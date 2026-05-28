/**
 * TimeRuler
 *
 * A canvas-based timeline ruler with millisecond precision.
 * Renders tick marks and time labels at intelligently chosen intervals
 * based on the available pixel width and track duration.
 *
 * Uses a ResizeObserver so it adapts automatically to any container width —
 * works both inside a fixed-width zoomed inner div (player section) and
 * inside a flex/scroll container (viz section).
 */

import { useRef, useEffect, useCallback, useState } from 'react';

interface TimeRulerProps {
  /** Total track duration in seconds */
  duration: number;
  /** Height of the ruler in CSS pixels */
  height?: number;
}

// Candidate major-tick intervals in seconds
const INTERVALS_SEC = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5,
  1, 2, 5, 10, 15, 30, 60, 120, 300,
];

/** Pick the smallest interval where major ticks are >= minPxBetween apart. */
function pickInterval(pxPerSec: number, minPxBetween = 72): { major: number; minor: number } {
  for (let i = 0; i < INTERVALS_SEC.length; i++) {
    const major = INTERVALS_SEC[i];
    if (major * pxPerSec >= minPxBetween) {
      // minor tick: two steps smaller (or 1/5 of major)
      const minorIdx = Math.max(0, i - 2);
      const minor = INTERVALS_SEC[minorIdx];
      return { major, minor: minor < major ? minor : major / 5 };
    }
  }
  const major = INTERVALS_SEC[INTERVALS_SEC.length - 1];
  return { major, minor: INTERVALS_SEC[INTERVALS_SEC.length - 3] };
}

/** Format a time value as a label for a given major interval. */
function formatLabel(t: number, major: number): string {
  // Snap to nearest ms to avoid floating-point drift
  const totalMs = Math.round(t * 1000);
  const m = Math.floor(totalMs / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;

  if (major < 1) {
    // Show milliseconds
    return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Read the current theme from <html data-theme>. */
function readTheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function TimeRuler({ duration, height = 22 }: TimeRulerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(readTheme);

  // Re-render when the user flips the theme (data-theme attribute mutates).
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(readTheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || duration <= 0) return;

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cssW = container.clientWidth;
    const cssH = height;
    if (cssW <= 0) return;

    const W = Math.round(cssW * dpr);
    const H = Math.round(cssH * dpr);

    // Only resize backing store when needed (avoids redundant clears)
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }

    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);

    const isLight = theme === 'light';

    // Background
    ctx.fillStyle = isLight ? '#eef0f3' : '#0b0f1a';
    ctx.fillRect(0, 0, W, H);

    const pxPerSec = cssW / duration;
    const { major, minor } = pickInterval(pxPerSec);

    // ── Bottom border ──────────────────────────────────────────────────────────
    ctx.strokeStyle = isLight ? 'rgba(15,23,42,0.18)' : 'rgba(75,85,99,0.55)';
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(0, H - 1);
    ctx.lineTo(W, H - 1);
    ctx.stroke();

    // ── Minor ticks ────────────────────────────────────────────────────────────
    const minorTickColor = isLight ? 'rgba(15,23,42,0.18)' : 'rgba(75,85,99,0.45)';
    const minorSteps = Math.ceil(duration / minor) + 1;
    for (let i = 0; i <= minorSteps; i++) {
      const t = i * minor;
      if (t > duration + minor * 0.001) break;
      const x = Math.round((Math.min(t, duration) / duration) * W);
      ctx.strokeStyle = minorTickColor;
      ctx.lineWidth = 0.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(x, H - 5 * dpr);
      ctx.lineTo(x, H - 1);
      ctx.stroke();
    }

    // ── Major ticks + labels ───────────────────────────────────────────────────
    const fontSize = Math.round(8.5 * dpr);
    ctx.font = `${fontSize}px ui-monospace,monospace`;
    ctx.textBaseline = 'top';

    const majorTickColor = isLight ? 'rgba(15,23,42,0.32)' : 'rgba(100,116,139,0.75)';
    const labelColor     = isLight ? 'rgba(15,23,42,0.72)' : 'rgba(148,163,184,0.92)';
    const majorSteps = Math.ceil(duration / major) + 1;
    for (let i = 0; i <= majorSteps; i++) {
      const t = i * major;
      if (t > duration + major * 0.001) break;
      const tClamped = Math.min(t, duration);
      const x = Math.round((tClamped / duration) * W);

      // Full-height tick
      ctx.strokeStyle = majorTickColor;
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H - 1);
      ctx.stroke();

      // Label — offset right of tick, clipped at right edge
      const label = formatLabel(tClamped, major);
      const labelW = ctx.measureText(label).width;
      if (x + labelW + 3 * dpr <= W || i === 0) {
        ctx.fillStyle = labelColor;
        ctx.fillText(label, x + 2.5 * dpr, 2 * dpr);
      }
    }
  }, [duration, height, theme]);

  // Initial draw + redraw on resize
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(container);
    return () => ro.disconnect();
  }, [draw]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height,
        lineHeight: 0,
        flexShrink: 0,
        backgroundColor: theme === 'light' ? '#eef0f3' : '#0b0f1a',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height }}
      />
    </div>
  );
}
