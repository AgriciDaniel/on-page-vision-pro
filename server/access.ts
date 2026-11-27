// Who may use the API, and how often. Without this, anyone who can reach the port can spend the
// Gemini key.
//
// APP_ACCESS_TOKEN (optional): when set, every /api route except /api/health and /api/session
// needs it, either as `Authorization: Bearer <token>` (scripts) or as the HttpOnly,
// SameSite=Strict cookie that POST /api/session sets after checking the token (the browser).
// The cookie holds an HMAC of the token, never the token itself, so changing the token logs
// every browser out. Comparisons are constant time.
//
// Startup: with no token and HOST not loopback, the server refuses to start unless ALLOW_OPEN=1.
// With no token on loopback it runs open, as before.
//
// Rate limits (always on, in memory, per client address, fixed one-minute windows), each a
// named setting with an env override:
//   RATE_LIMIT_PER_MIN        every /api request, default 300 (progress polling is ~40 a minute)
//   RATE_LIMIT_MODEL_PER_MIN  routes that call the model, default 20
//   RATE_LIMIT_AUTH_PER_MIN   wrong or missing tokens, default 10 (stops guessing the token)
// Past a limit: 429 with Retry-After in seconds. The client address is the socket address
// (Express `req.ip` without trust proxy), so clients behind one reverse proxy share a limit.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';

export const SESSION_COOKIE = 'vp_session';
const SESSION_MAX_AGE_S = 7 * 24 * 3600;
const WINDOW_MS = 60_000;
const MAX_TRACKED = 10_000;

/** Routes that send requests to the model API: the tight limit applies to them. */
export const MODEL_ROUTES = new Set([
  '/api/audit/viewport',
  '/api/audit/page',
  '/api/audit/more',
  '/api/audit/element',
  '/api/audit/fix-code',
  '/api/audit/compare',
  '/api/redesign',
  '/api/serp-research',
  '/api/copy-variants',
  '/api/chat',
  '/api/audio-brief',
]);
/** Open without a token: health for monitors, session so the browser can log in. */
const OPEN_ROUTES = new Set(['/api/health', '/api/session']);

function readLimit(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = String(env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 100_000) return n;
  console.warn(`[access] ignoring ${name}="${raw}"; expected a whole number from 1 to 100000.`);
  return fallback;
}

export interface AccessConfig {
  token: string | null;
  limits: { api: number; model: number; auth: number };
}

export function readAccessConfig(env: NodeJS.ProcessEnv = process.env): AccessConfig {
  const token = String(env.APP_ACCESS_TOKEN ?? '').trim() || null;
  if (token && token.length < 16) console.warn('[access] APP_ACCESS_TOKEN is shorter than 16 characters; use a long random value.');
  return {
    token,
    limits: {
      api: readLimit('RATE_LIMIT_PER_MIN', 300, env),
      model: readLimit('RATE_LIMIT_MODEL_PER_MIN', 20, env),
      auth: readLimit('RATE_LIMIT_AUTH_PER_MIN', 10, env),
    },
  };
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(h);
}

