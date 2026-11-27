import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, ListOrdered, OctagonAlert } from 'lucide-react';
import type { AuditFinding } from '../types';
import type { PriorityRow } from '../lib/client/priorities';

interface FixFirstBlockProps {
  rows: PriorityRow[];
  /** The finding's label where this block is shown, e.g. "#3" on the canvas or "D3" in the Report. */
  labelOf: (item: AuditFinding) => string;
  onJump: (item: AuditFinding) => void;
  /** Heading suffix, e.g. "Desktop" when the Report shows both viewports. */
  title?: string;
  compact?: boolean;
  /**
   * When set, the block shows reasons the first time it is seen for this key and only titles on
   * every later view (remembered in localStorage). The user can always show or hide reasons.
   */
  seenKey?: string;
}

const SEEN_PREFIX = 'vp:fix-first-seen:';

function wasSeen(key: string | undefined): boolean {
  if (!key) return false;
  try {
    return localStorage.getItem(SEEN_PREFIX + key) === '1';
  } catch {
    return false;
  }
}

/** "Fix these first": the ranked findings from a full-page audit. Renders nothing when there are none. */
export const FixFirstBlock: React.FC<FixFirstBlockProps> = ({ rows, labelOf, onJump, title, compact = false, seenKey }) => {
  // Decided once each time the key changes: expanded on the first view of this key, titles only
  // afterwards. The ref keeps the decision across StrictMode's double effects.
  const decided = useRef<{ key: string | undefined; show: boolean } | null>(null);
  if (!decided.current || decided.current.key !== seenKey) {
    decided.current = { key: seenKey, show: !wasSeen(seenKey) };
  }
  const [showReasons, setShowReasons] = useState(decided.current.show);
  useEffect(() => {
    setShowReasons(decided.current!.show);
    if (!seenKey || rows.length === 0) return;
    try {
      localStorage.setItem(SEEN_PREFIX + seenKey, '1');
    } catch {
      // Private mode: the block simply stays expanded.
    }
  }, [seenKey, rows.length]);
  if (rows.length === 0) return null;
  const headingId = `fix-first-${title ? title.toLowerCase() : 'page'}`;
  return (
    <section
      aria-labelledby={headingId}
      className={
        compact
          ? // Never crowds out the findings list: at most about a third of the panel, scrolling inside.
            'px-3.5 py-2.5 border-b border-slate-200 bg-white shrink-0 max-h-[34%] overflow-y-auto'
          : 'bg-white border border-slate-200 rounded-xl p-5 break-inside-avoid'
      }
    >
      <div className={`flex items-center justify-between gap-2 ${compact ? 'mb-1.5' : 'mb-3'}`}>
        <h2
          id={headingId}
          className={`font-semibold text-slate-900 flex items-center gap-1.5 ${compact ? 'text-xs' : 'text-sm'}`}
        >
          <ListOrdered size={compact ? 13 : 15} className="text-blue-600" />
          Fix these first{title ? `: ${title}` : ''}
        </h2>
        {seenKey && (
          <button
            type="button"
            onClick={() => setShowReasons((v) => !v)}
            aria-expanded={showReasons}
            className="no-print shrink-0 inline-flex items-center gap-0.5 text-[11px] font-medium text-blue-700 hover:text-blue-900 cursor-pointer focus-visible:outline-2 focus-visible:outline-blue-600 rounded"
          >
            {showReasons ? 'Hide reasons' : 'Show reasons'}
            {showReasons ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        )}
      </div>
      <ol className={compact ? 'space-y-0.5' : 'space-y-1'}>
        {rows.map((row) => (
          <li key={row.item.id}>
            <button
              type="button"
              onClick={() => onJump(row.item)}
              aria-label={`Fix first ${row.rank}: finding ${labelOf(row.item)}${
                row.alsoOn ? ` and ${labelOf(row.alsoOn.item)}, the same issue on desktop and mobile` : ''
              }, ${row.item.context}${row.blocker ? ', blocker' : ''}`}
              className={`w-full text-left flex items-start gap-2 rounded-md hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-blue-600 cursor-pointer ${
                compact ? 'px-1.5 py-1' : 'px-2 py-1.5'
              }`}
            >
              <span className="w-4 shrink-0 text-[11px] font-mono font-bold text-slate-500 tabular-nums pt-px">
                {row.rank}
              </span>
              <span
                className="shrink-0 inline-flex items-center gap-0.5"
                title={row.alsoOn ? 'The same issue on desktop and mobile' : undefined}
              >
                <span className="px-1.5 h-[18px] rounded bg-slate-900 text-white text-[10px] font-mono font-bold inline-flex items-center">
                  {labelOf(row.item)}
                </span>
                {row.alsoOn && (
                  <span className="px-1.5 h-[18px] rounded bg-slate-900 text-white text-[10px] font-mono font-bold inline-flex items-center">
                    {labelOf(row.alsoOn.item)}
                  </span>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-start gap-1.5">
                  {/* Long titles wrap; they are never cut. */}
                  <span className={`min-w-0 font-semibold text-slate-900 break-words [overflow-wrap:anywhere] ${compact ? 'text-xs' : 'text-sm'}`}>
                    {row.item.context}
                  </span>
                  {row.blocker && (
                    <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-px rounded bg-red-50 border border-red-200 text-red-700 text-[10px] font-semibold">
                      <OctagonAlert size={10} aria-hidden="true" />
                      Blocker
                    </span>
                  )}
                </span>
                {row.reason && showReasons && (
                  <span className={`block text-slate-600 leading-snug ${compact ? 'text-[11px] line-clamp-2' : 'text-xs'}`}>
                    {row.reason}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
};
