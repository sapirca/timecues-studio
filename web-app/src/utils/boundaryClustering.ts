// Shared centroid-linkage boundary clustering + representative-time methods.
//
// This is the single implementation of the "cluster predicted boundary times by
// temporal proximity, then pick a representative time per cluster" logic used by
// every auto-guess / consensus surface in the app. Previously each of these four
// call sites carried its own byte-identical copy of the same loop and centroid
// math:
//   - AutoGuessPanel            (interactive review-point generation)
//   - InspectorPageV2           (computeLiveClusters — live overlay preview)
//   - GlobalEvalStage           (computeConsensusTimes — dataset parameter sweep)
//   - AlgoInspectStage          (clusterForConsensus — single-song consensus panel)
//
// The Python MSAF-consensus generator (tools/python/generators/phrases_msaf.py)
// is the same *idea* over the four MSAF algorithms, but runs in a different
// runtime on baked caches — it is intentionally NOT unified here.

/** The eight representative-time methods. `AutoGuessCentroidMethod` (in
 *  types/manualAnnotation.ts) is the user-selectable subset; the extra three
 *  (median / trimmed / tightest) are internal candidates that some surfaces
 *  expose directly. */
export type CentroidMethod =
  | 'mean' | 'median' | 'trimmed' | 'tightest'
  | 'eqgroup' | 'metamed' | 'plural' | 'nearraw';

export interface ClusterPoint {
  algorithmId: string;
  time: number;
}

export interface BoundaryCluster {
  members: ClusterPoint[];
}

/**
 * Centroid-linkage clustering:
 *   1. Sort all points by time.
 *   2. Walk left→right; assign each point to the nearest existing cluster whose
 *      running-mean centroid is within `toleranceSec`, else start a new one.
 *   3. Recompute the running mean after each assignment (keeps clusters tight).
 * Clusters are returned in ascending start-time order.
 */
export function clusterPoints(points: ClusterPoint[], toleranceSec: number): BoundaryCluster[] {
  if (!points.length) return [];
  const sorted = [...points].sort((a, b) => a.time - b.time);
  const clusters: { sum: number; count: number; members: ClusterPoint[] }[] = [];
  for (const pt of sorted) {
    let bestIdx = -1, bestDist = Infinity;
    for (let k = clusters.length - 1; k >= 0; k--) {
      const centroid = clusters[k].sum / clusters[k].count;
      if (pt.time - centroid > toleranceSec) break;
      const dist = Math.abs(pt.time - centroid);
      if (dist <= toleranceSec && dist < bestDist) { bestDist = dist; bestIdx = k; }
    }
    if (bestIdx >= 0) {
      clusters[bestIdx].members.push(pt); clusters[bestIdx].sum += pt.time; clusters[bestIdx].count += 1;
    } else {
      clusters.push({ sum: pt.time, count: 1, members: [pt] });
    }
  }
  return clusters.map(({ members }) => ({ members }));
}

/**
 * All eight representative times for one cluster, computed together so the
 * shared intermediates (median / trimmed / tightest / eqgroup) are derived once.
 * Mirrors the previous inline computation in AlgoInspectStage.
 */
