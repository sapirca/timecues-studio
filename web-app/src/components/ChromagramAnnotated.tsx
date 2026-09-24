/**
 * ChromagramAnnotated
 *
 * 2D heatmap of pitch-class energy over time (12 rows × frameCount columns).
 * Mirrors CepstrogramAnnotated's two-phase render — Phase 1 builds an ImageData
 * cached against the source chroma reference; Phase 2 redraws overlays per frame.
 *
 * Each column is already per-frame max-normalised in mirAnalysis (column max = 1),
 * so the heatmap maps the raw [0,1] value directly through the colormap — no
 * per-row range estimation needed.
 *
 * Row 0 (bottom) = C, row 11 (top) = B. Matches librosa.display.specshow convention.
 */

import { useCallback, useRef } from 'react';
import { TiledStrip, type TileGeom } from './TiledStrip';
import { drawBeatGrid } from '../utils/gridLineStyle';
import { frameAxis, frameAtColumn, type FrameAxis } from '../utils/frameTime';

export interface Props {
  /** Row-major chroma matrix: length = frameCount × nChroma. Index = frame * nChroma + pc. */
  chroma: Float32Array;
  nChroma: number;
  frameCount: number;
  duration: number;
  /** Framing of the analysis run. Without it the component falls back to the
   *  old even-spread mapping, which is off by -23 ms at the start of the track
   *  drifting to +12 ms at the end — see utils/frameTime. */
  hopSize?: number;
  fftSize?: number;
  sampleRate?: number;
  beatTimes?: number[];
  bpm?: number;
  beatOffset?: number;
  beatsPerBar?: number;
  barGroupSize?: number;
  /** Compound-pulse step: only emit lines every N beats. Ignored when barGroupSize is set. */
  beatGroupSize?: number;
  /** Multiplier on beat-grid line width (1 = default). */
  gridThickness?: number;
  currentTime?: number;
  height?: number;
}

const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// ── Roseus colormap (same as SpectrogramAnnotated / CepstrogramAnnotated) ──────
const CM: [number, number, number, number][] = [
  [0.00,   5,   0,  15],
  [0.20,  60,   0, 100],
  [0.42, 160,   0, 120],
  [0.62, 230,  60,  20],
  [0.82, 255, 165,   0],
  [1.00, 255, 240, 130],
];
function magmaRGB(t: number): [number, number, number] {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < CM.length; i++) {
    const [t0, r0, g0, b0] = CM[i - 1];
    const [t1, r1, g1, b1] = CM[i];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return [Math.round(r0 + f * (r1 - r0)), Math.round(g0 + f * (g1 - g0)), Math.round(b0 + f * (b1 - b0))];
    }
  }
  return [255, 250, 210];
}

function buildChromagramImage(
  chroma: Float32Array, nChroma: number,
  W: number, H: number,
  ctx: CanvasRenderingContext2D,
  axis: FrameAxis, duration: number,
  colOffset = 0, colCount = W,
): ImageData {
  // W is the WHOLE strip's pixel width — the time↔column mapping has to stay
  // global — while the image covers only [colOffset, colOffset + colCount).
  const img = ctx.createImageData(colCount, H);
  for (let col = 0; col < colCount; col++) {
    // Each column is a time; ask the frame axis which frame describes it.
    // Spreading frame indices evenly across W instead skews the picture against
    // the waveform by -23 ms at the start drifting to +12 ms at the end.
    const srcFrame = frameAtColumn(colOffset + col, W, duration, axis);
    const fOff = srcFrame * nChroma;
    for (let row = 0; row < H; row++) {
      // Top row = B (pc 11), bottom = C (pc 0).
      const pc = (nChroma - 1) - Math.floor((row / H) * nChroma);
      const v = chroma[fOff + pc];
      const [r, g, b] = magmaRGB(v);
      const idx = (row * colCount + col) * 4;
      img.data[idx]     = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = 255;
    }
  }
  return img;
}

// ── Overlays ────────────────────────────────────────────────────────────────────
function drawPitchLabels(ctx: CanvasRenderingContext2D, W: number, H: number, nChroma: number, dpr = 1) {
  ctx.font = `${Math.round(9 * dpr)}px ui-monospace,monospace`;
  for (let pc = 0; pc < nChroma; pc++) {
    // Center of the row for this pitch class (top row = B, bottom = C).
    const rowIdx = (nChroma - 1) - pc;
    const row = Math.round((rowIdx + 0.5) / nChroma * H);
    // Subtle accent for naturals (C E F G A B) so the eye can land on a reference quickly.
    const isNatural = !PITCH_CLASS_NAMES[pc].includes('#');
    ctx.fillStyle = isNatural ? 'rgba(229,231,235,0.95)' : 'rgba(156,163,175,0.7)';
    ctx.fillText(PITCH_CLASS_NAMES[pc], W - (28 * dpr), row + (3 * dpr));
  }
}

