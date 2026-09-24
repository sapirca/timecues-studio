/**
 * SpanEditorPanel — controlled editor for Span annotation layers.
 *
 * Spans are labeled intervals that MAY overlap, distinct from Loops (which
 * carry playback affordances). Mirrors Cues / Loops: only the currently-
 * selected layer's items render as horizontal cards beneath the waveform,
 * with a slim per-layer toolbar above.
 */

import { useCallback, useEffect, useId, useImperativeHandle, useMemo, forwardRef, type ForwardedRef } from 'react';
import { formatClockTime as fmtTime } from '../../utils/clockTime';
import type {
  AnnotationLayer,
  AnnotationLayersDocument,
  AnnotationStage,
  SpanItem,
} from '../../types/annotationLayer';
import {
  getLayerStatus,
  newId,
  newSpanItem,
  newSpanLayer,
  pickDefaultLayerColor,
  setLayerStatus,
} from '../../types/annotationLayer';
import { snapToBeat, type BarGrid } from '../../utils/barSnap';
import { resolvePointAddTime } from './boundaryInsert';
import type { PendingSelection } from './AnnotationOverlays';
import { useSettings } from '../../context/SettingsContext';
import { duplicateItemNotice, findItemAtSpot } from './shared/duplicateItem';
import type { AnnotationPanelCapabilities, AnnotationPanelController } from './shared/AnnotationPanelController';
import { emptyCapabilities } from './shared/AnnotationPanelController';
import { SpanItemCard } from './SpanItemCard';
import { AddItemAtEndCard } from './ItemCard';
import { LayerModePicker } from './LayerModePicker';
import { formatBeatTime } from '../../utils/beatTimeFormat';

interface SpanEditorPanelProps {
  currentTime: number;
  duration: number;
  doc: AnnotationLayersDocument;
  onDocChange: (next: AnnotationLayersDocument) => void;
  grid: Partial<BarGrid> | null;
  snapToGrid?: boolean;
  /** The page's grid-aware snapper, used for every add / snap-to-playhead
   *  time. It honours the GRID unit the user picked (1/2 beat, triplets,
   *  bars…), per-beat overrides and tempo segments, and returns the time
   *  untouched while Snap and Grid Lock are both off — the same rule a drag
   *  on the canvas already followed. Optional: without it these paths fall
   *  back to whole-beat snapping, which is what they all used to do. */
  snapTime?: (t: number) => number;
  focusedSpan?: { layerId: string; itemId: string } | null;
  onFocusSpan?: (selection: { layerId: string; itemId: string } | null) => void;
  selectedLayerId?: string | null;
  onSelectLayer?: (layerId: string | null) => void;
  pendingSelection?: PendingSelection | null;
  onClearPendingSelection?: () => void;
  onCapabilitiesChange?: (caps: AnnotationPanelCapabilities) => void;
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error';
  /** Fired when an add was refused because a span with these exact edges is
   *  already in the target layer — carries the line the page shows as a
   *  notice. See shared/duplicateItem.ts. */
  onDuplicateSkipped?: (message: string) => void;
  gridLock?: boolean;
  /** Reader for the LIVE media clock (the page's `liveSongTime`). Placing a
   *  span against `currentTime` puts its start where the playhead was a render
   *  ago; see `markTime`. Optional — falls back to the prop without it. */
  getSongTime?: () => number | null;
}

