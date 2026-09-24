/**
 * Lead lane derivation + assignment. The assignment rules are where the
 * behaviour is subtle, so most of this file pins down what an assignment is
 * NOT allowed to do: swallow the head of an item, run past the range it was
 * given, or write an envelope onto something that never claimed the lead.
 */

import { describe, it, expect } from 'vitest';
import {
  assignLeadOverRange,
  assignVocalLeadEverywhere,
  collectLeadCandidates,
  leadCandidatesInRange,
  leadRegions,
  levelRegions,
  levelAtTrackTime,
  type LeadCandidate,
} from './leadLane';
import type { AnnotationLayer, ProminenceEnvelope } from '../types/annotationLayer';

function cand(
  itemId: string,
  start: number,
  end: number,
  prominence?: ProminenceEnvelope,
): LeadCandidate {
  return {
    layerId: `layer-${itemId}`, layerName: itemId, layerType: 'spans',
    color: '#888', itemId, label: itemId, start, end, prominence,
  };
}

describe('collectLeadCandidates', () => {
  const layers = [
    {
      id: 'L1', name: 'Instruments', type: 'spans', visible: true, color: '#0f0', snap: 'off',
      items: [{ id: 'gtr', start: 0, end: 30, label: 'guitar' }],
    },
    {
      id: 'L2', name: 'Detector', type: 'spans', visible: true, color: '#00f', snap: 'off',
      readOnly: true,
      items: [{ id: 'det', start: 0, end: 30, label: 'detected' }],
    },
    {
      id: 'L3', name: 'Cues', type: 'cues', visible: true, color: '#f00', snap: 'off',
      items: [{ id: 'c1', time: 4, label: 'hit' }],
    },
    {
      id: 'L4', name: 'Riffs', type: 'riff-patterns', visible: false, color: '#ff0', snap: 'off',
      nodes: [], combos: [],
      items: [{ id: 'pat', start: 10, end: 12, label: 'riff', repeatCount: 4, sequence: [] }],
    },
  ] as unknown as AnnotationLayer[];

  const got = collectLeadCandidates(layers);

  it('takes durational annotator layers only — no detector layers, no instants', () => {
    expect(got.map((c) => c.itemId)).toEqual(['gtr', 'pat']);
  });

  // Hiding a layer is a clutter control, not a statement about the annotation:
  // a hidden item still holds its lead and still has to be demotable.
  it('includes hidden layers', () => {
    expect(got.some((c) => c.itemId === 'pat')).toBe(true);
  });

  it('extends a riff instance to the end of its repeated region, not one cycle', () => {
    // 4 repeats of a 2s cycle from 10 ⇒ the envelope covers 10→18.
    expect(got.find((c) => c.itemId === 'pat')).toMatchObject({ start: 10, end: 18 });
  });

  // Most durational items are never labelled one by one — the part is named
  // once, on the layer — so an item's own label is a fallback, not the name.
  it('names an unlabelled item after its layer', () => {
    const layers = [{
      id: 'L', name: 'Chello parts', type: 'spans', visible: true, color: '#0f0', snap: 'off',
      items: [{ id: 'a', start: 0, end: 4, label: '' }, { id: 'b', start: 4, end: 8 }],
    }] as unknown as AnnotationLayer[];
    expect(collectLeadCandidates(layers).map((c) => c.label))
      .toEqual(['Chello parts', 'Chello parts']);
  });

  it('treats an auto-generated "Instance N" as a placeholder, keeping it aside', () => {
    const layers = [{
      id: 'L', name: 'Tick Tick (Riff)', type: 'riff-patterns', visible: true, color: '#0f0', snap: 'off',
      items: [
        { id: 'a', start: 0, end: 4, label: 'Instance 5' },
        { id: 'b', start: 4, end: 8, label: 'Chorus stab' },
      ],
    }] as unknown as AnnotationLayer[];
    expect(collectLeadCandidates(layers).map((c) => [c.label, c.placeholder])).toEqual([
      ['Tick Tick (Riff)', 'Instance 5'],
      ['Chorus stab', undefined],
    ]);
  });
});

describe('levelAtTrackTime', () => {
  const c = cand('gtr', 10, 20, [{ t: 0, level: 'lead' }, { t: 5, level: 'backing' }]);

  it('maps track time into the item and reads the envelope', () => {
    expect(levelAtTrackTime(c, 12)).toBe('lead');
    expect(levelAtTrackTime(c, 16)).toBe('backing');
  });

  // prominenceAt clamps past the last point so the playhead never falls off the
  // array; for "who is in front" that would leave a finished item still leading.
  it('reads null outside the item rather than clamping to the ends', () => {
    expect(levelAtTrackTime(c, 9.9)).toBeNull();
    expect(levelAtTrackTime(c, 20)).toBeNull();
  });

  it('reads null for an unannotated item', () => {
    expect(levelAtTrackTime(cand('bass', 0, 30), 5)).toBeNull();
  });
});

