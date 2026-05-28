/**
 * Band Gradient Segmentation (binary threshold approach)
 *
 * 1. Filter audio → low / mid / high bands + unfiltered amplitude
 * 2. Per-frame RMS energy for each channel
 * 3. Sliding-window smooth
 * 4. Normalize each channel to 0–1 (÷ max)
 * 5. Binarize per channel: value ≥ thr → 1, else 0
 * 6. Centered first difference: d[i] = b[i+1] − b[i−1] ∈ {−1, 0, +1}
 * 7. Merge non-zero derivative frames across all channels; min-distance gate
 * 8. Label segments from smoothed-energy vs track-median heuristics
 */

const RENDER_SAMPLE_RATE = 11025;
const FRAME_DURATION     = 0.1;   // seconds per energy frame

export const BAND_GRADIENT_DEFAULTS = {
  minDistSec:      4.0,   // min gap between detected boundaries
  thrLow:          0.30,  // 1st threshold — low band (0–1 normalized energy)
  thrMid:          0.30,  // 1st threshold — mid band
  thrHigh:         0.30,  // 1st threshold — high band
  thrAmp:          0.30,  // 1st threshold — amplitude
  smoothWindowSec: 1.0,   // smoothing window applied to 1st binary signals
  thr2Low:         0.50,  // 2nd threshold on smoothed binary (0–1 duty-cycle)
  thr2Mid:         0.50,
  thr2High:        0.50,
  thr2Amp:         0.50,
} as const;

export interface BandGradientParams {
  minDistSec?: number;
  thrLow?: number;
  thrMid?: number;
  thrHigh?: number;
  thrAmp?: number;
  smoothWindowSec?: number;
  thr2Low?: number;
  thr2Mid?: number;
  thr2High?: number;
  thr2Amp?: number;
}

// ─── Audio helpers ────────────────────────────────────────────────────────────

async function renderBand(
  source: AudioBuffer,
  filterChain: Array<{ type: BiquadFilterType; frequency: number; Q?: number }>,
): Promise<Float32Array> {
  const numFrames = Math.ceil(source.duration * RENDER_SAMPLE_RATE);
  const offlineCtx = new OfflineAudioContext(1, numFrames, RENDER_SAMPLE_RATE);
  const srcNode = offlineCtx.createBufferSource();
  srcNode.buffer = source;

  let lastNode: AudioNode = srcNode;
  for (const { type, frequency, Q = 0.5 } of filterChain) {
    const f = offlineCtx.createBiquadFilter();
    f.type = type;
    f.frequency.value = frequency;
    f.Q.value = Q;
    lastNode.connect(f);
    lastNode = f;
  }

  lastNode.connect(offlineCtx.destination);
  srcNode.start(0);
  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}

/** Per-frame RMS energy */
function buildFrameEnergy(pcm: Float32Array, frameSamples: number): Float32Array {
  const numFrames = Math.floor(pcm.length / frameSamples);
  const energy = new Float32Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    const start = f * frameSamples;
    const end   = Math.min(start + frameSamples, pcm.length);
    let sumSq = 0;
    for (let i = start; i < end; i++) sumSq += pcm[i] * pcm[i];
    energy[f] = Math.sqrt(sumSq / (end - start));
  }
  return energy;
}

/** Centered sliding-average smoothing */
function smoothArray(arr: Float32Array, windowSize: number): Float32Array {
  const out = new Float32Array(arr.length);
  const half = Math.floor(windowSize / 2);
  for (let i = 0; i < arr.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(arr.length - 1, i + half);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += arr[j];
    out[i] = sum / (hi - lo + 1);
  }
  return out;
}

/** Normalize to 0–1 by dividing by the array maximum */
function normalizeArray(arr: Float32Array): Float32Array {
  let max = 1e-9;
  for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] / max;
  return out;
}

/** Binarize: 1 if value ≥ threshold, else 0 */
function binarize(arr: Float32Array, threshold: number): Float32Array {
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] >= threshold ? 1 : 0;
  return out;
}

