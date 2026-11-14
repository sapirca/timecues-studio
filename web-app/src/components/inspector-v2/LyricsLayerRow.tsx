/**
 * LyricsLayerRow — word/line lyric timestamps for a single Lyrics layer.
 *
 * Mirrors CueLayerRow (point ticks, click-to-edit, drag-to-reposition,
 * detector-review ✓/✗) but renders the lyric `text` next to each tick and,
 * for items that carry an `end`, a faint duration band so a sung phrase (or a
 * word timed to its sound) reads as an interval. Words (no `end`) render as a
 * tick + label. A word's `onsets` draw as short ticks in the lower half, each
 * with its syllable, so one lane says both what was sung and when each part
 * of it began. A word's `envelope` draws as a faint dashed contour behind it — up to its
 * peak, down to its sustain, held, released — from where the sound rises to
 * where it dies away, louder sounds taller.
 *
 * Each timed word is a closed box — a bright bar where it starts, a bracket
 * where it ends — and neighbours alternate shade, so where one word stops and
 * the next begins reads at a glance. Words that overlap in time are stacked
 * into their own row (only then does the lane split), and the overlapping
 * stretch is hatched amber: two words never lie on top of each other, so it
 * is always clear which one a press will grab.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { LYRIC_MIN_SEC, type LyricsItem } from '../../types/annotationLayer';
import { formatClockTime as fmtTime } from '../../utils/clockTime';
import { BeatGridOverlay, type LaneGridProps } from './BeatGridOverlay';
import { useTimelineDrag, createEdgeItemClamp, useBodyMoveDrag } from '../../hooks/useTimelineDrag';
import { PendingHighlightOverlay, RegionDragOverlay, type PendingSelection } from './AnnotationOverlays';
import { isSelectToggle, useCrossLaneDrop, type CrossLaneDropOptions } from '../../hooks/useCrossLaneDrop';
import { nearestGrip, overlapSpans, packRows, type LyricsGrip } from './lyricsGrip';
import { ReviewControls, reviewBgFor, type ReviewStatus } from './ReviewControls';
import { usePaintClock, usePlayheadValue } from '../../hooks/usePlayhead';
import { PlayheadLine } from '../Playhead';
import { SoundEnvelopeShape } from './shared/SoundEnvelopeShape';
import { envelopeTitle, loudestPeakDb } from '../../utils/soundEnvelopes';

/** A lane dragged taller keeps between these; the floor is the default lane. */
const LANE_MIN_H = 26;
const LANE_MAX_H = 480;

function readLaneHeight(key: string | undefined): number | null {
  if (!key) return null;
  try {
    const n = parseInt(localStorage.getItem(key) ?? '', 10);
    return Number.isFinite(n) && n >= LANE_MIN_H ? Math.min(LANE_MAX_H, n) : null;
  } catch { return null; }
}

interface LyricsLayerRowProps {
  items: LyricsItem[];
  color: string;
  duration: number;
  height?: number;
  /** Where this lane's dragged height is remembered (per browser). With it the
   *  lane's bottom edge is a grip: drag it down and the stacked rows of
   *  overlapping words get the room; double-click it to go back. */
  heightKey?: string;
  /** When true, the word/line under the playhead is highlighted (the lane's Visualize switch). */
  visualize?: boolean;
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
  /** Editable lane: a drag over empty space makes a lyric line over the dragged
   *  stretch, in this lane (see laneCreate.ts), instead of the teal
   *  highlight. Absent on detector lanes. */
  onCreate?: (t1: number, t2: number) => void;
  /** The snap `onCreate` applies, so the drag preview lands where the item will. */
  createSnap?: (t: number) => number;
  /** Drag words onto another Lyrics lane to copy (or ⌥ move) them there — see
   *  useCrossLaneDrop. Absent on read-only lanes and wherever words can't move. */
  laneDrop?: CrossLaneDropOptions;
  /** Detector-review mode: ticks become read-only with inline ✓/✗. */
  reviewState?: Record<string, ReviewStatus>;
  onAccept?: (itemId: string) => void;
  onReject?: (itemId: string) => void;
}

