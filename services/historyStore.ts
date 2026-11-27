/**
 * Local audit history in IndexedDB.
 *
 * Two stores: `headers` holds one small row per audit (scores and a 320x200 JPEG thumbnail) and
 * is all the history list ever reads; `audits` holds full sessions and is read one at a time on
 * open. Saves write both in one transaction and reject with a SaveError when the browser refuses
 * (quota full, private mode). A failed save is kept in memory so the audit stays usable in this tab.
 */
import type { AuditHistoryHeader, AuditSession, ViewportKey } from '../types';
import { makeThumbnail, measureImage, withViewportDefaults } from '../lib/client/images';

const DB_NAME = 'onpage_vision_pro_db';
/** v1: `audits` only. v2: adds `headers`, filled from existing audits during the upgrade. */
const DB_VERSION = 2;
const SESSIONS = 'audits';
const HEADERS = 'headers';

/** Sessions whose last save failed, plus everything when IndexedDB is unavailable. */
const memorySessions = new Map<string, AuditSession>();
const memoryHeaders = new Map<string, AuditHistoryHeader>();

/** Last thumbnail per session and the screenshot it was made from, so unchanged screenshots are not re-decoded. */
const thumbCache = new Map<string, { source: string; thumb: string }>();

export class SaveError extends Error {
  readonly quotaExceeded: boolean;
  constructor(cause: unknown) {
    const name = (cause as { name?: string } | null)?.name;
    const quotaExceeded = name === 'QuotaExceededError';
    super(
      quotaExceeded
        ? 'Browser storage is full, so this audit was not saved. It stays open in this tab. Delete old audits to free space.'
        : 'This audit could not be saved to browser storage. It stays open in this tab.'
    );
    this.name = 'SaveError';
    this.quotaExceeded = quotaExceeded;
  }
}

// --- connection --------------------------------------------------------------

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = (db: IDBDatabase | null) => {
      if (settled) {
        db?.close();
        return;
      }
      settled = true;
      resolve(db);
    };
    try {
      const req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => upgrade(req.result, req.transaction!, event.oldVersion);
      req.onsuccess = () => settle(req.result);
      req.onerror = () => settle(null);
      // Another tab still holds v1 open. Work from memory for now; the next call retries.
      req.onblocked = () => {
        dbPromise = null;
        settle(null);
      };
    } catch {
      settle(null);
    }
  });
}

function upgrade(db: IDBDatabase, tx: IDBTransaction, oldVersion: number): void {
  if (!db.objectStoreNames.contains(SESSIONS)) {
    db.createObjectStore(SESSIONS, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(HEADERS)) {
    db.createObjectStore(HEADERS, { keyPath: 'id' });
  }
  if (oldVersion >= 1 && oldVersion < 2) {
    // Build a header for every existing audit. Thumbnails are filled later by backfillThumbnails().
    const headers = tx.objectStore(HEADERS);
    const cursorReq = tx.objectStore(SESSIONS).openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      const session = cursor.value as AuditSession;
      if (session && typeof session === 'object' && session.id) {
        headers.put(toHeader(session, ''));
      }
      cursor.continue();
    };
  }
}

/** One connection per page, reopened if another tab upgrades the database. */
function getDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = openDb().then((db) => {
      if (db) {
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        db.onclose = () => {
          dbPromise = null;
        };
      }
      return db;
    });
  }
  return dbPromise;
}

/**
 * Run one transaction. Resolves with the result of the request `body` returns (if any) once the
 * transaction commits. Rejects if it aborts for any reason, including a quota failure at commit,
 * which fires `abort` and never `error`.
 */
export function runTx<T = undefined>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => IDBRequest<T> | void
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(stores, mode);
    } catch (err) {
      reject(err);
      return;
    }
    let req: IDBRequest<T> | void;
    try {
      req = body(tx);
    } catch (err) {
      try {
        tx.abort();
      } catch {
        // already finished
      }
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
  });
}

// --- shape helpers ------------------------------------------------------------

