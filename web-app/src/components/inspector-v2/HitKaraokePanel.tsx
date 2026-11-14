/**
 * HitKaraokePanel — hits and notes you can watch along with the audio.
 *
 * The cue lane draws every hit as a tick on one long timeline, which is right
 * for editing and useless for the question "does this land where I hear it?".
 * Here the next few seconds scroll towards a "now" line, one row per voice:
 *
 *  - a HIT row (kick ●, snare ■, hat ▲) — ticks run into the row's shape on
 *    the now line, and the shape lights as bright as the hit was struck;
 *  - a NOTE row (anything with a pitch — a bass line) — a small piano roll,
 *    height = pitch, length = how long the note rang; the sounding note glows
 *    and its name is written at the line.
 *
 * Several layers can be stacked — drum hits over the bass notes, say — with
 * the chips in the header. The focused layer is always in.
 *
 * `Offset` shifts everything against the audio. If every hit feels early or
 * late by the same amount, the value that fixes it is the detector's timing
 * error — it moves nothing on disk.
 *
 * All of it is one canvas painted from `usePlayheadEffect`, so playback never
 * re-renders the panel, and every row has a fixed pixel height — the panel's
 * size is decided here, not by the width of the column it lands in. It paints
 * from a smoothed clock (utils/smoothClock): the media clock moves in audio-
 * buffer steps, and at this panel's magnification those steps made every tick
 * jump by ~5 px a frame.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePaintClock, usePlayheadClock, usePlayheadEffect } from '../../hooks/usePlayhead';
import type { KaraokeHitRow, KaraokeNoteRow, KaraokeRow } from '../../utils/karaokeRows';
import { midiNoteName } from '../../utils/drumHits';
import { createClockSmoother } from '../../utils/smoothClock';

export interface KaraokeSource {
  id: string;
  name: string;
  color: string;
  rows: KaraokeRow[];
}

interface HitKaraokePanelProps {
  /** Every layer / lane that has something to light, the focused one included. */
  sources: readonly KaraokeSource[];
  /** The layer the user clicked — always shown. */
  focusedId: string;
  onSeek?: (time: number) => void;
}

const HIT_ROW_PX = 24;
const NOTE_ROW_PX = 64;
const LABEL_PX = 64;
/** Seconds of lane shown behind and ahead of the playhead. */
const PAST = 1;
const AHEAD = 3;
const OFFSET_KEY = 'hitKaraoke.offsetMs';

function readOffset(): number {
  try {
    const v = Number(localStorage.getItem(OFFSET_KEY));
    return Number.isFinite(v) ? v : 0;
  } catch { return 0; }
}

/** Index of the last item starting at or before `t`, or -1. */
function lastAt<T extends { time: number }>(xs: readonly T[], t: number): number {
  let lo = 0, hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m].time <= t) lo = m + 1; else hi = m;
  }
  return lo - 1;
}

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

