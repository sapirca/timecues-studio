/**
 * CueEditorPanel — controlled component. The parent (InspectorPageV2) owns
 * the AnnotationLayersDocument state, loads it via loadLayers() on song
 * change, and saves via debounced saveLayers() on change. This panel only
 * renders + emits doc updates through `onDocChange`.
 *
 * Multi-layer model: one panel manages N Cue layers per song, but only the
 * currently-selected layer's items are shown as horizontal cards (matches the
 * boundary editor's layout). The slim toolbar above the cards owns the
 * layer-level controls — switch active layer via the right-edge sidebar.
 */

import { useCallback, useEffect, useId, useImperativeHandle, useMemo, forwardRef, type ForwardedRef } from 'react';
import type {
  AnnotationLayer,
  AnnotationLayersDocument,
  AnnotationStage,
  CueItem,
} from '../../types/annotationLayer';
import type { PendingSelection } from './AnnotationOverlays';
import {
  getLayerStatus,
  newCueItem,
  newCueLayer,
  pickDefaultLayerColor,
  setLayerStatus,
} from '../../types/annotationLayer';
import { snapToBeat, type BarGrid } from '../../utils/barSnap';
import { useSettings } from '../../context/SettingsContext';
import type { AnnotationPanelCapabilities, AnnotationPanelController } from './shared/AnnotationPanelController';
import { emptyCapabilities } from './shared/AnnotationPanelController';
import { CueItemCard } from './CueItemCard';
import { AddItemAtEndCard } from './ItemCard';
import { LayerModePicker } from './LayerModePicker';

interface CueEditorPanelProps {
  /** Current playhead position in seconds — used when adding a cue at playhead. */
  currentTime: number;
  /** Layers document for the active song. */
  doc: AnnotationLayersDocument;
  /** Emit a new doc; parent handles persistence. */
  onDocChange: (next: AnnotationLayersDocument) => void;
  /** Optional: the cue currently focused in a canvas popover. Highlighted in the list. */
  focusedCue?: { layerId: string; itemId: string } | null;
  /** Notify parent that the user selected a cue in the list — used to keep the popover in sync. */
  onFocusCue?: (selection: { layerId: string; itemId: string } | null) => void;
  /** Page-owned "active layer" for ADD targets. When set, the matching layer
   *  card lights up and the toolbar's ADD targets it. Click a layer card to
   *  promote it; the page wires this to its `selectedCueLayerId` state. */
  selectedLayerId?: string | null;
  onSelectLayer?: (layerId: string | null) => void;
  /** Global Snap-to-grid toggle. When on, "+ Add cue @ playhead" rounds the
   *  playhead time to the nearest beat. */
  snapToGrid?: boolean;
  grid?: Partial<BarGrid> | null;
  /** Page-level subscription that fires whenever the toolbar-visible state
   *  changes. Fed to the shared AnnotationToolbar above this panel. */
  onCapabilitiesChange?: (caps: AnnotationPanelCapabilities) => void;
  /** Inline save indicator state lifted to the page (since the page owns the
   *  layers-doc save debounce). Surfaced through the shared toolbar. */
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error';
  /** Drag-range pending selection from the viz. When set with t2, the Enter
   *  shortcut (and the "+ Add" pill) commits a pair of cues at t1 and t2. */
  pendingSelection?: PendingSelection | null;
  onClearPendingSelection?: () => void;
}

function fmtTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '0:00.0';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function CueEditorPanelInner(
  {
    currentTime, doc, onDocChange, focusedCue, onFocusCue,
    selectedLayerId = null, onSelectLayer,
    snapToGrid = false, grid = null,
    onCapabilitiesChange,
    saveStatus = 'idle',
    pendingSelection = null,
    onClearPendingSelection,
  }: CueEditorPanelProps,
  controllerRef: ForwardedRef<AnnotationPanelController>,
) {
  const { settings } = useSettings();
  const taxonomyId = useId();
  const showTaxonomy = settings.cueTaxonomyEnabled && settings.cueTaxonomy.length > 0;
  const cueLayers = useMemo(
    () => doc.layers.filter((l): l is AnnotationLayer<'cues'> => l.type === 'cues'),
    [doc.layers],
  );
  const totalCount = useMemo(
    () => cueLayers.reduce((acc, l) => acc + l.items.length, 0),
    [cueLayers],
  );

  // Resolve the layer whose items render below. Falls back to the first cue
  // layer when nothing is explicitly selected (or when the prior selection
  // refers to a layer that was deleted).
  const activeLayer = useMemo<AnnotationLayer<'cues'> | null>(() => {
    if (selectedLayerId) {
      const hit = cueLayers.find((l) => l.id === selectedLayerId);
      if (hit) return hit;
    }
    return cueLayers[0] ?? null;
  }, [cueLayers, selectedLayerId]);

  // Bubble up the implicit selection so the right-sidebar's "active" pill +
  // ADD-target arithmetic stay in sync with what the editor is showing.
  useEffect(() => {
    if (!onSelectLayer) return;
    if (activeLayer && activeLayer.id !== selectedLayerId) {
      onSelectLayer(activeLayer.id);
    }
  }, [activeLayer, selectedLayerId, onSelectLayer]);

  function patchLayer(layerId: string, patch: Partial<AnnotationLayer<'cues'>>) {
    onDocChange({
      ...doc,
      layers: doc.layers.map((l) => (l.id === layerId ? ({ ...l, ...patch } as AnnotationLayer) : l)),
    });
  }

  function deleteLayer(layerId: string) {
    onDocChange({ ...doc, layers: doc.layers.filter((l) => l.id !== layerId) });
    if (focusedCue?.layerId === layerId) onFocusCue?.(null);
    if (selectedLayerId === layerId) onSelectLayer?.(null);
  }

  function addCueAtPlayhead(layerId: string) {
    const t = snapToGrid && grid?.bpm ? snapToBeat(currentTime, grid as BarGrid) : currentTime;
    const cue = newCueItem(t, '');
    onDocChange({
      ...doc,
      layers: doc.layers.map((l) =>
        l.id === layerId ? { ...l, items: [...l.items, cue] } : l,
      ),
    });
    onFocusCue?.({ layerId, itemId: cue.id });
  }

  function patchItem(layerId: string, itemId: string, patch: Partial<CueItem>) {
    onDocChange({
      ...doc,
      layers: doc.layers.map((l) =>
        l.id === layerId
          ? { ...l, items: l.items.map((it) => (it.id === itemId ? ({ ...it, ...patch } as typeof it) : it)) }
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
    if (focusedCue?.itemId === itemId) onFocusCue?.(null);
  }

  function addCandidate(layerId: string, itemId: string) {
    const t = snapToGrid && grid?.bpm ? snapToBeat(currentTime, grid as BarGrid) : currentTime;
    const layer = cueLayers.find((l) => l.id === layerId);
    const cue = layer?.items.find((it) => it.id === itemId);
    if (!cue) return;
    const next = [...(cue.candidates ?? []), t].sort((a, b) => a - b);
    patchItem(layerId, itemId, { candidates: next });
  }

  function removeCandidate(layerId: string, itemId: string, ci: number) {
    const layer = cueLayers.find((l) => l.id === layerId);
    const cue = layer?.items.find((it) => it.id === itemId);
    if (!cue) return;
    const next = (cue.candidates ?? []).filter((_, i) => i !== ci);
    patchItem(layerId, itemId, { candidates: next.length ? next : undefined });
  }

  // Trigger an add into whichever layer makes sense — used both by the local
  // toolbar button and by the trailing "+ Add" card after the cards row.
  // Auto-creates the first cue layer when none exist.
  const addCueAtLayer = useCallback((forcedLayerId: string | null) => {
    const t = snapToGrid && grid?.bpm ? snapToBeat(currentTime, grid as BarGrid) : currentTime;
    const cue = newCueItem(t, '');
    let layers = doc.layers;
    let targetLayerId: string | undefined;
    if (forcedLayerId && layers.some((l) => l.id === forcedLayerId && l.type === 'cues')) {
      targetLayerId = forcedLayerId;
    } else if (selectedLayerId && layers.some((l) => l.id === selectedLayerId && l.type === 'cues')) {
      targetLayerId = selectedLayerId;
    } else if (activeLayer) {
      targetLayerId = activeLayer.id;
    } else if (focusedCue && layers.some((l) => l.id === focusedCue.layerId && l.type === 'cues')) {
      targetLayerId = focusedCue.layerId;
    }
    if (!targetLayerId) {
      const newLayer = newCueLayer('Cues 1', pickDefaultLayerColor(layers));
      layers = [...layers, newLayer];
      targetLayerId = newLayer.id;
    }
    const finalId = targetLayerId;
    layers = layers.map((l) =>
      l.id === finalId ? { ...l, items: [...l.items, cue] } : l,
    );
    onDocChange({ ...doc, layers });
    onFocusCue?.({ layerId: finalId, itemId: cue.id });
    onSelectLayer?.(finalId);
  }, [doc, focusedCue, selectedLayerId, activeLayer, currentTime, snapToGrid, grid, onDocChange, onFocusCue, onSelectLayer]);

  const addCueViaToolbar = useCallback(() => { addCueAtLayer(null); }, [addCueAtLayer]);
  const addCueViaToolbarInLayer = useCallback((layerId: string) => { addCueAtLayer(layerId); }, [addCueAtLayer]);

  // Commit a pair of cues at [t1, t2] into the active (or auto-created) layer.
  // Mirrors Manual's drag-range behavior — the user gets two boundary points
  // in one gesture. De-dupes against existing cues within 0.01s.
  const commitCueRange = useCallback((t1: number, t2: number) => {
    const snap = (t: number) => (snapToGrid && grid?.bpm ? snapToBeat(t, grid as BarGrid) : t);
    const start = Math.round(snap(Math.min(t1, t2)) * 1000) / 1000;
    const end   = Math.round(snap(Math.max(t1, t2)) * 1000) / 1000;
    let layers = doc.layers;
    let targetLayerId: string | undefined;
    if (selectedLayerId && layers.some((l) => l.id === selectedLayerId && l.type === 'cues')) {
      targetLayerId = selectedLayerId;
    } else if (activeLayer) {
      targetLayerId = activeLayer.id;
    }
    if (!targetLayerId) {
      const newLayer = newCueLayer('Cues 1', pickDefaultLayerColor(layers));
      layers = [...layers, newLayer];
      targetLayerId = newLayer.id;
    }
    const finalId = targetLayerId;
    const target = layers.find((l) => l.id === finalId);
    const existing = (target && target.type === 'cues' ? target.items : []) as CueItem[];
    const additions: CueItem[] = [];
    const novel = (t: number) =>
      !existing.some((c) => Math.abs(c.time - t) < 0.01)
      && !additions.some((c) => Math.abs(c.time - t) < 0.01);
    if (novel(start)) additions.push(newCueItem(start, ''));
    if (Math.abs(end - start) >= 0.05 && novel(end)) additions.push(newCueItem(end, ''));
    if (additions.length === 0) return;
    layers = layers.map((l) =>
      l.id === finalId ? { ...l, items: [...l.items, ...additions] } : l,
    );
    onDocChange({ ...doc, layers });
    const last = additions[additions.length - 1];
    onFocusCue?.({ layerId: finalId, itemId: last.id });
    onSelectLayer?.(finalId);
  }, [doc, selectedLayerId, activeLayer, snapToGrid, grid, onDocChange, onFocusCue, onSelectLayer]);

  const confirmPendingSelection = useCallback(() => {
    if (!pendingSelection) return;
    if (pendingSelection.t2 !== null) {
      commitCueRange(pendingSelection.t1, pendingSelection.t2);
    } else {
      // Point-only pending (rare for cues, but handle it): drop one cue at t1.
      addCueAtLayer(null);
    }
    onClearPendingSelection?.();
  }, [pendingSelection, commitCueRange, addCueAtLayer, onClearPendingSelection]);

  const addLayerViaToolbar = useCallback(() => {
    const layer = newCueLayer(`Cues ${cueLayers.length + 1}`, pickDefaultLayerColor(doc.layers));
    onDocChange({ ...doc, layers: [...doc.layers, layer] });
    onSelectLayer?.(layer.id);
  }, [doc, cueLayers.length, onDocChange, onSelectLayer]);

  const setCuesStage = useCallback((stage: AnnotationStage) => {
    onDocChange(setLayerStatus(doc, 'cues', stage));
  }, [doc, onDocChange]);

  const exportCuesJson = useCallback(() => {
    const cuesOnly: AnnotationLayersDocument = {
      ...doc,
      layers: doc.layers.filter((l) => l.type === 'cues'),
    };
    const blob = new Blob([JSON.stringify(cuesOnly, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cues-all_layers-${doc.song}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [doc]);

  const importCuesJson = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const text = (ev.target?.result as string) ?? '';
        const parsed = JSON.parse(text) as Partial<AnnotationLayersDocument>;
        const incoming = (parsed.layers ?? []).filter((l): l is AnnotationLayer<'cues'> => l.type === 'cues');
        const remaining = doc.layers.filter((l) => l.type !== 'cues');
        onDocChange({ ...doc, layers: [...remaining, ...incoming] });
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Could not parse JSON.');
      }
    };
    reader.readAsText(file);
  }, [doc, onDocChange]);

  const deleteAllCues = useCallback(() => {
    const remaining = doc.layers.filter((l) => l.type !== 'cues');
    onDocChange({ ...doc, layers: remaining });
    onFocusCue?.(null);
  }, [doc, onDocChange, onFocusCue]);

  // Single-item delete: focused cue first, otherwise the nearest cue across
  // all visible cue layers within ~5 s of the playhead.
  const deleteFocusedCue = useCallback(() => {
    if (focusedCue) {
      const layerId = focusedCue.layerId;
      const itemId = focusedCue.itemId;
      onDocChange({
        ...doc,
        layers: doc.layers.map((l) =>
          l.id === layerId
            ? ({ ...l, items: l.items.filter((it) => it.id !== itemId) } as AnnotationLayer)
            : l,
        ),
      });
      onFocusCue?.(null);
      return;
    }
    let bestLayerId: string | null = null;
    let bestItemId: string | null = null;
    let bestDist = Infinity;
    for (const l of doc.layers) {
      if (l.type !== 'cues' || !l.visible) continue;
      for (const it of l.items) {
        const d = Math.abs((it as { time: number }).time - currentTime);
        if (d < bestDist) { bestDist = d; bestLayerId = l.id; bestItemId = it.id; }
      }
    }
    if (!bestLayerId || !bestItemId || bestDist > 5) return;
    const matchLayer = bestLayerId;
    const matchItem = bestItemId;
    onDocChange({
      ...doc,
      layers: doc.layers.map((l) =>
        l.id === matchLayer
          ? ({ ...l, items: l.items.filter((it) => it.id !== matchItem) } as AnnotationLayer)
          : l,
      ),
    });
  }, [doc, focusedCue, currentTime, onDocChange, onFocusCue]);

  useImperativeHandle<AnnotationPanelController, AnnotationPanelController>(controllerRef, () => ({
    setStatus: setCuesStage,
    addAtPlayhead: addCueViaToolbar,
    addAtPlayheadInLayer: addCueViaToolbarInLayer,
    addLayer: addLayerViaToolbar,
    exportJson: exportCuesJson,
    importJson: importCuesJson,
    deleteAll: deleteAllCues,
    deleteFocused: deleteFocusedCue,
    confirmPending: confirmPendingSelection,
    commitItemRange: commitCueRange,
  }), [setCuesStage, addCueViaToolbar, addCueViaToolbarInLayer, addLayerViaToolbar, exportCuesJson, importCuesJson, deleteAllCues, deleteFocusedCue, confirmPendingSelection, commitCueRange]);

  useEffect(() => {
    if (!onCapabilitiesChange) return;
    onCapabilitiesChange({
      ...emptyCapabilities(),
      status: getLayerStatus(doc, 'cues'),
      hasItems: totalCount > 0,
      saveStatus,
      canUndo: false,
      canRedo: false,
      canSplit: false,
      splitVisible: false,
      splitLabel: 'Split',
      canAddAtPlayhead: true,
      addLabel: `+ Add @ ${fmtTime(currentTime)}`,
      canAddLayer: true,
      pending: pendingSelection ?? null,
      pendingRequiresRegion: false,
      importFormats: ['json'],
      canExport: totalCount > 0,
      canDeleteAll: doc.layers.some((l) => l.type === 'cues'),
    });
  }, [onCapabilitiesChange, doc, saveStatus, currentTime, totalCount, pendingSelection]);

  const sortedItems = useMemo(
    () => (activeLayer?.items ?? []).slice().sort((a, b) => a.time - b.time),
    [activeLayer],
  );

  return (
    <div className="space-y-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">
        {cueLayers.length} layer{cueLayers.length === 1 ? '' : 's'} · {totalCount} cue{totalCount === 1 ? '' : 's'}
      </div>

      {activeLayer && (
        <LayerToolbar
          layer={activeLayer}
          currentTime={currentTime}
          onRename={(name) => patchLayer(activeLayer.id, { name })}
          onToggleVisibility={() => patchLayer(activeLayer.id, { visible: !activeLayer.visible })}
          onChangeMode={(mode) => patchLayer(activeLayer.id, { mode })}
          onDelete={() => deleteLayer(activeLayer.id)}
          onAddCue={() => addCueAtPlayhead(activeLayer.id)}
        />
      )}

      {!activeLayer ? (
        <div className="flex flex-wrap items-start gap-1">
          <AddItemAtEndCard
            onClick={addCueViaToolbar}
            label={`+ Add cue @ ${fmtTime(currentTime)}`}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-1 max-h-[480px] overflow-y-auto pb-1">
          {sortedItems.map((cue, i) => (
            <CueItemCard
              key={cue.id}
              index={i}
              cue={cue}
              color={activeLayer.color}
              isSelected={focusedCue?.layerId === activeLayer.id && focusedCue.itemId === cue.id}
              onSelect={() => { onFocusCue?.({ layerId: activeLayer.id, itemId: cue.id }); onSelectLayer?.(activeLayer.id); }}
              onSnap={() => patchItem(activeLayer.id, cue.id, {
                time: snapToGrid && grid?.bpm ? snapToBeat(currentTime, grid as BarGrid) : currentTime,
              })}
              onChangeLabel={(label) => patchItem(activeLayer.id, cue.id, { label })}
              onToggleImportance={() => patchItem(activeLayer.id, cue.id, {
                importance: cue.importance === 'optional' ? 'critical' : 'optional',
              })}
              onAddCandidate={() => addCandidate(activeLayer.id, cue.id)}
              onRemoveCandidate={(ci) => removeCandidate(activeLayer.id, cue.id, ci)}
              onDelete={() => deleteItem(activeLayer.id, cue.id)}
              labelTaxonomyId={showTaxonomy ? taxonomyId : undefined}
            />
          ))}
          <AddItemAtEndCard
            onClick={() => addCueAtPlayhead(activeLayer.id)}
            label={`+ Add @ ${fmtTime(currentTime)}`}
          />
        </div>
      )}

      {showTaxonomy && (
        <datalist id={taxonomyId}>
          {settings.cueTaxonomy.map((v) => <option key={v} value={v} />)}
        </datalist>
      )}
    </div>
  );
}

// ─── Slim per-layer toolbar above the card row ─────────────────────────────

interface LayerToolbarProps {
  layer: AnnotationLayer<'cues'>;
  currentTime: number;
  onRename: (name: string) => void;
  onToggleVisibility: () => void;
  onChangeMode: (mode: import('../../types/annotationLayer').LayerEvalMode) => void;
  onDelete: () => void;
  onAddCue: () => void;
}

function LayerToolbar({
  layer, currentTime, onRename, onToggleVisibility, onChangeMode, onDelete, onAddCue,
}: LayerToolbarProps) {
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
        onClick={onAddCue}
        className="px-2 py-0.5 rounded text-[10px] uppercase tracking-wider border border-cyan-400/30 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20 hover:border-cyan-400/50 transition-colors"
        title="Add cue at playhead (M)"
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

export const CueEditorPanel = forwardRef<AnnotationPanelController, CueEditorPanelProps>(CueEditorPanelInner);
CueEditorPanel.displayName = 'CueEditorPanel';
