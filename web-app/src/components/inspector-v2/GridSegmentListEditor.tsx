// The grid-segment list inside step ③ (Grid segments) of the Song-setup panel.
//
// The lane on the waveform is the tactile path; this is the keyboard-and-
// numbers one, and it is where the feature is discovered at all. It lists
// every segment — the derived opening one included — with its start, meter
// and tempo, and adds a split at the playhead.
//
// Row 1 is the opening segment: it can be jumped to and edited like any
// other but never merged away, because its start is the song's own downbeat.
//
// The trailing control on every other row MERGES that segment into the one
// above it. Under the hood that is the stored head being dropped — hence the
// `onDelete` prop — but nothing is lost from the song: the two spans become
// one, counted at the earlier segment's own tempo and meter.
//
// Every segment gets a row, including when there is only one. In Mapped mode
// this list is the ONLY place tempo and meter are edited — the song-level BPM
// field is hidden there, because in a tempo map those numbers belong to the
// segments. A one-segment map that showed prose instead of its row would
// leave the song's tempo with nowhere to be set.

import type { ResolvedSegment } from '../../utils/gridSegments';
import { canPlaceSegmentAt } from '../../utils/gridSegments';
import { formatClockTime } from '../../utils/clockTime';

export interface GridSegmentListEditorProps {
  segments: readonly ResolvedSegment[];
  /** Current playhead, in seconds — where "Split here" would land. */
  playerTime: number;
  selectedId?: string | null;
  locked?: boolean;
  /** Row click. `anchor` is the cursor position so the host can open the
   *  segment editor beside the row that was clicked, not floating in the
   *  middle of the screen with nothing tying it to the choice. */
  onSelect?: (segment: ResolvedSegment, anchor: { x: number; y: number }) => void;
  onSeek?: (time: number) => void;
  onDelete?: (segment: ResolvedSegment) => void;
  /** Split the grid at the playhead. Hidden when not provided. */
  onSplitAtPlayhead?: () => void;
  /** Draw the "Grid segments · N" heading. Off when the host already titles
   *  the block — the Song-setup step does, and two headings read as a bug. */
  showHeader?: boolean;
}

export function GridSegmentListEditor({
  segments,
  playerTime,
  selectedId,
  locked = false,
  onSelect,
  onSeek,
  onDelete,
  onSplitAtPlayhead,
  showHeader = true,
}: GridSegmentListEditorProps) {
  if (segments.length === 0) return null;

  const splitCheck = canPlaceSegmentAt(segments, playerTime);
  const canSplit = !locked && !!onSplitAtPlayhead && splitCheck.ok;
  const isUnsplit = segments.length === 1;

  return (
    <div className="space-y-2.5">
      {showHeader && (
        <div className="flex items-center gap-[7px]">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-slate-500">
            Grid segments
          </span>
          <span className="h-px flex-1 bg-white/[0.07]" />
          {!isUnsplit && (
            <span className="font-mono text-[10px] text-cyan-200">{segments.length}</span>
          )}
        </div>
      )}

      <div className="flex flex-col gap-[3px]">
        {segments.map((seg) => {
          const isOpening = seg.index === 0;
          const isSelected = seg.id === selectedId;
          return (
            <div
              key={seg.id}
              className={`grid grid-cols-[15px_62px_48px_1fr_15px] items-center gap-[7px] rounded-[5px] border px-[7px] py-1.5 font-mono text-[11px] transition-colors ${
                isSelected
                  ? 'border-cyan-400/40 bg-cyan-500/[0.08] text-slate-200'
                  : 'border-white/[0.06] bg-white/[0.015] text-slate-400 hover:border-white/[0.12]'
              }`}
            >
              <span className="text-[9.5px] text-slate-500">{seg.index + 1}</span>
              <button
                type="button"
                onClick={(e) => { onSeek?.(seg.start); onSelect?.(seg, { x: e.clientX, y: e.clientY }); }}
                title={`Jump to ${formatClockTime(seg.start, 3)}`}
                className="text-left tabular-nums text-slate-200 hover:text-cyan-200 transition-colors"
              >
                {formatClockTime(seg.start, 3)}
              </button>
              <button
                type="button"
                onClick={(e) => onSelect?.(seg, { x: e.clientX, y: e.clientY })}
                title="Edit this segment"
                className="text-left tabular-nums text-cyan-100 hover:text-cyan-200 transition-colors"
              >
                {seg.bpm.toFixed(2)}
              </button>
              <button
                type="button"
                onClick={(e) => onSelect?.(seg, { x: e.clientX, y: e.clientY })}
                title="Edit this segment"
                className="text-left hover:text-slate-200 transition-colors"
              >
                {seg.timeSignature}
              </button>
              <button
                type="button"
                onClick={() => onDelete?.(seg)}
                disabled={locked || isOpening || !onDelete}
                aria-label={isOpening
                  ? 'Segment 1 has nothing before it to merge into'
                  : `Merge segment ${seg.index + 1} into segment ${seg.index}`}
                title={isOpening
                  ? 'Segment 1 has nothing before it to merge into — its start is the song’s downbeat.'
                  : `Merge into segment ${seg.index} — the split goes, and segment ${seg.index} counts on at ${segments[seg.index - 1].bpm.toFixed(2)} BPM.`}
                className="text-right text-slate-600 hover:text-amber-300 transition-colors disabled:opacity-25 disabled:hover:text-slate-600 disabled:cursor-not-allowed"
              >
                ⇤
              </button>
            </div>
          );
        })}
      </div>

      {isUnsplit && (
        <p className="text-[10.5px] leading-snug text-slate-500 text-pretty">
          One grid, whole song — an empty map reads exactly like Steady. Add a marker
          where the music restarts the count: a meter change, a breakdown, a tape splice.
        </p>
      )}

      {onSplitAtPlayhead && !locked && (
        <button
          type="button"
          onClick={onSplitAtPlayhead}
          disabled={!canSplit}
          title={canSplit
            ? `Start a new grid at ${formatClockTime(playerTime, 3)}`
            : splitCheck.reason ?? 'Move the playhead first'}
          className="w-full rounded-[5px] border border-cyan-400/40 bg-cyan-500/10 py-[7px] text-center text-[11.5px] font-semibold text-cyan-100 transition-colors hover:bg-cyan-500/20 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-cyan-500/10"
        >
          ＋ Split the grid at the playhead
        </button>
      )}

      {/* The playhead starts at the song's own downbeat, where a split is
          meaningless — saying so before the curator has moved it reads as an
          error on arrival. The reason only earns its amber once they are
          somewhere a split was plausibly intended. */}
      {!canSplit && !locked && onSplitAtPlayhead && splitCheck.reason && playerTime > segments[0].start && (
        <p className="text-[10.5px] leading-snug text-amber-400/80">{splitCheck.reason}</p>
      )}

      <p className="text-[10.5px] leading-[1.45] text-slate-500 text-pretty">
        Click a row to set its tempo and meter, or to read them off that segment's own
        audio. Each segment starts its own bar 1, and the bar before a split is cut
        wherever the split lands. <span className="text-slate-400">⇤</span> merges a
        segment into the one above it, which then counts on at its own tempo.
      </p>
    </div>
  );
}
