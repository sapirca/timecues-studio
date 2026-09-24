import { describe, it, expect } from 'vitest';
import {
  gridOf,
  gridSignature,
  timeToBeat,
  beatToTime,
  withStampedBeats,
  withClearedBeatStamps,
  retimedDocument,
  countRetimed,
  describeGridChange,
  withTimesFromBeats,
  countStaleTimes,
  withFoldedGridOffset,
  withShiftedBeatStamps,
} from './beatAnchoring';
import type { AnnotationLayer, AnnotationLayersDocument } from '../types/annotationLayer';
import type { SongInfo } from '../types/songInfo';

const song = (over: Partial<SongInfo> = {}): SongInfo => ({
  id: 's', bpm: 120, gridOffset: 0, timeSignature: '4/4', ...over,
} as SongInfo);

// 120 BPM 4/4, no offset → one beat = 0.5s, one bar = 2s.
const G120 = gridOf(song())!;
// 60 BPM → one beat = 1s. Every musical position lands at twice the seconds.
const G60 = gridOf(song({ bpm: 60 }))!;

const doc = (): AnnotationLayersDocument => ({
  song: 's',
  annotated_at: '',
  layers: [
    {
      id: 'c', name: 'Cues 1', type: 'cues', visible: true, color: '#0ff', snap: 'beat',
      items: [{ id: 'c1', time: 2, label: 'kick', candidates: [2.5] }],
    },
    {
      id: 'p', name: 'Spans 1', type: 'spans', visible: true, color: '#f0f', snap: 'bar',
      items: [{ id: 's1', start: 2, end: 6, label: 'verse' }],
    },
    {
      id: 'l', name: 'Lyrics 1', type: 'lyrics', visible: true, color: '#ff0', snap: 'off',
      items: [{ id: 'w1', time: 2, text: 'oh', kind: 'word' }],
    },
    {
      id: 'b', name: 'Boundaries 1', type: 'boundaries', visible: true, color: '#a78bfa', snap: 'bar',
      items: [
        { id: 'b1', time: 0, type: 'intro', label: 'Intro' },
        { id: 'b2', time: 4, type: 'drop', label: 'Drop', candidates: [4.25] },
      ],
    },
  ],
} as unknown as AnnotationLayersDocument);

/** The boundaries layer out of a document, for the assertions below. */
const boundaries = (d: AnnotationLayersDocument): AnnotationLayer<'boundaries'> =>
  d.layers.find((l) => l.type === 'boundaries') as AnnotationLayer<'boundaries'>;

describe('grid identity', () => {
  it('treats grids that place beats identically as the same', () => {
    expect(gridSignature(song())).toBe(gridSignature(song({ title: 'renamed' } as Partial<SongInfo>)));
  });

  it('separates every grid-defining edit', () => {
    const base = gridSignature(song());
    expect(gridSignature(song({ bpm: 128 }))).not.toBe(base);
    expect(gridSignature(song({ gridOffset: 0.25 }))).not.toBe(base);
    expect(gridSignature(song({ timeSignature: '3/4' }))).not.toBe(base);
    const split = { id: 'gs_a', start: 10, bpm: 90, timeSignature: '4/4' };
    const mapped = song({ gridMode: 'mapped', gridSegments: [split] });
    expect(gridSignature(mapped)).not.toBe(base);
    expect(gridSignature(song({ gridMode: 'mapped', gridSegments: [{ ...split, bpm: 95 }] })))
      .not.toBe(gridSignature(mapped));
  });

  it('ignores splits that are inert — a static song is not re-gridded by a parked map', () => {
    // effectiveGridSegments() returns nothing in static mode, so a parked map
    // places no beats and must not read as a grid change.
    expect(gridSignature(song({ gridSegments: [{ id: 'gs_a', start: 10, bpm: 90, timeSignature: '4/4' }] })))
      .toBe(gridSignature(song()));
  });

  it('has no usable grid below the BPM floor', () => {
    expect(gridOf(song({ bpm: 0 }))).toBeNull();
    expect(gridOf(song({ bpm: 12 }))).toBeNull();
    expect(gridOf(null)).toBeNull();
  });
});

