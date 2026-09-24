import { describe, it, expect } from 'vitest';
import {
  adsrStages, analyzeGestures, brightnessPlotRange, buildEnergySpanExport, clipCurve,
  computeAdsrEnvelope, computeStemEnergySpan, energySpanLabel, envelopeCoverageNote,
  envelopeViewport, parseEnergySpanExport, peakSequenceNote, peakSequenceWord,
} from './energySpan';
import type { EnergySpanExport, EnvelopeExport } from './energySpan';

const HOP = 0.005; // 5ms — the hop computeStemEnergySpan feeds the envelope pass

/** Builds a peak-normalized contour from piecewise-linear (durationMs, level)
 *  legs starting at `startLevel`, sampled on the 5ms envelope grid. */
function contour(startLevel: number, legs: [durationMs: number, toLevel: number][]): number[] {
  const out = [startLevel];
  let from = startLevel;
  for (const [durationMs, toLevel] of legs) {
    const steps = Math.max(1, Math.round(durationMs / (HOP * 1000)));
    for (let i = 1; i <= steps; i++) out.push(from + ((toLevel - from) * i) / steps);
    from = toLevel;
  }
  return out;
}

describe('computeAdsrEnvelope', () => {
  it('reads a percussive hit: fast attack, no plateau, long tail', () => {
    // 20ms strike → 80ms drop to a quiet tail → 900ms fade to silence.
    const env = computeAdsrEnvelope(contour(0, [[20, 1], [80, 0.15], [900, 0]]), HOP, 0.42);

    expect(env.shape).toBe('percussive');
    expect(env.peakAtMs).toBe(20);
    expect(env.peakRms).toBe(0.42);
    expect(env.attackMs).toBeLessThanOrEqual(20);
    expect(env.sustainLevel).toBeLessThan(0.35);
    // Everything after the strike is fall, so the tail dominates.
    expect(env.decayMs + env.releaseMs).toBeGreaterThan(800);
  });

  it('reads a swell: attack occupies most of the span', () => {
    // 3s rise to the peak, then a short 200ms fall off the end.
    const env = computeAdsrEnvelope(contour(0, [[3000, 1], [200, 0.4]]), HOP, 0.31);

    expect(env.shape).toBe('swell');
    expect(env.peakAtMs).toBe(3000);
    // 10%→90% of a linear 3s ramp is 80% of it.
    expect(env.attackMs).toBeGreaterThan(2300);
    expect(env.attackMs).toBeLessThan(2500);
    expect(env.releaseMs).toBeGreaterThan(0);
  });

  it('reads a sustained pad: plateau holds most of the span near peak', () => {
    // 300ms in, 200ms settle to 0.8, 4s hold, 500ms release.
    const env = computeAdsrEnvelope(
      contour(0, [[300, 1], [200, 0.8], [4000, 0.8], [500, 0]]),
      HOP,
      0.55,
    );

    expect(env.shape).toBe('sustained');
    expect(env.sustainLevel).toBeCloseTo(0.8, 1);
    expect(env.sustainMs).toBeGreaterThan(3500);
    expect(env.releaseMs).toBeGreaterThan(300);
    expect(env.decayMs).toBeGreaterThan(0);
  });

  it('collapses sustain to zero on a pure decay with no plateau', () => {
    // Peak at the very start, then a single uninterrupted slide to silence.
    const env = computeAdsrEnvelope(contour(1, [[2000, 0]]), HOP, 0.2);

    expect(env.peakAtMs).toBe(0);
    expect(env.attackMs).toBe(0);
    expect(env.sustainMs).toBe(0);
    expect(env.decayMs + env.releaseMs).toBeCloseTo(2000, -1);
  });

  it('gives a monotonic rise no decay and no sustain', () => {
    const env = computeAdsrEnvelope(contour(0, [[1000, 1]]), HOP, 0.9);

    expect(env.peakAtMs).toBe(1000);
    expect(env.decayMs).toBe(0);
    expect(env.sustainMs).toBe(0);
    expect(env.releaseMs).toBe(0);
  });

  it('measures attack from t=0 when the span opens above the 10% floor', () => {
    // Starts at 0.5 of peak — there is no 10% crossing to anchor the rise to.
    const env = computeAdsrEnvelope(contour(0.5, [[400, 1], [400, 0.6]]), HOP, 0.7);

    expect(env.attackMs).toBeGreaterThan(0);
    expect(env.attackMs).toBeLessThanOrEqual(400);
  });

  it('survives a contour too short to segment', () => {
    const env = computeAdsrEnvelope([0.6, 0.6], HOP, 0.1);

    expect(env.shape).toBe('sustained');
    expect(env.sustainLevel).toBe(0.6);
    expect(env.attackMs).toBe(0);
  });
});

const SAMPLE_RATE = 44100;

/** Minimal stand-in for the AudioBuffer fields computeStemEnergySpan reads —
 *  jsdom has no Web Audio, and only these four are touched. */
function fakeBuffer(samples: Float32Array): AudioBuffer {
  return {
    sampleRate: SAMPLE_RATE,
    duration: samples.length / SAMPLE_RATE,
    numberOfChannels: 1,
    getChannelData: () => samples,
  } as unknown as AudioBuffer;
}

