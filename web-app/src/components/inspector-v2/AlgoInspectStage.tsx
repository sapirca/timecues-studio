import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ToolResultData } from '../../tools/runTool';
import { useMirEvalSingle } from '../../services/mirEvalClient';
import { evaluateCustom } from '../../utils/evaluation';
import { clusterPoints, computeAllClusterTimes } from '../../utils/boundaryClustering';
import type { SectionBlock } from '../../types/sectionBlock';
import type { AutoGuessCentroidMethod } from '../../types/autoGuess';
import { sendConsensusConfig } from '../../state/consensusHandoff';
import { useConsensusHandoff } from '../../hooks/useConsensusHandoff';
import { CustomEvalControls, DEFAULT_CUSTOM_EVAL_SETTINGS, type CustomEvalSettings } from './CustomEvalControls';
import { EvalReferenceDropdown, type EvalReferenceMode } from './EvalReferenceDropdown';
import { ConsensusClusterControls } from './ConsensusClusterControls';
import { ConsensusPreviewLane, type PreviewCluster } from './ConsensusPreviewLane';
import { sectionEnd } from './sectionConstants';
import { InfoDot } from './InfoDot';

type ReferenceMode = EvalReferenceMode;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolState {
  status: 'idle' | 'running' | 'done' | 'error';
  result?: ToolResultData;
  error?: string;
}

export interface AlgorithmRow {
  id: string;
  label: string;
  /** `raw` carries the detector's original per-section JSON (every field it
   *  emitted, before the lossy map onto time/endTime/label/type) so the algo
   *  Inspect card can surface it as "Raw model output" — parity with the
   *  curator cards. Absent → the card falls back to the mapped section. */
  sections: { time: number; endTime: number; label: string; type: string; color?: string; raw?: unknown }[];
  /** LOOP-family only: which beat grid the detector aligned to
   *  ("song-info" | "allin1" | "librosa"). Drives a small lane badge so the
   *  annotator can see whether loops sit on the curator-aligned grid. */
  gridSource?: string | null;
}

// ─── Tool-state → row builder constants ───────────────────────────────────────

const ALGO_LABELS: Record<string, string> = {
  'msaf-olda':                 'OLDA',
  'msaf-cnmf':                 'CNMF',
  'msaf-foote':                'Foote',
  'msaf-sf':                   'SF',
  'allin1':                    'All-In-One',
  'ruptures-pelt-default':     'PELT (default)',
  'ruptures-binseg-default':   'BinSeg (default)',
  'ruptures-window-default':   'Window (default)',
  'band-gradient':             'BandGrad',
  // SPAN family — experimental. The rows render under the boundary inspector
  // since the visual model (timeline section bars) fits, but their per-kind
  // eval (IoU / frame-F1 / on-off F1) is deferred to the Phase 2 eval rework
  // — until then their eval columns show "—".
  'silero-vad':                'Silero-VAD',
  'jdcnet-voicing':            'JDCNet (voicing)',
  'panns-cnn14':               'PANNs CNN14',
  'basic-pitch':               'basic-pitch',
  'librosa-key':               'librosa key',
  'autochord-chords':          'autochord',
  'librosa-onsets':            'librosa onsets',
  'drum-transients':           'drum transients',
  'hpss-percussive':           'HPSS percussive',
  'whisper-base':              'Whisper-base lyrics',
  'ctc-forced-aligner':        'CTC forced aligner (lyrics)',
  'locomotif':                 'LoCoMotif',
};

/** SPAN-family algo IDs. Exported so consumers (the run-options sidebar in
 *  InspectorPageV2) can filter them out when `experimentalSpanFamily` is off.
 *  panns-cnn14 lives here too — same output kind, separate sidecar. */
export const SPAN_ALGO_IDS = ['silero-vad', 'jdcnet-voicing', 'panns-cnn14'] as const;
export type SpanAlgoId = typeof SPAN_ALGO_IDS[number];

/** CUE-family note-onset detector IDs (gated by `experimentalCueExtras`). */
export const PITCH_ALGO_IDS = ['basic-pitch'] as const;
export type PitchAlgoId = typeof PITCH_ALGO_IDS[number];

/** CUE-family extras (librosa key, autochord chords, librosa onsets, drum
 *  transients) — gated by `experimentalCueExtras`. */
export const CUE_EXTRAS_ALGO_IDS = ['librosa-key', 'autochord-chords', 'librosa-onsets', 'drum-transients'] as const;
export type CueExtrasAlgoId = typeof CUE_EXTRAS_ALGO_IDS[number];

/** Percussive SPAN-family detector (HPSS) — gated by `experimentalSpanFamily`. */
export const PERCUSSIVE_ALGO_IDS = ['hpss-percussive'] as const;
export type PercussiveAlgoId = typeof PERCUSSIVE_ALGO_IDS[number];

/** LYRICS-family detector IDs — gated by `experimentalLyricsFamily`. */
export const LYRICS_ALGO_IDS = ['whisper-base', 'ctc-forced-aligner'] as const;
export type LyricsAlgoId = typeof LYRICS_ALGO_IDS[number];

/** PATTERN-family detector IDs — gated by `experimentalPatternFamily`. */
export const PATTERN_ALGO_IDS = ['locomotif'] as const;
export type PatternAlgoId = typeof PATTERN_ALGO_IDS[number];

