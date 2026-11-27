// Boots the real server (no GEMINI_API_KEY, loopback only, port 3101 reserved for this lane)
// and checks the request boundary: body limits, validation, URL safety and error statuses.
// No external network: every request below is rejected before any outbound call.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pngBytes } from './fixtures.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 3101;
const BASE = `http://127.0.0.1:${PORT}`;
let child: ChildProcess;
let bootLog = '';

before(async () => {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(PORT), NODE_ENV: 'production' };
  delete env.GEMINI_API_KEY;
  delete env.HOST;
  child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${bootLog}`)), 20000);
    const onData = (d: Buffer) => {
      bootLog += d.toString();
      if (bootLog.includes('running on')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.on('exit', (code) => reject(new Error(`server exited ${code}:\n${bootLog}`)));
  });
});

after(() => {
  child?.kill();
});

async function post(route: string, body: unknown, raw?: string) {
  const res = await fetch(BASE + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave null: the assertion below reports it
  }
  return { status: res.status, json, text };
}

const png = `data:image/png;base64,${pngBytes(1440, 900).toString('base64')}`;

test('binds to loopback by default', () => {
  assert.match(bootLog, /bound to 127\.0\.0\.1/);
});

test('url-only routes reject bodies over 16 kB with a JSON 413', async () => {
  const r = await post('/api/capture', { url: 'https://example.com', pad: 'x'.repeat(20_000) });
  assert.equal(r.status, 413);
  assert.match(r.json?.error ?? '', /too large/i);
});

test('malformed JSON is a JSON 400, not an HTML page', async () => {
  const r = await post('/api/capture', null, '{"url":');
  assert.equal(r.status, 400);
  assert.ok(r.json?.error, r.text);
});

test('capture routes refuse private targets before any outbound request', async () => {
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://127.0.0.2/', 'localhost.']) {
    const a = await post('/api/capture', { url });
    assert.equal(a.status, 400, url);
    const b = await post('/api/capture-preview', { url });
    assert.equal(b.status, 400, url);
  }
});

test('image routes validate input locally (400) before needing the API key', async () => {
  assert.equal((await post('/api/audit/viewport', { screenshotDataUrl: 'http://x' })).status, 400);
  assert.equal((await post('/api/audit/viewport', { screenshotDataUrl: png, viewport: 'tablet' })).status, 400);
  assert.equal((await post('/api/audit/viewport', { screenshotDataUrl: png, auditGoal: 'crypto' })).status, 400);
  assert.equal((await post('/api/audit/element', { croppedImageDataUrl: png, box_2d: [1, 2] })).status, 400);
  assert.equal((await post('/api/audit/compare', { desktopScreenshot: png })).status, 400);
  assert.equal((await post('/api/redesign', { imageDataUrl: png, prompt: 'x', mode: 'poster' })).status, 400);
  assert.equal((await post('/api/chat', { messages: [] })).status, 400);
  assert.equal((await post('/api/audit/fix-code', {})).status, 400);
});

test('/api/audit/page validates locally: height cap, foldPx, viewport, then needs the key', async () => {
  const tall = `data:image/png;base64,${pngBytes(1440, 30_001).toString('base64')}`;
  const tallRes = await post('/api/audit/page', { screenshotDataUrl: tall, viewport: 'desktop' });
  assert.equal(tallRes.status, 400);
  assert.match(tallRes.json.error, /30,001 px tall; the limit is 30,000 px/);
  assert.equal((await post('/api/audit/page', { screenshotDataUrl: png, foldPx: -5 })).status, 400);
  assert.equal((await post('/api/audit/page', { screenshotDataUrl: png, viewport: 'tablet' })).status, 400);
  assert.equal((await post('/api/audit/page', { screenshotDataUrl: 'http://x' })).status, 400);
  const noKey = await post('/api/audit/page', { screenshotDataUrl: png, viewport: 'desktop', foldPx: 900 });
  assert.equal(noKey.status, 503);
  assert.match(noKey.json.error, /GEMINI_API_KEY/);
});

test('SEC-4: a pixel bomb is a 400 on every image route, before the key or any decode', async () => {
  const bomb = `data:image/png;base64,${pngBytes(50_000, 30_000).toString('base64')}`;
  for (const route of ['/api/audit/page', '/api/audit/viewport', '/api/audit/element', '/api/redesign', '/api/copy-variants']) {
    const res = await post(route, { screenshotDataUrl: bomb, imageDataUrl: bomb, croppedImageDataUrl: bomb, prompt: 'x', viewport: 'desktop', finding: { context: 'x' } });
    assert.equal(res.status, 400, route);
    assert.match(res.json.error, /50,000 px wide; the limit is 2,880 px/, route);
  }
});

test('/api/capture rejects an unknown mode before any capture', async () => {
  assert.equal((await post('/api/capture', { url: 'https://example.com', mode: 'poster' })).status, 400);
});

test('a valid request without a configured key is a neutral 503', async () => {
  const r = await post('/api/audit/viewport', { screenshotDataUrl: png, viewport: 'desktop' });
  assert.equal(r.status, 503);
  assert.match(r.json.error, /GEMINI_API_KEY/);
  assert.doesNotMatch(r.json.error, /Settings|Secrets|AI Studio/i);
  const chat = await post('/api/chat', { messages: [{ role: 'user', content: 'hi' }], auditContext: '' });
  assert.equal(chat.status, 503);
  assert.ok(chat.json?.error, 'chat errors before streaming are JSON');
});
