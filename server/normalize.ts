// Model output in, typed contract out. Every field the browser receives from a Gemini route is
// coerced here, so types.ts describes what the server actually sends and not what the model
// was asked to send.
import type {
  AttentionHotspot,
  AuditFinding,
  CodeFixPatch,
  ComparisonSummary,
  CopyVariant,
  GroundingSource,
  ParityIssue,
  SerpCompetitor,
  SerpResearchResult,
  SeverityLevel,
  ViewportAudit,
  ViewportKey,
} from '../types.ts';
import { normalizeUrl } from './safeFetch.ts';

const SEVERITIES: SeverityLevel[] = ['critical', 'warning', 'info'];
const ELEMENT_TYPES: AuditFinding['element_type'][] = [
  'heading', 'button', 'link', 'image', 'form', 'text', 'navigation', 'footer', 'abstract',
];

const clampScore = (value: unknown, fallback: number) =>
  Math.max(0, Math.min(100, Math.round(Number(value) || fallback)));
const str = (value: unknown, fallback = '') =>
  value === undefined || value === null ? fallback : String(value);
const severityOf = (value: unknown): SeverityLevel =>
  SEVERITIES.includes(value as SeverityLevel) ? (value as SeverityLevel) : 'warning';

export function cleanFindings(items: any[], viewport: ViewportKey): AuditFinding[] {
  const cleaned: AuditFinding[] = [];
  const list = Array.isArray(items) ? items : [];
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    if (!raw || typeof raw !== 'object') continue;

    let box: [number, number, number, number] | undefined;
    if (Array.isArray(raw.box_2d) && raw.box_2d.length === 4) {
      let [ymin, xmin, ymax, xmax] = raw.box_2d.map((n: any) => Number(n) || 0);
      ymin = Math.max(0, Math.min(1000, ymin));
      xmin = Math.max(0, Math.min(1000, xmin));
      ymax = Math.max(0, Math.min(1000, ymax));
      xmax = Math.max(0, Math.min(1000, xmax));
      if (raw.element_type !== 'abstract') {
        if (ymin >= ymax) [ymin, ymax] = [Math.min(ymin, ymax), Math.min(1000, Math.max(ymin, ymax) + 25)];
        if (xmin >= xmax) [xmin, xmax] = [Math.min(xmin, xmax), Math.min(1000, Math.max(xmin, xmax) + 25)];
        if (ymax - ymin > 5 && xmax - xmin > 5) {
          box = [Math.round(ymin), Math.round(xmin), Math.round(ymax), Math.round(xmax)];
        }
      } else {
        box = [0, 0, 0, 0];
      }
    }

    if (!box && raw.element_type !== 'abstract') continue;

    const area = box ? (box[2] - box[0]) * (box[3] - box[1]) : 0;
    cleaned.push(findingFromRaw(raw, i, viewport, box, area));
  }

  return sortFindings(cleaned);
}

/**
 * Every field of a finding except its geometry, coerced from model output. `areaUnits` is the
 * box area on the 0 to 1000 scale of the image the model saw, used only when the model gave no
 * valid box_confidence.
 */
/**
 * Titles and labels (finding context, category, section labels, priority reasons, hotspot
 * labels) never carry JSON debris. The model sometimes writes it inside a valid string, for
 * example "Lead Testimonial Card (Trust Proof)}{\"invalid\":false" (raw answer
 * 0018-page-section-11 of the 2026-11-24 run). The label is cut at the first brace or bracket,
 * or at a JSON key fragment such as `","` or `":"`, then trimmed of stray quotes and
 * punctuation. Returns null when nothing usable is left, so callers fall back to a safe default.
 */
