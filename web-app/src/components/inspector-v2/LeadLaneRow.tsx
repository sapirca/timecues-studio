/**
 * LeadLaneRow — "who is in front", across every annotator layer at once.
 *
 * This is the top-down half of the prominence feature. The per-item popovers
 * and band editors work bottom-up: you open one annotation and describe its own
 * arc. That is the right shape for detail work and the wrong shape for the
 * question the annotator actually asks first — *over these bars, who leads?* —
 * because answering it bottom-up means editing every competing item by hand and
 * hoping they agree.
 *
 * So: drag a bar range, pick a winner, and the handover is written into every
 * item involved in one edit. Exclusivity comes for free from the picker being
 * single-choice; nothing enforces it in the data model, which still allows a
 * genuinely shared front (call-and-response, a doubled hook).
 *
 * The lane stores nothing of its own. Every block is derived from the same
 * `prominence` envelopes the bands render, so the two surfaces cannot disagree.
 * See utils/leadLane.ts for the derivation and the assignment rules.
 *
 * That it is derived is also why it is drawn the way it is. It sits one row
 * away from the annotation lanes on the same canvas, so if it borrows their
 * visual language — layer hue, rounded chip, item label — it is read as a fifth
 * place annotations live rather than as a readout of the four that already
 * exist. So the lane is achromatic and meter-shaped: a front-to-back wash over
 * the tiers, and columns that hang off a level rule, in one neutral ramp. The
 * source layer's colour survives as a tab down each block's left edge, which is
 * enough to tell two blocks on a tier apart without the block impersonating the
 * item. See TIER_STYLE.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  leadCandidatesInRange,
  levelRegions,
  levelAtTrackTime,
  type LeadCandidate,
} from '../../utils/leadLane';
import { PROMINENCE_INFO, PROMINENCE_LEVELS, type ProminenceLevel } from '../../types/annotationLayer';
import { formatBeatPosition, getBarBeatOrigin, snapTimeToGrid, visibleGridLines } from '../../utils/beatGrid';
import { useRegionSelectDrag } from '../../hooks/useTimelineDrag';
import { formatClockTime as fmtTime } from '../../utils/clockTime';
import { BeatGridOverlay, type LaneGridProps } from './BeatGridOverlay';

/** One tier per prominence level. Fourteen pixels so a Lead block can carry a
 *  cut strip along its top edge and still leave a body big enough to click. */
const TIER_H = 18;

/** Height of the cut strip along a Lead block's top edge. Press here to split
 *  at the marked bar; press anywhere below it to reselect the whole range. */
const CUT_STRIP_H = 6;
export const LEAD_LANE_H = TIER_H * PROMINENCE_LEVELS.length;

/** Width of the colour tab down a block's left edge — the ONE place a source
 *  layer's own colour appears in this lane. */
const SPINE_W = 3;

/** Height of the level rule capping a block. */
const RULE_H = 2;

/** Diagonal hatch for a stretch two items hold at the same level. Neutral, like
 *  everything else here: the second holder's identity is in its half of the
 *  spine, not in the fill. */
const SHARED_HATCH = 'repeating-linear-gradient(45deg, rgba(255,255,255,0.17) 0 5px, transparent 5px 10px)';

/** The lane's own scale — deliberately NOT the annotation layers' palette.
 *
 *  Blocks here used to be drawn in each source layer's colour, at an alpha per
 *  tier. That made the lane a near-perfect forgery of an annotation row: same
 *  rounded chip, same hue, same label, one row apart on the same canvas — and
 *  people read it as a fifth place their annotations lived, rather than as a
 *  readout of the four they already had.
 *
 *  So the fill is achromatic and the tiers are a single ramp through it: the
 *  lane reads as a level meter, and every chromatic thing on the canvas is an
 *  annotation you can put somewhere. Provenance is not lost — it moves to the
 *  spine, the label and the tooltip, which is enough to tell two blocks on the
 *  same tier apart without the block itself pretending to BE the item.
 *
 *  The ramp stays steep for the reason it always was: the front is what the eye
 *  should find first, and a Backing tier drawn as boldly as Lead would make a
 *  well-annotated song read as a solid wall.
 *
 *  - `fill` falls away downward, so a block reads as a column hanging off its
 *    level line rather than as a filled clip.
 *  - `rule` is that line: the block's top edge, bright at Lead and nearly gone
 *    at Silent.
 *  - `bg` shades the empty tier behind the blocks, so the front/back axis is
 *    legible before anything is annotated at all.
 */
const TIER_STYLE: Record<ProminenceLevel, {
  fill: string; rule: string; text: string; ring: string; bg: string;
}> = {
  lead: {
    fill: 'linear-gradient(to bottom, rgba(226,232,240,0.34), rgba(226,232,240,0.11))',
    rule: 'rgba(248,250,252,0.92)', text: 'rgba(248,250,252,0.95)',
    ring: 'rgba(255,255,255,0.16)', bg: 'rgba(255,255,255,0.045)',
  },
  counter: {
    fill: 'linear-gradient(to bottom, rgba(226,232,240,0.22), rgba(226,232,240,0.07))',
    rule: 'rgba(226,232,240,0.62)', text: 'rgba(241,245,249,0.80)',
    ring: 'rgba(255,255,255,0.10)', bg: 'rgba(255,255,255,0.028)',
  },
  backing: {
    fill: 'linear-gradient(to bottom, rgba(226,232,240,0.13), rgba(226,232,240,0.04))',
    rule: 'rgba(203,213,225,0.40)', text: 'rgba(226,232,240,0.62)',
    ring: 'rgba(255,255,255,0.07)', bg: 'rgba(255,255,255,0.014)',
  },
  silent: {
    fill: 'linear-gradient(to bottom, rgba(226,232,240,0.06), rgba(226,232,240,0.02))',
    rule: 'rgba(148,163,184,0.26)', text: 'rgba(203,213,225,0.45)',
    ring: 'rgba(255,255,255,0.05)', bg: 'transparent',
  },
};

