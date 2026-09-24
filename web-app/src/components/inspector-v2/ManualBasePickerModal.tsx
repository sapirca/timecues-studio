// Modal that asks the curator which base grid Manual adjustment should
// ride on top of. Opens on first entry into Manual mode (when
// `songInfo.manualBaseGridMode` is undefined) and can be re-opened from
// the tempo-mode picker's "Change base…" button.
//
// Static = global BPM + offset; pinned beats sit on top of a single-tempo
// grid.
// Mapped = the song's grid segments are applied; pinned beats sit on top of
// a grid that restarts its bar 1 at each marker. Offered so that entering
// Hand-placed never silently discards a tempo map the curator has built.

import * as Dialog from '@radix-ui/react-dialog';
import type { ManualBaseGridMode } from '../../types/songInfo';

export interface ManualBasePickerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current selection — undefined when first entering Manual mode and
   *  the modal is forced open by the absence of a choice. */
  current?: ManualBaseGridMode;
  /** Pinned beat count, shown so the curator knows their micro edits
   *  survive a base switch (they ride on top of any base). */
  overrideCount: number;
  /** How many grids the song's tempo map divides it into. 1 = no map yet,
   *  which greys the Mapped card out — there would be nothing to ride. */
  segmentCount: number;
  onPick: (base: ManualBaseGridMode) => void;
  /** Cancel — closes the modal without changing anything. When `current`
   *  is undefined (must-choose first entry), Cancel acts as an *abort*:
   *  the host should revert gridMode back to where it was before the
   *  curator switched to Manual. */
  onCancel?: () => void;
}

export function ManualBasePickerModal({
  open,
  onOpenChange,
  current,
  overrideCount,
  segmentCount,
  onPick,
  onCancel,
}: ManualBasePickerModalProps) {
  const mustChoose = current === undefined;

  const handleOpenChange = (next: boolean) => {
    if (!next) onCancel?.();
    onOpenChange(next);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[101] w-[min(520px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-emerald-500/30 bg-[#14171d] shadow-2xl shadow-black/70 outline-none"
          aria-describedby={undefined}
          onPointerDownOutside={(e) => { if (mustChoose) e.preventDefault(); }}
        >
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
            <Dialog.Title className="text-[12px] font-semibold tracking-[0.18em] uppercase text-emerald-300">
              Hand-placed — pick base grid
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="text-slate-500 hover:text-slate-200 text-lg leading-none w-6 h-6 flex items-center justify-center rounded hover:bg-white/[0.06]"
                aria-label={mustChoose ? 'Cancel and return to previous grid mode' : 'Close'}
                title={mustChoose ? 'Cancel — return to previous grid mode' : 'Close'}
              >
                ×
              </button>
            </Dialog.Close>
          </div>

          <div className="px-5 py-4 space-y-3">
            <p className="text-[12px] text-slate-300 leading-relaxed">
              Pinned beats sit on top of an underlying tempo grid. Which grid
              should that be for this song?
              {overrideCount > 0 && (
                <span className="block mt-1 text-[11px] text-amber-300/90">
                  ({overrideCount} pinned beat{overrideCount === 1 ? '' : 's'} already exist — they stay, but their drift relative to the base will change.)
                </span>
              )}
            </p>

            <div className="grid grid-cols-1 gap-2">
              <button
                type="button"
                onClick={() => onPick('static')}
                className={`text-left rounded-md border-2 px-3 py-2.5 transition-all ${
                  current === 'static'
                    ? 'border-slate-200 bg-slate-300/15 text-slate-100 ring-2 ring-slate-200/30'
                    : 'border-slate-600/40 bg-transparent text-slate-300 hover:border-slate-400/70 hover:bg-white/[0.04]'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-mono font-semibold uppercase tracking-wider">Steady</span>
                  <span className="text-[9px] font-mono uppercase text-slate-500">global tempo</span>
                </div>
                <div className="mt-1 text-[11px] text-slate-400 leading-snug">
                  Pinned beats sit on top of a single-tempo grid built from BPM
                  + grid offset.
                </div>
              </button>

              <button
                type="button"
                onClick={() => onPick('mapped')}
                disabled={segmentCount <= 1}
                title={segmentCount <= 1
                  ? 'This song has no tempo map yet — split the grid in Mapped mode first.'
                  : undefined}
                className={`text-left rounded-md border-2 px-3 py-2.5 transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                  current === 'mapped'
                    ? 'border-violet-200 bg-violet-400/15 text-violet-100 ring-2 ring-violet-300/30'
                    : 'border-violet-700/40 bg-transparent text-violet-300/90 enabled:hover:border-violet-500/70 enabled:hover:bg-violet-500/[0.06]'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-mono font-semibold uppercase tracking-wider">Mapped</span>
                  <span className="text-[9px] font-mono uppercase text-violet-500/70">
                    {segmentCount <= 1 ? 'no map yet' : `${segmentCount} grids`}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-violet-200/70 leading-snug">
                  Pinned beats sit on top of the song&apos;s tempo map, where each
                  marker restarts bar 1 with its own tempo and meter. Use this when
                  the song changes meter or the count restarts partway through.
                </div>
              </button>
            </div>

            {mustChoose && (
              <p className="text-[10px] text-amber-300/80 italic">
                Pick one to enter Hand-placed mode — or press <kbd className="px-1 py-0.5 rounded bg-white/[0.08] font-mono not-italic">Esc</kbd> / click ✕ to cancel and stay on your current grid mode.
              </p>
            )}
          </div>

          {!mustChoose && (
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/[0.06]">
              <button
                onClick={() => onCancel?.()}
                className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
