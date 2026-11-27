// Wave 3 part 2: optional access token, session cookie, startup guard and rate limits.
// Each case builds its own app with its own env; no model calls are made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { RateLimiter, assertStartupAllowed, isLoopbackHost, safeEqual } from '../../server/access.ts';

process.env.VP_NO_AUTOSTART = '1';
process.env.NODE_ENV = 'production';
const TOKEN = 'correct-horse-battery-staple-42';
const KEYS = ['APP_ACCESS_TOKEN', 'RATE_LIMIT_PER_MIN', 'RATE_LIMIT_MODEL_PER_MIN', 'RATE_LIMIT_AUTH_PER_MIN'];

async function serve(env: Record<string, string>) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    const { createServer } = await import('../../server.ts');
    const app = await createServer({ listen: false });
    const server = app!.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) => {
      const res = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json', ...opts.headers },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON
      }
      return { status: res.status, json, headers: res.headers };
    };
    return { call, close: () => server.close() };
  } finally {
    for (const k of KEYS) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

test('no token on loopback: runs open, as before', async () => {
  const s = await serve({});
  try {
    assert.deepEqual((await s.call('GET', '/api/session')).json, { required: false, authenticated: true });
    const r = await s.call('GET', '/api/audit/progress/aaaaaaaaaaaaaaaaaaaa');
    assert.equal(r.status, 404, 'reaches the route');
    assert.equal((await s.call('POST', '/api/session', { body: { token: 'x' } })).json.required, false);
  } finally {
    s.close();
  }
});

test('token set: every /api route except health and session needs it, as a bearer header or the session cookie', async () => {
  const s = await serve({ APP_ACCESS_TOKEN: TOKEN });
  try {
    assert.equal((await s.call('GET', '/api/health')).status, 200);
    assert.deepEqual((await s.call('GET', '/api/session')).json, { required: true, authenticated: false });

    for (const [method, path] of [['POST', '/api/capture'], ['POST', '/api/audit/page'], ['GET', '/api/audit/progress/aaaaaaaaaaaaaaaaaaaa'], ['POST', '/api/chat'], ['POST', '/api/nope']]) {
      const r = await s.call(method, path, { body: method === 'POST' ? {} : undefined });
      assert.equal(r.status, 401, `${method} ${path}`);
      assert.match(r.json.error, /needs an access token/);
      assert.equal(r.headers.get('www-authenticate'), 'Bearer realm="vision-pro"');
    }
    assert.equal((await s.call('POST', '/api/capture', { body: {}, headers: { authorization: 'Bearer wrong-token' } })).status, 401);
    // The right bearer token reaches the route, which then answers on its own (400: no url).
    assert.equal((await s.call('POST', '/api/capture', { body: {}, headers: { authorization: `Bearer ${TOKEN}` } })).status, 400);

    // Browser: POST /api/session checks the token and sets an HttpOnly, SameSite=Strict cookie.
    assert.equal((await s.call('POST', '/api/session', { body: {} })).status, 400);
    assert.equal((await s.call('POST', '/api/session', { body: { token: 'wrong' } })).status, 401);
    const ok = await s.call('POST', '/api/session', { body: { token: ` ${TOKEN} ` } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { required: true, authenticated: true });
    const setCookie = ok.headers.get('set-cookie')!;
    assert.match(setCookie, /^vp_session=[A-Za-z0-9_-]+; Path=\/api; HttpOnly; SameSite=Strict; Max-Age=604800$/);
    assert.ok(!setCookie.includes(TOKEN), 'the cookie never holds the token itself');
    const cookie = setCookie.split(';')[0];

    assert.equal((await s.call('POST', '/api/capture', { body: {}, headers: { cookie } })).status, 400, 'cookie reaches the route');
    assert.deepEqual((await s.call('GET', '/api/session', { headers: { cookie } })).json, { required: true, authenticated: true });
    assert.equal((await s.call('POST', '/api/capture', { body: {}, headers: { cookie: 'vp_session=forged' } })).status, 401);

    const out = await s.call('DELETE', '/api/session', { headers: { cookie } });
    assert.match(out.headers.get('set-cookie')!, /^vp_session=; .*Max-Age=0/);
  } finally {
    s.close();
  }
});

test('token set: a cookie made for another token does not work, so changing the token logs browsers out', async () => {
  const a = await serve({ APP_ACCESS_TOKEN: TOKEN });
  const b = await serve({ APP_ACCESS_TOKEN: `${TOKEN}-rotated` });
  try {
    const cookie = (await a.call('POST', '/api/session', { body: { token: TOKEN } })).headers.get('set-cookie')!.split(';')[0];
    assert.equal((await b.call('POST', '/api/capture', { body: {}, headers: { cookie } })).status, 401);
  } finally {
    a.close();
    b.close();
  }
});

test('guessing the token: past RATE_LIMIT_AUTH_PER_MIN wrong tries, 429 with Retry-After', async () => {
  const s = await serve({ APP_ACCESS_TOKEN: TOKEN, RATE_LIMIT_AUTH_PER_MIN: '3' });
  try {
    assert.equal((await s.call('POST', '/api/session', { body: { token: 'a' } })).status, 401);
    assert.equal((await s.call('POST', '/api/capture', { body: {}, headers: { authorization: 'Bearer b' } })).status, 401);
    assert.equal((await s.call('POST', '/api/session', { body: { token: 'c' } })).status, 401);
    const r = await s.call('POST', '/api/session', { body: { token: TOKEN } });
    assert.equal(r.status, 429, 'locked for the rest of the minute, even with the right token');
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    assert.match(r.json.error, /RATE_LIMIT_AUTH_PER_MIN is 3/);
    assert.equal((await s.call('GET', '/api/health')).status, 200, 'health stays open');
  } finally {
    s.close();
  }
});

test('rate limits: model routes have the tight limit, every route the generous one; 429 with Retry-After names the setting', async () => {
  const s = await serve({ RATE_LIMIT_MODEL_PER_MIN: '2', RATE_LIMIT_PER_MIN: '6' });
  try {
    // No key is set, so model routes answer 400 or 503 on their own; the limit is checked first.
    assert.notEqual((await s.call('POST', '/api/audit/fix-code', { body: {} })).status, 429);
    assert.notEqual((await s.call('POST', '/api/chat', { body: {} })).status, 429);
    const third = await s.call('POST', '/api/audit/page', { body: {} });
    assert.equal(third.status, 429);
    assert.match(third.json.error, /2 AI requests a minute \(RATE_LIMIT_MODEL_PER_MIN\)/);
    const wait = Number(third.headers.get('retry-after'));
    assert.ok(wait >= 1 && wait <= 60, `Retry-After ${wait}`);
    // Cheap routes still work until the general limit (6 in all, 3 used).
    assert.equal((await s.call('GET', '/api/health')).status, 200);
    assert.equal((await s.call('GET', '/api/session')).status, 200);
    assert.equal((await s.call('GET', '/api/health')).status, 200);
    const over = await s.call('GET', '/api/health');
    assert.equal(over.status, 429);
    assert.match(over.json.error, /6 API requests a minute \(RATE_LIMIT_PER_MIN\)/);
  } finally {
    s.close();
  }
});

test('RateLimiter: fixed one-minute windows per key, with the wait in seconds', () => {
  let now = 1_000_000;
  const rl = new RateLimiter(() => now);
  assert.equal(rl.hit('a', 2), 0);
  assert.equal(rl.hit('a', 2), 0);
  assert.equal(rl.hit('a', 2), 60);
  assert.equal(rl.hit('b', 2), 0, 'separate keys');
  now += 45_500;
  assert.equal(rl.hit('a', 2), 15);
  assert.equal(rl.blocked('a', 2), 15);
  now += 15_000;
  assert.equal(rl.hit('a', 2), 0, 'a new window');
  assert.equal(rl.blocked('a', 2), 0);
});

test('startup: no token and a non-loopback HOST refuses to start unless ALLOW_OPEN=1', () => {
  for (const host of ['127.0.0.1', '127.0.0.53', '::1', '[::1]', 'localhost', '::ffff:127.0.0.1']) {
    assert.ok(isLoopbackHost(host), host);
    assert.doesNotThrow(() => assertStartupAllowed(host, {}));
  }
  for (const host of ['0.0.0.0', '::', '192.168.1.20', 'example.com']) {
    assert.ok(!isLoopbackHost(host), host);
    assert.throws(() => assertStartupAllowed(host, {}), /Refusing to start: HOST=.* APP_ACCESS_TOKEN is not set/);
    assert.doesNotThrow(() => assertStartupAllowed(host, { ALLOW_OPEN: '1' }));
    assert.doesNotThrow(() => assertStartupAllowed(host, { APP_ACCESS_TOKEN: TOKEN }));
  }
  assert.throws(() => assertStartupAllowed('0.0.0.0', { ALLOW_OPEN: 'yes' }), /ALLOW_OPEN=1/);
});

test('startup: the real server process exits with the message when HOST=0.0.0.0 has no token', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, HOST: '0.0.0.0', PORT: '0', NODE_ENV: 'production' };
  for (const k of ['VP_NO_AUTOSTART', 'APP_ACCESS_TOKEN', 'ALLOW_OPEN', 'GEMINI_API_KEY']) delete env[k];
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'server.ts'], { env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /Failed to start server: Refusing to start: HOST=0\.0\.0\.0/);
  assert.ok(!/running on/.test(r.stdout), 'never listened');
});

test('safeEqual compares strings of any length in constant time', () => {
  assert.ok(safeEqual(TOKEN, TOKEN));
  assert.ok(!safeEqual(TOKEN, TOKEN.slice(0, -1)));
  assert.ok(!safeEqual('', TOKEN));
});
