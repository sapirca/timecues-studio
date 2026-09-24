import { describe, it, expect } from 'vitest';
import {
  resolveGridSegments,
  resolveStoredGridSegments,
  buildResolved,
  segmentAtTime,
  segmentAtBeatIndex,
  segmentBeatTime,
  segmentBeatPosition,
  segmentBarBeat,
  canPlaceSegmentAt,
  canPlaceOriginAt,
  canMoveHeadTo,
  cutPreviewAt,
  snapSegmentHeadTime,
  formatKeptBeats,
  beatOverrideKey,
  readBeatOverride,
  remapBeatOverrides,
  OPENING_SEGMENT_ID,
} from './gridSegments';
import {
  normalizeGridSegments,
  effectiveGridSegments,
  storedGridSegments,
  getGridSegmentCount,
  makeGridSegmentId,
  makeEmptySongInfo,
} from '../types/songInfo';
import type { GridSegment, SongInfo } from '../types/songInfo';

/** The running example from the design: 120 BPM 4/4 from 0.32s, split at
 *  10.07s into 92 BPM 6/8. The first segment holds 19.5 beats, so its fifth
 *  bar keeps 3.5 of its 4 beats. */
function song(overrides: Partial<SongInfo> = {}): SongInfo {
  return {
    ...makeEmptySongInfo('demo'),
    bpm: 120,
    timeSignature: '4/4',
    gridOffset: 0.32,
    // Splits only shape the grid in Mapped mode. Tests that care about the
    // gate set the mode themselves through `overrides`.
    gridMode: 'mapped',
    ...overrides,
  };
}

const SPLIT: GridSegment = { id: 'gs_a', start: 10.07, bpm: 92, timeSignature: '6/8' };

