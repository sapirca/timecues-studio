/**
 * detectorRunLog — a detector run, told as the lines the run log panel shows.
 *
 * A run from the Detectors sidebar is one request that comes back with an
 * envelope, not a server job with a log to poll, so the panel's text is built
 * from the envelope instead: what ran, how long it took, what it kept, what it
 * said about the run, and — when it failed — the error and the traceback. The
 * traceback is the part an annotator was missing: without it a red "failed"
 * says that something broke and nothing about what.
 */

import { strictnessLevel, strictnessName, type CustomResultEnvelope } from '../types/customScript';

/** The run log panel's job id for runs started from the Detectors sidebar. */
export const DETECTOR_LOG_JOB = 'detector-sidebar';

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function indent(text: string, pad: string): string {
  return text.replace(/\s+$/, '').split('\n').map((l) => pad + l).join('\n');
}

/** The lines for one run: a "▶ <label>" header, then what came of it. */
export function formatDetectorRun(label: string, env: CustomResultEnvelope): string {
  const out = [`▶ ${label}`];
  const when = env.ran_at ? ` · ran ${env.ran_at}` : '';
  if (env.fatal) {
    out.push(`  ✗ failed — ${env.fatal.type}: ${env.fatal.message}${when}`);
    if (env.fatal.suggested_install) out.push(`    to fix: ${env.fatal.suggested_install}`);
    if (env.fatal.traceback?.trim()) out.push(indent(env.fatal.traceback, '    '));
  } else {
    const n = env.items.length;
    const at = env.strictness !== undefined ? ` at strictness ${strictnessName(strictnessLevel(env.strictness))}` : '';
    out.push(`  ✓ ${n === 0 ? 'nothing found' : `${n} item${n === 1 ? '' : 's'}`} in ${seconds(env.duration_ms)}${at}${when}`);
  }
  for (const note of env.notes ?? []) out.push(`  note: ${note.message}`);
  if (env.errors.length > 0) {
    out.push(`  rejected ${env.errors.length} item${env.errors.length === 1 ? '' : 's'}:`);
    for (const e of env.errors) {
      const where = [e.index != null ? `#${e.index}` : null, e.field].filter(Boolean).join(' ');
      out.push(`    ${where ? `${where}: ` : ''}${e.message}`);
    }
  }
  return out.join('\n') + '\n';
}
