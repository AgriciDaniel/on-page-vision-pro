/**
 * The scrollable canvas: one screenshot with finding boxes, heatmap, fold line, redesign
 * overlays and region drawing, plus zoom, a minimap for tall pages, and scrollToFinding().
 *
 * Everything on the image is positioned in percent of the image (from lib/client/pageView), so it
 * stays aligned at any zoom. Things that must keep a fixed on-screen size (callouts, badges) are
 * placed in display pixels computed from the measured scale.
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Move, X } from 'lucide-react';
import type { AttentionHotspot, AuditFinding, CanvasOverlay, SeverityLevel, ViewportKey } from '../types';
import { pixelRectToBox2d, type PixelRect } from '../lib/geometry';
import {
  findingBoxStyle,
  findingRect,
  findingSection,
  foldPercent,
  heatSpots,
  isTall,
  type PageView,
} from '../lib/client/pageView';
import { cropImagePx } from '../lib/client/images';
import { planMinimap } from '../lib/client/minimap';
import { badgeSpot, badgeWidth, type BadgeSpot } from '../lib/client/badges';

const BADGE_CLASS: Record<BadgeSpot, string> = {
  above: '-top-5 -left-[1.5px] rounded-t-xs',
  inside: 'top-0.5 left-0.5 rounded-xs',
  left: '-top-[1.5px] right-full rounded-l-xs',
  right: '-top-[1.5px] left-full rounded-r-xs',
};

export type ZoomMode = 'fit-width' | 'fit-height' | 'actual';

export interface CanvasStageHandle {
  /** Scroll the stage so the finding's box sits near the top third of the visible area. */
  scrollToFinding: (id: string) => void;
  /** Scroll smoothly back to the top of the page (used when activating first-screen Heatmap). */
  scrollToTop: () => void;
  /** Image Y coordinate at the center of the visible viewport, or null if showing the whole page. */
  getVisibleCenterY: () => number | null;
}

export interface RegionSelection {
  croppedDataUrl: string;
  box2d: [number, number, number, number];
  boxPct: { x: number; y: number; w: number; h: number };
}

interface CanvasStageProps {
  viewport: ViewportKey;
  domain: string;
  screenshotDataUrl: string;
  view: PageView;
  /** Findings to draw (already filtered). */
  items: AuditFinding[];
  /** All findings of this viewport, used for the heatmap fallback. */
  allItems: AuditFinding[];
  hotspots?: AttentionHotspot[];
  indexMap: Map<string, number>;
  overlays: CanvasOverlay[];
  selectedId: string | null;
  hoveredId: string | null;
  hoverFromCanvas: boolean;
  showAnnotations: boolean;
  showHeatmap: boolean;
  showFoldLine: boolean;
  lensFilter: 'none' | 'squint' | 'colorblind';
  isDrawMode: boolean;
  zoom: ZoomMode;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onRegionSelected: (region: RegionSelection) => void;
  onDrawFinished: () => void;
  onUpdateOverlays: (overlays: CanvasOverlay[]) => void;
  /** Ids of "Fix these first" blockers; they stay ticks on a crowded minimap. */
  blockerIds?: ReadonlySet<string>;
  /** Fires only when the currently centered full-page section changes (for section-aware Deep Scan). */
  onVisibleSectionChange?: (sectionIndex: number | null) => void;
}

// Finding boxes are stroked with an outline, drawn outside the box, so the box itself always has the
// finding's exact size. A border would grow a tiny box (a 40 px button is 1.7 px at Whole page zoom).
const SEVERITY: Record<
  SeverityLevel,
  { label: string; outline: string; bg: string; tint: string; tick: string }
> = {
  critical: { label: 'Critical', outline: 'outline-red-600', bg: 'bg-red-600', tint: 'bg-red-600/10', tick: 'bg-red-600' },
  warning: { label: 'Warning', outline: 'outline-amber-600', bg: 'bg-amber-600', tint: 'bg-amber-600/10', tick: 'bg-amber-500' },
  info: { label: 'Info', outline: 'outline-blue-600', bg: 'bg-blue-600', tint: 'bg-blue-600/10', tick: 'bg-blue-600' },
};

