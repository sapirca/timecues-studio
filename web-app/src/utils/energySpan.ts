/**
 * Energy-trend export for a highlighted time span, computed on a single
 * source (the full mix or one isolated Demucs stem) so the curve reads
 * clean instead of the noisy full-mix composite. Consumed externally (e.g.
 * by the LOL light-show agent) as a compact, LLM-readable JSON blob.
 *
 * Three readings come out of the same selection: the coarse *trend* (does this
 * stretch rise or fall?), the *envelope* — A/D/S/R measured off a finer pass,
 * describing the shape of the gesture rather than its direction — and
 * *brightness*, the spectral centroid over the same window.
 *
 * Brightness is here because level alone mis-reads the most common gesture in
 * dance music. A build strips the kick and the bass out and hands the tension
 * to a riser: broadband RMS *falls* through it while the sound gets steadily
 * brighter, so a span measuring only energy labels the bar before the drop
 * 'decreasing' — true of the level, and the opposite of what the passage does.
 * The two trends are reported side by side rather than folded into one verdict:
 * their disagreement IS the build, and a single number cannot say it.
 *
 * The envelope is only attempted once the span is shown to hold a *single*
 * gesture (`analyzeGestures`). ADSR models one onset, one peak, one decline;
 * over a selection holding two drops it would still return four confident
 * numbers describing nothing, so that case is rejected instead.
 *
 * The trend survives that rejection, and is the reading most spans are made
 * for — "does this stretch rise or fall" is a question about the whole
 * selection, not about whether it happens to hold one gesture or four. So it
 * is fitted across every frame (`fitTravel`) rather than read off the first
 * and last, and a span holding three louder-and-louder swells reports the
 * rise a listener hears instead of the fall its trailing frame sat in. Where
 * the gestures themselves are the story, `peakSequenceNote` says which way
 * their peaks are going.
 */

import { createHannWindow, fft, magnitudeSpectrum } from '../services/mirAnalysis';

export type EnergyTrend = 'increasing' | 'decreasing' | 'flat';

/** Coarse read of the envelope's overall gesture. Mostly the A/D/S/R
 *  proportions, plus the evidence those four numbers can't carry — whether an
 *  onset was captured at all, and which way the body of the sound is moving.
 *  Cheap for a consumer to branch on without inspecting numbers.
 *
 *  'swell' therefore covers a build into a drop whose own attack is short: the
 *  gesture is the rise, not the transient that ends it. */
export type AdsrShape = 'percussive' | 'swell' | 'sustained' | 'decaying';

/** Attack / Decay / Sustain / Release measured off the span's own energy
 *  contour. Times are milliseconds; `sustainLevel` is relative to the span's
 *  peak (see `peakRms` for an absolute anchor).
 *
 *  Attack is the 10%→90% rise into the peak — the envelope-follower
 *  convention, more robust than "span start → argmax" when the peak is
 *  flat-topped or the span opens mid-note. It therefore does NOT begin at
 *  t=0, so A+D+S+R need not sum to the span duration. */
export interface AdsrEnvelope {
  attackMs: number;
  decayMs: number;
  sustainMs: number;
  releaseMs: number;
  /** Plateau level, 0–1, relative to this span's own peak. */
  sustainLevel: number;
  /** Where the peak sits inside the span, ms from its start. */
  peakAtMs: number;
  /** Un-normalized RMS at the peak, so levels stay comparable across spans
   *  (everything else here is peak-normalized within the span). */
  peakRms: number;
  shape: AdsrShape;
}

export interface EnergyCurvePoint {
  t_ms: number;
  energy: number;
  /** Spectral centroid at this point, as a fraction of the span's peak
   *  centroid — so it shares the curve's 0–1 convention and `brightness_hz`
   *  carries the absolute anchor, exactly as `peak_rms` does for energy.
   *  Absent on a span too quiet to have a centroid, and on any export written
   *  before brightness was measured. */
  brightness?: number;
}

/** Spectral centroid across the span: which way the timbre moved, and between
 *  which frequencies. Peak-normalized values mirror `EnergyCurvePoint.energy`
 *  so the two curves are read the same way; the Hz are what make the reading
 *  mean anything on its own. */
export interface BrightnessReading {
  trend: EnergyTrend;
  /** Peak-normalized, matching `curve[].brightness`. */
  start: number;
  end: number;
  startHz: number;
  endHz: number;
  peakHz: number;
}

/** Why a span got no envelope. ADSR describes ONE gesture, so a selection
 *  holding two swells or two drops has no single envelope to report — and
 *  forcing one yields a confident-looking reading of nothing. */
export interface EnvelopeRejection {
  reason: 'multiple_gestures';
  gestureCount: number;
  /** Where the prominent peaks sit, ms from the span start. */
  peaksAtMs: number[];
  /** Lowest point between consecutive peaks — split here to get one envelope
   *  per gesture. Always `gestureCount - 1` entries. */
  splitAtMs: number[];
  /** Each peak's height relative to the span's tallest, in `peaksAtMs` order.
   *  The direction question, asked of the gestures themselves: a span refused
   *  an envelope still gets to say whether its hits are growing. */
  peakLevels: number[];
}

export interface EnergySpanResult {
  curve: EnergyCurvePoint[];
  startEnergy: number;
  endEnergy: number;
  trend: EnergyTrend;
  /** null exactly when `rejection` is set — the span isn't a single gesture. */
  adsr: AdsrEnvelope | null;
  rejection: EnvelopeRejection | null;
  /** null when the span holds no frame loud enough for a centroid to mean
   *  anything — the centroid of a noise floor is a number, not a timbre. */
  brightness: BrightnessReading | null;
}

/** Gesture census of a span: how many distinct swells/hits it contains. */
export interface GestureAnalysis {
  count: number;
  peaksAtMs: number[];
  splitAtMs: number[];
  /** How tall each peak stands, relative to the tallest gesture in the span.
   *  One entry per `peaksAtMs`, in the same order. Three swells reading
   *  0.61, 0.78, 1.00 are a build; the count and the split points alone say
   *  only that there were three of them. */
  peakLevels: number[];
}

const WINDOW_SEC = 0.05; // 50ms RMS window — same convention as analyzeEnergy in audioAnalysis.ts
const SMOOTH_RADIUS = 2; // moving-average half-width, in RMS-window units
// Travel along the fitted trend line, peak-relative, below which the span
// reads as 'flat'. Unchanged in meaning from the start/end delta it replaces —
// "the level moved less than 8% of this span's peak across its length" — so
// only the robustness of the measurement changed, not where the line is drawn.
const FLAT_THRESHOLD = 0.08;

// Brightness runs its own framing: 2048 samples is ~46ms at 44.1kHz, near
// enough to the RMS window above, and it is the frame size the whole-song pass
// in services/mirAnalysis uses — so a span's centroid and the Bright lane it is
// read against are measured the same way rather than merely similarly.
const BRIGHTNESS_FFT_SIZE = 2048;
const BRIGHTNESS_SMOOTH_RADIUS = 2; // moving-average half-width, in centroid frames
// Read against the span's peak centroid, so this is a relative shift: 0.08 is
// "the timbre moved 8% of where this span's brightest moment sits". Centroid
// wanders a percent or two on a held sound, and a filter sweep moves it by
// tens — there is a wide gap between those to put a threshold in.
const BRIGHTNESS_FLAT_THRESHOLD = 0.08;
// Peaks are already peak-relative to the loudest gesture in the span, so the
// same 8% applies to the question "are these hits growing?".
const PEAK_SEQUENCE_FLAT_THRESHOLD = 0.08;
// A frame this far below the span's loudest carries no timbre worth reporting:
// the centroid of near-silence is the centroid of the noise floor, which sits
// wherever the dither and the room do. Such frames are interpolated across
// rather than averaged in, so a gap between hits doesn't drag the curve.
const BRIGHTNESS_SILENCE_FLOOR = 0.02;
// Below this much travel (peak-relative) there is no gesture to draw, and
// stretching the remainder to fill a box turns ripple into a shape. See
// `brightnessPlotRange`.
const BRIGHTNESS_PLOT_MIN_RANGE = 0.04;

