/**
 * The one-editor-at-a-time contract for prominence.
 *
 * Before this, clicking an item opened the card AND the four-row strip on the
 * item's lane — two editors for one value, one of them floating over the lane
 * the other lived in. Now exactly one is ever on screen: expanding the card's
 * Prominence section hands the job to the strip and the card stops drawing,
 * the strip's × hands it back, and when no strip can open (Prep, review,
 * read-only detector layers) the card keeps the whole job itself.
 */

import { useRef } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { CardSection, setCardSectionOpen, useCardSectionOpen } from './CardSection';
import { AnnotationPointCard } from './AnnotationPointCard';
import { prominenceSection } from './ProminenceControl';
import { SettingsProvider } from '../../../context/SettingsContext';
import { ProminenceStrip } from './ProminenceLane';
import { PROMINENCE_EPSILON, type ProminenceEnvelope } from '../../../types/annotationLayer';

afterEach(() => {
  cleanup();
  localStorage.clear();
  // The fold store is module-level (the timeline reads it too), so clearing
  // localStorage isn't enough to un-remember it between cases.
  setCardSectionOpen('prominence', false);
});

/** Mirrors what InspectorPageV2 does: the lane grows a strip only while the
 *  card's Prominence section is expanded. */
function LaneGate() {
  const open = useCardSectionOpen('prominence', false);
  return <span data-testid="gate">{open ? 'strip' : 'no-strip'}</span>;
}

function Card({ sections, extras }: Pick<React.ComponentProps<typeof AnnotationPointCard>, 'sections' | 'extras'>) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <AnnotationPointCard
      popoverRef={ref}
      kind="loop"
      layerName="Loops 1"
      layerColor="#4ade80"
      start={0}
      end={4}
      label=""
      description=""
      sections={sections}
      extras={extras}
      onChange={vi.fn()}
      onDelete={vi.fn()}
      onClose={vi.fn()}
      positionStyle={{ left: 0, top: 0 }}
    />
  );
}

const ARC: ProminenceEnvelope = [
  { t: 0, level: 'lead' },
  { t: 2, level: 'backing' },
];

function Strip(props: Partial<React.ComponentProps<typeof ProminenceStrip>> = {}) {
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={containerRef} data-testid="strip">
      <ProminenceStrip
        points={ARC}
        start={0}
        end={4}
        duration={10}
        containerRef={containerRef}
        color="#4ade80"
        top={0}
        onChange={vi.fn()}
        {...props}
      />
    </div>
  );
}

