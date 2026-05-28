import * as Dialog from '@radix-ui/react-dialog';

export interface BpmWarningDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  songName: string;
  /** Proceed with annotation despite the missing BPM. */
  onContinue: () => void;
  /** Switch to Dataset Prep so the annotator can set BPM first. */
  onGoToPrep: () => void;
}

export function BpmWarningDialog({
  open,
  onOpenChange,
  songName,
  onContinue,
  onGoToPrep,
}: BpmWarningDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[101] w-[min(480px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-amber-500/40 bg-[#14171d] shadow-2xl shadow-black/70 outline-none"
          aria-describedby={undefined}
        >
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
            <Dialog.Title className="text-[12px] font-semibold tracking-[0.18em] uppercase text-amber-300">
              BPM not set
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
            <p className="text-[13px] text-slate-200 leading-relaxed">
              <span className="font-medium text-slate-100">{songName}</span> has
              no BPM set yet.
            </p>
            <p className="text-[12px] text-slate-400 leading-relaxed">
              Boundaries snap to the grid, so annotating without a BPM means
              every section will land off-beat. Set BPM in{' '}
              <span className="text-emerald-300">Dataset Prep</span> first — try
              auto-detect, or tap along with the metronome.
            </p>
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/[0.06]">
            <Dialog.Close asChild>
              <button className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 transition-colors">
                Cancel
              </button>
            </Dialog.Close>
            <button
              onClick={() => {
                onContinue();
                onOpenChange(false);
              }}
              className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 transition-colors"
              title="Annotate without a grid — boundaries will not snap to beats."
            >
              Annotate anyway
            </button>
            <button
              onClick={() => {
                onGoToPrep();
                onOpenChange(false);
              }}
              className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-emerald-500/25 hover:bg-emerald-500/35 text-emerald-100 border border-emerald-400/50 transition-colors"
            >
              Set BPM in Dataset Prep
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
