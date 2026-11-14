/**
 * The riff node editor — every node is a line of notes, written the way
 * Butler writes one (Unlocking the Groove, Appendix A, p. 82): the pulse along
 * the top, numbered in each bar (1–16 on sixteenths), one bar per note lasting
 * as long as it is held, and the whole cycle between repeat signs. Under it,
 * the attack positions in his numbering ("1 C1 · 3 C1 · 11 C2"), which is how
 * he tabulates a rhythm apart from its notation.
 *
 * A note need not have a pitch. Most nodes start as HITS — a drum figure, or a
 * bass line whose notes nobody has named — on a single **hit** row; **♪ Add
 * pitches** opens the piano roll above it, and a hit dragged up onto a pitch
 * row becomes that note. Editing always lands on the node's pulse (sixteenths
 * by default, triplets where the figure swings that way).
 *
 *  - `PitchRollStrip` — the miniature for the canvas lane.
 *  - `PitchedRiffEditor` — the editor: drag on a row to draw a note, drag a
 *    note to move it (time and pitch), drag its right edge to change how long
 *    it holds, click it to delete it. Hits can also be taken off the audio's
 *    onsets or another layer.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { normalizeBoundarySegments, type RiffBoundarySegment } from '../../types/annotationLayer';
import { midiNoteName } from '../../utils/drumHits';
import {
  attackPositionsByBar, deleteNote, hitsFromOnsets, holdToNextAttack, isBlackKey, moveNote,
  nameableHitCount, nameHits, notesFromOnsets,
  PITCHED_STEPS_PER_BEAT, pitchRows, placeNote, resizeNote, snapToPulse, stepFractionLabel, unmarkedOnsetCount,
  type PitchedOnset,
} from '../../utils/pitchedRiff';
import { RepeatBracket } from './LoopNotation';

const ROW_H = 10;
/** The hit row's height when it is the only row — a drum figure gets a lane
 *  you can hit, not a 10 px sliver. */
const HIT_ONLY_ROW_H = 26;
const LABEL_W = 30;
const RULER_H = 14;
/** Narrowest pulse column that still carries its own number. */
const MIN_NUMBERED_COL_PX = 13;
/** The grab zone at a note's right end that resizes rather than moves it. */
const EDGE_PX = 6;
const DRAG_SLOP_PX = 3;

const hasPitch = (segments: readonly RiffBoundarySegment[]) => segments.some((s) => s.kind === 'tick' && s.note != null);

// ─── Lane miniature ─────────────────────────────────────────────────────────

/** A riff node in a lane cell. Hits fill the cell's height; pitched notes sit
 *  at their own height, so the line's contour reads at a glance — the bass
 *  going up to C2 and back down is something you see, not a label you read. */
export function PitchRollStrip({
  color, segments, lengthBeats, beatsPerBar = 4,
}: {
  color: string;
  segments: readonly RiffBoundarySegment[];
  lengthBeats: number;
  beatsPerBar?: number;
}) {
  const len = Math.max(1e-6, lengthBeats);
  const pitched = hasPitch(segments);
  const rows = pitchRows(segments, { pad: 0, minRows: 5 });
  const hi = rows[0];
  const span = Math.max(1, rows.length);
  const beats = Math.round(len);
  return (
    <div className="relative w-full h-full overflow-hidden">
      {beats > 1 && beats <= 64 && Array.from({ length: beats - 1 }, (_, i) => i + 1).map((b) => (
        <span
          key={b}
          className="absolute top-0 bottom-0 w-px pointer-events-none"
          style={{
            left: `${(b / len) * 100}%`,
            backgroundColor: b % beatsPerBar === 0 ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.09)',
          }}
        />
      ))}
      {segments.map((s, i) => {
        if (s.kind !== 'tick') return null;
        const fullHeight = !pitched || s.note == null;
        const row = s.note != null ? hi - s.note : 0;
        return (
          <span
            key={i}
            className="absolute rounded-[1px]"
            style={{
              left: `${(s.start / len) * 100}%`,
              width: `max(2px, calc(${((s.end - s.start) / len) * 100}% - 1px))`,
              top: fullHeight ? '12%' : `${(row / span) * 100}%`,
              height: fullHeight ? '76%' : `max(3px, ${100 / span}%)`,
              backgroundColor: color,
              opacity: pitched && s.note == null ? 0.45 : 1,
              boxShadow: '0 0 0 0.5px rgba(0,0,0,0.6)',
            }}
          />
        );
      })}
    </div>
  );
}

