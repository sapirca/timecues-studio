/**
 * LyricsLayerRow — word/line lyric timestamps for a single Lyrics layer.
 *
 * Mirrors CueLayerRow (point ticks, click-to-edit, drag-to-reposition,
 * detector-review ✓/✗) but renders the lyric `text` next to each tick and,
 * for `kind: 'line'` items that carry an `end`, a faint duration band so a
 * sung phrase reads as an interval. Words (no `end`) render as a tick + label.
 */

import { useMemo, useRef } from 'react';
import type { LyricsItem } from '../../types/annotationLayer';
import { BeatGridOverlay } from './BeatGridOverlay';
import { useTimelineDrag } from '../../hooks/useTimelineDrag';
import { PendingHighlightOverlay, RegionDragOverlay, type PendingSelection } from './AnnotationOverlays';
import { ReviewControls, reviewBgFor, type ReviewStatus } from './ReviewControls';

interface LyricsLayerRowProps {
  items: LyricsItem[];
  color: string;
  duration: number;
  currentTime: number;
  height?: number;
  /** Lyric id currently focused — drawn brighter than the others. */
  focusedItemId?: string | null;
  onLyricsClick?: (itemId: string, anchor: { x: number; y: number }) => void;
  /** Seek the playhead to a word's start. Fires on click in BOTH edit and
   *  read-only (detector) modes — navigating the transcript shouldn't require
   *  an editable layer. */
  onLyricsSeek?: (time: number) => void;
  /** Drag the tick to change a lyric's time. */
  onLyricsDrag?: (itemId: string, time: number) => void;
  onLyricsDragStart?: (itemId: string) => void;
  gridProps?: { bpm?: number; gridOffset?: number; beatsPerBar?: number; barGroupSize?: number | null; thickness?: number };
  pendingSelection?: PendingSelection | null;
  /** Empty-space click → seek; empty-space drag → create a pending highlight. */
  onSeek?: (time: number) => void;
  onRegion?: (t1: number, t2: number) => void;
  onRegionDragStart?: () => void;
  /** Detector-review mode: ticks become read-only with inline ✓/✗. */
  reviewState?: Record<string, ReviewStatus>;
  onAccept?: (itemId: string) => void;
  onReject?: (itemId: string) => void;
}

