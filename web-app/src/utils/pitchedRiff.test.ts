import { describe, expect, it } from 'vitest';
import { normalizeBoundarySegments, type RiffBoundarySegment } from '../types/annotationLayer';
import {
  attackPositionsByBar, deleteNote, hitsFromOnsets, holdToNextAttack, isPitchedNode, moveNote,
  pitchRows, placeNote, resizeNote, setNodePulse, snapSegmentsToPulse, toNotesNode,
  nameHits, nameableHitCount, notesFromOnsets,
} from './pitchedRiff';

const ticks = (s: RiffBoundarySegment[]) => s.filter((x) => x.kind === 'tick');

describe('pitched riff', () => {
  it('a node is pitched once a note says its pitch', () => {
    expect(isPitchedNode({ segments: [{ start: 0, end: 1, kind: 'tick', note: 24 }] })).toBe(true);
    expect(isPitchedNode({ segments: [{ start: 0, end: 1, kind: 'tick' }] })).toBe(false);
    expect(isPitchedNode(null)).toBe(false);
  });

  it('a note keeps its accent when it is moved or resized', () => {
    const s = normalizeBoundarySegments([{ start: 0, end: 0.25, kind: 'tick', accent: 70 }], 4);
    expect(ticks(moveNote(s, 0, 1, null, 4)).map((t) => [t.start, t.accent])).toEqual([[1, 70]]);
    expect(ticks(resizeNote(s, 0, 1, 4)).map((t) => [t.end, t.accent])).toEqual([[1, 70]]);
  });

  it('a new note cuts the one under it, as a monophonic line does', () => {
    let s = placeNote([], 0, 4, 24, 8);
    s = placeNote(s, 2, 3, 36, 8);
    expect(ticks(s).map((t) => [t.start, t.end, t.note, t.label])).toEqual([
      [0, 2, 24, 'C1'], [2, 3, 36, 'C2'], [3, 4, 24, 'C1'],
    ]);
    expect(s.at(-1)).toMatchObject({ start: 4, end: 8, kind: 'empty' });
  });

  it('moves keep the length, resizes keep the start, deletes leave a rest', () => {
    const s = placeNote([], 0, 0.5, 24, 4);
    const moved = moveNote(s, 0, 1, 26, 4);
    expect(ticks(moved)).toEqual([{ start: 1, end: 1.5, kind: 'tick', note: 26, label: 'D1' }]);
    const longer = resizeNote(moved, moved.findIndex((x) => x.kind === 'tick'), 3, 4);
    expect(ticks(longer)[0]).toMatchObject({ start: 1, end: 3, note: 26 });
    expect(ticks(deleteNote(longer, longer.findIndex((x) => x.kind === 'tick'), 4))).toEqual([]);
  });

  it('hold to next attack: each note lasts until the next one starts', () => {
    let s = placeNote([], 0, 0.25, 24, 4);
    s = placeNote(s, 2.5, 2.75, 36, 4);
    expect(ticks(holdToNextAttack(s, 4)).map((t) => [t.start, t.end])).toEqual([[0, 2.5], [2.5, 4]]);
  });

  it("numbers attacks on the sixteenth pulse, bar by bar — Butler's 1/5/9/13", () => {
    // El Jaguar's bass riff, first two bars.
    const s: RiffBoundarySegment[] = [
      { start: 0, end: 0.5, kind: 'tick', note: 24 },
      { start: 0.5, end: 2.5, kind: 'tick', note: 24 },
      { start: 2.5, end: 3.5, kind: 'tick', note: 36 },
      { start: 3.5, end: 5.5, kind: 'tick', note: 34 },
      { start: 5.5, end: 8, kind: 'tick', note: 33 },
    ];
    const bars = attackPositionsByBar(s, 4);
    expect(bars.map((b) => b.map((a) => `${a.pos} ${a.name}`))).toEqual([
      ['1 C1', '3 C1', '11 C2', '15 A♯1'.replace('A♯', midiName(34))],
      ['7 A1'],
    ]);
  });

  it('draws the rows the line plays, padded, high to low', () => {
    const rows = pitchRows([{ start: 0, end: 1, kind: 'tick', note: 30 }, { start: 1, end: 2, kind: 'tick', note: 33 }], { pad: 1, minRows: 2 });
    expect(rows).toEqual([34, 33, 32, 31, 30, 29]);
  });
});

