// Full-page and viewport screenshots with Playwright Chromium.
//
// One function does the work: capturePage(url, viewport, mode). Behind it:
// - One shared Chromium, launched on first use, a small concurrency limit and a hard deadline.
// - The browser never touches the network itself. Every request it makes (document, redirects,
//   subresources, data calls) is fulfilled by fetchCapped, so it passes the same public-address
//   policy, DNS check and byte caps as the server's own requests. Playwright only routes the
//   first URL of a redirect chain the browser follows, so nothing is passed through with
//   route.continue(); redirects are followed and re-checked server side instead.
// - WebSockets, workers, WebRTC, WebTransport, service workers and QUIC are switched off.
// - The page is scrolled through instantly so lazy content loads, scroll-linked motion is
//   settled, overlays pinned to the lower window are hidden, animations are disabled, and the
//   page is back at scroll 0 before the picture is taken. The window is never resized.
// - Chromium cannot produce one image taller than 16,384 device px, so a tall page is captured
//   in clipped bands and stitched into one JPEG with sharp (WebP cannot hold these heights).
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page, type Request, type Route } from 'playwright';
import sharp from 'sharp';
import type { LabCwvMetrics, ViewportKey } from '../types.ts';
import { fetchCapped, normalizeUrl } from './safeFetch.ts';
import { IMAGE_LIMITS } from './image.ts';
import { startEgressProxy, type EgressProxy } from './egressProxy.ts';
import { CWV_INIT_SCRIPT, collectDomTelemetry, snapshotLabCwv, type DomTelemetrySnapshot } from './pageTelemetry.ts';

export type CaptureMode = 'viewport' | 'fullpage';

export interface PageCaptureResult {
  /** JPEG bytes. */
  image: Buffer;
  mimeType: 'image/jpeg';
  /** Image pixels (CSS px times the device scale). */
  width: number;
  height: number;
  /** Bottom of the first screen, in image pixels. */
  foldPx: number;
  /** True when the page was taller than maxPageCssHeight(viewport) and the image was cut. */
  truncated: boolean;
  captureMode: CaptureMode;
  /** Full rendered page height in CSS px, before the cap. */
  pageCssHeight: number;
  finalUrl: string;
  elapsedMs: number;
  hiddenOverlays: number;
  blockedRequests: number;
  /** Deterministic rendered DOM, SEO, and WCAG 2.2 snapshot (best effort). */
  dom?: DomTelemetrySnapshot;
  /** Lab Core Web Vitals captured before synthetic scrolling (desktop only, best effort). */
  cwv?: LabCwvMetrics;
}

export class CaptureError extends Error {
  readonly reason: 'unavailable' | 'busy' | 'timeout' | 'blocked' | 'failed';
  constructor(reason: CaptureError['reason'], message: string) {
    super(message);
    this.name = 'CaptureError';
    this.reason = reason;
  }
}

const DEVICES: Record<ViewportKey, { width: number; height: number; scale: number; mobile: boolean; userAgent: string }> = {
  desktop: {
    width: 1440,
    height: 900,
    scale: 1,
    mobile: false,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  },
  mobile: {
    width: 390,
    height: 844,
    scale: 2,
    mobile: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },
};

/** Same cap as web-obs: anything taller is cut and reported as truncated. */
export const MAX_PAGE_CSS_HEIGHT = 24_000;
/**
 * Tallest image a capture may produce, in image px, for every viewport. The client refuses
 * taller images (lib/client/images.ts), so both sides must use this same number.
 */
export const MAX_CAPTURE_IMAGE_HEIGHT_PX = IMAGE_LIMITS.maxHeightPx; // 30,000; one definition, in image.ts

/** CSS px cap for one viewport: 24,000 on desktop (scale 1), 15,000 on mobile (scale 2). */
export function maxPageCssHeight(viewport: ViewportKey): number {
  return Math.min(MAX_PAGE_CSS_HEIGHT, Math.floor(MAX_CAPTURE_IMAGE_HEIGHT_PX / DEVICES[viewport].scale));
}
/** Chromium's limit is 16,384 device px per image; stay well under it per band. */
const MAX_BAND_DEVICE_PX = 8_000;
const JPEG_QUALITY = 80;
const MAX_CONCURRENT_CAPTURES = 2;
export const CAPTURE_DEADLINE_MS = { viewport: 30_000, fullpage: 60_000 } as const;