export function LyricsLayerRow({
  items, color, duration, currentTime, height = 26,
  focusedItemId, onLyricsClick, onLyricsSeek,
  onLyricsDrag, onLyricsDragStart,
  gridProps,
  pendingSelection,
  onSeek, onRegion, onRegionDragStart,
  reviewState, onAccept, onReject,
}: LyricsLayerRowProps) {
  const reviewMode = !!reviewState;
  const containerRef = useRef<HTMLDivElement>(null);
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const didDragRef = useRef(false);
  const { startDrag } = useTimelineDrag<{ id: string }>({
    containerRef,
    duration,
    onDragStart: ({ id }) => onLyricsDragStart?.(id),
    onDrag: ({ id }, t) => { didDragRef.current = true; onLyricsDrag?.(id, t); },
  });
  const dragEnabled = !!onLyricsDrag && !reviewMode;

  const placed = useMemo(() => {
    if (duration <= 0) return [];
    const sorted = [...items].sort((a, b) => a.time - b.time);
    return sorted.map((item) => ({
      item,
      leftPct: (item.time / duration) * 100,
      widthPct: item.end != null && item.end > item.time
        ? ((item.end - item.time) / duration) * 100
        : null,
    }));
  }, [items, duration]);

  // The word currently under the playhead — the last item whose [time, end)
  // (end falling back to the next word's start) contains currentTime. Drives
  // the karaoke-style highlight as audio plays.
  const activeId = useMemo(() => {
    let id: string | null = null;
    for (let i = 0; i < placed.length; i++) {
      const it = placed[i].item;
      if (it.time <= currentTime) {
        const end = it.end ?? (placed[i + 1]?.item.time ?? Infinity);
        if (currentTime < end) id = it.id;
      }
    }
    return id;
  }, [placed, currentTime]);

  return (
    <div
      ref={containerRef}
      className="flex-1 relative rounded overflow-hidden bg-gray-950"
      style={{ height }}
      title={items.length === 0 ? 'No lyrics yet — run the Lyrics detector or import a transcript' : undefined}
    >
      {gridProps && (
        <BeatGridOverlay
          bpm={gridProps.bpm}
          gridOffset={gridProps.gridOffset}
          beatsPerBar={gridProps.beatsPerBar}
          barGroupSize={gridProps.barGroupSize}
          thickness={gridProps.thickness}
          duration={duration}
        />
      )}

      {items.length === 0 && (
        <span className="absolute inset-0 flex items-center px-2 text-[10px] text-gray-700 italic select-none pointer-events-none">
          no lyrics yet
        </span>
      )}

      {/* Behind the word ticks (z="") — empty space falls through to seek / highlight-drag. */}
      {onSeek && onRegion && (
        <RegionDragOverlay duration={duration} onVizClick={onSeek} onVizRegion={onRegion} onRegionDragStart={onRegionDragStart} z="" />
      )}

      {placed.map(({ item, leftPct, widthPct }) => {
        const isFocused = item.id === focusedItemId;
        const isActive = item.id === activeId;
        const status = reviewState?.[item.id];
        const tickColor = reviewMode ? reviewBgFor(color, status) : color;
        const titleText = `${item.text || '(empty)'} @ ${fmtTime(item.time)}${item.end != null ? `–${fmtTime(item.end)}` : ''} · ${item.kind}${reviewMode && status ? ` · ${status}` : ''} · click to seek`;
        const onClickItem = (e: React.MouseEvent) => {
          e.stopPropagation();
          if (didDragRef.current) { didDragRef.current = false; return; }
          onLyricsSeek?.(item.time);
          // Open the info card in every mode — read-only for detector layers
          // (review mode); the ✓/✗ ReviewControls stop propagation so they
          // don't also trigger this.
          onLyricsClick?.(item.id, { x: e.clientX, y: e.clientY });
        };
        const onMouseDownItem = dragEnabled
          ? (e: React.MouseEvent) => { didDragRef.current = false; startDrag({ id: item.id }, e); }
          : undefined;
        return (
          <div key={item.id} className="contents">
            {/* Duration band for line-level (and word-level with end). */}
            {widthPct != null && (
              <span
                className="absolute top-0 bottom-0 pointer-events-none"
                style={{
                  left: `${leftPct}%`,
                  width: `${widthPct}%`,
                  background: `${tickColor}1f`,
                  borderLeft: `1px solid ${tickColor}66`,
                }}
                aria-hidden="true"
              />
            )}
            <button
              onClick={onClickItem}
              onMouseDown={onMouseDownItem}
              className={`absolute top-0 bottom-0 flex items-center gap-0.5 pl-0.5 rounded-sm group/lyric ${
                dragEnabled ? 'cursor-ew-resize' : 'cursor-pointer'
              }`}
              style={{
                left: `${leftPct}%`,
                maxWidth: '40%',
                background: isActive ? `${tickColor}33` : 'transparent',
                boxShadow: isActive ? `0 0 0 1px ${tickColor}aa` : undefined,
              }}
              title={titleText}
            >
              <span
                className="block w-[2px] h-full rounded-sm transition-all group-hover/lyric:w-[3px] shrink-0"
                style={{
                  background: tickColor,
                  boxShadow: (isFocused || isActive) ? `0 0 10px ${tickColor}, 0 0 3px ${tickColor}` : `0 0 4px ${tickColor}aa`,
                  opacity: status === 'rejected' ? 0.45 : 1,
                }}
              />
              <span
                className="text-[10px] leading-none whitespace-nowrap overflow-hidden text-ellipsis select-none transition-all"
                style={{
                  color: isActive ? '#ffffff' : tickColor,
                  opacity: status === 'rejected' ? 0.4 : (isFocused || isActive ? 1 : 0.85),
                  fontWeight: (isFocused || isActive) ? 700 : 400,
                }}
              >
                {item.text}
              </span>
            </button>
            {reviewMode && (
              <ReviewControls
                status={status}
                onAccept={() => onAccept?.(item.id)}
                onReject={() => onReject?.(item.id)}
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

function fmtTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '0:00.0';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
