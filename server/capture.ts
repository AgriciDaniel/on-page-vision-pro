// Page capture: a viewport screenshot from the first provider that answers, and SEO metadata
// parsed from the page HTML. All outbound requests go through fetchCapped, so every call has
// a deadline, a byte cap and the private-address guard.
import type { HeadingNode, LabCwvMetrics, PageTelemetry, SeoMetadata, ViewportKey } from '../types.ts';
import { fetchCapped } from './safeFetch.ts';
import { HttpError } from './http.ts';
import { assertImageSize, sniffImage, toDataUrl } from './image.ts';
import { CaptureError, capturePage, maxPageCssHeight, type CaptureMode } from './pageCapture.ts';
import type { DomTelemetrySnapshot } from './pageTelemetry.ts';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export const VIEWPORT_SIZES: Record<ViewportKey, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;
const MAX_HTML_BYTES = 5 * 1024 * 1024;

export type CaptureProvider = 'microlink' | 'thum.io' | 'mshots';

export interface Screenshot {
  dataUrl: string;
  width: number;
  height: number;
  provider: CaptureProvider;
}

/** Downloads an image and accepts it only if its header bytes decode as PNG, JPEG or WebP. */
async function fetchImage(imageUrl: string, timeoutMs: number): Promise<{ dataUrl: string; width: number; height: number } | null> {
  try {
    const res = await fetchCapped(imageUrl, {
      timeoutMs,
      maxBytes: MAX_SCREENSHOT_BYTES,
      headers: { 'User-Agent': BROWSER_UA, Accept: 'image/png,image/jpeg,image/webp,image/*;q=0.8' },
    });
    if (res.status < 200 || res.status >= 300) return null;
    if (res.body.length < 2500) return null; // provider error stubs and blank pixels
    const info = sniffImage(res.body);
    if (!info) return null;
    try {
      assertImageSize(info, 'screenshot'); // a provider image is held to the same pixel limits
    } catch {
      return null;
    }
    return { dataUrl: toDataUrl(info.mimeType, res.body), width: info.width, height: info.height };
  } catch {
    return null;
  }
}

/** Viewport screenshot from Microlink, then thum.io, then (desktop only) WordPress mShots. */
export async function captureViewportScreenshot(targetUrl: string, viewport: ViewportKey): Promise<Screenshot | null> {
  const { width, height } = VIEWPORT_SIZES[viewport];
  const encodedUrl = encodeURIComponent(targetUrl);

  // Provider 1: Microlink API (supports desktop and mobile viewports)
  try {
    const microlinkUrl =
      `https://api.microlink.io/?url=${encodedUrl}&screenshot=true&meta=false` +
      `&viewport.width=${width}&viewport.height=${height}` +
      (viewport === 'mobile' ? '&viewport.isMobile=true&viewport.hasTouch=true' : '');
    const res = await fetchCapped(microlinkUrl, { timeoutMs: 22000, maxBytes: 1024 * 1024 });
    if (res.status >= 200 && res.status < 300) {
      const json = JSON.parse(res.body.toString('utf8')) as { data?: { screenshot?: { url?: string } } };
      const shotUrl = json?.data?.screenshot?.url;
      if (shotUrl) {
        const shot = await fetchImage(shotUrl, 18000);
        if (shot) return { ...shot, provider: 'microlink' };
      }
    }
  } catch {
    // fall through to the next provider
  }

  // Provider 2: thum.io viewport capture
  const thum = await fetchImage(`https://image.thum.io/get/width/${width}/crop/${height}/noanimate/${targetUrl}`, 22000);
  if (thum) return { ...thum, provider: 'thum.io' };

  // Provider 3: WordPress mShots (desktop only)
  if (viewport === 'desktop') {
    const mshots = await fetchImage(`https://s0.wp.com/mshots/v1/${encodedUrl}?w=${width}&h=${height}`, 18000);
    if (mshots) return { ...mshots, provider: 'mshots' };
  }

  return null;
}

// ---- engine choice: Playwright first, providers as viewport-only fallback ----------------------

export interface ShotInfo {
  width: number;
  height: number;
  provider: 'playwright' | CaptureProvider;
  captureMode: CaptureMode;
  /** Bottom of the first screen in image px. */
  foldPx: number;
  truncated: boolean;
}

