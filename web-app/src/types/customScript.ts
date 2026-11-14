/**
 * Types mirroring tools/python/custom_api.py and the result envelopes
 * produced by tools/python/custom_runner.py. Kept in lockstep with the
 * Python side — if you change one, change both.
 */

import type { PulseRate, RiffCombo, RiffNode, RiffPatternItem } from './annotationLayer';

/** Output kinds a detector may emit. Mirrors `OutputKind` in
 *  tools/python/custom_api.py.
 *
 *  A `riff` detector's output is one riff lane in the shape a Riff Patterns
 *  layer stores — its `nodes` (and `combos`) on the envelope or lane, its
 *  instances as `items` — so the app reads it as a layer with nothing to
 *  convert (detectorLayers.ts `detectorRiffLayer`). */
export type CustomOutputKind = 'boundary' | 'cue' | 'span' | 'loop' | 'lyrics' | 'riff' | 'lanes';
/** What one lane of a `lanes` detector holds — every kind but `lanes`. */
export type CustomLaneKind = Exclude<CustomOutputKind, 'lanes'>;
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
  /** Every registered detector shows in Algorithm Inspect. This one adds to
   *  that: when an annotator runs the detector on a song, its output is also
   *  copied into a new layer of their own annotation — once; a re-run leaves an
   *  existing copy alone. Off unless the detector sets `is_annotation = True`. */
  is_annotation: boolean;
  description: string;
  version: string;
  /** Demucs stem this detector reads from ("vocals" | "drums" | "bass" |
   *  "other" | "guitar" | "piano"), "mix" for whole-track detectors, or
   *  "stems" for one lane read from several stems and never the mix. null
   *  when the detector declares none — the UI then leaves the lane label
   *  untouched. For one stem of a detector run once per stem, that stem. */
  stem: CustomDetectorStem | typeof SEVERAL_STEMS | null;
  /** The `name` written in the detector's file. Differs from `name` only for a
   *  detector that declares several stems (`stem = ["vocals", "other"]`): it
   *  is registered once per stem as `<base_name>__<stem>`, and the file is
   *  still saved, renamed and deleted by `base_name`. Absent from older servers. */
  base_name?: string;
  /** Every stem such a detector declares, in its file's order; null for a
   *  detector with one stem or none. */
  stems?: CustomDetectorStem[] | null;
  /** Optional family/group label (e.g. "Band", "EDM", "Instruments"). Used to
   *  cluster detectors within a stem section in the sidebar. null = ungrouped. */
  group: string | null;
  /** Put a ✓/✗ on every item this detector draws. Off unless the detector sets
   *  `review = True`; without it the lane shows its items plainly and the
   *  lane's ⬇ copy is the only approval. */
  review: boolean;
  /** Can run on just a highlighted range: detect() reads only its context,
   *  which a window run cuts to the range. False for a detector that reads
   *  whole-song data off disk — it is never offered a window. Absent from
   *  servers that predate window runs. */
  windowable?: boolean;
  /** For a detector whose one lane holds several parts, each read from its
   *  own stem (Pulse): stem → the label prefixes its items start with. A
   *  section run can then read only some stems, and its Replace removes only
   *  those parts' items. Absent/null for every other detector. */
  stem_parts?: Record<string, string[]> | null;
  /** Offers the annotator a strictness slider, Strict (0) … Normal (50) …
   *  Loose (100): how much evidence it needs before it reports an item.
   *  Absent from servers that predate the choice. */
  strictness?: boolean;
  /** Offers the annotator where the drums are read from: Auto, Separated kit
   *  or Bands (`DrumSource`). Absent from servers that predate the choice. */
  drum_source?: boolean;
  /** Offers the annotator where the song's sections are read from: Auto,
   *  Annotated or All-In-One (`SectionSource`). Absent from servers that
   *  predate the choice. */
  section_source?: boolean;
  /** Where the detector reads its input from, as a picker on its row, in
   *  order; the first is the default. Absent/null for a detector that offers
   *  no choice (see DetectorSource). */
  sources?: DetectorSource[] | null;
  /** With `sources`: a layer type ("lyrics") — each of the annotator's lanes
   *  of it is offered too, as the source `lane:<layer id>`, by its name. */
  lane_sources?: string | null;
  /** Yes/no facts about the song the annotator ticks on this detector's row,
   *  name → label ({bass_leads: 'The bass leads this song'}). Absent/null for
   *  a detector that declares none. */
  switches?: Record<string, string> | null;
  /** True for a shipped detector (tools/python/custom-default/), false for one
   *  of the user's own (tools/python/custom/). Lists title the two apart. */
  is_default: boolean;
  /** The package folder the detector sits in (tools/python/custom/<package>/),
   *  and that package's title. null for a loose file. Absent from servers that
   *  predate packages. */
  package?: string | null;
  package_title?: string | null;
  /** Archived from the Playground (tools/python/custom/archived.json). The
   *  file stays in its package and the Playground still opens it, but only
   *  the Playground ever lists it: the registry leaves it out unless asked
   *  (`includeArchived`), so no other sidebar shows it, no "every detector"
   *  run runs it and its package's zip leaves it behind. Absent from servers
   *  that predate archiving. */
  archived?: boolean;
  errors: CustomValidationError[];
}

