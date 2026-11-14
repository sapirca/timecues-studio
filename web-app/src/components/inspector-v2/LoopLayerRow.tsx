/**
 * LoopLayerRow — interval bands on the canvas for a Loop layer.
 *
 * Each LoopItem renders as a filled rectangle from `start` to `end` (in song
 * time), painted in the layer's color. Loops in the same layer may NOT
 * overlap (the editor enforces this), so the bands tile cleanly.
 *
 * Clicking a band opens the edit popover (same pattern as Cues + Manual).
 */

import { useMemo, useRef } from 'react';
import { prominenceSummary, type LoopItem, type ProminenceEnvelope } from '../../types/annotationLayer';
import { ProminenceFill, ProminenceStrip, prominenceBandBackground, PROMINENCE_EDIT_TOTAL_H } from './shared/ProminenceLane';
import { formatClockTime as fmtTime } from '../../utils/clockTime';
import { BeatGridOverlay, type LaneGridProps } from './BeatGridOverlay';
import { isOnGridLine } from '../../utils/snapIndication';
import { SnapTick } from './SnapIndicator';
import { useTimelineDrag, createEdgeItemClamp, useBodyMoveDrag } from '../../hooks/useTimelineDrag';
import { isSelectToggle, useCrossLaneDrop, type CrossLaneDropOptions } from '../../hooks/useCrossLaneDrop';
import { PendingHighlightOverlay, RegionDragOverlay, type PendingSelection } from './AnnotationOverlays';
import { ReviewControls, reviewBgFor, type ReviewStatus } from './ReviewControls';
import { MIN_BAND_PX, withBandStart } from './shared/bandGeometry';
import { BandEdgeHandle } from './shared/BandEdgeHandle';
import { usePlayheadValue } from '../../hooks/usePlayhead';
import { PlayheadLine } from '../Playhead';

interface LoopLayerRowProps {
  items: LoopItem[];
  color: string;
  duration: number;
  height?: number;
  /** When true, the loop under the playhead is highlighted (the lane's Visualize switch). */
  visualize?: boolean;
  focusedItemId?: string | null;
  /** Item whose edit popover is currently OPEN — gates the prominence editor.
   *  Distinct from `focusedItemId`, which lingers after the popover closes. */
  prominenceEditItemId?: string | null;
  /** Prominence (front/back) edits from the band's breakpoint editor. */
  onProminenceChange?: (itemId: string, points: ProminenceEnvelope | undefined) => void;
  /** Snap a prominence breakpoint onto the beat grid as it's dragged or
   *  placed. The page's own snap, so Snap to grid / Grid Lock govern it the
   *  same way they govern moving the band itself. */
  snapProminenceTime?: (trackSeconds: number) => number;
  /** Highlight the loop currently playing (different visual from focus). */
  playingItemId?: string | null;
  onLoopClick?: (itemId: string, anchor: { x: number; y: number }) => void;
  /** Edge-drag callback. Receives the item id, which edge (start | end) the
   *  user grabbed, and the new time. Parent should clamp + snap as needed. */
  onLoopEdgeDrag?: (itemId: string, edge: 'start' | 'end', time: number) => void;
  /** Fired once at the start of a drag — parents use this to snapshot for undo. */
  onLoopEdgeDragStart?: (itemId: string, edge: 'start' | 'end') => void;
  /** Body-drag callback. Move the whole loop without changing its width —
   *  start and end shift by the same delta. */
  onLoopMove?: (itemId: string, newStart: number, newEnd: number) => void;
  onLoopMoveStart?: (itemId: string) => void;
  gridProps?: LaneGridProps;
  pendingSelection?: PendingSelection | null;
  /** Empty-space click → seek; empty-space drag → create a pending highlight. */
  onSeek?: (time: number) => void;
  onRegion?: (t1: number, t2: number) => void;
  onRegionDragStart?: () => void;
  /** Editable lane: a drag over empty space makes a loop over the dragged
   *  stretch, in this lane (see laneCreate.ts), instead of the teal
   *  highlight. Absent on detector lanes. */
  onCreate?: (t1: number, t2: number) => void;
  /** The snap `onCreate` applies, so the drag preview lands where the item will. */
  createSnap?: (t: number) => number;
  /** Drag an item onto another lane of the same type to move it there — see
   *  useCrossLaneDrop. Absent on read-only lanes and wherever items can't move. */
  laneDrop?: CrossLaneDropOptions;
  /** Detector-review mode. When set, loops become read-only and render inline ✓/✗. */
  reviewState?: Record<string, ReviewStatus>;
  onAccept?: (itemId: string) => void;
  onReject?: (itemId: string) => void;
}

