import { useRef } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NodeEditPopover } from './NodeEditPopover';
import { SettingsProvider } from '../../context/SettingsContext';
import type { RiffNode } from '../../types/annotationLayer';

const getAudioBuffer = vi.hoisted(() => vi.fn());
const computeOnsetEnvelopeWindow = vi.hoisted(() => vi.fn());
vi.mock('../../services/audioAnalysis', () => ({ getAudioBuffer }));
vi.mock('../../services/mirAnalysis', () => ({ computeOnsetEnvelopeWindow }));

const node: RiffNode = {
  id: 'n1',
  name: 'Blocks 1',
  color: '#f59e0b',
  highlightedBeats: [],
  spans: [],
  stepsPerCycle: 32,
  subbeatsPerBeat: 4,
  kind: 'boundary',
  segments: [{ start: 0, end: 8, kind: 'empty' }],
};

/** `veto: true` stands in for a live Tap Along session whose confirm the user
 *  cancelled — the guard says no, so the card must stay open AND keep the
 *  node. */
function mount(veto: boolean) {
  const onDelete = vi.fn();
  const onClose = vi.fn(() => (veto ? false : undefined));
  function Card() {
    const ref = useRef<HTMLDivElement>(null);
    return (
      <NodeEditPopover
        node={node}
        popoverRef={ref}
        positionStyle={{ left: 0, top: 0 }}
        onChange={vi.fn()}
        onDelete={onDelete}
        onClose={onClose}
        registerCloseGuard={vi.fn()}
        bpm={120}
        occurrence={null}
      />
    );
  }
  render(<SettingsProvider><Card /></SettingsProvider>);
  return { onDelete, onClose };
}

afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); });

