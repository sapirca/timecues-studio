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
 *
 * Several layers read as one: a transcription split across stems (the sung
 * words on `vocals`, a roar on `other`) is one performance, so every layer
 * that is shown on the canvas is merged into the same flow, each line in its
 * own layer's colour — colour alone says where a line came from, so two layers
 * that share one on the canvas get distinct ones here. No text tag: it pushed
 * the lyrics off centre. The chips in the header take a layer in or out; the
 * focused layer is always in. Lines from two layers that sound at once are
 * both lit, one above the other.
 */

import { useMemo, useRef, useState } from 'react';
import type { LyricsItem } from '../../types/annotationLayer';
import { formatClockTime } from '../../utils/clockTime';
import { textDir } from '../../utils/textDirection';
import { usePaintClock, usePlayheadEffect, usePlayheadValue } from '../../hooks/usePlayhead';

export interface KaraokeLyricsSource {
  id: string;
  name: string;
  color: string;
  items: LyricsItem[];
  /** On the canvas right now — such a layer starts in the karaoke. */
  shown: boolean;
}

interface KaraokePanelProps {
  /** Every lyrics layer that has words, the focused one included. */
  sources: readonly KaraokeLyricsSource[];
  /** The layer the user is reading — always in. */
  focusedId: string;
  onSeek?: (time: number) => void;
}

interface DisplayLine {
  /** start time of the line (first word, or the line item's time). */
  time: number;
  /** end time (line item's end, or last word's end/next-line start). */
  end: number;
  words: LyricsItem[];
  /** Raw line text when there are no word items to lay out individually. */
  text: string;
  /** The layer this line came from. */
  sourceId: string;
  sourceName: string;
  color: string;
}

/** What is lit: the lines sounding now (several when layers overlap), and the
 *  line either side of them for context. Indices into the merged line list. */
interface Active {
  first: number;
  last: number;
  lit: number[];
}

// When a lyrics layer has no explicit line items, group words into lines of
// roughly this many for a comfortable karaoke wrap.
const WORDS_PER_FALLBACK_LINE = 8;

export function KaraokePanel({ sources, focusedId, onSeek }: KaraokePanelProps) {
  // Chip clicks, over the default (focused + shown). A layer the user took out
  // stays out while it is shown, and one they added stays in while hidden.
  const [picked, setPicked] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const distinct = useMemo(() => distinctColors(sources, focusedId), [sources, focusedId]);
  const included = useMemo(
    () => distinct.filter((s) => s.id === focusedId || (picked.get(s.id) ?? s.shown)),
    [distinct, focusedId, picked],
  );
  const focused = distinct.find((s) => s.id === focusedId) ?? distinct[0];
  const color = focused?.color ?? '#38bdf8';
  const lines = useMemo(
    () => included.flatMap((src) => buildLines(src)).sort((a, b) => a.time - b.time || a.end - b.end),
    [included],
  );

  // Lit lines: every line sounding now. Between lines, the last one to start
  // holds (past the final line too) rather than blanking. Encoded as a string
  // so the panel re-renders only when the lit set moves; the word sweep inside
  // a line follows the clock itself.
  const activeKey = usePlayheadValue((currentTime) => {
    if (!lines.length) return '';
    const lit: number[] = [];
    let lastStarted = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].time > currentTime) break;
      lastStarted = i;
      // An open-ended line (a layer's last, with no end of its own) only
      // holds as the fallback below; lit outright it would sit over every
      // later line of every other layer.
      if (currentTime < lines[i].end && Number.isFinite(lines[i].end)) lit.push(i);
    }
    if (!lit.length) lit.push(Math.max(lastStarted, 0));
    return lit.join(',');
  }, usePaintClock());
  const active = useMemo<Active | null>(() => {
    if (!activeKey) return null;
    const lit = activeKey.split(',').map(Number);
    return { first: lit[0], last: lit[lit.length - 1], lit };
  }, [activeKey]);

  const toggle = (src: KaraokeLyricsSource) => setPicked((prev) => {
    const next = new Map(prev);
    next.set(src.id, !(prev.get(src.id) ?? src.shown));
    return next;
  });
  const header = (
    <Header
      title={focused?.name ?? 'Lyrics'}
      color={color}
      others={distinct.filter((s) => s.id !== focusedId)}
      isIn={(s) => included.includes(s)}
      onToggle={toggle}
      lineNo={active ? active.first + 1 : undefined}
      total={lines.length}
    />
  );

  if (!lines.length || !active) {
    return (
      <div className="rounded-lg border border-sky-400/20 bg-sky-500/[0.04] p-4">
        {header}
        <p className="text-[12px] text-slate-500 italic mt-2">
          No lyrics on this layer yet — run the Lyrics detector or import a transcript.
        </p>
      </div>
    );
  }

  // Context is the line before the first lit one and the line after the last
  // — skipping lines that are themselves lit, which a long overlapping line
  // from another layer can be.
  const litSet = new Set(active.lit);
  const prev = active.first > 0 ? lines[active.first - 1] : null;
  let nextIdx = active.last + 1;
  while (nextIdx < lines.length && litSet.has(nextIdx)) nextIdx++;
  const next = nextIdx < lines.length ? lines[nextIdx] : null;

  return (
    <div className="rounded-lg border border-sky-400/20 bg-sky-500/[0.04] p-4">
      {header}
      <div className="mt-3 flex flex-col items-center gap-1.5 text-center select-none">
        {prev && (
          <LineRow line={prev} onSeek={onSeek} variant="adjacent" />
        )}
        {active.lit.map((i) => (
          <LineRow key={`${lines[i].sourceId}:${lines[i].time}`} line={lines[i]} onSeek={onSeek} variant="active" />
        ))}
        {next && (
          <LineRow line={next} onSeek={onSeek} variant="adjacent" />
        )}
      </div>
    </div>
  );
}

