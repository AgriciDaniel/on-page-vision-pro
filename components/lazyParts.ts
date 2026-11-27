/**
 * Parts of the app that are not needed for first paint (the Launch Studio), loaded on demand.
 * `preloadAll` fetches them while the browser is idle after first paint, so switching to a tab or
 * starting an audit almost never waits on a chunk; the Suspense fallback is only a safety net.
 */
import { lazy } from 'react';

const loaders = {
  overlay: () => import('./AuditProgressOverlay'),
  canvas: () => import('./CanvasWorkspace'),
  compare: () => import('./CompareWorkspace'),
  serp: () => import('./SerpIntelWorkspace'),
  chat: () => import('./StrategistChatWorkspace'),
  report: () => import('./ReportWorkspace'),
  redesign: () => import('./RedesignStudioModal'),
};

export const AuditProgressOverlay = lazy(() => loaders.overlay().then((m) => ({ default: m.AuditProgressOverlay })));
export const CanvasWorkspace = lazy(() => loaders.canvas().then((m) => ({ default: m.CanvasWorkspace })));
export const CompareWorkspace = lazy(() => loaders.compare().then((m) => ({ default: m.CompareWorkspace })));
export const SerpIntelWorkspace = lazy(() => loaders.serp().then((m) => ({ default: m.SerpIntelWorkspace })));
export const StrategistChatWorkspace = lazy(() => loaders.chat().then((m) => ({ default: m.StrategistChatWorkspace })));
export const ReportWorkspace = lazy(() => loaders.report().then((m) => ({ default: m.ReportWorkspace })));
export const RedesignStudioModal = lazy(() => loaders.redesign().then((m) => ({ default: m.RedesignStudioModal })));

/** Start loading the parts an audit needs right away (called when an audit or history item starts). */
export function preloadAuditParts(): void {
  loaders.overlay().catch(() => {});
  loaders.canvas().catch(() => {});
}

/** Fetch every lazy part once the browser is idle. Failures are ignored; lazy() retries on use. */
export function preloadAll(): void {
  const run = () => Object.values(loaders).forEach((load) => load().catch(() => {}));
  const w = globalThis as typeof globalThis & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 2500 });
  else setTimeout(run, 1200);
}
