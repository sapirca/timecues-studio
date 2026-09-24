/**
 * RiffPatternLaneRow — canvas row for a riff-patterns layer.
 *
 * Renders each placed Riff (RiffPatternItem) tiled `repeatCount` times. Inside
 * each cycle, sequence entries render as proportionally-sized blocks — width
 * is `entry.lengthSteps / riffCycleSteps(cycle, bpm)` of the cycle. The two
 * normally agree exactly: an instance's `end` is derived from its sequence
 * (`fitRiffInstanceEnd`), so the blocks fill the cycle edge to edge. A sequence
 * shorter than its cycle is what a song with no tempo grid leaves behind —
 * nothing can be fitted without a steps↔seconds mapping — and it draws as a
 * dashed "empty" tail rather than silently looping to fill it. A combo
 * entry is further expanded (`flattenEntryVisual`, recursively) into its own
 * node/silence leaves scaled to fit the entry's slot, so what a combo is
 * actually made of is visible on the canvas rather than one opaque block. A
 * node leaf renders its own beat grid via the shared `ChipStrip` (same on/off
 * sub-beat strip a plain Pattern tile uses) instead of a flat color fill, so
 * which beats are actually turned on is visible without opening the node's
 * popup.
 * Nodes and combos are timeless library primitives (see RiffNode/RiffCombo)
 * with no canvas position of their own, so every click on this row has to pick
 * one of two editors. The tile is split so the pick is visible rather than
 * guessed: the title bar across the top is the INSTANCE (click opens its
 * popup, drag moves it and all its repeats), and each block below it is the
 * NODE it draws (click opens that node's popup). A combo or silence block has
 * no node of its own, so it falls back to the instance popup, expanded to
 * that entry.
 *
 * Each block's right edge is a drag handle, and what it resizes depends on
 * what the block IS. On an entry that's a bare node it TRIMS the node itself
 * (`trimRiffNodeLength`): the node's length moves, its tail is dropped, and
 * every placement scales with it, so the blocks that survive stay exactly the
 * size they're drawn at. That's what "shorten this" almost always means —
 * scaling the node's content into a narrower slot instead just squeezes the
 * whole rhythm. Alt-drag (and any combo/silence entry, where "the node's
 * length" means nothing) keeps the older behaviour: the entry's own
 * `lengthSteps` changes and its content stretches or squeezes to fill it.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { AnnotationLayer, RiffCombo, RiffNode, RiffPatternItem, RiffSeqEntry } from '../../types/annotationLayer';
import { prominenceAt, prominenceSummary, type ProminenceEnvelope } from '../../types/annotationLayer';
import { ProminenceStrip, PROMINENCE_EDIT_TOTAL_H } from './shared/ProminenceLane';
import { RIFF_NODE_SILENCE_ID, flattenRiffEntry, riffCycleSteps, isBoundaryNode, riffNodeLengthBeats } from '../../types/annotationLayer';
import { BeatGridOverlay, type LaneGridProps } from './BeatGridOverlay';
import { BoundaryStrip } from './BoundarySegmentEditor';
import { ChipStrip } from './BeatChipControls';
import { useBodyMoveDrag, isSamePointer, isSecondaryPointer, pointerIdOf } from '../../hooks/useTimelineDrag';
import { PendingHighlightOverlay, RegionDragOverlay, type PendingSelection } from './AnnotationOverlays';

/** Each placed instance draws as a title bar over a body of sequence blocks.
 *  The bar is the INSTANCE's target (click = its popup, drag = move it); the
 *  body belongs to the blocks (click = that node's popup). Splitting the two
 *  is what makes "which editor does this click open?" answerable by looking:
 *  before the bar existed a sequence that filled its cycle left no pixel that
 *  belonged to the instance, so its popup was unreachable from the canvas. */
const INST_HEADER_H = 13;
const INST_LANE_H = 20 + INST_HEADER_H;
const LANE_GAP_PX = 2;

/** One id per resize press, handed to the drag's callback as its undo
 *  coalesce key: the whole gesture collapses into a single ⌘Z, while the
 *  NEXT drag — which has to undo separately — gets a key of its own. Module
 *  scope rather than a ref, so ids stay unique across a remount too. */
