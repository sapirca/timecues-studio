/**
 * Floating edit popover for a single Riff Pattern instance — the only
 * riff-pattern object with real timeline semantics (a placed [start, end]
 * region, tiled `repeatCount` times). Combos are timeless library primitives
 * with no start/end of their own, so they're edited *inside* this popover
 * (expand a sequence chip to reach its nested sequence). Nodes get the same
 * expand toggle to peek at their own beat grid inline, plus a ✎ button that
 * opens the full floating card (`NodeEditPopover`, owned at the page level)
 * for rename/color/etc.
 *
 * Thin adapter over the shared AnnotationPointCard, same pattern as
 * PatternEditPopover — the repeats spinner leads the card in the always-
 * visible `extras` slot, and the sequence builder + prominence editor are
 * foldable `sections`.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type {
  AnnotationLayer, RiffCombo, RiffNode, RiffPatternItem, RiffSeqEntry,
} from '../../types/annotationLayer';
import {
  boundarySegmentsFromTaps,
  computeRiffSeqPlayback, defaultRiffEntryLength, isBoundaryNode, newRiffSeqEntry,
  riffEntryOccurrenceAtPath, riffLeafPath, riffNodeLengthBeats,
} from '../../types/annotationLayer';
import { BoundarySegmentEditor } from './BoundarySegmentEditor';
import {
  BeatChipPicker, TapAlongControls, TapAlongPianoRoll, TapRefineControls,
  useBoundaryTapRefine, useTapAlong,
} from './BeatChipControls';
import {
  AddToSeqMenu, NodeLengthControl, reachableCombos, resolveId, SeqChip,
} from './RiffPatternEditorPanel';
import { AnnotationPointCard, cardTheme, forwardCardPatch } from './shared/AnnotationPointCard';
import { RepeatsRow, useRepeatsDraft } from './shared/RepeatsRow';
import { useAnnotationPopover, type PopoverAnchor } from './shared/useAnnotationPopover';
import { prominenceSection } from './shared/ProminenceControl';

export type RiffPatternAnchor = PopoverAnchor;

export function useRiffPatternEditPopover() {
  return useAnnotationPopover({ width: 380, height: 420 });
}

interface RiffPatternEditPopoverProps {
  layer: AnnotationLayer<'riff-patterns'>;
  item: RiffPatternItem;
  beatsPerBar: number;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  positionStyle: CSSProperties;
  onChange: (patch: Partial<RiffPatternItem>) => void;
  onDelete: () => void;
  onClose: () => void;
  /** Registers a check the owning `useAnnotationPopover` runs before ANY
   *  close path (Done/×, outside click, Escape) actually closes — lets this
   *  card veto/confirm a close while a nested node's Tap Along session holds
   *  unsaved taps. Pass `null` to clear. */
  registerCloseGuard: (guard: (() => boolean) | null) => void;
  onPatchCombo: (comboId: string, patch: Partial<RiffCombo>) => void;
  onPatchNode: (nodeId: string, patch: Partial<RiffNode>) => void;
  /** Sets a node's length as a TRIM (`trimRiffNodeLength`) — separate from
   *  `onPatchNode` because it rewrites the layer's placements too, which a
   *  node patch can't reach. */
  onTrimNode: (nodeId: string, lengthBeats: number) => void;
  /** Creates a fresh node/combo in the layer and returns its id. */
  onCreateNode: () => string;
  onCreateCombo: () => string;
  onPlay?: () => void;
  onStop?: () => void;
  /** Seeks the main player to `time` (or `stopTime` when given) and plays
   *  through it — same primitive `NodeEditPopover`'s own `onPlay` is built
   *  on. Used to give a nested node's Tap Along a tight loop around just
   *  its own turn in the sequence (see `riffEntryOccurrenceAtPath`) instead
   *  of replaying the whole instance on every pass. */
  onSeekAndPlay?: (time: number, stopTime?: number) => void;
  isPlaying?: boolean;
  bpm?: number;
  gridOffset?: number;
  /** Resolved grid segments — keeps the bar.beat readout in step with a
   *  split grid, where each segment counts in its own meter from its own bar 1. */
  segments?: readonly import('../../utils/gridSegments').ResolvedSegment[];
  currentTime?: number;
  /** Pre-expand this sequence-entry index on open — set when the popover was
   *  opened by clicking a specific block on the canvas rather than the tile
   *  background. Only meaningful for a combo entry (a node entry opens its
   *  own edit popup instead of expanding in-place). */
  initialExpandedIndex?: number | null;
  /** Opens the given node's floating edit popup (owned at the page level). */
  onEditNode: (nodeId: string, e: React.MouseEvent) => void;
}

