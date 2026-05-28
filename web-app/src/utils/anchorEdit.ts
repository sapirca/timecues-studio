// Pure functions that produce new `TempoAnchor[]` arrays and per-beat
// override maps from Manual / Dynamic edits. No React, no DOM, no I/O —
// all returned arrays are normalized (sorted + deduped) so callers can
// pass them straight to the grid engine.

import {
  type TempoAnchor,
  type SongInfo,
  effectiveAnchors,
  normalizeAnchors,
} from '../types/songInfo';
import { beatTimeAt } from './beatGrid';

// ─── Manual adjustment: per-beat override map ────────────────────────────────
//
// Manual-mode beat drags write into SongInfo.beatOverrides (a sparse
// index → timestamp map) instead of inserting a tempo anchor. This keeps
// adjustments local: dragging beat n only moves beat n, leaving every
// other beat — including its neighbors inside the same segment — on the
// macro grid.
//
// Use the triangle flags above the waveform to edit macro tempo (those
// still write to tempoAnchors).

/** Minimum spacing (seconds) the dragged beat must keep from its
 *  immediate neighbours. Prevents adjacent grid lines from crossing /
 *  swapping under the cursor, which would re-key the override. */
const NEIGHBOUR_CLEARANCE_SEC = 0.005;

/** Write or update a Manual-mode beat override produced by a beat-line
 *  drag on the emerald grid strip.
 *
 *  Returns a new `Record<string, number>` (the original is never mutated).
 *  Pre-existing overrides are preserved; only the entry for `beatIndex`
 *  is set. `tNew` is clamped so it cannot cross the time of beats
 *  (beatIndex - 1) or (beatIndex + 1), taking any of *their* overrides
 *  into account.
 *
 *  The macro layer (`songInfo.tempoAnchors`) is never touched here. */
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
    // No macro tempo to derive neighbour times from — fall back to
    // writing the override raw, clamped only to t ≥ 0.
    next[String(beatIndex)] = Math.max(0, tNew);
    return next;
  }

  // Compute neighbour times via the same engine the renderer uses, so
  // any neighbouring override is respected. effectiveAnchors() returns
  // undefined when Manual mode is sitting on a Static base, matching
  // what the renderer sees.
  const offset = songInfo.gridOffset ?? 0;
  const effAnchors = effectiveAnchors(songInfo);
  const anchors = effAnchors && effAnchors.length > 0 ? effAnchors : undefined;
  const prevT = beatIndex > 0
    ? beatTimeAt(beatIndex - 1, bpm, offset, anchors, next)
    : 0;
  const nextT = beatTimeAt(beatIndex + 1, bpm, offset, anchors, next);

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

// ─── Delete ──────────────────────────────────────────────────────────────────

/** Remove the anchor at `index`. Out-of-range indices return the array
 *  unchanged. Downstream anchors retain their absolute timestamps; the
 *  newly-extended previous segment's tempo now governs the gap. */
export function deleteAnchor(
  anchors: readonly TempoAnchor[],
  index: number,
): TempoAnchor[] {
  if (index < 0 || index >= anchors.length) return [...anchors];
  return anchors.filter((_, i) => i !== index);
}

// ─── Dynamic mode: derive sparse anchors from a per-frame tempo curve ────────

export interface TempoCurve {
  /** Frame timestamps in seconds, sorted ascending. */
  frameTimes: readonly number[];
  /** Tempo (BPM) at each frame. Same length as frameTimes. */
  bpms: readonly number[];
}

export interface AnchorDerivationOptions {
  /** Emit a new anchor when the rolling-median BPM deviates by more than
   *  this many BPM from the current segment's tempo. Default 5. */
  thresholdBpm?: number;
  /** Minimum spacing between successive anchors, in seconds. Default 4. */
  minSpacingSec?: number;
  /** Number of frames used in the rolling median (odd, default 11). */
  windowFrames?: number;
}

/** Walk a per-frame tempo curve and emit a sparse set of anchors at the
 *  points where tempo drifts away from the current segment's bpm. The
 *  caller decides whether to apply the result to SongInfo. */
export function anchorsFromTempoCurve(
  curve: TempoCurve,
  options: AnchorDerivationOptions = {},
): TempoAnchor[] {
  const {
    thresholdBpm = 5,
    minSpacingSec = 4,
    windowFrames = 11,
  } = options;

  const n = curve.frameTimes.length;
  if (n === 0 || curve.bpms.length !== n) return [];

  const half = Math.max(0, Math.floor(windowFrames / 2));
  const rollingMedian = (i: number): number => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    const slice: number[] = [];
    for (let k = lo; k <= hi; k++) {
      const v = curve.bpms[k];
      if (Number.isFinite(v) && v > 0) slice.push(v);
    }
    if (slice.length === 0) return NaN;
    slice.sort((a, b) => a - b);
    const mid = Math.floor(slice.length / 2);
    return slice.length % 2 === 0
      ? (slice[mid - 1] + slice[mid]) / 2
      : slice[mid];
  };

  const out: TempoAnchor[] = [];
  let currentBpm = rollingMedian(0);
  if (!Number.isFinite(currentBpm) || currentBpm <= 0) return [];
  out.push({ timestamp: curve.frameTimes[0], bpm: currentBpm });

  for (let i = 1; i < n; i++) {
    const m = rollingMedian(i);
    if (!Number.isFinite(m) || m <= 0) continue;
    const drift = Math.abs(m - currentBpm);
    if (drift < thresholdBpm) continue;
    const t = curve.frameTimes[i];
    const lastT = out[out.length - 1].timestamp;
    if (t - lastT < minSpacingSec) continue;
    out.push({ timestamp: t, bpm: m });
    currentBpm = m;
  }

  return normalizeAnchors(out);
}