export function LoopLayerRow({
  items, color, duration, height = 22,
  visualize,
  focusedItemId, prominenceEditItemId, onProminenceChange, snapProminenceTime, playingItemId, onLoopClick,
  onLoopEdgeDrag, onLoopEdgeDragStart,
  onLoopMove, onLoopMoveStart,
  gridProps,
  pendingSelection,
  onSeek, onRegion, onRegionDragStart, onCreate, createSnap,
  reviewState, onAccept, onReject,
  laneDrop,
}: LoopLayerRowProps) {
  const reviewMode = !!reviewState;
  const containerRef = useRef<HTMLDivElement>(null);

  // Visualize: the loop whose [start, end) contains the playhead. Derived from
  // the clock, so the row re-renders only when that loop changes.
  const activeId = usePlayheadValue((t) => {
    if (!visualize) return null;
    return items.find((l) => l.start <= t && t < l.end)?.id ?? null;
  });

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const durationRef = useRef(duration);
  durationRef.current = duration;

  const { startDrag } = useTimelineDrag<{ id: string; edge: 'start' | 'end' }>({
    containerRef,
    duration,
    onDragStart: ({ id, edge }) => onLoopEdgeDragStart?.(id, edge),
    onDrag: ({ id, edge }, t) => onLoopEdgeDrag?.(id, edge, t),
    clamp: createEdgeItemClamp(itemsRef, duration),
  });
  const dragEnabled = !!onLoopEdgeDrag && !reviewMode;

  const { startBodyMove, wasDraggedRef } = useBodyMoveDrag({
    containerRef,
    durationGetter: () => durationRef.current,
    onMoveStart: (id) => onLoopMoveStart?.(id),
    onMove: (id, ns, ne) => onLoopMove?.(id, ns, ne),
  });
  const { beginLaneDrop } = useCrossLaneDrop(laneDrop);
  const moveEnabled = !!onLoopMove && !reviewMode;

  // The prominence editor only claims vertical space while a popover is open.
  const prominenceTarget = useMemo(
    () => (onProminenceChange && !reviewMode && prominenceEditItemId
      ? items.find((it) => it.id === prominenceEditItemId) ?? null
      : null),
    [onProminenceChange, reviewMode, prominenceEditItemId, items],
  );

  return (
    <div
      ref={containerRef}
      className="flex-1 relative rounded overflow-hidden bg-gray-950"
      style={{ minHeight: height + (prominenceTarget ? PROMINENCE_EDIT_TOTAL_H + 2 : 0) }}
      title={items.length === 0 && !onCreate ? 'No loops yet — add one from the Loops editor' : undefined}
    >
      {gridProps && (
        <BeatGridOverlay {...gridProps} duration={duration} />
      )}

      {items.length === 0 && (
        <span className="absolute inset-0 flex items-center px-2 text-[10px] text-gray-700 italic select-none pointer-events-none">
          {onCreate ? 'no loops yet — drag here to add one' : 'no loops yet'}
        </span>
      )}

      {/* Behind the bands (z="") — empty space falls through to seek / highlight-drag. */}
      {onSeek && onRegion && (
        <RegionDragOverlay duration={duration} onVizClick={onSeek} onVizRegion={onCreate ?? onRegion} onRegionDragStart={onCreate ? undefined : onRegionDragStart} onSelectRegion={laneDrop?.onSelectRange}
          createColor={onCreate ? color : undefined} snapTime={onCreate ? createSnap : undefined} hint={onCreate ? 'Drag to add a loop · click to move the playhead · ⇧-drag to select the loops inside' : undefined} z="" />
      )}

      {items.map((loop) => {
        const left  = duration > 0 ? (loop.start / duration) * 100 : 0;
        const width = duration > 0 ? ((loop.end - loop.start) / duration) * 100 : 0;
        const isFocused = loop.id === focusedItemId;
        const isPlaying = loop.id === playingItemId;
        const isActive = loop.id === activeId;
        const status = reviewState?.[loop.id];
        // A loop can carry its own colour (set in its card) over the layer's.
        const ownColor = loop.color ?? color;
        const bandColor = reviewMode ? reviewBgFor(ownColor, status) : ownColor;
        const boxShadow = isPlaying
          ? `inset 0 0 0 2px ${bandColor}, 0 0 12px ${bandColor}aa`
          : isActive
            ? `inset 0 0 0 2px ${bandColor}cc, 0 0 10px ${bandColor}88`
            : isFocused
              ? `inset 0 0 0 1px ${bandColor}, 0 0 6px ${bandColor}66`
              : undefined;
        const startSnapped = isOnGridLine(loop.start, gridProps?.bpm, gridProps?.gridOffset, gridProps?.beatsPerBar);
        const endSnapped   = isOnGridLine(loop.end,   gridProps?.bpm, gridProps?.gridOffset, gridProps?.beatsPerBar);
        return (
          <div key={loop.id} className="contents">
            <button
              data-item-id={loop.id}
              onPointerDown={(e) => {
                if (!moveEnabled) return;
                // A ⇧/⌘ press is a selection click, never a drag.
                if (laneDrop && isSelectToggle(e)) return;
                if (beginLaneDrop(loop.id, e)) return;
                startBodyMove(loop.id, loop.start, loop.end, e);
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (laneDrop && isSelectToggle(e)) { laneDrop.onToggleSelect(loop.id); return; }
                if (wasDraggedRef.current) {
                  wasDraggedRef.current = false;
                  return;
                }
                // Opens the info card in every mode — read-only for detector
                // layers (review mode); ✓/✗ controls stop propagation.
                onLoopClick?.(loop.id, { x: e.clientX, y: e.clientY });
              }}
              // touch-pan-y: a vertical swipe over a band still scrolls the
              // page on a phone; a horizontal one moves the band.
              className={`absolute top-0 bottom-0 flex items-stretch overflow-hidden ${moveEnabled ? 'touch-pan-y' : ''} ${
                reviewMode ? 'cursor-pointer' : (moveEnabled ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer')
              }`}
              style={{
                left: `${left}%`,
                width: `${width}%`,
                minWidth: MIN_BAND_PX,
                background: status ? `${bandColor}ee`
                  : loop.prominence ? prominenceBandBackground(bandColor, isActive || isPlaying)
                  : isPlaying ? `${bandColor}99` : isActive ? `${bandColor}77` : `${bandColor}55`,
                // Under the prominence editor the band keeps its own height;
                // otherwise top-0/bottom-0 stretch it to whatever the row is.
                height: prominenceTarget ? height : undefined,
                boxShadow: withBandStart(bandColor, boxShadow),
                // Selected for a cross-lane drag (⇧/⌘-click).
                outline: laneDrop?.selectedIds.has(loop.id) ? '2px solid #ffffff' : undefined,
                outlineOffset: -2,
                opacity: 1,
              }}
              title={reviewMode
                ? `${loop.label || '(unlabeled)'} · ${fmtTime(loop.start)}–${fmtTime(loop.end)}${status ? ` · ${status}` : ' · pending review'}${loop.description ? '\n' + loop.description : ''}`
                : `${loop.label || '(unlabeled)'} · ${fmtTime(loop.start)}–${fmtTime(loop.end)}${startSnapped && endSnapped ? ' · both ends snapped' : startSnapped ? ' · start snapped' : endSnapped ? ' · end snapped' : ''}${prominenceSummary(loop.prominence) ? ` · ${prominenceSummary(loop.prominence)}` : ''}${loop.description ? '\n' + loop.description : ''}`}
            >
              <ProminenceFill points={loop.prominence} itemDuration={loop.end - loop.start} color={bandColor} />
              {startSnapped && !reviewMode && <SnapTick style={{ top: 0, left: 0 }} title="Loop start is on the beat grid" />}
              {endSnapped   && !reviewMode && <SnapTick style={{ top: 0, right: 0 }} title="Loop end is on the beat grid" />}
              <span
                className="text-[10px] truncate text-white/90 pointer-events-none select-none leading-none px-0.5 pt-0.5"
                style={{ textShadow: '0 0 4px rgba(0,0,0,0.9)' }}
              >
                {isPlaying ? '▶ ' : ''}{loop.label || `${(loop.end - loop.start).toFixed(1)}s`}
              </span>
              {dragEnabled && (
                <>
                  <BandEdgeHandle
                    edge="start" widthClass="w-2" label="Drag to move loop start"
                    onPointerDown={(e) => startDrag({ id: loop.id, edge: 'start' }, e)}
                  />
                  <BandEdgeHandle
                    edge="end" widthClass="w-2" label="Drag to move loop end"
                    onPointerDown={(e) => startDrag({ id: loop.id, edge: 'end' }, e)}
                  />
                </>
              )}
            </button>
            {reviewMode && (
              <ReviewControls
                status={status}
                onAccept={() => onAccept?.(loop.id)}
                onReject={() => onReject?.(loop.id)}
                size={12}
                style={{ position: 'absolute', top: -1, left: `${left + width / 2}%`, transform: 'translateX(-50%)', zIndex: 15 }}
              />
            )}
          </div>
        );
      })}

      {prominenceTarget && onProminenceChange && (
        <ProminenceStrip
          points={prominenceTarget.prominence}
          start={prominenceTarget.start}
          end={prominenceTarget.end}
          duration={duration}
          containerRef={containerRef}
          color={color}
          top={height}
          snapTime={snapProminenceTime}
          onChange={(next) => onProminenceChange(prominenceTarget.id, next)}
          onDragStart={() => onLoopMoveStart?.(prominenceTarget.id)}
        />
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
