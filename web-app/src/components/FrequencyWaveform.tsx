/**
 * FrequencyWaveform
 *
 * Full-track frequency-coloured waveform canvas (Rekordbox/Serato style).
 * Splits the audio into three bands via BiquadFilterNode inside an OfflineAudioContext:
 *
 *   Low  (< 150 Hz)          → Blue (dark theme) / Purple (light theme)
 *   Mid  (150 Hz – 2500 Hz)  → Orange (dark theme) / Teal (light theme)
 *   High (> 2500 Hz)         → Light-gray (dark theme) / Slate (light theme)
 *
 * Rendering uses a reduced sample-rate offline context (11025 Hz) for speed, then
 * downsamples the output to one peak per canvas pixel column.
 *
 * Features:
 *   - Animated playhead cursor via CSS overlay (no canvas redraw on every tick)
 *   - Click-to-seek: clicking the canvas calls onSeek with the track position
 *
 * The TimeRuler and transport controls are intentionally left to the parent so that
 * this component can be embedded in an aligned multi-row layout without adding
 * its own offsets.
 */

import { useEffect, useRef, useCallback, useMemo, useState, forwardRef, useImperativeHandle } from 'react';
import { visibleGridLines, snapTimeToGrid } from '../utils/beatGrid';
import { getBandColors } from '../utils/bandPalettes';
import { useSettings } from '../context/SettingsContext';

// ─── Constants ──────────────────────────────────────────────────────────────

const CANVAS_HEIGHT = 70;          // px
const RENDER_SAMPLE_RATE = 11025;  // Hz — Nyquist 5512 > 2500 Hz HP crossover
// Clamp the canvas internal buffer so it stays under the browser's max-canvas
// size at Ultra zoom (Chrome caps at ~32 767 px; Firefox/Safari lower — 32 000
// is safe across browsers). Past this, CSS stretches a smaller buffer to the
// full row width — the bands appear softer rather than the canvas dropping to
// a broken-image placeholder.
const MAX_BUFFER_PX = 32_000;

function isLightTheme(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'light';
}

// Small in-canvas activity badge shown while the buffer is being soft-clamped
// at Ultra zoom. Replaces the browser's broken-image placeholder that used to
// surface when canvas dimensions exceeded the max-canvas size.
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

// ─── Audio helpers ───────────────────────────────────────────────────────────

async function renderBand(
  source: AudioBuffer,
  filterChain: Array<{ type: BiquadFilterType; frequency: number; Q?: number }>,
): Promise<Float32Array> {
  const numFrames = Math.ceil(source.duration * RENDER_SAMPLE_RATE);
  const offlineCtx = new OfflineAudioContext(1, numFrames, RENDER_SAMPLE_RATE);
  const srcNode = offlineCtx.createBufferSource();
  srcNode.buffer = source;

  let lastNode: AudioNode = srcNode;
  for (const { type, frequency, Q = 0.5 } of filterChain) {
    const f = offlineCtx.createBiquadFilter();
    f.type = type;
    f.frequency.value = frequency;
    f.Q.value = Q;
    lastNode.connect(f);
    lastNode = f;
  }

  lastNode.connect(offlineCtx.destination);
  srcNode.start(0);
  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}

function buildPeaks(pcm: Float32Array, numCols: number): Float32Array {
  const step = pcm.length / numCols;
  const peaks = new Float32Array(numCols);
  for (let col = 0; col < numCols; col++) {
    const start = Math.floor(col * step);
    const end   = Math.min(Math.floor((col + 1) * step), pcm.length);
    let peak = 0;
    for (let i = start; i < end; i++) {
      const a = Math.abs(pcm[i]);
      if (a > peak) peak = a;
    }
    peaks[col] = peak;
  }
  return peaks;
}

function drawBand(
  ctx: CanvasRenderingContext2D,
  peaks: Float32Array,
  color: string,
  scale: number,
  h: number,
): void {
  const cy = h / 2;
  const n  = peaks.length;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, cy);
  for (let x = 0; x < n; x++) ctx.lineTo(x, cy - peaks[x] * scale * cy);
  for (let x = n - 1; x >= 0; x--) ctx.lineTo(x, cy + peaks[x] * scale * cy);
  ctx.closePath();
  ctx.fill();
}

