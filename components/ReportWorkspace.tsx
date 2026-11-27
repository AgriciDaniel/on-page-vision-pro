import React, { useMemo, useState } from 'react';
import {
  Printer,
  Image as ImageIcon,
  FileText,
  FileJson,
  AlertCircle,
  AlertTriangle,
  Info,
  CheckCircle2,
  Database,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Layers,
  FileEdit,
  Globe,
  Share2,
  Code2,
  ClipboardCopy,
  Check,
  ArrowUpRight,
} from 'lucide-react';
import type { AuditSession, SeverityLevel, ViewportKey } from '../types';
import { AudioBriefingBar } from './AudioBriefingBar';
import { findingLabels } from '../utils/exportUtils';
import { FixFirstBlock } from './FixFirstBlock';
import { describeStats, mergedPriorityRows } from '../lib/client/priorities';
import { findingTwins } from '../lib/client/twins';

interface ReportWorkspaceProps {
  session: AuditSession;
  previousScoreDelta: number | null;
  isGeneratingAudio: boolean;
  onGenerateAudio: (voice: 'Kore' | 'Charon') => void;
  onReAudit?: () => void;
  onInspectFinding?: (viewport: ViewportKey, findingId: string) => void;
  onCopySummaryNotice?: (msg: string) => void;
  onExportPng: () => void;
  onExportMarkdown: () => void;
  onExportJson: () => void;
}

