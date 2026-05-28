import type { ManualSection, SectionImportance } from '../types/manualAnnotation';
import type {
  CueItem,
  SpanItem,
  LoopItem,
  PatternItem,
  LyricsItem,
  LayerEvalMode,
} from '../types/annotationLayer';

// ─── Input types ─────────────────────────────────────────────────────────────

export interface ManualSectionInput {
  time: number;
  importance?: SectionImportance;
  candidates?: number[];
}

export interface PredSection {
  time: number;
  endTime: number;
}

export const DEFAULT_OPTIONAL_WEIGHT = 0.5;
export const DEFAULT_USE_SECONDARY = true;
export const DEFAULT_TOLERANCE_SEC = 3;

/** Default tolerance window when scoring CUE predictions against a CUE reference.
 *  Cues are sub-second perceptual events (kick hits, FX triggers), so the
 *  window is two orders of magnitude tighter than boundary eval. Per-kind
 *  overrides (e.g. 50 ms for onsets, 200 ms for claps) are passed explicitly. */
export const DEFAULT_CUE_TOLERANCE_SEC = 0.1;

/** Frame resolution for SPAN frame-level F1. 100 ms matches the
 *  evaluation_notes.md recommendation; tight enough to catch real misses
 *  on voicing edges, loose enough that quantization noise doesn't dominate. */
export const DEFAULT_SPAN_FRAME_SEC = 0.1;

/** Cue tolerance applied when scoring SPAN onsets/offsets — each interval edge
 *  is treated as a point event. 100 ms matches the cue default; per-kind
 *  overrides accepted via opts.onsetToleranceSec. */
export const DEFAULT_SPAN_ONSET_TOLERANCE_SEC = DEFAULT_CUE_TOLERANCE_SEC;

/** Word-level lyrics tolerance — 50 ms per the eval contract. */
export const DEFAULT_LYRICS_TOLERANCE_SEC = 0.05;

// ─── Enriched manual section ────────────────────────────────────────────────────

export interface ManualSectionWithDurs {
  time: number;
  candidates?: number[];
  importance: 'critical' | 'optional';
  endTime: number;      // immediate next section start (or trackDuration)
  /**
   * durations[0] = time to immediate next section
   * durations[1] = time to section after that (only if previous was optional)
   * ...
   * last entry   = time to next critical section (stop condition, inclusive)
   *
   * If there is no following section, one entry: trackDuration - time.
   */
  durations: number[];
}

/**
 * For each manual section, build a list of durations walking forward until
 * hitting (and including) the next critical section.
 */
export function attachDurations(
  manual: ManualSectionInput[],
  trackDuration: number,
): ManualSectionWithDurs[] {
  return manual.map((g, j) => {
    const durations: number[] = [];
    for (let k = j + 1; k < manual.length; k++) {
      durations.push(manual[k].time - g.time);
      if (manual[k].importance !== 'optional') break; // critical hit — stop inclusive
    }
    if (durations.length === 0) {
      durations.push(trackDuration - g.time); // last section in track
    }
    return {
      time: g.time,
      candidates: g.candidates,
      importance: g.importance === 'optional' ? 'optional' : 'critical',
      endTime: manual[j + 1]?.time ?? trackDuration,
      durations,
    };
  });
}

// ─── Per-match duration result ────────────────────────────────────────────────

export interface DurationMatchResult {
  predTime: number;
  manualTime: number;
  boundaryDist: number;         // |pred.time - manual.time|
  predDur: number;
  manualDurations: number[];      // full list (see attachDurations)
  durationErrors: number[];     // |predDur - manualDurations[k]| for each k
  errBest: number;              // min across all durations
  manualImportance: 'critical' | 'optional';
}

// ─── Per-algorithm evaluation result ─────────────────────────────────────────

export interface AlgoEvalResult {
  /** Mean Nearest-Boundary Distance (seconds, lower = better).
   *  Weighted: optional manual matches count 0.5. */
  mnbd: number;

  /** Critical Section Recall — fraction of critical manual sections hit within τ. */
  csr: number;

  /** Boundary F-measure (weighted recall, standard tolerance window). */
  f1: number;
  precision: number;
  recall: number;   // weighted recall (critical=1.0, optional=0.5)