type LeadGridProps = LaneGridProps;

interface PendingRange {
  t0: number;
  t1: number;
  /** Viewport coords to anchor the picker at. */
  x: number;
  y: number;
  /** Tier the range was taken FROM, when it came from one block: a click on a
   *  block, or a split tick. Null for a painted drag, which selects a stretch
   *  of the track rather than any one block. Drives how much of the row the
   *  confirmation wash covers — see the `pending` overlay. */
  tier: number | null;
  /** Set when the range came off a block BELOW the lead tier. There the
   *  question is not "who is in front" — the block names one item already — but
   *  "what is this item doing from here", so the picker turns into that item's
   *  four levels rather than a cross-layer pick-list. */
  target: { itemId: string; label: string; level: ProminenceLevel } | null;
}

interface LeadLaneRowProps {
  candidates: LeadCandidate[];
  duration: number;
  currentTime: number;
  gridProps?: LeadGridProps;
  onSeek?: (time: number) => void;
  onRegionDragStart?: () => void;
  /** Commit a handover. Absent ⇒ the lane is read-only. */
  onAssignLead?: (t0: number, t1: number, winnerItemId: string | null) => void;
  /** Put one item at a level over a range, touching nobody else. Absent ⇒ the
   *  tiers below Lead are read-only and only the handover is offered. */
  onSetLevel?: (t0: number, t1: number, itemId: string, level: ProminenceLevel) => void;
  /** The range the picker is currently open over, or null once it closes. The
   *  page uses it as a zoom focus — a range with its picker open is the thing
   *  the annotator is working on, so ± zoom frames it rather than the playhead. */
  onPendingRangeChange?: (range: { start: number; end: number } | null) => void;
}

/** "bars 17–24" when there's a tempo, else the clock range.
 *
 *  `t1` is exclusive, so the last bar shown is the one before it — found by
 *  stepping back a hundredth of a bar rather than an arbitrary epsilon. Times
 *  are rounded to milliseconds on save, which is enough to push a downbeat a
 *  hair PAST its own bar line; a 1e-6 step back doesn't clear that, and the
 *  same range would then read "bars 23–28" before a save and "bars 23–29"
 *  after one. A hundredth of a bar (~22 ms at 107 BPM) absorbs the rounding
 *  while still being far smaller than any range worth labelling. */
function describeRange(t0: number, t1: number, grid: LeadGridProps | undefined, barLength: number): string {
  // Same nudge at both ends, for the same reason and in opposite directions: a
  // range STARTS on a grid line, and a start rounded a hair early reports the
  // beat that just ended.
  const p0 = cutPosAt(t0, grid);
  const p1 = cutPosAt(Math.max(t0, t1 - barLength * 0.01), grid);
  if (p0 === null || p1 === null) return `${fmtTime(t0)}–${fmtTime(t1)}`;
  // Bar-aligned ranges keep reading as bars. Beats are spelled out only when a
  // cut actually landed mid-bar, so the common case is not noisier for it.
  if (isDownbeat(p0) && isDownbeat(p1)) {
    return p0.bar === p1.bar ? `bar ${p0.bar}` : `bars ${p0.bar}–${p1.bar}`;
  }
  return `bars ${cutLabel(p0)}–${cutLabel(p1)}`;
}

/** Bar and beat a CUT falls on. A cut sits exactly on a grid line, where a time
 *  rounded to milliseconds can read as the beat that just ended — so step a
 *  fiftieth of a beat in, the same trick `describeRange` uses at the far end of
 *  a range. Without it the first cut inside a range is labelled with the
 *  range's own opening beat. */
function cutPosAt(
  t: number,
  grid: LeadGridProps | undefined,
): { bar: number; beat: number } | null {
  if (!grid?.bpm || grid.bpm <= 0) return null;
  const p = formatBeatPosition(
    t + beatLengthOf(grid) * 0.02,
    grid.bpm, grid.gridOffset ?? 0, grid.beatsPerBar ?? 4,
  );
  return { bar: p.bar, beat: p.beat };
}

/** True when a position is the first beat of its bar. Which number that is
 *  depends on the `barBeatOrigin` setting, so it is asked for rather than
 *  assumed to be 1. */
function isDownbeat(pos: { beat: number }): boolean {
  return pos.beat === getBarBeatOrigin();
}

/** "8" on a downbeat, "8·3" mid-bar — short enough for a chip. */
function cutLabel(pos: { bar: number; beat: number }): string {
  return isDownbeat(pos) ? `${pos.bar}` : `${pos.bar}\u00b7${pos.beat}`;
}

/** "bar 8" / "bar 8, beat 3" — for a tooltip, where there is room to spell it. */
function cutProse(pos: { bar: number; beat: number }): string {
  return isDownbeat(pos) ? `bar ${pos.bar}` : `bar ${pos.bar}, beat ${pos.beat}`;
}

/** Bar length in seconds, or 1 when the song has no usable tempo. */
function barLengthOf(grid: LeadGridProps | undefined): number {
  return grid?.bpm && grid.bpm > 0 ? (60 / grid.bpm) * (grid.beatsPerBar ?? 4) : 1;
}

/** Beat length in seconds, or 1 when the song has no usable tempo. */
function beatLengthOf(grid: LeadGridProps | undefined): number {
  return grid?.bpm && grid.bpm > 0 ? 60 / grid.bpm : 1;
}

/** How near a painted endpoint has to come to a block edge for that edge to
 *  win over the bar grid. See `snapEdge` for why this is in pixels. */
const MAGNET_REACH_PX = 10;