describe('normalizeGridSegments', () => {
  it('sorts, and drops splits at or before the song origin', () => {
    const out = normalizeGridSegments(
      [
        { id: 'b', start: 12, bpm: 100, timeSignature: '4/4' },
        { id: 'a', start: 4, bpm: 90, timeSignature: '3/4' },
        { id: 'early', start: 0.1, bpm: 90, timeSignature: '4/4' },
      ],
      0.32,
    );
    expect(out.map((g) => g.id)).toEqual(['a', 'b']);
  });

  it('collapses heads inside the dedup window, earlier listed wins', () => {
    const out = normalizeGridSegments(
      [
        { id: 'keep', start: 5.0, bpm: 100, timeSignature: '4/4' },
        { id: 'drop', start: 5.01, bpm: 111, timeSignature: '3/4' },
      ],
      0,
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('keep');
  });

  it('drops segments with an unusable tempo', () => {
    const out = normalizeGridSegments(
      [{ id: 'a', start: 5, bpm: 0, timeSignature: '4/4' }],
      0,
    );
    expect(out).toEqual([]);
  });
});

describe('resolveGridSegments', () => {
  it('returns nothing when the song has no tempo yet', () => {
    expect(resolveGridSegments(makeEmptySongInfo('x'))).toEqual([]);
  });

  it('resolves an unsplit song to one open-ended segment', () => {
    const r = resolveGridSegments(song());
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe(OPENING_SEGMENT_ID);
    expect(r[0].start).toBe(0.32);
    expect(r[0].end).toBe(Number.POSITIVE_INFINITY);
    expect(r[0].beatsPerBar).toBe(4);
    expect(r[0].cutBeats).toBe(0);
  });

  it('cuts the outgoing bar exactly where the split lands', () => {
    const r = resolveGridSegments(song({ gridSegments: [SPLIT] }));
    expect(r).toHaveLength(2);
    // 9.75s at 0.5s/beat = 19.5 beats = 4 whole bars + 3.5.
    expect(r[0].cutBeats).toBeCloseTo(3.5, 9);
    expect(r[0].barCount).toBe(5);
    expect(r[0].beatCount).toBe(20);
    expect(r[0].cutBarStart).toBeCloseTo(8.32, 9);
  });

  it('never rounds the split to complete the outgoing bar', () => {
    const r = resolveGridSegments(song({ gridSegments: [SPLIT] }));
    expect(r[1].start).toBe(10.07);
  });

  it('carries the second segment its own tempo and meter', () => {
    const r = resolveGridSegments(song({ gridSegments: [SPLIT] }));
    expect(r[1].bpm).toBe(92);
    expect(r[1].beatsPerBar).toBe(6);
    expect(r[1].beatDur).toBeCloseTo(60 / 92, 9);
  });

  it('keeps bar numbers running across the split, counting the cut bar', () => {
    const r = resolveGridSegments(song({ gridSegments: [SPLIT] }));
    // Bars 1-5 belong to segment 1 (the 5th is cut), so segment 2 opens bar 6.
    expect(r[1].barNumberOffset).toBe(5);
    expect(r[1].beatIndexOffset).toBe(20);
  });

  it('restarts bar numbers when the song asks it to', () => {
    const r = resolveGridSegments(song({ gridSegments: [SPLIT], barNumbering: 'restart' }));
    expect(r[0].barNumberOffset).toBe(0);
    expect(r[1].barNumberOffset).toBe(0);
    // Beat indices stay globally unique either way — only display restarts.
    expect(r[1].beatIndexOffset).toBe(20);
  });

  it('lands on a clean bar when the split happens to be on one', () => {
    const r = resolveGridSegments(song({
      gridSegments: [{ id: 'x', start: 8.32, bpm: 92, timeSignature: '6/8' }],
    }));
    expect(r[0].cutBeats).toBe(0);
    expect(r[0].barCount).toBe(4);
    expect(r[0].beatCount).toBe(16);
    expect(r[1].barNumberOffset).toBe(4);
  });

  it('accumulates offsets across three segments', () => {
    const r = resolveGridSegments(song({
      gridSegments: [
        SPLIT,
        { id: 'gs_b', start: 17.2, bpm: 124, timeSignature: '4/4' },
      ],
    }));
    expect(r).toHaveLength(3);
    expect(r[2].barNumberOffset).toBe(r[1].barNumberOffset + r[1].barCount);
    expect(r[2].beatIndexOffset).toBe(r[1].beatIndexOffset + r[1].beatCount);
  });
});

describe('lookups', () => {
  const r = resolveGridSegments(song({ gridSegments: [SPLIT] }));

  it('puts the pickup before bar 1 in the opening segment', () => {
    expect(segmentAtTime(r, 0)?.index).toBe(0);
  });

  it('gives the split instant to the new segment', () => {
    expect(segmentAtTime(r, 10.07)?.index).toBe(1);
    expect(segmentAtTime(r, 10.06)?.index).toBe(0);
  });

  it('resolves a global beat index back to its time', () => {
    expect(segmentBeatTime(r, 0)).toBeCloseTo(0.32, 9);
    expect(segmentBeatTime(r, 4)).toBeCloseTo(2.32, 9);
    // Beat 20 is the first beat of segment 2 — its start, not the old grid.
    expect(segmentBeatTime(r, 20)).toBeCloseTo(10.07, 9);
    expect(segmentBeatTime(r, 21)).toBeCloseTo(10.07 + 60 / 92, 9);
  });

  it('rounds a beat index trip back to the same index', () => {
    for (const idx of [0, 3, 19, 20, 26]) {
      const t = segmentBeatTime(r, idx)!;
      expect(segmentAtBeatIndex(r, idx)!.id).toBe(segmentAtTime(r, t)!.id);
    }
  });

  it('counts fractional beats from the origin', () => {
    expect(segmentBeatPosition(r, 0.32)).toBeCloseTo(0, 9);
    expect(segmentBeatPosition(r, 0.57)).toBeCloseTo(0.5, 9);
    expect(segmentBeatPosition(r, 10.07)).toBeCloseTo(20, 9);
  });

  it('reads bar.beat per segment meter, continuing the bar count', () => {
    // Segment 1, second bar, first beat.
    const a = segmentBarBeat(r, 2.32)!;
    expect(a.bar).toBe(1);
    expect(a.beat).toBe(0);
    // Segment 2 opens bar 6 (index 5), beat 1, in 6/8.
    const b = segmentBarBeat(r, 10.07)!;
    expect(b.bar).toBe(5);
    expect(b.beat).toBe(0);
    expect(b.segment.beatsPerBar).toBe(6);
  });

  it('numbers bars negatively before the first downbeat, as the grid always has', () => {
    expect(segmentBarBeat(r, 0)!.bar).toBe(-1);
  });
});

describe('placement rules', () => {
  const r = resolveGridSegments(song({ gridSegments: [SPLIT] }));

  it('accepts a head with room on both sides', () => {
    expect(canPlaceSegmentAt(r, 5).ok).toBe(true);
  });

  it('refuses a head before the song’s first downbeat', () => {
    const check = canPlaceSegmentAt(r, 0.1);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/first downbeat/);
  });

  it('refuses a head within one beat of another', () => {
    // The gap is measured in beats of the grid running between the two
    // heads. Just after the 6/8 head at 10.07s that grid is segment 2's,
    // whose beat is 60/92 = 0.652s.
    expect(canPlaceSegmentAt(r, 10.2).ok).toBe(false);
    expect(canPlaceSegmentAt(r, 10.6).ok).toBe(false);
    expect(canPlaceSegmentAt(r, 10.8).ok).toBe(true);
  });

  it('measures the gap against the outgoing grid on the earlier side', () => {
    // Before that same head the grid is segment 1's, at 0.5s per beat, so
    // 0.6s of clearance is enough on the left where it was not on the right.
    expect(canPlaceSegmentAt(r, 9.47).ok).toBe(true);
    expect(canPlaceSegmentAt(r, 9.9).ok).toBe(false);
  });

  it('lets a segment being dragged pass over its own old position', () => {
    expect(canPlaceSegmentAt(r, 10.07, 'gs_a').ok).toBe(true);
  });

  it('previews how much of the outgoing bar survives', () => {
    const preview = cutPreviewAt(r, 10.07, 'gs_a')!;
    expect(preview.beatsKept).toBeCloseTo(3.5, 9);
    expect(preview.beatsPerBar).toBe(4);
    expect(preview.barNumber).toBe(4);
  });

  it('reports no cut when the head lands on a bar line', () => {
    expect(cutPreviewAt(r, 8.32, 'gs_a')).toBeNull();
  });
});

