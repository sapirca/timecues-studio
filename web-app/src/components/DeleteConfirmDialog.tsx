import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

export interface DeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Word the user must type to enable the confirm button. Defaults to "DELETE". */
  confirmWord?: string;
  onConfirm: () => void | Promise<void>;
}

export function DeleteConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmWord = 'DELETE',
  onConfirm,
}: DeleteConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setTyped('');
      setBusy(false);
    }
  }, [open]);

  const matches = typed === confirmWord;

  const handleConfirm = async () => {
    if (!matches || busy) return;
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[101] w-[min(440px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-red-500/30 bg-[#14171d] shadow-2xl shadow-black/70 outline-none"
          aria-describedby={undefined}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches) handleConfirm();
          }}
        >
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
            <Dialog.Title className="text-[12px] font-semibold tracking-[0.18em] uppercase text-red-300">
              {title}
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
            {description && (
              <p className="text-[12px] text-slate-300 leading-relaxed">{description}</p>
            )}
            <p className="text-[11px] text-slate-400">
              Type <span className="font-mono text-red-300">{confirmWord}</span> to confirm.
            </p>
            <input
              autoFocus
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={confirmWord}
              className="w-full px-3 py-2 rounded bg-black/40 border border-white/[0.08] text-[13px] font-mono text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-red-400/50 focus:ring-1 focus:ring-red-500/30"
            />
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/[0.06]">
            <Dialog.Close asChild>
              <button className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 transition-colors">
                Cancel
              </button>
            </Dialog.Close>
            <button
              onClick={handleConfirm}
              disabled={!matches || busy}
              className={`px-3 py-1.5 rounded text-[11px] uppercase tracking-wider transition-colors ${
                matches && !busy
                  ? 'bg-red-500/25 hover:bg-red-500/35 text-red-100 border border-red-400/50'
                  : 'bg-white/[0.04] text-slate-600 border border-white/[0.06] cursor-not-allowed'
              }`}
            >
              {busy ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
