// Owner-approved paid comparison: sectioned full-page audit against the old single-image audit.
// Not part of `npm test`. Run ONLY with the owner's approval for that run.
//
//   node --import tsx tests/server/compare.manual.ts [desktop|mobile] --budget N --out DIR
//
//   0. Preflight (free): models.get on the audit and fallback model IDs checks the key and both
//      IDs without generating anything. If it fails, nothing else is sent.
//   1. capturePage(https://agricidaniel.com, viewport, fullpage), once. If the planned calls
//      (sections + overview + single image) exceed the budget, it stops before any model call.
//   2. auditPage on that image (sections with retries, then the overview).
//   3. The unchanged /api/audit/viewport route on the same full image as one picture, with a
//      240 s timeout (raised in this process only; the app's default stays 120 s).
//
// Hard budget: every generation request to the Gemini API in this process passes a fetch wrapper
// that counts it (fallbacks and retries included) and refuses any request past the budget. One
// request is reserved for step 3, so retries in step 2 cannot starve it. Any 400, 401, 403 or 404
// answer to a generation request stops every later request (key, model ID or request shape).
// The key comes only from the GEMINI_API_KEY environment variable. It is never printed, every
// string written is scrubbed of it, and the output folder is checked for it at the end.
//
// COMPARE_DRY_RUN=1 answers every Gemini request locally, for free. Dry-run knobs:
// COMPARE_DRY_PREFLIGHT_STATUS=404 fails the preflight; COMPARE_DRY_HANG_SECTION=2 makes the
// first attempt of section 2 hang until its timeout; COMPARE_DRY_SECTION_TIMEOUT_MS shortens it.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TARGET = 'https://agricidaniel.com';
const DRY_RUN = process.env.COMPARE_DRY_RUN === '1';

// ---- arguments ----------------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const viewport = (args.find((a) => a === 'desktop' || a === 'mobile') ?? 'desktop') as 'desktop' | 'mobile';
// --sectioned-only: skip step 3 (the single-image call), so no call is reserved for it. Speed
// variants set GEMINI_PAGE_AUDIT_THINKING, GEMINI_PAGE_AUDIT_CONCURRENCY and
// GEMINI_PAGE_SECTION_HEIGHT_DESKTOP or _MOBILE in the environment, one variant per fresh process.
const SECTIONED_ONLY = args.includes('--sectioned-only');
const BUDGET = Number(flag('--budget') ?? 9);
if (!Number.isInteger(BUDGET) || BUDGET < 2) {
  console.error('--budget must be a whole number of model calls, at least 2.');
  process.exit(2);
}
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const OUT = path.resolve(ROOT, flag('--out') ?? (DRY_RUN ? `.agent/tmp/compare-dry-run-${viewport}` : `.agent/results/compare-run-${viewport}-${stamp}`));
if (!DRY_RUN && existsSync(OUT) && readdirSync(OUT).length > 0) {
  console.error(`${path.relative(ROOT, OUT)} already has files; choose a new --out so no earlier run is overwritten.`);
  process.exit(2);
}

const KEY = process.env.GEMINI_API_KEY ?? '';
if (!KEY) {
  console.error('GEMINI_API_KEY is not set for this command. Nothing was sent.');
  process.exit(2);
}
const scrub = (s: unknown) => String(s).split(KEY).join('[redacted]');

// ---- budgeted fetch -----------------------------------------------------------------------------

interface CallRecord {
  n: number;
  phase: string;
  purpose: string;
  model: string;
  mediaResolutionAsked: string[];
  thinkingLevelAsked: string | null;
  noDashRuleSent: boolean;
  requestImageBytes: number;
  httpStatus: number | null;
  ms: number;
  finishReason: string | null;
  modelVersion: string | null;
  usage: unknown;
  error: string | null;
}
const calls: CallRecord[] = [];
const preflight: { model: string; httpStatus: number | null; error: string | null }[] = [];
const refused: string[] = [];
let sent = 0;
let phase = 'preflight';
let phaseCap = BUDGET; // during the sectioned audit: BUDGET - 1, keeping one call for the single image
let stopReason: string | null = null;

