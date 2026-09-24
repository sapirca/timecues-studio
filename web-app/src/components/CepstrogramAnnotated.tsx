/**
 * CepstrogramAnnotated
 *
 * 2D heatmap of MFCC coefficients over time (nMfcc rows × frameCount columns).
 * Mirrors SpectrogramAnnotated's two-phase render — Phase 1 builds an ImageData
 * cached against the source mfcc reference; Phase 2 redraws overlays per frame.
 *
 * Coefficient 0 (overall energy / DC) is dropped because it dominates the colour
 * range and obscures the modulation pattern in the higher-order coefficients.
 *
 * Each coefficient row is normalised independently so that modulation across
 * the track is visible regardless of absolute MFCC magnitude.
 */

import { useCallback, useMemo, useRef } from 'react';
import { TiledStrip, type TileGeom } from './TiledStrip';
import { drawBeatGrid } from '../utils/gridLineStyle';
import { frameAxis, frameAtColumn, type FrameAxis } from '../utils/frameTime';

export interface Props {
  /** Row-major MFCC matrix: length = frameCount × nMfcc. Index = frame * nMfcc + coef. */
  mfcc: Float32Array;
  nMfcc: number;
  frameCount: number;
  duration: number;
  /** Framing of the analysis run — see utils/frameTime. Without it the
   *  component keeps the old even-spread mapping. */
  hopSize?: number;
  fftSize?: number;
  sampleRate?: number;
  beatTimes?: number[];
  bpm?: number;
  beatOffset?: number;
  beatsPerBar?: number;
  barGroupSize?: number;
  /** Subdivide each beat (2 = 1/2, 3 = triplet, 4 = 1/4, 6 = 16th triplet, 8 = 1/8). Ignored when barGroupSize is set. */
  subBeatDivision?: number;
  /** Compound-pulse step: only emit lines every N beats. Ignored when barGroupSize or subBeatDivision (>1) is set. */
  beatGroupSize?: number;
  /** Multiplier on beat-grid line width (1 = default). */
  gridThickness?: number;
  currentTime?: number;
  height?: number;
}

// ── Roseus colormap (same as SpectrogramAnnotated) ──────────────────────────────
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

