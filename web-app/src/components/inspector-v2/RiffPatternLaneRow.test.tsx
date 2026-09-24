/**
 * The riff row's playhead. Every other lane on the canvas (Cue, Span, Loop,
 * Lead) draws the same white hairline at the cursor, and a riff row without
 * one is the place where "which repeat am I hearing?" has no answer.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { RiffPatternLaneRow } from './RiffPatternLaneRow';
import { newRiffPatternItem, newRiffPatternLayer, type RiffPatternItem } from '../../types/annotationLayer';

function layerWith(items: RiffPatternItem[] = []) {
  return { ...newRiffPatternLayer('Riffs', '#38bdf8'), items };
}

/** The hairline is the only full-height, zero-width, non-interactive child. */
function cursor(): HTMLElement | null {
  return document.querySelector('.absolute.top-0.bottom-0.w-px.pointer-events-none');
}

describe('RiffPatternLaneRow playhead', () => {
  it('draws the cursor at the playhead as a fraction of the track', () => {
    render(<RiffPatternLaneRow layer={layerWith()} duration={200} currentTime={50} />);
    expect(cursor()?.style.left).toBe('25%');
  });

  it('sits at the left edge before playback starts, and with no time given', () => {
    const { unmount } = render(<RiffPatternLaneRow layer={layerWith()} duration={200} currentTime={0} />);
    expect(cursor()?.style.left).toBe('0%');
    unmount();
    render(<RiffPatternLaneRow layer={layerWith()} duration={200} />);
    expect(cursor()?.style.left).toBe('0%');
  });

  it('never runs past the row when the clock overshoots a stale duration', () => {
    render(<RiffPatternLaneRow layer={layerWith()} duration={10} currentTime={99} />);
    expect(cursor()?.style.left).toBe('100%');
  });

  it('stays put — at the left edge — while the duration is still unknown', () => {
    render(<RiffPatternLaneRow layer={layerWith()} duration={0} currentTime={12} />);
    expect(cursor()?.style.left).toBe('0%');
  });
});

/**
 * Lane packing decides the row's HEIGHT, and it does so for the whole lane at
 * once: one pair of instances the packer thinks overlap adds a lane to every
 * row in the song. A run of bars is stored as `start + cycle x repeats` with
 * `cycle` rounded to whole milliseconds, so consecutive runs routinely end a
 * millisecond past where the next one begins — on a real 124 BPM track that
 * turned a three-row drum groove into a six-lane row with half of it empty.
 */

/** The row's own element is the one carrying an explicit pixel height. */
function rowHeight(container: HTMLElement): number {
  const el = container.querySelector('[style*="height"]') as HTMLElement;
  return parseFloat(el.style.height);
}

function at(start: number, end: number, repeats = 1): RiffPatternItem {
  return { ...newRiffPatternItem(start, end, 'n'), repeatCount: repeats };
}

describe('RiffPatternLaneRow lane packing', () => {
  it('keeps runs that touch in one lane, despite millisecond rounding', () => {
    // 32.020 + 1.934 x 5 = 41.690, and the next run's own measured start is
    // 41.690 — arrived at by a different sum, so it lands a hair earlier.
    const { container } = render(
      <RiffPatternLaneRow layer={layerWith([at(32.02, 33.954, 5), at(41.6899, 43.62, 2)])} duration={200} />,
    );
    const stacked = render(
      <RiffPatternLaneRow layer={layerWith([at(32.02, 33.954, 5)])} duration={200} />,
    );
    expect(rowHeight(container)).toBe(rowHeight(stacked.container));
  });

  it('still stacks instances that genuinely overlap', () => {
    // The three drums of one groove start together and must NOT be merged —
    // stacking them is how the lane draws a groove as a three-line staff.
    const { container } = render(
      <RiffPatternLaneRow layer={layerWith([at(0, 2), at(0, 2), at(0, 2)])} duration={200} />,
    );
    const single = render(<RiffPatternLaneRow layer={layerWith([at(0, 2)])} duration={200} />);
    expect(rowHeight(container)).toBeGreaterThan(rowHeight(single.container));
  });

  it('does not merge instances a person placed a step apart', () => {
    // The tolerance is 20 ms; a 16th note is 75 ms even at 200 BPM, so an
    // overlap a person can create by dragging must still open a lane.
    const { container } = render(
      <RiffPatternLaneRow layer={layerWith([at(0, 2), at(1.9, 3.9)])} duration={200} />,
    );
    const single = render(<RiffPatternLaneRow layer={layerWith([at(0, 2)])} duration={200} />);
    expect(rowHeight(container)).toBeGreaterThan(rowHeight(single.container));
  });
});
