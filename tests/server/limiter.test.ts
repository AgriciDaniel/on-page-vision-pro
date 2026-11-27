// Wave 3: one limiter shared by every page audit in flight, progress while sections wait for a
// slot, and 429 handling (wait and retry on the same model before any fallback). Fake model only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { CallLimiter, auditPage, pageAuditLimiter } from '../../server/pageAudit.ts';
import { MODELS, rateLimitDelayMs, withFallback } from '../../server/gemini.ts';
import { readProgress, startProgress } from '../../server/auditProgress.ts';

const reply = (obj: unknown) => ({ text: JSON.stringify(obj), candidates: [{ finishReason: 'STOP' }] });
const answerFor = (text: string) =>
  /^Audit section 1 of/.test(text)
    ? reply({ items: [], first_impression_test: {}, attention_hotspots: [] })
    : /^Audit section/.test(text)
      ? reply({ items: [] })
      : reply({ overall_summary: 's', strategic_advisor: 'a', scores: {}, section_labels: [], top_priorities: [], drop: [] });
const image = (h: number) => sharp({ create: { width: 1440, height: h, channels: 3, background: '#888' } }).png().toBuffer();
const tick = () => new Promise((r) => setTimeout(r, 5));

test('limiter: first come first served, never more than the limit, slots handed over on release', async () => {
  const l = new CallLimiter(2);
  const order: number[] = [];
  const a = await l.acquire();
  const b = await l.acquire();
  const waiters = [3, 4, 5].map((n) => l.acquire().then((rel) => (order.push(n), rel)));
  await tick();
  assert.equal(l.inFlight, 2);
  assert.equal(l.queued, 3);
  a();
  a(); // a second release of the same slot does nothing
  await tick();
  assert.deepEqual(order, [3]);
  assert.equal(l.inFlight, 2);
  b();
  const [r3, r4] = await Promise.all(waiters.slice(0, 2));
  assert.deepEqual(order, [3, 4]);
  r3();
  r4();
  (await waiters[2])();
  assert.equal(l.inFlight, 0);
  assert.equal(l.queued, 0);
});

test('two audits share one limit: never more calls in flight than the limit, and progress shows waiting sections as queued', async () => {
  const limiter = new CallLimiter(2);
  const pending: (() => void)[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const ai = {
    models: {
      async generateContent(r: any) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => pending.push(resolve));
        inFlight--;
        return answerFor(r.contents.parts[1].text);
      },
    },
  };
  const idA = crypto.randomUUID();
  const idB = crypto.randomUUID();
  const opts = (id: string) => ({ ai: ai as any, limiter, sectionHeight: 1800, rateLimit: { attempts: 0 }, onProgress: startProgress(id) });
  // Desktop-sized A has 4 sections, B has 3; A asks first, so it takes both slots.
  const a = auditPage({ image: await image(6000), width: 1440, height: 6000, viewport: 'desktop', auditGoal: 'general' }, opts(idA));
  const b = auditPage({ image: await image(4000), width: 1440, height: 4000, viewport: 'mobile', auditGoal: 'general' }, opts(idB));
  while (pending.length < 2) await tick();
  await tick();

  const pa = readProgress(idA)!;
  const pb = readProgress(idB)!;
  assert.deepEqual(pa.sections.running, [0, 1]);
  assert.deepEqual(pa.sections.states, ['running', 'running', 'queued', 'queued']);
  assert.equal(pb.stage, 'sections');
  assert.deepEqual(pb.sections.states, ['queued', 'queued', 'queued'], 'B waits for a slot and says so');
  assert.deepEqual(pb.sections.running, []);
  assert.equal(pb.sections.done, 0);

  let done = false;
  Promise.all([a, b]).finally(() => (done = true));
  while (!done) {
    if (pending.length) pending.shift()!();
    await tick();
  }
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(maxInFlight, 2, 'the limit held across both audits');
  assert.equal(ra.stats!.calls, 5);
  assert.equal(rb.stats!.calls, 4);
  assert.equal(rb.stats!.concurrency, 2);
  assert.equal(rb.stats!.concurrencyScope, 'audit');
  assert.ok(rb.stats!.sections.every((s) => (s.waitMs ?? 0) > 0), 'B sections record their wait');
  assert.ok((rb.stats!.overview.waitMs ?? -1) >= 0);
  assert.equal(readProgress(idB)!.sections.done, 3);
  assert.equal(readProgress(idB)!.overview, 'done');
});