/** Beats strictly INSIDE (start, end) — the places a lead block can be cut in
 *  two. Downbeats included; they are just the beats that start a bar.
 *
 *  Beats rather than bars because a handover does not wait for the bar line:
 *  a vocal comes in on the 3, a fill hands over on the last beat, and a block
 *  only one bar long has no downbeat inside it at all and so could not be
 *  divided anywhere. Edges are excluded — a cut there splits nothing off. */
function interiorCutTimes(
  start: number,
  end: number,
  grid: LeadGridProps | undefined,
): number[] {
  if (!grid?.bpm || grid.bpm <= 0) return [];
  const margin = beatLengthOf(grid) * 0.02;
  return visibleGridLines({
    bpm: grid.bpm,
    gridOffset: grid.gridOffset ?? 0,
    beatsPerBar: grid.beatsPerBar ?? 4,
    startTime: start,
    endTime: end,
    beatOverrides: grid.beatOverrides,
  })
    .filter((l) => !l.isSubBeat && l.t > start + margin && l.t < end - margin)
    .map((l) => l.t);
}

export function LeadLaneRow({
  candidates, duration, currentTime, gridProps,
  onSeek, onRegionDragStart, onAssignLead, onSetLevel, onPendingRangeChange,
}: LeadLaneRowProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<PendingRange | null>(null);
  /** Where the cut marker is drawn: the bar nearest the pointer inside the Lead
   *  block it is over. One marker that FOLLOWS the pointer, rather than a
   *  handle on every bar line — bar lines can be four pixels apart, at which
   *  point per-bar handles tile the block and there is nothing left to aim at,
   *  but the bar nearest the pointer is always exactly under the pointer. */
  const [cut, setCut] = useState<{ key: string; t: number; end: number; target: PendingRange['target'] } | null>(null);
  const cutRef = useRef<typeof cut>(null);
  cutRef.current = cut;

  // Publish the open range to the page. In an effect rather than at each
  // setPending site so every close path — commit, cancel, Escape, unmount —
  // reports too, and the page never holds a range whose picker has gone.
  const onPendingRangeChangeRef = useRef(onPendingRangeChange);
  onPendingRangeChangeRef.current = onPendingRangeChange;
  useEffect(() => {
    onPendingRangeChangeRef.current?.(pending ? { start: pending.t0, end: pending.t1 } : null);
  }, [pending]);
  useEffect(() => () => { onPendingRangeChangeRef.current?.(null); }, []);

  // Tier names ride the horizontal scroll so they stay at the gutter's edge.
  //
  // The row's own label cell manages this with `position: sticky`, which is not
  // available here: the lane is `overflow-hidden`, and that makes it the
  // sticky-positioning container, so a sticky child would stick to the lane's
  // own left edge and scroll away with everything else. Translating by the
  // scroller's own scrollLeft lands them in exactly the place sticky would —
  // the lane begins at the gutter's right edge, so shifting content by the
  // scroll distance pins them there. Written straight to the node rather than
  // through state: this fires on every scroll frame, and re-rendering a lane
  // full of blocks for it would be visible.
  const tierNamesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = containerRef.current;
    const names = tierNamesRef.current;
    if (!el || !names) return;
    let scroller: HTMLElement | null = el.parentElement;
    while (scroller) {
      const ox = getComputedStyle(scroller).overflowX;
      if (ox === 'auto' || ox === 'scroll') break;
      scroller = scroller.parentElement;
    }
    if (!scroller) return;
    const sync = () => {
      names.style.transform = `translateX(${scroller!.scrollLeft}px)`;
    };
    sync();
    scroller.addEventListener('scroll', sync, { passive: true });
    return () => scroller!.removeEventListener('scroll', sync);
  }, []);

  // One derivation per tier. `tiers[0]` is `lead`, the only tier anything
  // writes to; the rest are there to be read.
  const tiers = useMemo(
    () => PROMINENCE_LEVELS.map((level) => ({
      level,
      regions: levelRegions(candidates, duration, level),
    })),
    [candidates, duration],
  );
  const regions = tiers[0].regions;
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  // Ranges are snapped to whole bars: the question this lane answers is a
  // musical one ("from the second chorus"), and a lead handover that lands
  // three-hundredths of a beat off a downbeat is noise in every export.
  const barLength = barLengthOf(gridProps);

  const snapTo = (t: number, division: 'bar' | 'beat'): number => {
    if (!gridProps?.bpm || gridProps.bpm <= 0) return Math.max(0, Math.min(duration, t));
    const snapped = snapTimeToGrid(
      t, gridProps.bpm, gridProps.gridOffset ?? 0, gridProps.beatsPerBar ?? 4,
      division, gridProps.beatOverrides,
    );
    return Math.max(0, Math.min(duration, snapped));
  };
  // Ranges are still painted in bars — the question the lane answers is "from
  // the second chorus", and a painted edge three-hundredths off a downbeat is
  // noise in every export. A CUT is the finer gesture, and snaps to the beat.
  const snapBar = (t: number): number => snapTo(t, 'bar');
  const snapBeat = (t: number): number => snapTo(t, 'beat');

  // `snap: false` is for ranges that are already exact — a split tick sits ON a
  // downbeat, and a region end is a real boundary. Re-snapping those would
  // round the end to the NEAREST bar, which can pull it back inside the region
  // and leave a sliver of the old lead behind the new one.
  // Edges a painted endpoint should prefer over a plain downbeat: where a lead
  // block begins or ends, and where the items themselves do. "Drag across that
  // block" is the gesture people actually make, and rounding its ends to the
  // nearest bar line trims a bar off one end as often as it adds one — so the
  // block's own edges compete with the downbeats, and the nearer one wins.
  //
  // Two tiers, and the order matters. A lead block's own edges beat everything
  // else in reach: "drag across THAT block" is the gesture, and an unrelated
  // item that happens to start a few pixels away must not steal the endpoint
  // from the block the pointer is visibly tracing. Item edges are the fallback,
  // for painting over a stretch that has no lead on it yet.
  const cutBarsByRegion = useMemo(() => {
    const m = new Map<string, number[]>();
    if (!onAssignLead) return m;
    for (const t of tiers) {
      for (const r of t.regions) {
        const key = `${t.level}-${r.start}-${r.end}`;
        if (!m.has(key)) m.set(key, interiorCutTimes(r.start, r.end, gridProps));
      }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiers, gridProps, onAssignLead]);

  const magnets = useMemo(() => {
    const blocks = new Set<number>();
    for (const t of tiers) {
      for (const r of t.regions) { blocks.add(r.start); blocks.add(r.end); }
    }
    const items = new Set<number>();
    for (const c of candidates) {
      if (!blocks.has(c.start)) items.add(c.start);
      if (!blocks.has(c.end)) items.add(c.end);
    }
    return { blocks: [...blocks], items: [...items] };
  }, [tiers, candidates]);

  const snapEdge = (t: number): number => {
    // The capture zone is in PIXELS, not in bars, because the pointer is. On a
    // three-minute track drawn 700px wide a bar is eight pixels, so a zone
    // expressed as a fraction of a bar would be two or three pixels — nothing
    // a hand can hit, and the drag would keep landing on a downbeat one bar
    // outside the block it was tracing. Zoomed in the same rule shrinks in
    // musical terms and the bar grid takes back over, which is what you want
    // once individual bars are wide enough to aim at.
    const width = containerRef.current?.getBoundingClientRect().width ?? 0;
    const reach = width > 0 && duration > 0
      ? (MAGNET_REACH_PX * duration) / width
      : barLength * 0.35;
    const nearest = (from: readonly number[]): number | null => {
      let best: number | null = null;
      let bestD = Infinity;
      for (const m of from) {
        const d = Math.abs(t - m);
        if (d < bestD && d <= reach) { best = m; bestD = d; }
      }
      return best;
    };
    const hit = nearest(magnets.blocks) ?? nearest(magnets.items) ?? snapBar(t);
    return Math.max(0, Math.min(duration, hit));
  };

  const openPicker = (
    t0: number, t1: number, clientX: number,
    snap = true, tier: number | null = null,
    target: PendingRange['target'] = null,
  ) => {
    if (!onAssignLead) return;
    const lo = snap ? snapEdge(Math.min(t0, t1)) : Math.min(t0, t1);
    const hi = snap ? snapEdge(Math.max(t0, t1)) : Math.max(t0, t1);
    // Snapping can collapse a short drag onto a single downbeat; widen it to
    // one bar rather than silently discarding the gesture.
    const fixed = hi - lo > 0.05 ? hi : snapBar(lo + barLength);
    if (fixed - lo <= 0.05) return;
    const rect = containerRef.current?.getBoundingClientRect();
    setPending({ t0: lo, t1: fixed, x: clientX, y: rect ? rect.bottom : 0, tier, target });
  };

  // The gesture lives on the lane itself rather than on a RegionDragOverlay
  // sibling, because the lead blocks have to sit ON TOP (they need hover
  // tooltips) and a sibling overlay never sees a pointerdown that lands on one.
  // Dragging across a stretch that already has a lead — to hand part of it to
  // someone else — is the single most useful gesture here, so it cannot be the
  // one that silently does nothing.
  //
  // openPicker anchors its popup at the click's x; the hook only reports a
  // midpoint for real drags, so a plain click keeps its own down-x here.
  const lastDownXRef = useRef(0);
  /** Tier index the pointerdown landed on. The drag hook reports time only, and
   *  a click on the Backing tier has to reselect the Backing block under the
   *  cursor — not whatever happens to lead at the same moment. */
  const lastDownTierRef = useRef(0);

  // Set by a split tick's pointerdown, read by the click branch below. The tick
  // deliberately does NOT stop the event: at full-track zoom a block's bar
  // ticks sit a few pixels apart and their hit zones tile the whole block, so
  // swallowing the pointerdown would take away the paint-a-range drag exactly
  // where blocks are widest. Letting it through means a press-and-drag starting
  // on a tick still paints, and only a press-and-release splits.
  const tickHitRef = useRef<{ t: number; end: number; target: PendingRange['target'] } | null>(null);

  const regionDrag = useRegionSelectDrag({
    containerRef,
    durationGetter: () => duration,
    // Preview with the same magnets the commit uses, so what the teal band
    // shows during the drag is what the picker header then says.
    transform: snapEdge,
    // A bar-snapped drag can collapse onto a single downbeat; openPicker
    // widens it to one bar rather than dropping the gesture, so any drag
    // past the threshold counts however short it ends up.
    minSpanSec: 0,
    onDragStart: onRegionDragStart,
    onRegion: (t0, t1, meta) => {
      tickHitRef.current = null;
      openPicker(t0, t1, meta.clientX);
    },
    onClick: (t) => {
      const tick = tickHitRef.current;
      tickHitRef.current = null;
      // A tick's own range is already exact — see the `snap` note on openPicker.
      if (tick && onAssignLead) {
        openPicker(tick.t, tick.end, lastDownXRef.current, false, lastDownTierRef.current, tick.target);
        return;
      }
      // Reselect the block under the cursor — on whichever tier it was — or
      // seek in a bare stretch. Every tier opens the SAME picker: the lane's
      // only write is the handover, so clicking a Counter block means "these
      // are the bars that line covers; who should be in front over them?".
      const tierIndex = lastDownTierRef.current;
      const own = tiers[tierIndex]?.regions ?? regions;
      const ownHit = own.find((r) => t >= r.start && t < r.end);
      const hit = ownHit ?? regions.find((r) => t >= r.start && t < r.end);
      if (hit && onAssignLead) {
        const level = tiers[tierIndex]?.level;
        const target = ownHit && level && level !== 'lead' && ownHit.leaders.length === 1
          ? { itemId: ownHit.leaders[0].itemId, label: ownHit.leaders[0].label, level }
          : null;
        openPicker(hit.start, hit.end, lastDownXRef.current, true, ownHit ? tierIndex : 0, target);
      } else onSeek?.(t);
    },
  });
  const dragPreview = regionDrag.preview;

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.isPrimary === false) return;
    lastDownXRef.current = e.clientX;
    const rect = containerRef.current?.getBoundingClientRect();
    lastDownTierRef.current = rect
      ? Math.max(0, Math.min(PROMINENCE_LEVELS.length - 1, Math.floor((e.clientY - rect.top) / TIER_H)))
      : 0;
    regionDrag.onPointerDown(e);
  };

  const commit = (winnerItemId: string | null) => {
    if (pending && onAssignLead) onAssignLead(pending.t0, pending.t1, winnerItemId);
    setPending(null);
  };

  /** Level mode's commit. Lead is NOT written here: handing an item the front
   *  has to demote whoever held it, which is `assignLeadOverRange`'s job and
   *  nothing this path could do on its own. */
  const commitLevel = (level: ProminenceLevel) => {
    if (!pending?.target) return;
    if (level === 'lead') onAssignLead?.(pending.t0, pending.t1, pending.target.itemId);
    else onSetLevel?.(pending.t0, pending.t1, pending.target.itemId, level);
    setPending(null);
  };

  const pickList = useMemo(
    () => (pending ? leadCandidatesInRange(candidates, pending.t0, pending.t1) : []),
    [pending, candidates],
  );

  /** The cut the picker offers: the playhead, snapped to its downbeat, when it
   *  falls strictly inside the pending range. Taking it narrows the range to
   *  everything AFTER the cut — the head keeps whoever already led it, which is
   *  what "the vocal takes over from here" means. */
  /** Where a finer cut is made, in one line — or why this range has none.
   *
   *  The picker used to offer a chip per beat inside the range, which turned
   *  into two rows of "0·1 0·2 0·3 1 1·1 …" sitting directly under the list of
   *  items: bar-and-beat numbers with nothing on screen to tie them to, read
   *  as a second, competing way of choosing WHO leads rather than as WHERE the
   *  handover falls. A beat is a place on the track, so it is picked on the
   *  track — every block carries a rail along its top edge that marks the beat
   *  under the pointer — and this line says where to go for it. */
  const splitHint = useMemo(() => {
    if (!pending) return null;
    const interior = interiorCutTimes(pending.t0, pending.t1, gridProps).length;
    if (interior === 0) return 'shorter than a beat — nothing to split. Select a longer range to divide it.';
    return 'to hand over part-way, slide the rail along the block’s top edge to a beat.';
  }, [pending, gridProps]);

  const splitCut = useMemo(() => {
    if (!pending) return null;
    const t = snapBeat(currentTime);
    if (!(t > pending.t0 + 0.05 && t < pending.t1 - 0.05)) return null;
    const pos = cutPosAt(t, gridProps);
    return { t, label: pos === null ? fmtTime(t) : cutProse(pos) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, currentTime, gridProps, duration]);

  return (
    <div
      ref={containerRef}
      // touch-pan-y: this is a region-select surface — on a phone a vertical
      // swipe still scrolls the page, a horizontal one paints the range.
      className="flex-1 relative rounded overflow-hidden bg-gray-950 touch-pan-y"
      /* A faint hairline round the whole lane in emerald-400 — the same hue as
       * its name in the gutter and as its toggle in the Annotations menu. The
       * lane's one chromatic cue, and it is on the FRAME rather than on the
       * blocks: it says "this row is a readout" without giving the readout a
       * colour of its own to be confused with a layer's. */
      style={{
        height: LEAD_LANE_H,
        cursor: onAssignLead ? 'crosshair' : 'default',
        boxShadow: 'inset 0 0 0 1px rgba(52,211,153,0.18)',
      }}
      onPointerDown={handlePointerDown}
    >
      {gridProps && (
        <BeatGridOverlay {...gridProps} duration={duration} />
      )}

      {/* The tiers themselves: a hairline between each, and a front-to-back wash
        *  across them. The wash is what stops an empty lane looking like four
        *  blank annotation tracks stacked up — it gives the vertical axis a
        *  meaning before a single block is drawn. Kept under 5% alpha so the
        *  beat grid behind still reads. These belong to the track and stay
        *  put. */}
      {PROMINENCE_LEVELS.map((level, i) => (
        <div
          key={`tier-${level}`}
          className="absolute left-0 right-0 pointer-events-none"
          style={{
            top: i * TIER_H,
            height: TIER_H,
            background: TIER_STYLE[level].bg,
            borderTop: i === 0 ? undefined : '1px solid rgba(255,255,255,0.07)',
          }}
        />
      ))}

      {/* Tier names. Behind everything and never in the way of a gesture. */}
      {/* Above the blocks, not under them: a block starting at t=0 sat right on
        *  top of "LEAD" and hid the one name the row most needs to show. They
        *  are pointer-events-none, so nothing is stolen by lifting them, and
        *  the backdrop chip keeps them readable over a block. */}
      <div ref={tierNamesRef} className="absolute inset-0 z-10 pointer-events-none select-none">
      {PROMINENCE_LEVELS.map((level, i) => (
        <div
          key={level}
          className="absolute left-0 flex items-center"
          style={{ top: i * TIER_H, height: TIER_H }}
        >
          {/* On its own the 7px name disappears into the beat grid behind it,
            *  so it gets its own backdrop rather than a heavier colour. */}
          <span
            className="text-[9px] uppercase tracking-wider text-slate-400 ml-[2px] px-[3px] py-[1px] rounded-sm leading-none"
            style={{ background: 'rgba(3,7,18,0.88)' }}
          >
            {PROMINENCE_INFO[level].short}
          </span>
        </div>
      ))}
      </div>

      {tiers.every((t) => t.regions.length === 0) && (
        <span className="absolute inset-0 flex items-center justify-center text-[10px] text-gray-700 italic select-none pointer-events-none">
          {onAssignLead ? 'nothing placed front or back yet — drag a range to hand out the lead' : 'no prominence annotated'}
        </span>
      )}

      {tiers.map(({ level, regions: tierRegions }, tierIndex) => tierRegions.map((region) => {
        const isLead = level === 'lead';
        const left = duration > 0 ? (region.start / duration) * 100 : 0;
        const width = Math.max(0.3, duration > 0 ? ((region.end - region.start) / duration) * 100 : 0);
        const shared = region.leaders.length > 1;
        const head = region.leaders[0];
        const names = region.leaders.map((l) => (l.label === l.layerName ? l.label : `${l.label} (${l.layerName})`)).join(' + ');
        // The cut rail is the ONE place a beat is chosen: every tier's block
        // carries one, so a handover part-way through a stretch is made on the
        // stretch itself rather than off a list of numbers in the picker.
        const cutKey = `${level}-${region.start}-${region.end}`;
        // A block below the lead tier names exactly one item, so a cut there
        // edits that item's own arc. On the lead tier a stretch can be shared,
        // and the question stays "who is in front" — a cross-layer pick.
        const cutTarget: PendingRange['target'] = isLead || shared
          ? null
          : { itemId: head.itemId, label: head.label, level };
        const cutBars = cutBarsByRegion.get(cutKey) ?? [];
        const showCut = cut !== null && cut.key === cutKey;
        // The beat nearest a pointer x, among this block's cut bars. Hover
        // uses it to draw the marker; the rail's press uses it again rather
        // than trusting the hovered one, because a finger never hovers — on a
        // phone the first the rail hears of a touch is the press itself.
        const nearestCutBar = (clientX: number): number | null => {
          const rect = containerRef.current?.getBoundingClientRect();
          if (!rect || rect.width <= 0 || duration <= 0 || cutBars.length === 0) return null;
          const t = ((clientX - rect.left) / rect.width) * duration;
          let best = cutBars[0];
          for (const b of cutBars) if (Math.abs(b - t) < Math.abs(best - t)) best = b;
          return best;
        };
        const span = region.end - region.start;
        const st = TIER_STYLE[level];
        return (
          <div
            key={`${level}-${region.start}-${head.itemId}`}
            // Square, not `rounded-sm`. A rounded chip is what every annotation
            // lane draws; a readout of them should not be shaped like one.
            className="group absolute overflow-hidden flex items-center"
            style={{
              left: `${left}%`,
              width: `${width}%`,
              top: tierIndex * TIER_H + 1,
              height: TIER_H - 2,
              // Its own dark ground, so a block still separates from the tier
              // wash behind it once the fill gets faint down at Backing.
              backgroundColor: 'rgba(2,6,23,0.55)',
              // Two items at the same level in the same stretch is legal and
              // worth seeing: on the lead tier it is usually a handover someone
              // forgot to finish, so it gets a hatch over the fill. Both go in
              // `backgroundImage` — the fill is itself a gradient now, and the
              // shorthand would drop it.
              backgroundImage: shared ? `${SHARED_HATCH}, ${st.fill}` : st.fill,
              boxShadow: `inset 0 0 0 1px ${st.ring}`,
            }}
            title={`${shared ? `Shared ${PROMINENCE_INFO[level].short.toLowerCase()}` : PROMINENCE_INFO[level].short}: ${names}\n${describeRange(region.start, region.end, gridProps, barLength)} · ${fmtTime(region.start)}–${fmtTime(region.end)}${onAssignLead ? `\nClick to hand the lead over these bars${cutBars.length ? '\nOr click the pale rail on top to split it at the marked bar' : ''}` : ''}`}
            onPointerMove={cutBars.length === 0 ? undefined : (e) => {
              // Tracked from anywhere on the block, so the marker is visible
              // before the pointer has found the rail.
              const best = nearestCutBar(e.clientX);
              if (best === null) return;
              if (!showCut || cut.t !== best) setCut({ key: cutKey, t: best, end: region.end, target: cutTarget });
            }}
            onPointerLeave={cutBars.length === 0 ? undefined : () => setCut(null)}
          >
            {/* The level line the column hangs off. Inset past the spine so the
              *  two cues stay legible as two: a colour tab that says WHO, and a
              *  rule whose brightness says HOW FAR FORWARD. */}
            <span
              className="absolute top-0 right-0 pointer-events-none"
              style={{ left: SPINE_W, height: RULE_H, background: st.rule }}
            />

            {/* The source layer's colour, and the only place it appears here.
              *  A tab down the edge reads as a reference to an item; the block
              *  wearing that colour outright read as the item itself. Two
              *  leaders split the tab between them, top and bottom. */}
            <span
              className="absolute left-0 top-0 bottom-0 pointer-events-none"
              style={{
                width: SPINE_W,
                background: shared
                  ? `linear-gradient(to bottom, ${head.color} 0 50%, ${region.leaders[1].color} 50% 100%)`
                  : head.color,
              }}
            />

            <span
              className="text-[9px] truncate leading-none pointer-events-none select-none"
              style={{
                color: st.text,
                paddingLeft: SPINE_W + 3,
                paddingRight: 4,
                paddingTop: RULE_H,
                textShadow: '0 0 4px rgba(0,0,0,0.95)',
              }}
            >
              {shared ? region.leaders.map((l) => l.label).join(' + ') : head.label}
            </span>

            {cutBars.length > 0 && (
              <>
                {/* The cut the pointer is currently over. Drawn only while the
                  *  strip is hovered, so a block at rest is just a block. */}
                {showCut && (
                  <>
                    <span
                      className="absolute top-0 bottom-0 w-px pointer-events-none bg-white"
                      style={{
                        left: `${(((cut.t - region.start) / span) * 100).toFixed(4)}%`,
                        boxShadow: '0 0 3px rgba(0,0,0,0.95)',
                      }}
                    />
                    <span
                      className="absolute top-0 w-[5px] h-[5px] -ml-[2px] rounded-full bg-white pointer-events-none"
                      style={{
                        left: `${(((cut.t - region.start) / span) * 100).toFixed(4)}%`,
                        boxShadow: '0 0 3px rgba(0,0,0,0.95)',
                      }}
                    />
                  </>
                )}

                {/* The strip itself. It does NOT stop the pointerdown: a press
                  *  that turns into a drag still paints a range, and only a
                  *  press-and-release splits. Below it the block's body is
                  *  untouched, so clicking the block still reselects it. */}
                {/* A visible rail, not an invisible hotzone. A block that can
                  *  be divided has to LOOK like it can — the affordance was
                  *  hover-only, and a control nobody can see is a control
                  *  nobody finds. */}
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={showCut
                    ? `Split ${head.label} at ${cutProse(cutPosAt(cut.t, gridProps) ?? { bar: 0, beat: 0 })}`
                    : `Split the lead in ${head.label}`}
                  // Starts below the level rule rather than on top of it — the
                  // rule is how far forward this stretch sits, and the rail
                  // must not paint over the one thing the tier is for.
                  className="absolute left-0 right-0 cursor-col-resize"
                  style={{
                    top: RULE_H,
                    height: CUT_STRIP_H,
                    background: showCut ? 'rgba(255,255,255,0.34)' : 'rgba(255,255,255,0.16)',
                    borderBottom: '1px solid rgba(0,0,0,0.35)',
                  }}
                  title={`Slide along this rail to place a cut on the nearest beat, then click to split.\nThe part before the cut keeps its current ${PROMINENCE_INFO[level].short.toLowerCase()}.`}
                  onPointerDown={(e) => {
                    const c = cutRef.current;
                    if (c && c.key === cutKey) {
                      tickHitRef.current = { t: c.t, end: c.end, target: c.target };
                      return;
                    }
                    // No hover got here first (a touch): take the beat under
                    // the press, and show it so the split can be seen.
                    const best = nearestCutBar(e.clientX);
                    if (best === null) return;
                    tickHitRef.current = { t: best, end: region.end, target: cutTarget };
                    setCut({ key: cutKey, t: best, end: region.end, target: cutTarget });
                  }}
                />
              </>
            )}
          </div>
        );
      }))}

      {dragPreview && duration > 0 && (
        <div
          className="absolute top-0 bottom-0 pointer-events-none z-20"
          style={{
            left: `${(Math.min(dragPreview.s, dragPreview.e) / duration) * 100}%`,
            width: `${(Math.abs(dragPreview.e - dragPreview.s) / duration) * 100}%`,
            minWidth: 1,
            background: 'rgba(45,212,191,0.16)',
            borderLeft: '2px solid rgba(45,212,191,0.8)',
            borderRight: '2px solid rgba(45,212,191,0.8)',
          }}
        />
      )}

      <div
        className="absolute top-0 bottom-0 w-px pointer-events-none z-10"
        style={{ left: `${pct}%`, background: 'rgba(255,255,255,0.75)' }}
      />

      {pending && (
        <>
          {/* Highlight of the range about to be assigned, so the snap result is
            *  visible before committing to it. */}
          {/* Two parts, because one click means two things. The EDGES span the
            *  row: the assignment covers this stretch of the track whatever
            *  tier it was taken from, and every tier is about to be rewritten
            *  inside it. The WASH covers only the block that was clicked, so
            *  picking the Counter line under a Lead block doesn't look like
            *  both were selected. A painted drag has no source block, so it
            *  washes the whole row. */}
          <div
            className="absolute top-0 bottom-0 pointer-events-none z-20"
            style={{
              left: `${(pending.t0 / duration) * 100}%`,
              width: `${((pending.t1 - pending.t0) / duration) * 100}%`,
              borderLeft: '2px solid #2dd4bf',
              borderRight: '2px solid #2dd4bf',
            }}
          />
          <div
            className="absolute pointer-events-none z-20 rounded-sm"
            style={{
              left: `${(pending.t0 / duration) * 100}%`,
              width: `${((pending.t1 - pending.t0) / duration) * 100}%`,
              top: pending.tier === null ? 0 : pending.tier * TIER_H,
              height: pending.tier === null ? LEAD_LANE_H : TIER_H,
              background: 'rgba(45,212,191,0.2)',
              boxShadow: pending.tier === null ? undefined : 'inset 0 0 0 1px rgba(45,212,191,0.9)',
            }}
          />
          <div
            className="fixed inset-0 z-40"
            // Pointerdown, because the lane under it starts its drag on
            // pointerdown — stopping only the mousedown would let a press on
            // the backdrop both dismiss the picker and start painting.
            onPointerDown={(e) => { e.stopPropagation(); setPending(null); }}
            onMouseDown={(e) => e.stopPropagation()}
          />
          <LeadPicker
            range={pending}
            items={pickList}
            gridProps={gridProps}
            target={onSetLevel ? pending.target : null}
            onPickLevel={commitLevel}
            split={splitCut}
            splitHint={splitHint}
            onSplit={(t) => setPending((cur) => cur && { ...cur, t0: t })}
            onPick={commit}
            onCancel={() => setPending(null)}
          />
        </>
      )}
    </div>
  );
}