// ─── Component ───────────────────────────────────────────────────────────────

export interface FrequencyWaveformHandle {
  /** Returns the canvas as a PNG data URL, or null if not yet rendered */
  getCanvasDataURL: () => string | null;
}

export interface FrequencyWaveformProps {
  audioBuffer: AudioBuffer | null;
  /** Current playback position in seconds (drives the playhead cursor) */
  currentTime?: number;
  /** Track duration in seconds (falls back to audioBuffer.duration) */
  duration?: number;
  /** Called when the user clicks (no drag) — seek only */
  onSeek?: (time: number) => void;
  /** Called when the user drags a region — start and end in seconds */
  onRegion?: (start: number, end: number) => void;
  /** Called once on mousedown when a region drag begins (used by parents to
   *  dismiss a stale committed pending highlight so it doesn't render alongside
   *  the live drag rectangle). */
  onRegionDragStart?: () => void;
  /** Beat grid — BPM; omit or leave undefined to hide the grid */
  bpm?: number;
  beatOffset?: number;
  beatsPerBar?: number;
  /** Optional tempo anchors (Dynamic / Manual modes). When provided, snap
   *  uses the per-segment tempo. */
  anchors?: readonly import('../types/songInfo').TempoAnchor[];
  /** Optional per-beat overrides (Manual mode). When a snap target has a
   *  pinned position, snap returns the pinned time. */
  beatOverrides?: Readonly<Record<string, number>>;
  barGroupSize?: number;
  /** Subdivide each beat (2 = 1/2, 3 = triplet, 4 = 1/4, 6 = 16th triplet, 8 = 1/8). Ignored when barGroupSize is set. */
  subBeatDivision?: number;
  /** Compound-pulse step: only emit lines every N beats. Ignored when barGroupSize or subBeatDivision (>1) is set. */
  beatGroupSize?: number;
  /** Multiplier on beat-grid line width (1 = default). */
  gridThickness?: number;
  /** Called while the user holds Alt and drags horizontally to slide the grid. */
  onGridOffsetChange?: (newOffset: number) => void;
  /** Called once when an Alt-drag begins (so the parent can snapshot the previous offset for undo). */
  onGridOffsetDragStart?: (currentOffset: number) => void;
  /** When true (and bpm is set), snap the drag-selection highlight and emitted region to the beat grid. */
  snapToGrid?: boolean;
}

