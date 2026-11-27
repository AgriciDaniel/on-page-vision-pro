// G6: live progress of a full-page audit, read by polling GET /api/audit/progress/:id while the
// POST runs. The real route and auditPage run; only the Gemini network is faked, and section 2's
// first attempt is held open until the test has looked at the running state.
import './legacySettings.ts'; // first: pins 1,800 px sections, 3 at once, medium (see the file)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { clearProgressStore, readProgressId, startProgress } from '../../server/auditProgress.ts';

let server: Server;
let base = '';
const realFetch = globalThis.fetch;
let releaseSection2: () => void = () => {};
let section2Gate = new Promise<void>((r) => (releaseSection2 = r));
let section3Failures = 2; // primary and fallback both answer 500, so the section is retried once

const reply = (obj: unknown) =>
  new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(obj) }] }, finishReason: 'STOP' }] }), {
    headers: { 'content-type': 'application/json' },
  });

before(async () => {
  process.env.VP_NO_AUTOSTART = '1';
  process.env.NODE_ENV = 'production';
  process.env.GEMINI_API_KEY = 'fake-key-progress';
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input, init);
    const prompt = JSON.stringify(JSON.parse(String(init?.body ?? '{}')).contents);
    const m = /Audit section (\d+) of/.exec(prompt);
    if (m && m[1] === '2') await section2Gate;
    if (m && m[1] === '3' && section3Failures > 0) {
      section3Failures--;
      return new Response(JSON.stringify({ error: { code: 500, message: 'internal', status: 'INTERNAL' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    if (m) return reply(m[1] === '1' ? { items: [], first_impression_test: {}, attention_hotspots: [] } : { items: [] });
    return reply({ overall_summary: 's', strategic_advisor: 'a', scores: {}, section_labels: [], top_priorities: [] });
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

const getProgress = async (id: string) => {
  const res = await realFetch(`${base}/api/audit/progress/${id}`);
  return { status: res.status, json: await res.json(), cache: res.headers.get('cache-control') };
};

test('progress: sections done of total, which are running, retries, overview, then done', async () => {
  const id = crypto.randomUUID();
  const image = await sharp({ create: { width: 1440, height: 6000, channels: 3, background: '#888' } }).png().toBuffer();
  const post = realFetch(`${base}/api/audit/page`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ screenshotDataUrl: `data:image/png;base64,${image.toString('base64')}`, viewport: 'desktop', progressId: id }),
  });

  // Poll until section 2 is the only one still running (it is held at the gate).
  let mid: any;
  let last: any;
  try {
    for (let i = 0; i < 150; i++) {
      const p = await getProgress(id);
      last = p.json;
      if (p.status === 200 && p.json.sections.done === 3) {
        mid = p;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    if (!mid) releaseSection2(); // never leave the POST hanging
  }
  assert.ok(mid, `saw the running state; last seen ${JSON.stringify(last)}`);
  assert.equal(mid.cache, 'no-store');
  assert.equal(mid.json.id, id);
  assert.equal(mid.json.status, 'running');
  assert.equal(mid.json.stage, 'sections');
  assert.equal(mid.json.sections.total, 4);
  assert.deepEqual(mid.json.sections.running, [1]);
  assert.deepEqual(mid.json.sections.states, ['done', 'running', 'done', 'done']);
  assert.equal(mid.json.retries, 1, 'section 3 was retried');
  assert.equal(mid.json.overview, 'pending');

  releaseSection2();
  const res = await post;
  assert.equal(res.status, 200);
  const done = await getProgress(id);
  assert.equal(done.json.status, 'done');
  assert.equal(done.json.stage, 'done');
  assert.equal(done.json.overview, 'done');
  assert.equal(done.json.sections.done, 4);
  assert.deepEqual(done.json.sections.running, []);
  assert.ok(!JSON.stringify(done.json).includes('fake-key-progress'));
});

test('progress: unknown ids are 404, bad ids are refused, a running id cannot be reused', async () => {
  assert.equal((await getProgress('a'.repeat(20))).status, 404);
  assert.equal((await getProgress('bad id!')).status, 404);
  assert.throws(() => readProgressId('short'), (e: any) => e.status === 400);
  assert.throws(() => readProgressId({}), (e: any) => e.status === 400);
  assert.equal(readProgressId(undefined), undefined);
  clearProgressStore();
  const id = crypto.randomUUID();
  const report = startProgress(id);
  assert.throws(() => startProgress(id), (e: any) => e.status === 409);
  report({ type: 'finished', ok: false, error: 'x' });
  assert.doesNotThrow(() => startProgress(id), 'a finished id may be reused');
});

test('progress: a failed audit reports failed with the public error', async () => {
  section2Gate = Promise.resolve();
  const id = crypto.randomUUID();
  const saved = process.env.VP_MODEL_CALL_BUDGET;
  process.env.VP_MODEL_CALL_BUDGET = '0';
  try {
    const image = await sharp({ create: { width: 1440, height: 3000, channels: 3, background: '#888' } }).png().toBuffer();
    const res = await realFetch(`${base}/api/audit/page`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ screenshotDataUrl: `data:image/png;base64,${image.toString('base64')}`, viewport: 'desktop', progressId: id }),
    });
    assert.equal(res.status, 429);
    const p = await getProgress(id);
    assert.equal(p.json.status, 'failed');
    assert.match(p.json.error, /Model call budget reached/);
    assert.ok(p.json.sections.failed > 0);
  } finally {
    if (saved === undefined) delete process.env.VP_MODEL_CALL_BUDGET;
    else process.env.VP_MODEL_CALL_BUDGET = saved;
  }
});