function drawPlayhead(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, duration: number, dpr = 1) {
  if (t < 0 || !duration) return;
  const x = Math.round((t / duration) * W);
  ctx.save();
  ctx.shadowColor = 'rgba(255,255,255,0.6)';
  ctx.shadowBlur  = 4 * dpr;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth   = 1.5 * dpr;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.moveTo(x - (5 * dpr), 0); ctx.lineTo(x + (5 * dpr), 0); ctx.lineTo(x, 8 * dpr);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

// ── Component ───────────────────────────────────────────────────────────────────
export function ChromagramAnnotated({
  chroma,
  nChroma,
  frameCount,
  duration,
  hopSize,
  fftSize,
  sampleRate,
  beatTimes,
  bpm,
  beatOffset = 0,
  beatsPerBar = 4,
  barGroupSize,
  beatGroupSize,
  gridThickness = 1,
  currentTime = 0,
  height = 80,
}: Props) {
  const frameAxisRef = useRef<FrameAxis>(frameAxis(512, 2048, 44100, frameCount));
  frameAxisRef.current = hopSize && fftSize && sampleRate
    ? frameAxis(hopSize, fftSize, sampleRate, frameCount)
    // No framing supplied: fall back to an axis that reproduces the old
    // even-spread mapping exactly, so nothing shifts unexpectedly.
    : { step: duration / Math.max(1, frameCount), offset: 0, count: frameCount };
  const axis = frameAxisRef.current;

  const hasData = frameCount > 0 && chroma.length > 0;

  // One tile's slice of the chromagram. Identity changes only with the data or
  // the framing, so scrolling and playhead ticks never rebuild it.
  const paint = useCallback((ctx: CanvasRenderingContext2D, tile: TileGeom) => {
    if (!hasData) return;
    const totalPx = Math.max(1, Math.round(tile.totalW * tile.dpr));
    const H = Math.max(1, Math.round(tile.h * tile.dpr));
    const colOffset = Math.round(tile.x0 * tile.dpr);
    const colCount = Math.max(1, Math.round(tile.w * tile.dpr));
    const img = buildChromagramImage(chroma, nChroma, totalPx, H, ctx, axis, duration, colOffset, colCount);
    ctx.putImageData(img, 0, 0);
  }, [chroma, nChroma, duration, axis, hasData]);

  // Grid, pitch labels and playhead, in strip-global coordinates: translate by
  // the tile's own offset and draw as if this canvas were the whole strip.
  const overlay = useCallback((ctx: CanvasRenderingContext2D, tile: TileGeom, focusX: number | null) => {
    const totalPx = Math.max(1, Math.round(tile.totalW * tile.dpr));
    const H = Math.max(1, Math.round(tile.h * tile.dpr));
    ctx.save();
    ctx.translate(-Math.round(tile.x0 * tile.dpr), 0);
    drawPitchLabels(ctx, totalPx, H, nChroma, tile.dpr);
    drawBeatGrid(ctx, {
      W: totalPx, H, dpr: tile.dpr, thickness: gridThickness,
      duration, beatTimes, bpm, beatOffset, beatsPerBar,
      barGroupSize, beatGroupSize,
    });
    // focusX is already the playhead's x on the strip; feeding it as
    // (t=focusX, duration=totalW) reuses drawPlayhead's t/duration*W without
    // making this callback depend on currentTime.
    if (focusX != null) drawPlayhead(ctx, totalPx, H, focusX, tile.totalW, tile.dpr);
    ctx.restore();
  }, [nChroma, gridThickness, duration, beatTimes, bpm, beatOffset, beatsPerBar,
      barGroupSize, beatGroupSize]);

  return (
    <TiledStrip
      height={Math.max(1, Math.round(height))}
      paint={paint}
      overlay={overlay}
      overlayFocus={duration > 0 ? currentTime / duration : null}
      className="rounded bg-gray-900 w-full min-w-0 overflow-hidden"
    >
      {!hasData && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-900/70 rounded text-xs text-gray-400 animate-pulse pointer-events-none">
          Computing chromagram…
        </div>
      )}
    </TiledStrip>
  );
}
