/**
 * CueLayerRow — vertical tick marks for a single Cue layer on the canvas.
 *
 * Unlike SectionBlockRow (which renders contiguous colored blocks for
 * partitions), Cues are point events. Each tick is clickable: clicking
 * fires onCueClick(itemId, anchor), which the parent uses to open the
 * inline edit popover anchored near the click.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CueItem } from '../../types/annotationLayer';
import { BeatGridOverlay } from './BeatGridOverlay';
import { isOnGridLine, SNAP_INDICATOR_COLOR } from '../../utils/snapIndication';
import { SnapTick } from './SnapIndicator';
import { useTimelineDrag } from '../../hooks/useTimelineDrag';
import { PendingHighlightOverlay, type PendingSelection } from './AnnotationOverlays';
import { ReviewControls, reviewBgFor, type ReviewStatus } from './ReviewControls';

interface CueLayerRowProps {
  items: CueItem[];
  color: string;
  duration: number;
  currentTime: number;
  height?: number;
  /** Cue id currently focused — drawn brighter than the others. */
  focusedItemId?: string | null;
  onCueClick?: (itemId: string, anchor: { x: number; y: number }) => void;
  /** Drag the tick to change a cue's time. */
  onCueDrag?: (itemId: string, time: number) => void;
  onCueDragStart?: (itemId: string) => void;
  /** Optional grid overlay for beat/bar lines under the ticks. */
  gridProps?: { bpm?: number; gridOffset?: number; beatsPerBar?: number; barGroupSize?: number | null; thickness?: number };
  pendingSelection?: PendingSelection | null;
  /** When present, this row is in detector-review mode: ticks become read-only
   *  and each one renders inline ✓/✗ controls. Keyed by cue id. */
  reviewState?: Record<string, ReviewStatus>;
  onAccept?: (itemId: string) => void;
  onReject?: (itemId: string) => void;
}

