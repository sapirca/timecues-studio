/**
 * AutoGuessPanel — "highest-granularity" manual annotation.
 *
 * Aggregates ALL algorithm boundary suggestions into a single clustered set.
 * The reviewer validates each point: mark correct ✓, incorrect ✗, or adjust
 * timing (from the player seek position or from another algorithm's suggestion).
 *
 * The resulting "correct" points form an auto-guess manual annotation that can be
 * used to evaluate every algorithm's boundary detection performance.
 */

import { useState, useEffect, useRef, useCallback, useImperativeHandle, forwardRef, type ForwardedRef, type ReactNode } from 'react';
import type { SectionBlock } from '../types/sectionBlock';
import type { AutoGuessManualAnnotation, AutoGuessPoint, AutoGuessSource, AutoGuessStatus, AutoGuessCentroidMethod } from '../types/autoGuess';
import {
  loadAutoGuessAnnotation,
  saveAutoGuessAnnotation,
} from '../services/autoGuessAnnotations';
import { getCurrentSettings } from '../context/SettingsContext';
import type { SongInfo } from '../types/songInfo';
import type { AnnotationStage } from '../types/annotationLayer';
import { beatsPerBarFromTimeSignature } from '../utils/beatGrid';
import { BarBeatInput } from './inspector-v2/BarBeatInput';
import { ConsensusClusterControls } from './inspector-v2/ConsensusClusterControls';
import type { AnnotationPanelController, AnnotationPanelCapabilities } from './inspector-v2/shared/AnnotationPanelController';
import { emptyCapabilities } from './inspector-v2/shared/AnnotationPanelController';
import { agreementCount, clusterPoints, computeClusterTime } from '../utils/boundaryClustering';
import { sendConsensusConfig, type BoundaryConsensusConfig } from '../state/consensusHandoff';
import { useConsensusHandoff } from '../hooks/useConsensusHandoff';
import { formatClockTime } from '../utils/clockTime';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtTime(sec: number): string {
  return formatClockTime(sec, 2);
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

const CENTROID_METHODS: { id: AutoGuessCentroidMethod; short: string; detail: string }[] = [
  {
    id: 'mean', short: 'Mean',
    detail: 'Arithmetic mean of all raw member times. Classic centroid-linkage — fast and symmetric, but one algorithm firing twice pulls the result.',
  },
  {
    id: 'eqgroup', short: 'EqGrp',
    detail: 'One representative per algorithm (mean of its own members), then average across reps. Prevents a prolific algorithm from dominating just because it places many nearby boundaries.',
  },
  {
    id: 'metamed', short: 'MetaMed',
    detail: 'Computes four internal candidates — median, trimmed-mean, tightest-span midpoint, EqGrp — then picks whichever is closest to their mutual median. Always a real method\'s output, never a synthetic blend.',
  },
  {
    id: 'plural', short: 'Plural',
    detail: 'Scores each of the four internal candidates by how many others fall within 0.5 s. Returns the most-agreed-upon one; ties broken by proximity to the cluster mean.',
  },
  {
    id: 'nearraw', short: 'NearRaw',
    detail: 'Returns the raw algorithm timestamp with the smallest total absolute distance to every other timestamp in the cluster (L1 minimiser). Always an actual algorithm prediction, never interpolated.',
  },
];

// Cluster a flat list of {algorithmId, time} points using centroid-linkage:
//   1. Sort all points by time.
//   2. Walk left-to-right; assign each point to the nearest existing cluster
//      whose running-mean centroid is within toleranceSec, otherwise start new.
//   3. Recompute the running mean after each assignment (keeps clusters tight).
// The final representative time per cluster is then computed by `centroidMethod`.
function clusterBoundaries(
  allPoints: { algorithmId: string; time: number }[],
  toleranceSec: number,
  centroidMethod: AutoGuessCentroidMethod = 'mean',
): AutoGuessPoint[] {
  return clusterPoints(allPoints, toleranceSec).map(({ members }, clusterId) => {
    const sources: AutoGuessSource[] = members.map((m) => ({ algorithmId: m.algorithmId, originalTime: m.time }));
    const meanTime = members.reduce((s, m) => s + m.time, 0) / members.length;
    const centroidTime = computeClusterTime(members, centroidMethod);
    return {
      id: generateId(),
      time: centroidTime,
      originalTime: meanTime, // always the mean — anchor for "reset to mean"
      sources,
      clusterId,
      clusterSize: members.length,
      status: 'pending' as const,
      correctionSource: centroidMethod !== 'mean' ? centroidMethod : undefined,
    };
  });
}

// Cluster badge palette — coloured by how many distinct algorithms agreed
// (see agreementCount), which is what the ×N on the badge counts.
function clusterBadgeStyle(size: number): { bg: string; text: string } {
  if (size >= 4) return { bg: '#10b981', text: '#fff' };  // green — strong agreement
  if (size === 3) return { bg: '#3b82f6', text: '#fff' };  // blue
  if (size === 2) return { bg: '#f59e0b', text: '#000' };  // amber
  return { bg: '#6b7280', text: '#fff' };                  // gray — solo
}

const ALGO_SHORT: Record<string, string> = {
  'msaf-olda':   'OLDA',
  'msaf-cnmf':   'CNMF',
  'msaf-foote':  'Foote',
  'msaf-sf':     'SF',
  'allin1':      'AllIn1',
  'sections':    'Browser',
};
function algoLabel(id: string): string {
  if (id.startsWith('allin1-fold')) return `F${id.slice('allin1-fold'.length)}`;
  if (id.startsWith('custom:')) return id.slice('custom:'.length);
  if (id.startsWith('ruptures-')) return id.slice('ruptures-'.length);
  return ALGO_SHORT[id] ?? id;
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface AlgorithmRow {
  id: string;
  label: string;
  sections: { time: number; endTime: number }[];
}

export interface AutoGuessPanelProps {
  songId: string;
  /** Current playback time — used to set adjusted time from player. */
  currentTime: number;
  /** All loaded algorithm section results. */
  algorithmRows: AlgorithmRow[];
  /**
   * Pre-loaded annotation from the parent (avoids a duplicate fetch).
   * If provided, the panel will skip its own initial load.
   */
  initialAnnotation?: AutoGuessManualAnnotation | null;
  /** Called when the annotation changes so InspectorPage can update evaluation. */
  onAnnotationChange?: (ann: AutoGuessManualAnnotation | null) => void;
  onSeekAndPlay?: (time: number, stopTime?: number) => void;
  /** Manual manual annotation sections to evaluate against. */
  manualSections?: { time: number }[];
  /** Song-level metadata (BPM / time signature / grid offset) for the bar.beat input. */
  songInfo?: SongInfo | null;
  /** Page-level subscription that fires whenever the toolbar-visible state
   *  changes. Fed to the shared AnnotationToolbar above this panel. */
  onCapabilitiesChange?: (caps: AnnotationPanelCapabilities) => void;
  /** Copy the selected auto-guess points into the song's existing manual
   *  annotation as section boundaries. Mirrors DetectorOutputReview's
   *  "Copy to manual layer" — same affordance, different target store
   *  (boundaries live in ManualAnnotation, not the layers doc). */
  onCopyToManualAnnotation?: (sections: SectionBlock[]) => void;
  /** Open Consensus Inspect with these clustering parameters, so they can be
   *  tuned against a live F1 before anything is generated here. The config is
   *  parked for that stage first (see state/consensusHandoff). Omit and the
   *  button doesn't render. */
  onTuneInConsensus?: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

function AutoGuessPanelInner(
  {
    songId,
    currentTime,
    algorithmRows,
    initialAnnotation,
    onAnnotationChange,
    onSeekAndPlay,
    songInfo,
    onCapabilitiesChange,
    onCopyToManualAnnotation,
    onTuneInConsensus,
  }: AutoGuessPanelProps,
  controllerRef: ForwardedRef<AnnotationPanelController>,
) {
  // If the parent already loaded the annotation, start with it (avoids double fetch).
  const [ann, setAnn] = useState<AutoGuessManualAnnotation | null>(initialAnnotation ?? null);
  const [loading, setLoading] = useState(initialAnnotation === undefined);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [clusterTolerance, setClusterTolerance] = useState(() => getCurrentSettings().autoGuessClusterTolerance);
  const [centroidMethod, setCentroidMethod] = useState<AutoGuessCentroidMethod>(
    initialAnnotation?.centroidMethod ?? getCurrentSettings().autoGuessCentroidMethod,
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Two-step confirmation before overwriting an existing annotation
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [filterStatus, setFilterStatus] = useState<'all' | 'pending' | 'correct' | 'incorrect'>('all');
  const hitTolerance = 3;
  // Per-row toggle: when set, the row's algorithm-chip soup is expanded.
  // Rows with > CHIP_COLLAPSE_THRESHOLD chips collapse to a count summary by default.
  const [chipsExpandedIds, setChipsExpandedIds] = useState<Set<string>>(new Set());
  const toggleChips = useCallback((id: string) => {
    setChipsExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // Algorithm selection — which algorithms are included in clustering
  const [selectedAlgorithmIds, setSelectedAlgorithmIds] = useState<Set<string>>(
    () => new Set(algorithmRows.map((r) => r.id)),
  );
  // Min-consensus threshold — only show/evaluate points backed by at least
  // this many distinct algorithms (agreementCount, not raw member count)
  const [minConsensus, setMinConsensus] = useState(() => getCurrentSettings().autoGuessMinConsensus);
  /** Rows the auto-include effect has already offered. Only detectors that
   *  arrive *after* this point join the selection — one the panel has seen
   *  before stays where the user (or a hand-off from Consensus Inspect) left
   *  it, instead of being switched back on by the next row refresh. */
  const offeredAlgorithmIdsRef = useRef<Set<string>>(new Set(algorithmRows.map((r) => r.id)));
  /** The config that arrived from Consensus Inspect, if any. Held so the
   *  annotation-load effect doesn't reset the centroid back out from under it,
   *  and so the notice can say what landed. Cleared on song change, on
   *  Generate, or when dismissed. */
  const handoffRef = useRef<BoundaryConsensusConfig | null>(null);
  const [handoffNotice, setHandoffNotice] = useState<BoundaryConsensusConfig | null>(null);
  const handoffSongIdRef = useRef(songId);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks the previous `points` reference. A new array reference means the
  // user actually edited content (vs. flipping the status dropdown), so we can
  // auto-bump auto_guess_status. Reset on song change.
  const prevPointsRef = useRef<AutoGuessPoint[] | undefined>(undefined);

  // Auto-include newly loaded algorithms in the selection set
  useEffect(() => {
    setSelectedAlgorithmIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      algorithmRows.forEach((r) => {
        if (offeredAlgorithmIdsRef.current.has(r.id)) return;
        offeredAlgorithmIdsRef.current.add(r.id);
        if (!next.has(r.id)) { next.add(r.id); changed = true; }
      });
      return changed ? next : prev;
    });
  }, [algorithmRows]);

  // ── Load on mount / song change ──────────────────────────────────────────
  // Skip if the parent already supplied the annotation via initialAnnotation.
  useEffect(() => {
    // A hand-off belongs to the song it was sent for; a song change drops it.
    if (handoffSongIdRef.current !== songId) {
      handoffSongIdRef.current = songId;
      handoffRef.current = null;
      setHandoffNotice(null);
    }
    // Parameters that arrived from Consensus Inspect outrank the ones recorded
    // on the stored annotation — the user is on their way to re-generating.
    const centroidFor = (stored?: AutoGuessCentroidMethod) =>
      handoffRef.current?.centroid ?? stored ?? 'mean';
    if (initialAnnotation !== undefined) {
      // Parent handed us the data — sync local state in case it differs.
      setAnn(initialAnnotation ?? null);
      setCentroidMethod(centroidFor(initialAnnotation?.centroidMethod));
      prevPointsRef.current = initialAnnotation?.points;
      setLoading(false);
      return;
    }
    let cancelled = false;
    setAnn(null);
    setLoading(true);
    prevPointsRef.current = undefined;
    loadAutoGuessAnnotation(songId).then((loaded) => {
      if (cancelled) return;
      setAnn(loaded);
      setCentroidMethod(centroidFor(loaded?.centroidMethod));
      prevPointsRef.current = loaded?.points;
      onAnnotationChange?.(loaded);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [songId, initialAnnotation]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Incoming hand-off from Consensus Inspect ("Use for Auto-guess") ──────
  // Only the controls move. The stored points keep the parameters they were
  // built with until the reviewer presses Generate, which is the one action
  // that may overwrite reviewed work.
  useConsensusHandoff('autoGuess', (config) => {
    handoffRef.current = config;
    handoffSongIdRef.current = songId;
    setClusterTolerance(config.clusterWindow);
    setMinConsensus(config.minAgreement);
    setCentroidMethod(config.centroid);
    config.algoIds.forEach((id) => offeredAlgorithmIdsRef.current.add(id));
    setSelectedAlgorithmIds(new Set(config.algoIds));
    setHandoffNotice(config);
  });

  // Clamp minConsensus whenever the selected algorithm count shrinks
  useEffect(() => {
    const maxAllowed = Math.max(1, selectedAlgorithmIds.size);
    if (minConsensus > maxAllowed) setMinConsensus(maxAllowed);
  }, [selectedAlgorithmIds.size, minConsensus]);

  // ── Auto-save 1 s after any change ──────────────────────────────────────
  const persistAnn = useCallback((next: AutoGuessManualAnnotation) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      setSaving(true);
      const ok = await saveAutoGuessAnnotation(songId, next);
      setSaving(false);
      setSaveMsg(ok ? 'Saved' : 'Save failed');
      setTimeout(() => setSaveMsg(null), 2000);
    }, 1000);
  }, [songId]);

  const updateAnn = useCallback((next: AutoGuessManualAnnotation) => {
    setAnn(next);
    onAnnotationChange?.(next);
    persistAnn(next);
  }, [onAnnotationChange, persistAnn]);

  // Auto-bump auto_guess_status from "none" → "wip" on the first content edit.
  // Uses points reference equality so status-only changes don't trigger.
  useEffect(() => {
    if (!ann || loading) return;
    if (prevPointsRef.current === ann.points) return;
    prevPointsRef.current = ann.points;
    const status = ann.auto_guess_status ?? 'none';
    if (status !== 'none') return;
    updateAnn({ ...ann, auto_guess_status: 'wip', updated_at: new Date().toISOString() });
  }, [ann, loading, updateAnn]);

  // ── Generate from loaded algorithms ─────────────────────────────────────
  // Guard: if annotation already has points, require explicit confirmation
  // so cached/reviewed work is never accidentally overwritten.
  const handleGenerate = useCallback((force = false) => {
    if (ann?.points.length && !force) {
      // First click → show confirmation prompt; actual generate on second click
      setConfirmRegenerate(true);
      return;
    }
    setConfirmRegenerate(false);
    // The parameters are now baked into the points; the notice has done its job.
    handoffRef.current = null;
    setHandoffNotice(null);
    const activeRows = algorithmRows.filter((r) => selectedAlgorithmIds.has(r.id));
    if (!activeRows.length) return;
    const allPoints = activeRows.flatMap((row) =>
      row.sections.map((s) => ({ algorithmId: row.id, time: s.time })),
    );
    const points = clusterBoundaries(allPoints, clusterTolerance, centroidMethod);
    const now = new Date().toISOString();
    const next: AutoGuessManualAnnotation = {
      song: songId,
      created_at: ann?.created_at ?? now,
      updated_at: now,
      clusterTolerance,
      ...(centroidMethod !== 'mean' ? { centroidMethod } : {}),
      points,
    };
    updateAnn(next);
  }, [algorithmRows, selectedAlgorithmIds, clusterTolerance, centroidMethod, ann, songId, updateAnn]);

  // ── Centroid method — live re-apply to all non-player-corrected points ──────
  const handleCentroidMethodChange = useCallback((method: AutoGuessCentroidMethod) => {
    setCentroidMethod(method);
    if (!ann) return;
    const points = ann.points.map((p) => {
      if (p.correctionSource === 'player' || p.correctionSource === 'manual') return p;
      if (!p.sources.length) return p;
      const members = p.sources.map((s) => ({ algorithmId: s.algorithmId, time: s.originalTime }));
      const centroid = computeClusterTime(members, method);
      return {
        ...p,
        time: centroid,
        correctionSource: method !== 'mean' ? method : undefined,
      };
    });
    updateAnn({ ...ann, centroidMethod: method !== 'mean' ? method : undefined, updated_at: new Date().toISOString(), points });
  }, [ann, updateAnn]);

  // ── Point review actions ─────────────────────────────────────────────────
  const updatePoint = useCallback((id: string, patch: Partial<AutoGuessPoint>) => {
    if (!ann) return;
    const points = ann.points.map((p) => p.id === id ? { ...p, ...patch } : p);
    updateAnn({ ...ann, updated_at: new Date().toISOString(), points });
  }, [ann, updateAnn]);

  const markCorrect = useCallback((id: string) => {
    updatePoint(id, { status: 'correct', correctionSource: undefined, sourceStatuses: undefined });
  }, [updatePoint]);

  const markIncorrect = useCallback((id: string) => {
    updatePoint(id, { status: 'incorrect', correctionSource: undefined, sourceStatuses: undefined });
  }, [updatePoint]);

  const markPending = useCallback((id: string) => {
    updatePoint(id, { status: 'pending', correctionSource: undefined, sourceStatuses: undefined });
  }, [updatePoint]);

  // Toggle a single source's decision within a cluster.
  // Any source decision sets the cluster to 'partial'; clearing all reverts to 'pending'.
  const updateSourceStatus = useCallback((pointId: string, algorithmId: string, decision: 'approved' | 'rejected') => {
    const point = ann?.points.find((p) => p.id === pointId);
    if (!point) return;
    const current = point.sourceStatuses ?? {};
    const isToggle = current[algorithmId] === decision;
    const newStatuses = isToggle
      ? Object.fromEntries(Object.entries(current).filter(([k]) => k !== algorithmId))
      : { ...current, [algorithmId]: decision };
    const hasAny = Object.keys(newStatuses).length > 0;
    updatePoint(pointId, {
      sourceStatuses: hasAny ? newStatuses : undefined,
      status: hasAny ? 'partial' : 'pending',
    });
  }, [ann, updatePoint]);

  const adjustFromPlayer = useCallback((id: string) => {
    updatePoint(id, { time: currentTime, status: 'correct', correctionSource: 'player' });
  }, [currentTime, updatePoint]);

  const addMissingPointFromPlayer = useCallback(() => {
    const now = new Date().toISOString();
    const nextPoint: AutoGuessPoint = {
      id: generateId(),
      time: currentTime,
      originalTime: currentTime,
      sources: [],
      clusterId: (ann?.points.reduce((m, p) => Math.max(m, p.clusterId), -1) ?? -1) + 1,
      clusterSize: 1,
      status: 'correct',
      correctionSource: 'manual',
    };

    const next: AutoGuessManualAnnotation = ann
      ? {
          ...ann,
          updated_at: now,
          points: [...ann.points, nextPoint].sort((a, b) => a.time - b.time),
        }
      : {
          song: songId,
          created_at: now,
          updated_at: now,
          clusterTolerance,
          points: [nextPoint],
        };

    updateAnn(next);
  }, [ann, currentTime, songId, clusterTolerance, updateAnn]);

  const adoptSourceTime = useCallback((pointId: string, source: AutoGuessSource) => {
    updatePoint(pointId, {
      time: source.originalTime,
      status: 'correct',
      correctionSource: source.algorithmId,
    });
  }, [updatePoint]);

  const resetTime = useCallback((id: string) => {
    const point = ann?.points.find((p) => p.id === id);
    if (!point) return;
    updatePoint(id, { time: point.originalTime, correctionSource: undefined });
  }, [ann, updatePoint]);

  const removePoint = useCallback((id: string) => {
    if (!ann) return;
    const next: AutoGuessManualAnnotation = {
      ...ann,
      updated_at: new Date().toISOString(),
      points: ann.points.filter((p) => p.id !== id),
    };
    updateAnn(next);
    if (expandedId === id) setExpandedId(null);
  }, [ann, updateAnn, expandedId]);

  // ── Threshold-filtered points (min consensus) ────────────────────────────
  const thresholdFilteredPoints = ann?.points.filter((p) => agreementCount(p) >= minConsensus) ?? [];


  // ── Stats ────────────────────────────────────────────────────────────────
  const stats = ann ? {
    total: ann.points.length,
    correct: ann.points.filter((p) => p.status === 'correct').length,
    incorrect: ann.points.filter((p) => p.status === 'incorrect').length,
    pending: ann.points.filter((p) => p.status === 'pending').length,
    partial: ann.points.filter((p) => p.status === 'partial').length,
  } : null;

  const filteredPoints = ann?.points.filter((p) => {
    if (agreementCount(p) < minConsensus) return false;
    if (filterStatus === 'all') return true;
    if (filterStatus === 'pending') return p.status === 'pending' || p.status === 'partial';
    return p.status === filterStatus;
  }) ?? [];


  // ── Page-level controller wiring ──────────────────────────────────────────
  // The shared toolbar pill is the only status control; it writes
  // `auto_guess_status` so the sidebar status badge (which keys off that
  // field) stays in sync.
  const stageFromAutoGuessStatus = (s: AutoGuessStatus | undefined): AnnotationStage =>
    s === 'done' ? 'reviewed' : s === 'wip' ? 'ready_for_review' : 'in_progress';
  const autoGuessStatusFromStage = (stage: AnnotationStage): AutoGuessStatus =>
    stage === 'reviewed' ? 'done' : stage === 'ready_for_review' ? 'wip' : 'none';

  const setAnnotationStage = useCallback((stage: AnnotationStage) => {
    const now = new Date().toISOString();
    const status = autoGuessStatusFromStage(stage);
    if (ann) {
      updateAnn({ ...ann, auto_guess_status: status, updated_at: now });
      return;
    }
    updateAnn({
      song: songId,
      created_at: now,
      updated_at: now,
      clusterTolerance,
      ...(centroidMethod !== 'mean' ? { centroidMethod } : {}),
      auto_guess_status: status,
      points: [],
    });
  }, [ann, songId, clusterTolerance, centroidMethod, updateAnn]);

  useImperativeHandle<AnnotationPanelController, AnnotationPanelController>(controllerRef, () => ({
    setStatus: setAnnotationStage,
  }), [setAnnotationStage]);

  useEffect(() => {
    if (!onCapabilitiesChange) return;
    const stage = stageFromAutoGuessStatus(ann?.auto_guess_status);
    onCapabilitiesChange({
      ...emptyCapabilities(),
      status: stage,
      hasItems: (ann?.points.length ?? 0) > 0,
      saveStatus: saving ? 'saving' : saveMsg === 'Saved' ? 'saved' : saveMsg === 'Save failed' ? 'error' : 'idle',
      canUndo: false,
      canRedo: false,
      canSplit: false,
      splitVisible: false,
      splitLabel: 'Split',
      canAddAtPlayhead: false,
      addLabel: '+ Add',
      pending: null,
      pendingRequiresRegion: false,
      importFormats: [],
      // Export is handled by the page-level ExportManagerModal, which knows
      // how to serialize the auto-guess annotation alongside Manual/Eye.
      canExport: ann !== null && ann.points.length > 0,
      canDeleteAll: ann !== null,
    });
  }, [onCapabilitiesChange, ann, saving, saveMsg]);

  // ─────────────────────────────────────────────────────────────────────────

  if (loading) {
    return <p className="text-xs text-gray-500 py-2">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      {/* Status + save indicator now live in the shared AnnotationToolbar
          above this panel (fed via onCapabilitiesChange). */}

      {/* ── Section header: explains what the consensus controls below do ─── */}
      {algorithmRows.length > 0 && (
        <div className="border-l-2 border-violet-400/40 pl-3 py-1">
          <h4 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-violet-200">
            Evaluate as &apos;Manual&apos;
          </h4>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Configure the consensus parameters: <span className="text-slate-500 uppercase tracking-wider text-[10px]">settings</span>
          </p>
          {handoffNotice && (
            <p className="text-[11px] text-cyan-300/90 mt-1 flex items-center gap-2 flex-wrap">
              <span>
                From Consensus Inspect: <span className="font-mono">±{handoffNotice.clusterWindow}s</span>
                {' · '}<span className="font-mono">≥{handoffNotice.minAgreement}</span>
                {' · '}<span className="font-mono">{CENTROID_METHODS.find((m) => m.id === handoffNotice.centroid)?.short}</span>
                {' · '}<span className="font-mono">{handoffNotice.algoIds.length} detectors</span>
                {' — press '}<span className="uppercase tracking-wider text-[10px] text-violet-300">generate</span> to rebuild with them.
              </span>
              <button
                onClick={() => { handoffRef.current = null; setHandoffNotice(null); }}
                className="text-slate-500 hover:text-slate-300 transition-colors"
                title="Dismiss"
              >✕</button>
            </p>
          )}
        </div>
      )}

      {/* ── Top control row: settings popover + cluster window + actions ─── */}
      <div className="flex flex-wrap items-center gap-2">
        {algorithmRows.length > 0 && (
          <ConsensusClusterControls
            algoRows={algorithmRows.map((r) => ({ id: r.id, displayLabel: algoLabel(r.id), count: r.sections.length }))}
            selectedAlgoIds={selectedAlgorithmIds}
            onSelectedAlgoIdsChange={setSelectedAlgorithmIds}
            showMsafShortcut
            clusterWindow={clusterTolerance}
            onClusterWindowChange={setClusterTolerance}
            centroidMethod={centroidMethod}
            onCentroidMethodChange={handleCentroidMethodChange}
            centroidOptions={CENTROID_METHODS.map((m) => ({ id: m.id, short: m.short, description: m.detail }))}
            minConsensus={minConsensus}
            onMinConsensusChange={setMinConsensus}
            minConsensusLabel="Min consensus"
          />
        )}

        {/* ── Take these parameters somewhere they can be scored ───────────
             Nothing here says whether ±3s beats ±2s; Consensus Inspect draws
             the same clustering against a reference with live P/R/F1. The trip
             is round: that panel hands the tuned config back. */}
        {onTuneInConsensus && algorithmRows.length > 0 && (
          <button
            onClick={() => {
              sendConsensusConfig('consensus', {
                clusterWindow: clusterTolerance,
                minAgreement: minConsensus,
                centroid: centroidMethod,
                algoIds: [...selectedAlgorithmIds],
              });
              onTuneInConsensus();
            }}
            className="px-2.5 py-1.5 rounded text-[11px] uppercase tracking-wider bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] hover:border-violet-400/40 text-slate-300 transition-colors flex items-center gap-1.5"
            title="Open Consensus Inspect with these parameters and score them against your Boundaries — precision, recall and F1 — before generating here"
          >
            Tune in Consensus Inspect
            <span className="text-violet-300">→</span>
          </button>
        )}

        {confirmRegenerate ? (
          <span className="flex items-center gap-1.5">
            <span className="text-[10px] font-mono text-amber-400">Overwrite {ann?.points.length} cached points?</span>
            <button
              onClick={() => handleGenerate(true)}
              className="px-2 py-1 rounded text-[10px] uppercase tracking-wider bg-red-500/20 hover:bg-red-500/30 text-red-200 border border-red-400/40 transition-colors"
            >Yes, overwrite</button>
            <button
              onClick={() => setConfirmRegenerate(false)}
              className="px-2 py-1 rounded text-[10px] uppercase tracking-wider bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 transition-colors"
            >Cancel</button>
          </span>
        ) : (
          <button
            onClick={() => handleGenerate()}
            disabled={selectedAlgorithmIds.size === 0}
            className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-violet-500/20 hover:bg-violet-500/30 border border-violet-400/40 disabled:opacity-40 disabled:cursor-not-allowed text-violet-100 transition-colors flex items-center gap-1.5"
            title={selectedAlgorithmIds.size === 0 ? 'Select at least one algorithm' : ann?.points.length ? `Cached (${ann.points.length} points) — click to re-generate with ±${clusterTolerance}s` : `Cluster boundaries from ${selectedAlgorithmIds.size} algorithm(s) with ±${clusterTolerance}s`}
          >
            <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
            </svg>
            {ann?.points.length ? `Re-generate (${ann.points.length})` : `Generate`}
          </button>
        )}

        <button
          onClick={addMissingPointFromPlayer}
          className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/40 text-cyan-100 transition-colors flex items-center gap-1.5"
          title={`Add a missing boundary point at player time (${fmtTime(currentTime)}), even if no algorithm suggested it`}
        >
          <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 010-2h5V4a1 1 0 011-1z" clipRule="evenodd" />
          </svg>
          Add @ <span className="font-mono normal-case tracking-normal">{fmtTime(currentTime)}</span>
        </button>

        {onCopyToManualAnnotation && ann && ann.points.length > 0 && (() => {
          // Mirrors DetectorOutputReview's two-button "copy to manual layer"
          // affordance. 'accepted' = ✓ only; 'all' = everything except explicit
          // ✗ (pending kept), so a single click pulls the raw cluster into
          // editable section boundaries.
          const acceptedPoints = ann.points.filter((p) => p.status === 'correct');
          const keepablePoints = ann.points.filter((p) => p.status !== 'incorrect');
          const copy = (mode: 'accepted' | 'all') => {
            const src = mode === 'accepted' ? acceptedPoints : keepablePoints;
            if (src.length === 0) return;
            const sections: SectionBlock[] = [...src]
              .sort((a, b) => a.time - b.time)
              .map((p) => ({ time: p.time, type: 'drop', label: 'Auto-guess' }));
            onCopyToManualAnnotation(sections);
          };
          return (
            <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-slate-500 ml-1">
              Copy to manual:
              <button
                type="button"
                onClick={() => copy('accepted')}
                disabled={acceptedPoints.length === 0}
                title={acceptedPoints.length === 0
                  ? 'No accepted points to copy'
                  : `Copy ${acceptedPoints.length} accepted point${acceptedPoints.length === 1 ? '' : 's'} into the manual annotation as section boundaries`}
                className="px-2 py-1 rounded text-[10px] uppercase tracking-wider bg-emerald-500/20 hover:bg-emerald-500/30 disabled:opacity-30 disabled:cursor-not-allowed border border-emerald-400/40 text-emerald-100 transition-colors"
              >✓ accepted</button>
              <button
                type="button"
                onClick={() => copy('all')}
                disabled={keepablePoints.length === 0}
                title={`Copy ${keepablePoints.length} point${keepablePoints.length === 1 ? '' : 's'} (everything not rejected) into the manual annotation as section boundaries`}
                className="px-2 py-1 rounded text-[10px] uppercase tracking-wider bg-white/[0.06] hover:bg-white/[0.10] disabled:opacity-30 disabled:cursor-not-allowed border border-white/[0.14] text-slate-200 transition-colors"
              >all</button>
            </span>
          );
        })()}

      </div>

      {!ann && (
        <p className="text-[11px] text-slate-500 italic">
          No auto-guess annotation yet. Run algorithms (MSAF · CPD · AllIn1) from the inspector, then click "Generate", or add a boundary manually from the player.
        </p>
      )}

      {/* ── Stats info box ──────────────────────────────────────────── */}
      {ann && stats && (
        <div className="rounded-md border border-white/[0.06] bg-[#14171d]/60 px-3 py-2 flex flex-wrap gap-x-5 gap-y-1 text-[11px] font-mono tabular-nums">
          <span className="text-slate-400"><span className="text-slate-200">{stats.total}</span> points · tol {ann.clusterTolerance}s</span>
          {minConsensus > 1 && (
            <span className="text-cyan-400"><span className="text-cyan-200">{thresholdFilteredPoints.length}</span> pass ≥{minConsensus}</span>
          )}
          <span className="text-emerald-400"><span className="text-emerald-200">{stats.correct}</span> correct</span>
          <span className="text-rose-400"><span className="text-rose-300">{stats.incorrect}</span> incorrect</span>
          <span className="text-slate-500"><span className="text-slate-300">{stats.pending}</span> pending</span>
          {(stats.correct + stats.incorrect) > 0 && (
            <span className="text-slate-400">{Math.round(((stats.correct + stats.incorrect) / stats.total) * 100)}% reviewed</span>
          )}
        </div>
      )}

      {/* ── Filter tabs ─────────────────────────────────────────────── */}
      {ann && (
        <div className="flex flex-wrap gap-px">
          {(['all', 'pending', 'correct', 'incorrect'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilterStatus(f)}
              className={`px-2.5 py-0.5 text-[10px] uppercase tracking-wider transition-colors first:rounded-l last:rounded-r border ${
                filterStatus === f
                  ? f === 'correct' ? 'bg-emerald-500/20 border-emerald-400/40 text-emerald-200'
                  : f === 'incorrect' ? 'bg-rose-500/20 border-rose-400/40 text-rose-200'
                  : f === 'pending' ? 'bg-white/[0.08] border-white/[0.14] text-slate-100'
                  : 'bg-violet-500/20 border-violet-400/40 text-violet-200'
                  : 'bg-white/[0.02] border-white/[0.06] text-slate-500 hover:bg-white/[0.06] hover:text-slate-300'
              }`}
            >
              {f === 'pending'
                ? `pending${stats ? ` (${stats.pending + stats.partial})` : ''}`
                : f !== 'all' && stats ? `${f} (${stats[f]})` : f}
            </button>
          ))}
        </div>
      )}

      {/* ── Points table ────────────────────────────────────────────── */}
      {ann && filteredPoints.length === 0 && (
        <p className="text-[11px] text-slate-600 italic">No points match the current filter.</p>
      )}

      {ann && filteredPoints.length > 0 && (
        <div className="flex flex-wrap items-start gap-1">
          {filteredPoints.map((point, pi) => {
            const agreeing = agreementCount(point);
            const { bg, text } = clusterBadgeStyle(agreeing);
            const isExpanded = expandedId === point.id;
            const isChipsOpen = chipsExpandedIds.has(point.id);
            const timeChanged = Math.abs(point.time - point.originalTime) > 0.01;

            // Per-status accent — matches Manual/Eye 2px left rail + playhead glow.
            // Pending uses a muted rail; glow color stays slate so the highlight is still visible.
            const statusColor =
              point.status === 'correct'   ? '#10b981' :
              point.status === 'incorrect' ? '#ef4444' :
              point.status === 'partial'   ? '#f59e0b' :
                                              '#64748b';
            const railColor = point.status === 'pending' ? 'rgba(255,255,255,0.08)' : statusColor;

            // Highlight when the playhead sits between this boundary and the next visible one.
            const nextTime = filteredPoints[pi + 1]?.time ?? Infinity;
            const isCurrent = currentTime >= point.time && currentTime < nextTime;

            const chipCount = point.status === 'correct' && algorithmRows.length > 0
              ? algorithmRows.length
              : point.sources.length;
            const COLLAPSE_THRESHOLD = 4;
            const chipsCollapsed = chipCount > COLLAPSE_THRESHOLD && !isChipsOpen;

            return (
              <div
                key={point.id}
                className={`flex flex-col rounded-r border border-l-0 bg-[#14171d] hover:bg-[#1b1f27] transition-all overflow-hidden ${isExpanded ? 'w-[300px]' : 'w-[108px]'}`}
                style={(() => {
                  // Longhand *Color properties (never the all-sides `borderColor`
                  // shorthand) so the left rail's own color never fights with the
                  // top/right/bottom color across re-renders — see ItemCardShell.
                  const restBorderColor = isCurrent ? `${statusColor}99` : 'rgba(255,255,255,0.06)';
                  return {
                    borderLeft: `2px solid ${railColor}`,
                    borderTopColor: restBorderColor,
                    borderRightColor: restBorderColor,
                    borderBottomColor: restBorderColor,
                    boxShadow: isCurrent ? `0 0 0 1px ${statusColor}55, 0 0 12px 0 ${statusColor}33` : undefined,
                  };
                })()}
              >
                {/* ── Header: cluster badge + adjustment indicator ── */}
                <div className="flex items-center gap-1 px-1.5 pt-1 pb-0.5">
                  <span
                    className="text-[9px] font-mono font-medium rounded px-1 py-0.5 leading-none shrink-0"
                    style={{ background: bg, color: text }}
                    title={`${agreeing} algorithm${agreeing !== 1 ? 's' : ''} agreed within ±${ann.clusterTolerance}s${
                      point.sources.length > agreeing ? ` (${point.sources.length} predictions — one or more fired twice)` : ''
                    }`}
                  >
                    ×{agreeing}
                  </span>
                  {timeChanged && (
                    <span
                      className="text-[9px] font-mono text-amber-400 truncate ml-auto"
                      title={`Adjusted from ${fmtTime(point.originalTime)} via ${point.correctionSource ?? '?'}`}
                    >
                      ✎ {point.correctionSource === 'player' ? '@player' : algoLabel(point.correctionSource ?? '')}
                    </span>
                  )}
                </div>

                {/* ── Time (clickable to seek) ── */}
                <button
                  className="font-mono text-[10px] text-violet-300 hover:text-violet-100 transition-colors px-1.5 pb-1 text-left tabular-nums"
                  onClick={() => onSeekAndPlay?.(point.time)}
                  title="Seek to this point"
                >
                  {fmtTime(point.time)}
                </button>

                {/* ── Chips: collapsed summary or full list ── */}
                <div className="px-1.5 pb-1">
                  {chipsCollapsed ? (
                    <button
                      onClick={() => toggleChips(point.id)}
                      title="Show all algorithm chips"
                      className="w-full flex items-center gap-1 text-[10px] font-mono px-1 py-0.5 rounded bg-[#0a0b0d] border border-white/[0.06] hover:border-white/[0.12] text-left transition-colors"
                    >
                      {(() => {
                        if (point.status === 'correct' && algorithmRows.length > 0) {
                          let hits = 0;
                          algorithmRows.forEach((row) => {
                            if (row.sections.some((s) => Math.abs(s.time - point.time) <= hitTolerance)) hits++;
                          });
                          const misses = algorithmRows.length - hits;
                          return (
                            <>
                              <span className="text-emerald-300">✓{hits}</span>
                              {misses > 0 && (
                                <>
                                  <span className="text-slate-700">·</span>
                                  <span className="text-slate-500">✗{misses}</span>
                                </>
                              )}
                            </>
                          );
                        }
                        if (point.status === 'partial') {
                          const ss = point.sourceStatuses ?? {};
                          const approved = Object.values(ss).filter((v) => v === 'approved').length;
                          const rejected = Object.values(ss).filter((v) => v === 'rejected').length;
                          const undecided = chipCount - approved - rejected;
                          const parts: ReactNode[] = [];
                          if (approved > 0) parts.push(<span key="a" className="text-emerald-300">✓{approved}</span>);
                          if (rejected > 0) parts.push(<span key="r" className="text-rose-300">✗{rejected}</span>);
                          if (undecided > 0) parts.push(<span key="u" className="text-slate-500">·{undecided}</span>);
                          return parts.flatMap((p, i) => i === 0 ? [p] : [<span key={`s${i}`} className="text-slate-700">·</span>, p]);
                        }
                        return <span className="text-slate-400">{chipCount} algos</span>;
                      })()}
                      <span className="text-slate-600 text-[10px] ml-auto">▸</span>
                    </button>
                  ) : (
                    <div className="flex flex-wrap gap-0.5 items-center">
                      {point.status === 'correct' && algorithmRows.length > 0
                        ? algorithmRows.map((row) => {
                            const hit = row.sections.some(
                              (s) => Math.abs(s.time - point.time) <= hitTolerance,
                            );
                            const closest = row.sections.reduce<{ time: number } | null>(
                              (best, s) =>
                                best === null || Math.abs(s.time - point.time) < Math.abs(best.time - point.time)
                                  ? s : best,
                              null,
                            );
                            const dist = closest ? Math.abs(closest.time - point.time) : null;
                            const srcOriginalTime = point.sources.find((s) => s.algorithmId === row.id)?.originalTime;
                            return (
                              <span
                                key={row.id}
                                className={`text-[9px] px-1 py-0.5 rounded font-mono truncate inline-block max-w-full border transition-colors ${
                                  hit
                                    ? 'bg-emerald-500/10 text-emerald-300 border-emerald-400/30'
                                    : 'bg-white/[0.02] text-slate-600 border-white/[0.04]'
                                }`}
                                title={`${row.id}: ${hit ? `HIT @ ${fmtTime(closest!.time)} (Δ${dist!.toFixed(2)}s)` : `MISS — closest ${dist != null ? `${dist.toFixed(1)}s away` : 'n/a'}`}${srcOriginalTime != null ? ` | originally suggested ${fmtTime(srcOriginalTime)}` : ''}`}
                              >
                                {hit ? '✓' : '✗'} {algoLabel(row.id)}
                              </span>
                            );
                          })
                        : point.status === 'partial'
                        ? point.sources.map((src) => {
                            const srcStatus = point.sourceStatuses?.[src.algorithmId];
                            return (
                              <span
                                key={src.algorithmId}
                                className={`text-[9px] px-1 py-0.5 rounded font-mono truncate inline-block max-w-full border transition-colors ${
                                  srcStatus === 'approved'
                                    ? 'bg-emerald-500/10 text-emerald-300 border-emerald-400/30'
                                    : srcStatus === 'rejected'
                                    ? 'bg-rose-500/10 text-rose-300 border-rose-400/30 opacity-60'
                                    : 'bg-white/[0.04] text-slate-300 border-white/[0.06]'
                                }`}
                                title={`${src.algorithmId} @ ${fmtTime(src.originalTime)} — ${srcStatus ?? 'undecided'}`}
                              >
                                {srcStatus === 'approved' ? '✓' : srcStatus === 'rejected' ? '✗' : '·'} {algoLabel(src.algorithmId)}
                              </span>
                            );
                          })
                        : point.sources.map((src) => (
                            <span
                              key={src.algorithmId}
                              className="text-[9px] px-1 py-0.5 rounded bg-white/[0.04] border border-white/[0.06] text-slate-300 font-mono truncate inline-block max-w-full"
                              title={`${src.algorithmId} @ ${fmtTime(src.originalTime)}`}
                            >
                              {algoLabel(src.algorithmId)}
                            </span>
                          ))
                      }
                      {chipCount > COLLAPSE_THRESHOLD && (
                        <button
                          onClick={() => toggleChips(point.id)}
                          title="Collapse"
                          className="text-[10px] text-slate-600 hover:text-slate-300 px-1 transition-colors"
                        >
                          ▾
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* ── Action buttons ── */}
                <div className="flex items-center gap-px px-1 pb-1 pt-0.5 border-t border-white/[0.04] mt-auto">
                  <button
                    onClick={() => (point.status === 'correct' || point.status === 'partial') ? markPending(point.id) : markCorrect(point.id)}
                    title={
                      point.status === 'correct' ? 'Mark pending (clear bulk approval)'
                      : point.status === 'partial' ? 'Bulk approve all at cluster mean'
                      : 'Mark correct'
                    }
                    className={`flex-1 h-5 flex items-center justify-center rounded text-[11px] font-medium transition-colors border ${
                      point.status === 'correct'
                        ? 'bg-emerald-500/70 border-emerald-400/60 text-emerald-50'
                        : point.status === 'partial'
                        ? 'bg-emerald-500/10 border-emerald-400/20 text-emerald-300 hover:bg-emerald-500/20'
                        : 'border-white/[0.04] text-slate-500 hover:bg-emerald-500/15 hover:text-emerald-200 hover:border-emerald-400/30'
                    }`}
                  >
                    ✓
                  </button>
                  <button
                    onClick={() => point.status === 'incorrect' ? markPending(point.id) : markIncorrect(point.id)}
                    title={point.status === 'incorrect' ? 'Mark pending' : 'Mark incorrect'}
                    className={`flex-1 h-5 flex items-center justify-center rounded text-[11px] font-medium transition-colors border ${
                      point.status === 'incorrect'
                        ? 'bg-rose-500/70 border-rose-400/60 text-rose-50'
                        : 'border-white/[0.04] text-slate-500 hover:bg-rose-500/15 hover:text-rose-200 hover:border-rose-400/30'
                    }`}
                  >
                    ✗
                  </button>
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : point.id)}
                    title="Adjust timing"
                    className={`w-5 h-5 flex items-center justify-center rounded transition-colors border ${
                      isExpanded
                        ? 'bg-violet-500/25 border-violet-400/40 text-violet-100'
                        : 'border-white/[0.04] text-slate-500 hover:bg-violet-500/15 hover:text-violet-200 hover:border-violet-400/30'
                    }`}
                  >
                    <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                      <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => removePoint(point.id)}
                    title="Remove this point from the annotation"
                    className="w-5 h-5 flex items-center justify-center text-slate-600 hover:text-red-400 text-[10px] transition-colors tc-hover-reveal"
                  >
                    ✕
                  </button>
                </div>

                {/* ── Expanded edit panel (per-source decisions + adjust timing) ── */}
                {isExpanded && (
                  <div className="px-2 pb-2 pt-2 border-t border-white/[0.06] space-y-2.5">
                    {/* Per-source individual decisions */}
                    <div className="space-y-1">
                      <p className="text-[9px] text-slate-500 uppercase tracking-wider">
                        Review per algorithm
                      </p>
                      <div className="space-y-0.5">
                        {(() => {
                          const sorted = [...point.sources].sort((a, b) => a.originalTime - b.originalTime);
                          return sorted.map((src, idx) => {
                            const srcStatus = point.sourceStatuses?.[src.algorithmId];
                            const nextSrc = sorted[idx + 1];
                            const stopTime = nextSrc ? nextSrc.originalTime : src.originalTime + 4;
                            return (
                              <div key={src.algorithmId} className="flex items-center gap-1">
                                <button
                                  onClick={() => onSeekAndPlay?.(src.originalTime, stopTime)}
                                  title={`Play from ${fmtTime(src.originalTime)} → ${fmtTime(stopTime)}`}
                                  className="w-5 h-5 rounded flex items-center justify-center transition-colors bg-[#0a0b0d] border border-white/[0.06] text-emerald-400 hover:border-emerald-400/40 shrink-0"
                                >
                                  <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
                                  </svg>
                                </button>
                                <span className="font-mono text-[10px] text-violet-300 w-12 tabular-nums shrink-0">
                                  {fmtTime(src.originalTime)}
                                </span>
                                <span className="text-[10px] text-slate-400 font-mono flex-1 truncate">{algoLabel(src.algorithmId)}</span>
                                <button
                                  onClick={() => updateSourceStatus(point.id, src.algorithmId, 'approved')}
                                  title={srcStatus === 'approved' ? 'Unapprove' : `Approve at ${fmtTime(src.originalTime)}`}
                                  className={`w-5 h-5 rounded flex items-center justify-center text-[11px] font-bold transition-colors border ${
                                    srcStatus === 'approved'
                                      ? 'bg-emerald-500/70 border-emerald-400/60 text-emerald-50'
                                      : 'border-white/[0.04] text-slate-500 hover:bg-emerald-500/15 hover:text-emerald-200 hover:border-emerald-400/30'
                                  }`}
                                >✓</button>
                                <button
                                  onClick={() => updateSourceStatus(point.id, src.algorithmId, 'rejected')}
                                  title={srcStatus === 'rejected' ? 'Un-reject' : 'Reject'}
                                  className={`w-5 h-5 rounded flex items-center justify-center text-[11px] font-bold transition-colors border ${
                                    srcStatus === 'rejected'
                                      ? 'bg-rose-500/70 border-rose-400/60 text-rose-50'
                                      : 'border-white/[0.04] text-slate-500 hover:bg-rose-500/15 hover:text-rose-200 hover:border-rose-400/30'
                                  }`}
                                >✗</button>
                              </div>
                            );
                          });
                        })()}
                      </div>
                    </div>

                    {/* Adjust timing (skip when in partial review) */}
                    {point.status !== 'partial' && (
                      <div className="space-y-1.5">
                        <p className="text-[9px] text-slate-500 uppercase tracking-wider">Adjust timing</p>

                        <div className="flex items-center gap-1.5">
                          <input
                            key={`${point.id}-${point.time}`}
                            type="number"
                            defaultValue={point.time.toFixed(3)}
                            step="0.001"
                            min="0"
                            className="w-20 bg-[#0a0b0d] border border-white/[0.06] text-slate-200 text-[10px] font-mono rounded px-1.5 py-0.5 focus:outline-none focus:border-violet-500/50"
                            onBlur={(e) => {
                              const t = parseFloat(e.target.value);
                              if (!isNaN(t) && Math.abs(t - point.time) > 0.001) {
                                updatePoint(point.id, { time: t, status: 'correct', correctionSource: 'player' });
                              }
                            }}
                            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                          />
                          <BarBeatInput
                            value={point.time}
                            onChange={(t) => updatePoint(point.id, { time: t, status: 'correct', correctionSource: 'player' })}
                            bpm={songInfo?.bpm}
                            gridOffset={songInfo?.gridOffset ?? 0}
                            beatsPerBar={beatsPerBarFromTimeSignature(songInfo?.timeSignature)}
                            className="w-16 bg-[#0a0b0d] border border-white/[0.06] text-slate-200 text-[10px] font-mono rounded px-1.5 py-0.5 focus:outline-none focus:border-violet-500/50 disabled:text-slate-600 disabled:cursor-not-allowed"
                          />
                          <button
                            onClick={() => adjustFromPlayer(point.id)}
                            className="px-2 py-0.5 rounded text-[10px] bg-violet-500/15 hover:bg-violet-500/25 border border-violet-400/40 text-violet-200 transition-colors"
                            title={`Set time to player position: ${fmtTime(currentTime)}`}
                          >
                            @ {fmtTime(currentTime)}
                          </button>
                          {timeChanged && (
                            <button
                              onClick={() => resetTime(point.id)}
                              className="px-1.5 py-0.5 rounded text-[10px] border border-white/[0.06] text-slate-400 hover:text-slate-200 transition-colors"
                              title={`Reset to cluster mean: ${fmtTime(point.originalTime)}`}
                            >
                              reset
                            </button>
                          )}
                        </div>

                        {point.sources.length > 1 && (
                          <div className="space-y-1">
                            <p className="text-[9px] text-slate-600">Adopt from algorithm:</p>
                            <div className="flex flex-wrap gap-0.5">
                              {point.sources.map((src) => (
                                <button
                                  key={src.algorithmId}
                                  onClick={() => adoptSourceTime(point.id, src)}
                                  className={`px-1.5 py-0.5 rounded text-[9px] transition-colors flex items-center gap-1 border ${
                                    point.correctionSource === src.algorithmId
                                      ? 'bg-amber-500/25 border-amber-400/40 text-amber-100'
                                      : 'bg-[#0a0b0d] border-white/[0.06] text-slate-300 hover:border-white/[0.14]'
                                  }`}
                                  title={`Use ${src.algorithmId} time: ${fmtTime(src.originalTime)}`}
                                >
                                  {algoLabel(src.algorithmId)}
                                  <span className="font-mono opacity-60">{fmtTime(src.originalTime)}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}

const AutoGuessPanel = forwardRef<AnnotationPanelController, AutoGuessPanelProps>(AutoGuessPanelInner);
AutoGuessPanel.displayName = 'AutoGuessPanel';
export default AutoGuessPanel;
