/**
 * RiffGrooveLaneRow — a riff-patterns layer, drawn as the groove lane draws.
 *
 * One renderer for every repeated figure (see riffGrooves.ts): each cell the
 * figure as played, a play that differed from its node drawn over it in grey,
 * every play at its node's full colour, the runs lettered, and a click opens the groove card.
 * What a lane of your own adds on top of the detector's:
 *
 *   * The card's bar row is clickable — a hit to remove it, an empty step to
 *     add one — and says what the change applies to: every bar that plays the
 *     node (the default: a node means "these bars are the same"), or only this
 *     bar, which records the change as that play's occurrence and leaves the
 *     node as it is.
 *   * The card opens the node's own editor (pitch, pulse, length) and the
 *     instance's (repeats, prominence).
 *   * Dragging a cell moves its whole run — every instance the lane letters
 *     as one (A ×3, A ×7 …) and every repeat of each — as one block.
 *   * While the instance's editor is open its cells are outlined, and its
 *     prominence editor sits under the lane.
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { computeRiffDuplicates, type AnnotationLayer, type ProminenceEnvelope, type RiffPatternItem } from '../../types/annotationLayer';
import { formatClockTime } from '../../utils/clockTime';
import { useBodyMoveDrag } from '../../hooks/useTimelineDrag';
import { ProminenceStrip, PROMINENCE_EDIT_TOTAL_H } from './shared/ProminenceLane';
import type { LaneGridProps } from './BeatGridOverlay';
import type { PendingSelection } from './AnnotationOverlays';
import { CardTitle, GROOVE_LANE_H, GrooveLaneRow, type LaneSpan } from './GrooveLaneRow';
import { riffGrooveLane, type RiffCellRef } from './riffGrooves';
import { RIFF_EDITOR_H, RiffLaneEditor, type RiffLayerEdit } from './RiffLaneEditor';
import { riffRuns } from './riffLaneEdit';

/** The title bar over each instance on a lane of your own, px per stacked lane. */
const TITLE_H = 16;

export interface RiffItemMove { id: string; start: number; end: number }

/** Bars the card lists by number before "and N more". */
const MAX_LISTED_BARS = 6;

interface RiffGrooveLaneRowProps {
  layer: AnnotationLayer<'riff-patterns'>;
  duration: number;
  visualize?: boolean;
  /** The instance whose editor was last opened: its cells are outlined. */
  focusedItemId?: string | null;
  /** The instance whose editor is open now: its prominence editor shows. */
  prominenceEditItemId?: string | null;
  onProminenceChange?: (itemId: string, points: ProminenceEnvelope | undefined) => void;
  snapProminenceTime?: (trackSeconds: number) => number;
  /** Opens the instance's editor. */
  onItemClick?: (itemId: string, anchor: { x: number; y: number }) => void;
  /** Opens the editor of the node a cell plays (or, for a combo's leaf, the
   *  instance's, open at that entry). */
  onEntryClick?: (itemId: string, entryIndex: number, nodeId: string | null, anchor: { x: number; y: number }) => void;
  /** A run dragged: every instance in it, each at its new start and end. */
  onItemsMove?: (moves: RiffItemMove[]) => void;
  onItemMoveStart?: (itemId: string) => void;
  /** A step of a node toggled, for every bar that plays it. */
  onNodeStepToggle?: (nodeId: string, step: number) => void;
  /** A step toggled on this bar alone: an occurrence of its node. */
  onBarStepSplit?: (ref: RiffCellRef, step: number) => void;
  gridProps?: LaneGridProps;
  pendingSelection?: PendingSelection | null;
  onSeek?: (time: number) => void;
  onRegion?: (t1: number, t2: number) => void;
  onRegionDragStart?: () => void;
  /** The groove card's ▶: play a span of the song, and stop it. */
  onPlay?: (start: number, end: number) => void;
  onStop?: () => void;
  isPlaying?: boolean;
  /** A lane of your own: a drag over empty space starts a riff there. */
  onCreate?: (t1: number, t2: number) => void;
  createSnap?: (t: number) => number;
  /** The instance being built on the lane, when it is this lane's. */
  editor?: { itemId: string; draft: boolean } | null;
  onLayerEdit?: (edit: RiffLayerEdit, opts?: { coalesceKey?: string }) => void;
  onNodeCreated?: (nodeId: string) => void;
  onEditorDone?: () => void;
  onEditorDiscard?: () => void;
  /** The card's Edit instance: build it on the lane. */
  onEditOnLane?: (itemId: string) => void;
}