function LeadPicker({
  range, items, gridProps, target, split, splitHint,
  onSplit, onPick, onPickLevel, onCancel,
}: {
  range: PendingRange;
  items: LeadCandidate[];
  gridProps?: LeadGridProps;
  /** Present ⇒ level mode: the range came off one item's own block, so the
   *  question is what THAT item does here, not who is in front. */
  target: PendingRange['target'];
  onPickLevel: (level: ProminenceLevel) => void;
  /** Playhead cut inside the range, or null when there is nowhere to cut. */
  split: { t: number; label: string } | null;
  /** Where a finer cut is made, or why this range has none. */
  splitHint: string | null;
  onSplit: (t: number) => void;
  onPick: (winnerItemId: string | null) => void;
  onCancel: () => void;
}) {
  const width = 280;

  // Escape has to be caught on the document. The panel is a plain div that
  // nothing ever focuses, so a keydown handler on it only fired if the pointer
  // happened to have put focus inside — which meant Escape usually did nothing
  // and the next click, swallowed by the dismiss overlay, was what closed it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // Keep the panel on screen; it opens from a click anywhere along the lane.
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, range.x - width / 2));
  const top = Math.min(window.innerHeight - 40, range.y + 6);
  const mid = (range.t0 + range.t1) / 2;
  const barLength = barLengthOf(gridProps);

  return (
    <div
      className="fixed z-50 rounded border border-white/10 bg-[#0a0b0d] shadow-2xl p-2"
      style={{ left, top, width, maxHeight: '46vh', overflowY: 'auto' }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="Assign the lead over this range"
    >
      <div className="text-[9px] uppercase tracking-wider text-slate-300 mb-0.5">
        {target ? `${target.label} over ` : 'Lead over '}
        {describeRange(range.t0, range.t1, gridProps, barLength)}
      </div>
      <div className="text-[9px] text-slate-500 mb-1.5 font-mono">
        {fmtTime(range.t0)}–{fmtTime(range.t1)}
      </div>

      {target ? (
        <div className="mb-1">
          <div className="text-[9px] text-slate-500 mb-1">
            what does <span className="text-slate-300">{target.label}</span> do here?
          </div>
          <div className="grid grid-cols-2 gap-1">
            {PROMINENCE_LEVELS.map((lv) => {
              const isCurrent = lv === target.level;
              return (
                <button
                  key={lv}
                  type="button"
                  onClick={() => onPickLevel(lv)}
                  className={`text-[10px] leading-none px-1.5 py-1.5 rounded border text-left hover:bg-white/[0.06] ${
                    isCurrent ? 'border-teal-400 text-teal-200' : 'border-white/10 text-slate-300'
                  }`}
                  title={`${PROMINENCE_INFO[lv].label} — ${PROMINENCE_INFO[lv].description}${
                    lv === 'lead' ? '\nAnyone else leading over this range drops to Counter.' : ''
                  }`}
                >
                  {PROMINENCE_INFO[lv].short}{isCurrent ? ' ·' : ''}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {!target && items.length === 0 && (
        <div className="text-[10px] text-slate-500 italic py-1">
          No annotations run through this range — add a span, loop, or riff instance here first.
        </div>
      )}

      {!target && items.map((item) => {
        const leadsHere = levelAtTrackTime(item, mid) === 'lead';
        // `item.label` already falls back to the layer's name for the many
        // items nobody labelled individually, so the second column repeats it
        // when it would otherwise be the same word twice. What distinguishes
        // two items off one layer is then which occurrence this is — the
        // "Instance 5" the label stepped over, or failing that, where it sits.
        const detail = item.label !== item.layerName
          ? item.layerName
          : item.placeholder ?? describeRange(item.start, item.end, gridProps, barLength);
        return (
          <button
            key={`${item.layerId}:${item.itemId}`}
            type="button"
            onClick={() => onPick(item.itemId)}
            className="w-full flex items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-white/[0.06]"
            title={`Hand the lead to "${item.label}" (${detail}) here.\nAnyone else leading over this range drops to Counter.`}
          >
            <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: item.color }} />
            <span className="text-[11px] text-slate-200 truncate flex-1">{item.label}</span>
            <span className="text-[8px] text-slate-500 truncate max-w-[96px]">{detail}</span>
            {leadsHere && <span className="text-[9px] text-emerald-400" title="Already leading here">●</span>}
          </button>
        );
      })}

      {/* Cutting the range shorter. One button, for the one cut that has a
        *  place on screen already — the playhead — and otherwise a line
        *  pointing at the block's own rail. A grid of beat numbers here read
        *  as a second pick-list rather than as a position in the song. */}
      {(split || splitHint) && (
        <div className="mt-1 pt-1.5 border-t border-white/[0.06]">
          {split && (
            <button
              type="button"
              onClick={() => onSplit(split.t)}
              className="w-full flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-[10px] text-teal-300 hover:bg-teal-400/10"
              title={`Cut the range at the playhead and assign only what comes after it. Everything before ${split.label} keeps its current lead.`}
            >
              <span aria-hidden>✂</span>
              <span>split at {split.label} (playhead)</span>
            </button>
          )}
          {splitHint && (
            <div className="text-[9px] text-slate-500 italic px-1.5 pt-0.5">
              <span aria-hidden>✂</span> {splitHint}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 mt-1.5 pt-1.5 border-t border-white/[0.06]">
        {!target && (
          <button
            type="button"
            onClick={() => onPick(null)}
            className="text-[10px] text-slate-400 hover:text-slate-200 underline decoration-dotted"
            title="Nobody leads over this range — whoever held the front drops to Counter and no one takes over."
          >
            no lead
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="ml-auto text-[10px] text-slate-400 hover:text-slate-200"
        >
          cancel
        </button>
      </div>
    </div>
  );
}