export function cleanLabel(value: unknown, maxLength = 120): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  let s = String(value);
  const cut = s.search(/[{}[\]]|"\s*[,:]\s*"/);
  if (cut !== -1) s = s.slice(0, cut);
  s = s
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'`,:;\\]+|[\s"'`,:;\\]+$/g, '')
    .trim();
  if (!s) return null;
  if (s.length > maxLength) s = s.slice(0, maxLength).replace(/\s+\S*$/, '').trim() || s.slice(0, maxLength);
  return s;
}

export function findingFromRaw(
  raw: any,
  i: number,
  viewport: ViewportKey,
  box: [number, number, number, number] | undefined,
  areaUnits: number
): AuditFinding {
  const effort = ['quick-win', 'medium', 'complex'].includes(raw.effort_estimate) ? raw.effort_estimate : 'medium';
  const elementType = ELEMENT_TYPES.includes(raw.element_type) ? raw.element_type : 'text';
  const confidence = ['high', 'medium', 'low'].includes(raw.box_confidence)
    ? raw.box_confidence
    : areaUnits > 12000 ? 'high' : areaUnits > 2000 ? 'medium' : 'low';

  return {
    id: `${viewport}-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
    viewport,
    current_text: String(raw.current_text || 'N/A'),
    visual_description: String(raw.visual_description || raw.context || 'Page Element'),
    context: cleanLabel(raw.context) ?? cleanLabel(raw.category) ?? 'Page element',
    seo_analysis: String(raw.seo_analysis || ''),
    suggested_optimization: String(raw.suggested_optimization || ''),
    severity: severityOf(raw.severity),
    category: cleanLabel(raw.category, 60) ?? 'Conversion',
    impact_score: Math.max(0, Math.min(100, Math.round(Number(raw.impact_score) || 65))),
    effort_estimate: effort,
    technical_details: raw.technical_details ? String(raw.technical_details) : undefined,
    standards_violated: Array.isArray(raw.standards_violated) ? raw.standards_violated.map(String) : [],
    element_type: elementType,
    box_2d: box,
    box_confidence: confidence,
  };
}

/** Critical first, then warning, then info; within a severity, top of the image first. */
export function sortFindings(items: AuditFinding[]): AuditFinding[] {
  const order: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  return items.sort((a, b) => {
    const diff = order[a.severity] - order[b.severity];
    if (diff !== 0) return diff;
    return (a.box_2d?.[0] ?? 0) - (b.box_2d?.[0] ?? 0);
  });
}

/** Scores clamped to 0..100 with the historical defaults, plus their rounded mean. */
export function scoresFrom(raw: any): ViewportAudit['scores'] {
  const clarity = clampScore(raw?.clarity, 70);
  const visual_hierarchy = clampScore(raw?.visual_hierarchy, 70);
  const conversion = clampScore(raw?.conversion, 70);
  const trust_eeat = clampScore(raw?.trust_eeat, 65);
  const overall = Math.round((clarity + visual_hierarchy + conversion + trust_eeat) / 4);
  return { clarity, visual_hierarchy, conversion, trust_eeat, overall };
}

export function firstImpressionFrom(fit: any): ViewportAudit['first_impression_test'] {
  return fit && typeof fit === 'object'
    ? {
        passes_5s_test: Boolean(fit.passes_5s_test),
        visitor_understands: str(fit.visitor_understands),
        primary_distraction: str(fit.primary_distraction),
        single_biggest_lift: str(fit.single_biggest_lift),
      }
    : undefined;
}

/** Quick wins and severity counts for a final list of findings. */
export function summarizeFindings(items: AuditFinding[]): Pick<ViewportAudit, 'quick_wins' | 'critical_count' | 'warning_count' | 'info_count'> {
  const quickWinItems = items
    .filter((i) => i.effort_estimate === 'quick-win')
    .sort((a, b) => b.impact_score - a.impact_score)
    .slice(0, 3);
  const estimatedImpact = quickWinItems.length > 0
    ? Math.round(quickWinItems.reduce((sum, i) => sum + i.impact_score, 0) / quickWinItems.length)
    : 0;
  return {
    quick_wins: {
      count: quickWinItems.length,
      estimated_impact: estimatedImpact,
      top_3: quickWinItems.map((i) => i.suggested_optimization),
    },
    critical_count: items.filter((i) => i.severity === 'critical').length,
    warning_count: items.filter((i) => i.severity === 'warning').length,
    info_count: items.filter((i) => i.severity === 'info').length,
  };
}

/** Drops new findings whose box covers more than 45% of an existing box (or vice versa). */
export function dedupeAgainst(newItems: AuditFinding[], existing: Array<Pick<AuditFinding, 'box_2d'>>): AuditFinding[] {
  return newItems.filter((newItem) => {
    if (!newItem.box_2d || newItem.element_type === 'abstract') return true;
    const [ny1, nx1, ny2, nx2] = newItem.box_2d;
    return !existing.some((ex) => {
      if (!Array.isArray(ex?.box_2d) || ex.box_2d.length !== 4) return false;
      const [ey1, ex1, ey2, ex2] = ex.box_2d.map((n) => Number(n) || 0);
      const xOverlap = Math.max(0, Math.min(nx2, ex2) - Math.max(nx1, ex1));
      const yOverlap = Math.max(0, Math.min(ny2, ey2) - Math.max(ny1, ey1));
      const inter = xOverlap * yOverlap;
      const minArea = Math.min((nx2 - nx1) * (ny2 - ny1), (ex2 - ex1) * (ey2 - ey1));
      return minArea > 0 && inter / minArea > 0.45;
    });
  });
}

