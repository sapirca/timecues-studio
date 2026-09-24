// DataPrep-only controls for the three grid modes. Split in two so the
// Song-setup panel can put each where it belongs:
//
//   <TempoModePicker />        — the Steady / Mapped / Hand-placed segmented
//                                control at the top of step ① (Tempo), plus
//                                the Manual base banner + must-choose modal.
//   <GridResetControl />       — the destructive grid reset, at the foot of
//                                step ① under the picker it undoes. It used to
//                                live in an Advanced drawer of its own; that
//                                drawer held nothing else, and stood empty
//                                whenever the reset had nothing to offer.
//
// The wire values stay `static` / `mapped` / `manual`; only the labels are
// plain-language. Hosting page passes the current SongInfo + an onChange
// callback so both persist immediately.

import { useState } from 'react';
import type { SongInfo, GridMode, ManualBaseGridMode } from '../../types/songInfo';
import { effectiveGridMode, getActiveBeatOverrideCount, getGridSegmentCount } from '../../types/songInfo';
import { ManualBasePickerModal } from './ManualBasePickerModal';
import { MODE_LABEL, MODE_BLURB } from './shared/gridModeLabels';

const SEGMENT_ACTIVE: Record<GridMode, string> = {
  static: 'bg-slate-400/15 border-slate-400/40 text-slate-100',
  mapped: 'bg-violet-500/15 border-violet-400/40 text-violet-100',
  manual: 'bg-emerald-500/15 border-emerald-400/40 text-emerald-100',
};

export interface TempoModePickerProps {
  songInfo: SongInfo | null;
  onChange: (info: SongInfo) => void;
  /** When true, the controls render but inputs are disabled (non-admin viewer). */
  locked?: boolean;
  /** The grid-segment list, rendered under the picker while Mapped is the
   *  active mode. Passed as a slot because building it needs the player's
   *  time and the page's segment handlers, neither of which this control
   *  should know about. */
  segmentsSlot?: React.ReactNode;
  /** How many grids the song is currently divided into, for the blurb. */
  segmentCount?: number;
}

/** Shared mode-transition logic — the segmented picker and the base-picker
 *  modal both need it, and GridResetControl needs the reset half. */
function useGridModeState(songInfo: SongInfo | null, onChange: (info: SongInfo) => void, locked: boolean) {
  const mode = effectiveGridMode(songInfo);
  const manualBase = songInfo?.manualBaseGridMode;
  const [showBasePickerManual, setShowBasePickerManual] = useState(false);
  // Remembered when the curator switches *into* Manual without a base, so
  // the abort path (Esc / ✕ on the must-choose modal) can revert back.
  const [modeBeforeManual, setModeBeforeManual] = useState<GridMode | null>(null);

  const mustChooseBase = !locked && mode === 'manual' && manualBase === undefined;

  const setMode = (next: GridMode) => {
    if (!songInfo || next === mode) return;
    // Remember the previous mode when switching into Manual without a base
    // so the modal's abort path can revert back to it.
    if (next === 'manual' && songInfo.manualBaseGridMode === undefined) {
      setModeBeforeManual(mode);
    }
    onChange({ ...songInfo, gridMode: next, updated_at: new Date().toISOString() });
  };

  const pickBase = (base: ManualBaseGridMode) => {
    if (!songInfo) return;
    onChange({ ...songInfo, manualBaseGridMode: base, gridMode: 'manual', updated_at: new Date().toISOString() });
    setShowBasePickerManual(false);
    setModeBeforeManual(null);
  };

  const cancelBasePicker = () => {
    if (manualBase !== undefined) {
      // Re-opened from "Change base…" — just close, no mode change.
      setShowBasePickerManual(false);
      return;
    }
    // Must-choose abort path: revert gridMode back to where the curator
    // was before picking Hand-placed. Falls back to Steady if we somehow
    // got here without a remembered previous mode.
    if (songInfo) {
      const revertTo: GridMode = modeBeforeManual ?? 'static';
      onChange({ ...songInfo, gridMode: revertTo, updated_at: new Date().toISOString() });
    }
    setModeBeforeManual(null);
    setShowBasePickerManual(false);
  };

  return {
    mode,
    manualBase,
    showBasePicker: mustChooseBase || showBasePickerManual,
    openBasePicker: () => setShowBasePickerManual(true),
    closeBasePicker: () => setShowBasePickerManual(false),
    setMode,
    pickBase,
    cancelBasePicker,
  };
}

