/**
 * A struck cue (a detector's drum hit) draws in its own colour and stands as
 * tall as it was struck; a plain cue draws exactly as it always did.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CueLayerRow } from './CueLayerRow';
import type { CueItem } from '../../types/annotationLayer';

function tickOf(title: RegExp): { button: HTMLElement; bar: HTMLElement } {
  const button = [...document.querySelectorAll('button')].find((b) => title.test(b.title ?? ''));
  if (!button) throw new Error(`no tick titled ${title}`);
  return { button, bar: button.querySelector('span') as HTMLElement };
}

describe('CueLayerRow struck hits', () => {
  const items: CueItem[] = [
    { id: 'k', time: 1, label: 'kick', velocity: 127, levelDb: -1.5, color: '#f87171' },
    { id: 'g', time: 2, label: 'ghost', velocity: 10, color: '#38bdf8' },
    { id: 'p', time: 3, label: 'plain' },
    { id: 't', time: 4, label: 'tom', note: 45, decay: 0.5 },
  ];

  it('paints each tick in its own colour and sizes it by velocity', () => {
    render(<CueLayerRow items={items} color="#eab308" duration={10} currentTime={0} />);
    const kick = tickOf(/^kick/);
    expect(kick.bar.style.background).toBe('rgb(248, 113, 113)');
    expect(kick.bar.style.height).toBe('100%');
    expect(kick.button.className).toContain('items-end');
    // A ghost note keeps the 20% floor so it stays visible and clickable.
    expect(tickOf(/^ghost/).bar.style.height).toBe('20%');
  });

  it('puts velocity and level in the hover text', () => {
    render(<CueLayerRow items={items} color="#eab308" duration={10} currentTime={0} />);
    expect(tickOf(/^kick/).button.title).toMatch(/^kick · velocity 127 · -1\.5 dB @ /);
  });

  it('leaves a plain cue full height in the lane colour', () => {
    render(<CueLayerRow items={items} color="#eab308" duration={10} currentTime={0} />);
    const plain = tickOf(/^plain @ /);
    expect(plain.bar.style.background).toBe('rgb(234, 179, 8)');
    expect(plain.bar.style.height).toBe('');
    expect(plain.bar.className).toContain('h-full');
  });
});

describe('CueLayerRow note and decay', () => {
  it('names the note and the decay in the hover, and draws a tail for the decay', () => {
    render(<CueLayerRow items={[{ id: 't', time: 4, label: 'tom', note: 45, decay: 0.5 }]} color="#eab308" duration={10} currentTime={0} />);
    const tom = [...document.querySelectorAll('button')].find((b) => /^tom/.test(b.title))!;
    expect(tom.title).toMatch(/^tom · A2 · rings 500 ms @ /);
    const tail = document.querySelector('[data-testid="cue-decay"]') as HTMLElement;
    expect(tail.style.left).toBe('40%');
    expect(tail.style.width).toBe('5%');
  });

  it('draws no tail for a cue without decay', () => {
    render(<CueLayerRow items={[{ id: 'p', time: 3, label: 'plain' }]} color="#eab308" duration={10} currentTime={0} />);
    expect(document.querySelector('[data-testid="cue-decay"]')).toBeNull();
  });
});