// The envelope runs on its own finer pass: a 50ms window smears a 20ms drum
// transient into a single frame, which is fine for a trend line and useless
// for an attack time.
const ADSR_WINDOW_SEC = 0.01;   // 10ms RMS window → 5ms hop
const ADSR_SMOOTH_RADIUS = 3;   // ±3 frames ≈ ±15ms — kills ripple without smearing transients
// Slope is measured as a fraction of the CURRENT level shed per span-duration,
// which makes the flat test scale-free on both axes: 0.5 means "extending this
// segment across the whole span would cost it more than half of where it sits
// right now". Relative rather than peak-relative on purpose — a cymbal tail
// sliding 0.15→0 is a release, even though it only spans 15% of the peak,
// while a pad drifting 0.80→0.60 across a long hold is still a plateau.
const ADSR_SLOPE_EPS = 0.5;
const ADSR_LEVEL_FLOOR = 0.05; // keeps the ratio finite once the contour reaches silence
// Slope is measured over a window CENTRED on the frame, so the plateau's edges
// land where the level actually turns rather than half a window early.
const ADSR_SLOPE_WIN_FRACTION = 0.08; // slope measured over 8% of the span
// A plateau that sheds more than this much of the peak across its own length
// was never a plateau — it is the decay still running (see the fold below).
const SUSTAIN_MAX_DROP = 0.3;
// A plateau has to be long enough and high enough to be one. Below these it is
// either a transient briefly interrupting a fall, or the silence after the
// gesture has finished — neither is a sustain.
const SUSTAIN_MIN_FRACTION = 0.08; // of the span
const SUSTAIN_MIN_LEVEL = 0.15;    // of the peak
// The peak's position is located on a lightly smoothed contour: at a 5ms hop
// even a dead-flat tone ripples a few percent, and the fine contour's argmax
// then lands wherever that ripple happened to crest. The exact crest is
// recovered from the fine contour within this radius, so a transient's
// peakAtMs keeps its precision.
const ADSR_SEG_SMOOTH_FRACTION = 0.02;
// The plateau question is asked of the *body* of the sound: its lower envelope,
// the level it holds between transients. Percussion rides ON TOP of what it
// plays over, so it is a purely additive excursion — a running minimum removes
// it outright, at any depth, where no amount of averaging can (a mean still
// carries a kick that doubles the level, and the beat period is absolute while
// the smoothing window is a fraction of a span that varies).
const ADSR_BODY_MS = 120; // radius; 240ms window straddles the gap between hits
// How long the contour has to stay under the attack's 10% floor before that
// counts as the quiet the gesture rose out of. Absolute, like the percussive
// thresholds: it is the gap between hits that has to be outlasted, and that gap
// is set by the tempo, not by the length of the selection. 120ms clears an
// eighth-note gap at any dance tempo while a real stop before a drop still
// registers.
const ADSR_QUIET_MS = 120;

// A span whose peak sits at its very end, arrived at by a body that rose on the
// way there, is a build into that peak — there is no fall in it to call a
// decay. This is the structural read, held apart from the fine attack
// measurement on purpose: a build that genuinely stops dead before the drop has
// a short, correct attack, and would otherwise still land in 'decaying' because
// nothing else fits.
const BUILD_MAX_TAIL_FRACTION = 0.15; // peak within the last 15% of the span
const BUILD_MIN_RISE = 0.25;          // body arrives ≥25% above where it started
const BUILD_EDGE_FRACTION = 0.2;      // compared over the first/last fifth of the rise

// Gesture census. Prominence is measured on a contour smoothed to gesture
// scale — a fixed *fraction* of the span, so beat-rate transients blur into
// the shape they ride on while a short span keeps its detail. At 3% of a 7s
// span that is a ~200ms radius, wider than a beat at 140bpm.
const GESTURE_SMOOTH_FRACTION = 0.03;
// How far a peak must stand above the deepest trough separating it from a
// taller peak before it counts as a gesture of its own, as a fraction of the
// span peak. Below this it is ripple on one gesture, not a second one.
const GESTURE_MIN_PROMINENCE = 0.25;

// "Percussive" is an absolute-time claim, not a relative one: a 7s fade has a
// short attack *relative to its span* but is in no sense a hit. Every other
// threshold here is scale-free on purpose; these two must not be.
const PERCUSSIVE_MAX_ATTACK_MS = 100;
// Time from the peak down to a tenth of it. This, not the A/D/S/R bookkeeping,
// is what separates a hit from a fade that merely *opens* on one: a snare is
// spent in ~100ms, a breakdown fade takes seconds to cover the same ground.
const PERCUSSIVE_MAX_FALL_MS = 500;

/**
 * RMS-in-windows over a channel-averaged slice of an AudioBuffer, smoothed
 * and resampled to `numPoints`. Energy is normalized against the peak
 * *within the selected span* (not the whole song) — the export describes
 * how energy moves across this span, not its level relative to the rest of
 * the track.
 */
export function computeStemEnergySpan(opts: {
  audioBuffer: AudioBuffer;
  startSec: number;
  endSec: number;
  numPoints?: number;
}): EnergySpanResult {
  const { audioBuffer, numPoints = 12 } = opts;
  const sampleRate = audioBuffer.sampleRate;
  const startSec = Math.max(0, Math.min(opts.startSec, opts.endSec));
  const endSec = Math.min(audioBuffer.duration, Math.max(opts.startSec, opts.endSec));
  const startSample = Math.floor(startSec * sampleRate);
  const endSample = Math.max(startSample + 1, Math.floor(endSec * sampleRate));

  const windowSize = Math.max(1, Math.floor(sampleRate * WINDOW_SEC));
  const hopSize = Math.max(1, Math.floor(windowSize / 2));
  const raw = rmsFrames(audioBuffer, startSample, endSample, windowSize, hopSize);

  // Envelope gets its own finer pass — see ADSR_WINDOW_SEC. Normalized against
  // its own peak (sharper windows catch a higher transient than the 50ms pass).
  const adsrWindow = Math.max(1, Math.floor(sampleRate * ADSR_WINDOW_SEC));
  const adsrHop = Math.max(1, Math.floor(adsrWindow / 2));
  const adsrRaw = rmsFrames(audioBuffer, startSample, endSample, adsrWindow, adsrHop);
  const adsrPeakRms = Math.max(...adsrRaw, 1e-9);
  const adsrFrames = movingAverage(adsrRaw.map((v) => v / adsrPeakRms), ADSR_SMOOTH_RADIUS);
  const adsrHopSec = adsrHop / sampleRate;

  // Ask whether an envelope is meaningful here before measuring one.
  const gestures = analyzeGestures(adsrFrames, adsrHopSec);
  const rejection: EnvelopeRejection | null =
    gestures.count > 1
      ? {
          reason: 'multiple_gestures',
          gestureCount: gestures.count,
          peaksAtMs: gestures.peaksAtMs,
          splitAtMs: gestures.splitAtMs,
          peakLevels: gestures.peakLevels,
        }
      : null;
  const adsr = rejection ? null : computeAdsrEnvelope(adsrFrames, adsrHopSec, adsrPeakRms);

  const maxRaw = Math.max(...raw, 1e-9);
  const normalized = raw.map((v) => v / maxRaw);
  const smoothed = movingAverage(normalized, SMOOTH_RADIUS);
  const points = resample(smoothed, Math.max(2, numPoints));
  const durationMs = (endSec - startSec) * 1000;

  // Same slice, same point count, different question. Resampling both passes
  // onto the one grid is what lets a consumer read level and timbre off a
  // single array and see where they part company.
  const centroidHz = centroidFrames(audioBuffer, startSample, endSample);
  const smoothedHz = centroidHz ? movingAverage(centroidHz, BRIGHTNESS_SMOOTH_RADIUS) : null;
  const brightnessPoints = smoothedHz ? resample(smoothedHz, Math.max(2, numPoints)) : null;
  const peakHz = brightnessPoints ? Math.max(...brightnessPoints, 1e-9) : 0;

  const curve: EnergyCurvePoint[] = points.map((energy, idx) => {
    const point: EnergyCurvePoint = {
      t_ms: Math.round((idx / (points.length - 1 || 1)) * durationMs),
      energy: Math.round(energy * 1000) / 1000,
    };
    if (brightnessPoints) {
      point.brightness = Math.round((brightnessPoints[idx] / peakHz) * 1000) / 1000;
    }
    return point;
  });

  // Direction is fitted across the WHOLE contour — every 25ms frame of it, not
  // the twelve display points and emphatically not their two ends. See
  // `fitTravel` for why an endpoint pair cannot answer this question.
  const fitted = fitTravel(smoothed);
  const trend: EnergyTrend =
    Math.abs(fitted.delta) < FLAT_THRESHOLD
      ? 'flat'
      : fitted.delta > 0
        ? 'increasing'
        : 'decreasing';
  // What gets reported is that line's own endpoints, so the two numbers quoted
  // in the description are the two the verdict was read from — they used to be
  // able to contradict it.
  const startEnergy = round3(fitted.start);
  const endEnergy = round3(fitted.end);

  const brightness = smoothedHz ? readBrightness(smoothedHz, peakHz) : null;

  return { curve, startEnergy, endEnergy, trend, adsr, rejection, brightness };
}

