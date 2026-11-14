/**
 * GrooveLaneRow — a detector's drum grooves, one cell per bar.
 *
 * Read-only. Each cell is one bar of the song, coloured by its groove letter
 * (A² wears A's colour), so the lane answers "which groove, when" at
 * fit zoom, where a bar is a few pixels wide. How far a bar strays from its
 * groove fades its fill; a fill is capped with a bright edge and a drop-out is
 * hatched, so the bars a light show should react to are the ones that stand
 * out. The first bar of a run shows the groove, lettered with how many bars
 * the run plays ("C ×8") — the groove's main letter only, written over the
 * run so a run of narrow bars still shows it; what a bar inside the run plays
 * (B⁴, C) is named in its tooltip and card, not on the lane. A bar that plays
 * it again exactly is drawn exactly as strong as the first — one pattern, one
 * colour, one strength — and a dark rule between every two cells shows where
 * each play starts. Zoomed in far enough, a cell draws that bar AS PLAYED on hat / snare /
 * kick rows — toms, ride and crash too where the kit was split, and a bass row
 * under them where the bass plays the kick's part:
 * the groove's hits, the ones this bar dropped hollow, the ones it added
 * ringed.
 *
 * Visualized (the lane's ◇ toggle), the lane plays along: the bar under the
 * playhead is lit, and each drum's row flashes on every hit that bar struck,
 * as hard as it was struck — the whole bar's row when zoomed out, the one
 * step when zoomed in far enough to see the hits.
 *
 * What a groove IS lives in the card a cell opens: the bar that was clicked,
 * large, drawn over the canonical bar in grey, then the whole run it belongs to,
 * bar by bar, with the groove's names and how its bars split between exact,
 * variations, fills and drop-outs. See drumGrooves.ts. While the card is
 * open it plays along on its own, karaoke-style: the step sounding lit white,
 * the notes still to come faint, on the card's bar when that bar is. As playback
 * crosses into the next bar, the card moves on to it.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { formatClockTime } from '../../utils/clockTime';
import { PendingHighlightOverlay, RegionDragOverlay, type PendingSelection } from './AnnotationOverlays';
import { BeatGridOverlay, type LaneGridProps } from './BeatGridOverlay';
import { PlayheadLine } from '../Playhead';
import { usePaintClock, usePlayheadEffect, usePlayheadValue } from '../../hooks/usePlayhead';
import { litShadow } from './shared/litShadow';
import { useAnnotationPopover } from './shared/useAnnotationPopover';
import {
  EVENT_WORDS,
  GROOVE_ROW_COLORS,
  barSpan,
  describeBarChange,
  grooveHits,
  type Groove,
  type GrooveBar,
  type GrooveLaneModel,
  type GrooveRow,
  type GrooveStep,
} from './drumGrooves';
import { REST_MOTIF } from './riffGrooves';

export const GROOVE_LANE_H = 36;
/** Below this many CSS px per step a bar's hits are not drawn: at fit zoom a
 *  bar is a few px wide and its 48 cells would be a smear. */
const MIN_STEP_PX = 3;
/** A run's letter is written over the run, not inside its first bar: a run
 *  at least this wide shows it, and its count once there is room for both. At
 *  fit zoom one bar is a few px, so a letter clipped to its first bar was a
 *  letter that never showed. */
const MIN_RUN_LABEL_PX = 7;
const MIN_RUN_COUNT_PX = 28;
/** Fill opacity by how far the bar strays: the groove as written is the
 *  strongest mark, a bar that barely resembles it the faintest. */
