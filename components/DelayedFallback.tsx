import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Suspense fallback that stays empty for the first 300 ms, so a chunk that loads quickly (the
 * usual case, since parts are preloaded) never flashes a spinner.
 */
export const DelayedFallback: React.FC<{ label?: string; overlay?: boolean }> = ({ label = 'Loading', overlay = false }) => {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 300);
    return () => clearTimeout(t);
  }, []);
  if (!show) return null;
  return (
    <div
      role="status"
      className={`${overlay ? 'fixed inset-0 z-50 bg-slate-900/20' : 'h-full min-h-60'} flex items-center justify-center`}
    >
      <span className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white border border-slate-200 shadow-sm text-xs font-medium text-slate-600">
        <Loader2 size={14} className="animate-spin text-blue-600" aria-hidden="true" />
        {label}
      </span>
    </div>
  );
};
