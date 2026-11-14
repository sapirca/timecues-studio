import { describe, expect, it } from 'vitest';
import { formatDetectorRun } from './detectorRunLog';
import type { CustomResultEnvelope } from '../types/customScript';

const base: CustomResultEnvelope = {
  name: 'drum_grooves', slug: 'song', output_kind: 'span', ran_at: '2026-09-25T13:00:00+00:00',
  duration_ms: 3400, items: [], errors: [], notes: [], stats: { accepted: 0, rejected: 0 }, fatal: null,
};

describe('formatDetectorRun', () => {
  it('a failed run shows the error, how to fix it, and the traceback', () => {
    const text = formatDetectorRun('Drum grooves', {
      ...base,
      fatal: {
        type: 'ModuleNotFoundError', message: "No module named 'madmom'",
        traceback: 'Traceback (most recent call last):\n  File "x.py", line 1\nModuleNotFoundError\n',
        suggested_install: 'pip install madmom',
      },
    });
    expect(text).toContain('▶ Drum grooves');
    expect(text).toContain("✗ failed — ModuleNotFoundError: No module named 'madmom'");
    expect(text).toContain('to fix: pip install madmom');
    expect(text).toContain('    Traceback (most recent call last):');
  });

  it('a run that found nothing says so, with its notes and rejected items', () => {
    const text = formatDetectorRun('Rolls', {
      ...base,
      strictness: 'loose',
      notes: [{ code: 'quiet', message: 'The drum stem is nearly silent.' }],
      errors: [{ index: 2, field: 'end_ms', value: 1, message: 'end_ms must be after start_ms' }],
    });
    expect(text).toContain('✓ nothing found in 3.4s at strictness Loose');
    expect(formatDetectorRun('Pulse', { ...base, strictness: 70 })).toContain('at strictness 70');
    expect(text).toContain('note: The drum stem is nearly silent.');
    expect(text).toContain('rejected 1 item:');
    expect(text).toContain('#2 end_ms: end_ms must be after start_ms');
  });
});