function tint(color: string, deviation: number): string {
  const alpha = 0.6 - 0.4 * Math.min(1, deviation * 2);
  return `${color}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
}

/** One drum row of the card's bar: three rows were the 42px it always was, and
 *  a split kit's toms, ride and crash each add one rather than squeezing. */
const CARD_ROW_PX = 14;

/** Where the staff sits in a cell: under the motif letter, to the bottom. */
const STAFF_TOP_PX = 10;

/** The rule at the start of every cell inside a run: dark enough to read
 *  against a node's full colour, so each play is its own block. */
const CELL_RULE = 'rgba(0,0,0,0.8)';

const HATCH = 'repeating-linear-gradient(135deg, rgba(15,23,42,0.75) 0 2px, transparent 2px 5px)';

/** How faint a note still to come is while a bar plays along, karaoke-style. */
const AHEAD_FADE = 0.35;

/** Where a bar is, karaoke-style: the step sounding now. */
interface StaffNow {
  step: number;
}

/** One drum row of a bar: a rect per hit, in a 0..steps × 0..1 viewBox.
 *  A hit's left edge is its onset (the step's start), so it lines up with
 *  the beat ticks in the lanes below instead of floating mid-step. */
function StaffRow({ steps, cells, color, y, now }: {
  steps: GrooveStep[];
  cells: number;
  color: string;
  y: number;
  now?: StaffNow;
}) {
  return (
    <>
      {steps.map((s) => {
        const on = s.state !== 'missing';
        const strength = s.velocity != null ? 0.4 + 0.6 * (s.velocity / 127) : 1;
        const lit = now != null && s.step === now.step && on;
        const ahead = now != null && s.step > now.step;
        return (
          // One step can hold a note the play left out AND the one it struck
          // instead (a long note re-held shorter): the state tells them apart.
          <Fragment key={`${s.step}:${s.state}`}>
          <rect
            x={s.step}
            y={y + 0.12}
            // Exactly as long as the note — from its step to where it ends, no
            // inset either side; a held note runs to its release.
            width={s.length ?? 1}
            height={0.76}
            rx={0.15}
            data-lit={lit || undefined}
            fill={lit ? '#ffffff' : on ? color : 'none'}
            fillOpacity={lit ? 1 : on ? strength * (ahead ? AHEAD_FADE : 1) : 0}
            stroke={lit ? '#ffffff' : s.state === 'played' ? 'none' : s.state === 'added' ? '#ffffff' : color}
            strokeWidth={1}
            strokeOpacity={(s.state === 'missing' ? 0.7 : 1) * (ahead ? AHEAD_FADE + 0.2 : 1)}
            vectorEffect="non-scaling-stroke"
          >
            <title>{`${s.state === 'added' ? 'added' : s.state === 'missing' ? 'dropped' : s.label ? s.label : 'hit'}${s.label && s.state !== 'played' ? ` ${s.label}` : ''} · step ${s.step + 1}/${cells}${s.length ? `, held ${s.length}` : ''}`}</title>
          </rect>
          {/* With no inset, two hits on neighbouring steps would touch and read
              as one held note: a hairline at each attack keeps them two. */}
          {on && s.step > 0 && (
            <line
              x1={s.step} x2={s.step} y1={y + 0.12} y2={y + 0.88}
              stroke="#030712" strokeWidth={1} vectorEffect="non-scaling-stroke"
            />
          )}
          </Fragment>
        );
      })}
    </>
  );
}

/** The groove's hits, grey, a little larger than a bar's and behind them —
 *  so a bar is read against its groove in one row: a hit on grey is the
 *  groove played, grey with only an outline on it the groove dropped, a
 *  ringed hit with no grey behind it added. The grey is as strong as the
 *  groove's accent. */
function GrooveGhost({ lines, rows }: { lines: readonly GrooveRow[]; rows: Groove['rows'] }) {
  return (
    <g data-testid="groove-ghost">
      {lines.map((row, r) => rows[row].filter((s) => s.state !== 'missing').map((s) => (
        <rect
          key={`${row}-${s.step}`}
          x={s.step} y={r + 0.02} width={Math.max(0.9, s.length ?? 1)} height={0.96} rx={0.2}
          fill="#94a3b8"
          fillOpacity={0.14 + 0.2 * ((s.velocity ?? 127) / 127)}
        />
      )))}
    </g>
  );
}

/** A bar on the lane's rows (hat / snare / kick, and whatever else was sent),
 *  stretched to its box. Also what a copied bar's span draws (SpanLaneRow). */
export function Staff({ lines, rows, steps, beatLines = false, barSteps, now, behind }: {
  lines: readonly GrooveRow[];
  rows: Groove['rows'];
  steps: number;
  beatLines?: boolean;
  /** Steps per bar: inside a loop of several bars, a stronger line where
   *  each bar starts. */
  barSteps?: number;
  /** Playing along: the step sounding now lit, the ones to come faint. */
  now?: StaffNow;
  /** The groove, drawn as a grey ghost behind the bar. */
  behind?: Groove['rows'];
}) {
  return (
    <svg
      viewBox={`0 0 ${steps} ${lines.length}`}
      preserveAspectRatio="none"
      className="block w-full h-full"
      aria-hidden
    >
      {beatLines && Array.from({ length: steps / 4 + 1 }, (_, k) => (
        <line
          key={k}
          x1={k * 4} x2={k * 4} y1={0} y2={lines.length}
          stroke="rgba(148,163,184,0.35)" strokeWidth={1} vectorEffect="non-scaling-stroke"
        />
      ))}
      {barSteps != null && barSteps > 0 && barSteps < steps && Array.from(
        { length: Math.ceil(steps / barSteps) - 1 }, (_, k) => (k + 1) * barSteps,
      ).map((x) => (
        <line
          key={`bar-${x}`}
          data-testid="staff-bar-line"
          x1={x} x2={x} y1={0} y2={lines.length}
          stroke="rgba(226,232,240,0.8)" strokeWidth={2} vectorEffect="non-scaling-stroke"
        />
      ))}
      {now && (
        <rect
          data-testid="staff-now"
          x={now.step} y={0} width={1} height={lines.length}
          fill="rgba(255,255,255,0.14)"
        />
      )}
      {behind && <GrooveGhost lines={lines} rows={behind} />}
      {lines.map((row, r) => (
        <StaffRow
          key={row} steps={rows[row]} cells={steps} color={GROOVE_ROW_COLORS[row]} y={r} now={now}
        />
      ))}
    </svg>
  );
}

function BarCell({ bar, lines, duration, rowWidthPx, color, lit, onOpen, laneCount, focused, onPointerDown, movable }: {
  bar: GrooveBar;
  lines: readonly GrooveRow[];
  /** Under the playhead, with the lane visualized. */
  lit: boolean;
  duration: number;
  rowWidthPx: number;
  color: string;
  onOpen: (anchor: { x: number; y: number }) => void;
  /** Stacked lanes the row is split into (a riff lane's overlapping
   *  instances); the cell draws in its own, `bar.lane`. */
  laneCount: number;
  /** Part of the instance whose editor is open: outlined. */
  focused: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
  /** A drag on the cell moves what it belongs to. */
  movable: boolean;
}) {
  const left = (bar.start / duration) * 100;
  const width = ((bar.end - bar.start) / duration) * 100;
  const px = rowWidthPx * (bar.end - bar.start) / duration;
  const runStart = bar.runBars > 0;
  const showHits = px >= bar.steps * MIN_STEP_PX;
  const change = describeBarChange(bar);
  return (
    <div
      className={`group/bar absolute pointer-events-auto overflow-hidden hover:brightness-150 hover:ring-1 hover:ring-inset hover:ring-white/80 ${movable ? 'cursor-grab active:cursor-grabbing touch-pan-y' : 'cursor-pointer'}`}
      style={{
        left: `${left}%`,
        width: `${width}%`,
        top: (bar.lanes ?? laneCount) > 1 ? `calc(${bar.lane ?? 0} * 100% / ${bar.lanes ?? laneCount})` : 0,
        height: (bar.lanes ?? laneCount) > 1 ? `calc(100% / ${bar.lanes ?? laneCount})` : '100%',
        backgroundColor: tint(color, bar.deviation),
        backgroundImage: bar.event === 'drop' ? HATCH : undefined,
        // The left rule is an inset shadow, not a border: a border would push
        // the staff inside it 1–2px right of the bar's true start. Every cell
        // has one, so each play of a node is its own block.
        boxShadow: [
          runStart ? `inset 2px 0 0 ${color}` : `inset 1px 0 0 ${CELL_RULE}`,
          bar.event === 'fill' && 'inset 0 3px 0 #fde68a',
          focused && 'inset 0 0 0 1px #ffffff',
          lit && litShadow(color),
        ]
          .filter(Boolean).join(', ') || undefined,
        filter: lit ? 'brightness(1.3)' : undefined,
      }}
      title={[
        `${barSpan(bar)} · ${bar.motif} · ${EVENT_WORDS[bar.event]}${change ? ` (${change})` : ''}`,
        formatClockTime(bar.start),
        movable ? 'click for the groove · drag to move it' : 'click for the groove',
      ].join(' · ')}
      onPointerDown={onPointerDown}
      onClick={(e) => { e.stopPropagation(); onOpen({ x: e.clientX, y: e.clientY }); }}
    >
      {showHits && (
        <div className="absolute inset-x-0 bottom-0" style={{ top: STAFF_TOP_PX }}>
          <Staff lines={lines} rows={bar.rows} steps={bar.steps} />
        </div>
      )}
    </div>
  );
}

/** A run's letter, over the run: the groove's main letter only (B, not B³),
 *  and how many times the run plays. What a bar inside it plays — B⁴, C — is
 *  the card's and the tooltip's to say; on the lane it was a letter per bar,
 *  noise that buried the grooves. */
function RunLabels({ bars, duration, rowWidthPx, laneCount }: {
  bars: readonly GrooveBar[];
  duration: number;
  rowWidthPx: number;
  laneCount: number;
}) {
  const labels = useMemo(() => bars.flatMap((bar, i) => {
    if (bar.runBars <= 0) return [];
    let end = bar.end;
    // A run's bars are in time order but, on a lane of stacked instances, not
    // next to each other: another lane's cells fall between them.
    for (let j = i + 1; j < bars.length; j++) if (bars[j].run === bar.run) end = bars[j].end;
    return [{ bar, end }];
  }), [bars]);
  return (
    <>
      {labels.map(({ bar, end }) => {
        const px = rowWidthPx * (end - bar.start) / duration;
        if (px < MIN_RUN_LABEL_PX) return null;
        return (
          <span
            key={`${bar.run}:${bar.start}`}
            data-run-label
            className="absolute z-[5] pl-0.5 overflow-hidden pointer-events-none text-[9px] font-bold leading-[10px] text-white whitespace-nowrap"
            style={{
              top: (bar.lanes ?? laneCount) > 1 ? `calc(${bar.lane ?? 0} * 100% / ${bar.lanes ?? laneCount})` : 0,
              left: `${(bar.start / duration) * 100}%`,
              width: `${((end - bar.start) / duration) * 100}%`,
              textShadow: '0 0 3px rgba(0,0,0,0.9)',
            }}
          >
            {bar.motif}
            {px >= MIN_RUN_COUNT_PX && bar.runBars > 1 && <span className="font-normal opacity-80"> ×{bar.runBars}</span>}
          </span>
        );
      })}
    </>
  );
}

/** An instance that plays several nodes in order — a phrase, I F I F K G —
 *  as one span over its bars: a bracket along the foot of its lane, named
 *  at its start. The cells under it still say what each bar plays. */
export interface LaneSpan {
  start: number;
  end: number;
  lane: number;
  /** Lanes sharing its stretch (see GrooveBar.lanes); absent = laneCount. */
  lanes?: number;
  label: string;
  title: string;
  color: string;
}

/** A span this narrow (px) keeps its bracket but not its name. */
const MIN_SPAN_LABEL_PX = 40;

function LaneSpans({ spans, duration, rowWidthPx, laneCount }: {
  spans: readonly LaneSpan[];
  duration: number;
  rowWidthPx: number;
  laneCount: number;
}) {
  return (
    <>
      {spans.map((s) => (
        <div
          key={`${s.lane}:${s.start}`}
          data-lane-span
          title={s.title}
          className="absolute z-[5] pointer-events-none flex items-end"
          style={{
            top: `calc(${s.lane} * 100% / ${s.lanes ?? laneCount})`,
            height: `calc(100% / ${s.lanes ?? laneCount})`,
            left: `${(s.start / duration) * 100}%`,
            width: `${((s.end - s.start) / duration) * 100}%`,
          }}
        >
          <div
            className="relative w-full h-[11px] border-b-2 border-x-2 rounded-b-sm"
            style={{ borderColor: s.color }}
          >
            {rowWidthPx * (s.end - s.start) / duration >= MIN_SPAN_LABEL_PX && (
              <span
                className="absolute left-1 bottom-0 max-w-[calc(100%-8px)] overflow-hidden text-ellipsis whitespace-nowrap text-[9px] leading-[10px] font-semibold text-white"
                style={{ textShadow: '0 0 3px rgba(0,0,0,0.9)' }}
              >
                {s.label}
              </span>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

/** How long a hit's light lasts, at most, and as a share of the gap to the
 *  same drum's next hit — a hat on every 16th must go dark between strokes or
 *  it reads as a light left on. */
const HIT_FADE_S = 0.12;
const HIT_FADE_SHARE = 0.6;

/** The drum roll: one strip per drum, over the lane, flashing on each hit as
 *  the playhead crosses it. Styled straight from the playhead clock, so
 *  playback never re-renders the lane. */
function DrumFlash({ bars, lines, duration, rowWidthPx }: {
  bars: readonly GrooveBar[];
  lines: readonly GrooveRow[];
  duration: number;
  rowWidthPx: number;
}) {
  const hits = useMemo(() => grooveHits(bars), [bars]);
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  // What each flash was last placed on and shown at. Moving a flash (`left`,
  // `width`) is layout, so it happens once per hit; between hits only the
  // opacity changes, and on its own layer (`will-change`) that is composited,
  // not a repaint of the lane under it. Rewriting all three every frame
  // repainted the whole lane — every bar of the song at fit zoom.
  const [placed] = useState(() => new WeakMap<HTMLElement, { key: string; opacity: string }>());
  // Lit on the sound, not on the published clock — see usePaintClock.
  const paintClock = usePaintClock();
  usePlayheadEffect((t) => {
    lines.forEach((row, r) => {
      const el = refs.current[r];
      if (!el) return;
      const list = hits[row];
      // Last hit at or before t.
      let lo = 0, hi = list.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].time <= t) lo = m + 1; else hi = m; }
      const hit = lo > 0 ? list[lo - 1] : undefined;
      const fade = hit ? Math.min(HIT_FADE_S, hit.gap * HIT_FADE_SHARE) : 0;
      const a = hit ? Math.exp(-(t - hit.time) / fade) : 0;
      let was = placed.get(el);
      if (!was) placed.set(el, was = { key: '', opacity: '0' });
      const opacity = !hit || a < 0.1 ? '0' : ((0.35 + 0.65 * hit.strength) * a).toFixed(3);
      if (hit && opacity !== '0') {
        const bar = bars[hit.bar];
        const barSec = bar.end - bar.start;
        // The struck step when the hits are drawn, else the bar's whole row.
        const oneStep = rowWidthPx * barSec / duration >= bar.steps * MIN_STEP_PX;
        const from = oneStep ? hit.time : bar.start;
        const span = oneStep ? barSec / bar.steps : barSec;
        const key = `${from}:${span}:${duration}`;
        if (key !== was.key) {
          was.key = key;
          el.style.left = `${(from / duration) * 100}%`;
          el.style.width = `${(span / duration) * 100}%`;
        }
      }
      if (opacity !== was.opacity) {
        was.opacity = opacity;
        el.style.opacity = opacity;
      }
    });
  }, [hits, bars, lines, duration, rowWidthPx], paintClock);
  return (
    <>
      {lines.map((row, r) => (
        <div
          key={row}
          ref={(el) => { refs.current[r] = el; }}
          data-testid={`drum-flash-${row}`}
          className="absolute pointer-events-none z-[5]"
          style={{
            top: `calc(${STAFF_TOP_PX}px + ${r} * (100% - ${STAFF_TOP_PX}px) / ${lines.length})`,
            height: `calc((100% - ${STAFF_TOP_PX}px) / ${lines.length})`,
            background: GROOVE_ROW_COLORS[row],
            boxShadow: `0 0 8px ${GROOVE_ROW_COLORS[row]}`,
            opacity: 0,
            willChange: 'opacity',
          }}
          aria-hidden
        />
      ))}
    </>
  );
}

/** A card section's one-word heading. */
export function CardTitle({ children }: { children: ReactNode }) {
  return <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-1">{children}</div>;
}

/** Bars per line of the run strip: a four-bar phrase reads as one line. */
const RUN_COLS = 4;

/** The whole run the card's bar belongs to, bar by bar as played, a phrase
 *  per line — so where in the cycle the variations, fills and drop-outs fall
 *  reads at a glance. Every bar at full strength, as in the lane; the bar the
 *  card is about is ringed, the one playing is lit. A bar opens its own card. */
function RunStrip({ run, current, playing, step, lines, color, onPick }: {
  run: readonly { bar: GrooveBar; index: number }[];
  current: number;
  /** The lane index of the bar sounding now, and its step; -1 when none. */
  playing: number;
  step: number;
  lines: readonly GrooveRow[];
  color: string;
  onPick: (index: number) => void;
}) {
  const first = run[0].bar.bar;
  const end = run[run.length - 1].bar;
  const last = end.bar + end.bars - 1;
  return (
    <div data-testid="groove-run" title={`Bars ${first}–${last} · ×${run.length}`}>
      <CardTitle>Run · ×{run.length}</CardTitle>
      <div
        className="grid gap-1 max-h-[180px] overflow-y-auto pr-0.5"
        style={{ gridTemplateColumns: `repeat(${RUN_COLS}, minmax(0, 1fr))` }}
      >
        {run.map(({ bar, index }) => {
          const change = describeBarChange(bar);
          return (
            <button
              key={index}
              type="button"
              data-run-bar={bar.bar}
              onClick={(e) => { e.stopPropagation(); onPick(index); }}
              title={`${barSpan(bar)} · ${EVENT_WORDS[bar.event]}${change ? ` (${change})` : ''} · ${formatClockTime(bar.start)}`}
              className="relative h-[30px] rounded-sm bg-black/40 text-left hover:brightness-150"
              style={{
                backgroundImage: bar.event === 'drop' ? HATCH : undefined,
                boxShadow: [
                  index === current && 'inset 0 0 0 1px #ffffff',
                  bar.event === 'fill' && 'inset 0 2px 0 #fde68a',
                  index === playing && litShadow(color),
                ].filter(Boolean).join(', ') || undefined,
              }}
            >
              <span className="absolute left-0.5 top-0 text-[8px] leading-[9px] text-gray-500">{bar.bar}</span>
              <div className="absolute inset-x-0.5 bottom-0.5 top-[9px]">
                <Staff
                  lines={lines} rows={bar.rows} steps={bar.steps}
                  now={index === playing ? { step } : undefined}
                />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}


/** Steps per bar are at most this, so (bar index, step) packs into one
 *  number — a primitive, which the playhead selector needs to stay quiet
 *  between steps. */
const STEP_PACK = 4096;

function GrooveCard({ bars, bar, current, run, groove, lines, color, onPick, popoverRef, positionStyle, onStepClick, footer, onPlay, onStop, isPlaying }: {
  /** Every bar of the lane. */
  bars: readonly GrooveBar[];
  bar: GrooveBar;
  /** The bar's index in the lane's bars. */
  current: number;
  /** Every bar of its run, with its index in the lane's bars. */
  run: readonly { bar: GrooveBar; index: number }[];
  lines: readonly GrooveRow[];
  groove: Groove;
  color: string;
  onPick: (index: number) => void;
  popoverRef: RefObject<HTMLDivElement | null>;
  positionStyle: CSSProperties;
  /** On a lane of your own: the bar's row is clickable, a hit to remove it,
   *  an empty step to add one. One row only — a node is one line. */
  onStepClick?: (step: number) => void;
  /** What the card adds under the bar on a lane of your own. */
  footer?: ReactNode;
  /** Play the whole run, every repeat, from its first bar to its last. */
  onPlay?: (start: number, end: number) => void;
  onStop?: () => void;
  /** The player is running. */
  isPlaying?: boolean;
}) {
  const change = describeBarChange(bar);
  const staffSteps = Math.max(groove.steps, bar.steps);
  // Open, the card plays along — no toggle: the card's bar and its cell in
  // the run light while that bar is the one sounding. The lane moves the card on to each
  // bar as playback reaches it, so while playing, the card's bar is the one
  // sounding; paused, it stays on whichever bar was picked.
  const paintClock = usePaintClock();
  const packed = usePlayheadValue((t) => {
    const i = bars.findIndex((b) => b.start <= t && t < b.end);
    if (i < 0 || bars[i].motif !== groove.motif) return -1;
    const b = bars[i];
    const step = Math.min(b.steps - 1, Math.floor(((t - b.start) / (b.end - b.start)) * b.steps));
    return i * STEP_PACK + step;
  }, paintClock);
  const playing = packed < 0 ? -1 : Math.floor(packed / STEP_PACK);
  const step = packed < 0 ? -1 : packed % STEP_PACK;
  return (
    <div
      ref={popoverRef}
      style={positionStyle}
      data-annotation-popover
      className="z-50 w-[300px] rounded-md border border-gray-700 bg-[#0d0f13] p-3 shadow-xl text-left"
    >
      <div className="flex items-baseline gap-2 mb-2">
        <span className="w-2.5 h-2.5 rounded-full shrink-0 self-center" style={{ background: color }} />
        <span className="text-[12px] font-semibold text-gray-100 leading-snug">
          Groove {groove.motif}
          {groove.loopBars > 1 && <span className="font-normal text-gray-300"> · {groove.loopBars}-bar loop</span>}
          {groove.names.length > 0 && <span className="font-normal text-gray-300"> · {groove.names.join(', ')}</span>}
        </span>
        <span className="ml-auto text-[11px] text-gray-500 whitespace-nowrap" title={formatClockTime(bar.start)}>
          {barSpan(bar)}
        </span>
        {onPlay && (() => {
          const runStart = run[0]?.bar.start ?? bar.start;
          const runEnd = run[run.length - 1]?.bar.end ?? bar.end;
          const inRun = !!isPlaying && run.some((r) => r.index === playing);
          return (
            <button
              type="button"
              data-testid="groove-play"
              aria-label={inRun ? 'Stop' : 'Play every repeat'}
              title={inRun ? 'Stop' : `Play every repeat · ${formatClockTime(runStart)}–${formatClockTime(runEnd)}`}
              className="self-center w-8 h-8 shrink-0 rounded border border-gray-600 text-gray-200 hover:border-emerald-400 flex items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400"
              onClick={(e) => { e.stopPropagation(); if (inRun) onStop?.(); else onPlay(runStart, runEnd); }}
            >
              {inRun
                ? <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><rect x="2" y="2" width="10" height="10" rx="1" fill="currentColor" /></svg>
                : <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><path d="M3 1.5v11l9.5-5.5z" fill="currentColor" /></svg>}
            </button>
          );
        })()}
      </div>
      {bar.event !== 'exact' && (
        <div className="text-[11px] text-amber-200 -mt-1 mb-2">
          {EVENT_WORDS[bar.event]}{change && <> ({change})</>}
        </div>
      )}
      <div
        className="mb-3"
        title={`Grey: groove ${groove.motif}. Hollow: the groove has it, this bar didn't play it. Ringed: this bar added it.`}
      >
        <CardTitle>{onStepClick ? 'This bar · click to edit' : 'This bar'}</CardTitle>
        <div className="flex gap-1.5">
          <div className="flex flex-col justify-around text-[9px] leading-none text-gray-400 w-8 shrink-0">
            {lines.map((row) => <span key={row}>{row}</span>)}
          </div>
          <div
            className={`relative flex-1 rounded-sm bg-black/40 ${onStepClick ? 'outline outline-1 outline-dashed outline-emerald-400/50 outline-offset-2' : ''}`}
            style={{ height: lines.length * CARD_ROW_PX + (onStepClick ? 6 : 0) }}
          >
            {/* On the groove's own count, so a repeat cut short draws over the
                part of the groove it reached; a longer bar (a riff version
                longer than its groove) on its own, with no groove behind. */}
            <Staff
              lines={lines} rows={bar.rows} steps={staffSteps} beatLines barSteps={bar.stepsPerBar}
              behind={bar.steps <= groove.steps ? groove.rows : undefined}
              now={playing === current ? { step } : undefined}
            />
            {onStepClick && (
              <div className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${staffSteps}, minmax(0, 1fr))` }}>
                {Array.from({ length: bar.steps }, (_, k) => {
                  const on = lines.some((row) => bar.rows[row].some((st) => st.step === k && st.state !== 'missing'));
                  return (
                    <button
                      key={k}
                      type="button"
                      data-step={k}
                      aria-label={`Step ${k + 1}: ${on ? 'remove the hit' : 'add a hit'}`}
                      title={`Step ${k + 1}: click to ${on ? 'remove the hit' : 'add a hit'}`}
                      className="rounded-sm hover:bg-white/15 hover:ring-1 hover:ring-inset hover:ring-white/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                      onClick={(e) => { e.stopPropagation(); onStepClick(k); }}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
      {footer}
      {run.length > 1 && (
        <RunStrip
          run={run} current={current} playing={playing} step={step} lines={lines} color={color} onPick={onPick}
        />
      )}
    </div>
  );
}

interface GrooveLaneRowProps {
  /** Identifies this lane to the shared popover registry. */
  laneId: string;
  model: GrooveLaneModel;
  /** Play along with the playhead: light the bar, flash the hits. */
  visualize?: boolean;
  duration: number;
  gridProps?: LaneGridProps;
  pendingSelection?: PendingSelection | null;
  onSeek?: (time: number) => void;
  onRegion?: (t1: number, t2: number) => void;
  onRegionDragStart?: () => void;
  /** A lane of your own: a drag over empty space makes an item there (see
   *  laneCreate.ts) instead of the teal highlight, painted in `createColor`
   *  and snapped by `createSnap` while it is dragged. */
  onCreate?: (t1: number, t2: number) => void;
  createColor?: string;
  createSnap?: (t: number) => number;
  /** Stacked lanes the cells draw in (`GrooveBar.lane`): a riff lane's
   *  instances may overlap in time. 1 for a detector's grooves. */
  laneCount?: number;
  /** The row's own element, when the caller needs it too (a riff lane's drag
   *  and prominence editor measure against it). */
  containerRef?: RefObject<HTMLDivElement | null>;
  /** Cells outlined as one: the instance whose editor is open. */
  isFocused?: (index: number) => boolean;
  /** A press on a cell: a riff lane starts moving its instance from here. */
  onCellPointerDown?: (index: number, e: React.PointerEvent) => void;
  /** True right after a drag, so the click that ends it opens no card. */
  consumeDrag?: () => boolean;
  /** On a lane of your own: the card's bar row is clickable. */
  onCardStepClick?: (index: number, step: number) => void;
  /** On a lane of your own: what the card adds under the bar. */
  cardFooter?: (index: number) => ReactNode;
  /** The card's ▶: play a span of the song, and stop it. */
  onPlay?: (start: number, end: number) => void;
  onStop?: () => void;
  isPlaying?: boolean;
  /** Phrases bracketed over their bars (a riff lane's several-node
   *  instances). */
  spans?: readonly LaneSpan[];
  /** Drawn over the lanes, inside the row, `headerHeight` tall (a riff
   *  lane's title bar over each instance). The cells start under it. */
  header?: ReactNode;
  headerHeight?: number;
  /** Cells not drawn — a riff lane hides the instance open in its editor,
   *  which draws that instance itself. */
  hideCell?: (index: number) => boolean;
  /** A click on a cell, instead of the groove card: a riff lane of your own
   *  opens the node the cell plays. */
  onCellOpen?: (index: number, anchor: { x: number; y: number }) => void;
  /** Drawn under the lanes, inside the row (a riff's prominence editor). */
  below?: ReactNode;
  /** The height `below` takes, px. */
  belowHeight?: number;
}

export function GrooveLaneRow({
  laneId, model, visualize = false, duration, gridProps, pendingSelection, onSeek, onRegion, onRegionDragStart,
  onCreate, createColor, createSnap,
  laneCount = 1, containerRef: outerRef, isFocused, onCellPointerDown, consumeDrag, onCardStepClick, cardFooter,
  onPlay, onStop, isPlaying,
  spans, header, headerHeight = 0, hideCell, onCellOpen, below, belowHeight = 0,
}: GrooveLaneRowProps) {
  const ownRef = useRef<HTMLDivElement>(null);
  const containerRef = outerRef ?? ownRef;
  // The row's rendered width — at zoom, the whole zoomed track — so a cell can
  // tell whether its hits would be wide enough to see (MIN_STEP_PX).
  const [rowWidthPx, setRowWidthPx] = useState(0);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setRowWidthPx(Math.round(el.getBoundingClientRect().width));
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => setRowWidthPx(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  const { open, openAt, popoverRef, positionStyle } = useAnnotationPopover({ width: 300, height: 300 });
  const openIndex = open?.layerId === laneId ? Number(open.itemId) : -1;
  const openBar = openIndex >= 0 ? model.bars[openIndex] : undefined;
  const openGroove = openBar ? model.grooves.find((g) => g.motif === openBar.motif) : undefined;
  const openRun = useMemo(() => (openBar
    ? model.bars.flatMap((bar, index) => (bar.run === openBar.run ? [{ bar, index }] : []))
    : []), [model.bars, openBar]);
  const sounding = usePlayheadValue((t) => model.bars.findIndex((b) => b.start <= t && t < b.end), usePaintClock());
  const litBar = visualize ? sounding : -1;
  // An open card follows the playback: each time the playhead crosses into
  // another bar, the card turns to that bar — the one being heard is the one
  // being read. Only a CHANGE moves it, so a bar opened while paused (or
  // picked from the run strip) stays put until playback reaches the next bar.
  const followedRef = useRef(sounding);
  useEffect(() => {
    if (followedRef.current === sounding) return;
    followedRef.current = sounding;
    if (open?.layerId === laneId && sounding >= 0 && String(sounding) !== open.itemId) {
      openAt(laneId, String(sounding), open.anchor ?? undefined);
    }
  }, [sounding, open, laneId, openAt]);

  return (
    <div
      ref={containerRef}
      className="relative w-full select-none overflow-visible rounded bg-gray-950"
      style={{ minHeight: headerHeight + GROOVE_LANE_H * laneCount + belowHeight }}
    >
      {gridProps && <BeatGridOverlay {...gridProps} duration={duration} />}
      {/* Behind the cells, so empty space — no drums — still seeks and drags. */}
      {onSeek && onRegion && (
        <RegionDragOverlay
          duration={duration}
          onVizClick={onSeek}
          onVizRegion={onCreate ?? onRegion}
          onRegionDragStart={onCreate ? undefined : onRegionDragStart}
          createColor={onCreate ? createColor : undefined}
          snapTime={onCreate ? createSnap : undefined}
          hint={onCreate ? 'Drag to start a riff here · click to move the playhead' : undefined}
          z=""
        />
      )}
      {/* The cells' own box: the whole row, less what `below` holds. Clicks
          through it, so empty space still seeks and drags. */}
      {header}
      <div className="absolute inset-x-0 pointer-events-none" style={{ top: headerHeight, bottom: belowHeight }}>
        {duration > 0 && model.bars.map((bar, i) => (hideCell?.(i) ? null : (
          <BarCell
            key={`${bar.lane ?? 0}:${bar.start}`}
            bar={bar}
            lines={model.rows}
            duration={duration}
            rowWidthPx={rowWidthPx}
            color={model.colorOf(bar.motif)}
            lit={i === litBar}
            laneCount={laneCount}
            focused={isFocused?.(i) ?? false}
            movable={!!onCellPointerDown}
            onPointerDown={onCellPointerDown ? (e) => onCellPointerDown(i, e) : undefined}
            onOpen={(anchor) => {
              if (consumeDrag?.()) return;
              if (onCellOpen) onCellOpen(i, anchor);
              else openAt(laneId, String(i), anchor);
            }}
          />
        )))}
        {duration > 0 && (
          <RunLabels
            bars={hideCell ? model.bars.filter((_, i) => !hideCell(i)) : model.bars}
            duration={duration} rowWidthPx={rowWidthPx} laneCount={laneCount}
          />
        )}
        {duration > 0 && spans?.length ? (
          <LaneSpans spans={spans} duration={duration} rowWidthPx={rowWidthPx} laneCount={laneCount} />
        ) : null}
        {/* One flash strip per drum across the row: on stacked lanes there is
            no one row to flash, and the lit cell already says where it is. */}
        {visualize && duration > 0 && laneCount === 1 && (
          <DrumFlash bars={model.bars} lines={model.rows} duration={duration} rowWidthPx={rowWidthPx} />
        )}
      </div>
      {below}
      <PlayheadLine
        duration={duration}
        className="absolute top-0 bottom-0 w-px pointer-events-none z-10"
        style={{ background: 'rgba(255,255,255,0.75)' }}
      />
      {pendingSelection && (
        <PendingHighlightOverlay sel={pendingSelection} duration={duration} grid={gridProps} />
      )}
      {/* On the body, not in the row: the card is fixed-position, but inside the
          row it stays in the row's stacking context and every lane below
          paints over it, whatever its z-index. */}
      {openBar && openGroove && createPortal(
        <GrooveCard
          bars={model.bars}
          bar={openBar}
          current={openIndex}
          run={openRun}
          groove={openGroove}
          lines={model.rows}
          color={model.colorOf(openBar.motif)}
          onPick={(i) => openAt(laneId, String(i), open?.anchor ?? undefined)}
          popoverRef={popoverRef}
          positionStyle={positionStyle}
          onStepClick={onCardStepClick && model.bars[openIndex]?.motif !== REST_MOTIF
            ? (st) => onCardStepClick(openIndex, st) : undefined}
          footer={cardFooter?.(openIndex)}
          onPlay={onPlay}
          onStop={onStop}
          isPlaying={isPlaying}
        />,
        document.body,
      )}
    </div>
  );
}