// ─── Editor ─────────────────────────────────────────────────────────────────

type Drag =
  | { mode: 'draw'; note: number | null; fromBeat: number; toBeat: number }
  | { mode: 'move'; index: number; grab: number; beat: number; note: number | null; x0: number; y0: number; moved: boolean }
  | { mode: 'resize'; index: number; end: number };

/** One layer offered as a source of hits — its items inside this node's
 *  placement, each landing on its nearest step. */
export interface BoundaryTickSource {
  id: string;
  name: string;
  /** What kind of layer this is. */
  kind: 'cues' | 'lyrics';
  /** How many hits it would lay down. */
  count: number;
  /** Replaces the node's notes with hits from those items. */
  apply: () => void;
  /** Adds the ones this node isn't already marking and keeps every note
   *  already there. Absent ⇒ only replace is offered. */
  applyMerge?: () => void;
  /** Where this source's hits land, in beats from the node's start — a cue
   *  layer doubles as an onset reference. */
  tickBeats?: readonly number[];
  /** The MIDI note of each of `tickBeats`, where the layer knows it (a
   *  detector's notes lane). */
  tickNotes?: readonly (number | undefined)[];
}

/** One set of onset positions hits can be taken from — the audio's own
 *  picked peaks, an isolated stem's, or a detected cue layer's. */
export interface NoteOnsetSource {
  id: string;
  name: string;
  /** Onset positions in beats from the node's start. */
  beats: readonly number[];
  /** The MIDI note heard at each of `beats`, where the source knows it — a
   *  detector's notes lane does, an onset curve doesn't. */
  notes?: readonly (number | undefined)[];
  /** Set while the source's audio is still being fetched and analysed. */
  status?: 'loading' | 'error';
}

export interface PitchedRiffEditorProps {
  color: string;
  segments: readonly RiffBoundarySegment[];
  lengthBeats: number;
  /** The node's pulse, steps per beat (4 = sixteenths, 3/6 = triplets). */
  pulse?: number;
  beatsPerBar?: number;
  playheadBeat?: number | null;
  onChange: (segments: RiffBoundarySegment[]) => void;
  readOnly?: boolean;
  onsetSources?: readonly NoteOnsetSource[];
  /** Which onset source is showing (`null` = none) — a stem's audio is only
   *  fetched once it is picked. */
  onOnsetRefChange?: (sourceId: string | null) => void;
  /** Layers whose items can replace or add to the hits. */
  tickSources?: readonly BoundaryTickSource[];
  /** While Tap Along is recording, a press on the grid lands a tap there
   *  instead of editing. */
  onTapAtBeat?: (beat: number) => void;
}

const ONSETS_OFF = '__off';