/** A 220Hz tone whose amplitude follows `gainAt(t)`, so the RMS contour the
 *  analyzer recovers is a known shape. */
function tone(durationSec: number, gainAt: (t: number) => number): Float32Array {
  const out = new Float32Array(Math.floor(durationSec * SAMPLE_RATE));
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    out[i] = gainAt(t) * Math.sin(2 * Math.PI * 220 * t);
  }
  return out;
}

/** A tone whose frequency AND amplitude both follow the given functions —
 *  phase-accumulated, so a sweep stays continuous. This is the only way to
 *  build the case brightness exists for: a passage that gets quieter and
 *  brighter at the same time. */
function sweep(
  durationSec: number,
  hzAt: (t: number) => number,
  gainAt: (t: number) => number,
): Float32Array {
  const out = new Float32Array(Math.floor(durationSec * SAMPLE_RATE));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    phase += (2 * Math.PI * hzAt(t)) / SAMPLE_RATE;
    out[i] = gainAt(t) * Math.sin(phase);
  }
  return out;
}

/** Gain that walks through (atSec, level) knees, held flat past the last one.
 *  The shape of a real passage, as an amplitude envelope for `tone`. */
function ramp(knees: [atSec: number, level: number][]): (t: number) => number {
  return (t: number) => {
    if (t <= knees[0][0]) return knees[0][1];
    for (let i = 1; i < knees.length; i++) {
      const [t1, v1] = knees[i];
      if (t <= t1) {
        const [t0, v0] = knees[i - 1];
        return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
      }
    }
    return knees[knees.length - 1][1];
  };
}

// Three swells, each louder than the last, opening mid-sound and ending in the
// tail after the third — the span in the bug report, in miniature. Every
// endpoint pair in it lies: it starts loud and finishes quiet.
const RISING_SWELLS: [number, number][] = [
  [0, 0.55], [0.8, 0.10],
  [2.0, 0.45], [3.0, 0.10],
  [4.5, 0.70], [5.5, 0.10],
  [7.0, 1.00], [8.5, 0.12],
];

describe('trend is fitted across the span, not read off its edges', () => {
  it('calls a passage of louder-and-louder swells increasing, though it ends in its tail', () => {
    const buffer = fakeBuffer(tone(8.5, ramp(RISING_SWELLS)));
    const result = computeStemEnergySpan({ audioBuffer: buffer, startSec: 0, endSec: 8.5 });

    // The reading the old endpoint comparison had to give: first frame loud,
    // last frame in the tail. Both are still in the curve; neither decides.
    expect(result.curve[0].energy).toBeGreaterThan(result.curve[result.curve.length - 1].energy);
    expect(result.trend).toBe('increasing');
    // And the quoted pair agrees with the verdict it is printed beside.
    expect(result.endEnergy).toBeGreaterThan(result.startEnergy);
  });

  it('holds the verdict when the span is trimmed by a beat', () => {
    const buffer = fakeBuffer(tone(8.5, ramp(RISING_SWELLS)));
    const whole = computeStemEnergySpan({ audioBuffer: buffer, startSec: 0, endSec: 8.5 });
    // A drag half a second short — the kind of edge nudge that used to move the
    // last frame off the tail and invert the answer.
    const trimmed = computeStemEnergySpan({ audioBuffer: buffer, startSec: 0, endSec: 8.0 });

    expect(trimmed.trend).toBe(whole.trend);
  });

  it('never quotes a level outside the range the span actually held', () => {
    const buffer = fakeBuffer(tone(8.5, ramp(RISING_SWELLS)));
    const result = computeStemEnergySpan({ audioBuffer: buffer, startSec: 0, endSec: 8.5 });
    const levels = result.curve.map((p) => p.energy);

    // A fitted line overshoots its data at the ends; what gets reported doesn't.
    expect(result.startEnergy).toBeGreaterThanOrEqual(0);
    expect(result.endEnergy).toBeLessThanOrEqual(Math.max(...levels) + 1e-9);
  });

  it('still reads a plain fade as decreasing', () => {
    const buffer = fakeBuffer(tone(4, ramp([[0, 1], [4, 0.05]])));
    const result = computeStemEnergySpan({ audioBuffer: buffer, startSec: 0, endSec: 4 });

    expect(result.trend).toBe('decreasing');
  });
});

