/**
 * PatternEditorPanel — controlled editor for Pattern annotation layers.
 *
 * A Pattern is a labeled interval (one cycle) that visualises as
 * `repeatCount` tiled copies on the row. Inside the cycle, a sub-beat grid
 * (beatsPerBar × 4 chips — 16 for 4/4, 12 for 3/4 …) lets the annotator
 * toggle which 16th-note positions the pattern accents — those highlighted
 * steps are scheduled as audio ticks during playback.
 *
 * Mirrors Cues / Spans / Loops: only the currently-selected layer's items
 * render below the waveform as horizontal cards. The sub-beat chip picker
 * and description live in a "detail panel" beneath the cards when one is
 * selected — the chip grid needs more horizontal room than fits inside the
 * compact 108 px card width.
 *
 * Gated by the experimentalLoopsAndPatterns Settings flag (same as Loops).
 */

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, forwardRef, type ForwardedRef } from 'react';
import type {
  AnnotationLayer,
  AnnotationLayersDocument,
  AnnotationStage,
  PatternItem,
} from '../../types/annotationLayer';
import {
  PATTERN_SUBBEATS_PER_BEAT,
  getLayerStatus,
  newPatternItem,
  newPatternLayer,
  resolvePatternSteps,
  pickDefaultLayerColor,
  setLayerStatus,
} from '../../types/annotationLayer';
import { snapToBeat, type BarGrid } from '../../utils/barSnap';
import type { PendingSelection } from './AnnotationOverlays';
import type { AnnotationPanelCapabilities, AnnotationPanelController } from './shared/AnnotationPanelController';
import { emptyCapabilities } from './shared/AnnotationPanelController';
import { PatternItemCard } from './PatternItemCard';
import { AddItemAtEndCard } from './ItemCard';
import { LayerModePicker } from './LayerModePicker';

interface PatternEditorPanelProps {
  currentTime: number;
  duration: number;
  doc: AnnotationLayersDocument;
  onDocChange: (next: AnnotationLayersDocument) => void;
  grid: Partial<BarGrid> | null;
  snapToGrid?: boolean;
  focusedPattern?: { layerId: string; itemId: string } | null;
  onFocusPattern?: (selection: { layerId: string; itemId: string } | null) => void;
  selectedLayerId?: string | null;
  onSelectLayer?: (layerId: string | null) => void;
  playingPatternId?: string | null;
  onPlayPattern?: (itemId: string, start: number, end: number) => void;
  onStopPattern?: () => void;
  pendingSelection?: PendingSelection | null;
  onClearPendingSelection?: () => void;
  onCapabilitiesChange?: (caps: AnnotationPanelCapabilities) => void;
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error';
}

function fmtTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '0:00.0';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function PatternEditorPanelInner(
  {
    currentTime, duration, doc, onDocChange, grid,
    snapToGrid = false,
    focusedPattern, onFocusPattern,
    selectedLayerId = null, onSelectLayer,
    playingPatternId, onPlayPattern, onStopPattern,
    pendingSelection, onClearPendingSelection,
    onCapabilitiesChange,
    saveStatus = 'idle',
  }: PatternEditorPanelProps,
  controllerRef: ForwardedRef<AnnotationPanelController>,
) {
  const patternLayers = useMemo(
    () => doc.layers.filter((l): l is AnnotationLayer<'patterns'> => l.type === 'patterns'),
    [doc.layers],
  );
  const totalCount = useMemo(
    () => patternLayers.reduce((acc, l) => acc + l.items.length, 0),
    [patternLayers],
  );

  const activeLayer = useMemo<AnnotationLayer<'patterns'> | null>(() => {
    if (selectedLayerId) {
      const hit = patternLayers.find((l) => l.id === selectedLayerId);
      if (hit) return hit;
    }
    return patternLayers[0] ?? null;
  }, [patternLayers, selectedLayerId]);

  useEffect(() => {
    if (!onSelectLayer) return;
    if (activeLayer && activeLayer.id !== selectedLayerId) {
      onSelectLayer(activeLayer.id);
    }
  }, [activeLayer, selectedLayerId, onSelectLayer]);

  function patchLayer(layerId: string, patch: Partial<AnnotationLayer<'patterns'>>) {
    onDocChange({
      ...doc,
      layers: doc.layers.map((l) => (l.id === layerId ? ({ ...l, ...patch } as AnnotationLayer) : l)),
    });
  }

  function deleteLayer(layerId: string) {
    onDocChange({ ...doc, layers: doc.layers.filter((l) => l.id !== layerId) });
    if (focusedPattern?.layerId === layerId) onFocusPattern?.(null);
    if (selectedLayerId === layerId) onSelectLayer?.(null);
  }

  function patchItem(layerId: string, itemId: string, patch: Partial<PatternItem>) {
    onDocChange({
      ...doc,
      layers: doc.layers.map((l) =>
        l.id === layerId
          ? { ...l, items: l.items.map((it) => (it.id === itemId ? ({ ...it, ...patch } as PatternItem) : it)) }
          : l,
      ),
    });
  }

  function deleteItem(layerId: string, itemId: string) {
    onDocChange({
      ...doc,
      layers: doc.layers.map((l) =>
        l.id === layerId ? { ...l, items: l.items.filter((it) => it.id !== itemId) } : l,
      ),
    });
    if (focusedPattern?.itemId === itemId) onFocusPattern?.(null);
  }

  function snapStartToPlayhead(layerId: string, itemId: string) {
    const item = patternLayers.find((l) => l.id === layerId)?.items.find((i) => i.id === itemId);
    if (!item) return;
    const t = snapToGrid && grid?.bpm ? snapToBeat(currentTime, grid as BarGrid) : currentTime;
    patchItem(layerId, itemId, { start: Math.min(t, item.end - 0.05) });
  }

  function snapEndToPlayhead(layerId: string, itemId: string) {
    const item = patternLayers.find((l) => l.id === layerId)?.items.find((i) => i.id === itemId);
    if (!item) return;
    const t = snapToGrid && grid?.bpm ? snapToBeat(currentTime, grid as BarGrid) : currentTime;
    patchItem(layerId, itemId, { end: Math.max(t, item.start + 0.05) });
  }

  // ── Pending selection → "+ Add pattern" pill ─────────────────────────────
  const pendingPattern = pendingSelection && pendingSelection.t2 !== null
    ? { start: Math.min(pendingSelection.t1, pendingSelection.t2), end: Math.max(pendingSelection.t1, pendingSelection.t2) }
    : null;

  const pickPatternTarget = useCallback((forcedLayerId: string | null): { layers: AnnotationLayer[]; targetId: string } => {
    let layers = doc.layers;
    let targetId: string | null = null;
    if (forcedLayerId && patternLayers.some((l) => l.id === forcedLayerId)) targetId = forcedLayerId;
    else if (selectedLayerId && patternLayers.some((l) => l.id === selectedLayerId)) targetId = selectedLayerId;
    else if (activeLayer) targetId = activeLayer.id;
    else if (focusedPattern?.layerId && patternLayers.some((l) => l.id === focusedPattern.layerId)) targetId = focusedPattern.layerId;
    else targetId = patternLayers[0]?.id ?? null;
    if (!targetId) {
      const fresh = newPatternLayer(`Patterns ${patternLayers.length + 1}`, pickDefaultLayerColor(doc.layers));
      layers = [...layers, fresh];
      targetId = fresh.id;
    }
    return { layers, targetId };
  }, [doc.layers, patternLayers, selectedLayerId, activeLayer, focusedPattern]);

  const confirmPendingForLayer = useCallback((forcedLayerId: string | null) => {
    if (!pendingPattern) return;
    const start = Math.max(0, pendingPattern.start);
    const end   = Math.min(duration > 0 ? duration : pendingPattern.end, pendingPattern.end);
    if (end - start < 0.05) { onClearPendingSelection?.(); return; }
    const item = newPatternItem(start, end);
    const { layers, targetId } = pickPatternTarget(forcedLayerId);
    onDocChange({
      ...doc,
      layers: layers.map((l) => (l.id === targetId
        ? ({ ...l, items: [...(l as AnnotationLayer<'patterns'>).items, item] } as AnnotationLayer)
        : l)),
    });
    onFocusPattern?.({ layerId: targetId, itemId: item.id });
    onSelectLayer?.(targetId);
    onClearPendingSelection?.();
  }, [pendingPattern, duration, doc, pickPatternTarget, onDocChange, onFocusPattern, onSelectLayer, onClearPendingSelection]);

  const confirmPendingSelection = useCallback(() => { confirmPendingForLayer(null); }, [confirmPendingForLayer]);
  const confirmPendingInLayer = useCallback((id: string) => { confirmPendingForLayer(id); }, [confirmPendingForLayer]);

  const commitItemRange = useCallback((start: number, end: number) => {
    const s = Math.max(0, Math.min(start, end));
    const eRaw = Math.max(start, end);
    const e = duration > 0 ? Math.min(duration, eRaw) : eRaw;
    if (e - s < 0.05) return;
    const item = newPatternItem(s, e);
    const { layers, targetId } = pickPatternTarget(null);
    onDocChange({
      ...doc,
      layers: layers.map((l) => (l.id === targetId
        ? ({ ...l, items: [...(l as AnnotationLayer<'patterns'>).items, item] } as AnnotationLayer)
        : l)),
    });
    onFocusPattern?.({ layerId: targetId, itemId: item.id });
    onSelectLayer?.(targetId);
  }, [doc, duration, pickPatternTarget, onDocChange, onFocusPattern, onSelectLayer]);

  // Patterns are NOT splittable from the toolbar — `start`/`end` describe one
  // cycle that's tiled `repeatCount` times; splitting at the playhead inside
  // the cycle would produce two patterns with non-integer repeat counts and
  // break the chip-set semantics. The toolbar hides Split for this type.
  const setPatternsStage = useCallback((stage: AnnotationStage) => {
    onDocChange(setLayerStatus(doc, 'patterns', stage));
  }, [doc, onDocChange]);

  const exportPatternsJson = useCallback(() => {
    const slice: AnnotationLayersDocument = { ...doc, layers: patternLayers };
    const blob = new Blob([JSON.stringify(slice, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `patterns-all_layers-${doc.song}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [doc, patternLayers]);

  const importPatternsJson = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse((ev.target?.result as string) ?? '') as Partial<AnnotationLayersDocument>;
        const incoming = (parsed.layers ?? []).filter((l): l is AnnotationLayer<'patterns'> => l.type === 'patterns');
        const remaining = doc.layers.filter((l) => l.type !== 'patterns');
        onDocChange({ ...doc, layers: [...remaining, ...incoming] });
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Could not parse JSON.');
      }
    };
    reader.readAsText(file);
  }, [doc, onDocChange]);

  const deleteAllPatterns = useCallback(() => {
    onDocChange({ ...doc, layers: doc.layers.filter((l) => l.type !== 'patterns') });
    onFocusPattern?.(null);
  }, [doc, onDocChange, onFocusPattern]);

  // Add a 1-bar pattern (one cycle) at the playhead — falls back to a 2-second
  // cycle when no BPM grid is set.
  const addPatternForLayer = useCallback((forcedLayerId: string | null) => {
    const safeGrid = grid?.bpm && grid.beatsPerBar
      ? { bpm: grid.bpm, beatsPerBar: grid.beatsPerBar, gridOffsetSec: grid.gridOffsetSec ?? 0 }
      : null;
    const barLen = safeGrid ? (60 / safeGrid.bpm) * safeGrid.beatsPerBar : 2;
    const start = currentTime;
    let end = start + barLen;
    if (duration > 0 && end > duration) end = duration;
    if (end - start < 0.05) return;
    const { layers, targetId } = pickPatternTarget(forcedLayerId);
    const item = newPatternItem(start, end);
    onDocChange({
      ...doc,
      layers: layers.map((l) => (l.id === targetId
        ? ({ ...l, items: [...(l as AnnotationLayer<'patterns'>).items, item] } as AnnotationLayer)
        : l)),
    });
    onFocusPattern?.({ layerId: targetId, itemId: item.id });
    onSelectLayer?.(targetId);
  }, [doc, pickPatternTarget, grid, currentTime, duration, onDocChange, onFocusPattern, onSelectLayer]);

  const addPatternAtPlayhead = useCallback(() => { addPatternForLayer(null); }, [addPatternForLayer]);
  const addPatternAtPlayheadInLayer = useCallback((id: string) => { addPatternForLayer(id); }, [addPatternForLayer]);

  const addPatternLayerViaToolbar = useCallback(() => {
    const layer = newPatternLayer(`Patterns ${patternLayers.length + 1}`, pickDefaultLayerColor(doc.layers));
    onDocChange({ ...doc, layers: [...doc.layers, layer] });
    onSelectLayer?.(layer.id);
  }, [doc, patternLayers.length, onDocChange, onSelectLayer]);

  const deleteFocusedPattern = useCallback(() => {
    if (!focusedPattern) return;
    const layerId = focusedPattern.layerId;
    const itemId = focusedPattern.itemId;
    onDocChange({
      ...doc,
      layers: doc.layers.map((l) =>
        l.id === layerId
          ? ({ ...l, items: (l.items as PatternItem[]).filter((it) => it.id !== itemId) } as AnnotationLayer)
          : l,
      ),
    });
    onFocusPattern?.(null);
  }, [doc, focusedPattern, onDocChange, onFocusPattern]);

  useImperativeHandle<AnnotationPanelController, AnnotationPanelController>(controllerRef, () => ({
    setStatus: setPatternsStage,
    addAtPlayhead: addPatternAtPlayhead,
    addAtPlayheadInLayer: addPatternAtPlayheadInLayer,
    addLayer: addPatternLayerViaToolbar,
    confirmPending: confirmPendingSelection,
    confirmPendingInLayer,
    commitItemRange,
    exportJson: exportPatternsJson,
    importJson: importPatternsJson,
    deleteAll: deleteAllPatterns,
    deleteFocused: deleteFocusedPattern,
  }), [setPatternsStage, addPatternAtPlayhead, addPatternAtPlayheadInLayer,
       addPatternLayerViaToolbar,
       confirmPendingSelection, confirmPendingInLayer, commitItemRange, exportPatternsJson,
       importPatternsJson, deleteAllPatterns, deleteFocusedPattern]);

  useEffect(() => {
    if (!onCapabilitiesChange) return;
    onCapabilitiesChange({
      ...emptyCapabilities(),
      status: getLayerStatus(doc, 'patterns'),
      hasItems: totalCount > 0,
      saveStatus,
      canUndo: false,
      canRedo: false,
      canSplit: false,
      splitVisible: false,
      splitLabel: 'Split',
      snapBoundaryVisible: true,
      canMarkIn: true,
      canMarkOut: false,
      snapStartLabel: `@ ${fmtTime(currentTime)}`,
      snapEndLabel: `@ ${fmtTime(currentTime)}`,
      canAddAtPlayhead: true,
      addLabel: `+ Add pattern @ ${fmtTime(currentTime)}`,
      canAddLayer: true,
      pending: pendingSelection ?? null,
      pendingRequiresRegion: true,
      importFormats: ['json'],
      canExport: totalCount > 0,
      canDeleteAll: patternLayers.length > 0,
    });
  }, [onCapabilitiesChange, doc, saveStatus, currentTime, pendingSelection, totalCount, patternLayers.length]);

  const sortedItems = useMemo(
    () => (activeLayer?.items ?? []).slice().sort((a, b) => a.start - b.start),
    [activeLayer],
  );

  const focusedPatternInActiveLayer = activeLayer && focusedPattern?.layerId === activeLayer.id
    ? activeLayer.items.find((it) => it.id === focusedPattern.itemId) ?? null
    : null;

  const beatsPerBar = grid?.beatsPerBar ?? 4;

  return (
    <div className="space-y-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">
        {patternLayers.length} layer{patternLayers.length === 1 ? '' : 's'} · {totalCount} pattern{totalCount === 1 ? '' : 's'}
      </div>

      {activeLayer && (
        <PatternLayerToolbar
          layer={activeLayer}
          currentTime={currentTime}
          onRename={(name) => patchLayer(activeLayer.id, { name })}
          onToggleVisibility={() => patchLayer(activeLayer.id, { visible: !activeLayer.visible })}
          onChangeMode={(mode) => patchLayer(activeLayer.id, { mode })}
          onDelete={() => deleteLayer(activeLayer.id)}
          onAddPattern={addPatternAtPlayhead}
        />
      )}

      {!activeLayer ? (
        <div className="flex flex-wrap items-start gap-1">
          <AddItemAtEndCard
            onClick={addPatternAtPlayhead}
            label={`+ Add pattern @ ${fmtTime(currentTime)}`}
          />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-start gap-1 max-h-[480px] overflow-y-auto pb-1">
            {sortedItems.map((p, i) => (
              <PatternItemCard
                key={p.id}
                index={i}
                pattern={p}
                color={activeLayer.color}
                duration={duration}
                isSelected={focusedPattern?.layerId === activeLayer.id && focusedPattern.itemId === p.id}
                isPlaying={playingPatternId === p.id}
                onSelect={() => { onFocusPattern?.({ layerId: activeLayer.id, itemId: p.id }); onSelectLayer?.(activeLayer.id); }}
                onChangeLabel={(label) => patchItem(activeLayer.id, p.id, { label })}
                onSnapStart={() => snapStartToPlayhead(activeLayer.id, p.id)}
                onSnapEnd={() => snapEndToPlayhead(activeLayer.id, p.id)}
                onChangeRepeats={(n) => patchItem(activeLayer.id, p.id, { repeatCount: n })}
                onPlay={onPlayPattern ? (start, end) => onPlayPattern(p.id, start, end) : undefined}
                onStop={onStopPattern}
                onToggleImportance={() => patchItem(activeLayer.id, p.id, {
                  importance: p.importance === 'optional' ? 'critical' : 'optional',
                })}
                onDelete={() => deleteItem(activeLayer.id, p.id)}
              />
            ))}
            <AddItemAtEndCard
              onClick={addPatternAtPlayhead}
              label={`+ Add @ ${fmtTime(currentTime)}`}
            />
          </div>

          {focusedPatternInActiveLayer && (
            <PatternDetailPanel
              pattern={focusedPatternInActiveLayer}
              color={activeLayer.color}
              beatsPerBar={beatsPerBar}
              onPatchItem={(patch) => patchItem(activeLayer.id, focusedPatternInActiveLayer.id, patch)}
            />
          )}
        </>
      )}
    </div>
  );
}

// ─── Slim per-layer toolbar above the card row ─────────────────────────────

interface PatternLayerToolbarProps {
  layer: AnnotationLayer<'patterns'>;
  currentTime: number;
  onRename: (name: string) => void;
  onToggleVisibility: () => void;
  onChangeMode: (mode: import('../../types/annotationLayer').LayerEvalMode) => void;
  onDelete: () => void;
  onAddPattern: () => void;
}

function PatternLayerToolbar({
  layer, currentTime, onRename, onToggleVisibility, onChangeMode, onDelete, onAddPattern,
}: PatternLayerToolbarProps) {
  return (
    <div
      className="flex items-center gap-2 px-2 py-1 rounded bg-[#0f1116] border border-white/[0.06]"
      style={{ borderLeft: `3px solid ${layer.color}` }}
    >
      <span
        className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
        style={{ background: layer.color, boxShadow: `0 0 6px ${layer.color}66` }}
      />
      <input
        value={layer.name}
        onChange={(e) => onRename(e.target.value)}
        className="flex-1 min-w-0 bg-transparent border-0 text-[12px] text-slate-100 font-medium focus:outline-none focus:bg-white/[0.04] rounded px-1 -mx-1"
        spellCheck={false}
      />
      <span className="text-[10px] font-mono text-slate-500 shrink-0">{layer.items.length}</span>
      <LayerModePicker mode={layer.mode} onChange={onChangeMode} />
      <button
        onClick={onAddPattern}
        className="px-2 py-0.5 rounded text-[10px] uppercase tracking-wider border border-fuchsia-400/30 bg-fuchsia-500/10 text-fuchsia-200 hover:bg-fuchsia-500/20 hover:border-fuchsia-400/50 transition-colors"
        title="Add pattern at playhead — default cycle = 1 bar / 2s (M)"
      >
        + Add @ {fmtTime(currentTime)}
      </button>
      <button
        onClick={onToggleVisibility}
        className={`shrink-0 w-6 h-6 rounded flex items-center justify-center text-[11px] transition-colors ${
          layer.visible
            ? 'bg-white/[0.04] border border-white/[0.08] text-slate-300 hover:text-slate-100'
            : 'border border-white/[0.04] text-slate-700 hover:text-slate-400'
        }`}
        title={layer.visible ? 'Hide layer on canvas' : 'Show layer on canvas'}
      >
        {layer.visible ? '◉' : '○'}
      </button>
      <button
        onClick={onDelete}
        className="shrink-0 w-6 h-6 rounded flex items-center justify-center text-slate-500 hover:text-red-400 hover:bg-red-500/10 text-[12px]"
        title="Delete layer"
      >
        ✕
      </button>
    </div>
  );
}

// ─── Detail panel for the focused pattern (chip grid + description) ────────
// Lives below the card row because the chip grid (16 chips in 4/4) needs more
// horizontal room than a 108 px card can give. Renders nothing when no card
// in the active layer is currently focused.

interface PatternDetailPanelProps {
  pattern: PatternItem;
  color: string;
  beatsPerBar: number;
  onPatchItem: (patch: Partial<PatternItem>) => void;
}

function PatternDetailPanel({ pattern, color, beatsPerBar, onPatchItem }: PatternDetailPanelProps) {
  const stepsPerCycle = resolvePatternSteps(pattern, beatsPerBar);
  const cycleBeats = Math.round(stepsPerCycle / PATTERN_SUBBEATS_PER_BEAT);
  return (
    <div
      className="rounded border bg-white/[0.02] px-3 py-2 space-y-2"
      style={{
        borderColor: `${color}44`,
        borderLeft: `3px solid ${color}`,
      }}
    >
      <div className="text-[9px] uppercase tracking-wider text-slate-500">
        Pattern #{(pattern.label || 'untitled').slice(0, 40)} · sub-beats
        <span className="normal-case text-slate-600 ml-1">
          ({stepsPerCycle}/cycle = {cycleBeats} beats × {PATTERN_SUBBEATS_PER_BEAT} — click or drag to toggle)
        </span>
      </div>
      <BeatChipPicker
        color={color}
        steps={stepsPerCycle}
        highlighted={pattern.highlightedBeats}
        onChange={(next) => onPatchItem({ highlightedBeats: next })}
      />
      <BeatChipPresets
        beatsPerBar={cycleBeats}
        onApply={(next) => onPatchItem({ highlightedBeats: next })}
      />
      <label className="block">
        <span className="block text-[9px] uppercase tracking-wider text-slate-500 mb-0.5">
          Description
        </span>
        <textarea
          value={pattern.description ?? ''}
          onChange={(e) => onPatchItem({ description: e.target.value })}
          placeholder="Longer free-form note about this pattern…"
          rows={2}
          className="w-full bg-[#0a0b0d] border border-white/[0.06] rounded px-2 py-1 text-[11px] text-slate-200 placeholder-slate-700 focus:outline-none focus:ring-1 focus:ring-fuchsia-400/40 resize-none"
          spellCheck={false}
        />
      </label>
    </div>
  );
}

export const PatternEditorPanel = forwardRef<AnnotationPanelController, PatternEditorPanelProps>(PatternEditorPanelInner);
PatternEditorPanel.displayName = 'PatternEditorPanel';

// ─── BeatChipPicker (also imported by PatternEditPopover) ──────────────────

/** Sub-beat chip grid: `beatsPerBar` groups × PATTERN_SUBBEATS_PER_BEAT chips
 *  each. Every chip is independently toggleable. Down-beats (1st chip in each
 *  group) carry the beat number; off-beats show a "·" to advertise they're
 *  interactive, not decorative dividers. */
export function BeatChipPicker({ color, steps, highlighted, onChange, readOnly = false, playheadStep = null }: {
  color: string;
  /** Total sub-steps in the cycle (the index space). Grouped visually into
   *  `ceil(steps / PATTERN_SUBBEATS_PER_BEAT)` beat-groups. */
  steps: number;
  highlighted: number[];
  onChange: (next: number[]) => void;
  /** When true, chips render their highlighted state but can't be toggled —
   *  used by read-only (detector-sourced) pattern cards. */
  readOnly?: boolean;
  /** Live playhead position as a fractional sub-beat index inside the current
   *  cycle (0..steps), or null when audio isn't playing through the region.
   *  Drives the karaoke sweep: passed chips fill, hits "fire", the step under
   *  the playhead carries a ring. */
  playheadStep?: number | null;
}) {
  const total = Math.max(1, Math.floor(steps || PATTERN_SUBBEATS_PER_BEAT));
  const numBeats = Math.ceil(total / PATTERN_SUBBEATS_PER_BEAT);
  const hSet = new Set(highlighted);
  // Karaoke sweep state. `current` is the chip the playhead sits on right now;
  // every chip at or before it has "played" this cycle.
  const sweeping = playheadStep != null;
  const current = sweeping ? Math.min(total - 1, Math.max(0, Math.floor(playheadStep))) : -1;
  // Drag-paint: pointer-down on a chip latches a paint mode (the OPPOSITE of
  // the clicked chip's current state) and pointer-enter on subsequent chips
  // applies that same state. Click-to-toggle is a special case (paint mode
  // matches what onClick would've done).
  const paintingRef = useRef<'set' | 'clear' | null>(null);
  const draftRef = useRef<Set<number>>(new Set(hSet));

  const commit = (next: Set<number>) => {
    onChange(Array.from(next).sort((a, b) => a - b));
  };

  const beginPaint = (i: number) => {
    if (readOnly) return;
    const draft = new Set(hSet);
    const mode: 'set' | 'clear' = draft.has(i) ? 'clear' : 'set';
    paintingRef.current = mode;
    if (mode === 'set') draft.add(i); else draft.delete(i);
    draftRef.current = draft;
    commit(draft);
  };

  const continuePaint = (i: number) => {
    if (readOnly) return;
    const mode = paintingRef.current;
    if (!mode) return;
    const draft = draftRef.current;
    const before = draft.size;
    if (mode === 'set') draft.add(i); else draft.delete(i);
    if (draft.size !== before) commit(draft);
  };

  const endPaint = () => { paintingRef.current = null; };

  // Bail out cleanly when pointer leaves the picker entirely or button
  // released mid-air; otherwise paint mode stays latched.
  useEffect(() => {
    const onUp = () => endPaint();
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  return (
    <div className={`flex items-center gap-2 flex-wrap select-none ${readOnly ? 'pointer-events-none opacity-80' : ''}`}>
      {Array.from({ length: numBeats }, (_, beatIdx) => (
        <div key={beatIdx} className="flex items-center gap-0.5">
          {Array.from({ length: PATTERN_SUBBEATS_PER_BEAT }, (_, subIdx) => {
            const i = beatIdx * PATTERN_SUBBEATS_PER_BEAT + subIdx;
            if (i >= total) return null;
            const on = hSet.has(i);
            const isDownBeat = subIdx === 0;
            const isCurrent = sweeping && i === current;
            const passed = sweeping && i <= current; // already played this cycle
            const upcoming = sweeping && i > current; // not yet reached this cycle

            const classes = ['w-5 h-6 rounded-sm text-[9px] font-mono border cursor-pointer transition-all touch-none'];
            const style: React.CSSProperties = {};
            if (on) {
              style.background = color;
              style.borderColor = color;
              (style as Record<string, string>)['--chip-glow'] = `${color}88`;
              classes.push('text-white');
              if (passed) {
                // Hit just "fired" — punch up the glow for the karaoke flash.
                style.boxShadow = `0 0 12px ${color}, 0 0 4px ${color}`;
              } else if (upcoming) {
                // Hit hasn't been reached yet this cycle — dim it back.
                style.opacity = 0.3;
              } else {
                classes.push('shadow-[0_0_6px_var(--chip-glow)]');
              }
            } else {
              style.borderColor = isDownBeat ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.12)';
              if (passed) {
                // Empty step the sweep has crossed — faint trail so the fill reads.
                style.background = 'rgba(255,255,255,0.07)';
                classes.push(isDownBeat ? 'text-slate-300' : 'text-slate-400');
              } else {
                classes.push('bg-[#0a0b0d]');
                classes.push(isDownBeat ? 'text-slate-300 hover:text-slate-100 hover:bg-white/[0.06]' : 'text-slate-500 hover:text-slate-200 hover:bg-white/[0.06]');
              }
            }
            if (isCurrent) {
              // Playhead marker — a ring on the step playing right now.
              style.outline = `2px solid ${color}`;
              style.outlineOffset = '1px';
            }

            return (
              <button
                key={`${beatIdx}-${subIdx}`}
                type="button"
                onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); beginPaint(i); }}
                onPointerEnter={() => continuePaint(i)}
                className={classes.join(' ')}
                style={style}
                title={`Beat ${beatIdx + 1}${isDownBeat ? '' : `.${subIdx + 1}`} (16th ${i + 1}) — ${on ? 'tick will play here, click to clear' : 'click to highlight'}`}
              >
                {isDownBeat ? beatIdx + 1 : (on ? '' : '·')}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ─── Preset shortcuts for common rhythmic patterns ─────────────────────────
//
// Populate `highlightedBeats` with one click. Indices are 0-based sub-beat
// positions inside a single cycle (0..beatsPerBar*PATTERN_SUBBEATS_PER_BEAT-1).
// Down-beats are sub-beat 0 of each beat; back-beat is sub-beat 0 of beat 2/4.

interface BeatChipPresetsProps {
  beatsPerBar: number;
  onApply: (next: number[]) => void;
}

function BeatChipPresets({ beatsPerBar, onApply }: BeatChipPresetsProps) {
  const bpb = Math.max(1, Math.floor(beatsPerBar || 4));
  const sub = PATTERN_SUBBEATS_PER_BEAT;
  const allSteps = bpb * sub;

  const downbeats   = Array.from({ length: bpb }, (_, b) => b * sub);
  const backbeat    = bpb >= 4 ? [sub, 3 * sub] : [];                    // beats 2 & 4
  const offbeats    = Array.from({ length: bpb }, (_, b) => b * sub + sub / 2); // "and"
  const sixteenths  = Array.from({ length: allSteps }, (_, i) => i);
  const eighths     = Array.from({ length: bpb * 2 }, (_, i) => i * (sub / 2));

  const presets: { label: string; title: string; values: number[]; show: boolean }[] = [
    { label: 'Downbeats',  title: 'One tick per beat (1, 2, 3, …)',         values: downbeats,  show: true },
    { label: 'Backbeat',   title: 'Beats 2 and 4 (snare/clap pattern)',     values: backbeat,   show: backbeat.length > 0 },
    { label: 'Off-beats',  title: 'The "and" between each beat',            values: offbeats,   show: true },
    { label: '8ths',       title: 'Every eighth note (1 + 2 + 3 + …)',     values: eighths,    show: true },
    { label: '16ths',      title: 'Every sub-beat (busy fill)',             values: sixteenths, show: true },
  ];

  return (
    <div className="flex items-center gap-1 flex-wrap text-[9px] uppercase tracking-wider text-slate-500">
      <span className="mr-1">Presets:</span>
      {presets.filter((p) => p.show).map((p) => (
        <button
          key={p.label}
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onApply(p.values); }}
          title={p.title}
          className="px-1.5 py-0.5 rounded border border-white/[0.08] bg-white/[0.03] text-slate-400 hover:text-slate-100 hover:bg-white/[0.06] transition-colors"
        >
          {p.label}
        </button>
      ))}
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onApply([]); }}
        title="Clear every chip in this cycle"
        className="px-1.5 py-0.5 rounded border border-rose-400/20 bg-rose-500/[0.05] text-rose-300/80 hover:text-rose-200 hover:bg-rose-500/[0.12] transition-colors"
      >
        Clear
      </button>
    </div>
  );
}
