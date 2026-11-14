/**
 * An item's own colour — optional on spans, loops and boundaries as on cues —
 * is drawn on its lane, set in its card, and kept when a detector's output is
 * copied into a layer of your own. Without one, nothing changes.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SpanLaneRow } from './SpanLaneRow';
import { LoopLayerRow } from './LoopLayerRow';
import { ItemColorControl } from './shared/ItemColorControl';
import { convertDetectorItems } from './detectorConvert';
import type { LoopItem, SpanItem } from '../../types/annotationLayer';
import type { CustomLoopItem, CustomSpanItem } from '../../types/customScript';

afterEach(cleanup);

/** jsdom normalises `#rrggbbaa` to rgba(); match on the RGB part. */
const rgbOf = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
};

function bandBackgrounds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('button')]
    .map((b) => b.style.background)
    .filter(Boolean);
}

describe('span and loop lanes', () => {
  it('draw a span in its own colour and a plain span in the layer colour', () => {
    const items: SpanItem[] = [
      { id: 'a', start: 10, end: 20, label: 'violin', color: '#a3e635' },
      { id: 'b', start: 30, end: 40, label: 'pad' },
    ];
    const { container } = render(
      <SpanLaneRow items={items} color="#38bdf8" duration={100} onSpanEdgeDrag={vi.fn()} onSpanMove={vi.fn()} />,
    );
    const bg = bandBackgrounds(container);
    expect(bg.some((b) => b.includes(rgbOf('#a3e635')))).toBe(true);
    expect(bg.some((b) => b.includes(rgbOf('#38bdf8')))).toBe(true);
  });

  it('draw a loop in its own colour', () => {
    const items: LoopItem[] = [{ id: 'l', start: 0, end: 8, label: 'drums', color: '#f87171' }];
    const { container } = render(<LoopLayerRow items={items} color="#38bdf8" duration={100} />);
    const bg = bandBackgrounds(container);
    expect(bg.some((b) => b.includes(rgbOf('#f87171')))).toBe(true);
    expect(bg.some((b) => b.includes(rgbOf('#38bdf8')))).toBe(false);
  });
});

describe('ItemColorControl — the one colour control every card uses', () => {
  it('starts at the fallback, sets a colour, and resets to none', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ItemColorControl color={undefined} fallbackColor="#38bdf8" fallbackName="type colour" readOnly={false} onChange={onChange} />,
    );
    expect((screen.getByLabelText('Item colour') as HTMLInputElement).value).toBe('#38bdf8');
    expect(screen.getByText('type colour')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'reset' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Item colour'), { target: { value: '#a3e635' } });
    expect(onChange).toHaveBeenLastCalledWith('#a3e635');

    rerender(<ItemColorControl color="#a3e635" fallbackColor="#38bdf8" readOnly={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'reset' }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('is disabled on a read-only card', () => {
    render(<ItemColorControl color="#a3e635" fallbackColor="#38bdf8" readOnly onChange={vi.fn()} />);
    expect((screen.getByLabelText('Item colour') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'reset' })).toBeNull();
  });
});

describe('Copy to manual layer keeps a detector item\'s own colour', () => {
  it('for spans and loops, and adds none when the detector set none', () => {
    const spans: CustomSpanItem[] = [
      { start_ms: 0, duration_ms: 1000, label: 'vox', intensity: null, color: '#a3e635' },
      { start_ms: 2000, duration_ms: 1000, label: 'pad', intensity: null },
    ];
    const [own, plain] = convertDetectorItems('spans', spans) as SpanItem[];
    expect(own.color).toBe('#a3e635');
    expect(plain).not.toHaveProperty('color');

    const loops: CustomLoopItem[] = [{ start_ms: 0, duration_ms: 4000, label: 'drums', snap_zero_cross: null, color: '#f87171' }];
    expect((convertDetectorItems('loops', loops) as LoopItem[])[0].color).toBe('#f87171');
  });
});
