// Dual time representation for annotations: absolute seconds AND musical
// position (fractional beats from the grid origin).
//
// Which one is authoritative depends on Grid Lock:
//
//   - Grid Lock OFF — seconds are canonical. The beat rides along as a stamped
//     companion, refreshed from the times on every save.
//   - Grid Lock ON  — the BEAT is canonical: the song is annotated musically,
//     so a marker belongs to its bar.beat and its seconds are that beat's
//     position on the current grid. If the grid moves — even in another
//     session, in Data Prep, or by another annotator — the times are
//     recomputed from the beats rather than left behind.
//
// Seconds are always WRITTEN either way, because everything downstream reads
// them: evaluation tolerances, detector outputs, exports, cross-annotator
// agreement. An annotation file therefore stays meaningful on its own, and no
// consumer has to learn about beats.
//
// Having both lets the app answer the question a grid edit raises: when BPM,
// the grid offset, the time signature or a tempo anchor moves, does a marker
// keep the instant it was placed at (its milliseconds) or the musical spot it
// marks (its bar.beat)? Neither answer is right in general — a kick you tapped
// belongs to its instant, a downbeat you placed belongs to its beat — so the
// UI asks, and this module supplies both transforms:
//
//   - `withStampedBeats*`   — times win: recompute every beat from its time.
//   - `withClearedBeatStamps` — times win, absolutely: drop the beat companion
//                             altogether, for the annotator who has just said
//                             the millisecond is the whole truth. An un-stamped
//                             item is skipped by `withTimesFromBeats*`, so
//                             nothing can pull it back onto a bar.beat.
//   - `retimed*`            — beats win, derived: recompute every time from the
//                             beat the item had under the OLD grid.
//   - `withTimesFromBeats*` — beats win, stored: recompute every time from the
//                             item's own saved `beat`, against the grid in
//                             force now. This is the Grid Lock rule, and the
//                             only one that survives a grid edit made outside
//                             this session.
//
// `retimed*` deliberately takes the previous grid rather than reading the
// stored `beat` fields, so it is correct even for items saved before this
// feature existed, and cannot be defeated by a stale stamp. `withTimesFromBeats*`
// is its counterpart for when the old grid is gone and only the stamp remains;
// it leaves un-stamped items alone rather than guessing.
//
// Manual-mode caveat: `beatOverrides` (individually pinned beats) are not
// consulted. Both directions use the macro grid — bpm/offset/anchors — so a
// pinned beat's neighbourhood can round-trip a few milliseconds off. Pinning
// is a visual grid correction, not an annotation edit, and only one song in
// the corpus uses it.

import {
  beatPositionAt, beatTimeAt, beatsPerBarFromTimeSignature,
  foldGridOffset, gridOffsetBarShift, roundTime,
} from './beatGrid';
import type { AnnotationLayer, AnnotationLayersDocument } from '../types/annotationLayer';
import type { SongInfo } from '../types/songInfo';
import { effectiveGridSegments } from '../types/songInfo';
import { resolveGridSegments, type ResolvedSegment } from './gridSegments';

/** The part of a SongInfo that decides where beats fall in time. */
export interface BeatGrid {
  bpm: number;
  gridOffset: number;
  /** Resolved grid segments. More than one and the song's beats come from
   *  the segment table rather than from bpm/gridOffset, so retiming under Grid
   *  Lock has to read them too — otherwise a split would move every marker
   *  downstream while the maths still believed in one tempo. */
  segments?: readonly ResolvedSegment[];
}

/** Below this a "BPM" is a placeholder, not a tempo — matches the Grid Lock gate. */
const MIN_USABLE_BPM = 20;

/** A time difference this small is float noise, not a move. */
const EPSILON_SEC = 1e-4;

export function gridOf(info: SongInfo | null | undefined): BeatGrid | null {
  const bpm = info?.bpm ?? 0;
  if (!Number.isFinite(bpm) || bpm <= MIN_USABLE_BPM) return null;
  return {
    bpm,
    gridOffset: info?.gridOffset ?? 0,
    segments: resolveGridSegments(info),
  };
}

