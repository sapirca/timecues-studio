/**
 * onsetWindow — the slice of an onset-strength curve that describes one placed
 * span, expressed in that span's own beat coordinates.
 *
 * A riff node has no time of its own: it's a length in beats, drawn wherever
 * it happens to be placed. To show a node's blocks against the audio they were
 * built from, the song-wide onset envelope has to be cut down to the node's
 * real placement and re-laid out on the node's beat axis — the same linear
 * mapping the karaoke playhead already uses, so the envelope, the blocks and
 * the sweep all agree by construction.
 *
 * Two things come out of that window:
 *  - `curve`, a fixed number of evenly spaced samples for drawing. Each column
 *    takes the **maximum** of the frames it covers, never their mean: an onset
 *    is a spike one or two frames wide, and averaging is exactly the operation
 *    that buries it.
 *  - `peakBeats`, the onsets themselves — local maxima above a floor, thinned
 *    so one attack smeared across neighbouring frames arrives as one onset.
 *    These are what the blocks get measured and snapped against, so the
 *    comparison never needs a detector layer to exist.
 *  - `levelCurve`, the same window's loudness, when the caller passes the RMS
 *    beside the flux. Flux cannot answer "how long does this hit last?" — it
 *    is a difference between spectra, so it is back at the floor while the
 *    note is still ringing — and that question is what turns an onset into a
 *    block with a real length instead of a fixed one (`onsetTickEnds`).
 *
 * Frame → time goes through `frameTime`: a frame is a window, and the moment
 * it describes is its centre. Using the index would put every onset tens of
 * milliseconds off at this zoom, which is the whole error being looked for.
 */

import { frameAtTime, frameCenterTime, type FrameAxis } from './frameTime';

export interface OnsetWindow {
  /** Envelope samples, normalised 0-1 against the window's own loudest onset
   *  (not the song's — a quiet node still has a readable shape), evenly spaced
   *  across `[0, lengthBeats]`. Empty when there's nothing to draw. */
  curve: number[];
  /** Picked onsets, in beats from the window's start, ascending. */
  peakBeats: number[];
  /** Loudness over the same columns, normalised 0-1 against the window's own
   *  loudest moment — present only when `levels` was given. Sampled as the
   *  MEAN of the frames each column covers, not their max: this one is a
   *  continuous contour rather than a set of spikes, and a max would keep a
   *  decayed tail reading at the level of its own attack. */
  levelCurve?: number[];
}

/** How many samples the drawn envelope gets. Comfortably more than the pixel
 *  width of the strip it's drawn in, and small enough to rebuild on a render. */
export const ONSET_WINDOW_COLUMNS = 240;

/** Peaks below this fraction of the loudest onset NEARBY are the shoulders of
 *  the real ones, not hits of their own.
 *
 *  Nearby, not in the window: measured against the window's own maximum, one
 *  loud hit silences the whole placement. A 32-beat node is ten seconds of
 *  music, a snare in bar 2 has nothing to say about a picked note in bar 7,
 *  and a single crash sets a bar every quieter hit in the node fails — which
 *  reads, correctly, as "the detector missed most of them". The reference is
 *  therefore the loudest onset within `ONSET_LOCAL_WINDOW_SEC` either side, so
 *  the floor tracks the passage's own dynamics instead of its loudest moment.
 *
 *  Low — 8%, where this sat at 25% until 2026-09-17 — because the boundary
 *  node draws the very curve it picks from, and the two disagreeing on screen
 *  is not a tuning question but a bug report. At a quarter of the local
 *  maximum, a passage with one accented hit per bar had the ghost notes
 *  between them plainly visible as peaks in the strip and marked by nothing,
 *  and no tooltip explains that away: the user is looking at a peak and at the
 *  absence of a tick on it. So the bar drops to where a bump you can SEE in
 *  the envelope is a bump that gets a tick, and `ONSET_NOISE_FLOOR` — an
 *  absolute gate, not a relative one — is what keeps that from promoting
 *  noise. Over-marking is recoverable by deleting a block; under-marking asks
 *  the user to find what is missing. */
export const ONSET_PEAK_FLOOR = 0.08;

/** How far either side the floor looks for its reference. Wide enough to cover
 *  a hit and its decay (so a tail is still judged against the attack it came
 *  from), short enough that a dynamic swell doesn't drag the bar across a bar
 *  line. */
export const ONSET_LOCAL_WINDOW_SEC = 0.5;