describe('peak sequence — the direction across gestures', () => {
  it('reports each gesture\'s height, relative to the loudest, and which way they go', () => {
    const buffer = fakeBuffer(tone(8.5, ramp(RISING_SWELLS)));
    const result = computeStemEnergySpan({ audioBuffer: buffer, startSec: 0, endSec: 8.5 });

    // The span holds more than one gesture, so there is no envelope — which is
    // exactly the case that used to have nothing to say about direction.
    expect(result.adsr).toBeNull();
    expect(result.rejection).not.toBeNull();
    expect(result.rejection!.peakLevels).toHaveLength(result.rejection!.gestureCount);
    expect(peakSequenceWord(result.rejection!.peakLevels)).toBe('rising');
    // Heights are peak-relative, so the tallest gesture is 1.
    expect(Math.max(...result.rejection!.peakLevels)).toBe(1);
  });

  it('spells the sequence out for the card, loudest-relative', () => {
    expect(peakSequenceNote([0.61, 0.78, 1])).toBe('peaks rising 0.61 → 0.78 → 1.00');
    expect(peakSequenceNote([1, 0.72, 0.4])).toBe('peaks falling 1.00 → 0.72 → 0.40');
    expect(peakSequenceWord([0.95, 1, 0.97])).toBe('holding level');
  });

  it('says nothing when there is no sequence — one gesture, or an older blob', () => {
    expect(peakSequenceNote([1])).toBeNull();
    expect(peakSequenceNote(undefined)).toBeNull();
    expect(peakSequenceWord(undefined)).toBeNull();
  });

  it('carries the levels into the export blob and its description', () => {
    const buffer = fakeBuffer(tone(8.5, ramp(RISING_SWELLS)));
    const result = computeStemEnergySpan({ audioBuffer: buffer, startSec: 0, endSec: 8.5 });
    const blob = buildEnergySpanExport({
      songSlug: 'peter_the_wolf', stem: 'mix', startSec: 0, endSec: 8.5, result,
    });

    expect(blob.envelope_rejected!.peak_levels).toEqual(result.rejection!.peakLevels);
    expect(blob.description).toContain('peaks rising');
  });
});

describe('computeStemEnergySpan', () => {
  it('recovers a swell from real samples — rising trend, attack-dominated envelope', () => {
    // Amplitude ramps 0 → 1 across a 2s tone.
    const buffer = fakeBuffer(tone(2, (t) => t / 2));
    const result = computeStemEnergySpan({ audioBuffer: buffer, startSec: 0, endSec: 2 });

    expect(result.rejection).toBeNull();
    expect(result.adsr).not.toBeNull();
    expect(result.trend).toBe('increasing');
    expect(result.curve).toHaveLength(12);
    expect(result.endEnergy).toBeGreaterThan(result.startEnergy);

    expect(result.adsr!.shape).toBe('swell');
    expect(result.adsr!.peakAtMs).toBeGreaterThan(1800);
    expect(result.adsr!.peakRms).toBeGreaterThan(0);
    // 10%→90% of a linear ramp is 80% of its length.
    expect(result.adsr!.attackMs).toBeGreaterThan(1400);
  });

  it('recovers a held tone as a sustained plateau', () => {
    const buffer = fakeBuffer(tone(3, () => 0.5));
    const result = computeStemEnergySpan({ audioBuffer: buffer, startSec: 0, endSec: 3 });

    expect(result.trend).toBe('flat');
    expect(result.adsr!.shape).toBe('sustained');
    expect(result.adsr!.sustainLevel).toBeGreaterThan(0.9);
    expect(result.adsr!.sustainMs).toBeGreaterThan(2000);
  });

  it('honours a sub-window selection without throwing', () => {
    const buffer = fakeBuffer(tone(1, () => 0.5));
    const result = computeStemEnergySpan({ audioBuffer: buffer, startSec: 0.5, endSec: 0.502 });

    expect(result.curve.length).toBeGreaterThan(0);
    expect(Number.isFinite(result.adsr!.sustainLevel)).toBe(true);
  });

  it('carries the envelope into the export blob and its summary sentence', () => {
    const buffer = fakeBuffer(tone(2, (t) => t / 2));
    const result = computeStemEnergySpan({ audioBuffer: buffer, startSec: 0, endSec: 2 });
    const blob = buildEnergySpanExport({
      songSlug: 'demo-song', stem: 'drums', startSec: 0, endSec: 2, result,
    });

    expect(blob.envelope).not.toBeNull();
    expect(blob.envelope!.shape).toBe('swell');
    expect(blob.envelope!.attack_ms).toBe(result.adsr!.attackMs);
    expect(blob.envelope!.sustain_level).toBe(result.adsr!.sustainLevel);
    expect(blob.envelope!.peak_rms).toBe(result.adsr!.peakRms);
    expect(blob.description).toContain('Envelope reads swell');
    // The pre-existing trend sentence still leads the summary.
    expect(blob.description).toContain('Energy on the drums stem');
  });
});

