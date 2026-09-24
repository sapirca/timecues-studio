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
 *
 * At high zoom the ruler is as wide as the whole zoomed timeline (ULTRA
 * ceiling × the panel width — six figures of CSS pixels), which is far past
 * the browser's max canvas dimension. A single canvas that size fails to
 * allocate and Chrome paints the element as a blank white box. So the ruler
 * is drawn as a row of fixed-width tiles, and only the tiles near the
 * viewport are mounted: each backing store stays small, every tick and label
 * stays at full devicePixelRatio, and memory does not grow with zoom.
 */

import { useRef, useEffect, useLayoutEffect, useState } from 'react';

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

// One tile's CSS width. 4 000 px is 8 000 device px at dpr 2 — an order of
// magnitude under every browser's max-canvas dimension, and small enough that
// the two or three mounted tiles cost about a megabyte in total.
const TILE_CSS_PX = 4_000;
// A tick sitting just left of a seam draws its label to the right of itself,
// i.e. into the next tile. Each tile therefore also walks the ticks in this
// much space before its own start; their stems land off-canvas (the previous
// tile draws those) but their labels land inside.
const LABEL_OVERDRAW_PX = 240;

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

/** Nearest horizontally scrollable ancestor, or null when there isn't one. */
function findScroller(el: HTMLElement): HTMLElement | null {
  let p = el.parentElement;
  while (p) {
    const ox = getComputedStyle(p).overflowX;
    if (ox === 'auto' || ox === 'scroll') return p;
    p = p.parentElement;
  }
  return null;
}

export function TimeRuler({ duration, height = 22 }: TimeRulerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(readTheme);
  const [cssW, setCssW] = useState(0);
  // Inclusive tile index range to mount. [0, 0] until measured.
  const [tileRange, setTileRange] = useState<[number, number]>([0, 0]);

  // Re-render when the user flips the theme (data-theme attribute mutates).
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(readTheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setCssW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Which tiles overlap the viewport. Recomputed on scroll of the enclosing
  // scroll container (rAF-coalesced) and whenever either box resizes.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || cssW <= 0) return;
    const scroller = findScroller(el);
    const total = Math.max(1, Math.ceil(cssW / TILE_CSS_PX));
    let raf = 0;

    const update = () => {
      raf = 0;
      const c = containerRef.current;
      if (!c) return;
      let lo = 0;
      let hi = total - 1;
      if (scroller) {
        const cr = c.getBoundingClientRect();
        const sr = scroller.getBoundingClientRect();
        const left = Math.max(0, sr.left - cr.left);
        const right = Math.max(left, Math.min(cr.width, sr.right - cr.left));
        lo = Math.max(0, Math.floor(left / TILE_CSS_PX) - 1);
        hi = Math.min(total - 1, Math.floor(right / TILE_CSS_PX) + 1);
      }
      setTileRange((prev) => (prev[0] === lo && prev[1] === hi ? prev : [lo, hi]));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };

    update();
    scroller?.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    if (scroller) ro.observe(scroller);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      scroller?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      ro.disconnect();
    };
  }, [cssW]);

  const bg = theme === 'light' ? '#eef0f3' : '#0b0f1a';
  const tiles: number[] = [];
  if (cssW > 0 && duration > 0) {
    const total = Math.max(1, Math.ceil(cssW / TILE_CSS_PX));
    const lo = Math.min(tileRange[0], total - 1);
    const hi = Math.min(tileRange[1], total - 1);
    for (let i = lo; i <= hi; i++) tiles.push(i);
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: '100%',
        height,
        lineHeight: 0,
        flexShrink: 0,
        backgroundColor: bg,
      }}
    >
      {tiles.map((i) => (
        <RulerTile
          key={i}
          duration={duration}
          totalW={cssW}
          tileStart={i * TILE_CSS_PX}
          tileW={Math.min(TILE_CSS_PX, cssW - i * TILE_CSS_PX)}
          height={height}
          isLight={theme === 'light'}
        />
      ))}
    </div>
  );
}

interface RulerTileProps {
  duration: number;
  /** Full ruler width in CSS px — the time↔pixel mapping is global. */
  totalW: number;
  tileStart: number;
  tileW: number;
  height: number;
  isLight: boolean;
}

function RulerTile({ duration, totalW, tileStart, tileW, height, isLight }: RulerTileProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || tileW <= 0 || totalW <= 0 || duration <= 0) return;

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const W = Math.round(tileW * dpr);
    const H = Math.round(height * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }

    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = isLight ? '#eef0f3' : '#0b0f1a';
    ctx.fillRect(0, 0, W, H);

    const pxPerSec = totalW / duration;
    const { major, minor } = pickInterval(pxPerSec);
    // Time → x inside THIS tile, in device px.
    const xOf = (t: number) => Math.round((t * pxPerSec - tileStart) * dpr);
    const tFrom = Math.max(0, (tileStart - LABEL_OVERDRAW_PX) / pxPerSec);
    const tTo = Math.min(duration, (tileStart + tileW) / pxPerSec);

    // ── Bottom border ──────────────────────────────────────────────────────────
    ctx.strokeStyle = isLight ? 'rgba(15,23,42,0.18)' : 'rgba(75,85,99,0.55)';
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(0, H - 1);
    ctx.lineTo(W, H - 1);
    ctx.stroke();

    // ── Minor ticks ────────────────────────────────────────────────────────────
    const minorTickColor = isLight ? 'rgba(15,23,42,0.18)' : 'rgba(75,85,99,0.45)';
    ctx.strokeStyle = minorTickColor;
    ctx.lineWidth = 0.5 * dpr;
    for (let i = Math.floor(tFrom / minor); i * minor <= tTo + minor * 0.001; i++) {
      const t = i * minor;
      if (t > duration + minor * 0.001) break;
      const x = xOf(Math.min(t, duration));
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
    for (let i = Math.floor(tFrom / major); i * major <= tTo + major * 0.001; i++) {
      const t = i * major;
      if (t > duration + major * 0.001) break;
      const tClamped = Math.min(t, duration);
      const x = xOf(tClamped);

      // Full-height tick
      ctx.strokeStyle = majorTickColor;
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H - 1);
      ctx.stroke();

      // Label — offset right of tick, clipped at the ruler's right edge (the
      // whole ruler's, not this tile's: a label may legitimately cross a seam).
      const label = formatLabel(tClamped, major);
      const labelW = ctx.measureText(label).width;
      const globalRight = (tClamped * pxPerSec) * dpr + labelW + 3 * dpr;
      if (globalRight <= totalW * dpr || tClamped === 0) {
        ctx.fillStyle = labelColor;
        ctx.fillText(label, x + 2.5 * dpr, 2 * dpr);
      }
    }
  }, [duration, totalW, tileStart, tileW, height, isLight]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        top: 0,
        left: tileStart,
        display: 'block',
        width: tileW,
        height,
      }}
    />
  );
}