/** ...but never below this fraction of the window's loudest onset. A local
 *  reference is scale-free, and in a passage that is genuinely silent that is
 *  the wrong property: every ripple in the noise is 25% of its neighbours.
 *  This is the absolute gate that keeps silence silent, and with
 *  `ONSET_PEAK_FLOOR` down at 8% it is now doing nearly all of that work
 *  alone — so it moved too, but by less: 3% of the window's loudest onset is
 *  under any real hit and over the flux floor of a quiet passage. The margin
 *  between a rest and a ghost note is genuinely thinner than it was; that is
 *  the trade the low peak floor buys. */
export const ONSET_NOISE_FLOOR = 0.03;

/** Two peaks closer than this are one attack spread over a few frames. 50 ms
 *  is under a 32nd note at 150 bpm — nothing anyone plays lands inside it. */
export const ONSET_PEAK_MIN_GAP_SEC = 0.05;

/** How far outside the placement to keep looking for a peak, in seconds.
 *
 *  A node's edges are the one place where "inside the window" and "part of
 *  this node" stop meaning the same thing. The node starts on a beat; the hit
 *  that beat is FOR is played by a human, lands a few milliseconds either
 *  side, and its flux peak can easily sit one frame before the placement even
 *  though the sound is plainly the node's downbeat. Cut at the window edge, it
 *  is not detected at all — and the first and last hits are exactly the two a
 *  person checks first. So the search runs slightly wide and the results are
 *  clamped back into `[0, lengthBeats]`. Same 50 ms as the thinning gap: too
 *  short to reach a genuinely different hit. */
export const ONSET_EDGE_TOLERANCE_SEC = 0.05;

/** Cuts `values` down to `[startSec, endSec)` and re-expresses it over
 *  `lengthBeats`. Returns empty arrays for a degenerate window (no audio
 *  analysed, a zero-length placement, a silent span). */
export function sampleOnsetWindow(
  values: readonly number[],
  axis: FrameAxis,
  startSec: number,
  endSec: number,
  lengthBeats: number,
  opts: {
    columns?: number; floor?: number; minGapSec?: number; localWindowSec?: number;
    edgeToleranceSec?: number;
    /** Per-frame loudness on the SAME axis as `values` — `computeOnsetEnvelopeWindow`
     *  returns it beside the flux, and `computeMIRFeatures` calls it `rms`. */
    levels?: readonly number[];
  } = {},
): OnsetWindow {
  const empty: OnsetWindow = { curve: [], peakBeats: [] };
  const duration = endSec - startSec;
  const beats = Math.max(0, lengthBeats);
  if (values.length === 0 || !(axis.step > 0) || !(duration > 0) || beats <= 0) return empty;

  const first = frameAtTime(startSec, axis);
  const last = frameAtTime(endSec, axis);
  if (last <= first) return empty;

  let peak = 0;
  for (let i = first; i <= last && i < values.length; i += 1) {
    if (values[i] > peak) peak = values[i];
  }
  if (!(peak > 0)) return empty;

  const columns = Math.max(2, Math.round(opts.columns ?? ONSET_WINDOW_COLUMNS));
  const levels = opts.levels;
  const curve: number[] = [];
  const levelCurve: number[] | undefined = levels && levels.length > 0 ? [] : undefined;
  let levelPeak = 0;
  for (let c = 0; c < columns; c += 1) {
    const from = frameAtTime(startSec + (c / columns) * duration, axis);
    const to = Math.max(from, frameAtTime(startSec + ((c + 1) / columns) * duration, axis));
    let v = 0;
    for (let i = from; i <= to && i < values.length; i += 1) if (values[i] > v) v = values[i];
    curve.push(v / peak);
    if (levelCurve && levels) {
      let sum = 0;
      let n = 0;
      for (let i = from; i <= to && i < levels.length; i += 1) { sum += levels[i]; n += 1; }
      const mean = n > 0 ? sum / n : 0;
      if (mean > levelPeak) levelPeak = mean;
      levelCurve.push(mean);
    }
  }
  if (levelCurve && levelPeak > 0) {
    for (let c = 0; c < levelCurve.length; c += 1) levelCurve[c] /= levelPeak;
  }

  const floorFraction = opts.floor ?? ONSET_PEAK_FLOOR;
  const noiseFloor = ONSET_NOISE_FLOOR * peak;
  // Radius of the local floor's reference, in frames. At least one frame, so a
  // coarse axis still compares against something other than the peak itself.
  const localRadius = Math.max(1, Math.round((opts.localWindowSec ?? ONSET_LOCAL_WINDOW_SEC) / axis.step));
  const minGap = Math.max(0, opts.minGapSec ?? ONSET_PEAK_MIN_GAP_SEC);
  const edgeSec = Math.max(0, opts.edgeToleranceSec ?? ONSET_EDGE_TOLERANCE_SEC);
  const edgeFrames = Math.round(edgeSec / axis.step);
  const scanFrom = Math.max(0, first - edgeFrames);
  const scanTo = Math.min(values.length - 1, last + edgeFrames);
  const kept: { time: number; value: number }[] = [];
  for (let i = scanFrom; i <= scanTo; i += 1) {
    const v = values[i];
    if (v < noiseFloor) continue;
    // A frame at the very end of the analysed audio has no neighbour on that
    // side, and treating "no neighbour" as "not a peak" is what made a node
    // placed at 0:00 lose its own downbeat: frame 0 could never win. An
    // absent neighbour is -Infinity — nothing to be beaten by — so the hit
    // stands or falls on the side that does exist.
    // `>=` on the left and `>` on the right so a two-frame plateau is claimed
    // once, by its later frame, instead of twice or not at all.
    const before = i > 0 ? values[i - 1] : -Infinity;
    const after = i + 1 < values.length ? values[i + 1] : -Infinity;
    if (v < before || v <= after) continue;
    // Only now, for the handful of frames that are actually shaped like a
    // peak, is the local reference worth scanning for.
    let local = 0;
    const from = Math.max(scanFrom, i - localRadius);
    const to = Math.min(scanTo, i + localRadius);
    for (let j = from; j <= to; j += 1) if (values[j] > local) local = values[j];
    if (v < floorFraction * local) continue;
    const time = frameCenterTime(i, axis);
    const prev = kept[kept.length - 1];
    if (prev && time - prev.time < minGap) {
      if (v > prev.value) kept[kept.length - 1] = { time, value: v };
      continue;
    }
    kept.push({ time, value: v });
  }

  // Back into the node's own coordinates, with the overscan folded onto the
  // edge it came from. Two peaks either side of beat 0 can land on the same
  // clamped position, which is one hit described twice.
  const peakBeats: number[] = [];
  for (const p of kept) {
    const raw = ((p.time - startSec) / duration) * beats;
    const b = Math.min(beats, Math.max(0, raw));
    if (Math.abs(raw - b) > (edgeSec / duration) * beats) continue;
    const prev = peakBeats[peakBeats.length - 1];
    if (prev != null && b - prev < 1e-9) continue;
    peakBeats.push(b);
  }
  return levelCurve && levelPeak > 0
    ? { curve, peakBeats, levelCurve }
    : { curve, peakBeats };
}

