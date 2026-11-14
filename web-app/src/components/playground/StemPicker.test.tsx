import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StemPicker } from './StemPicker';

describe('StemPicker', () => {
  it('shows the ticked stems and adds one', () => {
    const onChange = vi.fn();
    render(<StemPicker parsed={{ kind: 'stems', stems: ['vocals'] }} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'vocals' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'other' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'other' }));
    expect(onChange).toHaveBeenCalledWith(['vocals', 'other']);
  });

  it('removes a stem but never the last one', () => {
    const onChange = vi.fn();
    const { rerender } = render(<StemPicker parsed={{ kind: 'stems', stems: ['vocals', 'other'] }} onChange={onChange} />);
    expect(screen.getByText('Runs once per stem — one lane each.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'vocals' }));
    expect(onChange).toHaveBeenLastCalledWith(['other']);

    rerender(<StemPicker parsed={{ kind: 'stems', stems: ['other'] }} onChange={onChange} />);
    const last = screen.getByRole('button', { name: 'other' }) as HTMLButtonElement;
    expect(last.disabled).toBe(true);
  });

  it('reads no stem line as the mix', () => {
    render(<StemPicker parsed={{ kind: 'absent' }} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'mix' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('(default: mix)')).toBeTruthy();
  });

  it('leaves a line it cannot rewrite to the code', () => {
    render(<StemPicker parsed={{ kind: 'unparsed', text: 'STEMS' }} onChange={() => {}} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('STEMS')).toBeTruthy();
  });
});
