// Interactive beat-line editor for DataPrep's "Manual adjustment" mode.
//
// A thin horizontal track sitting above the main waveform. Each visible
// beat from the current grid is grabbable — pointer-down on a line tracks
// pointer movement, pointer-up commits via `onBeatDrag(tOrig, tNew,
// beatIndex)`. The host writes the new position into
// `SongInfo.beatOverrides[beatIndex]`, leaving every other beat — including
// the dragged beat's neighbours — exactly where the macro grid put them.
//
// Right-click on a pinned (overridden) beat fires `onClearOverride` so the
// curator can drop a beat back onto the macro grid.
//
// Why a dedicated row instead of dragging directly on the waveform?
//   - The wavesurfer canvas already owns click-to-seek and Alt-drag for
//     gridOffset slide. Hijacking pointer events there to add a third
//     gesture (beat drag) collides with those.
//   - A separate row gives a clear hit target with no precision-of-grab
//     ambiguity. The row uses the same horizontal scale (px → seconds)
//     as the waveform, so visually the beat line in the editor sits
//     exactly above the corresponding beat on the wave.

import { useMemo, useRef, useState } from 'react';
import { visibleGridLines } from '../../utils/beatGrid';
import type { TempoAnchor } from '../../types/songInfo';

export interface ManualGridEditorProps {
  bpm: number;
  gridOffset: number;
  beatsPerBar: number;
  /** Current anchors. The grid lines render with these in effect, so the
   *  user sees the live state and grabs from where it is now. */
  anchors?: readonly TempoAnchor[];
  /** Current per-beat overrides — included so the rendered grid shows
   *  pinned beats at their override positions (and so the right-click
   *  clear knows what's currently pinned). */
  beatOverrides?: Readonly<Record<string, number>>;
  duration: number;
  /** Pixel height of the editor row. Default 28 — wide enough to grab. */
  height?: number;
  /** Fired on pointer-up. Receives the dragged beat's original time, the
   *  new dropped time, and the integer beat index captured at
   *  pointer-down. The index is the override key. */
  onBeatDrag: (tOrig: number, tNew: number, beatIndex: number) => void;
  /** Fired when the curator right-clicks a pinned (overridden) beat. The
   *  host deletes the matching entry from `SongInfo.beatOverrides`. No-op
   *  when omitted. */
  onClearOverride?: (beatIndex: number) => void;
  /** When true, the editor disables itself (non-admin viewer). */
  locked?: boolean;
  /** When true, render as a transparent overlay over the waveform: drops
   *  the border + emerald background, makes the container itself
   *  pointer-events-none so seek-clicks fall through, and only the per-
   *  beat hit zones intercept pointer events. The corner label is also
   *  hidden — its message lives in the container tooltip. */
  overlay?: boolean;
}

interface DragState {
  /** Original (visual) time of the dragged beat, in seconds. */
  tOrig: number;
  /** Integer beat index captured at pointer-down — the override key. */
  beatIndex: number;
  /** Current pointer-projected new time, in seconds. Updates during drag. */
  tNew: number;
  /** Captured pointer ID so we keep tracking even outside the row. */
  pointerId: number;
  /** Container width at drag start, used to convert px deltas to time. */
  containerWidthPx: number;
  /** Pointer X at drag start, in container-relative pixels. */
  startX: number;
}