function fitText(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && g.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s}…`;
}

function tracePath(g: CanvasRenderingContext2D, shape: KaraokeHitRow['shape'], cx: number, cy: number, s: number) {
  g.beginPath();
  if (shape === 'circle') g.arc(cx, cy, s * 0.44, 0, Math.PI * 2);
  else if (shape === 'square') { const r = s * 0.4; g.rect(cx - r, cy - r, 2 * r, 2 * r); }
  else { g.moveTo(cx, cy - s * 0.44); g.lineTo(cx + s * 0.46, cy + s * 0.38); g.lineTo(cx - s * 0.46, cy + s * 0.38); g.closePath(); }
}

function drawHitRow(g: CanvasRenderingContext2D, row: KaraokeHitRow, t: number, y0: number, h: number, nowX: number, pxPerS: number) {
  const cy = y0 + h / 2;
  const hs = row.hits;
  for (let i = Math.max(0, lastAt(hs, t - PAST)); i < hs.length && hs[i].time <= t + AHEAD; i++) {
    const x = nowX + (hs[i].time - t) * pxPerS;
    if (x < LABEL_PX || Math.abs(x - nowX) < h * 0.5) continue; // under the light
    const v = hs[i].velocity / 127;
    const th = (h - 6) * (0.3 + 0.7 * v);
    g.fillStyle = rgba(row.color, hs[i].time > t ? 0.3 + 0.6 * v : 0.16);
    g.fillRect(x - 1.5, cy - th / 2, 3, th);
  }
  const k = lastAt(hs, t);
  const on = k >= 0 ? (hs[k].velocity / 127) * Math.exp(-(t - hs[k].time) / row.fade) : 0;
  g.save();
  g.shadowColor = rgba(row.color, on);
  g.shadowBlur = on > 0.05 ? 3 + 14 * on : 0;
  tracePath(g, row.shape, nowX, cy, h - 4);
  g.fillStyle = rgba(row.color, 0.08 + 0.92 * on);
  g.fill();
  g.lineWidth = 1.2;
  g.strokeStyle = rgba(row.color, 0.4 + 0.6 * on);
  g.stroke();
  g.restore();
}

function drawNoteRow(g: CanvasRenderingContext2D, row: KaraokeNoteRow, t: number, y0: number, h: number, nowX: number, pxPerS: number, W: number) {
  const pad = 6;
  const lo = row.lo - 1, hi = row.hi + 1;
  const yOf = (m: number) => y0 + pad + (1 - (m - lo) / (hi - lo)) * (h - 2 * pad);
  // An octave guide at every C, so a jump reads as a jump.
  g.font = '9px ui-monospace, monospace';
  for (let m = Math.ceil(lo / 12) * 12; m <= hi; m += 12) {
    g.fillStyle = rgba(row.color, 0.08);
    g.fillRect(LABEL_PX, yOf(m) - 0.5, W - LABEL_PX, 1);
    g.fillStyle = rgba(row.color, 0.45);
    g.fillText(midiNoteName(m), W - 24, yOf(m) - 2);
  }
  const ns = row.notes;
  let sounding: (typeof ns)[number] | null = null;
  for (let i = Math.max(0, lastAt(ns, t - PAST - 2)); i < ns.length && ns[i].time <= t + AHEAD; i++) {
    const n = ns[i];
    if (n.end < t - PAST) continue;
    const xs = Math.max(LABEL_PX, nowX + (n.time - t) * pxPerS);
    const xe = Math.max(xs + 3, nowX + (n.end - t) * pxPerS);
    const on = n.time <= t && t < n.end;
    if (on && (!sounding || n.velocity > sounding.velocity)) sounding = n;
    g.fillStyle = rgba(row.color, on ? 0.95 : n.time > t ? 0.3 + 0.5 * (n.velocity / 127) : 0.16);
    g.fillRect(xs, yOf(n.midi) - 3, xe - xs, 6);
  }
  if (sounding) {
    const y = yOf(sounding.midi);
    g.save();
    g.shadowColor = rgba(row.color, 1);
    g.shadowBlur = 12;
    g.fillStyle = '#f5f3ff';
    g.beginPath();
    g.arc(nowX, y, 4, 0, Math.PI * 2);
    g.fill();
    g.restore();
    g.fillStyle = '#ede9fe';
    g.font = '600 11px ui-monospace, monospace';
    g.fillText(midiNoteName(sounding.midi), nowX + 8, y + 4);
  }
}

export function HitKaraokePanel({ sources, focusedId, onSeek }: HitKaraokePanelProps) {
  const clock = usePlayheadClock();
  // Drawn on the sound — see usePaintClock. Seeks read the real clock.
  const paintClock = usePaintClock();
  const [offsetMs, setOffsetMs] = useState(readOffset);
  const [extra, setExtra] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    try { localStorage.setItem(OFFSET_KEY, String(offsetMs)); } catch { /* private mode */ }
  }, [offsetMs]);

  const rows = useMemo(
    () => sources.filter((s) => s.id === focusedId || extra.has(s.id)).flatMap((s) => s.rows),
    [sources, focusedId, extra],
  );
  const height = rows.reduce((h, r) => h + (r.kind === 'hits' ? HIT_ROW_PX : NOTE_ROW_PX), 0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [smooth] = useState(createClockSmoother);
  // The canvas's CSS size, kept by the ResizeObserver below. Reading
  // clientWidth inside `draw` forced a layout every frame, right after the
  // lane cursors had moved.
  const sizeRef = useRef({ W: 0, H: 0 });

  const draw = (now: number) => {
    const cv = canvasRef.current;
    const g = cv?.getContext('2d');
    if (!cv || !g) return;
    const t = smooth(now, performance.now()) - offsetMs / 1000;
    const dpr = window.devicePixelRatio || 1;
    // Measured once until the observer has reported (and where there is none).
    if (sizeRef.current.W <= 0) sizeRef.current = { W: cv.clientWidth, H: cv.clientHeight };
    const { W, H } = sizeRef.current;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const pxPerS = (W - LABEL_PX) / (PAST + AHEAD);
    const nowX = LABEL_PX + PAST * pxPerS;
    let y = 0;
    rows.forEach((row, i) => {
      const h = row.kind === 'hits' ? HIT_ROW_PX : NOTE_ROW_PX;
      g.fillStyle = i % 2 ? 'rgba(255,255,255,0.015)' : 'rgba(255,255,255,0.035)';
      g.fillRect(0, y, W, h);
      g.fillStyle = '#64748b';
      g.font = '10px ui-sans-serif, system-ui, sans-serif';
      g.fillText(fitText(g, row.name, LABEL_PX - 10), 6, y + h / 2 + 3.5);
      if (row.kind === 'hits') drawHitRow(g, row, t, y, h, nowX, pxPerS);
      else drawNoteRow(g, row, t, y, h, nowX, pxPerS, W);
      y += h;
    });
    g.fillStyle = 'rgba(226,232,240,0.3)';
    g.fillRect(nowX - 0.5, 0, 1, H);
  };
  usePlayheadEffect(draw, [rows, offsetMs], paintClock);

  // A resize doesn't move the clock, so repaint on it (and while paused).
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      sizeRef.current = { W: cv.clientWidth, H: cv.clientHeight };
      draw(paintClock.get());
    });
    ro.observe(cv);
    return () => ro.disconnect();
  });

  const accent = '#f87171';
  const others = sources.filter((s) => s.id !== focusedId);
  const focused = sources.find((s) => s.id === focusedId);

  return (
    <div className="rounded-lg border border-rose-400/20 bg-rose-500/[0.04] px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mb-2">
        <h3 className="text-[12px] font-semibold flex items-center gap-1.5 min-w-0" style={{ color: accent }}>
          <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: accent }} />
          <span className="truncate">Karaoke · {focused?.name ?? 'hits'}</span>
        </h3>
        {others.length > 0 && (
          <div className="flex flex-wrap items-center gap-1" title="Stack another layer's hits or notes under this one">
            {others.map((s) => {
              const on = extra.has(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setExtra((prev) => {
                    const next = new Set(prev);
                    if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
                    return next;
                  })}
                  className={`h-5 px-1.5 rounded border text-[10px] leading-none transition-colors ${
                    on ? 'border-white/30 text-slate-200 bg-white/[0.08]' : 'border-white/[0.1] text-slate-500 hover:text-slate-300'
                  }`}
                >
                  <span className="inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle" style={{ background: s.color }} />
                  {on ? '✓ ' : '+ '}{s.name}
                </button>
              );
            })}
          </div>
        )}
        <label
          className="ml-auto flex items-center gap-2 text-[11px] text-slate-400"
          title="Shift the karaoke against the audio. If every hit feels early or late by the same amount, this is by how much. Changes nothing on disk."
        >
          Offset
          <input
            type="range" min={-150} max={150} step={5} value={offsetMs}
            onChange={(e) => setOffsetMs(Number(e.target.value))}
            className="w-24 accent-slate-300"
          />
          <button
            type="button"
            onClick={() => setOffsetMs(0)}
            title="Back to 0 ms"
            className="w-12 text-left font-mono text-slate-300 tabular-nums hover:underline"
          >
            {offsetMs > 0 ? '+' : ''}{offsetMs} ms
          </button>
        </label>
      </div>
      <canvas
        ref={canvasRef}
        onClick={(e) => {
          if (!onSeek) return;
          const r = e.currentTarget.getBoundingClientRect();
          const dt = ((e.clientX - r.left - LABEL_PX) / (r.width - LABEL_PX)) * (PAST + AHEAD) - PAST;
          onSeek(Math.max(0, clock.get() + dt));
        }}
        title="The next few seconds, scrolling to the line. Click to jump there."
        className="block w-full rounded cursor-pointer bg-black/20"
        style={{ height }}
      />
    </div>
  );
}
