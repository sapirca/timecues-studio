import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { KaraokePanel, type KaraokeLyricsSource } from './KaraokePanel';
import { PlayheadClockContext, createPlayheadClock } from '../../hooks/usePlayhead';
import type { LyricsItem } from '../../types/annotationLayer';

// A wordless transcription split across stems: one performance, two layers.
const line = (id: string, time: number, end: number, text: string): LyricsItem =>
  ({ id, time, end, text, kind: 'line' });

const VOCALS: KaraokeLyricsSource = {
  id: 'voc', name: 'Wordless vocals (vocals)', color: '#ec4899', shown: true,
  items: [line('v1', 1, 3, 'dho'), line('v2', 4, 6, '[turkey gobble]'), line('v3', 12, 14, '[groan]')],
};
const OTHER: KaraokeLyricsSource = {
  id: 'oth', name: 'Wordless vocals (other)', color: '#c026d3', shown: true,
  items: [line('o1', 8, 10, '[roar]'), line('o2', 5, 7, '[howl]')],
};

afterEach(cleanup);

function mount(sources: KaraokeLyricsSource[], at: number) {
  const clock = createPlayheadClock(at);
  render(
    <PlayheadClockContext.Provider value={clock}>
      <KaraokePanel sources={sources} focusedId="voc" />
    </PlayheadClockContext.Provider>,
  );
  return clock;
}

describe('KaraokePanel — several lyrics layers', () => {
  it('merges every shown layer into one flow, with no stem tags', () => {
    mount([VOCALS, OTHER], 9);
    // [roar] (other) is sounding; the vocals line before it and after it frame it.
    expect(screen.getByText('[roar]')).toBeTruthy();
    expect(screen.getByText('[howl]')).toBeTruthy();
    expect(screen.getByText('[groan]')).toBeTruthy();
    expect(screen.queryByText('other')).toBeNull();
    expect(screen.queryByText('vocals')).toBeNull();
  });

  it('tells layers apart by colour, even when they share one on the canvas', () => {
    mount([VOCALS, { ...OTHER, color: VOCALS.color }], 5.5);
    const colors = [...document.querySelectorAll<HTMLElement>('.text-\\[18px\\]')].map((el) => el.style.color);
    expect(colors).toHaveLength(2);
    expect(colors[0]).not.toEqual(colors[1]);
  });

  it('lights lines from two layers that sound at once', () => {
    const clock = mount([VOCALS, OTHER], 5.5);
    const big = () => [...document.querySelectorAll('.text-\\[18px\\]')].map((el) => el.textContent);
    expect(big()).toEqual(['[turkey gobble]', '[howl]']);
    act(() => clock.set(9));
    expect(big()).toEqual(['[roar]']);
  });

  it('a hidden layer starts out, and its chip brings it in', () => {
    mount([VOCALS, { ...OTHER, shown: false }], 9);
    expect(screen.queryByText('[roar]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Wordless vocals \(other\)/ }));
    expect(screen.getByText('[roar]')).toBeTruthy();
  });

  it('a shown layer can be taken out; the focused one has no chip', () => {
    mount([VOCALS, OTHER], 9);
    expect(screen.queryByRole('button', { name: /\(vocals\)/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Wordless vocals \(other\)/ }));
    expect(screen.queryByText('[roar]')).toBeNull();
  });
});

describe('KaraokePanel — line items and loose words', () => {
  const word = (id: string, time: number, end: number, text: string): LyricsItem =>
    ({ id, time, end, text, kind: 'word' });

  it('a stray empty line does not hide the words around it', () => {
    // One empty line drawn at the intro, then words with no line item at all.
    const src: KaraokeLyricsSource = {
      id: 'voc', name: 'Lyrics', color: '#ec4899', shown: true,
      items: [line('l1', 7.7, 8.6, ''), word('w1', 30, 30.5, 'יום'), word('w2', 31, 34, 'קסמים')],
    };
    mount([src], 31.5);
    expect(screen.getByText('קסמים')).toBeTruthy();
    expect(screen.getByText('יום')).toBeTruthy();
  });

  it('words a line covers stay in it; the rest form their own line', () => {
    const src: KaraokeLyricsSource = {
      id: 'voc', name: 'Lyrics', color: '#ec4899', shown: true,
      items: [line('l1', 1, 3, 'hello world'), word('w1', 1, 2, 'hello'), word('w2', 2, 3, 'world'), word('w3', 10, 11, 'later')],
    };
    const clock = mount([src], 1.5);
    const big = () => [...document.querySelectorAll('.text-\\[18px\\]')].map((el) => el.textContent);
    expect(big()).toEqual(['helloworld']);
    act(() => clock.set(10.5));
    expect(big()).toEqual(['later']);
  });
});
