import { describe, it, expect, vi } from 'vitest';
import { createRef } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnergySpanExportPopover } from './EnergySpanExportPopover';
import {
  buildEnergySpanLayerOptions,
  NEW_SPAN_LAYER_ID, NEW_ENERGY_SPAN_LAYER_ID, ENERGY_SPAN_LAYER_NAME,
} from './energySpanLayerOptions';

// EVERY source — the mix included — is fetched and decoded through
// getAudioBuffer, so jsdom's lack of Web Audio is stubbed at that seam and the
// tests hand back a synthetic buffer instead.
const decoded = vi.hoisted(() => ({ buffer: null as AudioBuffer | null, urls: [] as string[] }));
vi.mock('../../services/audioAnalysis', () => ({
  getAudioBuffer: vi.fn(async (url: string) => {
    decoded.urls.push(url);
    if (!decoded.buffer) throw new Error('no buffer staged for this test');
    return decoded.buffer;
  }),
}));

const SAMPLE_RATE = 44100;

/** Minimal stand-in for the AudioBuffer fields the analyzer reads — jsdom has
 *  no Web Audio. Amplitude follows `gainAt(t)` so the envelope is predictable. */
function fakeBuffer(durationSec: number, gainAt: (t: number) => number): AudioBuffer {
  const samples = new Float32Array(Math.floor(durationSec * SAMPLE_RATE));
  for (let i = 0; i < samples.length; i++) {
    const t = i / SAMPLE_RATE;
    samples[i] = gainAt(t) * Math.sin(2 * Math.PI * 220 * t);
  }
  return {
    sampleRate: SAMPLE_RATE,
    duration: durationSec,
    numberOfChannels: 1,
    getChannelData: () => samples,
  } as unknown as AudioBuffer;
}

const MIX_URL = '/audio/demo-song.mp3';

function renderPopover(
  buffer: AudioBuffer,
  onSaveToLayer = vi.fn(),
  spanLayerOptions = [{ id: 'layer-1', name: 'Spans 1', color: '#38bdf8' }],
  endSec = 2,
  initialLayerId: string | undefined = undefined,
) {
  decoded.buffer = buffer;
  decoded.urls = [];
  render(
    <EnergySpanExportPopover
      popoverRef={createRef<HTMLDivElement>()}
      positionStyle={{}}
      onClose={vi.fn()}
      songSlug="demo-song"
      startSec={0}
      endSec={endSec}
      mixAudioUrl={MIX_URL}
      stemManifest={null}
      spanLayerOptions={spanLayerOptions}
      initialLayerId={initialLayerId}
      onSaveToLayer={onSaveToLayer}
    />,
  );
  return { onSaveToLayer };
}