/** One row in the sequence tree — a chip plus the same expand toggle for
 *  both entry kinds: a combo recurses into its OWN nested sequence, a node
 *  reveals its own beat grid inline (an adjacent ✎ button still opens the
 *  full floating popup via `onEditNode` for rename/color/etc). Renders
 *  itself again for every nested combo, at any depth, indenting each level
 *  behind a connector line so the whole node/combo hierarchy reads as one
 *  tree — not just a single level of "peek inside" — down to every node,
 *  each shown with its own karaoke beat grid. Expand state lives in the
 *  parent (`RiffPatternEditPopover`) keyed by dot-separated path (e.g.
 *  "0.2.1", one index per nesting level) so a canvas block click, or the
 *  live playhead, can pre-expand one specific branch without disturbing
 *  sibling branches elsewhere in the tree. */
function SeqTreeRow({
  entry, path, nodes, combos, forbiddenFor,
  expandedPaths, onToggleExpand, onRemove,
  onPatchCombo, onPatchNode, onTrimNode, onCreateNode, onCreateCombo, onEditNode,
  activePath, nodePlayheadStep, isPlaying, onPlay, onStop, onTapActiveChange,
  item, bpm, onSeekAndPlay,
}: {
  entry: RiffSeqEntry;
  /** Dot-separated index path from the root sequence down to this row, e.g. "0.2". */
  path: string;
  nodes: RiffNode[]; combos: RiffCombo[];
  /** Combo ids `entry.type` may not add (cycle prevention), keyed by combo id. */
  forbiddenFor: (comboId: string) => Set<string>;
  expandedPaths: Set<string>;
  onToggleExpand: (path: string) => void;
  onRemove: () => void;
  onPatchCombo: (comboId: string, patch: Partial<RiffCombo>) => void;
  onPatchNode: (nodeId: string, patch: Partial<RiffNode>) => void;
  onTrimNode: (nodeId: string, lengthBeats: number) => void;
  onCreateNode: () => string;
  onCreateCombo: () => string;
  onEditNode: (nodeId: string, e: React.MouseEvent) => void;
  /** Full index path of the leaf the live playhead is currently sounding, or
   *  null when not playing. Every row along this path — ancestor combos and
   *  the leaf alike — gets the karaoke glow; only the leaf itself (when it's
   *  a node) sweeps its `BeatChipPicker` via `nodePlayheadStep`. */
  activePath: number[] | null;
  nodePlayheadStep: number | null;
  /** True while the instance's real audio is playing anywhere within the
   *  instance's own region — a looser window than any one node's own turn,
   *  used (together with `onSeekAndPlay`) to derive this row's own tight
   *  Tap Along playing/onPlay below; also still passed through to the
   *  footer's play/stop button visibility. */
  isPlaying?: boolean;
  /** Plays the whole instance from the top — used by the footer's own
   *  play/stop button and passed through to nested rows; a node row's own
   *  Tap Along uses `onSeekAndPlay` + its own occurrence instead (see
   *  below), not this. */
  onPlay?: () => void;
  /** Pauses the instance's real playback — used by Tap Along's Stop/Cancel to
   *  actually halt the loop rather than waiting for the current pass to run
   *  out on its own. */
  onStop?: () => void;
  /** Reports this row's own Tap Along session leaving/re-entering idle, keyed
   *  by its tree path — the popover-level parent aggregates these across every
   *  row (a session can be live on any node, at any nesting depth) so it can
   *  hide the instance-level play/stop button while one is active. See the
   *  same note on `useTapAlong`'s `onPhaseChange`. `commit` saves that
   *  session's taps into its node: the parent calls it on close, so closing
   *  the card keeps a take rather than dropping it (same rule as
   *  NodeEditPopover). */
  onTapActiveChange?: (path: string, active: boolean, commit?: () => void) => void;
  /** The instance this tree belongs to — needed (with `path`) to resolve a
   *  node row's own tight occurrence via `riffEntryOccurrenceAtPath`. */
  item: RiffPatternItem;
  bpm?: number;
  /** Seeks + plays an arbitrary [time, stopTime) span — see the prop of the
   *  same name on `RiffPatternEditPopover`. */
  onSeekAndPlay?: (time: number, stopTime?: number) => void;
}) {
  const [nestedMenuOpen, setNestedMenuOpen] = useState(false);
  const id = entry.type;
  const resolved = resolveId(id, nodes, combos);

  const pathIndices = path.split('.').map(Number);
  const onActivePath = activePath != null
    && pathIndices.length <= activePath.length
    && pathIndices.every((v, i) => activePath[i] === v);
  const isActiveLeaf = onActivePath && pathIndices.length === activePath!.length;
  const expanded = expandedPaths.has(path);

  // Computed (and `useTapAlong` called) before the `!resolved` early return
  // below so hook order stays stable across renders regardless of what this
  // entry resolves to — a combo/silence row just never uses it.
  const nodeItem = resolved?.kind === 'node' ? resolved.item : null;
  // This row's own tight [start, end) within the instance — not the whole
  // instance's region — so its Tap Along loops around just this node's own
  // turn (count-in, one short pass, count-in again…) exactly like the
  // standalone Node popup, instead of replaying the entire sequence (every
  // other entry, every repeat) on every single pass. Resolved by tree
  // position (`pathIndices`), not by node id, so a node used more than once
  // in the same sequence loops the occurrence the user actually expanded.
  const nodeOccurrence = nodeItem && bpm
    ? riffEntryOccurrenceAtPath(item, pathIndices, combos, bpm)
    : null;
  const tapOnPlay = nodeOccurrence
    ? (preRollSec?: number) => onSeekAndPlay?.(Math.max(0, nodeOccurrence.start - (preRollSec ?? 0)), nodeOccurrence.end)
    : undefined;
  // `isPlaying` (the instance-wide flag) already implies playback is inside
  // the instance's own region, which always contains this node's occurrence
  // — so gating on it here is enough to rule out a paused player whose
  // `currentTime` merely happens to sit inside the window.
  const tapIsPlaying = !!nodeOccurrence && !!isPlaying;
  // A boundary node's Tap Along commits raw presses as blocks instead of a
  // quantised chip patch — same hook, same controls, same session (see
  // `useTapAlong`'s `onSaveTaps`), only the write differs. Snap lives here
  // rather than inside the block editor so the commit uses exactly the value
  // its picker is showing.
  const nodeIsBoundary = isBoundaryNode(nodeItem);
  const [boundarySnap, setBoundarySnap] = useState(0);
  // Fold + vote for the tap review step, owned here for the same reason snap
  // is: the preview below and the Save above have to agree on them.
  const refine = useBoundaryTapRefine();
  // Indirection so the `commit` handed to the parent below always calls the
  // CURRENT `save` — it's reported once, when the session goes live, but has
  // to commit whatever the take (and the snap/fold dials) look like by the
  // time the card is actually closed.
  const tapSaveRef = useRef<() => void>(() => {});
  const tapAlong = useTapAlong({
    stepsPerCycle: nodeItem?.stepsPerCycle ?? 1,
    subbeatsPerBeat: nodeItem?.subbeatsPerBeat ?? 1,
    playheadStep: isActiveLeaf ? nodePlayheadStep : null,
    isPlaying: tapIsPlaying,
    onPlay: tapOnPlay,
    onStop,
    onChange: (patch) => { if (nodeItem) onPatchNode(nodeItem.id, patch); },
    onSaveTaps: nodeIsBoundary
      ? (taps, numBeats) => {
          if (nodeItem) onPatchNode(nodeItem.id, { segments: boundarySegmentsFromTaps(taps, numBeats, boundarySnap, refine) });
        }
      : undefined,
    onPhaseChange: (phase) => onTapActiveChange?.(path, phase !== 'idle', () => tapSaveRef.current()),
  });
  useEffect(() => { tapSaveRef.current = tapAlong.save; }, [tapAlong.save]);
  const tapPreview = tapAlong.previewPatch;
  const tapSegments = nodeIsBoundary && tapAlong.phase !== 'idle' && tapAlong.tapEvents.length > 0
    ? boundarySegmentsFromTaps(tapAlong.tapEvents, tapAlong.numBeats, boundarySnap, refine)
    : null;
  // How many passes the take has, for the vote's ceiling — passes are
  // numbered from 0 and only counted once a tap lands in them.
  const tapPasses = tapAlong.tapEvents.reduce((m, t) => Math.max(m, t.pass + 1), 1);

  if (!resolved) return null;

  return (
    <div className={`rounded transition-colors ${onActivePath ? 'bg-orange-500/10 ring-1 ring-orange-400/30' : 'bg-white/[0.03]'}`}>
      <div className="flex items-center gap-1.5 px-1.5 py-1">
        <SeqChip id={id} nodes={nodes} combos={combos} active={onActivePath} />
        <span className="flex-1 text-[11px] text-slate-300 truncate">
          {resolved.kind === 'silence' ? '(silence)' : resolved.item.name}
        </span>
        <span className="text-[9px] font-mono text-slate-600" title="Length in sub-steps">
          {entry.lengthSteps}st
        </span>
        {(resolved.kind === 'combo' || resolved.kind === 'node') && (
          <button
            type="button"
            className="text-[9px] text-slate-500 hover:text-slate-200 transition-colors"
            onClick={() => onToggleExpand(path)}
            title={expanded ? 'Collapse' : resolved.kind === 'combo'
              ? "Expand — see what this combo is built from"
              : "Expand — see this node's beat grid"}
          >
            {expanded ? '▲' : '▼'}
          </button>
        )}
        {resolved.kind === 'node' && (
          <button
            type="button"
            className="text-[9px] text-slate-500 hover:text-slate-200 transition-colors"
            onClick={(e) => onEditNode(resolved.item.id, e)}
            title="Edit this node"
          >
            ✎
          </button>
        )}
        <button
          type="button"
          className="text-[9px] text-slate-600 hover:text-red-400 transition-colors"
          onClick={onRemove}
        >
          ✕
        </button>
      </div>

      {/* Node beats shown inline — right here, not behind another popup or a
          chooser — once expanded via the ▼ toggle above, at any depth. The
          adjacent ✎ button still opens the full floating popup for
          rename/color (see file header). */}
      {resolved.kind === 'node' && expanded && (
        <div className="pl-1 pb-1.5">
          <NodeLengthControl
            node={resolved.item}
            onResize={(patch) => onPatchNode(resolved.item.id, patch)}
            onResizeSubdivision={(patch) => onPatchNode(resolved.item.id, patch)}
            onTrimLength={(beats) => onTrimNode(resolved.item.id, beats)}
            showSubdivision={!isBoundaryNode(resolved.item)}
          />
          {/* Boundary nodes swap the chip grid for their own block editor —
              same relative-time karaoke sweep, no subdivision inference. Tap
              Along stays: its raw presses land as blocks where they fell. */}
          {isBoundaryNode(resolved.item) ? (
            <div className="mt-1 space-y-1">
              <BoundarySegmentEditor
                color={resolved.item.color}
                segments={tapSegments ?? resolved.item.segments ?? []}
                lengthBeats={riffNodeLengthBeats(resolved.item)}
                playheadBeat={isActiveLeaf && nodePlayheadStep != null
                  ? nodePlayheadStep / Math.max(1, resolved.item.subbeatsPerBeat)
                  : null}
                onChange={(segments) => onPatchNode(resolved.item.id, { segments })}
                readOnly={tapAlong.phase !== 'idle'}
                snap={boundarySnap}
                onSnapChange={setBoundarySnap}
                onTapAtBeat={tapAlong.phase === 'recording'
                  ? (beat) => tapAlong.tapAtStep(beat * tapAlong.subbeats)
                  : undefined}
              />
              {tapAlong.phase !== 'idle' && (
                <TapAlongPianoRoll
                  taps={tapAlong.tapEvents}
                  numBeats={tapAlong.numBeats}
                  playheadBeat={isActiveLeaf && nodePlayheadStep != null ? nodePlayheadStep / tapAlong.subbeats : null}
                  color={resolved.item.color}
                />
              )}
              {tapAlong.phase !== 'idle' && tapAlong.tapEvents.length > 0 && (
                <TapRefineControls {...refine} passes={tapPasses} />
              )}
              <TapAlongControls {...tapAlong} disabled={!tapOnPlay} mode="boundary" />
            </div>
          ) : (
          <>
          <BeatChipPicker
            color={resolved.item.color}
            steps={tapPreview?.stepsPerCycle ?? resolved.item.stepsPerCycle}
            subbeatsPerBeat={tapPreview?.subbeatsPerBeat ?? resolved.item.subbeatsPerBeat}
            highlighted={tapPreview?.highlightedBeats ?? resolved.item.highlightedBeats}
            spans={tapPreview?.spans ?? resolved.item.spans}
            // A Tap Along preview is a pattern being re-played by hand; the
            // measured accents describe the old steps, so they are held back
            // until the preview is committed or dropped.
            accents={tapPreview ? undefined : resolved.item.accents}
            onChange={(patch) => onPatchNode(resolved.item.id, patch)}
            playheadStep={isActiveLeaf ? nodePlayheadStep : null}
            readOnly={tapAlong.phase !== 'idle'}
            onTapAlongTap={tapAlong.phase === 'recording' ? tapAlong.tapAtStep : undefined}
          />
          {tapAlong.phase !== 'idle' && (
            <div className="mt-1">
              <TapAlongPianoRoll
                taps={tapAlong.tapEvents}
                numBeats={tapAlong.numBeats}
                playheadBeat={isActiveLeaf && nodePlayheadStep != null ? nodePlayheadStep / tapAlong.subbeats : null}
                color={resolved.item.color}
              />
            </div>
          )}
          <div className="mt-1">
            <TapAlongControls {...tapAlong} disabled={!tapOnPlay} />
          </div>
          </>
          )}
        </div>
      )}

      {expanded && resolved.kind === 'combo' && (
        <div className="pl-2.5 ml-2 border-l border-slate-700/50 pb-1.5 space-y-1">
          {resolved.item.sequence.map((nested, i) => (
            <SeqTreeRow
              key={`${nested.type}-${i}`}
              entry={nested}
              path={`${path}.${i}`}
              nodes={nodes} combos={combos}
              forbiddenFor={forbiddenFor}
              expandedPaths={expandedPaths}
              onToggleExpand={onToggleExpand}
              onRemove={() => onPatchCombo(resolved.item.id, {
                sequence: resolved.item.sequence.filter((_, idx) => idx !== i),
              })}
              onPatchCombo={onPatchCombo}
              onPatchNode={onPatchNode}
              onTrimNode={onTrimNode}
              onCreateNode={onCreateNode}
              onCreateCombo={onCreateCombo}
              onEditNode={onEditNode}
              activePath={activePath}
              nodePlayheadStep={nodePlayheadStep}
              isPlaying={isPlaying}
              onPlay={onPlay}
              onStop={onStop}
              onTapActiveChange={onTapActiveChange}
              item={item}
              bpm={bpm}
              onSeekAndPlay={onSeekAndPlay}
            />
          ))}
          {resolved.item.sequence.length === 0 && (
            <span className="text-[9px] text-slate-600 italic">empty</span>
          )}
          <div className="relative">
            <button
              type="button"
              className="text-[9px] text-slate-500 hover:text-slate-200 border border-dashed border-slate-700 hover:border-slate-500 rounded px-1.5 py-0.5 transition-colors"
              onClick={() => setNestedMenuOpen((v) => !v)}
            >
              + Add
            </button>
            {nestedMenuOpen && (
              <AddToSeqMenu
                nodes={nodes} combos={combos}
                excludeComboIds={forbiddenFor(resolved.item.id)}
                onAdd={(newId) => onPatchCombo(resolved.item.id, {
                  sequence: [...resolved.item.sequence, newRiffSeqEntry(newId, defaultRiffEntryLength(newId, nodes, combos))],
                })}
                onClose={() => setNestedMenuOpen(false)}
                onCreateNode={onCreateNode}
                onCreateCombo={onCreateCombo}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function RiffPatternEditPopover({
  layer, item, beatsPerBar, popoverRef, positionStyle,
  onChange, onDelete, onClose, registerCloseGuard,
  onPatchCombo, onPatchNode, onTrimNode, onCreateNode, onCreateCombo, onEditNode,
  onPlay, onStop, onSeekAndPlay, isPlaying,
  bpm, gridOffset, segments, currentTime,
  initialExpandedIndex,
}: RiffPatternEditPopoverProps) {
  const nodes = layer.nodes ?? [];
  const combos = layer.combos ?? [];
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(initialExpandedIndex != null ? [String(initialExpandedIndex)] : []),
  );
  const toggleExpand = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };
  const cycle = Math.max(0, item.end - item.start);
  const reps = Math.max(1, Math.floor(item.repeatCount));
  const regionEnd = item.start + reps * cycle;

  // Tree paths (any nesting depth) with a live Tap Along session, reported by
  // each SeqTreeRow's `onTapActiveChange`. While any is active the footer's
  // own play/stop button (below, on the AnnotationPointCard) is hidden — it
  // shares the same onPlay/onStop as the active session's auto-loop, so a
  // click there doesn't actually stop anything (it reads as "pass ended
  // naturally" and the loop just restarts); Tap Along's own Stop/Cancel is the
  // only working control while a session is live.
  const [activeTapPaths, setActiveTapPaths] = useState<Set<string>>(new Set());
  /** The live sessions' own `save`, by path — the rows report it alongside
   *  going active. A ref, not state: it's only ever read on the way out. */
  const tapCommitsRef = useRef(new Map<string, () => void>());
  const handleTapActiveChange = (path: string, active: boolean, commit?: () => void) => {
    if (active && commit) tapCommitsRef.current.set(path, commit);
    else if (!active) tapCommitsRef.current.delete(path);
    setActiveTapPaths((prev) => {
      const has = prev.has(path);
      if (active === has) return prev;
      const next = new Set(prev);
      if (active) next.add(path); else next.delete(path);
      return next;
    });
  };
  const anyTapActive = activeTapPaths.size > 0;

  // Same rule as NodeEditPopover: closing KEEPS a nested node's take. Every
  // close path (Done/×, outside click, Escape) commits whatever Tap Along
  // sessions are live in the tree — the blocks/beats the user watched land in
  // the row are the ones the node keeps — instead of prompting or dropping
  // them. Each row's own `save` stops the shared instance playback its
  // auto-loop was driving, and the row itself unmounts with the popover.
  // Discarding stays the explicit gesture: Tap Along's own ✕ / Cancel.
  useEffect(() => {
    registerCloseGuard(() => {
      for (const commit of tapCommitsRef.current.values()) commit();
      tapCommitsRef.current.clear();
      return true;
    });
    return () => registerCloseGuard(null);
  }, [registerCloseGuard]);

  // Karaoke sweep: map the live playhead onto the sequence — which entry is
  // sounding right now, and (if it's a node) where inside that node's own
  // beat grid. Same idea as PatternEditPopover/NodeEditPopover's sweep, just
  // walking a tree of node/combo/silence entries instead of one flat grid.
  const seqPlayback =
    isPlaying && bpm && currentTime != null
      ? computeRiffSeqPlayback(item, nodes, combos, bpm, currentTime)
      : null;

  // Full index path (one entry per nesting level) from the root sequence
  // down to the leaf currently sounding — null when not playing. Drives the
  // karaoke glow (every row along the path).
  const activePath = seqPlayback != null
    ? riffLeafPath(item.sequence, nodes, combos, seqPlayback.leafIndex)
    : null;
  // Identity of the *ancestor chain* only (path minus its final leaf index),
  // with stable string identity so the auto-expand effect below can use it as
  // a dependency. Deliberately excludes the leaf: leafIndex advances on
  // basically every beat while playing, so keying off the full path would
  // re-fire the effect that often and re-expand a branch the instant after
  // the user manually collapsed it. Keying off the ancestor chain means the
  // effect only fires when playback crosses into a genuinely different
  // nested combo — same coarseness the original one-level version got for
  // free from `entryIndex` (which only changed between top-level entries),
  // generalized to any depth.
  const activeAncestorKey = activePath != null && activePath.length > 1
    ? activePath.slice(0, -1).join('.')
    : null;

  // Auto-expand every combo ancestor of the currently-sounding leaf — at any
  // nesting depth — so its karaoke sweep is visible without a manual click
  // first. Only adds paths, never removes them, so a manual collapse always
  // sticks for as long as that same branch keeps playing.
  useEffect(() => {
    if (activePath == null) return;
    setExpandedPaths((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (let i = 1; i < activePath.length; i++) {
        const ancestorPath = activePath.slice(0, i).join('.');
        if (!next.has(ancestorPath)) { next.add(ancestorPath); changed = true; }
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAncestorKey]);

  const repeats = useRepeatsDraft(item.repeatCount, (n) => onChange({ repeatCount: n }));

  // The repeat count is the one field that rewrites where the whole instance
  // ends, so it stays visible above the fold rather than inside a section.
  const extras = (
    <RepeatsRow
      draft={repeats}
      focusRing={cardTheme('riff-pattern').focusRing}
      trailing={
        <span className="text-[10px] font-mono text-slate-400" title="Region end (cycle × repeats)">
          → ends {regionEnd.toFixed(2)}s
        </span>
      }
    />
  );

  const sequenceSection = {
    id: 'riff-sequence',
    title: 'Sequence',
    summary: item.sequence.length === 1 ? '1 entry' : `${item.sequence.length} entries`,
    content: (
      <>
        <span className="mb-1 block text-[9px] text-slate-400">
          ▼ to peek at a node's beats or a combo's contents, ✎ to edit a node
        </span>
        <div className="space-y-1">
          {item.sequence.map((entry, i) => (
            <SeqTreeRow
              key={`${entry.type}-${i}`}
              entry={entry} path={String(i)}
              nodes={nodes} combos={combos}
              forbiddenFor={(comboId) => reachableCombos(comboId, combos)}
              expandedPaths={expandedPaths}
              onToggleExpand={toggleExpand}
              onRemove={() => {
                onChange({ sequence: item.sequence.filter((_, idx) => idx !== i) });
                setExpandedPaths((prev) => {
                  if (!prev.has(String(i))) return prev;
                  const next = new Set(prev);
                  next.delete(String(i));
                  return next;
                });
              }}
              onPatchCombo={onPatchCombo}
              onPatchNode={onPatchNode}
              onTrimNode={onTrimNode}
              onEditNode={onEditNode}
              onCreateNode={onCreateNode}
              onCreateCombo={onCreateCombo}
              activePath={activePath}
              nodePlayheadStep={seqPlayback?.nodePlayheadStep ?? null}
              isPlaying={isPlaying}
              onPlay={onPlay}
              onStop={onStop}
              onTapActiveChange={handleTapActiveChange}
              item={item}
              bpm={bpm}
              onSeekAndPlay={onSeekAndPlay}
            />
          ))}
          {item.sequence.length === 0 && (
            <div className="text-[10px] text-slate-600 italic px-1.5 py-1">empty — add a node, combo, or silence below</div>
          )}
        </div>
        <div className="relative mt-1">
          <button
            type="button"
            className="text-[9px] text-slate-500 hover:text-slate-200 border border-dashed border-slate-700 hover:border-slate-500 rounded px-1.5 py-0.5 transition-colors"
            onClick={() => setAddMenuOpen((v) => !v)}
          >
            + Add
          </button>
          {addMenuOpen && (
            <AddToSeqMenu
              nodes={nodes} combos={combos}
              onAdd={(id) => onChange({
                sequence: [...item.sequence, newRiffSeqEntry(id, defaultRiffEntryLength(id, nodes, combos))],
              })}
              onClose={() => setAddMenuOpen(false)}
              onCreateNode={onCreateNode}
              onCreateCombo={onCreateCombo}
            />
          )}
        </div>
      </>
    ),
  };

  // Says what Done will do while a nested take is live — the close guard
  // commits it, so it really is the Save button in that moment.
  const doneLabel = anyTapActive ? 'Save & Done' : undefined;

  const sections = [
    sequenceSection,
    // Prominence runs over the whole repeated region, not one cycle.
    prominenceSection({
      points: item.prominence,
      start: item.start,
      end: regionEnd,
      currentTime,
      color: layer.color,
      onChange: (points) => onChange({ prominence: points }),
    }),
  ];

  return (
    <AnnotationPointCard
      kind="riff-pattern"
      layerName={layer.name}
      layerColor={layer.color}
      start={item.start}
      end={item.end}
      label={item.label}
      labelPlaceholder="short label (e.g. verse riff)"
      description={item.description ?? ''}
      importance={item.importance}
      bpm={bpm}
      gridOffset={gridOffset}
      beatsPerBar={beatsPerBar}
      segments={segments}
      currentTime={currentTime}
      width={380}
      onChange={forwardCardPatch<RiffPatternItem>(onChange)}
      onDelete={onDelete}
      onPlay={anyTapActive ? undefined : onPlay}
      onStop={anyTapActive ? undefined : onStop}
      isPlaying={isPlaying}
      onClose={onClose}
      popoverRef={popoverRef}
      positionStyle={positionStyle}
      extras={extras}
      sections={sections}
      doneDisabled={!repeats.valid}
      doneDisabledReason="Repeats is invalid — fix it before closing"
      doneLabel={doneLabel}
    />
  );
}