export function finalizeViewportAudit(raw: any, viewport: ViewportKey, modelUsed: string): ViewportAudit {
  const items = cleanFindings(raw?.items || [], viewport);

  // Predicted 3-second attention hotspots, or derived from the key bounding boxes
  let hotspots: AttentionHotspot[] = [];
  if (Array.isArray(raw?.attention_hotspots) && raw.attention_hotspots.length > 0) {
    hotspots = raw.attention_hotspots
      .filter((h: any) => h && typeof h === 'object')
      .slice(0, 6)
      .map((h: any, idx: number) => ({
        x: Math.max(40, Math.min(960, Math.round(Number(h.x) || 500))),
        y: Math.max(40, Math.min(960, Math.round(Number(h.y) || 300))),
        radius: Math.max(55, Math.min(200, Math.round(Number(h.radius) || 120))),
        intensity: Math.max(25, Math.min(100, Math.round(Number(h.intensity) || 80 - idx * 10))),
        rank: Math.max(1, Math.min(6, Math.round(Number(h.rank) || idx + 1))),
        label: cleanLabel(h.label, 60) ?? `Fixation #${idx + 1}`,
      }))
      .sort((a: AttentionHotspot, b: AttentionHotspot) => a.rank - b.rank);
  } else {
    hotspots = items
      .filter((it) => it.box_2d && it.element_type !== 'abstract')
      .slice(0, 5)
      .map((it, idx) => {
        const [ymin, xmin, ymax, xmax] = it.box_2d!;
        return {
          x: Math.round((xmin + xmax) / 2),
          y: Math.round((ymin + ymax) / 2),
          radius: Math.max(70, Math.min(180, Math.round(Math.max(xmax - xmin, ymax - ymin) * 0.45))),
          intensity: Math.max(40, 95 - idx * 12),
          rank: idx + 1,
          label: it.context,
        };
      });
  }

  return {
    overall_summary: str(raw?.overall_summary),
    strategic_advisor: str(raw?.strategic_advisor),
    first_impression_test: firstImpressionFrom(raw?.first_impression_test),
    scores: scoresFrom(raw?.scores),
    items,
    attention_hotspots: hotspots,
    ...summarizeFindings(items),
    model_used: modelUsed,
  };
}

export function normalizeComparison(raw: any): ComparisonSummary {
  const issues: ParityIssue[] = (Array.isArray(raw?.parity_issues) ? raw.parity_issues : [])
    .filter((p: any) => p && typeof p === 'object')
    .slice(0, 12)
    .map((p: any) => ({
      title: str(p.title, 'Parity issue'),
      severity: severityOf(p.severity),
      desktop_behavior: str(p.desktop_behavior),
      mobile_behavior: str(p.mobile_behavior),
      recommended_fix: str(p.recommended_fix),
    }));
  return {
    parity_score: clampScore(raw?.parity_score, 70),
    executive_verdict: str(raw?.executive_verdict),
    above_the_fold_delta: str(raw?.above_the_fold_delta),
    tap_target_verdict: str(raw?.tap_target_verdict),
    parity_issues: issues,
    generated_at: new Date().toISOString(),
  };
}

function stripWww(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, '');
}

const GENERIC_DOMAIN_LABELS = new Set([
  'agency', 'analytics', 'blog', 'cloud', 'consulting', 'content', 'digital', 'github',
  'google', 'growth', 'guide', 'linkedin', 'marketing', 'medium', 'online', 'platform',
  'reddit', 'review', 'reviews', 'search', 'service', 'services', 'shopify', 'software',
  'solutions', 'studio', 'tools', 'website', 'wordpress', 'youtube',
]);

function primaryDomainLabel(host: string): string {
  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) return '';
  const secondLevel = parts.length >= 3 && parts[parts.length - 2].length <= 3 ? parts[parts.length - 3] : parts[parts.length - 2];
  return secondLevel || '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Checks whether a competitor's normalized hostname matches any grounded search source.
 * Gemini puts Vertex redirect URLs in chunk.web.uri and the publisher domain or page title in
 * chunk.web.title, so we match against non-Vertex URI hosts, domain tokens in source titles,
 * and distinctive single-word brand labels in titles (zero extra HTTP hops).
 */
