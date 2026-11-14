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
import type { ResolvedSegment } from '../utils/gridSegments';
import { TiledStrip, type TileGeom } from './TiledStrip';
import { GridLines } from './GridLines';
import { getBandColors } from '../utils/bandPalettes';
import { getBandPeaks } from '../utils/bandPeaks';
import { useSettings } from '../context/SettingsContext';
import { useRegionSelectDrag, preventPressDefault } from '../hooks/useTimelineDrag';
import { usePlayheadTransform } from '../hooks/usePlayhead';

// ─── Constants ──────────────────────────────────────────────────────────────

const CANVAS_HEIGHT = 70;          // px

function isLightTheme(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'light';
}

// ─── Audio helpers ───────────────────────────────────────────────────────────

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
  /** Optional per-beat overrides (Manual mode). When a snap target has a
   *  pinned position, snap returns the pinned time. */
  beatOverrides?: Readonly<Record<string, number>>;
  /** Resolved grid segments (Mapped mode, and Hand-placed riding a Mapped
   *  base). Every other surface draws and snaps against these; this row has
   *  to receive them too, or on a split song it paints a different grid from
   *  the one beside it and snaps region edges to lines it never drew. */
  segments?: readonly ResolvedSegment[];
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
  /** Replaces the built-in whole-beat snap entirely, `snapToGrid` included.
   *  Set while the Lyrics editor is open, to the identity: a sung word is
   *  timed to the voice and is never snapped. Returning `t` unchanged means
   *  "don't snap". */
  snapTimeOverride?: (t: number) => number;
  /** Strip height in px. The row sheet's S/M/L/XL sizes scale it. */
  height?: number;
}

