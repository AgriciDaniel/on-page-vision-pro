import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanFindings,
  dedupeAgainst,
  finalizeViewportAudit,
  normalizeCodeFix,
  normalizeComparison,
  normalizeCopyVariants,
  normalizeSerp,
} from '../../server/normalize.ts';
import { readAuditGoal, readStringArray, readViewport, toPublicError, HttpError } from '../../server/http.ts';

test('normalizeComparison coerces severities and strings the model got wrong', () => {
  const out = normalizeComparison({
    parity_score: 140,
    parity_issues: [
      { title: 'Nav', severity: 'blocker', desktop_behavior: 1, mobile_behavior: null, recommended_fix: 'x' },
      'garbage',
      null,
    ],
  });
  assert.equal(out.parity_score, 100);
  assert.equal(out.parity_issues.length, 1);
  assert.equal(out.parity_issues[0].severity, 'warning');
  assert.equal(out.parity_issues[0].desktop_behavior, '1');
  assert.equal(out.parity_issues[0].mobile_behavior, '');
  assert.equal(typeof out.generated_at, 'string');
});

test('normalizeSerp drops competitors whose URL the capture route would refuse', () => {
  const out = normalizeSerp(
    {
      competitors: [
        { name: 'Good', url: 'https://competitor.com' },
        { name: 'Bare', url: 'rival.io/pricing' },
        { name: 'Meta', url: 'http://169.254.169.254/' },
        { name: 'Local', url: 'http://localhost:3000' },
        { name: 'None' },
      ],
      keyword_opportunities: ['a', 2],
    },
    []
  );
  assert.deepEqual(out.competitors.map((c) => c.url), ['https://competitor.com/', 'https://rival.io/pricing']);
  assert.deepEqual(out.keyword_opportunities, ['a', '2']);
  assert.equal(out.niche_summary, 'Market category identified from live search.');
});

test('normalizeCodeFix rejects a patch without code and fills defaults', () => {
  assert.equal(normalizeCodeFix({ title: 'x', code: '   ' }), null);
  assert.deepEqual(normalizeCodeFix({ code: '<a>' }), { language: 'html', title: 'Suggested fix', code: '<a>', notes: '', ticket_markdown: '' });
});

test('normalizeCopyVariants skips non-objects', () => {
  const v = normalizeCopyVariants({ variants: [{ headline: 'H' }, 3] });
  assert.equal(v.length, 1);
  assert.equal(v[0].angle, 'Variant 1');
});

test('cleanFindings validates box_confidence and dedupeAgainst ignores malformed existing boxes', () => {
  const items = cleanFindings(
    [{ element_type: 'button', box_2d: [100, 100, 200, 400], box_confidence: 'certain', severity: 'critical' }],
    'desktop'
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].box_confidence, 'high'); // derived from area, not the invalid value
  assert.equal(dedupeAgainst(items, [{ box_2d: undefined }, { box_2d: 'x' as any }]).length, 1);
  assert.equal(dedupeAgainst(items, [{ box_2d: [110, 110, 190, 390] }]).length, 0);
});

test('finalizeViewportAudit computes overall from clamped scores', () => {
  const a = finalizeViewportAudit({ scores: { clarity: 200, visual_hierarchy: 0, conversion: 'x', trust_eeat: 50 } }, 'desktop', 'm');
  assert.equal(a.scores.clarity, 100);
  assert.equal(a.scores.visual_hierarchy, 70); // 0 falls back, as before this wave
  assert.equal(a.scores.overall, Math.round((100 + 70 + 70 + 50) / 4));
  assert.equal(a.model_used, 'm');
});

test('request readers reject bad viewport, goal and arrays with 400', () => {
  assert.equal(readViewport(undefined), 'desktop');
  assert.equal(readViewport('mobile'), 'mobile');
  assert.throws(() => readViewport(5), (e: any) => e instanceof HttpError && e.status === 400);
  assert.throws(() => readViewport('tablet'), HttpError);
  assert.equal(readAuditGoal(''), 'general');
  assert.throws(() => readAuditGoal('crypto'), HttpError);
  assert.deepEqual(readStringArray(['a', 1, 'ccc'], 'x', 2, 2), ['a', '1']);
  assert.throws(() => readStringArray('a', 'x', 2, 2), HttpError);
});

test('toPublicError never leaks raw messages and maps upstream statuses', () => {
  assert.deepEqual(toPublicError(new Error('secret stack detail'), 'Fallback.'), { status: 500, message: 'Fallback.' });
  assert.equal(toPublicError(Object.assign(new Error('x'), { status: 429 }), 'f').status, 429);
  assert.equal(toPublicError(Object.assign(new Error('x'), { status: 404 }), 'f').status, 502);
  assert.equal(toPublicError(Object.assign(new Error('x'), { name: 'TimeoutError' }), 'f').status, 504);
  assert.equal(toPublicError({ type: 'entity.too.large' }, 'f').status, 413);
  assert.deepEqual(toPublicError(new HttpError(422, 'Nope.'), 'f'), { status: 422, message: 'Nope.' });
});
