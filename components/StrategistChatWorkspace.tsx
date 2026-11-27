import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  Copy,
  Check,
  RefreshCw,
  Loader2,
  MessageSquare,
  FileEdit,
  Layers,
} from 'lucide-react';
import type { ChatMessage, CopyVariant } from '../types';

interface StrategistChatWorkspaceProps {
  domain: string;
  copyVariants: CopyVariant[];
  isGeneratingCopy: boolean;
  onGenerateCopy: () => void;
  onVisualizeVariant: (variant: CopyVariant) => void;
  chatHistory: ChatMessage[];
  isStreamingChat: boolean;
  onSendMessage: (message: string) => void;
  /** Whether the session was audited as a full page; changes one starter prompt. */
  isFullPage?: boolean;
}

/** Lightweight safe Markdown renderer for assistant replies (bold, inline code, fenced code, bullets). */
function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={i} className="font-semibold text-slate-900">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={i} className="px-1 py-0.5 rounded bg-slate-200/70 text-slate-900 font-mono text-[12px]">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

function renderMarkdownBlocks(content: string): React.ReactNode {
  const blocks = content.split(/```([a-z0-9_-]*)\n?([\s\S]*?)```/gi);
  const out: React.ReactNode[] = [];
  for (let i = 0; i < blocks.length; i += 3) {
    const prose = blocks[i] ?? '';
    if (prose.trim()) {
      const lines = prose.split('\n');
      let bullets: string[] = [];
      const flushBullets = (key: string) => {
        if (bullets.length === 0) return;
        out.push(
          <ul key={key} className="list-disc pl-5 space-y-1">
            {bullets.map((b, bi) => (
              <li key={bi}>{renderInline(b)}</li>
            ))}
          </ul>
        );
        bullets = [];
      };
      lines.forEach((raw, li) => {
        const line = raw.trimEnd();
        const bulletMatch = /^\s*[-*]\s+(.+)$/.exec(line);
        if (bulletMatch) {
          bullets.push(bulletMatch[1]);
        } else {
          flushBullets(`b-${i}-${li}`);
          if (line.trim()) {
            out.push(<p key={`p-${i}-${li}`}>{renderInline(line)}</p>);
          }
        }
      });
      flushBullets(`b-${i}-end`);
    }
    const code = blocks[i + 2];
    if (code !== undefined) {
      out.push(
        <pre key={`code-${i}`} className="p-3 rounded-lg bg-slate-950 text-emerald-200 font-mono text-xs overflow-x-auto leading-relaxed">
          <code>{code.replace(/^\n|\n$/g, '')}</code>
        </pre>
      );
    }
  }
  return <div className="space-y-2">{out}</div>;
}

const STARTER_PROMPTS = [
  'What single change above the fold will lift conversions fastest?',
  'Write exact CSS fixes for the contrast and visual hierarchy issues.',
  'Rewrite our hero section for enterprise B2B procurement buyers.',
  'How should we simplify this hero for mobile thumb-zone conversions?',
];

