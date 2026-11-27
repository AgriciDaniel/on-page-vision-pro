import React, { useEffect, useRef, useState } from 'react';
import { KeyRound, Loader2, X } from 'lucide-react';
import { isSignInOpen, signInCancelled, signInSucceeded, subscribeSignIn } from '../lib/client/access';
import { submitAccessToken } from '../services/apiClient';

/**
 * Small sign-in card for a server that needs an access token. Shown when an API call gets a 401
 * (or at start-up when GET /api/session says one is needed). The token lives only in this input's
 * state until it is posted; the server answers with an HttpOnly cookie.
 */
export const AccessTokenCard: React.FC = () => {
  const [open, setOpen] = useState(isSignInOpen);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitSec, setWaitSec] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => subscribeSignIn(setOpen), []);

  useEffect(() => {
    if (open) {
      returnFocus.current = document.activeElement as HTMLElement | null;
      setError(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setToken('');
      returnFocus.current?.focus?.();
    }
  }, [open]);

  // Count down a rate-limit wait (Retry-After) before the next try is allowed.
  useEffect(() => {
    if (waitSec <= 0) return;
    const t = setTimeout(() => setWaitSec((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [waitSec]);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim() || busy || waitSec > 0) return;
    setBusy(true);
    setError(null);
    const result = await submitAccessToken(token);
    setBusy(false);
    if (result.ok) {
      setToken('');
      signInSucceeded();
      return;
    }
    setError(result.error);
    if (result.retryAfterSec) setWaitSec(result.retryAfterSec);
    inputRef.current?.select();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 backdrop-blur-[2px] p-4"
      onKeyDown={(e) => {
        if (e.key === 'Escape') signInCancelled();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="access-token-title"
        aria-describedby="access-token-help"
        onSubmit={submit}
        className="w-full max-w-sm bg-white rounded-2xl border border-slate-200 shadow-xl p-5"
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center">
              <KeyRound size={16} className="text-blue-600" aria-hidden="true" />
            </span>
            <h2 id="access-token-title" className="text-sm font-semibold text-slate-900">
              Access token needed
            </h2>
          </div>
          <button
            type="button"
            onClick={signInCancelled}
            aria-label="Close sign-in"
            className="p-1 rounded text-slate-400 hover:text-slate-700 cursor-pointer focus-visible:outline-2 focus-visible:outline-blue-600"
          >
            <X size={16} />
          </button>
        </div>
        <p id="access-token-help" className="text-xs text-slate-600 leading-relaxed mb-3">
          This server is private. Enter the access token from its owner. You stay signed in on this
          browser for 7 days; the token itself is not saved here.
        </p>
        <label htmlFor="access-token-input" className="sr-only">
          Access token
        </label>
        <input
          ref={inputRef}
          id="access-token-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Access token"
          aria-invalid={Boolean(error)}
          aria-errormessage={error ? 'access-token-error' : undefined}
          className="w-full h-10 px-3 bg-white border border-slate-300 rounded-lg text-sm font-mono text-slate-900 placeholder:text-slate-400 placeholder:font-sans outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/20"
        />
        {error && (
          <p id="access-token-error" role="alert" className="mt-2 text-xs text-red-700">
            {/* During a wait the live countdown replaces the server's fixed "Retry in N s." */}
            {waitSec > 0 ? `${error.replace(/\s*Retry in \d+ s\.?\s*$/i, '')} You can try again in ${waitSec} s.` : error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={signInCancelled}
            className="h-9 px-3.5 text-xs font-semibold text-slate-600 hover:text-slate-900 rounded-lg cursor-pointer focus-visible:outline-2 focus-visible:outline-blue-600"
          >
            Not now
          </button>
          <button
            type="submit"
            disabled={!token.trim() || busy || waitSec > 0}
            className="h-9 px-4 bg-[#1A73E8] hover:bg-[#0B57D0] disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-semibold rounded-lg inline-flex items-center gap-1.5 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            {busy && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
            {waitSec > 0 ? `Wait ${waitSec} s` : 'Sign in'}
          </button>
        </div>
      </form>
    </div>
  );
};
