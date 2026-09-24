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
// 64 samples ≈ 1.45 ms at 44.1 kHz. `aggregateRange` snaps to whole buckets,
// so this is the finest detail the summary path can ever show — at 512 the
// envelope visibly staircased in ~11.6 ms plateaus once one pixel spanned
// less than a bucket (roughly 86 px/s, i.e. any real zoom). Cost is 9 bytes
// per bucket: ~3.6 MB for a 10-minute track, and the build pass is O(samples)
// either way. Below one bucket per column the renderer stops using the
// summary altogether — see aggregateExactRange.
const DEFAULT_BUCKET_SIZE = 64;

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
}

export interface WindowStats {
  peak: number;
  rms: number;
  clipped: boolean;
}

export function buildSummary(buf: AudioBuffer, bucketSize = DEFAULT_BUCKET_SIZE): WaveformSummary {
  const ch0 = buf.getChannelData(0);
  const nCh = buf.numberOfChannels;
  const total = buf.length;
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
      let v = ch0[i];
      if (nCh > 1) {
        for (let c = 1; c < nCh; c++) v += buf.getChannelData(c)[i];
        v /= nCh;
      }
      const a = v < 0 ? -v : v;
      if (a > p) p = a;
      sumSq += v * v;
      if (a >= CLIP_THRESHOLD) clip = 1;
    }
    peak[b] = p;
    rms[b] = Math.sqrt(sumSq / Math.max(1, end - start));
    clipped[b] = clip;
  }

  return { peak, rms, clipped, bucketSize, sampleRate: buf.sampleRate, totalSamples: total };
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

/** Exact peak/RMS/clip over [s0, s1) straight from the decoded channels,
 *  channel-averaged the same way `buildSummary` mixes down.
 *
 *  Used when a pixel column spans fewer samples than a summary bucket: there
 *  `aggregateRange` would round the column out to whole buckets, so several
 *  neighbouring columns read the same value and the envelope turns into a
 *  staircase. The visible window at those zooms is a fraction of a second, so
 *  scanning it per redraw is cheap. */
export function aggregateExactRange(
  channels: readonly Float32Array[],
  s0: number,
  s1: number,
  totalSamples: number,
): WindowStats {
  const a = Math.max(0, Math.floor(s0));
  const b = Math.min(totalSamples, Math.ceil(s1));
  if (b <= a || channels.length === 0) return { peak: 0, rms: 0, clipped: false };

  const nCh = channels.length;
  let p = 0;
  let sumSq = 0;
  let clip = false;
  for (let i = a; i < b; i++) {
    let v = channels[0][i];
    if (nCh > 1) {
      for (let c = 1; c < nCh; c++) v += channels[c][i];
      v /= nCh;
    }
    const amp = v < 0 ? -v : v;
    if (amp > p) p = amp;
    if (amp >= CLIP_THRESHOLD) clip = true;
    sumSq += v * v;
  }
  return { peak: p, rms: Math.sqrt(sumSq / (b - a)), clipped: clip };
}