describe('brightness', () => {
  it('reads a build: level falling while the timbre opens up', () => {
    // The bar before a drop, in miniature — the low end is pulled out (gain
    // 1 → 0.3) while a riser sweeps 300Hz → 4kHz. RMS alone calls this a
    // decrescendo, which is true of the level and wrong about the passage.
    const buffer = fakeBuffer(sweep(3, (t) => 300 + (3700 * t) / 3, (t) => 1 - (0.7 * t) / 3));
    const result = computeStemEnergySpan({ audioBuffer: buffer, startSec: 0, endSec: 3 });

    expect(result.trend).toBe('decreasing');
    expect(result.brightness).not.toBeNull();
    expect(result.brightness!.trend).toBe('increasing');
    expect(result.brightness!.startHz).toBeLessThan(1000);
    expect(result.brightness!.endHz).toBeGreaterThan(3000);
    expect(result.brightness!.peakHz).toBeGreaterThanOrEqual(result.brightness!.endHz);
    // Every curve point carries the pair, on one grid.
    expect(result.curve.every((p) => p.brightness != null)).toBe(true);
    expect(result.curve[0].brightness!).toBeLessThan(result.curve[11].brightness!);
  });

  it('reads a held tone as flat, whatever the level does', () => {
    // Same fade, no sweep: the level falls and the timbre does not move.
    const buffer = fakeBuffer(sweep(3, () => 440, (t) => 1 - (0.7 * t) / 3));
    const result = computeStemEnergySpan({ audioBuffer: buffer, startSec: 0, endSec: 3 });

    expect(result.trend).toBe('decreasing');
    expect(result.brightness!.trend).toBe('flat');
    expect(result.brightness!.startHz).toBeGreaterThan(300);
    expect(result.brightness!.startHz).toBeLessThan(700);
  });

  it('reports nothing on a silent span rather than the noise floor\'s centroid', () => {
    const result = computeStemEnergySpan({
      audioBuffer: fakeBuffer(new Float32Array(SAMPLE_RATE * 2)),
      startSec: 0,
      endSec: 2,
    });

    expect(result.brightness).toBeNull();
    expect(result.curve.every((p) => p.brightness === undefined)).toBe(true);
  });

  it('names the build in the export, the label and the summary sentence', () => {
    const buffer = fakeBuffer(sweep(3, (t) => 300 + (3700 * t) / 3, (t) => 1 - (0.7 * t) / 3));
    const result = computeStemEnergySpan({ audioBuffer: buffer, startSec: 0, endSec: 3 });
    const blob = buildEnergySpanExport({
      songSlug: 'demo-song', stem: 'other', startSec: 56.2, endSec: 59.2, result,
    });

    expect(blob.brightness_trend).toBe('increasing');
    expect(blob.brightness_hz!.end).toBeGreaterThan(blob.brightness_hz!.start);
    expect(blob.description).toContain('Brightness rises');
    expect(blob.description).toContain('the shape of a build');
    // The label is the part a person scans for; it has to carry both trends.
    expect(energySpanLabel(blob)).toBe('Energy: falling, brightening (other)');
  });

  it('leaves flat brightness off the label and keeps it in the summary', () => {
    const buffer = fakeBuffer(sweep(3, () => 440, (t) => 1 - (0.7 * t) / 3));
    const result = computeStemEnergySpan({ audioBuffer: buffer, startSec: 0, endSec: 3 });
    const blob = buildEnergySpanExport({
      songSlug: 'demo-song', stem: 'mix', startSec: 0, endSec: 3, result,
    });

    expect(energySpanLabel(blob)).toBe('Energy: falling (mix)');
    expect(blob.description).toContain('Brightness holds near');
  });

  it('falls back to the old label shape on a blob with no brightness', () => {
    expect(energySpanLabel(exportBlob({ trend: 'increasing' }))).toBe('Energy: rising (mix)');
  });
});

describe('brightnessPlotRange', () => {
  it('pads the travel a curve actually made', () => {
    const range = brightnessPlotRange([
      { t_ms: 0, energy: 1, brightness: 0.4 },
      { t_ms: 1000, energy: 1, brightness: 1 },
    ])!;

    expect(range.lo).toBeLessThan(0.4);
    expect(range.hi).toBeGreaterThan(1);
  });

  it('refuses to stretch ripple into a gesture', () => {
    expect(brightnessPlotRange([
      { t_ms: 0, energy: 1, brightness: 0.98 },
      { t_ms: 1000, energy: 1, brightness: 1 },
    ])).toBeNull();
  });

  it('is null on a curve measured before brightness existed', () => {
    expect(brightnessPlotRange([
      { t_ms: 0, energy: 1 },
      { t_ms: 1000, energy: 0.5 },
    ])).toBeNull();
  });
});

const HITS_PER_SEC = 1 / 0.4286; // one transient per beat at 140bpm

/** A fade from `from` to `to` over `durationMs` with a percussive transient on
 *  every beat riding on top — the shape a breakdown fade-out actually has on a
 *  full mix, and the one the first-failure slope walk trips over. */
function fadeWithBeats(durationMs: number, from: number, to: number, depth = 1): number[] {
  const n = Math.round(durationMs / (HOP * 1000));
  const beat = 1 / (HITS_PER_SEC * HOP);
  return Array.from({ length: n }, (_, i) => {
    const under = from * Math.pow(to / from, i / (n - 1));
    const phase = i % beat;
    return under * (1 + depth * (phase < 2 ? phase / 2 : Math.exp((-phase * HOP) / 0.12)));
  });
}

describe('analyzeGestures', () => {
  it('reads a single fade as one gesture', () => {
    expect(analyzeGestures(contour(1, [[6900, 0.05]]), HOP).count).toBe(1);
  });

  it('is not fooled into counting per-beat transients as gestures', () => {
    // The bug this guards: every drum hit is a local maximum, and on a fade
    // each one stands well above the trough before it.
    const frames = fadeWithBeats(6900, 1, 0.05);
    const peak = Math.max(...frames);
    expect(analyzeGestures(frames.map((v) => v / peak), HOP).count).toBe(1);
  });

  it('rejects two swells in one span and offers the trough as a split', () => {
    // Up to a peak at 2s, back down to 0.1, up to a second peak at 6s.
    const frames = contour(0, [[2000, 1], [2000, 0.1], [2000, 0.9], [1000, 0.2]]);
    const gestures = analyzeGestures(frames, HOP);

    expect(gestures.count).toBe(2);
    expect(gestures.peaksAtMs[0]).toBeGreaterThan(1500);
    expect(gestures.peaksAtMs[1]).toBeGreaterThan(5000);
    expect(gestures.splitAtMs).toHaveLength(1);
    // The split lands in the valley between them.
    expect(gestures.splitAtMs[0]).toBeGreaterThan(3000);
    expect(gestures.splitAtMs[0]).toBeLessThan(5000);
  });

  it('does not split a gesture on a dip too shallow to be a second one', () => {
    // Same two humps, but the valley only reaches 0.85 — ripple, not a gesture.
    const frames = contour(0, [[2000, 1], [1000, 0.85], [1000, 0.95], [1000, 0]]);
    expect(analyzeGestures(frames, HOP).count).toBe(1);
  });
});

