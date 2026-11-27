// Em and en dashes: the cleanup itself, and that it reaches every text-producing route.
// Dash characters are built from code points so this file contains none.
import './legacySettings.ts'; // first: pins 1,800 px sections, 3 at once, medium (see the file)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { Server } from 'node:http';
import { cleanDashes, cleanModelText, createDashStreamCleaner } from '../../server/normalize.ts';
import { generateJson } from '../../server/gemini.ts';
import { pngBytes } from './fixtures.ts';

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const hasDash = (s: string) => s.includes(EM) || s.includes(EN);

test('cleanDashes: between words a comma, numeric ranges "to", line edges removed', () => {
  const cases: [string, string][] = [
    [`Fast${EM}and clear`, 'Fast, and clear'],
    [`Fast ${EM} clear`, 'Fast, clear'],
    [`Fast ${EN} clear`, 'Fast, clear'],
    [`pages 10${EN}20`, 'pages 10 to 20'],
    [`2020 ${EN} 2024`, '2020 to 2024'],
    [`$10${EN}$20 a month`, '$10 to $20 a month'],
    [`${EM} Item one\n${EM} Item two`, 'Item one\nItem two'],
    [`Strong proof ${EM}.`, 'Strong proof.'],
    [`It works, ${EM} mostly`, 'It works, mostly'],
    [`(${EM} aside)`, '(aside)'],
    ['A well-known, -5 hyphen stays', 'A well-known, -5 hyphen stays'],
    ['No dashes here.', 'No dashes here.'],
  ];
  for (const [input, want] of cases) assert.equal(cleanDashes(input), want, JSON.stringify(input));
});

test('cleanModelText cleans every string except quotes of the page, code and links', () => {
  const raw = {
    overall_summary: `Clear ${EM} mostly`,
    items: [{ current_text: `Plans ${EN} pricing`, seo_analysis: `Weak${EM}fix it`, standards_violated: [`WCAG 1.4.3 ${EM} contrast`] }],
    code: `<p>a ${EM} b</p>`,
    competitors: [{ url: `https://x.test/a${EM}b`, strength: `Fast ${EN} cheap` }],
    impact_score: 80,
    flag: true,
  };
  const out = cleanModelText(raw);
  assert.equal(out.overall_summary, 'Clear, mostly');
  assert.equal(out.items[0].current_text, `Plans ${EN} pricing`);
  assert.equal(out.items[0].seo_analysis, 'Weak, fix it');
  assert.deepEqual(out.items[0].standards_violated, ['WCAG 1.4.3, contrast']);
  assert.equal(out.code, raw.code);
  assert.equal(out.competitors[0].url, raw.competitors[0].url);
  assert.equal(out.competitors[0].strength, 'Fast, cheap');
  assert.equal(out.impact_score, 80);
  assert.equal(out.flag, true);
});

test('the stream cleaner gives the same text as one-shot cleaning, wherever the chunks split', () => {
  const full = `Start here ${EM} then fix the hero.\n${EM} Bullet one\nPages 3${EN}5 are thin${EM}rewrite them ${EM}`;
  const want = cleanDashes(full);
  for (let i = 0; i <= full.length; i++) {
    for (let j = i; j <= full.length; j += 3) {
      const c = createDashStreamCleaner();
      const got = c.push(full.slice(0, i)) + c.push(full.slice(i, j)) + c.push(full.slice(j)) + c.flush();
      assert.equal(got, want, `split at ${i}, ${j}`);
    }
  }
});

test('generateJson returns cleaned fields but keeps current_text and the raw text exact', async () => {
  const body = { items: [{ current_text: `A ${EM} B`, context: `Hero ${EM} headline` }] };
  const ai = { models: { generateContent: async () => ({ text: JSON.stringify(body), candidates: [{ finishReason: 'STOP' }] }) } };
  const { result, rawText } = await generateJson({ ai, models: ['m'], prompt: 'x' });
  assert.equal(result.items[0].current_text, `A ${EM} B`);
  assert.equal(result.items[0].context, 'Hero, headline');
  assert.ok(hasDash(rawText));
});

