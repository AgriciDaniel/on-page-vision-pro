import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INGEST_LIMITS,
  foldPxFor,
  inferCaptureMode,
  planIngest,
  viewportDataFrom,
  withViewportDefaults,
} from '../../lib/client/images';

const png = (width: number, height: number, dataUrlChars = 1_000_000) => ({
  width,
  height,
  dataUrlChars,
  mimeType: 'image/png',
});

test('a 1440x900 PNG under the cap is kept as is', () => {
  assert.deepEqual(planIngest(png(1440, 900), 'desktop'), {
    targetWidth: 1440,
    targetHeight: 900,
    reencode: false,
  });
});

test('a 2x retina full page is scaled to 1440 wide and re-encoded', () => {
  const plan = planIngest(png(2880, 30000), 'desktop');
  assert.equal(plan.targetWidth, 1440);
  assert.equal(plan.targetHeight, 15000);
  assert.equal(plan.reencode, true);
  assert.equal(plan.error, undefined);
});

test('mobile keeps 2x: a 780x1688 Microlink shot is kept as is, a 3x shot is scaled to 780', () => {
  assert.deepEqual(planIngest(png(780, 1688), 'mobile'), { targetWidth: 780, targetHeight: 1688, reencode: false });
  const plan = planIngest(png(1170, 2532), 'mobile');
  assert.equal(plan.targetWidth, 780);
  assert.equal(plan.targetHeight, 1688);
  assert.equal(plan.reencode, true);
});

test('desktop stays capped at 1440 (a 2x Microlink 2880x1800 shot is halved)', () => {
  const plan = planIngest(png(2880, 1800), 'desktop');
  assert.equal(plan.targetWidth, 1440);
  assert.equal(plan.targetHeight, 900);
});

test('the limits live in INGEST_LIMITS', () => {
  assert.deepEqual(INGEST_LIMITS.maxWidth, { desktop: 1440, mobile: 780 });
});

test('GIF and SVG are always re-encoded (the server rejects them)', () => {
  assert.equal(planIngest({ ...png(780, 1688), mimeType: 'image/gif' }, 'mobile').reencode, true);
  assert.equal(planIngest({ ...png(780, 1688), mimeType: 'image/svg+xml' }, 'mobile').reencode, true);
});

test('an image taller than the limit after scaling is rejected with a message', () => {
  const plan = planIngest(png(1440, INGEST_LIMITS.maxHeight + 1), 'desktop');
  assert.match(plan.error ?? '', /too tall/);
});

test('an oversized or unusual-format image is re-encoded even at the right width', () => {
  assert.equal(planIngest(png(1440, 900, INGEST_LIMITS.maxDataUrlChars + 1), 'desktop').reencode, true);
  assert.equal(planIngest({ ...png(1440, 900), mimeType: 'image/gif' }, 'desktop').reencode, true);
});

test('capture mode is inferred from height relative to one screen', () => {
  assert.equal(inferCaptureMode(1440, 900, 'desktop'), 'viewport');
  assert.equal(inferCaptureMode(1440, 1300, 'desktop'), 'viewport');
  assert.equal(inferCaptureMode(1440, 15000, 'desktop'), 'fullpage');
  assert.equal(inferCaptureMode(390, 844, 'mobile'), 'viewport');
  assert.equal(inferCaptureMode(390, 6000, 'mobile'), 'fullpage');
  assert.equal(inferCaptureMode(780, 1688, 'mobile'), 'viewport');
  assert.equal(inferCaptureMode(780, 2400, 'mobile'), 'viewport');
  assert.equal(inferCaptureMode(780, 12000, 'mobile'), 'fullpage');
});

test('fold is the image bottom for a viewport shot and one screen down for a full page', () => {
  assert.equal(foldPxFor(1440, 900, 'desktop', 'viewport'), 900);
  assert.equal(foldPxFor(1440, 15000, 'desktop', 'fullpage'), 900);
  assert.equal(foldPxFor(720, 7500, 'desktop', 'fullpage'), 450);
  assert.equal(foldPxFor(390, 6000, 'mobile', 'fullpage'), 844);
  assert.equal(foldPxFor(780, 1688, 'mobile', 'viewport'), 1688);
  assert.equal(foldPxFor(780, 12000, 'mobile', 'fullpage'), 1688);
});

test('viewportDataFrom records the real size, mode and fold', () => {
  const vp = viewportDataFrom(
    { dataUrl: 'data:image/webp;base64,X', naturalWidth: 1440, naturalHeight: 15000, originalWidth: 2880, originalHeight: 30000, reencoded: true },
    'desktop'
  );
  assert.equal(vp.width, 1440);
  assert.equal(vp.height, 900);
  assert.equal(vp.naturalHeight, 15000);
  assert.equal(vp.captureMode, 'fullpage');
  assert.equal(vp.foldPx, 900);
});

test('withViewportDefaults leaves complete data alone', () => {
  const vp = {
    screenshotDataUrl: 'x',
    width: 1440,
    height: 900,
    analysis: null,
    overlays: [],
    naturalWidth: 1440,
    naturalHeight: 4000,
    captureMode: 'fullpage' as const,
    foldPx: 900,
  };
  assert.equal(withViewportDefaults(vp, 'desktop'), vp);
});

test('withViewportDefaults uses the measured size of an old 2x mobile capture', () => {
  const old = { screenshotDataUrl: 'x', width: 390, height: 844, analysis: null, overlays: [] };
  const vp = withViewportDefaults(old, 'mobile', { width: 780, height: 1688 });
  assert.equal(vp.naturalWidth, 780);
  assert.equal(vp.naturalHeight, 1688);
  assert.equal(vp.captureMode, 'viewport');
  assert.equal(vp.foldPx, 1688);
});

test('viewportDataFrom keeps the capture provider and original size', () => {
  const vp = viewportDataFrom(
    { dataUrl: 'd', naturalWidth: 780, naturalHeight: 1688, originalWidth: 780, originalHeight: 1688, reencoded: false },
    'mobile',
    'viewport',
    { width: 780, height: 1688, provider: 'microlink' }
  );
  assert.deepEqual(vp.capture, { width: 780, height: 1688, provider: 'microlink' });
  assert.equal(vp.foldPx, 1688);
});