describe('envelope shape on a real fade-out', () => {
  it('reads a beat-riddled fade as decaying, not percussive', () => {
    // The reported case: a 6.9s breakdown fade into a drop came back
    // "percussive" with a 6.1s "sustain" at 0.28 of peak.
    const frames = fadeWithBeats(6900, 1, 0.05);
    const peak = Math.max(...frames);
    const env = computeAdsrEnvelope(frames.map((v) => v / peak), HOP, peak);

    expect(env.shape).toBe('decaying');
    // The fall is the whole gesture: no plateau, and the fall is reported once
    // rather than split between D and R at an arbitrary point.
    expect(env.sustainMs).toBe(0);
    expect(env.sustainLevel).toBe(0);
    expect(env.decayMs + env.releaseMs).toBeGreaterThan(0.7 * 6900);
  });

  it('measures a plateau through the transients riding on it', () => {
    // A pad that rises, holds at 0.7 for 3s, then releases — with a drum hit on
    // every beat throughout. The old first-failure walk ended the decay on the
    // first kick after the peak and called everything left over "sustain"; the
    // longest-run scan has to find the actual 3s hold.
    const beat = Math.round(0.4286 / HOP);
    const base = contour(0, [[300, 1], [200, 0.7], [3000, 0.7], [900, 0]]);
    const frames = base.map((v, i) => {
      const phase = i % beat;
      return Math.min(1, v * (1 + 0.8 * (phase < 2 ? phase / 2 : Math.exp((-phase * HOP) / 0.12))));
    });
    const env = computeAdsrEnvelope(frames, HOP, 0.5);

    expect(env.shape).toBe('sustained');
    // Truth is D=200 S=3000 R=900 on a 4.4s span. Plateau edges carry roughly
    // half a slope window (~180ms each side) of uncertainty, so these are
    // "the right stretch", not exact — the point is that the hold is FOUND
    // and stays put, where the old walk reported no plateau at all here.
    expect(env.sustainMs).toBeGreaterThan(2200);
    expect(env.sustainMs).toBeLessThan(3200);
    expect(env.decayMs).toBeGreaterThan(0);
    expect(env.decayMs).toBeLessThan(900);
    expect(env.releaseMs).toBeGreaterThan(700);
    expect(env.releaseMs).toBeLessThan(1400);
  });

  it('keeps the same plateau however loud the transients on top of it get', () => {
    // The lower envelope is what makes this hold: percussion is an additive
    // excursion above the level being held, so its depth must not move the
    // measurement. A mean-smoothed contour drifts with it and eventually loses
    // the plateau entirely.
    const beat = Math.round(0.4286 / HOP);
    const base = contour(0, [[300, 1], [200, 0.7], [3000, 0.7], [900, 0]]);
    const measured = [0, 0.3, 0.8, 1.2].map((depth) => {
      const frames = base.map((v, i) => {
        const phase = i % beat;
        return v * (1 + depth * (phase < 2 ? phase / 2 : Math.exp((-phase * HOP) / 0.12)));
      });
      const peak = Math.max(...frames);
      return computeAdsrEnvelope(frames.map((v) => v / peak), HOP, 0.5);
    });

    for (const env of measured) {
      expect(env.shape).toBe('sustained');
      expect(env.sustainMs).toBeGreaterThan(2200);
    }
    // Spread across a 4x swing in transient depth stays inside one slope window.
    const sustains = measured.map((e) => e.sustainMs);
    expect(Math.max(...sustains) - Math.min(...sustains)).toBeLessThan(500);
  });

  it('reads a clean fade opening at its peak as decaying', () => {
    // No onset is captured at all, so a fast-attack read is unsupportable.
    const env = computeAdsrEnvelope(contour(1, [[6900, 0.05]]), HOP, 0.2);

    expect(env.attackMs).toBe(0);
    expect(env.shape).toBe('decaying');
  });

  it('still calls a genuine hit percussive', () => {
    const env = computeAdsrEnvelope(contour(0, [[20, 1], [80, 0.15], [900, 0]]), HOP, 0.42);
    expect(env.shape).toBe('percussive');
  });

  it('will not call a long-attack gesture percussive however short the span', () => {
    // Relative-only thresholds let a 400ms attack pass as "fast" on a 7s span.
    const env = computeAdsrEnvelope(contour(0, [[400, 1], [6500, 0.02]]), HOP, 0.3);

    expect(env.attackMs).toBeGreaterThan(100);
    expect(env.shape).toBe('decaying');
  });
});

/** A rising build with a hit on every eighth and the drop landing at the very
 *  end. Between hits the level collapses to a fraction of the local envelope,
 *  the way a real build does — which is what puts those troughs under a tenth
 *  of the drop's peak and makes them look like the start of a rise. */
