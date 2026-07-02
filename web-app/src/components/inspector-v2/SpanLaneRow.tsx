/**
 * SpanLaneRow — overlapping interval bands for a Span layer.
 *
 * Unlike LoopLayerRow, Spans MAY overlap, so we run greedy lane assignment:
 * sort by start, place each span in the lowest lane that doesn't conflict.
 * The row grows taller with more overlap (N lanes × LANE_HEIGHT_PX).
 *
 * Clicking a band fires onSpanClick(itemId, anchor) so the parent can open
 * the inline edit popover (same pattern as Cues + Loops).
 */

import { useMemo, useRef } from 'react';
import type { SpanItem } from '../../types/annotationLayer';
import { BeatGridOverlay } from './BeatGridOverlay';
import { isOnGridLine } from '../../utils/snapIndication';
import { SnapTick } from './SnapIndicator';
import { useTimelineDrag, createEdgeItemClamp, useBodyMoveDrag } from '../../hooks/useTimelineDrag';
import { PendingHighlightOverlay, RegionDragOverlay, type PendingSelection } from './AnnotationOverlays';
import { ReviewControls, reviewBgFor, type ReviewStatus } from './ReviewControls';

const LANE_HEIGHT_PX = 12;
const LANE_GAP_PX = 1;

interface SpanLaneRowProps {
  items: SpanItem[];
  color: string;
  duration: number;
  currentTime: number;
  focusedItemId?: string | null;
  onSpanClick?: (itemId: string, anchor: { x: number; y: number }) => void;
  /** Edge-drag callback. Same contract as LoopLayerRow: id, which edge, new time. */
  onSpanEdgeDrag?: (itemId: string, edge: 'start' | 'end', time: number) => void;
  onSpanEdgeDragStart?: (itemId: string, edge: 'start' | 'end') => void;
  /** Body-drag callback. Fires while the user drags the middle of a band to
   *  reposition the span without changing its width (start and end shift by
   *  the same delta). */
  onSpanMove?: (itemId: string, newStart: number, newEnd: number) => void;
  onSpanMoveStart?: (itemId: string) => void;
  gridProps?: { bpm?: number; gridOffset?: number; beatsPerBar?: number; barGroupSize?: number | null; anchors?: readonly import('../../types/songInfo').TempoAnchor[]; beatOverrides?: Readonly<Record<string, number>>; thickness?: number };
  pendingSelection?: PendingSelection | null;
  /** Empty-space click → seek; empty-space drag → create a pending highlight. */
  onSeek?: (time: number) => void;
  onRegion?: (t1: number, t2: number) => void;
  onRegionDragStart?: () => void;
  /** Detector-review mode. When set, spans become read-only and render inline ✓/✗. */
  reviewState?: Record<string, ReviewStatus>;
  onAccept?: (itemId: string) => void;
  onReject?: (itemId: string) => void;
}

interface PlacedSpan {
  item: SpanItem;
  lane: number;
}

function assignLanes(items: SpanItem[]): { placed: PlacedSpan[]; laneCount: number } {
  const sorted = items.slice().sort((a, b) => a.start - b.start);
  const laneEnds: number[] = []; // running end-time of the last span in each lane
  const placed: PlacedSpan[] = [];
  for (const item of sorted) {
    let lane = laneEnds.findIndex((end) => end <= item.start);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(item.end); }
    else laneEnds[lane] = item.end;
    placed.push({ item, lane });
  }
  return { placed, laneCount: Math.max(1, laneEnds.length) };
}

