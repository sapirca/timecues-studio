/**
 * Painting a selection that starts at the beginning of the song.
 *
 * The label gutter butts right up against t=0, so a drag begun at the very
 * start of the timeline almost always drifts off the row — left into the
 * gutter, or a few pixels above/below it. The gesture has to survive that:
 * when it didn't, selecting the opening bars was effectively impossible.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { RegionDragOverlay } from './AnnotationOverlays';

const ROW_WIDTH = 1000;
const DURATION = 100; // 10px per second

beforeAll(() => {
  // jsdom lays nothing out, so the row has no width to map clientX onto.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: ROW_WIDTH, bottom: 40,
    width: ROW_WIDTH, height: 40, toJSON: () => ({}),
  } as DOMRect);
});

function mount() {
  const onVizRegion = vi.fn();
  const onVizClick = vi.fn();
  const { container } = render(
    <RegionDragOverlay duration={DURATION} onVizClick={onVizClick} onVizRegion={onVizRegion} />,
  );
  return { surface: container.firstElementChild!, onVizRegion, onVizClick };
}

describe('RegionDragOverlay', () => {
  it('commits a region even when the pointer leaves the row mid-drag', () => {
    const { surface, onVizRegion } = mount();
    fireEvent.pointerDown(surface, { isPrimary: true, clientX: 20 });
    // Off the row entirely — this used to cancel the whole gesture.
    fireEvent.pointerLeave(surface, { isPrimary: true });
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 200 });
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 200 });
    expect(onVizRegion).toHaveBeenCalledWith(2, 20);
  });

  it('clamps to t=0 when the drag runs off the left edge', () => {
    const { surface, onVizRegion } = mount();
    fireEvent.pointerDown(surface, { isPrimary: true, clientX: 60 });
    fireEvent.pointerMove(document, { isPrimary: true, clientX: -400 });
    fireEvent.pointerUp(document, { isPrimary: true, clientX: -400 });
    expect(onVizRegion).toHaveBeenCalledWith(0, 6);
  });

  it('still reads a tap as a plain seek', () => {
    const { surface, onVizRegion, onVizClick } = mount();
    fireEvent.pointerDown(surface, { isPrimary: true, clientX: 300 });
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 302 });
    expect(onVizRegion).not.toHaveBeenCalled();
    expect(onVizClick).toHaveBeenCalledWith(30);
  });

  it('abandons the gesture on Escape', () => {
    const { surface, onVizRegion, onVizClick } = mount();
    fireEvent.pointerDown(surface, { isPrimary: true, clientX: 20 });
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 200 });
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 200 });
    expect(onVizRegion).not.toHaveBeenCalled();
    expect(onVizClick).not.toHaveBeenCalled();
  });
});