  /** Mean Duration Error — best interpretation per match (seconds, lower = better). */
  mde_best: number;
  /** Mean Duration Error — vs immediate next section (durations[0]). */
  mde_0: number;
  /** Mean Duration Error — vs next critical section (durations[last]). */
  mde_last: number;

  /** Full per-section match detail. */
  durationMatches: DurationMatchResult[];

  toleranceSec: number;

  /** Number of predictions that hit at least one manual within τ. */
  hitCount: number;
  /** Total predictions. */
  estCount: number;
  /** Total manual sections. */
  refCount: number;
  /** Number of critical manual sections (denominator of CSR). */
  criticalCount: number;

  /** The optional weight used for this evaluation. */
  optionalWeight: number;
  /** Whether candidate alternates were considered. */
  useSecondary: boolean;
}

// ─── Core evaluation ──────────────────────────────────────────────────────────

/** Minimum distance from a predicted time to any valid start of a manual section.
 *  When useSecondary=false, only the primary time (g.time) is considered. */
function manualDist(pTime: number, g: ManualSectionWithDurs, useSecondary: boolean): number {
  const allTimes = useSecondary ? [g.time, ...(g.candidates ?? [])] : [g.time];
  return Math.min(...allTimes.map((t) => Math.abs(pTime - t)));
}

/** The closest valid start time of manual section g to a predicted time.
 *  When useSecondary=false, always returns g.time. */
function closestManualTime(pTime: number, g: ManualSectionWithDurs, useSecondary: boolean): number {
  const allTimes = useSecondary ? [g.time, ...(g.candidates ?? [])] : [g.time];
  return allTimes.reduce((best, t) => Math.abs(pTime - t) < Math.abs(pTime - best) ? t : best);
}

export function evaluateAlgorithm(
  predicted: PredSection[],
  manual: ManualSectionWithDurs[],
  toleranceSec: number = DEFAULT_TOLERANCE_SEC,
  useSecondary: boolean = DEFAULT_USE_SECONDARY,
  optionalWeight: number = DEFAULT_OPTIONAL_WEIGHT,
): AlgoEvalResult {
  const criticalCount = manual.filter((g) => g.importance === 'critical').length;
  const empty: AlgoEvalResult = {
    mnbd: 0, csr: 1, f1: 0, precision: 0, recall: 0,
    mde_best: 0, mde_0: 0, mde_last: 0, durationMatches: [], toleranceSec,
    hitCount: 0, estCount: predicted.length, refCount: manual.length,
    criticalCount, optionalWeight, useSecondary,
  };
  if (!predicted.length || !manual.length) return empty;

  // ── MNBD ──────────────────────────────────────────────────────────────────
  let distSum = 0;
  for (const p of predicted) {
    const nearest = manual.reduce((best, g) => manualDist(p.time, g, useSecondary) < manualDist(p.time, best, useSecondary) ? g : best);
    const w = nearest.importance === 'optional' ? optionalWeight : 1.0;
    distSum += w * manualDist(p.time, nearest, useSecondary);
  }
  const mnbd = distSum / predicted.length;

  // ── Duration matches ───────────────────────────────────────────────────────
  const durationMatches: DurationMatchResult[] = predicted.map((p) => {
    const nearest = manual.reduce((best, g) => manualDist(p.time, g, useSecondary) < manualDist(p.time, best, useSecondary) ? g : best);
    const matchedTime = closestManualTime(p.time, nearest, useSecondary);
    const predDur = p.endTime - p.time;
    const durationErrors = nearest.durations.map((d) => Math.abs(predDur - d));
    return {
      predTime: p.time,
      manualTime: matchedTime,
      boundaryDist: Math.abs(p.time - matchedTime),
      predDur,
      manualDurations: nearest.durations,
      durationErrors,
      errBest: Math.min(...durationErrors),
      manualImportance: nearest.importance,
    };
  });

  const mde_best = durationMatches.reduce((s, m) => s + m.errBest, 0) / durationMatches.length;
  const mde_0    = durationMatches.reduce((s, m) => s + m.durationErrors[0], 0) / durationMatches.length;
  const mde_last = durationMatches.reduce((s, m) => s + m.durationErrors[m.durationErrors.length - 1], 0) / durationMatches.length;

  // ── Critical Section Recall ────────────────────────────────────────────────
  const critical = manual.filter((g) => g.importance === 'critical');
  const critHits = critical.filter((g) =>
    predicted.some((p) => manualDist(p.time, g, useSecondary) <= toleranceSec),
  );
  const csr = critical.length ? critHits.length / critical.length : 1;

  // ── Boundary F-measure ─────────────────────────────────────────────────────
  const hitByPred = predicted.filter((p) =>
    manual.some((g) => manualDist(p.time, g, useSecondary) <= toleranceSec),
  );
  const precision = predicted.length ? hitByPred.length / predicted.length : 0;

  const recallNum = manual.reduce((s, g) => {
    const w = g.importance === 'optional' ? optionalWeight : 1.0;
    const hit = predicted.some((p) => manualDist(p.time, g, useSecondary) <= toleranceSec) ? 1 : 0;
    return s + w * hit;
  }, 0);
  const recallDen = manual.reduce((s, g) => s + (g.importance === 'optional' ? optionalWeight : 1.0), 0);
  const recall = recallDen ? recallNum / recallDen : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    mnbd, csr, f1, precision, recall,
    mde_best, mde_0, mde_last,
    durationMatches, toleranceSec,
    hitCount: hitByPred.length,
    estCount: predicted.length,
    refCount: manual.length,
    criticalCount,
    optionalWeight, useSecondary,
  };
}

