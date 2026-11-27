import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Wand2,
  Loader2,
  Download,
  Check,
  AlertCircle,
  RefreshCw,
  Layers,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { ApiError, generateVisualRedesign, isAbortError } from '../services/apiClient';
import type { HeroRedesignItem, ViewportKey } from '../types';

export interface RedesignModalTarget {
  mode: 'element' | 'full-hero';
  imageDataUrl: string;
  context: string;
  suggestion?: string;
  viewport: ViewportKey;
  topIssues?: string[];
  boxPct?: { x: number; y: number; w: number; h: number };
}

interface RedesignStudioModalProps {
  target: RedesignModalTarget | null;
  savedHeroRedesigns: HeroRedesignItem[];
  onClose: () => void;
  onApplyElementOverlay: (dataUrl: string, prompt: string, boxPct: { x: number; y: number; w: number; h: number }) => void;
  onSaveHeroRedesign: (item: HeroRedesignItem) => void;
  onDeleteHeroRedesign?: (id: string) => void;
}

const ELEMENT_PRESETS = [
  {
    id: 'audit-fix',
    label: 'Apply Audit Fix',
    prompt: 'Implement the exact conversion and accessibility optimization recommended for this element.',
  },
  {
    id: 'contrast',
    label: 'Fix WCAG Contrast',
    prompt: 'Increase foreground-to-background color contrast to comfortably exceed WCAG AA 4.5:1 while keeping modern visual polish.',
  },
  {
    id: 'cta',
    label: 'Sharpen CTA',
    prompt: 'Redesign this call-to-action button with higher visual prominence, crisp action-driven typography, and strong visual hierarchy.',
  },
  {
    id: 'modernize',
    label: 'Modern Studio UI',
    prompt: 'Modernize this UI block with refined typography, balanced spacing, crisp 1px borders, and clear visual hierarchy.',
  },
];

const HERO_PRESETS = [
  {
    id: 'conversion-overhaul',
    label: 'High-Converting Overhaul',
    prompt:
      'Redesign the entire hero section with a crystal-clear benefit headline, concise subheadline, high-contrast primary CTA above the fold, visible customer trust logos, and clean modern Swiss-grid spacing.',
  },
  {
    id: 'minimal-editorial',
    label: 'Crisp Minimal Editorial',
    prompt:
      'Transform the hero into an authoritative, ultra-clean light editorial design with strong typographic contrast, generous whitespace, and a focused single primary CTA.',
  },
  {
    id: 'enterprise-trust',
    label: 'Enterprise Authority',
    prompt:
      'Elevate the hero to enterprise B2B polish with structured product preview visual, crisp social proof bar, security/trust signals, and high-clarity value framing.',
  },
];