const NO_IDS: ReadonlySet<string> = new Set();
const CALLOUT_WIDTH = 288;
const CALLOUT_HEIGHT_GUESS = 130;
const MAX_FIT_WIDTH: Record<ViewportKey, number> = { desktop: 1100, mobile: 390 };

function plainTakeaway(item: AuditFinding, maxLen = 145): string {
  const raw = (item.seo_analysis || item.suggested_optimization || '').replace(/\s+/g, ' ').trim();
  if (!raw) return 'Review this element for conversion and hierarchy impact.';
  const first = raw.match(/^.+?[.!?](?:\s|$)/)?.[0].trim() ?? raw;
  return first.length <= maxLen ? first : `${first.slice(0, maxLen - 1).trimEnd()}…`;
}

export const CanvasStage = forwardRef<CanvasStageHandle, CanvasStageProps>(function CanvasStage(props, ref) {
  const {
    viewport,
    domain,
    screenshotDataUrl,
    view,
    items,
    allItems,
    hotspots,
    indexMap,
    overlays,
    selectedId,
    hoveredId,
    hoverFromCanvas,
    showAnnotations,
    showHeatmap,
    showFoldLine,
    lensFilter,
    isDrawMode,
    zoom,
    onSelect,
    onHover,
    onRegionSelected,
    onDrawFinished,
    onUpdateOverlays,
    blockerIds = NO_IDS,
    onVisibleSectionChange,
  } = props;

  const stageRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [stageHeight, setStageHeight] = useState(0);
  const [boxWidth, setBoxWidth] = useState(0);
  const [scrollWindow, setScrollWindow] = useState<{ top: number; height: number }>({ top: 0, height: 0 });

  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [drawRect, setDrawRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [draggingOverlayId, setDraggingOverlayId] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<{ id: string; x: number; y: number } | null>(null);

  const { width: W, height: H } = view.size;
  /** Display px per image px. */
  const scale = boxWidth > 0 && W > 0 ? boxWidth / W : 0;
  const tall = isTall(view);

  // Measure the stage and the image box; both change with zoom, window size and layout.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const box = boxRef.current;
    if (!stage || !box) return;
    const measure = () => {
      setStageHeight(stage.clientHeight);
      setBoxWidth(box.clientWidth);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  /** Which part of the image is visible, as fractions of image height (for the minimap). */
  const updateScrollWindow = useCallback(() => {
    const stage = stageRef.current;
    const box = boxRef.current;
    if (!stage || !box || box.clientHeight === 0) return;
    const top = (stage.scrollTop - box.offsetTop) / box.clientHeight;
    const height = stage.clientHeight / box.clientHeight;
    setScrollWindow({ top: Math.max(0, top), height: Math.min(1, height) });
  }, []);

  useEffect(() => {
    updateScrollWindow();
  }, [updateScrollWindow, boxWidth, stageHeight, zoom]);

  const lastVisibleSecRef = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (!onVisibleSectionChange) return;
    let next: number | null = null;
    if (view.sections.length > 1 && zoom !== 'fit-height' && scrollWindow.height < 0.95 && H > 0) {
      const centerY = (scrollWindow.top + scrollWindow.height / 2) * H;
      let best = view.sections[0];
      let bestDist = Infinity;
      for (const s of view.sections) {
        const mid = (s.yStart + s.yEnd) / 2;
        const d = Math.abs(centerY - mid);
        if (d < bestDist) {
          bestDist = d;
          best = s;
        }
      }
      next = best ? best.index : 0;
    }
    if (lastVisibleSecRef.current !== next) {
      lastVisibleSecRef.current = next;
      onVisibleSectionChange(next);
    }
  }, [onVisibleSectionChange, view.sections, zoom, scrollWindow.top, scrollWindow.height, H]);

  const boxStyle = useMemo<React.CSSProperties>(() => {
    // The box has a 1 px border on each side, so its width is the image width plus 2.
    if (zoom === 'actual') return { width: `${W + 2}px`, maxWidth: 'none' };
    if (zoom === 'fit-height' && stageHeight > 0 && H > 0) {
      // Stage padding is 24 px top and bottom (p-6); a very tall page becomes a narrow strip.
      const usable = Math.max(120, stageHeight - 50);
      return { width: `${Math.max(12, (usable * W) / H) + 2}px`, maxWidth: 'none' };
    }
    return { width: '100%', maxWidth: `${MAX_FIT_WIDTH[viewport]}px` };
  }, [zoom, W, H, stageHeight, viewport]);

  const scrollToImageY = useCallback((imageY: number, imageX = 0, anchor = 0.2) => {
    const stage = stageRef.current;
    const box = boxRef.current;
    if (!stage || !box || W <= 0) return;
    const s = box.clientWidth / W;
    const top = box.offsetTop + imageY * s - stage.clientHeight * anchor;
    const left = box.offsetLeft + imageX * s - 40;
    stage.scrollTo({
      top: Math.max(0, top),
      left: stage.scrollWidth > stage.clientWidth ? Math.max(0, left) : undefined,
      behavior: 'smooth',
    });
  }, [W]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToFinding: (id: string) => {
        const item = allItems.find((i) => i.id === id);
        const rect = item ? findingRect(item, view) : null;
        if (!rect) return;
        const go = () => requestAnimationFrame(() => scrollToImageY(rect.y, rect.x));
        // Right after the canvas mounts (a jump from another tab) the image may not have its
        // height yet; scroll once it has loaded, or the target position would be wrong.
        const img = boxRef.current?.querySelector('img');
        if (img && !(img.complete && img.naturalHeight > 0)) img.addEventListener('load', go, { once: true });
        else go();
      },
      scrollToTop: () => {
        stageRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      },
      getVisibleCenterY: () => {
        if (zoom === 'fit-height' || scrollWindow.height >= 0.95 || H <= 0) return null;
        return (scrollWindow.top + scrollWindow.height / 2) * H;
      },
    }),
    [allItems, view, scrollToImageY, zoom, scrollWindow.top, scrollWindow.height, H]
  );

  // --- region drawing and overlay dragging (display px inside the image box) -------------

  const pointInBox = (e: React.MouseEvent | React.PointerEvent) => {
    const rect = boxRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, e.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, e.clientY - rect.top)),
      rect,
    };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isDrawMode || !boxRef.current) return;
    const { x, y } = pointInBox(e);
    setDrawStart({ x, y });
    setDrawRect({ x, y, w: 0, h: 0 });
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!boxRef.current) return;
    if (draggingOverlayId) {
      const target = overlays.find((o) => o.id === draggingOverlayId);
      if (!target) return;
      const { x, y, rect } = pointInBox(e);
      const wPx = (target.w / 100) * rect.width;
      const hPx = (target.h / 100) * rect.height;
      setDragPos({
        id: draggingOverlayId,
        x: Math.max(0, Math.min(100 - target.w, ((x - wPx / 2) / rect.width) * 100)),
        y: Math.max(0, Math.min(100 - target.h, ((y - hPx / 2) / rect.height) * 100)),
      });
      return;
    }
    if (isDrawMode && drawStart) {
      const { x, y } = pointInBox(e);
      setDrawRect({
        x: Math.min(drawStart.x, x),
        y: Math.min(drawStart.y, y),
        w: Math.abs(x - drawStart.x),
        h: Math.abs(y - drawStart.y),
      });
    }
  };

  const handleMouseUp = async () => {
    if (draggingOverlayId) {
      if (dragPos && dragPos.id === draggingOverlayId) {
        const { id, x, y } = dragPos;
        onUpdateOverlays(overlays.map((o) => (o.id === id ? { ...o, x, y } : o)));
      }
      setDraggingOverlayId(null);
      setDragPos(null);
      return;
    }
    if (!isDrawMode || !drawRect || !boxRef.current) return;
    const displayed = boxRef.current.getBoundingClientRect();
    const rectDrawn = drawRect;
    setDrawStart(null);
    setDrawRect(null);
    onDrawFinished();
    if (rectDrawn.w <= 18 || rectDrawn.h <= 18 || displayed.width <= 0) return;
    // Back to image px; box_2d keeps decimals so small regions on tall pages stay exact.
    const s = W / displayed.width;
    const imageRect: PixelRect = { x: rectDrawn.x * s, y: rectDrawn.y * s, width: rectDrawn.w * s, height: rectDrawn.h * s };
    const croppedDataUrl = await cropImagePx(screenshotDataUrl, imageRect);
    onRegionSelected({
      croppedDataUrl,
      box2d: pixelRectToBox2d(imageRect, view.size),
      boxPct: {
        x: (imageRect.x / W) * 100,
        y: (imageRect.y / H) * 100,
        w: (imageRect.width / W) * 100,
        h: (imageRect.height / H) * 100,
      },
    });
  };

  // --- derived layers ----------------------------------------------------------------------

  const spots = useMemo(() => heatSpots(hotspots, allItems, view), [hotspots, allItems, view]);
  const heatHeight = view.mode === 'fullpage' ? view.foldPx : H;
  const activeFocusId = hoveredId || selectedId;

  const hoveredItem = useMemo(() => {
    if (!hoveredId || !hoverFromCanvas || isDrawMode) return null;
    return items.find((i) => i.id === hoveredId && findingRect(i, view)) ?? null;
  }, [hoveredId, hoverFromCanvas, isDrawMode, items, view]);

  const boxed = useMemo(
    () =>
      items
        .map((item) => ({ item, rect: findingRect(item, view) }))
        .filter((t): t is { item: AuditFinding; rect: PixelRect } => Boolean(t.rect)),
    [items, view]
  );
  // Many findings: criticals and blockers as ticks, the rest as per-section density (see minimap.ts).
  const minimap = useMemo(() => planMinimap(boxed, view, blockerIds), [boxed, view, blockerIds]);
  const ticks = minimap.ticks;
  const maxDensity = Math.max(1, ...minimap.density.map((d) => d.count));
  const selectedBox = useMemo(() => boxed.find((b) => b.item.id === selectedId) ?? null, [boxed, selectedId]);

  const imgFilter =
    lensFilter === 'squint'
      ? 'grayscale(100%) blur(2.4px) contrast(1.06)'
      : lensFilter === 'colorblind'
      ? 'url(#vision-pro-deuteranopia)'
      : 'none';

  return (
    <div className="flex-1 flex min-h-0 min-w-0">
      {/* Hidden SVG colour-blind filter */}
      <svg className="sr-only" aria-hidden="true">
        <defs>
          <filter id="vision-pro-deuteranopia">
            <feColorMatrix type="matrix" values="0.625 0.375 0 0 0  0.7 0.3 0 0 0  0 0.3 0.7 0 0  0 0 0 1 0" />
          </filter>
        </defs>
      </svg>

      {/* Scrollable stage */}
      <div
        ref={stageRef}
        onScroll={updateScrollWindow}
        // One tab stop for the whole stage: arrow keys and Page Up/Down scroll it. The boxes are not
        // tab stops (75 on a long mobile page); the findings list is the keyboard path to them.
        tabIndex={0}
        className="relative flex-1 overflow-auto p-5 sm:p-6 bg-[#EEF2F6] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/60"
        aria-label={`${viewport === 'desktop' ? 'Desktop' : 'Mobile'} screenshot of ${domain}. Arrow keys scroll; use the findings list to step through findings.`}
        role="region"
      >
        <div
          ref={boxRef}
          onMouseDown={handleMouseDown}
          onPointerMove={handlePointerMove}
          onMouseUp={handleMouseUp}
          onClick={() => {
            if (!isDrawMode) onSelect(null);
          }}
          style={boxStyle}
          className={`relative mx-auto bg-white border border-slate-300 shadow-sm select-none overflow-hidden ${
            isDrawMode ? 'cursor-crosshair' : 'cursor-default'
          }`}
        >
          <img
            src={screenshotDataUrl}
            alt={`${domain} ${viewport} screenshot${view.mode === 'fullpage' ? ', full page' : ''}`}
            className="block w-full h-auto"
            style={{ filter: imgFilter }}
            draggable={false}
          />

          {/* Simulated attention heatmap: first screen only, round blobs sized from image width */}
          {showHeatmap && spots.length > 0 && heatHeight > 0 && (
            <div
              className="pointer-events-none absolute inset-x-0 top-0 z-25 overflow-hidden"
              style={{ height: `${(heatHeight / H) * 100}%` }}
            >
              <div className="absolute top-2 left-2 z-30 inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-slate-900/88 text-white text-[10px] font-medium shadow-md">
                <span>AI 3s Attention Estimate (first screen)</span>
                <span className="inline-flex items-center gap-1 text-[9px] text-slate-300">
                  <span>Low</span>
                  <span
                    className="w-10 h-1.5 rounded-full"
                    style={{ background: 'linear-gradient(90deg, #22d3ee, #facc15, #f97316, #dc2626)' }}
                  />
                  <span>High</span>
                </span>
              </div>
              <div className="absolute inset-0" style={{ filter: 'blur(20px)', opacity: 0.82 }}>
                {spots.map((spot) => {
                  const peak = Math.max(0.42, Math.min(0.88, spot.intensity / 108));
                  return (
                    <div
                      key={`heat-${spot.rank}-${spot.cx}-${spot.cy}`}
                      style={{
                        left: `${(spot.cx / W) * 100}%`,
                        top: `${(spot.cy / heatHeight) * 100}%`,
                        width: `${((2 * spot.r) / W) * 100}%`,
                        height: `${((2 * spot.r) / heatHeight) * 100}%`,
                        transform: 'translate(-50%, -50%)',
                        background: `radial-gradient(circle at center, rgba(220,38,38,${peak}) 0%, rgba(249,115,22,${peak * 0.72}) 28%, rgba(250,204,21,${peak * 0.45}) 54%, rgba(34,211,238,${peak * 0.16}) 76%, rgba(34,211,238,0) 100%)`,
                      }}
                      className="absolute mix-blend-multiply"
                    />
                  );
                })}
              </div>
              <svg viewBox={`0 0 ${W} ${heatHeight}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full">
                {spots.slice(0, -1).map((spot, idx) => {
                  const next = spots[idx + 1];
                  return (
                    <line
                      key={`path-${idx}`}
                      x1={spot.cx}
                      y1={spot.cy}
                      x2={next.cx}
                      y2={next.cy}
                      stroke="rgba(15, 23, 42, 0.78)"
                      strokeWidth="2.2"
                      strokeDasharray="7 5"
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                })}
              </svg>
              {spots.map((spot) => (
                <div
                  key={`node-${spot.rank}`}
                  style={{
                    left: `${(spot.cx / W) * 100}%`,
                    top: `${(spot.cy / heatHeight) * 100}%`,
                    transform: 'translate(-50%, -50%)',
                  }}
                  className="absolute flex items-center gap-1"
                >
                  <span className="w-5 h-5 rounded-full bg-slate-900 text-white border-[1.5px] border-white shadow-md text-[10px] font-mono font-bold flex items-center justify-center shrink-0">
                    {spot.rank}
                  </span>
                  <span className="bg-slate-900/85 backdrop-blur-xs text-white text-[10px] font-medium px-1.5 py-0.5 rounded shadow-xs whitespace-nowrap">
                    {spot.label}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Fold line: where the first screen ends. Only on full-page images. */}
          {showFoldLine && view.showFold && (
            <div
              className="pointer-events-none absolute inset-x-0 border-t-2 border-dashed border-blue-600 z-30"
              style={{ top: `${foldPercent(view)}%` }}
            >
              <span className="absolute right-2 -top-5 bg-blue-600 text-white text-[10px] font-mono font-semibold px-2 py-0.5 rounded">
                First screen ends ({Math.round(view.foldPx).toLocaleString('en-US')} px)
              </span>
            </div>
          )}

          {/* Draggable AI redesign overlays */}
          {overlays.map((saved) => {
            const ov = dragPos?.id === saved.id ? { ...saved, x: dragPos.x, y: dragPos.y } : saved;
            return (
              <div
                key={ov.id}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  if (!isDrawMode) setDraggingOverlayId(ov.id);
                }}
                style={{ left: `${ov.x}%`, top: `${ov.y}%`, width: `${ov.w}%`, height: `${ov.h}%` }}
                className="absolute z-30 group cursor-move border-2 border-emerald-600 shadow-lg"
                title="Drag to reposition redesigned element"
              >
                <img
                  src={ov.base64.startsWith('data:image') ? ov.base64 : `data:image/png;base64,${ov.base64}`}
                  alt={ov.label}
                  className="w-full h-full object-cover"
                  draggable={false}
                />
                <div className="absolute -top-6 left-0 bg-emerald-600 text-white text-[10px] font-semibold px-1.5 py-0.5 rounded-t flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                  <Move size={10} />
                  Redesigned
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onUpdateOverlays(overlays.filter((o) => o.id !== ov.id));
                  }}
                  className="absolute -top-2.5 -right-2.5 w-5 h-5 rounded-full bg-slate-900 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer"
                  aria-label={`Remove redesigned overlay: ${ov.label}`}
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}

          {drawRect && (
            <div
              style={{ left: drawRect.x, top: drawRect.y, width: drawRect.w, height: drawRect.h }}
              className="absolute z-40 border-2 border-blue-600 bg-blue-600/15 pointer-events-none"
            />
          )}

          {/* Finding boxes */}
          {showAnnotations &&
            items.map((item) => {
              const style = findingBoxStyle(item, view);
              const rect = findingRect(item, view);
              if (!style || !rect) return null;
              const meta = SEVERITY[item.severity] ?? SEVERITY.info;
              const badgeNum = indexMap.get(item.id) || 1;
              const isSelected = selectedId === item.id;
              const isHovered = hoveredId === item.id;
              const isDimmed = Boolean(activeFocusId && activeFocusId !== item.id);
              // Above the box, or outside its corner when a small box sits at the top (badges.ts).
              const spot = badgeSpot(
                { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale },
                W * scale,
                { width: badgeWidth(badgeNum, 6.5, 12), height: 22 }
              );
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(isSelected ? null : item.id);
                  }}
                  onMouseEnter={() => onHover(item.id)}
                  onMouseLeave={() => onHover(null)}
                  onFocus={() => onHover(item.id)}
                  onBlur={() => onHover(null)}
                  style={style}
                  aria-pressed={isSelected}
                  tabIndex={-1}
                  // The light halo (shadow outside the outline) keeps boxes readable on dark page
                  // areas and is invisible on light ones. Dimmed boxes stay at 45%, not 20%.
                  className={`absolute box-border outline-solid shadow-[0_0_0_2.5px_rgba(255,255,255,0.7)] transition-all duration-150 cursor-pointer text-left focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${
                    isSelected
                      ? `z-25 outline-[2.5px] ${meta.outline} ${meta.tint} ring-2 ring-blue-500/40 opacity-100`
                      : isHovered
                      ? `z-30 outline-2 ${meta.outline} ${meta.tint} opacity-100`
                      : isDimmed
                      ? `z-10 outline-1 ${meta.outline} bg-transparent opacity-45`
                      : `z-10 outline-[1.5px] ${meta.outline} bg-transparent`
                  }`}
                  aria-label={`Finding ${badgeNum}: ${item.context}`}
                >
                  <span
                    className={`absolute px-1.5 h-5 inline-flex items-center justify-center text-[10px] font-mono font-bold text-white ring-1 ring-white/80 ${meta.bg} ${
                      BADGE_CLASS[spot]
                    }`}
                  >
                    {badgeNum}
                  </span>
                </button>
              );
            })}

          {/* Hover callout, placed in display px next to its box */}
          {showAnnotations && hoveredItem && scale > 0 && (() => {
            const rect = findingRect(hoveredItem, view)!;
            const dispW = W * scale;
            const dispH = H * scale;
            const bx = rect.x * scale;
            const by = rect.y * scale;
            const bh = rect.height * scale;
            const width = Math.min(CALLOUT_WIDTH, dispW - 16);
            const below = by + bh + 8 + CALLOUT_HEIGHT_GUESS <= dispH || by < CALLOUT_HEIGHT_GUESS + 8;
            const left = Math.max(8, Math.min(bx, dispW - width - 8));
            const meta = SEVERITY[hoveredItem.severity] ?? SEVERITY.info;
            const section = findingSection(hoveredItem, view);
            return (
              <div
                style={{
                  left,
                  width,
                  ...(below ? { top: by + bh + 8 } : { bottom: dispH - by + 8 }),
                }}
                className="pointer-events-none absolute z-40 bg-slate-900/95 backdrop-blur-xs text-white rounded-lg shadow-xl border border-slate-700/90 p-3 space-y-1.5"
                role="tooltip"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className={`px-1.5 h-4 rounded text-[10px] font-mono font-bold text-white inline-flex items-center justify-center shrink-0 ${meta.bg}`}>
                      #{indexMap.get(hoveredItem.id) || 1}
                    </span>
                    <span className="text-xs font-semibold text-white truncate">{hoveredItem.context}</span>
                  </div>
                  <span className="text-[10px] font-mono tabular-nums text-slate-300 shrink-0">
                    Impact {hoveredItem.impact_score}
                  </span>
                </div>
                <p className="text-[11px] text-slate-200 leading-relaxed">{plainTakeaway(hoveredItem)}</p>
                <div className="flex items-center justify-between text-[10px] text-slate-400 pt-0.5">
                  <span className="truncate">
                    {meta.label} · {hoveredItem.category}
                    {section?.label ? ` · ${section.label}` : ''}
                  </span>
                  <span className="text-blue-300 font-medium shrink-0">Click to open fix</span>
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* Minimap for tall pages: sections, fold, finding ticks, visible window; click to jump */}
      {tall && (
        <div
          className="no-print relative w-5 shrink-0 bg-white border-l border-slate-200 cursor-pointer"
          title="Page overview. Click to jump."
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const fraction = (e.clientY - r.top) / r.height;
            scrollToImageY(fraction * H, 0, 0.5);
          }}
        >
          {view.sections.map((sec, idx) => {
            const next = view.sections[idx + 1];
            const end = next ? next.yStart : sec.yEnd;
            return (
              <div
                key={`sec-${sec.index}`}
                title={sec.label || `Section ${sec.index + 1}`}
                className={`absolute inset-x-0 ${idx % 2 === 0 ? 'bg-slate-100' : 'bg-slate-200/70'}`}
                style={{ top: `${(sec.yStart / H) * 100}%`, height: `${((end - sec.yStart) / H) * 100}%` }}
              />
            );
          })}
          {view.showFold && (
            <div
              className="absolute inset-x-0 border-t-2 border-blue-600 pointer-events-none"
              style={{ top: `${foldPercent(view)}%` }}
            />
          )}
          <div
            className="absolute inset-x-0 border border-slate-500/70 bg-slate-500/10 pointer-events-none"
            style={{ top: `${scrollWindow.top * 100}%`, height: `${scrollWindow.height * 100}%` }}
          />
          {minimap.density.map((seg) => (
            <button
              key={`density-${seg.key}`}
              type="button"
              data-density={seg.count}
              // Minimap controls are for the mouse; keyboard users scroll the stage itself.
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                scrollToImageY(seg.yStart, 0, 0.05);
              }}
              className="absolute left-0 w-[7px] rounded-r-sm bg-slate-800 hover:bg-blue-600 focus-visible:outline-2 focus-visible:outline-blue-600"
              style={{
                top: `${(seg.yStart / H) * 100}%`,
                height: `${((seg.yEnd - seg.yStart) / H) * 100}%`,
                opacity: 0.18 + 0.67 * (seg.count / maxDensity),
              }}
              aria-label={`${seg.label}: ${seg.count} more finding${seg.count === 1 ? '' : 's'}. Go there.`}
              title={`${seg.label}: ${seg.count} more finding${seg.count === 1 ? '' : 's'}`}
            />
          ))}
          {selectedBox && !ticks.some((t) => t.item.id === selectedBox.item.id) && (
            <div
              className="absolute left-0.5 right-0.5 h-[3px] rounded-full bg-blue-600 ring-2 ring-blue-500 pointer-events-none"
              style={{ top: `calc(${((selectedBox.rect.y + selectedBox.rect.height / 2) / H) * 100}% - 1.5px)` }}
            />
          )}
          {ticks.map(({ item, rect }) => (
            <button
              key={`tick-${item.id}`}
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                // Stop the strip's own click (which jumps to the click point) and scroll to the
                // box itself, the same way a list click does (scrollToFinding).
                e.stopPropagation();
                onSelect(item.id);
                requestAnimationFrame(() => scrollToImageY(rect.y, rect.x));
              }}
              className={`absolute left-0.5 right-0.5 h-[3px] rounded-full ${
                (SEVERITY[item.severity] ?? SEVERITY.info).tick
              } ${selectedId === item.id ? 'ring-2 ring-blue-500' : ''}`}
              style={{ top: `calc(${((rect.y + rect.height / 2) / H) * 100}% - 1.5px)` }}
              aria-label={`Go to finding ${indexMap.get(item.id) || ''}: ${item.context}`}
              title={`#${indexMap.get(item.id) || ''} ${item.context}`}
            />
          ))}
        </div>
      )}
    </div>
  );
});