let gestureSeq = 0;
const nextGestureId = () => `${gestureSeq++}`;

/** Greedily assigns each placed item a vertical lane, the same packing
 *  `PatternLaneRow.expandToTiles` uses for Pattern tiles — two items whose
 *  full occupied span (start through its last repeat's end) overlaps in
 *  time land in different lanes and stack one below the other instead of
 *  painting over each other. Items sharing a lane never overlap by
 *  construction, so within a lane the original render order is unchanged. */

/** How much two instances may overlap and still count as touching, in seconds.
 *
 *  A run of bars is stored as `start + cycle x repeats`, and `cycle` is one bar
 *  rounded to whole milliseconds — so several repeats accumulate a rounding
 *  error against the next run's own measured start, and two runs that are
 *  back-to-back in the music end up overlapping by a millisecond. Without a
 *  tolerance the packer believes it, opens a fresh lane, and every row in the
 *  lane grows to fit a stack that exists for 1 ms at one place in the song.
 *
 *  Small enough that it can never merge two things a person placed apart: a
 *  16th note is 75 ms even at 200 BPM. */
const LANE_TOUCH_TOLERANCE_S = 0.02;

function assignLanes(items: RiffPatternItem[]): { laneById: Map<string, number>; laneCount: number } {
  const spans = items
    .map((item) => {
      const cycleSec = Math.max(0.01, item.end - item.start);
      const reps = Math.max(1, Math.floor(item.repeatCount));
      return { id: item.id, start: item.start, end: item.start + cycleSec * reps };
    })
    .sort((a, b) => a.start - b.start);
  const laneEnds: number[] = [];
  const laneById = new Map<string, number>();
  for (const s of spans) {
    let lane = laneEnds.findIndex((end) => end <= s.start + LANE_TOUCH_TOLERANCE_S);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(s.end); }
    else laneEnds[lane] = s.end;
    laneById.set(s.id, lane);
  }
  return { laneById, laneCount: Math.max(1, laneEnds.length) };
}

interface RiffPatternLaneRowProps {
  layer: AnnotationLayer<'riff-patterns'>;
  duration: number;
  /** Playhead in track seconds — drawn as the lane's cursor hairline, and
   *  read by the prominence editor's level buttons to place a breakpoint
   *  where you're listening. */
  currentTime?: number;
  focusedItemId?: string | null;
  /** Item whose edit popover is currently OPEN — gates the prominence editor.
   *  Distinct from `focusedItemId`, which lingers after the popover closes. */
  prominenceEditItemId?: string | null;
  /** Prominence (front/back) edits from the band's breakpoint editor. */
  onProminenceChange?: (itemId: string, points: ProminenceEnvelope | undefined) => void;
  /** Snap a prominence breakpoint onto the beat grid as it's dragged or
   *  placed. The page's own snap, so Snap to grid / Grid Lock govern it the
   *  same way they govern moving the instance itself. */
  snapProminenceTime?: (trackSeconds: number) => number;
  /** Fired by the instance's title bar, and by a click that lands on the tile
   *  background (the blank tail, or an unresolvable entry) rather than on a
   *  specific sequence block. */
  onItemClick?: (itemId: string, anchor: { x: number; y: number }) => void;
  /** Fired when a specific sequence block is clicked. `nodeId` is the
   *  concrete node the clicked leaf resolves to (null for silence, or when
   *  the entry is a combo and the click landed on its silence leaf) — the
   *  caller uses this to open that node's popup directly, or (when the entry
   *  is a combo wrapping the leaf) offer a choice between the node and the
   *  containing instance, rather than always falling back to the instance. */
  onEntryClick?: (itemId: string, entryIndex: number, nodeId: string | null, anchor: { x: number; y: number }) => void;
  /** Fired continuously while dragging a block's resize handle in STRETCH
   *  mode — the entry's own width changes and the node's content is squeezed
   *  or stretched across it. That's the alt-drag; see `onEntryTrimNode` for
   *  what a plain drag does. Also the only mode a combo/silence entry has. */
  onEntryResize?: (itemId: string, entryIndex: number, newLengthSteps: number, gestureKey?: string) => void;
  /** Fired continuously while dragging a bare node entry's resize handle
   *  WITHOUT alt — the trim: the node's own length changes (content past the
   *  new end is dropped) and every placement follows, so the blocks that
   *  survive stay exactly the size they're drawn at. See `trimRiffNodeLength`. */
  onEntryTrimNode?: (nodeId: string, lengthBeats: number, gestureKey?: string) => void;
  /** Body-drag callback. Move the whole riff pattern instance (and all its
   *  repeats) without changing the cycle length — start and end shift by the
   *  same delta. */
  onItemMove?: (itemId: string, newStart: number, newEnd: number) => void;
  onItemMoveStart?: (itemId: string) => void;
  gridProps?: LaneGridProps;
  pendingSelection?: PendingSelection | null;
  onSeek?: (time: number) => void;
  onRegion?: (t1: number, t2: number) => void;
  onRegionDragStart?: () => void;
}

