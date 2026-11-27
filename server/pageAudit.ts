// Full-page audit of one tall image: auditPage(request) returns a ViewportAudit for the whole page.
//
// A tall page is never sent as one picture (Gemini reads at most about 1,120 tokens per image,
// so text on a 1440 x 15,000 image would be unreadable). Instead:
// 1. planSections (lib/tiling.ts) cuts the page into overlapping sections; sharp slices them.
// 2. One call per section (about 3 at a time, high media resolution) returns findings boxed on
//    that section. Only the first section is judged as a first impression; it alone returns
//    first_impression_test and gaze hotspots. Other sections are told where they sit on the
//    page and never hear the words fold or 5 second.
// 3. Boxes are mapped to the whole image (mapBoxToPage), kept as decimals, given box_px in image
//    pixels, filtered by a minimum size in pixels, and deduplicated across seams
//    (dedupeAcrossSections).
// 4. One overview call on a downscaled picture of the whole page (low media resolution), with the
//    section findings as text, writes the page narrative, scores and one label per section.
// A section that fails becomes a warning; the audit fails only when every section fails.
import sharp, { type Sharp } from 'sharp';
import { PartMediaResolutionLevel, Type, type ThinkingLevel } from '@google/genai';
import type {
  AttentionHotspot,
  AuditFinding,
  AuditGoal,
  PageAuditProgressEvent,
  PageAuditStats,
  PageSectionInfo,
  SeoMetadata,
  TokenUsage,
  TopPriority,
  ViewportAudit,
  ViewportKey,
} from '../types.ts';
import { dedupeAcrossSections, intersectionOverSmaller, isClippedBySection, mapBoxToPage, planSections, type PageSection } from '../lib/tiling.ts';
import { box2dToPixelRect, pixelRectToBox2d, type PixelRect } from '../lib/geometry.ts';
import { MODELS, ModelOutputError, PAGE_AUDIT_THINKING_LEVEL, RATE_LIMIT_RETRY, TIMEOUTS, generateJson, getAiClient, wrapUntrusted, type AiLike, type RateLimitPolicy } from './gemini.ts';
import { toPublicError } from './http.ts';
import { IMAGE_LIMITS } from './image.ts';
import { cleanLabel, findingFromRaw, firstImpressionFrom, scoresFrom, sortFindings, summarizeFindings } from './normalize.ts';
import { findingItemSchema, goalContext, pageFirstSectionSchema, pageOverviewSchema, pageSectionSchema } from './auditSchemas.ts';
import { formatTelemetryForPrompt } from './pageTelemetry.ts';

export interface PageAuditRequest {
  image: Buffer;
  width: number;
  height: number;
  viewport: ViewportKey;
  url?: string;
  metadata?: SeoMetadata;
  auditGoal: AuditGoal;
  targetKeyword?: string;
  /** Bottom of the first screen in image px. Defaults to the viewport's window ratio times width. */
  foldPx?: number;
}

export interface PageAuditOptions {
  ai?: AiLike;
  /** A private limit for this audit only (tests, scripts). Default: the shared pageAuditLimiter. */
  concurrency?: number;
  /** A limiter to share between audits (tests). Overrides `concurrency`. */
  limiter?: CallLimiter;
  /**
   * This audit's place in the shared limiter, joined by the route as soon as the request
   * headers arrive so its fair share is reserved while the image uploads. Default: joined here.
   */
  ticket?: LimiterTicket;
  /** Section height in image px; defaults to PAGE_SECTION_HEIGHT[viewport]. */
  sectionHeight?: number;
  /** 429 handling for every call of this audit; defaults to RATE_LIMIT_RETRY.attempts same-model retries. */
  rateLimit?: Omit<RateLimitPolicy, 'onRetry'>;
  /** Per-request timeout for section calls; defaults to TIMEOUTS.pageSection (150 s). */
  sectionTimeoutMs?: number;
  /** Defaults to PAGE_AUDIT_THINKING_LEVEL (env GEMINI_PAGE_AUDIT_THINKING). */
  thinkingLevel?: ThinkingLevel;
  /** Live progress (see auditProgress.ts). Errors thrown by the listener are ignored. */
  onProgress?: (event: PageAuditProgressEvent) => void;
}

const OVERLAP = 0.15;
const MAX_SECTIONS = 16;

/** Reads a whole number in [min, max]; anything else falls back. */
export function readIntSetting(value: string | undefined, fallback: number, min: number, max: number): number {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= min && n <= max) return n;
  console.warn(`[pageAudit] ignoring "${raw}"; expected a whole number from ${min} to ${max}.`);
  return fallback;
}

/**
 * Page-audit model calls in flight at once across the WHOLE PROCESS, shared by every audit
 * running (the app audits desktop and mobile at the same time). Sections and overviews wait
 * for a slot in arrival order. Default 8 since wave 3 (2026-11-24): 7 at once ran without rate
 * limits. 1 to 16 allowed. Override with GEMINI_PAGE_AUDIT_CONCURRENCY. The thinking cap is
 * PAGE_AUDIT_THINKING_LEVEL in gemini.ts (GEMINI_PAGE_AUDIT_THINKING, default low).
 */
export const PAGE_AUDIT_CONCURRENCY = readIntSetting(process.env.GEMINI_PAGE_AUDIT_CONCURRENCY, 8, 1, 16);

/**
 * Height of one audited section per viewport, in image px, before the 16-section cap stretches
 * it on very long pages. 900 to 4,000 allowed. Defaults since wave 3 (2026-11-24):
 * - desktop 1,800: the granular setting, measured as losing nothing (2,400 grouped separate
 *   buttons and cards into one box). Override with GEMINI_PAGE_SECTION_HEIGHT_DESKTOP.
 * - mobile 2,400: a 780 x 2,400 slice is fewer pixels than a 1440 x 1,800 one, and mobile
 *   returned too many findings. Override with GEMINI_PAGE_SECTION_HEIGHT_MOBILE.
 */
export const PAGE_SECTION_HEIGHT: Readonly<Record<ViewportKey, number>> = {
  desktop: readIntSetting(process.env.GEMINI_PAGE_SECTION_HEIGHT_DESKTOP, 1800, 900, 4000),
  mobile: readIntSetting(process.env.GEMINI_PAGE_SECTION_HEIGHT_MOBILE, 2400, 900, 4000),
};

