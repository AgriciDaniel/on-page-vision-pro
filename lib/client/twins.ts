/**
 * "Same issue on both devices": the desktop and mobile findings that vp-neon-1's linker
 * (lib/crossViewport.ts) matches, as a lookup from either finding to its twin on the other device.
 * Pure; the linker compares every desktop finding with every mobile one, so callers memoize per audit.
 */
import { linkAcrossViewports } from '../crossViewport';
import type { AuditFinding, ViewportAudit, ViewportKey } from '../../types';

export interface Twin {
  viewport: ViewportKey;
  item: AuditFinding;
}

const sideOf = (audit: ViewportAudit | null | undefined) =>
  audit && Array.isArray(audit.items)
    ? { items: audit.items, image: audit.image ?? null, sections: audit.sections ?? [] }
    : null;

/** Map from a finding id (on either device) to its twin on the other device. Empty unless both audits exist. */
export function findingTwins(
  desktop: ViewportAudit | null | undefined,
  mobile: ViewportAudit | null | undefined
): Map<string, Twin> {
  const twins = new Map<string, Twin>();
  const d = sideOf(desktop);
  const m = sideOf(mobile);
  if (!d || !m || d.items.length === 0 || m.items.length === 0) return twins;
  const dById = new Map(d.items.map((i) => [i.id, i]));
  const mById = new Map(m.items.map((i) => [i.id, i]));
  for (const pair of linkAcrossViewports(d, m).pairs) {
    const di = dById.get(pair.desktopId);
    const mi = mById.get(pair.mobileId);
    if (!di || !mi) continue;
    twins.set(di.id, { viewport: 'mobile', item: mi });
    twins.set(mi.id, { viewport: 'desktop', item: di });
  }
  return twins;
}
