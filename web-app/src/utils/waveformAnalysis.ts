// Pre-computed peak/RMS/clip summary used by the overview waveform renderer.
// One pass over the AudioBuffer at decode time → cheap per-pixel aggregation
// at any zoom level.

// -48 dB gives a more dramatic visual curve than the textbook -60: at the
// looser floor a typical -20 dB RMS still fills ~67 % of the half-canvas and
// the waveform reads as a flat block. With -48 dB the same RMS lands at ~58 %
// of the body, peaks above -12 dB stand out clearly, and content quieter than
// ~ -45 dB visibly tapers — much closer to how a pro DAW (Ableton, Reaper)
// renders its dB scale.
export const DB_FLOOR = -48;
const MIN_AMP = Math.pow(10, DB_FLOOR / 20);
const CLIP_THRESHOLD = 0.99;
const DEFAULT_BUCKET_SIZE = 512;

export type ScaleMode = 'lin' | 'db';

export interface WaveformSummary {
  /** max(|x|) per bucket */
  peak: Float32Array;
  /** sqrt(mean(x²)) per bucket */
  rms: Float32Array;
  /** 1 if any sample in bucket reached CLIP_THRESHOLD */
  clipped: Uint8Array;
  bucketSize: number;
  sampleRate: number;
  totalSamples: number;
  /** Mono PCM (float32, [-1, 1]) — used for sub-sample zoom */
  mono: Float32Array;
}

export interface WindowStats {
  peak: number;
  rms: number;
  clipped: boolean;
}

function toMono(buf: AudioBuffer): Float32Array {
  const channels = buf.numberOfChannels;
  const length = buf.length;
  if (channels === 1) {
    return new Float32Array(buf.getChannelData(0));
  }
  const out = new Float32Array(length);
  for (let c = 0; c < channels; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < length; i++) out[i] += data[i];
  }
  const inv = 1 / channels;
  for (let i = 0; i < length; i++) out[i] *= inv;
  return out;
}

export function buildSummary(buf: AudioBuffer, bucketSize = DEFAULT_BUCKET_SIZE): WaveformSummary {
  const mono = toMono(buf);
  const total = mono.length;
  const numBuckets = Math.ceil(total / bucketSize);
  const peak = new Float32Array(numBuckets);
  const rms = new Float32Array(numBuckets);
  const clipped = new Uint8Array(numBuckets);

  for (let b = 0; b < numBuckets; b++) {
    const start = b * bucketSize;
    const end = Math.min(start + bucketSize, total);
    let p = 0;
    let sumSq = 0;
    let clip = 0;
    for (let i = start; i < end; i++) {
      const v = mono[i];
      const a = v < 0 ? -v : v;
      if (a > p) p = a;
      sumSq += v * v;
      if (a >= CLIP_THRESHOLD) clip = 1;
    }
    peak[b] = p;
    rms[b] = Math.sqrt(sumSq / Math.max(1, end - start));
    clipped[b] = clip;
  }

  return {
    peak,
    rms,
    clipped,
    bucketSize,
    sampleRate: buf.sampleRate,
    totalSamples: total,
    mono,
  };
}

export function linearToDb(x: number): number {
  return 20 * Math.log10(Math.max(Math.abs(x), MIN_AMP));
}

/** Map an amplitude in [0, 1] to a vertical extent in [0, halfHeight]. */
export function amplitudeToExtent(value: number, halfHeight: number, mode: ScaleMode): number {
  const mag = value < 0 ? -value : value;
  if (mode === 'lin') {
    if (mag <= 0) return 0;
    if (mag >= 1) return halfHeight;
    return mag * halfHeight;
  }
  const db = linearToDb(mag);
  if (db <= DB_FLOOR) return 0;
  if (db >= 0) return halfHeight;
  return ((db - DB_FLOOR) / -DB_FLOOR) * halfHeight;
}

/** Aggregate peak/RMS/clip over the half-open sample range [s0, s1). */
export function aggregateRange(s: WaveformSummary, s0: number, s1: number): WindowStats {
  const total = s.totalSamples;
  const a = Math.max(0, Math.floor(s0));
  const b = Math.min(total, Math.ceil(s1));
  if (b <= a) return { peak: 0, rms: 0, clipped: false };

  const bs = s.bucketSize;

  // Short ranges → walk raw samples (avoids edge-quantization error from buckets)
  if (b - a <= bs * 2) {
    let p = 0;
    let sumSq = 0;
    let clip = false;
    for (let i = a; i < b; i++) {
      const v = s.mono[i];
      const av = v < 0 ? -v : v;
      if (av > p) p = av;
      sumSq += v * v;
      if (av >= CLIP_THRESHOLD) clip = true;
    }
    return { peak: p, rms: Math.sqrt(sumSq / (b - a)), clipped: clip };
  }

  // Wider ranges → use the precomputed summary (fast, slight bucket-edge slop)
  const firstBucket = Math.floor(a / bs);
  const lastBucket = Math.min(s.peak.length, Math.ceil(b / bs));
  let p = 0;
  let sumSq = 0;
  let count = 0;
  let clip = false;
  for (let bi = firstBucket; bi < lastBucket; bi++) {
    if (s.peak[bi] > p) p = s.peak[bi];
    if (s.clipped[bi]) clip = true;
    const start = bi * bs;
    const end = Math.min(start + bs, total);
    const n = end - start;
    sumSq += s.rms[bi] * s.rms[bi] * n;
    count += n;
  }
  return {
    peak: p,
    rms: count > 0 ? Math.sqrt(sumSq / count) : 0,
    clipped: clip,
  };
}
