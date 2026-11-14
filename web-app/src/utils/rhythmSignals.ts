/**
 * Two rhythm lanes that loudness cannot give you.
 *
 *  - **Beat strength** — how hard the kick and bass land, beat by beat. A
 *    drop is the beat hitting; a breakdown or a build is the beat gone,
 *    however loud the pads and vocals over it are. So where Volume says "a
 *    bit quieter", Beat strength says "the beat stopped". Measured on the
 *    song's grid: each beat takes the strongest bass hit (onset below
 *    ENERGY_BASS_HZ) anywhere inside it, times how STEADY those hits are over
 *    the 8 beats around it, held across that beat. Anywhere, not only on the
 *    grid line: a grid a few milliseconds off, or a BPM that drifts against
 *    the recording, would otherwise read a pounding kick as silence — which is
 *    what the demo's EDM At Midnight did. Steady, because a kick repeats with
 *    the same weight every beat and bass notes and swelling pads do not: in
 *    The Power Is Here Now, which has no beat, the low end hits as hard as
 *    anywhere, but each beat's hit differs from its neighbours'.
 *
 *  - **Onset density** — hits per beat: how many things are struck, whatever
 *    they are. A snare roll going from quarters to eighths to sixteenths
 *    doubles it twice at the same volume, which is the "tempo going up" you
 *    hear in a build even though the BPM never moves.
 *
 * Both need the beat grid to mean what they say. Without one (a song with no
 * BPM) they fall back to the same readings per second of audio, so the lane
 * still draws, just not in beats.
 *
 * Pure functions over the MIR frames — mirrored in
 * tools/python/generators/energy_arcs.py, which reads Beat strength per bar.
 */

import { frameCenterTime, type FrameAxis } from './frameTime';

/** Onset density counts the hits in this many beats around each frame, so a
 *  bar's worth of pattern decides it, not one busy beat. */
export const DENSITY_WINDOW_BEATS = 4;

/** Steadiness is read over this many beats around each one: the median of
 *  their strongest bass hits against the largest. A kick on every beat sits
 *  near 1 (0.87 through Alor's drops); bass notes and pads wander (0.35–0.43
 *  through The Power Is Here Now, 0.25 under Alor's risers). Below
 *  STEADY_LO a beat counts as no beat at all, above STEADY_HI as a full one. */
export const STEADY_WINDOW_BEATS = 8;
const STEADY_LO = 0.45;
const STEADY_HI = 0.8;

/** Without a grid: the density window in seconds (a 4/4 bar at 120 bpm). */
const DENSITY_WINDOW_SEC_NO_GRID = 2;
/** Without a grid: Beat strength is the bass hits over this window. */
const BEAT_STRENGTH_SEC_NO_GRID = 0.5;

/** An onset is a local peak of the onset curve standing this far above the
 *  mean of the ONSET_MEAN_SEC around it (onsets normalized 0–1). */
const ONSET_DELTA = 0.05;
const ONSET_MEAN_SEC = 0.25;

/** Both lanes are scaled to this percentile of their own values, not the
 *  single largest, so one freak kick does not flatten the rest of the song. */
const SCALE_PERCENTILE = 0.98;

function scaleTo01(values: Float32Array): Float32Array {
  if (values.length === 0) return values;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const ref = sorted[Math.min(sorted.length - 1, Math.floor(SCALE_PERCENTILE * (sorted.length - 1)))];
  if (!(ref > 0)) return values.fill(0);
  for (let i = 0; i < values.length; i++) values[i] = Math.min(1, values[i] / ref);
  return values;
}

/** Index of the first frame whose centre is at or after `t`. */
function firstFrameAtOrAfter(t: number, axis: FrameAxis): number {
  if (!(axis.step > 0)) return 0;
  return Math.max(0, Math.ceil((t - axis.offset) / axis.step));
}

/**
 * Beat strength per frame, 0–1. `bassHits` is per-frame (the onsets below the
 * bass cutoff); `beatTimes` the song's beats in seconds, ascending, or null
 * when the song has no grid. Each beat owns the frames from halfway to the
 * previous beat to halfway to the next. Its value is the strongest bass hit
 * among them (scaled over the song's beats) times its steadiness over the
 * STEADY_WINDOW_BEATS around it, and all of its frames carry it — a step per
 * beat, which is how the beat reads: on, or not.
 */
