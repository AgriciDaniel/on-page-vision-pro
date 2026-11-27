/**
 * Every screenshot enters the app through `ingestImage`: it is decoded once, measured,
 * scaled down to the capture width if larger, re-encoded only when it must be, and turned
 * into a ViewportData that records its real size, capture mode and fold position.
 * `makeThumbnail` makes the small history preview. The planning rules are pure functions
 * so they can be tested without a browser.
 */
import type { CaptureInfo, CaptureMode, ViewportData, ViewportKey } from '../../types';

/** Browser viewport each screenshot represents, in CSS px. Fold and capture mode are this ratio applied to the image's own width. */
export const VIEWPORT_SIZES: Record<ViewportKey, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

/**
 * All image size limits, in one place.
 * - maxWidth: wider images are scaled down to this. Desktop stays at 1x (1440). Mobile keeps 2x
 *   (780, what Microlink returns) because small mobile text is unreadable to the model at 390.
 * - maxDataUrlChars: cap on a stored data URL (about 6 MB of image bytes). The server takes
 *   24 MB per decoded image and 50 MB per request; compare sends two images.
 * - maxHeight: tallest upload accepted after scaling; browsers cannot draw much taller canvases.
 *   Captures from our own server are never refused for height (a 24,000 CSS px mobile page is
 *   48,000 px at 2x); they are only re-encoded when the canvas can hold them (maxCanvasSide).
 */
export const INGEST_LIMITS = {
  maxWidth: { desktop: 1440, mobile: 780 } as Record<ViewportKey, number>,
  maxDataUrlChars: 8 * 1024 * 1024,
  maxHeight: 30000,
  maxCanvasSide: 32767,
};

/** Where an image came from. Captures are produced by our server and trusted; uploads are checked. */
export type ImageSource = 'upload' | 'capture';

const KEEP_AS_IS_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export interface ImageFacts {
  width: number;
  height: number;
  dataUrlChars: number;
  mimeType: string;
}

export interface IngestPlan {
  targetWidth: number;
  targetHeight: number;
  reencode: boolean;
  error?: string;
}

/** Decide the stored size and whether to re-encode. Pure. */
export function planIngest(
  facts: ImageFacts,
  viewport: ViewportKey,
  source: ImageSource = 'upload'
): IngestPlan {
  if (!facts.width || !facts.height) {
    return { targetWidth: 0, targetHeight: 0, reencode: false, error: 'The image has no size and could not be read.' };
  }
  const maxWidth = INGEST_LIMITS.maxWidth[viewport];
  const scale = Math.min(1, maxWidth / facts.width);
  const targetWidth = Math.round(facts.width * scale);
  const targetHeight = Math.round(facts.height * scale);
  if (source === 'capture') {
    // Too tall for a canvas: keep the server's image exactly as it came.
    if (targetHeight > INGEST_LIMITS.maxCanvasSide) {
      return { targetWidth: facts.width, targetHeight: facts.height, reencode: false };
    }
  } else if (targetHeight > INGEST_LIMITS.maxHeight) {
    return {
      targetWidth,
      targetHeight,
      reencode: false,
      error: `This image is too tall: ${targetHeight.toLocaleString('en-US')} px at ${targetWidth} px wide. The limit is ${INGEST_LIMITS.maxHeight.toLocaleString('en-US')} px.`,
    };
  }
  const reencode =
    scale < 1 ||
    facts.dataUrlChars > INGEST_LIMITS.maxDataUrlChars ||
    !KEEP_AS_IS_TYPES.includes(facts.mimeType);
  return { targetWidth, targetHeight, reencode };
}

/**
 * Guess whether a stored image is one viewport or a whole page: it is a full page when it is
 * more than 1.5 screens tall for its width. Pure.
 */
export function inferCaptureMode(width: number, height: number, viewport: ViewportKey): CaptureMode {
  const vp = VIEWPORT_SIZES[viewport];
  const screenHeight = (width * vp.height) / vp.width;
  return height > screenHeight * 1.5 ? 'fullpage' : 'viewport';
}

/** Fold in image pixels: the image bottom for a viewport shot, one screen down for a full page. Pure. */
export function foldPxFor(width: number, height: number, viewport: ViewportKey, mode: CaptureMode): number {
  if (mode === 'viewport') return height;
  const vp = VIEWPORT_SIZES[viewport];
  return Math.min(height, Math.round((width * vp.height) / vp.width));
}

/**
 * Fill the wave 1 fields on a ViewportData saved before they existed. Old sessions were
 * always viewport captures at the standard size. Pure; returns the same object when nothing is missing.
 */
export function withViewportDefaults(
  vp: ViewportData,
  viewport: ViewportKey,
  measured?: { width: number; height: number }
): ViewportData {
  if (vp.naturalWidth && vp.naturalHeight && vp.captureMode && vp.foldPx) return vp;
  // Prefer the decoded size; the viewport size is only a last resort (old mobile captures were 780x1688, not 390x844).
  const size = measured ?? VIEWPORT_SIZES[viewport];
  const naturalWidth = vp.naturalWidth || size.width;
  const naturalHeight = vp.naturalHeight || size.height;
  const captureMode = vp.captureMode || 'viewport';
  return {
    ...vp,
    naturalWidth,
    naturalHeight,
    captureMode,
    foldPx: vp.foldPx || foldPxFor(naturalWidth, naturalHeight, viewport, captureMode),
  };
}

export interface IngestedImage {
  dataUrl: string;
  naturalWidth: number;
  naturalHeight: number;
  /** Size before scaling, for messages such as "scaled from 2880 px". */
  originalWidth: number;
  originalHeight: number;
  reencoded: boolean;
}

