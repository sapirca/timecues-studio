import { SNAP_INDICATOR_COLOR } from '../../utils/snapIndication';

/**
 * Small violet dot that signals a boundary is sitting on a beat-grid line.
 * Used across every annotation type (Manual, Eye, Cue, Span, Loop) so
 * the visual language of "this value is snapped" is consistent regardless of
 * whether the Beat-grid overlay is drawn.
 *
 * Positioned absolutely by the caller via `style` (the component itself just
 * paints the indicator). Default size is 5px; bump via `size` for taller rows.
 */
export function SnapTick({
  size = 5,
  style,
  title = 'Snapped to beat grid',
}: {
  size?: number;
  style?: React.CSSProperties;
  title?: string;
}) {
  return (
    <div
      className="absolute pointer-events-none z-20"
      title={title}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        background: SNAP_INDICATOR_COLOR,
        borderRadius: 1,
        boxShadow: `0 0 4px ${SNAP_INDICATOR_COLOR}`,
        ...style,
      }}
    />
  );
}

