/**
 * The drawn half of the pulse feature: the ticks a rate implies, laid over the
 * band that carries it. The picker half lives in PulseControl.
 *
 * Nothing here is stored. Every tick is derived from the song's grid on each
 * render (see utils/pulse), which is what keeps a pulse honest while its band
 * is dragged, trimmed, or sitting over a tempo segment that has since moved:
 * the marks follow the beats instead of remembering where the beats used to
 * be. It is the same reason the ticks are drawn from the same emitter the grid
 * overlay uses — a rate drawn a few milliseconds off the grid it describes
 * would be worse than not drawing it.
 *
 * Silence is drawn too, as a flatline rather than as nothing at all. An empty
 * band is what an UNANNOTATED span looks like, and the whole value of the
 * Silent answer is that it is not that: somebody listened and found nothing
 * here. A line through the band says so at a glance, needs no grid to place,
 * and cannot be mistaken for ticks however far the timeline is zoomed out.
 */

import { useMemo } from 'react';
import { PULSE_SILENT, type PulseRate } from '../../../types/annotationLayer';
import { pulseTickTimes, type PulseTickOptions } from '../../../utils/pulse';

export interface PulseTicksProps {
  rate: PulseRate | undefined;
  /** The item's bounds in track seconds — ticks are positioned as a
   *  percentage of the band, so the band itself needs no width in pixels. */
  start: number;
  end: number;
  color: string;
  /** Beat-grid context. Without a BPM nothing is drawn (see utils/pulse). */
  grid?: Pick<PulseTickOptions, 'bpm' | 'gridOffset' | 'beatsPerBar' | 'beatOverrides' | 'segments'>;
}

/** Absolutely-positioned overlay filling its parent band, like
 *  `ProminenceFill` — the parent must already be positioned with
 *  `overflow: hidden`, which every band is. Renders nothing when the item has
 *  no pulse, when there is no grid to derive one against, or when the ticks
 *  would be denser than `PULSE_MAX_TICKS` (the band's tooltip still names the
 *  rate in that case, which is the honest fallback: a thinned-out set of marks
 *  would draw a slower pulse than the annotation claims). */
export function PulseTicks({ rate, start, end, color, grid }: PulseTicksProps) {
  const span = Math.max(0, end - start);
  // Destructured so the memo keys off the grid's own values rather than the
  // identity of a `grid` object the caller rebuilds on every render.
  const { bpm, gridOffset, beatsPerBar, beatOverrides, segments } = grid ?? {};
  const ticks = useMemo(() => {
    if (!rate || span <= 0) return [];
    return pulseTickTimes({ rate, start, end, bpm, gridOffset, beatsPerBar, beatOverrides, segments });
  }, [rate, start, end, span, bpm, gridOffset, beatsPerBar, beatOverrides, segments]);

  // Before the tick list, because silence has no ticks by definition and its
  // empty list means something different from a rate's empty list.
  if (rate === PULSE_SILENT) {
    if (span <= 0) return null;
    return (
      <div
        className="absolute inset-0 pointer-events-none flex items-center"
        aria-hidden
      >
        <div
          className="w-full"
          style={{
            height: 2,
            opacity: 0.8,
            // Dashed rather than solid: a solid rule through a band reads as a
            // divider or a selection, a dashed one reads as "nothing here".
            // The gaps are dark rather than transparent so the line survives
            // both backgrounds it has to sit on — over an empty band the
            // coloured dashes carry it, and over a band already filled solid
            // in the same colour (a prominence arc, an energy curve) the dark
            // gaps do. A single-colour dash would vanish into the second one.
            backgroundImage:
              `repeating-linear-gradient(to right, ${color} 0 4px, rgba(0,0,0,0.45) 4px 8px)`,
          }}
        />
      </div>
    );
  }

  if (ticks.length === 0) return null;
  return (
    <div className="absolute inset-0 pointer-events-none">
      {ticks.map((t) => (
        <div
          key={t}
          className="absolute top-0 w-px"
          style={{
            left: `${((t - start) / span) * 100}%`,
            // Hanging from the top edge rather than spanning the band, and
            // unglowed: a fast pulse zoomed out puts more ticks in the band
            // than it has pixels, and a full-height glowing tick at that
            // density fills the band solid — which reads as a *selected*
            // band, not a busy one. Half-height marks over the band's own
            // fill stay legible as marks at any density, and resolve into
            // separate ticks as soon as the timeline is zoomed enough to
            // hold them.
            height: '55%',
            background: color,
            opacity: 0.7,
          }}
        />
      ))}
    </div>
  );
}
