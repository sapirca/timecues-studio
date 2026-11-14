/**
 * Turning layer-group membership into canvas rows.
 *
 * A group's member order is the annotation document's own layer order, but the
 * canvas draws from `rowOrder` — session state that knows nothing about groups
 * and interleaves the per-type blocks its six sync effects append to. Rather
 * than teach those effects about grouping, the scatter is resolved here, at
 * render time.
 *
 * Lives outside SharedVizPanel so it can be tested without mounting the panel.
 */

import type { VizRowId } from './SharedVizPanel';

/** Synthetic row id for a group's header. Never stored in `rowOrder` — it is
 *  emitted by `buildGroupedRowOrder` and consumed by the panel's row switch. */
export const GROUP_ROW_PREFIX = 'group-header:';

/** Splice each group's header into the row order and pull its member rows up
 *  behind it.
 *
 *  The first member a group has in `order` decides where its band sits; the
 *  rest follow it regardless of where they were. A collapsed group contributes
 *  its header and nothing else, which is what hides the lanes behind it.
 *  Returns the input array unchanged when no row belongs to a group, so the
 *  ungrouped case costs nothing. */
export function buildGroupedRowOrder(
  order: readonly VizRowId[],
  rowGroupId: Readonly<Record<string, string>> | undefined,
  collapsedGroupIds: ReadonlySet<string>,
): VizRowId[] {
  if (!rowGroupId) return order as VizRowId[];
  const members = new Map<string, VizRowId[]>();
  for (const rowId of order) {
    const gid = rowGroupId[rowId];
    if (!gid) continue;
    const bucket = members.get(gid);
    if (bucket) bucket.push(rowId);
    else members.set(gid, [rowId]);
  }
  if (members.size === 0) return order as VizRowId[];
  const emitted = new Set<string>();
  const out: VizRowId[] = [];
  for (const rowId of order) {
    const gid = rowGroupId[rowId];
    if (!gid) { out.push(rowId); continue; }
    if (emitted.has(gid)) continue;   // already flushed with its group
    emitted.add(gid);
    out.push(`${GROUP_ROW_PREFIX}${gid}`);
    if (!collapsedGroupIds.has(gid)) out.push(...members.get(gid)!);
  }
  return out;
}

/** Where a lane dropped on `targetRowId` ends up. */
export interface GroupDrop {
  /** The band it belongs to afterwards — the target's own band, or null when
   *  the target is outside every band. Dropping a member on an ungrouped row
   *  is how a lane leaves its band by drag: the drop position is honoured
   *  rather than silently snapped back behind the header. */
  groupId: string | null;
  /** The row to insert it above, or null for "the top of the band" — what a
   *  drop on the header itself means, since a header has no row under it to
   *  aim at. */
  beforeRowId: VizRowId | null;
  /** Which side of `beforeRowId` it lands on — 'after' for a lane dragged down
   *  onto it, so it ends up where it was let go (see `ReorderPlace`). Defaults
   *  to 'before'; ignored for a drop on the header. */
  place?: ReorderPlace;
}

/** Read a drop target as a group destination. Every row is a valid target:
 *  a header means the band it heads, any other row means whichever band that
 *  row is in (none, for most of the canvas). */
export function resolveGroupDrop(
  targetRowId: VizRowId,
  rowGroupId: Readonly<Record<string, string>> | undefined,
): GroupDrop {
  if (targetRowId.startsWith(GROUP_ROW_PREFIX)) {
    return { groupId: targetRowId.slice(GROUP_ROW_PREFIX.length), beforeRowId: null };
  }
  return { groupId: rowGroupId?.[targetRowId] ?? null, beforeRowId: targetRowId };
}

/** Move `rowId` to where `drop` puts it in the *stored* row order.
 *
 *  Membership alone doesn't decide what the canvas draws: `buildGroupedRowOrder`
 *  reads member order out of this array, so a lane joining a band has to land
 *  inside it here too. `rowGroupId` is the mapping as it stands *before* the
 *  drop — the lane hasn't joined yet when this runs.
 *
 *  Returns the input array unchanged when the move has nowhere to land. */
