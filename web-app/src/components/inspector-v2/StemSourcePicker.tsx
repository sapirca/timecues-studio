import { useEffect, useState } from 'react';
import type { StemSource } from '../../pages/InspectorPageV2';
import { useCapabilities } from '../../hooks/useCapabilities';
import { GPU_TOOLS_UNAVAILABLE_HINT } from '../../services/capabilities';

interface StemSourcePickerProps {
  value: StemSource;
  available: StemSource[];
  onChange: (next: StemSource) => void;
  /** Hide entirely when the active song has no stems cached. */
  hideWhenNoStems?: boolean;
  /**
   * Trigger Demucs stem separation for the currently selected song.
   *
   * When provided, the picker surfaces a "▶ Stem this song" button next to
   * the "no stems cached" hint. While a job is running the button is
   * replaced by a "⏳ Stemming… N% · MM:SS" pill (parsed from Demucs's
   * tqdm output) with the current step as a dim subtitle. On failure the
   * pill flips to a persistent red "✗ Stems failed — view log" that opens
   * a modal showing the tail of the Demucs log.
   *
   * Intended for the Dataset Prep workspace.
   */
  onRunStems?: () => void;
  runStemsStatus?: 'idle' | 'running' | 'error';
  runStemsProgressPct?: number;
  runStemsElapsedSec?: number;
  runStemsLastLine?: string;
  /** Set when the user has hit Cancel or Kill — pill swaps to a "⌛ Cancelling…"
   *  / "⌛ Killing…" label while we wait for the subprocess to exit. */
  runStemsCancelMode?: 'soft' | 'hard';
  /** SIGINT the demucs subprocess (graceful — lands between chunks). */
  onCancelStems?: () => void;
  /** SIGKILL the demucs subprocess group (immediate, no cleanup). */
  onKillStems?: () => void;
  runStemsErrorTail?: string;
  onDismissStemsError?: () => void;
  /**
   * True once the selected song's audio buffer has decoded. The "no stems
   * cached" amber label is suppressed until this flips true, so the warning
   * doesn't flash while the manifest fetch and audio decode are still in
   * flight (during that window we don't yet know whether stems exist).
   */
  isSongLoaded?: boolean;
}

const STEM_LABELS: Record<StemSource, string> = {
  mix:    'Full mix',
  vocals: 'Vocals',
  drums:  'Drums',
  bass:   'Bass',
  other:  'Other',
  guitar: 'Guitar',
  piano:  'Piano',
};

