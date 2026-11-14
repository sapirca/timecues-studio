// Beats on disk, seconds in memory.
//
// Under Grid Lock an annotation IS its musical position — "the third 16th of
// bar 9" — and its seconds are only where that position falls on the current
// grid. So a layers file saved under Grid Lock stores the position alone
// (`timebase: 'beats'`): a stamped item keeps `beat` / `startBeat` / `endBeat`
// and loses `time` / `start` / `end`. The file always carries the grid it was
// counted on (`grid`: bpm, offset, meter, and the tempo map), because a beat
// number means nothing without one.
//
// Everything that reads a layers file turns the beats back into seconds on
// read, with this module (TypeScript: the app, the exporter) or its twin
// tools/python/layers_timebase.py (evaluation, detectors). The app never holds
// a beats-only item: `loadLayersForEdit` hydrates, `saveLayers` strips again.
//
// What stays in seconds, on purpose: lyrics (never stamped — a sung word is
// timed to the voice, not the grid) and the fields that describe the SOUND
// rather than its place — a cue's `decay`, an `envelope`, a prominence
// envelope's item-relative `t`. Those are pinned to the audio; re-fitting the
// grid must not move them.
//
// One more rule, for files written by something that does not speak beats
// (e.g. an external sync tool that writes `time` / `start`): in a beats file, an item that DOES
// carry seconds was edited by such a writer, so its seconds win and its beat
// is re-read from them. The app itself never writes seconds for a stamped
// item into a beats file, so this never overrides one of its own marks.

import type {
  AnnotationLayer, AnnotationLayersDocument, LayersGrid, LayersGridTempo,
} from '../types/annotationLayer';
import type { SongInfo } from '../types/songInfo';
import { effectiveGridMode } from '../types/songInfo';
import { beatsPerBarFromTimeSignature, roundTime } from './beatGrid';
import { resolveGridSegments } from './gridSegments';
import {
  BEAT_FRACTION_STEPS, beatToTime, gridOf, stampBeat, type BeatGrid,
} from './beatAnchoring';

/** The song's grid as a layers file records it, or null when it has none
 *  (no usable BPM — then nothing can be stored as beats). */
export function layersGridOf(info: SongInfo | null | undefined): LayersGrid | null {
  const g = gridOf(info);
  if (!g || !info) return null;
  const segments = resolveGridSegments(info);
  const tempoMap: LayersGridTempo[] = segments.length > 1
    ? segments.map((s) => ({ beat: s.beatIndexOffset, time: s.start, bpm: s.bpm }))
    : [{ beat: 0, time: g.gridOffset, bpm: g.bpm }];
  return {
    bpm: g.bpm,
    gridOffset: g.gridOffset,
    timeSignature: info.timeSignature || '4/4',
    beatsPerBar: beatsPerBarFromTimeSignature(info.timeSignature),
    gridMode: effectiveGridMode(info),
    tempoMap,
  };
}

function usableMap(grid: LayersGrid | null | undefined): LayersGridTempo[] | null {
  const m = grid?.tempoMap;
  if (!Array.isArray(m) || m.length === 0) return null;
  return m.every((e) => Number.isFinite(e.beat) && Number.isFinite(e.time) && e.bpm > 0) ? m : null;
}

/** Seconds of a beat on a stored tempo map, rounded like every app time. */
export function tempoMapTime(grid: LayersGrid, beat: number): number {
  const m = usableMap(grid);
  if (!m) return NaN;
  let e = m[0];
  for (const x of m) { if (beat >= x.beat) e = x; else break; }
  return roundTime(e.time + (beat - e.beat) * (60 / e.bpm));
}

/** The beat a time falls on, on a stored tempo map — the exact grid fraction
 *  when within a millisecond of one, as `stampBeat` does. */
export function tempoMapBeat(grid: LayersGrid, t: number): number {
  const m = usableMap(grid);
  if (!m) return NaN;
  let e = m[0];
  for (const x of m) { if (t >= x.time - 1e-6) e = x; else break; }
  const perSec = e.bpm / 60;
  const b = e.beat + (t - e.time) * perSec;
  const step = Math.round(b * BEAT_FRACTION_STEPS) / BEAT_FRACTION_STEPS;
  return Math.abs(step - b) <= 0.001 * perSec ? step : Number(b.toFixed(6));
}

/** Record the song's grid on the document, and choose how it is stored:
 *  beats when the song is under Grid Lock and has a grid, seconds otherwise.
 *  Called by the editor on every save, with the song in front of it. */
