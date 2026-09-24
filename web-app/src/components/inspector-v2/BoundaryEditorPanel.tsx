/**
 * BoundaryEditorPanel — controlled component, same contract as
 * CueEditorPanel / SpanEditorPanel. The parent (InspectorPageV2) owns the
 * AnnotationLayersDocument, loads it on song change and runs the debounced
 * save; this panel only renders and emits doc updates via `onDocChange`.
 *
 * Multi-layer model: a song may carry several boundary layers — a second
 * reading of the structure is a second layer — but only the selected layer's
 * items render as cards. Switch the active layer from the right-edge sidebar.
 *
 * What makes boundaries different from the other layer kinds: they TILE.
 * Item `i` runs until item `i+1`, so ends are derived rather than stored, the
 * item list is kept sorted, and a trailing `unset`-typed item is the end-cap
 * convention that stops the last real section from swallowing the rest of the
 * track. Everything else — status pill, add-layer, import/export, undo — is
 * the shared layer machinery.
 */

import { useState, useEffect, useRef, useCallback, useMemo, useImperativeHandle, forwardRef, type RefObject, type ForwardedRef } from 'react';
import type {
  AnnotationLayer,
  AnnotationLayersDocument,
  AnnotationStage,
  BoundaryItem,
} from '../../types/annotationLayer';
import {
  getLayerStatus,
  newBoundaryLayer,
  pickDefaultLayerColor,
  setLayerStatus,
} from '../../types/annotationLayer';
import type { SectionBlock } from '../../types/sectionBlock';
import { useSettings } from '../../context/SettingsContext';
import type { AnnotationPanelController, AnnotationPanelCapabilities } from './shared/AnnotationPanelController';
import { emptyCapabilities } from './shared/AnnotationPanelController';
import { useSectionEditPopover } from './useSectionEditPopover';
import { formatClockTime as fmtTime } from '../../utils/clockTime';
import {
  parseTimeCuesJson,
  parseAudacity,
  parseSonicVisualiser,
  parseJams,
  parseMirEvalLab,
  parseReaperCsv,
} from '../../utils/importParsers';
import {
  SECTION_INFO,
  UNSET_TYPE,
  isOrphanedSection,
  sectionColor,
  sectionEnd,
  sectionLabel,
  getSectionTypes,
  normalizeSectionType,
  normalizeSections,
  normalizeSectionLabel,
} from './sectionConstants';
import { SectionCard, AddSectionAtEndCard } from './SectionCard';
import {
  EDGE_EPS,
  insertBoundaryAtPoint,
  makeSectionItem,
  makeUnsetCap,
  promoteCap,
  resolvePointAddTime,
  roundTime,
} from './boundaryInsert';
import { duplicateItemNotice } from './shared/duplicateItem';
import { BoundaryEditPopover } from './BoundaryEditPopover';
import {
  FillDefaultsModal,
  PRESETS as MANUAL_BOUNDARY_PRESETS,
  parseCustomLayout,
  layoutToSections,
  type BarEntry,
} from './FillDefaultsModal';
import type { PendingSelection } from './AnnotationOverlays';
import { getIsMobile } from '../../mobile/mobileMode';


// ─── Constants ────────────────────────────────────────────────────────────────