/**
 * Centered first difference of a 0/1 signal.
 * d[i] = b[i+1] − b[i−1]  →  values ∈ {−1, 0, +1}
 * +1 = onset (channel activated), −1 = offset (channel deactivated)
 */
function binaryDerivative(bin: Float32Array): Float32Array {
  const d = new Float32Array(bin.length);
  for (let i = 1; i < bin.length - 1; i++) d[i] = bin[i + 1] - bin[i - 1];
  d[0] = bin[1] - bin[0];
  d[bin.length - 1] = bin[bin.length - 1] - bin[bin.length - 2];
  return d;
}

// ─── Section labeling ─────────────────────────────────────────────────────────
// Heuristics based on normalized (0–1) per-segment energy vs track median.

function labelSection(
  lowE: number, midE: number, highE: number,
  medLow: number, medMid: number, medHigh: number,
): string {
  const highLow  = lowE  > medLow  * 1.3;
  const highMid  = midE  > medMid  * 1.1;
  const highHigh = highE > medHigh * 1.1;
  const lowLow   = lowE  < medLow  * 0.5;
  const lowMid   = midE  < medMid  * 0.7;
  if (highLow && highMid && highHigh) return 'drop';
  if (lowLow && lowMid)               return 'breakdown';
  if (!highLow && highHigh)           return 'buildup';
  if (highLow && !highMid)            return 'bridge';
  return 'bridge';
}

function buildSections(
  allTimes: number[],
  eLow: Float32Array, eMid: Float32Array, eHigh: Float32Array,
  medLow: number, medMid: number, medHigh: number,
): BandGradientSection[] {
  const sections: BandGradientSection[] = [];
  for (let i = 0; i < allTimes.length - 1; i++) {
    const t     = allTimes[i];
    const tEnd  = allTimes[i + 1];
    const fStart = Math.round(t    / FRAME_DURATION);
    const fEnd   = Math.round(tEnd / FRAME_DURATION);
    let sumLow = 0, sumMid = 0, sumHigh = 0, count = 0;
    for (let f = fStart; f < Math.min(fEnd, eLow.length); f++) {
      sumLow += eLow[f]; sumMid += eMid[f]; sumHigh += eHigh[f]; count++;
    }
    const avgLow  = count > 0 ? sumLow  / count : 0;
    const avgMid  = count > 0 ? sumMid  / count : 0;
    const avgHigh = count > 0 ? sumHigh / count : 0;
    const type  = labelSection(avgLow, avgMid, avgHigh, medLow, medMid, medHigh);
    const label = `${type.charAt(0).toUpperCase() + type.slice(1)} ${i + 1}`;
    sections.push({
      time: t, endTime: tEnd, type, label,
      energy:   avgLow + avgMid + avgHigh,
      centroid: avgHigh / Math.max(avgLow + avgMid + avgHigh, 1e-9),
    });
  }
  return sections;
}

// ─── Result / diagnostics types ───────────────────────────────────────────────

export interface BandGradientSection {
  time: number;
  endTime: number;
  type: string;
  label: string;
  energy: number;
  centroid: number;
}

export interface BandGradientResult {
  algorithm: 'band-gradient';
  algoName: string;
  duration: number;
  sections: BandGradientSection[];
  rawBoundaries: number[];
  computedAt: number;
}