export function toHeader(session: AuditSession, thumbnailDataUrl: string): AuditHistoryHeader {
  const desktop = session?.viewports?.desktop;
  const mobile = session?.viewports?.mobile;
  const criticalCount =
    (desktop?.analysis?.critical_count || 0) + (mobile?.analysis?.critical_count || 0);

  return {
    id: session.id,
    createdAt: session.createdAt,
    domain: session.domain || 'audited-page',
    url: session.url || '',
    pageTitle: session.pageTitle || session.domain || 'Audited Page',
    sourceType: session.sourceType || 'url',
    desktopScore: desktop?.analysis?.scores?.overall ?? null,
    mobileScore: mobile?.analysis?.scores?.overall ?? null,
    criticalCount,
    thumbnailDataUrl,
  };
}

type MeasuredSizes = Partial<Record<ViewportKey, { width: number; height: number }>>;

/** Give sessions saved by older versions the fields newer code relies on. `measured` holds decoded image sizes where known. */
export function normalizeSession(session: AuditSession, measured: MeasuredSizes = {}): AuditSession {
  const viewports = { ...session.viewports };
  for (const key of ['desktop', 'mobile'] as ViewportKey[]) {
    const vp = viewports[key];
    if (vp) viewports[key] = withViewportDefaults(vp, key, measured[key]);
  }
  return { ...session, viewports };
}

/** Decode the screenshots of an old session that has no recorded size, so its fold is right. Browser only. */
async function measureLegacy(session: AuditSession): Promise<MeasuredSizes> {
  const sizes: MeasuredSizes = {};
  if (typeof document === 'undefined') return sizes;
  for (const key of ['desktop', 'mobile'] as ViewportKey[]) {
    const vp = session.viewports?.[key];
    if (vp && !vp.naturalWidth && vp.screenshotDataUrl) {
      try {
        sizes[key] = await measureImage(vp.screenshotDataUrl);
      } catch {
        // Undecodable: fall back to the viewport size.
      }
    }
  }
  return sizes;
}

function primaryScreenshot(session: AuditSession): string {
  return session.viewports?.desktop?.screenshotDataUrl || session.viewports?.mobile?.screenshotDataUrl || '';
}

async function thumbnailFor(session: AuditSession): Promise<string> {
  const source = primaryScreenshot(session);
  if (!source) return '';
  const cached = thumbCache.get(session.id);
  if (cached && cached.source === source) return cached.thumb;
  let thumb = '';
  try {
    if (typeof document !== 'undefined') thumb = await makeThumbnail(source);
  } catch {
    thumb = '';
  }
  thumbCache.set(session.id, { source, thumb });
  return thumb;
}

function byNewest(a: AuditHistoryHeader, b: AuditHistoryHeader): number {
  return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
}

// --- public API ---------------------------------------------------------------

/** Pending save per audit. Saves of one audit run in call order, so an older copy never lands last. */
const saveQueue = new Map<string, Promise<void>>();

/** Save a session and its header. Rejects with SaveError if the browser refuses; the session is then kept in memory. */
export function saveAuditSession(session: AuditSession): Promise<void> {
  const previous = saveQueue.get(session.id) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => writeSession(session));
  saveQueue.set(session.id, current);
  const cleanup = () => {
    if (saveQueue.get(session.id) === current) saveQueue.delete(session.id);
  };
  current.then(cleanup, cleanup);
  return current;
}

/** Keeps large audio WAV buffers in memory for the current tab instead of bloating IndexedDB. */
const memoryAudio = new Map<string, string>();
const MAX_STORED_HERO_REDESIGNS = 6;

function compactForStorage(session: AuditSession): AuditSession {
  const heroRedesigns = (session.heroRedesigns || [])
    .slice(0, MAX_STORED_HERO_REDESIGNS)
    .map(({ originalDataUrl: _dropOriginal, ...rest }) => rest);
  if (session.audioBriefing?.audioDataUrl) {
    memoryAudio.set(session.id, session.audioBriefing.audioDataUrl);
  }
  const audioBriefing = session.audioBriefing
    ? { ...session.audioBriefing, audioDataUrl: '' }
    : null;
  return { ...session, heroRedesigns, audioBriefing };
}

function hydrateFromMemory(session: AuditSession): AuditSession {
  if (session.audioBriefing && !session.audioBriefing.audioDataUrl) {
    const cached = memoryAudio.get(session.id);
    if (cached) {
      return { ...session, audioBriefing: { ...session.audioBriefing, audioDataUrl: cached } };
    }
  }
  return session;
}