export function beatStrengthCurve(
  bassHits: ArrayLike<number>,
  axis: FrameAxis,
  beatTimes: readonly number[] | null,
): Float32Array {
  const n = bassHits.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  if (!beatTimes || beatTimes.length < 2) {
    const r = Math.max(1, Math.round(BEAT_STRENGTH_SEC_NO_GRID / 2 / (axis.step || 1)));
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) s += bassHits[j];
      out[i] = s;
    }
    return scaleTo01(out);
  }

  const nb = beatTimes.length;
  const peaks = new Float32Array(nb);
  const spans: [number, number][] = [];
  for (let b = 0; b < nb; b++) {
    const t = beatTimes[b];
    const from = b > 0 ? (beatTimes[b - 1] + t) / 2 : t - (beatTimes[1] - t) / 2;
    const to = b + 1 < nb ? (t + beatTimes[b + 1]) / 2 : t + (t - beatTimes[b - 1]) / 2;
    const first = firstFrameAtOrAfter(from, axis);
    let hit = 0;
    let i = first;
    for (; i < n && frameCenterTime(i, axis) < to; i++) hit = Math.max(hit, bassHits[i]);
    peaks[b] = hit;
    spans.push([first, i]);
  }
  const steady = steadiness(peaks);
  const strength = scaleTo01(Float32Array.from(peaks));
  for (let b = 0; b < nb; b++) {
    const v = strength[b] * steady[b];
    for (let k = spans[b][0]; k < spans[b][1]; k++) out[k] = v;
  }
  return out;
}

/** Per beat, 0–1: the median of the STEADY_WINDOW_BEATS peaks around it
 *  against their largest, mapped from [STEADY_LO, STEADY_HI] onto [0, 1]. */
export function steadiness(peaks: ArrayLike<number>): Float32Array {
  const nb = peaks.length;
  const out = new Float32Array(nb);
  const half = STEADY_WINDOW_BEATS / 2;
  const size = Math.min(STEADY_WINDOW_BEATS, nb);
  for (let b = 0; b < nb; b++) {
    const lo = Math.max(0, Math.min(b - half, nb - STEADY_WINDOW_BEATS));
    const win = Array.from({ length: size }, (_, k) => peaks[lo + k]).sort((x, y) => x - y);
    const top = win[size - 1];
    const mid = size % 2 ? win[(size - 1) / 2] : (win[size / 2 - 1] + win[size / 2]) / 2;
    const ratio = top > 0 ? mid / top : 0;
    out[b] = Math.max(0, Math.min(1, (ratio - STEADY_LO) / (STEADY_HI - STEADY_LO)));
  }
  return out;
}

/** Frames where the onset curve peaks: a local maximum standing ONSET_DELTA
 *  above the mean of the ONSET_MEAN_SEC around it. */
export function pickOnsets(onsets: ArrayLike<number>, axis: FrameAxis): number[] {
  const n = onsets.length;
  const r = Math.max(1, Math.round(ONSET_MEAN_SEC / 2 / (axis.step || 1)));
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + onsets[i];
  const peaks: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    const v = onsets[i];
    if (v < onsets[i - 1] || v <= onsets[i + 1]) continue;
    const lo = Math.max(0, i - r);
    const hi = Math.min(n, i + r + 1);
    const mean = (prefix[hi] - prefix[lo]) / (hi - lo);
    if (v >= mean + ONSET_DELTA) peaks.push(i);
  }
  return peaks;
}

/**
 * Onset density per frame, 0–1 (scaled; the unit is hits per beat, or per
 * second without a grid). Each frame counts the onsets in the
 * DENSITY_WINDOW_BEATS beats centred on it.
 */
export function onsetDensityCurve(
  onsets: ArrayLike<number>,
  axis: FrameAxis,
  beatTimes: readonly number[] | null,
): Float32Array {
  const n = onsets.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  const peaks = pickOnsets(onsets, axis).map((i) => frameCenterTime(i, axis));
  const withGrid = !!beatTimes && beatTimes.length >= 2;

  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const t = frameCenterTime(i, axis);
    let from: number;
    let to: number;
    let per: number;
    if (withGrid) {
      const beats = beatTimes!;
      // The beat this frame sits in, found by walking — frames are in order.
      const b = Math.max(0, Math.min(beats.length - 1, upperBound(beats, t) - 1));
      const a = Math.max(0, b - DENSITY_WINDOW_BEATS / 2);
      const z = Math.min(beats.length - 1, b + DENSITY_WINDOW_BEATS / 2);
      from = beats[a];
      to = beats[z];
      per = Math.max(1, z - a);
    } else {
      from = t - DENSITY_WINDOW_SEC_NO_GRID / 2;
      to = t + DENSITY_WINDOW_SEC_NO_GRID / 2;
      per = DENSITY_WINDOW_SEC_NO_GRID;
    }
    while (lo < peaks.length && peaks[lo] < from) lo++;
    if (hi < lo) hi = lo;
    while (hi < peaks.length && peaks[hi] < to) hi++;
    out[i] = (hi - lo) / per;
  }
  return scaleTo01(out);
}