test('by default every audit uses the one process-wide limiter', async () => {
  let inFlightSeen = 0;
  const ai = {
    models: {
      async generateContent(r: any) {
        inFlightSeen = Math.max(inFlightSeen, pageAuditLimiter.inFlight);
        return answerFor(r.contents.parts[1].text);
      },
    },
  };
  const audit = await auditPage({ image: await image(3000), width: 1440, height: 3000, viewport: 'desktop', auditGoal: 'general' }, { ai: ai as any });
  assert.equal(audit.stats!.concurrencyScope, 'process');
  assert.equal(audit.stats!.concurrency, pageAuditLimiter.limit);
  assert.ok(inFlightSeen >= 1, 'calls held slots of the shared limiter');
  assert.equal(pageAuditLimiter.inFlight, 0, 'every slot released');
});

test('429 on a section: waits and retries on the same model, reported as retrying, before any fallback', async () => {
  const calls: { section: string; model: string }[] = [];
  let failures = 2;
  const ai = {
    models: {
      async generateContent(r: any) {
        const text: string = r.contents.parts[1].text;
        const section = /^Audit section (\d+)/.exec(text)?.[1] ?? 'overview';
        calls.push({ section, model: r.model });
        if (section === '2' && failures > 0) {
          failures--;
          throw Object.assign(new Error('got status: 429 RESOURCE_EXHAUSTED. Please retry in 3s.'), { status: 429 });
        }
        return answerFor(text);
      },
    },
  };
  const waits: number[] = [];
  const id = crypto.randomUUID();
  const report = startProgress(id);
  const seen: string[] = [];
  const audit = await auditPage(
    { image: await image(3000), width: 1440, height: 3000, viewport: 'desktop', auditGoal: 'general' },
    {
      ai: ai as any,
      concurrency: 4,
      sectionHeight: 1800,
      rateLimit: { attempts: 2, sleep: async (ms) => void waits.push(ms) },
      onProgress: (e) => {
        report(e);
        if (e.type === 'section-retry') seen.push(readProgress(id)!.sections.states[1]);
      },
    }
  );
  const section2 = calls.filter((c) => c.section === '2');
  assert.deepEqual(section2.map((c) => c.model), [MODELS.audit, MODELS.audit, MODELS.audit], 'same model three times, no fallback');
  assert.deepEqual(waits, [3000, 3000], "the server's own retry hint was used");
  assert.deepEqual(seen, ['retrying', 'retrying']);
  assert.equal(audit.stats!.rateLimitRetries, 2);
  assert.equal(audit.stats!.retries, 0, 'not a section retry');
  assert.equal(audit.stats!.sections[1].ok, true);
  assert.equal(audit.model_used, MODELS.audit);
  assert.equal(readProgress(id)!.retries, 2);
});

test('429 that outlasts the same-model retries: then, and only then, the fallback model', async () => {
  const models: string[] = [];
  const run = async (model: string) => {
    models.push(model);
    if (model === 'primary') throw Object.assign(new Error('429'), { status: 429 });
    return 'ok';
  };
  const waits: number[] = [];
  const out = await withFallback('primary', 'fallback', 1000, run, { attempts: 2, sleep: async (ms) => void waits.push(ms) });
  assert.deepEqual(models, ['primary', 'primary', 'primary', 'fallback']);
  assert.equal(out.modelUsed, 'fallback');
  assert.deepEqual(waits, [10_000, 20_000]);
  // Without a policy (other routes): straight to the fallback, as before.
  models.length = 0;
  await withFallback('primary', 'fallback', 1000, run);
  assert.deepEqual(models, ['primary', 'fallback']);
  // A 500 is not a rate limit: no same-model wait.
  models.length = 0;
  await withFallback('primary', 'fallback', 1000, async (m) => {
    models.push(m);
    if (m === 'primary') throw Object.assign(new Error('internal'), { status: 500 });
    return 'ok';
  }, { attempts: 2, sleep: async () => assert.fail('no wait for a 500') });
  assert.deepEqual(models, ['primary', 'fallback']);
});

test('rateLimitDelayMs: the server hint when given, else 10 s then 20 s, capped at 60 s', () => {
  assert.equal(rateLimitDelayMs(new Error('Please retry in 12.5s.'), 1), 12_500);
  assert.equal(rateLimitDelayMs(new Error('{"retryDelay": "7s"}'), 2), 7_000);
  assert.equal(rateLimitDelayMs(new Error('429'), 1), 10_000);
  assert.equal(rateLimitDelayMs(new Error('429'), 2), 20_000);
  assert.equal(rateLimitDelayMs(new Error('Please retry in 300s'), 1), 60_000);
});