export interface CapturedShot {
  dataUrl: string;
  info: ShotInfo;
  dom?: DomTelemetrySnapshot;
  cwv?: LabCwvMetrics;
  finalUrl?: string;
}

const VIEWPORT_LABEL: Record<ViewportKey, string> = { desktop: 'Desktop', mobile: 'Mobile' };

/**
 * One screenshot for one viewport. Playwright is used for both modes; when it cannot run or
 * fails, the old providers supply a viewport-only image and `warnings` says why.
 */
export const CAPTURE_BUSY_MESSAGE =
  'The capture browser is busy with other pages right now. Please retry in a minute, or upload a screenshot instead.';

export async function captureShot(
  url: string,
  viewport: ViewportKey,
  mode: CaptureMode,
  warnings: string[],
  /** Injectable for tests; production uses Playwright and the old providers. */
  engines: { browser?: typeof capturePage; fallback?: typeof captureViewportScreenshot } = {}
): Promise<CapturedShot | null> {
  const label = VIEWPORT_LABEL[viewport];
  const browserCapture = engines.browser ?? capturePage;
  const fallbackCapture = engines.fallback ?? captureViewportScreenshot;
  let reason: string;
  try {
    const shot = await browserCapture(url, viewport, mode);
    if (shot.truncated) {
      warnings.push(
        `${label} page is ${shot.pageCssHeight.toLocaleString('en-US')} CSS px tall; the image stops at ${maxPageCssHeight(viewport).toLocaleString('en-US')} CSS px (${shot.height.toLocaleString('en-US')} image px).`
      );
    }
    return {
      dataUrl: toDataUrl(shot.mimeType, shot.image),
      info: {
        width: shot.width,
        height: shot.height,
        provider: 'playwright',
        captureMode: shot.captureMode,
        foldPx: shot.foldPx,
        truncated: shot.truncated,
      },
      ...(shot.dom ? { dom: shot.dom } : {}),
      ...(shot.cwv ? { cwv: shot.cwv } : {}),
      ...(shot.finalUrl ? { finalUrl: shot.finalUrl } : {}),
    };
  } catch (err) {
    // Busy is load, not a broken page: answer 429 rather than adding a fallback provider call.
    if (err instanceof CaptureError && err.reason === 'busy') throw new HttpError(429, CAPTURE_BUSY_MESSAGE);
    reason = err instanceof CaptureError ? err.message : 'the capture browser failed';
  }

  const fallback = await fallbackCapture(url, viewport);
  if (!fallback) {
    warnings.push(`${label} capture failed: ${reason}`);
    return null;
  }
  warnings.push(
    `${label} ${mode === 'fullpage' ? 'full-page ' : ''}capture failed (${reason.replace(/\.$/, '')}); used a ${fallback.provider} viewport screenshot instead.`
  );
  return {
    dataUrl: fallback.dataUrl,
    info: {
      width: fallback.width,
      height: fallback.height,
      provider: fallback.provider,
      captureMode: 'viewport',
      foldPx: fallback.height,
      truncated: false,
    },
  };
}

// ---- page metadata --------------------------------------------------------------------------

export function emptyMetadata(url: string, domain: string): SeoMetadata {
  return {
    url,
    title: domain,
    description: '',
    h1s: [],
    h2s: [],
    totalImages: 0,
    missingAltImages: 0,
    ctaTexts: [],
    wordCount: 0,
    textPreview: '',
  };
}

