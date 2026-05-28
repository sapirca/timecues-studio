/**
 * LoopEditorPanel — controlled editor for Loop annotation layers.
 *
 * Mirrors CueEditorPanel's shape: only the selected layer renders below the
 * waveform, as a flex-wrap row of LoopItemCards. The slim toolbar above the
 * cards owns layer-level controls (name, visibility, delete, + N-bar add).
 *
 * Gated by the experimentalLoopsAndPatterns Settings flag — the parent does
 * not mount this panel unless the flag is on.
 */

import { useCallback, useEffect, useImperativeHandle, useMemo, forwardRef, type ForwardedRef } from 'react';
import type {
  AnnotationLayer,
  AnnotationLayersDocument,
  AnnotationStage,
  LoopItem,
} from '../../types/annotationLayer';
import {
  getLayerStatus,
  newLoopLayer,
  newId,
  pickDefaultLayerColor,
  setLayerStatus,
} from '../../types/annotationLayer';
import { snapToBar, snapToBeat, type BarGrid } from '../../utils/barSnap';
import type { PendingSelection } from './AnnotationOverlays';
import { useSettings } from '../../context/SettingsContext';
import type { AnnotationPanelCapabilities, AnnotationPanelController } from './shared/AnnotationPanelController';
import { LoopItemCard } from './LoopItemCard';
import { AddItemAtEndCard } from './ItemCard';
import { LayerModePicker } from './LayerModePicker';

