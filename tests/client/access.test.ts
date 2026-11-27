import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSignInOpen,
  retryAfterSeconds,
  signInCancelled,
  signInSucceeded,
  SignInCancelledError,
  subscribeSignIn,
  waitForSignIn,
} from '../../lib/client/access';
import { captureCompetitorPreview, getAccessState, submitAccessToken } from '../../services/apiClient';

test('waitForSignIn: one card for many waiters; success resolves them all', async () => {
  const seen: boolean[] = [];
  const off = subscribeSignIn((o) => seen.push(o));
  const a = waitForSignIn();
  const b = waitForSignIn();
  assert.equal(isSignInOpen(), true);
  signInSucceeded();
  await Promise.all([a, b]);
  assert.equal(isSignInOpen(), false);
  assert.deepEqual(seen, [true, false]);
  off();
});

test('waitForSignIn: closing the card rejects with a clear message; abort rejects as AbortError', async () => {
  const a = waitForSignIn();
  signInCancelled();
  await assert.rejects(a, (e: Error) => e instanceof SignInCancelledError && /access token/.test(e.message));
  const ctrl = new AbortController();
  const b = waitForSignIn(ctrl.signal);
  ctrl.abort();
  await assert.rejects(b, (e: Error) => e.name === 'AbortError');
  signInCancelled();
});

test('retryAfterSeconds reads whole and fractional seconds and ignores junk', () => {
  assert.equal(retryAfterSeconds('42'), 42);
  assert.equal(retryAfterSeconds('1.2'), 2);
  assert.equal(retryAfterSeconds(null), null);
  assert.equal(retryAfterSeconds('soon'), null);
});

test('an API call that gets 401 waits for sign-in, then retries once with the same body', async () => {
  const real = globalThis.fetch;
  const calls: string[] = [];
  let authed = false;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${url} ${init.body}`);
    if (!authed) return new Response(JSON.stringify({ error: 'This server needs an access token.' }), { status: 401 });
    return new Response(JSON.stringify({ url: 'https://a.com', screenshotDataUrl: 'data:', provider: 'x' }), { status: 200 });
  }) as typeof fetch;
  try {
    const p = captureCompetitorPreview('https://a.com');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(isSignInOpen(), true);
    authed = true;
    signInSucceeded();
    const out = await p;
    assert.equal(out.url, 'https://a.com');
    assert.equal(calls.length, 2);
    assert.equal(calls[0], calls[1]);
  } finally {
    globalThis.fetch = real;
  }
});

test('submitAccessToken trims, reports the server error and the Retry-After wait', async () => {
  const real = globalThis.fetch;
  const bodies: string[] = [];
  let mode: 'ok' | 'wrong' | 'limited' = 'wrong';
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    if (mode === 'ok') return new Response(JSON.stringify({ required: true, authenticated: true }), { status: 200 });
    if (mode === 'wrong') return new Response(JSON.stringify({ error: 'That access token is not right.' }), { status: 401 });
    return new Response(JSON.stringify({ error: 'Too many requests from this address. Retry in 37 s.' }), { status: 429, headers: { 'Retry-After': '37' } });
  }) as typeof fetch;
  try {
    assert.deepEqual(await submitAccessToken('  abc  '), { ok: false, error: 'That access token is not right.', retryAfterSec: null });
    assert.equal(bodies[0], JSON.stringify({ token: 'abc' }));
    mode = 'limited';
    const limited = await submitAccessToken('abc');
    assert.equal(limited.retryAfterSec, 37);
    mode = 'ok';
    assert.deepEqual(await submitAccessToken('abc'), { ok: true });
  } finally {
    globalThis.fetch = real;
  }
});

test('getAccessState treats a server without the session route as open', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;
  try {
    assert.deepEqual(await getAccessState(), { required: false, authenticated: true });
  } finally {
    globalThis.fetch = real;
  }
});
