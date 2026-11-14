import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { StemSource } from '../../pages/InspectorPageV2';
import { useCapabilities } from '../../hooks/useCapabilities';
import { GPU_TOOLS_UNAVAILABLE_HINT } from '../../services/capabilities';
import { DEMUCS_MODEL_OPTIONS, KIT_PART_LABELS, type DemucsModel, type KitPart } from '../../hooks/useDemucsStems';

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
  /**
   * How many stems a (re-)run should produce — '6s' (vocals/drums/bass/other/
   * guitar/piano) or '4s' (vocals/drums/bass/other, quicker). Rendered as a
   * two-button segmented control beside the stem button; the parent owns the
   * value so it can seed it from Settings and reuse it for the automatic
   * post-upload runs.
   */
  stemModel?: DemucsModel;
  onStemModelChange?: (next: DemucsModel) => void;
  /** Model of the job currently running — named in the progress pill so a
   *  long 6-stem run is legible as such. */
  runStemsModel?: DemucsModel;
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
  /** Pieces of the drum kit split out of the drums stem (empty when it has not
   *  been split). Offered as a row of their own under Drums: choosing one
   *  plays that piece and keeps the stem Drums, so everything that follows
   *  the stem — the lock, the drum lanes — stays on drums. */
  kitParts?: KitPart[];
  /** The piece playing, or null for the whole drums stem. */
  kitPart?: KitPart | null;
  onKitPartChange?: (next: KitPart | null) => void;
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

/** "6 stems" / "4 stems" — the user-facing name of a separation model. */
function modelLabel(model: DemucsModel): string {
  return DEMUCS_MODEL_OPTIONS.find((o) => o.id === model)?.label ?? model;
}

/**
 * How tightly the row is packed so it stays on one line: 0 is the roomy
 * default, each step trims padding and gaps, the last also shortens the stem
 * button's label. Only when even that overflows does the row wrap.
 */
type Density = 0 | 1 | 2 | 3;
const MAX_DENSITY: Density = 3;

function pillPad(density: Density): string {
  return density === 0 ? 'px-2.5' : density === 1 ? 'px-2' : 'px-1.5';
}

/**
 * Fit a row on one line: each time its width or `contentKey` (which controls
 * it shows) changes, start roomy and step tighter while it overflows. The
 * steps happen in a layout effect, so the overflowing passes never paint.
 * Kept out of the component so the one lint suppression below — measuring
 * then re-rendering is what a layout effect is for — covers only this.
 */
