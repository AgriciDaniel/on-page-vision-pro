/**
 * Pure, dependency-free cross-viewport finding linker.
 * Matches desktop and mobile findings that describe the same real page element
 * or issue, prioritizing quoted text evidence over title/category and weak
 * section/position cues. Usable on both server and browser.
 */

export interface CrossViewportFinding {
  readonly id: string;
  readonly context: string;
  readonly category: string;
  readonly current_text: string;
  readonly severity: string;
  readonly box_px?: readonly [number, number, number, number];
  readonly box_2d?: readonly [number, number, number, number];
  readonly section_index?: number;
}

export interface CrossViewportSection {
  readonly index: number;
  readonly yStart: number;
  readonly yEnd: number;
  readonly label?: string;
}

export interface CrossViewportSide {
  readonly items: readonly CrossViewportFinding[];
  readonly image?: { readonly width: number; readonly height: number } | null;
  readonly sections?: readonly CrossViewportSection[];
}

export type MatchReason =
  | 'exact_text'
  | 'text_overlap'
  | 'title_match'
  | 'same_category'
  | 'section_match'
  | 'position_close';

export interface CrossViewportPair {
  readonly desktopId: string;
  readonly mobileId: string;
  readonly score: number;
  readonly reasons: readonly MatchReason[];
}

export interface CrossViewportLinkResult {
  readonly pairs: readonly CrossViewportPair[];
  readonly unmatchedDesktopIds: readonly string[];
  readonly unmatchedMobileIds: readonly string[];
}

export interface LinkAcrossViewportsOptions {
  /** Minimum score in [0, 1] required when exact_text or title_match is present (default 0.52). */
  readonly threshold?: number;
  /** Higher minimum score in [0, 1] required when neither exact_text nor title_match is present (default 0.68). */
  readonly noAnchorThreshold?: number;
}

const DEFAULT_THRESHOLD = 0.52;
const DEFAULT_NO_ANCHOR_THRESHOLD = 0.68;

const PLACEHOLDER_TEXTS = new Set([
  '',
  'n/a',
  'na',
  'none',
  'null',
  'undefined',
  '-',
  '--',
]);

const GENERIC_TITLES = new Set([
  'primary cta',
  'secondary cta',
  'section cta',
  'card cta',
  'cta',
  'trust proof',
  'social proof',
  'section heading',
  'section heading h2',
  'heading',
  'value proposition',
  'page element',
]);

const TITLE_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'of',
  'in',
  'on',
  'to',
  'a',
  'an',
  'section',
  'card',
  'block',
  'element',
  'h1',
  'h2',
  'h3',
]);

const TEXT_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'of',
  'in',
  'on',
  'to',
  'a',
  'an',
  'is',
  'are',
  'or',
  'by',
  'at',
]);

function stripDebris(raw: string): string {
  const cut = raw.search(/[{}\[\]]/);
  return cut >= 0 ? raw.slice(0, cut) : raw;
}

function normalizeText(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (PLACEHOLDER_TEXTS.has(trimmed)) return null;
  const collapsed = trimmed
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!collapsed || PLACEHOLDER_TEXTS.has(collapsed)) return null;
  return collapsed;
}

function tokenize(normalized: string | null, stopwords: ReadonlySet<string>): string[] {
  if (!normalized) return [];
  const rawTokens = normalized.split(' ').filter(Boolean);
  const filtered = rawTokens.filter((t) => t.length > 1 && !stopwords.has(t));
  // Preserve single-character tokens when the entire string is spaced letters (e.g. "M A K E A I").
  return filtered.length > 0 ? filtered : rawTokens;
}

function uniqueSet(tokens: readonly string[]): Set<string> {
  return new Set(tokens);
}

function intersectionCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0;
  for (const t of a) {
    if (b.has(t)) count += 1;
  }
  return count;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const inter = intersectionCount(a, b);
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

function containment(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const minSize = Math.min(a.size, b.size);
  if (minSize === 0) return 0;
  return intersectionCount(a, b) / minSize;
}

