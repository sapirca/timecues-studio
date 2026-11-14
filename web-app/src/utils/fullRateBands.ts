// The EQ lane's Low / Mid / High bands, measured on the audio at full quality.
//
// Why a second decode: the player (WaveSurfer) decodes each song at its
// default 8,000 Hz, which is plenty to draw a waveform and to play in sync,
// and every signal lane is analysed from that buffer. At 8 kHz nothing above
// 4 kHz survives — and the EQ lane's High band is defined as everything ABOVE
// 4 kHz. So High was an empty row on every song: hi-hats, cymbals and air
// were decoded away before anyone measured them (the drum-hit detector hears
// them because it reads the file itself, at 44.1 kHz).
//
// This fetches the same URL again (normally straight from the HTTP cache),
// decodes it at EQ_SAMPLE_RATE, reduces it to three small band arrays, and
// lets the full-quality buffer go. Only the EQ lane reads these arrays; the
// other lanes keep their 8 kHz analysis until they are moved over too.
//
// Memory: the decoded buffer is sample rate × seconds × channels × 4 bytes,
// held only while the bands are computed. A 4-minute stereo song is about
// 85 MB for a second or two, then roughly 0.3 MB of band values remain.

import { createHannWindow, fft, magnitudeSpectrum } from '../services/mirAnalysis';

export const EQ_SAMPLE_RATE = 44100;
const FFT_SIZE = 2048;
const HOP_SIZE = 512;
// Same band edges as the 8 kHz analysis, so the lane means what it always
// said it meant: Low < 250 Hz, Mid 250 Hz - 4 kHz, High > 4 kHz.
const LOW_MAX_HZ = 250;
const MID_MAX_HZ = 4000;
// Frames per slice between yields, so a long song never freezes the page.
// This runs on the main thread while the song is opening, maybe playing. At
// 2,000 frames a slice was ~75 ms of blocking on a 4-minute song (4-5 dropped
// frames, eleven times) — twice the longest block of the 8 kHz analysis it runs
// beside (34 ms). 250 frames is ~9 ms a slice.
const FRAMES_PER_SLICE = 250;

export interface Bands {
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
}

const yieldToPage = () => new Promise<void>((r) => setTimeout(r, 0));

/** Mean magnitude per band per frame, each band scaled to its own peak.
 *  Pure apart from yielding, so it is testable without Web Audio. */
export async function bandsFromChannels(channels: readonly Float32Array[], sampleRate: number): Promise<Bands> {
  const length = channels[0]?.length ?? 0;
  const frameCount = length >= FFT_SIZE ? Math.floor((length - FFT_SIZE) / HOP_SIZE) + 1 : 0;
  const low = new Float32Array(frameCount);
  const mid = new Float32Array(frameCount);
  const high = new Float32Array(frameCount);

  const half = FFT_SIZE / 2;
  const binHz = sampleRate / FFT_SIZE;
  const lowMaxBin = Math.max(1, Math.floor(LOW_MAX_HZ / binHz));
  const midMaxBin = Math.max(lowMaxBin + 1, Math.min(half - 1, Math.floor(MID_MAX_HZ / binHz)));
  const highBins = Math.max(1, half - 1 - midMaxBin);

  const window = createHannWindow(FFT_SIZE);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const mag = new Float32Array(half);
  const nCh = channels.length;

  for (let f = 0; f < frameCount; f++) {
    const offset = f * HOP_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) {
      let s = 0;
      for (let c = 0; c < nCh; c++) s += channels[c][offset + i];
      re[i] = (s / nCh) * window[i];
      im[i] = 0;
    }
    fft(re, im);
    magnitudeSpectrum(re, im, mag);
    let lo = 0, mi = 0, hi = 0;
    for (let i = 1; i <= lowMaxBin; i++) lo += mag[i];
    for (let i = lowMaxBin + 1; i <= midMaxBin; i++) mi += mag[i];
    for (let i = midMaxBin + 1; i < half; i++) hi += mag[i];
    low[f] = lo / lowMaxBin;
    mid[f] = mi / (midMaxBin - lowMaxBin);
    high[f] = hi / highBins;
    if (f % FRAMES_PER_SLICE === FRAMES_PER_SLICE - 1) await yieldToPage();
  }

  for (const band of [low, mid, high]) {
    let max = 0;
    for (let i = 0; i < band.length; i++) if (band[i] > max) max = band[i];
    if (max > 0) for (let i = 0; i < band.length; i++) band[i] /= max;
  }
  return { low, mid, high };
}

/** Fetch `url`, decode it at EQ_SAMPLE_RATE, and return its three bands. */
export async function computeFullRateBands(url: string, signal?: AbortSignal): Promise<Bands> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`EQ audio fetch failed: ${res.status}`);
  const bytes = await res.arrayBuffer();
  // decodeAudioData resamples to the context's rate, so this one-frame
  // offline context only sets the rate we measure at; it never renders.
  const decoded = await new OfflineAudioContext(1, 1, EQ_SAMPLE_RATE).decodeAudioData(bytes);
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c));
  return bandsFromChannels(channels, decoded.sampleRate);
}