/**
 * How long a joined audit that has not asked for a slot yet keeps its fair share reserved.
 * The route joins when the request headers arrive, before the image body is parsed (the 28,000
 * px mobile body takes longer than the desktop one); if the audit never asks, the reservation
 * lapses so no slot stays idle for long.
 */
export const LIMITER_JOIN_RESERVE_MS = 5_000;

class LimiterOwner {
  held = 0;
  waiting: (() => void)[] = [];
  /** Joined but has not asked for a slot yet: its share is reserved until this time. */
  pendingUntil: number | null = null;
  left = false;
}

/** One audit's handle on a CallLimiter. */
export interface LimiterTicket {
  /** Resolves with a release function once this owner is given a slot. */
  acquire(): Promise<() => void>;
  /** This owner wants no more slots (idempotent). Slots it holds are still released one by one. */
  leave(): void;
}

/**
 * Fair slots shared by every page audit in flight. Each audit is an owner. While several
 * owners want slots, each gets a fair share (limit divided by the owners in flight, rounded up),
 * and freed slots go round robin to owners below their share. Work conserving: when only one
 * owner has calls waiting and no newly joined owner is about to ask, it gets every free slot,
 * so a single audit still gets all of them and total throughput does not drop.
 */
export class CallLimiter {
  readonly limit: number;
  private owners: LimiterOwner[] = [];
  private rr = 0;
  private active = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly reserveMs: number;
  /** Plain acquire() calls (no ticket) share this one owner, first come first served. */
  private readonly shared = new LimiterOwner();

  constructor(limit: number, options: { reserveMs?: number } = {}) {
    this.limit = Math.max(1, Math.floor(limit));
    this.reserveMs = options.reserveMs ?? LIMITER_JOIN_RESERVE_MS;
    this.owners.push(this.shared);
  }
  get inFlight(): number {
    return this.active;
  }
  get queued(): number {
    return this.owners.reduce((n, o) => n + o.waiting.length, 0);
  }
  /** Audits (tickets) still registered: joined and not yet left, or still holding a slot. */
  get audits(): number {
    return this.owners.filter((o) => o !== this.shared).length;
  }
  /** Slots held per ticket owner, in join order (diagnostics and tests). */
  heldByAudit(): number[] {
    return this.owners.filter((o) => o !== this.shared).map((o) => o.held);
  }

  /** Registers an owner. Until its first acquire, its share is held back for LIMITER_JOIN_RESERVE_MS. */
  join(): LimiterTicket {
    const owner = new LimiterOwner();
    owner.pendingUntil = Date.now() + this.reserveMs;
    this.owners.push(owner);
    this.armTimer();
    return {
      acquire: () => this.acquireFor(owner),
      leave: () => {
        if (owner.left) return;
        owner.left = true;
        owner.pendingUntil = null;
        this.prune();
        this.dispatch();
      },
    };
  }

  /** First come, first served among plain callers; shares fairly with ticket holders. */
  acquire(): Promise<() => void> {
    return this.acquireFor(this.shared);
  }

  private acquireFor(owner: LimiterOwner): Promise<() => void> {
    owner.pendingUntil = null;
    return new Promise<() => void>((resolve) => {
      owner.waiting.push(() => {
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          owner.held--;
          this.active--;
          this.prune();
          this.dispatch();
        });
      });
      this.dispatch();
    });
  }

  private isPending(o: LimiterOwner, now: number): boolean {
    return !o.left && o.pendingUntil !== null && o.pendingUntil > now;
  }

  private scheduled = false;

  /**
   * Grants run once per microtask, after every request made in the same tick has registered:
   * an audit's sections all ask at once, and must be seen together to share fairly.
   */
  private dispatch(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.dispatchNow();
    });
  }

  private dispatchNow(): void {
    const now = Date.now();
    while (this.active < this.limit) {
      const inFlight = this.owners.filter((o) => o.held > 0 || o.waiting.length > 0 || this.isPending(o, now)).length;
      const share = Math.ceil(this.limit / Math.max(1, inFlight));
      const pending = this.owners.some((o) => this.isPending(o, now));
      // Below its share first; if every waiting owner is at its share, any of them, unless a
      // newly joined owner is about to ask (its share stays free for it, briefly).
      const pick = this.nextWaiting((o) => o.held < share) ?? (pending ? null : this.nextWaiting(() => true));
      if (!pick) break;
      pick.held++;
      this.active++;
      pick.waiting.shift()!();
    }
  }

  /** The next owner with a waiting call that passes `ok`, round robin. */
  private nextWaiting(ok: (o: LimiterOwner) => boolean): LimiterOwner | null {
    const n = this.owners.length;
    for (let k = 0; k < n; k++) {
      const i = (this.rr + k) % n;
      const o = this.owners[i];
      if (o.waiting.length > 0 && ok(o)) {
        this.rr = (i + 1) % n;
        return o;
      }
    }
    return null;
  }

  private prune(): void {
    this.owners = this.owners.filter((o) => o === this.shared || !o.left || o.held > 0 || o.waiting.length > 0);
    if (this.rr >= this.owners.length) this.rr = 0;
  }

  /** Re-dispatches when the earliest reservation lapses, so a slot never idles past it. */
  private armTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    const now = Date.now();
    const next = Math.min(...this.owners.filter((o) => this.isPending(o, now)).map((o) => o.pendingUntil!));
    if (!Number.isFinite(next)) {
      this.timer = null;
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.dispatch();
      this.armTimer();
    }, Math.max(1, next - now + 1));
    this.timer.unref();
  }
}

/** The process-wide limiter every page audit shares (GEMINI_PAGE_AUDIT_CONCURRENCY). */
export const pageAuditLimiter = new CallLimiter(PAGE_AUDIT_CONCURRENCY);
/** Smallest box kept, in image px on each side. Smaller boxes are model noise. */
export const MIN_BOX_PX = 6;
/** Longest side of the overview picture. */
const OVERVIEW_MAX_SIDE = 1536;
const OVERVIEW_GAP = 24;
/** Window height over width, used for a default fold when the client sends none. */
const FOLD_RATIO: Record<ViewportKey, number> = { desktop: 900 / 1440, mobile: 844 / 390 };

const LOW = { level: PartMediaResolutionLevel.MEDIA_RESOLUTION_LOW };
const HIGH = { level: PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH };
const SYSTEM =
  'You are a principal CRO strategist, UX accessibility auditor, and technical SEO lead. Be precise, concrete, and accurate with bounding box coordinates.';

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/** Sections for an image: baseHeight tall (default the desktop setting) with 15% overlap, stretched so there are at most 16. */
export function planPageSections(width: number, height: number, baseHeight: number = PAGE_SECTION_HEIGHT.desktop): PageSection[] {
  const needed = Math.ceil(height / (MAX_SECTIONS * (1 - OVERLAP)));
  const sectionHeight = Math.max(baseHeight, needed);
  return planSections(width, height, { sectionHeight, overlapRatio: OVERLAP });
}

