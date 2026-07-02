import { useEffect, useRef } from 'react';
import { ALL_DEMUCS_STEMS, type DemucsJob, type DemucsStem } from '../../hooks/useDemucsStems';

// Terminal-style report for a Demucs stem-separation job — modelled on the
// algorithm-run log panel in InspectorPageV2 (per-target pills + a live,
// auto-scrolling <pre>). Presentation only; the job lifecycle lives in
// useDemucsStems. Shows: which stems already exist on disk, overall tqdm
// progress, elapsed time, and the streamed Demucs output.

function fmtElapsed(sec: number): string {
  if (sec >= 60) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${sec}s`;
}

export function StemsRunLog({
  job,
  elapsedSec,
  presentStems,
  onCancel,
  onKill,
  onDismiss,
}: {
  job: DemucsJob;
  elapsedSec: number;
  /** Stems currently on disk (from the manifest) — "what's been stemmed". */
  presentStems: DemucsStem[];
  onCancel: () => void;
  onKill: () => void;
  onDismiss: () => void;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const logs = job.logs;
  const isRunning = job.status === 'running';
  const present = new Set(presentStems);

  // Auto-scroll to the newest output as it streams in.
  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [logs]);

  const elapsedStr = fmtElapsed(elapsedSec);
  const summary =
    job.status === 'done'      ? { color: 'text-emerald-400', text: `done in ${elapsedStr} — ${present.size}/${ALL_DEMUCS_STEMS.length} stems` } :
    job.status === 'error'     ? { color: 'text-red-400',     text: `failed after ${elapsedStr}` } :
    job.status === 'cancelled' ? { color: 'text-amber-400',   text: `stopped after ${elapsedStr}` } :
    null;

  const StemPill = ({ stem }: { stem: DemucsStem }) => {
    const done = present.has(stem);
    let cls = 'bg-slate-500/15 text-slate-400';
    let icon: React.ReactNode = '⊝';
    if (done) {
      cls = 'bg-emerald-500/15 text-emerald-300'; icon = '✓';
    } else if (isRunning) {
      cls = 'bg-violet-500/15 text-violet-300';
      icon = <span className="inline-block w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin" />;
    }
    return (
      <span className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider ${cls}`}>
        {icon}{stem}
      </span>
    );
  };

  return (
    <div className="rounded-md border border-white/[0.06] bg-[#14171d]/80 p-3 space-y-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-slate-500 mr-1">Demucs stems</span>
        {ALL_DEMUCS_STEMS.map((s) => <StemPill key={s} stem={s} />)}
        {isRunning && (
          <span className="text-[10px] font-mono text-slate-500 ml-1">
            {job.progressPct != null ? `${job.progressPct}% · ` : ''}{elapsedStr}
          </span>
        )}
        {summary && <span className={`text-[10px] font-mono ${summary.color} ml-1`}>{summary.text}</span>}

        {isRunning ? (
          <span className="ml-auto flex items-center gap-1.5 shrink-0">
            {!job.cancelMode && (
              <button
                onClick={onCancel}
                className="text-[10px] px-2 py-0.5 rounded bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 transition-colors"
                title="Stop after the current chunk (SIGINT)."
              >■ Stop</button>
            )}
            {job.cancelMode !== 'hard' && (
              <button
                onClick={onKill}
                className="text-[10px] px-2 py-0.5 rounded bg-red-500/15 hover:bg-red-500/25 text-red-300 transition-colors"
                title="Kill the subprocess immediately (SIGKILL)."
              >✕ Kill</button>
            )}
          </span>
        ) : (
          <button
            onClick={onDismiss}
            className="ml-auto text-[10px] text-slate-600 hover:text-slate-300 shrink-0 transition-colors"
            title="Dismiss"
          >✕</button>
        )}
        <button
          onClick={() => navigator.clipboard.writeText(logs || '(starting…)')}
          title="Copy output"
          className="text-[10px] text-slate-600 hover:text-slate-300 shrink-0 transition-colors"
        >⎘ Copy</button>
      </div>

      {/* Progress bar — only meaningful while a percentage is being parsed. */}
      {isRunning && job.progressPct != null && (
        <div className="h-1 w-full rounded bg-white/[0.06] overflow-hidden">
          <div
            className="h-full bg-violet-500/70 transition-[width] duration-500"
            style={{ width: `${job.progressPct}%` }}
          />
        </div>
      )}

      <pre
        ref={preRef}
        className="text-[10px] text-slate-500 bg-[#0a0b0d] border border-white/[0.04] rounded p-2 max-h-56 overflow-y-auto font-mono whitespace-pre-wrap"
      >
        {logs || '(starting…)'}
      </pre>
    </div>
  );
}
