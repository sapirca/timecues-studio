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
import { formatClockTime as fmtTime } from '../../utils/clockTime';
import { BeatGridOverlay, type LaneGridProps } from './BeatGridOverlay';
import { useTimelineDrag, createEdgeItemClamp } from '../../hooks/useTimelineDrag';
import { PendingHighlightOverlay, RegionDragOverlay, type PendingSelection } from './AnnotationOverlays';
import { ReviewControls, reviewBgFor, type ReviewStatus } from './ReviewControls';

interface LyricsLayerRowProps {
  items: LyricsItem[];
  color: string;
  duration: number;
  currentTime: number;
  height?: number;
  /** When true, the word/line under the playhead is highlighted (karaoke mode). */
  karaokeActive?: boolean;
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
  /** Edge-drag callback — same contract as SpanLaneRow's onSpanEdgeDrag.
   *  'start' moves the word's `time`, 'end' moves its `end`, so a timed word
   *  can be stretched from either side instead of only slid along. Only the
   *  end handle is rendered for now: the start edge is already the tick, which
   *  drags `time` and leaves `end` alone. */
  onLyricsEdgeDrag?: (itemId: string, edge: 'start' | 'end', time: number) => void;
  onLyricsEdgeDragStart?: (itemId: string, edge: 'start' | 'end') => void;
  gridProps?: LaneGridProps;
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
  karaokeActive,
  focusedItemId, onLyricsClick, onLyricsSeek,
  onLyricsDrag, onLyricsDragStart,
  onLyricsEdgeDrag, onLyricsEdgeDragStart,
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

  // Edge drags reuse the span clamp, which speaks {start,end}. Lyrics store
  // {time,end}, so adapt through a ref the clamp can read live. Words with no
  // `end` get a synthetic one purely so the clamp has an upper bound — they
  // render no band and therefore no handle.
  const edgeItemsRef = useRef<{ id: string; start: number; end: number }[]>([]);
  edgeItemsRef.current = items.map((it) => ({
    id: it.id,
    start: it.time,
    end: it.end != null && it.end > it.time ? it.end : it.time + 0.5,
  }));
  const { startDrag: startEdgeDrag } = useTimelineDrag<{ id: string; edge: 'start' | 'end' }>({
    containerRef,
    duration,
    onDragStart: ({ id, edge }) => onLyricsEdgeDragStart?.(id, edge),
    onDrag: ({ id, edge }, t) => { didDragRef.current = true; onLyricsEdgeDrag?.(id, edge, t); },
    clamp: createEdgeItemClamp(edgeItemsRef, duration),
  });
  const edgeDragEnabled = !!onLyricsEdgeDrag && !reviewMode;

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

  // The word currently under the playhead — gated by karaokeActive.
  const activeId = useMemo(() => {
    if (!karaokeActive) return null;
    let id: string | null = null;
    for (let i = 0; i < placed.length; i++) {
      const it = placed[i].item;
      if (it.time <= currentTime) {
        const end = it.end ?? (placed[i + 1]?.item.time ?? Infinity);
        if (currentTime < end) id = it.id;
      }
    }
    return id;
  }, [karaokeActive, placed, currentTime]);

  return (
    <div
      ref={containerRef}
      className="flex-1 relative rounded overflow-hidden bg-gray-950"
      style={{ height }}
      title={items.length === 0 ? 'No lyrics yet — run the Lyrics detector or import a transcript' : undefined}
    >
      {gridProps && (
        <BeatGridOverlay {...gridProps} duration={duration} />
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
        const onPointerDownItem = dragEnabled
          ? (e: React.PointerEvent) => { didDragRef.current = false; startDrag({ id: item.id }, e); }
          : undefined;
        // Controls reveal only for the hovered/focused word (or one already
        // reviewed) — at word-level density, showing every word's ✓/✗ pair
        // simultaneously makes neighboring pairs visually overlap, and only
        // the topmost DOM element at a given pixel is actually clickable, so
        // clicks silently land on the wrong (or no) word.
        const controlsVisible = isFocused || !!status;
        return (
          <div key={item.id} className="contents">
            {/* Duration band for line-level (and word-level with end). */}
            {widthPct != null && (
              <span
                className="absolute top-0 bottom-0 pointer-events-none"
                style={{
                  left: `${leftPct}%`,
                  width: `${widthPct}%`,
                  background: status ? `${tickColor}99` : `${tickColor}1f`,
                  borderLeft: `1px solid ${tickColor}66`,
                }}
                aria-hidden="true"
              />
            )}
            {/* End handle — sits on the band's right edge so a word can be
                stretched to its real sung length. Rendered only for items that
                already carry an `end` (i.e. draw a band); a bare tick has no
                right edge to grab.
                On a phone the grip reaches 10px further, but only OUTWARD
                (past the end): the shared `.tc-hit` reached both ways, and on a
                short word its inward half lay over the word chip, so the word
                could be stretched but not moved. */}
            {widthPct != null && edgeDragEnabled && (
              <span
                role="separator"
                aria-label="Drag to change lyric end"
                className="absolute top-0 bottom-0 z-20 cursor-ew-resize touch-none pointer-coarse:before:absolute pointer-coarse:before:inset-y-0 pointer-coarse:before:left-0 pointer-coarse:before:-right-2.5"
                style={{
                  left: `calc(${leftPct + widthPct}% - 3px)`,
                  width: 6,
                  background: `${tickColor}55`,
                }}
                title={`Drag to change how long "${item.text || '(empty)'}" lasts`}
                onPointerDown={(e) => { e.stopPropagation(); startEdgeDrag({ id: item.id, edge: 'end' }, e); }}
                onClick={(e) => e.stopPropagation()}
              />
            )}
            <div
              className="absolute top-0 bottom-0 group/lyric"
              style={{ left: `${leftPct}%` }}
            >
              <button
                onClick={onClickItem}
                onPointerDown={onPointerDownItem}
                // The word chip is up to 220px wide and a verse packs them
                // edge to edge, so it keeps vertical page scroll on a phone
                // (touch-pan-y) — only a horizontal drag moves the word.
                className={`absolute top-0 bottom-0 flex items-center gap-0.5 pl-0.5 rounded-sm ${
                  dragEnabled ? 'cursor-ew-resize touch-pan-y' : 'cursor-pointer'
                }`}
                style={{
                  left: 0,
                  maxWidth: 220,
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
                    opacity: 1,
                  }}
                />
                <span
                  className="text-[10px] leading-none whitespace-nowrap overflow-hidden text-ellipsis select-none transition-all rounded-sm px-1"
                  style={{
                    color: isActive ? '#ffffff' : '#e2e8f0',
                    background: 'rgba(3,7,18,0.85)',
                    opacity: (status || isFocused || isActive) ? 1 : 0.95,
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
                  className={controlsVisible ? 'opacity-100' : 'opacity-0 group-hover/lyric:opacity-100'}
                  style={{ position: 'absolute', top: -1, left: 0, transform: 'translateX(-50%)', zIndex: 15 }}
                />
              )}
            </div>
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
