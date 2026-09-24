/**
 * RiffPatternEditorPanel — three-tier hierarchical riff composer.
 *
 * Nodes  →  Combos  →  Instances (timeline regions)
 *
 * Nodes are named beat-chip motifs (leaf riffs). Combos are ordered sequences
 * of nodes and/or nested combos. Instances are placed on the timeline as
 * [start, end] regions referencing a sequence of combos/nodes × repeatCount.
 *
 * Gated by the experimentalLoopsAndPatterns Settings flag.
 */

import {
  useCallback, useEffect, useImperativeHandle, useMemo,
  useRef, useState, forwardRef, type ForwardedRef,
} from 'react';
import { formatClockTime as fmtTime } from '../../utils/clockTime';
import type {
  AnnotationLayer, AnnotationLayersDocument, AnnotationStage,
  RiffCombo, RiffNode, RiffNodeKind, RiffPatternItem,
} from '../../types/annotationLayer';
import {
  RIFF_NODE_SILENCE_ID, PATTERN_SUBBEATS_PER_BEAT,
  computeRiffDuplicates,
  defaultRiffEntryLength, resizeRiffNodeLength, resizeRiffNodeSubdivision,
  resizeBoundaryNodeLength, isBoundaryNode, newRiffBoundaryNode,
  getLayerStatus, newRiffCombo, newRiffNode, newRiffPatternItem, newRiffSeqEntry,
  newRiffPatternLayer, nodeEntryLengthSteps, pickDefaultLayerColor, pickRiffComboColor,
  pickRiffNodeColor, riffSequenceSteps, setLayerStatus,
} from '../../types/annotationLayer';
import { snapToBeat, type BarGrid } from '../../utils/barSnap';
import type { PendingSelection } from './AnnotationOverlays';
import type { AnnotationPanelCapabilities, AnnotationPanelController } from './shared/AnnotationPanelController';
import { emptyCapabilities } from './shared/AnnotationPanelController';
import { resolvePointAddTime } from './boundaryInsert';

// ─── helpers ────────────────────────────────────────────────────────────────

export type ResolvedEntry =
  | { kind: 'silence' }
  | { kind: 'node'; item: RiffNode }
  | { kind: 'combo'; item: RiffCombo };

export function resolveId(id: string, nodes: RiffNode[], combos: RiffCombo[]): ResolvedEntry | null {
  if (id === RIFF_NODE_SILENCE_ID) return { kind: 'silence' };
  const node = nodes.find((n) => n.id === id);
  if (node) return { kind: 'node', item: node };
  const combo = combos.find((c) => c.id === id);
  if (combo) return { kind: 'combo', item: combo };
  return null;
}

/** Returns all combo ids reachable from `rootId` (including itself). Used to
 *  prevent circular references when building a combo sequence. */
export function reachableCombos(rootId: string, combos: RiffCombo[]): Set<string> {
  const visited = new Set<string>();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const combo = combos.find((c) => c.id === id);
    if (!combo) continue;
    for (const entry of combo.sequence) {
      const isCombo = combos.some((c) => c.id === entry.type);
      if (isCombo) queue.push(entry.type);
    }
  }
  return visited;
}

// ─── small sub-components ───────────────────────────────────────────────────

/** Subdivision choices for a node's beat grid — steps per beat. Covers binary
 *  feels (quarters/eighths/sixteenths/thirty-seconds) and compound-meter
 *  triplet feels (eighth/sixteenth triplets). */
const SUBDIVISION_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: '1 (quarter notes)' },
  { value: 2, label: '2 (eighths)' },
  { value: 4, label: '4 (sixteenths)' },
  { value: 8, label: '8 (32nds)' },
  { value: 3, label: '3 (eighth triplets)' },
  { value: 6, label: '6 (sixteenth triplets)' },
];

/** A node's own length (in beats) and grid resolution (steps per beat, e.g. 4
 *  = sixteenth notes, 3 = eighth-note triplets for a compound-meter feel).
 *  Shared by the sidebar's Node popup and the sequence-editing popup's inline
 *  node view. */
