/**
 * CueLayerRow — vertical tick marks for a single Cue layer on the canvas.
 *
 * Unlike SectionBlockRow (which renders contiguous colored blocks for
 * partitions), Cues are point events. Each tick is clickable: clicking
 * fires onCueClick(itemId, anchor), which the parent uses to open the
 * inline edit popover anchored near the click.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CueItem } from '../../types/annotationLayer';
import { formatClockTime as fmtTime } from '../../utils/clockTime';
import { BeatGridOverlay, type LaneGridProps } from './BeatGridOverlay';
import { isOnGridLine, SNAP_INDICATOR_COLOR } from '../../utils/snapIndication';
import { SnapTick } from './SnapIndicator';
import { useTimelineDrag } from '../../hooks/useTimelineDrag';
import { isSelectToggle, useCrossLaneDrop, type CrossLaneDropOptions } from '../../hooks/useCrossLaneDrop';
import { PendingHighlightOverlay, RegionDragOverlay, type PendingSelection } from './AnnotationOverlays';
import { ReviewControls, reviewBgFor, type ReviewStatus } from './ReviewControls';
import { drumHitTitle } from '../../utils/drumHits';
import { stackTicks, tickHeightPct } from '../../utils/tickStacking';
import { cueSubject } from '../../utils/cueSubject';
import { usePaintClock, usePlayheadValue } from '../../hooks/usePlayhead';
import { PlayheadLine } from '../Playhead';
import { DECAY_STEP_COARSE_SEC, DECAY_STEP_FINE_SEC, decayReadout, stepCueDecay } from '../../utils/cueDecay';

interface CueLayerRowProps {
  items: CueItem[];
  color: string;
  duration: number;
  height?: number;
  /** When true, the most recently-crossed cue is highlighted (the lane's Visualize switch). */
  visualize?: boolean;
  /** Cue id currently focused — drawn brighter than the others. */
  focusedItemId?: string | null;
  onCueClick?: (itemId: string, anchor: { x: number; y: number }) => void;
  /** Drag the tick to change a cue's time. */
  onCueDrag?: (itemId: string, time: number) => void;
  onCueDragStart?: (itemId: string) => void;
  /** Drag the nub at the end of a cue's tail to set how long it rings.
   *  `undefined` clears the decay (the nub was pulled back onto the tick).
   *  Absent → no nub, which is how read-only lanes stay read-only. */
  onCueDecayDrag?: (itemId: string, decay: number | undefined) => void;
  onCueDecayDragStart?: (itemId: string) => void;
  /** The nub has keyboard focus and an arrow / Delete set the decay. `repeat`
   *  is a held key's auto-repeat, which joins the undo step of its first press. */
  onCueDecayKey?: (itemId: string, decay: number | undefined, repeat: boolean) => void;
  /** Optional grid overlay for beat/bar lines under the ticks. */
  gridProps?: LaneGridProps;
  pendingSelection?: PendingSelection | null;
  /** Empty-space click → seek; empty-space drag → create a pending highlight.
   *  Wired so highlight-selection works on this lane just like the signal rows. */
  onSeek?: (time: number) => void;
  onRegion?: (t1: number, t2: number) => void;
  onRegionDragStart?: () => void;
  /** Editable lane: a click on empty space drops a cue there (see
   *  laneCreate.ts) instead of seeking. Absent on detector lanes. */
  onCreate?: (time: number) => void;
  /** Drag a cue onto another Cues lane to move it there — see
   *  useCrossLaneDrop. Absent on read-only lanes and wherever cues can't move. */
  laneDrop?: CrossLaneDropOptions;
  /** When present, this row is in detector-review mode: ticks become read-only
   *  and each one renders inline ✓/✗ controls. Keyed by cue id. */
  reviewState?: Record<string, ReviewStatus>;
  onAccept?: (itemId: string) => void;
  onReject?: (itemId: string) => void;
}