// Per-capture network budget for the routed browser.
const MAX_REQUESTS = 400;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;
const ROUTED_TYPES = new Set(['document', 'stylesheet', 'script', 'image', 'font', 'xhr', 'fetch']);

const LAUNCH_ARGS = ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--no-pings'];

// ---- page scripts (ported from web-obs) ----------------------------------------------------

/** Replaces direct transports with constructors that throw, before any page script runs. */
const TRANSPORT_GUARD = `(() => {
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport', 'Worker', 'SharedWorker']) {
    const Blocked = class { constructor() { throw new DOMException('Direct browser transports are disabled during capture.', 'NotSupportedError'); } };
    try { Object.defineProperty(globalThis, name, { value: Blocked, writable: false, configurable: false }); } catch (_) {}
  }
})();`;

/** Instant scroll through the page so lazy content loads, then back to the top. Returns scrollHeight. */
const SCROLL_THROUGH = `async (maxHeight) => {
  for (const el of [document.documentElement, document.body]) if (el) el.style.setProperty('scroll-behavior', 'auto', 'important');
  const jump = (y) => window.scrollTo({ top: y, left: 0, behavior: 'instant' });
  const pause = (ms) => new Promise(r => setTimeout(r, ms));
  const step = Math.max(400, window.innerHeight);
  const end = Math.min(document.documentElement.scrollHeight, maxHeight);
  for (let y = 0; y < end; y += step) { jump(y); await pause(250); }
  jump(document.documentElement.scrollHeight);
  await pause(250);
  jump(0);
  for (let i = 0; i < 20 && (window.scrollY !== 0 || window.scrollX !== 0); i++) { await pause(50); jump(0); }
  await pause(400);
  return document.documentElement.scrollHeight;
}`;

/** Shows scroll-revealed elements in their resting state. */
const SETTLE_MOTION = `() => {
  let settled = 0;
  for (const el of document.querySelectorAll('[style]')) {
    const st = el.style;
    const op = st.opacity === '' ? 1 : parseFloat(st.opacity);
    const moved = (st.transform && st.transform !== 'none') || (st.translate && st.translate !== 'none');
    let settle = (op > 0.01 && op < 0.99) || (moved && op > 0.01);
    if (!settle && moved && op <= 0.01) {
      const cs = getComputedStyle(el);
      settle = cs.display !== 'none' && cs.visibility !== 'hidden' && (cs.position === 'static' || cs.position === 'relative');
    }
    if (settle) { el.setAttribute('data-vp-settle', ''); settled++; }
  }
  if (settled) {
    const css = document.createElement('style');
    css.textContent = '[data-vp-settle]{opacity:1!important;transform:none!important;translate:none!important;scale:none!important;rotate:none!important}';
    document.head.appendChild(css);
  }
  return settled;
}`;

/** Hides fixed elements that start in the lower 60% of the window (cookie bars, chat bubbles). */
const HIDE_FLOATING = `() => {
  const limit = window.innerHeight * 0.4;
  let hidden = 0;
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.top < limit) continue;
    el.setAttribute('data-vp-hide', ''); hidden++;
  }
  if (!hidden) return 0;
  const css = document.createElement('style');
  css.textContent = '[data-vp-hide]{visibility:hidden!important}';
  (document.head || document.documentElement).appendChild(css);
  return hidden;
}`;

// ---- shared browser, concurrency, shutdown ---------------------------------------------------

let browserPromise: Promise<Browser> | null = null;
let proxy: EgressProxy | null = null;
let launchFailure: { message: string; at: number } | null = null;
const LAUNCH_RETRY_MS = 5 * 60_000;

async function launch(): Promise<Browser> {
  proxy = proxy ?? (await startEgressProxy());
  return chromium.launch({
    headless: true,
    args: LAUNCH_ARGS,
    timeout: 30_000,
    // '<-loopback>' removes Chromium's implicit "never proxy localhost" rule, so loopback
    // targets that escape routing meet the proxy too.
    proxy: { server: proxy.url, bypass: '<-loopback>' },
  });
}

