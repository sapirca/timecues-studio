#!/usr/bin/env node
/**
 * Export a song's annotations to tool-agnostic timing files: Audacity-style
 * label tracks (.txt) plus a structured JSON manifest. Any tool that reads
 * Audacity "Export Labels" format (DAWs, Audacity, visualizers, lighting
 * rigs, scripts) can consume the output — TimeCues owns the export so no
 * consumer has to re-implement it.
 *
 * All sources are TimeCues' own data (see docs/DATA.md). Times are rounded (never
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
 *   --with-notes       Export detected cue lanes as their rows, not as a
 *                      summary (see isDetectedHitStream). Off by default.
 *   --detectors        Also write <slug>_detectors.txt: every detector that
 *                      ran on the song, summarised per group (detectorBlock).
 *   --units <u>        `seconds` (default) or `beats`. Beats writes every
 *                      position as fractional beats from the grid origin
 *                      (bar 1, beat 1 = 0; the 3rd 16th of beat 5 = 4.5):
 *                      the .txt columns, sections.json, and the manifest,
 *                      which then drops each seconds field that has a beat
 *                      twin (`start` beside `start_beat`) and converts the
 *                      ones that have none, under a name that says so
 *                      (candidate_beats, an envelope's peak_beat,
 *                      prominence at_beat, a cue's decay_beats).
 *                      `units: "beats"` heads the manifest, and its `grid`
 *                      block — bpm, grid_offset, time signature, tempo_map —
 *                      is what turns a beat back into a second. A song with
 *                      no grid cannot be written in beats and is skipped.
 *
 * Writes per song into <out>/<slug>/:
 *   <slug>_beats.txt            POINT  the annotator's grid (detector beats if no BPM)
 *   <slug>_bars.txt             POINT  its bar lines, bar 1 at the downbeat
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
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ── The app's own grid code ──────────────────────────────────────────────────
// beats.txt / bars.txt are the grid the annotator sees, so they come from the
// same functions that draw it (resolveGridSegments + visibleGridLines), not a
// copy of them. Node runs the .ts directly (type stripping, Node ≥ 22.18);
// the hook only adds the `.ts` the app's extensionless imports leave off.
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (e) {
    if (/^\\.\\.?\\//.test(spec) && !/\\.[cm]?[jt]s$/.test(spec)) return next(spec + '.ts', ctx);
    throw e;
  }
}`));
const APP_SRC = path.join(REPO_ROOT, 'web-app', 'src');
const appModule = (rel) => import(pathToFileURL(path.join(APP_SRC, rel)).href);
const { resolveGridSegments } = await appModule('utils/gridSegments.ts');
const { visibleGridLines, beatsPerBarFromTimeSignature, beatPositionAt } = await appModule('utils/beatGrid.ts');
const { sanitizeSongInfo, effectiveGridMode } = await appModule('types/songInfo.ts');
const { BEAT_FRACTION_STEPS, gridOf } = await appModule('utils/beatAnchoring.ts');
const { layersGridOf, withSecondsFromBeats } = await appModule('utils/beatTimebase.ts');

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
const WITH_NOTES = argv.includes('--with-notes');
const WITH_DETECTORS = argv.includes('--detectors');
const UNITS = flagValue('--units', 'seconds');
if (UNITS !== 'seconds' && UNITS !== 'beats') {
  console.error('error: --units must be `seconds` or `beats`');
  process.exit(2);
}
const IN_BEATS = UNITS === 'beats';
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
    if (a === '--annotator' || a === '--out' || a === '--precision' || a === '--units') { i++; continue; }
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
  return beatsPerBarFromTimeSignature(info?.timeSignature);
}

/** The song's beat and bar lines as the annotator's grid draws them — the
 *  downbeat they placed (gridOffset), the tempo map in Mapped mode, pinned
 *  beats in Manual mode — over [0, durationSec]. Beats before the downbeat
 *  (the pickup) are included, as on screen; bars are numbered from 1 at the
 *  downbeat. null when the song has no grid yet (no BPM). */