function Header({
  title, color, others, isIn, onToggle, lineNo, total,
}: {
  title: string;
  color: string;
  others: readonly KaraokeLyricsSource[];
  isIn: (s: KaraokeLyricsSource) => boolean;
  onToggle: (s: KaraokeLyricsSource) => void;
  lineNo?: number;
  total?: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <h3 className="text-[12px] font-semibold flex items-center gap-1.5 min-w-0" style={{ color }}>
        <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
        <span className="truncate">Karaoke · {title}</span>
      </h3>
      {others.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" title="Read another lyrics layer along with this one — its lines join the flow in its own colour">
          {others.map((s) => {
            const on = isIn(s);
            return (
              <button
                key={s.id}
                type="button"
                aria-pressed={on}
                onClick={() => onToggle(s)}
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
      {lineNo != null && total != null && (
        <span className="ml-auto text-[10px] uppercase tracking-wider text-slate-500 font-mono">
          line {lineNo}/{total}
        </span>
      )}
    </div>
  );
}

function LineRow({
  line, onSeek, variant,
}: {
  line: DisplayLine;
  onSeek?: (t: number) => void;
  variant: 'active' | 'adjacent';
}) {
  const big = variant === 'active';
  const { color } = line;
  // The active line's karaoke sweep — which word is lit, which are sung —
  // is written straight onto the word buttons on every playhead update, so
  // following the song never re-renders the line. Adjacent lines are dimmed
  // uniformly and don't follow the clock at all.
  const wordRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Lit on the sound — see usePaintClock.
  const paintClock = usePaintClock();
  usePlayheadEffect((currentTime) => {
    if (!big) return;
    line.words.forEach((w, i) => {
      const el = wordRefs.current[i];
      if (!el) return;
      const wEnd = w.end ?? (line.words[i + 1]?.time ?? line.end);
      const isActive = w.time <= currentTime && currentTime < wEnd;
      const isSung = currentTime >= wEnd;
      // Keyed on the accent too, so a colour change repaints every word.
      const state = `${isActive ? 'active' : isSung ? 'sung' : 'ahead'}:${color}`;
      if (el.dataset.karaoke === state) return;
      el.dataset.karaoke = state;
      el.style.color = isActive ? '#ffffff' : isSung ? color : '#94a3b8';
      el.style.fontWeight = isActive ? '800' : '600';
      el.style.textShadow = isActive ? `0 0 12px ${color}` : '';
    });
  }, [big, line, color], paintClock);
  // A Hebrew line runs right to left, its first word on the right.
  const dir = textDir(line.words.length ? line.words.map((w) => w.text).join(' ') : line.text);
  // Words-with-timing render individually so the active one can light up;
  // otherwise fall back to the raw line text, lit in its layer's colour.
  if (!line.words.length) {
    return (
      <div
        dir={dir}
        className={`flex flex-wrap justify-center items-baseline gap-x-1.5 ${big ? 'text-[18px] font-semibold leading-snug' : 'text-[13px] leading-snug'}`}
        style={{ color: big ? color : '#475569' }}
        title={`From ${line.sourceName}`}
      >
        {line.text || ' '}
      </div>
    );
  }
  return (
    <div dir={dir} className={`flex flex-wrap justify-center gap-x-1.5 gap-y-0.5 ${big ? 'text-[18px] leading-snug' : 'text-[13px] leading-snug'}`}>
      {line.words.map((w, i) => {
        return (
          <button
            key={w.id || `${w.time}:${i}`}
            ref={(el) => { wordRefs.current[i] = el; }}
            onClick={() => onSeek?.(w.time)}
            className="transition-colors hover:underline"
            // The active line's colour/weight/glow are set by the sweep above.
            style={big ? undefined : { color: '#475569', fontWeight: 400 }}
            title={`${fmt(w.time)} · ${line.sourceName} — click to seek`}
          >
            {w.text}
          </button>
        );
      })}
    </div>
  );
}

/** Colours a layer can take in the karaoke when its own is already used. */
const KARAOKE_PALETTE = ['#a78bfa', '#f472b6', '#38bdf8', '#34d399', '#fbbf24', '#fb923c', '#f87171', '#a3e635', '#22d3ee', '#e879f9'];

/** Every source with a colour no other source has. The focused layer keeps
 *  its own; any later layer whose colour is already taken gets the first
 *  palette colour not in use — colour is the only thing telling lines apart. */
function distinctColors(
  sources: readonly KaraokeLyricsSource[],
  focusedId: string,
): KaraokeLyricsSource[] {
  const order = [...sources].sort((a, b) => Number(b.id === focusedId) - Number(a.id === focusedId));
  const used = new Set<string>();
  const assigned = new Map<string, string>();
  for (const s of order) {
    let c = s.color.toLowerCase();
    if (used.has(c)) c = KARAOKE_PALETTE.find((p) => !used.has(p)) ?? c;
    used.add(c);
    assigned.set(s.id, c);
  }
  return sources.map((s) => (assigned.get(s.id) === s.color.toLowerCase() ? s : { ...s, color: assigned.get(s.id)! }));
}

/** Build one layer's display lines: explicit line items group the words they
 *  cover, and the words no line covers are chunked into fixed-size lines.
 *  A line item never hides the words around it — one stray line drawn at the
 *  intro used to turn a 150-word layer into a single empty line. A line with
 *  neither words nor text is dropped: there is nothing in it to read. */
function buildLines(src: KaraokeLyricsSource): DisplayLine[] {
  const { items } = src;
  const from = { sourceId: src.id, sourceName: src.name, color: src.color };
  const words = items.filter((it) => it.kind === 'word').sort((a, b) => a.time - b.time);
  const lineItems = items.filter((it) => it.kind === 'line').sort((a, b) => a.time - b.time);

  const lines: DisplayLine[] = lineItems.map((ln, i) => {
    const end = ln.end ?? lineItems[i + 1]?.time ?? Number.POSITIVE_INFINITY;
    const lineWords = words.filter((w) => w.time >= ln.time - 0.05 && w.time < end);
    return { time: ln.time, end, words: lineWords, text: ln.text, ...from };
  }).filter((ln) => ln.words.length || ln.text.trim());

  // Loose words chunk in runs; a run breaks where a line item starts, so a
  // chunk never straddles a line it isn't part of.
  const claimed = new Set(lines.flatMap((ln) => ln.words));
  const loose = words.filter((w) => !claimed.has(w));
  const lineStarts = lines.map((ln) => ln.time);
  const out: DisplayLine[] = [...lines];
  let chunk: LyricsItem[] = [];
  const flush = (nextTime: number | undefined) => {
    if (!chunk.length) return;
    const last = chunk[chunk.length - 1];
    out.push({
      time: chunk[0].time,
      end: last.end ?? nextTime ?? Number.POSITIVE_INFINITY,
      words: chunk,
      text: chunk.map((w) => w.text).join(' '),
      ...from,
    });
    chunk = [];
  };
  loose.forEach((w, i) => {
    chunk.push(w);
    const next = loose[i + 1];
    const lineBetween = next && lineStarts.some((t) => t > w.time && t <= next.time);
    if (!next || lineBetween || chunk.length >= WORDS_PER_FALLBACK_LINE) flush(next?.time);
  });
  return out.sort((a, b) => a.time - b.time);
}

function fmt(t: number): string {
  return formatClockTime(t, 0);
}