/** Identity of a grid, for detecting that one has changed. Two SongInfos with
 *  the same signature place every beat at the same time, so nothing needs to
 *  be re-anchored between them. The time signature is included because it
 *  moves bar lines (and therefore bar-snapped positions) even though it leaves
 *  beat times alone. */
export function gridSignature(info: SongInfo | null | undefined): string {
  if (!info) return 'none';
  // Splits move bar lines and renumber everything downstream, so they belong
  // in the identity: without them a split would slip past the Grid Lock
  // prompt that exists to ask what the annotator meant.
  const segments = effectiveGridSegments(info)
    .map((g) => `${g.start.toFixed(6)}@${g.bpm}/${g.timeSignature}`)
    .join(',');
  return [
    info.bpm ?? 0,
    info.gridOffset ?? 0,
    info.timeSignature ?? '',
    info.gridMode ?? 'static',
    segments,
  ].join('|');
}

/** Plain-language summary of what changed between two grid signatures, for the
 *  "the grid moved" prompt. Reads the signature's own fields rather than taking
 *  two SongInfos, so callers only have to keep the string they already track. */
export function describeGridChange(prevSig: string, nextSig: string): string {
  const [pBpm, pOff, pSig, pMode, pSegs = ''] = prevSig.split('|');
  const [nBpm, nOff, nSig, nMode, nSegs = ''] = nextSig.split('|');
  const parts: string[] = [];
  if (pBpm !== nBpm) parts.push(`BPM ${pBpm} → ${nBpm}`);
  if (pOff !== nOff) {
    const d = Number(nOff) - Number(pOff);
    parts.push(Number.isFinite(d)
      ? `grid offset moved ${d > 0 ? '+' : ''}${d.toFixed(3)}s`
      : 'grid offset moved');
  }
  if (pSig !== nSig) parts.push(`time signature ${pSig || '—'} → ${nSig || '—'}`);
  if (pMode !== nMode) parts.push(`grid mode ${pMode} → ${nMode}`);
  if (pSegs !== nSegs) {
    // Segment counts here exclude the opening one, which is always present.
    const before = pSegs ? pSegs.split(',').length + 1 : 1;
    const after = nSegs ? nSegs.split(',').length + 1 : 1;
    parts.push(before === after ? 'a grid segment changed' : `grid segments ${before} → ${after}`);
  }
  if (parts.length === 0) return 'The grid changed';
  return parts.join(', ').replace(/^./, (c) => c.toUpperCase());
}

export function timeToBeat(t: number, g: BeatGrid): number {
  return beatPositionAt(t, g.bpm, g.gridOffset, g.segments);
}

export function beatToTime(beat: number, g: BeatGrid): number {
  return roundTime(beatTimeAt(beat, g.bpm, g.gridOffset, undefined, g.segments));
}

/** Where `t` lands after the grid changes, if it holds its musical position. */
function retime(t: number, from: BeatGrid, to: BeatGrid): number {
  return Math.max(0, beatToTime(timeToBeat(t, from), to));
}

/** Same, but for an item that carries its own stamped beat: that stamp IS its
 *  musical position (the canonical one under Grid Lock), so use it directly
 *  instead of re-deriving the position from where the time fell on the old
 *  grid. The two agree whenever the stamp is fresh; the stamp wins when it is
 *  not, which is exactly the case a grid edit made outside this session
 *  produces. Falls back to the old-grid derivation for un-stamped items. */
function retimeWithStamp(
  t: number, beat: number | undefined, from: BeatGrid, to: BeatGrid,
): number {
  return typeof beat === 'number' && Number.isFinite(beat)
    ? Math.max(0, beatToTime(beat, to))
    : retime(t, from, to);
}

