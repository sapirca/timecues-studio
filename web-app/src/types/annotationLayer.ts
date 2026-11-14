/**
 * User-created annotation layers (Cues today; Spans/Lyrics later).
 *
 * These sit alongside the fixed Manual / Eye / AutoGuess tracks on the canvas.
 * Multiple layers of the same type can coexist on a song — e.g. "Kick hits"
 * and "FX triggers" are both Cue layers but render on separate rows with
 * separate items.
 *
 * Persistence: one file per song per annotator at
 *   data/annotations/layers/<annotator>/<slug>.json
 * served by /api/annotation-layers/:slug — see tools/python/custom_server.py.
 */

/** Built-in annotation paradigms. Extensible via the registry in annotations/.
 *
 *  - `boundaries` — section starts that TILE the track: item `i` runs until
 *    item `i+1`, so ends are derived rather than stored. Multiple boundary
 *    layers coexist on a song (a second reading of the structure is a second
 *    layer), exactly like Cues or Spans.
 *  - `cues`   — single timestamped events (shipped).
 *  - `spans`  — labeled intervals that may overlap (shipped).
 *  - `lyrics` — word/line lyric timestamps (deferred — needs Whisper/WhisperX).
 *  - `loops`  — grid-aware seamless-playback regions for auditioning N-bar
 *    phrases.
 */
export type AnnotationLayerType = 'boundaries' | 'cues' | 'spans' | 'lyrics' | 'loops' | 'riff-patterns';

/** The per-layer snap value stored on disk. Nothing reads it any more: every
 *  type but lyrics snaps to the grid unit shown in the toolbar, and lyrics are
 *  never snapped at all — a sung word is timed to the voice, and its offset
 *  from the beat is the phrasing. Kept so existing files round-trip unchanged. */
export type SnapMode = 'off' | 'magnetic' | 'bar' | 'beat' | '1/2beat' | '1/4beat';

/** Workflow status shown in the shared annotation toolbar pill.
 *  Distinct from the `AnnotationStatus` sidecar in manualAnnotation.ts (which
 *  is a per-slug metadata bundle). This is the storage union — legacy
 *  `ready_for_review` files still load but resave as `in_progress` on next
 *  user change. Live UI display is derived via `derivePillDisplay` below. */
export type AnnotationStage = 'in_progress' | 'ready_for_review' | 'reviewed';

/** What the user sees on the workflow pill. Three states, derived from
 *  (`hasItems` × stored `AnnotationStage`) by `derivePillDisplay`. */
export type AnnotationPillDisplay = 'not_started' | 'in_progress' | 'reviewed';

/** Single source of truth for "what label does the status pill show?" — used
 *  by the editor's StatusPill AND the sidebar popover so they can never
 *  disagree. Rule:
 *    !hasItems                         → 'not_started' (overrides storage —
 *                                        deleting every marker resets the
 *                                        workflow even if the file still
 *                                        says `reviewed`)
 *    hasItems && stage === 'reviewed'  → 'reviewed'
 *    otherwise                         → 'in_progress' (collapses legacy
 *                                        `ready_for_review` storage values) */
export function derivePillDisplay(
  hasItems: boolean,
  stage: AnnotationStage | undefined,
): AnnotationPillDisplay {
  if (!hasItems) return 'not_started';
  if (stage === 'reviewed') return 'reviewed';
  return 'in_progress';
}

/** Per-layer-type workflow status. Lives on AnnotationLayersDocument so every
 *  layer kind sharing the same document carries its own pill independently. */
export type LayerStatusByType = Partial<Record<AnnotationLayerType, AnnotationStage>>;

// ─── Item shapes (one per paradigm) ─────────────────────────────────────────

/** Per-item importance flag — mirrors SectionBlock.importance. Omitted ⇒
 *  treated as 'critical'. Optional items are surfaced with a hollow ☆ star
 *  and may be excluded from critical-only evaluation downstream. */
export type ItemImportance = 'critical' | 'optional';

// ─── Prominence (front / back) ──────────────────────────────────────────────

/** How far forward in the mix a part sits at a given moment.
 *
 *  This is the score-notation idea Schoenberg wrote as Hauptstimme (principal
 *  voice, `H`) / Nebenstimme (secondary voice, `N`) — a bracket over *part* of
 *  a line marking where it takes the lead and where it releases it. A guitar
 *  figure often enters as the lead and then drops back the moment the vocal
 *  arrives; without this the annotator has to split one musical gesture into
 *  several spans and loses the "same part throughout" identity.
 *
 *  Deliberately ordinal rather than a free 0–100% curve: four buckets are
 *  annotatable by ear and comparable across annotators, whereas a continuous
 *  percentage has no reliable ground truth (nobody agrees on 60% vs 75%) and
 *  agreement metrics would degrade to RMSE on a subjective scale. The `weight`
 *  in PROMINENCE_INFO leaves the door open to relaxing to continuous values
 *  later without a schema change. */
export type ProminenceLevel = 'lead' | 'counter' | 'backing' | 'silent';

/** Front-to-back order. Index doubles as the row index in the editor lane. */
export const PROMINENCE_LEVELS = ['lead', 'counter', 'backing', 'silent'] as const;

/** UI label, compact chip text, and the numeric weight that drives render
 *  alpha / fill height. Weights are evenly spaced so a `ramp` between any two
 *  adjacent levels reads as the same visual distance. */
export const PROMINENCE_INFO: Record<ProminenceLevel, {
  label: string;
  short: string;
  weight: number;
  description: string;
}> = {
  lead:    { label: 'Lead / Primary Melody',           short: 'Lead',    weight: 1,
             description: 'The main tune, vocal, or lead hook at the front of the mix.' },
  counter: { label: 'Counter-melody / Secondary Line', short: 'Counter', weight: 0.66,
             description: 'A complementary melody or response line that supports the lead without stealing full focus.' },
  backing: { label: 'Accompaniment / Background',      short: 'Backing', weight: 0.33,
             description: 'Chords, basslines, rhythm tracks, and pads filling out the harmony and groove.' },
  silent:  { label: 'Mute / Rest',                     short: 'Silent',  weight: 0,
             description: 'The track or voice is not playing.' },
};

/** One breakpoint in an item's prominence envelope. */
export interface ProminencePoint {
  /** Seconds relative to the ITEM's own start — NOT track start. Item-relative
   *  so that moving a whole item (useBodyMoveDrag) or dragging its end edge
   *  leaves the envelope correct for free, and a duplicated item carries its
   *  arc intact. Only a start-edge resize needs a fix-up; see
   *  `shiftProminenceForStartEdge`. */
  t: number;
  level: ProminenceLevel;
  /** How this level is reached from the previous point. `'step'` (default) is
   *  an instant switch; `'ramp'` linearly crossfades the weights across the
   *  gap — "the guitar eases back as the vocal enters". Meaningless on the
   *  first point (nothing to arrive from) and ignored there. */
  ramp?: 'step' | 'ramp';
}

/** Prominence envelope carried by every durational item kind. Absent means the
 *  item simply has no prominence annotation, which renders exactly as it did
 *  before this field existed — that is why it is optional rather than
 *  defaulted, and why no loader migration is needed. */
export type ProminenceEnvelope = ProminencePoint[];

/** Two breakpoints closer than this (seconds) are the same breakpoint. Also
 *  the minimum gap the drag handles are clamped to, so points can't stack. */
export const PROMINENCE_EPSILON = 0.01;

/** Sort, clamp, drop redundant neighbours, and anchor the first point at t=0.
 *  Called on every write so no reader has to defend itself against a malformed
 *  envelope. Returns `undefined` for an empty/absent envelope so "not
 *  annotated" has exactly one representation on disk. */
export function normalizeProminence(
  points: readonly ProminencePoint[] | undefined,
): ProminenceEnvelope | undefined {
  if (!points || points.length === 0) return undefined;
  const sorted = points
    .filter((p) => Number.isFinite(p.t) && p.level in PROMINENCE_INFO)
    .map((p) => ({ ...p, t: Math.max(0, p.t) }))
    .sort((a, b) => a.t - b.t);
  if (sorted.length === 0) return undefined;
  // The envelope has to start somewhere; the earliest point defines t=0.
  sorted[0] = { ...sorted[0], t: 0 };
  const out: ProminencePoint[] = [];
  for (const p of sorted) {
    const prev = out[out.length - 1];
    // Same level as the previous point contributes nothing — unless it lands
    // on the same instant, in which case the later one wins outright.
    if (prev && prev.t === p.t) { out[out.length - 1] = p; continue; }
    if (prev && prev.level === p.level && (p.ramp ?? 'step') === 'step') continue;
    out.push(p);
  }
  // The first point always steps in; a ramp there has nothing to ramp from.
  if (out[0].ramp) out[0] = { t: out[0].t, level: out[0].level };
  return out;
}

/** Level + weight in effect at `tRelative` seconds into the item.
 *
 *  `null` when the item has no prominence annotation. A `tRelative` before the
 *  first point or after the last reads as that point's level, so a playhead
 *  outside the item never falls off the ends. */
export function prominenceAt(
  points: readonly ProminencePoint[] | undefined,
  tRelative: number,
): { level: ProminenceLevel; weight: number } | null {
  if (!points || points.length === 0) return null;
  let idx = 0;
  for (let i = 0; i < points.length; i++) {
    if (points[i].t <= tRelative) idx = i; else break;
  }
  const cur = points[idx];
  const curWeight = PROMINENCE_INFO[cur.level].weight;
  const next = points[idx + 1];
  // A ramp is recorded on the point it ARRIVES AT, so the crossfade occupies
  // the segment before that point — the one we're currently inside. The level
  // still reads as the one being left (a part easing back is still the lead
  // until it has actually handed over); only the weight slides.
  if (!next || next.ramp !== 'ramp') return { level: cur.level, weight: curWeight };
  const span = next.t - cur.t;
  if (span <= 0 || tRelative <= cur.t) return { level: cur.level, weight: curWeight };
  const nextWeight = PROMINENCE_INFO[next.level].weight;
  const f = Math.max(0, Math.min(1, (tRelative - cur.t) / span));
  return { level: cur.level, weight: curWeight + (nextWeight - curWeight) * f };
}

/** Insert-or-replace the breakpoint at `tRelative`. The single mutation both
 *  authoring surfaces (popover buttons, band drag) funnel through.
 *
 *  The FIRST breakpoint of an empty envelope, placed anywhere past the start,
 *  brings an opening anchor with it. An envelope has to say what the level is
 *  from t=0 — there is no "unset" stretch inside an annotated item — so
 *  without one `normalizeProminence` would drag that first point back to the
 *  start, and a click at 0:12 would silently land at 0:00. `lead` is what the
 *  anchor gets: it's the shape the feature exists for ("in front, then drops
 *  back when the vocal enters"), and it's the reading a plain un-annotated
 *  band already has. Click on the Lead row instead and the two collapse back
 *  into one point, which is correct — the whole item leads. */
export function setProminenceAt(
  points: readonly ProminencePoint[] | undefined,
  tRelative: number,
  level: ProminenceLevel,
  ramp: 'step' | 'ramp' = 'step',
): ProminenceEnvelope | undefined {
  const t = Math.max(0, tRelative);
  const base = points && points.length > 0
    ? points
    : (t > PROMINENCE_EPSILON ? [{ t: 0, level: PROMINENCE_LEVELS[0] }] : []);
  const kept = base.filter((p) => Math.abs(p.t - t) > PROMINENCE_EPSILON);
  return normalizeProminence([...kept, { t, level, ...(ramp === 'ramp' ? { ramp } : {}) }]);
}

/** Flip breakpoint `index` between a hard switch and a crossfade. Per-point
 *  rather than a "next click is a ramp" mode, so both authoring surfaces (the
 *  popover chips and the band's breakpoint editor) can reach it and neither
 *  carries hidden state. Index 0 has nothing to arrive from, so it never ramps. */
export function toggleProminenceRamp(
  points: readonly ProminencePoint[] | undefined,
  index: number,
): ProminenceEnvelope | undefined {
  if (!points || index <= 0 || index >= points.length) return points as ProminenceEnvelope | undefined;
  const next = points.map((p, i) => {
    if (i !== index) return p;
    return p.ramp === 'ramp' ? { t: p.t, level: p.level } : { ...p, ramp: 'ramp' as const };
  });
  return normalizeProminence(next);
}

/** Drop the breakpoint at `index`. Index 0 is not protected — removing it
 *  simply promotes the next point to t=0 via `normalizeProminence`. Returns
 *  `undefined` once the last point goes, clearing the annotation. */
export function removeProminencePoint(
  points: readonly ProminencePoint[] | undefined,
  index: number,
): ProminenceEnvelope | undefined {
  if (!points) return undefined;
  return normalizeProminence(points.filter((_, i) => i !== index));
}

/** Re-anchor an envelope after the item's START edge moved by `deltaSeconds`
 *  (positive = start moved later, so the item got shorter at the front).
 *  Because `t` is item-relative, every point shifts the other way; points that
 *  fall off the front are dropped and the survivor is re-anchored at t=0 —
 *  which preserves the level that was in effect at the new start. */
export function shiftProminenceForStartEdge(
  points: readonly ProminencePoint[] | undefined,
  deltaSeconds: number,
): ProminenceEnvelope | undefined {
  if (!points || points.length === 0) return undefined;
  if (deltaSeconds === 0) return points as ProminenceEnvelope;
  const shifted = points.map((p) => ({ ...p, t: p.t - deltaSeconds }));
  // Whatever level was in effect at the new start becomes the new t=0 anchor.
  const survivors = shifted.filter((p) => p.t > PROMINENCE_EPSILON);
  const anchorSource = [...shifted].reverse().find((p) => p.t <= PROMINENCE_EPSILON) ?? shifted[0];
  const anchor: ProminencePoint = { t: 0, level: anchorSource.level };
  return normalizeProminence([anchor, ...survivors]);
}

/** Compact read-only summary for editor cards — "Lead", or "Lead → Backing"
 *  showing just the first and last distinct levels. `null` when unannotated. */
export function prominenceSummary(
  points: readonly ProminencePoint[] | undefined,
): string | null {
  if (!points || points.length === 0) return null;
  const first = PROMINENCE_INFO[points[0].level].short;
  const last = PROMINENCE_INFO[points[points.length - 1].level].short;
  return first === last && points.length === 1 ? first : `${first} → ${last}`;
}

/** Per-layer evaluation mode. Lives on `AnnotationLayer` (and on
 *  `ManualAnnotation` for boundaries) and is toggled by the annotator next to
 *  the importance-weight slider in the eval panel.
 *
 *  - `'full-annotation'` (default) — every gold item must be matched. Unmatched
 *    gold items are misses. Standard recall/precision semantics. Use when the
 *    annotator is committing to a complete, exhaustive labelling of the track.
 *  - `'multiple-candidates'` — the whole layer is treated as a set of
 *    *alternative* annotations for the same underlying truth. Matching ANY
 *    one item in the layer satisfies the layer; the rest are not penalised
 *    as misses. Use when the annotator is exploring alternatives and only ONE
 *    entry is the "right" answer at evaluation time.
 *
 *  This is layer-level, separate from per-item `candidates`. Both can coexist:
 *  candidates are alternates WITHIN one annotation; mode is alternates ACROSS
 *  the whole layer. See `deep_research/evaluation_notes.md` for the full
 *  contract. */
export type LayerEvalMode = 'full-annotation' | 'multiple-candidates';

/** One structural section start.
 *
 *  Boundaries TILE their layer: this item runs until the next item's `time`,
 *  so no end is stored. A layer therefore keeps its items sorted, and the
 *  trailing `unset`-typed item is the convention for "the music stops here"
 *  (see UNSET_TYPE in inspector-v2/sectionConstants.ts).
 *
 *  Tiling is per-layer — two boundary layers each cover the whole track with
 *  their own reading of the structure, which is what makes a second layer a
 *  second opinion rather than an overlap. */
