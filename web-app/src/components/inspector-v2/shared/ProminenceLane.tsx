/**
 * The canvas half of the front/back feature — how a prominence envelope reads
 * on the timeline, and how it's edited by dragging.
 *
 * Two states, so the always-on read view costs no vertical space:
 *
 *  - ProminenceFill  — drawn INSIDE the existing band. Fill height and hex
 *    alpha both track the level's weight, so a part that leads and then drops
 *    back reads as a skyline stepping down. Items without an envelope don't
 *    render this at all and look exactly as they did before the feature.
 *
 *  - ProminenceStrip — the four-row editor, opened from the card's Prominence
 *    section. The 12px default lane is far too thin to grab a handle in; this
 *    gives the handles room without permanently taxing the row height.
 *
 *    It is the WHOLE editor while it is up: the card that opened it stops
 *    drawing itself (see AnnotationPointCard), so the strip carries its own
 *    header — the four level buttons, clear, and the × that hands the card
 *    back. Two surfaces for one value, one of them floating over the lane the
 *    other one lives in, is what this replaced; a floating toolbar for the
 *    strip was still two things competing for the same attention.
 *
 * Alpha is encoded as a hex suffix on the colour rather than CSS `opacity`,
 * matching the convention every other lane row here already uses.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  PROMINENCE_EPSILON,
  PROMINENCE_INFO,
  PROMINENCE_LEVELS,
  normalizeProminence,
  prominenceAt,
  removeProminencePoint,
  setProminenceAt,
  toggleProminenceRamp,
  type ProminenceEnvelope,
  type ProminenceLevel,
} from '../../../types/annotationLayer';
import { useProminenceDrag } from '../../../hooks/useProminenceDrag';
import { setCardSectionOpen } from './CardSection';

/**
 * The strip currently on the canvas, in a single module slot.
 *
 * At most one can be mounted: it's gated on the Prominence section of the one
 * open annotation popover (popovers are mutually exclusive — see
 * useAnnotationPopover), so "which item?" never has to be asked. That lets the
 * popover card ask two things it otherwise couldn't without threading an id
 * and a ref through four lane rows and four card kinds: *is the strip up* (so
 * the card can stop repeating its breakpoint list) and *where is it* (so the
 * card can move off it).
 */
let stripEl: HTMLDivElement | null = null;
const stripListeners = new Set<() => void>();

function setStripEl(el: HTMLDivElement | null): void {
  if (stripEl === el) return;
  stripEl = el;
  stripListeners.forEach((fn) => fn());
}

/** The mounted prominence strip's element, or null when none is open. */
export function useProminenceStrip(): HTMLDivElement | null {
  const subscribe = useCallback((onChange: () => void) => {
    stripListeners.add(onChange);
    return () => { stripListeners.delete(onChange); };
  }, []);
  return useSyncExternalStore(subscribe, () => stripEl, () => null);
}

/** Height of the four breakpoint rows. */
export const PROMINENCE_EDIT_H = 56;

/** Height of the strip's own header — level buttons, clear, close. */
const HEADER_H = 20;

/** Width of the caps that mark the held stretches at either end of an arc. */
const CAP_W = 5;

/** What an editing lane row has to grow by: header + rows. */
export const PROMINENCE_EDIT_TOTAL_H = PROMINENCE_EDIT_H + HEADER_H;

const ROW_H = PROMINENCE_EDIT_H / PROMINENCE_LEVELS.length;

/** Weight → two-hex-digit alpha suffix. Floors at 0x2a so a `silent` stretch
 *  is still faintly visible as "annotated but not playing" rather than a gap
 *  that reads as a missing annotation. Runs to full opacity at `lead` so the
 *  four levels stay far apart on a 12px band — the band's own flat background
 *  is suppressed when an envelope exists (see the lane rows), so this alpha
 *  carries the whole signal. */
function alphaFor(weight: number): string {
  const a = Math.round(0x2a + weight * (0xff - 0x2a));
  return a.toString(16).padStart(2, '0');
}

/** Weight → fraction of the band's height the fill occupies. Paired with the
 *  alpha ramp so height and brightness reinforce each other. */
function heightFor(weight: number): number {
  return 0.18 + weight * 0.82;
}

/** Band background for an item that HAS an envelope. The usual flat
 *  `${color}55` would sit behind every segment and wash out the low levels,
 *  making `backing` almost indistinguishable from an unannotated band. */
