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
 *   5. The annotator may SPLIT a merged section at the playhead, where no lane
 *      heard the turn they can. That boundary votes as its own lane,
 *      `HAND_LANE_ID`, so it folds and tiles exactly like a detector's.
 *
 * Smart merge (`smartMerge.ts`) is the opt-in other reading, for when the
 * union is too many lines: votes within a bar of each other become ONE
 * candidate, placed on what the music says happened there — a rhythmic
 * figure, a level step in the signals, or the bar line — rather than on any
 * one lane's guess. Its boundaries say which of those placed them (`smart`).
 * Drops, edits and hand splits work the same in both readings.
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
  /** Feeding the merge but not drawn as a lane of its own — the annotator
   *  wanted the blend, not the ingredients. */
  hidden?: boolean;
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
  /** Last raw time minus first. Never more than EDGE_EPS in the union; up
   *  to a bar in a smart merge. */
  spreadSec: number;
  /** Whether this boundary lands in the merged output — true unless the
   *  annotator dropped it by hand. */
  kept: boolean;
  /** What the annotator set on it in the boundary popover, if anything. */
  edit?: MergeBoundaryEdit;
  /** Smart merge only: what placed this boundary where it is. */
  smart?: SmartPlacement;
}

/** Why a smart-merge boundary sits where it does, strongest reason first:
 *  on a rhythmic figure, on a level step in the signals, on the nearest bar
 *  line, or — with none of those — on the middle vote. `note` says it in
 *  words ("Bass +11 dB, on the bar line"). */
export interface SmartPlacement {
  kind: 'figure' | 'signal' | 'bar' | 'vote';
  note: string;
}

/** The annotator's own edits to one merged boundary — the same fields the
 *  boundary popover edits on a layer. `at` names the boundary by the time the
 *  lanes reported, like a drop does, so the edit survives members joining and
 *  leaving; `time` is where the annotator moved it to, if they did. */
export interface MergeBoundaryEdit {
  at: number;
  time?: number;
  type?: string;
  label?: string;
  description?: string;
  importance?: SectionBlock['importance'];
  color?: string;
}

/** The pseudo-lane a boundary the annotator split in by hand votes as. */
export const HAND_LANE_ID = 'hand';

/** Whether only the annotator put this boundary here — no lane reported it,
 *  so deleting it removes it rather than leaving a dropped ghost behind. */
export function isHandOnly(b: MergedBoundary): boolean {
  return b.laneIds.length === 1 && b.laneIds[0] === HAND_LANE_ID;
}

/** Add a hand boundary at `time`. A no-op within EDGE_EPS of one already added. */
export function addMergeBoundary(added: readonly number[], time: number): number[] {
  const t = roundTime(time);
  return added.some((a) => Math.abs(a - t) < EDGE_EPS) ? [...added] : [...added, t];
}

/** Take a hand boundary back out. */
export function removeMergeBoundary(added: readonly number[], boundary: MergedBoundary): number[] {
  return added.filter((a) => Math.abs(a - boundary.time) >= EDGE_EPS);
}

/** m:ss.s — the same reading as the player's clock. The row's tooltip and the
 *  popover's header both name a boundary by it. */
export function fmtMergeTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

/** Where a merged boundary starts on the lane: moved by hand, or as reported. */
export function mergedStart(b: MergedBoundary): number {
  return b.edit?.time ?? b.time;
}

/** The kept boundaries, in the order they tile the lane. A boundary moved by
 *  hand can pass its neighbour, so this sorts by where it now starts. */
export function keptInOrder(merged: readonly MergedBoundary[]): MergedBoundary[] {
  return merged.filter((b) => b.kept).sort((a, b) => mergedStart(a) - mergedStart(b));
}

function editFor(edits: readonly MergeBoundaryEdit[], time: number): MergeBoundaryEdit | undefined {
  return edits.find((e) => Math.abs(e.at - time) < EDGE_EPS);
}

/** Patch one boundary's edit, creating it if needed. Returns the next list. */
export function patchMergeEdit(
  edits: readonly MergeBoundaryEdit[],
  boundary: MergedBoundary,
  patch: Omit<Partial<MergeBoundaryEdit>, 'at'>,
): MergeBoundaryEdit[] {
  const prev = editFor(edits, boundary.time);
  const next: MergeBoundaryEdit = { ...(prev ?? { at: boundary.time }), ...patch };
  return prev ? edits.map((e) => (e === prev ? next : e)) : [...edits, next];
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
  edits: readonly MergeBoundaryEdit[] = [],
  added: readonly number[] = [],
): MergedBoundary[] {
  if (lanes.length === 0) return [];
  // The hand lane ranks last, so a fold names the detectors first.
  const laneRank = new Map([...lanes.map((l, i) => [l.id, i] as const), [HAND_LANE_ID, lanes.length] as const]);
  const votes = [...lanes, { id: HAND_LANE_ID, times: added }]
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
  return applyMergeWork(out, dropped, edits);
}

