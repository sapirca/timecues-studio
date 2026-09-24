/**
 * SsmAnnotated
 *
 * Chroma-based self-similarity matrix (SSM) rendered as a 2D heatmap.
 * Square N×N matrix where N = ssmFrameCount; entry [i,j] = cosine similarity
 * between L2-normalised aggregated chroma vectors at downsampled frames i, j.
 *
 * Both axes represent time (from 0 to duration). The bright diagonal is each
 * frame's self-similarity = 1. Off-diagonal bright stripes parallel to the
 * diagonal mark repeated content (e.g., a chorus heard twice).
 *
 * UX note: the canvas is row-shaped, not square — its width is the panel
 * width while its height is fixed. Off-diagonal stripes therefore appear
 * sheared (their slope ≠ 45°) but remain visible. The X-axis still maps
 * 1:1 to time so the beat grid and playhead align with the other rows.
 *
 * Two-phase render matches Cepstrogram/Chromagram/Tempogram conventions.
 */

import { useCallback, useRef } from 'react';
import { TiledStrip, type TileGeom } from './TiledStrip';
import { drawBeatGrid } from '../utils/gridLineStyle';
import { frameAxis, derivedAxis, frameAtColumn, type FrameAxis } from '../utils/frameTime';

export interface Props {
  /** Square row-major SSM: length = ssmFrameCount². Values in [0,1]. */
  ssm: Float32Array;
  ssmFrameCount: number;
  /** Framing of the underlying STFT run — see utils/frameTime. Each SSM frame
   *  is the mean of 64 input frames, so its axis is derived from that one. */
  hopSize?: number;
  fftSize?: number;
  sampleRate?: number;
  duration: number;
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

// ── Roseus colormap (same as other 2D viz components) ────────────────────────
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

function buildSsmImage(
  ssm: Float32Array, n: number,
  W: number, H: number,
  ctx: CanvasRenderingContext2D,
  axis: FrameAxis, duration: number,
  colOffset = 0, colCount = W,
): ImageData {
  // W is the whole strip's width (the horizontal time axis stays global); the
  // vertical axis is this tile's own height, which is the full row height.
  const img = ctx.createImageData(colCount, H);
  for (let col = 0; col < colCount; col++) {
    const srcCol = frameAtColumn(colOffset + col, W, duration, axis);
    for (let row = 0; row < H; row++) {
      // Row 0 = top = SSM frame 0 (start of song). Standard SSM display
      // orientation — and the vertical axis is the same time axis as the
      // horizontal one, so it gets the same frame-centre mapping.
      const srcRow = frameAtColumn(row, H, duration, axis);
      const v = ssm[srcRow * n + srcCol];
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
function drawPlayhead(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, duration: number, dpr = 1) {
  if (t < 0 || !duration) return;
  // Vertical line on the X-axis (column = current time).
  const x = Math.round((t / duration) * W);
  // Horizontal line on the Y-axis (row = current time) — together they crosshair
  // the current self-similarity row, so the user can see what "now" is similar to.
  const y = Math.round((t / duration) * H);
  ctx.save();
  ctx.shadowColor = 'rgba(255,255,255,0.6)';
  ctx.shadowBlur  = 4 * dpr;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth   = 1.5 * dpr;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth   = 1 * dpr;
  ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.moveTo(x - (5 * dpr), 0); ctx.lineTo(x + (5 * dpr), 0); ctx.lineTo(x, 8 * dpr);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

// ── Component ───────────────────────────────────────────────────────────────────
export function SsmAnnotated({
  ssm,
  ssmFrameCount,
  hopSize,
  fftSize,
  sampleRate,
  duration,
  beatTimes,
  bpm,
  beatOffset = 0,
  beatsPerBar = 4,
  barGroupSize,
  beatGroupSize,
  gridThickness = 1,
  currentTime = 0,
  height = 180,
}: Props) {
  const baseAxis = hopSize && fftSize && sampleRate
    ? frameAxis(hopSize, fftSize, sampleRate, 0)
    : null;
  // Each SSM frame is the mean of 64 consecutive input frames, so its centre
  // sits in the middle of that block (groupSize defaults to the hop factor).
  const frameAxisRef = useRef<FrameAxis>({ step: 0, offset: 0, count: 0 });
  frameAxisRef.current = baseAxis
    ? derivedAxis(baseAxis, 64, ssmFrameCount)
    : { step: duration / Math.max(1, ssmFrameCount), offset: 0, count: ssmFrameCount };
  const axis = frameAxisRef.current;

  const hasData = ssmFrameCount > 0 && ssm.length > 0;

  const paint = useCallback((ctx: CanvasRenderingContext2D, tile: TileGeom) => {
    if (!hasData) return;
    const totalPx = Math.max(1, Math.round(tile.totalW * tile.dpr));
    const H = Math.max(1, Math.round(tile.h * tile.dpr));
    const colOffset = Math.round(tile.x0 * tile.dpr);
    const colCount = Math.max(1, Math.round(tile.w * tile.dpr));
    const img = buildSsmImage(ssm, ssmFrameCount, totalPx, H, ctx, axis, duration, colOffset, colCount);
    ctx.putImageData(img, 0, 0);
  }, [ssm, ssmFrameCount, axis, duration, hasData]);

  // The SSM playhead is a crosshair: its horizontal arm crosses every tile, so
  // unlike the other rows this overlay cannot be limited to the tile the
  // vertical arm is on — it takes currentTime directly and every mounted tile
  // redraws. Cheap: it is two lines on a transparent canvas, not a repaint of
  // the matrix underneath.
  const overlay = useCallback((ctx: CanvasRenderingContext2D, tile: TileGeom) => {
    const totalPx = Math.max(1, Math.round(tile.totalW * tile.dpr));
    const H = Math.max(1, Math.round(tile.h * tile.dpr));
    ctx.save();
    ctx.translate(-Math.round(tile.x0 * tile.dpr), 0);
    drawBeatGrid(ctx, {
      W: totalPx, H, dpr: tile.dpr, thickness: gridThickness,
      duration, beatTimes, bpm, beatOffset, beatsPerBar,
      barGroupSize, beatGroupSize,
    });
    drawPlayhead(ctx, totalPx, H, currentTime, duration, tile.dpr);
    ctx.restore();
  }, [gridThickness, duration, beatTimes, bpm, beatOffset, beatsPerBar,
      barGroupSize, beatGroupSize, currentTime]);

  return (
    <TiledStrip
      height={Math.max(1, Math.round(height))}
      paint={paint}
      overlay={overlay}
      overlayFocus={null}
      className="rounded bg-gray-900 w-full min-w-0 overflow-hidden"
    >
      {!hasData && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-900/70 rounded text-xs text-gray-400 animate-pulse pointer-events-none">
          Computing SSM…
        </div>
      )}
    </TiledStrip>
  );
}
