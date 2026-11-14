/**
 * A riff lane's card draws its node: one cell per step of the loop, a bar
 * line where each bar of a multi-bar loop starts, and each hit as strong as
 * the accent on its note — the same object the export writes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { GrooveLaneRow } from './GrooveLaneRow';
import { riffGrooveLane } from './riffGrooves';
import {
  newRiffNode,
  newRiffPatternItem,
  newRiffPatternLayer,
  newRiffSeqEntry,
  type AnnotationLayer,
} from '../../types/annotationLayer';

globalThis.ResizeObserver = globalThis.ResizeObserver ?? class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

/** A 2-bar hat loop: loud on the &s of bar 1, ghost notes in bar 2. */
const HITS = [2, 6, 10, 14, 17, 19, 21, 23];
const ACCENTS = [127, 127, 127, 127, 32, 32, 32, 32];

function hatLayer(): AnnotationLayer<'riff-patterns'> {
  const node = {
    ...newRiffNode('A', '#38bdf8', 8),
    names: ['offbeat hat'],
    segments: HITS.map((st, i) => ({ start: st / 4, end: (st + 1) / 4, kind: 'tick' as const, accent: ACCENTS[i] })),
  };
  const item = { ...newRiffPatternItem(0, 4, 'A'), sequence: [newRiffSeqEntry(node.id, 32)], repeatCount: 2 };
  return { ...newRiffPatternLayer('Hi-hat pattern', '#38bdf8'), drum: 'hat', nodes: [node], items: [item] };
}

describe('a riff node in its card', () => {
  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 2000, bottom: 36, width: 2000, height: 36, toJSON: () => ({}),
    } as DOMRect);
  });

  it('draws the node: its steps, a line between its bars, and its notes’ accents', () => {
    const { model } = riffGrooveLane(hatLayer(), { bpm: 120, gridOffset: 0, beatsPerBar: 4 });
    render(<GrooveLaneRow laneId="riff" model={model} duration={8} />);
    fireEvent.click(document.querySelector<HTMLElement>('[title^="Bars 1–2"]')!);

    const card = document.querySelector('[data-annotation-popover]')!;
    expect(card.textContent).toContain('Groove A · 2-bar loop · offbeat hat');
    const staff = card.querySelector('svg')!;
    expect(staff.getAttribute('viewBox')).toBe('0 0 32 1');
    expect(card.querySelectorAll('[data-testid="staff-bar-line"]')).toHaveLength(1);
    expect(card.querySelector('[data-testid="staff-bar-line"]')!.getAttribute('x1')).toBe('16');
    // The bar's own hits (not the grey groove behind them), by step.
    const hits = [...staff.querySelectorAll('rect[fill="#a3e635"]')];
    expect(hits.map((r) => Number(r.getAttribute('x')))).toEqual(HITS);
    const strength = (step: number) => Number(hits.find((r) => Number(r.getAttribute('x')) === step)!.getAttribute('fill-opacity'));
    // Accent 127 full, accent 32 a ghost: 0.4 + 0.6 × 32/127 of it (the card
    // fades both alike while they are still to play).
    expect(strength(17) / strength(2)).toBeCloseTo(0.4 + 0.6 * (32 / 127), 2);
  });
});
