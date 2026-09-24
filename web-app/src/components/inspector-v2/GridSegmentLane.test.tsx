/**
 * Two things about dragging a segment head that were wrong on screen and are
 * invisible to a type checker:
 *
 *  • the readout must not be parked on top of the head being dragged — it was
 *    rendered inside the 30px lane, which both clipped it and covered the bar
 *    line, the hatch and the cursor it is describing;
 *  • the lane must not snap on its own. It calls whatever `snapTime` the host
 *    gives it, and the host is the one that knows whether Snap-to-grid is on.
 *
 * Plus the third thing a type checker cannot see: the cut chip is drawn over
 * the audio, so it must appear only for the cut being worked on.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { GridSegmentLane, GridSegmentCutOverlay } from './GridSegmentLane';
import { resolveGridSegments } from '../../utils/gridSegments';
import { makeEmptySongInfo } from '../../types/songInfo';

const LANE_WIDTH = 1000;
const LANE_TOP = 200;
const LANE_BOTTOM = 230;
const DURATION = 100; // 10px per second

beforeAll(() => {
  // jsdom lays nothing out, so the lane has no rect to map clientX onto.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: LANE_TOP, left: 0, top: LANE_TOP, right: LANE_WIDTH, bottom: LANE_BOTTOM,
    width: LANE_WIDTH, height: LANE_BOTTOM - LANE_TOP, toJSON: () => ({}),
  } as DOMRect);
});

const SEGMENTS = resolveGridSegments({
  ...makeEmptySongInfo('demo'),
  bpm: 120,
  timeSignature: '4/4',
  gridOffset: 0,
  // Splits only shape the grid in Mapped mode, so the lane only has a head
  // to drag when the song is in it.
  gridMode: 'mapped',
  gridSegments: [{ id: 'gs_a', start: 40, bpm: 90, timeSignature: '4/4' }],
});

function mount(snapTime?: (t: number, dragged: { id: string }) => number) {
  const onHeadDrag = vi.fn();
  const { container } = render(
    <GridSegmentLane
      segments={SEGMENTS}
      duration={DURATION}
      onHeadDrag={onHeadDrag}
      snapTime={snapTime as never}
    />,
  );
  const lane = container.firstElementChild as HTMLElement;
  // Heads render after the blocks, in segment order: the opening head first,
  // the split's second.
  const heads = lane.querySelectorAll('.cursor-ew-resize');
  return { lane, heads, head: heads[heads.length - 1], onHeadDrag };
}

describe('GridSegmentLane head drag', () => {
  it('passes the raw time through when the host does not snap', () => {
    const { head, onHeadDrag } = mount((t) => t);
    fireEvent.pointerDown(head, { isPrimary: true, button: 0, clientX: 400 });
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 437 });
    cleanup();
    expect(onHeadDrag).toHaveBeenCalled();
    const [, time] = onHeadDrag.mock.calls[onHeadDrag.mock.calls.length - 1];
    expect(time).toBeCloseTo(43.7, 9);
  });

  it('commits exactly what the host snap returns', () => {
    const { head, onHeadDrag } = mount(() => 42);
    fireEvent.pointerDown(head, { isPrimary: true, button: 0, clientX: 400 });
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 437 });
    cleanup();
    const [, time] = onHeadDrag.mock.calls[onHeadDrag.mock.calls.length - 1];
    expect(time).toBe(42);
  });

  it('puts the live readout below the lane, outside it, so the drag stays visible', () => {
    const { lane, head } = mount((t) => t);
    fireEvent.pointerDown(head, { isPrimary: true, button: 0, clientX: 400 });
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 437 });

    const readout = document.body.querySelector('.fixed.z-\\[1400\\]') as HTMLElement | null;
    expect(readout).not.toBeNull();
    expect(lane.contains(readout!)).toBe(false);
    expect(readout!.style.top).toBe(`${LANE_BOTTOM + 6}px`);
    expect(readout!.textContent).toContain('0:43.700');
    cleanup();
    // The readout goes with the drag — no stray label left on the page.
    expect(document.body.querySelector('.fixed.z-\\[1400\\]')).toBeNull();
  });
});


/**
 * The opening head is the song's own downbeat — `gridOffset`, not a stored
 * split — and a song whose bar 1 isn't at 0:00 needs it moved. It used to be
 * the one head the lane refused to drag.
 */