/** Trend + absolute anchors for a span's centroid. Split out so the threshold
 *  lives next to the one other place trends are decided — and fitted the same
 *  way, over the same full-resolution frames, because the timbre reading fails
 *  on an endpoint pair for exactly the reason the level reading does: a sweep
 *  that crests mid-span and settles reported the settle, and the crest (which
 *  `peakHz` had been saying all along) never reached the verdict. */
function readBrightness(smoothedHz: number[], peakHz: number): BrightnessReading {
  const fitted = fitTravel(smoothedHz);
  const delta = fitted.delta / peakHz;
  return {
    trend:
      Math.abs(delta) < BRIGHTNESS_FLAT_THRESHOLD ? 'flat' : delta > 0 ? 'increasing' : 'decreasing',
    // `peakHz` is the peak of the RESAMPLED curve, a hair under the peak of the
    // frames fitted here, so the normalized pair still needs its own ceiling to
    // keep the 0–1 convention `curve[].brightness` is written in.
    start: round3(clamp01(fitted.start / peakHz)),
    end: round3(clamp01(fitted.end / peakHz)),
    // The Hz pair is the trend line's, matching the verdict beside it.
    startHz: Math.round(fitted.start),
    endHz: Math.round(fitted.end),
    peakHz: Math.round(peakHz),
  };
}

/**
 * Per-frame spectral centroid in Hz over a slice, on the framing
 * `services/mirAnalysis` uses for the whole song. Returns null when no frame
 * in the slice clears the silence floor.
 *
 * Frames that don't clear the floor are interpolated across rather than
 * dropped or averaged in: the gap between two hits is silent, its centroid is
 * whatever the noise floor happens to be, and letting that into the curve
 * makes a clean beat look like a timbre that lurches every few hundred ms.
 */
function centroidFrames(
  buffer: AudioBuffer,
  startSample: number,
  endSample: number,
): number[] | null {
  const sampleRate = buffer.sampleRate;
  const available = endSample - startSample;
  if (available <= 0) return null;

  const channelCount = buffer.numberOfChannels;
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < channelCount; ch++) channels.push(buffer.getChannelData(ch));

  // A selection shorter than one frame still gets a reading, from a single
  // zero-padded window — the same courtesy rmsFrames extends to a short span.
  const fftSize = BRIGHTNESS_FFT_SIZE;
  const hopSize = fftSize / 2;
  const halfSpectrum = fftSize / 2 + 1;
  const freqBinWidth = sampleRate / fftSize;
  const window = createHannWindow(fftSize);
  const real = new Float32Array(fftSize);
  const imag = new Float32Array(fftSize);
  const mag = new Float32Array(halfSpectrum);

  const hz: number[] = [];
  const weight: number[] = [];
  const lastStart = Math.max(startSample, endSample - fftSize);
  for (let i = startSample; i <= lastStart; i += hopSize) {
    real.fill(0);
    imag.fill(0);
    const frameEnd = Math.min(i + fftSize, endSample);
    for (let j = 0; i + j < frameEnd; j++) {
      let sum = 0;
      for (const data of channels) sum += data[i + j];
      real[j] = (sum / channelCount) * window[j];
    }
    fft(real, imag);
    magnitudeSpectrum(real, imag, mag);

    let weightedSum = 0;
    let magSum = 0;
    for (let b = 0; b < halfSpectrum; b++) {
      weightedSum += b * freqBinWidth * mag[b];
      magSum += mag[b];
    }
    hz.push(magSum > 0 ? weightedSum / magSum : 0);
    weight.push(magSum);
  }
  if (hz.length === 0) return null;

  const floor = Math.max(...weight) * BRIGHTNESS_SILENCE_FLOOR;
  if (floor <= 0) return null;
  const loud = hz.map((_, idx) => weight[idx] >= floor);
  if (!loud.some(Boolean)) return null;
  return interpolateGaps(hz, loud);
}

/** Replaces every `!keep[i]` entry with a straight line between its nearest
 *  kept neighbours, holding flat past either end. */
function interpolateGaps(values: number[], keep: boolean[]): number[] {
  const out = values.slice();
  let prev = -1;
  for (let i = 0; i < out.length; i++) {
    if (!keep[i]) continue;
    if (prev === -1) {
      for (let j = 0; j < i; j++) out[j] = out[i];
    } else if (i - prev > 1) {
      for (let j = prev + 1; j < i; j++) {
        out[j] = out[prev] + ((out[i] - out[prev]) * (j - prev)) / (i - prev);
      }
    }
    prev = i;
  }
  for (let j = prev + 1; j < out.length; j++) out[j] = out[prev];
  return out;
}

/**
 * The vertical range a brightness curve should be DRAWN across — its own
 * travel within the span, not the 0–1 box the energy curve fills.
 *
 * Peak-normalized centroid is the honest number to export and a bad line to
 * look at: a sweep from 1.8kHz to 4.4kHz lives between 0.41 and 1.0, and one
 * from 3.0 to 3.6kHz is pinned to the top eighth of the box, where the gesture
 * the span was created to record is a curve you have to be told is there. So
 * the drawing stretches the travel — computed once over the WHOLE curve, never
 * per viewport, so trimming a band cannot change the shape of the line inside
 * it. Returns null when there is too little travel to stretch, which the
 * caller draws as a flat line rather than as amplified ripple.
 */
export function brightnessPlotRange(
  curve: EnergyCurvePoint[],
): { lo: number; hi: number } | null {
  const values = curve.map((p) => p.brightness).filter((b): b is number => b != null);
  if (values.length === 0) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (hi - lo < BRIGHTNESS_PLOT_MIN_RANGE) return null;
  // A little headroom at both ends, so the extremes are marks on a line rather
  // than points welded to the ceiling and the floor of the box.
  const pad = (hi - lo) * 0.15;
  return { lo: lo - pad, hi: hi + pad };
}

/** RMS-in-windows over a channel-averaged slice. A selection shorter than one
 *  window still gets a single frame, from a straight average over whatever
 *  samples it has, instead of an empty result. */
