/**
 * Envelope readout for a `sections` slot of AnnotationPointCard — the popover
 * half of the energy span's A/D/S/R, and the block that stands in for
 * Prominence on a span that carries an ⚡ Energy export.
 *
 * The two are alternatives, never both: prominence is something you *say*
 * about an annotation (which part is in front), an envelope is something
 * measured off the audio. Offering the four level buttons on a measurement
 * invites an edit that would be overwritten by the next export, and burying
 * the measurement in the description JSON meant the one thing the span was
 * created to record was the one thing the card didn't show.
 *
 * Unlike Prominence this section does NOT hand over to the lane. Prominence
 * does that because it is an editor whose handles have to line up with the
 * audio, and because a card sitting on top of the lane it edits is in the way.
 * A measurement has nothing to grab, and the band already carries the
 * in-place, to-scale copy of this curve — so the card is where the readable
 * one belongs: always a card's width, whatever the span's duration or the
 * timeline's zoom. It opens expanded for the same reason; on an energy span
 * this *is* the card's content.
 */

import type { CardSectionSpec } from './CardSection';
import {
  envelopeCoverageNote, envelopeViewport, fmtHz, peakSequenceNote, type EnergySpanExport,
} from '../../../utils/energySpan';
import { BRIGHTNESS_COLOR, EnvelopeCurve, envelopeSummary, fmtEnvMs } from './EnvelopeLane';

export interface EnvelopeControlProps {
  data: EnergySpanExport;
  /** The span's CURRENT bounds in track seconds. Only the window: every time
   *  printed here is read off the blob's own `start_ms`, because the
   *  measurement stays with the audio when the band is dragged away from it —
   *  a split point named at the band's new start is a split point in the
   *  wrong sound. The bounds decide what is drawn and what got cut. */
  start: number;
  end: number;
  /** Layer colour, so the curve matches the band it was drawn on. */
  color: string;
}

function Stat({ label, value, title }: { label: string; value: string; title: string }) {
  return (
    <div
      className="flex-1 min-w-0 rounded border border-white/[0.06] bg-[#0a0b0d] px-1 py-0.5"
      title={title}
    >
      <span className="block text-[8px] uppercase tracking-wider text-slate-500">{label}</span>
      <span className="block truncate text-[10px] font-mono text-slate-200">{value}</span>
    </div>
  );
}

