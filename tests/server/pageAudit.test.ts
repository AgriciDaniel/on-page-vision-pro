// Full-page audit pipeline with a fake model: real slicing (sharp), real mapping and dedupe,
// no Gemini calls. The synthetic page is 1440 x 15,000 px with a vertical grey gradient, so the
// fake model can check that every slice it receives starts at the planned y.
import './legacySettings.ts'; // first: pins 1,800 px sections, 3 at once, medium (see the file)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  applyPriorities,
  auditPage,
  firstSectionPrompt,
  planPageSections,
  readIntSetting,
  sectionPrompt,
  MIN_BOX_PX,
  PAGE_AUDIT_CONCURRENCY,
  type PageAuditRequest,
} from '../../server/pageAudit.ts';
import type { AuditFinding } from '../../types.ts';

const W = 1440;
const H = 15_000;
const BAND = 60; // grey value steps every 60 rows
const greyAt = (y: number) => Math.floor(y / BAND) % 250;
let image: Buffer;

before(async () => {
  const raw = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) raw.fill(greyAt(y), y * W, (y + 1) * W);
  image = await sharp(raw, { raw: { width: W, height: H, channels: 1 } }).jpeg({ quality: 90 }).toBuffer();
});

/** Elements on the page, in image px. */
interface Physical { y0: number; x0: number; y1: number; x1: number; text: string; category: string }

function physicalElements(): Physical[] {
  const sections = planPageSections(W, H);
  const els: Physical[] = [{ y0: 100, x0: 144, y1: 400, x1: 1296, text: 'Hero headline', category: 'Clarity' }];
  // One element straddling every seam: it starts 8% of a section above the seam and ends 10% below.
  for (let i = 0; i < sections.length - 1; i++) {
    const s = sections[i];
    els.push({ y0: s.yEnd - 0.08 * s.height, x0: 144, y1: s.yEnd + 0.1 * s.height, x1: 720, text: `Seam block ${i}`, category: 'Trust' });
  }
  els.push({ y0: 12_000, x0: 200, y1: 12_003, x1: 600, text: 'Hairline', category: 'Visual Hierarchy' }); // 3 px tall
  return els;
}

interface FakeOptions { failSections?: number[]; failOverview?: boolean }