function midiName(n: number): string {
  return ticks(placeNote([], 0, 1, n, 1))[0].label!.slice(0, -1);
}

describe('notes on the pulse', () => {
  const base = { id: 'n', name: 'N', color: '#fff' };
  const hits = (steps: number[], sub = 4) =>
    steps.map((st) => ({ start: st / sub, end: (st + 1) / sub, kind: 'tick' as const }));

  it('blocks off the pulse snap onto the sixteenth; hairlines become a step long', () => {
    const n = toNotesNode({
      ...base, stepsPerCycle: 32, subbeatsPerBeat: 4,
      segments: [
        { start: 0, end: 0.0293, kind: 'tick', accent: 90 },
        { start: 0.0293, end: 0.4797, kind: 'empty' },
        { start: 0.4797, end: 0.5091, kind: 'tick' },
        { start: 0.5091, end: 8, kind: 'empty' },
      ],
    });
    expect(ticks(n.segments).map((t) => [t.start, t.end, t.accent])).toEqual([[0, 0.25, 90], [0.5, 0.75, undefined]]);
  });

  it('a node already on its pulse is returned as is', () => {
    const clean = toNotesNode({ ...base, stepsPerCycle: 16, subbeatsPerBeat: 4, segments: normalizeBoundarySegments(hits([0]), 4) });
    expect(toNotesNode(clean)).toBe(clean);
  });

  it('two attacks on one step are one', () => {
    const segs = snapSegmentsToPulse([
      { start: 0.49, end: 0.5, kind: 'tick' }, { start: 0.51, end: 0.6, kind: 'tick' },
    ], 4, 4);
    expect(ticks(segs)).toHaveLength(1);
  });

  it('changing the pulse moves notes to the nearest new step, only when the length fits', () => {
    const n = { ...base, stepsPerCycle: 8, subbeatsPerBeat: 4, segments: normalizeBoundarySegments(hits([1]), 2) };
    const tri = setNodePulse(n, 3)!;
    expect(tri.stepsPerCycle).toBe(6);
    expect(ticks(tri.segments!).map((t) => t.start)).toEqual([0.3333]);
    expect(setNodePulse({ ...n, stepsPerCycle: 5 }, 3)).toBeNull();
  });

  it('takes hits off onsets; add keeps what is there', () => {
    const one = hitsFromOnsets([], [0.02, 1.48], 4, 4, 'replace');
    expect(ticks(one).map((t) => t.start)).toEqual([0, 1.5]);
    const more = hitsFromOnsets(one, [0.01, 3.03], 4, 4, 'add');
    expect(ticks(more).map((t) => t.start)).toEqual([0, 1.5, 3]);
  });
});

describe('pitches from a notes lane', () => {
  const bass = [{ beat: 0.02, note: 24 }, { beat: 1.49, note: 36 }, { beat: 3, note: undefined }];

  it('taking hits off a notes lane brings their pitches', () => {
    const s = notesFromOnsets([], bass, 4, 4, 'replace');
    expect(ticks(s).map((t) => [t.start, t.note, t.label])).toEqual([[0, 24, 'C1'], [1.5, 36, 'C2'], [3, undefined, undefined]]);
  });

  it('names the hits already there, and never renames a note', () => {
    let s = hitsFromOnsets([], [0, 1.5], 4, 4, 'replace');
    s = placeNote(s, 1.5, 1.75, 40, 4);
    expect(nameableHitCount(s, bass, 4)).toBe(1);
    expect(ticks(nameHits(s, bass, 4)).map((t) => t.note)).toEqual([24, 40]);
  });

  it('an onset more than half a step away names nothing', () => {
    const s = hitsFromOnsets([], [1], 4, 4, 'replace');
    expect(nameableHitCount(s, [{ beat: 1.2, note: 30 }], 4)).toBe(0);
  });
});
