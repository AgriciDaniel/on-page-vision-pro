// Manual check, not part of `npm test` (it uses the network). The only allowed target is
// https://agricidaniel.com. Run: node --import tsx tests/server/capture-check.manual.ts [outDir]
//
// For each viewport it reports width, height, bytes, time and truncated, then checks by pixels
// that the stitched image neither wraps (a band restarting at the top of the page) nor repeats
// (a band copying the one before), and that each seam is no sharper than the rows around it.
// On desktop, where the page fits in one Chromium image, it also compares the stitched result
// against a single-band capture of a second page load.
import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { capturePage, closeBrowser } from '../../server/pageCapture.ts';

const TARGET = 'https://agricidaniel.com';
const BAND_DEVICE_PX = 8000; // must match MAX_BAND_DEVICE_PX in pageCapture.ts
const outDir = process.argv[2];

async function grey(image: Buffer) {
  const { data, info } = await sharp(image).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

type Grey = Awaited<ReturnType<typeof grey>>;

/** Mean absolute difference between rows [a, a+n) and [b, b+n), 0 to 255. */
function regionDiff(g: Grey, a: number, b: number, n: number): number {
  let sum = 0;
  const len = n * g.width;
  const offA = a * g.width;
  const offB = b * g.width;
  for (let i = 0; i < len; i++) sum += Math.abs(g.data[offA + i] - g.data[offB + i]);
  return sum / len;
}

const rowDiff = (g: Grey, y: number) => regionDiff(g, y, y + 1, 1);

function seamReport(g: Grey, seam: number) {
  const neighbours: number[] = [];
  for (let y = seam - 60; y < seam + 60; y++) if (y !== seam - 1 && y >= 0 && y + 1 < g.height) neighbours.push(rowDiff(g, y));
  neighbours.sort((x, y) => x - y);
  const p95 = neighbours[Math.floor(neighbours.length * 0.95)];
  const atSeam = rowDiff(g, seam - 1);
  const n = Math.min(300, g.height - seam);
  return {
    seam,
    seamRowDiff: +atSeam.toFixed(2),
    neighbourP95: +p95.toFixed(2),
    seamLooksContinuous: atSeam <= Math.max(p95, 1) * 1.5 + 2,
    diffVsPageTop: +regionDiff(g, seam, 0, n).toFixed(2), // near 0 would mean the band wrapped to the top
    diffVsPreviousBand: +regionDiff(g, seam, seam - BAND_DEVICE_PX, n).toFixed(2), // near 0 would mean a repeat
  };
}

const results: Record<string, unknown> = {};
try {
  for (const viewport of ['desktop', 'mobile'] as const) {
    const shot = await capturePage(TARGET, viewport, 'fullpage');
    const { image, ...info } = shot;
    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, `${viewport}-fullpage.jpg`), image);
    }
    const g = await grey(image);
    const seams = [];
    for (let s = BAND_DEVICE_PX; s < g.height; s += BAND_DEVICE_PX) seams.push(seamReport(g, s));
    const entry: Record<string, unknown> = {
      width: info.width,
      height: info.height,
      bytes: image.length,
      elapsedMs: info.elapsedMs,
      truncated: info.truncated,
      pageCssHeight: info.pageCssHeight,
      foldPx: info.foldPx,
      hiddenOverlays: info.hiddenOverlays,
      blockedRequests: info.blockedRequests,
      bands: Math.ceil(info.height / BAND_DEVICE_PX),
      seams,
    };

    if (viewport === 'desktop' && info.height <= 16_000) {
      const single = await capturePage(TARGET, viewport, 'fullpage', { bandDevicePx: 16_000 });
      if (single.height === info.height) {
        const g2 = await grey(single.image);
        let identicalRows = 0;
        let changedRows = 0;
        for (let y = 0; y < g.height; y++) {
          const d = regionDiff({ ...g, data: Buffer.concat([g.data.subarray(y * g.width, (y + 1) * g.width), g2.data.subarray(y * g.width, (y + 1) * g.width)]), height: 2 }, 0, 1, 1);
          if (d < 4) identicalRows++;
          else changedRows++;
        }
        entry.singleBandComparison = {
          singleHeight: single.height,
          rowsMatching: identicalRows,
          rowsDiffering: changedRows,
          matchingPercent: +((identicalRows / g.height) * 100).toFixed(2),
          note: 'second page load; moving content (tickers, carousels) can differ',
        };
      } else {
        entry.singleBandComparison = { skipped: `second load height ${single.height} differs from ${info.height}` };
      }
    }
    results[viewport] = entry;
  }
} finally {
  await closeBrowser();
}
console.log(JSON.stringify(results, null, 2));
