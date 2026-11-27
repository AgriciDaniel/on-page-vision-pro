/**
 * Pure section planning, tile-to-page coordinate mapping, IoU, and seam
 * deduplication for tall full-page screenshot audits.
 * Zero external dependencies; usable on both server and browser.
 */

import {
  type Box2d,
  type ImageSize,
  type PixelRect,
  box2dToPixelRect,
  normalizeBox2d,
  pixelRectToBox2d,
} from './geometry.ts';

export interface PageSection {
  readonly index: number;
  readonly yStart: number;
  readonly yEnd: number;
  readonly width: number;
  readonly height: number;
}

export interface PlanSectionsOptions {
  /** Target section height in pixels (default 1800). */
  readonly sectionHeight?: number;
  /** Vertical overlap fraction between consecutive sections (default 0.15). */
  readonly overlapRatio?: number;
  /** Minimum height for the final section in pixels (default 400). */
  readonly minSectionHeight?: number;
}

export interface MappedPageBox {
  readonly pixelRect: PixelRect;
  readonly pageBox2d: [number, number, number, number];
}

export interface SectionFindingLike {
  readonly id?: string;
  readonly severity: string;
  readonly category?: string;
  readonly current_text?: string;
  readonly visual_description?: string;
  readonly sectionIndex?: number;
  readonly pixelRect?: PixelRect;
  readonly box_2d?: Box2d;
  readonly clipped?: boolean;
}

export interface DedupeOptions {
  /** Minimum IoU to treat two overlapping boxes as the same element (default 0.4). */
  readonly iouThreshold?: number;
  /** Minimum intersection-over-smaller ratio to treat two boxes as the same element (default 0.5). */
  readonly iosThreshold?: number;
  /** Minimum token Jaccard similarity to consider two texts matching (default 0.5). */
  readonly textSimilarityThreshold?: number;
  /** Optional planned sections used to infer clipping when finding.clipped is omitted. */
  readonly sections?: readonly PageSection[];
  /** Edge tolerance in pixels for clipped-seam detection (default 4). */
  readonly clipTolerancePx?: number;
}

const DEFAULT_SECTION_HEIGHT = 1800;
const DEFAULT_OVERLAP_RATIO = 0.15;
const DEFAULT_MIN_SECTION_HEIGHT = 400;
const DEFAULT_IOU_THRESHOLD = 0.4;
const DEFAULT_IOS_THRESHOLD = 0.5;
const DEFAULT_TEXT_SIMILARITY_THRESHOLD = 0.5;
const DEFAULT_CLIP_TOLERANCE_PX = 4;

const SEVERITY_RANK: Readonly<Record<string, number>> = {
  critical: 3,
  warning: 2,
  info: 1,
};

