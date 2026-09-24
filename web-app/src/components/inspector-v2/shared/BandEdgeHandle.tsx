import type { PressEvent } from '../../../hooks/useTimelineDrag';
import { EDGE_HANDLE_MAX_SHARE } from './bandGeometry';

/**
 * The start or end grip of an interval band (Loops, Spans).
 *
 * A fingertip needs a wider target than the 6–8px a mouse is happy with, but
 * the grip lives inside its band, and the band is `overflow-hidden` — so the
 * shared `.tc-hit` (an invisible ::before 10px past each side) could only ever
 * widen it INWARD: the outward half is clipped away. On a band under ~36px the
 * two inward reaches met in the middle and the whole body answered as an edge,
 * so on a phone a short loop could be stretched but never moved.
 *
 * So on a coarse pointer the grip itself widens instead, to 18px — the reach
 * `.tc-hit` used to give a wide band — while the same `EDGE_HANDLE_MAX_SHARE`
 * cap that already protects narrow bands from a mouse keeps each grip to 30%
 * of the band. At least 40% of the body is always left to grab. The visible
 * wash stays at its desktop width inside the wider grip, so the band looks the
 * same on both; on a mouse nothing about the grip changes at all.
 *
 * Why not reach outward, past the band? It would have to leave the clipped
 * band to do it, and then the end grip of one loop would lie over the first
 * 10px of the next one's body — loops are routinely back to back, so it would
 * steal from the neighbour what it stopped stealing from its own band.
 */
export function BandEdgeHandle({
  edge, widthClass, label, onPointerDown,
}: {
  edge: 'start' | 'end';
  /** The grip's width on a fine pointer, as a literal Tailwind class
   *  (`w-2`, `w-1.5`) so the scanner sees it. */
  widthClass: string;
  label: string;
  onPointerDown: (e: PressEvent) => void;
}) {
  const side = edge === 'start' ? 'left-0' : 'right-0';
  return (
    <span
      role="separator"
      aria-label={label}
      className={`absolute top-0 bottom-0 ${side} ${widthClass} pointer-coarse:w-[18px] z-20 cursor-ew-resize touch-none`}
      style={{ maxWidth: EDGE_HANDLE_MAX_SHARE }}
      onPointerDown={onPointerDown}
      onClick={(e) => e.stopPropagation()}
    >
      <span
        aria-hidden="true"
        className={`absolute top-0 bottom-0 ${side} ${widthClass} max-w-full pointer-events-none`}
        style={{ background: 'rgba(255,255,255,0.18)' }}
      />
    </span>
  );
}
