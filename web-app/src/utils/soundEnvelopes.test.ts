import { describe, expect, it } from 'vitest';
import type { AnnotationLayer, AnnotationLayersDocument, SoundEnvelope } from '../types/annotationLayer';
import {
  adsrToSoundEnvelope, applyMeasuredEnvelopes, dropRetimedEnvelopes, envelopeTargets, extractEnvelopes, measurableWords,
} from './soundEnvelopes';

const ENV: SoundEnvelope = { start: 0.9, peak: 1.1, decayEnd: 1.1, release: 2.6, end: 2.9, peakDb: -16, sustainDb: -2 };

function lane(items: AnnotationLayer<'lyrics'>['items'], id = 'L'): AnnotationLayer<'lyrics'> {
  return { id, name: 'Lyrics', type: 'lyrics', visible: true, color: '#fff', items } as AnnotationLayer<'lyrics'>;
}
function doc(...layers: AnnotationLayer[]): AnnotationLayersDocument {
  return { version: 1, layers } as unknown as AnnotationLayersDocument;
}
const nights = { id: 'n', time: 1, end: 2.8, text: 'nights', kind: 'word' as const, envelope: ENV };
const like = { id: 'k', time: 2.8, end: 3.1, text: 'like', kind: 'word' as const };

describe('dropRetimedEnvelopes', () => {
  it('deletes the envelope of a word whose start or end moved, and keeps the rest', () => {
    const prev = doc(lane([nights, like]));
    for (const moved of [{ ...nights, end: 2.5 }, { ...nights, time: 1.2 }]) {
      const got = dropRetimedEnvelopes(prev, doc(lane([moved, like])))!;
      const word = (got.layers[0] as AnnotationLayer<'lyrics'>).items[0];
      expect(word.envelope).toBeUndefined();
      expect(word.end).toBe(moved.end);
    }
  });

  it('follows a word moved into another lane', () => {
    const prev = doc(lane([nights]), lane([], 'M'));
    const got = dropRetimedEnvelopes(prev, doc(lane([]), lane([{ ...nights, time: 4, end: 5.8 }], 'M')))!;
    expect((got.layers[1] as AnnotationLayer<'lyrics'>).items[0].envelope).toBeUndefined();
  });

  it('leaves an edit that does not retime, or that sets the envelope itself, as it is', () => {
    const prev = doc(lane([nights, like]));
    const renamed = doc(lane([{ ...nights, text: 'knights' }, like]));
    expect(dropRetimedEnvelopes(prev, renamed)).toBe(renamed);
    const remeasured = doc(lane([{ ...nights, end: 2.5, envelope: { ...ENV, release: 2.3 } }, like]));
    expect(dropRetimedEnvelopes(prev, remeasured)).toBe(remeasured);
    // An undo back to the measured word brings its envelope back.
    const retimed = doc(lane([{ id: 'n', time: 1, end: 2.5, text: 'nights', kind: 'word' }, like]));
    expect(dropRetimedEnvelopes(retimed, prev)).toBe(prev);
  });
});

describe('measure held notes on a lane', () => {
  it('sends the timed words, and the lines with no word inside them', () => {
    const l = lane([nights, like, { id: 'x', time: 5, text: 'unended', kind: 'word' },
      { id: 'line', time: 1, end: 3.1, text: 'nights like', kind: 'line' },
      { id: 'aah', time: 7.7, end: 9.9, text: 'אהההההה', kind: 'line' },
      { id: 'blank', time: 12, end: 13, text: ' ', kind: 'line' }]);
    expect(measurableWords(l)).toEqual([
      { id: 'n', time: 1, end: 2.8 }, { id: 'k', time: 2.8, end: 3.1 }, { id: 'aah', time: 7.7, end: 9.9 }]);
  });

  it('gives held words their envelope and takes it from words that are not held', () => {
    const held = { id: 'h', time: 4, end: 6, text: 'days', kind: 'word' as const };
    const l = lane([nights, like, held]);
    const sent = measurableWords(l);
    const got = applyMeasuredEnvelopes(l, sent, { n: null, k: null, h: ENV });
    expect(got.items.map((it) => it.envelope)).toEqual([undefined, undefined, ENV]);
  });

  it('a stem that does not hold the sound keeps a reading made off another source', () => {
    const drums = { ...ENV, source: 'drums' as const };
    const l = lane([{ ...like, envelope: drums }]);
    const sent = measurableWords(l);
    expect(applyMeasuredEnvelopes(l, sent, { k: null }, 'mix')).toBe(l);
    expect(applyMeasuredEnvelopes(l, sent, { k: null }, 'drums').items[0].envelope).toBeUndefined();
  });

  it('leaves a word retimed while the measurement ran without one', () => {
    const l = lane([{ ...like, end: 4 }]);
    const got = applyMeasuredEnvelopes(l, [{ id: 'k', time: 2.8, end: 3.1 }], { k: ENV });
    expect(got).toBe(l);
  });
});

