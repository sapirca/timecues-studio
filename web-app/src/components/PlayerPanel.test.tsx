import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

// Minimal WaveSurfer stand-in: enough surface for PlayerPanel to mount and for
// the test to fire the 'play' event, but no audio decoding or canvas work.
const instances: FakeWaveSurfer[] = [];

class FakeWaveSurfer {
  handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  constructor() { instances.push(this); }
  on(evt: string, cb: (...args: unknown[]) => void) {
    const list = this.handlers.get(evt) ?? [];
    list.push(cb);
    this.handlers.set(evt, list);
    return () => {};
  }
  emit(evt: string, ...args: unknown[]) {
    for (const cb of this.handlers.get(evt) ?? []) cb(...args);
  }
  load() { return Promise.resolve(); }
  destroy() {}
  pause() { this.pauseCalls++; }
  play() { return Promise.resolve(); }
  getDuration() { return 0; }
  // Overridable so a test can drive the media clock frame by frame.
  now = 0;
  setTimeCalls: number[] = [];
  pauseCalls = 0;
  getCurrentTime() { return this.now; }
  getScroll() { return 0; }
  setScroll() {}
  setTime(t: number) { this.setTimeCalls.push(t); this.now = t; }
  zoom() {}
  isPlaying() { return false; }
}

vi.mock('wavesurfer.js', () => ({
  default: { create: () => new FakeWaveSurfer() },
}));

// jsdom ships neither of these and PlayerPanel subscribes to both on mount.
window.matchMedia = window.matchMedia ?? (() => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
})) as unknown as typeof window.matchMedia;
globalThis.ResizeObserver = globalThis.ResizeObserver ?? class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import { PlayerPanel } from './PlayerPanel';

describe('PlayerPanel onPlayingChange', () => {
  beforeEach(() => { instances.length = 0; });

  it('reports playback stopped when the stem url is swapped mid-play', () => {
    const onPlayingChange = vi.fn();
    const { rerender } = render(
      <PlayerPanel url="http://localhost/stems/full.wav" trackName="song" onPlayingChange={onPlayingChange} />,
    );

    act(() => { instances[0].emit('play'); });
    expect(onPlayingChange).toHaveBeenLastCalledWith(true);

    // Same track, different stem — WaveSurfer is torn down and rebuilt, which
    // stops playback without ever emitting 'pause'.
    rerender(
      <PlayerPanel url="http://localhost/stems/drums.wav" trackName="song" onPlayingChange={onPlayingChange} />,
    );

    expect(onPlayingChange).toHaveBeenLastCalledWith(false);
  });
});


// The preview region's end must be decided against the media clock inside the
// `audioprocess` handler — not in the parent against a `playerTime` React
// state, which trails the clock by a full inspector re-render. Measured on a
// 157 ms selection ending 20 ms before the first onset: at >=50 ms of that lag
// the loop overshoots far enough to play the song's attack 41 dB above the
// selection's own noise floor, which is the "I highlighted a quiet area and
// still hear something" report. These tests pin the decision to the one tick.
describe('PlayerPanel preview region end', () => {
  beforeEach(() => { instances.length = 0; });

  it('wraps a looping preview on the first audioprocess past the end', () => {
    render(
      <PlayerPanel
        url="http://localhost/stems/full.wav"
        trackName="song"
        previewRegion={{ start: 0.229, end: 0.386, loop: true }}
      />,
    );
    const ws = instances[0];

    // Still inside the region — nothing happens.
    act(() => { ws.now = 0.30; ws.emit('audioprocess'); });
    expect(ws.setTimeCalls).toEqual([]);

    // First tick at/after `end` wraps immediately, with no render in between.
    act(() => { ws.now = 0.3865; ws.emit('audioprocess'); });
    expect(ws.setTimeCalls).toEqual([0.229]);
    expect(ws.pauseCalls).toBe(0);
  });

  it('pauses a non-looping preview at the end and reports it', () => {
    const onPreviewEnd = vi.fn();
    render(
      <PlayerPanel
        url="http://localhost/stems/full.wav"
        trackName="song"
        previewRegion={{ start: 0.229, end: 0.386, loop: false }}
        onPreviewEnd={onPreviewEnd}
      />,
    );
    const ws = instances[0];

    act(() => { ws.now = 0.30; ws.emit('audioprocess'); });
    expect(ws.pauseCalls).toBe(0);
    expect(onPreviewEnd).not.toHaveBeenCalled();

    act(() => { ws.now = 0.3865; ws.emit('audioprocess'); });
    expect(ws.pauseCalls).toBe(1);
    expect(ws.setTimeCalls).toEqual([]);
    expect(onPreviewEnd).toHaveBeenCalledTimes(1);
  });

  it('leaves playback alone when there is no preview region', () => {
    render(<PlayerPanel url="http://localhost/stems/full.wav" trackName="song" />);
    const ws = instances[0];
    act(() => { ws.now = 12.5; ws.emit('audioprocess'); });
    expect(ws.setTimeCalls).toEqual([]);
    expect(ws.pauseCalls).toBe(0);
  });
});
