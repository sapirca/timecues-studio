/**
 * Editor + read-only strip for a *boundary node* — the un-quantised sibling
 * of the beat-chip grid (see `RiffNode.kind` / `RiffBoundarySegment`).
 *
 * A grid node asks "which of these N sub-beat slots are on?", which forces
 * every hit onto an inferred subdivision and makes the karaoke sweep drift
 * whenever that inference is wrong. A boundary node asks nothing: it's a
 * gapless list of `[start, end)` blocks in beats from the node's start, each
 * either a tick or a rest, with fractional edges kept exactly as detected or
 * dragged. The karaoke highlight here is a plain relative-time lookup
 * (`boundarySegmentIndexAt`) with no division math in the path at all.
 *
 * Two views, sharing one geometry:
 *  - `BoundaryStrip` — a tiny non-interactive render for the canvas lane and
 *    sequence chips, the boundary-node counterpart of `ChipStrip`.
 *  - `BoundarySegmentEditor` — the full editor: drag across the strip to
 *    declare a span ("2 to 3.5 beats, this happens" — the gesture this node
 *    kind exists for), click to drop or clear a single short tick, drag
 *    boundaries, alt-click to split, plus a numeric block list where a whole
 *    block can be flipped tick/rest outright. Blocks
 *    can also arrive wholesale rather than by hand: tapped in live against the
 *    real audio (the owner drives `useTapAlong` and feeds the result through
 *    `boundarySegmentsFromTaps`), or read off another layer's items via
 *    `tickSources` / `BoundaryTickSourceMenu` — either replacing the blocks or
 *    merging into them, or taken straight from the detected onsets drawn
 *    under them, which needs no tapping and no other layer at all.
 *
 * Either view can also be shown against the audio it's describing: give the
 * editor `onsetCurve` + `onsetSources` and the strip draws the onset-strength
 * envelope and the detected onsets over the blocks, reports how many ticks
 * actually sit on one, and offers both directions of acting on that: snap the
 * ticks that nearly sit on an onset, or take the ticks *from* the onsets —
 * marking all of them on a node that says nothing yet, adding only the
 * unmarked ones once it says something. That comparison is the reason a
 * boundary node is un-quantised in the first place — the grid it should agree
 * with is the audio, not a subdivision.
 *
 * Which makes the drawn curve the editor's own claim, and every peak in it
 * with no tick on it the editor contradicting itself on screen. Two things
 * answer that. `ONSET_PEAK_FLOOR` is low enough that a bump you can see is a
 * bump that gets picked (over-marking is a block you delete; under-marking is
 * a hunt), and the width picker defaults to a ±10 ms MARKER rather than a
 * measured block — so what comes back from "Mark N onsets" is one hairline per
 * peak, a row of ticks you can count against the curve above them, instead of
 * a dozen measured sustains tiled into a solid bar.
 */

import { useEffect, useRef, useState } from 'react';
import {
  markerHits, ONSET_MARKER_SEC, withMeasuredEnds,
} from '../../utils/onsetWindow';
import type { RiffBoundarySegment } from '../../types/annotationLayer';
import {
  alignBoundaryToOnsets, appendBoundaryTick, BOUNDARY_MIN_SEGMENT_BEATS,
  BOUNDARY_ONSET_MATCH_BEATS,
  boundarySegmentIndexAt, boundarySegmentsFromHits, dropBoundaryTickAt,
  mergeBoundaryHits, moveBoundary,
  normalizeBoundarySegments, paintBoundaryRange, removeBoundarySegment,
  snapBoundaryToOnsets, splitBoundaryAt,
} from '../../types/annotationLayer';

/** Snap choices offered next to the strip. `0` means free/unquantised —
 *  the default, since not quantising is the entire point of this node kind.
 *  The others exist only as a convenience for hand-built rhythms. */
const SNAP_OPTIONS: { value: number; label: string }[] = [
  { value: 0,     label: 'free' },
  { value: 1,     label: '1 beat' },
  { value: 0.5,   label: '1/2' },
  { value: 0.25,  label: '1/4' },
  { value: 1 / 3, label: '1/3' },
];

/** Widths offered for a seeded block.
 *
 *  `MARKER_WIDTH` (a hairline either side of the onset — see
 *  `ONSET_MARKER_SEC`) is the default, and it is the only entry that is a
 *  width rather than a ceiling: every other value caps a block whose real end
 *  was measured off the loudness, so a hit that stops sooner keeps its own
 *  shorter length. The beat fractions exist because the right answer is a
 *  property of the music, not of the app — a hi-hat pattern wants 1/8 and a
 *  sparse pad wants 2, and neither is wrong — but none of them is the right
 *  default for the question this node is usually asked: WHERE are the hits.
 *  Marked from measured blocks, a dense passage tiles solid and the rhythm
 *  stops being legible; marked from markers, it is a row of ticks you can
 *  count. */
const MARKER_WIDTH = 0;

const WIDTH_OPTIONS: { value: number; label: string }[] = [
  { value: MARKER_WIDTH, label: '±10 ms' },
  { value: 0.125, label: '1/8' },
  { value: 0.25,  label: '1/4' },
  { value: 0.5,   label: '1/2' },
  { value: 1,     label: '1 beat' },
  { value: 2,     label: '2 beats' },
];

/** How far the pointer must travel before a press on the strip counts as
 *  drawing a span rather than as a click on the block under it. */
const PAINT_DRAG_SLOP_PX = 3;

/** Reserved value of the onset picker's "off" entry — never a real source id
 *  (those are `audio` or `cues:<layer id>`). */
const ONSET_REF_OFF = '__off';

function snapBeat(beat: number, snap: number): number {
  if (!snap) return beat;
  return Math.round(beat / snap) * snap;
}

