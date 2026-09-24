import { memo } from 'react';
import { useBarBeatOrigin } from '../context/SettingsContext';
import type { GridLine } from '../utils/beatGrid';
import {
  GRID_CAP_COLOR, GRID_CAP_HEIGHT, GRID_LABEL_COLOR, gridLineKind, gridLineStyle,
} from '../utils/gridLineStyle';

export interface GridLinesProps {
  /** Lines to draw, already computed by the caller (each surface owns its own
   *  window, anchors, overrides and segments). */
  lines: readonly GridLine[];
  /** Track duration in seconds — lines are positioned as `(t / duration)%`. */
  duration: number;
  /** User's grid-thickness multiplier. */
  thickness?: number;
  /** Label bars with their number, and cap bar/phrase lines with small ticks. */
  showBarNumbers?: boolean;
  /** Label only every Nth bar (callers cull by zoom so digits don't smear). */
  barNumberStep?: number;
}

/**
 * The DOM half of the beat grid: a set of absolutely-positioned lines meant to
 * drop into any `relative` container that projects time as `(t / duration) *
 * 100%`. Colour and width come from utils/gridLineStyle, the same source the
 * canvas surfaces stroke from, so the grid reads identically wherever it is
 * drawn. Renders no wrapper of its own — the caller owns the container, its
 * z-index and its `pointer-events: none`.
 *
 * `memo`, and it matters more than it looks: at ×32 zoom a full-track grid is
 * over a thousand lines, it is drawn once per lane row, and the rows all
 * re-render on every playhead tick because `currentTime` flows through them.
 * Without the memo every one of those divs was re-created and diffed on every
 * frame of playback, for a playhead this subtree cannot even see. Measured in
 * demo mode at ×32 (3 200 line wrappers in the viz column): 23% of all CPU and
 * 34 ms per frame in a dev build — 30 fps, which is the stutter — against
 * 13 ms with the memo; in a production build under a 4× CPU throttle,
 * 40 ms → 31 ms per frame. The default shallow compare skips the whole subtree
 * as long as callers keep `lines` referentially stable (they all build it in a
 * useMemo).
 */
export const GridLines = memo(function GridLines({
  lines, duration, thickness = 1, showBarNumbers = false, barNumberStep = 1,
}: GridLinesProps) {
  const barBeatOrigin = useBarBeatOrigin();
  if (duration <= 0) return null;

  return (
    <>
      {lines.map((line, i) => {
        const kind = gridLineKind(line);
        const { color, width, halo, haloWidth } = gridLineStyle(line, thickness);
        const capped = showBarNumbers && (kind === 'bar' || kind === 'phrase');
        const labelled = showBarNumbers && line.isBar
          && ((line.barNumber - barBeatOrigin) % barNumberStep === 0);
        return (
          <div
            key={`${line.beatIndex}-${i}`}
            className="absolute top-0 bottom-0 pointer-events-none"
            style={{ left: `${(line.t / duration) * 100}%` }}
          >
            {/* The rule itself, centred on its own timestamp so a thick grid
                grows symmetrically around the beat instead of to its right. */}
            <div
              style={{
                width,
                marginLeft: -width / 2,
                height: '100%',
                background: color,
                boxShadow: `0 0 0 ${(haloWidth - width) / 2}px ${halo}`,
              }}
            />
            {/* Tick caps mark bars and phrases at the edges without bleeding
                a bright line across the whole surface. */}
            {capped && (
              <>
                <div className="absolute top-0 left-0" style={{ width: 1, height: GRID_CAP_HEIGHT[kind as 'bar' | 'phrase'], background: GRID_CAP_COLOR[kind as 'bar' | 'phrase'] }} />
                <div className="absolute bottom-0 left-0" style={{ width: 1, height: GRID_CAP_HEIGHT[kind as 'bar' | 'phrase'], background: GRID_CAP_COLOR[kind as 'bar' | 'phrase'] }} />
              </>
            )}
            {labelled && (
              <span
                className="absolute font-mono select-none whitespace-nowrap"
                style={{
                  top: 1, left: 2,
                  fontSize: 9,
                  lineHeight: 1,
                  color: line.isPhrase ? GRID_LABEL_COLOR.phrase : GRID_LABEL_COLOR.bar,
                  textShadow: '0 0 2px rgba(0,0,0,0.9)',
                }}
              >
                {line.barNumber}
              </span>
            )}
          </div>
        );
      })}
    </>
  );
});

export default GridLines;
