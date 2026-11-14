import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PulseStepper } from './RiffLaneEditor';
import { pulseNoteName } from '../../utils/pitchedRiff';

// A node's pulse is a divider the annotator picks — 1/N of a beat, down to
// 1/64 notes — not a fixed menu of five.
afterEach(cleanup);

function mount(pulse: number, lengthBeats = 4) {
  const onPulse = vi.fn();
  render(<PulseStepper pulse={pulse} lengthBeats={lengthBeats} onPulse={onPulse} />);
  return { input: screen.getByRole('textbox') as HTMLInputElement, onPulse };
}

describe('pulseNoteName', () => {
  it('names straight steps as notes and triplets as triplets, the beat a quarter', () => {
    expect(pulseNoteName(1)).toBe('1/4 note');
    expect(pulseNoteName(4)).toBe('1/16 note');
    expect(pulseNoteName(8)).toBe('1/32 note');
    expect(pulseNoteName(16)).toBe('1/64 note');
    expect(pulseNoteName(3)).toBe('1/8 triplet');
    expect(pulseNoteName(6)).toBe('1/16 triplet');
    expect(pulseNoteName(12)).toBe('1/32 triplet');
    expect(pulseNoteName(5)).toBe('5 per beat');
  });
});

describe('PulseStepper', () => {
  it('takes a typed divider on Enter, up to 1/64 notes', () => {
    const { input, onPulse } = mount(4);
    expect(screen.getByText('beat · 1/16 note')).toBeTruthy();
    fireEvent.change(input, { target: { value: '16' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPulse).toHaveBeenCalledWith(16);
  });

  it('refuses a divider past the finest and shows the pulse again', () => {
    const { input, onPulse } = mount(4);
    fireEvent.change(input, { target: { value: '32' } });
    fireEvent.blur(input);
    expect(onPulse).not.toHaveBeenCalled();
    expect(input.value).toBe('4');
  });

  it('steps one divider at a time, skipping ones the length has no whole steps on', () => {
    const { onPulse } = mount(4, 1.25);
    // 1¼ beats: only 4, 8, 12 and 16 give a whole number of steps.
    fireEvent.click(screen.getByRole('button', { name: 'Finer pulse' }));
    expect(onPulse).toHaveBeenLastCalledWith(8);
    expect((screen.getByRole('button', { name: 'Coarser pulse' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
