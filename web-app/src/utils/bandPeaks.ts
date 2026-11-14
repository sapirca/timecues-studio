/**
 * 3-band peaks for a decoded song — the data behind the 3-Band waveform row
 * (FrequencyWaveform) and the full-song overview strip (SongOverviewStrip).
 *
 * The song is split into Low (< 150 Hz), Mid (150–2500 Hz) and High (> 2500 Hz)
 * by BiquadFilterNodes in an OfflineAudioContext at 11025 Hz, then reduced to
 * peaks. That render is the expensive part, so it runs once per AudioBuffer and
 * every component asking for the same buffer shares the one promise.
 */

const RENDER_SAMPLE_RATE = 11025;  // Hz — Nyquist 5512 > 2500 Hz HP crossover
// Peak resolution kept per band, in peaks per second of audio. The old scheme
// stored a fixed 32 000 peaks for the WHOLE track, so a 3-minute song was
// summarized at ~5 ms per peak no matter how far you zoomed — the row could
// not show detail it had never kept. Storing a fixed RATE instead makes the
// row's detail independent of track length: 2 000/s is 0.5 ms per peak, finer
// than one screen pixel until about ×300, and costs 8 KB per second of audio
// per band (~1.4 MB per band for a 3-minute track).
const PEAKS_PER_SECOND = 2_000;
const MIN_PEAKS = 32_000;
const MAX_PEAKS = 2_000_000;   // ~8 MB per band, i.e. a 16-minute track at full rate

export interface BandPeaks {
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  /** 1 / each band's own maximum — every band is normalised to itself. */
  scales: { low: number; mid: number; high: number };
}

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

/** Max |sample| per output column. */
export function buildPeaks(pcm: Float32Array, numCols: number): Float32Array {
  const step = pcm.length / numCols;
  const peaks = new Float32Array(numCols);
  for (let col = 0; col < numCols; col++) {
    const start = Math.floor(col * step);
    const end   = Math.max(start + 1, Math.min(Math.floor((col + 1) * step), pcm.length));
    let peak = 0;
    for (let i = start; i < end; i++) {
      const a = Math.abs(pcm[i]);
      if (a > peak) peak = a;
    }
    peaks[col] = peak;
  }
  return peaks;
}

const cache = new WeakMap<AudioBuffer, Promise<BandPeaks>>();

export function getBandPeaks(buf: AudioBuffer): Promise<BandPeaks> {
  const hit = cache.get(buf);
  if (hit) return hit;
  const p = (async () => {
    // Render all three bands concurrently, then immediately downsample.
    // Storing the full 11025 Hz PCM would cost ~13 MB per band that grows with
    // song length; peaks keep it small.
    const [lowPcm, midPcm, highPcm] = await Promise.all([
      renderBand(buf, [{ type: 'lowpass',  frequency: 150 }]),
      renderBand(buf, [{ type: 'highpass', frequency: 150 }, { type: 'lowpass', frequency: 2500 }]),
      renderBand(buf, [{ type: 'highpass', frequency: 2500 }]),
    ]);
    const numPeaks = Math.max(MIN_PEAKS, Math.min(MAX_PEAKS, Math.round(buf.duration * PEAKS_PER_SECOND)));
    const low  = buildPeaks(lowPcm,  numPeaks);
    const mid  = buildPeaks(midPcm,  numPeaks);
    const high = buildPeaks(highPcm, numPeaks);
    const inv = (a: Float32Array) => { let m = 0; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m > 0 ? 1 / m : 1; };
    return { low, mid, high, scales: { low: inv(low), mid: inv(mid), high: inv(high) } };
  })();
  // A failed render must not poison the cache: the next ask tries again.
  p.catch(() => cache.delete(buf));
  cache.set(buf, p);
  return p;
}
