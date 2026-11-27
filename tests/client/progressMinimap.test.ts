import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeProgress } from '../../lib/client/progress';
import { planMinimap, MAX_PLAIN_TICKS } from '../../lib/client/minimap';
import { describeStats } from '../../lib/client/priorities';
import type { PageView } from '../../lib/client/pageView';
import type { AuditFinding, PageAuditProgress, PageAuditStats } from '../../types';

const prog = (extra: Partial<PageAuditProgress> = {}): PageAuditProgress => ({
  id: 'abc', status: 'running', stage: 'sections',
  sections: { total: 7, done: 2, failed: 0, running: [2, 3, 4], states: ['done', 'done', 'running', 'running', 'retrying', 'queued', 'queued'] },
  retries: 1, overview: 'pending', elapsedMs: 9000, updatedAt: '2026-11-24T10:00:00Z', ...extra,
});

test('describeProgress: sections, running, retrying and retries', () => {
  const v = describeProgress(prog())!;
  assert.equal(v.line, '2 of 7 sections done; running 3, 4; retrying section 5; 2 queued (1 retry)');
  assert.equal(v.fraction, 2 / 8);
  assert.equal(v.states.length, 7);
});

test('describeProgress: planning, overview, failed and missing', () => {
  assert.equal(describeProgress(null), null);
  assert.equal(describeProgress(prog({ stage: 'preparing', sections: { total: 0, done: 0, failed: 0, running: [], states: [] } }))!.line, 'Planning the page sections');
  const ov = describeProgress(prog({ stage: 'overview', retries: 0, overview: 'running',
    sections: { total: 7, done: 6, failed: 1, running: [], states: [] } }))!;
  assert.equal(ov.line, 'All 7 sections read; writing the page summary (1 failed)');
  assert.equal(ov.fraction, 7 / 8);
  assert.match(describeProgress(prog({ status: 'failed', error: 'Budget refused.' }))!.line, /^Stopped: Budget refused\.$/);
});

const view = (sections: PageView['sections']): PageView =>
  ({ size: { width: 780, height: 10000 }, mode: 'fullpage', foldPx: 1688, showFold: true, sections } as PageView);
const tick = (id: string, y: number, severity: AuditFinding['severity'] = 'warning') => ({
  item: { id, severity, context: id } as AuditFinding, rect: { x: 0, y, width: 10, height: 10 },
});

test('planMinimap: few findings stay plain ticks', () => {
  const boxed = Array.from({ length: MAX_PLAIN_TICKS }, (_, i) => tick(`f${i}`, i * 100));
  const plan = planMinimap(boxed, view([]));
  assert.equal(plan.ticks.length, MAX_PLAIN_TICKS);
  assert.equal(plan.density.length, 0);
});

test('planMinimap: many findings keep criticals and blockers as ticks, the rest as section density', () => {
  const boxed = Array.from({ length: 40 }, (_, i) => tick(`f${i}`, i * 240, i === 3 ? 'critical' : 'warning'));
  const sections = [
    { index: 0, yStart: 0, yEnd: 5200, label: 'Top' },
    { index: 1, yStart: 5000, yEnd: 10000, label: 'Bottom' },
  ];
  const plan = planMinimap(boxed, view(sections), new Set(['f10']));
  assert.deepEqual(plan.ticks.map((t) => t.item.id).sort(), ['f10', 'f3']);
  assert.deepEqual(plan.density.map((d) => [d.label, d.yStart, d.yEnd]), [['Top', 0, 5000], ['Bottom', 5000, 10000]]);
  assert.equal(plan.density.reduce((n, d) => n + d.count, 0), 38);
});

test('planMinimap: no sections falls back to one segment per screen', () => {
  const boxed = Array.from({ length: 30 }, (_, i) => tick(`f${i}`, i * 300));
  const plan = planMinimap(boxed, view([]));
  assert.ok(plan.density.every((d) => d.label.startsWith('Screen ')));
  assert.equal(plan.density.reduce((n, d) => n + d.count, 0), 30);
});

test('describeStats: says when findings were left out over the cap', () => {
  const stats = { calls: 8, retries: 0, thinkingLevel: 'low', concurrency: 3, totalMs: 1000, sections: [], overview: true,
    findings: { found: 64, returned: 30, droppedLowValue: 4, omittedOverCap: 30, cap: 30 } } as unknown as PageAuditStats;
  assert.match(describeStats(stats), /30 of 64 findings shown/);
  assert.doesNotMatch(describeStats({ ...stats, findings: { found: 20, returned: 20, droppedLowValue: 0, omittedOverCap: 0, cap: 30 } } as PageAuditStats), /findings shown/);
});

test('describeProgress: shared slots, queued sections and an overview waiting for a slot', () => {
  const waiting = describeProgress(prog({ retries: 0, sections: { total: 14, done: 3, failed: 0, running: [],
    states: [...Array(3).fill('done'), ...Array(11).fill('queued')] } }))!;
  assert.equal(waiting.line, '3 of 14 sections done; 11 waiting for a free slot');
  const overviewWait = describeProgress(prog({ retries: 2, overview: 'pending', sections: { total: 14, done: 14, failed: 0, running: [],
    states: Array(14).fill('done') } }))!;
  assert.equal(overviewWait.line, 'All 14 sections read; waiting for a free slot to write the page summary (2 retries)');
});

test('describeStats: mentions retries caused by rate limits only when there were some', () => {
  const base = { calls: 8, retries: 2, thinkingLevel: 'low', concurrency: 8, totalMs: 1000, sections: [], overview: true } as unknown as PageAuditStats;
  assert.match(describeStats({ ...base, rateLimitRetries: 2 } as PageAuditStats), /2 retries, 2 after rate limits/);
  assert.doesNotMatch(describeStats({ ...base, rateLimitRetries: 0 } as PageAuditStats), /rate limits/);
});

test('describeProgress: the real run 2 moment reads without a contradiction', () => {
  // Logged at 103.9 s: states dddddddddrrrdr, done 10, running [9, 10, 11, 13].
  const states = 'dddddddddrrrdr'.split('').map((c) => (c === 'd' ? 'done' : 'running')) as PageAuditProgress['sections']['states'];
  const v = describeProgress(prog({ retries: 0, sections: { total: 14, done: 10, failed: 0, running: [9, 10, 11, 13], states } }))!;
  assert.equal(v.line, '10 of 14 sections done; running 10, 11, 12, 14');
});

test('describeProgress: a section the states mark done is never listed as running', () => {
  const states = ['done', 'done', 'running', 'queued'] as PageAuditProgress['sections']['states'];
  const v = describeProgress(prog({ retries: 0, sections: { total: 4, done: 2, failed: 0, running: [1, 2], states } }))!;
  assert.equal(v.line, '2 of 4 sections done; running 3; 1 queued');
});
