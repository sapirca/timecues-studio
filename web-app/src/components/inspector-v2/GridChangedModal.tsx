import { useState } from 'react';
import { createPortal } from 'react-dom';

interface GridChangedModalProps {
  /** How many annotations sit at a different time under the new grid. */
  affected: number;
  /** Plain-language summary of what about the grid changed ("BPM 120 → 128"). */
  changeSummary: string;
  /** Move every annotation so it keeps the bar.beat it was placed on.
   *  `remember` is true when the annotator asked for this answer to be reused. */
  onKeepBeats: (remember: boolean) => void;
  /** Leave every annotation at the second it was placed at, untouched. */
  onKeepTimes: (remember: boolean) => void;
  /** Put the grid back the way it was and move nothing — the escape hatch for
   *  an edit the annotator regrets (a mis-clicked ×2, a stray offset drag). */
  onDiscard: () => void;
  /** What reverting restores, e.g. "back to 64.75 BPM" — shown on the
   *  discard button so it's clear what "cancel" means here. */
  revertSummary: string;
}

/** Shown when the beat grid moves while Grid Lock is on.
 *
 *  A grid edit makes the two readings of an annotation disagree: the instant
 *  it was placed at, and the musical position it marks. Only the annotator
 *  knows which one they meant — a kick they tapped belongs to its instant, a
 *  downbeat they placed belongs to its beat — so this asks instead of guessing.
 *
 *  "Remember my preference" is opt-in and covers only the two keep answers: an
 *  annotator who always means the same thing shouldn't be asked on every drag.
 *  Silently re-timing a corpus is not recoverable, so a remembered answer still
 *  raises the undo toast, and that toast carries "Ask me next time" — the
 *  preference is never more than one click from being off again. "Undo the grid
 *  change" is deliberately not rememberable: an always-undo would make the grid
 *  uneditable.
 *
 *  Only ONE of the two keep answers snaps, and the buttons say so, because the
 *  difference between them is exactly that and nothing about the wording used
 *  to give it away. "Keep their bars & beats" re-times every marker onto the
 *  new grid. "Keep their milliseconds" does not snap at all: every time stays
 *  as it is, the bar.beat companions are dropped, and Grid Lock comes off —
 *  the lock means the beat is the marker's real position, which is the
 *  opposite of what this answer says. It used to round the times onto the
 *  nearest new line, which is not keeping them: a grid edit that only added
 *  lines still nudged marks that were already exactly right, and a mark is a
 *  claim about the sound, which a grid edit does not move. */
export function GridChangedModal({
  affected, changeSummary, onKeepBeats, onKeepTimes, onDiscard, revertSummary,
}: GridChangedModalProps) {
  const [remember, setRemember] = useState(false);
  return createPortal(
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/70"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onDiscard(); }}
    >
      <div className="bg-[#14171d] border border-white/[0.18] rounded-xl shadow-2xl shadow-black/70 w-[400px] p-6 flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <span className="text-cyan-300 text-xl mt-0.5">⊞</span>
          <div>
            <h2 className="text-white font-semibold text-[15px] leading-snug">The grid moved</h2>
            <p className="text-slate-400 text-[12px] mt-1 leading-relaxed">
              {changeSummary}. Grid Lock is on, so{' '}
              <span className="text-slate-200 font-mono">{affected}</span>{' '}
              annotation{affected === 1 ? '' : 's'} now sit{affected === 1 ? 's' : ''} at a
              different bar.beat than before. What should they keep?
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => onKeepBeats(remember)}
            className="w-full px-4 py-2.5 rounded text-[12px] font-mono font-semibold bg-cyan-500/15 border border-cyan-500/60 text-cyan-200 hover:bg-cyan-500/25 hover:border-cyan-400 transition-colors text-left"
          >
            Keep their bars &amp; beats
            <span className="block font-normal text-[11px] text-cyan-200/60 mt-0.5">
              <span className="text-cyan-200/90">Snaps.</span> Every marker moves
              to the beat it was placed on, so its milliseconds change
            </span>
          </button>
          <button
            type="button"
            onClick={() => onKeepTimes(remember)}
            className="w-full px-4 py-2.5 rounded text-[12px] font-mono border border-white/[0.14] bg-transparent text-slate-300 hover:text-white hover:border-white/30 transition-colors text-left"
          >
            Keep their milliseconds
            <span className="block text-[11px] text-slate-500 mt-0.5">
              <span className="text-slate-300">Does not snap.</span> Every marker
              keeps its exact time and drops its bar.beat; Grid Lock comes off
            </span>
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="w-full px-4 py-2.5 rounded text-[12px] font-mono border border-white/[0.14] bg-transparent text-slate-400 hover:text-white hover:border-white/30 transition-colors text-left"
          >
            Undo the grid change
            <span className="block text-[11px] text-slate-500 mt-0.5">
              {revertSummary} — no annotation moves
            </span>
          </button>
        </div>

        <label className="flex items-start gap-2 cursor-pointer select-none group">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="mt-0.5 accent-cyan-500 cursor-pointer"
          />
          <span className="text-[11px] leading-relaxed">
            <span className="text-slate-300 font-mono group-hover:text-white transition-colors">
              Remember my preference
            </span>
            <span className="block text-slate-500">
              Applies the answer you pick above to future grid edits without asking.
              Undo the grid change is never remembered, and you can switch back to
              asking from the toast.
            </span>
          </span>
        </label>

        <p className="text-slate-500 text-[11px]">
          The first two keep the grid edit. Only the first one snaps: it re-times
          your marks onto the new grid. The second leaves every time untouched
          and stops holding the song to the grid at all. Both are undoable right
          after you choose — the undo puts Grid Lock back too. The third throws
          the edit away.
        </p>
      </div>
    </div>,
    document.body,
  );
}
