/**
 * PatternLaneRow — tiled-repetition canvas row for a Pattern layer.
 *
 * Each PatternItem expands into `repeatCount` adjacent tiles starting at
 * `start` and butting up against each other (cycle duration = end - start).
 * Tiles run through the same greedy lane assignment as Spans, so overlap
 * with tiles from OTHER patterns bumps a tile down to a new lane — the row
 * stays gridy. Each tile renders a sub-beat strip (beatsPerBar × 4 mini-bars)
 * inside the band, with `highlightedBeats` (step indices) rendered brighter
 * and beat-boundaries marked with a small gap.
 *
 * Clicking any tile of an item opens that item's edit popover (the click
 * carries the underlying PatternItem.id back to the parent).
 */

import { useMemo, useRef } from 'react';
import { PATTERN_SUBBEATS_PER_BEAT, patternStepsPerCycle, type PatternItem } from '../../types/annotationLayer';
import { BeatGridOverlay } from './BeatGridOverlay';
import { isOnGridLine } from '../../utils/snapIndication';
import { SnapTick } from './SnapIndicator';
import { useTimelineDrag, createEdgeItemClamp, useBodyMoveDrag } from '../../hooks/useTimelineDrag';
import { PendingHighlightOverlay, type PendingSelection } from './AnnotationOverlays';
import { ReviewControls, reviewBgFor, type ReviewStatus } from './ReviewControls';

const LANE_HEIGHT_PX = 14;
const LANE_GAP_PX = 1;

interface PatternLaneRowProps {
  items: PatternItem[];
  color: string;
  duration: number;
  currentTime: number;
  focusedItemId?: string | null;
  /** ItemId currently being auditioned (the play button is active). */
  playingItemId?: string | null;
  onPatternClick?: (itemId: string, anchor: { x: number; y: number }) => void;
  /** Edge-drag callback. Only the first (original) tile carries handles, since
   *  resizing the cycle implicitly resizes every repeat. */
  onPatternEdgeDrag?: (itemId: string, edge: 'start' | 'end', time: number) => void;
  onPatternEdgeDragStart?: (itemId: string, edge: 'start' | 'end') => void;
  /** Body-drag callback. Move the whole pattern (and all its repeats) without
   *  changing the cycle length — start and end shift by the same delta. */
  onPatternMove?: (itemId: string, newStart: number, newEnd: number) => void;
  onPatternMoveStart?: (itemId: string) => void;
  gridProps?: { bpm?: number; gridOffset?: number; beatsPerBar?: number; barGroupSize?: number | null; anchors?: readonly import('../../types/songInfo').TempoAnchor[]; beatOverrides?: Readonly<Record<string, number>>; thickness?: number };
  pendingSelection?: PendingSelection | null;
  /** Detector-review mode. When set, patterns become read-only and render inline ✓/✗ on the first tile. */
  reviewState?: Record<string, ReviewStatus>;
  onAccept?: (itemId: string) => void;
  onReject?: (itemId: string) => void;
}

interface PlacedTile {
  itemId: string;
  /** 0-based tile index inside the pattern (0 = original cycle, 1 = first repeat …). */
  tileIndex: number;
  /** First tile of an item carries the label; later tiles render as bare chips. */
  isFirst: boolean;
  start: number;
  end: number;
  label: string;
  description?: string;
  highlightedBeats: number[];
  lane: number;
}

function expandToTiles(items: PatternItem[]): PlacedTile[] {
  const tiles: Omit<PlacedTile, 'lane'>[] = [];
  for (const it of items) {
    const cycle = it.end - it.start;
    if (cycle <= 0) continue;
    const reps = Math.max(1, Math.floor(it.repeatCount));
    for (let i = 0; i < reps; i++) {
      tiles.push({
        itemId: it.id,
        tileIndex: i,
        isFirst: i === 0,
        start: it.start + i * cycle,
        end:   it.start + (i + 1) * cycle,
        label: it.label,
        description: it.description,
        highlightedBeats: it.highlightedBeats,
      });
    }
  }
  // Greedy lane assignment — sort by start, place each tile in the lowest lane
  // that doesn't conflict with the running end of that lane.
  tiles.sort((a, b) => a.start - b.start);
  const laneEnds: number[] = [];
  const placed: PlacedTile[] = [];
  for (const t of tiles) {
    let lane = laneEnds.findIndex((end) => end <= t.start);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(t.end); }
    else laneEnds[lane] = t.end;
    placed.push({ ...t, lane });
  }
  return placed;
}