function rmsFrames(
  buffer: AudioBuffer,
  startSample: number,
  endSample: number,
  windowSize: number,
  hopSize: number,
): number[] {
  const channelCount = buffer.numberOfChannels;
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < channelCount; ch++) channels.push(buffer.getChannelData(ch));

  const out: number[] = [];
  for (let i = startSample; i + windowSize <= endSample; i += hopSize) {
    let sum = 0;
    for (const data of channels) {
      for (let j = 0; j < windowSize; j++) {
        const v = data[i + j];
        sum += v * v;
      }
    }
    out.push(Math.sqrt(sum / (windowSize * channelCount)));
  }
  if (out.length === 0) {
    let sum = 0;
    let n = 0;
    for (const data of channels) {
      for (let i = startSample; i < endSample; i++) { sum += data[i] * data[i]; n++; }
    }
    out.push(n > 0 ? Math.sqrt(sum / n) : 0);
  }
  return out;
}

/**
 * Counts the distinct gestures in a peak-normalized contour by topographic
 * *prominence*: how far a peak stands above the deepest trough separating it
 * from any taller peak. Prominence is the right measure here because height
 * alone can't tell a second drop from a loud beat inside one — the trough
 * between them is what distinguishes the two.
 *
 * Run on a gesture-scale smoothing of the contour (GESTURE_SMOOTH_FRACTION),
 * so per-beat transients don't each register as a gesture.
 *
 * A count of 1 means the span holds one onset/peak/decline and ADSR applies.
 * More than 1 means it doesn't, and `splitAtMs` gives the troughs to cut at.
 */
export function analyzeGestures(frames: number[], hopSec: number): GestureAnalysis {
  const n = frames.length;
  const ms = (i: number) => Math.round(i * hopSec * 1000);
  if (n < 5) {
    let peak = 0;
    for (let i = 1; i < n; i++) if (frames[i] > frames[peak]) peak = i;
    return { count: 1, peaksAtMs: [ms(peak)], splitAtMs: [], peakLevels: [1] };
  }

  const coarse = movingAverage(frames, Math.max(1, Math.round(n * GESTURE_SMOOTH_FRACTION)));
  const max = Math.max(...coarse, 1e-9);
  const c = coarse.map((v) => v / max);

  // Local maxima, endpoints included — a fade-out peaks at frame 0 and a swell
  // at the last frame; both are single gestures. Runs of equal height collapse
  // to their first index so a plateau isn't counted once per frame.
  const candidates: number[] = [];
  for (let i = 0; i < n; i++) {
    const prev = i === 0 ? -Infinity : c[i - 1];
    const next = i === n - 1 ? -Infinity : c[i + 1];
    if (c[i] > prev && c[i] >= next && c[i] >= GESTURE_MIN_PROMINENCE) candidates.push(i);
  }

  const prominence = (i: number): number => {
    const h = c[i];
    let left = h;
    for (let j = i; j >= 0; j--) { if (c[j] > h) break; left = Math.min(left, c[j]); }
    let right = h;
    for (let j = i; j < n; j++) { if (c[j] > h) break; right = Math.min(right, c[j]); }
    return h - Math.max(left, right);
  };

  const peaks = candidates.filter((i) => prominence(i) >= GESTURE_MIN_PROMINENCE);
  if (peaks.length === 0) {
    let peak = 0;
    for (let i = 1; i < n; i++) if (c[i] > c[peak]) peak = i;
    return { count: 1, peaksAtMs: [ms(peak)], splitAtMs: [], peakLevels: [1] };
  }

  const splitAtMs: number[] = [];
  for (let k = 1; k < peaks.length; k++) {
    let lowest = peaks[k - 1];
    for (let j = peaks[k - 1]; j <= peaks[k]; j++) if (c[j] < c[lowest]) lowest = j;
    splitAtMs.push(ms(lowest));
  }

  // Heights come off `c`, already normalized to the tallest gesture — so the
  // biggest peak is 1.00 and the rest read as a proportion of it.
  return {
    count: peaks.length,
    peaksAtMs: peaks.map(ms),
    splitAtMs,
    peakLevels: peaks.map((i) => round3(c[i])),
  };
}

/**
 * Segments a peak-normalized, smoothed energy contour into A/D/S/R.
 *
 * - **Attack** — 10%→90% rise into the peak, linearly interpolated between
 *   frames.
 * - **Decay** — peak until the plateau starts.
 * - **Sustain** — the plateau: the LONGEST run of non-falling frames after the
 *   peak that is both long enough (SUSTAIN_MIN_FRACTION of the span) and high
 *   enough (SUSTAIN_MIN_LEVEL of the peak) to be a hold rather than a
 *   transient or the silence afterwards. Level is the median over it.
 * - **Release** — end of the plateau to the end of the span.
 *
 * When no run qualifies there is no plateau: D and S read 0 and the whole
 * post-peak fall is the release. D and R are not separable without a plateau
 * between them, so the fall is reported once rather than split at an arbitrary
 * point (which is what the old midpoint collapse did), and it goes to R because
 * 'decay' means "down to the sustain level" and there is no sustain level.
 * `sustainLevel` is 0 in that case rather than an invented hold.
 *
 * The shape label is not a re-reading of those four numbers alone: 'percussive'
 * additionally requires an onset captured inside the span, an attack inside
 * PERCUSSIVE_MAX_ATTACK_MS and a fall to a tenth of the peak inside
 * PERCUSSIVE_MAX_FALL_MS — both absolute, because a hit is an absolute-time
 * thing. Anything with a fast onset and a quiet body used to land here, which
 * made 'decaying' unreachable for the fade-outs it exists to describe.
 *
 * 'decaying' is the fallthrough, so it also has to be kept honest from the
 * other side: a span that peaks at its very end, having risen to get there,
 * has no fall in it to decay. It reads 'swell' whatever the attack measured —
 * the drop transient's own rise is short by construction, and on a build that
 * stops dead before the drop it is short and *correct*. Without that, a build
 * came back labelled 'decaying' beside a trend line on the same result reading
 * 'increasing'.
 *
 * Two things make this survive a real mix, where percussion rides on top of
 * whatever is being held. The plateau is sought in the contour's LOWER ENVELOPE
 * (ADSR_BODY_FRACTION) — the level between hits, which is what "holding" means
 * when a kick lands every 400ms — and it is the LONGEST qualifying run, not the
 * first pause in the fall. A first-failure walk ended on the first kick after
 * the peak; a transient cannot win a longest-run contest. SUSTAIN_MAX_DROP
 * stays as a backstop for a run that drifts down within the slope threshold.
 *
 * "Falling" is a relative slope test (ADSR_SLOPE_EPS) over a centred window, so
 * it behaves the same on a 0.3s drum hit and a 30s build.
 *
 * Degenerate contours fall out cleanly: a monotonic rise ends with D=S=R=0, and
 * a contour peaking at frame 0 gives A=0.
 */
