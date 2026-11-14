import { describe, expect, it } from 'vitest';
import { convertDetectorItems, detectorSpanFields, planDetectorAutoCopy } from './detectorConvert';
import type { BoundaryItem } from '../../types/annotationLayer';
import { parseEnergySpanExport } from '../../utils/energySpan';
import type { SpanItem } from '../../types/annotationLayer';
import type { CustomSpanItem } from '../../types/customScript';

const blob = JSON.stringify({
  type: 'energy_span', song: 's', stem: 'mix', start_ms: 1000, end_ms: 3000, duration_ms: 2000,
  trend: 'increasing', start_energy: 0.2, end_energy: 0.9,
  brightness_trend: 'increasing', brightness_hz: { start: 900, end: 3000, peak: 3100 },
  curve: [{ t_ms: 0, energy: 0.2 }, { t_ms: 2000, energy: 0.9 }],
  envelope: null, envelope_rejected: null, description: 'rises',
});

describe('convertDetectorItems — spans', () => {
  it('keeps a detector span\'s ⚡ Energy blob, so the copy still draws its envelope', () => {
    const [span] = convertDetectorItems('spans', [
      { start_ms: 1000, duration_ms: 2000, label: 'Rise', intensity: 0.8, description: blob },
    ]) as SpanItem[];
    expect(span.description).toBe(blob);
    expect(parseEnergySpanExport(span.description)?.trend).toBe('increasing');
  });

  it('adds no description to a span that had none', () => {
    const [span] = convertDetectorItems('spans', [
      { start_ms: 0, duration_ms: 500, label: 'vox', intensity: null },
    ]) as SpanItem[];
    expect('description' in span).toBe(false);
  });

  it('keeps a detector pulse, so the copy still has its chip and ticks', () => {
    const [span] = convertDetectorItems('spans', [
      { start_ms: 0, duration_ms: 500, label: '1/2 beat', intensity: null, pulse: '8th' },
    ]) as SpanItem[];
    expect(span.pulse).toBe('8th');
  });
});

const detectorSpan = (extra: Partial<CustomSpanItem> = {}): CustomSpanItem => ({
  start_ms: 1500, duration_ms: 2000, label: 'drums · 8 bars', intensity: 1, ...extra,
});

describe('detectorSpanFields', () => {
  it('carries a detector pulse into the Pulse field', () => {
    expect(detectorSpanFields(detectorSpan({ pulse: '16th' }))).toEqual({
      start: 1.5, end: 3.5, label: 'drums · 8 bars', pulse: '16th',
    });
  });

  it('keeps silent, which is an answer rather than a missing one', () => {
    expect(detectorSpanFields(detectorSpan({ pulse: 'silent' })).pulse).toBe('silent');
  });

  it('leaves pulse unset when the detector did not set one', () => {
    expect('pulse' in detectorSpanFields(detectorSpan())).toBe(false);
  });

  it('drops a value the picker has no chip for', () => {
    const odd = detectorSpan({ pulse: 'quarter' as CustomSpanItem['pulse'] });
    expect('pulse' in detectorSpanFields(odd)).toBe(false);
  });
});

describe('convertDetectorItems — boundaries', () => {
  const at = (time_ms: number, label: string | null, extra = {}) => ({
    time_ms, label, importance: null, candidates: null, ...extra,
  });

  it('converts a detector boundary into a layer item, in seconds', () => {
    const [b] = convertDetectorItems('boundaries', [at(15_600, '+bass')]) as BoundaryItem[];
    expect(b.time).toBeCloseTo(15.6);
    expect(b.label).toBe('+bass');
    expect(b.id).toBeTruthy();
  });

  it('reads a section name in the vocabulary as that type', () => {
    const [b] = convertDetectorItems('boundaries', [at(0, 'chorus')]) as BoundaryItem[];
    expect(b.type).toBe('chorus');
  });

  it('lands an unrecognised label on unset, keeping what was written', () => {
    const [b] = convertDetectorItems('boundaries', [at(0, '+bass +drums')]) as BoundaryItem[];
    expect(b.type).toBe('unset');
    expect(b.label).toBe('+bass +drums');
  });

  it('keeps a colour the detector set', () => {
    const [own, plain] = convertDetectorItems('boundaries', [
      at(0, 'intro', { color: '#f87171' }),
      at(1000, 'drop'),
    ]) as BoundaryItem[];
    expect(own.color).toBe('#f87171');
    expect(plain.color).toBeUndefined();
  });

  it('converts candidate times to seconds', () => {
    const [b] = convertDetectorItems('boundaries', [
      at(2000, 'drop', { candidates: [1900, 2100] }),
    ]) as BoundaryItem[];
    expect(b.candidates).toEqual([1.9, 2.1]);
  });
});

describe('planDetectorAutoCopy', () => {
  const det = { name: 'rolls', label: 'Rhythmic rolls', output_kind: 'span' as const, is_annotation: true };
  const env = { fatal: null, items: [{ start_ms: 0, duration_ms: 1000 }] };

  it('copies a run of an is_annotation detector into a layer of its kind', () => {
    expect(planDetectorAutoCopy(det, env, [])).toEqual({ category: 'spans', label: 'Rhythmic rolls', held: false });
    expect(planDetectorAutoCopy({ ...det, output_kind: 'boundary' }, env, [])?.category).toBe('boundaries');
  });

  it('does nothing without the flag, on a failed or empty run, or for a riff', () => {
    expect(planDetectorAutoCopy({ ...det, is_annotation: false }, env, [])).toBeNull();
    expect(planDetectorAutoCopy(undefined, env, [])).toBeNull();
    expect(planDetectorAutoCopy(det, { fatal: { code: 'x', message: 'boom' } as never, items: [] }, [])).toBeNull();
    expect(planDetectorAutoCopy(det, { fatal: null, items: [] }, [])).toBeNull();
    expect(planDetectorAutoCopy({ ...det, output_kind: 'riff' }, env, [])).toBeNull();
  });

  it('leaves a copy the annotator already holds alone, by hand or accepted-only', () => {
    expect(planDetectorAutoCopy(det, env, [{ importedFrom: 'Rhythmic rolls' }])?.held).toBe(true);
    expect(planDetectorAutoCopy(det, env, [{ importedFrom: 'Rhythmic rolls (✓ accepted)' }])?.held).toBe(true);
    expect(planDetectorAutoCopy(det, env, [{ importedFrom: 'Pulse' }, {}])?.held).toBe(false);
  });

  it('names the copy after the name when the detector has no label', () => {
    expect(planDetectorAutoCopy({ ...det, label: '' }, env, [])?.label).toBe('rolls');
  });
});
