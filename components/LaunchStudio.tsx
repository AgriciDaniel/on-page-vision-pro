import React, { useState, useEffect, useRef } from 'react';
import {
  Globe,
  Upload,
  ArrowRight,
  Monitor,
  Smartphone,
  Clipboard,
  X,
  Clock,
  CheckCircle2,
  SlidersHorizontal,
  Target,
} from 'lucide-react';
import type { AuditGoal, AuditHistoryHeader, CaptureMode, ViewportKey } from '../types';
import { WarpBackground } from './WarpBackground';
import { inferCaptureMode, ingestImage, type IngestedImage } from '../lib/client/images';

const AUDIT_GOALS: { id: AuditGoal; label: string }[] = [
  { id: 'general', label: 'General CRO & SEO' },
  { id: 'saas-trial', label: 'SaaS Free Trial' },
  { id: 'b2b-demo', label: 'B2B Demo Funnel' },
  { id: 'ecommerce', label: 'E-commerce Product' },
  { id: 'lead-gen', label: 'Lead Gen / Waitlist' },
];

interface LaunchStudioProps {
  history: AuditHistoryHeader[];
  onStartUrlAudit: (
    url: string,
    options?: { auditGoal: AuditGoal; targetKeyword: string; captureMode?: CaptureMode }
  ) => void;
  onStartUploadAudit: (params: {
    desktop: IngestedImage | null;
    mobile: IngestedImage | null;
    desktopMode?: CaptureMode;
    mobileMode?: CaptureMode;
    urlContext: string;
    auditGoal: AuditGoal;
    targetKeyword: string;
  }) => void;
  onSelectHistory: (id: string) => void;
  initialUrl?: string;
  /** Open on this tab, e.g. 'upload' after a site blocked capture. */
  initialMode?: 'url' | 'upload';
  /** Prefill for the upload form's page URL field. */
  initialUploadContext?: string;
}

const SAMPLE_URLS = [
  { label: 'stripe.com', url: 'https://stripe.com' },
  { label: 'linear.app', url: 'https://linear.app' },
  { label: 'vercel.com', url: 'https://vercel.com' },
  { label: 'notion.so', url: 'https://www.notion.so' },
];

const SCOPE_OPTIONS: { id: CaptureMode; label: string; hint: string }[] = [
  { id: 'fullpage', label: 'Full page', hint: 'Every section, top to bottom' },
  { id: 'viewport', label: 'First impression', hint: 'The first screen only' },
];

/** A two-option radio group: audit the whole page or only the first screen. */
const ScopeChoice: React.FC<{
  value: CaptureMode;
  onChange: (mode: CaptureMode) => void;
  label: string;
  compact?: boolean;
}> = ({ value, onChange, label, compact = false }) => (
  <div
    role="radiogroup"
    aria-label={label}
    className={`inline-flex items-center gap-0.5 p-0.5 bg-slate-100 border border-slate-200 rounded-lg ${compact ? '' : 'shadow-xs'}`}
    onClick={(e) => e.stopPropagation()}
  >
    {SCOPE_OPTIONS.map((opt) => {
      const active = value === opt.id;
      return (
        <button
          key={opt.id}
          type="button"
          role="radio"
          aria-checked={active}
          title={opt.hint}
          onClick={() => onChange(opt.id)}
          className={`rounded-md font-semibold transition-colors whitespace-nowrap cursor-pointer focus-visible:outline-2 focus-visible:outline-blue-600 ${
            compact ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1.5 text-xs'
          } ${active ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'}`}
        >
          {opt.label}
          {!compact && <span className="ml-1.5 font-normal text-slate-500">{opt.hint}</span>}
        </button>
      );
    })}
  </div>
);

/** One line under a ready dropzone: stored size, and the original size if it was scaled. */
function describeImage(img: IngestedImage): string {
  const size = `${img.naturalWidth} × ${img.naturalHeight.toLocaleString('en-US')} px`;
  return img.originalWidth !== img.naturalWidth
    ? `${size} (scaled from ${img.originalWidth} px wide)`
    : size;
}