function dryAnswer(url: string, purpose: string, init: any): Promise<Response> {
  const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (!url.includes(':generateContent')) {
    const status = Number(process.env.COMPARE_DRY_PREFLIGHT_STATUS || 200);
    return Promise.resolve(status === 200 ? json({ name: 'models/dry' }) : json({ error: { code: status, message: 'dry-run model not found' } }, status));
  }
  const hang = process.env.COMPARE_DRY_HANG_SECTION;
  if (hang && purpose === `section ${hang}/${purpose.split('/')[1]}` && !calls.some((c) => c.purpose === purpose && c.n < sent)) {
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  }
  const item = { current_text: 'Dry run', visual_description: 'x', context: 'Dry', seo_analysis: 'x', suggested_optimization: 'x', severity: 'warning', category: 'Clarity', impact_score: 50, effort_estimate: 'quick-win', element_type: 'text', box_2d: [100, 100, 300, 500] };
  const fit = { passes_5s_test: true, visitor_understands: 'x', primary_distraction: 'x', single_biggest_lift: 'x' };
  const scores = { clarity: 1, visual_hierarchy: 1, conversion: 1, trust_eeat: 1 };
  const payload =
    purpose === 'overview' ? { overall_summary: 'dry', strategic_advisor: 'dry', scores, section_labels: [] }
      : purpose.startsWith('section 1/') ? { items: [item], first_impression_test: fit, attention_hotspots: [] }
        : purpose.startsWith('section') ? { items: [item] }
          : { overall_summary: 'dry', strategic_advisor: 'dry', first_impression_test: fit, scores, items: [item], attention_hotspots: [] };
  return Promise.resolve(json({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(payload) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 0 }, modelVersion: 'dry-run' }));
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url: string = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input, init);
  const model = /models\/([^:/?]+)/.exec(url)?.[1] ?? 'unknown';

  // Preflight: model metadata only, generates nothing, not counted against the budget.
  if (!url.includes(':generateContent')) {
    const rec = { model, httpStatus: null as number | null, error: null as string | null };
    preflight.push(rec);
    try {
      const res = DRY_RUN ? await dryAnswer(url, 'preflight', init) : await realFetch(input, init);
      rec.httpStatus = res.status;
      if (!res.ok) rec.error = scrub((await res.clone().text()).slice(0, 300));
      return res;
    } catch (err) {
      rec.error = scrub((err as Error)?.message ?? err).slice(0, 300);
      throw err;
    }
  }

  if (stopReason) {
    refused.push(`${phase}: refused after ${stopReason}`);
    throw new Error(`Refused by the compare budget: ${stopReason}`);
  }
  if (sent >= phaseCap) {
    refused.push(`${phase}: refused, the ${phase === 'sectioned' ? 'sectioned audit used its share' : 'budget'} of ${phaseCap} calls`);
    throw new Error(`Refused by the compare budget: ${phaseCap} calls already sent.`);
  }
  const n = ++sent;

  let purpose = 'unknown';
  const asked: string[] = [];
  let imageBytes = 0;
  let thinking: string | null = null;
  let noDash = false;
  try {
    const body = JSON.parse(String(init?.body ?? '{}'));
    thinking = body.generationConfig?.thinkingConfig?.thinkingLevel ?? null;
    noDash = JSON.stringify(body.systemInstruction ?? '').includes('never use em dashes or en dashes');
    for (const c of body.contents ?? []) {
      for (const p of c.parts ?? []) {
        if (p.inlineData?.data) {
          imageBytes += Math.floor((p.inlineData.data.length * 3) / 4);
          asked.push(p.mediaResolution?.level ?? 'default');
        }
        if (typeof p.text === 'string' && purpose === 'unknown') {
          const m = /^Audit section (\d+) of (\d+)/.exec(p.text);
          purpose = m ? `section ${m[1]}/${m[2]}` : p.text.startsWith('This image is a downscaled picture') ? 'overview' : p.text.startsWith('Perform a rigorous') ? 'single image' : p.text.slice(0, 40);
        }
      }
    }
  } catch {
    // unreadable body: recorded as unknown
  }

  const rec: CallRecord = { n, phase, purpose, model, mediaResolutionAsked: asked, thinkingLevelAsked: thinking, noDashRuleSent: noDash, requestImageBytes: imageBytes, httpStatus: null, ms: 0, finishReason: null, modelVersion: null, usage: null, error: null };
  calls.push(rec);
  console.log(`call ${n}/${BUDGET}: ${purpose} on ${model} (media ${asked.join(', ') || 'none'}, thinking ${thinking ?? 'default'})`);
  const started = Date.now();
  try {
    const res: Response = DRY_RUN ? await dryAnswer(url, purpose, init) : await realFetch(input, init);
    rec.ms = Date.now() - started;
    rec.httpStatus = res.status;
    try {
      const json: any = await res.clone().json();
      rec.finishReason = json?.candidates?.[0]?.finishReason ?? null;
      rec.modelVersion = json?.modelVersion ?? null;
      rec.usage = json?.usageMetadata ?? null;
      if (!res.ok) rec.error = scrub(JSON.stringify(json?.error ?? json).slice(0, 400));
    } catch {
      rec.error = res.ok ? null : `HTTP ${res.status}, unreadable body`;
    }
    if ([400, 401, 403, 404].includes(res.status)) stopReason = `call ${n} returned HTTP ${res.status}: ${rec.error ?? ''}`.slice(0, 400);
    return res;
  } catch (err) {
    rec.ms = Date.now() - started;
    rec.error = scrub((err as Error)?.name + ': ' + ((err as Error)?.message ?? err)).slice(0, 300);
    throw err;
  }
}) as typeof fetch;

