import { useState, useEffect, useRef, useCallback, useMemo, useImperativeHandle, forwardRef, type ForwardedRef } from 'react';
import type { ManualAnnotation, ManualSection, EyeStatus } from '../../types/manualAnnotation';
import type { SongInfo } from '../../types/songInfo';
import { effectiveAnchors } from '../../types/songInfo';
import { beatsPerBarFromTimeSignature, snapTimeToGrid } from '../../utils/beatGrid';
import { loadEyeAnnotation, saveEyeAnnotationToServer, deleteEyeAnnotation } from '../../services/manualAnnotations';
import type { AnnotationStage } from '../../types/annotationLayer';
import type { AnnotationPanelController, AnnotationPanelCapabilities } from './shared/AnnotationPanelController';
import type { PendingSelection } from './AnnotationOverlays';
import { useSectionEditPopover } from './useSectionEditPopover';
import { useUndoableState } from '../../hooks/useUndoableState';
import { SectionCard, AddSectionAtEndCard } from './SectionCard';
import { BoundaryEditPopover } from './BoundaryEditPopover';
import {
  sectionLabel,
  autoLabel,
  fmtTime,
  sectionEnd as computeSectionEnd,
} from './sectionConstants';
import {
  parseTimeCuesJson,
  parseAudacity,
  parseSonicVisualiser,
  parseJams,
  parseMirEvalLab,
  parseReaperCsv,
} from '../../utils/importParsers';
import type { RefObject } from 'react';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface EyeEditorPanelProps {
  songId: string;
  currentTime: number;
  duration: number;
  /** Song-level metadata (BPM / time signature / grid offset). Required for the beat grid. */
  songInfo?: SongInfo | null;
  /** Pending selection lifted from InspectorPageV2 / SharedVizPanel interaction */
  pendingSelection: PendingSelection | null;
  onClearPendingSelection: () => void;
  onAnnotationChange?: (ann: ManualAnnotation | null) => void;
  /** Snap-to-grid toggle lifted to page level (VizControlBar) */
  snapToGrid?: boolean;
  /** Imperative handle: parent calls this to open/close the section edit popover. */
  openEditorRef?: RefObject<((idx: number | null, anchor?: { x: number; y: number }) => void) | null>;
  /** Imperative handle: parent calls this to add an eye point at the given time (used by the M keyboard shortcut). */
  addPointAtRef?: RefObject<((time: number) => void) | null>;
  /** Imperative handle: parent calls this to retime an existing eye point by its array index
   *  (used by the marker-drag callback wired in from SharedVizPanel). */
  setPointTimeRef?: RefObject<((idx: number, time: number) => void) | null>;
  /** Fired once when a marker drag begins — parent uses it to snapshot for undo. */
  pushUndoRef?: RefObject<(() => void) | null>;
  /** Bumping this forces a reload from the server (used after a top-level DELETE / IMPORT). */
  reloadKey?: number;
  /** Page-level subscription that fires whenever the toolbar-visible state
   *  changes. Fed to the shared AnnotationToolbar above this panel. */
  onCapabilitiesChange?: (caps: AnnotationPanelCapabilities) => void;
  /** Audio control wired by InspectorPageV2 — required for the play button
   *  on the boundary edit popover (0.5s preview). When omitted the play
   *  button is hidden. */
  onSeekAndPlay?: (time: number, stopTime?: number) => void;
  onPause?: () => void;
  playerIsPlaying?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

function EyeEditorPanelInner(
  {
    songId, currentTime, duration,
    songInfo,
    pendingSelection, onClearPendingSelection,
    onAnnotationChange,
    snapToGrid: snapToGridProp = false,
    openEditorRef,
    addPointAtRef,
    setPointTimeRef,
    pushUndoRef,
    reloadKey = 0,
    onCapabilitiesChange,
    onSeekAndPlay,
    onPause,
    playerIsPlaying = false,
  }: EyeEditorPanelProps,
  controllerRef: ForwardedRef<AnnotationPanelController>,
) {
  const [annotation, setAnnotation, undoCtl] = useUndoableState<ManualAnnotation | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [isLoaded, setIsLoaded] = useState(false);
  const sortOnClose = useCallback(() => {
    setAnnotation((prev) => prev
      ? { ...prev, sections: [...prev.sections].sort((a, b) => a.time - b.time), annotated_at: new Date().toISOString() }
      : prev
    , { skipHistory: true });
  }, [setAnnotation]);
  const { editingIdx, popoverRef, positionStyle, close: closeEdit } =
    useSectionEditPopover({ openEditorRef, onClose: sortOnClose });

  const snapToGrid = snapToGridProp;

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef('');
  // Tracks the previous `sections` reference. A new array reference means the
  // user actually edited content (vs. flipping the status dropdown), so we can
  // auto-bump the eye_status. Reset on song change.
  const prevSectionsRef = useRef<ManualSection[] | undefined>(undefined);

  useEffect(() => { onAnnotationChange?.(annotation); }, [annotation, onAnnotationChange]);

  // ⌘Z / ⇧⌘Z → undo / redo. Skip when typing in an editable field so the
  // browser's native input undo wins inside text/number inputs.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.key === 'z' || e.key === 'Z')) return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
      if (e.shiftKey) {
        if (!undoCtl.canRedo) return;
        e.preventDefault();
        undoCtl.redo();
      } else {
        if (!undoCtl.canUndo) return;
        e.preventDefault();
        undoCtl.undo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undoCtl]);

  // ── Load on song change ──────────────────────────────────────────────────
  useEffect(() => {
    setIsLoaded(false); undoCtl.reset(null); setSaveStatus('idle');
    lastSavedRef.current = '';
    prevSectionsRef.current = undefined;
    loadEyeAnnotation(songId).then((ex) => {
      if (ex) { undoCtl.reset(ex); prevSectionsRef.current = ex.sections; }
      setIsLoaded(true);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songId, reloadKey]);

  // Auto-bump eye_status from "none" → "wip" on the first content edit.
  // Uses sections reference equality so status-only changes don't trigger.
  useEffect(() => {
    if (!annotation || !isLoaded) return;
    if (prevSectionsRef.current === annotation.sections) return;
    prevSectionsRef.current = annotation.sections;
    const status = annotation.eye_status ?? 'none';
    if (status !== 'none') return;
    setAnnotation((prev) => prev ? { ...prev, eye_status: 'wip' as EyeStatus } : prev, { skipHistory: true });
  }, [annotation, isLoaded, setAnnotation]);

  // ── Auto-save (debounced 1 s) ─────────────────────────────────────────────
  useEffect(() => {
    if (!annotation || !isLoaded) return;
    const s = JSON.stringify(annotation);
    if (s === lastSavedRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSaveStatus('saving');
    debounceRef.current = setTimeout(async () => {
      const ok = await saveEyeAnnotationToServer(songId, annotation);
      if (ok) { lastSavedRef.current = s; setSaveStatus('saved'); setTimeout(() => setSaveStatus(x => x === 'saved' ? 'idle' : x), 2000); }
      else setSaveStatus('error');
    }, 1000);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [annotation, isLoaded, songId]);

  // ── Active BPM / offset (from SongInfo) ───────────────────────────────────
  const activeBpm = songInfo?.bpm;
  const activeBeatOffset = songInfo?.gridOffset ?? 0;
  const activeBeatsPerBar = beatsPerBarFromTimeSignature(songInfo?.timeSignature);
  // Anchored / pinned grid state — snap behaviour must match what the
  // curator sees on the canvas (Dynamic = anchors only; Manual = anchors
  // + per-beat overrides; Static = neither).
  const activeAnchors = songInfo?.gridMode === 'static' ? undefined : songInfo?.tempoAnchors;
  const activeBeatOverrides = songInfo?.gridMode === 'manual' ? songInfo?.beatOverrides : undefined;

  // ── Snap helper ───────────────────────────────────────────────────────────
  const snap = useCallback((t: number) =>
    snapToGrid && activeBpm
      ? snapTimeToGrid(t, activeBpm, activeBeatOffset, activeBeatsPerBar, 'beat', activeAnchors, activeBeatOverrides)
      : t,
  [snapToGrid, activeBpm, activeBeatOffset, activeBeatsPerBar, activeAnchors, activeBeatOverrides]);

  // Snapped view of current pending selection (for display + confirm)
  const snappedPending = useMemo(() => {
    if (!pendingSelection) return null;
    return {
      t1: snap(pendingSelection.t1),
      t2: pendingSelection.t2 !== null ? snap(pendingSelection.t2) : null,
    };
  }, [pendingSelection, snap]);

  // ── Base annotation builder ───────────────────────────────────────────────
  // BPM / time-signature / grid offset live on SongInfo now — not embedded here.
  const makeBase = useCallback((): ManualAnnotation => ({
    song: songId,
    annotated_at: new Date().toISOString(),
    reviewed: false,
    eye_status: 'none' as EyeStatus,
    sections: [],
  }), [songId]);

  // ── Import (round-trip the 3 export formats) ─────────────────────────────
  const importFromSections = useCallback((sections: ManualSection[]) => {
    setAnnotation((prev) => {
      const now = new Date().toISOString();
      if (prev) return { ...prev, sections, annotated_at: now };
      return { ...makeBase(), sections, annotated_at: now };
    });
  }, [makeBase, setAnnotation]);

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
      const { sections, rest } = parseTimeCuesJson(text);
      // Replace whole annotation; preserve unknown metadata (eye_status, etc.),
      // force song = current slug so we save under the right file.
      setAnnotation({
        ...makeBase(),
        ...(rest as Partial<ManualAnnotation>),
        sections,
        song: songId,
        annotated_at: new Date().toISOString(),
      });
    });
  }, [readTextFile, makeBase, songId, setAnnotation]);

  const importAudacityFile = useCallback((file: File) => {
    readTextFile(file, (text) => importFromSections(parseAudacity(text)));
  }, [readTextFile, importFromSections]);

  const importCsvFile = useCallback((file: File) => {
    readTextFile(file, (text) => {
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

  // ── Annotation creation ───────────────────────────────────────────────────
  const createPoint = useCallback((time: number) => {
    const t = Math.round(time * 100) / 100;
    setAnnotation((prev) => {
      const base = prev ?? makeBase();
      if (base.sections.some((s) => Math.abs(s.time - t) <= 0.5)) return base;
      const sections = [...base.sections, { time: t, type: 'drop', label: autoLabel(base.sections, 'drop') }]
        .sort((a, b) => a.time - b.time);
      return { ...base, sections, annotated_at: new Date().toISOString() };
    });
  }, [makeBase, setAnnotation]);

  const createRegion = useCallback((t1: number, t2: number) => {
    const start = Math.round(t1 * 100) / 100;
    const end   = Math.round(t2 * 100) / 100;
    setAnnotation((prev) => {
      const base = prev ?? makeBase();
      const sections = [...base.sections];
      if (!sections.some((s) => Math.abs(s.time - start) <= 0.5))
        sections.push({ time: start, type: 'drop', label: autoLabel(sections, 'drop') });
      if (!sections.some((s) => Math.abs(s.time - end) <= 0.5))
        sections.push({ time: end, type: 'drop', label: autoLabel(sections, 'drop') });
      sections.sort((a, b) => a.time - b.time);
      return { ...base, sections, annotated_at: new Date().toISOString() };
    });
  }, [makeBase, setAnnotation]);

  // Expose createPoint so InspectorPageV2's M keyboard shortcut can add an eye
  // point at the playhead — mirrors the manual setSectionsRef pattern.
  useEffect(() => {
    if (addPointAtRef) addPointAtRef.current = createPoint;
    return () => { if (addPointAtRef) addPointAtRef.current = null; };
  }, [addPointAtRef, createPoint]);

  // Imperative point-retime path used by the marker-drag callback wired from
  // SharedVizPanel. Uses a coalesceKey so the entire drag collapses to one
  // undo entry — `useUndoableState` snapshots only on the first call.
  const setPointTimeAt = useCallback((idx: number, time: number) => {
    setAnnotation((prev) => {
      if (!prev) return prev;
      const sections = prev.sections.slice();
      if (idx < 0 || idx >= sections.length) return prev;
      sections[idx] = { ...sections[idx], time };
      return { ...prev, sections, annotated_at: new Date().toISOString() };
    }, { coalesceKey: `eye-marker-drag-${idx}` });
  }, [setAnnotation]);

  useEffect(() => {
    if (setPointTimeRef) setPointTimeRef.current = setPointTimeAt;
    return () => { if (setPointTimeRef) setPointTimeRef.current = null; };
  }, [setPointTimeRef, setPointTimeAt]);

  // No-op so pushUndoRef can still be passed even when the panel routes undo
  // through the coalesced setter above. Kept callable for parity with other
  // panels that may snapshot on drag-start.
  const pushUndo = useCallback(() => {}, []);
  useEffect(() => {
    if (pushUndoRef) pushUndoRef.current = pushUndo;
    return () => { if (pushUndoRef) pushUndoRef.current = null; };
  }, [pushUndoRef, pushUndo]);

  // ── Confirm pending selection → create annotation ─────────────────────────
  const confirmAnnotation = useCallback(() => {
    if (!snappedPending) return;
    if (snappedPending.t2 !== null) {
      createRegion(snappedPending.t1, snappedPending.t2);
    } else {
      createPoint(snappedPending.t1);
    }
    onClearPendingSelection();
  }, [snappedPending, createPoint, createRegion, onClearPendingSelection]);

  // ── Section editors ────────────────────────────────────────────────────────
  // Skip sort while the edit modal is open so the section index stays stable
  // while the user is editing time. We re-sort once on close.
  const editingRef = useRef(editingIdx);
  editingRef.current = editingIdx;

  const updateSection = useCallback((idx: number, field: 'time' | 'type' | 'label' | 'importance', value: string | number) => {
    // Coalesce streaming inputs (label typing, numeric time edits, repeated
    // snap-to-playhead clicks on the same boundary) into one undo entry.
    const coalesceKey =
      field === 'label' ? `label-${idx}` :
      field === 'time'  ? `time-${idx}`  :
      undefined;
    setAnnotation((prev) => {
      if (!prev) return prev;
      const sections = [...prev.sections];
      if (field === 'type' && typeof value === 'string') {
        const othersOfType = sections.filter((s, i) => i !== idx && s.type === value);
        sections[idx] = { ...sections[idx], type: value, label: `${sectionLabel(value)} ${othersOfType.length + 1}` };
      } else {
        sections[idx] = { ...sections[idx], [field]: value };
        if (field === 'time' && editingRef.current === null) sections.sort((a, b) => a.time - b.time);
      }
      return { ...prev, sections, annotated_at: new Date().toISOString() };
    }, coalesceKey ? { coalesceKey } : undefined);
  }, [setAnnotation]);

  /** Apply an arbitrary partial patch to a section. Used by the boundary
   *  edit popover, which sends `{ time?, label?, description?, importance?, type? }`
   *  patches at once. Coalesces typing on label/description into one undo entry. */
  const patchSection = useCallback((idx: number, patch: Partial<ManualSection>) => {
    const coalesceKey =
      patch.label !== undefined ? `label-${idx}` :
      patch.description !== undefined ? `desc-${idx}` :
      patch.time !== undefined ? `time-${idx}` :
      undefined;
    setAnnotation((prev) => {
      if (!prev) return prev;
      const sections = [...prev.sections];
      sections[idx] = { ...sections[idx], ...patch };
      if (patch.time !== undefined && editingRef.current === null) {
        sections.sort((a, b) => a.time - b.time);
      }
      return { ...prev, sections, annotated_at: new Date().toISOString() };
    }, coalesceKey ? { coalesceKey } : undefined);
  }, [setAnnotation]);

  const deleteSection = useCallback((idx: number) => {
    setAnnotation((prev) => prev
      ? { ...prev, sections: prev.sections.filter((_, i) => i !== idx), annotated_at: new Date().toISOString() }
      : prev
    );
  }, [setAnnotation]);

  const addCandidate = useCallback((idx: number, time: number) => {
    setAnnotation((prev) => {
      if (!prev) return prev;
      const sections = [...prev.sections]; const s = sections[idx];
      const existing = [s.time, ...(s.candidates ?? [])];
      if (existing.some((t) => Math.abs(t - time) < 0.05)) return prev;
      sections[idx] = { ...s, candidates: [...(s.candidates ?? []), Math.round(time * 1000) / 1000].sort((a, b) => a - b) };
      return { ...prev, sections, annotated_at: new Date().toISOString() };
    });
  }, [setAnnotation]);

  const removeCandidate = useCallback((idx: number, ci: number) => {
    setAnnotation((prev) => {
      if (!prev) return prev;
      const sections = [...prev.sections]; const s = sections[idx];
      const candidates = (s.candidates ?? []).filter((_, j) => j !== ci);
      sections[idx] = { ...s, candidates: candidates.length ? candidates : undefined };
      return { ...prev, sections, annotated_at: new Date().toISOString() };
    });
  }, [setAnnotation]);

  const splitSection = useCallback((idx: number) => {
    setAnnotation((prev) => {
      if (!prev) return prev;
      const sections = [...prev.sections]; const s = sections[idx];
      const end = idx + 1 < sections.length ? sections[idx + 1].time : duration;
      const mid = Math.round(currentTime * 1000) / 1000;
      if (mid <= s.time || mid >= end) return prev;
      sections.splice(idx, 1, { time: s.time, type: s.type, label: `${s.label} A` }, { time: mid, type: s.type, label: `${s.label} B` });
      return { ...prev, sections, annotated_at: new Date().toISOString() };
    });
  }, [currentTime, duration, setAnnotation]);

  const addSectionAfter = useCallback((idx: number) => {
    setAnnotation((prev) => {
      if (!prev) return prev;
      const sections = [...prev.sections];
      const current = sections[idx]; if (!current) return prev;
      const nextStart = idx + 1 < sections.length ? sections[idx + 1].time : duration;
      const insertionTime = Math.min(Math.max(currentTime, current.time), Math.max(current.time, nextStart));
      sections.splice(idx + 1, 0, { time: Math.round(insertionTime * 1000) / 1000, type: 'drop', label: autoLabel(sections, 'drop') });
      return { ...prev, sections, annotated_at: new Date().toISOString() };
    });
  }, [currentTime, duration, setAnnotation]);

  const addSectionAtEnd = useCallback(() => {
    setAnnotation((prev) => {
      if (!prev) return prev;
      const start = computeSectionEnd(prev.sections, prev.sections.length - 1, duration);
      return { ...prev, sections: [...prev.sections, { time: start, type: 'drop', label: autoLabel(prev.sections, 'drop') }], annotated_at: new Date().toISOString() };
    });
  }, [duration, setAnnotation]);

  // ── Derived data ──────────────────────────────────────────────────────────
  const sectionEnd = useCallback((i: number) =>
    annotation ? computeSectionEnd(annotation.sections, i, duration) : duration,
  [annotation, duration]);

  // ── Page-level controller wiring ──────────────────────────────────────────
  const stageFromEyeStatus = (es: EyeStatus | undefined): AnnotationStage =>
    es === 'done' ? 'reviewed' : es === 'wip' ? 'ready_for_review' : 'in_progress';
  const eyeStatusFromStage = (stage: AnnotationStage): EyeStatus =>
    stage === 'reviewed' ? 'done' : stage === 'ready_for_review' ? 'wip' : 'none';

  const setAnnotationStatus = useCallback((stage: AnnotationStage) => {
    setAnnotation(
      (prev) => prev
        ? { ...prev, eye_status: eyeStatusFromStage(stage), annotated_at: new Date().toISOString() }
        : prev,
      { skipHistory: true },
    );
  }, [setAnnotation]);

  const sectionAtPlayhead = (() => {
    if (!annotation) return -1;
    for (let i = 0; i < annotation.sections.length; i++) {
      const s = annotation.sections[i];
      const next = i + 1 < annotation.sections.length ? annotation.sections[i + 1].time : duration;
      if (currentTime >= s.time && currentTime < next) return i;
    }
    return -1;
  })();
  const canSplitAtPlayhead = sectionAtPlayhead >= 0 && annotation !== null;
  const splitAtPlayhead = useCallback(() => {
    if (sectionAtPlayhead >= 0) splitSection(sectionAtPlayhead);
  }, [sectionAtPlayhead, splitSection]);

  const deleteAllForSong = useCallback(async () => {
    if (!annotation) return;
    setSaveStatus('saving');
    const ok = await deleteEyeAnnotation(songId);
    if (ok) {
      undoCtl.reset(null);
      lastSavedRef.current = '';
      prevSectionsRef.current = undefined;
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } else {
      setSaveStatus('error');
    }
  }, [annotation, songId, undoCtl]);

  // Single-point delete for the keyboard shortcut: nearest point to playhead
  // within 5 s — mirrors the Manual delete-nearest behavior so Eye feels symmetric.
  const deleteNearestPoint = useCallback(() => {
    if (!annotation || annotation.sections.length === 0) return;
    let bestIdx = 0;
    let bestDist = Math.abs(annotation.sections[0].time - currentTime);
    for (let i = 1; i < annotation.sections.length; i++) {
      const d = Math.abs(annotation.sections[i].time - currentTime);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestDist > 5) return;
    deleteSection(bestIdx);
  }, [annotation, currentTime, deleteSection]);

  useImperativeHandle<AnnotationPanelController, AnnotationPanelController>(controllerRef, () => ({
    setStatus: setAnnotationStatus,
    undo: () => undoCtl.undo(),
    redo: () => undoCtl.redo(),
    split: splitAtPlayhead,
    addAtPlayhead: () => createPoint(currentTime),
    confirmPending: () => confirmAnnotation(),
    importJson: importJsonFile,
    importAudacity: importAudacityFile,
    importCsv: importCsvFile,
    importJams: importJamsFile,
    importLab: importLabFile,
    deleteAll: deleteAllForSong,
    deleteFocused: deleteNearestPoint,
  }), [
    setAnnotationStatus, undoCtl, splitAtPlayhead, createPoint, currentTime, confirmAnnotation,
    importJsonFile, importAudacityFile, importCsvFile, importJamsFile, importLabFile, deleteAllForSong,
    deleteNearestPoint,
  ]);

  useEffect(() => {
    if (!onCapabilitiesChange) return;
    onCapabilitiesChange({
      status: stageFromEyeStatus(annotation?.eye_status),
      hasItems: (annotation?.sections.length ?? 0) > 0,
      saveStatus,
      canUndo: undoCtl.canUndo,
      canRedo: undoCtl.canRedo,
      canSplit: canSplitAtPlayhead,
      splitVisible: true,
      splitDisabledReason: canSplitAtPlayhead ? undefined : 'Move the playhead inside a section to enable Split',
      splitLabel: `Split at ${fmtTime(currentTime)}`,
      canAddAtPlayhead: true,
      addLabel: `+ Add @ ${fmtTime(currentTime)}`,
      pending: pendingSelection,
      pendingRequiresRegion: false,
      importFormats: ['json', 'audacity', 'csv', 'jams', 'lab'],
      canExport: annotation !== null,
      canDeleteAll: annotation !== null,
    });
  }, [
    onCapabilitiesChange, annotation, saveStatus,
    undoCtl.canUndo, undoCtl.canRedo,
    canSplitAtPlayhead, currentTime, pendingSelection,
  ]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (!isLoaded) return <div className="text-xs text-gray-600 animate-pulse py-2">Loading eye annotation…</div>;

  return (
    <div className="space-y-5">
      {/* Toolbar (status pill / undo / files / split / delete) + pending pill +
          "+ Add" are rendered by InspectorPageV2 above this panel via the
          shared AnnotationToolbar / AnnotationAddPanel. */}

      {/* ── Section list ──────────────────────────────────────────────────── */}
      {annotation && annotation.sections.length > 0 && (
        <div className="flex flex-wrap items-start gap-1 max-h-[480px] overflow-y-auto pb-1">
            {annotation.sections.map((s, i) => {
              const end = sectionEnd(i);
              const isLast = i === annotation.sections.length - 1;
              const isCurrentSection = currentTime >= s.time && currentTime < end;
              return (
                <SectionCard
                  key={i}
                  index={i}
                  section={s}
                  endTime={end}
                  isLast={isLast}
                  highlightCurrent={isCurrentSection}
                  activeBpm={activeBpm}
                  onSnapStart={() => updateSection(i, 'time', currentTime)}
                  onSnapEnd={() => { if (!isLast) updateSection(i + 1, 'time', currentTime); }}
                  onSplit={() => splitSection(i)}
                  onTypeChange={(t) => updateSection(i, 'type', t)}
                  onToggleImportance={() => updateSection(i, 'importance', s.importance === 'optional' ? 'critical' : 'optional')}
                  onAddCandidate={() => addCandidate(i, currentTime)}
                  onRemoveCandidate={(ci) => removeCandidate(i, ci)}
                  onDelete={() => deleteSection(i)}
                  onInsertAfter={() => addSectionAfter(i)}
                />
              );
            })}
            <AddSectionAtEndCard onClick={addSectionAtEnd} />
        </div>
      )}

      {!annotation && (
        <p className="text-[11px] text-slate-500">Click or drag on the visualization above to select a time or region, then open the <strong className="text-slate-300 font-medium">Annotate</strong> sidebar on the right and click <strong className="text-cyan-300 font-medium">+ Add</strong> to create a boundary.</p>
      )}

      {annotation && (
        <p className="text-[10px] text-slate-700 font-mono">Last edited: {new Date(annotation.annotated_at).toLocaleString()}</p>
      )}

      {/* ── Section edit popover ──────────────────────────────────────────── */}
      {editingIdx !== null && annotation && annotation.sections[editingIdx] && (() => {
        const idx = editingIdx;
        const s = annotation.sections[idx];
        const endTime = computeSectionEnd(annotation.sections, idx, duration);
        const sectionIsPlaying = !!onSeekAndPlay && playerIsPlaying
          && currentTime >= s.time && currentTime < s.time + 0.5;
        return (
          <BoundaryEditPopover
            index={idx}
            section={s}
            endTime={endTime}
            popoverRef={popoverRef}
            positionStyle={positionStyle}
            onChange={(patch) => patchSection(idx, patch)}
            onDelete={() => { deleteSection(idx); closeEdit(); }}
            onClose={closeEdit}
            onPlay={onSeekAndPlay ? () => onSeekAndPlay(s.time, s.time + 0.5) : undefined}
            onStop={onPause}
            isPlaying={sectionIsPlaying}
            bpm={songInfo?.bpm}
            gridOffset={activeBeatOffset}
            beatsPerBar={activeBeatsPerBar}
            anchors={effectiveAnchors(songInfo)}
            currentTime={currentTime}
          />
        );
      })()}

    </div>
  );
}

export const EyeEditorPanel = forwardRef<AnnotationPanelController, EyeEditorPanelProps>(EyeEditorPanelInner);
EyeEditorPanel.displayName = 'EyeEditorPanel';
