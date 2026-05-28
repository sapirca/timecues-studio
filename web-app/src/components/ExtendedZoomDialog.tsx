import * as Dialog from '@radix-ui/react-dialog';

export interface ExtendedZoomDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current standard cap (e.g. 15) shown to the user so they know what they're leaving. */
  standardCap: number;
  /** The extended cap they would unlock by approving. */
  extendedCap: number;
  /** User approved — enable extended zoom. */
  onApprove: () => void;
  /** User declined. */
  onDismiss: () => void;
}

export function ExtendedZoomDialog({
  open,
  onOpenChange,
  standardCap,
  extendedCap,
  onApprove,
  onDismiss,
}: ExtendedZoomDialogProps) {
  const handleApprove = () => onApprove();
  const handleDismiss = () => onDismiss();

  const fmt = (v: number) => `×${v < 10 ? v.toFixed(1) : Math.round(v)}`;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[101] w-[min(480px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-amber-500/30 bg-[#14171d] shadow-2xl shadow-black/70 outline-none"
          aria-describedby={undefined}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleApprove();
          }}
        >
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
            <Dialog.Title className="text-[12px] font-semibold tracking-[0.18em] uppercase text-amber-300">
              Allow extended zoom?
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="text-slate-500 hover:text-slate-200 text-lg leading-none w-6 h-6 flex items-center justify-center rounded hover:bg-white/[0.06]"
                aria-label="Close"
              >
                ×
              </button>
            </Dialog.Close>
          </div>

          <div className="px-5 py-4 space-y-3">
            <p className="text-[12px] text-slate-300 leading-relaxed">
              You've reached the maximum sharp-pixel zoom for this display
              ({fmt(standardCap)}). The cap is set so the spectrogram canvas
              stays within the browser's safe size.
            </p>
            <p className="text-[12px] text-slate-300 leading-relaxed">
              Allow zoom up to <span className="text-amber-200 font-semibold">{fmt(extendedCap)}</span>?
              Going further drops the spectrogram, chromagram, and cepstrogram
              canvases to <span className="font-mono">dpr=1</span>, so their
              overlays (frequency labels, beat grid, playhead) will appear
              softer on HiDPI screens. The underlying spectrogram colors are
              unaffected.
            </p>

          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/[0.06]">
            <button
              onClick={handleDismiss}
              className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 transition-colors"
            >
              Keep current limit
            </button>
            <button
              onClick={handleApprove}
              autoFocus
              className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-amber-500/25 hover:bg-amber-500/35 text-amber-100 border border-amber-400/50 transition-colors"
            >
              Allow more zoom
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