const RECOMMENDED_SECTION_SEQUENCE: Array<{ type: string; label: string }> = [
  { type: 'intro', label: 'Intro' }, { type: 'breakdown', label: 'Breakdown' },
  { type: 'buildup', label: 'Buildup' }, { type: 'drop', label: 'Drop' },
  { type: 'breakdown', label: 'Breakdown' }, { type: 'buildup', label: 'Buildup' },
  { type: 'drop', label: 'Drop' }, { type: 'outro', label: 'Outro' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Mint a BoundaryItem id. Local rather than imported so the panel never has
 *  to reach for the factory when it already knows the type and label. */
function itemId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function makeItem(time: number, type: string, label: string): BoundaryItem {
  return { id: itemId(), time, type, label };
}

/** Attach ids to plain section blocks — the shape every importer and the
 *  fill-defaults layouts produce. */
function toItems(sections: readonly SectionBlock[]): BoundaryItem[] {
  return sections.map((s) => ({ ...s, id: itemId() }));
}

function buildSequenceSections(sequence: Array<{ type: string; label: string }>, duration: number): SectionBlock[] {
  const n = sequence.length;
  const step = duration > 0 ? duration / n : 30;
  return sequence.map((s, i) => ({ time: i * step, type: s.type, label: s.label }));
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface BoundaryEditorPanelProps {
  songId: string;
  currentTime: number;
  duration: number;
  /** Required to start annotating. The panel disables the Start button if BPM is missing. */
  songBpm?: number;
  /** Beats-per-bar from the song's time signature (default 4). Drives the Length editor. */
  songBeatsPerBar?: number;
  /** Time (s) of bar 1 / beat 1 — needed for the bar.beat input. Default 0. */
  songGridOffset?: number;
  suggestedSections?: SectionBlock[];
  onSeekAndPlay?: (time: number, stopTime?: number) => void;
  onPause?: () => void;
  isPlaying?: boolean;
  /** Reader for the LIVE media clock (PlayerPanel's `getTimeRef`). Every
   *  point-add is placed against this, never against `currentTime` — see
   *  `resolvePointAddTime`. Optional: without it the panel falls back to the
   *  prop, as it used to. */
  getSongTime?: () => number | null;
  /** Imperative handle: parent calls this to open/close the section edit
   *  popover by index within the ACTIVE layer. */
  openEditorRef?: RefObject<((idx: number | null, anchor?: { x: number; y: number }) => void) | null>;
  /** Pending viz click/drag selection lifted from InspectorPageV2 — confirmed
   *  via the shared AnnotationAddPanel at page level. */
  pendingSelection?: PendingSelection | null;
  onClearPendingSelection?: () => void;
  /** Fired when an add was refused because a boundary already sits on that
   *  point — `insertBoundaryAtPoint` has always dropped it, this is what makes
   *  that visible. See shared/duplicateItem.ts. */
  onDuplicateSkipped?: (message: string) => void;
  /** The page's grid-aware snapper (`snapToGridIfEnabled`). Every point-add
   *  goes through it, so a section marked while the transport runs lands on
   *  the grid like one dragged there does. It honours the GRID unit, beat
   *  overrides and tempo segments, and is a no-op while Snap and Grid Lock are
   *  both off. Optional: without it the panel places the raw time, which is
   *  what it used to do — and what made **M** on a playing track the one add
   *  in the app that ignored Snap entirely. */
  snapTime?: (t: number) => number;
  /** Page-level subscription that fires whenever toolbar-visible state changes. */
  onCapabilitiesChange?: (caps: AnnotationPanelCapabilities) => void;

  /** Layers document for the active song. */
  doc: AnnotationLayersDocument;
  /** Emit a new doc; the parent owns persistence + the shared undo stack.
   *  Takes an updater as well as a value, and every write below uses the
   *  updater form: `doc` arrives as a prop, so it is a render BEHIND a write
   *  this panel just made, and two writes inside one click (Delete, then the
   *  sort-on-close; Split, then the same) would otherwise both build on the
   *  pre-click doc and the second would undo the first. */
  onDocChange: (
    next: AnnotationLayersDocument | ((prev: AnnotationLayersDocument) => AnnotationLayersDocument),
    opts?: { coalesceKey?: string; skipHistory?: boolean },
  ) => void;
  /** True once the page's per-song load has settled. Gates the "Loading…" placeholder. */
  docLoaded: boolean;
  /** Page-owned "active layer" for ADD targets. */
  selectedLayerId?: string | null;
  onSelectLayer?: (layerId: string | null) => void;
  /** Inline save indicator state, lifted to the page (which owns the save
   *  debounce for the whole layers document). */
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error';
}

// ─── Component ────────────────────────────────────────────────────────────────

function BoundaryEditorPanelInner(
  {
    songId, currentTime, duration,
    songBpm, songBeatsPerBar = 4, songGridOffset = 0, suggestedSections,
    onSeekAndPlay, onPause, isPlaying,
    getSongTime,
    openEditorRef,
    pendingSelection = null,
    onClearPendingSelection,
    onDuplicateSkipped,
    snapTime,
    onCapabilitiesChange,
    doc, onDocChange, docLoaded,
    selectedLayerId = null, onSelectLayer,
    saveStatus = 'idle',
  }: BoundaryEditorPanelProps,
  controllerRef: ForwardedRef<AnnotationPanelController>,
) {
  const { settings } = useSettings();
  const sectionTypes = getSectionTypes(settings.sectionTypeVocabulary);
  const defaultLayoutName = settings.manualBoundariesDefault === 'custom'
    ? 'Custom — type:bars list'
    : MANUAL_BOUNDARY_PRESETS[settings.manualBoundariesDefault].name;
  const [showInfo, setShowInfo] = useState(false);
  const [showDefaultsModal, setShowDefaultsModal] = useState(false);

  const boundaryLayers = useMemo(
    () => doc.layers.filter((l): l is AnnotationLayer<'boundaries'> => l.type === 'boundaries'),
    [doc.layers],
  );

  // Resolve the layer whose cards render below. Falls back to the first
  // boundary layer when nothing is selected (or the selection was deleted).
  const activeLayer = useMemo<AnnotationLayer<'boundaries'> | null>(() => {
    if (selectedLayerId) {
      const hit = boundaryLayers.find((l) => l.id === selectedLayerId);
      if (hit) return hit;
    }
    return boundaryLayers[0] ?? null;
  }, [boundaryLayers, selectedLayerId]);

  const items = activeLayer?.items ?? [];

  // Bubble up the implicit selection so the sidebar's "active" pill and the
  // ADD-target arithmetic stay in sync with what the editor shows.
  useEffect(() => {
    if (!onSelectLayer) return;
    if (activeLayer && activeLayer.id !== selectedLayerId) onSelectLayer(activeLayer.id);
  }, [activeLayer, selectedLayerId, onSelectLayer]);

  // ── Mutation core ─────────────────────────────────────────────────────────
  // Every edit below funnels through one of these two, so "which layer am I
  // writing to?" is answered in exactly one place.

  const writeItems = useCallback((
    layerId: string,
    next: BoundaryItem[] | ((prev: BoundaryItem[]) => BoundaryItem[]),
    opts?: { coalesceKey?: string; skipHistory?: boolean },
  ) => {
    onDocChange((cur) => {
      let changed = false;
      const layers = cur.layers.map((l) => {
        if (l.id !== layerId) return l;
        const prev = l.items as BoundaryItem[];
        const resolved = typeof next === 'function' ? next(prev) : next;
        if (resolved === prev) return l;
        changed = true;
        return { ...l, items: resolved } as AnnotationLayer;
      });
      // Same document back when nothing moved — the undo stack and the save
      // debounce both take an identical value as "no edit happened".
      return changed ? { ...cur, layers } : cur;
    }, opts);
  }, [onDocChange]);

  /** Write into the active layer, creating "Boundaries 1" if none exists yet.
   *  Returns the layer id that was written to. */
  const writeActive = useCallback((
    next: BoundaryItem[] | ((prev: BoundaryItem[]) => BoundaryItem[]),
    opts?: { coalesceKey?: string; skipHistory?: boolean },
  ): string => {
    if (activeLayer) {
      writeItems(activeLayer.id, next, opts);
      return activeLayer.id;
    }
    const layer = newBoundaryLayer('Boundaries 1', pickDefaultLayerColor(doc.layers));
    const resolved = typeof next === 'function' ? next([]) : next;
    onDocChange((cur) => ({ ...cur, layers: [{ ...layer, items: resolved }, ...cur.layers] }), opts);
    onSelectLayer?.(layer.id);
    return layer.id;
  }, [activeLayer, doc, writeItems, onDocChange, onSelectLayer]);

  const sortOnClose = useCallback(() => {
    if (!activeLayer) return;
    writeItems(
      activeLayer.id,
      // Already in order — hand back the same array, so a close that follows
      // a Delete or a Split doesn't emit a doc at all (useUndoableState drops
      // an identical value, but the layers array would be new every time).
      (prev) => (prev.every((s, i) => i === 0 || prev[i - 1].time <= s.time)
        ? prev
        : [...prev].sort((a, b) => a.time - b.time)),
      { skipHistory: true },
    );
  }, [activeLayer, writeItems]);

  const { editingIdx, popoverRef, positionStyle, close: closeEdit } =
    useSectionEditPopover({ openEditorRef, onClose: sortOnClose });

  // Skip sorting while the popover is open so the index the user is editing
  // stays put; closeEdit re-sorts on dismiss.
  const editingRef = useRef(editingIdx);
  editingRef.current = editingIdx;

  // Normalize the section vocabulary once per song, the first time the page's
  // load settles. Mirrors the old load flow's "resave once if normalization
  // changed something", sourced from the doc prop instead of a panel fetch.
  const normalizedForSongIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!docLoaded || normalizedForSongIdRef.current === songId) return;
    normalizedForSongIdRef.current = songId;
    const layers = doc.layers.filter((l) => l.type === 'boundaries');
    if (layers.length === 0) return;
    let changed = false;
    const nextLayers = doc.layers.map((l) => {
      if (l.type !== 'boundaries') return l;
      const before = l.items as BoundaryItem[];
      const after = normalizeSections(before, sectionTypes) as BoundaryItem[];
      if (after.length === before.length && after.every((s, i) => s === before[i])) return l;
      changed = true;
      return { ...l, items: after } as AnnotationLayer;
    });
    if (changed) onDocChange((cur) => ({ ...cur, layers: nextLayers }), { skipHistory: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docLoaded, songId, doc]);

  // ── Bootstrap / fill-defaults ─────────────────────────────────────────────

  const startAnnotatingWithSections = useCallback((sections: SectionBlock[]) => {
    writeActive(toItems(sections));
  }, [writeActive]);

  // Build the section list the user's saved default would produce. Used by
  // both the "Fill in defaults" quick-apply button and the modal.
  const computeDefaultSections = useCallback((): SectionBlock[] => {
    if (suggestedSections?.length) {
      return normalizeSections(
        suggestedSections.map(({ time, type, label }) => ({ time, type, label })),
        sectionTypes,
      );
    }
    // Resolve the user's saved default. With BPM we lay it out by bars
    // (PRESETS / custom); without BPM fall back to an equal-time split so the
    // button still works on songs that have no grid yet.
    let layout: readonly BarEntry[] = [];
    if (settings.manualBoundariesDefault === 'custom') {
      layout = parseCustomLayout(settings.manualBoundariesCustomLayout).layout;
    } else {
      layout = MANUAL_BOUNDARY_PRESETS[settings.manualBoundariesDefault].layout;
    }
    return songBpm && songBpm > 0 && layout.length > 0
      ? layoutToSections(layout, songBpm, songBeatsPerBar, duration, songGridOffset)
      : buildSequenceSections(
          layout.length > 0
            ? layout.map((e) => ({ type: e.type, label: sectionLabel(e.type) }))
            : RECOMMENDED_SECTION_SEQUENCE,
          duration,
        );
  }, [suggestedSections, sectionTypes, settings.manualBoundariesDefault, settings.manualBoundariesCustomLayout, songBpm, songBeatsPerBar, songGridOffset, duration]);

  const applyDefaultStructure = useCallback(() => {
    writeActive(toItems(computeDefaultSections()));
  }, [computeDefaultSections, writeActive]);

  const startAnnotatingEmpty = useCallback(() => { writeActive([]); }, [writeActive]);

  // ── Add ───────────────────────────────────────────────────────────────────

  // Held in a ref so the add callbacks below don't re-memoize on the parent's
  // inline arrow, and so each one reads the clock when it FIRES.
  const getSongTimeRef = useRef(getSongTime);
  getSongTimeRef.current = getSongTime;

  /** Where the next point-add lands — resolved at click time, never at render
   *  time. While the transport runs, both `currentTime` and a click-pending
   *  pill sit behind the cursor the annotator is actually listening to; see
   *  `resolvePointAddTime` for the rule.
   *
   *  The snap is applied here rather than in each caller so every way of
   *  placing a section at the cursor obeys it: M, "+ Add @ playhead", the
   *  per-row "add after", and a click-pending pill the cursor has since run
   *  past. Clicking already seeks onto the grid, so a mark placed while paused
   *  was landing on a grid line by accident; while the transport runs there is
   *  no click to inherit from, which is why this was ever visible. Snapping a
   *  value that is already on the grid returns it unchanged, so the pill path
   *  keeps the exact time it seeked to. */
  const pointAddTime = useCallback((pendingPoint?: number | null, atTime?: number) => {
    const t = resolvePointAddTime({
      // `atTime` is the caller's own reading of the same clock, taken at the
      // originating keydown (the M shortcut backs the dispatch lag out of it),
      // so it beats reading the clock again here a few milliseconds later.
      live: atTime ?? getSongTimeRef.current?.(),
      fallback: currentTime,
      pendingPoint,
    });
    return snapTime ? snapTime(t) : t;
  }, [currentTime, snapTime]);

  // One marked point = the END of the section being annotated; see
  // boundaryInsert.ts for the rule and why a single mark can't be a start.
  const addSection = useCallback((atTime?: number) => {
    const t = roundTime(pointAddTime(null, atTime));
    // insertBoundaryAtPoint drops a mark that lands on an existing boundary —
    // boundaries tile, so two starts within EDGE_EPS of each other are a
    // contradiction rather than two annotations. It has always done this
    // silently, which reads as an ADD button that didn't fire; say so.
    const existing = (activeLayer?.items as BoundaryItem[] | undefined)
      ?.find((it) => Math.abs(it.time - t) < EDGE_EPS);
    if (existing) {
      onDuplicateSkipped?.(duplicateItemNotice(
        'section boundary', { at: existing.time }, 'nothing was added',
      ));
      return;
    }
    writeActive((prev) => insertBoundaryAtPoint(prev, t));
  }, [pointAddTime, writeActive, activeLayer, onDuplicateSkipped]);

  const addSectionAfter = useCallback((idx: number) => {
    if (!activeLayer) return;
    writeItems(activeLayer.id, (prev) => {
      const next = [...prev];
      const current = next[idx];
      if (!current) return prev;
      const nextStart = idx + 1 < next.length ? next[idx + 1].time : duration;
      const at = pointAddTime();
      const insertionTime = Math.min(Math.max(at, current.time), Math.max(current.time, nextStart));
      next.splice(idx + 1, 0, makeItem(roundTime(insertionTime), 'drop', 'Drop'));
      return next;
    });
  }, [activeLayer, pointAddTime, duration, writeItems]);

  // Insert boundaries from a pending pill:
  //  - Click-only (t2 == null, or a zero-width drag): the click is a single
  //    marked point, so it goes through insertBoundaryAtPoint — it ENDS the
  //    section being annotated rather than starting one.
  //  - Range (t2 != null): the drag already says where the section starts AND
  //    stops, so it drops both — 'drop' at t1 (the section the user just
  //    highlighted) and 'unset' at t2 (a placeholder end-cap so the new
  //    section stops at t2 instead of swallowing whatever follows).
  //
  // The head may land on a boundary that already exists, as long as that
  // boundary is an unset cap: dragging the next section to start exactly where
  // the previous one stopped is the normal way to build a run of sections, and
  // the thing sitting at t1 is then the cap the previous range-add left behind.
  const insertFromPendingSelection = useCallback((sel: PendingSelection, forcedLayerId: string | null = null) => {
    const t1 = roundTime(sel.t1);
    const t2 = sel.t2 != null ? roundTime(sel.t2) : null;
    const eps = EDGE_EPS;
    const isPoint = t2 == null || Math.abs(t2 - t1) < eps;
    const apply = (prev: BoundaryItem[]): BoundaryItem[] => {
      // The pill's own time only wins while the cursor is still sitting on it
      // — press ADD after playing past the mark and the mark is stale.
      if (isPoint) return insertBoundaryAtPoint(prev, pointAddTime(t1));
      const next = [...prev];
      const indexAt = (time: number) => next.findIndex((s) => Math.abs(s.time - time) < eps);
      let changed = false;

      const headIdx = indexAt(t1);
      if (headIdx === -1) {
        next.push(makeSectionItem(t1));
        changed = true;
      } else if (next[headIdx].type === UNSET_TYPE) {
        // Keep the cap's own time so the shared edge doesn't jitter by up to
        // eps, and keep any fields it carries (beat anchor, description).
        next[headIdx] = promoteCap(next[headIdx]);
        changed = true;
      }
      // A tail never overwrites: an already-typed boundary at t2 is the start
      // of a real section, and downgrading it to a cap would erase it.
      if (t2 != null && indexAt(t2) === -1) {
        next.push(makeUnsetCap(t2));
        changed = true;
      }
      if (!changed) return prev;
      return next.sort((a, b) => a.time - b.time);
    };
    if (forcedLayerId && boundaryLayers.some((l) => l.id === forcedLayerId)) {
      writeItems(forcedLayerId, apply);
      onSelectLayer?.(forcedLayerId);
    } else {
      writeActive(apply);
    }
  }, [boundaryLayers, pointAddTime, writeItems, writeActive, onSelectLayer]);

  const confirmPendingForLayer = useCallback((forcedLayerId: string | null) => {
    if (!pendingSelection) return;
    insertFromPendingSelection(pendingSelection, forcedLayerId);
    onClearPendingSelection?.();
  }, [pendingSelection, insertFromPendingSelection, onClearPendingSelection]);

  const confirmPendingSelection = useCallback(() => { confirmPendingForLayer(null); }, [confirmPendingForLayer]);

  // "+ Add" adopts a highlighted region when there is one — the drag IS what
  // the annotator asked to add, so the filler-cap workflow at the playhead
  // only runs when there is nothing highlighted to consume.
  const addSectionOrPending = useCallback((atTime?: number) => {
    if (pendingSelection) { confirmPendingSelection(); return; }
    addSection(atTime);
  }, [pendingSelection, confirmPendingSelection, addSection]);

  const addSectionInLayer = useCallback((layerId: string, atTime?: number) => {
    onSelectLayer?.(layerId);
    if (pendingSelection) { confirmPendingForLayer(layerId); return; }
    writeItems(layerId, (prev) => insertBoundaryAtPoint(prev, pointAddTime(null, atTime)));
  }, [pointAddTime, pendingSelection, confirmPendingForLayer, writeItems, onSelectLayer]);

  // ── Per-item edits ────────────────────────────────────────────────────────

  const updateSection = useCallback((
    idx: number,
    field: 'time' | 'endTime' | 'type' | 'label' | 'importance' | 'description',
    value: string | number,
  ) => {
    if (!activeLayer) return;
    // Coalesce streaming inputs (typing in label/description/time fields) so
    // the whole edit collapses into one undo. Discrete actions
    // (type/importance) stay individual history entries.
    const coalesceKey =
      field === 'label'       ? `label-${idx}` :
      field === 'description' ? `desc-${idx}` :
      field === 'time'        ? `time-${idx}`  :
      field === 'endTime'     ? `endTime-${idx}` :
      undefined;
    writeItems(activeLayer.id, (prev) => {
      const next = [...prev];
      if (field === 'endTime') {
        // The "end" of section i IS the start of section i+1 — editing it
        // moves the shared edge, which is what tiling means.
        if (idx + 1 < next.length && typeof value === 'number') {
          next[idx + 1] = { ...next[idx + 1], time: value };
          if (editingRef.current === null) next.sort((a, b) => a.time - b.time);
        }
      } else if (field === 'type' && typeof value === 'string') {
        const type = normalizeSectionType(value, sectionTypes);
        const cur = next[idx].label ?? '';
        const shouldSync = cur.trim() === '' || sectionTypes.some((t) => sectionLabel(t).toLowerCase() === cur.toLowerCase());
        next[idx] = { ...next[idx], type, label: shouldSync ? sectionLabel(type) : normalizeSectionLabel(cur) };
      } else if (field === 'label' && typeof value === 'string') {
        next[idx] = { ...next[idx], label: normalizeSectionLabel(value) };
      } else {
        next[idx] = { ...next[idx], [field]: value };
        if (field === 'time' && editingRef.current === null) next.sort((a, b) => a.time - b.time);
      }
      return next;
    }, coalesceKey ? { coalesceKey } : undefined);
  }, [activeLayer, sectionTypes, writeItems]);

  const deleteSection = useCallback((idx: number) => {
    if (!activeLayer) return;
    writeItems(activeLayer.id, (prev) => prev.filter((_, i) => i !== idx));
  }, [activeLayer, writeItems]);

  const addCandidate = useCallback((idx: number, time: number) => {
    if (!activeLayer) return;
    writeItems(activeLayer.id, (prev) => {
      const s = prev[idx];
      if (!s) return prev;
      const existing = [s.time, ...(s.candidates ?? [])];
      if (existing.some((t) => Math.abs(t - time) < 0.05)) return prev;
      const next = [...prev];
      next[idx] = { ...s, candidates: [...(s.candidates ?? []), Math.round(time * 1000) / 1000].sort((a, b) => a - b) };
      return next;
    });
  }, [activeLayer, writeItems]);

  const removeCandidate = useCallback((idx: number, ci: number) => {
    if (!activeLayer) return;
    writeItems(activeLayer.id, (prev) => {
      const s = prev[idx];
      if (!s) return prev;
      const candidates = (s.candidates ?? []).filter((_, j) => j !== ci);
      const next = [...prev];
      next[idx] = { ...s, candidates: candidates.length ? candidates : undefined };
      return next;
    });
  }, [activeLayer, writeItems]);

  const splitSection = useCallback((idx: number) => {
    if (!activeLayer) return;
    writeItems(activeLayer.id, (prev) => {
      const s = prev[idx];
      if (!s) return prev;
      const end = idx + 1 < prev.length ? prev[idx + 1].time : duration;
      const mid = Math.round(currentTime * 1000) / 1000;
      if (mid <= s.time || mid >= end) return prev;
      const next = [...prev];
      next.splice(
        idx, 1,
        { ...s, label: `${s.label} A` },
        makeItem(mid, s.type, `${s.label} B`),
      );
      return next;
    });
  }, [activeLayer, currentTime, duration, writeItems]);

  // ── Layer-level actions ───────────────────────────────────────────────────

  const addLayerViaToolbar = useCallback(() => {
    const layer = newBoundaryLayer(`Boundaries ${boundaryLayers.length + 1}`, pickDefaultLayerColor(doc.layers));
    onDocChange((cur) => ({ ...cur, layers: [...cur.layers, layer] }));
    onSelectLayer?.(layer.id);
  }, [doc, boundaryLayers.length, onDocChange, onSelectLayer]);

  const setBoundariesStage = useCallback((stage: AnnotationStage) => {
    // Status is review metadata, not an annotation edit — keep it out of undo.
    onDocChange((cur) => setLayerStatus(cur, 'boundaries', stage), { skipHistory: true });
  }, [onDocChange]);

  const importFromSections = useCallback((sections: SectionBlock[]) => {
    writeActive(toItems(sections));
  }, [writeActive]);

  const readTextFile = useCallback((file: File, parse: (text: string) => void) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      try { parse((ev.target?.result as string) ?? ''); }
      catch (err) { alert(err instanceof Error ? err.message : 'Could not parse file.'); }
    };
    reader.readAsText(file);
  }, []);

  const importJsonFile = useCallback((file: File) => {
    readTextFile(file, (text) => {
      const { sections } = parseTimeCuesJson(text);
      importFromSections(normalizeSections(sections, sectionTypes));
    });
  }, [readTextFile, importFromSections, sectionTypes]);

  const importAudacityFile = useCallback((file: File) => {
    readTextFile(file, (text) => importFromSections(parseAudacity(text)));
  }, [readTextFile, importFromSections]);

  const importCsvFile = useCallback((file: File) => {
    readTextFile(file, (text) => {
      // Auto-route between REAPER and Sonic Visualiser. REAPER's header (or
      // row prefix) is unmistakable; everything else falls back to Sonic
      // Visualiser.
      const firstNonEmpty = text.split('\n').find((l) => l.trim());
      const isReaper = !!firstNonEmpty && (
        firstNonEmpty.trim().startsWith('#,Name,Start') ||
        /^[RM]\d+,/i.test(firstNonEmpty.trim())
      );
      importFromSections(isReaper ? parseReaperCsv(text) : parseSonicVisualiser(text));
    });
  }, [readTextFile, importFromSections]);

  const importJamsFile = useCallback((file: File) => {
    readTextFile(file, (text) => importFromSections(parseJams(text)));
  }, [readTextFile, importFromSections]);

  const importLabFile = useCallback((file: File) => {
    readTextFile(file, (text) => importFromSections(parseMirEvalLab(text)));
  }, [readTextFile, importFromSections]);

  const exportBoundariesJson = useCallback(() => {
    const boundariesOnly: AnnotationLayersDocument = {
      ...doc,
      layers: doc.layers.filter((l) => l.type === 'boundaries'),
    };
    const blob = new Blob([JSON.stringify(boundariesOnly, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `boundaries-all_layers-${doc.song}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [doc]);

  /** Drop every boundary layer for this song. Scoped to boundaries — the other
   *  layer kinds in the same document are untouched. */
  const deleteAllBoundaries = useCallback(() => {
    onDocChange((cur) => ({ ...cur, layers: cur.layers.filter((l) => l.type !== 'boundaries') }));
    onSelectLayer?.(null);
  }, [onDocChange, onSelectLayer]);

  // ── Page-level controller wiring ──────────────────────────────────────────
  // Split-at-playhead resolves to whichever section currently contains the
  // playhead; the toolbar shows it disabled when there is none.
  const sectionAtPlayhead = (() => {
    for (let i = 0; i < items.length; i++) {
      const s = items[i];
      const next = i + 1 < items.length ? items[i + 1].time : duration;
      if (currentTime >= s.time && currentTime < next) return i;
    }
    return -1;
  })();
  const canSplitAtPlayhead = sectionAtPlayhead >= 0;
  const splitAtPlayhead = useCallback(() => {
    if (sectionAtPlayhead >= 0) splitSection(sectionAtPlayhead);
  }, [sectionAtPlayhead, splitSection]);

  const hasAnyLayer = boundaryLayers.length > 0;

  useImperativeHandle<AnnotationPanelController, AnnotationPanelController>(controllerRef, () => ({
    setStatus: setBoundariesStage,
    split: splitAtPlayhead,
    addAtPlayhead: (atTime) => addSectionOrPending(atTime),
    addAtPlayheadInLayer: addSectionInLayer,
    addLayer: addLayerViaToolbar,
    confirmPending: () => confirmPendingSelection(),
    fillDefaults: () => applyDefaultStructure(),
    chooseStructure: () => setShowDefaultsModal(true),
    exportJson: exportBoundariesJson,
    importJson: importJsonFile,
    importAudacity: importAudacityFile,
    importCsv: importCsvFile,
    importJams: importJamsFile,
    importLab: importLabFile,
    deleteAll: deleteAllBoundaries,
  }), [
    setBoundariesStage, splitAtPlayhead, addSectionOrPending, addSectionInLayer,
    addLayerViaToolbar, confirmPendingSelection, applyDefaultStructure,
    exportBoundariesJson,
    importJsonFile, importAudacityFile, importCsvFile, importJamsFile, importLabFile,
    deleteAllBoundaries,
  ]);

  // Emit a capabilities snapshot whenever toolbar-visible state changes.
  // Undo/redo stay false (per `emptyCapabilities()`) — this type's edit
  // history lives in the page-level shared undo stack, and the page overrides
  // canUndo/canRedo uniformly for every annotation type.
  useEffect(() => {
    if (!onCapabilitiesChange) return;
    const splitLabel = `Split at ${fmtTime(currentTime)}`;
    const bpmReady = !!songBpm && songBpm > 0;
    const suggestedCount = suggestedSections?.length ?? 0;
    onCapabilitiesChange({
      ...emptyCapabilities(),
      status: getLayerStatus(doc, 'boundaries'),
      hasItems: boundaryLayers.some((l) => l.items.length > 0),
      saveStatus,
      canSplit: canSplitAtPlayhead,
      splitVisible: true,
      splitDisabledReason: canSplitAtPlayhead ? undefined : 'Move the playhead inside a section to enable Split',
      splitLabel,
      canAddAtPlayhead: bpmReady,
      canAddLayer: true,
      addLabel: pendingSelection
        ? (pendingSelection.t2 != null
            ? `+ Add ${fmtTime(Math.min(pendingSelection.t1, pendingSelection.t2))}→${fmtTime(Math.max(pendingSelection.t1, pendingSelection.t2))}`
            : `+ Add @ ${fmtTime(pendingSelection.t1)}`)
        : `+ Add @ ${fmtTime(currentTime)}`,
      canFillDefaults: bpmReady,
      fillDefaultsLabel: suggestedCount ? `✨ Fill (${suggestedCount})` : '✨ Fill defaults',
      fillDefaultsTooltip: bpmReady
        ? `Pre-fill using your saved default (${defaultLayoutName})`
        : 'Set the BPM in the Song Info panel to enable Fill defaults',
      pending: pendingSelection ?? null,
      pendingRequiresRegion: false,
      importFormats: ['json', 'audacity', 'csv', 'jams', 'lab'],
      canExport: hasAnyLayer,
      canDeleteAll: hasAnyLayer,
    });
  }, [
    onCapabilitiesChange, doc, boundaryLayers, hasAnyLayer, saveStatus,
    canSplitAtPlayhead, currentTime, pendingSelection,
    songBpm, suggestedSections, defaultLayoutName,
  ]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (!docLoaded) return <div className="text-[11px] text-slate-600 animate-pulse py-2 font-mono">Loading annotation…</div>;

  const bpmReady = !!songBpm && songBpm > 0;

  return (
    <div className="space-y-5">
      {/* Toolbar (status pill / undo / files / split / delete) + pending pill +
          "+ Add" are rendered by InspectorPageV2 above this panel via the
          shared AnnotationToolbar / AnnotationAddPanel — fed by the controller
          exposed via forwardRef and the capability snapshot above. */}

      <div className="space-y-2">
        <SectionsHeader onShowInfo={() => setShowInfo(true)} />

        {(() => {
          // Unset-type sections are invisible end-caps managed automatically
          // by the filler-cap workflow. Hide them from the card list so the
          // cursor value only ever appears as the END of the previous card,
          // never as the START of a new one. Orphans are the exception: they
          // wear `unset` because their type left the vocabulary, and hiding
          // them would strand a real section with no card to re-type it on.
          // Preserve original array indices so mutations land on the right slot.
          const visibleSections = items
            .map((s, i) => ({ s, i }))
            .filter(({ s }) => s.type !== UNSET_TYPE || isOrphanedSection(s));
          return visibleSections.length === 0 ? (
            <SectionsEmptyMessage
              bpmReady={bpmReady}
              onStartEmpty={bpmReady && !hasAnyLayer ? startAnnotatingEmpty : undefined}
            />
          ) : (
            <div className={`flex flex-wrap items-start ${getIsMobile() ? 'gap-1.5' : 'gap-3'} max-h-[480px] overflow-y-auto pb-1`}>
              {visibleSections.map(({ s, i }) => {
                const endTime = sectionEnd(items, i, duration);
                const isLast = i === items.length - 1;
                const isSectionPlaying = !!isPlaying && currentTime >= s.time && currentTime < endTime;
                const isCurrentSection = currentTime >= s.time && currentTime < endTime;
                return (
                  <SectionCard
                    key={s.id}
                    index={i}
                    section={s}
                    endTime={endTime}
                    isLast={isLast}
                    highlightCurrent={isCurrentSection}
                    activeBpm={songBpm}
                    onSnapStart={() => updateSection(i, 'time', currentTime)}
                    onSnapEnd={() => updateSection(i, 'endTime', currentTime)}
                    onSplit={() => splitSection(i)}
                    onTypeChange={(t) => updateSection(i, 'type', t)}
                    onLabelChange={(v) => updateSection(i, 'label', v)}
                    onToggleImportance={() => updateSection(i, 'importance', s.importance === 'optional' ? 'critical' : 'optional')}
                    onAddCandidate={() => addCandidate(i, currentTime)}
                    onRemoveCandidate={(ci) => removeCandidate(i, ci)}
                    onDelete={() => deleteSection(i)}
                    onPlay={() => onSeekAndPlay?.(s.time, endTime)}
                    onStop={() => onPause?.()}
                    isPlaying={isSectionPlaying}
                    onInsertAfter={() => addSectionAfter(i)}
                  />
                );
              })}
              <AddSectionAtEndCard onClick={() => addSectionOrPending()} />
            </div>
          );
        })()}
      </div>

      <p className="text-[10px] text-slate-700 font-mono">Last edited: {new Date(doc.annotated_at).toLocaleString()}</p>

      {/* ── Section edit popover — shared AnnotationPointCard via BoundaryEditPopover. */}
      {editingIdx !== null && items[editingIdx] && (() => {
        const idx = editingIdx;
        const s = items[idx];
        const endT = sectionEnd(items, idx, duration);
        const sectionIsPlaying = !!isPlaying && currentTime >= s.time && currentTime < endT;
        const canSplit = currentTime > s.time && currentTime < endT;
        return (
          <BoundaryEditPopover
            index={idx}
            section={s}
            endTime={endT}
            popoverRef={popoverRef}
            positionStyle={positionStyle}
            onChange={(patch) => {
              if (patch.time !== undefined)        updateSection(idx, 'time', patch.time);
              if (patch.type !== undefined)        updateSection(idx, 'type', patch.type);
              if (patch.label !== undefined)       updateSection(idx, 'label', patch.label);
              if (patch.description !== undefined) updateSection(idx, 'description', patch.description);
              if (patch.importance !== undefined)  updateSection(idx, 'importance', patch.importance);
            }}
            onDelete={() => { deleteSection(idx); closeEdit(); }}
            onClose={closeEdit}
            onPlay={onSeekAndPlay ? () => onSeekAndPlay(s.time, endT) : undefined}
            onStop={onPause}
            isPlaying={sectionIsPlaying}
            bpm={songBpm}
            gridOffset={songGridOffset}
            beatsPerBar={songBeatsPerBar}
            currentTime={currentTime}
            onSplit={() => splitSection(idx)}
            canSplit={canSplit}
          />
        );
      })()}

      {/* ── Section info dialog ───────────────────────────────────────────── */}
      {showInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setShowInfo(false)}>
          <div className="bg-[#14171d] border border-white/[0.08] rounded-md shadow-2xl shadow-black/80 p-5 w-[440px] max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-white/[0.05]">
              <span className="text-[11px] font-medium text-slate-200 uppercase tracking-wider">Section vocabulary</span>
              <button onClick={() => setShowInfo(false)} className="text-slate-500 hover:text-slate-200 transition-colors text-base leading-none">✕</button>
            </div>
            <div className="space-y-2">
              {sectionTypes.map((t) => {
                const col = sectionColor(t);
                return (
                  <div key={t} className="flex gap-3 items-stretch py-1 border-l-2 pl-3" style={{ borderLeftColor: col }}>
                    <span className="shrink-0 self-start text-[10px] font-mono uppercase tracking-wider" style={{ color: col }}>
                      {sectionLabel(t)}
                    </span>
                    <span className="text-[11px] text-slate-400 leading-relaxed">{SECTION_INFO[t]}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <FillDefaultsModal
        open={showDefaultsModal}
        onOpenChange={setShowDefaultsModal}
        bpm={songBpm ?? 0}
        beatsPerBar={songBeatsPerBar}
        duration={duration}
        gridOffset={songGridOffset}
        onApply={startAnnotatingWithSections}
      />
    </div>
  );
}

export const BoundaryEditorPanel = forwardRef<AnnotationPanelController, BoundaryEditorPanelProps>(BoundaryEditorPanelInner);
BoundaryEditorPanel.displayName = 'BoundaryEditorPanel';

// ─── Shared empty-state pieces ──────────────────────────────────────────────
// The slim header row holds just the section label + the vocabulary-info
// button; setup actions (+ Add, ✨ Fill defaults, ≡ Choose structure) live in
// the right-edge Annotate sidebar so one toolbar drives every annotation type.

function SectionsHeader({ onShowInfo }: { onShowInfo: () => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <label className="text-[10px] text-slate-300 uppercase tracking-wider font-medium">Structure Sections</label>
      <button onClick={onShowInfo}
        className="w-4 h-4 flex items-center justify-center rounded-full border border-white/[0.08] text-slate-500 hover:text-violet-300 hover:border-violet-500/50 text-[10px] transition-colors"
        title="Section type reference">ⓘ</button>
    </div>
  );
}

function SectionsEmptyMessage({ bpmReady, onStartEmpty }: { bpmReady: boolean; onStartEmpty?: () => void }) {
  return (
    <div className="px-3 py-3 rounded border border-white/[0.06] bg-white/[0.02] text-[11px] text-slate-500 italic">
      {bpmReady ? (
        <>
          No sections yet —{' '}
          {onStartEmpty && (
            <>
              <button
                onClick={onStartEmpty}
                className="text-violet-400 not-italic hover:text-violet-300 transition-colors underline"
                title="Create an empty boundary layer with no sections"
              >Start empty</button>{' '}to build section by section, or{' '}
            </>
          )}
          open the <span className="text-slate-300 not-italic">Annotate</span> sidebar and click <span className="text-slate-300 not-italic">+ Add</span> to place the first section from the start of the track to the playhead.
        </>
      ) : (
        <span className="text-amber-400 not-italic font-mono">Set the BPM in the Dataprep tab</span>
      )}
    </div>
  );
}
