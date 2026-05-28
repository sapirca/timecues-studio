import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTimelineDrag } from '../../hooks/useTimelineDrag';
import { PlayerPanel, type PlayerAccent } from '../PlayerPanel';
import { StemSourcePicker } from './StemSourcePicker';
import type { StemSource } from '../../pages/InspectorPageV2';
import { FrequencyWaveform } from '../FrequencyWaveform';
import { SpectrogramAnnotated } from '../SpectrogramAnnotated';
import { CepstrogramAnnotated } from '../CepstrogramAnnotated';
import { ChromagramAnnotated } from '../ChromagramAnnotated';
import { TempogramAnnotated } from '../TempogramAnnotated';
import { SsmAnnotated } from '../SsmAnnotated';
import EQVisualizer from '../EQVisualizer';
import { TimeRuler } from '../TimeRuler';
import {
  AnnotationOverlays,
  AutoGuessOverlay,
  PendingHighlightOverlay,
  type PendingSelection,
} from './AnnotationOverlays';
import { PreviewWindow, type PreviewRegion } from './PreviewWindow';
import { LayerAudioControls, type LayerAudioConfig, DEFAULT_LAYER_AUDIO } from './LayerAudioControls';
import { TimeDisplayBar } from './TimeDisplayBar';
import { BeatGridOverlay } from './BeatGridOverlay';
import { CueLayerRow } from './CueLayerRow';
import { LoopLayerRow } from './LoopLayerRow';
import { SpanLaneRow } from './SpanLaneRow';
import { PatternLaneRow } from './PatternLaneRow';
import { AnnotationPointCard } from './shared/AnnotationPointCard';
import { useAnnotationPopover } from './shared/useAnnotationPopover';
import { PATTERN_SUBBEATS_PER_BEAT } from '../../types/annotationLayer';
import type { ManualSection, AutoGuessPoint } from '../../types/manualAnnotation';
import type { AnnotationLayer } from '../../types/annotationLayer';
import { useBoundaryAudioFeedback } from '../../hooks/useBoundaryAudioFeedback';
import { isTypingTarget } from '../../hooks/useAnnotationShortcuts';
import { useSettings } from '../../context/SettingsContext';
import { snapTimeToGrid } from '../../utils/beatGrid';

// ─── Section color map ────────────────────────────────────────────────────────

const SECTION_COLORS: Record<string, string> = {
  intro: '#a78bfa', bridge: '#fb7185', buildup: '#fde047',
  drop: '#4ade80', breakdown: '#e879f9', outro: '#64748b',
  silence: '#334155', autoGuess: '#e879f9', default: '#94a3b8',
};
function sectionBg(type: string) { return SECTION_COLORS[type] ?? SECTION_COLORS.default; }

// ─── Row ordering ─────────────────────────────────────────────────────────────

export type VizRowId = string; // fixed IDs + dynamic algo overlay IDs
export const DEFAULT_FIXED_ROW_ORDER: VizRowId[] = ['waveform', 'eq', 'manual', 'eye', 'autoGuess', 'spectrogram', 'cepstrogram', 'chroma', 'tempogram', 'ssm', 'energy', 'brightness', 'novelty', 'onsets', 'flux'];
const FIXED_ROW_IDS = new Set(DEFAULT_FIXED_ROW_ORDER);

// ─── Row label ────────────────────────────────────────────────────────────────
// The label cell doubles as a drag handle: drag any row's label to reorder.
//
// Labels stick to the scroll container's left edge so they stay visible when
// the user pans the horizontally-scrolling viz. The label cell itself drops
// `gap-2`, so its solid bg literally is the gutter: signals scrolling
// underneath hit a hard cut at content-start, with no thin strip peeking
// past the title. `pr-2` gives the right-aligned text breathing room.
//
// Width is `--viz-label-w` PLUS 0.5rem. The non-label sibling rows (player,
// palette, layer-audio, the auto-guess review strip) align their content
// with a `w-[var(--viz-label-w)]` spacer *followed by* a `gap-2`, so their
// content begins at `var + 0.5rem`. Folding that same 0.5rem into the label
// width lands the label's right edge — and thus every data row's content
// start — at the exact same x as those spacer rows. Without it, label rows
// sat 0.5rem to the left of the waveform/spectro/etc. and the per-row
// content visibly failed to line up.
//
// A single resize handle on any row label drives `--viz-label-w`, widening
// the gutter across every row uniformly. Falls back to 4.5rem when the var
// is unset (e.g. when the cell renders inside a non-Shared-viz context).
const STICKY_LABEL_CELL = 'w-[calc(var(--viz-label-w,4.5rem)_+_0.5rem)] shrink-0 sticky left-0 z-30 bg-gray-900 pr-2 flex items-center justify-end relative';

interface RowDragHandlers {
  draggable: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
}

/** Thin vertical grippy on the right edge of every label cell — pointerdown
 *  starts a column-wide resize that updates `--viz-label-w`. Shared between
 *  RowLabel and LayerRowLabel so every gutter cell exposes the affordance. */
function LabelResizeHandle({ onResizeStart }: { onResizeStart?: (e: React.PointerEvent) => void }) {
  if (!onResizeStart) return null;
  return (
    <div
      onPointerDown={onResizeStart}
      // Stop the parent label's mousedown so HTML5 drag (row reorder) and
      // the click-to-select handler don't fire when the user grabs the
      // grippy. preventDefault on dragstart is the only thing that actually
      // suppresses the browser-initiated drag on a draggable=true parent.
      onMouseDown={(e) => e.stopPropagation()}
      onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onClick={(e) => e.stopPropagation()}
      draggable={false}
      title="Drag to resize the label column"
      className="absolute top-0 right-0 h-full w-1.5 -mr-0.5 cursor-col-resize z-40 hover:bg-cyan-400/40 active:bg-cyan-400/60 transition-colors"
    />
  );
}

function RowLabel({ text, color = 'text-gray-600', dragHandlers, onResizeStart, wrap = false }: {
  text: string; color?: string;
  dragHandlers?: RowDragHandlers;
  onResizeStart?: (e: React.PointerEvent) => void;
  wrap?: boolean;
}) {
  return (
    <div
      className={`${STICKY_LABEL_CELL} ${dragHandlers ? 'cursor-grab active:cursor-grabbing' : ''}`}
      draggable={dragHandlers?.draggable}
      onDragStart={dragHandlers?.onDragStart}
      onDragEnd={dragHandlers?.onDragEnd}
      title={dragHandlers ? 'Drag to reorder' : undefined}
    >
      <span
        className={`text-[10px] uppercase tracking-wide text-right leading-tight min-w-0 flex-1 ${wrap ? 'break-words' : 'truncate'} ${color}`}
        title={text}
      >{text}</span>
      <LabelResizeHandle onResizeStart={onResizeStart} />
    </div>
  );
}

// ─── Layer row label — click-to-select with neon active highlight ─────────
/** Annotation-layer types whose viz rows accept click-to-select. */
type SelectableLayerType = 'cues' | 'spans' | 'loops' | 'patterns';
/** Payload sent up when the user clicks a viz row label — same shape as the
 *  unified-sidebar selection so the page handler accepts both call sites. */
export interface VizLayerSelection {
  id: string;
  sourceId: 'manual' | `detector:${string}`;
  name: string;
  readOnly: boolean;
}

function LayerRowLabel({
  layer,
  isSelected,
  onSelect,
  dragHandlers,
  onResizeStart,
}: {
  layer: AnnotationLayer;
  isSelected: boolean;
  onSelect?: () => void;
  dragHandlers?: RowDragHandlers;
  onResizeStart?: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      className={`${STICKY_LABEL_CELL} transition-colors ${
        dragHandlers ? 'cursor-grab active:cursor-grabbing' : ''
      } ${onSelect ? 'hover:bg-[#161a21]' : ''}`}
      style={isSelected ? {
        // Solid #0a0b0d base under the tint gradient. The gradient's left stop
        // is the layer color at ~13% alpha, so without an opaque layer behind
        // it, horizontally-scrolled row content bleeds through the sticky title.
        background: `linear-gradient(90deg, ${layer.color}22 0%, #0a0b0d 100%), #0a0b0d`,
        boxShadow: `inset 3px 0 0 0 ${layer.color}, inset -1px 0 0 0 ${layer.color}66`,
      } : undefined}
      draggable={dragHandlers?.draggable}
      onDragStart={dragHandlers?.onDragStart}
      onDragEnd={dragHandlers?.onDragEnd}
      onClick={onSelect}
      onKeyDown={onSelect ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }
      } : undefined}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      title={onSelect
        ? `${layer.name} — click to make this the active layer (switches the tab + ADD+ target)`
        : (dragHandlers ? 'Drag to reorder' : layer.name)}
    >
      <span
        className={`text-[10px] uppercase tracking-wide text-right leading-tight break-words ${
          isSelected ? 'font-bold' : ''
        }`}
        style={{
          color: layer.color,
          textShadow: isSelected ? `0 0 6px ${layer.color}cc, 0 0 12px ${layer.color}66` : undefined,
        }}
      >
        {layer.name}
      </span>
      <LabelResizeHandle onResizeStart={onResizeStart} />
    </div>
  );
}

// ─── Shared grid overlay props ────────────────────────────────────────────────

interface GridProps {
  bpm?: number;
  gridOffset?: number;
  beatsPerBar?: number;
  barGroupSize?: number | null;
  /** Subdivide each beat (2 = 1/2 beat, 3 = triplet, 4 = 1/4 beat, 6 = 16th
   *  triplet, 8 = 1/8 beat). Ignored when barGroupSize is set. */
  subBeatDivision?: number;
  /** Compound-pulse step: only emit lines every N beats (3 for 6/8/9/8/12/8).
   *  Ignored when barGroupSize is set. */
  beatGroupSize?: number;
  /** Optional tempo anchors. Piecewise-constant tempo when present. */
  anchors?: readonly import('../../types/songInfo').TempoAnchor[];
  /** Optional per-beat overrides (Manual mode). */
  beatOverrides?: Readonly<Record<string, number>>;
  /** Grid-line width multiplier (1 = default). */
  thickness?: number;
}

// ─── Section block row ────────────────────────────────────────────────────────

function SectionBlockRow({ sections, duration, currentTime, height = 22, onBoundaryChange, onBoundaryDragStart, onSectionClick, sectionColorOverrides, gridProps, pendingSelection }: {
  sections: { time: number; endTime: number; label: string; type: string; color?: string; importance?: string }[];
  duration: number;
  currentTime: number;
  height?: number;
  onBoundaryChange?: (nextSectionIndex: number, newTime: number) => void;
  onBoundaryDragStart?: () => void;
  onSectionClick?: (sectionIndex: number, anchor: { x: number; y: number }) => void;
  sectionColorOverrides?: Record<string, string>;
  gridProps?: GridProps;
  pendingSelection?: PendingSelection | null;
}) {
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const containerRef = useRef<HTMLDivElement>(null);
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;

  const { startDrag: startBoundaryDrag } = useTimelineDrag<{ nextIdx: number }>({
    containerRef,
    duration,
    onDragStart: () => { onBoundaryDragStart?.(); },
    onDrag: ({ nextIdx }, t) => { onBoundaryChange?.(nextIdx, t); },
    clamp: ({ nextIdx }, raw) => {
      const secs = sectionsRef.current;
      const prevTime = secs[nextIdx - 1]?.time ?? 0;
      const nextTime = secs[nextIdx + 1]?.time ?? duration;
      return Math.max(prevTime + 0.1, Math.min(nextTime - 0.1, raw));
    },
  });

  return (
    <div ref={containerRef} className="flex-1 relative rounded overflow-hidden bg-gray-950" style={{ height }}>
      {sections.map((s, i) => {
        const left  = duration > 0 ? (s.time / duration) * 100 : 0;
        const width = Math.max(0.3, duration > 0 ? ((s.endTime - s.time) / duration) * 100 : 0);
        const isUnset = s.type === 'unset';
        const baseColor = s.color ?? sectionColorOverrides?.[s.type] ?? sectionBg(s.type);
        const isOptional = s.importance === 'optional';
        const bg = isUnset
          ? 'transparent'
          : isOptional
            ? `radial-gradient(circle, ${baseColor}55 1px, transparent 1.6px) 0 0 / 6px 6px, ${baseColor}aa`
            : baseColor;
        const isLast = i === sections.length - 1;
        return (
          <div
            key={i}
            className={`absolute top-0 bottom-0 overflow-hidden ${onSectionClick ? 'cursor-pointer hover:ring-1 hover:ring-white/40' : ''}`}
            style={{ left: `${left}%`, width: `${width}%`, background: bg, opacity: isUnset ? 1 : (isOptional ? 0.85 : (i % 2 === 0 ? 1 : 0.85)), borderRight: '1px solid rgba(0,0,0,0.4)' }}
            title={onSectionClick ? `Click to edit · ${s.label}` : `${s.label} @ ${(s.time / 60 | 0)}:${(s.time % 60).toFixed(0).padStart(2, '0')}${isOptional ? ' (optional)' : ''}`}
            onClick={onSectionClick ? (e) => { e.stopPropagation(); onSectionClick(i, { x: e.clientX, y: e.clientY }); } : undefined}
          >
            {!isUnset && (
              <span className="absolute inset-x-0.5 top-0.5 text-[8px] truncate text-white/80 pointer-events-none select-none leading-none">
                {isOptional ? `○ ${s.label}` : s.label}
              </span>
            )}
          </div>
        );
      })}
      {/* Handles must be siblings (not children) of the section divs: each
          section's opacity creates a stacking context, so a handle nested
          inside section 0 was unreachable past the boundary line. */}
      {onBoundaryChange && sections.map((s, i) => {
        // Boundary i sits at sections[i].start. The leftmost boundary only
        // renders when the first section starts past t=0 — otherwise the 8px
        // handle would be half-clipped at the container edge with nowhere to
        // slide. When the user did push section 0 in from t=0 (e.g. there's
        // silence/lead-in before it), they need this handle to move its
        // start back.
        if (i === 0 && s.time <= 0.01) return null;
        const leftPct = duration > 0 ? (s.time / duration) * 100 : 0;
        return (
          <div
            key={`boundary-${i}`}
            className="absolute top-0 bottom-0 z-30 cursor-ew-resize"
            style={{
              left: `${leftPct}%`,
              width: 8,
              transform: 'translateX(-50%)',
              background: 'rgba(255,255,255,0.18)',
            }}
            onMouseDown={(e) => startBoundaryDrag({ nextIdx: i }, e)}
            onClick={(e) => e.stopPropagation()}
            title={`Boundary @ ${(s.time / 60 | 0)}:${(s.time % 60).toFixed(1).padStart(4, '0')} · drag to reposition`}
          />
        );
      })}
      {gridProps && (
        <BeatGridOverlay
          bpm={gridProps.bpm}
          gridOffset={gridProps.gridOffset}
          beatsPerBar={gridProps.beatsPerBar}
          barGroupSize={gridProps.barGroupSize} beatGroupSize={gridProps.beatGroupSize}
          subBeatDivision={gridProps.subBeatDivision}
          anchors={gridProps.anchors}
          beatOverrides={gridProps.beatOverrides}
          thickness={gridProps.thickness}
          duration={duration}
        />
      )}
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

// ─── Sparkline row ────────────────────────────────────────────────────────────

// Max internal-buffer width before the canvas hits the browser's max-canvas
// size and renders a broken-image placeholder. At Ultra zoom the CSS width can
// exceed this, so we drop the effective dpr to keep the buffer underneath the
// limit — the sparkline appears softer but always paints.
const SPARKLINE_MAX_BUFFER_PX = 32_000;

// Small animated badge surfaced over the row while the buffer is being soft-
// clamped at Ultra zoom. Replaces the browser's broken-image placeholder.
function SoftClampSpinner() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="5" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="1.5" />
      <path d="M 7 2 A 5 5 0 0 1 12 7" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="1.5" strokeLinecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0 7 7" to="360 7 7" dur="0.9s" repeatCount="indefinite" />
      </path>
    </svg>
  );
}

