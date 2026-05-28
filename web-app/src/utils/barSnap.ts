/**
 * Bar-aware time snapping for Loops.
 *
 * Given a BPM and beats-per-bar, project a raw time onto the bar grid that
 * starts at `gridOffsetSec`. Used by the Loops editor to keep loop start/end
 * locked to whole bars (or N-bar phrases) — that's what makes a loop "clean"
 * for auditioning purposes.
 */

export interface BarGrid {
  /** Beats per minute. */
  bpm: number;
  /** Beats per bar (4 for most pop/edm; 3 for waltzes). */
  beatsPerBar: number;
  /** Seconds offset of the first beat (the locked grid origin). */
  gridOffsetSec?: number;
}

function barLengthSec(grid: BarGrid): number {
  return (60 / grid.bpm) * grid.beatsPerBar;
}

/** Snap `timeSec` to the nearest bar boundary on `grid`. */
export function snapToBar(timeSec: number, grid: BarGrid): number {
  const barLen = barLengthSec(grid);
  const offset = grid.gridOffsetSec ?? 0;
  const rel = (timeSec - offset) / barLen;
  return Math.round(rel) * barLen + offset;
}

/** Snap `timeSec` DOWN to the start of the bar it's in (floor). */
export function floorToBar(timeSec: number, grid: BarGrid): number {
  const barLen = barLengthSec(grid);
  const offset = grid.gridOffsetSec ?? 0;
  const rel = (timeSec - offset) / barLen;
  return Math.floor(rel) * barLen + offset;
}

/** Snap `timeSec` UP to the start of the next bar (ceil). */
export function ceilToBar(timeSec: number, grid: BarGrid): number {
  const barLen = barLengthSec(grid);
  const offset = grid.gridOffsetSec ?? 0;
  const rel = (timeSec - offset) / barLen;
  return Math.ceil(rel) * barLen + offset;
}

/** Snap `timeSec` to the nearest beat boundary. */
export function snapToBeat(timeSec: number, grid: BarGrid): number {
  const beatLen = 60 / grid.bpm;
  const offset = grid.gridOffsetSec ?? 0;
  const rel = (timeSec - offset) / beatLen;
  return Math.round(rel) * beatLen + offset;
}

/** Compute the bar-length of an interval [start, end]. Returns null when
 *  the grid is missing or the BPM is zero. */
export function intervalBars(startSec: number, endSec: number, grid: Partial<BarGrid> | null | undefined): number | null {
  if (!grid?.bpm || !grid.beatsPerBar) return null;
  const barLen = barLengthSec(grid as BarGrid);
  return (endSec - startSec) / barLen;
}
