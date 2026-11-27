import React, { Suspense, useState, useEffect, useCallback, useRef } from 'react';
import {
  Plus,
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
} from 'lucide-react';
import type {
  AuditFinding,
  AuditGoal,
  AuditHistoryHeader,
  AuditSession,
  CanvasOverlay,
  CaptureInfo,
  CaptureMode,
  PageAuditProgress,
  CaptureStage,
  ChatMessage,
  CopyVariant,
  HeroRedesignItem,
  SeoMetadata,
  ToastNotice,
  ViewportAudit,
  ViewportData,
  ViewportKey,
  WorkspaceTab,
} from './types';
import {
  auditMoreElements,
  auditPage,
  getAccessState,
  auditSingleElement,
  pollAuditProgress,
  auditViewport,
  captureCompetitorPreview,
  captureUrl,
  compareViewports,
  generateAudioBriefing,
  generateCopyVariants,
  CaptureBlockedError,
  generateFindingFixCode,
  isAbortError,
  runSerpResearch,
  streamStrategistChat,
} from './services/apiClient';
import {
  backfillThumbnails,
  deleteAuditSession,
  getAuditSession,
  listAuditHeaders,
  saveAuditSession,
} from './services/historyStore';
// Exports load on first use; they are not needed for first paint.
const loadExports = () => import('./utils/exportUtils');
import {
  cropImagePx,
  ingestImage,
  viewportDataFrom,
  type IngestedImage,
} from './lib/client/images';
import { firstScreenRect, heroRedesignRect, pageViewOf } from './lib/client/pageView';
import { stackToasts, toastDurationMs } from './lib/client/toasts';
import { priorityRows } from './lib/client/priorities';
import { HistoryRail } from './components/HistoryRail';
import { LaunchStudio } from './components/LaunchStudio';
import type { LiveScanProgress } from './components/AuditProgressOverlay';
import type { RedesignModalTarget } from './components/RedesignStudioModal';
// Everything after the Launch Studio is split into its own chunks and preloaded when idle.
import {
  AuditProgressOverlay,
  CanvasWorkspace,
  CompareWorkspace,
  RedesignStudioModal,
  ReportWorkspace,
  SerpIntelWorkspace,
  StrategistChatWorkspace,
  preloadAll,
  preloadAuditParts,
} from './components/lazyParts';
import { DelayedFallback } from './components/DelayedFallback';
import { AccessTokenCard } from './components/AccessTokenCard';
import { promptSignIn } from './lib/client/access';

const WORKSPACE_TABS: { id: WorkspaceTab; label: string }[] = [
  { id: 'canvas', label: 'Canvas' },
  { id: 'compare', label: 'Compare' },
  { id: 'serp', label: 'SERP Intel' },
  { id: 'chat', label: 'Copy & Chat' },
  { id: 'report', label: 'Report' },
];

const EMPTY_META: SeoMetadata = {
  title: '',
  description: '',
  h1s: [],
  h2s: [],
  totalImages: 0,
  missingAltImages: 0,
  ctaTexts: [],
  wordCount: 0,
  textPreview: '',
};

const INITIAL_PROGRESS: LiveScanProgress = {
  capture: 'waiting',
  desktopAudit: 'waiting',
  mobileAudit: 'waiting',
  compare: 'waiting',
};

