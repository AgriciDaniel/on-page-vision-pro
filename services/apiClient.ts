import type {
  AudioBriefing,
  AuditFinding,
  CaptureInfo,
  CaptureMode,
  AuditGoal,
  CodeFixPatch,
  ComparisonSummary,
  PageAuditProgress,
  CopyVariant,
  SeoMetadata,
  SerpResearchResult,
  ViewportAudit,
  ViewportKey,
} from '../types';
import { retryAfterSeconds, waitForSignIn } from '../lib/client/access';

export interface CaptureResult {
  url: string;
  domain: string;
  metadata: SeoMetadata;
  desktopScreenshot: string | null;
  mobileScreenshot: string | null;
  /** Provider and original size of each shot; null when that shot failed. */
  desktopCapture: CaptureInfo | null;
  mobileCapture: CaptureInfo | null;
  captureWarnings: string[];
}

export interface PreviewResult extends CaptureInfo {
  url: string;
  screenshotDataUrl: string;
  captureWarnings?: string[];
}

/**
 * Error from an API route. `message` is the server's own text (safe to show the user);
 * `status` is the HTTP status; `body` is the whole JSON error body, which can carry extra
 * fields such as `metadata` on a capture 422.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
  constructor(message: string, status: number, body: Record<string, unknown> | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** A capture the site blocked (422). Carries whatever page metadata the server still read. */
export class CaptureBlockedError extends ApiError {
  readonly metadata: SeoMetadata | null;
  /** Why each viewport failed, as the server explained it. */
  readonly warnings: string[];
  constructor(err: ApiError) {
    super(err.message, err.status, err.body);
    this.name = 'CaptureBlockedError';
    const meta = err.body?.metadata;
    this.metadata = meta && typeof meta === 'object' ? (meta as SeoMetadata) : null;
    const w = err.body?.captureWarnings;
    this.warnings = Array.isArray(w) ? w.filter((x): x is string => typeof x === 'string') : [];
  }
}

/** Per-call options. Pass `signal` to cancel the request (the promise rejects with an AbortError). */
export interface RequestOptions {
  signal?: AbortSignal;
}

/** True when an error came from an aborted request, so callers can drop it silently. */
export function isAbortError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'AbortError';
}

/**
 * fetch for /api routes. On a 401 (the server needs an access token) it waits for the sign-in card
 * and retries once; the server answers 401 before doing any work, so the retry never repeats a
 * model call. 429 (rate limit) is never retried: the caller shows the server's text.
 */
async function apiFetch(endpoint: string, init: RequestInit): Promise<Response> {
  const res = await fetch(endpoint, init);
  if (res.status !== 401) return res;
  await waitForSignIn(init.signal ?? undefined);
  return fetch(endpoint, init);
}

async function postJson<T>(endpoint: string, body: unknown, opts?: RequestOptions): Promise<T> {
  const res = await apiFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    if (!res.ok) {
      throw new ApiError(`Server error (${res.status}). Please retry.`, res.status, null);
    }
    throw new Error(`Unexpected non-JSON response from ${endpoint}. Please retry.`);
  }
  if (!res.ok) {
    const body = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
    const message = typeof body?.error === 'string' && body.error ? body.error : `Request failed (${res.status})`;
    throw new ApiError(message, res.status, body);
  }
  if (!data || typeof data !== 'object') {
    throw new Error(`Empty response from ${endpoint}. Please retry.`);
  }
  return data as T;
}

/** Whether this server needs an access token, and whether this browser already has a session. */
export interface AccessState {
  required: boolean;
  authenticated: boolean;
}

/** GET /api/session. Never throws: a server without the route (or offline) counts as open. */
export async function getAccessState(): Promise<AccessState> {
  try {
    const res = await fetch('/api/session', { cache: 'no-store' });
    if (!res.ok) return { required: false, authenticated: true };
    const data = await res.json();
    return { required: Boolean(data?.required), authenticated: Boolean(data?.authenticated) };
  } catch {
    return { required: false, authenticated: true };
  }
}

export interface SignInResult {
  ok: boolean;
  /** The server's text when sign-in failed. */
  error?: string;
  /** Seconds to wait after a 429. */
  retryAfterSec?: number | null;
}

/**
 * POST /api/session with the token. On success the server sets an HttpOnly cookie that the browser
 * sends from then on; the token is not kept anywhere by the client.
 */
export async function submitAccessToken(token: string): Promise<SignInResult> {
  try {
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token.trim() }),
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.authenticated) return { ok: true };
    const fallback =
      res.status === 401 ? 'That access token is not right.' : `Sign-in failed (${res.status}). Please retry.`;
    return {
      ok: false,
      error: typeof data?.error === 'string' && data.error ? data.error : fallback,
      retryAfterSec: res.status === 429 ? retryAfterSeconds(res.headers.get('Retry-After')) : null,
    };
  } catch {
    return { ok: false, error: 'Could not reach the server. Check the connection and retry.', retryAfterSec: null };
  }
}