export interface BoundaryItem {
  id: string;
  /** Section start, in seconds. Canonical. */
  time: number;
  /** Musical position: fractional beats from the grid origin, stamped from
   *  `time` whenever the song has a usable grid. Seconds stay canonical — the
   *  beat is what lets a grid edit offer "keep the bar.beat" alongside "keep
   *  the milliseconds". See utils/beatAnchoring.ts. */
  beat?: number;
  /** Section vocabulary key — intro | buildup | drop | … | unset. The active
   *  vocabulary is a user setting; see sectionConstants.getSectionTypes(). */
  type: string;
  /** Display name. Falls back to the type's label when empty. */
  label: string;
  /** Longer free-form note shown in the boundary edit popover. */
  description?: string;
  importance?: ItemImportance;
  /** Alternative valid start times. Under `multiple-candidates` eval mode any
   *  candidate within tolerance counts as a hit. */
  candidates?: number[];
  /** "#rrggbb" for this one item, overriding the section-type colour — set in the
   *  item's card, by a detector, or kept by Copy to manual layer. Optional. */
  color?: string;
}

/** A single timestamped event (kick hit, FX trigger, clap, lyric word). */
export interface CueItem {
  /** Stable identifier — uuid. */
  id: string;
  /** Seconds from track start. Frontend uses seconds; backend serializes ms. */
  time: number;
  /** Musical position: fractional beats from the grid origin, stamped from
   *  `time` whenever the song has a usable grid. Seconds stay canonical — this
   *  is what lets a grid edit offer "keep the bar.beat" as well as "keep the
   *  milliseconds". Absent on items saved before the grid existed. See
   *  utils/beatAnchoring.ts. */
  beat?: number;
  /** Short text rendered next to the tick on hover and in the editor list. */
  label: string;
  /** Longer free-form note shown only when the cue is selected in the editor. */
  description?: string;
  /** Critical (default, ★) vs. optional (☆). Missing ⇒ 'critical'. */
  importance?: ItemImportance;
  /** Alternative valid times in seconds. During evaluation any candidate within
   *  tolerance counts as a hit — mirrors SectionBlock.candidates. */
  candidates?: number[];
  /** How hard this hit was struck, 1-127, against the same instrument's
   *  hardest hit — the tick draws this tall. One field for every cue, however
   *  it got here: a detector fills it (a custom Cue's `velocity`), Copy to
   *  manual layer keeps it, and the cue card's Hit
   *  section sets it by hand. */
  velocity?: number;
  /** The hit's level against the loudest hit in the track, dB (<= 0). Unlike
   *  `velocity` this IS comparable across instruments. Same sources. */
  levelDb?: number;
  /** "#rrggbb" for this one tick, overriding the layer colour — e.g. one hue
   *  per drum. Same sources. */
  color?: string;
  /** MIDI note number, 0-127 (60 = middle C): the pitch of the hit. With
   *  `velocity`, everything a MIDI note-on needs. Same sources. */
  note?: number;
  /** How long the hit rings, seconds (> 0). A cue stays a point; this says
   *  flash vs. swell, and the lane draws it as a faint tail. Same sources. */
  decay?: number;
}

// ─── Pulse (rhythmic rate) ──────────────────────────────────────────────────

/** How fast a stretch of music is hitting — the rate its events land at, not
 *  where each one falls.
 *
 *  Expressed relative to the BEAT rather than to a note value, so it stays
 *  honest in any meter: in 6/8 the BPM counts an 8th note, which makes "1/2
 *  beat" a 16th there and an 8th in 4/4. Same strings (and the same beat-
 *  relative reading) as the viz bar's grid picker, `BEAT_GRID_UNIT_OPTIONS` —
 *  minus its multi-bar entries, which are phrase lengths rather than pulses:
 *  nothing *hits* every four bars. Sharing the vocabulary is what lets a pulse
 *  be handed straight to the grid renderer to draw.
 *
 *  A pulse is ONE value for a whole item and its ticks are DERIVED from the
 *  song's grid, never stored. That's the point of it: "eighths through here"
 *  stays true when the item's edges are trimmed, when the grid is re-fit, or
 *  when a tempo segment moves underneath it — where a frozen list of tick
 *  times would quietly become a lie about where the sound is. When the
 *  individual hits are the annotation (they're uneven, or each one means
 *  something), that's a Cues layer or a riff node, not a pulse. */
export const PULSE_RATES = [
  '32nd', '16th-triplet', '16th', '8th-triplet', '8th', 'beat', 'bar',
] as const;
/** A rate that actually ticks — everything the grid can draw marks for. */
export type PulseTickingRate = typeof PULSE_RATES[number];

/** Silence, as an answer rather than the absence of one. `undefined` means
 *  nobody has said what this stretch does; `'silent'` means somebody listened
 *  and there is nothing hitting here — a drop, a held pad under a cut drum
 *  track, the bar of air before the chorus. Those are worth annotating for
 *  exactly the reasons a rate is: a light show, a remixer or a model wants to
 *  know the stretch is empty on purpose, and "no pulse set" cannot say that.
 *
 *  It sits in `PulseRate` alongside the seven rates because it answers the
 *  same question, but never in `PULSE_RATES`, which is the list of things the
 *  grid can draw ticks for — silence is the one answer whose ticks are the
 *  empty set. */
export const PULSE_SILENT = 'silent';

export type PulseRate = PulseTickingRate | typeof PULSE_SILENT;

/** Every answer the picker offers, in chip order: fastest to slowest, then
 *  silence — which is the far end of that same scale, not a separate idea. */
export const PULSE_OPTIONS = [...PULSE_RATES, PULSE_SILENT] as const;

/** Whether `rate` is one of the seven that tick, narrowing for the helpers
 *  that need a period to work with. */
export function isTickingPulse(
  rate: PulseRate | undefined,
): rate is PulseTickingRate {
  return rate != null && rate !== PULSE_SILENT;
}

/** Full label (matching the viz bar's grid menu word for word, so the two
 *  can't drift into describing the same rate differently), the short form the
 *  chips and badges show, and how many beats one period lasts — `'bar'` alone
 *  depends on the meter and is resolved by `pulsePeriodBeats`. */
export const PULSE_RATE_INFO: Record<PulseRate, {
  label: string;
  short: string;
  /** Beats in one period. `null` for silence, which has no period. */
  beats: number | 'bar' | null;
  description: string;
  /** Standalone text for badges and the zoomed-out band chip. Spoken in
   *  beats, never note values: "1/4" beside a note glyph reads as a quarter
   *  note, which is one whole beat in 4/4 — four times slower than meant. */
  badge: string;
}> = {
  '32nd':         { label: '1/8 beat',           short: '1/8',  beats: 1 / 8,
                    description: 'Eight hits per beat — a 32nd-note roll or a fast tremolo.',
                    badge: '1/8 beat' },
  '16th-triplet': { label: '1/6 beat · triplet', short: '1/6T', beats: 1 / 6,
                    description: 'Six per beat — 16th triplets.',
                    badge: '1/6 beat' },
  '16th':         { label: '1/4 beat',           short: '1/4',  beats: 1 / 4,
                    description: 'Four per beat — 16ths in 4/4. The usual hi-hat/shaker rate.',
                    badge: '1/4 beat' },
  '8th-triplet':  { label: '1/3 beat · triplet', short: '1/3T', beats: 1 / 3,
                    description: 'Three per beat — 8th triplets, a shuffle or swung feel.',
                    badge: '1/3 beat' },
  '8th':          { label: '1/2 beat',           short: '1/2',  beats: 1 / 2,
                    description: 'Twice per beat — 8ths in 4/4.',
                    badge: '1/2 beat' },
  beat:           { label: 'Beat',               short: 'Beat', beats: 1,
                    description: 'Once per beat — the pulse you would tap along to.',
                    badge: '1 beat' },
  bar:            { label: 'Bar',                short: 'Bar',  beats: 'bar',
                    description: 'Once per bar — a downbeat stab or a whole-bar chord.',
                    badge: '1 bar' },
  silent:         { label: 'Silent',             short: 'Silent', beats: null,
                    description: 'Nothing hits here — a drop, a cut, a bar of air. Different from leaving the pulse unset, which only says nobody has listened yet.',
                    badge: 'Silent' },
};

/** How many beats one period of `rate` lasts. `'bar'` resolves against the
 *  meter; everything else is a fixed fraction of a beat. */
export function pulsePeriodBeats(rate: PulseTickingRate, beatsPerBar = 4): number {
  const beats = PULSE_RATE_INFO[rate].beats;
  if (beats == null) return 0;
  return beats === 'bar' ? Math.max(1, beatsPerBar) : beats;
}

/** Compact read-only summary for cards and tooltips — "1/2 beat", "Silent".
 *  `null` when the item carries no pulse at all, so callers can render nothing
 *  — which is the distinction the feature turns on: nothing drawn means
 *  unannotated, "Silent" means annotated as empty. */
export function pulseSummary(rate: PulseRate | undefined): string | null {
  return rate ? PULSE_RATE_INFO[rate].label : null;
}

/** A labeled time interval. May overlap with other spans on the same layer.
 *  Backend-supported but the user-facing UI lives behind a feature flag —
 *  see the Span TODO in tools/python/custom_api.py. */
export interface SpanItem {
  id: string;
  /** Seconds from track start. */
  start: number;
  /** Seconds from track start. Must be > start. */
  end: number;
  /** Musical position of `start` / `end`: fractional beats from the grid
   *  origin, stamped from the seconds whenever the song has a usable grid.
   *  Seconds stay canonical. See utils/beatAnchoring.ts. */
  startBeat?: number;
  endBeat?: number;
  label: string;
  description?: string;
  importance?: ItemImportance;
  /** Alternative valid `[start, end]` intervals. During evaluation, matching ANY
   *  candidate counts as a hit; the matched candidate is consumed (no
   *  double-count). Mirrors `SectionBlock.candidates` and `CueItem.candidates`. */
  candidates?: [number, number][];
  /** How far forward this part sits in the mix over its own duration. Sorted
   *  by `t`, first point at t=0. Absent ⇒ not annotated. See ProminencePoint. */
  prominence?: ProminenceEnvelope;
  /** The rate this stretch is hitting at — one value for the whole span, with
   *  its ticks derived from the song's grid rather than stored, or `'silent'`
   *  for a stretch that hits at no rate because nothing sounds in it. Absent ⇒
   *  not annotated, which renders exactly as it did before the field existed
   *  (so no loader migration is needed) and is NOT the same claim as
   *  `'silent'`. See PulseRate. */
  pulse?: PulseRate;
  /** "#rrggbb" for this one item, overriding the layer colour — set in the
   *  item's card, by a detector, or kept by Copy to manual layer. Optional. */
  color?: string;
  /** The span's sound as attack, decay, sustain and release — Extract ADSR on
   *  the span's card or its lane's ⋮. The same shape and rules as
   *  LyricsItem.envelope: pinned to the audio, deleted when the span is
   *  retimed (utils/soundEnvelopes.ts). */
  envelope?: SoundEnvelope;
}

/** Word- or line-level lyric timestamp. */
export interface LyricsItem {
  id: string;
  time: number;
  /** Where the lyric stops. Every lyric is a span — see withLyricSpans,
   *  which repairs one stored without a usable end when the layers load. */
  end?: number;
  text: string;
  kind: 'word' | 'line';
  /** Longer free-form note about this lyric — what it means, how it is sung,
   *  a translation. Shown in the lyric's edit popover; the text stays the
   *  label. */
  description?: string;
  /** Where each sound inside a word begins (seconds, song time), with the
   *  syllable sung there — none on an attack no syllable was laid on. A word
   *  holds one time; a sung `a-la-ta` begins three times. Pinned to the
   *  audio: moving or trimming the word does not move them, and only those
   *  inside [time, end] are drawn or exported. */
  onsets?: LyricsOnset[];
  /** The word's sound as attack, decay, sustain and release — Extract ADSR,
   *  read off the vocals stem. May start before `time` and ring on after
   *  `end`: the word is cut 20 dB under its peak, this is the whole sound.
   *  Pinned to the audio like `onsets`. */
  envelope?: SoundEnvelope;
}

export interface LyricsOnset {
  time: number;
  text?: string;
}

/** One sound's envelope, on a lyric or a span. Seconds, song time:
 *  start ≤ peak ≤ decayEnd ≤ release ≤ end. */
export interface SoundEnvelope {
  start: number;
  peak: number;
  decayEnd: number;
  release: number;
  end: number;
  /** The peak's level on the stem, dBFS. */
  peakDb: number;
  /** The sustain's level under the peak (dB, ≤ 0); absent on a sound that
   *  decays straight into its release. */
  sustainDb?: number;
  /** What it was read off — the mix or one stem. Absent on an envelope
   *  measured before the source was recorded. */
  source?: 'mix' | 'vocals' | 'drums' | 'bass' | 'other' | 'guitar' | 'piano';
  /** Set when the item holds several pulses (a gobble, a trill): how many.
   *  The envelope is then their outer shape taken together, not one hit's. */
  peaks?: number;
}

// A LoopItem is a labeled INTERVAL with grid-aware seamless-playback
// affordances. While labeling loops or sanity-checking that a structural
// boundary is clean, an annotator hears how an N-bar phrase loops back on
// itself — boundaries snap to bars and to zero-crossings so the rhythmic
// signature can be verified without manual slicing.
//
// The bars field is a UX convenience — store start/end in seconds (the
// canonical coordinate). bars is recomputed from the active BPM whenever
// the loop is rendered.
export interface LoopItem {
  id: string;
  /** Seconds from track start. */
  start: number;
  /** Seconds from track start. Must be > start. */
  end: number;
  /** Musical position of `start` / `end`: fractional beats from the grid
   *  origin, stamped from the seconds whenever the song has a usable grid.
   *  Seconds stay canonical. See utils/beatAnchoring.ts. */
  startBeat?: number;
  endBeat?: number;
  label: string;
  description?: string;
  /** Cached bar length (end - start, in bars) for quick display. Recompute on BPM change. */
  bars?: number;
  /** Whether to snap loop boundaries to zero-crossings during playback. */
  snapZeroCross?: boolean;
  importance?: ItemImportance;
  /** Alternative valid `[start, end]` intervals. Same semantics as
   *  `SpanItem.candidates`. */
  candidates?: [number, number][];
  /** "#rrggbb" for this one item, overriding the layer colour — set in the
   *  item's card, by a detector, or kept by Copy to manual layer. Optional. */
  color?: string;
  /** Prominence envelope over the loop's own duration. See ProminencePoint. */
  prominence?: ProminenceEnvelope;
}

/** Sub-beats per beat — each beat splits into this many "quarter-of-a-beat"
 *  steps (16th notes when a beat = quarter note). Steps per cycle = the song's
 *  beats-per-bar × this constant (16 for 4/4, 12 for 3/4, 20 for 5/4 …). */
export const PATTERN_SUBBEATS_PER_BEAT = 4;

/** Velocity a step draws at when it carries no accent — full strength. */
export const ACCENT_FULL = 127;

/** How opaque a struck step draws, 0..1. A ghost note has to stay clearly
 *  louder-looking than an EMPTY chip (which draws at 0.2), or the grid would
 *  say "nothing here" about a note that is played — so the floor is 0.45
 *  rather than 0.
 *
 *  The curve is not linear in velocity, because played hits are not spread
 *  evenly across 1..127. A detector measures level against the loudest hit in
 *  the track, and a mixed drum part lives in the top third of that scale — on
 *  a house track the kick came out 125..127, which a linear ramp drew as
 *  opacity 0.991..1.000, a difference no eye resolves. Weighting the ramp
 *  toward the loud end spends the contrast where the hits actually are; the
 *  same kick keeps its whole range and a ghost note still reads as a ghost. */
const ACCENT_CURVE = 1.8;

export function accentOpacity(velocity: number | undefined): number {
  if (velocity == null || !Number.isFinite(velocity)) return 1;
  const v = Math.max(1, Math.min(ACCENT_FULL, velocity));
  return 0.45 + 0.55 * Math.pow(v / ACCENT_FULL, ACCENT_CURVE);
}

/** How tall a struck step draws, 0..1 of the chip row.
 *
 *  Opacity is a weak channel at this size — a chip in a lane block is a few
 *  pixels wide, and a saturated colour at 0.77 against the same colour at 1.0
 *  is not a difference anyone reads. Height is the channel a piano roll has
 *  always used for velocity, and it survives being small: a step half as tall
 *  as its neighbour is obvious at a glance. Opacity still rides along, so the
 *  two reinforce rather than compete.
 *
 *  A step nobody measured draws full height — velocity is advisory, and a
 *  hand-drawn node must not look like a track of ghost notes. */
export function accentHeight(velocity: number | undefined): number {
  if (velocity == null || !Number.isFinite(velocity)) return 1;
  const v = Math.max(1, Math.min(ACCENT_FULL, velocity));
  return 0.3 + 0.7 * Math.pow(v / ACCENT_FULL, ACCENT_CURVE);
}