// The item union has two timing shapes — a point (`time`) and a range
// (`start`/`end`) — and every transform here is uniform across both. TypeScript
// can't narrow `layer.items` from `layer.type` on a generic AnnotationLayer, so
// the maps below work through these structural views instead of the union.
type TimedItem = {
  time?: number;
  beat?: number;
  start?: number;
  end?: number;
  startBeat?: number;
  endBeat?: number;
  /** Points carry bare seconds, ranges carry [start, end] pairs — a union, not
   *  an intersection, so each branch below can write back its own shape. */
  candidates?: number[] | [number, number][];
};

function itemsOf(layer: AnnotationLayer): TimedItem[] {
  return layer.items as unknown as TimedItem[];
}

function withItems(layer: AnnotationLayer, items: TimedItem[]): AnnotationLayer {
  return { ...layer, items } as unknown as AnnotationLayer;
}

// ─── Times win: stamp the beat companion fields ─────────────────────────────

function stampLayer(layer: AnnotationLayer, g: BeatGrid): AnnotationLayer {
  // Lyrics are exempt from grid alignment everywhere else (Grid Lock skips
  // them, the bulk snap skips them) — a sung word does not sit on a beat.
  if (layer.type === 'lyrics') return layer;
  const items = itemsOf(layer).map((it) => {
    if (typeof it.time === 'number') return { ...it, beat: timeToBeat(it.time, g) };
    if (typeof it.start === 'number' && typeof it.end === 'number') {
      return { ...it, startBeat: timeToBeat(it.start, g), endBeat: timeToBeat(it.end, g) };
    }
    return it;
  });
  return withItems(layer, items);
}

export function withStampedBeats(
  doc: AnnotationLayersDocument,
  g: BeatGrid | null,
): AnnotationLayersDocument {
  if (!g) return doc;
  return { ...doc, layers: doc.layers.map((l) => stampLayer(l, g)) };
}

function clearLayerStamps(layer: AnnotationLayer): AnnotationLayer {
  let changed = false;
  const items = itemsOf(layer).map((it) => {
    if (it.beat === undefined && it.startBeat === undefined && it.endBeat === undefined) return it;
    changed = true;
    const next = { ...it };
    delete next.beat;
    delete next.startBeat;
    delete next.endBeat;
    return next;
  });
  return changed ? withItems(layer, items) : layer;
}

/**
 * Drop every beat companion in the document, leaving the seconds alone.
 *
 * This is what "keep their milliseconds" means once you take it literally: the
 * marker is a claim about the sound, the grid edit did not move the sound, and
 * a musical position derived from a grid the annotator has just declined is
 * not worth keeping. Clearing is also the safety: `withTimesFromBeats` skips
 * un-stamped items, so there is no stamp left for the once-per-load realign to
 * pull the times onto.
 *
 * The stamps do come back — the next save re-derives them from the canonical
 * seconds (`withStampedBeats`), and they then agree with the times they were
 * derived from, which is the point. What cannot come back is the OLD stamp,
 * the one that still described the grid before the edit.
 */
export function withClearedBeatStamps(
  doc: AnnotationLayersDocument,
): AnnotationLayersDocument {
  return { ...doc, layers: doc.layers.map(clearLayerStamps) };
}

// ─── Folding the grid offset: bar 1 is the song's first bar ─────────────────
//
// A grid offset of several bars numbers the whole intro negatively, because
// the grid extends backwards from wherever bar 1 was set. Folding it into the
// first bar (see foldGridOffset in beatGrid.ts) fixes the numbering without
// moving a single grid line — the fold is a whole number of bars, so every
// beat stays exactly where it sounded.
//
// What the fold DOES move is the beat *index* of every time in the song: it
// gains `barsFolded * beatsPerBar`. Anything that stored an index against the
// old numbering has to move with it — the annotations' beat stamps (the
// canonical position under Grid Lock) and the `beatOverrides` keys. That is a
// pure relabelling: no time changes, and a stamp that disagreed with its time
// before the fold disagrees by exactly as much after it, so the Grid Lock
// realign still has the same work to do.

