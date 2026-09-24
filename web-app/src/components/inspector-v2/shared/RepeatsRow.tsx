/**
 * The "Repeats → ends …" row shared by the Pattern and Riff Pattern edit
 * cards — the two kinds that tile one cycle N times.
 *
 * Both had their own copy; the riff one had since grown a draft-text fix the
 * pattern one never got, so they had actually drifted in behaviour. Editing
 * `repeatCount` through a controlled input bound straight to the committed
 * number snaps the field back to "1" the instant it's cleared
 * (`Number('') || 1`), which makes select-all-and-retype impossible. So the
 * text is held as a draft here: typing only reaches the document once it
 * parses to a whole 1–256, and an in-progress invalid value just shows red
 * and reports `valid: false` (the card wires that to `doneDisabled`) without
 * ever being written anywhere.
 */

import { useState, type ReactNode } from 'react';

export const MIN_REPEATS = 1;
export const MAX_REPEATS = 256;

export interface RepeatsDraft {
  text: string;
  set: (raw: string) => void;
  valid: boolean;
  /** Why the current text is invalid, or null while it's fine. */
  error: string | null;
}

function parse(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_REPEATS || n > MAX_REPEATS) return null;
  return n;
}

/** Draft state for a repeat count. `commit` fires only on valid values. */
export function useRepeatsDraft(committed: number, commit: (n: number) => void): RepeatsDraft {
  const [text, setText] = useState(String(committed));

  // Re-seed when the committed value changes from anywhere BUT this input —
  // an undo, or the card being pointed at a different item without
  // unmounting. Adjusted during render rather than in an effect (React's
  // "derive state while rendering" pattern) so no cascading second pass runs.
  // `seen` is bumped by `set` as well, so our own commits don't come back
  // round and renormalise what's being typed ("05" would snap to "5"
  // mid-keystroke).
  const [seen, setSeen] = useState(committed);
  if (committed !== seen) {
    setSeen(committed);
    setText(String(committed));
  }

  const parsed = parse(text);
  return {
    text,
    valid: parsed !== null,
    error: parsed !== null ? null
      : text.trim() === '' ? "can't be empty"
      : `must be a whole number ${MIN_REPEATS}–${MAX_REPEATS}`,
    set: (raw) => {
      setText(raw);
      const n = parse(raw);
      if (n !== null) { setSeen(n); commit(n); }
    },
  };
}

export function RepeatsRow({
  draft, focusRing, readOnly = false, trailing,
}: {
  draft: RepeatsDraft;
  /** The card kind's `focus:ring-*` class — see `cardTheme()`. */
  focusRing: string;
  readOnly?: boolean;
  /** Read-out shown beside the spinner while the value is valid (region end,
   *  cycle length…). Replaced by the validation error when it isn't. */
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-300">
        <span>Repeats</span>
        <input
          type="number"
          min={MIN_REPEATS}
          max={MAX_REPEATS}
          value={draft.text}
          disabled={readOnly}
          onChange={(e) => draft.set(e.target.value)}
          className={`w-16 bg-[#0a0b0d] border rounded px-1 py-0.5 text-[12px] text-slate-100 focus:outline-none focus:ring-1 ${
            draft.valid ? `border-white/[0.06] ${focusRing}` : 'border-red-500/60 focus:ring-red-400/50'
          } ${readOnly ? 'cursor-not-allowed opacity-70' : ''}`}
        />
      </label>
      {draft.valid
        ? trailing
        : <span className="text-[10px] text-red-400">{draft.error}</span>}
    </div>
  );
}