// ─── Riff-pattern types (nodes → combos → instances) ────────────────────────

/** Sentinel id for the built-in silence/empty node. Never in nodes[]; handled
 *  specially in the editor UI as the always-present first palette entry. */
export const RIFF_NODE_SILENCE_ID = '__silence__';

/** Auto-assign colors for riff nodes. Distinct from the layer-level palette. */
export const RIFF_NODE_COLORS = [
  '#f97316', '#22c55e', '#3b82f6', '#a855f7',
  '#ec4899', '#14b8a6', '#f59e0b', '#ef4444',
] as const;

/** First color in `palette` not already in `usedColors`, or a modulo fallback
 *  once the whole palette is taken. Shared by the node/combo pickers below and
 *  by the cross-layer rebalance migration (`migrateRiffColors` in
 *  services/annotationLayers.ts), which walks colors it's already assigned
 *  across earlier layers rather than a single layer's own node/combo list. */
export function pickFromPalette(palette: readonly string[], usedColors: Iterable<string>, fallbackIndex: number): string {
  const used = new Set(usedColors);
  for (const c of palette) if (!used.has(c)) return c;
  return palette[fallbackIndex % palette.length];
}

export function pickRiffNodeColor(existingNodes: RiffNode[]): string {
  return pickFromPalette(RIFF_NODE_COLORS, existingNodes.map((n) => n.color), existingNodes.length);
}

/** Auto-assign colors for riff combos. Alternating cool/warm so adjacent combos
 *  are visually distinct. */
export const RIFF_COMBO_COLORS = [
  '#818cf8', // indigo (cool)
  '#fb923c', // orange (warm)
  '#34d399', // emerald (cool)
  '#f472b6', // pink (warm)
  '#38bdf8', // sky (cool)
  '#facc15', // yellow (warm)
  '#a78bfa', // violet (cool)
  '#4ade80', // green (warm)
] as const;

export function pickRiffComboColor(existingCombos: RiffCombo[]): string {
  const used = existingCombos.map((c) => c.color).filter((c): c is string => Boolean(c));
  return pickFromPalette(RIFF_COMBO_COLORS, used, existingCombos.length);
}

/** A named riff figure: a line of notes on the node's own pulse. Leaf of the
 *  hierarchy — a pure library primitive with no timeline position of its own.
 *  Every place a node is *used* (in a Combo's or Riff's `sequence`) carries
 *  its own `lengthSteps`, so the same node can occupy a different duration in
 *  every occurrence without the node itself needing a position.
 *
 *  This is the only form a repeated figure takes — drawn by hand, copied from
 *  a detector, or returned by one. A play that differs from the node (a
 *  dropped hit, a fill) is not another node: it is an occurrence on the item
 *  that plays it (`RiffPatternItem.occurrences`). */
export interface RiffNode {
  id: string;
  name: string;
  color: string;
  /** Steps in the whole node at its own pulse: its length is
   *  `stepsPerCycle / subbeatsPerBeat` beats (`riffNodeLengthBeats`). Also
   *  this node's *natural* length when first placed in a sequence — see
   *  `defaultRiffEntryLength`. */
  stepsPerCycle: number;
  /** The node's pulse: steps per beat. 4 (sixteenths) by default; any whole
   *  number from 1 to 16 (1/64 notes) — see MAX_PULSE. Every note starts and ends on it. */
  subbeatsPerBeat: number;
  /** The notes: an ordered, gapless list of blocks covering
   *  `[0, riffNodeLengthBeats(node))` — a `tick` block is a note, an `empty`
   *  one a rest. See `RiffBoundarySegment`. */
  segments: RiffBoundarySegment[];
  /** What a musician would call the figure ("four on the floor"), when it has
   *  a name — set by a detector that recognised it. Usually absent. */
  names?: string[];
}

/** One block of a node — a half-open `[start, end)` interval in beats
 *  measured from the node's own start: a note (`tick`) or a rest (`empty`).
 *  A node's `segments` always tile its whole length end-to-end with no gaps
 *  and no overlaps (`normalizeBoundarySegments` enforces that), and every
 *  edge sits on the node's pulse:
 *
 *      [0   – 2  ] empty
 *      [2   – 2.5] tick
 *      [2.5 – 3  ] tick
 *      [3   – 4  ] empty
 *
 *  Two adjacent `tick` blocks are two separate hits, not one held note —
 *  the block's `end` is where that hit's slot stops, not a release time. */
export interface RiffBoundarySegment {
  /** Offset from the node's start, in beats. Fractional. */
  start: number;
  /** Offset from the node's start, in beats. Always `> start`. */
  end: number;
  /** `'tick'` = something sounds here, `'empty'` = a rest. */
  kind: 'tick' | 'empty';
  /** Optional free-text note for this block (e.g. "snare", "ghost"). */
  label?: string;
  /** MIDI pitch of the note this block plays, 0-127 (60 = middle C) — set
   *  when the block is a pitched note (a detector's bass riff), so the pitch
   *  is a number to read and not only the "C1" written in `label`. */
  note?: number;
  /** How hard the note is struck, 1..127 (MIDI velocity) — measured by a
   *  detector, or set by hand. Absent = full strength, which is every note
   *  nobody measured. */
  accent?: number;
}

/** A node's own length in beats, derived from its step count and pulse so
 *  nothing has to be kept in sync. */
export function riffNodeLengthBeats(
  node: Pick<RiffNode, 'stepsPerCycle' | 'subbeatsPerBeat'>,
): number {
  const subbeats = Math.max(1, Math.round(node.subbeatsPerBeat) || PATTERN_SUBBEATS_PER_BEAT);
  return Math.max(0, node.stepsPerCycle) / subbeats;
}

/** Rounds a beat offset to `BOUNDARY_BEAT_EPSILON` precision so arithmetic
 *  on segment edges (splitting, dragging, merging) doesn't accumulate float
 *  dust that shows up as a `2.4999999999999996` in the editor's inputs. */
const BOUNDARY_BEAT_DECIMALS = 4;
function roundBeat(b: number): number {
  const f = 10 ** BOUNDARY_BEAT_DECIMALS;
  return Math.round(b * f) / f;
}

/** Blocks shorter than this (in beats) are treated as zero-width and
 *  dissolved into their neighbour — the floor a boundary drag can't cross.
 *  Deliberately a round hundredth rather than a musical fraction like 1/64:
 *  it has to survive `roundBeat`, and a value that isn't representable at
 *  `BOUNDARY_BEAT_DECIMALS` gets rounded just under itself, which makes a
 *  block dragged to exactly the minimum fail the width filter and vanish.
 *  A hundredth of a beat is ~5 ms at 120 bpm — far below any rhythm anyone
 *  is annotating, and well under a 1/64-beat block either way. */
export const BOUNDARY_MIN_SEGMENT_BEATS = 0.01;

/** Is a block this wide worth keeping? Rounds the width to the same
 *  precision the edges themselves are stored at before comparing: a boundary
 *  dragged to exactly the floor produces edges whose float difference lands a
 *  hair *under* it (`4 - 3.99 === 0.00999…`), and a raw `>=` would silently
 *  swallow the block the user just made. */
function wideEnough(width: number): boolean {
  return roundBeat(width) >= BOUNDARY_MIN_SEGMENT_BEATS;
}

/** Enforces the boundary-node invariant: segments are sorted, non-degenerate,
 *  non-overlapping, and tile `[0, lengthBeats)` exactly — any gap the caller
 *  left (including a leading or trailing one) is filled with an `empty`
 *  block, and adjacent `empty` blocks with no label are merged so a rest
 *  never arrives split in two for no reason. Adjacent `tick` blocks are
 *  never merged: two ticks in a row are two hits (see `RiffBoundarySegment`).
 *
 *  Every write path goes through this, so any consumer can assume
 *  `segments[0].start === 0`, `segments[i].end === segments[i+1].start`, and
 *  `segments.at(-1).end === lengthBeats`. A zero/negative `lengthBeats`
 *  yields `[]`. */
export function normalizeBoundarySegments(
  segments: readonly RiffBoundarySegment[] | undefined,
  lengthBeats: number,
): RiffBoundarySegment[] {
  const len = roundBeat(Math.max(0, lengthBeats));
  if (len <= 0) return [];

  const sorted = [...(segments ?? [])]
    .map((s) => ({
      ...s,
      start: roundBeat(Math.max(0, Math.min(len, s.start))),
      end: roundBeat(Math.max(0, Math.min(len, s.end))),
    }))
    .filter((s) => wideEnough(s.end - s.start))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const out: RiffBoundarySegment[] = [];
  let cursor = 0;
  for (const seg of sorted) {
    // Earlier segment wins an overlap: this one is trimmed to start where
    // the last one ended, and dropped outright if nothing is left.
    const start = Math.max(seg.start, cursor);
    if (!wideEnough(seg.end - start)) continue;
    let from = start;
    if (wideEnough(start - cursor)) {
      out.push({ start: roundBeat(cursor), end: roundBeat(start), kind: 'empty' });
    } else if (start > cursor) {
      // Sub-epsilon gap — too narrow to be a block of its own, but leaving it
      // would punch a hole in a cover every consumer is promised is gapless.
      // Hand it to the previous block, or, when this is the first one, let
      // this block start where the cover has to: at the cursor.
      if (out.length > 0) out[out.length - 1] = { ...out[out.length - 1], end: roundBeat(start) };
      else from = cursor;
    }
    out.push({ ...seg, start: roundBeat(from), end: roundBeat(seg.end) });
    cursor = seg.end;
  }
  if (wideEnough(len - cursor) || out.length === 0) {
    out.push({ start: roundBeat(cursor), end: len, kind: 'empty' });
  } else if (out.length > 0) {
    // Sub-epsilon tail: absorb it into the last block rather than emitting a
    // sliver, so the cover still reaches exactly `lengthBeats`.
    out[out.length - 1] = { ...out[out.length - 1], end: len };
  }

  const merged: RiffBoundarySegment[] = [];
  for (const seg of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.kind === 'empty' && seg.kind === 'empty' && !prev.label && !seg.label) {
      merged[merged.length - 1] = { ...prev, end: seg.end };
    } else {
      merged.push(seg);
    }
  }
  return merged;
}

/** Default cap on how long a single onset-seeded `tick` block runs, in beats.
 *  Without a cap, a lone hit followed by four beats of silence would render
 *  as one four-beat tick — visually claiming the whole rest as part of the
 *  hit. Capped, the tail comes back as an explicit `empty` block, which is
 *  what the rhythm actually looks like. */
export const BOUNDARY_DEFAULT_TICK_BEATS = 1;

/** One incoming hit to turn into a boundary block — the shared input shape of
 *  every "where are the ticks?" source: detected onsets, another layer's cues
 *  or lyric timestamps, and Tap Along's raw presses. All in beats from the
 *  node's own start, never quantised on the way in.
 *
 *  Structurally a superset of `TapEvent` (BeatChipControls), so a tap
 *  session's raw events can be handed over as-is. */
export interface BoundaryHit {
  beat: number;
  /** Release position of a *sustained* hit — a tap held across beats, or a
   *  lyric line's own end. Absent ⇒ a point hit, whose block instead runs to
   *  the next hit (capped at `maxTickBeats`), since nothing said how long it
   *  actually lasted. */
  endBeat?: number;
  /** Free-text carried onto the block — a lyric's words, a cue's label. */
  label?: string;
  /** Which Tap Along pass this hit came from, when it came from one. Only
   *  used to measure a cluster's *support* (see `minSupport`): two taps in
   *  the same pass are one person tapping twice, not two passes agreeing. */
  pass?: number;
}

/** Builds a boundary node's segments from a set of hits. Each hit opens a
 *  `tick` block; a sustained hit runs to its own release, a point hit runs to
 *  the next hit capped at `maxTickBeats`, and every gap comes back `empty`.
 *  Hits outside `[0, lengthBeats)` are ignored, and a block is never allowed
 *  to run past the hit that follows it.
 *
 *  `snapBeats` (0 = free, the default) quantises each edge to a beat fraction
 *  — off by default because *not* quantising is the whole point of a boundary
 *  node; it exists for the hand-built rhythms where the user asked for a grid.
 *
 *  `clusterBeats` (0 = off) folds hits landing within that distance of each
 *  other into a single one at the group's *median* position — what several
 *  Tap Along passes over the same bar are: repeated attempts at the same hits,
 *  not one hit each. The median (rather than the first, or a mean) is what
 *  makes extra passes improve the result instead of just multiplying it: one
 *  badly-late tap can't drag the answer. */
export function boundarySegmentsFromHits(
  hits: readonly BoundaryHit[],
  lengthBeats: number,
  opts: {
    maxTickBeats?: number;
    snapBeats?: number;
    clusterBeats?: number;
    /** Drop any cluster backed by fewer than this many passes — 1 (the
     *  default) keeps everything, which is what a single pass, a detector's
     *  onsets or a lyrics layer want. Above 1 it's a vote: a hit tapped in
     *  only one of twelve passes is a slip, not part of the rhythm, and
     *  without this it still lands as its own block. Only meaningful
     *  alongside `clusterBeats`, which is what forms the groups being
     *  counted. */
    minSupport?: number;
  } = {},
): RiffBoundarySegment[] {
  const len = Math.max(0, lengthBeats);
  const cap = Math.max(BOUNDARY_MIN_SEGMENT_BEATS, opts.maxTickBeats ?? BOUNDARY_DEFAULT_TICK_BEATS);
  const snapTo = Math.max(0, opts.snapBeats ?? 0);
  const cluster = Math.max(0, opts.clusterBeats ?? 0);
  const minSupport = Math.max(1, Math.round(opts.minSupport ?? 1));
  const snap = (b: number) => (snapTo > 0 ? Math.round(b / snapTo) * snapTo : b);

  const prepared = hits
    .filter((h) => Number.isFinite(h.beat))
    .map((h) => {
      const start = snap(h.beat);
      // A held hit whose release snaps back onto its own start has no
      // measurable duration left — it degrades to a point hit rather than a
      // zero-width block that `normalizeBoundarySegments` would drop.
      const end = h.endBeat != null && Number.isFinite(h.endBeat) ? snap(h.endBeat) : undefined;
      return { start, end: end != null && end > start ? end : undefined, label: h.label, pass: h.pass };
    })
    .filter((h) => h.start >= 0 && h.start < len)
    .sort((a, b) => a.start - b.start);

  const grouped = cluster > 0
    ? clusterHits(prepared, cluster).filter((h) => h.support >= minSupport)
    : prepared;

  const ticks: RiffBoundarySegment[] = grouped.map((h, i) => {
    const next = i + 1 < grouped.length ? grouped[i + 1].start : len;
    // A hit landing hard against the node's end has no room left to be a
    // block: [len - 0.004, len] is narrower than `BOUNDARY_MIN_SEGMENT_BEATS`,
    // so `normalizeBoundarySegments` drops it and the last onset in the node
    // ends up detected, drawn, counted in the readout — and marked by nothing.
    // Pulling its start back by the minimum width costs a few milliseconds and
    // is the difference between a block and no block.
    const start = Math.min(h.start, Math.max(0, len - BOUNDARY_MIN_SEGMENT_BEATS));
    // A point hit is capped (it never claimed a duration); a sustained one
    // keeps the duration it was given, trimmed only by the next hit and the
    // node's own end.
    const natural = h.end ?? Math.min(start + cap, len);
    return {
      start,
      end: Math.min(Math.max(natural, start + BOUNDARY_MIN_SEGMENT_BEATS), next, len),
      kind: 'tick' as const,
      ...(h.label ? { label: h.label } : {}),
    };
  });
  return normalizeBoundarySegments(ticks, len);
}

/** Median of a non-empty list — the middle value, or the midpoint of the two
 *  middle ones. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Folds near-simultaneous hits (already sorted by start) into one each. A
 *  group is anchored on its first member — membership is measured from that
 *  anchor, never from the running last one, so a long drizzle of hits a
 *  hair apart can't chain into one giant group. The group is sustained only
 *  if at least half its members were, so one accidental long press among
 *  four taps doesn't turn the hit into a hold. */
