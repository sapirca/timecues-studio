/**
 * The drawing half of the energy span's envelope — what an ⚡ Energy export
 * looks like on the timeline and on its card.
 *
 * An energy span is not an annotation you author: it is a *measurement*, saved
 * into the span's description by the ⚡ Energy popover (see `energySpan.ts`).
 * So where every other durational item draws a prominence arc in its band and
 * offers the four-level editor, this one draws the A/D/S/R the measurement
 * already reports, and offers nothing to edit.
 *
 *  - EnvelopeCurve — the drawing, sized to whatever box it is given. The band
 *    on the lane and the card's Envelope section are the same picture at two
 *    scales; only the labelled detail differs.
 *
 *  - EnvelopeFill  — that curve inside the 15px band, plus its trend arrows.
 *    The band deliberately drops the span's label text: "Energy: falling,
 *    brightening (mix)" is the same few dozen characters on every band, and at lane height
 *    it sits directly on top of the one thing that does differ between them.
 *    The label is still on the card, in the item list below the timeline, and
 *    in the band's own tooltip.
 *
 * Both draw two things at once: the *measured* contour as a filled area, and
 * the idealized A/D/S/R polyline over it. Neither alone is honest — the
 * polyline is the four numbers a consumer will actually branch on, and the
 * contour is what the audio did; seeing them apart is how you notice the
 * envelope reading is a poor fit for the sound.
 *
 * Over both sits the brightness line, in the Bright signal lane's own cyan —
 * an export measures spectral centroid across the same window, and the one
 * gesture this whole feature exists to capture, the build, is the one where
 * that line climbs while the contour under it sinks. Same colour as the lane
 * deliberately: it is the same measurement, and someone who just saw the rise
 * on the Bright row should recognise it here without being told.
 */

import { useMemo } from 'react';
import {
  adsrStages,
  brightnessPlotRange,
  clipCurve,
  envelopeViewport,
  fmtHz,
  peakSequenceWord,
  type AdsrStageName,
  type EnergySpanExport,
  type EnergyTrend,
  type EnvelopeViewport,
} from '../../../utils/energySpan';

const STAGE_LETTER: Record<AdsrStageName, string> = {
  attack: 'A', decay: 'D', sustain: 'S', release: 'R',
};

/** Rising / falling / flat, in the one character the band has room for once
 *  the curve has the rest of it. */
const TREND_GLYPH: Record<EnergyTrend, string> = {
  increasing: '↗', decreasing: '↘', flat: '→',
};

/** The Bright signal lane's colour (see VizControlBar), reused so the curve on
 *  a span and the row it was read off are the same thing to look at. */
export const BRIGHTNESS_COLOR = '#22d3ee';

/** Times read in ms up to a second and in seconds past it — a 42ms attack and
 *  a 3.4s release are both natural, and "3400ms" is neither. */
export function fmtEnvMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

/** One-line read of an export, for a folded card section or a band tooltip. */
export function envelopeSummary(data: EnergySpanExport): string {
  const bright = brightnessSummary(data);
  const head = data.envelope
    ? (() => {
        const e = data.envelope!;
        return `${e.shape} · A ${fmtEnvMs(e.attack_ms)} D ${fmtEnvMs(e.decay_ms)} S ${fmtEnvMs(e.sustain_ms)} R ${fmtEnvMs(e.release_ms)}`;
      })()
    : data.envelope_rejected
      // Which way the gestures are travelling, not merely that there were
      // several of them — a folded header saying only "no envelope" spent its
      // whole width on what the measurement could not do.
      ? `${data.envelope_rejected.gesture_count} gestures · ${
          peakSequenceWord(data.envelope_rejected.peak_levels)
            ? `peaks ${peakSequenceWord(data.envelope_rejected.peak_levels)}`
            : 'no envelope'
        }`
      : data.trend;
  return bright ? `${head} · ${bright}` : head;
}

/** The brightness half of a one-line read — null when nothing was measured, so
 *  callers can append it without a placeholder. Flat still gets a line here,
 *  unlike in the label: a summary is where you check, not where you scan. */
export function brightnessSummary(data: EnergySpanExport): string | null {
  if (!data.brightness_trend || !data.brightness_hz) return null;
  const { start, end } = data.brightness_hz;
  if (data.brightness_trend === 'flat') return `brightness flat near ${fmtHz(start)}`;
  const word = data.brightness_trend === 'increasing' ? 'brightening' : 'darkening';
  return `${word} ${fmtHz(start)} → ${fmtHz(end)}`;
}

interface EnvelopeCurveProps {
  data: EnergySpanExport;
  color: string;
  /** Stage letters, the sustain guide and the peak marker. Off inside a 15px
   *  band, where they'd be illegible on top of being in the way. */
  detail?: boolean;
  /** Which slice of the measurement this box shows, and where it sits in it
   *  (`envelopeViewport`). Defaults to the whole thing, filling the box.
   *  Callers that draw inside a draggable band MUST pass one: without it a
   *  trimmed band re-fits the measurement into its new width, which slides
   *  every peak off the audio it was measured from. */
  viewport?: EnvelopeViewport;
}