export function isGroundedDomainMatch(competitorUrl: string, sources: GroundingSource[]): boolean {
  let host: string;
  try {
    host = stripWww(new URL(competitorUrl).hostname);
  } catch {
    return false;
  }
  if (!host) return false;
  const label = primaryDomainLabel(host);
  const labelRe =
    label.length >= 6 && !label.includes('-') && !GENERIC_DOMAIN_LABELS.has(label)
      ? new RegExp(`\\b${escapeRegExp(label)}\\b`, 'i')
      : null;

  for (const s of sources) {
    try {
      const uriHost = stripWww(new URL(s.uri).hostname);
      if (uriHost && !uriHost.endsWith('vertexaisearch.cloud.google.com') && (uriHost === host || uriHost.endsWith(`.${host}`) || host.endsWith(`.${uriHost}`))) {
        return true;
      }
    } catch {
      // ignore invalid source URI
    }
    const rawTitle = String(s.title || '');
    const titleTokens = rawTitle.toLowerCase().match(/[a-z0-9.-]+\.[a-z]{2,}/g) ?? [];
    for (const tok of titleTokens) {
      const clean = stripWww(tok.replace(/^\.+|\.+$/g, ''));
      if (clean && (clean === host || clean.endsWith(`.${host}`) || host.endsWith(`.${clean}`))) return true;
    }
    if (labelRe && labelRe.test(rawTitle)) return true;
  }
  return false;
}

export interface GroundingExtract {
  sources: GroundingSource[];
  webSearchQueries: string[];
  searchEntryPointHtml?: string;
}

/** Extracts web sources, executed search queries, and Google Search entry-point HTML from groundingMetadata. */
export function groundingDetails(response: any): GroundingExtract {
  const meta = response?.candidates?.[0]?.groundingMetadata;
  const chunks = meta?.groundingChunks || [];
  const sources: GroundingSource[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks as any[]) {
    const uri = chunk?.web?.uri;
    if (uri && !seen.has(uri)) {
      seen.add(uri);
      sources.push({ title: String(chunk?.web?.title || uri), uri: String(uri) });
    }
  }
  const queries: string[] = Array.isArray(meta?.webSearchQueries)
    ? Array.from(new Set<string>(meta.webSearchQueries.map((q: unknown) => String(q || '').trim()).filter(Boolean))).slice(0, 8)
    : [];
  const rendered = typeof meta?.searchEntryPoint?.renderedContent === 'string'
    ? meta.searchEntryPoint.renderedContent.trim()
    : '';
  return {
    sources,
    webSearchQueries: queries,
    ...(rendered ? { searchEntryPointHtml: rendered } : {}),
  };
}

/** Competitors keep only URLs that would pass the capture route's URL check. */
export function normalizeSerp(
  raw: any,
  sources: GroundingSource[],
  grounding?: Pick<GroundingExtract, 'webSearchQueries' | 'searchEntryPointHtml'>
): SerpResearchResult {
  const strings = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max).map((s) => String(s)) : []);
  const competitors: SerpCompetitor[] = [];
  for (const c of Array.isArray(raw?.competitors) ? raw.competitors.slice(0, 8) : []) {
    if (!c || typeof c !== 'object') continue;
    let url: string;
    try {
      url = normalizeUrl(str(c.url));
    } catch {
      continue;
    }
    competitors.push({
      name: str(c.name, new URL(url).hostname),
      url,
      value_prop_hook: str(c.value_prop_hook),
      strength: str(c.strength),
      opportunity_gap: str(c.opportunity_gap),
      grounded_domain_match: sources.length > 0 ? isGroundedDomainMatch(url, sources) : undefined,
    });
  }
  const intent = str(raw?.search_intent).trim();
  const aiGaps = strings(raw?.ai_overview_geo_gaps, 10);
  const queries = grounding?.webSearchQueries ?? [];
  return {
    niche_summary: str(raw?.niche_summary) || 'Market category identified from live search.',
    positioning_verdict: str(raw?.positioning_verdict),
    ...(intent ? { search_intent: intent } : {}),
    competitors,
    keyword_opportunities: strings(raw?.keyword_opportunities, 12),
    eeat_gaps: strings(raw?.eeat_gaps, 10),
    ...(aiGaps.length > 0 ? { ai_overview_geo_gaps: aiGaps } : {}),
    quick_differentiators: strings(raw?.quick_differentiators, 10),
    ...(queries.length > 0 ? { web_search_queries: queries } : {}),
    ...(grounding?.searchEntryPointHtml ? { search_entry_point_html: grounding.searchEntryPointHtml } : {}),
    sources,
    generated_at: new Date().toISOString(),
  };
}