/** True while the node still says nothing — one full-length rest, or a list
 *  of rests with no tick anywhere in it.
 *
 *  This is the state every boundary node is *born* in (`newRiffBoundaryNode`
 *  seeds a single `empty` block), and drawing it in the rest language — a
 *  transparent lane cell, a diagonal hatch in the editor — renders a brand
 *  new node as a hole. "Nothing marked here yet" and "this block is
 *  deliberately silent" then look identical, and the first one is what the
 *  user is staring at while wondering whether the node drew at all. So an
 *  untouched node is filled instead: a plain block in its own colour, dimmer
 *  than a tick so it can never be mistaken for one. The hatch goes back to
 *  meaning a rest the moment a tick exists to rest between. */
function hasNoTicks(segments: readonly RiffBoundarySegment[]): boolean {
  return !segments.some((s) => s.kind === 'tick');
}

/** Fill for that untouched state — solid enough to read as a block from the
 *  canvas lane, well below a tick's own `bb`-to-opaque alpha. */
function untouchedFill(color: string): string {
  return `${color}55`;
}

/** The onset envelope as `x,y` pairs in a 0-100 viewBox stretched over the
 *  strip (`preserveAspectRatio="none"`), so the curve needs no pixel widths
 *  and re-lays itself out with the popover. */