test('VP_DEBUG_RAW=1 saves the raw answer (dashes intact) per call; off by default nothing is written', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vp-raw-'));
  const text = JSON.stringify({ context: `Hero ${EM} headline` });
  const ai = { models: { generateContent: async () => ({ text, candidates: [{ finishReason: 'STOP' }] }) } };
  process.env.VP_DEBUG_RAW_DIR = dir;
  try {
    delete process.env.VP_DEBUG_RAW;
    await generateJson({ ai, models: ['m-off'], prompt: 'x', label: 'off' });
    assert.deepEqual(await readdir(dir), []);

    process.env.VP_DEBUG_RAW = '1';
    const { result } = await generateJson({ ai, models: ['gemini-test'], prompt: 'x', label: 'page-section-2' });
    assert.equal(result.context, 'Hero, headline');
    const [run] = await readdir(dir);
    const files = await readdir(path.join(dir, run));
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{4}-page-section-2-gemini-test\.txt$/);
    assert.equal(await readFile(path.join(dir, run, files[0]), 'utf8'), text);
  } finally {
    delete process.env.VP_DEBUG_RAW;
    delete process.env.VP_DEBUG_RAW_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- routes, in process, with the Gemini API answered by a local fake ---------------------------

let server: Server;
let base = '';
const realFetch = globalThis.fetch;
const sent: { url: string; body: any }[] = [];

const reply = (text: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] }), {
    headers: { 'content-type': 'application/json' },
  });

