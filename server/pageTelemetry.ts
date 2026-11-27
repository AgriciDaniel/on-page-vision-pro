// Deterministic page telemetry: hydrated DOM vs raw SSR diff, WCAG 2.2 AA measurements,
// Lab Core Web Vitals (captured BEFORE synthetic scrolling), and server-side /robots.txt + /llms.txt.
//
// Zero extra paid model calls and zero external browser dependencies. Every outbound fetch goes
// through fetchCapped (public-address DNS policy, byte cap, hard timeout). Node strip-only TS safe.
import type { Page } from 'playwright';
import type {
  AiBotAccess,
  ContrastFailureSample,
  HeadingNode,
  LabCwvMetrics,
  OriginSignals,
  PageTelemetry,
  SeoMetadata,
  ViewportKey,
} from '../types.ts';
import { fetchCapped } from './safeFetch.ts';

const AI_BOTS = [
  'Googlebot',
  'OAI-SearchBot',
  'GPTBot',
  'Claude-SearchBot',
  'PerplexityBot',
  'Google-Extended',
] as const;

/**
 * Injected via context.addInitScript BEFORE navigation so LCP, CLS, and FCP are captured
 * during initial load, before SCROLL_THROUGH or SETTLE_MOTION runs.
 */
export const CWV_INIT_SCRIPT = `(() => {
  const store = { fcp: null, lcp: null, cls: 0 };
  globalThis.__vpCwv = store;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.name === 'first-contentful-paint' && store.fcp === null) store.fcp = Math.round(e.startTime);
      }
    }).observe({ type: 'paint', buffered: true });
  } catch (_) {}
  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      if (entries.length) store.lcp = Math.round(entries[entries.length - 1].startTime);
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (_) {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!e.hadRecentInput && typeof e.value === 'number') store.cls += e.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (_) {}
})();`;

const READ_CWV_SCRIPT = `() => {
  const store = globalThis.__vpCwv || {};
  const nav = performance.getEntriesByType('navigation')[0];
  const ttfbMs = nav && Number.isFinite(nav.responseStart) && nav.responseStart >= 0 ? Math.round(nav.responseStart) : null;
  const resources = performance.getEntriesByType('resource') || [];
  let transferBytes = nav && Number.isFinite(nav.transferSize) ? nav.transferSize : 0;
  for (const r of resources) {
    if (Number.isFinite(r.transferSize) && r.transferSize > 0) transferBytes += r.transferSize;
  }
  return {
    ttfbMs,
    fcpMs: typeof store.fcp === 'number' ? store.fcp : null,
    lcpMs: typeof store.lcp === 'number' ? store.lcp : null,
    cls: typeof store.cls === 'number' ? Math.round(store.cls * 1000) / 1000 : null,
    domNodes: document.querySelectorAll('*').length,
    transferKb: transferBytes > 0 ? Math.round(transferBytes / 1024) : null,
  };
}`;

export interface DomTelemetrySnapshot {
  title: string;
  description: string;
  canonical?: string;
  robotsMeta?: string;
  viewportMeta?: string;
  lang: string | null;
  h1s: string[];
  h2s: string[];
  headingTree: HeadingNode[];
  headingOrderIssues: string[];
  renderedWordCount: number;
  totalImages: number;
  missingAltImages: number;
  brokenImages: number;
  schemaTypes: string[];
  jsonLdErrors: number;
  formFieldCount: number;
  unlabelledInputs: number;
  missingLandmarks: string[];
  bodyFontPx: number | null;
  horizontalOverflow: boolean;
  smallTapTargets24: number;
  smallTapTargets44: number;
  contrastFailures: ContrastFailureSample[];
  contrastUnresolvedCount: number;
}

