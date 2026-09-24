/** Releasing the audio device.
 *
 *  An AudioContext is not memory the collector reclaims on its own: for as
 *  long as it lives it holds an output thread on the audio hardware, and
 *  Chrome refuses to construct more than a handful per document. A hook that
 *  leaves one behind at unmount therefore doesn't just grow the heap over a
 *  long session — it eventually makes the feature fail outright, because
 *  `new AudioContext()` starts throwing and there is no way back short of a
 *  reload. These tests pin the teardown. */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLoopPlayback } from './useLoopPlayback';

interface FakeNode {
  buffer: AudioBuffer | null;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  playbackRate: { value: number };
  onended: (() => void) | null;
  connect: (n: unknown) => unknown;
  disconnect: () => void;
  start: () => void;
  stop: ReturnType<typeof vi.fn>;
}

/** Minimal AudioContext: enough graph for one looping buffer source, plus a
 *  record of whether it was ever closed. */
class FakeCtx {
  static live: FakeCtx[] = [];
  static nodes: FakeNode[] = [];
  currentTime = 0;
  state: 'running' | 'suspended' | 'closed' = 'running';
  destination = {};
  closed = false;
  sampleRate: number;

  constructor(opts?: { sampleRate?: number }) {
    this.sampleRate = opts?.sampleRate ?? 48_000;
    FakeCtx.live.push(this);
  }

  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
  createBufferSource(): FakeNode {
    const node: FakeNode = {
      buffer: null,
      loop: false, loopStart: 0, loopEnd: 0,
      playbackRate: { value: 1 },
      onended: null,
      connect: (n: unknown) => n,
      disconnect: () => {},
      start: () => {},
      stop: vi.fn(),
    };
    FakeCtx.nodes.push(node);
    return node;
  }
}


/** A one-second buffer of silence at 44.1 kHz — the rate matters, because the
 *  hook pins the context to it. */
function fakeBuffer(sampleRate = 44_100): AudioBuffer {
  const data = new Float32Array(sampleRate);
  return {
    sampleRate,
    duration: 1,
    length: sampleRate,
    numberOfChannels: 1,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}

beforeEach(() => {
  FakeCtx.live = [];
  FakeCtx.nodes = [];
  vi.stubGlobal('AudioContext', FakeCtx);
  // The position clock runs on rAF; drive it by hand so nothing is left
  // pending between tests.
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useLoopPlayback resource release', () => {
  it('closes its AudioContext when the hook unmounts', () => {
    const audioBuffer = fakeBuffer();
    const view = renderHook(() => useLoopPlayback({ audioBuffer }));

    act(() => { view.result.current.play('loop-1', 0.1, 0.4); });
    expect(FakeCtx.live).toHaveLength(1);
    expect(FakeCtx.live[0].closed).toBe(false);

    view.unmount();
    expect(FakeCtx.live[0].closed).toBe(true);
  });

  it('leaves nothing open across repeated mounts — the case that exhausts the browser limit', () => {
    const audioBuffer = fakeBuffer();
    for (let i = 0; i < 8; i++) {
      const view = renderHook(() => useLoopPlayback({ audioBuffer }));
      act(() => { view.result.current.play(`loop-${i}`, 0.1, 0.4); });
      view.unmount();
    }
    expect(FakeCtx.live).toHaveLength(8);
    expect(FakeCtx.live.filter((c) => !c.closed)).toEqual([]);
  });

  it('does not construct a context at all for a session that never plays a loop', () => {
    const view = renderHook(() => useLoopPlayback({ audioBuffer: fakeBuffer() }));
    view.unmount();
    expect(FakeCtx.live).toHaveLength(0);
  });

  it('closes the old context when the buffer\'s sample rate changes', () => {
    const view = renderHook(
      ({ buf }: { buf: AudioBuffer }) => useLoopPlayback({ audioBuffer: buf }),
      { initialProps: { buf: fakeBuffer(44_100) } },
    );
    act(() => { view.result.current.play('a', 0.1, 0.4); });
    view.rerender({ buf: fakeBuffer(48_000) });
    act(() => { view.result.current.play('b', 0.1, 0.4); });

    expect(FakeCtx.live).toHaveLength(2);
    expect(FakeCtx.live[0].closed).toBe(true);

    view.unmount();
    expect(FakeCtx.live.filter((c) => !c.closed)).toEqual([]);
  });
});

/** The seam.
 *
 *  This engine exists because the media element has no seamless loop to
 *  offer: wrapping one means noticing `currentTime >= end` on a timer and
 *  then seeking, by which point the output device has already been handed the
 *  milliseconds that follow — the annotator hears a sliver of the next bar
 *  before the phrase restarts. A buffer source wraps inside the audio thread,
 *  so the seam is exact. These tests pin the two things that would push the
 *  preview back onto a seam: re-cutting a loop mid-flight, and matching the
 *  player's speed control. */
describe('useLoopPlayback seam', () => {
  it('re-cuts a sounding loop in place rather than re-triggering it', () => {
    const audioBuffer = fakeBuffer();
    const view = renderHook(() => useLoopPlayback({ audioBuffer }));
    act(() => { view.result.current.play('preview', 0.1, 0.4); });
    expect(FakeCtx.nodes).toHaveLength(1);

    act(() => { view.result.current.setBounds(0.2, 0.5); });

    // Same node, new seam — dragging a band handle must not restart the phrase.
    expect(FakeCtx.nodes).toHaveLength(1);
    expect(FakeCtx.nodes[0].stop).not.toHaveBeenCalled();
    expect(FakeCtx.nodes[0].loopStart).toBeCloseTo(0.2, 5);
    expect(FakeCtx.nodes[0].loopEnd).toBeCloseTo(0.5, 5);
    view.unmount();
  });

  it('ignores setBounds when nothing is sounding', () => {
    const audioBuffer = fakeBuffer();
    const view = renderHook(() => useLoopPlayback({ audioBuffer }));
    act(() => { view.result.current.setBounds(0.2, 0.5); });
    expect(FakeCtx.nodes).toHaveLength(0);
    view.unmount();
  });

  it('plays at the requested rate, and reports a position that moves at that rate', () => {
    const audioBuffer = fakeBuffer();
    const view = renderHook(() => useLoopPlayback({ audioBuffer }));
    act(() => { view.result.current.play('preview', 0.1, 0.4, { rate: 0.5 }); });

    expect(FakeCtx.nodes[0].playbackRate.value).toBe(0.5);
    // Half a second of wall clock into a half-speed loop is a quarter second
    // of song — a cursor counting wall clock would have run twice as far.
    FakeCtx.live[0].currentTime = 0.5;
    expect(view.result.current.getTime()).toBeCloseTo(0.35, 5);
    view.unmount();
  });
});
