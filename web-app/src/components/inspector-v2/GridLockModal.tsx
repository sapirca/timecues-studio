import { useState } from 'react';
import { createPortal } from 'react-dom';
import { formatClockTime } from '../../utils/clockTime';
import type { GridLockMove, GridLockSnapType } from '../../utils/gridLockSnap';

const SNAP_ROWS: { type: GridLockSnapType; label: string }[] = [
  { type: 'boundaries', label: 'Boundaries' },
  { type: 'loops', label: 'Loops' },
  { type: 'spans', label: 'Spans' },
  { type: 'riff-patterns', label: 'Riff patterns' },
];

/** Ticked when the dialog opens: the song's structure. Spans and riff
 *  patterns often sit off the grid on purpose, so they are opt-in. */
const DEFAULT_SNAP: GridLockSnapType[] = ['boundaries', 'loops'];

interface GridLockModalProps {
  /** Every item each type would move, from where to where — only the ones
   *  that actually move; an item already on the grid is not listed. */
  moves: Record<GridLockSnapType, GridLockMove[]>;
  /** The grid unit everything will be pulled onto, worded as the Grid selector
   *  words it ("1/3 beat · triplet"). Named here because it is the whole
   *  answer to "aligned to what?", and it is a toolbar away from this dialog. */
  unitLabel: string;
  /** Enable, and pull the existing items of the ticked types onto the grid. */
  onConfirm: (types: GridLockSnapType[]) => void;
  onCancel: () => void;
}

function signedMs(d: number): string {
  const ms = Math.round(d * 1000);
  return `${ms > 0 ? '+' : ms < 0 ? '−' : '±'}${Math.abs(ms)} ms`;
}

/** One edge of a move: "0:12.345 → 0:12.500  +155 ms". */
function EdgeMove({ name, from, to }: { name?: string; from: number; to: number }) {
  const still = Math.abs(to - from) < 5e-4;
  return (
    <div className={`flex gap-1.5 tabular-nums ${still ? 'text-slate-500' : ''}`}>
      {name && <span className="w-7 text-slate-500">{name}</span>}
      <span>{formatClockTime(from, 3)}</span>
      {still ? <span>stays</span> : (
        <>
          <span className="text-slate-500">→</span>
          <span className="text-amber-200">{formatClockTime(to, 3)}</span>
          <span className="ml-auto text-slate-500">{signedMs(to - from)}</span>
        </>
      )}
    </div>
  );
}

function MoveList({ moves }: { moves: GridLockMove[] }) {
  const lanes = new Set(moves.map((m) => m.lane)).size;
  return (
    <ul className="ml-5 mt-1 mb-1.5 max-h-44 overflow-y-auto rounded border border-white/[0.08] bg-black/30 divide-y divide-white/[0.05] text-[11px] font-mono">
      {moves.map((m) => (
        <li key={`${m.lane}/${m.id}`} className="px-2 py-1">
          <div className="truncate text-slate-300">
            {m.label || '—'}
            {lanes > 1 && <span className="text-slate-500"> · {m.lane}</span>}
          </div>
          {m.from.end === undefined ? (
            <EdgeMove from={m.from.start} to={m.to.start} />
          ) : (
            <>
              <EdgeMove name="start" from={m.from.start} to={m.to.start} />
              <EdgeMove name="end" from={m.from.end} to={m.to.end ?? m.from.end} />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Popup shown before enabling GRID LOCK. The annotator picks which layer
 *  types are pulled onto the grid, and can open each type to see every item
 *  that would move and where to. Everything else keeps its times. Nothing
 *  ticked is fine too — the lock then only governs what is placed from now on. */
export function GridLockModal({ moves, unitLabel, onConfirm, onCancel }: GridLockModalProps) {
  const [picked, setPicked] = useState<Set<GridLockSnapType>>(() => new Set(DEFAULT_SNAP));
  const [open, setOpen] = useState<Set<GridLockSnapType>>(() => new Set());
  const flip = (set: typeof setPicked, type: GridLockSnapType) => set((prev) => {
    const next = new Set(prev);
    if (next.has(type)) next.delete(type); else next.add(type);
    return next;
  });
  const total = SNAP_ROWS.reduce((sum, r) => sum + (picked.has(r.type) ? moves[r.type].length : 0), 0);

  return createPortal(
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/70"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="bg-[#14171d] border border-white/[0.18] rounded-xl shadow-2xl shadow-black/70 w-[420px] max-h-[90vh] overflow-y-auto p-6 flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <span className="text-amber-400 text-xl mt-0.5">⊞</span>
          <div>
            <h2 className="text-white font-semibold text-[15px] leading-snug">Enable Grid Lock?</h2>
            <p className="text-slate-400 text-[12px] mt-1 leading-relaxed">
              Grid Lock locks all snapping on. Tick what to align to the grid
              you have on screen — currently{' '}
              <span className="text-slate-200 font-mono">{unitLabel}</span>.
              Anything left unticked, cues and lyrics keep their times. Open
              a row to see what moves and where to.
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 space-y-0.5" data-testid="grid-lock-snap-picker">
          <p className="text-amber-200 text-[11px] font-semibold uppercase tracking-wider mb-1.5">
            Snap to the grid
          </p>
          {SNAP_ROWS.map((r) => {
            const list = moves[r.type];
            const n = list.length;
            const on = picked.has(r.type) && n > 0;
            const expanded = open.has(r.type) && n > 0;
            return (
              <div key={r.type}>
                <div className={`flex items-center gap-2 text-[12px] font-mono py-0.5 ${n ? '' : 'opacity-40'}`}>
                  <button
                    type="button"
                    disabled={n === 0}
                    onClick={() => flip(setOpen, r.type)}
                    aria-expanded={expanded}
                    aria-label={`${expanded ? 'Hide' : 'Show'} the ${r.label.toLowerCase()} that move`}
                    className="text-slate-400 hover:text-white disabled:hover:text-slate-400 p-0.5 -m-0.5"
                  >
                    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden
                      className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}>
                      <path d="M4 2.5 L9 6 L4 9.5 Z" fill="currentColor" />
                    </svg>
                  </button>
                  <label className={`flex flex-1 items-center gap-2 ${n ? 'cursor-pointer' : 'cursor-default'}`}>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={n === 0}
                      onChange={() => flip(setPicked, r.type)}
                      className="accent-amber-400 w-3.5 h-3.5"
                    />
                    <span className={on ? 'text-slate-200' : 'text-slate-400'}>{r.label}</span>
                    <span className={`ml-auto ${on ? 'text-amber-300' : 'text-slate-500'}`}>
                      {n ? `${n} to move` : 'nothing to move'}
                    </span>
                  </label>
                </div>
                {expanded && <MoveList moves={list} />}
              </div>
            );
          })}
          <div className="border-t border-amber-500/20 mt-2 pt-2 flex justify-between text-[12px] font-mono font-semibold">
            <span className="text-slate-200">Will move</span>
            <span className="text-amber-200">{total}</span>
          </div>
        </div>

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
            onClick={() => onConfirm(SNAP_ROWS.map((r) => r.type).filter((t) => picked.has(t) && moves[t].length > 0))}
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