export function CueLayerRow({
  items, color, duration, height = 22,
  visualize,
  focusedItemId, onCueClick,
  onCueDrag, onCueDragStart,
  onCueDecayDrag, onCueDecayDragStart, onCueDecayKey,
  gridProps,
  pendingSelection,
  onSeek, onRegion, onRegionDragStart, onCreate,
  reviewState, onAccept, onReject,
  laneDrop,
}: CueLayerRowProps) {
  const reviewMode = !!reviewState;
  const containerRef = useRef<HTMLDivElement>(null);
  // Click vs. drag disambiguation: the tick is both clickable (open popover)
  // and draggable (reposition). We flip `didDragRef` true on the first
  // onDrag call; the click handler short-circuits if a real drag happened.
  const didDragRef = useRef(false);
  const { startDrag } = useTimelineDrag<{ id: string }>({
    containerRef,
    duration,
    onDragStart: ({ id }) => onCueDragStart?.(id),
    onDrag: ({ id }, t) => { didDragRef.current = true; onCueDrag?.(id, t); },
  });
  const dragEnabled = !!onCueDrag && !reviewMode;
  const { beginLaneDrop } = useCrossLaneDrop(laneDrop);

  // The decay nub. A drag of it only ever writes `decay` — a length, measured
  // from the tick — so the cue itself never moves. Pulled back to within a few
  // pixels of the tick it clears the decay rather than leaving a 3 ms sliver.
  const [decayLive, setDecayLive] = useState<{ id: string; decay: number | undefined; flip: boolean } | null>(null);
  const { startDrag: startDecayDrag } = useTimelineDrag<{ id: string; time: number }>({
    containerRef,
    duration,
    onDragStart: ({ id }) => onCueDecayDragStart?.(id),
    onDrag: ({ id, time }, t) => {
      const el = containerRef.current;
      const rect = el?.getBoundingClientRect();
      const width = rect?.width ?? 0;
      const snapSec = width > 0 ? (DECAY_CLEAR_PX / width) * duration : 0;
      const raw = t - time;
      const decay = raw <= snapSec ? undefined : Math.round(raw * 1000) / 1000;
      // The readout sits right of the nub unless that runs it off the lane
      // or out of the scrolled view — then it reads on the left instead.
      const nubX = rect && duration > 0 ? rect.left + (t / duration) * width : 0;
      const flip = !!el && !!rect && Math.min(rect.right, visibleRightEdge(el)) - nubX < READOUT_ROOM_PX;
      setDecayLive({ id, decay, flip });
      onCueDecayDrag?.(id, decay);
    },
    onDragEnd: () => setDecayLive(null),
  });
  const decayEnabled = !!onCueDecayDrag && !reviewMode;

  // Transient violet halo for newly-placed cues whose time landed on the beat
  // grid (i.e. snap-to-grid moved the value). The persistent SnapTick is easy
  // to miss when M is pressed, so we flash a larger ring at the moment of
  // placement to make "your click was snapped" obvious.
  const [pulseIds, setPulseIds] = useState<ReadonlySet<string>>(() => new Set());
  const prevItemTimesRef = useRef<Map<string, number> | null>(null);
  // One timer per pulsing cue. A single shared timer cleared by the effect's
  // cleanup would never be rescheduled on the re-run that cleared it (the new
  // pass sees no changed times and returns early), leaving every cue placed
  // just before it pinging forever — which is what "the cues keep flashing"
  // was. Per-id timers survive unrelated re-runs and expire on their own.
  const pulseTimersRef = useRef(new Map<string, number>());
  useEffect(() => () => {
    for (const handle of pulseTimersRef.current.values()) window.clearTimeout(handle);
    pulseTimersRef.current.clear();
  }, []);
  useEffect(() => {
    const next = new Map(items.map((it) => [it.id, it.time]));
    const prev = prevItemTimesRef.current;
    prevItemTimesRef.current = next;
    if (prev === null) return; // skip on first mount
    const changed: string[] = [];
    for (const [id, t] of next) {
      const prevT = prev.get(id);
      if (prevT !== undefined && prevT === t) continue;
      if (isOnGridLine(t, gridProps?.bpm, gridProps?.gridOffset, gridProps?.beatsPerBar)) {
        changed.push(id);
      }
    }
    if (changed.length === 0) return;
    setPulseIds((curr) => {
      const u = new Set(curr);
      for (const id of changed) u.add(id);
      return u;
    });
    for (const id of changed) {
      const running = pulseTimersRef.current.get(id);
      if (running !== undefined) window.clearTimeout(running);
      pulseTimersRef.current.set(id, window.setTimeout(() => {
        pulseTimersRef.current.delete(id);
        setPulseIds((curr) => {
          if (!curr.has(id)) return curr;
          const u = new Set(curr);
          u.delete(id);
          return u;
        });
      }, 800));
    }
  }, [items, gridProps?.bpm, gridProps?.gridOffset, gridProps?.beatsPerBar]);

  const placed = useMemo(() => {
    if (duration <= 0) return [];
    const sorted = [...items].sort((a, b) => a.time - b.time);
    const heights = sorted.map((cue) => tickHeightPct(cue.velocity));
    const stacks = stackTicks(sorted.map((cue, i) => ({ time: cue.time, heightPct: heights[i] })));
    // A lane that mixes kinds of moment (a drop, a change, a hit) names each
    // tick, or the kinds tell apart only by colour. The name gets the room up
    // to the next tick and no more, so a dense lane quietly shows none.
    const subjects = sorted.map((cue) => cueSubject(cue.label));
    const mixed = new Set(subjects.filter(Boolean)).size > 1;
    return sorted.map((cue, i) => ({
      cue,
      leftPct: (cue.time / duration) * 100,
      tag: mixed && subjects[i] ? {
        text: subjects[i],
        widthPct: (((i + 1 < sorted.length ? sorted[i + 1].time : duration) - cue.time) / duration) * 100,
      } : null,
      heightPct: heights[i],
      stack: stacks[i],
      // Who else lands on this moment, for the tooltip — a hidden hit is
      // at least named on the one covering it.
      together: stacks[i].together.length > 1
        ? stacks[i].together.map((j) => sorted[j].label || '(unlabeled)')
        : null,
    }));
  }, [items, duration]);

  return (
    <div
      ref={containerRef}
      className="flex-1 relative rounded overflow-hidden bg-gray-950"
      style={{ minHeight: height }}
      title={items.length === 0 && !onCreate ? 'No cues yet — add one from the Cues editor' : undefined}
    >
      {gridProps && (
        <BeatGridOverlay {...gridProps} duration={duration} />
      )}

      {items.length === 0 && (
        <span className="absolute inset-0 flex items-center px-2 text-[10px] text-gray-700 italic select-none pointer-events-none">
          {onCreate ? 'no cues yet — click here to add one' : 'no cues yet'}
        </span>
      )}

      {/* Behind the ticks (z="") so they keep receiving their own mousedowns;
          empty space between ticks falls through to seek / highlight-drag. */}
      {onSeek && onRegion && (
        <RegionDragOverlay duration={duration} onVizClick={onCreate ?? onSeek} onVizRegion={onRegion} onRegionDragStart={onRegionDragStart} onSelectRegion={laneDrop?.onSelectRange}
          hint={onCreate ? 'Click to add a cue · drag to highlight · ⇧-drag to select the cues inside' : undefined} z="" />
      )}

      {placed.map(({ cue, leftPct, tag, heightPct, stack, together }) => {
        const isFocused = cue.id === focusedItemId;
        const snapped = isOnGridLine(cue.time, gridProps?.bpm, gridProps?.gridOffset, gridProps?.beatsPerBar);
        const status = reviewState?.[cue.id];
        // A detector may colour one tick (a hue per drum) over the layer's.
        const ownColor = cue.color ?? color;
        const tickColor = reviewMode ? reviewBgFor(ownColor, status) : ownColor;
        const hasVelocity = typeof cue.velocity === 'number';
        const tickHeight = hasVelocity ? `${heightPct}%` : undefined;
        const togetherText = together ? `\n${together.length} hits at once: ${together.join(', ')}` : '';
        const hasHitInfo = hasVelocity || typeof cue.levelDb === 'number'
          || typeof cue.note === 'number' || typeof cue.decay === 'number';
        const head = hasHitInfo
          ? drumHitTitle({ label: cue.label || '(unlabeled)', velocity: cue.velocity, levelDb: cue.levelDb, note: cue.note, decay: cue.decay })
          : (cue.label || '(unlabeled)');
        // How long it rings, as a faint tail after the tick: a flash is a
        // tick, a swell trails off to the right.
        const decayPct = typeof cue.decay === 'number' && duration > 0
          ? Math.min(100 - leftPct, (cue.decay / duration) * 100)
          : 0;
        const titleText = reviewMode
          ? `${head} @ ${fmtTime(cue.time)}${status ? ` · ${status}` : ' · pending review'}${togetherText}${cue.description ? '\n' + cue.description : ''}`
          : `${head} @ ${fmtTime(cue.time)}${snapped ? ' · snapped to beat grid' : ''}${dragEnabled ? ' · drag to reposition · click to edit' : ''}${decayEnabled ? ' · drag the nub on its right to set how long it rings' : ''}${togetherText}${cue.description ? '\n' + cue.description : ''}`;
        // The tick is clickable in every mode: in review mode it opens the
        // read-only info card (the ✓/✗ ReviewControls handle accept/reject and
        // stop propagation, so they don't double-fire); otherwise it opens the
        // editable card. Drag is disabled in review mode, so didDragRef stays
        // false there.
        const onClickCue = (e: React.MouseEvent) => {
          e.stopPropagation();
          if (laneDrop && isSelectToggle(e)) { laneDrop.onToggleSelect(cue.id); return; }
          if (didDragRef.current) { didDragRef.current = false; return; }
          onCueClick?.(cue.id, { x: e.clientX, y: e.clientY });
        };
        const onPointerDownCue = dragEnabled
          ? (e: React.PointerEvent) => {
              didDragRef.current = false;
              // A ⇧/⌘ press is a selection click, never a drag; a group press
              // belongs to the lane hand-off alone.
              if (laneDrop && isSelectToggle(e)) { e.stopPropagation(); return; }
              if (beginLaneDrop(cue.id, e)) return;
              startDrag({ id: cue.id }, e);
            }
          : undefined;
        const pulsing = pulseIds.has(cue.id);
        const live = decayLive?.id === cue.id ? decayLive : null;
        return (
          <div key={cue.id} className="contents group/cuewrap">
            {decayPct > 0 && (
              <span
                aria-hidden="true"
                data-testid="cue-decay"
                className="absolute bottom-0 pointer-events-none"
                style={{
                  left: `${leftPct}%`,
                  width: `${decayPct}%`,
                  height: tickHeight ?? '100%',
                  background: `linear-gradient(to right, ${tickColor}66, ${tickColor}00)`,
                }}
              />
            )}
            {tag && (
              <span
                aria-hidden="true"
                data-testid="cue-tag"
                className="@container absolute top-0 pointer-events-none select-none overflow-hidden"
                // Clear of the ✓/✗ controls that sit centred on a reviewed tick.
                style={{ left: `calc(${leftPct}% + ${reviewMode ? 8 : 4}px)`, width: `calc(${tag.widthPct}% - ${reviewMode ? 10 : 6}px)` }}
              >
                <span
                  className="block truncate text-[9px] font-semibold leading-[12px] @max-[18px]:hidden"
                  style={{ color: tickColor, textShadow: '0 0 3px rgba(0,0,0,1), 0 0 6px rgba(0,0,0,0.9)' }}
                >
                  {tag.text}
                </span>
              </span>
            )}
            {pulsing && (
              <span
                className="absolute top-0 bottom-0 pointer-events-none z-20 flex items-center justify-center"
                style={{ left: `${leftPct}%`, width: 18, transform: 'translateX(-50%)' }}
                aria-hidden="true"
              >
                <span
                  className="block animate-ping rounded-sm"
                  style={{
                    width: 14, height: 14,
                    background: SNAP_INDICATOR_COLOR,
                    opacity: 0.55,
                    boxShadow: `0 0 12px ${SNAP_INDICATOR_COLOR}`,
                  }}
                />
              </span>
            )}
            <button
              data-item-id={cue.id}
              onClick={onClickCue}
              onPointerDown={onPointerDownCue}
              // Centred on its time by a -4px margin (half its width). A
              // margin, not a transform: a transform per tick is one more
              // compositor node per hit, and a drum lane has thousands.
              // The 8px-wide click target straddles the 2px-wide visible line,
              // giving generous hit area without obscuring neighbouring ticks.
              // A fingertip needs more than 8px: tc-hit widens the target on
              // coarse pointers only, and touch-none keeps a horizontal drag
              // from being taken as a page pan.
              className={`absolute top-0 bottom-0 w-2 flex ${hasVelocity ? 'items-end' : 'items-stretch'} justify-center group/cue tc-hit ${dragEnabled ? 'touch-none' : ''} ${
                reviewMode ? 'cursor-pointer' : (dragEnabled ? 'cursor-ew-resize' : 'cursor-pointer')
              }`}
              // Shorter hits sit above taller ones and equal ones fan out, so
              // a snare on the same onset as a kick is never hidden behind it.
              style={{
                left: `${leftPct}%`, marginLeft: `${stack.offsetPx - 4}px`, zIndex: stack.zIndex,
                // Selected for a cross-lane drag (⇧/⌘-click).
                outline: laneDrop?.selectedIds.has(cue.id) ? '2px solid #ffffff' : undefined,
                outlineOffset: -1,
              }}
              title={titleText}
            >
              <span
                className={`block rounded-sm transition-all group-hover/cue:w-1.5 w-[3px] ${hasVelocity ? '' : 'h-full'}`}
                style={{
                  height: tickHeight,
                  background: tickColor,
                  boxShadow: isFocused
                    ? `0 0 12px ${tickColor}, 0 0 4px ${tickColor}`
                    : `0 0 5px ${tickColor}aa, 0 0 1px ${tickColor}`,
                  opacity: 1,
                }}
              />
              {snapped && !reviewMode && <SnapTick style={{ top: 0, left: '50%', transform: 'translateX(-50%)' }} />}
            </button>
            {decayEnabled && (
              <DecayHandle
                leftPct={leftPct}
                decayPct={decayPct}
                midHeight={tickHeight ?? '100%'}
                color={tickColor}
                hasDecay={decayPct > 0}
                selected={isFocused}
                live={live}
                label={cue.label || '(unlabeled)'}
                decay={cue.decay}
                room={Math.max(0, duration - cue.time)}
                onPointerDown={(e) => startDecayDrag({ id: cue.id, time: cue.time }, e)}
                onStep={onCueDecayKey
                  ? (delta, repeat) => onCueDecayKey(cue.id, delta === null ? undefined : stepCueDecay(cue.decay, delta, duration - cue.time), repeat)
                  : undefined}
              />
            )}
            {reviewMode && (
              <ReviewControls
                status={status}
                onAccept={() => onAccept?.(cue.id)}
                onReject={() => onReject?.(cue.id)}
                size={12}
                style={{ position: 'absolute', top: -1, left: `${leftPct}%`, transform: 'translateX(-50%)', zIndex: 15 }}
              />
            )}
          </div>
        );
      })}

      {visualize && (
        <ActiveCue placed={placed} color={color} reviewMode={reviewMode} reviewState={reviewState} />
      )}

      {/* Playhead */}
      <PlayheadLine
        duration={duration}
        className="absolute top-0 bottom-0 w-px pointer-events-none z-10"
        style={{ background: 'rgba(255,255,255,0.75)' }}
      />
      {pendingSelection && (
        <PendingHighlightOverlay sel={pendingSelection} duration={duration} grid={gridProps} />
      )}
    </div>
  );
}