/** Lay the annotator's own work — popover edits and drops, both keyed by the
 *  boundary's time — over a freshly built merge. One pass for both readings. */
export function applyMergeWork(
  merged: readonly MergedBoundary[],
  dropped: readonly number[],
  edits: readonly MergeBoundaryEdit[],
): MergedBoundary[] {
  return merged.map((b) => {
    const edit = editFor(edits, b.time);
    const withEdit = edit ? { ...b, edit } : b;
    return isDropped(dropped, b.time) ? { ...withEdit, kept: false } : withEdit;
  });
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
  edits: MergeBoundaryEdit[];
  /** Boundaries the annotator split in by hand. */
  added: number[];
  /** Members that feed the merge without being drawn as lanes. */
  hidden?: string[];
  /** One candidate per place (smartMerge.ts) instead of the union. */
  smart?: boolean;
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
    // Stored before edits existed → none.
    const edits = Array.isArray(parsed.edits)
      ? parsed.edits.filter((e): e is MergeBoundaryEdit => !!e && typeof e === 'object' && typeof (e as MergeBoundaryEdit).at === 'number')
      : [];
    const added = Array.isArray(parsed.added) ? parsed.added.filter((x): x is number => typeof x === 'number') : [];
    const hidden = Array.isArray(parsed.hidden) ? parsed.hidden.filter((x): x is string => typeof x === 'string') : [];
    return { memberIds, dropped, edits, added, ...(hidden.length ? { hidden } : {}), ...(parsed.smart === true ? { smart: true } : {}) };
  } catch { return null; }
}

export function writeMergeState(songId: string, state: StoredMergeState): void {
  if (typeof window === 'undefined' || !songId) return;
  try {
    // An empty merge is the default, so it is stored as nothing at all rather
    // than as an empty record — otherwise clearing a merge would leave a row
    // per song behind forever.
    if (state.memberIds.length === 0 && state.dropped.length === 0 && state.edits.length === 0 && state.added.length === 0) {
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
  return tileSectionBlocks(keptInOrder(merged).map(mergedToSection));
}

/** One merged boundary as the section it starts, carrying whatever the
 *  annotator set on it in the popover. Untouched, it is an untyped block. */
export function mergedToSection(b: MergedBoundary): SectionBlock {
  const e = b.edit;
  const block: SectionBlock = { time: mergedStart(b), type: e?.type ?? UNSET_TYPE, label: e?.label ?? '' };
  if (e?.description) block.description = e.description;
  if (e?.importance) block.importance = e.importance;
  if (e?.color) block.color = e.color;
  return block;
}

/** The same tiling, from bare boundary times — what the Consensus lane's copy
 *  hands over. Kept as one implementation because "a blend of detectors,
 *  committed into a layer the annotator owns" is one idea with two producers,
 *  and the caps / naming rules above are the whole reason it lands usefully. */
export function boundaryTimesToSectionBlocks(times: readonly number[]): SectionBlock[] {
  return tileSectionBlocks(times.map((time) => ({ time, type: UNSET_TYPE, label: '' })));
}

/** Sort, hold the head of the track with a block at 0, and name every block
 *  the annotator has not named ("Section N" — see above for why). */
function tileSectionBlocks(sections: readonly SectionBlock[]): SectionBlock[] {
  if (sections.length === 0) return [];
  const blocks = [...sections].sort((a, b) => a.time - b.time);
  if (blocks[0].time > EDGE_EPS) blocks.unshift({ time: 0, type: UNSET_TYPE, label: '' });
  else blocks[0] = { ...blocks[0], time: 0 };
  return blocks.map((b, i) => (b.label ? b : { ...b, label: `Section ${i + 1}` }));
}

/** Default name for the layer a merge commits into — the member lanes, so the
 *  layer list says what it was blended from without opening anything. */
export function mergeLayerName(lanes: readonly MergeSourceLane[]): string {
  if (lanes.length === 0) return 'Merge';
  if (lanes.length <= 3) return `Merge · ${lanes.map((l) => l.label).join(' + ')}`;
  return `Merge · ${lanes.slice(0, 2).map((l) => l.label).join(' + ')} +${lanes.length - 2}`;
}
