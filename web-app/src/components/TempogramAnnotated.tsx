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

import { useEffect, useRef, useState, useCallback } from 'react';
import { visibleGridLines } from '../utils/beatGrid';

export interface Props {
  /** Row-major tempogram matrix: length = tempogramFrameCount × nTempo. Index = tempoFrame * nTempo + bin. */
  tempogram: Float32Array;
  nTempo: number;
  tempogramFrameCount: number;
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
  tempogram: Float32Array, nTempo: number, tempogramFrameCount: number,
  W: number, H: number,
  ctx: CanvasRenderingContext2D,
): ImageData {
  const img = ctx.createImageData(W, H);
  for (let col = 0; col < W; col++) {
    const srcFrame = Math.min(tempogramFrameCount - 1, Math.floor((col / W) * tempogramFrameCount));
    const fOff = srcFrame * nTempo;
    for (let row = 0; row < H; row++) {
      // Top row = highest BPM (last index in tempoBpm), bottom = slowest.
      const bin = (nTempo - 1) - Math.floor((row / H) * nTempo);
      const v = tempogram[fOff + bin];
      const [r, g, b] = magmaRGB(v);
      const idx = (row * W + col) * 4;
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

function drawBeatGrid(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  duration: number, beatTimes?: number[], bpm?: number, beatOffset = 0, beatsPerBar = 4, barGroupSize?: number,
  beatGroupSize?: number,
  dpr = 1,
  gridThickness = 1,
) {
  if (!duration || !bpm) return;
  const anchor = beatOffset > 0 ? beatOffset : (beatTimes && beatTimes.length > 0 ? beatTimes[0] : 0);
  const lines = visibleGridLines({
    bpm, gridOffset: anchor, beatsPerBar,
    startTime: 0, endTime: duration,
    barGroupSize: barGroupSize ?? null,
    beatGroupSize,
  });
  if (lines.length < 2) return;
  const pxPerBeat = ((60 / bpm) / duration) * W;
  const step = (barGroupSize == null) ? Math.max(1, Math.ceil(5 / pxPerBeat)) : 1;
  ctx.save();
  for (let i = 0; i < lines.length; i++) {
    if (step > 1 && i % step !== 0) continue;
    const { t, isBar, isPhrase } = lines[i];
    const x = (t / duration) * W;
    if (barGroupSize != null) {
      ctx.strokeStyle = 'rgba(251,191,36,0.5)';
      ctx.lineWidth   = 2 * dpr * gridThickness;
    } else {
      ctx.strokeStyle = isPhrase ? 'rgba(251,191,36,0.50)'
        : isBar ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.09)';
      ctx.lineWidth = (isBar ? (1.5 * dpr) : (1 * dpr)) * gridThickness;
    }
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  ctx.restore();
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

// ── Cache ───────────────────────────────────────────────────────────────────────
interface TempoCache {
  tempogramRef: Float32Array;
  imgData: ImageData;
  W: number;
  H: number;
  dpr: number;
}

// ── Component ───────────────────────────────────────────────────────────────────
export function TempogramAnnotated({
  tempogram,
  nTempo,
  tempogramFrameCount,
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
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cacheRef = useRef<TempoCache | null>(null);
  const [ready, setReady] = useState(false);
  const [canvasSize, setCanvasSize] = useState(() => ({
    cssWidth: 900,
    cssHeight: Math.max(1, Math.round(height)),
    dpr: window.devicePixelRatio || 1,
  }));

  useEffect(() => {
    const update = () => {
      const cssWidth = Math.max(1, Math.round(containerRef.current?.clientWidth ?? 900));
      const cssHeight = Math.max(1, Math.round(height));
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      setCanvasSize((prev) => (
        prev.cssWidth === cssWidth && prev.cssHeight === cssHeight && prev.dpr === dpr
          ? prev
          : { cssWidth, cssHeight, dpr }
      ));
    };
    update();
    const ro = containerRef.current ? new ResizeObserver(update) : null;
    if (containerRef.current && ro) ro.observe(containerRef.current);
    window.addEventListener('resize', update);
    return () => { ro?.disconnect(); window.removeEventListener('resize', update); };
  }, [height]);

  const pixelWidth  = Math.max(1, Math.round(canvasSize.cssWidth * canvasSize.dpr));
  const pixelHeight = Math.max(1, Math.round(canvasSize.cssHeight * canvasSize.dpr));

  const overlayRef = useRef({ duration, beatTimes, bpm, beatOffset, beatsPerBar, barGroupSize, beatGroupSize, gridThickness });
  useEffect(() => { overlayRef.current = { duration, beatTimes, bpm, beatOffset, beatsPerBar, barGroupSize, beatGroupSize, gridThickness }; });

  const drawFrame = useCallback((headTime: number) => {
    const canvas = canvasRef.current;
    const cache  = cacheRef.current;
    if (!canvas || !cache) return;
    const ctx = canvas.getContext('2d')!;
    const { imgData, W, H, dpr } = cache;
    const { duration: dur, beatTimes: bt, bpm: b, beatOffset: bo, beatsPerBar: bpb, barGroupSize: bgs, beatGroupSize: bgrp, gridThickness: gt } = overlayRef.current;
    ctx.putImageData(imgData, 0, 0);
    drawBpmLabels(ctx, W, H, nTempo, tempoBpm, dpr);
    drawBeatGrid(ctx, W, H, dur, bt, b, bo, bpb, bgs, bgrp, dpr, gt);
    drawPlayhead(ctx, W, H, headTime, dur, dpr);
  }, [nTempo, tempoBpm]);

  // Phase 1: build ImageData when source data / canvas size changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (tempogramFrameCount <= 0 || tempogram.length === 0) { setReady(false); return; }
    setReady(false);
    let cancelled = false;

    const timer = setTimeout(() => {
      if (cancelled) return;
      const W = canvas.width, H = canvas.height;
      const ctx = canvas.getContext('2d')!;
      const img = buildTempogramImage(tempogram, nTempo, tempogramFrameCount, W, H, ctx);
      if (cancelled) return;
      cacheRef.current = {
        tempogramRef: tempogram, imgData: img, W, H, dpr: canvasSize.dpr,
      };
      setReady(true);
    }, 16);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [tempogram, nTempo, tempogramFrameCount, canvasSize.cssWidth, canvasSize.cssHeight, canvasSize.dpr]);

  // Phase 2: redraw overlays on time / grid change.
  useEffect(() => {
    if (!ready) return;
    drawFrame(currentTime);
  }, [ready, currentTime, duration, beatTimes, bpm, beatOffset, beatsPerBar, barGroupSize, beatGroupSize, gridThickness, drawFrame]);

  return (
    <div ref={containerRef} className="relative w-full min-w-0">
      <canvas
        ref={canvasRef}
        width={pixelWidth}
        height={pixelHeight}
        className="rounded bg-gray-900 block w-full"
        style={{ height: `${canvasSize.cssHeight}px` }}
      />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-900/70 rounded text-xs text-gray-400 animate-pulse pointer-events-none">
          Computing tempogram…
        </div>
      )}
    </div>
  );
}
