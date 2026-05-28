// Modal that asks the curator which base grid Manual adjustment should
// ride on top of. Opens on first entry into Manual mode (when
// `songInfo.manualBaseGridMode` is undefined) and can be re-opened from
// the GridModeControls "Change base…" button.
//
// Static = global BPM + offset; existing tempoAnchors are ignored while
// in Manual mode (the data is preserved, just not applied).
// Dynamic = tempoAnchors are applied as the underlying tempo curve;
// pinned beats sit on top of that piecewise tempo.

import * as Dialog from '@radix-ui/react-dialog';
import type { ManualBaseGridMode } from '../../types/songInfo';

export interface ManualBasePickerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current selection — undefined when first entering Manual mode and
   *  the modal is forced open by the absence of a choice. */
  current?: ManualBaseGridMode;
  /** Anchor count, shown so the curator sees what "Dynamic" would carry. */
  anchorCount: number;
  /** Pinned beat count, shown so the curator knows their micro edits
   *  survive a base switch (they ride on top of either base). */
  overrideCount: number;
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
  anchorCount,
  overrideCount,
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
              Manual adjustment — pick base grid
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
                  <span className="text-[11px] font-mono font-semibold uppercase tracking-wider">Static BPM</span>
                  <span className="text-[9px] font-mono uppercase text-slate-500">global tempo</span>
                </div>
                <div className="mt-1 text-[11px] text-slate-400 leading-snug">
                  Pinned beats sit on top of a single-tempo grid built from BPM
                  + grid offset. The {anchorCount} existing anchor{anchorCount === 1 ? '' : 's'} {anchorCount === 0 ? 'are' : 'is'} preserved on disk but ignored while you're in Manual mode.
                </div>
              </button>

              <button
                type="button"
                onClick={() => onPick('dynamic')}
                className={`text-left rounded-md border-2 px-3 py-2.5 transition-all ${
                  current === 'dynamic'
                    ? 'border-cyan-200 bg-cyan-400/15 text-cyan-100 ring-2 ring-cyan-300/30'
                    : 'border-cyan-700/40 bg-transparent text-cyan-300/90 hover:border-cyan-500/70 hover:bg-cyan-500/[0.06]'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-mono font-semibold uppercase tracking-wider">Dynamic</span>
                  <span className="text-[9px] font-mono uppercase text-cyan-500/70">{anchorCount} anchor{anchorCount === 1 ? '' : 's'}</span>
                </div>
                <div className="mt-1 text-[11px] text-cyan-200/70 leading-snug">
                  Pinned beats sit on top of the piecewise tempo curve defined by
                  the anchors. Use this when the song speeds up or slows down and
                  you want the underlying grid to follow.
                </div>
              </button>
            </div>

            {mustChoose && (
              <p className="text-[10px] text-amber-300/80 italic">
                Pick one to enter Manual adjustment — or press <kbd className="px-1 py-0.5 rounded bg-white/[0.08] font-mono not-italic">Esc</kbd> / click ✕ to cancel and stay on your current grid mode.
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
