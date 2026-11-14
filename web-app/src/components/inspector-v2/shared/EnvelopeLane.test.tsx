/**
 * An energy span shows its measured A/D/S/R where every other span offers the
 * prominence editor.
 *
 * Two surfaces, and the split between them is the point: the band draws the
 * curve in place against the audio and drops its label to make room for it,
 * while the card carries the readable copy with the numbers. Both halves are
 * pinned here because each one regressed on its own during the change — a
 * band whose label covered the curve it was drawn to show, and a card that
 * handed its readout to the lane and so had nothing in it.
 */

import { useRef } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { setCardSectionOpen, useCardSectionOpen } from './CardSection';
import { SpanEditPopover } from '../SpanEditPopover';
import { SpanLaneRow } from '../SpanLaneRow';
import { SettingsProvider } from '../../../context/SettingsContext';
import { PlayheadClockContext, createPlayheadClock } from '../../../hooks/usePlayhead';
import { EnvelopeCurve } from './EnvelopeLane';
import {
  buildEnergySpanExport,
  envelopeViewport,
  type EnergySpanExport,
  type EnergySpanResult,
} from '../../../utils/energySpan';
import type { AnnotationLayer, SpanItem } from '../../../types/annotationLayer';

afterEach(() => {
  cleanup();
  localStorage.clear();
  // The fold store is module-level — clearing localStorage isn't enough.
  setCardSectionOpen('prominence', false);
  setCardSectionOpen('envelope', true);
});

/** An export built the way the ⚡ Energy popover builds it, so the test reads
 *  the same blob the app writes rather than a hand-shaped stand-in. */
function energyExport(over: Partial<EnergySpanExport> = {}): EnergySpanExport {
  const blob = buildEnergySpanExport({
    songSlug: 'demo-song',
    stem: 'drums',
    startSec: 10,
    endSec: 14,
    result: {
      curve: [
        { t_ms: 0, energy: 0.1 },
        { t_ms: 1000, energy: 1 },
        { t_ms: 2500, energy: 0.6 },
        { t_ms: 4000, energy: 0.05 },
      ],
      startEnergy: 0.1,
      endEnergy: 0.05,
      trend: 'decreasing',
      adsr: {
        attackMs: 120,
        decayMs: 400,
        sustainMs: 1200,
        releaseMs: 900,
        sustainLevel: 0.62,
        peakAtMs: 1000,
        peakRms: 0.14,
        shape: 'sustained',
      },
      rejection: null,
      brightness: null,
    },
  });
  return { ...blob, ...over };
}

/** The same 4s window, measured as a build: the level falls off while the
 *  centroid climbs 900Hz → 4.2kHz. This is the shape the brightness curve
 *  exists for, and the only one where the two readings disagree. */
function buildExport(resultOver: Partial<EnergySpanResult> = {}): EnergySpanExport {
  return buildEnergySpanExport({
    songSlug: 'demo-song',
    stem: 'other',
    startSec: 10,
    endSec: 14,
    result: {
      curve: [
        { t_ms: 0, energy: 1, brightness: 0.4 },
        { t_ms: 1000, energy: 0.7, brightness: 0.6 },
        { t_ms: 2500, energy: 0.45, brightness: 0.8 },
        { t_ms: 4000, energy: 0.2, brightness: 1 },
      ],
      startEnergy: 1,
      endEnergy: 0.2,
      trend: 'decreasing',
      adsr: null,
      rejection: {
        reason: 'multiple_gestures', gestureCount: 2,
        peaksAtMs: [0, 2500], splitAtMs: [1200], peakLevels: [1, 0.55],
      },
      brightness: {
        trend: 'increasing',
        start: 0.4,
        end: 1,
        startHz: 900,
        endHz: 4200,
        peakHz: 4200,
      },
      ...resultOver,
    },
  });
}

function span(over: Partial<SpanItem> = {}): SpanItem {
  return {
    id: 'span-1',
    start: 10,
    end: 14,
    label: 'Energy: falling (drums)',
    description: JSON.stringify(energyExport(), null, 2),
    importance: 'critical',
    ...over,
  } as SpanItem;
}