function Sparkline({ data, color, height = 40, currentTime, duration, label, onSeek, onRegion, onRegionDragStart, dragHandlers, onResizeStart, overlay, pendingSelection, signalMarkers, gridProps }: {
  data: number[]; color: string; height?: number;
  currentTime: number; duration: number; label: string;
  onSeek?: (t: number) => void;
  onRegion?: (t1: number, t2: number) => void;
  onRegionDragStart?: () => void;
  dragHandlers?: RowDragHandlers;
  onResizeStart?: (e: React.PointerEvent) => void;
  overlay?: {
    manualSections?: ManualSection[]; showManual: boolean;
    eyeTimes: number[]; showEye: boolean;
    onManualMarkerDrag?: (idx: number, t: number) => void;
    onEyeMarkerDrag?: (idx: number, t: number) => void;
    onEyeMarkerDragStart?: () => void;
  };
  /** Pending Mark In/Out highlight. Shown regardless of the "Overlay on signals"
   *  toggle so an in-progress two-step selection stays visible across every row. */
  pendingSelection?: PendingSelection | null;
  signalMarkers?: { points: SignalPointMarker[]; bands: SignalBandMarker[] };
  gridProps?: GridProps;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const h = height;

  const [softening, setSoftening] = useState(false);
  const softenTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (softenTimerRef.current != null) window.clearTimeout(softenTimerRef.current);
  }, []);

  // Repaint at native pixel resolution (devicePixelRatio-aware) so the curve
  // stays crisp at any container width. Mirrors the FrequencyWaveform approach.
  useEffect(() => {
    const canvas = canvasRef.current;
    const box = boxRef.current;
    if (!canvas || !box || !data.length) return;
    const paint = () => {
      const rawDpr = window.devicePixelRatio || 1;
      const cssW = Math.max(1, Math.round(box.clientWidth));
      const cssH = h;
      // Lower the dpr along the X axis only — Y dpr stays at native so the
      // curve's vertical resolution doesn't change. cssW * safeDprX never
      // exceeds SPARKLINE_MAX_BUFFER_PX.
      const safeDprX = Math.min(rawDpr, SPARKLINE_MAX_BUFFER_PX / Math.max(1, cssW));
      canvas.width = Math.round(cssW * safeDprX);
      canvas.height = Math.round(cssH * rawDpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(safeDprX, 0, 0, rawDpr, 0, 0);
      if (safeDprX < rawDpr) {
        setSoftening(true);
        if (softenTimerRef.current != null) window.clearTimeout(softenTimerRef.current);
        softenTimerRef.current = window.setTimeout(() => setSoftening(false), 250);
      }
      ctx.clearRect(0, 0, cssW, cssH);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const n = data.length;
      // If there are more data points than pixels, collapse each column to a
      // min/max pair so peaks aren't dropped between samples.
      if (n > cssW * 2) {
        for (let x = 0; x < cssW; x++) {
          const i0 = Math.floor((x / cssW) * n);
          const i1 = Math.min(n, Math.floor(((x + 1) / cssW) * n));
          let mn = Infinity, mx = -Infinity;
          for (let i = i0; i < i1; i++) {
            const v = data[i];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
          if (mn === Infinity) continue;
          const yHi = cssH - mn * (cssH - 4) - 2;
          const yLo = cssH - mx * (cssH - 4) - 2;
          if (x === 0) ctx.moveTo(x + 0.5, yLo);
          else ctx.lineTo(x + 0.5, yLo);
          ctx.lineTo(x + 0.5, yHi);
        }
      } else {
        for (let i = 0; i < n; i++) {
          const x = n === 1 ? 0 : (i / (n - 1)) * (cssW - 1);
          const y = cssH - data[i] * (cssH - 4) - 2;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    };
    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(box);
    return () => ro.disconnect();
  }, [data, color, h]);

  if (!data.length) return null;
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  return (
    <div className="flex flex-1 min-w-0 items-stretch">
      <RowLabel text={label} dragHandlers={dragHandlers} onResizeStart={onResizeStart} />
      <div
        ref={boxRef}
        className="flex-1 relative bg-gray-950 rounded overflow-hidden"
        style={{ height }}
      >
        <canvas ref={canvasRef} className="block" />
        {softening && (
          <div className="absolute top-1 left-1 z-30 pointer-events-none">
            <SoftClampSpinner />
          </div>
        )}
        {gridProps && (
          <BeatGridOverlay
            bpm={gridProps.bpm}
            gridOffset={gridProps.gridOffset}
            beatsPerBar={gridProps.beatsPerBar}
            barGroupSize={gridProps.barGroupSize} beatGroupSize={gridProps.beatGroupSize}
            subBeatDivision={gridProps.subBeatDivision}
            thickness={gridProps.thickness}
            duration={duration}
          />
        )}
        {overlay && (
          <AnnotationOverlays
            duration={duration}
            currentTime={currentTime}
            isPlaying={false}
            manualSections={overlay.manualSections}
            showManual={overlay.showManual}
            onManualMarkerDrag={overlay.onManualMarkerDrag}
            eyeTimes={overlay.eyeTimes}
            showEye={overlay.showEye}
            onEyeMarkerDrag={overlay.onEyeMarkerDrag}
            onEyeMarkerDragStart={overlay.onEyeMarkerDragStart}
            grid={gridProps}
          />
        )}
        {pendingSelection && (
          <div className="absolute inset-0 pointer-events-none">
            <PendingHighlightOverlay sel={pendingSelection} duration={duration} grid={gridProps} />
          </div>
        )}
        {signalMarkers && (
          <SignalMarkersOverlay
            points={signalMarkers.points}
            bands={signalMarkers.bands}
            duration={duration}
          />
        )}
        <div
          className="absolute top-0 bottom-0 w-px pointer-events-none"
          style={{ left: `${pct}%`, background: 'rgba(255,255,255,0.75)', boxShadow: '0 0 3px rgba(255,255,255,0.5)' }}
        />
        {onSeek && onRegion && (
          <RegionDragOverlay duration={duration} onVizClick={onSeek} onVizRegion={onRegion} onRegionDragStart={onRegionDragStart} />
        )}
      </div>
    </div>
  );
}

// ─── Signal markers overlay ───────────────────────────────────────────────────
// Renders every "chosen" annotation (Manual + Eye + Auto-guess + custom-detector
// boundaries + cue/span/loop/pattern layers) as 1px vertical lines (points) or
// faint translucent bands (intervals) over the parent signal row. The same
// payload is reused for every signal panel so toggling "Overlay all on signals"
// from the toolbar gates a single source of truth.
//
// Stacks safely on top of the existing AnnotationOverlays / SpectrogramDragOverlay
// (3-Band + Spectrogram + sparklines) — Manual + Eye lines simply overlap pixel-
// perfectly. Pointer events stay off so it never blocks clicks / drag handles
// underneath.
interface SignalPointMarker { time: number; color: string; opacity?: number }
interface SignalBandMarker { start: number; end: number; color: string; opacity?: number }
function SignalMarkersOverlay({ points, bands, duration }: {
  points: SignalPointMarker[];
  bands: SignalBandMarker[];
  duration: number;
}) {
  if (duration <= 0 || (!points.length && !bands.length)) return null;
  return (
    <div className="absolute inset-0 pointer-events-none z-[6]">
      {bands.map((b, i) => {
        const w = ((b.end - b.start) / duration) * 100;
        if (w <= 0) return null;
        return (
          <div
            key={`b-${i}`}
            className="absolute top-0 bottom-0"
            style={{
              left: `${(b.start / duration) * 100}%`,
              width: `${w}%`,
              background: b.color,
              opacity: b.opacity ?? 0.10,
            }}
          />
        );
      })}
      {points.map((p, i) => (
        <div
          key={`p-${i}`}
          className="absolute top-0 bottom-0"
          style={{
            left: `${(p.time / duration) * 100}%`,
            width: 1,
            background: p.color,
            opacity: p.opacity ?? 0.7,
          }}
        />
      ))}
    </div>
  );
}

// ─── Algo timeline row ────────────────────────────────────────────────────────

function AlgoTimelineRow({ sections, duration, currentTime, label, labelColor, renderKind = 'boundary', dragHandlers, onResizeStart, sectionColorOverrides, gridProps, focusedSectionIdx, onSectionClick }: {
  sections: { time: number; endTime: number; label: string; type: string; color?: string }[];
  duration: number; currentTime: number; label: string;
  labelColor?: string;
  /** Drives the per-section shape: contiguous blocks ('boundary'), translucent
   *  bands ('span'), or thin centred ticks ('point'). Defaults to 'boundary'. */
  renderKind?: AlgoRenderKind;
  dragHandlers?: RowDragHandlers;
  onResizeStart?: (e: React.PointerEvent) => void;
  sectionColorOverrides?: Record<string, string>;
  gridProps?: GridProps;
  /** Index of the section whose popover is currently open — gets a brighter outline. */
  focusedSectionIdx?: number | null;
  /** Click a block to open the read-only output card. */
  onSectionClick?: (sectionIdx: number, anchor: { x: number; y: number }) => void;
}) {
  // For span/point rows the per-section `type` is content-derived (a chord
  // name, a note pitch, an event class…) and never matches SECTION_COLORS, so
  // it would fall through to the near-invisible slate-400 default. Use the
  // row's algo color as the base instead so these rows read as "their" hue.
  const baseColor = labelColor ?? sectionBg('default');
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  return (
    <div className="flex flex-1 min-w-0 items-stretch">
      <div
        className={`${STICKY_LABEL_CELL} ${dragHandlers ? 'cursor-grab active:cursor-grabbing' : ''}`}
        draggable={dragHandlers?.draggable}
        onDragStart={dragHandlers?.onDragStart}
        onDragEnd={dragHandlers?.onDragEnd}
        title={dragHandlers ? 'Drag to reorder' : undefined}
      >
        <span
          className="text-[10px] uppercase tracking-wide text-right leading-tight break-words"
          style={labelColor ? { color: labelColor } : undefined}
        >
          {label}
        </span>
        <LabelResizeHandle onResizeStart={onResizeStart} />
      </div>
      <div className="flex-1 relative h-5 rounded overflow-hidden bg-gray-950">
        {sections.map((s, i) => {
          const left  = (s.time / duration) * 100;
          const isFocused = focusedSectionIdx === i;
          const onClick = onSectionClick
            ? (e: React.MouseEvent) => { e.stopPropagation(); onSectionClick(i, { x: e.clientX, y: e.clientY }); }
            : undefined;
          const title = onSectionClick ? `Click to view output · ${s.label || s.type}` : (s.label || s.type);

          // ── Point ticks (onsets / key / chords) — half-transparent colored
          //    cue-style markers centred on the event time. ──
          if (renderKind === 'point') {
            const color = s.color ?? baseColor;
            return (
              <button key={i}
                className={`absolute top-0 bottom-0 w-2 flex items-stretch justify-center group/algotick ${onSectionClick ? 'cursor-pointer' : 'cursor-default'}`}
                style={{ left: `${left}%`, transform: 'translateX(-50%)' }}
                onClick={onClick}
                title={title}
              >
                <span
                  className="block w-[3px] h-full rounded-sm transition-all group-hover/algotick:w-1.5"
                  style={{
                    background: color,
                    opacity: isFocused ? 1 : 0.7,
                    boxShadow: isFocused ? `0 0 10px ${color}, 0 0 3px ${color}` : `0 0 5px ${color}aa, 0 0 1px ${color}`,
                  }}
                />
              </button>
            );
          }

          // ── Span bands (voicing / loops / notes / events / lyrics) —
          //    translucent colored intervals, like the span annotation markers. ──
          if (renderKind === 'span') {
            const color = s.color ?? baseColor;
            const width = Math.max(0.3, ((s.endTime - s.time) / duration) * 100);
            return (
              <div key={i}
                className={`absolute top-0 bottom-0 rounded-[2px] overflow-hidden ${onSectionClick ? 'cursor-pointer hover:brightness-125' : ''}`}
                style={{
                  left: `${left}%`, width: `${width}%`,
                  background: `${color}55`,
                  boxShadow: isFocused
                    ? `inset 0 0 0 1px ${color}, 0 0 6px ${color}66`
                    : `inset 0 0 0 1px ${color}88`,
                }}
                onClick={onClick}
                title={title}
              >
                <span className="absolute inset-x-0.5 top-0 text-[8px] truncate text-white/80 pointer-events-none select-none leading-tight">
                  {s.label}
                </span>
              </div>
            );
          }

          // ── Boundary blocks (MSAF / ruptures / allin1 / custom) — contiguous
          //    labeled section tiling. ──
          const width = Math.max(0.3, ((s.endTime - s.time) / duration) * 100);
          return (
            <div key={i}
              className={`absolute top-0 bottom-0 ${onSectionClick ? 'cursor-pointer hover:ring-1 hover:ring-white/40' : ''}`}
              style={{
                left: `${left}%`, width: `${width}%`,
                background: s.color ?? sectionColorOverrides?.[s.type] ?? sectionBg(s.type),
                opacity: isFocused ? 1 : 0.78,
                borderRight: '1px solid rgba(0,0,0,0.5)',
                boxShadow: isFocused
                  ? 'inset 0 0 0 1px rgba(255,255,255,0.65), 0 0 6px rgba(255,255,255,0.25)'
                  : 'inset 0 0 0 1px rgba(255,255,255,0.22)',
              }}
              onClick={onClick}
              title={title}
            />
          );
        })}
        {gridProps && (
          <BeatGridOverlay
            bpm={gridProps.bpm}
            gridOffset={gridProps.gridOffset}
            beatsPerBar={gridProps.beatsPerBar}
            barGroupSize={gridProps.barGroupSize} beatGroupSize={gridProps.beatGroupSize}
            subBeatDivision={gridProps.subBeatDivision}
            thickness={gridProps.thickness}
            duration={duration}
          />
        )}
        <div className="absolute top-0 bottom-0 w-px pointer-events-none" style={{ left: `${pct}%`, background: 'rgba(255,255,255,0.75)' }} />
      </div>
    </div>
  );
}

// ─── Spectrogram interactive overlay ─────────────────────────────────────────

function SpectrogramDragOverlay({
  duration, currentTime,
  manualSections, showManual, onManualMarkerDrag,
  eyeTimes, showEye, onEyeMarkerDrag, onEyeMarkerDragStart,
  pendingSelection,
  onVizClick, onVizRegion, onRegionDragStart,
  snapToGrid, bpm, beatOffset, beatsPerBar, anchors, beatOverrides,
}: {
  duration: number; currentTime: number;
  manualSections?: ManualSection[]; showManual: boolean;
  onManualMarkerDrag?: (idx: number, t: number) => void;
  eyeTimes: number[]; showEye: boolean;
  onEyeMarkerDrag?: (idx: number, t: number) => void;
  onEyeMarkerDragStart?: () => void;
  pendingSelection?: PendingSelection | null;
  onVizClick: (t: number) => void;
  onVizRegion: (t1: number, t2: number) => void;
  onRegionDragStart?: () => void;
  snapToGrid?: boolean;
  bpm?: number;
  beatOffset?: number;
  beatsPerBar?: number;
  anchors?: readonly import('../../types/songInfo').TempoAnchor[];
  beatOverrides?: Readonly<Record<string, number>>;
}) {
  const [dragSel, setDragSel] = useState<{ s: number; e: number } | null>(null);
  const dragRef = useRef<{ time: number; x: number } | null>(null);

  const timeAt = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((e.clientX - rect.left) / rect.width) * duration));
  };
  const snap = (t: number) => {
    if (!snapToGrid || !bpm || bpm <= 0) return t;
    return snapTimeToGrid(t, bpm, beatOffset ?? 0, beatsPerBar ?? 4, 'beat', anchors, beatOverrides);
  };
  const onMD = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = timeAt(e); dragRef.current = { time: t, x: e.clientX };
    const ts = snap(t);
    setDragSel({ s: ts, e: ts });
    onRegionDragStart?.();
    e.preventDefault();
  };
  const onMM = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    setDragSel({ s: snap(dragRef.current.time), e: snap(timeAt(e)) });
  };
  const onMU = (e: React.MouseEvent<HTMLDivElement>) => {
    const drag = dragRef.current; if (!drag) return;
    const endT = timeAt(e); const px = Math.abs(e.clientX - drag.x);
    const rawT1 = Math.min(drag.time, endT); const rawT2 = Math.max(drag.time, endT);
    const t1 = snap(rawT1); const t2 = snap(rawT2);
    if (px > 6 && t2 - t1 > 0.1) onVizRegion(t1, t2); else onVizClick(drag.time);
    dragRef.current = null; setDragSel(null);
  };
  const onML = () => { dragRef.current = null; setDragSel(null); };

  return (
    <div
      className="absolute inset-0"
      style={{ cursor: 'crosshair' }}
      onMouseDown={onMD} onMouseMove={onMM} onMouseUp={onMU} onMouseLeave={onML}
    >
      <AnnotationOverlays
        duration={duration}
        currentTime={currentTime}
        isPlaying={false}
        manualSections={manualSections}
        showManual={showManual}
        onManualMarkerDrag={onManualMarkerDrag}
        eyeTimes={eyeTimes}
        showEye={showEye}
        onEyeMarkerDrag={onEyeMarkerDrag}
        onEyeMarkerDragStart={onEyeMarkerDragStart}
        pendingSelection={pendingSelection}
        grid={bpm ? { bpm, gridOffset: beatOffset, beatsPerBar } : undefined}
      />
      {dragSel && duration > 0 && (
        <div className="absolute top-0 bottom-0 pointer-events-none z-25"
          style={{
            left: `${(Math.min(dragSel.s, dragSel.e) / duration) * 100}%`,
            width: `${(Math.abs(dragSel.e - dragSel.s) / duration) * 100}%`,
            minWidth: 1,
            background: 'rgba(45,212,191,0.13)',
            borderLeft: '2px solid rgba(45,212,191,0.7)',
            borderRight: Math.abs(dragSel.e - dragSel.s) > 0.1 ? '2px solid rgba(45,212,191,0.7)' : 'none',
          }}
        />
      )}
    </div>
  );
}

