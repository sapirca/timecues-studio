// The grid-segment lane — a strip under the waveform in DataPrep showing how
// the song's ruler is divided, and letting the curator redivide it by hand.
//
// One block per segment, laid end to end: a segment ends exactly where the
// next one starts, so the blocks tile the track with no gaps to interpret.
// Each block is stamped with its meter and tempo at its head, the way a score
// stamps a meter change.
//
// The head itself is drawn as a DOUBLE BAR LINE for the same reason — it is
// the notation a musician already reads as "the count restarts here". Dragging
// it moves the whole downstream grid; right-clicking MERGES the segment into
// the one on its left — the split goes, and the earlier grid grows over the
// span, counting on at its own tempo.
//
// The bar the outgoing segment was in the middle of is hatched, with the beat
// count it kept written inside it, so a bar that only got 3.5 of its 4 beats
// reads as a deliberate cut rather than as a rendering bug.
//
// Positioning matches every other overlay on the waveform: the caller mounts
// this inside the `translateX(-scrollLeft)` wrapper whose width is the full
// zoomed timeline, so times map to pixels by a plain time/duration ratio.

import { useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { ResolvedSegment } from '../../utils/gridSegments';
import { canMoveHeadTo, cutPreviewAt, formatKeptBeats } from '../../utils/gridSegments';
import { useTimelineDrag } from '../../hooks/useTimelineDrag';
import { formatClockTime } from '../../utils/clockTime';
import { foldGridOffset } from '../../utils/beatGrid';

export interface GridSegmentLaneProps {
  segments: readonly ResolvedSegment[];
  /** Track duration in seconds — defines the time axis. */
  duration: number;
  /** Id of the selected segment, if any. */
  selectedId?: string | null;
  /** Bar number the first bar carries (the barBeatOrigin setting). */
  barBeatOrigin?: 0 | 1;
  /** When true the lane renders read-only: no drags, no adds, no deletes. */
  locked?: boolean;
  /** Click on a segment block. `anchor` is the cursor position, so the host's
   *  editor can open next to the click rather than at the block's midpoint —
   *  a segment block is as wide as its span, and its centre can be a screen
   *  away from where the pointer actually went down. */
  onSelect?: (segment: ResolvedSegment, anchor: { x: number; y: number }) => void;
  /** Live drag of a segment head. Fires continuously; the parent clamps,
   *  snaps and commits. Fired for the opening head too — a song whose bar 1
   *  isn't at 0:00 has an origin worth dragging, and the parent routes that
   *  one to `gridOffset` instead of to a stored split. */
  onHeadDrag?: (segment: ResolvedSegment, time: number) => void;
  onHeadDragStart?: (segment: ResolvedSegment) => void;
  onHeadDragEnd?: (segment: ResolvedSegment) => void;
  /** Right-click a head to merge the segment into the one before it: the
   *  stored head is dropped and the earlier grid grows over the span. Not
   *  offered for the opening segment, which has nothing before it. */
  onDeleteSegment?: (segment: ResolvedSegment) => void;
  /** Alt-click anywhere in the lane splits the grid there. */
  onSplitAt?: (time: number) => void;
  /** Snap an in-flight drag position. Receives the head being dragged so the
   *  snap can measure against the OUTGOING grid rather than the dragged
   *  segment's own, and whether Shift was held when the drag began — the host
   *  decides what Shift means. Identity when snapping is off. */
  snapTime?: (time: number, dragged: ResolvedSegment, shiftKey: boolean) => number;
  /** Whether a plain (no-Shift) drag snaps right now — the Snap-to-grid /
   *  Grid Lock state. Shown in the drag readout so "why didn't that snap?"
   *  is answered on the spot rather than by hunting through the toolbar. */
  snapping?: boolean;
}

/** Blocks alternate between two low-saturation tints so a segment's extent
 *  reads at a glance without any of them claiming a semantic color. */
const TINT = [
  'border-cyan-400/35 bg-gradient-to-b from-cyan-400/[0.13] to-cyan-400/[0.05]',
  'border-slate-300/25 bg-gradient-to-b from-slate-200/[0.07] to-slate-200/[0.02]',
];
const TINT_SELECTED = [
  'border-slate-100/60 bg-gradient-to-b from-cyan-400/25 to-cyan-400/[0.09]',
  'border-slate-100/60 bg-gradient-to-b from-slate-200/20 to-slate-200/[0.06]',
];

export function GridSegmentLane({
  segments,
  duration,
  selectedId,
  barBeatOrigin = 0,
  locked = false,
  onSelect,
  onHeadDrag,
  onHeadDragStart,
  onHeadDragEnd,
  onDeleteSegment,
  onSplitAt,
  snapTime,
  snapping = false,
}: GridSegmentLaneProps) {
  const laneRef = useRef<HTMLDivElement>(null);
  // The head currently under the cursor, with the readout the drag needs.
  const [dragging, setDragging] = useState<
    { id: string; time: number; free: boolean; origin: boolean } | null
  >(null);

  const { startDrag } = useTimelineDrag<{ segment: ResolvedSegment; shiftKey: boolean }>({
    containerRef: laneRef as RefObject<HTMLElement | null>,
    duration,
    onDragStart: ({ segment, shiftKey }) => {
      setDragging({
        id: segment.id, time: segment.start,
        free: snapping === shiftKey, origin: segment.index === 0,
      });
      onHeadDragStart?.(segment);
    },
    onDrag: ({ segment, shiftKey }, t) => {
      const snapped = snapTime ? snapTime(t, segment, shiftKey) : t;
      setDragging({
        id: segment.id, time: snapped,
        free: snapping === shiftKey, origin: segment.index === 0,
      });
      onHeadDrag?.(segment, snapped);
    },
    onDragEnd: ({ segment }) => {
      setDragging(null);
      onHeadDragEnd?.(segment);
    },
  });

  if (duration <= 0 || segments.length === 0) return null;

  const pct = (t: number) => (t / duration) * 100;
  const dragEnabled = !locked && !!onHeadDrag;

  return (
    <div
      ref={laneRef}
      className="relative h-[30px] bg-[#0b0d10] border-t border-white/[0.06] select-none"
      onDoubleClick={!locked && onSplitAt ? (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        if (rect.width <= 0) return;
        onSplitAt(((e.clientX - rect.left) / rect.width) * duration);
      } : undefined}
      title={locked ? 'Grid segments (read-only)' : 'Double-click to split the grid here'}
    >
      {segments.map((seg) => {
        const end = Number.isFinite(seg.end) ? seg.end : duration;
        const left = pct(seg.start);
        const width = Math.max(0, pct(end) - left);
        const isSelected = seg.id === selectedId;
        const tint = (isSelected ? TINT_SELECTED : TINT)[seg.index % 2];
        // Rendered width in px is what decides how much of the stamp fits;
        // the lane is inside the zoomed wrapper, so percentages of `duration`
        // are the only geometry available here. Gate on the fraction of the
        // track instead, which tracks px width monotonically at any zoom.
        const frac = width / 100;
        return (
          <button
            key={seg.id}
            type="button"
            onClick={(e) => onSelect?.(seg, { x: e.clientX, y: e.clientY })}
            aria-label={`Grid segment ${seg.index + 1}, ${seg.bpm.toFixed(2)} BPM at ${seg.timeSignature}`}
            aria-pressed={isSelected}
            className={`absolute top-[3px] bottom-[3px] rounded-[2px] border overflow-hidden flex items-center gap-[7px] pl-[9px] pr-[7px] transition-colors ${tint}`}
            style={{ left: `${left}%`, width: `calc(${width}% - 2px)` }}
            title={`Segment ${seg.index + 1} — ${seg.bpm.toFixed(2)} BPM · ${seg.timeSignature} · from ${formatClockTime(seg.start, 3)}`}
          >
            <span className="shrink-0 font-mono text-[11px] font-semibold leading-none text-cyan-200 tabular-nums">
              {seg.bpm.toFixed(2)}
            </span>
            {frac > 0.06 && (
              <span className="shrink-0 font-mono text-[10px] leading-none text-slate-100">
                {seg.timeSignature}
              </span>
            )}
            {frac > 0.12 && (
              <span className="ml-auto shrink-0 font-mono text-[9px] leading-none text-slate-500">
                segment {seg.index + 1}
              </span>
            )}
          </button>
        );
      })}

      {/* Heads sit above the blocks so the double bar line is never clipped
          by the block edge it divides. */}
      {segments.map((seg) => {
        const isOpening = seg.index === 0;
        const canDrag = dragEnabled;
        const canMerge = !locked && !isOpening && !!onDeleteSegment;
        return (
          <div
            key={`head-${seg.id}`}
            className={`group absolute top-0 bottom-0 w-[5px] ${canDrag ? 'cursor-ew-resize touch-none tc-hit' : ''}`}
            style={{ left: `calc(${pct(seg.start)}% - 1px)` }}
            title={
              isOpening
                ? `The song's first downbeat — ${formatClockTime(seg.start, 3)}${canDrag ? ' · drag to move it (this is the “Bar 1 at” value)' : ''}`
                : `Segment ${seg.index + 1} starts here${canDrag ? ' · drag to move' : ''}${canMerge ? ` · right-click to merge into segment ${seg.index}` : ''}`
            }
            onPointerDown={canDrag ? (e) => {
              if (e.button !== 0) return;
              startDrag({ segment: seg, shiftKey: e.shiftKey }, e);
            } : undefined}
            onContextMenu={canMerge ? (e) => {
              e.preventDefault();
              onDeleteSegment!(seg);
            } : undefined}
          >
            {/* The opening head stays quieter than a split's double bar line —
                it marks where the count begins, not where it restarts — but a
                draggable thing has to answer the cursor, so it brightens to a
                split's weight on hover. */}
            <span
              className={`absolute inset-y-0 left-0 w-px transition-colors ${
                isOpening
                  ? `bg-slate-100/35 ${canDrag ? 'group-hover:bg-slate-100/55' : ''}`
                  : 'bg-slate-100/55'
              }`}
            />
            <span
              className={`absolute inset-y-0 left-[3px] w-[2px] transition-colors ${
                isOpening
                  ? `bg-slate-100/65 ${canDrag ? 'group-hover:bg-slate-100' : ''}`
                  : 'bg-slate-100'
              }`}
              style={isOpening ? undefined : { boxShadow: '0 0 7px rgba(241,245,249,0.45)' }}
            />
          </div>
        );
      })}

      {dragging && (
        <DragReadout
          laneRef={laneRef as RefObject<HTMLElement | null>}
          segments={segments}
          draggingId={dragging.id}
          time={dragging.time}
          free={dragging.free}
          origin={dragging.origin}
          duration={duration}
          barBeatOrigin={barBeatOrigin}
        />
      )}
    </div>
  );
}

/** The live label that follows a head during a drag. Says where the head is
 *  in clock time, and — the question you are actually answering while you
 *  drag — how much of the outgoing bar survives it.
 *
 *  Rendered into the body rather than into the lane, and parked BELOW it. In
 *  the lane it did two unhelpful things at once: the lane's `overflow-hidden`
 *  clipped a two-line box out of a 30px row, and what did show sat right on
 *  top of the head, the bar line and the hatch — the three things the readout
 *  is describing. Below the lane it covers only the controls row, which
 *  nobody is reading mid-drag. */
const READOUT_HALF_WIDTH_PX = 110;

function DragReadout({
  laneRef,
  segments,
  draggingId,
  time,
  free,
  origin,
  duration,
  barBeatOrigin,
}: {
  laneRef: RefObject<HTMLElement | null>;
  segments: readonly ResolvedSegment[];
  draggingId: string;
  time: number;
  free: boolean;
  /** The head being dragged is the song's own downbeat, not a split. It
   *  cuts nothing, snaps to nothing, and plays by its own placement rules. */
  origin: boolean;
  duration: number;
  barBeatOrigin: 0 | 1;
}) {
  const dragged = segments.find((s) => s.id === draggingId);
  const check = dragged
    ? canMoveHeadTo(segments, dragged, time, duration)
    : { ok: true as const };
  const cut = origin ? null : cutPreviewAt(segments, time, draggingId);
  // gridOffset is a PHASE inside the first bar: withFoldedGridOffset() folds
  // anything larger back and renumbers the bars to match, leaving every grid
  // line where it was. So an origin dragged across a bar line lands somewhere
  // other than where the cursor is, and the readout has to show where it
  // actually lands — promising a downbeat the commit will move is the one
  // thing a live readout must never do.
  // Only meaningful for a position that will be taken: a refused drag has no
  // landing, so it shows the cursor's own time beside the reason it won't be
  // kept. Folding a rejected time would print a perfectly legal-looking
  // downbeat next to "too close to segment 2".
  const landing = origin && dragged && check.ok
    ? foldGridOffset(time, dragged.bpm, dragged.beatsPerBar)
    : time;
  const foldedAway = Math.abs(landing - time) > 1e-6;
  const rect = laneRef.current?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || duration <= 0) return null;
  // The lane rides the timeline's scroll transform, so its own rect already
  // carries the pan: time → client x is a plain ratio of it. Kept on screen
  // when the head is dragged near either edge of the viewport.
  const headX = rect.left + (landing / duration) * rect.width;
  const left = Math.max(
    READOUT_HALF_WIDTH_PX + 6,
    Math.min(window.innerWidth - READOUT_HALF_WIDTH_PX - 6, headX),
  );
  return createPortal(
    <div
      className={`fixed z-[1400] -translate-x-1/2 pointer-events-none whitespace-nowrap rounded-[3px] border px-[7px] py-[5px] font-mono text-[10px] leading-[1.35] shadow-[0_3px_14px_rgba(0,0,0,0.65)] ${
        check.ok
          ? 'border-slate-100/35 bg-[#0a0b0d]/95 text-slate-200'
          : 'border-red-500/50 bg-[#1a0a0c]/95 text-red-200'
      }`}
      style={{ left, top: rect.bottom + 6 }}
    >
      <span className="font-semibold text-slate-50">{formatClockTime(landing, 3)}</span>
      {' · '}
      <span
        className={origin || free ? 'text-slate-500' : 'text-violet-300'}
        title={origin
          ? 'The song’s downbeat is where the grid begins, so there are no beats before it to snap to.'
          : free
            ? 'Free placement — the head goes exactly where you drop it. Snap is off (or Shift is held).'
            : 'Snapping to the nearest beat of the outgoing grid. Hold Shift to place freely.'}
      >
        {origin || free ? 'free' : 'snap'}
      </span>
      {' · '}
      <span>new bar {barBeatOrigin === 1 ? 1 : 0} · beat {barBeatOrigin === 1 ? 1 : 0}</span>
      <br />
      {check.ok ? (
        origin ? (
          <span className="text-slate-400">
            {foldedAway
              ? 'same grid, renumbered — bar 1 is a phase inside the first bar'
              : 'every bar line moves with it — nothing is cut'}
          </span>
        ) : cut ? (
          <span className="text-red-300">
            bar {cut.barNumber + barBeatOrigin} keeps {formatKeptBeats(cut.beatsKept, cut.beatsPerBar)} of {cut.beatsPerBar} beats
          </span>
        ) : (
          <span className="text-slate-400">lands on a bar line — nothing is cut</span>
        )
      ) : (
        <span>{check.reason}</span>
      )}
    </div>,
    document.body,
  );
}