/** DELETE /api/session: the server clears its cookie. */
export async function signOut(): Promise<void> {
  await fetch('/api/session', { method: 'DELETE' }).catch(() => undefined);
}

/** Capture a URL. A site that blocks capture rejects with CaptureBlockedError, which keeps the page metadata. */
export async function captureUrl(
  url: string,
  mode: CaptureMode = 'fullpage',
  opts?: RequestOptions
): Promise<CaptureResult> {
  try {
    return await postJson<CaptureResult>('/api/capture', { url, mode }, opts);
  } catch (err) {
    if (err instanceof ApiError && err.status === 422) throw new CaptureBlockedError(err);
    throw err;
  }
}

export async function captureCompetitorPreview(url: string, opts?: RequestOptions): Promise<PreviewResult> {
  return postJson<PreviewResult>('/api/capture-preview', { url }, opts);
}

export async function auditViewport(params: {
  screenshotDataUrl: string;
  viewport: ViewportKey;
  url?: string;
  metadata?: SeoMetadata;
  auditGoal?: AuditGoal;
  targetKeyword?: string;
}, opts?: RequestOptions): Promise<ViewportAudit> {
  const raw = await postJson<ViewportAudit>('/api/audit/viewport', params, opts);
  return toViewportAudit(raw);
}

/**
 * Audit a tall image. The server slices it into overlapping sections plus an overview, maps every
 * box back to the full image (box_2d on 0 to 1000 with decimals, box_px in image px) and returns
 * mode, image size and sections. `foldPx` tells it where the first screen ends.
 */
export async function auditPage(
  params: {
    screenshotDataUrl: string;
    viewport: ViewportKey;
    url?: string;
    metadata?: SeoMetadata;
    auditGoal?: AuditGoal;
    targetKeyword?: string;
    foldPx: number;
    /** Lets the client poll /api/audit/progress/<id> while this request runs. */
    progressId?: string;
  },
  opts?: RequestOptions
): Promise<ViewportAudit> {
  const raw = await postJson<ViewportAudit>('/api/audit/page', params, opts);
  return toViewportAudit(raw);
}

