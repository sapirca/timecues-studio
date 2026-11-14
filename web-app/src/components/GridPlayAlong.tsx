import { useMemo, useRef } from 'react';
import type { GridLine } from '../utils/beatGrid';
import { usePaintClock, usePlayheadEffect } from '../hooks/usePlayhead';

/** How bright a beat lights at its onset; a downbeat lights brighter. */
const BEAT_PEAK = 0.32;
const DOWNBEAT_PEAK = 0.55;
/** Fade time, capped at this share of the beat so each light is gone before
 *  the next one — a beat you can count, not a smear. */
const FADE_S = 0.25;
const FADE_SHARE = 0.6;

/**
 * The beat grid, played along with the playhead: the bar under it sits in a
 * soft band, and each beat cell lights on its beat and fades — the downbeat
 * brighter and in its own colour — so you can watch the grid count the bar
 * against what you hear. Drawn over the same lines GridLines draws, in the
 * same percentage space, and set straight on the elements from the playhead
 * clock, so playback never re-renders the player.
 */
export function GridPlayAlong({ lines, duration }: { lines: readonly GridLine[]; duration: number }) {
  const { beats, bars } = useMemo(() => {
    const beats = lines.filter((l) => !l.isSubBeat);
    return { beats, bars: beats.filter((l) => l.isBar) };
  }, [lines]);
  const barRef = useRef<HTMLDivElement>(null);
  const beatRef = useRef<HTMLDivElement>(null);
  // Lit on the sound — see usePaintClock.
  const paintClock = usePaintClock();

  usePlayheadEffect((t) => {
    const barEl = barRef.current;
    const beatEl = beatRef.current;
    if (!barEl || !beatEl || duration <= 0) return;
    const pct = (s: number) => `${(s / duration) * 100}%`;

    const b = lastAtOrBefore(beats, t);
    if (b < 0 || b >= beats.length - 1) {
      beatEl.style.opacity = '0';
    } else {
      const start = beats[b].t;
      const end = beats[b + 1].t;
      const fade = Math.min(FADE_S, (end - start) * FADE_SHARE);
      const a = Math.exp(-(t - start) / fade);
      beatEl.style.left = pct(start);
      beatEl.style.width = pct(end - start);
      beatEl.style.background = beats[b].isBar ? '#fbbf24' : '#ffffff';
      beatEl.style.opacity = a < 0.05 ? '0' : String((beats[b].isBar ? DOWNBEAT_PEAK : BEAT_PEAK) * a);
    }

    const k = lastAtOrBefore(bars, t);
    if (k < 0 || k >= bars.length - 1) {
      barEl.style.opacity = '0';
    } else {
      barEl.style.left = pct(bars[k].t);
      barEl.style.width = pct(bars[k + 1].t - bars[k].t);
      barEl.style.opacity = '1';
    }
  }, [beats, bars, duration], paintClock);

  return (
    <>
      <div
        ref={barRef}
        className="absolute top-0 bottom-0 pointer-events-none"
        style={{ opacity: 0, background: 'rgba(34,211,238,0.10)', boxShadow: 'inset 0 0 0 1px rgba(34,211,238,0.45)' }}
        data-testid="grid-play-along-bar"
        aria-hidden
      />
      <div
        ref={beatRef}
        className="absolute top-0 bottom-0 pointer-events-none"
        style={{ opacity: 0 }}
        data-testid="grid-play-along-beat"
        aria-hidden
      />
    </>
  );
}

/** Index of the last line at or before `t`, or −1. `lines` is time-sorted. */
function lastAtOrBefore(lines: readonly GridLine[], t: number): number {
  let lo = 0, hi = lines.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (lines[m].t <= t) lo = m + 1; else hi = m; }
  return lo - 1;
}
