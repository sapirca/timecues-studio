/**
 * A tempo is judged against the audio behind the popover, not against its own
 * digits, so the tempo field streams while it is being typed or nudged. What
 * a type checker cannot see, and what these cover:
 *
 *  • every in-range keystroke reaches the grid, and half-typed or out-of-range
 *    states do NOT — clamping "1" on the way to "144" would yank the grid down
 *    to the 20 BPM floor and back on the way past;
 *  • a streamed value is marked `live`, which is what lets the host collapse
 *    the run into one undo step;
 *  • the blur that ends the run commits nothing more, because the value has
 *    already landed;
 *  • Escape puts the grid back, since by then something has gone out.
 *
 * The host here feeds the edited tempo back in as a prop, the way
 * InspectorPageV2 does — with a mock that never re-renders, "already landed"
 * cannot be told apart from "landed twice".
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { createRef, useMemo, useState } from 'react';
import { GridSegmentEditPopover } from './GridSegmentEditPopover';
import { resolveGridSegments } from '../../utils/gridSegments';
import { makeEmptySongInfo } from '../../types/songInfo';

const OPENED_AT = 90;

function Host({ onChange }: { onChange: (patch: { bpm?: number }, opts?: { live?: boolean }) => void }) {
  const [bpm, setBpm] = useState(OPENED_AT);
  const segments = useMemo(() => resolveGridSegments({
    ...makeEmptySongInfo('demo'),
    bpm: 120,
    timeSignature: '4/4',
    gridOffset: 0,
    gridMode: 'mapped',
    gridSegments: [{ id: 'gs_a', start: 41, bpm, timeSignature: '4/4' }],
  }), [bpm]);
  return (
    <GridSegmentEditPopover
      segment={segments[1]}
      segments={segments}
      total={2}
      popoverRef={createRef<HTMLDivElement>()}
      positionStyle={{}}
      onChange={(patch, opts) => {
        onChange(patch, opts);
        if (patch.bpm != null) setBpm(patch.bpm);
      }}
      onDelete={vi.fn()}
      onClose={vi.fn()}
    />
  );
}

function mount() {
  const onChange = vi.fn();
  render(<Host onChange={onChange} />);
  const bpm = screen.getByLabelText('Tempo') as HTMLInputElement;
  fireEvent.focus(bpm);
  return { bpm, onChange };
}

/** Type a value the way a curator does — one character at a time. */
function type(input: HTMLInputElement, value: string) {
  for (let i = 0; i <= value.length; i++) {
    fireEvent.change(input, { target: { value: value.slice(0, i) } });
  }
}

describe('GridSegmentEditPopover tempo', () => {
  it('streams the typed tempo to the grid, skipping the half-typed values', () => {
    const { bpm, onChange } = mount();
    // "1" and "14" are below the 20 BPM floor: a number in progress, not a
    // tempo anyone asked for.
    type(bpm, '144');
    expect(onChange.mock.calls).toEqual([[{ bpm: 144 }, { live: true }]]);
  });

  it('nudges the grid on arrow keys without waiting for a blur', () => {
    const { bpm, onChange } = mount();
    fireEvent.keyDown(bpm, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenCalledWith({ bpm: OPENED_AT + 0.01 }, { live: true });
  });

  it('commits nothing more on blur — the streamed value already landed', () => {
    const { bpm, onChange } = mount();
    type(bpm, '144');
    onChange.mockClear();
    fireEvent.blur(bpm);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('puts the grid back on Escape, and the blur behind it commits nothing', () => {
    const { bpm, onChange } = mount();
    type(bpm, '144');
    onChange.mockClear();
    fireEvent.keyDown(bpm, { key: 'Escape' });
    fireEvent.blur(bpm);
    // A plain commit, not a live one: the restore is its own act, not part of
    // the run it undoes.
    expect(onChange.mock.calls).toEqual([[{ bpm: OPENED_AT }, undefined]]);
    expect(bpm.value).toBe('90.00');
  });
});

/** The way out of a segment is a merge into the one before it — same stored
 *  act as dropping the head, but the button has to say what the curator gets:
 *  which segment swallows the span, and at what tempo it counts on. */
describe('GridSegmentEditPopover merge', () => {
  function renderSegment(index: 0 | 1) {
    const onDelete = vi.fn();
    const segments = resolveGridSegments({
      ...makeEmptySongInfo('demo'),
      bpm: 120,
      timeSignature: '4/4',
      gridOffset: 0,
      gridMode: 'mapped',
      gridSegments: [{ id: 'gs_a', start: 41, bpm: 90, timeSignature: '6/8' }],
    });
    render(
      <GridSegmentEditPopover
        segment={segments[index]}
        segments={segments}
        total={2}
        popoverRef={createRef<HTMLDivElement>()}
        positionStyle={{}}
        onChange={vi.fn()}
        onDelete={onDelete}
        onClose={vi.fn()}
      />,
    );
    return { button: screen.getByRole('button', { name: /Merge with previous/ }), onDelete };
  }

  it('merges into the previous segment, naming the tempo that survives', () => {
    const { button, onDelete } = renderSegment(1);
    // Segment 1 keeps counting at the song's own 120 BPM in 4/4 — not this
    // segment's 90 in 6/8, which is exactly the count being given up.
    expect(button.getAttribute('title')).toContain('segment 1');
    expect(button.getAttribute('title')).toContain('120.00 BPM');
    expect(button.getAttribute('title')).toContain('4/4');
    fireEvent.click(button);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('refuses on the opening segment, which has nothing before it', () => {
    const { button, onDelete } = renderSegment(0);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onDelete).not.toHaveBeenCalled();
  });
});
