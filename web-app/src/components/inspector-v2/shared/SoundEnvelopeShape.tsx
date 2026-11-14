/**
 * An item's measured `envelope` (Extract ADSR), drawn as a faint shape — up to
 * its peak, down to its sustain, held, released — from where the sound rises
 * to where it dies away, louder sounds taller. One drawing for every lane that
 * carries envelopes: a lyrics lane draws it behind its words across the whole
 * lane, a span draws it inside its band.
 *
 * Drawn in its own ink, never the lane's colour, and never as a closed box:
 * the item it belongs to is already a box in the lane's colour, and a second
 * one in that colour read as a second word. So the envelope is a dashed
 * contour over the sound — no stroke along the floor — with a pale fill that
 * fades out toward the bottom, a level, not an item.
 *
 * Laid out in song seconds, so the shape stays on the audio it was read from:
 * a band dragged shorter cuts it (the SVG's own window), never squeezes it.
 */
import { useId } from 'react';
import type { SoundEnvelope } from '../../../types/annotationLayer';

/** Neutral light grey: distinct from every lane colour, readable on the dark lanes. */
const ENVELOPE_INK = '#e5e7eb';

/** An envelope this many dB under the lane's loudest peak draws flat; a
 *  sustain is placed on the same scale under its own peak. */
const ENVELOPE_RANGE_DB = 30;

/** The envelope's contour in (seconds, 0 top … 1 bottom), floor to floor. */
function envelopePoints(e: SoundEnvelope, loudestDb: number): string {
  const top = Math.min(1, Math.max(0.2, 1 - (loudestDb - e.peakDb) / ENVELOPE_RANGE_DB));
  const pts: [number, number][] = [[e.start, 0], [e.peak, top]];
  if (e.sustainDb != null) {
    const sus = top * Math.max(0, 1 + e.sustainDb / ENVELOPE_RANGE_DB);
    pts.push([e.decayEnd, sus], [e.release, sus]);
  }
  pts.push([e.end, 0]);
  return pts.map(([t, v]) => `${t},${1 - v}`).join(' ');
}

export function SoundEnvelopeShape({ shapes, from, to, loudestDb }: {
  shapes: readonly { id: string; envelope: SoundEnvelope }[];
  /** The window drawn, song seconds — the lane, or one band. */
  from: number;
  to: number;
  loudestDb: number;
}) {
  const fadeId = `envelope-fade-${useId()}`;
  if (!shapes.length || !(to > from)) return null;
  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none"
      viewBox={`${from} 0 ${to - from} 1`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={fadeId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={ENVELOPE_INK} stopOpacity={0.22} />
          <stop offset="1" stopColor={ENVELOPE_INK} stopOpacity={0} />
        </linearGradient>
      </defs>
      {shapes.map(({ id, envelope }) => {
        const points = envelopePoints(envelope, loudestDb);
        return (
          <g key={id}>
            <polygon points={points} fill={`url(#${fadeId})`} stroke="none" />
            {/* Open: the floor is not part of the shape. */}
            <polyline
              points={points}
              fill="none"
              stroke={ENVELOPE_INK}
              strokeOpacity={0.75}
              strokeWidth={1}
              strokeDasharray="3 2"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          </g>
        );
      })}
    </svg>
  );
}
