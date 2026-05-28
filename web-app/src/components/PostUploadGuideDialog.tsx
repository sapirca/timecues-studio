import * as Dialog from '@radix-ui/react-dialog';

export interface PostUploadGuideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Name of the song uploaded; when `count > 1`, used only as a fallback label. */
  songName: string;
  /** How many songs were just uploaded; the body switches to a count when > 1. */
  count: number;
  /** Switch to the Annotator Tool workspace (`/annotate`). */
  onOpenAnnotator: () => void;
}

export function PostUploadGuideDialog({
  open,
  onOpenChange,
  songName,
  count,
  onOpenAnnotator,
}: PostUploadGuideDialogProps) {
  const headline =
    count > 1
      ? `${count} songs uploaded`
      : songName;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[101] w-[min(480px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-emerald-500/40 bg-[#14171d] shadow-2xl shadow-black/70 outline-none"
          aria-describedby={undefined}
        >
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
            <Dialog.Title className="text-[12px] font-semibold tracking-[0.18em] uppercase text-emerald-300">
              Upload complete
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
              <span className="font-medium text-slate-100">{headline}</span>{' '}
              {count > 1 ? 'are' : 'is'} ready.
            </p>
            <ol className="text-[12px] text-slate-400 leading-relaxed space-y-1.5 list-decimal pl-4">
              <li>
                Set the BPM here in{' '}
                <span className="text-emerald-300">Dataprep</span> — boundaries
                snap to the grid, so the BPM must be right first.
              </li>
              <li>
                Then switch to the{' '}
                <span className="text-cyan-300">Annotator Tool</span> to begin
                marking sections.
              </li>
            </ol>
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/[0.06]">
            <button
              onClick={() => {
                onOpenAnnotator();
                onOpenChange(false);
              }}
              className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 transition-colors"
            >
              Open Annotator Tool
            </button>
            <Dialog.Close asChild>
              <button className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-emerald-500/25 hover:bg-emerald-500/35 text-emerald-100 border border-emerald-400/50 transition-colors">
                Stay in Dataprep
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