function resolveEntryVisual(
  entry: RiffSeqEntry,
  nodes: RiffNode[],
  combos: RiffCombo[],
): { color: string; label: string } {
  const id = entry.type;
  if (id === RIFF_NODE_SILENCE_ID) return { color: 'transparent', label: '◌' };
  const node = nodes.find((n) => n.id === id);
  if (node) return { color: node.color, label: node.name[0]?.toUpperCase() ?? '?' };
  const combo = combos.find((c) => c.id === id);
  if (combo) return { color: combo.color ?? '#475569', label: `[${combo.name[0]?.toUpperCase() ?? '?'}]` };
  return { color: '#475569', label: '?' };
}

/** A leaf's on-screen share of its containing entry's own width — `fraction`
 *  is 0..1 and every returned array sums to 1. Built on the shared
 *  `flattenRiffEntry` (which just resolves node ids) so the canvas's visuals
 *  and its click routing (`nodeId`) always agree on what a combo expands to.
 *  `node` carries the resolved RiffNode (when the leaf is one) so the leaf
 *  can render that node's actual beat grid via `ChipStrip` instead of a flat
 *  color block. */
interface VisualLeaf { color: string; label: string; fraction: number; nodeId: string | null; node: RiffNode | null; }

function flattenEntryVisual(
  entry: RiffSeqEntry,
  nodes: RiffNode[],
  combos: RiffCombo[],
): VisualLeaf[] {
  return flattenRiffEntry(entry, nodes, combos).map((leaf) => {
    if (leaf.nodeId === null) return { color: 'transparent', label: '◌', fraction: leaf.fraction, nodeId: null, node: null };
    const node = nodes.find((n) => n.id === leaf.nodeId);
    if (!node) return { color: '#475569', label: '?', fraction: leaf.fraction, nodeId: leaf.nodeId, node: null };
    return { color: node.color, label: node.name[0]?.toUpperCase() ?? '?', fraction: leaf.fraction, nodeId: leaf.nodeId, node };
  });
}

