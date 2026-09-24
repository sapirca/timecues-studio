#!/usr/bin/env node
/**
 * Export a song's annotations to tool-agnostic timing files: Audacity-style
 * label tracks (.txt) plus a structured JSON manifest. Any tool that reads
 * Audacity "Export Labels" format (DAWs, Audacity, visualizers, lighting
 * rigs, scripts) can consume the output — TimeCues owns the export so no
 * consumer has to re-implement it.
 *
 * All sources are TimeCues' own data (see DATA.md). Times are rounded (never
 * truncated) to the configured precision — 3 decimals (millisecond) by
 * default, matching roundTime() in web-app/src/utils/beatGrid.ts.
 *
 * Usage:
 *   node tools/export-timing-files.mjs <slug> --annotator <id> [options]
 *   node tools/export-timing-files.mjs --all --annotator <id> [options]
 *
 * Options:
 *   --annotator <id>   Annotator whose layers are exported (required).
 *                      `shared` reads the collaborative team document
 *                      (annotations/shared/<slug>/layers.json) instead of
 *                      one person's copy — on a song the team works on
 *                      together, that IS the annotation.
 *   --all              Export every song under song-info/ for that annotator.
 *   --out <dir>        Output root (default: exports/timing). Each song is
 *                      written to <dir>/<slug>/.
 *   --precision <n>    Decimal places for exported times, 2–6 (default 3).
 *                      Mirrors the timePrecisionDecimals Settings control.
 *   --default          Read from data-default/ instead of data/.
 *
 * Writes per song into <out>/<slug>/:
 *   <slug>_beats.txt            POINT  chosen detector's beat_times
 *   <slug>_bars.txt             POINT  downbeats (every Nth beat)
 *   <slug>_key_points.txt       SPAN   cues + spans + loops layers, merged
 *   <slug>_pattern.txt          SPAN   riff-pattern instances
 *   <slug>_lyrics.txt           SPAN   lyrics layers (words / lines)
 *   <slug>_sections_labels.txt  POINT  boundary sections
 *   <slug>_sections.json        JSON   { song, annotated_at, sections[] }
 *   bpm.txt                     number single BPM value
 *   <slug>_info.txt             text   human-readable summary
 *   <slug>_annotations.json     JSON   self-describing per-layer manifest
 *
 * TWO CONTRACTS, ON PURPOSE. The .txt label tracks are Audacity's format:
 * three columns, start/end/label, and nothing else will ever fit in them.
 * The JSON manifest has no such limit, and for a long time behaved as though
 * it did — it reduced every item to the same three columns, so each attribute
 * added to an annotation after the exporter was written (prominence, pulse,
 * importance, the ⚡ Energy measurement, the beat stamps) was recorded by the
 * app and then dropped at this border. Anything downstream — a light show, a
 * model, a collaborator's DAW — saw a bare interval with a name on it.
 *
 * So the manifest now carries everything the annotation carries, and the rule
 * for future fields is: a new key on an item type is a new key here. The
 * guard at .claude/hooks/export_guard.py fails the build when the schema in
 * web-app/src/types/annotationLayer.ts grows a field this file doesn't mention
 * — that is what keeps the promise true after this commit.
 *
 * Derived values (a pulse's milliseconds, a prominence point's absolute time)
 * are resolved against the grid stamped in the manifest's own `grid` block,
 * and go stale the moment the annotator re-fits the grid. The annotation is
 * the rate and the beat; the seconds are this export's reading of them.
 *
 * Paths below mirror web-app/dataPaths.ts — keep them in sync if folders move.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ── Time precision (mirrors utils/beatGrid.ts) ───────────────────────────────
const DEFAULT_TIME_PRECISION = 3;
const MIN_TIME_PRECISION = 2;
const MAX_TIME_PRECISION = 6;

/** Round a time (seconds) to `decimals` places. Rounds, never truncates —
 *  toFixed returns a string, so re-parse to a number. */
function roundTime(t, decimals) {
  const d = Math.min(MAX_TIME_PRECISION, Math.max(MIN_TIME_PRECISION, Math.round(decimals)));
  return Number(Number(t).toFixed(d));
}

// ── CLI args ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);

