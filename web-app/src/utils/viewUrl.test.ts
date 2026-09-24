import { describe, it, expect } from 'vitest';
import { parseViewUrl, writeViewUrl, type ViewUrlState } from './viewUrl';

const EMPTY: ViewUrlState = {
  song: null, type: null, kind: null, view: null, algos: [], dets: null, layers: null,
  signals: null, fams: null, stem: null, filter: null, lock: null, speed: null, unit: null, window: null,
};

describe('viewUrl', () => {
  it('round-trips everything it owns', () => {
    const state: ViewUrlState = {
      song: 'pantheon',
      type: null,
      kind: 'boundaries',
      view: 'algo',
      algos: ['msaf-sf', 'allin1'],
      dets: null, layers: null, signals: null, fams: null,
      stem: null, filter: null, lock: null, speed: null, unit: null,
      window: { start: 62.5, end: 78 },
    };
    const search = writeViewUrl('', state);
    expect(search).toBe('?song=pantheon&kind=boundaries&view=algo&algos=allin1%2Cmsaf-sf&t=62.50-78.00');
    expect(parseViewUrl(search)).toEqual({ ...state, algos: ['allin1', 'msaf-sf'] });
  });

  it('leaves parameters it does not own alone, and drops the ones that are now empty', () => {
    const search = writeViewUrl('?returnTo=x&t=1-2&algos=a', { ...EMPTY, song: 's' });
    expect(search).toBe('?returnTo=x&song=s');
  });

  it('writes nothing at all for a fresh view', () => {
    expect(writeViewUrl('', EMPTY)).toBe('');
  });

  it('drops what it cannot trust instead of guessing', () => {
    expect(parseViewUrl('?type=nope&kind=riff-patterns&view=x&t=9-3')).toEqual(EMPTY);
    expect(parseViewUrl('?t=abc').window).toBeNull();
    expect(parseViewUrl('?algos=,a,,b').algos).toEqual(['a', 'b']);
  });

  it('carries the stems, and says an empty set out loud', () => {
    const state: ViewUrlState = {
      ...EMPTY,
      song: 's',
      algos: ['librosa-onsets__drums'],
      dets: [],
      layers: ['manual'],
      signals: ['spectrogram', 'chroma'],
      fams: ['msaf', 'cue-extras'],
      stem: 'drums',
      filter: 'all',
      lock: false,
      speed: 0.5,
      unit: 'bar',
    };
    const search = writeViewUrl('', state);
    expect(search).toContain('dets=-');
    expect(search).toContain('lock=0');
    expect(parseViewUrl(search)).toEqual({
      ...state,
      signals: ['chroma', 'spectrogram'],
      fams: ['cue-extras', 'msaf'],
    });
  });

  it('leaves out what matches opening the song fresh', () => {
    const search = writeViewUrl('', { ...EMPTY, song: 's', stem: 'mix', filter: 'mix', lock: true, speed: 1, unit: 'beat' });
    expect(search).toBe('?song=s');
  });

  it('keeps unknown signals and layers out, but an unknown detector in', () => {
    const p = parseViewUrl('?signals=chroma,bogus&layers=manual,x&dets=my_curator');
    expect(p.signals).toEqual(['chroma']);
    expect(p.layers).toEqual(['manual']);
    expect(p.dets).toEqual(['my_curator']);
  });
});
