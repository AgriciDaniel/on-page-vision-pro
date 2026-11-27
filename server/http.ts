// Request and response boundary for the Express routes: one error type with a public message,
// one place that turns any thrown value into a status and a neutral message, and the small
// readers that validate request body fields before they reach a prompt.
import type { Response } from 'express';
import type { AuditGoal, ViewportKey } from '../types.ts';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, publicMessage: string) {
    super(publicMessage);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Status and message that are safe to show to the browser. */
export function toPublicError(err: unknown, fallbackMessage: string): { status: number; message: string } {
  if (err instanceof HttpError) return { status: err.status, message: err.message };

  const e = err as { name?: string; status?: unknown; type?: string; message?: unknown } | null;

  // body-parser errors (Express json middleware)
  if (e?.type === 'entity.too.large') {
    return { status: 413, message: 'The request is too large. Use a smaller or more compressed image.' };
  }
  if (e?.type === 'entity.parse.failed') {
    return { status: 400, message: 'The request body is not valid JSON.' };
  }

  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return { status: 504, message: 'The AI service took too long to answer. Please try again.' };
  }

  // @google/genai ApiError carries the upstream HTTP status
  const upstream = typeof e?.status === 'number' ? e.status : undefined;
  if (upstream !== undefined) {
    if (upstream === 429) {
      return { status: 429, message: 'The AI service is rate limited right now. Try again in a minute.' };
    }
    if (upstream === 401 || upstream === 403) {
      return { status: 502, message: 'The AI service rejected the server API key.' };
    }
    return { status: 502, message: `The AI service returned an error (status ${upstream}).` };
  }

  return { status: 500, message: fallbackMessage };
}

/** Logs the raw error on the server and sends only the public message. */
export function sendError(res: Response, err: unknown, fallbackMessage: string, extra?: Record<string, unknown>): void {
  const { status, message } = toPublicError(err, fallbackMessage);
  if (status >= 500) console.error(`[${status}] ${fallbackMessage}`, err);
  if (res.headersSent) return;
  res.status(status).json({ error: message, ...(extra || {}) });
}

// ---- body field readers ----------------------------------------------------------------

const VIEWPORTS: readonly ViewportKey[] = ['desktop', 'mobile'];
const AUDIT_GOALS: readonly AuditGoal[] = ['general', 'saas-trial', 'b2b-demo', 'ecommerce', 'lead-gen'];

export function readViewport(value: unknown): ViewportKey {
  if (value === undefined || value === null || value === '') return 'desktop';
  if (typeof value === 'string' && (VIEWPORTS as readonly string[]).includes(value)) return value as ViewportKey;
  throw new HttpError(400, 'viewport must be "desktop" or "mobile".');
}

export function readAuditGoal(value: unknown): AuditGoal {
  if (value === undefined || value === null || value === '') return 'general';
  if (typeof value === 'string' && (AUDIT_GOALS as readonly string[]).includes(value)) return value as AuditGoal;
  throw new HttpError(400, `auditGoal must be one of: ${AUDIT_GOALS.join(', ')}.`);
}

/** Optional string, trimmed to maxLength. Non-strings are rejected. */
export function readString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string.`);
  return value.slice(0, maxLength);
}

export function readRequiredString(value: unknown, field: string, maxLength: number): string {
  const s = readString(value, field, maxLength);
  if (!s || !s.trim()) throw new HttpError(400, `${field} is required.`);
  return s;
}

/** Optional array of strings, each trimmed to maxLength, at most maxItems kept. */
export function readStringArray(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, `${field} must be an array of strings.`);
  return value
    .slice(0, maxItems)
    .map((v) => (typeof v === 'string' ? v.slice(0, maxLength) : String(v ?? '').slice(0, maxLength)));
}

export function readArray<T = unknown>(value: unknown, field: string, maxItems: number): T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, `${field} must be an array.`);
  return value.slice(0, maxItems) as T[];
}