function metaContext(
  metadata: SeoMetadata | undefined,
  url: string | undefined,
  viewport: ViewportKey,
  scope: 'first-section' | 'later-section' | 'overview'
): string {
  if (!metadata) return url ? `- URL: ${url}\n` : '';
  const looksLikeClientSpa = Boolean(
    metadata.telemetry?.spaHydratedDiff ||
      (metadata.wordCount || 0) < 60 ||
      ((metadata.h1s?.length || 0) === 0 && (metadata.totalImages || 0) === 0)
  );
  const rawLines = [
    `- URL: ${url || metadata.url || 'Uploaded design'}`,
    `- Title (${metadata.title?.length || 0} chars): ${metadata.title || 'None'}`,
    `- Meta Description (${metadata.description?.length || 0} chars): ${metadata.description || 'None'}`,
    `- H1 Tags: ${metadata.h1s?.join(' | ') || 'None detected in raw HTML'}`,
    `- Schema Types: ${metadata.schemaTypes?.join(', ') || 'None'}`,
    `- Images: ${metadata.totalImages} total, ${metadata.missingAltImages} missing alt text`,
    ...(scope === 'overview'
      ? [
          `- Canonical: ${metadata.canonical || 'Not detected'}`,
          `- Meta Robots: ${metadata.robotsMeta || 'None'}`,
          `- Viewport Meta: ${metadata.viewportMeta || 'Not detected'}`,
        ]
      : []),
  ];
  const spaNote = looksLikeClientSpa
    ? '\n- SPA RENDERING NOTE: Raw HTML fetch returned minimal pre-rendered markup (likely a JS-hydrated SPA). Trust the rendered screenshot and verified DOM measurements for visible H1 headings, body copy, and imagery; do NOT flag "missing H1" or "thin content" when those elements are clearly visible in the screenshot.'
    : '';
  const telemetryBlock =
    scope === 'later-section' ? '' : formatTelemetryForPrompt(metadata, scope === 'overview' ? 'overview' : 'first-section', viewport);
  return `${wrapUntrusted('untrusted_page_data', rawLines.join('\n'))}${spaNote}${telemetryBlock}\n`;
}

/** The shared 'general' goal text speaks of a first impression; later sections get a neutral one. */
const GENERAL_BELOW_TOP = 'General high-converting website: clarity, persuasion, SEO, and trust.';

function calibration(
  req: PageAuditRequest,
  scope: 'first-section' | 'later-section' | 'overview' = 'first-section'
): string {
  const keyword = req.targetKeyword?.trim() ? `- Primary Target Keyword: "${req.targetKeyword.trim()}"\n` : '';
  const goal = scope === 'later-section' && req.auditGoal === 'general' ? GENERAL_BELOW_TOP : goalContext(req.auditGoal);
  return `CALIBRATION:\n- Conversion Goal: ${goal}\n${keyword}${metaContext(req.metadata, req.url, req.viewport, scope)}`;
}

const BOX_RULES = `- Bounding boxes MUST tightly wrap each visible element on a 0-1000 scale of THIS image [ymin, xmin, ymax, xmax].
- An element cut off by the top or bottom edge of this image continues in the neighbouring section: box only the part you can see.
- Use [0,0,0,0] with element_type "abstract" ONLY for page-wide technical issues, and only if this image gives evidence for them.
- NEVER mention coordinates, section numbers or pixel ranges in seo_analysis, suggested_optimization, or technical_details. Write in natural UX/CRO language.
- Provide concrete, domain-specific copy rewrites or visual/WCAG fixes in suggested_optimization.`;

/**
 * Findings asked for per section. A mobile section (780 px wide, 1,800 px tall) holds about two
 * phone screens, so it gets fewer: the 2026-11-24 run returned 75 mobile findings at 6 each.
 */
export const FINDINGS_PER_SECTION: Record<ViewportKey, number> = { desktop: 6, mobile: 4 };

/**
 * Most findings a full-page audit returns. Blockers are always kept, even past it; anything
 * else beyond it is counted in stats.omitted. 30 is about a working session of fixes; the
 * 2026-11-24 run returned 38 (desktop) and 75 (mobile).
 */
export const MAX_PAGE_FINDINGS = 30;

/** What counts as a finding, how to title it and how severe it is; shared by every section prompt. */
export function findingRules(viewport: ViewportKey): string {
  return `- Report UP TO ${FINDINGS_PER_SECTION[viewport]} findings for this image, and only issues worth fixing. Fewer is fine when the image is clean.
- Give every finding a distinct, located title in "context" that names the element and where it sits, for example "Hero primary CTA" or "Pricing band CTA", never a bare "Primary CTA". No two findings may share a title.
- Include a strength (severity "info") only when it is notable enough that the team should protect it.
- Do not report a separate finding for a minor label, eyebrow, caption, placeholder or legal line unless it causes a real problem.
- Box one element or one coherent group (a whole nav bar, a whole card row, a whole form). Never put unrelated small elements into one box.
SEVERITY RUBRIC (provisional: a page-level review of every section's findings sets the final severities):
- "critical": it blocks the primary conversion, comprehension of the offer, or indexing.
- "warning": it clearly weakens clarity, trust or conversion, but does not block them.
- "info": polish, or a notable strength.`;
}

/** Prompt for the first section: the only one judged as a first impression. */
export function firstSectionPrompt(req: PageAuditRequest, section: PageSection, total: number, foldPx: number): string {
  const foldUnits = Math.round((Math.min(foldPx, section.yEnd) / section.height) * 1000);
  return `Audit section 1 of ${total} of a full-page ${req.viewport.toUpperCase()} screenshot. This image is the top of the page: image pixels y=0 to y=${fmt(section.yEnd)} of a page ${fmt(req.height)} px tall.
The first screen (what a visitor sees before scrolling) ends at y=${fmt(foldPx)} px, which is ${foldUnits} on this image's 0-1000 vertical scale.
${calibration(req)}
EVALUATE:
1. The first screen only: can a cold visitor tell in 5 seconds what is offered, who it is for and what to click? Does the hero visual guide attention to the headline and primary CTA? Is proof visible before scrolling? Put this verdict in first_impression_test and predict 4 to 6 attention_hotspots inside the first screen.
2. Everything in this image, including what sits below the first screen: copy clarity, visual hierarchy, CTA hierarchy, trust and proof, accessibility (WCAG 2.1 AA contrast, tap targets, text size), and on-page SEO.

STRICT OUTPUT RULES:
${findingRules(req.viewport)}
${BOX_RULES}
- attention_hotspots: x and y on this image's 0-1000 scale; radius on a 0-1000 scale of the image WIDTH.`;
}