export function PitchedRiffEditor({
  color, segments, lengthBeats, pulse = PITCHED_STEPS_PER_BEAT, beatsPerBar = 4, playheadBeat = null,
  onChange, readOnly = false, onsetSources, onOnsetRefChange, tickSources, onTapAtBeat,
}: PitchedRiffEditorProps) {
  const len = Math.max(1e-6, lengthBeats);
  const steps = Math.max(1, Math.round(len * pulse));
  const stepsPerBar = Math.max(1, Math.round(beatsPerBar * pulse));
  const [extraAbove, setExtraAbove] = useState(0);
  const [extraBelow, setExtraBelow] = useState(0);
  const [pitchesOpen, setPitchesOpen] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [gridW, setGridW] = useState(0);
  useEffect(() => {
    const el = gridRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setGridW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pitched = hasPitch(segments);
  const showPitches = pitched || pitchesOpen;
  const rows = useMemo(
    () => pitchRows(segments, { pad: 1, minRows: 8, extraAbove, extraBelow }),
    [segments, extraAbove, extraBelow],
  );
  // The hit row is always there, under the pitches: a note nobody has named
  // is still a note.
  const rowNotes: (number | null)[] = showPitches ? [...rows, null] : [null];
  const rowH = showPitches ? ROW_H : HIT_ONLY_ROW_H;
  const rowOf = (note: number | null | undefined) => (note == null ? rowNotes.length - 1 : rowNotes.indexOf(note));

  // Onsets to compare against and take hits from.
  const sources = onsetSources ?? [];
  const [onsetRefId, setOnsetRefId] = useState<string | null>(null);
  // The layer the "from layer" row takes hits from; falls back to the first
  // one offered when nothing is picked or the picked layer went away.
  const [tickSourceId, setTickSourceId] = useState<string | null>(null);
  const tickSource = tickSources?.find((s) => s.id === tickSourceId) ?? tickSources?.[0];
  const onsetRef = onsetRefId === ONSETS_OFF ? null : (sources.find((s) => s.id === onsetRefId) ?? sources[0] ?? null);
  const onsets: PitchedOnset[] = onsetRef && !onsetRef.status
    ? onsetRef.beats
      .map((beat, i) => ({ beat, note: onsetRef.notes?.[i] }))
      .filter((o) => o.beat >= 0 && o.beat < len)
    : [];
  const onsetBeats = onsets.map((o) => o.beat);
  // Hits already on the roll that this source can name — it heard a pitch
  // right where they are.
  const nameable = nameableHitCount(segments, onsets, pulse);
  const sourceKnowsPitch = onsets.some((o) => o.note != null);
  const noteCount = segments.filter((s) => s.kind === 'tick').length;
  const takeMode: 'replace' | 'add' = noteCount > 0 ? 'add' : 'replace';
  const takeCount = takeMode === 'replace'
    ? hitsFromOnsets([], onsetBeats, len, pulse, 'replace').filter((s) => s.kind === 'tick').length
    : unmarkedOnsetCount(segments, onsetBeats, len, pulse);

  // What the grid shows: the drag's result while one is under way, so a note
  // follows the pointer and lands only on release (one undo step, not one per
  // pixel).
  const shown = useMemo(() => {
    if (!drag) return segments;
    if (drag.mode === 'draw') {
      const a = Math.min(drag.fromBeat, drag.toBeat);
      const b = Math.max(drag.fromBeat, drag.toBeat) + 1 / pulse;
      return placeNote(segments, a, b, drag.note, len);
    }
    if (drag.mode === 'move') return drag.moved ? moveNote(segments, drag.index, drag.beat, drag.note, len, pulse) : segments;
    return resizeNote(segments, drag.index, drag.end, len, pulse);
  }, [drag, segments, len, pulse]);

  const pointAt = (clientX: number, clientY: number) => {
    const r = gridRef.current!.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width - 0.001, clientX - r.left));
    const y = Math.max(0, Math.min(r.height - 0.001, clientY - r.top));
    const rawBeat = (x / r.width) * len;
    const row = Math.min(rowNotes.length - 1, Math.floor(y / rowH));
    return { rawBeat, stepBeat: Math.floor(rawBeat * pulse) / pulse, note: rowNotes[row] };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (onTapAtBeat) { onTapAtBeat(pointAt(e.clientX, e.clientY).rawBeat); return; }
    if (readOnly) return;
    const p = pointAt(e.clientX, e.clientY);
    const hit = (e.target as HTMLElement).closest<HTMLElement>('[data-note-index]');
    e.currentTarget.setPointerCapture(e.pointerId);
    if (hit) {
      const index = Number(hit.dataset.noteIndex);
      const seg = segments[index];
      const box = hit.getBoundingClientRect();
      if (box.right - e.clientX <= EDGE_PX) {
        setDrag({ mode: 'resize', index, end: seg.end });
      } else {
        setDrag({ mode: 'move', index, grab: p.rawBeat - seg.start, beat: seg.start, note: seg.note ?? null, x0: e.clientX, y0: e.clientY, moved: false });
      }
      return;
    }
    setDrag({ mode: 'draw', note: p.note, fromBeat: p.stepBeat, toBeat: p.stepBeat });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const p = pointAt(e.clientX, e.clientY);
    if (drag.mode === 'draw') {
      setDrag({ ...drag, toBeat: Math.max(drag.fromBeat, p.stepBeat) });
    } else if (drag.mode === 'move') {
      const moved = drag.moved || Math.abs(e.clientX - drag.x0) > DRAG_SLOP_PX || Math.abs(e.clientY - drag.y0) > DRAG_SLOP_PX;
      setDrag({ ...drag, moved, beat: snapToPulse(p.rawBeat - drag.grab, pulse), note: p.note });
    } else {
      setDrag({ ...drag, end: snapToPulse(p.rawBeat, pulse) });
    }
  };

  const onPointerUp = () => {
    if (!drag) return;
    if (drag.mode === 'move' && !drag.moved) onChange(deleteNote(segments, drag.index, len));
    else onChange(shown as RiffBoundarySegment[]);
    setDrag(null);
  };

  const bars = attackPositionsByBar(segments, beatsPerBar, pulse);
  // An attack's place in its bar, in beats and their fractions: 1, 1¼, 2½.
  const beatAt = (pos: number) => {
    const i = pos - 1;
    return `${Math.floor(i / pulse) + 1}${i % pulse ? stepFractionLabel(i, pulse) : ''}`;
  };
  // Numbers on every step while a column is wide enough to hold one; past
  // that only the beats, as Butler's tables count them.
  const everyStep = gridW > 0 && gridW / steps >= MIN_NUMBERED_COL_PX;
  const gridH = rowNotes.length * rowH;
  const cursor = onTapAtBeat ? 'pointer' : readOnly ? 'default' : drag?.mode === 'resize' ? 'ew-resize' : 'crosshair';
  const btn = 'px-1.5 py-0.5 rounded bg-white/[0.05] hover:bg-white/10 text-slate-300 disabled:opacity-40';
  const selectCls = 'bg-[#0a0b0d] border border-white/[0.06] rounded px-1 py-0.5 text-[10px] text-slate-200 max-w-[9rem]';
  // The onsets / from-layer row stays on one line: its menus give up width
  // and cut a long layer name with an ellipsis (the full name is the menu's
  // tooltip), while the buttons and labels keep theirs.
  const rowSelectCls = `${selectCls} min-w-[3.5rem] shrink truncate text-ellipsis`;
  const rowBtn = `${btn} shrink-0 whitespace-nowrap`;

  return (
    <div className="space-y-1.5">
      <RepeatBracket color={color} fill>
        <div className="flex" style={{ width: '100%' }}>
          {/* Pitch names, high to low, piano-roll style; the hit row last. */}
          <div className="flex-shrink-0 relative" style={{ width: LABEL_W, paddingTop: RULER_H }}>
            {rowNotes.map((n, i) => (
              <div
                key={i}
                className="text-[7.5px] font-mono leading-none flex items-center justify-end pr-1"
                style={{
                  height: rowH,
                  color: n == null ? '#cbd5e1' : (n % 12 === 0 ? '#e2e8f0' : '#64748b'),
                  backgroundColor: n != null && isBlackKey(n) ? 'rgba(0,0,0,0.35)' : 'transparent',
                }}
                title={n == null ? 'Hits — notes with no pitch. Drag one up onto a pitch to name it.' : undefined}
              >
                {n == null ? 'hit' : midiNoteName(n)}
              </div>
            ))}
          </div>

          <div className="flex-1 min-w-[240px]">
            {/* The beats and their fractions: the beat's number on the beat,
                then what part of it each step is (¼ ½ ¾ · ⅓ ⅔). */}
            <div className="relative" style={{ height: RULER_H }}>
              {Array.from({ length: steps }, (_, i) => {
                const onBeat = i % pulse === 0;
                if (!everyStep && !onBeat) return null;
                return (
                  <span
                    key={i}
                    className={`absolute text-center font-mono leading-none ${onBeat ? 'text-slate-200 font-semibold' : 'text-slate-500'}`}
                    style={{ left: `${(i / steps) * 100}%`, width: `${100 / steps}%`, top: 3, fontSize: onBeat ? 9 : 8 }}
                  >
                    {stepFractionLabel(i, pulse)}
                  </span>
                );
              })}
            </div>

            <div
              ref={gridRef}
              className="relative overflow-hidden rounded-sm bg-[#0d0f12] select-none touch-none"
              style={{ height: gridH, cursor }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => setDrag(null)}
            >
              {rowNotes.map((n, i) => (
                <div
                  key={i}
                  className="absolute left-0 right-0 pointer-events-none"
                  style={{
                    top: i * rowH,
                    height: rowH,
                    backgroundColor: n == null ? 'rgba(148,163,184,0.07)' : isBlackKey(n) ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.025)',
                    borderTop: n != null && n % 12 === 11 ? '1px solid rgba(255,255,255,0.12)' : n == null && i > 0 ? '1px solid rgba(148,163,184,0.35)' : undefined,
                  }}
                />
              ))}
              {/* Every beat a block, every alternate one shaded, so a beat
                  reads as one group of its fractions. */}
              {Array.from({ length: Math.ceil(steps / pulse) }, (_, b) => b).filter((b) => b % 2 === 1).map((b) => (
                <span
                  key={`b${b}`}
                  className="absolute top-0 bottom-0 pointer-events-none"
                  style={{ left: `${((b * pulse) / steps) * 100}%`, width: `${(Math.min(pulse, steps - b * pulse) / steps) * 100}%`, backgroundColor: 'rgba(255,255,255,0.035)' }}
                />
              ))}
              {/* Every step a cell: the fraction lines inside a beat, the beat
                  lines stronger. No other grid, and nothing off it. */}
              {Array.from({ length: steps - 1 }, (_, i) => i + 1).map((i) => {
                const bar = i % stepsPerBar === 0;
                const beat = i % pulse === 0;
                return (
                  <span
                    key={i}
                    className="absolute top-0 bottom-0 w-px pointer-events-none"
                    style={{
                      left: `${(i / steps) * 100}%`,
                      backgroundColor: bar ? 'rgba(255,255,255,0.45)' : beat ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.12)',
                    }}
                  />
                );
              })}
              {shown.map((s, i) => {
                if (s.kind !== 'tick') return null;
                const row = rowOf(s.note);
                if (row < 0) return null;
                const active = playheadBeat != null && playheadBeat >= s.start && playheadBeat < s.end;
                return (
                  <div
                    key={i}
                    data-note-index={drag ? undefined : i}
                    className="absolute rounded-[2px] flex items-center overflow-hidden"
                    style={{
                      left: `${(s.start / len) * 100}%`,
                      width: `${((s.end - s.start) / len) * 100}%`,
                      top: row * rowH + 1,
                      height: rowH - 2,
                      backgroundColor: color,
                      // Exactly its cells; a dark hairline at the attack keeps
                      // neighbouring notes two.
                      boxShadow: active ? '0 0 0 1.5px #fff, 0 0 8px rgba(255,255,255,0.6)' : 'inset 1px 0 0 rgba(3,7,18,0.9)',
                      cursor: readOnly || onTapAtBeat ? undefined : 'grab',
                    }}
                    title={readOnly ? (s.label ?? 'hit') : `${s.label ?? 'hit'} — drag to move${showPitches ? ' (up or down to change pitch)' : ''}, drag the right end to hold longer, click to delete`}
                  >
                    <span className="text-[8px] font-bold font-mono text-black/80 px-0.5 leading-none truncate pointer-events-none">
                      {s.note != null ? midiNoteName(s.note) : ''}
                    </span>
                    {!readOnly && !onTapAtBeat && (
                      <span className="absolute right-0 top-0 bottom-0 cursor-ew-resize" style={{ width: EDGE_PX - 2, backgroundColor: 'rgba(0,0,0,0.25)' }} />
                    )}
                  </div>
                );
              })}
              {playheadBeat != null && playheadBeat >= 0 && playheadBeat <= len && (
                <span
                  className="absolute top-0 bottom-0 w-px bg-white/80 pointer-events-none"
                  style={{ left: `${(playheadBeat / len) * 100}%` }}
                />
              )}
            </div>
          </div>
        </div>
      </RepeatBracket>

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-1.5 text-[9px] text-slate-500 pl-1">
          {!pitched && (
            <button
              type="button"
              className={btn}
              aria-pressed={pitchesOpen}
              onClick={() => setPitchesOpen((v) => !v)}
              title={pitchesOpen ? 'Back to hits only' : 'Show the piano roll — draw named notes, or drag a hit up onto its pitch'}
            >
              {pitchesOpen ? 'Hits only' : '♪ Add pitches'}
            </button>
          )}
          {showPitches && (
            <>
              <button type="button" className={btn} onClick={() => setExtraAbove((v) => v + 2)} title="Show two more notes above">▲ higher</button>
              <button type="button" className={btn} onClick={() => setExtraBelow((v) => v + 2)} title="Show two more notes below">▼ lower</button>
            </>
          )}
          <span className="flex-1" />
          <button
            type="button"
            disabled={noteCount === 0}
            className={btn}
            onClick={() => onChange(normalizeBoundarySegments([], len))}
            title="Remove every note and start this node again from an empty grid (Ctrl+Z brings them back)"
          >
            Clear all
          </button>
          <button
            type="button"
            disabled={noteCount === 0}
            className={btn}
            onClick={() => onChange(holdToNextAttack(segments, len))}
            title="Make every note last until the next one starts — how Butler writes a line, rests only where it really stops"
          >
            Hold to next note
          </button>
        </div>
      )}

      {!readOnly && (sources.length > 0 || (tickSources?.length ?? 0) > 0) && (
        <div className="flex items-center min-w-0 gap-1.5 text-[9px] text-slate-500 pl-1">
          {sources.length > 0 && (
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="shrink-0">onsets</span>
              <select
                aria-label="onsets"
                title={onsetRef?.name ?? 'off'}
                className={rowSelectCls}
                value={onsetRef?.id ?? ONSETS_OFF}
                onChange={(e) => {
                  setOnsetRefId(e.target.value);
                  onOnsetRefChange?.(e.target.value === ONSETS_OFF ? null : e.target.value);
                }}
              >
                {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                <option value={ONSETS_OFF}>off</option>
              </select>
              {onsetRef?.status === 'loading' && <span>reading…</span>}
              {onsetRef?.status === 'error' && <span className="text-rose-400">couldn't read {onsetRef.name}</span>}
              <button
                type="button"
                className={rowBtn}
                disabled={takeCount === 0}
                onClick={() => onChange(notesFromOnsets(segments, onsets, len, pulse, takeMode))}
                title={(takeMode === 'replace'
                  ? 'Put a hit on every onset, each on its nearest step'
                  : 'Add a hit on every onset no note covers yet, on its nearest step — the notes already there stay')
                  + (sourceKnowsPitch ? '. Each arrives as the note this source heard there.' : '')}
              >
                {takeMode === 'replace'
                  ? `Take ${takeCount} ${sourceKnowsPitch ? 'notes' : 'hits'}`
                  : `Add ${takeCount} unmarked`}
              </button>
              {nameable > 0 && (
                <button
                  type="button"
                  className={rowBtn}
                  onClick={() => onChange(nameHits(segments, onsets, pulse))}
                  title={`Give each hit with no pitch the note ${onsetRef?.name ?? 'this source'} heard on it. Notes you already named stay as they are.`}
                >
                  ♪ Pitch {nameable} {nameable === 1 ? 'hit' : 'hits'}
                </button>
              )}
            </span>
          )}
          {tickSource && (
            // A layer, then what to do with its hits — two plain buttons, not
            // an optgroup per layer: a native menu draws those headers big and
            // cuts them, and "replace" vs "add" read as two separate actions.
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="shrink-0 whitespace-nowrap">from layer</span>
              <select
                aria-label="from layer"
                className={rowSelectCls}
                value={tickSource.id}
                onChange={(e) => setTickSourceId(e.target.value)}
                title={`${tickSource.name} (${tickSource.count}) — the layer to take hits from, its items inside this placement`}
              >
                {tickSources!.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.count})</option>)}
              </select>
              <button
                type="button"
                className={rowBtn}
                disabled={tickSource.count === 0}
                onClick={() => tickSource.apply()}
                title={`Remove this node's notes and put ${tickSource.name}'s ${tickSource.count} hits in their place (Ctrl+Z brings them back)`}
              >
                Replace
              </button>
              {tickSource.applyMerge && (
                <button
                  type="button"
                  className={rowBtn}
                  disabled={tickSource.count === 0}
                  onClick={() => tickSource.applyMerge!()}
                  title={`Keep this node's notes and add ${tickSource.name}'s hits where no note is yet`}
                >
                  Add
                </button>
              )}
            </span>
          )}
        </div>
      )}

      {/* Butler's attack positions, bar by bar. */}
      <div className="rounded bg-white/[0.03] px-2 py-1 space-y-0.5">
        {noteCount === 0 ? (
          <div className="text-[10px] text-slate-500 italic">
            {readOnly ? 'No notes.' : 'No notes yet — drag along the hit row to draw one, or take them from the onsets.'}
          </div>
        ) : bars.map((attacks, b) => (
          <div key={b} className="flex items-baseline gap-2 text-[10px] font-mono">
            <span className="text-slate-500 w-9 flex-shrink-0">bar {b + 1}</span>
            <span className="text-slate-300">
              {attacks.length === 0 ? <span className="text-slate-600">rest</span> : attacks.map((a, i) => (
                <span key={i}>
                  {i > 0 && <span className="text-slate-600"> · </span>}
                  <span className="text-slate-400" title={a.offGrid ? 'Not on the pulse — shown at the nearest step' : `Beat ${beatAt(a.pos)} of the bar`}>
                    {beatAt(a.pos)}{a.offGrid ? '~' : ''}
                  </span>
                  {a.name && <span style={{ color }}> {a.name}</span>}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
