import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findingTwins } from '../../lib/client/twins';
import { mergedPriorityRows } from '../../lib/client/priorities';
import type { AuditFinding, ViewportAudit } from '../../types';

const item = (id: string, context: string, current_text: string, y: number, extra: Partial<AuditFinding> = {}): AuditFinding => ({
  id, viewport: id.startsWith('d') ? 'desktop' : 'mobile', current_text, visual_description: '', context, seo_analysis: '',
  suggested_optimization: '', severity: 'warning', category: 'Conversion', impact_score: 50, effort_estimate: 'medium',
  element_type: 'button', box_px: [y, 0, y + 40, 100], ...extra,
});
const scores = { overall: 60, clarity: 60, visual_hierarchy: 60, conversion: 60, trust_eeat: 60 };
const audit = (items: AuditFinding[], top: [string, boolean][], height: number): ViewportAudit =>
  ({ scores, items, image: { width: 1000, height }, sections: [],
     top_priorities: top.map(([finding_id, blocker], i) => ({ finding_id, rank: i + 1, reason: `why ${finding_id}`, blocker })),
     overall_summary: '', strategic_advisor: '' } as unknown as ViewportAudit);

const desk = audit([
  item('d1', 'Hero Headline', 'Make AI useful for every marketer', 100),
  item('d2', 'Pricing Table', 'Choose your plan today and save', 3000),
  item('d3', 'Footer Links', 'Privacy Terms Cookies Accessibility', 9000),
], [['d1', true], ['d2', false]], 10000);
const mob = audit([
  item('m1', 'Hero H1', 'Make AI useful for every marketer', 300),
  item('m2', 'Sticky Bar', 'Join the community now for free', 1500),
  item('m3', 'Footer Links', 'Privacy Terms Cookies Accessibility', 27000),
], [['m2', false], ['m1', false]], 28000);

test('findingTwins links the same issue both ways and leaves the rest unlinked', () => {
  const twins = findingTwins(desk, mob);
  assert.equal(twins.get('d1')?.item.id, 'm1');
  assert.equal(twins.get('m1')?.viewport, 'desktop');
  assert.equal(twins.get('d3')?.item.id, 'm3');
  assert.equal(twins.has('d2'), false);
  assert.equal(findingTwins(desk, null).size, 0);
});

test('mergedPriorityRows: a problem ranked on both devices is one row with both findings', () => {
  const rows = mergedPriorityRows(desk, mob, findingTwins(desk, mob));
  assert.deepEqual(rows.map((r) => [r.rank, r.item.id, r.alsoOn?.item.id ?? null, r.blocker]), [
    [1, 'd1', 'm1', true],
    [2, 'm2', null, false],
    [3, 'd2', null, false],
  ]);
  assert.equal(rows[0].viewport, 'desktop');
  assert.equal(rows[1].viewport, 'mobile');
});

test('mergedPriorityRows: without twins it alternates the two lists; one device alone is unchanged', () => {
  const rows = mergedPriorityRows(desk, mob, new Map());
  assert.deepEqual(rows.map((r) => r.item.id), ['d1', 'm2', 'd2', 'm1']);
  assert.deepEqual(mergedPriorityRows(desk, null, new Map()).map((r) => r.item.id), ['d1', 'd2']);
});

test('mergedPriorityRows: a merged row reads desktop first even when mobile ranked it higher', () => {
  const m2 = audit(mob.items, [['m1', false], ['m2', false]], 28000);
  const d2 = audit(desk.items, [['d2', false], ['d1', true]], 10000);
  const rows = mergedPriorityRows(d2, m2, findingTwins(d2, m2));
  const merged = rows.find((r) => r.alsoOn)!;
  assert.equal(merged.item.id, 'd1');
  assert.equal(merged.viewport, 'desktop');
  assert.equal(merged.alsoOn!.item.id, 'm1');
  assert.equal(merged.alsoOn!.viewport, 'mobile');
  assert.equal(merged.reason, 'why m1');
  assert.equal(merged.blocker, true);
});
