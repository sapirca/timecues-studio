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

import { useEffect, useRef, useState, useCallback } from 'react';
import { useExtendedZoom, effectiveDpr } from '../hooks/useExtendedZoom';
import { visibleGridLines } from '../utils/beatGrid';

export interface Props {
  /** Row-major MFCC matrix: length = frameCount × nMfcc. Index = frame * nMfcc + coef. */
  mfcc: Float32Array;
  nMfcc: number;
  frameCount: number;
  duration: number;
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
  mfcc: Float32Array, nMfcc: number, frameCount: number,
  W: number, H: number,
  coefMin: Float32Array, coefMax: Float32Array,
  ctx: CanvasRenderingContext2D,
): ImageData {
  // Drop coef 0 — visible coefficients are 1..nMfcc-1.
  const visCoef = nMfcc - 1;
  const img = ctx.createImageData(W, H);
  for (let col = 0; col < W; col++) {
    const srcFrame = Math.min(frameCount - 1, Math.floor((col / W) * frameCount));
    const fOff = srcFrame * nMfcc;
    for (let row = 0; row < H; row++) {
      // Top row = highest coefficient (matches librosa specshow convention).
      const coefIdx = (visCoef - 1) - Math.floor((row / H) * visCoef) + 1; // 1..nMfcc-1
      const v   = mfcc[fOff + coefIdx];
      const lo  = coefMin[coefIdx];
      const hi  = coefMax[coefIdx];
      const t   = hi > lo ? (v - lo) / (hi - lo) : 0.5;
      const [r, g, b] = magmaRGB(t);
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

function drawBeatGrid(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  duration: number, beatTimes?: number[], bpm?: number, beatOffset = 0, beatsPerBar = 4, barGroupSize?: number,
  subBeatDivision?: number,
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
    subBeatDivision,
    beatGroupSize,
  });
  if (lines.length < 2) return;
  // Cull lines that would render closer than 5 px — at low zoom every line
  // becomes a hairline blur otherwise. The cull step is measured in beat-
  // divisions so sub-beat (8th/16th) lines also thin out.
  const dense = barGroupSize == null;
  const div = (dense && subBeatDivision && subBeatDivision > 1) ? Math.floor(subBeatDivision) : 1;
  const pxPerStep = ((60 / bpm) / div / duration) * W;
  const step = dense ? Math.max(1, Math.ceil(5 / pxPerStep)) : 1;
  ctx.save();
  for (let i = 0; i < lines.length; i++) {
    if (step > 1 && i % step !== 0) continue;
    const { t, isBar, isPhrase, isSubBeat } = lines[i];
    const x = (t / duration) * W;
    if (barGroupSize != null) {
      ctx.strokeStyle = 'rgba(251,191,36,0.5)';
      ctx.lineWidth   = 2 * dpr * gridThickness;
    } else if (isPhrase) {
      ctx.strokeStyle = 'rgba(251,191,36,0.50)';
      ctx.lineWidth   = 1.5 * dpr * gridThickness;
    } else if (isBar) {
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth   = 1.5 * dpr * gridThickness;
    } else if (isSubBeat) {
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth   = 1 * dpr * gridThickness;
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.09)';
      ctx.lineWidth   = 1 * dpr * gridThickness;
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
interface CepstroCache {
  mfccRef: Float32Array;
  imgData: ImageData;
  W: number;
  H: number;
  dpr: number;
  visCoef: number;
}

// ── Component ───────────────────────────────────────────────────────────────────
export function CepstrogramAnnotated({
  mfcc,
  nMfcc,
  frameCount,
  duration,
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
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cacheRef = useRef<CepstroCache | null>(null);
  const [ready, setReady] = useState(false);
  const { enabled: extendedZoom } = useExtendedZoom();
  // dpr is clamped by both the extended-zoom opt-in and the canvas-buffer cap
  // so the cache and canvas always agree on dimensions even mid-zoom race.
  const CEPSTRO_MAX_BUFFER_PX = 32_000;
  const computeSafeDpr = useCallback((cssWidth: number) => {
    const raw = effectiveDpr(Math.max(1, window.devicePixelRatio || 1), extendedZoom);
    return Math.min(raw, CEPSTRO_MAX_BUFFER_PX / Math.max(1, cssWidth));
  }, [extendedZoom]);
  const [canvasSize, setCanvasSize] = useState(() => {
    const cssWidth = 900;
    return {
      cssWidth,
      cssHeight: Math.max(1, Math.round(height)),
      dpr: computeSafeDpr(cssWidth),
    };
  });

  useEffect(() => {
    const update = () => {
      const cssWidth = Math.max(1, Math.round(containerRef.current?.clientWidth ?? 900));
      const cssHeight = Math.max(1, Math.round(height));
      const dpr = computeSafeDpr(cssWidth);
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
  }, [height, computeSafeDpr]);

  const pixelWidth  = Math.max(1, Math.round(canvasSize.cssWidth * canvasSize.dpr));
  const pixelHeight = Math.max(1, Math.round(canvasSize.cssHeight * canvasSize.dpr));

  const overlayRef = useRef({ duration, beatTimes, bpm, beatOffset, beatsPerBar, barGroupSize, subBeatDivision, beatGroupSize, gridThickness });
  useEffect(() => { overlayRef.current = { duration, beatTimes, bpm, beatOffset, beatsPerBar, barGroupSize, subBeatDivision, beatGroupSize, gridThickness }; });

  const drawFrame = useCallback((headTime: number) => {
    const canvas = canvasRef.current;
    const cache  = cacheRef.current;
    if (!canvas || !cache) return;
    const ctx = canvas.getContext('2d')!;
    const { imgData, W, H, dpr, visCoef } = cache;
    const { duration: dur, beatTimes: bt, bpm: b, beatOffset: bo, beatsPerBar: bpb, barGroupSize: bgs, subBeatDivision: sbd, beatGroupSize: bgrp, gridThickness: gt } = overlayRef.current;
    ctx.putImageData(imgData, 0, 0);
    drawCoefLabels(ctx, W, H, visCoef, dpr);
    drawBeatGrid(ctx, W, H, dur, bt, b, bo, bpb, bgs, sbd, bgrp, dpr, gt);
    drawPlayhead(ctx, W, H, headTime, dur, dpr);
  }, []);

  // Phase 1: build ImageData when source data / canvas size changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (frameCount <= 0 || mfcc.length === 0) { setReady(false); return; }
    setReady(false);
    let cancelled = false;

    const timer = setTimeout(() => {
      if (cancelled) return;
      const W = canvas.width, H = canvas.height;
      const { min, max } = computeCoefRanges(mfcc, nMfcc, frameCount);
      const ctx = canvas.getContext('2d')!;
      const img = buildCepstrogramImage(mfcc, nMfcc, frameCount, W, H, min, max, ctx);
      if (cancelled) return;
      cacheRef.current = {
        mfccRef: mfcc, imgData: img, W, H, dpr: canvasSize.dpr,
        visCoef: nMfcc - 1,
      };
      setReady(true);
    }, 16);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [mfcc, nMfcc, frameCount, canvasSize.cssWidth, canvasSize.cssHeight, canvasSize.dpr]);

  // Phase 2: redraw overlays on time / grid change.
  useEffect(() => {
    if (!ready) return;
    drawFrame(currentTime);
  }, [ready, currentTime, duration, beatTimes, bpm, beatOffset, beatsPerBar, barGroupSize, subBeatDivision, gridThickness, drawFrame]);

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
          Computing cepstrogram…
        </div>
      )}
    </div>
  );
}