export const StrategistChatWorkspace: React.FC<StrategistChatWorkspaceProps> = ({
  domain,
  copyVariants,
  isGeneratingCopy,
  onGenerateCopy,
  onVisualizeVariant,
  chatHistory,
  isStreamingChat,
  onSendMessage,
  isFullPage = false,
}) => {
  const starters = isFullPage
    ? [STARTER_PROMPTS[0], 'Which section below the first screen loses the most visitors, and how do we fix it?', ...STARTER_PROMPTS.slice(1, 3)]
    : STARTER_PROMPTS;
  const [input, setInput] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, isStreamingChat]);

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1800);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreamingChat) return;
    const msg = input.trim();
    setInput('');
    onSendMessage(msg);
  };

  return (
    <div className="flex-1 overflow-y-auto bg-[#F8FAFC]">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* A/B Copy Variant Matrix */}
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-bold text-slate-900">
                A/B Hero Copy Lab &amp; CRO Strategist
              </h2>
              <p className="text-xs text-slate-600 mt-0.5">
                Ready-to-test headline, subheadline, and CTA variants tailored to <span className="font-mono text-slate-800">{domain}</span>
              </p>
            </div>
            {/* Empty state has its own button; this one appears once there is something to refresh. */}
            {(copyVariants.length > 0 || isGeneratingCopy) && (
            <button
              type="button"
              onClick={onGenerateCopy}
              disabled={isGeneratingCopy}
              className="px-4 py-2 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-semibold rounded-lg flex items-center gap-2 transition-colors whitespace-nowrap cursor-pointer"
            >
              {isGeneratingCopy ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Writing Variants...
                </>
              ) : copyVariants.length > 0 ? (
                <>
                  <RefreshCw size={14} />
                  Regenerate Variants
                </>
              ) : (
                <>
                  <FileEdit size={14} />
                  Generate 3 A/B Variants
                </>
              )}
            </button>
            )}
          </div>

          {copyVariants.length === 0 && !isGeneratingCopy ? (
            <div className="bg-white border border-slate-200 rounded-xl p-6 flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-slate-900">
                  No A/B copy variants generated yet
                </p>
                <p className="text-xs text-slate-600 mt-0.5">
                  Generate Clarity-First, Outcome &amp; Proof, and Urgency-Led hero rewrites grounded in your screenshot and audit findings.
                </p>
              </div>
              <button
                type="button"
                onClick={onGenerateCopy}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg cursor-pointer whitespace-nowrap"
              >
                Generate A/B Matrix
              </button>
            </div>
          ) : isGeneratingCopy && copyVariants.length === 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[0, 1, 2].map((n) => (
                <div key={n} className="bg-white border border-slate-200 rounded-xl p-5 space-y-3 animate-pulse">
                  <div className="h-3 w-24 bg-slate-200 rounded" />
                  <div className="h-5 w-full bg-slate-200 rounded" />
                  <div className="h-12 w-full bg-slate-100 rounded" />
                  <div className="h-8 w-32 bg-slate-200 rounded" />
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {copyVariants.map((variant, idx) => {
                const fullCopy = `H1: ${variant.headline}\nSubheadline: ${variant.subheadline}\nPrimary CTA: ${variant.primary_cta}${variant.secondary_cta ? `\nSecondary CTA: ${variant.secondary_cta}` : ''}`;
                const isCopied = copiedId === variant.id;
                return (
                  <div
                    key={variant.id}
                    className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4"
                  >
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-blue-700">
                          0{idx + 1}. {variant.angle}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleCopy(variant.id, fullCopy)}
                          className="text-xs font-medium text-slate-500 hover:text-slate-900 flex items-center gap-1 cursor-pointer"
                        >
                          {isCopied ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
                          {isCopied ? 'Copied' : 'Copy'}
                        </button>
                      </div>

                      <h3 className="text-base font-bold text-slate-900 leading-snug">
                        {variant.headline}
                      </h3>
                      <p className="text-xs text-slate-600 leading-relaxed">
                        {variant.subheadline}
                      </p>

                      <div className="pt-2 flex flex-wrap items-center gap-2">
                        <span className="px-3 py-1.5 bg-blue-600 text-white text-xs font-semibold rounded-md">
                          {variant.primary_cta}
                        </span>
                        {variant.secondary_cta && (
                          <span className="px-3 py-1.5 bg-slate-100 text-slate-700 text-xs font-medium rounded-md border border-slate-200">
                            {variant.secondary_cta}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="pt-3 border-t border-slate-100 space-y-3">
                      <p className="text-[11px] text-slate-500 leading-relaxed">
                        <span className="font-semibold text-slate-700">Why it works: </span>
                        {variant.rationale}
                      </p>
                      <button
                        type="button"
                        onClick={() => onVisualizeVariant(variant)}
                        className="w-full py-2 px-3 bg-slate-900 hover:bg-[#1A73E8] text-white text-xs font-semibold rounded-lg transition-colors flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                      >
                        <Layers size={13} />
                        Visualize in Hero Redesign
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Interactive Streaming CRO Strategist Chat */}
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col min-h-[420px]">
          <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50/70 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MessageSquare size={15} className="text-blue-600" />
              <h3 className="text-sm font-semibold text-slate-900">
                Ask the CRO &amp; SEO Strategist
              </h3>
            </div>
            <span className="text-xs text-slate-500">
              Grounded in your live screenshot, scores, and HTML metadata
            </span>
          </div>

          <div className="flex-1 p-5 space-y-4 max-h-[62vh] overflow-y-auto">
            {chatHistory.length === 0 ? (
              <div className="py-6 space-y-4">
                <p className="text-xs text-slate-500">
                  Start a workshop session or pick a quick question:
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {starters.map((q) => (
                    <button
                      key={q}
                      type="button"
                      disabled={isStreamingChat}
                      onClick={() => onSendMessage(q)}
                      className="text-left p-3 rounded-lg border border-slate-200 hover:border-blue-400 hover:bg-blue-50/40 text-xs font-medium text-slate-700 transition-colors cursor-pointer"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              chatHistory.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-xl px-4 py-3 text-sm leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-slate-900 text-white whitespace-pre-wrap'
                        : 'bg-slate-50 border border-slate-200 text-slate-800'
                    }`}
                  >
                    {msg.role === 'user'
                      ? msg.content
                      : msg.content
                      ? renderMarkdownBlocks(msg.content)
                      : isStreamingChat
                      ? 'Thinking...'
                      : ''}
                  </div>
                </div>
              ))
            )}
            <div ref={chatEndRef} />
          </div>

          <form
            onSubmit={handleSubmit}
            className="p-3.5 border-t border-slate-200 bg-white flex items-center gap-2.5"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask for copy rewrites, CSS patches, mobile UX fixes, or experiment ideas..."
              className="flex-1 h-10 px-3.5 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:bg-white focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15"
              disabled={isStreamingChat}
            />
            <button
              type="submit"
              disabled={isStreamingChat || !input.trim()}
              className="h-10 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
            >
              {isStreamingChat ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Send
            </button>
          </form>
        </section>
      </div>
    </div>
  );
};
