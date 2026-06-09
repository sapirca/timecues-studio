/**
 * ManualEditorPanel — manual manual annotation editor, visualization-free.
 *
 * The shared visualization in SharedVizPanel handles display; this panel
 * handles only the section list, status, and save logic. BPM / time-signature
 * / grid-offset live on SongInfo (set in SongInfoBar before annotating).
 */

import { useState, useEffect, useRef, useCallback, useImperativeHandle, forwardRef, type RefObject, type ForwardedRef } from 'react';
import type { ManualAnnotation, ManualSection } from '../../types/manualAnnotation';
import { useSettings } from '../../context/SettingsContext';
import { loadAnnotation, saveToServer, deleteAnnotation } from '../../services/manualAnnotations';
import type { AnnotationStage } from '../../types/annotationLayer';
import type { AnnotationPanelController, AnnotationPanelCapabilities } from './shared/AnnotationPanelController';
import { emptyCapabilities } from './shared/AnnotationPanelController';
import { useSectionEditPopover } from './useSectionEditPopover';
import { useUndoableState } from '../../hooks/useUndoableState';
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
  sectionColor,
  sectionEnd,
  sectionLabel,
  fmtTime,
  getSectionTypes,
  normalizeSectionType,
} from './sectionConstants';
import { SectionCard, AddSectionAtEndCard } from './SectionCard';
import { BoundaryEditPopover } from './BoundaryEditPopover';
import {
  FillDefaultsModal,
  PRESETS as MANUAL_BOUNDARY_PRESETS,
  parseCustomLayout,
  layoutToSections,
  type BarEntry,
} from './FillDefaultsModal';
import type { PendingSelection } from './AnnotationOverlays';

// ─── Constants ────────────────────────────────────────────────────────────────