/** Where the loudness has to fall, as a fraction of the hit's own RISE, before
 *  the hit is over. A third: well under the -6 dB a decaying note spends most
 *  of its life above, and well over the noise a quiet passage sits at.
 *
 *  Its rise, not its peak. A hit does not happen in silence — it happens on
 *  top of whatever else is playing, and in a full mix that bed never goes
 *  away. Measured against the peak, a kick that takes the level from 0.6 to
 *  1.0 is "over" at 0.33, which the mix will not reach before the next onset,
 *  so the block runs into it and every hit in a dense passage gets drawn as a
 *  sustain. Measured against the rise, the same kick is over at 0.73 — back to
 *  the bed it came from, which is where the kick actually ended. Where the bed
 *  IS silence the two are identical, so a sparse node is unaffected. */
export const TICK_RELEASE_FRACTION = 1 / 3;

/** How far before the onset to read the bed it rose from, in beats. The
 *  quietest moment in that stretch, not the mean: a previous hit's tail is
 *  still decaying through it, and averaging that in would put the bed above
 *  where the music actually sits. */
export const TICK_BASE_BEATS = 0.12;

/** ...but never below this fraction of the window's loudest moment. A hit at
 *  the end of a fade would otherwise chase its own tiny peak down into the
 *  noise floor and report a block lasting until the next onset. */
export const TICK_RELEASE_FLOOR = 0.12;

/** How far past the onset the attack is allowed to peak, in beats. The flux
 *  fires on the transient's first frame; the RMS crest can sit a frame or two
 *  later, and measuring the release against a level read before the sound has
 *  fully arrived would end every block instantly. */
export const TICK_ATTACK_BEATS = 0.06;

/** How many consecutive columns have to sit under the threshold before the hit
 *  is called over — one dip inside a tremolo or a vibrato is not a release. */
const TICK_RELEASE_HOLD_COLUMNS = 2;

/** Shortest block this can produce, in beats. A hit shorter than this is drawn
 *  as a hairline nobody can grab, so it is rounded up rather than left
 *  invisible — a 32nd at 120 bpm. */
export const TICK_MIN_BEATS = 0.125;