const READ_DOM_SCRIPT = `async (isMobile) => {
  try {
    if (document.fonts && document.fonts.ready) {
      await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 800))]);
    }
  } catch (_) {}

  const walk = (root, out) => {
    if (!root || out.length > 4000) return;
    const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of nodes) {
      out.push(el);
      if (out.length > 4000) break;
      if (el.shadowRoot) walk(el.shadowRoot, out);
    }
  };
  const allEls = [];
  walk(document, allEls);

  const meta = (selector) => (document.querySelector(selector)?.getAttribute('content') || '').trim();
  const title = (document.title || '').trim().slice(0, 300);
  const description = meta('meta[name="description"]').slice(0, 1000);
  const canonical = (document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '').trim().slice(0, 2048) || undefined;
  const robotsMeta = meta('meta[name="robots"]').slice(0, 200) || undefined;
  const viewportMeta = meta('meta[name="viewport"]').slice(0, 200) || undefined;
  const lang = (document.documentElement?.getAttribute('lang') || '').trim().slice(0, 40) || null;

  const headingTree = [];
  const headingOrderIssues = [];
  let prevLevel = 0;
  for (const el of allEls) {
    const tag = el.tagName;
    if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4') {
      const level = Number(tag[1]);
      const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 140);
      if (!text) continue;
      if (prevLevel > 0 && level > prevLevel + 1 && headingOrderIssues.length < 6) {
        headingOrderIssues.push('Skipped H' + prevLevel + ' to H' + level + ': "' + text.slice(0, 45) + '"');
      }
      prevLevel = level;
      if (level <= 3 && headingTree.length < 16) headingTree.push({ level, text });
    }
  }
  const h1s = headingTree.filter((h) => h.level === 1).map((h) => h.text).slice(0, 5);
  const h2s = headingTree.filter((h) => h.level === 2).map((h) => h.text).slice(0, 10);
  if (h1s.length === 0) headingOrderIssues.unshift('No visible H1 heading in rendered DOM');
  else if (h1s.length > 1) headingOrderIssues.unshift('Multiple H1 headings (' + h1s.length + ')');

  const bodyText = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
  const renderedWordCount = bodyText ? bodyText.split(' ').length : 0;

  let totalImages = 0;
  let missingAltImages = 0;
  let brokenImages = 0;
  for (const el of allEls) {
    if (el.tagName !== 'IMG') continue;
    totalImages++;
    if (!el.hasAttribute('alt')) missingAltImages++;
    const cs = getComputedStyle(el);
    if (cs.display !== 'none' && cs.visibility !== 'hidden' && el.complete && el.naturalWidth === 0 && (el.getAttribute('src') || el.currentSrc)) {
      brokenImages++;
    }
  }

  const schemaSet = new Set();
  let jsonLdErrors = 0;
  const collectTypes = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(collectTypes); return; }
    if (typeof node['@type'] === 'string') schemaSet.add(node['@type']);
    else if (Array.isArray(node['@type'])) node['@type'].forEach((t) => { if (typeof t === 'string') schemaSet.add(t); });
    if (Array.isArray(node['@graph'])) collectTypes(node['@graph']);
  };
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { collectTypes(JSON.parse((s.textContent || '').trim())); } catch (_) { jsonLdErrors++; }
  }

  let formFieldCount = 0;
  let unlabelledInputs = 0;
  for (const el of allEls) {
    if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) continue;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    formFieldCount++;
    const id = el.getAttribute('id');
    const hasLabel = Boolean(
      (el.getAttribute('aria-label') || '').trim() ||
      (el.getAttribute('aria-labelledby') || '').trim() ||
      el.closest('label') ||
      (id && document.querySelector('label[for="' + CSS.escape(id) + '"]'))
    );
    if (!hasLabel) unlabelledInputs++;
  }

  const missingLandmarks = [];
  if (!document.querySelector('main, [role="main"]')) missingLandmarks.push('main');
  if (!document.querySelector('nav, [role="navigation"]')) missingLandmarks.push('nav');
  if (!document.querySelector('header, [role="banner"]')) missingLandmarks.push('header');

  const bodyFontPxRaw = parseFloat(getComputedStyle(document.body || document.documentElement).fontSize || '');
  const bodyFontPx = Number.isFinite(bodyFontPxRaw) ? Math.round(bodyFontPxRaw * 10) / 10 : null;
  const horizontalOverflow = (document.documentElement?.scrollWidth || 0) > window.innerWidth + 2;

  const parseRgba = (str) => {
    const m = /rgba?\\(\\s*(\\d+)[\\s,]+(\\d+)[\\s,]+(\\d+)(?:[\\s,/]+([\\d.]+))?\\s*\\)/i.exec(str || '');
    if (!m) return null;
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
  };
  const lum = (c) => {
    const ch = [c.r, c.g, c.b].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const ratioOf = (a, b) => {
    const l1 = lum(a);
    const l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const resolveSolidBg = (el) => {
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const cs = getComputedStyle(cur);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return 'unresolved';
      const c = parseRgba(cs.backgroundColor);
      if (c && c.a >= 0.92) return c;
      if (c && c.a > 0.05 && c.a < 0.92) return 'unresolved';
      cur = cur.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };

  let smallTapTargets24 = 0;
  let smallTapTargets44 = 0;
  const contrastFailures = [];
  let contrastUnresolvedCount = 0;
  let checkedContrast = 0;

  for (const el of allEls) {
    const tag = el.tagName;
    const isInteractive = tag === 'A' || tag === 'BUTTON' || (tag === 'INPUT' && ['submit', 'button'].includes((el.getAttribute('type') || '').toLowerCase())) || el.getAttribute('role') === 'button';
    if (isInteractive) {
      const cs = getComputedStyle(el);
      if (cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.05) {
        const rect = el.getBoundingClientRect();
        if (rect.width >= 4 && rect.height >= 4) {
          if (rect.width < 24 || rect.height < 24) smallTapTargets24++;
          if (rect.width < 44 || rect.height < 44) smallTapTargets44++;
        }
      }
    }

    if (!isMobile && checkedContrast < 180 && ['H1', 'H2', 'H3', 'P', 'A', 'BUTTON', 'LABEL', 'LI', 'SPAN'].includes(tag)) {
      const directText = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent || '').join(' ').replace(/\\s+/g, ' ').trim();
      if (directText.length >= 3) {
        const cs = getComputedStyle(el);
        if (cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') >= 0.85) {
          const rect = el.getBoundingClientRect();
          if (rect.width >= 8 && rect.height >= 8) {
            checkedContrast++;
            const fg = parseRgba(cs.color);
            const bg = resolveSolidBg(el);
            if (!fg || fg.a < 0.9 || bg === 'unresolved') {
              contrastUnresolvedCount++;
            } else {
              const fontPx = parseFloat(cs.fontSize || '16');
              const weight = Number(cs.fontWeight) || 400;
              const isLarge = fontPx >= 24 || (fontPx >= 18.66 && weight >= 700);
              const required = isLarge ? 3.0 : 4.5;
              const r = ratioOf(fg, bg);
              if (r < required && contrastFailures.length < 8) {
                contrastFailures.push({
                  text: directText.slice(0, 60),
                  ratio: Math.round(r * 100) / 100,
                  required,
                  fg: cs.color.slice(0, 32),
                  bg: 'rgb(' + bg.r + ', ' + bg.g + ', ' + bg.b + ')',
                });
              }
            }
          }
        }
      }
    }
  }

  return {
    title,
    description,
    canonical,
    robotsMeta,
    viewportMeta,
    lang,
    h1s,
    h2s,
    headingTree,
    headingOrderIssues: headingOrderIssues.slice(0, 8),
    renderedWordCount,
    totalImages,
    missingAltImages,
    brokenImages,
    schemaTypes: Array.from(schemaSet).slice(0, 30),
    jsonLdErrors,
    formFieldCount,
    unlabelledInputs,
    missingLandmarks,
    bodyFontPx,
    horizontalOverflow,
    smallTapTargets24,
    smallTapTargets44,
    contrastFailures,
    contrastUnresolvedCount,
  };
}`;