describe('pinned beats across a split', () => {
  const unsplit = resolveGridSegments(song());
  const split = resolveGridSegments(song({ gridSegments: [SPLIT] }));

  it('keeps plain numeric keys while the song has no splits', () => {
    expect(beatOverrideKey(unsplit, 7)).toBe('7');
  });

  it('scopes keys to their segment once the song is split', () => {
    expect(beatOverrideKey(split, 7)).toBe(`${OPENING_SEGMENT_ID}:7`);
    expect(beatOverrideKey(split, 21)).toBe('gs_a:1');
  });

  it('still reads a legacy key after the first split', () => {
    expect(readBeatOverride({ '7': 3.9 }, split, 7)).toBe(3.9);
  });

  it('prefers the scoped key when both exist', () => {
    expect(readBeatOverride({ '7': 3.9, [`${OPENING_SEGMENT_ID}:7`]: 4.1 }, split, 7)).toBe(4.1);
  });

  it('re-keys a pin so it stays on the beat it was pinned to', () => {
    const before = { '7': 3.9 };
    const after = remapBeatOverrides(before, unsplit, split);
    // Beat 7 sits at 3.82s, comfortably inside segment 1 — same beat, new key.
    expect(after).toEqual({ [`${OPENING_SEGMENT_ID}:7`]: 3.9 });
  });

  it('drops a pin whose beat no longer exists after the split', () => {
    // Beat 25 was at 12.82s on the old grid; segment 1 now ends at 10.07s.
    const after = remapBeatOverrides({ '25': 12.9 }, unsplit, split);
    expect(Object.keys(after)).toHaveLength(0);
  });

  it('survives a round trip back to an unsplit grid', () => {
    const forward = remapBeatOverrides({ '7': 3.9 }, unsplit, split);
    const back = remapBeatOverrides(forward, split, unsplit);
    expect(back).toEqual({ '7': 3.9 });
  });

  it('never lets two pins collide on one beat', () => {
    const before = { '19': 9.9, '20': 10.4 };
    const after = remapBeatOverrides(before, unsplit, split);
    expect(Object.keys(after).length).toBeLessThanOrEqual(2);
    expect(new Set(Object.keys(after)).size).toBe(Object.keys(after).length);
  });
});

