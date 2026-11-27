/**
 * Pure coordinate and dimension math shared by server and browser for
 * viewport and tall full-page screenshots. Zero external dependencies.
 */

/** Gemini normalized bounding box: [ymin, xmin, ymax, xmax] on a 0..1000 scale. */
export type Box2d = readonly [number, number, number, number];

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PercentRectStyle {
  readonly top: string;
  readonly left: string;
  readonly width: string;
  readonly height: string;
}

const NORM_MAX = 1000;

function isPositiveFinite(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Clamp a Gemini box_2d to [0, 1000] and ensure ymin <= ymax and xmin <= xmax.
 */
export function normalizeBox2d(box: Box2d): [number, number, number, number] {
  const y0 = clamp(box[0], 0, NORM_MAX);
  const x0 = clamp(box[1], 0, NORM_MAX);
  const y1 = clamp(box[2], 0, NORM_MAX);
  const x1 = clamp(box[3], 0, NORM_MAX);
  return [
    Math.min(y0, y1),
    Math.min(x0, x1),
    Math.max(y0, y1),
    Math.max(x0, x1),
  ];
}

/**
 * Convert a Gemini box_2d ([ymin, xmin, ymax, xmax] on 0..1000) to a pixel rect
 * for the given natural image size. Preserves sub-pixel precision so small
 * elements on tall pages do not collapse.
 */
export function box2dToPixelRect(box: Box2d, size: ImageSize): PixelRect {
  if (!isPositiveFinite(size.width) || !isPositiveFinite(size.height)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const [ymin, xmin, ymax, xmax] = normalizeBox2d(box);
  const x = (xmin / NORM_MAX) * size.width;
  const y = (ymin / NORM_MAX) * size.height;
  const width = ((xmax - xmin) / NORM_MAX) * size.width;
  const height = ((ymax - ymin) / NORM_MAX) * size.height;
  return { x, y, width, height };
}

/**
 * Convert a pixel rect back to a Gemini box_2d ([ymin, xmin, ymax, xmax] on 0..1000)
 * without integer rounding, preserving exact dimensions on tall pages.
 */
export function pixelRectToBox2d(
  rect: PixelRect,
  size: ImageSize
): [number, number, number, number] {
  if (!isPositiveFinite(size.width) || !isPositiveFinite(size.height)) {
    return [0, 0, 0, 0];
  }
  const x0 = clamp(rect.x, 0, size.width);
  const y0 = clamp(rect.y, 0, size.height);
  const w = Number.isFinite(rect.width) && rect.width > 0 ? rect.width : 0;
  const h = Number.isFinite(rect.height) && rect.height > 0 ? rect.height : 0;
  const x1 = clamp(x0 + w, 0, size.width);
  const y1 = clamp(y0 + h, 0, size.height);

  return [
    (y0 / size.height) * NORM_MAX,
    (x0 / size.width) * NORM_MAX,
    (y1 / size.height) * NORM_MAX,
    (x1 / size.width) * NORM_MAX,
  ];
}

/**
 * Convert a Gemini box_2d directly to CSS percentage overlay styles.
 */
export function box2dToPercentStyle(box: Box2d): PercentRectStyle {
  const [ymin, xmin, ymax, xmax] = normalizeBox2d(box);
  return {
    top: `${ymin / 10}%`,
    left: `${xmin / 10}%`,
    width: `${(xmax - xmin) / 10}%`,
    height: `${(ymax - ymin) / 10}%`,
  };
}

/**
 * Convert a pixel rect to CSS percentage overlay styles for a given image size.
 */
export function pixelRectToPercentStyle(
  rect: PixelRect,
  size: ImageSize
): PercentRectStyle {
  return box2dToPercentStyle(pixelRectToBox2d(rect, size));
}

/**
 * Convert a vertical pixel offset to a percentage (0..100) of natural image height.
 */
export function pagePxToPercent(px: number, naturalHeight: number): number {
  if (!isPositiveFinite(naturalHeight) || !Number.isFinite(px)) return 0;
  return clamp((px / naturalHeight) * 100, 0, 100);
}

/**
 * Convert a percentage (0..100) of natural image height to page pixels.
 */
export function percentToPagePx(percent: number, naturalHeight: number): number {
  if (!isPositiveFinite(naturalHeight) || !Number.isFinite(percent)) return 0;
  return (clamp(percent, 0, 100) / 100) * naturalHeight;
}

/**
 * Compute the fold position as a fraction in [0, 1] given foldPx and naturalHeight.
 */
export function foldFraction(foldPx: number, naturalHeight: number): number {
  if (!isPositiveFinite(naturalHeight) || !isPositiveFinite(foldPx)) return 0;
  return clamp(foldPx / naturalHeight, 0, 1);
}

/**
 * Convert a 0..1000 hotspot radius to pixels using image width only, so gaze
 * blobs stay circular on tall full-page images instead of stretching vertically.
 */
export function hotspotRadiusPx(radiusNorm: number, imageWidth: number): number {
  if (!isPositiveFinite(imageWidth) || !isPositiveFinite(radiusNorm)) return 0;
  return (clamp(radiusNorm, 0, NORM_MAX) / NORM_MAX) * imageWidth;
}