/** Longest, too. A block marks WHERE a hit is, and the useful reading of a
 *  node is the pattern its blocks make — which needs gaps between them. Left
 *  to the release alone, a dense passage produces blocks that each run into
 *  the next onset and the strip fills in solid: technically every hit is
 *  marked, and nothing can be read off it. So the measured release ends a
 *  block early wherever it fires, and this ends it regardless: a hit gets a
 *  minimal window at its peak, not a sustain.
 *
 *  Half a beat is a quaver at any tempo — long enough to see and to grab,
 *  short enough that consecutive hits stay visibly separate. Callers that
 *  genuinely want held blocks (a lyric line, a tapped-and-held segment) pass
 *  their own `maxBeats`; those arrive with an `endBeat` already and never
 *  reach this code at all. */
export const TICK_MAX_BEATS = 0.5;

/**
 * How long each onset's block should run, read off the window's loudness.
 *
 * The alternative — and what this replaces — is a fixed length: every detected
 * onset opening a block of one beat (or of the gap to the next onset, whichever
 * is shorter). That is a claim about the music that the music never made. A
 * staccato stab and a held chord get identical blocks, so the node's own
 * picture stops describing the audio the moment it is seeded from it, and the
 * karaoke sweep lights a block for a beat after the sound has gone.
 *
 * So each hit is followed instead: take its peak level just after the attack,
 * and end the block where the level has spent `TICK_RELEASE_HOLD_COLUMNS`
 * columns below `TICK_RELEASE_FRACTION` of that peak (never below
 * `TICK_RELEASE_FLOOR` of the window's own loudest moment, so a quiet hit
 * can't chase its tail into the noise). A hit that never falls that far before
 * the next onset simply runs into it — which is what a sustained note does.
 *
 * `levelCurve` is `sampleOnsetWindow`'s, i.e. normalised 0-1 and evenly spaced
 * across `[0, lengthBeats]`. Returns one end beat per onset, in the order
 * given; an empty or flat curve returns an empty array, and the caller should
 * fall back to its fixed length rather than pretend.
 */
export function onsetTickEnds(
  onsetBeats: readonly number[],
  levelCurve: readonly number[],
  lengthBeats: number,
  opts: { releaseFraction?: number; floor?: number; minBeats?: number; maxBeats?: number } = {},
): number[] {
  const beats = Math.max(0, lengthBeats);
  const columns = levelCurve.length;
  if (columns < 2 || !(beats > 0) || onsetBeats.length === 0) return [];

  const perColumn = beats / columns;
  const release = opts.releaseFraction ?? TICK_RELEASE_FRACTION;
  const floor = opts.floor ?? TICK_RELEASE_FLOOR;
  const minBeats = Math.max(0, opts.minBeats ?? TICK_MIN_BEATS);
  const maxBeats = Math.max(minBeats, opts.maxBeats ?? TICK_MAX_BEATS);
  const attackColumns = Math.max(1, Math.round(TICK_ATTACK_BEATS / perColumn));
  const baseColumns = Math.max(1, Math.round(TICK_BASE_BEATS / perColumn));
  // The next onset caps each block, so they are read in time order whatever
  // order the caller holds them in — and handed back in the caller's order.
  const order = onsetBeats.map((beat, i) => ({ beat, i })).sort((a, b) => a.beat - b.beat);

  const ends = new Array<number>(onsetBeats.length);
  for (let k = 0; k < order.length; k += 1) {
    const { beat, i } = order[k];
    const next = k + 1 < order.length ? order[k + 1].beat : beats;
    // The next onset still caps the block — two blocks must not overlap — but
    // the window cap usually bites first, which is the point.
    const limit = Math.min(next, beats, beat + maxBeats);
    const startCol = Math.max(0, Math.min(columns - 1, Math.floor(beat / perColumn)));
    const limitCol = Math.max(startCol + 1, Math.min(columns, Math.ceil(limit / perColumn)));

    let peak = 0;
    for (let c = startCol; c < Math.min(limitCol, startCol + attackColumns + 1); c += 1) {
      if (levelCurve[c] > peak) peak = levelCurve[c];
    }
    // The bed this hit rose from. Nothing before the window's own start means
    // nothing to have risen from, so a hit on column 0 is measured against
    // silence exactly as it was before.
    let base = peak;
    for (let c = Math.max(0, startCol - baseColumns); c < startCol; c += 1) {
      if (levelCurve[c] < base) base = levelCurve[c];
    }
    if (startCol === 0) base = 0;
    const threshold = Math.max(base + (peak - base) * release, floor);

    let end = limit;
    let below = 0;
    for (let c = startCol + 1; c < limitCol; c += 1) {
      if (levelCurve[c] < threshold) {
        below += 1;
        if (below >= TICK_RELEASE_HOLD_COLUMNS) {
          // Date the release at the first column that went under, not at the
          // one that confirmed it — the sound stopped where it stopped.
          end = (c - below + 1) * perColumn;
          break;
        }
      } else {
        below = 0;
      }
    }
    ends[i] = Math.min(limit, Math.max(Math.min(beat + minBeats, limit), end));
  }
  return ends;
}