// ─── UI-friendly wrapper ─────────────────────────────────────────────────────

export interface CustomEvalOptions {
  toleranceSec?: number;
  optionalWeight?: number;
  useSecondary?: boolean;
}

/**
 * Evaluate an algorithm against a list of ManualSections that may carry
 * `importance` ('optional'/'critical') and `candidates` (alternative valid
 * start times). Builds enriched durations internally and forwards to
 * `evaluateAlgorithm`. The estimated boundaries only need a `time`; their
 * `endTime` falls back to the next prediction's time (or trackDuration).
 */
export function evaluateCustom(
  refSections: ManualSection[],
  estTimes: number[],
  trackDuration: number,
  opts: CustomEvalOptions = {},
): AlgoEvalResult {
  const enriched = attachDurations(
    refSections.map((s) => ({
      time: s.time,
      importance: s.importance,
      candidates: s.candidates,
    })),
    trackDuration,
  );
  const sortedEst = [...estTimes].sort((a, b) => a - b);
  const predicted: PredSection[] = sortedEst.map((t, i) => ({
    time: t,
    endTime: sortedEst[i + 1] ?? trackDuration,
  }));
  return evaluateAlgorithm(
    predicted,
    enriched,
    opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC,
    opts.useSecondary ?? DEFAULT_USE_SECONDARY,
    opts.optionalWeight ?? DEFAULT_OPTIONAL_WEIGHT,
  );
}

// ─── Cue eval ────────────────────────────────────────────────────────────────

/** Per-result metadata distinguishing boundary-style eval from cue-style eval.
 *  Boundary-specific columns (csr, mde_*) should be hidden by the UI when
 *  mode === 'cue', since cues are points without section duration semantics. */
export type EvalMode = 'boundary' | 'cue';

/** Score predicted CUE timestamps against a CUE reference layer.
 *
 *  Reuses `evaluateAlgorithm` under the hood — cues are point events with no
 *  candidates and no importance gradation, so they collapse onto the
 *  boundary-style scorer cleanly. The only difference is the tolerance
 *  default (100 ms vs 3 s) and the semantic note that duration-based
 *  metrics (mde_*, csr) are not meaningful for cues.
 *
 *  Pass `toleranceSec` per-kind for tighter scoring: 50 ms for raw onsets,
 *  100 ms for kicks, 200 ms for claps (rule of thumb — adjust empirically).
 */
export function evaluateCueLayer(
  reference: CueItem[],
  predicted: CueItem[],
  trackDuration: number,
  toleranceSec: number = DEFAULT_CUE_TOLERANCE_SEC,
): AlgoEvalResult {
  // Build a synthetic ManualSection[] from cue items so we can reuse
  // evaluateCustom verbatim. Every cue is treated as a critical, candidate-
  // free section starting at its timestamp.
  const refSections: ManualSection[] = reference.map((c) => ({
    time: c.time,
    type: 'default',
    label: c.label,
    importance: 'critical' as const,
    candidates: [],
  }));
  const predTimes = predicted.map((c) => c.time);
  return evaluateCustom(refSections, predTimes, trackDuration, {
    toleranceSec,
    useSecondary: false,           // cues don't carry alternates
    optionalWeight: 1,             // all cues weighted equally
  });
}

