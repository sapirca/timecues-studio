/**
 * The playhead's leaf components — the pieces that follow the clock on their
 * own so nothing above them re-renders. The clock and its hooks are in
 * hooks/usePlayhead.
 */

import { type CSSProperties, type ReactNode } from 'react';
import { fillPlayheadSlot, usePlayheadTransform, usePlayheadValue } from '../hooks/usePlayhead';

/**
 * A vertical cursor line at the playhead, positioned as a percentage of
 * `duration` across its (relatively positioned) parent. Moves itself; its
 * parent does not re-render for it.
 */
export function PlayheadLine({ duration, className = 'absolute top-0 bottom-0 w-px pointer-events-none', style }: {
  duration: number;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = usePlayheadTransform<HTMLDivElement>(duration);
  return <div ref={ref} className={className} style={style} />;
}

/**
 * Renders `children(inside)`, where `inside` is whether the playhead sits in
 * [start, end) while `active`. For a parent that cannot call hooks at the
 * spot it needs the flag (an inline render branch): only this wrapper
 * re-renders, and only as the playhead crosses an edge.
 */
export function PlayheadWithin({ start, end, active = true, children }: {
  start: number;
  end: number;
  active?: boolean;
  children: (inside: boolean) => ReactNode;
}) {
  const inside = usePlayheadValue((t) => active && t >= start && t < end);
  return <>{children(inside)}</>;
}

/** Label text with any PLAYHEAD_SLOT filled from the live clock. Re-renders
 *  itself when the shown time changes; its parent never does. */
export function LiveLabel({ text }: { text: string }) {
  const shown = usePlayheadValue((t) => fillPlayheadSlot(text, t));
  return <>{shown}</>;
}
