// Small color-coded markers along the top axis of the waveform showing
// where each TempoAnchor lives. Only rendered in the DataPrep workspace.
// Color tier matches the active grid mode (cyan for dynamic, emerald for
// manual). pointer-events are enabled so right-click deletes the anchor
// and left-click-drag repositions it via the shared useTimelineDrag hook.

import { useRef, type RefObject } from 'react';
import type { TempoAnchor, GridMode } from '../../types/songInfo';
import { useTimelineDrag } from '../../hooks/useTimelineDrag';

export interface AnchorFlagOverlayProps {
  anchors: readonly TempoAnchor[];
  /** Track duration in seconds. */
  duration: number;
  /** Active grid mode, used to choose the flag color tier. */
  mode: GridMode;
  /** Hover label formatter — typically "bar.beat · 120.00 BPM". */
  formatLabel?: (anchor: TempoAnchor, index: number) => string;
  /** Optional right-click handler (Phase F3). */
  onDeleteAnchor?: (index: number) => void;
  /** Left-click-drag handler. Receives the anchor index and the new
   *  timestamp in seconds. Parent should clamp + snap as needed. */
  onAnchorDrag?: (index: number, time: number) => void;
  onAnchorDragStart?: (index: number) => void;
  /** Container whose width defines the time axis. Required when onAnchorDrag
   *  is provided so the hook can map pixels → time. */
  containerRef?: RefObject<HTMLElement | null>;
}

const FLAG_COLOR: Record<GridMode, { fill: string; border: string; text: string; labelBg: string; labelText: string; labelBorder: string }> = {
  static: {  // unreachable: caller only renders this in anchor modes
    fill: 'rgba(148,163,184,0.6)', border: 'rgba(148,163,184,0.9)', text: 'text-slate-200',
    labelBg: 'bg-slate-500/30', labelText: 'text-slate-100', labelBorder: 'border-slate-400/40',
  },
  dynamic: {
    fill: 'rgba(34,211,238,0.7)', border: 'rgba(34,211,238,0.95)', text: 'text-cyan-50',
    labelBg: 'bg-cyan-500/30', labelText: 'text-cyan-100', labelBorder: 'border-cyan-400/50',
  },
  manual: {
    fill: 'rgba(52,211,153,0.7)', border: 'rgba(52,211,153,0.95)', text: 'text-emerald-50',
    labelBg: 'bg-emerald-500/30', labelText: 'text-emerald-100', labelBorder: 'border-emerald-400/50',
  },
};

export function AnchorFlagOverlay({
  anchors,
  duration,
  mode,
  formatLabel,
  onDeleteAnchor,
  onAnchorDrag,
  onAnchorDragStart,
  containerRef,
}: AnchorFlagOverlayProps) {
  const fallbackRef = useRef<HTMLDivElement | null>(null);
  const effectiveRef = (containerRef ?? fallbackRef) as RefObject<HTMLElement | null>;
  // Hook must be called unconditionally — pass null callbacks when drag is
  // disabled so the early-return below stays React-rules-compliant.
  const { startDrag } = useTimelineDrag<{ index: number }>({
    containerRef: effectiveRef,
    duration,
    onDragStart: ({ index }) => onAnchorDragStart?.(index),
    onDrag: ({ index }, t) => onAnchorDrag?.(index, t),
  });

  if (anchors.length === 0 || duration <= 0 || mode === 'static') return null;
  const color = FLAG_COLOR[mode];
  const dragEnabled = !!onAnchorDrag;

  return (
    <div
      ref={fallbackRef}
      className="absolute inset-x-0 top-0 h-full pointer-events-none z-10"
    >
      {anchors.map((a, i) => {
        const left = (a.timestamp / duration) * 100;
        const label = formatLabel
          ? formatLabel(a, i)
          : `${a.timestamp.toFixed(2)}s · ${a.bpm.toFixed(2)} BPM`;
        const bpmRounded = Math.round(a.bpm);
        return (
          <div
            key={`${i}-${a.timestamp}`}
            className={`absolute top-0 -translate-x-1/2 pointer-events-auto flex flex-col items-center gap-0.5 ${dragEnabled ? 'cursor-ew-resize' : ''}`}
            style={{ left: `${left}%` }}
            title={dragEnabled ? `${label} · drag to move · right-click to delete` : label}
            onMouseDown={dragEnabled ? (e) => {
              if (e.button !== 0) return;
              startDrag({ index: i }, e);
            } : undefined}
            onContextMenu={onDeleteAnchor ? (e) => {
              e.preventDefault();
              onDeleteAnchor(i);
            } : undefined}
          >
            {/* Always-on BPM badge — rounded for compactness; full
                precision still in the title tooltip. */}
            <span
              className={`px-1 py-px rounded text-[10px] font-mono font-semibold leading-none border tabular-nums whitespace-nowrap ${color.labelBg} ${color.labelText} ${color.labelBorder}`}
            >
              {bpmRounded}
            </span>
            {/* The "flag": a triangle pointing down with a small stem. */}
            <svg
              width="10" height="14" viewBox="0 0 10 14"
              className={`block ${color.text}`}
              aria-hidden="true"
            >
              <path
                d="M 5 14 L 5 4 M 1 1 L 9 1 L 5 5 Z"
                fill={color.fill}
                stroke={color.border}
                strokeWidth="1"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        );
      })}
    </div>
  );
}
