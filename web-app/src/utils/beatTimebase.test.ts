import { describe, it, expect } from 'vitest';
import { beatToTime, gridOf, stampBeat, withStampedBeats } from './beatAnchoring';
import {
  layersGridOf, tempoMapBeat, tempoMapTime, toStoredLayers, withSecondsFromBeats, withSongGrid,
} from './beatTimebase';
import type { AnnotationLayer, AnnotationLayersDocument } from '../types/annotationLayer';
import type { SongInfo } from '../types/songInfo';

const song = (over: Partial<SongInfo> = {}): SongInfo => ({
  id: 's', bpm: 128, gridOffset: 0.137, timeSignature: '4/4', ...over,
} as SongInfo);

// 128 BPM: a beat is 0.46875 s, so 1/8 of one is 0.05859375 s — never a whole
// millisecond, which is exactly what makes a stored second lose the fraction.
const LOCKED = song({ annotatorGridMode: true });
const G = gridOf(LOCKED)!;
const at = (beat: number) => beatToTime(beat, G);

const layer = (type: AnnotationLayer['type'], items: unknown[]): AnnotationLayer =>
  ({ id: `l-${type}`, name: type, type, color: '#fff', visible: true, snap: 'beat', items } as unknown as AnnotationLayer);

const doc = (): AnnotationLayersDocument => ({
  song: 's',
  annotated_at: '2026-11-11T00:00:00.000Z',
  layers: [
    layer('boundaries', [{ id: 'b1', time: at(0), label: 'intro', type: 'intro' }]),
    layer('cues', [
      { id: 'c1', time: at(12.375), label: '1/8 beat' },              // 13th beat, 3rd 32nd
      { id: 'c2', time: at(5 + 1 / 3), label: 'triplet', candidates: [at(5.5)] },
    ]),
    layer('spans', [{ id: 's1', start: at(16.25), end: at(20 + 5 / 6), label: 'build' }]),
    layer('lyrics', [{ id: 'w1', time: 3.21, end: 3.5, text: 'hey', kind: 'word' }]),
  ],
});

const items = (d: AnnotationLayersDocument, type: string) =>
  d.layers.find((l) => l.type === type)!.items as unknown as Record<string, unknown>[];

const saved = (info: SongInfo) =>
  toStoredLayers(withSongGrid(withStampedBeats(doc(), gridOf(info)), info));

describe('beat stamps are the grid fraction, not a float near it', () => {
  it('lands 1/8-beat and triplet marks exactly, from millisecond times', () => {
    expect(stampBeat(at(12.375), G)).toBe(12.375);
    expect(stampBeat(at(5 + 1 / 3), G)).toBe(Math.round((5 + 1 / 3) * 24) / 24);
    expect(stampBeat(at(20 + 5 / 6), G)).toBe(Math.round((20 + 5 / 6) * 24) / 24);
  });

  it('leaves a mark that is off the grid where it really is', () => {
    const b = stampBeat(at(7) + 0.017, G);       // a tapped hit, 17 ms late
    expect(b).not.toBe(Math.round(b * 24) / 24);
    expect(Math.abs(b - (at(7) + 0.017 - 0.137) / 0.46875)).toBeLessThan(1e-5);
  });
});

