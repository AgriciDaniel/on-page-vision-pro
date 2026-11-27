/**
 * Where things are on one viewport's screenshot, for viewport and full-page audits alike.
 *
 * Every screen that draws or describes findings (canvas, compare, progress overlay, report,
 * exports) asks this module instead of doing its own box math. It hides three things:
 * - which coordinates to trust (box_px from a full-page audit beats box_2d),
 * - what to do with old sessions (no natural size, no mode, no fold),
 * - the first-screen rules (fold, hotspots, hero crops).
 * The math itself comes from lib/geometry.ts.
 */
import {
  box2dToPixelRect,
  foldFraction,
  hotspotRadiusPx,
  pixelRectToPercentStyle,
  type ImageSize,
  type PercentRectStyle,
  type PixelRect,
} from '../geometry';
import type {
  AttentionHotspot,
  AuditFinding,
  CaptureMode,
  PageSectionInfo,
  ViewportData,
  ViewportKey,
} from '../../types';
import { VIEWPORT_SIZES, foldPxFor } from './images';

/** Boxes smaller than this (in image px, either side) are not drawn. */
const MIN_BOX_PX = 3;

export interface PageView {
  size: ImageSize;
  mode: CaptureMode;
  /** Bottom of the first screen, image px. Equals size.height for a viewport shot. */
  foldPx: number;
  /** True when a fold line means something: a full page taller than its first screen. */
  showFold: boolean;
  sections: PageSectionInfo[];
}

/** Describe one viewport's image. Works on sessions saved before wave 1 and wave 2. */
export function pageViewOf(vp: ViewportData, key: ViewportKey): PageView {
  const fallback = VIEWPORT_SIZES[key];
  const size: ImageSize = {
    width: vp.naturalWidth || vp.analysis?.image?.width || fallback.width,
    height: vp.naturalHeight || vp.analysis?.image?.height || fallback.height,
  };
  const mode: CaptureMode = vp.analysis?.mode ?? vp.captureMode ?? 'viewport';
  const foldPx = Math.min(size.height, vp.foldPx || foldPxFor(size.width, size.height, key, mode));
  return {
    size,
    mode,
    foldPx,
    showFold: mode === 'fullpage' && foldPx < size.height - 1,
    sections: Array.isArray(vp.analysis?.sections) ? vp.analysis!.sections! : [],
  };
}

/** The finding's box in image px, or null for page-wide findings and boxes too small to draw. */
export function findingRect(item: AuditFinding, view: PageView): PixelRect | null {
  if (item.element_type === 'abstract') return null;
  let rect: PixelRect | null = null;
  if (Array.isArray(item.box_px) && item.box_px.length === 4) {
    const [y0, x0, y1, x1] = item.box_px;
    rect = { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
  } else if (Array.isArray(item.box_2d) && item.box_2d.length === 4) {
    rect = box2dToPixelRect(item.box_2d, view.size);
  }
  if (!rect || !(rect.width >= MIN_BOX_PX) || !(rect.height >= MIN_BOX_PX)) return null;
  return rect;
}

/** CSS percent style placing a finding's box over the image, or null when it has no drawable box. */
export function findingBoxStyle(item: AuditFinding, view: PageView): PercentRectStyle | null {
  const rect = findingRect(item, view);
  return rect ? pixelRectToPercentStyle(rect, view.size) : null;
}

/** The section a finding belongs to: its section_index, else the section holding its box centre. */
export function findingSection(item: AuditFinding, view: PageView): PageSectionInfo | null {
  if (view.sections.length === 0) return null;
  if (typeof item.section_index === 'number') {
    const byIndex = view.sections.find((s) => s.index === item.section_index);
    if (byIndex) return byIndex;
  }
  const rect = findingRect(item, view);
  if (!rect) return null;
  const cy = rect.y + rect.height / 2;
  return view.sections.find((s) => cy >= s.yStart && cy < s.yEnd) ?? null;
}

/** "y 4,210 to 4,380 px, Pricing" style position text for reports and exports. Empty for page-wide findings. */
export function describePosition(item: AuditFinding, view: PageView): string {
  const rect = findingRect(item, view);
  if (!rect) return '';
  const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
  const where = `y ${fmt(rect.y)} to ${fmt(rect.y + rect.height)} px`;
  const section = findingSection(item, view);
  const aboveFold = view.mode === 'fullpage' && rect.y < view.foldPx ? ', first screen' : '';
  return section?.label ? `${where}, ${section.label}${aboveFold}` : `${where}${aboveFold}`;
}

/** Fold as a percent of image height (for CSS top). */
export function foldPercent(view: PageView): number {
  return foldFraction(view.foldPx, view.size.height) * 100;
}

export interface HeatSpot {
  rank: number;
  label: string;
  /** Centre and radius in image px. */
  cx: number;
  cy: number;
  r: number;
  intensity: number;
}

/**
 * AI-estimated attention hotspots in image px, limited to the first screen.
 * Never fabricates eye-tracking blobs from finding boxes when the model returned no hotspots.
 * Radius is relative to image width (so blobs stay round on tall pages) and kept between 8 and 18 percent of width.
 */
export function heatSpots(
  hotspots: AttentionHotspot[] | undefined,
  _items: AuditFinding[],
  view: PageView
): HeatSpot[] {
  const { width, height } = view.size;
  const clampR = (r: number) => Math.max(width * 0.08, Math.min(width * 0.18, r));
  if (!hotspots || hotspots.length === 0) return [];
  return hotspots
    .map((h) => ({
      rank: h.rank,
      label: h.label,
      cx: (h.x / 1000) * width,
      cy: (h.y / 1000) * height,
      r: clampR(hotspotRadiusPx(h.radius, width) * 1.075),
      intensity: h.intensity,
    }))
    .filter((s) => s.cy <= view.foldPx);
}

/** The first screen of the image in px (the whole image for a viewport shot). Used to crop hero tools. */
export function firstScreenRect(view: PageView): PixelRect {
  return { x: 0, y: 0, width: view.size.width, height: view.foldPx };
}

/**
 * Hero crop rect matched to Nano Banana 2.1's output aspect ratio:
 * desktop uses firstScreenRect (16:10 / 16:9), mobile crops to top 9:16 so Before/After wipe aligns 1:1.
 */
export function heroRedesignRect(view: PageView, viewport: ViewportKey): PixelRect {
  if (viewport === 'mobile') {
    const targetH = Math.min(view.foldPx, Math.round((view.size.width * 16) / 9));
    return { x: 0, y: 0, width: view.size.width, height: Math.max(1, targetH) };
  }
  return firstScreenRect(view);
}

/** Is the page tall enough that navigation aids (minimap, fit height) help? */
export function isTall(view: PageView): boolean {
  return view.size.height > view.foldPx * 1.5;
}
