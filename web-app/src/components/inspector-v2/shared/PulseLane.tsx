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

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PULSE_RATE_INFO, PULSE_SILENT, type PulseRate } from '../../../types/annotationLayer';
import { pulseIntervalSec, pulseTickTimes, type PulseTickOptions } from '../../../utils/pulse';
import { usePaintClock, usePlayheadEffect } from '../../../hooks/usePlayhead';

export interface PulseTicksProps {
  rate: PulseRate | undefined;
  /** The item's bounds in track seconds — ticks are positioned as a
   *  percentage of the band, so the band itself needs no width in pixels. */
  start: number;
  end: number;
  color: string;
  /** Beat-grid context. Without a BPM nothing is drawn (see utils/pulse). */
  grid?: Pick<PulseTickOptions, 'bpm' | 'gridOffset' | 'beatsPerBar' | 'beatOverrides' | 'segments'>;
  /** The band's own label already names the rate ("Kick · Beat · 24 bars"),
   *  so when the ticks give way nothing more is drawn — a corner chip would
   *  only repeat it, over the label, on exactly the narrow bands that have
   *  no room for either. */
  labelNamesRate?: boolean;
  /** Blink the band on every tick while the playhead is in it — the lane's
   *  Visualize toggle. Off, the ticks are drawn and nothing moves. */
  blink?: boolean;
}

/** Below this many pixels between neighbouring ticks the marks stop reading
 *  as separate hits and merge into stripes that bury the band — and its label,
 *  which is what says what the pulse IS — so the ticks give way until the
 *  timeline is zoomed in far enough to space them out. 6 px was tried first:
 *  a one-bar beat band zoomed out cleared it at ~7 px and came out as a
 *  barcode with "K…" under it. */
export const PULSE_MIN_TICK_GAP_PX = 12;

/** Absolutely-positioned overlay filling its parent band, like
 *  `ProminenceFill` — the parent must already be positioned with
 *  `overflow: hidden`, which every band is. Renders nothing when the item has
 *  no pulse, when there is no grid to derive one against, or when the ticks
 *  would be denser than `PULSE_MAX_TICKS` (the band's tooltip still names the
 *  rate in that case, which is the honest fallback: a thinned-out set of marks
 *  would draw a slower pulse than the annotation claims). */