describe('prominence edit mode', () => {
  it('opens the lane strip only once the Prominence section is expanded', () => {
    render(
      <>
        <LaneGate />
        <CardSection id="prominence" title="Prominence" defaultOpen={false} content={<i />} />
      </>,
    );
    // Opening the card alone must not open a strip — that was the old bug.
    expect(screen.getByTestId('gate').textContent).toBe('no-strip');

    fireEvent.click(screen.getByRole('button', { name: /prominence/i }));
    expect(screen.getByTestId('gate').textContent).toBe('strip');

    fireEvent.click(screen.getByRole('button', { name: /prominence/i }));
    expect(screen.getByTestId('gate').textContent).toBe('no-strip');
  });

  it('takes the card off the screen while the lane editor is up', () => {
    const card = (
      <SettingsProvider>
        <Card
          extras={<div data-testid="repeats">Repeats</div>}
          sections={[prominenceSection({
            points: ARC, start: 0, end: 4, color: '#4ade80', onChange: vi.fn(),
          })]}
        />
      </SettingsProvider>
    );
    render(<>{card}<Strip /></>);
    // Folded: an ordinary card — label, headline field, breakpoint chips.
    expect(screen.getByPlaceholderText(/short label/i)).toBeInTheDocument();
    expect(screen.getByTestId('repeats')).toBeInTheDocument();
    expect(screen.getAllByTitle(/Remove this breakpoint/)).toHaveLength(2);

    act(() => setCardSectionOpen('prominence', true));
    // Open: the lane editor is the only thing on screen. Not two surfaces
    // competing for the same attention — the card simply isn't drawn.
    expect(document.querySelector('[data-annotation-popover]')).toBeNull();
    expect(screen.queryByPlaceholderText(/short label/i)).not.toBeInTheDocument();
    expect(screen.queryAllByTitle(/Remove this breakpoint/)).toHaveLength(0);
    expect(screen.getByTestId('strip')).toBeInTheDocument();

    // The strip's own Done is the way back to the card.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByPlaceholderText(/short label/i)).toBeInTheDocument();
    expect(screen.getByTestId('repeats')).toBeInTheDocument();
  });

  it('keeps the card when the lane editor cannot open at all', () => {
    // Prep, review mode and read-only detector layers all withhold the lane's
    // onProminenceChange, so no strip mounts. The card has to stay usable.
    render(
      <SettingsProvider>
        <Card sections={[prominenceSection({
          points: ARC, start: 0, end: 4, color: '#4ade80', onChange: vi.fn(),
        })]} />
      </SettingsProvider>,
    );
    act(() => setCardSectionOpen('prominence', true));
    expect(screen.getByPlaceholderText(/short label/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lead' })).toBeInTheDocument();
    expect(screen.getAllByTitle(/Remove this breakpoint/)).toHaveLength(2);
  });

  it('places a level at the playhead from the strip header', () => {
    const onChange = vi.fn();
    render(<Strip points={[{ t: 0, level: 'lead' }]} currentTime={2} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Backing' }));
    expect(onChange).toHaveBeenCalledWith([
      { t: 0, level: 'lead' },
      { t: 2, level: 'backing' },
    ]);
  });

  it('runs the last level out to the item’s end', () => {
    // The band above the strip fills to the end; the strip has to agree, or
    // the arc reads as stopping at the final dot.
    const { container } = render(<Strip points={[{ t: 0, level: 'lead' }, { t: 2, level: 'backing' }]} />);
    const line = container.querySelector('polyline')!.getAttribute('points')!;
    // …lead across to the breakpoint, drop to backing, then hold to x=100.
    expect(line.trim().split(/\s+/).pop()).toMatch(/^100,/);
  });

  it('places the first breakpoint where it was clicked, not at 0:00', () => {
    const onChange = vi.fn();
    const { container } = render(<Strip points={undefined} onChange={onChange} />);
    // Row 1 (Counter), a quarter of the way along a 4-second item.
    const row = container.querySelectorAll('[title*="click to place a breakpoint"]')[1] as HTMLElement;
    row.getBoundingClientRect = () => ({
      left: 0, width: 100, top: 0, height: 11, right: 100, bottom: 11, x: 0, y: 0, toJSON: () => ({}),
    }) as DOMRect;
    fireEvent.click(row, { clientX: 25 });
    expect(onChange).toHaveBeenCalledWith([
      { t: 0, level: 'lead' },
      { t: 1, level: 'counter' },
    ]);
  });

  it('snaps a placed breakpoint onto the grid when the host snaps', () => {
    // The host's snap runs in TRACK seconds — the grid is the song's, not the
    // item's — so a strip on an item that doesn't start at 0:00 still lands on
    // the song's own lines. Half-second lines here, on a 4s item at +1s.
    const onChange = vi.fn();
    const snapTime = (t: number) => Math.round(t * 2) / 2;
    const { container } = render(
      <Strip points={[{ t: 0, level: 'lead' }]} start={1} end={5} snapTime={snapTime} onChange={onChange} />,
    );
    const row = container.querySelectorAll('[title*="click to place a breakpoint"]')[1] as HTMLElement;
    row.getBoundingClientRect = () => ({
      left: 0, width: 100, top: 0, height: 11, right: 100, bottom: 11, x: 0, y: 0, toJSON: () => ({}),
    }) as DOMRect;
    // 40% along a 4s item = +1.6s = 2.6s in the track → snaps to 2.5s → +1.5s.
    fireEvent.click(row, { clientX: 40 });
    expect(onChange).toHaveBeenCalledWith([
      { t: 0, level: 'lead' },
      { t: 1.5, level: 'counter' },
    ]);
  });

  it('leaves a placed breakpoint where it was clicked when the host does not snap', () => {
    const onChange = vi.fn();
    const { container } = render(
      <Strip points={[{ t: 0, level: 'lead' }]} start={1} end={5} onChange={onChange} />,
    );
    const row = container.querySelectorAll('[title*="click to place a breakpoint"]')[1] as HTMLElement;
    row.getBoundingClientRect = () => ({
      left: 0, width: 100, top: 0, height: 11, right: 100, bottom: 11, x: 0, y: 0, toJSON: () => ({}),
    }) as DOMRect;
    fireEvent.click(row, { clientX: 40 });
    expect(onChange).toHaveBeenCalledWith([
      { t: 0, level: 'lead' },
      { t: 1.6, level: 'counter' },
    ]);
  });

  it('snaps a dragged breakpoint, and still refuses to cross its neighbour', () => {
    // x is measured against the timeline container (10s across 100px here),
    // y against the strip's four rows — so the drag has to land on a grid line
    // AND keep the handle behind the next breakpoint.
    const onChange = vi.fn();
    const snapTime = (t: number) => Math.round(t * 2) / 2;
    const { container } = render(
      <Strip
        points={[{ t: 0, level: 'lead' }, { t: 2, level: 'backing' }, { t: 3, level: 'silent' }]}
        snapTime={snapTime}
        onChange={onChange}
      />,
    );
    screen.getByTestId('strip').getBoundingClientRect = () => ({
      left: 0, width: 100, top: 0, height: 76, right: 100, bottom: 76, x: 0, y: 0, toJSON: () => ({}),
    }) as DOMRect;
    // The four-row box, so y maps to a level instead of falling back to row 0.
    const rows = container.querySelector('.rounded-sm.overflow-hidden') as HTMLElement;
    rows.getBoundingClientRect = () => ({
      left: 0, width: 100, top: 0, height: 56, right: 100, bottom: 56, x: 0, y: 0, toJSON: () => ({}),
    }) as DOMRect;

    const dot = screen.getAllByTitle(/Drag to move/)[0];
    fireEvent.pointerDown(dot, { isPrimary: true });
    // 27px = 2.7s, with the pointer in the Backing row (rows are 14px tall).
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 27, clientY: 35 });
    expect(onChange).toHaveBeenLastCalledWith([
      { t: 0, level: 'lead' },
      { t: 2.5, level: 'backing' },
      { t: 3, level: 'silent' },
    ]);

    // Dragged past the next breakpoint, the grid line beyond it gives way to
    // the neighbour — snapping must never let handles reorder or stack.
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 38, clientY: 35 });
    const last = onChange.mock.lastCall![0] as ProminenceEnvelope;
    // Parked one epsilon behind its neighbour, not snapped past it.
    expect(last[1].t).toBeCloseTo(3 - PROMINENCE_EPSILON, 9);
    fireEvent.pointerUp(document, { isPrimary: true });
  });

  it('toggles a crossfade from the strip, so the chips are not needed for it', () => {
    const onChange = vi.fn();
    render(<Strip onChange={onChange} />);
    // Only the transitions are dots; the opening breakpoint is a cap.
    const dots = screen.getAllByTitle(/Drag to move/);
    expect(dots).toHaveLength(1);
    fireEvent.pointerDown(dots[0], { isPrimary: true, altKey: true });
    expect(onChange).toHaveBeenCalledWith([
      { t: 0, level: 'lead' },
      { t: 2, level: 'backing', ramp: 'ramp' },
    ]);
  });

  it('caps both ends of the arc — held levels, not placeable points', () => {
    const { container } = render(<Strip />);
    // The opening breakpoint reads as a cap and offers only the drag that
    // means anything for it: up and down.
    const opening = screen.getByTitle(/from the start/);
    expect(opening.className).toContain('cursor-ns-resize');
    expect(opening.title).toMatch(/Drag up or down/);
    expect(opening.title).not.toMatch(/crossfade/);
    // …and the run-out end is inert: nothing to place after the annotation.
    expect(container.querySelectorAll('div.absolute.pointer-events-none')).toHaveLength(1);
  });

  it('leaves the opening breakpoint unrampable — nothing precedes it', () => {
    const onChange = vi.fn();
    render(<Strip onChange={onChange} />);
    fireEvent.pointerDown(screen.getByTitle(/from the start/), { isPrimary: true, altKey: true });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('setCardSectionOpen', () => {
  it('notifies readers outside the card', () => {
    render(<LaneGate />);
    expect(screen.getByTestId('gate').textContent).toBe('no-strip');
    act(() => setCardSectionOpen('prominence', true));
    expect(screen.getByTestId('gate').textContent).toBe('strip');
  });
});