export function LyricsLayerRow({
  items, color, duration, height = LANE_MIN_H, heightKey,
  visualize,
  focusedItemId, onLyricsClick, onLyricsSeek,
  onLyricsDrag, onLyricsDragStart,
  onLyricsEdgeDrag, onLyricsEdgeDragStart,
  gridProps,
  pendingSelection,
  onSeek, onRegion, onRegionDragStart, onCreate, createSnap,
  reviewState, onAccept, onReject,
  laneDrop,
}: LyricsLayerRowProps) {
  const reviewMode = !!reviewState;
  const containerRef = useRef<HTMLDivElement>(null);
  const [draggedHeight, setDraggedHeight] = useState<number | null>(() => readLaneHeight(heightKey));
  useEffect(() => { setDraggedHeight(readLaneHeight(heightKey)); }, [heightKey]);
  const saveHeight = (h: number | null) => {
    setDraggedHeight(h);
    if (!heightKey) return;
    try {
      if (h === null) localStorage.removeItem(heightKey);
      else localStorage.setItem(heightKey, String(Math.round(h)));
    } catch { /* a courtesy */ }
  };
  const startHeightDrag = (e: React.PointerEvent) => {
    const el = containerRef.current;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = el.offsetHeight;
    let latest = startH;
    const onMove = (ev: PointerEvent) => {
      latest = Math.min(LANE_MAX_H, Math.max(LANE_MIN_H, startH + ev.clientY - startY));
      setDraggedHeight(latest);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      saveHeight(latest);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  };
  const didDragRef = useRef(false);
  // Moving a word waits for 3px of travel and keeps the grab offset, as span
  // bodies do: a press with a hand's wobble is a click (it opens the card),
  // and a real drag slides the word from where it was grabbed instead of
  // jumping its start to the pointer.
  const { startBodyMove } = useBodyMoveDrag({
    containerRef,
    // Read once per press; a drag never outlives a duration change.
    durationGetter: () => duration,
    onMoveStart: (id) => onLyricsDragStart?.(id),
    onMove: (id, start) => { didDragRef.current = true; onLyricsDrag?.(id, start); },
  });
  const dragEnabled = !!onLyricsDrag && !reviewMode;
  const { beginLaneDrop } = useCrossLaneDrop(laneDrop);

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

  const { placed, overlaps } = useMemo(() => {
    if (duration <= 0) return { placed: [], overlaps: [] };
    const sorted = [...items].sort((a, b) => a.time - b.time);
    const { rows, counts, count } = packRows(sorted);
    const perRow = new Array<number>(count).fill(0);
    const placed = sorted.map((item, idx) => {
      // Onsets are pinned to the audio; a word trimmed by hand draws only
      // the ones still inside it. Each label may run until the next onset.
      const end = item.end ?? Infinity;
      const inside = (item.onsets ?? []).filter((o) => o.time >= item.time && o.time <= end);
      return {
        item,
        row: rows[idx],
        // Rows of this word's own cluster — the lane splits only where words overlap.
        rows: counts[idx],
        // Alternate shade within a row, so two words back to back read as two.
        alt: perRow[rows[idx]]++ % 2 === 1,
        leftPct: (item.time / duration) * 100,
        widthPct: item.end != null && item.end > item.time
          ? ((item.end - item.time) / duration) * 100
          : null,
        onsets: inside.map((o, i) => ({
          key: `${o.time}`,
          text: o.text,
          leftPct: (o.time / duration) * 100,
          roomPct: (((inside[i + 1]?.time ?? item.end ?? o.time + 1) - o.time) / duration) * 100,
        })),
      };
    });
    return { placed, overlaps: overlapSpans(sorted) };
  }, [items, duration]);

  // What each word overlaps, for its tooltip.
  const overlapNote = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const o of overlaps) {
      m.set(o.a.id, [...(m.get(o.a.id) ?? []), o.b.text || '(empty)']);
      m.set(o.b.id, [...(m.get(o.b.id) ?? []), o.a.text || '(empty)']);
    }
    return m;
  }, [overlaps]);

  // Which grip a press means. Aligned words sit back to back, so one word's
  // end handle lies over the next word's tick, and the handle is on top: a
  // press aimed at the right word's tick dragged the left word's end. So a
  // press on either grip goes to whichever one is nearest the pointer — a
  // word's tick (move it) or a word's end (trim it) — and the drawn order
  // stops deciding. Two grips a few pixels apart are then both reachable.
  const pressGrip = (own: LyricsGrip, e: React.PointerEvent) => {
    didDragRef.current = false;
    const rect = containerRef.current?.getBoundingClientRect();
    // Stacked rows are separate targets: only grips in the row pressed answer.
    const yFrac = rect && rect.height > 0 ? (e.clientY - rect.top) / rect.height : undefined;
    const grip = rect && rect.width > 0 && duration > 0
      ? nearestGrip(placed, e.clientX - rect.left, rect.width / duration, dragEnabled, edgeDragEnabled, yFrac) ?? own
      : own;
    if (grip.kind === 'end') { startEdgeDrag({ id: grip.id, edge: 'end' }, e); return; }
    // Only once the grip is known: the word that moves is the word that can
    // be carried to another lane, never the neighbour whose grip lay on top.
    if (beginLaneDrop(grip.id, e)) return;
    const it = placed.find((pl) => pl.item.id === grip.id)?.item;
    if (!it) return;
    // Held here, not by the lane: the gaps between words seek and highlight.
    e.stopPropagation();
    startBodyMove(it.id, it.time, it.end != null && it.end > it.time ? it.end : it.time + LYRIC_MIN_SEC, e);
  };

  const envelopes = useMemo(() => ({
    loudestDb: loudestPeakDb(items.map((it) => it.envelope)),
    shapes: items.flatMap((it) => (it.envelope ? [{ id: it.id, envelope: it.envelope }] : [])),
  }), [items]);

  // The word currently under the playhead — gated by visualize. Derived
  // from the clock, so the row re-renders only when the word changes.
  const activeId = usePlayheadValue((t) => {
    if (!visualize) return null;
    let id: string | null = null;
    for (let i = 0; i < placed.length; i++) {
      const it = placed[i].item;
      if (it.time <= t) {
        const end = it.end ?? (placed[i + 1]?.item.time ?? Infinity);
        if (t < end) id = it.id;
      }
    }
    return id;
  }, usePaintClock());

  return (
    <div
      ref={containerRef}
      className="flex-1 relative rounded overflow-hidden bg-gray-950"
      style={{ minHeight: draggedHeight ?? height }}
      title={items.length === 0 && !onCreate ? 'No lyrics yet — run the Lyrics detector or import a transcript' : undefined}
    >
      {gridProps && (
        <BeatGridOverlay {...gridProps} duration={duration} />
      )}

      {items.length === 0 && (
        <span className="absolute inset-0 flex items-center px-2 text-[10px] text-gray-700 italic select-none pointer-events-none">
          {onCreate ? 'no lyrics yet — drag here to add one' : 'no lyrics yet'}
        </span>
      )}

      {/* Behind the word ticks (z="") — empty space falls through to seek / highlight-drag. */}
      {onSeek && onRegion && (
        <RegionDragOverlay duration={duration} onVizClick={onSeek} onVizRegion={onCreate ?? onRegion} onRegionDragStart={onCreate ? undefined : onRegionDragStart} onSelectRegion={laneDrop?.onSelectRange}
          createColor={onCreate ? color : undefined} snapTime={onCreate ? createSnap : undefined} hint={onCreate ? 'Drag to add a lyric line · click to move the playhead · ⇧-drag to select the lyrics inside' : undefined} z="" />
      )}

      {/* Each sound's envelope, in song seconds, behind the words. */}
      <SoundEnvelopeShape {...envelopes} from={0} to={duration} />

      {placed.map(({ item, row, rows: rowCount, alt, leftPct, widthPct, onsets }) => {
        // The word's own row of the lane; one row when nothing overlaps it.
        const rowBox = { top: `${(row / rowCount) * 100}%`, height: `${100 / rowCount}%` };
        const overlapsWith = overlapNote.get(item.id);
        const isFocused = item.id === focusedItemId;
        const isActive = item.id === activeId;
        const status = reviewState?.[item.id];
        const tickColor = reviewMode ? reviewBgFor(color, status) : color;
        const titleText = `${item.text || '(empty)'} @ ${fmtTime(item.time)}${item.end != null ? `–${fmtTime(item.end)}` : ''} · ${item.kind}${item.envelope ? envelopeTitle(item.envelope) : ''}${overlapsWith ? ` · ⚠ overlaps ${overlapsWith.map((t) => `"${t}"`).join(', ')}` : ''}${reviewMode && status ? ` · ${status}` : ''} · click to edit`;
        const onClickItem = (e: React.MouseEvent) => {
          e.stopPropagation();
          if (laneDrop && isSelectToggle(e)) { laneDrop.onToggleSelect(item.id); return; }
          if (didDragRef.current) { didDragRef.current = false; return; }
          onLyricsSeek?.(item.time);
          // Open the info card in every mode — read-only for detector layers
          // (review mode); the ✓/✗ ReviewControls stop propagation so they
          // don't also trigger this.
          onLyricsClick?.(item.id, { x: e.clientX, y: e.clientY });
        };
        const onPointerDownItem = dragEnabled
          ? (e: React.PointerEvent) => {
              // A ⇧/⌘ press is a selection click, never a drag; a press on a
              // selected word carries the selection to another lane.
              if (laneDrop && isSelectToggle(e)) { e.stopPropagation(); return; }
              if (beginLaneDrop(item.id, e, { groupOnly: true })) return;
              pressGrip({ id: item.id, kind: 'move' }, e);
            }
          : undefined;
        // Controls reveal only for the hovered/focused word (or one already
        // reviewed) — at word-level density, showing every word's ✓/✗ pair
        // simultaneously makes neighboring pairs visually overlap, and only
        // the topmost DOM element at a given pixel is actually clickable, so
        // clicks silently land on the wrong (or no) word.
        const controlsVisible = isFocused || !!status;
        return (
          <div key={item.id} className="contents">
            {/* Duration band for line-level (and word-level with end). Its
                body only opens the card — a line is clickable along its length,
                not just at its first few pixels — and never drags: moving is
                the tick's job and trimming the right edge's, so a click in the
                middle cannot shift the lyric. The press is kept from the lane,
                whose own drag would start a highlight. */}
            {widthPct != null && (
              <span
                onClick={onClickItem}
                onPointerDown={(e) => e.stopPropagation()}
                title={titleText}
                className="absolute cursor-pointer box-border"
                style={{
                  ...rowBox,
                  left: `${leftPct}%`,
                  width: `${widthPct}%`,
                  background: status ? `${tickColor}99` : `${tickColor}${alt ? '33' : '1a'}`,
                  // A closed box: the word's extent is its outline, not just a tint.
                  border: `1px solid ${tickColor}${alt ? '88' : '55'}`,
                  borderRadius: 2,
                }}
                aria-hidden="true"
              />
            )}
            {/* Where each sound inside the word begins: a short tick in the
                lower half, the syllable sung there beside it (an attack no
                syllable was laid on is a bare tick). */}
            {onsets.map((o) => (
              <span
                key={o.key}
                className="absolute h-1/2 flex items-end pointer-events-none"
                style={{
                  left: `${o.leftPct}%`, width: `${o.roomPct}%`, minWidth: 2,
                  // The lower half of the word's own row.
                  bottom: `${((rowCount - 1 - row) / rowCount) * 100}%`,
                  height: `${50 / rowCount}%`,
                }}
                aria-hidden="true"
              >
                <span className="block w-px h-full shrink-0" style={{ background: tickColor }} />
                {o.text && (
                  <span
                    className="text-[9px] leading-none pl-0.5 pb-0.5 whitespace-nowrap overflow-hidden select-none"
                    style={{ color: tickColor }}
                  >
                    {o.text}
                  </span>
                )}
              </span>
            ))}
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
                className="absolute z-20 cursor-ew-resize touch-none pointer-coarse:before:absolute pointer-coarse:before:inset-y-0 pointer-coarse:before:left-0 pointer-coarse:before:-right-2.5"
                style={{
                  ...rowBox,
                  left: `calc(${leftPct + widthPct}% - 3px)`,
                  width: 6,
                }}
                title={`Drag to change how long "${item.text || '(empty)'}" lasts`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  // Selected words overlap their neighbours' grips; a press on
                  // one still carries the selection.
                  if (laneDrop && isSelectToggle(e)) return;
                  if (beginLaneDrop(item.id, e, { groupOnly: true })) return;
                  pressGrip({ id: item.id, kind: 'end' }, e);
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (laneDrop && isSelectToggle(e)) laneDrop.onToggleSelect(item.id);
                }}
              >
                {/* A "]" bracket — the end looks nothing like the start's
                    bar, so a boundary between two words shows which is which. */}
                <span
                  className="absolute right-[3px] w-[5px] pointer-events-none"
                  style={{
                    top: 1, bottom: 1,
                    borderTop: `2px solid ${tickColor}`,
                    borderBottom: `2px solid ${tickColor}`,
                    borderRight: `2px solid ${tickColor}`,
                    borderRadius: '0 2px 2px 0',
                  }}
                />
              </span>
            )}
            {/* z-10: a word's chip runs past its own band, and must stay above
                the next word's band, which comes later in the DOM. */}
            <div
              className="absolute z-10 group/lyric"
              style={{ ...rowBox, left: `${leftPct}%` }}
            >
              <button
                // The page finds a just-added word by this to open its card
                // beside it.
                data-lyric-id={item.id}
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
                  // Selected for a cross-lane drag (⇧/⌘-click).
                  outline: laneDrop?.selectedIds.has(item.id) ? '2px solid #ffffff' : undefined,
                  outlineOffset: -1,
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
                  dir="auto"
                  className="text-[10px] leading-none whitespace-nowrap overflow-hidden text-ellipsis select-none transition-all rounded-sm px-1"
                  style={{
                    color: isActive ? '#ffffff' : '#e2e8f0',
                    background: 'rgba(3,7,18,0.85)',
                    opacity: (status || isFocused || isActive) ? 1 : 0.95,
                    fontWeight: (isFocused || isActive) ? 700 : 400,
                  }}
                >
                  {item.text || <span className="italic opacity-60">({item.kind})</span>}
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

      {/* Where two words overlap: hatched amber over the full lane height, so
          the clash is visible even before hovering either word. */}
      {overlaps.map((o) => (
        <span
          key={`${o.a.id}|${o.b.id}`}
          data-lyric-overlap
          className="absolute top-0 bottom-0 pointer-events-none"
          style={{
            left: `${(o.start / duration) * 100}%`,
            width: `${((o.end - o.start) / duration) * 100}%`,
            minWidth: 2,
            background: 'repeating-linear-gradient(135deg, rgba(245,158,11,0.45) 0 3px, transparent 3px 7px)',
            borderLeft: '1px solid rgba(245,158,11,0.9)',
            borderRight: '1px solid rgba(245,158,11,0.9)',
          }}
          aria-hidden="true"
        />
      ))}

      {/* Playhead */}
      <PlayheadLine
        duration={duration}
        className="absolute top-0 bottom-0 w-px pointer-events-none z-10"
        style={{ background: 'rgba(255,255,255,0.75)' }}
      />
      {pendingSelection && (
        <PendingHighlightOverlay sel={pendingSelection} duration={duration} grid={gridProps} />
      )}

      {/* The lane's bottom edge: drag down for taller rows where words overlap. */}
      {heightKey && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Drag to change the lane's height"
          data-lyrics-height-grip
          className="absolute left-0 right-0 bottom-0 h-1.5 z-30 cursor-row-resize touch-none hover:bg-white/20"
          title="Drag to make this lane taller — overlapping words get their own rows · double-click to reset"
          onPointerDown={startHeightDrag}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => { e.stopPropagation(); saveHeight(null); }}
        />
      )}
    </div>
  );
}