async function getBrowser(): Promise<Browser> {
  if (launchFailure && Date.now() - launchFailure.at < LAUNCH_RETRY_MS) {
    throw new CaptureError('unavailable', launchFailure.message);
  }
  if (!browserPromise) {
    browserPromise = launch()
      .then((browser) => {
        launchFailure = null;
        browser.on('disconnected', () => {
          browserPromise = null;
        });
        return browser;
      })
      .catch((err) => {
        browserPromise = null;
        const first = String(err?.message || err).split('\n')[0].slice(0, 200);
        launchFailure = { message: `The capture browser could not start (${first}).`, at: Date.now() };
        throw new CaptureError('unavailable', launchFailure.message);
      });
  }
  return browserPromise;
}

/** Closes the shared browser and its egress proxy. Safe to call more than once. */
export async function closeBrowser(): Promise<void> {
  const pending = browserPromise;
  browserPromise = null;
  if (pending) {
    try {
      await (await pending).close();
    } catch {
      // already gone
    }
  }
  const p = proxy;
  proxy = null;
  await p?.close();
}

/** Requests the egress proxy refused since start (escapes from routing that were stopped). */
export function egressRefusals(): number {
  return proxy?.refused() ?? 0;
}

let active = 0;
const waiting: Array<() => void> = [];
/**
 * Captures allowed to wait for a slot. One /api/capture request needs two (desktop and mobile),
 * so 4 is two queued requests; anything past that is refused at once as busy (HTTP 429).
 */
export const MAX_CAPTURE_QUEUE = 4;
export const acquireCaptureSlot = (deadline: number) => acquireSlot(deadline);

/** True when `needed` more captures would be refused right now; lets routes answer 429 before any work. */
export function captureQueueFull(needed = 1): boolean {
  return active + waiting.length + needed > MAX_CONCURRENT_CAPTURES + MAX_CAPTURE_QUEUE;
}

async function acquireSlot(deadline: number): Promise<() => void> {
  if (active >= MAX_CONCURRENT_CAPTURES && waiting.length >= MAX_CAPTURE_QUEUE) {
    throw new CaptureError('busy', 'The capture browser is busy with other pages.');
  }
  if (active >= MAX_CONCURRENT_CAPTURES) {
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const i = waiting.indexOf(wake);
        if (i !== -1) waiting.splice(i, 1);
        reject(new CaptureError('busy', 'The capture browser is busy. Please retry in a moment.'));
      }, Math.max(0, deadline - Date.now()));
      waiting.push(wake);
    });
  }
  active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active--;
    waiting.shift()?.();
  };
}

// ---- routing: every browser request goes through fetchCapped --------------------------------

const DROP_RESPONSE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade', 'set-cookie', 'location',
]);

export interface RouteBudget {
  requests: number;
  bytes: number;
  blocked: number;
  deadline: number;
}

function makeRouteHandler(budget: RouteBudget, userAgent: string) {
  return async (route: Route, request: Request) => {
    const refuse = async () => {
      budget.blocked++;
      await route.abort('blockedbyclient').catch(() => {});
    };
    try {
      const url = request.url();
      const scheme = url.slice(0, url.indexOf(':')).toLowerCase();
      if (scheme === 'data' || scheme === 'blob' || scheme === 'about') {
        await route.continue();
        return;
      }
      if (scheme !== 'http' && scheme !== 'https') return refuse();
      if (!ROUTED_TYPES.has(request.resourceType())) return refuse();
      const method = request.method().toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') return refuse();
      if (--budget.requests < 0 || budget.bytes <= 0) return refuse();
      const timeLeft = budget.deadline - Date.now();
      if (timeLeft <= 500) return refuse();

      const headers: Record<string, string> = { 'User-Agent': userAgent, Accept: request.headers()['accept'] || '*/*' };
      const lang = request.headers()['accept-language'];
      if (lang) headers['Accept-Language'] = lang;
      const referer = request.headers()['referer'];
      if (referer) headers.Referer = referer;

      const res = await fetchCapped(url, {
        method: method as 'GET' | 'HEAD',
        timeoutMs: Math.min(15_000, timeLeft),
        maxBytes: Math.min(MAX_RESPONSE_BYTES, budget.bytes),
        headers,
      });
      budget.bytes -= res.body.length;

      const outHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(res.headers)) {
        if (value === undefined || DROP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
        outHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value);
      }
      // A 3xx without Location (fetchCapped follows the rest) is passed as is, which the browser treats as final.
      await route.fulfill({ status: res.status, headers: outHeaders, body: res.body });
    } catch {
      await refuse();
    }
  };
}

