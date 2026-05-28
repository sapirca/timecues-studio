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

import { useEffect, useRef, useState, useCallback } from 'react';
import { visibleGridLines } from '../utils/beatGrid';

export interface Props {
  /** Square row-major SSM: length = ssmFrameCount². Values in [0,1]. */
  ssm: Float32Array;
  ssmFrameCount: number;
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
): ImageData {
  const img = ctx.createImageData(W, H);
  for (let col = 0; col < W; col++) {
    const srcCol = Math.min(n - 1, Math.floor((col / W) * n));
    for (let row = 0; row < H; row++) {
      // Row 0 = top = SSM frame 0 (start of song). Standard SSM display orientation.
      const srcRow = Math.min(n - 1, Math.floor((row / H) * n));
      const v = ssm[srcRow * n + srcCol];
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

// ── Overlays ────────────────────────────────────────────────────────────────────
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
      ctx.strokeStyle = isPhrase ? 'rgba(251,191,36,0.40)'
        : isBar ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.07)';
      ctx.lineWidth = (isBar ? (1.5 * dpr) : (1 * dpr)) * gridThickness;
    }
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  ctx.restore();
}

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

// ── Cache ───────────────────────────────────────────────────────────────────────
interface SsmCache {
  ssmRef: Float32Array;
  imgData: ImageData;
  W: number;
  H: number;
  dpr: number;
}

// ── Component ───────────────────────────────────────────────────────────────────
export function SsmAnnotated({
  ssm,
  ssmFrameCount,
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
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cacheRef = useRef<SsmCache | null>(null);
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
    drawBeatGrid(ctx, W, H, dur, bt, b, bo, bpb, bgs, bgrp, dpr, gt);
    drawPlayhead(ctx, W, H, headTime, dur, dpr);
  }, []);

  // Phase 1: build ImageData when source data / canvas size changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (ssmFrameCount <= 0 || ssm.length === 0) { setReady(false); return; }
    setReady(false);
    let cancelled = false;

    const timer = setTimeout(() => {
      if (cancelled) return;
      const W = canvas.width, H = canvas.height;
      const ctx = canvas.getContext('2d')!;
      const img = buildSsmImage(ssm, ssmFrameCount, W, H, ctx);
      if (cancelled) return;
      cacheRef.current = {
        ssmRef: ssm, imgData: img, W, H, dpr: canvasSize.dpr,
      };
      setReady(true);
    }, 16);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [ssm, ssmFrameCount, canvasSize.cssWidth, canvasSize.cssHeight, canvasSize.dpr]);

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
          Computing SSM…
        </div>
      )}
    </div>
  );
}