export function RiffPatternLaneRow({
  layer, duration, currentTime,
  focusedItemId, prominenceEditItemId, onProminenceChange, snapProminenceTime,
  onItemClick, onEntryClick, onEntryResize, onEntryTrimNode,
  onItemMove, onItemMoveStart,
  gridProps,
  pendingSelection,
  onSeek, onRegion, onRegionDragStart,
}: RiffPatternLaneRowProps) {
  const nodes  = layer.nodes  ?? [];
  const combos = layer.combos ?? [];
  const items  = layer.items as RiffPatternItem[];
  const { laneById, laneCount } = useMemo(() => assignLanes(items), [items]);
  const lanesHeight = laneCount * INST_LANE_H + (laneCount - 1) * LANE_GAP_PX;
  // The prominence editor only claims vertical space while a popover is open.
  const prominenceTarget = useMemo(
    () => (onProminenceChange && prominenceEditItemId
      ? items.find((it) => it.id === prominenceEditItemId) ?? null
      : null),
    [onProminenceChange, prominenceEditItemId, items],
  );
  const rowHeight = lanesHeight + (prominenceTarget ? PROMINENCE_EDIT_TOTAL_H + 2 : 0);
  // Playhead, same white hairline every other lane row draws (Cue/Span/Loop/
  // Lead). Without it a riff row was the one place on the canvas where you
  // could not see which repeat you were listening to.
  const pct = duration > 0 ? Math.min(100, ((currentTime ?? 0) / duration) * 100) : 0;
  const containerRef = useRef<HTMLDivElement>(null);
  const durationRef = useRef(duration);
  durationRef.current = duration;

  const { startBodyMove, wasDraggedRef } = useBodyMoveDrag({
    containerRef,
    durationGetter: () => durationRef.current,
    onMoveStart: (id) => onItemMoveStart?.(id),
    onMove: (id, ns, ne) => onItemMove?.(id, ns, ne),
  });
  const moveEnabled = !!onItemMove;

  // Resize-drag state lives in a ref (not React state) — dragging fires its
  // callback directly on every pointermove and the new width is derived from
  // the (now-updated) props on next render, so no local preview state is
  // needed.
  //
  // Two modes, both driven from the same handle (see `startResize`):
  //  - `'node'` TRIMS. The default on an entry that IS a node: the node's own
  //    length moves, its tail is dropped, and every placement scales with it,
  //    so the blocks left over keep the size they're drawn at.
  //  - `'entry'` STRETCHES — the old behaviour, now alt-drag (and the only
  //    mode a combo/silence entry has, where "the node's length" means
  //    nothing): only this placement's slot changes, and the content inside
  //    is squeezed or spread to fill it.
  // Both measure from the gesture's start rather than the last frame, so a
  // long drag can't accumulate rounding drift.
  const dragRef = useRef<
    | { mode: 'entry'; key: string; itemId: string; entryIndex: number; startX: number; startLength: number; pxPerStep: number; pointerId: number | null }
    | { mode: 'node'; key: string; nodeId: string; startX: number; startLength: number; startBeats: number; pxPerStep: number; pointerId: number | null }
    | null
  >(null);

  // Pointer events so a finger can trim as well as a mouse; pointercancel
  // ends the gesture like pointerup (every step has already been applied
  // under the gesture's undo key, so there is nothing to roll back).
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || !isSamePointer(d.pointerId, e)) return;
      const deltaSteps = Math.round((e.clientX - d.startX) / d.pxPerStep);
      const nextLength = Math.max(1, d.startLength + deltaSteps);
      if (d.mode === 'node') onEntryTrimNode?.(d.nodeId, d.startBeats * (nextLength / d.startLength), d.key);
      else onEntryResize?.(d.itemId, d.entryIndex, nextLength, d.key);
    };
    const onUp = (e: PointerEvent) => {
      if (dragRef.current && !isSamePointer(dragRef.current.pointerId, e)) return;
      dragRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [onEntryResize, onEntryTrimNode]);

  function startResize(
    e: React.PointerEvent, itemId: string, entryIndex: number, startLength: number, cycleSteps: number,
    entryNode: RiffNode | null,
  ) {
    if (isSecondaryPointer(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const cycleEl = (e.currentTarget as HTMLElement).closest('[data-riff-cycle]') as HTMLElement | null;
    const cyclePx = cycleEl?.getBoundingClientRect().width || 1;
    const pxPerStep = cyclePx / Math.max(1, cycleSteps);
    const key = `riff-drag:${nextGestureId()}`;
    const pointerId = pointerIdOf(e);
    dragRef.current = entryNode && onEntryTrimNode && !e.altKey
      ? {
          mode: 'node', key, nodeId: entryNode.id, startX: e.clientX, startLength, pxPerStep,
          startBeats: Math.max(1e-6, riffNodeLengthBeats(entryNode)), pointerId,
        }
      : { mode: 'entry', key, itemId, entryIndex, startX: e.clientX, startLength, pxPerStep, pointerId };
  }

  return (
    <div
      ref={containerRef}
      // Same lane chrome as every other row (Cue/Lyrics/Pattern/Span/Loop/Lead):
      // a rounded gray-950 track. `overflow-visible` stays so the prominence
      // editor can spill past the row; the background still clips to the radius.
      className="relative w-full select-none overflow-visible rounded bg-gray-950"
      style={{ height: rowHeight }}
    >
      {gridProps && (
        <BeatGridOverlay {...gridProps} duration={duration} />
      )}

      {/* Behind the tiles (z="") — empty space falls through to seek / highlight-drag.
          Must mount BEFORE the instance tiles below so they stay on top and
          keep receiving their own clicks (see AnnotationOverlays.tsx doc comment). */}
      {onSeek && onRegion && (
        <RegionDragOverlay
          duration={duration}
          onVizClick={onSeek}
          onVizRegion={onRegion}
          onRegionDragStart={onRegionDragStart}
          z=""
        />
      )}

      {items.map((item) => {
        const cycleSec = Math.max(0.01, item.end - item.start);
        const reps  = Math.max(1, Math.floor(item.repeatCount));
        const left = duration > 0 ? (item.start / duration) * 100 : 0;
        const totalWidth = duration > 0 ? (cycleSec * reps / duration) * 100 : 0;
        const focused = focusedItemId === item.id;
        const cycleSteps = riffCycleSteps(cycleSec, gridProps?.bpm ?? 0);
        const seqTotalSteps = item.sequence.reduce((s, e) => s + e.lengthSteps, 0);
        const tailPct = Math.max(0, ((cycleSteps - seqTotalSteps) / cycleSteps) * 100);
        const top = (laneById.get(item.id) ?? 0) * (INST_LANE_H + LANE_GAP_PX);

        return (
          <div
            key={item.id}
            className="absolute flex flex-col"
            style={{ left: `${left}%`, width: `${totalWidth}%`, top, height: INST_LANE_H }}
          >
            {/* Title bar — spans every repeat, so it also reads as the bracket
                that groups them into one instance. Drag lives here rather than
                on rep 0's body, where it used to compete with block clicks. */}
            <div
              className={`flex items-center gap-1 px-1 overflow-hidden flex-shrink-0 rounded-t-sm transition-[filter] hover:brightness-125 ${moveEnabled ? 'cursor-grab active:cursor-grabbing touch-pan-y' : 'cursor-pointer'}`}
              style={{
                height: INST_HEADER_H,
                backgroundColor: layer.color,
                opacity: focused ? 1 : 0.85,
                boxShadow: focused ? `0 0 0 1px ${layer.color}` : 'none',
              }}
              title={[
                item.label || 'Instance',
                prominenceSummary(item.prominence),
                moveEnabled ? 'click to edit this instance · drag to move it' : 'click to edit this instance',
              ].filter(Boolean).join(' · ')}
              onPointerDown={(e) => {
                if (!moveEnabled) return;
                startBodyMove(item.id, item.start, item.end, e);
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (wasDraggedRef.current) {
                  wasDraggedRef.current = false;
                  return;
                }
                onItemClick?.(item.id, { x: e.clientX, y: e.clientY });
              }}
            >
              {moveEnabled && (
                <span className="text-[9px] leading-none text-white/80 flex-shrink-0" style={{ textShadow: '0 0 3px rgba(0,0,0,0.9)' }}>⠿</span>
              )}
              <span
                className="text-[9px] font-bold leading-none text-white truncate"
                style={{ textShadow: '0 0 3px rgba(0,0,0,0.9)' }}
              >
                {item.label || 'Instance'}
              </span>
              {reps > 1 && (
                <span
                  className="ml-auto text-[9px] font-bold leading-none text-white/90 flex-shrink-0"
                  style={{ textShadow: '0 0 3px rgba(0,0,0,0.9)' }}
                >
                  ×{reps}
                </span>
              )}
            </div>
            <div className="flex flex-1 min-h-0">
            {Array.from({ length: reps }).map((_, rep) => {
              // A riff cycle is already a dense tree of node blocks, so dim the
              // WHOLE cycle rather than filling inside it — one repetition is
              // the natural granularity for "this riff drops back here".
              const prom = prominenceAt(item.prominence, (rep + 0.5) * cycleSec);
              return (
              <div
                key={rep}
                data-riff-cycle
                className="flex items-stretch overflow-hidden flex-shrink-0 cursor-pointer"
                style={{
                  width: `${100 / reps}%`,
                  height: '100%',
                  backgroundColor: `${layer.color}22`,
                  borderLeft:   rep === 0       ? `2px solid ${layer.color}` : `1px solid ${layer.color}60`,
                  borderRight:  rep === reps - 1 ? `1px solid ${layer.color}60` : 'none',
                  borderTop:    `1px solid ${layer.color}40`,
                  borderBottom: `1px solid ${layer.color}40`,
                  opacity:  (focused ? 1 : 0.8) * (prom ? 0.3 + prom.weight * 0.7 : 1),
                  boxShadow: focused ? `0 0 0 1px ${layer.color}80` : 'none',
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (wasDraggedRef.current) {
                    wasDraggedRef.current = false;
                    return;
                  }
                  onItemClick?.(item.id, { x: e.clientX, y: e.clientY });
                }}
              >
                {item.sequence.map((entry, i) => {
                  const { label: entryLabel } = resolveEntryVisual(entry, nodes, combos);
                  const widthPct = cycleSteps > 0 ? (entry.lengthSteps / cycleSteps) * 100 : 0;
                  const leaves = flattenEntryVisual(entry, nodes, combos);
                  // A bare node entry — the case where dragging this edge can
                  // mean "make the node itself shorter" rather than only
                  // "make this slot narrower". Null for combos and silence.
                  const entryNode = nodes.find((n) => n.id === entry.type) ?? null;
                  return (
                    <div
                      key={i}
                      className="relative h-full flex-shrink-0 overflow-hidden flex items-stretch"
                      style={{ width: `${widthPct}%` }}
                      title={entryLabel}
                    >
                      {leaves.map((leaf, li) => {
                        const isSilence = leaf.color === 'transparent';
                        return (
                          <div
                            key={li}
                            // A block is a button in all but name: hovering
                            // lifts it so the click target under the cursor is
                            // never in doubt.
                            className="h-full flex-shrink-0 overflow-hidden flex items-center justify-center cursor-pointer hover:brightness-150 hover:ring-1 hover:ring-inset hover:ring-white/80"
                            style={isSilence ? {
                              width: `${leaf.fraction * 100}%`,
                              // A fully transparent fill let the dark canvas
                              // show through and read as an empty gap rather
                              // than a rendered "rest" — a visible hatch marks
                              // it as intentional silence instead.
                              backgroundImage: 'repeating-linear-gradient(135deg, rgba(148,163,184,0.22) 0 2px, transparent 2px 5px)',
                              backgroundColor: 'rgba(148,163,184,0.06)',
                              border: '1px dashed rgba(148,163,184,0.6)',
                            } : {
                              width: `${leaf.fraction * 100}%`,
                              // Dim fill behind the node's own beat grid (see
                              // ChipStrip below) — same "faint background,
                              // bright on-steps" treatment a plain Pattern
                              // tile uses, so a node reads as its actual
                              // rhythm instead of one opaque color block.
                              backgroundColor: leaf.node ? `${leaf.color}33` : leaf.color,
                              border: '1px solid rgba(0,0,0,0.35)',
                            }}
                            title={leaf.node
                              ? isBoundaryNode(leaf.node)
                                ? `${leaf.label} — ${(leaf.node.segments ?? []).filter((s) => s.kind === 'tick').length} blocks · click to edit this node`
                                : `${leaf.label} — ${leaf.node.highlightedBeats.length}/${leaf.node.stepsPerCycle} beats · click to edit this node`
                              : isSilence
                                ? 'silence — click to edit this instance’s sequence'
                                : `${leaf.label} — click to edit this instance’s sequence`}
                            onClick={(e) => { e.stopPropagation(); onEntryClick?.(item.id, i, leaf.nodeId, { x: e.clientX, y: e.clientY }); }}
                          >
                            {leaf.node ? (
                              // Boundary nodes carry no sub-beat grid to draw,
                              // so they render their blocks directly instead.
                              isBoundaryNode(leaf.node) ? (
                                <BoundaryStrip
                                  color={leaf.color}
                                  segments={leaf.node.segments ?? []}
                                  lengthBeats={riffNodeLengthBeats(leaf.node)}
                                />
                              ) : (
                                <ChipStrip
                                  color={leaf.color}
                                  steps={leaf.node.stepsPerCycle}
                                  highlighted={leaf.node.highlightedBeats}
                                  spans={leaf.node.spans ?? []}
                                  accents={leaf.node.accents}
                                  label=""
                                />
                              )
                            ) : (
                              <span
                                className="text-[9px] font-bold text-white truncate leading-none px-0.5"
                                style={{ textShadow: '0 0 3px rgba(0,0,0,0.8)' }}
                              >
                                {leaf.label}
                              </span>
                            )}
                          </div>
                        );
                      })}
                      {(onEntryResize || (entryNode && onEntryTrimNode)) && (
                        // On a phone the grip widens to 14px rather than
                        // taking `.tc-hit`: the entry is overflow-hidden, so
                        // that ::before could only reach inward, and on an
                        // entry under 14px it swallowed the blocks — the
                        // instance could be resized but no longer moved. The
                        // 30% cap (touch only; a mouse keeps its 4px grip)
                        // always leaves the entry's blocks to grab.
                        <span
                          role="separator"
                          aria-label={entryNode && onEntryTrimNode
                            ? 'Drag to trim this node · alt-drag to stretch this placement'
                            : 'Drag to resize this entry'}
                          title={entryNode && onEntryTrimNode
                            ? 'Drag to trim this node — what’s past the new end is dropped and every placement shrinks with it, so the rest keeps its size. Alt-drag stretches just this placement instead. ⌘Z undoes either.'
                            : 'Drag to resize this entry'}
                          className="absolute top-0 bottom-0 right-0 w-1 pointer-coarse:w-3.5 pointer-coarse:max-w-[30%] cursor-ew-resize hover:bg-white/40 touch-none"
                          onPointerDown={(e) => startResize(e, item.id, i, entry.lengthSteps, cycleSteps, entryNode)}
                        />
                      )}
                    </div>
                  );
                })}
                {tailPct > 0 && (
                  <div
                    className="h-full flex-shrink-0 flex items-center justify-center border border-dashed border-slate-600/60"
                    style={{ width: `${tailPct}%` }}
                    title="empty — the sequence doesn't fill this cycle. Set the song's BPM and the cycle trims itself to the sequence."
                  >
                    <span className="text-[7px] text-slate-500">·</span>
                  </div>
                )}
                {item.sequence.length === 0 && tailPct <= 0 && (
                  <span className="text-[8px] text-slate-600 italic px-1">—</span>
                )}
              </div>
              );
            })}
            </div>
          </div>
        );
      })}

      {prominenceTarget && onProminenceChange && (
        <ProminenceStrip
          points={prominenceTarget.prominence}
          currentTime={currentTime}
          start={prominenceTarget.start}
          end={prominenceTarget.start
            + Math.max(1, Math.floor(prominenceTarget.repeatCount)) * Math.max(0.01, prominenceTarget.end - prominenceTarget.start)}
          duration={duration}
          containerRef={containerRef}
          color={layer.color}
          top={lanesHeight}
          snapTime={snapProminenceTime}
          onChange={(next) => onProminenceChange(prominenceTarget.id, next)}
          onDragStart={() => onItemMoveStart?.(prominenceTarget.id)}
        />
      )}

      <div
        className="absolute top-0 bottom-0 w-px pointer-events-none z-10"
        style={{ left: `${pct}%`, background: 'rgba(255,255,255,0.75)' }}
      />

      {pendingSelection && (
        <PendingHighlightOverlay
          sel={pendingSelection}
          duration={duration}
          grid={gridProps}
        />
      )}
    </div>
  );
}