function isPositiveFinite(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

function severityRank(severity: string): number {
  return SEVERITY_RANK[severity.toLowerCase()] ?? 0;
}

/**
 * Plan ordered overlapping vertical sections covering [0, height].
 * - Zero or negative dimensions return an empty array.
 * - Viewport-sized images (height <= sectionHeight) return exactly one section.
 * - The final section is never thinner than minSectionHeight (clamped to sectionHeight).
 */
export function planSections(
  width: number,
  height: number,
  options: PlanSectionsOptions = {}
): PageSection[] {
  if (!isPositiveFinite(width) || !isPositiveFinite(height)) {
    return [];
  }

  const sectionHeight = isPositiveFinite(options.sectionHeight ?? DEFAULT_SECTION_HEIGHT)
    ? Math.floor(options.sectionHeight ?? DEFAULT_SECTION_HEIGHT)
    : DEFAULT_SECTION_HEIGHT;

  const rawOverlap = options.overlapRatio ?? DEFAULT_OVERLAP_RATIO;
  const overlapRatio = Number.isFinite(rawOverlap)
    ? Math.max(0, Math.min(0.5, rawOverlap))
    : DEFAULT_OVERLAP_RATIO;

  const rawMin = options.minSectionHeight ?? DEFAULT_MIN_SECTION_HEIGHT;
  const minSectionHeight = isPositiveFinite(rawMin)
    ? Math.min(sectionHeight, Math.floor(rawMin))
    : Math.min(sectionHeight, DEFAULT_MIN_SECTION_HEIGHT);

  if (height <= sectionHeight) {
    return [{ index: 0, yStart: 0, yEnd: height, width, height }];
  }

  const overlapPx = Math.min(sectionHeight - 1, Math.round(sectionHeight * overlapRatio));
  const step = Math.max(1, sectionHeight - overlapPx);

  const sections: PageSection[] = [];
  let yStart = 0;

  while (yStart < height) {
    let yEnd = Math.min(yStart + sectionHeight, height);

    // Ensure the trailing section is never thinner than minSectionHeight.
    if (yEnd === height && yEnd - yStart < minSectionHeight && sections.length > 0) {
      yStart = Math.max(0, height - minSectionHeight);
    }

    sections.push({
      index: sections.length,
      yStart,
      yEnd,
      width,
      height: yEnd - yStart,
    });

    if (yEnd >= height) {
      break;
    }
    yStart += step;
  }

  return sections;
}

/**
 * Map a Gemini box_2d returned for one section into full-page pixel coordinates
 * and a full-page 0..1000 box_2d.
 */
export function mapBoxToPage(
  box: Box2d,
  section: PageSection,
  pageSize: ImageSize
): MappedPageBox {
  if (
    !isPositiveFinite(pageSize.width) ||
    !isPositiveFinite(pageSize.height) ||
    !isPositiveFinite(section.width) ||
    !isPositiveFinite(section.height)
  ) {
    return {
      pixelRect: { x: 0, y: 0, width: 0, height: 0 },
      pageBox2d: [0, 0, 0, 0],
    };
  }

  const [ymin, xmin, ymax, xmax] = normalizeBox2d(box);
  const rawX = (xmin / 1000) * section.width;
  const rawY = section.yStart + (ymin / 1000) * section.height;
  const rawX2 = (xmax / 1000) * section.width;
  const rawY2 = section.yStart + (ymax / 1000) * section.height;

  const x0 = Math.max(0, Math.min(pageSize.width, rawX));
  const y0 = Math.max(0, Math.min(pageSize.height, rawY));
  const x1 = Math.max(x0, Math.min(pageSize.width, rawX2));
  const y1 = Math.max(y0, Math.min(pageSize.height, rawY2));

  const pixelRect: PixelRect = {
    x: x0,
    y: y0,
    width: x1 - x0,
    height: y1 - y0,
  };

  return {
    pixelRect,
    pageBox2d: pixelRectToBox2d(pixelRect, pageSize),
  };
}

/**
 * Compute Intersection over Union (IoU) in [0, 1] for two pixel rectangles.
 */
export function intersectionOverUnion(a: PixelRect, b: PixelRect): number {
  const interArea = intersectionArea(a, b);
  if (interArea <= 0) return 0;

  const unionArea = a.width * a.height + b.width * b.height - interArea;
  return unionArea > 0 ? interArea / unionArea : 0;
}

/**
 * Compute Intersection over Smaller (IoS) in [0, 1]: intersection area divided
 * by the area of the smaller rectangle. Catches partial boxes cut by a section
 * edge that sit inside a fuller box from the neighbouring section.
 */
export function intersectionOverSmaller(a: PixelRect, b: PixelRect): number {
  const interArea = intersectionArea(a, b);
  if (interArea <= 0) return 0;

  const smallerArea = Math.min(a.width * a.height, b.width * b.height);
  return smallerArea > 0 ? interArea / smallerArea : 0;
}

function intersectionArea(a: PixelRect, b: PixelRect): number {
  if (
    !isPositiveFinite(a.width) ||
    !isPositiveFinite(a.height) ||
    !isPositiveFinite(b.width) ||
    !isPositiveFinite(b.height) ||
    !Number.isFinite(a.x) ||
    !Number.isFinite(a.y) ||
    !Number.isFinite(b.x) ||
    !Number.isFinite(b.y)
  ) {
    return 0;
  }

  const interX0 = Math.max(a.x, b.x);
  const interY0 = Math.max(a.y, b.y);
  const interX1 = Math.min(a.x + a.width, b.x + b.width);
  const interY1 = Math.min(a.y + a.height, b.y + b.height);

  const interW = Math.max(0, interX1 - interX0);
  const interH = Math.max(0, interY1 - interY0);
  return interW * interH;
}

function unionRect(a: PixelRect, b: PixelRect): PixelRect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width);
  const y1 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Return true when a section-relative box_2d touches the top or bottom edge of
 * its section (within tolerance in pixels) and that edge is not the page edge.
 */
export function isClippedBySection(
  box: Box2d,
  section: PageSection,
  pageSize: ImageSize,
  tolerance = DEFAULT_CLIP_TOLERANCE_PX
): boolean {
  if (
    !isPositiveFinite(section.width) ||
    !isPositiveFinite(section.height) ||
    !isPositiveFinite(pageSize.width) ||
    !isPositiveFinite(pageSize.height)
  ) {
    return false;
  }

  const tolPx = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 0;
  const [ymin, , ymax] = normalizeBox2d(box);
  const topDistPx = (ymin / 1000) * section.height;
  const bottomDistPx = ((1000 - ymax) / 1000) * section.height;

  const touchesInternalTop = section.yStart > 0 && topDistPx <= tolPx;
  const touchesInternalBottom = section.yEnd < pageSize.height && bottomDistPx <= tolPx;
  return touchesInternalTop || touchesInternalBottom;
}

