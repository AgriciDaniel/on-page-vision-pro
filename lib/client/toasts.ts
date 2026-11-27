/** How the toast stack behaves. Pure, so it is tested without a browser. */

/** At most this many toasts are visible; a new one pushes out the oldest. */
export const MAX_VISIBLE_TOASTS = 3;

export type ToastKind = 'success' | 'error' | 'info';

/**
 * How long a toast stays, in ms: 3 s plus 0.3 s per word (about 200 words a minute). Errors and
 * notices (info, which carries the server's capture and audit warnings) stay at least 7 s,
 * successes at least 4.5 s, and nothing stays longer than 15 s. Hovering or focusing a toast
 * pauses it (see App.tsx).
 */
export function toastDurationMs(kind: ToastKind, message: string): number {
  const words = message.trim().split(/\s+/).filter(Boolean).length;
  const min = kind === 'success' ? 4500 : 7000;
  return Math.min(15000, Math.max(min, 3000 + words * 300));
}

/** The stack after adding `next`: the newest MAX_VISIBLE_TOASTS, and which ones were pushed out. */
export function stackToasts<T>(current: T[], next: T, max = MAX_VISIBLE_TOASTS): { visible: T[]; dropped: T[] } {
  const all = [...current, next];
  const cut = Math.max(0, all.length - max);
  return { visible: all.slice(cut), dropped: all.slice(0, cut) };
}