export function normalizeCodeFix(raw: any): CodeFixPatch | null {
  const code = str(raw?.code).trim();
  if (!code) return null;
  return {
    language: str(raw?.language, 'html').toLowerCase().slice(0, 20) || 'html',
    title: str(raw?.title, 'Suggested fix'),
    code,
    notes: str(raw?.notes),
    ticket_markdown: str(raw?.ticket_markdown),
  };
}

export function normalizeCopyVariants(raw: any): CopyVariant[] {
  return (Array.isArray(raw?.variants) ? raw.variants : [])
    .filter((v: any) => v && typeof v === 'object')
    .slice(0, 6)
    .map((v: any, idx: number) => ({
      id: `variant-${Date.now()}-${idx}`,
      angle: str(v.angle) || `Variant ${idx + 1}`,
      headline: str(v.headline),
      subheadline: str(v.subheadline),
      primary_cta: str(v.primary_cta),
      secondary_cta: v.secondary_cta ? String(v.secondary_cta) : undefined,
      rationale: str(v.rationale),
    }));
}

/** Unique web sources from a grounded response. */
export function groundingSources(response: any): GroundingSource[] {
  const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const sources: GroundingSource[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks as any[]) {
    const uri = chunk?.web?.uri;
    if (uri && !seen.has(uri)) {
      seen.add(uri);
      sources.push({ title: String(chunk?.web?.title || uri), uri: String(uri) });
    }
  }
  return sources;
}

// ---- dashes -------------------------------------------------------------------------------------
// The owner publishes this text and em or en dashes make it read as AI-written. Prompts ask the
// model not to use them (NO_DASHES_RULE in gemini.ts); this cleans any that still arrive.
// The characters are built from their code points so this source file contains none.

const D = `[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`;
const RE = {
  any: new RegExp(D),
  range: new RegExp(`(\\d)[ \\t]*${D}+[ \\t]*(?=[$${String.fromCharCode(0x20ac)}${String.fromCharCode(0xa3)}]?\\d)`, 'g'),
  lineStart: new RegExp(`^[ \\t]*${D}+[ \\t]*`, 'gm'),
  lineEnd: new RegExp(`[ \\t]*${D}+[ \\t]*$`, 'gm'),
  between: new RegExp(`[ \\t]*${D}+[ \\t]*`, 'g'),
  tail: new RegExp(`(?:\\s|${D})*$`),
};

/** A numeric range becomes "to"; a dash between words becomes ", "; a dash at a line edge goes. */
export function cleanDashes(text: string): string {
  if (!RE.any.test(text)) return text;
  return text
    .replace(RE.range, '$1 to ')
    .replace(RE.lineStart, '')
    .replace(RE.lineEnd, '')
    .replace(RE.between, ', ')
    .replace(/,[ \t]*([,.;:!?)])/g, '$1')
    .replace(/\([ \t]*,[ \t]*/g, '(');
}

/** Keys whose text must stay exactly as the model gave it: quotes of the page, code and links. */
const KEEP_VERBATIM = new Set(['current_text', 'code', 'url', 'uri']);

/** Cleans dashes in every string of a parsed model answer, except the keys in KEEP_VERBATIM. */
export function cleanModelText<T>(value: T, key?: string): T {
  if (typeof value === 'string') return (key && KEEP_VERBATIM.has(key) ? value : cleanDashes(value)) as T;
  if (Array.isArray(value)) return value.map((v) => cleanModelText(v, key)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = cleanModelText(v, k);
    return out as T;
  }
  return value;
}

/**
 * The same cleanup for streamed text (chat). A trailing run of spaces and dashes is held back
 * until the next chunk, and the last character already sent is used as context, so a dash split
 * across chunks is cleaned exactly as it would be in one string.
 */
export function createDashStreamCleaner(): { push(chunk: string): string; flush(): string } {
  let carry = '';
  let last = '';
  const clean = (piece: string) => {
    if (!piece) return '';
    if (!last) return cleanDashes(piece);
    const cleaned = cleanDashes(last + piece);
    return cleaned.startsWith(last) ? cleaned.slice(last.length) : cleanDashes(piece);
  };
  return {
    push(chunk: string) {
      const buffer = carry + chunk;
      const tail = RE.tail.exec(buffer)![0];
      carry = tail;
      const out = clean(buffer.slice(0, buffer.length - tail.length));
      if (out) last = out[out.length - 1];
      return out;
    },
    flush() {
      const out = clean(carry);
      carry = '';
      return out;
    },
  };
}
