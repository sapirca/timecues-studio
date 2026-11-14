import { useRef, useState } from 'react';
import type { SectionBlock } from '../../types/sectionBlock';
import type { AutoGuessPoint } from '../../types/autoGuess';
import { isOnGridLine, SNAP_INDICATOR_COLOR } from '../../utils/snapIndication';
import { SnapTick } from './SnapIndicator';
import { useTimelineDrag, useRegionSelectDrag } from '../../hooks/useTimelineDrag';
import { isSelectToggle } from '../../hooks/useCrossLaneDrop';
import { agreementCount } from '../../utils/boundaryClustering';
import { usePlayheadValue } from '../../hooks/usePlayhead';
import { PlayheadLine } from '../Playhead';
import { sectionColor } from './sectionConstants';

/** Grid info needed to decide whether a boundary lies on a beat-grid line.
 *  Optional everywhere — when bpm is undefined, the snap indicator simply
 *  doesn't render and the existing visuals are unchanged. */
export interface GridSnapInfo {
  bpm?: number;
  gridOffset?: number;
  beatsPerBar?: number;
}

// ─── Color map ────────────────────────────────────────────────────────────────

const sectionBg = sectionColor;

// ─── Manual markers ─────────────────────────────────────────────────────────────

// Lane offsets: the number label sits in its own horizontal band at the top of
// the signal. Each line also gets a tiny colored "cap" in its lane so the
// boundary is identifiable even when the 1px lines occlude one another.
const LANE_MANUAL_TOP = 1;   // px — row 1
const LANE_CAP_W    = 5;   // px — width of the colored cap that sits inside the lane

function ManualMarkerLine({ s, i, duration, grid, onPointerDown }: {
  s: SectionBlock; i: number; duration: number; grid?: GridSnapInfo;
  /** When provided, the cap+number patch becomes a drag handle. */
  onPointerDown?: (e: React.PointerEvent, sectionIdx: number) => void;
}) {
  const color = s.color ?? sectionBg(s.type);
  const snapped = isOnGridLine(s.time, grid?.bpm, grid?.gridOffset, grid?.beatsPerBar);
  const draggable = !!onPointerDown;
  return (
    <div
      className="absolute top-0 bottom-0 pointer-events-none z-10"
      style={{ left: `${(s.time / duration) * 100}%` }}
    >
      <div className="absolute inset-y-0 left-0 w-px" style={{ background: color, opacity: 0.9 }} />
      {/* Lane cap — also serves as the drag handle when onPointerDown is wired. */}
      <div
        className={`absolute ${draggable ? 'pointer-events-auto cursor-ew-resize touch-none tc-hit' : ''}`}
        style={{ top: LANE_MANUAL_TOP, left: -3, width: LANE_CAP_W + 6, height: 12, background: color, opacity: 0.9, borderRadius: 1 }}
        onPointerDown={onPointerDown ? (e) => onPointerDown(e, i) : undefined}
        title={draggable ? `Manual boundary ${i + 1} · drag to reposition` : undefined}
      />
      {snapped && (
        <SnapTick
          style={{ top: LANE_MANUAL_TOP - 5, left: -1 }}
          title={`Manual boundary ${i + 1} is on the beat grid`}
        />
      )}
      <div
        className="absolute text-[9px] font-mono leading-none select-none pointer-events-none"
        style={{ top: LANE_MANUAL_TOP, left: LANE_CAP_W + 1, color, textShadow: '0 0 4px rgba(0,0,0,0.9)' }}
      >
        {i + 1}
      </div>
    </div>
  );
}

function ManualCandidateMarkerLine({ t, sectionIndex, type, duration }: { t: number; sectionIndex: number; type: string; duration: number }) {
  const color = sectionBg(type);
  return (
    <div
      className="absolute top-0 bottom-0 pointer-events-none z-9"
      style={{ left: `${(t / duration) * 100}%` }}
    >
      <div
        className="absolute inset-y-0 left-0"
        style={{
          width: 1,
          background: `repeating-linear-gradient(to bottom, ${color} 0px, ${color} 3px, transparent 3px, transparent 6px)`,
          opacity: 0.45,
        }}
      />
      <div
        className="absolute text-[8px] font-mono leading-none select-none"
        style={{ top: 10, left: 2, color, opacity: 0.55, textShadow: '0 0 3px rgba(0,0,0,0.9)' }}
      >
        {sectionIndex + 1}·
      </div>
    </div>
  );
}

