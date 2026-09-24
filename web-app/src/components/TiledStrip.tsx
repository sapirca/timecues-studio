/**
 * TiledStrip
 *
 * A canvas strip as wide as the zoomed timeline — hundreds of thousands of CSS
 * pixels at high zoom — drawn as a row of fixed-width tiles, with only the
 * tiles near the viewport mounted.
 *
 * Every full-width visualization in the inspector used to be one canvas whose
 * backing store was `cssWidth × devicePixelRatio`. Past the browser's max
 * canvas dimension (Chrome 65 535 px; less elsewhere) that canvas fails to
 * allocate and paints as a blank white box, so each of them clamped its own
 * pixel ratio to keep the buffer at 32 000 px — which means that past roughly
 * ×50 the picture is a 32 000-px bitmap stretched across the full width, and
 * the further you zoom the blurrier it gets. Tiling removes the ceiling
 * instead of degrading under it: each tile is a small buffer at full dpr, so
 * the strip is pixel-sharp at any zoom and costs the same memory at ×1 as at
 * ×1024.
 *
 * Each tile is two stacked canvases:
 *   • base    — the expensive per-pixel paint (spectrogram slice, chroma
 *               slice, waveform envelope). Repainted only when the geometry,
 *               the data, or the `paint` callback changes.
 *   • overlay — cheap lines redrawn on every playhead tick (beat grid,
 *               playhead, axis labels). Kept separate so a moving playhead
 *               never re-runs the per-pixel paint underneath it.
 *
 * `paint` and `overlay` receive the tile's own geometry plus the strip total,
 * so callers position everything in GLOBAL strip coordinates and let the tile
 * clip: `ctx.translate(-tile.x0 * dpr, 0)` once, then draw as if the canvas
 * were the whole strip.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface TileGeom {
  /** Tile's left edge in CSS px from the strip's left edge. */
  x0: number;
  /** Tile width in CSS px. */
  w: number;
  /** The whole strip's width in CSS px — the denominator for time↔x math. */
  totalW: number;
  /** Strip height in CSS px. */
  h: number;
  /** Device pixel ratio the tile's buffers use (never clamped down). */
  dpr: number;
}

interface Props {
  height: number;
  /** Per-pixel paint of this tile's slice. Runs off the main render path. */
  paint: (ctx: CanvasRenderingContext2D, tile: TileGeom) => void;
  /** Lines redrawn on every tick, on a transparent canvas above `paint`.
   *  `focusX` is `overlayFocus` resolved to CSS px from the strip's left edge —
   *  draw the playhead there rather than closing over the current time, or
   *  this callback's identity changes every frame and every mounted tile
   *  repaints instead of the one or two the playhead touches. */
  overlay?: (ctx: CanvasRenderingContext2D, tile: TileGeom, focusX: number | null) => void;
  /** The overlay's moving part as a fraction of the strip (currentTime /
   *  duration). Only the tiles it touches repaint as it moves. */
  overlayFocus?: number | null;
  /** Override the tile width in CSS px. Rows whose paint is expensive per
   *  column (the spectrogram runs an FFT for each one) want narrower tiles so
   *  a tile scrolling into view costs less. */
  tileWidth?: number;
  className?: string;
  style?: React.CSSProperties;
  /** Painted before the first tile finishes, e.g. "Computing spectrogram…". */
  children?: React.ReactNode;
}

// A tile is sized to the viewport it will be seen through, not to some fixed
// width: tiles much wider than the viewport allocate backing store nobody can
// see (a 4 096-px tile serving a 644-px viewport wasted 6× its own memory and
// made every tile that scrolled in six times more expensive to paint), and
// tiles much narrower churn through repaints. Clamped so a tiny pane still
// gets a sensible tile and a very wide one stays under a manageable buffer.
const MIN_TILE_CSS = 512;
const MAX_TILE_CSS = 4_096;
// Mount tiles overlapping the viewport plus half a tile either side, so
// scrolling has something ready without keeping a whole extra tile per side
// resident.
const MOUNT_MARGIN_FRACTION = 0.5;

// ── Paint scheduler ─────────────────────────────────────────────────────────
// Every tile used to paint in its own setTimeout(0), so a pan that brought a
// new tile into view for each of seven rows ran all seven per-pixel paints
// back to back in one task: measured 200 ms+ of frozen UI per pan step. The
// queue drains inside an animation frame under a time budget instead, so the
// rows fill in over the next few frames and the pan, the playhead and the
// cursor keep moving. A single tile can still overrun the budget (a
// spectrogram tile is an FFT per column) — the budget stops the NEXT tile from
// starting in the same frame, which is what bounds the stall.
const PAINT_BUDGET_MS = 8;
const paintQueue: Array<() => void> = [];
let draining = false;

function drainPaintQueue() {
  const start = performance.now();
  while (paintQueue.length > 0 && performance.now() - start < PAINT_BUDGET_MS) {
    const job = paintQueue.shift();
    try { job?.(); } catch { /* one bad tile must not wedge the queue */ }
  }
  if (paintQueue.length > 0) requestAnimationFrame(drainPaintQueue);
  else draining = false;
}