function flagValue(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

const ALL = argv.includes('--all');
const USE_DEFAULT = argv.includes('--default');
const ANNOTATOR = flagValue('--annotator', null);
const OUT_ROOT = path.resolve(REPO_ROOT, flagValue('--out', 'exports/timing'));

const PRECISION = (() => {
  const raw = flagValue('--precision', null);
  if (raw == null) return DEFAULT_TIME_PRECISION;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < MIN_TIME_PRECISION || n > MAX_TIME_PRECISION) {
    console.error(`error: --precision must be an integer in ${MIN_TIME_PRECISION}–${MAX_TIME_PRECISION}`);
    process.exit(2);
  }
  return n;
})();

// Positional slug = first non-flag arg that isn't a flag value.
const POSITIONAL = (() => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--annotator' || a === '--out' || a === '--precision') { i++; continue; }
    if (a.startsWith('--')) continue;
    out.push(a);
  }
  return out;
})();

if (!ANNOTATOR) {
  console.error('error: --annotator <id> is required');
  process.exit(2);
}
if (!ALL && POSITIONAL.length !== 1) {
  console.error('error: pass exactly one <slug>, or use --all');
  process.exit(2);
}

// ── Data roots ───────────────────────────────────────────────────────────────
const DATA_DIR = path.join(REPO_ROOT, USE_DEFAULT ? 'data-default' : 'data');
const SONG_INFO_DIR = path.join(DATA_DIR, 'song-info');
const BPM_DIR = path.join(DATA_DIR, 'algorithm-outputs', 'bpm-detections');
// Annotations are per-annotator — EXCEPT the shared team document, which is
// where a collaborative song's real markup lives and which every annotator
// edits in place. It is a different path, not a different format, so
// `--annotator shared` reads it and everything downstream is identical. The
// exporter used to know only the per-person layout, so asking it for a
// collaborative song handed back whatever stale per-person seed existed
// instead of the annotation people had actually been working on.
const SHARED_ANNOTATOR = 'shared';

