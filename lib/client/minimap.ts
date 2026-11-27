/**
 * What the canvas minimap draws. With few findings every one is a tick. With many (75 on a long
 * mobile page reads as noise) only criticals and "Fix these first" blockers stay ticks; the rest
 * become one density segment per page section, still clickable. Pure, so it is unit tested.
 */
import type { PixelRect } from '../geometry';
import type { AuditFinding } from '../../types';
import type { PageView } from './pageView';

/** Above this many boxed findings the minimap switches to ticks plus density. */
export const MAX_PLAIN_TICKS = 24;

export interface MinimapTick {
  item: AuditFinding;
  rect: PixelRect;
}

export interface DensitySegment {
  key: string;
  label: string;
  /** Image px; the segment covers [yStart, yEnd). */
  yStart: number;
  yEnd: number;
  /** Findings in this segment that are not drawn as ticks. */
  count: number;
}

export interface MinimapPlan {
  ticks: MinimapTick[];
  density: DensitySegment[];
}

export function planMinimap(
  boxed: MinimapTick[],
  view: PageView,
  blockerIds: ReadonlySet<string> = new Set(),
  maxTicks = MAX_PLAIN_TICKS
): MinimapPlan {
  if (boxed.length <= maxTicks) return { ticks: boxed, density: [] };
  const isTick = (t: MinimapTick) => t.item.severity === 'critical' || blockerIds.has(t.item.id);
  const ticks = boxed.filter(isTick);
  const rest = boxed.filter((t) => !isTick(t));

  // Segments: the audit's sections without their overlap, or one per screen when there are none.
  const H = view.size.height;
  const segments: DensitySegment[] =
    view.sections.length > 0
      ? view.sections.map((s, i) => ({
          key: `s${s.index}`,
          label: s.label || `Section ${s.index + 1}`,
          yStart: s.yStart,
          yEnd: view.sections[i + 1] ? view.sections[i + 1].yStart : Math.max(s.yEnd, H),
          count: 0,
        }))
      : Array.from({ length: Math.max(1, Math.ceil(H / Math.max(1, view.foldPx))) }, (_, i) => ({
          key: `p${i}`,
          label: `Screen ${i + 1}`,
          yStart: i * view.foldPx,
          yEnd: Math.min(H, (i + 1) * view.foldPx),
          count: 0,
        }));
  for (const t of rest) {
    const cy = t.rect.y + t.rect.height / 2;
    const seg = segments.find((s) => cy >= s.yStart && cy < s.yEnd) ?? segments[segments.length - 1];
    seg.count += 1;
  }
  return { ticks, density: segments.filter((s) => s.count > 0) };
}