export const ReportWorkspace: React.FC<ReportWorkspaceProps> = ({
  session,
  previousScoreDelta,
  isGeneratingAudio,
  onGenerateAudio,
  onReAudit,
  onInspectFinding,
  onCopySummaryNotice,
  onExportPng,
  onExportMarkdown,
  onExportJson,
}) => {
  const [severityFilter, setSeverityFilter] = useState<'all' | SeverityLevel>('all');
  const [copiedSummary, setCopiedSummary] = useState(false);

  const desktopAudit = session.viewports.desktop?.analysis;
  const mobileAudit = session.viewports.mobile?.analysis;
  const primaryAudit = desktopAudit || mobileAudit;
  const primaryScreenshot =
    session.viewports.desktop?.screenshotDataUrl || session.viewports.mobile?.screenshotDataUrl;
  const isFullPage = (session.viewports.desktop ?? session.viewports.mobile)?.captureMode === 'fullpage';

  const allFindings = [
    ...(desktopAudit?.items || []),
    ...(mobileAudit?.items || []),
  ];
  const labels = findingLabels(session);
  const twins = useMemo(() => findingTwins(desktopAudit, mobileAudit), [desktopAudit, mobileAudit]);
  const fixFirstRows = useMemo(
    () => mergedPriorityRows(desktopAudit, mobileAudit, twins),
    [desktopAudit, mobileAudit, twins]
  );
  const filteredFindings =
    severityFilter === 'all'
      ? allFindings
      : allFindings.filter((f) => f.severity === severityFilter);

  const meta = session.seoMetadata;

  return (
    <div className="flex-1 overflow-y-auto print-flow bg-[#F8FAFC] print:bg-white">
      <div className="max-w-5xl mx-auto p-6 lg:p-8 space-y-6 print:p-0 print:max-w-none">
        {/* Executive Header & Export Actions */}
        {/* Title gets the full width; the export buttons wrap on their own row below it. */}
        <div className="flex flex-col gap-4 pb-5 border-b border-slate-200">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 font-medium mb-1">
              <span>
                On-page Vision Pro Executive Audit · {new Date(session.createdAt).toLocaleDateString()}
              </span>
              {session.auditGoal && session.auditGoal !== 'general' && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-slate-700 font-semibold capitalize">
                    Goal: {session.auditGoal.replace('-', ' ')}
                  </span>
                </>
              )}
              {session.targetKeyword && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono text-blue-700">KW: &ldquo;{session.targetKeyword}&rdquo;</span>
                </>
              )}
            </div>
            <h1 className="text-2xl lg:text-3xl font-bold text-slate-900 tracking-tight break-words [text-wrap:balance]">
              {session.pageTitle || session.domain}
            </h1>
            {session.url && (
              <p className="text-xs font-mono text-slate-500 mt-1 break-all">{session.url}</p>
            )}
          </div>

          <div className="no-print flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const overall = primaryAudit?.scores?.overall ?? 0;
                const deltaStr =
                  previousScoreDelta !== null && previousScoreDelta !== 0
                    ? ` (${previousScoreDelta > 0 ? `+${previousScoreDelta}` : previousScoreDelta} vs prev)`
                    : '';
                const s = primaryAudit?.scores;
                const fiveSec = primaryAudit?.first_impression_test;
                const topFixes = (primaryAudit?.items || [])
                  .filter((i) => i.severity !== 'info')
                  .slice(0, 3)
                  .map((i, idx) => `${idx + 1}. [${i.severity.toUpperCase()}] ${i.context}: ${i.suggested_optimization}`)
                  .join('\n');
                const digest = [
                  `${isFullPage ? 'On-Page Full-Page Audit' : 'On-Page First Impression Audit'}: ${session.domain}`,
                  `Health Score: ${overall}/100${deltaStr} | Clarity ${s?.clarity ?? 0} · Visual ${s?.visual_hierarchy ?? 0} · CRO ${s?.conversion ?? 0} · Trust ${s?.trust_eeat ?? 0}`,
                  fiveSec
                    ? `5-Second Test${isFullPage ? ' (first screen)' : ''}: ${fiveSec.passes_5s_test ? 'PASSES' : 'NEEDS CLARITY'}. ${fiveSec.visitor_understands}`
                    : '',
                  fiveSec?.single_biggest_lift ? `#1 Above-the-Fold Lift: ${fiveSec.single_biggest_lift}` : '',
                  topFixes ? `\nTop Priority Fixes:\n${topFixes}` : '',
                ]
                  .filter(Boolean)
                  .join('\n');
                navigator.clipboard?.writeText(digest).catch(() => {});
                setCopiedSummary(true);
                onCopySummaryNotice?.('Executive Slack / Email summary copied to clipboard.');
                setTimeout(() => setCopiedSummary(false), 2000);
              }}
              className="px-3 py-2 bg-white border border-slate-200 hover:border-blue-300 hover:bg-blue-50/40 text-slate-800 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
              title="Copy a crisp executive summary ready for Slack, Email, or Notion"
            >
              {copiedSummary ? (
                <Check size={13} className="text-emerald-600" />
              ) : (
                <ClipboardCopy size={13} className="text-blue-600" />
              )}
              {copiedSummary ? 'Summary Copied' : 'Copy Client Summary'}
            </button>
            {session.sourceType === 'url' && session.url && onReAudit && (
              <button
                type="button"
                onClick={onReAudit}
                className="px-3 py-2 bg-blue-50 border border-blue-200 hover:bg-blue-100 text-blue-700 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
              >
                <RefreshCw size={13} />
                Re-Audit URL
              </button>
            )}
            <button
              type="button"
              onClick={onExportPng}
              className="px-3 py-2 bg-white border border-slate-200 hover:border-slate-300 text-slate-700 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
            >
              <ImageIcon size={14} />
              Annotated PNG
            </button>
            <button
              type="button"
              onClick={onExportMarkdown}
              className="px-3 py-2 bg-white border border-slate-200 hover:border-slate-300 text-slate-700 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
            >
              <FileText size={14} />
              Markdown
            </button>
            <button
              type="button"
              onClick={onExportJson}
              className="px-3 py-2 bg-white border border-slate-200 hover:border-slate-300 text-slate-700 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
            >
              <FileJson size={14} />
              JSON
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Printer size={14} />
              Print / Save PDF
            </button>
          </div>
        </div>

        {/* Spoken Executive Audio Briefing */}
        <AudioBriefingBar
          briefing={session.audioBriefing}
          isGenerating={isGeneratingAudio}
          onGenerate={onGenerateAudio}
        />

        {/* Fix these first (full-page audits with a page-level ranking) and the audit stats line */}
        {/* One list for both devices: a problem ranked on desktop and mobile is one row with both labels. */}
        <FixFirstBlock
          rows={fixFirstRows}
          labelOf={(it) => labels.get(it.id) ?? ''}
          onJump={(it) => {
            const row = fixFirstRows.find((r) => r.item.id === it.id);
            onInspectFinding?.(row?.viewport ?? (session.viewports.desktop?.analysis?.items.some((x) => x.id === it.id) ? 'desktop' : 'mobile'), it.id);
          }}
        />
        {(['desktop', 'mobile'] as ViewportKey[]).map((key) => {
          const a = session.viewports[key]?.analysis;
          const line = a?.mode === 'fullpage' ? describeStats(a.stats) : '';
          return line ? (
            <p key={`stats-${key}`} className="text-[11px] text-slate-500 -mt-3">
              {key === 'desktop' ? 'Desktop' : 'Mobile'} full-page audit: {line}
            </p>
          ) : null;
        })}

        {/* KPI Scorecard Strip (both Desktop and Mobile when present) */}
        {primaryAudit && (
          <section className="space-y-3 break-inside-avoid">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div className="bg-slate-900 text-white rounded-xl p-4 border border-slate-900">
                <div className="flex items-center justify-between gap-1">
                  <p className="text-xs text-slate-300">
                    {desktopAudit && mobileAudit ? 'Desktop Health' : 'Overall Health'}
                  </p>
                  {previousScoreDelta !== null && previousScoreDelta !== 0 && (
                    <span
                      className={`inline-flex items-center gap-0.5 text-[11px] font-mono font-bold tabular-nums ${
                        previousScoreDelta > 0 ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {previousScoreDelta > 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                      {previousScoreDelta > 0 ? `+${previousScoreDelta}` : previousScoreDelta}
                    </span>
                  )}
                </div>
                <p className="text-3xl font-bold font-mono tabular-nums mt-1">
                  {primaryAudit.scores?.overall ?? 0}
                  <span className="text-xs font-normal text-slate-400">/100</span>
                </p>
              </div>
              {[
                { label: 'Content Clarity', score: primaryAudit.scores?.clarity ?? 0 },
                { label: 'Visual Hierarchy', score: primaryAudit.scores?.visual_hierarchy ?? 0 },
                { label: 'Conversion CRO', score: primaryAudit.scores?.conversion ?? 0 },
                { label: 'Trust & E-E-A-T', score: primaryAudit.scores?.trust_eeat ?? 0 },
              ].map((item) => (
                <div key={item.label} className="bg-white rounded-xl p-4 border border-slate-200">
                  <p className="text-xs text-slate-500">{item.label}</p>
                  <p className="text-2xl font-bold font-mono tabular-nums text-slate-900 mt-1">
                    {item.score}
                    <span className="text-xs font-normal text-slate-400">/100</span>
                  </p>
                </div>
              ))}
            </div>

            {desktopAudit && mobileAudit && (
              <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="flex flex-wrap items-center gap-4">
                  <span className="font-semibold text-slate-900">
                    Mobile Health: <span className="font-mono tabular-nums">{mobileAudit.scores?.overall ?? 0}/100</span>
                  </span>
                  <span className="text-slate-500 font-mono tabular-nums">
                    Clarity {mobileAudit.scores?.clarity ?? 0} · Visual {mobileAudit.scores?.visual_hierarchy ?? 0} · CRO {mobileAudit.scores?.conversion ?? 0} · Trust {mobileAudit.scores?.trust_eeat ?? 0}
                  </span>
                </div>
                {session.comparison && (
                  <span className="font-mono tabular-nums text-blue-700 font-semibold">
                    Responsive Parity: {session.comparison.parity_score}/100
                  </span>
                )}
              </div>
            )}
          </section>
        )}

        {/* 5-Second First Impression Test Verdict */}
        {primaryAudit?.first_impression_test && (
          <section className="bg-white border border-slate-200 rounded-xl p-5 grid grid-cols-1 md:grid-cols-3 gap-5 break-inside-avoid">
            <div className="space-y-1">
              <p className="text-xs font-semibold text-slate-500">
                5-Second Visitor Takeaway (
                <span
                  className={
                    primaryAudit.first_impression_test.passes_5s_test
                      ? 'text-emerald-700'
                      : 'text-amber-700'
                  }
                >
                  {primaryAudit.first_impression_test.passes_5s_test ? 'Passes' : 'Needs Clarity'}
                </span>
                )
              </p>
              <p className="text-xs text-slate-800 leading-relaxed">
                {primaryAudit.first_impression_test.visitor_understands}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-semibold text-slate-500">Primary Visual Distraction</p>
              <p className="text-xs text-slate-700 leading-relaxed">
                {primaryAudit.first_impression_test.primary_distraction}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-semibold text-blue-700">#1 Highest-ROI Above-the-Fold Lift</p>
              <p className="text-xs text-slate-900 font-medium leading-relaxed">
                {primaryAudit.first_impression_test.single_biggest_lift}
              </p>
            </div>
          </section>
        )}

        {/* Executive Summary & Quick Wins */}
        {primaryAudit && (
          <section className="grid grid-cols-1 lg:grid-cols-12 gap-5 break-inside-avoid">
            <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <h2 className="text-base font-bold text-slate-900">Executive Summary &amp; Strategy</h2>
              <p className="text-sm text-slate-700 leading-relaxed">
                {primaryAudit.overall_summary}
              </p>
              {primaryAudit.strategic_advisor && (
                <div className="pt-3 border-t border-slate-100">
                  <p className="text-xs font-semibold text-slate-500 mb-1.5">Strategic Growth Roadmap</p>
                  <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-line">
                    {primaryAudit.strategic_advisor}
                  </p>
                </div>
              )}
            </div>

            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4">
              <div>
                <h2 className="text-base font-bold text-slate-900 mb-3">Highest-ROI Quick Wins</h2>
                {primaryAudit.quick_wins.top_3.length > 0 ? (
                  <ol className="space-y-2.5 text-xs text-slate-700">
                    {primaryAudit.quick_wins.top_3.map((win, idx) => (
                      <li key={idx} className="flex items-start gap-2.5 leading-relaxed">
                        <span className="font-mono font-bold text-blue-600 shrink-0">0{idx + 1}.</span>
                        <span>{win}</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-xs text-slate-500">
                    Review the detailed findings table below for prioritized improvements.
                  </p>
                )}
              </div>

              {primaryScreenshot && (
                <div className="pt-3 border-t border-slate-100">
                  <p className="text-[11px] font-medium text-slate-500 mb-2">
                    {isFullPage ? 'Audited Page (top shown)' : 'Audited Hero Snapshot'}
                  </p>
                  <img
                    src={primaryScreenshot}
                    alt="Audited viewport"
                    className="w-full max-h-40 object-cover object-top rounded-lg border border-slate-200"
                  />
                </div>
              )}
            </div>
          </section>
        )}

        {/* Full Findings Table */}
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-bold text-slate-900">
              All Audit Findings ({filteredFindings.length})
            </h2>
            <div className="no-print inline-flex items-center gap-0.5 p-0.5 bg-slate-100 border border-slate-200 rounded-md">
              {(['all', 'critical', 'warning', 'info'] as const).map((sev) => (
                <button
                  key={sev}
                  type="button"
                  onClick={() => setSeverityFilter(sev)}
                  className={`px-2.5 py-1 text-xs font-medium rounded capitalize cursor-pointer ${
                    severityFilter === sev
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {sev}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-white border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="py-3 px-4 w-12 font-semibold">#</th>
                  <th className="py-3 px-4 w-28 font-semibold">Severity</th>
                  <th className="py-3 px-4 w-28 font-semibold">Viewport</th>
                  <th className="py-3 px-4 font-semibold">Diagnosis &amp; Fix</th>
                  <th className="py-3 px-4 w-20 text-right font-semibold">Impact</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {allFindings.map((item) => {
                  const hiddenByFilter = severityFilter !== 'all' && item.severity !== severityFilter;
                  return (
                  <tr
                    key={item.id}
                    className={`break-inside-avoid hover:bg-slate-50/50 ${hiddenByFilter ? 'hidden print:table-row' : ''}`}
                  >
                    <td
                      className="py-3.5 px-4 align-top font-mono text-slate-400 tabular-nums"
                      title="D = desktop, M = mobile. The number matches the box on that Canvas tab."
                    >
                      {labels.get(item.id)}
                    </td>
                    <td className="py-3.5 px-4 align-top">
                      <span className="inline-flex items-center gap-1.5 font-semibold capitalize">
                        {item.severity === 'critical' ? (
                          <AlertCircle size={13} className="text-red-600" />
                        ) : item.severity === 'warning' ? (
                          <AlertTriangle size={13} className="text-amber-600" />
                        ) : (
                          <Info size={13} className="text-blue-600" />
                        )}
                        <span
                          className={
                            item.severity === 'critical'
                              ? 'text-red-700'
                              : item.severity === 'warning'
                              ? 'text-amber-700'
                              : 'text-blue-700'
                          }
                        >
                          {item.severity}
                        </span>
                      </span>
                    </td>
                    <td className="py-3.5 px-4 align-top text-slate-600 capitalize">
                      {item.viewport} · {item.category}
                    </td>
                    <td className="py-3.5 px-4 align-top space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-semibold text-slate-900">{item.context}</p>
                        {onInspectFinding && (
                          <button
                            type="button"
                            onClick={() => onInspectFinding(item.viewport, item.id)}
                            className="no-print text-[11px] font-semibold text-blue-600 hover:text-blue-800 inline-flex items-center gap-0.5 shrink-0 cursor-pointer"
                          >
                            Inspect on Canvas
                            <ArrowUpRight size={11} />
                          </button>
                        )}
                      </div>
                      <p className="text-slate-700 leading-relaxed">{item.seo_analysis}</p>
                      {item.technical_details && (
                        <p className="font-mono text-[11px] text-slate-500">
                          {item.technical_details}
                        </p>
                      )}
                      <p className="text-slate-800 bg-slate-50 border border-slate-200 rounded p-2 leading-relaxed">
                        <span className="font-semibold">Recommended Fix: </span>
                        {item.suggested_optimization}
                      </p>
                    </td>
                    <td className="py-3.5 px-4 align-top text-right font-mono font-bold tabular-nums text-slate-900">
                      {item.impact_score}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* Saved Full-Hero AI Redesigns (Embedded in Report & Printable PDF) */}
        {session.heroRedesigns.length > 0 && (
          <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Layers size={15} className="text-blue-600" />
                Saved Full-Hero AI Redesign Concepts ({session.heroRedesigns.length})
              </h2>
              <span className="text-xs text-slate-500">Before vs. AI Concept</span>
            </div>
            <div className="space-y-5">
              {session.heroRedesigns.slice(0, 3).map((item, idx) => {
                const origSrc = item.originalDataUrl || session.viewports[item.viewport]?.screenshotDataUrl;
                const isMobileConcept = item.viewport === 'mobile';
                return (
                <div
                  key={item.id}
                  className="border border-slate-200 rounded-lg overflow-hidden break-inside-avoid"
                >
                  <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-800">
                      Concept #{idx + 1} · {item.viewport}{item.modelUsed ? ` · ${item.modelUsed}` : ''}
                    </span>
                    <span className="text-slate-500 truncate max-w-md">{item.prompt}</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-200">
                    <div className="p-3 space-y-1.5">
                      <p className="text-[11px] font-semibold text-slate-500">Original Capture</p>
                      {origSrc && (
                        <img
                          src={origSrc}
                          alt="Original hero"
                          className={`${isMobileConcept ? 'w-[200px] mx-auto aspect-[9/16]' : 'w-full aspect-video'} object-cover object-top rounded border border-slate-200`}
                        />
                      )}
                    </div>
                    <div className="p-3 space-y-1.5">
                      <p className="text-[11px] font-semibold text-blue-700">AI Redesigned Hero</p>
                      <img
                        src={item.redesignedDataUrl}
                        alt="AI redesigned hero"
                        className={`${isMobileConcept ? 'w-[200px] mx-auto aspect-[9/16]' : 'w-full aspect-video'} object-cover object-top rounded border border-slate-200`}
                      />
                    </div>
                  </div>
                </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Saved A/B Copy Lab Variants (Embedded in Report & Printable PDF) */}
        {session.copyVariants.length > 0 && (
          <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <FileEdit size={15} className="text-blue-600" />
              A/B Hero Copy Test Variants ({session.copyVariants.length})
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {session.copyVariants.map((variant, idx) => (
                <div
                  key={variant.id}
                  className="border border-slate-200 rounded-lg p-4 space-y-2.5 bg-slate-50/50 break-inside-avoid"
                >
                  <p className="text-[11px] font-semibold text-blue-700">
                    0{idx + 1}. {variant.angle}
                  </p>
                  <p className="text-sm font-bold text-slate-900 leading-snug">{variant.headline}</p>
                  <p className="text-xs text-slate-600 leading-relaxed">{variant.subheadline}</p>
                  <p className="text-xs font-semibold text-slate-800 pt-1">
                    CTA: <span className="text-blue-700">{variant.primary_cta}</span>
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Print-Safe SERP & Competitor Intelligence Summary */}
        {session.serpResearch && (
          <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Globe size={15} className="text-blue-600" />
                Live SERP &amp; Competitor Intelligence
              </h2>
              {session.serpResearch.search_intent && (
                <span className="text-[11px] font-medium text-blue-800 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded">
                  {session.serpResearch.search_intent}
                </span>
              )}
            </div>
            <p className="text-xs text-slate-700 leading-relaxed">{session.serpResearch.positioning_verdict}</p>
            {session.serpResearch.competitors.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 text-slate-500">
                    <tr>
                      <th className="py-2 pr-3 font-semibold">Competitor</th>
                      <th className="py-2 px-3 font-semibold">Hero Value Hook</th>
                      <th className="py-2 pl-3 font-semibold">Where You Can Win</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {session.serpResearch.competitors.map((comp, idx) => (
                      <tr key={idx} className="break-inside-avoid">
                        <td className="py-2.5 pr-3 align-top font-semibold text-slate-900 whitespace-nowrap">
                          {comp.name}
                          {comp.grounded_domain_match === false && (
                            <span className="ml-1 text-[10px] font-normal text-slate-500">(Indirect source)</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 align-top text-slate-700">{comp.value_prop_hook}</td>
                        <td className="py-2.5 pl-3 align-top text-slate-800">{comp.opportunity_gap}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {session.serpResearch.ai_overview_geo_gaps && session.serpResearch.ai_overview_geo_gaps.length > 0 && (
              <div className="pt-2 border-t border-slate-100">
                <p className="text-xs font-semibold text-slate-700 mb-1.5">AI Overview &amp; GEO Gaps</p>
                <ul className="list-disc pl-4 space-y-1 text-xs text-slate-700">
                  {session.serpResearch.ai_overview_geo_gaps.map((g, i) => (
                    <li key={i}>{g}</li>
                  ))}
                </ul>
              </div>
            )}
            {session.serpResearch.sources.length > 0 && (
              <p className="text-[11px] text-slate-500 pt-1">
                <span className="font-semibold text-slate-700">Grounding sources: </span>
                {session.serpResearch.sources.map((s) => s.title).join(', ')}
              </p>
            )}
          </section>
        )}

        {/* Live Google SERP Snippet & OpenGraph Social Card Preview */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-5 break-inside-avoid">
          {/* Google SERP Preview */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Globe size={15} className="text-blue-600" />
                Live Google Search Snippet Preview
              </h2>
              <span className="text-[11px] font-mono tabular-nums text-slate-500">
                Title {meta.title?.length || 0}/60 · Desc {meta.description?.length || 0}/155
              </span>
            </div>
            <div className="p-4 rounded-lg border border-slate-200 bg-white space-y-1">
              <div className="flex items-center gap-2 text-xs text-slate-600">
                <div className="w-5 h-5 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center text-[10px] font-bold text-slate-700 uppercase">
                  {(session.domain || 'W').slice(0, 1)}
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-slate-800 truncate">{session.domain}</p>
                  <p className="text-[11px] text-slate-500 truncate">
                    {session.url || `https://${session.domain}`}
                  </p>
                </div>
              </div>
              <p className="text-base font-medium text-[#1a0dab] leading-snug pt-0.5">
                {(meta.title || session.domain).slice(0, 62)}
                {(meta.title?.length || 0) > 62 ? '...' : ''}
              </p>
              <p className="text-xs text-[#4d5156] leading-relaxed">
                {meta.description
                  ? `${meta.description.slice(0, 158)}${meta.description.length > 158 ? '...' : ''}`
                  : 'No meta description detected, so Google will auto-generate a snippet from page body copy.'}
              </p>
            </div>
            {(meta.title?.length || 0) > 60 && (
              <p className="text-[11px] text-amber-700">
                Title exceeds 60 chars and may truncate in Google SERPs.
              </p>
            )}
          </div>

          {/* OpenGraph Social Share Card Preview */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Share2 size={15} className="text-slate-600" />
                OpenGraph Social Link Preview
              </h2>
              <span className="text-[11px] text-slate-500">
                {meta.ogImage ? 'og:image present' : 'Missing og:image'}
              </span>
            </div>
            <div className="rounded-lg border border-slate-200 overflow-hidden bg-slate-50">
              {meta.ogImage ? (
                <img
                  src={meta.ogImage}
                  alt="OpenGraph preview"
                  className="w-full h-32 object-cover border-b border-slate-200 bg-slate-100"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = 'none';
                  }}
                />
              ) : (
                <div className="w-full h-24 bg-slate-100 border-b border-slate-200 flex items-center justify-center text-xs text-slate-400">
                  No og:image tag detected (social shares will lack a rich card preview)
                </div>
              )}
              <div className="p-3 space-y-0.5">
                <p className="text-[10px] uppercase tracking-wide text-slate-500 font-mono">
                  {session.domain}
                </p>
                <p className="text-xs font-bold text-slate-900 truncate">
                  {meta.ogTitle || meta.title || session.domain}
                </p>
                <p className="text-[11px] text-slate-600 line-clamp-2">
                  {meta.ogDescription || meta.description || 'No og:description tag detected.'}
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Extracted On-Page Technical SEO, Deterministic WCAG 2.2, Lab CWV & AI-Search (GEO) */}
        <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-5">
          <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
            <Database size={15} className="text-slate-500" />
            Technical On-Page SEO, WCAG 2.2, Lab CWV &amp; GEO Telemetry
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3 text-xs">
            <div className="flex justify-between py-2 border-b border-slate-100">
              <span className="text-slate-500">Title Tag Length</span>
              <span className="font-mono tabular-nums font-semibold text-slate-900">
                {meta.title?.length || 0} chars
              </span>
            </div>
            <div className="flex justify-between py-2 border-b border-slate-100">
              <span className="text-slate-500">Meta Description Length</span>
              <span className="font-mono tabular-nums font-semibold text-slate-900">
                {meta.description?.length || 0} chars
              </span>
            </div>
            <div className="flex justify-between py-2 border-b border-slate-100">
              <span className="text-slate-500">H1 Headings Found</span>
              <span
                className={`font-mono tabular-nums font-semibold ${
                  (meta.telemetry?.renderedH1Count ?? meta.h1s?.length ?? 0) === 1 ? 'text-emerald-700' : 'text-amber-700'
                }`}
              >
                {meta.telemetry?.renderedH1Count ?? meta.h1s?.length ?? 0}{' '}
                {(meta.telemetry?.renderedH1Count ?? meta.h1s?.length ?? 0) === 1 ? '(Optimal)' : '(Check H1 count)'}
              </span>
            </div>
            <div className="flex justify-between py-2 border-b border-slate-100">
              <span className="text-slate-500">Images Missing Alt Text</span>
              <span className="font-mono tabular-nums font-semibold text-slate-900">
                {meta.missingAltImages} / {meta.totalImages}
                {meta.telemetry && meta.telemetry.brokenImages > 0 ? ` (${meta.telemetry.brokenImages} broken)` : ''}
              </span>
            </div>
            <div className="flex justify-between py-2 border-b border-slate-100">
              <span className="text-slate-500">Canonical URL</span>
              <span className="font-mono text-slate-800 truncate max-w-[220px] inline-flex items-center gap-1">
                {meta.canonical ? (
                  <>
                    <CheckCircle2 size={12} className="text-emerald-600 shrink-0" />
                    Present
                  </>
                ) : (
                  'Not detected'
                )}
              </span>
            </div>
            <div className="flex justify-between py-2 border-b border-slate-100">
              <span className="text-slate-500">Word Count</span>
              <span className="font-mono tabular-nums font-semibold text-slate-900">
                {meta.telemetry?.renderedWordCount ?? meta.wordCount}
                {meta.telemetry?.spaHydratedDiff ? ' (SPA hydrated)' : ''}
              </span>
            </div>
            <div className="flex justify-between py-2 border-b border-slate-100">
              <span className="text-slate-500">JSON-LD Structured Data</span>
              <span className="font-mono text-slate-900 truncate max-w-[260px]">
                {meta.schemaTypes && meta.schemaTypes.length > 0
                  ? meta.schemaTypes.join(', ')
                  : 'None detected'}
                {meta.telemetry && meta.telemetry.jsonLdErrors > 0 ? ` (${meta.telemetry.jsonLdErrors} invalid)` : ''}
              </span>
            </div>
            <div className="flex justify-between py-2 border-b border-slate-100">
              <span className="text-slate-500">Mobile Viewport Meta</span>
              <span className="font-mono text-slate-800 inline-flex items-center gap-1">
                {meta.viewportMeta ? (
                  <>
                    <CheckCircle2 size={12} className="text-emerald-600 shrink-0" />
                    Configured
                  </>
                ) : (
                  'Not detected'
                )}
              </span>
            </div>
            {meta.telemetry && (
              <>
                <div className="flex justify-between py-2 border-b border-slate-100">
                  <span className="text-slate-500">WCAG 2.2 Contrast (solid bg)</span>
                  <span className={`font-mono tabular-nums font-semibold ${meta.telemetry.contrastFailures.length > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
                    {meta.telemetry.contrastFailures.length > 0
                      ? `${meta.telemetry.contrastFailures.length} failing`
                      : '0 failing'}
                    {meta.telemetry.contrastUnresolvedCount > 0 ? ` (${meta.telemetry.contrastUnresolvedCount} over img/grad)` : ''}
                  </span>
                </div>
                <div className="flex justify-between py-2 border-b border-slate-100">
                  <span className="text-slate-500">Tap Targets (&lt;24px / Mobile &lt;44px)</span>
                  <span className={`font-mono tabular-nums font-semibold ${(meta.telemetry.mobileSmallTapTargets24 ?? meta.telemetry.smallTapTargets24) > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
                    {meta.telemetry.mobileSmallTapTargets24 ?? meta.telemetry.smallTapTargets24} / {meta.telemetry.mobileSmallTapTargets44 ?? meta.telemetry.smallTapTargets44}
                  </span>
                </div>
                {meta.telemetry.cwv && (
                  <div className="flex justify-between py-2 border-b border-slate-100">
                    <span className="text-slate-500">Lab CWV (proxied, directional)</span>
                    <span className="font-mono tabular-nums text-slate-900">
                      LCP {meta.telemetry.cwv.lcpMs ?? 'n/a'}ms · CLS {meta.telemetry.cwv.cls ?? 'n/a'} · TTFB {meta.telemetry.cwv.ttfbMs ?? 'n/a'}ms
                    </span>
                  </div>
                )}
                {meta.telemetry.origin && (
                  <div className="flex justify-between py-2 border-b border-slate-100">
                    <span className="text-slate-500">robots.txt &amp; AI Crawlers</span>
                    <span className="font-mono text-slate-900 truncate max-w-[260px]">
                      {(() => {
                        const blocked = meta.telemetry.origin.aiBots.filter((b) => b.allowed === false).map((b) => b.bot);
                        if (!meta.telemetry.origin.robotsTxtPresent) return 'No robots.txt';
                        return blocked.length > 0
                          ? `Blocks ${blocked.join(', ')}`
                          : `Allows major bots (${meta.telemetry.origin.sitemapCount} sitemaps)`;
                      })()}
                    </span>
                  </div>
                )}
                <div className="flex justify-between py-2 border-b border-slate-100">
                  <span className="text-slate-500">HTML Landmarks &amp; Lang</span>
                  <span className="font-mono text-slate-900">
                    lang={meta.telemetry.lang || 'missing'}
                    {meta.telemetry.missingLandmarks.length > 0 ? ` · missing ${meta.telemetry.missingLandmarks.join(', ')}` : ' · landmarks ok'}
                  </span>
                </div>
                {meta.telemetry.origin && (
                  <div className="flex justify-between py-2 border-b border-slate-100">
                    <span className="text-slate-500">llms.txt (optional GEO file)</span>
                    <span className="font-mono text-slate-700">
                      {meta.telemetry.origin.llmsTxtPresent ? 'Present' : 'Not detected (optional)'}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>

          {meta.telemetry && (meta.telemetry.contrastFailures.length > 0 || meta.telemetry.headingOrderIssues.length > 0 || meta.telemetry.unlabelledInputs > 0) && (
            <details className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-3">
              <summary className="font-semibold text-slate-800 cursor-pointer">
                Detailed Deterministic Checks ({meta.telemetry.contrastFailures.length + meta.telemetry.headingOrderIssues.length + (meta.telemetry.unlabelledInputs > 0 ? 1 : 0)} items)
              </summary>
              <div className="mt-2 space-y-1.5 text-slate-700">
                {meta.telemetry.headingOrderIssues.map((h, i) => (
                  <p key={`ho-${i}`}>Heading: {h}</p>
                ))}
                {meta.telemetry.unlabelledInputs > 0 && (
                  <p>Forms: {meta.telemetry.unlabelledInputs} of {meta.telemetry.formFieldCount} visible inputs have no accessible label.</p>
                )}
                {meta.telemetry.contrastFailures.map((c, i) => (
                  <p key={`cf-${i}`} className="font-mono text-[11px]">
                    Contrast {c.ratio}:1 (need {c.required}:1): &ldquo;{c.text}&rdquo; ({c.fg} on {c.bg})
                  </p>
                ))}
              </div>
            </details>
          )}

          {/* Heading Hierarchy Outline */}
          {meta.headingTree && meta.headingTree.length > 0 && (
            <div className="pt-2 border-t border-slate-100">
              <p className="text-xs font-semibold text-slate-700 flex items-center gap-1.5 mb-2.5">
                <Code2 size={13} className="text-slate-500" />
                Document Heading Hierarchy (H1 to H3)
              </p>
              <div className="space-y-1.5 bg-slate-50 border border-slate-200 rounded-lg p-3 max-h-52 overflow-y-auto print:max-h-none print:overflow-visible">
                {meta.headingTree.map((node, i) => (
                  <div
                    key={i}
                    style={{ paddingLeft: `${(node.level - 1) * 16}px` }}
                    className="flex items-baseline gap-2 text-xs"
                  >
                    <span
                      className={`font-mono text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${
                        node.level === 1
                          ? 'bg-blue-100 text-blue-800'
                          : node.level === 2
                          ? 'bg-slate-200 text-slate-700'
                          : 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      H{node.level}
                    </span>
                    <span className="text-slate-800 truncate">{node.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