/** All intermediate signals exposed for live visualization */
export interface BandGradientDiagnostics {
  frameDuration: number;
  numFrames: number;
  // normalized raw energy (0–1) per channel — no smoothing applied
  eLow:  Float32Array;
  eMid:  Float32Array;
  eHigh: Float32Array;
  eAmp:  Float32Array;
  // 1st binarization thresholds (same 0–1 scale)
  thrLow:  number;
  thrMid:  number;
  thrHigh: number;
  thrAmp:  number;
  // 1st binary signals (0 or 1 per frame)
  bLow:  Float32Array;
  bMid:  Float32Array;
  bHigh: Float32Array;
  bAmp:  Float32Array;
  // smoothed 1st binary — running average → 0–1 duty-cycle
  sbLow:  Float32Array;
  sbMid:  Float32Array;
  sbHigh: Float32Array;
  sbAmp:  Float32Array;
  // 2nd binarization thresholds (applied to sb*)
  thr2Low:  number;
  thr2Mid:  number;
  thr2High: number;
  thr2Amp:  number;
  // 2nd binary signals (0 or 1) — clean/debounced
  b2Low:  Float32Array;
  b2Mid:  Float32Array;
  b2High: Float32Array;
  b2Amp:  Float32Array;
  // centered derivative of 2nd binary (−1 / 0 / +1)
  dLow:  Float32Array;
  dMid:  Float32Array;
  dHigh: Float32Array;
  dAmp:  Float32Array;
  // combined absolute derivative activity (0–4)
  novelty: Float32Array;
  rawBoundaries: number[];
  sections: BandGradientSection[];
  duration: number;
}

/** Cached output of the expensive audio rendering step */
export interface RenderedBands {
  lowPcm: Float32Array;
  midPcm: Float32Array;
  highPcm: Float32Array;
  ampPcm: Float32Array;   // unfiltered full-range (for amplitude channel)
  duration: number;
}

// ─── Two-phase API ────────────────────────────────────────────────────────────

/** Phase 1 (slow): filter the audio into 3 frequency bands + unfiltered amplitude */
export async function renderBands(audioBuffer: AudioBuffer): Promise<RenderedBands> {
  const [lowPcm, midPcm, highPcm, ampPcm] = await Promise.all([
    renderBand(audioBuffer, [{ type: 'lowpass',  frequency: 150 }]),
    renderBand(audioBuffer, [{ type: 'highpass', frequency: 150 }, { type: 'lowpass', frequency: 2500 }]),
    renderBand(audioBuffer, [{ type: 'highpass', frequency: 2500 }]),
    renderBand(audioBuffer, []),  // no filters → full amplitude
  ]);
  return { lowPcm, midPcm, highPcm, ampPcm, duration: audioBuffer.duration };
}