export const RedesignStudioModal: React.FC<RedesignStudioModalProps> = ({
  target,
  savedHeroRedesigns,
  onClose,
  onApplyElementOverlay,
  onSaveHeroRedesign,
  onDeleteHeroRedesign,
}) => {
  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [generatedDataUrl, setGeneratedDataUrl] = useState<string | null>(null);
  const [usedModel, setUsedModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 'rephrase': the model answered but made no image (422). Its message tells the user what to change.
  const [errorKind, setErrorKind] = useState<'failed' | 'rephrase'>('failed');
  const [scale, setScale] = useState(1);
  const [sliderPos, setSliderPos] = useState(50);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!isGenerating) {
      setElapsedSec(0);
      return;
    }
    const started = Date.now();
    const t = window.setInterval(() => setElapsedSec(Math.floor((Date.now() - started) / 1000)), 500);
    return () => window.clearInterval(t);
  }, [isGenerating]);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsGenerating(false);
    if (!target) return;
    setError(null);
    setScale(1);
    setSliderPos(50);
    setGeneratedDataUrl(null);
    setUsedModel(null);
    if (target.mode === 'full-hero') {
      setPrompt(
        target.suggestion ||
          'Redesign the above-the-fold hero to fix critical conversion blockers: sharpen the headline clarity, elevate CTA contrast, reduce clutter, and surface trust proof cleanly.'
      );
    } else {
      setPrompt(target.suggestion || '');
    }
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [target]);

  const handleClose = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsGenerating(false);
    onClose();
  };

  // Esc closes the studio.
  useEffect(() => {
    if (!target) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [target, onClose]);

  if (!target) return null;

  const isFullHero = target.mode === 'full-hero';
  const isMobile = target.viewport === 'mobile';

  const runGeneration = async (directive: string) => {
    if (!directive.trim()) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsGenerating(true);
    setError(null);
    try {
      const { redesignedDataUrl, modelUsed } = await generateVisualRedesign(
        {
          imageDataUrl: target.imageDataUrl,
          mode: target.mode,
          prompt: directive.trim(),
          context: target.context,
          viewport: target.viewport,
          topIssues: target.topIssues,
        },
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      setGeneratedDataUrl(redesignedDataUrl);
      setUsedModel(modelUsed || null);
      if (isFullHero) {
        onSaveHeroRedesign({
          id: `hero-${Date.now()}`,
          viewport: target.viewport,
          redesignedDataUrl,
          prompt: directive.trim(),
          modelUsed,
          createdAt: new Date().toISOString(),
        });
      }
    } catch (err: any) {
      if (isAbortError(err) || controller.signal.aborted) return;
      const noImage = err instanceof ApiError && err.status === 422;
      setErrorKind(noImage ? 'rephrase' : 'failed');
      setError(
        noImage
          ? `${err.message} Adjust the direction below and generate again.`
          : err?.message || 'Visual redesign failed. Please retry.'
      );
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setIsGenerating(false);
      }
    }
  };

  const handlePresetClick = (presetPrompt: string) => {
    const combined =
      target.suggestion && presetPrompt.includes('exact conversion')
        ? `${presetPrompt} Specific fix: ${target.suggestion}`
        : presetPrompt;
    setPrompt(combined);
  };

  const handleDownload = () => {
    if (!generatedDataUrl) return;
    const link = document.createElement('a');
    link.href = generatedDataUrl;
    link.download = `vision-pro-${target.mode}-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleApplyToCanvas = () => {
    if (!generatedDataUrl || !target.boxPct) return;
    onApplyElementOverlay(generatedDataUrl, prompt || target.context, target.boxPct);
    onClose();
  };

  const viewportHeroHistory = savedHeroRedesigns.filter((r) => r.viewport === target.viewport);

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-[2px] flex items-center justify-center p-4"
      onClick={handleClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="redesign-studio-title"
        className="bg-white border border-slate-200 rounded-xl shadow-2xl w-full max-w-6xl max-h-[92vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between shrink-0 bg-white">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center shrink-0">
              {isFullHero ? <Layers size={16} /> : <Wand2 size={16} />}
            </div>
            <div className="min-w-0">
              <h2
                id="redesign-studio-title"
                className="text-base font-bold text-slate-900 leading-tight truncate"
              >
                {isFullHero ? 'Full-Hero Visual Redesign Studio' : 'Element Visual Redesign Studio'}
              </h2>
              <p className="text-xs text-slate-500 truncate flex items-center gap-1.5">
                <span>
                  {target.context} · {isMobile ? 'Mobile 9:16' : 'Desktop 16:9'} ·{' '}
                  {usedModel || (isFullHero ? 'Nano Banana 2.1 (2K)' : 'Nano Banana 2.1 (1K)')}
                </span>
                {usedModel && !usedModel.includes('nano-banana') && (
                  <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-semibold">
                    Fallback model
                  </span>
                )}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
            aria-label="Close redesign studio"
          >
            <X size={18} />
          </button>
        </div>

        {/* Main Workspace Body */}
        <div className="flex-1 overflow-y-auto p-6 bg-[#F8FAFC] space-y-5">
          {isFullHero && generatedDataUrl ? (
            /* Full-Hero Interactive Before/After Wipe Slider */
            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700 flex items-center gap-2">
                  <SlidersHorizontal size={14} className="text-blue-600" />
                  Before / After Wipe Comparison
                </span>
                <span className="text-xs font-mono tabular-nums text-slate-500">
                  Original {sliderPos}% · Redesigned {100 - sliderPos}%
                </span>
              </div>

              <div className="relative w-full max-h-[500px] overflow-hidden rounded-lg border border-slate-200 bg-slate-100 select-none flex items-center justify-center p-2">
                <div
                  className={`relative overflow-hidden rounded ${
                    isMobile ? 'w-[270px] aspect-[9/16]' : 'w-full aspect-video max-h-[450px]'
                  }`}
                >
                  {/* After (Redesigned) Base Layer */}
                  <img
                    src={generatedDataUrl}
                    alt="Redesigned hero"
                    className="absolute inset-0 w-full h-full object-contain bg-white"
                  />
                  {/* Before (Original) Clipped Layer */}
                  <div
                    className="absolute inset-0 overflow-hidden"
                    style={{ clipPath: `inset(0 ${100 - sliderPos}% 0 0)` }}
                  >
                    <img
                      src={target.imageDataUrl}
                      alt="Original hero"
                      className="w-full h-full object-contain bg-white"
                    />
                  </div>
                  {/* Divider Handle */}
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-blue-600 pointer-events-none"
                    style={{ left: `${sliderPos}%` }}
                  >
                    <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-7 h-7 rounded-full bg-blue-600 text-white shadow-md flex items-center justify-center text-[10px] font-bold">
                      ⇄
                    </div>
                  </div>
                  {/* Labels */}
                  <span className="absolute top-3 left-3 px-2 py-1 bg-slate-900/80 text-white text-[11px] font-medium rounded">
                    Original
                  </span>
                  <span className="absolute top-3 right-3 px-2 py-1 bg-blue-600/90 text-white text-[11px] font-medium rounded">
                    AI Redesigned
                  </span>
                </div>
              </div>

              <input
                type="range"
                min={0}
                max={100}
                value={sliderPos}
                onChange={(e) => setSliderPos(Number(e.target.value))}
                className="w-full accent-blue-600 cursor-ew-resize"
                aria-label="Before and after wipe slider"
              />
            </div>
          ) : (
            /* Side-by-Side Comparison Grid */
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-semibold text-slate-700">Original Capture</span>
                  <span className="text-xs font-mono text-slate-400">Source</span>
                </div>
                <div className="flex-1 min-h-[260px] max-h-[380px] rounded-lg border border-slate-200 bg-slate-50 p-3 flex items-center justify-center overflow-hidden">
                  <img
                    src={target.imageDataUrl}
                    alt="Original element"
                    className="max-w-full max-h-[340px] object-contain"
                  />
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-semibold text-slate-700">
                    {generatedDataUrl ? 'Redesigned Output' : 'AI Preview'}
                  </span>
                  {generatedDataUrl && (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setScale((s) => Math.max(0.5, s - 0.25))}
                        className="p-1 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded cursor-pointer"
                        aria-label="Zoom out"
                      >
                        <ZoomOut size={13} />
                      </button>
                      <span className="text-xs font-mono tabular-nums text-slate-600 w-10 text-center">
                        {Math.round(scale * 100)}%
                      </span>
                      <button
                        type="button"
                        onClick={() => setScale((s) => Math.min(2.5, s + 0.25))}
                        className="p-1 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded cursor-pointer"
                        aria-label="Zoom in"
                      >
                        <ZoomIn size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setScale(1)}
                        className="p-1 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded cursor-pointer"
                        aria-label="Reset zoom"
                      >
                        <RotateCcw size={13} />
                      </button>
                    </div>
                  )}
                </div>

                <div className="flex-1 min-h-[260px] max-h-[380px] rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3 flex items-center justify-center overflow-auto">
                  {isGenerating ? (
                    <div className="text-center space-y-2 py-8">
                      <Loader2 size={26} className="mx-auto text-blue-600 animate-spin" />
                      <p className="text-sm font-semibold text-slate-800">
                        Rendering visual redesign... {elapsedSec > 0 ? `(${elapsedSec}s)` : ''}
                      </p>
                      <p className="text-xs text-slate-500">
                        Generating high-contrast typography and layout adjustments
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          abortRef.current?.abort();
                          abortRef.current = null;
                          setIsGenerating(false);
                        }}
                        className="mt-1 px-3 py-1 bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-medium rounded-md cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : generatedDataUrl ? (
                    <img
                      src={generatedDataUrl}
                      alt="AI redesigned element"
                      className="max-w-full max-h-[340px] object-contain transition-transform duration-150"
                      style={{ transform: `scale(${scale})` }}
                    />
                  ) : (
                    <div className="text-center space-y-1.5 px-6">
                      <Wand2 size={22} className="mx-auto text-slate-300" />
                      <p className="text-sm font-medium text-slate-600">
                        Choose a preset or enter a custom direction below
                      </p>
                      <p className="text-xs text-slate-400">
                        {isFullHero
                          ? 'Generates a 2K before/after full hero mockup'
                          : 'Generates a drop-in visual redesign you can place right on the canvas'}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {error && errorKind === 'rephrase' && (
            <div
              role="status"
              className="bg-amber-50 border border-amber-200 rounded-lg p-3.5 flex items-center gap-2.5 text-amber-900 text-xs"
            >
              <AlertCircle size={15} className="shrink-0 text-amber-600" />
              <span>{error}</span>
            </div>
          )}

          {error && errorKind === 'failed' && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 text-red-800 text-xs">
                <AlertCircle size={15} className="shrink-0 text-red-600" />
                <span>{error}</span>
              </div>
              <button
                type="button"
                onClick={() => runGeneration(prompt)}
                className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded flex items-center gap-1 whitespace-nowrap cursor-pointer"
              >
                <RefreshCw size={12} />
                Retry
              </button>
            </div>
          )}

          {/* Presets + Prompt Bar */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">
                Quick Redesign Presets <span className="font-normal text-slate-400">(fills prompt for review)</span>
              </p>
              <div className="flex flex-wrap gap-2">
                {(isFullHero ? HERO_PRESETS : ELEMENT_PRESETS).map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    disabled={isGenerating}
                    onClick={() => handlePresetClick(preset.prompt)}
                    className="px-3 py-1.5 bg-slate-50 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-300 border border-slate-200 rounded-md text-xs font-medium text-slate-700 transition-colors disabled:opacity-50 cursor-pointer whitespace-nowrap"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            {target.suggestion && !isFullHero && (
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-700">
                <span className="font-semibold text-slate-900">Audit Recommendation: </span>
                {target.suggestion}
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-2.5">
              <input
                type="text"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isGenerating) runGeneration(prompt);
                }}
                placeholder="Describe exact typography, contrast, layout, or copy updates..."
                className="flex-1 h-10 px-3.5 bg-white border border-slate-300 rounded-lg text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15"
                disabled={isGenerating}
              />
              <button
                type="button"
                onClick={() => runGeneration(prompt)}
                disabled={isGenerating || !prompt.trim()}
                className="h-10 px-5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white text-sm font-semibold rounded-lg transition-colors flex items-center justify-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
              >
                {isGenerating ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />}
                Generate Redesign
              </button>
            </div>
          </div>

          {/* Saved Full-Hero Variations Strip */}
          {isFullHero && viewportHeroHistory.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs font-semibold text-slate-700 mb-3">
                Saved Hero Concepts ({viewportHeroHistory.length})
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {viewportHeroHistory.map((item) => (
                  <div
                    key={item.id}
                    className={`relative group rounded-lg border overflow-hidden transition-colors ${
                      generatedDataUrl === item.redesignedDataUrl
                        ? 'border-blue-600 ring-2 ring-blue-600/15'
                        : 'border-slate-200 hover:border-slate-400'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setGeneratedDataUrl(item.redesignedDataUrl);
                        setUsedModel(item.modelUsed || null);
                      }}
                      className="w-full text-left cursor-pointer"
                    >
                      <img
                        src={item.redesignedDataUrl}
                        alt="Saved hero concept"
                        className="w-full h-20 object-cover object-top"
                      />
                      <p className="p-2 text-[11px] text-slate-600 truncate">{item.prompt}</p>
                    </button>
                    {onDeleteHeroRedesign && (
                      <button
                        type="button"
                        onClick={() => onDeleteHeroRedesign(item.id)}
                        className="absolute top-1.5 right-1.5 p-1 rounded bg-slate-900/75 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-red-600 transition-opacity cursor-pointer"
                        aria-label="Delete saved hero concept"
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-slate-200 bg-white flex items-center justify-between gap-3 shrink-0">
          <div>
            {generatedDataUrl && (
              <button
                type="button"
                onClick={handleDownload}
                className="px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-semibold rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                <Download size={14} />
                Download PNG
              </button>
            )}
          </div>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={handleClose}
              className="px-4 py-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap"
            >
              Close
            </button>
            {!isFullHero && target.boxPct && (
              <button
                type="button"
                onClick={handleApplyToCanvas}
                disabled={!generatedDataUrl}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-semibold rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                <Check size={14} />
                Apply to Live Canvas
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