export function computeAdsrEnvelope(
  frames: number[],
  hopSec: number,
  peakRms: number,
): AdsrEnvelope {
  const n = frames.length;
  const ms = (i: number) => i * hopSec * 1000;
  const totalMs = ms(Math.max(0, n - 1));

  if (n < 3) {
    return {
      attackMs: 0, decayMs: 0, sustainMs: totalMs, releaseMs: 0,
      sustainLevel: round3(frames[0] ?? 0), peakAtMs: 0,
      peakRms: round4(peakRms), shape: 'sustained',
    };
  }

  const segRadius = Math.max(1, Math.round(n * ADSR_SEG_SMOOTH_FRACTION));
  const seg = movingAverage(frames, segRadius);
  let segPeakIdx = 0;
  for (let i = 1; i < n; i++) if (seg[i] > seg[segPeakIdx]) segPeakIdx = i;
  let peakIdx = Math.max(0, segPeakIdx - segRadius);
  for (let i = peakIdx; i <= Math.min(n - 1, segPeakIdx + segRadius); i++) {
    if (frames[i] > frames[peakIdx]) peakIdx = i;
  }
  const peak = Math.max(...frames, 1e-9);

  // The body: what the sound holds between hits. Smoothed after the minimum to
  // take the stair-steps back out.
  const bodyRadius = Math.max(1, Math.round(ADSR_BODY_MS / 1000 / hopSec));
  const body = movingAverage(lowerEnvelope(frames, bodyRadius), bodyRadius);

  // ── Attack: 10% → 90% rise into the peak ────────────────────────────────
  const loLevel = 0.1 * peak;
  const hiLevel = 0.9 * peak;
  let hiIdx = peakIdx;
  for (let i = 0; i <= peakIdx; i++) { if (frames[i] >= hiLevel) { hiIdx = i; break; } }
  // The rise starts where the sound was last *genuinely* quiet: under the 10%
  // floor and staying there for ADSR_QUIET_MS. A single frame dipping under it
  // is the gap between two hits, not the start of the gesture — and inside a
  // build the hits tower over the body they ride on, so the floor sits low
  // enough that every such gap ducks below it. Taking the nearest one read a
  // 6.5s build into a drop as a 40ms attack, which then labelled it 'decaying'.
  const quietRun = Math.max(1, Math.round(ADSR_QUIET_MS / 1000 / hopSec));
  let loIdx = -1;
  for (let i = hiIdx; i >= 0; i--) {
    if (frames[i] > loLevel) continue;
    let quiet = true;
    for (let j = i + 1; j <= Math.min(hiIdx, i + quietRun); j++) {
      if (frames[j] > loLevel) { quiet = false; break; }
    }
    if (quiet) { loIdx = i; break; }
  }
  // That scan stops a quiet window early; the rise begins where the quiet
  // stretch actually ends.
  while (loIdx >= 0 && loIdx < hiIdx && frames[loIdx + 1] <= loLevel) loIdx++;
  // No 10% crossing means the span opens above it — measure the rise from t=0.
  const riseStartMs = loIdx < 0 ? 0 : crossingMs(frames, loIdx + 1, loLevel, hopSec);
  const attackMs = Math.max(0, crossingMs(frames, hiIdx, hiLevel, hopSec) - riseStartMs);

  // ── Decay / sustain / release: where the contour stops and resumes falling ─
  const slopeWin = Math.max(1, Math.round(n * ADSR_SLOPE_WIN_FRACTION));
  const spanSec = Math.max(hopSec * (n - 1), 1e-9);
  const slopeAt = (from: number, to: number) => {
    if (from === to) return 0;
    const base = Math.max(body[from], ADSR_LEVEL_FLOOR);
    return ((body[to] - body[from]) / base) * (spanSec / ((to - from) * hopSec));
  };

  const half = Math.max(1, Math.round(slopeWin / 2));
  const falling = (i: number) =>
    slopeAt(Math.max(0, i - half), Math.min(n - 1, i + half)) < -ADSR_SLOPE_EPS;

  // Longest qualifying run of non-falling frames after the peak. Ties go to the
  // earliest run, so a hold right after the peak beats a flat stretch later.
  const minRun = Math.max(1, Math.round(n * SUSTAIN_MIN_FRACTION));
  // No qualifying run means no plateau. D and R are not separable without one
  // between them, so the whole post-peak fall is reported once, as the release:
  // 'decay' means "down to the sustain level", and there is no sustain level.
  let settleIdx = peakIdx;
  let releaseIdx = peakIdx;
  let bestLen = 0;
  for (let i = peakIdx; i < n; i++) {
    if (falling(i)) continue;
    let end = i;
    while (end + 1 < n && !falling(end + 1)) end++;
    const len = end - i + 1;
    if (
      len > bestLen && len >= minRun &&
      median(body.slice(i, end + 1)) >= SUSTAIN_MIN_LEVEL * peak
    ) {
      bestLen = len;
      settleIdx = i;
      releaseIdx = end;
    }
    i = end;
  }

  // A running minimum sees a fall coming: it drops as soon as the window's
  // leading edge reaches the fall, so both ends of the run land one radius
  // early. Shift them back onto the signal.
  if (releaseIdx > settleIdx) {
    releaseIdx = Math.min(n - 1, releaseIdx + bodyRadius);
    settleIdx = Math.min(releaseIdx, settleIdx + bodyRadius);
  }

  // Backstop: a run can drift downhill while every individual slope reading
  // stays inside the threshold. If it sheds most of the peak across its own
  // length it was the decay all along, not a plateau.
  if (releaseIdx > settleIdx && body[settleIdx] - body[releaseIdx] > SUSTAIN_MAX_DROP) {
    settleIdx = releaseIdx;
  }

  const decayMs = Math.max(0, ms(settleIdx) - ms(peakIdx));
  const sustainMs = Math.max(0, ms(releaseIdx) - ms(settleIdx));
  const releaseMs = Math.max(0, totalMs - ms(releaseIdx));
  // With no plateau there is no level to report — 0 says "nothing held here",
  // where echoing the peak or a midpoint of the fall would invent a hold.
  const sustainLevel = releaseIdx > settleIdx ? median(body.slice(settleIdx, releaseIdx + 1)) : 0;

  const dur = totalMs || 1;
  // attackMs === 0 means the peak sits at frame 0: the span opened at its
  // loudest and no onset was captured. That is absence of evidence, not
  // evidence of a fast attack, so it can't support a 'percussive' read.
  const hasOnset = peakIdx > 0 && attackMs > 0;
  let fallIdx = n - 1;
  for (let i = peakIdx; i < n; i++) { if (frames[i] <= 0.1 * peak) { fallIdx = i; break; } }
  const fallMs = frames[fallIdx] <= 0.1 * peak ? ms(fallIdx) - ms(peakIdx) : Infinity;

  // Nothing came down: the peak sits at the end of the span and the body
  // arrived higher than it started. Measured on the body, so the transients a
  // build is made of don't decide it, and over the rise only — the couple of
  // frames after a peak at the span's edge are too few to read anything from.
  const tailMs = totalMs - ms(peakIdx);
  const edge = Math.max(1, Math.round(peakIdx * BUILD_EDGE_FRACTION));
  const openLevel = median(body.slice(0, edge));
  const preLevel = median(body.slice(Math.max(0, peakIdx - edge), peakIdx + 1));
  const isBuild =
    tailMs <= BUILD_MAX_TAIL_FRACTION * dur &&
    (preLevel - openLevel) / Math.max(openLevel, ADSR_LEVEL_FLOOR) >= BUILD_MIN_RISE;

  const shape: AdsrShape =
    attackMs >= 0.35 * dur || isBuild ? 'swell'
    // Either a high plateau over much of the span, or a plateau over most of
    // it at any level clearing SUSTAIN_MIN_LEVEL. The second arm matters when a
    // transient owns the peak: every level is a fraction of THAT, so a pad
    // genuinely holding all span long reads 0.44 of peak and would otherwise
    // fall through to 'decaying' with 2.5s of measured sustain sitting there.
    : (sustainMs >= 0.40 * dur && sustainLevel >= 0.55) || sustainMs >= 0.55 * dur
      ? 'sustained'
    : hasOnset && attackMs <= PERCUSSIVE_MAX_ATTACK_MS && fallMs <= PERCUSSIVE_MAX_FALL_MS
      ? 'percussive'
    : 'decaying';

  return {
    attackMs: Math.round(attackMs),
    decayMs: Math.round(decayMs),
    sustainMs: Math.round(sustainMs),
    releaseMs: Math.round(releaseMs),
    sustainLevel: round3(sustainLevel),
    peakAtMs: Math.round(ms(peakIdx)),
    peakRms: round4(peakRms),
    shape,
  };
}

/** Time (ms) at which the contour crosses `level` on the way into frame `i`
 *  (the first frame at or beyond it), linearly interpolated off the gap
 *  between `i-1` and `i`. */
function crossingMs(frames: number[], i: number, level: number, hopSec: number): number {
  if (i <= 0) return 0;
  const prev = frames[i - 1];
  const denom = frames[i] - prev;
  const frac = denom === 0 ? 0 : (level - prev) / denom;
  return (i - 1 + Math.max(0, Math.min(1, frac))) * hopSec * 1000;
}

