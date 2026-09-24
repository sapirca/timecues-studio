/**
 * LoopPlayIcon — the "play this interval, seamlessly repeating" affordance.
 *
 * Deliberately NOT a circular arrow: a lone ↻ / ⟳ reads as "refresh" or
 * "re-run" everywhere else in this UI (Re-run detectors, Re-derive anchors,
 * Reload songs), so users hit it expecting a recompute. This is the media
 * "repeat" bracket with a play triangle inside it — the transport vocabulary
 * for looped playback, and unambiguous next to the ✕ / ★ / ⏹ glyphs it sits with.
 */

interface Props {
  size?: number;
  strokeWidth?: number;
  className?: string;
  title?: string;
}

export function LoopPlayIcon({ size = 14, strokeWidth = 2, className, title }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      {/* Upper track, wrapping right and turning back at the top-right. */}
      <path d="M16.5 2.5 20.5 6.5 16.5 10.5" />
      <path d="M3.5 11.5V10a3.5 3.5 0 0 1 3.5-3.5h13.5" />
      {/* Lower track, wrapping left and turning back at the bottom-left. */}
      <path d="M7.5 21.5 3.5 17.5 7.5 13.5" />
      <path d="M20.5 12.5V14a3.5 3.5 0 0 1-3.5 3.5H3.5" />
      {/* Play triangle in the middle — this is playback, not a recompute. */}
      <path d="M10 9.2 15 12 10 14.8Z" fill="currentColor" stroke="none" />
    </svg>
  );
}
