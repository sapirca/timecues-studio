/**
 * VocalRunsSection — the shape of the voice on the Prominence lane.
 *
 * A lyrics layer reaches that lane as one block per SUNG STRETCH rather than
 * one per word (see utils/vocalRuns.ts for why). The stretches are derived, and
 * a derivation with a threshold in it will get some songs wrong — so this is
 * where the annotator corrects it: change the gap that splits one run from the
 * next, cut a run the threshold ran straight through, or join two it pulled
 * apart.
 *
 * Levels are NOT edited here. Saying who is in front is the Prominence lane's
 * whole job, and a second surface for it would be a second place to disagree.
 * What lives here is the run's extent — where the voice starts and stops — plus
 * the one cross-layer action the lane can't express as a drag: handing the
 * front to the voice across every stretch at once.
 *
 * Runs start out DERIVED, which the header says plainly. Nothing is written
 * until an edit, and the first edit freezes the whole list so that correcting a
 * word's timing later can't renumber a run that has already been annotated.
 */

import { useMemo, useState } from 'react';
import type { AnnotationLayer, VocalRun } from '../../types/annotationLayer';
import {
  DEFAULT_VOCAL_RUN_GAP_BARS,
  mergeVocalRunWithNext,
  resolveVocalRuns,
  splitVocalRun,
  vocalRunsAreDerived,
  type VocalRunGrid,
} from '../../utils/vocalRuns';
import { formatClockTime as fmtTime } from '../../utils/clockTime';
import { formatBeatPosition } from '../../utils/beatGrid';

/** Gap choices, in bars. Half a bar splits on every breath; eight fuses a verse
 *  into the chorus after it. Two is the default for the reason given in
 *  utils/vocalRuns.ts. */
const GAP_CHOICES = [0.5, 1, 2, 3, 4, 6, 8];

const GAP_TITLE =
  'How long the voice has to stop before the Prominence lane counts it as a new '
  + 'run. Measured in bars, so it follows the tempo. Two bars is the default: one '
  + "bar of rest between lines is ordinary phrasing inside a verse, and splitting "
  + 'there breaks a single chorus into a block per line. Only affects runs that '
  + 'are still derived.';

interface VocalRunsSectionProps {
  layer: AnnotationLayer<'lyrics'>;
  /** Beat grid the run edges snap out to. Absent ⇒ runs still derive, just
   *  without bar-aligned edges. */
  grid?: VocalRunGrid;
  /** Playhead, in track seconds — where a split lands. */
  currentTime: number;
  onPatchLayer: (layerId: string, patch: Partial<AnnotationLayer<'lyrics'>>) => void;
  /** Hand the front to this layer's voice everywhere it sings, demoting whoever
   *  else held it. One document write, one undo. Absent ⇒ the action is hidden. */
  onAssignVocalLead?: (layerId: string) => void;
  onSeek?: (time: number) => void;
}

/** "bar 17" when the song has a tempo, else the clock time. */
function positionLabel(t: number, grid: VocalRunGrid | undefined): string {
  if (!grid?.bpm || grid.bpm <= 0) return fmtTime(t);
  const p = formatBeatPosition(t, grid.bpm, grid.gridOffset ?? 0, grid.beatsPerBar ?? 4);
  return `bar ${p.bar}`;
}