describe('seconds ⇄ beats', () => {
  it('round-trips', () => {
    for (const t of [0, 0.5, 2, 13.842458]) {
      expect(beatToTime(timeToBeat(t, G120), G120)).toBeCloseTo(t, 3);
    }
  });

  it('reads the same instant as a different beat under a different tempo', () => {
    expect(timeToBeat(2, G120)).toBeCloseTo(4, 9);   // 2s = beat 4 at 120
    expect(timeToBeat(2, G60)).toBeCloseTo(2, 9);    // 2s = beat 2 at 60
  });
});

describe('times win — stamping', () => {
  it('stamps points and ranges, and leaves lyrics alone', () => {
    const out = withStampedBeats(doc(), G120);
    const [cues, spans, lyrics] = out.layers;
    expect((cues.items[0] as { beat: number }).beat).toBeCloseTo(4, 9);
    expect((spans.items[0] as { startBeat: number; endBeat: number }).startBeat).toBeCloseTo(4, 9);
    expect((spans.items[0] as { startBeat: number; endBeat: number }).endBeat).toBeCloseTo(12, 9);
    expect(lyrics.items[0]).not.toHaveProperty('beat');
  });

  it('never moves a time', () => {
    const out = withStampedBeats(doc(), G120);
    expect((out.layers[0].items[0] as { time: number }).time).toBe(2);
    expect((out.layers[1].items[0] as { start: number }).start).toBe(2);
  });

  it('is a no-op without a usable grid', () => {
    const d = doc();
    expect(withStampedBeats(d, null)).toBe(d);
  });

  it('stamps boundary items like any other layer', () => {
    expect(boundaries(withStampedBeats(doc(), G120)).items[1].beat).toBeCloseTo(8, 9);
  });
});

// "Keep their milliseconds", the other answer to the grid-moved prompt, taken
// literally: the seconds survive the grid edit untouched, and the beat
// companions go, because a musical position read off a grid the annotator has
// just declined is not worth keeping — and because a stamp left describing the
// OLD grid is precisely what hands the seconds back on the next load.
describe('keeping the milliseconds across a grid change', () => {
  it('holds every second and drops every stamp', () => {
    const stamped = withStampedBeats(doc(), G120);
    const after = withClearedBeatStamps(stamped);

    expect(boundaries(after).items[1].time).toBe(4);
    expect((after.layers[0].items[0] as { time: number }).time).toBe(2);
    expect((after.layers[1].items[0] as { start: number; end: number }).start).toBe(2);
    expect((after.layers[1].items[0] as { start: number; end: number }).end).toBe(6);

    expect(boundaries(after).items[1]).not.toHaveProperty('beat');
    expect(after.layers[0].items[0]).not.toHaveProperty('beat');
    expect(after.layers[1].items[0]).not.toHaveProperty('startBeat');
    expect(after.layers[1].items[0]).not.toHaveProperty('endBeat');
  });

  it('leaves the once-per-load realign nothing to move, under any grid', () => {
    const after = withClearedBeatStamps(withStampedBeats(doc(), G120));
    expect(countStaleTimes(after, G60)).toBe(0);
    expect(withTimesFromBeats(after, G60)).toEqual(after);
  });

  it('would lose those seconds if the stamps were left describing the old grid', () => {
    const stale = withStampedBeats(doc(), G120);
    expect(countStaleTimes(stale, G60)).toBeGreaterThan(0);
    expect(boundaries(withTimesFromBeats(stale, G60)).items[1].time).not.toBe(4);
  });

  it('is a no-op on a document that never carried a stamp', () => {
    const d = doc();
    expect(withClearedBeatStamps(d).layers[0]).toBe(d.layers[0]);
  });

  it('re-stamps from the kept seconds on the next save, agreeing with them', () => {
    // The stamps come back — that is not the old stamp returning. Derived from
    // the seconds that were kept, they describe where the marks are, so the
    // realign still has nothing to do.
    const saved = withStampedBeats(withClearedBeatStamps(withStampedBeats(doc(), G120)), G60);
    expect(boundaries(saved).items[1].time).toBe(4);
    expect(boundaries(saved).items[1].beat).toBeCloseTo(4, 9);   // 4s at 60 BPM
    expect(countStaleTimes(saved, G60)).toBe(0);
  });
});

