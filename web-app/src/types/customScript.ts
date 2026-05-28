/**
 * Types mirroring tools/python/custom_api.py and the result envelopes
 * produced by tools/python/custom_runner.py. Kept in lockstep with the
 * Python side — if you change one, change both.
 */

/** Output kinds a detector may emit. Mirrors `OutputKind` in
 *  tools/python/custom_api.py.
 *
 *  `loop` and `pattern` are gated by the `experimentalLoopsAndPatterns`
 *  Settings flag — the registry filters them out of the response when the
 *  flag is off, matching how the corresponding annotation tabs are hidden. */
export type CustomOutputKind = 'boundary' | 'cue' | 'span' | 'loop' | 'pattern';
export type CustomImportance = 'critical' | 'optional';

export type CustomRegistryStatus = 'ok' | 'load_error' | 'validation_error';

export interface CustomValidationError {
  /** Item index when the error came from validating one item; null when load-time. */
  index: number | null;
  /** Field that failed (e.g. "name", "time_ms"). null when the error spans the whole item or file. */
  field: string | null;
  /** Offending value, JSON-safe (string, number, boolean, list, dict, or null). */
  value: unknown;
  /** Human-readable explanation. */
  message: string;
}

export interface CustomRegistryEntry {
  name: string;
  file: string;
  status: CustomRegistryStatus;
  label: string;
  output_kind: CustomOutputKind;
  is_algorithm: boolean;
  is_annotation: boolean;
  description: string;
  version: string;
  errors: CustomValidationError[];
}

/** GET /api/custom-scripts response. */
export interface CustomRegistryResponse {
  detectors: CustomRegistryEntry[];
}

// ─── Result envelope (run output) ─────────────────────────────────────────────

export interface CustomBoundaryItem {
  time_ms: number;
  label: string | null;
  importance: CustomImportance | null;
  candidates: number[] | null;
}

export interface CustomCueItem {
  /** Single timestamp in ms — a Cue is a point event, not an interval. */
  time_ms: number;
  /** Short text, shown next to the tick on hover/in the editor list. */
  label: string | null;
  /** Longer free-form note, shown only when a cue is selected in the editor. */
  description: string | null;
  intensity: number | null;
  /** Alternative valid times in ms — any candidate within tolerance counts as
   *  a hit during evaluation. Mirrors CustomBoundaryItem.candidates. */
  candidates: number[] | null;
}

/** Labeled interval that may overlap (vocal-active regions, instrument
 *  presence, FX sweeps). */
export interface CustomSpanItem {
  start_ms: number;
  duration_ms: number;
  label: string | null;
  intensity: number | null;
}

/** Grid-aware seamless-playback interval — the region "works musically when
 *  played back-to-back on repeat" (N-bar phrases, DJ pickups, drum loops).
 *  Gated by `experimentalLoopsAndPatterns`. */
export interface CustomLoopItem {
  start_ms: number;
  duration_ms: number;
  label: string | null;
  /** UI hint: snap loop boundaries to nearest audio zero-crossing on
   *  playback to avoid clicks at the seam. */
  snap_zero_cross: boolean | null;
}

/** Short repeating motif that tiles across the track. `start_ms` +
 *  `duration_ms` describe ONE cycle; the renderer multiplies it `repeat_count`
 *  times. `highlighted_beats` carries 0-based 16th-note step indices within
 *  one cycle that the pattern accents. Gated by `experimentalLoopsAndPatterns`. */
export interface CustomPatternItem {
  start_ms: number;
  duration_ms: number;
  label: string | null;
  repeat_count: number;
  highlighted_beats: number[] | null;
}

export interface CustomFatalError {
  type: string;
  message: string;
  /** Full Python traceback. May be empty for non-exception fatals (e.g. missing audio). */
  traceback: string;
  /** Top-level Python module name that failed to import (e.g. "torch", "cv2"). */
  missing_module?: string;
  /** pip package name to install (differs from missing_module for cv2→opencv-python, sklearn→scikit-learn, etc). */
  suggested_package?: string;
  /** Ready-to-copy shell command, e.g. "pip install opencv-python". */
  suggested_install?: string;
}

/** Shape carried inside CustomValidationError.value when a load failure was
 *  caused by a missing module. Mirrors the same fields on CustomFatalError. */
export interface MissingModuleHint {
  missing_module: string;
  suggested_package: string;
  suggested_install: string;
}

/** Type guard for CustomValidationError.value containing a missing-module hint. */
export function isMissingModuleHint(value: unknown): value is MissingModuleHint {
  return (
    typeof value === 'object' && value !== null &&
    typeof (value as MissingModuleHint).missing_module === 'string' &&
    typeof (value as MissingModuleHint).suggested_install === 'string'
  );
}

export interface CustomResultEnvelope {
  name: string;
  slug: string;
  output_kind: CustomOutputKind;
  /** ISO-8601 timestamp. */
  ran_at: string;
  duration_ms: number;
  items: (
    | CustomBoundaryItem
    | CustomCueItem
    | CustomSpanItem
    | CustomLoopItem
    | CustomPatternItem
  )[];
  errors: CustomValidationError[];
  stats: { accepted: number; rejected: number };
  /** Set when detect() raised, audio could not be loaded, etc. items will be empty. */
  fatal: CustomFatalError | null;
}
