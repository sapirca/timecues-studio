// Butler's way of writing a loop down (Unlocking the Groove, p. 180): the
// shortest repeating pattern between a pair of repeat signs, plus how long
// one turn of it lasts. A riff node already IS that shortest pattern; these
// pieces only say so on screen — the length in plain words ("1 bar",
// "½ bar", "1½ beats") and the repeat signs that mark the cycle as a loop
// rather than a bar.

import type { ReactNode } from 'react';
import { loopLengthWords } from '../../utils/loopLength';

/** "1 bar", "½ bar", "1½ beats" — one turn of the loop in plain words. */
export function LoopLength({ beats, beatsPerBar = 4, className = '' }: { beats: number; beatsPerBar?: number; className?: string }) {
  const words = loopLengthWords(beats, beatsPerBar);
  if (!words) return null;
  return (
    <span className={`whitespace-nowrap ${className}`} title={`One turn of the loop lasts ${words}`}>
      {words}
    </span>
  );
}

/** A repeat sign drawn the way a score draws it: thick bar, thin bar and two
 *  dots facing into the repeated material. Built from boxes so it stretches
 *  to any height without squashing the dots. */
export function RepeatSign({ side, color = 'currentColor', dot = 3 }: { side: 'start' | 'end'; color?: string; dot?: number }) {
  const thick = <span className="self-stretch flex-shrink-0" style={{ width: 2.5, backgroundColor: color }} />;
  const thin = <span className="self-stretch flex-shrink-0" style={{ width: 1, backgroundColor: color }} />;
  const dots = (
    <span className="flex flex-col justify-center flex-shrink-0" style={{ gap: dot }}>
      <span className="rounded-full" style={{ width: dot, height: dot, backgroundColor: color }} />
      <span className="rounded-full" style={{ width: dot, height: dot, backgroundColor: color }} />
    </span>
  );
  return (
    <span className="flex items-stretch flex-shrink-0 pointer-events-none" style={{ gap: 1.5 }} aria-hidden="true">
      {side === 'start' ? <>{thick}{thin}{dots}</> : <>{dots}{thin}{thick}</>}
    </span>
  );
}

/** Wraps one cycle in repeat signs: "this is the loop, it comes around".
 *  `fill` stretches it across its container — for content that has no width
 *  of its own to shrink-wrap, like a piano roll laid out in percentages. */
export function RepeatBracket({ color, fill = false, children }: { color?: string; fill?: boolean; children: ReactNode }) {
  return (
    // Shrink-wraps the cycle so the closing sign lands right after its last
    // step, the way a score closes the bar — not out at the panel's edge.
    <div className={`${fill ? 'flex w-full' : 'inline-flex max-w-full'} items-stretch gap-1.5`} title="One turn of the loop — it repeats between these signs">
      <RepeatSign side="start" color={color} />
      <div className={fill ? 'min-w-0 flex-1' : 'min-w-0'}>{children}</div>
      <RepeatSign side="end" color={color} />
    </div>
  );
}