describe('NodeEditPopover Delete', () => {
  it('does not delete the node when a close guard vetoes the close', () => {
    const { onDelete, onClose } = mount(true);
    fireEvent.click(screen.getByTitle(/^Delete this node/));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('deletes once the close goes through', () => {
    const { onDelete } = mount(false);
    fireEvent.click(screen.getByTitle(/^Delete this node/));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

describe('NodeEditPopover Tap Along on close', () => {
  /** The card with a real placement to tap along to — `currentTime` sweeps the
   *  occurrence, which is what the tap capture reads its beat position off. */
  function mountTapping() {
    const onChange = vi.fn();
    let guard: (() => boolean) | null = null;
    function Card({ currentTime }: { currentTime: number }) {
      const ref = useRef<HTMLDivElement>(null);
      return (
        <NodeEditPopover
          node={node}
          popoverRef={ref}
          positionStyle={{ left: 0, top: 0 }}
          onChange={onChange}
          onDelete={vi.fn()}
          onClose={vi.fn()}
          registerCloseGuard={(g) => { guard = g; }}
          bpm={120}
          // 8 beats at 120bpm — the node's own length, so a beat is 0.5s.
          occurrence={{ start: 0, end: 4 }}
          isPlaying
          currentTime={currentTime}
          onPlay={vi.fn()}
          onStop={vi.fn()}
        />
      );
    }
    const view = render(<SettingsProvider><Card currentTime={0} /></SettingsProvider>);
    const seek = (t: number) => view.rerender(<SettingsProvider><Card currentTime={t} /></SettingsProvider>);
    return { onChange, seek, close: () => guard?.() };
  }

  /** Runs the count-in out and presses Space from `from` to `to` seconds. */
  function tapOnce(seek: (t: number) => void) {
    fireEvent.click(screen.getByRole('button', { name: /Tap Along/ }));
    act(() => { vi.advanceTimersByTime(3000); });
    seek(1);
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true })); });
    seek(1.5);
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true })); });
  }

  it('commits the live take instead of dropping it', () => {
    vi.useFakeTimers();
    const { onChange, seek, close } = mountTapping();
    tapOnce(seek);
    // Done says so while a take is live — it's the Save button in that moment.
    expect(screen.getByRole('button', { name: 'Save & Done' })).toBeTruthy();
    onChange.mockClear();
    act(() => { expect(close()).toBe(true); });
    const patch = onChange.mock.calls.at(-1)?.[0] as { segments?: { kind: string }[] } | undefined;
    expect(patch?.segments?.some((s) => s.kind === 'tick')).toBe(true);
  });

  it('still throws the take away on the tap session’s own Cancel', () => {
    vi.useFakeTimers();
    const { onChange, seek, close } = mountTapping();
    tapOnce(seek);
    fireEvent.click(screen.getByTitle(/^Cancel — throw these taps away/));
    onChange.mockClear();
    act(() => { expect(close()).toBe(true); });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('NodeEditPopover stem onsets', () => {
  /** A one-beat-per-second placement with a spike every second, so the window
   *  sampler picks one onset per beat. */
  function envelope(peakFrames: number[]) {
    const values = new Array(400).fill(0);
    for (const f of peakFrames) values[f] = 1;
    return { values, axis: { step: 0.01, offset: 0, count: 400 } };
  }

  function mountWithStems() {
    const onChange = vi.fn();
    function Card() {
      const ref = useRef<HTMLDivElement>(null);
      return (
        <NodeEditPopover
          node={{ ...node, segments: [{ start: 0, end: 4, kind: 'tick' }] }}
          popoverRef={ref}
          positionStyle={{ left: 0, top: 0 }}
          onChange={onChange}
          onDelete={vi.fn()}
          onClose={vi.fn()}
          registerCloseGuard={vi.fn()}
          bpm={60}
          occurrence={{ start: 0, end: 8 }}
          onsetEnvelope={envelope([100, 200])}
          onsetStems={[
            { id: 'drums', name: 'audio · drums', url: '/stems/drums/x.mp3' },
            { id: 'bass', name: 'audio · bass', url: '/stems/bass/x.mp3' },
          ]}
        />
      );
    }
    render(<SettingsProvider><Card /></SettingsProvider>);
  }

  afterEach(() => { getAudioBuffer.mockReset(); computeOnsetEnvelopeWindow.mockReset(); });

  it('fetches a stem only once it is picked, and only once per stem', async () => {
    const user = userEvent.setup();
    getAudioBuffer.mockResolvedValue({ fake: 'buffer' });
    computeOnsetEnvelopeWindow.mockReturnValue(envelope([50, 150, 250]));
    mountWithStems();

    // Listed without being read: a picker that only offers what is already
    // loaded could never be used to load anything.
    const picker = screen.getByRole('combobox', { name: /onsets/ });
    expect(getAudioBuffer).not.toHaveBeenCalled();

    await user.selectOptions(picker, 'stem:drums');
    await waitFor(() => expect(getAudioBuffer).toHaveBeenCalledWith('/stems/drums/x.mp3'));
    // Analysed over the node's real placement, not the whole song.
    expect(computeOnsetEnvelopeWindow).toHaveBeenCalledWith({ fake: 'buffer' }, 0, 8);

    await user.selectOptions(picker, 'stem:bass');
    await waitFor(() => expect(getAudioBuffer).toHaveBeenCalledTimes(2));
    // Back to the drums: decoded already, so nothing is re-fetched.
    await user.selectOptions(picker, 'stem:drums');
    await waitFor(() => expect(computeOnsetEnvelopeWindow).toHaveBeenCalledTimes(3));
    expect(getAudioBuffer).toHaveBeenCalledTimes(2);
  });

  it('reports a stem that cannot be read instead of scoring the blocks against nothing', async () => {
    const user = userEvent.setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getAudioBuffer.mockRejectedValue(new Error('404'));
    mountWithStems();

    await user.selectOptions(screen.getByRole('combobox', { name: /onsets/ }), 'stem:drums');
    await waitFor(() => expect(screen.getByText(/couldn't read audio · drums/)).toBeTruthy());
    expect(screen.queryByText(/on an onset/)).toBeNull();
  });
});
