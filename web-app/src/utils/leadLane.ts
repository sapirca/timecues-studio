/**
 * The Prominence lane — a cross-layer, top-down view of who sits where in the
 * mix, tier by tier: Lead, Counter, Backing, Silent.
 *
 * Per-item `prominence` envelopes stay the ONLY stored state. This module is
 * pure derivation over them plus one write helper, so the lane can never
 * disagree with the bands: there is no second source of truth to desync.
 *
 * Two things live here:
 *
 *  - `levelRegions` — reads every durational item in every annotator layer and
 *    splits the track into stretches holding a constant set of items at one
 *    level. That set can be empty (nobody is there) or hold more than one item:
 *    on the `lead` tier two lines genuinely can share the front (call-and-
 *    response, a doubled hook, unison stabs), so the lane reports a shared
 *    front rather than forbidding it. `leadRegions` is the `lead` tier.
 *
 *  - `assignLeadOverRange` — "over bars 17–24, the vocal leads". Exclusivity is
 *    structural here: one winner is picked, so everyone else who was leading in
 *    that range is demoted in the same edit.
 *
 * Lyrics layers join through `utils/vocalRuns.ts` rather than through their
 * items. A word is an instant with no arc to run over, and several hundred of
 * them on the Lead tier is not a readout of anything — so the voice contributes
 * one candidate per SUNG STRETCH, and an un-annotated stretch reads `lead`,
 * which is what a vocal is until somebody says otherwise. That default is
 * derived, never written: it puts the voice on the Lead tier beside whatever
 * instrumental item is already there (`levelRegions` has always allowed a
 * shared front) and demotes nothing. Handing the voice the front for real still
 * goes through `assignLeadOverRange`, as an edit the annotator asked for.
 *
 * Read-only detector layers are excluded. Their items are re-derived from a
 * cached envelope on every render and are not the annotator's to edit, so a
 * demote written into one would be silently discarded.
 *
 * Hidden layers ARE included. Hiding a layer is a canvas-clutter control, not a
 * statement about the annotation; deriving over visible layers only would let a
 * hidden item hold a lead that the lane claims is free, and a later assignment
 * would then leave two unreconciled leads on disk.
 */

import {
  PROMINENCE_EPSILON,
  normalizeProminence,
  prominenceAt,
  type AnnotationLayer,
  type LyricsItem,
  type ProminenceEnvelope,
  type ProminenceLevel,
  type ProminencePoint,
  type VocalRun,
} from '../types/annotationLayer';
import { resolveVocalRuns, type VocalRunGrid, type VocalRunOptions } from './vocalRuns';

/** Layer types whose items carry a prominence envelope. Instants (cues,
 *  boundaries) have no duration for an arc to run over. Lyrics are the one
 *  instant kind that still contributes — not per item, but per sung stretch;
 *  see `PROMINENCE_LAYER_TYPES`. */
export const DURATIONAL_LAYER_TYPES = ['spans', 'loops', 'riff-patterns'] as const;
export type DurationalLayerType = (typeof DURATIONAL_LAYER_TYPES)[number];

/** Everything that reaches the Prominence lane: the durational kinds by item,
 *  plus lyrics by vocal run. */
export type ProminenceLayerType = DurationalLayerType | 'lyrics';

export interface LeadCandidate {
  layerId: string;
  layerName: string;
  layerType: ProminenceLayerType;
  /** The layer's colour, so a lane block is traceable back to its row. */
  color: string;
  itemId: string;
  /** What to call this item on screen: its own label, or — when that is blank
   *  or an auto-generated placeholder — the layer's name. Most durational
   *  items are never labelled individually; the part is named once, on the
   *  layer ("Chello parts", "Contra Bass (Riff)"), and repeating that name is
   *  far more use than a lane full of "(unlabeled)". Never empty. */
  label: string;
  /** The placeholder `label` stepped over ("Instance 5"), when there was one —
   *  or, for a vocal run, its opening words. Neither names the part, but both
   *  say WHICH occurrence this is, so they stay available as a secondary
   *  detail. */
  placeholder?: string;
  start: number;
  /** End of the stretch the item's envelope covers, in track seconds. For
   *  riff-patterns that is the end of the REPEATED region
   *  (`start + repeatCount × cycle`), not of one cycle — matching how their
   *  `prominence` `t` is defined. */
  end: number;
  prominence?: ProminenceEnvelope;
  /** Present on a lyrics candidate: the whole layer's resolved run list, which
   *  a write has to carry because the runs may not be on disk yet. `itemId` is
   *  the run's id, not an item's. See `LeadPatch.runs`. */
  runs?: readonly VocalRun[];
}