/**
 * Return the index of the section whose vertical centre is nearest to pageY.
 * Returns -1 when sections is empty or pageY is non-finite.
 */
export function ownerSectionIndex(
  pageY: number,
  sections: readonly PageSection[]
): number {
  if (!Number.isFinite(pageY) || sections.length === 0) {
    return -1;
  }

  let bestIndex = sections[0].index;
  let bestDist = Math.abs(pageY - (sections[0].yStart + sections[0].yEnd) / 2);

  for (let i = 1; i < sections.length; i += 1) {
    const centre = (sections[i].yStart + sections[i].yEnd) / 2;
    const dist = Math.abs(pageY - centre);
    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = sections[i].index;
    }
  }

  return bestIndex;
}

function isRectClippedBySection(
  rect: PixelRect,
  section: PageSection,
  pageSize: ImageSize,
  tolerancePx: number
): boolean {
  const touchesInternalTop =
    section.yStart > 0 && Math.abs(rect.y - section.yStart) <= tolerancePx;
  const touchesInternalBottom =
    section.yEnd < pageSize.height &&
    Math.abs(rect.y + rect.height - section.yEnd) <= tolerancePx;
  return touchesInternalTop || touchesInternalBottom;
}

function horizontalOverlapRatio(a: PixelRect, b: PixelRect): number {
  const overlapW = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const minW = Math.min(a.width, b.width);
  return minW > 0 ? overlapW / minW : 0;
}

function verticalGapPx(a: PixelRect, b: PixelRect): number {
  return Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
}