/** Prompt for every later section: placed on the page, never judged as a first impression. */
export function sectionPrompt(req: PageAuditRequest, section: PageSection, total: number): string {
  const percent = Math.round((section.yStart / req.height) * 100);
  return `Audit section ${section.index + 1} of ${total} of a full-page ${req.viewport.toUpperCase()} screenshot. This image shows image pixels y=${fmt(section.yStart)} to y=${fmt(section.yEnd)} of a page ${fmt(req.height)} px tall, about ${percent}% of the way down.
The visitor has already scrolled to this point. Judge this part of the page on the job it does here (explaining, proving, persuading, answering objections, converting), not as an entry point.
${calibration(req, 'later-section')}
EVALUATE: copy clarity and scannability, visual hierarchy, CTA placement and wording, trust and proof, accessibility (WCAG 2.1 AA contrast, tap targets, text size), and visible heading structure for on-page SEO.

STRICT OUTPUT RULES:
${findingRules(req.viewport)}
${BOX_RULES}`;
}

export function overviewPrompt(req: PageAuditRequest, sections: PageSection[], digest: string, columns = 1): string {
  const list = sections.map((s) => `${s.index}: y ${fmt(s.yStart)} to ${fmt(s.yEnd)} px`).join('\n');
  const layout = columns > 1
    ? ` To fit, the page is cut into ${columns} columns placed side by side and separated by grey gaps: read the leftmost column top to bottom, then continue at the top of the next column.`
    : ' It runs from top to bottom.';
  return `This image is a downscaled picture of a whole ${req.viewport.toUpperCase()} landing page (originally ${fmt(req.width)} x ${fmt(req.height)} px).${layout} The page was already audited section by section at full resolution; those findings are listed below. Write the page-level verdict.
${calibration(req, 'overview')}
SECTIONS (index: image pixel range):

FINDINGS BY SECTION:
${digest || 'None'}

TASK:
- overall_summary: how the page tells its story from top to bottom, messaging clarity, and conversion readiness of the whole page.
- strategic_advisor: an actionable 3-paragraph growth roadmap for the whole page, highest conversion ROI first.
- scores: for the whole page, not only its top.
- section_labels: one short label (1 to 3 words) for every section index above, naming what it mainly contains.
- top_priorities: the 3 to 5 findings from the list above to fix first, for the whole page, ranked 1 (first) to 5. Name each by its id exactly as listed (F1, F2, ...); never invent an id. Give a one-line reason for each.
- blocker: true only when the finding blocks the primary conversion, comprehension of the offer, or indexing. Zero blockers is a valid answer. The severities in the list are provisional, written by each section alone; blockers you mark become the only critical findings.
- drop: the ids of low-value findings to leave out of the report: minor polish, or a finding that repeats another finding in other words (keep the clearer one). Never list a blocker or a top priority. An empty list is fine.
- Never mention pixel ranges, coordinates or section numbers in overall_summary or strategic_advisor.`;
}

/**
 * A tall page squeezed into one small picture becomes a sliver (a 780 x 28,000 page is 85 px wide
 * at 3,072 px tall). Instead the page is cut into side-by-side columns, read left to right, so
 * the sheet is close to square before downscaling.
 */
export async function overviewSheet(source: Sharp, width: number, height: number): Promise<{ image: Buffer; columns: number }> {
  const columns = Math.max(1, Math.min(8, Math.round(Math.sqrt(height / width))));
  const columnHeight = Math.ceil(height / columns);
  const strips = await Promise.all(
    Array.from({ length: columns }, async (_, i) => {
      const top = i * columnHeight;
      const input = await source.clone().extract({ left: 0, top, width, height: Math.min(columnHeight, height - top) }).png().toBuffer();
      return { input, left: i * (width + OVERVIEW_GAP), top: 0 };
    })
  );
  const sheet = await sharp({
    create: { width: columns * width + (columns - 1) * OVERVIEW_GAP, height: columnHeight, channels: 3, background: '#9ca3af' },
    limitInputPixels: false,
  })
    .composite(strips)
    .png()
    .toBuffer();
  const image = await sharp(sheet, { limitInputPixels: false })
    .resize({ width: OVERVIEW_MAX_SIDE, height: OVERVIEW_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 70 })
    .toBuffer();
  return { image, columns };
}

function clampBox(raw: unknown): [number, number, number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  let [ymin, xmin, ymax, xmax] = raw.map((n) => Math.max(0, Math.min(1000, Number(n) || 0)));
  if (ymin > ymax) [ymin, ymax] = [ymax, ymin];
  if (xmin > xmax) [xmin, xmax] = [xmax, xmin];
  return [ymin, xmin, ymax, xmax];
}

interface Candidate {
  finding: AuditFinding;
  sectionIndex: number;
  pixelRect?: PixelRect;
  clipped?: boolean;
  severity: string;
  category: string;
  current_text: string;
  visual_description: string;
}

/** Turns one section's raw items into page-space candidates. Exported for tests. */
export function mapSectionItems(
  rawItems: unknown,
  section: PageSection,
  page: { width: number; height: number },
  viewport: ViewportKey
): Candidate[] {
  const out: Candidate[] = [];
  const list = Array.isArray(rawItems) ? rawItems : [];
  list.forEach((raw: any, i) => {
    if (!raw || typeof raw !== 'object') return;
    const base = { sectionIndex: section.index, severity: '', category: String(raw.category || ''), current_text: String(raw.current_text || ''), visual_description: String(raw.visual_description || '') };
    if (raw.element_type === 'abstract') {
      const finding = { ...findingFromRaw(raw, i, viewport, [0, 0, 0, 0], 0), section_index: section.index };
      out.push({ ...base, finding, severity: finding.severity });
      return;
    }
    const box = clampBox(raw.box_2d);
    if (!box) return;
    const { pixelRect } = mapBoxToPage(box, section, page);
    if (pixelRect.width < MIN_BOX_PX || pixelRect.height < MIN_BOX_PX) return;
    const areaUnits = (box[2] - box[0]) * (box[3] - box[1]);
    const finding = { ...findingFromRaw(raw, i, viewport, undefined, areaUnits), section_index: section.index };
    out.push({
      ...base,
      finding,
      severity: finding.severity,
      pixelRect,
      clipped: isClippedBySection(box, section, page),
    });
  });
  return out;
}