function clusterHits<T extends { start: number; end?: number; label?: string; pass?: number }>(
  sorted: readonly T[],
  toleranceBeats: number,
): { start: number; end?: number; label?: string; support: number }[] {
  const out: { start: number; end?: number; label?: string; support: number }[] = [];
  let group: T[] = [];
  const flush = () => {
    if (group.length === 0) return;
    const ends = group.map((h) => h.end).filter((e): e is number => e != null);
    const start = median(group.map((h) => h.start));
    const end = ends.length * 2 >= group.length ? Math.max(median(ends), start) : undefined;
    // How many *passes* back this hit: distinct pass numbers, so tapping the
    // same hit twice inside one pass isn't two votes. Hits with no pass at
    // all (onsets, a lyric layer) each count for one.
    const passes = new Set(group.map((h) => h.pass).filter((p) => p != null));
    out.push({
      start,
      end: end != null && end > start ? end : undefined,
      label: group.find((h) => h.label)?.label,
      support: passes.size > 0 ? passes.size : group.length,
    });
    group = [];
  };
  for (const h of sorted) {
    if (group.length > 0 && h.start - group[0].start > toleranceBeats) flush();
    group.push(h);
  }
  flush();
  return out;
}

/** How close a block's start has to sit to a detected onset before the two are
 *  read as the same hit — used for the alignment readout under the strip, for
 *  snapping, and for deciding which incoming hits a merge already has.
 *
 *  An eighth of a beat: 62 ms at 120 bpm, in the same neighbourhood as the
 *  100 ms cue tolerance `evaluateCueLayer` scores with, and comfortably below
 *  the gap between two hits anyone plays as distinct. */
export const BOUNDARY_ONSET_MATCH_BEATS = 0.125;

/** How a node's blocks line up against a set of detected onsets — the number
 *  behind "do my ticks sit on the transients?".
 *
 *  Matching is nearest-onset-per-tick, measured from the tick's *start* (the
 *  attack; a block's end is a decay the detector never claimed to find), and
 *  is deliberately not one-to-one: two ticks a hair apart both count against
 *  the onset between them, which is what you want from a readout that is
 *  describing the blocks rather than scoring a detector. */
export interface BoundaryOnsetAlignment {
  /** Tick blocks in the node. */
  ticks: number;
  /** Onsets inside the node's span. */
  onsets: number;
  /** Ticks with an onset within tolerance of their start. */
  matched: number;
  /** Onsets no tick landed on — hits in the audio the node doesn't mark. */
  missedOnsets: number;
  /** Median signed offset of the matched ticks, in beats: positive ⇒ the
   *  blocks sit *late* against the audio. Null when nothing matched. */
  medianOffsetBeats: number | null;
  /** Largest absolute offset among the matched ticks, in beats — the worst
   *  block, which is the one worth dragging. Null when nothing matched. */
  maxOffsetBeats: number | null;
}

/** Scores `segments` against `onsetBeats` (both in beats from the node's
 *  start). Onsets outside the node are ignored — a placement can be stretched
 *  away from its node's length, so the caller's list is not bounded. */
export function alignBoundaryToOnsets(
  segments: readonly RiffBoundarySegment[],
  onsetBeats: readonly number[],
  lengthBeats: number,
  toleranceBeats: number = BOUNDARY_ONSET_MATCH_BEATS,
): BoundaryOnsetAlignment {
  const len = Math.max(0, lengthBeats);
  const tol = Math.max(0, toleranceBeats);
  const onsets = onsetBeats
    .filter((b) => Number.isFinite(b) && b >= 0 && b <= len)
    .sort((a, b) => a - b);
  const ticks = segments.filter((s) => s.kind === 'tick');
  const claimed = new Set<number>();
  const offsets: number[] = [];
  for (const tick of ticks) {
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < onsets.length; i += 1) {
      const dist = Math.abs(tick.start - onsets[i]);
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    if (best < 0 || bestDist > tol) continue;
    claimed.add(best);
    offsets.push(roundBeat(tick.start - onsets[best]));
  }
  return {
    ticks: ticks.length,
    onsets: onsets.length,
    matched: offsets.length,
    missedOnsets: onsets.length - claimed.size,
    medianOffsetBeats: offsets.length > 0 ? roundBeat(median(offsets)) : null,
    maxOffsetBeats: offsets.length > 0 ? roundBeat(Math.max(...offsets.map(Math.abs))) : null,
  };
}

/** Slides every tick that has a detected onset within `toleranceBeats` of its
 *  start onto that onset, keeping the block's own width — the "merge the
 *  correlation" half of comparing a hand-built rhythm against the audio.
 *
 *  A tick with no onset near it is left exactly where it is: this tightens the
 *  blocks the detector agrees with, it does not rewrite the node (that's what
 *  re-seeding from a layer does). Two ticks snapping onto the same onset
 *  collapse into one — they were two attempts at one hit. */
export function snapBoundaryToOnsets(
  segments: readonly RiffBoundarySegment[],
  onsetBeats: readonly number[],
  lengthBeats: number,
  toleranceBeats: number = BOUNDARY_ONSET_MATCH_BEATS,
): RiffBoundarySegment[] {
  const len = Math.max(0, lengthBeats);
  if (len <= 0) return [...segments];
  const tol = Math.max(0, toleranceBeats);
  const onsets = onsetBeats
    .filter((b) => Number.isFinite(b) && b >= 0 && b <= len)
    .sort((a, b) => a - b);
  if (onsets.length === 0) return [...segments];

  const moved = segments
    .filter((s) => s.kind === 'tick')
    .map((seg) => {
      let target = seg.start;
      let bestDist = tol;
      for (const onset of onsets) {
        const dist = Math.abs(seg.start - onset);
        if (dist <= bestDist) { bestDist = dist; target = onset; }
      }
      const shift = target - seg.start;
      return { ...seg, start: roundBeat(seg.start + shift), end: roundBeat(Math.min(len, seg.end + shift)) };
    })
    .sort((a, b) => a.start - b.start);

  // Trim each block at the next one's start rather than letting
  // `normalizeBoundarySegments` resolve the overlap: there, the earlier block
  // wins outright and a later tick that ended up fully inside it would vanish
  // — a hit silently lost to a snap the user asked for.
  for (let i = 0; i + 1 < moved.length; i += 1) {
    moved[i] = { ...moved[i], end: Math.min(moved[i].end, moved[i + 1].start) };
  }
  return normalizeBoundarySegments(moved, len);
}

/** Adds `hits` that the node isn't already marking, and leaves every existing
 *  block alone — the additive counterpart of `boundarySegmentsFromHits`, which
 *  replaces the whole node.
 *
 *  A hit is considered already marked when it falls inside a tick, or within
 *  `toleranceBeats` of one's start; everything else carves a tick out of the
 *  rest it landed in — as long as the hit's own `endBeat` says it rings for,
 *  or `tickBeats` when it doesn't carry one — trimmed so it can't run into the
 *  hit after it. Used by the tick-source menu's Merge and by the block
 *  editor's own "add the onsets I'm not marking", so a detected rhythm can be
 *  filled in around hand-placed blocks instead of wiping them. */
export function mergeBoundaryHits(
  segments: readonly RiffBoundarySegment[],
  hits: readonly BoundaryHit[],
  lengthBeats: number,
  opts: { toleranceBeats?: number; tickBeats?: number } = {},
): RiffBoundarySegment[] {
  const len = Math.max(0, lengthBeats);
  if (len <= 0) return [...segments];
  const tol = Math.max(0, opts.toleranceBeats ?? BOUNDARY_ONSET_MATCH_BEATS);
  const width = Math.max(BOUNDARY_MIN_SEGMENT_BEATS, opts.tickBeats ?? BOUNDARY_MANUAL_TICK_BEATS);
  const incoming = hits
    .filter((h) => Number.isFinite(h.beat) && h.beat >= 0 && h.beat < len)
    .sort((a, b) => a.beat - b.beat);

  let out = normalizeBoundarySegments(segments, len);
  for (let i = 0; i < incoming.length; i += 1) {
    const hit = incoming[i];
    const covered = out.some((s) => (
      s.kind === 'tick'
      && (Math.abs(s.start - hit.beat) <= tol || (hit.beat >= s.start && hit.beat < s.end))
    ));
    if (covered) continue;
    const next = i + 1 < incoming.length ? incoming[i + 1].beat : len;
    // A hit that knows its own length keeps it — a measured onset decay, a
    // held tap — and only the ones that don't fall back to the flat `width`.
    const wanted = hit.endBeat != null && Number.isFinite(hit.endBeat) && hit.endBeat > hit.beat
      ? hit.endBeat - hit.beat
      : width;
    const room = Math.min(wanted, Math.max(BOUNDARY_MIN_SEGMENT_BEATS, next - hit.beat));
    // `dropBoundaryTickAt` shifts the new tick back as far as it must to stay
    // inside the rest it landed in, so the block that ends up *covering* the
    // hit is the one this call made — and blocks are disjoint, so that's
    // enough to find it again and hand it the hit's label.
    out = dropBoundaryTickAt(out, hit.beat, len, room);
    if (hit.label) {
      out = out.map((s) => (
        s.kind === 'tick' && !s.label && hit.beat >= s.start && hit.beat < s.end
          ? { ...s, label: hit.label }
          : s
      ));
    }
  }
  return out;
}

/** How far apart two taps can land and still be read as repeated attempts at
 *  the same hit rather than two different ones. A quarter of a beat — a 16th
 *  note at 4/4 — is comfortably wider than human tap jitter across passes and
 *  still narrower than any two rhythmically distinct hits a person taps by
 *  hand. */
export const BOUNDARY_TAP_CLUSTER_BEATS = 0.25;

/** Turns a finished Tap Along session's raw presses into boundary blocks:
 *  one block per press, running from the press to its release. Nothing is
 *  lengthened to fill the gap to the next hit — the hold IS the block, which
 *  is what a boundary node's Tap Along promises. `snapBeats` mirrors the
 *  editor's own snap picker — 0 (free) keeps each press exactly where it
 *  landed, which is the whole reason a boundary node exists.
 *
 *  Only a hit that carries no release at all — the on-screen tap button, or a
 *  hit placed by eye on the strip, neither of which has a duration to report —
 *  falls back to a length, and to the short `BOUNDARY_MANUAL_TICK_BEATS` the
 *  editor's own click uses rather than the full `BOUNDARY_DEFAULT_TICK_BEATS`
 *  that a *detected* onset gets.
 *
 *  Taps that drifted a hair before the node's own start (the first beat is
 *  easy to anticipate) are pulled to beat 0 rather than dropped — the same
 *  thing the grid path's `clampStep` does with them.
 *
 *  `refine` is the review step's two dials: how far apart two taps can be and
 *  still be the same hit (`clusterBeats`, 0 = don't fold at all), and how many
 *  passes have to agree before a hit is kept (`minPasses`, 1 = keep every
 *  one). Defaults reproduce the behaviour before they existed. */
export function boundarySegmentsFromTaps(
  taps: readonly BoundaryHit[],
  lengthBeats: number,
  snapBeats: number = 0,
  refine: { clusterBeats?: number; minPasses?: number } = {},
): RiffBoundarySegment[] {
  const clamped = taps.map((t) => ({
    beat: Math.max(0, t.beat),
    endBeat: t.endBeat == null ? undefined : Math.max(0, t.endBeat),
    label: t.label,
    pass: t.pass,
  }));
  return boundarySegmentsFromHits(clamped, lengthBeats, {
    maxTickBeats: BOUNDARY_MANUAL_TICK_BEATS,
    snapBeats,
    clusterBeats: refine.clusterBeats ?? BOUNDARY_TAP_CLUSTER_BEATS,
    minSupport: refine.minPasses ?? 1,
  });
}

/** Index of the segment containing `beatPos` (offset from the node's start,
 *  in beats), or `-1` when it falls outside the node. Drives the boundary
 *  editor's karaoke highlight: it's a plain relative-time lookup, with no
 *  beat-division inference anywhere in the path. */
export function boundarySegmentIndexAt(
  segments: readonly RiffBoundarySegment[],
  beatPos: number,
): number {
  if (!Number.isFinite(beatPos)) return -1;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    // Last block is closed on the right so a playhead sitting exactly on the
    // node's final edge still highlights something.
    const inside = i === segments.length - 1
      ? beatPos >= s.start && beatPos <= s.end
      : beatPos >= s.start && beatPos < s.end;
    if (inside) return i;
  }
  return -1;
}

/** Resizes a node to `lengthBeats` (rounded to whole steps of its pulse),
 *  re-tiling its notes to the new length: notes past the new end are trimmed
 *  or dropped, and a longer node gains a trailing rest. The standard place a
 *  node's length is changed. */
export function resizeBoundaryNodeLength(
  node: Pick<RiffNode, 'subbeatsPerBeat' | 'segments'>,
  lengthBeats: number,
): Pick<RiffNode, 'stepsPerCycle' | 'segments'> {
  const subbeats = Math.max(1, Math.round(node.subbeatsPerBeat) || PATTERN_SUBBEATS_PER_BEAT);
  const stepsPerCycle = Math.max(1, Math.round(lengthBeats * subbeats));
  return { stepsPerCycle, segments: normalizeBoundarySegments(node.segments, stepsPerCycle / subbeats) };
}

/** Splits the segment containing `atBeat` in two at that point, keeping both
 *  halves' kind and label. A no-op when `atBeat` is already within
 *  `BOUNDARY_MIN_SEGMENT_BEATS` of an existing boundary. */
export function splitBoundaryAt(
  segments: readonly RiffBoundarySegment[],
  atBeat: number,
  lengthBeats: number,
): RiffBoundarySegment[] {
  const i = boundarySegmentIndexAt(segments, atBeat);
  if (i < 0) return [...segments];
  const seg = segments[i];
  if (!wideEnough(atBeat - seg.start)) return [...segments];
  if (!wideEnough(seg.end - atBeat)) return [...segments];
  const at = roundBeat(atBeat);
  return normalizeBoundarySegments(
    [
      ...segments.slice(0, i),
      { ...seg, end: at },
      { ...seg, start: at },
      ...segments.slice(i + 1),
    ],
    lengthBeats,
  );
}

/** Declares one span outright: everything inside `[fromBeat, toBeat)` becomes
 *  a single block of `kind`, whatever was there before, and the blocks either
 *  side are trimmed back to make room. This is the gesture the node kind is
 *  actually for — "between 2 and 3.5 beats, this happens" — which splitting
 *  and flipping can only approximate: reaching a span by hand means one split
 *  per edge, in the right order, with a flip in between, and a span that
 *  swallows blocks needs one removal each on top of that.
 *
 *  The painted span always comes back as ONE block: two adjacent ticks mean
 *  two hits (see `RiffBoundarySegment`), so a range the user drew as a single
 *  event must not arrive as several. A neighbour left narrower than
 *  `BOUNDARY_MIN_SEGMENT_BEATS` is dropped by `normalizeBoundarySegments`,
 *  which hands its sliver back to the painted block rather than leaving a
 *  hole. A degenerate range (or one outside the node) is a no-op. */
export function paintBoundaryRange(
  segments: readonly RiffBoundarySegment[],
  fromBeat: number,
  toBeat: number,
  kind: RiffBoundarySegment['kind'],
  lengthBeats: number,
  label?: string,
): RiffBoundarySegment[] {
  const len = Math.max(0, lengthBeats);
  if (len <= 0) return [...segments];
  const clamp = (b: number) => roundBeat(Math.max(0, Math.min(len, b)));
  const from = clamp(Math.min(fromBeat, toBeat));
  const to = clamp(Math.max(fromBeat, toBeat));
  if (!wideEnough(to - from)) return [...segments];

  const out: RiffBoundarySegment[] = [];
  for (const seg of segments) {
    // Whatever of each existing block survives on either side of the span —
    // its label goes with it, since it's still that block.
    const headEnd = Math.min(seg.end, from);
    if (wideEnough(headEnd - seg.start)) out.push({ ...seg, end: headEnd });
    const tailStart = Math.max(seg.start, to);
    if (wideEnough(seg.end - tailStart)) out.push({ ...seg, start: tailStart });
  }
  out.push(label ? { start: from, end: to, kind, label } : { start: from, end: to, kind });
  return normalizeBoundarySegments(out, len);
}

/** Moves the boundary *between* `segments[index - 1]` and `segments[index]`
 *  to `toBeat`, clamped so neither neighbour shrinks below
 *  `BOUNDARY_MIN_SEGMENT_BEATS`. `index` 0 (the node's own start) and
 *  `index === segments.length` (its end) are fixed and return unchanged —
 *  the node's length is edited through the Length field, not by dragging. */