function fakeModel(opts: FakeOptions = {}) {
  const els = physicalElements();
  const prompts: { index: number; text: string }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const errors: string[] = [];
  const ai = {
    models: {
      async generateContent(req: any) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await new Promise((r) => setTimeout(r, 15));
          const [imgPart, textPart] = req.contents.parts;
          const text: string = textPart.text;
          const buf = Buffer.from(imgPart.inlineData.data, 'base64');
          const meta = await sharp(buf).metadata();

          if (text.startsWith('This image is a downscaled picture')) {
            if (imgPart.mediaResolution?.level !== 'MEDIA_RESOLUTION_LOW') errors.push('overview not LOW resolution');
            if (meta.width! > 1536 || meta.height! > 1536) errors.push(`overview too big ${meta.width}x${meta.height}`);
            if (!/cut into 3 columns placed side by side/.test(text)) errors.push('overview prompt does not explain the 3 columns');
            if (opts.failOverview) throw Object.assign(new Error('overloaded'), { status: 503 });
            const n = planPageSections(W, H).length;
            return ok({
              overall_summary: 'Whole page summary.',
              strategic_advisor: 'Roadmap.',
              scores: { clarity: 80, visual_hierarchy: 60, conversion: 70, trust_eeat: 90 },
              section_labels: Array.from({ length: n }, (_, i) => ({ index: i, label: `Label ${i}` })),
              // F1 is the page-wide schema issue (the only provisional critical, so listed first).
              top_priorities: [
                { finding: 'F3', rank: 2, reason: 'Second', blocker: false },
                { finding: 'F1', rank: 1, reason: 'Missing schema hurts indexing', blocker: true },
                { finding: 'F999', rank: 3, reason: 'Invented', blocker: true },
                { finding: 'F1', rank: 4, reason: 'Duplicate', blocker: false },
                { finding: 'F2', rank: 5, reason: 'Third', blocker: false },
              ],
            });
          }

          const m = /^Audit section (\d+) of (\d+)/.exec(text);
          if (!m) throw new Error('unexpected prompt');
          const index = Number(m[1]) - 1;
          prompts.push({ index, text });
          if (imgPart.mediaResolution?.level !== 'MEDIA_RESOLUTION_HIGH') errors.push(`section ${index} not HIGH resolution`);
          if (opts.failSections?.includes(index)) throw Object.assign(new Error('internal'), { status: 500 });

          const s = planPageSections(W, H)[index];
          if (meta.width !== W || meta.height !== s.height) errors.push(`section ${index} is ${meta.width}x${meta.height}, planned ${W}x${s.height}`);
          // Gradient check: a row in the middle of a grey band must have that band's value.
          const off = ((BAND / 2 - (s.yStart % BAND)) + BAND) % BAND;
          const { data } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
          const got = data[off * W + 700];
          if (Math.abs(got - greyAt(s.yStart + off)) > 3) errors.push(`section ${index} starts at the wrong y (grey ${got}, expected ${greyAt(s.yStart + off)})`);

          const toUnits = (v: number) => Math.round(((v - s.yStart) / s.height) * 10000) / 10; // 0.1-unit precision
          const items: any[] = els
            .filter((e) => e.y1 > s.yStart && e.y0 < s.yEnd)
            .map((e) => ({
              current_text: e.text,
              visual_description: e.text,
              context: e.text,
              seo_analysis: `About ${e.text}`,
              suggested_optimization: 'Fix it',
              severity: 'warning',
              category: e.category,
              impact_score: 60,
              effort_estimate: 'quick-win',
              element_type: 'text',
              box_2d: [toUnits(Math.max(e.y0, s.yStart)), (e.x0 / W) * 1000, toUnits(Math.min(e.y1, s.yEnd)), (e.x1 / W) * 1000],
            }));
          items.push({
            current_text: 'N/A', visual_description: 'Page', context: 'Missing schema', seo_analysis: 'No schema',
            suggested_optimization: 'Add JSON-LD', severity: index === 4 ? 'critical' : 'info', category: 'On-Page SEO',
            impact_score: 50, effort_estimate: 'medium', element_type: 'abstract', box_2d: [0, 0, 0, 0],
          });
          const out: any = { items };
          if (index === 0) {
            out.first_impression_test = { passes_5s_test: true, visitor_understands: 'It is a tool.', primary_distraction: 'None', single_biggest_lift: 'Bigger CTA' };
            out.attention_hotspots = [
              { x: 500, y: 300, radius: 120, intensity: 90, rank: 1, label: 'Headline' },
              { x: 300, y: 900, radius: 80, intensity: 70, rank: 2, label: 'Below the fold' },
            ];
          }
          return ok(out);
        } finally {
          inFlight--;
        }
      },
    },
  };
  return { ai, prompts, errors, maxInFlight: () => maxInFlight };
}

const ok = (obj: unknown) => ({ text: JSON.stringify(obj), candidates: [{ finishReason: 'STOP' }] });

const request = (): PageAuditRequest => ({
  image, width: W, height: H, viewport: 'desktop', url: 'https://example.com/', auditGoal: 'general', foldPx: 900,
});

test('section plan for a 1440 x 15,000 page: 10 overlapping 1,800 px sections', () => {
  const s = planPageSections(W, H);
  assert.equal(s.length, 10);
  assert.equal(s[0].yStart, 0);
  assert.equal(s[s.length - 1].yEnd, H);
  for (let i = 1; i < s.length; i++) assert.ok(s[i].yStart < s[i - 1].yEnd, 'sections overlap');
  // Very tall pages stretch sections instead of exceeding 16 calls.
  assert.ok(planPageSections(780, 30_000).length <= 16);
});

