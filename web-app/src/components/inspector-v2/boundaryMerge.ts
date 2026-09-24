/**
 * Blending several boundary algo lanes into one reading of the structure.
 *
 * No single change-point method gets a whole song right: Dynp·ar hears the
 * drop, Window·rbf hears the breakdown, BinSeg·l2 hears the turnaround nobody
 * else does. The annotator can see that on the canvas — three lanes, each
 * correct in a different stretch — and what they want is the union of what
 * each one got right, not another algorithm.
 *
 * So a merge is a UNION, and only a union:
 *
 *   1. Every boundary from every member lane lands in the merge. There is no
 *      threshold, no window to tune, no vote to lose — that is what the
 *      Consensus lane is for, and a merge is deliberately the other thing.
 *   2. The only folding is of boundaries that name the same instant: two lanes
 *      saying 30.00s and 30.02s are one boundary, because `EDGE_EPS` (50ms) is
 *      already this app's rule for "the same boundary" everywhere else — see
 *      `boundaryInsert`, where an insert that close to an existing boundary is
 *      a no-op. A fold keeps the EARLIEST vote, never a synthetic average:
 *      every time in the merge is a time some detector actually reported.
 *   3. A folded boundary remembers which lanes voted in it (`agreement`), so
 *      the lane can say "these two heard this together" — information, not a
 *      filter.
 *   4. The annotator may DROP individual boundaries they can hear are wrong.
 *      Nothing is ever dropped for them.
 *
 * This is deliberately NOT a custom detector: it exists for the song on
 * screen, and its output is committed into an ordinary editable boundary
 * layer. Nothing here is cached, exported, or run over the corpus — but the
 * working state (members + hand drops) IS remembered per song in
 * localStorage, so a reload does not throw away a blend you were reading.
 */

import type { SectionBlock } from '../../types/sectionBlock';
import { UNSET_TYPE } from './sectionConstants';
import { EDGE_EPS, roundTime } from './boundaryInsert';

/** One algo lane offered to the merge — its boundary start times, plus the
 *  identity the merged lane shows back in its member chips. */
export interface MergeSourceLane {
  id: string;
  label: string;
  color: string;
  times: number[];
}

export interface MergedBoundary {
  /** The instant, as some member lane actually reported it. */
  time: number;
  /** Distinct member lanes that named this same instant. Usually 1 — a union
   *  does not need agreement — but ×2 is worth seeing when it happens. */
  agreement: number;
  /** Their ids, in the member order the caller passed. */
  laneIds: string[];
  /** Raw per-vote times, ascending — what the lanes actually said. */
  rawTimes: number[];
  /** Last raw time minus first. Never more than EDGE_EPS. */
  spreadSec: number;
  /** Whether this boundary lands in the merged output — true unless the
   *  annotator dropped it by hand. */
  kept: boolean;
}

/** Whether a stored drop claims this boundary. Dropped times are recorded
 *  rather than indexes because the merge list is rebuilt from scratch whenever
 *  a lane joins or leaves: an index would re-point at a different boundary the
 *  moment the membership moves, where a time still names the same instant. */
function isDropped(dropped: readonly number[], time: number): boolean {
  return dropped.some((t) => Math.abs(t - time) < EDGE_EPS);
}

/**
 * Merge the member lanes. Returns EVERY boundary any member proposed, in
 * ascending time, each `kept` unless the annotator dropped it. Callers that
 * want only the output read `.filter((b) => b.kept)`.
 */
export function mergeBoundaryLanes(
  lanes: readonly MergeSourceLane[],
  dropped: readonly number[] = [],
): MergedBoundary[] {
  if (lanes.length === 0) return [];
  const laneRank = new Map(lanes.map((l, i) => [l.id, i]));
  const votes = lanes
    .flatMap((lane) => lane.times.map((time) => ({ laneId: lane.id, time: roundTime(time) })))
    .sort((a, b) => a.time - b.time);
  if (votes.length === 0) return [];

  const out: MergedBoundary[] = [];
  for (const v of votes) {
    const prev = out[out.length - 1];
    // Same instant as the boundary before it? Fold in, keeping that boundary's
    // (earlier) time — the same "already have one here" rule boundaryInsert
    // applies when the annotator clicks.
    if (prev && v.time - prev.time < EDGE_EPS) {
      const laneIds = prev.laneIds.includes(v.laneId)
        ? prev.laneIds
        : [...prev.laneIds, v.laneId].sort((a, b) => (laneRank.get(a) ?? 0) - (laneRank.get(b) ?? 0));
      const rawTimes = [...prev.rawTimes, v.time];
      out[out.length - 1] = {
        ...prev,
        laneIds,
        agreement: laneIds.length,
        rawTimes,
        spreadSec: rawTimes[rawTimes.length - 1] - rawTimes[0],
      };
      continue;
    }
    out.push({
      time: v.time,
      agreement: 1,
      laneIds: [v.laneId],
      rawTimes: [v.time],
      spreadSec: 0,
      kept: true,
    });
  }
  return out.map((b) => (isDropped(dropped, b.time) ? { ...b, kept: false } : b));
}

