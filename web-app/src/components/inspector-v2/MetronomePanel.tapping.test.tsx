/** Tapping mode: once a tap has started it, Space taps instead of reaching the
 *  global play/pause shortcut, and Escape stops it — so the tempo can be
 *  tapped on the keyboard alone, on the biggest key there is. */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@testing-library/react';
import { MetronomePanel } from './MetronomePanel';
import type { SongInfo } from '../../types/songInfo';

const songInfo: SongInfo = {
  song: 'test-song',
  bpm: 120,
  timeSignature: '4/4',
  gridOffset: 0,
  updated_at: '',
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mount() {
  // Stands in for the page's Space=play/pause, bound on window in bubble phase.
  const playPause = vi.fn();
  const onWindowKey = (e: KeyboardEvent) => { if (e.code === 'Space') playPause(); };
  window.addEventListener('keydown', onWindowKey);
  render(
    <MetronomePanel
      songInfo={songInfo}
      playerIsPlaying={false}
      clickEnabled={false}
      onClickEnabledChange={() => {}}
    />,
  );
  return { playPause, dispose: () => window.removeEventListener('keydown', onWindowKey) };
}

const space = () => fireEvent.keyDown(window, { code: 'Space', key: ' ' });

describe('tap tempo keyboard mode', () => {
  it('leaves Space to play/pause until a tap starts tapping mode', () => {
    const { playPause, dispose } = mount();
    space();
    expect(playPause).toHaveBeenCalledTimes(1);
    expect(screen.getByText('0 taps')).toBeTruthy();
    dispose();
  });

  it('taps on Space while tapping, without play/pause, and Escape stops it', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { playPause, dispose } = mount();

    fireEvent.mouseDown(screen.getByText('TAP · T'));
    expect(screen.getByText('TAP · SPACE')).toBeTruthy();
    // The arming press is not a tap: counting starts at the first Space.
    expect(screen.getByText('0 taps')).toBeTruthy();
    now += 3000; space();
    now += 500; space();
    now += 500; space();
    fireEvent.keyDown(window, { code: 'Space', key: ' ', repeat: true });
    expect(playPause).not.toHaveBeenCalled();
    expect(screen.getByText('3 taps')).toBeTruthy();
    expect(screen.getByText('120')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByText('TAP · T')).toBeTruthy();
    now += 500; space();
    expect(playPause).toHaveBeenCalledTimes(1);
    expect(screen.getByText('3 taps')).toBeTruthy();
    dispose();
  });

  it('drops every tap before a pause of over a second', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { dispose } = mount();

    fireEvent.mouseDown(screen.getByText('TAP · T'));
    now += 500; space();
    now += 500; space();
    now += 500; space();
    expect(screen.getByText('3 taps')).toBeTruthy();
    now += 1500; space();
    expect(screen.getByText('1 tap')).toBeTruthy();
    now += 600; space();
    expect(screen.getByText('2 taps')).toBeTruthy();
    expect(screen.getByText('100')).toBeTruthy();
    dispose();
  });
});