export function SpanLaneRow({
  items, color, duration, currentTime,
  focusedItemId, onSpanClick,
  onSpanEdgeDrag, onSpanEdgeDragStart,
  onSpanMove, onSpanMoveStart,
  gridProps,
  pendingSelection,
  onSeek, onRegion, onRegionDragStart,
  reviewState, onAccept, onReject,
}: SpanLaneRowProps) {
  const reviewMode = !!reviewState;
  const containerRef = useRef<HTMLDivElement>(null);
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const { placed, laneCount } = useMemo(() => assignLanes(items), [items]);
  const height = Math.max(22, laneCount * LANE_HEIGHT_PX + (laneCount - 1) * LANE_GAP_PX + 4);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const durationRef = useRef(duration);
  durationRef.current = duration;

  const { startDrag } = useTimelineDrag<{ id: string; edge: 'start' | 'end' }>({
    containerRef,
    duration,
    onDragStart: ({ id, edge }) => onSpanEdgeDragStart?.(id, edge),
    onDrag: ({ id, edge }, t) => onSpanEdgeDrag?.(id, edge, t),
    clamp: createEdgeItemClamp(itemsRef, duration),
  });
  const dragEnabled = !!onSpanEdgeDrag && !reviewMode;

  // Body-drag (move whole span). Click vs drag is disambiguated by a 3 px
  // movement threshold inside the helper — taps still open the popover.
  const { startBodyMove, wasDraggedRef } = useBodyMoveDrag({
    containerRef,
    durationGetter: () => durationRef.current,
    onMoveStart: (id) => onSpanMoveStart?.(id),
    onMove: (id, ns, ne) => onSpanMove?.(id, ns, ne),
  });
  const moveEnabled = !!onSpanMove && !reviewMode;

  return (
    <div
      ref={containerRef}
      className="flex-1 relative rounded overflow-hidden bg-gray-950"
      style={{ height }}
      title={items.length === 0 ? 'No spans yet — add one from the Spans editor' : undefined}
    >
      {gridProps && (
        <BeatGridOverlay
          bpm={gridProps.bpm}
          gridOffset={gridProps.gridOffset}
          beatsPerBar={gridProps.beatsPerBar}
          barGroupSize={gridProps.barGroupSize}
          anchors={gridProps.anchors}
          beatOverrides={gridProps.beatOverrides}
          thickness={gridProps.thickness}
          duration={duration}
        />
      )}

      {items.length === 0 && (
        <span className="absolute inset-0 flex items-center px-2 text-[10px] text-gray-700 italic select-none pointer-events-none">
          no spans yet
        </span>
      )}

      {/* Behind the bands (z="") — bands keep their own mousedowns; empty space
          falls through to seek / highlight-drag. */}
      {onSeek && onRegion && (
        <RegionDragOverlay duration={duration} onVizClick={onSeek} onVizRegion={onRegion} onRegionDragStart={onRegionDragStart} z="" />
      )}

      {placed.map(({ item, lane }) => {
        const left  = duration > 0 ? (item.start / duration) * 100 : 0;
        const width = Math.max(0.5, duration > 0 ? ((item.end - item.start) / duration) * 100 : 0);
        const isFocused = item.id === focusedItemId;
        const top = 2 + lane * (LANE_HEIGHT_PX + LANE_GAP_PX);
        const startSnapped = isOnGridLine(item.start, gridProps?.bpm, gridProps?.gridOffset, gridProps?.beatsPerBar);
        const endSnapped   = isOnGridLine(item.end,   gridProps?.bpm, gridProps?.gridOffset, gridProps?.beatsPerBar);
        const status = reviewState?.[item.id];
        const bandColor = reviewMode ? reviewBgFor(color, status) : color;
        return (
          <div key={item.id} className="contents">
            <button
              onMouseDown={(e) => {
                if (!moveEnabled) return;
                startBodyMove(item.id, item.start, item.end, e);
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (wasDraggedRef.current) {
                  wasDraggedRef.current = false;
                  return;
                }
                // Opens the info card in every mode — read-only for detector
                // layers (review mode); ✓/✗ controls stop propagation.
                onSpanClick?.(item.id, { x: e.clientX, y: e.clientY });
              }}
              className={`absolute flex items-stretch overflow-hidden rounded-sm ${
                reviewMode ? 'cursor-pointer' : (moveEnabled ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer')
              }`}
              style={{
                left: `${left}%`,
                width: `${width}%`,
                top,
                height: LANE_HEIGHT_PX,
                background: `${bandColor}55`,
                boxShadow: isFocused ? `inset 0 0 0 1px ${bandColor}, 0 0 6px ${bandColor}66` : undefined,
                borderRight: '1px solid rgba(0,0,0,0.4)',
                opacity: status === 'rejected' ? 0.4 : 1,
              }}
              title={reviewMode
                ? `${item.label || '(unlabeled)'} · ${fmtTime(item.start)}–${fmtTime(item.end)}${status ? ` · ${status}` : ' · pending review'}${item.description ? '\n' + item.description : ''}`
                : `${item.label || '(unlabeled)'} · ${fmtTime(item.start)}–${fmtTime(item.end)}${startSnapped && endSnapped ? ' · both ends snapped' : startSnapped ? ' · start snapped' : endSnapped ? ' · end snapped' : ''}${item.description ? '\n' + item.description : ''}`}
            >
              {startSnapped && !reviewMode && <SnapTick style={{ top: 0, left: 0 }} title="Span start is on the beat grid" />}
              {endSnapped   && !reviewMode && <SnapTick style={{ top: 0, right: 0 }} title="Span end is on the beat grid" />}
              <span
                className="text-[8px] truncate text-white/90 pointer-events-none select-none leading-none px-1 self-center"
                style={{ textShadow: '0 0 4px rgba(0,0,0,0.9)' }}
              >
                {item.label || `${(item.end - item.start).toFixed(1)}s`}
              </span>
              {dragEnabled && (
                <>
                  <span
                    role="separator"
                    aria-label="Drag to move span start"
                    className="absolute top-0 bottom-0 left-0 w-1.5 z-20 cursor-ew-resize"
                    style={{ background: 'rgba(255,255,255,0.18)' }}
                    onMouseDown={(e) => startDrag({ id: item.id, edge: 'start' }, e)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span
                    role="separator"
                    aria-label="Drag to move span end"
                    className="absolute top-0 bottom-0 right-0 w-1.5 z-20 cursor-ew-resize"
                    style={{ background: 'rgba(255,255,255,0.18)' }}
                    onMouseDown={(e) => startDrag({ id: item.id, edge: 'end' }, e)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </>
              )}
            </button>
            {reviewMode && (
              <ReviewControls
                status={status}
                onAccept={() => onAccept?.(item.id)}
                onReject={() => onReject?.(item.id)}
                size={11}
                style={{ position: 'absolute', top: Math.max(0, top - 1), left: `${left + width / 2}%`, transform: 'translateX(-50%)', zIndex: 15 }}
              />
            )}
          </div>
        );
      })}

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

function fmtTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '0:00.0';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
