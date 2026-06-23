// DataPrep-only controls for the three grid modes: Static BPM, Dynamic,
// Manual adjustment. Lives below the BPM / Grid Offset inputs in
// SongInfoBar. Hosting page passes the current SongInfo + an onChange
// callback so the selector and the Reset Grid button persist immediately.

import { useState } from 'react';
import type { SongInfo, GridMode, ManualBaseGridMode } from '../../types/songInfo';
import { effectiveGridMode, getActiveAnchorCount, getActiveBeatOverrideCount } from '../../types/songInfo';
import { ManualBasePickerModal } from './ManualBasePickerModal';

export interface GridModeControlsProps {
  songInfo: SongInfo | null;
  onChange: (info: SongInfo) => void;
  /** When true, the controls render but inputs are disabled (non-admin viewer). */
  locked?: boolean;
  /** Optional callback fired when the curator picks Dynamic mode. The host
   *  is responsible for fetching the tempo curve and converting it to
   *  anchors. The selector only flips the gridMode field. */
  onEnterDynamic?: () => void;
  /** Called when the curator clicks "Re-derive" with the threshold slider's
   *  current value (BPM). The host should fetch the tempo curve and
   *  replace `tempoAnchors` with a freshly derived baseline. */
  onRederive?: (thresholdBpm: number) => void;
}

// Tab styles per mode — same language as the annotation type-tab rail in the
// Annotate / Algo sidebars: a bottom-accent tab that splits the row evenly, a
// translucent color fill + bright underline + soft glow when active, faded
// fill with a dim underline when idle. A check glyph marks the active tab so
// the radio-style "pick one" intent stays clear.
const MODE_STYLES: Record<GridMode, { pillActive: string; pillIdle: string }> = {
  static: {
    pillActive: 'bg-slate-400/15 text-slate-100 border-b-slate-300 border-x-slate-400/40 border-t-slate-400/40 shadow-[0_0_14px_-3px_rgba(148,163,184,0.6)]',
    pillIdle:   'bg-slate-400/[0.04] text-slate-400 hover:text-slate-100 hover:bg-slate-400/10 border-b-slate-400/25 border-x-transparent border-t-transparent',
  },
  dynamic: {
    pillActive: 'bg-cyan-500/15 text-cyan-100 border-b-cyan-400 border-x-cyan-400/40 border-t-cyan-400/40 shadow-[0_0_14px_-3px_rgba(34,211,238,0.6)]',
    pillIdle:   'bg-cyan-500/[0.04] text-cyan-300/70 hover:text-cyan-100 hover:bg-cyan-500/10 border-b-cyan-400/25 border-x-transparent border-t-transparent',
  },
  manual: {
    pillActive: 'bg-emerald-500/15 text-emerald-100 border-b-emerald-400 border-x-emerald-400/40 border-t-emerald-400/40 shadow-[0_0_14px_-3px_rgba(52,211,153,0.6)]',
    pillIdle:   'bg-emerald-500/[0.04] text-emerald-300/70 hover:text-emerald-100 hover:bg-emerald-500/10 border-b-emerald-400/25 border-x-transparent border-t-transparent',
  },
};

const MODE_LABEL: Record<GridMode, string> = {
  static: 'Static BPM',
  dynamic: 'Dynamic',
  manual: 'Manual adjustment',
};

