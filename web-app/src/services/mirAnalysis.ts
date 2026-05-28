/**
 * MIR (Music Information Retrieval) Analysis Module
 *
 * Client-side DSP computation for audio feature extraction.
 * Computes per-frame: RMS energy, spectral centroid, onset strength (spectral flux),
 * zero-crossing rate, A-weighted loudness, 3-band energy, peak amplitude,
 * acoustic novelty (cosine distance between feature vectors), and
 * harmonic/percussive energy separation (HPSS via moving-average Wiener masks).
 */

export interface MIRFeatures {
  energy: Float32Array;      // Composite: 40% RMS + 25% bandwidth + 35% onsets
  rms: Float32Array;         // Raw RMS energy (normalized 0-1)
  centroid: Float32Array;
  onsets: Float32Array;
  zcr: Float32Array;         // Zero-crossing rate (normalized 0-1)
  loudness: Float32Array;    // A-weighted perceptual loudness (normalized 0-1)
  lowBand: Float32Array;     // Bass energy < 250 Hz (normalized 0-1)
  midBand: Float32Array;     // Mid energy 250 Hz – 4 kHz (normalized 0-1)
  highBand: Float32Array;    // Treble energy > 4 kHz (normalized 0-1)
  peaks: Float32Array;       // Peak amplitude per frame (normalized 0-1)
  flux: Float32Array;        // Full spectral flux — L2 norm of per-bin magnitude differences (both onsets and offsets), normalized 0-1
  novelty: Float32Array;     // Acoustic novelty — cosine distance between adjacent feature vectors, Gaussian-smoothed (0-1)
  harmonic: Float32Array;    // HPSS harmonic energy — temporal-smoothed spectrogram component (0-1)
  percussive: Float32Array;  // HPSS percussive energy — spectral-smoothed spectrogram component (0-1)
  /** MFCC matrix, row-major frame × coef (length = frameCount × nMfcc). Raw cepstral values (no normalisation). */
  mfcc: Float32Array;
  nMfcc: number;
  /** Chromagram, row-major frame × pitch-class (length = frameCount × 12). Each column max-normalised to [0,1]; index 0 = C, 1 = C#, … 11 = B. */
  chroma: Float32Array;
  nChroma: number;
  /** Tempogram, row-major tempoFrame × tempoBin (length = tempogramFrameCount × nTempo). Each row = local windowed autocorrelation of the onset envelope at lags corresponding to `tempoBpm[k]`. Per-column max-normalised to [0,1]. */
  tempogram: Float32Array;
  nTempo: number;
  tempogramFrameCount: number;
  /** Log-spaced BPM value at each tempo row (length = nTempo). Index 0 = slowest, index nTempo-1 = fastest. */
  tempoBpm: Float32Array;
  /** Self-similarity matrix (chroma-based, cosine similarity). Square row-major: length = ssmFrameCount². Values in [0,1] (chroma is non-negative). */
  ssm: Float32Array;
  ssmFrameCount: number;
  frameCount: number;
  hopSize: number;
  sampleRate: number;
}

export interface MIRProgress {
  phase: 'fft' | 'energy' | 'centroid' | 'onsets' | 'done';
  progress: number; // 0-1
}

const FFT_SIZE = 2048;
const HOP_SIZE = 512;
const CHUNK_SIZE = 256; // frames per setTimeout chunk

// ── HPSS constants ───────────────────────────────────────────────────────────
// Compressed spectrogram bins for HPSS (from halfSpectrum=1025 → 64 bins).
// Each bin represents a uniformly spaced frequency range across the spectrum.
const NUM_HPSS_BINS = 64;

// Half-window size for temporal smoothing (harmonics: smooth over time).
// 17 frames × 512 hop / 44100 sr ≈ 197ms — removes short transients, keeps sustained tones.
const HPSS_HALF_KT = 8;

// Half-window size for spectral smoothing (percussive: smooth across bins).
// 17 bins out of 64 ≈ 26% of the spectrum — removes narrowband harmonics, keeps broadband hits.
const HPSS_HALF_KF = 8;

// Gaussian sigma for novelty smoothing (5 frames ≈ 58ms) — removes single-frame noise.
const NOVELTY_SIGMA = 5;

// ── MFCC constants ───────────────────────────────────────────────────────────
const N_MFCC = 13;
const N_MEL_BANDS = 40;
const MFCC_FMIN = 20;