// ── Per-coefficient min/max (skip coef 0) for independent row normalisation ───
function computeCoefRanges(mfcc: Float32Array, nMfcc: number, frameCount: number): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(nMfcc);
  const max = new Float32Array(nMfcc);
  for (let k = 0; k < nMfcc; k++) { min[k] = Infinity; max[k] = -Infinity; }
  for (let t = 0; t < frameCount; t++) {
    const off = t * nMfcc;
    for (let k = 0; k < nMfcc; k++) {
      const v = mfcc[off + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

function buildCepstrogramImage(
  mfcc: Float32Array, nMfcc: number,
  W: number, H: number,
  coefMin: Float32Array, coefMax: Float32Array,
  ctx: CanvasRenderingContext2D,
  axis: FrameAxis, duration: number,
  colOffset = 0, colCount = W,
): ImageData {
  // Drop coef 0 — visible coefficients are 1..nMfcc-1.
  const visCoef = nMfcc - 1;
  // W stays the WHOLE strip's width so the time↔column mapping is global; the
  // image covers only [colOffset, colOffset + colCount).
  const img = ctx.createImageData(colCount, H);
  for (let col = 0; col < colCount; col++) {
    // Column time -> the frame whose analysis window is centred there.
    const srcFrame = frameAtColumn(colOffset + col, W, duration, axis);
    const fOff = srcFrame * nMfcc;
    for (let row = 0; row < H; row++) {
      // Top row = highest coefficient (matches librosa specshow convention).
      const coefIdx = (visCoef - 1) - Math.floor((row / H) * visCoef) + 1; // 1..nMfcc-1
      const v   = mfcc[fOff + coefIdx];
      const lo  = coefMin[coefIdx];
      const hi  = coefMax[coefIdx];
      const t   = hi > lo ? (v - lo) / (hi - lo) : 0.5;
      const [r, g, b] = magmaRGB(t);
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
function drawCoefLabels(ctx: CanvasRenderingContext2D, W: number, H: number, visCoef: number, dpr = 1) {
  ctx.font = `${Math.round(9 * dpr)}px ui-monospace,monospace`;
  // Label every other coefficient to avoid clutter on short canvases.
  const step = visCoef > 8 ? 2 : 1;
  for (let i = 1; i <= visCoef; i++) {
    if ((visCoef - i) % step !== 0) continue;
    const row = Math.round(((visCoef - i) / (visCoef - 1)) * (H - 1));
    if (row < 2 || row > H - 2) continue;
    ctx.fillStyle = 'rgba(156,163,175,0.85)';
    ctx.fillText(`c${i}`, W - (24 * dpr), row + (3 * dpr));
    ctx.strokeStyle = 'rgba(156,163,175,0.08)';
    ctx.lineWidth = 0.5 * dpr;
    ctx.beginPath(); ctx.moveTo(0, row); ctx.lineTo(W - (28 * dpr), row); ctx.stroke();
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
export function CepstrogramAnnotated({
  mfcc,
  nMfcc,
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
  subBeatDivision,
  beatGroupSize,
  gridThickness = 1,
  currentTime = 0,
  height = 80,
}: Props) {
  const frameAxisRef = useRef<FrameAxis>(frameAxis(512, 2048, 44100, frameCount));
  frameAxisRef.current = hopSize && fftSize && sampleRate
    ? frameAxis(hopSize, fftSize, sampleRate, frameCount)
    : { step: duration / Math.max(1, frameCount), offset: 0, count: frameCount };
  const axis = frameAxisRef.current;

  const hasData = frameCount > 0 && mfcc.length > 0;
  const visCoef = nMfcc - 1;
  // Per-coefficient min/max is a full pass over the analysis; memoize it so it
  // is paid once for the row rather than once per tile.
  const ranges = useMemo(
    () => (hasData ? computeCoefRanges(mfcc, nMfcc, frameCount) : null),
    [mfcc, nMfcc, frameCount, hasData],
  );

  const paint = useCallback((ctx: CanvasRenderingContext2D, tile: TileGeom) => {
    if (!ranges) return;
    const totalPx = Math.max(1, Math.round(tile.totalW * tile.dpr));
    const H = Math.max(1, Math.round(tile.h * tile.dpr));
    const colOffset = Math.round(tile.x0 * tile.dpr);
    const colCount = Math.max(1, Math.round(tile.w * tile.dpr));
    const img = buildCepstrogramImage(
      mfcc, nMfcc, totalPx, H, ranges.min, ranges.max, ctx, axis, duration, colOffset, colCount,
    );
    ctx.putImageData(img, 0, 0);
  }, [mfcc, nMfcc, ranges, axis, duration]);

  const overlay = useCallback((ctx: CanvasRenderingContext2D, tile: TileGeom, focusX: number | null) => {
    const totalPx = Math.max(1, Math.round(tile.totalW * tile.dpr));
    const H = Math.max(1, Math.round(tile.h * tile.dpr));
    ctx.save();
    ctx.translate(-Math.round(tile.x0 * tile.dpr), 0);
    drawCoefLabels(ctx, totalPx, H, visCoef, tile.dpr);
    drawBeatGrid(ctx, {
      W: totalPx, H, dpr: tile.dpr, thickness: gridThickness,
      duration, beatTimes, bpm, beatOffset, beatsPerBar,
      barGroupSize, subBeatDivision, beatGroupSize,
    });
    if (focusX != null) drawPlayhead(ctx, totalPx, H, focusX, tile.totalW, tile.dpr);
    ctx.restore();
  }, [visCoef, gridThickness, duration, beatTimes, bpm, beatOffset, beatsPerBar,
      barGroupSize, subBeatDivision, beatGroupSize]);

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
          Computing cepstrogram…
        </div>
      )}
    </TiledStrip>
  );
}