function buildIntoDrop(durationMs: number, from: number, to: number, dropGain: number): number[] {
  const n = Math.round(durationMs / (HOP * 1000));
  const beat = 1 / (2 * HITS_PER_SEC * HOP);
  const dropIdx = n - Math.round(70 / (HOP * 1000));
  return Array.from({ length: n }, (_, i) => {
    if (i >= dropIdx) return to * dropGain * Math.min(1, ((i - dropIdx) * HOP) / 0.01);
    const under = from * Math.pow(to / from, i / (n - 1));
    const phase = i % beat;
    const hit = phase < 2 ? phase / 2 : Math.exp((-phase * HOP) / 0.12);
    return under * (0.08 + 0.92 * hit);
  });
}

describe('envelope shape on a build into a drop', () => {
  it('reads a beat-riddled build as a swell, not decaying', () => {
    // The reported case: a 6.6s build into a drop came back "decaying" with a
    // 37ms attack, next to a trend line on the same result reading "increasing".
    // The drop towers over the build under it, so the 10% floor sits below every
    // gap between hits — and the attack was measured from the last one, 55ms
    // before the peak.
    const frames = buildIntoDrop(6600, 0.18, 0.62, 2.6);
    const peak = Math.max(...frames);
    const env = computeAdsrEnvelope(frames.map((v) => v / peak), HOP, peak);

    expect(env.shape).toBe('swell');
    // The rise is the gesture: it owns most of the span, not 37ms of it.
    expect(env.attackMs).toBeGreaterThan(0.35 * 6600);
    expect(env.peakAtMs).toBeGreaterThan(6400);
  });

  it('calls a build that stops dead before the drop a swell too', () => {
    // Here the short attack is correct — the drop really does rise out of
    // silence — so only the structure says this is a build: the peak sits at
    // the span's end and the body climbed all the way to it.
    const env = computeAdsrEnvelope(
      contour(0.1, [[5000, 0.5], [100, 0.02], [300, 0.02], [20, 1], [100, 0.9]]),
      HOP,
      0.48,
    );

    expect(env.attackMs).toBeLessThan(100);
    expect(env.shape).toBe('swell');
  });

  it('does not call a fade closing on a crash a build', () => {
    // Same geometry — peak at the very end, nothing after it — but the body
    // fell to get there. Direction is what separates the two.
    const frames = fadeWithBeats(6600, 1, 0.1);
    const n = frames.length;
    const crashIdx = n - Math.round(80 / (HOP * 1000));
    for (let i = crashIdx; i < n; i++) frames[i] = 2 * Math.min(1, ((i - crashIdx) * HOP) / 0.01);
    const peak = Math.max(...frames);
    const env = computeAdsrEnvelope(frames.map((v) => v / peak), HOP, peak);

    expect(env.shape).toBe('decaying');
  });
});

describe('rejection reaches the export blob', () => {
  it('nulls the envelope and explains the split instead', () => {
    // Two tone swells inside one selection.
    const buffer = fakeBuffer(tone(8, (t) => (t < 4 ? t / 4 : (8 - t) / 4) * (t < 4 ? 1 : 1)));
    const twoHumps = tone(8, (t) => {
      const a = Math.exp(-(((t - 1.5) / 0.7) ** 2));
      const b = Math.exp(-(((t - 6.0) / 0.7) ** 2));
      return Math.max(a, b);
    });
    void buffer;
    const result = computeStemEnergySpan({ audioBuffer: fakeBuffer(twoHumps), startSec: 0, endSec: 8 });

    expect(result.adsr).toBeNull();
    expect(result.rejection?.gestureCount).toBe(2);

    const blob = buildEnergySpanExport({
      songSlug: 'demo-song', stem: 'mix', startSec: 10, endSec: 18, result,
    });

    expect(blob.envelope).toBeNull();
    expect(blob.envelope_rejected?.reason).toBe('multiple_gestures');
    expect(blob.description).toContain('No envelope reported');
    // Split points are reported on the song clock, not relative to the span.
    expect(blob.description).toMatch(/Split it at 1[0-9]\.[0-9]s/);
    // The trend half of the export is untouched.
    expect(blob.curve).toHaveLength(12);
  });

  it('leaves envelope_rejected null on a single-gesture span', () => {
    const result = computeStemEnergySpan({
      audioBuffer: fakeBuffer(tone(2, (t) => t / 2)), startSec: 0, endSec: 2,
    });
    const blob = buildEnergySpanExport({
      songSlug: 'demo-song', stem: 'drums', startSec: 0, endSec: 2, result,
    });

    expect(blob.envelope_rejected).toBeNull();
    expect(blob.envelope?.shape).toBe('swell');
  });
});

// ─── Reading an export back off a Span ──────────────────────────────────────

const ENVELOPE: EnvelopeExport = {
  shape: 'sustained',
  attack_ms: 100,
  decay_ms: 200,
  sustain_ms: 500,
  release_ms: 300,
  sustain_level: 0.6,
  peak_at_ms: 400,
  peak_rms: 0.12,
};