interface DurationalItemShape {
  id: string;
  start: number;
  end: number;
  label?: string;
  repeatCount?: number;
  prominence?: ProminenceEnvelope;
}

/** End of the stretch an item's envelope spans. Riff patterns
 *  store one cycle in `[start, end]` and repeat it `repeatCount` times. */
function envelopeEndOf(item: DurationalItemShape): number {
  const cycle = item.end - item.start;
  if (cycle <= 0) return item.end;
  const reps = Math.max(1, Math.floor(item.repeatCount ?? 1));
  return item.start + reps * cycle;
}

/** Auto-generated riff-instance labels. `RiffPatternEditorPanel` names every
 *  new instance "Instance N" by position in the layer, and they are rarely
 *  renamed — the number is an index, not a name for what the instance plays. */
const PLACEHOLDER_LABEL = /^instance\s+\d+$/i;

function isDurational(type: string): type is DurationalLayerType {
  return (DURATIONAL_LAYER_TYPES as readonly string[]).includes(type);
}

/** Level a sung stretch reads as before anybody annotates it.
 *
 *  A vocal is the front of the mix until somebody says otherwise, so a run with
 *  no envelope of its own is shown leading rather than shown as unannotated.
 *  This is a READ-TIME default: nothing is written, nobody is demoted, and the
 *  lane simply draws the voice on the Lead tier beside whatever instrumental
 *  item was already claiming it. Resolving that shared front is what the
 *  handover is for. */
const VOCAL_DEFAULT: ProminenceEnvelope = Object.freeze([
  Object.freeze({ t: 0, level: 'lead' as const }),
]) as ProminenceEnvelope;

/** The first few words sung in a run — enough to tell two blocks apart without
 *  the block trying to reproduce the lyric. */
function openingWords(items: readonly LyricsItem[], run: VocalRun, max = 4): string | undefined {
  const words: string[] = [];
  for (const it of items) {
    if (it.time < run.start - PROMINENCE_EPSILON || it.time >= run.end) continue;
    const text = (it.text ?? '').trim();
    if (text) words.push(text);
    if (words.length >= max) break;
  }
  if (words.length === 0) return undefined;
  return words.join(' ') + (words.length >= max ? '\u2026' : '');
}

/** Every sung stretch on one lyrics layer, as lane candidates. */
function lyricsCandidates(
  layer: AnnotationLayer,
  grid: VocalRunGrid | undefined,
  opts: VocalRunOptions | undefined,
): LeadCandidate[] {
  const runs = resolveVocalRuns(layer, grid, opts);
  if (runs.length === 0) return [];
  const items = layer.items as readonly LyricsItem[];
  return runs.map((run) => ({
    layerId: layer.id,
    layerName: layer.name,
    layerType: 'lyrics' as const,
    color: layer.color,
    itemId: run.id,
    label: layer.name,
    placeholder: openingWords(items, run),
    start: run.start,
    end: run.end,
    prominence: run.prominence ?? VOCAL_DEFAULT,
    runs,
  }));
}

/** Flatten every prominence-carrying item the annotator owns into one list.
 *
 *  `grid` and `opts` only reach the lyrics layers, whose runs are derived from
 *  word timings against the bar grid. Omitting them still yields runs — just
 *  without bar-aligned edges. */
