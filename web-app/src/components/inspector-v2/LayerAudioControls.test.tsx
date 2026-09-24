/** The "Test" pip and the browser's AudioContext ceiling.
 *
 *  Each press used to construct its own AudioContext and close it on a 200 ms
 *  timer, so presses inside that window held one open context each — and
 *  Chrome refuses to construct more than a handful per document, after which
 *  the button throws instead of making a sound. One shared context also means
 *  one audio output thread for the page rather than one per press. */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { LayerAudioControls, DEFAULT_LAYER_AUDIO } from './LayerAudioControls';

class FakeCtx {
  static live: FakeCtx[] = [];
  currentTime = 0;
  state: 'running' | 'suspended' | 'closed' = 'running';
  destination = {};

  constructor() { FakeCtx.live.push(this); }

  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  createOscillator() {
    return {
      type: '', frequency: { value: 0 },
      onended: null as (() => void) | null,
      connect: (n: unknown) => n,
      disconnect: () => {},
      start: () => {}, stop: () => {},
    };
  }
  createGain() {
    return {
      gain: {
        setValueAtTime() {}, linearRampToValueAtTime() {},
        exponentialRampToValueAtTime() {}, cancelScheduledValues() {},
      },
      connect: (n: unknown) => n,
      disconnect: () => {},
    };
  }
  createStereoPanner() {
    return { pan: { value: 0 }, connect: (n: unknown) => n, disconnect: () => {} };
  }
}

beforeEach(() => {
  FakeCtx.live = [];
  vi.stubGlobal('AudioContext', FakeCtx);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LayerAudioControls test pip', () => {
  it('reuses one AudioContext however many times the button is pressed', () => {
    const view = render(
      <LayerAudioControls value={{ ...DEFAULT_LAYER_AUDIO }} onChange={() => {}} label="Cues" />,
    );
    // The pip control lives behind the popover the labelled button opens.
    fireEvent.click(view.getByText('Cues'));
    const test = view.getByTitle('Play one pip at current settings');
    for (let i = 0; i < 10; i++) fireEvent.click(test);

    expect(FakeCtx.live).toHaveLength(1);
  });
});
