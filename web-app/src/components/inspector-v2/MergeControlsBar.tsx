/**
 * The control strip under the Merge lane — who is in the blend, and what to do
 * with it.
 *
 * There is no reconciliation rule to set, because a merge has none: every
 * boundary every member lane found is in. The knobs here are membership and
 * one switch — Smart merge, which folds the votes near one place into a single
 * candidate set on the figure, level step or bar line there (smartMerge.ts).
 * It has no threshold to tune either; thresholds and windows are the Consensus
 * stage's business.
 *
 * Membership and visibility are separate: a chip's eye takes its lane off the
 * canvas while it keeps feeding the blend, and "Merge only" does that for all
 * of them — for when the blend is what you want to read, not its ingredients.
 *
 * It lives in the content column, under the lane it drives, rather than in a
 * popover: adding or removing a lane changes what the lane above is drawing,
 * and the point of the feature is to watch that happen.
 */

import type { MergeSourceLane } from './boundaryMerge';

export function MergeControlsBar({
  lanes,
  onRemoveLane,
  onSetLanesHidden,
  onClear,
  onCommit,
  onRestoreDropped,
  keptCount,
  totalCount,
  droppedCount,
  committedCount,
  committedNote = null,
  smart = false,
  onSetSmart,
}: {
  /** Member lanes, in the order they were added. */
  lanes: MergeSourceLane[];
  onRemoveLane: (id: string) => void;
  /** Take member lanes off the canvas, or put them back. Without it, no eyes. */
  onSetLanesHidden?: (ids: string[], hidden: boolean) => void;
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
  /** One candidate per place instead of the union. */
  smart?: boolean;
  /** Without it, no Smart switch. */
  onSetSmart?: (on: boolean) => void;
}) {
  const allHidden = lanes.length > 0 && lanes.every((l) => l.hidden);
  const voteCount = lanes.reduce((n, l) => n + l.times.length, 0);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-1 py-1">
      {/* ── Member chips ───────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-1">
        {lanes.map((lane) => (
          <span
            key={lane.id}
            className="inline-flex items-center gap-1 pl-1.5 pr-0.5 py-[1px] rounded border text-[10px] leading-tight"
            style={{
              borderColor: `${lane.color}55`,
              background: lane.hidden ? 'transparent' : `${lane.color}14`,
              color: lane.color,
              borderStyle: lane.hidden ? 'dashed' : 'solid',
            }}
            title={`${lane.label} — ${lane.times.length} boundaries${lane.hidden ? ' · lane hidden, still in the merge' : ''}`}
          >
            {onSetLanesHidden ? (
              <button
                type="button"
                onClick={() => onSetLanesHidden([lane.id], !lane.hidden)}
                aria-pressed={!lane.hidden}
                aria-label={lane.hidden ? `Show the ${lane.label} lane` : `Hide the ${lane.label} lane`}
                title={lane.hidden
                  ? `Show the ${lane.label} lane again`
                  : `Hide the ${lane.label} lane — it stays in the merge`}
                className="w-3.5 h-3.5 inline-flex items-center justify-center rounded opacity-80 hover:opacity-100 hover:bg-white/10 transition-opacity"
              >
                <EyeIcon off={!!lane.hidden} />
              </button>
            ) : (
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: lane.color }} />
            )}
            <span className={lane.hidden ? 'opacity-70 italic' : ''}>{lane.label}</span>
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
        title={smart
          ? `${keptCount} kept of ${totalCount} candidates, one per place, from the ${voteCount} boundaries the member lanes found${droppedCount > 0 ? ` — you dropped ${droppedCount}` : ''}`
          : droppedCount > 0
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
        {onSetSmart && (
          <button
            type="button"
            onClick={() => onSetSmart(!smart)}
            aria-pressed={smart}
            className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
              smart
                ? 'border-violet-400/40 text-violet-200 bg-violet-500/[0.12] hover:bg-violet-500/[0.2]'
                : 'border-gray-800 text-gray-400 hover:text-gray-200 hover:border-gray-700'
            }`}
            title={smart
              ? 'Smart merge is on: boundaries within a bar of each other are one candidate, placed on a rhythmic figure, a big level change, or the bar line. Click to go back to every boundary the lanes found.'
              : 'Smart merge: fold boundaries within a bar of each other into one candidate, placed on a rhythmic figure there, else on a level change of 6 dB or more in Volume, Bass, Mids or Highs, else on the nearest bar line'}
          >
            {/* Names what the click does, like Merge only / Show lanes beside it
                — one label for both states left "which mode am I in?" open. */}
            {smart ? 'All boundaries' : 'Smart merge'}
          </button>
        )}
        {onSetLanesHidden && (
          <button
            type="button"
            onClick={() => onSetLanesHidden(lanes.map((l) => l.id), !allHidden)}
            aria-pressed={allHidden}
            className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
              allHidden
                ? 'border-violet-400/40 text-violet-200 bg-violet-500/[0.12] hover:bg-violet-500/[0.2]'
                : 'border-gray-800 text-gray-400 hover:text-gray-200 hover:border-gray-700'
            }`}
            title={allHidden
              ? 'Put the member lanes back on the canvas'
              : 'Hide the member lanes and show only the merge — they keep feeding it'}
          >
            {allHidden ? 'Show lanes' : 'Merge only'}
          </button>
        )}
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
            ? `Save these ${keptCount} boundaries as another new boundary layer in your annotations — ${committedCount} already saved from this merge. Open the Annotate tab to edit it.`
            : `Save these ${keptCount} boundaries as a new boundary layer in your annotations. Open the Annotate tab to edit it.`}
        >
          <span aria-hidden>⬇</span>
          Save as layer
          {committedCount > 0 && <span className="font-mono opacity-70">×{committedCount}</span>}
        </button>
        {committedNote && (
          <span className="text-[10px] text-emerald-300/90" role="status">{committedNote}</span>
        )}
      </span>
    </div>
  );
}

/** Open eye, or struck through — the lane on the canvas, or taken off it. */
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
      {off && <path d="M2.5 13.5 13.5 2.5" />}
    </svg>
  );
}