// ---- reusable pieces (exported for tests) ---------------------------------------------------

/**
 * Locks a fresh browser context down before any page opens: transport guard script, every
 * HTTP(S) request fulfilled through fetchCapped, WebSockets mocked so they never connect.
 * Returns the live budget so callers can read how many requests were refused.
 */
export async function guardContext(ctx: BrowserContext, userAgent: string, deadline: number): Promise<RouteBudget> {
  const budget: RouteBudget = { requests: MAX_REQUESTS, bytes: MAX_TOTAL_BYTES, blocked: 0, deadline };
  await ctx.addInitScript({ content: TRANSPORT_GUARD });
  await ctx.addInitScript({ content: CWV_INIT_SCRIPT });
  await ctx.route('**/*', makeRouteHandler(budget, userAgent));
  await ctx.routeWebSocket(/.*/, () => {
    budget.blocked++; // never connected to a server: the socket stays mocked and silent
  });
  return budget;
}

/** A new context on the shared, proxied browser, locked down with guardContext. */
export async function openGuardedContext(
  options: BrowserContextOptions,
  userAgent: string,
  deadline: number
): Promise<{ context: BrowserContext; budget: RouteBudget }> {
  const browser = await getBrowser();
  // Downloads are refused (nothing is written to disk), and callers cannot turn them back on.
  const context = await browser.newContext({ serviceWorkers: 'block', ...options, userAgent, acceptDownloads: false });
  // A capture uses one page. Any later page (window.open, target=_blank, popups) is closed at once,
  // so a hostile page cannot spawn tabs in a loop.
  let primary: Page | null = null;
  context.on('page', (page) => {
    if (!primary) primary = page;
    else if (page !== primary) page.close().catch(() => {});
  });
  try {
    return { context, budget: await guardContext(context, userAgent, deadline) };
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

/**
 * Photographs [0, cssHeight) of the page at scroll 0 in clipped bands (each under Chromium's
 * 16,384 device px limit) and stitches them into one JPEG. The window is never resized.
 */
export async function screenshotInBands(
  page: Page,
  opts: { cssWidth: number; cssHeight: number; scale: number; deadline: number; bandDevicePx?: number }
): Promise<{ image: Buffer; width: number; height: number; bands: number }> {
  const bandDevice = Math.min(16_000, Math.max(500, opts.bandDevicePx ?? MAX_BAND_DEVICE_PX));
  const bandCss = Math.floor(bandDevice / opts.scale);
  const bands: Array<{ input: Buffer; top: number; left: number }> = [];
  for (let y = 0; y < opts.cssHeight; y += bandCss) {
    const h = Math.min(bandCss, opts.cssHeight - y);
    const input = await page.screenshot({
      type: 'png',
      fullPage: true,
      animations: 'disabled',
      clip: { x: 0, y, width: opts.cssWidth, height: h },
      timeout: Math.max(1000, Math.min(20_000, opts.deadline - Date.now())),
    });
    bands.push({ input, top: y * opts.scale, left: 0 });
  }
  const width = opts.cssWidth * opts.scale;
  const height = opts.cssHeight * opts.scale;
  const image = await sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .composite(bands)
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
  return { image, width, height, bands: bands.length };
}

// ---- capture -----------------------------------------------------------------------------------

function withDeadline<T>(promise: Promise<T>, deadline: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new CaptureError('timeout', 'The page took too long to capture.'));
    }, Math.max(0, deadline - Date.now()));
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * Captures one URL in one viewport. `viewport` mode is the first screen only; `fullpage` is the
 * whole page up to maxPageCssHeight(viewport) (30,000 image px). Throws CaptureError with a reason the route can report.
 */