export function NodeLengthControl({
  node, onResize, onResizeSubdivision, onTrimLength, entryLengthSteps, onResizeEntry,
  showSubdivision = true,
}: {
  node: Pick<RiffNode, 'stepsPerCycle' | 'highlightedBeats' | 'spans' | 'subbeatsPerBeat' | 'segments'>;
  onResize: (patch: Pick<RiffNode, 'stepsPerCycle' | 'highlightedBeats' | 'spans' | 'segments'>) => void;
  onResizeSubdivision: (patch: Pick<RiffNode, 'stepsPerCycle' | 'highlightedBeats' | 'spans' | 'subbeatsPerBeat'>) => void;
  /** Boundary nodes pass `false`: their content isn't quantised to a
   *  sub-beat grid, so offering a subdivision would imply a division that
   *  doesn't exist. They still use the same beats-based Length field. */
  showSubdivision?: boolean;
  /** Applies a new node length as a TRIM (`trimRiffNodeLength`) — the tail is
   *  dropped and every placement shrinks by the same ratio, so what survives
   *  stays exactly the size it's drawn at. Needs the whole layer, so only a
   *  caller that has one passes it; without it the field falls back to
   *  resizing the node alone, which leaves the placements at their old width
   *  and re-stretches the survivors across it. */
  onTrimLength?: (lengthBeats: number) => void;
  /** When this control is showing a specific placed occurrence (not the
   *  node's own library entry), that occurrence's actual length in the
   *  sequence's fixed grid (`PATTERN_SUBBEATS_PER_BEAT`/beat) — independent
   *  of the node's own `stepsPerCycle`/`subbeatsPerBeat` grid, since a
   *  placement can be drag-stretched on the canvas without touching the
   *  node's pattern. Shown as its own STRETCH field below Length, which
   *  always edits the node itself. */
  entryLengthSteps?: number | null;
  onResizeEntry?: (lengthSteps: number) => void;
}) {
  const subbeats = Math.max(1, Math.round(node.subbeatsPerBeat) || PATTERN_SUBBEATS_PER_BEAT);
  const beats = node.stepsPerCycle / subbeats;
  const minBeats = 1 / subbeats;
  const entryMinBeats = 1 / PATTERN_SUBBEATS_PER_BEAT;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[10px]">
        <span className="text-slate-500 uppercase tracking-wider">Length</span>
        <input
          type="number"
          min={minBeats}
          step={minBeats}
          value={beats}
          title="The node's own length. Shortening it trims — blocks past the new end are dropped and every placement shrinks to match, so what's left keeps its size (⌘Z to undo)."
          onChange={(e) => {
            const b = Math.max(minBeats, Number(e.target.value) || minBeats);
            if (onTrimLength) {
              onTrimLength(b);
            } else if (showSubdivision) {
              onResize(resizeRiffNodeLength(node, b));
            } else {
              // Boundary node: re-tile its blocks to the new length too,
              // otherwise they'd keep covering the old span.
              onResize(resizeBoundaryNodeLength(node, b));
            }
          }}
          className="w-14 bg-[#0a0b0d] border border-white/[0.06] rounded px-1 py-0.5 text-[11px] text-slate-200 focus:outline-none focus:ring-1 focus:ring-orange-400/40"
        />
        <span className="text-slate-500">
          beats {showSubdivision ? `(${node.stepsPerCycle} steps)` : ''}
        </span>
      </div>
      {/* The placement's own width, kept separate from Length above: trimming
          the node carries every placement along, so this field is only for the
          other thing — deliberately stretching THIS occurrence away from the
          node's natural length (the canvas's alt-drag, in a number field). */}
      {entryLengthSteps != null && onResizeEntry && (
        <div className="flex items-center gap-2 text-[10px]">
          <span className="text-slate-500 uppercase tracking-wider">Stretch</span>
          <input
            type="number"
            min={entryMinBeats}
            step={entryMinBeats}
            value={entryLengthSteps / PATTERN_SUBBEATS_PER_BEAT}
            title="How wide THIS placement is drawn, independent of the node's length — stretches or squeezes its content rather than trimming it."
            onChange={(e) => {
              const b = Math.max(entryMinBeats, Number(e.target.value) || entryMinBeats);
              onResizeEntry(Math.max(1, Math.round(b * PATTERN_SUBBEATS_PER_BEAT)));
            }}
            className="w-14 bg-[#0a0b0d] border border-white/[0.06] rounded px-1 py-0.5 text-[11px] text-slate-200 focus:outline-none focus:ring-1 focus:ring-orange-400/40"
          />
          <span className="text-slate-500">beats (this placement)</span>
        </div>
      )}
      {showSubdivision && (
        <div className="flex items-center gap-2 text-[10px]">
          <span className="text-slate-500 uppercase tracking-wider">Divide beat into</span>
          <select
            value={subbeats}
            onChange={(e) => onResizeSubdivision(resizeRiffNodeSubdivision(node, Number(e.target.value)))}
            className="bg-[#0a0b0d] border border-white/[0.06] rounded px-1 py-0.5 text-[11px] text-slate-200 focus:outline-none focus:ring-1 focus:ring-orange-400/40"
          >
            {SUBDIVISION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

function SectionHeader({
  title, count, open, onToggle, onAdd, addLabel = '+ Add', addTitle, extraAdd,
}: {
  title: string; count: number; open: boolean;
  onToggle: () => void; onAdd: () => void; addLabel?: string; addTitle?: string;
  /** Optional second "add" action rendered left of the primary one — used by
   *  the Nodes section, which can create either kind of node. */
  extraAdd?: { label: string; title: string; onAdd: () => void };
}) {
  return (
    <div className="flex items-center gap-2 py-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1.5 flex-1 text-[10px] uppercase tracking-wider text-slate-400 hover:text-slate-200 transition-colors text-left"
      >
        <span className="text-[9px]">{open ? '▼' : '▶'}</span>
        {title}
        <span className="text-slate-600">({count})</span>
      </button>
      {extraAdd && (
        <button
          type="button"
          onClick={extraAdd.onAdd}
          title={extraAdd.title}
          className="text-[10px] text-slate-500 hover:text-slate-200 transition-colors px-1.5 py-0.5 rounded hover:bg-white/5"
        >
          {extraAdd.label}
        </button>
      )}
      <button
        type="button"
        onClick={onAdd}
        title={addTitle}
        className="text-[10px] text-slate-500 hover:text-slate-200 transition-colors px-1.5 py-0.5 rounded hover:bg-white/5"
      >
        {addLabel}
      </button>
    </div>
  );
}

/** Compact chip showing node/combo identifier in a sequence. Node chips open
 *  the node's edit popup when `onEditNode` is given (taking over the click
 *  from `onRemove`) — see `SeqChipRow` below for the paired remove button
 *  that removal then needs. */
export function SeqChip({
  id, nodes, combos, onRemove, onEditNode, active = false,
}: {
  id: string; nodes: RiffNode[]; combos: RiffCombo[];
  onRemove?: () => void;
  onEditNode?: (e: React.MouseEvent) => void;
  /** True while the live playhead is currently sounding this chip — karaoke
   *  glow, same idea as `BeatChipPicker`'s sweep ring. Works for any kind
   *  (node, combo, or silence) since a collapsed combo has no beat grid of
   *  its own to sweep. */
  active?: boolean;
}) {
  const resolved = resolveId(id, nodes, combos);
  if (!resolved) return null;
  const activeRing = active ? 'ring-2 ring-orange-400 shadow-[0_0_8px_rgba(251,146,60,0.85)]' : '';

  if (resolved.kind === 'silence') {
    return (
      <span
        className={`inline-flex items-center justify-center w-6 h-6 rounded text-[10px] font-mono border border-dashed border-slate-600 text-slate-500 cursor-pointer hover:border-red-500/60 hover:text-red-400 transition-colors select-none ${activeRing}`}
        onClick={onRemove}
        title="(silence) — click to remove"
      >
        ◌
      </span>
    );
  }
  if (resolved.kind === 'node') {
    const node = resolved.item;
    return (
      <span
        className={`inline-flex items-center justify-center w-6 h-6 rounded text-[10px] font-bold text-white cursor-pointer transition-all select-none ${
          onEditNode ? 'hover:opacity-70 hover:ring-1 hover:ring-white/60' : 'hover:opacity-70 hover:ring-1 hover:ring-red-400'
        } ${activeRing}`}
        style={{ backgroundColor: node.color }}
        onClick={onEditNode ?? onRemove}
        title={onEditNode ? `${node.name} — click to edit` : `${node.name} — click to remove`}
      >
        {node.name[0]?.toUpperCase() ?? '?'}
      </span>
    );
  }
  // combo
  const combo = resolved.item;
  return (
    <span
      className={`inline-flex items-center justify-center px-1.5 h-6 rounded text-[9px] font-mono font-bold text-white cursor-pointer hover:opacity-70 hover:ring-1 hover:ring-red-400 transition-all select-none ${activeRing}`}
      style={{ backgroundColor: combo.color ?? '#475569' }}
      onClick={onRemove}
      title={`${combo.name} — click to remove`}
    >
      [{combo.name.slice(0, 4)}]
    </span>
  );
}

/** A sequence-child chip plus its own remove control — for the flat chip
 *  lists where a node/combo is listed as a member of something else (a
 *  combo's own sequence editor, or a nested combo shown inside another
 *  sequence's expand). When `onEditNode` is supplied, a node chip's click
 *  opens its edit popup instead of removing it, so removal moves to an
 *  adjacent ✕; combo/silence chips are unaffected (no popup to open, so they
 *  keep the plain click-to-remove chip). Omit `onEditNode` to fall back to
 *  the original click-to-remove chip for every kind (no extra ✕). */
export function SeqChipRow({
  id, nodes, combos, onRemove, onEditNode,
}: {
  id: string; nodes: RiffNode[]; combos: RiffCombo[];
  onRemove: () => void;
  onEditNode?: (nodeId: string, e: React.MouseEvent) => void;
}) {
  const resolved = resolveId(id, nodes, combos);
  const editable = resolved?.kind === 'node' && !!onEditNode;
  return (
    <span className="inline-flex items-center gap-0.5">
      <SeqChip
        id={id} nodes={nodes} combos={combos}
        onRemove={editable ? undefined : onRemove}
        onEditNode={editable ? (e) => onEditNode!(id, e) : undefined}
      />
      {editable && (
        <button
          type="button"
          className="text-[9px] text-slate-600 hover:text-red-400 transition-colors"
          onClick={onRemove}
          title="Remove from sequence"
        >
          ✕
        </button>
      )}
    </span>
  );
}

/** Dropdown to add a node or combo to a sequence. `onCreateNode`/`onCreateCombo`
 *  (when given) surface a "+ New …" entry that creates a fresh library item and
 *  adds it in one step — lets a sequence be built without leaving this menu. */
export function AddToSeqMenu({
  nodes, combos, excludeComboIds = new Set(), onAdd, onClose, onCreateNode, onCreateCombo,
}: {
  nodes: RiffNode[]; combos: RiffCombo[];
  excludeComboIds?: Set<string>;
  onAdd: (id: string) => void;
  onClose: () => void;
  /** Creates a new node and returns its id. */
  onCreateNode?: () => string;
  /** Creates a new combo and returns its id. */
  onCreateCombo?: () => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // Pointerdown, not mousedown: the timeline cancels its touch pointerdowns,
    // so a tap there never fires a mousedown and would leave this open.
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute z-50 mt-1 min-w-[140px] rounded-lg border border-white/10 bg-[#1a1d24] shadow-xl text-[11px]"
    >
      <div className="px-2 pt-1.5 pb-0.5 text-[9px] uppercase tracking-wider text-slate-500">Nodes</div>
      <div
        className="flex items-center gap-1.5 px-2 py-1 hover:bg-white/5 cursor-pointer text-slate-400"
        onClick={() => { onAdd(RIFF_NODE_SILENCE_ID); onClose(); }}
      >
        <span className="w-4 h-4 rounded border border-dashed border-slate-600 flex items-center justify-center text-[9px]">◌</span>
        (silence)
      </div>
      {nodes.map((n) => (
        <div
          key={n.id}
          className="flex items-center gap-1.5 px-2 py-1 hover:bg-white/5 cursor-pointer text-slate-200"
          onClick={() => { onAdd(n.id); onClose(); }}
        >
          <span className="w-4 h-4 rounded flex-shrink-0" style={{ backgroundColor: n.color }} />
          {n.name}
        </div>
      ))}
      {onCreateNode && (
        <div
          className="flex items-center gap-1.5 px-2 py-1 hover:bg-white/5 cursor-pointer text-slate-400 border-t border-white/5"
          onClick={() => { onAdd(onCreateNode()); onClose(); }}
        >
          <span className="w-4 h-4 flex items-center justify-center text-[10px]">+</span>
          New node…
        </div>
      )}
      {combos.length > 0 && (
        <>
          <div className="px-2 pt-1.5 pb-0.5 text-[9px] uppercase tracking-wider text-slate-500">Combos</div>
          {combos.filter((c) => !excludeComboIds.has(c.id)).map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-1.5 px-2 py-1 hover:bg-white/5 cursor-pointer text-slate-200"
              onClick={() => { onAdd(c.id); onClose(); }}
            >
              <span
                className="w-4 h-4 rounded flex-shrink-0 text-[8px] font-bold text-white flex items-center justify-center"
                style={{ backgroundColor: c.color ?? '#475569' }}
              >[…]</span>
              {c.name}
            </div>
          ))}
        </>
      )}
      {onCreateCombo && (
        <div
          className="flex items-center gap-1.5 px-2 py-1 hover:bg-white/5 cursor-pointer text-slate-400 border-t border-white/5"
          onClick={() => { onAdd(onCreateCombo()); onClose(); }}
        >
          <span className="w-4 h-4 flex items-center justify-center text-[10px]">+</span>
          New combo…
        </div>
      )}
    </div>
  );
}

// ─── panel props / main component ───────────────────────────────────────────

export interface RiffPatternEditorPanelProps {
  currentTime: number;
  duration: number;
  doc: AnnotationLayersDocument;
  onDocChange: (doc: AnnotationLayersDocument) => void;
  grid?: Partial<BarGrid> | null;
  snapToGrid?: boolean;
  /** The page's grid-aware snapper, used for every add / snap-to-playhead
   *  time. It honours the GRID unit the user picked (1/2 beat, triplets,
   *  bars…), per-beat overrides and tempo segments, and returns the time
   *  untouched while Snap and Grid Lock are both off — the same rule a drag
   *  on the canvas already followed. Optional: without it these paths fall
   *  back to whole-beat snapping, which is what they all used to do. */
  snapTime?: (t: number) => number;
  focusedInstance?: { layerId: string; itemId: string } | null;
  onFocusInstance?: (f: { layerId: string; itemId: string } | null) => void;
  selectedLayerId?: string | null;
  onSelectLayer?: (id: string | null) => void;
  pendingSelection?: PendingSelection | null;
  onClearPendingSelection?: () => void;
  onCapabilitiesChange?: (caps: AnnotationPanelCapabilities) => void;
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error';
  /** Opens the floating Node-edit popup (owned at the page level, same as the
   *  Riff-instance popover) for the given node in `layerId`. Anchor omitted →
   *  centered (used right after creating a node). */
  onEditNode: (layerId: string, nodeId: string, anchor?: { x: number; y: number }) => void;
  /** Reader for the LIVE media clock (the page's `liveSongTime`). An instance
   *  started from `currentTime` begins a render behind the riff the annotator
   *  heard; see `markTime`. Optional — falls back to the prop. */
  getSongTime?: () => number | null;
}

function RiffPatternEditorPanelInner(
  {
    currentTime, duration, doc, onDocChange, grid,
    snapToGrid = false, snapTime,
    focusedInstance, onFocusInstance,
    selectedLayerId = null, onSelectLayer,
    pendingSelection, onClearPendingSelection,
    onCapabilitiesChange,
    saveStatus = 'idle',
    onEditNode,
    getSongTime,
  }: RiffPatternEditorPanelProps,
  controllerRef: ForwardedRef<AnnotationPanelController>,
) {
  // Where something placed *right now* belongs. Called at the moment of the
  // placement, never captured: `currentTime` is the media clock one rAF, one
  // setState and one inspector re-render later.
  const markTime = useCallback(
    (atTime?: number) => resolvePointAddTime({
      live: atTime ?? getSongTime?.(),
      fallback: currentTime,
    }),
    [getSongTime, currentTime],
  );
  const riffLayers = useMemo(
    () => doc.layers.filter((l): l is AnnotationLayer<'riff-patterns'> => l.type === 'riff-patterns'),
    [doc.layers],
  );

  const activeLayer = useMemo<AnnotationLayer<'riff-patterns'> | null>(() => {
    if (selectedLayerId) {
      const hit = riffLayers.find((l) => l.id === selectedLayerId);
      if (hit) return hit;
    }
    return riffLayers[0] ?? null;
  }, [riffLayers, selectedLayerId]);

  useEffect(() => {
    if (!onSelectLayer) return;
    if (activeLayer && activeLayer.id !== selectedLayerId) {
      onSelectLayer(activeLayer.id);
    }
  }, [activeLayer, selectedLayerId, onSelectLayer]);

  const nodes  = activeLayer?.nodes  ?? [];
  const combos = activeLayer?.combos ?? [];
  const items  = (activeLayer?.items ?? []) as RiffPatternItem[];
  const totalItems = riffLayers.reduce((s, l) => s + l.items.length, 0);

  // Colors are picked against every riff-pattern layer's nodes/combos, not just
  // the active layer's — otherwise every layer's first node/combo independently
  // lands on palette index 0 and different layers end up looking the same color.
  const allRiffNodes  = useMemo(() => riffLayers.flatMap((l) => l.nodes  ?? []), [riffLayers]);
  const allRiffCombos = useMemo(() => riffLayers.flatMap((l) => l.combos ?? []), [riffLayers]);

  // ── section open/close ───────────────────────────────────────────────────
  const [nodesOpen,     setNodesOpen]     = useState(true);
  const [combosOpen,    setCombosOpen]    = useState(true);
  const [instancesOpen, setInstancesOpen] = useState(true);

  // ── expanded row ids (one per section at a time) ─────────────────────────
  // Nodes edit in a floating popup owned at the page level (`onEditNode`)
  // rather than an inline expand — they're the one riff-hierarchy tier the
  // user edits often enough on its own (rename, resize, redraw the beat grid,
  // pick a subdivision) to warrant a dedicated card, same as a Riff instance.
  const [expandedComboId,    setExpandedComboId]    = useState<string | null>(null);
  const [expandedInstanceId, setExpandedInstanceId] = useState<string | null>(null);

  // ── open add-seq menus ───────────────────────────────────────────────────
  const [comboSeqMenu, setComboSeqMenu] = useState<string | null>(null);   // combo id
  const [instSeqMenu,  setInstSeqMenu]  = useState<string | null>(null);   // instance id

  // ── doc mutation helpers ─────────────────────────────────────────────────
  function patchLayer(layerId: string, patch: Partial<AnnotationLayer<'riff-patterns'>>) {
    onDocChange({
      ...doc,
      layers: doc.layers.map((l) =>
        l.id === layerId ? ({ ...l, ...patch } as AnnotationLayer) : l,
      ),
    });
  }

  function deleteLayer(layerId: string) {
    onDocChange({ ...doc, layers: doc.layers.filter((l) => l.id !== layerId) });
    if (focusedInstance?.layerId === layerId) onFocusInstance?.(null);
    if (selectedLayerId === layerId) onSelectLayer?.(null);
  }

  /** The highlighted region on the visualization, normalized — `null` when
   *  nothing is highlighted. Every "+ Add" in this panel prefers it over the
   *  playhead: a highlight is the user pointing at a range, and silently
   *  adding somewhere else (and discarding the highlight on the way out) is
   *  the one thing an add must never do. Falling back to the cursor is only
   *  for when there is nothing to adopt. Same rule, and same source, as
   *  `effectiveAnnotationSelection` in InspectorPageV2. */
  const pendingRange = useMemo(() => {
    if (!pendingSelection || pendingSelection.t2 == null) return null;
    return {
      start: Math.min(pendingSelection.t1, pendingSelection.t2),
      end: Math.max(pendingSelection.t1, pendingSelection.t2),
    };
  }, [pendingSelection]);

  // ── node mutations ───────────────────────────────────────────────────────
  /** A node has no timeline position of its own, but if the user dragged a
   *  region before hitting "New Node" we still honor that drag as a length
   *  hint — beats = duration × (bpm / 60), rounded to the nearest quarter
   *  beat by `resizeRiffNodeLength`. No tempo grid → fall back to default. */
  function beatsFromPendingSelection(): number | null {
    if (!pendingSelection || pendingSelection.t2 == null) return null;
    const bpm = grid?.bpm;
    if (!bpm || bpm <= 0) return null;
    const durationSec = Math.abs(pendingSelection.t2 - pendingSelection.t1);
    const beats = durationSec * (bpm / 60);
    return beats > 0 ? beats : null;
  }

  /** Nodes are pure library primitives with no timeline position of their own
   *  (see the type doc on RiffNode) — adding one just appends to the library
   *  and expands it for editing; placing it happens by referencing it from a
   *  combo's or instance's `sequence`. If the user dragged a region before
   *  hitting "New Node" though, we also drop a RiffPatternItem spanning that
   *  exact range with the new node as its sole sequence entry — otherwise the
   *  dragged highlight would just vanish with nothing placed on the riff lane
   *  (same fix as `handleGenerateRiffNodeFromSelection` in InspectorPageV2). */
  function addNode(kind: RiffNodeKind = 'grid') {
    // With no riff layer yet, the layer is created and the node lands in it in
    // the SAME commit — bailing out after making the layer would swallow both
    // the node the user asked for and the selection they drew for it.
    const { layers, targetId } = pickOrCreateLayer();
    const target = layers.find((l) => l.id === targetId) as AnnotationLayer<'riff-patterns'> | undefined;
    const targetNodes = target?.nodes ?? [];
    const targetItems = (target?.items ?? []) as RiffPatternItem[];
    const name = `${kind === 'boundary' ? 'Blocks' : 'Node'} ${targetNodes.length + 1}`;
    const color = pickRiffNodeColor(allRiffNodes);
    let node = kind === 'boundary' ? newRiffBoundaryNode(name, color) : newRiffNode(name, color);
    const beats = beatsFromPendingSelection();
    if (beats != null) {
      node = kind === 'boundary'
        ? { ...node, ...resizeBoundaryNodeLength(node, beats) }
        : { ...node, ...resizeRiffNodeLength(node, beats) };
    }
    let placed: RiffPatternItem | null = null;
    if (beats != null && pendingSelection && pendingSelection.t2 != null) {
      const start = Math.min(pendingSelection.t1, pendingSelection.t2);
      const end = Math.max(pendingSelection.t1, pendingSelection.t2);
      placed = {
        ...newRiffPatternItem(start, end, `Instance ${targetItems.length + 1}`),
        sequence: [newRiffSeqEntry(node.id, nodeEntryLengthSteps(node))],
      } as RiffPatternItem;
    }
    onDocChange({
      ...doc,
      layers: layers.map((l) => (l.id === targetId
        ? ({
          ...l,
          nodes: [...targetNodes, node],
          items: placed ? [...targetItems, placed] : targetItems,
        } as AnnotationLayer)
        : l)),
    });
    if (placed) onFocusInstance?.({ layerId: targetId, itemId: placed.id });
    onEditNode(targetId, node.id);
    if (beats != null) onClearPendingSelection?.();
  }

  /** Same as `addNode` but returns the id synchronously without expanding it —
   *  for "+ New node…" inside a sequence-building menu. Only reachable once a
   *  combo or instance exists to hold the sequence, so `activeLayer` is
   *  always set by the time this fires. */
  function createBareNode(): string {
    const node = newRiffNode(`Node ${nodes.length + 1}`, pickRiffNodeColor(allRiffNodes));
    if (activeLayer) patchLayer(activeLayer.id, { nodes: [...nodes, node] });
    return node.id;
  }

  function patchNode(nodeId: string, patch: Partial<RiffNode>) {
    if (!activeLayer) return;
    patchLayer(activeLayer.id, {
      nodes: nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)),
    });
  }

  function deleteNode(nodeId: string) {
    if (!activeLayer) return;
    const nextNodes = nodes.filter((n) => n.id !== nodeId);
    const nextCombos = combos.map((c) => ({
      ...c,
      sequence: c.sequence.filter((e) => e.type !== nodeId),
    }));
    const nextItems = items.map((it) => ({
      ...it,
      sequence: it.sequence.filter((e) => e.type !== nodeId),
    }));
    patchLayer(activeLayer.id, { nodes: nextNodes, combos: nextCombos, items: nextItems as any });
  }

  /** Creates an empty combo and returns its id synchronously — for "+ New
   *  combo…" inside a sequence-building menu. Only reachable once another
   *  combo or instance exists, so `activeLayer` is always set. */
  function createBareCombo(): string {
    const combo = newRiffCombo(`Combo ${combos.length + 1}`, pickRiffComboColor(allRiffCombos));
    if (activeLayer) patchLayer(activeLayer.id, { combos: [...combos, combo] });
    return combo.id;
  }

  // ── combo mutations ──────────────────────────────────────────────────────
  function addCombo() {
    // Same create-and-continue rule as addNode: no layer yet is not a reason
    // to drop the combo.
    const { layers, targetId } = pickOrCreateLayer();
    const target = layers.find((l) => l.id === targetId) as AnnotationLayer<'riff-patterns'> | undefined;
    const targetCombos = target?.combos ?? [];
    const color = pickRiffComboColor(allRiffCombos);
    const combo = newRiffCombo(`Combo ${targetCombos.length + 1}`, color);
    onDocChange({
      ...doc,
      layers: layers.map((l) => (l.id === targetId
        ? ({ ...l, combos: [...targetCombos, combo] } as AnnotationLayer)
        : l)),
    });
    setExpandedComboId(combo.id);
  }

  function patchCombo(comboId: string, patch: Partial<RiffCombo>) {
    if (!activeLayer) return;
    patchLayer(activeLayer.id, {
      combos: combos.map((c) => (c.id === comboId ? { ...c, ...patch } : c)),
    });
  }

  function deleteCombo(comboId: string) {
    if (!activeLayer) return;
    const nextCombos = combos.filter((c) => c.id !== comboId).map((c) => ({
      ...c,
      sequence: c.sequence.filter((e) => e.type !== comboId),
    }));
    const nextItems = items.map((it) => ({
      ...it,
      sequence: it.sequence.filter((e) => e.type !== comboId),
    }));
    patchLayer(activeLayer.id, { combos: nextCombos, items: nextItems as any });
    if (expandedComboId === comboId) setExpandedComboId(null);
  }

  // ── instance mutations ───────────────────────────────────────────────────
  // Delegates to the page's `snapTime` so a node placed from the panel lands
  // on the same lines as one dragged on the canvas — the GRID unit, beat
  // overrides and tempo segments included. The whole-beat fallback is only for
  // mounts that inject no snapper.
  const snapT = useCallback((t: number) => (snapTime
    ? snapTime(t)
    : (snapToGrid && grid?.bpm ? snapToBeat(t, grid as BarGrid) : t)),
    [snapTime, snapToGrid, grid],
  );

  /** Whether this instance's `end` is derived rather than placed — true
   *  whenever there's both a tempo grid to convert the sequence's steps into
   *  seconds and a sequence to convert (see `fitRiffInstanceEnd`). The panel
   *  reads it to stop offering an End the page is about to overwrite. */
  const endFollowsSequence = useCallback(
    (it: RiffPatternItem) => !!grid?.bpm && grid.bpm > 0 && riffSequenceSteps(it) >= 1,
    [grid],
  );

  function pickOrCreateLayer(): { layers: AnnotationLayer[]; targetId: string } {
    let layers = doc.layers;
    let targetId = activeLayer?.id ?? riffLayers[0]?.id ?? null;
    if (!targetId) {
      const fresh = newRiffPatternLayer(`Riff Patterns ${riffLayers.length + 1}`, pickDefaultLayerColor(doc.layers));
      layers = [...layers, fresh];
      targetId = fresh.id;
      onSelectLayer?.(targetId);
    }
    return { layers, targetId };
  }

  function addInstance() {
    const { layers, targetId } = pickOrCreateLayer();
    const layer = layers.find((l) => l.id === targetId) as AnnotationLayer<'riff-patterns'> | undefined;
    const existingItems = (layer?.items ?? []) as RiffPatternItem[];
    const defaultLen = 4;
    const start = snapT(markTime());
    const end = Math.min(start + defaultLen, duration > 0 ? duration : start + defaultLen);
    const item = newRiffPatternItem(start, end, `Instance ${existingItems.length + 1}`);
    const next = [...existingItems, item];
    onDocChange({
      ...doc,
      layers: layers.map((l) =>
        l.id === targetId ? ({ ...l, items: next } as AnnotationLayer) : l,
      ),
    });
    onFocusInstance?.({ layerId: targetId, itemId: item.id });
    setExpandedInstanceId(item.id);
    onClearPendingSelection?.();
  }

  function confirmPendingAsInstance(forcedLayerId: string | null) {
    if (!pendingRange) return;
    const { start, end } = pendingRange;
    const { layers, targetId } = pickOrCreateLayer();
    const layer = layers.find((l) => l.id === (forcedLayerId ?? targetId)) as AnnotationLayer<'riff-patterns'> | undefined;
    const realTargetId = forcedLayerId ?? targetId;
    const existingItems = (layer?.items ?? []) as RiffPatternItem[];
    const item = newRiffPatternItem(start, end, `Instance ${existingItems.length + 1}`);
    const next = [...existingItems, item];
    onDocChange({
      ...doc,
      layers: layers.map((l) =>
        l.id === realTargetId ? ({ ...l, items: next } as AnnotationLayer) : l,
      ),
    });
    onFocusInstance?.({ layerId: realTargetId, itemId: item.id });
    setExpandedInstanceId(item.id);
    onClearPendingSelection?.();
  }

  function patchInstance(itemId: string, patch: Partial<RiffPatternItem>) {
    if (!activeLayer) return;
    patchLayer(activeLayer.id, {
      items: items.map((it) => (it.id === itemId ? { ...it, ...patch } : it)) as any,
    });
  }

  function deleteInstance(itemId: string) {
    if (!activeLayer) return;
    patchLayer(activeLayer.id, {
      items: items.filter((it) => it.id !== itemId) as any,
    });
    if (focusedInstance?.itemId === itemId) onFocusInstance?.(null);
    if (expandedInstanceId === itemId) setExpandedInstanceId(null);
  }

  /** Backs the toolbar's "+" caret kind picker (Node / Blocks / Combo /
   *  Instance). Both node kinds self-consume a pending viz-selection as a
   *  length hint (see addNode); Instance adopts a pending range as its span
   *  via confirmPendingAsInstance, or falls back to a fixed-length instance
   *  at the playhead; Combo has no timeline placement, so a pending range is
   *  just discarded rather than consumed. */
  function addKind(kindId: string) {
    const hasRange = pendingRange != null;
    if (kindId === 'instance') {
      if (hasRange) confirmPendingAsInstance(null);
      else addInstance();
      return;
    }
    if (kindId === 'combo') {
      addCombo();
      if (hasRange) onClearPendingSelection?.();
      return;
    }
    addNode(kindId === 'boundary-node' ? 'boundary' : 'grid');
  }

  // ── layer-level mutations ────────────────────────────────────────────────
  function addLayer() {
    const layer = newRiffPatternLayer(`Riff Patterns ${riffLayers.length + 1}`, pickDefaultLayerColor(doc.layers));
    onDocChange({ ...doc, layers: [...doc.layers, layer] });
    onSelectLayer?.(layer.id);
  }

  const setStatus = useCallback((stage: AnnotationStage) => {
    onDocChange(setLayerStatus(doc, 'riff-patterns', stage));
  }, [doc, onDocChange]);

  const deleteAll = useCallback(() => {
    onDocChange({ ...doc, layers: doc.layers.filter((l) => l.type !== 'riff-patterns') });
    onFocusInstance?.(null);
    onSelectLayer?.(null);
  }, [doc, onDocChange, onFocusInstance, onSelectLayer]);

  // ── controller ───────────────────────────────────────────────────────────
  useImperativeHandle<AnnotationPanelController, AnnotationPanelController>(controllerRef, () => ({
    setStatus,
    addAtPlayhead: () => addNode(),
    addAtPlayheadInLayer: () => addNode(),
    addKind,
    addLayer,
    confirmPending: () => confirmPendingAsInstance(null),
    confirmPendingInLayer: (id) => confirmPendingAsInstance(id),
    commitItemRange: (start, end) => {
      const { layers, targetId } = pickOrCreateLayer();
      const layer = layers.find((l) => l.id === targetId) as AnnotationLayer<'riff-patterns'> | undefined;
      const existingItems = (layer?.items ?? []) as RiffPatternItem[];
      const item = newRiffPatternItem(start, end, `Instance ${existingItems.length + 1}`);
      onDocChange({
        ...doc,
        layers: layers.map((l) =>
          l.id === targetId ? ({ ...l, items: [...existingItems, item] } as AnnotationLayer) : l,
        ),
      });
      onFocusInstance?.({ layerId: targetId, itemId: item.id });
      setExpandedInstanceId(item.id);
    },
    deleteAll,
  }), [setStatus, addCombo, addInstance, addLayer, confirmPendingAsInstance, deleteAll]);

  // ── capabilities ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!onCapabilitiesChange) return;
    onCapabilitiesChange({
      ...emptyCapabilities(),
      status: getLayerStatus(doc, 'riff-patterns'),
      hasItems: totalItems > 0,
      saveStatus,
      snapBoundaryVisible: true,
      canMarkIn: true,
      canMarkOut: pendingSelection !== null && pendingSelection !== undefined && pendingSelection.t2 === null,
      snapStartLabel: `@ ${fmtTime(currentTime)}`,
      snapEndLabel:   `@ ${fmtTime(currentTime)}`,
      canAddAtPlayhead: true,
      addLabel: `+ Add node @ ${fmtTime(currentTime)}`,
      canAddLayer: true,
      pending: pendingSelection ?? null,
      pendingRequiresRegion: true,
      canExport: false,
      canDeleteAll: riffLayers.length > 0,
    });
  }, [onCapabilitiesChange, doc, saveStatus, currentTime, pendingSelection, totalItems, riffLayers.length]);

  const sortedItems = useMemo(
    () => items.slice().sort((a, b) => a.start - b.start),
    [items],
  );

  const rowNumberById = useMemo(() => {
    const m = new Map<string, number>();
    sortedItems.forEach((it, i) => m.set(it.id, i + 1));
    return m;
  }, [sortedItems]);

  /** Keeps each item's persisted `duplicateOfId` in sync with the live
   *  content-equality computation, so "instance #4 is an exact repeat of #1"
   *  is saved into the document itself (see the field's doc comment) rather
   *  than existing only as this panel's "same as #N" badge. */
  useEffect(() => {
    if (!activeLayer) return;
    const computed = computeRiffDuplicates(items);
    let changed = false;
    const nextItems = items.map((it) => {
      const dup = computed.get(it.id);
      if (dup === it.duplicateOfId) return it;
      changed = true;
      return { ...it, duplicateOfId: dup };
    });
    if (changed) patchLayer(activeLayer.id, { items: nextItems as any });
  }, [items, activeLayer]);

  // ── render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-1">
      {/* layer header */}
      <div className="flex items-center gap-2 mb-2">
        <div
          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: activeLayer?.color ?? '#94a3b8' }}
        />
        {activeLayer ? (
          <input
            className="flex-1 bg-transparent text-[11px] text-slate-200 border-none outline-none focus:underline decoration-slate-600 truncate"
            value={activeLayer.name}
            onChange={(e) => patchLayer(activeLayer.id, { name: e.target.value })}
          />
        ) : (
          <span className="text-[11px] text-slate-500 italic">No layer — add one below</span>
        )}
        {activeLayer && (
          <button
            type="button"
            onClick={() => deleteLayer(activeLayer.id)}
            className="text-[9px] text-slate-600 hover:text-red-400 transition-colors ml-auto"
            title="Delete layer"
          >
            ✕
          </button>
        )}
      </div>

      {/* ── NODES ────────────────────────────────────────────────────────── */}
      <SectionHeader
        title="Nodes" count={nodes.length}
        open={nodesOpen} onToggle={() => setNodesOpen((v) => !v)}
        onAdd={() => addNode('grid')}
        extraAdd={{
          label: '+ Blocks',
          title: 'New boundary node — free-form blocks in beats, no sub-beat grid',
          onAdd: () => addNode('boundary'),
        }}
      />
      {nodesOpen && (
        <div className="space-y-0.5 pl-1">
          {/* built-in silence entry */}
          <div className="flex items-center gap-2 px-2 py-1 rounded text-[11px] text-slate-500 bg-white/[0.02]">
            <span className="w-3 h-3 rounded-full border border-dashed border-slate-600" />
            <span className="italic">(silence)</span>
            <span className="ml-auto text-[9px]">built-in</span>
          </div>
          {nodes.map((node) => (
            <div key={node.id} className="rounded bg-white/[0.03]">
              <div className="flex items-center gap-2 px-2 py-1">
                <span
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{ backgroundColor: node.color }}
                />
                <input
                  className="flex-1 bg-transparent text-[11px] text-slate-200 border-none outline-none min-w-0"
                  value={node.name}
                  onChange={(e) => patchNode(node.id, { name: e.target.value })}
                />
                {isBoundaryNode(node) && (
                  <span
                    className="text-[8px] uppercase tracking-wider text-slate-500 border border-white/[0.08] rounded px-1 py-px flex-shrink-0"
                    title="Boundary node — free-form blocks in beats, not a sub-beat grid"
                  >
                    blocks
                  </span>
                )}
                <button
                  type="button"
                  className="text-[9px] text-slate-500 hover:text-slate-200 transition-colors"
                  onClick={(e) => activeLayer && onEditNode(activeLayer.id, node.id, { x: e.clientX, y: e.clientY })}
                  title="Edit this node"
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="text-[9px] text-slate-600 hover:text-red-400 transition-colors"
                  onClick={() => deleteNode(node.id)}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
          {nodes.length === 0 && (
            <div className="text-[10px] text-slate-600 italic px-2 py-1">
              No nodes yet — add one to start building combos
            </div>
          )}
        </div>
      )}

      {/* ── COMBOS ───────────────────────────────────────────────────────── */}
      <SectionHeader
        title="Combos" count={combos.length}
        open={combosOpen} onToggle={() => setCombosOpen((v) => !v)}
        onAdd={addCombo}
      />
      {combosOpen && (
        <div className="space-y-0.5 pl-1">
          {combos.map((combo) => {
            const forbidden = reachableCombos(combo.id, combos);
            return (
              <div key={combo.id} className="rounded bg-white/[0.03]">
                <div className="flex items-center gap-2 px-2 py-1">
                  <span
                    className="w-3 h-3 rounded-sm flex-shrink-0 text-[7px] font-bold text-white flex items-center justify-center"
                    style={{ backgroundColor: combo.color ?? '#475569' }}
                  />
                  <input
                    className="w-24 bg-transparent text-[11px] text-slate-200 border-none outline-none min-w-0"
                    value={combo.name}
                    onChange={(e) => patchCombo(combo.id, { name: e.target.value })}
                  />
                  {/* mini chip preview */}
                  <div className="flex items-center gap-0.5 flex-1 flex-wrap overflow-hidden">
                    {combo.sequence.map((entry, i) => (
                      <SeqChip key={`${entry.type}-${i}`} id={entry.type} nodes={nodes} combos={combos} />
                    ))}
                    {combo.sequence.length === 0 && (
                      <span className="text-[9px] text-slate-600 italic">empty</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="text-[9px] text-slate-500 hover:text-slate-200 transition-colors"
                    onClick={() => setExpandedComboId((v) => v === combo.id ? null : combo.id)}
                  >
                    {expandedComboId === combo.id ? '▲' : '▼'}
                  </button>
                  <button
                    type="button"
                    className="text-[9px] text-slate-600 hover:text-red-400 transition-colors"
                    onClick={() => deleteCombo(combo.id)}
                  >
                    ✕
                  </button>
                </div>
                {expandedComboId === combo.id && (
                  <div className="px-2 pb-2 space-y-1.5">
                    <div className="text-[9px] text-slate-500 uppercase tracking-wider">Sequence</div>
                    <div className="flex items-center gap-1 flex-wrap">
                      {combo.sequence.map((entry, i) => (
                        <SeqChipRow
                          key={`${entry.type}-${i}`} id={entry.type} nodes={nodes} combos={combos}
                          onRemove={() => patchCombo(combo.id, {
                            sequence: combo.sequence.filter((_, idx) => idx !== i),
                          })}
                          onEditNode={(nodeId, e) => activeLayer && onEditNode(activeLayer.id, nodeId, { x: e.clientX, y: e.clientY })}
                        />
                      ))}
                      <div className="relative">
                        <button
                          type="button"
                          className="text-[9px] text-slate-500 hover:text-slate-200 border border-dashed border-slate-700 hover:border-slate-500 rounded px-1.5 py-0.5 transition-colors"
                          onClick={() => setComboSeqMenu((v) => v === combo.id ? null : combo.id)}
                        >
                          + Add
                        </button>
                        {comboSeqMenu === combo.id && (
                          <AddToSeqMenu
                            nodes={nodes} combos={combos}
                            excludeComboIds={forbidden}
                            onAdd={(id) => patchCombo(combo.id, {
                              sequence: [...combo.sequence, newRiffSeqEntry(id, defaultRiffEntryLength(id, nodes, combos))],
                            })}
                            onClose={() => setComboSeqMenu(null)}
                            onCreateNode={createBareNode}
                            onCreateCombo={createBareCombo}
                          />
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {combos.length === 0 && (
            <div className="text-[10px] text-slate-600 italic px-2 py-1">
              No combos yet — add one to sequence nodes together
            </div>
          )}
        </div>
      )}

      {/* ── INSTANCES ────────────────────────────────────────────────────── */}
      <SectionHeader
        title="Instances" count={items.length}
        open={instancesOpen} onToggle={() => setInstancesOpen((v) => !v)}
        onAdd={() => (pendingRange ? confirmPendingAsInstance(null) : addInstance())}
        addLabel={pendingRange
          ? `+ Add ${fmtTime(pendingRange.start)}–${fmtTime(pendingRange.end)}`
          : `+ Add @ ${fmtTime(currentTime)}`}
        addTitle={pendingRange
          ? 'Add an instance spanning the highlighted region'
          : 'Add a 4-second instance at the playhead — highlight a region first to place one there instead'}
      />
      {instancesOpen && (
        <div className="space-y-0.5 pl-1">
          {sortedItems.map((item, idx) => {
            const dupOf = item.duplicateOfId ? rowNumberById.get(item.duplicateOfId) : undefined;
            return (
            <div key={item.id} className="rounded bg-white/[0.03]">
              <div className="flex items-center gap-2 px-2 py-1">
                <span className="text-[9px] font-mono text-slate-600 w-5 text-right flex-shrink-0">#{idx + 1}</span>
                <span className="text-[10px] font-mono text-slate-400 whitespace-nowrap">
                  {fmtTime(item.start)}–{fmtTime(item.end)}
                </span>
                {/* mini sequence preview */}
                <div className="flex items-center gap-0.5 flex-1 overflow-hidden">
                  {item.sequence.map((entry, i) => (
                    <SeqChip key={`${entry.type}-${i}`} id={entry.type} nodes={nodes} combos={combos} />
                  ))}
                  {item.sequence.length === 0 && (
                    <span className="text-[9px] text-slate-600 italic">empty</span>
                  )}
                </div>
                <span className="text-[10px] font-semibold text-slate-300 whitespace-nowrap">×{item.repeatCount}</span>
                {dupOf != null && (
                  <span
                    className="text-[9px] text-amber-400/90 whitespace-nowrap"
                    title={`Same sequence and repeat count as Instance #${dupOf} — renders identical content; saved in the document as duplicateOfId`}
                  >
                    ≡ same as #{dupOf}
                  </span>
                )}
                <button
                  type="button"
                  className="text-[9px] text-slate-500 hover:text-slate-200 transition-colors"
                  onClick={() => setExpandedInstanceId((v) => v === item.id ? null : item.id)}
                >
                  {expandedInstanceId === item.id ? '▲' : '▼'}
                </button>
                <button
                  type="button"
                  className="text-[9px] text-slate-600 hover:text-red-400 transition-colors"
                  onClick={() => deleteInstance(item.id)}
                >
                  ✕
                </button>
              </div>
              {expandedInstanceId === item.id && (
                <div className="px-2 pb-2 space-y-2">
                  <div className="flex items-center gap-2">
                    <label className="text-[9px] text-slate-500 uppercase tracking-wider w-10">Label</label>
                    <input
                      className="flex-1 bg-white/5 rounded px-2 py-0.5 text-[11px] text-slate-200 border-none outline-none"
                      value={item.label}
                      onChange={(e) => patchInstance(item.id, { label: e.target.value })}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-[9px] text-slate-500 uppercase tracking-wider w-10">Repeat</label>
                    <input
                      type="number" min={1} max={64} step={1}
                      className="w-16 bg-white/5 rounded px-2 py-0.5 text-[11px] text-slate-200 border-none outline-none text-center"
                      value={item.repeatCount}
                      onChange={(e) => patchInstance(item.id, {
                        repeatCount: Math.max(1, Math.floor(Number(e.target.value) || 1)),
                      })}
                    />
                    <span className="text-[9px] text-slate-600">×</span>
                  </div>
                  <div>
                    <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-1">Sequence</div>
                    <div className="flex items-center gap-1 flex-wrap">
                      {item.sequence.map((entry, i) => (
                        <SeqChipRow
                          key={`${entry.type}-${i}`} id={entry.type} nodes={nodes} combos={combos}
                          onRemove={() => patchInstance(item.id, {
                            sequence: item.sequence.filter((_, idx) => idx !== i),
                          })}
                          onEditNode={(nodeId, e) => activeLayer && onEditNode(activeLayer.id, nodeId, { x: e.clientX, y: e.clientY })}
                        />
                      ))}
                      <div className="relative">
                        <button
                          type="button"
                          className="text-[9px] text-slate-500 hover:text-slate-200 border border-dashed border-slate-700 hover:border-slate-500 rounded px-1.5 py-0.5 transition-colors"
                          onClick={() => setInstSeqMenu((v) => v === item.id ? null : item.id)}
                        >
                          + Add
                        </button>
                        {instSeqMenu === item.id && (
                          <AddToSeqMenu
                            nodes={nodes} combos={combos}
                            onAdd={(id) => patchInstance(item.id, {
                              sequence: [...item.sequence, newRiffSeqEntry(id, defaultRiffEntryLength(id, nodes, combos))],
                            })}
                            onClose={() => setInstSeqMenu(null)}
                            onCreateNode={createBareNode}
                            onCreateCombo={createBareCombo}
                          />
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-[9px] text-slate-500 uppercase tracking-wider w-10">Start</label>
                    <span className="font-mono text-[10px] text-slate-300">{fmtTime(item.start)}</span>
                    <button
                      type="button"
                      className="text-[9px] text-slate-500 hover:text-slate-200 transition-colors ml-1"
                      title={endFollowsSequence(item)
                        ? 'Move this instance to the playhead — the end follows, so its length is unchanged'
                        : 'Move this instance’s start to the playhead'}
                      // With the end derived, start is free to land anywhere and
                      // the cycle re-forms around it; only a hand-placed end has
                      // to be defended against a start that overruns it.
                      onClick={() => {
                        const at = snapT(markTime());
                        patchInstance(item.id, {
                          start: endFollowsSequence(item)
                            ? Math.max(0, at)
                            : Math.min(at, item.end - 0.05),
                        });
                      }}
                    >
                      ⊙ snap
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-[9px] text-slate-500 uppercase tracking-wider w-10">End</label>
                    <span className="font-mono text-[10px] text-slate-300">{fmtTime(item.end)}</span>
                    {/* End is derived from the sequence wherever there's a tempo
                        grid to derive it on (see RiffPatternItem), so offering
                        to snap it there would be offering a control that gets
                        overwritten the moment it's used. */}
                    {endFollowsSequence(item) ? (
                      <span
                        className="text-[9px] text-slate-500 ml-1"
                        title="The cycle is exactly as long as the sequence plays for, so the end follows it — drag a block's right edge on the lane to make the sequence itself longer or shorter."
                      >
                        ↳ follows the sequence
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="text-[9px] text-slate-500 hover:text-slate-200 transition-colors ml-1"
                        onClick={() => patchInstance(item.id, { end: Math.max(snapT(markTime()), item.start + 0.05) })}
                      >
                        ⊙ snap
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
            );
          })}
          {items.length === 0 && (
            <div className="text-[10px] text-slate-600 italic px-2 py-1">
              No instances yet — drag a region on the timeline or click "+ Add"
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const RiffPatternEditorPanel = forwardRef<AnnotationPanelController, RiffPatternEditorPanelProps>(
  RiffPatternEditorPanelInner,
);
