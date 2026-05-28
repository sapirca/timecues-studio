import { useEffect, useRef, type RefObject } from 'react';
import { PreviewControlsBar } from './PreviewControlsBar';

export interface PreviewRegion {
  start: number;
  end: number;
  loop: boolean;
}

interface Props {
  region: PreviewRegion;
  duration: number;
  isPlaying: boolean;
  /** Element whose width defines the time→pixel mapping (parent of the FrequencyWaveform). */
  parentRef: RefObject<HTMLElement | null>;
  onChange: (region: PreviewRegion) => void;
  onPlay: () => void;
  onPause: () => void;
  onDismiss: () => void;
  onLoopToggle: () => void;
  /** When false, omit the floating control bar above the band. Used when the
   *  same preview region is mirrored across stacked rows (e.g. algo-inspect)
   *  so only the topmost row shows the controls. Resize handles still render. */
  showControls?: boolean;
}

type DragMode = 'left' | 'right';

export function PreviewWindow({
  region, duration, isPlaying, parentRef,
  onChange, onPlay, onPause, onDismiss, onLoopToggle,
  showControls = true,
}: Props) {
  const dragRef = useRef<{ mode: DragMode; startX: number; startStart: number; startEnd: number } | null>(null);

  useEffect(() => {
    const onMove = (ev: MouseEvent) => {
      const drag = dragRef.current;
      const parent = parentRef.current;
      if (!drag || !parent || duration <= 0) return;
      const rect = parent.getBoundingClientRect();
      if (rect.width <= 0) return;
      const dxSec = ((ev.clientX - drag.startX) / rect.width) * duration;

      if (drag.mode === 'left') {
        let s = drag.startStart + dxSec;
        if (s < 0) s = 0;
        if (s > drag.startEnd - 0.1) s = drag.startEnd - 0.1;
        onChange({ ...region, start: s, end: drag.startEnd });
      } else {
        let e = drag.startEnd + dxSec;
        if (e > duration) e = duration;
        if (e < drag.startStart + 0.1) e = drag.startStart + 0.1;
        onChange({ ...region, start: drag.startStart, end: e });
      }
    };
    const onUp = () => { dragRef.current = null; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [parentRef, duration, region, onChange]);

  if (duration <= 0) return null;

  const startPct = Math.max(0, Math.min(100, (region.start / duration) * 100));
  const widthPct = Math.max(0, Math.min(100 - startPct, ((region.end - region.start) / duration) * 100));

  const beginDrag = (e: React.MouseEvent, mode: DragMode) => {
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = { mode, startX: e.clientX, startStart: region.start, startEnd: region.end };
  };

  return (
    // Background is pointer-events:none so clicks pass through to the viz rows
    // underneath — keeps row interactions (marker drag, click-to-clear) intact
    // even when the tall band spans them. Only the resize handles and the
    // floating control bar capture mouse events.
    <div
      className="absolute top-0 bottom-0 z-30 pointer-events-none"
      style={{
        left: `${startPct}%`,
        width: `${widthPct}%`,
        background: 'rgba(45,212,191,0.18)',
        borderLeft:  '2px solid rgba(45,212,191,0.95)',
        borderRight: '2px solid rgba(45,212,191,0.95)',
        boxShadow: '0 0 0 1px rgba(45,212,191,0.30) inset',
      }}
    >
      {/* Resize handles (overlap the borders for easier grab) */}
      <div
        className="absolute top-0 bottom-0 pointer-events-auto"
        style={{ left: -5, width: 10, cursor: 'ew-resize', zIndex: 1 }}
        onMouseDown={(e) => beginDrag(e, 'left')}
      />
      <div
        className="absolute top-0 bottom-0 pointer-events-auto"
        style={{ right: -5, width: 10, cursor: 'ew-resize', zIndex: 1 }}
        onMouseDown={(e) => beginDrag(e, 'right')}
      />

      {/* Floating control bar (above the band) */}
      {showControls && (
      <div className="absolute -top-7 left-1/2 -translate-x-1/2">
        <PreviewControlsBar
          isPlaying={isPlaying}
          loop={region.loop}
          onPlay={onPlay}
          onPause={onPause}
          onLoopToggle={onLoopToggle}
          onDismiss={onDismiss}
          extra={
            <span className="text-[10px] font-mono text-gray-400 px-1 tabular-nums">
              {(region.end - region.start).toFixed(1)}s
            </span>
          }
        />
      </div>
      )}
    </div>
  );
}