test('whole pipeline: slices, maps, dedupes and shapes the response per the contract', async () => {
  const fake = fakeModel();
  const audit = await auditPage(request(), { ai: fake.ai });
  assert.deepEqual(fake.errors, []);
  assert.ok(fake.maxInFlight() <= 3, `max in flight ${fake.maxInFlight()}`);
  assert.equal(fake.prompts.length, 10);

  assert.equal(audit.mode, 'fullpage');
  assert.deepEqual(audit.image, { width: W, height: H });
  assert.equal(audit.sections!.length, 10);
  assert.equal(audit.sections![3].label, 'Label 3');
  assert.deepEqual(audit.warnings, []);
  assert.equal(audit.overall_summary, 'Whole page summary.');
  assert.equal(audit.scores.overall, 75);

  // Every real element exactly once, at its true position; the 3 px hairline is dropped.
  const expected = physicalElements().filter((e) => e.y1 - e.y0 >= MIN_BOX_PX);
  const boxed = audit.items.filter((i) => i.element_type !== 'abstract');
  assert.deepEqual(boxed.map((i) => i.current_text).sort(), expected.map((e) => e.text).sort());
  for (const e of expected) {
    const f = boxed.find((i) => i.current_text === e.text)!;
    const [y0, x0, y1, x1] = f.box_px!;
    for (const [got, want] of [[y0, e.y0], [x0, e.x0], [y1, e.y1], [x1, e.x1]]) {
      assert.ok(Math.abs(got - want) <= 1, `${e.text}: ${f.box_px} vs ${[e.y0, e.x0, e.y1, e.x1]}`);
    }
    // box_2d is on the FULL image, 0 to 1000, decimals kept.
    assert.ok(Math.abs(f.box_2d![0] - (e.y0 / H) * 1000) < 0.1);
    assert.equal(typeof f.section_index, 'number');
  }
  assert.ok(boxed.some((f) => !Number.isInteger(f.box_2d![0])), 'box_2d keeps decimals');

  // The page-wide issue that every section repeated is kept once; the overview ranked it first
  // as a blocker, so it is the one critical finding.
  const abstract = audit.items.filter((i) => i.element_type === 'abstract');
  assert.equal(abstract.length, 1);
  assert.equal(abstract[0].severity, 'critical');
  assert.equal(audit.critical_count, 1);

  // top_priorities: invented F999 and the duplicate F1 are ignored; ranks are renumbered 1 to 3.
  const tp = audit.top_priorities!;
  assert.deepEqual(tp.map((p) => [p.rank, p.reason, p.blocker]), [[1, 'Missing schema hurts indexing', true], [2, 'Second', false], [3, 'Third', false]]);
  assert.equal(tp[0].finding_id, abstract[0].id);
  const ids = new Set(audit.items.map((i) => i.id));
  assert.ok(tp.every((p) => ids.has(p.finding_id)));
  assert.equal(audit.stats!.concurrency, 3);

  // First impression and hotspots from section 0 only; hotspot y on the full image, capped at the fold.
  assert.equal(audit.first_impression_test?.passes_5s_test, true);
  assert.equal(audit.attention_hotspots!.length, 2);
  assert.equal(audit.attention_hotspots![0].y, 36); // 300/1000 of 1,800 px = 540 px; 540/15,000
  assert.equal(audit.attention_hotspots![1].y, 60); // 1,620 px is below the 900 px fold, so capped at 900
  assert.equal(audit.attention_hotspots![0].radius, 120);
});

test('only the first section talks about the fold or the first five seconds', async () => {
  const fake = fakeModel();
  await auditPage(request(), { ai: fake.ai });
  const banned = /fold|5[- ]?second|five second|first impression|first screen|above the/i;
  for (const p of fake.prompts) {
    if (p.index === 0) {
      assert.match(p.text, /first screen/);
      assert.match(p.text, /y=900 px/);
    } else {
      assert.doesNotMatch(p.text, banned, `section ${p.index}`);
      assert.match(p.text, new RegExp(`^Audit section ${p.index + 1} of 10 `));
      assert.match(p.text, /% of the way down/);
    }
  }
});