/**
 * Visualize: the cue the playhead crossed last, drawn lit over its tick.
 *
 * It follows the clock on its own. When the row held this as state, every
 * hit the playhead crossed re-rendered every tick in the lane — on a drum
 * lane that is thousands of buttons, several times a second, and in the dev
 * build 35–55 ms each time: the stutter while a song played.
 */
function ActiveCue({ placed, color, reviewMode, reviewState }: {
  placed: readonly { cue: CueItem; leftPct: number; heightPct: number; stack: { offsetPx: number; zIndex: number } }[];
  color: string;
  reviewMode?: boolean;
  reviewState?: Record<string, ReviewStatus>;
}) {
  // `placed` is time-sorted: the last cue at or before the playhead.
  const i = usePlayheadValue((t) => {
    let lo = 0, hi = placed.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (placed[m].cue.time <= t) lo = m + 1; else hi = m; }
    return lo - 1;
  }, usePaintClock());
  const p = i >= 0 ? placed[i] : undefined;
  if (!p) return null;
  const ownColor = p.cue.color ?? color;
  const tickColor = reviewMode ? reviewBgFor(ownColor, reviewState?.[p.cue.id]) : ownColor;
  const hasVelocity = typeof p.cue.velocity === 'number';
  return (
    <span
      aria-hidden="true"
      data-testid="cue-active"
      className={`absolute top-0 bottom-0 w-2 flex ${hasVelocity ? 'items-end' : 'items-stretch'} justify-center pointer-events-none`}
      style={{ left: `${p.leftPct}%`, marginLeft: `${p.stack.offsetPx - 4}px`, zIndex: p.stack.zIndex + 1 }}
    >
      <span
        className={`block rounded-sm w-1 ${hasVelocity ? '' : 'h-full'}`}
        style={{
          height: hasVelocity ? `${p.heightPct}%` : undefined,
          background: tickColor,
          boxShadow: `0 0 12px ${tickColor}, 0 0 4px ${tickColor}`,
        }}
      />
    </span>
  );
}