before(async () => {
  process.env.VP_NO_AUTOSTART = '1';
  process.env.NODE_ENV = 'production';
  process.env.GEMINI_API_KEY = 'test-key-not-real';
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input, init);
    const body = JSON.parse(String(init?.body ?? '{}'));
    sent.push({ url, body });
    if (url.includes(':streamGenerateContent')) {
      const chunks = [`Fix the hero ${EM}`, ` it is vague. Pages 3${EN}`, `5 are thin ${EM}`];
      const sse = chunks.map((t) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] })}\n\n`).join('');
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.includes('tts')) {
      const audio = { inlineData: { mimeType: 'audio/L16;rate=24000', data: Buffer.alloc(480).toString('base64') } };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [audio] }, finishReason: 'STOP' }] }), { headers: { 'content-type': 'application/json' } });
    }
    const prompt = JSON.stringify(body.contents);
    if (prompt.includes('Research the live market')) {
      return reply(JSON.stringify({ niche_summary: `AI tools ${EM} for marketers`, positioning_verdict: 'ok', competitors: [{ name: 'X', url: 'https://x.test/', value_prop_hook: `Fast ${EN} cheap`, strength: 's', opportunity_gap: 'g' }], keyword_opportunities: [`seo ${EM} audit`], eeat_gaps: [], quick_differentiators: [] }));
    }
    if (prompt.includes('executive spoken briefing')) return reply(`Your page scores 70 ${EM} solid. Fix the hero in 1${EN}2 days.`);
    // viewport audit
    return reply(JSON.stringify({
      overall_summary: `Clear page ${EM} weak proof`, strategic_advisor: `Ship ${EN} then test`,
      first_impression_test: { passes_5s_test: true, visitor_understands: `Tools ${EM} free`, primary_distraction: 'none', single_biggest_lift: 'cta' },
      scores: { clarity: 70, visual_hierarchy: 70, conversion: 70, trust_eeat: 70 },
      items: [{ current_text: `Build ${EM} ship`, visual_description: 'Hero', context: `Hero ${EM} headline`, seo_analysis: `Vague${EM}rewrite`, suggested_optimization: 'x', severity: 'warning', category: 'Clarity', impact_score: 60, effort_estimate: 'quick-win', element_type: 'text', box_2d: [100, 100, 300, 500] }],
      attention_hotspots: [],
    }));
  }) as typeof fetch;
  const { createServer } = await import('../../server.ts');
  const app = await createServer({ listen: false });
  server = app!.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
  globalThis.fetch = realFetch;
});

const post = (route: string, body: unknown) =>
  realFetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('routes: viewport audit, SERP research, chat stream and audio brief come back without dashes', async () => {
  const png = `data:image/png;base64,${pngBytes(1440, 900).toString('base64')}`;

  const audit = await (await post('/api/audit/viewport', { screenshotDataUrl: png, viewport: 'desktop' })).json();
  assert.equal(audit.overall_summary, 'Clear page, weak proof');
  assert.equal(audit.items[0].seo_analysis, 'Vague, rewrite');
  assert.equal(audit.items[0].current_text, `Build ${EM} ship`); // a quote of the page stays exact
  const { current_text, ...rest } = audit.items[0];
  assert.ok(!hasDash(JSON.stringify({ ...audit, items: [rest] })));

  const serp = await (await post('/api/serp-research', { url: 'https://example.com', summary: 's' })).json();
  assert.equal(serp.niche_summary, 'AI tools, for marketers');
  assert.ok(!hasDash(JSON.stringify(serp)));

  const chat = await (await post('/api/chat', { messages: [{ role: 'user', content: 'hi' }] })).text();
  const streamed = chat.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)).text ?? '').join('');
  assert.equal(streamed, 'Fix the hero, it is vague. Pages 3 to 5 are thin');

  const brief = await (await post('/api/audio-brief', { domain: 'example.com' })).json();
  assert.equal(brief.script, 'Your page scores 70, solid. Fix the hero in 1 to 2 days.');
  const ttsReq = sent.find((s) => s.url.includes('tts'));
  assert.ok(ttsReq && ttsReq.url.includes('/v1beta/'), `TTS request must target v1beta, got: ${ttsReq?.url}`);

  // Every text request asked for no dashes in its system instruction.
  const textCalls = sent.filter((s) => !s.url.includes('tts'));
  assert.equal(textCalls.length, 4);
  for (const s of textCalls) assert.match(JSON.stringify(s.body.systemInstruction ?? s.body.system_instruction), /never use em dashes or en dashes/);
});

test('/api/audit/page returns stats and top_priorities (the fake overview ranks nothing, so it says so)', async () => {
  const real = await sharp({ create: { width: 1440, height: 4000, channels: 3, background: '#999' } }).png().toBuffer();
  const tall = `data:image/png;base64,${real.toString('base64')}`;
  const res = await post('/api/audit/page', { screenshotDataUrl: tall, viewport: 'desktop', foldPx: 900 });
  assert.equal(res.status, 200);
  const audit = await res.json();
  assert.equal(audit.mode, 'fullpage');
  assert.equal(audit.stats.calls, audit.sections.length + 1);
  assert.equal(audit.stats.retries, 0);
  assert.equal(audit.stats.concurrency, 3);
  assert.equal(audit.stats.thinkingLevel, 'MEDIUM');
  assert.equal(audit.stats.sections.length, audit.sections.length);
  assert.deepEqual(audit.top_priorities, []);
  assert.match(audit.warnings.join(' '), /did not rank any listed finding/);
  assert.ok(!hasDash(JSON.stringify(audit.items.map(({ current_text, ...r }: any) => r))));
});

test('every text request so far carried the no-dash rule', () => {
  const textCalls = sent.filter((s) => !s.url.includes('tts'));
  for (const s of textCalls) assert.match(JSON.stringify(s.body.systemInstruction ?? s.body.system_instruction), /never use em dashes or en dashes/);
});

test('static source scan: zero em dashes or en dashes across source files and prompts', async () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const dirs = ['server', 'components', 'lib', 'services', 'utils'];
  const files = ['server.ts', 'App.tsx', 'types.ts', 'AGENTS.md', 'README.md', '.env.example'].map((f) => path.join(root, f));

  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(ts|tsx|md)$/.test(entry.name)) files.push(full);
    }
  };
  for (const d of dirs) await walk(path.join(root, d));

  const offenders: string[] = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    if (hasDash(content)) offenders.push(path.relative(root, file));
  }
  assert.deepEqual(offenders, [], `Found em/en dashes in: ${offenders.join(', ')}`);
});
