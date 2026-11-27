import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSession, runTx, toHeader } from '../../services/historyStore';
import type { AuditSession } from '../../types';

/** Minimal stand-in for an IDBTransaction: the test decides when it completes or aborts. */
function fakeDb() {
  const tx: any = { error: null, oncomplete: null, onabort: null, abort() {} };
  const db: any = { transaction: () => tx };
  return { db: db as IDBDatabase, tx };
}

test('runTx resolves with the request result when the transaction commits', async () => {
  const { db, tx } = fakeDb();
  const req = { result: 42 } as unknown as IDBRequest<number>;
  const p = runTx(db, ['headers'], 'readonly', () => req);
  tx.oncomplete();
  assert.equal(await p, 42);
});

test('runTx rejects when the transaction aborts (quota failure fires abort, not error)', async () => {
  const { db, tx } = fakeDb();
  const p = runTx(db, ['audits', 'headers'], 'readwrite', () => undefined);
  tx.error = Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
  tx.onabort();
  await assert.rejects(p, (err: any) => err.name === 'QuotaExceededError');
});

test('runTx rejects when opening the transaction throws', async () => {
  const db = {
    transaction: () => {
      throw new Error('no such store');
    },
  } as unknown as IDBDatabase;
  await assert.rejects(runTx(db, ['missing'], 'readonly', () => undefined), /no such store/);
});

function oldSession(): AuditSession {
  return {
    id: 'audit-1',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    sourceType: 'url',
    url: 'https://example.com/',
    domain: 'example.com',
    pageTitle: 'Example',
    seoMetadata: {
      title: 'Example',
      description: '',
      h1s: [],
      h2s: [],
      totalImages: 0,
      missingAltImages: 0,
      ctaTexts: [],
      wordCount: 0,
      textPreview: '',
    },
    viewports: {
      desktop: {
        screenshotDataUrl: 'data:image/png;base64,AAAA',
        width: 1440,
        height: 900,
        analysis: null,
        overlays: [],
      },
      mobile: null,
    },
    comparison: null,
    heroRedesigns: [],
    serpResearch: null,
    copyVariants: [],
    chatHistory: [],
    audioBriefing: null,
  };
}

test('normalizeSession gives a pre-wave-1 session safe viewport defaults', () => {
  const s = normalizeSession(oldSession());
  const d = s.viewports.desktop!;
  assert.equal(d.captureMode, 'viewport');
  assert.equal(d.naturalWidth, 1440);
  assert.equal(d.naturalHeight, 900);
  assert.equal(d.foldPx, 900);
  assert.equal(s.viewports.mobile, null);
});

test('toHeader never carries the full screenshot', () => {
  const h = toHeader(oldSession(), 'data:image/jpeg;base64,THUMB');
  assert.equal(h.thumbnailDataUrl, 'data:image/jpeg;base64,THUMB');
  assert.equal(h.desktopScore, null);
  assert.ok(!JSON.stringify(h).includes('base64,AAAA'));
});

test('saveAuditSession without IndexedDB keeps the session readable in this tab', async () => {
  const { saveAuditSession, getAuditSession, listAuditHeaders } = await import('../../services/historyStore');
  const s = oldSession();
  await saveAuditSession({ ...s, pageTitle: 'first' });
  await saveAuditSession({ ...s, pageTitle: 'second' });
  const loaded = await getAuditSession(s.id);
  assert.equal(loaded?.pageTitle, 'second');
  const headers = await listAuditHeaders();
  assert.equal(headers.length, 1);
  assert.equal(headers[0].thumbnailDataUrl, '');
});

test('normalizeSession prefers a measured size over the assumed viewport size', () => {
  const base = oldSession();
  const s = normalizeSession(
    { ...base, viewports: { desktop: null, mobile: { ...base.viewports.desktop!, width: 390, height: 844 } } },
    { mobile: { width: 780, height: 1688 } }
  );
  assert.equal(s.viewports.mobile!.naturalWidth, 780);
  assert.equal(s.viewports.mobile!.foldPx, 1688);
});
