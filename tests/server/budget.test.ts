// VP_MODEL_CALL_BUDGET: a hard cap on model API requests per server process. The real SDK client
// from getAiClient() runs; only the network is faked (globalThis.fetch for the Gemini host), so
// fallbacks, streams and the page audit all go through the same counting fetch as production.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { resetModelCallCount } from '../../server/gemini.ts';

const FAKE_KEY = 'fake-key-for-budget-tests';
let server: Server;
let base = '';
const realFetch = globalThis.fetch;
let apiHits = 0;
let failPrimaryOnce = false;

const viewportAnswer = {
  overall_summary: 's', strategic_advisor: 'a',
  first_impression_test: { passes_5s_test: true, visitor_understands: 'v', primary_distraction: 'p', single_biggest_lift: 'l' },
  scores: { clarity: 70, visual_hierarchy: 70, conversion: 70, trust_eeat: 70 },
  items: [], attention_hotspots: [],
};

before(async () => {
  process.env.VP_NO_AUTOSTART = '1';
  process.env.NODE_ENV = 'production';
  process.env.GEMINI_API_KEY = FAKE_KEY;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input, init);
    apiHits++;
    if (failPrimaryOnce && url.includes('gemini-4-neon')) {
      failPrimaryOnce = false;
      return new Response(JSON.stringify({ error: { code: 503, message: 'overloaded', status: 'UNAVAILABLE' } }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes(':streamGenerateContent')) {
      return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hi.' }] } }] })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    const prompt = JSON.stringify(JSON.parse(String(init?.body ?? '{}')).contents);
    const answer = prompt.includes('Audit section') ? { items: [], first_impression_test: {}, attention_hotspots: [] } : prompt.includes('downscaled picture') ? { overall_summary: 's', strategic_advisor: 'a', scores: {}, section_labels: [], top_priorities: [] } : viewportAnswer;
    return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }] }), { headers: { 'content-type': 'application/json' } });
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
  delete process.env.VP_MODEL_CALL_BUDGET;
});

beforeEach(() => {
  resetModelCallCount();
  apiHits = 0;
  failPrimaryOnce = false;
});

const post = async (route: string, body: unknown) => {
  const res = await realFetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};
const health = async () => (await realFetch(`${base}/api/health`)).json();
let png = '';
before(async () => {
  png = `data:image/png;base64,${(await sharp({ create: { width: 1440, height: 900, channels: 3, background: '#888' } }).png().toBuffer()).toString('base64')}`;
});
const audit = () => post('/api/audit/viewport', { screenshotDataUrl: png, viewport: 'desktop' });

test('unset: no limit, and health reports the count with a null budget', async () => {
  delete process.env.VP_MODEL_CALL_BUDGET;
  for (let i = 0; i < 4; i++) assert.equal((await audit()).status, 200);
  assert.deepEqual(await health(), { ok: true, modelCalls: 4, modelCallBudget: null, modelCallsRefused: 0 });
});

test('the budget counts fallbacks, and refuses the call past it with a 429 naming the budget', async () => {
  process.env.VP_MODEL_CALL_BUDGET = '3';
  failPrimaryOnce = true;
  assert.equal((await audit()).status, 200); // primary 503, fallback 200: 2 requests
  assert.equal((await health()).modelCalls, 2);
  assert.equal((await audit()).status, 200); // 3rd request
  const refused = await audit();
  assert.equal(refused.status, 429);
  assert.match(refused.json.error, /^Model call budget reached: this server allows 3 model API calls \(VP_MODEL_CALL_BUDGET=3\)/);
  assert.equal(apiHits, 3, 'nothing past the budget reached the network');
  const h = await health();
  assert.equal(h.modelCalls, 3);
  assert.equal(h.modelCallBudget, 3);
  assert.equal(h.modelCallsRefused, 1, 'a refused call is not retried on the fallback model');
});

test('streams and the full-page audit go through the same count', async () => {
  process.env.VP_MODEL_CALL_BUDGET = '1';
  const chat = await post('/api/chat', { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(chat.status, 200);
  assert.equal((await post('/api/chat', { messages: [{ role: 'user', content: 'hi' }] })).status, 429);
  const tall = `data:image/png;base64,${(await sharp({ create: { width: 1440, height: 4000, channels: 3, background: '#888' } }).png().toBuffer()).toString('base64')}`;
  const page = await post('/api/audit/page', { screenshotDataUrl: tall, viewport: 'desktop' });
  assert.equal(page.status, 429);
  assert.match(page.json.error, /Model call budget reached/);
  assert.equal(apiHits, 1);
});

test('a budget that is not a whole number refuses every call (fails closed)', async () => {
  process.env.VP_MODEL_CALL_BUDGET = 'ten';
  assert.equal((await audit()).status, 429);
  assert.equal(apiHits, 0);
  assert.equal((await health()).modelCallBudget, 0);
});

test('health never carries key material', async () => {
  process.env.VP_MODEL_CALL_BUDGET = '5';
  const text = JSON.stringify(await health());
  assert.ok(!text.includes(FAKE_KEY));
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['modelCallBudget', 'modelCalls', 'modelCallsRefused', 'ok']);
});
