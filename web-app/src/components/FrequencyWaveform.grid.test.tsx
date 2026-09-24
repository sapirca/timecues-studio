/**
 * The 3-Band row draws its own grid — it is a canvas strip, not a lane with a
 * BeatGridOverlay dropped over it — and for a while it drew the WRONG one: it
 * computed its lines from the song's global BPM alone, ignoring the tempo map
 * every other surface was following. On a Mapped song the row beside it showed
 * one grid and this one showed another, and the region edges it snapped landed
 * on lines it had never drawn.
 *
 * A type checker cannot see this: the segments were simply never passed, and
 * every argument that WAS passed had the right type. So the test renders the
 * component and reads the lines back out of the DOM.
 */

import type React from 'react';
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { FrequencyWaveform } from './FrequencyWaveform';
import { SettingsProvider } from '../context/SettingsContext';
import { resolveGridSegments } from '../utils/gridSegments';
import { visibleGridLines } from '../utils/beatGrid';
import { makeEmptySongInfo } from '../types/songInfo';

const DURATION = 120;

beforeAll(() => {
  // The band canvases are a TiledStrip, which measures itself. jsdom has no
  // ResizeObserver and lays nothing out; the grid is DOM, so a no-op observer
  // is all this test needs.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

/** 120 BPM from the top; at 80s the song jumps to 130 BPM with a fresh bar 1. */
const MAPPED = {
  ...makeEmptySongInfo('split'),
  bpm: 120,
  timeSignature: '4/4',
  gridOffset: 0,
  gridMode: 'mapped' as const,
  gridSegments: [{ id: 'gs_b', start: 80, bpm: 130, timeSignature: '4/4' }],
};

const SEGMENTS = resolveGridSegments(MAPPED);

/** The grid line positions the row actually rendered, in seconds. GridLines
 *  places each line at `left: (t / duration) * 100%`, so the percentage is the
 *  timestamp the surface believes in. */
function renderedLineTimes(container: HTMLElement): number[] {
  const out: number[] = [];
  for (const el of container.querySelectorAll<HTMLElement>('div[style*="left"]')) {
    const m = /left:\s*([\d.]+)%/.exec(el.style.cssText);
    if (m) out.push((parseFloat(m[1]) / 100) * DURATION);
  }
  return out.sort((a, b) => a - b);
}

type RowProps = React.ComponentProps<typeof FrequencyWaveform>;

function renderRow(props: Partial<RowProps> = {}) {
  return render(
    <SettingsProvider>
      <FrequencyWaveform
        audioBuffer={null}
        duration={DURATION}
        bpm={MAPPED.bpm}
        beatOffset={MAPPED.gridOffset}
        beatsPerBar={4}
        {...props}
      />
    </SettingsProvider>,
  );
}

afterEach(cleanup);

describe('FrequencyWaveform beat grid', () => {
  it('draws the segment grid, not the global BPM, on a split song', () => {
    const { container } = renderRow({ segments: SEGMENTS });
    const drawn = renderedLineTimes(container);

    const expected = visibleGridLines({
      bpm: MAPPED.bpm,
      gridOffset: MAPPED.gridOffset,
      beatsPerBar: 4,
      startTime: 0,
      endTime: DURATION,
      barGroupSize: null,
      segments: SEGMENTS,
    }).map((l) => l.t);

    expect(drawn.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) expect(drawn[i]).toBeCloseTo(expected[i], 6);
  });

  it('is a different grid from the one the global BPM alone produces', () => {
    // The guard on the guard: if these two agreed, the test above would pass
    // for a component that still ignored `segments`.
    const withSegments = renderedLineTimes(renderRow({ segments: SEGMENTS }).container);
    cleanup();
    const without = renderedLineTimes(renderRow().container);

    expect(withSegments.length).not.toBe(without.length);
    // After the 80s split the two disagree on where every beat falls.
    const firstAfterSplit = (ts: number[]) => ts.find((t) => t > 80) as number;
    expect(firstAfterSplit(withSegments)).not.toBeCloseTo(firstAfterSplit(without), 3);
  });

  it('honours pinned beats from Hand-placed mode', () => {
    const pinned = 10.5;
    // Beat 20 at 120 BPM sits at 10.0s; pin it late and the row must move it.
    const { container } = renderRow({ beatOverrides: { '20': pinned } });
    const drawn = renderedLineTimes(container);
    expect(drawn.some((t) => Math.abs(t - pinned) < 1e-6)).toBe(true);
    expect(drawn.some((t) => Math.abs(t - 10.0) < 1e-6)).toBe(false);
  });
});