/** Drop a kept boundary, or restore a dropped one. Returns the next list. */
export function toggleMergeDropped(
  dropped: readonly number[],
  boundary: MergedBoundary,
): number[] {
  if (!boundary.kept) return dropped.filter((t) => Math.abs(t - boundary.time) >= EDGE_EPS);
  return [...dropped, boundary.time];
}

// ── Remembering the blend ──────────────────────────────────────────────────
// A merge is a per-song reading, so it is stored per song — switching away and
// back, or reloading the tab, finds the same lanes blended and the same
// boundaries dropped. It is a working view rather than an annotation, so it
// lives in localStorage next to the other viz preferences, not in the
// document; committing is still what makes a merge durable and shareable.

export interface StoredMergeState {
  memberIds: string[];
  dropped: number[];
}

const MERGE_STORAGE_PREFIX = 'tc.merge.';

export function readMergeState(songId: string): StoredMergeState | null {
  if (typeof window === 'undefined' || !songId) return null;
  try {
    const raw = window.localStorage.getItem(MERGE_STORAGE_PREFIX + songId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredMergeState>;
    const memberIds = Array.isArray(parsed.memberIds) ? parsed.memberIds.filter((x): x is string => typeof x === 'string') : [];
    const dropped = Array.isArray(parsed.dropped) ? parsed.dropped.filter((x): x is number => typeof x === 'number') : [];
    return { memberIds, dropped };
  } catch { return null; }
}

export function writeMergeState(songId: string, state: StoredMergeState): void {
  if (typeof window === 'undefined' || !songId) return;
  try {
    // An empty merge is the default, so it is stored as nothing at all rather
    // than as an empty record — otherwise clearing a merge would leave a row
    // per song behind forever.
    if (state.memberIds.length === 0 && state.dropped.length === 0) {
      window.localStorage.removeItem(MERGE_STORAGE_PREFIX + songId);
      return;
    }
    window.localStorage.setItem(MERGE_STORAGE_PREFIX + songId, JSON.stringify(state));
  } catch { /* quota / private mode — the merge is still on screen */ }
}

/**
 * The kept boundaries as a section tiling, ready for the page's ordinary
 * copy-to-a-new-boundary-layer path.
 *
 * Boundaries tile — a block is a section START that runs until the next one —
 * so a merged set whose first boundary is not at 0 would leave the head of the
 * track unannotated. A block is laid at 0 to hold that opening stretch
 * explicitly. Every block is `unset`: the merge knows WHERE the structure
 * turns, never what the section is called — that is the annotator's next pass,
 * in the boundary editor, on a layer they own.
 *
 * Each block is still NAMED, "Section 1", "Section 2"… That is not decoration:
 * an `unset` block carrying the default '—' label is a filler CAP, and caps are
 * deliberately invisible — drawn transparent on the lane and hidden from the
 * section-card list (see `isOrphanedSection`). A merge commits a complete
 * tiling of untyped-but-real sections, so unlabelled ones would land in the
 * document and then draw nothing anywhere the annotator could retype them.
 * A written label is exactly the app's existing marker for "a real section
 * whose type I cannot name".
 */
export function mergedToSectionBlocks(merged: readonly MergedBoundary[]): SectionBlock[] {
  return boundaryTimesToSectionBlocks(merged.filter((b) => b.kept).map((b) => b.time));
}

/** The same tiling, from bare boundary times — what the Consensus lane's copy
 *  hands over. Kept as one implementation because "a blend of detectors,
 *  committed into a layer the annotator owns" is one idea with two producers,
 *  and the caps / naming rules above are the whole reason it lands usefully. */
export function boundaryTimesToSectionBlocks(times: readonly number[]): SectionBlock[] {
  if (times.length === 0) return [];
  const sorted = [...times].sort((a, b) => a - b);
  const blocks: SectionBlock[] = sorted.map((time) => ({ time, type: UNSET_TYPE, label: '' }));
  if (blocks[0].time > EDGE_EPS) blocks.unshift({ time: 0, type: UNSET_TYPE, label: '' });
  else blocks[0] = { ...blocks[0], time: 0 };
  return blocks.map((b, i) => ({ ...b, label: `Section ${i + 1}` }));
}

/** Default name for the layer a merge commits into — the member lanes, so the
 *  layer list says what it was blended from without opening anything. */
export function mergeLayerName(lanes: readonly MergeSourceLane[]): string {
  if (lanes.length === 0) return 'Merge';
  if (lanes.length <= 3) return `Merge · ${lanes.map((l) => l.label).join(' + ')}`;
  return `Merge · ${lanes.slice(0, 2).map((l) => l.label).join(' + ')} +${lanes.length - 2}`;
}
