// Live progress for POST /api/audit/page, read with GET /api/audit/progress/:id.
//
// Why polling and not a streamed response: a full-page audit runs for up to 7 minutes, and
// buffering proxies (nginx default, some CDNs) hold a streamed body until it ends, so a stream
// would show nothing until the audit is over. A small GET every couple of seconds passes any
// proxy unchanged, needs no change to the POST response (it stays one JSON document), and the
// client can stop polling at any time.
//
// The client makes the id (crypto.randomUUID()), sends it as `progressId` in the POST body, and
// polls the GET route while the POST is in flight. Entries hold counts only, never page content,
// expire 10 minutes after the audit ends, and the store keeps at most 200.
import type { PageAuditProgress, PageAuditProgressEvent, SectionProgressState } from '../types.ts';
import { HttpError } from './http.ts';

const KEEP_AFTER_END_MS = 10 * 60_000;
const MAX_ENTRIES = 200;
const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

interface Entry {
  progress: PageAuditProgress;
  started: number;
  endedAt?: number;
}

const store = new Map<string, Entry>();

function prune(now = Date.now()): void {
  for (const [id, e] of store) if (e.endedAt !== undefined && now - e.endedAt > KEEP_AFTER_END_MS) store.delete(id);
  // Still over the cap: drop the oldest finished entries first, then the oldest running ones.
  if (store.size >= MAX_ENTRIES) {
    const ordered = [...store.entries()].sort((a, b) => Number(a[1].endedAt === undefined) - Number(b[1].endedAt === undefined) || a[1].started - b[1].started);
    for (const [id] of ordered.slice(0, store.size - MAX_ENTRIES + 1)) store.delete(id);
  }
}

/** Validates a client progress id: optional, but when present it must be 16 to 64 of [A-Za-z0-9_-]. */
export function readProgressId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new HttpError(400, 'progressId must be 16 to 64 letters, digits, "-" or "_" (for example crypto.randomUUID()).');
  }
  return value;
}

/** Registers a new audit. A reused id that is still running is refused, so one client cannot overwrite another's progress. */
export function startProgress(id: string): (event: PageAuditProgressEvent) => void {
  prune();
  const existing = store.get(id);
  if (existing && existing.endedAt === undefined) throw new HttpError(409, 'An audit with this progressId is already running.');
  const now = Date.now();
  const entry: Entry = {
    started: now,
    progress: {
      id,
      status: 'running',
      stage: 'preparing',
      sections: { total: 0, done: 0, failed: 0, running: [], states: [] },
      retries: 0,
      overview: 'pending',
      elapsedMs: 0,
      updatedAt: new Date(now).toISOString(),
    },
  };
  store.set(id, entry);
  return (event) => apply(entry, event);
}

function apply(entry: Entry, event: PageAuditProgressEvent): void {
  const p = entry.progress;
  const s = p.sections;
  const set = (index: number, state: SectionProgressState) => {
    if (index >= 0 && index < s.states.length) s.states[index] = state;
  };
  switch (event.type) {
    case 'plan':
      s.total = event.total;
      s.states = Array.from({ length: event.total }, () => 'queued');
      p.stage = 'sections';
      break;
    case 'section-start':
      set(event.index, 'running');
      break;
    case 'section-retry':
      p.retries++;
      set(event.index, 'retrying');
      break;
    case 'section-end':
      set(event.index, event.ok ? 'done' : 'failed');
      break;
    case 'overview-start':
      p.stage = 'overview';
      p.overview = 'running';
      break;
    case 'overview-end':
      p.overview = event.ok ? 'done' : 'failed';
      break;
    case 'finished':
      p.stage = 'done';
      p.status = event.ok ? 'done' : 'failed';
      if (!event.ok && event.error) p.error = event.error;
      entry.endedAt = Date.now();
      break;
  }
  s.done = s.states.filter((x) => x === 'done').length;
  s.failed = s.states.filter((x) => x === 'failed').length;
  s.running = s.states.flatMap((x, i) => (x === 'running' || x === 'retrying' ? [i] : []));
  p.elapsedMs = Date.now() - entry.started;
  p.updatedAt = new Date().toISOString();
}

/** A copy of the current progress, or undefined for an unknown or expired id. */
export function readProgress(id: string): PageAuditProgress | undefined {
  prune();
  const e = store.get(id);
  if (!e) return undefined;
  if (e.endedAt === undefined) e.progress.elapsedMs = Date.now() - e.started;
  return structuredClone(e.progress);
}

/** For tests only. */
export function clearProgressStore(): void {
  store.clear();
}