const LAYER = { id: 'layer-1', type: 'spans', name: 'energies', color: '#38bdf8', items: [] } as unknown as AnnotationLayer<'spans'>;

function Popover({ item }: { item: SpanItem }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <SettingsProvider>
      <SpanEditPopover
        layer={LAYER}
        span={item}
        popoverRef={ref}
        positionStyle={{ left: 0, top: 0 }}
        onChange={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />
    </SettingsProvider>
  );
}

const LANE_CLOCK = createPlayheadClock(11);

/** Mirrors what InspectorPageV2 does: the lane grows its editor only while
 *  the open card's Prominence section is expanded. */
function Lane({ item }: { item: SpanItem }) {
  const editing = useCardSectionOpen('prominence', false);
  return (
    <PlayheadClockContext.Provider value={LANE_CLOCK}>
      <SpanLaneRow
        items={[item]}
        color="#38bdf8"
        duration={60}
        prominenceEditItemId={editing ? item.id : null}
        onProminenceChange={vi.fn()}
      />
    </PlayheadClockContext.Provider>
  );
}

describe('the card half — Envelope instead of Prominence', () => {
  it('offers Envelope on a span carrying an energy export', () => {
    render(<Popover item={span()} />);

    expect(screen.getByText('Envelope')).toBeInTheDocument();
    expect(screen.queryByText('Prominence')).not.toBeInTheDocument();
  });

  it('still offers Prominence on an ordinary span', () => {
    render(<Popover item={span({ description: 'guitar takes over here' })} />);

    expect(screen.getByText('Prominence')).toBeInTheDocument();
    expect(screen.queryByText('Envelope')).not.toBeInTheDocument();
  });

  it('reads the shape and the four times out of the blob while folded', () => {
    render(<Popover item={span()} />);

    // The folded summary is what makes the section worth not opening.
    expect(screen.getByText(/sustained · A 120ms D 400ms S 1\.20s R 900ms/)).toBeInTheDocument();
  });

  it('says which way the gestures travel on a span that has no envelope', () => {
    // The shape a rejection used to be silent about: three swells, each louder
    // than the last. Knowing there were three of them says nothing about
    // whether the passage is building; the peak sequence is what says it.
    const item = span({
      description: JSON.stringify(
        buildExport({
          adsr: null,
          rejection: {
            reason: 'multiple_gestures',
            gestureCount: 3,
            peaksAtMs: [1500, 3200, 6900],
            splitAtMs: [2200, 5500],
            peakLevels: [0.61, 0.78, 1],
          },
        }),
        null,
        2,
      ),
    });
    render(<Popover item={item} />);

    expect(screen.getByText('peaks rising 0.61 → 0.78 → 1.00')).toBeInTheDocument();
    // And the folded header spends its width on the direction, not on the refusal.
    expect(screen.getByText(/3 gestures · peaks rising/)).toBeInTheDocument();
  });

  it('says why there is no envelope when the span holds several gestures', () => {
    const rejected = energyExport({
      envelope: null,
      envelope_rejected: { reason: 'multiple_gestures', gesture_count: 2, peaks_at_ms: [500, 3000], split_at_ms: [1800] },
    });
    render(<Popover item={span({ description: JSON.stringify(rejected) })} />);

    expect(screen.getByText('2 gestures · no envelope')).toBeInTheDocument();
  });
});

describe('the card half — the readout itself', () => {
  it('draws the curve in the card, with no unfolding', () => {
    const { container } = render(<Popover item={span()} />);

    expect(container.querySelector('[data-annotation-popover] [data-envelope-curve]')).not.toBeNull();
  });

  it('puts the four times in the card', () => {
    render(<Popover item={span()} />);

    expect(screen.getByText('120ms')).toBeInTheDocument();   // attack
    expect(screen.getByText('400ms')).toBeInTheDocument();   // decay
    expect(screen.getByText('1.20s')).toBeInTheDocument();   // sustain
    expect(screen.getByText('900ms')).toBeInTheDocument();   // release
    expect(screen.getByText(/sustain 0\.62 of peak/)).toBeInTheDocument();
  });

  it('draws the curve for a multi-gesture span too, and says why the numbers are missing', () => {
    const rejected = energyExport({
      envelope: null,
      envelope_rejected: { reason: 'multiple_gestures', gesture_count: 2, peaks_at_ms: [500, 3000], split_at_ms: [1800] },
    });
    const { container } = render(<Popover item={span({ description: JSON.stringify(rejected) })} />);

    expect(container.querySelector('[data-envelope-curve]')).not.toBeNull();
    expect(screen.getByText(/2 separate gestures/)).toBeInTheDocument();
    expect(screen.getByText(/Split it at 11\.8s/)).toBeInTheDocument();
  });

  it('keeps the card, rather than handing the lane an editor', () => {
    const { container } = render(<Lane item={span()} />);

    act(() => setCardSectionOpen('envelope', true));

    expect(container.querySelector('[data-prominence-strip]')).toBeNull();
    expect(container.querySelector('[data-envelope-strip]')).toBeNull();
  });
});

