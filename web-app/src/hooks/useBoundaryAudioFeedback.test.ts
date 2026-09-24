/** Where a boundary pip lands on the audio clock.
 *
 *  The `currentTime` this hook receives is WaveSurfer's audioprocess routed
 *  through rAF and a setState on the whole inspector page, so it is always
 *  stale by a render's worth by the time a scheduler tick reads it — and by a
 *  different amount on every playthrough, since it tracks how heavy the tree
 *  is. These tests hold the prop deliberately stale and assert the pip still
 *  lands on the song time the marker was written at. */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBoundaryAudioFeedback, type BoundaryLayer } from './useBoundaryAudioFeedback';

/** Minimal AudioContext whose clock the test drives by hand. Records the
 *  `start()` time of every oscillator so pip placement can be asserted. */
class FakeCtx {
  currentTime = 0;
  state = 'running';
  destination = { };
  starts: number[] = [];
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createOscillator() {
    const starts = this.starts;
    return {
      type: '', frequency: { value: 0 },
      connect: (n: unknown) => n,
      start: (at: number) => { starts.push(at); },
      stop: () => {},
    };
  }
  createGain() {
    return {
      gain: {
        setValueAtTime() {}, linearRampToValueAtTime() {},
        exponentialRampToValueAtTime() {}, cancelScheduledValues() {},
      },
      connect: (n: unknown) => n,
    };
  }
  createStereoPanner() {
    return { pan: { value: 0 }, connect: (n: unknown) => n };
  }
}

let ctx: FakeCtx;

function layer(times: number[]): BoundaryLayer {
  return { id: 'cues', times, enabled: true, clickFreq: 1200, pan: 0, gain: 0.6 };
}

/** Mounts the hook playing, with the audio clock at `ctxT0` and the song at
 *  `songT0`. Returns a `tick` that advances both clocks by `dt` seconds of
 *  wall time while leaving the `currentTime` prop wherever the caller last
 *  put it — i.e. as stale as a slow render would leave it. */
function playing(times: number[], ctxT0: number, songT0: number) {
  ctx.currentTime = ctxT0;
  const view = renderHook(
    ({ t, rate }: { t: number; rate: number }) =>
      useBoundaryAudioFeedback([layer(times)], t, true, rate),
    { initialProps: { t: songT0, rate: 1 } },
  );
  return {
    view,
    /** Advance wall time by `dt`, optionally delivering a fresh prop value. */
    tick(dt: number, prop?: number, rate = 1) {
      act(() => {
        ctx.currentTime += dt;
        if (prop !== undefined) view.rerender({ t: prop, rate });
        vi.advanceTimersByTime(dt * 1000);
      });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  ctx = new FakeCtx();
  vi.stubGlobal('AudioContext', function () { return ctx; } as unknown as typeof AudioContext);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useBoundaryAudioFeedback pip placement', () => {
  it('places a pip at the anchor offset, not at the tick that scheduled it', () => {
    // Anchor: audio clock 100 ↔ song 10. A marker 0.29s of song later must
    // sound at audio-clock 100.29 however many ticks it takes to get queued.
    const p = playing([10.29], 100, 10);
    for (let i = 0; i < 12; i++) p.tick(0.025, 10 + (i + 1) * 0.025);
    expect(ctx.starts).toEqual([expect.closeTo(100.29, 6)]);
  });

  it('ignores how stale the currentTime prop is', () => {
    // Same marker, but the prop feed lags 60ms behind the transport the whole
    // way — a heavy render. Placement must not move.
    const p = playing([10.29], 100, 10);
    for (let i = 0; i < 12; i++) p.tick(0.025, 10 + (i + 1) * 0.025 - 0.06);
    expect(ctx.starts).toEqual([expect.closeTo(100.29, 6)]);
  });

  it('keeps a run of markers evenly spaced', () => {
    // Four markers a quarter second apart come out a quarter second apart,
    // with the prop lagging by a different amount on every tick.
    const p = playing([10.2, 10.45, 10.7, 10.95], 100, 10);
    for (let i = 0; i < 44; i++) {
      const lag = (i % 4) * 0.02; // jittery render latency
      p.tick(0.025, 10 + (i + 1) * 0.025 - lag);
    }
    expect(ctx.starts).toHaveLength(4);
    const gaps = ctx.starts.slice(1).map((s, i) => s - ctx.starts[i]);
    for (const g of gaps) expect(g).toBeCloseTo(0.25, 6);
  });

  it('halves the wall-clock offset at 2x speed', () => {
    // 0.4s of song at 2x is 0.2s of wall time, so the pip belongs at 100.2.
    const p = playing([10.4], 100, 10);
    p.tick(0.001, 10, 2); // speed change re-anchors at song 10 / ctx 100.001
    for (let i = 0; i < 12; i++) p.tick(0.025, 10 + (i + 1) * 0.05, 2);
    expect(ctx.starts).toEqual([expect.closeTo(100.201, 6)]);
  });

  it('re-anchors on a seek and drops the pips queued for the old position', () => {
    // A marker at 10.29 is queued, then the user jumps to song 40. The queued
    // pip is cancelled and the marker at 40.29 lands against the new anchor.
    const p = playing([10.29, 40.29], 100, 10);
    p.tick(0.025, 10.025);
    p.tick(0.025, 40); // forward jump past SEEK_FORWARD_THRESHOLD
    for (let i = 0; i < 12; i++) p.tick(0.025, 40 + (i + 1) * 0.025);
    expect(ctx.starts).toContainEqual(expect.closeTo(100.34, 6)); // 40.29 vs anchor {100.05, 40}
  });
});
