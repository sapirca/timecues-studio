/** How point ticks that land on the same moment share the lane.
 *
 *  A drum-hits lane routinely puts a kick and a snare on one onset. Drawn in
 *  time order, whichever comes second in the list simply covers the other —
 *  the snare is there, and invisible. Two rules keep every hit in sight:
 *
 *  - **Shorter draws on top.** A tick's height is its velocity, so a tall kick
 *    behind a shorter snare still shows above it. This is global, not per
 *    stack, so near-but-not-equal hits that touch when zoomed out obey it too.
 *  - **Equal heights fan out.** Two ticks the same height at the same time
 *    would still hide each other, so they are spread a few pixels apart,
 *    centred on their shared time.
 *
 *  Shared by the cue lane and the algo point rows so both answer the same. */

export interface TickIn {
  time: number;
  /** Visible height as a percentage of the lane (100 = full height). */
  heightPct: number;
}

export interface TickPlacement {
  /** 1 (tallest) … 7 (shortest) — stays under the playhead's z-10. */
  zIndex: number;
  /** Horizontal nudge in px from the tick's time. Always 0 — kept so the
   *  renderers share one placement shape; see the module note. */
  offsetPx: number;
  /** Indices (into the input) of every tick sharing this moment, itself
   *  included, tallest first. Length 1 when it stands alone. */
  together: number[];
}

/** Hits closer than this are one moment — a detector stamps a kick and a
 *  snare struck together a few ms apart at most. */
export const SAME_MOMENT_S = 0.01;

/** A struck hit stands as tall as it was struck: velocity 127 fills the lane,
 *  a ghost note is a stub at the bottom. The 20% floor keeps the softest hit
 *  visible and clickable. No velocity → full height. */
export function tickHeightPct(velocity: number | undefined): number {
  return typeof velocity === 'number' ? Math.max(20, (velocity / 127) * 100) : 100;
}

export function stackTicks(ticks: readonly TickIn[]): TickPlacement[] {
  const out: TickPlacement[] = ticks.map((t) => ({
    zIndex: 1 + Math.round(((100 - clampPct(t.heightPct)) / 100) * 6),
    offsetPx: 0,
    together: [],
  }));
  const order = ticks.map((_, i) => i).sort((a, b) => ticks[a].time - ticks[b].time);
  let start = 0;
  while (start < order.length) {
    let end = start + 1;
    while (end < order.length && ticks[order[end]].time - ticks[order[start]].time <= SAME_MOMENT_S) end++;
    const group = order.slice(start, end)
      .sort((a, b) => ticks[b].heightPct - ticks[a].heightPct || a - b);
    for (const i of group) out[i].together = group;
    start = end;
  }
  return out;
}

function clampPct(p: number): number {
  return Math.min(100, Math.max(0, p));
}
