// Offline tests for the Playwright capture: no external network. A real Chromium is launched;
// pages are built with setContent, and a loopback server counts any request that leaks through.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import sharp from 'sharp';
import { CaptureError, MAX_CAPTURE_IMAGE_HEIGHT_PX, capturePage, closeBrowser, egressRefusals, maxPageCssHeight, openGuardedContext, screenshotInBands } from '../../server/pageCapture.ts';

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await closeBrowser();
});

test('the height cap is 30,000 image px for every viewport (client limit)', () => {
  assert.equal(MAX_CAPTURE_IMAGE_HEIGHT_PX, 30_000);
  assert.equal(maxPageCssHeight('desktop'), 24_000); // scale 1: 24,000 image px
  assert.equal(maxPageCssHeight('mobile'), 15_000); // scale 2: 30,000 image px
});

test('capturePage refuses private and loopback targets before opening a page', async () => {
  for (const url of ['http://127.0.0.1:9/', 'http://localhost/', 'http://169.254.169.254/', 'http://[::1]/']) {
    await assert.rejects(capturePage(url, 'desktop', 'viewport'), (e: any) => e instanceof CaptureError && e.reason === 'blocked', url);
  }
});

test('the guarded browser sends no request of any kind to a loopback server', async () => {
  let hits = 0;
  const leaked: string[] = [];
  const server = http.createServer((req, res) => {
    hits++;
    leaked.push(`${req.method} ${req.url} upgrade=${req.headers.upgrade ?? ''}`);
    res.writeHead(302, { location: 'http://127.0.0.1/' });
    res.end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  // Same shared, proxied browser and context guard that capturePage uses.
  const { context: ctx, budget } = await openGuardedContext({}, 'test-agent', Date.now() + 20_000);
  try {
    const page = await ctx.newPage();
    await page.setContent(`<!doctype html><html><head>
      <link rel="stylesheet" href="${base}/a.css">
      <script src="${base}/a.js"></script>
      </head><body>
      <img src="${base}/a.png"><img src="http://localhost:${port}/b.png">
      <iframe src="${base}/frame"></iframe>
      <video src="${base}/v.mp4" autoplay muted></video>
      <link rel="prefetch" href="${base}/prefetch">
      <link rel="preload" as="image" href="${base}/preload.png">
      <link rel="modulepreload" href="${base}/module.js">
      <script type="speculationrules">{"prerender":[{"source":"list","urls":["${base}/prerender"]}],"prefetch":[{"source":"list","urls":["${base}/specprefetch"]}]}</script>
      <a id="pinger" href="${base}/link" ping="${base}/ping" target="sink">x</a>
      <form id="f" method="post" action="${base}/form" target="sink"><input name="a" value="b"></form>
      <iframe name="sink"></iframe>
      <object data="${base}/object"></object><embed src="${base}/embed">
      <audio src="${base}/a.mp3" autoplay></audio>
      </body></html>`);
    await page.evaluate(`document.getElementById('f').submit(); document.getElementById('pinger').click();`).catch(() => {});
    // A string, not a function: tsx would inject helpers (__name) that do not exist in the page.
    const probes = (await page.evaluate(`(async (b) => {
      const out = {};
      const attempt = async (name, fn) => {
        try { await fn(); out[name] = 'ok'; } catch (e) { out[name] = String((e && e.name) || e); }
      };
      await attempt('fetch', () => fetch(b + '/api'));
      await attempt('post', () => fetch(b + '/api', { method: 'POST', body: 'x' }));
      await attempt('beacon', () => navigator.sendBeacon(b + '/beacon', 'x'));
      await attempt('worker', () => new Worker('data:text/javascript,1'));
      await attempt('rtc', () => new RTCPeerConnection());
      await attempt('websocket', () => new Promise((resolve) => {
        const ws = new WebSocket('ws://127.0.0.1:' + new URL(b).port + '/ws');
        ws.onopen = resolve; ws.onerror = resolve; setTimeout(resolve, 500);
      }));
      return out;
    })(${JSON.stringify(base)})`)) as Record<string, string>;
    await page.waitForTimeout(1500);

    assert.equal(hits, 0, `loopback server must never be reached: ${leaked.join('; ')}`);
    assert.equal(probes.worker, 'NotSupportedError');
    assert.equal(probes.rtc, 'NotSupportedError');
    assert.notEqual(probes.fetch, 'ok');
    assert.ok(budget.blocked >= 6, `blocked ${budget.blocked}`);
    assert.ok(egressRefusals() >= 1, `egress proxy refusals ${egressRefusals()}`);
  } finally {
    await ctx.close();
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  }
});

/** A page of horizontal stripes 700 CSS px tall; stripe i is grey value (i * 37 + 20) % 236. */
const stripeGrey = (i: number) => (i * 37 + 20) % 236;
function stripePage(cssHeight: number, stripe = 700): string {
  const rows: string[] = [];
  for (let y = 0, i = 0; y < cssHeight; y += stripe, i++) {
    const g = stripeGrey(i);
    rows.push(`<div style="height:${Math.min(stripe, cssHeight - y)}px;background:rgb(${g},${g},${g})"></div>`);
  }
  return `<!doctype html><html><body style="margin:0">${rows.join('')}</body></html>`;
}

async function checkStripes(image: Buffer, scale: number, cssHeight: number, stripe = 700) {
  const { data, info } = await sharp(image).greyscale().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.height, cssHeight * scale);
  const sample = (yDevice: number) => data[yDevice * info.width + Math.floor(info.width / 2)];
  let checked = 0;
  for (let y = 0, i = 0; y < cssHeight; y += stripe, i++) {
    const h = Math.min(stripe, cssHeight - y);
    // Inside each stripe, away from its own edges (JPEG ringing), every 25 CSS px.
    for (let yy = y + 6; yy < y + h - 6; yy += 25) {
      const got = sample(Math.floor(yy * scale));
      assert.ok(Math.abs(got - stripeGrey(i)) <= 6, `css y ${yy}: expected ${stripeGrey(i)}, got ${got}`);
      checked++;
    }
  }
  return checked;
}

test('desktop bands stitch into one exact image (20,000 CSS px, 3 bands, scale 1)', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  try {
    const page = await ctx.newPage();
    await page.setContent(stripePage(20_000));
    const out = await screenshotInBands(page, { cssWidth: 1440, cssHeight: 20_000, scale: 1, deadline: Date.now() + 60_000 });
    assert.equal(out.bands, 3);
    assert.equal(out.width, 1440);
    const checked = await checkStripes(out.image, 1, 20_000);
    assert.ok(checked > 700);
  } finally {
    await ctx.close();
  }
});

test('mobile bands stitch at 2x (10,000 CSS px is 20,000 image px, past the 16,384 limit)', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true });
  try {
    const page = await ctx.newPage();
    await page.setContent(stripePage(10_000));
    const out = await screenshotInBands(page, { cssWidth: 390, cssHeight: 10_000, scale: 2, deadline: Date.now() + 60_000 });
    assert.equal(out.width, 780);
    assert.equal(out.height, 20_000);
    assert.equal(out.bands, 3);
    await checkStripes(out.image, 2, 10_000);
  } finally {
    await ctx.close();
  }
});
