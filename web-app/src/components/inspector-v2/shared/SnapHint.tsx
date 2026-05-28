/**
 * Inline "· snapped to BEAT" chip rendered next to a timestamp when the time
 * lies on the beat grid. Replaces the open-coded title-attribute strings in
 * CueLayerRow / PatternLaneRow / SpanEditPopover so every place that displays
 * a time uses the same wording, color, and snap tolerance.
 *
 * Renders nothing when:
 *   - grid info is incomplete (bpm / beatsPerBar missing or invalid)
 *   - the time is not on a beat-grid line within isOnGridLine's tolerance
 *
 * Intentionally has no border/background — it's a low-weight inline label, not
 * a status pill.
 */

import { isOnGridLine, SNAP_INDICATOR_COLOR } from '../../../utils/snapIndication';

export interface SnapHintProps {
  time: number;
  bpm?: number;
  gridOffset?: number;
  beatsPerBar?: number;
  /** Override the default "snapped to BEAT" copy (e.g. "snapped to BAR"). */
  label?: string;
  /** Tighten or relax the on-grid tolerance (seconds). Matches the default
   *  used elsewhere when omitted. */
  toleranceSec?: number;
  className?: string;
}

export function SnapHint({
  time, bpm, gridOffset, beatsPerBar,
  label = 'snapped to BEAT',
  toleranceSec,
  className,
}: SnapHintProps) {
  const snapped = isOnGridLine(time, bpm, gridOffset, beatsPerBar, toleranceSec);
  if (!snapped) return null;
  return (
    <span
      className={`text-[9px] font-mono uppercase tracking-wider whitespace-nowrap ${className ?? ''}`}
      style={{ color: SNAP_INDICATOR_COLOR }}
      title={`Time lies on a beat-grid line (BPM ${bpm}, ${beatsPerBar}/bar)`}
    >
      · {label}
    </span>
  );
}
