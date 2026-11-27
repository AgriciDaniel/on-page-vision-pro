import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describePosition,
  findingBoxStyle,
  findingRect,
  findingSection,
  firstScreenRect,
  foldPercent,
  heatSpots,
  heroRedesignRect,
  isTall,
  pageViewOf,
} from '../../lib/client/pageView';
import { planIngest, viewportDataFrom, withCaptureMode } from '../../lib/client/images';
import { planPngTiles, pngLegendLines } from '../../utils/exportUtils';
import type { AuditFinding, ViewportAudit, ViewportData } from '../../types';

function item(id: string, extra: Partial<AuditFinding> = {}): AuditFinding {
  return {
    id,
    viewport: 'desktop',
    current_text: '',
    visual_description: '',
    context: `Finding ${id}`,
    seo_analysis: '',
    suggested_optimization: '',
    severity: 'warning',
    category: 'Clarity',
    impact_score: 50,
    effort_estimate: 'medium',
    element_type: 'text',
    ...extra,
  };
}

function audit(extra: Partial<ViewportAudit> = {}): ViewportAudit {
  return {
    scores: { overall: 70, clarity: 70, visual_hierarchy: 70, conversion: 70, trust_eeat: 70 },
    overall_summary: '',
    items: [],
    attention_hotspots: [],
    critical_count: 0,
    warning_count: 0,
    info_count: 0,
    ...extra,
  } as ViewportAudit;
}

const SECTIONS = [
  { index: 0, yStart: 0, yEnd: 1800, label: 'Hero' },
  { index: 1, yStart: 1530, yEnd: 3330, label: 'Features' },
  { index: 2, yStart: 3060, yEnd: 12000, label: 'Pricing' },
];

function tallDesktop(analysis: ViewportAudit | null = null): ViewportData {
  return {
    screenshotDataUrl: 'data:image/jpeg;base64,x',
    width: 1440,
    height: 900,
    analysis,
    overlays: [],
    naturalWidth: 1440,
    naturalHeight: 12000,
    captureMode: 'fullpage',
    foldPx: 900,
  };
}

test('an old session with no size, mode or fold reads as a desktop viewport with no fold line', () => {
  const view = pageViewOf({ screenshotDataUrl: 'x', width: 1440, height: 900, analysis: null, overlays: [] }, 'desktop');
  assert.deepEqual(view.size, { width: 1440, height: 900 });
  assert.equal(view.mode, 'viewport');
  assert.equal(view.foldPx, 900);
  assert.equal(view.showFold, false);
  assert.equal(isTall(view), false);
});

test('a full page shows its fold at foldPx over natural height', () => {
  const view = pageViewOf(tallDesktop(), 'desktop');
  assert.equal(view.showFold, true);
  assert.equal(foldPercent(view), 7.5);
  assert.equal(isTall(view), true);
  assert.deepEqual(firstScreenRect(view), { x: 0, y: 0, width: 1440, height: 900 });
});

test('box_px wins over box_2d and keeps a 40 px button exact on a 12,000 px page', () => {
  const view = pageViewOf(tallDesktop(), 'desktop');
  const it = item('a', { box_px: [6000, 100, 6040, 300], box_2d: [0, 0, 10, 10] });
  assert.deepEqual(findingRect(it, view), { x: 100, y: 6000, width: 200, height: 40 });
  const style = findingBoxStyle(it, view)!;
  assert.equal(style.top, '50%');
  assert.equal(parseFloat(style.height).toFixed(4), ((40 / 12000) * 100).toFixed(4));
});

test('box_2d with decimals maps to the full image when box_px is missing', () => {
  const view = pageViewOf(tallDesktop(), 'desktop');
  const rect = findingRect(item('b', { box_2d: [500, 0, 503.3333, 500] }), view)!;
  assert.equal(Math.round(rect.y), 6000);
  assert.equal(Math.round(rect.height), 40);
});

test('page-wide and too-small findings have no box', () => {
  const view = pageViewOf(tallDesktop(), 'desktop');
  assert.equal(findingRect(item('c', { element_type: 'abstract', box_2d: [0, 0, 100, 100] }), view), null);
  assert.equal(findingRect(item('d', { box_px: [10, 10, 11, 400] }), view), null);
  assert.equal(findingRect(item('e'), view), null);
});

test('section comes from section_index, else from the box centre', () => {
  const view = pageViewOf(tallDesktop(audit({ mode: 'fullpage', sections: SECTIONS })), 'desktop');
  assert.equal(findingSection(item('f', { section_index: 1, box_px: [100, 0, 140, 10] }), view)?.label, 'Features');
  assert.equal(findingSection(item('g', { box_px: [5000, 0, 5040, 10] }), view)?.label, 'Pricing');
});