/** Running minimum over a window of CONSTANT width, anchored inside the array
 *  at the edges. A window that shrank at the ends would report a higher minimum
 *  there — which reads as a peak, or a fall away from one, that is not in the
 *  signal. */
function lowerEnvelope(values: number[], radius: number): number[] {
  const n = values.length;
  const width = Math.min(2 * radius, n - 1);
  return values.map((_, i) => {
    const lo = Math.min(Math.max(0, i - radius), n - 1 - width);
    let min = Infinity;
    for (let j = lo; j <= lo + width; j++) min = Math.min(min, values[j]);
    return min;
  });
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const round4 = (v: number) => Math.round(v * 10000) / 10000;

function movingAverage(values: number[], radius: number): number[] {
  if (radius <= 0) return values;
  return values.map((_, i) => {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(values.length - 1, i + radius);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += values[j];
    return sum / (hi - lo + 1);
  });
}

/**
 * Least-squares line through evenly-spaced values, returned as that line's two
 * endpoints rather than its slope — so the numbers read exactly the way the
 * first-and-last pair they replace did, and every threshold written against
 * "how far did this travel across the span" keeps its meaning.
 *
 * Endpoints are the one thing a trend must NOT be read from. `values[0]` and
 * `values[n-1]` are single frames: on any span holding more than one hit they
 * sit wherever the selection's edges happened to land, so a passage whose every
 * gesture is louder than the last reported 'decreasing' whenever the drag
 * finished in the tail after the final peak — true of that frame, and the
 * opposite of the passage. A fit spends every frame on the question, so no
 * single one can decide it, and trimming a span by a beat nudges the verdict
 * instead of inverting it.
 *
 * Centring x on the array's midpoint drops the intercept out of the normal
 * equations: the fitted value at the centre is just the mean.
 *
 * `start` and `end` are held inside the range the data actually occupied. A
 * least-squares line overshoots its own extremes at the ends — mildly on a
 * monotonic sweep, which is how a centroid rising 0.9kHz → 3.9kHz came back
 * quoting an endpoint of 3964Hz above a measured peak of 3937Hz. Nothing here
 * ever wants to print a level or a frequency the span never reached. `delta`
 * is the unclamped travel and is what every verdict is decided on, so the
 * clamp cannot quietly flatten a trend it was only meant to keep honest.
 */
function fitTravel(values: number[]): { start: number; end: number; delta: number } {
  const n = values.length;
  if (n === 0) return { start: 0, end: 0, delta: 0 };
  if (n === 1) return { start: values[0], end: values[0], delta: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const xMean = (n - 1) / 2;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    num += dx * (values[i] - mean);
    den += dx * dx;
  }
  const half = (den === 0 ? 0 : num / den) * ((n - 1) / 2);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const hold = (v: number) => Math.max(lo, Math.min(hi, v));
  return { start: hold(mean - half), end: hold(mean + half), delta: half * 2 };
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Linear-resamples `values` (any length >= 1) to exactly `n` points. */
function resample(values: number[], n: number): number[] {
  if (values.length === 1) return new Array(n).fill(values[0]);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const pos = (i / (n - 1)) * (values.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(values.length - 1, lo + 1);
    const frac = pos - lo;
    out.push(values[lo] * (1 - frac) + values[hi] * frac);
  }
  return out;
}

export interface EnergySpanExport {
  type: 'energy_span';
  song: string;
  stem: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  trend: EnergyTrend;
  start_energy: number;
  end_energy: number;
  /** Which way the spectral centroid moved across the span — the other half of
   *  the reading, and the half that names a build. `trend` above is level
   *  only, so the two disagree exactly where a passage sheds its low end while
   *  getting brighter. null on a span too quiet to have a timbre, and on any
   *  export written before brightness was measured. */
  brightness_trend: EnergyTrend | null;
  /** Absolute anchor for `curve[].brightness`, which is peak-normalized the
   *  way `energy` is. Rounded to whole Hz. */
  brightness_hz: { start: number; end: number; peak: number } | null;
  curve: EnergyCurvePoint[];
  /** null when the span holds no single gesture — `envelope_rejected` says why.
   *  The trend and curve above stay valid either way. */
  envelope: EnvelopeExport | null;
  envelope_rejected: EnvelopeRejectedExport | null;
  description: string;
}

/** Snake-case mirror of `EnvelopeRejection` for the LLM-facing blob. */
export interface EnvelopeRejectedExport {
  reason: 'multiple_gestures';
  gesture_count: number;
  peaks_at_ms: number[];
  split_at_ms: number[];
  /** Each peak's height relative to the span's tallest. Absent on any blob
   *  written before the peak sequence was measured. */
  peak_levels?: number[];
}

/** Snake-case mirror of `AdsrEnvelope` for the LLM-facing blob. */
export interface EnvelopeExport {
  shape: AdsrShape;
  attack_ms: number;
  decay_ms: number;
  sustain_ms: number;
  release_ms: number;
  sustain_level: number;
  peak_at_ms: number;
  peak_rms: number;
}

/** Assembles the LLM-facing export blob: numbers plus a one-line natural-
 *  language summary, so a consumer can act on it without parsing the curve. */
export function buildEnergySpanExport(opts: {
  songSlug: string;
  stem: string;
  startSec: number;
  endSec: number;
  result: EnergySpanResult;
}): EnergySpanExport {
  const { songSlug, stem, result } = opts;
  const { adsr, rejection } = result;
  const startSec = Math.min(opts.startSec, opts.endSec);
  const endSec = Math.max(opts.startSec, opts.endSec);
  const durationSec = endSec - startSec;
  const { brightness } = result;
  const trendPhrase =
    result.trend === 'flat'
      ? `stays roughly flat around ${result.startEnergy.toFixed(2)}`
      : `${result.trend === 'increasing' ? 'rises' : 'falls'} from ${result.startEnergy.toFixed(2)} to ${result.endEnergy.toFixed(2)}`;
  // Level and timbre in one sentence, and named as a build when they disagree
  // the way a build does — that pairing is the reason brightness is measured
  // at all, so the consumer should not have to infer it from two trend fields.
  const brightnessPhrase = !brightness
    ? ''
    : brightness.trend === 'flat'
      ? ` Brightness holds near ${fmtHz(brightness.startHz)}.`
      : ` Brightness ${brightness.trend === 'increasing' ? 'rises' : 'falls'} ` +
        `${fmtHz(brightness.startHz)} → ${fmtHz(brightness.endHz)}` +
        (result.trend === 'decreasing' && brightness.trend === 'increasing'
          ? ' — level falling while the timbre opens up, the shape of a build.'
          : '.');
  const atSec = (ms: number) => `${(startSec + ms / 1000).toFixed(1)}s`;
  // A rejection used to be all refusal: three gestures, here are the split
  // points, good luck. But "which way is this going" has an answer across
  // gestures too, and it is usually the answer the span was made for — so the
  // peak sequence leads, and the split points follow as the way to get an
  // envelope as well.
  const sequence = peakSequenceNote(rejection?.peakLevels);
  const envelopePhrase = adsr
    ? `Envelope reads ${adsr.shape}: attack ${adsr.attackMs}ms, decay ${adsr.decayMs}ms, ` +
      `sustain ${adsr.sustainMs}ms at ${adsr.sustainLevel.toFixed(2)} of peak, release ${adsr.releaseMs}ms.`
    : `No envelope reported: this span holds ${rejection?.gestureCount} separate gestures ` +
      `(peaks at ${rejection?.peaksAtMs.map(atSec).join(', ')}), and A/D/S/R describes one` +
      `${sequence ? ` — ${sequence}` : ''}. ` +
      `Split it at ${rejection?.splitAtMs.map(atSec).join(', ')} to read each gesture on its own.`;

  return {
    type: 'energy_span',
    song: songSlug,
    stem,
    start_ms: Math.round(startSec * 1000),
    end_ms: Math.round(endSec * 1000),
    duration_ms: Math.round(durationSec * 1000),
    trend: result.trend,
    start_energy: result.startEnergy,
    end_energy: result.endEnergy,
    brightness_trend: brightness?.trend ?? null,
    brightness_hz: brightness
      ? { start: brightness.startHz, end: brightness.endHz, peak: brightness.peakHz }
      : null,
    curve: result.curve,
    envelope: adsr && {
      shape: adsr.shape,
      attack_ms: adsr.attackMs,
      decay_ms: adsr.decayMs,
      sustain_ms: adsr.sustainMs,
      release_ms: adsr.releaseMs,
      sustain_level: adsr.sustainLevel,
      peak_at_ms: adsr.peakAtMs,
      peak_rms: adsr.peakRms,
    },
    envelope_rejected: rejection && {
      reason: rejection.reason,
      gesture_count: rejection.gestureCount,
      peaks_at_ms: rejection.peaksAtMs,
      split_at_ms: rejection.splitAtMs,
      peak_levels: rejection.peakLevels,
    },
    description:
      `Energy on the ${stem} stem ${trendPhrase} over ${durationSec.toFixed(1)}s ` +
      `(${startSec.toFixed(1)}s–${endSec.toFixed(1)}s).${brightnessPhrase} ${envelopePhrase}`,
  };
}

/**
 * Which way a multi-gesture span's peaks are going, as a phrase.
 *
 * The direction question asked of the gestures themselves, for the one span
 * shape where a single envelope is refused. Fitted like every other trend here
 * rather than read off the first and last peak, for the same reason — with
 * three or four points, one loud outlier at an end is the whole comparison.
 *
 * Levels are relative to the loudest gesture in the span, so the sequence reads
 * as a proportion of its own biggest moment. Returns null when there is no
 * sequence to describe: one peak, or a blob written before these were measured.
 */
export function peakSequenceNote(levels: number[] | undefined | null): string | null {
  const word = peakSequenceWord(levels);
  if (!word || !levels) return null;
  return `peaks ${word} ${levels.map((v) => v.toFixed(2)).join(' → ')}`;
}

/** Just the direction, for the folded header — where "3 gestures · peaks
 *  rising" fits and the four numbers behind it do not. */
export function peakSequenceWord(
  levels: number[] | undefined | null,
): 'rising' | 'falling' | 'holding level' | null {
  if (!levels || levels.length < 2) return null;
  const { delta } = fitTravel(levels);
  if (Math.abs(delta) < PEAK_SEQUENCE_FLAT_THRESHOLD) return 'holding level';
  return delta > 0 ? 'rising' : 'falling';
}

/** Frequencies in the units a person reads them in — a centroid is quoted in
 *  Hz down low and kHz above a thousand, never as "3400Hz". */
export function fmtHz(hz: number): string {
  if (!Number.isFinite(hz)) return '—';
  return hz >= 1000 ? `${(hz / 1000).toFixed(1)}kHz` : `${Math.round(hz)}Hz`;
}

const ENERGY_WORD: Record<EnergyTrend, string> = {
  increasing: 'rising', decreasing: 'falling', flat: 'steady',
};
const BRIGHTNESS_WORD: Record<EnergyTrend, string> = {
  increasing: 'brightening', decreasing: 'darkening', flat: '',
};

/**
 * The span's label: both trends and the source it was measured on.
 *
 * Shared rather than spelled out at the save site because it is the line a
 * person scans in the item list to find the build they annotated, and a label
 * saying only what the level did sent them looking for a rise that the export
 * had recorded but never said out loud. Flat brightness is left off — a label
 * should carry what is notable, and "not much timbral movement" is not.
 */
export function energySpanLabel(data: EnergySpanExport): string {
  const brightWord = data.brightness_trend ? BRIGHTNESS_WORD[data.brightness_trend] : '';
  const trends = brightWord
    ? `${ENERGY_WORD[data.trend]}, ${brightWord}`
    : ENERGY_WORD[data.trend];
  return `Energy: ${trends} (${data.stem})`;
}

// ─── Reading an export back off a Span ──────────────────────────────────────
// The ⚡ Energy popover saves its blob into the Span's `description`, so the
// lane can recover the whole measurement — curve, envelope, rejection — from
// the annotation itself with nothing extra stored alongside it.

/** Parse a Span description back into the export that wrote it. Returns null
 *  for anything that isn't one — a hand-typed description, a truncated blob,
 *  an export from a future shape — so callers fall back to the plain span
 *  rendering rather than drawing half a curve. */
export function parseEnergySpanExport(
  description: string | null | undefined,
): EnergySpanExport | null {
  if (!description) return null;
  const text = description.trim();
  // Cheap rejects first: this runs per band, per render, on lanes that mostly
  // hold prose descriptions.
  if (!text.startsWith('{') || !text.includes('energy_span')) return null;
  try {
    const parsed = JSON.parse(text) as EnergySpanExport;
    if (!parsed || parsed.type !== 'energy_span') return null;
    if (!Array.isArray(parsed.curve) || parsed.curve.length === 0) return null;
    if (!(parsed.duration_ms > 0)) return null;
    // Blobs saved before brightness was measured carry neither field. Normalize
    // the absence to null here, once, so every reader can ask `?? null`-free
    // questions of the parsed shape instead of each guarding for undefined.
    return {
      ...parsed,
      brightness_trend: parsed.brightness_trend ?? null,
      brightness_hz: parsed.brightness_hz ?? null,
    };
  } catch {
    return null;
  }
}

/** Is this span a ⚡ Energy measurement rather than an authored one?
 *  The cheap question, for surfaces that only need to know which kind of span
 *  they are looking at — an energy span carries an envelope it measured and is
 *  offered no Prominence and no Pulse, both of which are claims a person makes
 *  by ear. */
export function isEnergySpan(description: string | null | undefined): boolean {
  return parseEnergySpanExport(description) !== null;
}

// ─── The A/D/S/R polyline ───────────────────────────────────────────────────

export type AdsrStageName = 'attack' | 'decay' | 'sustain' | 'release';

/** One leg of the drawn envelope. Times are ms from the span's start; levels
 *  are 0–1 of the span's own peak, matching `sustainLevel`. */
export interface AdsrStage {
  stage: AdsrStageName;
  fromMs: number;
  toMs: number;
  fromLevel: number;
  toLevel: number;
}

/**
 * The classic A/D/S/R shape the measured numbers describe, laid back onto the
 * span's own timeline so it can be drawn against the curve it came from.
 *
 * The attack is anchored BACKWARDS from the peak, because `attack_ms` is the
 * 10%→90% rise into it (see `AdsrEnvelope`) rather than "span start → argmax".
 * A span that opens mid-note therefore has its attack starting before its own
 * beginning, and that leg is clipped at 0 — with its level interpolated, so
 * the visible shape still starts where the sound actually was — instead of
 * being slid rightwards into a rise the audio never made.
 *
 * Stages that fall entirely outside the span are dropped; a zero-length one
 * (a decay of 0ms on a hit that never decays) is dropped too, and the vertical
 * step it stood for survives as the gap between its neighbours' levels.
 *
 * `visible` narrows that clip further, to the slice of the measurement a
 * dragged band still covers (see `envelopeViewport`). Same rule as the span
 * edges: a leg is cut where the band cuts it, with its level interpolated, so
 * what is drawn is the part of the gesture that is still in front of you.
 */
export function adsrStages(
  env: EnvelopeExport,
  durationMs: number,
  visible?: { fromMs: number; toMs: number },
): AdsrStage[] {
  if (!(durationMs > 0)) return [];
  const lo = Math.max(0, visible?.fromMs ?? 0);
  const hi = Math.min(durationMs, visible?.toMs ?? durationMs);
  const peak = Math.max(0, Math.min(durationMs, env.peak_at_ms));
  const sustain = Math.max(0, Math.min(1, env.sustain_level));
  const len = (ms: number) => Math.max(0, ms);
  const decayEnd = peak + len(env.decay_ms);
  const sustainEnd = decayEnd + len(env.sustain_ms);
  const releaseEnd = sustainEnd + len(env.release_ms);
  const raw: AdsrStage[] = [
    { stage: 'attack', fromMs: peak - len(env.attack_ms), toMs: peak, fromLevel: 0, toLevel: 1 },
    { stage: 'decay', fromMs: peak, toMs: decayEnd, fromLevel: 1, toLevel: sustain },
    { stage: 'sustain', fromMs: decayEnd, toMs: sustainEnd, fromLevel: sustain, toLevel: sustain },
    { stage: 'release', fromMs: sustainEnd, toMs: releaseEnd, fromLevel: sustain, toLevel: 0 },
  ];

  const out: AdsrStage[] = [];
  for (const s of raw) {
    const from = Math.max(lo, s.fromMs);
    const to = Math.min(hi, s.toMs);
    if (to <= from) continue;
    const span = s.toMs - s.fromMs;
    const at = (ms: number) => (span > 0
      ? s.fromLevel + ((ms - s.fromMs) / span) * (s.toLevel - s.fromLevel)
      : s.toLevel);
    out.push({ stage: s.stage, fromMs: from, toMs: to, fromLevel: at(from), toLevel: at(to) });
  }
  return out;
}

// ─── Drawing a measurement in a band that has since been dragged ────────────

/** Where the measurement sits inside the box it is drawn in, and how much of
 *  it survives.
 *
 *  An energy span is measured off the audio, so every number in the blob is
 *  pinned to the song and not to the annotation: `t_ms` counts from `start_ms`,
 *  and `start_ms` is where that sound is. Which is why dragging the band's edge
 *  cannot re-fit the picture into the new width — stretch a 7.7s measurement
 *  across a 4s band and its peak lands on audio it was never measured from,
 *  while the card goes on naming the old time for it. So a drag CUTS: what
 *  still falls inside the band is drawn exactly where it always was, and the
 *  rest is simply not shown. Drag the edge back out and it returns — nothing
 *  here mutates the blob, the band is only a window onto it.
 *
 *  Null when the band and the measurement no longer overlap at all (a body
 *  drag to somewhere else in the song); the callers say so rather than drawing
 *  an empty box.
 *
 *  A blob with no `start_ms` — a hand-written description, an export from
 *  before that field — is anchored to the band's own start instead. It still
 *  cuts rather than scales; it just can't know it has been moved. */
export interface EnvelopeViewport {
  /** The offsets into the measurement that survive, ms from its `start_ms`. */
  fromMs: number;
  toMs: number;
  /** An offset into the measurement → its x in the drawn box, 0–100. Values
   *  outside [`fromMs`, `toMs`] map outside the box; don't draw them. */
  xPct: (ms: number) => number;
  /** True while the band still frames exactly what was measured — nothing cut
   *  off either end, no unmeasured air. */
  exact: boolean;
}

/** Tolerance for "the band still matches the measurement", in ms, applied to
 *  ROUNDED differences.
 *
 *  The blob rounds its three times independently (`Math.round(startSec * 1000)`
 *  and friends), so `end_ms - start_ms` and `duration_ms` can legitimately
 *  disagree by a millisecond on a span nobody has touched — and the seconds→ms
 *  arithmetic here adds float dust on top, which is what the rounding is for:
 *  without it a 1.000000000015ms difference reads as a deliberate trim, and
 *  every freshly exported span claims to have been cut. A millisecond is far
 *  below anything a drag can express at any zoom. */
const VIEWPORT_EPSILON_MS = 1;

/** Rounded to whole ms first, so float dust can't outvote the epsilon. */
const withinEpsilon = (ms: number) => Math.abs(Math.round(ms)) <= VIEWPORT_EPSILON_MS;

export function envelopeViewport(
  data: Pick<EnergySpanExport, 'start_ms' | 'duration_ms'>,
  startSec: number,
  endSec: number,
): EnvelopeViewport | null {
  const windowMs = (endSec - startSec) * 1000;
  if (!(windowMs > 0) || !(data.duration_ms > 0)) return null;
  // How far the measurement's own start sits from the band's start. Positive:
  // the band opens before the sound was measured. Negative: the band's head
  // was dragged past it, and that much of the measurement is cut away.
  const offsetMs = Number.isFinite(data.start_ms) ? data.start_ms - startSec * 1000 : 0;
  // Snapped to the measurement's own ends within the same epsilon, so the
  // sub-picosecond noise of seconds→ms arithmetic can't shave the final curve
  // sample off a band nobody has touched.
  const rawFrom = Math.max(0, -offsetMs);
  const rawTo = Math.min(data.duration_ms, windowMs - offsetMs);
  const fromMs = withinEpsilon(rawFrom) ? 0 : rawFrom;
  const toMs = withinEpsilon(data.duration_ms - rawTo) ? data.duration_ms : rawTo;
  if (!(toMs > fromMs)) return null;
  return {
    fromMs,
    toMs,
    xPct: (ms: number) => ((offsetMs + ms) / windowMs) * 100,
    exact: withinEpsilon(offsetMs) && withinEpsilon(windowMs - data.duration_ms),
  };
}

/** The measured contour cut to [`fromMs`, `toMs`], with a point interpolated
 *  at each cut so the survivor ends in a clean vertical edge rather than
 *  wherever the last whole sample happened to fall. Points are returned at
 *  their own times — this drops samples, it never moves one. */
export function clipCurve(
  curve: readonly EnergyCurvePoint[],
  fromMs: number,
  toMs: number,
): EnergyCurvePoint[] {
  const at = (a: EnergyCurvePoint, b: EnergyCurvePoint, t: number): EnergyCurvePoint => {
    const frac = (t - a.t_ms) / (b.t_ms - a.t_ms);
    const point: EnergyCurvePoint = {
      t_ms: t,
      energy: a.energy + frac * (b.energy - a.energy),
    };
    // Brightness rides along, so a band trimmed mid-segment cuts both curves at
    // the same place instead of ending one of them a point early.
    if (a.brightness != null && b.brightness != null) {
      point.brightness = a.brightness + frac * (b.brightness - a.brightness);
    }
    return point;
  };
  const out: EnergyCurvePoint[] = [];
  for (let i = 0; i < curve.length; i++) {
    const p = curve[i];
    const prev = i > 0 ? curve[i - 1] : null;
    if (prev && prev.t_ms < fromMs && p.t_ms > fromMs) out.push(at(prev, p, fromMs));
    if (p.t_ms >= fromMs && p.t_ms <= toMs) out.push(p);
    if (prev && prev.t_ms < toMs && p.t_ms > toMs) out.push(at(prev, p, toMs));
  }
  return out;
}

/** One line for a band tooltip / card when the band no longer frames what was
 *  measured. Null while it does, so callers can append it unconditionally. */
export function envelopeCoverageNote(
  data: Pick<EnergySpanExport, 'start_ms' | 'duration_ms'>,
  startSec: number,
  endSec: number,
): string | null {
  const vp = envelopeViewport(data, startSec, endSec);
  const measured = Number.isFinite(data.start_ms)
    ? `${(data.start_ms / 1000).toFixed(1)}s–${((data.start_ms + data.duration_ms) / 1000).toFixed(1)}s`
    : `${(data.duration_ms / 1000).toFixed(1)}s`;
  if (!vp) return `measurement is at ${measured}, outside this band`;
  if (vp.exact) return null;
  const shown = (vp.toMs - vp.fromMs) / 1000;
  return `showing ${shown.toFixed(1)}s of the ${(data.duration_ms / 1000).toFixed(1)}s measured at ${measured}`;
}