const ALL_STEMS: StemSource[] = ['mix', 'vocals', 'drums', 'bass', 'other', 'guitar', 'piano'];

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function StemSourcePicker({
  value,
  available,
  onChange,
  hideWhenNoStems = false,
  onRunStems,
  runStemsStatus = 'idle',
  runStemsProgressPct,
  runStemsElapsedSec,
  runStemsLastLine,
  runStemsCancelMode,
  onCancelStems,
  onKillStems,
  runStemsErrorTail,
  onDismissStemsError,
  isSongLoaded = true,
}: StemSourcePickerProps) {
  const { capabilities } = useCapabilities();
  const demucsInstalled = capabilities.demucs;
  const hasStems = available.some((s) => s !== 'mix');
  const isStemming = runStemsStatus === 'running';
  const isError = runStemsStatus === 'error';
  const [showErrorLog, setShowErrorLog] = useState(false);

  // Auto-close the error modal if the parent clears the error state
  // (user clicked Dismiss or Retry — either way the modal is now stale).
  useEffect(() => {
    if (!isError) setShowErrorLog(false);
  }, [isError]);

  if (hideWhenNoStems && !hasStems && demucsInstalled && !isStemming && !isError) return null;

  // Per-stem disabled-state title is one of three messages:
  // 1. no Demucs profile running → "Requires demucs-gpu or demucs-cpu profile…"
  // 2. installed, no stems       → "No cached stem for this song — run …"
  // 3. installed, has stems      → "Play vocals"
  const disabledTitle = demucsInstalled
    ? (onRunStems
        ? 'No cached stem for this song — click "Stem this song" to run Demucs.'
        : 'No cached stem for this song — run tools/run_demucs_songs.py')
    : GPU_TOOLS_UNAVAILABLE_HINT;

  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <span className="text-[10px] uppercase tracking-wide text-slate-500 shrink-0">Source</span>
      <div className="flex flex-wrap items-center gap-1">
        {ALL_STEMS.map((s) => {
          const isAvailable = available.includes(s);
          const isActive = value === s;
          return (
            <button
              key={s}
              type="button"
              disabled={!isAvailable}
              onClick={() => onChange(s)}
              className={[
                'px-2.5 py-1 rounded-full text-xs transition-colors border',
                isActive
                  ? 'bg-slate-200 text-slate-900 border-slate-200'
                  : isAvailable
                    ? 'bg-[#1a1f28] text-slate-300 border-white/10 hover:bg-[#222833] hover:border-white/20'
                    : 'bg-[#14171d] text-slate-600 border-white/[0.04] cursor-not-allowed',
              ].join(' ')}
              title={isAvailable ? `Play ${STEM_LABELS[s].toLowerCase()}` : disabledTitle}
            >
              {STEM_LABELS[s]}
            </button>
          );
        })}
        {!hasStems && !isStemming && !isError && isSongLoaded && (
          <span
            className="text-[10px] text-amber-400/70 ml-1"
            title={disabledTitle}
          >
            {demucsInstalled ? 'no stems cached' : 'stem tools not installed'}
          </span>
        )}
        {onRunStems && demucsInstalled && (
          isStemming ? (
            <div className="ml-1 flex flex-col gap-0.5 min-w-0">
              <div className="flex items-center gap-1 flex-wrap">
                <span
                  className={[
                    'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border',
                    runStemsCancelMode
                      ? 'border-amber-500/50 bg-amber-500/15 text-amber-200'
                      : 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200',
                  ].join(' ')}
                  title={runStemsCancelMode === 'hard'
                    ? 'Stop signal sent to the demucs subprocess group (SIGKILL). Should land within a second.'
                    : runStemsCancelMode === 'soft'
                      ? 'Cancel signal sent to demucs (SIGINT). It will exit at the next chunk boundary — usually a few seconds.'
                      : 'Demucs is splitting this song into vocals/drums/bass/other. This usually takes a few minutes.'}
                >
                  <span aria-hidden="true">⏳</span>
                  <span>
                    {runStemsCancelMode === 'hard' ? 'Killing…'
                      : runStemsCancelMode === 'soft' ? 'Cancelling…'
                      : 'Stemming…'}
                  </span>
                  {runStemsProgressPct !== undefined && !runStemsCancelMode && (
                    <span className="font-mono tabular-nums">{runStemsProgressPct}%</span>
                  )}
                  {runStemsElapsedSec !== undefined && (
                    <>
                      {runStemsProgressPct !== undefined && !runStemsCancelMode && (
                        <span aria-hidden="true" className="opacity-50">·</span>
                      )}
                      <span className="font-mono tabular-nums opacity-80">{formatElapsed(runStemsElapsedSec)}</span>
                    </>
                  )}
                </span>
                {/* Cancel: graceful. Hidden once cancel/kill has been requested. */}
                {onCancelStems && !runStemsCancelMode && (
                  <button
                    type="button"
                    onClick={onCancelStems}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 hover:border-amber-500/60 transition-colors"
                    title="Cancel: ask Demucs to stop gracefully at the next chunk boundary (usually a few seconds)."
                  >
                    <span aria-hidden="true">⏸</span>
                    <span>Cancel</span>
                  </button>
                )}
                {/* Kill: force. Stays available as an escalation while a soft cancel is in flight. */}
                {onKillStems && (
                  <button
                    type="button"
                    onClick={onKillStems}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 hover:border-red-500/60 transition-colors"
                    title={runStemsCancelMode === 'soft'
                      ? 'Kill: SIGKILL the demucs subprocess group now — use if the graceful cancel is taking too long.'
                      : 'Kill: stop the demucs subprocess group immediately (SIGKILL). Partial WAV files on disk will be orphaned.'}
                  >
                    <span aria-hidden="true">🛑</span>
                    <span>Kill</span>
                  </button>
                )}
              </div>
              {runStemsLastLine && (
                <span
                  className="text-[10px] text-slate-500 truncate max-w-[36ch] pl-1 leading-tight"
                  title={runStemsLastLine}
                >
                  {runStemsLastLine}
                </span>
              )}
            </div>
          ) : isError ? (
            <div className="ml-1 inline-flex items-center gap-1 flex-wrap">
              <button
                type="button"
                onClick={() => setShowErrorLog(true)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border border-red-500/50 bg-red-500/15 text-red-200 hover:bg-red-500/25 transition-colors"
                title="Click to view the failure log."
              >
                <span aria-hidden="true">✗</span>
                <span>Stems failed — view log</span>
              </button>
              <button
                type="button"
                onClick={onRunStems}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20 hover:border-cyan-500/60 transition-colors"
                title="Retry the Demucs stem separation for this song."
              >
                <span aria-hidden="true">↻</span>
                <span>Retry</span>
              </button>
              {onDismissStemsError && (
                <button
                  type="button"
                  onClick={onDismissStemsError}
                  className="text-slate-500 hover:text-slate-300 text-xs px-1.5"
                  title="Dismiss this error."
                  aria-label="Dismiss stemming error"
                >
                  ✕
                </button>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={onRunStems}
              className="ml-1 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20 hover:border-cyan-500/60 transition-colors"
              title={hasStems
                ? 'Re-run Demucs stem separation for this song (will ask before overwriting existing stems).'
                : 'Run Demucs stem separation for this song. Generates vocals/drums/bass/other WAVs (~a few minutes).'}
            >
              <span aria-hidden="true">▶</span>
              <span>{hasStems ? 'Re-stem this song' : 'Stem this song'}</span>
            </button>
          )
        )}
      </div>
      {showErrorLog && runStemsErrorTail && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShowErrorLog(false)}
        >
          <div
            className="bg-[#1a1f28] border border-red-500/40 rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-2 border-b border-white/10">
              <h3 className="text-sm text-red-300">✗ Demucs stemming failed</h3>
              <button
                type="button"
                onClick={() => setShowErrorLog(false)}
                className="text-slate-400 hover:text-slate-200 text-base leading-none px-1"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <pre className="flex-1 overflow-auto p-3 text-[11px] font-mono text-slate-300 whitespace-pre-wrap leading-snug">
              {runStemsErrorTail}
            </pre>
            <div className="px-4 py-2 border-t border-white/10 text-[10px] text-slate-500">
              Full log is also in the browser console — filter for <span className="text-slate-300 font-mono">[stems]</span>.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