function exportBlob(over: Partial<EnergySpanExport> = {}): EnergySpanExport {
  return {
    type: 'energy_span',
    song: 'demo-song',
    stem: 'mix',
    start_ms: 1000,
    end_ms: 3000,
    duration_ms: 2000,
    trend: 'increasing',
    start_energy: 0.2,
    end_energy: 0.9,
    brightness_trend: null,
    brightness_hz: null,
    curve: [{ t_ms: 0, energy: 0.2 }, { t_ms: 2000, energy: 0.9 }],
    envelope: ENVELOPE,
    envelope_rejected: null,
    description: 'Energy on the mix stem rises…',
    ...over,
  };
}

describe('parseEnergySpanExport', () => {
  it('round-trips a blob written into a span description', () => {
    const blob = exportBlob();
    const parsed = parseEnergySpanExport(JSON.stringify(blob, null, 2));
    expect(parsed).toEqual(blob);
  });

  it('returns null for a description that is not an export', () => {
    expect(parseEnergySpanExport(undefined)).toBeNull();
    expect(parseEnergySpanExport('')).toBeNull();
    expect(parseEnergySpanExport('the drums drop here')).toBeNull();
    // Mentions the type but is not JSON — the cheap prefilter must not let
    // this reach JSON.parse and throw on the caller's render path.
    expect(parseEnergySpanExport('notes on the energy_span export')).toBeNull();
  });

  it('returns null for a truncated or wrong-shaped blob', () => {
    expect(parseEnergySpanExport('{"type":"energy_span","curve":[')).toBeNull();
    expect(parseEnergySpanExport(JSON.stringify({ type: 'cue_export', curve: [1] }))).toBeNull();
    expect(parseEnergySpanExport(JSON.stringify(exportBlob({ curve: [] })))).toBeNull();
    expect(parseEnergySpanExport(JSON.stringify(exportBlob({ duration_ms: 0 })))).toBeNull();
  });
});

describe('adsrStages', () => {
  it('lays the four legs out around the peak', () => {
    const stages = adsrStages(ENVELOPE, 2000);

    expect(stages.map((s) => s.stage)).toEqual(['attack', 'decay', 'sustain', 'release']);
    // Attack is anchored backwards from the peak: 400ms peak − 100ms rise.
    expect(stages[0]).toMatchObject({ fromMs: 300, toMs: 400, fromLevel: 0, toLevel: 1 });
    expect(stages[1]).toMatchObject({ fromMs: 400, toMs: 600, fromLevel: 1, toLevel: 0.6 });
    expect(stages[2]).toMatchObject({ fromMs: 600, toMs: 1100, fromLevel: 0.6, toLevel: 0.6 });
    expect(stages[3]).toMatchObject({ fromMs: 1100, toMs: 1400, fromLevel: 0.6, toLevel: 0 });
  });

  it('clips an attack that starts before the span and interpolates its level', () => {
    const stages = adsrStages({ ...ENVELOPE, peak_at_ms: 40, attack_ms: 100 }, 2000);

    expect(stages[0].stage).toBe('attack');
    expect(stages[0].fromMs).toBe(0);
    // 60ms of the 100ms rise is missing, so the visible leg opens at 60%.
    expect(stages[0].fromLevel).toBeCloseTo(0.6, 6);
    expect(stages[0].toLevel).toBe(1);
  });

  it('drops legs that fall past the end of the span', () => {
    const stages = adsrStages(ENVELOPE, 700);

    expect(stages.map((s) => s.stage)).toEqual(['attack', 'decay', 'sustain']);
    expect(stages[2].toMs).toBe(700);
  });

  it('drops a zero-length leg rather than drawing it', () => {
    const stages = adsrStages({ ...ENVELOPE, decay_ms: 0 }, 2000);

    expect(stages.map((s) => s.stage)).toEqual(['attack', 'sustain', 'release']);
    // The step from peak to plateau survives as the gap between the legs.
    expect(stages[0].toLevel).toBe(1);
    expect(stages[1].fromLevel).toBe(0.6);
    expect(stages[1].fromMs).toBe(400);
  });

  it('returns nothing for a span with no duration', () => {
    expect(adsrStages(ENVELOPE, 0)).toEqual([]);
  });
});

// ─── A dragged band cuts the measurement; it never re-fits it ───────────────
// The blob is pinned to the audio: t_ms counts from start_ms, and start_ms is
// where that sound is. So the one thing a resize must not do is scale.

