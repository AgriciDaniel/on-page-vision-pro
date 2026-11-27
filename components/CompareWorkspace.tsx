import React, { useState } from 'react';
import {
  Monitor,
  Smartphone,
  RefreshCw,
  Loader2,
  AlertCircle,
  AlertTriangle,
  Info,
  Eye,
  EyeOff,
  Upload,
  Flame,
  Glasses,
} from 'lucide-react';
import type { AuditFinding, ComparisonSummary, ViewportData, ViewportKey } from '../types';
import { badgeSpot, badgeWidth, type BadgeSpot } from '../lib/client/badges';
import { findingRect, heatSpots, pageViewOf } from '../lib/client/pageView';
import { findingTwins } from '../lib/client/twins';
import type { PixelRect } from '../lib/geometry';

/** "1440×900" for a viewport shot; "1440×900 of 1440×12,400" for a full page (first screen of the whole). */
function specOf(data: ViewportData, key: ViewportKey): string {
  const v = pageViewOf(data, key);
  const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
  const first = `${fmt(v.size.width)}×${fmt(v.foldPx)}`;
  return v.showFold ? `${first} of ${fmt(v.size.width)}×${fmt(v.size.height)}` : first;
}

interface CompareWorkspaceProps {
  desktopData: ViewportData | null;
  mobileData: ViewportData | null;
  comparison: ComparisonSummary | null;
  isComparing: boolean;
  onRunComparison: () => void;
  onUploadMissingViewport: (viewport: 'desktop' | 'mobile', file: File) => void;
  onInspectFinding: (viewport: ViewportKey, findingId: string) => void;
}

function shortSummary(item: AuditFinding): string {
  const text = (item.seo_analysis || item.suggested_optimization || '').replace(/\s+/g, ' ').trim();
  const match = text.match(/^.+?[.!?](?:\s|$)/);
  const first = match ? match[0].trim() : text;
  return first.length <= 125 ? first : `${first.slice(0, 124).trimEnd()}…`;
}

const COMPARE_BADGE_CLASS: Record<BadgeSpot, string> = {
  above: '-top-4 -left-[1px] rounded-t-xs',
  inside: 'top-0.5 left-0.5 rounded-xs',
  // Compare boxes draw a 1.5 px border inside their edge: sit just past it.
  left: '-top-[1px] right-[calc(100%+1.5px)] rounded-l-xs',
  right: '-top-[1px] left-[calc(100%+1.5px)] rounded-r-xs',
};