// ─── Span eval (Phase 2 of the integration plan) ─────────────────────────────

/** Tuple representing one valid `[start, end]` interval. Shared by SpanItem,
 *  LoopItem, PatternItem candidates. */
export type SpanInterval = [number, number];

/** Result of scoring SPAN-family predictions against a SPAN reference.
 *  The four metrics are roughly orthogonal:
 *  - `meanIoU`  — interval overlap quality of matched pairs (Jaccard).
 *  - `frameP/R/F1` — voicing-mask agreement after rasterising at 100 ms.
 *  - `onsetF1` / `offsetF1` — edge alignment, treated as cues at the same
 *    tolerance as a CUE eval (default 100 ms).
 *  - `coverage` — total covered ground-truth duration ÷ total ref duration;
 *    sanity check for over- / under-prediction.
 *  See deep_research/evaluation_notes.md for the contract this implements. */
export interface SpanEvalResult {
  meanIoU: number;
  frameP: number;
  frameR: number;
  frameF1: number;
  onsetF1: number;
  offsetF1: number;
  coverage: number;
  refCount: number;
  estCount: number;
  /** Number of (ref, est) pairs that overlapped at all (IoU > 0). */
  matchedPairs: number;
  /** Mode used (echoed back to consumers so the UI can adjust copy). */
  mode: LayerEvalMode;
  toleranceSec: number;
  frameSec: number;
}

/** Resolve the evaluation mode for a region layer (spans / loops / patterns).
 *  The global `evalRegionLayersAsCandidates` Setting, when ON, forces every
 *  region layer to `'multiple-candidates'` regardless of its per-layer picker —
 *  the annotator wants any item in the layer to count as a valid alternative of
 *  the same underlying event. When OFF, the layer's own `mode` wins (defaulting
 *  to `'full-annotation'` for pre-Phase-2 documents that lack the field). */
export function effectiveLayerMode(
  layerMode: LayerEvalMode | undefined,
  forceCandidates: boolean,
): LayerEvalMode {
  if (forceCandidates) return 'multiple-candidates';
  return layerMode ?? 'full-annotation';
}

export interface SpanEvalOptions {
  /** Per-layer evaluation mode. Defaults to `'full-annotation'`. */
  mode?: LayerEvalMode;
  /** Frame resolution for the binary voicing-mask F1. Default 100 ms. */
  frameSec?: number;
  /** Edge tolerance for onset/offset F1. Default 100 ms (same as cues). */
  toleranceSec?: number;
}

const EMPTY_SPAN_RESULT: Omit<SpanEvalResult, 'refCount' | 'estCount' | 'mode' | 'toleranceSec' | 'frameSec'> = {
  meanIoU: 0, frameP: 0, frameR: 0, frameF1: 0,
  onsetF1: 0, offsetF1: 0, coverage: 0, matchedPairs: 0,
};

/** Jaccard intersection-over-union for two `[start, end]` intervals.
 *  Returns 0 when intervals don't overlap or either is degenerate. */
export function intervalIoU(a: SpanInterval, b: SpanInterval): number {
  const interStart = Math.max(a[0], b[0]);
  const interEnd   = Math.min(a[1], b[1]);
  const interLen   = Math.max(0, interEnd - interStart);
  const unionLen   = (a[1] - a[0]) + (b[1] - b[0]) - interLen;
  return unionLen > 0 ? interLen / unionLen : 0;
}

/** Best IoU achievable between a single ref span and any of its candidate
 *  alternates, against one prediction. Mirrors `manualDist` for boundaries —
 *  the "candidate" treatment is per-item (alternates within one annotation),
 *  distinct from the layer-level `multiple-candidates` mode. */
function bestIoUWithCandidates(
  ref: { start: number; end: number; candidates?: SpanInterval[] },
  est: SpanInterval,
): number {
  const all: SpanInterval[] = [[ref.start, ref.end], ...(ref.candidates ?? [])];
  return Math.max(...all.map((iv) => intervalIoU(iv, est)));
}