// ── Chromagram constants ─────────────────────────────────────────────────────
// Pitch-class energy from the magnitude spectrum: each bin is snapped to its
// nearest semitone (mod 12). Bins below MIN_CHROMA_HZ are skipped — they sit
// below A1 where bin spacing exceeds a semitone and pitch attribution is noisy.
const N_CHROMA = 12;
const MIN_CHROMA_HZ = 55; // A1

// ── Tempogram constants ──────────────────────────────────────────────────────
// Local windowed autocorrelation of the onset envelope at lags corresponding to
// log-spaced BPM values. Time axis is downsampled by TEMPOGRAM_HOP_FACTOR — tempo
// doesn't change on the millisecond scale, so ~46ms per output frame is plenty.
const N_TEMPO_BINS = 40;
const TEMPO_MIN_BPM = 30;
const TEMPO_MAX_BPM = 300;
const TEMPO_WINDOW_FRAMES = 256;  // ~3 sec at 86 Hz input frame rate
const TEMPOGRAM_HOP_FACTOR = 4;   // output every 4 input frames

// ── SSM (Self-Similarity Matrix) constants ───────────────────────────────────
// Chroma-vector cosine similarity between every pair of downsampled frames.
// Time axis is downsampled by SSM_HOP_FACTOR to keep the matrix manageable —
// a 5-min track at 64× downsample is ~400×400 ≈ 640 KB.
const SSM_HOP_FACTOR = 64;  // ~750 ms per SSM frame at 86 Hz input rate

function hzToMel(f: number): number { return 2595 * Math.log10(1 + f / 700); }
function melToHz(m: number): number { return 700 * (Math.pow(10, m / 2595) - 1); }

/** Triangular mel filterbank, row-major (band × bin). Each row sums to ~1 (Slaney normalisation). */
function buildMelFilters(halfSpectrum: number, sampleRate: number, fftSize: number, nMels: number, fmin: number, fmax: number): Float32Array {
  const melLo = hzToMel(fmin);
  const melHi = hzToMel(fmax);
  const hzPts = new Float32Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) {
    hzPts[i] = melToHz(melLo + (i / (nMels + 1)) * (melHi - melLo));
  }
  const binFreqs = new Float32Array(halfSpectrum);
  for (let i = 0; i < halfSpectrum; i++) binFreqs[i] = (i * sampleRate) / fftSize;

  const filters = new Float32Array(nMels * halfSpectrum);
  for (let m = 0; m < nMels; m++) {
    const lo = hzPts[m], ctr = hzPts[m + 1], hi = hzPts[m + 2];
    const denomL = ctr - lo || 1;
    const denomH = hi - ctr || 1;
    // Slaney: scale so each filter has unit area (compensates wider filters at high mel).
    const norm = 2 / (hi - lo || 1);
    for (let b = 0; b < halfSpectrum; b++) {
      const f = binFreqs[b];
      let v = 0;
      if (f >= lo && f <= ctr) v = (f - lo) / denomL;
      else if (f > ctr && f <= hi) v = (hi - f) / denomH;
      filters[m * halfSpectrum + b] = v * norm;
    }
  }
  return filters;
}

/** DCT-II orthonormal matrix, row-major (coef × band). */
function buildDctMatrix(nCoef: number, nBands: number): Float32Array {
  const m = new Float32Array(nCoef * nBands);
  const s0 = Math.sqrt(1 / nBands);
  const sN = Math.sqrt(2 / nBands);
  for (let k = 0; k < nCoef; k++) {
    const scale = k === 0 ? s0 : sN;
    for (let n = 0; n < nBands; n++) {
      m[k * nBands + n] = scale * Math.cos((Math.PI * k * (n + 0.5)) / nBands);
    }
  }
  return m;
}

// Hann window
function createHannWindow(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return window;
}

// In-place radix-2 Cooley-Tukey FFT
// real and imag arrays are modified in place
function fft(real: Float32Array, imag: Float32Array): void {
  const n = real.length;
  // Bit-reversal permutation
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      let tmp = real[i]; real[i] = real[j]; real[j] = tmp;
      tmp = imag[i]; imag[i] = imag[j]; imag[j] = tmp;
    }
    let k = n >> 1;
    while (k <= j) { j -= k; k >>= 1; }
    j += k;
  }

  // FFT butterfly
  for (let size = 2; size <= n; size *= 2) {
    const halfSize = size / 2;
    const angle = -2 * Math.PI / size;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);

    for (let i = 0; i < n; i += size) {
      let curReal = 1, curImag = 0;
      for (let k = 0; k < halfSize; k++) {
        const evenIdx = i + k;
        const oddIdx = i + k + halfSize;
        const tReal = curReal * real[oddIdx] - curImag * imag[oddIdx];
        const tImag = curReal * imag[oddIdx] + curImag * real[oddIdx];
        real[oddIdx] = real[evenIdx] - tReal;
        imag[oddIdx] = imag[evenIdx] - tImag;
        real[evenIdx] += tReal;
        imag[evenIdx] += tImag;
        const newCurReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = newCurReal;
      }
    }
  }
}