export function RiffGrooveLaneRow({
  layer, duration, visualize, focusedItemId, prominenceEditItemId, onProminenceChange, snapProminenceTime,
  onItemClick, onEntryClick, onItemsMove, onItemMoveStart, onNodeStepToggle, onBarStepSplit,
  gridProps, pendingSelection, onSeek, onRegion, onRegionDragStart, onPlay, onStop, isPlaying,
  onCreate, createSnap, editor, onLayerEdit, onNodeCreated, onEditorDone, onEditorDiscard, onEditOnLane,
}: RiffGrooveLaneRowProps) {
  const { model, refs, laneCount } = useMemo(() => riffGrooveLane(layer, gridProps), [layer, gridProps]);
  const items = layer.items as RiffPatternItem[];
  const editable = !layer.readOnly;
  const allSpans = useMemo(() => phraseSpans(items, refs, model.bars.map((b) => b.lane ?? 0), model.bars.map((b) => b.lanes), layer.color),
    [items, refs, model.bars, layer.color]);
  const [scope, setScope] = useState<'node' | 'bar'>('node');

  const containerRef = useRef<HTMLDivElement>(null);
  const durationRef = useRef(duration);
  useLayoutEffect(() => { durationRef.current = duration; }, [duration]);
  // The run being dragged, as it stood when the drag began: the drag moves
  // the run's first start, and every instance keeps its offset from it.
  const runDragRef = useRef<RiffItemMove[]>([]);
  const { startBodyMove, wasDraggedRef } = useBodyMoveDrag({
    containerRef,
    durationGetter: () => durationRef.current,
    onMoveStart: (id) => onItemMoveStart?.(id),
    onMove: (_id, ns) => {
      const run = runDragRef.current;
      if (!run.length) return;
      const shift = ns - run[0].start;
      onItemsMove?.(run.map((m) => ({ id: m.id, start: m.start + shift, end: m.end + shift })));
    },
  });

  const editing = editor && onLayerEdit && gridProps?.bpm && items.some((it) => it.id === editor.itemId) ? editor : null;
  const prominenceTarget = !editing && onProminenceChange && prominenceEditItemId
    ? items.find((it) => it.id === prominenceEditItemId) ?? null
    : null;
  const lanesHeight = GROOVE_LANE_H * laneCount;
  // On a lane of your own each instance wears a thin title bar over all of
  // its passes: click it to edit the instance on the lane; click a cell under
  // it to edit the node that cell plays.
  const showTitles = editable && !!onEditOnLane;
  const headerHeight = showTitles ? TITLE_H * laneCount : 0;
  const titles = useMemo(() => {
    if (!showTitles) return [];
    const nameOf = new Map((layer.nodes ?? []).map((n) => [n.id, n.name]));
    const dup = computeRiffDuplicates(items);
    const byId = new Map(items.map((it) => [it.id, it]));
    return items.flatMap((it) => {
      const cell = refs.findIndex((r) => r.itemId === it.id);
      // An instance with nothing to draw gets no title either (it is removed
      // on the next pass — see withoutDanglingRiffInstances).
      if (cell < 0) return [];
      const reps = Math.max(1, Math.floor(it.repeatCount));
      const seq = riffRuns(it.sequence)
        .map((r) => (nameOf.get(r.type) ?? '◌') + (r.count > 1 ? `×${r.count}` : ''))
        .join(' ');
      return [{
        id: it.id,
        lane: cell >= 0 ? model.bars[cell].lane ?? 0 : 0,
        lanes: cell >= 0 ? model.bars[cell].lanes ?? laneCount : laneCount,
        start: it.start,
        end: it.start + reps * Math.max(0.01, it.end - it.start),
        name: it.label || 'riff',
        seq: `${seq}${reps > 1 ? `  ×${reps}` : ''}`,
        // What the phrase bracket said on a detector's lane: the same riff
        // heard earlier in the song.
        again: byId.has(dup.get(it.id) ?? '') ? `as at ${formatClockTime(byId.get(dup.get(it.id)!)!.start, 0)}` : '',
      }];
    });
  }, [showTitles, items, refs, model.bars, layer.nodes, laneCount]);
  // While an instance is open in the editor, the editor draws it: its cells,
  // title and bracket step aside so it is never on screen twice, and come
  // back on Done / Close. The editor sits where the lanes are (the cells it
  // hides are under it) and only grows the row by what it needs beyond them.
  const editedId = editing?.itemId ?? null;
  const spans = useMemo(() => {
    // The title bar names every instance on a lane of your own; a bracket
    // under it would say the same thing twice.
    if (showTitles) return [];
    if (!editedId) return allSpans;
    const it = items.find((x) => x.id === editedId);
    return it ? allSpans.filter((sp) => Math.abs(sp.start - it.start) > 1e-6) : allSpans;
  }, [allSpans, editedId, items, showTitles]);
  const belowTop = editing ? headerHeight : headerHeight + lanesHeight;

  const barsPlaying = (nodeId: string | null): number[] => [...new Set(
    model.bars.filter((_, j) => refs[j].nodeId === nodeId).map((b) => b.bar),
  )];

  const cardFooter = (index: number) => {
    const ref = refs[index];
    if (!ref) return null;
    const node = (layer.nodes ?? []).find((n) => n.id === ref.nodeId);
    const anchorOf = (e: React.MouseEvent) => ({ x: e.clientX, y: e.clientY });
    const btn = 'h-8 px-3 rounded border border-gray-600 text-[12px] text-gray-200 hover:border-emerald-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400';
    const buttons = (
      <div className="flex gap-1.5">
        {node && onEntryClick && (
          <button
            type="button"
            className={btn}
            title={`Edit node “${node.name}”: pitch, pulse and length`}
            onClick={(e) => { e.stopPropagation(); onEntryClick(ref.itemId, ref.entryIndex, ref.nodeId, anchorOf(e)); }}
          >
            Edit node
          </button>
        )}
        {(onEditOnLane || onItemClick) && (
          <button
            type="button"
            className={btn}
            title={onEditOnLane
              ? 'Edit instance on the lane: its nodes, notes, name and repeats'
              : 'Edit instance: sequence, repeat count, prominence and ★'}
            onClick={(e) => {
              e.stopPropagation();
              if (onEditOnLane) onEditOnLane(ref.itemId);
              else onItemClick?.(ref.itemId, anchorOf(e));
            }}
          >
            Edit instance
          </button>
        )}
      </div>
    );
    if (!editable || !node) return <div className="mb-3">{buttons}</div>;
    const playing = barsPlaying(node.id);
    const listed = playing.slice(0, MAX_LISTED_BARS).join(', ')
      + (playing.length > MAX_LISTED_BARS ? ` and ${playing.length - MAX_LISTED_BARS} more` : '');
    const bar = model.bars[index].bar;
    const splitBlocked = ref.inCombo
      ? 'Not here: it is part of a combo, which every placement shares — edit the combo instead'
      : null;
    const perBar = scope === 'bar' && !splitBlocked;
    const seg = (on: boolean) => `flex-1 h-8 px-2 text-[12px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400 ${
      on ? 'bg-emerald-500/20 text-emerald-200' : 'text-gray-300 hover:bg-white/5'}`;
    return (
      <div className="mb-3 flex flex-col gap-1.5">
        <div className="-mb-1.5"><CardTitle>Apply edits to</CardTitle></div>
        <div role="radiogroup" aria-label="A change applies to" className="flex rounded border border-gray-600 overflow-hidden">
          <button
            type="button" role="radio" aria-checked={!perBar} className={seg(!perBar)}
            title={`A change applies to every bar that plays ${node.name}: ${playing.length === 1 ? 'bar' : 'bars'} ${listed}`}
            onClick={(e) => { e.stopPropagation(); setScope('node'); }}
          >
            All {node.name}
          </button>
          <button
            type="button" role="radio" aria-checked={perBar} disabled={!!splitBlocked}
            className={`${seg(perBar)} border-l border-gray-600 disabled:opacity-40 disabled:cursor-not-allowed`}
            title={splitBlocked ?? `A change applies to bar ${bar} only — it stays ${node.name}, played differently this once`}
            onClick={(e) => { e.stopPropagation(); setScope('bar'); }}
          >
            Bar {bar} only
          </button>
        </div>
        {buttons}
      </div>
    );
  };

  const onCardStepClick = editable && (onNodeStepToggle || onBarStepSplit)
    ? (index: number, step: number) => {
        const ref = refs[index];
        if (!ref?.nodeId) return;
        if (scope === 'bar' && !ref.inCombo && onBarStepSplit) onBarStepSplit(ref, step);
        else onNodeStepToggle?.(ref.nodeId, step);
      }
    : undefined;

  return (
    <GrooveLaneRow
      laneId={`riff:${layer.id}`}
      model={model}
      visualize={visualize}
      duration={duration}
      gridProps={gridProps}
      pendingSelection={pendingSelection}
      onSeek={onSeek}
      onRegion={onRegion}
      onRegionDragStart={onRegionDragStart}
      onCreate={editable ? onCreate : undefined}
      createColor={layer.color}
      createSnap={createSnap}
      laneCount={laneCount}
      containerRef={containerRef}
      isFocused={editing ? (i) => refs[i]?.itemId === editing.itemId
        : focusedItemId ? (i) => refs[i]?.itemId === focusedItemId : undefined}
      onCellPointerDown={editable && onItemsMove ? (i, e) => {
        const run = model.bars[i]?.run;
        const ids = new Set(refs.filter((_, j) => model.bars[j].run === run).map((r) => r.itemId));
        const members = items.filter((it) => ids.has(it.id)).sort((a, b) => a.start - b.start);
        if (!members.length) return;
        runDragRef.current = members.map((it) => ({ id: it.id, start: it.start, end: it.end }));
        // The whole run, every repeat of its last instance included, so the
        // drag stops where the run's end meets the song's.
        const runEnd = Math.max(...members.map((it) =>
          it.start + Math.max(0.01, it.end - it.start) * Math.max(1, Math.floor(it.repeatCount))));
        startBodyMove(members[0].id, members[0].start, runEnd, e);
      } : undefined}
      consumeDrag={() => {
        if (!wasDraggedRef.current) return false;
        wasDraggedRef.current = false;
        return true;
      }}
      onCardStepClick={onCardStepClick}
      cardFooter={cardFooter}
      onPlay={onPlay}
      onStop={onStop}
      isPlaying={isPlaying}
      spans={spans}
      headerHeight={headerHeight}
      hideCell={editedId ? (i) => refs[i]?.itemId === editedId : undefined}
      header={showTitles && duration > 0 ? titles.filter((t) => t.id !== editedId).map((t) => {
        const open = editing?.itemId === t.id;
        return (
          <button
            key={t.id}
            type="button"
            data-riff-title
            onClick={(e) => { e.stopPropagation(); onEditOnLane!(t.id); }}
            title={`Edit “${t.name}” on the lane — its nodes, notes, name and repeats`}
            className="absolute z-[6] flex items-center gap-1.5 px-1.5 rounded-t-sm text-[10px] leading-none whitespace-nowrap overflow-hidden text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400"
            style={{
              top: t.lane * (headerHeight / t.lanes) + 1,
              height: headerHeight / t.lanes - 2,
              left: `${(t.start / duration) * 100}%`,
              width: `${((t.end - t.start) / duration) * 100}%`,
              minWidth: 12,
              background: open ? layer.color : `${layer.color}40`,
              color: open ? '#030712' : '#f1f5f9',
              boxShadow: `inset 0 -1px 0 ${layer.color}`,
            }}
          >
            <span className="font-semibold">{t.name}</span>
            <span className="opacity-75 font-mono">{t.seq}</span>
            {t.again && <span className="opacity-60">· {t.again}</span>}
          </button>
        );
      }) : null}
      onCellOpen={editable && onEntryClick ? (i, anchor) => {
        const ref = refs[i];
        if (!ref) return;
        if (ref.nodeId) onEntryClick(ref.itemId, ref.entryIndex, ref.nodeId, anchor);
        else onEditOnLane?.(ref.itemId);
      } : undefined}
      belowHeight={editing ? Math.max(0, RIFF_EDITOR_H - lanesHeight) : prominenceTarget ? PROMINENCE_EDIT_TOTAL_H + 2 : 0}
      below={editing ? (
        <RiffLaneEditor
          layer={layer}
          itemId={editing.itemId}
          duration={duration}
          bpm={gridProps!.bpm!}
          containerRef={containerRef}
          top={belowTop}
          draft={editing.draft}
          onEdit={onLayerEdit!}
          onNodeCreated={onNodeCreated}
          onDone={() => onEditorDone?.()}
          onDiscard={() => onEditorDiscard?.()}
        />
      ) : prominenceTarget && onProminenceChange ? (
        <ProminenceStrip
          points={prominenceTarget.prominence}
          start={prominenceTarget.start}
          end={prominenceTarget.start
            + Math.max(1, Math.floor(prominenceTarget.repeatCount)) * Math.max(0.01, prominenceTarget.end - prominenceTarget.start)}
          duration={duration}
          containerRef={containerRef}
          color={layer.color}
          top={belowTop}
          snapTime={snapProminenceTime}
          onChange={(next) => onProminenceChange(prominenceTarget.id, next)}
          onDragStart={() => onItemMoveStart?.(prominenceTarget.id)}
        />
      ) : null}
    />
  );
}

