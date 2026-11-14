/**
 * Hits on the same onset share the lane: a snare struck with the kick draws
 * above it rather than behind, and two equally loud hits fan out.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CueLayerRow } from './CueLayerRow';
import type { CueItem } from '../../types/annotationLayer';

function tickOf(title: RegExp): HTMLElement {
  const button = [...document.querySelectorAll('button')].find((b) => title.test(b.title ?? ''));
  if (!button) throw new Error(`no tick titled ${title}`);
  return button;
}

describe('CueLayerRow stacked hits', () => {
  it('draws the quieter snare above the kick it shares an onset with', () => {
    const items: CueItem[] = [
      { id: 's', time: 1, label: 'snare', velocity: 80 },
      { id: 'k', time: 1, label: 'kick', velocity: 127 },
    ];
    render(<CueLayerRow items={items} color="#eab308" duration={10} />);
    const kick = tickOf(/^kick/);
    const snare = tickOf(/^snare/);
    expect(Number(snare.style.zIndex)).toBeGreaterThan(Number(kick.style.zIndex));
    expect(kick.title).toContain('2 hits at once: kick, snare');
  });

  it('draws equally loud hits on their time — the tie is named, never fanned', () => {
    const items: CueItem[] = [
      { id: 'k', time: 1, label: 'kick', velocity: 127 },
      { id: 's', time: 1, label: 'snare', velocity: 127 },
    ];
    render(<CueLayerRow items={items} color="#eab308" duration={10} />);
    // Centred by a -4px margin (half the 8px target) and nothing more: a
    // fanned tick sat beside the grid line it was stamped on.
    expect(tickOf(/^kick/).style.marginLeft).toBe('-4px');
    expect(tickOf(/^snare/).style.marginLeft).toBe('-4px');
    expect(tickOf(/^kick/).title).toContain('2 hits at once: kick, snare');
  });
});