export function prominenceBandBackground(color: string, isActive: boolean): string {
  return `${color}${isActive ? '26' : '14'}`;
}

interface Segment {
  /** Fractions of the item's own duration, 0..1. */
  from: number;
  to: number;
  fromWeight: number;
  toWeight: number;
  level: ProminenceLevel;
  ramp: boolean;
}

/** Break an envelope into renderable segments across the item's duration. */
function toSegments(points: ProminenceEnvelope, itemDuration: number): Segment[] {
  if (itemDuration <= 0) return [];
  const segs: Segment[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const next = points[i + 1];
    const w = PROMINENCE_INFO[p.level].weight;
    const from = Math.max(0, Math.min(1, p.t / itemDuration));
    const to = next ? Math.max(0, Math.min(1, next.t / itemDuration)) : 1;
    if (to <= from) continue;
    // A ramp belongs to the segment BEFORE the point it ramps into — that's
    // the stretch over which the crossfade is actually happening.
    const rampsOut = !!next && next.ramp === 'ramp';
    segs.push({
      from,
      to,
      fromWeight: w,
      toWeight: rampsOut ? PROMINENCE_INFO[next.level].weight : w,
      level: p.level,
      ramp: rampsOut,
    });
  }
  return segs;
}

interface ProminenceFillProps {
  points: ProminenceEnvelope | undefined;
  /** The item's own duration in seconds. */
  itemDuration: number;
  color: string;
}

/** Absolutely-positioned overlay filling its parent band. The parent must be
 *  `position: relative|absolute` with `overflow: hidden` — every band already
 *  is. Renders nothing when the item has no envelope. */
export function ProminenceFill({ points, itemDuration, color }: ProminenceFillProps) {
  const segs = useMemo(
    () => (points ? toSegments(points, itemDuration) : []),
    [points, itemDuration],
  );
  if (segs.length === 0) return null;
  return (
    <div className="absolute inset-0 pointer-events-none">
      {segs.map((s, i) => {
        const startA = alphaFor(s.fromWeight);
        const endA = alphaFor(s.toWeight);
        const startH = heightFor(s.fromWeight) * 100;
        const endH = heightFor(s.toWeight) * 100;
        return (
          <div
            key={i}
            className="absolute bottom-0"
            style={{
              left: `${s.from * 100}%`,
              width: `${(s.to - s.from) * 100}%`,
              // A ramp grows/shrinks its box to the taller of the two ends and
              // uses a vertical mask to fake the diagonal; a step is a flat box.
              height: `${Math.max(startH, endH)}%`,
              background: s.ramp
                ? `linear-gradient(to right, ${color}${startA}, ${color}${endA})`
                : `${color}${startA}`,
              clipPath: s.ramp
                ? `polygon(0% ${100 - (startH / Math.max(startH, endH)) * 100}%, 100% ${100 - (endH / Math.max(startH, endH)) * 100}%, 100% 100%, 0% 100%)`
                : undefined,
            }}
          />
        );
      })}
    </div>
  );
}

interface ProminenceStripProps {
  points: ProminenceEnvelope | undefined;
  /** Item bounds in track seconds. */
  start: number;
  end: number;
  /** Track duration + the timeline container the x axis is measured against. */
  duration: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  color: string;
  /** Vertical offset of the strip within the lane row. */
  top: number;
  /** Playhead in track seconds — the level buttons apply there when it's
   *  inside the item, which is what makes them quick: scrub to where the
   *  vocal enters, click Backing. */
  currentTime?: number;
  readOnly?: boolean;
  /** Pull a breakpoint onto the song's beat grid as it's dragged or placed.
   *  Track seconds in, track seconds out — the host passes the page's one snap
   *  function, which is the identity while Snap and Grid Lock are both off, so
   *  a breakpoint obeys the same switch every other annotation here does. A
   *  breakpoint is a musical instant ("the vocal takes the lead on the
   *  downbeat"), and placing it three-hundredths of a beat off is noise in
   *  every export. */
  snapTime?: (trackSeconds: number) => number;
  onChange: (points: ProminenceEnvelope | undefined) => void;
  onDragStart?: () => void;
}