/** Throws (so the server does not start) when it would be open to the network with no token. */
export function assertStartupAllowed(host: string, env: NodeJS.ProcessEnv = process.env): void {
  if (readAccessConfig(env).token || isLoopbackHost(host) || env.ALLOW_OPEN === '1') return;
  throw new Error(
    `Refusing to start: HOST=${host} is reachable from other machines and APP_ACCESS_TOKEN is not set, so anyone who can reach this port could spend the Gemini key. Set APP_ACCESS_TOKEN to a long random value, bind to 127.0.0.1, or set ALLOW_OPEN=1 to run open on purpose.`
  );
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();
/** Constant time for any two strings: both sides are hashed to 32 bytes first. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}
const sessionValue = (token: string) => createHmac('sha256', token).update('vp-session-v1').digest('base64url');

function readCookie(req: Request, name: string): string | null {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function presented(req: Request, token: string): boolean {
  const auth = String(req.headers.authorization ?? '');
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m && safeEqual(m[1].trim(), token)) return true;
  const cookie = readCookie(req, SESSION_COOKIE);
  return cookie !== null && safeEqual(cookie, sessionValue(token));
}

/** Fixed one-minute windows per key. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private now: () => number;
  // No parameter property: `npm start` runs Node's strip-only TypeScript, which rejects them.
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Counts one hit; returns the seconds to wait when the limit is exceeded, else 0. */
  hit(key: string, limit: number): number {
    const now = this.now();
    if (this.hits.size > MAX_TRACKED) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + WINDOW_MS };
      this.hits.set(key, entry);
    }
    entry.count++;
    return entry.count > limit ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) : 0;
  }

  /** Seconds to wait if this key is already over the limit, without counting a hit. */
  blocked(key: string, limit: number): number {
    const entry = this.hits.get(key);
    const now = this.now();
    return entry && entry.resetAt > now && entry.count >= limit ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) : 0;
  }
}

function tooMany(res: Response, wait: number, what: string): void {
  res.setHeader('Retry-After', String(wait));
  res.status(429).json({ error: `Too many requests from this address: ${what}. Retry in ${wait} s.` });
}

/**
 * Mounts rate limits, the token check and the session routes on `app`. Call before any /api
 * route so unauthenticated requests are refused before their bodies are read.
 */
export function installAccess(app: express.Express, config: AccessConfig = readAccessConfig(), limiter = new RateLimiter()): void {
  const { token, limits } = config;
  const client = (req: Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown';

  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    const ip = client(req);
    const path = req.baseUrl + req.path;
    let wait = limiter.hit(`api|${ip}`, limits.api);
    if (wait) return tooMany(res, wait, `the limit is ${limits.api} API requests a minute (RATE_LIMIT_PER_MIN)`);
    if (MODEL_ROUTES.has(path)) {
      wait = limiter.hit(`model|${ip}`, limits.model);
      if (wait) return tooMany(res, wait, `the limit is ${limits.model} AI requests a minute (RATE_LIMIT_MODEL_PER_MIN)`);
    }
    if (!token || OPEN_ROUTES.has(path)) return next();
    wait = limiter.blocked(`auth|${ip}`, limits.auth);
    if (wait) return tooMany(res, wait, `too many attempts without a valid access token (RATE_LIMIT_AUTH_PER_MIN is ${limits.auth})`);
    if (presented(req, token)) return next();
    limiter.hit(`auth|${ip}`, limits.auth);
    res.setHeader('WWW-Authenticate', 'Bearer realm="vision-pro"');
    res.status(401).json({ error: 'This server needs an access token. Enter it in the app, or send it as "Authorization: Bearer <token>".' });
  });

  // GET: does this server need a token, and is this browser logged in?
  app.get('/api/session', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ required: token !== null, authenticated: token === null || presented(req, token) });
  });

  // POST { token }: checks it and sets the session cookie.
  app.post('/api/session', express.json({ limit: '4kb' }), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!token) return res.json({ required: false, authenticated: true });
    const ip = client(req);
    const wait = limiter.blocked(`auth|${ip}`, limits.auth);
    if (wait) return tooMany(res, wait, `too many attempts without a valid access token (RATE_LIMIT_AUTH_PER_MIN is ${limits.auth})`);
    const given = req.body?.token;
    if (typeof given !== 'string' || !given.trim()) return res.status(400).json({ error: 'Send the access token as {"token": "..."}.' });
    if (!safeEqual(given.trim(), token)) {
      limiter.hit(`auth|${ip}`, limits.auth);
      return res.status(401).json({ error: 'That access token is not right.' });
    }
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sessionValue(token)}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_S}${secure}`);
    res.json({ required: true, authenticated: true });
  });

  // DELETE: logs this browser out.
  app.delete('/api/session', (_req, res) => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ required: token !== null, authenticated: token === null });
  });
}
