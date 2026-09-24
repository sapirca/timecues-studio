/**
 * A band is drawn where the item actually sits — even a very short one.
 *
 * The regression this pins: the band's width carried a floor of 0.5% of the
 * SONG, so every item shorter than that (1.8 s in a six-minute track) was
 * drawn 1.8 s wide at every zoom. The item's data was fine and its start was
 * on the beat; only its right edge was drawn past where it ended, and the
 * further you zoomed in the further past. A span snapped to the grid looked
 * like the snap had failed, and the "drag the end" handle sat somewhere the
 * span didn't end.
 *
 * The floor is now in pixels, so it stays a couple of pixels of nudge at fit
 * zoom instead of a constant slice of the timeline.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { SpanLaneRow } from './SpanLaneRow';
import { MIN_BAND_PX } from './shared/bandGeometry';
import type { SpanItem } from '../../types/annotationLayer';

afterEach(cleanup);

function span(start: number, end: number): SpanItem {
  return { id: 's1', start, end, label: '', importance: 'optional' } as SpanItem;
}

/** The row draws one band per item; it is the button carrying the edge handles. */
function band(container: HTMLElement): HTMLElement {
  const el = [...container.querySelectorAll('button')]
    .find((b) => b.querySelector('[aria-label="Drag to move span start"]'));
  expect(el, 'no band rendered').toBeTruthy();
  return el as HTMLElement;
}

function renderLane(item: SpanItem) {
  return render(
    <SpanLaneRow
      items={[item]}
      color="#38bdf8"
      duration={364}
      currentTime={0}
      onSpanEdgeDrag={vi.fn()}
      onSpanMove={vi.fn()}
    />,
  );
}

describe('span band geometry', () => {
  it('draws a short span at its own width, not at a floor measured in song-time', () => {
    // 1.7 s of a 364 s song — under the old 0.5%-of-song floor, which would
    // have drawn it as 0.5%.
    const { container } = renderLane(span(84.45, 86.105));

    expect(band(container).style.width).toBe(`${((86.105 - 84.45) / 364) * 100}%`);
  });

  it('draws a long span at its own width too', () => {
    const { container } = renderLane(span(0.036, 11.622));

    expect(band(container).style.width).toBe(`${((11.622 - 0.036) / 364) * 100}%`);
  });

  it('keeps a near-zero span clickable with a pixel floor', () => {
    const { container } = renderLane(span(74.885, 75));

    expect(band(container).style.minWidth).toBe(`${MIN_BAND_PX}px`);
  });

  it('caps the edge handles so a narrow band keeps a body to grab', () => {
    // Both handles are a fixed 6px. On a band narrower than 12px they used to
    // meet in the middle, so every drag resized the span instead of moving it.
    const { container } = renderLane(span(74.885, 75));
    const handles = container.querySelectorAll('[aria-label^="Drag to move span"]');

    expect(handles).toHaveLength(2);
    handles.forEach((h) => expect((h as HTMLElement).style.maxWidth).toBe('30%'));
  });
});