export function withSongGrid(
  doc: AnnotationLayersDocument, info: SongInfo | null | undefined,
): AnnotationLayersDocument {
  const grid = layersGridOf(info);
  const next: AnnotationLayersDocument = { ...doc };
  if (grid) next.grid = grid; else delete next.grid;
  if (grid && info?.annotatorGridMode === true) next.timebase = 'beats';
  else delete next.timebase;
  return next;
}

// The item union has a point shape (`time`) and a range shape (`start`/`end`);
// these transforms are uniform across both, so they work on a structural view.
type TimedItem = {
  time?: number; beat?: number;
  start?: number; end?: number; startBeat?: number; endBeat?: number;
  candidates?: number[] | [number, number][];
};

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function mapItems(
  doc: AnnotationLayersDocument, f: (it: TimedItem) => TimedItem,
): AnnotationLayersDocument {
  return {
    ...doc,
    layers: doc.layers.map((layer) => (layer.type === 'lyrics'
      ? layer
      : { ...layer, items: (layer.items as unknown as TimedItem[]).map(f) } as unknown as AnnotationLayer)),
  };
}

function mapCandidates(
  c: TimedItem['candidates'], f: (v: number) => number,
): TimedItem['candidates'] {
  if (!Array.isArray(c)) return c;
  return (c as unknown[]).map((v) => (Array.isArray(v)
    ? [f(v[0] as number), f(v[1] as number)]
    : f(v as number))) as TimedItem['candidates'];
}

/**
 * The form a document is written to disk in. A seconds document (no
 * `timebase`) goes as it is. A beats document drops the seconds of every
 * stamped item and turns its candidates into beats. A beats document with no
 * usable grid is written as seconds rather than as numbers nobody can place.
 */
export function toStoredLayers(doc: AnnotationLayersDocument): AnnotationLayersDocument {
  if (doc.timebase !== 'beats') return doc;
  const grid = doc.grid;
  if (!grid || !usableMap(grid)) {
    const next = { ...doc };
    delete next.timebase;
    return next;
  }
  return mapItems(doc, (it) => {
    if (finite(it.beat)) {
      const out = { ...it, candidates: mapCandidates(it.candidates, (s) => tempoMapBeat(grid, s)) };
      delete out.time;
      if (out.candidates === undefined) delete out.candidates;
      return out;
    }
    if (finite(it.startBeat) && finite(it.endBeat)) {
      const out = { ...it, candidates: mapCandidates(it.candidates, (s) => tempoMapBeat(grid, s)) };
      delete out.start;
      delete out.end;
      if (out.candidates === undefined) delete out.candidates;
      return out;
    }
    return it;
  });
}

/**
 * Seconds for every item of a beats document — the read side of
 * `toStoredLayers`. `current` is the grid the song has NOW, for a reader that
 * knows it (the exporter): under Grid Lock the beat is the annotation, so its
 * seconds belong to today's grid. Without it the file's own grid is used,
 * which is where the marks sat when it was saved (the editor then re-aligns
 * them to a grid that has moved since, as it always has). Seconds documents
 * come back unchanged. Throws on a beats document with no grid to read it by,
 * rather than handing back items with no place.
 */
export function withSecondsFromBeats(
  doc: AnnotationLayersDocument, current?: BeatGrid | null,
): AnnotationLayersDocument {
  if (doc.timebase !== 'beats') return doc;
  const stored = doc.grid && usableMap(doc.grid) ? doc.grid : null;
  if (!current && !stored) throw new Error('layers file stores beats but carries no grid');
  const toSec = (b: number) => (current ? Math.max(0, beatToTime(b, current)) : Math.max(0, tempoMapTime(stored!, b)));
  const toBeat = (t: number) => (current ? stampBeat(t, current) : tempoMapBeat(stored!, t));
  return mapItems(doc, (it) => {
    if (finite(it.beat)) {
      if (finite(it.time)) return { ...it, beat: toBeat(it.time) };   // written by a seconds-only tool
      const out = { ...it, time: toSec(it.beat) };
      if (it.candidates) out.candidates = mapCandidates(it.candidates, toSec);
      return out;
    }
    if (finite(it.startBeat)) {
      if (finite(it.start)) {
        return {
          ...it,
          startBeat: toBeat(it.start),
          ...(finite(it.end) ? { endBeat: toBeat(it.end) } : {}),
        };
      }
      const start = toSec(it.startBeat);
      const end = finite(it.endBeat) ? Math.max(toSec(it.endBeat), start) : start;
      const out = { ...it, start, end };
      if (it.candidates) out.candidates = mapCandidates(it.candidates, toSec);
      return out;
    }
    return it;
  });
}
