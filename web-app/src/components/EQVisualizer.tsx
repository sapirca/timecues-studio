import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MirCurves } from './inspector-v2/SharedVizPanel';
import { BeatGridOverlay } from './inspector-v2/BeatGridOverlay';
import { getBandColors, type BandColors } from '../utils/bandPalettes';
import { useSettings } from '../context/SettingsContext';
import { useExtendedZoom, effectiveDpr } from '../hooks/useExtendedZoom';

interface GridProps {
  bpm?: number;
  gridOffset?: number;
  beatsPerBar?: number;
  barGroupSize?: number | null;
  anchors?: readonly import('../types/songInfo').TempoAnchor[];
  thickness?: number;
}

interface Props {
  mirCurves: MirCurves | null;
  loading?: boolean;
  duration: number;
  currentTime: number;
  height?: number;
  onSeek?: (time: number) => void;
  gridProps?: GridProps;
}

const BAND_IDS: Array<{ id: 'low' | 'mid' | 'high'; label: string }> = [
  { id: 'low',  label: 'Low'  }, // < 250 Hz
  { id: 'mid',  label: 'Mid'  }, // 250 Hz – 4 kHz
  { id: 'high', label: 'High' }, // > 4 kHz
];

function getBand(curves: MirCurves, id: 'low' | 'mid' | 'high'): number[] | undefined {
  if (id === 'low')  return curves.lowBand;
  if (id === 'mid')  return curves.midBand;
  return curves.highBand;
}

function isLightTheme(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'light';
}

// Convert "rgba(r, g, b, a)" or "rgb(r, g, b)" → opaque "rgb(r, g, b)" for stroke edges.
function toOpaque(rgba: string): string {
  const m = rgba.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!m) return rgba;
  return `rgb(${m[1]}, ${m[2]}, ${m[3]})`;
}

function drawLanes(
  ctx: CanvasRenderingContext2D,
  cssW: number,
  cssH: number,
  dpr: number,
  curves: MirCurves,
  colors: BandColors,
) {
  const W = cssW * dpr;
  const H = cssH * dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);

  ctx.fillStyle = '#020617';
  ctx.fillRect(0, 0, W, H);

  const laneH = H / BAND_IDS.length;
  const padPx = Math.max(1, Math.round(2 * dpr));

  for (let b = 0; b < BAND_IDS.length; b++) {
    const band = BAND_IDS[b];
    const fill = colors[band.id];
    const stroke = toOpaque(fill);
    const data = getBand(curves, band.id);
    const yTop = b * laneH;
    const yBot = yTop + laneH;

    if (b > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(0, yTop, W, Math.max(1, dpr));
    }

    if (data && data.length > 1) {
      const usableH = laneH - padPx * 2;
      const baseline = yBot - padPx;

      ctx.beginPath();
      ctx.moveTo(0, baseline);
      for (let x = 0; x < W; x++) {
        const i = Math.floor((x / W) * (data.length - 1));
        const v = Math.max(0, Math.min(1, data[i] ?? 0));
        ctx.lineTo(x, baseline - v * usableH);
      }
      ctx.lineTo(W, baseline);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();

      ctx.beginPath();
      for (let x = 0; x < W; x++) {
        const i = Math.floor((x / W) * (data.length - 1));
        const v = Math.max(0, Math.min(1, data[i] ?? 0));
        const y = baseline - v * usableH;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(1, dpr);
      ctx.stroke();
    }

    ctx.font = `${Math.round(10 * dpr)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, yTop, Math.round(36 * dpr), Math.round(14 * dpr));
    ctx.fillStyle = stroke;
    ctx.fillText(band.label, Math.round(6 * dpr), yTop + Math.round(2 * dpr));
  }
}

export default function EQVisualizer({ mirCurves, loading = false, duration, currentTime, height = 54, onSeek, gridProps }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [cssW, setCssW] = useState(0);
  const [theme, setTheme] = useState<'light' | 'dark'>(isLightTheme() ? 'light' : 'dark');
  const { settings } = useSettings();
  const colors = getBandColors(settings.bandPalette, theme);
  // Mirrors the spectrogram/chromagram/cepstrogram self-clamp: when the
  // container width grows past the browser's max-canvas buffer, drop the
  // internal pixel ratio so the canvas keeps painting (resolution degrades
  // proportionally; without this clamp the 3-Band would go blank at ultra
  // zoom). See [[project_ultra_zoom]] / ExtendedZoomDialog for context.
  const { enabled: extendedZoom } = useExtendedZoom();

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setCssW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(isLightTheme() ? 'light' : 'dark'));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || cssW <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const EQ_MAX_BUFFER_PX = 32_000;
    const rawDpr = effectiveDpr(Math.max(1, window.devicePixelRatio || 1), extendedZoom);
    const dpr = Math.min(rawDpr, EQ_MAX_BUFFER_PX / Math.max(1, cssW));
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${height}px`;
    if (mirCurves) drawLanes(ctx, cssW, height, dpr, mirCurves, colors);
    else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#020617';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }, [cssW, height, mirCurves, colors, extendedZoom]);

  const hasData = !!(mirCurves && (mirCurves.lowBand?.length || mirCurves.midBand?.length || mirCurves.highBand?.length));
  const pct = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onSeek || duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek(((e.clientX - rect.left) / rect.width) * duration);
  };

  return (
    <div
      ref={containerRef}
      className={`relative w-full bg-gray-950 rounded overflow-hidden ${onSeek ? 'cursor-pointer' : ''}`}
      style={{ height }}
      onClick={handleClick}
    >
      <canvas ref={canvasRef} className="block w-full h-full" />
      {!hasData && loading && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-[11px] text-gray-500 pointer-events-none">
          <svg className="animate-spin h-3.5 w-3.5 text-gray-400" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
            <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
          </svg>
          Computing 3-band analysis…
        </div>
      )}
      {!hasData && !loading && (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-gray-600 pointer-events-none">
          No 3-band analysis
        </div>
      )}
      {gridProps && duration > 0 && (
        <BeatGridOverlay
          bpm={gridProps.bpm}
          gridOffset={gridProps.gridOffset}
          beatsPerBar={gridProps.beatsPerBar}
          barGroupSize={gridProps.barGroupSize}
          anchors={gridProps.anchors}
          thickness={gridProps.thickness}
          duration={duration}
        />
      )}
      {duration > 0 && (
        <div
          className="absolute top-0 bottom-0 w-px pointer-events-none"
          style={{ left: `${pct}%`, background: 'rgba(255,255,255,0.75)', boxShadow: '0 0 3px rgba(255,255,255,0.5)' }}
        />
      )}
    </div>
  );
}
