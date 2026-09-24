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
  } else {
    // Above whichever member leads the band today: that is the slot the header
    // already draws in, so joining at the top doesn't make the band jump.
    at = next.findIndex((id) => rowGroupId?.[id] === drop.groupId);
  }
  if (at < 0) return order as VizRowId[];
  next.splice(at, 0, rowId);
  return next;
}
