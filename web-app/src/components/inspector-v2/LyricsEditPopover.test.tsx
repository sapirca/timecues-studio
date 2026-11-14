/**
 * Every lyric is a span, so its card always shows End — a word as much as a
 * line, including one that was stored without an end. And a lyric carries a
 * description like any other item: the card shows it and writes it back.
 * And a lyric made on the wrong lane moves to another from the card's header.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { LyricsEditPopover } from './LyricsEditPopover';
import { SettingsProvider } from '../../context/SettingsContext';
import type { AnnotationLayer, LyricsItem } from '../../types/annotationLayer';
import type { CardLaneMove } from './shared/AnnotationPointCard';

const layer = { id: 'L', name: 'Lyrics', type: 'lyrics', visible: true, color: '#a78bfa', snap: 'off', items: [] } as unknown as AnnotationLayer<'lyrics'>;

function open(item: LyricsItem, onChange = vi.fn(), laneMove?: CardLaneMove) {
  render(
    <SettingsProvider>
      <LyricsEditPopover
        layer={layer} item={item}
        popoverRef={createRef<HTMLDivElement>()} positionStyle={{}}
        onChange={onChange} onDelete={() => {}} onClose={() => {}}
        laneMove={laneMove}
      />
    </SettingsProvider>,
  );
}

describe('LyricsEditPopover', () => {
  beforeEach(() => { try { window.localStorage.clear(); } catch { /* no storage */ } });

  it('shows End for a word', () => {
    open({ id: 'w', time: 39.76, end: 39.78, text: 'עם', kind: 'word' });
    expect(screen.getByText('End')).toBeTruthy();
  });

  it('shows End for a word stored without one', () => {
    open({ id: 'w', time: 10, text: 'la', kind: 'word' });
    expect(screen.getByText('End')).toBeTruthy();
  });

  it('shows a lyric\'s description and writes an edit back onto it', () => {
    const onChange = vi.fn();
    open({ id: 'w', time: 48.66, end: 51.82, text: 'זהוב,', kind: 'word', description: 'gold, sung long' }, onChange);
    expect(screen.getByText('Description')).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue('gold, sung long'), { target: { value: 'gold' } });
    expect(onChange).toHaveBeenCalledWith({ description: 'gold' });
  });

  it('names its lane as plain text when there is nowhere to move it', () => {
    open({ id: 'w', time: 1, end: 2, text: 'la', kind: 'word' });
    expect(screen.queryByRole('combobox', { name: /Move to another lane/ })).toBeNull();
    expect(screen.getByText('Lyrics')).toBeTruthy();
  });

  it('moves the lyric to the lane picked in the header', () => {
    const onMove = vi.fn();
    open({ id: 'w', time: 1, end: 2, text: 'la', kind: 'word' }, vi.fn(), {
      targets: [{ id: 'L2', name: 'Ivrit lyrics' }],
      onMove,
    });
    const picker = screen.getByRole('combobox', { name: /Lane: Lyrics/ });
    expect(screen.getByRole('option', { name: 'Ivrit lyrics' })).toBeTruthy();
    fireEvent.change(picker, { target: { value: 'L2' } });
    expect(onMove).toHaveBeenCalledWith('L2');
  });
});