function userGridLines(info, durationSec) {
  if (!info || !(durationSec > 0)) return null;
  const clean = sanitizeSongInfo(info);
  const segments = resolveGridSegments(clean);
  if (!segments.length) return null;
  const lines = visibleGridLines({
    bpm: clean.bpm,
    gridOffset: clean.gridOffset ?? 0,
    beatsPerBar: beatsPerBarFromTimeSignature(clean.timeSignature),
    startTime: 0,
    endTime: durationSec,
    beatOverrides: effectiveGridMode(clean) === 'manual' ? clean.beatOverrides : undefined,
    segments,
    barBeatOrigin: 1,
  });
  return {
    beats: lines.map((l) => ({ t: l.t, label: `b${l.beatIndex}` })),
    bars: lines.filter((l) => l.isBar).map((l) => ({ t: l.t, label: `bar ${l.barNumber}` })),
  };
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

// What a column holds: seconds, or under --units beats the song's beat
// position (set per song by exportSong, which owns the grid).
let column = (t) => roundTime(t, PRECISION);

function pointLine(t, label) {
  const s = column(t);
  return `${s}\t${s}\t${label ?? ''}`;
}

function spanLine(start, end, label) {
  return `${column(start)}\t${column(end)}\t${label ?? ''}`;
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

// ── Beats-only items (--units beats) ─────────────────────────────────────────
// A manifest item in seconds, restated with no seconds in it. A position that
// already has its beat twin loses the seconds (`start` beside `start_beat`);
// one that has none is converted and renamed so the key says what it holds
// (`candidates` → `candidate_beats`, an envelope's `peak` → `peak_beat`).
// Durations that describe the sound become their length in beats at that
// point of the song (`decay` → `decay_beats`). A riff note's start/end were
// beats from its node's start all along and stay as they are.

const SECONDS_TWINS = [['start', 'start_beat'], ['end', 'end_beat'], ['time', 'beat']];

function inBeats(item, beatAt) {
  const o = { ...item };
  // A point (cue, boundary) has `beat` and start == end.
  if (o.beat !== undefined && o.start_beat === undefined) {
    delete o.start;
    if (o.end_beat === undefined) delete o.end;
  }
  for (const [sec, beat] of SECONDS_TWINS) if (o[beat] !== undefined) delete o[sec];
  if (Array.isArray(o.candidates)) {
    o.candidate_beats = o.candidates.map((c) => (Array.isArray(c) ? c.map(beatAt) : beatAt(c)));
    delete o.candidates;
  }
  if (Array.isArray(o.onsets)) {
    o.onsets = o.onsets.map(({ time, ...rest }) => (rest.beat !== undefined ? rest : { ...rest, beat: beatAt(time) }));
  }
  if (Array.isArray(o.prominence)) {
    o.prominence = o.prominence.map(({ t, at, ...rest }) => ({ at_beat: beatAt(at), ...rest }));
  }
  if (o.envelope) {
    const e = { ...o.envelope };
    for (const k of ['start', 'peak', 'decay_end', 'release', 'end']) {
      if (Number.isFinite(e[k])) e[`${k}_beat`] = beatAt(e[k]);
      delete e[k];
    }
    o.envelope = e;
  }
  if (typeof o.decay === 'number' && Number.isFinite(item.start)) {
    o.decay_beats = Number((beatAt(item.start + o.decay) - beatAt(item.start)).toFixed(6));
    delete o.decay;
  }
  if (o.energy && Number.isFinite(item.start)) o.energy = energyInBeats(o.energy, item.start, beatAt);
  if (o.pulse && 'interval_ms' in o.pulse) {
    o.pulse = { ...o.pulse };
    delete o.pulse.interval_ms;   // period_beats says it without the clock
  }
  return o;
}

/** The ⚡ Energy measurement with its clock taken out: where it starts and
 *  ends is the item's own start_beat / end_beat, each curve point gets the
 *  beat it sits on, and every millisecond length (attack, decay …) becomes
 *  that many beats at the item's tempo. */
function energyInBeats(energy, startSec, beatAt) {
  const e = { ...energy };
  const perSec = beatAt(startSec + 1) - beatAt(startSec);
  const msToBeats = (ms) => Number(((ms / 1000) * perSec).toFixed(6));
  delete e.start_ms; delete e.end_ms;
  if (Number.isFinite(e.duration_ms)) { e.duration_beats = msToBeats(e.duration_ms); delete e.duration_ms; }
  if (Array.isArray(e.curve)) {
    e.curve = e.curve.map((pt) => {
      if (!pt || typeof pt !== 'object' || !Number.isFinite(pt.t_ms)) return pt;
      const { t_ms: tMs, ...rest } = pt;
      return { at_beat: beatAt(startSec + tMs / 1000), ...rest };
    });
  }
  if (e.envelope && typeof e.envelope === 'object') {
    e.envelope = Object.fromEntries(Object.entries(e.envelope).map(([k, v]) => (
      k.endsWith('_ms') && Number.isFinite(v) ? [`${k.slice(0, -3)}_beats`, msToBeats(v)] : [k, v])));
  }
  return e;
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
    // The curve is the bulkiest thing in the export; it is kept (dropping data
    // is the bug being fixed here) but rounded, since three decimals is well
    // past what a normalized reading means. A point is an object — t_ms plus
    // energy, brightness, beat_strength, flux — so each number in it is
    // rounded; rounding the point itself turned every one into null.
    return { ...parsed, curve: parsed.curve.map(roundCurvePoint) };
  } catch {
    return null;
  }
}

function roundCurvePoint(p) {
  if (typeof p === 'number') return roundTime(p, 3);
  if (!p || typeof p !== 'object') return p;
  return Object.fromEntries(Object.entries(p).map(([k, v]) =>
    [k, typeof v === 'number' ? (k === 't_ms' ? Math.round(v) : roundTime(v, 3)) : v]));
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

/** Every item's musical position, from its seconds on the song's grid -- the
 *  same reading beatAnchoring stamps (macro grid, overrides not consulted).
 *  Computed here rather than copied from the stored stamp because lyrics carry
 *  none and the stored ones are read off 3-decimal seconds (64.00053). A
 *  position within SNAP_SEC of a 1/24-beat step — every snap the grid offers:
 *  1/2, 1/3, 1/4, 1/6, 1/8 — is that step; anything further off (a tapped
 *  hit, a sung word) stays as it is. null when the song has no grid. */
const SNAP_SEC = 0.001;
const SNAP_STEPS = BEAT_FRACTION_STEPS;
function beatReader(info) {
  if (!info) return null;
  const clean = sanitizeSongInfo(info);
  const segments = resolveGridSegments(clean);
  if (!segments.length || !(clean.bpm > 0)) return null;
  const at = (t) => beatPositionAt(t, clean.bpm, clean.gridOffset ?? 0, segments);
  return (t) => {
    if (!Number.isFinite(t)) return undefined;
    const b = at(t);
    const step = Math.round(b * SNAP_STEPS) / SNAP_STEPS;
    const tol = SNAP_SEC * Math.abs(at(t + 1) - b);       // 1 ms, in this tempo's beats
    return roundBeat(Math.abs(step - b) <= tol ? step : b);
  };
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

/** One riff sequence entry, as the app stores it — `type` is a node id, a
 *  combo id, or the silence sentinel. The entry's `name` is added so a reader
 *  doesn't have to join tables to learn what is playing. */
function riffEntryOut(entry, nameById) {
  const out = { type: entry.type, lengthSteps: entry.lengthSteps };
  const name = nameById.get(entry.type);
  if (name) out.name = name;
  else if (entry.type === '__silence__') out.name = 'silence';
  return out;
}

/** One note (or rest) of a node, as stored: beats from the node's start. */
function riffNoteOut(sg) {
  const o = { start: roundBeat(sg.start), end: roundBeat(sg.end) };
  if (sg.kind) o.kind = sg.kind;
  setIf(o, 'label', sg.label);
  // A pitched note's MIDI number (a bass line, a riff).
  setIf(o, 'note', sg.note);
  // How hard it is struck, 1..127; absent = full strength.
  setIf(o, 'accent', sg.accent);
  return o;
}

/** A riff node, as the app stores it: its length on its own pulse, and its
 *  notes. The one shape a repeated figure takes, here as in the app. */
function riffNodeOut(node) {
  const out = {
    id: node.id,
    name: node.name,
    color: node.color,
    stepsPerCycle: node.stepsPerCycle,
    subbeatsPerBeat: node.subbeatsPerBeat,
    segments: (node.segments ?? []).map(riffNoteOut),
  };
  setIf(out, 'names', Array.isArray(node.names) && node.names.length ? node.names : null);
  return out;
}

/** An item's measured sound (lyrics, spans) as attack, decay, sustain and
 *  release — song seconds, snake_case. Null when it has none. */
function envelopeOut(e) {
  if (!e) return null;
  const out = {
    start: roundTime(e.start, PRECISION), peak: roundTime(e.peak, PRECISION),
    decay_end: roundTime(e.decayEnd, PRECISION), release: roundTime(e.release, PRECISION),
    end: roundTime(e.end, PRECISION), peak_db: e.peakDb,
  };
  setIf(out, 'sustain_db', e.sustainDb);
  // What it was read off: 'mix' or a stem.
  setIf(out, 'source', e.source);
  // Several pulses read as one outer shape: how many.
  setIf(out, 'peaks', e.peaks);
  return out;
}

/** The manifest form of one item. `grid` supplies bpm / beats-per-bar for the
 *  derived fields; `nameById` resolves riff sequence references. */
function manifestItem(type, item, grid, nameById) {
  const r = layerItemToRecord(type, item);
  const start = roundTime(r.start, PRECISION);
  const out = { id: item.id, start, end: roundTime(r.end, PRECISION), label: r.label };

  if (type === 'lyrics') {
    // A lyric carries no importance — its text IS its label, and `kind` says
    // whether it is a word or a whole line. A description is the annotator's
    // note on it, as on any other item.
    out.text = item.text ?? '';
    out.kind = item.kind ?? 'word';
    setIf(out, 'description', item.description);
    setIf(out, 'beat', grid.beatAt ? grid.beatAt(r.start) : roundBeat(item.beat));
    if (grid.beatAt) setIf(out, 'end_beat', grid.beatAt(r.end));
    // Where each sound inside the word begins, with the syllable sung there
    // (no text: an attack no syllable was laid on). Pinned to the audio, so a
    // word trimmed by hand keeps only the onsets still inside it.
    const onsets = (item.onsets ?? [])
      .filter((o) => o.time >= r.start && o.time <= r.end)
      .map((o) => setIf(setIf({ time: roundTime(o.time, PRECISION) }, 'beat', grid.beatAt?.(o.time)), 'text', o.text));
    if (onsets.length) out.onsets = onsets;
    // The word's whole sound as attack, decay, sustain and release — it may
    // rise before the word and ring on after it.
    setIf(out, 'envelope', envelopeOut(item.envelope));
    return out;
  }

  if (type === 'cues' || type === 'boundaries') {
    setIf(out, 'beat', grid.beatAt ? grid.beatAt(r.start) : roundBeat(item.beat));
    if (grid.beatAt && r.end > r.start) setIf(out, 'end_beat', grid.beatAt(r.end));
    if (type === 'boundaries') {
      out.section_type = item.type ?? 'unset';
      setIf(out, 'color', item.color);
    }
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

  setIf(out, 'start_beat', grid.beatAt ? grid.beatAt(r.start) : roundBeat(item.startBeat));
  setIf(out, 'end_beat', grid.beatAt ? grid.beatAt(r.end) : roundBeat(item.endBeat));
  // An item's own colour, over its layer's (spans, loops, riff instances…).
  setIf(out, 'color', item.color);

  if (type === 'spans') {
    const energy = parseEnergyDescription(item.description);
    setIf(out, 'pulse', pulseDetail(item.pulse, grid.bpm, grid.beatsPerBar));
    // Extract ADSR's reading, in the same shape a lyric's has.
    setIf(out, 'envelope', envelopeOut(item.envelope));
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
    out.repeatCount = item.repeatCount;
    out.sequence = (item.sequence ?? []).map((e) => riffEntryOut(e, nameById));
    // The plays that differed from their node — the same node, played
    // differently once: what it added, what it left out.
    if (Array.isArray(item.occurrences) && item.occurrences.length) {
      out.occurrences = item.occurrences.map((o) => {
        const oo = { index: o.index, event: o.event };
        if (Array.isArray(o.added) && o.added.length) oo.added = o.added.map(riffNoteOut);
        if (Array.isArray(o.missing) && o.missing.length) oo.missing = o.missing.map((m) => ({ start: roundBeat(m.start) }));
        return oo;
      });
    }
    setIf(out, 'duplicate_of', item.duplicateOfId);
    return commonItemFields(out, item, start);
  }

  return commonItemFields(out, item, start);
}

const KEY_POINT_TYPES = new Set(['cues', 'spans', 'loops']);

/** A cue layer copied from a detector is a transcription — one row per struck
 *  hit, played note or onset: 4,369 rows (186k chars) on one song, past a
 *  light show's preload limit, so the patterns behind them never reached it.
 *  What a reader downstream needs from it is what it adds up to — how many,
 *  where in the song, which drums or pitches — and the patterns the detector
 *  found in it, which travel as their own lanes (riffs, grooves). So a detected
 *  cue lane exports as that summary, never as its rows, unless `--with-notes`
 *  asks for the rows. A cue layer the user made is theirs and always travels. */
function isDetectedHitStream(layer) {
  return layer.type === 'cues' && Boolean(layer.importedFrom
    || (typeof layer.source === 'string' && layer.source.startsWith('detector:')));
}

// ── Detector summaries ───────────────────────────────────────────────────────
// One reading of a detector's output at the level a person describes music:
// a hit stream as counts, range and where it plays; a pattern as its rhythm or
// notes, how often, and at which bars. Used for detected lanes in the manifest
// and for `--detectors`, so a copied lane and the detector it came from read
// the same. Never a list of the hits themselves.

/** The bar a time falls in (1-based) on the song's grid, or null without one. */
function barOf(t, g) {
  if (!g?.barSec) return null;
  return Math.max(1, Math.floor((t - g.offset) / g.barSec) + 1);
}

/** Where a set of times plays, as merged bar ranges ("bars 1–40, 49–120"):
 *  a silence of more than `gapBars` bars starts a new range. Seconds when the
 *  song has no grid. */
function whereText(times, g, gapBars = 2) {
  const ts = times.filter(Number.isFinite).sort((a, b) => a - b);
  if (!ts.length) return '';
  const unit = g?.barSec ? (t) => barOf(t, g) : (t) => Math.round(t);
  const gap = g?.barSec ? gapBars + 1 : (gapBars + 1) * 2;
  const ranges = [];
  for (const t of ts) {
    const u = unit(t);
    const last = ranges[ranges.length - 1];
    if (last && u - last[1] <= gap) last[1] = u;
    else ranges.push([u, u]);
  }
  const fmt = ([a, b]) => (a === b ? `${a}` : `${a}–${b}`);
  return `${g?.barSec ? 'bars' : 's'} ${ranges.map(fmt).join(', ')}`;
}

function midiName(n) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${names[n % 12]}${Math.floor(n / 12) - 1}`;
}

/** Counted values, most frequent first, as "kick 320 · snare 395". */
function tally(values, top) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, top);
}

/** A hit stream in one line: how many, how dense, its range of pitch or its
 *  mix of drums, and where in the song it plays. `hits` are {t, label, note}. */
function hitsSummary(hits, g, noun) {
  const ts = hits.map((h) => h.t).filter(Number.isFinite);
  if (!ts.length) return `0 ${noun}`;
  const parts = [`${ts.length} ${noun}`];
  const bars = g?.barSec ? barOf(Math.max(...ts), g) - barOf(Math.min(...ts), g) + 1 : null;
  if (bars) parts.push(`${roundTime(ts.length / bars, 2)}/bar`);
  const notes = hits.map((h) => h.note).filter((n) => Number.isInteger(n) && n >= 0 && n <= 127);
  if (notes.length) {
    const top = tally(notes, 3).map(([n, c]) => `${midiName(n)} ${Math.round((100 * c) / notes.length)}%`);
    const [lo, hi] = [midiName(Math.min(...notes)), midiName(Math.max(...notes))];
    parts.push(`${lo === hi ? lo : `${lo}–${hi}`}, mostly ${top.join(', ')}`);
  } else {
    // A drum split labels each hit with its drum; a bare onset stream labels
    // them all the same, and saying so would be noise.
    const labels = hits.map((h) => String(h.label ?? '').split(' · ')[0].trim()).filter(Boolean);
    const kinds = tally(labels, 9);
    if (kinds.length > 1 && kinds.length <= 8) parts.push(kinds.map(([l, c]) => `${l} ${c}`).join(' · '));
  }
  parts.push(whereText(ts, g));
  return parts.filter(Boolean).join(' · ');
}

/** One detected figure's rhythm: its steps on its own pulse, and the step
 *  each note starts on — with its pitch when it has one, after the lane's
 *  drum when it is a drum's ("16 steps: kick 0,4,8,12"). A riff node. */
function riffRhythm(node, drum) {
  const pulse = node.subbeatsPerBeat || 4;
  const notes = (node.segments ?? []).filter((sg) => sg.kind === 'tick');
  const step = (sg) => Math.round(sg.start * pulse);
  if (notes.some((sg) => Number.isInteger(sg.note))) {
    return `${node.stepsPerCycle} steps: ${notes.map((sg) => `${step(sg)}:${Number.isInteger(sg.note) ? midiName(sg.note) : '?'}`).join(' ')}`;
  }
  if (!notes.length) return '';
  return `${node.stepsPerCycle} steps: ${drum ? `${drum} ` : ''}${notes.map(step).join(',')}`;
}

/** A riff lane's figures, one line each, most-played first: a node with how
 *  many times it plays across every instance (each entry of each repeat of a
 *  sequence is one play), its rhythm, and the bars it plays at. */
function riffLines(lane, g) {
  const byId = new Map((lane.nodes ?? []).map((n) => [n.id, { node: n, plays: 0, starts: [] }]));
  for (const it of lane.items ?? []) {
    const seq = it.sequence ?? [];
    const total = seq.reduce((n, e) => n + (e.lengthSteps ?? 0), 0) || 1;
    const cycle = (it.end ?? 0) - (it.start ?? 0);
    for (let r = 0; r < Math.max(1, it.repeatCount ?? 1); r += 1) {
      let at = 0;
      for (const e of seq) {
        const m = byId.get(e.type);
        if (m) { m.plays += 1; m.starts.push(it.start + r * cycle + (cycle * at) / total); }
        at += e.lengthSteps ?? 0;
      }
    }
  }
  return [...byId.values()]
    .filter((m) => m.plays > 0)
    .sort((a, b) => b.plays - a.plays)
    .map(({ node, plays, starts }) => {
      const bars = Math.max(1, Math.round(node.stepsPerCycle / (node.subbeatsPerBeat || 4) / 4));
      // What the figure is called, else how busy it is: "four on the floor",
      // "7 hits/bar", "19 notes/4 bars" — the line's second field, which
      // lol's bank_rhythms reads.
      const notes = (node.segments ?? []).filter((sg) => sg.kind === 'tick');
      const noun = notes.some((sg) => Number.isInteger(sg.note)) ? 'notes' : 'hits';
      const feel = node.names?.length ? node.names.join(', ') : `${notes.length} ${noun}/${bars === 1 ? 'bar' : `${bars} bars`}`;
      return [`${node.name} · ${feel} ×${plays}`, riffRhythm(node, lane.drum), whereText(starts, g, bars + 1)].filter(Boolean).join(' · ');
    });
}

/** A detected cue layer from the layers document, as the summary that stands
 *  in for its rows in the manifest. */
function laneSummary(layer, g, groupName) {
  const hits = (layer.items ?? []).map((i) => ({ t: Number(i.time), label: i.label, note: i.note }));
  const out = {
    name: layer.name ?? layer.type,
    type: layer.type,
    count: hits.length,
    summary: hitsSummary(hits, g, hits.some((h) => Number.isInteger(h.note)) ? 'notes' : 'hits'),
  };
  setIf(out, 'group', groupName);
  setIf(out, 'detector', layer.importedFrom);
  return out;
}

/** A detector's raw output file as indented lines: its warnings, then each
 *  group — every lane the detector wrote under one group name — as its loops
 *  ranked by repeats, a stats line for its hits, and its spans / boundaries. */
function detectorBlock(doc, g) {
  const lanes = Array.isArray(doc.lanes) && doc.lanes.length
    ? doc.lanes
    : [{ label: doc.name, output_kind: doc.output_kind, items: doc.items ?? [], nodes: doc.nodes, drum: doc.drum }];
  const groups = new Map();
  for (const lane of lanes) {
    const key = lane.group ?? lane.label ?? doc.name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(lane);
  }
  const out = [`## ${doc.name} — ${doc.output_kind ?? 'output'}`];
  for (const n of doc.notes ?? []) {
    out.push(`  ! ${n.code}: ${String(n.message ?? '').split(/(?<=\.)\s/)[0]}`);
  }
  if (doc.fatal) {
    const f = doc.fatal;
    out.push(`  ! failed: ${typeof f === 'string' ? f : (f.message ?? f.code ?? JSON.stringify(f))}`);
  }
  const before = out.length;
  for (const [name, ls] of groups) {
    const body = [];
    // A group is read as its riff: when it has one, its note / hit lane is
    // what the riff was found in and says nothing more, so it is left out.
    const hasPattern = ls.some((l) => l.output_kind === 'riff' && (l.items ?? []).length);
    for (const lane of ls) {
      const items = lane.items ?? [];
      if (!items.length) continue;
      const kind = lane.output_kind;
      if (kind === 'cue' && hasPattern) continue;
      if (kind === 'cue') {
        const hits = items.map((i) => ({ t: i.time_ms / 1000, label: i.label, note: i.note }));
        body.push(`${lane.label ?? 'hits'}: ${hitsSummary(hits, g, hits.some((h) => Number.isInteger(h.note)) ? 'notes' : 'hits')}`);
      } else if (kind === 'riff') {
        const loops = riffLines(lane, g);
        body.push(`${lane.label ?? 'loops'}: ${loops.length} loop${loops.length === 1 ? '' : 's'}`);
        for (const line of loops) body.push(`  ${line}`);
      } else if (kind === 'span') {
        body.push(`${lane.label ?? 'spans'}: ${items.length}`);
        for (const it of items) {
          const s = it.start_ms / 1000;
          body.push(`  ${roundTime(s, 1)}–${roundTime(s + (it.duration_ms ?? 0) / 1000, 1)}s ${it.label ?? ''}`.trimEnd());
        }
      } else if (kind === 'boundary') {
        body.push(`${lane.label ?? 'boundaries'}: ${items.map((it) => `${roundTime(it.time_ms / 1000, 1)}s ${it.label ?? ''}`.trim()).join(' · ')}`);
      } else if (kind === 'lyrics') {
        const ts = items.map((i) => i.time_ms / 1000);
        const lines = items.filter((i) => i.kind === 'line').length;
        body.push(`${lane.label ?? 'lyrics'}: ${items.length - lines} words, ${lines} lines · ${whereText(ts, g)}`);
      }
    }
    if (!body.length) continue;
    if (groups.size > 1) out.push(`  ### ${name}`);
    const pad = groups.size > 1 ? '    ' : '  ';
    for (const b of body) out.push(pad + b);
  }
  if (out.length === before && !doc.fatal) out.push('  (found nothing)');
  return out.join('\n');
}

/** Every custom / curated detector that ran on this song, newest format only
 *  (the files with an `output_kind`). */
function detectorsDoc(slug, g) {
  const blocks = [];
  for (const root of ['custom', 'curated']) {
    const dir = path.join(DATA_DIR, 'algorithm-outputs', root);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      const doc = readJsonOrNull(path.join(dir, name, `${slug}.json`));
      if (!doc || typeof doc !== 'object' || !doc.output_kind) continue;
      blocks.push(detectorBlock({ ...doc, name: doc.name ?? name }, g));
    }
  }
  return blocks;
}

// Every authored layer type reaches the manifest. It used to be four, one of
// which ('patterns') had since been retired from the app — so riff patterns
// and lyrics, both of which a person can spend an afternoon annotating, were
// exported nowhere at all.
const MANIFEST_TYPES = new Set(['boundaries', 'cues', 'spans', 'loops', 'lyrics', 'riff-patterns']);

// ── Per-song export ──────────────────────────────────────────────────────────

function exportSong(slug, generatedAt) {
  const info = readJsonOrNull(path.join(SONG_INFO_DIR, `${slug}.json`));
  const bpmDoc = readJsonOrNull(path.join(BPM_DIR, `${slug}.json`));
  // A Grid Lock save stores beats alone; its seconds are where those beats
  // fall on the song's grid as it stands now (beats are the annotation).
  const rawLayers = readJsonOrNull(layersFile(slug));
  let layersDoc = rawLayers;
  let layersProblem = null;
  if (rawLayers) {
    try { layersDoc = withSecondsFromBeats(rawLayers, gridOf(info ? sanitizeSongInfo(info) : null)); }
    catch (e) { layersDoc = null; layersProblem = `layers file unreadable: ${e.message}`; }
  }
  const beatAt = beatReader(info);
  const outDir = path.join(OUT_ROOT, slug);
  if (IN_BEATS && !beatAt) {
    return { outDir, written: [], warnings: ['no grid (no BPM) — a beat position means nothing without one; skipped'] };
  }
  column = IN_BEATS ? beatAt : (t) => roundTime(t, PRECISION);

  const beatAlgo = pickBeatAlgorithm(bpmDoc);
  const detected = beatAlgo?.beat_times ?? [];
  const duration = Number.isFinite(bpmDoc?.duration) ? bpmDoc.duration : detected[detected.length - 1];
  const userGrid = userGridLines(info, duration);
  const numerator = timeSignatureNumerator(info);
  const allLayers = Array.isArray(layersDoc?.layers) ? layersDoc.layers : [];
  const tempo = resolveGridBpm(info) ?? beatAlgo?.bpm;
  const barGrid = Number.isFinite(tempo) && tempo > 0
    ? { barSec: (60 / tempo) * timeSignatureNumerator(info), offset: info?.gridOffset ?? 0 }
    : null;
  const exported = (l) => WITH_NOTES || !isDetectedHitStream(l);
  const layers = allLayers.filter(exported);
  const omitted = allLayers.filter((l) => !exported(l));
  // Sections come from the FIRST boundaries layer — the same single track the
  // old singleton manual document held. Extra boundary layers are an editing
  // affordance; the exported .txt/.json contract stays one sections track.
  const boundaryLayer = layers.find((l) => l.type === 'boundaries') ?? null;
  const sections = Array.isArray(boundaryLayer?.items) ? boundaryLayer.items : [];

  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  const write = (name, contents) => {
    const file = path.join(outDir, name);
    // Label tracks / text files get a trailing newline; JSON keeps its own.
    fs.writeFileSync(file, contents, 'utf-8');
    written.push(name);
  };

  // 1–2. beats.txt / bars.txt — POINT. The annotator's grid when the song has
  // one (labels b<beat index>, bar <n> from bar 1 at the downbeat). Without a
  // BPM there is no grid, and the beat detector is all there is: its beats,
  // every Nth called a bar, counted from its own first beat.
  let beats = userGrid?.beats;
  let bars = userGrid?.bars;
  if (!userGrid) {
    beats = detected.map((t, i) => ({ t, label: `b${i}` }));
    bars = [];
    for (let i = 0; i < detected.length; i += numerator) {
      bars.push({ t: detected[i], label: `bar ${i / numerator}` });
    }
  }
  write(`${slug}_beats.txt`, pointsTrack(beats) + '\n');
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
    .map((s) => ({
      ...(IN_BEATS ? { beat: beatAt(s.time) } : { time: roundTime(s.time, PRECISION) }),
      type: s.type ?? 'unset', label: s.label ?? '',
    }));
  write(`${slug}_sections.json`, JSON.stringify({
    song: slug,
    ...(IN_BEATS ? { units: 'beats' } : {}),
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
    `grid offset: ${roundTime(info?.gridOffset ?? 0, PRECISION)} s`,
    `units: ${IN_BEATS ? 'beats from the grid origin (bar 1, beat 1 = 0)' : 'seconds'}`,
    `sections: ${sortedSections.map((s) => s.label).join(', ')}`,
    // What a reader would otherwise have to open the JSON to discover — most
    // usefully, that a song HAS lyrics or riff patterns at all.
    `layers: ${laneCounts.length ? laneCounts.join('; ') : '(none)'}`,
  ];
  const groupName = new Map((layersDoc?.groups ?? []).map((gr) => [gr.id, gr.name]));
  // A copied group is read as its pattern (riffs, grooves): when it has one,
  // its note / hit lane is left out altogether, not even summarised.
  const patternGroups = new Set(layers
    .filter((l) => l.groupId && l.type === 'riff-patterns')
    .map((l) => l.groupId));
  const summarized = omitted
    .filter((l) => !patternGroups.has(l.groupId))
    .map((l) => laneSummary(l, barGrid, groupName.get(l.groupId)));
  if (summarized.length) {
    infoLines.push('detected lanes, summarised (rows not exported):');
    for (const s of summarized) infoLines.push(`  ${s.group ? `${s.group} / ` : ''}${s.name}: ${s.summary}`);
  }
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
    // What beats.txt / bars.txt hold: the annotator's grid, or (no BPM yet)
    // the beat detector's beats.
    beats_source: userGrid ? 'grid' : (beatAlgo ? 'detector' : null),
  };
  const segs = Array.isArray(info?.gridSegments) ? info.gridSegments : [];
  if (segs.length) {
    grid.segments = segs.map((g) => ({
      start: roundTime(g.start, PRECISION),
      bpm: roundTime(g.bpm, PRECISION),
      time_signature: g.timeSignature ?? grid.time_signature,
    }));
  }
  // The grid resolved into constant-tempo stretches: from `beat` at `time`
  // seconds, `bpm` beats a minute. seconds = time + (b - beat) * 60 / bpm,
  // using the last entry whose beat <= b. All a reader needs to place a beat,
  // whatever the song's tempo mode (pinned beats aside).
  const tempoMap = info ? layersGridOf(sanitizeSongInfo(info))?.tempoMap : null;
  if (tempoMap) {
    grid.tempo_map = tempoMap.map((e) => ({
      beat: e.beat, time: roundTime(e.time, MAX_TIME_PRECISION), bpm: e.bpm,
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
      .map((item) => manifestItem(layer.type, item, { bpm: gridBpm, beatsPerBar: numerator, beatAt }, nameById))
      .sort((a, b) => a.start - b.start || a.end - b.end)
      .map((it) => (IN_BEATS ? inBeats(it, beatAt) : it));
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
    // The layer's big picture in one line (a copied groove's main loops), for a
    // reader who should get it before reading every item.
    setIf(lane, 'summary', layer.summary);
    // The drum a copied groove's figures are played on (hat, snare, kick …).
    setIf(lane, 'drum', layer.drum);
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
      lane.combos = layer.combos.map((c) => setIf({
        id: c.id, name: c.name,
        sequence: (c.sequence ?? []).map((e) => riffEntryOut(e, nameById)),
      }, 'color', c.color));
    }
    // A lyrics layer's prominence lives on its vocal runs, not on its words —
    // one arc per sung stretch. Absent means "derived on read", not "none".
    if (Array.isArray(layer.vocalRuns) && layer.vocalRuns.length) {
      lane.vocal_runs = layer.vocalRuns.map((r) => {
        const o = { start: roundTime(r.start, PRECISION), end: roundTime(r.end, PRECISION) };
        setIf(o, 'prominence', prominenceOut(r.prominence, r.start));
        setIf(o, 'prominence_summary', prominenceSummary(r.prominence));
        if (IN_BEATS) {
          o.start_beat = beatAt(r.start);
          o.end_beat = beatAt(r.end);
          return inBeats(o, beatAt);
        }
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
      const item = manifestItem('boundaries', sec, { bpm: gridBpm, beatsPerBar: numerator, beatAt }, new Map());
      item.kind = sec.type ?? 'unset';
      return item;
    })
    .sort((a, b) => a.start - b.start)
    .map((it) => (IN_BEATS ? inBeats(it, beatAt) : it));
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
    // What every position below is in. Absent from older exports, which
    // were all seconds.
    units: UNITS,
    precision: PRECISION,
    grid,
    groups,
    lanes,
    // Detected cue lanes, as what they add up to instead of their rows (see
    // isDetectedHitStream). Present only when there are some.
    ...(summarized.length ? { summarized_lanes: summarized } : {}),
  }, null, 2) + '\n');

  // 10. detectors.txt — every detector that ran, summarised (--detectors).
  if (WITH_DETECTORS) {
    const blocks = detectorsDoc(slug, barGrid);
    write(`${slug}_detectors.txt`, [
      `# Detector outputs for ${slug}, summarised: patterns, counts and where they play — never the individual hits.`,
      barGrid ? `# Bars on the song's grid: ${roundTime(tempo, 2)} BPM, ${timeSignatureNumerator(info)} beats a bar.` : '# No grid: places are in seconds.',
      '', ...blocks.flatMap((b) => [b, '']),
    ].join('\n'));
  }

  const warnings = collectWarnings({ info, bpmDoc, beatAlgo, userGrid, layersDoc, boundaryLayer });
  if (layersProblem) warnings.unshift(layersProblem);
  return { outDir, written, warnings };
}

function collectWarnings({ info, bpmDoc, beatAlgo, userGrid, layersDoc, boundaryLayer }) {
  const w = [];
  if (!info) w.push('no song-info (using defaults for bpm / time signature / title)');
  if (userGrid) { /* beats / bars are the annotator's grid */ }
  else if (Number.isFinite(info?.bpm) && !Number.isFinite(bpmDoc?.duration)) w.push('song has a grid but no known duration (beats / bars from the detector)');
  else if (!bpmDoc) w.push('no bpm-detections and no grid BPM (beats / bars will be empty)');
  else if (!beatAlgo) w.push('no usable beat detector and no grid BPM (beats / bars empty)');
  else w.push('no grid BPM in song-info (beats / bars are the beat detector\'s)');
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