export const CompareWorkspace: React.FC<CompareWorkspaceProps> = ({
  desktopData,
  mobileData,
  comparison,
  isComparing,
  onRunComparison,
  onUploadMissingViewport,
  onInspectFinding,
}) => {
  const [showBoxes, setShowBoxes] = useState(true);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [squintMode, setSquintMode] = useState(false);
  const [showFoldGuide, setShowFoldGuide] = useState(true);
  const [hoveredBox, setHoveredBox] = useState<{
    viewport: ViewportKey;
    item: AuditFinding;
    badgeNum: number;
  } | null>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, target: 'desktop' | 'mobile') => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    onUploadMissingViewport(target, file);
  };

  if (!desktopData || !mobileData) {
    const missing: 'desktop' | 'mobile' = !mobileData ? 'mobile' : 'desktop';
    return (
      <div className="flex-1 overflow-y-auto bg-[#F8FAFC] p-8 flex items-center justify-center">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-xl p-6 text-center space-y-4">
          <div className="w-10 h-10 rounded-lg bg-slate-100 border border-slate-200 mx-auto flex items-center justify-center text-slate-700">
            {missing === 'mobile' ? <Smartphone size={18} /> : <Monitor size={18} />}
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-900 mb-1">
              Add a {missing} viewport to compare devices
            </h2>
            <p className="text-xs text-slate-600 leading-relaxed">
              Upload a {missing} screenshot to unlock synchronized Desktop vs. Mobile fold analysis and tap-target parity scoring.
            </p>
          </div>
          <label className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg cursor-pointer transition-colors">
            <Upload size={14} />
            Upload {missing === 'mobile' ? 'Mobile' : 'Desktop'} Screenshot
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => handleFileUpload(e, missing)}
            />
          </label>
        </div>
      </div>
    );
  }

  const dScore = desktopData.analysis?.scores;
  const mScore = mobileData.analysis?.scores;

  const renderViewportCard = (
    title: string,
    spec: string,
    icon: React.ReactNode,
    data: ViewportData,
    viewportKey: ViewportKey
  ) => {
    const isMobile = viewportKey === 'mobile';
    const activeHover = hoveredBox && hoveredBox.viewport === viewportKey ? hoveredBox : null;
    // Compare is about what each device shows first. A full page is shown from the top to a
    // quarter screen past the fold, so the fold line has room to mean something.
    const view = pageViewOf(data, viewportKey);
    const W = view.size.width;
    const visibleH = view.showFold ? Math.min(view.size.height, view.foldPx * 1.25) : view.size.height;
    const pct = (r: PixelRect) => ({
      top: (r.y / visibleH) * 100,
      left: (r.x / W) * 100,
      width: (r.width / W) * 100,
      height: (r.height / visibleH) * 100,
    });
    const spots = heatSpots(data.analysis?.attention_hotspots, data.analysis?.items || [], view);

    // Put the "First screen ends" label in the first corner by the fold line that covers no box
    // (G10). Sizes are estimated in px from the card width, then compared in percent of the frame.
    const frameW = isMobile ? 280 : 760;
    const frameH = (frameW * visibleH) / W;
    const labelW = (112 / frameW) * 100;
    const labelH = (20 / frameH) * 100;
    const edge = (8 / frameW) * 100;
    const foldTopPct = (view.foldPx / visibleH) * 100;
    const boxPcts = (data.analysis?.items || [])
      .map((it) => findingRect(it, view))
      .filter((r): r is PixelRect => Boolean(r) && r!.y < visibleH)
      .map(pct);
    const placements = [
      { cls: 'right-2 -top-5', left: 100 - edge - labelW, top: foldTopPct - labelH },
      { cls: 'left-2 -top-5', left: edge, top: foldTopPct - labelH },
      { cls: 'right-2 top-1', left: 100 - edge - labelW, top: foldTopPct + 0.2 },
      { cls: 'left-2 top-1', left: edge, top: foldTopPct + 0.2 },
    ];
    const free = placements.find(
      (pl) =>
        !boxPcts.some(
          (b) =>
            !(b.left + b.width < pl.left || b.left > pl.left + labelW || b.top + b.height < pl.top || b.top > pl.top + labelH)
        )
    );
    const foldLabelClass = free?.cls ?? null;

    return (
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between bg-slate-50/70">
          <div className="flex items-center gap-2">
            {icon}
            <span className="text-xs font-semibold text-slate-900">{title}</span>
            <span className="text-xs font-mono text-slate-400">{spec}</span>
          </div>
          <span className="text-xs font-mono font-bold tabular-nums text-slate-900">
            {data.analysis?.scores ? `${data.analysis.scores.overall}/100` : 'Auditing...'}
          </span>
        </div>

        <div className="p-4 bg-[#EEF2F6] flex-1 flex flex-col items-center">
          <div
            className={`relative bg-white border border-slate-300 shadow-xs overflow-hidden ${
              isMobile ? 'w-[280px]' : 'w-full'
            }`}
            style={{ aspectRatio: `${W} / ${visibleH}` }}
          >
            <img
              src={data.screenshotDataUrl}
              alt={view.showFold ? `${title}, first screen` : title}
              className="absolute top-0 left-0 block w-full h-auto transition-all duration-200"
              style={{
                filter: squintMode ? 'grayscale(100%) blur(2.2px) contrast(1.06)' : 'none',
              }}
              draggable={false}
            />

            {/* Synchronized 3-Second Heatmap Layer: clipped strictly to first screen */}
            {showHeatmap && spots.length > 0 && (
              <div
                className="pointer-events-none absolute inset-x-0 top-0 z-20 overflow-hidden"
                style={{ height: `${Math.min(100, (view.foldPx / visibleH) * 100)}%` }}
              >
                <div className="absolute top-1.5 left-1.5 z-30 px-1.5 py-0.5 rounded bg-slate-900/85 text-white text-[9px] font-medium">
                  AI 3s Estimate
                </div>
                <div className="absolute inset-0" style={{ filter: 'blur(16px)', opacity: 0.8 }}>
                  {spots.map((spot) => {
                    const peak = Math.max(0.42, Math.min(0.88, spot.intensity / 108));
                    return (
                      <div
                        key={`cmp-heat-${viewportKey}-${spot.rank}`}
                        style={{
                          left: `${(spot.cx / W) * 100}%`,
                          top: `${(spot.cy / view.foldPx) * 100}%`,
                          width: `${((2 * spot.r) / W) * 100}%`,
                          height: `${((2 * spot.r) / view.foldPx) * 100}%`,
                          transform: 'translate(-50%, -50%)',
                          background: `radial-gradient(circle at center, rgba(220,38,38,${peak}) 0%, rgba(249,115,22,${peak * 0.7}) 30%, rgba(250,204,21,${peak * 0.42}) 56%, rgba(34,211,238,0) 100%)`,
                        }}
                        className="absolute mix-blend-multiply"
                      />
                    );
                  })}
                </div>
                {spots.map((spot) => (
                  <span
                    key={`cmp-node-${viewportKey}-${spot.rank}`}
                    style={{
                      left: `${(spot.cx / W) * 100}%`,
                      top: `${(spot.cy / view.foldPx) * 100}%`,
                      transform: 'translate(-50%, -50%)',
                    }}
                    className="absolute w-4 h-4 rounded-full bg-slate-900 text-white border border-white text-[9px] font-mono font-bold flex items-center justify-center shadow"
                  >
                    {spot.rank}
                  </span>
                ))}
              </div>
            )}

            {showFoldGuide && view.showFold && (
              <div
                className="absolute inset-x-0 border-t-2 border-dashed border-blue-600/80 pointer-events-none z-25"
                style={{ top: `${(view.foldPx / visibleH) * 100}%` }}
              >
                {foldLabelClass && (
                  <span
                    className={`absolute bg-blue-600 text-white text-[10px] font-mono px-1.5 py-0.5 rounded whitespace-nowrap ${foldLabelClass}`}
                  >
                    First screen ends
                  </span>
                )}
              </div>
            )}

            {/* Interactive Hoverable + Clickable Bounding Boxes */}
            {showBoxes &&
              (data.analysis?.items || []).map((item, idx) => {
                const rect = findingRect(item, view);
                // Only what is on screen here: boxes that start inside the visible window.
                if (!rect || rect.y >= visibleH) return null;
                const { top, left, width, height } = pct(rect);

                const isHovered = activeHover?.item.id === item.id;
                const isDimmed = Boolean(activeHover && !isHovered);
                const border =
                  item.severity === 'critical'
                    ? 'border-red-600'
                    : item.severity === 'warning'
                    ? 'border-amber-600'
                    : 'border-blue-600';
                const bg =
                  item.severity === 'critical'
                    ? 'bg-red-600'
                    : item.severity === 'warning'
                    ? 'bg-amber-600'
                    : 'bg-blue-600';
                const tint =
                  item.severity === 'critical'
                    ? 'bg-red-600/12'
                    : item.severity === 'warning'
                    ? 'bg-amber-600/12'
                    : 'bg-blue-600/12';

                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onInspectFinding(viewportKey, item.id)}
                    onMouseEnter={() => setHoveredBox({ viewport: viewportKey, item, badgeNum: idx + 1 })}
                    onMouseLeave={() =>
                      setHoveredBox((prev) => (prev?.item.id === item.id ? null : prev))
                    }
                    style={{
                      top: `${top}%`,
                      left: `${left}%`,
                      width: `${width}%`,
                      height: `${height}%`,
                    }}
                    className={`absolute box-border transition-all duration-150 cursor-pointer ${
                      isHovered
                        ? `z-30 border-2 ${border} ${tint} opacity-100`
                        : isDimmed
                        ? `z-10 border ${border} bg-transparent opacity-20`
                        : `z-10 border-[1.5px] ${border} bg-transparent`
                    }`}
                    aria-label={`Inspect ${title} finding ${idx + 1}: ${item.context}`}
                  >
                    <span
                      className={`absolute px-1 h-4 inline-flex items-center justify-center text-[9px] font-mono font-bold text-white ${bg} ${
                        COMPARE_BADGE_CLASS[
                          badgeSpot(
                            { x: (left / 100) * frameW, y: (top / 100) * frameH, width: (width / 100) * frameW, height: (height / 100) * frameH },
                            frameW,
                            { width: badgeWidth(idx + 1, 5.5, 8), height: 17 }
                          )
                        ]
                      }`}
                    >
                      {idx + 1}
                    </span>
                  </button>
                );
              })}

            {/* Plain-English Floating Hover Callout */}
            {showBoxes && activeHover && findingRect(activeHover.item, view) && (() => {
              const hp = pct(findingRect(activeHover.item, view)!);
              const topPct = hp.top;
              const bottomPct = Math.min(100, hp.top + hp.height);
              const leftPct = hp.left;
              const rightPct = hp.left + hp.width;
              const placeAbove = bottomPct > 58 && topPct > 24;
              const alignRight = leftPct > 48;
              const bg =
                activeHover.item.severity === 'critical'
                  ? 'bg-red-600'
                  : activeHover.item.severity === 'warning'
                  ? 'bg-amber-600'
                  : 'bg-blue-600';

              const style: React.CSSProperties = {
                ...(placeAbove
                  ? { bottom: `${Math.min(90, 100 - topPct + 1.5)}%` }
                  : { top: `${Math.min(72, bottomPct + 1.5)}%` }),
                ...(isMobile
                  ? { left: '4%', right: '4%' }
                  : alignRight
                  ? { right: `${Math.max(2, 100 - rightPct)}%` }
                  : { left: `${Math.min(56, Math.max(2, leftPct))}%` }),
              };

              return (
                <div
                  style={style}
                  className={`pointer-events-none absolute z-40 bg-slate-900/95 text-white rounded-lg shadow-xl border border-slate-700 p-2.5 space-y-1 ${
                    isMobile ? '' : 'w-64 max-w-[85%]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className={`px-1 h-4 rounded text-[9px] font-mono font-bold text-white inline-flex items-center justify-center shrink-0 ${bg}`}
                      >
                        #{activeHover.badgeNum}
                      </span>
                      <span className="text-[11px] font-semibold truncate">
                        {activeHover.item.context}
                      </span>
                    </div>
                    <span className="text-[10px] font-mono tabular-nums text-slate-300 shrink-0">
                      {activeHover.item.impact_score}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-200 leading-snug">
                    {shortSummary(activeHover.item)}
                  </p>
                  <p className="text-[10px] text-blue-300 font-medium">
                    Click to inspect in Canvas →
                  </p>
                </div>
              );
            })()}
          </div>
          {showFoldGuide && view.showFold && !free && (
            // Every corner by the fold covers a box: say it under the image instead of on it.
            <p className="mt-1.5 text-[10px] font-mono text-blue-700 flex items-center gap-1.5">
              <span className="inline-block w-5 border-t-2 border-dashed border-blue-600" aria-hidden="true" />
              First screen ends at {Math.round(view.foldPx).toLocaleString('en-US')} px
            </p>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex-1 overflow-y-auto bg-[#F8FAFC]">
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        {/* Top Controls Row */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-slate-900">
              {desktopData.captureMode === 'fullpage' || mobileData.captureMode === 'fullpage'
                ? 'Desktop vs. Mobile First Screen Comparison'
                : 'Desktop vs. Mobile Viewport Comparison'}
            </h2>
            <p className="text-xs text-slate-600 mt-0.5">
              Hover any numbered box for a plain-English summary, or click to jump straight to its fix in Canvas.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center p-0.5 bg-slate-100 border border-slate-200 rounded-md">
              <button
                type="button"
                onClick={() => setShowBoxes((v) => !v)}
                className={`px-2.5 py-1 rounded text-xs font-medium flex items-center gap-1 cursor-pointer whitespace-nowrap transition-colors ${
                  showBoxes ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {showBoxes ? <Eye size={12} /> : <EyeOff size={12} />}
                Boxes
              </button>
              <button
                type="button"
                onClick={() => setShowHeatmap((v) => !v)}
                className={`px-2.5 py-1 rounded text-xs font-medium flex items-center gap-1 cursor-pointer whitespace-nowrap transition-colors ${
                  showHeatmap ? 'bg-orange-600 text-white shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Flame size={12} />
                Heatmap
              </button>
              <button
                type="button"
                onClick={() => setSquintMode((v) => !v)}
                className={`px-2.5 py-1 rounded text-xs font-medium flex items-center gap-1 cursor-pointer whitespace-nowrap transition-colors ${
                  squintMode ? 'bg-slate-900 text-white shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Glasses size={12} />
                Squint
              </button>
              <button
                type="button"
                onClick={() => setShowFoldGuide((v) => !v)}
                className={`px-2.5 py-1 rounded text-xs font-medium cursor-pointer whitespace-nowrap transition-colors ${
                  showFoldGuide ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Fold
              </button>
            </div>

            <button
              type="button"
              onClick={onRunComparison}
              disabled={isComparing}
              className="px-3.5 py-1.5 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-200 text-white text-xs font-semibold rounded-md flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            >
              {isComparing ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <RefreshCw size={13} />
              )}
              {comparison ? 'Re-Run Parity Audit' : 'Run Parity Audit'}
            </button>
          </div>
        </div>

        {/* Score Delta Table */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs text-slate-500">Desktop Overall</p>
            <p className="text-2xl font-bold font-mono tabular-nums text-slate-900 mt-1">
              {dScore?.overall ?? 'n/a'}
              <span className="text-xs font-normal text-slate-400">/100</span>
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs text-slate-500">Mobile Overall</p>
            <p className="text-2xl font-bold font-mono tabular-nums text-slate-900 mt-1">
              {mScore?.overall ?? 'n/a'}
              <span className="text-xs font-normal text-slate-400">/100</span>
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs text-slate-500">Responsive Parity</p>
            <p className="text-2xl font-bold font-mono tabular-nums text-blue-600 mt-1">
              {comparison ? comparison.parity_score : 'n/a'}
              <span className="text-xs font-normal text-slate-400">/100</span>
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs text-slate-500">Device Score Gap</p>
            <p className="text-2xl font-bold font-mono tabular-nums text-slate-900 mt-1">
              {dScore && mScore ? `${mScore.overall - dScore.overall >= 0 ? '+' : ''}${mScore.overall - dScore.overall}` : 'n/a'}
              <span className="text-xs font-normal text-slate-400"> pts</span>
            </p>
          </div>
        </div>

        {/* Synchronized Side-by-Side Viewport Frames */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
          <div className="lg:col-span-8 flex flex-col">
            {renderViewportCard(
              desktopData.captureMode === 'fullpage' ? 'Desktop First Screen' : 'Desktop Viewport',
              specOf(desktopData, 'desktop'),
              <Monitor size={14} className="text-slate-600" />,
              desktopData,
              'desktop'
            )}
          </div>
          <div className="lg:col-span-4 flex flex-col">
            {renderViewportCard(
              mobileData.captureMode === 'fullpage' ? 'Mobile First Screen' : 'Mobile Viewport',
              specOf(mobileData, 'mobile'),
              <Smartphone size={14} className="text-slate-600" />,
              mobileData,
              'mobile'
            )}
          </div>
        </div>

        {/* AI Parity Diagnostics */}
        {isComparing && !comparison ? (
          <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-2">
            <Loader2 size={22} className="mx-auto text-blue-600 animate-spin" />
            <p className="text-sm font-semibold text-slate-900">
              Analyzing Desktop vs. Mobile responsive parity...
            </p>
          </div>
        ) : comparison ? (
          <div className="space-y-4">
            <div className="bg-white border border-slate-200 rounded-xl p-5 grid grid-cols-1 md:grid-cols-3 gap-6">
              <div>
                <h3 className="text-xs font-semibold text-slate-500 mb-1.5">Executive Verdict</h3>
                <p className="text-sm text-slate-800 leading-relaxed">{comparison.executive_verdict}</p>
              </div>
              <div>
                <h3 className="text-xs font-semibold text-slate-500 mb-1.5">Above-the-Fold Delta</h3>
                <p className="text-sm text-slate-800 leading-relaxed">{comparison.above_the_fold_delta}</p>
              </div>
              <div>
                <h3 className="text-xs font-semibold text-slate-500 mb-1.5">Tap Target &amp; Touch Ergonomics</h3>
                <p className="text-sm text-slate-800 leading-relaxed">{comparison.tap_target_verdict}</p>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50/70">
                <h3 className="text-sm font-semibold text-slate-900">
                  Cross-Device Parity Issues ({comparison.parity_issues.length})
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-white border-b border-slate-200 text-slate-500">
                    <tr>
                      <th className="py-3 px-4 font-semibold">Issue</th>
                      <th className="py-3 px-4 font-semibold">Desktop Behavior</th>
                      <th className="py-3 px-4 font-semibold">Mobile Behavior</th>
                      <th className="py-3 px-4 font-semibold">Recommended Fix</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {comparison.parity_issues.map((issue, idx) => (
                      <tr key={idx} className="hover:bg-slate-50/60">
                        <td className="py-3.5 px-4 align-top max-w-[200px]">
                          <div className="flex items-center gap-1.5 mb-1">
                            {issue.severity === 'critical' ? (
                              <AlertCircle size={13} className="text-red-600 shrink-0" />
                            ) : issue.severity === 'warning' ? (
                              <AlertTriangle size={13} className="text-amber-600 shrink-0" />
                            ) : (
                              <Info size={13} className="text-blue-600 shrink-0" />
                            )}
                            <span className="font-semibold text-slate-900">{issue.title}</span>
                          </div>
                        </td>
                        <td className="py-3.5 px-4 align-top text-slate-600 leading-relaxed">
                          {issue.desktop_behavior}
                        </td>
                        <td className="py-3.5 px-4 align-top text-slate-600 leading-relaxed">
                          {issue.mobile_behavior}
                        </td>
                        <td className="py-3.5 px-4 align-top text-slate-800 font-medium leading-relaxed">
                          {issue.recommended_fix}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : null}

        {/* Full-Page Cross-Device Linked Findings (zero extra model calls) */}
        {(() => {
          const twins = findingTwins(desktopData.analysis, mobileData.analysis);
          const pairs = (desktopData.analysis?.items || [])
            .map((dItem, dIdx) => {
              const twin = twins.get(dItem.id);
              if (!twin) return null;
              const mIdx = (mobileData.analysis?.items || []).findIndex((m) => m.id === twin.item.id);
              return { dItem, dNum: dIdx + 1, mItem: twin.item, mNum: mIdx + 1 };
            })
            .filter((x): x is { dItem: AuditFinding; dNum: number; mItem: AuditFinding; mNum: number } => Boolean(x));
          if (pairs.length === 0) return null;
          return (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50/70 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-900">
                  Shared Issues Across Desktop &amp; Mobile ({pairs.length})
                </h3>
                <span className="text-[11px] text-slate-500">Linked across the full page</span>
              </div>
              <div className="divide-y divide-slate-100">
                {pairs.slice(0, 12).map(({ dItem, dNum, mItem, mNum }) => (
                  <div key={dItem.id} className="px-5 py-3 flex flex-wrap items-center justify-between gap-3 text-xs hover:bg-slate-50/60">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-slate-900 truncate">{dItem.context}</p>
                      <p className="text-slate-600 truncate mt-0.5">{shortSummary(dItem)}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onInspectFinding('desktop', dItem.id)}
                        className="px-2 py-1 rounded border border-slate-200 hover:border-blue-400 text-[11px] font-mono font-semibold text-slate-700 hover:text-blue-700 cursor-pointer"
                      >
                        D{dNum}
                      </button>
                      <button
                        type="button"
                        onClick={() => onInspectFinding('mobile', mItem.id)}
                        className="px-2 py-1 rounded border border-slate-200 hover:border-blue-400 text-[11px] font-mono font-semibold text-slate-700 hover:text-blue-700 cursor-pointer"
                      >
                        M{mNum}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
};