export async function capturePage(
  rawUrl: string,
  viewport: ViewportKey,
  mode: CaptureMode,
  /** Band height in device px; only tests change it, to compare stitched against single-shot output. */
  options: { bandDevicePx?: number } = {}
): Promise<PageCaptureResult> {
  const started = Date.now();
  const deadline = started + CAPTURE_DEADLINE_MS[mode];
  let url: string;
  try {
    url = normalizeUrl(rawUrl);
  } catch (err) {
    throw new CaptureError('blocked', (err as Error).message);
  }
  const device = DEVICES[viewport];
  const cssCap = maxPageCssHeight(viewport);

  const release = await acquireSlot(deadline);
  let context: BrowserContext | null = null;
  try {
    const opened = await openGuardedContext(
      {
        viewport: { width: device.width, height: device.height },
        deviceScaleFactor: device.scale,
        isMobile: device.mobile,
        hasTouch: device.mobile,
        locale: 'en-US',
      },
      device.userAgent,
      deadline
    );
    context = opened.context;
    const { budget } = opened;
    const ctx = context;
    const work = async () => {
      const page = await ctx.newPage();

      const response = await page.goto(url, { waitUntil: 'load', timeout: Math.max(1000, deadline - Date.now() - 5000) });
      if (!response) throw new CaptureError('failed', 'The page did not load.');
      if (response.status() >= 400) throw new CaptureError('failed', `The page returned status ${response.status()}.`);
      await page.waitForLoadState('networkidle', { timeout: Math.min(3000, Math.max(1, deadline - Date.now() - 5000)) }).catch(() => {});
      const finalUrl = normalizeUrl(page.url()); // throws for a non-public final URL
      // Snapshot Lab CWV right after networkidle, BEFORE synthetic scrolling or CSS injection poisons CLS.
      const cwv = viewport === 'desktop' ? await snapshotLabCwv(page, budget.blocked) : undefined;

      let pageCssHeight = device.height;
      let hiddenOverlays = 0;
      let dom: DomTelemetrySnapshot | undefined;
      if (mode === 'fullpage') {
        pageCssHeight = Number(await page.evaluate(`(${SCROLL_THROUGH})(${cssCap})`).catch(() => 0)) ||
          Number(await page.evaluate('document.documentElement.scrollHeight'));
        pageCssHeight = Math.max(device.height, Math.ceil(pageCssHeight));
        await page.evaluate(`(${SETTLE_MOTION})()`).catch(() => 0);
        // Read rendered DOM/WCAG after lazy elements settle and BEFORE hiding fixed overlays.
        dom = await collectDomTelemetry(page, viewport, deadline);
        hiddenOverlays = Number(await page.evaluate(`(${HIDE_FLOATING})()`).catch(() => 0)) || 0;
        await page.waitForTimeout(200);
        await page.evaluate("window.scrollTo({ top: 0, left: 0, behavior: 'instant' })");
      } else {
        dom = await collectDomTelemetry(page, viewport, deadline);
      }

      const cssShotHeight = mode === 'fullpage' ? Math.min(pageCssHeight, cssCap) : device.height;
      const { image, width, height } = await screenshotInBands(page, {
        cssWidth: device.width,
        cssHeight: cssShotHeight,
        scale: device.scale,
        deadline,
        bandDevicePx: options.bandDevicePx,
      });

      return {
        image,
        mimeType: 'image/jpeg' as const,
        width,
        height,
        foldPx: Math.min(height, device.height * device.scale),
        truncated: mode === 'fullpage' && pageCssHeight > cssCap,
        captureMode: mode,
        pageCssHeight,
        finalUrl,
        elapsedMs: Date.now() - started,
        hiddenOverlays,
        blockedRequests: budget.blocked,
        ...(dom ? { dom } : {}),
        ...(cwv ? { cwv } : {}),
      };
    };
    return await withDeadline(work(), deadline, () => {
      ctx.close().catch(() => {});
    });
  } catch (err) {
    if (err instanceof CaptureError) throw err;
    const first = String((err as Error)?.message || err).split('\n')[0].slice(0, 200);
    if ((err as Error)?.name === 'HttpError') throw new CaptureError('blocked', first);
    throw new CaptureError('failed', first);
  } finally {
    await context?.close().catch(() => {});
    release();
  }
}