function normalizeLabel(value?: string): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function tokenize(value?: string): Set<string> {
  const clean = (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim();
  if (!clean) return new Set();
  return new Set(clean.split(/\s+/).filter(Boolean));
}

function textsMatch(a: SectionFindingLike, b: SectionFindingLike, threshold: number): boolean {
  const textA = normalizeLabel(a.current_text || a.visual_description);
  const textB = normalizeLabel(b.current_text || b.visual_description);
  if (!textA || !textB) return false;
  if (textA === textB) return true;
  if (textA.length >= 4 && textB.length >= 4 && (textA.includes(textB) || textB.includes(textA))) {
    return true;
  }

  const tokensA = tokenize(textA);
  const tokensB = tokenize(textB);
  if (tokensA.size === 0 || tokensB.size === 0) return false;

  let overlap = 0;
  for (const tok of tokensA) {
    if (tokensB.has(tok)) overlap += 1;
  }
  const union = tokensA.size + tokensB.size - overlap;
  return union > 0 && overlap / union >= threshold;
}

function categoriesMatch(a: SectionFindingLike, b: SectionFindingLike): boolean {
  const catA = normalizeLabel(a.category);
  const catB = normalizeLabel(b.category);
  return catA.length > 0 && catA === catB;
}

function resolveRect(finding: SectionFindingLike, pageSize?: ImageSize): PixelRect | null {
  if (
    finding.pixelRect &&
    isPositiveFinite(finding.pixelRect.width) &&
    isPositiveFinite(finding.pixelRect.height)
  ) {
    return finding.pixelRect;
  }
  if (finding.box_2d && pageSize) {
    const rect = box2dToPixelRect(finding.box_2d, pageSize);
    if (isPositiveFinite(rect.width) && isPositiveFinite(rect.height)) {
      return rect;
    }
  }
  return null;
}

function resolveClipped(
  finding: SectionFindingLike,
  rect: PixelRect,
  pageSize: ImageSize | undefined,
  sections: readonly PageSection[] | undefined,
  clipTolerancePx: number
): boolean {
  if (finding.clipped !== undefined) return finding.clipped;
  if (!sections || !pageSize || finding.sectionIndex === undefined) return false;
  const sec = sections.find((s) => s.index === finding.sectionIndex);
  if (!sec) return false;
  return isRectClippedBySection(rect, sec, pageSize, clipTolerancePx);
}

function applyMergedRect<T extends SectionFindingLike>(
  item: T,
  rect: PixelRect,
  pageSize?: ImageSize
): T {
  return {
    ...item,
    ...(item.pixelRect !== undefined ? { pixelRect: rect } : {}),
    ...(item.box_2d !== undefined && pageSize
      ? { box_2d: pixelRectToBox2d(rect, pageSize) }
      : {}),
  };
}

/**
 * Deduplicate findings seen across overlapping section seams.
 * Two findings from different sections merge when:
 * - their IoU >= iouThreshold OR intersectionOverSmaller >= iosThreshold
 *   (or both are clipped and abut across the seam with matching horizontal span), AND
 * - they share either the same category or matching text.
 * When one finding is unclipped and the other is clipped, the unclipped finding
 * is preferred. When both are clipped, the kept rect is merged to their union.
 * Otherwise, the higher severity finding is kept.
 */
export function dedupeAcrossSections<T extends SectionFindingLike>(
  findings: readonly T[],
  pageSize?: ImageSize,
  options: DedupeOptions = {}
): T[] {
  const iouThreshold = Number.isFinite(options.iouThreshold)
    ? Math.max(0, Math.min(1, options.iouThreshold!))
    : DEFAULT_IOU_THRESHOLD;
  const iosThreshold = Number.isFinite(options.iosThreshold)
    ? Math.max(0, Math.min(1, options.iosThreshold!))
    : DEFAULT_IOS_THRESHOLD;
  const textThreshold = Number.isFinite(options.textSimilarityThreshold)
    ? Math.max(0, Math.min(1, options.textSimilarityThreshold!))
    : DEFAULT_TEXT_SIMILARITY_THRESHOLD;
  const clipTolerancePx =
    Number.isFinite(options.clipTolerancePx) && options.clipTolerancePx! >= 0
      ? options.clipTolerancePx!
      : DEFAULT_CLIP_TOLERANCE_PX;

  const kept: Array<{
    item: T;
    rect: PixelRect | null;
    clipped: boolean;
    sections: Set<number>;
  }> = [];

  for (const candidate of findings) {
    const candRect = resolveRect(candidate, pageSize);
    if (!candRect) {
      const sections = new Set<number>();
      if (candidate.sectionIndex !== undefined) sections.add(candidate.sectionIndex);
      kept.push({ item: candidate, rect: null, clipped: Boolean(candidate.clipped), sections });
      continue;
    }

    const candClipped = resolveClipped(
      candidate,
      candRect,
      pageSize,
      options.sections,
      clipTolerancePx
    );

    let matchedIndex = -1;
    for (let i = 0; i < kept.length; i += 1) {
      const existing = kept[i];
      if (!existing.rect) continue;

      if (
        candidate.sectionIndex !== undefined &&
        existing.sections.has(candidate.sectionIndex)
      ) {
        continue;
      }

      const iou = intersectionOverUnion(existing.rect, candRect);
      const ios = intersectionOverSmaller(existing.rect, candRect);
      const seamAbutting =
        existing.clipped &&
        candClipped &&
        verticalGapPx(existing.rect, candRect) <= clipTolerancePx &&
        horizontalOverlapRatio(existing.rect, candRect) >= iosThreshold;

      if (iou < iouThreshold && ios < iosThreshold && !seamAbutting) continue;

      if (
        categoriesMatch(existing.item, candidate) ||
        textsMatch(existing.item, candidate, textThreshold)
      ) {
        matchedIndex = i;
        break;
      }
    }

    if (matchedIndex === -1) {
      const sections = new Set<number>();
      if (candidate.sectionIndex !== undefined) sections.add(candidate.sectionIndex);
      kept.push({ item: candidate, rect: candRect, clipped: candClipped, sections });
      continue;
    }

    const existing = kept[matchedIndex];
    if (candidate.sectionIndex !== undefined) {
      existing.sections.add(candidate.sectionIndex);
    }

    if (existing.clipped && !candClipped) {
      kept[matchedIndex] = {
        item: candidate,
        rect: candRect,
        clipped: false,
        sections: existing.sections,
      };
    } else if (!existing.clipped && candClipped) {
      // Keep the unclipped existing finding and its rect as-is.
    } else if (existing.clipped && candClipped) {
      const mergedRect = unionRect(existing.rect!, candRect);
      const winner =
        severityRank(candidate.severity) > severityRank(existing.item.severity)
          ? candidate
          : existing.item;
      kept[matchedIndex] = {
        item: applyMergedRect(winner, mergedRect, pageSize),
        rect: mergedRect,
        clipped: true,
        sections: existing.sections,
      };
    } else if (severityRank(candidate.severity) > severityRank(existing.item.severity)) {
      kept[matchedIndex] = {
        item: candidate,
        rect: candRect,
        clipped: false,
        sections: existing.sections,
      };
    }
  }

  return kept.map((entry) => entry.item);
}
