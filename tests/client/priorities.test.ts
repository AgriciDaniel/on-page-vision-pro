import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeStats, priorityLines, priorityRows } from '../../lib/client/priorities';
import { buildMarkdownReport, pngLegendEntries } from '../../utils/exportUtils';
import { pageViewOf } from '../../lib/client/pageView';
import type { AuditFinding, AuditSession, PageAuditStats, ViewportAudit } from '../../types';

const item = (id: string, context: string, extra: Partial<AuditFinding> = {}): AuditFinding => ({
  id, viewport: 'desktop', current_text: '', visual_description: '', context, seo_analysis: '', suggested_optimization: '',
  severity: 'warning', category: 'Conversion', impact_score: 50, effort_estimate: 'medium', element_type: 'button', ...extra,
});
const scores = { overall: 60, clarity: 60, visual_hierarchy: 60, conversion: 60, trust_eeat: 60 };
const audit = (extra: Partial<ViewportAudit>): ViewportAudit =>
  ({ scores, overall_summary: 's', items: [], attention_hotspots: [], critical_count: 0, warning_count: 0, info_count: 0, ...extra }) as ViewportAudit;

const ITEMS = [
  item('a', 'Hero CTA', { severity: 'critical', box_px: [300, 200, 360, 500] }),
  item('b', 'Pricing table', { box_px: [15000, 300, 15100, 900] }),
  item('c', 'Footer links', { box_px: [19500, 100, 19560, 600] }),
];

test('rows follow rank, join their finding, and drop unknown or repeated ids', () => {
  const rows = priorityRows(
    audit({
      items: ITEMS,
      top_priorities: [
        { finding_id: 'b', rank: 2, reason: 'Hidden price.', blocker: false },
        { finding_id: 'zzz', rank: 3, reason: 'No such finding.', blocker: false },
        { finding_id: 'a', rank: 1, reason: 'Main action is unclear.', blocker: true },
        { finding_id: 'a', rank: 4, reason: 'Duplicate.', blocker: true },
      ],
    })
  );
  assert.deepEqual(rows.map((r) => [r.rank, r.item.id, r.blocker, r.reason]), [
    [1, 'a', true, 'Main action is unclear.'],
    [2, 'b', false, 'Hidden price.'],
  ]);
});

test('nothing to show when top_priorities is missing, empty or not an array (old sessions, viewport audits)', () => {
  assert.deepEqual(priorityRows(audit({ items: ITEMS })), []);
  assert.deepEqual(priorityRows(audit({ items: ITEMS, top_priorities: [] })), []);
  assert.deepEqual(priorityRows(audit({ items: ITEMS, top_priorities: 'x' as any })), []);
  assert.deepEqual(priorityRows(null), []);
});

test('stats line: sections, retries, time, and tokens only when present', () => {
  const stats: PageAuditStats = {
    calls: 15, retries: 1, thinkingLevel: 'low', concurrency: 4, totalMs: 48210,
    sections: Array.from({ length: 13 }, (_, i) => ({ index: i, attempts: 1, retried: false, ok: true, ms: 3000 })),
    overview: { attempts: 1, ok: true, ms: 2000 },
  };
  assert.equal(describeStats(stats), '13 sections audited, 1 retry, 48.2 s');
  assert.equal(
    describeStats({ ...stats, retries: 2, tokens: { prompt: 1, output: 1, thinking: 1, total: 182400 }, sections: [...stats.sections.slice(0, 12), { ...stats.sections[12], ok: false }] }),
    '12 of 13 sections audited, 2 retries, 48.2 s, 182,400 tokens'
  );
  assert.equal(describeStats(undefined), '');
});

test('PNG legend starts with Fix these first, numbered like the badges, blockers in red', () => {
  const a = audit({ items: ITEMS, mode: 'fullpage', top_priorities: [{ finding_id: 'c', rank: 1, reason: 'Broken.', blocker: true }] });
  const vp = { screenshotDataUrl: 'x', width: 1440, height: 900, analysis: a, overlays: [], naturalWidth: 1440, naturalHeight: 20000, captureMode: 'fullpage' as const, foldPx: 900 };
  const entries = pngLegendEntries(ITEMS, pageViewOf(vp, 'desktop'), priorityRows(a));
  assert.deepEqual(entries.slice(0, 2), [
    { text: 'Fix these first', kind: 'heading', color: '#0F172A' },
    { text: '1. #3 Footer links [blocker]: Broken.', kind: 'line', color: '#DC2626' },
  ]);
  assert.equal(entries[2].text, 'Finding positions (image 1440 x 20000 px)');
  assert.equal(pngLegendEntries(ITEMS, pageViewOf(vp, 'desktop'))[0].text.startsWith('Finding positions'), true);
});

test('Markdown has a Fix These First list with report labels, and none without priorities', () => {
  const mk = (a: ViewportAudit) =>
    ({ id: 's', url: 'https://a.example', domain: 'a.example', createdAt: 0, comparison: null, copyVariants: [], serpResearch: null, heroRedesigns: [],
      viewports: { desktop: { screenshotDataUrl: 'x', width: 1440, height: 900, analysis: a, overlays: [] }, mobile: null } }) as unknown as AuditSession;
  const md = buildMarkdownReport(mk(audit({ items: ITEMS, top_priorities: [{ finding_id: 'b', rank: 1, reason: 'Hidden price.', blocker: false }] })));
  assert.match(md, /## Fix These First\n1\. D2 Pricing table: Hidden price\./);
  assert.doesNotMatch(buildMarkdownReport(mk(audit({ items: ITEMS }))), /Fix These First/);
  assert.deepEqual(priorityLines([], () => ''), []);
});
