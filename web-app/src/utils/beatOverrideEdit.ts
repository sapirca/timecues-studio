// Pure functions that produce per-beat override maps from Hand-placed
// edits. No React, no DOM, no I/O — the returned maps can be written
// straight onto a SongInfo.
//
// ─── Hand-placed: per-beat override map ──────────────────────────────────────
//
// Hand-placed beat drags write into SongInfo.beatOverrides (a sparse
// index → timestamp map). This keeps adjustments local: dragging beat n only
// moves beat n, leaving every other beat — including its neighbours inside the
// same segment — on the base grid.

import type { SongInfo } from '../types/songInfo';
import { beatTimeAt } from './beatGrid';
import { resolveGridSegments } from './gridSegments';

/** Minimum spacing (seconds) the dragged beat must keep from its
 *  immediate neighbours. Prevents adjacent grid lines from crossing /
 *  swapping under the cursor, which would re-key the override. */
const NEIGHBOUR_CLEARANCE_SEC = 0.005;

/** Write or update a Hand-placed beat override produced by a beat-line
 *  drag on the emerald grid strip.
 *
 *  Returns a new `Record<string, number>` (the original is never mutated).
 *  Pre-existing overrides are preserved; only the entry for `beatIndex`
 *  is set. `tNew` is clamped so it cannot cross the time of beats
 *  (beatIndex - 1) or (beatIndex + 1), taking any of *their* overrides
 *  into account.
 *
 *  The base grid is never touched here. */
export function updateManualBeatOverride(
  songInfo: SongInfo,
  tNew: number,
  beatIndex: number,
): Record<string, number> {
  if (!Number.isFinite(tNew) || !Number.isInteger(beatIndex)) {
    return { ...(songInfo.beatOverrides ?? {}) };
  }

  const next: Record<string, number> = { ...(songInfo.beatOverrides ?? {}) };
  const bpm = songInfo.bpm ?? 0;
  if (!Number.isFinite(bpm) || bpm <= 0) {
    // No base tempo to derive neighbour times from — fall back to
    // writing the override raw, clamped only to t ≥ 0.
    next[String(beatIndex)] = Math.max(0, tNew);
    return next;
  }

  // Compute neighbour times via the same engine the renderer uses, so any
  // neighbouring override — and the segment table, when Hand-placed rides a
  // Mapped base — is respected.
  const offset = songInfo.gridOffset ?? 0;
  const segments = resolveGridSegments(songInfo);
  const prevT = beatIndex > 0
    ? beatTimeAt(beatIndex - 1, bpm, offset, next, segments)
    : 0;
  const nextT = beatTimeAt(beatIndex + 1, bpm, offset, next, segments);

  const lo = prevT + NEIGHBOUR_CLEARANCE_SEC;
  const hi = nextT - NEIGHBOUR_CLEARANCE_SEC;
  const clamped = hi > lo
    ? Math.max(lo, Math.min(hi, tNew))
    : Math.max(0, tNew);

  next[String(beatIndex)] = Math.max(0, clamped);
  return next;
}

/** Remove the override for `beatIndex`, returning a new map. No-op
 *  (returns a clone) when the index isn't currently overridden. */
export function clearBeatOverride(
  overrides: Readonly<Record<string, number>> | undefined,
  beatIndex: number,
): Record<string, number> {
  const next: Record<string, number> = { ...(overrides ?? {}) };
  delete next[String(beatIndex)];
  return next;
}