/** Final geometry on a finding: box_2d on the full image (decimals kept) and box_px in image px. */
function placeFinding(c: Candidate, page: { width: number; height: number }): AuditFinding {
  if (!c.pixelRect) return { ...c.finding, box_2d: [0, 0, 0, 0] };
  const r = c.pixelRect;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    ...c.finding,
    box_2d: pixelRectToBox2d(r, page).map(round2) as [number, number, number, number],
    box_px: [round2(r.y), round2(r.x), round2(r.y + r.height), round2(r.x + r.width)],
  };
}

/** Merges duplicates across seams, then page-wide (abstract) duplicates by category and text. */
export function mergeCandidates(candidates: Candidate[], sections: PageSection[], page: { width: number; height: number }): AuditFinding[] {
  const boxed = dedupeAcrossSections(candidates.filter((c) => c.pixelRect), page, { sections });
  const abstractByKey = new Map<string, Candidate>();
  const rank: Record<string, number> = { critical: 3, warning: 2, info: 1 };
  for (const c of candidates.filter((c) => !c.pixelRect)) {
    const key = `${c.category.toLowerCase()}|${(c.current_text || c.finding.context).toLowerCase().trim()}`;
    const seen = abstractByKey.get(key);
    if (!seen || rank[c.severity] > rank[seen.severity]) abstractByKey.set(key, c);
  }
  return sortFindings([...boxed, ...abstractByKey.values()].map((c) => placeFinding(c, page)));
}

/** Section-0 hotspots mapped to the whole image: x, y on 0-1000 of the full image, radius on width. */
export function mapHotspots(raw: unknown, section0: PageSection, page: { width: number; height: number }, foldPx: number): AttentionHotspot[] {
  if (!Array.isArray(raw)) return [];
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return raw
    .filter((h: any) => h && typeof h === 'object')
    .slice(0, 6)
    .map((h: any, idx: number) => {
      const yPx = Math.min(foldPx, section0.yStart + (Math.max(0, Math.min(1000, Number(h.y) || 300)) / 1000) * section0.height);
      return {
        x: round2(Math.max(0, Math.min(1000, Number(h.x) || 500))),
        y: round2((yPx / page.height) * 1000),
        radius: Math.max(30, Math.min(250, Math.round(Number(h.radius) || 120))),
        intensity: Math.max(25, Math.min(100, Math.round(Number(h.intensity) || 80 - idx * 10))),
        rank: Math.max(1, Math.min(6, Math.round(Number(h.rank) || idx + 1))),
        label: cleanLabel(h.label, 60) ?? `Fixation #${idx + 1}`,
      };
    })
    .sort((a, b) => a.rank - b.rank);
}

/** Findings shown to the overview; 16 sections of up to 6 findings fit. */
const MAX_DIGEST = 100;

/** Findings as text for the overview, each with a short ref (F1, F2, ...) it ranks them by. */
export function digestOf(findings: AuditFinding[]): string {
  return findings
    .slice(0, MAX_DIGEST)
    .map((f, i) => `F${i + 1} (section ${(f.section_index ?? 0) + 1}) [${f.severity}] ${f.context}: ${f.seo_analysis.slice(0, 140)}`)
    .join('\n');
}

/** The finding ids behind the overview's `drop` refs (F1 = findings[0]); unknown refs are ignored. */
export function resolveDrops(findings: AuditFinding[], raw: unknown): Set<string> {
  const ids = new Set<string>();
  for (const ref of Array.isArray(raw) ? raw : []) {
    const m = /^F(\d+)$/i.exec(String(ref ?? '').trim());
    const index = m ? Number(m[1]) - 1 : -1;
    if (index >= 0 && index < Math.min(findings.length, MAX_DIGEST)) ids.add(findings[index].id);
  }
  return ids;
}

/**
 * G11: fewer, actionable findings. Removes the findings the overview marked as low value, then
 * keeps at most `cap`, choosing by severity and then impact. Critical findings (the blockers)
 * and top priorities are never dropped or capped, even past the cap. Returns the kept findings
 * in their original order, with the counts for stats.findings.
 */
export function trimFindings(
  items: AuditFinding[],
  drop: Set<string>,
  protectedIds: Set<string>,
  cap = MAX_PAGE_FINDINGS
): { items: AuditFinding[]; omitted: AuditFinding[]; counts: NonNullable<PageAuditStats['findings']> } {
  const keep = (f: AuditFinding) => f.severity === 'critical' || protectedIds.has(f.id);
  const afterDrop = items.filter((f) => keep(f) || !drop.has(f.id));
  const droppedLowValue = items.length - afterDrop.length;
  const order: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  const chosen = new Set(afterDrop.filter(keep).map((f) => f.id));
  const rest = afterDrop
    .filter((f) => !chosen.has(f.id))
    .sort((a, b) => order[a.severity] - order[b.severity] || b.impact_score - a.impact_score);
  for (const f of rest) {
    if (chosen.size >= cap) break;
    chosen.add(f.id);
  }
  const kept = afterDrop.filter((f) => chosen.has(f.id));
  return {
    items: kept,
    // Cut by the cap only, never the low-value drops; highest severity and impact first.
    omitted: rest.filter((f) => !chosen.has(f.id)),
    counts: { found: items.length, returned: kept.length, droppedLowValue, omittedOverCap: afterDrop.length - kept.length, cap },
  };
}

/**
 * G3: no two findings share a title. Each title used more than once gets its section label,
 * as in "Primary CTA (Pricing)"; if two still match (same section), a running number follows.
 */
export function uniqueTitles(items: AuditFinding[], sectionLabel: (index: number | undefined) => string): AuditFinding[] {
  const key = (s: string) => s.trim().toLowerCase();
  const counts = new Map<string, number>();
  for (const f of items) counts.set(key(f.context), (counts.get(key(f.context)) ?? 0) + 1);
  const located = items.map((f) => (counts.get(key(f.context))! > 1 ? { ...f, context: `${f.context} (${sectionLabel(f.section_index)})` } : f));
  const seen = new Map<string, number>();
  const total = new Map<string, number>();
  for (const f of located) total.set(key(f.context), (total.get(key(f.context)) ?? 0) + 1);
  return located.map((f) => {
    const k = key(f.context);
    if (total.get(k)! < 2) return f;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return { ...f, context: `${f.context} ${n}` };
  });
}

