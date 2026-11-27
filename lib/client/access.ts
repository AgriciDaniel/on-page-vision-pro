/**
 * Sign-in gate for a server that needs an access token (opus-1, wave 3). Any API call that gets a
 * 401 waits here while the app shows the sign-in card; after a successful sign-in the server has set
 * an HttpOnly cookie and every waiting call retries once. The token itself never leaves the card's
 * own state: it is not stored in localStorage, sessionStorage or anywhere in this module.
 */

export class SignInCancelledError extends Error {
  constructor() {
    super('This server needs an access token. Sign in to continue.');
    this.name = 'SignInCancelledError';
  }
}

type Waiter = { resolve: () => void; reject: (err: Error) => void };
type Listener = (open: boolean) => void;

const waiters: Waiter[] = [];
const listeners = new Set<Listener>();
let open = false;

function setOpen(next: boolean) {
  if (open === next) return;
  open = next;
  listeners.forEach((l) => l(open));
}

export function isSignInOpen(): boolean {
  return open;
}

/** Follow whether the sign-in card should show. Returns the unsubscribe function. */
export function subscribeSignIn(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Open the sign-in card and wait for it. Resolves after a successful sign-in; rejects with
 * SignInCancelledError when the user closes the card, or with an AbortError when `signal` aborts.
 * Many callers can wait at once; they all share one card.
 */
export function waitForSignIn(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      resolve: () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      reject: (err) => {
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      },
    };
    const onAbort = () => {
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    waiters.push(waiter);
    setOpen(true);
  });
}

/** Open the card without a waiting call, e.g. when the app starts on a server that needs a token. */
export function promptSignIn(): void {
  setOpen(true);
}

/** The card signed in: close it and let every waiting call retry. */
export function signInSucceeded(): void {
  setOpen(false);
  waiters.splice(0).forEach((w) => w.resolve());
}

/** The user closed the card: waiting calls fail with a clear message. */
export function signInCancelled(): void {
  setOpen(false);
  waiters.splice(0).forEach((w) => w.reject(new SignInCancelledError()));
}

/** Read Retry-After (seconds) from a 429; null when absent or not a number. */
export function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : null;
}