// ---- run ----------------------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
process.env.VP_NO_AUTOSTART = '1';
process.env.NODE_ENV = 'production';
const { GoogleGenAI } = await import('@google/genai');
const { MODELS, TIMEOUTS, PAGE_AUDIT_THINKING_LEVEL } = await import('../../server/gemini.ts');
const { capturePage, closeBrowser } = await import('../../server/pageCapture.ts');
const { fetchPageMetadata } = await import('../../server/capture.ts');
const { fetchCapped } = await import('../../server/safeFetch.ts');
const { auditPage, planPageSections, PAGE_AUDIT_CONCURRENCY, PAGE_SECTION_HEIGHT } = await import('../../server/pageAudit.ts');
const { createServer } = await import('../../server.ts');
const { modelCallStats } = await import('../../server/gemini.ts');

const summary: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  target: TARGET,
  viewport,
  budget: BUDGET,
  sectionedOnly: SECTIONED_ONLY,
  thinkingLevel: PAGE_AUDIT_THINKING_LEVEL,
  concurrency: PAGE_AUDIT_CONCURRENCY,
  sectionHeight: PAGE_SECTION_HEIGHT[viewport],
  dryRun: DRY_RUN,
};
try {
  // 0. preflight
  const client = new GoogleGenAI({ apiKey: KEY });
  for (const model of [MODELS.audit, MODELS.auditFallback]) {
    try {
      await client.models.get({ model });
    } catch (err) {
      stopReason = `preflight failed for ${model}: ${scrub((err as Error)?.message ?? err).slice(0, 300)}`;
      break;
    }
  }
  if (stopReason) throw new Error(stopReason);

  // 1. capture once, plus the page HTML for checking quotes (no model calls)
  phase = 'capture';
  const shot = await capturePage(TARGET, viewport, 'fullpage');
  writeFileSync(path.join(OUT, 'page.jpg'), shot.image);
  const html = await fetchCapped(TARGET, { timeoutMs: 15_000, maxBytes: 5 * 1024 * 1024 });
  writeFileSync(path.join(OUT, 'page.html'), html.body);
  const { metadata } = await fetchPageMetadata(shot.finalUrl, 'agricidaniel.com');
  summary.capture = { width: shot.width, height: shot.height, bytes: shot.image.length, ms: shot.elapsedMs, truncated: shot.truncated, foldPx: shot.foldPx };
  const planned = planPageSections(shot.width, shot.height, PAGE_SECTION_HEIGHT[viewport]).length + (SECTIONED_ONLY ? 1 : 2);
  summary.plannedCalls = planned;
  if (planned > BUDGET) throw new Error(`planned ${planned} calls (sections, overview${SECTIONED_ONLY ? '' : ', single image'}) exceed the budget of ${BUDGET}; nothing was sent.`);

  // 2. sectioned audit; unless sectioned-only, one call stays reserved for the single image
  phase = 'sectioned';
  phaseCap = SECTIONED_ONLY ? BUDGET : BUDGET - 1;
  const t2 = Date.now();
  let sectioned: any = null;
  try {
    const dryTimeout = DRY_RUN && process.env.COMPARE_DRY_SECTION_TIMEOUT_MS ? Number(process.env.COMPARE_DRY_SECTION_TIMEOUT_MS) : undefined;
    sectioned = await auditPage(
      { image: shot.image, width: shot.width, height: shot.height, viewport, url: shot.finalUrl, metadata, auditGoal: 'general', foldPx: shot.foldPx },
      { sectionTimeoutMs: dryTimeout }
    );
  } catch (err) {
    summary.sectionedError = scrub((err as Error)?.message ?? err);
  }
  summary.sectionedMs = Date.now() - t2;
  if (sectioned) writeFileSync(path.join(OUT, 'audit-sectioned.json'), scrub(JSON.stringify(sectioned, null, 2)));

  // 3. the existing viewport route on the same full image as one picture, 240 s
  phase = 'single';
  phaseCap = BUDGET;
  let single: any = null;
  if (SECTIONED_ONLY) {
    summary.single = 'skipped: --sectioned-only';
  } else if (!stopReason) {
    (TIMEOUTS as { json: number }).json = 240_000; // this process only
    const app = await createServer({ listen: false });
    const srv = app!.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const port = (srv.address() as AddressInfo).port;
    const t3 = Date.now();
    const res = await realFetch(`http://127.0.0.1:${port}/api/audit/viewport`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screenshotDataUrl: `data:image/jpeg;base64,${shot.image.toString('base64')}`, viewport, url: shot.finalUrl, metadata, auditGoal: 'general' }),
      signal: AbortSignal.timeout(600_000),
    });
    single = await res.json();
    summary.singleMs = Date.now() - t3;
    summary.singleStatus = res.status;
    writeFileSync(path.join(OUT, 'audit-single.json'), scrub(JSON.stringify(single, null, 2)));
    srv.close();
  } else {
    summary.single = `skipped: ${stopReason}`;
  }

  // annotated copies
  await annotate(shot.image, shot.width, shot.height, (sectioned?.items ?? []).map((f: any) => f.box_px ?? null), sectioned?.items ?? [], 'annotated-sectioned.jpg', sectioned?.sections ?? []);
  const singleBoxes = (single?.items ?? []).map((f: any) => {
    const b = f.box_2d;
    if (!b || f.element_type === 'abstract') return null;
    return [(b[0] / 1000) * shot.height, (b[1] / 1000) * shot.width, (b[2] / 1000) * shot.height, (b[3] / 1000) * shot.width];
  });
  await annotate(shot.image, shot.width, shot.height, singleBoxes, single?.items ?? [], 'annotated-single.jpg', []);
} catch (err) {
  summary.stopped = scrub((err as Error)?.message ?? err);
} finally {
  await closeBrowser();
}

