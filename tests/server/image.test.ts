import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImageDataUrl, parseOptionalImageDataUrl, sniffImage } from '../../server/image.ts';
import { HttpError } from '../../server/http.ts';
import { pngBytes } from './fixtures.ts';

function jpegBytes(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc2, 0); // progressive SOF2
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(16)]);
}

function webpVp8x(width: number, height: number): Buffer {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(32, 4);
  b.write('WEBPVP8X', 8, 'ascii');
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

function webpVp8l(width: number, height: number): Buffer {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBPVP8L', 8, 'ascii');
  b[20] = 0x2f;
  b.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21);
  return b;
}

function webpVp8(width: number, height: number): Buffer {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBPVP8 ', 8, 'ascii');
  b[23] = 0x9d;
  b[24] = 0x01;
  b[25] = 0x2a;
  b.writeUInt16LE(width, 26);
  b.writeUInt16LE(height, 28);
  return b;
}

test('sniffImage reads real dimensions from PNG, JPEG and all three WebP chunk types', () => {
  assert.deepEqual(sniffImage(pngBytes(1440, 15000)), { mimeType: 'image/png', width: 1440, height: 15000 });
  assert.deepEqual(sniffImage(jpegBytes(390, 844)), { mimeType: 'image/jpeg', width: 390, height: 844 });
  assert.deepEqual(sniffImage(webpVp8x(2880, 40000)), { mimeType: 'image/webp', width: 2880, height: 40000 });
  assert.deepEqual(sniffImage(webpVp8l(1440, 900)), { mimeType: 'image/webp', width: 1440, height: 900 });
  assert.deepEqual(sniffImage(webpVp8(1440, 900)), { mimeType: 'image/webp', width: 1440, height: 900 });
});

test('sniffImage returns null for GIF, SVG, HTML and truncated data', () => {
  assert.equal(sniffImage(Buffer.from('GIF89a' + '\0'.repeat(40))), null);
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(sniffImage(Buffer.from('<!doctype html><html><body>error</body></html>')), null);
  assert.equal(sniffImage(pngBytes(10, 10).subarray(0, 20)), null);
  assert.equal(sniffImage(pngBytes(0, 10)), null);
});

test('parseImageDataUrl trusts the header bytes over the declared type', () => {
  const declaredJpeg = `data:image/jpeg;base64,${pngBytes(1440, 900).toString('base64')}`;
  const parsed = parseImageDataUrl(declaredJpeg, 'shot');
  assert.equal(parsed.mimeType, 'image/png');
  assert.equal(parsed.width, 1440);
  assert.equal(parsed.height, 900);
});

test('parseImageDataUrl rejects non data URLs locally with 400 and oversize with 413', () => {
  const status = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      assert.ok(e instanceof HttpError);
      return e.status;
    }
    return 0;
  };
  assert.equal(status(() => parseImageDataUrl('http://x', 'shot')), 400);
  assert.equal(status(() => parseImageDataUrl(undefined, 'shot')), 400);
  assert.equal(status(() => parseImageDataUrl(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`, 'shot')), 400);
  assert.equal(status(() => parseImageDataUrl(`data:image/png;base64,${'A'.repeat(4000)}`, 'shot', 1000)), 413);
  assert.equal(parseOptionalImageDataUrl(undefined, 'shot'), undefined);
  assert.equal(parseOptionalImageDataUrl('', 'shot'), undefined);
});