test('describePosition gives px, section and first-screen flag', () => {
  const view = pageViewOf(tallDesktop(audit({ mode: 'fullpage', sections: SECTIONS })), 'desktop');
  assert.equal(describePosition(item('h', { box_px: [4210, 0, 4380, 10] }), view), 'y 4,210 to 4,380 px, Pricing');
  assert.equal(describePosition(item('i', { box_px: [200, 0, 260, 10] }), view), 'y 200 to 260 px, Hero, first screen');
  assert.equal(describePosition(item('j', { element_type: 'abstract' }), view), '');
});

test('heatmap spots are round (radius from width) and limited to the first screen', () => {
  const view = pageViewOf(tallDesktop(), 'desktop');
  const spots = heatSpots(
    [
      { x: 500, y: 30, radius: 100, intensity: 90, rank: 1, label: 'Hero' },
      { x: 500, y: 600, radius: 100, intensity: 70, rank: 2, label: 'Footer' },
    ],
    [],
    view
  );
  assert.equal(spots.length, 1);
  assert.equal(spots[0].cx, 720);
  assert.equal(spots[0].cy, 360);
  // 100 of 1000 of the WIDTH, times 1.075, clamped to 8..18 percent of width.
  assert.ok(Math.abs(spots[0].r - 154.8) < 0.01);
});

test('heatmap never fabricates eye-tracking blobs from finding boxes when hotspots are absent', () => {
  const view = pageViewOf(tallDesktop(), 'desktop');
  const spots = heatSpots(undefined, [item('k', { box_px: [5000, 0, 5100, 100] }), item('l', { box_px: [100, 0, 300, 400] })], view);
  assert.deepEqual(spots, []);
});

test('heroRedesignRect crops mobile to top 9:16 to match Nano Banana 2.1 output aspect ratio', () => {
  const mobileView = pageViewOf(
    {
      screenshotDataUrl: 'x',
      width: 390,
      height: 844,
      analysis: null,
      overlays: [],
      naturalWidth: 780,
      naturalHeight: 1688,
      captureMode: 'viewport',
      foldPx: 1688,
    },
    'mobile'
  );
  assert.deepEqual(heroRedesignRect(mobileView, 'mobile'), { x: 0, y: 0, width: 780, height: 1387 });
  const desktopView = pageViewOf(tallDesktop(), 'desktop');
  assert.deepEqual(heroRedesignRect(desktopView, 'desktop'), { x: 0, y: 0, width: 1440, height: 900 });
});

test('captures are never refused for height; a 780 x 48,000 mobile page is kept as it came', () => {
  const facts = { width: 780, height: 48000, dataUrlChars: 3_000_000, mimeType: 'image/jpeg' };
  assert.equal(planIngest(facts, 'mobile').error !== undefined, true);
  assert.deepEqual(planIngest(facts, 'mobile', 'capture'), { targetWidth: 780, targetHeight: 48000, reencode: false });
});

test('a capture brings its own mode and fold, scaled if the client scaled the image', () => {
  const img = { dataUrl: 'x', naturalWidth: 1440, naturalHeight: 5000, originalWidth: 2880, originalHeight: 10000, reencoded: true };
  const vp = viewportDataFrom(img, 'desktop', 'viewport', {
    width: 2880,
    height: 10000,
    provider: 'playwright',
    captureMode: 'fullpage',
    foldPx: 1800,
    truncated: false,
  });
  assert.equal(vp.captureMode, 'fullpage');
  assert.equal(vp.foldPx, 900);
});

test('the user can switch an upload between full page and first impression', () => {
  const img = { dataUrl: 'x', naturalWidth: 780, naturalHeight: 1688, originalWidth: 780, originalHeight: 1688, reencoded: false };
  const vp = viewportDataFrom(img, 'mobile');
  assert.equal(vp.captureMode, 'viewport');
  const full = withCaptureMode(vp, 'mobile', 'fullpage');
  assert.equal(full.captureMode, 'fullpage');
  assert.equal(full.foldPx, 1688);
});

test('PNG tiles stay under the safe height and cover every row once', () => {
  assert.deepEqual(planPngTiles(900), [{ y0: 0, y1: 900 }]);
  assert.deepEqual(planPngTiles(16000), [{ y0: 0, y1: 16000 }]);
  const tiles = planPngTiles(48000);
  assert.equal(tiles.length, 3);
  assert.ok(tiles.every((t) => t.y1 - t.y0 <= 16000));
  assert.equal(tiles[0].y0, 0);
  assert.equal(tiles[tiles.length - 1].y1, 48000);
  for (let i = 1; i < tiles.length; i++) assert.equal(tiles[i].y0, tiles[i - 1].y1);
  assert.deepEqual(planPngTiles(0), []);
});

test('the PNG legend lists boxed findings with position and section', () => {
  const view = pageViewOf(tallDesktop(audit({ mode: 'fullpage', sections: SECTIONS })), 'desktop');
  const lines = pngLegendLines(
    [item('m', { box_px: [4210, 0, 4380, 10], severity: 'critical' }), item('n', { element_type: 'abstract' })],
    view
  );
  assert.deepEqual(lines, ['#1  [critical]  y 4,210 to 4,380 px, Pricing  Finding m']);
});