export function VocalRunsSection({
  layer, grid, currentTime, onPatchLayer, onAssignVocalLead, onSeek,
}: VocalRunsSectionProps) {
  const runs = useMemo(() => resolveVocalRuns(layer, grid), [layer, grid]);
  const derived = vocalRunsAreDerived(layer);
  // A re-derive throws away every level the annotator set on a run, so it asks
  // once — in place, on the button itself, rather than through a dialog that
  // would be the only modal in this panel.
  const [armed, setArmed] = useState(false);

  const annotated = runs.some((r) => r.prominence && r.prominence.length > 0);
  const gap = layer.vocalRunGapBars ?? DEFAULT_VOCAL_RUN_GAP_BARS;

  function writeRuns(next: VocalRun[]) {
    onPatchLayer(layer.id, { vocalRuns: next });
  }

  if (layer.items.length === 0) return null;

  return (
    <div className="rounded bg-[#0f1116] border border-white/[0.06] px-2 py-1.5 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-slate-500 shrink-0">
          Vocal runs
        </span>
        <span className="text-[10px] text-slate-600 shrink-0">
          {runs.length} · {derived ? 'derived' : 'edited'}
        </span>
        <div className="flex-1" />
        <label className="flex items-center gap-1 text-[9px] text-slate-500 shrink-0" title={GAP_TITLE}>
          Split on
          <select
            value={String(gap)}
            onChange={(e) => onPatchLayer(layer.id, { vocalRunGapBars: Number(e.target.value) })}
            disabled={!derived}
            className="h-5 text-[9px] font-mono rounded border px-1 py-0 leading-none cursor-pointer focus:outline-none transition-colors bg-white/[0.03] border-white/[0.12] text-slate-400 hover:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {GAP_CHOICES.map((g) => (
              <option key={g} value={g}>{g} bar{g === 1 ? '' : 's'}</option>
            ))}
          </select>
        </label>
        {!derived && (
          <button
            onClick={() => {
              if (annotated && !armed) { setArmed(true); return; }
              setArmed(false);
              onPatchLayer(layer.id, { vocalRuns: undefined });
            }}
            onBlur={() => setArmed(false)}
            className={`shrink-0 h-5 px-1.5 rounded text-[9px] border transition-colors ${
              armed
                ? 'border-red-500/40 text-red-300 bg-red-500/10'
                : 'border-white/[0.12] text-slate-400 hover:text-slate-200 bg-white/[0.03]'
            }`}
            title={
              annotated
                ? 'Rebuild the runs from the current word timings at the gap above. '
                  + 'The levels set on these runs are discarded.'
                : 'Rebuild the runs from the current word timings at the gap above.'
            }
          >
            {armed ? 'Discard levels?' : 'Rebuild'}
          </button>
        )}
      </div>

      <div className="flex flex-col gap-0.5 max-h-[160px] overflow-y-auto">
        {runs.map((run, i) => {
          const splittable = currentTime > run.start + 0.05 && currentTime < run.end - 0.05;
          return (
            <div
              key={run.id}
              className="flex items-center gap-1.5 px-1 py-0.5 rounded hover:bg-white/[0.03]"
            >
              <button
                onClick={() => onSeek?.(run.start)}
                className="font-mono text-[10px] text-slate-400 hover:text-slate-100 shrink-0"
                title={`Seek to the start of this run (${fmtTime(run.start)})`}
              >
                {positionLabel(run.start, grid)}–{positionLabel(run.end, grid)}
              </button>
              <span className="flex-1 min-w-0 truncate text-[10px] text-slate-600">
                {fmtTime(run.end - run.start)}
              </span>
              <button
                onClick={() => writeRuns(splitVocalRun(runs, run.id, currentTime))}
                disabled={!splittable}
                className="shrink-0 w-5 h-5 rounded text-[10px] text-slate-600 hover:text-slate-100 hover:bg-white/[0.06] disabled:text-slate-800 disabled:hover:bg-transparent transition-colors"
                title={
                  splittable
                    ? `Cut this run at the playhead (${fmtTime(currentTime)}) — the voice does stop here`
                    : 'Move the playhead inside this run to cut it'
                }
              >
                ✂
              </button>
              <button
                onClick={() => writeRuns(mergeVocalRunWithNext(runs, run.id))}
                disabled={i >= runs.length - 1}
                className="shrink-0 w-5 h-5 rounded text-[10px] text-slate-600 hover:text-slate-100 hover:bg-white/[0.06] disabled:text-slate-800 disabled:hover:bg-transparent transition-colors"
                title="Join this run to the next one — it was one phrase, not two"
              >
                ⤓
              </button>
            </div>
          );
        })}
      </div>

      {onAssignVocalLead && runs.length > 0 && (
        <button
          onClick={() => onAssignVocalLead(layer.id)}
          className="w-full h-6 rounded text-[10px] border border-white/[0.12] bg-white/[0.03] text-slate-300 hover:text-slate-100 hover:bg-white/[0.06] transition-colors"
          title={
            'Give this voice the lead across every run, dropping whoever else held it '
            + 'to Counter there. The Prominence lane already SHOWS the voice in front — '
            + 'that is a reading, not an annotation, and it leaves instrumental parts '
            + 'sharing the front with it. This writes the handover for real, in one '
            + 'undoable step.'
          }
        >
          Vocal leads where it sings
        </button>
      )}
    </div>
  );
}