/**
 * Final severities from the overview's ranking. `raw` is the overview's top_priorities; each entry
 * names a finding by its ref in digestOf (F1 = findings[0]). Refs that do not exist are ignored,
 * duplicates keep their first entry, and at most 5 are kept, re-ranked 1 to n. Only findings the
 * overview marked as blockers become critical; any other critical becomes a warning; warning and
 * info stay. Returns null when no usable priority remains, so the caller keeps the sections' own
 * severities.
 */
export function applyPriorities(findings: AuditFinding[], raw: unknown): { items: AuditFinding[]; priorities: TopPriority[] } | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<number>();
  const valid: { index: number; rank: number; order: number; reason: string; blocker: boolean }[] = [];
  raw.forEach((p: any, order) => {
    const m = /^F(\d+)$/i.exec(String(p?.finding ?? '').trim());
    const index = m ? Number(m[1]) - 1 : -1;
    if (index < 0 || index >= Math.min(findings.length, MAX_DIGEST) || seen.has(index)) return;
    seen.add(index);
    const rank = Number(p?.rank);
    const reason = cleanLabel(p?.reason, 300) ?? 'Ranked among the first fixes by the page-level review.';
    valid.push({ index, rank: Number.isFinite(rank) ? rank : 99, order, reason, blocker: p?.blocker === true });
  });
  if (valid.length === 0) return null;
  const ranked = valid.sort((a, b) => a.rank - b.rank || a.order - b.order).slice(0, 5);
  const blockers = new Set(ranked.filter((p) => p.blocker).map((p) => findings[p.index].id));
  const items = sortFindings(
    findings.map((f) => {
      const severity = blockers.has(f.id) ? 'critical' : f.severity === 'critical' ? 'warning' : f.severity;
      return severity === f.severity ? f : { ...f, severity };
    })
  );
  const priorities = ranked.map((p, i) => ({ finding_id: findings[p.index].id, rank: i + 1, reason: p.reason, blocker: p.blocker }));
  return { items, priorities };
}

function addUsage(target: { tokens?: TokenUsage }, usage: any): void {
  if (!usage || typeof usage !== 'object') return;
  const t = (target.tokens ??= { prompt: 0, output: 0, thinking: 0, total: 0 });
  t.prompt += Number(usage.promptTokenCount) || 0;
  t.output += Number(usage.candidatesTokenCount) || 0;
  t.thinking += Number(usage.thoughtsTokenCount) || 0;
  t.total += Number(usage.totalTokenCount) || 0;
}

/**
 * A section is tried once more after a timeout or a server error (5xx), on the primary model
 * only, so one section costs at most 3 requests (primary, fallback, retry). Unusable output
 * (ModelOutputError) already got its fallback attempt and is not retried; nor are 4xx errors.
 */
export function isRetryableSectionError(err: unknown): boolean {
  if (err instanceof ModelOutputError) return false;
  const e = err as { status?: unknown; name?: string } | null;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return true;
  return typeof e?.status === 'number' && e.status >= 500 && e.status <= 599;
}

/** Wraps the client so every request sent (fallbacks and retries included) is counted, with its tokens. */
function counting(ai: AiLike, onCall: () => void, usageTargets: { tokens?: TokenUsage }[]): AiLike {
  return {
    models: {
      async generateContent(request: any) {
        onCall();
        const response = await ai.models.generateContent(request);
        for (const target of usageTargets) addUsage(target, response?.usageMetadata);
        return response;
      },
    },
  };
}