describe('the opening head', () => {
  it('is draggable, like every other head', () => {
    const { heads } = mount((t) => t);
    expect(heads).toHaveLength(2);
    cleanup();
  });

  it('reports the drag against the opening segment, not the split', () => {
    const { heads, onHeadDrag } = mount((t) => t);
    fireEvent.pointerDown(heads[0], { isPrimary: true, button: 0, clientX: 0 });
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 63 });
    const [segment, time] = onHeadDrag.mock.calls[onHeadDrag.mock.calls.length - 1];
    expect(segment.index).toBe(0);
    expect(time).toBeCloseTo(6.3, 9);
    cleanup();
  });

  it('tells the reader it cuts nothing and cannot snap', () => {
    const { heads } = mount((t) => t);
    fireEvent.pointerDown(heads[0], { isPrimary: true, button: 0, clientX: 0 });
    // 1.2s — inside the opening bar (120 BPM 4/4 = 2s), so nothing folds.
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 12 });
    const readout = document.body.querySelector('.fixed.z-\\[1400\\]') as HTMLElement;
    // No outgoing grid exists before the origin, so "snap" would be a lie.
    expect(readout.textContent).toContain('free');
    expect(readout.textContent).toContain('0:01.200');
    expect(readout.textContent).toContain('every bar line moves with it');
    cleanup();
  });

  it('shows where an origin dragged past a bar line actually lands', () => {
    // gridOffset is a phase inside the first bar: the app folds anything
    // larger back and renumbers the bars, leaving every grid line put. A
    // readout that kept promising 0:06.300 would be promising a downbeat the
    // commit immediately moves.
    const { heads } = mount((t) => t);
    fireEvent.pointerDown(heads[0], { isPrimary: true, button: 0, clientX: 0 });
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 63 });   // 6.3s, three bars along
    const readout = document.body.querySelector('.fixed.z-\\[1400\\]') as HTMLElement;
    expect(readout.textContent).toContain('0:00.300');
    expect(readout.textContent).not.toContain('0:06.300');
    expect(readout.textContent).toContain('same grid, renumbered');
    cleanup();
  });

  it('refuses to be dragged over the split it would delete', () => {
    const { heads } = mount((t) => t);
    fireEvent.pointerDown(heads[0], { isPrimary: true, button: 0, clientX: 0 });
    // 45s: past the split at 40s, which normalize would drop on commit.
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 450 });
    const readout = document.body.querySelector('.fixed.z-\\[1400\\]') as HTMLElement;
    expect(readout.textContent).toMatch(/Too close to segment 2/);
    cleanup();
  });
});

// A split at 41s lands mid-bar on the 120 BPM opening grid (2s bars, so bar 20
// starts at 40s), leaving the opening segment with 2 of its 4 beats.
const CUT_SEGMENTS = resolveGridSegments({
  ...makeEmptySongInfo('demo'),
  bpm: 120,
  timeSignature: '4/4',
  gridOffset: 0,
  gridMode: 'mapped',
  gridSegments: [{ id: 'gs_a', start: 41, bpm: 90, timeSignature: '4/4' }],
});

function mountOverlay(labelledSegmentId: string | null) {
  const { container } = render(
    <GridSegmentCutOverlay
      segments={CUT_SEGMENTS}
      duration={DURATION}
      labelledSegmentId={labelledSegmentId}
    />,
  );
  return container;
}

describe('GridSegmentCutOverlay label', () => {
  it('draws the hatch but no chip when nothing is selected', () => {
    const container = mountOverlay(null);
    // The hatch is the state and stays put; only the chip is conditional.
    expect(container.querySelector('[title*="cut short"]')).not.toBeNull();
    expect(container.textContent).not.toContain('of 4 beats');
    cleanup();
  });

  it('labels the cut when its own segment is selected', () => {
    const container = mountOverlay('opening');
    expect(container.textContent).toContain('2 of 4 beats');
    cleanup();
  });

  it('labels the cut when the segment whose head did the cutting is selected', () => {
    const container = mountOverlay('gs_a');
    expect(container.textContent).toContain('2 of 4 beats');
    cleanup();
  });
});