interface LoopEditorPanelProps {
  currentTime: number;
  duration: number;
  doc: AnnotationLayersDocument;
  onDocChange: (next: AnnotationLayersDocument) => void;
  /** Beat-grid info — used to snap start/end, compute bar lengths, and bar-snap on resize. */
  grid: Partial<BarGrid> | null;
  /** Global Snap-to-grid toggle (VizControlBar). */
  snapToGrid?: boolean;
  focusedLoop?: { layerId: string; itemId: string } | null;
  onFocusLoop?: (selection: { layerId: string; itemId: string } | null) => void;
  selectedLayerId?: string | null;
  onSelectLayer?: (layerId: string | null) => void;
  playingLoopId: string | null;
  onPlayLoop: (id: string, startSec: number, endSec: number) => void;
  onStopLoop: () => void;
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

function newLoopItem(start: number, end: number): LoopItem {
  return { id: newId(), start, end, label: '', description: '', snapZeroCross: true };
}

function LoopEditorPanelInner(
  {
    currentTime, duration, doc, onDocChange, grid,
    snapToGrid = false,
    focusedLoop, onFocusLoop, playingLoopId, onPlayLoop, onStopLoop,
    selectedLayerId = null, onSelectLayer,
    pendingSelection, onClearPendingSelection,
    onCapabilitiesChange,
    saveStatus = 'idle',
  }: LoopEditorPanelProps,
  controllerRef: ForwardedRef<AnnotationPanelController>,
) {
  const { settings } = useSettings();
  const quickAddBars = settings.loopQuickAddBars;
  const loopLayers = useMemo(
    () => doc.layers.filter((l): l is AnnotationLayer<'loops'> => l.type === 'loops'),
    [doc.layers],
  );
  const totalCount = useMemo(
    () => loopLayers.reduce((acc, l) => acc + l.items.length, 0),
    [loopLayers],
  );

  const activeLayer = useMemo<AnnotationLayer<'loops'> | null>(() => {
    if (selectedLayerId) {
      const hit = loopLayers.find((l) => l.id === selectedLayerId);
      if (hit) return hit;
    }
    return loopLayers[0] ?? null;
  }, [loopLayers, selectedLayerId]);

  useEffect(() => {
    if (!onSelectLayer) return;
    if (activeLayer && activeLayer.id !== selectedLayerId) {
      onSelectLayer(activeLayer.id);
    }
  }, [activeLayer, selectedLayerId, onSelectLayer]);

  function patchLayer(layerId: string, patch: Partial<AnnotationLayer<'loops'>>) {
    onDocChange({
      ...doc,
      layers: doc.layers.map((l) => (l.id === layerId ? ({ ...l, ...patch } as AnnotationLayer) : l)),
    });
  }

  function deleteLayer(layerId: string) {
    onDocChange({ ...doc, layers: doc.layers.filter((l) => l.id !== layerId) });
    if (focusedLoop?.layerId === layerId) onFocusLoop?.(null);
    if (selectedLayerId === layerId) onSelectLayer?.(null);
  }

  function addLoop(layerId: string, bars: number) {
    const layer = loopLayers.find((l) => l.id === layerId);
    if (!layer) return;
    const safeGrid = grid?.bpm && grid.beatsPerBar
      ? { bpm: grid.bpm, beatsPerBar: grid.beatsPerBar, gridOffsetSec: grid.gridOffsetSec ?? 0 }
      : null;
    let start = currentTime;
    let end = currentTime + bars * 2; // fallback when no grid: 2 sec/bar guess
    if (safeGrid) {
      const barLen = (60 / safeGrid.bpm) * safeGrid.beatsPerBar;
      start = snapToBar(currentTime, safeGrid);
      end   = start + bars * barLen;
    }
    if (end > duration) end = duration;
    const item = newLoopItem(start, end);
    onDocChange({
      ...doc,
      layers: doc.layers.map((l) =>
        l.id === layerId ? { ...l, items: [...l.items, item] } : l,
      ),
    });
    onFocusLoop?.({ layerId, itemId: item.id });
  }

  function patchItem(layerId: string, itemId: string, patch: Partial<LoopItem>) {
    onDocChange({
      ...doc,
      layers: doc.layers.map((l) =>
        l.id === layerId
          ? { ...l, items: l.items.map((it) => (it.id === itemId ? { ...it, ...patch } as LoopItem : it)) }
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
    if (focusedLoop?.itemId === itemId) onFocusLoop?.(null);
  }

  function snapStartToPlayhead(layerId: string, itemId: string) {
    const item = loopLayers.find((l) => l.id === layerId)?.items.find((i) => i.id === itemId);
    if (!item) return;
    const t = snapToGrid && grid?.bpm ? snapToBeat(currentTime, grid as BarGrid) : currentTime;
    patchItem(layerId, itemId, { start: Math.min(t, item.end - 0.05) });
  }

  function snapEndToPlayhead(layerId: string, itemId: string) {
    const item = loopLayers.find((l) => l.id === layerId)?.items.find((i) => i.id === itemId);
    if (!item) return;
    const t = snapToGrid && grid?.bpm ? snapToBeat(currentTime, grid as BarGrid) : currentTime;
    patchItem(layerId, itemId, { end: Math.max(t, item.start + 0.05) });
  }

  function resizeLoop(layerId: string, itemId: string, factor: number) {
    const item = loopLayers.find((l) => l.id === layerId)?.items.find((i) => i.id === itemId);
    if (!item) return;
    const length = item.end - item.start;
    let newEnd = item.start + length * factor;
    if (grid?.bpm && grid.beatsPerBar) {
      newEnd = snapToBar(newEnd, grid as BarGrid);
    }
    if (duration > 0) newEnd = Math.min(duration, newEnd);
    newEnd = Math.max(item.start + 0.05, newEnd);
    patchItem(layerId, itemId, { end: newEnd });
    if (playingLoopId === itemId) {
      onPlayLoop(itemId, item.start, newEnd);
    }
  }

  // ── Pending selection → "+ Add loop" pill ─────────────────────────────────
  const pendingSpan = pendingSelection && pendingSelection.t2 !== null
    ? { start: Math.min(pendingSelection.t1, pendingSelection.t2), end: Math.max(pendingSelection.t1, pendingSelection.t2) }
    : null;

  const pickLoopTarget = useCallback((forcedLayerId: string | null): { layers: AnnotationLayer[]; targetId: string } => {
    let layers = doc.layers;
    let targetId: string | null = null;
    if (forcedLayerId && loopLayers.some((l) => l.id === forcedLayerId)) targetId = forcedLayerId;
    else if (selectedLayerId && loopLayers.some((l) => l.id === selectedLayerId)) targetId = selectedLayerId;
    else if (activeLayer) targetId = activeLayer.id;
    else if (focusedLoop?.layerId && loopLayers.some((l) => l.id === focusedLoop.layerId)) targetId = focusedLoop.layerId;
    else targetId = loopLayers[0]?.id ?? null;
    if (!targetId) {
      const fresh = newLoopLayer(`Loops ${loopLayers.length + 1}`, pickDefaultLayerColor(doc.layers));
      layers = [...layers, fresh];
      targetId = fresh.id;
    }
    return { layers, targetId };
  }, [doc.layers, loopLayers, selectedLayerId, activeLayer, focusedLoop]);

  const confirmPendingForLayer = useCallback((forcedLayerId: string | null) => {
    if (!pendingSpan) return;
    const start = Math.max(0, pendingSpan.start);
    const end   = Math.min(duration > 0 ? duration : pendingSpan.end, pendingSpan.end);
    if (end - start < 0.05) { onClearPendingSelection?.(); return; }
    const item = newLoopItem(start, end);
    const { layers, targetId } = pickLoopTarget(forcedLayerId);
    onDocChange({
      ...doc,
      layers: layers.map((l) => (l.id === targetId
        ? ({ ...l, items: [...(l as AnnotationLayer<'loops'>).items, item] } as AnnotationLayer)
        : l)),
    });
    onFocusLoop?.({ layerId: targetId, itemId: item.id });
    onSelectLayer?.(targetId);
    onClearPendingSelection?.();
  }, [pendingSpan, duration, doc, pickLoopTarget, onDocChange, onFocusLoop, onSelectLayer, onClearPendingSelection]);

  const confirmPendingSelection = useCallback(() => { confirmPendingForLayer(null); }, [confirmPendingForLayer]);
  const confirmPendingInLayer = useCallback((id: string) => { confirmPendingForLayer(id); }, [confirmPendingForLayer]);

  const commitItemRange = useCallback((start: number, end: number) => {
    const s = Math.max(0, Math.min(start, end));
    const eRaw = Math.max(start, end);
    const e = duration > 0 ? Math.min(duration, eRaw) : eRaw;
    if (e - s < 0.05) return;
    const item = newLoopItem(s, e);
    const { layers, targetId } = pickLoopTarget(null);
    onDocChange({
      ...doc,
      layers: layers.map((l) => (l.id === targetId
        ? ({ ...l, items: [...(l as AnnotationLayer<'loops'>).items, item] } as AnnotationLayer)
        : l)),
    });
    onFocusLoop?.({ layerId: targetId, itemId: item.id });
    onSelectLayer?.(targetId);
  }, [doc, duration, pickLoopTarget, onDocChange, onFocusLoop, onSelectLayer]);

  // ── Page-level controller wiring ──────────────────────────────────────────
  const focusedLoopItem: LoopItem | null = useMemo(() => {
    if (!focusedLoop) return null;
    const layer = doc.layers.find((l): l is AnnotationLayer<'loops'> =>
      l.id === focusedLoop.layerId && l.type === 'loops');
    return layer?.items.find((it) => it.id === focusedLoop.itemId) ?? null;
  }, [focusedLoop, doc.layers]);
  const canSplitAtPlayhead = !!focusedLoopItem
    && currentTime > focusedLoopItem.start + 0.01
    && currentTime < focusedLoopItem.end - 0.01;

  const splitFocusedLoop = useCallback(() => {
    if (!focusedLoop || !focusedLoopItem) return;
    const t = currentTime;
    if (t <= focusedLoopItem.start + 0.01 || t >= focusedLoopItem.end - 0.01) return;
    const oldEnd = focusedLoopItem.end;
    onDocChange({
      ...doc,
      layers: doc.layers.map((l) => {
        if (l.id !== focusedLoop.layerId || l.type !== 'loops') return l;
        const items = (l.items as LoopItem[]).flatMap((it) => {
          if (it.id !== focusedLoop.itemId) return [it];
          const baseLabel = it.label || 'Loop';
          return [
            { ...it, end: t, label: `${baseLabel} A` },
            { ...it, id: newId(), start: t, end: oldEnd, label: `${baseLabel} B` },
          ];
        });
        return { ...l, items } as AnnotationLayer;
      }),
    });
  }, [focusedLoop, focusedLoopItem, currentTime, doc, onDocChange]);

  const setLoopsStage = useCallback((stage: AnnotationStage) => {
    onDocChange(setLayerStatus(doc, 'loops', stage));
  }, [doc, onDocChange]);

  const exportLoopsJson = useCallback(() => {
    const slice: AnnotationLayersDocument = { ...doc, layers: loopLayers };
    const blob = new Blob([JSON.stringify(slice, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `loops-all_layers-${doc.song}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [doc, loopLayers]);

  const importLoopsJson = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse((ev.target?.result as string) ?? '') as Partial<AnnotationLayersDocument>;
        const incoming = (parsed.layers ?? []).filter((l): l is AnnotationLayer<'loops'> => l.type === 'loops');
        const remaining = doc.layers.filter((l) => l.type !== 'loops');
        onDocChange({ ...doc, layers: [...remaining, ...incoming] });
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Could not parse JSON.');
      }
    };
    reader.readAsText(file);
  }, [doc, onDocChange]);

  const deleteAllLoops = useCallback(() => {
    onDocChange({ ...doc, layers: doc.layers.filter((l) => l.type !== 'loops') });
    onFocusLoop?.(null);
  }, [doc, onDocChange, onFocusLoop]);

  const addLoopForLayer = useCallback((forcedLayerId: string | null) => {
    const { layers, targetId } = pickLoopTarget(forcedLayerId);
    const safeGrid = grid?.bpm && grid.beatsPerBar
      ? { bpm: grid.bpm, beatsPerBar: grid.beatsPerBar, gridOffsetSec: grid.gridOffsetSec ?? 0 }
      : null;
    let start = currentTime;
    let end = currentTime + quickAddBars[0] * 2;
    if (safeGrid) {
      const barLen = (60 / safeGrid.bpm) * safeGrid.beatsPerBar;
      start = snapToBar(currentTime, safeGrid);
      end   = start + quickAddBars[0] * barLen;
    }
    if (duration > 0 && end > duration) end = duration;
    const item = newLoopItem(start, end);
    onDocChange({
      ...doc,
      layers: layers.map((l) =>
        l.id === targetId
          ? ({ ...l, items: [...(l as AnnotationLayer<'loops'>).items, item] } as AnnotationLayer)
          : l,
      ),
    });
    onFocusLoop?.({ layerId: targetId, itemId: item.id });
    onSelectLayer?.(targetId);
  }, [doc, pickLoopTarget, grid, currentTime, quickAddBars, duration, onDocChange, onFocusLoop, onSelectLayer]);

  const addLoopAtPlayhead = useCallback(() => { addLoopForLayer(null); }, [addLoopForLayer]);
  const addLoopAtPlayheadInLayer = useCallback((id: string) => { addLoopForLayer(id); }, [addLoopForLayer]);

  const deleteFocusedLoop = useCallback(() => {
    if (!focusedLoop) return;
    const layerId = focusedLoop.layerId;
    const itemId = focusedLoop.itemId;
    onDocChange({
      ...doc,
      layers: doc.layers.map((l) =>
        l.id === layerId
          ? ({ ...l, items: (l.items as LoopItem[]).filter((it) => it.id !== itemId) } as AnnotationLayer)
          : l,
      ),
    });
    onFocusLoop?.(null);
  }, [doc, focusedLoop, onDocChange, onFocusLoop]);

  const halveFocusedLoop = useCallback(() => {
    if (!focusedLoop || !focusedLoopItem) return;
    resizeLoopByFactor(focusedLoop.layerId, focusedLoop.itemId, 0.5);
  }, [focusedLoop, focusedLoopItem]);

  const doubleFocusedLoop = useCallback(() => {
    if (!focusedLoop || !focusedLoopItem) return;
    resizeLoopByFactor(focusedLoop.layerId, focusedLoop.itemId, 2);
  }, [focusedLoop, focusedLoopItem]);

  function resizeLoopByFactor(layerId: string, itemId: string, factor: number) {
    const item = loopLayers.find((l) => l.id === layerId)?.items.find((i) => i.id === itemId);
    if (!item) return;
    const length = item.end - item.start;
    let newEnd = item.start + length * factor;
    if (grid?.bpm && grid.beatsPerBar) newEnd = snapToBar(newEnd, grid as BarGrid);
    if (duration > 0) newEnd = Math.min(duration, newEnd);
    newEnd = Math.max(item.start + 0.05, newEnd);
    patchItem(layerId, itemId, { end: newEnd });
    if (playingLoopId === itemId) onPlayLoop(itemId, item.start, newEnd);
  }

  const togglePlayFocusedLoop = useCallback(() => {
    if (!focusedLoop || !focusedLoopItem) return;
    if (playingLoopId === focusedLoop.itemId) onStopLoop();
    else onPlayLoop(focusedLoop.itemId, focusedLoopItem.start, focusedLoopItem.end);
  }, [focusedLoop, focusedLoopItem, playingLoopId, onPlayLoop, onStopLoop]);

  const addLoopLayerViaToolbar = useCallback(() => {
    const layer = newLoopLayer(`Loops ${loopLayers.length + 1}`, pickDefaultLayerColor(doc.layers));
    onDocChange({ ...doc, layers: [...doc.layers, layer] });
    onSelectLayer?.(layer.id);
  }, [doc, loopLayers.length, onDocChange, onSelectLayer]);

  useImperativeHandle<AnnotationPanelController, AnnotationPanelController>(controllerRef, () => ({
    setStatus: setLoopsStage,
    split: splitFocusedLoop,
    addAtPlayhead: addLoopAtPlayhead,
    addAtPlayheadInLayer: addLoopAtPlayheadInLayer,
    addLayer: addLoopLayerViaToolbar,
    confirmPending: confirmPendingSelection,
    confirmPendingInLayer,
    commitItemRange,
    exportJson: exportLoopsJson,
    importJson: importLoopsJson,
    deleteAll: deleteAllLoops,
    deleteFocused: deleteFocusedLoop,
    halveFocused: halveFocusedLoop,
    doubleFocused: doubleFocusedLoop,
    togglePlayFocused: togglePlayFocusedLoop,
  }), [setLoopsStage, splitFocusedLoop, addLoopAtPlayhead, addLoopAtPlayheadInLayer,
       addLoopLayerViaToolbar,
       confirmPendingSelection, confirmPendingInLayer, commitItemRange, exportLoopsJson,
       importLoopsJson, deleteAllLoops, deleteFocusedLoop, halveFocusedLoop, doubleFocusedLoop,
       togglePlayFocusedLoop]);

  useEffect(() => {
    if (!onCapabilitiesChange) return;
    onCapabilitiesChange({
      status: getLayerStatus(doc, 'loops'),
      hasItems: totalCount > 0,
      saveStatus,
      canUndo: false,
      canRedo: false,
      canSplit: canSplitAtPlayhead,
      splitVisible: true,
      splitDisabledReason: canSplitAtPlayhead
        ? undefined
        : 'Focus a loop whose body contains the playhead to enable Split',
      splitLabel: `Split at ${fmtTime(currentTime)}`,
      snapBoundaryVisible: true,
      canMarkIn: true,
      canMarkOut: false,
      snapStartLabel: `@ ${fmtTime(currentTime)}`,
      snapEndLabel: `@ ${fmtTime(currentTime)}`,
      canAddAtPlayhead: true,
      addLabel: `+ Add ${quickAddBars[0]}-bar loop @ ${fmtTime(currentTime)}`,
      canAddLayer: true,
      pending: pendingSelection ?? null,
      pendingRequiresRegion: true,
      importFormats: ['json'],
      canExport: totalCount > 0,
      canDeleteAll: loopLayers.length > 0,
    });
  }, [onCapabilitiesChange, doc, saveStatus, canSplitAtPlayhead, currentTime, pendingSelection, totalCount, loopLayers.length, quickAddBars]);

  const sortedItems = useMemo(
    () => (activeLayer?.items ?? []).slice().sort((a, b) => a.start - b.start),
    [activeLayer],
  );

  return (
    <div className="space-y-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">
        {loopLayers.length} layer{loopLayers.length === 1 ? '' : 's'} · {totalCount} loop{totalCount === 1 ? '' : 's'}
      </div>

      {activeLayer && (
        <LoopLayerToolbar
          layer={activeLayer}
          currentTime={currentTime}
          grid={grid}
          quickAddBars={quickAddBars}
          onRename={(name) => patchLayer(activeLayer.id, { name })}
          onToggleVisibility={() => patchLayer(activeLayer.id, { visible: !activeLayer.visible })}
          onChangeMode={(mode) => patchLayer(activeLayer.id, { mode })}
          onDelete={() => deleteLayer(activeLayer.id)}
          onAddBars={(bars) => addLoop(activeLayer.id, bars)}
        />
      )}

      {!activeLayer ? (
        <div className="flex flex-wrap items-start gap-1">
          <AddItemAtEndCard
            onClick={addLoopAtPlayhead}
            label={`+ Add ${quickAddBars[0]}-bar loop`}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-1 max-h-[480px] overflow-y-auto pb-1">
          {sortedItems.map((loop, i) => (
            <LoopItemCard
              key={loop.id}
              index={i}
              loop={loop}
              color={activeLayer.color}
              grid={grid}
              isSelected={focusedLoop?.layerId === activeLayer.id && focusedLoop.itemId === loop.id}
              isPlaying={playingLoopId === loop.id}
              onSelect={() => { onFocusLoop?.({ layerId: activeLayer.id, itemId: loop.id }); onSelectLayer?.(activeLayer.id); }}
              onChangeLabel={(label) => patchItem(activeLayer.id, loop.id, { label })}
              onSnapStart={() => snapStartToPlayhead(activeLayer.id, loop.id)}
              onSnapEnd={() => snapEndToPlayhead(activeLayer.id, loop.id)}
              onResize={(factor) => resizeLoop(activeLayer.id, loop.id, factor)}
              onToggleImportance={() => patchItem(activeLayer.id, loop.id, {
                importance: loop.importance === 'optional' ? 'critical' : 'optional',
              })}
              onPlay={() => onPlayLoop(loop.id, loop.start, loop.end)}
              onStop={onStopLoop}
              onDelete={() => deleteItem(activeLayer.id, loop.id)}
            />
          ))}
          <AddItemAtEndCard
            onClick={() => addLoop(activeLayer.id, quickAddBars[0])}
            label={`+ ${quickAddBars[0]}-bar loop`}
          />
        </div>
      )}
    </div>
  );
}

// ─── Slim per-layer toolbar above the card row ─────────────────────────────

interface LoopLayerToolbarProps {
  layer: AnnotationLayer<'loops'>;
  currentTime: number;
  grid: Partial<BarGrid> | null;
  quickAddBars: readonly [number, number];
  onRename: (name: string) => void;
  onToggleVisibility: () => void;
  onChangeMode: (mode: import('../../types/annotationLayer').LayerEvalMode) => void;
  onDelete: () => void;
  onAddBars: (bars: number) => void;
}

function LoopLayerToolbar({
  layer, currentTime, grid, quickAddBars,
  onRename, onToggleVisibility, onChangeMode, onDelete, onAddBars,
}: LoopLayerToolbarProps) {
  return (
    <div
      className="flex items-center gap-2 px-2 py-1 rounded bg-[#0f1116] border border-white/[0.06] flex-wrap"
      style={{ borderLeft: `3px solid ${layer.color}` }}
    >
      <span
        className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
        style={{ background: layer.color, boxShadow: `0 0 6px ${layer.color}66` }}
      />
      <input
        value={layer.name}
        onChange={(e) => onRename(e.target.value)}
        className="flex-1 min-w-[120px] bg-transparent border-0 text-[12px] text-slate-100 font-medium focus:outline-none focus:bg-white/[0.04] rounded px-1 -mx-1"
        spellCheck={false}
      />
      <span className="text-[10px] font-mono text-slate-500 shrink-0">{layer.items.length}</span>
      <LayerModePicker mode={layer.mode} onChange={onChangeMode} />
      <span className="text-[10px] uppercase tracking-wider text-slate-500 shrink-0">@ {fmtTime(currentTime)}:</span>
      {quickAddBars.map((bars, i) => (
        <button
          key={i}
          onClick={() => onAddBars(bars)}
          disabled={!grid?.bpm}
          className="px-2 py-0.5 rounded text-[10px] uppercase tracking-wider border border-fuchsia-400/30 bg-fuchsia-500/10 text-fuchsia-200 hover:bg-fuchsia-500/20 hover:border-fuchsia-400/50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title={grid?.bpm
            ? `Add a ${bars}-bar loop starting from the bar containing the playhead${i === 0 ? ' (M)' : ''}`
            : 'Set the song BPM first'}
        >
          + {bars}-bar loop
        </button>
      ))}
      {!grid?.bpm && (
        <span className="text-[10px] text-amber-400/70 italic">no BPM — set in Song Info to enable bar snap</span>
      )}
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

export const LoopEditorPanel = forwardRef<AnnotationPanelController, LoopEditorPanelProps>(LoopEditorPanelInner);
LoopEditorPanel.displayName = 'LoopEditorPanel';