export function PulseTicks({ rate, start, end, color, grid, labelNamesRate, blink = false }: PulseTicksProps) {
  const span = Math.max(0, end - start);
  // Destructured so the memo keys off the grid's own values rather than the
  // identity of a `grid` object the caller rebuilds on every render.
  const { bpm, gridOffset, beatsPerBar, beatOverrides, segments } = grid ?? {};
  const ticks = useMemo(() => {
    if (!rate || span <= 0) return [];
    return pulseTickTimes({ rate, start, end, bpm, gridOffset, beatsPerBar, beatOverrides, segments });
  }, [rate, start, end, span, bpm, gridOffset, beatsPerBar, beatOverrides, segments]);
  // The blink needs every tick, even where there are too many to draw.
  const blinkTicks = useMemo(() => {
    if (!blink) return [];
    if (ticks.length || !rate || span <= 0) return ticks;
    return pulseTickTimes({ rate, start, end, bpm, gridOffset, beatsPerBar, beatOverrides, segments, maxTicks: 1e6 });
  }, [blink, ticks, rate, start, end, span, bpm, gridOffset, beatsPerBar, beatOverrides, segments]);
  const period = rate ? pulseIntervalSec(rate, bpm, beatsPerBar) : null;
  const flash = blinkTicks.length > 0 && period
    ? <PulseFlash ticks={blinkTicks} start={start} end={end} color={color} period={period} />
    : null;

  // The band's width in pixels — zoom changes it without changing any prop
  // this component sees, so it is observed rather than passed in. Observed on
  // one wrapper that stays mounted whether ticks or nothing are drawn inside
  // it: observing whichever element happened to render first left the
  // observer on a detached node once the view flipped, and zooming back in
  // never brought the ticks back.
  const boxRef = useRef<HTMLDivElement>(null);
  const [widthPx, setWidthPx] = useState(0);
  const measured = ticks.length > 0;
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    setWidthPx(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidthPx(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [measured]);

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

  // No ticks to draw — no tempo on the song, or more ticks than a band can
  // hold — but the span still has a rate, so name it rather than draw nothing
  // (unless the label already does).
  if (ticks.length === 0) {
    if (!rate || span <= 0) return null;
    return <>{flash}{!labelNamesRate && <PulseRateChip rate={rate} color={color} />}</>;
  }
  // Narrowest gap between neighbours, not the average: a split grid can put a
  // dense stretch inside an otherwise roomy band, and that stretch is where
  // the stripes would form.
  let minGap = Infinity;
  for (let i = 1; i < ticks.length; i++) minGap = Math.min(minGap, ticks[i] - ticks[i - 1]);
  const gapPx = ticks.length > 1 ? (minGap / span) * widthPx : Infinity;
  // Unmeasured (first paint, jsdom) counts as roomy, so the marks are the
  // default and only give way once a real width says so.
  const tooDense = widthPx > 0 && gapPx < PULSE_MIN_TICK_GAP_PX;
  return (
    <div ref={boxRef} className="absolute inset-0 pointer-events-none">
      {flash}
      {tooDense
        ? (!labelNamesRate && <PulseRateChip rate={rate!} color={color} />)
        : ticks.map((t) => (
          <div
            key={t}
            className="absolute top-0 w-px"
            style={{
              left: `${((t - start) / span) * 100}%`,
              // Hanging from the top edge rather than spanning the band, and
              // unglowed: a full-height glowing tick at any real density
              // fills the band solid — which reads as a *selected* band, not
              // a busy one. Half-height marks over the band's own fill stay
              // legible as marks.
              height: '55%',
              background: color,
              opacity: 0.7,
            }}
          />
        ))}
    </div>
  );
}

/** How long one blink takes to fade, at most, and as a share of the pulse's
 *  own period: a light still lit at the next tick never goes out, and a light
 *  that never goes out doesn't blink. */
const FLASH_FADE_S = 0.12;
const FLASH_FADE_SHARE = 0.3;
/** Peak opacity of the band's flash — bright enough to see from across the
 *  timeline, not so bright that the label under it washes out. */
const FLASH_PEAK = 0.55;

/** Lights the whole band on every tick of its pulse while the playhead is in
 *  it, and lets the light fade before the next one — the rate, blinking. Only
 *  while the lane's Visualize toggle is on (see `blink`). Set
 *  straight on the element from the playhead clock, so playback never
 *  re-renders the lane. */
function PulseFlash({ ticks, start, end, color, period }: {
  ticks: readonly number[];
  start: number;
  end: number;
  color: string;
  period: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const lit = useRef(false);
  const fade = Math.min(FLASH_FADE_S, period * FLASH_FADE_SHARE);
  // Lit on the sound — see usePaintClock.
  const paintClock = usePaintClock();
  usePlayheadEffect((t) => {
    const el = ref.current;
    if (!el) return;
    let a = 0;
    if (t >= start && t <= end + fade) {
      // Last tick at or before t.
      let lo = 0, hi = ticks.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (ticks[m] <= t) lo = m + 1; else hi = m; }
      if (lo > 0) a = Math.exp(-(t - ticks[lo - 1]) / fade);
    }
    if (a < 0.1) {
      if (lit.current) { el.style.opacity = '0'; lit.current = false; }
      return;
    }
    el.style.opacity = String(FLASH_PEAK * a);
    lit.current = true;
  }, [ticks, start, end, fade], paintClock);
  return (
    <div
      ref={ref}
      className="absolute inset-0 pointer-events-none"
      style={{ background: color, opacity: 0 }}
      data-testid="pulse-flash"
      aria-hidden
    />
  );
}

/** The rate in words, in the band's corner — for when ticks can't be drawn. */
function PulseRateChip({ rate, color }: { rate: PulseRate; color: string }) {
  return (
    <span
      className="absolute bottom-0.5 right-0.5 rounded-sm px-1 text-[9px] leading-[12px] font-medium whitespace-nowrap"
      style={{ background: 'rgba(0,0,0,0.55)', color, boxShadow: `inset 0 0 0 1px ${color}66` }}
      data-testid="pulse-rate-chip"
      aria-hidden
    >
      {PULSE_RATE_INFO[rate].badge}
    </span>
  );
}

/** Whether a band's label already names `rate` — as its own " · "-separated
 *  part, the way the detectors write it ("Kick · Beat · 24 bars", "Hat · 1/4
 *  beat"). Whole parts only, so "Beat" never matches "Upbeat". */
export function labelNamesPulseRate(label: string | undefined, rate: PulseRate | undefined): boolean {
  if (!label || !rate) return false;
  const info = PULSE_RATE_INFO[rate];
  const names = new Set([info.label, info.short, info.badge].map((n) => n.toLowerCase()));
  return label.split(' · ').some((part) => names.has(part.trim().toLowerCase()));
}