export function GridModeControls({
  songInfo,
  onChange,
  locked = false,
  onEnterDynamic,
  onRederive,
}: GridModeControlsProps) {
  const mode = effectiveGridMode(songInfo);
  const anchorCount = getActiveAnchorCount(songInfo);
  const overrideCount = getActiveBeatOverrideCount(songInfo);
  const manualBase = songInfo?.manualBaseGridMode;
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  // True when the curator manually clicked "Change base…". The modal is
  // *also* forced open whenever Manual mode is active without a chosen
  // base (mustChooseBase below) — that case is derived, no extra state.
  const [showBasePickerManual, setShowBasePickerManual] = useState(false);
  // Remembered when the curator switches *into* Manual without a base, so
  // the abort path (Esc / ✕ on the must-choose modal) can revert back.
  const [modeBeforeManual, setModeBeforeManual] = useState<GridMode | null>(null);
  // Dynamic-mode threshold slider — defaults to the same 5 BPM that the
  // auto-population path uses, so "Re-derive" with no slider movement is
  // idempotent against the initial baseline.
  const [dynamicThreshold, setDynamicThreshold] = useState<number>(5);

  if (!songInfo) return null;

  const mustChooseBase = !locked && mode === 'manual' && manualBase === undefined;
  const showBasePicker = mustChooseBase || showBasePickerManual;

  const setMode = (next: GridMode) => {
    if (next === mode) return;
    // Remember the previous mode when switching into Manual without a base
    // so the modal's abort path can revert back to it.
    if (next === 'manual' && songInfo.manualBaseGridMode === undefined) {
      setModeBeforeManual(mode);
    }
    onChange({ ...songInfo, gridMode: next, updated_at: new Date().toISOString() });
    if (next === 'dynamic') onEnterDynamic?.();
    // No need to flip showBasePickerManual — mustChooseBase becomes true
    // on the next render when manualBaseGridMode is undefined.
  };

  const pickBase = (base: ManualBaseGridMode) => {
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
    // was before clicking the Manual pill. Falls back to Static if we
    // somehow got here without a remembered previous mode.
    const revertTo: GridMode = modeBeforeManual ?? 'static';
    onChange({ ...songInfo, gridMode: revertTo, updated_at: new Date().toISOString() });
    setModeBeforeManual(null);
    setShowBasePickerManual(false);
  };

  const resetGrid = () => {
    onChange({
      ...songInfo,
      gridMode: 'static',
      tempoAnchors: [],
      beatOverrides: {},
      manualBaseGridMode: undefined,
      updated_at: new Date().toISOString(),
    });
    setShowResetConfirm(false);
  };

  const renderOption = (value: GridMode, label: string) => {
    const isActive = value === mode;
    const style = MODE_STYLES[value];
    return (
      <button
        key={value}
        type="button"
        disabled={locked}
        onClick={() => setMode(value)}
        aria-pressed={isActive}
        title={isActive ? `${label} is the active mode (rendered in all workspaces)` : `Switch to ${label}`}
        className={`flex-1 basis-0 min-w-0 inline-flex items-center justify-center gap-1 px-1.5 py-1.5 rounded-md border-b-2 border-x border-t text-[10px] font-mono font-semibold uppercase tracking-wide transition disabled:opacity-50 disabled:cursor-not-allowed ${
          isActive ? style.pillActive : style.pillIdle
        }`}
      >
        <span className={`inline-block w-2.5 text-center shrink-0 ${isActive ? '' : 'opacity-0'}`} aria-hidden="true">✓</span>
        <span className="truncate">{label}</span>
      </button>
    );
  };

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs text-slate-400 uppercase tracking-wider">Tempo mode</span>
        <span className="text-sm font-mono text-slate-300">
          Active: <span className="text-slate-100 font-semibold">{MODE_LABEL[mode]}</span>
          {mode === 'manual' && manualBase && (
            <span className={manualBase === 'dynamic' ? 'text-cyan-300/90' : 'text-slate-400'}>
              {' '}· base: <span className="font-semibold">{manualBase === 'dynamic' ? 'Dynamic' : 'Static'}</span>
            </span>
          )}
          {mode === 'dynamic' && <span className="text-slate-400"> · {anchorCount} anchor{anchorCount === 1 ? '' : 's'}</span>}
          {mode === 'manual' && manualBase === 'dynamic' && (
            <span className="text-slate-400"> · {anchorCount} anchor{anchorCount === 1 ? '' : 's'}</span>
          )}
          {mode === 'manual' && overrideCount > 0 && (
            <span className="text-amber-300/90"> · {overrideCount} pinned beat{overrideCount === 1 ? '' : 's'}</span>
          )}
        </span>
      </div>
      <nav className="flex gap-1" role="radiogroup" aria-label="Grid mode">
        {renderOption('static',  'Static')}
        {renderOption('dynamic', 'Dynamic')}
        {renderOption('manual',  'Manual')}
      </nav>
      <p className="text-xs text-slate-500 leading-snug">
        Only the active mode's grid is drawn downstream (Annotation Tool + Algorithm Inspect). Switching never deletes the others' data.
      </p>
      {mode === 'manual' && !locked && manualBase !== undefined && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-emerald-500/30 bg-emerald-500/[0.05]">
          <span className="text-xs font-mono text-emerald-300 font-semibold">
            Base grid
          </span>
          <span className="text-xs font-mono text-slate-300">
            {manualBase === 'dynamic'
              ? `Dynamic — pinned beats ride on ${anchorCount} anchor${anchorCount === 1 ? '' : 's'}`
              : 'Static — pinned beats ride on the global BPM grid (anchors ignored)'}
          </span>
          <button
            type="button"
            onClick={() => setShowBasePickerManual(true)}
            className="ml-auto px-4 py-2 rounded-md text-sm font-mono font-semibold uppercase tracking-wider border-2 border-emerald-400/60 bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30 hover:border-emerald-300/80 transition-all"
            title="Switch which underlying tempo grid your pinned beats sit on top of."
          >
            Change base…
          </button>
        </div>
      )}
      {mode === 'dynamic' && onRederive && !locked && (
        <div className="px-3 py-2 rounded-md border border-cyan-500/30 bg-cyan-500/[0.05] space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-cyan-300 font-semibold">
              Δ Threshold
            </span>
            <input
              type="range"
              min={1}
              max={20}
              step={1}
              value={dynamicThreshold}
              onChange={(e) => setDynamicThreshold(parseInt(e.target.value, 10) || 5)}
              className="flex-1 max-w-[160px] accent-cyan-400"
              title={`Threshold: ${dynamicThreshold} BPM`}
            />
            <span className="text-xs font-mono font-semibold text-cyan-200 tabular-nums w-14">{dynamicThreshold} BPM</span>
            <button
              type="button"
              onClick={() => onRederive(dynamicThreshold)}
              className="ml-auto px-4 py-2 rounded-md text-sm font-mono font-semibold uppercase tracking-wider border-2 border-cyan-400/60 bg-cyan-500/20 text-cyan-100 hover:bg-cyan-500/30 hover:border-cyan-300/80 transition-all"
              title="Replace current anchors with a fresh Dynamic-mode baseline at this threshold."
            >
              ↻ Re-derive
            </button>
          </div>
          <p className="text-[10px] text-slate-400 leading-snug">
            Drops a new tempo anchor whenever the rolling-median BPM drifts more than this much from the last anchor. Lower = more anchors, follows subtle tempo changes; higher = fewer anchors, ignores small fluctuations.
          </p>
        </div>
      )}
      {!locked && (anchorCount > 0 || overrideCount > 0 || mode !== 'static') && (
        <div className="flex justify-end pt-1">
          {!showResetConfirm ? (
            <button
              type="button"
              onClick={() => setShowResetConfirm(true)}
              className="px-4 py-2 rounded-md text-sm font-semibold uppercase tracking-wider border-2 border-red-500/50 bg-red-500/[0.08] text-red-300 hover:bg-red-500/20 hover:border-red-400/70 hover:text-red-200 transition-all"
              title="Purges all anchors and pinned beat overrides, then reverts to Static BPM. Cannot be undone."
            >
              Reset Grid / Clear All Adjustments
            </button>
          ) : (
            <span className="inline-flex items-center gap-2">
              <span className="text-xs font-mono font-semibold text-red-300">
                Discard all anchors{overrideCount > 0 ? ' and pinned beats' : ''}?
              </span>
              <button
                type="button"
                onClick={resetGrid}
                className="px-3 py-1.5 rounded-md text-xs font-mono font-semibold border-2 border-red-500/70 bg-red-500/30 text-red-50 hover:bg-red-500/40"
              >
                Yes, reset
              </button>
              <button
                type="button"
                onClick={() => setShowResetConfirm(false)}
                className="px-3 py-1.5 rounded-md text-xs font-mono border-2 border-white/[0.12] bg-white/[0.04] text-slate-300 hover:text-slate-100 hover:border-white/20"
              >
                Cancel
              </button>
            </span>
          )}
        </div>
      )}
      <ManualBasePickerModal
        open={showBasePicker}
        onOpenChange={(o) => { if (!o) setShowBasePickerManual(false); }}
        current={manualBase}
        anchorCount={songInfo?.tempoAnchors?.length ?? 0}
        overrideCount={overrideCount}
        onPick={pickBase}
        onCancel={cancelBasePicker}
      />
    </div>
  );
}
