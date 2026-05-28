import { SNAP_INDICATOR_COLOR } from '../../utils/snapIndication';

/**
 * Small violet dot that signals a boundary is sitting on a beat-grid line.
 * Used across every annotation type (Manual, Eye, Cue, Span, Loop, Pattern) so
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

/**
 * Inline "snapped" chip for pending-selection pills and editor lists where an
 * absolute-positioned dot would look out of place. Pairs a violet glyph with a
 * short label so the user understands what the indicator means.
 */
export function SnapChip({ label = 'snapped' }: { label?: string }) {
  return (
    <span
      className="inline-flex items-center gap-0.5 px-1 rounded text-[9px] font-mono uppercase tracking-wider"
      style={{
        color: SNAP_INDICATOR_COLOR,
        background: `${SNAP_INDICATOR_COLOR}22`,
        border: `1px solid ${SNAP_INDICATOR_COLOR}55`,
      }}
      title="Both endpoints lie on the beat grid"
    >
      <span
        aria-hidden="true"
        style={{
          width: 4, height: 4, borderRadius: 1,
          background: SNAP_INDICATOR_COLOR,
          boxShadow: `0 0 3px ${SNAP_INDICATOR_COLOR}`,
        }}
      />
      {label}
    </span>
  );
}
