import { describe, it, expect } from 'vitest';
import { gateAlgoOverlay } from './InspectorPageV2';

// The rule this pins: a row ticked BY NAME always draws, whichever stem the
// filter is on — except a full-mix row, which the filter can still veto. That
// asymmetry is deliberate (the filter has to mean something for mix rows), and
// it is exactly the state the picker has to explain out loud, so 'filtered' is
// a distinct verdict rather than a bare false.
const sel = (...ids: string[]) => new Set(ids);

describe('gateAlgoOverlay', () => {
  it('leaves a row nobody asked for alone', () => {
    expect(gateAlgoOverlay('whisper-base', sel(), 'all')).toBe('unticked');
    expect(gateAlgoOverlay('whisper-base__vocals', sel(), 'vocals')).toBe('unticked');
  });

  it('draws a per-stem row ticked by name whatever the filter says', () => {
    for (const filter of ['all', 'mix', 'vocals', 'drums'] as const) {
      expect(gateAlgoOverlay('whisper-base__vocals', sel('whisper-base__vocals'), filter)).toBe('shown');
    }
  });

  it('lets a stem variant ride along on its base tick, subject to the filter', () => {
    const s = sel('whisper-base');
    expect(gateAlgoOverlay('whisper-base__vocals', s, 'all')).toBe('shown');
    expect(gateAlgoOverlay('whisper-base__vocals', s, 'vocals')).toBe('shown');
    expect(gateAlgoOverlay('whisper-base__vocals', s, 'drums')).toBe('filtered');
    expect(gateAlgoOverlay('whisper-base__vocals', s, 'mix')).toBe('filtered');
  });

  it('vetoes a ticked full-mix row under a single-stem filter', () => {
    const s = sel('whisper-base');
    expect(gateAlgoOverlay('whisper-base', s, 'all')).toBe('shown');
    expect(gateAlgoOverlay('whisper-base', s, 'mix')).toBe('shown');
    // The reported case: both Whisper rows ticked, filter on vocals, and only
    // the vocals lane appears.
    expect(gateAlgoOverlay('whisper-base', s, 'vocals')).toBe('filtered');
  });

  it('treats a boundary row with no stem suffix as full mix', () => {
    expect(gateAlgoOverlay('msaf-olda', sel('msaf-olda'), 'vocals')).toBe('filtered');
    expect(gateAlgoOverlay('msaf-olda', sel('msaf-olda'), 'mix')).toBe('shown');
  });
});