// ─── Click + drag-to-region overlay (signal/MIR rows) ─────────────────────────
// Thin overlay mounted absolute-inset on top of any signal/MIR visualization
// (EQ, Sparklines, cepstrogram, chroma, tempogram, SSM). Translates a plain
// click into onVizClick(t) (seek + clear preview) and a drag into onVizRegion
// (preview-region create) — the same gestures the 3-Band waveform and
// Spectrogram already support, now available on every signal row.
function RegionDragOverlay({ duration, onVizClick, onVizRegion, onRegionDragStart }: {
  duration: number;
  onVizClick: (t: number) => void;
  onVizRegion: (t1: number, t2: number) => void;
  onRegionDragStart?: () => void;
}) {
  const [dragSel, setDragSel] = useState<{ s: number; e: number } | null>(null);
  const dragRef = useRef<{ time: number; x: number } | null>(null);

  const timeAt = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || duration <= 0) return 0;
    return Math.max(0, Math.min(duration, ((e.clientX - rect.left) / rect.width) * duration));
  };
  const onMD = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = timeAt(e);
    dragRef.current = { time: t, x: e.clientX };
    setDragSel({ s: t, e: t });
    onRegionDragStart?.();
    e.preventDefault();
  };
  const onMM = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    setDragSel({ s: dragRef.current.time, e: timeAt(e) });
  };
  const onMU = (e: React.MouseEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const endT = timeAt(e);
    const px = Math.abs(e.clientX - drag.x);
    const t1 = Math.min(drag.time, endT);
    const t2 = Math.max(drag.time, endT);
    if (px > 6 && t2 - t1 > 0.1) onVizRegion(t1, t2);
    else onVizClick(drag.time);
    dragRef.current = null;
    setDragSel(null);
  };
  const onML = () => { dragRef.current = null; setDragSel(null); };

  return (
    // z-[1]: keeps overlay below AnnotationOverlays markers (z-10/z-20) so
    // marker drag handles still receive their pointer-events-auto mousedowns.
    // Empty space on the row still hits the overlay because AnnotationOverlays'
    // own container is pointer-events-none.
    <div
      className="absolute inset-0 z-[1]"
      style={{ cursor: 'crosshair' }}
      onMouseDown={onMD} onMouseMove={onMM} onMouseUp={onMU} onMouseLeave={onML}
    >
      {dragSel && duration > 0 && (
        <div
          className="absolute top-0 bottom-0 pointer-events-none"
          style={{
            left: `${(Math.min(dragSel.s, dragSel.e) / duration) * 100}%`,
            width: `${(Math.abs(dragSel.e - dragSel.s) / duration) * 100}%`,
            minWidth: 1,
            background: 'rgba(45,212,191,0.13)',
            borderLeft: '2px solid rgba(45,212,191,0.7)',
            borderRight: Math.abs(dragSel.e - dragSel.s) > 0.1 ? '2px solid rgba(45,212,191,0.7)' : 'none',
          }}
        />
      )}
    </div>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

// All grid resolutions are expressed *relative to the beat* (where 1 beat =
// 60 / BPM seconds). This sidesteps the time-signature-denominator ambiguity:
// in 6/8 the "beat" the BPM counts is an 8th note, so "1/2 beat" is a 16th —
// the labels stay honest regardless of meter.
//   '32nd'          = 1/8 of a beat  (= 32nd note in 4/4)
//   '16th-triplet'  = 1/6 of a beat  (= 16th triplet, 6 per beat)
//   '16th'          = 1/4 of a beat  (= 16th note in 4/4)
//   '8th-triplet'   = 1/3 of a beat  (= 8th triplet, 3 per beat)
//   '8th'           = 1/2 of a beat  (= 8th note in 4/4)
//   'beat'          = 1 beat
//   'compound-beat' = 3 beats (the "felt" pulse in 6/8, 9/8, 12/8)
//   'bar' .. '16bar'= 1, 2, 4, 8, 16 bars
export const BEAT_GRID_UNIT_OPTIONS = [
  '32nd', '16th-triplet', '16th', '8th-triplet', '8th',
  'beat', 'compound-beat',
  'bar', '2bar', '4bar', '8bar', '16bar',
] as const;
export type BeatGridUnit = typeof BEAT_GRID_UNIT_OPTIONS[number];

/** How an algo overlay row is drawn. 'boundary' tiles the track into contiguous
 *  labeled section blocks (MSAF / ruptures / allin1 / custom-boundary). 'span'
 *  draws each section as a translucent colored band (voicing / loops / notes /
 *  events / lyrics). 'point' draws each section as a thin colored tick centred
 *  on its start time (onsets / key / chords) — like cue markers. */
export type AlgoRenderKind = 'boundary' | 'span' | 'point';

export interface AlgoOverlay {
  id: string;
  label: string;
  labelColor?: string;
  /** Defaults to 'boundary' when unset. */
  renderKind?: AlgoRenderKind;
  sections: { time: number; endTime: number; label: string; type: string; color?: string }[];
}

export interface MirCurves {
  energy: number[]; spectral: number[]; novelty: number[]; onsets: number[];
  /** Full spectral flux (L2 norm of frame-to-frame magnitude differences). Captures both attacks AND releases, unlike `onsets` which is half-wave rectified. */
  flux?: number[];
  lowBand?: number[]; midBand?: number[]; highBand?: number[];
  frameDuration: number;
  /** Row-major MFCC matrix (frame × coef). Optional — only required for the cepstrogram row. */
  mfcc?: Float32Array;
  nMfcc?: number;
  /** Row-major chroma matrix (frame × 12). Optional — only required for the chromagram row. Each column already per-frame max-normalised to [0,1]. */
  chroma?: Float32Array;
  nChroma?: number;
  /** Row-major tempogram matrix (tempoFrame × nTempo). Optional — only required for the tempogram row. Each column already per-frame max-normalised to [0,1]. */
  tempogram?: Float32Array;
  nTempo?: number;
  tempogramFrameCount?: number;
  /** BPM value at each tempo row (length = nTempo). Used to draw y-axis labels. */
  tempoBpm?: Float32Array;
  /** Chroma-based self-similarity matrix. Square row-major (ssmFrameCount²). Optional — only required for the SSM row. */
  ssm?: Float32Array;
  ssmFrameCount?: number;
  frameCount?: number;
}

export interface SharedVizPanelProps {
  // Audio / player
  playerUrl: string | null;
  trackName?: string;
  audioBuffer: AudioBuffer | null;
  duration: number;
  currentTime: number;
  // Beat grid
  bpm?: number;
  /** Display-only time signature string (e.g. '4/4'). Shown next to the
   *  BPM pill in the player toolbar. Beat-grid math uses `beatsPerBar`. */
  timeSignature?: string;
  beatOffset?: number;
  beatsPerBar?: number;
  barGroupSize?: number;
  showBeatGrid?: boolean;
  beatGridUnit?: BeatGridUnit;
  /** Tempo anchors (Dynamic / Manual adjustment modes). When present, the
   *  grid becomes piecewise-constant per segment. */
  anchors?: readonly import('../../types/songInfo').TempoAnchor[];
  /** Per-beat overrides (Manual mode). Sparse map keyed by global integer
   *  beat index → absolute timestamp in seconds. */
  beatOverrides?: Readonly<Record<string, number>>;
  /** Active grid mode. Drives the color of anchor flags above the player
   *  row. Anything other than 'dynamic' / 'manual' hides the flag row. */
  gridMode?: import('../../types/songInfo').GridMode;
  /** Fired when the curator right-clicks an anchor flag. Receives the
   *  anchor's index in the original (sorted) array. Only enabled when
   *  gridMode === 'manual'. */
  onDeleteAnchor?: (index: number) => void;
  /** Drag a tempo anchor flag to retime it. Only enabled in manual grid mode. */
  onAnchorDrag?: (index: number, newTime: number) => void;
  onAnchorDragStart?: (index: number) => void;
  /** Fired when the curator drag-drops a beat line in the manual editor.
   *  Receives the dragged beat's original time, the dropped time, and the
   *  integer beat index. Host writes the new position into
   *  `SongInfo.beatOverrides[beatIndex]`. Only used when
   *  gridMode === 'manual'. */
  onBeatDrag?: (tOrig: number, tNew: number, beatIndex: number) => void;
  /** Fired when the curator right-clicks a pinned beat in the manual
   *  editor. Host deletes the matching entry from
   *  `SongInfo.beatOverrides`. */
  onClearBeatOverride?: (beatIndex: number) => void;
  /** When true, manual-mode editing is read-only (non-admin viewer). */
  manualEditLocked?: boolean;
  /** When true (and bpm is set), drag-selections on the 3-Band waveform and Spectrogram snap to the beat grid. */
  snapToGrid?: boolean;
  // Marker data
  manualSections?: ManualSection[];
  eyeSections?: ManualSection[];
  autoGuessPoints?: AutoGuessPoint[];
  pendingSelection?: PendingSelection | null;
  // Visibility
  showManual: boolean;
  showEye: boolean;
  showAutoGuess: boolean;
  /** Draw section markers on top of 3-Band / Spectrogram. Off lets the bar grid show through. Defaults to true. */
  showSignalOverlays?: boolean;
  showWaveform: boolean;
  showEQ?: boolean;
  showSpectrogram: boolean;
  showCepstrogram: boolean;
  showChroma: boolean;
  showTempogram: boolean;
  showSsm: boolean;
  mirCurves: MirCurves | null;
  mirComputing?: boolean;
  showEnergy: boolean;
  showBrightness: boolean;
  showNovelty: boolean;
  showOnsets: boolean;
  showFlux: boolean;
  // Algo section rows
  algoOverlays: AlgoOverlay[];
  // Interaction routing
  onVizClick: (time: number) => void;
  onVizRegion: (t1: number, t2: number) => void;
  /** Fires once when the user mousedowns to start a region drag on any row.
   *  Parents wire this to clear any committed pending highlight so it doesn't
   *  render at the same time as the in-progress drag rectangle. */
  onRegionDragStart?: () => void;
  onManualBoundaryChange?: (sectionIndex: number, newTime: number) => void;
  onManualBoundaryDragStart?: () => void;
  /** Drag-to-retime callback for the thin manual ghost marker that appears
   *  on signal rows. Same payload as onManualBoundaryChange. */
  onManualMarkerDrag?: (sectionIndex: number, newTime: number) => void;
  /** Drag-to-retime callback for the thin eye ghost marker on signal rows. */
  onEyeMarkerDrag?: (pointIndex: number, newTime: number) => void;
  onEyeMarkerDragStart?: () => void;
  onManualSectionClick?: (sectionIndex: number, anchor: { x: number; y: number }) => void;
  onEyeSectionClick?: (sectionIndex: number, anchor: { x: number; y: number }) => void;
  onManualUndo?: () => void;
  canManualUndo?: boolean;
  // Auto-guess callbacks
  onMarkCorrect?: (id: string) => void;
  onMarkIncorrect?: (id: string) => void;
  onMarkPending?: (id: string) => void;
  // Custom-detector annotation rows (is_annotation detectors) — one row per detector,
  // rendered with AutoGuess-style ✓/✗/@ review cards. Each row's id is `custom-annotation:<name>`.
  customAnnotationRows?: Array<{ rowId: string; detectorName: string; label: string; color: string; points: AutoGuessPoint[] }>;
  /** Detector names the user has toggled off in the Annotations dropdown. Hidden rows are skipped during render. */
  hiddenCustomAnnotations?: Set<string>;
  onCustomAnnotationMarkCorrect?: (detectorName: string, pointId: string) => void;
  onCustomAnnotationMarkIncorrect?: (detectorName: string, pointId: string) => void;
  onCustomAnnotationMarkPending?: (detectorName: string, pointId: string) => void;
  /** Per-layer review state for detector-sourced cue/span/loop/pattern layers.
   *  Keyed by layer.id, then by item.id. When a layer has an entry here, the
   *  row component renders inline ✓/✗ controls and disables edit affordances. */
  detectorLayerReview?: Record<string, Record<string, 'accepted' | 'rejected'>>;
  onDetectorLayerAccept?: (layerId: string, itemId: string) => void;
  onDetectorLayerReject?: (layerId: string, itemId: string) => void;
  // Player refs
  seekRef: RefObject<((time: number) => void) | null>;
  playRef: RefObject<(() => void) | null>;
  pauseRef: RefObject<(() => void) | null>;
  wsScrollRef: RefObject<((scrollLeft: number) => void) | null>;
  zoomInRef?: RefObject<(() => void) | null>;
  zoomOutRef?: RefObject<(() => void) | null>;
  zoomResetRef?: RefObject<(() => void) | null>;
  /** Prompt-free pinch zoom — see [PlayerPanel docs]. Used by the viz
   *  Ctrl/⌘+wheel handler so trackpad pinch can't auto-cross into Extended
   *  or Ultra zoom; those tiers require the toolbar + button. */
  pinchZoomInRef?: RefObject<(() => void) | null>;
  pinchZoomOutRef?: RefObject<(() => void) | null>;
  /** Scroll viewport so `time` is centered (or near-left if align='left'). */
  scrollToTimeRef?: RefObject<((time: number, align?: 'center' | 'left') => void) | null>;
  /** Zoom + scroll so [t1, t2] fills the viewport. */
  zoomToRangeRef?: RefObject<((t1: number, t2: number) => void) | null>;
  onBufferReady: (buf: AudioBuffer) => void;
  onReady?: () => void;
  onTimeUpdate: (t: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onScrollChange: (scrollLeft: number) => void;
  onViewChange: (zoomFactor: number, containerWidth: number, atMaxZoom: boolean) => void;
  // Viz scroll sync
  vizScrollContainerRef: RefObject<HTMLDivElement | null>;
  vizSignalWidth: number;
  /** Current player zoom multiplier (1 = fit, 2 = ×2 …). Drives the auto-guess
   *  per-point collapse/expand threshold (see autoGuessExpandZoomThreshold). */
  vizZoomFactor?: number;
  onVizScroll: () => void;
  playerIsPlaying: boolean;
  onSeekAndPlay?: (time: number, stopTime?: number) => void;
  onPause?: () => void;
  // Preview window — drag-to-listen region with movable/resizable band
  previewRegion?: PreviewRegion | null;
  onPreviewRegionChange?: (region: PreviewRegion) => void;
  onPreviewPlay?: () => void;
  onPreviewPause?: () => void;
  onPreviewDismiss?: () => void;
  onPreviewLoopToggle?: () => void;
  rowOrder?: VizRowId[];
  onReorderRow?: (draggedId: VizRowId, targetId: VizRowId) => void;
  // Section-color palette overrides (keyed by section type, e.g. 'intro' → '#a78bfa').
  // Applies to manual/eye/auto-guess block rows + algo overlay rows.
  sectionColorOverrides?: Record<string, string>;
  onSectionColorChange?: (type: string, color: string) => void;
  onResetSectionColors?: () => void;
  // Reset row order back to default; shown when user has reordered.
  onResetRowOrder?: () => void;
  hasCustomRowOrder?: boolean;
  /** Per-layer auralisation config (manual/eye/autoGuess). Plays a panned click on each boundary during playback. */
  layerAudioConfig?: Record<string, LayerAudioConfig>;
  onLayerAudioChange?: (layerId: string, config: LayerAudioConfig) => void;
  /** Theme accent for the embedded PlayerPanel (waveform color, play btn, BPM pill, etc.) */
  playerAccent?: PlayerAccent;
  /** Hide the crosshair icon next to the Playback time (used in algorithm-inspect mode). */
  hidePlaybackIcon?: boolean;
  /** Hide the entire Playback/Selection readout row above the player. Used in
   *  Dataset Prep, where the numeric readout adds clutter to grid setup. */
  hideTimeDisplay?: boolean;
  /** Called while the user holds Alt and drags any waveform horizontally to slide the grid. */
  onGridOffsetChange?: (newOffset: number) => void;
  /** Called once when an Alt-drag begins. Use to snapshot the previous offset for undo. */
  onGridOffsetDragStart?: (currentOffset: number) => void;
  /** When true, render bar numbers above bar lines on the main player waveform. */
  showBarNumbers?: boolean;
  /** Multiplier on every beat-grid line's width across all rows (1 = default). */
  gridLineThickness?: number;
  /** Demucs stem playback. When provided, a Source picker is shown above the player. */
  stemSource?: StemSource;
  availableStemSources?: StemSource[];
  onStemSourceChange?: (next: StemSource) => void;
  /** When provided, the Source picker also shows a "▶ Stem this song" button.
   *  While a job is in flight the button is replaced by a "⏳ Stemming… N% ·
   *  MM:SS" pill with the current step as a subtitle; on failure it flips to
   *  a persistent red "✗ Stems failed — view log" pill. Intended for Dataset Prep. */
  onRunStems?: () => void;
  runStemsStatus?: 'idle' | 'running' | 'error';
  /** Parsed progress % from Demucs's tqdm output (rightmost \d+% in the log tail). */
  runStemsProgressPct?: number;
  /** Wall-clock seconds since the job started — for the pill's MM:SS display. */
  runStemsElapsedSec?: number;
  /** Latest non-empty log line — shown as a dim subtitle under the pill. */
  runStemsLastLine?: string;
  /** Set when the user has requested cancel/kill — pill flips to "⌛ Cancelling…" / "⌛ Killing…". */
  runStemsCancelMode?: 'soft' | 'hard';
  /** SIGINT the demucs subprocess — graceful, lands between chunks. */
  onCancelStems?: () => void;
  /** SIGKILL the demucs subprocess group — immediate, no cleanup. */
  onKillStems?: () => void;
  /** Tail of the log when the job failed — shown in the inline error modal. */
  runStemsErrorTail?: string;
  /** Dismiss the persistent error pill (clears the failed job from state). */
  onDismissStemsError?: () => void;
  /** User-created Cue layers. Each visible layer renders as a tick-mark row. */
  cueLayers?: AnnotationLayer<'cues'>[];
  /** Cue currently focused (selected in editor or open in popover). Highlighted on the row. */
  focusedCue?: { layerId: string; itemId: string } | null;
  /** Fired when the user clicks a tick on a Cue row. The anchor is the mouse position. */
  onCueClick?: (layerId: string, itemId: string, anchor: { x: number; y: number }) => void;
  /** Drag a cue tick to retime it. */
  onCueDrag?: (layerId: string, itemId: string, newTime: number) => void;
  onCueDragStart?: (layerId: string, itemId: string) => void;
  /** User-created Loop layers (gated by experimentalLoopsAndPatterns Settings flag in the parent).
   *  Each visible layer renders as an interval-band row. */
  loopLayers?: AnnotationLayer<'loops'>[];
  /** Loop currently focused in the editor — highlighted on the canvas band. */
  focusedLoop?: { layerId: string; itemId: string } | null;
  /** Loop currently playing — rendered with a brighter glow on the canvas. */
  playingLoopId?: string | null;
  /** Fired when the user clicks a loop band on the canvas. */
  onLoopClick?: (layerId: string, itemId: string, anchor: { x: number; y: number }) => void;
  /** Drag a loop band's edge to retime it. Edge is 'start' or 'end'. */
  onLoopEdgeDrag?: (layerId: string, itemId: string, edge: 'start' | 'end', newTime: number) => void;
  onLoopEdgeDragStart?: (layerId: string, itemId: string, edge: 'start' | 'end') => void;
  /** Drag the body of a loop band to move it without changing its width. */
  onLoopMove?: (layerId: string, itemId: string, newStart: number, newEnd: number) => void;
  onLoopMoveStart?: (layerId: string, itemId: string) => void;
  /** User-created Span layers. Each visible layer renders as a stacked-lane
   *  overlap-aware band row. */
  spanLayers?: AnnotationLayer<'spans'>[];
  /** Span currently focused in editor or popover — highlighted on the canvas band. */
  focusedSpan?: { layerId: string; itemId: string } | null;
  /** Fired when the user clicks a span band on the canvas. */
  onSpanClick?: (layerId: string, itemId: string, anchor: { x: number; y: number }) => void;
  /** Drag a span band's edge to retime it. */
  onSpanEdgeDrag?: (layerId: string, itemId: string, edge: 'start' | 'end', newTime: number) => void;
  onSpanEdgeDragStart?: (layerId: string, itemId: string, edge: 'start' | 'end') => void;
  /** Drag the body of a span band to move it without changing its width. */
  onSpanMove?: (layerId: string, itemId: string, newStart: number, newEnd: number) => void;
  onSpanMoveStart?: (layerId: string, itemId: string) => void;
  /** User-created Pattern layers (gated by experimentalLoopsAndPatterns Settings flag).
   *  Each visible layer renders as tiled-repetition band row — every item
   *  expands into `repeatCount` adjacent copies before lane assignment. */
  patternLayers?: AnnotationLayer<'patterns'>[];
  /** Pattern currently focused in editor or popover — highlighted on the canvas. */
  focusedPattern?: { layerId: string; itemId: string } | null;
  /** Pattern currently being auditioned — drawn with a subtle inset glow. */
  playingPatternId?: string | null;
  /** Fired when the user clicks a pattern tile on the canvas. */
  onPatternClick?: (layerId: string, itemId: string, anchor: { x: number; y: number }) => void;
  /** Drag a pattern's first-tile edge to retime its cycle. */
  onPatternEdgeDrag?: (layerId: string, itemId: string, edge: 'start' | 'end', newTime: number) => void;
  onPatternEdgeDragStart?: (layerId: string, itemId: string, edge: 'start' | 'end') => void;
  /** Drag the body of a pattern's first tile to slide the whole cycle (and
   *  all its repeats) without changing the cycle length. */
  onPatternMove?: (layerId: string, itemId: string, newStart: number, newEnd: number) => void;
  onPatternMoveStart?: (layerId: string, itemId: string) => void;
  /** When true, register a window-level wheel listener that redirects every
   *  horizontal trackpad/wheel gesture on the page to scroll the viz timeline
   *  (and suppresses the browser swipe-back/forward gesture). Default false. */
  captureGlobalHScroll?: boolean;
  /** When true, schedule audio ticks for highlighted pattern sub-beats. Default
   *  false — annotator stages stay silent so the song isn't drowned out by a
   *  metronome-like click on every highlighted step. Dataset Prep can opt in. */
  enablePatternBeatAudio?: boolean;
  /** Currently-active annotation tab. Drives the "selected layer" highlight
   *  on the matching viz row label (neon accent + glow). */
  activeAnnotationType?: 'boundaries' | 'cues' | 'spans' | 'loops' | 'patterns';
  /** Selected layer id per type (same map fed to the unified sidebar). Used
   *  to mark exactly one viz row as the active target. */
  selectedLayerIdByType?: Partial<Record<'boundaries' | 'cues' | 'spans' | 'loops' | 'patterns', string | null>>;
  /** Fired when the user clicks a viz row label. The parent should switch
   *  the active tab + source picker to this layer (same handler the unified
   *  sidebar uses). When omitted, viz labels stay non-interactive. */
  onSelectLayer?: (type: SelectableLayerType, selection: VizLayerSelection) => void;
}

// ─── Beat grid resolver ───────────────────────────────────────────────────────

function resolveBeatGrid(
  bpm: number | undefined,
  beatsPerBar: number,
  showBeatGrid: boolean | undefined,
  beatGridUnit: BeatGridUnit | undefined,
): { bpm?: number; beatsPerBar?: number; barGroupSize?: number; subBeatDivision?: number; beatGroupSize?: number } {
  if (!showBeatGrid || !bpm) return {};
  switch (beatGridUnit) {
    case '32nd':          return { bpm, beatsPerBar, subBeatDivision: 8 };
    case '16th-triplet':  return { bpm, beatsPerBar, subBeatDivision: 6 };
    case '16th':          return { bpm, beatsPerBar, subBeatDivision: 4 };
    case '8th-triplet':   return { bpm, beatsPerBar, subBeatDivision: 3 };
    case '8th':           return { bpm, beatsPerBar, subBeatDivision: 2 };
    case 'compound-beat': return { bpm, beatsPerBar, beatGroupSize: 3 };
    case '2bar':          return { bpm, beatsPerBar, barGroupSize: 2 };
    case '4bar':          return { bpm, beatsPerBar, barGroupSize: 4 };
    case '8bar':          return { bpm, beatsPerBar, barGroupSize: 8 };
    case '16bar':         return { bpm, beatsPerBar, barGroupSize: 16 };
    case 'bar':           return { bpm, beatsPerBar, barGroupSize: 1 };
    case 'beat':
    default:              return { bpm, beatsPerBar };
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SharedVizPanel({
  playerUrl, trackName,
  audioBuffer, duration, currentTime,
  bpm, timeSignature, beatOffset, beatsPerBar = 4,
  showBeatGrid, beatGridUnit, anchors, beatOverrides, gridMode, onDeleteAnchor, onAnchorDrag, onAnchorDragStart, onBeatDrag, onClearBeatOverride, manualEditLocked,
  snapToGrid = false,
  manualSections, eyeSections, autoGuessPoints, pendingSelection,
  showManual, showEye, showAutoGuess,
  showSignalOverlays = true,
  showWaveform, showEQ = false, showSpectrogram, showCepstrogram, showChroma, showTempogram, showSsm,
  mirCurves, mirComputing = false, showEnergy, showBrightness, showNovelty, showOnsets, showFlux,
  algoOverlays,
  onVizClick, onVizRegion, onRegionDragStart, onManualBoundaryChange, onManualBoundaryDragStart,
  onManualMarkerDrag, onEyeMarkerDrag, onEyeMarkerDragStart,
  onManualSectionClick, onEyeSectionClick, onManualUndo, canManualUndo,
  onMarkCorrect, onMarkIncorrect, onMarkPending,
  customAnnotationRows,
  hiddenCustomAnnotations,
  onCustomAnnotationMarkCorrect, onCustomAnnotationMarkIncorrect,
  onCustomAnnotationMarkPending,
  detectorLayerReview, onDetectorLayerAccept, onDetectorLayerReject,
  seekRef, playRef, pauseRef, wsScrollRef, zoomInRef, zoomOutRef, zoomResetRef, pinchZoomInRef, pinchZoomOutRef, scrollToTimeRef, zoomToRangeRef,
  onBufferReady, onReady, onTimeUpdate, onPlayingChange, onScrollChange, onViewChange,
  vizScrollContainerRef, vizSignalWidth, vizZoomFactor = 1, onVizScroll,
  playerIsPlaying, onSeekAndPlay, onPause,
  previewRegion, onPreviewRegionChange, onPreviewPlay, onPreviewPause, onPreviewDismiss, onPreviewLoopToggle,
  rowOrder, onReorderRow,
  sectionColorOverrides, onSectionColorChange, onResetSectionColors,
  onResetRowOrder, hasCustomRowOrder,
  layerAudioConfig, onLayerAudioChange,
  playerAccent,
  hidePlaybackIcon,
  hideTimeDisplay = false,
  onGridOffsetChange,
  onGridOffsetDragStart,
  showBarNumbers = false,
  gridLineThickness = 1,
  stemSource, availableStemSources, onStemSourceChange, onRunStems, runStemsStatus,
  runStemsProgressPct, runStemsElapsedSec, runStemsLastLine, runStemsCancelMode,
  onCancelStems, onKillStems, runStemsErrorTail, onDismissStemsError,
  cueLayers, focusedCue, onCueClick, onCueDrag, onCueDragStart,
  loopLayers, focusedLoop, playingLoopId, onLoopClick, onLoopEdgeDrag, onLoopEdgeDragStart, onLoopMove, onLoopMoveStart,
  spanLayers, focusedSpan, onSpanClick, onSpanEdgeDrag, onSpanEdgeDragStart, onSpanMove, onSpanMoveStart,
  patternLayers, focusedPattern, playingPatternId, onPatternClick, onPatternEdgeDrag, onPatternEdgeDragStart, onPatternMove, onPatternMoveStart,
  captureGlobalHScroll = false,
  enablePatternBeatAudio = false,
  activeAnnotationType,
  selectedLayerIdByType,
  onSelectLayer,
}: SharedVizPanelProps) {

  // Drag-to-reorder: tracks the row currently being dragged and the row hovered as drop target.
  const [draggedRowId, setDraggedRowId] = useState<VizRowId | null>(null);
  const [dropTargetRowId, setDropTargetRowId] = useState<VizRowId | null>(null);

  // ── Label column width (resizable gutter) ─────────────────────────────────
  // Width applied to every sticky row label via the `--viz-label-w` CSS var
  // set on the panel root. Persisted to localStorage so the user's pick
  // survives reloads. Bounded between a tight 56px (current short labels
  // still fit) and 240px (enough for long renamed layer names without
  // ever clipping or wrapping the spectrogram column too tightly).
  const LABEL_COL_W_KEY = 'tc:viz-label-col-w';
  const LABEL_COL_W_DEFAULT = 72;
  const LABEL_COL_W_MIN = 56;
  const LABEL_COL_W_MAX = 240;
  const [labelColW, setLabelColW] = useState<number>(() => {
    if (typeof window === 'undefined') return LABEL_COL_W_DEFAULT;
    const raw = window.localStorage.getItem(LABEL_COL_W_KEY);
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n >= LABEL_COL_W_MIN && n <= LABEL_COL_W_MAX ? n : LABEL_COL_W_DEFAULT;
  });
  const labelColWRef = useRef(labelColW);
  useEffect(() => { labelColWRef.current = labelColW; }, [labelColW]);
  const handleLabelColResizeStart = useCallback((e: React.PointerEvent) => {
    // Stop the parent label's HTML5-drag (row reorder) and click-to-select
    // from firing when the user grabs the grippy.
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = labelColWRef.current;
    const onMove = (ev: PointerEvent) => {
      const next = Math.max(LABEL_COL_W_MIN, Math.min(LABEL_COL_W_MAX, startW + (ev.clientX - startX)));
      setLabelColW(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try { window.localStorage.setItem(LABEL_COL_W_KEY, String(labelColWRef.current)); } catch { /* private mode */ }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  // ── Layer-row click-to-select helper ──────────────────────────────────────
  // Build the per-layer selection payload + isSelected flag for the four
  // multi-layer types. Returns null when click-to-select isn't wired so the
  // label stays passive (drag-to-reorder still works, no onClick attached).
  const layerSelectionFor = useCallback((
    type: SelectableLayerType,
    layer: AnnotationLayer,
  ): { isSelected: boolean; onSelect?: () => void } => {
    const isSelected = activeAnnotationType === type
      && selectedLayerIdByType?.[type] === layer.id;
    if (!onSelectLayer) return { isSelected };
    const sourceId: VizLayerSelection['sourceId'] = layer.source && layer.source.startsWith('detector:')
      ? (layer.source as `detector:${string}`)
      : 'manual';
    return {
      isSelected,
      onSelect: () => onSelectLayer(type, {
        id: layer.id,
        sourceId,
        name: layer.name,
        readOnly: layer.readOnly === true,
      }),
    };
  }, [activeAnnotationType, selectedLayerIdByType, onSelectLayer]);

  // Auto-guess per-point manual-expand toggle. The set is shared across the
  // built-in auto-guess row and every custom-detector row since point IDs are
  // globally unique. When the row's auto-expand threshold is met (zoom factor
  // ≥ autoGuessExpandZoomThreshold) this set is bypassed.
  const { settings } = useSettings();
  const expandThreshold = settings.autoGuessExpandZoomThreshold;
  const [expandedAutoGuessPointIds, setExpandedAutoGuessPointIds] = useState<Set<string>>(() => new Set());
  const toggleAutoGuessExpanded = useCallback((pointId: string) => {
    setExpandedAutoGuessPointIds((prev) => {
      const next = new Set(prev);
      if (next.has(pointId)) next.delete(pointId);
      else next.add(pointId);
      return next;
    });
  }, []);

  // Parent of the 3-Band waveform — kept for layout (no longer used by PreviewWindow).
  const waveformBoxRef = useRef<HTMLDivElement | null>(null);

  // Parent of the tall PreviewBand — spans every viz row's content column, used by
  // PreviewWindow for time↔pixel conversion when the user resizes the band.
  const previewBandParentRef = useRef<HTMLDivElement | null>(null);

  // Intercept trackpad horizontal wheel deltas on the viz scroll container so
  // the browser's swipe-back/forward gesture doesn't fire when scrubbing.
  // React's onWheel synthetic event is always passive, so we need a native
  // listener with { passive: false } to make preventDefault() take effect.
  // Skips ctrl-modified events — those are pinch-zoom / Ctrl+wheel and are
  // handled by the zoom listener below.
  useEffect(() => {
    const el = vizScrollContainerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return;
      if (e.deltaX === 0) return;
      e.preventDefault();
      el.scrollLeft += e.deltaX;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [vizScrollContainerRef]);

  // Intercept the browser's pinch-zoom / Ctrl+wheel gesture over the viz and
  // remap it to the app's zoomIn/zoomOut. Browsers fire pinch as
  // `wheel` events with `ctrlKey: true` and a deltaY proportional to the
  // pinch velocity, so a single listener covers both Ctrl/⌘+wheel on mice
  // and two-finger pinch on trackpads.
  //
  // zoomIn/Out are 2× step functions, so we rate-limit by accumulating deltaY
  // and only firing once the magnitude crosses ZOOM_STEP_THRESHOLD — otherwise
  // a single pinch frame produces a runaway cascade. preventDefault stops the
  // browser's native page-zoom from also firing.
  useEffect(() => {
    const el = vizScrollContainerRef.current;
    if (!el) return;
    const ZOOM_STEP_THRESHOLD = 40;
    let accumDelta = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      accumDelta += e.deltaY;
      while (accumDelta <= -ZOOM_STEP_THRESHOLD) {
        pinchZoomInRef?.current?.();
        accumDelta += ZOOM_STEP_THRESHOLD;
      }
      while (accumDelta >= ZOOM_STEP_THRESHOLD) {
        pinchZoomOutRef?.current?.();
        accumDelta -= ZOOM_STEP_THRESHOLD;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [vizScrollContainerRef, pinchZoomInRef, pinchZoomOutRef]);

  // Opt-in: redirect *every* horizontal wheel gesture on the page to the viz
  // timeline. Captures at the window level so it runs before any other
  // horizontal scroll container (e.g. the workspace tab strip) or the local
  // viz/WaveSurfer listeners get a chance. stopPropagation() prevents the
  // local listeners from also firing — they'd otherwise double-scroll, since
  // the global handler already scrolls the viz container and the WaveSurfer
  // scroll syncs via the existing onScroll → wsScrollRef plumbing.
  // Skips ctrl-modified events so pinch-zoom over any element falls through
  // to the local viz zoom handler instead of being eaten as a pan.
  useEffect(() => {
    if (!captureGlobalHScroll) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return;
      if (e.deltaX === 0) return;
      const viz = vizScrollContainerRef.current;
      if (!viz) return;
      e.preventDefault();
      e.stopPropagation();
      viz.scrollLeft += e.deltaX;
    };
    window.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => window.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
  }, [captureGlobalHScroll, vizScrollContainerRef]);

  const makeDragHandlers = useCallback((rowId: VizRowId): RowDragHandlers | undefined => {
    if (!onReorderRow) return undefined;
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.effectAllowed = 'move';
        setDraggedRowId(rowId);
      },
      onDragEnd: () => {
        setDraggedRowId(null);
        setDropTargetRowId(null);
      },
    };
  }, [onReorderRow]);

  const makeRowDropHandlers = useCallback((rowId: VizRowId) => {
    if (!onReorderRow) return {};
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!draggedRowId || draggedRowId === rowId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (dropTargetRowId !== rowId) setDropTargetRowId(rowId);
      },
      onDragLeave: () => {
        if (dropTargetRowId === rowId) setDropTargetRowId(null);
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        setDropTargetRowId(null);
        if (!draggedRowId || draggedRowId === rowId) { setDraggedRowId(null); return; }
        onReorderRow(draggedRowId, rowId);
        setDraggedRowId(null);
      },
    };
  }, [onReorderRow, draggedRowId, dropTargetRowId]);

  const beatGrid = useMemo(
    () => resolveBeatGrid(bpm, beatsPerBar, showBeatGrid, beatGridUnit),
    [bpm, beatsPerBar, showBeatGrid, beatGridUnit],
  );

  // When anchors are active (Dynamic / Manual mode), the user's bar-level
  // beatGridUnit choice (Bar, 2bar, 4bar, …) is augmented to also emit the
  // beats between anchors — otherwise a 100-BPM segment next to a 130-BPM
  // segment is indistinguishable from a uniform grid. Finer-than-bar units
  // (8th, 16th, etc.) already show beats and are left alone.
  const augmentForAnchors = !!(anchors && anchors.length > 0 && beatGrid.barGroupSize != null);
  const effectiveBeatGrid = useMemo(() => (
    augmentForAnchors
      ? { ...beatGrid, barGroupSize: undefined, subBeatDivision: 1, beatGroupSize: undefined }
      : beatGrid
  ), [beatGrid, augmentForAnchors]);

  // Bundled props for the BeatGridOverlay used by section/sparkline/algo rows
  // — the canvas-based waveforms and spectrogram render their own grid directly.
  const gridProps: GridProps | undefined = useMemo(() => {
    if (!effectiveBeatGrid.bpm) return undefined;
    return {
      bpm: effectiveBeatGrid.bpm,
      gridOffset: beatOffset ?? 0,
      beatsPerBar: effectiveBeatGrid.beatsPerBar,
      barGroupSize: effectiveBeatGrid.barGroupSize ?? null,
      subBeatDivision: effectiveBeatGrid.subBeatDivision,
      beatGroupSize: effectiveBeatGrid.beatGroupSize,
      anchors,
      beatOverrides,
      thickness: gridLineThickness,
    };
  }, [effectiveBeatGrid, beatOffset, anchors, beatOverrides, gridLineThickness]);

  // Manual block sections
  const manualBlockSections = useMemo(() =>
    (manualSections ?? []).map((s, i) => ({
      time: s.time,
      endTime: (manualSections ?? [])[i + 1]?.time ?? duration,
      label: s.label,
      type: s.type,
      importance: s.importance,
    })),
  [manualSections, duration]);

  // Eye block sections
  const eyeBlockSections = useMemo(() =>
    (eyeSections ?? []).map((s, i) => ({
      time: s.time,
      endTime: (eyeSections ?? [])[i + 1]?.time ?? duration,
      label: s.label,
      type: s.type,
    })),
  [eyeSections, duration]);

  // Auto-guess block sections (colored by review status)
  const autoGuessBlockSections = useMemo(() => {
    if (!autoGuessPoints?.length) return [];
    const sorted = [...autoGuessPoints].sort((a, b) => a.time - b.time);
    return sorted.map((p, i) => ({
      time: p.time,
      endTime: sorted[i + 1]?.time ?? duration,
      label: `×${p.clusterSize}`,
      type: 'default',
      color: p.status === 'correct' ? '#14b8a6' : p.status === 'incorrect' ? '#f87171' : p.status === 'partial' ? '#f59e0b' : '#4b5563',
    }));
  }, [autoGuessPoints, duration]);

  // Eye times for marker lines on 3-band
  const eyeTimes = useMemo(() => eyeSections?.map(s => s.time) ?? [], [eyeSections]);

  // Overlay payload for Sparkline rows. Undefined when "Overlay on signals" is off,
  // so the sparkline renders no annotation markers at all.
  const sparklineOverlay = useMemo(
    () => showSignalOverlays
      ? { manualSections, showManual, eyeTimes, showEye, onManualMarkerDrag, onEyeMarkerDrag, onEyeMarkerDragStart }
      : undefined,
    [showSignalOverlays, manualSections, showManual, eyeTimes, showEye, onManualMarkerDrag, onEyeMarkerDrag, onEyeMarkerDragStart],
  );

  // Unified marker payload for SignalMarkersOverlay. Walks every annotation
  // kind currently toggled on in the dropdown and projects it onto the signal
  // panels as a 1px line (point events) or a translucent band (intervals).
  // Returned shape stays stable when the flag is off so referential equality
  // checks downstream don't churn.
  const signalOverlayMarkers = useMemo<{ points: SignalPointMarker[]; bands: SignalBandMarker[] }>(() => {
    if (!showSignalOverlays) return { points: [], bands: [] };
    const points: SignalPointMarker[] = [];
    const bands: SignalBandMarker[] = [];
    if (showManual && manualSections) {
      for (const s of manualSections) points.push({ time: s.time, color: sectionBg(s.type), opacity: 0.85 });
    }
    if (showEye && eyeSections) {
      for (const s of eyeSections) points.push({ time: s.time, color: '#2dd4bf', opacity: 0.85 });
    }
    if (showAutoGuess && autoGuessPoints) {
      for (const p of autoGuessPoints) {
        const color = p.status === 'correct' ? '#14b8a6'
          : p.status === 'incorrect' ? '#f87171'
          : p.status === 'partial' ? '#f59e0b'
          : '#a78bfa';
        points.push({ time: p.time, color, opacity: 0.75 });
      }
    }
    for (const row of customAnnotationRows ?? []) {
      if (hiddenCustomAnnotations?.has(row.detectorName)) continue;
      for (const p of row.points) points.push({ time: p.time, color: row.color, opacity: 0.75 });
    }
    for (const layer of cueLayers ?? []) {
      if (!layer.visible) continue;
      for (const item of layer.items) points.push({ time: item.time, color: layer.color, opacity: 0.7 });
    }
    for (const layer of spanLayers ?? []) {
      if (!layer.visible) continue;
      for (const item of layer.items) bands.push({ start: item.start, end: item.end, color: layer.color, opacity: 0.10 });
    }
    for (const layer of loopLayers ?? []) {
      if (!layer.visible) continue;
      for (const item of layer.items) bands.push({ start: item.start, end: item.end, color: layer.color, opacity: 0.10 });
    }
    for (const layer of patternLayers ?? []) {
      if (!layer.visible) continue;
      for (const item of layer.items) {
        const cycle = Math.max(0, item.end - item.start);
        const totalEnd = item.start + Math.max(1, Math.floor(item.repeatCount)) * cycle;
        bands.push({ start: item.start, end: totalEnd, color: layer.color, opacity: 0.08 });
      }
    }
    return { points, bands };
  }, [
    showSignalOverlays,
    showManual, manualSections,
    showEye, eyeSections,
    showAutoGuess, autoGuessPoints,
    customAnnotationRows, hiddenCustomAnnotations,
    cueLayers, spanLayers, loopLayers, patternLayers,
  ]);

  // Section types currently rendered → used by the section-color palette picker.
  // Walks Manual/Eye + visible algo overlays. Auto-guess uses per-section status colors so it's excluded.
  const visibleSectionTypes = useMemo(() => {
    const order = rowOrder ?? DEFAULT_FIXED_ROW_ORDER;
    const types = new Set<string>();
    if (showManual && manualBlockSections.length) for (const s of manualBlockSections) types.add(s.type);
    if (showEye  && eyeBlockSections.length)  for (const s of eyeBlockSections)  types.add(s.type);
    for (const rowId of order) {
      if (FIXED_ROW_IDS.has(rowId)) continue;
      const overlay = algoOverlays.find((o) => o.id === rowId);
      if (overlay) for (const s of overlay.sections) types.add(s.type);
    }
    return Array.from(types).sort();
  }, [rowOrder, showManual, showEye, manualBlockSections, eyeBlockSections, algoOverlays]);

  // No section overlay on spectrogram — manual already shown as dedicated block row above

  const handlePlay = useCallback((time: number, stopTime: number) => {
    onSeekAndPlay?.(time, stopTime);
  }, [onSeekAndPlay]);

  const handlePause = useCallback(() => { onPause?.(); }, [onPause]);

  // ── Algo block popover (click a section in any algo row to read its output) ──
  // Reuses the unified AnnotationPointCard in read-only mode so the algo card
  // matches every other annotation popover (cues / spans / loops / patterns).
  const algoPopover = useAnnotationPopover({ width: 340, height: 240 });

  // ── Auralisation: per-layer click pips on boundary crossings ───────────────
  const manualAudio = layerAudioConfig?.manual ?? DEFAULT_LAYER_AUDIO;
  const eyeAudio = layerAudioConfig?.eye ?? DEFAULT_LAYER_AUDIO;
  const autoGuessAudio = layerAudioConfig?.autoGuess ?? DEFAULT_LAYER_AUDIO;

  const manualTimes = useMemo(
    () => (manualSections ?? []).map((s) => s.time).sort((a, b) => a - b),
    [manualSections],
  );
  const eyeTimesAudio = useMemo(
    () => (eyeSections ?? []).map((s) => s.time).sort((a, b) => a - b),
    [eyeSections],
  );
  const autoGuessTimes = useMemo(
    () =>
      (autoGuessPoints ?? [])
        .filter((p) => p.status === 'correct' || p.status === 'partial')
        .map((p) => p.time)
        .sort((a, b) => a - b),
    [autoGuessPoints],
  );

  // Pattern sub-beat ticks: for every visible Pattern layer, for every item
  // with at least one highlighted step, emit a tick at
  // `start + i*cycle + b*(cycle/(beatsPerBar*PATTERN_SUBBEATS_PER_BEAT))` for
  // each repetition i and highlighted step b. The list is fed to
  // useBoundaryAudioFeedback alongside Manual/Eye/AutoGuess so the same
  // click-scheduling pipeline applies. Distinct pan + frequency keep the
  // pattern ticks separable from the boundary cues by ear.
  const patternTickTimes = useMemo(() => {
    if (!patternLayers?.length) return [] as number[];
    const stepsPerCycle = Math.max(1, Math.floor((beatsPerBar || 4))) * PATTERN_SUBBEATS_PER_BEAT;
    const out: number[] = [];
    for (const layer of patternLayers) {
      if (!layer.visible) continue;
      for (const p of layer.items) {
        if (!p.highlightedBeats.length) continue;
        const cycle = p.end - p.start;
        if (cycle <= 0) continue;
        const reps = Math.max(1, Math.floor(p.repeatCount));
        const stepDur = cycle / stepsPerCycle;
        for (let i = 0; i < reps; i++) {
          for (const b of p.highlightedBeats) {
            out.push(p.start + i * cycle + b * stepDur);
          }
        }
      }
    }
    return out.sort((a, b) => a - b);
  }, [patternLayers, beatsPerBar]);

  // Per-layer auralisation for user-created Cue/Span/Loop layers. Cues click
  // on every tick; Span/Loop click on entry (start). Frequencies are spread
  // across a small palette so multiple layers stay distinguishable by ear.
  // Patterns intentionally stay on the global `enablePatternBeatAudio` path —
  // their per-step ticks have different semantics than a single boundary pip.
  const userLayerAudioEntries = useMemo(() => {
    const out: Array<{ id: string; label: string; accent: string; freq: number; times: number[] }> = [];
    const slots = [800, 1100, 1700, 2200, 2700, 3000, 3300];
    let i = 0;
    const nextFreq = () => slots[(i++) % slots.length];
    for (const l of cueLayers ?? []) {
      if (!l.visible || !l.items.length) continue;
      const times = l.items.map((it) => it.time).sort((a, b) => a - b);
      out.push({ id: `cue-layer:${l.id}`, label: l.name, accent: l.color, freq: nextFreq(), times });
    }
    for (const l of spanLayers ?? []) {
      if (!l.visible || !l.items.length) continue;
      const times = l.items.map((it) => it.start).sort((a, b) => a - b);
      out.push({ id: `span-layer:${l.id}`, label: l.name, accent: l.color, freq: nextFreq(), times });
    }
    for (const l of loopLayers ?? []) {
      if (!l.visible || !l.items.length) continue;
      const times = l.items.map((it) => it.start).sort((a, b) => a - b);
      out.push({ id: `loop-layer:${l.id}`, label: l.name, accent: l.color, freq: nextFreq(), times });
    }
    return out;
  }, [cueLayers, spanLayers, loopLayers]);

  const audioLayers = useMemo(
    () => [
      { id: 'manual', times: manualTimes, clickFreq: 2500, ...manualAudio },
      { id: 'eye', times: eyeTimesAudio, clickFreq: 1500, ...eyeAudio },
      { id: 'autoGuess', times: autoGuessTimes, clickFreq: 3500, ...autoGuessAudio },
      // Pattern beat ticks — gated behind `enablePatternBeatAudio` so the
      // annotator stage stays silent (the per-beat clicks otherwise read as a
      // metronome and compete with the song). Dataset Prep can opt in.
      { id: 'patternBeats', times: patternTickTimes, clickFreq: 1000, enabled: enablePatternBeatAudio && patternTickTimes.length > 0, pan: 0, gain: 0.6 },
      ...userLayerAudioEntries.map((e) => {
        const cfg = layerAudioConfig?.[e.id] ?? DEFAULT_LAYER_AUDIO;
        return { id: e.id, times: e.times, clickFreq: e.freq, ...cfg };
      }),
    ],
    [manualTimes, eyeTimesAudio, autoGuessTimes, manualAudio, eyeAudio, autoGuessAudio, patternTickTimes, enablePatternBeatAudio, userLayerAudioEntries, layerAudioConfig],
  );

  useBoundaryAudioFeedback(audioLayers, currentTime, playerIsPlaying);

  // Layers eligible for the audio mixer row: only those currently rendered with data.
  const audioMixerLayers = useMemo(() => {
    const out: { id: string; label: string; accent: string; freq: number }[] = [];
    if (showManual && manualTimes.length) out.push({ id: 'manual', label: 'Boundaries', accent: '#f59e0b', freq: 2500 });
    if (showEye && eyeTimesAudio.length) out.push({ id: 'eye', label: 'Eye', accent: '#2dd4bf', freq: 1500 });
    if (showAutoGuess && autoGuessTimes.length) out.push({ id: 'autoGuess', label: 'Auto-G', accent: '#a78bfa', freq: 3500 });
    for (const e of userLayerAudioEntries) {
      out.push({ id: e.id, label: e.label, accent: e.accent, freq: e.freq });
    }
    return out;
  }, [showManual, showEye, showAutoGuess, manualTimes.length, eyeTimesAudio.length, autoGuessTimes.length, userLayerAudioEntries]);

  if (!playerUrl) return null;

  // Tempo-anchor flag mode for the DataPrep workspace. Static mode → no
  // flags. Dynamic / Manual → colored flags above the player row.
  const anchorFlagMode: 'dynamic' | 'manual' | null =
    (gridMode === 'dynamic' || gridMode === 'manual') && anchors && anchors.length > 0
      ? gridMode
      : null;

  // Release focus from a sidebar description input (cue/span/loop/pattern/
  // marker editors) the moment the user mousedowns anywhere on the viz —
  // waveform, transport, markers, lane rows. Without this, the textarea
  // keeps focus and the next Space keystroke types into it instead of
  // hitting the global play/pause shortcut.
  const blurTypingTargetOnMouseDown = useCallback(() => {
    const active = document.activeElement;
    if (isTypingTarget(active)) (active as HTMLElement).blur();
  }, []);

  return (
    <div
      className="bg-gray-900 rounded-xl overflow-hidden"
      onMouseDownCapture={blurTypingTargetOnMouseDown}
      style={{ ['--viz-label-w' as string]: `${labelColW}px` } as React.CSSProperties}
    >

      {/* ── Big timer + selection readout (Audacity-style) ── */}
      {!hideTimeDisplay && (
        <div className="flex items-stretch gap-2 pr-2 pt-2">
          <div className="w-[var(--viz-label-w,4.5rem)] shrink-0" />
          <div className="flex-1 min-w-0">
            <TimeDisplayBar
              currentTime={currentTime}
              pendingSelection={pendingSelection}
              previewRegion={previewRegion}
              showPlaybackIcon={!hidePlaybackIcon}
            />
          </div>
        </div>
      )}

      {/* Tempo-anchor flags now ride on top of the waveform itself (see
          PlayerPanel's `anchorFlagMode` prop), so the previous dedicated row
          here has been removed. */}

      {/* The Manual-mode per-beat editor now overlays the waveform itself
          (see PlayerPanel's `gridMode === 'manual'` branch), so the
          previous dedicated strip here has been removed. */}

      {/* ── Player row — same horizontal alignment as viz rows ── */}
      <div className="flex items-stretch gap-2 pr-2 pt-2">
        <div className="w-[var(--viz-label-w,4.5rem)] shrink-0" />
        <div className="flex-1 min-w-0">
          {stemSource && availableStemSources && onStemSourceChange && (
            <StemSourcePicker
              value={stemSource}
              available={availableStemSources}
              onChange={onStemSourceChange}
              onRunStems={onRunStems}
              runStemsStatus={runStemsStatus}
              runStemsProgressPct={runStemsProgressPct}
              runStemsElapsedSec={runStemsElapsedSec}
              runStemsLastLine={runStemsLastLine}
              runStemsCancelMode={runStemsCancelMode}
              onCancelStems={onCancelStems}
              onKillStems={onKillStems}
              runStemsErrorTail={runStemsErrorTail}
              onDismissStemsError={onDismissStemsError}
              isSongLoaded={audioBuffer != null}
            />
          )}
          <PlayerPanel
            url={playerUrl}
            trackName={trackName}
            bpm={effectiveBeatGrid.bpm}
            timeSignature={timeSignature}
            beatOffset={beatOffset}
            beatsPerBar={effectiveBeatGrid.beatsPerBar}
            barGroupSize={effectiveBeatGrid.barGroupSize} beatGroupSize={effectiveBeatGrid.beatGroupSize} gridThickness={gridLineThickness}
            subBeatDivision={effectiveBeatGrid.subBeatDivision}
            onBufferReady={onBufferReady}
            onReady={onReady}
            onTimeUpdate={onTimeUpdate}
            onViewChange={onViewChange}
            seekRef={seekRef}
            playRef={playRef}
            pauseRef={pauseRef}
            wsScrollRef={wsScrollRef}
            zoomInRef={zoomInRef}
            zoomOutRef={zoomOutRef}
            zoomResetRef={zoomResetRef}
            pinchZoomInRef={pinchZoomInRef}
            pinchZoomOutRef={pinchZoomOutRef}
            scrollToTimeRef={scrollToTimeRef}
            zoomToRangeRef={zoomToRangeRef}
            onScrollChange={onScrollChange}
            onPlayingChange={onPlayingChange}
            accent={playerAccent}
            onGridOffsetChange={onGridOffsetChange}
            onGridOffsetDragStart={onGridOffsetDragStart}
            showBarNumbers={showBarNumbers}
            anchors={anchors}
            beatOverrides={beatOverrides}
            anchorFlagMode={anchorFlagMode}
            onDeleteAnchor={gridMode === 'manual' ? onDeleteAnchor : undefined}
            onAnchorDrag={gridMode === 'manual' ? onAnchorDrag : undefined}
            onAnchorDragStart={gridMode === 'manual' ? onAnchorDragStart : undefined}
            gridMode={gridMode}
            onBeatDrag={onBeatDrag}
            onClearBeatOverride={onClearBeatOverride}
            manualEditLocked={manualEditLocked}
            pendingSelection={pendingSelection}
            previewRegion={previewRegion}
            onUserSeek={onVizClick}
            onUserRegion={onVizRegion}
            previewControls={previewRegion && onPreviewPlay && onPreviewPause && onPreviewLoopToggle && onPreviewDismiss ? {
              isPlaying: playerIsPlaying,
              loop: previewRegion.loop,
              onPlay: onPreviewPlay,
              onPause: onPreviewPause,
              onLoopToggle: onPreviewLoopToggle,
              onDismiss: onPreviewDismiss,
            } : null}
          />
        </div>
      </div>

      {/* ── Layer audio mixer — auralisation pip + pan/volume per layer.
           Lives OUTSIDE the scroll container so the popover isn't clipped. ── */}
      {onLayerAudioChange && audioMixerLayers.length > 0 && (
        <div className="flex items-stretch gap-2 pr-2 pt-1 relative z-30">
          <div className="w-[var(--viz-label-w,4.5rem)] shrink-0" />
          <div className="flex-1 flex flex-wrap items-center gap-2">
            <span
              className="text-[9px] text-gray-500 uppercase tracking-wide"
              title="Plays a short click pip whenever the playhead crosses a boundary in this layer. Useful for aurally checking annotation timing — try panning Manual to one ear and Auto-Guess to the other to hear the offset."
            >
              Layer audio:
            </span>
            {audioMixerLayers.map((l) => (
              <LayerAudioControls
                key={l.id}
                label={l.label}
                accentColor={l.accent}
                testFreq={l.freq}
                value={layerAudioConfig?.[l.id] ?? DEFAULT_LAYER_AUDIO}
                onChange={(next) => onLayerAudioChange(l.id, next)}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Section-color palette + reset row order. Lives OUTSIDE the scroll
           container (like the layer-audio mixer above) so the swatches stay
           pinned in place instead of sliding off-screen when the timeline is
           panned horizontally. ── */}
      {(visibleSectionTypes.length > 0 || hasCustomRowOrder || (sectionColorOverrides && Object.keys(sectionColorOverrides).length > 0)) && (
        <div className="flex items-stretch gap-2 pr-2 pt-1">
          <div className="w-[var(--viz-label-w,4.5rem)] shrink-0" />
          <div className="flex-1 flex flex-wrap items-center gap-2">
            {visibleSectionTypes.length > 0 && onSectionColorChange && (
              <>
                <span className="text-[9px] text-gray-500 uppercase tracking-wide">Section colors:</span>
                {visibleSectionTypes.map((type) => {
                  const current = sectionColorOverrides?.[type] ?? sectionBg(type);
                  return (
                    <label key={type} className="flex items-center gap-1 cursor-pointer" title={`Recolor "${type}" sections across all rows`}>
                      <span className="relative w-3 h-3 rounded-full border border-gray-700 shrink-0" style={{ backgroundColor: current }}>
                        <input
                          type="color"
                          value={current}
                          onChange={(e) => onSectionColorChange(type, e.target.value)}
                          className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                        />
                      </span>
                      <span className="text-[10px] text-gray-400">{type}</span>
                    </label>
                  );
                })}
              </>
            )}
            {(hasCustomRowOrder || (sectionColorOverrides && Object.keys(sectionColorOverrides).length > 0)) && (
              <button
                onClick={() => { onResetRowOrder?.(); onResetSectionColors?.(); }}
                className="ml-auto text-[10px] text-gray-500 hover:text-gray-300 px-2 py-0.5 rounded border border-gray-800 hover:border-gray-700 transition-colors"
                title="Reset row order and section colors to defaults"
              >
                ↺ Reset
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Scrollable viz rows (same horizontal alignment via pr-2 — no
           left padding, so the sticky label gutter sits flush at the panel's
           left edge; player/time-display rows above drop their left padding
           the same way to stay aligned) ── */}
      <div
        ref={vizScrollContainerRef}
        className="overflow-x-auto overflow-y-hidden overscroll-x-none pr-2 pb-2"
        style={{ scrollbarWidth: 'thin', scrollbarColor: '#374151 #111827' }}
        onScroll={onVizScroll}
      >
        {/* vizSignalWidth is the player's bare waveform width at this zoom. Add
            the sticky label gutter — labelColW (var(--viz-label-w)) plus the
            0.5rem gap folded into STICKY_LABEL_CELL — so every row's flex-1
            content column ends up exactly as wide as the player's waveform.
            Using a fixed gutter here instead of the real (resizable) labelColW
            drifts the cursor/highlight by (gutterError)·(t/duration) px. */}
        <div
          className="relative space-y-1 pt-1"
          style={{ minWidth: vizSignalWidth > 0 ? `${vizSignalWidth + labelColW + 8}px` : undefined }}
        >
          {/* Rows in configurable order */}
          {(rowOrder ?? DEFAULT_FIXED_ROW_ORDER).map((rowId) => {
            const dragHandlers = makeDragHandlers(rowId);
            const dropProps = makeRowDropHandlers(rowId);
            const isDragging = draggedRowId === rowId;
            const isDropTarget = dropTargetRowId === rowId && draggedRowId !== rowId;
            // No `gap-2`: STICKY_LABEL_CELL is widened to include the gap, so
            // the label's solid bg butts directly against the content edge.
            const rowClass = `flex items-stretch transition-opacity ${isDragging ? 'opacity-40' : ''} ${isDropTarget ? 'bg-violet-900/20 ring-1 ring-violet-700/40 rounded' : ''}`;

            switch (rowId) {
              case 'waveform':
                if (!showWaveform) return null;
                return (
                  <div key="waveform" className={rowClass} {...dropProps}>
                    <RowLabel text="3-Band" color="text-blue-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
                        <div className="flex-1 min-w-0 overflow-hidden">
                      <TimeRuler duration={duration} height={16} />
                      <div ref={waveformBoxRef} className="relative">
                        <FrequencyWaveform
                          audioBuffer={audioBuffer}
                          currentTime={currentTime}
                          duration={duration || undefined}
                          bpm={beatGrid.bpm}
                          beatOffset={beatOffset}
                          beatsPerBar={beatGrid.beatsPerBar}
                          barGroupSize={effectiveBeatGrid.barGroupSize} beatGroupSize={effectiveBeatGrid.beatGroupSize} gridThickness={gridLineThickness}
                          subBeatDivision={effectiveBeatGrid.subBeatDivision}
                          anchors={anchors}
                          beatOverrides={beatOverrides}
                          onSeek={onVizClick}
                          onRegion={onVizRegion}
                          onRegionDragStart={onRegionDragStart}
                          onGridOffsetChange={onGridOffsetChange}
                          onGridOffsetDragStart={onGridOffsetDragStart}
                          snapToGrid={snapToGrid && !!beatGrid.bpm}
                        />
                        <AnnotationOverlays
                          duration={duration}
                          currentTime={currentTime}
                          isPlaying={playerIsPlaying}
                          manualSections={manualSections}
                          showManual={showManual && showSignalOverlays}
                          onManualMarkerDrag={showSignalOverlays ? onManualMarkerDrag : undefined}
                          eyeTimes={eyeTimes}
                          showEye={showEye && showSignalOverlays}
                          onEyeMarkerDrag={showSignalOverlays ? onEyeMarkerDrag : undefined}
                          onEyeMarkerDragStart={showSignalOverlays ? onEyeMarkerDragStart : undefined}
                          pendingSelection={pendingSelection}
                          grid={gridProps}
                        />
                        <SignalMarkersOverlay
                          points={signalOverlayMarkers.points}
                          bands={signalOverlayMarkers.bands}
                          duration={duration}
                        />
                      </div>
                    </div>
                  </div>
                );

              case 'eq':
                if (!showEQ) return null;
                return (
                  <div key="eq" className={rowClass} {...dropProps}>
                    <RowLabel text="EQ" color="text-blue-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
                    <div className="flex-1 min-w-0 relative overflow-hidden">
                      <EQVisualizer
                        mirCurves={mirCurves}
                        loading={mirComputing}
                        duration={duration}
                        currentTime={currentTime}
                        onSeek={onVizClick}
                        gridProps={gridProps}
                      />
                      <SignalMarkersOverlay
                        points={signalOverlayMarkers.points}
                        bands={signalOverlayMarkers.bands}
                        duration={duration}
                      />
                      {pendingSelection && (
                        <PendingHighlightOverlay sel={pendingSelection} duration={duration} grid={gridProps} />
                      )}
                      <RegionDragOverlay duration={duration} onVizClick={onVizClick} onVizRegion={onVizRegion} onRegionDragStart={onRegionDragStart} />
                    </div>
                  </div>
                );

              case 'manual':
                if (!showManual || !manualBlockSections.length) return null;
                return (
                  <div key="manual" className={rowClass} {...dropProps}>
                    <div
                      className={`${STICKY_LABEL_CELL} gap-1 ${dragHandlers ? 'cursor-grab active:cursor-grabbing' : ''}`}
                      draggable={dragHandlers?.draggable}
                      onDragStart={dragHandlers?.onDragStart}
                      onDragEnd={dragHandlers?.onDragEnd}
                      title={dragHandlers ? 'Drag to reorder' : undefined}
                    >
                      {onManualUndo && (
                        <button onClick={onManualUndo} disabled={!canManualUndo} title="Undo last change" className="text-[10px] leading-none disabled:opacity-20 text-amber-400/70 hover:text-amber-300 transition-opacity">↩</button>
                      )}
                      <span className="text-[10px] uppercase tracking-wide text-right leading-tight break-words text-amber-400/70">Boundaries</span>
                      <LabelResizeHandle onResizeStart={handleLabelColResizeStart} />
                    </div>
                    <SectionBlockRow
                      sections={manualBlockSections}
                      duration={duration}
                      currentTime={currentTime}
                      onBoundaryChange={onManualBoundaryChange}
                      onBoundaryDragStart={onManualBoundaryDragStart}
                      onSectionClick={onManualSectionClick}
                      sectionColorOverrides={sectionColorOverrides}
                      gridProps={gridProps}
                      pendingSelection={pendingSelection}
                    />
                  </div>
                );

              case 'eye':
                if (!showEye) return null;
                return (
                  <div key="eye" className={rowClass} {...dropProps}>
                    <RowLabel text="Eye" color="text-teal-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
                    <div className="flex-1 min-w-0 overflow-hidden flex items-stretch">
                      {eyeBlockSections.length > 0
                        ? <SectionBlockRow sections={eyeBlockSections} duration={duration} currentTime={currentTime} onSectionClick={onEyeSectionClick} sectionColorOverrides={sectionColorOverrides} gridProps={gridProps} pendingSelection={pendingSelection} />
                        : <div className="flex-1 h-5 rounded bg-gray-900/30 flex items-center px-2"><span className="text-[10px] text-gray-700 italic">no eye annotation</span></div>
                      }
                    </div>
                  </div>
                );

              case 'autoGuess':
                if (!showAutoGuess) return null;
                return (
                  <div key="autoGuess" {...dropProps} className={`${isDragging ? 'opacity-40' : ''} ${isDropTarget ? 'bg-violet-900/20 ring-1 ring-violet-700/40 rounded' : ''}`}>
                    <div className="flex items-stretch">
                      <RowLabel text="Auto-guess" color="text-violet-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} wrap />
                      <div className="flex-1 min-w-0 overflow-hidden flex items-stretch">
                        {autoGuessBlockSections.length > 0
                          ? <SectionBlockRow
                              sections={autoGuessBlockSections}
                              duration={duration}
                              currentTime={currentTime}
                              height={20}
                              gridProps={gridProps}
                              pendingSelection={pendingSelection}
                              onSectionClick={expandThreshold > 0 ? (i) => {
                                const sortedIds = [...(autoGuessPoints ?? [])].sort((a, b) => a.time - b.time);
                                const id = sortedIds[i]?.id;
                                if (id) toggleAutoGuessExpanded(id);
                              } : undefined}
                            />
                          : <div className="flex-1 h-5 rounded bg-gray-900/30 flex items-center px-2"><span className="text-[10px] text-gray-700 italic">no auto-guess annotation</span></div>
                        }
                      </div>
                    </div>
                    {autoGuessBlockSections.length > 0 && (
                      <div className="flex items-stretch">
                        {/* Opaque sticky gutter cell (matches the title column) so the
                            review overlay slides *behind* the labels when scrolled
                            horizontally, instead of over them. */}
                        <div className="w-[calc(var(--viz-label-w,4.5rem)_+_0.5rem)] shrink-0 sticky left-0 z-30 bg-gray-900" />
                        <div className="flex-1 min-w-0 overflow-hidden">
                          <AutoGuessOverlay
                            points={autoGuessPoints!}
                            duration={duration}
                            currentTime={currentTime}
                            isPlaying={playerIsPlaying}
                            onMarkCorrect={onMarkCorrect ?? (() => {})}
                            onMarkIncorrect={onMarkIncorrect ?? (() => {})}
                            onMarkPending={onMarkPending ?? (() => {})}
                            onPlay={handlePlay}
                            onPause={handlePause}
                            expandedPointIds={expandedAutoGuessPointIds}
                            onToggleExpanded={toggleAutoGuessExpanded}
                            expandZoomThreshold={expandThreshold}
                            zoomFactor={vizZoomFactor}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );

              case 'spectrogram':
                if (!showSpectrogram || !audioBuffer) return null;
                return (
                  <div key="spectrogram" className={rowClass} {...dropProps}>
                    <RowLabel text="Spectro" color="text-violet-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
                    <div className="flex-1 min-w-0 overflow-hidden">
                      <TimeRuler duration={duration} height={16} />
                      <div className="relative">
                        <SpectrogramAnnotated
                          audioBuffer={audioBuffer}
                          sections={[]}
                          duration={duration}
                          currentTime={currentTime}
                          height={80}
                          bpm={beatGrid.bpm}
                          beatOffset={beatOffset}
                          beatsPerBar={beatGrid.beatsPerBar}
                          barGroupSize={effectiveBeatGrid.barGroupSize} beatGroupSize={effectiveBeatGrid.beatGroupSize} gridThickness={gridLineThickness}
                          subBeatDivision={effectiveBeatGrid.subBeatDivision}
                        />
                        <SpectrogramDragOverlay
                          duration={duration}
                          currentTime={currentTime}
                          manualSections={manualSections}
                          showManual={showManual && showSignalOverlays}
                          onManualMarkerDrag={showSignalOverlays ? onManualMarkerDrag : undefined}
                          eyeTimes={eyeTimes}
                          showEye={showEye && showSignalOverlays}
                          onEyeMarkerDrag={showSignalOverlays ? onEyeMarkerDrag : undefined}
                          onEyeMarkerDragStart={showSignalOverlays ? onEyeMarkerDragStart : undefined}
                          pendingSelection={pendingSelection}
                          onVizClick={onVizClick}
                          onVizRegion={onVizRegion}
                          onRegionDragStart={onRegionDragStart}
                          snapToGrid={snapToGrid && !!beatGrid.bpm}
                          bpm={beatGrid.bpm}
                          beatOffset={beatOffset}
                          beatsPerBar={beatGrid.beatsPerBar}
                          anchors={anchors}
                          beatOverrides={beatOverrides}
                        />
                        <SignalMarkersOverlay
                          points={signalOverlayMarkers.points}
                          bands={signalOverlayMarkers.bands}
                          duration={duration}
                        />
                      </div>
                    </div>
                  </div>
                );

              case 'cepstrogram': {
                if (!showCepstrogram || !mirCurves?.mfcc || !mirCurves.nMfcc || !mirCurves.frameCount) return null;
                return (
                  <div key="cepstrogram" className={rowClass} {...dropProps}>
                    <RowLabel text="MFCC" color="text-violet-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
                    <div className="flex-1 min-w-0 relative overflow-hidden">
                      <CepstrogramAnnotated
                        mfcc={mirCurves.mfcc}
                        nMfcc={mirCurves.nMfcc}
                        frameCount={mirCurves.frameCount}
                        duration={duration}
                        currentTime={currentTime}
                        height={70}
                        bpm={beatGrid.bpm}
                        beatOffset={beatOffset}
                        beatsPerBar={beatGrid.beatsPerBar}
                        barGroupSize={effectiveBeatGrid.barGroupSize} beatGroupSize={effectiveBeatGrid.beatGroupSize} gridThickness={gridLineThickness}
                        subBeatDivision={effectiveBeatGrid.subBeatDivision}
                      />
                      <SignalMarkersOverlay
                        points={signalOverlayMarkers.points}
                        bands={signalOverlayMarkers.bands}
                        duration={duration}
                      />
                      {pendingSelection && (
                        <PendingHighlightOverlay sel={pendingSelection} duration={duration} grid={gridProps} />
                      )}
                      <RegionDragOverlay duration={duration} onVizClick={onVizClick} onVizRegion={onVizRegion} onRegionDragStart={onRegionDragStart} />
                    </div>
                  </div>
                );
              }

              case 'chroma': {
                if (!showChroma || !mirCurves?.chroma || !mirCurves.nChroma || !mirCurves.frameCount) return null;
                return (
                  <div key="chroma" className={rowClass} {...dropProps}>
                    <RowLabel text="Chroma" color="text-lime-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
                    <div className="flex-1 min-w-0 relative overflow-hidden">
                      <ChromagramAnnotated
                        chroma={mirCurves.chroma}
                        nChroma={mirCurves.nChroma}
                        frameCount={mirCurves.frameCount}
                        duration={duration}
                        currentTime={currentTime}
                        height={80}
                        bpm={beatGrid.bpm}
                        beatOffset={beatOffset}
                        beatsPerBar={beatGrid.beatsPerBar}
                        barGroupSize={effectiveBeatGrid.barGroupSize} beatGroupSize={effectiveBeatGrid.beatGroupSize} gridThickness={gridLineThickness}
                      />
                      <SignalMarkersOverlay
                        points={signalOverlayMarkers.points}
                        bands={signalOverlayMarkers.bands}
                        duration={duration}
                      />
                      {pendingSelection && (
                        <PendingHighlightOverlay sel={pendingSelection} duration={duration} grid={gridProps} />
                      )}
                      <RegionDragOverlay duration={duration} onVizClick={onVizClick} onVizRegion={onVizRegion} onRegionDragStart={onRegionDragStart} />
                    </div>
                  </div>
                );
              }

              case 'tempogram': {
                if (!showTempogram || !mirCurves?.tempogram || !mirCurves.nTempo || !mirCurves.tempogramFrameCount || !mirCurves.tempoBpm) return null;
                return (
                  <div key="tempogram" className={rowClass} {...dropProps}>
                    <RowLabel text="Tempo" color="text-fuchsia-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
                    <div className="flex-1 min-w-0 relative overflow-hidden">
                      <TempogramAnnotated
                        tempogram={mirCurves.tempogram}
                        nTempo={mirCurves.nTempo}
                        tempogramFrameCount={mirCurves.tempogramFrameCount}
                        tempoBpm={mirCurves.tempoBpm}
                        duration={duration}
                        currentTime={currentTime}
                        height={90}
                        bpm={beatGrid.bpm}
                        beatOffset={beatOffset}
                        beatsPerBar={beatGrid.beatsPerBar}
                        barGroupSize={effectiveBeatGrid.barGroupSize} beatGroupSize={effectiveBeatGrid.beatGroupSize} gridThickness={gridLineThickness}
                      />
                      <SignalMarkersOverlay
                        points={signalOverlayMarkers.points}
                        bands={signalOverlayMarkers.bands}
                        duration={duration}
                      />
                      {pendingSelection && (
                        <PendingHighlightOverlay sel={pendingSelection} duration={duration} grid={gridProps} />
                      )}
                      <RegionDragOverlay duration={duration} onVizClick={onVizClick} onVizRegion={onVizRegion} onRegionDragStart={onRegionDragStart} />
                    </div>
                  </div>
                );
              }

              case 'ssm': {
                if (!showSsm || !mirCurves?.ssm || !mirCurves.ssmFrameCount) return null;
                return (
                  <div key="ssm" className={rowClass} {...dropProps}>
                    <RowLabel text="SSM" color="text-orange-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
                    <div className="flex-1 min-w-0 relative overflow-hidden">
                      <SsmAnnotated
                        ssm={mirCurves.ssm}
                        ssmFrameCount={mirCurves.ssmFrameCount}
                        duration={duration}
                        currentTime={currentTime}
                        height={180}
                        bpm={beatGrid.bpm}
                        beatOffset={beatOffset}
                        beatsPerBar={beatGrid.beatsPerBar}
                        barGroupSize={effectiveBeatGrid.barGroupSize} beatGroupSize={effectiveBeatGrid.beatGroupSize} gridThickness={gridLineThickness}
                      />
                      <SignalMarkersOverlay
                        points={signalOverlayMarkers.points}
                        bands={signalOverlayMarkers.bands}
                        duration={duration}
                      />
                      {pendingSelection && (
                        <PendingHighlightOverlay sel={pendingSelection} duration={duration} grid={gridProps} />
                      )}
                      <RegionDragOverlay duration={duration} onVizClick={onVizClick} onVizRegion={onVizRegion} onRegionDragStart={onRegionDragStart} />
                    </div>
                  </div>
                );
              }

              case 'energy':
                if (!showEnergy || !mirCurves?.energy?.length) return null;
                return <div key="energy" className={rowClass} {...dropProps}><Sparkline label="Energy" data={mirCurves.energy} color="#f59e0b" height={40} currentTime={currentTime} duration={duration} onSeek={onVizClick} onRegion={onVizRegion} onRegionDragStart={onRegionDragStart} dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} overlay={sparklineOverlay} pendingSelection={pendingSelection} signalMarkers={signalOverlayMarkers} gridProps={gridProps} /></div>;

              case 'brightness':
                if (!showBrightness || !mirCurves?.spectral?.length) return null;
                return <div key="brightness" className={rowClass} {...dropProps}><Sparkline label="Bright" data={mirCurves.spectral} color="#22d3ee" height={36} currentTime={currentTime} duration={duration} onSeek={onVizClick} onRegion={onVizRegion} onRegionDragStart={onRegionDragStart} dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} overlay={sparklineOverlay} pendingSelection={pendingSelection} signalMarkers={signalOverlayMarkers} gridProps={gridProps} /></div>;

              case 'novelty':
                if (!showNovelty || !mirCurves?.novelty?.length) return null;
                return <div key="novelty" className={rowClass} {...dropProps}><Sparkline label="Novelty" data={mirCurves.novelty} color="#a78bfa" height={36} currentTime={currentTime} duration={duration} onSeek={onVizClick} onRegion={onVizRegion} onRegionDragStart={onRegionDragStart} dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} overlay={sparklineOverlay} pendingSelection={pendingSelection} signalMarkers={signalOverlayMarkers} gridProps={gridProps} /></div>;

              case 'onsets':
                if (!showOnsets || !mirCurves?.onsets?.length) return null;
                return <div key="onsets" className={rowClass} {...dropProps}><Sparkline label="Onsets" data={mirCurves.onsets} color="#f472b6" height={32} currentTime={currentTime} duration={duration} onSeek={onVizClick} onRegion={onVizRegion} onRegionDragStart={onRegionDragStart} dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} overlay={sparklineOverlay} pendingSelection={pendingSelection} signalMarkers={signalOverlayMarkers} gridProps={gridProps} /></div>;

              case 'flux':
                if (!showFlux || !mirCurves?.flux?.length) return null;
                return <div key="flux" className={rowClass} {...dropProps}><Sparkline label="Flux" data={mirCurves.flux} color="#10b981" height={32} currentTime={currentTime} duration={duration} onSeek={onVizClick} onRegion={onVizRegion} onRegionDragStart={onRegionDragStart} dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} overlay={sparklineOverlay} pendingSelection={pendingSelection} signalMarkers={signalOverlayMarkers} gridProps={gridProps} /></div>;

              default: {
                // User-created Pattern layer row. Each pattern item expands
                // into N tiled copies before lane-assignment (overlap with
                // other patterns bumps tiles down a lane).
                if (rowId.startsWith('pattern-layer:')) {
                  const layer = patternLayers?.find((l) => `pattern-layer:${l.id}` === rowId);
                  if (!layer || !layer.visible) return null;
                  const { isSelected, onSelect } = layerSelectionFor('patterns', layer);
                  return (
                    <div
                      key={rowId}
                      className={rowClass}
                      {...dropProps}
                    >
                      <LayerRowLabel
                        layer={layer}
                        isSelected={isSelected}
                        onSelect={onSelect}
                        dragHandlers={dragHandlers}
                        onResizeStart={handleLabelColResizeStart}
                      />
                      <div
                        className={`flex-1 min-w-0 flex items-stretch ${isSelected ? 'rounded-sm' : ''}`}
                        style={isSelected ? { boxShadow: `0 0 0 1px ${layer.color}aa, 0 0 14px ${layer.color}55`, clipPath: 'inset(-16px -16px -16px 0)' } : undefined}
                      >
                      <PatternLaneRow
                        items={layer.items}
                        color={layer.color}
                        duration={duration}
                        currentTime={currentTime}
                        focusedItemId={focusedPattern?.layerId === layer.id ? focusedPattern.itemId : null}
                        playingItemId={playingPatternId ?? null}
                        onPatternClick={(itemId, anchor) => onPatternClick?.(layer.id, itemId, anchor)}
                        onPatternEdgeDrag={onPatternEdgeDrag
                          ? (itemId, edge, time) => onPatternEdgeDrag(layer.id, itemId, edge, time)
                          : undefined}
                        onPatternEdgeDragStart={onPatternEdgeDragStart
                          ? (itemId, edge) => onPatternEdgeDragStart(layer.id, itemId, edge)
                          : undefined}
                        onPatternMove={onPatternMove
                          ? (itemId, ns, ne) => onPatternMove(layer.id, itemId, ns, ne)
                          : undefined}
                        onPatternMoveStart={onPatternMoveStart
                          ? (itemId) => onPatternMoveStart(layer.id, itemId)
                          : undefined}
                        gridProps={gridProps}
                        pendingSelection={pendingSelection}
                        reviewState={detectorLayerReview?.[layer.id]}
                        onAccept={(itemId) => onDetectorLayerAccept?.(layer.id, itemId)}
                        onReject={(itemId) => onDetectorLayerReject?.(layer.id, itemId)}
                      />
                      </div>
                    </div>
                  );
                }
                // User-created Span layer row. Spans MAY overlap, so the
                // row uses lane-assignment rendering (variable height).
                if (rowId.startsWith('span-layer:')) {
                  const layer = spanLayers?.find((l) => `span-layer:${l.id}` === rowId);
                  if (!layer || !layer.visible) return null;
                  const { isSelected, onSelect } = layerSelectionFor('spans', layer);
                  return (
                    <div
                      key={rowId}
                      className={rowClass}
                      {...dropProps}
                    >
                      <LayerRowLabel
                        layer={layer}
                        isSelected={isSelected}
                        onSelect={onSelect}
                        dragHandlers={dragHandlers}
                        onResizeStart={handleLabelColResizeStart}
                      />
                      <div
                        className={`flex-1 min-w-0 flex items-stretch ${isSelected ? 'rounded-sm' : ''}`}
                        style={isSelected ? { boxShadow: `0 0 0 1px ${layer.color}aa, 0 0 14px ${layer.color}55`, clipPath: 'inset(-16px -16px -16px 0)' } : undefined}
                      >
                      <SpanLaneRow
                        items={layer.items}
                        color={layer.color}
                        duration={duration}
                        currentTime={currentTime}
                        focusedItemId={focusedSpan?.layerId === layer.id ? focusedSpan.itemId : null}
                        onSpanClick={(itemId, anchor) => onSpanClick?.(layer.id, itemId, anchor)}
                        onSpanEdgeDrag={onSpanEdgeDrag
                          ? (itemId, edge, time) => onSpanEdgeDrag(layer.id, itemId, edge, time)
                          : undefined}
                        onSpanEdgeDragStart={onSpanEdgeDragStart
                          ? (itemId, edge) => onSpanEdgeDragStart(layer.id, itemId, edge)
                          : undefined}
                        onSpanMove={onSpanMove
                          ? (itemId, ns, ne) => onSpanMove(layer.id, itemId, ns, ne)
                          : undefined}
                        onSpanMoveStart={onSpanMoveStart
                          ? (itemId) => onSpanMoveStart(layer.id, itemId)
                          : undefined}
                        gridProps={gridProps}
                        pendingSelection={pendingSelection}
                        reviewState={detectorLayerReview?.[layer.id]}
                        onAccept={(itemId) => onDetectorLayerAccept?.(layer.id, itemId)}
                        onReject={(itemId) => onDetectorLayerReject?.(layer.id, itemId)}
                      />
                      </div>
                    </div>
                  );
                }
                // User-created Loop layer row. Each Loop layer renders as
                // interval bands; clicking a band fires onLoopClick.
                if (rowId.startsWith('loop-layer:')) {
                  const layer = loopLayers?.find((l) => `loop-layer:${l.id}` === rowId);
                  if (!layer || !layer.visible) return null;
                  const { isSelected, onSelect } = layerSelectionFor('loops', layer);
                  return (
                    <div
                      key={rowId}
                      className={rowClass}
                      {...dropProps}
                    >
                      <LayerRowLabel
                        layer={layer}
                        isSelected={isSelected}
                        onSelect={onSelect}
                        dragHandlers={dragHandlers}
                        onResizeStart={handleLabelColResizeStart}
                      />
                      <div
                        className={`flex-1 min-w-0 flex items-stretch ${isSelected ? 'rounded-sm' : ''}`}
                        style={isSelected ? { boxShadow: `0 0 0 1px ${layer.color}aa, 0 0 14px ${layer.color}55`, clipPath: 'inset(-16px -16px -16px 0)' } : undefined}
                      >
                      <LoopLayerRow
                        items={layer.items}
                        color={layer.color}
                        duration={duration}
                        currentTime={currentTime}
                        focusedItemId={focusedLoop?.layerId === layer.id ? focusedLoop.itemId : null}
                        playingItemId={playingLoopId ?? null}
                        onLoopClick={(itemId, anchor) => onLoopClick?.(layer.id, itemId, anchor)}
                        onLoopEdgeDrag={onLoopEdgeDrag
                          ? (itemId, edge, time) => onLoopEdgeDrag(layer.id, itemId, edge, time)
                          : undefined}
                        onLoopEdgeDragStart={onLoopEdgeDragStart
                          ? (itemId, edge) => onLoopEdgeDragStart(layer.id, itemId, edge)
                          : undefined}
                        onLoopMove={onLoopMove
                          ? (itemId, ns, ne) => onLoopMove(layer.id, itemId, ns, ne)
                          : undefined}
                        onLoopMoveStart={onLoopMoveStart
                          ? (itemId) => onLoopMoveStart(layer.id, itemId)
                          : undefined}
                        gridProps={gridProps}
                        pendingSelection={pendingSelection}
                        reviewState={detectorLayerReview?.[layer.id]}
                        onAccept={(itemId) => onDetectorLayerAccept?.(layer.id, itemId)}
                        onReject={(itemId) => onDetectorLayerReject?.(layer.id, itemId)}
                      />
                      </div>
                    </div>
                  );
                }
                // User-created Cue layer row. Each Cue layer renders as a single
                // tick-mark row; clicking a tick fires onCueClick so the parent
                // can open the inline edit popover.
                if (rowId.startsWith('cue-layer:')) {
                  const layer = cueLayers?.find((l) => `cue-layer:${l.id}` === rowId);
                  if (!layer || !layer.visible) return null;
                  const { isSelected, onSelect } = layerSelectionFor('cues', layer);
                  return (
                    <div
                      key={rowId}
                      className={rowClass}
                      {...dropProps}
                    >
                      <LayerRowLabel
                        layer={layer}
                        isSelected={isSelected}
                        onSelect={onSelect}
                        dragHandlers={dragHandlers}
                        onResizeStart={handleLabelColResizeStart}
                      />
                      <div
                        className={`flex-1 min-w-0 flex items-stretch ${isSelected ? 'rounded-sm' : ''}`}
                        style={isSelected ? { boxShadow: `0 0 0 1px ${layer.color}aa, 0 0 14px ${layer.color}55`, clipPath: 'inset(-16px -16px -16px 0)' } : undefined}
                      >
                        <CueLayerRow
                          items={layer.items}
                          color={layer.color}
                          duration={duration}
                          currentTime={currentTime}
                          focusedItemId={focusedCue?.layerId === layer.id ? focusedCue.itemId : null}
                          onCueClick={(itemId, anchor) => onCueClick?.(layer.id, itemId, anchor)}
                          onCueDrag={onCueDrag
                            ? (itemId, time) => onCueDrag(layer.id, itemId, time)
                            : undefined}
                          onCueDragStart={onCueDragStart
                            ? (itemId) => onCueDragStart(layer.id, itemId)
                            : undefined}
                          gridProps={gridProps}
                          pendingSelection={pendingSelection}
                          reviewState={detectorLayerReview?.[layer.id]}
                          onAccept={(itemId) => onDetectorLayerAccept?.(layer.id, itemId)}
                          onReject={(itemId) => onDetectorLayerReject?.(layer.id, itemId)}
                        />
                      </div>
                    </div>
                  );
                }
                // Custom annotation row (is_annotation detector). Layout mirrors the
                // built-in autoGuess row: a colored block strip on top, AutoGuessOverlay
                // review cards below, each scoped to this detector's pointId namespace.
                if (rowId.startsWith('custom-annotation:')) {
                  const cfg = customAnnotationRows?.find((r) => r.rowId === rowId);
                  if (!cfg) return null;
                  if (hiddenCustomAnnotations?.has(cfg.detectorName)) return null;
                  const sorted = [...cfg.points].sort((a, b) => a.time - b.time);
                  const blocks = sorted.map((p, i) => ({
                    time: p.time,
                    endTime: sorted[i + 1]?.time ?? duration,
                    label: p.status === 'pending' ? '?' : p.status === 'correct' ? '✓' : p.status === 'incorrect' ? '✗' : '~',
                    type: 'autoGuess',
                    color:
                      p.status === 'correct'   ? '#14b8a6' :
                      p.status === 'incorrect' ? '#f87171' :
                      p.status === 'partial'   ? '#f59e0b' :
                      Math.abs(p.time - p.originalTime) > 0.01 ? '#6366f1' :
                                                 '#4b5563',
                  }));
                  return (
                    <div key={rowId} {...dropProps} className={`${isDragging ? 'opacity-40' : ''} ${isDropTarget ? 'bg-amber-900/20 ring-1 ring-amber-700/40 rounded' : ''}`}>
                      <div className="flex items-stretch">
                        <div
                          className={`${STICKY_LABEL_CELL} ${dragHandlers ? 'cursor-grab active:cursor-grabbing' : ''}`}
                          draggable={dragHandlers?.draggable}
                          onDragStart={dragHandlers?.onDragStart}
                          onDragEnd={dragHandlers?.onDragEnd}
                          title={dragHandlers ? 'Drag to reorder' : undefined}
                        >
                          <span
                            className="text-[10px] uppercase tracking-wide text-right leading-tight break-words"
                            style={{ color: cfg.color }}
                          >
                            {cfg.label}
                          </span>
                          <LabelResizeHandle onResizeStart={handleLabelColResizeStart} />
                        </div>
                        {blocks.length > 0
                          ? <SectionBlockRow
                              sections={blocks}
                              duration={duration}
                              currentTime={currentTime}
                              height={20}
                              gridProps={gridProps}
                              onSectionClick={expandThreshold > 0 ? (i) => {
                                const id = sorted[i]?.id;
                                if (id) toggleAutoGuessExpanded(id);
                              } : undefined}
                            />
                          : <div className="flex-1 h-5 rounded bg-gray-900/30 flex items-center px-2"><span className="text-[10px] text-gray-700 italic">no items — run the detector on this song</span></div>
                        }
                      </div>
                      {cfg.points.length > 0 && (
                        <div className="flex items-stretch">
                          {/* Opaque sticky gutter cell (matches the title column) so the
                              review overlay slides *behind* the labels when scrolled
                              horizontally, instead of over them. */}
                          <div className="w-[calc(var(--viz-label-w,4.5rem)_+_0.5rem)] shrink-0 sticky left-0 z-30 bg-gray-900" />
                          <div className="flex-1 min-w-0 overflow-hidden">
                            <AutoGuessOverlay
                              points={cfg.points}
                              duration={duration}
                              currentTime={currentTime}
                              isPlaying={playerIsPlaying}
                              onMarkCorrect={(id) => onCustomAnnotationMarkCorrect?.(cfg.detectorName, id)}
                              onMarkIncorrect={(id) => onCustomAnnotationMarkIncorrect?.(cfg.detectorName, id)}
                              onMarkPending={(id) => onCustomAnnotationMarkPending?.(cfg.detectorName, id)}
                              onPlay={handlePlay}
                              onPause={handlePause}
                              expandedPointIds={expandedAutoGuessPointIds}
                              onToggleExpanded={toggleAutoGuessExpanded}
                              expandZoomThreshold={expandThreshold}
                              zoomFactor={vizZoomFactor}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                }
                const overlay = algoOverlays.find((o) => o.id === rowId);
                if (!overlay) return null;
                const focusedIdx = algoPopover.open && algoPopover.open.layerId === rowId
                  ? Number(algoPopover.open.itemId)
                  : null;
                return (
                  <div key={rowId} className={rowClass} {...dropProps}>
                    <AlgoTimelineRow
                      label={overlay.label}
                      labelColor={overlay.labelColor}
                      renderKind={overlay.renderKind}
                      sections={overlay.sections}
                      duration={duration}
                      currentTime={currentTime}
                      dragHandlers={dragHandlers}
                      onResizeStart={handleLabelColResizeStart}
                      sectionColorOverrides={sectionColorOverrides}
                      gridProps={gridProps}
                      focusedSectionIdx={focusedIdx}
                      onSectionClick={(idx, anchor) => algoPopover.openAt(rowId, String(idx), anchor)}
                    />
                  </div>
                );
              }
            }
          })}

          {/* ── Tall PreviewBand — single highlight spanning every viz row's
               content column. Background is pointer-events:none so row
               interactions (drag-to-region, marker drag, click-to-clear) keep
               working under the band. The left offset must equal the sticky
               label gutter — var(--viz-label-w) (= resizable labelColW) plus
               the 0.5rem gap folded into STICKY_LABEL_CELL — so the band's
               content column lines up with every row's flex-1 content (and the
               player's waveform). A fixed 4.5rem here drew the band ~8px off
               from the cursor / pending highlight once the gutter was widened. ── */}
          {previewRegion && (
            <div
              ref={previewBandParentRef}
              className="absolute top-0 bottom-0 pointer-events-none"
              style={{ left: 'calc(var(--viz-label-w, 4.5rem) + 0.5rem)', right: 0 }}
            >
              <PreviewWindow
                region={previewRegion}
                duration={duration}
                isPlaying={playerIsPlaying}
                parentRef={previewBandParentRef}
                onChange={onPreviewRegionChange ?? (() => {})}
                onPlay={onPreviewPlay ?? (() => {})}
                onPause={onPreviewPause ?? (() => {})}
                onDismiss={onPreviewDismiss ?? (() => {})}
                onLoopToggle={onPreviewLoopToggle ?? (() => {})}
                // The single control bar lives on PlayerPanel above (its
                // overflow-y context isn't clipped). In-band controls here
                // would be hidden by the viz scroll container anyway.
                showControls={false}
              />
            </div>
          )}
        </div>
      </div>

      {/* Floating algo-output card — opens on click of any algo timeline
          block. Uses the same AnnotationPointCard as the cue/span/loop/pattern
          popovers, in read-only mode (the detector authored these values; the
          user can play through the section but can't edit it here). */}
      {algoPopover.open && (() => {
        const overlay = algoOverlays.find((o) => o.id === algoPopover.open!.layerId);
        if (!overlay) return null;
        const idx = Number(algoPopover.open.itemId);
        const section = overlay.sections[idx];
        if (!section) return null;
        const isInside = playerIsPlaying && currentTime >= section.time && currentTime < section.endTime;
        return (
          <AnnotationPointCard
            kind="span"
            layerName={overlay.label}
            layerColor={overlay.labelColor ?? '#94a3b8'}
            badge="algo"
            start={section.time}
            end={section.endTime}
            endEditable={false}
            label={section.label}
            description=""
            hideDescription
            hideImportance
            hideDelete
            readOnly
            bpm={gridProps?.bpm}
            gridOffset={gridProps?.gridOffset}
            beatsPerBar={gridProps?.beatsPerBar}
            anchors={gridProps?.anchors}
            currentTime={currentTime}
            onChange={() => {}}
            onClose={algoPopover.close}
            onPlay={() => handlePlay(section.time, section.endTime)}
            onStop={handlePause}
            isPlaying={isInside}
            popoverRef={algoPopover.popoverRef}
            positionStyle={algoPopover.positionStyle}
            extras={(section.type || section.color) ? (
              <div className="flex items-center gap-2 text-[10px]">
                {section.type && (
                  <>
                    <span className="text-slate-500 uppercase tracking-wider w-12 shrink-0">Type</span>
                    <span className="px-1.5 py-0.5 rounded bg-slate-800/60 text-slate-200 font-mono">{section.type}</span>
                  </>
                )}
                {section.color && (
                  <span className="ml-auto flex items-center gap-1.5 min-w-0">
                    <span className="inline-block w-3 h-3 rounded-sm border border-white/20 shrink-0" style={{ background: section.color }} />
                    <span className="font-mono text-slate-400 truncate">{section.color}</span>
                  </span>
                )}
              </div>
            ) : undefined}
          />
        );
      })()}
    </div>
  );
}
