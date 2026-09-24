/**
 * Auto-guess boundary review + the algorithm-cluster analysis that feeds it.
 *
 * Auto-guess is the one annotation kind that is NOT a layer: it is a review
 * workflow over clustered algorithm output, with a per-point ✓/✗/@ verdict
 * rather than a canvas lane the curator draws on. It keeps its own document at
 *   data/annotations/auto-guess/<annotator>/<slug>.json
 * served by /api/auto-guess-annotations/:slug.
 *
 * Everything a curator authors by hand — boundaries included — lives in the
 * annotation-layers document instead; see types/annotationLayer.ts.
 */

export type AutoGuessStatus = 'done' | 'wip' | 'none';

// ─── Auto-guess points ───────────────────────────────────────────────────────
// Created by merging ALL algorithm boundary suggestions via clustering.
// The reviewer validates each point individually and may adjust its timing.

export interface AutoGuessSource {
  algorithmId: string;
  originalTime: number;   // the time as suggested by this algorithm
}

export type AutoGuessPointStatus = 'pending' | 'correct' | 'incorrect' | 'partial';

export interface AutoGuessPoint {
  /** Unique stable id (used as React key and for correlation). */
  id: string;
  /** Current accepted time — may be adjusted by the reviewer. */
  time: number;
  /** Initial representative time (mean across cluster members) before any review. */
  originalTime: number;
  /** All algorithm suggestions that were merged into this cluster. */
  sources: AutoGuessSource[];
  /** Cluster index (0-based). Points with the same clusterId were merged together. */
  clusterId: number;
  /** How many algorithms contributed to this cluster. */
  clusterSize: number;
  /** Reviewer decision. */
  status: AutoGuessPointStatus;
  /**
   * Set when the reviewer chose to use a specific source's time or the player time.
   * 'player' = time was set via player seek position.
    * 'manual' = a missing point was added manually by the reviewer.
   * algorithmId = time was adopted from that source.
   */
  correctionSource?: string;
  /**
   * Per-source decisions when reviewing algorithms individually within a cluster.
   * When set, the cluster has 'partial' status and each approved source contributes
   * its own boundary time to the manual annotation (enabling multiple correct answers
   * within one cluster window).
   * Clearing this (setting undefined) reverts to bulk decision via `status`.
   */
  sourceStatuses?: Record<string, 'approved' | 'rejected'>;
}

/**
 * How the representative time is chosen for each cluster during generation
 * and live re-apply. Mirrors the same methods exposed in the Auto Consensus panel.
 * 'mean'     — arithmetic mean of all raw member times (default).
 * 'eqgroup'  — one representative per algorithm group, then average; prevents
 *              prolific algorithms from dominating.
 * 'metamed'  — picks whichever of {median, trimmed-mean, tightest-span, eqgroup}
 *              is closest to their mutual median. Always a real method's output.
 * 'plural'   — the candidate most agreed-upon by the others (within 0.5 s);
 *              ties broken by proximity to the cluster mean.
 * 'nearraw'  — raw member timestamp with the smallest total L1 distance to all
 *              others. Always an actual algorithm prediction, never interpolated.
 * `originalTime` always stores the arithmetic mean (anchor for "reset to mean").
 */
export type AutoGuessCentroidMethod = 'mean' | 'eqgroup' | 'metamed' | 'plural' | 'nearraw';

export interface AutoGuessManualAnnotation {
  song: string;
  created_at: string;
  updated_at: string;
  /** Tolerance in seconds used to merge nearby algorithm boundaries into clusters. */
  clusterTolerance: number;
  /** Centroid method used when generating / re-applying cluster representative times. */
  centroidMethod?: AutoGuessCentroidMethod;
  /** Coarse status of this auto-guess annotation. Used by the song list and
   *  the legacy AutoGuessPanel header chip; the shared toolbar pill reads
   *  `reviewed` / `ready_for_review` below. */
  auto_guess_status?: AutoGuessStatus;
  /** Shared-toolbar pill state. Mirrors the same fields on ManualAnnotation so
   *  every annotation type has a uniform 3-state workflow flag. Missing →
   *  treated as in_progress. */
  reviewed?: boolean;
  ready_for_review?: boolean;
  points: AutoGuessPoint[];
}

// ─── Algorithm Cluster Analysis ───────────────────────────────────────────────
// Automatic clustering of the 4 MSAF algorithm boundary outputs.
// Cached per song at algo-clusters/<slug>.json.
// Separate from AutoGuessManualAnnotation (user-validated workflow).

/** The four MSAF algorithm variants tracked in cluster analysis. */
export type AlgoGroup = 'msaf-sf' | 'msaf-foote' | 'msaf-cnmf' | 'msaf-olda';

export interface AlgoClusterSource {
  algoId: string;
  group: AlgoGroup;
  time: number;
}

export interface AlgoCluster {
  id: number;
  meanTime: number;
  sources: AlgoClusterSource[];
  /** Distinct groups that have at least one source in this cluster. */
  groups: AlgoGroup[];
  /** Number of distinct groups present (0–4). */
  numGroups: number;
}

export interface AlgoClusteredData {
  slug: string;
  generatedAt: string;
  /** Clustering tolerance (seconds) used to produce this data. */
  tolerance: number;
  /** Total number of individual algorithm outputs that were clustered. */
  totalAlgos: number;
  clusters: AlgoCluster[];
}