/** Rasterise a set of spans onto a binary mask at `frameSec` resolution.
 *  Overlapping spans collapse onto the same `true` cells (voicing is a single
 *  binary track; multi-label SPAN evaluation would need a per-label mask, which
 *  is out of scope for Phase 2's voicing-first metric). */
function rasterise(spans: SpanInterval[], trackDuration: number, frameSec: number): Uint8Array {
  const nFrames = Math.max(1, Math.ceil(trackDuration / frameSec));
  const mask = new Uint8Array(nFrames);
  for (const [s, e] of spans) {
    const i0 = Math.max(0, Math.floor(s / frameSec));
    const i1 = Math.min(nFrames, Math.ceil(e / frameSec));
    for (let i = i0; i < i1; i++) mask[i] = 1;
  }
  return mask;
}

/** Score SPAN predictions against a SPAN reference layer.
 *
 *  Greedy matching (predicted spans are consumed in order, each picks the
 *  best-IoU unmatched reference) — keeps the implementation simple at the cost
 *  of being non-optimal under heavy overlap; the metrics are robust to it
 *  because frame-F1 + coverage scale to total duration rather than counts.
 *
 *  Mode handling:
 *    - 'full-annotation' (default) — standard precision/recall on the rasterised
 *      mask, plus per-pair IoU averaged over matched pairs.
 *    - 'multiple-candidates' — collapses the whole reference layer to one
 *      "alternative-set" entity: recall is binary (1.0 if ANY ref item matches
 *      ANY pred item with IoU > 0, else 0.0). Precision and the per-pair IoU
 *      still mean the same thing. */
export function evaluateSpans(
  reference: SpanItem[],
  predicted: SpanItem[],
  trackDuration: number,
  opts: SpanEvalOptions = {},
): SpanEvalResult {
  const mode        = opts.mode        ?? 'full-annotation';
  const frameSec    = opts.frameSec    ?? DEFAULT_SPAN_FRAME_SEC;
  const toleranceSec = opts.toleranceSec ?? DEFAULT_SPAN_ONSET_TOLERANCE_SEC;

  const refCount = reference.length;
  const estCount = predicted.length;
  if (refCount === 0 || estCount === 0) {
    return {
      ...EMPTY_SPAN_RESULT,
      refCount, estCount, mode, toleranceSec, frameSec,
    };
  }

  // Per-pair IoU via greedy matching. Each predicted span consumes one
  // reference span (whichever has highest IoU, including any per-item
  // candidates). Ties go to the earliest unmatched ref.
  const consumed = new Set<number>();
  const iouValues: number[] = [];
  for (const est of predicted) {
    const estIv: SpanInterval = [est.start, est.end];
    let bestIdx = -1;
    let bestIoU = 0;
    for (let i = 0; i < reference.length; i++) {
      if (consumed.has(i)) continue;
      const iou = bestIoUWithCandidates(reference[i], estIv);
      if (iou > bestIoU) { bestIoU = iou; bestIdx = i; }
    }
    if (bestIdx >= 0 && bestIoU > 0) {
      consumed.add(bestIdx);
      iouValues.push(bestIoU);
    }
  }
  const matchedPairs = iouValues.length;
  const meanIoU = matchedPairs > 0 ? iouValues.reduce((s, v) => s + v, 0) / matchedPairs : 0;

  // Frame-level F1 on the rasterised voicing mask. Multi-candidates mode
  // unions each ref item with its alternates so any acceptable form of the
  // truth contributes to the mask.
  const refSpans: SpanInterval[] = reference.flatMap((r) => [
    [r.start, r.end] as SpanInterval,
    ...((r.candidates ?? []) as SpanInterval[]),
  ]);
  const estSpans: SpanInterval[] = predicted.map((p) => [p.start, p.end] as SpanInterval);
  const refMask = rasterise(refSpans, trackDuration, frameSec);
  const estMask = rasterise(estSpans, trackDuration, frameSec);
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < refMask.length; i++) {
    if (estMask[i] && refMask[i]) tp++;
    else if (estMask[i] && !refMask[i]) fp++;
    else if (!estMask[i] && refMask[i]) fn++;
  }
  const frameP = (tp + fp) > 0 ? tp / (tp + fp) : 0;
  const frameR = mode === 'multiple-candidates'
    ? (matchedPairs > 0 ? 1 : 0)
    : ((tp + fn) > 0 ? tp / (tp + fn) : 0);
  const frameF1 = (frameP + frameR) > 0 ? (2 * frameP * frameR) / (frameP + frameR) : 0;

  // Onset / offset F1 — treat each span edge as a cue and reuse evaluateCueLayer.
  const onsetRef: CueItem[] = reference.map((r) => ({ id: r.id, time: r.start, label: r.label }));
  const onsetEst: CueItem[] = predicted.map((p) => ({ id: p.id, time: p.start, label: p.label }));
  const offsetRef: CueItem[] = reference.map((r) => ({ id: r.id, time: r.end, label: r.label }));
  const offsetEst: CueItem[] = predicted.map((p) => ({ id: p.id, time: p.end, label: p.label }));
  const onsetEval  = evaluateCueLayer(onsetRef,  onsetEst,  trackDuration, toleranceSec);
  const offsetEval = evaluateCueLayer(offsetRef, offsetEst, trackDuration, toleranceSec);

  // Coverage = ratio of total covered ref duration to total ref duration.
  // Uses the same rasterised mask so overlapping spans don't double-count.
  let refFrames = 0, refCovered = 0;
  for (let i = 0; i < refMask.length; i++) {
    if (refMask[i]) {
      refFrames++;
      if (estMask[i]) refCovered++;
    }
  }
  const coverage = refFrames > 0 ? refCovered / refFrames : 0;

  return {
    meanIoU,
    frameP, frameR, frameF1,
    onsetF1:  onsetEval.f1,
    offsetF1: offsetEval.f1,
    coverage,
    matchedPairs,
    refCount, estCount,
    mode, toleranceSec, frameSec,
  };
}