export function ManualGridEditor({
  bpm,
  gridOffset,
  beatsPerBar,
  anchors,
  beatOverrides,
  duration,
  height = 28,
  onBeatDrag,
  onClearOverride,
  locked = false,
  overlay = false,
}: ManualGridEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  // Enumerate visible beat lines. Reuse the same engine the waveform's
  // BeatGridOverlay uses so positions match exactly. Bar lines are
  // preferred grab targets, but every beat is grabbable.
  const lines = useMemo(() => {
    if (!bpm || bpm <= 0 || duration <= 0) return [];
    return visibleGridLines({
      bpm,
      gridOffset,
      beatsPerBar,
      startTime: 0,
      endTime: duration,
      anchors,
      beatOverrides,
    });
  }, [bpm, gridOffset, beatsPerBar, anchors, beatOverrides, duration]);

  if (duration <= 0 || lines.length === 0) return null;

  const px = (t: number) => (t / duration) * 100;

  const handlePointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
    tOrig: number,
    beatIndex: number,
  ) => {
    if (locked) return;
    if (!Number.isInteger(beatIndex)) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const startX = e.clientX - rect.left;
    // Capture so pointermove fires even if the user moves outside the row.
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    setDrag({ tOrig, beatIndex, tNew: tOrig, pointerId: e.pointerId, containerWidthPx: rect.width, startX });
    e.stopPropagation();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const currentX = e.clientX - rect.left;
    const deltaPx = currentX - drag.startX;
    const tNew = drag.tOrig + (deltaPx / drag.containerWidthPx) * duration;
    if (Number.isFinite(tNew)) {
      setDrag({ ...drag, tNew: Math.max(0, Math.min(duration, tNew)) });
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    try { (e.currentTarget as HTMLDivElement).releasePointerCapture(drag.pointerId); } catch { /* noop */ }
    // Only fire if the drop moved meaningfully — sub-millisecond drops
    // are usually accidental clicks.
    if (Math.abs(drag.tNew - drag.tOrig) >= 0.005) {
      onBeatDrag(drag.tOrig, drag.tNew, drag.beatIndex);
    }
    setDrag(null);
  };

  const handleContextMenu = (
    e: React.MouseEvent<HTMLDivElement>,
    beatIndex: number,
    isOverridden: boolean,
  ) => {
    if (locked || !onClearOverride || !isOverridden) return;
    if (!Number.isInteger(beatIndex)) return;
    e.preventDefault();
    e.stopPropagation();
    onClearOverride(beatIndex);
  };

  // In overlay mode the editor sits transparently on top of the waveform.
  // The container itself must let seek-clicks fall through, so it goes
  // pointer-events-none and only the per-beat hit zones below opt back in.
  const containerClass = overlay
    ? 'absolute inset-0 select-none pointer-events-none'
    : 'relative w-full select-none border-y border-emerald-500/20 bg-emerald-500/[0.04]';
  const containerStyle = overlay ? undefined : { height };

  return (
    <div
      ref={containerRef}
      className={containerClass}
      style={containerStyle}
      title={locked ? undefined : 'Manual adjustment — drag a beat line to pin it to a new time; right-click a pinned (emerald-tinted) line to clear the override. Drag a triangle flag above for macro tempo changes; right-click it to delete the anchor.'}
    >
      {/* Faint label — hidden in overlay mode (the message lives in the
          container tooltip + the per-beat-line tooltips already). */}
      {!overlay && (
        <span className="absolute top-0.5 left-1 text-[8px] font-mono uppercase tracking-wider text-emerald-400/70 pointer-events-none">
          Drag a beat to pin it · right-click to unpin
        </span>
      )}

      {/* Grid lines — each rendered with a wider invisible hit area for grab.
          Sub-beat lines (8th/16th) are NOT grabbable — only integer beats
          can be overridden. */}
      {lines.map((l, i) => {
        if (l.isSubBeat) return null;
        if (!Number.isInteger(l.beatIndex)) return null;
        const left = px(l.t);
        const isBar = l.isBar;
        const isOverridden = !!l.isOverridden;
        // Pinned beats render as a solid, brighter, slightly wider line
        // with a small dot at the top so they read at a glance against
        // the macro-grid lines.
        const lineColor = isOverridden
          ? 'rgba(251,191,36,0.95)'           // amber (matches the live-drag preview)
          : isBar
            ? 'rgba(52,211,153,0.85)'         // emerald bar
            : 'rgba(52,211,153,0.32)';        // emerald beat
        const lineWidth = isOverridden ? 2 : isBar ? 2 : 1;
        const titleParts = [
          `beat ${l.beatIndex + 1} · ${l.t.toFixed(3)}s`,
          isOverridden ? '· pinned (right-click to clear)' : '· drag to pin',
        ];
        return (
          <div
            key={`${l.beatIndex}-${i}`}
            className={locked ? '' : 'cursor-ew-resize'}
            style={{
              position: 'absolute',
              left: `${left}%`,
              top: 0,
              bottom: 0,
              transform: 'translateX(-50%)',
              width: 9,                            // hit area (visible line is centered)
              touchAction: 'none',
              // In overlay mode the parent is pointer-events-none so the
              // waveform's seek-click works between beats; each hit zone
              // opts back in so the drag/right-click gesture still fires.
              pointerEvents: overlay ? 'auto' : undefined,
            }}
            title={locked ? undefined : titleParts.join(' ')}
            onPointerDown={(e) => handlePointerDown(e, l.t, l.beatIndex)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onContextMenu={(e) => handleContextMenu(e, l.beatIndex, isOverridden)}
          >
            {/* Inner visible beat line. */}
            <div
              className="absolute top-1 bottom-1 left-1/2 -translate-x-1/2 pointer-events-none"
              style={{ width: lineWidth, background: lineColor }}
            />
            {/* Pinned-beat marker — small dot at the top so overrides are
                visible even when many beat lines crowd the row. */}
            {isOverridden && (
              <div
                className="absolute top-0 left-1/2 -translate-x-1/2 pointer-events-none rounded-full"
                style={{ width: 5, height: 5, background: 'rgba(251,191,36,0.95)', boxShadow: '0 0 4px rgba(251,191,36,0.7)' }}
              />
            )}
          </div>
        );
      })}

      {/* Live preview line: where the dragged beat will land if released now. */}
      {drag && (
        <div
          className="absolute top-0 bottom-0 pointer-events-none"
          style={{
            left: `${px(drag.tNew)}%`,
            transform: 'translateX(-50%)',
            width: 2,
            background: 'rgba(251,191,36,0.95)',
            boxShadow: '0 0 6px rgba(251,191,36,0.7)',
          }}
        >
          <span className="absolute -top-3 left-1/2 -translate-x-1/2 text-[9px] font-mono text-amber-200 whitespace-nowrap px-1 rounded bg-black/70">
            {drag.tNew.toFixed(3)}s
          </span>
        </div>
      )}
    </div>
  );
}