/** Pixels from the tick inside which a decay drag clears the decay. */
const DECAY_CLEAR_PX = 4;
/** Where the nub of a cue with no decay yet sits, right of the tick. */
const DECAY_NUB_GAP_PX = 7;
/** Room the "decay 1234 ms" readout needs right of the nub before it flips. */
const READOUT_ROOM_PX = 96;

/** How far right anything inside `el` can still be seen: the nearest right
 *  edge among `el` and its ancestors that clip (the lane, the zoomed
 *  timeline's scroller), and the window's. */
function visibleRightEdge(el: HTMLElement): number {
  let right = Infinity;
  for (let p: HTMLElement | null = el; p; p = p.parentElement) {
    if (getComputedStyle(p).overflowX !== 'visible') right = Math.min(right, p.getBoundingClientRect().right);
  }
  const vw = document.documentElement.clientWidth;
  return vw > 0 ? Math.min(right, vw) : right;
}

/** The grab point for a cue's decay: a small pill at the right end of its
 *  tail, or — for a cue that doesn't ring yet — a fainter one just right of
 *  the tick, so there is always a visible thing to pull. It sits under the
 *  ticks so a crowded lane still gives every tick its own click, and rises
 *  above them while its own cue is hovered or selected — or it has focus, or
 *  is being dragged — so in a cluster you select the cue, then pull its nub.
 *  Focusable: ← / → step the decay (Shift for the coarse step), Delete or
 *  Backspace clears it. */
