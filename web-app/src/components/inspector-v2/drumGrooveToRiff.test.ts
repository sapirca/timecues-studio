import { describe, it, expect } from 'vitest';
import { riffLayerFromDrumGrooves, describeVariants, type GrooveItem } from './drumGrooveToRiff';

// A 4/4 bar at 120 bpm is 2 s and 16 sixteenth steps.
const BPM = 120;

function groove(over: Partial<GrooveItem> = {}): GrooveItem {
  return {
    start_ms: 0,
    duration_ms: 2000,
    label: 'Drum groove A (6 hits/bar)',
    repeat_count: 4,
    steps_per_cycle: 16,
    groove: 'A',
    rows: [
      { row: 'kick', highlighted_beats: [0, 8], accents: [120, 118] },
      { row: 'snare', highlighted_beats: [4, 12], accents: [115, 117] },
      { row: 'hat', highlighted_beats: [2, 6, 10, 14], accents: [70, 70, 70, 70] },
    ],
    occurrences: [
      { index: 0, start_ms: 0, deviation: 0, added: [], missing: [], relabelled: [] },
      { index: 1, start_ms: 2000, deviation: 0, added: [], missing: [], relabelled: [] },
      { index: 2, start_ms: 4000, deviation: 0.1, added: [], missing: [{ row: 'hat', step: 6 }], relabelled: [] },
      { index: 3, start_ms: 6000, deviation: 0, added: [], missing: [], relabelled: [] },
    ],
    exact_repeats: 3,
    variant_repeats: 1,
    ...over,
  };
}

const OPTS = { name: 'Drum grooves', layerColor: '#eab308', importedFrom: 'drum-kit-pattern' };

