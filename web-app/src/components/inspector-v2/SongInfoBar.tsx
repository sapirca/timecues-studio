import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { SongInfo, GridMode } from '../../types/songInfo';
import { isAnchorMode } from '../../types/songInfo';

const COMMON_TIME_SIGNATURES = ['4/4', '3/4', '6/8', '5/4', '7/8', '2/4', '12/8'];
const BPM_MIN = 20;
const BPM_MAX = 300;

export interface BpmSuggestion {
  /** Detector label, e.g. 'librosa-beat-track', 'madmom-tempo'. */
  source: string;
  bpm: number;
  /** Optional madmom-style strength (0–1). Higher = more confident. */
  strength?: number;
}

export interface SongInfoBarProps {
  songInfo: SongInfo | null;
  onChange: (info: SongInfo) => void;
  /** Auto-detected BPM candidates from one or more detectors. The user picks. */
  suggestedBpms?: BpmSuggestion[];
  /** Optional auto-detected time signature (e.g. `"4/4"`, `"3/4"`) from BeatNet.
   *  Rendered as a click-to-apply chip next to the Time Signature select.
   *  Omitted when no detector returns one. */
  suggestedTimeSignature?: string | null;
  /** Status of the detection run (idle/running/done/error). */
  bpmDetectionStatus?: 'idle' | 'running' | 'done' | 'error';
  /** Optional message when status === 'error' (e.g. "BPM server not running"). */
  bpmDetectionError?: string;
  /** Called when the user clicks "Re-run" — host runs detection with force=true. */
  onRerunBpmDetection?: () => void;
  /** Snaps gridOffset to the current playhead time. Hidden when not provided. */
  onAlignGridToPlayhead?: () => void;
  /** Current player time in seconds — shown inside the "Set bar start" button
   *  so the user can see what offset they're about to capture. */
  playerTime?: number;
  /** When true, the BPM / time-sig / offset inputs are read-only — used to
   *  block non-admin viewers from editing the dataset's grid params. */
  locked?: boolean;
  /** When true, suppress the outer card chrome + "Song info" title — caller
   *  is wrapping this in their own container (e.g. CollapsibleSection). */
  embedded?: boolean;
  /** Optional content rendered at the bottom of the card. The DataPrep
   *  workspace passes a <GridModeControls /> here; other workspaces leave
   *  it undefined so no grid-mode controls show. */
  extraControls?: ReactNode;
  /** Active grid mode. When 'dynamic' or 'manual', the global BPM input,
   *  Grid Offset input, Set bar start button, and Auto-detected chips are
   *  hidden (they're static-only concerns); the host should render an
   *  anchor list via `anchorListSlot` instead. Time Signature stays
   *  visible regardless — it applies to both static and anchored grids. */
  gridMode?: GridMode;
  /** Slot rendered in place of the BPM / offset / detected-chips section
   *  when `gridMode` is an anchor mode. DataPrep injects
   *  <AnchorListEditor /> here. */
  anchorListSlot?: ReactNode;
}