/** The hatched tail of a segment that was cut mid-bar, drawn over the
 *  waveform rather than in the lane so it sits on the audio it describes.
 *  Rendered by PlayerPanel inside the same scroll wrapper as the beat grid.
 *
 *  The hatch is always drawn — it IS the state, and it is translucent enough
 *  to read the waveform through. The beat-count chip is not: it sits on top
 *  of the audio, so it is drawn only for the cut the curator is working on —
 *  `labelledSegmentId`, the segment-lane selection, matching either the cut
 *  segment itself or the one whose head did the cutting. Everywhere else the
 *  hatch's own tooltip still carries the count, so nothing is lost by leaving
 *  the chip off, and there is no dismissed state to remember or to restore. */
export function GridSegmentCutOverlay({
  segments,
  duration,
  labelledSegmentId = null,
}: {
  segments: readonly ResolvedSegment[];
  duration: number;
  /** Selected segment. Its cut is labelled, as is the cut immediately
   *  upstream of it — dragging a head cuts the bar of the segment BEFORE it,
   *  and that is the bar you want the count for. `null` labels nothing. */
  labelledSegmentId?: string | null;
}) {
  if (duration <= 0 || segments.length < 2) return null;
  return (
    <>
      {segments.map((seg, i) => {
        if (!(seg.cutBeats > 0) || !Number.isFinite(seg.end)) return null;
        const left = (seg.cutBarStart / duration) * 100;
        const width = ((seg.end - seg.cutBarStart) / duration) * 100;
        if (!(width > 0)) return null;
        const labelled = labelledSegmentId != null
          && (seg.id === labelledSegmentId || segments[i + 1]?.id === labelledSegmentId);
        return (
          <div
            key={`cut-${seg.id}`}
            className="absolute inset-y-0 border-r border-red-500/30"
            style={{
              left: `${left}%`,
              width: `${width}%`,
              // A bar cut half a beat short is a fraction of a pixel wide when
              // the whole song is on screen. Keep a hairline of hatch so the
              // cut is still visible before you zoom into it.
              minWidth: 3,
              background:
                'repeating-linear-gradient(-45deg, rgba(239,68,68,0.16) 0 4px, transparent 4px 9px)',
            }}
            title={`This bar is cut short — it keeps ${formatKeptBeats(seg.cutBeats, seg.beatsPerBar)} of its ${seg.beatsPerBar} beats.`}
          >
            {/* Pinned just under the bar-number row rather than centred on the
                waveform: the top strip is the one place on the surface that
                carries no amplitude, so the chip stops covering the audio it
                is annotating. */}
            {labelled && width / 100 * duration > 0.9 && (
              <span className="absolute left-1/2 top-[13px] -translate-x-1/2 whitespace-nowrap rounded-[2px] border border-red-500/40 bg-red-950/75 px-1 py-[2px] font-mono text-[9px] leading-none text-red-300">
                {formatKeptBeats(seg.cutBeats, seg.beatsPerBar)} of {seg.beatsPerBar} beats
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}