async function writeSession(session: AuditSession): Promise<void> {
  const header = toHeader(session, await thumbnailFor(session));
  const db = await getDb();
  if (!db) {
    memorySessions.set(session.id, session);
    memoryHeaders.set(session.id, header);
    return;
  }
  const stored = compactForStorage(session);
  try {
    await runTx(db, [SESSIONS, HEADERS], 'readwrite', (tx) => {
      tx.objectStore(SESSIONS).put(stored);
      tx.objectStore(HEADERS).put(header);
    });
    memorySessions.delete(session.id);
    memoryHeaders.delete(session.id);
  } catch (err) {
    memorySessions.set(session.id, session);
    memoryHeaders.set(session.id, header);
    throw new SaveError(err);
  }
}

/** Headers only, newest first. Never loads a full session. */
export async function listAuditHeaders(): Promise<AuditHistoryHeader[]> {
  const db = await getDb();
  let stored: AuditHistoryHeader[] = [];
  if (db) {
    try {
      stored = ((await runTx(db, [HEADERS], 'readonly', (tx) => tx.objectStore(HEADERS).getAll())) ||
        []) as AuditHistoryHeader[];
    } catch {
      stored = [];
    }
  }
  const byId = new Map<string, AuditHistoryHeader>();
  for (const h of stored) if (h && h.id) byId.set(h.id, h);
  for (const h of memoryHeaders.values()) byId.set(h.id, h); // unsaved changes are newer
  return Array.from(byId.values()).sort(byNewest);
}

export async function getAuditSession(id: string): Promise<AuditSession | null> {
  const inMemory = memorySessions.get(id);
  if (inMemory) return normalizeSession(inMemory, await measureLegacy(inMemory));
  const db = await getDb();
  if (!db) return null;
  try {
    let header: AuditHistoryHeader | undefined;
    const session = (await runTx(db, [SESSIONS, HEADERS], 'readonly', (tx) => {
      const headerReq = tx.objectStore(HEADERS).get(id);
      headerReq.onsuccess = () => {
        header = headerReq.result as AuditHistoryHeader | undefined;
      };
      return tx.objectStore(SESSIONS).get(id);
    })) as AuditSession | undefined;
    if (!session) return null;
    // Remember the stored thumbnail so the next save does not decode the screenshot again.
    if (header?.thumbnailDataUrl) {
      thumbCache.set(id, { source: primaryScreenshot(session), thumb: header.thumbnailDataUrl });
    }
    return hydrateFromMemory(normalizeSession(session, await measureLegacy(session)));
  } catch {
    return null;
  }
}

export async function deleteAuditSession(id: string): Promise<void> {
  memorySessions.delete(id);
  memoryHeaders.delete(id);
  memoryAudio.delete(id);
  thumbCache.delete(id);
  const db = await getDb();
  if (!db) return;
  await runTx(db, [SESSIONS, HEADERS], 'readwrite', (tx) => {
    tx.objectStore(SESSIONS).delete(id);
    tx.objectStore(HEADERS).delete(id);
  });
}

const backfillTried = new Set<string>();

/**
 * Make thumbnails for headers that have none (audits migrated from v1). Loads one session at a
 * time. Returns how many headers changed, so the caller knows whether to refresh the list.
 */
export async function backfillThumbnails(): Promise<number> {
  const db = await getDb();
  if (!db || typeof document === 'undefined') return 0;
  const headers = await listAuditHeaders();
  let changed = 0;
  for (const h of headers) {
    if (h.thumbnailDataUrl || backfillTried.has(h.id) || memoryHeaders.has(h.id)) continue;
    backfillTried.add(h.id);
    const session = await getAuditSession(h.id);
    if (!session) continue;
    const thumb = await thumbnailFor(session);
    if (!thumb) continue;
    try {
      await runTx(db, [HEADERS], 'readwrite', (tx) => {
        const store = tx.objectStore(HEADERS);
        const req = store.get(h.id);
        req.onsuccess = () => {
          const current = req.result as AuditHistoryHeader | undefined;
          if (current && !current.thumbnailDataUrl) store.put({ ...current, thumbnailDataUrl: thumb });
        };
      });
      changed += 1;
    } catch {
      // Leave it without a thumbnail; the list shows an icon instead.
    }
  }
  return changed;
}
