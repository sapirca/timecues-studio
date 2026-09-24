// The /prep "Song setup" sidebar. Setting a grid is a task, not a form, so
// the panel is shaped like one:
//
//   • a status card that always answers "is my grid right?" — BPM, meter and
//     where bar 1 sits, without opening anything;
//   • three steps — Tempo → Downbeat → Check by ear — one accordion level
//     deep, one open at a time. That is the whole panel: there is no advanced
//     drawer any more. The display name and the destructive grid reset each
//     moved to the control they are about.
//
// The metronome is step 3 rather than a sibling section: it is the
// instrument you verify the grid with. Tapping a tempo still drives only the
// click, but it now offers to write itself back to the song's BPM, so the
// two tempo numbers can't silently disagree.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { SongInfo } from '../../types/songInfo';
import { effectiveGridMode, getActiveBeatOverrideCount, isMapMode } from '../../types/songInfo';
import { formatClockTime } from '../../utils/clockTime';
import { StepSection } from './shared/StepSection';
import { TempoModePicker, GridResetControl } from './GridModeControls';
import { MODE_LABEL } from './shared/gridModeLabels';
import { GridScorePanel } from './GridScorePanel';
import { MetronomePanel } from './MetronomePanel';
import { PinnedBeatListEditor } from './PinnedBeatListEditor';
import { CrosshairIcon } from './CrosshairIcon';

const BPM_MIN = 20;
const BPM_MAX = 300;
/** Meter chips, in the order they're offered. Anything else lives behind the
 *  "Other" chip's select so the common cases stay one click away. */
const QUICK_TIME_SIGNATURES = ['4/4', '3/4', '6/8', '7/8'];
const OTHER_TIME_SIGNATURES = ['5/4', '2/4', '12/8'];

const OPEN_STEP_KEY = 'tc:prep:setup:step';
const NUDGE_STEP_KEY = 'tc:prep:setup:nudgestep';
const NAME_OPEN_KEY = 'tc:prep:setup:name';
const AUTODETECT_KEY = 'tc:prep:autodetect:open';

export interface BpmSuggestion {
  /** Detector label, e.g. 'librosa-beat-track', 'madmom-tempo'. */
  source: string;
  bpm: number;
  /** Optional madmom-style strength (0–1). Higher = more confident. */
  strength?: number;
}

/** The four steps of the panel's accordion, in the order the grid is built:
 *  the tempo, where bar 1 falls, where the count restarts, then the ear check
 *  that verifies all three. Exactly one is open at a time. */
type Step = 1 | 2 | 3 | 4;

export interface SongSetupPanelProps {
  songInfo: SongInfo | null;
  onChange: (info: SongInfo) => void;
  /** Auto-detected BPM candidates from one or more detectors. The user picks. */
  suggestedBpms?: BpmSuggestion[];
  /** Optional auto-detected time signature (e.g. `"4/4"`) from BeatNet.
   *  Rendered as a click-to-apply chip beside the meter chips. */
  suggestedTimeSignature?: string | null;
  bpmDetectionStatus?: 'idle' | 'running' | 'done' | 'error';
  bpmDetectionError?: string;
  /** Runs detection with force=true. Omitted for non-admin viewers. */
  onRerunBpmDetection?: () => void;
  /** Snaps gridOffset to the current playhead time. Hidden when not provided. */
  onAlignGridToPlayhead?: () => void;
  playerTime?: number;
  playerIsPlaying?: boolean;
  /** Live media-clock reader, forwarded to the click track. See
   *  MetronomePanel's `getSongTime`: the click has to be placed against the
   *  element's own clock, not against `playerTime`. */
  getSongTime?: () => number | null;
  /** Player speed multiplier, forwarded to the click track so the woodblock
   *  follows the song at half speed instead of clicking twice per beat. */
  playbackRate?: number;
  /** When true the inputs are read-only — non-admin annotators consume the
   *  BPM the team leader set. */
  locked?: boolean;
  /** Jump the playhead to `time` (seconds). */
  onSeek?: (time: number) => void;
  onClearPinnedBeat?: (beatIndex: number) => void;
  /** Imperative tap-tempo trigger for the T shortcut. */
  tapRef?: RefObject<(() => void) | null>;
  /** The grid-segment list, rendered inside step ③. Passed in rather than
   *  built here because the host owns the segment table and every edit
   *  callback on it; the panel only owns where it sits in the flow. */
  segmentsSlot?: ReactNode;
  /** Segment count including the opening one — drives step ③'s summary. */
  segmentCount?: number;
  /** Where the autosave of this song's grid stands. Every edit in /prep is
   *  written back on its own; this is the only place that says so. */
  saveState?: 'idle' | 'saving' | 'saved' | 'error';
  /** Re-send a save the server refused. Rendered as the badge's action. */
  onRetrySave?: () => void;
  /** Audio duration in seconds, forwarded to step ④ — the grid is a rule,
   *  and expanding it into beats to score needs to know where to stop. */
  duration?: number;
  /** Every collection name already in use across the corpus, for the
   *  collection field's reuse list. The panel only sees one song, so without
   *  this a second spelling of an existing collection is one typo away. */
  knownCollections?: readonly string[];
}

function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch { /* ignore */ }
  return fallback;
}

function storeFlag(key: string, value: boolean) {
  try { window.localStorage.setItem(key, value ? '1' : '0'); } catch { /* ignore quota */ }
}

/** The BPM most detectors agree on, used as the empty state's one-click
 *  answer. Ties break toward the first (detector order is priority order). */