/** Each instance that plays several nodes in order, as one bracketed span:
 *  named for what it plays, its repeats, and — when an earlier instance
 *  plays the very same — where that one is. */
function phraseSpans(
  items: readonly RiffPatternItem[],
  refs: readonly RiffCellRef[],
  laneOf: readonly number[],
  lanesOf: readonly (number | undefined)[],
  color: string,
): LaneSpan[] {
  const dup = computeRiffDuplicates(items);
  const byId = new Map(items.map((it) => [it.id, it]));
  return items.filter((it) => it.sequence.length > 1).map((it) => {
    const reps = Math.max(1, Math.floor(it.repeatCount));
    const cell = refs.findIndex((r) => r.itemId === it.id);
    const first = byId.get(dup.get(it.id) ?? '');
    const name = `${it.label || 'Phrase'}${reps > 1 ? ` ×${reps}` : ''}`;
    const again = first ? ` · as at ${formatClockTime(first.start, 0)}` : '';
    return {
      start: it.start,
      end: it.start + reps * Math.max(0.01, it.end - it.start),
      lane: cell >= 0 ? laneOf[cell] : 0,
      lanes: cell >= 0 ? lanesOf[cell] : undefined,
      label: `${name}${again}`,
      title: `One instance: ${name}${first ? `, the same as the one at ${formatClockTime(first.start, 0)}` : ''}`,
      color,
    };
  });
}