describe('song-level helpers', () => {
  it('counts the opening segment', () => {
    expect(getGridSegmentCount(song())).toBe(1);
    expect(getGridSegmentCount(song({ gridSegments: [SPLIT] }))).toBe(2);
  });

  it('counts nothing when there is no grid', () => {
    expect(getGridSegmentCount(makeEmptySongInfo('x'))).toBe(0);
  });

  it('mints unique ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => makeGridSegmentId()));
    expect(ids.size).toBe(50);
  });

  it('normalizes through the song accessor', () => {
    const info = song({ gridSegments: [{ id: 'x', start: 0.1, bpm: 90, timeSignature: '4/4' }] });
    expect(effectiveGridSegments(info)).toEqual([]);
  });
});

describe('buildResolved', () => {
  it('works from loose parts, for a drag in progress', () => {
    const r = buildResolved([SPLIT], 0.32, 120, '4/4');
    expect(r).toHaveLength(2);
    expect(r[0].cutBeats).toBeCloseTo(3.5, 9);
  });

  it('treats an empty split list as one whole-song grid', () => {
    const r = buildResolved([], 0, 120, '4/4');
    expect(r).toHaveLength(1);
    expect(r[0].end).toBe(Number.POSITIVE_INFINITY);
  });
});


// The head of a split is dropped by hand, and the grid it is landing IN is the
// outgoing one — the dragged segment's own beats move with it, so snapping to
// them would be snapping to the thing being dragged.
describe('snapSegmentHeadTime', () => {
  const resolved = resolveGridSegments(song({ gridSegments: [SPLIT] }));

  it('snaps to the nearest beat of the OUTGOING segment', () => {
    // Opening segment: 120 BPM from 0.32s → a beat every 0.5s.
    expect(snapSegmentHeadTime(resolved, 8.1, 'gs_a')).toBeCloseTo(8.32, 9);
    expect(snapSegmentHeadTime(resolved, 8.60, 'gs_a')).toBeCloseTo(8.82, 9);
  });

  it('measures against the segment the head is landing in, not the first one', () => {
    const three = resolveGridSegments(song({
      gridSegments: [SPLIT, { id: 'gs_b', start: 30, bpm: 60, timeSignature: '4/4' }],
    }));
    // Lands inside the 92 BPM 6/8 segment that starts at 10.07 — beats of
    // 60/92 s, so the snap grid is 10.07 + n·0.652…, nothing to do with 120.
    const beatDur = 60 / 92;
    const snapped = snapSegmentHeadTime(three, 20, 'gs_b');
    expect(Math.abs((snapped - 10.07) / beatDur - Math.round((snapped - 10.07) / beatDur))).toBeLessThan(1e-9);
    expect(Math.abs(snapped - 20)).toBeLessThanOrEqual(beatDur / 2 + 1e-9);
  });

  it('never returns a negative time', () => {
    expect(snapSegmentHeadTime(resolved, 0.05, 'gs_a')).toBeGreaterThanOrEqual(0);
  });

  it('leaves the time alone when there is nothing else to measure against', () => {
    const only = resolveGridSegments(song());
    expect(snapSegmentHeadTime(only, 7.77, OPENING_SEGMENT_ID)).toBe(7.77);
  });
});