describe('the lane half — the band', () => {
  it('draws the curve instead of the label that used to cover it', () => {
    const { container } = render(<Lane item={span()} />);

    expect(container.querySelector('[data-envelope-curve]')).not.toBeNull();
    expect(screen.queryByText('Energy: decreasing (drums)')).not.toBeInTheDocument();
    // The trend survives the label, in one character.
    expect(screen.getByText('↘')).toBeInTheDocument();
  });

  it('names the stem it was measured on, so stacked readings are told apart', () => {
    render(<Lane item={span()} />);

    expect(screen.getByText('drums')).toBeInTheDocument();
  });

  it('still labels an ordinary span', () => {
    const { container } = render(<Lane item={span({ label: 'pad swell', description: 'guitar takes over here' })} />);

    expect(screen.getByText('pad swell')).toBeInTheDocument();
    expect(container.querySelector('[data-envelope-curve]')).toBeNull();
  });

  it('still opens the prominence strip on an ordinary span', () => {
    const { container } = render(<Lane item={span({ description: 'guitar takes over here' })} />);

    act(() => setCardSectionOpen('prominence', true));

    expect(container.querySelector('[data-prominence-strip]')).not.toBeNull();
  });

  it("hovers with the blob's own summary, not the raw JSON", () => {
    render(<Lane item={span()} />);

    const band = screen.getByTitle(/Energy on the drums stem/);
    expect(band.getAttribute('title')).not.toContain('"type": "energy_span"');
    expect(band.getAttribute('title')).toContain('sustained · A 120ms');
  });
});

// ─── Dragging an edge cuts the measurement, it never re-fits it ─────────────
// The blob is measured off the audio, so its times belong to the song and not
// to the band. Re-fitting a 4s measurement into a 2s band would slide its peak
// a second away from the sound it was measured from, and the card would go on
// naming the old time for it.

/** x coordinates of the drawn contour, in the band's own 0–100 box. */
function contourXs(container: HTMLElement): number[] {
  const pts = container.querySelector('polyline')!.getAttribute('points')!;
  return pts.split(' ').map((p) => Number(p.split(',')[0]));
}

describe('a band dragged off what it measured', () => {
  it('draws the whole curve while the band still frames it', () => {
    const { container } = render(<Lane item={span()} />);

    // 4s measured across a 4s band: the peak at 1s sits a quarter in.
    expect(contourXs(container)).toEqual([0, 25, 62.5, 100]);
  });

  it('cuts the tail when the end edge comes in, leaving the rest where it was', () => {
    // 14s → 12s. The band is now half as wide, so the peak at 11s staying put
    // on the timeline means it moves to the middle of the band's own box.
    const { container } = render(<Lane item={span({ end: 12 })} />);

    const xs = contourXs(container);
    expect(xs[xs.length - 1]).toBe(100); // the cut, not the 14s sample
    expect(xs).toEqual([0, 50, 100]);    // ← a squeeze would give [0, 12.5, 31.25, 50]
  });

  it('cuts the head when the start edge comes in', () => {
    const { container } = render(<Lane item={span({ start: 12 })} />);

    // Only the 12s–14s half survives: the cut at 12s, then the 12.5s sample a
    // quarter in, then the 14s end. The peak at 11s is gone rather than slid
    // into view.
    expect(contourXs(container)).toEqual([0, 25, 100]);
  });

  it('leaves unmeasured air when the band is dragged wider', () => {
    const { container } = render(<Lane item={span({ end: 18 })} />);

    // 4s of measurement in an 8s band: it occupies its own first half.
    expect(contourXs(container)).toEqual([0, 12.5, 31.25, 50]);
  });

  it('says where the measurement went once the band is moved off it', () => {
    const { container } = render(<Lane item={span({ start: 30, end: 34 })} />);

    expect(container.querySelector('[data-envelope-curve]')).toBeNull();
    expect(screen.getByText(/measured at 10\.0s/)).toBeInTheDocument();
  });

  it('says in the tooltip how much of the measurement is left', () => {
    render(<Lane item={span({ end: 12 })} />);

    expect(screen.getByTitle(/showing 2\.0s of the 4\.0s measured at 10\.0s–14\.0s/)).toBeInTheDocument();
  });
});

