import { describe, expect, it } from 'vitest';
import type { SongInfo } from '../../types/songInfo';
import { metronomeBeatsInRange, metronomeGridSignature } from './MetronomePanel';

/** The click-track grid resolver, tested against the shape of song-info that
 *  actually shipped a wrong click: a Static song still carrying grid data a
 *  previous pass in another mode left behind. Whatever is parked on disk must
 *  place no clicks, or the woodblock disagrees with the lines drawn beside it.
 *
 *  The fixture is `data/song-info/bruce_adler_arabian_nights.json` (Aladdin —
 *  Arabian Nights) trimmed to the grid fields. Its saved BPM is 64.75 while
 *  the parked map runs at ~129 — exactly double. */
const PARKED_MAP = [
  { id: 'gs_a', start: 10, bpm: 129.19921875, timeSignature: '4/4' },
];

function aladdin(overrides: Partial<SongInfo> = {}): SongInfo {
  return {
    song: 'bruce_adler_arabian_nights',
    bpm: 64.75,
    gridOffset: 0.406,
    timeSignature: '4/4',
    gridMode: 'static',
    gridSegments: PARKED_MAP,
    beatOverrides: { '4': 2.045702449972776, '5': 2.5678003796043223 },
    ...overrides,
  } as SongInfo;
}

/** Mean gap between consecutive clicks, as a BPM. */
function clickBpm(beats: Array<{ t: number }>): number {
  expect(beats.length).toBeGreaterThan(2);
  const span = beats[beats.length - 1].t - beats[0].t;
  return 60 / (span / (beats.length - 1));
}

describe('metronomeBeatsInRange', () => {
  it('clicks the static BPM, ignoring a map left parked on disk', () => {
    const beats = metronomeBeatsInRange(aladdin(), 0, 20);
    expect(clickBpm(beats)).toBeCloseTo(64.75, 4);
  });

  it('lands on the same times the static grid draws', () => {
    const info = aladdin();
    const beats = metronomeBeatsInRange(info, 0, 10);
    const dBeat = 60 / 64.75;
    for (const b of beats) {
      const k = Math.round((b.t - 0.406) / dBeat);
      expect(b.t).toBeCloseTo(0.406 + k * dBeat, 6);
    }
  });

  it('ignores per-beat overrides outside Manual mode', () => {
    const beats = metronomeBeatsInRange(aladdin(), 0, 6);
    expect(beats.map((b) => b.t)).not.toContain(2.045702449972776);
  });

  it('follows the map in Mapped mode', () => {
    const beats = metronomeBeatsInRange(aladdin({ gridMode: 'mapped' }), 10.1, 20);
    expect(clickBpm(beats)).toBeCloseTo(129.19921875, 2);
  });

  it('ignores the map in Manual mode on a Static base, but keeps the overrides', () => {
    const info = aladdin({ gridMode: 'manual', manualBaseGridMode: 'static' });
    const beats = metronomeBeatsInRange(info, 0, 20);
    expect(clickBpm(beats)).toBeCloseTo(64.75, 1);
    expect(beats.map((b) => b.t)).toContain(2.045702449972776);
  });

  it('follows the map in Manual mode on a Mapped base', () => {
    const info = aladdin({ gridMode: 'manual', manualBaseGridMode: 'mapped' });
    const beats = metronomeBeatsInRange(info, 10.1, 20);
    expect(clickBpm(beats)).toBeCloseTo(129.19921875, 2);
  });

  it('accents every fourth beat in 4/4', () => {
    const beats = metronomeBeatsInRange(aladdin(), 0.406, 10);
    const downbeats = beats.filter((b) => b.isDownbeat);
    expect(downbeats.length).toBeGreaterThan(0);
    for (let i = 1; i < downbeats.length; i++) {
      expect(downbeats[i].t - downbeats[i - 1].t).toBeCloseTo(4 * (60 / 64.75), 6);
    }
  });
});

/** The signature is what tells the panel a grid changed under a playing click,
 *  so anything that moves a woodblock has to move it — and anything that does
 *  not must leave it alone, or every re-render would cancel the queue and the
 *  click would stutter. */
describe('metronomeGridSignature', () => {
  const sig = (i: SongInfo, tap: number | null = null) => metronomeGridSignature(i, tap);

  it('changes when the tempo type is switched', () => {
    expect(sig(aladdin())).not.toBe(sig(aladdin({ gridMode: 'mapped' })));
  });

  it('changes when the steady BPM is nudged', () => {
    expect(sig(aladdin())).not.toBe(sig(aladdin({ bpm: 64.8 })));
  });

  it('changes when the grid offset is dragged', () => {
    expect(sig(aladdin())).not.toBe(sig(aladdin({ gridOffset: 0.5 })));
  });

  it('changes when the time signature is changed', () => {
    expect(sig(aladdin())).not.toBe(sig(aladdin({ timeSignature: '3/4' })));
  });

  it('changes when a segment is edited in a mode that uses the map', () => {
    const a = aladdin({ gridMode: 'mapped' });
    const b = aladdin({
      gridMode: 'mapped',
      gridSegments: [{ ...PARKED_MAP[0], bpm: 130 }],
    });
    expect(sig(a)).not.toBe(sig(b));
  });

  it('changes when a beat is pinned in Manual mode', () => {
    const a = aladdin({ gridMode: 'manual', manualBaseGridMode: 'static' });
    const b = aladdin({
      gridMode: 'manual',
      manualBaseGridMode: 'static',
      beatOverrides: { ...a.beatOverrides, '9': 8.5 },
    });
    expect(sig(a)).not.toBe(sig(b));
  });

  it('changes when the Manual base grid is switched', () => {
    const a = aladdin({ gridMode: 'manual', manualBaseGridMode: 'static' });
    const b = aladdin({ gridMode: 'manual', manualBaseGridMode: 'mapped' });
    expect(sig(a)).not.toBe(sig(b));
  });

  it('changes when a tempo is tapped, and again when it is cleared', () => {
    expect(sig(aladdin())).not.toBe(sig(aladdin(), 90));
    expect(sig(aladdin(), 90)).not.toBe(sig(aladdin(), 91));
    expect(sig(aladdin(), null)).toBe(sig(aladdin()));
  });

  it('is stable across a re-render that rebuilds an identical SongInfo', () => {
    expect(sig(aladdin())).toBe(sig(aladdin()));
  });

  it('ignores edits the active mode does not use', () => {
    // Static ignores the map, so editing a parked segment must NOT interrupt a
    // correct click — the same rule that fixed the doubled woodblock.
    const edited = aladdin({ gridSegments: [{ ...PARKED_MAP[0], bpm: 200 }] });
    expect(sig(aladdin())).toBe(sig(edited));
    // Ditto pinned beats outside Manual mode.
    expect(sig(aladdin())).toBe(sig(aladdin({ beatOverrides: { '4': 99 } })));
  });

  it('ignores metadata that cannot move a click', () => {
    expect(sig(aladdin())).toBe(sig(aladdin({ updated_at: '2030-01-01T00:00:00.000Z' } as Partial<SongInfo>)));
  });
});
