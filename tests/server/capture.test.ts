import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureShot, coerceMetadata, parseSeoMetadata } from '../../server/capture.ts';
import { CaptureError } from '../../server/pageCapture.ts';

const fakeShot = (height: number, truncated = false, pageCssHeight = height) => async () => ({
  image: Buffer.from('jpeg'),
  mimeType: 'image/jpeg' as const,
  width: 1440,
  height,
  foldPx: 900,
  truncated,
  captureMode: 'fullpage' as const,
  pageCssHeight,
  finalUrl: 'https://example.com/',
  elapsedMs: 1,
  hiddenOverlays: 0,
  blockedRequests: 0,
});

test('captureShot returns Playwright info and warns when the page was cut', async () => {
  const warnings: string[] = [];
  const shot = await captureShot('https://example.com', 'desktop', 'fullpage', warnings, {
    browser: fakeShot(24_000, true, 31_000),
    fallback: async () => assert.fail('fallback must not run'),
  });
  assert.deepEqual(shot!.info, { width: 1440, height: 24_000, provider: 'playwright', captureMode: 'fullpage', foldPx: 900, truncated: true });
  assert.equal(warnings[0], 'Desktop page is 31,000 CSS px tall; the image stops at 24,000 CSS px (24,000 image px).');
});

test('captureShot falls back to a provider viewport shot and says why', async () => {
  const warnings: string[] = [];
  const shot = await captureShot('https://example.com', 'mobile', 'fullpage', warnings, {
    browser: async () => {
      throw new CaptureError('unavailable', 'The capture browser could not start (no chromium).');
    },
    fallback: async () => ({ dataUrl: 'data:image/webp;base64,AA', width: 780, height: 1688, provider: 'microlink' }),
  });
  assert.deepEqual(shot!.info, { width: 780, height: 1688, provider: 'microlink', captureMode: 'viewport', foldPx: 1688, truncated: false });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^Mobile full-page capture failed \(The capture browser could not start \(no chromium\)\); used a microlink viewport screenshot instead\.$/);
});

test('captureShot reports both failures when nothing works', async () => {
  const warnings: string[] = [];
  const shot = await captureShot('https://example.com', 'desktop', 'viewport', warnings, {
    browser: async () => {
      throw new CaptureError('timeout', 'The page took too long to capture.');
    },
    fallback: async () => null,
  });
  assert.equal(shot, null);
  assert.deepEqual(warnings, ['Desktop capture failed: The page took too long to capture.']);
});

test('coerceMetadata turns hostile client metadata into a safe shape', () => {
  assert.equal(coerceMetadata('x'), undefined);
  assert.equal(coerceMetadata([1]), undefined);
  const m = coerceMetadata({ h1s: 'not an array', title: 5, wordCount: 'many', ctaTexts: ['Buy', 7, 'x'.repeat(500)] })!;
  assert.deepEqual(m.h1s, []);
  assert.equal(m.title, '');
  assert.equal(m.wordCount, 0);
  assert.deepEqual(m.ctaTexts, ['Buy', 'x'.repeat(60)]);
});

test('parseSeoMetadata still extracts title, headings, alt gaps and schema types (moved code)', () => {
  const html = `<html><head><title>Hello &amp; welcome</title>
    <meta name="description" content="Desc">
    <link rel="canonical" href="https://example.com/">
    <script type="application/ld+json">{"@graph":[{"@type":"Organization"},{"@type":["WebSite","Thing"]}]}</script>
    </head><body><h1>Main</h1><h2>Sub</h2><img src="a.png"><img src="b.png" alt="">
    <a href="#">Start free trial</a></body></html>`;
  const m = parseSeoMetadata(html, 'https://example.com/');
  assert.equal(m.title, 'Hello & welcome');
  assert.equal(m.description, 'Desc');
  assert.equal(m.canonical, 'https://example.com/');
  assert.deepEqual(m.h1s, ['Main']);
  assert.deepEqual(m.schemaTypes, ['Organization', 'WebSite', 'Thing']);
  assert.equal(m.totalImages, 2);
  assert.equal(m.missingAltImages, 1);
  assert.deepEqual(m.ctaTexts, ['Start free trial']);
});