function spans(items: AnnotationLayer<'spans'>['items'], id = 'S'): AnnotationLayer<'spans'> {
  return { id, name: 'Pads', type: 'spans', visible: true, color: '#fff', items } as AnnotationLayer<'spans'>;
}
const pad = { id: 'p', start: 1, end: 2.8, label: 'pad', envelope: ENV };

describe('spans carry envelopes by the same rules', () => {
  it('deletes the envelope of a retimed span, keeps it on a relabel', () => {
    const prev = doc(spans([pad]));
    const got = dropRetimedEnvelopes(prev, doc(spans([{ ...pad, end: 2.4 }])))!;
    expect((got.layers[0] as AnnotationLayer<'spans'>).items[0].envelope).toBeUndefined();
    const renamed = doc(spans([{ ...pad, label: 'strings' }]));
    expect(dropRetimedEnvelopes(prev, renamed)).toBe(renamed);
  });

  it('reports each envelope a retime clears, with the source it was read off', () => {
    const read = { ...pad, envelope: { ...ENV, source: 'drums' as const } };
    const heard: unknown[] = [];
    dropRetimedEnvelopes(doc(spans([read])), doc(spans([{ ...read, start: 1.5 }])), (d) => heard.push(d));
    expect(heard).toEqual([{ layerId: 'S', itemId: 'p', source: 'drums' }]);
  });

  it('sends every timed span but an Energy one, or the one item asked for', () => {
    const energy = { id: 'e', start: 4, end: 6, label: 'Energy', description: JSON.stringify({
      type: 'energy_span', duration_ms: 2000, curve: [{ t_ms: 0, energy: 1 }] }) };
    const l = spans([pad, energy, { id: 'q', start: 7, end: 9, label: 'q' }]);
    expect(envelopeTargets(l).map((w) => w.id)).toEqual(['p', 'q']);
    expect(envelopeTargets(l, 'q')).toEqual([{ id: 'q', time: 7, end: 9 }]);
    // One lyric line over words: the lane leaves it out, its own card sends it.
    const lyr = lane([nights, { id: 'line', time: 1, end: 3.1, text: 'nights like', kind: 'line' }]);
    expect(envelopeTargets(lyr).map((w) => w.id)).toEqual(['n']);
    expect(envelopeTargets(lyr, 'line')).toEqual([{ id: 'line', time: 1, end: 3.1 }]);
  });

  it('applies a measurement to a span lane', () => {
    const l = spans([{ id: 'q', start: 7, end: 9, label: 'q' }]);
    const got = applyMeasuredEnvelopes(l, envelopeTargets(l), { q: ENV });
    expect(got.items[0].envelope).toBe(ENV);
  });
});

describe('extracting an envelope in the browser', () => {
  it('lays the span-relative reading onto the song', () => {
    const env = adsrToSoundEnvelope({
      attackMs: 100, decayMs: 200, sustainMs: 1000, releaseMs: 300,
      sustainLevel: 0.5, peakAtMs: 150, peakRms: 0.5, shape: 'sustained',
    }, 10);
    expect(env).toEqual({ start: 10.05, peak: 10.15, decayEnd: 10.35, release: 11.35, end: 11.65, peakDb: -6, sustainDb: -6 });
  });

  it('reads one swell-and-fade, and the outer shape of a run of hits', () => {
    const rate = 44100;
    const tone = (gain: (t: number) => number, sec: number) => {
      const data = new Float32Array(rate * sec);
      for (let i = 0; i < data.length; i++) data[i] = gain(i / rate) * Math.sin(2 * Math.PI * 220 * i / rate);
      return { sampleRate: rate, duration: sec, numberOfChannels: 1, length: data.length, getChannelData: () => data } as unknown as AudioBuffer;
    };
    // Up over 0.2 s, held to 1.5 s, down to silence by 2 s.
    const one = tone((t) => (t < 0.2 ? t / 0.2 : t < 1.5 ? 1 : Math.max(0, 1 - (t - 1.5) / 0.5)), 2);
    const got = extractEnvelopes(one, [{ id: 'a', time: 0, end: 2 }]).a!;
    expect(got.peak).toBeGreaterThan(0.1);
    expect(got.peak).toBeLessThan(1.6);
    expect(got.end).toBeLessThanOrEqual(2);
    expect(got.peakDb).toBeLessThan(0);
    // Two separate hits, silence between.
    const hit = (u: number) => (u < 0 ? 0 : u < 0.02 ? u / 0.02 : Math.max(0, 1 - (u - 0.02) / 0.2));
    const two = tone((t) => hit((t % 1) - 0.3), 2);
    const outer = extractEnvelopes(two, [{ id: 'b', time: 0, end: 2 }]).b!;
    expect(outer.peaks).toBe(2);
    // Opens on the first hit, closes after the last — not stretched past either.
    expect(outer.start).toBeGreaterThanOrEqual(0.25);
    expect(outer.start).toBeLessThan(0.35);
    expect(outer.end).toBeGreaterThan(1.3);
    expect(outer.end).toBeLessThanOrEqual(2);
    expect(got.peaks).toBeUndefined();
  });
});