/**
 * The drawing itself, filling whatever box it's given. Absolutely positioned
 * children only, so the parent must be a positioned box.
 *
 * The curve is in an SVG with `preserveAspectRatio="none"` — a 0–100 box
 * stretched to the band — which is why every text label here is an HTML
 * element placed in percent instead: stretched glyphs are the usual cost of
 * that trick, and the letters A/D/S/R are the part that has to stay readable.
 */
export function EnvelopeCurve({ data, color, detail = false, viewport }: EnvelopeCurveProps) {
  const durationMs = data.duration_ms;
  // No viewport given: the box IS the measurement, which is the card's case
  // before anything has been dragged and the only case the tests of the pure
  // drawing need.
  const vp = useMemo<EnvelopeViewport>(
    () => viewport ?? { fromMs: 0, toMs: durationMs, xPct: (ms) => (ms / durationMs) * 100, exact: true },
    [viewport, durationMs],
  );
  const { fromMs, toMs, xPct } = vp;
  const visible = (ms: number) => ms >= fromMs && ms <= toMs;

  const contour = useMemo(() => {
    const pts = clipCurve(data.curve, fromMs, toMs).map((p) => {
      const x = xPct(p.t_ms);
      const y = (1 - Math.max(0, Math.min(1, p.energy))) * 100;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    if (pts.length === 0) return { line: '', area: '' };
    return {
      line: pts.join(' '),
      // Closed back along the floor, so the contour reads as a body of energy
      // rather than a wire — at 15px the outline alone is nearly invisible.
      // The floor corners sit at the cut, not at the box edge, so a trimmed
      // band ends in a wall where the audio was cut off rather than in a wedge
      // sloping down to a corner the measurement never reached.
      area: `${xPct(fromMs).toFixed(2)},100 ${pts.join(' ')} ${xPct(toMs).toFixed(2)},100`,
    };
  }, [data.curve, fromMs, toMs, xPct]);

  // Drawn on its own vertical scale (`brightnessPlotRange`) rather than in the
  // 0–1 the contour fills: centroid never approaches zero, so sharing the
  // energy axis would pin every brightness line to the top of the box and
  // flatten the gesture out of it. The range is taken from the whole curve,
  // never from the visible slice, so trimming a band cuts the line without
  // reshaping it.
  const brightness = useMemo(() => {
    const range = brightnessPlotRange(data.curve);
    const pts = clipCurve(data.curve, fromMs, toMs)
      .filter((p) => p.brightness != null)
      .map((p) => {
        const level = range
          ? (p.brightness! - range.lo) / (range.hi - range.lo)
          : 0.5; // too little travel to stretch — say so with a flat line
        const y = (1 - Math.max(0, Math.min(1, level))) * 100;
        return `${xPct(p.t_ms).toFixed(2)},${y.toFixed(2)}`;
      });
    return pts.length >= 2 ? pts.join(' ') : '';
  }, [data.curve, fromMs, toMs, xPct]);

  const stages = useMemo(
    () => (data.envelope ? adsrStages(data.envelope, durationMs, { fromMs, toMs }) : []),
    [data.envelope, durationMs, fromMs, toMs],
  );

  const adsrLine = useMemo(() => {
    if (stages.length === 0) return '';
    const pts: string[] = [];
    const at = (ms: number, level: number) =>
      `${xPct(ms).toFixed(2)},${((1 - level) * 100).toFixed(2)}`;
    // Lead-in and run-out along the floor: the idealized envelope is silent
    // before its attack and after its release, and a polyline that simply
    // began mid-span would read as "no data here" rather than "nothing yet".
    // Both run to the cut rather than to the box edge — past the cut there is
    // no measurement to be silent about.
    if (stages[0].fromMs > fromMs) pts.push(at(fromMs, stages[0].fromLevel));
    stages.forEach((s, i) => {
      if (i === 0) pts.push(at(s.fromMs, s.fromLevel));
      // A stage that starts below where the last one ended is a vertical step
      // (a 0ms decay). Emitting both points keeps it a step instead of a ramp.
      else if (s.fromLevel !== stages[i - 1].toLevel) pts.push(at(s.fromMs, s.fromLevel));
      pts.push(at(s.toMs, s.toLevel));
    });
    const last = stages[stages.length - 1];
    if (last.toMs < toMs) pts.push(at(toMs, last.toLevel));
    return pts.join(' ');
  }, [stages, xPct, fromMs, toMs]);

  const peakX = data.envelope && visible(data.envelope.peak_at_ms)
    ? xPct(data.envelope.peak_at_ms)
    : null;
  const sustainY = data.envelope ? (1 - Math.max(0, Math.min(1, data.envelope.sustain_level))) * 100 : null;

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden" data-envelope-curve>
      <svg
        className="absolute inset-0 w-full h-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {contour.area && <polygon points={contour.area} fill={`${color}3d`} />}
        {contour.line && (
          <polyline
            points={contour.line}
            fill="none"
            stroke={`${color}99`}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {detail && sustainY !== null && (
          <line
            x1={xPct(fromMs)} x2={xPct(toMs)} y1={sustainY} y2={sustainY}
            stroke={`${color}44`}
            strokeWidth={1}
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {/* Stage boundaries, so where one leg ends is a mark rather than a
          * bend you have to find. Drawn under the polyline. */}
        {detail && stages.map((s) => (
          <line
            key={`div-${s.stage}`}
            x1={xPct(s.toMs)}
            x2={xPct(s.toMs)}
            y1={0}
            y2={100}
            stroke="rgba(255,255,255,0.10)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {adsrLine && (
          <polyline
            points={adsrLine}
            fill="none"
            stroke={color}
            strokeWidth={detail ? 1.5 : 1}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {/* Last, so it reads over the fill rather than through it — the two
          * curves crossing is the thing worth seeing, and the one underneath
          * is a filled body the thin line would otherwise disappear into. */}
        {brightness && (
          <polyline
            points={brightness}
            fill="none"
            stroke={BRIGHTNESS_COLOR}
            strokeWidth={detail ? 1.25 : 1}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {/* The rejected case still gets its peaks marked: the reason there is
          * no envelope is exactly that there are several of these. */}
        {data.envelope_rejected?.peaks_at_ms.filter(visible).map((ms, i) => (
          <line
            key={`peak-${i}`}
            x1={xPct(ms)} x2={xPct(ms)} y1={0} y2={100}
            stroke={`${color}aa`}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {data.envelope_rejected?.split_at_ms.filter(visible).map((ms, i) => (
          <line
            key={`split-${i}`}
            x1={xPct(ms)} x2={xPct(ms)} y1={0} y2={100}
            stroke="rgba(255,255,255,0.35)"
            strokeWidth={1}
            strokeDasharray="2 3"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>

      {detail && peakX !== null && (
        <span
          className="absolute top-0 text-[8px] leading-none text-slate-300 select-none"
          style={{ left: `${peakX}%`, transform: 'translateX(-50%)', textShadow: '0 0 3px rgba(0,0,0,0.95)' }}
        >
          ▲
        </span>
      )}

      {detail && stages.map((s) => {
        const w = xPct(s.toMs) - xPct(s.fromMs);
        // A leg thinner than this can't hold its own letter; the boundary line
        // above still says it happened.
        if (w < 4) return null;
        return (
          <span
            key={`lbl-${s.stage}`}
            className="absolute bottom-0 text-[8px] leading-[10px] uppercase tracking-wider select-none"
            style={{
              left: `${xPct((s.fromMs + s.toMs) / 2)}%`,
              transform: 'translateX(-50%)',
              color: `${color}cc`,
              textShadow: '0 0 3px rgba(0,0,0,0.95)',
            }}
          >
            {STAGE_LETTER[s.stage]}
          </span>
        );
      })}
    </div>
  );
}

interface EnvelopeFillProps {
  data: EnergySpanExport;
  color: string;
  /** The band's CURRENT bounds in track seconds — which is not where the
   *  measurement was taken once an edge has been dragged. Passed so the curve
   *  is cut at the band's edges instead of squeezed into them. */
  start: number;
  end: number;
}

/** The band-sized read view. Mirrors ProminenceFill: absolutely positioned
 *  overlay, inert to the pointer, drawn inside the span's own band. */
export function EnvelopeFill({ data, color, start, end }: EnvelopeFillProps) {
  const viewport = envelopeViewport(data, start, end);

  // Dragged clear of the audio it was measured from — a body move, or an edge
  // pulled past the far end. There is nothing to draw at this scale, and an
  // empty band reads as a broken one, so say where the measurement went.
  if (!viewport) {
    return (
      <span
        className="absolute inset-0 flex items-center px-[3px] text-[9px] leading-none text-white/50 pointer-events-none select-none"
        style={{ textShadow: '0 0 4px rgba(0,0,0,0.95)' }}
      >
        ⚡ measured at {(data.start_ms / 1000).toFixed(1)}s
      </span>
    );
  }

  return (
    <>
      <EnvelopeCurve data={data} color={color} viewport={viewport} />
      {/* The one mark that survives the label's removal. Pinned to the left
        * edge, dim enough to read as a marker rather than as content, and
        * inert — the band underneath handles the click.
        *
        * The brightness arrow joins it only when the two trends DISAGREE. A
        * band that rises in both is just loud; a band falling in level while
        * the timbre opens is a build, and that pair of arrows is the whole
        * reading at 15px. Printing brightness always would spend the band's
        * one legible mark on the case where it adds nothing. */}
      <span
        className="absolute left-0 top-0 bottom-0 flex items-center px-[3px] text-[9px] leading-none text-white/70 pointer-events-none select-none"
        style={{ textShadow: '0 0 4px rgba(0,0,0,0.95)' }}
        aria-hidden="true"
      >
        {TREND_GLYPH[data.trend]}
        {data.brightness_trend && data.brightness_trend !== data.trend && (
          <span style={{ color: BRIGHTNESS_COLOR }}>{TREND_GLYPH[data.brightness_trend]}</span>
        )}
      </span>
    </>
  );
}