describe('leadRegions', () => {
  it('is empty when nothing is annotated', () => {
    expect(leadRegions([cand('gtr', 0, 30)], 30)).toEqual([]);
  });

  it('omits the stretches where nobody is in front', () => {
    const gtr = cand('gtr', 0, 30, [
      { t: 0, level: 'lead' }, { t: 10, level: 'silent' }, { t: 20, level: 'lead' },
    ]);
    expect(leadRegions([gtr], 30).map((r) => [r.start, r.end]))
      .toEqual([[0, 10], [20, 30]]);
  });

  it('splits the track where the front changes hands', () => {
    const gtr = cand('gtr', 0, 30, [{ t: 0, level: 'lead' }, { t: 10, level: 'counter' }]);
    const vox = cand('vox', 10, 30, [{ t: 0, level: 'lead' }]);
    const regions = leadRegions([gtr, vox], 30);
    expect(regions.map((r) => [r.start, r.end, r.leaders.map((l) => l.itemId)]))
      .toEqual([[0, 10, ['gtr']], [10, 30, ['vox']]]);
  });

  it('merges neighbouring stretches that keep the same leaders', () => {
    // The backing→silent switch at +10 changes nothing about who leads, so the
    // two stretches either side of it must not be reported separately.
    const gtr = cand('gtr', 0, 30, [{ t: 0, level: 'lead' }]);
    const pad = cand('pad', 0, 30, [{ t: 0, level: 'backing' }, { t: 10, level: 'silent' }]);
    expect(leadRegions([gtr, pad], 30)).toEqual([
      { start: 0, end: 30, leaders: [gtr] },
    ]);
  });

  // Call-and-response, a doubled hook, unison stabs: the front is genuinely
  // shared, so the lane reports both rather than forbidding it.
  it('reports a shared front', () => {
    const a = cand('a', 0, 30, [{ t: 0, level: 'lead' }]);
    const b = cand('b', 0, 30, [{ t: 0, level: 'lead' }]);
    expect(leadRegions([a, b], 30)[0].leaders.map((l) => l.itemId)).toEqual(['a', 'b']);
  });
});

describe('leadCandidatesInRange', () => {
  it('returns everything alive anywhere in the range', () => {
    const items = [cand('a', 0, 10), cand('b', 8, 20), cand('c', 25, 30)];
    expect(leadCandidatesInRange(items, 5, 15).map((c) => c.itemId)).toEqual(['a', 'b']);
  });

  it('excludes an item that merely abuts the range', () => {
    expect(leadCandidatesInRange([cand('a', 0, 10)], 10, 20)).toEqual([]);
  });
});

