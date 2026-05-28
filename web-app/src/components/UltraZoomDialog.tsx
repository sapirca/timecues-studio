import * as Dialog from '@radix-ui/react-dialog';

export interface UltraZoomDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current extended cap (e.g. 31) shown to the user so they know what they're leaving. */
  extendedCap: number;
  /** The ultra cap they would unlock by approving. */
  ultraCap: number;
  /** User approved — enable ultra zoom. */
  onApprove: () => void;
  /** User declined. */
  onDismiss: () => void;
}

export function UltraZoomDialog({
  open,
  onOpenChange,
  extendedCap,
  ultraCap,
  onApprove,
  onDismiss,
}: UltraZoomDialogProps) {
  const handleApprove = () => onApprove();
  const handleDismiss = () => onDismiss();

  const fmt = (v: number) => `×${v < 10 ? v.toFixed(1) : Math.round(v)}`;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[101] w-[min(500px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-rose-500/30 bg-[#14171d] shadow-2xl shadow-black/70 outline-none"
          aria-describedby={undefined}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleApprove();
          }}
        >
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
            <Dialog.Title className="text-[12px] font-semibold tracking-[0.18em] uppercase text-rose-300">
              Allow ultra zoom?
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
              You've reached the maximum safe-buffer zoom ({fmt(extendedCap)}).
              The cap is set so the spectrogram-style canvases stay within
              the browser's max-canvas size.
            </p>
            <p className="text-[12px] text-slate-300 leading-relaxed">
              Allow zoom up to <span className="text-rose-200 font-semibold">{fmt(ultraCap)}</span>?
              Going further makes the <span className="text-slate-200">spectrogram, chromagram, cepstrogram, and 3-Band</span> canvases
              progressively <span className="text-rose-200">softer/blurrier</span> with zoom
              — their internal pixel buffer can no longer keep up with the CSS
              width, so each CSS pixel ends up covering less than one buffer
              pixel. The waveform, time grid, and playhead stay crisp.
            </p>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              There is no way around this in the browser — past the browser's
              max-canvas size, resolution must give. You can return to lower
              zoom at any time to recover full sharpness.
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
              className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-rose-500/25 hover:bg-rose-500/35 text-rose-100 border border-rose-400/50 transition-colors"
            >
              Allow ultra zoom
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
