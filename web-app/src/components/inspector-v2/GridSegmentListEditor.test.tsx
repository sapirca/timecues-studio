/**
 * The sidebar list is where a segment is discovered at all, so its trailing
 * control has to read as what it does: MERGE this segment into the one above,
 * which then counts on at its own tempo. Row 1 has nothing above it and must
 * stay inert — the same rule the lane and the editor enforce.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { GridSegmentListEditor } from './GridSegmentListEditor';
import { resolveGridSegments } from '../../utils/gridSegments';
import { makeEmptySongInfo } from '../../types/songInfo';

function mount() {
  const onDelete = vi.fn();
  const segments = resolveGridSegments({
    ...makeEmptySongInfo('demo'),
    bpm: 120,
    timeSignature: '4/4',
    gridOffset: 0,
    gridMode: 'mapped',
    gridSegments: [{ id: 'gs_a', start: 41, bpm: 90, timeSignature: '6/8' }],
  });
  render(<GridSegmentListEditor segments={segments} playerTime={41} onDelete={onDelete} />);
  return { onDelete, segments };
}

describe('GridSegmentListEditor merge control', () => {
  it('merges a segment into the one above it', () => {
    const { onDelete, segments } = mount();
    const merge = screen.getByLabelText('Merge segment 2 into segment 1');
    // The tooltip names the tempo that survives — segment 1's 120, not the
    // 90 this row is giving up.
    expect(merge.getAttribute('title')).toContain('120.00 BPM');
    fireEvent.click(merge);
    expect(onDelete).toHaveBeenCalledWith(segments[1]);
  });

  it('leaves row 1 with nothing to merge into', () => {
    const { onDelete } = mount();
    const opening = screen.getByLabelText('Segment 1 has nothing before it to merge into');
    expect(opening).toBeDisabled();
    fireEvent.click(opening);
    expect(onDelete).not.toHaveBeenCalled();
  });
});