const RECOMMENDED_SECTION_SEQUENCE: Array<{ type: string; label: string }> = [
  { type: 'intro', label: 'Intro' }, { type: 'breakdown', label: 'Breakdown' },
  { type: 'buildup', label: 'Buildup' }, { type: 'drop', label: 'Drop' },
  { type: 'breakdown', label: 'Breakdown' }, { type: 'buildup', label: 'Buildup' },
  { type: 'drop', label: 'Drop' }, { type: 'outro', label: 'Outro' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripEndTimes(ann: ManualAnnotation): ManualAnnotation {
  return { ...ann, sections: ann.sections.map(({ time, type, label, importance }) => ({ time, type, label, ...(importance === 'optional' ? { importance } : {}) })) };
}

function normalizeSectionLabel(label: string | undefined): string {
  return label ?? '';
}

function normalizeSection(section: ManualSection, sectionTypes: readonly string[]): ManualSection {
  const type = normalizeSectionType(section.type, sectionTypes);
  const normalizedLabel = normalizeSectionLabel(section.label);
  const original = (section.label ?? '').trim();
  const isAutoLike = original === '' || sectionTypes.some((t) => sectionLabel(t).toLowerCase() === original.toLowerCase());
  return { ...section, type, label: isAutoLike ? sectionLabel(type) : normalizedLabel };
}

function normalizeSections(sections: ManualSection[], sectionTypes: readonly string[]): ManualSection[] {
  return sections.map((section) => normalizeSection(section, sectionTypes));
}

function normalizeAnnotation(ann: ManualAnnotation, sectionTypes: readonly string[]): ManualAnnotation {
  // A stored annotation that only carries timing (e.g. `{ song, time_spent_seconds }`
  // — time recorded but zero boundaries added) legitimately omits `sections`.
  // Default to an empty array so every in-memory annotation has a real list and
  // downstream `.sections.*` reads can't throw.
  return { ...ann, sections: normalizeSections(ann.sections ?? [], sectionTypes) };
}

function buildSequenceSections(sequence: Array<{ type: string; label: string }>, duration: number): ManualSection[] {
  const n = sequence.length;
  const step = duration > 0 ? duration / n : 30;
  return sequence.map((s, i) => ({ time: i * step, type: s.type, label: s.label }));
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface ManualEditorPanelProps {
  songId: string;
  currentTime: number;
  duration: number;
  /** Required to start annotating. The panel disables the Start button if BPM is missing. */
  songBpm?: number;
  /** Beats-per-bar from the song's time signature (default 4). Drives the Length editor. */
  songBeatsPerBar?: number;
  /** Time (s) of bar 1 / beat 1 — needed for the bar.beat input. Default 0. */
  songGridOffset?: number;
  suggestedSections?: ManualSection[];
  onStatusChange?: (slug: string, status: { reviewed: boolean; ready_for_review?: boolean } | null) => void;
  onAnnotationChange?: (ann: ManualAnnotation | null) => void;
  onSeekAndPlay?: (time: number, stopTime?: number) => void;
  onPause?: () => void;
  isPlaying?: boolean;
  setSectionsRef?: RefObject<((sections: ManualSection[]) => void) | null>;
  /** Imperative handle: parent calls this to open/close the section edit popover. Optional anchor positions the popover near a click point. */
  openEditorRef?: RefObject<((idx: number | null, anchor?: { x: number; y: number }) => void) | null>;
  /** Pending viz click/drag selection lifted from InspectorPageV2 — confirmed
   *  via the shared AnnotationAddPanel at page level; the panel itself no
   *  longer renders its own pending pill. */
  pendingSelection?: PendingSelection | null;
  onClearPendingSelection?: () => void;
  /** Bumping this forces a reload from the server (used after a top-level IMPORT). */
  reloadKey?: number;
  /** Page-level subscription that fires whenever the toolbar-visible state
   *  changes (status, save indicator, undo flag, etc.). The page mirrors it
   *  into `manualCaps` and feeds it to the shared AnnotationToolbar. */
  onCapabilitiesChange?: (caps: AnnotationPanelCapabilities) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

function ManualEditorPanelInner(
  {
    songId, currentTime, duration,
    songBpm, songBeatsPerBar = 4, songGridOffset = 0, suggestedSections,
    onStatusChange, onAnnotationChange,
    onSeekAndPlay, onPause, isPlaying,
    setSectionsRef,
    openEditorRef,
    pendingSelection,
    onClearPendingSelection,
    reloadKey = 0,
    onCapabilitiesChange,
  }: ManualEditorPanelProps,
  controllerRef: ForwardedRef<AnnotationPanelController>,
) {
  const { settings } = useSettings();
  const sectionTypes = getSectionTypes(settings.sectionTypeVocabulary);
  const defaultLayoutName = settings.manualBoundariesDefault === 'custom'
    ? 'Custom — type:bars list'
    : MANUAL_BOUNDARY_PRESETS[settings.manualBoundariesDefault].name;
  const [annotation, setAnnotation, undoCtl] = useUndoableState<ManualAnnotation | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [isLoaded, setIsLoaded] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showDefaultsModal, setShowDefaultsModal] = useState(false);
  const sortOnClose = useCallback(() => {
    setAnnotation((prev) => prev
      ? { ...prev, sections: [...prev.sections].sort((a, b) => a.time - b.time), annotated_at: new Date().toISOString() }
      : prev
    , { skipHistory: true });
  }, [setAnnotation]);
  const { editingIdx, popoverRef, positionStyle, close: closeEdit } =
    useSectionEditPopover({ openEditorRef, onClose: sortOnClose });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>('');
  // Snapshot of the latest unsaved annotation, used for synchronous flush
  // on unmount or songId change (e.g. tab switch within the 1s debounce).
  const latestAnnRef = useRef<{ songId: string; ann: ManualAnnotation } | null>(null);
  // Which songId the in-state `annotation` actually belongs to — gates the
  // auto-save effect during the post-songId-change re-render window.
  const loadedForSongIdRef = useRef<string | null>(null);
  // Tracks the previous `sections` reference. A new array reference means the
  // user actually edited content (vs. flipping the status dropdown), so we can
  // auto-bump the review stage. Reset on song change.
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

  useEffect(() => {
    setIsLoaded(false); undoCtl.reset(null); setSaveStatus('idle'); lastSavedRef.current = '';
    latestAnnRef.current = null;
    prevSectionsRef.current = undefined;
    loadAnnotation(songId).then((existing) => {
      if (existing) { const normalized = normalizeAnnotation(existing, sectionTypes); undoCtl.reset(normalized); lastSavedRef.current = JSON.stringify(existing); prevSectionsRef.current = normalized.sections; }
      loadedForSongIdRef.current = songId;
      setIsLoaded(true);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songId, reloadKey]);

  // Auto-bump status from "Not started" → "In review" on the first content edit.
  // Detects edits via reference equality on `sections` — status-only changes
  // (dropdown) keep the same array reference and so don't trigger a bump.
  useEffect(() => {
    if (!annotation || !isLoaded) return;
    if (loadedForSongIdRef.current !== songId) return;
    if (prevSectionsRef.current === annotation.sections) return;
    prevSectionsRef.current = annotation.sections;
    if (annotation.reviewed || annotation.ready_for_review) return;
    setAnnotation((prev) => prev ? { ...prev, ready_for_review: true } : prev, { skipHistory: true });
  }, [annotation, isLoaded, songId, setAnnotation]);

  useEffect(() => {
    if (!annotation || !isLoaded) return;
    // Guard: during a songId change, this effect briefly re-runs with the
    // stale annotation but the new songId. Skip until load has settled.
    if (loadedForSongIdRef.current !== songId) return;
    const serialized = JSON.stringify(annotation);
    latestAnnRef.current = { songId, ann: annotation };
    if (serialized === lastSavedRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSaveStatus('saving');
    debounceRef.current = setTimeout(async () => {
      const ok = await saveToServer(songId, stripEndTimes(annotation));
      if (ok) {
        lastSavedRef.current = serialized; setSaveStatus('saved');
        onStatusChange?.(songId, { reviewed: annotation.reviewed, ready_for_review: annotation.ready_for_review });
        setTimeout(() => setSaveStatus((s) => (s === 'saved' ? 'idle' : s)), 2000);
      } else { setSaveStatus('error'); }
    }, 1000);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [annotation, isLoaded, songId, onStatusChange]);

  // Flush pending save synchronously on unmount or songId change. Without
  // this, switching tabs (panel unmount) within the 1s debounce window
  // silently drops the pending save. saveToServer uses `keepalive: true`,
  // so the request survives even if the page is closing. Mirror the
  // autosave's serialize-full / send-stripped pattern so the comparison
  // against lastSavedRef matches.
  useEffect(() => {
    return () => {
      const latest = latestAnnRef.current;
      if (!latest) return;
      const s = JSON.stringify(latest.ann);
      if (s === lastSavedRef.current) return;
      void saveToServer(latest.songId, stripEndTimes(latest.ann));
      lastSavedRef.current = s;
    };
  }, [songId]);

  useEffect(() => {
    if (setSectionsRef) setSectionsRef.current = annotation
      ? (sections: ManualSection[]) => setAnnotation(
          (prev) => prev ? { ...prev, sections, annotated_at: new Date().toISOString() } : prev,
          { coalesceKey: 'external-sections' },
        )
      : null;
    return () => { if (setSectionsRef) setSectionsRef.current = null; };
  }, [annotation, setSectionsRef, setAnnotation]);

  const startAnnotatingWithSections = useCallback((sections: ManualSection[]) => {
    setAnnotation((prev) => prev
      ? { ...prev, sections, annotated_at: new Date().toISOString() }
      : { song: songId, annotated_at: new Date().toISOString(), reviewed: false, sections }
    );
  }, [songId, setAnnotation]);

  const startAnnotatingAtCursor = useCallback(() => {
    const t = Math.round(currentTime * 1000) / 1000;
    setAnnotation({
      song: songId,
      annotated_at: new Date().toISOString(),
      reviewed: false,
      sections: [{ time: t, type: 'drop', label: 'Drop' }],
    });
  }, [songId, currentTime, setAnnotation]);

  // Build the section list the user's saved default would produce. Used by
  // both the "Fill in defaults" quick-apply button (which skips the modal)
  // and by `applyDefaultStructure` below.
  const computeDefaultSections = useCallback((): ManualSection[] => {
    if (suggestedSections?.length) {
      return normalizeSections(
        suggestedSections.map(({ time, type, label }) => ({ time, type, label })),
        sectionTypes,
      );
    }
    // Resolve the user's saved default. With BPM we can lay it out by bars
    // (PRESETS / custom); without BPM we fall back to the legacy equal-time
    // split so the button still works on songs that have no grid yet.
    let layout: readonly BarEntry[] = [];
    if (settings.manualBoundariesDefault === 'custom') {
      layout = parseCustomLayout(settings.manualBoundariesCustomLayout).layout;
    } else {
      layout = MANUAL_BOUNDARY_PRESETS[settings.manualBoundariesDefault].layout;
    }
    return songBpm && songBpm > 0 && layout.length > 0
      ? layoutToSections(layout, songBpm, songBeatsPerBar, duration)
      : buildSequenceSections(
          layout.length > 0
            ? layout.map((e) => ({ type: e.type, label: sectionLabel(e.type) }))
            : RECOMMENDED_SECTION_SEQUENCE,
          duration,
        );
  }, [suggestedSections, sectionTypes, settings.manualBoundariesDefault, settings.manualBoundariesCustomLayout, songBpm, songBeatsPerBar, duration]);

  const applyDefaultStructure = useCallback(() => {
    const sections = computeDefaultSections();
    setAnnotation((prev) => prev ? { ...prev, sections, annotated_at: new Date().toISOString() } : prev);
  }, [computeDefaultSections, setAnnotation]);

  // Quick-apply variant for the empty-state (no annotation yet): builds the
  // sections from the user's saved default and bootstraps a new annotation.
  const startAnnotatingWithDefaults = useCallback(() => {
    startAnnotatingWithSections(computeDefaultSections());
  }, [computeDefaultSections, startAnnotatingWithSections]);

  const addSection = useCallback(() => {
    setAnnotation((prev) => {
      if (!prev) return prev;
      const sections = [...prev.sections, { time: currentTime, type: 'drop', label: 'Drop' }].sort((a, b) => a.time - b.time);
      return { ...prev, sections, annotated_at: new Date().toISOString() };
    });
  }, [currentTime, setAnnotation]);

  const addSectionAtEnd = useCallback(() => {
    setAnnotation((prev) => {
      if (!prev) return prev;
      const start = sectionEnd(prev.sections, prev.sections.length - 1, duration);
      return { ...prev, sections: [...prev.sections, { time: start, type: 'drop', label: 'Drop' }], annotated_at: new Date().toISOString() };
    });
  }, [duration, setAnnotation]);

  const addSectionAfter = useCallback((idx: number) => {
    setAnnotation((prev) => {
      if (!prev) return prev;
      const sections = [...prev.sections];
      const current = sections[idx]; if (!current) return prev;
      const nextStart = idx + 1 < sections.length ? sections[idx + 1].time : duration;
      const insertionTime = Math.min(Math.max(currentTime, current.time), Math.max(current.time, nextStart));
      sections.splice(idx + 1, 0, { time: Math.round(insertionTime * 1000) / 1000, type: 'drop', label: 'Drop' });
      return { ...prev, sections, annotated_at: new Date().toISOString() };
    });
  }, [currentTime, duration, setAnnotation]);

  // Insert boundaries from a pending pill:
  //  - Click-only (t2 == null): one 'drop' boundary at t1; the new section
  //    inherits its end from whatever boundary comes next.
  //  - Range (t2 != null): two boundaries — 'drop' at t1 (the labeled section
  //    the user just highlighted) and 'unset' at t2 (a placeholder end-cap so
  //    the new section actually stops at t2 instead of swallowing whatever
  //    follows). The user can re-type the unset boundary later.
  const insertFromPendingSelection = useCallback((sel: PendingSelection) => {
    const t1 = Math.round(sel.t1 * 1000) / 1000;
    const t2 = sel.t2 != null ? Math.round(sel.t2 * 1000) / 1000 : null;
    const eps = 0.05;
    const head = { time: t1, type: 'drop', label: 'Drop' };
    const tail = t2 != null && Math.abs(t2 - t1) >= eps
      ? { time: t2, type: UNSET_TYPE, label: sectionLabel(UNSET_TYPE) }
      : null;
    setAnnotation((prev) => {
      const now = new Date().toISOString();
      const existing = prev?.sections ?? [];
      const additions: typeof existing = [];
      const novel = (time: number) =>
        !existing.some((s) => Math.abs(s.time - time) < eps)
        && !additions.some((s) => Math.abs(s.time - time) < eps);
      if (novel(head.time)) additions.push(head);
      if (tail && novel(tail.time)) additions.push(tail);
      if (additions.length === 0) return prev;
      if (!prev) {
        return {
          song: songId,
          annotated_at: now,
          reviewed: false,
          sections: additions.sort((a, b) => a.time - b.time),
        };
      }
      const sections = [...existing, ...additions].sort((a, b) => a.time - b.time);
      return { ...prev, sections, annotated_at: now };
    });
  }, [songId, setAnnotation]);

  const confirmPendingSelection = useCallback(() => {
    if (!pendingSelection) return;
    insertFromPendingSelection(pendingSelection);
    onClearPendingSelection?.();
  }, [pendingSelection, insertFromPendingSelection, onClearPendingSelection]);

  // Skip sort while the edit modal is open so the index stays stable
  // while the user is editing time. closeEdit re-sorts on dismiss.
  const editingRef = useRef(editingIdx);
  editingRef.current = editingIdx;

  const updateSection = useCallback((idx: number, field: 'time' | 'endTime' | 'type' | 'label' | 'importance' | 'description', value: string | number) => {
    // Coalesce streaming inputs (typing in label/description/time/endTime
    // fields) so the whole edit collapses into one undo. Discrete actions
    // (type/importance) remain individual history entries.
    const coalesceKey =
      field === 'label'       ? `label-${idx}` :
      field === 'description' ? `desc-${idx}` :
      field === 'time'        ? `time-${idx}`  :
      field === 'endTime'     ? `endTime-${idx}` :
      undefined;
    setAnnotation((prev) => {
      if (!prev) return prev;
      const sections = [...prev.sections];
      if (field === 'endTime') {
        if (idx + 1 < sections.length && typeof value === 'number') {
          sections[idx + 1] = { ...sections[idx + 1], time: value };
          if (editingRef.current === null) sections.sort((a, b) => a.time - b.time);
        }
      } else if (field === 'type' && typeof value === 'string') {
        const type = normalizeSectionType(value, sectionTypes);
        const cur = sections[idx].label ?? '';
        const shouldSync = cur.trim() === '' || sectionTypes.some((t) => sectionLabel(t).toLowerCase() === cur.toLowerCase());
        sections[idx] = { ...sections[idx], type, label: shouldSync ? sectionLabel(type) : normalizeSectionLabel(cur) };
      } else if (field === 'label' && typeof value === 'string') {
        sections[idx] = { ...sections[idx], label: normalizeSectionLabel(value) };
      } else {
        sections[idx] = { ...sections[idx], [field]: value };
        if (field === 'time' && editingRef.current === null) sections.sort((a, b) => a.time - b.time);
      }
      return { ...prev, sections, annotated_at: new Date().toISOString() };
    }, coalesceKey ? { coalesceKey } : undefined);
  }, [setAnnotation]);

  const deleteSection = useCallback((idx: number) => {
    setAnnotation((prev) => prev ? { ...prev, sections: prev.sections.filter((_, i) => i !== idx), annotated_at: new Date().toISOString() } : prev);
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

  const setAnnotationStatus = useCallback(async (stage: AnnotationStage) => {
    if (!annotation) return;
    const updated: ManualAnnotation = { ...annotation, reviewed: stage === 'reviewed', ready_for_review: stage === 'ready_for_review', annotated_at: new Date().toISOString() };
    // Status is review metadata, not an annotation edit — keep it out of undo history.
    setAnnotation(updated, { skipHistory: true }); setSaveStatus('saving');
    const ok = await saveToServer(songId, stripEndTimes(updated));
    lastSavedRef.current = JSON.stringify(updated);
    setSaveStatus(ok ? 'saved' : 'error');
    onStatusChange?.(songId, { reviewed: updated.reviewed, ready_for_review: updated.ready_for_review });
    setTimeout(() => setSaveStatus((s) => (s === 'saved' ? 'idle' : s)), 2000);
  }, [annotation, songId, onStatusChange, setAnnotation]);

  const importFromSections = useCallback((sections: ManualSection[]) => {
    setAnnotation((prev) => {
      const now = new Date().toISOString();
      if (prev) return { ...prev, sections, annotated_at: now };
      return { song: songId, annotated_at: now, reviewed: false, sections };
    });
  }, [songId, setAnnotation]);

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
      // Replace the whole annotation; preserve any unknown metadata fields,
      // but force song = current slug so we save under the right file.
      setAnnotation(normalizeAnnotation({ ...(rest as Partial<ManualAnnotation>), sections, song: songId } as ManualAnnotation, sectionTypes));
    });
  }, [readTextFile, songId, setAnnotation, sectionTypes]);

  const importAudacityFile = useCallback((file: File) => {
    readTextFile(file, (text) => importFromSections(parseAudacity(text)));
  }, [readTextFile, importFromSections]);

  const importCsvFile = useCallback((file: File) => {
    readTextFile(file, (text) => {
      // Auto-route between REAPER and Sonic Visualiser. REAPER's header
      // (or row prefix) is unmistakable; everything else falls back to
      // the existing Sonic Visualiser parser.
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

  const deleteAllForSong = useCallback(async () => {
    if (!annotation) return;
    setSaveStatus('saving');
    const ok = await deleteAnnotation(songId);
    if (ok) {
      undoCtl.reset(null);
      lastSavedRef.current = '';
      latestAnnRef.current = null;
      prevSectionsRef.current = undefined;
      setSaveStatus('saved');
      onStatusChange?.(songId, null);
      setTimeout(() => setSaveStatus((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } else {
      setSaveStatus('error');
    }
  }, [annotation, songId, undoCtl, onStatusChange]);

  // ── Page-level controller wiring ──────────────────────────────────────────
  // Split-at-playhead resolves to whichever section currently contains the
  // playhead; the toolbar shows it disabled when there is none.
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

  useImperativeHandle<AnnotationPanelController, AnnotationPanelController>(controllerRef, () => ({
    setStatus: (stage) => void setAnnotationStatus(stage),
    undo: () => undoCtl.undo(),
    redo: () => undoCtl.redo(),
    split: splitAtPlayhead,
    addAtPlayhead: () => { if (annotation) addSection(); else startAnnotatingAtCursor(); },
    confirmPending: () => confirmPendingSelection(),
    fillDefaults: () => { if (annotation) applyDefaultStructure(); else startAnnotatingWithDefaults(); },
    chooseStructure: () => setShowDefaultsModal(true),
    importJson: importJsonFile,
    importAudacity: importAudacityFile,
    importCsv: importCsvFile,
    importJams: importJamsFile,
    importLab: importLabFile,
    deleteAll: deleteAllForSong,
  }), [
    setAnnotationStatus, undoCtl, splitAtPlayhead, addSection, startAnnotatingAtCursor, annotation, confirmPendingSelection,
    applyDefaultStructure, startAnnotatingWithDefaults,
    importJsonFile, importAudacityFile, importCsvFile, importJamsFile, importLabFile, deleteAllForSong,
  ]);

  // Emit a capabilities snapshot whenever toolbar-visible state changes.
  useEffect(() => {
    if (!onCapabilitiesChange) return;
    const status: AnnotationStage = annotation?.reviewed
      ? 'reviewed'
      : annotation?.ready_for_review ? 'ready_for_review' : 'in_progress';
    const splitLabel = `Split at ${fmtTime(currentTime)}`;
    const bpmReady = !!songBpm && songBpm > 0;
    const suggestedCount = suggestedSections?.length ?? 0;
    onCapabilitiesChange({
      ...emptyCapabilities(),
      status,
      hasItems: (annotation?.sections.length ?? 0) > 0,
      saveStatus,
      canUndo: undoCtl.canUndo,
      canRedo: undoCtl.canRedo,
      canSplit: canSplitAtPlayhead,
      splitVisible: true,
      splitDisabledReason: canSplitAtPlayhead ? undefined : 'Move the playhead inside a section to enable Split',
      splitLabel,
      canAddAtPlayhead: bpmReady,
      addLabel: `+ Add @ ${fmtTime(currentTime)}`,
      canFillDefaults: bpmReady,
      fillDefaultsLabel: suggestedCount ? `⚡ Fill (${suggestedCount})` : '⚡ Fill defaults',
      fillDefaultsTooltip: bpmReady
        ? `Pre-fill using your saved default (${defaultLayoutName})`
        : 'Set the BPM in the Song Info panel to enable Fill defaults',
      pending: pendingSelection ?? null,
      pendingRequiresRegion: false,
      importFormats: ['json', 'audacity', 'csv', 'jams', 'lab'],
      canExport: annotation !== null,
      canDeleteAll: annotation !== null,
    });
  }, [
    onCapabilitiesChange, annotation, saveStatus,
    undoCtl.canUndo, undoCtl.canRedo,
    canSplitAtPlayhead, currentTime, pendingSelection,
    songBpm, suggestedSections, defaultLayoutName,
  ]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (!isLoaded) return <div className="text-[11px] text-slate-600 animate-pulse py-2 font-mono">Loading annotation…</div>;

  if (!annotation) {
    const bpmReady = !!songBpm && songBpm > 0;
    return (
      <div className="space-y-5">
        <div className="space-y-2">
          <SectionsHeader onShowInfo={() => setShowInfo(true)} />
          <SectionsEmptyMessage bpmReady={bpmReady} />
        </div>
        <FillDefaultsModal
          open={showDefaultsModal}
          onOpenChange={setShowDefaultsModal}
          bpm={songBpm ?? 0}
          beatsPerBar={songBeatsPerBar}
          duration={duration}
          onApply={startAnnotatingWithSections}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Toolbar (status pill / undo / files / split / delete) + pending pill +
          "+ Add" are rendered by InspectorPageV2 above this panel via the
          shared AnnotationToolbar / AnnotationAddPanel — fed by the
          controller exposed via forwardRef and the capability snapshot above. */}

      {/* Sections */}
      <div className="space-y-2">
        <SectionsHeader onShowInfo={() => setShowInfo(true)} />

        {annotation.sections.length === 0 ? (
          <SectionsEmptyMessage bpmReady={!!songBpm && songBpm > 0} />
        ) : (
          <div className="flex flex-wrap items-start gap-3 max-h-[480px] overflow-y-auto pb-1">
            {annotation.sections.map((s, i) => {
              const endTime = sectionEnd(annotation.sections, i, duration);
              const isLast = i === annotation.sections.length - 1;
              const isSectionPlaying = !!isPlaying && currentTime >= s.time && currentTime < endTime;
              const isCurrentSection = currentTime >= s.time && currentTime < endTime;
              return (
                <SectionCard
                  key={i}
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
            <AddSectionAtEndCard onClick={addSectionAtEnd} />
          </div>
        )}
      </div>

      <p className="text-[10px] text-slate-700 font-mono">Last edited: {new Date(annotation.annotated_at).toLocaleString()}</p>

      {/* ── Section edit popover — shared AnnotationPointCard via BoundaryEditPopover. */}
      {editingIdx !== null && annotation.sections[editingIdx] && (() => {
        const idx = editingIdx;
        const s = annotation.sections[idx];
        const endT = sectionEnd(annotation.sections, idx, duration);
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
              if (patch.time !== undefined)       updateSection(idx, 'time', patch.time);
              if (patch.type !== undefined)       updateSection(idx, 'type', patch.type);
              if (patch.label !== undefined)      updateSection(idx, 'label', patch.label);
              if (patch.description !== undefined) updateSection(idx, 'description', patch.description);
              if (patch.importance !== undefined) updateSection(idx, 'importance', patch.importance);
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
        onApply={startAnnotatingWithSections}
      />
    </div>
  );
}

export const ManualEditorPanel = forwardRef<AnnotationPanelController, ManualEditorPanelProps>(ManualEditorPanelInner);
ManualEditorPanel.displayName = 'ManualEditorPanel';

// ─── Shared empty-state pieces ──────────────────────────────────────────────
// Used by both the bootstrap state (no annotation file yet) and the
// in-annotation empty state (sections.length === 0). The slim header row
// holds just the section label + the vocabulary-info button; setup actions
// (+ Add, ⚡ Fill defaults, ≡ Choose structure) live in the right-edge
// Annotate sidebar so a single toolbar drives every annotation type.

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

function SectionsEmptyMessage({ bpmReady }: { bpmReady: boolean }) {
  return (
    <div className="px-3 py-3 rounded border border-white/[0.06] bg-white/[0.02] text-[11px] text-slate-500 italic">
      {bpmReady ? (
        <>
          No sections yet — open the <span className="text-slate-300 not-italic">Annotate</span> sidebar on the right and click <span className="text-slate-300 not-italic">+ Add</span> to drop a section at the playhead, or <span className="text-slate-300 not-italic">⚡ Fill defaults</span> to pre-fill.
        </>
      ) : (
        <span className="text-amber-400 not-italic font-mono">Set the BPM in the Dataprep tab</span>
      )}
    </div>
  );
}