test('a failing section becomes a warning; the rest of the audit stands', async () => {
  const fake = fakeModel({ failSections: [3] });
  const audit = await auditPage(request(), { ai: fake.ai });
  assert.equal(audit.warnings!.length, 1);
  assert.match(audit.warnings![0], /^Section 4 of 10 \(y 4,590 to 6,390 px\) could not be audited \(after one retry\): The AI service returned an error \(status 500\)\.$/);
  assert.ok(audit.items.length > 5);
  assert.equal(audit.sections!.length, 10);
  // Section 4: primary 500, fallback 500, one retry on the primary 500 = 3 requests.
  assert.equal(audit.stats!.sections[3].attempts, 3);
  assert.equal(audit.stats!.retries, 1);
  assert.equal(audit.stats!.calls, 9 + 3 + 1);
});

// ---- tuning round: retry, timer start, thinking cap, prompt rules, dashes -----------------------

/** A small fake for timing tests: 4 sections on a 1440 x 6,000 page. */
function scriptedModel(behaviour: (sectionIndex: number, attempt: number, req: any) => Promise<any>) {
  const attempts = new Map<number, number>();
  const requests: any[] = [];
  const ai = {
    models: {
      async generateContent(req: any) {
        requests.push(req);
        const text: string = req.contents.parts[1].text;
        const m = /^Audit section (\d+) of/.exec(text);
        if (!m) return ok({ overall_summary: 'Fine. Really', strategic_advisor: 'x', scores: {}, section_labels: [] });
        const index = Number(m[1]) - 1;
        const n = (attempts.get(index) ?? 0) + 1;
        attempts.set(index, n);
        return behaviour(index, n, req);
      },
    },
  };
  return { ai, requests };
}

const hangUntilAborted = (req: any) =>
  new Promise((_, reject) => {
    const signal: AbortSignal = req.config.abortSignal;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    // Keep Node 22's event loop alive until AbortSignal.timeout fires (unref'd on Node 22).
    const keepAlive = setTimeout(() => {}, 10_000);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(keepAlive);
        reject(signal.reason);
      },
      { once: true }
    );
  });

let small: Buffer;
before(async () => {
  small = await sharp({ create: { width: 1440, height: 6000, channels: 3, background: '#888' } }).jpeg().toBuffer();
});
const smallRequest = (): PageAuditRequest => ({ image: small, width: 1440, height: 6000, viewport: 'desktop', auditGoal: 'general' });
const noItems = (index: number) => ok(index === 0 ? { items: [], first_impression_test: {}, attention_hotspots: [] } : { items: [] });

test('a timed-out section is retried once and then stands; the retry is counted', async () => {
  const fake = scriptedModel(async (index, attempt, req) => (index === 1 && attempt === 1 ? hangUntilAborted(req) : noItems(index)));
  const audit = await auditPage(smallRequest(), { ai: fake.ai, sectionTimeoutMs: 100 });
  assert.equal(planPageSections(1440, 6000).length, 4);
  assert.deepEqual(audit.warnings, []);
  assert.equal(audit.stats!.retries, 1);
  assert.equal(audit.stats!.sections[1].attempts, 2); // a timeout gets no fallback, then one retry
  assert.equal(audit.stats!.sections[1].retried, true);
  assert.ok(audit.stats!.sections[1].ms >= 100);
  assert.equal(audit.stats!.calls, 4 + 1 + 1);
});

test('a 4xx error is not retried', async () => {
  const fake = scriptedModel(async (index) => {
    if (index === 2) throw Object.assign(new Error('bad request'), { status: 400 });
    return noItems(index);
  });
  const audit = await auditPage(smallRequest(), { ai: fake.ai });
  assert.equal(audit.stats!.retries, 0);
  assert.equal(audit.stats!.sections[2].attempts, 1);
  assert.match(audit.warnings![0], /^Section 3 of 4 .*could not be audited: /);
});