export const FrequencyWaveform = forwardRef<FrequencyWaveformHandle, FrequencyWaveformProps>(function FrequencyWaveform({
  audioBuffer,
  duration,
  onSeek,
  onRegion,
  onRegionDragStart,
  snapTimeOverride,
  height = CANVAS_HEIGHT,
  bpm,
  beatOffset = 0,
  beatsPerBar = 4,
  barGroupSize,
  subBeatDivision,
  beatGroupSize,
  gridThickness = 1,
  beatOverrides,
  segments,
  onGridOffsetChange,
  onGridOffsetDragStart,
  snapToGrid = false,
}, ref) {
  const { settings } = useSettings();
  const bandPalette = settings.bandPalette;

  const containerRef = useRef<HTMLDivElement>(null);

  // Drag-selection lives in useRegionSelectDrag (document-level tracking, so
  // the gesture survives leaving the canvas) — see the hook wiring below.

  // Alt-drag-to-slide-grid state. Separate from selection drag because the modifier
  // changes the meaning of the gesture.
  const gridDragRef = useRef<{ startTime: number; startOffset: number } | null>(null);
  const [gridDragging, setGridDragging] = useState(false);

  const peaksRef     = useRef<{ low: Float32Array; mid: Float32Array; high: Float32Array } | null>(null);
  const renderingRef = useRef(false);
  const pendingRef   = useRef<AudioBuffer | null>(null);

  // Whole-track peak maxima, so every tile scales its bands identically.
  const scalesRef = useRef<{ low: number; mid: number; high: number } | null>(null);

  useImperativeHandle(ref, () => ({
    // The bands are a strip of tiles; composite what is mounted into one image.
    getCanvasDataURL: () => {
      const host = containerRef.current;
      if (!host) return null;
      const tiles = [...host.querySelectorAll('canvas')];
      if (tiles.length === 0) return null;
      const w = Math.max(...tiles.map((c) => c.offsetLeft + c.width));
      const h = Math.max(...tiles.map((c) => c.height));
      if (w <= 0 || h <= 0 || w > 16_384) return tiles[0].toDataURL('image/png');
      const out = document.createElement('canvas');
      out.width = w; out.height = h;
      const octx = out.getContext('2d');
      if (!octx) return null;
      for (const c of tiles) octx.drawImage(c, c.offsetLeft * (c.width / Math.max(1, c.offsetWidth)), 0);
      return out.toDataURL('image/png');
    },
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
      beatOverrides,
      segments,
    });
  }, [bpm, beatOffset, beatsPerBar, barGroupSize, subBeatDivision, beatGroupSize, effectiveDuration, beatOverrides, segments]);

  // ── Cursor: a transform written from the clock — no re-render, no layout ──
  // Driven by the playhead clock, the same one every lane-row cursor follows,
  // so they all move in the same callback and show one time. (A passive
  // effect keyed on a time prop once left this cursor 22 px behind the others
  // at ×128 — it ran a frame after the commit that scheduled it.) Re-run when
  // the buffer lands, since that is what mounts the cursor.
  const cursorRef = usePlayheadTransform<HTMLDivElement>(effectiveDuration, [audioBuffer]);

  // ── Paint one tile's slice of the bands ───────────────────────────────────
  // Bumped when a new set of peaks lands, so the tiles repaint (peaksRef is a
  // ref — the tiles cannot see it change on their own).
  const [peaksVersion, setPeaksVersion] = useState(0);
  const [themeVersion, setThemeVersion] = useState(0);

  const paint = useCallback((ctx: CanvasRenderingContext2D, tile: TileGeom) => {
    // The peaks and the theme are read at draw time rather than closed over,
    // so these two counters are what gives this callback a new identity when
    // either changes — that is what makes the mounted tiles repaint.
    void peaksVersion; void themeVersion;
    const peaks = peaksRef.current;
    if (!peaks) return;
    const totalPx = Math.max(1, Math.round(tile.totalW * tile.dpr));
    const H = Math.max(1, Math.round(tile.h * tile.dpr));
    const colOffset = Math.round(tile.x0 * tile.dpr);
    const colCount = Math.max(1, Math.round(tile.w * tile.dpr));

    // Max-reduce the stored peaks over each of this tile's columns. Once the
    // column is narrower than one stored peak this stops gaining detail —
    // that's the 0.5 ms floor, and it is the only floor left.
    // One column of overdraw on each side: a filled band is antialiased where
    // it meets the edge of its canvas, so without it every tile boundary shows
    // a faint darker line down the row. The extra columns are drawn just off
    // the tile and clipped away.
    const OVER = 1;
    const slice = (src: Float32Array): Float32Array => {
      const out = new Float32Array(colCount + 2 * OVER);
      const step = src.length / totalPx;
      for (let c = 0; c < out.length; c++) {
        const g = colOffset - OVER + c;
        const a = Math.max(0, Math.min(src.length - 1, Math.floor(g * step)));
        const b = Math.max(a + 1, Math.min(src.length, Math.floor((g + 1) * step)));
        let m = 0;
        for (let i = a; i < b; i++) { const v = src[i]; if (v > m) m = v; }
        out[c] = m;
      }
      return out;
    };

    // Band scaling is global (computed once with the peaks), not per tile —
    // scaling each tile to its own loudest moment would step the levels at
    // every seam.
    const scales = scalesRef.current ?? { low: 1, mid: 1, high: 1 };
    const colors = getBandColors(bandPalette, isLightTheme() ? 'light' : 'dark');
    ctx.clearRect(0, 0, colCount, H);
    ctx.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.translate(-OVER, 0);
    drawBand(ctx, slice(peaks.low), colors.low, scales.low, H);
    drawBand(ctx, slice(peaks.mid), colors.mid, scales.mid, H);
    drawBand(ctx, slice(peaks.high), colors.high, scales.high, H);
    ctx.restore();
  }, [bandPalette, peaksVersion, themeVersion]);

  // ── Process a new AudioBuffer ──────────────────────────────────────────────
  const processBuffer = useCallback(async (buf: AudioBuffer) => {
    if (renderingRef.current) { pendingRef.current = buf; return; }
    renderingRef.current = true;
    pendingRef.current = null;
    try {
      // Shared with the overview strip (utils/bandPeaks): one render per song.
      const { low, mid, high, scales } = await getBandPeaks(buf);
      peaksRef.current = { low, mid, high };
      scalesRef.current = scales;
      setPeaksVersion((v) => v + 1);
    } finally {
      renderingRef.current = false;
      if (pendingRef.current) {
        const next = pendingRef.current;
        pendingRef.current = null;
        processBuffer(next);
      }
    }
  }, []);

  useEffect(() => {
    if (!audioBuffer) {
      // No bump needed: the row is display:none without a buffer, and the next
      // buffer's peaks bump it anyway.
      peaksRef.current = null;
      scalesRef.current = null;
      return;
    }
    processBuffer(audioBuffer);
  }, [audioBuffer, processBuffer]);

  // Resize and palette changes reach the tiles on their own — the strip
  // re-measures itself, and `paint`'s identity carries the palette. Theme is
  // the one input read at draw time rather than closed over, so it needs a
  // version bump of its own: all three band colors swap so peaks stay
  // readable on both dark and light canvases.
  useEffect(() => {
    const obs = new MutationObserver(() => setThemeVersion((v) => v + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  const timeAt = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(effectiveDuration, ((e.clientX - rect.left) / rect.width) * effectiveDuration));
  }, [effectiveDuration]);

  // Snap to the nearest beat when snap-to-grid is on and a valid BPM is known.
  // Raw time falls through otherwise — keeps click-to-seek pixel-precise.
  // An override wins outright: it already encodes both whether to snap and how
  // finely, so consulting `snapToGrid` on top of it would re-impose the global
  // switch on a layer that opted out of it.
  const snap = useCallback((t: number) => {
    if (snapTimeOverride) return snapTimeOverride(t);
    if (!snapToGrid || !bpm || bpm <= 0) return t;
    return snapTimeToGrid(t, bpm, beatOffset, beatsPerBar, 'beat', beatOverrides, undefined, segments);
  }, [snapTimeOverride, snapToGrid, bpm, beatOffset, beatsPerBar, beatOverrides, segments]);

  const regionDrag = useRegionSelectDrag({
    containerRef,
    durationGetter: () => effectiveDuration,
    transform: snap,
    onDragStart: onRegionDragStart,
    onClick: (t) => onSeek?.(t),
    onRegion: (t1, t2) => onRegion?.(t1, t2),
  });
  const selection = regionDrag.preview;

  // Pointer events throughout, so a finger can paint a selection on the
  // waveform (the region drag) as well as a mouse; the grid slide needs Alt,
  // so it stays a keyboard-and-mouse gesture in practice.
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (effectiveDuration <= 0 || e.isPrimary === false) return;
    // Alt-drag slides the beat grid instead of selecting — the modifier
    // changes the meaning of the gesture, so it branches before the region
    // drag ever starts.
    if (e.altKey && onGridOffsetChange) {
      gridDragRef.current = { startTime: timeAt(e), startOffset: beatOffset };
      setGridDragging(true);
      onGridOffsetDragStart?.(beatOffset);
      preventPressDefault(e);
      return;
    }
    regionDrag.onPointerDown(e);
  }, [effectiveDuration, timeAt, beatOffset, onGridOffsetChange, onGridOffsetDragStart, regionDrag]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!gridDragRef.current || !onGridOffsetChange || e.isPrimary === false) return;
    const dt = timeAt(e) - gridDragRef.current.startTime;
    onGridOffsetChange(Math.max(0, gridDragRef.current.startOffset + dt));
  }, [timeAt, onGridOffsetChange]);

  const handlePointerUp = useCallback(() => {
    if (!gridDragRef.current) return;
    gridDragRef.current = null;
    setGridDragging(false);
  }, []);

  const handlePointerLeave = useCallback(() => {
    // Only the grid-slide gesture is bound to this element; the region drag
    // tracks on the document and deliberately keeps going off-canvas. Also
    // wired to pointercancel, which ends a grid slide the same way.
    gridDragRef.current = null;
    setGridDragging(false);
  }, []);

  const interactive = !!(onSeek || onRegion || onGridOffsetChange);
  const cursor = interactive
    ? (gridDragging ? 'ew-resize' : 'crosshair')
    : undefined;

  return (
    <div
      ref={containerRef}
      // touch-pan-y on an interactive waveform: a vertical swipe still
      // scrolls the page on a phone, a horizontal one paints a selection.
      className={`relative w-full rounded overflow-hidden bg-gray-900/60 ${interactive ? 'touch-pan-y' : ''}`}
      title={onGridOffsetChange ? 'Alt-drag to slide the beat grid' : undefined}
      style={{ cursor, height }}
      onPointerDown={interactive ? handlePointerDown : undefined}
      onPointerMove={interactive ? handlePointerMove : undefined}
      onPointerUp={interactive ? handlePointerUp : undefined}
      onPointerLeave={interactive ? handlePointerLeave : undefined}
      onPointerCancel={interactive ? handlePointerLeave : undefined}
    >
      {/* Frequency bands canvas */}
      {!audioBuffer && (
        <div className="absolute inset-0 flex items-center justify-center text-[10px] text-gray-600 italic pointer-events-none">
          waveform loads with audio
        </div>
      )}
      <div style={{ display: audioBuffer ? 'block' : 'none' }}>
        <TiledStrip height={height} paint={paint} />
      </div>

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
      <div className="absolute inset-0 pointer-events-none overflow-hidden z-10">
        <GridLines lines={beatLines} duration={effectiveDuration} thickness={gridThickness} />
      </div>

      {/* Playhead cursor */}
      {audioBuffer && effectiveDuration > 0 && (
        <div
          ref={cursorRef}
          className="absolute top-0 bottom-0 pointer-events-none"
          style={{ width: 0 }}
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
