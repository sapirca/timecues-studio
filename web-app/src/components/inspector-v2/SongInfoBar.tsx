import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { SongInfo, GridMode } from '../../types/songInfo';
import { isAnchorMode } from '../../types/songInfo';
import { CollapsibleSubsection } from './shared/CollapsibleSubsection';

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

  // Display name is committed on Save (not live) — a half-typed title should
  // never replace the song's shown name mid-keystroke. Drafts mirror the
  // saved values until the user hits Save (commit both) or Clear (back to the
  // file-name default). Re-seed whenever the saved values change underneath us
  // (e.g. switching songs, or another IDE editing the same record).
  const savedTitle = songInfo?.title ?? '';
  const savedArtist = songInfo?.artist ?? '';
  const [titleDraft, setTitleDraft] = useState(savedTitle);
  const [artistDraft, setArtistDraft] = useState(savedArtist);
  useEffect(() => { setTitleDraft(savedTitle); }, [savedTitle]);
  useEffect(() => { setArtistDraft(savedArtist); }, [savedArtist]);
  const nameDirty = titleDraft.trim() !== savedTitle || artistDraft.trim() !== savedArtist;
  const nameClearable = titleDraft !== '' || artistDraft !== '' || savedTitle !== '' || savedArtist !== '';
  const saveName = useCallback(() => {
    if (!songInfo) return;
    onChange({
      ...songInfo,
      title: titleDraft.trim() === '' ? undefined : titleDraft.trim(),
      artist: artistDraft.trim() === '' ? undefined : artistDraft.trim(),
      updated_at: new Date().toISOString(),
    });
  }, [songInfo, onChange, titleDraft, artistDraft]);
  const clearName = useCallback(() => {
    setTitleDraft('');
    setArtistDraft('');
    if (!songInfo) return;
    onChange({ ...songInfo, title: undefined, artist: undefined, updated_at: new Date().toISOString() });
  }, [songInfo, onChange]);

  // Auto-detected tempo chips fold behind a disclosure — by default just a
  // one-line "N suggestions" summary shows, expand to reveal the chips.
  const [autoDetectOpen, setAutoDetectOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('tc:prep:autodetect:open') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('tc:prep:autodetect:open', autoDetectOpen ? '1' : '0'); } catch {}
  }, [autoDetectOpen]);

  // The Nudge step buttons fold behind a disclosure too — collapsed by default
  // so Grid offset is the first thing in the section.
  const [nudgeOpen, setNudgeOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('tc:prep:nudge:open') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('tc:prep:nudge:open', nudgeOpen ? '1' : '0'); } catch {}
  }, [nudgeOpen]);

  const validSuggestions = (suggestedBpms ?? []).filter(
    (s) => Number.isFinite(s.bpm) && s.bpm >= BPM_MIN && s.bpm <= BPM_MAX,
  );

  const applyBpm = useCallback((next: number) => {
    update('bpm', parseFloat(next.toFixed(2)));
  }, [update]);

  const containerClass = embedded
    ? 'space-y-4'
    : 'rounded-md border border-white/[0.06] bg-[#14171d]/80 p-4 space-y-4';

  // Shared sizing so the whole panel reads big-and-clear and stays consistent.
  const sectionTitleClass = 'text-base font-semibold uppercase tracking-wide text-slate-100';
  const fieldLabelClass = 'text-xs text-slate-400 uppercase tracking-wider';
  const inputBaseClass = 'w-full bg-[#0a0b0d] border text-slate-100 text-sm rounded-md px-3 py-2 focus:outline-none transition-colors disabled:opacity-60 disabled:cursor-not-allowed';
  const inputClass = `${inputBaseClass} border-white/[0.08] focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/50`;

  return (
    <div className={containerClass}>
      {!embedded && (
        <div className="flex items-center">
          <span className={sectionTitleClass}>Song info</span>
        </div>
      )}

      {/* ─── DISPLAY NAME ────────────────────────────────────────────────
          The human-readable name shown across the app. Independent of the
          on-disk slug/file name (which is never changed by these fields).
          Title blank → the app falls back to the file name; Artist is only
          used when a Title is set, rendered as "Artist — Title". Commits on
          Save (not per-keystroke); Clear resets to the file name. */}
      <CollapsibleSubsection
        title="Display name"
        storageKey="tc:prep:displayname:open"
        defaultOpen={false}
        headerBelow={!locked && nameDirty ? (
          <span className="text-xs font-mono text-amber-400/90">unsaved</span>
        ) : undefined}
        headerRight={!locked ? (
          <>
            <button
              type="button"
              onClick={saveName}
              disabled={!nameDirty}
              title={nameDirty ? 'Save the title and artist' : 'No unsaved changes'}
              className="px-2.5 py-1 rounded text-xs font-semibold uppercase tracking-wider border border-violet-400/60 bg-violet-500/20 text-violet-100 hover:bg-violet-500/30 hover:border-violet-300/80 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              Save
            </button>
            <button
              type="button"
              onClick={clearName}
              disabled={!nameClearable}
              title="Clear the title and artist — the song falls back to its file name."
              className="px-2.5 py-1 rounded text-xs font-semibold uppercase tracking-wider border border-white/[0.12] bg-white/[0.04] text-slate-300 hover:text-slate-100 hover:border-white/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              Clear
            </button>
          </>
        ) : undefined}
      >
        <div className="space-y-2">
          <div className="space-y-1">
            <label className={fieldLabelClass}>Title</label>
            <input
              type="text"
              value={titleDraft}
              disabled={locked}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && nameDirty) { e.preventDefault(); saveName(); } }}
              placeholder="(uses file name)"
              className={inputClass}
            />
          </div>
          <div className="space-y-1">
            <label className={fieldLabelClass}>Artist <span className="normal-case tracking-normal text-slate-600">(optional)</span></label>
            <input
              type="text"
              value={artistDraft}
              disabled={locked}
              onChange={(e) => setArtistDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && nameDirty) { e.preventDefault(); saveName(); } }}
              placeholder=""
              className={inputClass}
            />
          </div>
        </div>
      </CollapsibleSubsection>

      {/* ─── TEMPO ────────────────────────────────────────────────────────
          Everything that answers "what's the tempo?": the mode tabs (Static /
          Dynamic / Manual), the auto-detected suggestions, and the BPM +
          time-signature inputs. Where bar 1 sits is its own Grid alignment
          section below. */}
      <CollapsibleSubsection
        title="Tempo"
        storageKey="tc:prep:tempo:open"
        defaultOpen
        headerBelow={!anchored && bpmOutOfRange ? (
          <span className="text-xs text-red-400 font-mono">⚠ BPM must be {BPM_MIN}–{BPM_MAX}</span>
        ) : !anchored && bpmMissing ? (
          <span className="text-xs text-amber-400 font-mono">⚠ BPM required to start annotating</span>
        ) : undefined}
      >
        <div className="space-y-2.5">
          {/* Tempo-mode tabs (Static / Dynamic / Manual) — rendered by
              GridModeControls, now nested inside Tempo. */}
          {extraControls}
          {/* Detected BPM suggestions fold behind a disclosure — one bigger
              chip per detector (detector name on hover). Click to apply.
              Static-only: in anchor modes per-anchor BPM is edited inline. */}
          {!anchored && (bpmDetectionStatus !== 'idle' || validSuggestions.length > 0) && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setAutoDetectOpen((v) => !v)}
                  aria-expanded={autoDetectOpen}
                  className="group flex min-w-0 items-center gap-1.5 text-left"
                >
                  <span
                    className={`inline-block text-sm leading-none text-slate-500 transition-transform duration-150 group-hover:text-slate-300 ${autoDetectOpen ? 'rotate-90' : ''}`}
                    aria-hidden="true"
                  >
                    ▸
                  </span>
                  <span className={fieldLabelClass}>Auto-detected</span>
                  {validSuggestions.length > 0 && (
                    <span className="text-xs font-mono text-slate-500 normal-case tracking-normal">
                      · {validSuggestions.length} suggestion{validSuggestions.length === 1 ? '' : 's'}
                    </span>
                  )}
                </button>
                <div className="flex items-center gap-2">
                  {bpmDetectionStatus === 'running' && (
                    <span className="text-xs font-mono text-violet-400 animate-pulse">detecting…</span>
                  )}
                  {bpmDetectionStatus === 'error' && (
                    <span className="text-xs font-mono text-amber-400" title={bpmDetectionError}>
                      ⚠ {bpmDetectionError ?? 'detection failed'}
                    </span>
                  )}
                  {onRerunBpmDetection && bpmDetectionStatus !== 'running' && (
                    <button
                      onClick={onRerunBpmDetection}
                      className="text-xs font-mono text-slate-400 hover:text-slate-200 transition-colors"
                      title="Re-run all detectors (ignores cache)"
                    >
                      ↻ Re-run
                    </button>
                  )}
                </div>
              </div>
              {autoDetectOpen && (
                validSuggestions.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {validSuggestions.map((s, i) => {
                      const isCurrent = bpm != null && Math.abs(bpm - s.bpm) < 0.05;
                      return (
                        <button
                          key={`${s.source}-${i}`}
                          onClick={() => applyBpm(s.bpm)}
                          disabled={isCurrent || locked}
                          className={`px-3 py-2 rounded-md text-base font-mono tabular-nums border transition-colors ${
                            isCurrent
                              ? 'border-violet-500/40 bg-violet-500/15 text-violet-100 cursor-default'
                              : 'border-white/[0.08] bg-white/[0.02] text-slate-200 hover:border-violet-500/40 hover:bg-violet-500/10 hover:text-violet-100'
                          }`}
                          title={`${s.source}${s.strength != null ? ` · strength ${s.strength.toFixed(2)}` : ''} — click to set BPM = ${s.bpm.toFixed(2)}`}
                        >
                          {s.bpm.toFixed(2)}
                        </button>
                      );
                    })}
                  </div>
                ) : bpmDetectionStatus === 'done' ? (
                  <span className="text-xs font-mono text-slate-500">No detector returned a usable BPM.</span>
                ) : null
              )}
            </div>
          )}

          {/* BPM + time signature share one row. In anchor modes only Time
              Signature applies, so it spans the row alone. */}
          <div className={`grid gap-4 ${anchored ? 'grid-cols-1' : 'grid-cols-2'}`}>
            {!anchored && (
              <div className="space-y-1">
                <label className={fieldLabelClass}>BPM</label>
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
                  className={`${inputBaseClass} font-mono ${
                    bpmOutOfRange ? 'border-red-500/40 focus:border-red-500/70 focus:ring-1 focus:ring-red-500/40'
                      : bpmMissing ? 'border-amber-500/40 focus:border-amber-500/70 focus:ring-1 focus:ring-amber-500/40'
                      : 'border-white/[0.08] focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/50'
                  }`}
                />
              </div>
            )}
            <div className="space-y-1">
              <label className={fieldLabelClass}>Time signature</label>
              <div className="flex items-center gap-2">
                <select
                  value={COMMON_TIME_SIGNATURES.includes(timeSignature) ? timeSignature : '__custom__'}
                  disabled={locked}
                  onChange={(e) => { if (e.target.value !== '__custom__') update('timeSignature', e.target.value); }}
                  className={`${inputClass} font-mono`}
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
                    className="shrink-0 text-xs font-mono uppercase tracking-wider px-2 py-1.5 rounded-md border border-violet-400/30 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {suggestedTimeSignature}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </CollapsibleSubsection>

      {/* ─── GRID ALIGNMENT ──────────────────────────────────────────────
          Where bar 1 sits: the grid-offset value plus the tools that move it
          (Set bar start in the header, the Nudge buttons). Static-only —
          anchor modes get the AnchorListEditor instead. */}
      {!anchored && (
        <CollapsibleSubsection
          title="Grid alignment"
          storageKey="tc:prep:align:open"
          defaultOpen
          headerBelow={!locked && onAlignGridToPlayhead ? (
            <button
              type="button"
              onClick={onAlignGridToPlayhead}
              title="Capture the current playhead time as bar 1. Shortcut: G (or hold Alt and drag the waveform to slide the grid). One-shot — does not toggle."
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold uppercase tracking-wider border-2 border-slate-600/60 bg-slate-800/40 text-slate-200 hover:bg-slate-700/60 hover:border-slate-500 hover:text-slate-100 active:bg-slate-600/80 active:scale-[0.97] transition-all duration-75"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
          ) : undefined}
        >
          <div className="space-y-2.5">
          {/* Nudge grid offset — fine-tune the static gridOffset with fixed-
              size steps. Folds behind a disclosure (collapsed by default) and
              sits above Grid offset so the buttons don't crowd the field.
              Easiest to use while the Metronome below is on. */}
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setNudgeOpen((v) => !v)}
                aria-expanded={nudgeOpen}
                className="group flex min-w-0 items-center gap-1.5 text-left"
                title="Shift the grid offset by a fixed amount. Use ±1ms / ±10ms for fine alignment, ±1 beat for off-by-one errors, ±1 bar to shift the entire grid by a bar. Easiest to do while the Metronome below is on, so you can hear the realignment."
              >
                <span
                  className={`inline-block text-sm leading-none text-slate-500 transition-transform duration-150 group-hover:text-slate-300 ${nudgeOpen ? 'rotate-90' : ''}`}
                  aria-hidden="true"
                >
                  ▸
                </span>
                <span className={fieldLabelClass}>Nudge</span>
              </button>
              {locked && (
                <span className="font-mono normal-case tracking-normal text-xs text-red-400/80">
                  · read-only (you don't have grid write permission)
                </span>
              )}
              {!locked && !hasGrid && (
                <span className="font-mono normal-case tracking-normal text-xs text-amber-400/80">
                  · set a BPM first
                </span>
              )}
            </div>
            {nudgeOpen && (
              <div className="flex flex-wrap gap-1.5">
                {[
                  { delta: -barDuration,  label: '−1 bar',  title: `Shift the grid earlier by one bar (${barDuration ? barDuration.toFixed(3) + 's' : 'set BPM first'}). Use to fix off-by-a-bar alignment.` },
                  { delta: -beatDuration, label: '−1 beat', title: `Shift the grid earlier by one beat (${beatDuration ? beatDuration.toFixed(3) + 's' : 'set BPM first'}). Use to fix off-by-one alignment.` },
                  { delta: -1.0,          label: '−1 sec',  title: 'Shift the grid 1 second earlier. Coarse alignment.' },
                  { delta: -0.100,        label: '−100ms',  title: 'Shift the grid 100 milliseconds earlier. Coarse alignment.' },
                  { delta: -0.010,        label: '−10ms',   title: 'Shift the grid 10 milliseconds earlier. Coarse fine-tuning.' },
                  { delta: -0.001,        label: '−1ms',    title: 'Shift the grid 1 millisecond earlier. Finest tuning.' },
                  { delta: +0.001,        label: '+1ms',    title: 'Shift the grid 1 millisecond later. Finest tuning.' },
                  { delta: +0.010,        label: '+10ms',   title: 'Shift the grid 10 milliseconds later. Coarse fine-tuning.' },
                  { delta: +0.100,        label: '+100ms',  title: 'Shift the grid 100 milliseconds later. Coarse alignment.' },
                  { delta: +1.0,          label: '+1 sec',  title: 'Shift the grid 1 second later. Coarse alignment.' },
                  { delta: +beatDuration, label: '+1 beat', title: `Shift the grid later by one beat (${beatDuration ? beatDuration.toFixed(3) + 's' : 'set BPM first'}). Use to fix off-by-one alignment.` },
                  { delta: +barDuration,  label: '+1 bar',  title: `Shift the grid later by one bar (${barDuration ? barDuration.toFixed(3) + 's' : 'set BPM first'}). Use to fix off-by-a-bar alignment.` },
                ].map((n) => (
                  <button
                    key={n.label}
                    type="button"
                    onClick={() => nudgeOffset(n.delta)}
                    disabled={locked || !hasGrid}
                    title={locked ? 'Grid is locked — unlock in Song Info to nudge.' : n.title}
                    className="px-3 py-2 rounded-md text-sm font-mono border border-white/[0.08] bg-white/[0.02] text-slate-300 hover:border-emerald-500/40 hover:bg-emerald-500/10 hover:text-emerald-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {n.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-1">
            <label className={fieldLabelClass}>Grid offset (s)</label>
            <input
              type="number" min="0" step="0.1"
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
              className={`${inputClass} font-mono`}
            />
          </div>
          </div>
        </CollapsibleSubsection>
      )}

      {anchored && anchorListSlot}
    </div>
  );
}
