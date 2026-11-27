import React, { useState, useEffect, useMemo } from 'react';
import {
  Check,
  Loader2,
  Monitor,
  Smartphone,
  Globe,
  Layers,
  ScanLine,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  Database,
  Activity,
} from 'lucide-react';
import type { PageAuditProgress, SectionProgressState, SeoMetadata, ViewportAudit, ViewportData, ViewportKey } from '../types';
import { describeProgress } from '../lib/client/progress';
import { findingBoxStyle, foldPercent, pageViewOf } from '../lib/client/pageView';

export type StepState = 'waiting' | 'active' | 'done' | 'skipped';

export interface LiveScanProgress {
  capture: StepState;
  desktopAudit: StepState;
  mobileAudit: StepState;
  compare: StepState;
}

interface AuditProgressOverlayProps {
  targetLabel: string;
  progress: LiveScanProgress;
  desktopScreenshot: string | null;
  mobileScreenshot: string | null;
  metadata: SeoMetadata | null;
  desktopAudit: ViewportAudit | null;
  mobileAudit: ViewportAudit | null;
  /** The draft's viewport data: gives the real image size, mode and fold so boxes line up. */
  desktopData?: ViewportData | null;
  mobileData?: ViewportData | null;
  /** Live section progress per viewport (full-page audits on a server that reports it). */
  pageProgress?: Partial<Record<ViewportKey, PageAuditProgress>>;
  onEnterEarly?: () => void;
  onCancel?: () => void;
}