summary.preflight = preflight;
summary.serverModelCalls = modelCallStats(); // the server's own VP_MODEL_CALL_BUDGET counter
summary.callsSent = sent;
summary.refused = refused;
summary.stopReason = stopReason;
summary.calls = calls;
writeFileSync(path.join(OUT, 'calls.json'), scrub(JSON.stringify(summary, null, 2)));

// Last guard: no file in the output folder may contain the key.
const leaked = readdirSync(OUT).filter((f) => readFileSync(path.join(OUT, f)).includes(KEY));
console.log(JSON.stringify({ out: path.relative(ROOT, OUT), callsSent: sent, budget: BUDGET, refused: refused.length, stopped: summary.stopped ?? null, keyFoundInOutputFiles: leaked.length > 0 }, null, 2));

async function annotate(image: Buffer, w: number, h: number, boxes: (number[] | null)[], items: any[], name: string, sections: any[]) {
  const colour: Record<string, string> = { critical: '#e11d48', warning: '#f59e0b', info: '#2563eb' };
  const parts: string[] = [];
  for (const s of sections) {
    parts.push(`<line x1="0" y1="${s.yStart}" x2="${w}" y2="${s.yStart}" stroke="#10b981" stroke-width="3" stroke-dasharray="18 10"/>`);
    parts.push(`<text x="${w - 12}" y="${s.yStart + 34}" text-anchor="end" font-family="sans-serif" font-size="26" font-weight="700" fill="#10b981">S${s.index + 1} ${escapeXml(s.label ?? '')}</text>`);
  }
  boxes.forEach((b, i) => {
    if (!b) return;
    const [y0, x0, y1, x1] = b;
    const c = colour[items[i]?.severity] ?? '#111';
    parts.push(`<rect x="${x0}" y="${y0}" width="${Math.max(1, x1 - x0)}" height="${Math.max(1, y1 - y0)}" fill="none" stroke="${c}" stroke-width="4"/>`);
    parts.push(`<rect x="${x0}" y="${Math.max(0, y0 - 34)}" width="46" height="34" fill="${c}"/>`);
    parts.push(`<text x="${x0 + 23}" y="${Math.max(0, y0 - 34) + 26}" text-anchor="middle" font-family="sans-serif" font-size="24" font-weight="700" fill="#fff">${i + 1}</text>`);
  });
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${parts.join('')}</svg>`);
  await sharp(image, { limitInputPixels: false }).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 82 }).toFile(path.join(OUT, name));
}

function escapeXml(s: string) {
  return String(s).replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch]!);
}