// Compute magnitude spectrum from real/imag
function magnitudeSpectrum(real: Float32Array, imag: Float32Array, out: Float32Array): void {
  const n = out.length;
  for (let i = 0; i < n; i++) {
    out[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
  }
}

// A-weighting approximation (ITU-R 468 / ANSI S1.4)
// Returns linear gain (not dB). Normalized so A(1000 Hz) ≈ 1.0.
function buildAWeights(halfSpectrum: number, freqBinWidth: number): Float32Array {
  const weights = new Float32Array(halfSpectrum);
  const A1000 = _aWeight(1000);
  for (let i = 1; i < halfSpectrum; i++) {
    const f = i * freqBinWidth;
    weights[i] = _aWeight(f) / (A1000 || 1);
  }
  return weights;
}

function _aWeight(f: number): number {
  if (f <= 0) return 0;
  const f2 = f * f;
  const f4 = f2 * f2;
  const num = 12200 * 12200 * f4;
  const den =
    (f2 + 20.6 * 20.6) *
    Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9)) *
    (f2 + 12200 * 12200);
  return den > 0 ? num / den : 0;
}

/**
 * 1-D Gaussian smoothing (normalized convolution — handles boundaries correctly).
 * sigma: standard deviation in frames. Kernel radius = ceil(3 * sigma).
 */
function gaussianSmooth(arr: Float32Array, sigma: number): Float32Array {
  const out = new Float32Array(arr.length);
  const r = Math.ceil(3 * sigma);
  const kernel = new Float32Array(2 * r + 1);
  let kSum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + r] = v;
    kSum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= kSum;

  for (let i = 0; i < arr.length; i++) {
    let sum = 0, wSum = 0;
    for (let j = 0; j < kernel.length; j++) {
      const idx = i - r + j;
      if (idx >= 0 && idx < arr.length) {
        sum += arr[idx] * kernel[j];
        wSum += kernel[j];
      }
    }
    out[i] = wSum > 0 ? sum / wSum : 0;
  }
  return out;
}

/**
 * Compute MIR features from an AudioBuffer.
 * Uses chunked processing via setTimeout to avoid blocking the UI.
 *
 * Per-frame loop computes: RMS, peaks, ZCR, centroid, bandwidth, onset flux,
 * A-weighted loudness, 3-band energy, compressed-spectrogram row, novelty distance.
 *
 * Post-loop computes:
 *   - Novelty: Gaussian-smoothed cosine distance between adjacent feature vectors
 *   - HPSS: harmonic (temporal mean filter) + percussive (spectral mean filter)
 *           combined with Wiener soft masks → energy curves
 */