export function TempoModePicker({
  songInfo,
  onChange,
  locked = false,
  segmentsSlot,
  segmentCount = 1,
}: TempoModePickerProps) {
  const grid = useGridModeState(songInfo, onChange, locked);
  const overrideCount = getActiveBeatOverrideCount(songInfo);

  if (!songInfo) return null;

  const renderOption = (value: GridMode) => {
    const isActive = value === grid.mode;
    return (
      <button
        key={value}
        type="button"
        role="radio"
        aria-checked={isActive}
        disabled={locked}
        onClick={() => grid.setMode(value)}
        title={`${MODE_LABEL[value]} — ${MODE_BLURB[value]}`}
        className={`flex-1 basis-0 min-w-0 truncate rounded-[5px] px-1 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
          isActive
            ? `border ${SEGMENT_ACTIVE[value]}`
            : 'border border-transparent text-slate-400 hover:text-slate-100 hover:bg-white/[0.04]'
        }`}
      >
        {MODE_LABEL[value] ?? value}
      </button>
    );
  };

  return (
    <div className="space-y-1.5">
      <div
        role="radiogroup"
        aria-label="Tempo mode"
        className="flex gap-1 rounded-[7px] border border-white/[0.05] bg-black/35 p-[3px]"
      >
        {renderOption('static')}
        {renderOption('mapped')}
        {renderOption('manual')}
      </div>
      <p className="text-[11px] leading-snug text-slate-500 text-pretty">
        {MODE_BLURB[grid.mode]}
        {grid.mode === 'manual' && overrideCount > 0 && (
          <span className="text-amber-300/80"> {overrideCount} pinned beat{overrideCount === 1 ? '' : 's'}.</span>
        )}
        {grid.mode === 'mapped' && segmentCount > 1 && (
          <span className="text-violet-300/80"> {segmentCount} grids so far.</span>
        )}
      </p>

      {/* The map itself lives with the mode that turns it on, not in a step
          of its own — it is a question about Mapped, not a separate stage. */}
      {/* Hand-placed on a Mapped base rides the same segment table, and in
          both modes this list is the only editor for a segment's tempo and
          meter — the song-level BPM field is hidden wherever the map is
          live. Showing it only in Mapped would strand the base grid. */}
      {(grid.mode === 'mapped'
        || (grid.mode === 'manual' && grid.manualBase === 'mapped')) && segmentsSlot}

      {grid.mode === 'manual' && !locked && grid.manualBase !== undefined && (
        <div className="flex items-center gap-2 px-2.5 py-2 rounded-md border border-emerald-500/30 bg-emerald-500/[0.05]">
          <span className="min-w-0 text-[11px] text-slate-300">
            Base grid:{' '}
            <span className="font-semibold text-emerald-300">
              {grid.manualBase === 'mapped' ? 'Mapped' : 'Steady'}
            </span>
            {grid.manualBase === 'mapped' && segmentCount > 1 && (
              <span className="text-slate-500"> · pinned beats ride on {segmentCount} grids</span>
            )}
          </span>
          <button
            type="button"
            onClick={grid.openBasePicker}
            className="ml-auto shrink-0 px-2.5 py-1 rounded text-[11px] font-semibold border border-emerald-400/50 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/25 transition-colors"
            title="Switch which underlying tempo grid your pinned beats sit on top of."
          >
            Change base…
          </button>
        </div>
      )}

      <ManualBasePickerModal
        open={grid.showBasePicker}
        onOpenChange={(o) => { if (!o) grid.closeBasePicker(); }}
        current={grid.manualBase}
        overrideCount={overrideCount}
        segmentCount={segmentCount}
        onPick={grid.pickBase}
        onCancel={grid.cancelBasePicker}
      />
    </div>
  );
}

export interface GridControlsProps {
  songInfo: SongInfo | null;
  onChange: (info: SongInfo) => void;
  locked?: boolean;
}

/** The destructive grid reset — the way out of whichever mode the picker above
 *  is on. It sits at the foot of the Tempo step, under the picker it undoes,
 *  and renders nothing at all when there is nothing to undo (a Steady grid with
 *  no pinned beats) or for a read-only viewer. */
export function GridResetControl({
  songInfo,
  onChange,
  locked = false,
}: GridControlsProps) {
  const mode = effectiveGridMode(songInfo);
  const overrideCount = getActiveBeatOverrideCount(songInfo);
  const splitCount = getGridSegmentCount(songInfo) - 1;
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  if (!songInfo || locked) return null;

  const canReset = overrideCount > 0 || mode !== 'static';
  if (!canReset) return null;

  // Name what actually goes, per mode — "drops 0 pinned beats" on a Mapped
  // song is both wrong and alarming. The reset only switches the mode and
  // clears the pinned beats; a segment map is left on disk, parked, because
  // switching away from Mapped is what makes it inactive.
  const losses: string[] = [];
  if (overrideCount > 0) losses.push(`${overrideCount} pinned beat${overrideCount === 1 ? '' : 's'}`);
  const blurb =
    losses.length > 0
      ? `Drops ${losses.join(' and ')}, back to Steady.`
      : mode === 'mapped' && splitCount > 0
        ? `Back to Steady. The ${splitCount + 1}-grid map is parked, not deleted.`
        : 'Back to Steady — one tempo for the whole song.';
  const confirmQuestion =
    losses.length > 0 ? `Discard ${losses.join(' and ')}?` : 'Switch back to Steady?';

  const resetGrid = () => {
    onChange({
      ...songInfo,
      gridMode: 'static',
      beatOverrides: {},
      manualBaseGridMode: undefined,
      updated_at: new Date().toISOString(),
    });
    setShowResetConfirm(false);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-md border border-red-500/25 bg-red-500/[0.05]">
        {!showResetConfirm ? (
          <>
            <span className="flex-1 min-w-0 flex flex-col gap-0.5">
              <span className="text-xs font-semibold text-red-300">Reset the grid</span>
              <span className="text-[10px] text-slate-500">{blurb}</span>
            </span>
            <button
              type="button"
              onClick={() => setShowResetConfirm(true)}
              className="shrink-0 px-3 py-1.5 rounded text-xs font-semibold border border-red-500/50 text-red-300 hover:bg-red-500/15 hover:text-red-200 transition-colors"
            >
              Reset
            </button>
          </>
        ) : (
          <>
            <span className="flex-1 min-w-0 text-xs font-semibold text-red-300">
              {confirmQuestion}
            </span>
            <button
              type="button"
              onClick={resetGrid}
              className="shrink-0 px-3 py-1.5 rounded text-xs font-semibold border-2 border-red-500/70 bg-red-500/30 text-red-50 hover:bg-red-500/40 transition-colors"
            >
              Yes, reset
            </button>
            <button
              type="button"
              onClick={() => setShowResetConfirm(false)}
              className="shrink-0 px-3 py-1.5 rounded text-xs border border-white/[0.12] bg-white/[0.04] text-slate-300 hover:text-slate-100 transition-colors"
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}
