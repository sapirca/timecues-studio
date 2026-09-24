/**
 * Types mirroring tools/python/custom_api.py and the result envelopes
 * produced by tools/python/custom_runner.py. Kept in lockstep with the
 * Python side — if you change one, change both.
 */

/** Output kinds a detector may emit. Mirrors `OutputKind` in
 *  tools/python/custom_api.py.
 *
 *  `pattern` was absent here for a while: the standalone Patterns annotation
 *  layer was retired, so the app had nowhere to put pattern items even though
 *  the Python side kept emitting them. It is back because riff patterns are
 *  that home — a repeating figure is a NODE and each run of it an INSTANCE,
 *  which is what a pattern item already describes. See
 *  components/inspector-v2/drumGrooveToRiff.ts.
 *
 *  `loop` and `pattern` are gated by the `experimentalLoopsAndPatterns`
 *  Settings flag — the registry filters them out of the response when the flag
 *  is off, matching how the corresponding annotation tab is hidden. */
export type CustomOutputKind = 'boundary' | 'cue' | 'span' | 'loop' | 'lyrics' | 'pattern';
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
  /** Demucs stem this detector reads from ("vocals" | "drums" | "bass" |
   *  "other"), or "mix" for whole-track detectors. null when the detector
   *  declares none — the UI then leaves the lane label untouched. */
  stem: CustomDetectorStem | null;
  /** Optional family/group label (e.g. "Band", "EDM", "Instruments"). Used to
   *  cluster detectors within a stem section in the sidebar. null = ungrouped. */
  group: string | null;
  /** True for a shipped detector (tools/python/custom-default/), false for one
   *  of the user's own (tools/python/custom/). Lists title the two apart. */
  is_default: boolean;
  errors: CustomValidationError[];
}

/** Source stem a detector was built from. Mirrors ALLOWED_STEM in
 *  tools/python/custom_loader.py. */
export type CustomDetectorStem = 'vocals' | 'drums' | 'bass' | 'other' | 'guitar' | 'piano' | 'mix';

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
  /** Struck-hit fields — present only when the detector set them.
   *  How hard this hit was struck, 1-127, against the same instrument's
   *  hardest hit. The lane draws the tick this tall. */
  velocity?: number;
  /** Actual level against the loudest hit in the track, dB (<= 0). */
  level_db?: number;
  /** "#rrggbb" for this one tick, overriding the lane colour. */
  color?: string;
  /** MIDI note number, 0-127 (60 = middle C) — the pitch of the hit. */
  note?: number;
  /** How long the hit rings, ms (> 0). Drawn as a faint tail after the tick. */
  decay_ms?: number;
  /** Same star a hand-placed cue carries. */
  importance?: CustomImportance;
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

/** One repeating figure. `start_ms` + `duration_ms` describe ONE cycle, which
 *  the renderer tiles `repeat_count` times; `highlighted_beats` are 0-based
 *  step indices inside that cycle and `steps_per_cycle` is their index space
 *  (a 4/4 bar at 16th resolution is 16).
 *
 *  `rows` and `occurrences` are the multi-row extension `drum_kit_pattern.py`
 *  emits, and are absent from single-row generators: `rows` splits the figure
 *  into named lines (kick / snare / hat) with a velocity per kept step, and
 *  `occurrences` records each repeat's distance from the canonical cycle plus
 *  the exact steps it added or dropped. Mirrors the Pattern dataclass in
 *  tools/python/custom_api.py. Gated by `experimentalLoopsAndPatterns`. */
export interface CustomPatternItem {
  start_ms: number;
  duration_ms: number;
  label: string | null;
  repeat_count: number;
  highlighted_beats: number[] | null;
  spans: number[][] | null;
  steps_per_cycle: number | null;
  rows?: { row: string; highlighted_beats: number[]; accents?: number[] }[];
  occurrences?: {
    index: number;
    start_ms: number;
    deviation: number;
    added: { row: string; step: number }[];
    missing: { row: string; step: number }[];
    relabelled: { step: number; from: string; to: string }[];
  }[];
  /** Stable letter shared by every run of the same figure, so a groove that
   *  returns later in the song is recognisable as the same one. */
  groove?: string;
  exact_repeats?: number;
  variant_repeats?: number;
}

/** Word- or line-level lyric timestamp. `end_ms` is present for line-level
 *  entries (and word-level when the model provides it). `source` names the
 *  algorithm that produced it (e.g. "whisper-base", "ctc-forced-aligner") —
 *  curated_lyrics prefers ctc-forced-aligner and falls back to whisper-base
 *  silently, so this is how the UI shows which one actually ran. Gated by
 *  the experimentalLyricsFamily flag on the UI side. */
export interface CustomLyricsItem {
  time_ms: number;
  end_ms: number | null;
  text: string;
  kind: 'word' | 'line';
  source?: string | null;
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
    | CustomLyricsItem
  )[];
  errors: CustomValidationError[];
  /** Caveats about the RUN, raised by the detector itself through `ctx.warn()`.
   *  The run succeeded and the items are valid — something about the INPUT
   *  means they should not be read at face value, and only the detector was
   *  ever positioned to know it. Distinct from `errors` (an item was rejected)
   *  and `fatal` (nothing ran). Absent on envelopes cached before this existed. */
  notes?: CustomRunNote[];
  stats: { accepted: number; rejected: number };
  /** Set when detect() raised, audio could not be loaded, etc. items will be empty. */
  fatal: CustomFatalError | null;
}

/** One caveat about a run. `code` is stable and machine-readable (e.g.
 *  `empty-band:hat`); `message` is written for a curator to act on. */
export interface CustomRunNote {
  code: string;
  message: string;
}
