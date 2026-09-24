/** Releasing the audio device when the click panel closes.
 *
 *  The panel builds an AudioContext the first time the click is armed, and
 *  that context is not memory the collector reclaims on its own: for as long
 *  as it lives it holds an output thread on the audio hardware, and Chrome
 *  refuses to construct more than a handful per document. The panel unmounts
 *  every time its step section is collapsed or the setup pane is left, so one
 *  left behind here leaked once per visit — and a long session eventually hit
 *  the ceiling, at which point `new AudioContext()` throws and the click goes
 *  permanently silent with no way back short of a reload. */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { MetronomePanel } from './MetronomePanel';
import type { SongInfo } from '../../types/songInfo';

/** Minimal AudioContext: enough graph for the panel's master chain, plus a
 *  record of whether it was ever closed. */
class FakeCtx {
  static live: FakeCtx[] = [];
  currentTime = 0;
  state: 'running' | 'suspended' | 'closed' = 'running';
  sampleRate = 48_000;
  destination = {};
  closed = false;

  constructor() { FakeCtx.live.push(this); }

  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
  createGain() {
    return {
      gain: {
        value: 0,
        setValueAtTime() {}, linearRampToValueAtTime() {},
        exponentialRampToValueAtTime() {}, cancelScheduledValues() {},
      },
      connect: (n: unknown) => n,
      disconnect: () => {},
    };
  }
  createWaveShaper() {
    return { curve: null, oversample: 'none', connect: (n: unknown) => n, disconnect: () => {} };
  }
}

const songInfo: SongInfo = {
  song: 'test-song',
  bpm: 120,
  timeSignature: '4/4',
  gridOffset: 0,
  updated_at: '',
};

/** Mounts the panel and arms the click, which is what builds the context. */
function mountAndArm() {
  let enabled = false;
  const view = render(
    <MetronomePanel
      songInfo={songInfo}
      playerTime={0}
      playerIsPlaying={false}
      clickEnabled={enabled}
      onClickEnabledChange={(next) => { enabled = next; }}
    />,
  );
  fireEvent.click(view.getByTitle(/Turn the click track on or off/));
  return view;
}

beforeEach(() => {
  FakeCtx.live = [];
  vi.stubGlobal('AudioContext', FakeCtx);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MetronomePanel resource release', () => {
  it('closes its AudioContext when the panel unmounts', () => {
    const view = mountAndArm();
    expect(FakeCtx.live).toHaveLength(1);
    expect(FakeCtx.live[0].closed).toBe(false);

    view.unmount();
    expect(FakeCtx.live[0].closed).toBe(true);
  });

  it('leaves nothing open across repeated open/close of the step section', () => {
    for (let i = 0; i < 8; i++) {
      const view = mountAndArm();
      view.unmount();
    }
    expect(FakeCtx.live).toHaveLength(8);
    expect(FakeCtx.live.filter((c) => !c.closed)).toEqual([]);
  });

  it('does not construct a context at all when the click is never armed', () => {
    const view = render(
      <MetronomePanel
        songInfo={songInfo}
        playerTime={0}
        playerIsPlaying={false}
        clickEnabled={false}
        onClickEnabledChange={() => {}}
      />,
    );
    view.unmount();
    expect(FakeCtx.live).toHaveLength(0);
  });
});
