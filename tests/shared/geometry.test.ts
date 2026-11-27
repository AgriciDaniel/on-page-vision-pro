import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  box2dToPercentStyle,
  box2dToPixelRect,
  foldFraction,
  hotspotRadiusPx,
  normalizeBox2d,
  pagePxToPercent,
  percentToPagePx,
  pixelRectToBox2d,
  pixelRectToPercentStyle,
} from '../../lib/geometry.ts';

describe('lib/geometry', () => {
  it('converts box_2d to pixel rect and percent styles for desktop viewport (1440x900)', () => {
    const size = { width: 1440, height: 900 };
    const rect = box2dToPixelRect([100, 250, 300, 750], size);
    assert.deepEqual(rect, { x: 360, y: 90, width: 720, height: 180 });

    const style = box2dToPercentStyle([100, 250, 300, 750]);
    assert.deepEqual(style, { top: '10%', left: '25%', width: '50%', height: '20%' });

    const fromPx = pixelRectToPercentStyle(rect, size);
    assert.deepEqual(fromPx, style);
  });

  it('normalizes inverted or out-of-range box_2d values safely', () => {
    assert.deepEqual(normalizeBox2d([900, 1200, -50, 400]), [0, 400, 900, 1000]);
    assert.deepEqual(normalizeBox2d([Number.NaN, 100, 500, Number.POSITIVE_INFINITY]), [0, 0, 500, 100]);
  });

  it('preserves a 40 px button height on a 1440x15000 page across box_2d round-trip', () => {
    const size = { width: 1440, height: 15000 };
    const button = { x: 600, y: 7480, width: 240, height: 40 };
    const box = pixelRectToBox2d(button, size);
    const restored = box2dToPixelRect(box, size);

    assert.ok(Math.abs(restored.x - button.x) < 1e-9);
    assert.ok(Math.abs(restored.y - button.y) < 1e-9);
    assert.ok(Math.abs(restored.width - button.width) < 1e-9);
    assert.ok(Math.abs(restored.height - 40) < 1e-9);
  });

  it('converts page pixels to and from percent of image height', () => {
    assert.equal(pagePxToPercent(900, 15000), 6);
    assert.equal(percentToPagePx(6, 15000), 900);
    assert.equal(pagePxToPercent(20000, 15000), 100);
    assert.equal(pagePxToPercent(-10, 15000), 0);
    assert.equal(percentToPagePx(150, 15000), 15000);
  });

  it('computes fold position fraction across viewport and tall pages', () => {
    assert.equal(foldFraction(900, 900), 1);
    assert.equal(foldFraction(844, 844), 1);
    assert.equal(foldFraction(900, 15000), 0.06);
    assert.equal(foldFraction(1800, 40000), 0.045);
    assert.equal(foldFraction(1200, 900), 1);
  });

  it('computes hotspot radius from image width only so blobs stay round on tall images', () => {
    const desktopViewportRadius = hotspotRadiusPx(120, 1440);
    const desktopTallRadius = hotspotRadiusPx(120, 1440);
    const mobileRadius = hotspotRadiusPx(120, 390);
    const retinaRadius = hotspotRadiusPx(120, 2880);

    assert.ok(Math.abs(desktopViewportRadius - 172.8) < 1e-9);
    assert.equal(desktopViewportRadius, desktopTallRadius);
    assert.ok(Math.abs(mobileRadius - 46.8) < 1e-9);
    assert.ok(Math.abs(retinaRadius - 345.6) < 1e-9);
  });

  it('handles zero, negative, and non-finite sizes without NaN or crashes', () => {
    const badSizes = [
      { width: 0, height: 0 },
      { width: -1440, height: 900 },
      { width: 1440, height: -15000 },
      { width: Number.NaN, height: 900 },
      { width: 1440, height: Number.POSITIVE_INFINITY },
    ];

    for (const size of badSizes) {
      assert.deepEqual(box2dToPixelRect([100, 100, 500, 500], size), {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      });
      assert.deepEqual(pixelRectToBox2d({ x: 10, y: 10, width: 100, height: 40 }, size), [0, 0, 0, 0]);
    }

    assert.equal(pagePxToPercent(100, 0), 0);
    assert.equal(pagePxToPercent(100, -500), 0);
    assert.equal(percentToPagePx(50, 0), 0);
    assert.equal(foldFraction(900, 0), 0);
    assert.equal(foldFraction(-100, 15000), 0);
    assert.equal(hotspotRadiusPx(120, 0), 0);
    assert.equal(hotspotRadiusPx(-50, 1440), 0);
  });
});