/** One detector package — a folder of detectors with an optional package.json.
 *  GET /api/custom-scripts/packages. Mirrors custom_loader.read_package. */
export interface DetectorPackage {
  id: string;
  title: string;
  description: string;
  author: string;
  version: string;
  /** Folders under tools/python/ that sharing copies the imported parts of. */
  bundle: string[];
  /** Ships with TimeCues (custom-default/) — can be shared, not removed. */
  is_default: boolean;
  /** False when package.json says `"public": false`: only signed-in team
   *  members see the package — the demo never lists it or its outputs. */
  public: boolean;
  /** Why package.json could not be read, when it couldn't. */
  manifest_error: string | null;
  /** Detector names in the package — the ones its zip carries. */
  detectors: string[];
  /** Its archived detectors, which the zip leaves out. Absent from servers
   *  that predate archiving. */
  archived?: string[];
}

/** Source stem a detector was built from. Mirrors ALLOWED_STEM in
 *  tools/python/custom_loader.py. */
export type CustomDetectorStem = 'vocals' | 'drums' | 'bass' | 'other' | 'guitar' | 'piano' | 'mix';

/** Where a detector reading several stems into one lane, and never the full
 *  mix, is filed (Pulse, Call & response). A filing, not a stem: never on
 *  disk, never in a per-stem list. Mirrors SEVERAL_STEMS in custom_loader.py. */
export const SEVERAL_STEMS = 'stems';

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
  /** "#rrggbb" for this one section — present only when the detector set it. */
  color?: string;
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
  /** "#rrggbb" for this one span — present only when the detector set it. */
  color?: string;
  /** Free-form note — present only when the detector set it. An ⚡ Energy
   *  export here (see utils/energySpan) draws as a measured envelope. */
  description?: string;
  /** The rate this stretch hits at — present only when the detector set it.
   *  Becomes the span's Pulse field; see PulseRate. */
  pulse?: PulseRate;
}

/** Grid-aware seamless-playback interval — the region "works musically when
 *  played back-to-back on repeat" (N-bar phrases, DJ pickups, drum loops). */
export interface CustomLoopItem {
  start_ms: number;
  duration_ms: number;
  label: string | null;
  /** UI hint: snap loop boundaries to nearest audio zero-crossing on
   *  playback to avoid clicks at the seam. */
  snap_zero_cross: boolean | null;
  /** "#rrggbb" for this one loop — present only when the detector set it. */
  color?: string;
}

/** One instance of a `riff` detector's lane: a RiffPatternItem without the
 *  id the app gives it. Seconds, as stored. */
export type CustomRiffItem = Pick<RiffPatternItem, 'start' | 'end' | 'label' | 'sequence' | 'repeatCount' | 'occurrences'>;

/** A node of a `riff` detector's lane: a RiffNode whose colour the app may
 *  pick when the detector named none. */
export type CustomRiffNode = Omit<RiffNode, 'color'> & { color?: string };

/** Word- or line-level lyric timestamp. `end_ms` is present for line-level
 *  entries (and word-level when the model provides it). `source` names the
 *  algorithm that produced it (e.g. "whisper-base", "ctc-forced-aligner") —
 *  curated_lyrics prefers ctc-forced-aligner and falls back to whisper-base
 *  silently, so this is how the UI shows which one actually ran. */