// ─── Pending selection highlight ──────────────────────────────────────────────

export type PendingSelection = { t1: number; t2: number | null };

export function PendingHighlightOverlay({ sel, duration, grid }: { sel: PendingSelection; duration: number; grid?: GridSnapInfo }) {
  if (duration <= 0) return null;
  if (sel.t2 !== null) {
    const lo = Math.min(sel.t1, sel.t2);
    const hi = Math.max(sel.t1, sel.t2);
    const left  = (lo / duration) * 100;
    const width = ((hi - lo) / duration) * 100;
    const loSnapped = isOnGridLine(lo, grid?.bpm, grid?.gridOffset, grid?.beatsPerBar);
    const hiSnapped = isOnGridLine(hi, grid?.bpm, grid?.gridOffset, grid?.beatsPerBar);
    // When either endpoint is on the grid, paint that edge violet so the user
    // sees that the boundary they're about to commit is snapped — even with the
    // Beat-grid overlay hidden. Cyan stays for non-snapped edges.
    const leftEdgeColor  = loSnapped ? SNAP_INDICATOR_COLOR : '#2dd4bf';
    const rightEdgeColor = hiSnapped ? SNAP_INDICATOR_COLOR : '#2dd4bf';
    return (
      <div
        className="absolute top-0 bottom-0 pointer-events-none z-20"
        style={{
          left: `${left}%`, width: `${width}%`, minWidth: 2,
          background: 'rgba(45,212,191,0.22)',
          borderLeft: `2px solid ${leftEdgeColor}`,
          borderRight: `2px solid ${rightEdgeColor}`,
        }}
      >
        {loSnapped && <SnapTick style={{ top: 2, left: -3 }} title="Pending start is on the beat grid" />}
        {hiSnapped && <SnapTick style={{ top: 2, right: -3 }} title="Pending end is on the beat grid" />}
      </div>
    );
  }
  // A t1-only pending mark draws nothing. The click that sets it also seeks,
  // so the line was born under the playhead and only separated from it once
  // playback moved on — a second cursor-looking marker that says nothing the
  // playhead and the pending pill in the sidebar don't already say. The
  // selection state itself is untouched; only its on-canvas twin is gone.
  return null;
}

