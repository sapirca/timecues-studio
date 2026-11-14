import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MergeControlsBar } from './MergeControlsBar';
import type { MergeSourceLane } from './boundaryMerge';

function renderBar(lanes: MergeSourceLane[], onSetLanesHidden = vi.fn()) {
  render(
    <MergeControlsBar
      lanes={lanes}
      onRemoveLane={() => {}}
      onSetLanesHidden={onSetLanesHidden}
      onClear={() => {}}
      onCommit={() => {}}
      onRestoreDropped={() => {}}
      keptCount={3}
      totalCount={3}
      droppedCount={0}
      committedCount={0}
    />,
  );
  return onSetLanesHidden;
}

const sf: MergeSourceLane = { id: 'sf', label: 'SF', color: '#f00', times: [1, 2] };
const olda: MergeSourceLane = { id: 'olda', label: 'OLDA', color: '#0f0', times: [3] };

describe('MergeControlsBar', () => {
  it("hides one member's lane without taking it out of the merge", async () => {
    const onSetLanesHidden = renderBar([sf, olda]);
    await userEvent.click(screen.getByRole('button', { name: 'Hide the SF lane' }));
    expect(onSetLanesHidden).toHaveBeenCalledWith(['sf'], true);
  });

  it('offers Merge only while any member is drawn, and Show lanes once none is', async () => {
    const onSetLanesHidden = renderBar([sf, { ...olda, hidden: true }]);
    await userEvent.click(screen.getByRole('button', { name: 'Merge only' }));
    expect(onSetLanesHidden).toHaveBeenCalledWith(['sf', 'olda'], true);
  });

  it('puts every lane back from Show lanes', async () => {
    const onSetLanesHidden = renderBar([{ ...sf, hidden: true }, { ...olda, hidden: true }]);
    expect(screen.getByRole('button', { name: 'Show the SF lane' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Show lanes' }));
    expect(onSetLanesHidden).toHaveBeenCalledWith(['sf', 'olda'], false);
  });

  it('switches Smart merge on and off, and says so', async () => {
    const onSetSmart = vi.fn();
    const { rerender } = render(
      <MergeControlsBar
        lanes={[sf, olda]} onRemoveLane={() => {}} onClear={() => {}} onCommit={() => {}}
        onRestoreDropped={() => {}} keptCount={2} totalCount={2} droppedCount={0} committedCount={0}
        smart={false} onSetSmart={onSetSmart}
      />,
    );
    const toggle = screen.getByRole('button', { name: 'Smart merge' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(toggle);
    expect(onSetSmart).toHaveBeenCalledWith(true);
    rerender(
      <MergeControlsBar
        lanes={[sf, olda]} onRemoveLane={() => {}} onClear={() => {}} onCommit={() => {}}
        onRestoreDropped={() => {}} keptCount={2} totalCount={2} droppedCount={0} committedCount={0}
        smart onSetSmart={onSetSmart}
      />,
    );
    // On, the button names the way back: the union.
    expect(screen.queryByRole('button', { name: 'Smart merge' })).toBeNull();
    const back = screen.getByRole('button', { name: 'All boundaries' });
    expect(back.getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(back);
    expect(onSetSmart).toHaveBeenLastCalledWith(false);
    expect(screen.getByTitle(/2 kept of 2 candidates, one per place, from the 3 boundaries/)).toBeTruthy();
  });
});