export const AuditProgressOverlay: React.FC<AuditProgressOverlayProps> = ({
  targetLabel,
  progress,
  desktopScreenshot,
  mobileScreenshot,
  metadata,
  desktopAudit,
  mobileAudit,
  desktopData = null,
  mobileData = null,
  pageProgress = {} as Partial<Record<ViewportKey, PageAuditProgress>>,
  onEnterEarly,
  onCancel,
}) => {
  const [previewVp, setPreviewVp] = useState<ViewportKey>('desktop');
  const [showFold, setShowFold] = useState(true);
  const [rightTab, setRightTab] = useState<'pipeline' | 'seo'>('pipeline');
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    setElapsedSec(0);
    const id = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [targetLabel]);

  useEffect(() => {
    if (!desktopScreenshot && mobileScreenshot) {
      setPreviewVp('mobile');
    }
  }, [desktopScreenshot, mobileScreenshot]);

  const activeShot = previewVp === 'desktop' ? desktopScreenshot : mobileScreenshot;
  const activeAudit = previewVp === 'desktop' ? desktopAudit : mobileAudit;
  const activeData = previewVp === 'desktop' ? desktopData : mobileData;
  // Boxes are placed with the same rules as the canvas. The audit's own mode and size win once it lands.
  const view = useMemo(() => {
    if (!activeData) return null;
    return pageViewOf(activeAudit ? { ...activeData, analysis: activeAudit } : activeData, previewVp);
  }, [activeData, activeAudit, previewVp]);
  const isFullPage = view?.mode === 'fullpage';
  // On a full page the frame shows the first screen plus 15%, so the fold line is always in view.
  const frameAspect =
    view && view.showFold
      ? `${view.size.width} / ${Math.min(view.size.height, Math.round(view.foldPx * 1.15))}`
      : null;
  const anyFullPage = desktopData?.captureMode === 'fullpage' || mobileData?.captureMode === 'fullpage';

  // Compute real progress percentage from actual step completions
  const trackedSteps: StepState[] = [
    progress.capture,
    progress.desktopAudit,
    progress.mobileAudit,
    progress.compare,
  ].filter((s) => s !== 'skipped');

  const live = {
    desktop: desktopAudit ? null : describeProgress(pageProgress.desktop),
    mobile: mobileAudit ? null : describeProgress(pageProgress.mobile),
  };
  // Active steps count by their real section progress when the server reports it.
  const activeShare = (key: keyof LiveScanProgress) =>
    key === 'desktopAudit' && live.desktop
      ? live.desktop.fraction
      : key === 'mobileAudit' && live.mobile
      ? live.mobile.fraction
      : 0.35;
  const stepKeys: (keyof LiveScanProgress)[] = ['capture', 'desktopAudit', 'mobileAudit', 'compare'];
  const doneCount = trackedSteps.filter((s) => s === 'done').length;
  const activeSum = stepKeys
    .filter((k) => progress[k] === 'active')
    .reduce((sum, k) => sum + activeShare(k), 0);
  const progressPct = Math.min(
    98,
    Math.max(10, Math.round(((doneCount + activeSum) / Math.max(1, trackedSteps.length)) * 100))
  );

  const canEnterEarly = Boolean(desktopAudit || mobileAudit);

  const allPipelineRows: {
    key: keyof LiveScanProgress;
    label: string;
    detail: string;
    state: StepState;
    icon: React.ReactNode;
    score?: number;
    /** Per-section states, drawn as a strip under the detail while a full page is audited. */
    sectionStates?: SectionProgressState[];
  }[] = [
    {
      key: 'capture',
      label: anyFullPage ? 'Full-Page Capture & HTML Parse' : 'Dual-Viewport Capture & HTML Parse',
      detail: metadata
        ? `Extracted ${metadata.wordCount} words, ${metadata.h1s.length} H1, ${metadata.totalImages} images`
        : 'Rendering desktop (1440 px wide) and mobile (390 px wide) screenshots',
      state: progress.capture,
      icon: <Globe size={14} />,
    },
    {
      key: 'desktopAudit',
      label: 'Desktop Vision CRO & SEO Audit',
      detail: desktopAudit
        ? `${desktopAudit.items.length} elements mapped · ${desktopAudit.critical_count} critical`
        : live.desktop
        ? live.desktop.line
        : desktopData?.captureMode === 'fullpage'
        ? 'Auditing every section: contrast, hierarchy, CRO and E-E-A-T'
        : 'Mapping hero boxes, contrast, hierarchy, and E-E-A-T',
      state: progress.desktopAudit,
      sectionStates: live.desktop?.states,
      icon: <Monitor size={14} />,
      score: desktopAudit?.scores?.overall,
    },
    {
      key: 'mobileAudit',
      label: mobileData?.captureMode === 'fullpage' ? 'Mobile Full-Page Audit' : 'Mobile Above-the-Fold Audit',
      detail: mobileAudit
        ? `${mobileAudit.items.length} elements mapped · ${mobileAudit.critical_count} critical`
        : live.mobile
        ? live.mobile.line
        : mobileData?.captureMode === 'fullpage'
        ? 'Checking every mobile section, tap targets and fold pushdown in parallel'
        : 'Checking mobile fold pushdown and tap targets in parallel',
      state: progress.mobileAudit,
      sectionStates: live.mobile?.states,
      icon: <Smartphone size={14} />,
      score: mobileAudit?.scores?.overall,
    },
    {
      key: 'compare',
      label: 'Desktop vs. Mobile Parity Check',
      detail: 'Evaluating cross-device consistency and responsive deltas',
      state: progress.compare,
      icon: <Layers size={14} />,
    },
  ];
  const pipelineRows = allPipelineRows.filter((r) => r.state !== 'skipped');

  const titleLen = metadata?.title?.length || 0;
  const descLen = metadata?.description?.length || 0;

  return (
    <div
      className="flex-1 relative overflow-y-auto flex items-center justify-center p-4 sm:p-6 bg-[#F0F4F8]"
      style={{
        backgroundImage:
          'linear-gradient(rgba(26,115,232,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(26,115,232,0.06) 1px, transparent 1px)',
        backgroundSize: '36px 36px',
      }}
    >
      <div className="w-full max-w-6xl bg-white border border-slate-200 rounded-2xl shadow-xl shadow-blue-950/5 overflow-hidden flex flex-col">
        {/* Top Live Status Header */}
        <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 relative bg-white">
          <div className="flex items-center gap-2.5 min-w-0">
            <ScanLine size={16} className="text-[#1A73E8] shrink-0" />
            <span className="text-sm font-bold text-slate-900 truncate">{targetLabel}</span>
            <span className="text-xs text-slate-400 font-mono tabular-nums">
              · {elapsedSec}s elapsed
            </span>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {canEnterEarly && onEnterEarly && (
              <button
                type="button"
                onClick={onEnterEarly}
                className="px-3.5 py-1.5 bg-[#1A73E8] hover:bg-[#0B57D0] text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
              >
                Explore Canvas Now
                <ArrowRight size={13} />
              </button>
            )}
            <span className="text-xs font-mono font-semibold tabular-nums text-[#1A73E8]">
              {progressPct}%
            </span>
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="text-xs font-medium text-slate-500 hover:text-slate-900 transition-colors cursor-pointer"
              >
                Cancel
              </button>
            )}
          </div>

          {/* Real Progress Track */}
          <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-slate-100">
            <div
              className="h-full bg-[#1A73E8] transition-all duration-500 ease-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12">
          {/* Left: Interactive Precision Scanner Bay */}
          <div className="lg:col-span-7 bg-[#0B1220] p-5 sm:p-7 flex flex-col justify-between gap-4 min-h-[420px] relative overflow-hidden">
            {/* Subtle dark studio blueprint grid */}
            <div
              className="absolute inset-0 opacity-20 pointer-events-none"
              style={{
                backgroundImage:
                  'linear-gradient(rgba(148,163,184,0.22) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.22) 1px, transparent 1px)',
                backgroundSize: '28px 28px',
              }}
            />

            {/* Interactive Scanner Toolbar */}
            <div className="relative z-10 flex flex-wrap items-center justify-between gap-2">
              <div className="inline-flex items-center p-0.5 bg-slate-900/90 border border-slate-700/80 rounded-lg">
                <button
                  type="button"
                  disabled={!desktopScreenshot}
                  onClick={() => setPreviewVp('desktop')}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-40 whitespace-nowrap ${
                    previewVp === 'desktop'
                      ? 'bg-[#1A73E8] text-white'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  <Monitor size={12} />
                  Desktop
                </button>
                <button
                  type="button"
                  disabled={!mobileScreenshot}
                  onClick={() => setPreviewVp('mobile')}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-40 whitespace-nowrap ${
                    previewVp === 'mobile'
                      ? 'bg-[#1A73E8] text-white'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  <Smartphone size={12} />
                  Mobile
                </button>
              </div>

              <div className="flex items-center gap-2">
                {activeShot && view?.showFold && (
                  <button
                    type="button"
                    aria-pressed={showFold}
                    onClick={() => setShowFold((v) => !v)}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors cursor-pointer whitespace-nowrap ${
                      showFold
                        ? 'bg-blue-500/20 border-blue-400/50 text-blue-200'
                        : 'bg-slate-900/80 border-slate-700 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Fold Guide
                  </button>
                )}
                {activeAudit && (
                  <span className="text-[11px] font-mono tabular-nums text-emerald-300 bg-emerald-950/80 border border-emerald-500/40 px-2.5 py-1 rounded-md">
                    {activeAudit.items.length} elements locked
                  </span>
                )}
              </div>
            </div>

            {/* Viewport Frame + Corner Brackets + Laser Scan + Live Boxes */}
            <div className="relative z-10 flex-1 flex items-center justify-center py-2">
              <div
                className={`relative transition-all duration-300 ${
                  previewVp === 'mobile' ? (isFullPage ? 'w-[200px]' : 'w-[220px]') : 'w-full max-w-[580px]'
                }`}
              >
                {/* Precision Viewfinder Corner Brackets */}
                <div className="pointer-events-none absolute -top-2.5 -left-2.5 w-6 h-6 border-t-[2.5px] border-l-[2.5px] border-blue-400 rounded-tl-md z-30" />
                <div className="pointer-events-none absolute -top-2.5 -right-2.5 w-6 h-6 border-t-[2.5px] border-r-[2.5px] border-blue-400 rounded-tr-md z-30" />
                <div className="pointer-events-none absolute -bottom-2.5 -left-2.5 w-6 h-6 border-b-[2.5px] border-l-[2.5px] border-blue-400 rounded-bl-md z-30" />
                <div className="pointer-events-none absolute -bottom-2.5 -right-2.5 w-6 h-6 border-b-[2.5px] border-r-[2.5px] border-blue-400 rounded-br-md z-30" />

                <div
                  className={`relative w-full rounded-lg overflow-hidden border border-slate-700/80 bg-slate-900 shadow-2xl ${
                    frameAspect ? '' : previewVp === 'mobile' ? 'aspect-[9/16]' : 'aspect-video'
                  }`}
                  style={frameAspect ? { aspectRatio: frameAspect } : undefined}
                >
                  {activeShot ? (
                    <>
                      <div
                        className="absolute inset-0 overflow-y-auto overflow-x-hidden"
                        tabIndex={0}
                        aria-label={`${previewVp === 'desktop' ? 'Desktop' : 'Mobile'} screenshot being scanned${isFullPage ? ', scroll to see the whole page' : ''}`}
                      >
                      <div className="relative w-full">
                      <img
                        src={activeShot}
                        alt={`Scanning ${previewVp} viewport`}
                        className="block w-full h-auto"
                      />

                      {/* Fold line at the real first-screen boundary, only on a full page */}
                      {showFold && view?.showFold && (
                        <div
                          className="pointer-events-none absolute inset-x-0 border-t border-dashed border-blue-400/90 z-20"
                          style={{ top: `${foldPercent(view)}%` }}
                        >
                          <span className="absolute right-2 -top-4 bg-blue-600/90 text-white text-[9px] font-mono px-1.5 py-0.5 rounded">
                            First screen ends
                          </span>
                        </div>
                      )}

                      {/* Live Detected Bounding Boxes appear immediately when audit finishes */}
                      {view && activeAudit?.items.map((item, idx) => {
                        const boxStyle = findingBoxStyle(item, view);
                        if (!boxStyle) return null;
                        const border =
                          item.severity === 'critical'
                            ? 'border-red-500 bg-red-500/15'
                            : item.severity === 'warning'
                            ? 'border-amber-400 bg-amber-400/15'
                            : 'border-blue-400 bg-blue-400/15';
                        return (
                          <div
                            key={item.id}
                            style={boxStyle}
                            className={`pointer-events-none absolute border-[1.5px] ${border} z-20 transition-opacity duration-300`}
                          >
                            <span className="absolute -top-3.5 -left-[1px] bg-slate-900/90 text-white text-[8px] font-mono px-1 rounded-t-xs">
                              {idx + 1}
                            </span>
                          </div>
                        );
                      })}
                      </div>
                      </div>

                      {/* Smooth Cobalt Laser Sweep while active */}
                      {!activeAudit && (
                        <div className="pointer-events-none absolute inset-0 overflow-hidden z-20">
                          <div className="animate-vision-scan w-full h-full relative">
                            <div className="w-full h-[2px] bg-blue-400 shadow-[0_0_20px_5px_rgba(59,130,246,0.95)]" />
                            <div className="w-full h-16 -mt-16 bg-gradient-to-t from-blue-500/30 to-transparent" />
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    /* Animated Skeleton Wireframe Preview while capturing */
                    <div className="w-full h-full p-6 flex flex-col justify-between relative bg-slate-900/95">
                      <div className="flex items-center justify-between">
                        <div className="h-3.5 w-24 bg-slate-800 rounded" />
                        <div className="flex gap-2">
                          <div className="h-2.5 w-12 bg-slate-800 rounded" />
                          <div className="h-2.5 w-12 bg-slate-800 rounded" />
                          <div className="h-2.5 w-12 bg-slate-800 rounded" />
                        </div>
                      </div>
                      <div className="my-auto space-y-3 max-w-sm">
                        <div className="h-6 w-3/4 bg-slate-800 rounded" />
                        <div className="h-3.5 w-full bg-slate-800/70 rounded" />
                        <div className="h-3.5 w-5/6 bg-slate-800/70 rounded" />
                        <div className="flex gap-2.5 pt-2">
                          <div className="h-8 w-28 bg-blue-600/30 border border-blue-500/40 rounded-md" />
                          <div className="h-8 w-24 bg-slate-800 rounded-md" />
                        </div>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-blue-300">
                        <Loader2 size={14} className="animate-spin" />
                        <span>Rendering live desktop &amp; mobile screenshots...</span>
                      </div>

                      {/* Laser sweep over wireframe */}
                      <div className="pointer-events-none absolute inset-0 overflow-hidden">
                        <div className="animate-vision-scan w-full h-full relative">
                          <div className="w-full h-[2px] bg-blue-400/80 shadow-[0_0_16px_3px_rgba(59,130,246,0.75)]" />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Bottom Live Hint */}
            <div className="relative z-10 flex items-center justify-between text-[11px] text-slate-400">
              <span>
                {activeAudit
                  ? `Vision scan complete for ${previewVp}: score ${activeAudit.scores?.overall ?? 0}/100`
                  : activeShot
                  ? isFullPage
                    ? `Scanning the whole page section by section with Gemini 4`
                    : `Running parallel Gemini 4 vision scans across viewports`
                  : `Connecting to the page and capturing screenshots`}
              </span>
              <span className="font-mono">
                {view
                  ? `${view.size.width}×${view.size.height}${isFullPage ? ' full page' : ''}`
                  : previewVp === 'desktop'
                  ? '1440×900'
                  : '390×844'}
              </span>
            </div>
          </div>

          {/* Right: Interactive Pipeline + Instant Extracted SEO Inspector */}
          <div className="lg:col-span-5 flex flex-col bg-white border-t lg:border-t-0 lg:border-l border-slate-200">
            {/* Interactive Right Panel Tabs */}
            <div className="px-5 pt-4 pb-3 border-b border-slate-200 flex items-center justify-between gap-2">
              <div className="inline-flex items-center gap-1 p-0.5 bg-slate-100 border border-slate-200 rounded-lg w-full">
                <button
                  type="button"
                  onClick={() => setRightTab('pipeline')}
                  className={`flex-1 py-1.5 text-xs font-semibold rounded-md flex items-center justify-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap ${
                    rightTab === 'pipeline'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Activity size={13} />
                  Live Pipeline
                </button>
                <button
                  type="button"
                  onClick={() => setRightTab('seo')}
                  disabled={!metadata}
                  className={`flex-1 py-1.5 text-xs font-semibold rounded-md flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:opacity-45 whitespace-nowrap ${
                    rightTab === 'seo'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Database size={13} />
                  Live SEO Tags {metadata ? '✓' : ''}
                </button>
              </div>
            </div>

            <div className="flex-1 p-5 overflow-y-auto">
              {rightTab === 'pipeline' ? (
                <div className="space-y-5">
                  <ol className="space-y-4">
                    {pipelineRows.map((step) => (
                      <li key={step.key} className="flex items-start gap-3">
                        <div
                          className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 border text-xs ${
                            step.state === 'done'
                              ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                              : step.state === 'active'
                              ? 'bg-blue-50 border-blue-200 text-[#1A73E8]'
                              : 'bg-slate-50 border-slate-200 text-slate-400'
                          }`}
                        >
                          {step.state === 'done' ? (
                            <Check size={13} strokeWidth={2.5} />
                          ) : step.state === 'active' ? (
                            <Loader2 size={13} className="animate-spin" />
                          ) : (
                            step.icon
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <p
                              className={`text-sm font-semibold ${
                                step.state !== 'waiting' ? 'text-slate-900' : 'text-slate-400'
                              }`}
                            >
                              {step.label}
                            </p>
                            {typeof step.score === 'number' && (
                              <span className="text-xs font-mono font-bold tabular-nums text-slate-900">
                                {step.score}/100
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-500 leading-relaxed mt-0.5" aria-live="polite">
                            {step.detail}
                          </p>
                          {step.sectionStates && step.sectionStates.length > 0 && (
                            <div
                              className="mt-1.5 flex gap-0.5"
                              role="img"
                              aria-label={`Sections: ${step.sectionStates.filter((x) => x === 'done').length} of ${step.sectionStates.length} done`}
                            >
                              {step.sectionStates.map((st, i) => (
                                <span
                                  key={i}
                                  title={`Section ${i + 1}: ${st}`}
                                  className={`h-1.5 flex-1 max-w-6 rounded-full ${
                                    st === 'done'
                                      ? 'bg-emerald-500'
                                      : st === 'running'
                                      ? 'bg-blue-500 animate-pulse'
                                      : st === 'retrying'
                                      ? 'bg-amber-500 animate-pulse'
                                      : st === 'failed'
                                      ? 'bg-red-500'
                                      : 'bg-slate-200'
                                  }`}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>

                  {/* Instant Snapshot of Real Extracted SEO Metadata right under the pipeline */}
                  {metadata && (
                    <div className="pt-4 border-t border-slate-100 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-semibold text-slate-700">
                          Instant HTML Check (Ready)
                        </p>
                        <button
                          type="button"
                          onClick={() => setRightTab('seo')}
                          className="text-xs font-medium text-[#1A73E8] hover:underline cursor-pointer"
                        >
                          Inspect all tags →
                        </button>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5">
                          <p className="text-[11px] text-slate-500">Title</p>
                          <p className="text-sm font-bold font-mono tabular-nums text-slate-900">
                            {titleLen}ch
                          </p>
                        </div>
                        <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5">
                          <p className="text-[11px] text-slate-500">H1 Tags</p>
                          <p className="text-sm font-bold font-mono tabular-nums text-slate-900">
                            {metadata.h1s.length}
                          </p>
                        </div>
                        <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5">
                          <p className="text-[11px] text-slate-500">No Alt</p>
                          <p className="text-sm font-bold font-mono tabular-nums text-slate-900">
                            {metadata.missingAltImages}/{metadata.totalImages}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : metadata ? (
                <div className="space-y-3.5 text-xs">
                  <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-700">Page Title</span>
                      <span className="font-mono tabular-nums flex items-center gap-1 text-slate-600">
                        {titleLen >= 25 && titleLen <= 65 ? (
                          <CheckCircle2 size={12} className="text-emerald-600" />
                        ) : (
                          <AlertTriangle size={12} className="text-amber-600" />
                        )}
                        {titleLen} chars
                      </span>
                    </div>
                    <p className="text-slate-900 leading-snug">{metadata.title || 'Not detected'}</p>
                  </div>

                  <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-700">Meta Description</span>
                      <span className="font-mono tabular-nums flex items-center gap-1 text-slate-600">
                        {descLen >= 70 && descLen <= 165 ? (
                          <CheckCircle2 size={12} className="text-emerald-600" />
                        ) : (
                          <AlertTriangle size={12} className="text-amber-600" />
                        )}
                        {descLen} chars
                      </span>
                    </div>
                    <p className="text-slate-700 leading-relaxed">
                      {metadata.description || 'Missing meta description tag'}
                    </p>
                  </div>

                  <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
                    <span className="font-semibold text-slate-700">Detected H1 Headline</span>
                    <p className="text-slate-900 leading-snug">
                      {metadata.h1s[0] || 'No H1 element extracted from initial HTML'}
                    </p>
                  </div>

                  {metadata.ctaTexts.length > 0 && (
                    <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
                      <span className="font-semibold text-slate-700">Detected CTA &amp; Nav Labels</span>
                      <p className="text-slate-600 leading-relaxed">
                        {metadata.ctaTexts.slice(0, 8).join(' · ')}
                      </p>
                    </div>
                  )}
                </div>
              ) : null}
            </div>

            <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/60 flex items-center justify-between text-[11px] text-slate-500">
              <span>Parallel Gemini 4 Vision</span>
              <span className="font-mono tabular-nums">
                {desktopAudit && mobileAudit
                  ? 'Finalizing...'
                  : canEnterEarly
                  ? 'Preview ready'
                  : 'Scanning...'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