function coerceTelemetry(raw: unknown): PageTelemetry | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const t = raw as Record<string, unknown>;
  const s = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const optStr = (v: unknown, max: number) => {
    const out = s(v, max).trim();
    return out || undefined;
  };
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
  const optNum = (v: unknown) => (v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);
  const strList = (v: unknown, n: number, max: number) =>
    Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, n).map((x) => (x as string).slice(0, max)) : [];
  const contrastFailures = Array.isArray(t.contrastFailures)
    ? t.contrastFailures
        .filter((c) => c && typeof c === 'object')
        .slice(0, 8)
        .map((c: any) => ({
          text: s(c.text, 60),
          ratio: Number.isFinite(Number(c.ratio)) ? Math.round(Number(c.ratio) * 100) / 100 : 0,
          required: Number.isFinite(Number(c.required)) ? Number(c.required) : 4.5,
          fg: s(c.fg, 32),
          bg: s(c.bg, 32),
        }))
    : [];
  const rawCwv = t.cwv && typeof t.cwv === 'object' ? (t.cwv as Record<string, unknown>) : null;
  const rawOrigin = t.origin && typeof t.origin === 'object' ? (t.origin as Record<string, unknown>) : null;
  const rawHeaders = t.headers && typeof t.headers === 'object' ? (t.headers as Record<string, unknown>) : null;
  return {
    collectedAt: s(t.collectedAt, 40) || new Date().toISOString(),
    spaHydratedDiff: Boolean(t.spaHydratedDiff),
    renderedWordCount: num(t.renderedWordCount),
    renderedH1Count: num(t.renderedH1Count),
    lang: optStr(t.lang, 40) ?? null,
    brokenImages: num(t.brokenImages),
    headingOrderIssues: strList(t.headingOrderIssues, 8, 120),
    jsonLdErrors: num(t.jsonLdErrors),
    formFieldCount: num(t.formFieldCount),
    unlabelledInputs: num(t.unlabelledInputs),
    missingLandmarks: strList(t.missingLandmarks, 6, 30),
    bodyFontPx: optNum(t.bodyFontPx),
    horizontalOverflow: Boolean(t.horizontalOverflow),
    smallTapTargets24: num(t.smallTapTargets24),
    smallTapTargets44: num(t.smallTapTargets44),
    ...(t.mobileHorizontalOverflow !== undefined ? { mobileHorizontalOverflow: Boolean(t.mobileHorizontalOverflow) } : {}),
    ...(t.mobileBodyFontPx !== undefined ? { mobileBodyFontPx: optNum(t.mobileBodyFontPx) } : {}),
    ...(t.mobileSmallTapTargets24 !== undefined ? { mobileSmallTapTargets24: num(t.mobileSmallTapTargets24) } : {}),
    ...(t.mobileSmallTapTargets44 !== undefined ? { mobileSmallTapTargets44: num(t.mobileSmallTapTargets44) } : {}),
    contrastFailures,
    contrastUnresolvedCount: num(t.contrastUnresolvedCount),
    ...(rawCwv
      ? {
          cwv: {
            ttfbMs: optNum(rawCwv.ttfbMs),
            fcpMs: optNum(rawCwv.fcpMs),
            lcpMs: optNum(rawCwv.lcpMs),
            cls: optNum(rawCwv.cls),
            domNodes: num(rawCwv.domNodes),
            transferKb: optNum(rawCwv.transferKb),
            blockedRequests: num(rawCwv.blockedRequests),
          },
        }
      : {}),
    ...(rawOrigin
      ? {
          origin: {
            robotsTxtPresent: Boolean(rawOrigin.robotsTxtPresent),
            robotsTxtStatus: optNum(rawOrigin.robotsTxtStatus),
            sitemapCount: num(rawOrigin.sitemapCount),
            aiBots: Array.isArray(rawOrigin.aiBots)
              ? rawOrigin.aiBots
                  .filter((b) => b && typeof b === 'object')
                  .slice(0, 10)
                  .map((b: any) => ({
                    bot: s(b.bot, 40),
                    allowed: typeof b.allowed === 'boolean' ? b.allowed : null,
                  }))
              : [],
            llmsTxtPresent: Boolean(rawOrigin.llmsTxtPresent),
            llmsTxtStatus: optNum(rawOrigin.llmsTxtStatus),
            ...(rawOrigin.llmsTxtBytes !== undefined ? { llmsTxtBytes: num(rawOrigin.llmsTxtBytes) } : {}),
          },
        }
      : {}),
    ...(rawHeaders
      ? {
          headers: {
            ...(optStr(rawHeaders.xRobotsTag, 160) ? { xRobotsTag: optStr(rawHeaders.xRobotsTag, 160) } : {}),
            ...(rawHeaders.hsts !== undefined ? { hsts: Boolean(rawHeaders.hsts) } : {}),
            ...(rawHeaders.csp !== undefined ? { csp: Boolean(rawHeaders.csp) } : {}),
          },
        }
      : {}),
    ...(optStr(t.finalUrl, 2048) ? { finalUrl: optStr(t.finalUrl, 2048) } : {}),
  };
}