// ---- fair slots across audits (final-run-2: desktop took 7 of 8, mobile waited up to 69 s) ----

/** Releases calls one by one in order; each release lets the next waiting call in. */
async function drain(calls: Promise<() => void>[]) {
  for (const c of calls) (await c)();
}

/** Runs `plan` (tasks per owner) through a limiter one round at a time: every call in flight
 * finishes together, then the next round starts. Returns calls per round, split by owner. */
async function rounds(limiter: CallLimiter, plan: { acquire: () => Promise<() => void> }[], counts: number[]) {
  const holders: { owner: number; release: () => void }[] = [];
  const total = counts.reduce((a, b) => a + b, 0);
  counts.forEach((n, owner) => {
    for (let k = 0; k < n; k++) plan[owner].acquire().then((release) => holders.push({ owner, release }));
  });
  const out: number[][] = [];
  let done = 0;
  while (done < total) {
    await new Promise((r) => setImmediate(r));
    const now = holders.splice(0);
    if (now.length === 0) continue;
    assert.ok(now.length <= limiter.limit);
    out.push(counts.map((_, o) => now.filter((h) => h.owner === o).length));
    for (const h of now) h.release();
    done += now.length;
  }
  return out;
}

test('fair slots: two audits joined at once get half each, even when one asks for all its calls first', async () => {
  const limiter = new CallLimiter(8, { reserveMs: 60_000 });
  const desktop = limiter.join(); // both join when their request headers arrive
  const mobile = limiter.join();
  // Desktop's 7 sections ask first, while the mobile image is still uploading.
  const d = Array.from({ length: 7 }, () => desktop.acquire());
  await tick();
  assert.deepEqual(limiter.heldByAudit(), [4, 0], 'desktop gets its half; the other half waits for mobile');
  assert.equal(limiter.inFlight, 4);
  const m = Array.from({ length: 14 }, () => mobile.acquire());
  await tick();
  assert.deepEqual(limiter.heldByAudit(), [4, 4], 'both strips move from the start');

  // Round robin while both wait: a freed desktop slot goes back to desktop, a freed mobile one to mobile.
  const dr = await Promise.all(d.slice(0, 4));
  const mr = await Promise.all(m.slice(0, 4));
  dr[0]();
  await tick();
  assert.deepEqual(limiter.heldByAudit(), [4, 4]);
  mr[0]();
  await tick();
  assert.deepEqual(limiter.heldByAudit(), [4, 4]);
  assert.equal(limiter.inFlight, 8, 'never an idle slot while calls wait');
  // Once desktop has nothing left to ask, mobile gets every free slot (work conserving).
  for (const r of dr.slice(1)) r();
  for (const r of await Promise.all(d.slice(4))) r();
  await tick();
  assert.deepEqual(limiter.heldByAudit(), [0, 8]);
  desktop.leave();
  await drain(m);
  mobile.leave();
  assert.equal(limiter.inFlight, 0);
  assert.equal(limiter.audits, 0);
});

test('fair slots: total throughput is unchanged, only the order changes (7 desktop + 14 mobile calls, limit 8)', async () => {
  // Old behaviour: one first-come first-served queue, desktop first.
  const fifo = new CallLimiter(8);
  const old = await rounds(fifo, [fifo, fifo], [7, 14]);
  // New: each audit its own ticket.
  const fair = new CallLimiter(8, { reserveMs: 60_000 });
  const a = fair.join();
  const b = fair.join();
  const now = await rounds(fair, [a, b], [7, 14]);

  const perRound = (r: number[][]) => r.map(([x, y]) => x + y);
  assert.deepEqual(perRound(old), [8, 8, 5]);
  assert.deepEqual(perRound(now), [8, 8, 5], 'same rounds, same calls per round: throughput unchanged');
  assert.deepEqual(old[0], [7, 1], 'before: desktop took 7 of 8');
  assert.deepEqual(now[0], [4, 4], 'now: 4 and 4');
  assert.deepEqual(now, [[4, 4], [3, 5], [0, 5]]);
});

test('fair slots: a single audit still gets all 8', async () => {
  const limiter = new CallLimiter(8, { reserveMs: 60_000 });
  const only = limiter.join();
  const calls = Array.from({ length: 10 }, () => only.acquire());
  await tick();
  assert.equal(limiter.inFlight, 8);
  assert.deepEqual(limiter.heldByAudit(), [8]);
  await drain(calls);
  only.leave();
});

