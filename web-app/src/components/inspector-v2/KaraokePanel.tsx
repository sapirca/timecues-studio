/**
 * KaraokePanel — a readable, playback-synced lyrics display.
 *
 * The lyrics canvas row (LyricsLayerRow) packs every word onto one thin
 * timeline, which is great for editing alignment but unreadable as lyrics.
 * This panel is the complement: it renders the lyrics as flowing text and
 * follows playback karaoke-style — the current line large and centered with
 * the active word lit, the previous and next lines dimmed for context. Click
 * any word to seek there.
 *
 * Source-agnostic: feed it any lyrics layer's items (curated detector output
 * or a hand-edited layer). Words drive the highlight; line items (when
 * present) define the line grouping, otherwise words are chunked into lines.
 */

import { useMemo } from 'react';
import type { LyricsItem } from '../../types/annotationLayer';

interface KaraokePanelProps {
  items: LyricsItem[];
  currentTime: number;
  onSeek?: (time: number) => void;
  /** Layer name shown in the header (e.g. "Lyrics (curated)"). */
  title?: string;
  /** Accent color for the active word/line. */
  color?: string;
}

interface DisplayLine {
  /** start time of the line (first word, or the line item's time). */
  time: number;
  /** end time (line item's end, or last word's end/next-line start). */
  end: number;
  words: LyricsItem[];
  /** Raw line text when there are no word items to lay out individually. */
  text: string;
}

// When a lyrics layer has no explicit line items, group words into lines of
// roughly this many for a comfortable karaoke wrap.
const WORDS_PER_FALLBACK_LINE = 8;

export function KaraokePanel({
  items, currentTime, onSeek, title = 'Lyrics', color = '#38bdf8',
}: KaraokePanelProps) {
  const lines = useMemo(() => buildLines(items), [items]);

  // Active line: the last line whose start is at/before now and whose end is
  // after now (end falls back to the next line's start). Past the last line we
  // hold on the final one rather than blanking.
  const activeIdx = useMemo(() => {
    if (!lines.length) return -1;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].time <= currentTime) idx = i;
      else break;
    }
    return idx === -1 ? 0 : idx;
  }, [lines, currentTime]);

  if (!lines.length) {
    return (
      <div className="rounded-lg border border-sky-400/20 bg-sky-500/[0.04] p-4">
        <Header title={title} color={color} />
        <p className="text-[12px] text-slate-500 italic mt-2">
          No lyrics on this layer yet — run the Lyrics detector or import a transcript.
        </p>
      </div>
    );
  }

  const prev = activeIdx > 0 ? lines[activeIdx - 1] : null;
  const current = lines[activeIdx];
  const next = activeIdx < lines.length - 1 ? lines[activeIdx + 1] : null;

  return (
    <div className="rounded-lg border border-sky-400/20 bg-sky-500/[0.04] p-4">
      <Header title={title} color={color} lineNo={activeIdx + 1} total={lines.length} />
      <div className="mt-3 flex flex-col items-center gap-1.5 text-center select-none">
        {prev && (
          <LineRow line={prev} currentTime={currentTime} onSeek={onSeek} color={color} variant="adjacent" />
        )}
        <LineRow line={current} currentTime={currentTime} onSeek={onSeek} color={color} variant="active" />
        {next && (
          <LineRow line={next} currentTime={currentTime} onSeek={onSeek} color={color} variant="adjacent" />
        )}
      </div>
    </div>
  );
}

function Header({ title, color, lineNo, total }: { title: string; color: string; lineNo?: number; total?: number }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-[12px] font-semibold flex items-center gap-1.5" style={{ color }}>
        <span className="inline-block w-2 h-2 rounded-full" style={{ background: color }} />
        Karaoke · {title}
      </h3>
      {lineNo != null && total != null && (
        <span className="text-[10px] uppercase tracking-wider text-slate-500 font-mono">
          line {lineNo}/{total}
        </span>
      )}
    </div>
  );
}

function LineRow({
  line, currentTime, onSeek, color, variant,
}: {
  line: DisplayLine;
  currentTime: number;
  onSeek?: (t: number) => void;
  color: string;
  variant: 'active' | 'adjacent';
}) {
  const big = variant === 'active';
  // Words-with-timing render individually so the active one can light up;
  // otherwise fall back to the raw line text.
  if (!line.words.length) {
    return (
      <div
        className={big ? 'text-[18px] font-semibold leading-snug' : 'text-[13px] leading-snug'}
        style={{ color: big ? '#e2e8f0' : '#475569' }}
      >
        {line.text || ' '}
      </div>
    );
  }
  return (
    <div className={`flex flex-wrap justify-center gap-x-1.5 gap-y-0.5 ${big ? 'text-[18px] leading-snug' : 'text-[13px] leading-snug'}`}>
      {line.words.map((w, i) => {
        const wEnd = w.end ?? (line.words[i + 1]?.time ?? line.end);
        const isActive = big && w.time <= currentTime && currentTime < wEnd;
        const isSung = big && currentTime >= wEnd;
        const colorVal = !big
          ? '#475569'
          : isActive ? '#ffffff' : isSung ? color : '#94a3b8';
        return (
          <button
            key={w.id || `${w.time}:${i}`}
            onClick={() => onSeek?.(w.time)}
            className="transition-colors hover:underline"
            style={{
              color: colorVal,
              fontWeight: isActive ? 800 : big ? 600 : 400,
              textShadow: isActive ? `0 0 12px ${color}` : undefined,
            }}
            title={`${fmt(w.time)} — click to seek`}
          >
            {w.text}
          </button>
        );
      })}
    </div>
  );
}

/** Build display lines from a flat item list: prefer explicit line items,
 *  else chunk words into fixed-size lines. */
function buildLines(items: LyricsItem[]): DisplayLine[] {
  const words = items.filter((it) => it.kind === 'word').sort((a, b) => a.time - b.time);
  const lineItems = items.filter((it) => it.kind === 'line').sort((a, b) => a.time - b.time);

  if (lineItems.length) {
    return lineItems.map((ln, i) => {
      const end = ln.end ?? lineItems[i + 1]?.time ?? Number.POSITIVE_INFINITY;
      const lineWords = words.filter((w) => w.time >= ln.time - 0.05 && w.time < end);
      return { time: ln.time, end, words: lineWords, text: ln.text };
    });
  }
  if (!words.length) return [];
  const out: DisplayLine[] = [];
  for (let i = 0; i < words.length; i += WORDS_PER_FALLBACK_LINE) {
    const chunk = words.slice(i, i + WORDS_PER_FALLBACK_LINE);
    const last = chunk[chunk.length - 1];
    out.push({
      time: chunk[0].time,
      end: last.end ?? (words[i + WORDS_PER_FALLBACK_LINE]?.time ?? Number.POSITIVE_INFINITY),
      words: chunk,
      text: chunk.map((w) => w.text).join(' '),
    });
  }
  return out;
}

function fmt(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '0:00';
  const m = Math.floor(t / 60);
  const s = Math.floor(t - m * 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