describe('the card on a band that has been dragged', () => {
  it('keeps naming the times of the audio, not of the band', () => {
    const rejected = energyExport({
      envelope: null,
      envelope_rejected: { reason: 'multiple_gestures', gesture_count: 2, peaks_at_ms: [500, 3000], split_at_ms: [1800] },
    });
    // Start dragged a second in. The split is still at 11.8s in the song —
    // reading it off the band's new start would send you to 12.8s, a second
    // of music away from the trough it names.
    render(<Popover item={span({ start: 11, description: JSON.stringify(rejected) })} />);

    expect(screen.getByText(/Split it at 11\.8s/)).toBeInTheDocument();
  });

  it('flags that the numbers describe more span than the band now holds', () => {
    render(<Popover item={span({ end: 12 })} />);

    expect(screen.getByText(/band trimmed · showing 2\.0s of the 4\.0s measured/)).toBeInTheDocument();
  });

  it('says nothing about trimming while the band still matches', () => {
    render(<Popover item={span()} />);

    expect(screen.queryByText(/band trimmed/)).not.toBeInTheDocument();
  });
});


// ─── The brightness curve ──────────────────────────────────────────────────
// Brightness is a supporting reading, not the energy moving: a build can
// brighten as it climbs, but so does a hi-hat pattern. So it is off unless the
// card's toggle turns it on — on the band it is never drawn at all.

/** Points of the cyan brightness polyline, in the box's own 0–100 coordinates. */
function brightnessPoints(container: HTMLElement): string | null {
  return container.querySelector('polyline[stroke="#22d3ee"]')?.getAttribute('points') ?? null;
}

describe('a span whose timbre moved', () => {
  it('draws no brightness curve on the band', () => {
    const { container } = render(
      <Lane item={span({ description: JSON.stringify(buildExport()) })} />,
    );

    expect(brightnessPoints(container)).toBeNull();
  });

  it('shows one arrow on the band — the volume trend', () => {
    const { container } = render(
      <Lane item={span({ description: JSON.stringify(buildExport()) })} />,
    );
    expect(container.textContent).toContain('↘');
    expect(container.textContent).not.toContain('↗');
  });

  it('keeps brightness off the card until it is switched on', () => {
    const { container } = render(<Popover item={span({ description: JSON.stringify(buildExport()) })} />);

    expect(brightnessPoints(container)).toBeNull();
    expect(screen.queryByText(/brightness 900Hz → 4\.2kHz/)).not.toBeInTheDocument();
    expect(
      screen.queryByText('level falling while the timbre opens up — the shape of a build'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /\+ brightness/ }));

    expect(brightnessPoints(container)).not.toBeNull();
    expect(screen.getByText(/brightness 900Hz → 4\.2kHz/)).toBeInTheDocument();
    // Exact, so the JSON in the description textarea doesn't answer for the
    // readout — it carries the same sentence inside the blob it holds.
    expect(
      screen.getByText('level falling while the timbre opens up — the shape of a build'),
    ).toBeInTheDocument();
  });

  it('remembers the brightness switch for the next card', () => {
    const description = JSON.stringify(buildExport());
    render(<Popover item={span({ description })} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ brightness/ }));
    cleanup();

    const { container } = render(<Popover item={span({ description })} />);
    expect(brightnessPoints(container)).not.toBeNull();
  });

  it('leaves the build sentence off a span that only got quieter', () => {
    const darkening = buildExport({
      brightness: { trend: 'decreasing', start: 1, end: 0.4, startHz: 4200, endHz: 900, peakHz: 4200 },
    });
    render(<Popover item={span({ description: JSON.stringify(darkening) })} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ brightness/ }));

    expect(
      screen.queryByText('level falling while the timbre opens up — the shape of a build'),
    ).not.toBeInTheDocument();
  });

  it('cuts the brightness curve at a dragged edge without reshaping it', () => {
    // Its vertical scale comes from the whole measurement, never the visible
    // slice — so trimming a band drops points off the line instead of
    // restretching the ones that are left onto a new range.
    const data = buildExport();
    const draw = (end: number) => render(
      <div style={{ position: 'relative' }}>
        <EnvelopeCurve data={data} color="#38bdf8" showBrightness viewport={envelopeViewport(data, 10, end)!} />
      </div>,
    ).container;
    const before = brightnessPoints(draw(14))!.split(' ').map((p) => p.split(',')[1]);
    cleanup();
    const after = brightnessPoints(draw(12))!.split(' ').map((p) => p.split(',')[1]);

    // 10s–12s survives: the 0ms and 1000ms samples, at the heights they had.
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
  });
});