describe('EnergySpanExportPopover — Envelope subsection', () => {
  it('renders the A/D/S/R readout with the shape once analysis lands', async () => {
    // A 2s amplitude ramp — a swell.
    renderPopover(fakeBuffer(2, (t) => t / 2));

    await waitFor(() => expect(screen.getByText('Envelope')).toBeInTheDocument());

    for (const letter of ['A', 'D', 'S', 'R']) {
      expect(screen.getByText(letter)).toBeInTheDocument();
    }
    expect(screen.getByText('swell')).toBeInTheDocument();
    expect(screen.getByText(/sustain level .* of peak/)).toBeInTheDocument();
    expect(screen.getByText(/^peak \d/)).toBeInTheDocument();
    // Four millisecond readings, one per stage.
    expect(screen.getAllByText(/^\d+ms$/)).toHaveLength(4);
  });

  it('shows no envelope when the source audio is unavailable', async () => {
    renderPopover(null as unknown as AudioBuffer);

    await waitFor(() =>
      expect(screen.getByText(/couldn't load that source's audio/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText('Envelope')).not.toBeInTheDocument();
  });

  it('reports a held tone as sustained and hands the envelope to the save callback', async () => {
    const { onSaveToLayer } = renderPopover(fakeBuffer(2, () => 0.5));

    await waitFor(() => expect(screen.getByText('sustained')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /save to span layer/i }));

    expect(onSaveToLayer).toHaveBeenCalledTimes(1);
    const [layerId, exportData] = onSaveToLayer.mock.calls[0];
    expect(layerId).toBe('layer-1');
    expect(exportData.envelope.shape).toBe('sustained');
    expect(exportData.envelope.sustain_level).toBeGreaterThan(0.9);
    expect(exportData.description).toContain('Envelope reads sustained');
  });
});

describe('EnergySpanExportPopover — rejected envelope', () => {
  /** Two separated swells in one selection — no single ADSR describes it. */
  const twoGestures = (t: number) =>
    Math.max(Math.exp(-(((t - 1.5) / 0.7) ** 2)), Math.exp(-(((t - 6) / 0.7) ** 2)));

  it('replaces the A/D/S/R readout with the split points', async () => {
    renderPopover(fakeBuffer(8, twoGestures), vi.fn(), undefined, 8);

    await waitFor(() =>
      expect(screen.getByText(/not a single gesture/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/split the selection at/i)).toBeInTheDocument();
    // No A/D/S/R numbers are offered — that is the whole point.
    expect(screen.queryAllByText(/^\d+ms$/)).toHaveLength(0);
    expect(screen.queryByText(/sustain level/)).not.toBeInTheDocument();
  });

  it('still exports the trend, with a null envelope and the reason', async () => {
    const { onSaveToLayer } = renderPopover(fakeBuffer(8, twoGestures), vi.fn(), undefined, 8);

    await waitFor(() => expect(screen.getByText(/not a single gesture/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /save to span layer/i }));

    const [, exportData] = onSaveToLayer.mock.calls[0];
    expect(exportData.envelope).toBeNull();
    expect(exportData.envelope_rejected.reason).toBe('multiple_gestures');
    expect(exportData.envelope_rejected.gesture_count).toBe(2);
    expect(exportData.curve).toHaveLength(12);
    expect(exportData.description).toContain('No envelope reported');
  });
});

describe('EnergySpanExportPopover — save target', () => {
  // Whatever the caller puts first is what saving with no pick will hit, so
  // the picker must come up on it — see buildEnergySpanLayerOptions for who
  // earns that slot.
  it('preselects the lone energies option when the song has no span layer', async () => {
    const onSaveToLayer = vi.fn();
    renderPopover(fakeBuffer(2, () => 0.5), onSaveToLayer, [
      { id: NEW_ENERGY_SPAN_LAYER_ID, name: 'energies', color: '#38bdf8' },
    ]);

    await waitFor(() => expect(screen.getByText('sustained')).toBeInTheDocument());

    const picker = screen.getByRole('combobox', { name: /save into/i });
    expect(picker).toHaveValue(NEW_ENERGY_SPAN_LAYER_ID);
    expect(screen.getByRole('option', { name: 'energies' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /new span layer/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /save to span layer/i }));
    expect(onSaveToLayer.mock.calls[0][0]).toBe(NEW_ENERGY_SPAN_LAYER_ID);
  });

  // The regression this guards: a song with unrelated span lanes used to
  // preselect whichever lane sorted first, so a one-click save dropped the
  // energy item in among hand-drawn spans.
  it('preselects the energies lane even when the song has other span lanes', async () => {
    const onSaveToLayer = vi.fn();
    renderPopover(fakeBuffer(2, () => 0.5), onSaveToLayer, buildEnergySpanLayerOptions(
      [{ id: 'layer-1', name: 'Spans 1', color: '#34d399' }],
      '#60a5fa',
    ));

    await waitFor(() => expect(screen.getByText('sustained')).toBeInTheDocument());

    expect(screen.getByRole('combobox', { name: /save into/i })).toHaveValue(NEW_ENERGY_SPAN_LAYER_ID);
    expect(screen.getByRole('option', { name: 'Spans 1' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /save to span layer/i }));
    expect(onSaveToLayer.mock.calls[0][0]).toBe(NEW_ENERGY_SPAN_LAYER_ID);
  });

  // Opened from a lane's own "+ ADD", the lane that was pressed is the
  // destination — not whichever one the generic ordering puts first.
  it('opens on the lane the caller named', async () => {
    const onSaveToLayer = vi.fn();
    renderPopover(fakeBuffer(2, () => 0.5), onSaveToLayer, [
      { id: NEW_ENERGY_SPAN_LAYER_ID, name: ENERGY_SPAN_LAYER_NAME, color: '#38bdf8' },
      { id: 'layer-9', name: 'Spans 1', color: '#34d399' },
    ], 2, 'layer-9');

    await waitFor(() => expect(screen.getByText('sustained')).toBeInTheDocument());

    expect(screen.getByRole('combobox', { name: /save into/i })).toHaveValue('layer-9');
    await userEvent.click(screen.getByRole('button', { name: /save to span layer/i }));
    expect(onSaveToLayer.mock.calls[0][0]).toBe('layer-9');
  });

  // A stale id (the lane was deleted between the click and the render) must
  // not leave the picker on a value no option carries — saving then would
  // file the export into nothing.
  it('falls back to the first option when the named lane is gone', async () => {
    renderPopover(fakeBuffer(2, () => 0.5), vi.fn(), [
      { id: NEW_ENERGY_SPAN_LAYER_ID, name: ENERGY_SPAN_LAYER_NAME, color: '#38bdf8' },
    ], 2, 'layer-that-was-deleted');

    await waitFor(() => expect(screen.getByText('sustained')).toBeInTheDocument());

    expect(screen.getByRole('combobox', { name: /save into/i })).toHaveValue(NEW_ENERGY_SPAN_LAYER_ID);
  });
});

describe('buildEnergySpanLayerOptions', () => {
  const spans = (...names: string[]) =>
    names.map((name, i) => ({ id: `l${i}`, name, color: '#34d399' }));

  it('offers only the energies sentinel when the song has no span lane', () => {
    expect(buildEnergySpanLayerOptions([], '#60a5fa')).toEqual([
      { id: NEW_ENERGY_SPAN_LAYER_ID, name: ENERGY_SPAN_LAYER_NAME, color: '#60a5fa' },
    ]);
  });

  it('leads with the energies sentinel, then the song\'s other span lanes', () => {
    const opts = buildEnergySpanLayerOptions(spans('Spans 1', 'Tags'), '#60a5fa');
    expect(opts.map((o) => o.name)).toEqual([
      ENERGY_SPAN_LAYER_NAME, 'Spans 1', 'Tags', '+ New Span Layer',
    ]);
    expect(opts[0].id).toBe(NEW_ENERGY_SPAN_LAYER_ID);
    expect(opts[3].id).toBe(NEW_SPAN_LAYER_ID);
  });

  // Second and later exports of a song: the lane exists now, so it is the
  // real lane that leads — no second "energies" lane gets created.
  it('leads with the existing energies lane, listed once', () => {
    const opts = buildEnergySpanLayerOptions(spans('Spans 1', 'energies'), '#60a5fa');
    expect(opts.map((o) => o.name)).toEqual([
      ENERGY_SPAN_LAYER_NAME, 'Spans 1', '+ New Span Layer',
    ]);
    expect(opts[0].id).toBe('l1');
  });

  it('still offers a fresh lane when energies is the only span lane', () => {
    const opts = buildEnergySpanLayerOptions(spans('energies'), '#60a5fa');
    expect(opts.map((o) => o.id)).toEqual(['l0', NEW_SPAN_LAYER_ID]);
  });
});


// ─── The mix is decoded, never borrowed ────────────────────────────────────
// The page holds a decoded mix buffer already, and handing it over here is the
// obvious saving — it is also wrong. That buffer is `ws.getDecodedData()`, and
// WaveSurfer decodes at its default sampleRate: 8000 because it only needs
// peaks to draw with. Measuring off it throws away everything above 4kHz, so a
// riser cannot register: the same span read 780Hz -> 1.1kHz off the playback
// buffer against 2.4kHz -> 4.3kHz off the file. This test exists so the saving
// cannot be reintroduced quietly.
describe('the mix source', () => {
  it('decodes the song from its own URL rather than taking a pre-decoded buffer', async () => {
    renderPopover(fakeBuffer(2, (t) => t / 2));

    await waitFor(() => expect(screen.getByText('Envelope')).toBeInTheDocument());
    expect(decoded.urls).toEqual([MIX_URL]);
  });
});