function useOneLineDensity(contentKey: string) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [rowWidth, setRowWidth] = useState(0);
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setRowWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fitKey = `${rowWidth}|${contentKey}`;
  const [fit, setFit] = useState<{ key: string; density: Density }>({ key: '', density: 0 });
  const density: Density = fit.key === fitKey ? fit.density : 0;
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (el && density < MAX_DENSITY && el.scrollWidth > el.clientWidth + 1) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFit({ key: fitKey, density: (density + 1) as Density });
    }
  }, [density, fitKey]);
  return { rowRef, density };
}

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
  stemModel = '4s',
  onStemModelChange,
  runStemsModel,
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
  kitParts = [],
  kitPart = null,
  onKitPartChange,
}: StemSourcePickerProps) {
  const { capabilities } = useCapabilities();
  const demucsInstalled = capabilities.demucs;
  const hasStems = available.some((s) => s !== 'mix');
  const isStemming = runStemsStatus === 'running';
  const isError = runStemsStatus === 'error';
  const [showErrorLog, setShowErrorLog] = useState(false);

  const { rowRef, density } = useOneLineDensity([
    available.join(','), value === 'drums' ? kitParts.length : 0,
    runStemsStatus, runStemsCancelMode ?? '', isSongLoaded, demucsInstalled, !!onStemModelChange,
  ].join('|'));
  const pad = pillPad(density);
  const gap = density === 0 ? 'gap-1' : 'gap-0.5';

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
    <div ref={rowRef} className={`flex items-center ${density === 0 ? 'gap-2' : 'gap-1.5'} px-2 py-1.5 min-w-0`}>
      <span className="text-[10px] uppercase tracking-wide text-slate-500 shrink-0">Source</span>
      <div className={`flex ${density === MAX_DENSITY ? 'flex-wrap' : 'flex-nowrap'} items-center ${gap}`}>
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
                `${pad} py-1 rounded-full text-xs whitespace-nowrap transition-colors border`,
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
        {value === 'drums' && kitParts.length > 0 && onKitPartChange && (
          <KitPartRow parts={kitParts} value={kitPart} onChange={onKitPartChange} density={density} />
        )}
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
                      : runStemsModel
                        ? DEMUCS_MODEL_OPTIONS.find((o) => o.id === runStemsModel)?.hint
                        : 'Demucs is splitting this song into vocals/drums/bass/other. This usually takes a few minutes.'}
                >
                  <span aria-hidden="true">⏳</span>
                  <span>
                    {runStemsCancelMode === 'hard' ? 'Killing…'
                      : runStemsCancelMode === 'soft' ? 'Cancelling…'
                      : runStemsModel ? `Stemming (${modelLabel(runStemsModel)})…`
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
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs whitespace-nowrap border border-red-500/50 bg-red-500/15 text-red-200 hover:bg-red-500/25 transition-colors"
                title="Click to view the failure log."
              >
                <span aria-hidden="true">⚠</span>
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
                  className="inline-flex items-center justify-center w-7 h-7 rounded-full text-xs border border-white/15 text-slate-400 hover:text-slate-200 hover:border-white/30 hover:bg-white/5 transition-colors"
                  title="Dismiss this error."
                  aria-label="Dismiss stemming error"
                >
                  ✕
                </button>
              )}
            </div>
          ) : (
            <div className={`ml-1 inline-flex items-center ${density === 0 ? 'gap-1.5' : 'gap-1'}`}>
              <button
                type="button"
                onClick={onRunStems}
                className={`inline-flex items-center gap-1 ${pad} py-1 rounded-full text-xs whitespace-nowrap border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20 hover:border-cyan-500/60 transition-colors`}
                title={hasStems
                  ? `Re-run Demucs stem separation for this song as ${modelLabel(stemModel)} (will ask before overwriting existing stems).`
                  : `Run Demucs stem separation for this song as ${modelLabel(stemModel)} (~a few minutes).`}
              >
                <span aria-hidden="true">▶</span>
                <span>{density >= 2
                  ? (hasStems ? 'Re-stem' : 'Stem')
                  : (hasStems ? 'Re-stem this song' : 'Stem this song')}</span>
              </button>
              {/* How many stems that run should produce. Sits next to the button
                  rather than behind a menu because it changes both how long the
                  run takes and what the SOURCE row above will offer afterwards. */}
              {onStemModelChange && (
                <div
                  className="inline-flex items-center rounded-full border border-white/10 bg-[#14171d] overflow-hidden"
                  role="group"
                  aria-label="Number of stems to separate into"
                >
                  {DEMUCS_MODEL_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => onStemModelChange(opt.id)}
                      aria-pressed={stemModel === opt.id}
                      className={[
                        `${density === 0 ? 'px-2' : 'px-1.5'} py-1 text-[11px] whitespace-nowrap transition-colors`,
                        stemModel === opt.id
                          ? 'bg-slate-200 text-slate-900'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-white/5',
                      ].join(' ')}
                      title={opt.hint}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
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

/** The drum kit's pieces, as a sub-choice of Drums: "All" is the whole drums
 *  stem. Set apart from the stem pills by a rule and smaller pills, so it reads
 *  as a choice inside Drums rather than six more stems. */
function KitPartRow({ parts, value, onChange, density }: {
  parts: KitPart[];
  value: KitPart | null;
  onChange: (next: KitPart | null) => void;
  density: Density;
}) {
  const options: (KitPart | null)[] = [null, ...parts];
  return (
    <div
      className={`inline-flex items-center ${density === 0 ? 'gap-1 pl-2 ml-1' : 'gap-0.5 pl-1.5 ml-0.5'} border-l border-white/10`}
      role="group"
      aria-label="Drum kit piece to play"
    >
      <span className="text-[10px] uppercase tracking-wide text-slate-500 mr-0.5">Kit</span>
      {options.map((p) => {
        const isActive = value === p;
        return (
          <button
            key={p ?? 'all'}
            type="button"
            onClick={() => onChange(p)}
            aria-pressed={isActive}
            data-testid={`kit-part-${p ?? 'all'}`}
            className={[
              `${density === 0 ? 'px-2' : 'px-1.5'} py-0.5 rounded-full text-[11px] whitespace-nowrap transition-colors border`,
              isActive
                ? 'bg-cyan-200 text-slate-900 border-cyan-200'
                : 'bg-[#1a1f28] text-slate-300 border-white/10 hover:bg-[#222833] hover:border-white/20',
            ].join(' ')}
            title={p ? `Play only the ${KIT_PART_LABELS[p].toLowerCase()}, separated from the drums stem` : 'Play the whole drums stem'}
          >
            {p ? KIT_PART_LABELS[p] : 'All'}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The stem choice as one small dropdown, for the slim sticky transport: once
 * the player has scrolled away its pill row goes with it, and the stem is
 * still something you want to flip while listening. Same `value` / `onChange`
 * as the picker above, so both always show the stem that is playing. Shown
 * only when there is something to choose between.
 */
export function StemSourceSelect({
  value,
  available,
  onChange,
  kitParts = [],
  kitPart = null,
  onKitPartChange,
}: Pick<StemSourcePickerProps, 'value' | 'available' | 'onChange' | 'kitParts' | 'kitPart' | 'onKitPartChange'>) {
  if (!available.some((s) => s !== 'mix')) return null;
  const isMix = value === 'mix';
  const withKit = kitParts.length > 0 && !!onKitPartChange && available.includes('drums');
  // A kit piece is the drums stem, narrowed: "drums/kick".
  const selected = value === 'drums' && kitPart && withKit ? `drums/${kitPart}` : value;
  return (
    <div
      className={`relative inline-flex items-center gap-1.5 h-8 pl-2 pr-1.5 text-[11px] rounded border transition-colors cursor-pointer focus-within:ring-1 focus-within:ring-cyan-500/50 ${
        isMix
          ? 'bg-white/[0.05] hover:bg-white/[0.10] border-white/[0.22] text-slate-100'
          : 'bg-cyan-500/15 hover:bg-cyan-500/20 border-cyan-500/50 text-cyan-100'
      }`}
    >
      <span className="text-[10px] uppercase tracking-wide text-slate-500" aria-hidden="true">Stem</span>
      <span aria-hidden="true">
        {STEM_LABELS[value]}
        {value === 'drums' && kitPart && withKit && <> · {KIT_PART_LABELS[kitPart]}</>}
      </span>
      <svg className="shrink-0 opacity-70" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
        <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <select
        value={selected}
        onChange={(e) => {
          const [stem, part] = e.target.value.split('/') as [StemSource, KitPart | undefined];
          onChange(stem);
          if (withKit) onKitPartChange!(part ?? null);
        }}
        title="Which stem the player plays"
        aria-label="Stem"
        data-testid="slim-stem-source"
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
      >
        {ALL_STEMS.filter((s) => available.includes(s)).map((s) => (
          <option key={s} value={s}>{STEM_LABELS[s]}</option>
        ))}
        {withKit && (
          <optgroup label="Drum kit">
            {kitParts.map((p) => (
              <option key={p} value={`drums/${p}`}>{KIT_PART_LABELS[p]}</option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  );
}