const ALGO_ORDER = [
  'band-gradient',
  'ruptures-pelt-default', 'ruptures-binseg-default', 'ruptures-window-default',
  'msaf-olda', 'msaf-cnmf', 'msaf-foote', 'msaf-sf',
  'allin1',
  ...[0,1,2,3,4,5,6,7].map((n) => `allin1-fold${n}`),
  ...SPAN_ALGO_IDS,
  ...PITCH_ALGO_IDS,
  ...CUE_EXTRAS_ALGO_IDS,
  ...PERCUSSIVE_ALGO_IDS,
  ...LYRICS_ALGO_IDS,
  ...PATTERN_ALGO_IDS,
];

// The six Demucs stems, in the order per-stem rows stack under their base row.
const STEM_ROW_ORDER = ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'] as const;

function algoLabel(id: string): string {
  // Composite per-stem id "<algo>__<stem>" → "<base label> · <stem>".
  const i = id.indexOf('__');
  if (i !== -1) return `${algoLabel(id.slice(0, i))} · ${id.slice(i + 2)}`;
  return ALGO_LABELS[id] ?? id.replace('allin1-', 'allin1 ');
}

/** Example detectors ship as templates (tools/python/custom-default/example_*.py) and
 *  register as `custom:example_…` rows. They're opt-in in the consensus picker:
 *  excluded from the default selection and never auto-added by the row-sync
 *  effect, so they only join the consensus when the user checks them on in the
 *  Settings popover. */
const isExampleAlgoId = (id: string) => id.startsWith('custom:example_');

// ─── Build annotation rows from toolStates ────────────────────────────────────

export function buildAnnotationRows(toolStates: Record<string, ToolState>): AlgorithmRow[] {
  // Walk the canonical order, and right after each base detector emit any
  // per-stem variants ("<base>__<stem>") that have a cached result — so a
  // detector's stem rows group directly beneath its full-mix row.
  const ids: string[] = [];
  for (const base of ALGO_ORDER) {
    ids.push(base);
    for (const stem of STEM_ROW_ORDER) {
      if (toolStates[`${base}__${stem}`]) ids.push(`${base}__${stem}`);
    }
  }
  return ids.flatMap((id) => {
    const state = toolStates[id];
    if (!state || state.status !== 'done' || !state.result) return [];
    // Every id here comes from ALGO_ORDER (or a per-stem variant of one), so the
    // result always carries `sections`. The old per-toolId dispatch existed only
    // to narrow the discriminated union; the composite stem ids can't be
    // narrowed that way, so read sections structurally instead.
    const rawSections =
      (state.result.result as { sections?: { time: number; endTime: number; label: string; type: string }[] })
        .sections ?? [];
    if (!rawSections.length) return [];
    // Keep the rendered shape, but pin each section's full original object as
    // `raw` — MSAF carries energy/centroid, lyrics carry per-word fields, etc.,
    // all of which the narrowed type drops but the card should still show.
    const sections = rawSections.map((s) => ({ ...s, raw: s }));
    const gridSource = (state.result.result as { gridSource?: string | null }).gridSource ?? undefined;
    return [{ id, label: algoLabel(id), sections, gridSource }];
  });
}

// ─── Auto-Consensus clustering ────────────────────────────────────────────────

type CentroidMethod = 'mean' | 'median' | 'trimmed' | 'tightest' | 'eqgroup' | 'metamed' | 'plural' | 'nearraw';

// The selectable subset — the same five the Auto-guess panel offers, so a
// config handed between the two panels always has a home on both.
const CENTROID_METHODS: { id: AutoGuessCentroidMethod; short: string; desc: string; example: string }[] = [
  {
    id: 'mean', short: 'Mean',
    desc: 'Arithmetic mean of every raw member time. Fast and symmetric, but one algorithm firing twice pulls the result toward itself.',
    example: 'Sources: 3.0, 3.2, 4.0 → (3.0+3.2+4.0)/3 = 3.4s',
  },
  {
    id: 'eqgroup', short: 'EqGrp',
    desc: 'Gives each algorithm one equal vote, no matter how many boundaries it placed here.',
    example: 'MSAF-SF fires at 3.1s & 3.15s → counts as one rep (3.13s). Foote: 3.3s, allin1: 3.5s → result: (3.13+3.3+3.5)/3 = 3.31s',
  },
  {
    id: 'metamed', short: 'MetaMed',
    desc: 'Computes four internal candidates (median, trimmed-mean, tightest-span, group-equal), then picks whichever is closest to their median — always an actual method\'s output, never a synthetic blend.',
    example: 'Candidates: 3.1, 3.2, 3.4, 3.5 → their median is 3.3 → picks 3.2 (nearest real candidate)',
  },
  {
    id: 'plural', short: 'Plural',
    desc: 'Picks the candidate that agrees with the most others (within 0.5s). Ties broken by proximity to the cluster mean.',
    example: 'Candidates: 3.1, 3.15, 3.4, 3.8 → 3.1 & 3.15 agree with each other (score 2 each); 3.4 and 3.8 are alone (score 1) → picks 3.1 or 3.15',
  },
  {
    id: 'nearraw', short: 'NearRaw',
    desc: 'Returns the actual raw algorithm timestamp with the smallest total distance to every other timestamp in the cluster (L1 minimizer — effectively the median of the raw sources).',
    example: 'Sources: 3.0, 3.2, 4.0 → 3.2 wins: total dist = 0.2+0+0.8 = 1.0, beats 3.0 (1.2) and 4.0 (1.8)',
  },
];

