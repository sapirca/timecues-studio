import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SettingsProvider, useSettings } from './SettingsContext';

// Separations default to 4 stems since 2026-09-27. A store saved before that
// holds '6s' and would outrank the new default, so it is flipped once — and
// only once, so choosing 6 stems again afterwards sticks.
const KEY = 'timecues.settings.v1';
const wrapper = ({ children }: { children: ReactNode }) => (
  <SettingsProvider>{children}</SettingsProvider>
);

function stemModelFor(stored: object | null) {
  if (stored) localStorage.setItem(KEY, JSON.stringify(stored));
  const { result } = renderHook(() => useSettings(), { wrapper });
  return result.current.settings.defaultStemModel;
}

afterEach(() => { cleanup(); localStorage.clear(); });

describe('defaultStemModel', () => {
  it('is 4 stems for someone with no saved settings', () => {
    expect(stemModelFor(null)).toBe('4s');
  });

  it('flips a 6-stem choice saved before the change', () => {
    expect(stemModelFor({ defaultStemModel: '6s' })).toBe('4s');
  });

  it('keeps 6 stems chosen after the change', () => {
    expect(stemModelFor({ defaultStemModel: '6s', _fourStemsDefaultMigrated: true })).toBe('6s');
  });
});