test('time spent queued behind the concurrency limit does not count against a call timeout', async () => {
  // Each call takes 80 ms; one at a time, the 4th section waits about 240 ms before it is sent.
  // With a 150 ms timeout that only works if each timer starts when its request is sent.
  const fake = scriptedModel(async (index) => {
    await new Promise((r) => setTimeout(r, 80));
    return noItems(index);
  });
  const audit = await auditPage(smallRequest(), { ai: fake.ai, concurrency: 1, sectionTimeoutMs: 150 });
  assert.deepEqual(audit.warnings, []);
  assert.equal(audit.stats!.retries, 0);
  assert.ok(audit.stats!.totalMs >= 320);
});

test('every page-audit request carries the thinking cap and the no-dash rule', async () => {
  const fake = scriptedModel(async (index) => noItems(index));
  const audit = await auditPage(smallRequest(), { ai: fake.ai });
  assert.equal(fake.requests.length, 5);
  for (const r of fake.requests) {
    assert.equal(r.config.thinkingConfig.thinkingLevel, 'MEDIUM');
    assert.match(r.config.systemInstruction, /never use em dashes or en dashes/);
    assert.match(r.config.systemInstruction, /^You are a principal CRO strategist/);
  }
  assert.equal(audit.stats!.thinkingLevel, 'MEDIUM');
});

test('section prompts: up to 6 findings, severity rubric, no grouping of unrelated small elements', () => {
  const s = planPageSections(1440, 6000);
  for (const prompt of [firstSectionPrompt(smallRequest(), s[0], 4, 900), sectionPrompt(smallRequest(), s[2], 4)]) {
    assert.match(prompt, /UP TO 6 findings/);
    assert.match(prompt, /only issues worth fixing/);
    assert.match(prompt, /only when it is notable/);
    assert.match(prompt, /minor label, eyebrow, caption/);
    assert.match(prompt, /"critical": it blocks the primary conversion, comprehension of the offer, or indexing/);
    assert.match(prompt, /Never put unrelated small elements into one box/);
    assert.doesNotMatch(prompt, /4 to 9|3 to 8/);
  }
});