/** Phase 2 (fast, synchronous): compute everything from cached band PCM */
export function runBandGradientFromBands(
  bands: RenderedBands,
  params?: BandGradientParams,
): { result: BandGradientResult; diagnostics: BandGradientDiagnostics } {
  const { lowPcm, midPcm, highPcm, ampPcm, duration } = bands;
  const minDistSec      = params?.minDistSec      ?? BAND_GRADIENT_DEFAULTS.minDistSec;
  const thrLow          = params?.thrLow          ?? BAND_GRADIENT_DEFAULTS.thrLow;
  const thrMid          = params?.thrMid          ?? BAND_GRADIENT_DEFAULTS.thrMid;
  const thrHigh         = params?.thrHigh         ?? BAND_GRADIENT_DEFAULTS.thrHigh;
  const thrAmp          = params?.thrAmp          ?? BAND_GRADIENT_DEFAULTS.thrAmp;
  const smoothWindowSec = params?.smoothWindowSec ?? BAND_GRADIENT_DEFAULTS.smoothWindowSec;
  const thr2Low         = params?.thr2Low         ?? BAND_GRADIENT_DEFAULTS.thr2Low;
  const thr2Mid         = params?.thr2Mid         ?? BAND_GRADIENT_DEFAULTS.thr2Mid;
  const thr2High        = params?.thr2High        ?? BAND_GRADIENT_DEFAULTS.thr2High;
  const thr2Amp         = params?.thr2Amp         ?? BAND_GRADIENT_DEFAULTS.thr2Amp;

  const frameSamples = Math.round(FRAME_DURATION * RENDER_SAMPLE_RATE);
  const smoothWindow = Math.max(1, Math.round(smoothWindowSec / FRAME_DURATION));

  // Step 1: RMS energy → normalize to 0–1 (no smoothing)
  const eLow  = normalizeArray(buildFrameEnergy(lowPcm,  frameSamples));
  const eMid  = normalizeArray(buildFrameEnergy(midPcm,  frameSamples));
  const eHigh = normalizeArray(buildFrameEnergy(highPcm, frameSamples));
  const eAmp  = normalizeArray(buildFrameEnergy(ampPcm,  frameSamples));

  // Step 2: 1st binarization — energy ≥ thr → 1
  const bLow  = binarize(eLow,  thrLow);
  const bMid  = binarize(eMid,  thrMid);
  const bHigh = binarize(eHigh, thrHigh);
  const bAmp  = binarize(eAmp,  thrAmp);

  // Step 3: smooth 1st binary → 0–1 duty-cycle
  const sbLow  = smoothArray(bLow,  smoothWindow);
  const sbMid  = smoothArray(bMid,  smoothWindow);
  const sbHigh = smoothArray(bHigh, smoothWindow);
  const sbAmp  = smoothArray(bAmp,  smoothWindow);

  // Step 4c: 2nd binarization on the smoothed binary → clean signal
  const b2Low  = binarize(sbLow,  thr2Low);
  const b2Mid  = binarize(sbMid,  thr2Mid);
  const b2High = binarize(sbHigh, thr2High);
  const b2Amp  = binarize(sbAmp,  thr2Amp);

  // Step 5: Centered first difference of the 2nd binary → {−1, 0, +1}
  const dLow  = binaryDerivative(b2Low);
  const dMid  = binaryDerivative(b2Mid);
  const dHigh = binaryDerivative(b2High);
  const dAmp  = binaryDerivative(b2Amp);

  // Step 6: Combined novelty = sum of |derivatives| per frame (0–4)
  const n = dLow.length;
  const novelty = new Float32Array(n);
  for (let i = 0; i < n; i++)
    novelty[i] = Math.abs(dLow[i]) + Math.abs(dMid[i]) + Math.abs(dHigh[i]) + Math.abs(dAmp[i]);

  // Step 7: Boundaries — any transition frame, minimum-distance gated
  const minDistFrames = Math.round(minDistSec / FRAME_DURATION);
  const rawBoundaries: number[] = [];
  let lastFrame = -minDistFrames;
  for (let i = 0; i < n; i++) {
    if (novelty[i] > 0 && i - lastFrame >= minDistFrames) {
      rawBoundaries.push(i * FRAME_DURATION);
      lastFrame = i;
    }
  }

  // Step 8: Label each segment from per-segment energy vs track median
  const allTimes = [0, ...rawBoundaries, duration];
  const eLowSorted  = [...eLow].sort((a, b) => a - b);
  const eMidSorted  = [...eMid].sort((a, b) => a - b);
  const eHighSorted = [...eHigh].sort((a, b) => a - b);
  const medLow  = eLowSorted[Math.floor(eLowSorted.length   / 2)];
  const medMid  = eMidSorted[Math.floor(eMidSorted.length   / 2)];
  const medHigh = eHighSorted[Math.floor(eHighSorted.length / 2)];
  const sections = buildSections(allTimes, eLow, eMid, eHigh, medLow, medMid, medHigh);

  return {
    result: {
      algorithm: 'band-gradient',
      algoName: 'Band Gradient',
      duration,
      sections,
      rawBoundaries,
      computedAt: Date.now(),
    },
    diagnostics: {
      frameDuration: FRAME_DURATION,
      numFrames: n,
      eLow, eMid, eHigh, eAmp,
      thrLow, thrMid, thrHigh, thrAmp,
      bLow, bMid, bHigh, bAmp,
      sbLow, sbMid, sbHigh, sbAmp,
      thr2Low, thr2Mid, thr2High, thr2Amp,
      b2Low, b2Mid, b2High, b2Amp,
      dLow, dMid, dHigh, dAmp,
      novelty,
      rawBoundaries,
      sections,
      duration,
    },
  };
}

// ─── Main entry (backwards-compatible) ───────────────────────────────────────

export async function runBandGradient(audioBuffer: AudioBuffer, params?: BandGradientParams): Promise<BandGradientResult> {
  const bands = await renderBands(audioBuffer);
  return runBandGradientFromBands(bands, params).result;
}
