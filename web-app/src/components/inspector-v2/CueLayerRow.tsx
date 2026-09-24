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
import { PendingHighlightOverlay, RegionDragOverlay, type PendingSelection } from './AnnotationOverlays';
import { ReviewControls, reviewBgFor, type ReviewStatus } from './ReviewControls';
import { drumHitTitle } from '../../utils/drumHits';

interface CueLayerRowProps {
  items: CueItem[];
  color: string;
  duration: number;
  currentTime: number;
  height?: number;
  /** When true, the most recently-crossed cue is highlighted (karaoke mode). */
  karaokeActive?: boolean;
  /** Cue id currently focused — drawn brighter than the others. */
  focusedItemId?: string | null;
  onCueClick?: (itemId: string, anchor: { x: number; y: number }) => void;
  /** Drag the tick to change a cue's time. */
  onCueDrag?: (itemId: string, time: number) => void;
  onCueDragStart?: (itemId: string) => void;
  /** Optional grid overlay for beat/bar lines under the ticks. */
  gridProps?: LaneGridProps;
  pendingSelection?: PendingSelection | null;
  /** Empty-space click → seek; empty-space drag → create a pending highlight.
   *  Wired so highlight-selection works on this lane just like the signal rows. */
  onSeek?: (time: number) => void;
  onRegion?: (t1: number, t2: number) => void;
  onRegionDragStart?: () => void;
  /** When present, this row is in detector-review mode: ticks become read-only
   *  and each one renders inline ✓/✗ controls. Keyed by cue id. */
  reviewState?: Record<string, ReviewStatus>;
  onAccept?: (itemId: string) => void;
  onReject?: (itemId: string) => void;
}

export function CueLayerRow({
  items, color, duration, currentTime, height = 22,
  karaokeActive,
  focusedItemId, onCueClick,
  onCueDrag, onCueDragStart,
  gridProps,
  pendingSelection,
  onSeek, onRegion, onRegionDragStart,
  reviewState, onAccept, onReject,
}: CueLayerRowProps) {
  const reviewMode = !!reviewState;
  const containerRef = useRef<HTMLDivElement>(null);
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
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
    return sorted.map((cue) => ({
      cue,
      leftPct: (cue.time / duration) * 100,
    }));
  }, [items, duration]);

  // Karaoke: the last cue whose time ≤ currentTime (most recently crossed).
  const activeId = useMemo(() => {
    if (!karaokeActive) return null;
    let id: string | null = null;
    for (const { cue } of placed) {
      if (cue.time <= currentTime) id = cue.id;
      else break;
    }
    return id;
  }, [karaokeActive, placed, currentTime]);

  return (
    <div
      ref={containerRef}
      className="flex-1 relative rounded overflow-hidden bg-gray-950"
      style={{ height }}
      title={items.length === 0 ? 'No cues yet — add one from the Cues editor' : undefined}
    >
      {gridProps && (
        <BeatGridOverlay {...gridProps} duration={duration} />
      )}

      {items.length === 0 && (
        <span className="absolute inset-0 flex items-center px-2 text-[10px] text-gray-700 italic select-none pointer-events-none">
          no cues yet
        </span>
      )}

      {/* Behind the ticks (z="") so they keep receiving their own mousedowns;
          empty space between ticks falls through to seek / highlight-drag. */}
      {onSeek && onRegion && (
        <RegionDragOverlay duration={duration} onVizClick={onSeek} onVizRegion={onRegion} onRegionDragStart={onRegionDragStart} z="" />
      )}

      {placed.map(({ cue, leftPct }) => {
        const isFocused = cue.id === focusedItemId;
        const isActive = cue.id === activeId;
        const snapped = isOnGridLine(cue.time, gridProps?.bpm, gridProps?.gridOffset, gridProps?.beatsPerBar);
        const status = reviewState?.[cue.id];
        // A detector may colour one tick (a hue per drum) over the layer's.
        const ownColor = cue.color ?? color;
        const tickColor = reviewMode ? reviewBgFor(ownColor, status) : ownColor;
        // A struck hit stands as tall as it was struck: velocity 127 fills the
        // lane, a ghost note is a stub at the bottom. The 20% floor keeps the
        // softest hit visible and clickable. Same rule as the algo rows.
        const hasVelocity = typeof cue.velocity === 'number';
        const tickHeight = hasVelocity ? `${Math.max(20, (cue.velocity! / 127) * 100)}%` : undefined;
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
          ? `${head} @ ${fmtTime(cue.time)}${status ? ` · ${status}` : ' · pending review'}${cue.description ? '\n' + cue.description : ''}`
          : `${head} @ ${fmtTime(cue.time)}${snapped ? ' · snapped to beat grid' : ''}${dragEnabled ? ' · drag to reposition · click to edit' : ''}${cue.description ? '\n' + cue.description : ''}`;
        // The tick is clickable in every mode: in review mode it opens the
        // read-only info card (the ✓/✗ ReviewControls handle accept/reject and
        // stop propagation, so they don't double-fire); otherwise it opens the
        // editable card. Drag is disabled in review mode, so didDragRef stays
        // false there.
        const onClickCue = (e: React.MouseEvent) => {
          e.stopPropagation();
          if (didDragRef.current) { didDragRef.current = false; return; }
          onCueClick?.(cue.id, { x: e.clientX, y: e.clientY });
        };
        const onPointerDownCue = dragEnabled
          ? (e: React.PointerEvent) => { didDragRef.current = false; startDrag({ id: cue.id }, e); }
          : undefined;
        const pulsing = pulseIds.has(cue.id);
        return (
          <div key={cue.id} className="contents">
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
              onClick={onClickCue}
              onPointerDown={onPointerDownCue}
              // Translate by -50% so the tick is visually centred on its time.
              // The 8px-wide click target straddles the 2px-wide visible line,
              // giving generous hit area without obscuring neighbouring ticks.
              // A fingertip needs more than 8px: tc-hit widens the target on
              // coarse pointers only, and touch-none keeps a horizontal drag
              // from being taken as a page pan.
              className={`absolute top-0 bottom-0 w-2 flex ${hasVelocity ? 'items-end' : 'items-stretch'} justify-center group/cue tc-hit ${dragEnabled ? 'touch-none' : ''} ${
                reviewMode ? 'cursor-pointer' : (dragEnabled ? 'cursor-ew-resize' : 'cursor-pointer')
              }`}
              style={{ left: `${leftPct}%`, transform: 'translateX(-50%)' }}
              title={titleText}
            >
              <span
                className={`block rounded-sm transition-all group-hover/cue:w-1.5 ${hasVelocity ? '' : 'h-full'} ${isActive ? 'w-1' : 'w-[3px]'}`}
                style={{
                  height: tickHeight,
                  background: tickColor,
                  boxShadow: (isFocused || isActive)
                    ? `0 0 12px ${tickColor}, 0 0 4px ${tickColor}`
                    : `0 0 5px ${tickColor}aa, 0 0 1px ${tickColor}`,
                  opacity: 1,
                }}
              />
              {snapped && !reviewMode && <SnapTick style={{ top: 0, left: '50%', transform: 'translateX(-50%)' }} />}
            </button>
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

      {/* Playhead */}
      <div
        className="absolute top-0 bottom-0 w-px pointer-events-none z-10"
        style={{ left: `${pct}%`, background: 'rgba(255,255,255,0.75)' }}
      />
      {pendingSelection && (
        <PendingHighlightOverlay sel={pendingSelection} duration={duration} grid={gridProps} />
      )}
    </div>
  );
}
