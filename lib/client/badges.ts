/**
 * Where a finding's number badge goes, so it never hides the element it marks.
 * Default: above the box's top-left corner. With no room above (a box at the top of the image), a
 * small box gets its badge outside its corner, to the left (or right at the image's left edge);
 * only a large box takes the badge inside, where it covers a corner of a big area. Pure, all in
 * displayed px, so canvas and Compare share it.
 */
export type BadgeSpot = 'above' | 'left' | 'right' | 'inside';

export interface BoxPx {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Rough badge width for a number label, in px: padding plus one glyph per digit. */
export function badgeWidth(label: string | number, digitPx: number, padPx: number): number {
  return padPx + String(label).length * digitPx;
}

export function badgeSpot(
  box: BoxPx,
  frameWidth: number,
  badge: { width: number; height: number }
): BadgeSpot {
  if (box.y >= badge.height) return 'above';
  const small = box.width < badge.width * 4 || box.height < badge.height * 2;
  if (!small) return 'inside';
  if (box.x >= badge.width + 2) return 'left';
  if (frameWidth - (box.x + box.width) >= badge.width + 2) return 'right';
  return 'inside';
}
