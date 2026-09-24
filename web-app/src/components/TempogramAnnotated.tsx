/**
 * TempogramAnnotated
 *
 * 2D heatmap of tempo strength over time (nTempo rows × tempogramFrameCount columns).
 * Mirrors ChromagramAnnotated's two-phase render — Phase 1 builds an ImageData
 * cached against the source tempogram reference; Phase 2 redraws overlays per frame.
 *
 * Each column is already per-frame max-normalised in mirAnalysis (column max = 1),
 * so the heatmap maps the raw [0,1] value directly through the colormap.
 *
 * Row 0 (bottom) = slowest BPM (typically 30), top row = fastest (typically 300).
 * BPM labels are drawn at canonical reference tempos (60, 90, 120, 150, 180, 240)
 * by snapping each target to the nearest log-spaced row.
 */

import { useCallback, useRef } from 'react';
import { TiledStrip, type TileGeom } from './TiledStrip';
import { drawBeatGrid } from '../utils/gridLineStyle';
import { frameAxis, derivedAxis, frameAtColumn, type FrameAxis } from '../utils/frameTime';

export interface Props {
  /** Row-major tempogram matrix: length = tempogramFrameCount × nTempo. Index = tempoFrame * nTempo + bin. */
  tempogram: Float32Array;
  nTempo: number;
  tempogramFrameCount: number;
  /** Framing of the underlying STFT run — see utils/frameTime. The tempogram's
   *  own axis is derived from it (one output frame every 4 input frames, each
   *  autocorrelation window centred on its input frame). */
  hopSize?: number;
  fftSize?: number;
  sampleRate?: number;
  /** BPM value at each tempo row (length = nTempo). Used for y-axis labelling. */
  tempoBpm: Float32Array;
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

// BPM reference points to label on the y-axis. Each is snapped to the nearest
// log-spaced row at render time so labels land on actual data rows, not approximations.
const BPM_LABEL_TARGETS = [60, 90, 120, 150, 180, 240];

// ── Roseus colormap (same as Spectrogram / Cepstrogram / Chromagram) ──────────
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

function buildTempogramImage(
  tempogram: Float32Array, nTempo: number,
  W: number, H: number,
  ctx: CanvasRenderingContext2D,
  axis: FrameAxis, duration: number,
  colOffset = 0, colCount = W,
): ImageData {
  // W is the whole strip; the image covers [colOffset, colOffset + colCount).
  const img = ctx.createImageData(colCount, H);
  for (let col = 0; col < colCount; col++) {
    const srcFrame = frameAtColumn(colOffset + col, W, duration, axis);
    const fOff = srcFrame * nTempo;
    for (let row = 0; row < H; row++) {
      // Top row = highest BPM (last index in tempoBpm), bottom = slowest.
      const bin = (nTempo - 1) - Math.floor((row / H) * nTempo);
      const v = tempogram[fOff + bin];
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

// Snap each BPM label target to the nearest tempogram row index (log-spaced).
function pickBpmLabelRows(tempoBpm: Float32Array): { bpm: number; binIndex: number }[] {
  if (tempoBpm.length === 0) return [];
  const used = new Set<number>();
  const out: { bpm: number; binIndex: number }[] = [];
  for (const target of BPM_LABEL_TARGETS) {
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < tempoBpm.length; i++) {
      const d = Math.abs(Math.log2(tempoBpm[i] / target));
      if (d < bestDist) { bestDist = d; best = i; }
    }
    if (best >= 0 && !used.has(best)) { used.add(best); out.push({ bpm: target, binIndex: best }); }
  }
  return out;
}

// ── Overlays ────────────────────────────────────────────────────────────────────
function drawBpmLabels(ctx: CanvasRenderingContext2D, W: number, H: number, nTempo: number, tempoBpm: Float32Array, dpr = 1) {
  ctx.font = `${Math.round(9 * dpr)}px ui-monospace,monospace`;
  const labels = pickBpmLabelRows(tempoBpm);
  for (const { bpm, binIndex } of labels) {
    // Convert tempo bin index to row index (top = highest BPM).
    const rowIdx = (nTempo - 1) - binIndex;
    const row = Math.round((rowIdx + 0.5) / nTempo * H);
    if (row < 2 || row > H - 2) continue;
    ctx.fillStyle = 'rgba(229,231,235,0.95)';
    ctx.fillText(`${bpm}`, W - (30 * dpr), row + (3 * dpr));
    ctx.strokeStyle = 'rgba(156,163,175,0.10)';
    ctx.lineWidth = 0.5 * dpr;
    ctx.beginPath(); ctx.moveTo(0, row); ctx.lineTo(W - (34 * dpr), row); ctx.stroke();
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
export function TempogramAnnotated({
  tempogram,
  nTempo,
  tempogramFrameCount,
  hopSize,
  fftSize,
  sampleRate,
  tempoBpm,
  duration,
  beatTimes,
  bpm,
  beatOffset = 0,
  beatsPerBar = 4,
  barGroupSize,
  beatGroupSize,
  gridThickness = 1,
  currentTime = 0,
  height = 90,
}: Props) {
  const baseAxis = hopSize && fftSize && sampleRate
    ? frameAxis(hopSize, fftSize, sampleRate, 0)
    : null;
  // One output frame every 4 input frames, each autocorrelation window centred
  // on its input frame — so groupSize is 1, not 4.
  const frameAxisRef = useRef<FrameAxis>({ step: 0, offset: 0, count: 0 });
  frameAxisRef.current = baseAxis
    ? derivedAxis(baseAxis, 4, tempogramFrameCount, 1)
    : { step: duration / Math.max(1, tempogramFrameCount), offset: 0, count: tempogramFrameCount };
  const axis = frameAxisRef.current;

  const hasData = tempogramFrameCount > 0 && tempogram.length > 0;

  const paint = useCallback((ctx: CanvasRenderingContext2D, tile: TileGeom) => {
    if (!hasData) return;
    const totalPx = Math.max(1, Math.round(tile.totalW * tile.dpr));
    const H = Math.max(1, Math.round(tile.h * tile.dpr));
    const colOffset = Math.round(tile.x0 * tile.dpr);
    const colCount = Math.max(1, Math.round(tile.w * tile.dpr));
    const img = buildTempogramImage(tempogram, nTempo, totalPx, H, ctx, axis, duration, colOffset, colCount);
    ctx.putImageData(img, 0, 0);
  }, [tempogram, nTempo, axis, duration, hasData]);

  const overlay = useCallback((ctx: CanvasRenderingContext2D, tile: TileGeom, focusX: number | null) => {
    const totalPx = Math.max(1, Math.round(tile.totalW * tile.dpr));
    const H = Math.max(1, Math.round(tile.h * tile.dpr));
    ctx.save();
    ctx.translate(-Math.round(tile.x0 * tile.dpr), 0);
    drawBpmLabels(ctx, totalPx, H, nTempo, tempoBpm, tile.dpr);
    drawBeatGrid(ctx, {
      W: totalPx, H, dpr: tile.dpr, thickness: gridThickness,
      duration, beatTimes, bpm, beatOffset, beatsPerBar,
      barGroupSize, beatGroupSize,
    });
    if (focusX != null) drawPlayhead(ctx, totalPx, H, focusX, tile.totalW, tile.dpr);
    ctx.restore();
  }, [nTempo, tempoBpm, gridThickness, duration, beatTimes, bpm, beatOffset,
      beatsPerBar, barGroupSize, beatGroupSize]);

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
          Computing tempogram…
        </div>
      )}
    </TiledStrip>
  );
}