describe('envelopeViewport — the band as a window onto the measurement', () => {
  const data = { start_ms: 46520, duration_ms: 7740 };

  it('fills the box exactly while the band still frames what was measured', () => {
    const vp = envelopeViewport(data, 46.52, 54.26)!;

    expect(vp.exact).toBe(true);
    expect(vp.fromMs).toBe(0);
    expect(vp.toMs).toBe(7740);
    expect(vp.xPct(0)).toBeCloseTo(0, 6);
    expect(vp.xPct(7740)).toBeCloseTo(100, 6);
  });

  it('cuts the tail rather than squeezing it when the end edge comes in', () => {
    // Half the span dragged away. A squeeze would put the 3.87s mark at 100%.
    const vp = envelopeViewport(data, 46.52, 50.39)!;

    expect(vp.toMs).toBeCloseTo(3870, 6);
    // What survives is drawn at the size it always was: the 1.935s mark is
    // still halfway through the surviving half, not a quarter of the way in.
    expect(vp.xPct(1935)).toBeCloseTo(50, 6);
    expect(vp.exact).toBe(false);
  });

  it('cuts the head, and keeps the survivors on the sound they were measured from', () => {
    const vp = envelopeViewport(data, 50.39, 54.26)!;

    expect(vp.fromMs).toBeCloseTo(3870, 6);
    expect(vp.xPct(3870)).toBeCloseTo(0, 6);
    expect(vp.xPct(7740)).toBeCloseTo(100, 6);
  });

  it('leaves unmeasured air when the band is dragged wider, rather than stretching', () => {
    // Band twice the measured length: the measurement occupies its own half.
    const vp = envelopeViewport(data, 46.52, 62.0)!;

    expect(vp.toMs).toBe(7740);
    expect(vp.xPct(7740)).toBeCloseTo(50, 1);
    expect(vp.exact).toBe(false);
  });

  it('reports no overlap once the band has been moved off the audio', () => {
    expect(envelopeViewport(data, 100, 108)).toBeNull();
  });

  it('anchors a blob with no start_ms to the band, and still cuts', () => {
    const legacy = { start_ms: undefined as unknown as number, duration_ms: 4000 };
    const vp = envelopeViewport(legacy, 10, 12)!;

    expect(vp.fromMs).toBe(0);
    expect(vp.toMs).toBe(2000);
    expect(vp.xPct(2000)).toBeCloseTo(100, 6);
  });
});

describe('clipCurve', () => {
  const curve = [
    { t_ms: 0, energy: 0 },
    { t_ms: 1000, energy: 1 },
    { t_ms: 2000, energy: 0.5 },
    { t_ms: 3000, energy: 0 },
  ];

  it('keeps the surviving samples at their own times', () => {
    expect(clipCurve(curve, 0, 2000)).toEqual([
      { t_ms: 0, energy: 0 },
      { t_ms: 1000, energy: 1 },
      { t_ms: 2000, energy: 0.5 },
    ]);
  });

  it('interpolates a point at the cut, so the survivor ends in a clean wall', () => {
    const out = clipCurve(curve, 0, 1500);

    expect(out[out.length - 1]).toEqual({ t_ms: 1500, energy: 0.75 });
  });

  it('cuts both ends of a window that falls inside one segment', () => {
    expect(clipCurve(curve, 1250, 1750)).toEqual([
      { t_ms: 1250, energy: 0.875 },
      { t_ms: 1750, energy: 0.625 },
    ]);
  });

  it('returns nothing when the window is off the curve', () => {
    expect(clipCurve(curve, 5000, 6000)).toEqual([]);
  });
});

describe('adsrStages under a window', () => {
  const env: EnvelopeExport = {
    shape: 'sustained',
    attack_ms: 200,
    decay_ms: 300,
    sustain_ms: 1000,
    release_ms: 500,
    sustain_level: 0.5,
    peak_at_ms: 200,
    peak_rms: 0.2,
  };

  it('drops the legs the band no longer covers and cuts the one it crosses', () => {
    const full = adsrStages(env, 2000);
    const cut = adsrStages(env, 2000, { fromMs: 0, toMs: 700 });

    expect(full.map((s) => s.stage)).toEqual(['attack', 'decay', 'sustain', 'release']);
    expect(cut.map((s) => s.stage)).toEqual(['attack', 'decay', 'sustain']);
    // The sustain that survives is the part inside the band, at its own level.
    expect(cut[2].toMs).toBe(700);
    expect(cut[2].toLevel).toBeCloseTo(0.5, 6);
  });

  it('leaves the stages alone when the window is the whole span', () => {
    expect(adsrStages(env, 2000, { fromMs: 0, toMs: 2000 })).toEqual(adsrStages(env, 2000));
  });
});

describe('envelopeCoverageNote', () => {
  const data = { start_ms: 46520, duration_ms: 7740 };

  it('says nothing while the band matches', () => {
    expect(envelopeCoverageNote(data, 46.52, 54.26)).toBeNull();
  });

  it('says how much survives a trim', () => {
    expect(envelopeCoverageNote(data, 46.52, 50.39))
      .toBe('showing 3.9s of the 7.7s measured at 46.5s–54.3s');
  });

  it('says where the measurement went when the band was moved off it', () => {
    expect(envelopeCoverageNote(data, 100, 108)).toBe('measurement is at 46.5s–54.3s, outside this band');
  });
});

describe('a span straight out of the ⚡ export never reads as trimmed', () => {
  // The numbers a real export produced: the blob rounds start, end and
  // duration separately, so end_ms - start_ms is 13287 while duration_ms is
  // 13286. Before the epsilon was applied to rounded differences, that 1ms
  // (plus float dust from seconds→ms) made every new span announce a trim it
  // had not had.
  const data = { start_ms: 120107, duration_ms: 13286 };

  it('is exact at the bounds the save path gives the item', () => {
    const vp = envelopeViewport(data, 120.107, 133.394)!;

    expect(vp.exact).toBe(true);
    expect(vp.toMs).toBe(13286);
    expect(envelopeCoverageNote(data, 120.107, 133.394)).toBeNull();
  });

  it('still notices a trim a hand could actually aim at', () => {
    expect(envelopeViewport(data, 120.107, 133.294)!.exact).toBe(false);
  });
});