export function SongInfoBar({
  songInfo,
  onChange,
  suggestedBpms,
  suggestedTimeSignature,
  bpmDetectionStatus = 'idle',
  bpmDetectionError,
  onRerunBpmDetection,
  onAlignGridToPlayhead,
  playerTime,
  locked = false,
  embedded = false,
  extraControls,
  gridMode,
  anchorListSlot,
}: SongInfoBarProps) {
  const anchored = isAnchorMode(gridMode);
  const update = useCallback(<K extends keyof SongInfo>(key: K, value: SongInfo[K]) => {
    if (!songInfo) return;
    onChange({ ...songInfo, [key]: value, updated_at: new Date().toISOString() });
  }, [songInfo, onChange]);

  const bpm = songInfo?.bpm;
  const timeSignature = songInfo?.timeSignature ?? '4/4';
  const gridOffset = songInfo?.gridOffset ?? 0;
  const bpmMissing = !bpm || bpm <= 0;
  const hasGrid = !!bpm && bpm > 0;
  const beatsPerBar = (() => {
    const top = parseInt((timeSignature ?? '4/4').split('/')[0], 10);
    return Number.isFinite(top) && top > 0 ? top : 4;
  })();
  const beatDuration = bpm ? 60 / bpm : 0;
  const barDuration = beatDuration * beatsPerBar;

  const nudgeOffset = useCallback((deltaSeconds: number) => {
    if (locked || !songInfo) return;
    const next = Math.max(0, (songInfo.gridOffset ?? 0) + deltaSeconds);
    update('gridOffset', Math.round(next * 1000) / 1000);
  }, [locked, songInfo, update]);

  // Local text state so the user can type intermediate values (e.g. "1" on the
  // way to "120") without committing out-of-range BPMs to song state — a stray
  // BPM like 1251 freezes the UI by exploding the beat-grid line count.
  const [bpmText, setBpmText] = useState(bpm != null ? String(bpm) : '');
  useEffect(() => { setBpmText(bpm != null ? String(bpm) : ''); }, [bpm]);
  const bpmTextNum = parseFloat(bpmText);
  const bpmOutOfRange = bpmText !== '' && (!Number.isFinite(bpmTextNum) || bpmTextNum < BPM_MIN || bpmTextNum > BPM_MAX);

  // Same pattern for grid offset — without local text state, the input value
  // gets snapped back to gridOffset.toFixed(3) on every keystroke, so the user
  // can't backspace digits or clear the field.
  const [gridOffsetText, setGridOffsetText] = useState(gridOffset === 0 ? '' : gridOffset.toFixed(3));
  useEffect(() => {
    setGridOffsetText((prev) => {
      const parsed = parseFloat(prev);
      if (Number.isFinite(parsed) && Math.abs(parsed - gridOffset) < 1e-6) return prev;
      return gridOffset === 0 ? '' : gridOffset.toFixed(3);
    });
  }, [gridOffset]);

  const validSuggestions = (suggestedBpms ?? []).filter(
    (s) => Number.isFinite(s.bpm) && s.bpm >= BPM_MIN && s.bpm <= BPM_MAX,
  );

  const applyBpm = useCallback((next: number) => {
    update('bpm', parseFloat(next.toFixed(2)));
  }, [update]);

  const containerClass = embedded
    ? 'space-y-2'
    : 'rounded-md border border-white/[0.06] bg-[#14171d]/80 p-3 space-y-2';

  return (
    <div className={containerClass}>
      {!embedded && (
        <div className="flex items-center">
          <span className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-200">Song info</span>
        </div>
      )}

      {/* ─── GRID MODE ───────────────────────────────────────────────────
          Pick the grid model first (Static / Dynamic / Manual). The Tempo
          and Grid-alignment subsections below adapt to the active mode:
          Static gets BPM + offset + nudge; anchor modes get the anchor list
          rendered below in place of Grid alignment. */}
      {extraControls}

      {/* ─── TEMPO ───────────────────────────────────────────────────────
          What's the song's tempo? Auto-detected suggestions come first
          (the easy path), then the manual BPM + Time Signature inputs. */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-300">Tempo</span>
          {!anchored && bpmOutOfRange ? (
            <span className="text-[10px] text-red-400 font-mono">⚠ BPM must be {BPM_MIN}–{BPM_MAX}</span>
          ) : !anchored && bpmMissing ? (
            <span className="text-[10px] text-amber-400 font-mono">⚠ BPM required to start annotating</span>
          ) : null}
        </div>

        {/* Detected BPM suggestions — one chip per detector. Click to apply.
            Static-only: in anchor modes, per-anchor BPM is edited inline in
            the anchor list, and these global-tempo chips don't apply. */}
        {!anchored && (bpmDetectionStatus !== 'idle' || validSuggestions.length > 0) && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-slate-500 uppercase tracking-wider">Auto-detected</span>
              <div className="flex items-center gap-2">
                {bpmDetectionStatus === 'running' && (
                  <span className="text-[10px] font-mono text-violet-400 animate-pulse">detecting…</span>
                )}
                {bpmDetectionStatus === 'error' && (
                  <span className="text-[10px] font-mono text-amber-400" title={bpmDetectionError}>
                    ⚠ {bpmDetectionError ?? 'detection failed'}
                  </span>
                )}
                {onRerunBpmDetection && bpmDetectionStatus !== 'running' && (
                  <button
                    onClick={onRerunBpmDetection}
                    className="text-[10px] font-mono text-slate-500 hover:text-slate-300 transition-colors"
                    title="Re-run all detectors (ignores cache)"
                  >
                    ↻ Re-run
                  </button>
                )}
              </div>
            </div>
            {validSuggestions.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {validSuggestions.map((s, i) => {
                  const isCurrent = bpm != null && Math.abs(bpm - s.bpm) < 0.05;
                  return (
                    <button
                      key={`${s.source}-${i}`}
                      onClick={() => applyBpm(s.bpm)}
                      disabled={isCurrent || locked}
                      className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-colors flex items-center gap-1.5 ${
                        isCurrent
                          ? 'border-violet-500/30 bg-violet-500/15 text-violet-200 cursor-default'
                          : 'border-white/[0.08] bg-white/[0.02] text-slate-300 hover:border-violet-500/40 hover:bg-violet-500/10 hover:text-violet-200'
                      }`}
                      title={`Set BPM = ${s.bpm.toFixed(2)} (${s.source})`}
                    >
                      <span className="text-slate-500">{s.source}</span>
                      <span className="tabular-nums">{s.bpm.toFixed(2)}</span>
                      {s.strength != null && (
                        <span className="text-slate-600">·{s.strength.toFixed(2)}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : bpmDetectionStatus === 'done' ? (
              <span className="text-[10px] font-mono text-slate-500">No detector returned a usable BPM.</span>
            ) : null}
          </div>
        )}

        <div className={`grid gap-4 ${anchored ? 'grid-cols-1' : 'grid-cols-2'}`}>
          {!anchored && (
            <div className="space-y-1.5">
              <label className="text-[10px] text-slate-500 uppercase tracking-wider">BPM</label>
              <input
                type="number" min={BPM_MIN} max={BPM_MAX} step="0.01"
                value={bpmText}
                disabled={locked}
                onChange={(e) => {
                  const text = e.target.value;
                  setBpmText(text);
                  if (text === '') { update('bpm', undefined); return; }
                  const v = parseFloat(text);
                  if (Number.isFinite(v) && v >= BPM_MIN && v <= BPM_MAX) update('bpm', v);
                }}
                onBlur={() => { if (bpmOutOfRange) setBpmText(bpm != null ? String(bpm) : ''); }}
                placeholder=""
                className={`w-full bg-[#0a0b0d] border text-slate-200 text-xs rounded px-2.5 py-1 font-mono focus:outline-none transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
                  bpmOutOfRange ? 'border-red-500/40 focus:border-red-500/70 focus:ring-1 focus:ring-red-500/40'
                    : bpmMissing ? 'border-amber-500/40 focus:border-amber-500/70 focus:ring-1 focus:ring-amber-500/40'
                    : 'border-white/[0.08] focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/50'
                }`}
              />
            </div>
          )}
          <div className="space-y-1.5">
            <label className="text-[10px] text-slate-500 uppercase tracking-wider">Time Signature</label>
            <select
              value={COMMON_TIME_SIGNATURES.includes(timeSignature) ? timeSignature : '__custom__'}
              disabled={locked}
              onChange={(e) => { if (e.target.value !== '__custom__') update('timeSignature', e.target.value); }}
              className="w-full bg-[#0a0b0d] border border-white/[0.08] text-slate-200 text-xs rounded px-2 py-1 font-mono focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {COMMON_TIME_SIGNATURES.map((ts) => <option key={ts} value={ts}>{ts}</option>)}
              {!COMMON_TIME_SIGNATURES.includes(timeSignature) && (
                <option value="__custom__">{timeSignature || 'custom'}</option>
              )}
            </select>
            {/* Auto-detected meter suggestion (BeatNet, experimental). Only
                rendered when the upstream detector returned one AND it differs
                from the currently-selected time signature. */}
            {suggestedTimeSignature && suggestedTimeSignature !== timeSignature && (
              <button
                type="button"
                disabled={locked}
                onClick={() => update('timeSignature', suggestedTimeSignature)}
                title={`BeatNet detected ${suggestedTimeSignature}. Click to apply.`}
                className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border border-violet-400/30 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                BeatNet: {suggestedTimeSignature}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ─── GRID ALIGNMENT ──────────────────────────────────────────────
          Where does bar 1 start, and is the grid locked to the kick?
          Static-only — anchor modes get the AnchorListEditor slot instead. */}
      {!anchored && (
        <div className="pt-2 border-t border-white/[0.04] space-y-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span
              className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-300"
              title="Where bar 1 starts in the song. Three ways to set it: type a value, capture the playhead with Set bar start, or use the Nudge buttons. Easiest with the Metronome below switched on so you can hear the realignment."
            >
              Grid alignment
            </span>
            {!locked && onAlignGridToPlayhead && (
              <button
                type="button"
                onClick={onAlignGridToPlayhead}
                title="Capture the current playhead time as bar 1. Shortcut: G (or hold Alt and drag the waveform to slide the grid). One-shot — does not toggle."
                className="inline-flex items-center gap-2 px-2.5 py-1 rounded text-[10px] uppercase tracking-wider border border-slate-600/60 bg-slate-800/40 text-slate-300 hover:bg-slate-700/60 hover:border-slate-500 hover:text-slate-100 active:bg-slate-600/80 active:scale-[0.97] transition-all duration-75"
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="8" y1="2" x2="8" y2="14" />
                  <polyline points="3,5 6,8 3,11" />
                  <polyline points="13,5 10,8 13,11" />
                </svg>
                <span>Set bar start</span>
                {playerTime != null && (
                  <>
                    <span className="text-slate-500">→</span>
                    <span className="font-mono tabular-nums text-slate-100 normal-case tracking-normal">{(() => {
                      const t = Math.max(0, playerTime);
                      const m = Math.floor(t / 60);
                      const s = (t - m * 60).toFixed(3).padStart(6, '0');
                      return `${m}:${s}`;
                    })()}</span>
                  </>
                )}
                <span className="text-slate-500 font-mono">(G)</span>
              </button>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] text-slate-500 uppercase tracking-wider">Grid Offset (s)</label>
            <input
              type="number" min="0" step="0.001"
              value={gridOffsetText}
              disabled={locked}
              onChange={(e) => {
                const text = e.target.value;
                setGridOffsetText(text);
                if (text === '') { update('gridOffset', 0); return; }
                const v = parseFloat(text);
                if (Number.isFinite(v)) update('gridOffset', v);
              }}
              onBlur={() => {
                const v = parseFloat(gridOffsetText);
                setGridOffsetText(Number.isFinite(v) && v !== 0 ? v.toFixed(3) : '');
              }}
              placeholder="0.000"
              className="w-full bg-[#0a0b0d] border border-white/[0.08] text-slate-200 text-xs rounded px-2.5 py-1 font-mono focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            />
          </div>

          {/* Nudge grid offset — fine-tune the static gridOffset with fixed-
              size steps. Easiest to use while the Metronome below is on, so
              you can hear the realignment in real time. */}
          <div className="space-y-1.5">
            <span
              className="text-[10px] text-slate-500 uppercase tracking-wider"
              title="Shift the grid offset by a fixed amount. Use ±1ms / ±10ms for fine alignment, ±1 beat for off-by-one errors, ±1 bar to shift the entire grid by a bar. Easiest to do while the Metronome below is on, so you can hear the realignment."
            >
              Nudge
              {locked && (
                <span className="ml-2 font-mono normal-case tracking-normal text-red-400/80">
                  · read-only (you don't have grid write permission)
                </span>
              )}
              {!locked && !hasGrid && (
                <span className="ml-2 font-mono normal-case tracking-normal text-amber-400/80">
                  · set a BPM first
                </span>
              )}
            </span>
            <div className="flex flex-wrap gap-1">
              {[
                { delta: -barDuration,  label: '−1 bar',  title: `Shift the grid earlier by one bar (${barDuration ? barDuration.toFixed(3) + 's' : 'set BPM first'}). Use to fix off-by-a-bar alignment.` },
                { delta: -beatDuration, label: '−1 beat', title: `Shift the grid earlier by one beat (${beatDuration ? beatDuration.toFixed(3) + 's' : 'set BPM first'}). Use to fix off-by-one alignment.` },
                { delta: -0.010,        label: '−10ms',   title: 'Shift the grid 10 milliseconds earlier. Coarse fine-tuning.' },
                { delta: -0.001,        label: '−1ms',    title: 'Shift the grid 1 millisecond earlier. Finest tuning.' },
                { delta: +0.001,        label: '+1ms',    title: 'Shift the grid 1 millisecond later. Finest tuning.' },
                { delta: +0.010,        label: '+10ms',   title: 'Shift the grid 10 milliseconds later. Coarse fine-tuning.' },
                { delta: +beatDuration, label: '+1 beat', title: `Shift the grid later by one beat (${beatDuration ? beatDuration.toFixed(3) + 's' : 'set BPM first'}). Use to fix off-by-one alignment.` },
                { delta: +barDuration,  label: '+1 bar',  title: `Shift the grid later by one bar (${barDuration ? barDuration.toFixed(3) + 's' : 'set BPM first'}). Use to fix off-by-a-bar alignment.` },
              ].map((n) => (
                <button
                  key={n.label}
                  type="button"
                  onClick={() => nudgeOffset(n.delta)}
                  disabled={locked || !hasGrid}
                  title={locked ? 'Grid is locked — unlock in Song Info to nudge.' : n.title}
                  className="px-2 py-1 rounded text-[10px] font-mono border border-white/[0.08] bg-white/[0.02] text-slate-300 hover:border-emerald-500/40 hover:bg-emerald-500/10 hover:text-emerald-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {n.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {anchored && anchorListSlot}
    </div>
  );
}
