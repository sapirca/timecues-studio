import { memo } from 'react';
import { useBarBeatOrigin } from '../context/SettingsContext';
import type { GridLine } from '../utils/beatGrid';
import {
  GRID_CAP_COLOR, GRID_CAP_HEIGHT, GRID_LABEL_COLOR, gridLineKind, gridLineStyle,
} from '../utils/gridLineStyle';
import type { GridLineKind, GridLineShape } from '../utils/gridLineStyle';

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
  /** Also number every beat with its count from the start of the song — 0 at
   *  the grid anchor, then 1, 2, 3… straight through, never restarting at a
   *  bar. Drawn on a second row under the bar numbers, so the bar line shows
   *  both. Labels every `beatNumberStep`-th beat; 0 (the zoom left no room)
   *  falls back to bar numbers alone. Sub-beat lines stay unnumbered. */
  beatNumberStep?: number;
}

/** One subpath per line: a vertical rule from the top of the viewBox to the
 *  bottom, at its time in seconds. */
function rulesPath(ts: readonly number[]): string {
  let d = '';
  for (const t of ts) d += `M${t} 0V1`;
  return d;
}

/**
 * The DOM half of the beat grid, meant to drop into any `relative` container
 * that projects time as `(t / duration) * 100%`. Colour and width come from
 * utils/gridLineStyle, the same source the canvas surfaces stroke from, so the
 * grid reads identically wherever it is drawn. Renders no wrapper of its own —
 * the caller owns the container, its z-index and its `pointer-events: none`.
 *
 * Drawn as SVG, one `<path>` per line kind, not one element per line. A
 * full-track grid is ~1 800 lines on a six-minute song at 145 BPM, and it is
 * drawn once per lane row: as divs that was ~14 000 of the ~34 000 elements on
 * Algorithm Inspect, and every playback frame — WaveSurfer reads the scroll
 * position, which forces a layout — paid for all of them. Playback, seeking
 * and opening a menu all lagged with it. The viewBox is in seconds and
 * stretched to the container (`preserveAspectRatio="none"`), which is exactly
 * the percent projection; `vector-effect: non-scaling-stroke` keeps the
 * widths in CSS pixels however far that stretch goes at zoom.
 *
 * Halos are all stroked before any core, so a halo never lands on top of a
 * neighbouring line's core — the canvas half strokes line by line, which only
 * differs where two lines are within a pixel and a half of each other.
 *
 * Still `memo`: the lane rows this sits in re-render on karaoke changes and
 * edits, and callers keep `lines` referentially stable (they all build it in
 * a useMemo), so the shallow compare skips rebuilding the paths.
 */
export const GridLines = memo(function GridLines({
  lines, duration, thickness = 1, showBarNumbers = false, barNumberStep = 1,
  beatNumberStep = 0,
}: GridLinesProps) {
  const barBeatOrigin = useBarBeatOrigin();
  if (duration <= 0 || lines.length === 0) return null;

  const byKind = new Map<GridLineKind, number[]>();
  const caps: Record<'bar' | 'phrase', number[]> = { bar: [], phrase: [] };
  const labels: { line: GridLine; text: number; isBeat: boolean }[] = [];
  for (const line of lines) {
    const kind = gridLineKind(line);
    let ts = byKind.get(kind);
    if (!ts) byKind.set(kind, (ts = []));
    ts.push(line.t);
    if (!showBarNumbers) continue;
    // Tick caps mark bars and phrases at the edges without bleeding a bright
    // line across the whole surface.
    if (kind === 'bar' || kind === 'phrase') caps[kind].push(line.t);
    if (line.isBar && (beatNumberStep > 0 || (line.barNumber - barBeatOrigin) % barNumberStep === 0)) {
      labels.push({ line, text: line.barNumber, isBeat: false });
    }
    // beatIndex is the song-wide count (segments included), fractional on
    // sub-beats. Beats before the anchor (a pickup) stay unnumbered.
    const n = line.beatIndex;
    if (beatNumberStep > 0 && !line.isSubBeat && Number.isInteger(n) && n >= 0 && n % beatNumberStep === 0) {
      labels.push({ line, text: n, isBeat: true });
    }
  }
  const kinds = [...byKind];
  const viewBox = `0 0 ${duration} 1`;

  return (
    <>
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none"
        viewBox={viewBox}
        preserveAspectRatio="none"
        aria-hidden
      >
        {kinds.map(([kind, ts]) => {
          const { halo, haloWidth } = gridLineStyle(GRID_KIND_SHAPE[kind], thickness);
          return <path key={`h-${kind}`} d={rulesPath(ts)} stroke={halo} strokeWidth={haloWidth} vectorEffect="non-scaling-stroke" fill="none" />;
        })}
        {kinds.map(([kind, ts]) => {
          const { color, width } = gridLineStyle(GRID_KIND_SHAPE[kind], thickness);
          return <path key={`c-${kind}`} data-grid-kind={kind} d={rulesPath(ts)} stroke={color} strokeWidth={width} vectorEffect="non-scaling-stroke" fill="none" />;
        })}
      </svg>
      {(['bar', 'phrase'] as const).flatMap((kind) => caps[kind].length === 0 ? [] : (['top', 'bottom'] as const).map((edge) => (
        <svg
          key={`cap-${kind}-${edge}`}
          className={`absolute left-0 w-full pointer-events-none ${edge === 'top' ? 'top-0' : 'bottom-0'}`}
          style={{ height: GRID_CAP_HEIGHT[kind] }}
          viewBox={viewBox}
          preserveAspectRatio="none"
          aria-hidden
        >
          <path d={rulesPath(caps[kind])} stroke={GRID_CAP_COLOR[kind]} strokeWidth={1} vectorEffect="non-scaling-stroke" fill="none" />
        </svg>
      )))}
      {labels.map(({ line, text, isBeat }, i) => (
        <span
          key={`${line.beatIndex}-${i}`}
          className="absolute font-mono select-none whitespace-nowrap pointer-events-none"
          style={{
            top: isBeat ? 11 : 1,
            left: `calc(${(line.t / duration) * 100}% + 2px)`,
            fontSize: 9,
            lineHeight: 1,
            color: isBeat
              ? GRID_LABEL_COLOR.beat
              : (line.isPhrase ? GRID_LABEL_COLOR.phrase : GRID_LABEL_COLOR.bar),
            textShadow: '0 0 2px rgba(0,0,0,0.9)',
          }}
        >
          {text}
        </span>
      ))}
    </>
  );
});

/** A representative line of each kind, to look its style up by. */
const GRID_KIND_SHAPE: Record<GridLineKind, GridLineShape> = {
  overridden: { isBar: false, isPhrase: false, isOverridden: true },
  phrase: { isBar: true, isPhrase: true },
  bar: { isBar: true, isPhrase: false },
  subBeat: { isBar: false, isPhrase: false, isSubBeat: true },
  beat: { isBar: false, isPhrase: false },
};

export default GridLines;
