/**
 * SongOverviewStrip — the whole song in one strip, shown while zoomed in.
 *
 * Zoomed in, the rows show a few bars and you lose where you are in the song.
 * This is the rekordbox answer: the full 3-band waveform with the section
 * starts flagged on it, and a box sliding along it that marks the stretch the
 * rows are showing.
 *
 *   drag the box          → pan the rows (the playhead stays put)
 *   press anywhere else   → seek there and centre the rows on it; keep the
 *                           button down and it scrubs
 *
 * It sits in its own box below every lane, pinned to the window's bottom edge,
 * outside the rows' scroller (inside the lanes it read as one more lane), and
 * drives that scroller through scrollerRef. The waveform is painted once per song/width; the box moves on scroll and the
 * playhead follows the shared clock, so neither re-renders the panel.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { getBandPeaks, buildPeaks, type BandPeaks } from '../../utils/bandPeaks';
import { getBandColors } from '../../utils/bandPalettes';
import { useSettings } from '../../context/SettingsContext';
import { PlayheadLine } from '../Playhead';

export interface OverviewSection { time: number; endTime: number; color: string }

const HEIGHT = 34;

export function SongOverviewStrip({ audioBuffer, duration, sections, scrollerRef, contentWidth, gutterWidth, onSeek }: {
  audioBuffer: AudioBuffer | null;
  duration: number;
  /** One boundary layer's sections, each with its resolved color. */
  sections: OverviewSection[];
  /** The rows' horizontal scroller — the strip reads and drives its scrollLeft. */
  scrollerRef: RefObject<HTMLDivElement | null>;
  /** Width of the rows' time area at this zoom (vizSignalWidth). */
  contentWidth: number;
  /** The rows' sticky label gutter, which covers the left of the scroller. */
  gutterWidth: number;
  onSeek: (time: number) => void;
}) {
  const { settings } = useSettings();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // Keyed by the buffer they came from, so a new song never shows the old peaks.
  const [loaded, setLoaded] = useState<{ buf: AudioBuffer; peaks: BandPeaks } | null>(null);
  const peaks = loaded && loaded.buf === audioBuffer ? loaded.peaks : null;
  const [viewW, setViewW] = useState(0);     // the scroller's visible width
  const [trackW, setTrackW] = useState(0);

  useEffect(() => {
    if (!audioBuffer) return;
    let live = true;
    getBandPeaks(audioBuffer).then((p) => { if (live) setLoaded({ buf: audioBuffer, peaks: p }); }).catch(() => {});
    return () => { live = false; };
  }, [audioBuffer]);

  useEffect(() => {
    const sc = scrollerRef.current, tr = trackRef.current;
    if (!sc || !tr) return;
    const ro = new ResizeObserver(() => { setViewW(sc.clientWidth); setTrackW(tr.clientWidth); });
    ro.observe(sc); ro.observe(tr);
    return () => ro.disconnect();
  }, [scrollerRef]);

  // ── The waveform and section flags ──
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || trackW <= 0 || duration <= 0) return;
    const dpr = window.devicePixelRatio || 1, W = trackW, H = HEIGHT;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const X = (t: number) => (t / duration) * W;
    for (const s of sections) {
      g.globalAlpha = 0.12; g.fillStyle = s.color;
      g.fillRect(X(s.time), 0, Math.max(1, X(s.endTime) - X(s.time)), H);
    }
    g.globalAlpha = 1;
    if (peaks) {
      const light = document.documentElement.getAttribute('data-theme') === 'light';
      const colors = getBandColors(settings.bandPalette, light ? 'light' : 'dark');
      const cols = Math.max(1, Math.round(W * dpr)), dx = W / cols, cy = H / 2;
      for (const id of ['low', 'mid', 'high'] as const) {
        const p = buildPeaks(peaks[id], cols), k = peaks.scales[id];
        g.fillStyle = colors[id];
        g.beginPath(); g.moveTo(0, cy);
        for (let i = 0; i < cols; i++) g.lineTo(i * dx, cy - p[i] * k * cy);
        for (let i = cols - 1; i >= 0; i--) g.lineTo(i * dx, cy + p[i] * k * cy);
        g.closePath(); g.fill();
      }
    }
    // Section starts: a line down the strip and a numbered flag at its top.
    g.font = '600 9px system-ui, sans-serif'; g.textBaseline = 'middle';
    sections.forEach((s, i) => {
      const x = Math.round(X(s.time)) + 0.5, n = String(i + 1), fw = g.measureText(n).width + 6;
      g.fillStyle = s.color; g.fillRect(x - 0.5, 0, 1, H);
      g.beginPath(); g.moveTo(x - 0.5, 0); g.lineTo(x + fw, 0); g.lineTo(x + fw + 4, 5.5);
      g.lineTo(x + fw, 11); g.lineTo(x - 0.5, 11); g.closePath(); g.fill();
      g.fillStyle = '#0b0d10'; g.fillText(n, x + 3, 6);
    });
  }, [peaks, sections, duration, trackW, settings.bandPalette]);

  // ── The box: the stretch of the song the rows show ──
  // The rows' visible time area: the scroller minus the label gutter and its
  // pr-2 (8px) padding.
  const visW = () => Math.max(1, (scrollerRef.current?.clientWidth ?? 1) - gutterWidth - 8);
  useEffect(() => {
    const sc = scrollerRef.current, box = boxRef.current;
    if (!sc || !box) return;
    const place = () => {
      // At fit there is no scroll width (contentWidth 0): the rows show it all.
      if (contentWidth <= 0) { box.style.left = '0%'; box.style.width = '100%'; return; }
      box.style.left = `${(100 * sc.scrollLeft) / contentWidth}%`;
      box.style.width = `${100 * Math.min(1, visW() / contentWidth)}%`;
    };
    place();
    sc.addEventListener('scroll', place, { passive: true });
    return () => sc.removeEventListener('scroll', place);
  }, [scrollerRef, contentWidth, viewW, gutterWidth]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const sc = scrollerRef.current, tr = trackRef.current;
    if (e.button !== 0 || !sc || !tr || duration <= 0) return;
    e.preventDefault(); e.stopPropagation();
    const r = tr.getBoundingClientRect();
    const frac = (cx: number) => Math.max(0, Math.min(1, (cx - r.left) / r.width));
    tr.setPointerCapture(e.pointerId);
    let move: (ev: PointerEvent) => void;
    if ((e.target as Element).closest('[data-overview-box]')) {
      const x0 = e.clientX, s0 = sc.scrollLeft;
      move = (ev) => { sc.scrollLeft = s0 + ((ev.clientX - x0) / r.width) * contentWidth; };
    } else {
      move = (ev) => {
        const f = frac(ev.clientX);
        onSeek(f * duration);
        if (contentWidth > 0) sc.scrollLeft = Math.max(0, f * contentWidth - visW() / 2);
      };
      move(e.nativeEvent);
    }
    const up = () => {
      tr.removeEventListener('pointermove', move);
      tr.removeEventListener('pointerup', up);
      tr.removeEventListener('pointercancel', up);
    };
    tr.addEventListener('pointermove', move);
    tr.addEventListener('pointerup', up);
    tr.addEventListener('pointercancel', up);
  };

  return (
    <div className="flex items-center gap-3 rounded-md border border-gray-800 bg-gray-950/60 px-3 py-2">
      <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-gray-500">Song</span>
      <div
        ref={trackRef}
        className="flex-1 min-w-0 relative overflow-hidden rounded-sm bg-gray-950 cursor-pointer touch-none"
        style={{ height: HEIGHT }}
        onPointerDown={onPointerDown}
        title="The whole song — drag the box to pan, press anywhere else to jump there"
      >
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
        <div
          ref={boxRef}
          data-overview-box
          className="absolute top-0 bottom-0 box-border rounded-sm cursor-grab active:cursor-grabbing"
          style={{
            minWidth: 3,
            border: '1px solid rgba(226,232,240,0.6)',
            background: 'rgba(255,255,255,0.05)',
            // Dims everything outside the box; the track's overflow-hidden clips it.
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.38)',
          }}
        />
        <PlayheadLine duration={duration} style={{ background: '#ff5c7a' }} />
      </div>
    </div>
  );
}
