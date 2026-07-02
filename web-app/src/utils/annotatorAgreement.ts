import type { ManualAnnotation, AutoGuessManualAnnotation } from '../types/manualAnnotation';

export interface BoundaryF1 {
  precision: number;
  recall: number;
  f1: number;
  hits: number;
  refCount: number;
  estCount: number;
}

/** MIREX-style boundary detection F1: greedy 1:1 match of est→ref boundaries
 *  within `tolerance` seconds. Each ref boundary can match at most one est. */
export function pairwiseBoundaryF1(
  refTimes: number[],
  estTimes: number[],
  tolerance: number,
): BoundaryF1 {
  const refSorted = [...refTimes].sort((a, b) => a - b);
  const estSorted = [...estTimes].sort((a, b) => a - b);
  const refUsed = new Array<boolean>(refSorted.length).fill(false);
  let hits = 0;

  for (const est of estSorted) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < refSorted.length; i++) {
      if (refUsed[i]) continue;
      const d = Math.abs(refSorted[i] - est);
      if (d <= tolerance && d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      refUsed[bestIdx] = true;
      hits++;
    }
  }

  const precision = estSorted.length === 0 ? 0 : hits / estSorted.length;
  const recall = refSorted.length === 0 ? 0 : hits / refSorted.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, hits, refCount: refSorted.length, estCount: estSorted.length };
}

/** Boundary times from a manual annotation (section start times). */
export function manualBoundaries(ann: ManualAnnotation | null | undefined): number[] {
  if (!ann?.sections?.length) return [];
  return ann.sections.map((s) => s.time).filter((t) => Number.isFinite(t));
}

/** Boundary times from an auto-guess annotation: only points marked
 *  'correct' or 'partial' (with at least one approved source). */
export function autoGuessBoundaries(ann: AutoGuessManualAnnotation | null | undefined): number[] {
  if (!ann?.points?.length) return [];
  const out: number[] = [];
  for (const p of ann.points) {
    if (p.status === 'correct') {
      out.push(p.time);
    } else if (p.status === 'partial' && p.sourceStatuses) {
      // Each approved source contributes its own time
      for (const [, status] of Object.entries(p.sourceStatuses)) {
        if (status === 'approved') {
          out.push(p.time);
          break; // one boundary per cluster is enough for boundary-F1
        }
      }
    }
  }
  return out.filter((t) => Number.isFinite(t));
}

/** Pairwise label agreement: of the boundaries that match within tolerance,
 *  what fraction have the same `type`? Returns null if there are no matches. */
export function pairwiseLabelAgreement(
  ref: { time: number; type: string }[],
  est: { time: number; type: string }[],
  tolerance: number,
): { matched: number; sameLabel: number; ratio: number } | null {
  const refSorted = [...ref].sort((a, b) => a.time - b.time);
  const estSorted = [...est].sort((a, b) => a.time - b.time);
  const refUsed = new Array<boolean>(refSorted.length).fill(false);
  let matched = 0;
  let sameLabel = 0;

  for (const e of estSorted) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < refSorted.length; i++) {
      if (refUsed[i]) continue;
      const d = Math.abs(refSorted[i].time - e.time);
      if (d <= tolerance && d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      refUsed[bestIdx] = true;
      matched++;
      if (refSorted[bestIdx].type === e.type) sameLabel++;
    }
  }

  if (matched === 0) return null;
  return { matched, sameLabel, ratio: sameLabel / matched };
}

export interface AgreementMatrix {
  ids: string[];
  /** `f1[i][j]` = boundary F1 of ids[i] vs ids[j]; symmetric, NaN on diagonal. */
  f1: number[][];
  /** `labels[i][j]` = same-label ratio of matched boundaries; null if no matches. */
  labels: (number | null)[][];
  /** Per-annotator boundary count (kept for display alongside the matrix). */
  counts: Record<string, number>;
}

/** Build a pairwise comparison matrix across N annotators for one annotation
 *  type. `boundariesFor` returns the {time,type}[] for each annotator id. */
export function buildAgreementMatrix(
  ids: string[],
  boundariesFor: (id: string) => { time: number; type: string }[],
  tolerance: number,
): AgreementMatrix {
  const data = ids.map((id) => boundariesFor(id));
  const f1: number[][] = ids.map(() => ids.map(() => NaN));
  const labels: (number | null)[][] = ids.map(() => ids.map(() => null));
  const counts: Record<string, number> = {};
  ids.forEach((id, i) => { counts[id] = data[i].length; });

  for (let i = 0; i < ids.length; i++) {
    for (let j = 0; j < ids.length; j++) {
      if (i === j) continue;
      const refTimes = data[i].map((b) => b.time);
      const estTimes = data[j].map((b) => b.time);
      f1[i][j] = pairwiseBoundaryF1(refTimes, estTimes, tolerance).f1;
      labels[i][j] = pairwiseLabelAgreement(data[i], data[j], tolerance)?.ratio ?? null;
    }
  }
  return { ids, f1, labels, counts };
}