// ─── Loop / pattern / lyrics stubs (Phase 4–5) ───────────────────────────────
//
// Surface placeholders so consumers can import these names today; the bodies
// reuse `evaluateSpans` for now since all three are interval-shaped. When the
// dedicated metrics land (bar-grid snap for loops, cycle alignment for
// patterns, word-level WER for lyrics) replace the body, not the signature.

export interface LoopEvalResult extends SpanEvalResult { /* phase-4 extras land here */ }
export interface PatternEvalResult extends SpanEvalResult { /* phase-5 extras land here */ }
export interface LyricsEvalResult extends SpanEvalResult { /* word-level metrics land here */ }

export function evaluateLoops(
  reference: LoopItem[],
  predicted: LoopItem[],
  trackDuration: number,
  opts: SpanEvalOptions = {},
): LoopEvalResult {
  // Loops share the SpanItem shape (start/end/label/candidates). Reuse.
  const refSpans = reference.map((l) => ({ ...l, candidates: l.candidates }));
  const estSpans = predicted.map((l) => ({ ...l, candidates: l.candidates }));
  return evaluateSpans(refSpans as unknown as SpanItem[], estSpans as unknown as SpanItem[], trackDuration, opts);
}

export function evaluatePatterns(
  reference: PatternItem[],
  predicted: PatternItem[],
  trackDuration: number,
  opts: SpanEvalOptions = {},
): PatternEvalResult {
  const refSpans = reference.map((p) => ({ ...p, candidates: p.candidates }));
  const estSpans = predicted.map((p) => ({ ...p, candidates: p.candidates }));
  return evaluateSpans(refSpans as unknown as SpanItem[], estSpans as unknown as SpanItem[], trackDuration, opts);
}

export function evaluateLyrics(
  reference: LyricsItem[],
  predicted: LyricsItem[],
  trackDuration: number,
  opts: SpanEvalOptions = {},
): LyricsEvalResult {
  // Phase 5 will replace this with word-level WER + onset/offset F1 at 50 ms;
  // until then map LyricsItem.kind === 'word' to point-cues and 'line' to spans
  // so consumers get reasonable numbers from a partially-typed corpus.
  const toIntervalItem = (l: LyricsItem): SpanItem => ({
    id: l.id,
    start: l.time,
    end: l.end ?? l.time + 0.2,
    label: l.text,
  });
  const refIntervals = reference.map(toIntervalItem);
  const estIntervals = predicted.map(toIntervalItem);
  return evaluateSpans(
    refIntervals, estIntervals, trackDuration,
    { ...opts, toleranceSec: opts.toleranceSec ?? DEFAULT_LYRICS_TOLERANCE_SEC },
  );
}
