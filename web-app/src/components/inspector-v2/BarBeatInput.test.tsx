import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { BarBeatInput } from './BarBeatInput';
import { SettingsProvider } from '../../context/SettingsContext';

// The bar.beat field sits next to the seconds field on every annotation point
// card, so it has to both *render* and *parse* in the user's chosen numbering.
const GRID = { bpm: 120, gridOffset: 0, beatsPerBar: 4 };

function mount(origin: 0 | 1, value: number, onChange = vi.fn()) {
  // The sentinel marks this store as already past the zero-based migration,
  // so a deliberately chosen origin is what readStored() hands back.
  localStorage.setItem('timecues.settings.v1', JSON.stringify(
    { barBeatOrigin: origin, _barBeatOriginZeroMigrated: true }));
  render(
    <SettingsProvider>
      <BarBeatInput value={value} onChange={onChange} {...GRID} />
    </SettingsProvider>,
  );
  return { input: screen.getByRole('textbox') as HTMLInputElement, onChange };
}

afterEach(() => { cleanup(); localStorage.clear(); });

describe('BarBeatInput honours the bar/beat origin setting', () => {
  it('renders the first downbeat as 1.1 when bars start at 1', () => {
    const { input } = mount(1, 0);
    expect(input.value).toBe('1.1');
    expect(input.placeholder).toBe('1.1');
  });

  it('renders the same downbeat as 0.0 when bars start at 0', () => {
    const { input } = mount(0, 0);
    expect(input.value).toBe('0.0');
    expect(input.placeholder).toBe('0.0');
  });

  it('parses typed input in the active convention', () => {
    // 2 bars in at 120 BPM 4/4 = 4.0s — "3.1" one-based, "2.0" zero-based.
    const one = mount(1, 0);
    fireEvent.change(one.input, { target: { value: '3.1' } });
    fireEvent.blur(one.input);
    expect(one.onChange).toHaveBeenCalledWith(4);
    cleanup();

    const zero = mount(0, 0);
    fireEvent.change(zero.input, { target: { value: '2.0' } });
    fireEvent.blur(zero.input);
    expect(zero.onChange).toHaveBeenCalledWith(4);
  });
});
