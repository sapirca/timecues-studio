// Shared snap-to-grid logic used across all annotation types (Manual, Eye, Cue,
// Span, Loop, Pattern) so the on-canvas "snapped to grid" indicator and the
// snap behavior itself stay consistent.

/**
 * True when `t` lies on a beat-grid line within `toleranceSec`. Bar lines are
 * always beat lines (every Nth beat) so this also covers bar-snapped values.
 * Returns false when the grid is undefined or invalid.
 */
export function isOnGridLine(
  t: number,
  bpm: number | undefined,
  gridOffset: number | undefined,
  beatsPerBar: number | undefined,
  toleranceSec = 0.005,
): boolean {
  if (!bpm || bpm <= 0 || !beatsPerBar || beatsPerBar <= 0) return false;
  if (!Number.isFinite(t)) return false;
  const dBeat = 60 / bpm;
  const rel = (t - (gridOffset ?? 0)) / dBeat;
  const nearest = Math.round(rel);
  return Math.abs(rel - nearest) * dBeat < toleranceSec;
}

/** Violet hue used everywhere a "snapped to grid" indicator is drawn. Matches
 *  the BeatGrid checkbox color in VizControlBar so users associate the two. */
export const SNAP_INDICATOR_COLOR = '#818cf8';