export function collectLeadCandidates(
  layers: readonly AnnotationLayer[] | undefined,
  grid?: VocalRunGrid,
  opts?: VocalRunOptions,
): LeadCandidate[] {
  if (!layers) return [];
  const out: LeadCandidate[] = [];
  for (const layer of layers) {
    if (layer.readOnly) continue;
    if (layer.type === 'lyrics') { out.push(...lyricsCandidates(layer, grid, opts)); continue; }
    if (!isDurational(layer.type)) continue;
    for (const raw of layer.items as readonly DurationalItemShape[]) {
      const end = envelopeEndOf(raw);
      if (!(end > raw.start)) continue;
      const own = (raw.label ?? '').trim();
      const placeholder = own && PLACEHOLDER_LABEL.test(own) ? own : undefined;
      out.push({
        layerId: layer.id,
        layerName: layer.name,
        layerType: layer.type,
        color: layer.color,
        itemId: raw.id,
        label: own && !placeholder ? own : layer.name,
        placeholder,
        start: raw.start,
        end,
        prominence: raw.prominence,
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Level in effect at track time `t`, or null when `t` is outside the item or
 *  the item carries no envelope. Unlike `prominenceAt`, this does NOT clamp to
 *  the ends — an item that has finished is not still leading. */
export function levelAtTrackTime(
  cand: Pick<LeadCandidate, 'start' | 'end' | 'prominence'>,
  t: number,
): ProminenceLevel | null {
  if (t < cand.start || t >= cand.end) return null;
  return prominenceAt(cand.prominence, t - cand.start)?.level ?? null;
}

export interface LeadRegion {
  start: number;
  end: number;
  /** Items reading the region's level across the whole of it. Never empty —
   *  see `levelRegions`. Named for the `lead` tier, which is the only one
   *  anything writes to; on the other tiers read it as "the items here". */
  leaders: LeadCandidate[];
}

/** The stretches where somebody sits at `level`, in track order.
 *
 *  Boundaries can only fall where something changes: an item's start or end, or
 *  one of its breakpoints. Between two consecutive boundaries the answer is
 *  constant, so each stretch is evaluated once at its midpoint.
 *
 *  Empty stretches are omitted rather than returned as regions with no items.
 *  The lane draws a block per region, and "nobody is here" is drawn by leaving
 *  the gap — an unannotated track then yields nothing at all instead of one
 *  track-long placeholder per level. */
export function levelRegions(
  candidates: readonly LeadCandidate[],
  duration: number,
  level: ProminenceLevel,
): LeadRegion[] {
  if (duration <= 0 || candidates.length === 0) return [];
  const marks = new Set<number>([0, duration]);
  for (const c of candidates) {
    if (c.start > 0 && c.start < duration) marks.add(c.start);
    if (c.end > 0 && c.end < duration) marks.add(c.end);
    for (const p of c.prominence ?? []) {
      const t = c.start + p.t;
      if (t > 0 && t < duration) marks.add(t);
    }
  }
  const edges = [...marks].sort((a, b) => a - b);

  const regions: LeadRegion[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const start = edges[i];
    const end = edges[i + 1];
    if (end - start <= PROMINENCE_EPSILON) continue;
    const mid = (start + end) / 2;
    const leaders = candidates.filter((c) => levelAtTrackTime(c, mid) === level);
    if (leaders.length === 0) continue;
    const prev = regions[regions.length - 1];
    // Merge with the previous stretch when the same items lead across both. A
    // leaderless gap in between leaves `prev.end < start`, so it never merges.
    if (prev && prev.end === start && sameLeaders(prev.leaders, leaders)) {
      prev.end = end;
      continue;
    }
    regions.push({ start, end, leaders });
  }
  return regions;
}

/** The `lead` tier — the one the handover writes to. Kept as its own name
 *  because everything that ASSIGNS reasons about the front specifically. */
export function leadRegions(
  candidates: readonly LeadCandidate[],
  duration: number,
): LeadRegion[] {
  return levelRegions(candidates, duration, 'lead');
}

function sameLeaders(a: readonly LeadCandidate[], b: readonly LeadCandidate[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.itemId === b[i].itemId);
}

/** Items alive anywhere in [t0, t1) — the pick-list for a range. */
export function leadCandidatesInRange(
  candidates: readonly LeadCandidate[],
  t0: number,
  t1: number,
): LeadCandidate[] {
  const lo = Math.min(t0, t1);
  const hi = Math.max(t0, t1);
  return candidates.filter((c) => Math.min(hi, c.end) - Math.max(lo, c.start) > PROMINENCE_EPSILON);
}

/** True when the item reads `lead` anywhere in [a, b). Checked at the range
 *  start and at every breakpoint inside it — the only places it can change. */
function leadsAnywhereIn(cand: LeadCandidate, a: number, b: number): boolean {
  if (!cand.prominence) return false;
  if (levelAtTrackTime(cand, a) === 'lead') return true;
  for (const p of cand.prominence) {
    const t = cand.start + p.t;
    if (t > a && t < b && levelAtTrackTime(cand, t) === 'lead') return true;
  }
  return false;
}

/** Write one flat `level` across [t0, t1] of a single item, leaving the rest of
 *  its envelope intact.
 *
 *  The level in effect just past the range is re-stated as a breakpoint at the
 *  range end, so an assignment stops exactly where the range stops instead of
 *  running to the item's end — that is what makes bar ranges composable. Items
 *  with no envelope at all have nothing to restore, so `fillOutside` supplies
 *  the level for the stretches the range doesn't cover. */
function writeLevelOverRange(
  cand: LeadCandidate,
  t0: number,
  t1: number,
  level: ProminenceLevel,
  fillOutside: ProminenceLevel,
): ProminenceEnvelope | undefined {
  const a = Math.max(t0, cand.start);
  const b = Math.min(t1, cand.end);
  if (b - a <= PROMINENCE_EPSILON) return cand.prominence;

  const itemDuration = cand.end - cand.start;
  const ra = a - cand.start;
  const rb = b - cand.start;
  const existing = cand.prominence;
  const before = prominenceAt(existing, ra)?.level ?? fillOutside;
  const after = prominenceAt(existing, rb)?.level ?? fillOutside;

  // The range gets one flat level, so anything previously inside it goes.
  const kept = (existing ?? []).filter(
    (p) => p.t < ra - PROMINENCE_EPSILON || p.t > rb + PROMINENCE_EPSILON,
  );
  const next: ProminencePoint[] = [...kept, { t: ra, level }];
  if (rb < itemDuration - PROMINENCE_EPSILON) next.push({ t: rb, level: after });
  // Without an anchor at t=0, `normalizeProminence` would drag the range's own
  // start back to zero and the assignment would swallow the item's whole head.
  if (ra > PROMINENCE_EPSILON && !kept.some((p) => p.t <= PROMINENCE_EPSILON)) {
    next.push({ t: 0, level: before });
  }
  return normalizeProminence(next);
}

export interface LeadPatch {
  layerId: string;
  /** An item's id, or — when `runs` is set — a vocal run's. */
  itemId: string;
  prominence: ProminenceEnvelope | undefined;
  /** Set when the target is a vocal run on a lyrics layer. Carries the layer's
   *  whole resolved run list because the runs may still be derived rather than
   *  stored: applying the patch is what materializes them, and it has to write
   *  every run at once so the ids stop depending on the word timings. The list
   *  here is the PRE-edit one; the applier overlays `prominence` onto `itemId`.
   *  Identical on every patch for the same layer, so an applier may take the
   *  first it sees. */
  runs?: readonly VocalRun[];
}

/** Attach the run list to a patch aimed at a vocal run. */
function patchFor(cand: LeadCandidate, prominence: ProminenceEnvelope | undefined): LeadPatch {
  return {
    layerId: cand.layerId,
    itemId: cand.itemId,
    prominence,
    ...(cand.runs ? { runs: cand.runs } : {}),
  };
}

function sameEnvelope(a: ProminenceEnvelope | undefined, b: ProminenceEnvelope | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Hand the front to `winnerItemId` across [t0, t1], demoting whoever held it.
 *
 *  Returns one patch per item that actually changes, for the caller to apply in
 *  a single document write (and therefore a single undo step).
 *
 *  The rules, in full:
 *
 *  - The winner reads `lead` across the range. Outside it, the winner keeps
 *    whatever it already said; an item with no envelope yet gets `counter`,
 *    because something that leads for part of a passage is a secondary line for
 *    the rest of it, not mere accompaniment.
 *  - Anyone else reading `lead` inside the range drops to `counter` there, and
 *    gets its previous level back at the range end. Demoting to `counter` (not
 *    `backing`) is the point of the feature: the part that just handed over is
 *    still a foreground line.
 *  - Items that never claimed the lead in the range are LEFT ALONE, envelope or
 *    not. Assigning the vocal the front must not promote every pad in the song
 *    from unannotated to `counter` — the lane annotates the front, not the back.
 *  - `winnerItemId === null` clears the range: everyone leading there drops to
 *    `counter` and nobody takes over.
 *
 *  There is deliberately no auto-restore past the range end for the demoted
 *  item. Whether the old lead comes back when the new one stops is a musical
 *  judgement — often the guitar stays behind for the rest of the song — so it
 *  is left to the annotator, who says so by assigning the next range. */
/** Put ONE item at `level` across [t0, t1], leaving everybody else exactly as
 *  they were.
 *
 *  This is the non-exclusive twin of `assignLeadOverRange`, and the difference
 *  is the whole reason both exist. The front is exclusive by construction — one
 *  winner, everyone else demoted in the same edit — but "the pad is Backing over
 *  these bars" says nothing about anyone else, so nothing else may be touched.
 *
 *  Use it to divide a Counter or Backing stretch: cut at a beat, then say what
 *  the item does from there. Handing an item the LEAD still goes through
 *  `assignLeadOverRange`, which is what demotes whoever held it. */
export function setLevelOverRange(
  candidates: readonly LeadCandidate[],
  itemId: string,
  t0: number,
  t1: number,
  level: ProminenceLevel,
): LeadPatch[] {
  const lo = Math.min(t0, t1);
  const hi = Math.max(t0, t1);
  if (hi - lo <= PROMINENCE_EPSILON) return [];
  const cand = candidates.find((c) => c.itemId === itemId);
  if (!cand) return [];
  const a = Math.max(lo, cand.start);
  const b = Math.min(hi, cand.end);
  if (b - a <= PROMINENCE_EPSILON) return [];

  // These edits start from a block the annotator can see, so the item always
  // has an envelope already and `fillOutside` never fires. It is the item's own
  // level at the range start regardless — the least surprising thing to leave
  // behind on a stretch the edit does not cover.
  const fillOutside = prominenceAt(cand.prominence, Math.max(0, a - cand.start))?.level ?? level;
  const next = writeLevelOverRange(cand, lo, hi, level, fillOutside);
  if (sameEnvelope(next, cand.prominence)) return [];
  return [patchFor(cand, next)];
}

export function assignLeadOverRange(
  candidates: readonly LeadCandidate[],
  t0: number,
  t1: number,
  winnerItemId: string | null,
): LeadPatch[] {
  const lo = Math.min(t0, t1);
  const hi = Math.max(t0, t1);
  if (hi - lo <= PROMINENCE_EPSILON) return [];

  const patches: LeadPatch[] = [];
  for (const cand of candidates) {
    const a = Math.max(lo, cand.start);
    const b = Math.min(hi, cand.end);
    if (b - a <= PROMINENCE_EPSILON) continue;

    const isWinner = cand.itemId === winnerItemId;
    if (!isWinner && !leadsAnywhereIn(cand, a, b)) continue;

    const next = writeLevelOverRange(cand, lo, hi, isWinner ? 'lead' : 'counter', 'counter');
    if (!sameEnvelope(next, cand.prominence)) {
      patches.push(patchFor(cand, next));
    }
  }
  return patches;
}

/**
 * Hand the front to the voice everywhere it sings, in one edit.
 *
 * The read-time default puts a vocal run on the Lead tier without touching
 * anybody — which means it sits there BESIDE whatever instrumental item was
 * already leading, as a shared front. That is the honest picture until somebody
 * decides, and deciding is this function: over each sung stretch the run takes
 * the lead outright and every other leader drops to `counter`, exactly as a
 * hand-made handover would.
 *
 * It is deliberately an action the annotator asks for rather than something the
 * lane does because a lyrics layer exists. Applying it can rewrite the envelope
 * of every instrumental item in the song, and an edit that large has to be one
 * the annotator chose and can undo in one step.
 *
 * Each run is resolved against the result of the previous ones, not against the
 * original document: two runs overlapping the same pad would otherwise each
 * compute a patch from the pad's untouched envelope, and the second would
 * discard the first.
 */
export function assignVocalLeadEverywhere(
  candidates: readonly LeadCandidate[],
  layerId: string,
): LeadPatch[] {
  const runs = candidates.filter((c) => c.layerId === layerId && c.runs);
  if (runs.length === 0) return [];

  const working: LeadCandidate[] = candidates.map((c) => ({ ...c }));
  for (const run of runs) {
    for (const patch of assignLeadOverRange(working, run.start, run.end, run.itemId)) {
      const target = working.find((x) => x.layerId === patch.layerId && x.itemId === patch.itemId);
      if (target) target.prominence = patch.prominence;
    }
  }

  const out: LeadPatch[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const cand = working[i];
    // The voice's own runs are patched even when the level did not move. Before
    // this action a run reading `lead` was a READING of an un-annotated voice;
    // after it, it is a decision — and the demotions just written into the other
    // parts are cut to these run boundaries, so the boundaries have to stop
    // being derived. Emitting the patch is what makes the applier store the run
    // list, ids and all. Without it a later lyric correction would reshape the
    // runs out from under demotions that no longer line up with anything.
    const isOwnRun = cand.layerId === layerId && !!cand.runs;
    if (isOwnRun || !sameEnvelope(cand.prominence, candidates[i].prominence)) {
      // Never hand the shared default array on to a document write.
      out.push(patchFor(cand, cand.prominence ? [...cand.prominence] : undefined));
    }
  }
  return out;
}