function SpanEditorPanelInner(
  {
    currentTime, duration, doc, onDocChange, grid,
    snapToGrid = false, snapTime,
    gridLock = false,
    focusedSpan, onFocusSpan,
    selectedLayerId = null, onSelectLayer,
    pendingSelection, onClearPendingSelection,
    onCapabilitiesChange,
    saveStatus = 'idle',
    onDuplicateSkipped,
    getSongTime,
  }: SpanEditorPanelProps,
  controllerRef: ForwardedRef<AnnotationPanelController>,
) {
  const { settings } = useSettings();
  // Where a span placed *right now* starts. Called at the moment of the add,
  // never captured: `currentTime` is the media clock one rAF, one setState and
  // one inspector re-render later, which is a marker dropped behind the beat
  // the annotator was listening to. `atTime` is the caller's own reading (the
  // M shortcut's, taken at the keydown) when it has one.
  const markTime = useCallback(
    (atTime?: number) => resolvePointAddTime({
      live: atTime ?? getSongTime?.(),
      fallback: currentTime,
    }),
    [getSongTime, currentTime],
  );

  // Where an add actually lands. Delegates to the page's `snapTime` so a mark
  // placed from the keyboard ends up on the same lines as one dragged on the
  // canvas; the whole-beat fallback is only for mounts that inject no snapper.
  const snapAdd = useCallback(
    (t: number) => (snapTime
      ? snapTime(t)
      : (snapToGrid && grid?.bpm ? snapToBeat(t, grid as BarGrid) : t)),
    [snapTime, snapToGrid, grid],
  );
  const taxonomyId = useId();
  const showTaxonomy = settings.spanTaxonomyEnabled && settings.spanTaxonomy.length > 0;
  const spanLayers = useMemo(
    () => doc.layers.filter((l): l is AnnotationLayer<'spans'> => l.type === 'spans'),
    [doc.layers],
  );
  const totalCount = useMemo(
    () => spanLayers.reduce((acc, l) => acc + l.items.length, 0),
    [spanLayers],
  );

  const activeLayer = useMemo<AnnotationLayer<'spans'> | null>(() => {
    if (selectedLayerId) {
      const hit = spanLayers.find((l) => l.id === selectedLayerId);
      if (hit) return hit;
    }
    return spanLayers[0] ?? null;
  }, [spanLayers, selectedLayerId]);

  useEffect(() => {
    if (!onSelectLayer) return;
    if (activeLayer && activeLayer.id !== selectedLayerId) {
      onSelectLayer(activeLayer.id);
    }
  }, [activeLayer, selectedLayerId, onSelectLayer]);

  function patchLayer(layerId: string, patch: Partial<AnnotationLayer<'spans'>>) {
    onDocChange({
      ...doc,
      layers: doc.layers.map((l) => (l.id === layerId ? ({ ...l, ...patch } as AnnotationLayer) : l)),
    });
  }

  function deleteLayer(layerId: string) {
    onDocChange({ ...doc, layers: doc.layers.filter((l) => l.id !== layerId) });
    if (focusedSpan?.layerId === layerId) onFocusSpan?.(null);
    if (selectedLayerId === layerId) onSelectLayer?.(null);
  }

  function patchItem(layerId: string, itemId: string, patch: Partial<SpanItem>) {
    onDocChange({
      ...doc,
      layers: doc.layers.map((l) =>
        l.id === layerId
          ? { ...l, items: l.items.map((it) => (it.id === itemId ? ({ ...it, ...patch } as SpanItem) : it)) }
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
    if (focusedSpan?.itemId === itemId) onFocusSpan?.(null);
  }

  function snapStartToPlayhead(layerId: string, itemId: string) {
    const item = spanLayers.find((l) => l.id === layerId)?.items.find((i) => i.id === itemId);
    if (!item) return;
    const raw = markTime();
    const t = snapAdd(raw);
    patchItem(layerId, itemId, { start: Math.min(t, item.end - 0.05) });
  }

  function snapEndToPlayhead(layerId: string, itemId: string) {
    const item = spanLayers.find((l) => l.id === layerId)?.items.find((i) => i.id === itemId);
    if (!item) return;
    const raw = markTime();
    const t = snapAdd(raw);
    patchItem(layerId, itemId, { end: Math.max(t, item.start + 0.05) });
  }

  // ── Pending selection → "+ Add span" pill ─────────────────────────────────
  const pendingSpan = pendingSelection && pendingSelection.t2 !== null
    ? { start: Math.min(pendingSelection.t1, pendingSelection.t2), end: Math.max(pendingSelection.t1, pendingSelection.t2) }
    : null;

  const pickSpanTarget = useCallback((forcedLayerId: string | null): { layers: AnnotationLayer[]; targetId: string } => {
    let layers = doc.layers;
    let targetId: string | null = null;
    if (forcedLayerId && spanLayers.some((l) => l.id === forcedLayerId)) targetId = forcedLayerId;
    else if (selectedLayerId && spanLayers.some((l) => l.id === selectedLayerId)) targetId = selectedLayerId;
    else if (activeLayer) targetId = activeLayer.id;
    else if (focusedSpan?.layerId && spanLayers.some((l) => l.id === focusedSpan.layerId)) targetId = focusedSpan.layerId;
    else targetId = spanLayers[0]?.id ?? null;
    if (!targetId) {
      const fresh = newSpanLayer(`Spans ${spanLayers.length + 1}`, pickDefaultLayerColor(doc.layers));
      layers = [...layers, fresh];
      targetId = fresh.id;
    }
    return { layers, targetId };
  }, [doc.layers, spanLayers, selectedLayerId, activeLayer, focusedSpan]);

  // The one place a new span enters the document — playhead add, dragged
  // region and canvas range all land here, so the duplicate rule is written
  // once. A span whose two edges already exist in the target layer is not
  // added: it would sit exactly on top of the one that's there and the
  // annotator would have no way to see the second one.
  const commitSpan = useCallback((start: number, end: number, forcedLayerId: string | null) => {
    const { layers, targetId } = pickSpanTarget(forcedLayerId);
    const layer = layers.find((l): l is AnnotationLayer<'spans'> =>
      l.id === targetId && l.type === 'spans');
    const existing = layer && findItemAtSpot(
      layer.items, { at: start, end }, (it) => ({ at: it.start, end: it.end }),
    );
    if (existing) {
      onFocusSpan?.({ layerId: targetId, itemId: existing.id });
      onSelectLayer?.(targetId);
      onDuplicateSkipped?.(duplicateItemNotice('span', { at: start, end }));
      return;
    }
    const item = newSpanItem(start, end);
    onDocChange({
      ...doc,
      layers: layers.map((l) => (l.id === targetId
        ? ({ ...l, items: [...(l as AnnotationLayer<'spans'>).items, item] } as AnnotationLayer)
        : l)),
    });
    onFocusSpan?.({ layerId: targetId, itemId: item.id });
    onSelectLayer?.(targetId);
  }, [doc, pickSpanTarget, onDocChange, onFocusSpan, onSelectLayer, onDuplicateSkipped]);

  const confirmPendingForLayer = useCallback((forcedLayerId: string | null) => {
    if (!pendingSpan) return;
    const start = Math.max(0, pendingSpan.start);
    const end   = Math.min(duration > 0 ? duration : pendingSpan.end, pendingSpan.end);
    if (end - start < 0.05) { onClearPendingSelection?.(); return; }
    commitSpan(start, end, forcedLayerId);
    onClearPendingSelection?.();
  }, [pendingSpan, duration, commitSpan, onClearPendingSelection]);

  const confirmPendingSelection = useCallback(() => { confirmPendingForLayer(null); }, [confirmPendingForLayer]);
  const confirmPendingInLayer = useCallback((id: string) => { confirmPendingForLayer(id); }, [confirmPendingForLayer]);

  const commitItemRange = useCallback((start: number, end: number) => {
    const s = Math.max(0, Math.min(start, end));
    const eRaw = Math.max(start, end);
    const e = duration > 0 ? Math.min(duration, eRaw) : eRaw;
    if (e - s < 0.05) return;
    commitSpan(s, e, null);
  }, [duration, commitSpan]);

  // ── Page-level controller wiring ──────────────────────────────────────────
  const focusedSpanItem: SpanItem | null = useMemo(() => {
    if (!focusedSpan) return null;
    const layer = doc.layers.find((l): l is AnnotationLayer<'spans'> =>
      l.id === focusedSpan.layerId && l.type === 'spans');
    return layer?.items.find((it) => it.id === focusedSpan.itemId) ?? null;
  }, [focusedSpan, doc.layers]);
  const canSplitAtPlayhead = !!focusedSpanItem
    && currentTime > focusedSpanItem.start + 0.01
    && currentTime < focusedSpanItem.end - 0.01;

  const splitFocusedSpan = useCallback(() => {
    if (!focusedSpan || !focusedSpanItem) return;
    const t = currentTime;
    if (t <= focusedSpanItem.start + 0.01 || t >= focusedSpanItem.end - 0.01) return;
    const oldEnd = focusedSpanItem.end;
    onDocChange({
      ...doc,
      layers: doc.layers.map((l) => {
        if (l.id !== focusedSpan.layerId || l.type !== 'spans') return l;
        const items = (l.items as SpanItem[]).flatMap((it) => {
          if (it.id !== focusedSpan.itemId) return [it];
          const baseLabel = it.label || 'Span';
          return [
            { ...it, end: t, label: `${baseLabel} A` },
            { ...it, id: newId(), start: t, end: oldEnd, label: `${baseLabel} B` },
          ];
        });
        return { ...l, items } as AnnotationLayer;
      }),
    });
  }, [focusedSpan, focusedSpanItem, currentTime, doc, onDocChange]);

  const setSpansStage = useCallback((stage: AnnotationStage) => {
    onDocChange(setLayerStatus(doc, 'spans', stage));
  }, [doc, onDocChange]);

  const exportSpansJson = useCallback(() => {
    const slice: AnnotationLayersDocument = { ...doc, layers: spanLayers };
    const blob = new Blob([JSON.stringify(slice, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `spans-all_layers-${doc.song}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [doc, spanLayers]);

  const importSpansJson = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse((ev.target?.result as string) ?? '') as Partial<AnnotationLayersDocument>;
        const incoming = (parsed.layers ?? []).filter((l): l is AnnotationLayer<'spans'> => l.type === 'spans');
        const remaining = doc.layers.filter((l) => l.type !== 'spans');
        onDocChange({ ...doc, layers: [...remaining, ...incoming] });
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Could not parse JSON.');
      }
    };
    reader.readAsText(file);
  }, [doc, onDocChange]);

  const deleteAllSpans = useCallback(() => {
    onDocChange({ ...doc, layers: doc.layers.filter((l) => l.type !== 'spans') });
    onFocusSpan?.(null);
  }, [doc, onDocChange, onFocusSpan]);

  // Add a default-length span at the playhead — 1 bar when a grid is set,
  // 2 seconds otherwise.
  const addSpanForLayer = useCallback((forcedLayerId: string | null, atTime?: number) => {
    // A highlighted region always wins over the playhead: if the annotator
    // dragged a range and then hit "+ Add", the range IS the thing they meant
    // to add. Falling back to a default-length span at the cursor would throw
    // their drag away and drop an item somewhere they never pointed at.
    if (pendingSpan) { confirmPendingForLayer(forcedLayerId); return; }
    const safeGrid = grid?.bpm && grid.beatsPerBar
      ? { bpm: grid.bpm, beatsPerBar: grid.beatsPerBar, gridOffsetSec: grid.gridOffsetSec ?? 0 }
      : null;
    const barLen = safeGrid ? (60 / safeGrid.bpm) * safeGrid.beatsPerBar : 2;
    const start = markTime(atTime);
    let end = start + barLen;
    if (duration > 0 && end > duration) end = duration;
    if (end - start < 0.05) return;
    commitSpan(start, end, forcedLayerId);
  }, [commitSpan, grid, markTime, duration, pendingSpan, confirmPendingForLayer]);

  const addSpanAtPlayhead = useCallback(
    (atTime?: number) => { addSpanForLayer(null, atTime); },
    [addSpanForLayer],
  );
  const addSpanAtPlayheadInLayer = useCallback(
    (id: string, atTime?: number) => { addSpanForLayer(id, atTime); },
    [addSpanForLayer],
  );

  // What "+ Add" will actually create, so the button never promises the
  // playhead while a dragged region is what lands.
  const addLabelSuffix = pendingSpan
    ? `${fmtTime(pendingSpan.start)}\u2192${fmtTime(pendingSpan.end)}`
    : `@ ${fmtTime(currentTime)}`;
  const addTitle = pendingSpan
    ? 'Add the highlighted region as a span'
    : 'Add span at playhead \u2014 default length = 1 bar / 2s (M)';

  const addSpanLayerViaToolbar = useCallback(() => {
    const layer = newSpanLayer(`Spans ${spanLayers.length + 1}`, pickDefaultLayerColor(doc.layers));
    onDocChange({ ...doc, layers: [...doc.layers, layer] });
    onSelectLayer?.(layer.id);
  }, [doc, spanLayers.length, onDocChange, onSelectLayer]);

  const deleteFocusedSpan = useCallback(() => {
    if (!focusedSpan) return;
    const layerId = focusedSpan.layerId;
    const itemId = focusedSpan.itemId;
    onDocChange({
      ...doc,
      layers: doc.layers.map((l) =>
        l.id === layerId
          ? ({ ...l, items: (l.items as SpanItem[]).filter((it) => it.id !== itemId) } as AnnotationLayer)
          : l,
      ),
    });
    onFocusSpan?.(null);
  }, [doc, focusedSpan, onDocChange, onFocusSpan]);

  useImperativeHandle<AnnotationPanelController, AnnotationPanelController>(controllerRef, () => ({
    setStatus: setSpansStage,
    split: splitFocusedSpan,
    addAtPlayhead: addSpanAtPlayhead,
    addAtPlayheadInLayer: addSpanAtPlayheadInLayer,
    addLayer: addSpanLayerViaToolbar,
    confirmPending: confirmPendingSelection,
    confirmPendingInLayer,
    commitItemRange,
    exportJson: exportSpansJson,
    importJson: importSpansJson,
    deleteAll: deleteAllSpans,
    deleteFocused: deleteFocusedSpan,
  }), [setSpansStage, splitFocusedSpan, addSpanAtPlayhead, addSpanAtPlayheadInLayer,
       addSpanLayerViaToolbar,
       confirmPendingSelection, confirmPendingInLayer, commitItemRange, exportSpansJson,
       importSpansJson, deleteAllSpans, deleteFocusedSpan]);

  useEffect(() => {
    if (!onCapabilitiesChange) return;
    onCapabilitiesChange({
      ...emptyCapabilities(),
      status: getLayerStatus(doc, 'spans'),
      hasItems: totalCount > 0,
      saveStatus,
      canUndo: false,
      canRedo: false,
      canSplit: canSplitAtPlayhead,
      splitVisible: true,
      splitDisabledReason: canSplitAtPlayhead
        ? undefined
        : 'Focus a span whose body contains the playhead to enable Split',
      splitLabel: `Split at ${fmtTime(currentTime)}`,
      snapBoundaryVisible: true,
      canMarkIn: true,
      canMarkOut: false,
      snapStartLabel: `@ ${fmtTime(currentTime)}`,
      snapEndLabel: `@ ${fmtTime(currentTime)}`,
      canAddAtPlayhead: true,
      addLabel: `+ Add span ${addLabelSuffix}`,
      canAddLayer: true,
      pending: pendingSelection ?? null,
      pendingRequiresRegion: true,
      importFormats: ['json'],
      canExport: totalCount > 0,
      canDeleteAll: spanLayers.length > 0,
    });
  }, [onCapabilitiesChange, doc, saveStatus, canSplitAtPlayhead, currentTime, pendingSelection, totalCount, spanLayers.length, addLabelSuffix]);

  const sortedItems = useMemo(
    () => (activeLayer?.items ?? []).slice().sort((a, b) => a.start - b.start),
    [activeLayer],
  );

  const beatFmt = useMemo<((t: number) => string) | undefined>(() => {
    if (!gridLock || !grid?.bpm || grid.bpm <= 0) return undefined;
    return (t: number) => formatBeatTime(
      t, grid.bpm!, grid.gridOffsetSec ?? 0, grid.beatsPerBar ?? 4,
      'bar-beat', settings.barBeatOrigin,
    );
  }, [gridLock, grid, settings.barBeatOrigin]);

  return (
    <div className="space-y-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">
        {spanLayers.length} layer{spanLayers.length === 1 ? '' : 's'} · {totalCount} span{totalCount === 1 ? '' : 's'}
      </div>

      {activeLayer && (
        <SpanLayerToolbar
          layer={activeLayer}
          onRename={(name) => patchLayer(activeLayer.id, { name })}
          onToggleVisibility={() => patchLayer(activeLayer.id, { visible: !activeLayer.visible })}
          onChangeMode={(mode) => patchLayer(activeLayer.id, { mode })}
          onDelete={() => deleteLayer(activeLayer.id)}
          onAddSpan={() => addSpanAtPlayhead()}
          addLabel={`+ Add ${addLabelSuffix}`}
          addTitle={addTitle}
        />
      )}

      {!activeLayer ? (
        <div className="flex flex-wrap items-start gap-1">
          <AddItemAtEndCard
            onClick={() => addSpanAtPlayhead()}
            label={`+ Add span ${addLabelSuffix}`}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-1 max-h-[480px] overflow-y-auto pb-1">
          {sortedItems.map((span, i) => (
            <SpanItemCard
              key={span.id}
              index={i}
              span={span}
              color={activeLayer.color}
              isSelected={focusedSpan?.layerId === activeLayer.id && focusedSpan.itemId === span.id}
              onSelect={() => { onFocusSpan?.({ layerId: activeLayer.id, itemId: span.id }); onSelectLayer?.(activeLayer.id); }}
              onChangeLabel={(label) => patchItem(activeLayer.id, span.id, { label })}
              onSnapStart={() => snapStartToPlayhead(activeLayer.id, span.id)}
              onSnapEnd={() => snapEndToPlayhead(activeLayer.id, span.id)}
              onToggleImportance={() => patchItem(activeLayer.id, span.id, {
                importance: span.importance === 'optional' ? 'critical' : 'optional',
              })}
              onDelete={() => deleteItem(activeLayer.id, span.id)}
              labelTaxonomyId={showTaxonomy ? taxonomyId : undefined}
              fmt={beatFmt}
            />
          ))}
          <AddItemAtEndCard
            onClick={() => addSpanAtPlayhead()}
            label={`+ Add ${addLabelSuffix}`}
          />
        </div>
      )}

      {showTaxonomy && (
        <datalist id={taxonomyId}>
          {settings.spanTaxonomy.map((v) => <option key={v} value={v} />)}
        </datalist>
      )}
    </div>
  );
}

// ─── Slim per-layer toolbar above the card row ─────────────────────────────


interface SpanLayerToolbarProps {
  layer: AnnotationLayer<'spans'>;
  onRename: (name: string) => void;
  onToggleVisibility: () => void;
  onChangeMode: (mode: import('../../types/annotationLayer').LayerEvalMode) => void;
  onDelete: () => void;
  onAddSpan: () => void;
  /** Reflects what the add will create — the highlighted region when one is
   *  pending, otherwise the playhead. */
  addLabel: string;
  addTitle: string;
}

function SpanLayerToolbar({
  layer,
  onRename, onToggleVisibility, onChangeMode, onDelete, onAddSpan,
  addLabel, addTitle,
}: SpanLayerToolbarProps) {
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
        onClick={onAddSpan}
        className="px-2 py-0.5 rounded text-[10px] uppercase tracking-wider border border-emerald-400/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20 hover:border-emerald-400/50 transition-colors"
        title={addTitle}
      >
        {addLabel}
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

export const SpanEditorPanel = forwardRef<AnnotationPanelController, SpanEditorPanelProps>(SpanEditorPanelInner);
SpanEditorPanel.displayName = 'SpanEditorPanel';