export function CueLayerRow({
  items, color, duration, currentTime, height = 22,
  focusedItemId, onCueClick,
  onCueDrag, onCueDragStart,
  gridProps,
  pendingSelection,
  reviewState, onAccept, onReject,
}: CueLayerRowProps) {
  const reviewMode = !!reviewState;
  const containerRef = useRef<HTMLDivElement>(null);
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  // Click vs. drag disambiguation: the tick is both clickable (open popover)
  // and draggable (reposition). We flip `didDragRef` true on the first
  // onDrag call; the click handler short-circuits if a real drag happened.
  const didDragRef = useRef(false);
  const { startDrag } = useTimelineDrag<{ id: string }>({
    containerRef,
    duration,
    onDragStart: ({ id }) => onCueDragStart?.(id),
    onDrag: ({ id }, t) => { didDragRef.current = true; onCueDrag?.(id, t); },
  });
  const dragEnabled = !!onCueDrag && !reviewMode;

  // Transient violet halo for newly-placed cues whose time landed on the beat
  // grid (i.e. snap-to-grid moved the value). The persistent SnapTick is easy
  // to miss when M is pressed, so we flash a larger ring at the moment of
  // placement to make "your click was snapped" obvious.
  const [pulseIds, setPulseIds] = useState<ReadonlySet<string>>(() => new Set());
  const prevItemTimesRef = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    const next = new Map(items.map((it) => [it.id, it.time]));
    const prev = prevItemTimesRef.current;
    prevItemTimesRef.current = next;
    if (prev === null) return; // skip on first mount
    const changed: string[] = [];
    for (const [id, t] of next) {
      const prevT = prev.get(id);
      if (prevT !== undefined && prevT === t) continue;
      if (isOnGridLine(t, gridProps?.bpm, gridProps?.gridOffset, gridProps?.beatsPerBar)) {
        changed.push(id);
      }
    }
    if (changed.length === 0) return;
    setPulseIds((curr) => {
      const u = new Set(curr);
      for (const id of changed) u.add(id);
      return u;
    });
    const handle = window.setTimeout(() => {
      setPulseIds((curr) => {
        const u = new Set(curr);
        for (const id of changed) u.delete(id);
        return u;
      });
    }, 800);
    return () => window.clearTimeout(handle);
  }, [items, gridProps?.bpm, gridProps?.gridOffset, gridProps?.beatsPerBar]);

  const placed = useMemo(() => {
    if (duration <= 0) return [];
    const sorted = [...items].sort((a, b) => a.time - b.time);
    return sorted.map((cue) => ({
      cue,
      leftPct: (cue.time / duration) * 100,
    }));
  }, [items, duration]);

  return (
    <div
      ref={containerRef}
      className="flex-1 relative rounded overflow-hidden bg-gray-950"
      style={{ height }}
      title={items.length === 0 ? 'No cues yet — add one from the Cues editor' : undefined}
    >
      {gridProps && (
        <BeatGridOverlay
          bpm={gridProps.bpm}
          gridOffset={gridProps.gridOffset}
          beatsPerBar={gridProps.beatsPerBar}
          barGroupSize={gridProps.barGroupSize}
          thickness={gridProps.thickness}
          duration={duration}
        />
      )}

      {items.length === 0 && (
        <span className="absolute inset-0 flex items-center px-2 text-[10px] text-gray-700 italic select-none pointer-events-none">
          no cues yet
        </span>
      )}

      {placed.map(({ cue, leftPct }) => {
        const isFocused = cue.id === focusedItemId;
        const snapped = isOnGridLine(cue.time, gridProps?.bpm, gridProps?.gridOffset, gridProps?.beatsPerBar);
        const status = reviewState?.[cue.id];
        const tickColor = reviewMode ? reviewBgFor(color, status) : color;
        const titleText = reviewMode
          ? `${cue.label || '(unlabeled)'} @ ${fmtTime(cue.time)}${status ? ` · ${status}` : ' · pending review'}${cue.description ? '\n' + cue.description : ''}`
          : `${cue.label || '(unlabeled)'} @ ${fmtTime(cue.time)}${snapped ? ' · snapped to beat grid' : ''}${dragEnabled ? ' · drag to reposition · click to edit' : ''}${cue.description ? '\n' + cue.description : ''}`;
        const onClickCue = reviewMode
          ? undefined
          : (e: React.MouseEvent) => {
              e.stopPropagation();
              if (didDragRef.current) { didDragRef.current = false; return; }
              onCueClick?.(cue.id, { x: e.clientX, y: e.clientY });
            };
        const onMouseDownCue = dragEnabled
          ? (e: React.MouseEvent) => { didDragRef.current = false; startDrag({ id: cue.id }, e); }
          : undefined;
        const pulsing = pulseIds.has(cue.id);
        return (
          <div key={cue.id} className="contents">
            {pulsing && (
              <span
                className="absolute top-0 bottom-0 pointer-events-none z-20 flex items-center justify-center"
                style={{ left: `${leftPct}%`, width: 18, transform: 'translateX(-50%)' }}
                aria-hidden="true"
              >
                <span
                  className="block animate-ping rounded-sm"
                  style={{
                    width: 14, height: 14,
                    background: SNAP_INDICATOR_COLOR,
                    opacity: 0.55,
                    boxShadow: `0 0 12px ${SNAP_INDICATOR_COLOR}`,
                  }}
                />
              </span>
            )}
            <button
              onClick={onClickCue}
              onMouseDown={onMouseDownCue}
              disabled={reviewMode}
              // Translate by -50% so the tick is visually centred on its time.
              // The 8px-wide click target straddles the 2px-wide visible line,
              // giving generous hit area without obscuring neighbouring ticks.
              className={`absolute top-0 bottom-0 w-2 flex items-stretch justify-center group/cue ${
                reviewMode ? 'cursor-default' : (dragEnabled ? 'cursor-ew-resize' : 'cursor-pointer')
              }`}
              style={{ left: `${leftPct}%`, transform: 'translateX(-50%)' }}
              title={titleText}
            >
              <span
                className="block w-[3px] h-full rounded-sm transition-all group-hover/cue:w-1.5"
                style={{
                  background: tickColor,
                  boxShadow: isFocused ? `0 0 10px ${tickColor}, 0 0 3px ${tickColor}` : `0 0 5px ${tickColor}aa, 0 0 1px ${tickColor}`,
                  opacity: status === 'rejected' ? 0.45 : 1,
                }}
              />
              {snapped && !reviewMode && <SnapTick style={{ top: 0, left: '50%', transform: 'translateX(-50%)' }} />}
            </button>
            {reviewMode && (
              <ReviewControls
                status={status}
                onAccept={() => onAccept?.(cue.id)}
                onReject={() => onReject?.(cue.id)}
                size={12}
                style={{ position: 'absolute', top: -1, left: `${leftPct}%`, transform: 'translateX(-50%)', zIndex: 15 }}
              />
            )}
          </div>
        );
      })}

      {/* Playhead */}
      <div
        className="absolute top-0 bottom-0 w-px pointer-events-none z-10"
        style={{ left: `${pct}%`, background: 'rgba(255,255,255,0.75)' }}
      />
      {pendingSelection && (
        <PendingHighlightOverlay sel={pendingSelection} duration={duration} grid={gridProps} />
      )}
    </div>
  );
}

function fmtTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '0:00.0';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
