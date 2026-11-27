/**
 * Live progress of a full-page audit (GET /api/audit/progress/<id>, from opus-1), turned into
 * words and a fraction for the progress overlay. Pure, so it is unit tested.
 */
import type { PageAuditProgress, SectionProgressState } from '../../types';

export interface ProgressView {
  /** One line for the pipeline row, e.g. "3 of 7 sections done; running 4, 5". */
  line: string;
  /** 0..1 for this viewport's audit: sections plus the page summary. */
  fraction: number;
  states: SectionProgressState[];
}

const list = (xs: number[]) => xs.map((i) => i + 1).join(', ');

export function describeProgress(p: PageAuditProgress | null | undefined): ProgressView | null {
  if (!p || !p.sections) return null;
  const { total, done, failed, running, states } = p.sections;
  const safeStates = Array.isArray(states) ? states : [];
  const retrying = safeStates.map((s, i) => (s === 'retrying' ? i : -1)).filter((i) => i >= 0);
  const steps = total + 1; // every section plus the page summary
  const finished = done + failed + (p.overview === 'done' || p.overview === 'failed' ? 1 : 0);
  const fraction = total > 0 ? Math.min(1, finished / steps) : 0;
  const extras: string[] = [];
  if (failed > 0) extras.push(`${failed} failed`);
  if (p.retries > 0) extras.push(`${p.retries} ${p.retries === 1 ? 'retry' : 'retries'}`);
  const tail = extras.length ? ` (${extras.join(', ')})` : '';

  let line: string;
  if (p.status === 'failed') line = `Stopped: ${p.error || 'the audit failed'}`;
  else if (p.stage === 'preparing' || total === 0) line = 'Planning the page sections';
  else if (p.stage === 'sections' && done + failed >= total && p.overview === 'pending') {
    // Every section is read and the page summary waits for a free model slot (shared server limit).
    line = `All ${total} sections read; waiting for a free slot to write the page summary` + tail;
  } else if (p.stage === 'sections') {
    // Running sections come from the per-section states when present, so a section the server
    // already marks done can never also be listed as running.
    const runningNow = (Array.isArray(running) ? running : []).filter(
      (i) => !retrying.includes(i) && (safeStates.length === 0 || safeStates[i] === 'running')
    );
    const queued = safeStates.filter((st) => st === 'queued').length;
    // "10 of 14 sections done", not "Section 10 of 14 done", which read as if section 10 were done.
    const parts = [`${done} of ${total} sections done`];
    if (runningNow.length) parts.push(`running ${list(runningNow)}`);
    if (retrying.length) parts.push(`retrying section ${list(retrying)}`);
    // Queued sections wait for one of the server's shared model slots: real waiting, not a hang.
    if (queued > 0) parts.push(runningNow.length || retrying.length ? `${queued} queued` : `${queued} waiting for a free slot`);
    line = parts.join('; ') + tail;
  } else if (p.stage === 'overview') line = `All ${total} sections read; writing the page summary` + tail;
  else line = `${done} of ${total} sections done` + tail;
  return { line, fraction, states: safeStates };
}