function relativeY(
  item: CrossViewportFinding,
  side: CrossViewportSide
): number | null {
  const imgH = side.image?.height ?? 0;
  if (item.box_px && imgH > 0) {
    const [y0, , y1] = item.box_px;
    if (Number.isFinite(y0) && Number.isFinite(y1) && y1 > y0) {
      return Math.max(0, Math.min(1, ((y0 + y1) / 2) / imgH));
    }
  }
  if (item.box_2d) {
    const [y0, , y1] = item.box_2d;
    if (Number.isFinite(y0) && Number.isFinite(y1) && y1 > y0) {
      return Math.max(0, Math.min(1, ((y0 + y1) / 2) / 1000));
    }
  }
  if (item.section_index !== undefined && side.sections && imgH > 0) {
    const sec = side.sections.find((s) => s.index === item.section_index);
    if (sec && sec.yEnd > sec.yStart) {
      return Math.max(0, Math.min(1, ((sec.yStart + sec.yEnd) / 2) / imgH));
    }
  }
  return null;
}

function sectionTokens(
  item: CrossViewportFinding,
  side: CrossViewportSide
): Set<string> {
  if (item.section_index === undefined || !side.sections) return new Set();
  const sec = side.sections.find((s) => s.index === item.section_index);
  if (!sec || !sec.label) return new Set();
  return uniqueSet(tokenize(normalizeText(sec.label), TITLE_STOPWORDS));
}

interface PreparedItem {
  readonly item: CrossViewportFinding;
  readonly normText: string | null;
  readonly textTokens: Set<string>;
  readonly normTitle: string | null;
  readonly titleTokens: Set<string>;
  readonly isGenericTitle: boolean;
  readonly normCategory: string;
  readonly secTokens: Set<string>;
  readonly relY: number | null;
}

function prepareSide(side: CrossViewportSide | null | undefined): PreparedItem[] {
  if (!side || !Array.isArray(side.items)) return [];
  return side.items.map((item) => {
    const normText = normalizeText(item.current_text);
    const normTitle = normalizeText(stripDebris(item.context || ''));
    return {
      item,
      normText,
      textTokens: uniqueSet(tokenize(normText, TEXT_STOPWORDS)),
      normTitle,
      titleTokens: uniqueSet(tokenize(normTitle, TITLE_STOPWORDS)),
      isGenericTitle: normTitle ? GENERIC_TITLES.has(normTitle) : true,
      normCategory: (item.category || '').trim().toLowerCase(),
      secTokens: sectionTokens(item, side),
      relY: relativeY(item, side),
    };
  });
}

function scorePair(
  d: PreparedItem,
  m: PreparedItem
): { score: number; reasons: MatchReason[] } {
  const reasons: MatchReason[] = [];
  let score = 0;

  // 1. Quoted current_text (strongest evidence, up to 0.58)
  const bothHaveText = d.normText !== null && m.normText !== null;
  let textSim = 0;
  if (bothHaveText) {
    if (d.normText === m.normText && d.normText!.length >= 3) {
      textSim = 1;
      score += 0.58;
      reasons.push('exact_text');
    } else {
      const inter = intersectionCount(d.textTokens, m.textTokens);
      const j = jaccard(d.textTokens, m.textTokens);
      const c = containment(d.textTokens, m.textTokens);
      const shorter =
        d.normText!.length <= m.normText!.length ? d.normText! : m.normText!;
      const longer =
        d.normText!.length <= m.normText!.length ? m.normText! : d.normText!;
      const isStrongSubstring = shorter.length >= 8 && longer.includes(shorter);

      if (inter >= 2 || isStrongSubstring) {
        textSim = 0.55 * j + 0.45 * c;
      } else {
        textSim = 0.55 * j;
      }

      if (textSim > 0) {
        score += 0.54 * textSim;
        if (textSim >= 0.32) {
          reasons.push('text_overlap');
        }
      }
    }

    // Conflict guard: if both findings quote real multi-token text with near-zero overlap,
    // they refer to different elements even if they share a title or category.
    if (d.textTokens.size >= 2 && m.textTokens.size >= 2 && textSim < 0.15) {
      return { score: 0, reasons: [] };
    }
  }

  // 2. Title (context) & category (up to 0.24)
  let titleSim = 0;
  if (d.normTitle && m.normTitle) {
    if (d.normTitle === m.normTitle) {
      titleSim = d.isGenericTitle ? 0.45 : 1.0;
    } else {
      const j = jaccard(d.titleTokens, m.titleTokens);
      const c = containment(d.titleTokens, m.titleTokens);
      titleSim = 0.65 * j + 0.35 * c;
      if (d.isGenericTitle && m.isGenericTitle) {
        titleSim = Math.min(titleSim, 0.45);
      }
    }
    if (titleSim > 0) {
      score += 0.18 * titleSim;
      if (titleSim >= 0.45) {
        reasons.push('title_match');
      }
    }
  }

  const sameCat = d.normCategory.length > 0 && d.normCategory === m.normCategory;
  if (sameCat) {
    score += 0.06;
    reasons.push('same_category');
  }

  // 3. Section label & relative position (weak evidence, up to 0.18)
  let secSim = 0;
  if (d.secTokens.size > 0 && m.secTokens.size > 0) {
    secSim = jaccard(d.secTokens, m.secTokens);
    if (secSim > 0) {
      score += 0.09 * secSim;
      if (secSim >= 0.34) {
        reasons.push('section_match');
      }
    }
  }

  let posDiff: number | null = null;
  if (d.relY !== null && m.relY !== null) {
    posDiff = Math.abs(d.relY - m.relY);
    const posSim = Math.max(0, 1 - posDiff / 0.25);
    if (posSim > 0) {
      score += 0.09 * posSim;
      if (posDiff <= 0.12) {
        reasons.push('position_close');
      }
    }
  }

  // 4. Visual-only (no quoted text on either side, e.g. chart or graphic):
  // allow a link when exact non-generic title, category, and relative position agree.
  if (
    d.normText === null &&
    m.normText === null &&
    !d.isGenericTitle &&
    !m.isGenericTitle &&
    titleSim >= 0.85 &&
    sameCat &&
    posDiff !== null &&
    posDiff <= 0.12
  ) {
    score += 0.18;
  }

  const clamped = Math.max(0, Math.min(1, Number(score.toFixed(4))));
  return { score: clamped, reasons };
}