interface ConsensusCluster {
  members: { algorithmId: string; time: number }[];
  times: Record<CentroidMethod, number>;
  size: number;
}

function clusterForConsensus(rows: AlgorithmRow[], toleranceSec: number): ConsensusCluster[] {
  const allPoints = rows.flatMap((r) => r.sections.map((s) => ({ algorithmId: r.id, time: s.time })));
  return clusterPoints(allPoints, toleranceSec).map(({ members }) => ({
    members,
    size: members.length,
    times: computeAllClusterTimes(members),
  }));
}

// ─── Auto-Consensus Panel ─────────────────────────────────────────────────────

const CONSENSUS_OPEN_KEY = 'tc:consensusInspect:open';

const REFERENCE_ROW_LABELS: Record<ReferenceMode, string> = {
  manual: 'Boundaries',
  autoGuess: 'Auto-guess',
};

/** Everything the shared viz panel needs to draw the Consensus row. The stage
 *  computes it; the page parks it on the panel. Kept deliberately small — no
 *  callbacks, no settings — so the row is a picture of a result and every knob
 *  that shapes it stays in this stage. */
export interface ConsensusVizState {
  /** Consensus boundaries, tiled to the next one and typed by verdict
   *  ('hit' / 'miss', or 'consensus' when there is no reference to score). */
  blocks: { time: number; endTime: number; label: string; type: string }[];
  /** Reference boundaries the consensus never matched (FN). */
  refMisses: number[];
  /** Which reference produced those verdicts. */
  referenceLabel: string;
  /** The ± window a match had to land in, in seconds. */
  tolerance: number;
}
function AutoConsensusPanel({
  rows,
  referenceSections,
  referenceMode,
  canSwitchReference,
  duration,
  evalTolerance,
  onToleranceChange,
  customSettings,
  onCustomSettingsChange,
  onVizChange,
  onReferenceModeChange,
  onHandoffToAutoGuess,
}: {
  rows: AlgorithmRow[];
  referenceSections: SectionBlock[];
  referenceMode: ReferenceMode;
  /** Whether the header's reference picker is a dropdown at all — it collapses
   *  to static text when no other source has data. Gates the "switch the
   *  reference" half of the no-reference hint. */
  canSwitchReference: boolean;
  duration: number;
  evalTolerance: number;
  /** τ lives in this panel's control strip, under the preview it redraws —
   *  the stage header keeps only the title and the reference picker. */
  onToleranceChange: (t: number) => void;
  customSettings: CustomEvalSettings;
  onCustomSettingsChange: (next: CustomEvalSettings) => void;
  /** Used by the circularity guard to move the reference off Auto-guess. */
  onReferenceModeChange?: (mode: ReferenceMode) => void;
  /** Open the Auto-guess panel — the config is already parked for it. Omitted
   *  where there is nowhere to go, which hides the hand-off button. */
  onHandoffToAutoGuess?: () => void;
  /** Hand the drawable consensus up to the page, which parks it on the shared
   *  viz panel's Consensus row. Called with null when there is nothing to
   *  draw, and on unmount — the row must not outlive this stage. */
  onVizChange?: (next: ConsensusVizState | null) => void;
}) {
  const [clusterTol, setClusterTol] = useState(3);
  const [minAgreement, setMinAgreement] = useState(2);
  const [method, setMethod] = useState<AutoGuessCentroidMethod>('metamed');
  const [selectedAlgoIds, setSelectedAlgoIds] = useState<Set<string>>(
    () => new Set(rows.filter((r) => !isExampleAlgoId(r.id)).map((r) => r.id)),
  );
  /** Rows the auto-add effect has already offered. Only genuinely *new*
   *  detectors join the selection — one this panel has seen before is left
   *  wherever the user (or a hand-off from Auto-guess) put it. */
  const offeredAlgoIdsRef = useRef<Set<string>>(new Set(rows.map((r) => r.id)));
  /** Set while the incoming config is being applied, so the notice below the
   *  header can say where the numbers came from. */
  const [handoffNotice, setHandoffNotice] = useState(false);

  /** Drawer state, per user rather than per song: somebody tuning a corpus
   *  opens this panel on every track, and re-collapsing it each time is the
   *  kind of small tax that makes a tool feel like it is arguing. Collapsed is
   *  the right first-run default — the verdict is the answer most visits
   *  need. */
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(CONSENSUS_OPEN_KEY) === '1'; } catch { return false; }
  });
  const toggleOpen = useCallback(() => {
    setOpen((prev) => {
      try { localStorage.setItem(CONSENSUS_OPEN_KEY, prev ? '0' : '1'); } catch { /* private mode */ }
      return !prev;
    });
  }, []);

  useEffect(() => {
    setSelectedAlgoIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      // Auto-add newly discovered rows so real detectors light up on arrival —
      // but skip example detectors, which stay opt-in until the user checks them.
      rows.forEach((r) => {
        if (offeredAlgoIdsRef.current.has(r.id)) return;
        offeredAlgoIdsRef.current.add(r.id);
        if (!isExampleAlgoId(r.id) && !next.has(r.id)) { next.add(r.id); changed = true; }
      });
      return changed ? next : prev;
    });
  }, [rows]);

  // ── Incoming hand-off from the Auto-guess panel ("Tune in Consensus") ────
  useConsensusHandoff('consensus', (config) => {
    setClusterTol(config.clusterWindow);
    setMinAgreement(config.minAgreement);
    setMethod(config.centroid);
    // Ids the Auto-guess panel never saw stay out of the blend; the auto-add
    // effect must not put them back.
    config.algoIds.forEach((id) => offeredAlgoIdsRef.current.add(id));
    setSelectedAlgoIds(new Set(config.algoIds));
    setHandoffNotice(true);
  });

  // ── Outgoing hand-off to the Auto-guess panel ───────────────────────────
  // Scoring the consensus against Auto-guess and then *building* Auto-guess
  // from that consensus is circular — the F1 above would be the consensus
  // grading itself. So the button stops and says so first.
  const [confirmCircular, setConfirmCircular] = useState(false);
  const sendToAutoGuess = useCallback(() => {
    sendConsensusConfig('autoGuess', {
      clusterWindow: clusterTol,
      minAgreement,
      centroid: method,
      algoIds: [...selectedAlgoIds],
    });
    setConfirmCircular(false);
    onHandoffToAutoGuess?.();
  }, [clusterTol, minAgreement, method, selectedAlgoIds, onHandoffToAutoGuess]);

  const activeRows = useMemo(() => rows.filter((r) => selectedAlgoIds.has(r.id)), [rows, selectedAlgoIds]);

  const clusters = useMemo(() => clusterForConsensus(activeRows, clusterTol), [activeRows, clusterTol]);
  const filtered = useMemo(() => clusters.filter((c) => new Set(c.members.map((m) => m.algorithmId)).size >= minAgreement), [clusters, minAgreement]);
  const consensusTimes = useMemo(() => filtered.map((c) => c.times[method]), [filtered, method]);

  // mir_eval (server-side, debounced) — strict boundary retrieval against ref.
  const sortedConsensus = useMemo(() => [...consensusTimes].sort((a, b) => a - b), [consensusTimes]);
  const mirPair = useMemo(() => {
    if (!referenceSections.length || !sortedConsensus.length || duration <= 0) return null;
    return {
      refTimes: referenceSections.map((s) => s.time),
      estTimes: sortedConsensus,
      tolerance: evalTolerance,
      trackDuration: duration,
    };
  }, [referenceSections, sortedConsensus, duration, evalTolerance]);
  const { result: evalResult } = useMirEvalSingle(mirPair);

  // Map est/ref boundary times → nearest-neighbor error, used to color
  // consensus blocks (hit/miss) and to overlay green/red ticks on the active
  // reference row. Uses the server's per-boundary nearest-neighbor distances;
  // a marker counts as 'hit' iff its nearest counterpart is within tolerance.
  const estMatch = useMemo(() => {
    const m = new Map<number, number>();
    if (!evalResult) return m;
    sortedConsensus.forEach((t, i) => {
      const err = evalResult.e2tErrors[i];
      if (err !== undefined && err <= evalTolerance) m.set(t, err);
    });
    return m;
  }, [evalResult, sortedConsensus, evalTolerance]);
  const refMatch = useMemo(() => {
    const m = new Map<number, number>();
    if (!evalResult) return m;
    referenceSections.forEach((s, i) => {
      const err = evalResult.t2eErrors[i];
      if (err !== undefined && err <= evalTolerance) m.set(s.time, err);
    });
    return m;
  }, [evalResult, referenceSections, evalTolerance]);

  const consensusBlocks = useMemo(() => {
    const sorted = [...consensusTimes].sort((a, b) => a - b);
    const hasEval = evalResult != null;
    return sorted.map((t, i) => {
      const isHit = estMatch.has(t);
      // No reference loaded → keep neutral 'consensus' blocks (no green/red noise).
      const type = !hasEval ? 'consensus' : isHit ? 'hit' : 'miss';
      const label = !hasEval ? 'C' : isHit ? '✓' : '✗';
      return { time: t, endTime: sorted[i + 1] ?? duration, label, type };
    });
  }, [consensusTimes, duration, estMatch, evalResult]);

  // Reference boundaries the consensus never proposed (FN). They ride the
  // Consensus lane as ticks: the hits are already green tiles there, so only
  // the absences need a mark of their own.
  const refMisses = useMemo<number[]>(() => {
    if (!evalResult) return [];
    return referenceSections.filter((s) => !refMatch.has(s.time)).map((s) => s.time);
  }, [evalResult, referenceSections, refMatch]);

  const referenceLabel = REFERENCE_ROW_LABELS[referenceMode];

  /** Every cluster the window produced, with the agreement count the filter
   *  judges it by — including the ones it drops. The preview draws those in
   *  grey: the discard is exactly what the Agreement slider is choosing, and a
   *  count that silently shrinks is not something anyone can tune against. */
  const previewClusters = useMemo<PreviewCluster[]>(() => {
    const labelOf = new Map(rows.map((r) => [r.id, r.label]));
    return clusters.map((c) => {
      const ids = [...new Set(c.members.map((m) => m.algorithmId))];
      return {
        time: c.times[method],
        agree: ids.length,
        detectors: ids.map((id) => labelOf.get(id) ?? id).sort((a, b) => a.localeCompare(b)),
      };
    });
  }, [clusters, method, rows]);

  /** Reference edges whose nearest consensus boundary landed inside τ. */
  const matchedRefTimes = useMemo(() => new Set(refMatch.keys()), [refMatch]);

  const customEvalResult = useMemo(() => {
    if (!referenceSections.length || !consensusTimes.length || duration <= 0) return null;
    return evaluateCustom(referenceSections, consensusTimes, duration, {
      toleranceSec: evalTolerance,
      optionalWeight: customSettings.optionalWeight,
      useSecondary: customSettings.useSecondary,
    });
  }, [referenceSections, consensusTimes, duration, evalTolerance, customSettings.optionalWeight, customSettings.useSecondary]);

  // Hand the drawn form of the consensus to the page. `null` while there is
  // nothing to draw, and on unmount — leaving the row up after the stage
  // closes would strand a lane no visible control can change.
  useEffect(() => {
    onVizChange?.(consensusBlocks.length
      ? { blocks: consensusBlocks, refMisses, referenceLabel, tolerance: evalTolerance }
      : null);
  }, [onVizChange, consensusBlocks, refMisses, referenceLabel, evalTolerance]);
  useEffect(() => () => onVizChange?.(null), [onVizChange]);

  if (!rows.length) {
    return (
      <div className="py-6 flex flex-col items-center gap-3">
        <p className="text-xs text-gray-600 text-center">
          No algorithm results loaded yet. Open the <span className="text-violet-300">Algorithms</span> sidebar on the right and click <span className="text-violet-300">▶ Run for this song</span> to generate consensus boundaries.
        </p>
      </div>
    );
  }

  const totalAlgos = activeRows.length;
  const centroidShort = CENTROID_METHODS.find((m) => m.id === method)?.short ?? method;
  const verdict = consensusVerdict({
    detectorsSelected: totalAlgos,
    clusterCount: filtered.length,
    minAgreement,
    clusterWindow: clusterTol,
    referenceLabel,
    referenceCount: referenceSections.length,
    canSwitchReference,
    // mir_eval is called with trim=True (the MIREX convention), so the [0, T]
    // anchors it drops are not in the counts the metrics line reports. The
    // sentence has to quote the same ones, or it contradicts the numbers
    // directly beneath it.
    scoredEst: evalResult?.estCount ?? null,
    scoredRef: evalResult?.refCount ?? null,
    hits: evalResult ? evalResult.hitCount : null,
    tolerance: evalTolerance,
  });

  return (
    <div className="rounded-lg border border-violet-800/40 bg-violet-950/20 p-3 space-y-3">
      {handoffNotice && (
        <p className="text-[11px] text-cyan-300/90 flex items-center gap-2">
          Loaded from the Auto-guess panel — tune them against the scores, then send them back.
          <button
            onClick={() => setHandoffNotice(false)}
            className="text-slate-500 hover:text-slate-300 transition-colors"
            title="Dismiss"
          >✕</button>
        </p>
      )}

      {/* ── The verdict: what the whole panel is for, in one sentence ──────
           The reference is named once, up in the stage header's "Evaluate vs"
           dropdown, so nothing here repeats it as a banner. Percentages are
           left to the metrics line: at the extremes ("F1 0%") they read as a
           broken widget, where "none of 54" reads as an answer. */}
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-[13px] leading-snug text-gray-200">{verdict.head}</p>
          {verdict.sub && <p className="text-[11px] text-gray-500 mt-1">{verdict.sub}</p>}
        </div>
        {/* The thumbnail IS the preview, at a sixth of the size — so it only
            earns its space while the preview itself is folded away. */}
        {!open && (
          <MiniTilings
            duration={duration}
            blocks={consensusBlocks}
            referenceSections={referenceSections}
            matchedRefTimes={matchedRefTimes}
          />
        )}
      </div>

      {/* ── The drawer handle, and the one action that does not need it ──── */}
      <div className="flex items-stretch gap-2">
        <button
          onClick={toggleOpen}
          aria-expanded={open}
          className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-md border text-[11.5px] transition-colors ${
            open
              ? 'bg-violet-500/10 border-violet-400/35 text-violet-100'
              : 'bg-white/[0.035] border-white/[0.12] text-slate-300 hover:bg-violet-500/[0.09] hover:border-violet-400/40'
          }`}
          title={open ? 'Collapse the tuning controls' : 'Open the consensus preview and its parameters'}
        >
          <span className="text-violet-400 text-[10px] w-2.5">{open ? '▾' : '▸'}</span>
          <span className="font-medium">{open ? 'Hide the controls' : 'Tune the consensus'}</span>
          <span className="flex-1" />
          {/* Printed here only while they are out of sight. Open, the sliders
              below carry them, and repeating them is the duplication this
              rebuild set out to remove. */}
          {!open && (
            <span className="text-[10.5px] font-mono tabular-nums text-slate-500">
              ±{clusterTol}s · {centroidShort} · ≥{minAgreement} of {totalAlgos} · τ {evalTolerance}s
            </span>
          )}
        </button>

        {onHandoffToAutoGuess && (
          confirmCircular ? (
            <span className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono text-amber-400">
                Scored against Auto-guess — building it from this is circular.
              </span>
              <button
                onClick={() => { onReferenceModeChange?.('manual'); setConfirmCircular(false); }}
                className="px-2 py-1 rounded text-[10px] uppercase tracking-wider bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 transition-colors"
                title="Score the consensus against your Boundaries layer instead, then read the numbers again"
              >Use Boundaries</button>
              <button
                onClick={sendToAutoGuess}
                className="px-2 py-1 rounded text-[10px] uppercase tracking-wider bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 border border-amber-400/40 transition-colors"
              >Send anyway</button>
            </span>
          ) : (
            <button
              onClick={() => {
                if (referenceMode === 'autoGuess') { setConfirmCircular(true); return; }
                sendToAutoGuess();
              }}
              disabled={totalAlgos === 0}
              className="px-3 py-1.5 rounded-md text-[11px] uppercase tracking-wider bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/40 disabled:opacity-40 disabled:cursor-not-allowed text-cyan-100 transition-colors flex items-center gap-1.5 shrink-0"
              title={totalAlgos === 0
                ? 'Select at least one algorithm'
                : `Open the Auto-guess panel with these parameters — ±${clusterTol}s, ≥${minAgreement}, ${centroidShort}, ${totalAlgos} detector${totalAlgos === 1 ? '' : 's'}`}
            >
              <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 3a1 1 0 011 1v9.586l2.293-2.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 111.414-1.414L9 13.586V4a1 1 0 011-1z" clipRule="evenodd" />
              </svg>
              Use for Auto-guess
            </button>
          )
        )}
      </div>

      {/* ── The instrument ────────────────────────────────────────────────
           A slider that moves a number you cannot see is guesswork, so the
           parameters sit directly under the picture they redraw. */}
      {open && (
        <div className="space-y-3">
          <ConsensusPreviewLane
            duration={duration}
            blocks={consensusBlocks}
            clusters={previewClusters}
            minAgreement={minAgreement}
            totalDetectors={totalAlgos}
            clusterWindow={clusterTol}
            referenceSections={referenceSections}
            referenceLabel={referenceLabel}
            matchedRefTimes={matchedRefTimes}
            tolerance={evalTolerance}
          />

          <div className="flex items-center gap-x-3.5 gap-y-2 flex-wrap">
            <SliderControl
              label="Match within"
              title="τ — how far a consensus boundary may sit from one of your edges and still count as a match."
              min={0.25} max={5} step={0.25}
              value={evalTolerance}
              onChange={onToleranceChange}
              format={(v) => `±${v}s`}
              valueWidth="w-12"
            />
            <SliderControl
              label="Group within"
              title="Cluster window — detector boundaries closer together than this are treated as one proposed boundary. Widen it and nearby detectors merge into fewer, better-agreed boundaries."
              min={0.5} max={10} step={0.5}
              value={clusterTol}
              onChange={setClusterTol}
              format={(v) => `±${v}s`}
              valueWidth="w-12"
            />
            <SliderControl
              label="Keep if"
              title="Agreement threshold — a grouped boundary only enters the consensus when at least this many distinct detectors proposed it."
              min={1} max={Math.max(1, totalAlgos)} step={1}
              value={Math.min(minAgreement, Math.max(1, totalAlgos))}
              onChange={setMinAgreement}
              format={(v) => `≥${v} of ${totalAlgos}`}
              valueWidth="w-16"
            />

            {/* Centroid rejoins the popover: five buttons for a setting that is
                chosen once a session cost more of the strip than the three
                sliders that are moved constantly. */}
            <ConsensusClusterControls
              variant="detectors"
              buttonSuffix={centroidShort}
              selectedCount={totalAlgos}
              algoRows={rows.map((r) => ({ id: r.id, displayLabel: r.label, count: r.sections.length }))}
              selectedAlgoIds={selectedAlgoIds}
              onSelectedAlgoIdsChange={setSelectedAlgoIds}
              clusterWindow={clusterTol}
              onClusterWindowChange={setClusterTol}
              centroidMethod={method}
              onCentroidMethodChange={setMethod}
              centroidOptions={CENTROID_METHODS.map((m) => ({ id: m.id, short: m.short, description: m.desc, example: m.example }))}
              minConsensus={minAgreement}
              onMinConsensusChange={setMinAgreement}
              minConsensusLabel="Min agreement"
              popoverAlign="right"
              extraPopoverSection={
                <div className="pt-3 border-t border-white/[0.06] space-y-2">
                  <span className="text-[10px] uppercase tracking-wider text-amber-400">Custom eval</span>
                  <CustomEvalControls settings={customSettings} onChange={onCustomSettingsChange} compact />
                </div>
              }
            />
          </div>

          {/* ── Both evaluators on one line: labelled, unboxed, and quiet
               enough that they confirm the verdict instead of competing with
               it. They disagree on purpose — strict retrieval vs. the
               optional-weighted one — so each says which it is. ── */}
          {(evalResult || customEvalResult) && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 pt-2 border-t border-white/[0.06] text-[11px] font-mono tabular-nums text-slate-400">
              {evalResult && (
                <span title="Strict mir_eval boundary retrieval — no importance weighting.">
                  <span className="text-[9.5px] uppercase tracking-wider text-slate-600 mr-1.5">mir_eval</span>
                  P {fmtPct(evalResult.precision)} · R {fmtPct(evalResult.recall)} · F1 {fmtPct(evalResult.fmeasure)}
                </span>
              )}
              {customEvalResult && (
                <span title={`Custom evaluator — optional weight ${customSettings.optionalWeight.toFixed(2)}, candidate alternates ${customSettings.useSecondary ? 'on' : 'off'}. Adds MNBD and CSR.`}>
                  <span className="text-[9.5px] uppercase tracking-wider text-amber-400/70 mr-1.5">custom</span>
                  P {fmtPct(customEvalResult.precision)} · R {fmtPct(customEvalResult.recall)} · F1 {fmtPct(customEvalResult.f1)}
                  {' · '}MNBD {customEvalResult.mnbd.toFixed(2)}s · CSR {fmtPct(customEvalResult.csr)}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Verdict, mini tilings, slider ────────────────────────────────────────────

function fmtPct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

/** The panel's headline. Every branch is a real state the panel can be in —
 *  no detectors, nothing above the threshold, no reference to score against,
 *  a server round-trip still in flight — because an empty panel with a stale
 *  number in it is the version people misread. */
function consensusVerdict(p: {
  detectorsSelected: number;
  clusterCount: number;
  minAgreement: number;
  clusterWindow: number;
  referenceLabel: string;
  referenceCount: number;
  /** Whether another reference source is actually on offer — see the panel prop. */
  canSwitchReference: boolean;
  /** Boundary counts as the scorer saw them (post-trim), when it has answered. */
  scoredEst: number | null;
  scoredRef: number | null;
  hits: number | null;
  tolerance: number;
}): { head: ReactNode; sub: string } {
  const est = p.scoredEst ?? p.clusterCount;
  const refs = p.scoredRef ?? p.referenceCount;
  const n = <span className="font-mono font-semibold text-gray-100">{est}</span>;
  if (p.detectorsSelected === 0) {
    return { head: 'No detectors are feeding the consensus.', sub: 'Open the controls and pick at least one.' };
  }
  if (p.clusterCount === 0) {
    return {
      head: <>No clusters reach <span className="font-mono font-semibold text-gray-100">≥{p.minAgreement}</span> agreeing detectors at a <span className="font-mono font-semibold text-gray-100">{p.clusterWindow}s</span> window.</>,
      sub: 'Widen the window or lower the agreement threshold.',
    };
  }
  if (p.referenceCount === 0) {
    return {
      head: <>{n} consensus boundaries, with no {p.referenceLabel} layer to score them against.</>,
      sub: p.canSwitchReference
        ? 'Annotate a section edge, or switch the reference in "Evaluate vs" above.'
        : 'Annotate a section edge to score them against.',
    };
  }
  if (p.hits === null) {
    return { head: <>Scoring {n} consensus boundaries against {p.referenceLabel}…</>, sub: '' };
  }
  const edges = `${refs} edge${refs === 1 ? '' : 's'}`;
  if (p.hits === 0) {
    return {
      head: <><span className="font-mono font-semibold text-red-400">None</span> of the {n} consensus boundaries land within <span className="font-mono font-semibold text-gray-100">±{p.tolerance}s</span> of the {edges} in your {p.referenceLabel} layer.</>,
      sub: `Every edge was missed. Try a wider window, or a larger τ.${
        p.detectorsSelected >= 6 && p.minAgreement <= 2
          ? ` ${p.detectorsSelected} detectors at ≥${p.minAgreement} is close to unfiltered.`
          : ''}`,
    };
  }
  const recall = refs ? p.hits / refs : 0;
  const missed = refs - p.hits;
  return {
    head: <><span className={`font-mono font-semibold ${recall >= 0.6 ? 'text-green-400' : 'text-yellow-400'}`}>{p.hits} of {refs}</span> {p.referenceLabel} edges are matched by the {n} consensus boundaries, within <span className="font-mono font-semibold text-gray-100">±{p.tolerance}s</span>.</>,
    sub: `${missed ? `${missed} edge${missed === 1 ? '' : 's'} missed` : 'Every edge matched'} · ${est - p.hits} consensus boundaries with no match.`,
  };
}

/** The collapsed state's picture: the same two tilings the preview draws, at
 *  a sixth of the size, so opening the drawer reads as a zoom rather than a
 *  switch to some other surface. */
function MiniTilings({
  duration,
  blocks,
  referenceSections,
  matchedRefTimes,
}: {
  duration: number;
  blocks: { time: number; endTime: number; type: string }[];
  referenceSections: SectionBlock[];
  matchedRefTimes: Set<number>;
}) {
  if (duration <= 0) return null;
  const w = (from: number, to: number) => `${Math.max(0.2, ((to - from) / duration) * 100)}%`;
  const x = (t: number) => `${Math.max(0, Math.min(100, (t / duration) * 100))}%`;
  return (
    <div className="w-[168px] shrink-0 hidden sm:block">
      <div className="relative h-2.5 rounded-sm bg-white/[0.03] overflow-hidden">
        {blocks.map((b) => (
          <span
            key={b.time}
            className="absolute top-0 bottom-0"
            style={{
              left: x(b.time), width: w(b.time, b.endTime),
              background: b.type === 'hit' ? 'rgba(34,197,94,0.55)' : b.type === 'miss' ? 'rgba(239,68,68,0.4)' : 'rgba(139,92,246,0.4)',
              boxShadow: 'inset 1px 0 0 rgba(255,255,255,0.22)',
            }}
          />
        ))}
      </div>
      <div className="relative h-2.5 rounded-sm bg-white/[0.03] overflow-hidden mt-0.5">
        {referenceSections.map((s, i) => (
          <span
            key={s.time}
            className="absolute top-0 bottom-0"
            style={{
              left: x(s.time), width: w(s.time, sectionEnd(referenceSections, i, duration)),
              background: 'rgba(139,92,246,0.4)',
              boxShadow: `inset 2px 0 0 ${matchedRefTimes.has(s.time) ? '#22c55e' : '#ef4444'}`,
            }}
          />
        ))}
      </div>
      <p className="text-[9px] font-mono uppercase tracking-wider text-slate-600 text-right mt-1">consensus / yours</p>
    </div>
  );
}

function SliderControl({
  label, title, min, max, step, value, onChange, format, valueWidth = 'w-9',
}: {
  label: string;
  title: string;
  min: number; max: number; step: number;
  value: number;
  onChange: (n: number) => void;
  format: (n: number) => string;
  /** Widened for the labels that carry a unit or a denominator. */
  valueWidth?: string;
}) {
  return (
    <div className="flex items-center gap-1.5" title={title}>
      <span className="text-[10px] uppercase tracking-wider text-slate-500">{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-16 accent-violet-500"
        aria-label={title}
      />
      <span className={`text-[11px] font-mono tabular-nums text-violet-300 ${valueWidth} text-right`}>{format(value)}</span>
    </div>
  );
}

// ─── AlgoInspectStage — thin wrapper around AutoConsensusPanel ────────────────

export interface AlgoInspectStageProps {
  annotationRows: AlgorithmRow[];
  manualSections: SectionBlock[];
  autoGuessSections?: SectionBlock[];
  /** Whether the Auto-guess reference layer is currently shown (the
   *  same viz-panel visibility toggle, off by default). When off, its
   *  eval-reference option is hidden here too — the user opts in from the
   *  viz panel before they can score consensus against it. */
  showAutoGuess?: boolean;
  duration: number;
  tolerance: number;
  onToleranceChange: (t: number) => void;
  /** Hand the drawable consensus up to the page, which parks it on the shared
   *  viz panel's Consensus row — cursor, seeking and the preview band all come
   *  from the timeline there, so this stage no longer draws a lane of its own.
   *  Called with null when there is nothing to draw, and on unmount. */
  onConsensusVizChange?: (next: ConsensusVizState | null) => void;
  /** Switch the workspace to the Annotator's Auto-guess panel. The consensus
   *  parameters are parked for it first (see state/consensusHandoff). Omit and
   *  the hand-off button doesn't render. */
  onHandoffToAutoGuess?: () => void;
  /** Rendered at the left of this stage's reference row. The page puts the
   *  "Reference from" annotator picker here so it shares one line with
   *  "Evaluate vs" — whose annotations are the truth, and which of their
   *  layers — instead of each getting a near-empty row of its own. */
  leading?: ReactNode;
}

export function AlgoInspectStage({
  annotationRows,
  manualSections,
  autoGuessSections = [],
  showAutoGuess = true,
  duration,
  tolerance,
  onToleranceChange,
  onConsensusVizChange,
  onHandoffToAutoGuess,
  leading,
}: AlgoInspectStageProps) {
  const [referenceMode, setReferenceMode] = useState<ReferenceMode>('manual');
  const [customSettings, setCustomSettings] = useState<CustomEvalSettings>(DEFAULT_CUSTOM_EVAL_SETTINGS);

  const autoGuessAvailable = showAutoGuess && autoGuessSections.length > 0;

  // Fall back to manual if the chosen reference disappears (e.g. the Auto-guess
  // show toggle is turned off while that reference was selected).
  useEffect(() => {
    if (referenceMode === 'autoGuess' && !autoGuessAvailable && manualSections.length) setReferenceMode('manual');
  }, [referenceMode, autoGuessAvailable, manualSections.length]);

  const referenceSections = useMemo(() => {
    if (referenceMode === 'autoGuess') return autoGuessSections;
    return manualSections;
  }, [referenceMode, manualSections, autoGuessSections]);

  /** The sources the picker can offer, and whether any of them is an actual
   *  alternative to the current one. The picker collapses to plain text when
   *  none is, so every hint that says "switch the reference" has to ask this
   *  first or it points at a control that isn't rendered. */
  const referenceOptions = useMemo(() => [
    { mode: 'manual' as const, hasData: manualSections.length > 0 },
    ...(showAutoGuess ? [{ mode: 'autoGuess' as const, hasData: autoGuessSections.length > 0 }] : []),
  ], [manualSections.length, showAutoGuess, autoGuessSections.length]);
  const canSwitchReference = referenceOptions.some((o) => o.hasData && o.mode !== referenceMode);

  return (
    <div className="space-y-3">
      {/* No heading here — the lit sub-tab directly above already says
          "Consensus Inspect", and printing it twice made one workspace look
          like two panels. What this row carries is the thing the tab can't:
          which reference every number below is measured against. */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center">{leading}</div>

        <div className="flex items-center justify-end gap-3 flex-wrap">
          <InfoDot label="What Consensus Inspect does" align="right">
            Aggregates the checked detectors&apos; boundaries into one consensus and scores it against the chosen reference.
          </InfoDot>

          <EvalReferenceDropdown
            value={referenceMode}
            onChange={setReferenceMode}
            options={referenceOptions}
          />
        </div>
      </div>

      <AutoConsensusPanel
        rows={annotationRows}
        referenceSections={referenceSections}
        referenceMode={referenceMode}
        canSwitchReference={canSwitchReference}
        duration={duration}
        evalTolerance={tolerance}
        onToleranceChange={onToleranceChange}
        customSettings={customSettings}
        onCustomSettingsChange={setCustomSettings}
        onVizChange={onConsensusVizChange}
        onReferenceModeChange={setReferenceMode}
        onHandoffToAutoGuess={onHandoffToAutoGuess}
      />
    </div>
  );
}