export function EnvelopeControl({ data, start, end, color }: EnvelopeControlProps) {
  const env = data.envelope;
  const rejected = data.envelope_rejected;
  // Absolute times come off the measurement's own anchor, falling back to the
  // span's start only for a blob old enough to have no `start_ms`.
  const base = Number.isFinite(data.start_ms) ? data.start_ms / 1000 : start;
  const atSec = (ms: number) => `${(base + ms / 1000).toFixed(1)}s`;
  const viewport = envelopeViewport(data, start, end);
  const coverage = envelopeCoverageNote(data, start, end);
  const sequence = peakSequenceNote(rejected?.peak_levels);

  return (
    <div>
      <span
        className="block text-[9px] text-slate-400 mb-1"
        title={
          'Both trends are the slope fitted across every frame of the span, not its first ' +
          'frame against its last — so where the band\'s edges landed cannot flip the verdict, ' +
          'and a passage of three louder-and-louder swells reads as the rise it is.'
        }
      >
        measured on the {data.stem} stem · energy {data.trend}
        {data.brightness_trend && (
          <>
            {' · '}
            <span style={{ color: BRIGHTNESS_COLOR }}>brightness {data.brightness_trend}</span>
          </>
        )}
        {' · read-only'}
      </span>

      {/* The pair, spelled out, on the one span shape where the two readings
        * contradict each other. Both trends are already on the line above, but
        * "energy decreasing" next to "brightness increasing" is a thing you
        * have to hold two facts in mind to interpret, and the interpretation is
        * always the same one — so say it. */}
      {data.trend === 'decreasing' && data.brightness_trend === 'increasing' && (
        <span className="block text-[9px] text-slate-400 mb-1">
          level falling while the timbre opens up — the shape of a build
        </span>
      )}

      {/* The numbers below describe the measurement, all of it — they were
        * read off the audio and no drag re-reads them. So when the band has
        * been trimmed past its edges, the picture and the numbers stop being
        * the same span, and the difference has to be on the card. Re-run
        * ⚡ Energy on the new bounds to measure what is there now. */}
      {coverage && (
        <span className="block text-[9px] text-amber-300/80 mb-1">
          band trimmed · {coverage} · the times below still describe the whole measurement
        </span>
      )}

      <div
        className="relative h-16 rounded-sm overflow-hidden"
        style={{ background: '#0a0b0d', boxShadow: `inset 0 0 0 1px ${color}44` }}
        title={data.description}
      >
        {viewport
          ? <EnvelopeCurve data={data} color={color} detail viewport={viewport} />
          : (
            <span className="absolute inset-0 flex items-center justify-center px-2 text-center text-[9px] text-slate-500">
              this band no longer covers the audio this was measured from
            </span>
          )}
      </div>

      {data.brightness_hz && (
        <div
          className="mt-1 flex items-center gap-1.5 text-[9px] font-mono"
          style={{ color: `${BRIGHTNESS_COLOR}cc` }}
          title="Spectral centroid — the same measurement the Bright signal lane draws, taken over this span. Peak is the brightest moment inside it."
        >
          <span
            className="inline-block w-3 border-t"
            style={{ borderColor: BRIGHTNESS_COLOR }}
            aria-hidden="true"
          />
          <span>
            brightness {fmtHz(data.brightness_hz.start)} → {fmtHz(data.brightness_hz.end)}
          </span>
          <span className="ml-auto text-slate-500">peak {fmtHz(data.brightness_hz.peak)}</span>
        </div>
      )}

      {env ? (
        <>
          <div className="mt-1 flex items-center gap-1">
            <Stat label="A" value={fmtEnvMs(env.attack_ms)} title="Attack — the 10%→90% rise into the peak" />
            <Stat label="D" value={fmtEnvMs(env.decay_ms)} title="Decay — peak down to the plateau" />
            <Stat label="S" value={fmtEnvMs(env.sustain_ms)} title="Sustain — how long the plateau holds" />
            <Stat label="R" value={fmtEnvMs(env.release_ms)} title="Release — plateau down to silence" />
          </div>
          <div className="mt-1 flex items-center gap-1 text-[9px] font-mono text-slate-400">
            <span
              className="rounded px-1 py-0.5 uppercase tracking-wider"
              style={{ color, background: `${color}1a`, boxShadow: `inset 0 0 0 1px ${color}33` }}
              title="Coarse read of the A/D/S/R proportions"
            >
              {env.shape}
            </span>
            <span title="Plateau level, relative to this span's own peak">
              sustain {env.sustain_level.toFixed(2)} of peak
            </span>
            <span className="ml-auto" title={`Peak RMS ${env.peak_rms.toFixed(3)} — un-normalized, so levels compare across spans`}>
              peak {atSec(env.peak_at_ms)}
            </span>
          </div>
        </>
      ) : (
        <>
          {/* The direction across the gestures, first and on its own line —
            * on most spans it is the reading the measurement was taken for,
            * and it used to be the one thing a rejection didn't say. Absent
            * on a blob written before peak levels were measured. */}
          {sequence && (
            <p
              className="mt-1 text-[10px] font-mono leading-relaxed text-slate-300"
              title="Each gesture's peak, relative to the loudest in this span. Which way they travel is the build, or the fade."
            >
              {sequence}
            </p>
          )}
          <p className="mt-1 text-[10px] leading-relaxed text-amber-300/90">
            {rejected
              ? `No envelope: this span holds ${rejected.gesture_count} separate gestures (peaks at ${rejected.peaks_at_ms.map(atSec).join(', ')}), and A/D/S/R describes one. Split it at ${rejected.split_at_ms.map(atSec).join(', ')} to read each gesture on its own.`
              : 'This export carries no envelope.'}
          </p>
        </>
      )}
    </div>
  );
}

/** The card section an energy span mounts in place of Prominence. Open by
 *  default — it is the whole point of this span, and a measurement you have to
 *  unfold to see is the state this feature replaced. The header still carries
 *  the shape and the four times, for when it has been folded away. */
export function envelopeSection(props: EnvelopeControlProps): CardSectionSpec {
  return {
    id: 'envelope',
    title: 'Envelope',
    defaultOpen: true,
    summary: envelopeSummary(props.data),
    content: <EnvelopeControl {...props} />,
  };
}
