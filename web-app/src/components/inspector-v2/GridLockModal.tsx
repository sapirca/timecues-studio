import { createPortal } from 'react-dom';

interface SnapCount {
  boundaries: number;
  cues: number;
  spans: number;
  loops: number;
  riffPatterns: number;
}

interface GridLockModalProps {
  snapCount: SnapCount;
  /** The grid unit everything will be pulled onto, worded as the Grid selector
   *  words it ("1/3 beat · triplet"). Named here because it is the whole
   *  answer to "aligned to what?", and it is a toolbar away from this dialog. */
  unitLabel: string;
  /** Enable, and pull every existing annotation onto the grid. */
  onConfirm: () => void;
  onCancel: () => void;
}

/** Warning popup shown before enabling GRID LOCK. Grid Lock means the song IS
 *  on the grid, so enabling always aligns what is already there — the choice
 *  is whether to enable at all. Lists how many annotations will move. */
export function GridLockModal({ snapCount, unitLabel, onConfirm, onCancel }: GridLockModalProps) {
  const rows: { label: string; n: number }[] = [
    { label: 'Boundaries', n: snapCount.boundaries },
    { label: 'Cues', n: snapCount.cues },
    { label: 'Spans', n: snapCount.spans },
    { label: 'Loops', n: snapCount.loops },
    { label: 'Riff patterns', n: snapCount.riffPatterns },
  ];
  const total = rows.reduce((sum, r) => sum + r.n, 0);
  const shown = rows.filter((r) => r.n > 0);

  return createPortal(
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/70"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="bg-[#14171d] border border-white/[0.18] rounded-xl shadow-2xl shadow-black/70 w-[360px] p-6 flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <span className="text-amber-400 text-xl mt-0.5">⊞</span>
          <div>
            <h2 className="text-white font-semibold text-[15px] leading-snug">Enable Grid Lock?</h2>
            <p className="text-slate-400 text-[12px] mt-1 leading-relaxed">
              Grid Lock locks all snapping on and aligns every existing
              annotation to the grid you have on screen — currently{' '}
              <span className="text-slate-200 font-mono">{unitLabel}</span>.
              Lyrics are left untouched.
            </p>
          </div>
        </div>

        {total > 0 && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 space-y-1">
            <p className="text-amber-200 text-[11px] font-semibold uppercase tracking-wider mb-1.5">
              Will be re-snapped
            </p>
            {shown.map((r) => (
              <div key={r.label} className="flex justify-between text-[12px] font-mono">
                <span className="text-slate-300">{r.label}</span>
                <span className="text-amber-300">{r.n} item{r.n !== 1 ? 's' : ''}</span>
              </div>
            ))}
            <div className="border-t border-amber-500/20 mt-2 pt-2 flex justify-between text-[12px] font-mono font-semibold">
              <span className="text-slate-200">Total</span>
              <span className="text-amber-200">{total}</span>
            </div>
          </div>
        )}

        {total === 0 && (
          <p className="text-slate-500 text-[12px] italic">
            Every annotation is already on the grid — nothing will move.
          </p>
        )}

        <p className="text-slate-500 text-[11px]">
          You can undo immediately after enabling. Times already on the grid
          won't move.
        </p>

        <div className="flex gap-2 justify-end mt-1">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded text-[12px] font-mono border border-white/[0.14] bg-transparent text-slate-300 hover:text-white hover:border-white/30 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-5 py-2 rounded text-[12px] font-mono font-semibold bg-amber-500/20 border border-amber-500/60 text-amber-200 hover:bg-amber-500/30 hover:border-amber-400 transition-colors"
          >
            Enable Grid Lock
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface NoBpmModalProps {
  onClose: () => void;
}

/** Shown when the user tries to enable Grid Lock but the song has no BPM. */
export function NoBpmModal({ onClose }: NoBpmModalProps) {
  return createPortal(
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/70"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-[#14171d] border border-white/[0.18] rounded-xl shadow-2xl shadow-black/70 w-[340px] p-6 flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <span className="text-rose-400 text-xl mt-0.5">⚠</span>
          <div>
            <h2 className="text-white font-semibold text-[15px] leading-snug">No BPM set</h2>
            <p className="text-slate-400 text-[12px] mt-1 leading-relaxed">
              Grid Lock needs a beat grid. Set the BPM for this song first
              (use the Grid Editor in the Beat Grid tab), then try again.
            </p>
          </div>
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded text-[12px] font-mono border border-white/[0.14] bg-transparent text-slate-300 hover:text-white hover:border-white/30 transition-colors"
          >
            OK
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
