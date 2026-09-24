/**
 * A hand-placed cue can carry velocity, level and colour exactly like a
 * detector's — the Hit section is where they are set, changed and cleared.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { CueEditPopover } from './CueEditPopover';
import { SettingsProvider } from '../../context/SettingsContext';
import type { AnnotationLayer, CueItem } from '../../types/annotationLayer';

const layer = { id: 'L', name: 'Hits', type: 'cues', visible: true, color: '#eab308', snap: 'beat', items: [] } as unknown as AnnotationLayer<'cues'>;

function open(cue: CueItem, onChange = vi.fn()) {
  render(
    <SettingsProvider>
      <CueEditPopover
        layer={layer} cue={cue}
        popoverRef={createRef<HTMLDivElement>()} positionStyle={{}}
        onChange={onChange} onDelete={() => {}} onClose={() => {}}
      />
    </SettingsProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /^Hit/ }));
  return onChange;
}

describe('CueEditPopover Hit section', () => {
  beforeEach(() => { try { window.localStorage.clear(); } catch { /* no storage */ } });

  it('sets a velocity on a hand-placed cue', () => {
    const onChange = open({ id: 'c', time: 1, label: 'kick' });
    const v = screen.getByLabelText(/Velocity/);
    fireEvent.change(v, { target: { value: '90' } });
    fireEvent.blur(v);
    expect(onChange).toHaveBeenCalledWith({ velocity: 90 });
  });

  it('refuses a velocity outside 1-127 and a positive level', () => {
    const onChange = open({ id: 'c', time: 1, label: 'kick' });
    const v = screen.getByLabelText(/Velocity/);
    fireEvent.change(v, { target: { value: '200' } });
    fireEvent.blur(v);
    const l = screen.getByLabelText(/Level dB/);
    fireEvent.change(l, { target: { value: '3' } });
    fireEvent.blur(l);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clears a field back to "not set"', () => {
    const onChange = open({ id: 'c', time: 1, label: 'kick', velocity: 90 });
    const v = screen.getByLabelText(/Velocity/);
    fireEvent.change(v, { target: { value: '' } });
    fireEvent.blur(v);
    expect(onChange).toHaveBeenCalledWith({ velocity: undefined });
  });

  it('sets and resets the tick colour', () => {
    const onChange = open({ id: 'c', time: 1, label: 'kick', color: '#38bdf8' });
    fireEvent.change(screen.getByLabelText('Cue colour'), { target: { value: '#a3e635' } });
    expect(onChange).toHaveBeenCalledWith({ color: '#a3e635' });
    fireEvent.click(screen.getByRole('button', { name: 'reset' }));
    expect(onChange).toHaveBeenCalledWith({ color: undefined });
  });
});

describe('CueEditPopover Hit section — note and decay', () => {
  beforeEach(() => { try { window.localStorage.clear(); } catch { /* no storage */ } });

  it('sets a note and shows its name', () => {
    const onChange = open({ id: 'c', time: 1, label: 'kick', note: 36 });
    expect(screen.getAllByText('C2').length).toBe(2); // the section summary and the read-out beside the input
    const n = screen.getByLabelText(/^Note/);
    fireEvent.change(n, { target: { value: '38' } });
    fireEvent.blur(n);
    expect(onChange).toHaveBeenCalledWith({ note: 38 });
  });

  it('takes decay in ms and stores seconds', () => {
    const onChange = open({ id: 'c', time: 1, label: 'kick' });
    const d = screen.getByLabelText(/Decay ms/);
    fireEvent.change(d, { target: { value: '250' } });
    fireEvent.blur(d);
    expect(onChange).toHaveBeenCalledWith({ decay: 0.25 });
  });
});
