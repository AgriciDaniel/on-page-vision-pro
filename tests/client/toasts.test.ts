import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_VISIBLE_TOASTS, stackToasts, toastDurationMs } from '../../lib/client/toasts';

test('the stack keeps the newest 3 and pushes out the oldest first', () => {
  assert.equal(MAX_VISIBLE_TOASTS, 3);
  let stack: number[] = [];
  const dropped: number[] = [];
  for (let i = 1; i <= 5; i++) {
    const r = stackToasts(stack, i);
    stack = r.visible;
    dropped.push(...r.dropped);
  }
  assert.deepEqual(stack, [3, 4, 5]);
  assert.deepEqual(dropped, [1, 2]);
});

test('warnings stay long enough to read; short successes go sooner; nothing stays past 15 s', () => {
  const warning = 'Mobile full-page capture failed (timeout); used a microlink viewport screenshot instead.';
  assert.ok(toastDurationMs('info', warning) >= 7000);
  assert.equal(toastDurationMs('success', 'Saved.'), 4500);
  assert.equal(toastDurationMs('error', 'x'), 7000);
  assert.equal(toastDurationMs('info', 'word '.repeat(80)), 15000);
  // A 20-word notice: 3 s + 20 x 0.3 s = 9 s.
  assert.equal(toastDurationMs('info', 'word '.repeat(20)), 9000);
});