/** One read of a page audit's progress. Null while the server has not planned it yet (404) or on any error. */
export async function getAuditProgress(id: string, opts?: RequestOptions): Promise<PageAuditProgress | null> {
  try {
    const res = await fetch(`/api/audit/progress/${encodeURIComponent(id)}`, { signal: opts?.signal, cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as PageAuditProgress;
  } catch {
    return null;
  }
}

/**
 * Poll a page audit's progress every `intervalMs` until stopped, aborted, or the server says it is
 * done or failed. Returns the stop function; call it when the POST answers.
 */
export function pollAuditProgress(
  id: string,
  onUpdate: (p: PageAuditProgress) => void,
  opts: { intervalMs?: number; signal?: AbortSignal } = {}
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
  opts.signal?.addEventListener('abort', stop, { once: true });
  const tick = async () => {
    if (stopped) return;
    const p = await getAuditProgress(id, { signal: opts.signal });
    if (stopped) return;
    if (p) onUpdate(p);
    if (p && (p.status === 'done' || p.status === 'failed')) return stop();
    timer = setTimeout(tick, opts.intervalMs ?? 1500);
  };
  timer = setTimeout(tick, 600);
  return stop;
}

const SCORE_KEYS = ['clarity', 'visual_hierarchy', 'conversion', 'trust_eeat', 'overall'] as const;

/**
 * Check an audit from the server. The server already normalises it, so this only guards the
 * arrays and refuses an audit without real scores instead of inventing numbers.
 */
export function toViewportAudit(raw: any): ViewportAudit {
  const scores = raw?.scores;
  const hasScores =
    scores && SCORE_KEYS.every((k) => typeof scores[k] === 'number' && Number.isFinite(scores[k]));
  if (!hasScores) {
    throw new Error('The audit came back without scores, so it was not shown. Please retry.');
  }
  const items: AuditFinding[] = Array.isArray(raw.items) ? raw.items : [];
  const count = (sev: string, given: unknown) =>
    typeof given === 'number' && Number.isFinite(given)
      ? given
      : items.filter((i) => i.severity === sev).length;
  return {
    ...raw,
    items,
    attention_hotspots: Array.isArray(raw.attention_hotspots) ? raw.attention_hotspots : [],
    ...(raw.mode === 'fullpage'
      ? { sections: Array.isArray(raw.sections) ? raw.sections : [] }
      : {}),
    quick_wins: raw.quick_wins ?? { count: 0, estimated_impact: 0, top_3: [] },
    critical_count: count('critical', raw.critical_count),
    warning_count: count('warning', raw.warning_count),
    info_count: count('info', raw.info_count),
  };
}

export async function generateFindingFixCode(params: {
  finding: AuditFinding;
  domain?: string;
  url?: string;
}, opts?: RequestOptions): Promise<CodeFixPatch> {
  return postJson<CodeFixPatch>('/api/audit/fix-code', params, opts);
}

export async function auditMoreElements(params: {
  screenshotDataUrl: string;
  viewport: ViewportKey;
  existingItems: AuditFinding[];
  sectionIndex?: number;
}, opts?: RequestOptions): Promise<{ items: AuditFinding[]; sectionIndex?: number }> {
  return postJson<{ items: AuditFinding[]; sectionIndex?: number }>('/api/audit/more', params, opts);
}

export async function auditSingleElement(params: {
  croppedImageDataUrl: string;
  viewport: ViewportKey;
  box_2d: [number, number, number, number];
}, opts?: RequestOptions): Promise<{ item: AuditFinding }> {
  return postJson<{ item: AuditFinding }>('/api/audit/element', params, opts);
}

export async function compareViewports(params: {
  desktopScreenshot: string;
  mobileScreenshot: string;
  url?: string;
}, opts?: RequestOptions): Promise<ComparisonSummary> {
  return postJson<ComparisonSummary>('/api/audit/compare', params, opts);
}

export async function generateVisualRedesign(params: {
  imageDataUrl: string;
  mode: 'element' | 'full-hero';
  prompt: string;
  context?: string;
  viewport?: ViewportKey;
  topIssues?: string[];
}, opts?: RequestOptions): Promise<{ redesignedDataUrl: string; modelUsed?: string }> {
  return postJson<{ redesignedDataUrl: string; modelUsed?: string }>('/api/redesign', params, opts);
}

export async function runSerpResearch(params: {
  url?: string;
  pageTitle?: string;
  metaDescription?: string;
  summary?: string;
  auditGoal?: AuditGoal;
  targetKeyword?: string;
  metadata?: SeoMetadata;
}, opts?: RequestOptions): Promise<SerpResearchResult> {
  return postJson<SerpResearchResult>('/api/serp-research', params, opts);
}

export async function generateCopyVariants(params: {
  screenshotDataUrl?: string;
  url?: string;
  pageTitle?: string;
  currentHeadline?: string;
  auditSummary?: string;
  topIssues?: string[];
  auditGoal?: AuditGoal;
  targetKeyword?: string;
  serpContext?: string;
}, opts?: RequestOptions): Promise<{ variants: CopyVariant[] }> {
  return postJson<{ variants: CopyVariant[] }>('/api/copy-variants', params, opts);
}

export async function generateAudioBriefing(params: {
  domain: string;
  pageTitle: string;
  scores?: {
    overall: number;
    clarity: number;
    visual_hierarchy: number;
    conversion: number;
    trust_eeat: number;
  };
  mobileScore?: number;
  parityNote?: string;
  overallSummary: string;
  topFindings: string[];
  quickWins: string[];
  voice: 'Kore' | 'Charon';
}, opts?: RequestOptions): Promise<AudioBriefing> {
  return postJson<AudioBriefing>('/api/audio-brief', params, opts);
}

export async function streamStrategistChat(params: {
  messages: { role: 'user' | 'assistant'; content: string }[];
  screenshotDataUrl?: string;
  auditContext: string;
  onChunk: (text: string) => void;
}, opts?: RequestOptions): Promise<void> {
  const res = await apiFetch('/api/chat', {
    method: 'POST',
    signal: opts?.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: params.messages,
      screenshotDataUrl: params.screenshotDataUrl,
      auditContext: params.auditContext,
    }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData?.error || `Chat request failed (${res.status})`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('Streaming response unavailable.');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseBuffer(buffer);
    buffer = parsed.rest;
    for (const payload of parsed.events) {
      if (payload.error) throw new Error(payload.error);
      if (payload.text) params.onChunk(payload.text);
    }
  }
}

export interface ChatEvent {
  text?: string;
  done?: boolean;
  error?: string;
}

/**
 * Split buffered server-sent events into complete JSON payloads plus the unfinished remainder.
 * A malformed event is skipped (and logged) instead of ending the stream.
 */
export function parseSseBuffer(buffer: string): { events: ChatEvent[]; rest: string } {
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() || '';
  const events: ChatEvent[] = [];
  for (const block of blocks) {
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
    if (!dataLine) continue;
    const jsonStr = dataLine.slice(6).trim();
    if (!jsonStr) continue;
    try {
      const payload = JSON.parse(jsonStr);
      if (payload && typeof payload === 'object') events.push(payload as ChatEvent);
    } catch {
      console.warn('Skipped a malformed chat event:', jsonStr.slice(0, 120));
    }
  }
  return { events, rest };
}