export interface CustomLyricsItem {
  time_ms: number;
  end_ms: number | null;
  text: string;
  kind: 'word' | 'line';
  source?: string | null;
  /** Where each sound inside a word begins, with its syllable (null on an
   *  attack no syllable was laid on). See LyricsItem.onsets. */
  onsets?: { time_ms: number; text: string | null }[] | null;
  /** The word's sound as attack, decay, sustain and release. See
   *  LyricsItem.envelope. */
  envelope?: {
    start_ms: number; peak_ms: number; decay_end_ms: number; release_ms: number; end_ms: number;
    peak_db: number; sustain_db: number | null;
  } | null;
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

/** How sure a detector that offers the choice must be before it reports an
 *  item: 0 (Strict) … 50 (Normal) … 100 (Loose). Mirrors strictness_level in
 *  tools/python/custom_api.py. */
export type DetectorStrictness = number;

/** The three settings from before the slider, still on older cached results,
 *  and still what the slider's ends and middle are called. */
export const STRICTNESS_NAMES = { strict: 0, normal: 50, loose: 100 } as const;
export const DEFAULT_STRICTNESS: DetectorStrictness = STRICTNESS_NAMES.normal;

/** A result's strictness as a number — a name from before the slider is its
 *  number, nothing at all is Normal. */
export function strictnessLevel(raw: number | string | null | undefined): DetectorStrictness {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.min(100, Math.max(0, Math.round(raw)));
  if (typeof raw === 'string' && raw in STRICTNESS_NAMES) {
    return STRICTNESS_NAMES[raw as keyof typeof STRICTNESS_NAMES];
  }
  return DEFAULT_STRICTNESS;
}

/** "Strict", "Normal", "Loose" at the ends and the middle; the number between. */
export function strictnessName(level: DetectorStrictness): string {
  if (level === STRICTNESS_NAMES.strict) return 'Strict';
  if (level === STRICTNESS_NAMES.normal) return 'Normal';
  if (level === STRICTNESS_NAMES.loose) return 'Loose';
  return String(level);
}

/** Where a detector reads its drums. "auto" is the separated kit (Drum kit,
 *  separated) where the song has been split and the drums stem's three bands
 *  otherwise. Mirrors DRUM_SOURCES in tools/python/generators/drum_hits.py. */
export type DrumSource = 'auto' | 'kit' | 'bands';
export const DRUM_SOURCES: readonly DrumSource[] = ['auto', 'kit', 'bands'];
/** The detector that splits the drums into the kit — private, so a server may
 *  not have it, and then there is nothing to choose. */
export const DRUM_KIT_DETECTOR = 'drum_kit_split';
/** `names` in run order: the kit split first, since every run that reads
 *  drums records the kit it read and goes out of date when the kit is split
 *  after it. The rest keep their order. Mirrors the job loop in vite.config.ts. */
export function kitFirst(names: readonly string[]): string[] {
  return [...names.filter((n) => n === DRUM_KIT_DETECTOR), ...names.filter((n) => n !== DRUM_KIT_DETECTOR)];
}
/** The detector that measures a lyrics lane's held notes for Extract ADSR —
 *  private, so where it is not installed the browser reads them instead. */
export const LYRIC_ENVELOPES_DETECTOR = 'lyric_envelopes';

/** A detector word's envelope, milliseconds (see CustomLyricsItem.envelope). */
export type CustomLyricsEnvelope = NonNullable<CustomLyricsItem['envelope']>;

/** What Extract ADSR on a lyrics lane hands back: every word sent, by id — its envelope,
 *  or null for a word that is not held (too short, or the voice does not stay
 *  up across it). `left_out` counts the long words that got null, and why. */
export interface LyricEnvelopesMeasure {
  envelopes: Record<string, CustomLyricsEnvelope | null>;
  min_held_s: number;
  long: number;
  left_out: { quiet: number; unheld: number };
}

export function drumSourceName(source: DrumSource): string {
  return source === 'kit' ? 'Kit' : source === 'bands' ? 'Bands' : 'Auto';
}

/** Where a detector reads the song's sections. "auto" is the annotator's
 *  first boundaries layer where they have one, All-In-One otherwise. Mirrors
 *  SECTION_SOURCES in tools/python/custom_runner.py. */
export type SectionSource = 'auto' | 'annotated' | 'allin1';

/** One choice of a detector's `sources` picker: Held lyrics reads your lyrics
 *  or one model's. Mirrors CustomDetector.sources in tools/python/custom_api.py. */
export interface DetectorSource {
  name: string; label: string; hint: string;
  /** Shown under this heading, with the others of its group (absent: on top). */
  group?: string;
}
export const SECTION_SOURCES: readonly SectionSource[] = ['auto', 'annotated', 'allin1'];

export function sectionSourceName(source: SectionSource | 'none'): string {
  return source === 'annotated' ? 'Annotated' : source === 'allin1' ? 'All-In-One' : source === 'none' ? 'None' : 'Auto';
}

/** Why a run that read drums is out of date against the kit run on screen
 *  (`kit`, the drum_kit_split envelope), or null. The kit can be split for the
 *  first time, split again, or deleted after a lane was read from it, and
 *  nothing else ties the two runs together. */
export function drumReadStale(env: CustomResultEnvelope | undefined, kit: CustomResultEnvelope | undefined): string | null {
  const read = env?.drum_read;
  if (!env || env.fatal || !read || !('kit_ran_at' in read) || env.drum_source === 'bands') return null;
  const now = kit && !kit.fatal && kit.lanes?.length ? kit.ran_at : null;
  const then = read.kit_ran_at ?? null;
  if (now === then) return null;
  if (then === null) return 'Read from the drums stem\'s bands before the kit was split (Drum kit, separated). Run it again to read each drum from its own stem.';
  if (now === null) return 'Read from a separated kit run that is no longer there. Run it again.';
  return 'Read from an earlier run of Drum kit, separated; the kit has been split again since. Run it again.';
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
    | CustomRiffItem
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
  /** A `riff` detector's library, beside its items: its nodes (and combos),
   *  in the shape a Riff Patterns layer stores them. Mirrors `Riff` in
   *  tools/python/custom_api.py (`_validate_riff` in custom_runner.py). */
  nodes?: CustomRiffNode[];
  combos?: (Omit<RiffCombo, 'color'> & { color?: string })[];
  /** The drum a `riff` lane plays, for a groove — "kick", "snare", "hat" … */
  drum?: string;
  /** A `riff` lane's big picture in one line, when the detector has one. */
  summary?: string;
  /** On a `lanes` detector (output_kind 'lanes'): its lanes, each one kind's
   *  items, validated as that kind's are. `items` is then empty. Mirrors
   *  `Lane` in tools/python/custom_api.py and `_validate_lanes` in
   *  custom_runner.py. */
  lanes?: CustomLane[];
  /** The setting it was read at, for a detector that offers a strictness —
   *  0-100, or 'strict' / 'normal' / 'loose' on a result cached before the
   *  slider (read it with `strictnessLevel`). Absent for every other
   *  detector, and on results from before the choice. */
  strictness?: DetectorStrictness | keyof typeof STRICTNESS_NAMES;
  /** The drum source it was asked for, for a detector that offers the choice.
   *  Absent for every other detector, and on results from before it (Auto). */
  drum_source?: DrumSource;
  /** What a run that read drums actually read: `source` once it read hits,
   *  and `kit_ran_at` — the Drum kit, separated run it read, or null for none
   *  — once it looked for the kit. Absent on a run that read no drums. */
  drum_read?: { source?: 'kit' | 'bands'; kit_ran_at?: string | null };
  /** The section source it was asked for, for a detector that offers the
   *  choice (Auto when absent). */
  section_source?: SectionSource;
  /** Which sections it actually read: the annotator's layer (`layer` is its
   *  name), All-In-One (`layer` is the file), or none (the whole song). */
  section_read?: { source?: 'annotated' | 'allin1' | 'none'; layer?: string };
  /** The source it was asked for, for a detector that declares `sources`. */
  source?: string;
  /** What it actually read — on Auto, which source Auto came to. */
  source_read?: { source?: string };
  /** The switches it was read with, name → ticked, for a detector that
   *  declares any. */
  switches?: Record<string, boolean>;
  /** On a window run: the range it heard, in song ms. Its items are in song
   *  time and inside this range. */
  window?: {
    start_ms: number;
    end_ms: number;
    /** On a run narrowed to some stems: which, and the parts (label
     *  prefixes) they carry — the only items its Replace removes. */
    stems?: string[];
    parts?: string[];
  };
  /** On a window run: the handle that Merges or Replaces it into the lane.
   *  The server holds the run's items; the client never sends them back. */
  window_token?: string;
  /** On a cached output: every window run folded into it since the last
   *  whole-song run. Absent when the output is one whole-song run. */
  window_runs?: CustomWindowRun[];
  /** On a `lanes` detector's cached output: each lane deleted from it since
   *  the last whole-song run, which brings them back. */
  dropped_lanes?: { id: string; label: string; dropped_at: string }[];
}

/** One lane of a `lanes` detector's run. Lanes sharing a `group` are drawn in
 *  one band ("Kick": the kick's notes and its loop). */
export interface CustomLane {
  id: string;
  label: string;
  output_kind: CustomLaneKind;
  group: string | null;
  items: CustomResultEnvelope['items'];
  /** A `riff` detector's library, beside its items: its nodes (and combos),
   *  in the shape a Riff Patterns layer stores them. Mirrors `Riff` in
   *  tools/python/custom_api.py (`_validate_riff` in custom_runner.py). */
  nodes?: CustomRiffNode[];
  combos?: (Omit<RiffCombo, 'color'> & { color?: string })[];
  /** The drum a `riff` lane plays, for a groove — "kick", "snare", "hat" … */
  drum?: string;
  /** A `riff` lane's big picture in one line, when the detector has one. */
  summary?: string;
}

export interface CustomWindowRun {
  start_ms: number;
  end_ms: number;
  mode: 'merge' | 'replace';
  ran_at: string;
  added: number;
  removed: number;
  duplicates: number;
}

/** One caveat about a run. `code` is stable and machine-readable (e.g.
 *  `empty-band:hat`); `message` is written for a curator to act on. */
export interface CustomRunNote {
  code: string;
  message: string;
}
