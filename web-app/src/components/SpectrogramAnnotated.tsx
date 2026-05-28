/**
 * SpectrogramAnnotated
 *
 * Features:
 *  - Mel-scale power spectrogram (roseus colormap), computed once per AudioBuffer
 *  - Section label row above the canvas (colored chips, time-positioned)
 *  - Section boundary bands on canvas
 *  - BPM beat grid (quarter-note lines, bar lines from current time signature)
 *  - Animated playhead (white vertical line + triangle cap)
 *  - Click-to-seek on canvas
 *  - Play/pause transport below the canvas
 *
 * Two-phase render:
 *   Phase 1 – FFT → ImageData (cached in ref, only reruns when audioBuffer changes)
 *   Phase 2 – restores pixels + draws all overlays; runs from useEffect (static)
 *             and from requestAnimationFrame (when playing)
 */

import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle, type Ref } from 'react';
import type { MsafSection, SectionItem } from '../tools/runTool';
import { visibleGridLines } from '../utils/beatGrid';
import { useExtendedZoom, effectiveDpr } from '../hooks/useExtendedZoom';

type AnySection = MsafSection | SectionItem;

export interface Props {
  audioBuffer: AudioBuffer;
  sections?: AnySection[];
  duration: number;
  algoName?: string;
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
  gain?: number;
  contrast?: number;
}

// ── Hann window ────────────────────────────────────────────────────────────────

function hann(n: number, i: number) {
  return 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
}

// ── Radix-2 in-place FFT ───────────────────────────────────────────────────────

function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
    let k = n >> 1;
    while (k <= j) { j -= k; k >>= 1; }
    j += k;
  }
  for (let sz = 2; sz <= n; sz <<= 1) {
    const half = sz >> 1;
    const ang = -2 * Math.PI / sz;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += sz) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const ei = i + k, oi = i + k + half;
        const tr = cr * re[oi] - ci * im[oi];
        const ti = cr * im[oi] + ci * re[oi];
        re[oi] = re[ei] - tr; im[oi] = im[ei] - ti;
        re[ei] += tr;         im[ei] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

// ── Colormap (roseus — matches audio-visualizer SpectrogramPlugin) ─────────────