export function PatternLaneRow({
  items, color, duration, currentTime,
  focusedItemId, playingItemId, onPatternClick,
  onPatternEdgeDrag, onPatternEdgeDragStart,
  onPatternMove, onPatternMoveStart,
  gridProps,
  pendingSelection,
  reviewState, onAccept, onReject,
}: PatternLaneRowProps) {
  const reviewMode = !!reviewState;
  const containerRef = useRef<HTMLDivElement>(null);
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const placed = useMemo(() => expandToTiles(items), [items]);
  const laneCount = useMemo(
    () => placed.reduce((m, t) => Math.max(m, t.lane + 1), 1),
    [placed],
  );
  const height = Math.max(24, laneCount * LANE_HEIGHT_PX + (laneCount - 1) * LANE_GAP_PX + 4);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const durationRef = useRef(duration);
  durationRef.current = duration;

  const { startDrag } = useTimelineDrag<{ id: string; edge: 'start' | 'end' }>({
    containerRef,
    duration,
    onDragStart: ({ id, edge }) => onPatternEdgeDragStart?.(id, edge),
    onDrag: ({ id, edge }, t) => onPatternEdgeDrag?.(id, edge, t),
    clamp: createEdgeItemClamp(itemsRef, duration),
  });
  const dragEnabled = !!onPatternEdgeDrag && !reviewMode;

  const { startBodyMove, wasDraggedRef } = useBodyMoveDrag({
    containerRef,
    durationGetter: () => durationRef.current,
    onMoveStart: (id) => onPatternMoveStart?.(id),
    onMove: (id, ns, ne) => onPatternMove?.(id, ns, ne),
  });
  const moveEnabled = !!onPatternMove && !reviewMode;

  return (
    <div
      ref={containerRef}
      className="flex-1 relative rounded overflow-hidden bg-gray-950"
      style={{ height }}
      title={items.length === 0 ? 'No patterns yet — add one from the Patterns editor' : undefined}
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
          no patterns yet
        </span>
      )}

      {placed.map((tile) => {
        const left  = duration > 0 ? (tile.start / duration) * 100 : 0;
        const width = Math.max(0.5, duration > 0 ? ((tile.end - tile.start) / duration) * 100 : 0);
        const isFocused = tile.itemId === focusedItemId;
        const isPlaying = tile.itemId === playingItemId;
        const top = 2 + tile.lane * (LANE_HEIGHT_PX + LANE_GAP_PX);
        const status = reviewState?.[tile.itemId];
        const tileColor = reviewMode ? reviewBgFor(color, status) : color;
        const bg = tile.isFirst ? `${tileColor}66` : `${tileColor}33`;
        const startSnapped = isOnGridLine(tile.start, gridProps?.bpm, gridProps?.gridOffset, gridProps?.beatsPerBar);
        const endSnapped   = isOnGridLine(tile.end,   gridProps?.bpm, gridProps?.gridOffset, gridProps?.beatsPerBar);
        const titleText = reviewMode
          ? `${tile.label || '(unlabeled)'} · cycle ${tile.tileIndex + 1}${status ? ` · ${status}` : ' · pending review'}${tile.description ? '\n' + tile.description : ''}`
          : `${tile.label || '(unlabeled)'} · cycle ${tile.tileIndex + 1}${startSnapped && endSnapped ? ' · snapped to grid' : ''}${tile.description ? '\n' + tile.description : ''}`;
        const tileMoveEnabled = moveEnabled && tile.isFirst;
        return (
          <div key={`${tile.itemId}#${tile.tileIndex}`} className="contents">
            <button
              onMouseDown={(e) => {
                if (!tileMoveEnabled) return;
                startBodyMove(tile.itemId, tile.start, tile.end, e);
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (reviewMode) return;
                if (wasDraggedRef.current) {
                  wasDraggedRef.current = false;
                  return;
                }
                onPatternClick?.(tile.itemId, { x: e.clientX, y: e.clientY });
              }}
              disabled={reviewMode}
              className={`absolute flex items-stretch overflow-hidden rounded-sm ${
                reviewMode ? 'cursor-default' : (tileMoveEnabled ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer')
              }`}
              style={{
                left: `${left}%`,
                width: `${width}%`,
                top,
                height: LANE_HEIGHT_PX,
                background: bg,
                boxShadow: isFocused
                  ? `inset 0 0 0 1px ${tileColor}, 0 0 6px ${tileColor}88`
                  : isPlaying ? `inset 0 0 0 1px ${tileColor}aa` : undefined,
                borderRight: '1px solid rgba(0,0,0,0.55)',
                opacity: status === 'rejected' ? 0.4 : 1,
              }}
              title={titleText}
            >
              {tile.isFirst && startSnapped && !reviewMode && <SnapTick style={{ top: 0, left: 0 }} title="Pattern cycle start is on the beat grid" />}
              {endSnapped && !reviewMode && <SnapTick style={{ top: 0, right: 0 }} title="Pattern cycle boundary is on the beat grid" />}
              <ChipStrip
                color={tileColor}
                beatsPerBar={gridProps?.beatsPerBar ?? 4}
                highlighted={tile.highlightedBeats}
                label={tile.isFirst ? tile.label : ''}
              />
              {dragEnabled && tile.isFirst && (
                <>
                  <span
                    role="separator"
                    aria-label="Drag to move pattern cycle start"
                    className="absolute top-0 bottom-0 left-0 w-1.5 z-20 cursor-ew-resize"
                    style={{ background: 'rgba(255,255,255,0.18)' }}
                    onMouseDown={(e) => startDrag({ id: tile.itemId, edge: 'start' }, e)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span
                    role="separator"
                    aria-label="Drag to move pattern cycle end"
                    className="absolute top-0 bottom-0 right-0 w-1.5 z-20 cursor-ew-resize"
                    style={{ background: 'rgba(255,255,255,0.18)' }}
                    onMouseDown={(e) => startDrag({ id: tile.itemId, edge: 'end' }, e)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </>
              )}
            </button>
            {reviewMode && tile.isFirst && (
              <ReviewControls
                status={status}
                onAccept={() => onAccept?.(tile.itemId)}
                onReject={() => onReject?.(tile.itemId)}
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

/** Renders the sub-beat chips inside a tile. `beatsPerBar × 4` mini bars span
 *  the tile width; highlighted sub-beats are full-opacity, others are dim. A
 *  small gap every PATTERN_SUBBEATS_PER_BEAT marks beat boundaries so the
 *  pulse stays readable at small tile widths. The label, when present, sits
 *  on the left and truncates. */
function ChipStrip({ color, beatsPerBar, highlighted, label }: {
  color: string; beatsPerBar: number; highlighted: number[]; label: string;
}) {
  const hSet = new Set(highlighted);
  const steps = patternStepsPerCycle(beatsPerBar);
  return (
    <span className="flex items-stretch w-full h-full pointer-events-none select-none">
      {label && (
        <span
          className="text-[8px] truncate text-white/90 leading-none px-1 self-center max-w-[40%]"
          style={{ textShadow: '0 0 4px rgba(0,0,0,0.9)' }}
        >
          {label}
        </span>
      )}
      <span className="flex-1 flex items-stretch gap-px py-0.5 pr-0.5 pl-0.5">
        {Array.from({ length: steps }, (_, i) => {
          const isLastInBeat = (i % PATTERN_SUBBEATS_PER_BEAT) === PATTERN_SUBBEATS_PER_BEAT - 1;
          const isLast = i === steps - 1;
          return (
            <span
              key={i}
              className="flex-1 rounded-[1px]"
              style={{
                background: hSet.has(i) ? color : `${color}33`,
                boxShadow: hSet.has(i) ? `0 0 3px ${color}` : undefined,
                minWidth: 1,
                marginRight: isLastInBeat && !isLast ? 2 : 0,
              }}
            />
          );
        })}
      </span>
    </span>
  );
}