/** Coerces client-sent metadata (it returns to the server inside audit requests) into a safe shape. */
export function coerceMetadata(raw: unknown): SeoMetadata | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const m = raw as Record<string, unknown>;
  const s = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const opt = (v: unknown, max: number) => {
    const out = s(v, max).trim();
    return out || undefined;
  };
  const list = (v: unknown, n: number, max: number) =>
    Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, n).map((x) => (x as string).slice(0, max)) : [];
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
  const headingTree: HeadingNode[] | undefined = Array.isArray(m.headingTree)
    ? m.headingTree
        .filter((h) => h && typeof h === 'object' && typeof (h as any).text === 'string')
        .slice(0, 16)
        .map((h: any) => ({
          level: Math.max(1, Math.min(3, Math.round(Number(h.level) || 2))),
          text: String(h.text).slice(0, 140),
        }))
    : undefined;
  const telemetry = coerceTelemetry(m.telemetry);
  return {
    url: opt(m.url, 2048),
    title: s(m.title, 300),
    description: s(m.description, 1000),
    ...(opt(m.canonical, 2048) ? { canonical: opt(m.canonical, 2048) } : {}),
    ...(opt(m.ogTitle, 300) ? { ogTitle: opt(m.ogTitle, 300) } : {}),
    ...(opt(m.ogDescription, 1000) ? { ogDescription: opt(m.ogDescription, 1000) } : {}),
    ...(opt(m.ogImage, 2048) ? { ogImage: opt(m.ogImage, 2048) } : {}),
    ...(opt(m.viewportMeta, 200) ? { viewportMeta: opt(m.viewportMeta, 200) } : {}),
    ...(opt(m.robotsMeta, 200) ? { robotsMeta: opt(m.robotsMeta, 200) } : {}),
    schemaTypes: list(m.schemaTypes, 30, 80),
    ...(headingTree && headingTree.length > 0 ? { headingTree } : {}),
    h1s: list(m.h1s, 5, 200),
    h2s: list(m.h2s, 10, 200),
    totalImages: num(m.totalImages),
    missingAltImages: num(m.missingAltImages),
    ctaTexts: list(m.ctaTexts, 10, 60),
    wordCount: num(m.wordCount),
    textPreview: s(m.textPreview, 1200),
    ...(telemetry ? { telemetry } : {}),
  };
}

