// Image bytes in, trusted facts out: the real format and pixel size read from the file header,
// never from a declared MIME type or file name. Used for request validation (data URLs sent by
// the browser) and for screenshots fetched from capture providers.
import { HttpError } from './http.ts';

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ImageInfo {
  mimeType: ImageMime;
  width: number;
  height: number;
}

/** Reads format and dimensions from PNG, JPEG or WebP header bytes. Returns null for anything else. */
export function sniffImage(buf: Buffer): ImageInfo | null {
  if (!buf || buf.length < 24) return null;

  // PNG: 8-byte signature, then IHDR with width and height as big-endian uint32.
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a && buf.toString('ascii', 12, 16) === 'IHDR') {
    return valid('image/png', buf.readUInt32BE(16), buf.readUInt32BE(20));
  }

  // JPEG: walk the marker segments until a start-of-frame marker.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buf[offset + 1];
      if (marker === 0xff) {
        offset++;
        continue;
      }
      // Standalone markers without a length field
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return null; // end of image or scan data before any frame
      const length = buf.readUInt16BE(offset + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return valid('image/jpeg', buf.readUInt16BE(offset + 7), buf.readUInt16BE(offset + 5));
      }
      offset += 2 + length;
    }
    return null;
  }

  // WebP: RIFF....WEBP, then a VP8 / VP8L / VP8X chunk.
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' && buf.length >= 30) {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      return valid('image/webp', 1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3));
    }
    if (chunk === 'VP8L' && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      return valid('image/webp', (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
    if (chunk === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      return valid('image/webp', buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
    }
    return null;
  }

  return null;
}

function valid(mimeType: ImageMime, width: number, height: number): ImageInfo | null {
  return width > 0 && height > 0 ? { mimeType, width, height } : null;
}

export interface ParsedImage extends ImageInfo {
  /** Base64 payload without the data URL prefix, ready for Gemini inlineData. */
  data: string;
  bytes: number;
}

/**
 * Pixel limits for every image a route accepts, checked from the header before anything decodes it.
 * Captures are 1440 px wide (desktop) and 780 px wide (mobile at 2x), and at most 30,000 px tall.
 * - maxHeightPx: the capture height cap (pageCapture.ts re-exports it as MAX_CAPTURE_IMAGE_HEIGHT_PX).
 * - maxWidthPx: a desktop screenshot at 2x (2 x 1440), the widest upload worth auditing.
 * - maxPixels: the largest capture, 1440 x 30,000 = 43.2 MP; about 173 MB as RGBA when decoded.
 */
export const IMAGE_LIMITS = {
  maxWidthPx: 2 * 1440,
  maxHeightPx: 30_000,
  maxPixels: 1440 * 30_000,
} as const;

/** Default cap per image: about 24 MB decoded (about 32 MB as base64). */
export const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

/**
 * Validates a browser data URL and returns the real format and size.
 * Throws HttpError(400) for anything that is not a PNG, JPEG or WebP data URL,
 * and HttpError(413) when the decoded image is over maxBytes.
 */
export function parseImageDataUrl(value: unknown, field: string, maxBytes = MAX_IMAGE_BYTES): ParsedImage {
  if (typeof value !== 'string' || !value) throw new HttpError(400, `${field} is required.`);
  const match = /^data:([a-z0-9.+/-]+)(?:;[a-z0-9=.+-]+)*;base64,/i.exec(value.slice(0, 200));
  if (!match) throw new HttpError(400, `${field} must be a base64 image data URL.`);
  const data = value.slice(match[0].length).replace(/\s+/g, '');
  const approxBytes = Math.floor((data.length * 3) / 4);
  if (approxBytes > maxBytes) {
    throw new HttpError(413, `${field} is ${(approxBytes / 1048576).toFixed(1)} MB; the limit is ${Math.round(maxBytes / 1048576)} MB.`);
  }
  const buf = Buffer.from(data, 'base64');
  const info = sniffImage(buf);
  if (!info) throw new HttpError(400, `${field} must be a PNG, JPEG or WebP image.`);
  assertImageSize(info, field);
  return { ...info, data, bytes: buf.length };
}

/**
 * Refuses an image whose header declares more than IMAGE_LIMITS allows, before any decoder
 * allocates memory for it (a 1 kB PNG can declare 50,000 x 30,000 px).
 */
export function assertImageSize(info: { width: number; height: number }, field: string): void {
  const n = (v: number) => v.toLocaleString('en-US');
  if (info.width > IMAGE_LIMITS.maxWidthPx) {
    throw new HttpError(400, `${field} is ${n(info.width)} px wide; the limit is ${n(IMAGE_LIMITS.maxWidthPx)} px.`);
  }
  if (info.height > IMAGE_LIMITS.maxHeightPx) {
    throw new HttpError(400, `${field} is ${n(info.height)} px tall; the limit is ${n(IMAGE_LIMITS.maxHeightPx)} px.`);
  }
  if (info.width * info.height > IMAGE_LIMITS.maxPixels) {
    throw new HttpError(
      400,
      `${field} is ${n(info.width)} x ${n(info.height)} px (${(info.width * info.height / 1e6).toFixed(1)} megapixels); the limit is ${(IMAGE_LIMITS.maxPixels / 1e6).toFixed(1)} megapixels.`
    );
  }
}

/** Same as parseImageDataUrl but returns undefined when the field is absent. */
export function parseOptionalImageDataUrl(value: unknown, field: string, maxBytes = MAX_IMAGE_BYTES): ParsedImage | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return parseImageDataUrl(value, field, maxBytes);
}

export function toDataUrl(mimeType: string, buf: Buffer): string {
  return `data:${mimeType};base64,${buf.toString('base64')}`;
}
