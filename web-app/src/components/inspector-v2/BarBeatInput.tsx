import { useState, useRef } from 'react';
import type { TempoAnchor } from '../../types/songInfo';
import { timeToBarBeat, barBeatToTime } from '../../utils/beatGrid';

export interface BarBeatInputProps {
  /** Time in seconds — derived from / written back to the same source-of-truth as the seconds input. */
  value: number;
  onChange: (seconds: number) => void;
  bpm?: number;
  gridOffset?: number;
  beatsPerBar?: number;
  /** Optional tempo anchors — when present, bar.beat walks per-segment BPM
   *  (Dynamic / Manual grids). When omitted, falls back to a global BPM. */
  anchors?: readonly TempoAnchor[];
  disabled?: boolean;
  className?: string;
  title?: string;
  /** Optional minimum time in seconds (e.g. previous section's start). */
  minSeconds?: number;
}

const HELP_TITLE =
  'bar.beat — e.g. 2.3 = bar 2 beat 3; 2.3.5 = halfway between beat 3 and 4';

export function BarBeatInput({
  value,
  onChange,
  bpm,
  gridOffset = 0,
  beatsPerBar = 4,
  anchors,
  disabled,
  className,
  title,
  minSeconds,
}: BarBeatInputProps) {
  const ready = !!bpm && bpm > 0 && beatsPerBar > 0;
  const [editText, setEditText] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const derived = ready ? timeToBarBeat(value, bpm!, gridOffset, beatsPerBar, 3, anchors) ?? '' : '';
  const display = editText ?? derived;

  const commit = () => {
    if (editText == null) return;
    if (!ready) { setEditText(null); return; }
    const t = barBeatToTime(editText, bpm!, gridOffset, beatsPerBar, anchors);
    if (t != null && Number.isFinite(t)) {
      const clamped = minSeconds != null ? Math.max(minSeconds, t) : t;
      // Only fire onChange if the parsed value differs from current (avoid no-op edits).
      if (Math.abs(clamped - value) > 1e-6) onChange(clamped);
    }
    setEditText(null);
  };

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      value={display}
      placeholder={ready ? '1.1' : '— BPM —'}
      disabled={disabled || !ready}
      onChange={(e) => setEditText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          inputRef.current?.blur();
        } else if (e.key === 'Escape') {
          setEditText(null);
          inputRef.current?.blur();
        }
      }}
      className={className}
      title={title ?? (ready ? HELP_TITLE : 'Set BPM in Song Info to use bar.beat input')}
    />
  );
}
