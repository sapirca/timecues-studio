import { useEffect, useMemo, useRef, useState } from 'react';
import {
  aggregateRange,
  amplitudeToExtent,
  buildSummary,
  DB_FLOOR,
  type ScaleMode,
  type WaveformSummary,
  type WindowStats,
} from '../utils/waveformAnalysis';

const HEIGHT = 96;
const CLIP_VISUAL_THRESHOLD = 0.99;

interface OverviewWaveformProps {
  audioBuffer: AudioBuffer | null;
  /** Visible viewport width in CSS pixels */
  containerWidth: number;
  /** Effective WaveSurfer zoom in pixels-per-second */
  pxPerSec: number;
  /** Current scrollLeft of WaveSurfer's internal scroll container, in CSS px */
  scrollLeft: number;
  /** Outer (peak) envelope color — hex like '#fb7185' */
  peakColor: string;
  /** Inner (RMS) envelope color — hex like '#e11d48' */
  rmsColor: string;
  scaleMode: ScaleMode;
}

function hexAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function OverviewWaveform({
  audioBuffer,
  containerWidth,
  pxPerSec,
  scrollLeft,
  peakColor,
  rmsColor,
  scaleMode,
}: OverviewWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const [isLight, setIsLight] = useState(
    () => document.documentElement.getAttribute('data-theme') === 'light',
  );

  // Track theme attribute so grid colors flip when the user toggles theme.
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setIsLight(document.documentElement.getAttribute('data-theme') === 'light'),
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  const summary = useMemo<WaveformSummary | null>(
    () => (audioBuffer ? buildSummary(audioBuffer) : null),
    [audioBuffer],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || containerWidth <= 0) return;

    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      drawAll(
        canvas,
        summary,
        containerWidth,
        pxPerSec,
        scrollLeft,
        peakColor,
        rmsColor,
        scaleMode,
        isLight,
      );
      rafRef.current = null;
    });

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [summary, containerWidth, pxPerSec, scrollLeft, peakColor, rmsColor, scaleMode, isLight]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: HEIGHT,
        pointerEvents: 'none',
        display: 'block',
        zIndex: 1,
      }}
    />
  );
}

function drawAll(
  canvas: HTMLCanvasElement,
  summary: WaveformSummary | null,
  cssW: number,
  pxPerSec: number,
  scrollLeft: number,
  peakColor: string,
  rmsColor: string,
  scaleMode: ScaleMode,
  isLight: boolean,
) {
  const dpr = window.devicePixelRatio || 1;
  const cssH = HEIGHT;
  const tgtW = Math.max(1, Math.floor(cssW * dpr));
  const tgtH = Math.max(1, Math.floor(cssH * dpr));
  if (canvas.width !== tgtW) canvas.width = tgtW;
  if (canvas.height !== tgtH) canvas.height = tgtH;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  drawGrid(ctx, cssW, cssH, scaleMode, isLight);

  if (!summary || pxPerSec <= 0) return;

  const samplesPerPixel = summary.sampleRate / pxPerSec;
  if (samplesPerPixel < 1) {
    drawSampleLine(ctx, summary, cssW, cssH, pxPerSec, scrollLeft, peakColor, rmsColor, scaleMode);
  } else {
    drawPeakRms(ctx, summary, cssW, cssH, pxPerSec, scrollLeft, peakColor, rmsColor, scaleMode);
  }
}

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, scaleMode: ScaleMode, isLight: boolean) {
  const halfH = h / 2;
  const axisColor   = isLight ? 'rgba(15, 23, 42, 0.18)' : 'rgba(255, 255, 255, 0.07)';
  const guideStroke = isLight ? 'rgba(15, 23, 42, 0.10)' : 'rgba(255, 255, 255, 0.04)';
  const guideLabel  = isLight ? 'rgba(15, 23, 42, 0.55)' : 'rgba(148, 163, 184, 0.45)';

  // Center axis (zero amplitude) — solid hairline, minimal
  ctx.save();
  ctx.strokeStyle = axisColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, halfH + 0.5);
  ctx.lineTo(w, halfH + 0.5);
  ctx.stroke();
  ctx.restore();

  type Guide = { value: number; label: string };
  const guides: Guide[] =
    scaleMode === 'db'
      ? [
          { value: -3, label: '-3 dB' },
          { value: -6, label: '-6 dB' },
          { value: -12, label: '-12 dB' },
          { value: -24, label: '-24 dB' },
        ]
      : [
          { value: 0.75, label: '0.75' },
          { value: 0.5, label: '0.5' },
          { value: 0.25, label: '0.25' },
        ];

  ctx.save();
  ctx.strokeStyle = guideStroke;
  ctx.fillStyle = guideLabel;
  ctx.font = '8px ui-monospace, "JetBrains Mono", "SF Mono", monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  for (const g of guides) {
    let extent: number;
    if (scaleMode === 'db') {
      const db = g.value;
      if (db <= DB_FLOOR) extent = 0;
      else if (db >= 0) extent = halfH;
      else extent = ((db - DB_FLOOR) / -DB_FLOOR) * halfH;
    } else {
      extent = g.value * halfH;
    }
    const yTop = halfH - extent;
    const yBot = halfH + extent;
    ctx.beginPath();
    ctx.moveTo(0, yTop + 0.5);
    ctx.lineTo(w, yTop + 0.5);
    ctx.moveTo(0, yBot + 0.5);
    ctx.lineTo(w, yBot + 0.5);
    ctx.stroke();
    ctx.fillText(g.label, w - 4, yTop + 1);
  }
  ctx.restore();
}

