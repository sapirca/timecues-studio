import { useRef } from 'react';
import type { ManualSection, AutoGuessPoint } from '../../types/manualAnnotation';
import { isOnGridLine, SNAP_INDICATOR_COLOR } from '../../utils/snapIndication';
import { SnapTick } from './SnapIndicator';
import { useTimelineDrag } from '../../hooks/useTimelineDrag';

/** Grid info needed to decide whether a boundary lies on a beat-grid line.
 *  Optional everywhere — when bpm is undefined, the snap indicator simply
 *  doesn't render and the existing visuals are unchanged. */
export interface GridSnapInfo {
  bpm?: number;
  gridOffset?: number;
  beatsPerBar?: number;
}

// ─── Color map ────────────────────────────────────────────────────────────────

const SECTION_COLORS: Record<string, string> = {
  intro:     '#a78bfa', bridge: '#fb7185', buildup: '#fde047',
  drop:      '#4ade80', breakdown: '#e879f9', outro: '#64748b',
  silence:   '#334155', default: '#94a3b8',
};
function sectionBg(type: string) { return SECTION_COLORS[type] ?? SECTION_COLORS.default; }

// ─── Manual markers ─────────────────────────────────────────────────────────────

// Lane offsets: each layer's number label sits in its own horizontal band at the
// top of the signal, so coincident Manual/Eye boundaries don't render their labels
// on top of each other. Each line also gets a tiny colored "cap" in its lane so
// the layer is identifiable even when the 1px lines occlude one another.
const LANE_MANUAL_TOP = 1;   // px — row 1
const LANE_EYE_TOP  = 10;  // px — row 2
const LANE_CAP_W    = 5;   // px — width of the colored cap that sits inside the lane

function ManualMarkerLine({ s, i, duration, grid, onMouseDown }: {
  s: ManualSection; i: number; duration: number; grid?: GridSnapInfo;
  /** When provided, the cap+number patch becomes a drag handle. */
  onMouseDown?: (e: React.MouseEvent, sectionIdx: number) => void;
}) {
  const color = sectionBg(s.type);
  const snapped = isOnGridLine(s.time, grid?.bpm, grid?.gridOffset, grid?.beatsPerBar);
  const draggable = !!onMouseDown;
  return (
    <div
      className="absolute top-0 bottom-0 pointer-events-none z-10"
      style={{ left: `${(s.time / duration) * 100}%` }}
    >
      <div className="absolute inset-y-0 left-0 w-px" style={{ background: color, opacity: 0.9 }} />
      {/* Lane cap — also serves as the drag handle when onMouseDown is wired. */}
      <div
        className={`absolute ${draggable ? 'pointer-events-auto cursor-ew-resize' : ''}`}
        style={{ top: LANE_MANUAL_TOP, left: -3, width: LANE_CAP_W + 6, height: 12, background: color, opacity: 0.9, borderRadius: 1 }}
        onMouseDown={onMouseDown ? (e) => onMouseDown(e, i) : undefined}
        title={draggable ? `Manual boundary ${i + 1} · drag to reposition` : undefined}
      />
      {snapped && (
        <SnapTick
          style={{ top: LANE_MANUAL_TOP - 5, left: -1 }}
          title={`Manual boundary ${i + 1} is on the beat grid`}
        />
      )}
      <div
        className="absolute text-[7px] font-mono leading-none select-none pointer-events-none"
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
        className="absolute text-[6px] font-mono leading-none select-none"
        style={{ top: 10, left: 2, color, opacity: 0.55, textShadow: '0 0 3px rgba(0,0,0,0.9)' }}
      >
        {sectionIndex + 1}·
      </div>
    </div>
  );
}

// ─── Eye markers ──────────────────────────────────────────────────────────────