export function moveBoundary(
  segments: readonly RiffBoundarySegment[],
  index: number,
  toBeat: number,
  lengthBeats: number,
): RiffBoundarySegment[] {
  if (index <= 0 || index >= segments.length) return [...segments];
  const prev = segments[index - 1];
  const next = segments[index];
  const lo = prev.start + BOUNDARY_MIN_SEGMENT_BEATS;
  const hi = next.end - BOUNDARY_MIN_SEGMENT_BEATS;
  if (hi < lo) return [...segments];
  const at = roundBeat(Math.min(hi, Math.max(lo, toBeat)));
  return normalizeBoundarySegments(
    [
      ...segments.slice(0, index - 1),
      { ...prev, end: at },
      { ...next, start: at },
      ...segments.slice(index + 1),
    ],
    lengthBeats,
  );
}

/** Default length of a tick added by hand (as opposed to seeded from an
 *  onset), in beats. An eighth note at the usual 4/4 feel — short enough to
 *  lay several down inside a bar, long enough to grab and drag. */
export const BOUNDARY_MANUAL_TICK_BEATS = 0.5;

/** Appends a tick where the rhythm has got to so far: starting at the end of
 *  the last existing tick (or at the node's start when there are none), it
 *  carves up to `tickBeats` out of the rest that follows. Clicking repeatedly
 *  therefore lays ticks down left to right — the "add a block of info with a
 *  length" flow — instead of endlessly halving whatever block happens to be
 *  last. Falls back to the first rest anywhere in the node when the space
 *  after the last tick is already full, and returns the segments unchanged
 *  when there's no rest left to carve at all. */
export function appendBoundaryTick(
  segments: readonly RiffBoundarySegment[],
  lengthBeats: number,
  tickBeats: number = BOUNDARY_MANUAL_TICK_BEATS,
): RiffBoundarySegment[] {
  const len = Math.max(0, lengthBeats);
  if (len <= 0) return [...segments];
  let cursor = 0;
  for (const seg of segments) if (seg.kind === 'tick') cursor = Math.max(cursor, seg.end);

  // Prefer the rest at/after the cursor; otherwise take the earliest rest.
  const restAfter = segments.find((s) => s.kind === 'empty' && s.end - Math.max(s.start, cursor) > 0);
  const target = (restAfter && restAfter.end > cursor)
    ? restAfter
    : segments.find((s) => s.kind === 'empty');
  if (!target) return [...segments];

  // Resume at the cursor only when it actually falls inside the chosen rest.
  // In the fallback case (an earlier rest, because the tail is full) the
  // cursor is past that rest entirely, and clamping to it would produce a
  // zero-width tick that the width filter then drops.
  const start = cursor > target.start && cursor < target.end ? cursor : target.start;
  const end = Math.min(target.end, start + Math.max(BOUNDARY_MIN_SEGMENT_BEATS, tickBeats));
  if (!wideEnough(end - start)) return [...segments];

  // Splice the tick into the rest explicitly rather than appending and
  // letting `normalizeBoundarySegments` sort it out: overlaps there resolve
  // in favour of the EARLIER block, so an appended tick sitting inside a
  // longer rest would simply be swallowed by it.
  const out: RiffBoundarySegment[] = [];
  for (const seg of segments) {
    if (seg !== target) { out.push(seg); continue; }
    if (wideEnough(start - seg.start)) out.push({ ...seg, start: seg.start, end: start });
    out.push({ start, end, kind: 'tick' });
    if (wideEnough(seg.end - end)) out.push({ ...seg, start: end, end: seg.end });
  }
  return normalizeBoundarySegments(out, len);
}

/** What a plain click on the block strip means: a click is an *instant*, so
 *  it lays a short tick down at that instant rather than rewriting the block
 *  it landed in. Clicking inside a rest carves a `tickBeats`-long tick out of
 *  it, starting where the click landed and shifted back only as far as it
 *  must to stay inside that rest (a rest shorter than a tick simply becomes
 *  one). Clicking a tick clears that whole block, so the same gesture takes
 *  the hit away again.
 *
 *  Flipping the block *whole* is deliberately not what the strip does: on a
 *  fresh node the only block covers the entire length, and a stray click
 *  would turn every beat of it into one tick — a span nobody drew. The
 *  explicit whole-block flip lives on the block row's Tick/Empty button. */
export function dropBoundaryTickAt(
  segments: readonly RiffBoundarySegment[],
  atBeat: number,
  lengthBeats: number,
  tickBeats: number = BOUNDARY_MANUAL_TICK_BEATS,
): RiffBoundarySegment[] {
  const len = Math.max(0, lengthBeats);
  if (len <= 0) return [...segments];
  const i = boundarySegmentIndexAt(segments, atBeat);
  if (i < 0) return [...segments];
  const seg = segments[i];
  if (seg.kind === 'tick') return paintBoundaryRange(segments, seg.start, seg.end, 'empty', len);
  const width = Math.max(
    BOUNDARY_MIN_SEGMENT_BEATS,
    Math.min(Math.max(0, tickBeats), seg.end - seg.start),
  );
  const start = Math.max(seg.start, Math.min(atBeat, seg.end - width));
  return paintBoundaryRange(segments, start, start + width, 'tick', len);
}

/** Removes segment `index`.
 *
 *  On a **tick** that means the hit didn't happen: its span becomes a rest,
 *  which `normalizeBoundarySegments` then merges into any rest beside it, so
 *  the row disappears and nothing sounds there. Handing a tick's span to the
 *  neighbour instead would keep the neighbour's kind — and a mistaken tick
 *  between two ticks would simply grow the one before it, which is not a
 *  removal at all (the bug that made a stray tap feel impossible to delete).
 *
 *  On a **rest** there is no hit to take away, so the span goes to a
 *  neighbour — the previous one when there is one, otherwise the next —
 *  which is how a rest is closed up. Removing the only segment leaves a
 *  single full-length `empty` either way. */
export function removeBoundarySegment(
  segments: readonly RiffBoundarySegment[],
  index: number,
  lengthBeats: number,
): RiffBoundarySegment[] {
  if (index < 0 || index >= segments.length) return [...segments];
  if (segments.length === 1) return normalizeBoundarySegments([], lengthBeats);
  const seg = segments[index];
  if (seg.kind === 'tick') {
    return normalizeBoundarySegments(
      segments.map((s, i) => (i === index ? { start: s.start, end: s.end, kind: 'empty' as const } : s)),
      lengthBeats,
    );
  }
  const rest = segments.filter((_, i) => i !== index);
  const absorbAt = index > 0 ? index - 1 : 0;
  const target = rest[absorbAt];
  rest[absorbAt] = index > 0
    ? { ...target, end: seg.end }
    : { ...target, start: seg.start };
  return normalizeBoundarySegments(rest, lengthBeats);
}

/** Resizes a node to `lengthBeats` as a TRIM rather than a rescale: whatever
 *  survives keeps the size it's drawn at today, and only the tail goes.
 *
 *  Resizing the node on its own can't do that. A placement occupies whatever
 *  slot its `RiffSeqEntry.lengthSteps` says, and the canvas fits the node's
 *  whole content into that unchanged width (`ChipStrip`/`BoundaryStrip` scale
 *  to their box), so cutting a 16-beat node to 10 only spread the ten
 *  surviving beats back over all 16 — and the mirror gesture, dragging a
 *  placement's edge in, squeezed every block into a narrower slot without
 *  dropping any. Carrying the placements along by the same ratio is what pins
 *  a block's drawn scale and makes the edit read as a trim.
 *
 *  Entries are SCALED, not set to the node's new natural length, so a
 *  placement deliberately drag-stretched to 2× stays at 2×. Every reference
 *  moves — combo children included — because a node is a shared library
 *  primitive: trimming it in one place only isn't a thing. Trimming the
 *  content itself is `resizeBoundaryNodeLength`'s job (blocks re-tile); this
 *  only has to keep the timeline in step with it. */
export function trimRiffNodeLength(
  layer: Pick<AnnotationLayer<'riff-patterns'>, 'nodes' | 'combos' | 'items'>,
  nodeId: string,
  lengthBeats: number,
): Pick<AnnotationLayer<'riff-patterns'>, 'nodes' | 'combos' | 'items'> {
  const nodes = layer.nodes ?? [];
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return { nodes: layer.nodes, combos: layer.combos, items: layer.items };
  const patch = resizeBoundaryNodeLength(node, lengthBeats);
  const nextNodes = nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n));
  // The resize leaves `subbeatsPerBeat` alone, so the step counts are
  // directly comparable and the ratio is the node's change in real length.
  const ratio = node.stepsPerCycle > 0 ? patch.stepsPerCycle / node.stepsPerCycle : 1;
  if (ratio === 1) return { nodes: nextNodes, combos: layer.combos, items: layer.items };
  const scale = (sequence: readonly RiffSeqEntry[]): RiffSeqEntry[] => sequence.map((e) => (
    e.type === nodeId ? { ...e, lengthSteps: Math.max(1, Math.round(e.lengthSteps * ratio)) } : e
  ));
  return {
    nodes: nextNodes,
    combos: layer.combos?.map((c) => ({ ...c, sequence: scale(c.sequence) })),
    items: (layer.items as RiffPatternItem[]).map((it) => ({ ...it, sequence: scale(it.sequence) })),
  };
}

/** One child slot in a Combo's or Riff's `sequence` — a reference to a
 *  RiffNode or RiffCombo (`type`, resolved against the layer's `nodes`/
 *  `combos`, or `RIFF_NODE_SILENCE_ID`) plus how long this *occurrence*
 *  lasts, in the sequence's own fixed grid unit (`PATTERN_SUBBEATS_PER_BEAT`
 *  sub-steps per beat) — NOT the referenced node's own `stepsPerCycle` grid,
 *  which may run at a different `subbeatsPerBeat` resolution. Use
 *  `nodeEntryLengthSteps` to convert a node's natural length into this unit
 *  (`defaultRiffEntryLength` does this for you). Siblings lay out end-to-end,
 *  so a sequence's total duration is simply the sum of its entries' lengths.
 *  `type` doubles as the aggregation key for grouping every occurrence of
 *  the same node/combo across a layer. */
export interface RiffSeqEntry {
  type: string;
  lengthSteps: number;
}

/** Fallback occurrence length (one bar at 16th-note resolution) used when an
 *  entry's natural length can't be inferred (silence, or a legacy file being
 *  upgraded from the pre-length sequence format). */
export const RIFF_DEFAULT_ENTRY_STEPS = 16;

/** Converts a node's own `stepsPerCycle` (counted at that node's own
 *  `subbeatsPerBeat` resolution — e.g. 96 steps at 6/beat for a 16-beat
 *  triplet node) into the sequence-grid's fixed `PATTERN_SUBBEATS_PER_BEAT`
 *  (4/beat) unit that `RiffSeqEntry.lengthSteps`, `riffCycleSteps`, and every
 *  entry-resize/occurrence/playback calculation assume. A no-op when the node
 *  already uses the default resolution. Without this conversion, a node
 *  placed at a non-default `subbeatsPerBeat` gets an entry length that's off
 *  by `subbeatsPerBeat / PATTERN_SUBBEATS_PER_BEAT`×, which desyncs its
 *  rendered chip grid (and audio preview / Tap Along timing) from real
 *  playback time. */
export function nodeEntryLengthSteps(node: Pick<RiffNode, 'stepsPerCycle' | 'subbeatsPerBeat'>): number {
  const subbeats = Math.max(1, Math.round(node.subbeatsPerBeat) || PATTERN_SUBBEATS_PER_BEAT);
  const beats = node.stepsPerCycle / subbeats;
  return Math.max(1, Math.round(beats * PATTERN_SUBBEATS_PER_BEAT));
}

/** The natural length (in sequence-grid sub-steps, `PATTERN_SUBBEATS_PER_BEAT`
 *  per beat) a node/combo/silence entry should start at when first added to a
 *  sequence: a node's own length converted via `nodeEntryLengthSteps`, a
 *  combo's total (sum of its own entries — no recursion needed since every
 *  entry already carries an explicit length in the same fixed unit), or the
 *  flat fallback. */
export function defaultRiffEntryLength(
  type: string,
  nodes: readonly RiffNode[],
  combos: readonly RiffCombo[],
): number {
  const node = nodes.find((n) => n.id === type);
  if (node) return nodeEntryLengthSteps(node);
  const combo = combos.find((c) => c.id === type);
  if (combo) {
    const total = combo.sequence.reduce((s, e) => s + e.lengthSteps, 0);
    if (total > 0) return total;
  }
  return RIFF_DEFAULT_ENTRY_STEPS;
}

/** An ordered, reusable, timeless sequence of node/combo occurrences. Combos
 *  may nest other combos (no cycles allowed — the editor enforces acyclicity
 *  at write time) but may never contain a Riff — a Riff only exists once
 *  placed at the tree's root, so it can't also be referenced as a child. */
export interface RiffCombo {
  id: string;
  name: string;
  /** Display color — assigned from RIFF_COMBO_COLORS with alternating palette. */
  color: string;
  sequence: RiffSeqEntry[];
}

/** What a play did to its node: played it as written (`exact`), added hits
 *  only (`fill`), left every hit out (`drop`), or anything else
 *  (`variation`). */
export type RiffEvent = 'exact' | 'variation' | 'fill' | 'drop';

/** A note one play added over its node: where, in beats from the node's
 *  start, and as the node writes a note. */
export type RiffAddedNote = Pick<RiffBoundarySegment, 'start' | 'end' | 'label' | 'note' | 'accent'>;

/** One play of an item that differed from its node — the same node, played
 *  differently this once. Never a node of its own: "the fourth A drops the
 *  kick" is A with one note missing, and the lane still reads A.
 *
 *  `index` counts plays from 0: repeat `r` of an item whose sequence has `n`
 *  entries plays entry `e` as index `r × n + e`. An entry that is a combo is
 *  one play, and is not given occurrences (every placement of the combo
 *  shares its leaves). */
export interface RiffOccurrence {
  index: number;
  event: RiffEvent;
  /** Notes the play struck that the node does not have. */
  added?: RiffAddedNote[];
  /** The node's notes the play left out, by where they start (beats). */
  missing?: { start: number }[];
}

/** A Riff: the tree's root. Structurally identical to a Combo (same ordered
 *  `sequence` of node/combo occurrences) plus a placement — `start`/`end`
 *  position this occurrence's first cycle on the timeline, and the whole
 *  cycle repeats `repeatCount` times end-to-end from there.
 *
 *  `end` is DERIVED, not placed: the cycle is exactly as long as the sequence
 *  plays for, so `end` follows whatever the sequence becomes (see
 *  `fitRiffInstanceEnd`, enforced document-wide in InspectorPageV2). Only
 *  `start` is positioned by hand. The one case where the two can disagree is a
 *  song with no tempo grid, where there is no steps↔seconds mapping to fit
 *  against — that is when the canvas draws a dashed tail for the remainder. */
export interface RiffPatternItem {
  id: string;
  start: number;
  /** Derived from `start` + the sequence's own length — see the type doc. */
  end: number;
  /** Musical position of `start` / `end`: fractional beats from the grid
   *  origin, stamped from the seconds whenever the song has a usable grid.
   *  Seconds stay canonical. See utils/beatAnchoring.ts. */
  startBeat?: number;
  endBeat?: number;
  label: string;
  description?: string;
  sequence: RiffSeqEntry[];
  repeatCount: number;
  /** Id of an earlier instance (by start time, within the same layer) with the
   *  exact same `sequence` + `repeatCount` — i.e. one that renders identical
   *  musical content, just placed elsewhere on the timeline. `undefined` if
   *  this instance's content is unique so far. Kept in sync automatically
   *  (see `computeRiffDuplicates`) so the fact survives into the saved
   *  document — anything reading the raw annotation JSON (a future agent,
   *  an export) can see the duplication without re-deriving it, since the
   *  editor UI only shows a "same as #N" badge live and doesn't otherwise
   *  persist that judgement anywhere. */
  duplicateOfId?: string;
  /** Prominence envelope. `t` runs over the full repeated
   *  region (`repeatCount` cycles), not one cycle. */
  prominence?: ProminenceEnvelope;
  /** Critical (default) vs optional, same flag every other interval kind
   *  carries. Omitted ⇒ critical. */
  importance?: ItemImportance;
  /** The plays that differed from their node: a hit dropped, a fill added.
   *  A play is one sequence entry in one repeat — see `RiffOccurrence.index`.
   *  A play with no entry here plays its node exactly. Absent when every play
   *  does. */
  occurrences?: RiffOccurrence[];
}