function drawPeakRms(
  ctx: CanvasRenderingContext2D,
  summary: WaveformSummary,
  cssW: number,
  cssH: number,
  pxPerSec: number,
  scrollLeft: number,
  peakColor: string,
  rmsColor: string,
  scaleMode: ScaleMode,
) {
  const halfH = cssH / 2;
  const sr = summary.sampleRate;
  const n = Math.max(0, Math.floor(cssW));
  const cols: WindowStats[] = new Array(n);

  for (let x = 0; x < n; x++) {
    const t0 = (scrollLeft + x) / pxPerSec;
    const t1 = (scrollLeft + x + 1) / pxPerSec;
    cols[x] = aggregateRange(summary, t0 * sr, t1 * sr);
  }

  // Vertical gradients: peaks fade out toward the canvas edges, RMS body
  // stays brightest at the centerline. Reads as a soft glow rather than a
  // flat slab.
  const peakGrad = ctx.createLinearGradient(0, 0, 0, cssH);
  peakGrad.addColorStop(0,    hexAlpha(peakColor, 0.18));
  peakGrad.addColorStop(0.5,  hexAlpha(peakColor, 0.55));
  peakGrad.addColorStop(1,    hexAlpha(peakColor, 0.18));

  const rmsGrad = ctx.createLinearGradient(0, 0, 0, cssH);
  rmsGrad.addColorStop(0,    hexAlpha(rmsColor, 0.55));
  rmsGrad.addColorStop(0.5,  rmsColor);
  rmsGrad.addColorStop(1,    hexAlpha(rmsColor, 0.55));

  // Outer: peak envelope
  ctx.fillStyle = peakGrad;
  const peakExts = new Float32Array(n);
  for (let x = 0; x < n; x++) {
    const ext = amplitudeToExtent(cols[x].peak, halfH, scaleMode);
    peakExts[x] = ext;
    if (ext < 0.5) continue;
    ctx.fillRect(x, halfH - ext, 1, ext * 2);
  }

  // Inner: RMS envelope. Clamp to 85% of peak so the warm peak halo always
  // shows above the violet body — guarantees a visible "stepped" silhouette
  // even in heavily compressed material where peak ≈ RMS.
  const RMS_VS_PEAK_RATIO = 0.85;
  ctx.fillStyle = rmsGrad;
  for (let x = 0; x < n; x++) {
    let ext = amplitudeToExtent(cols[x].rms, halfH, scaleMode);
    const cap = peakExts[x] * RMS_VS_PEAK_RATIO;
    if (ext > cap) ext = cap;
    if (ext < 0.5) continue;
    ctx.fillRect(x, halfH - ext, 1, ext * 2);
  }

  // Hairline highlight along the top + bottom of the peak envelope —
  // crisps the silhouette without recoloring the body. Only meaningful in
  // linear mode: in dB mode the peak per column is nearly always at 0 dB
  // (max-over-samples), so the highlight collapses into a continuous band
  // along the canvas edges and reads as a solid block.
  if (scaleMode === 'lin') {
    ctx.fillStyle = hexAlpha(peakColor, 0.85);
    for (let x = 0; x < n; x++) {
      const ext = amplitudeToExtent(cols[x].peak, halfH, scaleMode);
      if (ext < 0.5) continue;
      ctx.fillRect(x, halfH - ext, 1, 1);
      ctx.fillRect(x, halfH + ext - 1, 1, 1);
    }
  }

  // Clipping caps
  ctx.fillStyle = '#ff1f4d';
  for (let x = 0; x < n; x++) {
    if (!cols[x].clipped) continue;
    ctx.fillRect(x, 0, 1, 2);
    ctx.fillRect(x, cssH - 2, 1, 2);
  }
}

function drawSampleLine(
  ctx: CanvasRenderingContext2D,
  summary: WaveformSummary,
  cssW: number,
  cssH: number,
  pxPerSec: number,
  scrollLeft: number,
  peakColor: string,
  rmsColor: string,
  scaleMode: ScaleMode,
) {
  const halfH = cssH / 2;
  const sr = summary.sampleRate;

  const tLeft = scrollLeft / pxPerSec;
  const tRight = (scrollLeft + cssW) / pxPerSec;
  const s0 = Math.max(0, Math.floor(tLeft * sr) - 1);
  const s1 = Math.min(summary.totalSamples, Math.ceil(tRight * sr) + 2);
  if (s1 <= s0) return;

  const sampleX = (i: number) => (i / sr) * pxPerSec - scrollLeft;
  const sampleY = (v: number) => {
    const ext = amplitudeToExtent(v < 0 ? -v : v, halfH, scaleMode);
    return halfH - (v >= 0 ? ext : -ext);
  };

  // Continuous interpolated line
  ctx.save();
  ctx.strokeStyle = rmsColor;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = s0; i < s1; i++) {
    const x = sampleX(i);
    const y = sampleY(summary.mono[i]);
    if (i === s0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();

  // Sample dots — discrete digital nature
  ctx.save();
  ctx.fillStyle = peakColor;
  for (let i = s0; i < s1; i++) {
    const x = sampleX(i);
    const y = sampleY(summary.mono[i]);
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // Clipping caps at sample resolution
  ctx.fillStyle = '#ff1f4d';
  for (let i = s0; i < s1; i++) {
    const v = summary.mono[i];
    const av = v < 0 ? -v : v;
    if (av < CLIP_VISUAL_THRESHOLD) continue;
    const x = Math.floor(sampleX(i));
    ctx.fillRect(x, 0, 1, 2);
    ctx.fillRect(x, cssH - 2, 1, 2);
  }
}
