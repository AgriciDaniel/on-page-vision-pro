// Manual check, not part of `npm test` (uses the network; only target is https://agricidaniel.com).
// Boots the real server on port 3101, calls the capture routes, then sends SIGTERM and checks
// that the server and its capture browser exit cleanly.
// Run: node --import tsx tests/server/route-capture.manual.ts
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 3101;
const BASE = `http://127.0.0.1:${PORT}`;
const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(PORT), NODE_ENV: 'production' };
delete env.GEMINI_API_KEY;
delete env.HOST;

const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));
await new Promise<void>((resolve, reject) => {
  const t = setInterval(() => {
    if (log.includes('running on')) {
      clearInterval(t);
      resolve();
    }
  }, 100);
  setTimeout(() => reject(new Error(`no boot:\n${log}`)), 20_000);
});

async function post(route: string, body: unknown) {
  const started = Date.now();
  const res = await fetch(BASE + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json: any = await res.json();
  const strip = (v: unknown) => (typeof v === 'string' && v.startsWith('data:') ? `${v.slice(0, 23)}... (${v.length} chars)` : v);
  const shown = Object.fromEntries(Object.entries(json).filter(([k]) => k !== 'metadata').map(([k, v]) => [k, strip(v)]));
  return { status: res.status, ms: Date.now() - started, ...shown };
}

const out: Record<string, unknown> = {};
out.fullpage = await post('/api/capture', { url: 'https://agricidaniel.com' });
out.viewport = await post('/api/capture', { url: 'https://agricidaniel.com', mode: 'viewport' });
out.preview = await post('/api/capture-preview', { url: 'https://agricidaniel.com' });
out.badMode = await post('/api/capture', { url: 'https://agricidaniel.com', mode: 'poster' });

const exitStarted = Date.now();
child.kill('SIGTERM');
const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
out.shutdown = { exitCode: code, ms: Date.now() - exitStarted, logTail: log.trim().split('\n').slice(-1)[0] };
const stillUp = await fetch(BASE + '/api/health').then(() => true, () => false);
out.portFreeAfterExit = !stillUp;
console.log(JSON.stringify(out, null, 2));
