import React, { useState } from 'react';
import {
  Search,
  ExternalLink,
  RefreshCw,
  Loader2,
  Globe,
  Target,
  ShieldCheck,
  Compass,
  Columns,
  X,
} from 'lucide-react';
import type { SerpCompetitor, SerpResearchResult } from '../types';

interface SerpIntelWorkspaceProps {
  domain: string;
  url: string;
  yourScreenshot: string | null;
  yourSpec?: string;
  research: SerpResearchResult | null;
  isLoading: boolean;
  capturingCompUrl: string | null;
  onRunResearch: () => void;
  onCaptureCompetitor: (competitorUrl: string) => void;
}

export const SerpIntelWorkspace: React.FC<SerpIntelWorkspaceProps> = ({
  domain,
  url,
  yourScreenshot,
  yourSpec,
  research,
  isLoading,
  capturingCompUrl,
  onRunResearch,
  onCaptureCompetitor,
}) => {
  const [selectedCompName, setSelectedCompName] = useState<string | null>(null);
  const selectedComp: SerpCompetitor | null =
    selectedCompName === '__closed__'
      ? null
      : research?.competitors.find((c) => c.name === selectedCompName && c.capturedScreenshot) ||
        research?.competitors.find((c) => Boolean(c.capturedScreenshot)) ||
        null;
  return (
    <div className="flex-1 overflow-y-auto bg-[#F8FAFC]">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-slate-900">
              Live SERP &amp; Competitor Intelligence
            </h2>
            <p className="text-xs text-slate-600 mt-0.5">
              Real-time Google Search grounding and URL context benchmarking for <span className="font-mono text-slate-800">{domain}</span>
            </p>
          </div>
          {/* Empty state has its own button; this one appears once there is something to refresh. */}
          {(research || isLoading) && (
          <button
            type="button"
            onClick={onRunResearch}
            disabled={isLoading}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-semibold rounded-lg flex items-center gap-2 transition-colors whitespace-nowrap cursor-pointer"
          >
            {isLoading ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Searching Live SERPs...
              </>
            ) : research ? (
              <>
                <RefreshCw size={14} />
                Refresh Market Intel
              </>
            ) : (
              <>
                <Search size={14} />
                Run Live SERP Research
              </>
            )}
          </button>
          )}
        </div>

        {!research && !isLoading ? (
          <div className="bg-white border border-slate-200 rounded-xl p-10 text-center max-w-2xl mx-auto space-y-4">
            <div className="w-11 h-11 rounded-lg bg-blue-50 border border-blue-100 mx-auto flex items-center justify-center text-blue-600">
              <Globe size={20} />
            </div>
            <div className="space-y-1.5">
              <h3 className="text-base font-bold text-slate-900">
                Benchmark against real search competitors
              </h3>
              <p className="text-sm text-slate-600 leading-relaxed max-w-lg mx-auto">
                Uses Gemini with live Google Search grounding to identify direct SERP competitors for {url || domain}, compare hero positioning hooks, surface keyword &amp; E-E-A-T gaps, and cite real web sources.
              </p>
            </div>
            <button
              type="button"
              onClick={onRunResearch}
              className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg inline-flex items-center gap-2 transition-colors cursor-pointer"
            >
              <Search size={15} />
              Launch Live Competitor Research
            </button>
          </div>
        ) : isLoading && !research ? (
          <div className="bg-white border border-slate-200 rounded-xl p-12 text-center space-y-3">
            <Loader2 size={26} className="mx-auto text-blue-600 animate-spin" />
            <p className="text-sm font-semibold text-slate-900">
              Querying live search results and analyzing competitors...
            </p>
            <p className="text-xs text-slate-500">
              Gathering real competitor positioning hooks, E-E-A-T signals, and verified citations.
            </p>
          </div>
        ) : research ? (
          <div className="space-y-6">
            {/* Positioning Overview */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <p className="text-xs font-semibold text-slate-500 mb-1.5">Market Category &amp; Buyer Intent</p>
                <p className="text-sm text-slate-800 leading-relaxed">{research.niche_summary}</p>
                {research.search_intent && (
                  <p className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-medium text-blue-800 bg-blue-50 border border-blue-200 rounded-md px-2 py-1">
                    <span className="font-semibold">Search Intent:</span>
                    <span>{research.search_intent}</span>
                  </p>
                )}
              </div>
              <div>
                <p className="text-xs font-semibold text-slate-500 mb-1.5">Competitive Positioning Verdict</p>
                <p className="text-sm text-slate-800 leading-relaxed">{research.positioning_verdict}</p>
              </div>
            </div>

            {/* Head-to-Head Visual Competitor Split (when any competitor is captured) */}
            {selectedComp && selectedComp.capturedScreenshot && yourScreenshot && (
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-900 text-white flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Columns size={15} className="text-blue-400" />
                    <h3 className="text-sm font-semibold">
                      Head-to-Head Hero Split: {domain} vs. {selectedComp.name}
                    </h3>
                  </div>
                  <div className="flex items-center gap-2">
                    {research.competitors
                      .filter((c) => c.capturedScreenshot)
                      .map((c) => (
                        <button
                          key={c.name}
                          type="button"
                          onClick={() => setSelectedCompName(c.name)}
                          className={`px-2.5 py-1 text-xs font-medium rounded cursor-pointer transition-colors ${
                            selectedComp.name === c.name
                              ? 'bg-blue-600 text-white'
                              : 'bg-slate-800 text-slate-300 hover:text-white'
                          }`}
                        >
                          {c.name}
                        </button>
                      ))}
                    <button
                      type="button"
                      onClick={() => setSelectedCompName('__closed__')}
                      className="p-1 text-slate-400 hover:text-white cursor-pointer"
                      aria-label="Close visual split"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
                  <div className="p-4 space-y-2.5 bg-[#F8FAFC]">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-slate-900">Your Page ({domain})</span>
                      <span className="font-mono text-slate-500">{yourSpec || 'First screen'}</span>
                    </div>
                    <img
                      src={yourScreenshot}
                      alt={`${domain} hero`}
                      className="w-full aspect-video object-cover object-top rounded-lg border border-slate-300 bg-white shadow-xs"
                    />
                  </div>
                  <div className="p-4 space-y-2.5 bg-[#F8FAFC]">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-slate-900">Rival: {selectedComp.name}</span>
                      <span className="font-mono text-slate-500 truncate max-w-[260px]">
                        {selectedComp.url.replace(/^https?:\/\//, '')}
                        {selectedComp.capturedInfo &&
                          ` · ${selectedComp.capturedInfo.width}×${selectedComp.capturedInfo.height} via ${selectedComp.capturedInfo.provider}`}
                      </span>
                    </div>
                    <img
                      src={selectedComp.capturedScreenshot}
                      alt={`${selectedComp.name} hero`}
                      className="w-full aspect-video object-cover object-top rounded-lg border border-slate-300 bg-white shadow-xs"
                    />
                  </div>
                </div>

                <div className="px-5 py-3.5 border-t border-slate-200 bg-white grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                  <div>
                    <span className="font-semibold text-slate-700">Rival Positioning Hook: </span>
                    <span className="text-slate-600">{selectedComp.value_prop_hook}</span>
                  </div>
                  <div>
                    <span className="font-semibold text-blue-700">Where You Can Win: </span>
                    <span className="text-slate-800 font-medium">{selectedComp.opportunity_gap}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Competitor Benchmark Table */}
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50/70 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">
                  SERP Competitor Matrix ({research.competitors.length})
                </h3>
                <span className="text-xs text-slate-500 font-mono">
                  Updated {new Date(research.generated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-white border-b border-slate-200 text-slate-500">
                    <tr>
                      <th className="py-3 px-4 font-semibold">Competitor</th>
                      <th className="py-3 px-4 font-semibold">Hero Value Hook</th>
                      <th className="py-3 px-4 font-semibold">Key Strength</th>
                      <th className="py-3 px-4 font-semibold">Where You Can Win</th>
                      <th className="py-3 px-4 font-semibold text-right">Visual Split</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {research.competitors.map((comp, idx) => {
                      const isCapturingThis = Boolean(comp.url && capturingCompUrl === comp.url);
                      return (
                        <tr key={idx} className="hover:bg-slate-50/60">
                          <td className="py-3.5 px-4 align-top whitespace-nowrap">
                            <div className="flex items-center gap-1.5">
                              <p className="font-semibold text-slate-900">{comp.name}</p>
                              {comp.grounded_domain_match === false && (
                                <span
                                  className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-[10px] font-medium text-slate-600"
                                  title="Surfaced from live search context, though this exact domain was not one of the direct grounding source URLs"
                                >
                                  Indirect source
                                </span>
                              )}
                            </div>
                            {comp.url && (
                              <a
                                href={comp.url.startsWith('http') ? comp.url : `https://${comp.url}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[11px] font-mono text-blue-600 hover:underline inline-flex items-center gap-1 mt-0.5"
                              >
                                {comp.url.replace(/^https?:\/\//, '').slice(0, 28)}
                                <ExternalLink size={10} />
                              </a>
                            )}
                          </td>
                          <td className="py-3.5 px-4 align-top text-slate-700 leading-relaxed">
                            {comp.value_prop_hook}
                          </td>
                          <td className="py-3.5 px-4 align-top text-slate-600 leading-relaxed">
                            {comp.strength}
                          </td>
                          <td className="py-3.5 px-4 align-top text-slate-900 font-medium leading-relaxed">
                            {comp.opportunity_gap}
                          </td>
                          <td className="py-3.5 px-4 align-top text-right whitespace-nowrap">
                            {comp.url && (
                              <button
                                type="button"
                                disabled={isCapturingThis}
                                onClick={() => {
                                  setSelectedCompName(comp.name);
                                  if (!comp.capturedScreenshot) {
                                    onCaptureCompetitor(comp.url);
                                  }
                                }}
                                className={`px-2.5 py-1.5 rounded-md text-[11px] font-semibold border transition-colors inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap disabled:opacity-50 ${
                                  comp.capturedScreenshot
                                    ? 'bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100'
                                    : 'bg-white border-slate-200 text-slate-700 hover:border-blue-400 hover:text-blue-600'
                                }`}
                              >
                                {isCapturingThis ? (
                                  <Loader2 size={12} className="animate-spin" />
                                ) : (
                                  <Columns size={12} />
                                )}
                                {isCapturingThis
                                  ? 'Capturing...'
                                  : comp.capturedScreenshot
                                  ? 'View Split'
                                  : 'Capture Hero'}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Gaps & Differentiators 3-Column Strip */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              <div className="bg-white border border-slate-200 rounded-xl p-5">
                <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2 mb-3">
                  <Target size={15} className="text-blue-600" />
                  Keyword &amp; Intent Gaps
                </h3>
                <ul className="space-y-2.5 text-xs text-slate-700">
                  {research.keyword_opportunities.map((kw, i) => (
                    <li key={i} className="pb-2 border-b border-slate-100 last:border-0 last:pb-0 leading-relaxed">
                      {kw}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-5">
                <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2 mb-3">
                  <ShieldCheck size={15} className="text-amber-600" />
                  E-E-A-T &amp; Trust Gaps
                </h3>
                <ul className="space-y-2.5 text-xs text-slate-700">
                  {research.eeat_gaps.map((gap, i) => (
                    <li key={i} className="pb-2 border-b border-slate-100 last:border-0 last:pb-0 leading-relaxed">
                      {gap}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-5">
                <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2 mb-3">
                  <Compass size={15} className="text-emerald-600" />
                  Quick Differentiators
                </h3>
                <ul className="space-y-2.5 text-xs text-slate-700">
                  {research.quick_differentiators.map((diff, i) => (
                    <li key={i} className="pb-2 border-b border-slate-100 last:border-0 last:pb-0 leading-relaxed">
                      {diff}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {research.ai_overview_geo_gaps && research.ai_overview_geo_gaps.length > 0 && (
              <div className="bg-white border border-slate-200 rounded-xl p-5">
                <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2 mb-3">
                  <Globe size={15} className="text-violet-600" />
                  AI Overview &amp; GEO Citability Gaps
                </h3>
                <ul className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs text-slate-700">
                  {research.ai_overview_geo_gaps.map((gap, i) => (
                    <li key={i} className="p-3 rounded-lg bg-slate-50 border border-slate-200/80 leading-relaxed">
                      {gap}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Google Search Grounding Attribution & Executed Queries */}
            {(research.search_entry_point_html || (research.web_search_queries && research.web_search_queries.length > 0) || research.sources.length > 0) && (
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                {research.web_search_queries && research.web_search_queries.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold text-slate-500 mb-2">
                      Executed Google Search Queries ({research.web_search_queries.length})
                    </h3>
                    <div className="flex flex-wrap gap-1.5">
                      {research.web_search_queries.map((q, idx) => (
                        <span
                          key={idx}
                          className="px-2.5 py-1 rounded-full bg-slate-100 border border-slate-200 text-[11px] font-mono text-slate-700"
                        >
                          {q}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {research.search_entry_point_html && (
                  <div className="no-print">
                    <iframe
                      srcDoc={research.search_entry_point_html}
                      sandbox="allow-popups allow-popups-to-escape-sandbox"
                      title="Google Search grounding suggestions"
                      className="w-full h-14 border-0 rounded-lg bg-slate-50"
                    />
                  </div>
                )}

                {research.sources.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold text-slate-500 mb-3">
                      Verified Search Grounding Sources ({research.sources.length})
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                      {research.sources.map((src, idx) => (
                        <a
                          key={idx}
                          href={src.uri}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-slate-200 hover:border-blue-400 hover:bg-blue-50/40 text-xs text-slate-700 transition-colors"
                        >
                          <span className="truncate font-medium">{src.title}</span>
                          <ExternalLink size={12} className="shrink-0 text-slate-400" />
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
};