/** Build the ViewportData for an ingested image. Pass `mode` when the source says it (a capture); otherwise it is inferred. */
export function viewportDataFrom(
  img: IngestedImage,
  viewport: ViewportKey,
  mode?: CaptureMode,
  capture?: CaptureInfo
): ViewportData {
  const captureMode =
    capture?.captureMode ?? mode ?? inferCaptureMode(img.naturalWidth, img.naturalHeight, viewport);
  const size = VIEWPORT_SIZES[viewport];
  // The server's fold is in the pixels it captured; scale it if the client scaled the image.
  const foldPx =
    capture?.foldPx && capture.width
      ? Math.min(img.naturalHeight, Math.round((capture.foldPx * img.naturalWidth) / capture.width))
      : foldPxFor(img.naturalWidth, img.naturalHeight, viewport, captureMode);
  return {
    screenshotDataUrl: img.dataUrl,
    width: size.width,
    height: size.height,
    analysis: null,
    overlays: [],
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    captureMode,
    foldPx,
    ...(capture ? { capture } : {}),
  };
}

// ---------------------------------------------------------------------------
// Browser-only below: these need DOM image decoding and canvas.

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the image file.'));
    reader.readAsDataURL(file);
  });
}

async function decodeImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
  } catch {
    throw new Error('This file could not be opened as an image.');
  }
  return img;
}

function mimeOf(dataUrl: string): string {
  return dataUrl.slice(5, dataUrl.indexOf(';')) || '';
}

/** Encode a canvas, lowering quality until the data URL fits the cap. WebP first, JPEG where WebP encoding is missing. */
function encodeWithinCap(canvas: HTMLCanvasElement): string | null {
  const qualities = [0.92, 0.85, 0.75, 0.65, 0.55];
  for (const type of ['image/webp', 'image/jpeg']) {
    for (const q of qualities) {
      const out = canvas.toDataURL(type, q);
      if (!out.startsWith(`data:${type}`)) break; // this browser cannot encode this type
      if (out.length <= INGEST_LIMITS.maxDataUrlChars) return out;
    }
  }
  return null;
}

/** Decode a data URL just to read its pixel size. */
export async function measureImage(dataUrl: string): Promise<{ width: number; height: number }> {
  const img = await decodeImage(dataUrl);
  return { width: img.naturalWidth, height: img.naturalHeight };
}

/** Decode, measure, scale and cap one screenshot. Throws an Error with a user-facing message when it cannot be used. */
export async function ingestImage(
  source: File | string,
  viewport: ViewportKey,
  from: ImageSource = 'upload'
): Promise<IngestedImage> {
  if (typeof source !== 'string' && source.type && !source.type.startsWith('image/')) {
    throw new Error('Please choose an image file (PNG, JPEG or WebP).');
  }
  const dataUrl = typeof source === 'string' ? source : await readFileAsDataUrl(source);
  if (!dataUrl.startsWith('data:image/')) {
    throw new Error('Please choose an image file (PNG, JPEG or WebP).');
  }
  const img = await decodeImage(dataUrl);
  const facts: ImageFacts = {
    width: img.naturalWidth,
    height: img.naturalHeight,
    dataUrlChars: dataUrl.length,
    mimeType: mimeOf(dataUrl),
  };
  const plan = planIngest(facts, viewport, from);
  if (plan.error) throw new Error(plan.error);

  if (!plan.reencode) {
    return {
      dataUrl,
      naturalWidth: facts.width,
      naturalHeight: facts.height,
      originalWidth: facts.width,
      originalHeight: facts.height,
      reencoded: false,
    };
  }

  const canvas = document.createElement('canvas');
  canvas.width = plan.targetWidth;
  canvas.height = plan.targetHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser could not process the image.');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, plan.targetWidth, plan.targetHeight);
  const encoded = encodeWithinCap(canvas);
  if (!encoded) {
    throw new Error('This image is too large to store even after compression. Try a shorter page or a smaller file.');
  }
  return {
    dataUrl: encoded,
    naturalWidth: plan.targetWidth,
    naturalHeight: plan.targetHeight,
    originalWidth: facts.width,
    originalHeight: facts.height,
    reencoded: true,
  };
}

/** A small JPEG of the top of a screenshot (default 320x200) for the history list. */
export async function makeThumbnail(dataUrl: string, width = 320, height = 200): Promise<string> {
  const img = await decodeImage(dataUrl);
  const srcW = img.naturalWidth;
  const srcH = Math.min(img.naturalHeight, Math.round((srcW * height) / width));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  const drawH = Math.round((srcH * width) / srcW);
  ctx.drawImage(img, 0, 0, srcW, srcH, 0, 0, width, drawH);
  return canvas.toDataURL('image/jpeg', 0.72);
}

/** Same image, other capture mode (the user corrected the guess). Recomputes the fold. */
export function withCaptureMode(vp: ViewportData, viewport: ViewportKey, mode: CaptureMode): ViewportData {
  const w = vp.naturalWidth || VIEWPORT_SIZES[viewport].width;
  const h = vp.naturalHeight || VIEWPORT_SIZES[viewport].height;
  return { ...vp, captureMode: mode, foldPx: foldPxFor(w, h, viewport, mode) };
}

/** Crop a pixel rect out of an image data URL. Returns PNG unless the crop is large, then JPEG. */
export async function cropImagePx(
  dataUrl: string,
  rect: { x: number; y: number; width: number; height: number }
): Promise<string> {
  const img = await decodeImage(dataUrl);
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const w = Math.max(16, Math.min(img.naturalWidth - x, Math.round(rect.width)));
  const h = Math.max(16, Math.min(img.naturalHeight - y, Math.round(rect.height)));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser could not crop the image.');
  ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
  return w * h > 2_000_000 ? canvas.toDataURL('image/jpeg', 0.9) : canvas.toDataURL('image/png');
}
