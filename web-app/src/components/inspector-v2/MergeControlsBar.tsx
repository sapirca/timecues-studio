/**
 * The control strip under the Merge lane — who is in the blend, and what to do
 * with it.
 *
 * There is no reconciliation rule to set, because a merge has none: every
 * boundary every member lane found is in. The only knob that ever belonged
 * here was membership, so that is all this strip holds — the member chips, the
 * tally, and Commit. Thresholds and windows are the Consensus stage's business.
 *
 * It lives in the content column, under the lane it drives, rather than in a
 * popover: adding or removing a lane changes what the lane above is drawing,
 * and the point of the feature is to watch that happen.
 */

import type { MergeSourceLane } from './boundaryMerge';

export function MergeControlsBar({
  lanes,
  onRemoveLane,
  onClear,
  onCommit,
  onRestoreDropped,
  keptCount,
  totalCount,
  droppedCount,
  committedCount,
  committedNote = null,
}: {
  /** Member lanes, in the order they were added. */
  lanes: MergeSourceLane[];
  onRemoveLane: (id: string) => void;
  onClear: () => void;
  /** Write the kept boundaries into a new editable boundary layer. */
  onCommit: () => void;
  /** Put every by-hand drop back, so the merge is the whole union again. */
  onRestoreDropped: () => void;
  keptCount: number;
  totalCount: number;
  droppedCount: number;
  /** How many layers this merge has already been committed into. */
  committedCount: number;
  /** Set for a moment after a commit. Committing turns the blend into a layer
   *  in the annotator's own folder, which is why it does NOT appear on this
   *  canvas — Algorithm Inspect draws proposals, and it has stopped being one.
   *  Without a word said, the ⬇ reads as having done nothing. */
  committedNote?: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-1 py-1">
      {/* ── Member chips ───────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-1">
        {lanes.map((lane) => (
          <span
            key={lane.id}
            className="inline-flex items-center gap-1 pl-1.5 pr-0.5 py-[1px] rounded border text-[10px] leading-tight"
            style={{ borderColor: `${lane.color}55`, background: `${lane.color}14`, color: lane.color }}
            title={`${lane.label} — ${lane.times.length} boundaries`}
          >
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: lane.color }} />
            {lane.label}
            <span className="font-mono opacity-60">{lane.times.length}</span>
            <button
              type="button"
              onClick={() => onRemoveLane(lane.id)}
              title={`Remove ${lane.label} from the merge`}
              className="ml-0.5 w-3.5 h-3.5 inline-flex items-center justify-center rounded text-[10px] opacity-60 hover:opacity-100 hover:bg-white/10 transition-opacity"
            >
              ×
            </button>
          </span>
        ))}
      </div>

      {/* ── Tally + actions ────────────────────────────────────────────── */}
      <span
        className="text-[10px] font-mono text-gray-500 tabular-nums"
        title={droppedCount > 0
          ? `${keptCount} boundaries kept of the ${totalCount} the member lanes found — you dropped ${droppedCount}`
          : `Every one of the ${totalCount} boundaries the member lanes found`}
      >
        <span className="text-emerald-300">{keptCount}</span>
        <span className="text-gray-700">/{totalCount}</span>
      </span>

      {droppedCount > 0 && (
        <button
          type="button"
          onClick={onRestoreDropped}
          className="text-[10px] text-amber-300/90 hover:text-amber-200 underline decoration-dotted underline-offset-2 transition-colors"
          title="Put every boundary you dropped by hand back into the merge"
        >
          {droppedCount} dropped ↺
        </button>
      )}

      <span className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onClear}
          className="text-[10px] text-gray-500 hover:text-gray-300 px-1.5 py-0.5 rounded border border-gray-800 hover:border-gray-700 transition-colors"
          title="Empty the merge — the member lanes themselves are untouched"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={onCommit}
          disabled={keptCount === 0}
          className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border transition-colors ${
            keptCount === 0
              ? 'border-gray-800 text-gray-700 cursor-not-allowed'
              : committedCount > 0
                ? 'border-amber-400/30 text-amber-200 bg-amber-500/[0.08] hover:bg-amber-500/[0.16]'
                : 'border-emerald-400/30 text-emerald-200 bg-emerald-500/[0.08] hover:bg-emerald-500/[0.16]'
          }`}
          title={committedCount > 0
            ? `Copy these ${keptCount} boundaries into a new editable layer — ${committedCount} already committed from this merge`
            : `Copy these ${keptCount} boundaries into a new editable boundary layer`}
        >
          <span aria-hidden>⬇</span>
          Commit
          {committedCount > 0 && <span className="font-mono opacity-70">×{committedCount}</span>}
        </button>
        {committedNote && (
          <span className="text-[10px] text-emerald-300/90" role="status">{committedNote}</span>
        )}
      </span>
    </div>
  );
}