export function computeMIRFeatures(
  audioBuffer: AudioBuffer,
  onProgress?: (progress: MIRProgress) => void
): Promise<MIRFeatures> {
  return new Promise((resolve) => {
    const sampleRate = audioBuffer.sampleRate;
    // Mix down to mono
    const length = audioBuffer.length;
    const mono = new Float32Array(length);
    const numChannels = audioBuffer.numberOfChannels;
    for (let ch = 0; ch < numChannels; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        mono[i] += channelData[i];
      }
    }
    if (numChannels > 1) {
      const scale = 1 / numChannels;
      for (let i = 0; i < length; i++) {
        mono[i] *= scale;
      }
    }

    const frameCount = Math.floor((length - FFT_SIZE) / HOP_SIZE) + 1;
    const empty = new Float32Array(0);
    if (frameCount <= 0) {
      resolve({
        energy: empty, rms: empty, centroid: empty, onsets: empty,
        zcr: empty, loudness: empty, lowBand: empty, midBand: empty,
        highBand: empty, peaks: empty,
        flux: empty, novelty: empty, harmonic: empty, percussive: empty,
        mfcc: empty, nMfcc: N_MFCC,
        chroma: empty, nChroma: N_CHROMA,
        tempogram: empty, nTempo: N_TEMPO_BINS, tempogramFrameCount: 0, tempoBpm: empty,
        ssm: empty, ssmFrameCount: 0,
        frameCount: 0, hopSize: HOP_SIZE, sampleRate,
      });
      return;
    }

    const rmsRaw    = new Float32Array(frameCount);
    const bandwidth = new Float32Array(frameCount);
    const centroid  = new Float32Array(frameCount);
    const onsets    = new Float32Array(frameCount);
    // Full spectral flux (L2): sqrt(Σ(mag[t][k] - mag[t-1][k])²) — unlike onsets (half-wave
    // rectified, counts only increases), this counts both magnitude increases and decreases,
    // capturing note releases, filter closings, and other spectral "ending" events alongside attacks.
    const fluxRaw   = new Float32Array(frameCount);
    const zcr       = new Float32Array(frameCount);
    const loudness  = new Float32Array(frameCount);
    const lowBand   = new Float32Array(frameCount);
    const midBand   = new Float32Array(frameCount);
    const highBand  = new Float32Array(frameCount);
    const peaks     = new Float32Array(frameCount);

    // ── Novelty: raw cosine-distance between adjacent 7-dim feature vectors ──
    // Vectors use raw (pre-normalisation) values — cosine distance is scale-invariant
    // across the whole vector, and high-magnitude spectral features (bandwidth, centroid)
    // naturally dominate, which is exactly what we want for section-change detection.
    const noveltyRaw = new Float32Array(frameCount);
    // prevFeat[0..6] = [rms, bandwidth, centroid, onsets, lowBand, midBand, highBand]
    const prevFeat = new Float32Array(7);

    // ── HPSS: compressed spectrogram (row-major: frame × bin) ────────────────
    // NUM_HPSS_BINS evenly-spaced bins sampled from [1, halfSpectrum-1].
    // Memory: ~frameCount × 64 × 4 bytes ≈ 6.6 MB for a 5-min track.
    const halfSpectrum = FFT_SIZE / 2 + 1;
    const hpssStep = Math.max(1, Math.floor((halfSpectrum - 1) / NUM_HPSS_BINS));
    const spectrogramData = new Float32Array(frameCount * NUM_HPSS_BINS);

    const hannWindow  = createHannWindow(FFT_SIZE);
    const prevMag     = new Float32Array(halfSpectrum);

    // Reusable buffers for FFT
    const fftReal = new Float32Array(FFT_SIZE);
    const fftImag = new Float32Array(FFT_SIZE);
    const mag     = new Float32Array(halfSpectrum);

    // Precomputed constants
    const freqBinWidth = sampleRate / FFT_SIZE;
    const aWeights     = buildAWeights(halfSpectrum, freqBinWidth);
    const lowMaxBin    = Math.max(1, Math.floor(250 / freqBinWidth));
    const midMaxBin    = Math.max(lowMaxBin + 1, Math.floor(4000 / freqBinWidth));
    const lowNumBins   = lowMaxBin;
    const midNumBins   = midMaxBin - lowMaxBin;
    const highNumBins  = Math.max(1, halfSpectrum - midMaxBin);

    // ── MFCC precomputation ──────────────────────────────────────────────────
    // Mel filterbank applied to power spectrum → log → DCT-II → N_MFCC coefficients.
    // Stored row-major (frame × coef) so the cepstrogram viz can index by (frame * nMfcc + coef).
    const melFilters = buildMelFilters(halfSpectrum, sampleRate, FFT_SIZE, N_MEL_BANDS, MFCC_FMIN, sampleRate / 2);
    const dctMatrix  = buildDctMatrix(N_MFCC, N_MEL_BANDS);
    const mfcc       = new Float32Array(frameCount * N_MFCC);
    const melEnergy  = new Float32Array(N_MEL_BANDS); // scratch

    // ── Chromagram precomputation ─────────────────────────────────────────────
    // Snap each FFT bin to its nearest semitone, then mod 12 → pitch class.
    // -1 marks bins below MIN_CHROMA_HZ (skipped during aggregation).
    const binToPitchClass = new Int8Array(halfSpectrum);
    for (let b = 0; b < halfSpectrum; b++) {
      const f = b * freqBinWidth;
      if (f < MIN_CHROMA_HZ) { binToPitchClass[b] = -1; continue; }
      const midi = 69 + 12 * Math.log2(f / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      binToPitchClass[b] = pc;
    }
    const chroma = new Float32Array(frameCount * N_CHROMA);

    let frameIdx = 0;

    function processChunk() {
      const endFrame = Math.min(frameIdx + CHUNK_SIZE, frameCount);

      for (; frameIdx < endFrame; frameIdx++) {
        const offset = frameIdx * HOP_SIZE;

        // ── Time-domain features (no FFT needed) ──────────────────────────
        let sumSq = 0;
        let peak  = 0;
        let crossings = 0;
        let prevSign = mono[offset] >= 0;
        for (let i = 0; i < FFT_SIZE; i++) {
          const s = mono[offset + i];
          const absS = Math.abs(s);
          sumSq += s * s;
          if (absS > peak) peak = absS;
          const sign = s >= 0;
          if (i > 0 && sign !== prevSign) crossings++;
          prevSign = sign;
        }
        rmsRaw[frameIdx] = Math.sqrt(sumSq / FFT_SIZE);
        peaks[frameIdx]  = peak;
        zcr[frameIdx]    = crossings / FFT_SIZE;

        // ── FFT ──────────────────────────────────────────────────────────
        for (let i = 0; i < FFT_SIZE; i++) {
          fftReal[i] = mono[offset + i] * hannWindow[i];
          fftImag[i] = 0;
        }
        fft(fftReal, fftImag);
        magnitudeSpectrum(fftReal, fftImag, mag);

        // ── Spectral Centroid + Bandwidth ─────────────────────────────────
        let weightedSum = 0, magSum = 0;
        for (let i = 0; i < halfSpectrum; i++) {
          const freq = i * freqBinWidth;
          weightedSum += freq * mag[i];
          magSum += mag[i];
        }
        const cent = magSum > 0 ? weightedSum / magSum : 0;
        centroid[frameIdx] = cent;
        let bwSum = 0;
        for (let i = 0; i < halfSpectrum; i++) {
          const diff = i * freqBinWidth - cent;
          bwSum += diff * diff * mag[i];
        }
        bandwidth[frameIdx] = magSum > 0 ? Math.sqrt(bwSum / magSum) : 0;

        // ── Onset Strength (half-wave rectified flux) + Full Spectral Flux ──
        // onsets: Σ max(0, Δmag) — only increases → sharp attack peaks
        // fluxRaw: sqrt(Σ Δmag²) — full L2 distance → all spectral change
        let onset = 0, fluxSq = 0;
        for (let i = 0; i < halfSpectrum; i++) {
          const diff = mag[i] - prevMag[i];
          if (diff > 0) onset += diff;
          fluxSq += diff * diff;
        }
        onsets[frameIdx]  = onset;
        fluxRaw[frameIdx] = Math.sqrt(fluxSq);
        prevMag.set(mag);

        // ── A-weighted loudness ───────────────────────────────────────────
        let aSum = 0;
        for (let i = 1; i < halfSpectrum; i++) {
          const w = aWeights[i] * mag[i];
          aSum += w * w;
        }
        loudness[frameIdx] = Math.sqrt(aSum / halfSpectrum);

        // ── 3-Band energy (mean power per bin so bands are comparable) ────
        let lo = 0, mi = 0, hi = 0;
        for (let i = 1; i <= lowMaxBin && i < halfSpectrum; i++)  lo += mag[i];
        for (let i = lowMaxBin + 1; i <= midMaxBin && i < halfSpectrum; i++) mi += mag[i];
        for (let i = midMaxBin + 1; i < halfSpectrum; i++)         hi += mag[i];
        lowBand[frameIdx]  = lo / lowNumBins;
        midBand[frameIdx]  = mi / midNumBins;
        highBand[frameIdx] = hi / highNumBins;

        // ── Compressed spectrogram for HPSS ──────────────────────────────
        // Sample NUM_HPSS_BINS evenly from the magnitude spectrum.
        const spectroOffset = frameIdx * NUM_HPSS_BINS;
        for (let b = 0; b < NUM_HPSS_BINS; b++) {
          spectrogramData[spectroOffset + b] = mag[Math.min(b * hpssStep + 1, halfSpectrum - 1)];
        }

        // ── MFCC: mel filterbank on power spectrum → log → DCT-II ────────
        for (let m = 0; m < N_MEL_BANDS; m++) {
          let sum = 0;
          const base = m * halfSpectrum;
          for (let b = 0; b < halfSpectrum; b++) {
            const mg = mag[b];
            sum += melFilters[base + b] * mg * mg;
          }
          melEnergy[m] = Math.log(sum + 1e-10);
        }
        const mfccOff = frameIdx * N_MFCC;
        for (let k = 0; k < N_MFCC; k++) {
          let s = 0;
          const base = k * N_MEL_BANDS;
          for (let m = 0; m < N_MEL_BANDS; m++) s += dctMatrix[base + m] * melEnergy[m];
          mfcc[mfccOff + k] = s;
        }

        // ── Chroma: accumulate magnitude² into pitch-class bins ───────────
        // Power (mag²) is the conventional input — emphasises strong tonal energy
        // and suppresses broadband noise that has been spread across many bins.
        const chromaOff = frameIdx * N_CHROMA;
        for (let b = 1; b < halfSpectrum; b++) {
          const pc = binToPitchClass[b];
          if (pc < 0) continue;
          const m = mag[b];
          chroma[chromaOff + pc] += m * m;
        }

        // ── Novelty: cosine distance from previous frame ──────────────────
        // Uses raw feature values — cosine similarity is scale-invariant, so no
        // pre-normalisation is needed. High-magnitude spectral features (bandwidth ~1000–8000 Hz,
        // centroid ~500–8000 Hz) naturally dominate, which emphasises timbral changes.
        const rC = rmsRaw[frameIdx], bwC = bandwidth[frameIdx], cC = centroid[frameIdx];
        const oC = onsets[frameIdx], loC = lowBand[frameIdx], miC = midBand[frameIdx], hiC = highBand[frameIdx];
        if (frameIdx > 0) {
          const dot = rC*prevFeat[0] + bwC*prevFeat[1] + cC*prevFeat[2] + oC*prevFeat[3]
                    + loC*prevFeat[4] + miC*prevFeat[5] + hiC*prevFeat[6];
          const normA = rC*rC + bwC*bwC + cC*cC + oC*oC + loC*loC + miC*miC + hiC*hiC;
          const normB = prevFeat[0]*prevFeat[0] + prevFeat[1]*prevFeat[1] + prevFeat[2]*prevFeat[2]
                      + prevFeat[3]*prevFeat[3] + prevFeat[4]*prevFeat[4] + prevFeat[5]*prevFeat[5]
                      + prevFeat[6]*prevFeat[6];
          const denom = Math.sqrt(normA * normB);
          noveltyRaw[frameIdx] = denom > 1e-10 ? 1 - dot / denom : 0;
        }
        prevFeat[0] = rC; prevFeat[1] = bwC; prevFeat[2] = cC; prevFeat[3] = oC;
        prevFeat[4] = loC; prevFeat[5] = miC; prevFeat[6] = hiC;
      }

      if (frameIdx < frameCount) {
        onProgress?.({ phase: 'fft', progress: frameIdx / frameCount });
        setTimeout(processChunk, 0);
      } else {
        // Normalize raw features to [0, 1]
        normalizeInPlace(rmsRaw);
        normalizeInPlace(bandwidth);
        normalizeInPlace(centroid);
        normalizeInPlace(onsets);
        normalizeInPlace(fluxRaw);
        normalizeInPlace(zcr);
        normalizeInPlace(loudness);
        normalizeInPlace(peaks);

        // Normalize bands independently so each has full 0-1 range.
        normalizeInPlace(lowBand);
        normalizeInPlace(midBand);
        normalizeInPlace(highBand);

        // Composite energy: 40% RMS + 25% bandwidth + 35% onsets
        const energy = new Float32Array(frameCount);
        for (let i = 0; i < frameCount; i++) {
          energy[i] = 0.40 * rmsRaw[i] + 0.25 * bandwidth[i] + 0.35 * onsets[i];
        }
        normalizeInPlace(energy);

        // ── Novelty: Gaussian smoothing ───────────────────────────────────
        // Sigma=5 frames ≈ 58ms — removes single-frame noise while keeping sharp transition peaks.
        const novelty = gaussianSmooth(noveltyRaw, NOVELTY_SIGMA);
        normalizeInPlace(novelty);

        // ── HPSS: moving-average Wiener separation ────────────────────────
        //
        // Algorithm (Fitzgerald 2010 — mean-filter approximation):
        //   H[t][b] = mean(spectrogram[t-HALF_KT .. t+HALF_KT][b])  ← temporal smoothing
        //   P[t][b] = mean(spectrogram[t][b-HALF_KF .. b+HALF_KF])  ← spectral smoothing
        //   H_mask[t][b] = H² / (H² + P² + ε)  ← Wiener soft mask
        //   P_mask[t][b] = P² / (H² + P² + ε)
        //   harmonic[t]   = mean(H_mask[t] × spectrogram[t])
        //   percussive[t] = mean(P_mask[t] × spectrogram[t])
        //
        // Both filters use sliding-sum for O(N×M) total complexity instead of O(N×M×L).
        // Libraries (Python reference): librosa.decompose.hpss, scipy.signal.medfilt

        const H = new Float32Array(frameCount * NUM_HPSS_BINS);
        const P = new Float32Array(frameCount * NUM_HPSS_BINS);

        // Temporal filter (harmonics): sliding sum per bin across frames
        for (let b = 0; b < NUM_HPSS_BINS; b++) {
          let wSum = 0, wCount = 0;
          // Seed with initial window [0, HALF_KT]
          for (let t = 0; t <= Math.min(HPSS_HALF_KT, frameCount - 1); t++) {
            wSum += spectrogramData[t * NUM_HPSS_BINS + b];
            wCount++;
          }
          for (let t = 0; t < frameCount; t++) {
            H[t * NUM_HPSS_BINS + b] = wSum / wCount;
            // Remove outgoing element
            const tOut = t - HPSS_HALF_KT;
            if (tOut >= 0) { wSum -= spectrogramData[tOut * NUM_HPSS_BINS + b]; wCount--; }
            // Add incoming element
            const tIn = t + HPSS_HALF_KT + 1;
            if (tIn < frameCount) { wSum += spectrogramData[tIn * NUM_HPSS_BINS + b]; wCount++; }
          }
        }

        // Spectral filter (percussive): sliding sum per frame across bins
        for (let t = 0; t < frameCount; t++) {
          const offset = t * NUM_HPSS_BINS;
          let wSum = 0, wCount = 0;
          // Seed with initial window [0, HALF_KF]
          for (let b = 0; b <= Math.min(HPSS_HALF_KF, NUM_HPSS_BINS - 1); b++) {
            wSum += spectrogramData[offset + b];
            wCount++;
          }
          for (let b = 0; b < NUM_HPSS_BINS; b++) {
            P[offset + b] = wSum / wCount;
            const bOut = b - HPSS_HALF_KF;
            if (bOut >= 0) { wSum -= spectrogramData[offset + bOut]; wCount--; }
            const bIn = b + HPSS_HALF_KF + 1;
            if (bIn < NUM_HPSS_BINS) { wSum += spectrogramData[offset + bIn]; wCount++; }
          }
        }

        // Wiener masks → energy curves
        const harmonic   = new Float32Array(frameCount);
        const percussive = new Float32Array(frameCount);
        const eps = 1e-7;
        for (let t = 0; t < frameCount; t++) {
          const offset = t * NUM_HPSS_BINS;
          let hE = 0, pE = 0;
          for (let b = 0; b < NUM_HPSS_BINS; b++) {
            const hv = H[offset + b], pv = P[offset + b];
            const s  = spectrogramData[offset + b];
            const h2 = hv * hv, p2 = pv * pv;
            const denom = h2 + p2 + eps;
            hE += (h2 / denom) * s;
            pE += (p2 / denom) * s;
          }
          harmonic[t]   = hE / NUM_HPSS_BINS;
          percussive[t] = pE / NUM_HPSS_BINS;
        }
        normalizeInPlace(harmonic);
        normalizeInPlace(percussive);

        // ── Chroma: per-frame max normalisation ───────────────────────────
        // Each column scaled so its strongest pitch class = 1, making the
        // *relative* tonal balance visible regardless of overall loudness.
        for (let t = 0; t < frameCount; t++) {
          const off = t * N_CHROMA;
          let cmax = 0;
          for (let k = 0; k < N_CHROMA; k++) if (chroma[off + k] > cmax) cmax = chroma[off + k];
          if (cmax > 0) {
            const inv = 1 / cmax;
            for (let k = 0; k < N_CHROMA; k++) chroma[off + k] *= inv;
          }
        }

        // ── SSM: chroma-based self-similarity matrix ──────────────────────
        // Aggregate chroma into coarse SSM frames (mean over SSM_HOP_FACTOR input
        // frames), L2-normalise each aggregated vector, then compute cosine
        // similarity between every pair of SSM frames. Off-diagonal stripes mark
        // repeated harmonic content (e.g., repeated choruses); bright diagonal
        // blocks mark internally-similar sections.
        const ssmFrameCount = Math.max(0, Math.floor(frameCount / SSM_HOP_FACTOR));
        const ssmChroma = new Float32Array(ssmFrameCount * N_CHROMA);
        for (let sf = 0; sf < ssmFrameCount; sf++) {
          const start = sf * SSM_HOP_FACTOR;
          const end = Math.min(frameCount, start + SSM_HOP_FACTOR);
          const sfOff = sf * N_CHROMA;
          for (let t = start; t < end; t++) {
            const cOff = t * N_CHROMA;
            for (let k = 0; k < N_CHROMA; k++) ssmChroma[sfOff + k] += chroma[cOff + k];
          }
          // L2-normalise — cosine similarity needs unit vectors.
          let n2 = 0;
          for (let k = 0; k < N_CHROMA; k++) n2 += ssmChroma[sfOff + k] * ssmChroma[sfOff + k];
          if (n2 > 0) {
            const inv = 1 / Math.sqrt(n2);
            for (let k = 0; k < N_CHROMA; k++) ssmChroma[sfOff + k] *= inv;
          }
        }
        const ssm = new Float32Array(ssmFrameCount * ssmFrameCount);
        for (let i = 0; i < ssmFrameCount; i++) {
          const iOff = i * N_CHROMA;
          for (let j = i; j < ssmFrameCount; j++) {
            let dot = 0;
            const jOff = j * N_CHROMA;
            for (let k = 0; k < N_CHROMA; k++) dot += ssmChroma[iOff + k] * ssmChroma[jOff + k];
            // Cosine sim between non-negative vectors is in [0,1]; clamp guards
            // against floating-point drift just above 1.
            const sim = dot < 0 ? 0 : (dot > 1 ? 1 : dot);
            ssm[i * ssmFrameCount + j] = sim;
            ssm[j * ssmFrameCount + i] = sim;
          }
        }

        // ── Tempogram: local windowed autocorrelation of the onset envelope ──
        // Operates on the normalised `onsets` array. For each output frame
        // (every TEMPOGRAM_HOP_FACTOR input frames), we take a TEMPO_WINDOW_FRAMES
        // window centred on that input frame and correlate it against itself at
        // each of N_TEMPO_BINS lags. Each lag corresponds to a log-spaced BPM
        // value — strong autocorrelation at that lag means the onset envelope
        // repeats with that period, i.e. that tempo is present.
        const inputFrameRate = sampleRate / HOP_SIZE;
        const tempoBpm = new Float32Array(N_TEMPO_BINS);
        const tempoLagFrames = new Int32Array(N_TEMPO_BINS);
        for (let k = 0; k < N_TEMPO_BINS; k++) {
          const bpm = TEMPO_MIN_BPM * Math.pow(TEMPO_MAX_BPM / TEMPO_MIN_BPM, k / (N_TEMPO_BINS - 1));
          tempoBpm[k] = bpm;
          tempoLagFrames[k] = Math.max(1, Math.round(60 * inputFrameRate / bpm));
        }
        const tempogramFrameCount = Math.max(0, Math.floor(frameCount / TEMPOGRAM_HOP_FACTOR));
        const tempogram = new Float32Array(tempogramFrameCount * N_TEMPO_BINS);
        const halfWin = TEMPO_WINDOW_FRAMES >> 1;
        for (let tf = 0; tf < tempogramFrameCount; tf++) {
          const center = tf * TEMPOGRAM_HOP_FACTOR;
          const winStart = Math.max(0, center - halfWin);
          const winEnd   = Math.min(frameCount, center + halfWin);
          const rowOff = tf * N_TEMPO_BINS;
          let rowMax = 0;
          for (let k = 0; k < N_TEMPO_BINS; k++) {
            const lag = tempoLagFrames[k];
            const stop = winEnd - lag;
            if (stop <= winStart) { tempogram[rowOff + k] = 0; continue; }
            let ac = 0;
            for (let i = winStart; i < stop; i++) ac += onsets[i] * onsets[i + lag];
            tempogram[rowOff + k] = ac;
            if (ac > rowMax) rowMax = ac;
          }
          // Per-output-frame max normalisation: each column shows the *relative*
          // strength of each tempo candidate at that moment, not absolute energy.
          if (rowMax > 0) {
            const inv = 1 / rowMax;
            for (let k = 0; k < N_TEMPO_BINS; k++) tempogram[rowOff + k] *= inv;
          }
        }

        onProgress?.({ phase: 'done', progress: 1 });
        resolve({
          energy, rms: rmsRaw, centroid, onsets,
          zcr, loudness, lowBand, midBand, highBand, peaks,
          flux: fluxRaw, novelty, harmonic, percussive,
          mfcc, nMfcc: N_MFCC,
          chroma, nChroma: N_CHROMA,
          tempogram, nTempo: N_TEMPO_BINS, tempogramFrameCount, tempoBpm,
          ssm, ssmFrameCount,
          frameCount, hopSize: HOP_SIZE, sampleRate,
        });
      }
    }

    onProgress?.({ phase: 'fft', progress: 0 });
    setTimeout(processChunk, 0);
  });
}

function normalizeInPlace(arr: Float32Array): void {
  let max = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > max) max = arr[i];
  }
  if (max > 0) {
    const scale = 1 / max;
    for (let i = 0; i < arr.length; i++) {
      arr[i] *= scale;
    }
  }
}