function consensusBpm(suggestions: readonly BpmSuggestion[]): { bpm: number; votes: number } | null {
  if (suggestions.length === 0) return null;
  let best: { bpm: number; votes: number } | null = null;
  for (const s of suggestions) {
    const votes = suggestions.filter((o) => Math.abs(o.bpm - s.bpm) < 0.05).length;
    if (!best || votes > best.votes) best = { bpm: s.bpm, votes };
  }
  return best;
}

/** The autosave badge on the status card. Idle is deliberately quiet — a
 *  permanent "Saved" reads as decoration and stops being information. */
function SaveBadge({ state, onRetry }: {
  state: 'idle' | 'saving' | 'saved' | 'error';
  onRetry?: () => void;
}) {
  if (state === 'idle') {
    return (
      <span
        className="shrink-0 font-mono text-[10px] text-slate-500"
        title="Every change here is saved automatically, about half a second after you stop editing."
      >
        Autosaves
      </span>
    );
  }
  if (state === 'error') {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] rounded border border-rose-400/50 bg-rose-500/15 text-rose-200 px-2 py-[3px] hover:bg-rose-500/25 transition-colors"
        title="The server did not accept the last save. Your edit is still on screen but is NOT on disk — click to try again."
      >
        Not saved · retry
      </button>
    );
  }
  return (
    <span
      className={`shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] rounded border px-2 py-[3px] ${
        state === 'saving'
          ? 'border-slate-400/35 bg-slate-400/10 text-slate-300'
          : 'border-emerald-400/40 bg-emerald-500/12 text-emerald-300'
      }`}
      title={state === 'saving' ? 'Writing this grid to the server…' : 'This grid is on the server.'}
    >
      {state === 'saving' ? 'Saving…' : 'Saved'}
    </span>
  );
}

