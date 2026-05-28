/**
 * LoopLayerRow — interval bands on the canvas for a Loop layer.
 *
 * Each LoopItem renders as a filled rectangle from `start` to `end` (in song
 * time), painted in the layer's color. Loops in the same layer may NOT
 * overlap (the editor enforces this), so the bands tile cleanly.
 *
 * Clicking a band opens the edit popover (same pattern as Cues + Manual).
 */

import { useRef } from 'react';
import type { LoopItem } from '../../types/annotationLayer';
import { BeatGridOverlay } from './BeatGridOverlay';
import { isOnGridLine } from '../../utils/snapIndication';
import { SnapTick } from './SnapIndicator';
import { useTimelineDrag, createEdgeItemClamp, useBodyMoveDrag } from '../../hooks/useTimelineDrag';
import { PendingHighlightOverlay, type PendingSelection } from './AnnotationOverlays';
import { ReviewControls, reviewBgFor, type ReviewStatus } from './ReviewControls';

interface LoopLayerRowProps {
  items: LoopItem[];
  color: string;
  duration: number;
  currentTime: number;
  height?: number;
  focusedItemId?: string | null;
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
  gridProps?: { bpm?: number; gridOffset?: number; beatsPerBar?: number; barGroupSize?: number | null; anchors?: readonly import('../../types/songInfo').TempoAnchor[]; beatOverrides?: Readonly<Record<string, number>>; thickness?: number };
  pendingSelection?: PendingSelection | null;
  /** Detector-review mode. When set, loops become read-only and render inline ✓/✗. */
  reviewState?: Record<string, ReviewStatus>;
  onAccept?: (itemId: string) => void;
  onReject?: (itemId: string) => void;
}

export function LoopLayerRow({
  items, color, duration, currentTime, height = 22,
  focusedItemId, playingItemId, onLoopClick,
  onLoopEdgeDrag, onLoopEdgeDragStart,
  onLoopMove, onLoopMoveStart,
  gridProps,
  pendingSelection,
  reviewState, onAccept, onReject,
}: LoopLayerRowProps) {
  const reviewMode = !!reviewState;
  const containerRef = useRef<HTMLDivElement>(null);
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
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
  const moveEnabled = !!onLoopMove && !reviewMode;

  return (
    <div
      ref={containerRef}
      className="flex-1 relative rounded overflow-hidden bg-gray-950"
      style={{ height }}
      title={items.length === 0 ? 'No loops yet — add one from the Loops editor' : undefined}
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
          no loops yet
        </span>
      )}

      {items.map((loop) => {
        const left  = duration > 0 ? (loop.start / duration) * 100 : 0;
        const width = Math.max(0.5, duration > 0 ? ((loop.end - loop.start) / duration) * 100 : 0);
        const isFocused = loop.id === focusedItemId;
        const isPlaying = loop.id === playingItemId;
        const status = reviewState?.[loop.id];
        const bandColor = reviewMode ? reviewBgFor(color, status) : color;
        const boxShadow = isPlaying
          ? `inset 0 0 0 2px ${bandColor}, 0 0 12px ${bandColor}aa`
          : isFocused
            ? `inset 0 0 0 1px ${bandColor}, 0 0 6px ${bandColor}66`
            : undefined;
        const startSnapped = isOnGridLine(loop.start, gridProps?.bpm, gridProps?.gridOffset, gridProps?.beatsPerBar);
        const endSnapped   = isOnGridLine(loop.end,   gridProps?.bpm, gridProps?.gridOffset, gridProps?.beatsPerBar);
        return (
          <div key={loop.id} className="contents">
            <button
              onMouseDown={(e) => {
                if (!moveEnabled) return;
                startBodyMove(loop.id, loop.start, loop.end, e);
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (reviewMode) return;
                if (wasDraggedRef.current) {
                  wasDraggedRef.current = false;
                  return;
                }
                onLoopClick?.(loop.id, { x: e.clientX, y: e.clientY });
              }}
              disabled={reviewMode}
              className={`absolute top-0 bottom-0 flex items-stretch overflow-hidden ${
                reviewMode ? 'cursor-default' : (moveEnabled ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer')
              }`}
              style={{
                left: `${left}%`,
                width: `${width}%`,
                background: isPlaying ? `${bandColor}99` : `${bandColor}55`,
                boxShadow,
                borderRight: '1px solid rgba(0,0,0,0.4)',
                opacity: status === 'rejected' ? 0.4 : 1,
              }}
              title={reviewMode
                ? `${loop.label || '(unlabeled)'} · ${fmtTime(loop.start)}–${fmtTime(loop.end)}${status ? ` · ${status}` : ' · pending review'}${loop.description ? '\n' + loop.description : ''}`
                : `${loop.label || '(unlabeled)'} · ${fmtTime(loop.start)}–${fmtTime(loop.end)}${startSnapped && endSnapped ? ' · both ends snapped' : startSnapped ? ' · start snapped' : endSnapped ? ' · end snapped' : ''}${loop.description ? '\n' + loop.description : ''}`}
            >
              {startSnapped && !reviewMode && <SnapTick style={{ top: 0, left: 0 }} title="Loop start is on the beat grid" />}
              {endSnapped   && !reviewMode && <SnapTick style={{ top: 0, right: 0 }} title="Loop end is on the beat grid" />}
              <span
                className="text-[8px] truncate text-white/90 pointer-events-none select-none leading-none px-0.5 pt-0.5"
                style={{ textShadow: '0 0 4px rgba(0,0,0,0.9)' }}
              >
                {isPlaying ? '▶ ' : ''}{loop.label || `${(loop.end - loop.start).toFixed(1)}s`}
              </span>
              {dragEnabled && (
                <>
                  <span
                    role="separator"
                    aria-label="Drag to move loop start"
                    className="absolute top-0 bottom-0 left-0 w-2 z-20 cursor-ew-resize"
                    style={{ background: 'rgba(255,255,255,0.18)' }}
                    onMouseDown={(e) => startDrag({ id: loop.id, edge: 'start' }, e)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span
                    role="separator"
                    aria-label="Drag to move loop end"
                    className="absolute top-0 bottom-0 right-0 w-2 z-20 cursor-ew-resize"
                    style={{ background: 'rgba(255,255,255,0.18)' }}
                    onMouseDown={(e) => startDrag({ id: loop.id, edge: 'end' }, e)}
                    onClick={(e) => e.stopPropagation()}
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

function fmtTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '0:00.0';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
