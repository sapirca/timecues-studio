import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VizControlBar, type AlgoOverlayOption } from './VizControlBar';

// A ticked algo row that the stem filter is keeping off the canvas used to look
// identical to one that is drawn — same checkmark, no lane, nothing said. These
// cover the three places that now say so: the trigger badge, the popover
// banner, and the row itself.

const noop = () => {};

function bar(over: Partial<React.ComponentProps<typeof VizControlBar>> = {}) {
  const required = {
    showManual: false, onToggleManual: noop,
    showAutoGuess: false, onToggleAutoGuess: noop,
    showWaveform: true, onToggleWaveform: noop,
    showEQ: false, onToggleEQ: noop,
    showSpectrogram: false, onToggleSpectrogram: noop,
    showCepstrogram: false, onToggleCepstrogram: noop,
    showChroma: false, onToggleChroma: noop,
    showTempogram: false, onToggleTempogram: noop,
    showSsm: false, onToggleSsm: noop,
    showEnergy: false, onToggleEnergy: noop,
    showBrightness: false, onToggleBrightness: noop,
    showNovelty: false, onToggleNovelty: noop,
    showOnsets: false, onToggleOnsets: noop,
    showFlux: false, onToggleFlux: noop,
    showBeatGrid: false, onToggleBeatGrid: noop,
    beatGridUnit: 'beat' as const, onBeatGridUnitChange: noop,
    snapToGrid: false, onToggleSnapToGrid: noop,
    captureGlobalHScroll: false, onToggleCaptureGlobalHScroll: noop,
    gridLineThickness: 1, onGridLineThicknessChange: noop,
  } as unknown as React.ComponentProps<typeof VizControlBar>;
  return render(<VizControlBar {...required} {...over} />);
}

const OPTIONS: AlgoOverlayOption[] = [
  { id: 'whisper-base', label: 'Whisper-base lyrics', hiddenByStemFilter: 'vocals' },
  { id: 'whisper-base__vocals', label: 'Whisper-base lyrics · vocals' },
];

const algoProps = (over: Record<string, unknown> = {}) => ({
  showAlgos: true,
  algoOptions: OPTIONS,
  selectedAlgos: new Set(['whisper-base', 'whisper-base__vocals']),
  onToggleAlgo: noop,
  algoStemFilter: 'vocals',
  algoStemFilterHiddenCount: 1,
  ...over,
});

describe('VizControlBar — stem-filtered algo rows', () => {
  it('reads the badge as drawn/ticked while the filter is hiding a row', () => {
    bar(algoProps());
    expect(screen.getByLabelText(/^Algorithms/)).toHaveTextContent('1/2');
  });

  it('shows a plain count when nothing is hidden', () => {
    bar(algoProps({
      algoOptions: OPTIONS.map((o) => ({ ...o, hiddenByStemFilter: undefined })),
      algoStemFilterHiddenCount: 0,
    }));
    expect(screen.getByLabelText(/^Algorithms/)).toHaveTextContent('2');
    expect(screen.getByLabelText(/^Algorithms/)).not.toHaveTextContent('/');
  });

  it('names the stem and flags the row inside the popover', async () => {
    const user = userEvent.setup();
    bar(algoProps());
    await user.click(screen.getByLabelText(/^Algorithms/));

    expect(screen.getByText(/Stem filter is on/)).toBeInTheDocument();
    expect(screen.getByText('vocals')).toBeInTheDocument();
    // The mix row carries the marker; the vocals row, which draws, does not.
    expect(screen.getByText('Whisper-base lyrics').closest('label'))
      .toHaveTextContent('hidden');
    expect(screen.getByText('Whisper-base lyrics · vocals').closest('label'))
      .not.toHaveTextContent('hidden');
  });

  it('offers one click back to every stem', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    bar(algoProps({ onClearAlgoStemFilter: onClear }));
    await user.click(screen.getByLabelText(/^Algorithms/));
    await user.click(screen.getByRole('button', { name: 'show all stems' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe('VizControlBar — stem lock checkbox', () => {
  it('is ticked by default and reports an unlock', async () => {
    const user = userEvent.setup();
    const onStemLockChange = vi.fn();
    bar({ onStemLockChange });
    await user.click(screen.getByLabelText('More visualization options'));
    const box = screen.getByLabelText('Lock player stem to stem filter');
    expect(box).toBeChecked();
    await user.click(box);
    expect(onStemLockChange).toHaveBeenCalledWith(false);
  });

  it('is absent when the page does not offer it', async () => {
    const user = userEvent.setup();
    bar();
    await user.click(screen.getByLabelText('More visualization options'));
    expect(screen.queryByLabelText('Lock player stem to stem filter')).toBeNull();
  });
});