/** Reads buffered Lab CWV right after networkidle, BEFORE synthetic scrolling or CSS injection. */
export async function snapshotLabCwv(page: Page, blockedRequests: number): Promise<LabCwvMetrics | undefined> {
  try {
    const raw = (await page.evaluate(`(${READ_CWV_SCRIPT})()`)) as Omit<LabCwvMetrics, 'blockedRequests'>;
    return { ...raw, blockedRequests };
  } catch {
    return undefined;
  }
}

/** Collects rendered DOM, SEO, and WCAG 2.2 measurements under a strict 2.5 s cap. */
export async function collectDomTelemetry(
  page: Page,
  viewport: ViewportKey,
  deadline: number
): Promise<DomTelemetrySnapshot | undefined> {
  const capMs = Math.min(2500, deadline - Date.now() - 4000);
  if (capMs < 400) return undefined;
  try {
    const work = page.evaluate(`(${READ_DOM_SCRIPT})(${viewport === 'mobile'})`) as Promise<DomTelemetrySnapshot>;
    const timer = new Promise<undefined>((resolve) => {
      const t = setTimeout(() => resolve(undefined), capMs);
      t.unref?.();
    });
    return await Promise.race([work, timer]);
  } catch {
    return undefined;
  }
}

/**
 * Evaluates whether a bot is allowed to crawl `/` from a robots.txt body.
 * Checks exact bot group first, then `*` wildcard group. Longest matching path wins, Allow beats Disallow on tie.
 */
