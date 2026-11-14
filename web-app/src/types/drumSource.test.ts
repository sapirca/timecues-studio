import { describe, expect, it } from 'vitest';
import { drumReadStale, type CustomResultEnvelope } from './customScript';

const env = (extra: Partial<CustomResultEnvelope>): CustomResultEnvelope => ({
  name: 'instrument_layers', slug: 's', output_kind: 'lanes', ran_at: '2026-10-08T00:00:00+00:00',
  duration_ms: 1, items: [], errors: [], stats: { accepted: 0, rejected: 0 }, fatal: null, ...extra,
});
const kit = (ranAt: string) => env({ name: 'drum_kit_split', ran_at: ranAt, lanes: [
  { id: 'kick', label: 'Kick', output_kind: 'cue', items: [] } as never] });

describe('drumReadStale', () => {
  it('is quiet while the lane read the kit run on screen', () => {
    expect(drumReadStale(env({ drum_read: { source: 'kit', kit_ran_at: 'A' } }), kit('A'))).toBeNull();
    expect(drumReadStale(env({ drum_read: { source: 'bands', kit_ran_at: null } }), undefined)).toBeNull();
  });

  it('speaks when the kit was split after the lane was read, split again, or removed', () => {
    expect(drumReadStale(env({ drum_read: { source: 'bands', kit_ran_at: null } }), kit('A'))).toMatch(/before the kit was split/);
    expect(drumReadStale(env({ drum_read: { source: 'kit', kit_ran_at: 'A' } }), kit('B'))).toMatch(/split again/);
    expect(drumReadStale(env({ drum_read: { source: 'kit', kit_ran_at: 'A' } }), undefined)).toMatch(/no longer there/);
  });

  it('never for a lane pinned to the bands, a run that never looked for the kit, or an old run', () => {
    expect(drumReadStale(env({ drum_source: 'bands', drum_read: { source: 'bands' } }), kit('A'))).toBeNull();
    expect(drumReadStale(env({ drum_read: { source: 'bands' } }), kit('A'))).toBeNull();
    expect(drumReadStale(env({}), kit('A'))).toBeNull();
  });

  it('a failed kit run is no kit', () => {
    expect(drumReadStale(env({ drum_read: { source: 'bands', kit_ran_at: null } }),
      { ...kit('A'), fatal: { type: 'X', message: 'boom', traceback: '' } })).toBeNull();
  });
});