describe('beats win — re-timing', () => {
  it('moves times so the musical position survives a tempo change', () => {
    // Halving the tempo doubles every beat's time: beat 4 moves 2s → 4s.
    const out = retimedDocument(withStampedBeats(doc(), G120), G120, G60);
    expect((out.layers[0].items[0] as { time: number }).time).toBeCloseTo(4, 6);
    expect((out.layers[1].items[0] as { start: number; end: number }).start).toBeCloseTo(4, 6);
    expect((out.layers[1].items[0] as { start: number; end: number }).end).toBeCloseTo(12, 6);
  });

  it('re-stamps the beat to the new grid, leaving the musical position fixed', () => {
    const out = retimedDocument(withStampedBeats(doc(), G120), G120, G60);
    expect((out.layers[0].items[0] as { beat: number }).beat).toBeCloseTo(4, 6);
  });

  it('carries candidates along', () => {
    const out = retimedDocument(doc(), G120, G60);
    expect((out.layers[0].items[0] as { candidates: number[] }).candidates[0]).toBeCloseTo(5, 6);
  });

  it('leaves lyrics where they are', () => {
    const out = retimedDocument(doc(), G120, G60);
    expect((out.layers[2].items[0] as { time: number }).time).toBe(2);
  });

  it('follows a grid-offset shift', () => {
    const shifted = gridOf(song({ gridOffset: 0.25 }))!;
    const out = retimedDocument(doc(), G120, shifted);
    expect((out.layers[0].items[0] as { time: number }).time).toBeCloseTo(2.25, 6);
  });

  it('never inverts an interval', () => {
    const out = retimedDocument(doc(), G120, G60);
    const span = out.layers[1].items[0] as { start: number; end: number };
    expect(span.end).toBeGreaterThanOrEqual(span.start);
  });

  it('clamps to zero rather than going negative', () => {
    const later = gridOf(song({ gridOffset: 10 }))!;
    const out = boundaries(retimedDocument(doc(), later, G120));
    expect(out.items[0].time).toBeGreaterThanOrEqual(0);
  });

  it('re-times boundary items and their candidates', () => {
    const out = boundaries(retimedDocument(doc(), G120, G60));
    expect(out.items[1].time).toBeCloseTo(8, 6);
    expect(out.items[1].candidates![0]).toBeCloseTo(8.5, 6);
  });
});

describe('counting what would move', () => {
  it('counts items, not timestamps, and ignores lyrics', () => {
    // cue + span + one boundary move; the lyric is exempt, and the boundary
    // sitting on the origin does not move.
    expect(countRetimed(doc(), G120, G60)).toBe(3);
  });

  it('is zero when the grid did not really change', () => {
    expect(countRetimed(doc(), G120, G120)).toBe(0);
  });
});

describe('describing what changed', () => {
  const sig = (o: Partial<SongInfo>) => gridSignature(song(o));

  it('names a tempo edit with both values', () => {
    expect(describeGridChange(sig({}), sig({ bpm: 128 }))).toBe('BPM 120 → 128');
  });

  it('gives the offset shift a direction', () => {
    expect(describeGridChange(sig({}), sig({ gridOffset: 0.25 }))).toBe('Grid offset moved +0.250s');
    expect(describeGridChange(sig({ gridOffset: 0.25 }), sig({}))).toBe('Grid offset moved -0.250s');
  });

  it('names a meter change', () => {
    expect(describeGridChange(sig({}), sig({ timeSignature: '3/4' })))
      .toBe('Time signature 4/4 → 3/4');
  });

  it('reports splits added vs merely changed', () => {
    const one = sig({ gridMode: 'mapped', gridSegments: [{ id: 'gs_a', start: 10, bpm: 90, timeSignature: '4/4' }] });
    const changed = sig({ gridMode: 'mapped', gridSegments: [{ id: 'gs_a', start: 11, bpm: 90, timeSignature: '4/4' }] });
    const two = sig({
      gridMode: 'mapped',
      gridSegments: [
        { id: 'gs_a', start: 10, bpm: 90, timeSignature: '4/4' },
        { id: 'gs_b', start: 20, bpm: 95, timeSignature: '4/4' },
      ],
    });
    expect(describeGridChange(one, changed)).toBe('A grid segment changed');
    expect(describeGridChange(one, two)).toBe('Grid segments 2 → 3');
  });

  it('combines several edits into one sentence', () => {
    expect(describeGridChange(sig({}), sig({ bpm: 128, gridOffset: 0.5 })))
      .toBe('BPM 120 → 128, grid offset moved +0.500s');
  });
});

