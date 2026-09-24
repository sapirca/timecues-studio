import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { GridChangedModal } from './GridChangedModal';

// The modal's answer is destructive (it re-times a whole song), so what the
// "Remember my preference" tick does — and, just as importantly, what it must
// NOT do — is worth pinning down.
function mount() {
  const onKeepBeats = vi.fn();
  const onKeepTimes = vi.fn();
  const onDiscard = vi.fn();
  render(
    <GridChangedModal
      affected={10}
      changeSummary="BPM 107 → 120"
      onKeepBeats={onKeepBeats}
      onKeepTimes={onKeepTimes}
      onDiscard={onDiscard}
      revertSummary="Back to 107 BPM"
    />,
  );
  return {
    onKeepBeats, onKeepTimes, onDiscard,
    remember: screen.getByRole('checkbox') as HTMLInputElement,
    beats: screen.getByText('Keep their bars & beats').closest('button')!,
    times: screen.getByText('Keep their milliseconds').closest('button')!,
    discard: screen.getByText('Undo the grid change').closest('button')!,
  };
}

afterEach(cleanup);

describe('GridChangedModal', () => {
  it('starts unticked — a remembered answer is always opt-in', () => {
    expect(mount().remember.checked).toBe(false);
  });

  it('reports the answer without remembering when the box is untouched', () => {
    const { beats, onKeepBeats } = mount();
    fireEvent.click(beats);
    expect(onKeepBeats).toHaveBeenCalledWith(false);
  });

  it('carries the tick through to whichever keep answer is clicked', () => {
    const { remember, times, onKeepTimes } = mount();
    fireEvent.click(remember);
    fireEvent.click(times);
    expect(onKeepTimes).toHaveBeenCalledWith(true);
  });

  it('never remembers "undo the grid change" — an always-undo would make the grid uneditable', () => {
    const { remember, discard, onDiscard } = mount();
    fireEvent.click(remember);
    fireEvent.click(discard);
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledWith(expect.objectContaining({ type: 'click' }));
  });
});
