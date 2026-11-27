import React from 'react';
import {
  Trash2,
  Plus,
  Monitor,
  ChevronLeft,
  ChevronRight,
  TrendingUp,
  TrendingDown,
  RefreshCw,
} from 'lucide-react';
import type { AuditHistoryHeader } from '../types';

interface HistoryRailProps {
  history: AuditHistoryHeader[];
  activeId: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onReAudit: (item: AuditHistoryHeader) => void;
  onCleanIncomplete?: () => void;
  onNewAudit: () => void;
}

export const HistoryRail: React.FC<HistoryRailProps> = ({
  history,
  activeId,
  collapsed,
  onToggleCollapse,
  onSelect,
  onDelete,
  onReAudit,
  onCleanIncomplete,
  onNewAudit,
}) => {
  if (collapsed) {
    return (
      <aside className="no-print w-12 shrink-0 bg-white border-r border-slate-200 flex flex-col items-center py-3 gap-3">
        <button
          type="button"
          onClick={onToggleCollapse}
          className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors cursor-pointer"
          title="Expand audit history"
          aria-label="Expand audit history"
        >
          <ChevronRight size={16} />
        </button>
        <button
          type="button"
          onClick={onNewAudit}
          className="p-2 text-blue-600 hover:bg-blue-50 rounded-md transition-colors cursor-pointer"
          title="New audit"
          aria-label="New audit"
        >
          <Plus size={16} />
        </button>
      </aside>
    );
  }

  const incompleteCount = history.filter((h) => (h.desktopScore ?? h.mobileScore) === null).length;

  // Compute score delta against previous audit for the same domain
  const getDomainDelta = (item: AuditHistoryHeader, index: number): number | null => {
    const score = item.desktopScore ?? item.mobileScore;
    if (score === null) return null;
    const prevSameDomain = history
      .slice(index + 1)
      .find((h) => h.domain === item.domain && (h.desktopScore ?? h.mobileScore) !== null);
    if (!prevSameDomain) return null;
    const prevScore = prevSameDomain.desktopScore ?? prevSameDomain.mobileScore;
    if (prevScore === null) return null;
    return score - prevScore;
  };

  return (
    <aside className="no-print w-[248px] shrink-0 bg-white border-r border-slate-200 flex flex-col h-full">
      <div className="h-12 px-3.5 border-b border-slate-200 flex items-center justify-between gap-2 shrink-0">
        <span className="text-xs font-semibold text-slate-700 truncate">
          Audit History <span className="text-slate-400 font-mono tabular-nums ml-1">{history.length}</span>
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {incompleteCount > 0 && onCleanIncomplete && (
            <button
              type="button"
              onClick={onCleanIncomplete}
              className="text-[10px] font-semibold text-amber-700 hover:text-red-700 px-1.5 py-0.5 rounded hover:bg-amber-50 transition-colors cursor-pointer"
              title={`Remove ${incompleteCount} incomplete audit${incompleteCount > 1 ? 's' : ''}`}
            >
              Clean ({incompleteCount})
            </button>
          )}
          <button
            type="button"
            onClick={onToggleCollapse}
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors cursor-pointer"
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            <ChevronLeft size={15} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2.5 space-y-1.5">
        {history.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <p className="text-xs font-medium text-slate-700 mb-1">No saved audits yet</p>
            <p className="text-xs text-slate-500 leading-relaxed">
              Audits are saved automatically in your browser so you can revisit and track score changes.
            </p>
          </div>
        ) : (
          history.map((item, idx) => {
            const isActive = item.id === activeId;
            const score = item.desktopScore ?? item.mobileScore;
            const isIncomplete = score === null;
            const delta = getDomainDelta(item, idx);

            return (
              <div
                key={item.id}
                onClick={() => onSelect(item.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(item.id);
                  }
                }}
                className={`group rounded-lg p-2.5 border transition-colors cursor-pointer flex items-start gap-2.5 ${
                  isActive
                    ? 'bg-blue-50/70 border-blue-200'
                    : isIncomplete
                    ? 'bg-amber-50/40 border-amber-200/70 hover:bg-amber-50'
                    : 'bg-white border-transparent hover:bg-slate-50 hover:border-slate-200'
                }`}
              >
                <div className="w-11 h-9 rounded border border-slate-200 bg-slate-100 overflow-hidden shrink-0 mt-0.5">
                  {item.thumbnailDataUrl ? (
                    <img
                      src={item.thumbnailDataUrl}
                      alt={item.domain}
                      className="w-full h-full object-cover object-top"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-slate-400">
                      <Monitor size={13} />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-1">
                    <p
                      className={`text-xs font-semibold truncate ${
                        isActive ? 'text-blue-900' : 'text-slate-900'
                      }`}
                    >
                      {item.domain}
                    </p>
                    <div className="flex items-center gap-0.5 shrink-0">
                      {item.sourceType === 'url' && item.url && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onReAudit(item);
                          }}
                          className={`p-1 transition-opacity rounded cursor-pointer ${
                            isIncomplete
                              ? 'text-blue-600 hover:bg-blue-100 opacity-100'
                              : 'text-slate-400 hover:text-blue-600 opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                          }`}
                          title={isIncomplete ? 'Retry incomplete audit' : 'Re-audit URL & compare score delta'}
                          aria-label={isIncomplete ? `Retry ${item.domain}` : `Re-audit ${item.domain}`}
                        >
                          <RefreshCw size={11} />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(item.id);
                        }}
                        className={`p-1 transition-opacity rounded cursor-pointer ${
                          isIncomplete
                            ? 'text-slate-500 hover:text-red-600 opacity-100'
                            : 'text-slate-400 hover:text-red-600 opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                        }`}
                        title="Delete audit"
                        aria-label={`Delete audit for ${item.domain}`}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-slate-500 mt-0.5 font-mono tabular-nums">
                    {isIncomplete ? (
                      <span className="font-sans font-semibold text-amber-700">Incomplete · Retry</span>
                    ) : (
                      <>
                        <span className="font-semibold text-slate-800">{score}/100</span>
                        {delta !== null && delta !== 0 && (
                          <span
                            className={`inline-flex items-center gap-0.5 font-semibold ${
                              delta > 0 ? 'text-emerald-600' : 'text-red-600'
                            }`}
                          >
                            {delta > 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                            {delta > 0 ? `+${delta}` : delta}
                          </span>
                        )}
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span>{new Date(item.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
};
