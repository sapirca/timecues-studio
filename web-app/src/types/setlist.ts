// Setlist — an ordered subset of the corpus produced by the Setlist workspace.
//
// A setlist is per-annotator and corpus-scoped. The MVP scorer uses BPM only
// and leaves slots for meter + energy. Key/chord/genre scorers can join the
// strategy registry once Phase 3 ships their underlying detectors.

export type SetlistStrategyId = 'bpm-ladder';

export interface SetlistScoringWeights {
  /** 0..1 — how much BPM proximity matters. v0 weight = 1. */
  bpm: number;
  /** 0..1 — meter match (4/4 vs 3/4). Reserved for the next pass. */
  meter: number;
  /** 0..1 — energy continuity between adjacent songs. Reserved. */
  energy: number;
}

export interface SetlistEntry {
  /** Song slug (matches `AudioEntry.id` from the manifest). */
  slug: string;
  /** Display name at the time the setlist was saved — kept so renamed/removed
   *  songs still render something readable in old setlists. */
  name: string;
  /** Median BPM used when the setlist was generated. Cached here so the
   *  ordering is reproducible even if the BPM cache later changes. */
  bpm: number | null;
  /** Time signature label ("4/4", "3/4"). Reserved for the meter scorer. */
  meter: string | null;
}

export interface Setlist {
  /** Name shown in the picker. Doubles as the filename (slug-safe). */
  name: string;
  /** Strategy that produced the order. */
  strategy: SetlistStrategyId;
  /** Weights used. Persisted so reruns from the saved object are reproducible. */
  weights: SetlistScoringWeights;
  /** Ordered entries — first → last play. */
  entries: SetlistEntry[];
  /** Per-pair score (entries.length - 1 items). Pairs[i] is the score
   *  between entries[i] and entries[i+1]. */
  pairScores: number[];
  /** ISO timestamp of last save (stamped server-side; client never fakes a clock). */
  saved_at?: string;
}