/** Recomputes `duplicateOfId` for every item in `items` (sorted by `start`,
 *  same order the editor lists them in) — `undefined` for the first instance
 *  with a given `sequence`+`repeatCount`, or that instance's id for every
 *  later one that matches it exactly. Two instances referencing the very same
 *  combo/node ids at the same lengths and repeat count always render
 *  identically (combos are shared references), so a plain structural
 *  comparison is sufficient — no need to resolve combos recursively. */
export function computeRiffDuplicates(items: readonly RiffPatternItem[]): Map<string, string | undefined> {
  const sorted = items.slice().sort((a, b) => a.start - b.start);
  const firstIdFor = new Map<string, string>();
  const result = new Map<string, string | undefined>();
  for (const it of sorted) {
    const key = `${JSON.stringify(it.sequence)}#${it.repeatCount}`;
    const firstId = firstIdFor.get(key);
    if (firstId === undefined) {
      firstIdFor.set(key, it.id);
      result.set(it.id, undefined);
    } else {
      result.set(it.id, firstId);
    }
  }
  return result;
}

/** How many sub-steps a Riff's own placed cycle (`end - start`, in seconds)
 *  spans, at the standard 16th-note grid — the space the sequence's entries
 *  are laid out into on the canvas. Independent of the sequence's own total
 *  `lengthSteps` (which may be shorter, leaving a silent tail, or longer,
 *  overflowing the tile — see the RiffPatternItem type doc). Falls back to
 *  `RIFF_DEFAULT_ENTRY_STEPS` when no tempo grid is available. */
export function riffCycleSteps(cycleSeconds: number, bpm: number): number {
  if (!bpm || bpm <= 0 || cycleSeconds <= 0) return RIFF_DEFAULT_ENTRY_STEPS;
  const secPerStep = (60 / bpm) / PATTERN_SUBBEATS_PER_BEAT;
  return Math.max(1, Math.round(cycleSeconds / secPerStep));
}

/** Total length of a Riff's own sequence, in the same sub-step unit
 *  `riffCycleSteps` reports the placed cycle in. Comparing the two is what
 *  says whether the instance's window is tight on what it actually plays. */
export function riffSequenceSteps(item: Pick<RiffPatternItem, 'sequence'>): number {
  return item.sequence.reduce((s, e) => s + e.lengthSteps, 0);
}

/** Ends closer than this are the same end. A step is 125 ms at 120 bpm, so
 *  this is far below anything audible — it exists only so the fit is a fixed
 *  point (refitting an already-fitted instance must return it unchanged, or
 *  the enforcing effect in InspectorPageV2 would write on every render). */
const RIFF_FIT_EPSILON_SEC = 1e-6;

/** Pulls an instance's `end` in (or out) so its placed cycle is exactly as
 *  long as its sequence plays for — the invariant the riff lane maintains:
 *  the cycle IS the sequence, never a looser window around it with a silent
 *  tail at the end of every repeat.
 *
 *  `start` is the anchor and never moves: an instance is placed by where it
 *  begins, and its length is a consequence of its content. Two cases have no
 *  answer and are left alone — an empty sequence (nothing to be as long as)
 *  and a song with no tempo grid (with no bpm there is no steps↔seconds
 *  mapping at all, which is also the only case where the canvas still draws
 *  the dashed "doesn't fill this cycle" tail). */
export function fitRiffInstanceEnd<T extends RiffPatternItem>(item: T, bpm: number): T {
  const steps = riffSequenceSteps(item);
  if (!bpm || bpm <= 0 || steps < 1) return item;
  const secPerStep = (60 / bpm) / PATTERN_SUBBEATS_PER_BEAT;
  const end = item.start + steps * secPerStep;
  if (Math.abs(end - item.end) <= RIFF_FIT_EPSILON_SEC) return item;
  // `endBeat` is deliberately not re-stamped here: beat companions are
  // restamped from the canonical seconds on save (`withStampedBeats`), the
  // same as for every other end edit in the editor.
  return { ...item, end };
}

/** `fitRiffInstanceEnd` over a whole document. Returns the SAME document
 *  reference when every instance is already tight, so the effect that enforces
 *  the invariant can bail out without writing (and without looping). */
export function withFittedRiffInstances(
  doc: AnnotationLayersDocument,
  bpm: number,
): AnnotationLayersDocument {
  if (!bpm || bpm <= 0) return doc;
  let docChanged = false;
  const layers = doc.layers.map((layer) => {
    if (layer.type !== 'riff-patterns' || layer.readOnly) return layer;
    let layerChanged = false;
    const items = (layer.items as RiffPatternItem[]).map((it) => {
      const next = fitRiffInstanceEnd(it, bpm);
      if (next !== it) layerChanged = true;
      return next;
    });
    if (!layerChanged) return layer;
    docChanged = true;
    return { ...layer, items } as AnnotationLayer;
  });
  return docChanged ? { ...doc, layers } : doc;
}

/** A riff instance can only play what its lane holds. Entries naming a node
 *  or combo that no longer exists (deleted from under it) are dropped, with
 *  their plays' occurrences renumbered; an instance left with nothing to
 *  play is removed — an empty instance draws nothing but its title, and
 *  there is no node left in it to open. Rests are kept: a deliberate rest
 *  plays silence. Returns the SAME document when nothing dangles, so the
 *  effect that enforces it can bail out without writing. */
export function withoutDanglingRiffInstances(doc: AnnotationLayersDocument): AnnotationLayersDocument {
  let docChanged = false;
  const layers = doc.layers.map((layer) => {
    if (layer.type !== 'riff-patterns' || layer.readOnly) return layer;
    const known = new Set<string>([
      RIFF_NODE_SILENCE_ID,
      ...(layer.nodes ?? []).map((n) => n.id),
      ...(layer.combos ?? []).map((c) => c.id),
    ]);
    let layerChanged = false;
    const items: RiffPatternItem[] = [];
    for (const it of layer.items as RiffPatternItem[]) {
      const keep = it.sequence.map((e) => known.has(e.type));
      const kept = it.sequence.filter((_, i) => keep[i]);
      if (!kept.some((e) => e.type !== RIFF_NODE_SILENCE_ID)) { layerChanged = true; continue; }
      if (kept.length === it.sequence.length) { items.push(it); continue; }
      layerChanged = true;
      const oldN = it.sequence.length;
      const newIndex = new Map<number, number>();
      keep.reduce((k, on, i) => { if (on) { newIndex.set(i, k); return k + 1; } return k; }, 0);
      const occurrences = (it.occurrences ?? []).flatMap((o) => {
        const k = newIndex.get(o.index % oldN);
        return k == null ? [] : [{ ...o, index: Math.floor(o.index / oldN) * kept.length + k }];
      });
      const next: RiffPatternItem = { ...it, sequence: kept, occurrences };
      if (!occurrences.length) delete next.occurrences;
      items.push(next);
    }
    if (!layerChanged) return layer;
    docChanged = true;
    return { ...layer, items } as AnnotationLayer;
  });
  return docChanged ? { ...doc, layers } : doc;
}

/** One expanded leaf of a sequence entry: either a node occurrence or a
 *  silence gap, with its share of the entry's own length (`fraction`, 0..1 —
 *  every leaf array returned for one entry sums to 1). A combo entry is
 *  expanded recursively so every leaf is always a concrete node or silence,
 *  never a combo. Shared by the canvas (what to draw, and which node a click
 *  on a nested-in-a-combo block actually landed on) and by
 *  `findFirstRiffNodeOccurrence` (locating real audio for a node's preview),
 *  so both agree exactly on what a combo is "really made of". */
export interface RiffLeaf {
  /** Node id, or null for a silence leaf. */
  nodeId: string | null;
  fraction: number;
}

/** Depth-capped defensively — cycles are prevented at edit time (see
 *  reachableCombos in RiffPatternEditorPanel), this just guards against any
 *  that slip through. */
export function flattenRiffEntry(
  entry: RiffSeqEntry,
  nodes: readonly RiffNode[],
  combos: readonly RiffCombo[],
  depth = 0,
): RiffLeaf[] {
  const id = entry.type;
  if (id === RIFF_NODE_SILENCE_ID) return [{ nodeId: null, fraction: 1 }];
  const node = nodes.find((n) => n.id === id);
  if (node) return [{ nodeId: node.id, fraction: 1 }];
  const combo = combos.find((c) => c.id === id);
  if (!combo || depth > 8) return [{ nodeId: null, fraction: 1 }];
  const total = combo.sequence.reduce((s, e) => s + e.lengthSteps, 0) || 1;
  const out: RiffLeaf[] = [];
  for (const child of combo.sequence) {
    const childFraction = child.lengthSteps / total;
    for (const leaf of flattenRiffEntry(child, nodes, combos, depth + 1)) {
      out.push({ nodeId: leaf.nodeId, fraction: leaf.fraction * childFraction });
    }
  }
  return out;
}

/** Locates the first time `nodeId` actually occurs on the timeline within
 *  `layer` — the first cycle (rep 0; later reps are identical copies) of the
 *  first Riff instance whose sequence contains it, directly or nested inside
 *  a combo — so the Node popup's "listen" preview can loop the real recorded
 *  audio there instead of a synthesized click. Returns the absolute
 *  [start, end) in seconds, or null if the node isn't placed anywhere yet. */
export function findFirstRiffNodeOccurrence(
  layer: Pick<AnnotationLayer<'riff-patterns'>, 'items' | 'nodes' | 'combos'>,
  nodeId: string,
  bpm: number,
): { start: number; end: number } | null {
  const nodes = layer.nodes ?? [];
  const combos = layer.combos ?? [];
  const items = layer.items as RiffPatternItem[];
  for (const item of items) {
    const cycleSec = Math.max(0.01, item.end - item.start);
    const cycleSteps = riffCycleSteps(cycleSec, bpm);
    const stepDur = cycleSec / cycleSteps;
    let offsetSteps = 0;
    for (const entry of item.sequence) {
      let leafOffsetSteps = 0;
      for (const leaf of flattenRiffEntry(entry, nodes, combos)) {
        const leafSteps = leaf.fraction * entry.lengthSteps;
        if (leaf.nodeId === nodeId) {
          const startSec = item.start + (offsetSteps + leafOffsetSteps) * stepDur;
          return { start: startSec, end: startSec + leafSteps * stepDur };
        }
        leafOffsetSteps += leafSteps;
      }
      offsetSteps += entry.lengthSteps;
    }
  }
  return null;
}

/** Result of `computeRiffSeqPlayback` — which sequence entry (and, if it's a
 *  node leaf, which point in that node's own beat grid) the live playhead is
 *  currently sounding. Drives the karaoke-style highlight in the Instance
 *  popup's sequence builder: the active entry's chip/row glows, and if it's
 *  a node (bare or nested inside an expanded combo), that node's
 *  `BeatChipPicker` sweeps via `nodePlayheadStep` exactly like the standalone
 *  Node popup does. */
export interface RiffSeqPlayback {
  /** Index into `item.sequence` of the entry currently sounding. */
  entryIndex: number;
  /** Index into `flattenRiffEntry(item.sequence[entryIndex], ...)` of the
   *  leaf currently sounding — the entry's own leaves, in the same order a
   *  combo's direct children are recursively flattened into. Use
   *  `riffLeafPath` to map this back to the full chain of child indices
   *  (silence included — a silent leaf gets a `leafIndex` just like a node
   *  leaf does). */
  leafIndex: number;
  /** Node id of the actual leaf sounding (resolved through any nested
   *  combos), or null when the sounding leaf is silence. */
  leafNodeId: string | null;
  /** Fractional position (0..node.stepsPerCycle) inside the sounding leaf
   *  node's own beat grid, or null when there's no node to sweep. */
  nodePlayheadStep: number | null;
}

/** Maps a `RiffSeqPlayback.leafIndex` (a position in the fully-flattened leaf
 *  list of one top-level sequence) to the full path of child indices — one
 *  per nesting level — from the top-level entry down to the sounding leaf,
 *  since `flattenRiffEntry` recurses child by child in order and each direct
 *  child owns a contiguous run of leaves. The last element of the returned
 *  path is the leaf entry itself (a node or silence); every earlier element
 *  is a combo that must be expanded to reveal it. Used by the Instance
 *  popup's sequence tree to auto-expand exactly the branch currently
 *  sounding — at any nesting depth, not just one level in — and to
 *  karaoke-highlight every row along that branch. Returns `[]` if
 *  `leafIndex` is out of range (shouldn't happen for a valid playback
 *  result). */
export function riffLeafPath(
  sequence: readonly RiffSeqEntry[],
  nodes: readonly RiffNode[],
  combos: readonly RiffCombo[],
  leafIndex: number,
): number[] {
  let count = 0;
  for (let i = 0; i < sequence.length; i++) {
    const entry = sequence[i];
    const leaves = flattenRiffEntry(entry, nodes, combos);
    if (leafIndex < count + leaves.length) {
      const combo = combos.find((c) => c.id === entry.type);
      if (combo) return [i, ...riffLeafPath(combo.sequence, nodes, combos, leafIndex - count)];
      return [i];
    }
    count += leaves.length;
  }
  return [];
}

/** Maps `currentTime` onto a Riff instance's sequence — same step-grid math
 *  as `findFirstRiffNodeOccurrence`, run in reverse (time → position instead
 *  of position → time). Returns null when playback isn't inside this
 *  instance's region, or when `currentTime` falls past the sequence's own
 *  declared length into a silent tail (see `RiffPatternItem.sequence` doc —
 *  the sequence's total `lengthSteps` may be shorter than the tile). */
export function computeRiffSeqPlayback(
  item: Pick<RiffPatternItem, 'start' | 'end' | 'sequence'>,
  nodes: readonly RiffNode[],
  combos: readonly RiffCombo[],
  bpm: number,
  currentTime: number,
): RiffSeqPlayback | null {
  const cycle = item.end - item.start;
  if (cycle <= 0 || currentTime < item.start) return null;
  const elapsed = (currentTime - item.start) % cycle;
  const cycleSteps = riffCycleSteps(cycle, bpm);
  const stepDur = cycle / cycleSteps;
  const posSteps = elapsed / stepDur;

  let offset = 0;
  for (let i = 0; i < item.sequence.length; i++) {
    const entry = item.sequence[i];
    if (posSteps >= offset && posSteps < offset + entry.lengthSteps) {
      const withinEntry = posSteps - offset;
      let leafOffset = 0;
      const leaves = flattenRiffEntry(entry, nodes, combos);
      for (let leafIndex = 0; leafIndex < leaves.length; leafIndex++) {
        const leaf = leaves[leafIndex];
        const leafSteps = leaf.fraction * entry.lengthSteps;
        if (withinEntry >= leafOffset && withinEntry < leafOffset + leafSteps) {
          const node = leaf.nodeId ? nodes.find((n) => n.id === leaf.nodeId) ?? null : null;
          const nodePlayheadStep = node && leafSteps > 0
            ? ((withinEntry - leafOffset) / leafSteps) * node.stepsPerCycle
            : null;
          return { entryIndex: i, leafIndex, leafNodeId: leaf.nodeId, nodePlayheadStep };
        }
        leafOffset += leafSteps;
      }
      return { entryIndex: i, leafIndex: -1, leafNodeId: null, nodePlayheadStep: null };
    }
    offset += entry.lengthSteps;
  }
  return null;
}

/** Map a layer type to the shape of its items. */
export type LayerItem<T extends AnnotationLayerType> =
  T extends 'boundaries'    ? BoundaryItem     :
  T extends 'cues'          ? CueItem          :
  T extends 'spans'         ? SpanItem         :
  T extends 'lyrics'        ? LyricsItem       :
  T extends 'loops'         ? LoopItem         :
  T extends 'riff-patterns' ? RiffPatternItem  :
  never;

/** Locates the entry at `path` (dot-index chain — one array index per nesting
 *  level, root sequence first, same shape `riffLeafPath` produces) within
 *  THIS `item`'s own sequence, and returns its absolute [start, end) in
 *  seconds for cycle 0 — same step-grid math as `findFirstRiffNodeOccurrence`,
 *  but keyed by the caller's own tree position instead of searching for a
 *  node id's first appearance across the whole layer. That distinction
 *  matters when the same node is used more than once in one sequence: the
 *  Instance popup's sequence tree knows exactly which occurrence the user
 *  has expanded (by path), and Tap Along there should loop tightly around
 *  *that* turn, not silently jump to wherever the id happens to appear
 *  first. Returns null if `path` doesn't resolve to a real leaf (e.g. an
 *  out-of-range index, or a non-final path element that isn't a combo). */
