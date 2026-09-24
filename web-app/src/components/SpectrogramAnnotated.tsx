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
import { drawBeatGrid } from '../utils/gridLineStyle';
import { TiledStrip, type TileGeom } from './TiledStrip';

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

  useImperativeHandle(ref, () => ({
    // The row is a strip of tiles now, so there is no single canvas to export.
    // Composite whatever is mounted into one image — at fit zoom that is the
    // whole row, which is what every caller of this ever wanted.
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

  const FFT = 2048;
  const BINS = FFT >> 2;

  // A coarse pass over the whole track for the dB range and the display
  // Nyquist. Every tile normalizes against THIS, not against its own slice —
  // per-tile min/max would make each tile's brightness depend on what happens
  // to be in it, and the seams would show as steps in contrast.
  const [analysis, setAnalysis] = useState<{ mn: number; mx: number; dNyq: number } | null>(null);
  useEffect(() => {
    if (!audioBuffer) { setAnalysis(null); return; }
    setAnalysis(null);
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      const trackDuration = duration > 0 ? duration : audioBuffer.duration;
      const nyq = audioBuffer.sampleRate / 2;
      const dNyq = (BINS / (FFT / 2)) * nyq;
      const samp = audioBuffer.getChannelData(0);
      const len = samp.length;
      const probes = 1024;
      const re = new Float32Array(FFT), im = new Float32Array(FFT);
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < probes; i++) {
        const centreSample = Math.round((i / probes) * trackDuration * audioBuffer.sampleRate);
        const s0 = Math.max(0, Math.min(len - FFT, centreSample - (FFT >> 1)));
        re.fill(0); im.fill(0);
        for (let k = 0; k < FFT; k++) re[k] = (s0 + k < len ? samp[s0 + k] : 0) * hann(FFT, k);
        fft(re, im);
        for (let b = 0; b < BINS; b++) {
          const db = 20 * Math.log10(Math.max(Math.sqrt(re[b] ** 2 + im[b] ** 2), 1e-8));
          if (db > mx) mx = db;
          if (db < mn) mn = db;
        }
      }
      if (cancelled) return;
      setAnalysis({ mn, mx, dNyq });
    }, 16);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [audioBuffer, duration, BINS, FFT]);

  const melMapRef = useRef<{ h: number; dNyq: number; map: ReturnType<typeof buildMelMap> } | null>(null);

  // One tile's slice: an FFT per column of THIS tile, centred on the time that
  // column represents. Zooming in therefore buys real analysis resolution —
  // more columns over less time — instead of stretching a fixed-size bitmap,
  // and it costs less than the old full-width pass because only the columns
  // near the viewport are ever computed.
  const paint = useCallback((ctx: CanvasRenderingContext2D, tile: TileGeom) => {
    if (!audioBuffer || !analysis) return;
    const totalPx = Math.max(1, Math.round(tile.totalW * tile.dpr));
    const H = Math.max(1, Math.round(tile.h * tile.dpr));
    const colOffset = Math.round(tile.x0 * tile.dpr);
    const colCount = Math.max(1, Math.round(tile.w * tile.dpr));
    const trackDuration = duration > 0 ? duration : audioBuffer.duration;
    const samp = audioBuffer.getChannelData(0);
    const len = samp.length;

    if (!melMapRef.current || melMapRef.current.h !== H || melMapRef.current.dNyq !== analysis.dNyq) {
      melMapRef.current = { h: H, dNyq: analysis.dNyq, map: buildMelMap(BINS, H, analysis.dNyq) };
    }
    const mel = melMapRef.current.map;

    const spec = new Float32Array(colCount * BINS);
    const re = new Float32Array(FFT), im = new Float32Array(FFT);
    const secPerCol = totalPx > 0 ? trackDuration / totalPx : 0;
    for (let col = 0; col < colCount; col++) {
      const centreSample = Math.round((colOffset + col) * secPerCol * audioBuffer.sampleRate);
      const s0 = Math.max(0, Math.min(len - FFT, centreSample - (FFT >> 1)));
      re.fill(0); im.fill(0);
      for (let i = 0; i < FFT; i++) re[i] = (s0 + i < len ? samp[s0 + i] : 0) * hann(FFT, i);
      fft(re, im);
      for (let b = 0; b < BINS; b++) {
        spec[col * BINS + b] = 20 * Math.log10(Math.max(Math.sqrt(re[b] ** 2 + im[b] ** 2), 1e-8));
      }
    }
    const img = buildSpectrogramImage(spec, mel, colCount, H, BINS, analysis.mn, analysis.mx, gain, contrast, ctx);
    ctx.putImageData(img, 0, 0);
  }, [audioBuffer, analysis, duration, gain, contrast, BINS, FFT]);

  const overlay = useCallback((ctx: CanvasRenderingContext2D, tile: TileGeom, focusX: number | null) => {
    const totalPx = Math.max(1, Math.round(tile.totalW * tile.dpr));
    const H = Math.max(1, Math.round(tile.h * tile.dpr));
    ctx.save();
    ctx.translate(-Math.round(tile.x0 * tile.dpr), 0);
    if (analysis) drawFreqLabels(ctx, totalPx, H, analysis.dNyq, tile.dpr);
    drawBeatGrid(ctx, {
      W: totalPx, H, dpr: tile.dpr, thickness: gridThickness,
      duration, beatTimes, bpm, beatOffset, beatsPerBar,
      barGroupSize, subBeatDivision, beatGroupSize,
    });
    drawSectionBands(ctx, totalPx, H, sections, duration, tile.dpr);
    if (focusX != null) drawPlayhead(ctx, totalPx, H, focusX, tile.totalW, tile.dpr);
    ctx.restore();
  }, [analysis, gridThickness, duration, beatTimes, bpm, beatOffset, beatsPerBar,
      barGroupSize, subBeatDivision, beatGroupSize, sections]);

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
        <TiledStrip
          height={Math.max(1, Math.round(height))}
          paint={paint}
          overlay={overlay}
          overlayFocus={duration > 0 ? currentTime / duration : null}
          className="rounded bg-gray-900 w-full min-w-0 overflow-hidden"
        >
          {!analysis && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-900/70 rounded text-xs text-gray-400 animate-pulse pointer-events-none">
              Computing spectrogram…
            </div>
          )}
          {algoName && analysis && (
            <div className="absolute bottom-1 left-1 text-[9px] text-gray-500 bg-gray-900/70 px-1.5 py-0.5 rounded pointer-events-none">
              annotations: {algoName}
            </div>
          )}
        </TiledStrip>
      </div>
    </div>
  );
});