export function moveRowInOrder(
  order: readonly VizRowId[],
  rowId: VizRowId,
  drop: GroupDrop,
  rowGroupId: Readonly<Record<string, string>> | undefined,
): VizRowId[] {
  const from = order.indexOf(rowId);
  if (from < 0) return order as VizRowId[];
  const next = order.slice();
  next.splice(from, 1);
  let at: number;
  if (drop.beforeRowId != null) {
    at = next.indexOf(drop.beforeRowId);
    if (at >= 0 && drop.place === 'after') at += 1;
  } else {
    // Above whichever member leads the band today: that is the slot the header
    // already draws in, so joining at the top doesn't make the band jump.
    at = next.findIndex((id) => rowGroupId?.[id] === drop.groupId);
  }
  if (at < 0) return order as VizRowId[];
  next.splice(at, 0, rowId);
  return next;
}

/** Which side of the target a plain reorder lands on. A row dragged down takes
 *  the slot *below* the row it was dropped on, a row dragged up the slot above
 *  it — so the dragged row always ends up where it was let go. Inserting
 *  "before" on a downward drag parks it one row short, which for the row just
 *  below is exactly where it started. */
export type ReorderPlace = 'before' | 'after';

/** A group's members, in stored order. */
function membersOf(order: readonly VizRowId[], gid: string, rowGroupId: Readonly<Record<string, string>> | undefined): VizRowId[] {
  return order.filter((id) => rowGroupId?.[id] === gid);
}

/** Move a row — or a whole band, when `draggedId` is a band header — to
 *  `place` of `targetId`, in the *stored* row order, so that the canvas
 *  (`buildGroupedRowOrder`) draws it there.
 *
 *  A band is drawn where its first member sits, with every other member pulled
 *  up behind it, so the stored slot of a lone member says nothing about where
 *  the band shows. A row dropped on a band it isn't part of therefore moves
 *  around the band as a block: above its first member, or below its last once
 *  the members are gathered together (gathering changes nothing on screen).
 *  Inside its own band a row moves against the target alone.
 *
 *  Membership is not touched here — that is `moveRowInOrder`'s job. Returns the
 *  input unchanged when the move has nowhere to land. */
export function reorderRow(
  order: readonly VizRowId[],
  draggedId: VizRowId,
  targetId: VizRowId,
  place: ReorderPlace,
  rowGroupId: Readonly<Record<string, string>> | undefined,
): VizRowId[] {
  if (draggedId === targetId) return order as VizRowId[];
  const headerGid = (id: VizRowId) => (id.startsWith(GROUP_ROW_PREFIX) ? id.slice(GROUP_ROW_PREFIX.length) : null);
  const draggedHeader = headerGid(draggedId);
  const block = draggedHeader ? membersOf(order, draggedHeader, rowGroupId) : [draggedId];
  if (block.length === 0 || !order.includes(block[0])) return order as VizRowId[];
  const draggedGid = draggedHeader ?? rowGroupId?.[draggedId] ?? null;
  const targetGid = headerGid(targetId) ?? rowGroupId?.[targetId] ?? null;

  const moving = new Set(block);
  let next = order.filter((id) => !moving.has(id));
  let targetBlock: VizRowId[];
  if (targetGid && targetGid !== draggedGid) {
    targetBlock = membersOf(next, targetGid, rowGroupId);
    if (targetBlock.length === 0) return order as VizRowId[];
    // Gather the band behind its first member, where it is already drawn.
    const inBand = new Set(targetBlock);
    const lead = next.indexOf(targetBlock[0]);
    next = [...next.slice(0, lead).filter((id) => !inBand.has(id)), ...targetBlock, ...next.slice(lead).filter((id) => !inBand.has(id))];
  } else {
    if (moving.has(targetId) || !next.includes(targetId)) return order as VizRowId[];
    targetBlock = [targetId];
  }
  const at = place === 'before'
    ? next.indexOf(targetBlock[0])
    : next.indexOf(targetBlock[targetBlock.length - 1]) + 1;
  next.splice(at, 0, ...block);
  return next;
}