describe('beats win from the stored stamp (the Grid Lock rule)', () => {
  it('re-derives times from the saved beat against the current grid', () => {
    // Stamped at 120 BPM (beat 4 = 2s), then the song is re-gridded to 60 BPM
    // in another session. Beat 4 is now 4s, and that is where the marker goes.
    const stamped = withStampedBeats(doc(), G120);
    const out = withTimesFromBeats(stamped, G60);
    expect((out.layers[0].items[0] as { time: number }).time).toBeCloseTo(4, 6);
    expect((out.layers[1].items[0] as { start: number; end: number }).start).toBeCloseTo(4, 6);
    expect((out.layers[1].items[0] as { start: number; end: number }).end).toBeCloseTo(12, 6);
  });

  it('leaves un-stamped items alone — a missing beat is not beat zero', () => {
    const out = withTimesFromBeats(doc(), G60);   // never stamped
    expect((out.layers[0].items[0] as { time: number }).time).toBe(2);
    expect((out.layers[1].items[0] as { start: number }).start).toBe(2);
  });

  it('is a no-op when the grid has not moved', () => {
    const stamped = withStampedBeats(doc(), G120);
    const out = withTimesFromBeats(stamped, G120);
    expect((out.layers[0].items[0] as { time: number }).time).toBeCloseTo(2, 6);
  });

  it('never inverts an interval', () => {
    const out = withTimesFromBeats(withStampedBeats(doc(), G120), G60);
    const span = out.layers[1].items[0] as { start: number; end: number };
    expect(span.end).toBeGreaterThanOrEqual(span.start);
  });

  it('re-derives boundary times too', () => {
    const stamped = withStampedBeats(doc(), G120);
    expect(boundaries(withTimesFromBeats(stamped, G60)).items[1].time).toBeCloseTo(8, 6);
  });

  it('counts how far the song has drifted from its musical intent', () => {
    const stamped = withStampedBeats(doc(), G120);
    // Same grid — the coordinates agree.
    expect(countStaleTimes(stamped, G120)).toBe(0);
    // Re-gridded elsewhere — cue + span drift; lyrics never count; the
    // boundary on the origin stays put, the one at 4s drifts.
    expect(countStaleTimes(stamped, G60)).toBe(3);
  });

  it('counts nothing when there are no stamps to compare against', () => {
    expect(countStaleTimes(doc(), G60)).toBe(0);
  });
});

describe('a stale stamp beats a stale grid', () => {
  it('honours the saved beat over the old grid when the two disagree', () => {
    // The stamp says beat 8 while the time says beat 4 — what happens when a
    // grid edit landed in another session after this item was written. Under
    // the Grid Lock rule the stamp is the truth: beat 8 at 60 BPM = 8s.
    const d = doc();
    (d.layers[0].items[0] as unknown as { beat: number }).beat = 8;
    const out = retimedDocument(d, G120, G60);
    expect((out.layers[0].items[0] as { time: number }).time).toBeCloseTo(8, 6);
  });

  it('still re-times un-stamped items off the old grid', () => {
    const out = retimedDocument(doc(), G120, G60);
    expect((out.layers[0].items[0] as { time: number }).time).toBeCloseTo(4, 6);
  });
});

