/**
 * LyricsEditorPanel — controlled editor for word/line lyric layers, mirroring
 * CueEditorPanel. The parent (InspectorPageV2) owns the AnnotationLayersDocument
 * and persistence; this panel renders the active lyrics layer's items as
 * editable cards (time · text · word/line · optional end) and emits doc updates.
 *
 * Lyrics are usually generated (Whisper/aligner) then corrected here, so the
 * editor optimizes for fast text fixes and retiming rather than authoring from
 * scratch — though "+ Add @ playhead" drops a fresh word too.
 */

import { useCallback, useEffect, useImperativeHandle, useMemo, forwardRef, type ForwardedRef } from 'react';
import type {
  AnnotationLayer,
  AnnotationLayersDocument,
  AnnotationStage,
  LyricsItem,
} from '../../types/annotationLayer';
import type { PendingSelection } from './AnnotationOverlays';
import {
  getLayerStatus,
  newLyricsItem,
  newLyricsLayer,
  pickDefaultLayerColor,
  setLayerStatus,
} from '../../types/annotationLayer';
import { snapToBeat, type BarGrid } from '../../utils/barSnap';
import type { AnnotationPanelCapabilities, AnnotationPanelController } from './shared/AnnotationPanelController';
import { emptyCapabilities } from './shared/AnnotationPanelController';
import { AddItemAtEndCard } from './ItemCard';

interface LyricsEditorPanelProps {
  currentTime: number;
  /** Track length (seconds) — clamps line ends committed from a drag-region. */
  duration?: number;
  doc: AnnotationLayersDocument;
  onDocChange: (next: AnnotationLayersDocument) => void;
  focusedLyrics?: { layerId: string; itemId: string } | null;
  onFocusLyrics?: (selection: { layerId: string; itemId: string } | null) => void;
  selectedLayerId?: string | null;
  onSelectLayer?: (layerId: string | null) => void;
  /** Seek the playhead to a clicked lyric row (keeps the editor in sync with
   *  the canvas karaoke highlight). */
  onSeek?: (time: number) => void;
  snapToGrid?: boolean;
  grid?: Partial<BarGrid> | null;
  onCapabilitiesChange?: (caps: AnnotationPanelCapabilities) => void;
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error';
  pendingSelection?: PendingSelection | null;
  onClearPendingSelection?: () => void;
}

function fmtTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '0:00.0';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function LyricsEditorPanelInner(
  {
    currentTime, duration = 0, doc, onDocChange, focusedLyrics, onFocusLyrics,
    selectedLayerId = null, onSelectLayer, onSeek,
    snapToGrid = false, grid = null,
    onCapabilitiesChange,
    saveStatus = 'idle',
    pendingSelection = null,
    onClearPendingSelection,
  }: LyricsEditorPanelProps,
  controllerRef: ForwardedRef<AnnotationPanelController>,
) {
  const lyricsLayers = useMemo(
    () => doc.layers.filter((l): l is AnnotationLayer<'lyrics'> => l.type === 'lyrics'),
    [doc.layers],
  );
  const totalCount = useMemo(
    () => lyricsLayers.reduce((acc, l) => acc + l.items.length, 0),
    [lyricsLayers],
  );

  const activeLayer = useMemo<AnnotationLayer<'lyrics'> | null>(() => {
    if (selectedLayerId) {
      const hit = lyricsLayers.find((l) => l.id === selectedLayerId);
      if (hit) return hit;
    }
    return lyricsLayers[0] ?? null;
  }, [lyricsLayers, selectedLayerId]);

  useEffect(() => {
    if (!onSelectLayer) return;
    if (activeLayer && activeLayer.id !== selectedLayerId) onSelectLayer(activeLayer.id);
  }, [activeLayer, selectedLayerId, onSelectLayer]);

  const snap = useCallback(
    (t: number) => (snapToGrid && grid?.bpm ? snapToBeat(t, grid as BarGrid) : t),
    [snapToGrid, grid],
  );

  function patchLayer(layerId: string, patch: Partial<AnnotationLayer<'lyrics'>>) {
    onDocChange({
      ...doc,
      layers: doc.layers.map((l) => (l.id === layerId ? ({ ...l, ...patch } as AnnotationLayer) : l)),
    });
  }

  function deleteLayer(layerId: string) {
    onDocChange({ ...doc, layers: doc.layers.filter((l) => l.id !== layerId) });
    if (focusedLyrics?.layerId === layerId) onFocusLyrics?.(null);
    if (selectedLayerId === layerId) onSelectLayer?.(null);
  }

  function patchItem(layerId: string, itemId: string, patch: Partial<LyricsItem>) {
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
    if (focusedLyrics?.itemId === itemId) onFocusLyrics?.(null);
  }

  // Toggle word↔line. Switching to 'line' seeds an end (+1s, clamped grid);
  // switching to 'word' drops the end.
  function toggleKind(layerId: string, item: LyricsItem) {
    if (item.kind === 'word') {
      patchItem(layerId, item.id, { kind: 'line', end: Math.max(item.time + 0.5, (item.end ?? item.time + 1)) });
    } else {
      patchItem(layerId, item.id, { kind: 'word', end: undefined });
    }
  }

  // Resolve which layer an add targets (forced → page-selected → active →
  // first → fresh), mirroring the span/cue editors so every add path agrees.
  const pickTarget = useCallback((forcedLayerId: string | null): { layers: AnnotationLayer[]; targetId: string } => {
    let layers = doc.layers;
    let targetId: string | null = null;
    if (forcedLayerId && lyricsLayers.some((l) => l.id === forcedLayerId)) targetId = forcedLayerId;
    else if (selectedLayerId && lyricsLayers.some((l) => l.id === selectedLayerId)) targetId = selectedLayerId;
    else if (activeLayer) targetId = activeLayer.id;
    else if (focusedLyrics?.layerId && lyricsLayers.some((l) => l.id === focusedLyrics.layerId)) targetId = focusedLyrics.layerId;
    else targetId = lyricsLayers[0]?.id ?? null;
    if (!targetId) {
      const fresh = newLyricsLayer(`Lyrics ${lyricsLayers.length + 1}`, pickDefaultLayerColor(doc.layers));
      layers = [...layers, fresh];
      targetId = fresh.id;
    }
    return { layers, targetId };
  }, [doc.layers, lyricsLayers, selectedLayerId, activeLayer, focusedLyrics]);

  const commitItem = useCallback((item: LyricsItem, forcedLayerId: string | null) => {
    const { layers, targetId } = pickTarget(forcedLayerId);
    onDocChange({
      ...doc,
      layers: layers.map((l) => (l.id === targetId
        ? ({ ...l, items: [...(l as AnnotationLayer<'lyrics'>).items, item] } as AnnotationLayer)
        : l)),
    });
    onFocusLyrics?.({ layerId: targetId, itemId: item.id });
    onSelectLayer?.(targetId);
  }, [doc, pickTarget, onDocChange, onFocusLyrics, onSelectLayer]);

  // Word add at the playhead.
  const addAtLayer = useCallback((forcedLayerId: string | null) => {
    commitItem(newLyricsItem(snap(currentTime), '', 'word'), forcedLayerId);
  }, [commitItem, snap, currentTime]);

  const addViaToolbar = useCallback(() => { addAtLayer(null); }, [addAtLayer]);
  const addViaToolbarInLayer = useCallback((layerId: string) => { addAtLayer(layerId); }, [addAtLayer]);

  // Drag-region → a LINE lyric spanning the selection (the natural analog of a
  // span/loop region for the lyrics paradigm).
  const commitItemRange = useCallback((start: number, end: number) => {
    const s = Math.max(0, Math.min(start, end));
    const eRaw = Math.max(start, end);
    const e = duration > 0 ? Math.min(duration, eRaw) : eRaw;
    if (e - s < 0.05) return;
    commitItem(newLyricsItem(s, '', 'line', e), null);
  }, [duration, commitItem]);

  // Adopt the page-level pending viz-selection. A region → a line; a single
  // point (t2 null) → a word at t1. Matches how spans/cues consume pending.
  const confirmPendingForLayer = useCallback((forcedLayerId: string | null) => {
    if (!pendingSelection) return;
    if (pendingSelection.t2 !== null) {
      const start = Math.max(0, Math.min(pendingSelection.t1, pendingSelection.t2));
      const eRaw = Math.max(pendingSelection.t1, pendingSelection.t2);
      const end = duration > 0 ? Math.min(duration, eRaw) : eRaw;
      if (end - start >= 0.05) commitItem(newLyricsItem(start, '', 'line', end), forcedLayerId);
    } else {
      commitItem(newLyricsItem(Math.max(0, pendingSelection.t1), '', 'word'), forcedLayerId);
    }
    onClearPendingSelection?.();
  }, [pendingSelection, duration, commitItem, onClearPendingSelection]);

  const confirmPendingSelection = useCallback(() => { confirmPendingForLayer(null); }, [confirmPendingForLayer]);
  const confirmPendingInLayer = useCallback((id: string) => { confirmPendingForLayer(id); }, [confirmPendingForLayer]);

  const addLayerViaToolbar = useCallback(() => {
    const layer = newLyricsLayer(`Lyrics ${lyricsLayers.length + 1}`, pickDefaultLayerColor(doc.layers));
    onDocChange({ ...doc, layers: [...doc.layers, layer] });
    onSelectLayer?.(layer.id);
  }, [doc, lyricsLayers.length, onDocChange, onSelectLayer]);

  const setStage = useCallback((stage: AnnotationStage) => {
    onDocChange(setLayerStatus(doc, 'lyrics', stage));
  }, [doc, onDocChange]);

  const exportJson = useCallback(() => {
    const only: AnnotationLayersDocument = { ...doc, layers: doc.layers.filter((l) => l.type === 'lyrics') };
    const blob = new Blob([JSON.stringify(only, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lyrics-all_layers-${doc.song}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [doc]);

  const importJson = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const text = (ev.target?.result as string) ?? '';
        const parsed = JSON.parse(text) as Partial<AnnotationLayersDocument>;
        const incoming = (parsed.layers ?? []).filter((l): l is AnnotationLayer<'lyrics'> => l.type === 'lyrics');
        const remaining = doc.layers.filter((l) => l.type !== 'lyrics');
        onDocChange({ ...doc, layers: [...remaining, ...incoming] });
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Could not parse JSON.');
      }
    };
    reader.readAsText(file);
  }, [doc, onDocChange]);

  const deleteAll = useCallback(() => {
    onDocChange({ ...doc, layers: doc.layers.filter((l) => l.type !== 'lyrics') });
    onFocusLyrics?.(null);
  }, [doc, onDocChange, onFocusLyrics]);

  const deleteFocused = useCallback(() => {
    if (focusedLyrics) {
      deleteItem(focusedLyrics.layerId, focusedLyrics.itemId);
      return;
    }
    let bestLayerId: string | null = null;
    let bestItemId: string | null = null;
    let bestDist = Infinity;
    for (const l of doc.layers) {
      if (l.type !== 'lyrics' || !l.visible) continue;
      for (const it of l.items) {
        const d = Math.abs((it as { time: number }).time - currentTime);
        if (d < bestDist) { bestDist = d; bestLayerId = l.id; bestItemId = it.id; }
      }
    }
    if (!bestLayerId || !bestItemId || bestDist > 5) return;
    deleteItem(bestLayerId, bestItemId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, focusedLyrics, currentTime]);

  useImperativeHandle<AnnotationPanelController, AnnotationPanelController>(controllerRef, () => ({
    setStatus: setStage,
    addAtPlayhead: addViaToolbar,
    addAtPlayheadInLayer: addViaToolbarInLayer,
    addLayer: addLayerViaToolbar,
    confirmPending: confirmPendingSelection,
    confirmPendingInLayer,
    commitItemRange,
    exportJson,
    importJson,
    deleteAll,
    deleteFocused,
  }), [setStage, addViaToolbar, addViaToolbarInLayer, addLayerViaToolbar, confirmPendingSelection, confirmPendingInLayer, commitItemRange, exportJson, importJson, deleteAll, deleteFocused]);

  useEffect(() => {
    if (!onCapabilitiesChange) return;
    onCapabilitiesChange({
      ...emptyCapabilities(),
      status: getLayerStatus(doc, 'lyrics'),
      hasItems: totalCount > 0,
      saveStatus,
      canAddAtPlayhead: true,
      addLabel: `+ Add @ ${fmtTime(currentTime)}`,
      canAddLayer: true,
      // A dragged region commits a line; Mark In / Mark Out builds the same.
      snapBoundaryVisible: true,
      canMarkIn: true,
      pending: pendingSelection ?? null,
      // A lyric can be a point (word), so a point-only pending is valid too.
      pendingRequiresRegion: false,
      importFormats: ['json'],
      canExport: totalCount > 0,
      canDeleteAll: doc.layers.some((l) => l.type === 'lyrics'),
    });
  }, [onCapabilitiesChange, doc, saveStatus, currentTime, totalCount, pendingSelection]);

  const sortedItems = useMemo(
    () => (activeLayer?.items ?? []).slice().sort((a, b) => a.time - b.time),
    [activeLayer],
  );

  // Row under the playhead — the last item whose [time, end/next-start) spans
  // currentTime. Lights up in sync with the canvas karaoke highlight.
  const activeItemId = useMemo(() => {
    let id: string | null = null;
    for (let i = 0; i < sortedItems.length; i++) {
      const it = sortedItems[i];
      if (it.time <= currentTime) {
        const end = it.end ?? (sortedItems[i + 1]?.time ?? Infinity);
        if (currentTime < end) id = it.id;
      }
    }
    return id;
  }, [sortedItems, currentTime]);

  return (
    <div className="space-y-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">
        {lyricsLayers.length} layer{lyricsLayers.length === 1 ? '' : 's'} · {totalCount} lyric{totalCount === 1 ? '' : 's'}
      </div>

      {activeLayer && (
        <div
          className="flex items-center gap-2 px-2 py-1 rounded bg-[#0f1116] border border-white/[0.06]"
          style={{ borderLeft: `3px solid ${activeLayer.color}` }}
        >
          <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: activeLayer.color, boxShadow: `0 0 6px ${activeLayer.color}66` }} />
          <input
            value={activeLayer.name}
            onChange={(e) => patchLayer(activeLayer.id, { name: e.target.value })}
            className="flex-1 min-w-0 bg-transparent border-0 text-[12px] text-slate-100 font-medium focus:outline-none focus:bg-white/[0.04] rounded px-1 -mx-1"
            spellCheck={false}
          />
          <span className="text-[10px] font-mono text-slate-500 shrink-0">{activeLayer.items.length}</span>
          <button
            onClick={() => patchLayer(activeLayer.id, { visible: !activeLayer.visible })}
            className={`shrink-0 w-6 h-6 rounded flex items-center justify-center text-[11px] transition-colors ${
              activeLayer.visible
                ? 'bg-white/[0.04] border border-white/[0.08] text-slate-300 hover:text-slate-100'
                : 'border border-white/[0.04] text-slate-700 hover:text-slate-400'
            }`}
            title={activeLayer.visible ? 'Hide layer on canvas' : 'Show layer on canvas'}
          >
            {activeLayer.visible ? '◉' : '○'}
          </button>
          <button
            onClick={() => deleteLayer(activeLayer.id)}
            className="shrink-0 w-6 h-6 rounded flex items-center justify-center text-slate-500 hover:text-red-400 hover:bg-red-500/10 text-[12px]"
            title="Delete layer"
          >
            ✕
          </button>
        </div>
      )}

      {!activeLayer ? (
        <div className="flex flex-wrap items-start gap-1">
          <AddItemAtEndCard onClick={addViaToolbar} label={`+ Add lyric @ ${fmtTime(currentTime)}`} />
        </div>
      ) : (
        <div className="flex flex-col gap-1 max-h-[480px] overflow-y-auto pb-1">
          {sortedItems.map((item) => {
            const isSelected = focusedLyrics?.layerId === activeLayer.id && focusedLyrics.itemId === item.id;
            const isActive = item.id === activeItemId;
            return (
              <div
                key={item.id}
                onClick={() => { onSeek?.(item.time); onFocusLyrics?.({ layerId: activeLayer.id, itemId: item.id }); onSelectLayer?.(activeLayer.id); }}
                className={`flex items-center gap-2 px-2 py-1 rounded border cursor-pointer transition-colors ${
                  isActive ? 'bg-sky-500/15 border-sky-400/40'
                    : isSelected ? 'bg-white/[0.06] border-white/20'
                    : 'bg-[#0d0f13] border-white/[0.06] hover:border-white/15'
                }`}
              >
                <button
                  onClick={(e) => { e.stopPropagation(); patchItem(activeLayer.id, item.id, { time: snap(currentTime) }); }}
                  className="shrink-0 font-mono text-[10px] text-slate-400 hover:text-sky-300 tabular-nums"
                  title="Set time to playhead"
                >
                  {fmtTime(item.time)}{item.end != null ? `–${fmtTime(item.end)}` : ''}
                </button>
                <input
                  value={item.text}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => patchItem(activeLayer.id, item.id, { text: e.target.value })}
                  placeholder="(text)"
                  className="flex-1 min-w-0 bg-transparent border-0 text-[12px] text-slate-100 focus:outline-none focus:bg-white/[0.04] rounded px-1"
                  spellCheck={false}
                />
                <button
                  onClick={(e) => { e.stopPropagation(); toggleKind(activeLayer.id, item); }}
                  className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider border transition-colors ${
                    item.kind === 'line'
                      ? 'border-sky-400/40 bg-sky-500/15 text-sky-200'
                      : 'border-white/[0.08] text-slate-400 hover:text-slate-200'
                  }`}
                  title="Toggle word / line"
                >
                  {item.kind}
                </button>
                {item.kind === 'line' && (
                  <button
                    onClick={(e) => { e.stopPropagation(); patchItem(activeLayer.id, item.id, { end: Math.max(item.time + 0.1, snap(currentTime)) }); }}
                    className="shrink-0 font-mono text-[9px] text-slate-500 hover:text-sky-300"
                    title="Set line end to playhead"
                  >
                    ⇥end
                  </button>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); deleteItem(activeLayer.id, item.id); }}
                  className="shrink-0 w-5 h-5 rounded flex items-center justify-center text-slate-600 hover:text-red-400 hover:bg-red-500/10 text-[11px]"
                  title="Delete lyric"
                >
                  ✕
                </button>
              </div>
            );
          })}
          <AddItemAtEndCard onClick={() => addAtLayer(activeLayer.id)} label={`+ Add @ ${fmtTime(currentTime)}`} />
        </div>
      )}
    </div>
  );
}

export const LyricsEditorPanel = forwardRef<AnnotationPanelController, LyricsEditorPanelProps>(LyricsEditorPanelInner);
LyricsEditorPanel.displayName = 'LyricsEditorPanel';
