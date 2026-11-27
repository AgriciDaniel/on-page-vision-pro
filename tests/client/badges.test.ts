import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgeSpot, badgeWidth } from '../../lib/client/badges';

const badge = { width: badgeWidth(5, 6.5, 12), height: 22 };

test('a box with room above gets its badge above, whatever its size', () => {
  assert.equal(badgeSpot({ x: 300, y: 600, width: 80, height: 30 }, 900, badge), 'above');
});

test('a small box at the top gets its badge outside its corner, never on the element', () => {
  // Run 1 mobile #5: the "JOIN" button in the header, 10 px from the top of the image.
  assert.equal(badgeSpot({ x: 260, y: 10, width: 60, height: 40 }, 390, badge), 'left');
  // At the left edge there is no room on the left: outside to the right.
  assert.equal(badgeSpot({ x: 4, y: 6, width: 60, height: 30 }, 390, badge), 'right');
});

test('a large box at the top takes the badge inside its corner', () => {
  assert.equal(badgeSpot({ x: 20, y: 5, width: 600, height: 300 }, 900, badge), 'inside');
});

test('badgeWidth grows with the number of digits', () => {
  assert.ok(badgeWidth(42, 6.5, 12) > badgeWidth(5, 6.5, 12));
});