// A head is stored to the millisecond, so "how much of the bar survived" is
// answered with a hair of float noise on it. The answer must never round into
// a lie — a bar that kept all four of its beats was not cut at all.
describe('cut bars near a bar line', () => {
  const bpm = 89, beatsPerBar = 4;
  const beat = 60 / bpm;
  const bar = beat * beatsPerBar;

  function cutOf(headAt: number) {
    const resolved = resolveGridSegments({
      ...makeEmptySongInfo('demo'),
      bpm, timeSignature: '4/4', gridOffset: 0, gridMode: 'mapped',
      gridSegments: [{ id: 'gs_a', start: headAt, bpm, timeSignature: '4/4' }],
    });
    return resolved[0].cutBeats;
  }

  it('reports no cut when the head is a rounding error short of a bar line', () => {
    expect(cutOf(Math.round(6 * bar * 1000) / 1000)).toBe(0);
    expect(cutOf(6 * bar - 0.0004)).toBe(0);
  });

  it('still reports a real cut', () => {
    expect(cutOf(6 * bar + 3 * beat)).toBeCloseTo(3, 6);
  });

  it('the live readout agrees with the hatch that lands after the drop', () => {
    const resolved = resolveGridSegments({
      ...makeEmptySongInfo('demo'),
      bpm, timeSignature: '4/4', gridOffset: 0,
      gridSegments: [{ id: 'gs_a', start: 40, bpm, timeSignature: '4/4' }],
    });
    const onLine = Math.round(6 * bar * 1000) / 1000;
    expect(cutPreviewAt(resolved, onLine, 'gs_a')).toBeNull();
    expect(cutOf(onLine)).toBe(0);
  });

  it('never prints "4 of 4" or "0 of 4" — it reaches for another decimal', () => {
    expect(formatKeptBeats(3.96, 4)).toBe('3.96');
    expect(formatKeptBeats(0.04, 4)).toBe('0.04');
    expect(formatKeptBeats(3.5, 4)).toBe('3.5');
    expect(formatKeptBeats(3.4999999, 4)).toBe('3.5');
  });
});

// Hand-placed mode draws its beat lines where the pins are, so that is where a
// snapped head has to land — snapping it to the macro beat instead would park
// it beside a visible line.
describe('snapSegmentHeadTime with pinned beats', () => {
  const base = {
    ...makeEmptySongInfo('demo'),
    bpm: 120, timeSignature: '4/4', gridOffset: 0, gridMode: 'mapped',
    gridSegments: [{ id: 'gs_a', start: 30, bpm: 90, timeSignature: '4/4' }],
  } as SongInfo;
  const resolved = resolveGridSegments(base);

  it('lands on the pinned time when the nearest beat is pinned', () => {
    // Opening segment, 120 BPM: beat 17 sits at 8.5s; pinned to 8.61.
    expect(snapSegmentHeadTime(resolved, 8.55, 'gs_a', { 'opening:17': 8.61 })).toBeCloseTo(8.61, 9);
  });

  it('falls back to the macro beat when that beat is not pinned', () => {
    expect(snapSegmentHeadTime(resolved, 8.55, 'gs_a', { 'opening:3': 1.61 })).toBeCloseTo(8.5, 9);
  });

  it('measures against the outgoing segment even mid-drag, when starts are moving', () => {
    // The dragged head is well past its own recorded start — the outgoing
    // segment is still the one before it in the table, not the one whose start
    // happens to be closest.
    const three = resolveGridSegments({
      ...base,
      gridSegments: [
        { id: 'gs_a', start: 30, bpm: 90, timeSignature: '4/4' },
        { id: 'gs_b', start: 60, bpm: 90, timeSignature: '4/4' },
      ],
    } as SongInfo);
    const beatDur = 60 / 90;
    const snapped = snapSegmentHeadTime(three, 61.4, 'gs_b');
    const n = (snapped - 30) / beatDur;
    expect(Math.abs(n - Math.round(n))).toBeLessThan(1e-9);
  });
});

// ─── The mode gate ───────────────────────────────────────────────────────────
//
// Splits shape the grid only in Mapped mode. Everywhere else the map stays on
// disk, inert, so switching modes to look at a song never costs you the map you
// built.

describe('grid segments follow the active mode', () => {
  const withSplit = (mode: SongInfo['gridMode'], base?: SongInfo['manualBaseGridMode']) =>
    song({ gridMode: mode, manualBaseGridMode: base, gridSegments: [SPLIT] });

  it('shapes the grid in Mapped mode', () => {
    expect(resolveGridSegments(withSplit('mapped'))).toHaveLength(2);
  });

  it('leaves the grid alone in Steady', () => {
    expect(resolveGridSegments(withSplit('static'))).toHaveLength(1);
  });

  it('applies under Hand-placed when the base is Mapped', () => {
    expect(resolveGridSegments(withSplit('manual', 'mapped'))).toHaveLength(2);
    expect(resolveGridSegments(withSplit('manual', 'static'))).toHaveLength(1);
  });

  it('keeps the map visible to the editors whatever the mode', () => {
    for (const mode of ['static', 'mapped', 'manual'] as const) {
      expect(resolveStoredGridSegments(withSplit(mode))).toHaveLength(2);
    }
  });

  it('counts the stored map, not the active one', () => {
    expect(getGridSegmentCount(withSplit('static'))).toBe(2);
    expect(getGridSegmentCount(withSplit('mapped'))).toBe(2);
  });

  it('never loses the splits from disk', () => {
    const parked = withSplit('static');
    expect(storedGridSegments(parked)).toHaveLength(1);
    expect(effectiveGridSegments(parked)).toHaveLength(0);
  });
});