export function evaluateRobotsForBot(robotsText: string, bot: string): boolean | null {
  const lines = robotsText.split(/\r?\n/);
  const groups: Array<{ agents: string[]; rules: Array<{ type: 'allow' | 'disallow'; path: string }> }> = [];
  let current: { agents: string[]; rules: Array<{ type: 'allow' | 'disallow'; path: string }> } | null = null;
  let sawRule = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || sawRule) {
        current = { agents: [], rules: [] };
        groups.push(current);
        sawRule = false;
      }
      if (val) current.agents.push(val.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && current) {
      sawRule = true;
      current.rules.push({ type: key, path: val });
    }
  }

  const target = bot.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a === target));
  const matched = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes('*'));
  if (matched.length === 0) return true;

  let bestLen = -1;
  let bestType: 'allow' | 'disallow' | null = null;
  for (const g of matched) {
    for (const r of g.rules) {
      if (!r.path) {
        // Empty Disallow means allow all.
        if (r.type === 'disallow' && bestLen < 0) {
          bestLen = 0;
          bestType = 'allow';
        }
        continue;
      }
      const p = r.path.replace(/\*+$/, '');
      if (p === '/' || p === '') {
        const len = p.length;
        if (len > bestLen || (len === bestLen && r.type === 'allow')) {
          bestLen = len;
          bestType = r.type;
        }
      }
    }
  }
  return bestType === 'disallow' ? false : true;
}

/** Server-side check of /robots.txt and /llms.txt via fetchCapped. Never throws or blocks capture. */
export async function fetchOriginSignals(
  pageUrl: string,
  fetcher: typeof fetchCapped = fetchCapped
): Promise<OriginSignals | undefined> {
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return undefined;
  }

  const safeGet = async (pathname: string) => {
    try {
      const res = await fetcher(new URL(pathname, origin).toString(), {
        timeoutMs: 2500,
        maxBytes: 131_072,
        maxRedirects: 3,
        headers: { 'User-Agent': 'OnPageVisionPro/1.0 (+https://example.com)', Accept: 'text/plain,*/*;q=0.5' },
      });
      return { status: res.status, text: res.status >= 200 && res.status < 300 ? res.body.toString('utf8') : '', bytes: res.body.length };
    } catch {
      return { status: null as number | null, text: '', bytes: 0 };
    }
  };

  const [robots, llms] = await Promise.all([safeGet('/robots.txt'), safeGet('/llms.txt')]);
  const robotsTxtPresent = robots.status !== null && robots.status >= 200 && robots.status < 300 && robots.text.trim().length > 0;
  const sitemapCount = robotsTxtPresent
    ? robots.text.split(/\r?\n/).filter((l) => /^\s*sitemap\s*:/i.test(l)).length
    : 0;
  const aiBots: AiBotAccess[] = AI_BOTS.map((bot) => ({
    bot,
    allowed: robotsTxtPresent ? evaluateRobotsForBot(robots.text, bot) : null,
  }));

  const llmsTxtPresent = llms.status !== null && llms.status >= 200 && llms.status < 300 && llms.text.trim().length > 0;

  return {
    robotsTxtPresent,
    robotsTxtStatus: robots.status,
    sitemapCount,
    aiBots,
    llmsTxtPresent,
    llmsTxtStatus: llms.status,
    ...(llmsTxtPresent ? { llmsTxtBytes: llms.bytes } : {}),
  };
}