/** Half-width of a MARKER block, in seconds.
 *
 *  A marker is the other answer to "how long is this block?", and it answers
 *  by refusing the question: 10 ms either side of the onset, and nothing
 *  claimed about the sound after that. `onsetTickEnds` above measures a hit's
 *  release and draws a block that lasts as long as the note does, which is the
 *  right picture when the node is describing sustains — and the wrong one when
 *  the node is describing a rhythm, because a dozen measured blocks in a dense
 *  passage tile into a solid bar and the pattern that was the whole point of
 *  looking becomes unreadable. A marker is the position and only the position.
 *
 *  In seconds rather than beats because that is what it is: a hairline is a
 *  hairline at 70 bpm and at 180, whereas a beat fraction would be twice as
 *  wide in the slow song. 10 ms is roughly a pixel at working zoom and two
 *  orders of magnitude tighter than the 125 ms `BOUNDARY_ONSET_MATCH_BEATS`
 *  the alignment readout calls "on the onset", so a node built from markers
 *  reads as 13 / 13 on an onset.
 *
 *  Centred, not started, on the peak — so the readout's median offset comes
 *  back at −10 ms rather than 0. That is not an error to hide: a centred
 *  marker does start 10 ms before the transient, and the readout reports where
 *  the blocks are. */
export const ONSET_MARKER_SEC = 0.01;

/** Gives every hit a hairline block centred on it — the marker counterpart of
 *  `withMeasuredEnds`, and its alternative rather than its companion.
 *
 *  Both hand a block its `[beat, endBeat)`, so everything downstream
 *  (`boundarySegmentsFromHits`, `mergeBoundaryHits`) is unchanged: it already
 *  honours a hit that knows its own length. Unlike the measured path this one
 *  overwrites an `endBeat` the hit arrived with — a marker is a statement
 *  about position only, and keeping a lyric line's duration here would
 *  produce a node of markers with one sustain in it.
 *
 *  `halfBeats` is `ONSET_MARKER_SEC` converted through the node's own tempo by
 *  the caller, which is the only place that knows it. Clamped into
 *  `[0, lengthBeats]`, so a hit on the node's first or last beat still gets a
 *  whole marker rather than half of one pushed off the edge. */
export function markerHits<T extends { beat: number; endBeat?: number }>(
  hits: readonly T[],
  halfBeats: number,
  lengthBeats: number,
): T[] {
  const len = Math.max(0, lengthBeats);
  const half = Math.max(0, halfBeats);
  if (!(half > 0) || !(len > 0)) return [...hits];
  return hits.map((h) => {
    if (!Number.isFinite(h.beat)) return h;
    // Slid inward at the edges rather than clipped: a marker is a fixed width
    // and a half-width one at beat 0 would read as a different kind of thing.
    const start = Math.min(Math.max(0, h.beat - half), Math.max(0, len - half * 2));
    return { ...h, beat: start, endBeat: Math.min(len, start + half * 2) };
  });
}

/**
 * Fills in the length of every hit that doesn't already know its own, by
 * measuring it off `levelCurve` — the bridge between the curve math above and
 * the boundary-block builders, which read a hit's `endBeat`.
 *
 * A hit that arrived with an end keeps it: a lyric line carries its own
 * duration, and a held tap is as long as the hand held it. Those are claims
 * from the source itself, and a measurement is not entitled to overrule them.
 * With no curve to read, nothing is added and the builders fall back to their
 * fixed block length.
 */
export function withMeasuredEnds<T extends { beat: number; endBeat?: number }>(
  hits: readonly T[],
  levelCurve: readonly number[] | null | undefined,
  lengthBeats: number,
  opts: { maxBeats?: number } = {},
): T[] {
  if (!levelCurve || levelCurve.length < 2 || hits.length === 0) return [...hits];
  const ends = onsetTickEnds(hits.map((h) => h.beat), levelCurve, lengthBeats, opts);
  if (ends.length === 0) return [...hits];
  return hits.map((h, i) => (
    h.endBeat != null || !(ends[i] > h.beat) ? h : { ...h, endBeat: ends[i] }
  ));
}
