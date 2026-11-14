/**
 * Which grip of a Lyrics lane a press means. Aligned words sit back to back,
 * so one word's end handle is drawn over the next word's tick; the lane asks
 * this instead of letting the drawn order decide.
 */

import type { LyricsItem } from '../../types/annotationLayer';

/** A word's tick is drawn this far right of its time (the chip's 2px padding
 *  plus half the 2px tick), and that is where the eye aims. */
const TICK_CENTER_PX = 3;
/** How far from a grip a press still counts as aimed at it — the end
 *  handle's 6px width, so nothing reachable before stops being reachable. */
const GRIP_REACH_PX = 6;

export type LyricsGrip = { id: string; kind: 'move' | 'end' };

/** Stack overlapping words: each word takes the first row whose last word has
 *  ended by its start. Words that don't overlap all stay in row 0, so a clean
 *  lane draws one row; only an overlap opens a second.
 *
 *  Lines and words never share a row: where a phrase line lies over its words,
 *  the line takes the row(s) on top and the words the rows under it — fixed by
 *  kind, so dragging a word ahead of its line does not swap the two rows.
 *
 *  The split is local. `counts[i]` is how many rows word i's own cluster — the
 *  run of items linked by overlaps — needs, and the word is drawn at that
 *  height: a pile of twelve at one instant thins those twelve, never the clean
 *  verse a minute earlier. `count` is the deepest cluster. Input sorted by time. */
export function packRows(items: readonly LyricsItem[]): { rows: number[]; counts: number[]; count: number } {
  const rows: number[] = [];
  const counts: number[] = [];
  const endOf = (it: LyricsItem) => (it.end != null && it.end > it.time ? it.end : it.time);
  let deepest = 1;
  let start = 0;
  let reach = -Infinity;
  const pack = (members: number[]): number => {
    const ends: number[] = [];
    for (const i of members) {
      const it = items[i];
      let r = ends.findIndex((e) => e <= it.time + 1e-6);
      if (r < 0) { r = ends.length; ends.push(endOf(it)); } else ends[r] = endOf(it);
      rows[i] = r;
    }
    return ends.length;
  };
  const close = (upTo: number) => {
    const idx = Array.from({ length: upTo - start }, (_, k) => start + k);
    const lines = idx.filter((i) => items[i].kind === 'line');
    const words = idx.filter((i) => items[i].kind !== 'line');
    const lineRows = pack(lines);
    const wordRows = pack(words);
    for (const i of words) rows[i] += lineRows;
    const n = Math.max(1, lineRows + wordRows);
    for (const i of idx) counts[i] = n;
    deepest = Math.max(deepest, n);
  };
  items.forEach((it, i) => {
    // Everything so far has ended by this start: nothing before can overlap
    // anything after, so the cluster closes here.
    if (i > start && reach <= it.time + 1e-6) { close(i); start = i; reach = -Infinity; }
    reach = Math.max(reach, endOf(it));
  });
  if (items.length) close(items.length);
  return { rows, counts, count: deepest };
}

/** Where two words overlap in time: [start, end) with both ids, for a warning
 *  mark. A line over words is not one: the line is the phrase, its words are
 *  the sounds in it, and they already sit in rows of their own. Input sorted
 *  by time. */
export function overlapSpans(items: readonly LyricsItem[]): { a: LyricsItem; b: LyricsItem; start: number; end: number }[] {
  const out: { a: LyricsItem; b: LyricsItem; start: number; end: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (a.end == null || a.end <= a.time) continue;
    for (let j = i + 1; j < items.length && items[j].time < a.end; j++) {
      const b = items[j];
      if ((a.kind === 'line') !== (b.kind === 'line')) continue;
      const end = Math.min(a.end, b.end != null && b.end > b.time ? b.end : b.time);
      if (end > b.time) out.push({ a, b, start: b.time, end });
    }
  }
  return out;
}

/** The grip nearest `x` (px from the lane's left), or null when none is
 *  within reach. Ties go to the earlier word's grip. With `yFrac` (how far
 *  down the lane the press is, 0 top … 1 bottom), only words stacked in the
 *  row pressed answer — an overlapping word in the row above is a different
 *  target, whatever its x. A word's rows are those of its own cluster
 *  (`rows`, see packRows), so the same height is row 1 in one place and the
 *  only row in another. */
export function nearestGrip(
  placed: readonly { item: LyricsItem; widthPct: number | null; row?: number; rows?: number }[],
  x: number,
  pxPerSec: number,
  moveEnabled: boolean,
  endEnabled: boolean,
  yFrac?: number,
): LyricsGrip | null {
  let best: LyricsGrip | null = null;
  let bestDist = GRIP_REACH_PX;
  for (const { item, widthPct, row: r, rows = 1 } of placed) {
    if (yFrac != null && r != null && r !== Math.min(rows - 1, Math.max(0, Math.floor(yFrac * rows)))) continue;
    if (moveEnabled) {
      const d = Math.abs(x - (item.time * pxPerSec + TICK_CENTER_PX));
      if (d < bestDist) { bestDist = d; best = { id: item.id, kind: 'move' }; }
    }
    if (endEnabled && widthPct != null && item.end != null) {
      const d = Math.abs(x - item.end * pxPerSec);
      if (d < bestDist) { bestDist = d; best = { id: item.id, kind: 'end' }; }
    }
  }
  return best;
}