describe('folding a whole-bar grid offset', () => {
  // 120 BPM 4/4 → 2s per bar. An offset of 7.5s is 3¾ bars: bar 1 lands
  // deep in the song and everything before it numbers backwards.
  it('folds the offset into the first bar and reports the renumbering', () => {
    const { info, deltaBeats } = withFoldedGridOffset(song({ gridOffset: 7.5 }));
    expect(info.gridOffset).toBeCloseTo(1.5, 9);
    expect(deltaBeats).toBe(12);          // 3 bars × 4 beats
  });

  it('leaves an offset that already sits inside the first bar alone', () => {
    const original = song({ gridOffset: 1.5 });
    const { info, deltaBeats } = withFoldedGridOffset(original);
    expect(info).toBe(original);
    expect(deltaBeats).toBe(0);
  });

  it('holds every beat exactly where it was — the fold is whole bars', () => {
    const before = gridOf(song({ gridOffset: 7.5 }))!;
    const { info } = withFoldedGridOffset(song({ gridOffset: 7.5 }));
    const after = gridOf(info)!;
    for (const t of [0.5, 3.7, 13.933, 27.748]) {
      // Same phase: the beat each time sits on has not moved, only its number.
      expect(timeToBeat(t, after) - timeToBeat(t, before)).toBeCloseTo(12, 9);
    }
  });

  it('numbers a time that used to be negative from the front of the song', () => {
    const { info } = withFoldedGridOffset(song({ gridOffset: 7.5 }));
    expect(timeToBeat(2.0, gridOf(song({ gridOffset: 7.5 }))!)).toBeLessThan(0);
    expect(timeToBeat(2.0, gridOf(info)!)).toBeGreaterThanOrEqual(0);
  });

  it('re-keys the Manual-mode beat overrides onto the new numbering', () => {
    const { info } = withFoldedGridOffset(song({
      gridOffset: 7.5,
      beatOverrides: { '0': 7.5, '-4': 5.4 },
    }));
    expect(info.beatOverrides).toEqual({ '12': 7.5, '8': 5.4 });
  });

  it('does nothing without a usable BPM — there is no bar to fold into', () => {
    const noBpm = song({ bpm: undefined, gridOffset: 7.5 });
    expect(withFoldedGridOffset(noBpm).deltaBeats).toBe(0);
    expect(withFoldedGridOffset(null).info).toBeNull();
  });

  it('shifts every stamp by the same renumbering, leaving times untouched', () => {
    const stamped = withStampedBeats(doc(), G120);
    const shifted = withShiftedBeatStamps(stamped, 12);
    const cue = shifted.layers[0].items[0] as { time: number; beat: number };
    const span = shifted.layers[1].items[0] as { start: number; startBeat: number; endBeat: number };
    expect(cue.time).toBe(2);
    expect(cue.beat).toBe(4 + 12);
    expect(span.start).toBe(2);
    expect(span.startBeat).toBe(4 + 12);
    expect(span.endBeat).toBe(12 + 12);
  });

  it('shifts boundary stamps too, and leaves un-stamped items alone', () => {
    const shifted = boundaries(withShiftedBeatStamps(withStampedBeats(doc(), G120), 12));
    expect(shifted.items[0].beat).toBe(0 + 12);
    expect(withShiftedBeatStamps(doc(), 12).layers[0].items[0]).not.toHaveProperty('beat');
  });

  it('keeps a stale stamp exactly as stale as it was', () => {
    // The fold must not quietly repair (or deepen) a disagreement between an
    // item's time and its saved beat — Grid Lock still has the same call to make.
    const d = doc();
    (d.layers[0].items[0] as unknown as { beat: number }).beat = 8;
    const before = gridOf(song({ gridOffset: 7.5 }))!;
    const { info, deltaBeats } = withFoldedGridOffset(song({ gridOffset: 7.5 }));
    const drift = 8 - timeToBeat(2, before);
    const shifted = withShiftedBeatStamps(d, deltaBeats);
    const item = shifted.layers[0].items[0] as unknown as { beat: number; time: number };
    expect(item.beat - timeToBeat(item.time, gridOf(info)!)).toBeCloseTo(drift, 9);
  });
});