/**
 * Link desktop and mobile findings that describe the same real issue.
 * Each finding links to at most one twin (highest score wins, deterministic).
 */
export function linkAcrossViewports(
  desktop: CrossViewportSide | null | undefined,
  mobile: CrossViewportSide | null | undefined,
  options: LinkAcrossViewportsOptions = {}
): CrossViewportLinkResult {
  const threshold = Number.isFinite(options.threshold)
    ? Math.max(0, Math.min(1, options.threshold!))
    : DEFAULT_THRESHOLD;
  const noAnchorThreshold = Number.isFinite(options.noAnchorThreshold)
    ? Math.max(threshold, Math.min(1, options.noAnchorThreshold!))
    : Math.max(threshold, DEFAULT_NO_ANCHOR_THRESHOLD);

  const dItems = prepareSide(desktop);
  const mItems = prepareSide(mobile);

  if (dItems.length === 0 || mItems.length === 0) {
    return {
      pairs: [],
      unmatchedDesktopIds: dItems.map((d) => d.item.id),
      unmatchedMobileIds: mItems.map((m) => m.item.id),
    };
  }

  const candidates: CrossViewportPair[] = [];
  for (const d of dItems) {
    for (const m of mItems) {
      const { score, reasons } = scorePair(d, m);
      const hasAnchor =
        reasons.includes('exact_text') || reasons.includes('title_match');
      const required = hasAnchor ? threshold : noAnchorThreshold;
      if (score >= required) {
        candidates.push({
          desktopId: d.item.id,
          mobileId: m.item.id,
          score,
          reasons,
        });
      }
    }
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.desktopId !== b.desktopId) return a.desktopId < b.desktopId ? -1 : 1;
    if (a.mobileId !== b.mobileId) return a.mobileId < b.mobileId ? -1 : 1;
    return 0;
  });

  const usedDesktop = new Set<string>();
  const usedMobile = new Set<string>();
  const pairs: CrossViewportPair[] = [];

  for (const cand of candidates) {
    if (usedDesktop.has(cand.desktopId) || usedMobile.has(cand.mobileId)) continue;
    usedDesktop.add(cand.desktopId);
    usedMobile.add(cand.mobileId);
    pairs.push(cand);
  }

  return {
    pairs,
    unmatchedDesktopIds: dItems
      .map((d) => d.item.id)
      .filter((id) => !usedDesktop.has(id)),
    unmatchedMobileIds: mItems
      .map((m) => m.item.id)
      .filter((id) => !usedMobile.has(id)),
  };
}