export const LaunchStudio: React.FC<LaunchStudioProps> = ({
  history,
  onStartUrlAudit,
  onStartUploadAudit,
  onSelectHistory,
  initialUrl = '',
  initialMode = 'url',
  initialUploadContext = '',
}) => {
  const [mode, setMode] = useState<'url' | 'upload'>(initialMode);
  const [urlInput, setUrlInput] = useState(initialUrl);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);

  const [auditGoal, setAuditGoal] = useState<AuditGoal>('general');
  const [targetKeyword, setTargetKeyword] = useState('');
  const [showCalibration, setShowCalibration] = useState(false);

  const [desktopUpload, setDesktopUpload] = useState<IngestedImage | null>(null);
  const [mobileUpload, setMobileUpload] = useState<IngestedImage | null>(null);
  const [uploadError, setUploadError] = useState<Record<ViewportKey, string | null>>({
    desktop: null,
    mobile: null,
  });
  const [ingesting, setIngesting] = useState<ViewportKey | null>(null);
  // What a URL audit captures. Full page is the default.
  const [captureMode, setCaptureMode] = useState<CaptureMode>('fullpage');
  // For uploads the mode is guessed from the image's height; the user can switch it.
  const [uploadMode, setUploadMode] = useState<Record<ViewportKey, CaptureMode>>({
    desktop: 'viewport',
    mobile: 'viewport',
  });
  const [uploadContextUrl, setUploadContextUrl] = useState(initialUploadContext);
  const [pasteTarget, setPasteTarget] = useState<'desktop' | 'mobile'>('desktop');

  const desktopInputRef = useRef<HTMLInputElement>(null);
  const mobileInputRef = useRef<HTMLInputElement>(null);

  /** Measure, scale and store one screenshot for a slot, or show why it was refused. */
  const acceptImage = async (file: File, target: ViewportKey) => {
    setIngesting(target);
    setUploadError((prev) => ({ ...prev, [target]: null }));
    try {
      const img = await ingestImage(file, target);
      if (target === 'desktop') setDesktopUpload(img);
      else setMobileUpload(img);
      setUploadMode((prev) => ({
        ...prev,
        [target]: inferCaptureMode(img.naturalWidth, img.naturalHeight, target),
      }));
    } catch (err: any) {
      setUploadError((prev) => ({ ...prev, [target]: err?.message || 'This image could not be used.' }));
    } finally {
      setIngesting(null);
    }
  };

  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            setMode('upload');
            if (pasteTarget === 'mobile' && desktopUpload) {
              await acceptImage(file, 'mobile');
            } else if (!desktopUpload) {
              setPasteTarget('mobile');
              await acceptImage(file, 'desktop');
            } else {
              await acceptImage(file, 'mobile');
            }
            break;
          }
        }
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [desktopUpload, pasteTarget]);

  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = urlInput.trim();
    if (!cleaned) {
      setUrlError('Enter a website URL to audit.');
      return;
    }
    try {
      const normalized = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
      new URL(normalized);
      setUrlError(null);
      setLaunching(true);
      setTimeout(() => {
        onStartUrlAudit(normalized, {
          auditGoal,
          captureMode,
          targetKeyword: targetKeyword.trim(),
        });
      }, 320);
    } catch {
      setUrlError('Please enter a valid web address (for example, https://stripe.com).');
    }
  };

  const handleFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
    target: 'desktop' | 'mobile'
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await acceptImage(file, target);
  };

  const handleDrop = async (e: React.DragEvent, target: 'desktop' | 'mobile') => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    await acceptImage(file, target);
  };

  const handleUploadSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if ((!desktopUpload && !mobileUpload) || ingesting) return;
    onStartUploadAudit({
      desktop: desktopUpload,
      mobile: mobileUpload,
      desktopMode: uploadMode.desktop,
      mobileMode: uploadMode.mobile,
      urlContext: uploadContextUrl.trim(),
      auditGoal,
      targetKeyword: targetKeyword.trim(),
    });
  };

  return (
    <WarpBackground
      className="flex-1 w-full bg-[#F0F4F8] overflow-y-auto"
      perspective={200}
      beamsPerSide={4}
      beamSize={4}
      beamDuration={4}
      gridColor="rgba(26, 115, 232, 0.15)"
    >
      <div className="min-h-full w-full flex flex-col items-center justify-center px-4 sm:px-6 py-12 md:py-16">
        <div className="w-full max-w-4xl flex flex-col items-center text-center">
          {/* Iconic Bold Centered Hero Heading */}
          <h1 className="text-5xl sm:text-7xl md:text-8xl font-extrabold tracking-tighter text-[#1F1F1F] leading-[0.95] mb-6">
            On-page Vision Pro.
          </h1>

          <p className="text-lg md:text-2xl max-w-3xl mx-auto leading-relaxed font-light text-gray-600 mb-9">
            Audits the <span className="font-bold text-[#1A73E8]">whole page</span>, section by section, or
            just the <span className="font-bold text-gray-900">first impression</span>. Built-in{' '}
            <span className="font-semibold text-[#E56565]">Desktop &amp; Mobile</span> capture and{' '}
            <span className="font-semibold text-[#FF9500]">Gemini 4</span> for CRO, visual hierarchy, on-page SEO
            &amp; AI redesigns.
          </p>

          {/* Clean Mode Switcher */}
          <div className="inline-flex items-center gap-1 p-1 bg-white/90 backdrop-blur-md border border-gray-200 rounded-xl shadow-xs mb-5">
            <button
              type="button"
              onClick={() => setMode('url')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                mode === 'url'
                  ? 'bg-[#1A73E8] text-white shadow-xs'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              <Globe size={14} />
              Live URL Capture
            </button>
            <button
              type="button"
              onClick={() => setMode('upload')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                mode === 'upload'
                  ? 'bg-[#1A73E8] text-white shadow-xs'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              <Upload size={14} />
              Upload or Paste Screenshot
            </button>
          </div>

          {/* Primary Action Area */}
          {mode === 'url' ? (
            <div className="w-full max-w-2xl">
              {launching ? (
                <div className="w-full h-[64px] md:h-[72px] bg-green-50 border border-green-200 rounded-2xl flex items-center justify-center gap-2.5 text-green-700 font-bold text-base shadow-sm">
                  <CheckCircle2 size={22} />
                  <span>Audit Initiated...</span>
                </div>
              ) : (
                <form onSubmit={handleUrlSubmit} className="w-full">
                  <div className="relative flex items-center bg-white rounded-2xl border border-gray-200 shadow-xl shadow-blue-900/5 hover:shadow-2xl hover:shadow-blue-900/10 focus-within:border-[#1A73E8] focus-within:ring-4 focus-within:ring-blue-100 transition-all">
                    <Globe
                      size={18}
                      className="absolute left-5 md:left-6 text-gray-400 pointer-events-none"
                    />
                    <input
                      type="text"
                      value={urlInput}
                      onChange={(e) => {
                        setUrlInput(e.target.value);
                        if (urlError) setUrlError(null);
                      }}
                      placeholder="https://example.com"
                      className="w-full h-[64px] md:h-[72px] pl-12 md:pl-14 pr-36 md:pr-44 bg-transparent outline-none text-base md:text-xl text-[#444746] placeholder:text-gray-400"
                    />
                    <div className="absolute right-2.5 top-2.5 bottom-2.5">
                      <button
                        type="submit"
                        className="h-full px-5 md:px-8 bg-[#1A73E8] hover:bg-[#0B57D0] active:scale-[0.98] text-white font-bold text-sm md:text-base rounded-xl transition-all flex items-center gap-2 shadow-md hover:shadow-lg whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        Audit
                        <ArrowRight size={18} strokeWidth={2.5} />
                      </button>
                    </div>
                  </div>

                  {urlError && (
                    <p className="mt-2.5 text-xs font-medium text-red-600">{urlError}</p>
                  )}

                  <div className="mt-4 flex justify-center">
                    <ScopeChoice value={captureMode} onChange={setCaptureMode} label="What to audit" />
                  </div>

                  <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs text-slate-500">
                    <span>Try a live page:</span>
                    {SAMPLE_URLS.map((sample) => (
                      <button
                        key={sample.label}
                        type="button"
                        onClick={() => {
                          setUrlInput(sample.url);
                          setUrlError(null);
                        }}
                        className="font-mono text-slate-700 hover:text-blue-600 underline decoration-slate-300 underline-offset-4 transition-colors cursor-pointer whitespace-nowrap"
                      >
                        {sample.label}
                      </button>
                    ))}
                    <span className="hidden sm:inline text-slate-300" aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1 text-slate-500">
                      <Clipboard size={12} />
                      Cmd/Ctrl+V to paste
                    </span>
                    <span className="hidden sm:inline text-slate-300" aria-hidden="true">·</span>
                    <button
                      type="button"
                      onClick={() => setShowCalibration((v) => !v)}
                      className={`inline-flex items-center gap-1 font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                        showCalibration || auditGoal !== 'general' || targetKeyword.trim()
                          ? 'text-[#1A73E8]'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <SlidersHorizontal size={12} />
                      {auditGoal !== 'general' || targetKeyword.trim()
                        ? `Calibrated: ${AUDIT_GOALS.find((g) => g.id === auditGoal)?.label}`
                        : 'Calibrate Goal & Keyword'}
                    </button>
                  </div>

                  {showCalibration && (
                    <div className="mt-4 bg-white/95 backdrop-blur-md border border-slate-200 rounded-xl p-4 shadow-sm text-left space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-700">
                          Conversion Goal Lens
                        </span>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {AUDIT_GOALS.map((g) => (
                            <button
                              key={g.id}
                              type="button"
                              onClick={() => setAuditGoal(g.id)}
                              className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors cursor-pointer whitespace-nowrap ${
                                auditGoal === g.id
                                  ? 'bg-[#1A73E8] border-[#1A73E8] text-white'
                                  : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
                              }`}
                            >
                              {g.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="relative flex items-center">
                        <Target size={14} className="absolute left-3 text-slate-400 pointer-events-none" />
                        <input
                          type="text"
                          value={targetKeyword}
                          onChange={(e) => setTargetKeyword(e.target.value)}
                          placeholder="Optional target keyword (e.g. payment infrastructure API, project tracking software)"
                          className="w-full h-9 pl-9 pr-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-900 placeholder:text-slate-400 outline-none focus:bg-white focus:border-[#1A73E8]"
                        />
                      </div>
                    </div>
                  )}
                </form>
              )}
            </div>
          ) : (
            <form
              onSubmit={handleUploadSubmit}
              className="w-full max-w-3xl bg-white/95 backdrop-blur-md border border-slate-200 rounded-2xl p-5 md:p-6 shadow-xl shadow-blue-950/5 text-left space-y-4"
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Desktop Dropzone */}
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => handleDrop(e, 'desktop')}
                  onClick={() => {
                    setPasteTarget('desktop');
                    if (!desktopUpload) desktopInputRef.current?.click();
                  }}
                  {...(!desktopUpload
                    ? {
                        role: 'button',
                        tabIndex: 0,
                        'aria-label': 'Add a desktop screenshot: browse, drop, or paste an image',
                        onKeyDown: (e: React.KeyboardEvent) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setPasteTarget('desktop');
                            desktopInputRef.current?.click();
                          }
                        },
                      }
                    : {})}
                  className={`border border-dashed rounded-xl p-4 transition-colors cursor-pointer min-h-[170px] flex flex-col justify-center items-center focus-visible:outline-2 focus-visible:outline-blue-600 ${
                    desktopUpload
                      ? 'border-slate-300 bg-slate-50'
                      : pasteTarget === 'desktop'
                      ? 'border-blue-400 bg-blue-50/40 hover:bg-blue-50/60'
                      : 'border-slate-300 hover:border-slate-400 bg-slate-50/60'
                  }`}
                >
                  <input
                    ref={desktopInputRef}
                    type="file"
                    accept="image/*"
                    onChange={(e) => handleFileChange(e, 'desktop')}
                    className="hidden"
                  />
                  {desktopUpload ? (
                    <div className="w-full">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
                          <Monitor size={14} className="text-blue-600" />
                          Desktop Ready
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDesktopUpload(null);
                          }}
                          className="p-1 text-slate-400 hover:text-red-600 rounded cursor-pointer"
                          aria-label="Remove desktop screenshot"
                        >
                          <X size={14} />
                        </button>
                      </div>
                      <img
                        src={desktopUpload.dataUrl}
                        alt="Uploaded desktop screenshot"
                        className="w-full h-28 object-cover object-top rounded border border-slate-200 bg-white"
                      />
                      <p className="mt-1.5 text-[11px] font-mono text-slate-500">{describeImage(desktopUpload)}</p>
                      <div className="mt-1.5 flex items-center gap-2">
                        <span className="text-[11px] text-slate-500">Audit as</span>
                        <ScopeChoice
                          compact
                          value={uploadMode.desktop}
                          onChange={(m) => setUploadMode((prev) => ({ ...prev, desktop: m }))}
                          label="Audit this desktop screenshot as"
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="text-center space-y-1.5">
                      <Monitor size={20} className="mx-auto text-slate-400" />
                      <p className="text-sm font-semibold text-slate-800">Desktop Screenshot</p>
                      <p className="text-xs text-slate-500">
                        {ingesting === 'desktop' ? 'Reading image...' : 'Drop, browse, or paste (Cmd/Ctrl+V)'}
                      </p>
                      {uploadError.desktop && (
                        <p className="text-xs font-medium text-red-600">{uploadError.desktop}</p>
                      )}
                    </div>
                  )}
                </div>

                {/* Mobile Dropzone */}
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => handleDrop(e, 'mobile')}
                  onClick={() => {
                    setPasteTarget('mobile');
                    if (!mobileUpload) mobileInputRef.current?.click();
                  }}
                  {...(!mobileUpload
                    ? {
                        role: 'button',
                        tabIndex: 0,
                        'aria-label': 'Add a mobile screenshot: browse, drop, or paste an image',
                        onKeyDown: (e: React.KeyboardEvent) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setPasteTarget('mobile');
                            mobileInputRef.current?.click();
                          }
                        },
                      }
                    : {})}
                  className={`border border-dashed rounded-xl p-4 transition-colors cursor-pointer min-h-[170px] flex flex-col justify-center items-center focus-visible:outline-2 focus-visible:outline-blue-600 ${
                    mobileUpload
                      ? 'border-slate-300 bg-slate-50'
                      : pasteTarget === 'mobile'
                      ? 'border-blue-400 bg-blue-50/40 hover:bg-blue-50/60'
                      : 'border-slate-300 hover:border-slate-400 bg-slate-50/60'
                  }`}
                >
                  <input
                    ref={mobileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={(e) => handleFileChange(e, 'mobile')}
                    className="hidden"
                  />
                  {mobileUpload ? (
                    <div className="w-full">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
                          <Smartphone size={14} className="text-blue-600" />
                          Mobile Ready
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMobileUpload(null);
                          }}
                          className="p-1 text-slate-400 hover:text-red-600 rounded cursor-pointer"
                          aria-label="Remove mobile screenshot"
                        >
                          <X size={14} />
                        </button>
                      </div>
                      <img
                        src={mobileUpload.dataUrl}
                        alt="Uploaded mobile screenshot"
                        // A full-page phone capture is many screens tall: show its top in a phone-shaped
                        // frame instead of squeezing the whole page into a sliver.
                        className={
                          mobileUpload.naturalHeight > mobileUpload.naturalWidth * 2.5
                            ? 'mx-auto h-28 aspect-[9/16] object-cover object-top rounded border border-slate-200 bg-white'
                            : 'w-full h-28 object-contain rounded border border-slate-200 bg-white'
                        }
                      />
                      <p className="mt-1.5 text-[11px] font-mono text-slate-500">{describeImage(mobileUpload)}</p>
                      <div className="mt-1.5 flex items-center gap-2">
                        <span className="text-[11px] text-slate-500">Audit as</span>
                        <ScopeChoice
                          compact
                          value={uploadMode.mobile}
                          onChange={(m) => setUploadMode((prev) => ({ ...prev, mobile: m }))}
                          label="Audit this mobile screenshot as"
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="text-center space-y-1.5">
                      <Smartphone size={20} className="mx-auto text-slate-400" />
                      <p className="text-sm font-semibold text-slate-800">Mobile Screenshot (Optional)</p>
                      <p className="text-xs text-slate-500">
                        {ingesting === 'mobile' ? 'Reading image...' : 'Unlocks Desktop vs. Mobile parity check'}
                      </p>
                      {uploadError.mobile && (
                        <p className="text-xs font-medium text-red-600">{uploadError.mobile}</p>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <span className="text-xs font-semibold text-slate-600 mr-1">Goal:</span>
                {AUDIT_GOALS.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => setAuditGoal(g.id)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors cursor-pointer whitespace-nowrap ${
                      auditGoal === g.id
                        ? 'bg-[#1A73E8] border-[#1A73E8] text-white'
                        : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {g.label}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  type="text"
                  value={uploadContextUrl}
                  onChange={(e) => setUploadContextUrl(e.target.value)}
                  placeholder="Optional page URL or project name"
                  className="h-11 px-3.5 bg-white border border-slate-300 rounded-xl text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15"
                />
                <input
                  type="text"
                  value={targetKeyword}
                  onChange={(e) => setTargetKeyword(e.target.value)}
                  placeholder="Optional target SEO keyword"
                  className="h-11 px-3.5 bg-white border border-slate-300 rounded-xl text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15"
                />
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={(!desktopUpload && !mobileUpload) || Boolean(ingesting)}
                  className="h-11 px-6 bg-[#1A73E8] hover:bg-[#0B57D0] disabled:bg-slate-200 disabled:text-slate-400 text-white text-sm font-semibold rounded-xl transition-colors flex items-center justify-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Analyze Screenshots
                  <ArrowRight size={15} />
                </button>
              </div>
            </form>
          )}

          {/* Quiet Capability Strip */}
          <div className="mt-10 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-slate-600 font-medium">
            <span>Full Page or First Screen</span>
            <span className="text-slate-300" aria-hidden="true">·</span>
            <span>Desktop &amp; Mobile Parity</span>
            <span className="text-slate-300" aria-hidden="true">·</span>
            <span>Element &amp; 2K Hero Redesigns</span>
            <span className="text-slate-300" aria-hidden="true">·</span>
            <span>Google Search SERP Intel</span>
            <span className="text-slate-300" aria-hidden="true">·</span>
            <span>Audio Briefings &amp; Print to PDF</span>
          </div>

          {/* Recent Local Audits Quick-Resume */}
          {history.length > 0 && (
            <div className="mt-12 w-full max-w-4xl text-left bg-white/85 backdrop-blur-md border border-slate-200/90 rounded-2xl p-5 shadow-sm">
              <div className="flex items-center justify-between mb-3.5">
                <h2 className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                  <Clock size={13} className="text-slate-400" />
                  Resume Recent Local Audits
                </h2>
                <span className="text-xs text-slate-500 font-mono tabular-nums">
                  {history.length} saved
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {history.slice(0, 6).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelectHistory(item.id)}
                    className="text-left bg-white border border-slate-200 hover:border-blue-400 rounded-xl p-2.5 transition-colors flex gap-3 items-center cursor-pointer group"
                  >
                    <div className="w-14 h-10 rounded-md border border-slate-200 bg-slate-100 overflow-hidden shrink-0">
                      {item.thumbnailDataUrl ? (
                        <img
                          src={item.thumbnailDataUrl}
                          alt={item.domain}
                          className="w-full h-full object-cover object-top"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-slate-400">
                          <Monitor size={14} />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-slate-900 truncate group-hover:text-blue-600 transition-colors">
                        {item.domain}
                      </p>
                      <p className="text-[11px] text-slate-500 truncate mt-0.5 font-mono tabular-nums">
                        {item.desktopScore ?? item.mobileScore ?? 'n/a'}/100 · {item.criticalCount} critical
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </WarpBackground>
  );
};