export function SongSetupPanel({
  songInfo,
  onChange,
  knownCollections,
  suggestedBpms,
  suggestedTimeSignature,
  bpmDetectionStatus = 'idle',
  bpmDetectionError,
  onRerunBpmDetection,
  onAlignGridToPlayhead,
  playerTime = 0,
  playerIsPlaying = false,
  getSongTime,
  playbackRate = 1,
  locked = false,
  onSeek,
  onClearPinnedBeat,
  tapRef,
  segmentsSlot,
  segmentCount = 1,
  duration,
  saveState = 'idle',
  onRetrySave,
}: SongSetupPanelProps) {
  const update = useCallback(<K extends keyof SongInfo>(key: K, value: SongInfo[K]) => {
    if (!songInfo) return;
    onChange({ ...songInfo, [key]: value, updated_at: new Date().toISOString() });
  }, [songInfo, onChange]);

  const bpm = songInfo?.bpm;
  const timeSignature = songInfo?.timeSignature ?? '4/4';
  const gridOffset = songInfo?.gridOffset ?? 0;
  const bpmMissing = !bpm || bpm <= 0;
  const hasGrid = !bpmMissing;
  const mode = effectiveGridMode(songInfo);
  /** Hand-placed: step ② lists the beats pinned on top of the base grid
   *  instead of the single grid-offset the other modes edit. */
  const handPlaced = mode === 'manual';
  // In Mapped, tempo and meter belong to the segments — each row of the
  // segment list carries its own, and the popover edits them. A song-level
  // BPM field sitting under that list is a second control for the first
  // segment's number, which reads as "the map isn't doing anything".
  const mapped = isMapMode(songInfo);
  // With splits in play, the status row's BPM and Meter are the OPENING
  // segment's, not the song's — there is no such thing as the song's. Saying
  // which segment they belong to is the difference between a summary and a
  // wrong number.
  const mappedMulti = mapped && segmentCount > 1;
  const pinnedCount = getActiveBeatOverrideCount(songInfo);

  const beatsPerBar = useMemo(() => {
    const top = parseInt((timeSignature ?? '4/4').split('/')[0], 10);
    return Number.isFinite(top) && top > 0 ? top : 4;
  }, [timeSignature]);
  const beatDuration = bpm ? 60 / bpm : 0;
  const barDuration = beatDuration * beatsPerBar;

  // ── Which step is expanded. Exactly one at a time (or none): the panel's
  //    whole point is that you're never looking at three open forms. Before
  //    a BPM exists there is nothing to expand, so step 1 opens itself.
  // The name card folds away like the steps do. Naming is a once-per-song
  // job; the grid is what a curator comes back to, so the card should not
  // hold the top of the sidebar open forever.
  const [nameOpen, setNameOpen] = useState<boolean>(() => {
    try { return window.localStorage.getItem(NAME_OPEN_KEY) !== 'closed'; } catch { return true; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(NAME_OPEN_KEY, nameOpen ? 'open' : 'closed'); } catch { /* ignore quota */ }
  }, [nameOpen]);
  const [openStep, setOpenStep] = useState<Step | null>(() => {
    try {
      const raw = window.localStorage.getItem(OPEN_STEP_KEY);
      if (raw === '1' || raw === '2' || raw === '3' || raw === '4') return Number(raw) as Step;
      if (raw === 'none') return null;
    } catch { /* ignore */ }
    return null;
  });
  useEffect(() => {
    try { window.localStorage.setItem(OPEN_STEP_KEY, openStep == null ? 'none' : String(openStep)); } catch { /* ignore quota */ }
  }, [openStep]);
  const toggleStep = useCallback((step: Step) => {
    setOpenStep((cur) => (cur === step ? null : step));
  }, []);


  const [autoDetectOpen, setAutoDetectOpen] = useState<boolean>(() => loadFlag(AUTODETECT_KEY, false));
  useEffect(() => { storeFlag(AUTODETECT_KEY, autoDetectOpen); }, [autoDetectOpen]);

  const [meterOtherOpen, setMeterOtherOpen] = useState<boolean>(
    () => !QUICK_TIME_SIGNATURES.includes(timeSignature),
  );

  // The click track is armed here rather than inside MetronomePanel so the
  // collapsed step 3 header can say whether it's on.
  const [clickEnabled, setClickEnabled] = useState(false);
  // Step 3 earns its ✓ by being *used* — you turned the click on and listened.
  // Tapping is not required; it's the fallback for when you can't place the
  // tempo by hand. Resets per song, so a fresh track starts unchecked.
  const [checkedByEar, setCheckedByEar] = useState(false);
  const songSlug = songInfo?.song ?? null;
  useEffect(() => { setCheckedByEar(false); setClickEnabled(false); }, [songSlug]);
  useEffect(() => { if (clickEnabled) setCheckedByEar(true); }, [clickEnabled]);

  // ── Typed drafts. Local text state lets the user type intermediate values
  //    ("1" on the way to "120") without committing an out-of-range BPM —
  //    a stray 1251 freezes the UI by exploding the beat-grid line count.
  const [bpmText, setBpmText] = useState(bpm != null ? String(bpm) : '');
  useEffect(() => { setBpmText(bpm != null ? String(bpm) : ''); }, [bpm]);
  const bpmTextNum = parseFloat(bpmText);
  const bpmOutOfRange = bpmText !== '' && (!Number.isFinite(bpmTextNum) || bpmTextNum < BPM_MIN || bpmTextNum > BPM_MAX);

  // Same pattern for the grid offset — without a local draft the input snaps
  // back to gridOffset.toFixed(3) on every keystroke, so the user can't
  // backspace digits or clear the field.
  const [gridOffsetText, setGridOffsetText] = useState(gridOffset === 0 ? '' : gridOffset.toFixed(3));
  // The offset is folded into the first bar as it is committed (see
  // withFoldedGridOffset), so typing "27" on the way to "27.5" would otherwise
  // see the field answer back with the folded value mid-keystroke. While it
  // has focus the typed text stands; blur re-seeds it from what was stored.
  const gridOffsetFocused = useRef(false);
  useEffect(() => {
    if (gridOffsetFocused.current) return;
    setGridOffsetText((prev) => {
      const parsed = parseFloat(prev);
      if (Number.isFinite(parsed) && Math.abs(parsed - gridOffset) < 1e-6) return prev;
      return gridOffset === 0 ? '' : gridOffset.toFixed(3);
    });
  }, [gridOffset]);

  const applyBpm = useCallback((next: number) => {
    update('bpm', parseFloat(next.toFixed(2)));
  }, [update]);

  const nudgeOffset = useCallback((deltaSeconds: number) => {
    if (locked || !songInfo) return;
    const next = Math.max(0, (songInfo.gridOffset ?? 0) + deltaSeconds);
    update('gridOffset', Math.round(next * 1000) / 1000);
  }, [locked, songInfo, update]);

  // ── Display name. Committed on Save, not per keystroke: a half-typed title
  //    should never replace the song's shown name mid-edit.
  const savedTitle = songInfo?.title ?? '';
  const savedArtist = songInfo?.artist ?? '';
  const [titleDraft, setTitleDraft] = useState(savedTitle);
  const [artistDraft, setArtistDraft] = useState(savedArtist);
  useEffect(() => { setTitleDraft(savedTitle); }, [savedTitle]);
  useEffect(() => { setArtistDraft(savedArtist); }, [savedArtist]);
  const nameDirty = titleDraft.trim() !== savedTitle || artistDraft.trim() !== savedArtist;
  // An unsaved edit must never be folded out of sight.
  useEffect(() => { if (nameDirty) setNameOpen(true); }, [nameDirty]);
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

  // ── Collection. The curator's own grouping of the corpus, and the only
  //    grouping the app cannot infer for itself. Saved on its own button, like
  //    the name: a half-typed collection would refile the song mid-keystroke.
  const savedCollection = songInfo?.collection ?? '';
  const [collectionDraft, setCollectionDraft] = useState(savedCollection);
  useEffect(() => { setCollectionDraft(savedCollection); }, [savedCollection]);
  const collectionDirty = collectionDraft.trim() !== savedCollection;
  const saveCollection = useCallback(() => {
    if (!songInfo) return;
    const next = collectionDraft.trim();
    onChange({
      ...songInfo,
      collection: next === '' ? undefined : next,
      updated_at: new Date().toISOString(),
    });
  }, [songInfo, onChange, collectionDraft]);

  // ── Nudge step. The old panel offered twelve fixed-size buttons; picking a
  //    step size and stepping with two arrows covers the same range in a
  //    fraction of the space, and reads as one control.
  const nudgeChoices = useMemo(() => ([
    { key: 'ms1',   label: '1ms',   delta: 0.001,        title: 'Shift the grid by 1 millisecond. Finest tuning.' },
    { key: 'ms10',  label: '10ms',  delta: 0.010,        title: 'Shift the grid by 10 milliseconds.' },
    { key: 'ms100', label: '100ms', delta: 0.100,        title: 'Shift the grid by 100 milliseconds. Coarse alignment.' },
    { key: 'beat',  label: 'beat',  delta: beatDuration, title: `Shift the grid by one beat (${beatDuration ? beatDuration.toFixed(3) + 's' : 'set a BPM first'}). Fixes off-by-one alignment.` },
    { key: 'bar',   label: 'bar',   delta: barDuration,  title: `Shift the grid by one bar (${barDuration ? barDuration.toFixed(3) + 's' : 'set a BPM first'}). Fixes off-by-a-bar alignment.` },
  ]), [beatDuration, barDuration]);
  const [nudgeKey, setNudgeKey] = useState<string>(() => {
    try { return window.localStorage.getItem(NUDGE_STEP_KEY) ?? 'ms10'; } catch { return 'ms10'; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(NUDGE_STEP_KEY, nudgeKey); } catch { /* ignore quota */ }
  }, [nudgeKey]);
  const nudgeDelta = nudgeChoices.find((c) => c.key === nudgeKey)?.delta ?? 0.010;

  const validSuggestions = useMemo(
    () => (suggestedBpms ?? []).filter((s) => Number.isFinite(s.bpm) && s.bpm >= BPM_MIN && s.bpm <= BPM_MAX),
    [suggestedBpms],
  );
  const consensus = useMemo(() => consensusBpm(validSuggestions), [validSuggestions]);

  const halvedBpm = bpm != null ? parseFloat((bpm / 2).toFixed(2)) : null;
  const doubledBpm = bpm != null ? parseFloat((bpm * 2).toFixed(2)) : null;
  const canHalveBpm = !locked && halvedBpm != null && halvedBpm >= BPM_MIN;
  const canDoubleBpm = !locked && doubledBpm != null && doubledBpm <= BPM_MAX;

  /** What the status card shows in the BPM column. */
  const statusBpm = bpmMissing ? '—' : String(bpm);

  const inputBase = 'w-full bg-[#0a0b0d] border rounded-md px-3 py-2 text-slate-100 text-sm focus:outline-none transition-colors disabled:opacity-60 disabled:cursor-not-allowed';
  const inputIdle = 'border-white/[0.08] focus:border-violet-500/60 focus:ring-[3px] focus:ring-violet-500/20';
  const fieldLabel = 'text-[11px] text-slate-400';
  const chipBase = 'flex-1 basis-0 min-w-0 py-1.5 rounded-[5px] border font-mono text-[11px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const chipIdle = 'border-white/[0.08] bg-white/[0.02] text-slate-400 hover:border-violet-500/30 hover:text-violet-200';
  const chipActive = 'border-violet-500/50 bg-violet-500/15 text-violet-100';

  if (!songInfo) return null;

  const statusColumn = (value: string, label: string, step: 1 | 2, title: string) => (
    <button
      type="button"
      onClick={() => setOpenStep(step)}
      title={title}
      className="flex flex-col gap-1 items-start text-left rounded px-1 -mx-1 py-0.5 hover:bg-white/[0.03] transition-colors"
    >
      <span className={`font-mono text-2xl font-semibold leading-none tabular-nums truncate max-w-full ${value === '—' ? 'text-slate-600' : 'text-slate-50'}`}>
        {value}
      </span>
      <span className="text-[10px] uppercase tracking-[0.12em] text-slate-500">{label}</span>
    </button>
  );

  return (
    <div className="space-y-2.5">

      {/* ─── SONG NAME ────────────────────────────────────────────────────
          What the song is called everywhere in the app — independent of the
          on-disk slug / file name. It sits in plain sight: naming the track is
          part of preparing it, and a curator shouldn't have to go hunting for
          it in a drawer. A blank title falls back
          to the file name. Committed on Save, not per keystroke: a half-typed
          title should never replace the song's shown name mid-edit. */}
      <div className="rounded-lg border border-white/[0.08] bg-[#161920] px-3.5 py-3 space-y-2">
        <button
          type="button"
          onClick={() => setNameOpen((o) => !o)}
          aria-expanded={nameOpen}
          title={nameOpen ? 'Hide the title and artist fields' : 'Edit the title and artist'}
          className="flex w-full items-baseline justify-between gap-2 text-left"
        >
          <span className="flex items-baseline gap-1.5 min-w-0">
            <span className="text-[10px] uppercase tracking-[0.12em] text-slate-500">Song name</span>
            {/* Closed, the card still has to say what the song is called —
                otherwise folding it away hides the one fact it exists for. */}
            {!nameOpen && (
              <span className="min-w-0 truncate text-[11px] text-slate-300">
                {[artistDraft.trim(), titleDraft.trim()].filter(Boolean).join(' — ') || '(uses file name)'}
              </span>
            )}
          </span>
          <span className="flex items-baseline gap-2 shrink-0">
            {nameDirty && <span className="font-mono text-[11px] text-amber-400/90">unsaved</span>}
            <span className={`text-slate-500 text-[9px] transition-transform ${nameOpen ? '' : '-rotate-90'}`} aria-hidden="true">▼</span>
          </span>
        </button>
        {nameOpen && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label htmlFor="tc-setup-title" className={fieldLabel}>Title</label>
            <input
              id="tc-setup-title"
              type="text"
              value={titleDraft}
              disabled={locked}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && nameDirty) { e.preventDefault(); saveName(); } }}
              placeholder="(uses file name)"
              className={`${inputBase} ${inputIdle}`}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="tc-setup-artist" className={fieldLabel}>
              Artist <span className="text-slate-600">(optional)</span>
            </label>
            <input
              id="tc-setup-artist"
              type="text"
              value={artistDraft}
              disabled={locked}
              onChange={(e) => setArtistDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && nameDirty) { e.preventDefault(); saveName(); } }}
              className={`${inputBase} ${inputIdle}`}
            />
          </div>
        </div>
        )}
        {nameOpen && !locked && (
          <div className="flex items-center gap-2">
            <p className="flex-1 min-w-0 text-[10px] text-slate-600 text-pretty">
              Shown across the app as “Artist — Title”.
            </p>
            <button
              type="button"
              onClick={saveName}
              disabled={!nameDirty}
              title={nameDirty ? 'Save the title and artist' : 'No unsaved changes'}
              className="shrink-0 px-3.5 py-1.5 rounded text-xs font-semibold border border-violet-400/55 bg-violet-500/20 text-violet-50 hover:bg-violet-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Save
            </button>
            <button
              type="button"
              onClick={clearName}
              disabled={!nameClearable}
              title="Clear the title and artist — the song falls back to its file name."
              className="shrink-0 px-3 py-1.5 rounded text-xs border border-white/[0.12] bg-white/[0.04] text-slate-300 hover:text-slate-100 hover:border-white/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {/* ─── COLLECTION ───────────────────────────────────────────────────
          One free-text name that files this song in the sidebar's "Group by →
          Collection" list. Its own card rather than a third field under Song
          name: a collection is not what the song is called, it is which pile it
          belongs to. Hidden for viewers who can't edit it AND have nothing to
          read — an empty disabled box explains nothing. */}
      {(!locked || savedCollection) && (
        <div className="rounded-lg border border-white/[0.08] bg-[#161920] px-3.5 py-3 space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor="tc-setup-collection" className="text-[10px] uppercase tracking-[0.12em] text-slate-500">
              Collection
            </label>
            {collectionDirty && <span className="font-mono text-[11px] text-amber-400/90">unsaved</span>}
          </div>
          <div className="flex items-center gap-2">
            <input
              id="tc-setup-collection"
              type="text"
              list="tc-setup-collection-names"
              value={collectionDraft}
              disabled={locked}
              onChange={(e) => setCollectionDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && collectionDirty) { e.preventDefault(); saveCollection(); } }}
              placeholder="(none)"
              className={`${inputBase} ${inputIdle} min-w-0 flex-1`}
            />
            {!locked && (
              <button
                type="button"
                onClick={saveCollection}
                disabled={!collectionDirty}
                title={collectionDirty
                  ? (collectionDraft.trim() === '' ? 'Remove this song from its collection' : `File this song under “${collectionDraft.trim()}”`)
                  : 'No unsaved changes'}
                className="shrink-0 px-3.5 py-1.5 rounded text-xs font-semibold border border-violet-400/55 bg-violet-500/20 text-violet-50 hover:bg-violet-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Save
              </button>
            )}
          </div>
          {/* Existing names, offered by the browser as you type. A datalist and
              not a select: the first song in a new collection has no name to
              pick from. */}
          <datalist id="tc-setup-collection-names">
            {(knownCollections ?? []).map((name) => <option key={name} value={name} />)}
          </datalist>
          {!locked && (
            <p className="text-[10px] text-slate-600 text-pretty">
              Groups this song in the sidebar’s <span className="text-slate-500">Group by → Collection</span> list.
              Anything you like — “Set 1”, “Needs a second pass”. Save it empty to unfile the song.
            </p>
          )}
        </div>
      )}

      {/* ─── STATUS ──────────────────────────────────────────────────────
          The one thing that is never folded away: what the grid currently
          is. Every column jumps to the step that changes it. */}
      <div className={`rounded-lg border bg-[#161920] px-3.5 py-3 space-y-3.5 ${bpmMissing ? 'border-amber-500/30' : 'border-white/[0.08]'}`}>
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2">
            <span
              className={`w-[7px] h-[7px] rounded-full ${bpmMissing ? 'bg-amber-500 shadow-[0_0_8px_0_rgba(245,158,11,0.7)]' : 'bg-emerald-500 shadow-[0_0_8px_0_rgba(16,185,129,0.7)]'}`}
              aria-hidden="true"
            />
            <span className={`text-[13px] font-semibold ${bpmMissing ? 'text-amber-400' : 'text-slate-200'}`}>
              {bpmMissing ? 'No grid yet' : 'Grid is set'}
            </span>
          </span>
          <span className="flex items-center gap-1.5 shrink-0">
            <SaveBadge state={saveState} onRetry={onRetrySave} />
            <span
              className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] rounded border border-slate-400/35 bg-slate-400/10 text-slate-300 px-2 py-[3px]"
              title={`Tempo mode: ${MODE_LABEL[mode]}`}
            >
              {MODE_LABEL[mode]}
              {handPlaced && pinnedCount > 0 && ` · ${pinnedCount} pinned`}
              {mappedMulti && ` · ${segmentCount} grids`}
            </span>
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2.5">
          {statusColumn(
            statusBpm,
            mappedMulti ? 'BPM · seg 1' : 'BPM',
            1,
            mappedMulti ? 'Open the Tempo step — each segment carries its own' : 'Open the Tempo step',
          )}
          {statusColumn(
            timeSignature,
            mappedMulti ? 'Meter · seg 1' : 'Meter',
            1,
            mappedMulti ? 'Open the Tempo step — each segment carries its own' : 'Open the Tempo step',
          )}
          {statusColumn(hasGrid ? formatClockTime(gridOffset, 1) : '—', 'Bar 1 at', 2, 'Open the Downbeat step')}
        </div>
      </div>

      {/* ─── EMPTY STATE ─────────────────────────────────────────────────
          Before a BPM exists the panel has exactly one thing to click. */}
      {bpmMissing && !locked && (
        <div className="rounded-lg border border-violet-500/35 bg-violet-500/[0.05] p-3.5 space-y-2.5">
          <p className="text-[13px] leading-relaxed text-slate-300 text-pretty">
            Annotating needs a tempo. Let the detectors take a first pass — you can correct it after.
          </p>
          {bpmDetectionStatus === 'running' ? (
            <div className="w-full px-3 py-3 rounded-md border border-violet-500/40 bg-violet-500/10 text-violet-200 text-[13px] font-semibold text-center animate-pulse">
              Detecting…
            </div>
          ) : consensus ? (
            <button
              type="button"
              onClick={() => applyBpm(consensus.bpm)}
              title={`${consensus.votes} of ${validSuggestions.length} detectors agree on this tempo.`}
              className="w-full px-3 py-3 rounded-md border border-violet-500/55 bg-violet-500/20 text-violet-50 text-[13px] font-semibold hover:bg-violet-500/30 transition-colors"
            >
              Use {consensus.bpm.toFixed(2)} BPM
            </button>
          ) : onRerunBpmDetection ? (
            <button
              type="button"
              onClick={onRerunBpmDetection}
              className="w-full inline-flex items-center justify-center gap-2 px-3 py-3 rounded-md border border-violet-500/55 bg-violet-500/20 text-violet-50 text-[13px] font-semibold hover:bg-violet-500/30 transition-colors"
            >
              <span aria-hidden="true">↻</span> Detect the tempo
            </button>
          ) : null}
          {bpmDetectionStatus === 'error' && (
            <p className="text-[11px] font-mono text-amber-400 break-words">⚠ {bpmDetectionError ?? 'detection failed'}</p>
          )}
          <div className="flex items-center justify-center gap-2">
            <span className="text-[11px] text-slate-500">or</span>
            <button
              type="button"
              onClick={() => setOpenStep(3)}
              className="text-xs text-violet-300 hover:text-violet-200 transition-colors"
            >
              tap it out yourself
            </button>
          </div>
        </div>
      )}

      {/* ─── THE FOUR STEPS ──────────────────────────────────────────── */}
      <div className="space-y-1.5">

        <StepSection
          index={1}
          title="Tempo"
          done={hasGrid}
          summary={hasGrid ? `${bpm} · ${timeSignature}` : undefined}
          accent="violet"
          open={openStep === 1}
          onToggle={() => toggleStep(1)}
        >
          <TempoModePicker
            segmentsSlot={segmentsSlot}
            segmentCount={segmentCount}
            songInfo={songInfo}
            onChange={onChange}
            locked={locked}
          />

          {!mapped && (
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <label htmlFor="tc-setup-bpm" className={fieldLabel}>Beats per minute</label>
                <span className="text-[10px] text-slate-500">type it, or pick one below</span>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  id="tc-setup-bpm"
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
                  className={`${inputBase} flex-1 min-w-0 font-mono text-lg font-semibold tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${
                    bpmOutOfRange ? 'border-red-500/50 focus:border-red-500/70 focus:ring-[3px] focus:ring-red-500/20'
                      : bpmMissing ? 'border-amber-500/40 focus:border-amber-500/70 focus:ring-[3px] focus:ring-amber-500/20'
                      : inputIdle
                  }`}
                />
                <button
                  type="button"
                  disabled={!canHalveBpm}
                  onClick={() => { if (halvedBpm != null) applyBpm(halvedBpm); }}
                  title={canHalveBpm ? `Halve the BPM → ${halvedBpm}` : 'Halving would drop below the minimum BPM'}
                  className="shrink-0 w-[42px] h-[42px] rounded-md border border-white/[0.1] bg-white/[0.03] text-slate-300 font-mono text-[13px] hover:border-violet-500/40 hover:text-violet-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  ÷2
                </button>
                <button
                  type="button"
                  disabled={!canDoubleBpm}
                  onClick={() => { if (doubledBpm != null) applyBpm(doubledBpm); }}
                  title={canDoubleBpm ? `Double the BPM → ${doubledBpm}` : 'Doubling would exceed the maximum BPM'}
                  className="shrink-0 w-[42px] h-[42px] rounded-md border border-white/[0.1] bg-white/[0.03] text-slate-300 font-mono text-[13px] hover:border-violet-500/40 hover:text-violet-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  ×2
                </button>
              </div>
              <p className={`text-[10px] ${bpmOutOfRange ? 'text-red-400' : 'text-slate-600'}`}>
                {bpmOutOfRange
                  ? `⚠ BPM must be ${BPM_MIN}–${BPM_MAX}`
                  : `${BPM_MIN}–${BPM_MAX}. Half or double it if the detector landed an octave off.`}
              </p>
            </div>
          )}

          {!mapped && (
          <div className="space-y-1.5">
            <span className={fieldLabel}>Beats per bar</span>
            <div className="flex gap-1.5">
              {QUICK_TIME_SIGNATURES.map((ts) => (
                <button
                  key={ts}
                  type="button"
                  disabled={locked}
                  onClick={() => { update('timeSignature', ts); setMeterOtherOpen(false); }}
                  className={`${chipBase} ${timeSignature === ts ? chipActive : chipIdle}`}
                >
                  {ts}
                </button>
              ))}
              <button
                type="button"
                disabled={locked}
                onClick={() => setMeterOtherOpen((v) => !v)}
                aria-expanded={meterOtherOpen}
                title="Less common meters"
                className={`${chipBase} ${!QUICK_TIME_SIGNATURES.includes(timeSignature) ? chipActive : chipIdle}`}
              >
                {QUICK_TIME_SIGNATURES.includes(timeSignature) ? 'Other' : timeSignature}
              </button>
            </div>
            {meterOtherOpen && (
              <select
                value={OTHER_TIME_SIGNATURES.includes(timeSignature) ? timeSignature : '__custom__'}
                disabled={locked}
                onChange={(e) => { if (e.target.value !== '__custom__') update('timeSignature', e.target.value); }}
                aria-label="Less common time signatures"
                className={`${inputBase} ${inputIdle} font-mono max-w-[10rem]`}
              >
                {OTHER_TIME_SIGNATURES.map((ts) => <option key={ts} value={ts}>{ts}</option>)}
                {!OTHER_TIME_SIGNATURES.includes(timeSignature) && !QUICK_TIME_SIGNATURES.includes(timeSignature) && (
                  <option value="__custom__">{timeSignature || 'custom'}</option>
                )}
              </select>
            )}
            {suggestedTimeSignature && suggestedTimeSignature !== timeSignature && (
              <button
                type="button"
                disabled={locked}
                onClick={() => update('timeSignature', suggestedTimeSignature)}
                title={`BeatNet detected ${suggestedTimeSignature}. Click to apply.`}
                className="text-[11px] text-violet-300 hover:text-violet-200 transition-colors disabled:opacity-40"
              >
                BeatNet heard {suggestedTimeSignature} — use it
              </button>
            )}
          </div>
          )}

          {/* Detected candidates. Each chip carries its detector, so the
              numbers mean something without hovering one at a time.
              Hidden in Mapped: a whole-song tempo is an answer to a question
              a mapped song isn't asking, and the segment editor has a
              per-segment detector that reads the right span. */}
          {!mapped && (bpmDetectionStatus !== 'idle' || validSuggestions.length > 0) && (
            <div className="space-y-2 pt-3 border-t border-white/[0.05]">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAutoDetectOpen((v) => !v)}
                  aria-expanded={autoDetectOpen}
                  className="group flex-1 min-w-0 flex items-center gap-1.5 text-left"
                >
                  <span
                    className={`shrink-0 text-[11px] leading-none text-slate-500 transition-transform duration-150 group-hover:text-slate-300 ${autoDetectOpen ? 'rotate-90' : ''}`}
                    aria-hidden="true"
                  >
                    ▸
                  </span>
                  <span className="truncate text-xs text-slate-300">
                    {consensus
                      ? <>{consensus.votes} of {validSuggestions.length} detector{validSuggestions.length === 1 ? '' : 's'} say <span className="font-mono text-slate-100">{consensus.bpm.toFixed(2)}</span></>
                      : bpmDetectionStatus === 'running' ? 'Detecting…'
                      : 'No detector returned a usable BPM'}
                  </span>
                </button>
                {onRerunBpmDetection && bpmDetectionStatus !== 'running' && (
                  <button
                    type="button"
                    onClick={onRerunBpmDetection}
                    className="shrink-0 text-[11px] text-slate-400 hover:text-slate-200 transition-colors"
                    title="Re-run all detectors (ignores cache)"
                  >
                    Re-run
                  </button>
                )}
              </div>
              {bpmDetectionStatus === 'error' && (
                <p className="text-[11px] font-mono text-amber-400 break-words">⚠ {bpmDetectionError ?? 'detection failed'}</p>
              )}
              {autoDetectOpen && validSuggestions.length > 0 && (
                <div className="grid grid-cols-2 gap-1.5">
                  {validSuggestions.map((s, i) => {
                    const isCurrent = bpm != null && Math.abs(bpm - s.bpm) < 0.05;
                    return (
                      <button
                        key={`${s.source}-${i}`}
                        type="button"
                        onClick={() => applyBpm(s.bpm)}
                        disabled={isCurrent || locked}
                        title={`${s.source}${s.strength != null ? ` · strength ${s.strength.toFixed(2)}` : ''} — click to set BPM = ${s.bpm.toFixed(2)}`}
                        className={`flex min-w-0 items-baseline gap-1.5 px-2.5 py-1.5 rounded-[5px] border transition-colors ${
                          isCurrent
                            ? 'border-violet-500/45 bg-violet-500/15 text-violet-100 cursor-default'
                            : 'border-white/[0.08] bg-white/[0.02] text-slate-200 hover:border-violet-500/40 hover:bg-violet-500/10'
                        }`}
                      >
                        <span className="shrink-0 font-mono text-[13px] tabular-nums">{s.bpm.toFixed(2)}</span>
                        <span className={`min-w-0 flex-1 truncate text-left text-[10px] ${isCurrent ? 'text-violet-300' : 'text-slate-500'}`}>{s.source}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* The way out of whatever mode was picked at the top of this step:
              throw the pinned beats away and go back to Steady. It lives here, under the picker it undoes, rather than in
              a drawer of its own — it renders nothing at all for a Steady grid
              with nothing to discard, or for a read-only viewer. */}
          <GridResetControl
            songInfo={songInfo}
            onChange={onChange}
            locked={locked}
          />
        </StepSection>

        <StepSection
          index={2}
          title="Downbeat"
          done={hasGrid}
          summary={handPlaced ? `${pinnedCount} pinned beat${pinnedCount === 1 ? '' : 's'}` : formatClockTime(gridOffset, 3)}
          accent="violet"
          open={openStep === 2}
          onToggle={() => toggleStep(2)}
          disabled={bpmMissing}
          disabledHint="needs a tempo"
        >
          {handPlaced ? (
            <PinnedBeatListEditor
              manualBase={songInfo.manualBaseGridMode}
              beatOverrides={songInfo.beatOverrides}
              locked={locked}
              onSeek={onSeek}
              onClearPinnedBeat={onClearPinnedBeat}
            />
          ) : (
            <>
              <p className="text-xs leading-relaxed text-slate-400 text-pretty">
                Park the playhead on the first downbeat, then capture it.
              </p>

              {!locked && onAlignGridToPlayhead && (
                <button
                  type="button"
                  onClick={onAlignGridToPlayhead}
                  title="Capture the current playhead time as bar 1. Shortcut: G (or hold Alt and drag the waveform to slide the grid). One-shot — does not toggle."
                  className="w-full inline-flex items-center justify-center gap-2.5 px-3 py-3 rounded-md border border-violet-500/50 bg-violet-500/[0.18] text-violet-50 hover:bg-violet-500/25 active:scale-[0.99] transition-all"
                >
                  <CrosshairIcon size={15} />
                  <span className="text-[13px] font-semibold">Set bar 1 here</span>
                  <span className="font-mono text-[13px] tabular-nums text-violet-200">{formatClockTime(playerTime, 3)}</span>
                  <span className="font-mono text-[10px] text-violet-300 border border-violet-400/40 rounded px-1.5 py-px">G</span>
                </button>
              )}

              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <label htmlFor="tc-setup-offset" className={fieldLabel}>Grid offset</label>
                  <span className="text-[10px] text-slate-500">type it, or step it</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={locked || !hasGrid}
                    onClick={() => nudgeOffset(-nudgeDelta)}
                    title={`Shift the grid ${nudgeDelta ? nudgeDelta.toFixed(3) + 's' : ''} earlier`}
                    aria-label="Nudge the grid earlier"
                    className="shrink-0 w-[38px] h-[40px] inline-flex items-center justify-center rounded-md border border-white/[0.1] bg-white/[0.03] text-slate-300 hover:border-violet-500/40 hover:text-violet-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="10,3 5,8 10,13" /></svg>
                  </button>
                  <div className="relative flex-1 min-w-0">
                    <input
                      id="tc-setup-offset"
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
                      onFocus={() => { gridOffsetFocused.current = true; }}
                      onBlur={() => {
                        gridOffsetFocused.current = false;
                        setGridOffsetText(gridOffset === 0 ? '' : gridOffset.toFixed(3));
                      }}
                      placeholder="0.000"
                      className={`${inputBase} ${inputIdle} font-mono text-center tabular-nums pr-6 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
                    />
                    <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-500">s</span>
                  </div>
                  <button
                    type="button"
                    disabled={locked || !hasGrid}
                    onClick={() => nudgeOffset(+nudgeDelta)}
                    title={`Shift the grid ${nudgeDelta ? nudgeDelta.toFixed(3) + 's' : ''} later`}
                    aria-label="Nudge the grid later"
                    className="shrink-0 w-[38px] h-[40px] inline-flex items-center justify-center rounded-md border border-white/[0.1] bg-white/[0.03] text-slate-300 hover:border-violet-500/40 hover:text-violet-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6,3 11,8 6,13" /></svg>
                  </button>
                </div>
                <span className="block text-[10px] text-slate-600">Arrows step by:</span>
                <div className="flex gap-1.5">
                  {nudgeChoices.map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => setNudgeKey(c.key)}
                      title={c.title}
                      className={`${chipBase} ${nudgeKey === c.key ? chipActive : chipIdle}`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                {locked && (
                  <p className="text-[11px] font-mono text-red-400/80">read-only — you don't have grid write permission</p>
                )}
              </div>
            </>
          )}
        </StepSection>

        <StepSection
          index={3}
          title="Check by ear"
          done={checkedByEar}
          summary={clickEnabled ? 'click on' : checkedByEar ? 'checked' : 'click off'}
          accent="emerald"
          open={openStep === 3}
          onToggle={() => toggleStep(3)}
          disabled={bpmMissing && openStep !== 3}
          disabledHint="tap a tempo in step 1"
        >
          <MetronomePanel
            songInfo={songInfo}
            playerTime={playerTime}
            playerIsPlaying={playerIsPlaying}
            getSongTime={getSongTime}
            playbackRate={playbackRate}
            clickEnabled={clickEnabled}
            onClickEnabledChange={setClickEnabled}
            onAdoptTappedBpm={locked ? undefined : applyBpm}
            tapRef={tapRef}
          />
        </StepSection>

        {/* Step ③ checks the grid by ear; this is the same check with a
            different judge. Scores CACHED tracker output, so it costs
            milliseconds and never starts a model run — and renders nothing
            at all when the Python stack is down. */}
        <StepSection
          index={4}
          title="Check against the models"
          accent="emerald"
          open={openStep === 4}
          onToggle={() => toggleStep(4)}
          disabled={bpmMissing && openStep !== 4}
          disabledHint="tap a tempo in step 1"
        >
          <GridScorePanel
            songInfo={songInfo}
            duration={duration}
            onApplyBpm={locked ? undefined : applyBpm}
            onApplyOffset={locked ? undefined : (seconds) => update('gridOffset', seconds)}
          />
        </StepSection>
      </div>
    </div>
  );
}