/** A note starts in a band where its level rises this many dB over
 *  BUSY_LAG_FRAMES frames and that rise is the largest within ±BUSY_PEAK_FRAMES. */
export const BUSY_RISE_DB = 6;
const BUSY_LAG_FRAMES = 2;
const BUSY_PEAK_FRAMES = 4;
/** Each note counts by how loud its band is against the band's own loud
 *  passages (its 95th percentile), as an amplitude ratio capped at 1: a note
 *  at full level counts 1, one 20 dB down 0.1. Counting every note alike
 *  read El Jaguar as flat — its shakers and congas start notes in every band
 *  all song, so a passage without kick, bass or chords scored like the full
 *  groove (0.82 against 0.93); weighted, 0.47 against 0.96. */

/**
 * Busyness per frame, 0–1 (scaled; the unit is loudness-weighted notes per
 * beat, summed over the bands, or per second without a grid). `bandLevels` is
 * frame × band in dB (mirAnalysis: BUSY_BAND_EDGES_HZ). In each band a note
 * is a rise of BUSY_RISE_DB, weighted by the band's level (see above); each
 * frame counts the notes in all bands over the DENSITY_WINDOW_BEATS beats
 * around it. So it is high where many parts of the spectrum each start many
 * notes at full level — a full arrangement playing fast — and low for long
 * held sounds, however loud or wide (a sustained band has no rises to count),
 * and low for a quiet part ticking alone.
 */
export function busynessCurve(
  bandLevels: ArrayLike<number>,
  nBands: number,
  axis: FrameAxis,
  beatTimes: readonly number[] | null,
): Float32Array {
  const n = nBands > 0 ? Math.floor(bandLevels.length / nBands) : 0;
  const counts = new Float32Array(n);
  for (let b = 0; b < nBands; b++) {
    const level = new Float32Array(n);
    for (let i = 0; i < n; i++) level[i] = bandLevels[i * nBands + b];
    const sorted = Array.from(level).sort((x, y) => x - y);
    const ref = sorted[Math.floor(0.95 * (n - 1))] ?? 0;
    const rise = new Float32Array(n);
    for (let i = BUSY_LAG_FRAMES; i < n; i++) rise[i] = Math.max(0, level[i] - level[i - BUSY_LAG_FRAMES]);
    for (let i = 0; i < n; i++) {
      const v = rise[i];
      if (v < BUSY_RISE_DB) continue;
      let top = true;
      for (let j = Math.max(0, i - BUSY_PEAK_FRAMES); j <= Math.min(n - 1, i + BUSY_PEAK_FRAMES) && top; j++) {
        if (rise[j] > v || (rise[j] === v && j < i)) top = false;
      }
      if (top) counts[i] += Math.min(1, 10 ** ((level[i] - ref) / 20));
    }
  }
  return countsPerWindow(counts, axis, beatTimes);
}

/** Per frame: the sum of `counts` over the DENSITY_WINDOW_BEATS beats around
 *  it, per beat (or over DENSITY_WINDOW_SEC_NO_GRID, per second), scaled. */
function countsPerWindow(
  counts: Float32Array,
  axis: FrameAxis,
  beatTimes: readonly number[] | null,
): Float32Array {
  const n = counts.length;
  const out = new Float32Array(n);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + counts[i];
  const withGrid = !!beatTimes && beatTimes.length >= 2;
  for (let i = 0; i < n; i++) {
    const t = frameCenterTime(i, axis);
    let from: number;
    let to: number;
    let per: number;
    if (withGrid) {
      const beats = beatTimes!;
      const b = Math.max(0, Math.min(beats.length - 1, upperBound(beats, t) - 1));
      const a = Math.max(0, b - DENSITY_WINDOW_BEATS / 2);
      const z = Math.min(beats.length - 1, b + DENSITY_WINDOW_BEATS / 2);
      from = beats[a];
      to = beats[z];
      per = Math.max(1, z - a);
    } else {
      from = t - DENSITY_WINDOW_SEC_NO_GRID / 2;
      to = t + DENSITY_WINDOW_SEC_NO_GRID / 2;
      per = DENSITY_WINDOW_SEC_NO_GRID;
    }
    const lo = Math.min(n, firstFrameAtOrAfter(from, axis));
    const hi = Math.min(n, firstFrameAtOrAfter(to, axis));
    out[i] = (prefix[hi] - prefix[Math.max(lo, 0)]) / per;
  }
  return scaleTo01(out);
}

/** Number of entries in ascending `xs` that are <= `t`. */
function upperBound(xs: readonly number[], t: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
