import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserLaneMenuItems, type UserLaneActions, type LaneSnapUnit } from './UserLaneMenuItems';

function actions(snap: UserLaneActions['snap'], extractAdsr: UserLaneActions['extractAdsr'] = null, locked = false): UserLaneActions {
  return {
    locked, toggleLock: () => {}, duplicate: () => {},
    region: null, split: null, mergeTargets: [], mergeInto: () => {}, snap, extractAdsr,
  };
}

describe('UserLaneMenuItems — snap', () => {
  it('offers Snap to beats and Snap to bars, each counting and running its own unit', async () => {
    const run = vi.fn();
    const count = (unit: LaneSnapUnit) => (unit === 'beat' ? 2 : 5);
    const onDone = vi.fn();
    render(<UserLaneMenuItems name="Cues 1" actions={actions({ count, run })} onDone={onDone} />);
    const beats = screen.getByRole('button', { name: /Snap to beats/ });
    const bars = screen.getByRole('button', { name: /Snap to bars/ });
    expect(beats.textContent).toContain('2');
    expect(bars.textContent).toContain('5');
    await userEvent.click(bars);
    expect(run).toHaveBeenCalledWith('bar');
    expect(onDone).toHaveBeenCalled();
  });

  it('greys a unit whose items already sit on it', () => {
    render(<UserLaneMenuItems name="Cues 1" actions={actions({ count: (u) => (u === 'beat' ? 0 : 3), run: () => {} })} onDone={() => {}} />);
    expect(screen.getByRole('button', { name: /Snap to beats/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Snap to bars/ })).toBeEnabled();
  });

  it('says why when the song has no tempo, and never counts', () => {
    const count = vi.fn(() => 4);
    render(<UserLaneMenuItems name="Cues 1" actions={actions({ count, run: () => {}, why: 'no BPM' })} onDone={() => {}} />);
    expect(screen.getByRole('button', { name: /Snap to bars/ })).toBeDisabled();
    expect(count).not.toHaveBeenCalled();
  });
});

describe('UserLaneMenuItems — Extract ADSR', () => {
  const adsr = (over: Partial<NonNullable<UserLaneActions['extractAdsr']>> = {}): UserLaneActions['extractAdsr'] => ({
    run: () => {}, sources: ['mix', 'drums'], measured: false, running: false, ...over,
  });

  it('offers one button per source; a press extracts from that source', async () => {
    const run = vi.fn();
    const onDone = vi.fn();
    const { rerender } = render(<UserLaneMenuItems name="Pads" actions={actions(null, adsr({ run }))} onDone={onDone} />);
    expect(screen.getByText('Extract ADSR from')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Drums' }));
    expect(run).toHaveBeenCalledWith('drums');
    expect(onDone).toHaveBeenCalled();
    rerender(<UserLaneMenuItems name="Pads" actions={actions(null, adsr({ run, measured: true }))} onDone={onDone} />);
    expect(screen.getByText('Re-extract ADSR from')).toBeTruthy();
  });

  it('is greyed while an extraction is out, and on a locked lane', () => {
    const { rerender } = render(<UserLaneMenuItems name="Pads" actions={actions(null, adsr({ running: true }))} onDone={() => {}} />);
    expect(screen.getByRole('button', { name: 'Mix' })).toBeDisabled();
    rerender(<UserLaneMenuItems name="Pads" actions={actions(null, adsr(), true)} onDone={() => {}} />);
    expect(screen.getByRole('button', { name: 'Mix' })).toBeDisabled();
  });

  it('is absent on a lane with nothing timed', () => {
    render(<UserLaneMenuItems name="Lyrics" actions={actions(null)} onDone={() => {}} />);
    expect(screen.queryByText(/ADSR/)).toBeNull();
  });
});