/** Merges raw SSR HTML metadata with hydrated Playwright DOM telemetry, Lab CWV, headers, and origin signals. */
export function buildEnrichedMetadata(params: {
  raw: SeoMetadata;
  desktopDom?: DomTelemetrySnapshot;
  mobileDom?: DomTelemetrySnapshot;
  cwv?: LabCwvMetrics;
  origin?: OriginSignals;
  headers?: { xRobotsTag?: string; hsts?: boolean; csp?: boolean };
  finalUrl?: string;
}): SeoMetadata {
  const { raw, desktopDom, mobileDom, cwv, origin, headers, finalUrl } = params;
  const primary = desktopDom ?? mobileDom;

  if (!primary && !cwv && !origin && !headers) {
    return raw;
  }

  const rawWords = raw.wordCount || 0;
  const renderedWords = primary?.renderedWordCount ?? rawWords;
  const spaHydratedDiff = Boolean(
    primary &&
      ((rawWords < 60 && renderedWords >= 120) ||
        (raw.h1s.length === 0 && primary.h1s.length > 0) ||
        ((raw.schemaTypes?.length ?? 0) === 0 && primary.schemaTypes.length > 0))
  );

  const mergedSchema = Array.from(new Set([...(raw.schemaTypes ?? []), ...(primary?.schemaTypes ?? [])])).slice(0, 30);

  const telemetry: PageTelemetry = {
    collectedAt: new Date().toISOString(),
    spaHydratedDiff,
    renderedWordCount: renderedWords,
    renderedH1Count: primary?.h1s.length ?? raw.h1s.length,
    lang: primary?.lang ?? null,
    brokenImages: primary?.brokenImages ?? 0,
    headingOrderIssues: primary?.headingOrderIssues ?? [],
    jsonLdErrors: primary?.jsonLdErrors ?? 0,
    formFieldCount: primary?.formFieldCount ?? 0,
    unlabelledInputs: primary?.unlabelledInputs ?? 0,
    missingLandmarks: primary?.missingLandmarks ?? [],
    bodyFontPx: primary?.bodyFontPx ?? null,
    horizontalOverflow: primary?.horizontalOverflow ?? false,
    smallTapTargets24: primary?.smallTapTargets24 ?? 0,
    smallTapTargets44: primary?.smallTapTargets44 ?? 0,
    ...(mobileDom
      ? {
          mobileHorizontalOverflow: mobileDom.horizontalOverflow,
          mobileBodyFontPx: mobileDom.bodyFontPx,
          mobileSmallTapTargets24: mobileDom.smallTapTargets24,
          mobileSmallTapTargets44: mobileDom.smallTapTargets44,
        }
      : {}),
    contrastFailures: primary?.contrastFailures ?? [],
    contrastUnresolvedCount: primary?.contrastUnresolvedCount ?? 0,
    ...(cwv ? { cwv } : {}),
    ...(origin ? { origin } : {}),
    ...(headers ? { headers } : {}),
    ...(finalUrl ? { finalUrl } : {}),
  };

  return {
    ...raw,
    title: raw.title || primary?.title || '',
    description: raw.description || primary?.description || '',
    canonical: raw.canonical || primary?.canonical,
    viewportMeta: raw.viewportMeta || primary?.viewportMeta,
    robotsMeta: raw.robotsMeta || primary?.robotsMeta,
    schemaTypes: mergedSchema,
    headingTree: (raw.headingTree?.length ?? 0) > 0 ? raw.headingTree : primary?.headingTree,
    h1s: raw.h1s.length > 0 ? raw.h1s : (primary?.h1s ?? []),
    h2s: raw.h2s.length > 0 ? raw.h2s : (primary?.h2s ?? []),
    totalImages: Math.max(raw.totalImages, primary?.totalImages ?? 0),
    missingAltImages: raw.totalImages > 0 ? raw.missingAltImages : (primary?.missingAltImages ?? 0),
    telemetry,
  };
}

/**
 * Compact, verified numeric/enum facts for Gemini prompts.
 * - 'first-section': ~35 tokens (rendered counts, SPA guard, tap targets, contrast failures, overflow).
 * - 'overview': ~100 tokens (indexing flags, AI crawler policy, JSON-LD, broken images, landmarks, headers).
 */
