import { describe, it, expect } from 'vitest';
import type { AnnotationLayer } from '../types/annotationLayer';
import { copyFingerprint, sameCopy } from './copyFingerprint';
import {
  newRiffNode,
  newRiffPatternItem,
  newRiffPatternLayer,
  newRiffSeqEntry,
  type RiffOccurrence,
} from '../types/annotationLayer';

/** Hat groove A on the &s, three bars; the second adds a hat on beat 3. */
const FILL: RiffOccurrence = { index: 1, event: 'fill', added: [{ start: 2, end: 2.25 }] };

/** A copy of the detector's hat lane, as the ⬇ makes one: every id fresh. */
const copy = (occurrences: RiffOccurrence[] = [FILL]): AnnotationLayer<'riff-patterns'> => {
  const node = {
    ...newRiffNode('A', '#fff', 4),
    segments: [2, 6, 10, 14].map((st) => ({ start: st / 4, end: (st + 1) / 4, kind: 'tick' as const })),
  };
  const item = {
    ...newRiffPatternItem(0, 2, 'A'), sequence: [newRiffSeqEntry(node.id, 16)], repeatCount: 3,
    ...(occurrences.length ? { occurrences } : {}),
  };
  return {
    ...newRiffPatternLayer('Hi-hat pattern', '#fff'),
    source: 'user', importedFrom: 'Hi-hat pattern', drum: 'hat', nodes: [node], items: [item],
  };
};
/** As it comes back from disk: through JSON, with beat stamps added. */
const saved = (l: AnnotationLayer): AnnotationLayer => {
  const back = JSON.parse(JSON.stringify(l));
  back.items = back.items.map((it: { start: number }) => ({ ...it, startBeat: it.start * 2, endBeat: 0 }));
  return back;
};

describe('sameCopy', () => {
  it('finds a groove copied a second time with nothing changed, though every id differs', () => {
    const first = saved(copy());
    const second = copy();
    expect(second.id).not.toBe(first.id);
    expect(sameCopy(second, [first])).toBe(first);
  });

  it('makes a new copy once the first one was edited', () => {
    const first = saved(copy());
    const edited = { ...first, items: first.items.slice(1) } as AnnotationLayer;
    expect(sameCopy(copy(), [edited])).toBeNull();
  });

  it('tells copies apart by how their bars were played', () => {
    const first = saved(copy());
    expect(sameCopy(copy([]), [first])).toBeNull();
    expect(sameCopy(copy([{ ...FILL, index: 2 }]), [first])).toBeNull();
  });

  it('only compares copies of the same source, of the same kind, of your own', () => {
    const first = saved(copy());
    expect(sameCopy(copy(), [{ ...first, importedFrom: 'Snare pattern' }])).toBeNull();
    expect(sameCopy(copy(), [{ ...first, readOnly: true }])).toBeNull();
  });

  it('reads plain items without their ids, beat stamps or float noise', () => {
    const a = { type: 'spans', importedFrom: 'x', items: [{ id: '1', start: 1.0001, end: 2, label: 'A' }] } as unknown as AnnotationLayer;
    const b = { type: 'spans', importedFrom: 'x', items: [{ id: '2', start: 1.0002, end: 2, label: 'A', startBeat: 2 }] } as unknown as AnnotationLayer;
    expect(copyFingerprint(a)).toBe(copyFingerprint(b));
    const c = { ...b, items: [{ id: '3', start: 1, end: 2, label: 'B' }] } as unknown as AnnotationLayer;
    expect(copyFingerprint(a)).not.toBe(copyFingerprint(c));
  });
});