export async function auditPage(req: PageAuditRequest, opts: PageAuditOptions = {}): Promise<ViewportAudit> {
  const ai = opts.ai ?? getAiClient(); // fails fast (503) when no key is configured
  const started = Date.now();
  const page = { width: req.width, height: req.height };
  const foldPx = Math.max(1, Math.min(req.height, Math.round(req.foldPx ?? req.width * FOLD_RATIO[req.viewport])));
  const sectionHeight = opts.sectionHeight ?? PAGE_SECTION_HEIGHT[req.viewport];
  const sections = planPageSections(req.width, req.height, sectionHeight);
  const emit = (event: PageAuditProgressEvent) => {
    try {
      opts.onProgress?.(event);
    } catch {
      // progress is best effort; it never breaks an audit
    }
  };
  emit({ type: 'plan', total: sections.length });
  const warnings: string[] = [];
  const modelsUsed = new Set<string>();
  // Second guard behind the route's header check: sharp refuses to decode past IMAGE_LIMITS.
  const source = sharp(req.image, { limitInputPixels: IMAGE_LIMITS.maxPixels });
  const thinkingLevel = opts.thinkingLevel ?? PAGE_AUDIT_THINKING_LEVEL;
  // One limiter shared by every audit in the process, unless the caller asks for a private one.
  const limiter = opts.limiter ?? (opts.concurrency ? new CallLimiter(opts.concurrency) : pageAuditLimiter);
  const ticket = opts.ticket ?? limiter.join();
  const rateLimitAttempts = opts.rateLimit?.attempts ?? RATE_LIMIT_RETRY.attempts;
  const stats: PageAuditStats = {
    calls: 0,
    retries: 0,
    rateLimitRetries: 0,
    thinkingLevel: String(thinkingLevel),
    concurrency: limiter.limit,
    concurrencyScope: limiter === pageAuditLimiter ? 'process' : 'audit',
    sectionHeight,
    totalMs: 0,
    sections: sections.map((s) => ({ index: s.index, attempts: 0, retried: false, ok: false, ms: 0, waitMs: 0 })),
    overview: { attempts: 0, ok: false, ms: 0, waitMs: 0 },
  };
  /** 429 policy: same-model retries before the fallback, each reported as a retry in progress. */
  const rateLimitFor = (onRetry: () => void): RateLimitPolicy => ({
    ...opts.rateLimit,
    attempts: rateLimitAttempts,
    onRetry: () => {
      stats.rateLimitRetries = (stats.rateLimitRetries ?? 0) + 1;
      onRetry();
    },
  });

  // Every section starts at once but waits for a limiter slot before slicing or calling, so
  // progress shows it "queued" until it really runs. Each request's timeout starts in
  // withFallback right as generateContent is called, so time spent waiting costs nothing.
  const results = await Promise.all(sections.map(async (section) => {
    const s = stats.sections[section.index];
    const sectionAi = counting(
      ai,
      () => {
        stats.calls++;
        s.attempts++;
      },
      [s, stats]
    );
    const queuedAt = Date.now();
    const release = await ticket.acquire();
    const t0 = Date.now();
    s.waitMs = t0 - queuedAt;
    emit({ type: 'section-start', index: section.index });
    try {
      const slice = await source
        .clone()
        .extract({ left: 0, top: section.yStart, width: section.width, height: section.height })
        .jpeg({ quality: 85 })
        .toBuffer();
      const first = section.index === 0;
      const call = (models: [string, string?]) =>
        generateJson({
          ai: sectionAi,
          label: `page-section-${section.index + 1}`,
          models,
          systemInstruction: SYSTEM,
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: slice.toString('base64') }, mediaResolution: HIGH },
            { text: first ? firstSectionPrompt(req, section, sections.length, foldPx) : sectionPrompt(req, section, sections.length) },
          ],
          schema: first ? pageFirstSectionSchema : pageSectionSchema,
          timeoutMs: opts.sectionTimeoutMs ?? TIMEOUTS.pageSection,
          thinkingLevel,
          rateLimit: rateLimitFor(() => emit({ type: 'section-retry', index: section.index })),
        });
      let answer;
      try {
        answer = await call([MODELS.audit, MODELS.auditFallback]);
      } catch (err) {
        if (!isRetryableSectionError(err)) throw err;
        s.retried = true;
        stats.retries++;
        emit({ type: 'section-retry', index: section.index });
        answer = await call([MODELS.audit]);
      }
      modelsUsed.add(answer.modelUsed);
      s.ok = true;
      return { section, raw: answer.result, candidates: mapSectionItems(answer.result?.items, section, page, req.viewport) };
    } catch (err) {
      const why = toPublicError(err, 'The AI call failed.').message;
      const tried = s.retried ? ' (after one retry)' : '';
      warnings.push(`Section ${section.index + 1} of ${sections.length} (y ${fmt(section.yStart)} to ${fmt(section.yEnd)} px) could not be audited${tried}: ${why}`);
      return { section, raw: null, candidates: [] as Candidate[], error: err };
    } finally {
      release();
      s.ms = Date.now() - t0;
      emit({ type: 'section-end', index: section.index, ok: s.ok });
    }
  }));

  const failed = results.filter((r) => 'error' in r);
  if (failed.length === sections.length) {
    ticket.leave();
    throw (failed[0] as { error: unknown }).error;
  }

  const sectionItems = mergeCandidates(results.flatMap((r) => r.candidates), sections, page);
  const first = results[0];
  const hotspots = first.raw ? mapHotspots(first.raw.attention_hotspots, sections[0], page, foldPx) : [];

  // Overview: narrative, scores and labels from a small picture of the whole page plus the findings.
  let overview: any = null;
  const overviewQueued = Date.now();
  const releaseOverview = await ticket.acquire();
  const t1 = Date.now();
  stats.overview.waitMs = t1 - overviewQueued;
  emit({ type: 'overview-start' });
  try {
    const sheet = await overviewSheet(source, req.width, req.height);
    const { result, modelUsed } = await generateJson({
      ai: counting(
        ai,
        () => {
          stats.calls++;
          stats.overview.attempts++;
        },
        [stats.overview, stats]
      ),
      label: 'page-overview',
      thinkingLevel,
      models: [MODELS.audit, MODELS.auditFallback],
      systemInstruction: SYSTEM,
      parts: [
        { inlineData: { mimeType: 'image/jpeg', data: sheet.image.toString('base64') }, mediaResolution: LOW },
        { text: overviewPrompt(req, sections, digestOf(sectionItems), sheet.columns) },
      ],
      schema: pageOverviewSchema,
      rateLimit: rateLimitFor(() => {}),
    });
    overview = result;
    modelsUsed.add(modelUsed);
    stats.overview.ok = true;
  } catch (err) {
    warnings.push(
      `The page overview could not be written: ${toPublicError(err, 'The AI call failed.').message} Scores fall back to defaults, and severities are each section's own, with no page-level ranking.`
    );
  } finally {
    releaseOverview();
    ticket.leave(); // no more calls from this audit
  }
  stats.overview.ms = Date.now() - t1;
  emit({ type: 'overview-end', ok: stats.overview.ok });
  stats.totalMs = Date.now() - started;

  // Final severities: critical only for the blockers the overview ranked. Without a usable
  // ranking, the sections' own (provisional) severities stand.
  let items = sectionItems;
  let topPriorities: TopPriority[] = [];
  if (overview && sectionItems.length > 0) {
    const ranked = applyPriorities(sectionItems, overview.top_priorities);
    if (ranked) {
      items = ranked.items;
      topPriorities = ranked.priorities;
    } else {
      warnings.push("The page overview did not rank any listed finding, so severities are each section's own.");
    }
  }

  const labels = new Map<number, string>();
  for (const l of Array.isArray(overview?.section_labels) ? overview.section_labels : []) {
    const i = Number(l?.index);
    const label = cleanLabel(l?.label, 60);
    if (Number.isInteger(i) && label) labels.set(i, label);
  }
  const sectionInfo: PageSectionInfo[] = sections.map((s) => ({
    index: s.index,
    yStart: s.yStart,
    yEnd: s.yEnd,
    label: labels.get(s.index) ?? `Section ${s.index + 1}`,
  }));

  // G11: drop what the overview marked as low value, then cap; blockers and priorities stay.
  const trimmed = trimFindings(
    items,
    overview ? resolveDrops(sectionItems, overview.drop) : new Set(),
    new Set(topPriorities.map((p) => p.finding_id))
  );
  stats.findings = trimmed.counts;
  if (trimmed.counts.omittedOverCap > 0) {
    warnings.push(`Showing the ${trimmed.counts.returned} most important of ${trimmed.counts.found} findings; ${trimmed.counts.omittedOverCap} lower-impact ones were left out.`);
  }
  // G3: titles that still repeat get their section label, across shown and omitted findings
  // together, so a finding opened from omitted_items never shares a title with a shown one.
  const titled = uniqueTitles([...trimmed.items, ...trimmed.omitted], (i) => sectionInfo[i ?? 0]?.label ?? `Section ${(i ?? 0) + 1}`);
  items = titled.slice(0, trimmed.items.length);
  const omittedItems = titled.slice(trimmed.items.length);

  return {
    overall_summary: String(overview?.overall_summary ?? ''),
    strategic_advisor: String(overview?.strategic_advisor ?? ''),
    first_impression_test: firstImpressionFrom(first.raw?.first_impression_test),
    scores: scoresFrom(overview?.scores),
    items,
    attention_hotspots: hotspots,
    ...summarizeFindings(items),
    model_used: [...modelsUsed].join(', ') || MODELS.audit,
    mode: 'fullpage',
    image: { width: req.width, height: req.height },
    sections: sectionInfo,
    warnings,
    stats,
    top_priorities: topPriorities,
    omitted_items: omittedItems,
  };
}