function DecayHandle({
  leftPct, decayPct, midHeight, color, hasDecay, selected, live, label, decay, room, onPointerDown, onStep,
}: {
  leftPct: number;
  decayPct: number;
  /** Height of the tick/tail; the pill sits halfway up it. */
  midHeight: string;
  color: string;
  hasDecay: boolean;
  /** Its cue is the focused one (card open / picked in the list). */
  selected: boolean;
  live: { decay: number | undefined; flip: boolean } | null;
  label: string;
  decay: number | undefined;
  /** Seconds from the cue to the end of the song — the longest it can ring. */
  room: number;
  onPointerDown: (e: React.PointerEvent) => void;
  /** A keyboard step: seconds to add, or null to clear. */
  onStep?: (delta: number | null, repeat: boolean) => void;
}) {
  // Where the keyboard readout goes, measured when the nub takes focus or a
  // key moves it — the drag measures its own.
  const [keyFlip, setKeyFlip] = useState(false);
  const measure = (el: HTMLElement) => setKeyFlip(visibleRightEdge(el) - el.getBoundingClientRect().right < READOUT_ROOM_PX);
  const flip = live ? live.flip : keyFlip;
  const readout = live ? decayReadout(live.decay) : decayReadout(decay);
  const onKeyDown = onStep ? (e: React.KeyboardEvent<HTMLElement>) => {
    let delta: number | null | undefined;
    if (e.key === 'ArrowRight') delta = e.shiftKey ? DECAY_STEP_COARSE_SEC : DECAY_STEP_FINE_SEC;
    else if (e.key === 'ArrowLeft') delta = -(e.shiftKey ? DECAY_STEP_COARSE_SEC : DECAY_STEP_FINE_SEC);
    else if (e.key === 'Delete' || e.key === 'Backspace') delta = null;
    if (delta === undefined || e.altKey || e.ctrlKey || e.metaKey) return;
    // Ours, not the page's: an arrow here must not seek, nor Delete remove the cue.
    e.preventDefault();
    e.stopPropagation();
    onStep(delta, e.repeat);
    measure(e.currentTarget);
  } : undefined;
  const z = live ? 'z-30' : selected ? 'z-20' : 'z-0 group-hover/cuewrap:z-20 has-[:focus-visible]:z-30';
  // A track from the tick to the end of the tail, with the pill on its right
  // end. Its min-width keeps the pill clear of its own tick: a short decay
  // would otherwise park the pill on the tick, and hovering the tick (which
  // raises the pill) would leave the tick itself nowhere to be clicked.
  return (
    <span
      data-testid="cue-decay-track"
      className={`absolute top-0 bottom-0 pointer-events-none ${z}`}
      style={{ left: `${leftPct}%`, width: `${hasDecay ? decayPct : 0}%`, minWidth: DECAY_NUB_GAP_PX }}
    >
      <span
        role="slider"
        tabIndex={0}
        data-testid="cue-decay-handle"
        aria-label={`Decay of ${label}`}
        aria-valuemin={0}
        aria-valuemax={Math.round(room * 1000)}
        aria-valuenow={decay === undefined ? 0 : Math.round(decay * 1000)}
        aria-valuetext={decayReadout(decay)}
        title="Drag to set how long it rings (decay) · drag back onto the tick to clear it · focused: ← / → adjust, Delete clears"
        onPointerDown={onPointerDown}
        // The press is a drag, never a click: the tick's card stays shut.
        onClick={(e) => e.stopPropagation()}
        onFocus={(e) => measure(e.currentTarget)}
        onKeyDown={onKeyDown}
        className="absolute top-0 bottom-0 right-0 w-2 translate-x-1/2 pointer-events-auto cursor-ew-resize touch-none tc-hit group/decay focus:outline-none"
      >
        <span
          aria-hidden="true"
          className={`absolute left-1/2 w-[3px] h-2.5 rounded-full transition-opacity group-hover/decay:opacity-100 group-focus-visible/decay:opacity-100 group-focus-visible/decay:ring-1 group-focus-visible/decay:ring-white ${
            live || selected ? 'opacity-100' : hasDecay ? 'opacity-80 group-hover/cuewrap:opacity-100' : 'opacity-35 group-hover/cuewrap:opacity-80'
          }`}
          style={{
            bottom: `calc(${midHeight} / 2)`,
            transform: 'translate(-50%, 50%)',
            background: hasDecay ? color : 'transparent',
            border: `1px solid ${color}`,
            boxShadow: live ? `0 0 6px ${color}` : undefined,
          }}
        />
        <span
          data-testid={live ? 'cue-decay-readout' : undefined}
          data-side={flip ? 'left' : 'right'}
          className={`absolute top-0 whitespace-nowrap rounded bg-black/80 px-1 text-[9px] leading-[12px] text-slate-100 pointer-events-none ${
            flip ? 'right-2' : 'left-2'
          } ${live ? '' : 'hidden group-focus-visible/decay:block'}`}
        >
          {readout}
        </span>
      </span>
    </span>
  );
}
