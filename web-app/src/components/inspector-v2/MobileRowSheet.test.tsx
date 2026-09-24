/**
 * The phone's row sheet and the marks it can draw over a signal row.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { MobileRowSheet } from './MobileRowSheet';
import { SignalMarksOverlay } from './SignalMarksOverlay';

describe('MobileRowSheet', () => {
  const base = {
    target: { rowId: 'spectrogram', name: 'Spectrogram', color: '#8b5cf6' },
    onClose: () => {},
    shownSignals: new Set(['spectrogram', 'chroma']),
  };

  it('swaps a signal row to the one picked, and cannot "swap" to itself', () => {
    const onSwap = vi.fn();
    render(<MobileRowSheet {...base} onSwap={onSwap} />);
    expect(screen.getByRole('button', { name: /Spectrogram/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Tempogram/ }));
    expect(onSwap).toHaveBeenCalledWith('tempogram');
  });

  it('marks a signal that is already another row as "on"', () => {
    render(<MobileRowSheet {...base} onSwap={() => {}} />);
    expect(screen.getByRole('button', { name: /Chroma/ }).textContent).toMatch(/on$/);
  });

  it('offers no signal picker on a lane that is not a signal', () => {
    render(<MobileRowSheet {...base} target={{ rowId: 'cue-layer:x', name: 'Cues 1', color: '#fff' }} onSwap={() => {}} onMoveUp={() => {}} />);
    expect(screen.queryByText('Show in this row')).toBeNull();
    expect(screen.getByRole('button', { name: /Move up/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Move down/ })).toBeDisabled();
  });

  it('sets the row height and toggles what is drawn on the row', () => {
    const onSize = vi.fn();
    const onToggleMark = vi.fn();
    render(
      <MobileRowSheet
        {...base}
        size="M"
        onSize={onSize}
        markSources={[{ key: 'layer:b1', name: 'Boundaries 1', color: '#f59e0b', kind: 'line' }]}
        markedKeys={[]}
        onToggleMark={onToggleMark}
      />,
    );
    expect(screen.getByRole('button', { name: 'M' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'XL' }));
    expect(onSize).toHaveBeenCalledWith('XL');
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onToggleMark).toHaveBeenCalledWith('layer:b1');
  });
});

describe('SignalMarksOverlay', () => {
  it('places marks as a share of the song, lines full height and bars short', () => {
    const { container } = render(
      <SignalMarksOverlay
        duration={200}
        lines={[{ t: 50, color: '#f00' }]}
        bars={[{ t: 100, color: '#0f0' }, { t: 250, color: '#0f0' }]}
      />,
    );
    const spans = container.querySelectorAll('span');
    expect(spans).toHaveLength(3);
    expect((spans[0] as HTMLElement).style.left).toBe('25%');
    expect(spans[0].className).toMatch(/bottom-0/);
    expect((spans[1] as HTMLElement).style.left).toBe('50%');
    expect(spans[1].className).toMatch(/h-\[14px\]/);
    // Past the end clamps to the end rather than drawing off the row.
    expect((spans[2] as HTMLElement).style.left).toBe('100%');
  });

  it('draws nothing when there is nothing to draw', () => {
    const { container } = render(<SignalMarksOverlay duration={200} lines={[]} bars={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