describe('Grid Lock saves beats only', () => {
  it('stores no seconds for a stamped item, and the grid it was counted on', () => {
    const d = saved(LOCKED);
    expect(d.timebase).toBe('beats');
    expect(d.grid).toMatchObject({ bpm: 128, gridOffset: 0.137, timeSignature: '4/4', beatsPerBar: 4 });
    expect(d.grid!.tempoMap).toEqual([{ beat: 0, time: 0.137, bpm: 128 }]);
    const [c1, c2] = items(d, 'cues');
    expect(c1).toEqual({ id: 'c1', beat: 12.375, label: '1/8 beat' });
    expect(c2.time).toBeUndefined();
    expect(c2.candidates).toEqual([5.5]);
    const [s1] = items(d, 'spans');
    expect(s1.start).toBeUndefined();
    expect(s1.end).toBeUndefined();
    expect(s1.startBeat).toBe(16.25);
    expect(items(d, 'boundaries')[0]).toMatchObject({ beat: 0 });
    expect(items(d, 'boundaries')[0].time).toBeUndefined();
  });

  it('keeps lyrics in seconds — a sung word is timed to the voice', () => {
    expect(items(saved(LOCKED), 'lyrics')[0]).toMatchObject({ time: 3.21, end: 3.5 });
  });

  it('reads back to the seconds it was saved from', () => {
    const back = withSecondsFromBeats(saved(LOCKED));
    const orig = doc();
    for (const type of ['boundaries', 'cues', 'spans', 'lyrics']) {
      items(orig, type).forEach((o, i) => {
        const b = items(back, type)[i];
        for (const k of ['time', 'start', 'end']) {
          if (typeof o[k] === 'number') expect(Math.abs((b[k] as number) - (o[k] as number))).toBeLessThanOrEqual(0.001);
        }
      });
    }
    expect(Math.abs((items(back, 'cues')[1].candidates as number[])[0] - at(5.5))).toBeLessThanOrEqual(0.001);
    // The beats it carries in memory are the stored ones, untouched.
    expect(items(back, 'cues')[0].beat).toBe(12.375);
  });

  it('re-saving what it read writes the same file', () => {
    const once = saved(LOCKED);
    expect(toStoredLayers(withSecondsFromBeats(once))).toEqual(once);
  });

  it('places beats on the song as it is NOW when the reader knows it', () => {
    const moved = gridOf(song({ bpm: 130, gridOffset: 0.2 }))!;
    const back = withSecondsFromBeats(saved(LOCKED), moved);
    expect(items(back, 'cues')[0].time).toBe(beatToTime(12.375, moved));
  });
});

describe('Grid Lock off', () => {
  it('stores seconds, with the beat beside them and the grid recorded', () => {
    const d = saved(song());
    expect(d.timebase).toBeUndefined();
    expect(d.grid?.bpm).toBe(128);
    expect(items(d, 'cues')[0]).toMatchObject({ time: at(12.375), beat: 12.375 });
    expect(withSecondsFromBeats(d)).toBe(d);
  });

  it('a song with no grid stores no grid and no beats', () => {
    const d = saved(song({ bpm: 0, annotatorGridMode: true }));
    expect(d.grid).toBeUndefined();
    expect(d.timebase).toBeUndefined();
  });
});

describe('a file someone else wrote', () => {
  it('trusts seconds a seconds-only tool wrote into a beats file', () => {
    const d = saved(LOCKED);
    const cue = items(d, 'cues')[0];
    delete cue.beat;
    cue.time = at(14.5);                     // an external tool moved it, beat dropped
    items(d, 'cues')[1].time = at(6);        // …or moved it and left a stale beat
    const back = withSecondsFromBeats(d);
    expect(items(back, 'cues')[0].time).toBe(at(14.5));
    expect(items(back, 'cues')[1]).toMatchObject({ time: at(6), beat: 6 });
  });

  it('refuses a beats file with no grid rather than placing marks nowhere', () => {
    const d = saved(LOCKED);
    delete d.grid;
    expect(() => withSecondsFromBeats(d)).toThrow(/no grid/);
    expect(toStoredLayers(d).timebase).toBeUndefined();
  });
});

describe('a song split into tempo segments', () => {
  const split = song({
    gridMode: 'mapped', annotatorGridMode: true,
    gridSegments: [{ id: 'gs_a', start: 30.137, bpm: 140, timeSignature: '4/4' }],
  });
  const g = gridOf(split)!;

  it('records one tempo-map entry per segment, and reads beats as the app does', () => {
    const grid = layersGridOf(split)!;
    expect(grid.tempoMap.length).toBe(2);
    expect(grid.tempoMap[1]).toMatchObject({ time: 30.137, bpm: 140 });
    for (const b of [-2, 0, 10.5, 63.875, 64, 64.125, 100 + 1 / 3]) {
      expect(tempoMapTime(grid, b)).toBe(Math.max(-Infinity, beatToTime(b, g)));
      expect(tempoMapBeat(grid, beatToTime(b, g))).toBe(stampBeat(beatToTime(b, g), g));
    }
  });
});
