import { memo, useMemo } from 'react';
import { visibleGridLines } from '../../utils/beatGrid';
import type { ResolvedSegment } from '../../utils/gridSegments';
import { GridLines } from '../GridLines';
import { useBarBeatOrigin } from '../../context/SettingsContext';

export interface BeatGridOverlayProps {
  bpm?: number;
  gridOffset?: number;
  beatsPerBar?: number;
  /** null/undefined → dense (every beat). Else only every Nth bar. */
  barGroupSize?: number | null;
  /** Subdivide each beat (2 = 1/2 beat, 3 = triplet, 4 = 1/4 beat, 6 = 16th
   *  triplet, 8 = 1/8 beat). Ignored when barGroupSize is set. */
  subBeatDivision?: number;
  /** Compound-pulse step: only emit lines every N beats (3 for 6/8/9/8/12/8).
   *  Ignored when barGroupSize or subBeatDivision (>1) is set. */
  beatGroupSize?: number;
  /** Track duration in seconds — used to project beat times to %-of-row. */
  duration: number;
  /** Show "1, 2, 3…" bar numbers above the lines. Off by default. */
  showBarNumbers?: boolean;
  /**
   * Minimum spacing in time (seconds) between rendered lines. The component
   * doesn't know its rendered pixel width, so callers can pass this to cull
   * lines on very long tracks. Default 0 = no culling.
   */
  minSpacingSec?: number;
  /** Optional per-beat overrides (Manual mode). Sparse map keyed by
   *  global integer beat index → absolute timestamp in seconds. */
  beatOverrides?: Readonly<Record<string, number>>;
  /** Multiplier on every line's width (1 = default). Scales the bar/beat/
   *  sub-beat hierarchy uniformly so bars stay thicker than beats. */
  thickness?: number;
  /** Resolved grid segments, when the song is split into tempo regions. Each
   *  draws its own tempo, meter and bar 1 — without them a Mapped song's lanes
   *  would rule a single uniform grid while the waveforms beside them, which
   *  have always passed these through, rule the real one. */
  segments?: readonly ResolvedSegment[];
}

/**
 * The grid context a lane row is handed and passes straight through to
 * `<BeatGridOverlay>`. Spread it (`<BeatGridOverlay {...gridProps} …/>`)
 * rather than naming the fields one by one: every lane used to declare its
 * own narrower shape and forward the handful of props it happened to know
 * about, which is how the sub-beat units (1/3 beat, 1/6 beat, 1/8 beat …)
 * came to be drawn by the player and the waveforms but not by a single
 * annotation lane. One type, and a new grid field cannot go missing again.
 */
export type LaneGridProps = Pick<
  BeatGridOverlayProps,
  'bpm' | 'gridOffset' | 'beatsPerBar' | 'barGroupSize' | 'subBeatDivision'
  | 'beatGroupSize' | 'beatOverrides' | 'thickness' | 'segments'
>;

/**
 * Absolutely-positioned beat/bar grid overlay. Drop into any `relative` row
 * that uses `(t / duration) * 100%` time projection. `pointer-events: none`
 * so click-to-seek on the parent still works.
 *
 * `memo` for the same reason GridLines is: the lane rows this sits in
 * re-render on every playhead tick, and none of that reaches the grid. Every
 * prop is a primitive except `beatOverrides`, which callers take straight off
 * `songInfo` (or the memoised `gridProps` bundle), so the shallow compare
 * holds across a playing frame.
 */
export const BeatGridOverlay = memo(function BeatGridOverlay({
  bpm,
  gridOffset = 0,
  beatsPerBar = 4,
  barGroupSize = null,
  subBeatDivision = 1,
  beatGroupSize,
  duration,
  showBarNumbers = false,
  minSpacingSec = 0,
  beatOverrides,
  thickness = 1,
  segments,
}: BeatGridOverlayProps) {
  const barBeatOrigin = useBarBeatOrigin();
  const lines = useMemo(() => {
    if (!bpm || !Number.isFinite(bpm) || bpm <= 0 || duration <= 0) return [];
    const all = visibleGridLines({
      bpm,
      gridOffset,
      beatsPerBar,
      startTime: 0,
      endTime: duration,
      barGroupSize: barGroupSize ?? null,
      subBeatDivision,
      beatGroupSize,
      beatOverrides,
      barBeatOrigin,
      segments,
    });
    if (minSpacingSec <= 0) return all;
    const out: typeof all = [];
    let lastT = -Infinity;
    for (const l of all) {
      if (l.t - lastT < minSpacingSec && !l.isPhrase) continue;
      out.push(l);
      lastT = l.t;
    }
    return out;
  }, [bpm, gridOffset, beatsPerBar, barGroupSize, subBeatDivision, beatGroupSize, duration, minSpacingSec, beatOverrides, barBeatOrigin, segments]);

  if (!lines.length) return null;

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      <GridLines
        lines={lines}
        duration={duration}
        thickness={thickness}
        showBarNumbers={showBarNumbers}
      />
    </div>
  );
});