describe('assignLeadOverRange', () => {
  it('gives the winner the lead and pins counter either side of the range', () => {
    const gtr = cand('gtr', 0, 30);
    const [patch] = assignLeadOverRange([gtr], 10, 20, 'gtr');
    expect(patch.prominence).toEqual([
      { t: 0, level: 'counter' },
      { t: 10, level: 'lead' },
      { t: 20, level: 'counter' },
    ]);
  });

  it('stops exactly at the range end instead of running to the item end', () => {
    const gtr = cand('gtr', 0, 30, [{ t: 0, level: 'backing' }]);
    const [patch] = assignLeadOverRange([gtr], 10, 20, 'gtr');
    // Outside the range the item keeps what it already said — backing, not the
    // 'counter' fill, which only applies to items with nothing to restore.
    expect(patch.prominence).toEqual([
      { t: 0, level: 'backing' },
      { t: 10, level: 'lead' },
      { t: 20, level: 'backing' },
    ]);
  });

  it('writes a single flat point when the range covers the whole item', () => {
    const gtr = cand('gtr', 10, 20);
    const [patch] = assignLeadOverRange([gtr], 0, 40, 'gtr');
    expect(patch.prominence).toEqual([{ t: 0, level: 'lead' }]);
  });

  it('demotes the outgoing lead to counter and hands it back afterwards', () => {
    const gtr = cand('gtr', 0, 40, [{ t: 0, level: 'lead' }]);
    const vox = cand('vox', 0, 40);
    const patches = assignLeadOverRange([gtr, vox], 10, 20, 'vox');
    const byId = Object.fromEntries(patches.map((p) => [p.itemId, p.prominence]));
    expect(byId.gtr).toEqual([
      { t: 0, level: 'lead' },
      { t: 10, level: 'counter' },
      { t: 20, level: 'lead' },
    ]);
    expect(byId.vox).toEqual([
      { t: 0, level: 'counter' },
      { t: 10, level: 'lead' },
      { t: 20, level: 'counter' },
    ]);
  });

  // The lane annotates the front. Handing the vocal the lead must not promote
  // every unannotated pad in the song to 'counter'.
  it('leaves items that never claimed the lead completely alone', () => {
    const pad = cand('pad', 0, 40);
    const bass = cand('bass', 0, 40, [{ t: 0, level: 'backing' }]);
    const vox = cand('vox', 0, 40);
    const patches = assignLeadOverRange([pad, bass, vox], 10, 20, 'vox');
    expect(patches.map((p) => p.itemId)).toEqual(['vox']);
  });

  it('only touches the part of an item that overlaps the range', () => {
    const gtr = cand('gtr', 15, 40, [{ t: 0, level: 'lead' }]);
    const vox = cand('vox', 0, 40);
    const patches = assignLeadOverRange([gtr, vox], 10, 20, 'vox');
    const byId = Object.fromEntries(patches.map((p) => [p.itemId, p.prominence]));
    // gtr starts at 15, so its demotion runs from +0 (=track 15) to +5 (=20).
    expect(byId.gtr).toEqual([{ t: 0, level: 'counter' }, { t: 5, level: 'lead' }]);
  });

  it('clears the front when no winner is named', () => {
    const gtr = cand('gtr', 0, 40, [{ t: 0, level: 'lead' }]);
    const [patch] = assignLeadOverRange([gtr], 10, 20, null);
    expect(patch.prominence).toEqual([
      { t: 0, level: 'lead' },
      { t: 10, level: 'counter' },
      { t: 20, level: 'lead' },
    ]);
  });

  it('emits nothing for a no-op or a degenerate range', () => {
    const gtr = cand('gtr', 0, 40, [{ t: 0, level: 'lead' }]);
    expect(assignLeadOverRange([gtr], 0, 40, 'gtr')).toEqual([]);
    expect(assignLeadOverRange([gtr], 12, 12, 'gtr')).toEqual([]);
  });

  it('skips items that do not overlap the range at all', () => {
    const gtr = cand('gtr', 0, 5, [{ t: 0, level: 'lead' }]);
    expect(assignLeadOverRange([gtr], 10, 20, null)).toEqual([]);
  });

  it('replaces breakpoints buried inside the range', () => {
    const gtr = cand('gtr', 0, 40, [
      { t: 0, level: 'backing' }, { t: 12, level: 'lead' }, { t: 15, level: 'silent' },
    ]);
    const [patch] = assignLeadOverRange([gtr], 10, 20, 'gtr');
    expect(patch.prominence).toEqual([
      { t: 0, level: 'backing' },
      { t: 10, level: 'lead' },
      { t: 20, level: 'silent' },
    ]);
  });
});

/**
 * Lyrics reach the lane through `utils/vocalRuns.ts`, one candidate per sung
 * stretch. The rules that matter here are the two the feature turns on: a run
 * with no envelope READS as leading without anything being written, and giving
 * the voice the front for real is an explicit, single-write action.
 */
