/**
 * "Fix these first" and the audit stats line, from the optional `top_priorities` and `stats` that
 * /api/audit/page returns. Pure, so canvas, Report, Markdown and PNG all show the same thing.
 */
import type { AuditFinding, PageAuditStats, ViewportAudit, ViewportKey } from '../../types';
import type { Twin } from './twins';

export interface PriorityRow {
  rank: number;
  reason: string;
  blocker: boolean;
  item: AuditFinding;
  /** Set on merged rows: which device `item` is from. */
  viewport?: ViewportKey;
  /** The same issue on the other device, when it is ranked there too (merged rows only). */
  alsoOn?: Twin;
}

/**
 * The ranked rows to show, rank 1 first. Empty when the audit has no `top_priorities` (old
 * sessions, viewport audits, or an empty array). Rows whose `finding_id` matches no finding, or
 * repeat one already listed, are dropped rather than shown without a target.
 */
export function priorityRows(audit: ViewportAudit | null | undefined): PriorityRow[] {
  const list = audit?.top_priorities;
  if (!Array.isArray(list) || list.length === 0) return [];
  const byId = new Map((audit?.items ?? []).map((i) => [i.id, i]));
  const seen = new Set<string>();
  return list
    .filter((p) => p && typeof p.finding_id === 'string')
    .slice()
    .sort((a, b) => (Number(a.rank) || 99) - (Number(b.rank) || 99))
    .flatMap((p) => {
      const item = byId.get(p.finding_id);
      if (!item || seen.has(item.id)) return [];
      seen.add(item.id);
      return [{ rank: 0, reason: String(p.reason ?? '').trim(), blocker: p.blocker === true, item }];
    })
    .map((row, idx) => ({ ...row, rank: idx + 1 }));
}

const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');

/**
 * One quiet line for the Report, e.g. "13 sections audited, 1 retry, 48.2 s, 182,400 tokens".
 * Tokens appear only when the model reported them. Empty string when there are no stats.
 */
export function describeStats(stats: PageAuditStats | null | undefined): string {
  if (!stats || typeof stats !== 'object') return '';
  const parts: string[] = [];
  const sections = Array.isArray(stats.sections) ? stats.sections : [];
  if (sections.length > 0) {
    const ok = sections.filter((s) => s.ok).length;
    parts.push(
      ok === sections.length
        ? `${sections.length} section${sections.length === 1 ? '' : 's'} audited`
        : `${ok} of ${sections.length} sections audited`
    );
  }
  const f = stats.findings;
  if (f && Number.isFinite(f.found) && Number.isFinite(f.returned) && f.returned < f.found) {
    parts.push(`${fmtInt(f.returned)} of ${fmtInt(f.found)} findings shown`);
  }
  if (Number.isFinite(stats.retries)) parts.push(`${stats.retries} ${stats.retries === 1 ? 'retry' : 'retries'}`);
  const rl = (stats as { rateLimitRetries?: number }).rateLimitRetries;
  if (Number.isFinite(rl) && rl! > 0) parts.push(`${rl} after rate limits`);
  if (Number.isFinite(stats.totalMs)) parts.push(`${(stats.totalMs / 1000).toFixed(1)} s`);
  if (stats.tokens && Number.isFinite(stats.tokens.total)) parts.push(`${fmtInt(stats.tokens.total)} tokens`);
  return parts.join(', ');
}

/** Plain-text lines for the Markdown export and the PNG legend. `label` gives each finding's label. */
export function priorityLines(rows: PriorityRow[], label: (item: AuditFinding) => string): string[] {
  return rows.map(
    (r) => `${r.rank}. ${label(r.item)} ${r.item.context}${r.blocker ? ' [blocker]' : ''}${r.reason ? `: ${r.reason}` : ''}`
  );
}

/**
 * One "Fix these first" list for both devices. Rows are taken alternately by rank (desktop 1,
 * mobile 1, desktop 2, ...); when a row's twin (same issue, lib/crossViewport.ts) is also ranked on
 * the other device, the two become one row with both findings, so the list reads as real problems
 * instead of repeats. A merged row is a blocker when either side is. Ranks are renumbered from 1.
 */
export function mergedPriorityRows(
  desktop: ViewportAudit | null | undefined,
  mobile: ViewportAudit | null | undefined,
  twins: ReadonlyMap<string, Twin>
): PriorityRow[] {
  const lists: Record<ViewportKey, PriorityRow[]> = {
    desktop: priorityRows(desktop).map((r) => ({ ...r, viewport: 'desktop' as const })),
    mobile: priorityRows(mobile).map((r) => ({ ...r, viewport: 'mobile' as const })),
  };
  const byId = new Map<string, PriorityRow>();
  for (const r of [...lists.desktop, ...lists.mobile]) byId.set(r.item.id, r);
  const used = new Set<string>();
  const out: PriorityRow[] = [];
  const longest = Math.max(lists.desktop.length, lists.mobile.length);
  for (let i = 0; i < longest; i++) {
    for (const key of ['desktop', 'mobile'] as const) {
      const row = lists[key][i];
      if (!row || used.has(row.item.id)) continue;
      used.add(row.item.id);
      const twin = twins.get(row.item.id);
      const twinRow = twin ? byId.get(twin.item.id) : undefined;
      if (twin && twinRow && !used.has(twin.item.id)) {
        used.add(twin.item.id);
        // A merged row always reads desktop first (D13 M16), whichever side was ranked higher;
        // the reason stays the one from the higher-ranked side.
        const [first, second] = row.viewport === 'mobile' ? [twinRow, row] : [row, twinRow];
        out.push({
          ...first,
          blocker: row.blocker || twinRow.blocker,
          reason: row.reason || twinRow.reason,
          alsoOn: { viewport: second.viewport ?? 'mobile', item: second.item },
        });
      } else {
        out.push(row);
      }
    }
  }
  return out.map((r, idx) => ({ ...r, rank: idx + 1 }));
}