export function computeAllClusterTimes(members: ClusterPoint[]): Record<CentroidMethod, number> {
  const ts = [...members.map((m) => m.time)].sort((a, b) => a - b);
  const n = ts.length;
  const mean = ts.reduce((s, t) => s + t, 0) / n;

  // Median
  const mid = Math.floor(n / 2);
  const median = n % 2 === 1 ? ts[mid] : (ts[mid - 1] + ts[mid]) / 2;

  // Trimmed mean — remove the member farthest from the arithmetic mean
  let trimmed = mean;
  if (n > 2) {
    const fi = ts.reduce((bi, t, i) => Math.abs(t - mean) > Math.abs(ts[bi] - mean) ? i : bi, 0);
    const arr = ts.filter((_, i) => i !== fi);
    trimmed = arr.reduce((s, t) => s + t, 0) / arr.length;
  }

  // Tightest span — smallest window covering ≥⌈N/2⌉ members; use its midpoint
  let tightest = ts[0];
  {
    const majority = Math.ceil(n / 2);
    let bestSpan = Infinity;
    for (let i = 0; i <= n - majority; i++) {
      const span = ts[i + majority - 1] - ts[i];
      if (span < bestSpan) { bestSpan = span; tightest = (ts[i] + ts[i + majority - 1]) / 2; }
    }
  }

  // EqGroup — one representative per algorithm (mean of its members), then average reps
  let eqgroup = mean;
  {
    const gm = new Map<string, number[]>();
    for (const m of members) {
      if (!gm.has(m.algorithmId)) gm.set(m.algorithmId, []);
      gm.get(m.algorithmId)!.push(m.time);
    }
    const reps = [...gm.values()].map((gts) => gts.reduce((s, t) => s + t, 0) / gts.length);
    eqgroup = reps.reduce((s, t) => s + t, 0) / reps.length;
  }

  // MetaMed / Plural operate on the four internal candidates
  const cands = [median, trimmed, tightest, eqgroup];

  const sortedCands = [...cands].sort((a, b) => a - b);
  const mm = sortedCands.length % 2 === 1
    ? sortedCands[Math.floor(sortedCands.length / 2)]
    : (sortedCands[sortedCands.length / 2 - 1] + sortedCands[sortedCands.length / 2]) / 2;
  const metamed = cands.reduce((best, v) => Math.abs(v - mm) < Math.abs(best - mm) ? v : best, cands[0]);

  // plural — most agreed-upon candidate (within 0.5 s); ties → closest to mean
  const scores = cands.map((v) => cands.filter((u) => Math.abs(u - v) <= 0.5).length);
  const maxS = Math.max(...scores);
  const winners = cands.filter((_, i) => scores[i] === maxS);
  const plural = winners.reduce((best, v) => Math.abs(v - mean) < Math.abs(best - mean) ? v : best, winners[0]);

  // NearRaw — raw timestamp with smallest total L1 distance to all others
  const nearraw = ts.reduce((best, t) => {
    const sd = ts.reduce((s, u) => s + Math.abs(t - u), 0);
    const bd = ts.reduce((s, u) => s + Math.abs(best - u), 0);
    return sd < bd ? t : best;
  }, ts[0]);

  return { mean, median, trimmed, tightest, eqgroup, metamed, plural, nearraw };
}

/**
 * Representative time for one cluster under a single method. Fast-paths the
 * common `mean` case (and the degenerate single-member cluster); otherwise
 * derives from `computeAllClusterTimes`.
 */
export function computeClusterTime(members: ClusterPoint[], method: CentroidMethod): number {
  if (method === 'mean' || members.length === 1) {
    return members.reduce((s, m) => s + m.time, 0) / members.length;
  }
  return computeAllClusterTimes(members)[method];
}

/**
 * How many *distinct algorithms* back a cluster — what every min-agreement
 * threshold and every ×N badge means when it says "N algorithms agreed".
 *
 * A member count is not the same number: one detector that fires twice inside
 * τ contributes two members but one voice, so counting members lets a prolific
 * detector clear a "≥2 algorithms" bar on its own. Consensus Inspect has always
 * counted algorithms (as does the Merge row, deliberately — "agreement counts
 * lanes, not votes"); this is the same rule for the Auto-guess points, so a
 * threshold means the same thing on both surfaces.
 *
 * Points with no `sources` are hand-added — they have no algorithm behind them
 * at all, so their stored `clusterSize` (1) stands in.
 */
export function agreementCount(point: {
  sources: { algorithmId: string }[];
  clusterSize: number;
}): number {
  if (!point.sources.length) return point.clusterSize;
  return new Set(point.sources.map((s) => s.algorithmId)).size;
}