/** Where one annotator's layers document lives. Mirrors web-app/dataPaths.ts. */
function layersFile(slug) {
  return ANNOTATOR === SHARED_ANNOTATOR
    ? path.join(DATA_DIR, 'annotations', 'shared', slug, 'layers.json')
    : path.join(DATA_DIR, 'annotations', 'layers', ANNOTATOR, `${slug}.json`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function readJsonOrNull(file) {
  try { return readJson(file); }
  catch { return null; }
}

// ── Source resolution ────────────────────────────────────────────────────────

/** Chosen beat detector: madmom-rnn-beats, else librosa-beat-track, else any
 *  algorithm that succeeded and carries beat_times. Returns the algorithm
 *  object or null. */
function pickBeatAlgorithm(bpmDoc) {
  const algos = Array.isArray(bpmDoc?.algorithms) ? bpmDoc.algorithms : [];
  const usable = (a) => a && a.ok && Array.isArray(a.beat_times) && a.beat_times.length > 0;
  const byName = (name) => algos.find((a) => a.source === name && usable(a));
  return byName('madmom-rnn-beats') || byName('librosa-beat-track') || algos.find(usable) || null;
}

function timeSignatureNumerator(info) {
  const ts = info?.timeSignature;
  if (!ts) return 4;
  const n = parseInt(String(ts).split('/')[0], 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** Single BPM value for bpm.txt / info.txt: song-info bpm; else the chosen
 *  detector's bpm; else the median of the song's grid-segment tempos. A
 *  detector's guess is a reasonable thing to print in a summary file. */
function resolveBpm(info, beatAlgo) {
  if (Number.isFinite(info?.bpm)) return info.bpm;
  if (Number.isFinite(beatAlgo?.bpm)) return beatAlgo.bpm;
  const segments = Array.isArray(info?.gridSegments) ? info.gridSegments : [];
  return median(segments.map((g) => g.bpm));
}

/** The tempo of the song's own GRID — what the annotator set or fitted — with
 *  no detector fallback, and `null` when there isn't one.
 *
 *  Deliberately stricter than resolveBpm(). A pulse is a statement about the
 *  grid: the app draws no ticks at all for a span on a song with no tempo,
 *  because a rate resolved against a number nobody chose is a claim about
 *  where the sound is that nothing supports. Deriving "every 125ms" here from
 *  a beat detector's guess would smuggle exactly that claim across the border
 *  the UI refuses to cross. The rate still exports; only the milliseconds are
 *  withheld, which is the same trade the annotator sees on screen. */
function resolveGridBpm(info) {
  if (Number.isFinite(info?.bpm)) return info.bpm;
  const segments = Array.isArray(info?.gridSegments) ? info.gridSegments : [];
  return median(segments.map((g) => g.bpm));
}

// ── Label-track formatting (Audacity "Export Labels") ────────────────────────
// TAB-separated, one record per line, sorted by start, no header, labels
// unquoted. POINT markers emit start == end (three-column form).

function pointLine(t, label) {
  const s = roundTime(t, PRECISION);
  return `${s}\t${s}\t${label ?? ''}`;
}

function spanLine(start, end, label) {
  return `${roundTime(start, PRECISION)}\t${roundTime(end, PRECISION)}\t${label ?? ''}`;
}

/** Serialize point records `{ t, label }`, sorted by time. */
function pointsTrack(records) {
  return records
    .slice()
    .sort((a, b) => a.t - b.t)
    .map((r) => pointLine(r.t, r.label))
    .join('\n');
}

/** Serialize span records `{ start, end, label }`, sorted by start then end. */
function spansTrack(records) {
  return records
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((r) => spanLine(r.start, r.end, r.label))
    .join('\n');
}

// ── Item extraction ──────────────────────────────────────────────────────────
// Two jobs, kept apart, because conflating them is what made this exporter
// lossy in the first place:
//
//   layerItemToRecord()  → { start, end, label }, for the .txt label tracks.
//                          Audacity's format has three columns. This stays
//                          exactly this lossy, forever.
//   manifestItem()       → every field the annotation carries, for the JSON.
//
// A cue / boundary is a point (start == end); a lyric word is a point and a
// lyric line a span; everything else carries start / end.

function layerItemToRecord(type, item) {
  if (type === 'cues' || type === 'boundaries') {
    const t = type === 'cues' ? item.time : item.time;
    return { start: t, end: t, label: item.label ?? '' };
  }
  if (type === 'lyrics') {
    return { start: item.time, end: item.end ?? item.time, label: item.text ?? '' };
  }
  return { start: item.start, end: item.end, label: item.label ?? '' };
}

// ── Pulse ────────────────────────────────────────────────────────────────────
// Mirrors PULSE_RATE_INFO in web-app/src/types/annotationLayer.ts. A pulse is
// a RATE — "eighths through here" — and its ticks are derived from the grid at
// draw time, never stored, which is what keeps it true when the grid is re-fit.
// The same reasoning crosses this border: `rate` IS the annotation and travels
// verbatim; `interval_ms` / `per_bar` are conveniences resolved against the BPM
// recorded in the manifest's `grid` block, and stop being true the moment the
// annotator changes the grid. A consumer that intends to survive a re-fit
// should read the rate and re-derive against its own beat list.
const PULSE_BEATS = {
  '32nd': 1 / 8, '16th-triplet': 1 / 6, '16th': 1 / 4,
  '8th-triplet': 1 / 3, '8th': 1 / 2, beat: 1, bar: 'bar',
};
const PULSE_LABEL = {
  '32nd': '1/8 beat', '16th-triplet': '1/6 beat · triplet', '16th': '1/4 beat',
  '8th-triplet': '1/3 beat · triplet', '8th': '1/2 beat', beat: 'Beat', bar: 'Bar',
};

function pulseDetail(rate, bpm, beatsPerBar) {
  if (!rate || !(rate in PULSE_BEATS)) return null;
  const raw = PULSE_BEATS[rate];
  const periodBeats = raw === 'bar' ? Math.max(1, beatsPerBar) : raw;
  const out = { rate, label: PULSE_LABEL[rate], period_beats: roundTime(periodBeats, 6) };
  if (Number.isFinite(bpm) && bpm > 0) {
    out.interval_ms = Math.round(periodBeats * (60 / bpm) * 1000);
    out.per_bar = roundTime(Math.max(1, beatsPerBar) / periodBeats, 3);
    out.derived_from_bpm = roundTime(bpm, PRECISION);
  }
  return out;
}

// ── ⚡ Energy ────────────────────────────────────────────────────────────────
/** An energy span stores its whole measurement as JSON text in `description`
 *  (see parseEnergySpanExport in web-app/src/utils/energySpan.ts — the lane
 *  reads it back the same way). Passing that through as a description would
 *  hand every consumer a blob to re-parse, so it is lifted into its own
 *  `energy` key and the description is dropped: it was never prose. Anything
 *  that fails to parse stays a description, because then it IS prose. */
function parseEnergyDescription(description) {
  if (typeof description !== 'string') return null;
  const text = description.trim();
  if (!text.startsWith('{') || !text.includes('energy_span')) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || parsed.type !== 'energy_span') return null;
    if (!Array.isArray(parsed.curve) || !parsed.curve.length) return null;
    // The curve is ~one RMS frame per 10ms and is the bulkiest thing in the
    // export; it is kept (dropping data is the bug being fixed here) but
    // rounded, since three decimals is well past what a normalized loudness
    // reading means.
    return { ...parsed, curve: parsed.curve.map((v) => roundTime(v, 3)) };
  } catch {
    return null;
  }
}

// ── Prominence ───────────────────────────────────────────────────────────────
/** Breakpoints are stored item-relative (`t` counted from the item's own
 *  start), because that is what makes them survive the item being dragged.
 *  Every consumer of a timing export works in track seconds, so both are
 *  written: `t` as annotated, `at` as the moment it actually happens. */
function prominenceOut(env, startSec) {
  if (!Array.isArray(env) || !env.length) return null;
  return env
    .slice()
    .sort((a, b) => (a.t ?? 0) - (b.t ?? 0))
    .map((pt) => {
      const t = Number(pt.t) || 0;
      const out = { t: roundTime(t, PRECISION), at: roundTime(startSec + t, PRECISION), level: pt.level };
      if (pt.ramp) out.ramp = pt.ramp;
      return out;
    });
}

/** The arc in one phrase — "lead → backing" — so a reader that is not going to
 *  walk the breakpoints still learns the shape. */
function prominenceSummary(env) {
  if (!Array.isArray(env) || !env.length) return null;
  const levels = env.slice().sort((a, b) => (a.t ?? 0) - (b.t ?? 0)).map((p) => p.level);
  const runs = levels.filter((l, i) => i === 0 || l !== levels[i - 1]);
  return runs.join(' → ');
}

// ── Manifest items ───────────────────────────────────────────────────────────
// Every optional key is omitted when absent rather than written as null: an
// absent `pulse` means "nobody annotated a pulse", and that is not the same
// statement as "the pulse is nothing".

/** Beats are not seconds: `--precision` is a statement about time, and a beat
 *  stamped from a time lands on things like 64.00053333333334. Six places is
 *  far below a musical distinction and keeps the file readable. */
function roundBeat(b) {
  return Number.isFinite(b) ? Number(Number(b).toFixed(6)) : b;
}

function setIf(out, key, value) {
  if (value !== undefined && value !== null && value !== '') out[key] = value;
  return out;
}

/** Fields every authored item can carry, whatever its kind. */
function commonItemFields(out, item, startSec) {
  setIf(out, 'description', item.description);
  setIf(out, 'importance', item.importance);
  setIf(out, 'prominence', prominenceOut(item.prominence, startSec));
  setIf(out, 'prominence_summary', prominenceSummary(item.prominence));
  setIf(out, 'candidates', Array.isArray(item.candidates) && item.candidates.length
    ? item.candidates.map((c) => (Array.isArray(c)
      ? [roundTime(c[0], PRECISION), roundTime(c[1], PRECISION)]
      : roundTime(c, PRECISION)))
    : null);
  return out;
}

/** One riff sequence entry — `type` is a node id, a combo id, or the silence
 *  sentinel. Resolved to a name here so a reader doesn't have to join tables
 *  to learn what is playing; the id is kept beside it for one that does. */
function riffEntryOut(entry, nameById) {
  const out = { ref: entry.type, length_steps: entry.lengthSteps };
  const name = nameById.get(entry.type);
  if (name) out.name = name;
  else if (entry.type === '__silence__') out.name = 'silence';
  return out;
}

function riffNodeOut(node) {
  const out = {
    id: node.id,
    name: node.name,
    kind: node.kind ?? 'grid',
    steps_per_cycle: node.stepsPerCycle,
    subbeats_per_beat: node.subbeatsPerBeat,
  };
  if (Array.isArray(node.highlightedBeats) && node.highlightedBeats.length) {
    out.ticks = node.highlightedBeats.slice().sort((a, b) => a - b);
  }
  if (Array.isArray(node.spans) && node.spans.length) out.holds = node.spans;
  // How hard each step is struck, 1..127, for the steps a detector measured.
  // Sparse by design: a step with no entry is played at full strength, which
  // is every step of a hand-drawn node, so an empty map is omitted entirely.
  if (node.accents && Object.keys(node.accents).length) {
    out.accents = Object.fromEntries(
      Object.entries(node.accents)
        .map(([step, v]) => [Number(step), Number(v)])
        .sort((a, b) => a[0] - b[0]),
    );
  }
  if (Array.isArray(node.segments) && node.segments.length) {
    // Boundary nodes quantise nothing: these are beat offsets from the node's
    // own start, and rounding them to a grid here would be the exact lie the
    // node kind exists to avoid.
    out.segments = node.segments.map((sg) => {
      const o = { start: roundBeat(sg.start), end: roundBeat(sg.end), kind: sg.kind };
      setIf(o, 'label', sg.label);
      return o;
    });
  }
  return out;
}

/** The manifest form of one item. `grid` supplies bpm / beats-per-bar for the
 *  derived fields; `nameById` resolves riff sequence references. */
function manifestItem(type, item, grid, nameById) {
  const r = layerItemToRecord(type, item);
  const start = roundTime(r.start, PRECISION);
  const out = { id: item.id, start, end: roundTime(r.end, PRECISION), label: r.label };

  if (type === 'lyrics') {
    // A lyric carries no label/description/importance — its text IS its label,
    // and `kind` says whether it is a word or a whole line.
    out.text = item.text ?? '';
    out.kind = item.kind ?? 'word';
    setIf(out, 'beat', roundBeat(item.beat));
    return out;
  }

  if (type === 'cues' || type === 'boundaries') {
    setIf(out, 'beat', roundBeat(item.beat));
    if (type === 'boundaries') out.section_type = item.type ?? 'unset';
    if (type === 'cues') {
      // A struck hit: how hard (1-127, per instrument), how loud (dB against
      // the track's loudest hit), and the hue its detector drew it in.
      setIf(out, 'velocity', item.velocity);
      setIf(out, 'level_db', item.levelDb);
      setIf(out, 'color', item.color);
      // Pitch (MIDI 0-127) and how long it rings, for a MIDI / light consumer.
      setIf(out, 'note', item.note);
      setIf(out, 'decay', typeof item.decay === 'number' ? roundTime(item.decay, PRECISION) : null);
    }
    return commonItemFields(out, item, start);
  }

  setIf(out, 'start_beat', roundBeat(item.startBeat));
  setIf(out, 'end_beat', roundBeat(item.endBeat));

  if (type === 'spans') {
    const energy = parseEnergyDescription(item.description);
    setIf(out, 'pulse', pulseDetail(item.pulse, grid.bpm, grid.beatsPerBar));
    commonItemFields(out, item, start);
    if (energy) { delete out.description; out.energy = energy; }
    return out;
  }

  if (type === 'loops') {
    setIf(out, 'bars', item.bars);
    if (item.snapZeroCross) out.snap_zero_cross = true;
    return commonItemFields(out, item, start);
  }

  if (type === 'riff-patterns') {
    out.repeats = item.repeatCount;
    out.sequence = (item.sequence ?? []).map((e) => riffEntryOut(e, nameById));
    setIf(out, 'duplicate_of', item.duplicateOfId);
    return commonItemFields(out, item, start);
  }

  return commonItemFields(out, item, start);
}

const KEY_POINT_TYPES = new Set(['cues', 'spans', 'loops']);
// Every authored layer type reaches the manifest. It used to be four, one of
// which ('patterns') had since been retired from the app — so riff patterns
// and lyrics, both of which a person can spend an afternoon annotating, were
// exported nowhere at all.
const MANIFEST_TYPES = new Set(['boundaries', 'cues', 'spans', 'loops', 'lyrics', 'riff-patterns']);

// ── Per-song export ──────────────────────────────────────────────────────────

function exportSong(slug, generatedAt) {
  const info = readJsonOrNull(path.join(SONG_INFO_DIR, `${slug}.json`));
  const bpmDoc = readJsonOrNull(path.join(BPM_DIR, `${slug}.json`));
  const layersDoc = readJsonOrNull(layersFile(slug));

  const beatAlgo = pickBeatAlgorithm(bpmDoc);
  const beats = beatAlgo?.beat_times ?? [];
  const numerator = timeSignatureNumerator(info);
  const layers = Array.isArray(layersDoc?.layers) ? layersDoc.layers : [];
  // Sections come from the FIRST boundaries layer — the same single track the
  // old singleton manual document held. Extra boundary layers are an editing
  // affordance; the exported .txt/.json contract stays one sections track.
  const boundaryLayer = layers.find((l) => l.type === 'boundaries') ?? null;
  const sections = Array.isArray(boundaryLayer?.items) ? boundaryLayer.items : [];

  const outDir = path.join(OUT_ROOT, slug);
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  const write = (name, contents) => {
    const file = path.join(outDir, name);
    // Label tracks / text files get a trailing newline; JSON keeps its own.
    fs.writeFileSync(file, contents, 'utf-8');
    written.push(name);
  };

  // 1. beats.txt — POINT, label b0, b1, …
  write(`${slug}_beats.txt`, pointsTrack(
    beats.map((t, i) => ({ t, label: `b${i}` })),
  ) + '\n');

  // 2. bars.txt — POINT, downbeats = every Nth beat, label bar 0, bar 1, …
  const bars = [];
  for (let i = 0; i < beats.length; i += numerator) {
    bars.push({ t: beats[i], label: `bar ${i / numerator}` });
  }
  write(`${slug}_bars.txt`, pointsTrack(bars) + '\n');

  // 3. key_points.txt — SPAN, cues + spans + loops layers merged.
  const keyPoints = [];
  for (const layer of layers) {
    if (!KEY_POINT_TYPES.has(layer.type)) continue;
    for (const item of layer.items ?? []) keyPoints.push(layerItemToRecord(layer.type, item));
  }
  write(`${slug}_key_points.txt`, spansTrack(keyPoints) + '\n');

  // 4. pattern.txt — SPAN, riff-pattern instances. (This file used to read
  // layers of type 'patterns', a type the app retired when LoCoMotif landed as
  // riff patterns — so it had been exporting an empty file for every song.)
  const patterns = [];
  for (const layer of layers) {
    if (layer.type !== 'riff-patterns') continue;
    for (const item of layer.items ?? []) {
      const r = layerItemToRecord('riff-patterns', item);
      const reps = Number(item.repeatCount) > 1 ? ` ×${item.repeatCount}` : '';
      patterns.push({ ...r, label: `${r.label}${reps}` });
    }
  }
  write(`${slug}_pattern.txt`, spansTrack(patterns) + '\n');

  // 4b. lyrics.txt — SPAN, lyrics layers. Words are points (start == end),
  // lines carry their own end. Never exported before at all.
  const lyrics = [];
  for (const layer of layers) {
    if (layer.type !== 'lyrics') continue;
    for (const item of layer.items ?? []) lyrics.push(layerItemToRecord('lyrics', item));
  }
  write(`${slug}_lyrics.txt`, spansTrack(lyrics) + '\n');

  // 5. sections_labels.txt — POINT, boundary sections.
  write(`${slug}_sections_labels.txt`, pointsTrack(
    sections.map((s) => ({ t: s.time, label: s.label ?? '' })),
  ) + '\n');

  // 6. sections.json — structured sections.
  const sortedSections = sections
    .slice()
    .sort((a, b) => a.time - b.time)
    .map((s) => ({ time: roundTime(s.time, PRECISION), type: s.type ?? 'unset', label: s.label ?? '' }));
  write(`${slug}_sections.json`, JSON.stringify({
    song: slug,
    annotated_at: layersDoc?.annotated_at ?? null,
    sections: sortedSections,
  }, null, 2) + '\n');

  // 7. bpm.txt — single BPM value.
  const bpm = resolveBpm(info, beatAlgo);
  write('bpm.txt', bpm == null ? '' : `${roundTime(bpm, PRECISION)}\n`);

  // 8. info.txt — human-readable summary.
  const laneCounts = layers
    .filter((l) => MANIFEST_TYPES.has(l.type))
    .map((l) => `${l.name ?? l.type} (${l.type}): ${(l.items ?? []).length}`);
  const infoLines = [
    `title: ${info?.title ?? slug}`,
    `artist: ${info?.artist ?? ''}`,
    `bpm: ${bpm == null ? '' : roundTime(bpm, PRECISION)}`,
    `time signature: ${info?.timeSignature ?? '4/4'}`,
    `grid mode: ${info?.gridMode ?? 'static'}`,
    `sections: ${sortedSections.map((s) => s.label).join(', ')}`,
    // What a reader would otherwise have to open the JSON to discover — most
    // usefully, that a song HAS lyrics or riff patterns at all.
    `layers: ${laneCounts.length ? laneCounts.join('; ') : '(none)'}`,
  ];
  write(`${slug}_info.txt`, infoLines.join('\n') + '\n');

  // 9. annotations.json — self-describing per-layer manifest.
  //
  // The grid every derived number in this file was resolved against. Stamped
  // because a pulse's milliseconds, a prominence point's absolute second and
  // (under Grid Lock) an item's `start` itself all move when the annotator
  // re-fits the grid — and an export is a snapshot, not a subscription. A
  // consumer holding an older `grid.signature` than the song now has is
  // holding stale seconds and should re-import; the beat stamps and the pulse
  // rate beside them are the parts that survived the change.
  const gridBpm = resolveGridBpm(info);
  const grid = {
    bpm: gridBpm == null ? null : roundTime(gridBpm, PRECISION),
    // Where that tempo came from, because "the annotator fitted 124" and "a
    // detector guessed 124" are different facts and only the first one can be
    // relied on to place a beat.
    bpm_source: Number.isFinite(info?.bpm) ? 'song-info'
      : (Array.isArray(info?.gridSegments) && info.gridSegments.length ? 'grid-segments' : null),
    detected_bpm: Number.isFinite(beatAlgo?.bpm) ? roundTime(beatAlgo.bpm, PRECISION) : null,
    time_signature: info?.timeSignature ?? '4/4',
    beats_per_bar: numerator,
    grid_offset: roundTime(info?.gridOffset ?? 0, PRECISION),
    grid_mode: info?.gridMode ?? 'static',
    beat_overrides: Object.keys(info?.beatOverrides ?? {}).length || 0,
  };
  const segs = Array.isArray(info?.gridSegments) ? info.gridSegments : [];
  if (segs.length) {
    grid.segments = segs.map((g) => ({
      start: roundTime(g.start, PRECISION),
      bpm: roundTime(g.bpm, PRECISION),
      time_signature: g.timeSignature ?? grid.time_signature,
    }));
  }
  // Mirrors gridSignature() in web-app/src/utils/beatAnchoring.ts closely
  // enough to answer the only question asked of it: "is this the same grid the
  // export was made against?"
  grid.signature = [
    `bpm=${grid.bpm}`, `off=${grid.grid_offset}`, `ts=${grid.time_signature}`,
    `mode=${grid.grid_mode}`, `segs=${(grid.segments ?? []).map((g) => `${g.start}@${g.bpm}`).join(',')}`,
  ].join(';');

  const lanes = [];
  for (const layer of layers) {
    if (!MANIFEST_TYPES.has(layer.type)) continue;
    // Riff sequences reference nodes and combos by id; resolve the names once
    // per layer so each entry can carry the readable one.
    const nameById = new Map();
    for (const n of layer.nodes ?? []) nameById.set(n.id, n.name);
    for (const c of layer.combos ?? []) nameById.set(c.id, c.name);

    const items = (layer.items ?? [])
      .map((item) => manifestItem(layer.type, item, { bpm: gridBpm, beatsPerBar: numerator }, nameById))
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const lane = {
      id: `layer:${layer.id}`,
      source: 'layers',
      type: layer.type,
      name: layer.name ?? layer.type,
      color: layer.color ?? null,
      count: items.length,
      items,
    };
    if (layer.readOnly) lane.read_only = true;
    setIf(lane, 'stem', layer.sourceStem);
    setIf(lane, 'detector', layer.importedFrom ?? (typeof layer.source === 'string' && layer.source.startsWith('detector:') ? layer.source.slice('detector:'.length) : null));
    setIf(lane, 'detector_description', layer.sourceDescription);
    // Caveats the detector raised about the run that produced this lane. They
    // matter MORE out here than in the app: a curator can hover the lane's ⓘ
    // and see them, while a light show or a training set reads the manifest
    // and nothing else. A groove built on hits that could not be named looks
    // identical to one built on clean hits, so dropping these at the border
    // would turn "we could not tell" into silence, which reads as "fine".
    if (Array.isArray(layer.sourceNotes) && layer.sourceNotes.length) {
      lane.detector_notes = layer.sourceNotes.map((n) => ({
        code: String(n.code ?? ''),
        message: String(n.message ?? ''),
      }));
    }
    setIf(lane, 'eval_mode', layer.mode);
    setIf(lane, 'group', layer.groupId);
    // Riff nodes/combos are the motif library the instances above are made of:
    // without them a sequence entry is an opaque uuid.
    if (Array.isArray(layer.nodes) && layer.nodes.length) {
      lane.nodes = layer.nodes.map(riffNodeOut);
    }
    if (Array.isArray(layer.combos) && layer.combos.length) {
      lane.combos = layer.combos.map((c) => ({
        id: c.id, name: c.name,
        sequence: (c.sequence ?? []).map((e) => riffEntryOut(e, nameById)),
      }));
    }
    // A lyrics layer's prominence lives on its vocal runs, not on its words —
    // one arc per sung stretch. Absent means "derived on read", not "none".
    if (Array.isArray(layer.vocalRuns) && layer.vocalRuns.length) {
      lane.vocal_runs = layer.vocalRuns.map((r) => {
        const o = { start: roundTime(r.start, PRECISION), end: roundTime(r.end, PRECISION) };
        setIf(o, 'prominence', prominenceOut(r.prominence, r.start));
        setIf(o, 'prominence_summary', prominenceSummary(r.prominence));
        return o;
      });
    }
    lanes.push(lane);
  }
  // The `sections` lane is the song's structure under the name every existing
  // consumer already reads. It duplicates the first boundaries lane above (now
  // exported like any other layer, with its descriptions and candidates
  // intact) — kept rather than replaced, because something out there reads
  // `type: "sections"` and a rename would break it for no gain.
  const sectionItems = sections
    .map((sec) => {
      const item = manifestItem('boundaries', sec, { bpm: gridBpm, beatsPerBar: numerator }, new Map());
      item.kind = sec.type ?? 'unset';
      return item;
    })
    .sort((a, b) => a.start - b.start);
  lanes.push({
    id: 'sections',
    source: 'layers',
    type: 'sections',
    name: 'Sections',
    count: sectionItems.length,
    items: sectionItems,
  });
  const groups = (layersDoc?.groups ?? []).map((g) => ({
    id: g.id, name: g.name, color: g.color ?? null,
  }));
  write(`${slug}_annotations.json`, JSON.stringify({
    song: slug,
    annotator: ANNOTATOR,
    generated_at: generatedAt,
    // Bumped when the shape of what's below changes. v1 was start/end/label
    // and nothing else; v2 carries every field the annotation carries.
    schema_version: 2,
    precision: PRECISION,
    grid,
    groups,
    lanes,
  }, null, 2) + '\n');

  return { outDir, written, warnings: collectWarnings({ info, bpmDoc, beatAlgo, layersDoc, boundaryLayer }) };
}

function collectWarnings({ info, bpmDoc, beatAlgo, layersDoc, boundaryLayer }) {
  const w = [];
  if (!info) w.push('no song-info (using defaults for bpm / time signature / title)');
  if (!bpmDoc) w.push('no bpm-detections (beats / bars will be empty)');
  else if (!beatAlgo) w.push('no usable beat detector in bpm-detections (beats / bars empty)');
  if (!layersDoc) w.push('no layers file for this annotator (key_points / pattern empty)');
  if (!boundaryLayer) w.push('no boundaries layer for this annotator (sections empty)');
  return w;
}

// ── Song list ────────────────────────────────────────────────────────────────

function listSlugs() {
  if (!ALL) return POSITIONAL;
  if (!fs.existsSync(SONG_INFO_DIR)) return [];
  return fs.readdirSync(SONG_INFO_DIR)
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.replace(/\.json$/, ''))
    .sort();
}

function main() {
  const slugs = listSlugs();
  if (!slugs.length) {
    console.error('error: no songs to export');
    process.exit(1);
  }

  const generatedAt = new Date().toISOString();
  console.log(`Exporting ${slugs.length} song(s) — annotator=${ANNOTATOR}, precision=${PRECISION}, corpus=${USE_DEFAULT ? 'data-default' : 'data'}`);

  for (const slug of slugs) {
    const { outDir, written, warnings } = exportSong(slug, generatedAt);
    console.log(`\n${slug} → ${path.relative(REPO_ROOT, outDir)}/`);
    console.log(`  wrote ${written.length} files: ${written.join(', ')}`);
    for (const warn of warnings) console.log(`  ! ${warn}`);
  }
  console.log('\nDone.');
}

main();