describe('lyrics candidates', () => {
  // 120 BPM, 4/4: one bar is 2s. Sung over bars 1-4, silent over 5-8, sung
  // again over 9-12 — the shape that should give the lane two blocks.
  const GRID = { bpm: 120, gridOffset: 0, beatsPerBar: 4 };
  const words = (from: number, to: number) => {
    const out = [];
    for (let t = from; t < to; t += 0.5) {
      out.push({ id: `w${t}`, time: t, text: t < 8 ? 'verse' : 'chorus', kind: 'word' as const });
    }
    return out;
  };
  const layers = [
    {
      id: 'LV', name: 'Combined Lyrics', type: 'lyrics', visible: true, color: '#a78bfa',
      snap: 'off', items: [...words(0, 8), ...words(16, 24)],
    },
    {
      id: 'LR', name: 'Riff Patterns 1', type: 'riff-patterns', visible: true, color: '#34d399',
      snap: 'bar', items: [{ id: 'riff', start: 0, end: 24, label: 'Instance 1',
                             prominence: [{ t: 0, level: 'lead' }] }],
    },
  ] as unknown as AnnotationLayer[];

  it('contributes one candidate per sung stretch, not one per word', () => {
    const vocal = collectLeadCandidates(layers, GRID).filter((c) => c.layerType === 'lyrics');
    expect(vocal).toHaveLength(2);
    expect(vocal[0].start).toBeCloseTo(0);
    expect(vocal[0].end).toBeCloseTo(8);
    expect(vocal[1].start).toBeCloseTo(16);
  });

  it('names a run by its layer, with its opening words as the detail', () => {
    const [first] = collectLeadCandidates(layers, GRID).filter((c) => c.layerType === 'lyrics');
    expect(first.label).toBe('Combined Lyrics');
    expect(first.placeholder).toContain('verse');
  });

  it('reads an un-annotated run as leading', () => {
    const [first] = collectLeadCandidates(layers, GRID).filter((c) => c.layerType === 'lyrics');
    expect(levelAtTrackTime(first, 4)).toBe('lead');
  });

  it('draws nothing at all over the break between two runs', () => {
    // The break is absence, not an annotated rest: no candidate covers it, so
    // no tier gets a block there — in particular not the Silent tier, which a
    // single track-long run would have had to assert.
    const cands = collectLeadCandidates(layers, GRID);
    const vocal = cands.filter((c) => c.layerType === 'lyrics');
    expect(vocal.some((c) => 10 >= c.start && 10 < c.end)).toBe(false);
    for (const level of ['lead', 'counter', 'backing', 'silent'] as const) {
      const covering = levelRegions(vocal, 24, level).filter((r) => r.start <= 10 && r.end > 10);
      expect(covering).toEqual([]);
    }
  });

  it('shares the front rather than demoting anyone, until asked', () => {
    // The riff claims the lead across the whole song and the voice defaults to
    // it too. Both are on the Lead tier and nothing has been written.
    const cands = collectLeadCandidates(layers, GRID);
    const [region] = levelRegions(cands, 24, 'lead');
    expect(region.leaders.length).toBeGreaterThan(1);
  });

  it('hands the voice the front over its runs and demotes the riff only there', () => {
    const cands = collectLeadCandidates(layers, GRID);
    const patches = assignVocalLeadEverywhere(cands, 'LV');
    const riff = patches.find((p) => p.itemId === 'riff');
    expect(riff).toBeDefined();
    // Lead over bars 1-4, back to lead over the break it still owns, counter
    // again over bars 9-12: the handover stops exactly where the voice stops.
    expect(riff!.prominence).toEqual([
      { t: 0, level: 'counter' },
      { t: 8, level: 'lead' },
      { t: 16, level: 'counter' },
    ]);
  });

  it('freezes the run list even where the voice level did not move', () => {
    // The voice already READ as leading, so its own envelope does not change —
    // but the demotions just written into the other parts are cut to these run
    // boundaries, so the boundaries must stop being derived.
    const cands = collectLeadCandidates(layers, GRID);
    const patches = assignVocalLeadEverywhere(cands, 'LV');
    const own = patches.filter((p) => p.layerId === 'LV');
    expect(own).toHaveLength(2);
    for (const p of own) expect(p.prominence).toEqual([{ t: 0, level: 'lead' }]);
  });

  it('carries the whole run list on a run patch, so the first edit freezes it', () => {
    const cands = collectLeadCandidates(layers, GRID);
    const patches = assignVocalLeadEverywhere(cands, 'LV');
    const runPatches = patches.filter((p) => p.layerId === 'LV');
    for (const p of runPatches) expect(p.runs).toHaveLength(2);
  });

  it('resolves each run against the previous ones, not against the original', () => {
    // One pad spanning both runs. Computed independently, the second run patch
    // would be derived from the pad untouched envelope and would discard the
    // first run demotion; folded, both survive.
    const withPad = [...layers, {
      id: 'LP', name: 'Pad', type: 'spans', visible: true, color: '#888', snap: 'off',
      items: [{ id: 'pad', start: 0, end: 24, prominence: [{ t: 0, level: 'lead' }] }],
    }] as unknown as AnnotationLayer[];
    const patches = assignVocalLeadEverywhere(collectLeadCandidates(withPad, GRID), 'LV');
    const pad = patches.find((p) => p.itemId === 'pad');
    expect(pad!.prominence).toEqual([
      { t: 0, level: 'counter' },
      { t: 8, level: 'lead' },
      { t: 16, level: 'counter' },
    ]);
  });

  it('leaves a lyrics layer with no words out of the lane entirely', () => {
    const empty = [{
      id: 'LE', name: 'Empty', type: 'lyrics', visible: true, color: '#a78bfa',
      snap: 'off', items: [],
    }] as unknown as AnnotationLayer[];
    expect(collectLeadCandidates(empty, GRID)).toEqual([]);
  });

  it('prefers stored runs over the word timings', () => {
    const stored = [{
      ...layers[0], vocalRuns: [{ id: 'one', start: 2, end: 6, prominence: [{ t: 0, level: 'backing' }] }],
    }] as unknown as AnnotationLayer[];
    const cands = collectLeadCandidates(stored, GRID);
    expect(cands).toHaveLength(1);
    expect(cands[0].itemId).toBe('one');
    expect(levelAtTrackTime(cands[0], 4)).toBe('backing');
  });
});