function onsetCurvePoints(curve: readonly number[]): string {
  return curve
    .map((v, i) => {
      const x = (i / (curve.length - 1)) * 100;
      const y = 100 - Math.min(1, Math.max(0, v)) * 100;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

/** Same curve closed along the bottom edge, for the fill under the line. */
function onsetCurveArea(curve: readonly number[]): string {
  return `M0,100 L${onsetCurvePoints(curve).split(' ').join(' L')} L100,100 Z`;
}

/** The alignment readout's middle clause: the median offset, in milliseconds
 *  when the node's real placement is known (which is what a person can hear),
 *  in beats when it isn't. Signed — `+` means the blocks sit late. */
function fmtOffset(offsetBeats: number, secPerBeat?: number): string {
  if (secPerBeat && secPerBeat > 0) {
    const ms = Math.round(offsetBeats * secPerBeat * 1000);
    return `${ms >= 0 ? '+' : '−'}${Math.abs(ms)} ms`;
  }
  return `${offsetBeats >= 0 ? '+' : '−'}${fmtBeat(Math.abs(offsetBeats))} beat`;
}

/** Trims trailing zeros so a block edge reads `2.5`, not `2.5000`. */
function fmtBeat(b: number): string {
  return String(Number(b.toFixed(4)));
}

/** A block-edge number field that commits only on blur or Enter.
 *
 *  Committing on every keystroke looks reasonable but is unusable here: each
 *  edit is clamped against the neighbouring blocks and written straight back
 *  into the field, so typing `0.37` gets clamped to the minimum on the very
 *  first `0` and every later keystroke then appends to *that* — the user ends
 *  up with `0.0104`. Holding a draft lets the whole number be typed before
 *  anything is clamped. */
function BeatInput({
  value, disabled, ariaLabel, onCommit,
}: {
  value: number;
  disabled: boolean;
  ariaLabel: string;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // Drop the draft whenever the committed value changes underneath the field
  // (a neighbouring drag, an onset re-seed, a length change) — adjusted
  // during render rather than in an effect, so the input never paints one
  // frame of a stale draft.
  const [seenValue, setSeenValue] = useState(value);
  if (seenValue !== value) {
    setSeenValue(value);
    setDraft(null);
  }

  const commit = () => {
    if (draft === null) return;
    const n = Number(draft);
    setDraft(null);
    if (Number.isFinite(n) && n !== value) onCommit(n);
  };

  return (
    <input
      type="number"
      step={0.25}
      value={draft ?? fmtBeat(value)}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') setDraft(null);
      }}
      aria-label={ariaLabel}
      className="w-12 bg-[#0a0b0d] border border-white/[0.06] rounded px-1 py-0.5 text-slate-200 disabled:text-slate-600 focus:outline-none focus:ring-1 focus:ring-orange-400/40"
    />
  );
}

// ─── Read-only strip (canvas lane + sequence chips) ─────────────────────────

/** Miniature render of a boundary node's blocks, scaled to fill its box.
 *  Ticks are drawn in the node's color, rests left dark — same "faint
 *  background, bright content" language `ChipStrip` uses for grid nodes, so
 *  the two kinds read alike on the canvas despite different content models. */
export function BoundaryStrip({
  color, segments, lengthBeats, playheadBeat = null,
}: {
  color: string;
  segments: readonly RiffBoundarySegment[];
  lengthBeats: number;
  playheadBeat?: number | null;
}) {
  const len = Math.max(1e-6, lengthBeats);
  const untouched = hasNoTicks(segments);
  return (
    <div
      className="relative w-full h-full flex items-stretch overflow-hidden"
      style={untouched ? { backgroundColor: untouchedFill(color) } : undefined}
    >
      {segments.map((seg, i) => (
        <div
          key={i}
          className="h-full flex-shrink-0"
          style={{
            width: `${((seg.end - seg.start) / len) * 100}%`,
            backgroundColor: seg.kind === 'tick' ? color : 'transparent',
            borderLeft: i === 0 || untouched ? undefined : '1px solid rgba(0,0,0,0.45)',
          }}
        />
      ))}
      {playheadBeat != null && playheadBeat >= 0 && playheadBeat <= len && (
        <span
          className="absolute top-0 bottom-0 w-px bg-white/80 pointer-events-none"
          style={{ left: `${(playheadBeat / len) * 100}%` }}
        />
      )}
    </div>
  );
}

// ─── Editor ─────────────────────────────────────────────────────────────────

export interface BoundarySegmentEditorProps {
  color: string;
  segments: readonly RiffBoundarySegment[];
  /** The node's full length. Blocks always tile exactly `[0, lengthBeats)`. */
  lengthBeats: number;
  /** Live playhead offset from the node's start, in beats — `null` when this
   *  node isn't currently sounding. Drives the karaoke highlight. */
  playheadBeat?: number | null;
  onChange: (segments: RiffBoundarySegment[]) => void;
  readOnly?: boolean;
  /** Layers the blocks can be rebuilt from — the selected onset/cue layers and
   *  any lyrics layer with words inside this node's placement. Empty/absent ⇒
   *  the "From layer" button isn't offered (nothing is placed anywhere yet, or
   *  no layer has anything in this window). */
  tickSources?: readonly BoundaryTickSource[];
  /** Snap, in beats (`0` = free). Controlled so the owner can quantise a Tap
   *  Along session with the very value shown in the picker; left uncontrolled
   *  the editor keeps its own. */
  snap?: number;
  onSnapChange?: (snapBeats: number) => void;
  /** How wide a seeded block is, in beats. `0` is the default and means a
   *  MARKER — `ONSET_MARKER_SEC` either side of the onset, a statement about
   *  position and nothing else. Any other value is a ceiling instead: the
   *  measured release ends a block earlier wherever it fires, and this is what
   *  stops a dense passage from reading as one solid bar. Controlled like
   *  `snap`, for the same reason: the owner seeds from the value the picker is
   *  showing. */
  maxTickBeats?: number;
  onMaxTickBeatsChange?: (beats: number) => void;
  /** The audio's onset-strength envelope across exactly this node's span,
   *  normalised to 0-1 and evenly spaced — sample `i` sits at beat
   *  `i / (length - 1) * lengthBeats`. Drawn behind the blocks so the rhythm
   *  can be read against the transients it is supposed to mark. Absent ⇒ no
   *  audio is analysed yet, or the node isn't placed anywhere. */
  onsetCurve?: readonly number[];
  /** The audio's loudness (RMS) across exactly this node's span, normalised
   *  0-1 on the same columns as `onsetCurve`. This is what gives a block its
   *  LENGTH: flux says where a hit starts and is back at the floor while the
   *  note is still sounding, so a node seeded without this has to fall back to
   *  a fixed one-beat block for a stab and a held chord alike. */
  levelCurve?: readonly number[];
  /** Onset positions the blocks can be compared and snapped to, by source —
   *  the audio's own picked peaks (per stem, where stems exist) plus every
   *  detected onset/cue layer. The first is the default; the picker can also
   *  turn the overlay off. */
  onsetSources?: readonly BoundaryOnsetSource[];
  /** Which source the picker is showing, whenever it changes (`null` = off).
   *  A source whose audio has to be fetched and analysed — an isolated stem —
   *  is only worth that work once it's the one being looked at, so the owner
   *  loads on this rather than up front. */
  onOnsetRefChange?: (sourceId: string | null) => void;
  /** Seconds per beat in this node's real placement, used only to report the
   *  alignment offset in milliseconds instead of beats. */
  secPerBeat?: number;
  /** While a Tap Along session is recording: clicking the strip lands a tap at
   *  the clicked beat instead of flipping that block, so a hit the hand missed
   *  can be placed by eye mid-loop — the boundary counterpart of
   *  `BeatChipPicker`'s `onTapAlongTap`. */
  onTapAtBeat?: (beat: number) => void;
}

/** One layer offered as a source of ticks — see `BoundaryTickSourceMenu`. */
export interface BoundaryTickSource {
  id: string;
  name: string;
  /** What kind of layer this is, for the menu's grouping label. */
  kind: 'cues' | 'lyrics';
  /** How many of its items fall inside this node's placement. */
  count: number;
  /** Replaces the node's blocks with ticks converted from those items. */
  apply: () => void;
  /** Adds the ones this node isn't already marking and keeps every existing
   *  block — `mergeBoundaryHits`. Absent ⇒ only Replace is offered. */
  applyMerge?: () => void;
  /** Where this source's ticks land, in beats from the node's start. Lets a
   *  cue layer double as the reference the strip draws and snaps to. */
  tickBeats?: readonly number[];
}

/** One set of onset positions the blocks can be measured against. */
export interface BoundaryOnsetSource {
  id: string;
  name: string;
  /** Onset positions in beats from the node's start. */
  beats: readonly number[];
  /** This source's own envelope across the node, same shape as `onsetCurve` —
   *  an isolated stem draws the stem's shape, not the mix's. Absent for a
   *  source that is a list of positions and nothing more (a cue layer), which
   *  keeps the mix curve behind it as context. */
  curve?: readonly number[];
  /** This source's loudness across the node, same shape again — how long each
   *  of its hits actually rings for. Absent for a positions-only source, which
   *  falls back to the page's `levelCurve` the way `curve` does. */
  levelCurve?: readonly number[];
  /** Set while the source's audio is still being fetched and analysed, or
   *  after that failed. A source in either state has no `beats` yet, so the
   *  alignment readout would otherwise announce a confident `0 / 23`. */
  status?: 'loading' | 'error';
}

export function BoundarySegmentEditor({
  color, segments, lengthBeats, playheadBeat = null,
  onChange, readOnly = false, tickSources, snap: snapProp, onSnapChange, onTapAtBeat,
  maxTickBeats: widthProp, onMaxTickBeatsChange,
  onsetCurve, levelCurve, onsetSources, onOnsetRefChange, secPerBeat,
}: BoundarySegmentEditorProps) {
  const len = Math.max(1e-6, lengthBeats);
  const [ownSnap, setOwnSnap] = useState(0);
  const snap = snapProp ?? ownSnap;
  const setSnap = (v: number) => { setOwnSnap(v); onSnapChange?.(v); };
  const [ownWidth, setOwnWidth] = useState<number>(MARKER_WIDTH);
  const tickWidth = widthProp ?? ownWidth;
  const setTickWidth = (v: number) => { setOwnWidth(v); onMaxTickBeatsChange?.(v); };
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // The span currently being drawn across the strip, in beats. Held in state
  // (not committed per move) so a drag paints once, on release: committing
  // every frame would leave one undo entry per pixel and would re-tile the
  // blocks under the pointer while it's still moving.
  const [paint, setPaint] = useState<{ from: number; to: number; kind: RiffBoundarySegment['kind'] } | null>(null);
  // Set when a drag actually painted, so the click React fires afterwards
  // doesn't also flip the block that ended up under the pointer. Cleared by
  // the next press as well as by the click it swallows.
  const paintedRef = useRef(false);
  const activeIndex = playheadBeat != null ? boundarySegmentIndexAt(segments, playheadBeat) : -1;
  const untouched = hasNoTicks(segments);
  // The block list is a short scroll box, and a node with a couple of dozen
  // blocks (anything seeded from onsets) shows about five of them. Nothing in
  // the panel said so — the app's scrollbars are 5px at 10% white over near
  // black — so the rest of the list read as missing. These two track whether
  // there's more list above/below the box, for the edge shading below.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [listOverflow, setListOverflow] = useState({ above: false, below: false });

  // Which onset set the strip is drawn and measured against. `null` means
  // "not chosen yet" and falls through to the first source (the audio's own
  // peaks), so the comparison is there on open rather than after a click.
  const [onsetRefId, setOnsetRefId] = useState<string | null>(null);
  const sources = onsetSources ?? [];
  const onsetRef = onsetRefId === null
    ? (sources[0] ?? null)
    : (sources.find((s) => s.id === onsetRefId) ?? null);
  const showOnsets = onsetRef !== null;
  const refBeats = onsetRef?.beats ?? [];
  const refStatus = onsetRef?.status;
  // The selected source's own shape where it has one (a stem), the page's
  // envelope otherwise (a cue layer, which is positions only).
  const refCurve = onsetRef?.curve ?? onsetCurve;
  // Same fallback for the loudness, and for the same reason: a cue layer has
  // no audio of its own, but the hits it names still ring out in the mix.
  const refLevel = onsetRef?.levelCurve ?? levelCurve;
  // A source still loading has no positions yet — measuring against none of
  // them would report a flat "0 / 23 on an onset", which is a claim about the
  // blocks rather than about the fetch.
  const alignment = showOnsets && !refStatus ? alignBoundaryToOnsets(segments, refBeats, len) : null;
  // The chosen source's onsets that actually fall inside this node — the very
  // ones the strip draws dashed. Taking the blocks *from* them is the reason
  // the detector ran at all: before this, a node with no ticks could only be
  // filled by hand or by tapping, and "Snap to onsets" sat disabled because
  // there was nothing to move — telling the user the audio was useless to
  // them at exactly the moment it was most useful.
  const onsetsInside = showOnsets && !refStatus
    ? refBeats.filter((b) => Number.isFinite(b) && b >= 0 && b < len)
    : [];
  // `ONSET_MARKER_SEC` in this node's own beats. Undefined `secPerBeat` means
  // the node isn't placed anywhere and there is no tempo to convert through —
  // which in practice never coincides with having onsets to mark, since both
  // come from the same placement, so the fallback only has to be sane rather
  // than right: the narrowest block the model can hold.
  // Never below half the minimum block width, so the marker cannot come out
  // narrower than `normalizeBoundarySegments` will keep. A fixed time buys
  // *fewer* beats the slower the song is, and under about 30 bpm — a bad BPM
  // entry, a placement stretched far past its node's length — 10 ms stops
  // being expressible as a block at all. Dropped silently, that is a hit
  // detected, drawn, counted in the readout and marked by nothing, which is
  // the one failure this whole row exists to prevent.
  const markerHalfBeats = Math.max(
    BOUNDARY_MIN_SEGMENT_BEATS / 2,
    secPerBeat && secPerBeat > 0 ? ONSET_MARKER_SEC / secPerBeat : BOUNDARY_MIN_SEGMENT_BEATS,
  );
  const markerMode = tickWidth === MARKER_WIDTH;
  // Each of those onsets with a length: a hairline centred on it in marker
  // mode, otherwise the length it actually rings for, read off the loudness
  // under this node. Without a level curve there is nothing to read and the
  // hits carry no end at all, which is what puts `boundarySegmentsFromHits`
  // back on its fixed cap — a fallback, not the intent.
  const onsetHits = markerMode
    ? markerHits(onsetsInside.map((beat) => ({ beat })), markerHalfBeats, len)
    : withMeasuredEnds(onsetsInside.map((beat) => ({ beat })), refLevel, len, { maxBeats: tickWidth });
  // Replace while the node says nothing, add while it says something: the two
  // are different enough that neither is a safe default, so the button names
  // whichever one it's about to do rather than leaving a rule to remember.
  const markMode: 'replace' | 'merge' = alignment && alignment.ticks > 0 ? 'merge' : 'replace';
  // What the button would actually add, counted by `mergeBoundaryHits`' own
  // rule — *not* the readout's `missedOnsets`, which asks the narrower
  // question "did a tick *start* on this onset?". An onset sitting inside a
  // long held tick is unmarked by that measure and already covered by this
  // one, and a button promising three hits that lands two is worse than a
  // readout and a button disagreeing.
  const unmarkedHits = markMode === 'merge'
    ? onsetHits.filter(({ beat }) => !segments.some((s) => (
      s.kind === 'tick'
      && (Math.abs(s.start - beat) <= BOUNDARY_ONSET_MATCH_BEATS || (beat >= s.start && beat < s.end))
    )))
    : onsetHits;
  const unmarkedOnsets = unmarkedHits.length;

  const commit = (next: RiffBoundarySegment[]) => onChange(normalizeBoundarySegments(next, len));

  const syncListOverflow = () => {
    const el = listRef.current;
    if (!el) return;
    const below = el.scrollHeight - el.scrollTop - el.clientHeight > 1;
    const above = el.scrollTop > 1;
    setListOverflow((prev) => (prev.above === above && prev.below === below ? prev : { above, below }));
  };

  // Re-measure whenever the list's content changes under it (blocks added,
  // removed, re-seeded from a layer) — a scroll event won't fire for that.
  useEffect(syncListOverflow, [segments.length]);

  // Keep the row under the playhead visible. Scrolled by hand rather than with
  // `scrollIntoView`, which is free to scroll every ancestor as well and would
  // yank the whole popover around on each block boundary.
  useEffect(() => {
    const el = listRef.current;
    if (!el || activeIndex < 0) return;
    const row = el.children[activeIndex] as HTMLElement | undefined;
    if (!row) return;
    const rowBox = row.getBoundingClientRect();
    const listBox = el.getBoundingClientRect();
    if (rowBox.top < listBox.top) el.scrollTop -= listBox.top - rowBox.top;
    else if (rowBox.bottom > listBox.bottom) el.scrollTop += rowBox.bottom - listBox.bottom;
  }, [activeIndex]);

  /** Pointer x → beat offset within the strip. */
  const beatAtClientX = (clientX: number): number | null => {
    const el = stripRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return frac * len;
  };

  const toggleKind = (i: number) => {
    if (readOnly) return;
    commit(segments.map((s, idx) => (
      idx === i ? { ...s, kind: s.kind === 'tick' ? 'empty' : 'tick' } : s
    )));
  };

  const onStripClick = (e: React.MouseEvent) => {
    if (paintedRef.current) { paintedRef.current = false; return; }
    // A live tap session owns the strip: a click is one more tap, not an edit
    // of whatever block happens to sit under the pointer.
    if (onTapAtBeat) {
      const beat = beatAtClientX(e.clientX);
      if (beat != null) onTapAtBeat(snapBeat(beat, snap));
      return;
    }
    if (readOnly) return;
    const beat = beatAtClientX(e.clientX);
    if (beat == null) return;
    // Alt-click splits at the exact spot clicked; a plain click drops a short
    // tick there (or clears the tick it landed on) — never a whole-block flip,
    // which on a one-block node would fill the entire lane. See
    // `dropBoundaryTickAt`.
    if (e.altKey) commit(splitBoundaryAt(segments, snapBeat(beat, snap), len));
    else commit(dropBoundaryTickAt(segments, snapBeat(beat, snap), len));
  };

  /** Drags a span across the strip: press inside a block, move, release, and
   *  the whole swept range becomes one block — a tick when the drag started
   *  on a rest, a rest when it started on a tick, mirroring what a plain
   *  click does to a single block. Below the movement threshold nothing is
   *  painted and the click handler takes over, so a click is still a click.
   *  Boundary handles stop the event before it gets here, and alt (split) and
   *  a live tap session both opt out. */
  const startPaintDrag = (i: number) => (e: React.PointerEvent) => {
    // Clear first, before any early return: a drag that ends over a *different*
    // block fires its click on the strip rather than on a block, so the flag
    // would otherwise still be up and would eat the user's next real click.
    paintedRef.current = false;
    if (readOnly || onTapAtBeat || e.altKey || e.button !== 0) return;
    const from = beatAtClientX(e.clientX);
    if (from == null) return;
    const kind: RiffBoundarySegment['kind'] = segments[i]?.kind === 'tick' ? 'empty' : 'tick';
    const startX = e.clientX;
    let span: { from: number; to: number } | null = null;
    const onMove = (ev: PointerEvent) => {
      // A few pixels of slop: a click nudged by the mouse button must not
      // silently become a hair-thin block.
      if (Math.abs(ev.clientX - startX) < PAINT_DRAG_SLOP_PX) return;
      const to = beatAtClientX(ev.clientX);
      if (to == null) return;
      span = { from: snapBeat(from, snap), to: snapBeat(to, snap) };
      setPaint({ ...span, kind });
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      setPaint(null);
      if (!span) return;
      paintedRef.current = true;
      commit(paintBoundaryRange(segments, span.from, span.to, kind, len));
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  /** Drags the boundary before segment `index` (never the outer edges — the
   *  node's own length is edited through the Length field above). */
  const startBoundaryDrag = (index: number) => (e: React.PointerEvent) => {
    if (readOnly || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setDragIndex(index);
    let latest: RiffBoundarySegment[] = [...segments];
    const onMove = (ev: PointerEvent) => {
      const beat = beatAtClientX(ev.clientX);
      if (beat == null) return;
      latest = moveBoundary(latest, index, snapBeat(beat, snap), len);
      onChange(latest);
    };
    const onUp = () => {
      setDragIndex(null);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  /** Lays the next tick down after the last one — the "add a block of info
   *  with a length" path, for building a rhythm by hand instead of from
   *  onsets. See `appendBoundaryTick`. */
  const addBlock = () => {
    if (readOnly) return;
    commit(appendBoundaryTick(segments, len));
  };

  const setEdge = (index: number, value: number) => {
    if (readOnly) return;
    commit(moveBoundary(segments, index, value, len));
  };

  // Whole-beat guide lines. Informational only — blocks never snap to them
  // unless the user explicitly picks a snap value.
  const beatLines: number[] = [];
  for (let b = 1; b < len; b += 1) beatLines.push(b);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[9px]">
        <span className="uppercase tracking-wider text-slate-300">Blocks</span>
        <span className="text-slate-600 tabular-nums" title={`${segments.length} blocks in this node`}>
          {segments.length}
        </span>
        <span className="text-slate-500 normal-case">
          {onTapAtBeat
            ? 'tapping — click the strip to land a hit by eye'
            : paint
              ? `${fmtBeat(Math.min(paint.from, paint.to))} – ${fmtBeat(Math.max(paint.from, paint.to))} beats · ${paint.kind === 'tick' ? 'tick' : 'rest'}`
              : 'drag to mark a span · click to drop a tick · alt-click to split · drag an edge'}
        </span>
        <label className="ml-auto flex items-center gap-1 text-slate-500">
          width
          <select
            value={tickWidth}
            onChange={(e) => setTickWidth(Number(e.target.value))}
            title="How wide a block seeded from the audio is. ±10 ms marks where each onset is and claims nothing about how long it lasts — the reading that keeps a dense passage legible instead of tiling it solid. Every other value is a CEILING: the block's real end is measured off the loudness, so a hit that stops sooner keeps its own shorter length."
            className="bg-[#0a0b0d] border border-white/[0.06] rounded px-1 py-0.5 text-[10px] text-slate-200 focus:outline-none focus:ring-1 focus:ring-orange-400/40"
          >
            {WIDTH_OPTIONS.map((o) => (
              <option key={o.label} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-slate-500">
          snap
          <select
            value={snap}
            onChange={(e) => setSnap(Number(e.target.value))}
            className="bg-[#0a0b0d] border border-white/[0.06] rounded px-1 py-0.5 text-[10px] text-slate-200 focus:outline-none focus:ring-1 focus:ring-orange-400/40"
          >
            {SNAP_OPTIONS.map((o) => (
              <option key={o.label} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div
        ref={stripRef}
        className="relative h-9 rounded border border-white/[0.08] bg-[#0a0b0d] overflow-hidden select-none flex items-stretch"
      >
        {beatLines.map((b) => (
          <span
            key={`g${b}`}
            className="absolute top-0 bottom-0 w-px bg-white/[0.07] pointer-events-none"
            style={{ left: `${(b / len) * 100}%` }}
          />
        ))}

        {segments.map((seg, i) => {
          const isActive = i === activeIndex;
          const isTick = seg.kind === 'tick';
          // A rest only looks like a rest once something is resting between
          // ticks; in an untouched node the hatch reads as "failed to draw".
          const isUntouchedRest = !isTick && untouched;
          return (
            <div
              key={i}
              className={`relative h-full flex-shrink-0 flex items-center justify-center ${readOnly && !onTapAtBeat ? '' : 'cursor-pointer'}`}
              style={{
                width: `${((seg.end - seg.start) / len) * 100}%`,
                backgroundColor: isTick
                  ? (isActive ? color : `${color}bb`)
                  : isUntouchedRest
                    ? untouchedFill(color)
                    : (isActive ? 'rgba(148,163,184,0.22)' : 'transparent'),
                boxShadow: isActive ? `inset 0 0 0 1px ${isTick ? '#fff' : 'rgba(226,232,240,0.7)'}` : undefined,
                backgroundImage: isTick || isUntouchedRest
                  ? undefined
                  : 'repeating-linear-gradient(135deg, rgba(148,163,184,0.16) 0 2px, transparent 2px 5px)',
              }}
              onPointerDown={startPaintDrag(i)}
              onClick={onStripClick}
              title={`${fmtBeat(seg.start)} – ${fmtBeat(seg.end)} beats · ${isTick ? 'tick' : 'empty'}${seg.label ? ` · ${seg.label}` : ''}`}
            >
              {/* Draggable boundary handle on this block's left edge. The
                  first block has no handle: beat 0 is the node's start. */}
              {i > 0 && !readOnly && (
                <span
                  role="separator"
                  aria-label={`Move boundary at beat ${fmtBeat(seg.start)}`}
                  onPointerDown={startBoundaryDrag(i)}
                  className={`absolute left-0 top-0 bottom-0 -ml-1 w-2 cursor-ew-resize z-10 ${
                    dragIndex === i ? 'bg-orange-300/60' : 'hover:bg-orange-300/40'
                  }`}
                />
              )}
            </div>
          );
        })}

        {/* The audio's own shape, over the blocks rather than behind them: a
            tick is a solid bar in the node's colour, so an envelope drawn
            underneath would be hidden by exactly the blocks it is there to be
            compared against. Cyan, because nothing else in this card is. */}
        {showOnsets && refCurve && refCurve.length > 1 && (
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
            className="absolute inset-0 w-full h-full pointer-events-none z-10"
          >
            {/* Loudness first, and only as a fill: it is the slow shape the
                flux spikes sit on, and it is what decides how long each block
                runs — drawn so a block ending halfway through a ringing note
                is something you can SEE rather than a number to trust. */}
            {refLevel && refLevel.length > 1 && (
              <path d={onsetCurveArea(refLevel)} fill="rgba(148,163,184,0.18)" />
            )}
            <path d={onsetCurveArea(refCurve)} fill="rgba(56,189,248,0.16)" />
            <polyline
              points={onsetCurvePoints(refCurve)}
              fill="none"
              stroke="rgba(125,211,252,0.85)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}

        {/* Detected onsets themselves. Dashed so they can't be mistaken for a
            block edge, which is the one other vertical line in this strip. */}
        {showOnsets && refBeats.map((beat, i) => (
          beat >= 0 && beat <= len ? (
            <span
              key={`o${i}`}
              className="absolute top-0 bottom-0 w-px pointer-events-none z-10"
              style={{
                left: `${(beat / len) * 100}%`,
                backgroundImage: 'linear-gradient(to bottom, rgba(56,189,248,0.95) 0 3px, transparent 3px 6px)',
                backgroundSize: '1px 6px',
              }}
            />
          ) : null
        ))}

        {paint && (
          <span
            className="absolute top-0 bottom-0 pointer-events-none z-10 border-x border-white/60"
            style={{
              left: `${(Math.min(paint.from, paint.to) / len) * 100}%`,
              width: `${(Math.abs(paint.to - paint.from) / len) * 100}%`,
              backgroundColor: paint.kind === 'tick' ? `${color}99` : 'rgba(15,17,21,0.75)',
            }}
          />
        )}

        {playheadBeat != null && playheadBeat >= 0 && playheadBeat <= len && (
          <span
            className="absolute top-0 bottom-0 w-px bg-white pointer-events-none z-20"
            style={{ left: `${(playheadBeat / len) * 100}%`, boxShadow: '0 0 6px rgba(255,255,255,0.8)' }}
          />
        )}
      </div>

      {/* Blocks vs. the audio. One row: what it's being compared against, how
          well it agrees, and the one action that acts on the disagreement —
          so there's no rule to remember about where the number came from. */}
      {sources.length > 0 && (
        <div className="flex items-center gap-1.5 text-[9px]">
          <label className="flex items-center gap-1 text-slate-500 shrink-0">
            onsets
            <select
              value={onsetRef?.id ?? ONSET_REF_OFF}
              onChange={(e) => {
                setOnsetRefId(e.target.value);
                onOnsetRefChange?.(e.target.value === ONSET_REF_OFF ? null : e.target.value);
              }}
              title="Which onsets the strip draws, measures and snaps against — the full mix, one isolated stem, or a detected onset/cue layer"
              className="bg-[#0a0b0d] border border-white/[0.06] rounded px-1 py-0.5 text-[10px] text-slate-200 focus:outline-none focus:ring-1 focus:ring-orange-400/40"
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
              <option value={ONSET_REF_OFF}>off</option>
            </select>
          </label>

          {refStatus === 'loading' && (
            <span className="text-slate-500 italic truncate">reading {onsetRef?.name}…</span>
          )}
          {refStatus === 'error' && (
            <span className="text-red-300 truncate">couldn't read {onsetRef?.name}</span>
          )}

          {alignment && (
            <span
              className="text-slate-400 tabular-nums truncate"
              title={`Ticks whose start sits within ${fmtBeat(BOUNDARY_ONSET_MATCH_BEATS)} beat of a detected onset. “+” means the blocks are late against the audio.`}
            >
              {alignment.ticks === 0
                ? 'no ticks to compare'
                : alignment.matched === 0
                  ? `0 / ${alignment.ticks} on an onset`
                  : `${alignment.matched} / ${alignment.ticks} on an onset · median ${fmtOffset(alignment.medianOffsetBeats ?? 0, secPerBeat)}`}
              {alignment.missedOnsets > 0 && ` · ${alignment.missedOnsets} onset${alignment.missedOnsets === 1 ? '' : 's'} unmarked`}
            </span>
          )}

          <div className="ml-auto shrink-0 flex items-center gap-1.5">
            {/* Take the blocks straight from the detector — the no-tapping
                path onto the audio's own hits. Gone once there is nothing
                left to take: an onset set the node already marks in full has
                no action to offer, and the readout beside it says so. */}
            {unmarkedOnsets > 0 && (
              <button
                type="button"
                disabled={readOnly}
                onClick={() => commit(markMode === 'merge'
                  ? mergeBoundaryHits(segments, unmarkedHits, len,
                    markerMode ? { tickBeats: markerHalfBeats * 2 } : undefined)
                  // Straight from the detector, through the same path a Tap
                  // Along session takes, so the snap picker still applies: a
                  // user who asked for 1/2-beat quantisation meant it here too.
                  : boundarySegmentsFromHits(onsetHits, len, {
                    snapBeats: snap,
                    // In marker mode every hit already carries its own ends,
                    // so this only bites where a snap has collapsed them back
                    // onto each other — and there the answer is still a
                    // marker, not the one-beat default a `0` would fall to.
                    maxTickBeats: markerMode ? markerHalfBeats * 2 : tickWidth,
                  }))}
                title={markMode === 'merge'
                  ? `Add a tick on each of the ${unmarkedOnsets} detected onset${unmarkedOnsets === 1 ? '' : 's'} this node isn’t marking yet, keeping every block already here`
                  : `Fill this node with a tick on each of the ${onsetsInside.length} detected onset${onsetsInside.length === 1 ? '' : 's'} — no tapping needed`}
                className="px-2 py-0.5 rounded text-[10px] border bg-[#0a0b0d] border-white/[0.08] text-slate-300 hover:text-slate-100 hover:border-sky-400/50 transition-colors disabled:opacity-40 disabled:hover:border-white/[0.08]"
              >
                {markMode === 'merge'
                  ? `Add ${unmarkedOnsets} unmarked`
                  : `Mark ${onsetsInside.length} onset${onsetsInside.length === 1 ? '' : 's'}`}
              </button>
            )}

            <button
              type="button"
              disabled={readOnly || !alignment || alignment.matched === 0}
              onClick={() => commit(snapBoundaryToOnsets(segments, refBeats, len))}
              title="Move every tick that has an onset within a 1/8 beat onto it, keeping its length. Ticks with no onset nearby are left alone."
              className="px-2 py-0.5 rounded text-[10px] border bg-[#0a0b0d] border-white/[0.08] text-slate-300 hover:text-slate-100 hover:border-sky-400/50 transition-colors disabled:opacity-40 disabled:hover:border-white/[0.08]"
            >
              Snap to onsets
            </button>
          </div>
        </div>
      )}

      {/* Inset shading on whichever edge has more list beyond it: the only
          honest cue that the box scrolls, and unlike a gradient overlay it
          doesn't need to know the host panel's background colour. */}
      <div
        ref={listRef}
        onScroll={syncListOverflow}
        style={{
          boxShadow: [
            listOverflow.above ? 'inset 0 9px 7px -8px rgba(0,0,0,0.9)' : '',
            listOverflow.below ? 'inset 0 -9px 7px -8px rgba(0,0,0,0.9)' : '',
          ].filter(Boolean).join(', ') || undefined,
        }}
        className="max-h-64 overflow-y-auto overscroll-contain space-y-0.5 pr-0.5"
      >
        {segments.map((seg, i) => (
          <div
            key={i}
            className={`flex items-center gap-1 text-[10px] rounded px-1 py-0.5 ${
              i === activeIndex ? 'bg-white/[0.08]' : 'bg-white/[0.02]'
            }`}
          >
            <span className="text-slate-600 w-4 text-right tabular-nums">{i + 1}</span>
            <BeatInput
              value={seg.start}
              disabled={readOnly || i === 0}
              ariaLabel={`Block ${i + 1} start, in beats`}
              onCommit={(v) => setEdge(i, v)}
            />
            <span className="text-slate-600">–</span>
            <BeatInput
              value={seg.end}
              disabled={readOnly || i === segments.length - 1}
              ariaLabel={`Block ${i + 1} end, in beats`}
              onCommit={(v) => setEdge(i + 1, v)}
            />
            <button
              type="button"
              disabled={readOnly}
              onClick={() => toggleKind(i)}
              className={`px-1.5 py-0.5 rounded border uppercase tracking-wider text-[9px] transition-colors ${
                seg.kind === 'tick'
                  ? 'border-orange-400/40 text-orange-200 bg-orange-500/20 hover:bg-orange-500/30'
                  : 'border-white/[0.08] text-slate-400 hover:text-slate-200'
              }`}
              title="Flip between tick and rest"
            >
              {seg.kind === 'tick' ? 'Tick' : 'Empty'}
            </button>
            <input
              value={seg.label ?? ''}
              disabled={readOnly}
              placeholder="label"
              spellCheck={false}
              onChange={(e) => {
                const label = e.target.value;
                commit(segments.map((s, idx) => (idx === i ? { ...s, label: label || undefined } : s)));
              }}
              aria-label={`Block ${i + 1} label`}
              className="flex-1 min-w-0 bg-transparent border-none outline-none text-slate-300 placeholder-slate-600"
            />
            <button
              type="button"
              disabled={readOnly}
              onClick={() => commit(removeBoundarySegment(segments, i, len))}
              className="text-slate-600 hover:text-red-400 transition-colors px-0.5"
              title={seg.kind === 'tick'
                ? 'Remove this hit (its span becomes a rest)'
                : 'Remove this rest (its span joins the neighbour)'}
              aria-label={`Remove block ${i + 1}`}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={readOnly}
          onClick={addBlock}
          className="px-2 py-0.5 rounded text-[10px] border bg-[#0a0b0d] border-white/[0.08] text-slate-300 hover:text-slate-100 hover:border-orange-400/40 transition-colors disabled:opacity-40"
        >
          + Block
        </button>
        {tickSources && tickSources.length > 0 && (
          <div className="relative">
            <button
              type="button"
              disabled={readOnly}
              onClick={() => setSourceMenuOpen((v) => !v)}
              title="Rebuild these blocks from another layer’s items inside this node’s placement, or merge that layer’s missing hits into what’s already here"
              className="px-2 py-0.5 rounded text-[10px] border bg-[#0a0b0d] border-white/[0.08] text-slate-300 hover:text-slate-100 hover:border-orange-400/40 transition-colors disabled:opacity-40"
            >
              ⟳ From layer ▾
            </button>
            {sourceMenuOpen && (
              <BoundaryTickSourceMenu
                sources={tickSources}
                onPick={(s, mode) => {
                  if (mode === 'merge') s.applyMerge?.(); else s.apply();
                  setSourceMenuOpen(false);
                }}
                onClose={() => setSourceMenuOpen(false)}
              />
            )}
          </div>
        )}
        <span className="ml-auto text-[9px] text-slate-600 tabular-nums">
          {segments.filter((s) => s.kind === 'tick').length} ticks · {fmtBeat(len)} beats
        </span>
      </div>
    </div>
  );
}

/** Dropdown of layers whose items can be converted into this node's blocks —
 *  onsets/cues and lyric timestamps alike, each showing how many of its items
 *  actually fall inside the node's placement so an empty source is obvious
 *  before it's picked.
 *
 *  Each row offers both directions explicitly, because they are not the same
 *  action and neither is a safe default: **Replace** re-seeds the node from
 *  the layer, throwing away whatever was there (which is what you want on a
 *  node built by hand in the wrong place), while **Merge** keeps every
 *  existing block and only adds the hits the node isn't already marking
 *  (which is what you want once the hand-built rhythm is worth keeping). */
function BoundaryTickSourceMenu({
  sources, onPick, onClose,
}: {
  sources: readonly BoundaryTickSource[];
  onPick: (source: BoundaryTickSource, mode: 'replace' | 'merge') => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // Pointerdown, not mousedown: the timeline cancels its touch pointerdowns,
    // so a tap there never fires a mousedown and would leave this open.
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [onClose]);

  const groups: { kind: BoundaryTickSource['kind']; title: string }[] = [
    { kind: 'cues', title: 'Onsets / cues' },
    { kind: 'lyrics', title: 'Lyrics' },
  ];

  return (
    <div
      ref={ref}
      className="absolute z-50 bottom-full mb-1 left-0 min-w-[200px] max-h-56 overflow-y-auto rounded-lg border border-white/10 bg-[#1a1d24] shadow-xl text-[11px]"
    >
      {groups.map(({ kind, title }) => {
        const inGroup = sources.filter((s) => s.kind === kind);
        if (inGroup.length === 0) return null;
        return (
          <div key={kind}>
            <div className="px-2 pt-1.5 pb-0.5 text-[9px] uppercase tracking-wider text-slate-500">{title}</div>
            {inGroup.map((s) => (
              <div key={s.id} className="flex items-center gap-1.5 px-2 py-1 hover:bg-white/5 text-slate-200">
                <span className="flex-1 truncate" title={s.name}>{s.name}</span>
                <span className="text-[9px] text-slate-500 tabular-nums shrink-0">{s.count}</span>
                <button
                  type="button"
                  onClick={() => onPick(s, 'replace')}
                  title={`Throw away this node’s blocks and rebuild them from ${s.count} tick${s.count === 1 ? '' : 's'} in “${s.name}”`}
                  className="shrink-0 px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider border border-white/[0.10] text-slate-300 hover:text-slate-100 hover:border-orange-400/40"
                >
                  Replace
                </button>
                {s.applyMerge && (
                  <button
                    type="button"
                    onClick={() => onPick(s, 'merge')}
                    title={`Keep this node’s blocks and add whichever of the ${s.count} tick${s.count === 1 ? '' : 's'} in “${s.name}” it isn’t marking yet`}
                    className="shrink-0 px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider border border-white/[0.10] text-slate-300 hover:text-slate-100 hover:border-sky-400/50"
                  >
                    Merge
                  </button>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