// ─── Moving the opening head (the song's own downbeat) ──────────────────────
//
// The opening segment starts at `gridOffset`, which is very often not 0:00 —
// a song with a pickup, a fade-in, or a late first downbeat. Dragging that
// head is how it gets lined up, and it obeys different rules from a split:
// a split has to come AFTER the origin, while the origin has nothing to come
// after. What it must not do is cross segment 2, because
// `normalizeGridSegments` drops every stored split at or before the offset —
// so an unchecked drag through one deletes it in passing.

describe('moving the opening head', () => {
  const withSplit = resolveGridSegments(song({ gridSegments: [SPLIT] }));
  const alone = resolveGridSegments(song());

  it('accepts an origin anywhere before segment 2, unlike a split', () => {
    // 0.1s is refused for a split — "must come after the first downbeat" —
    // but for the origin itself it is simply an earlier downbeat.
    expect(canPlaceSegmentAt(withSplit, 0.1).ok).toBe(false);
    expect(canPlaceOriginAt(withSplit, 0.1).ok).toBe(true);
    expect(canPlaceOriginAt(withSplit, 0).ok).toBe(true);
    expect(canPlaceOriginAt(withSplit, 5).ok).toBe(true);
  });

  it('refuses an origin before the start of the song', () => {
    const check = canPlaceOriginAt(alone, -0.5);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/before the start/);
  });

  it('refuses an origin past the end of the audio', () => {
    expect(canPlaceOriginAt(alone, 400, 300).ok).toBe(false);
    expect(canPlaceOriginAt(alone, 299, 300).ok).toBe(true);
    // No duration known — nothing to check it against.
    expect(canPlaceOriginAt(alone, 400).ok).toBe(true);
  });

  it('refuses an origin that would swallow segment 2', () => {
    // Segment 1 runs at 120 BPM, so it needs 0.5s to hold one beat.
    expect(canPlaceOriginAt(withSplit, 9.5).ok).toBe(true);
    expect(canPlaceOriginAt(withSplit, 9.7).ok).toBe(false);
    expect(canPlaceOriginAt(withSplit, 10.07).ok).toBe(false);
    expect(canPlaceOriginAt(withSplit, 12).ok).toBe(false);
  });

  it('is refusing a real deletion, not being fussy', () => {
    // Why the rule exists: normalize drops splits at or before the offset,
    // so committing an origin past segment 2 loses it with no undo prompt.
    expect(normalizeGridSegments([SPLIT], 0.32)).toHaveLength(1);
    expect(normalizeGridSegments([SPLIT], 12)).toHaveLength(0);
  });

  it('routes each head to the rules that apply to it', () => {
    const opening = withSplit[0];
    const split = withSplit[1];
    // The origin may sit at 0.1s; a split may not.
    expect(canMoveHeadTo(withSplit, opening, 0.1).ok).toBe(true);
    expect(canMoveHeadTo(withSplit, split, 0.1).ok).toBe(false);
    // A split may sit at 5s; the origin may too, but for different reasons.
    expect(canMoveHeadTo(withSplit, split, 5).ok).toBe(true);
  });

  it('does not snap the origin — there are no beats before it', () => {
    const opening = withSplit[0];
    expect(snapSegmentHeadTime(withSplit, 3.14159, opening.id)).toBeCloseTo(3.14159, 9);
    // Even dragged past segment 2, it must not latch onto that grid: the
    // fallback scan would otherwise hand back one of segment 2's beat times.
    expect(snapSegmentHeadTime(withSplit, 11.3, opening.id)).toBeCloseTo(11.3, 9);
  });

  it('clamps a negative snap request to the start of the song', () => {
    expect(snapSegmentHeadTime(alone, -2, alone[0].id)).toBe(0);
  });
});
