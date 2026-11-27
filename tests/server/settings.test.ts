// Page-audit speed settings: named, with env overrides. Defaults since wave 3 (2026-11-24,
// .agent/results/opus-1-wave3.md): low thinking; sections 1,800 px on desktop and 2,400 px on
// mobile; 8 page-audit calls in flight across the whole process. Nothing is pinned in this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { PAGE_AUDIT_CONCURRENCY, PAGE_SECTION_HEIGHT, pageAuditLimiter, planPageSections } from '../../server/pageAudit.ts';
import { PAGE_AUDIT_THINKING_LEVEL, RATE_LIMIT_RETRY } from '../../server/gemini.ts';

const KEYS = ['GEMINI_PAGE_SECTION_HEIGHT_DESKTOP', 'GEMINI_PAGE_SECTION_HEIGHT_MOBILE', 'GEMINI_PAGE_AUDIT_CONCURRENCY', 'GEMINI_PAGE_AUDIT_THINKING', 'GEMINI_RATE_LIMIT_RETRIES'];
const read = (env: Record<string, string>) => {
  const base = { ...process.env };
  for (const k of KEYS) delete base[k];
  const script =
    "Promise.all([import('./server/pageAudit.ts'), import('./server/gemini.ts')]).then(([p, g]) => console.log(JSON.stringify([p.PAGE_SECTION_HEIGHT.desktop, p.PAGE_SECTION_HEIGHT.mobile, p.PAGE_AUDIT_CONCURRENCY, p.pageAuditLimiter.limit, g.PAGE_AUDIT_THINKING_LEVEL, g.RATE_LIMIT_RETRY.attempts])))";
  const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', script], { env: { ...base, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out.trim().split('\n').pop()!);
};

test('defaults: desktop 1,800 px, mobile 2,400 px, 8 shared, low thinking, 2 same-model 429 retries', () => {
  assert.deepEqual(read({}), [1800, 2400, 8, 8, 'LOW', 2]);
  if (!KEYS.some((k) => process.env[k])) {
    assert.deepEqual(PAGE_SECTION_HEIGHT, { desktop: 1800, mobile: 2400 });
    assert.equal(PAGE_AUDIT_CONCURRENCY, 8);
    assert.equal(pageAuditLimiter.limit, 8);
    assert.equal(PAGE_AUDIT_THINKING_LEVEL, 'LOW');
    assert.equal(RATE_LIMIT_RETRY.attempts, 2);
  }
});

test('section plans at the defaults: the 2026-11-24 pages are 7 desktop sections and 14 mobile ones', () => {
  assert.equal(planPageSections(1440, 10_539, 1800).length, 7);
  assert.equal(planPageSections(780, 28_058, 2400).length, 14);
  assert.ok(planPageSections(780, 28_058, 2400).every((s) => s.height <= 2400));
  // A 780 x 2,400 mobile slice is fewer pixels than a 1440 x 1,800 desktop one.
  assert.ok(780 * 2400 < 1440 * 1800);
  // The 16-section cap still stretches short sections on very long pages.
  assert.equal(planPageSections(780, 28_058, 900).length, 16);
});

test('env overrides: valid values are used; out of range or not whole falls back to the default', () => {
  assert.deepEqual(
    read({ GEMINI_PAGE_SECTION_HEIGHT_DESKTOP: '2400', GEMINI_PAGE_SECTION_HEIGHT_MOBILE: '1800', GEMINI_PAGE_AUDIT_CONCURRENCY: '12', GEMINI_PAGE_AUDIT_THINKING: 'medium', GEMINI_RATE_LIMIT_RETRIES: '0' }),
    [2400, 1800, 12, 12, 'MEDIUM', 0]
  );
  assert.deepEqual(
    read({ GEMINI_PAGE_SECTION_HEIGHT_DESKTOP: '500', GEMINI_PAGE_SECTION_HEIGHT_MOBILE: '2400.5', GEMINI_PAGE_AUDIT_CONCURRENCY: '17', GEMINI_PAGE_AUDIT_THINKING: 'minimal', GEMINI_RATE_LIMIT_RETRIES: '9' }),
    [1800, 2400, 8, 8, 'LOW', 2]
  );
});