// ─── The Beat strength and Flux lanes on the card ────────────────────────────
// An energy shift is found on the Beat strength and Flux lanes, so the card
// draws those two, each in its lane's colour, over the grey volume contour.

function lanePoints(container: HTMLElement, stroke: string): string | null {
  return container.querySelector(`polyline[stroke="${stroke}"]`)?.getAttribute('points') ?? null;
}

describe('the Beat strength and Flux signals', () => {
  const withLanes = () => {
    const blob = buildExport();
    blob.curve = blob.curve.map((p, i) => ({ ...p, beat_strength: [0.9, 0.5, 0.3, 1][i], flux: [1, 0.4, 0.2, 0.8][i] }));
    return blob;
  };

  it('draws both on the card, amber and green, with a key', () => {
    const { container } = render(<Popover item={span({ description: JSON.stringify(withLanes()) })} />);

    expect(lanePoints(container, '#f59e0b')).not.toBeNull();
    expect(lanePoints(container, '#10b981')).not.toBeNull();
    expect(screen.getByText('beat strength')).toBeInTheDocument();
    expect(screen.getByText('flux')).toBeInTheDocument();
    expect(screen.getByText('volume')).toBeInTheDocument();
  });

  it('keeps the band to the volume contour', () => {
    const { container } = render(<Lane item={span({ description: JSON.stringify(withLanes()) })} />);

    expect(lanePoints(container, '#f59e0b')).toBeNull();
    expect(lanePoints(container, '#10b981')).toBeNull();
  });

  it('draws neither for a blob measured before they were', () => {
    const { container } = render(<Popover item={span({ description: JSON.stringify(buildExport()) })} />);

    expect(lanePoints(container, '#f59e0b')).toBeNull();
    expect(lanePoints(container, '#10b981')).toBeNull();
    expect(screen.queryByText('flux')).not.toBeInTheDocument();
  });
});

// ─── Plain volume, as a line of its own ──────────────────────────────────────
// The grey contour is volume, but it shares its grey with the A/D/S/R line and
// reads as backdrop; the card also draws it as a signal in its own colour.

describe('the volume signal', () => {
  it('draws the loudness curve as a line on the card', () => {
    const data = buildExport();
    const { container } = render(<Popover item={span({ description: JSON.stringify(data) })} />);

    const pts = lanePoints(container, '#f1f5f9')!.split(' ');
    expect(pts).toHaveLength(data.curve.length);
    // Same axis as the contour: a point at full loudness sits at the top.
    const loudest = data.curve.findIndex((p) => p.energy === Math.max(...data.curve.map((q) => q.energy)));
    expect(Number(pts[loudest].split(',')[1])).toBeCloseTo((1 - data.curve[loudest].energy) * 100, 1);
  });

  it('stays off the band, which keeps to the contour', () => {
    const { container } = render(<Lane item={span({ description: JSON.stringify(buildExport()) })} />);

    expect(lanePoints(container, '#f1f5f9')).toBeNull();
  });
});