function shiftOverrideKeys(
  overrides: Readonly<Record<string, number>>, deltaBeats: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(overrides)) {
    const idx = parseInt(k, 10);
    out[Number.isFinite(idx) ? String(idx + deltaBeats) : k] = v;
  }
  return out;
}

/** Fold a song's grid offset into its first bar, returning the corrected
 *  SongInfo (offset + re-keyed `beatOverrides`) and the whole-bar renumbering
 *  in beats. `deltaBeats === 0` means nothing moved — the common case, and the
 *  invariant every song holds once folded. Callers that own annotation
 *  documents must pass a nonzero delta to `withShiftedBeatStamps` /
 *  `withShiftedSectionBeats` so the stamps keep meaning what they meant. */
export function withFoldedGridOffset<T extends SongInfo | null | undefined>(
  info: T,
): { info: T; deltaBeats: number } {
  const bpm = info?.bpm ?? 0;
  if (!info || !Number.isFinite(bpm) || bpm <= MIN_USABLE_BPM) return { info, deltaBeats: 0 };
  const beatsPerBar = beatsPerBarFromTimeSignature(info.timeSignature);
  const offset = info.gridOffset ?? 0;
  const bars = gridOffsetBarShift(offset, bpm, beatsPerBar);
  if (bars === 0) return { info, deltaBeats: 0 };
  const deltaBeats = bars * beatsPerBar;
  const folded: SongInfo = { ...info, gridOffset: foldGridOffset(offset, bpm, beatsPerBar) };
  if (info.beatOverrides && Object.keys(info.beatOverrides).length > 0) {
    folded.beatOverrides = shiftOverrideKeys(info.beatOverrides, deltaBeats);
  }
  return { info: folded as T, deltaBeats };
}

function shiftStamp(beat: number | undefined, deltaBeats: number): number | undefined {
  return typeof beat === 'number' && Number.isFinite(beat) ? beat + deltaBeats : beat;
}

/** Renumber every stamped beat by `deltaBeats` — the companion of a grid-offset
 *  fold. Times are untouched. */
export function withShiftedBeatStamps(
  doc: AnnotationLayersDocument, deltaBeats: number,
): AnnotationLayersDocument {
  if (!deltaBeats) return doc;
  return {
    ...doc,
    layers: doc.layers.map((layer) => {
      if (layer.type === 'lyrics') return layer;   // never stamped — see stampLayer
      return withItems(layer, itemsOf(layer).map((it) => {
        const beat = shiftStamp(it.beat, deltaBeats);
        const startBeat = shiftStamp(it.startBeat, deltaBeats);
        const endBeat = shiftStamp(it.endBeat, deltaBeats);
        return {
          ...it,
          ...(beat !== undefined ? { beat } : {}),
          ...(startBeat !== undefined ? { startBeat } : {}),
          ...(endBeat !== undefined ? { endBeat } : {}),
        };
      }));
    }),
  };
}

// ─── Beats win: re-time onto the new grid ───────────────────────────────────

function retimeLayer(layer: AnnotationLayer, from: BeatGrid, to: BeatGrid): AnnotationLayer {
  if (layer.type === 'lyrics') return layer;
  const items = itemsOf(layer).map((it) => {
    if (typeof it.time === 'number') {
      const time = retimeWithStamp(it.time, it.beat, from, to);
      return {
        ...it,
        time,
        beat: timeToBeat(time, to),
        ...(Array.isArray(it.candidates)
          ? { candidates: (it.candidates as number[]).map((c) => retime(c, from, to)) }
          : {}),
      };
    }
    if (typeof it.start === 'number' && typeof it.end === 'number') {
      const start = retimeWithStamp(it.start, it.startBeat, from, to);
      const end = retimeWithStamp(it.end, it.endBeat, from, to);
      return {
        ...it,
        start,
        end: Math.max(end, start),   // a tempo change must not invert an interval
        startBeat: timeToBeat(start, to),
        endBeat: timeToBeat(Math.max(end, start), to),
        ...(Array.isArray(it.candidates)
          ? {
              candidates: (it.candidates as [number, number][]).map(([s, e]) => {
                const rs = retime(s, from, to);
                return [rs, Math.max(retime(e, from, to), rs)] as [number, number];
              }),
            }
          : {}),
      };
    }
    return it;
  });
  return withItems(layer, items);
}

