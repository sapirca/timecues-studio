import { describe, expect, it } from 'vitest';
import type { CustomRegistryEntry } from '../types/customScript';
import { foldPerStem, parseStemAttr, runNameFor, setStemInCode } from './detectorStems';

const SRC = (stemLine: string) => `from custom_api import CustomDetector

class Trade(CustomDetector):
    name = "trade"
    label = "Trade"
${stemLine}
    def detect(self, ctx):
        return []
`;

function entry(over: Partial<CustomRegistryEntry>): CustomRegistryEntry {
  return {
    name: 'x', file: '/x.py', status: 'ok', label: 'X', output_kind: 'span', is_annotation: false,
    description: '', version: '0.1', stem: null, errors: [], ...over,
  } as CustomRegistryEntry;
}

describe('runNameFor', () => {
  it('suffixes a stem and leaves the mix bare', () => {
    expect(runNameFor('trade', 'vocals')).toBe('trade__vocals');
    expect(runNameFor('trade', 'mix')).toBe('trade');
    expect(runNameFor('trade', null)).toBe('trade');
  });
});

describe('foldPerStem', () => {
  it('folds a per-stem detector into one entry named by its file, in place', () => {
    const list = [
      entry({ name: 'alpha' }),
      entry({ name: 'trade__vocals', base_name: 'trade', stem: 'vocals', stems: ['vocals', 'other'] }),
      entry({ name: 'trade__other', base_name: 'trade', stem: 'other', stems: ['vocals', 'other'] }),
      entry({ name: 'zeta', base_name: 'zeta', stem: 'bass', stems: null }),
    ];
    const folded = foldPerStem(list);
    expect(folded.map((e) => e.name)).toEqual(['alpha', 'trade', 'zeta']);
    expect(folded[1].stem).toBeNull();
    expect(folded[1].stems).toEqual(['vocals', 'other']);
    expect(folded[2].stem).toBe('bass');
  });
});

describe('parseStemAttr', () => {
  it('reads one stem, a list, and nothing', () => {
    expect(parseStemAttr(SRC('    stem = "vocals"'))).toEqual({ kind: 'stems', stems: ['vocals'] });
    expect(parseStemAttr(SRC("    stem = ['vocals', \"other\"]  # not bass"))).toEqual({ kind: 'stems', stems: ['vocals', 'other'] });
    expect(parseStemAttr(SRC(''))).toEqual({ kind: 'absent' });
    expect(parseStemAttr(SRC('    stem = None'))).toEqual({ kind: 'absent' });
  });

  it('leaves what it cannot rewrite safely to the code', () => {
    expect(parseStemAttr(SRC('    stem = STEMS')).kind).toBe('unparsed');
    expect(parseStemAttr(SRC('    stem = ["vocals", "vox"]')).kind).toBe('unparsed');
    expect(parseStemAttr(SRC('    stem = [')).kind).toBe('unparsed');
  });

  it('does not mistake stem_parts for stem', () => {
    expect(parseStemAttr(SRC('    stem_parts = {"drums": ["Kick"]}'))).toEqual({ kind: 'absent' });
  });
});

describe('setStemInCode', () => {
  it('writes one stem as a string and several as a list, in picker order', () => {
    const one = setStemInCode(SRC('    stem = ["vocals", "other"]  # keep me'), ['other']);
    expect(one).toContain('    stem = "other"  # keep me');
    const many = setStemInCode(SRC('    stem = "other"'), ['other', 'vocals']);
    expect(many).toContain('    stem = ["vocals", "other"]');
    expect(parseStemAttr(many)).toEqual({ kind: 'stems', stems: ['vocals', 'other'] });
  });

  it('inserts the line after the class header when there is none', () => {
    const out = setStemInCode(SRC(''), ['bass']);
    expect(out).toContain('class Trade(CustomDetector):\n    stem = "bass"\n');
  });

  it('refuses an empty pick rather than write a stemless list', () => {
    const src = SRC('    stem = "vocals"');
    expect(setStemInCode(src, [])).toBe(src);
  });
});
