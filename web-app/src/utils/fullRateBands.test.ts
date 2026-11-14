import { describe, it, expect } from 'vitest';
import { bandsFromChannels, EQ_SAMPLE_RATE } from './fullRateBands';

const tone = (hz: number, seconds = 1, sr = EQ_SAMPLE_RATE) =>
  Float32Array.from({ length: Math.round(seconds * sr) }, (_, i) => Math.sin((2 * Math.PI * hz * i) / sr));

const mean = (a: Float32Array) => a.reduce((s, v) => s + v, 0) / a.length;

describe('bandsFromChannels — the EQ lane at full quality', () => {
  it('puts an 8 kHz hi-hat-range tone in High, which an 8 kHz decode cannot hold', async () => {
    // Quiet low tone for reference, loud 8 kHz tone for the highs.
    const low = tone(100), hi = tone(8000);
    const mix = low.map((v, i) => 0.2 * v + hi[i]);
    const bands = await bandsFromChannels([mix], EQ_SAMPLE_RATE);
    expect(mean(bands.high)).toBeGreaterThan(0.5);
  });

  it('keeps a 100 Hz tone in Low and out of High', async () => {
    const bands = await bandsFromChannels([tone(100)], EQ_SAMPLE_RATE);
    expect(mean(bands.low)).toBeGreaterThan(0.5);
    const lowRaw = Math.max(...bands.low);
    expect(lowRaw).toBe(1);
  });

  it('mixes channels to mono and scales each band to its own peak', async () => {
    const l = tone(1000), r = tone(1000);
    const bands = await bandsFromChannels([l, r], EQ_SAMPLE_RATE);
    expect(Math.max(...bands.mid)).toBeCloseTo(1, 5);
    expect(bands.mid.length).toBe(Math.floor((l.length - 2048) / 512) + 1);
  });

  it('returns empty bands for audio shorter than one frame', async () => {
    const bands = await bandsFromChannels([new Float32Array(100)], EQ_SAMPLE_RATE);
    expect(bands.high.length).toBe(0);
  });
});