test('fair slots: a joined audit that never asks stops holding slots back (on leave, or after the reserve time)', async () => {
  const limiter = new CallLimiter(8, { reserveMs: 80 });
  const a = limiter.join();
  const quiet = limiter.join();
  const calls = Array.from({ length: 7 }, () => a.acquire());
  await tick();
  assert.equal(limiter.inFlight, 4, 'half held back for the other audit');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(limiter.inFlight, 7, 'the reservation lapsed: no slot stays idle');
  quiet.leave();

  const b = limiter.join();
  const c = limiter.join();
  const more = Array.from({ length: 6 }, () => b.acquire());
  await tick();
  assert.equal(limiter.inFlight, 8, '7 + 1: b gets the free slot');
  c.leave();
  for (const r of await Promise.all(calls)) r();
  await tick();
  assert.equal(limiter.inFlight, 6, 'leave frees at once: b runs all 6');
  for (const r of await Promise.all(more)) r();
  a.leave();
  b.leave();
  assert.equal(limiter.audits, 0);
});

test('route: desktop and mobile posted together share the 8 slots 4 and 4; a refused request leaves no reservation', async () => {
  process.env.VP_NO_AUTOSTART = '1';
  process.env.NODE_ENV = 'production';
  process.env.GEMINI_API_KEY = 'fake-key-limiter';
  const realFetch = globalThis.fetch;
  const held: (() => void)[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input, init);
    const text: string = JSON.parse(String(init?.body ?? '{}')).contents?.[0]?.parts?.[1]?.text ?? '';
    await new Promise<void>((r) => held.push(r));
    const a = answerFor(text);
    return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: a.text }] }, finishReason: 'STOP' }] }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const { createServer } = await import('../../server.ts');
  const app = await createServer({ listen: false });
  const server = app!.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (body: unknown) => realFetch(`${base}/api/audit/page`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  // Like a browser sending both uploads at once: both sets of headers arrive first, then the bodies.
  const { request } = await import('node:http');
  const startUpload = (body: unknown) => {
    const data = Buffer.from(JSON.stringify(body));
    const url = new URL(`${base}/api/audit/page`);
    let resolveDone!: (v: { status: number }) => void;
    const done = new Promise<{ status: number }>((r) => (resolveDone = r));
    const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      res.resume();
      res.on('end', () => resolveDone({ status: res.statusCode ?? 0 }));
    });
    req.flushHeaders();
    return { send: () => req.end(data), done };
  };
  try {
    assert.equal(pageAuditLimiter.limit, 8);
    const desk = await sharp({ create: { width: 1440, height: 9000, channels: 3, background: '#888' } }).png().toBuffer();
    const mob = await sharp({ create: { width: 780, height: 14_000, channels: 3, background: '#888' } }).png().toBuffer();
    const du = startUpload({ screenshotDataUrl: `data:image/png;base64,${desk.toString('base64')}`, viewport: 'desktop' });
    const mu = startUpload({ screenshotDataUrl: `data:image/png;base64,${mob.toString('base64')}`, viewport: 'mobile' });
    while (pageAuditLimiter.audits < 2) await tick(); // both joined on their headers
    du.send(); // desktop's body lands first and asks for all its sections at once
    while (pageAuditLimiter.inFlight < 4) await tick();
    await tick();
    assert.deepEqual(pageAuditLimiter.heldByAudit(), [4, 0], 'desktop starts with its half; the rest waits for mobile');
    mu.send();
    const d = du.done;
    const m = mu.done;
    while (held.length < 8) await tick();
    await tick();
    assert.deepEqual([...pageAuditLimiter.heldByAudit()].sort(), [4, 4], 'both audits run from the start');
    let finished = false;
    Promise.all([d, m]).finally(() => (finished = true));
    while (!finished) {
      if (held.length) held.shift()!();
      await tick();
    }
    assert.equal((await d).status, 200);
    assert.equal((await m).status, 200);
    assert.equal(pageAuditLimiter.audits, 0, 'both tickets left');

    const bad = await post({ screenshotDataUrl: 'not an image', viewport: 'desktop' });
    assert.equal(bad.status, 400);
    await tick();
    assert.equal(pageAuditLimiter.audits, 0, 'a refused request leaves no reservation');
  } finally {
    // Never leave calls hanging if an assertion failed: answer everything still held.
    const drainHeld = setInterval(() => held.splice(0).forEach((r) => r()), 5);
    await new Promise((r) => setTimeout(r, 300));
    clearInterval(drainHeld);
    server.close();
    globalThis.fetch = realFetch;
  }
});