export const FrequencyWaveform = forwardRef<FrequencyWaveformHandle, FrequencyWaveformProps>(function FrequencyWaveform({
  audioBuffer,
  currentTime = 0,
  duration,
  onSeek,
  onRegion,
  onRegionDragStart,
  bpm,
  beatOffset = 0,
  beatsPerBar = 4,
  barGroupSize,
  subBeatDivision,
  beatGroupSize,
  gridThickness = 1,
  anchors,
  beatOverrides,
  onGridOffsetChange,
  onGridOffsetDragStart,
  snapToGrid = false,
}, ref) {
  const { settings } = useSettings();
  const bandPalette = settings.bandPalette;

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const cursorRef    = useRef<HTMLDivElement>(null);

  // Drag-selection state
  const [selection, setSelection] = useState<{ s: number; e: number } | null>(null);
  const dragRef = useRef<{ time: number; x: number } | null>(null);

  // Alt-drag-to-slide-grid state. Separate from selection drag because the modifier
  // changes the meaning of the gesture.
  const gridDragRef = useRef<{ startTime: number; startOffset: number } | null>(null);
  const [gridDragging, setGridDragging] = useState(false);

  const peaksRef     = useRef<{ low: Float32Array; mid: Float32Array; high: Float32Array } | null>(null);
  const renderingRef = useRef(false);
  const pendingRef   = useRef<AudioBuffer | null>(null);

  // Surfaces the buffer-clamp spinner. True while the canvas is being repainted
  // at a zoom level past the safe-buffer cap. Auto-clears ~250 ms after the
  // last paint completes so it never sticks during idle.
  const [softening, setSoftening] = useState(false);
  const softenTimerRef = useRef<number | null>(null);

  useImperativeHandle(ref, () => ({
    getCanvasDataURL: () => canvasRef.current?.toDataURL('image/png') ?? null,
  }));

  const effectiveDuration = duration ?? audioBuffer?.duration ?? 0;

  const beatLines = useMemo(() => {
    if (!bpm || effectiveDuration <= 0) return [];
    return visibleGridLines({
      bpm,
      gridOffset: beatOffset,
      beatsPerBar,
      startTime: 0,
      endTime: effectiveDuration,
      barGroupSize: barGroupSize ?? null,
      subBeatDivision,
      beatGroupSize,
    });
  }, [bpm, beatOffset, beatsPerBar, barGroupSize, subBeatDivision, beatGroupSize, effectiveDuration]);

  // ── Cursor: direct DOM mutation — no React re-render on every tick ─────────
  useEffect(() => {
    const cursor = cursorRef.current;
    if (!cursor || effectiveDuration <= 0) return;
    const pct = Math.min(100, Math.max(0, (currentTime / effectiveDuration) * 100));
    cursor.style.left = `${pct}%`;
  }, [currentTime, effectiveDuration]);

  // ── Paint cached peaks onto canvas ────────────────────────────────────────
  const paintPeaks = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !peaksRef.current) return;

    const cssW = container.clientWidth || 800;
    // Soft-clamp the internal buffer: at Ultra zoom the CSS width can exceed
    // the browser's max-canvas limit, which makes the element render as a
    // broken-image placeholder. Keeping the buffer ≤ MAX_BUFFER_PX while
    // leaving CSS width unbounded lets the browser stretch the smaller buffer
    // over the full row — softer texture, but always painted.
    const bufW = Math.min(cssW, MAX_BUFFER_PX);
    canvas.width  = bufW;
    canvas.height = CANVAS_HEIGHT;
    // CSS width stays driven by Tailwind's `w-full` on the <canvas>, so the
    // browser stretches the (possibly smaller) buffer to fill the row.

    const { low, mid, high } = peaksRef.current;
    const numCols = bufW;

    const lowP  = buildPeaks(low,  numCols);
    const midP  = buildPeaks(mid,  numCols);
    const highP = buildPeaks(high, numCols);

    let lowMax = 0, midMax = 0, highMax = 0;
    for (let i = 0; i < numCols; i++) {
      if (lowP[i]  > lowMax)  lowMax  = lowP[i];
      if (midP[i]  > midMax)  midMax  = midP[i];
      if (highP[i] > highMax) highMax = highP[i];
    }
    const lowScale  = lowMax  > 0 ? 1 / lowMax  : 1;
    const midScale  = midMax  > 0 ? 1 / midMax  : 1;
    const highScale = highMax > 0 ? 1 / highMax : 1;

    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;

    ctx2d.clearRect(0, 0, bufW, CANVAS_HEIGHT);
    ctx2d.globalCompositeOperation = 'source-over';
    const colors = getBandColors(bandPalette, isLightTheme() ? 'light' : 'dark');
    drawBand(ctx2d, lowP,  colors.low,  lowScale,  CANVAS_HEIGHT);
    drawBand(ctx2d, midP,  colors.mid,  midScale,  CANVAS_HEIGHT);
    drawBand(ctx2d, highP, colors.high, highScale, CANVAS_HEIGHT);

    // Spinner only spins when the buffer was actually clamped. Steady-state
    // zoom levels don't trigger it; Ultra-zoom repaints flash it for ~250 ms.
    if (bufW < cssW) {
      setSoftening(true);
      if (softenTimerRef.current != null) window.clearTimeout(softenTimerRef.current);
      softenTimerRef.current = window.setTimeout(() => setSoftening(false), 250);
    } else if (softening) {
      setSoftening(false);
    }
  }, [bandPalette, softening]);

  useEffect(() => () => {
    if (softenTimerRef.current != null) window.clearTimeout(softenTimerRef.current);
  }, []);

  // ── Process a new AudioBuffer ──────────────────────────────────────────────
  const processBuffer = useCallback(async (buf: AudioBuffer) => {
    if (renderingRef.current) { pendingRef.current = buf; return; }
    renderingRef.current = true;
    pendingRef.current = null;
    try {
      const [lowData, midData, highData] = await Promise.all([
        renderBand(buf, [{ type: 'lowpass',  frequency: 150 }]),
        renderBand(buf, [{ type: 'highpass', frequency: 150 }, { type: 'lowpass', frequency: 2500 }]),
        renderBand(buf, [{ type: 'highpass', frequency: 2500 }]),
      ]);
      peaksRef.current = { low: lowData, mid: midData, high: highData };
      paintPeaks();
    } finally {
      renderingRef.current = false;
      if (pendingRef.current) {
        const next = pendingRef.current;
        pendingRef.current = null;
        processBuffer(next);
      }
    }
  }, [paintPeaks]);

  useEffect(() => {
    if (!audioBuffer) {
      peaksRef.current = null;
      const canvas = canvasRef.current;
      if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    processBuffer(audioBuffer);
  }, [audioBuffer, processBuffer]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => paintPeaks());
    ro.observe(container);
    return () => ro.disconnect();
  }, [paintPeaks]);

  // Repaint when the user flips theme — all three band colors swap so peaks
  // stay readable on both dark and light canvases.
  useEffect(() => {
    const obs = new MutationObserver(() => paintPeaks());
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, [paintPeaks]);

  // Repaint when the palette setting changes.
  useEffect(() => {
    paintPeaks();
  }, [bandPalette, paintPeaks]);

  const timeAt = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(effectiveDuration, ((e.clientX - rect.left) / rect.width) * effectiveDuration));
  }, [effectiveDuration]);

  // Snap to the nearest beat when snap-to-grid is on and a valid BPM is known.
  // Raw time falls through otherwise — keeps click-to-seek pixel-precise.
  const snap = useCallback((t: number) => {
    if (!snapToGrid || !bpm || bpm <= 0) return t;
    return snapTimeToGrid(t, bpm, beatOffset, beatsPerBar, 'beat', anchors, beatOverrides);
  }, [snapToGrid, bpm, beatOffset, beatsPerBar, anchors, beatOverrides]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (effectiveDuration <= 0) return;
    const t = timeAt(e);
    if (e.altKey && onGridOffsetChange) {
      gridDragRef.current = { startTime: t, startOffset: beatOffset };
      setGridDragging(true);
      onGridOffsetDragStart?.(beatOffset);
      e.preventDefault();
      return;
    }
    dragRef.current = { time: t, x: e.clientX };
    // A plain click should only seek — defer the teal selection box until the
    // drag passes the same 6px threshold the commit uses below.
    onRegionDragStart?.();
    e.preventDefault();
  }, [effectiveDuration, timeAt, beatOffset, onGridOffsetChange, onGridOffsetDragStart, onRegionDragStart, snap]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (gridDragRef.current && onGridOffsetChange) {
      const dt = timeAt(e) - gridDragRef.current.startTime;
      const next = gridDragRef.current.startOffset + dt;
      onGridOffsetChange(Math.max(0, next));
      return;
    }
    if (!dragRef.current || effectiveDuration <= 0) return;
    if (Math.abs(e.clientX - dragRef.current.x) > 6) {
      setSelection({ s: snap(dragRef.current.time), e: snap(timeAt(e)) });
    } else {
      setSelection(null);
    }
  }, [effectiveDuration, timeAt, onGridOffsetChange, snap]);

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (gridDragRef.current) {
      gridDragRef.current = null;
      setGridDragging(false);
      return;
    }
    const drag = dragRef.current;
    if (!drag || effectiveDuration <= 0) { dragRef.current = null; setSelection(null); return; }
    const endT = timeAt(e);
    const dragPx = Math.abs(e.clientX - drag.x);
    const rawT1 = Math.min(drag.time, endT);
    const rawT2 = Math.max(drag.time, endT);
    const t1 = snap(rawT1);
    const t2 = snap(rawT2);
    if (onRegion && dragPx > 6 && t2 - t1 > 0.1) {
      onRegion(t1, t2);
    } else {
      onSeek?.(drag.time);
    }
    dragRef.current = null;
    setSelection(null);
  }, [effectiveDuration, timeAt, onRegion, onSeek, snap]);

  const handleMouseLeave = useCallback(() => {
    dragRef.current = null;
    gridDragRef.current = null;
    setGridDragging(false);
    setSelection(null);
  }, []);

  const interactive = !!(onSeek || onRegion || onGridOffsetChange);
  const cursor = interactive
    ? (gridDragging ? 'ew-resize' : 'crosshair')
    : undefined;

  return (
    <div
      ref={containerRef}
      className="relative w-full rounded overflow-hidden bg-gray-900/60"
      title={onGridOffsetChange ? 'Alt-drag to slide the beat grid' : undefined}
      style={{ cursor, height: CANVAS_HEIGHT }}
      onMouseDown={interactive ? handleMouseDown : undefined}
      onMouseMove={interactive ? handleMouseMove : undefined}
      onMouseUp={interactive ? handleMouseUp : undefined}
      onMouseLeave={interactive ? handleMouseLeave : undefined}
    >
      {/* Frequency bands canvas */}
      {!audioBuffer && (
        <div className="absolute inset-0 flex items-center justify-center text-[10px] text-gray-600 italic pointer-events-none">
          waveform loads with audio
        </div>
      )}
      <canvas
        ref={canvasRef}
        height={CANVAS_HEIGHT}
        className="w-full block"
        style={{ display: audioBuffer ? 'block' : 'none', height: `${CANVAS_HEIGHT}px` }}
      />

      {/* Soft-clamp spinner: shown briefly during Ultra-zoom repaints, while
          the internal buffer is being scaled to stay under the browser's max. */}
      {softening && (
        <div className="absolute top-1 left-1 z-30 pointer-events-none">
          <SoftClampSpinner />
        </div>
      )}

      {/* Drag selection highlight */}
      {selection && effectiveDuration > 0 && (
        <div
          className="absolute top-0 bottom-0 pointer-events-none z-20"
          style={{
            left:       `${(Math.min(selection.s, selection.e) / effectiveDuration) * 100}%`,
            width:      `${(Math.abs(selection.e - selection.s) / effectiveDuration) * 100}%`,
            minWidth:   1,
            background: 'rgba(45,212,191,0.18)',
            borderLeft: '2px solid rgba(45,212,191,0.85)',
            borderRight: Math.abs(selection.e - selection.s) > 0.1
              ? '2px solid rgba(45,212,191,0.85)'
              : 'none',
          }}
        />
      )}

      {/* Beat / bar grid overlay */}
      {beatLines.map((line, i) => (
        <div
          key={i}
          className="absolute top-0 bottom-0 pointer-events-none z-10"
          style={{
            left: `${(line.t / effectiveDuration) * 100}%`,
            width: (line.isBar ? 1 : 0.5) * gridThickness,
            background: line.isPhrase
              ? 'rgba(251,191,36,0.70)'
              : line.isBar
                ? 'rgba(239,68,68,0.70)'
                : line.isSubBeat
                  ? 'rgba(255,255,255,0.08)'
                  : 'rgba(255,255,255,0.18)',
          }}
        />
      ))}

      {/* Playhead cursor */}
      {audioBuffer && effectiveDuration > 0 && (
        <div
          ref={cursorRef}
          className="absolute top-0 bottom-0 pointer-events-none"
          style={{ left: '0%', width: 0 }}
        >
          {/* Triangle cap */}
          <div
            className="absolute"
            style={{
              top: 0, left: '-5px',
              width: 0, height: 0,
              borderLeft: '5px solid transparent',
              borderRight: '5px solid transparent',
              borderTop: '8px solid rgba(255,255,255,0.95)',
            }}
          />
          {/* Vertical line */}
          <div
            className="absolute top-0 bottom-0"
            style={{
              left: 0, width: '1.5px', marginLeft: '-0.75px',
              background: 'rgba(255,255,255,0.90)',
              boxShadow: '0 0 4px rgba(255,255,255,0.55)',
            }}
          />
        </div>
      )}
    </div>
  );
});
