import { describe, expect, it } from 'vitest';
import { layerMarkerCounts } from './layerMarkerCounts';

describe('layerMarkerCounts', () => {
  it('splits a cue lane by label, most frequent first', () => {
    const items = ['kick', 'snare', 'kick', 'hat', 'kick', 'snare', ' '].map((label, i) => ({ id: `c${i}`, time: i, label }));
    expect(layerMarkerCounts({ type: 'cues', items } as never)).toEqual({
      total: 7,
      noun: 'markers',
      kinds: [
        { kind: 'kick', count: 3 },
        { kind: 'snare', count: 2 },
        { kind: 'hat', count: 1 },
        { kind: 'unlabelled', count: 1 },
      ],
    });
  });

  it('counts a described label by its leading kind, not the whole description', () => {
    const items = ['Rise · bass · 1-bar climb', 'Rise · bass · 13-bar build', 'Fall · mix · fade'].map((label, i) => ({ id: `s${i}`, start: i, end: i + 1, label }));
    expect(layerMarkerCounts({ type: 'spans', items } as never).kinds).toEqual([
      { kind: 'Rise', count: 2 },
      { kind: 'Fall', count: 1 },
    ]);
  });

  it('splits a lyrics lane by words vs lines, not by the lyric text', () => {
    const items = [
      { id: 'a', time: 0, text: 'hello', kind: 'word' },
      { id: 'b', time: 1, text: 'world', kind: 'word' },
      { id: 'c', time: 0, text: 'hello world', kind: 'line' },
    ];
    expect(layerMarkerCounts({ type: 'lyrics', items } as never).kinds).toEqual([
      { kind: 'words', count: 2 },
      { kind: 'lines', count: 1 },
    ]);
  });

  it('reports an empty lane as zero with no kinds', () => {
    expect(layerMarkerCounts({ type: 'boundaries', items: [] } as never)).toEqual({ total: 0, noun: 'boundaries', kinds: [] });
  });
});