/** Queue a tile paint; returns a cancel for tiles that unmount before their turn. */
function schedulePaint(job: () => void): () => void {
  paintQueue.push(job);
  if (!draining) {
    draining = true;
    requestAnimationFrame(drainPaintQueue);
  }
  return () => {
    const i = paintQueue.indexOf(job);
    if (i >= 0) paintQueue.splice(i, 1);
  };
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

function tileCssWidth(viewportW: number): number {
  return Math.max(MIN_TILE_CSS, Math.min(MAX_TILE_CSS, Math.round(viewportW)));
}

export function TiledStrip({
  height,
  paint,
  overlay,
  overlayFocus = null,
  tileWidth,
  className,
  style,
  children,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [cssW, setCssW] = useState(0);
  const [viewW, setViewW] = useState(0);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const dpr = Math.max(1, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
  const tileW = useMemo(
    () => (tileWidth && tileWidth > 0 ? tileWidth : tileCssWidth(viewW || cssW)),
    [tileWidth, viewW, cssW],
  );

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setCssW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Which tiles overlap the viewport, recomputed on scroll (rAF-coalesced).
  useEffect(() => {
    const el = containerRef.current;
    if (!el || cssW <= 0) return;
    const scroller = findScroller(el);
    const total = Math.max(1, Math.ceil(cssW / tileW));
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
        setViewW((prev) => (Math.abs(prev - sr.width) < 1 ? prev : sr.width));
        const left = Math.max(0, sr.left - cr.left);
        const right = Math.max(left, Math.min(cr.width, sr.right - cr.left));
        const margin = tileW * MOUNT_MARGIN_FRACTION;
        lo = Math.max(0, Math.floor((left - margin) / tileW));
        hi = Math.min(total - 1, Math.floor((right + margin) / tileW));
      }
      setRange((prev) => (prev[0] === lo && prev[1] === hi ? prev : [lo, hi]));
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
  }, [cssW, tileW]);

  const tiles: number[] = [];
  if (cssW > 0 && height > 0) {
    const total = Math.max(1, Math.ceil(cssW / tileW));
    for (let i = Math.min(range[0], total - 1); i <= Math.min(range[1], total - 1); i++) tiles.push(i);
  }

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ position: 'relative', width: '100%', height, ...style }}
    >
      {tiles.map((i) => {
        const x0 = i * tileW;
        return (
          <StripTile
            key={i}
            geom={{ x0, w: Math.min(tileW, cssW - x0), totalW: cssW, h: height, dpr }}
            paint={paint}
            overlay={overlay}
            focusX={overlayFocus == null ? null : overlayFocus * cssW}
          />
        );
      })}
      {children}
    </div>
  );
}

interface TileProps {
  geom: TileGeom;
  paint: (ctx: CanvasRenderingContext2D, tile: TileGeom) => void;
  overlay?: (ctx: CanvasRenderingContext2D, tile: TileGeom, focusX: number | null) => void;
  focusX: number | null;
}

function StripTile({ geom, paint, overlay, focusX }: TileProps) {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const { x0, w, totalW, h, dpr } = geom;
  const pxW = Math.max(1, Math.round(w * dpr));
  const pxH = Math.max(1, Math.round(h * dpr));

  // Base: the expensive slice, run through the shared budgeted queue so a pan
  // that brings in a tile for every row doesn't paint them all in one frame.
  useEffect(() => {
    const canvas = baseRef.current;
    if (!canvas) return;
    return schedulePaint(() => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, pxW, pxH);
      paint(ctx, { x0, w, totalW, h, dpr });
    });
  }, [paint, x0, w, totalW, h, dpr, pxW, pxH]);

  // Overlay. Two triggers, deliberately separate: anything structural (the
  // callback's own identity, i.e. grid or labels changed; or the tile moved)
  // redraws this tile, while a moving playhead redraws only the tile it is on
  // and the one it just left. Everyone else keeps the overlay they have —
  // clearing them would wipe their beat grid.
  // Latest overlay callback and focus, published from an effect so the
  // focus-driven effect below can call the current one without listing it as a
  // dependency — depending on it directly would redraw every tile on every
  // tick, which is exactly what the split is here to avoid. Declared first so
  // it has already run by the time either draw effect fires in this commit.
  const latestRef = useRef({ overlay, focusX });
  useEffect(() => { latestRef.current = { overlay, focusX }; });

  const drawOverlay = useCallback(() => {
    const canvas = overlayRef.current;
    const { overlay: fn, focusX: fx } = latestRef.current;
    if (!canvas || !fn) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pxW, pxH);
    fn(ctx, { x0, w, totalW, h, dpr }, fx);
  }, [x0, w, totalW, h, dpr, pxW, pxH]);

  // Structural: the grid, labels or geometry changed — this tile redraws.
  useEffect(() => { drawOverlay(); }, [overlay, drawOverlay]);

  // The playhead moved: only the tile it is on, and the one it just left.
  const wasFocusedRef = useRef(false);
  useEffect(() => {
    const focused = focusX != null && focusX >= x0 - 24 && focusX <= x0 + w + 24;
    if (focused || wasFocusedRef.current) drawOverlay();
    wasFocusedRef.current = focused;
  }, [focusX, x0, w, drawOverlay]);

  // Hand the backing stores back at unmount instead of waiting for GC: at high
  // zoom tiles are mounted and dropped continuously while panning, and a tile's
  // two buffers are megabytes each.
  useEffect(() => () => {
    for (const c of [baseRef.current, overlayRef.current]) {
      if (!c) continue;
      c.width = 0;
      c.height = 0;
    }
  }, []);

  const shared: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: x0,
    display: 'block',
    width: w,
    height: h,
  };

  return (
    <>
      <canvas ref={baseRef} width={pxW} height={pxH} style={shared} />
      {overlay && (
        <canvas
          ref={overlayRef}
          width={pxW}
          height={pxH}
          style={{ ...shared, pointerEvents: 'none' }}
        />
      )}
    </>
  );
}