/** The expanded four-row breakpoint editor, spanning the item's x-range. */
export function ProminenceStrip({
  points, start, end, duration, containerRef, color, top, currentTime,
  readOnly = false, snapTime, onChange, onDragStart,
}: ProminenceStripProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const pointsRef = useRef(points);
  pointsRef.current = points;

  // Publish this strip for the card to find (see the module slot above) — it's
  // how the card knows to stand down and let this be the only editor.
  useEffect(() => {
    const el = wrapRef.current;
    setStripEl(el);
    return () => { if (stripEl === el) setStripEl(null); };
  }, []);

  const itemDuration = Math.max(0, end - start);
  const left = duration > 0 ? (start / duration) * 100 : 0;
  const width = duration > 0 ? (itemDuration / duration) * 100 : 0;

  const { startDrag } = useProminenceDrag<{ index: number }>({
    containerRef,
    stripRef,
    duration,
    rows: PROMINENCE_LEVELS.length,
    onDragStart,
    // Snap first, then keep each handle inside the item and strictly between
    // its neighbours, so dragging can never reorder or stack breakpoints. That
    // order matters: a grid line just past a neighbour has to give way to the
    // neighbour, not drag the handle through it.
    clamp: ({ index }, raw) => {
      const snapped = snapTime ? snapTime(raw) : raw;
      const cur = pointsRef.current;
      if (!cur) return snapped;
      const lo = index > 0 ? start + cur[index - 1].t + PROMINENCE_EPSILON : start;
      const hi = index < cur.length - 1 ? start + cur[index + 1].t - PROMINENCE_EPSILON : end;
      return Math.max(lo, Math.min(hi, snapped));
    },
    onDrag: ({ index }, tTrack, row) => {
      const cur = pointsRef.current;
      if (!cur) return;
      const next = cur.map((p, i) => (
        i === index ? { ...p, t: tTrack - start, level: PROMINENCE_LEVELS[row] } : p
      ));
      onChange(normalizeProminence(next));
    },
  });

  // Clicking empty space in a row adds a breakpoint there — the fastest way to
  // build an arc once the strip is already open.
  const addAt = (clientX: number, row: number, el: HTMLElement) => {
    if (readOnly) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || itemDuration <= 0) return;
    // Snapped in TRACK time — the grid is the song's, not the item's — and
    // then brought back into item time and held inside the item, since a grid
    // line just outside either end would otherwise place a breakpoint there.
    const tTrack = start + ((clientX - rect.left) / rect.width) * itemDuration;
    const tRel = Math.max(0, Math.min(
      itemDuration,
      (snapTime ? snapTime(tTrack) : tTrack) - start,
    ));
    // Through the shared mutation rather than hand-rolled, so a first click
    // lands where it was aimed here too: setProminenceAt brings the opening
    // anchor an envelope needs, instead of the point being pulled back to the
    // start to serve as one.
    onChange(setProminenceAt(pointsRef.current, tRel, PROMINENCE_LEVELS[row]));
  };

  // Where the level buttons land. The playhead when it's inside the item —
  // the same rule the card's copy of these buttons used — else the t=0 anchor,
  // the only other position that always means something.
  const tRel = currentTime !== undefined ? currentTime - start : null;
  const playheadInside = tRel !== null && tRel >= 0 && tRel <= itemDuration;
  const applyAt = playheadInside ? tRel : 0;
  const activeLevel = prominenceAt(points, applyAt)?.level;

  return (
    <div
      ref={wrapRef}
      data-prominence-strip
      className="absolute z-30"
      // Explicit height: everything inside is absolutely positioned, so
      // without it the wrapper measures zero and anything reading the
      // editor's rect (the card's clearance check) gets nonsense.
      style={{ left: `${left}%`, width: `${width}%`, top, height: PROMINENCE_EDIT_TOTAL_H }}
    >
      {/* The strip's own header. Sized to its buttons rather than to the item,
        * so a two-second pattern still gets a usable one; anchored to whichever
        * end keeps it inside the lane, which clips at its own edges. */}
      <div
        className={`absolute flex items-center gap-1 ${left > 55 ? 'right-0' : 'left-0'}`}
        style={{ top: 0, height: HEADER_H, whiteSpace: 'nowrap' }}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <span
          className="text-[9px] uppercase tracking-wider select-none"
          style={{ color }}
          title={`Prominence — ${playheadInside ? 'buttons apply at the playhead' : 'buttons apply at the start of this annotation; move the playhead inside it to place one mid-way'}\nClick a row to add a breakpoint · drag to move · ⌥-click to crossfade · right-click to remove${snapTime ? '\nBreakpoints land on the beat grid while Snap to grid is on' : ''}`}
        >
          {playheadInside ? 'at playhead' : 'at start'}
        </span>
        {PROMINENCE_LEVELS.map((level) => {
          const info = PROMINENCE_INFO[level];
          const isActive = activeLevel === level;
          return (
            <button
              key={level}
              type="button"
              disabled={readOnly}
              onClick={() => onChange(setProminenceAt(points, applyAt, level))}
              className={`rounded px-1 py-[1px] text-[10px] leading-none border ${
                readOnly ? 'cursor-not-allowed opacity-60' : 'hover:bg-white/[0.08]'
              } ${isActive ? 'text-slate-50' : 'text-slate-300 border-white/[0.08] bg-[#0a0b0d]'}`}
              style={isActive ? { borderColor: color, background: `${color}33` } : undefined}
              title={`${info.label}\n${info.description}`}
            >
              {info.short}
            </button>
          );
        })}
        {!readOnly && points && points.length > 0 && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="text-[10px] text-slate-400 hover:text-slate-200 underline decoration-dotted"
            title="Remove the prominence annotation entirely"
          >
            clear
          </button>
        )}
        {/* "Done", not a ×: the arc is already saved — every edit here goes
          * through the same autosave as the card — and a × next to a lane you
          * have just been drawing on reads like "discard". */}
        <button
          type="button"
          onClick={() => setCardSectionOpen('prominence', false)}
          className="rounded px-1 py-[1px] text-[9px] leading-none uppercase tracking-wider border text-slate-100 hover:brightness-125"
          style={{ borderColor: `${color}66`, background: `${color}26` }}
          title="Done — closes this editor and brings the annotation's card back. Your changes are already saved."
        >
          Done
        </button>
      </div>

      <div
        ref={stripRef}
        className="absolute left-0 right-0 rounded-sm overflow-hidden"
        style={{
          top: HEADER_H,
          height: PROMINENCE_EDIT_H,
          background: 'rgba(10,11,13,0.92)',
          boxShadow: `inset 0 0 0 1px ${color}66`,
        }}
      >
      {PROMINENCE_LEVELS.map((level, row) => (
        <div
          key={level}
          className={`absolute left-0 right-0 ${readOnly ? '' : 'cursor-copy'}`}
          style={{
            top: row * ROW_H,
            height: ROW_H,
            borderBottom: row < PROMINENCE_LEVELS.length - 1 ? '1px solid rgba(255,255,255,0.05)' : undefined,
            // Faint front-to-back gradient across the rows so the strip reads
            // top = front even before any breakpoint is placed.
            background: `rgba(255,255,255,${(0.02 + PROMINENCE_INFO[level].weight * 0.035).toFixed(3)})`,
          }}
          onPointerDown={(e) => { e.stopPropagation(); }}
          onMouseDown={(e) => { e.stopPropagation(); }}
          onClick={(e) => { e.stopPropagation(); addAt(e.clientX, row, e.currentTarget); }}
          title={`${PROMINENCE_INFO[level].label} — click to place a breakpoint here`}
        >
          {/* Nudged clear of the t=0 handle, which straddles x=0 and would
            *  otherwise sit on top of the first row's label. */}
          <span
            className="absolute left-[8px] top-0 text-[9px] leading-[14px] text-slate-400 pointer-events-none select-none"
            style={{ textShadow: '0 0 3px rgba(0,0,0,0.95)' }}
          >
            {PROMINENCE_INFO[level].short}
          </span>
        </div>
      ))}

      {/* Connecting line through the breakpoints, so the arc reads as a shape
       *  rather than a scatter of dots. Stepped for an instant switch and
       *  diagonal for a crossfade — the ramp used to be visible only as a
       *  glyph in the card's breakpoint chips, which meant the strip could not
       *  be the whole editor. */}
      {points && points.length > 1 && (
        <svg className="absolute inset-0 w-full h-full pointer-events-none" preserveAspectRatio="none" viewBox="0 0 100 100">
          <polyline
            points={(() => {
              const rowY = (level: ProminenceLevel) =>
                (PROMINENCE_LEVELS.indexOf(level) + 0.5) * (100 / PROMINENCE_LEVELS.length);
              const out: string[] = [];
              let prevY = 0;
              points.forEach((p, i) => {
                const x = itemDuration > 0 ? (p.t / itemDuration) * 100 : 0;
                const y = rowY(p.level);
                // A step holds the previous level right up to this point and
                // only then jumps; a ramp is the straight line from the last
                // point to this one.
                if (i > 0 && p.ramp !== 'ramp') out.push(`${x},${prevY}`);
                out.push(`${x},${y}`);
                prevY = y;
              });
              // Run out to the item's end. The last breakpoint holds from
              // where it is until the annotation stops — that's what the band
              // above already draws — and a line that ended at the final dot
              // read as "and then nothing", which is what `silent` is for.
              out.push(`100,${prevY}`);
              return out.join(' ');
            })()}
            fill="none"
            stroke={color}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            opacity={0.7}
          />
        </svg>
      )}

      {/* End cap on the run-out's row, so where the annotation stops is a mark
        * on the strip rather than something you infer from the box edge. Not
        * a breakpoint and not draggable: there is no time after it to
        * describe. Inert to the pointer so the row underneath stays clickable
        * right up to the edge. */}
      {points && points.length > 0 && (() => {
        const lastRow = PROMINENCE_LEVELS.indexOf(points[points.length - 1].level);
        if (lastRow < 0) return null;
        return (
          <div
            className="absolute pointer-events-none"
            style={{
              right: 0,
              top: lastRow * ROW_H,
              height: ROW_H,
              width: CAP_W,
              background: color,
              boxShadow: `0 0 5px ${color}aa`,
            }}
          />
        );
      })()}

      {(points ?? []).map((p, i) => {
        const x = itemDuration > 0 ? (p.t / itemDuration) * 100 : 0;
        const row = PROMINENCE_LEVELS.indexOf(p.level);

        // The opening breakpoint is a cap, not a dot — the mirror of the
        // run-out's cap at the other end. Both ends of an arc are a level
        // being *held*; only the transitions in between are things you placed,
        // and only those should look placeable. It also stops the round handle
        // being drawn half outside the strip at x=0, and answers the "why is
        // there a dot I didn't put there?" that the opening anchor otherwise
        // raises. Still fully editable: it can't move in time (an envelope's
        // first point is always the start), so it takes the one drag that
        // means anything — up and down, to change the level it opens on.
        if (i === 0) {
          return (
            <button
              key={`cap-${p.level}`}
              type="button"
              className={`absolute left-0 z-10 ${readOnly ? '' : 'cursor-ns-resize touch-none tc-hit'}`}
              style={{
                top: row * ROW_H + 1,
                height: ROW_H - 2,
                width: CAP_W,
                background: color,
                boxShadow: `0 0 5px ${color}aa`,
              }}
              onPointerDown={(e) => { if (!readOnly) startDrag({ index: i }, e); }}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!readOnly) onChange(removeProminencePoint(points!, i));
              }}
              title={`${PROMINENCE_INFO[p.level].label} from the start${
                points!.length === 1 ? ` — holds the whole annotation (${itemDuration.toFixed(2)}s)` : ''
              }\nDrag up or down to change the level it opens on · right-click to remove`}
            />
          );
        }

        return (
          <button
            key={`${i}-${p.t}`}
            type="button"
            className={`absolute w-2.5 h-2.5 rounded-full z-10 ${readOnly ? '' : 'cursor-move touch-none tc-hit'}`}
            style={{
              left: `${x}%`,
              top: row * ROW_H + ROW_H / 2,
              transform: 'translate(-50%, -50%)',
              background: color,
              boxShadow: `0 0 0 1px rgba(0,0,0,0.8), 0 0 6px ${color}88`,
            }}
            onPointerDown={(e) => {
              if (readOnly) return;
              // Alt-click flips how this breakpoint is arrived at. Not a plain
              // click: that's the tail of every drag, and an arc would flip
              // ramps every time it was nudged.
              if (e.altKey && i > 0) {
                e.preventDefault();
                e.stopPropagation();
                onChange(toggleProminenceRamp(points!, i));
                return;
              }
              startDrag({ index: i }, e);
            }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!readOnly) onChange(removeProminencePoint(points, i));
            }}
            title={`${PROMINENCE_INFO[p.level].label} from +${p.t.toFixed(2)}s${p.ramp === 'ramp' ? ' (crossfaded in)' : ''}${
              i === points!.length - 1 ? ` — holds to the end (+${itemDuration.toFixed(2)}s)` : ''
            }\nDrag to move · right-click to remove${i > 0 ? `\n⌥-click to ${p.ramp === 'ramp' ? 'switch instantly' : 'crossfade in'}` : ''}`}
          />
        );
      })}
      </div>
    </div>
  );
}