export interface DeepScanRequest {
  image: Buffer;
  width: number;
  height: number;
  viewport: ViewportKey;
  existingItems: Partial<AuditFinding>[];
  /** Optional 0-based section index to scan on tall pages; defaults to 0 (top section). */
  sectionIndex?: number;
  sectionHeight?: number;
}

/**
 * Single-call Deep Scan Round 2 that works identically for viewport shots and tall full-page screenshots.
 * On tall pages, slices ONLY the requested section at high media resolution, maps existing findings into
 * section-local 0..1000 coordinates, returns exact box_px + decimal box_2d + section_index, and dedupes
 * against existing findings in pixel space.
 */
export async function deepScanPage(
  req: DeepScanRequest,
  opts: { ai?: AiLike } = {}
): Promise<{ items: AuditFinding[]; sectionIndex: number }> {
  const page = { width: req.width, height: req.height };
  const baseHeight = req.sectionHeight ?? PAGE_SECTION_HEIGHT[req.viewport];
  const sections = planPageSections(req.width, req.height, baseHeight);
  const clampedIdx = Math.max(0, Math.min(sections.length - 1, Math.floor(req.sectionIndex ?? 0)));
  const section = sections[clampedIdx] ?? { index: 0, yStart: 0, yEnd: req.height, width: req.width, height: req.height };

  const rectOfExisting = (item: Partial<AuditFinding>): PixelRect | null => {
    if (item.element_type === 'abstract') return null;
    if (Array.isArray(item.box_px) && item.box_px.length === 4) {
      const [y0, x0, y1, x1] = item.box_px.map(Number);
      if ([y0, x0, y1, x1].every(Number.isFinite)) {
        return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
      }
    }
    if (Array.isArray(item.box_2d) && item.box_2d.length === 4) {
      return box2dToPixelRect(item.box_2d as [number, number, number, number], page);
    }
    return null;
  };

  const existingWithRects = req.existingItems.map((item) => ({ item, rect: rectOfExisting(item) }));
  const localExisting = existingWithRects.filter(({ rect }) => {
    if (!rect) return true;
    return rect.y + rect.height > section.yStart && rect.y < section.yEnd;
  });

  const existingSummary = localExisting
    .map(({ item, rect }, i) => {
      let localBox = '[0,0,0,0]';
      if (rect && section.width > 0 && section.height > 0) {
        const y0 = Math.max(0, Math.min(1000, Math.round(((rect.y - section.yStart) / section.height) * 1000)));
        const x0 = Math.max(0, Math.min(1000, Math.round((rect.x / section.width) * 1000)));
        const y1 = Math.max(0, Math.min(1000, Math.round(((rect.y + rect.height - section.yStart) / section.height) * 1000)));
        const x1 = Math.max(0, Math.min(1000, Math.round(((rect.x + rect.width) / section.width) * 1000)));
        localBox = JSON.stringify([y0, x0, y1, x1]);
      }
      return `${i + 1}. ${String(item.context ?? '').slice(0, 120)} ("${String(item.current_text ?? '').slice(0, 160)}") box=${localBox}`;
    })
    .join('\n');

  let imageData: Buffer;
  let mimeType = 'image/jpeg';
  if (sections.length > 1) {
    imageData = await sharp(req.image, { limitInputPixels: IMAGE_LIMITS.maxPixels })
      .extract({ left: 0, top: section.yStart, width: section.width, height: section.height })
      .jpeg({ quality: 85 })
      .toBuffer();
  } else {
    imageData = req.image;
    mimeType = 'image/jpeg';
    try {
      const meta = await sharp(req.image, { limitInputPixels: IMAGE_LIMITS.maxPixels }).metadata();
      if (meta.format === 'png') mimeType = 'image/png';
      else if (meta.format === 'webp') mimeType = 'image/webp';
    } catch {
      // keep jpeg fallback
    }
  }

  const scopeNote =
    sections.length > 1
      ? `section ${section.index + 1} of ${sections.length} (image pixels y=${fmt(section.yStart)} to y=${fmt(section.yEnd)} of a ${fmt(req.height)} px tall ${req.viewport.toUpperCase()} page)`
      : `this ${req.viewport.toUpperCase()} viewport screenshot`;

  const prompt = `Deep-Scan Round 2 on ${scopeNote}.
Already audited elements in this view (DO NOT duplicate or heavily overlap these boxes):
${wrapUntrusted('untrusted_page_data', existingSummary || 'None')}

Find 4 to 7 ADDITIONAL subtle, missed CRO, accessibility, micro-copy, trust-signal, or visual-hierarchy issues visible in THIS image.
${BOX_RULES}`;

  const { result } = await generateJson({
    ai: opts.ai,
    label: `deep-scan-section-${section.index + 1}`,
    models: [MODELS.audit, MODELS.auditFallback],
    systemInstruction: SYSTEM,
    parts: [
      { inlineData: { mimeType, data: imageData.toString('base64') }, ...(sections.length > 1 ? { mediaResolution: HIGH } : {}) },
      { text: prompt },
    ],
    schema: {
      type: Type.OBJECT,
      properties: {
        items: { type: Type.ARRAY, items: findingItemSchema },
      },
      required: ['items'],
    },
    thinkingLevel: sections.length > 1 ? PAGE_AUDIT_THINKING_LEVEL : undefined,
  });

  const candidates = mapSectionItems(result?.items || [], section, page, req.viewport);
  const existingRects = existingWithRects.map((e) => e.rect).filter((r): r is PixelRect => Boolean(r));
  const kept = candidates
    .filter((c) => {
      if (!c.pixelRect) return true;
      return !existingRects.some((ex) => intersectionOverSmaller(c.pixelRect!, ex) > 0.45);
    })
    .map((c) => placeFinding(c, page));

  return { items: sortFindings(kept), sectionIndex: section.index };
}