test('a failing overview keeps the findings and warns that scores are defaults', async () => {
  const fake = fakeModel({ failOverview: true });
  const audit = await auditPage(request(), { ai: fake.ai });
  assert.equal(audit.overall_summary, '');
  assert.equal(audit.scores.clarity, 70);
  assert.equal(audit.sections![0].label, 'Section 1');
  assert.match(audit.warnings!.join(' '), /overview could not be written: .* severities are each section's own/);
  assert.ok(audit.items.length > 5);
  // Fallback: the sections' own severities stand (section 5 called the schema issue critical).
  assert.equal(audit.critical_count, 1);
  assert.deepEqual(audit.top_priorities, []);
});

// ---- page-level ranking -------------------------------------------------------------------------

const finding = (id: string, severity: 'critical' | 'warning' | 'info'): AuditFinding =>
  ({ id, severity, context: id, seo_analysis: 'x', impact_score: 50 }) as unknown as AuditFinding;

test('applyPriorities: critical only on ranked blockers, other criticals become warnings', () => {
  const items = [finding('a', 'critical'), finding('b', 'critical'), finding('c', 'warning'), finding('d', 'info'), finding('e', 'warning')];
  const out = applyPriorities(items, [
    { finding: 'F3', rank: 1, reason: 'Blocks the CTA', blocker: true },
    { finding: 'f1', rank: 2, reason: 'Hurts trust', blocker: false },
    { finding: 'F4', rank: 3, reason: 'Polish', blocker: false },
    { finding: 'G2', rank: 4, reason: 'bad ref', blocker: true },
    { finding: 'F0', rank: 5, reason: 'bad ref', blocker: true },
  ])!;
  const sev = Object.fromEntries(out.items.map((f) => [f.id, f.severity]));
  assert.deepEqual(sev, { a: 'warning', b: 'warning', c: 'critical', d: 'info', e: 'warning' });
  assert.deepEqual(out.priorities.map((p) => p.finding_id), ['c', 'a', 'd']);
  assert.equal(out.items[0].id, 'c', 'critical sorts first');
});

test('applyPriorities: keeps at most 5, and returns null when nothing usable remains', () => {
  const items = Array.from({ length: 8 }, (_, i) => finding(`x${i}`, 'warning'));
  const many = applyPriorities(items, items.map((_, i) => ({ finding: `F${i + 1}`, rank: 8 - i, reason: 'r', blocker: false })))!;
  assert.equal(many.priorities.length, 5);
  assert.deepEqual(many.priorities.map((p) => p.finding_id), ['x7', 'x6', 'x5', 'x4', 'x3']);
  assert.equal(applyPriorities(items, [{ finding: 'F42', rank: 1, reason: 'r', blocker: true }]), null);
  assert.equal(applyPriorities(items, undefined), null);
});

test('an overview that ranks only invented ids leaves section severities and says so', async () => {
  const fake = scriptedModel(async (index) =>
    ok(index === 0 ? { items: [rawItem('critical')], first_impression_test: {}, attention_hotspots: [] } : { items: [rawItem('warning')] })
  );
  const real = fake.ai.models.generateContent;
  fake.ai.models.generateContent = async (req: any) =>
    req.contents.parts[1].text.startsWith('This image is a downscaled')
      ? ok({ overall_summary: 's', strategic_advisor: 'a', scores: {}, section_labels: [], top_priorities: [{ finding: 'F77', rank: 1, reason: 'r', blocker: true }] })
      : real(req);
  const audit = await auditPage(smallRequest(), { ai: fake.ai });
  assert.equal(audit.critical_count, 1);
  assert.deepEqual(audit.top_priorities, []);
  assert.match(audit.warnings!.join(' '), /did not rank any listed finding/);
});

test('stats carry tokens per section, for the overview and in total, when the model reports usage', async () => {
  const usage = { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30, totalTokenCount: 150 };
  const fake = scriptedModel(async (index) => ({ ...noItems(index), usageMetadata: usage }));
  const real = fake.ai.models.generateContent;
  fake.ai.models.generateContent = async (req: any) => ({ ...(await real(req)), usageMetadata: usage });
  const audit = await auditPage(smallRequest(), { ai: fake.ai });
  assert.deepEqual(audit.stats!.sections[2].tokens, { prompt: 100, output: 20, thinking: 30, total: 150 });
  assert.deepEqual(audit.stats!.overview.tokens, { prompt: 100, output: 20, thinking: 30, total: 150 });
  assert.deepEqual(audit.stats!.tokens, { prompt: 500, output: 100, thinking: 150, total: 750 });
});

test('concurrency setting: the env value is used when valid, otherwise the measured default 3', () => {
  assert.equal(readIntSetting(undefined, 3, 1, 8), 3);
  assert.equal(readIntSetting('5', 3, 1, 8), 5);
  assert.equal(readIntSetting('0', 3, 1, 8), 3);
  assert.equal(readIntSetting('2.5', 3, 1, 8), 3);
  assert.equal(readIntSetting('many', 3, 1, 8), 3);
  assert.equal(PAGE_AUDIT_CONCURRENCY, 3);
});

function rawItem(severity: string) {
  return { current_text: 't', visual_description: 'v', context: 'c', seo_analysis: 's', suggested_optimization: 'o', severity, category: 'Clarity', impact_score: 50, effort_estimate: 'quick-win', element_type: 'text', box_2d: [100, 100, 400, 600] };
}

test('when every section fails, the audit fails with the upstream status', async () => {
  const fake = fakeModel({ failSections: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
  await assert.rejects(auditPage(request(), { ai: fake.ai }), (e: any) => e.status === 500);
});