describe('riffLayerFromDrumGrooves', () => {
  it('gives each drum its own node and its own instance', () => {
    const layer = riffLayerFromDrumGrooves([groove()], BPM, OPTS)!;
    expect(layer).not.toBeNull();
    expect(layer.nodes!).toHaveLength(3);
    expect(layer.nodes!.map((n) => n.name)).toEqual([
      'Groove A · Kick', 'Groove A · Snare', 'Groove A · Hat',
    ]);
    expect(layer.items).toHaveLength(3);
  });

  it('places the three instances over the same bars, so the lane stacks them', () => {
    const layer = riffLayerFromDrumGrooves([groove()], BPM, OPTS)!;
    const starts = new Set(layer.items.map((i) => i.start));
    const ends = new Set(layer.items.map((i) => i.end));
    expect(starts.size).toBe(1);
    expect(ends.size).toBe(1);
    expect([...starts][0]).toBe(0);
  });

  it('keeps each drum on its own steps', () => {
    const layer = riffLayerFromDrumGrooves([groove()], BPM, OPTS)!;
    const byName = Object.fromEntries(layer.nodes!.map((n) => [n.name, n.highlightedBeats]));
    expect(byName['Groove A · Kick']).toEqual([0, 8]);
    expect(byName['Groove A · Snare']).toEqual([4, 12]);
    expect(byName['Groove A · Hat']).toEqual([2, 6, 10, 14]);
  });

  it('sizes the node grid from the bar length, not a default', () => {
    const layer = riffLayerFromDrumGrooves([groove()], BPM, OPTS)!;
    for (const n of layer.nodes!) {
      expect(n.stepsPerCycle).toBe(16);   // 4 beats × 4 sixteenths
      expect(n.subbeatsPerBeat).toBe(4);
    }
  });

  it('carries the repeat count onto every instance', () => {
    const layer = riffLayerFromDrumGrooves([groove()], BPM, OPTS)!;
    for (const item of layer.items) expect(item.repeatCount).toBe(4);
  });

  it('reuses the same nodes when a groove returns later in the song', () => {
    const later = groove({ start_ms: 32000, occurrences: [] });
    const layer = riffLayerFromDrumGrooves([groove(), later], BPM, OPTS)!;
    // Two runs of groove A: still three nodes, but six instances.
    expect(layer.nodes!).toHaveLength(3);
    expect(layer.items).toHaveLength(6);
    const kickNode = layer.nodes!.find((n) => n.name === 'Groove A · Kick')!;
    const kickItems = layer.items.filter((i) => i.sequence[0].type === kickNode.id);
    expect(kickItems).toHaveLength(2);
  });

  it('gives a different groove its own nodes', () => {
    const b = groove({
      groove: 'B',
      start_ms: 32000,
      rows: [{ row: 'kick', highlighted_beats: [0, 4, 8, 12] }],
    });
    const layer = riffLayerFromDrumGrooves([groove(), b], BPM, OPTS)!;
    expect(layer.nodes!).toHaveLength(4);
    expect(layer.nodes!.map((n) => n.name)).toContain('Groove B · Kick');
  });

  it('skips a drum that never plays rather than drawing an empty row', () => {
    const noHat = groove({
      rows: [
        { row: 'kick', highlighted_beats: [0, 8] },
        { row: 'snare', highlighted_beats: [4, 12] },
        { row: 'hat', highlighted_beats: [] },
      ],
    });
    const layer = riffLayerFromDrumGrooves([noHat], BPM, OPTS)!;
    expect(layer.nodes!).toHaveLength(2);
    expect(layer.nodes!.map((n) => n.name)).not.toContain('Groove A · Hat');
  });

  it('renders an older single-row pattern as one unnamed node', () => {
    // What drum_pattern.py and every curated_*_pattern layer on disk emit:
    // highlighted_beats and no rows.
    const legacy: GrooveItem = {
      start_ms: 0, duration_ms: 2000, repeat_count: 3, steps_per_cycle: 16,
      groove: 'A', highlighted_beats: [0, 4, 8, 12],
    };
    const layer = riffLayerFromDrumGrooves([legacy], BPM, OPTS)!;
    expect(layer).not.toBeNull();
    expect(layer.nodes!).toHaveLength(1);
    expect(layer.nodes![0].name).toBe('Groove A');
    expect(layer.nodes![0].highlightedBeats).toEqual([0, 4, 8, 12]);
    expect(layer.items[0].repeatCount).toBe(3);
  });

  it('carries each step\'s velocity onto the node as an accent', () => {
    const layer = riffLayerFromDrumGrooves([groove()], BPM, OPTS)!;
    const hat = layer.nodes!.find((n) => n.name === 'Groove A · Hat')!;
    // accents[] is positional against highlighted_beats: steps 2,6,10,14 at 70.
    expect(hat.accents).toEqual({ 2: 70, 6: 70, 10: 70, 14: 70 });
    const kick = layer.nodes!.find((n) => n.name === 'Groove A · Kick')!;
    expect(kick.accents).toEqual({ 0: 120, 8: 118 });
  });

  it('leaves accents off a pattern that measured none', () => {
    const noVel = groove({
      rows: [{ row: 'kick', highlighted_beats: [0, 8] }],
    });
    const layer = riffLayerFromDrumGrooves([noVel], BPM, OPTS)!;
    expect(layer.nodes![0].accents).toBeUndefined();
  });

  it('returns null without a bpm, so the caller can fall back', () => {
    expect(riffLayerFromDrumGrooves([groove()], undefined, OPTS)).toBeNull();
    expect(riffLayerFromDrumGrooves([groove()], 0, OPTS)).toBeNull();
  });

  it('returns null when nothing was detected', () => {
    expect(riffLayerFromDrumGrooves([], BPM, OPTS)).toBeNull();
    expect(riffLayerFromDrumGrooves([groove({ rows: [] })], BPM, OPTS)).toBeNull();
  });

  it('items come out in time order', () => {
    const layer = riffLayerFromDrumGrooves(
      [groove({ start_ms: 32000 }), groove({ start_ms: 0 })], BPM, OPTS,
    )!;
    const starts = layer.items.map((i) => i.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });
});

describe('describeVariants', () => {
  it('names the repeat and the step that changed, for that drum only', () => {
    const text = describeVariants(groove(), 'hat');
    expect(text).toContain('4 repeats · 3 exact, 1 with variations');
    expect(text).toContain('repeat 3: -6');
  });

  it('says so when a drum is identical throughout', () => {
    const text = describeVariants(groove(), 'kick');
    expect(text).toContain('identical in every repeat');
    expect(text).not.toContain('repeat 3');
  });

  it('reports an added hit separately from a dropped one', () => {
    const g = groove({
      occurrences: [
        { index: 0, start_ms: 0, deviation: 0, added: [], missing: [], relabelled: [] },
        {
          index: 1, start_ms: 2000, deviation: 0.2,
          added: [{ row: 'kick', step: 14 }], missing: [{ row: 'kick', step: 8 }],
          relabelled: [],
        },
      ],
    });
    const text = describeVariants(g, 'kick');
    expect(text).toContain('repeat 2: -8 +14');
  });
});

/**
 * The block on the canvas is a few bars wide and the name is truncated hard.
 * Whatever survives the truncation is all a person gets, so the drum has to be
 * in the readable part — and the name must not spend its first twelve
 * characters saying "Groove" twice.
 */
describe('node names', () => {
  const rows = [
    { row: 'kick', highlighted_beats: [0, 4, 8, 12] },
    { row: 'snare', highlighted_beats: [4, 12] },
  ];

  function build(items: GrooveItem[]) {
    return riffLayerFromDrumGrooves(items, 120, {
      name: 'Drum grooves', layerColor: '#38bdf8', importedFrom: 'kit_groove_detector',
    });
  }

  it('names a node from the motif, not the run label', () => {
    const layer = build([{
      start_ms: 0, duration_ms: 2000, repeat_count: 4, steps_per_cycle: 16,
      label: 'Drum groove A (10 hits/bar)', motif: 'A', rows,
    }]);
    expect(layer!.nodes!.map((n) => n.name)).toEqual(['Groove A · Kick', 'Groove A · Snare']);
  });

  it('falls back to the label when a detector sends no motif', () => {
    // Older cached envelopes have no `motif` — they must still read sanely,
    // and above all must not gain a second "Groove".
    const layer = build([{
      start_ms: 0, duration_ms: 2000, repeat_count: 4, steps_per_cycle: 16,
      label: 'Drum groove A (10 hits/bar)', rows,
    }]);
    for (const node of layer!.nodes!) {
      expect(node.name).not.toMatch(/Groove.*groove/i);
      expect(node.name).toContain('Drum groove A');
    }
  });

  it('keeps two runs of one motif apart when their bars differ', () => {
    // The generator groups by similarity, not equality: groove A can come back
    // playing a different bar. Sharing a node would draw the first run's steps
    // over the second run, and the lane would be quietly lying.
    const layer = build([
      { start_ms: 0, duration_ms: 2000, repeat_count: 2, steps_per_cycle: 16,
        label: 'Drum groove A (4 hits/bar)', motif: 'A',
        rows: [{ row: 'kick', highlighted_beats: [0, 4, 8, 12] }] },
      { start_ms: 4000, duration_ms: 2000, repeat_count: 2, steps_per_cycle: 16,
        label: 'Drum groove A (2 hits/bar)', motif: 'A',
        rows: [{ row: 'kick', highlighted_beats: [0, 8] }] },
    ]);
    expect(layer!.nodes).toHaveLength(2);
    expect(layer!.nodes![0].highlightedBeats).not.toEqual(layer!.nodes![1].highlightedBeats);
    // ...and they cannot both be called "Groove A · Kick".
    expect(new Set(layer!.nodes!.map((n) => n.name)).size).toBe(2);
  });

  it('reuses one node when a motif returns playing the same bar', () => {
    const same = {
      duration_ms: 2000, repeat_count: 2, steps_per_cycle: 16,
      label: 'Drum groove A (4 hits/bar)', motif: 'A',
      rows: [{ row: 'kick', highlighted_beats: [0, 4, 8, 12] }],
    };
    const layer = build([{ ...same, start_ms: 0 }, { ...same, start_ms: 60000 }]);
    expect(layer!.nodes).toHaveLength(1);
    expect(layer!.items).toHaveLength(2);
  });
});
