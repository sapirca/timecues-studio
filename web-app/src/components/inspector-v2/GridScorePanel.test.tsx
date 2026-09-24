import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GridScorePanel } from './GridScorePanel';
import type { SongInfo } from '../../types/songInfo';

const INFO: SongInfo = {
  song: 'a-song',
  bpm: 124,
  timeSignature: '4/4',
  gridOffset: 0.07,
  updated_at: '2026-09-12T00:00:00Z',
};

function reply(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    json: async () => body,
  } as unknown as Response);
}

function scored(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    slug: 'a-song',
    duration: 200,
    caveat: null,
    consensus: 0.95,
    verdict: 'confirmed',
    reason: 'the trackers agree with this grid',
    refBeats: 400,
    trackers: {
      'beat-this': {
        beat: { f_measure: 0.997, cmlt: 0.99, amlt: 0.99, n_ref: 400, n_est: 400 },
        downbeat: { f_measure: 1.0, cmlt: 1.0, amlt: 1.0, n_ref: 100, n_est: 100 },
        bpm: 124.0,
      },
      'librosa-beat-track': {
        beat: { f_measure: 0.66, cmlt: 0.64, amlt: 0.71, n_ref: 400, n_est: 390 },
        downbeat: null,
        bpm: 62.0,
      },
    },
    suggestion: { bpm: 124.0, firstDownbeat: 0.07 },
    ...over,
  };
}

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('GridScorePanel', () => {
  it('says the server is unreachable, with the command that fixes it', async () => {
    // A blank card is the one answer that explains nothing, and opening the
    // step is a deliberate request for information.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    render(<GridScorePanel songInfo={INFO} />);
    await vi.advanceTimersByTimeAsync(600);

    expect(await screen.findByText(/Can't reach the scoring server/)).toBeTruthy();
    expect(screen.getByText('python tools/python/mir_eval_server.py')).toBeTruthy();
  });

  it('passes the dev proxy\'s own hint through on a 503', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'mir-eval server is not running.', hint: './run.sh' }),
    } as unknown as Response));
    render(<GridScorePanel songInfo={INFO} />);
    await vi.advanceTimersByTimeAsync(600);

    expect(await screen.findByText(/mir-eval server is not running/)).toBeTruthy();
    expect(screen.getByText('./run.sh')).toBeTruthy();
  });

  it('shows the confirmed verdict and every tracker row', async () => {
    vi.stubGlobal('fetch', reply(scored()));
    render(<GridScorePanel songInfo={INFO} />);
    await vi.advanceTimersByTimeAsync(600);

    expect(await screen.findByText('Confirmed')).toBeTruthy();
    expect(screen.getByText('beat-this')).toBeTruthy();
    // BPM, not the beat F-measure: an F1 says "disagrees" without saying how.
    expect(screen.getByText('124.00')).toBeTruthy();
    expect(screen.queryByText('0.997')).toBeNull();
    // The F-measure is still there, moved into the cell's tooltip.
    expect(screen.getByTitle(/beat F-measure 0\.997/)).toBeTruthy();
    // A detector with no downbeats shows a dash, not a zero — reporting 0.000
    // would read as "got every downbeat wrong" rather than "doesn't do them".
    expect(screen.getByText('librosa-beat-track')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('explains a disputed grid with the consensus figure', async () => {
    vi.stubGlobal('fetch', reply(scored({
      verdict: 'disputed',
      consensus: 0.99,
      reason: 'the trackers agree with each other (0.99) far more than with this grid (0.30)',
    })));
    render(<GridScorePanel songInfo={INFO} />);
    await vi.advanceTimersByTimeAsync(600);

    expect(await screen.findByText('Disputed')).toBeTruthy();
    expect(screen.getByText(/trackers agree with each other: 0\.99/)).toBeTruthy();
  });

  it('calls a half/double-time reading what it is, not an error', async () => {
    // Low F1 with a high AMLt is the octave signature. Presenting it as a
    // failure would send a curator to "fix" a grid that is already right.
    vi.stubGlobal('fetch', reply(scored({ verdict: 'octave' })));
    render(<GridScorePanel songInfo={INFO} />);
    await vi.advanceTimersByTimeAsync(600);

    expect(await screen.findByText('Half / double time')).toBeTruthy();
    expect(screen.getByText(/Probably not an error/)).toBeTruthy();
  });

  it('surfaces a refusal instead of a score', async () => {
    vi.stubGlobal('fetch', reply({
      ok: false, slug: 'a-song',
      reason: 'Hand-placed grid — per-beat overrides are not expanded here',
    }));
    render(<GridScorePanel songInfo={INFO} />);
    await vi.advanceTimersByTimeAsync(600);

    expect(await screen.findByText(/Hand-placed grid/)).toBeTruthy();
  });

  it('offers the suggestion only when it differs from the current grid', async () => {
    // suggestion equals INFO's values → nothing to apply.
    vi.stubGlobal('fetch', reply(scored()));
    const { rerender } = render(<GridScorePanel songInfo={INFO} onApplyBpm={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(600);
    await screen.findByText('Confirmed');
    expect(screen.queryByText(/The trackers suggest/)).toBeNull();

    vi.stubGlobal('fetch', reply(scored({
      suggestion: { bpm: 129.2, firstDownbeat: 2.26 },
      verdict: 'disputed',
    })));
    rerender(<GridScorePanel songInfo={{ ...INFO, bpm: 130 }} onApplyBpm={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(600);
    expect(await screen.findByText(/The trackers suggest/)).toBeTruthy();
    expect(screen.getByText('129.20 BPM')).toBeTruthy();
  });

  it('applies the suggested tempo when the chip is clicked', async () => {
    const onApplyBpm = vi.fn();
    vi.stubGlobal('fetch', reply(scored({
      suggestion: { bpm: 129.2, firstDownbeat: null }, verdict: 'disputed',
    })));
    render(<GridScorePanel songInfo={{ ...INFO, bpm: 140 }} onApplyBpm={onApplyBpm} />);
    await vi.advanceTimersByTimeAsync(600);

    await userEvent.click(await screen.findByText('129.20 BPM'));
    expect(onApplyBpm).toHaveBeenCalledWith(129.2);
  });

  it('hides the apply chips for a locked (non-admin) viewer', async () => {
    vi.stubGlobal('fetch', reply(scored({
      suggestion: { bpm: 129.2, firstDownbeat: 2.26 }, verdict: 'disputed',
    })));
    // No onApplyBpm / onApplyOffset — the panel still shows the numbers.
    render(<GridScorePanel songInfo={{ ...INFO, bpm: 140 }} />);
    await vi.advanceTimersByTimeAsync(600);

    await screen.findByText('Disputed');
    expect(screen.queryByText('129.20 BPM')).toBeNull();
  });
});

describe('the BPM column', () => {
  it('flags a half-time reading as an octave rather than an error', async () => {
    // librosa's 62 against a grid of 124 is exactly half. Colouring that red
    // would send a curator to "fix" a grid that is already right, so it gets
    // the amber octave treatment and a ÷2 hint.
    vi.stubGlobal('fetch', reply(scored()));
    render(<GridScorePanel songInfo={INFO} />);
    await vi.advanceTimersByTimeAsync(600);

    await screen.findByText('124.00');
    expect(screen.getByText('62.00')).toBeTruthy();
    expect(screen.getByText('÷2')).toBeTruthy();
  });

  it('shows a dash when a tracker reported no usable tempo', async () => {
    vi.stubGlobal('fetch', reply(scored({
      trackers: {
        'beat-this': { beat: null, downbeat: null, bpm: null },
      },
    })));
    render(<GridScorePanel songInfo={INFO} />);
    await vi.advanceTimersByTimeAsync(600);

    await screen.findByText('beat-this');
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});