export function riffEntryOccurrenceAtPath(
  item: Pick<RiffPatternItem, 'start' | 'end' | 'sequence'>,
  path: readonly number[],
  combos: readonly RiffCombo[],
  bpm: number,
): { start: number; end: number } | null {
  if (path.length === 0) return null;
  const cycleSec = Math.max(0.01, item.end - item.start);
  const cycleSteps = riffCycleSteps(cycleSec, bpm);
  const stepDur = cycleSec / cycleSteps;

  let sequence: readonly RiffSeqEntry[] = item.sequence;
  let offsetSteps = 0;
  let budgetSteps = 0;

  for (let level = 0; level < path.length; level++) {
    const idx = path[level];
    const entry = sequence[idx];
    if (!entry) return null;

    if (level === 0) {
      // Top-level entries carry absolute step widths directly (their
      // `lengthSteps` live in the same units as `cycleSteps`).
      offsetSteps = sequence.slice(0, idx).reduce((s, e) => s + e.lengthSteps, 0);
      budgetSteps = entry.lengthSteps;
    } else {
      // Inside a combo, a child's `lengthSteps` is only meaningful relative
      // to its siblings — scale by the parent's own budget, same as
      // `flattenRiffEntry`'s combo recursion.
      const total = sequence.reduce((s, e) => s + e.lengthSteps, 0) || 1;
      const before = sequence.slice(0, idx).reduce((s, e) => s + e.lengthSteps, 0);
      offsetSteps += (before / total) * budgetSteps;
      budgetSteps = (entry.lengthSteps / total) * budgetSteps;
    }

    if (level === path.length - 1) break;
    const combo = combos.find((c) => c.id === entry.type);
    if (!combo) return null;
    sequence = combo.sequence;
  }

  const startSec = item.start + offsetSteps * stepDur;
  return { start: startSec, end: startSec + budgetSteps * stepDur };
}

// ─── Layer + Document ───────────────────────────────────────────────────────

/** One stretch of continuous singing on a lyrics layer — the prominence-
 *  carrying unit of a voice. See `AnnotationLayer.vocalRuns`. */
export interface VocalRun {
  /** Stable once materialized. Derived runs get a deterministic id keyed to
   *  their start time so the same lyrics always yield the same ids and an
   *  unmaterialized run can still be the target of an edit. */
  id: string;
  /** Track seconds, like every other lane coordinate — NOT item-relative. The
   *  `prominence` envelope inside is item-relative to `start`, as everywhere. */
  start: number;
  end: number;
  prominence?: ProminenceEnvelope;
}

export interface AnnotationLayer<T extends AnnotationLayerType = AnnotationLayerType> {
  /** Stable across renames. */
  id: string;
  /** User-visible name shown in the Annotations dropdown and editor header. */
  name: string;
  type: T;
  /** Canvas show/hide toggle. */
  visible: boolean;
  /** CSS hex color used for ticks/intervals on this layer. */
  color: string;
  /** Inert — see SnapMode. The grid unit selector decides what a layer snaps
   *  to, and lyrics never snap. */
  snap: SnapMode;
  items: LayerItem<T>[];
  /** True when the layer is derived from a custom detector run rather than
   *  authored by the annotator. Editors must disable add/edit/delete on
   *  read-only layers; the canvas renders them identically. */
  readOnly?: boolean;
  /** Origin marker used by the merge logic. `'user'` = persisted in
   *  annotation-layers; `'detector:<name>'` = re-derived each render from
   *  the detector's cached envelope. Optional for forward compat. */
  source?: 'user' | `detector:${string}`;
  /** Detector name this layer was *copied* from via "Copy to manual layer".
   *  Distinct from `source: 'detector:<name>'` (which marks ephemeral, not-
   *  persisted detector mirrors): a layer with `importedFrom` is a normal
   *  persisted manual layer that just happens to remember where its seed
   *  points came from. The annotator edits it freely; the original detector
   *  output is untouched. UI may show a "from <X>" badge. */
  importedFrom?: string;
  /** Demucs stem a detector-sourced layer was built from ("vocals" | "drums" |
   *  "bass" | "other" | "guitar" | "piano"), "mix" for whole-track
   *  detectors, or "stems" for one lane read from several stems and never the
   *  mix. Drives the lane label's stem tag and the highlight shown while
   *  that stem is auditioned. Only set on read-only detector layers; undefined
   *  on user-authored ones. */
  sourceStem?: 'vocals' | 'drums' | 'bass' | 'other' | 'guitar' | 'piano' | 'mix' | 'stems';
  /** The detector's one-line manifest `description` — the algorithm/heuristic
   *  this layer's items came from (e.g. "RMS energy presence of the vocals
   *  Demucs stem"). Surfaced in the lane's ⓘ info popover. Only set on
   *  read-only detector layers; undefined on user-authored ones. */
  sourceDescription?: string;
  /** Caveats the detector raised about THIS run — an input it could not judge
   *  properly, not a failure. Surfaced in the lane's ⓘ popover, with a ⚠ on
   *  the button so it does not need opening to be noticed. A groove built on
   *  hits that could not be named looks exactly like one built on clean hits,
   *  so without this the lane's confidence is indistinguishable from its
   *  correctness. Only set on read-only detector layers. */
  sourceNotes?: { code: string; message: string }[];
  /** The layer's big picture in one line, for a reader of the export who should
   *  not have to read every item to get it — a copied groove's main loops,
   *  ranked by how many bars they play (drumGrooves.ts `grooveSummary`). The
   *  light-show agent sees it under the section heading, above the rows. */
  summary?: string;
  /** The drum a riff-patterns layer plays — `hat`, `snare`, `kick` … (the
   *  groove lane's rows, drumGrooves.ts `GROOVE_ROWS`). Set on a copied drum
   *  groove, so its hits keep that drum's colour and a reader of the export
   *  knows which drum the figures are; absent on a riff drawn by hand. */
  drum?: string;
  /** Per-layer evaluation mode. Default `'full-annotation'` when omitted —
   *  pre-Phase-2 documents on disk don't have this field. See `LayerEvalMode`. */
  mode?: LayerEvalMode;
  /** Lyrics layers only: the stretches where the voice is actually singing,
   *  each carrying its own prominence envelope. See `utils/vocalRuns.ts`.
   *
   *  A lyrics layer is ONE instrument sampled at word resolution, not a bag of
   *  independently placed items the way a riff-patterns layer is — so the front/
   *  back arc belongs to the voice, not to each word. Storing it per word would
   *  put several hundred 200ms blocks in the Prominence lane; storing one
   *  envelope for the whole layer would force the instrumental break between two
   *  choruses to be spelled as a `silent` stretch, which draws a block on the
   *  Silent tier asserting something nobody annotated. A run per sung stretch
   *  gives the lane exactly what the ear hears: two choruses, two blocks, and
   *  nothing at all over the break.
   *
   *  Absent means "not materialized" — the runs are derived from the word
   *  timings on read, which is why an imported lyrics layer needs no migration.
   *  The first prominence edit stores the whole derived list, ids included, so
   *  later lyric corrections can't renumber what the annotator has edited. */
  vocalRuns?: VocalRun[];
  /** Lyrics layers only: how long a silence has to be, in bars, before it
   *  splits one vocal run from the next. Absent ⇒ DEFAULT_VOCAL_RUN_GAP_BARS.
   *  Per layer rather than global because the line between a long breath and a
   *  real break is a property of the song being annotated. Only affects DERIVED
   *  runs; once `vocalRuns` is stored, changing this does nothing until the
   *  annotator re-derives. */
  vocalRunGapBars?: number;
  /** Riff-patterns layers only: named motif library. Each node has its own
   *  beat-chip grid and is referenced by combos and pattern instances. */
  nodes?: RiffNode[];
  /** Riff-patterns layers only: ordered motif sequences that may nest other
   *  combos. Referenced by pattern instances on the timeline. */
  combos?: RiffCombo[];
  /** Group this layer belongs to, or absent when it is ungrouped. Points at an
   *  `AnnotationLayerGroup.id` in the same document. A layer is in at most one
   *  group, and groups don't nest.
   *
   *  Membership lives here rather than as a member list on the group because
   *  every authored lane — boundaries included, since they became a layer type
   *  — has a persisted record to hang it on: the field prunes itself when the
   *  layer is deleted, and there is no second list to keep in sync. Detector
   *  lanes are the exception: they are re-derived each render and never
   *  persisted, so they cannot be grouped. */
  groupId?: string;
  /** Locked from the lane's ⋮ menu: nothing may change what the layer says —
   *  its items, riff library, vocal runs — until it is unlocked. Name, colour,
   *  visibility and group stay editable. Enforced at the one funnel every
   *  document edit goes through (see `lockedLayerEdited`), so no edit path
   *  needs to know about it. */
  locked?: boolean;
}

/** A named, coloured band over lanes that already exist. Grouping is
 *  orthogonal to type: a group can hold a boundaries layer, two Spans layers
 *  and a Loops layer at once, and none of them changes shape by joining.
 *
 *  The group record carries only its own identity and display state — which
 *  layers are in it is answered by their `groupId`, and their ORDER is the
 *  document's own `layers` order (already "ordered as displayed"), kept
 *  contiguous by `groupLayers` below. */
export interface AnnotationLayerGroup {
  id: string;
  /** User-visible name shown on the group header row. */
  name: string;
  /** CSS hex colour for the header, the member rule and the collapsed summary.
   *  Identity only — members keep their own colours until the annotator asks
   *  for "apply colour to members". */
  color: string;
  /** Collapsed groups hide their member rows behind a single summary lane. */
  collapsed?: boolean;
  /** How the group draws when expanded. `'stacked'` (default) gives every
   *  member its own row; `'merged'` packs every member's items into one row.
   *  Only 'stacked' is implemented today — the field exists so a merged
   *  renderer can land later without touching stored documents. */
  display?: 'stacked' | 'merged';
}

/** The single per-song-per-annotator document persisted by the layers API. */
export interface AnnotationLayersDocument {
  song: string;
  /** ISO timestamp of last save. */
  annotated_at: string;
  /** Ordered as displayed on the canvas; drag-reorder mutates this list. */
  layers: AnnotationLayer[];
  /** Workflow status per layer type (cues/spans/loops/lyrics). Missing keys
   *  read as 'in_progress'. Set by the shared annotation toolbar's status pill. */
  statusByType?: LayerStatusByType;
  /** Layer groups, in header order. Absent on every document written before
   *  groups existed, which is why every reader treats it as optional rather
   *  than defaulting it on load. */
  groups?: AnnotationLayerGroup[];
  /** The server's write counter for this file — every save bumps it. Read
   *  back on load and named by the next save, which the server refuses if
   *  the file has moved on (see saveLayers). Absent until the first save. */
  rev?: number;
  /** How the file states WHERE items are. Absent = seconds: every item carries
   *  `time` / `start` / `end` (and, with a grid, its beat stamp beside them).
   *  `'beats'` = written under Grid Lock: an item with a beat stamp is stored
   *  by its musical position ONLY — `beat`, or `startBeat` / `endBeat` — with
   *  no seconds, and its `candidates` are beats too. Lyrics are never stamped
   *  (a sung word is timed to the voice), so they keep their seconds either
   *  way, as do the fields that describe the sound rather than its place
   *  (a cue's `decay`, an `envelope`, a prominence envelope's item-relative
   *  `t`). Readers turn beats back into seconds with `grid.tempoMap` — see
   *  utils/beatTimebase.ts and tools/python/layers_timebase.py. In memory the
   *  app always holds seconds; the beats form exists only on disk. */
  timebase?: 'beats';
  /** The grid the beat positions in this file are counted on, written with
   *  every save on a song that has one. A beat number means nothing without
   *  it, so a file that stores beats is never written without this. */
  grid?: LayersGrid;
}

/** One stretch of constant tempo: from `beat` (fractional beats from the grid
 *  origin) at `time` (seconds), `bpm` beats a minute. A beat before the first
 *  entry is extrapolated at the first entry's tempo. */
export interface LayersGridTempo {
  beat: number;
  time: number;
  bpm: number;
}

/** The song's grid as a layers file records it. `bpm` / `gridOffset` /
 *  `timeSignature` / `gridMode` are the song's own settings, copied so the
 *  file says what it was counted against; `tempoMap` is the same grid resolved
 *  into constant-tempo stretches, which is all a reader needs to turn a beat
 *  into seconds (one entry unless the song is split into grid segments).
 *  Hand-placed (pinned) beats are not part of it — beats are converted on the
 *  macro grid, as everywhere else (see utils/beatAnchoring.ts). */
export interface LayersGrid {
  bpm: number;
  gridOffset: number;
  timeSignature: string;
  beatsPerBar: number;
  gridMode: 'static' | 'mapped' | 'manual';
  tempoMap: LayersGridTempo[];
}

// ─── Factories ──────────────────────────────────────────────────────────────

export function emptyDocument(song: string): AnnotationLayersDocument {
  return { song, annotated_at: new Date().toISOString(), layers: [], statusByType: {} };
}

/** Read the status for a layer type from a document, defaulting to in_progress
 *  when the field is missing (older files on disk pre-status-pill). */
export function getLayerStatus(
  doc: AnnotationLayersDocument | null | undefined,
  type: keyof LayerStatusByType,
): AnnotationStage {
  return doc?.statusByType?.[type] ?? 'in_progress';
}

/** Set the status for a layer type, returning a new document. */
export function setLayerStatus(
  doc: AnnotationLayersDocument,
  type: keyof LayerStatusByType,
  stage: AnnotationStage,
): AnnotationLayersDocument {
  return {
    ...doc,
    statusByType: { ...(doc.statusByType ?? {}), [type]: stage },
  };
}

// ─── Layer groups ───────────────────────────────────────────────────────────
//
// Display order is the document's own `layers` order — there is no second
// ordering to keep in sync. The canvas walks `layers`, and when it reaches the
// first member of a group it draws that group's header followed by every
// member; `normalizeGroupOrder` is what guarantees the members it finds next
// are the whole group. The `groups` array is a lookup table for name/colour/
// collapsed state, and its own order is not meaningful.

/** Group header palette. Deliberately distinct from `DEFAULT_LAYER_COLORS` so
 *  a band never reads as one of its own members. */
const GROUP_COLORS = [
  '#a78bfa', // violet
  '#22d3ee', // cyan
  '#f59e0b', // amber
  '#fb7185', // rose
  '#4ade80', // green
  '#818cf8', // indigo
] as const;

export function pickGroupColor(existingGroups: readonly AnnotationLayerGroup[]): string {
  return pickFromPalette(GROUP_COLORS, existingGroups.map((g) => g.color), existingGroups.length);
}

export function newLayerGroup(name: string, color: string): AnnotationLayerGroup {
  return { id: newId(), name, color, collapsed: false, display: 'stacked' };
}

export function findGroup(
  doc: AnnotationLayersDocument | null | undefined,
  groupId: string | null | undefined,
): AnnotationLayerGroup | undefined {
  if (!groupId) return undefined;
  return doc?.groups?.find((g) => g.id === groupId);
}

/** Members of a group, in document (display) order. */
export function layersInGroup(
  doc: AnnotationLayersDocument | null | undefined,
  groupId: string,
): AnnotationLayer[] {
  return (doc?.layers ?? []).filter((l) => l.groupId === groupId);
}

/** Tri-state for the group header's visibility box: every member shown, some
 *  of them, or none. An empty group reads as 'none' — it has nothing to show. */
export function groupVisibility(
  doc: AnnotationLayersDocument | null | undefined,
  groupId: string,
): 'all' | 'some' | 'none' {
  const members = layersInGroup(doc, groupId);
  if (members.length === 0) return 'none';
  const shown = members.filter((l) => l.visible).length;
  if (shown === 0) return 'none';
  return shown === members.length ? 'all' : 'some';
}

/** The workflow pill a group shows: the weakest state among its members, so a
 *  band only reads `reviewed` once every lane in it does. Derived on every
 *  render rather than stored — a stored copy would drift the moment a member
 *  is edited from its own panel. */