export function formatTelemetryForPrompt(
  meta: SeoMetadata | undefined,
  scope: 'first-section' | 'overview',
  viewport: ViewportKey = 'desktop'
): string {
  const t = meta?.telemetry;
  if (!t) return '';
  if (scope === 'first-section') {
    const tap24 = viewport === 'mobile' && t.mobileSmallTapTargets24 !== undefined ? t.mobileSmallTapTargets24 : t.smallTapTargets24;
    const tap44 = viewport === 'mobile' && t.mobileSmallTapTargets44 !== undefined ? t.mobileSmallTapTargets44 : t.smallTapTargets44;
    const overflow = viewport === 'mobile' && t.mobileHorizontalOverflow !== undefined ? t.mobileHorizontalOverflow : t.horizontalOverflow;
    const fontPx = viewport === 'mobile' && t.mobileBodyFontPx !== undefined ? t.mobileBodyFontPx : t.bodyFontPx;
    const parts = [
      `Rendered H1s: ${t.renderedH1Count}`,
      `Rendered words: ${t.renderedWordCount}`,
      t.spaHydratedDiff ? 'SPA-hydrated: yes (trust screenshot over empty raw SSR HTML)' : null,
      fontPx ? `Body font: ${fontPx}px` : null,
      overflow ? 'Horizontal overflow: YES' : null,
      tap24 > 0 ? `Tap targets <24px: ${tap24}` : null,
      viewport === 'mobile' && tap44 > 0 ? `Tap targets <44px: ${tap44}` : null,
      t.contrastFailures.length > 0
        ? `Measured contrast failures (solid bg): ${t.contrastFailures.slice(0, 3).map((c) => `"${c.text.slice(0, 28)}" ${c.ratio}:1 (need ${c.required}:1)`).join('; ')}`
        : null,
    ].filter(Boolean);
    return parts.length ? `\nVERIFIED DOM MEASUREMENTS (use these exact figures instead of guessing):\n- ${parts.join('\n- ')}\n` : '';
  }

  const blockedBots = (t.origin?.aiBots ?? []).filter((b) => b.allowed === false).map((b) => b.bot);
  const parts = [
    meta?.canonical ? `Canonical: present (${meta.canonical.slice(0, 120)})` : 'Canonical: missing',
    meta?.robotsMeta ? `Meta robots: ${meta.robotsMeta}` : null,
    t.headers?.xRobotsTag ? `X-Robots-Tag: ${t.headers.xRobotsTag}` : null,
    meta?.viewportMeta ? 'Viewport meta: configured' : 'Viewport meta: MISSING',
    t.lang ? `HTML lang: ${t.lang}` : 'HTML lang: MISSING',
    t.brokenImages > 0 ? `Broken images (0px): ${t.brokenImages}` : null,
    t.jsonLdErrors > 0 ? `Invalid JSON-LD scripts: ${t.jsonLdErrors}` : null,
    t.headingOrderIssues.length > 0 ? `Heading issues: ${t.headingOrderIssues.slice(0, 3).join('; ')}` : null,
    t.unlabelledInputs > 0 ? `Unlabelled form fields: ${t.unlabelledInputs}/${t.formFieldCount}` : null,
    t.missingLandmarks.length > 0 ? `Missing HTML landmarks: ${t.missingLandmarks.join(', ')}` : null,
    t.origin
      ? `robots.txt: ${t.origin.robotsTxtPresent ? `present (${t.origin.sitemapCount} sitemap refs${blockedBots.length ? `; blocks ${blockedBots.join(', ')}` : '; allows major search & AI bots'})` : 'not found'}`
      : null,
    t.origin?.llmsTxtPresent ? 'llms.txt: present' : null,
    t.headers ? `Security headers: HSTS=${t.headers.hsts ? 'yes' : 'no'}, CSP=${t.headers.csp ? 'yes' : 'no'}` : null,
  ].filter(Boolean);
  return parts.length ? `\nVERIFIED TECHNICAL SEO, WCAG 2.2 & GEO SIGNALS:\n- ${parts.join('\n- ')}\n` : '';
}