/** Fetches the page HTML and parses it. Never throws: returns empty metadata plus a warning. */
export async function fetchPageMetadata(
  url: string,
  domain: string
): Promise<{
  metadata: SeoMetadata;
  headers?: { xRobotsTag?: string; hsts?: boolean; csp?: boolean };
  finalUrl?: string;
  warning?: string;
}> {
  try {
    const res = await fetchCapped(url, {
      timeoutMs: 10000,
      maxBytes: MAX_HTML_BYTES,
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    const headerVal = (name: string) => {
      const v = res.headers[name];
      return Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : '';
    };
    const xRobotsTag = headerVal('x-robots-tag').trim().slice(0, 160) || undefined;
    const headers = {
      ...(xRobotsTag ? { xRobotsTag } : {}),
      hsts: Boolean(headerVal('strict-transport-security')),
      csp: Boolean(headerVal('content-security-policy')),
    };
    if (res.status < 200 || res.status >= 300) {
      return {
        metadata: emptyMetadata(url, domain),
        headers,
        finalUrl: res.url,
        warning: `Page HTML returned status ${res.status}; metadata may be limited.`,
      };
    }
    return { metadata: parseSeoMetadata(res.body.toString('utf8'), res.url || url), headers, finalUrl: res.url };
  } catch (err: any) {
    const reason = err?.code === 'too_large' ? ' (page HTML is over 5 MB)' : '';
    return {
      metadata: emptyMetadata(url, domain),
      warning: `Could not fetch raw HTML metadata directly${reason}; running visual-first audit.`,
    };
  }
}

function extractText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// Typographic characters are built from code points so this source file contains no dash glyphs.
const ch = (code: number) => String.fromCharCode(code);
const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ',
  rsquo: ch(0x2019), lsquo: ch(0x2018), rdquo: ch(0x201d), ldquo: ch(0x201c),
  mdash: ch(0x2014), ndash: ch(0x2013), hellip: ch(0x2026),
  copy: ch(0xa9), reg: ch(0xae), trade: ch(0x2122),
  rarr: ch(0x2192), larr: ch(0x2190), middot: ch(0xb7), bull: ch(0x2022), times: ch(0xd7),
};

function decodeHtmlEntities(str: string): string {
  const fromCode = (code: number) => (Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '');
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => fromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => fromCode(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_HTML_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/\s+/g, ' ')
    .trim();
}

function extractHtmlAttr(tag: string, attrName: string): string | null {
  const patterns = [
    new RegExp(`\\b${attrName}\\s*=\\s*"([^"]*)"`, 'i'),
    new RegExp(`\\b${attrName}\\s*=\\s*'([^']*)'`, 'i'),
    new RegExp(`\\b${attrName}\\s*=\\s*([^\\s"'=<>` + '`' + `]+)`, 'i'),
  ];
  for (const re of patterns) {
    const m = tag.match(re);
    if (m) return decodeHtmlEntities(m[1]);
  }
  return null;
}

export function parseSeoMetadata(html: string, url: string): SeoMetadata {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1]) : '';

  const metaTags = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const getMeta = (attr: string, value: string): string => {
    const target = value.toLowerCase();
    for (const tag of metaTags) {
      const keyVal = extractHtmlAttr(tag, attr);
      if (keyVal && keyVal.toLowerCase() === target) {
        const content = extractHtmlAttr(tag, 'content');
        if (content !== null) return content;
      }
    }
    return '';
  };

  const description = getMeta('name', 'description');
  const ogTitle = getMeta('property', 'og:title');
  const ogDescription = getMeta('property', 'og:description');
  const ogImage = getMeta('property', 'og:image');
  const viewportMeta = getMeta('name', 'viewport');
  const robotsMeta = getMeta('name', 'robots');

  let canonical: string | undefined;
  for (const tag of [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0])) {
    const rel = extractHtmlAttr(tag, 'rel');
    if (rel && rel.toLowerCase().split(/\s+/).includes('canonical')) {
      canonical = extractHtmlAttr(tag, 'href') || undefined;
      break;
    }
  }

  // JSON-LD structured data @type values
  const schemaSet = new Set<string>();
  const collectTypes = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(collectTypes);
      return;
    }
    if (typeof node['@type'] === 'string') schemaSet.add(node['@type']);
    else if (Array.isArray(node['@type'])) node['@type'].forEach((t: any) => typeof t === 'string' && schemaSet.add(t));
    if (Array.isArray(node['@graph'])) collectTypes(node['@graph']);
  };
  for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      collectTypes(JSON.parse(match[1].trim()));
    } catch {
      // ignore malformed third-party JSON-LD
    }
  }

  // Ordered heading outline (H1 to H3)
  const headingTree: HeadingNode[] = [...html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((m) => ({ level: Number(m[1]), text: extractText(m[2]).slice(0, 140) }))
    .filter((h) => h.text.length > 0)
    .slice(0, 16);

  const h1s = headingTree.filter((h) => h.level === 1).map((h) => h.text).slice(0, 5);
  const h2s = headingTree.filter((h) => h.level === 2).map((h) => h.text).slice(0, 10);

  // Per WCAG 1.1.1, explicit alt="" is valid for decorative images; only flag missing alt attributes
  const imgTags = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const missingAltImages = imgTags.filter((tag) => extractHtmlAttr(tag, 'alt') === null).length;

  const buttonTexts = [...html.matchAll(/<(?:button|a)\b[^>]*>([\s\S]*?)<\/(?:button|a)>/gi)]
    .map((m) => extractText(m[1]))
    .filter((t) => t.length >= 2 && t.length <= 40)
    .slice(0, 15);

  const plainText = extractText(html);

  return {
    url,
    title: title || ogTitle || new URL(url).hostname,
    description: description || ogDescription || '',
    canonical,
    ogTitle,
    ogDescription,
    ogImage,
    viewportMeta: viewportMeta || undefined,
    robotsMeta: robotsMeta || undefined,
    schemaTypes: Array.from(schemaSet),
    headingTree,
    h1s,
    h2s,
    totalImages: imgTags.length,
    missingAltImages,
    ctaTexts: Array.from(new Set(buttonTexts)).slice(0, 10),
    wordCount: plainText ? plainText.split(/\s+/).length : 0,
    textPreview: plainText.slice(0, 1200),
  };
}