// ─── Click + drag-to-region overlay ──────────────────────────────────────────
// A thin absolute-inset overlay that turns a plain click into onVizClick(t)
// (seek) and a drag into onVizRegion(t1, t2) (create a pending highlight) —
// the same gesture the 3-Band waveform / signal rows support.
//
// `z` controls the stacking class. Signal/MIR rows mount it on TOP of the
// visualization (default `z-[1]`, which still sits below AnnotationOverlays
// markers at z-10/z-20). Annotation lane rows instead mount it as an EARLIER
// sibling with `z=""` so it sits BEHIND the lane's interactive items (ticks,
// bands) — those paint on top and keep receiving their own pointerdowns, while
// empty space between them falls through to this overlay.
//
// The gesture itself is useRegionSelectDrag, so tracking happens on the
// document: a drag that wanders off the row (or past t=0 into the label
// gutter) keeps painting instead of being thrown away. `touch-pan-y` lets a
// phone scroll the page with a vertical swipe over the row, while a
// horizontal one paints the selection.
export function RegionDragOverlay({ duration, onVizClick, onVizRegion, onRegionDragStart, onSelectRegion, createColor, snapTime, hint, z = 'z-[1]' }: {
  duration: number;
  onVizClick: (t: number) => void;
  onVizRegion: (t1: number, t2: number) => void;
  onRegionDragStart?: () => void;
  /** ⇧/⌘-drag: pick this lane's items inside the stretch instead of
   *  highlighting it. Absent on lanes whose items can't be picked. */
  onSelectRegion?: (t1: number, t2: number) => void;
  /** Set on an editable lane whose drag CREATES an item (see laneCreate.ts):
   *  the drag paints in the lane's colour instead of the teal highlight, so it
   *  reads as the item it is about to become rather than a selection. */
  createColor?: string;
  /** Snap both ends live while dragging, so the band lands where the item
   *  will — the item is snapped by the same rule when it is made. */
  snapTime?: (t: number) => number;
  /** Tooltip for the empty lane — what a click and a drag do here. */
  hint?: string;
  z?: string;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // Decided at the press. The ref is what the gesture reads (its callbacks
  // fire inside the same press, before a state update lands); the state only
  // colours the drag after what it will do.
  const selectingRef = useRef(false);
  const [selecting, setSelecting] = useState(false);
  const drag = useRegionSelectDrag({
    containerRef: surfaceRef,
    durationGetter: () => duration,
    transform: snapTime,
    onDragStart: () => { if (!selectingRef.current) onRegionDragStart?.(); },
    onClick: onVizClick,
    onRegion: (t1, t2) => (selectingRef.current && onSelectRegion ? onSelectRegion(t1, t2) : onVizRegion(t1, t2)),
  });
  const sel = drag.preview;
  const edge = selecting ? 'rgba(255,255,255,0.85)' : createColor ?? 'rgba(45,212,191,0.7)';
  const fill = selecting ? 'rgba(255,255,255,0.12)' : createColor ? `${createColor}55` : 'rgba(45,212,191,0.13)';

  return (
    <div
      ref={surfaceRef}
      className={`absolute inset-0 touch-pan-y ${z}`}
      style={{ cursor: 'crosshair' }}
      onPointerDown={(e) => {
        const pick = !!onSelectRegion && isSelectToggle(e);
        selectingRef.current = pick;
        setSelecting(pick);
        drag.onPointerDown(e);
      }}
      title={hint ?? (onSelectRegion ? 'Drag to highlight · ⇧-drag to select the items inside' : undefined)}
    >
      {sel && duration > 0 && (
        <div
          className="absolute top-0 bottom-0 pointer-events-none"
          style={{
            left: `${(Math.min(sel.s, sel.e) / duration) * 100}%`,
            width: `${(Math.abs(sel.e - sel.s) / duration) * 100}%`,
            minWidth: 1,
            background: fill,
            borderLeft: `2px solid ${edge}`,
            borderRight: Math.abs(sel.e - sel.s) > 0.1 ? `2px solid ${edge}` : 'none',
          }}
        />
      )}
    </div>
  );
}

// ─── Auto-guess interactive overlay (exported for use as standalone row) ─────

export interface AutoGuessOverlayProps {
  points: AutoGuessPoint[];
  duration: number;
  isPlaying: boolean;
  onMarkCorrect: (id: string) => void;
  onMarkIncorrect: (id: string) => void;
  onMarkPending: (id: string) => void;
  onPlay: (time: number, stopTime: number) => void;
  onPause: () => void;
  /** Per-point IDs that should render the full review-button cluster regardless of zoom.
   *  Toggled by clicking the inline expand chevron or the section block above. */
  expandedPointIds?: Set<string>;
  onToggleExpanded?: (pointId: string) => void;
  /** Zoom multiplier ≥ this value forces all points expanded.
   *  When 0, every point is always expanded (legacy behavior). */
  expandZoomThreshold?: number;
  /** Current player zoom multiplier (1 = fit). */
  zoomFactor?: number;
}

export function AutoGuessOverlay({
  points, duration, isPlaying,
  onMarkCorrect, onMarkIncorrect, onMarkPending, onPlay, onPause,
  expandedPointIds, onToggleExpanded,
  expandZoomThreshold = 0,
  zoomFactor = 1,
}: AutoGuessOverlayProps) {
  const sorted = [...points].sort((a, b) => a.time - b.time);
  // The point whose [time, next point) holds the playhead while playing, as an
  // index — the overlay re-renders when playback crosses a point, not per frame.
  const playingIndex = usePlayheadValue((t) => {
    if (!isPlaying) return -1;
    for (let i = 0; i < sorted.length; i++) {
      const nextTime = sorted[i + 1]?.time ?? duration;
      if (t >= sorted[i].time && t < nextTime) return i;
    }
    return -1;
  });
  // When threshold=0 the row stays in its legacy always-expanded mode.
  // Above 0 we collapse below the threshold and let users opt-in per-point.
  const autoExpanded = expandZoomThreshold <= 0 || zoomFactor >= expandZoomThreshold;

  return (
    <div className="relative w-full" style={{ height: 52, background: 'rgba(20,184,166,0.04)', borderRadius: 4 }}>
      {sorted.map((point, i) => {
        const nextTime = sorted[i + 1]?.time ?? duration;
        const isThisPlaying = i === playingIndex;
        const pct = duration > 0 ? (point.time / duration) * 100 : 0;
        const lineColor =
          point.status === 'correct'   ? '#14b8a6' :
          point.status === 'incorrect' ? '#f87171' :
          point.status === 'partial'   ? '#f59e0b' : '#6b7280';
        const isManuallyExpanded = expandedPointIds?.has(point.id) ?? false;
        const showButtons = autoExpanded || isManuallyExpanded;
        const canCollapse = !!onToggleExpanded && expandZoomThreshold > 0;
        return (
          <div key={point.id} className="absolute top-0 bottom-0" style={{ left: `${pct}%`, zIndex: 5 }}>
            <div className="absolute top-0 bottom-0" style={{ left: 0, width: 2, background: lineColor, opacity: 0.85 }} />
            <div className="absolute flex items-center gap-px" style={{ top: 2, left: 0, transform: 'translateX(-50%)', zIndex: 10 }}>
              {showButtons ? (
                <>
                  {/* Collapse chevron — only present when the row is collapsible (threshold > 0)
                      and the point is currently expanded BELOW the auto-threshold. */}
                  {canCollapse && !autoExpanded && (
                    <button
                      onMouseDown={(e) => { e.stopPropagation(); onToggleExpanded!(point.id); }}
                      className="w-[14px] h-[18px] rounded flex items-center justify-center text-[9px] transition-colors bg-gray-900/90 border border-gray-600 text-gray-400 hover:text-gray-200 hover:border-gray-400"
                      title="Collapse"
                    >‹</button>
                  )}
                  <button
                    onMouseDown={(e) => { e.stopPropagation(); isThisPlaying ? onPause() : onPlay(point.time, nextTime); }}
                    className={`w-[18px] h-[18px] rounded flex items-center justify-center text-[9px] transition-colors border ${
                      isThisPlaying
                        ? 'bg-red-600/80 border-red-500 text-white'
                        : 'bg-gray-900/90 border-gray-600 text-green-400 hover:border-green-500 hover:text-green-300'
                    }`}
                    title={isThisPlaying ? 'Stop' : `Play from ${(point.time / 60 | 0)}:${(point.time % 60).toFixed(1).padStart(4, '0')}`}
                  >
                    {isThisPlaying ? '⏹' : '▶'}
                  </button>
                  <button
                    onMouseDown={(e) => { e.stopPropagation(); point.status === 'correct' ? onMarkPending(point.id) : onMarkCorrect(point.id); }}
                    className={`w-[18px] h-[18px] rounded flex items-center justify-center text-[10px] font-bold transition-colors ${
                      point.status === 'correct'
                        ? 'bg-teal-600 text-white'
                        : 'bg-gray-900/90 border border-gray-600 text-gray-500 hover:bg-teal-700/60 hover:text-teal-200'
                    }`}
                    title={point.status === 'correct' ? 'Revert to pending' : 'Mark correct'}
                  >✓</button>
                  <button
                    onMouseDown={(e) => { e.stopPropagation(); point.status === 'incorrect' ? onMarkPending(point.id) : onMarkIncorrect(point.id); }}
                    className={`w-[18px] h-[18px] rounded flex items-center justify-center text-[10px] font-bold transition-colors ${
                      point.status === 'incorrect'
                        ? 'bg-rose-500 text-white'
                        : 'bg-gray-900/90 border border-gray-600 text-gray-500 hover:bg-rose-500/60 hover:text-rose-200'
                    }`}
                    title={point.status === 'incorrect' ? 'Revert to pending' : 'Mark incorrect'}
                  >✗</button>
                </>
              ) : (
                /* Collapsed: a single compact "expand" chevron. Status is conveyed by the
                   line color and a colored ring around the button. */
                <button
                  onMouseDown={(e) => { e.stopPropagation(); onToggleExpanded?.(point.id); }}
                  className="w-[16px] h-[16px] rounded flex items-center justify-center text-[10px] leading-none transition-colors bg-gray-900/90 border text-gray-300 hover:text-white"
                  style={{ borderColor: lineColor, boxShadow: `0 0 4px ${lineColor}55` }}
                  title={`Review point @ ${(point.time / 60 | 0)}:${(point.time % 60).toFixed(1).padStart(4, '0')} (×${agreementCount(point)})`}
                >›</button>
              )}
            </div>
            <div
              className="absolute text-[10px] font-bold whitespace-nowrap pointer-events-none"
              style={{ bottom: 3, left: 3, color: lineColor, opacity: 0.8 }}
            >
              ×{agreementCount(point)}
            </div>
          </div>
        );
      })}
      <PlayheadLine
        duration={duration}
        style={{ background: 'rgba(255,255,255,0.75)', boxShadow: '0 0 3px rgba(255,255,255,0.4)', zIndex: 4 }}
      />
    </div>
  );
}

// ─── Combined annotation overlay (manual lines + pending highlight) ─

export interface AnnotationOverlaysProps {
  duration: number;
  isPlaying: boolean;
  // Manual
  manualSections?: SectionBlock[];
  showManual?: boolean;
  /** Drag a manual marker cap to retime that section's boundary. Same
   *  callback as SectionBlockRow's onBoundaryChange — clamps to neighbours
   *  via the same clamp logic on the page side. */
  onManualMarkerDrag?: (sectionIdx: number, time: number) => void;
  onManualMarkerDragStart?: () => void;
  // Pending selection
  pendingSelection?: PendingSelection | null;
  /** Beat-grid info — when present, boundaries lying on a grid line render a
   *  small violet "snapped" indicator. Decoupled from grid-overlay visibility
   *  so users still see snap state even with the grid hidden. */
  grid?: GridSnapInfo;
}

export function AnnotationOverlays({
  duration,
  manualSections, showManual,
  onManualMarkerDrag, onManualMarkerDragStart,
  pendingSelection,
  grid,
}: AnnotationOverlaysProps) {
  // Container ref: a thin absolute layer over the host signal row gives the
  // drag hook a stable bounding box for the time-axis mapping. Children
  // remain inside it, so percentage positioning is unchanged.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sectionsRef = useRef(manualSections);
  sectionsRef.current = manualSections;

  const { startDrag: startManualDrag } = useTimelineDrag<{ idx: number }>({
    containerRef,
    duration,
    onDragStart: () => onManualMarkerDragStart?.(),
    onDrag: ({ idx }, t) => onManualMarkerDrag?.(idx, t),
    clamp: ({ idx }, raw) => {
      const secs = sectionsRef.current;
      if (!secs) return Math.max(0, Math.min(duration, raw));
      const prevTime = secs[idx - 1]?.time ?? 0;
      const nextTime = secs[idx + 1]?.time ?? duration;
      return Math.max(prevTime + 0.1, Math.min(nextTime - 0.1, raw));
    },
  });
  if (duration <= 0) return null;

  const manualDraggable = !!onManualMarkerDrag;

  return (
    <div ref={containerRef} className="absolute inset-0 pointer-events-none">
      {showManual && manualSections?.map((s, i) =>
        s.candidates?.map((t, ci) => (
          <ManualCandidateMarkerLine key={`c-${i}-${ci}`} t={t} sectionIndex={i} type={s.type} duration={duration} />
        ))
      )}
      {showManual && manualSections?.map((s, i) => (
        <ManualMarkerLine
          key={i} s={s} i={i} duration={duration} grid={grid}
          onPointerDown={manualDraggable ? (e, idx) => startManualDrag({ idx }, e) : undefined}
        />
      ))}
      {pendingSelection && (
        <PendingHighlightOverlay sel={pendingSelection} duration={duration} grid={grid} />
      )}
    </div>
  );
}