const CM: [number, number, number, number][] = [
  [0.00,   5,   0,  15],  // near-black purple
  [0.20,  60,   0, 100],  // deep violet
  [0.42, 160,   0, 120],  // magenta-purple
  [0.62, 230,  60,  20],  // orange-red
  [0.82, 255, 165,   0],  // amber
  [1.00, 255, 240, 130],  // bright yellow
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

// ── Colour palette ─────────────────────────────────────────────────────────────

const SEC_COLORS: Record<string, string> = {
  intro:     '#a78bfa',
  buildup:   '#fde047',
  drop:      '#4ade80',
  breakdown: '#e879f9',
  bridge:    '#fb7185',
  outro:     '#6b7280',
  default:   '#374151',
};
function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

// ── Mel-scale ─────────────────────────────────────────────────────────────────

function melToHz(m: number) { return 700 * (10 ** (m / 2595) - 1); }
function hzToMel(f: number) { return 2595 * Math.log10(1 + f / 700); }
function buildMelMap(bins: number, rows: number, nyquist: number): Uint16Array {
  const maxMel = hzToMel(nyquist);
  const map = new Uint16Array(rows);
  for (let row = 0; row < rows; row++) {
    map[row] = Math.min(Math.round((melToHz((1 - row / rows) * maxMel) / nyquist) * bins), bins - 1);
  }
  return map;
}


// ── Cached spectrogram ─────────────────────────────────────────────────────────

interface SpectroCache {
  buffer: AudioBuffer;
  imgData: ImageData;
  W: number;
  H: number;
  dpr: number;
  displayNyquist: number;
  specDb: Float32Array;
  melMap: Uint16Array;
  bins: number;
  minDb: number;
  maxDb: number;
}

function buildSpectrogramImage(
  specDb: Float32Array,
  melMap: Uint16Array,
  W: number,
  H: number,
  bins: number,
  minDb: number,
  maxDb: number,
  gain: number,
  contrast: number,
  ctx: CanvasRenderingContext2D,
) {
  const safeGain = Math.max(0.1, gain);
  const safeContrast = Math.max(0.1, contrast);
  // Higher contrast lowers the noise floor so quieter content is more visible.
  const floorPercent = Math.max(0, Math.min(0.45, 0.05 / safeContrast));
  const floor = minDb + (maxDb - minDb) * floorPercent;
  const range = maxDb - floor || 1;

  const img = ctx.createImageData(W, H);
  for (let col = 0; col < W; col++) {
    for (let row = 0; row < H; row++) {
      const base = (specDb[col * bins + melMap[row]] - floor) / range;
      const t = Math.max(0, Math.min(1, base * safeGain));
      const [r, g, bv] = magmaRGB(t);
      const idx = (row * W + col) * 4;
      img.data[idx] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = bv;
      img.data[idx + 3] = 255;
    }
  }
  return img;
}

// ── Canvas drawing helpers ─────────────────────────────────────────────────────

function drawFreqLabels(ctx: CanvasRenderingContext2D, W: number, H: number, displayNyquist: number, dpr = 1) {
  const labels = ['11k', '8k', '5k', '2k', '1k', '500', '200', '80'];
  const freqs  = [11000, 8000, 5000, 2000, 1000, 500, 200, 80];
  ctx.font = `${Math.round(9 * dpr)}px ui-monospace,monospace`;
  for (let i = 0; i < labels.length; i++) {
    if (freqs[i] > displayNyquist) continue;
    const row = Math.round((1 - hzToMel(freqs[i]) / hzToMel(displayNyquist)) * H);
    if (row < 2 || row > H - 2) continue;
    ctx.fillStyle   = 'rgba(156,163,175,0.85)';
    ctx.fillText(labels[i], W - (28 * dpr), row + (3 * dpr));
    ctx.strokeStyle = 'rgba(156,163,175,0.12)';
    ctx.lineWidth   = 0.5 * dpr;
    ctx.beginPath(); ctx.moveTo(0, row); ctx.lineTo(W - (30 * dpr), row); ctx.stroke();
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

  // Phase anchor: explicit beatOffset > 0, else first detected beat, else 0.
  const anchor = beatOffset > 0 ? beatOffset
    : (beatTimes && beatTimes.length > 0 ? beatTimes[0] : 0);

  const lines = visibleGridLines({
    bpm, gridOffset: anchor, beatsPerBar,
    startTime: 0, endTime: duration,
    barGroupSize: barGroupSize ?? null,
    subBeatDivision,
    beatGroupSize,
  });
  if (lines.length < 2) return;

  // In dense mode (no barGroupSize) cull lines that would render closer than 5px
  // — at very low zoom every beat would be a hairline blur otherwise. The cull
  // step is measured in beat-divisions so sub-beat (8th/16th) lines also thin out.
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

function drawSectionBands(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  sections: AnySection[], duration: number,
  dpr = 1,
) {
  if (!sections.length || !duration) return;
  ctx.save();
  for (const s of sections) {
    const x0 = (s.time    / duration) * W;
    const x1 = (s.endTime / duration) * W;
    const [cr, cg, cb] = hexToRgb(SEC_COLORS[s.type] ?? SEC_COLORS.default);
    ctx.fillStyle   = `rgba(${cr},${cg},${cb},0.18)`;
    ctx.fillRect(x0, 0, x1 - x0, H);
    ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.85)`;
    ctx.lineWidth   = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0, H); ctx.stroke();
  }
  // Closing line
  const last = sections[sections.length - 1];
  if (last) {
    const x1 = (last.endTime / duration) * W;
    const [cr, cg, cb] = hexToRgb(SEC_COLORS[last.type] ?? SEC_COLORS.default);
    ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.85)`;
    ctx.lineWidth   = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, H); ctx.stroke();
  }
  ctx.restore();
}

function drawPlayhead(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, duration: number, dpr = 1) {
  if (t < 0 || !duration) return;
  const x = Math.round((t / duration) * W);
  ctx.save();
  // Glow
  ctx.shadowColor = 'rgba(255,255,255,0.6)';
  ctx.shadowBlur  = 4 * dpr;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth   = 1.5 * dpr;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  // Triangle cap
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.moveTo(x - (5 * dpr), 0); ctx.lineTo(x + (5 * dpr), 0); ctx.lineTo(x, 8 * dpr);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

// ── Main component ─────────────────────────────────────────────────────────────

export interface SpectrogramAnnotatedHandle {
  getCanvasDataURL: () => string | null;
}

export const SpectrogramAnnotated = forwardRef<SpectrogramAnnotatedHandle, Props>(function SpectrogramAnnotated({
  audioBuffer,
  sections = [],
  duration,
  algoName,
  beatTimes,
  bpm,
  beatOffset = 0,
  beatsPerBar = 4,
  barGroupSize,
  subBeatDivision,
  beatGroupSize,
  gridThickness = 1,
  currentTime = 0,
  height = 160,
  gain = 1,
  contrast = 1,
}: Props, ref: Ref<SpectrogramAnnotatedHandle>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useImperativeHandle(ref, () => ({
    getCanvasDataURL: () => canvasRef.current?.toDataURL('image/png') ?? null,
  }));
  const cacheRef  = useRef<SpectroCache | null>(null);
  const [spectroReady, setSpectroReady] = useState(false);
  // When the user opts into extended zoom, drop the canvas dpr to 1 so the
  // internal buffer stays under the browser's max-canvas limit at high zoom.
  // Also clamp dpr by cssWidth as a defensive backstop so the canvas
  // self-degrades rather than overflowing if the cssWidth ever exceeds the
  // safe-buffer/dpr threshold (e.g. mid-zoom race).
  const { enabled: extendedZoom } = useExtendedZoom();
  const SPECTRO_MAX_BUFFER_PX = 32_000;
  const computeSafeDpr = useCallback((cssWidth: number) => {
    const raw = effectiveDpr(Math.max(1, window.devicePixelRatio || 1), extendedZoom);
    return Math.min(raw, SPECTRO_MAX_BUFFER_PX / Math.max(1, cssWidth));
  }, [extendedZoom]);
  // True while the spectrogram is being soft-clamped (Ultra-zoom past the
  // safe-buffer cap) — surfaces a small spinner overlay so the user has a live
  // cue instead of the browser's broken-image placeholder.
  const [softening, setSoftening] = useState(false);
  const softenTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (softenTimerRef.current != null) window.clearTimeout(softenTimerRef.current);
  }, []);
  const [canvasSize, setCanvasSize] = useState(() => {
    const cssWidth = 900;
    return {
      cssWidth,
      cssHeight: Math.max(1, Math.round(height)),
      dpr: computeSafeDpr(cssWidth),
    };
  });

  useEffect(() => {
    const updateCanvasSize = () => {
      const cssWidth = Math.max(1, Math.round(containerRef.current?.clientWidth ?? 900));
      const cssHeight = Math.max(1, Math.round(height));
      const dpr = computeSafeDpr(cssWidth);

      // Flash the spinner whenever the clamp lowered the dpr below the raw
      // value — i.e., we're past the safe-buffer cap.
      const rawDpr = effectiveDpr(Math.max(1, window.devicePixelRatio || 1), extendedZoom);
      if (dpr < rawDpr - 1e-3) {
        setSoftening(true);
        if (softenTimerRef.current != null) window.clearTimeout(softenTimerRef.current);
        softenTimerRef.current = window.setTimeout(() => setSoftening(false), 250);
      }

      setCanvasSize((prev) => {
        if (prev.cssWidth === cssWidth && prev.cssHeight === cssHeight && prev.dpr === dpr) {
          return prev;
        }
        return { cssWidth, cssHeight, dpr };
      });
    };

    updateCanvasSize();
    const ro = containerRef.current ? new ResizeObserver(updateCanvasSize) : null;
    if (containerRef.current && ro) {
      ro.observe(containerRef.current);
    }
    window.addEventListener('resize', updateCanvasSize);

    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', updateCanvasSize);
    };
  }, [height, computeSafeDpr, extendedZoom]);

  const pixelWidth = Math.max(1, Math.round(canvasSize.cssWidth * canvasSize.dpr));
  const pixelHeight = Math.max(1, Math.round(canvasSize.cssHeight * canvasSize.dpr));

  // Keep overlay params in a ref so the RAF loop always reads fresh values
  const overlayRef = useRef({ sections, duration, beatTimes, bpm, beatOffset, beatsPerBar, barGroupSize, subBeatDivision, beatGroupSize, gridThickness });
  useEffect(() => { overlayRef.current = { sections, duration, beatTimes, bpm, beatOffset, beatsPerBar, barGroupSize, subBeatDivision, beatGroupSize, gridThickness }; });

  // ── Draw one frame onto the canvas ───────────────────────────────────────────
  const drawFrame = useCallback((headTime: number) => {
    const canvas = canvasRef.current;
    const cache  = cacheRef.current;
    if (!canvas || !cache) return;
    const ctx = canvas.getContext('2d')!;
    const { imgData, W, H, dpr, displayNyquist } = cache;
    const { sections: secs, duration: dur, beatTimes: bt, bpm: b, beatOffset: bo, beatsPerBar: bpb, barGroupSize: bgs, subBeatDivision: sbd, beatGroupSize: bgrp, gridThickness: gt } = overlayRef.current;
    ctx.putImageData(imgData, 0, 0);
    drawFreqLabels(ctx, W, H, displayNyquist, dpr);
    drawBeatGrid(ctx, W, H, dur, bt, b, bo, bpb, bgs, sbd, bgrp, dpr, gt);
    drawSectionBands(ctx, W, H, secs, dur, dpr);
    drawPlayhead(ctx, W, H, headTime, dur, dpr);
  }, []);

  // ── Phase 1: FFT → ImageData ─────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (cacheRef.current?.buffer === audioBuffer && cacheRef.current.W === canvas.width && cacheRef.current.H === canvas.height) {
      const ctx = canvas.getContext('2d')!;
      cacheRef.current.imgData = buildSpectrogramImage(
        cacheRef.current.specDb,
        cacheRef.current.melMap,
        cacheRef.current.W,
        cacheRef.current.H,
        cacheRef.current.bins,
        cacheRef.current.minDb,
        cacheRef.current.maxDb,
        gain,
        contrast,
        ctx,
      );
      setSpectroReady(true);
      return;
    }

    setSpectroReady(false);
    let cancelled = false;

    const timer = setTimeout(() => {
      if (cancelled) return;
      const FFT  = 2048, HOP = FFT >> 2, BINS = FFT >> 2;
      const nyq  = audioBuffer.sampleRate / 2;
      const dNyq = (BINS / (FFT / 2)) * nyq;
      const samp = audioBuffer.getChannelData(0);
      const len  = samp.length;
      const nf   = Math.max(1, Math.floor((len - FFT) / HOP));
      const W    = canvas.width, H = canvas.height;
      const mel  = buildMelMap(BINS, H, dNyq);

      const spec = new Float32Array(W * BINS);
      const re = new Float32Array(FFT), im = new Float32Array(FFT);
      let mn = Infinity, mx = -Infinity;

      for (let col = 0; col < W; col++) {
        if (cancelled) return;
        const s0 = Math.min(Math.floor((col / W) * nf), nf - 1) * HOP;
        re.fill(0); im.fill(0);
        for (let i = 0; i < FFT; i++) re[i] = (s0 + i < len ? samp[s0 + i] : 0) * hann(FFT, i);
        fft(re, im);
        for (let b = 0; b < BINS; b++) {
          const db = 20 * Math.log10(Math.max(Math.sqrt(re[b] ** 2 + im[b] ** 2), 1e-8));
          spec[col * BINS + b] = db;
          if (db > mx) mx = db; if (db < mn) mn = db;
        }
      }
      if (cancelled) return;

      const ctx   = canvas.getContext('2d')!;
      const img   = buildSpectrogramImage(spec, mel, W, H, BINS, mn, mx, gain, contrast, ctx);
      if (cancelled) return;
      cacheRef.current = {
        buffer: audioBuffer,
        imgData: img,
        W,
        H,
        dpr: canvasSize.dpr,
        displayNyquist: dNyq,
        specDb: spec,
        melMap: mel,
        bins: BINS,
        minDb: mn,
        maxDb: mx,
      };
      setSpectroReady(true);
    }, 16);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [audioBuffer, gain, contrast, canvasSize.cssWidth, canvasSize.cssHeight, canvasSize.dpr]);

  // ── Phase 2: redraw whenever currentTime or overlays change ─────────────────
  useEffect(() => {
    if (!spectroReady) return;
    drawFrame(currentTime);
  }, [spectroReady, currentTime, sections, duration, beatTimes, bpm, beatOffset, drawFrame]);

  // ── JSX ──────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-1">
      {/* Section label row above spectrogram */}
      {sections.length > 0 && duration > 0 && (
        <div className="relative w-full h-6 select-none">
          {sections.map((s, i) => {
            const left  = (s.time    / duration) * 100;
            const width = ((s.endTime - s.time) / duration) * 100;
            const color = SEC_COLORS[s.type] ?? SEC_COLORS.default;
            return (
              <div
                key={i}
                className="absolute inset-y-0 flex items-center overflow-hidden px-px"
                style={{ left: `${left}%`, width: `${width}%` }}
              >
                <div
                  className="text-[10px] font-bold text-white px-1.5 py-0.5 rounded truncate w-full"
                  style={{ backgroundColor: color + 'cc' }}
                  title={s.label}
                >
                  {s.label}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Spectrogram canvas */}
      {/* min-w-0 prevents the canvas's intrinsic backing-buffer width from
          driving flex-1 wider than its allotted space — without it, the
          canvas locks at a runaway size after zoom-in and drifts out of
          alignment with the player / 3-Band cursors. */}
      <div ref={containerRef} className="relative w-full min-w-0">
        <canvas
          ref={canvasRef}
          width={pixelWidth}
          height={pixelHeight}
          className="rounded bg-gray-900 block w-full"
          style={{ height: `${canvasSize.cssHeight}px` }}
        />
        {!spectroReady && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/70 rounded text-xs text-gray-400 animate-pulse pointer-events-none">
            Computing spectrogram…
          </div>
        )}
        {softening && spectroReady && (
          <div className="absolute top-1 left-1 z-30 pointer-events-none">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <circle cx="7" cy="7" r="5" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="1.5" />
              <path d="M 7 2 A 5 5 0 0 1 12 7" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="1.5" strokeLinecap="round">
                <animateTransform attributeName="transform" type="rotate" from="0 7 7" to="360 7 7" dur="0.9s" repeatCount="indefinite" />
              </path>
            </svg>
          </div>
        )}
        {algoName && spectroReady && (
          <div className="absolute bottom-1 left-1 text-[9px] text-gray-500 bg-gray-900/70 px-1.5 py-0.5 rounded pointer-events-none">
            annotations: {algoName}
          </div>
        )}
      </div>
    </div>
  );
});