function buildChatAuditContext(session: AuditSession): string {
  const desktop = session.viewports.desktop?.analysis;
  const mobile = session.viewports.mobile?.analysis;
  const primary = desktop || mobile;
  const formatItems = (items: AuditFinding[], prefix: string, limit: number) =>
    items
      .slice(0, limit)
      .map(
        (f, idx) =>
          `${prefix}${idx + 1}. [${f.severity.toUpperCase()}] ${f.context} (${f.category}): ${f.seo_analysis} | Fix: ${f.suggested_optimization}`
      )
      .join('\n');

  const desktopFindings = desktop ? formatItems(desktop.items || [], 'D', 10) : '';
  const mobileFindings = mobile ? formatItems(mobile.items || [], 'M', 8) : '';
  const topPriorityLines = priorityRows(primary)
    .map((r) => `${r.rank}. ${r.item.context}${r.blocker ? ' [BLOCKER]' : ''}: ${r.reason}`)
    .join('\n');
  const meta = session.seoMetadata;
  const t = meta.telemetry;
  const serp = session.serpResearch;

  return [
    `Domain: ${session.domain}`,
    `URL: ${session.url || 'Uploaded design'}`,
    `Title: ${meta.title || session.pageTitle}`,
    `Meta Description: ${meta.description || 'None'}`,
    `Canonical: ${meta.canonical || 'Not detected'} | Robots: ${meta.robotsMeta || 'None'} | Schema: ${meta.schemaTypes?.join(', ') || 'None'}`,
    t
      ? `Telemetry: ${t.renderedWordCount} rendered words, ${t.renderedH1Count} H1, ${t.contrastFailures.length} measured contrast failures, ${t.mobileSmallTapTargets24 ?? t.smallTapTargets24} tap targets <24px${t.cwv ? `, Lab LCP ${t.cwv.lcpMs ?? 'n/a'}ms, CLS ${t.cwv.cls ?? 'n/a'}` : ''}`
      : '',
    desktop?.scores
      ? `Desktop Scores: Overall ${desktop.scores.overall ?? 0}, Clarity ${desktop.scores.clarity ?? 0}, Visual ${desktop.scores.visual_hierarchy ?? 0}, Conversion ${desktop.scores.conversion ?? 0}, Trust ${desktop.scores.trust_eeat ?? 0}`
      : '',
    mobile?.scores
      ? `Mobile Scores: Overall ${mobile.scores.overall ?? 0}, Clarity ${mobile.scores.clarity ?? 0}, Visual ${mobile.scores.visual_hierarchy ?? 0}, Conversion ${mobile.scores.conversion ?? 0}, Trust ${mobile.scores.trust_eeat ?? 0}`
      : '',
    session.comparison
      ? `Cross-Device Parity: ${session.comparison.parity_score}/100 (${session.comparison.executive_verdict})`
      : '',
    primary ? `Executive Summary: ${primary.overall_summary || ''}` : '',
    topPriorityLines ? `Top Priorities:\n${topPriorityLines}` : '',
    desktopFindings ? `Desktop Findings:\n${desktopFindings}` : '',
    mobileFindings ? `Mobile Findings:\n${mobileFindings}` : '',
    serp
      ? `SERP Intel (${serp.search_intent || 'live search'}): ${serp.positioning_verdict}\nRivals: ${serp.competitors.slice(0, 4).map((c) => `${c.name} ("${c.value_prop_hook}")`).join('; ')}\nDifferentiators: ${serp.quick_differentiators.slice(0, 3).join('; ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** True when two URLs (with or without scheme) share a hostname, ignoring "www.". */
function sameHost(a: string, b: string): boolean {
  const host = (u: string) => {
    try {
      return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  };
  return Boolean(host(a)) && host(a) === host(b);
}

/** A notice when the page could not be captured the way the user asked, or was cut short. */
function describeModeOutcome(
  requested: CaptureMode,
  desktop: CaptureInfo | null,
  mobile: CaptureInfo | null
): string | null {
  const shots = [desktop, mobile].filter((c): c is CaptureInfo => Boolean(c));
  if (requested === 'fullpage' && shots.some((c) => c.captureMode !== 'fullpage')) {
    return 'A full-page capture was not available for this site, so the first screen was audited instead.';
  }
  if (shots.some((c) => c.truncated)) {
    return 'This page is very long, so it was captured up to the height limit. Findings below that point are not included.';
  }
  return null;
}

/** A notice when a shot came from a fallback service, which is less faithful than Microlink. */
function describeFallbackCapture(desktop: CaptureInfo | null, mobile: CaptureInfo | null): string | null {
  const notes: string[] = [];
  const primary = (p: string) => p === 'microlink' || p === 'playwright';
  if (desktop && !primary(desktop.provider)) notes.push(`desktop via ${desktop.provider}`);
  if (mobile && !primary(mobile.provider)) {
    notes.push(`mobile via ${mobile.provider} (a narrow desktop render, not a real phone view)`);
  }
  return notes.length ? `Captured with a fallback service: ${notes.join('; ')}.` : null;
}

/** Audit one viewport with the route that fits its capture mode. */
function auditFor(
  vp: ViewportData,
  key: ViewportKey,
  base: AuditSession,
  sendMetadata: boolean,
  signal?: AbortSignal,
  onProgress?: (p: PageAuditProgress) => void
): Promise<ViewportAudit> {
  const common = {
    screenshotDataUrl: vp.screenshotDataUrl,
    viewport: key,
    url: base.url || undefined,
    metadata: sendMetadata ? base.seoMetadata : undefined,
    auditGoal: base.auditGoal,
    targetKeyword: base.targetKeyword,
  };
  if (vp.captureMode === 'fullpage') {
    // A fresh id per audit; the overlay polls it so a long wait shows which section is running.
    const progressId = onProgress && globalThis.crypto?.randomUUID ? crypto.randomUUID() : undefined;
    const stop = progressId ? pollAuditProgress(progressId, onProgress!, { signal }) : () => {};
    return auditPage({ ...common, foldPx: pageViewOf(vp, key).foldPx, progressId }, { signal }).finally(stop);
  }
  return auditViewport(common, { signal });
}

/** The first screen of a viewport's image: the whole image for a viewport shot, a crop for a full page. */
async function firstScreenImage(vp: ViewportData, key: ViewportKey): Promise<string> {
  const view = pageViewOf(vp, key);
  if (!view.showFold) return vp.screenshotDataUrl;
  return cropImagePx(vp.screenshotDataUrl, firstScreenRect(view));
}

/** Parity compares what each device shows first, so full pages are cut to their first screen. */
async function compareFirstScreens(
  desktop: ViewportData,
  mobile: ViewportData,
  url: string,
  signal?: AbortSignal
) {
  const [d, m] = await Promise.all([firstScreenImage(desktop, 'desktop'), firstScreenImage(mobile, 'mobile')]);
  return compareViewports({ desktopScreenshot: d, mobileScreenshot: m, url: url || undefined }, { signal });
}

/** One audit pipeline run. `draft` is its latest partial session, used by "Explore Canvas Now". */
interface AuditRun {
  controller: AbortController;
  draft: AuditSession | null;
}

function withViewportAnalysis(
  s: AuditSession,
  key: ViewportKey,
  analysis: ViewportAudit
): AuditSession {
  const vp = s.viewports[key];
  if (!vp) return s;
  return { ...s, viewports: { ...s.viewports, [key]: { ...vp, analysis } } };
}

function addFindings(
  s: AuditSession,
  key: ViewportKey,
  items: AuditFinding[],
  where: 'append' | 'prepend'
): AuditSession {
  const vp = s.viewports[key];
  if (!vp?.analysis) return s;
  const merged =
    where === 'append' ? [...vp.analysis.items, ...items] : [...items, ...vp.analysis.items];
  return withViewportAnalysis(s, key, {
    ...vp.analysis,
    items: merged,
    critical_count: merged.filter((i) => i.severity === 'critical').length,
    warning_count: merged.filter((i) => i.severity === 'warning').length,
    info_count: merged.filter((i) => i.severity === 'info').length,
  });
}

const App: React.FC = () => {
  const [history, setHistory] = useState<AuditHistoryHeader[]>([]);
  const [railCollapsed, setRailCollapsed] = useState(false);

  const [session, setSession] = useState<AuditSession | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('canvas');
  const [activeViewport, setActiveViewport] = useState<ViewportKey>('desktop');

  const [stage, setStage] = useState<CaptureStage>('idle');
  const [stageLabel, setStageLabel] = useState('');
  const [liveProgress, setLiveProgress] = useState<LiveScanProgress>(INITIAL_PROGRESS);
  const [liveDesktopShot, setLiveDesktopShot] = useState<string | null>(null);
  const [liveMobileShot, setLiveMobileShot] = useState<string | null>(null);
  const [liveMetadata, setLiveMetadata] = useState<SeoMetadata | null>(null);
  const [liveDesktopAudit, setLiveDesktopAudit] = useState<AuditSession['viewports']['desktop']>(null);
  const [liveMobileAudit, setLiveMobileAudit] = useState<AuditSession['viewports']['mobile']>(null);
  const [draftSession, setDraftSession] = useState<AuditSession | null>(null);
  // Live section progress of each full-page audit while it runs (from /api/audit/progress).
  const [pageProgress, setPageProgress] = useState<Partial<Record<ViewportKey, PageAuditProgress>>>({});
  const [fatalError, setFatalError] = useState<string | null>(null);
  // Page metadata the server still read when a site blocked capture (422). Reused if the user
  // then uploads a screenshot of the same site, so the audit still gets the real title and headings.
  const [blockedCapture, setBlockedCapture] = useState<{
    url: string;
    metadata: SeoMetadata;
    warnings?: string[];
  } | null>(null);
  const [launchPreset, setLaunchPreset] = useState<{ mode: 'url' | 'upload'; uploadContext: string; initialUrl?: string } | null>(null);

  const [isDeepScanning, setIsDeepScanning] = useState(false);
  const [isAuditingRegion, setIsAuditingRegion] = useState(false);
  const [generatingFixId, setGeneratingFixId] = useState<string | null>(null);
  const [capturingCompUrl, setCapturingCompUrl] = useState<string | null>(null);
  const [isComparing, setIsComparing] = useState(false);
  const [isLoadingSerp, setIsLoadingSerp] = useState(false);
  const [isGeneratingCopy, setIsGeneratingCopy] = useState(false);
  const [isStreamingChat, setIsStreamingChat] = useState(false);
  const [isGeneratingAudio, setIsGeneratingAudio] = useState(false);

  const [redesignTarget, setRedesignTarget] = useState<RedesignModalTarget | null>(null);
  const [focusedFindingId, setFocusedFindingId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastNotice[]>([]);

  const isWorking =
    stage === 'capturing' ||
    stage === 'auditing-desktop' ||
    stage === 'auditing-mobile' ||
    stage === 'comparing';

  // One dismiss timer per visible toast; hovering or focusing a toast pauses it.
  const toastTimers = useRef(new Map<string, number>());
  const dismissToast = useCallback((id: string) => {
    window.clearTimeout(toastTimers.current.get(id));
    toastTimers.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
  const scheduleToast = useCallback(
    (id: string, ms: number) => {
      window.clearTimeout(toastTimers.current.get(id));
      toastTimers.current.set(id, window.setTimeout(() => dismissToast(id), ms));
    },
    [dismissToast]
  );
  const pauseToast = useCallback((id: string) => {
    window.clearTimeout(toastTimers.current.get(id));
    toastTimers.current.delete(id);
  }, []);

  const pushToast = useCallback(
    (type: ToastNotice['type'], message: string) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setToasts((prev) => {
        const { visible, dropped } = stackToasts(prev, { id, type, message });
        dropped.forEach((t) => pauseToast(t.id));
        return visible;
      });
      scheduleToast(id, toastDurationMs(type, message));
    },
    [pauseToast, scheduleToast]
  );

  const refreshHistory = useCallback(async () => {
    try {
      const headers = await listAuditHeaders();
      setHistory(headers);
    } catch {
      // Ignore transient IndexedDB read issues
    }
  }, []);

  useEffect(() => {
    refreshHistory().then(() =>
      backfillThumbnails().then((changed) => {
        if (changed > 0) refreshHistory();
      })
    );
  }, [refreshHistory]);

  // The open session lives in a ref as well as in state, so async handlers always
  // build on the latest copy instead of the one their closure captured.
  const sessionRef = useRef<AuditSession | null>(null);

  const showSession = useCallback((next: AuditSession | null) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  /** Apply `fn` to the open session `id` in memory only. Returns null if `id` is not open. */
  const patchOpenSession = useCallback(
    (id: string, fn: (s: AuditSession) => AuditSession): AuditSession | null => {
      const current = sessionRef.current;
      if (!current || current.id !== id) return null;
      const next = fn(current);
      sessionRef.current = next;
      setSession(next);
      return next;
    },
    []
  );

  /**
   * The one way to change a saved audit. Applies `fn` to the latest copy of session `id`
   * (the open one, else the stored one, else `fallback`) and saves the result.
   */
  const updateSession = useCallback(
    async (
      id: string,
      fn: (s: AuditSession) => AuditSession,
      fallback?: AuditSession
    ): Promise<AuditSession | null> => {
      const stamp = (s: AuditSession) => ({ ...fn(s), updatedAt: new Date().toISOString() });
      let next = patchOpenSession(id, stamp);
      if (!next) {
        const base = (await getAuditSession(id)) ?? fallback;
        if (!base) return null;
        next = stamp(base);
      }
      try {
        await saveAuditSession(next);
      } catch (err: any) {
        pushToast('error', err?.message || 'This audit could not be saved to browser storage.');
      }
      await refreshHistory();
      return next;
    },
    [patchOpenSession, refreshHistory, pushToast]
  );

  // One audit run at a time. A run is "live" until it finishes, fails, or is cancelled;
  // results from a run that is no longer live are dropped.
  const runRef = useRef<AuditRun | null>(null);

  const startRun = (): AuditRun => {
    if (runRef.current) {
      runRef.current.controller.abort();
      pushToast('info', 'The audit that was still running has been cancelled.');
    }
    const run: AuditRun = { controller: new AbortController(), draft: null };
    runRef.current = run;
    return run;
  };

  const cancelRun = () => {
    runRef.current?.controller.abort();
    runRef.current = null;
  };

  const isLive = (run: AuditRun) => runRef.current === run;

  // Shared parallel audit execution across captured/uploaded viewports
  /** `sendMetadata`: pass the page's HTML metadata to the audit (URL captures, and uploads that reuse a blocked capture's metadata). */
  const executeParallelAudits = async (
    run: AuditRun,
    baseSession: AuditSession,
    sendMetadata = baseSession.sourceType === 'url'
  ) => {
    const signal = run.controller.signal;
    const desktopImg = baseSession.viewports.desktop?.screenshotDataUrl || null;
    const mobileImg = baseSession.viewports.mobile?.screenshotDataUrl || null;
    const hasBoth = Boolean(desktopImg && mobileImg);

    let draft = baseSession;
    const publishDraft = (next: AuditSession) => {
      draft = next;
      run.draft = next;
      setDraftSession(next);
    };

    publishDraft(baseSession);
    setLiveProgress({
      capture: 'done',
      desktopAudit: desktopImg ? 'active' : 'skipped',
      mobileAudit: mobileImg ? 'active' : 'skipped',
      compare: hasBoth ? 'active' : 'skipped',
    });
    setStage('auditing-desktop');

    const tasks: Promise<void>[] = [];

    for (const key of ['desktop', 'mobile'] as const) {
      const vpData = baseSession.viewports[key];
      if (!vpData) continue;
      tasks.push(
        auditFor(vpData, key, baseSession, sendMetadata, signal, (p) => {
          if (isLive(run)) setPageProgress((prev) => ({ ...prev, [key]: p }));
        }).then((analysis) => {
          if (!isLive(run)) return;
          (analysis.warnings ?? []).forEach((w) =>
            pushToast('info', `${key === 'desktop' ? 'Desktop' : 'Mobile'}: ${w}`)
          );
          publishDraft(withViewportAnalysis(draft, key, analysis));
          const vp = draft.viewports[key];
          if (key === 'desktop') setLiveDesktopAudit(vp ? { ...vp } : null);
          else setLiveMobileAudit(vp ? { ...vp } : null);
          patchOpenSession(baseSession.id, (s) => withViewportAnalysis(s, key, analysis));
          setLiveProgress((p) => ({ ...p, [key === 'desktop' ? 'desktopAudit' : 'mobileAudit']: 'done' }));
        })
      );
    }

    if (hasBoth && baseSession.viewports.desktop && baseSession.viewports.mobile) {
      tasks.push(
        compareFirstScreens(baseSession.viewports.desktop, baseSession.viewports.mobile, baseSession.url, signal)
          .then((comparison) => {
            if (!isLive(run)) return;
            publishDraft({ ...draft, comparison });
            patchOpenSession(baseSession.id, (s) => ({ ...s, comparison }));
            setLiveProgress((p) => ({ ...p, compare: 'done' }));
          })
          .catch(() => {
            if (isLive(run)) setLiveProgress((p) => ({ ...p, compare: 'done' }));
          })
      );
    }

    const results = await Promise.allSettled(tasks);
    if (!isLive(run)) return;

    const anyAuditSucceeded = Boolean(
      draft.viewports.desktop?.analysis || draft.viewports.mobile?.analysis
    );
    if (!anyAuditSucceeded) {
      const firstRejected = results.find((r) => r.status === 'rejected') as
        | PromiseRejectedResult
        | undefined;
      throw new Error(firstRejected?.reason?.message || 'Vision audit failed. Please try again.');
    }

    // The run is done; from here it can no longer be cancelled.
    runRef.current = null;
    const finished = draft;
    const stillWatching = !sessionRef.current || sessionRef.current.id === finished.id;
    // Merge the results into the latest copy, so changes made after "Explore Canvas Now" survive.
    const saved = await updateSession(
      finished.id,
      (s) => {
        let next = s;
        for (const key of ['desktop', 'mobile'] as const) {
          const analysis = finished.viewports[key]?.analysis;
          if (analysis) next = withViewportAnalysis(next, key, analysis);
        }
        return finished.comparison ? { ...next, comparison: finished.comparison } : next;
      },
      finished
    );
    setDraftSession(null);
    if (stillWatching) {
      if (saved && !sessionRef.current) {
        showSession(saved);
        setActiveViewport(desktopImg ? 'desktop' : 'mobile');
      }
      setStage('ready');
    }
    pushToast('success', `Full audit complete for ${finished.domain}`);
  };

  /** Show a failed run's error, unless the run was cancelled or replaced. */
  const failRun = (run: AuditRun, err: any, fallbackMessage: string) => {
    if (!isLive(run) || isAbortError(err)) return;
    runRef.current = null;
    setFatalError(err?.message || fallbackMessage);
    setStage('error');
  };

  // Run full pipeline from Live URL
  useEffect(() => {
    preloadAll();
    // A server with an access token: ask for it up front instead of after the first refused call.
    getAccessState().then((s) => {
      if (s.required && !s.authenticated) promptSignIn();
    });
  }, []);

  const handleStartUrlAudit = async (
    rawUrl: string,
    options?: { auditGoal: AuditGoal; targetKeyword: string; captureMode?: CaptureMode }
  ) => {
    preloadAuditParts();
    const run = startRun();
    setFatalError(null);
    setBlockedCapture(null);
    showSession(null);
    setStage('capturing');
    setStageLabel(rawUrl.replace(/^https?:\/\//, ''));
    setLiveDesktopShot(null);
    setLiveMobileShot(null);
    setLiveMetadata(null);
    setLiveDesktopAudit(null);
    setPageProgress({});
    setLiveMobileAudit(null);
    setDraftSession(null);
    setLiveProgress({
      capture: 'active',
      desktopAudit: 'waiting',
      mobileAudit: 'waiting',
      compare: 'waiting',
    });
    setActiveTab('canvas');

    try {
      const requestedMode: CaptureMode = options?.captureMode ?? 'fullpage';
      const captured = await captureUrl(rawUrl, requestedMode, { signal: run.controller.signal });
      if (!isLive(run)) return;
      // Measure (and if needed scale) each capture. Captures are single viewports today.
      const [desktopImg, mobileImg] = await Promise.all([
        captured.desktopScreenshot ? ingestImage(captured.desktopScreenshot, 'desktop', 'capture') : null,
        captured.mobileScreenshot ? ingestImage(captured.mobileScreenshot, 'mobile', 'capture') : null,
      ]);
      if (!isLive(run)) return;
      setLiveDesktopShot(desktopImg?.dataUrl ?? null);
      setLiveMobileShot(mobileImg?.dataUrl ?? null);
      setLiveMetadata(captured.metadata);

      // The server explains fallbacks and cut pages itself; our own notes are for an older server.
      const warnings = captured.captureWarnings ?? [];
      if (warnings.length > 0) {
        warnings.forEach((w) => pushToast('info', w));
      } else {
        const fallbackNote = describeFallbackCapture(captured.desktopCapture, captured.mobileCapture);
        if (fallbackNote) pushToast('info', fallbackNote);
        const modeNote = describeModeOutcome(requestedMode, captured.desktopCapture, captured.mobileCapture);
        if (modeNote) pushToast('info', modeNote);
      }

      const baseSession: AuditSession = {
        id: `audit-${Date.now()}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceType: 'url',
        url: captured.url,
        domain: captured.domain,
        pageTitle: captured.metadata.title || captured.domain,
        auditGoal: options?.auditGoal || 'general',
        targetKeyword: options?.targetKeyword || '',
        resolvedFindingIds: [],
        codeFixes: {},
        seoMetadata: captured.metadata,
        viewports: {
          desktop: desktopImg
            ? viewportDataFrom(desktopImg, 'desktop', 'viewport', captured.desktopCapture ?? undefined)
            : null,
          mobile: mobileImg
            ? viewportDataFrom(mobileImg, 'mobile', 'viewport', captured.mobileCapture ?? undefined)
            : null,
        },
        comparison: null,
        heroRedesigns: [],
        serpResearch: null,
        copyVariants: [],
        chatHistory: [],
        audioBriefing: null,
      };

      await executeParallelAudits(run, baseSession);
    } catch (err: any) {
      if (err instanceof CaptureBlockedError && err.metadata && isLive(run)) {
        setBlockedCapture({ url: rawUrl, metadata: err.metadata, warnings: err.warnings });
      }
      failRun(run, err, 'Audit failed. Please try again or upload a screenshot.');
    }
  };

  // Run full pipeline from Uploaded / Pasted Screenshots
  const handleStartUploadAudit = async (params: {
    desktop: IngestedImage | null;
    mobile: IngestedImage | null;
    desktopMode?: CaptureMode;
    mobileMode?: CaptureMode;
    urlContext: string;
    auditGoal?: AuditGoal;
    targetKeyword?: string;
  }) => {
    const { desktop, mobile, urlContext, auditGoal = 'general', targetKeyword = '' } = params;
    if (!desktop && !mobile) return;
    preloadAuditParts();

    let domain = 'uploaded-design';
    let normalizedUrl = '';
    if (urlContext) {
      try {
        const withProto = /^https?:\/\//i.test(urlContext) ? urlContext : `https://${urlContext}`;
        const parsed = new URL(withProto);
        domain = parsed.hostname.replace(/^www\./, '');
        normalizedUrl = parsed.toString();
      } catch {
        domain = urlContext.slice(0, 32);
      }
    }

    const reusedMeta =
      blockedCapture && sameHost(blockedCapture.url, normalizedUrl) ? blockedCapture.metadata : null;
    const run = startRun();
    setFatalError(null);
    showSession(null);
    setStage('auditing-desktop');
    setStageLabel(domain);
    setLiveDesktopShot(desktop?.dataUrl ?? null);
    setLiveMobileShot(mobile?.dataUrl ?? null);
    setLiveMetadata(null);
    setLiveDesktopAudit(null);
    setPageProgress({});
    setLiveMobileAudit(null);
    setDraftSession(null);
    setActiveTab('canvas');

    try {
      const baseSession: AuditSession = {
        id: `audit-${Date.now()}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceType: 'upload',
        url: normalizedUrl,
        domain,
        pageTitle: reusedMeta?.title || domain,
        auditGoal,
        targetKeyword,
        resolvedFindingIds: [],
        codeFixes: {},
        seoMetadata: reusedMeta
          ? { ...reusedMeta, url: normalizedUrl || reusedMeta.url }
          : { ...EMPTY_META, title: domain, url: normalizedUrl || undefined },
        viewports: {
          desktop: desktop ? viewportDataFrom(desktop, 'desktop', params.desktopMode) : null,
          mobile: mobile ? viewportDataFrom(mobile, 'mobile', params.mobileMode) : null,
        },
        comparison: null,
        heroRedesigns: [],
        serpResearch: null,
        copyVariants: [],
        chatHistory: [],
        audioBriefing: null,
      };

      if (reusedMeta) setBlockedCapture(null);
      await executeParallelAudits(run, baseSession, Boolean(reusedMeta));
    } catch (err: any) {
      failRun(run, err, 'Screenshot analysis failed.');
    }
  };

  const handleEnterEarly = () => {
    const draft = runRef.current?.draft ?? draftSession;
    if (!draft) return;
    showSession(draft);
    setActiveViewport(draft.viewports.desktop?.analysis ? 'desktop' : 'mobile');
    setStage('ready');
  };

  // Load saved audit from IndexedDB
  const handleSelectHistory = async (id: string) => {
    preloadAuditParts();
    const loaded = await getAuditSession(id);
    if (!loaded) return;
    if (isWorking) cancelRun();
    const hasAnalysis = Boolean(loaded.viewports.desktop?.analysis || loaded.viewports.mobile?.analysis);
    if (!hasAnalysis && loaded.sourceType === 'url' && loaded.url) {
      // Never fire a paid re-audit silently on click: pre-fill Launch Studio so user can confirm settings.
      showSession(null);
      setLaunchPreset({ mode: 'url', uploadContext: '', initialUrl: loaded.url });
      setStage('idle');
      setFatalError(null);
      pushToast('info', 'Loaded incomplete audit into Launch Studio so you can review settings before auditing.');
      return;
    }
    showSession(loaded);
    setStage('ready');
    setFatalError(null);
    setActiveViewport(loaded.viewports.desktop ? 'desktop' : 'mobile');
    setActiveTab('canvas');
  };

  const handleDeleteHistory = async (id: string) => {
    try {
      await deleteAuditSession(id);
    } catch {
      pushToast('error', 'Could not delete this audit from browser storage.');
      return;
    }
    if (sessionRef.current?.id === id) {
      showSession(null);
      setStage('idle');
    }
    await refreshHistory();
    pushToast('info', 'Audit removed from local history');
  };

  const handleCleanIncompleteHistory = async () => {
    const incomplete = history.filter((h) => (h.desktopScore ?? h.mobileScore) === null);
    if (incomplete.length === 0) return;
    try {
      await Promise.all(incomplete.map((h) => deleteAuditSession(h.id)));
    } catch {
      pushToast('error', 'Some incomplete audits could not be deleted.');
    }
    if (sessionRef.current && incomplete.some((h) => h.id === sessionRef.current?.id)) {
      showSession(null);
      setStage('idle');
    }
    await refreshHistory();
    pushToast(
      'success',
      `Removed ${incomplete.length} incomplete audit${incomplete.length > 1 ? 's' : ''} from history.`
    );
  };

  const handleInspectFinding = (viewport: ViewportKey, findingId: string) => {
    setActiveViewport(viewport);
    setActiveTab('canvas');
    setFocusedFindingId(findingId);
  };

  // Deep Scan Round 2 (section-aware on tall full-page screenshots)
  const handleDeepScan = async (sectionIndex?: number) => {
    if (!session) return;
    const sessionId = session.id;
    const vpKey = activeViewport;
    const vp = session.viewports[vpKey];
    if (!vp?.screenshotDataUrl || !vp.analysis) return;

    setIsDeepScanning(true);
    try {
      const { items } = await auditMoreElements({
        screenshotDataUrl: vp.screenshotDataUrl,
        viewport: vpKey,
        existingItems: [...vp.analysis.items, ...(vp.analysis.omitted_items ?? [])],
        sectionIndex,
      });
      if (items.length === 0) {
        pushToast('info', 'Deep scan found no additional unflagged issues in this section.');
        return;
      }
      await updateSession(sessionId, (s) => addFindings(s, vpKey, items, 'append'));
      pushToast('success', `Added ${items.length} newly discovered findings.`);
    } catch (err: any) {
      pushToast('error', err?.message || 'Deep scan failed.');
    } finally {
      setIsDeepScanning(false);
    }
  };

  // Manual Region Audit
  const handleAuditManualRegion = async (
    croppedDataUrl: string,
    box: [number, number, number, number]
  ) => {
    if (!session) return;
    const sessionId = session.id;
    const vpKey = activeViewport;
    if (!session.viewports[vpKey]?.analysis) return;

    setIsAuditingRegion(true);
    try {
      const { item } = await auditSingleElement({
        croppedImageDataUrl: croppedDataUrl,
        viewport: vpKey,
        box_2d: box,
      });
      await updateSession(sessionId, (s) => addFindings(s, vpKey, [item], 'prepend'));
      pushToast('success', 'Custom region audited and added to inspector.');
    } catch (err: any) {
      pushToast('error', err?.message || 'Region audit failed.');
    } finally {
      setIsAuditingRegion(false);
    }
  };

  // Update Overlays (Element Redesign)
  const handleUpdateOverlays = async (viewport: ViewportKey, overlays: CanvasOverlay[]) => {
    if (!session) return;
    await updateSession(session.id, (s) => {
      const vp = s.viewports[viewport];
      return vp ? { ...s, viewports: { ...s.viewports, [viewport]: { ...vp, overlays } } } : s;
    });
  };

  const handleApplyElementOverlay = async (
    dataUrl: string,
    prompt: string,
    boxPct: { x: number; y: number; w: number; h: number }
  ) => {
    if (!session || !redesignTarget) return;
    const target = redesignTarget;
    const newOverlay: CanvasOverlay = {
      id: `ov-${Date.now()}`,
      base64: dataUrl,
      x: boxPct.x,
      y: boxPct.y,
      w: boxPct.w,
      h: boxPct.h,
      label: target.context,
      prompt,
    };
    await updateSession(session.id, (s) => {
      const vp = s.viewports[target.viewport];
      if (!vp) return s;
      return {
        ...s,
        viewports: {
          ...s.viewports,
          [target.viewport]: { ...vp, overlays: [...vp.overlays, newOverlay] },
        },
      };
    });
    pushToast('success', 'Redesigned element placed on live canvas.');
  };

  const handleSaveHeroRedesign = async (item: HeroRedesignItem) => {
    if (!session) return;
    await updateSession(session.id, (s) => ({
      ...s,
      heroRedesigns: [item, ...s.heroRedesigns].slice(0, 6),
    }));
    pushToast('success', 'Full-hero redesign saved to session.');
  };

  const handleDeleteHeroRedesign = async (id: string) => {
    if (!session) return;
    await updateSession(session.id, (s) => ({
      ...s,
      heroRedesigns: s.heroRedesigns.filter((r) => r.id !== id),
    }));
    pushToast('info', 'Hero concept removed.');
  };

  // Upload missing viewport from Compare tab
  const handleUploadMissingViewport = async (vpKey: ViewportKey, file: File) => {
    if (!session) return;
    const base = session;
    setIsComparing(true);
    try {
      const img = await ingestImage(file, vpKey);
      const fresh = viewportDataFrom(img, vpKey);
      const analysis = await auditFor(fresh, vpKey, base, true);
      const newViewport = { ...fresh, analysis };
      const desktopVp = vpKey === 'desktop' ? newViewport : base.viewports.desktop;
      const mobileVp = vpKey === 'mobile' ? newViewport : base.viewports.mobile;
      const comparison =
        desktopVp && mobileVp ? await compareFirstScreens(desktopVp, mobileVp, base.url) : null;
      await updateSession(base.id, (s) => ({
        ...s,
        viewports: { ...s.viewports, [vpKey]: newViewport },
        comparison: comparison ?? s.comparison,
      }));
      pushToast('success', `${vpKey === 'mobile' ? 'Mobile' : 'Desktop'} viewport audited and compared.`);
    } catch (err: any) {
      pushToast('error', err?.message || 'Could not audit uploaded viewport.');
    } finally {
      setIsComparing(false);
    }
  };

  // Re-run Parity Comparison
  const handleRunComparison = async () => {
    if (!session?.viewports.desktop || !session?.viewports.mobile) return;
    setIsComparing(true);
    try {
      const comparison = await compareFirstScreens(
        session.viewports.desktop,
        session.viewports.mobile,
        session.url
      );
      await updateSession(session.id, (s) => ({ ...s, comparison }));
      pushToast('success', 'Desktop vs. Mobile parity analysis updated.');
    } catch (err: any) {
      pushToast('error', err?.message || 'Comparison failed.');
    } finally {
      setIsComparing(false);
    }
  };

  // Toggle Finding Resolution Checklist
  const handleToggleResolveFinding = async (findingId: string) => {
    if (!session) return;
    await updateSession(session.id, (s) => {
      const prev = s.resolvedFindingIds || [];
      const next = prev.includes(findingId)
        ? prev.filter((id) => id !== findingId)
        : [...prev, findingId];
      return { ...s, resolvedFindingIds: next };
    });
  };

  // Generate 1-Click Code Fix Patch for a Finding
  const handleGenerateFixCode = async (finding: AuditFinding) => {
    if (!session) return;
    const sessionId = session.id;
    setGeneratingFixId(finding.id);
    try {
      const patch = await generateFindingFixCode({
        finding,
        domain: session.domain,
        url: session.url || undefined,
      });
      await updateSession(sessionId, (s) => ({
        ...s,
        codeFixes: { ...(s.codeFixes || {}), [finding.id]: patch },
      }));
      pushToast('success', 'Ready-to-paste code patch generated.');
    } catch (err: any) {
      pushToast('error', err?.message || 'Could not generate code fix.');
    } finally {
      setGeneratingFixId(null);
    }
  };

  // Closed-Loop Bridge: Visualize A/B Copy Variant directly in Full-Hero AI Redesign
  const handleVisualizeVariant = async (variant: CopyVariant) => {
    if (!session) return;
    const vpKey: ViewportKey = session.viewports.desktop ? 'desktop' : 'mobile';
    const vp = session.viewports[vpKey];
    if (!vp?.screenshotDataUrl) {
      pushToast('error', 'No viewport screenshot available to redesign.');
      return;
    }
    const promptDirective = [
      `Redesign this hero section using the "${variant.angle}" A/B test copy:`,
      `- Exact Hero Headline (H1): "${variant.headline}"`,
      `- Exact Subheadline: "${variant.subheadline}"`,
      `- Primary CTA Button: "${variant.primary_cta}"`,
      variant.secondary_cta ? `- Secondary CTA: "${variant.secondary_cta}"` : '',
      'Preserve the core brand palette while elevating typographic hierarchy, WCAG AA button contrast, clean whitespace, and above-the-fold trust proof.',
    ]
      .filter(Boolean)
      .join('\n');

    const heroCrop = heroRedesignRect(pageViewOf(vp, vpKey), vpKey);
    const needsHeroCrop = heroCrop.height < pageViewOf(vp, vpKey).size.height - 1;
    setRedesignTarget({
      mode: 'full-hero',
      imageDataUrl: needsHeroCrop ? await cropImagePx(vp.screenshotDataUrl, heroCrop) : vp.screenshotDataUrl,
      context: `${session.domain}: "${variant.angle}" hero concept`,
      suggestion: promptDirective,
      viewport: vpKey,
      topIssues: (vp.analysis?.items || [])
        .filter((i) => i.severity !== 'info')
        .slice(0, 4)
        .map((i) => `${i.context}: ${i.suggested_optimization}`),
    });
  };

  // Live SERP Research
  const handleRunSerpResearch = async () => {
    if (!session) return;
    const sessionId = session.id;
    setIsLoadingSerp(true);
    try {
      const primary = session.viewports.desktop?.analysis || session.viewports.mobile?.analysis;
      const result = await runSerpResearch({
        url: session.url || undefined,
        pageTitle: session.seoMetadata.title || session.pageTitle,
        metaDescription: session.seoMetadata.description,
        summary: primary?.overall_summary,
        auditGoal: session.auditGoal,
        targetKeyword: session.targetKeyword,
        metadata: session.seoMetadata,
      });
      await updateSession(sessionId, (s) => ({ ...s, serpResearch: result }));
      pushToast('success', `Found ${result.competitors.length} SERP competitors with grounded sources.`);
    } catch (err: any) {
      pushToast('error', err?.message || 'SERP research failed.');
    } finally {
      setIsLoadingSerp(false);
    }
  };

  // Capture Live Competitor Hero for Head-to-Head Visual Split
  const handleCaptureCompetitor = async (competitorUrl: string) => {
    if (!session?.serpResearch) return;
    const sessionId = session.id;
    setCapturingCompUrl(competitorUrl);
    try {
      const preview = await captureCompetitorPreview(competitorUrl);
      const capturedInfo = { width: preview.width, height: preview.height, provider: preview.provider };
      await updateSession(sessionId, (s) =>
        s.serpResearch
          ? {
              ...s,
              serpResearch: {
                ...s.serpResearch,
                competitors: s.serpResearch.competitors.map((c) =>
                  c.url === competitorUrl
                    ? { ...c, capturedScreenshot: preview.screenshotDataUrl, capturedInfo }
                    : c
                ),
              },
            }
          : s
      );
      pushToast('success', 'Competitor hero captured for side-by-side comparison.');
    } catch (err: any) {
      pushToast('error', err?.message || 'Could not capture competitor hero screenshot.');
    } finally {
      setCapturingCompUrl(null);
    }
  };

  // A/B Copy Variants (always sends first screen, never a 28,000 px sliver, plus SERP context when available)
  const handleGenerateCopy = async () => {
    if (!session) return;
    const sessionId = session.id;
    setIsGeneratingCopy(true);
    try {
      const vpKey: ViewportKey = session.viewports.desktop ? 'desktop' : 'mobile';
      const vp = session.viewports[vpKey];
      const primary = vp?.analysis;
      const heroImg = vp ? await firstScreenImage(vp, vpKey) : undefined;
      const serp = session.serpResearch;
      const serpContext = serp
        ? [
            serp.search_intent ? `Intent: ${serp.search_intent}` : '',
            `Verdict: ${serp.positioning_verdict}`,
            serp.competitors.length
              ? `Rival hooks: ${serp.competitors.slice(0, 3).map((c) => `${c.name}: "${c.value_prop_hook}"`).join('; ')}`
              : '',
            serp.quick_differentiators.length
              ? `Differentiators: ${serp.quick_differentiators.slice(0, 3).join('; ')}`
              : '',
          ]
            .filter(Boolean)
            .join(' | ')
        : undefined;
      const { variants } = await generateCopyVariants({
        screenshotDataUrl: heroImg,
        url: session.url || undefined,
        pageTitle: session.seoMetadata.title || session.pageTitle,
        currentHeadline: session.seoMetadata.h1s[0],
        auditSummary: primary?.overall_summary,
        topIssues: (primary?.items || []).slice(0, 5).map((i) => i.seo_analysis),
        auditGoal: session.auditGoal,
        targetKeyword: session.targetKeyword,
        serpContext,
      });
      await updateSession(sessionId, (s) => ({ ...s, copyVariants: variants }));
      pushToast('success', 'Generated 3 strategic A/B hero copy variants.');
    } catch (err: any) {
      pushToast('error', err?.message || 'Failed to generate copy variants.');
    } finally {
      setIsGeneratingCopy(false);
    }
  };

  // Streaming CRO Strategist Chat
  // A ref, not state, so a second send in the same tick (Discuss, starter prompt) is refused too.
  const chatBusyRef = useRef(false);

  const handleSendChat = async (text: string) => {
    const current = sessionRef.current;
    if (!current) return;
    if (chatBusyRef.current) {
      pushToast('info', 'Wait for the strategist to finish the current answer.');
      return;
    }
    chatBusyRef.current = true;
    const sessionId = current.id;
    const userMsg: ChatMessage = {
      id: `msg-u-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };
    const assistantId = `msg-a-${Date.now()}`;
    const assistantPlaceholder: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
    };

    const priorMessages = current.chatHistory;
    patchOpenSession(sessionId, (s) => ({
      ...s,
      chatHistory: [...s.chatHistory, userMsg, assistantPlaceholder],
    }));
    setIsStreamingChat(true);

    let accumulated = '';
    try {
      const chatVpKey: ViewportKey = current.viewports.desktop ? 'desktop' : 'mobile';
      const chatVp = current.viewports[chatVpKey];
      const primaryShot = chatVp ? await firstScreenImage(chatVp, chatVpKey) : undefined;
      await streamStrategistChat({
        messages: [...priorMessages, userMsg].map((m) => ({
          role: m.role,
          content: m.content,
        })),
        screenshotDataUrl: primaryShot,
        auditContext: buildChatAuditContext(current),
        onChunk: (chunk) => {
          accumulated += chunk;
          patchOpenSession(sessionId, (s) => ({
            ...s,
            chatHistory: s.chatHistory.map((m) =>
              m.id === assistantId ? { ...m, content: accumulated } : m
            ),
          }));
        },
      });

      const finalAssistant: ChatMessage = { ...assistantPlaceholder, content: accumulated };
      // If the user switched audits mid-stream, the stored copy has no placeholder: append both.
      await updateSession(sessionId, (s) =>
        s.chatHistory.some((m) => m.id === assistantId)
          ? {
              ...s,
              chatHistory: s.chatHistory.map((m) => (m.id === assistantId ? finalAssistant : m)),
            }
          : { ...s, chatHistory: [...s.chatHistory, userMsg, finalAssistant] }
      );
    } catch (err: any) {
      pushToast('error', err?.message || 'Strategist chat failed.');
      patchOpenSession(sessionId, (s) => ({
        ...s,
        chatHistory: s.chatHistory.filter((m) => m.id !== assistantId),
      }));
    } finally {
      chatBusyRef.current = false;
      setIsStreamingChat(false);
    }
  };

  const handleDiscussFinding = (finding: AuditFinding) => {
    setActiveTab('chat');
    const prompt = `Let's fix "${finding.context}" (${finding.severity}, ${finding.category}). Current issue: ${finding.seo_analysis} Give me 2 concrete, high-converting rewrites or exact design/UX steps we can ship today.`;
    handleSendChat(prompt);
  };

  // Spoken Executive Audio Briefing (Gemini 3.8 TTS)
  const handleGenerateAudio = async (voice: 'Kore' | 'Charon') => {
    if (!session) return;
    const sessionId = session.id;
    const primary = session.viewports.desktop?.analysis || session.viewports.mobile?.analysis;
    if (!primary) return;

    setIsGeneratingAudio(true);
    try {
      const mobileOverall =
        session.viewports.desktop?.analysis && session.viewports.mobile?.analysis
          ? session.viewports.mobile.analysis.scores?.overall
          : undefined;
      const parityNote = session.comparison
        ? `Parity ${session.comparison.parity_score}/100: ${session.comparison.executive_verdict}`
        : undefined;
      const briefing = await generateAudioBriefing({
        domain: session.domain,
        pageTitle: session.pageTitle,
        scores: primary.scores,
        mobileScore: mobileOverall,
        parityNote,
        overallSummary: primary.overall_summary || '',
        topFindings: (primary.items || []).slice(0, 3).map((i) => `${i.context}: ${i.seo_analysis}`),
        quickWins: primary.quick_wins?.top_3 || [],
        voice,
      });
      await updateSession(sessionId, (s) => ({ ...s, audioBriefing: briefing }));
      pushToast('success', 'Executive audio briefing ready to play.');
    } catch (err: any) {
      pushToast('error', err?.message || 'Audio synthesis failed.');
    } finally {
      setIsGeneratingAudio(false);
    }
  };

  // Export Annotated PNG (optionally including active first-screen heatmap)
  const handleExportPng = async (includeHeatmap = false) => {
    if (!session) return;
    const vp = session.viewports[activeViewport] || session.viewports.desktop || session.viewports.mobile;
    if (!vp) return;
    try {
      const vpKey: ViewportKey = session.viewports[activeViewport]
        ? activeViewport
        : session.viewports.desktop
        ? 'desktop'
        : 'mobile';
      const { downloadAnnotatedPng } = await loadExports();
      const files = await downloadAnnotatedPng(
        vp.screenshotDataUrl,
        vp.analysis?.items || [],
        vp.overlays,
        session.domain,
        vpKey,
        pageViewOf(vp, vpKey),
        priorityRows(vp.analysis),
        { enabled: includeHeatmap, hotspots: vp.analysis?.attention_hotspots }
      );
      pushToast(
        'success',
        files > 1
          ? `Annotated PNG downloaded in ${files} parts (the page is too tall for one image).`
          : 'Annotated PNG downloaded.'
      );
    } catch {
      pushToast('error', 'Could not render annotated PNG.');
    }
  };

  return (
    <div className="h-screen w-full flex flex-col bg-[#F8FAFC] text-slate-900 overflow-hidden print:h-auto print:overflow-visible">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="no-print h-14 px-5 bg-white border-b border-slate-200 flex items-center justify-between gap-8 shrink-0 z-30">
        {/* Zone 1: Single-line Brand Wordmark */}
        <button
          type="button"
          onClick={() => {
            if (!isWorking) {
              showSession(null);
              setStage('idle');
              setFatalError(null);
            }
          }}
          className="text-base font-bold tracking-tight text-slate-900 hover:text-blue-600 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          On-page Vision Pro
        </button>

        {/* Zone 2: 5 Concise Single-Line Workspace Links */}
        <nav className="hidden md:flex items-center gap-6 h-full">
          {WORKSPACE_TABS.map((tab) => {
            const isDisabled = !session || isWorking;
            const isActive = Boolean(session && activeTab === tab.id && !isWorking);
            return (
              <button
                key={tab.id}
                type="button"
                disabled={isDisabled}
                onClick={() => setActiveTab(tab.id)}
                className={`h-full px-1 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                  isActive
                    ? 'border-blue-600 text-slate-900 font-semibold'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Single Primary Action */}
        <div className="shrink-0">
          <button
            type="button"
            disabled={isWorking}
            onClick={() => {
              showSession(null);
              setStage('idle');
              setFatalError(null);
            }}
            className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-semibold rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus size={14} />
            New Audit
          </button>
        </div>
      </header>

      {/* Mobile Tab Strip (only visible < md when a session is open) */}
      {session && !isWorking && (
        <div className="no-print md:hidden bg-white border-b border-slate-200 px-3 flex items-center gap-4 overflow-x-auto shrink-0">
          {WORKSPACE_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`py-2.5 text-xs font-semibold border-b-2 whitespace-nowrap shrink-0 ${
                activeTab === tab.id
                  ? 'border-blue-600 text-slate-900'
                  : 'border-transparent text-slate-500'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Main Tri-Pane Studio Body */}
      <div className="flex-1 flex min-h-0 overflow-hidden print:block print:overflow-visible">
        {(session || (isWorking && history.length > 0)) && (
          <HistoryRail
            history={history}
            activeId={session?.id || null}
            collapsed={railCollapsed}
            onToggleCollapse={() => setRailCollapsed((v) => !v)}
            onSelect={handleSelectHistory}
            onDelete={handleDeleteHistory}
            onReAudit={async (item) => {
              if (!item.url) return;
              const stored = await getAuditSession(item.id).catch(() => null);
              handleStartUrlAudit(item.url, {
                auditGoal: stored?.auditGoal || 'general',
                targetKeyword: stored?.targetKeyword || '',
                captureMode: stored?.viewports.desktop?.captureMode ?? stored?.viewports.mobile?.captureMode ?? 'fullpage',
              });
            }}
            onCleanIncomplete={handleCleanIncompleteHistory}
            onNewAudit={() => {
              showSession(null);
              setStage('idle');
              setFatalError(null);
            }}
          />
        )}

        <main className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden print:block print:overflow-visible">
          {stage === 'error' && fatalError ? (
            <div className="flex-1 flex items-center justify-center p-6 bg-[#F8FAFC]">
              <div className="max-w-md w-full bg-white border border-slate-200 rounded-xl p-6 text-center space-y-4">
                <div className="w-10 h-10 rounded-full bg-red-50 border border-red-200 mx-auto flex items-center justify-center text-red-600">
                  <AlertTriangle size={18} />
                </div>
                <div>
                  <h2 className="text-base font-bold text-slate-900 mb-1">Audit Could Not Complete</h2>
                  <p className="text-xs text-slate-600 leading-relaxed">{fatalError}</p>
                </div>
                {blockedCapture && (
                  <div className="text-left text-xs bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1">
                    <p className="font-semibold text-slate-800">The page HTML was still read and will be used:</p>
                    <p className="text-slate-600 truncate">
                      Title: {blockedCapture.metadata.title || 'none found'}
                    </p>
                    <p className="text-slate-600">
                      {blockedCapture.metadata.h1s.length} H1 · {blockedCapture.metadata.wordCount} words ·{' '}
                      {blockedCapture.metadata.missingAltImages}/{blockedCapture.metadata.totalImages} images without alt
                    </p>
                    {blockedCapture.warnings && blockedCapture.warnings.length > 0 && (
                      <ul className="pt-1 text-slate-500 list-disc pl-4 space-y-0.5">
                        {blockedCapture.warnings.map((w) => (
                          <li key={w}>{w}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {blockedCapture && (
                    <button
                      type="button"
                      onClick={() => {
                        setLaunchPreset({ mode: 'upload', uploadContext: blockedCapture.url });
                        setStage('idle');
                        setFatalError(null);
                      }}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg cursor-pointer"
                    >
                      Upload a Screenshot of This Page
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setLaunchPreset(null);
                      setStage('idle');
                      setFatalError(null);
                    }}
                    className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg cursor-pointer"
                  >
                    Return to Launch Studio
                  </button>
                </div>
              </div>
            </div>
          ) : isWorking ? (
            <Suspense fallback={<DelayedFallback label="Starting the audit" />}>
            <AuditProgressOverlay
              targetLabel={stageLabel}
              progress={liveProgress}
              desktopScreenshot={liveDesktopShot}
              mobileScreenshot={liveMobileShot}
              metadata={liveMetadata}
              desktopAudit={liveDesktopAudit?.analysis || null}
              mobileAudit={liveMobileAudit?.analysis || null}
              desktopData={draftSession?.viewports.desktop ?? null}
              pageProgress={pageProgress}
              mobileData={draftSession?.viewports.mobile ?? null}
              onEnterEarly={handleEnterEarly}
              onCancel={() => {
                cancelRun();
                setStage('idle');
                setDraftSession(null);
              }}
            />
            </Suspense>
          ) : !session ? (
            <LaunchStudio
              key={launchPreset ? `${launchPreset.mode}-${launchPreset.uploadContext}-${launchPreset.initialUrl || ''}` : 'default'}
              initialMode={launchPreset?.mode}
              initialUrl={launchPreset?.initialUrl}
              initialUploadContext={launchPreset?.uploadContext}
              history={history}
              onStartUrlAudit={handleStartUrlAudit}
              onStartUploadAudit={handleStartUploadAudit}
              onSelectHistory={handleSelectHistory}
            />
          ) : (
            <Suspense fallback={<DelayedFallback />}>
              {activeTab === 'canvas' && (
                <CanvasWorkspace
                  sessionId={session.id}
                  activeViewport={activeViewport}
                  onViewportChange={setActiveViewport}
                  desktopData={session.viewports.desktop}
                  mobileData={session.viewports.mobile}
                  domain={session.domain}
                  resolvedFindingIds={session.resolvedFindingIds || []}
                  codeFixes={session.codeFixes || {}}
                  generatingFixId={generatingFixId}
                  isDeepScanning={isDeepScanning}
                  isAuditingRegion={isAuditingRegion}
                  externalFocusFindingId={focusedFindingId}
                  onClearExternalFocus={() => setFocusedFindingId(null)}
                  onDeepScan={handleDeepScan}
                  onAuditManualRegion={handleAuditManualRegion}
                  onOpenRedesign={setRedesignTarget}
                  onDiscussFinding={handleDiscussFinding}
                  onUpdateOverlays={handleUpdateOverlays}
                  onToggleResolveFinding={handleToggleResolveFinding}
                  onGenerateFixCode={handleGenerateFixCode}
                  onCopyNotice={(msg) => pushToast('success', msg)}
                  onExportPng={handleExportPng}
                />
              )}

              {activeTab === 'compare' && (
                <CompareWorkspace
                  desktopData={session.viewports.desktop}
                  mobileData={session.viewports.mobile}
                  comparison={session.comparison}
                  isComparing={isComparing}
                  onRunComparison={handleRunComparison}
                  onUploadMissingViewport={handleUploadMissingViewport}
                  onInspectFinding={handleInspectFinding}
                />
              )}

              {activeTab === 'serp' && (() => {
                const yourVpKey: ViewportKey = session.viewports.desktop ? 'desktop' : 'mobile';
                const yourVp = session.viewports[yourVpKey];
                const yourView = yourVp ? pageViewOf(yourVp, yourVpKey) : null;
                const yourSpec = yourView
                  ? `${Math.round(yourView.size.width)}×${Math.round(yourView.foldPx)}`
                  : undefined;
                return (
                <SerpIntelWorkspace
                  domain={session.domain}
                  url={session.url}
                  yourScreenshot={yourVp?.screenshotDataUrl || null}
                  yourSpec={yourSpec}
                  research={session.serpResearch}
                  isLoading={isLoadingSerp}
                  capturingCompUrl={capturingCompUrl}
                  onRunResearch={handleRunSerpResearch}
                  onCaptureCompetitor={handleCaptureCompetitor}
                />
                );
              })()}

              {activeTab === 'chat' && (
                <StrategistChatWorkspace
                  domain={session.domain}
                  isFullPage={(session.viewports.desktop ?? session.viewports.mobile)?.captureMode === 'fullpage'}
                  copyVariants={session.copyVariants}
                  isGeneratingCopy={isGeneratingCopy}
                  onGenerateCopy={handleGenerateCopy}
                  onVisualizeVariant={handleVisualizeVariant}
                  chatHistory={session.chatHistory}
                  isStreamingChat={isStreamingChat}
                  onSendMessage={handleSendChat}
                />
              )}

              {activeTab === 'report' && (
                <ReportWorkspace
                  session={session}
                  previousScoreDelta={(() => {
                    const currentScore =
                      session.viewports.desktop?.analysis?.scores?.overall ??
                      session.viewports.mobile?.analysis?.scores?.overall ??
                      null;
                    if (currentScore === null) return null;
                    const idx = history.findIndex((h) => h.id === session.id);
                    const older = history
                      .slice(idx >= 0 ? idx + 1 : 0)
                      .find(
                        (h) =>
                          h.id !== session.id &&
                          h.domain === session.domain &&
                          (h.desktopScore ?? h.mobileScore) !== null
                      );
                    if (!older) return null;
                    const prev = older.desktopScore ?? older.mobileScore;
                    return prev !== null ? currentScore - prev : null;
                  })()}
                  isGeneratingAudio={isGeneratingAudio}
                  onGenerateAudio={handleGenerateAudio}
                  onReAudit={
                    session.sourceType === 'url' && session.url
                      ? () =>
                          handleStartUrlAudit(session.url, {
                            captureMode: session.viewports.desktop?.captureMode ?? session.viewports.mobile?.captureMode ?? 'viewport',
                            auditGoal: session.auditGoal || 'general',
                            targetKeyword: session.targetKeyword || '',
                          })
                      : undefined
                  }
                  onInspectFinding={handleInspectFinding}
                  onCopySummaryNotice={(msg) => pushToast('success', msg)}
                  onExportPng={handleExportPng}
                  onExportMarkdown={() => {
                    loadExports()
                      .then(({ downloadMarkdownReport }) => {
                        downloadMarkdownReport(session);
                        pushToast('success', 'Markdown report downloaded.');
                      })
                      .catch(() => pushToast('error', 'Could not load the exporter. Check the connection and try again.'));
                  }}
                  onExportJson={() => {
                    loadExports()
                      .then(({ downloadJsonReport }) => {
                        downloadJsonReport(session);
                        pushToast('success', 'JSON report downloaded.');
                      })
                      .catch(() => pushToast('error', 'Could not load the exporter. Check the connection and try again.'));
                  }}
                />
              )}
            </Suspense>
          )}
        </main>
      </div>

      {/* AI Redesign Studio Modal (Element & Full-Hero) */}
      {redesignTarget && (
      <Suspense fallback={<DelayedFallback label="Opening the Redesign Studio" overlay />}>
      <RedesignStudioModal
        target={redesignTarget}
        savedHeroRedesigns={session?.heroRedesigns || []}
        onClose={() => setRedesignTarget(null)}
        onApplyElementOverlay={handleApplyElementOverlay}
        onSaveHeroRedesign={handleSaveHeroRedesign}
        onDeleteHeroRedesign={handleDeleteHeroRedesign}
      />
      </Suspense>
      )}

      <AccessTokenCard />

      {/* Non-Blocking Toast Notifications */}
      <div
        role="status"
        aria-live="polite"
        className="no-print fixed bottom-5 right-5 z-50 flex flex-col gap-2 max-w-sm"
      >
      {toasts.length > 0 && (
        <div className="contents">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              onMouseEnter={() => pauseToast(toast.id)}
              onMouseLeave={() => scheduleToast(toast.id, 4000)}
              onFocus={() => pauseToast(toast.id)}
              onBlur={() => scheduleToast(toast.id, 4000)}
              className="bg-slate-900 text-white px-3.5 py-2.5 rounded-lg shadow-lg border border-slate-800 text-xs flex items-center gap-2.5"
            >
              {toast.type === 'success' ? (
                <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />
              ) : toast.type === 'error' ? (
                <AlertTriangle size={14} className="text-red-400 shrink-0" />
              ) : (
                <Info size={14} className="text-blue-400 shrink-0" />
              )}
              <span className="flex-1 leading-snug">{toast.message}</span>
              <button
                type="button"
                onClick={() => dismissToast(toast.id)}
                className="text-slate-400 hover:text-white cursor-pointer"
                aria-label="Dismiss notification"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      </div>
    </div>
  );
};

export default App;