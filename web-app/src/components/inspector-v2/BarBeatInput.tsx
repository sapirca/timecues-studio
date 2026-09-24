import { useState, useRef } from 'react';
import { timeToBarBeat, barBeatToTime } from '../../utils/beatGrid';
import { barBeatHelpTitle } from '../../utils/beatTimeFormat';
import { useBarBeatOrigin } from '../../context/SettingsContext';

export interface BarBeatInputProps {
  /** Time in seconds — derived from / written back to the same source-of-truth as the seconds input. */
  value: number;
  onChange: (seconds: number) => void;
  bpm?: number;
  gridOffset?: number;
  beatsPerBar?: number;
  /** Resolved grid segments. When the song is split, bar.beat counts in each
   *  segment's own meter from its own bar 1 — so this readout agrees with the
   *  ruler the annotator is looking at. */
  segments?: readonly import('../../utils/gridSegments').ResolvedSegment[];
  disabled?: boolean;
  className?: string;
  title?: string;
  /** Optional minimum time in seconds (e.g. previous section's start). */
  minSeconds?: number;
}

export function BarBeatInput({
  value,
  onChange,
  bpm,
  gridOffset = 0,
  beatsPerBar = 4,
  segments,
  disabled,
  className,
  title,
  minSeconds,
}: BarBeatInputProps) {
  const barBeatOrigin = useBarBeatOrigin();
  const ready = !!bpm && bpm > 0 && beatsPerBar > 0;
  const [editText, setEditText] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const derived = ready
    ? timeToBarBeat(value, bpm!, gridOffset, beatsPerBar, 3, barBeatOrigin, segments) ?? ''
    : '';
  const display = editText ?? derived;

  const commit = () => {
    if (editText == null) return;
    if (!ready) { setEditText(null); return; }
    const t = barBeatToTime(editText, bpm!, gridOffset, beatsPerBar, barBeatOrigin, segments);
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
      placeholder={ready ? `${barBeatOrigin}.${barBeatOrigin}` : '— BPM —'}
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
      title={title ?? (ready ? barBeatHelpTitle(barBeatOrigin) : 'Set BPM in Song Info to use bar.beat input')}
    />
  );
}