export function retimedDocument(
  doc: AnnotationLayersDocument,
  from: BeatGrid | null,
  to: BeatGrid | null,
): AnnotationLayersDocument {
  if (!from || !to) return doc;
  return { ...doc, layers: doc.layers.map((l) => retimeLayer(l, from, to)) };
}

// ─── Beats win, from the stored stamp ───────────────────────────────────────
//
// Under Grid Lock the saved beat is the annotation's real position, so the
// seconds are re-derived from it against whatever grid is in force now. Items
// with no stamp (saved before this existed, or placed while the song had no
// usable grid) are left exactly as they are — a missing beat is not a zero.

function timesFromBeats(layer: AnnotationLayer, g: BeatGrid): AnnotationLayer {
  if (layer.type === 'lyrics') return layer;
  const items = itemsOf(layer).map((it) => {
    if (typeof it.beat === 'number' && Number.isFinite(it.beat)) {
      return { ...it, time: Math.max(0, beatToTime(it.beat, g)) };
    }
    if (typeof it.startBeat === 'number' && Number.isFinite(it.startBeat)) {
      const start = Math.max(0, beatToTime(it.startBeat, g));
      const end = typeof it.endBeat === 'number' && Number.isFinite(it.endBeat)
        ? Math.max(beatToTime(it.endBeat, g), start)
        : it.end;
      return { ...it, start, end };
    }
    return it;
  });
  return withItems(layer, items);
}

export function withTimesFromBeats(
  doc: AnnotationLayersDocument,
  g: BeatGrid | null,
): AnnotationLayersDocument {
  if (!g) return doc;
  return { ...doc, layers: doc.layers.map((l) => timesFromBeats(l, g)) };
}

/** How many stamped items sit at a time that no longer matches their beat —
 *  i.e. how much the grid has drifted away from the song's musical intent
 *  since these annotations were last written. Zero means the two coordinates
 *  already agree and nothing needs re-deriving. */
export function countStaleTimes(
  doc: AnnotationLayersDocument | null | undefined,
  g: BeatGrid | null,
): number {
  if (!g) return 0;
  const stale = (beat: unknown, t: unknown) => (
    typeof beat === 'number' && Number.isFinite(beat)
    && typeof t === 'number'
    && Math.abs(beatToTime(beat, g) - t) > EPSILON_SEC
  );
  let n = 0;
  for (const layer of doc?.layers ?? []) {
    if (layer.type === 'lyrics') continue;
    for (const it of itemsOf(layer)) {
      if (stale(it.beat, it.time) || stale(it.startBeat, it.start) || stale(it.endBeat, it.end)) n++;
    }
  }
  return n;
}

// ─── How much would actually move? ──────────────────────────────────────────

/** Number of individual timestamps that would land somewhere new if musical
 *  position were preserved across this grid change. Drives the modal's copy —
 *  "37 annotations" is the difference between an informed choice and a shrug. */
export function countRetimed(
  doc: AnnotationLayersDocument | null | undefined,
  from: BeatGrid | null,
  to: BeatGrid | null,
): number {
  if (!from || !to) return 0;
  const moved = (t: number) => Math.abs(retime(t, from, to) - t) > EPSILON_SEC;
  let n = 0;
  for (const layer of doc?.layers ?? []) {
    if (layer.type === 'lyrics') continue;
    for (const it of itemsOf(layer)) {
      if (typeof it.time === 'number') { if (moved(it.time)) n++; continue; }
      if (typeof it.start === 'number' && typeof it.end === 'number') {
        if (moved(it.start) || moved(it.end)) n++;
      }
    }
  }
  return n;
}