function EyeMarkerLine({ t, i, duration, grid, onMouseDown }: {
  t: number; i: number; duration: number; grid?: GridSnapInfo;
  /** When provided, the cap+number patch becomes a drag handle. */
  onMouseDown?: (e: React.MouseEvent, pointIdx: number) => void;
}) {
  const snapped = isOnGridLine(t, grid?.bpm, grid?.gridOffset, grid?.beatsPerBar);
  const draggable = !!onMouseDown;
  return (
    <div
      className="absolute top-0 bottom-0 pointer-events-none z-10"
      style={{ left: `${(t / duration) * 100}%` }}
    >
      <div className="absolute inset-y-0 left-0 w-px" style={{ background: '#2dd4bf', opacity: 0.9 }} />
      {/* Lane cap doubles as drag handle when onMouseDown is wired. */}
      <div
        className={`absolute ${draggable ? 'pointer-events-auto cursor-ew-resize' : ''}`}
        style={{ top: LANE_EYE_TOP, left: -3, width: LANE_CAP_W + 6, height: 12, background: '#2dd4bf', opacity: 0.9, borderRadius: 1 }}
        onMouseDown={onMouseDown ? (e) => onMouseDown(e, i) : undefined}
        title={draggable ? `Eye point ${i + 1} · drag to reposition` : undefined}
      />
      {snapped && (
        <SnapTick
          style={{ top: LANE_EYE_TOP + 8, left: -1 }}
          title={`Eye boundary ${i + 1} is on the beat grid`}
        />
      )}
      <div
        className="absolute text-[7px] font-mono leading-none text-teal-300 select-none pointer-events-none"
        style={{ top: LANE_EYE_TOP, left: LANE_CAP_W + 1, textShadow: '0 0 4px rgba(0,0,0,0.9)' }}
      >
        {i + 1}
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
  const snapped = isOnGridLine(sel.t1, grid?.bpm, grid?.gridOffset, grid?.beatsPerBar);
  return (
    <div
      className="absolute top-0 bottom-0 pointer-events-none z-20"
      style={{ left: `${(sel.t1 / duration) * 100}%`, width: '2px', background: snapped ? SNAP_INDICATOR_COLOR : '#2dd4bf' }}
    >
      {snapped && <SnapTick style={{ top: 2, left: -2 }} title="Pending boundary is on the beat grid" />}
    </div>
  );
}

// ─── Auto-guess interactive overlay (exported for use as standalone row) ─────

export interface AutoGuessOverlayProps {
  points: AutoGuessPoint[];
  duration: number;
  currentTime: number;
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
  points, duration, currentTime, isPlaying,
  onMarkCorrect, onMarkIncorrect, onMarkPending, onPlay, onPause,
  expandedPointIds, onToggleExpanded,
  expandZoomThreshold = 0,
  zoomFactor = 1,
}: AutoGuessOverlayProps) {
  const sorted = [...points].sort((a, b) => a.time - b.time);
  const playheadPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  // When threshold=0 the row stays in its legacy always-expanded mode.
  // Above 0 we collapse below the threshold and let users opt-in per-point.
  const autoExpanded = expandZoomThreshold <= 0 || zoomFactor >= expandZoomThreshold;

  return (
    <div className="relative w-full" style={{ height: 52, background: 'rgba(20,184,166,0.04)', borderRadius: 4 }}>
      {sorted.map((point, i) => {
        const nextTime = sorted[i + 1]?.time ?? duration;
        const isThisPlaying = isPlaying && currentTime >= point.time && currentTime < nextTime;
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
                        ? 'bg-red-700 text-white'
                        : 'bg-gray-900/90 border border-gray-600 text-gray-500 hover:bg-red-800/60 hover:text-red-200'
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
                  title={`Review point @ ${(point.time / 60 | 0)}:${(point.time % 60).toFixed(1).padStart(4, '0')} (×${point.clusterSize})`}
                >›</button>
              )}
            </div>
            <div
              className="absolute text-[8px] font-bold whitespace-nowrap pointer-events-none"
              style={{ bottom: 3, left: 3, color: lineColor, opacity: 0.8 }}
            >
              ×{point.clusterSize}
            </div>
          </div>
        );
      })}
      <div
        className="absolute top-0 bottom-0 w-px pointer-events-none"
        style={{ left: `${playheadPct}%`, background: 'rgba(255,255,255,0.75)', boxShadow: '0 0 3px rgba(255,255,255,0.4)', zIndex: 4 }}
      />
    </div>
  );
}

// ─── Combined annotation overlay (manual lines + eye lines + pending highlight) ─

export interface AnnotationOverlaysProps {
  duration: number;
  currentTime: number;
  isPlaying: boolean;
  // Manual
  manualSections?: ManualSection[];
  showManual?: boolean;
  /** Drag a manual marker cap to retime that section's boundary. Same
   *  callback as SectionBlockRow's onBoundaryChange — clamps to neighbours
   *  via the same clamp logic on the page side. */
  onManualMarkerDrag?: (sectionIdx: number, time: number) => void;
  onManualMarkerDragStart?: () => void;
  // Eye
  eyeTimes?: number[];
  showEye?: boolean;
  /** Drag an eye marker cap to retime the point. */
  onEyeMarkerDrag?: (pointIdx: number, time: number) => void;
  onEyeMarkerDragStart?: () => void;
  // Pending (eye selection)
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
  eyeTimes, showEye,
  onEyeMarkerDrag, onEyeMarkerDragStart,
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
  const { startDrag: startEyeDrag } = useTimelineDrag<{ idx: number }>({
    containerRef,
    duration,
    onDragStart: () => onEyeMarkerDragStart?.(),
    onDrag: ({ idx }, t) => onEyeMarkerDrag?.(idx, t),
    // Eye points may cross each other during a drag — the EyeEditorPanel
    // re-sorts on close, so we only clamp to the song bounds here.
  });

  if (duration <= 0) return null;

  const manualDraggable = !!onManualMarkerDrag;
  const eyeDraggable = !!onEyeMarkerDrag;

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
          onMouseDown={manualDraggable ? (e, idx) => startManualDrag({ idx }, e) : undefined}
        />
      ))}
      {showEye && eyeTimes?.map((t, i) => (
        <EyeMarkerLine
          key={i} t={t} i={i} duration={duration} grid={grid}
          onMouseDown={eyeDraggable ? (e, idx) => startEyeDrag({ idx }, e) : undefined}
        />
      ))}
      {pendingSelection && (
        <PendingHighlightOverlay sel={pendingSelection} duration={duration} grid={grid} />
      )}
    </div>
  );
}
