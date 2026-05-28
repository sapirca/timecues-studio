/**
 * Small ✓/✗ button pair used to accept/reject detector-emitted items on the
 * timeline. Designed to be absolutely positioned over each item (cue tick,
 * span band, loop bar, pattern bar) by the host row component.
 *
 * Behavior matches the auto-guess overlay buttons in AnnotationOverlays.tsx:
 * clicking ✓ when already accepted reverts to pending; same for ✗. Uses
 * onMouseDown + stopPropagation so the host's click/drag handlers don't fire.
 */
import type { CSSProperties, MouseEvent } from 'react';

export type ReviewStatus = 'accepted' | 'rejected';

interface ReviewControlsProps {
  status: ReviewStatus | undefined;
  onAccept: () => void;
  onReject: () => void;
  /** Container positioning. The host decides where these buttons sit. */
  style?: CSSProperties;
  /** Optional tweak for compact rows. */
  size?: number;
  className?: string;
}

export function ReviewControls({ status, onAccept, onReject, style, size = 14, className }: ReviewControlsProps) {
  const stop = (e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); };
  return (
    <div
      className={`flex items-center gap-px pointer-events-auto ${className ?? ''}`}
      style={style}
      onClick={stop}
      onMouseDown={stop}
    >
      <button
        type="button"
        onClick={(e) => { stop(e); onAccept(); }}
        onMouseDown={stop}
        className={`rounded flex items-center justify-center font-bold transition-colors ${
          status === 'accepted'
            ? 'bg-teal-600 text-white'
            : 'bg-gray-900/85 border border-gray-600 text-gray-300 hover:bg-teal-700/60 hover:text-teal-200'
        }`}
        style={{ width: size, height: size, fontSize: Math.max(8, size - 6) }}
        title={status === 'accepted' ? 'Revert to pending' : 'Accept'}
      >✓</button>
      <button
        type="button"
        onClick={(e) => { stop(e); onReject(); }}
        onMouseDown={stop}
        className={`rounded flex items-center justify-center font-bold transition-colors ${
          status === 'rejected'
            ? 'bg-red-700 text-white'
            : 'bg-gray-900/85 border border-gray-600 text-gray-300 hover:bg-red-800/60 hover:text-red-200'
        }`}
        style={{ width: size, height: size, fontSize: Math.max(8, size - 6) }}
        title={status === 'rejected' ? 'Revert to pending' : 'Reject'}
      >✗</button>
    </div>
  );
}

/** Status-color helpers shared by all four row components, so accepted/rejected
 *  items get a consistent tint. Returns CSS color strings, never undefined. */
export function reviewBgFor(layerColor: string, status: ReviewStatus | undefined): string {
  if (status === 'accepted') return '#14b8a6';
  if (status === 'rejected') return '#7f1d1d';
  return layerColor;
}

export function reviewOpacityFor(status: ReviewStatus | undefined): number {
  if (status === 'rejected') return 0.35;
  return 1;
}