export function groupPillDisplay(
  doc: AnnotationLayersDocument | null | undefined,
  groupId: string,
): AnnotationPillDisplay {
  const members = layersInGroup(doc, groupId);
  if (members.length === 0) return 'not_started';
  const per = members.map((l) => derivePillDisplay(
    l.items.length > 0,
    doc?.statusByType?.[l.type],
  ));
  if (per.every((p) => p === 'reviewed')) return 'reviewed';
  if (per.every((p) => p === 'not_started')) return 'not_started';
  return 'in_progress';
}

/** Pull every grouped layer up against the first member of its group, leaving
 *  ungrouped layers where they are. Called on every write that could scatter a
 *  group, and defensively on load, so the canvas can assume that reaching one
 *  member means the rest follow immediately. Stable: nothing moves that is
 *  already contiguous, so a no-op returns the same array reference. */
export function normalizeGroupOrder(layers: readonly AnnotationLayer[]): AnnotationLayer[] {
  const byGroup = new Map<string, AnnotationLayer[]>();
  for (const l of layers) {
    if (!l.groupId) continue;
    const bucket = byGroup.get(l.groupId);
    if (bucket) bucket.push(l);
    else byGroup.set(l.groupId, [l]);
  }
  if (byGroup.size === 0) return layers as AnnotationLayer[];
  const emitted = new Set<string>();
  const out: AnnotationLayer[] = [];
  for (const l of layers) {
    if (!l.groupId) { out.push(l); continue; }
    if (emitted.has(l.groupId)) continue;   // already flushed with its group
    emitted.add(l.groupId);
    out.push(...byGroup.get(l.groupId)!);
  }
  const unchanged = out.length === layers.length && out.every((l, i) => l === layers[i]);
  return unchanged ? (layers as AnnotationLayer[]) : out;
}

/** Create a group holding `layerIds`, which are pulled together in document
 *  order at the position of the first one. Detector-sourced layers are skipped:
 *  they are re-derived each render and never persisted, so a groupId on them
 *  would not survive the round trip. Returns the document unchanged when no
 *  eligible layer is named. */
export function groupLayers(
  doc: AnnotationLayersDocument,
  layerIds: readonly string[],
  name: string,
  color?: string,
): { doc: AnnotationLayersDocument; group: AnnotationLayerGroup | null } {
  const wanted = new Set(layerIds);
  const eligible = doc.layers.filter((l) => wanted.has(l.id) && !l.readOnly);
  if (eligible.length === 0) return { doc, group: null };
  const group = newLayerGroup(name, color ?? pickGroupColor(doc.groups ?? []));
  const ids = new Set(eligible.map((l) => l.id));
  const layers = normalizeGroupOrder(
    doc.layers.map((l) => (ids.has(l.id) ? { ...l, groupId: group.id } : l)),
  );
  return { doc: { ...doc, layers, groups: [...(doc.groups ?? []), group] }, group };
}

/** Move one layer into a group, or out of every group when `groupId` is null. */
export function setLayerGroup(
  doc: AnnotationLayersDocument,
  layerId: string,
  groupId: string | null,
): AnnotationLayersDocument {
  const layer = doc.layers.find((l) => l.id === layerId);
  if (!layer || layer.readOnly) return doc;
  if ((layer.groupId ?? null) === groupId) return doc;
  const layers = normalizeGroupOrder(doc.layers.map((l) => {
    if (l.id !== layerId) return l;
    const next = { ...l };
    if (groupId) next.groupId = groupId;
    else delete next.groupId;
    return next;
  }));
  return { ...doc, layers };
}

/** Put one layer in the group called `name`, creating the group when the
 *  document has none by that name. How a copied detector lane joins the rest
 *  of its detector group's copies: the first copy makes the group, the next
 *  ones find it. A group the annotator renamed is no longer found, and the
 *  next copy starts a fresh one rather than guessing. */
export function addLayerToGroupNamed(
  doc: AnnotationLayersDocument,
  layerId: string,
  name: string,
): AnnotationLayersDocument {
  const existing = (doc.groups ?? []).find((g) => g.name === name);
  if (existing) return setLayerGroup(doc, layerId, existing.id);
  return groupLayers(doc, [layerId], name).doc;
}

/** Dissolve the band and keep every lane — the non-destructive half of the
 *  pair. `deleteGroupAndLayers` is the other one, and they are deliberately
 *  never spelled the same way in the UI. */
export function ungroupLayers(
  doc: AnnotationLayersDocument,
  groupId: string,
): AnnotationLayersDocument {
  return {
    ...doc,
    layers: doc.layers.map((l) => {
      if (l.groupId !== groupId) return l;
      const next = { ...l };
      delete next.groupId;
      return next;
    }),
    groups: (doc.groups ?? []).filter((g) => g.id !== groupId),
  };
}

/** Remove the group AND every lane in it. Callers confirm first, naming the
 *  lanes that go — see `layersInGroup`. */
export function deleteGroupAndLayers(
  doc: AnnotationLayersDocument,
  groupId: string,
): AnnotationLayersDocument {
  return {
    ...doc,
    layers: doc.layers.filter((l) => l.groupId !== groupId),
    groups: (doc.groups ?? []).filter((g) => g.id !== groupId),
  };
}

/** Patch a group's own fields (name, colour, collapsed, display). */
export function updateGroup(
  doc: AnnotationLayersDocument,
  groupId: string,
  patch: Partial<Omit<AnnotationLayerGroup, 'id'>>,
): AnnotationLayersDocument {
  return {
    ...doc,
    groups: (doc.groups ?? []).map((g) => (g.id === groupId ? { ...g, ...patch } : g)),
  };
}

/** Show or hide every member at once. Members stay individually toggleable
 *  afterwards — this writes their `visible` rather than shadowing it, so the
 *  header box goes back to reading 'some' the moment one is flipped back. */
export function setGroupVisible(
  doc: AnnotationLayersDocument,
  groupId: string,
  visible: boolean,
): AnnotationLayersDocument {
  return {
    ...doc,
    layers: doc.layers.map((l) => (l.groupId === groupId ? { ...l, visible } : l)),
  };
}

/** Drop groupIds that point at a group the document no longer has, and groups
 *  whose id is duplicated. Cheap to run on load; returns the same object when
 *  there is nothing to fix. */
export function pruneGroups(doc: AnnotationLayersDocument): AnnotationLayersDocument {
  const seen = new Set<string>();
  const groups = (doc.groups ?? []).filter((g) => {
    if (seen.has(g.id)) return false;
    seen.add(g.id);
    return true;
  });
  const live = new Set(groups.map((g) => g.id));
  let touched = groups.length !== (doc.groups?.length ?? 0);
  const layers = doc.layers.map((l) => {
    if (!l.groupId || live.has(l.groupId)) return l;
    touched = true;
    const next = { ...l };
    delete next.groupId;
    return next;
  });
  if (!touched) {
    const ordered = normalizeGroupOrder(doc.layers);
    return ordered === doc.layers ? doc : { ...doc, layers: ordered };
  }
  return { ...doc, layers: normalizeGroupOrder(layers), groups };
}

/** Layer types whose items can be dragged from one lane into another. Only
 *  between lanes of the SAME type, so an item never changes shape on the way.
 *  Boundaries stay put on purpose — they tile their lane, so taking one out
 *  re-cuts two sections — and so do riff placements, which point at their own
 *  lane's node library. */
export const CROSS_LANE_ITEM_TYPES: ReadonlySet<AnnotationLayerType> = new Set(['cues', 'spans', 'loops', 'lyrics']);

/** Where an item starts, whichever way its type spells it. */
export function itemStartTime(item: { time?: number; start?: number }): number {
  return item.time ?? item.start ?? 0;
}

/** True when any of `incoming` overlaps a loop already in `existing` — the one
 *  drop a Loops lane refuses, because loops in a lane must tile. */
export function loopsWouldOverlap(
  existing: readonly { start: number; end: number }[],
  incoming: readonly { start: number; end: number }[],
): boolean {
  return incoming.some((a) => existing.some((b) => a.start < b.end && b.start < a.end));
}

/** Hand items from one layer to another of the same type, at the times in
 *  `originals` — the items as they were when the drag began, so a nudge along
 *  time on the way over doesn't count. `move` takes them out of the source and
 *  keeps their ids; otherwise the source gets its originals back and the target
 *  gets copies with fresh ids. Returns the same document when the transfer
 *  isn't allowed: different types, a read-only end, a type not in
 *  CROSS_LANE_ITEM_TYPES, or loops that would overlap the target's.
 *
 *  A lyrics layer's stored `vocalRuns` are left as they are on both ends: a
 *  target with none derives its runs from the words, and one with stored runs
 *  is the annotator's own reading, which re-derives only when asked. */
export function transferItems(
  doc: AnnotationLayersDocument,
  fromLayerId: string,
  toLayerId: string,
  originals: readonly { id: string }[],
  { move }: { move: boolean },
): AnnotationLayersDocument {
  if (fromLayerId === toLayerId || originals.length === 0) return doc;
  const from = doc.layers.find((l) => l.id === fromLayerId);
  const to = doc.layers.find((l) => l.id === toLayerId);
  if (!from || !to || from.type !== to.type || from.readOnly || to.readOnly) return doc;
  if (!CROSS_LANE_ITEM_TYPES.has(from.type)) return doc;
  const byId = new Map(originals.map((it) => [it.id, it]));
  const sourceItems = from.items as readonly { id: string }[];
  if (!sourceItems.some((it) => byId.has(it.id))) return doc;
  const carried = sourceItems.flatMap((it) => byId.get(it.id) ?? []);
  if (to.type === 'loops' && loopsWouldOverlap(
    to.items as readonly LoopItem[], carried as unknown as readonly LoopItem[],
  )) return doc;
  const arriving = move ? carried : carried.map((it) => ({ ...it, id: newId() }));
  return {
    ...doc,
    layers: doc.layers.map((l) => {
      if (l.id === fromLayerId) {
        const items = move
          ? sourceItems.filter((it) => !byId.has(it.id))
          : sourceItems.map((it) => byId.get(it.id) ?? it);
        return { ...l, items } as typeof l;
      }
      if (l.id === toLayerId) return { ...l, items: [...l.items, ...arriving] } as typeof l;
      return l;
    }),
  };
}

/** Palette used by `newCueLayer` when the caller doesn't pass an explicit color. */
const DEFAULT_LAYER_COLORS = [
  '#34d399', // emerald
  '#60a5fa', // sky
  '#fbbf24', // amber
  '#f472b6', // pink
  '#a78bfa', // violet
  '#22d3ee', // cyan
] as const;

export function pickDefaultLayerColor(existingLayers: AnnotationLayer[]): string {
  const used = new Set(existingLayers.map((l) => l.color));
  for (const c of DEFAULT_LAYER_COLORS) if (!used.has(c)) return c;
  return DEFAULT_LAYER_COLORS[existingLayers.length % DEFAULT_LAYER_COLORS.length];
}

/** Boundaries default to bar-snap: a section change that lands off the bar
 *  line is almost always a mis-tap, and the popover can still nudge it. */
export function newBoundaryLayer(name: string, color: string): AnnotationLayer<'boundaries'> {
  return {
    id: newId(),
    name,
    type: 'boundaries',
    visible: true,
    color,
    snap: 'bar',
    items: [],
  };
}

export function newBoundaryItem(time: number, type: string, label = ''): BoundaryItem {
  return { id: newId(), time, type, label };
}

export function newCueLayer(name: string, color: string): AnnotationLayer<'cues'> {
  return {
    id: newId(),
    name,
    type: 'cues',
    visible: true,
    color,
    snap: 'beat',
    items: [],
  };
}

/** Backend-supported but gated by the experimental-annotation-types flag in
 *  Settings (see the Span TODO in tools/python/custom_api.py). */
export function newSpanLayer(name: string, color: string): AnnotationLayer<'spans'> {
  return {
    id: newId(),
    name,
    type: 'spans',
    visible: true,
    color,
    snap: 'beat',
    items: [],
  };
}

export function newLoopLayer(name: string, color: string): AnnotationLayer<'loops'> {
  return {
    id: newId(),
    name,
    type: 'loops',
    visible: true,
    color,
    snap: 'bar',  // Loops default to bar-snap; cues default to beat-snap.
    items: [],
  };
}

/** Lyrics layers default to no snap — word timestamps are sub-beat and should
 *  not be quantized to the grid. */
export function newLyricsLayer(name: string, color: string): AnnotationLayer<'lyrics'> {
  return {
    id: newId(),
    name,
    type: 'lyrics',
    visible: true,
    color,
    snap: 'off',
    items: [],
  };
}

export function newCueItem(time: number, label = '', description = ''): CueItem {
  return { id: newId(), time, label, description };
}

/** How long a word lasts when nothing said how long: added by hand at the
 *  playhead, or read from a file that stored only its start. About one sung
 *  syllable — long enough to see and grab, short enough not to swallow the
 *  next word. */
export const LYRIC_DEFAULT_SEC = 0.3;
/** The shortest a lyric may be: under this its band is too thin to grab. */
export const LYRIC_MIN_SEC = 0.05;

/** A new lyric item. Every lyric is a span — a word lasts as it is sung, a
 *  line as long as it runs — so one with no `end` given gets the default. */
export function newLyricsItem(
  time: number,
  text = '',
  kind: 'word' | 'line' = 'word',
  end?: number,
): LyricsItem {
  return { id: newId(), time, text, kind, end: end !== undefined && end > time ? end : time + LYRIC_DEFAULT_SEC };
}

/** Give every lyric a real length. Words used to be allowed to be points: a
 *  hand-added word had no `end`, an aligner word could come back zero-length,
 *  and a beat snap could pull both edges of a short word onto one beat. Such a
 *  word drew as a tick with no band and no edge to drag, and its card had no
 *  End. One without a usable end gets the default length, stopping short of
 *  the next lyric where that leaves room. Returns the same array when nothing
 *  needed fixing. */
export function withLyricSpans<T extends Pick<LyricsItem, 'time' | 'end'>>(items: readonly T[]): T[] {
  if (items.every((it) => it.end != null && it.end - it.time >= LYRIC_MIN_SEC)) return items as T[];
  const starts = items.map((it) => it.time).sort((a, b) => a - b);
  return items.map((it) => {
    if (it.end != null && it.end - it.time >= LYRIC_MIN_SEC) return it;
    const next = starts.find((t) => t > it.time + LYRIC_MIN_SEC);
    const end = Math.max(it.time + LYRIC_MIN_SEC, Math.min(it.time + LYRIC_DEFAULT_SEC, next ?? Infinity));
    return { ...it, end };
  });
}

export function newSpanItem(start: number, end: number, label = '', description = ''): SpanItem {
  return { id: newId(), start, end, label, description };
}

export function newLoopItem(start: number, end: number): LoopItem {
  return { id: newId(), start, end, label: '', description: '', snapZeroCross: true };
}

// ─── Riff-pattern factories ──────────────────────────────────────────────────

export function newRiffPatternLayer(name: string, color: string): AnnotationLayer<'riff-patterns'> {
  return {
    id: newId(),
    name,
    type: 'riff-patterns',
    visible: true,
    color,
    snap: 'bar',
    items: [],
    nodes: [],
    combos: [],
  };
}

/** A node `lengthBeats` long on the default pulse (sixteenths), holding one
 *  rest — the user (or a detector) writes notes into it. */
export function newRiffNode(name: string, color: string, lengthBeats = 4): RiffNode {
  const stepsPerCycle = Math.max(1, Math.round(lengthBeats * PATTERN_SUBBEATS_PER_BEAT));
  return {
    id: newId(),
    name,
    color,
    stepsPerCycle,
    subbeatsPerBeat: PATTERN_SUBBEATS_PER_BEAT,
    segments: normalizeBoundarySegments([], stepsPerCycle / PATTERN_SUBBEATS_PER_BEAT),
  };
}

export function newRiffCombo(name: string, color: string): RiffCombo {
  return { id: newId(), name, color, sequence: [] };
}

export function newRiffPatternItem(start: number, end: number, label = ''): RiffPatternItem {
  return { id: newId(), start, end, label, sequence: [], repeatCount: 1 };
}

export function newRiffSeqEntry(type: string, lengthSteps: number): RiffSeqEntry {
  return { type, lengthSteps: Math.max(1, Math.floor(lengthSteps)) };
}

/** uuid via crypto.randomUUID when available; cheap fallback otherwise. */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
