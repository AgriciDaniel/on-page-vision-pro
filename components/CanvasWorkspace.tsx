import React, { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import {
  Monitor,
  Smartphone,
  ArrowRight,
  Eye,
  EyeOff,
  Pencil,
  PlusCircle,
  Wand2,
  Layers,
  AlertCircle,
  AlertTriangle,
  Info,
  Loader2,
  X,
  Download,
  Move,
  Flame,
  Glasses,
  Code2,
  ClipboardCopy,
  Check,
  CheckSquare,
  Square,
  TrendingUp,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  ChevronsUpDown,
  Maximize2,
} from 'lucide-react';
import type {
  AuditFinding,
  CanvasOverlay,
  CodeFixPatch,
  SeverityLevel,
  ViewportData,
  ViewportKey,
} from '../types';
import { cropImagePx } from '../lib/client/images';
import { describePosition, findingRect, heroRedesignRect, isTall, pageViewOf } from '../lib/client/pageView';
import { CanvasStage, type CanvasStageHandle, type RegionSelection, type ZoomMode } from './CanvasStage';
import { FixFirstBlock } from './FixFirstBlock';
import { priorityRows } from '../lib/client/priorities';
import { findingTwins, type Twin } from '../lib/client/twins';
import type { RedesignModalTarget } from './RedesignStudioModal';

type PillarFilter = 'all' | 'clarity' | 'visual' | 'conversion' | 'trust';

interface CanvasWorkspaceProps {
  /** Used to remember that "Fix these first" was already seen for this session and viewport. */
  sessionId?: string;
  activeViewport: ViewportKey;
  onViewportChange: (vp: ViewportKey) => void;
  desktopData: ViewportData | null;
  mobileData: ViewportData | null;
  domain: string;
  resolvedFindingIds: string[];
  codeFixes: Record<string, CodeFixPatch>;
  generatingFixId: string | null;
  isDeepScanning: boolean;
  isAuditingRegion: boolean;
  externalFocusFindingId?: string | null;
  onClearExternalFocus?: () => void;
  onDeepScan: (sectionIndex?: number) => void;
  onAuditManualRegion: (croppedDataUrl: string, box: [number, number, number, number]) => void;
  onOpenRedesign: (target: RedesignModalTarget) => void;
  onDiscussFinding: (finding: AuditFinding) => void;
  onUpdateOverlays: (viewport: ViewportKey, overlays: CanvasOverlay[]) => void;
  onToggleResolveFinding: (findingId: string) => void;
  onGenerateFixCode: (finding: AuditFinding) => void;
  onCopyNotice: (msg: string) => void;
  onExportPng: (includeHeatmap?: boolean) => void;
}

/** Extract a concise, plain-English 1-sentence takeaway for compact cards & canvas hover tooltips. */
function getPlainTakeaway(item: AuditFinding, maxLen = 132): string {
  const raw = (item.seo_analysis || item.suggested_optimization || '').replace(/\s+/g, ' ').trim();
  if (!raw) return 'Review this element for conversion and hierarchy impact.';
  const firstSentenceMatch = raw.match(/^.+?[.!?](?:\s|$)/);
  const first = firstSentenceMatch ? firstSentenceMatch[0].trim() : raw;
  if (first.length <= maxLen) return first;
  return `${first.slice(0, maxLen - 1).trimEnd()}…`;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

function isDialogOpen(): boolean {
  return Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'));
}

/** Match a finding's category to one of the 4 clickable Health Score pillars. */
function matchesPillar(item: AuditFinding, pillar: PillarFilter): boolean {
  if (pillar === 'all') return true;
  const cat = (item.category || '').toLowerCase();
  if (pillar === 'clarity') {
    return cat.includes('clarity') || cat.includes('seo') || cat.includes('copy') || cat.includes('content');
  }
  if (pillar === 'visual') {
    return (
      cat.includes('visual') ||
      cat.includes('hierarchy') ||
      cat.includes('access') ||
      cat.includes('nav') ||
      cat.includes('layout') ||
      cat.includes('contrast')
    );
  }
  if (pillar === 'conversion') {
    return cat.includes('conversion') || cat.includes('cro') || cat.includes('cta') || cat.includes('funnel');
  }
  if (pillar === 'trust') {
    return cat.includes('trust') || cat.includes('e-e-a-t') || cat.includes('eeat') || cat.includes('proof') || cat.includes('credib');
  }
  return true;
}

export const CanvasWorkspace: React.FC<CanvasWorkspaceProps> = ({
  sessionId,
  activeViewport,
  onViewportChange,
  desktopData,
  mobileData,
  domain,
  resolvedFindingIds,
  codeFixes,
  generatingFixId,
  isDeepScanning,
  isAuditingRegion,
  externalFocusFindingId,
  onClearExternalFocus,
  onDeepScan,
  onAuditManualRegion,
  onOpenRedesign,
  onDiscussFinding,
  onUpdateOverlays,
  onToggleResolveFinding,
  onGenerateFixCode,
  onCopyNotice,
  onExportPng,
}) => {
  const viewportData = activeViewport === 'desktop' ? desktopData : mobileData;
  const audit = viewportData?.analysis || null;
  const overlays = viewportData?.overlays || [];
  const view = useMemo(
    () => (viewportData ? pageViewOf(viewportData, activeViewport) : null),
    [viewportData, activeViewport]
  );

  const [showAnnotations, setShowAnnotations] = useState(true);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [showFoldLine, setShowFoldLine] = useState(false);
  const [lensFilter, setLensFilter] = useState<'none' | 'squint' | 'colorblind'>('none');
  const [severityFilter, setSeverityFilter] = useState<'all' | SeverityLevel>('all');
  const [pillarFilter, setPillarFilter] = useState<PillarFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoverSource, setHoverSource] = useState<'canvas' | 'list' | null>(null);
  const [expandAll, setExpandAll] = useState(false);
  const [showFirstImpression, setShowFirstImpression] = useState(false);
  const [expandedFixIds, setExpandedFixIds] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [isDrawMode, setIsDrawMode] = useState(false);
  const [pendingRegion, setPendingRegion] = useState<RegionSelection | null>(null);
  const [zoom, setZoom] = useState<ZoomMode>('fit-width');
  const [visibleSectionIdx, setVisibleSectionIdx] = useState<number | null>(null);
  const [scannedSections, setScannedSections] = useState<Record<string, boolean>>({});
  const [deepScanPickerOpen, setDeepScanPickerOpen] = useState(false);

  const hasHotspots = Boolean(audit?.attention_hotspots && audit.attention_hotspots.length > 0);
  useEffect(() => {
    setDeepScanPickerOpen(false);
    setVisibleSectionIdx(null);
  }, [activeViewport, sessionId]);

  const stageRef = useRef<CanvasStageHandle>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Switching viewport shows the other list from its first finding, not the old scroll offset.
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [activeViewport]);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Lower-impact findings the server left out over its cap (omitted_items). Hidden until asked for;
  // then listed after the shown ones, numbered on from them, and boxed on the canvas only while shown.
  const omittedItems = useMemo(() => audit?.omitted_items ?? [], [audit]);
  const omittedIds = useMemo(() => new Set(omittedItems.map((i) => i.id)), [omittedItems]);
  const [showOmitted, setShowOmitted] = useState(false);
  useEffect(() => {
    setShowOmitted(false);
  }, [activeViewport, sessionId]);
  const listedItems = useMemo(
    () => (showOmitted && omittedItems.length > 0 ? [...(audit?.items || []), ...omittedItems] : audit?.items || []),
    [audit, omittedItems, showOmitted]
  );

  // Master index map so badge numbers stay stable (#1..#N) even while filtering
  const indexMap = useMemo(() => {
    const map = new Map<string, number>();
    listedItems.forEach((it, idx) => map.set(it.id, idx + 1));
    return map;
  }, [listedItems]);

  const filteredItems = useMemo(() => {
    const list = listedItems;
    return list.filter((i) => {
      if (severityFilter !== 'all' && i.severity !== severityFilter) return false;
      if (!matchesPillar(i, pillarFilter)) return false;
      return true;
    });
  }, [listedItems, severityFilter, pillarFilter]);

  const scrollCardIntoView = useCallback((id: string) => {
    requestAnimationFrame(() => {
      const el = cardRefs.current[id];
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }, []);

  /** Select a finding and bring it into view on the canvas (F4) and, optionally, in the list. */
  const focusFinding = useCallback(
    (id: string | null, opts: { card?: boolean; canvas?: boolean } = {}) => {
      setSelectedId(id);
      if (!id) return;
      if (opts.card !== false) scrollCardIntoView(id);
      if (opts.canvas !== false) stageRef.current?.scrollToFinding(id);
    },
    [scrollCardIntoView]
  );

  // Same issue on the other device (lib/crossViewport.ts via twins.ts).
  const desktopAudit = desktopData?.analysis;
  const mobileAudit = mobileData?.analysis;
  const twins = useMemo(() => findingTwins(desktopAudit, mobileAudit), [desktopAudit, mobileAudit]);
  const twinNumber = useCallback(
    (twin: Twin) => {
      const other = twin.viewport === 'desktop' ? desktopAudit : mobileAudit;
      return (other?.items ?? []).findIndex((i) => i.id === twin.item.id) + 1;
    },
    [desktopAudit, mobileAudit]
  );
  // Jump to a twin: switch viewport first, then focus once that viewport's list and stage exist.
  const [pendingTwinId, setPendingTwinId] = useState<string | null>(null);
  const jumpToTwin = useCallback(
    (twin: Twin) => {
      setSeverityFilter('all');
      setPillarFilter('all');
      setSelectedId(null);
      setPendingTwinId(twin.item.id);
      onViewportChange(twin.viewport);
    },
    [onViewportChange]
  );
  useEffect(() => {
    if (!pendingTwinId || !audit?.items.some((i) => i.id === pendingTwinId)) return;
    const id = pendingTwinId;
    const t = window.setTimeout(() => {
      focusFinding(id);
      setPendingTwinId(null);
    }, 80);
    return () => window.clearTimeout(t);
  }, [pendingTwinId, audit, focusFinding]);

  // Handle jump-to-finding from Compare or Report tabs. Waits a moment so the cards and stage exist.
  // The request is cleared only after the jump: clearing it first re-ran this effect, whose
  // cleanup cancelled the pending jump, so a Report or Compare click selected nothing.
  useEffect(() => {
    if (!externalFocusFindingId) return;
    const id = externalFocusFindingId;
    setSeverityFilter('all');
    setPillarFilter('all');
    const t = window.setTimeout(() => {
      focusFinding(id);
      onClearExternalFocus?.();
    }, 60);
    return () => window.clearTimeout(t);
  }, [externalFocusFindingId, onClearExternalFocus, focusFinding]);

  // Guided walkthrough step helpers
  const selectedIndex = useMemo(
    () => (selectedId ? filteredItems.findIndex((i) => i.id === selectedId) : -1),
    [filteredItems, selectedId]
  );

  const stepFinding = useCallback(
    (direction: 1 | -1) => {
      if (filteredItems.length === 0) return;
      let nextIdx: number;
      if (selectedIndex === -1) {
        nextIdx = direction === 1 ? 0 : filteredItems.length - 1;
      } else {
        nextIdx = (selectedIndex + direction + filteredItems.length) % filteredItems.length;
      }
      const target = filteredItems[nextIdx];
      if (target) focusFinding(target.id);
    },
    [filteredItems, selectedIndex, focusFinding]
  );

  // Keyboard: J / K step through findings from anywhere on the page, Esc clears the selection.
  // Arrow keys are left to the browser (so the tall canvas scrolls) except inside the findings
  // list, see onFindingsListKeyDown. Nothing fires while typing or while a dialog is open.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey || isDialogOpen()) return;
      const key = e.key.toLowerCase();
      if ((key === 'j' || key === 'k') && filteredItems.length > 0) {
        e.preventDefault();
        stepFinding(key === 'j' ? 1 : -1);
      } else if (e.key === 'Escape' && selectedId) {
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [filteredItems.length, selectedId, stepFinding]);

  const onFindingsListKeyDown = (e: React.KeyboardEvent) => {
    if (isTypingTarget(e.target) || filteredItems.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      stepFinding(e.key === 'ArrowDown' ? 1 : -1);
    }
  };

  const fixFirstRows = useMemo(() => priorityRows(audit), [audit]);
  const blockerIds = useMemo(
    () => new Set(fixFirstRows.filter((r) => r.blocker).map((r) => r.item.id)),
    [fixFirstRows]
  );

  const resolvedSet = useMemo(() => new Set(resolvedFindingIds), [resolvedFindingIds]);

  const projectedUplift = useMemo(() => {
    if (!audit) return 0;
    let delta = 0;
    for (const item of audit.items || []) {
      if (!resolvedSet.has(item.id)) continue;
      const base = item.severity === 'critical' ? 4.8 : item.severity === 'warning' ? 2.6 : 1.1;
      delta += base * (0.55 + (item.impact_score || 60) / 160);
    }
    const current = audit.scores?.overall ?? 0;
    return Math.min(99 - current, Math.round(delta));
  }, [audit, resolvedSet]);

  const copyTextWithFeedback = (key: string, text: string, notice: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedId(key);
    onCopyNotice(notice);
    setTimeout(() => setCopiedId((prev) => (prev === key ? null : prev)), 1800);
  };

  const buildTicketMarkdown = (item: AuditFinding): string => {
    const cached = codeFixes[item.id];
    if (cached?.ticket_markdown) return cached.ticket_markdown;
    return [
      `## [${item.severity.toUpperCase()}] ${item.context} (${item.viewport})`,
      `**Domain:** ${domain} | **Category:** ${item.category} | **Impact:** ${item.impact_score}/100 | **Effort:** ${item.effort_estimate}`,
      '',
      '### Problem',
      item.seo_analysis,
      item.technical_details ? `\n**Technical details:** ${item.technical_details}` : '',
      '',
      '### Recommended Fix',
      item.suggested_optimization,
    ]
      .filter(Boolean)
      .join('\n');
  };

  const severityMeta = (sev: SeverityLevel) => {
    if (sev === 'critical') {
      return {
        label: 'Critical',
        border: 'border-red-600',
        bg: 'bg-red-600',
        tint: 'bg-red-600/10',
        text: 'text-red-700',
        icon: <AlertCircle size={13} className="text-red-600 shrink-0" />,
      };
    }
    if (sev === 'warning') {
      return {
        label: 'Warning',
        border: 'border-amber-600',
        bg: 'bg-amber-600',
        tint: 'bg-amber-600/10',
        text: 'text-amber-700',
        icon: <AlertTriangle size={13} className="text-amber-600 shrink-0" />,
      };
    }
    return {
      label: 'Info',
      border: 'border-blue-600',
      bg: 'bg-blue-600',
      tint: 'bg-blue-600/10',
      text: 'text-blue-700',
      icon: <Info size={13} className="text-blue-600 shrink-0" />,
    };
  };

  const handleOpenElementRedesign = async (item: AuditFinding) => {
    if (!viewportData?.screenshotDataUrl || !view) return;
    const rect = findingRect(item, view);
    if (!rect) return;
    try {
      const cropped = await cropImagePx(viewportData.screenshotDataUrl, rect);
      const { width: W, height: H } = view.size;
      onOpenRedesign({
        mode: 'element',
        imageDataUrl: cropped,
        context: item.context,
        suggestion: item.suggested_optimization,
        viewport: activeViewport,
        boxPct: {
          x: (rect.x / W) * 100,
          y: (rect.y / H) * 100,
          w: (rect.width / W) * 100,
          h: (rect.height / H) * 100,
        },
      });
    } catch {
      onCopyNotice('Could not crop this element from the screenshot.');
    }
  };

  const handleOpenFullHeroRedesign = async () => {
    if (!viewportData?.screenshotDataUrl || !view) return;
    const topIssues = (audit?.items || [])
      .filter((i) => i.severity !== 'info')
      .filter((i) => {
        const r = view.mode === 'fullpage' ? findingRect(i, view) : null;
        return !r || r.y < view.foldPx;
      })
      .slice(0, 5)
      .map((i) => `${i.context}: ${i.suggested_optimization}`);
    // Crop to match Nano Banana 2.1's output ratio (16:9 desktop, 9:16 mobile) so wipe slider aligns 1:1.
    const crop = heroRedesignRect(view, activeViewport);
    const needsCrop = crop.height < view.size.height - 1;
    const imageDataUrl = needsCrop
      ? await cropImagePx(viewportData.screenshotDataUrl, crop)
      : viewportData.screenshotDataUrl;
    onOpenRedesign({
      mode: 'full-hero',
      imageDataUrl,
      context: `${domain}: first screen (hero)`,
      viewport: activeViewport,
      topIssues,
      ...(needsCrop
        ? { boxPct: { x: 0, y: 0, w: 100, h: (crop.height / view.size.height) * 100 } }
        : {}),
    });
  };

  if (!viewportData) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-[#F8FAFC] p-8 text-center">
        <p className="text-sm font-semibold text-slate-900 mb-1">
          No {activeViewport} viewport captured for this session
        </p>
        <p className="text-xs text-slate-500 mb-4">
          Switch to the available viewport to inspect findings.
        </p>
        <button
          type="button"
          onClick={() => onViewportChange(activeViewport === 'desktop' ? 'mobile' : 'desktop')}
          className="px-4 py-2 bg-blue-600 text-white text-xs font-semibold rounded-lg cursor-pointer"
        >
          Switch to {activeViewport === 'desktop' ? 'Mobile' : 'Desktop'}
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden bg-[#F8FAFC]">
      {/* Center Visual Canvas Column */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Studio Canvas Toolbar, Responsive & Non-Clipping */}
        <div className="no-print min-h-12 px-3 py-1.5 bg-white border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Viewport Switcher */}
            <div className="inline-flex items-center p-0.5 bg-slate-100 border border-slate-200 rounded-md">
              <button
                type="button"
                disabled={!desktopData}
                onClick={() => {
                  onViewportChange('desktop');
                  setSelectedId(null);
                }}
                className={`px-2 py-1 text-xs font-medium rounded flex items-center gap-1 transition-colors whitespace-nowrap cursor-pointer disabled:opacity-40 ${
                  activeViewport === 'desktop'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Monitor size={13} />
                Desktop
              </button>
              <button
                type="button"
                disabled={!mobileData}
                onClick={() => {
                  onViewportChange('mobile');
                  setSelectedId(null);
                }}
                className={`px-2 py-1 text-xs font-medium rounded flex items-center gap-1 transition-colors whitespace-nowrap cursor-pointer disabled:opacity-40 ${
                  activeViewport === 'mobile'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Smartphone size={13} />
                Mobile
              </button>
            </div>

            {/* Visual Lenses & Overlays */}
            <div className="inline-flex items-center p-0.5 bg-slate-100 border border-slate-200 rounded-md">
              <button
                type="button"
                aria-pressed={showAnnotations}
                onClick={() => setShowAnnotations((v) => !v)}
                className={`px-2 py-1 text-xs font-medium rounded flex items-center gap-1 transition-colors whitespace-nowrap cursor-pointer ${
                  showAnnotations
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
                title="Toggle finding bounding boxes"
              >
                {showAnnotations ? <Eye size={12} /> : <EyeOff size={12} />}
                Boxes
              </button>
              <button
                type="button"
                aria-pressed={showHeatmap && hasHotspots}
                disabled={!hasHotspots}
                onClick={() => {
                  const next = !showHeatmap;
                  setShowHeatmap(next);
                  if (next && view?.showFold) stageRef.current?.scrollToTop();
                }}
                className={`px-2 py-1 text-xs font-medium rounded flex items-center gap-1 transition-colors whitespace-nowrap cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                  showHeatmap && hasHotspots
                    ? 'bg-orange-600 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
                title={
                  !hasHotspots
                    ? 'No AI attention hotspots were returned for this audit'
                    : view?.mode === 'fullpage'
                    ? 'AI 3s visual attention estimate on the first screen (scrolls to top)'
                    : 'AI 3s visual attention estimate (simulated salience, not comprehension)'
                }
              >
                <Flame size={12} />
                Heatmap
              </button>
              <button
                type="button"
                aria-pressed={lensFilter === 'squint'}
                onClick={() => setLensFilter((v) => (v === 'squint' ? 'none' : 'squint'))}
                className={`px-2 py-1 text-xs font-medium rounded flex items-center gap-1 transition-colors whitespace-nowrap cursor-pointer ${
                  lensFilter === 'squint'
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
                title="Grayscale + blur squint test for visual hierarchy & CTA contrast"
              >
                <Glasses size={12} />
                Squint
              </button>
              <button
                type="button"
                aria-pressed={lensFilter === 'colorblind'}
                onClick={() => setLensFilter((v) => (v === 'colorblind' ? 'none' : 'colorblind'))}
                className={`px-2 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                  lensFilter === 'colorblind'
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
                title="Deuteranopia color-vision simulation"
              >
                CVD
              </button>
              {view?.showFold && (
              <button
                type="button"
                aria-pressed={showFoldLine}
                onClick={() => setShowFoldLine((v) => !v)}
                className={`px-2 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                  showFoldLine
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
                title="Show where the first screen ends"
              >
                Fold
              </button>
              )}
            </div>

            {/* Zoom: native scrolling, no pan engine */}
            <div
              role="radiogroup"
              aria-label="Zoom"
              className="inline-flex items-center p-0.5 bg-slate-100 border border-slate-200 rounded-md"
            >
              {(
                [
                  { id: 'fit-width', label: 'Fit width', title: 'Fit the page width to the canvas' },
                  ...(view && isTall(view)
                    ? [{ id: 'fit-height', label: 'Whole page', title: 'Show the whole page height at once' }]
                    : []),
                  { id: 'actual', label: '100%', title: 'One screenshot pixel per screen pixel' },
                ] as { id: ZoomMode; label: string; title: string }[]
              ).map((z) => (
                <button
                  key={z.id}
                  type="button"
                  role="radio"
                  aria-checked={zoom === z.id}
                  onClick={() => setZoom(z.id)}
                  title={z.title}
                  className={`px-2 py-1 text-xs font-medium rounded flex items-center gap-1 transition-colors whitespace-nowrap cursor-pointer ${
                    zoom === z.id ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {z.id === 'fit-height' && <Maximize2 size={11} />}
                  {z.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setIsDrawMode((v) => !v);
                setPendingRegion(null);
              }}
              className={`px-2.5 py-1.5 rounded-md text-xs font-medium border flex items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer ${
                isDrawMode
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
              }`}
              title="Draw a custom box on the screenshot to audit or redesign"
            >
              <Pencil size={12} />
              {isDrawMode ? 'Cancel' : 'Select Area'}
            </button>

            {(() => {
              const sections = view?.sections ?? [];
              const multiSection = sections.length > 1;
              const activeSecIdx =
                visibleSectionIdx ??
                (selectedId ? audit?.items.find((i) => i.id === selectedId)?.section_index ?? 0 : 0);
              const activeSec = sections.find((s) => s.index === activeSecIdx) ?? sections[0];
              const triggerDeepScan = (idx?: number) => {
                setDeepScanPickerOpen(false);
                if (typeof idx === 'number') {
                  setScannedSections((prev) => ({ ...prev, [`${activeViewport}:${idx}`]: true }));
                }
                onDeepScan(idx);
              };
              return (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => {
                      if (!multiSection) {
                        triggerDeepScan(undefined);
                      } else if (zoom === 'fit-height') {
                        setDeepScanPickerOpen((v) => !v);
                      } else {
                        triggerDeepScan(activeSec?.index ?? 0);
                      }
                    }}
                    disabled={isDeepScanning}
                    className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-white text-slate-700 border border-slate-200 hover:border-slate-300 flex items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
                    title={
                      multiSection
                        ? zoom === 'fit-height'
                          ? 'Choose which page section to Deep Scan at full resolution'
                          : `Deep Scan section "${activeSec?.label || 'Section 1'}" at full resolution (1 call)`
                        : 'Scan for additional overlooked elements'
                    }
                  >
                    {isDeepScanning ? (
                      <Loader2 size={12} className="animate-spin text-blue-600" />
                    ) : (
                      <PlusCircle size={12} />
                    )}
                    {multiSection && zoom !== 'fit-height' && activeSec?.label
                      ? `Deep Scan: ${activeSec.label.slice(0, 14)}`
                      : 'Deep Scan'}
                  </button>
                  {deepScanPickerOpen && multiSection && (
                    <div className="absolute right-0 mt-1.5 w-52 bg-white border border-slate-200 rounded-lg shadow-lg z-40 py-1">
                      <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                        Pick section to scan (1 call)
                      </p>
                      <div className="max-h-60 overflow-y-auto">
                        {sections.map((sec) => {
                          const done = Boolean(scannedSections[`${activeViewport}:${sec.index}`]);
                          return (
                            <button
                              key={sec.index}
                              type="button"
                              onClick={() => triggerDeepScan(sec.index)}
                              className="w-full px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-blue-50 hover:text-blue-700 flex items-center justify-between gap-2 cursor-pointer"
                            >
                              <span className="truncate">
                                {sec.index + 1}. {sec.label || `Section ${sec.index + 1}`}
                              </span>
                              {done && <Check size={11} className="text-emerald-600 shrink-0" />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            <button
              type="button"
              onClick={handleOpenFullHeroRedesign}
              className="px-2.5 py-1.5 rounded-md text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-white flex items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer"
              title={
                view?.showFold
                  ? 'Generate a 2K AI redesign of the first screen'
                  : 'Generate a complete 2K AI hero redesign'
              }
            >
              <Layers size={12} />
              Hero Redesign
            </button>

            <button
              type="button"
              onClick={() => onExportPng(showHeatmap && hasHotspots)}
              className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-white text-slate-700 border border-slate-200 hover:border-slate-300 flex items-center gap-1 transition-colors whitespace-nowrap cursor-pointer"
              title={showHeatmap && hasHotspots ? 'Download annotated PNG (includes active heatmap)' : 'Download annotated PNG'}
            >
              <Download size={12} />
              PNG
            </button>
          </div>
        </div>

        {/* Manual Region Prompt Strip */}
        {isDrawMode && (
          <div className="px-4 py-2 bg-blue-50 border-b border-blue-200 text-xs text-blue-900 flex items-center justify-between">
            <span>Drag across any area of the screenshot to run a focused audit or redesign it.</span>
            <button
              type="button"
              onClick={() => setIsDrawMode(false)}
              className="font-semibold underline cursor-pointer"
            >
              Cancel
            </button>
          </div>
        )}

        {pendingRegion && (
          <div className="px-4 py-2.5 bg-white border-b border-blue-200 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <img
                src={pendingRegion.croppedDataUrl}
                alt="Selected region"
                className="h-9 w-16 object-contain rounded border border-slate-200 bg-slate-50"
              />
              <span className="text-xs font-semibold text-slate-800">
                Custom region selected. Choose an action:
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={isAuditingRegion}
                onClick={() => {
                  onAuditManualRegion(pendingRegion.croppedDataUrl, pendingRegion.box2d);
                  setPendingRegion(null);
                }}
                className="px-3 py-1.5 bg-white border border-slate-300 hover:border-blue-500 text-slate-800 text-xs font-semibold rounded-md flex items-center gap-1.5 cursor-pointer"
              >
                {isAuditingRegion ? <Loader2 size={13} className="animate-spin" /> : <PlusCircle size={13} />}
                Audit This Region
              </button>
              <button
                type="button"
                onClick={() => {
                  onOpenRedesign({
                    mode: 'element',
                    imageDataUrl: pendingRegion.croppedDataUrl,
                    context: 'Custom Selected Region',
                    viewport: activeViewport,
                    boxPct: pendingRegion.boxPct,
                  });
                  setPendingRegion(null);
                }}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-md flex items-center gap-1.5 cursor-pointer"
              >
                <Wand2 size={13} />
                Redesign Region
              </button>
              <button
                type="button"
                onClick={() => setPendingRegion(null)}
                className="p-1.5 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        )}

        {/* Active Lens Indicator Strip */}
        {((showHeatmap && hasHotspots) || lensFilter !== 'none') && (
          <div className="no-print px-4 py-1.5 bg-slate-900 text-slate-100 text-[11px] flex flex-wrap items-center justify-between gap-2">
            <span>
              {showHeatmap && hasHotspots &&
                'AI 3s Attention Estimate (first screen, simulated visual salience, not comprehension). '}
              {lensFilter === 'squint' && 'Squint Test active: grayscale blur isolates hierarchy & CTA prominence. '}
              {lensFilter === 'colorblind' && 'Color-Vision Deficiency (Deuteranopia) simulation active.'}
            </span>
            <div className="flex items-center gap-3">
              {showHeatmap && hasHotspots && view?.showFold && (
                <button
                  type="button"
                  onClick={() => stageRef.current?.scrollToTop()}
                  className="text-amber-300 hover:text-white font-semibold cursor-pointer"
                >
                  Jump to first screen
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setShowHeatmap(false);
                  setLensFilter('none');
                }}
                className="text-blue-300 hover:text-white font-semibold cursor-pointer"
              >
                Reset Lenses
              </button>
            </div>
          </div>
        )}

        {view && (
          <CanvasStage
            // A new viewport starts at its top: remounting the stage resets its scroll (G4).
            key={activeViewport}
            ref={stageRef}
            viewport={activeViewport}
            domain={domain}
            screenshotDataUrl={viewportData.screenshotDataUrl}
            view={view}
            items={filteredItems}
            allItems={listedItems}
            hotspots={audit?.attention_hotspots}
            indexMap={indexMap}
            overlays={overlays}
            selectedId={selectedId}
            hoveredId={hoveredId}
            hoverFromCanvas={hoverSource === 'canvas'}
            showAnnotations={showAnnotations}
            showHeatmap={showHeatmap && hasHotspots}
            showFoldLine={showFoldLine}
            lensFilter={lensFilter}
            isDrawMode={isDrawMode}
            zoom={zoom}
            onSelect={(id) => focusFinding(id, { canvas: false })}
            onHover={(id) => {
              setHoveredId(id);
              setHoverSource(id ? 'canvas' : null);
            }}
            onRegionSelected={setPendingRegion}
            onDrawFinished={() => setIsDrawMode(false)}
            onUpdateOverlays={(next) => onUpdateOverlays(activeViewport, next)}
            blockerIds={blockerIds}
            onVisibleSectionChange={setVisibleSectionIdx}
          />
        )}
      </div>

      {/* Right High-Contrast Inspector Panel (372px) */}
      <aside className="no-print w-full lg:w-[372px] shrink-0 bg-white border-t lg:border-t-0 lg:border-l border-slate-200 flex flex-col max-h-[48vh] lg:max-h-none">
        {/* Compact Score Summary + Clickable Pillar Filters */}
        {audit && (
          <div className="px-4 py-3 border-b border-slate-200 shrink-0">
            <div className="flex items-baseline justify-between mb-2.5">
              <div>
                <p className="text-[11px] text-slate-500 font-medium">
                  {activeViewport === 'desktop' ? 'Desktop' : 'Mobile'} Health Score
                </p>
                <div className="flex items-baseline gap-2">
                  <p className="text-2xl font-bold font-mono tabular-nums text-slate-900">
                    {audit.scores?.overall ?? 0}
                    <span className="text-xs font-normal text-slate-400 ml-0.5">/100</span>
                  </p>
                  {projectedUplift > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-xs font-mono font-bold tabular-nums text-emerald-700">
                      <TrendingUp size={12} />
                      {(audit.scores?.overall ?? 0) + projectedUplift} (+{projectedUplift})
                    </span>
                  )}
                </div>
              </div>
              <div className="text-right text-[11px] text-slate-500 font-mono tabular-nums">
                <span className="text-red-700 font-semibold">{audit.critical_count ?? 0} critical</span>
                <span className="mx-1 text-slate-300">·</span>
                <span className="text-amber-700 font-semibold">{audit.warning_count ?? 0} warn</span>
                {resolvedFindingIds.length > 0 && (
                  <p className="text-[11px] text-emerald-700 font-semibold mt-0.5">
                    {resolvedFindingIds.length} fixed
                  </p>
                )}
              </div>
            </div>

            {/* Interactive Clickable Pillar Filters */}
            <div className="grid grid-cols-4 gap-1.5 pt-2.5 border-t border-slate-100">
              {(
                [
                  { id: 'clarity', label: 'Clarity', value: audit.scores?.clarity ?? 0 },
                  { id: 'visual', label: 'Visual', value: audit.scores?.visual_hierarchy ?? 0 },
                  { id: 'conversion', label: 'CRO', value: audit.scores?.conversion ?? 0 },
                  { id: 'trust', label: 'Trust', value: audit.scores?.trust_eeat ?? 0 },
                ] as const
              ).map((m) => {
                const active = pillarFilter === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setPillarFilter((prev) => (prev === m.id ? 'all' : m.id))}
                    className={`py-1.5 px-1 rounded-md text-center transition-colors cursor-pointer border ${
                      active
                        ? 'bg-blue-50 border-blue-300 text-blue-900'
                        : 'bg-slate-50/70 border-transparent hover:bg-slate-100 text-slate-900'
                    }`}
                    title={`Filter findings by ${m.label}`}
                  >
                    <p className={`text-[10px] font-medium ${active ? 'text-blue-700' : 'text-slate-500'}`}>
                      {m.label}
                    </p>
                    <p className="text-sm font-bold font-mono tabular-nums">{m.value}</p>
                  </button>
                );
              })}
            </div>

            {/* Collapsible 1-Line 5-Second First Impression Strip */}
            {audit.first_impression_test && (
              <div className="mt-2.5 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowFirstImpression((v) => !v)}
                  className="w-full flex items-center justify-between gap-2 text-left text-[11px] cursor-pointer group"
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="font-semibold text-slate-700">
                      5-Second Test{view?.mode === 'fullpage' ? ' (first screen)' : ''}
                    </span>
                    <span className="text-slate-300" aria-hidden="true">·</span>
                    <span
                      className={`font-semibold ${
                        audit.first_impression_test.passes_5s_test
                          ? 'text-emerald-700'
                          : 'text-amber-700'
                      }`}
                    >
                      {audit.first_impression_test.passes_5s_test ? 'Passes' : 'Needs Clarity'}
                    </span>
                  </span>
                  <span className="text-slate-400 group-hover:text-slate-700 flex items-center gap-0.5 shrink-0">
                    <span>{showFirstImpression ? 'Hide' : '#1 Lift'}</span>
                    {showFirstImpression ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </span>
                </button>
                {showFirstImpression && (
                  <div className="mt-2 space-y-1.5 text-[11px] bg-slate-50 border border-slate-200/80 rounded-md p-2.5">
                    <p className="text-slate-600 leading-relaxed">
                      <span className="font-semibold text-slate-800">Takeaway: </span>
                      {audit.first_impression_test.visitor_understands}
                    </p>
                    {audit.first_impression_test.primary_distraction && (
                      <p className="text-slate-600 leading-relaxed">
                        <span className="font-semibold text-amber-800">Distraction: </span>
                        {audit.first_impression_test.primary_distraction}
                      </p>
                    )}
                    {audit.first_impression_test.single_biggest_lift && (
                      <p className="text-slate-800 leading-relaxed">
                        <span className="font-semibold text-blue-700">#1 Lift: </span>
                        {audit.first_impression_test.single_biggest_lift}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Fix these first: the page-level ranking from a full-page audit (nothing when absent) */}
        <FixFirstBlock
          compact
          seenKey={sessionId ? `${sessionId}:${activeViewport}` : undefined}
          rows={fixFirstRows}
          labelOf={(it) => `#${indexMap.get(it.id) ?? ''}`}
          onJump={(it) => {
            // Clear filters first so the finding's card exists, then select and scroll both panes.
            setSeverityFilter('all');
            setPillarFilter('all');
            window.setTimeout(() => focusFinding(it.id), 60);
          }}
        />

        {/* Filter Bar + Guided Walkthrough Stepper + Compact/Expand Toggle */}
        <div className="px-3.5 py-2 border-b border-slate-200 space-y-2 shrink-0 bg-slate-50/80">
          <div className="inline-flex items-center gap-0.5 p-0.5 bg-slate-100 border border-slate-200 rounded-md w-full">
            {(['all', 'critical', 'warning', 'info'] as const).map((sev) => (
              <button
                key={sev}
                type="button"
                aria-pressed={severityFilter === sev}
                onClick={() => setSeverityFilter(sev)}
                className={`flex-1 py-1 text-[11px] font-semibold rounded transition-colors capitalize cursor-pointer whitespace-nowrap ${
                  severityFilter === sev
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {sev}
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between gap-2 text-[11px]">
            {/* Walkthrough Stepper */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={filteredItems.length === 0}
                onClick={() => stepFinding(-1)}
                className="p-1 rounded border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 disabled:opacity-40 cursor-pointer"
                title="Previous finding (K)"
                aria-label="Previous finding"
              >
                <ChevronLeft size={12} />
              </button>
              <span className="font-mono tabular-nums text-slate-600 px-1">
                {selectedIndex >= 0
                  ? `${selectedIndex + 1} / ${filteredItems.length}`
                  : `${filteredItems.length} items`}
              </span>
              <button
                type="button"
                disabled={filteredItems.length === 0}
                onClick={() => stepFinding(1)}
                className="p-1 rounded border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 disabled:opacity-40 cursor-pointer"
                title="Next finding (J)"
                aria-label="Next finding"
              >
                <ChevronRight size={12} />
              </button>
              {pillarFilter !== 'all' && (
                <button
                  type="button"
                  onClick={() => setPillarFilter('all')}
                  className="ml-1 text-blue-600 hover:text-blue-800 font-semibold cursor-pointer"
                >
                  Clear {pillarFilter}
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={() => setExpandAll((v) => !v)}
              className="text-slate-500 hover:text-slate-900 font-medium inline-flex items-center gap-1 cursor-pointer"
              title={expandAll ? 'Switch to compact scannable rows' : 'Expand all findings'}
            >
              <ChevronsUpDown size={12} />
              {expandAll ? 'Compact' : 'Expand all'}
            </button>
          </div>
        </div>

        {/* Synchronized Scannable Accordion Findings List */}
        <div
          ref={listRef}
          className="flex-1 min-h-0 overflow-y-auto divide-y divide-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          tabIndex={0}
          onKeyDown={onFindingsListKeyDown}
          aria-label="Findings list. Use the up and down arrow keys, or J and K anywhere, to step through findings."
        >
          {filteredItems.length === 0 ? (
            <div className="p-8 text-center space-y-2">
              <p className="text-xs font-semibold text-slate-800">No findings match this filter</p>
              <p className="text-xs text-slate-500">
                Reset your filters or run Deep Scan to inspect additional elements.
              </p>
              {(severityFilter !== 'all' || pillarFilter !== 'all') && (
                <button
                  type="button"
                  onClick={() => {
                    setSeverityFilter('all');
                    setPillarFilter('all');
                  }}
                  className="mt-1 px-3 py-1.5 bg-slate-900 text-white text-xs font-semibold rounded-md cursor-pointer"
                >
                  Show All Findings
                </button>
              )}
            </div>
          ) : (
            filteredItems.map((item, listIdx) => {
              const meta = severityMeta(item.severity);
              const isOmitted = omittedIds.has(item.id);
              const firstOmitted = isOmitted && (listIdx === 0 || !omittedIds.has(filteredItems[listIdx - 1].id));
              const badgeNum = indexMap.get(item.id) || 1;
              const isSelected = selectedId === item.id;
              const isExpanded = expandAll || isSelected;
              const isHovered = hoveredId === item.id;
              const isResolved = resolvedSet.has(item.id);
              const canRedesign = Boolean(view && findingRect(item, view));
              const patch = codeFixes[item.id];
              const isFixLoading = generatingFixId === item.id;
              const isFixOpen = Boolean(expandedFixIds[item.id] && patch);

              const specParts = item.technical_details
                ? item.technical_details
                    .split(/[;•|]/)
                    .map((s) => s.trim())
                    .filter(Boolean)
                : [];

              return (
                <React.Fragment key={item.id}>
                {firstOmitted && (
                  <div className="px-3.5 py-2 bg-slate-50 text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
                    Lower impact: left out of the main list
                  </div>
                )}
                <div
                  ref={(el) => {
                    cardRefs.current[item.id] = el;
                  }}
                  onClick={() => focusFinding(isSelected ? null : item.id, { card: false })}
                  tabIndex={0}
                  aria-expanded={isSelected}
                  aria-label={`Finding ${indexMap.get(item.id) || ''}: ${item.context}`}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      focusFinding(isSelected ? null : item.id, { card: false });
                    }
                  }}
                  onMouseEnter={() => {
                    setHoveredId(item.id);
                    setHoverSource('list');
                  }}
                  onMouseLeave={() => {
                    setHoveredId((prev) => (prev === item.id ? null : prev));
                    setHoverSource((prev) => (prev === 'list' ? null : prev));
                  }}
                  className={`px-3.5 py-3 transition-colors cursor-pointer ${
                    isResolved
                      ? 'bg-emerald-50/40'
                      : isSelected
                      ? 'bg-blue-50/60'
                      : isHovered
                      ? 'bg-slate-50'
                      : 'bg-white'
                  }`}
                >
                  {/* Compact Scannable Header Row */}
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleResolveFinding(item.id);
                      }}
                      className="mt-0.5 text-slate-400 hover:text-emerald-600 transition-colors cursor-pointer shrink-0"
                      title={isResolved ? 'Mark unresolved' : 'Mark planned / fixed to preview score uplift'}
                      aria-label={isResolved ? 'Mark unresolved' : 'Mark fixed'}
                    >
                      {isResolved ? (
                        <CheckSquare size={14} className="text-emerald-600" />
                      ) : (
                        <Square size={14} />
                      )}
                    </button>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1.5">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className={`px-1 h-4 rounded text-[10px] font-mono font-bold text-white inline-flex items-center justify-center shrink-0 ${meta.bg}`}
                          >
                            {badgeNum}
                          </span>
                          <h4
                            className={`text-xs font-semibold truncate ${
                              isResolved ? 'line-through text-slate-400' : 'text-slate-900'
                            }`}
                          >
                            {item.context}
                          </h4>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className="text-[11px] font-mono tabular-nums text-slate-500">
                            {item.impact_score}
                          </span>
                          {isExpanded ? (
                            <ChevronUp size={13} className="text-slate-400" />
                          ) : (
                            <ChevronDown size={13} className="text-slate-400" />
                          )}
                        </div>
                      </div>

                      {/* Quiet 1-line metadata */}
                      <div className="flex items-center gap-1.5 text-[11px] text-slate-500 mt-0.5">
                        <span className={`font-medium ${meta.text}`}>{meta.label}</span>
                        <span aria-hidden="true">·</span>
                        <span className="truncate">
                          {item.element_type === 'abstract'
                            ? `Page-wide · ${item.category}`
                            : item.category}
                        </span>
                        {item.effort_estimate === 'quick-win' && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-emerald-700 font-medium shrink-0">Quick win</span>
                          </>
                        )}
                        {isOmitted && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="shrink-0 px-1 rounded bg-slate-100 text-slate-600 font-medium">Lower impact</span>
                          </>
                        )}
                        {twins.has(item.id) && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="shrink-0 inline-flex items-center gap-0.5 text-violet-700 font-medium">
                              {twins.get(item.id)!.viewport === 'mobile' ? (
                                <Smartphone size={11} aria-hidden="true" />
                              ) : (
                                <Monitor size={11} aria-hidden="true" />
                              )}
                              Also on {twins.get(item.id)!.viewport}
                            </span>
                          </>
                        )}
                      </div>

                      {/* Compact Plain-English Takeaway (when collapsed) */}
                      {!isExpanded && (
                        <p className="text-xs text-slate-600 leading-snug mt-1.5 line-clamp-2">
                          {getPlainTakeaway(item, 140)}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Expanded Focused Fix Drawer */}
                  {isExpanded && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="mt-3 pl-6 space-y-2.5 cursor-default"
                    >
                      {/* First in the drawer, right under the "Also on ..." chip, so it is never below the fold. */}
                      {twins.has(item.id) && (() => {
                        const twin = twins.get(item.id)!;
                        const n = twinNumber(twin);
                        return (
                          <button
                            type="button"
                            onClick={() => jumpToTwin(twin)}
                            className="w-full text-left flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-violet-200 bg-violet-50/60 hover:bg-violet-50 text-xs text-violet-900 cursor-pointer focus-visible:outline-2 focus-visible:outline-violet-600"
                          >
                            {twin.viewport === 'mobile' ? <Smartphone size={13} aria-hidden="true" /> : <Monitor size={13} aria-hidden="true" />}
                            <span className="min-w-0">
                              <span className="font-semibold">Same issue on {twin.viewport}: #{n}</span>{' '}
                              <span className="text-violet-700">{twin.item.context}</span>
                            </span>
                            <ArrowRight size={13} className="ml-auto shrink-0" aria-hidden="true" />
                          </button>
                        );
                      })()}
                      <p className="text-xs text-slate-700 leading-relaxed">
                        {item.seo_analysis}
                      </p>

                      {specParts.length > 0 && (
                        <p className="text-[11px] font-mono text-slate-500 leading-relaxed">
                          {specParts.join(' · ')}
                        </p>
                      )}

                      <div className="text-xs text-slate-800 bg-white border border-slate-200 rounded-md p-2.5 leading-relaxed">
                        <span className="font-semibold text-blue-700">Fix: </span>
                        {item.suggested_optimization}
                      </div>


                      {/* Focused Action Strip */}
                      <div className="flex flex-wrap items-center justify-between gap-1.5 pt-0.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            disabled={isFixLoading}
                            onClick={() => {
                              if (patch) {
                                setExpandedFixIds((prev) => ({ ...prev, [item.id]: !prev[item.id] }));
                              } else {
                                setExpandedFixIds((prev) => ({ ...prev, [item.id]: true }));
                                onGenerateFixCode(item);
                              }
                            }}
                            className="px-2 py-1 bg-white hover:bg-slate-100 border border-slate-200 text-slate-700 text-[11px] font-semibold rounded transition-colors flex items-center gap-1 cursor-pointer whitespace-nowrap disabled:opacity-50"
                          >
                            {isFixLoading ? (
                              <Loader2 size={11} className="animate-spin text-blue-600" />
                            ) : (
                              <Code2 size={11} className="text-blue-600" />
                            )}
                            {patch ? (isFixOpen ? 'Hide Code' : 'View Code') : 'Code Fix'}
                          </button>

                          <button
                            type="button"
                            onClick={() =>
                              copyTextWithFeedback(
                                `ticket-${item.id}`,
                                buildTicketMarkdown(item),
                                'Issue ticket Markdown copied for Linear / Jira / GitHub.'
                              )
                            }
                            className="px-2 py-1 bg-white hover:bg-slate-100 border border-slate-200 text-slate-700 text-[11px] font-medium rounded transition-colors flex items-center gap-1 cursor-pointer whitespace-nowrap"
                            title="Copy formatted Markdown issue ticket"
                          >
                            {copiedId === `ticket-${item.id}` ? (
                              <Check size={11} className="text-emerald-600" />
                            ) : (
                              <ClipboardCopy size={11} />
                            )}
                            Ticket
                          </button>

                          <button
                            type="button"
                            onClick={() => onDiscussFinding(item)}
                            className="px-2 py-1 bg-white hover:bg-blue-50 border border-slate-200 hover:border-blue-200 text-slate-700 hover:text-blue-700 text-[11px] font-medium rounded transition-colors flex items-center gap-1 cursor-pointer whitespace-nowrap"
                            title="Ask the CRO Strategist about this finding"
                          >
                            <MessageSquare size={11} />
                            Discuss
                          </button>
                        </div>

                        {canRedesign && (
                          <button
                            type="button"
                            onClick={() => handleOpenElementRedesign(item)}
                            className="px-2.5 py-1 bg-slate-900 hover:bg-blue-600 text-white text-[11px] font-semibold rounded transition-colors flex items-center gap-1 cursor-pointer whitespace-nowrap"
                          >
                            <Wand2 size={11} />
                            Redesign
                          </button>
                        )}
                      </div>

                      {/* Generated Drop-In Code Patch */}
                      {isFixOpen && patch && (
                        <div className="rounded-lg overflow-hidden border border-slate-800 bg-slate-950 text-slate-100">
                          <div className="px-3 py-1.5 bg-slate-900 border-b border-slate-800 flex items-center justify-between gap-2">
                            <span className="text-[11px] font-semibold text-slate-200 truncate">
                              {patch.title}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                copyTextWithFeedback(
                                  `code-${item.id}`,
                                  patch.code,
                                  'Code patch copied to clipboard.'
                                )
                              }
                              className="text-[11px] font-medium text-blue-300 hover:text-white flex items-center gap-1 cursor-pointer shrink-0"
                            >
                              {copiedId === `code-${item.id}` ? <Check size={11} /> : <ClipboardCopy size={11} />}
                              {copiedId === `code-${item.id}` ? 'Copied' : 'Copy Code'}
                            </button>
                          </div>
                          <pre className="p-3 text-[11px] font-mono overflow-x-auto leading-relaxed text-emerald-200 max-h-52">
                            <code>{patch.code}</code>
                          </pre>
                          {patch.notes && (
                            <p className="px-3 py-2 border-t border-slate-800 bg-slate-900/70 text-[11px] text-slate-400 leading-relaxed">
                              {patch.notes}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                </React.Fragment>
              );
            })
          )}
          {omittedItems.length > 0 && (
            <div className="p-3 text-center">
              <button
                type="button"
                onClick={() => {
                  if (showOmitted && selectedId && omittedIds.has(selectedId)) setSelectedId(null);
                  setShowOmitted((v) => !v);
                }}
                aria-expanded={showOmitted}
                className="text-xs font-medium text-slate-500 hover:text-slate-800 underline underline-offset-2 decoration-slate-300 cursor-pointer focus-visible:outline-2 focus-visible:outline-blue-600 rounded"
              >
                {showOmitted
                  ? `Hide the ${omittedItems.length} lower-impact findings`
                  : `Show ${omittedItems.length} more lower-impact finding${omittedItems.length === 1 ? '' : 's'}`}
              </button>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
};
