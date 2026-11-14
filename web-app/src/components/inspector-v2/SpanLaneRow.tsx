/**
 * SpanLaneRow — overlapping interval bands for a Span layer.
 *
 * Unlike LoopLayerRow, Spans MAY overlap, so we run greedy lane assignment:
 * sort by start, place each span in the lowest lane that doesn't conflict.
 * The row grows taller with more overlap (N lanes × LANE_HEIGHT_PX), and when
 * the row is taller than that (a sideways lane title) the lanes share it.
 *
 * Clicking a band fires onSpanClick(itemId, anchor) so the parent can open
 * the inline edit popover (same pattern as Cues + Loops).
 */

import { useMemo, useRef } from 'react';
import { PULSE_RATE_INFO, prominenceSummary, type ProminenceEnvelope, type SpanItem } from '../../types/annotationLayer';
import { ProminenceFill, ProminenceStrip, prominenceBandBackground, PROMINENCE_EDIT_TOTAL_H } from './shared/ProminenceLane';
import { EnvelopeFill, envelopeSummary } from './shared/EnvelopeLane';
import { PulseTicks, labelNamesPulseRate, type PulseTicksProps } from './shared/PulseLane';
import { compactBandLabelPart } from '../../utils/bandLabel';
import { envelopeCoverageNote } from '../../utils/energySpan';
import { parseEnergySpanExport, type EnergySpanExport } from '../../utils/energySpan';
import { formatClockTime as fmtTime } from '../../utils/clockTime';
import { BeatGridOverlay, type LaneGridProps } from './BeatGridOverlay';
import { isOnGridLine } from '../../utils/snapIndication';
import { SnapTick } from './SnapIndicator';
import { useTimelineDrag, createEdgeItemClamp, useBodyMoveDrag } from '../../hooks/useTimelineDrag';
import { isSelectToggle, useCrossLaneDrop, type CrossLaneDropOptions } from '../../hooks/useCrossLaneDrop';
import { PendingHighlightOverlay, RegionDragOverlay, type PendingSelection } from './AnnotationOverlays';
import { ReviewControls, reviewBgFor, type ReviewStatus } from './ReviewControls';
import { MIN_BAND_PX, withBandStart } from './shared/bandGeometry';
import { BandEdgeHandle } from './shared/BandEdgeHandle';
import { usePlayheadValue } from '../../hooks/usePlayhead';
import { PlayheadLine } from '../Playhead';
import { SoundEnvelopeShape } from './shared/SoundEnvelopeShape';
import { envelopeTitle, loudestPeakDb } from '../../utils/soundEnvelopes';

const LANE_HEIGHT_PX = 15;
const LANE_GAP_PX = 1;

interface SpanLaneRowProps {
  items: SpanItem[];
  color: string;
  duration: number;
  /** When true, spans under the playhead are highlighted (the lane's Visualize switch). */
  visualize?: boolean;
  focusedItemId?: string | null;
  /** Item whose edit popover is currently OPEN. Distinct from `focusedItemId`,
   *  which lingers after the popover closes to keep the editor-panel card
   *  highlighted — the prominence editor must not linger with it, or the row
   *  stays permanently taller. */
  prominenceEditItemId?: string | null;
  onSpanClick?: (itemId: string, anchor: { x: number; y: number }) => void;
  /** Edge-drag callback. Same contract as LoopLayerRow: id, which edge, new time. */
  onSpanEdgeDrag?: (itemId: string, edge: 'start' | 'end', time: number) => void;
  onSpanEdgeDragStart?: (itemId: string, edge: 'start' | 'end') => void;
  /** Body-drag callback. Fires while the user drags the middle of a band to
   *  reposition the span without changing its width (start and end shift by
   *  the same delta). */
  onSpanMove?: (itemId: string, newStart: number, newEnd: number) => void;
  onSpanMoveStart?: (itemId: string) => void;
  /** Prominence (front/back) edits from the band-drag editor. When absent the
   *  envelope still renders inside the band, it just can't be edited here. */
  onProminenceChange?: (itemId: string, points: ProminenceEnvelope | undefined) => void;
  /** Snap a prominence breakpoint onto the beat grid as it's dragged or
   *  placed. The page's own snap, so Snap to grid / Grid Lock govern it the
   *  same way they govern moving the band itself. */
  snapProminenceTime?: (trackSeconds: number) => number;
  gridProps?: LaneGridProps;
  /** The song's tempo for pulse ticks, present even while the grid overlay is
   *  hidden. Falls back to `gridProps`. */
  pulseGrid?: PulseTicksProps['grid'];
  pendingSelection?: PendingSelection | null;
  /** Empty-space click → seek; empty-space drag → create a pending highlight. */
  onSeek?: (time: number) => void;
  onRegion?: (t1: number, t2: number) => void;
  onRegionDragStart?: () => void;
  /** Editable lane: a drag over empty space makes a span over the dragged
   *  stretch, in this lane (see laneCreate.ts), instead of the teal
   *  highlight. Absent on detector lanes. */
  onCreate?: (t1: number, t2: number) => void;
  /** The snap `onCreate` applies, so the drag preview lands where the item will. */
  createSnap?: (t: number) => number;
  /** Drag an item onto another lane of the same type to move it there — see
   *  useCrossLaneDrop. Absent on read-only lanes and wherever items can't move. */
  laneDrop?: CrossLaneDropOptions;
  /** Detector-review mode. When set, spans become read-only and render inline ✓/✗. */
  reviewState?: Record<string, ReviewStatus>;
  onAccept?: (itemId: string) => void;
  onReject?: (itemId: string) => void;
}

interface PlacedSpan {
  item: SpanItem;
  lane: number;
}

function assignLanes(items: SpanItem[]): { placed: PlacedSpan[]; laneCount: number } {
  const sorted = items.slice().sort((a, b) => a.start - b.start);
  const laneEnds: number[] = []; // running end-time of the last span in each lane
  const placed: PlacedSpan[] = [];
  for (const item of sorted) {
    let lane = laneEnds.findIndex((end) => end <= item.start);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(item.end); }
    else laneEnds[lane] = item.end;
    placed.push({ item, lane });
  }
  return { placed, laneCount: Math.max(1, laneEnds.length) };
}

export function SpanLaneRow({
  items, color, duration,
  visualize,
  focusedItemId, prominenceEditItemId, onSpanClick,
  onSpanEdgeDrag, onSpanEdgeDragStart,
  onSpanMove, onSpanMoveStart,
  onProminenceChange,
  snapProminenceTime,
  gridProps,
  pulseGrid,
  pendingSelection,
  onSeek, onRegion, onRegionDragStart, onCreate, createSnap,
  reviewState, onAccept, onReject,
  laneDrop,
}: SpanLaneRowProps) {
  const reviewMode = !!reviewState;
  const containerRef = useRef<HTMLDivElement>(null);
  const { placed, laneCount } = useMemo(() => assignLanes(items), [items]);

  // Visualize: all spans whose [start, end) contains the playhead (spans may
  // overlap). Selected as one string key — a primitive, so the row re-renders
  // only when the set of sounding spans changes, not on every frame.
  const activeKey = usePlayheadValue((t) => {
    if (!visualize) return null;
    let key = '';
    for (const { item } of placed) {
      if (item.start <= t && t < item.end) key += `${item.id}\n`;
    }
    return key;
  });
  const activeIds = useMemo(
    () => (activeKey === null ? null : new Set(activeKey.split('\n').filter(Boolean))),
    [activeKey],
  );
  const lanesHeight = Math.max(26, laneCount * LANE_HEIGHT_PX + (laneCount - 1) * LANE_GAP_PX);

  // A span whose description is an ⚡ Energy export is a measurement, not an
  // authored annotation: it draws its measured A/D/S/R envelope instead of a
  // prominence arc, and has no prominence editor at all (see EnvelopeLane).
  // Keyed off the export itself rather than the lane's name, because the
  // ⚡ popover can save into any span lane, and "energies" is only its default.
  const energyById = useMemo(() => {
    const map = new Map<string, EnergySpanExport>();
    for (const { item } of placed) {
      const data = parseEnergySpanExport(item.description);
      if (data) map.set(item.id, data);
    }
    return map;
  }, [placed]);
  // Extract ADSR's envelopes, scaled against the lane's loudest so a quiet
  // sound reads quieter than its neighbour, as on a lyrics lane.
  const loudestDb = useMemo(() => loudestPeakDb(items.map((it) => it.envelope)), [items]);
  // The prominence editor only claims vertical space while an item is focused
  // — the 12px band is unusable for grabbing handles, but permanently taxing
  // every span row 44px for a feature most rows don't use isn't worth it.
  const prominenceTarget = useMemo(
    () => (onProminenceChange && !reviewMode && prominenceEditItemId
      ? placed.find(({ item }) => item.id === prominenceEditItemId)?.item ?? null
      : null),
    [onProminenceChange, reviewMode, prominenceEditItemId, placed],
  );
  const height = lanesHeight + (prominenceTarget ? PROMINENCE_EDIT_TOTAL_H + 2 : 0);
  // Bands fill the row edge to edge, as loops and sections do — no inset
  // above the first track or below the last. The only gap is the 1px between
  // stacked tracks, so two overlapping bands of one colour stay two.
  const trackH = `((100% - ${(laneCount - 1) * LANE_GAP_PX}px) / ${Math.max(1, laneCount)})`;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const durationRef = useRef(duration);
  durationRef.current = duration;

  const { startDrag } = useTimelineDrag<{ id: string; edge: 'start' | 'end' }>({
    containerRef,
    duration,
    onDragStart: ({ id, edge }) => onSpanEdgeDragStart?.(id, edge),
    onDrag: ({ id, edge }, t) => onSpanEdgeDrag?.(id, edge, t),
    clamp: createEdgeItemClamp(itemsRef, duration),
  });
  const dragEnabled = !!onSpanEdgeDrag && !reviewMode;

  // Body-drag (move whole span). Click vs drag is disambiguated by a 3 px
  // movement threshold inside the helper — taps still open the popover.
  const { startBodyMove, wasDraggedRef } = useBodyMoveDrag({
    containerRef,
    durationGetter: () => durationRef.current,
    onMoveStart: (id) => onSpanMoveStart?.(id),
    onMove: (id, ns, ne) => onSpanMove?.(id, ns, ne),
  });
  const { beginLaneDrop } = useCrossLaneDrop(laneDrop);
  const moveEnabled = !!onSpanMove && !reviewMode;

  return (
    <div
      ref={containerRef}
      className="flex-1 relative rounded overflow-hidden bg-gray-950"
      // A floor, not a height: the row stretches to its tallest cell — a
      // sideways lane title is often taller than the bands need — and the
      // bands grow to fill it rather than leaving an empty strip under them.
      style={{ minHeight: height }}
      title={items.length === 0 && !onCreate ? 'No spans yet — add one from the Spans editor' : undefined}
    >
      {gridProps && (
        <BeatGridOverlay {...gridProps} duration={duration} />
      )}

      {items.length === 0 && (
        <span className="absolute inset-0 flex items-center px-2 text-[10px] text-gray-700 italic select-none pointer-events-none">
          {onCreate ? 'no spans yet — drag here to add one' : 'no spans yet'}
        </span>
      )}

      {/* Behind the bands (z="") — bands keep their own mousedowns; empty space
          falls through to seek / highlight-drag. */}
      {onSeek && onRegion && (
        <RegionDragOverlay duration={duration} onVizClick={onSeek} onVizRegion={onCreate ?? onRegion} onRegionDragStart={onCreate ? undefined : onRegionDragStart} onSelectRegion={laneDrop?.onSelectRange}
          createColor={onCreate ? color : undefined} snapTime={onCreate ? createSnap : undefined} hint={onCreate ? 'Drag to add a span · click to move the playhead · ⇧-drag to select the spans inside' : undefined} z="" />
      )}

      {placed.map(({ item, lane }) => {
        const left  = duration > 0 ? (item.start / duration) * 100 : 0;
        const width = duration > 0 ? ((item.end - item.start) / duration) * 100 : 0;
        const isFocused = item.id === focusedItemId;
        const isActive = activeIds?.has(item.id) ?? false;
        // While the prominence editor holds the bottom of the row the bands
        // keep their fixed tracks above it; otherwise each track takes an
        // equal share of whatever height the row was given.
        const top: number | string = prominenceTarget
          ? lane * (LANE_HEIGHT_PX + LANE_GAP_PX)
          : `calc(${lane} * (${trackH} + ${LANE_GAP_PX}px))`;
        const startSnapped = isOnGridLine(item.start, gridProps?.bpm, gridProps?.gridOffset, gridProps?.beatsPerBar);
        const endSnapped   = isOnGridLine(item.end,   gridProps?.bpm, gridProps?.gridOffset, gridProps?.beatsPerBar);
        const status = reviewState?.[item.id];
        // A span can carry its own colour (set in its card) over the layer's.
        const ownColor = item.color ?? color;
        const bandColor = reviewMode ? reviewBgFor(ownColor, status) : ownColor;
        const energy = energyById.get(item.id) ?? null;
        // Set once the band has been dragged off what was measured — the curve
        // below is cut to the overlap, and the tooltip has to say so or the
        // shortened picture reads as a shorter gesture.
        const coverage = energy ? envelopeCoverageNote(energy, item.start, item.end) : null;
        // An energy span's description is the export blob itself — hundreds of
        // lines of JSON in a tooltip. The blob carries its own one-paragraph
        // summary, which is the part a hover can actually use.
        const hoverDescription = energy ? energy.description : item.description;
        return (
          <div key={item.id} className="contents">
            <button
              data-item-id={item.id}
              onPointerDown={(e) => {
                if (!moveEnabled) return;
                // A ⇧/⌘ press is a selection click, never a drag.
                if (laneDrop && isSelectToggle(e)) return;
                if (beginLaneDrop(item.id, e)) return;
                startBodyMove(item.id, item.start, item.end, e);
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (laneDrop && isSelectToggle(e)) { laneDrop.onToggleSelect(item.id); return; }
                if (wasDraggedRef.current) {
                  wasDraggedRef.current = false;
                  return;
                }
                // Opens the info card in every mode — read-only for detector
                // layers (review mode); ✓/✗ controls stop propagation.
                onSpanClick?.(item.id, { x: e.clientX, y: e.clientY });
              }}
              // touch-pan-y: a vertical swipe over a band still scrolls the
              // page on a phone; a horizontal one moves the band.
              className={`@container absolute flex items-stretch overflow-hidden ${moveEnabled ? 'touch-pan-y' : ''} ${
                reviewMode ? 'cursor-pointer' : (moveEnabled ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer')
              }`}
              style={{
                left: `${left}%`,
                width: `${width}%`,
                minWidth: MIN_BAND_PX,
                top,
                height: prominenceTarget ? LANE_HEIGHT_PX : `calc${trackH}`,
                // The dimmed background is for any band drawing a shape
                // inside itself — prominence arc or energy contour; a flat
                // wash behind either one washes it out.
                background: status ? `${bandColor}ee`
                  : (item.prominence || item.envelope || energy) ? prominenceBandBackground(bandColor, isActive)
                  : isActive ? `${bandColor}77` : `${bandColor}55`,
                boxShadow: withBandStart(bandColor, isActive
                  ? `inset 0 0 0 2px ${bandColor}cc, 0 0 10px ${bandColor}88`
                  : isFocused ? `inset 0 0 0 1px ${bandColor}, 0 0 6px ${bandColor}66` : undefined),
                // Selected for a cross-lane drag (⇧/⌘-click).
                outline: laneDrop?.selectedIds.has(item.id) ? '2px solid #ffffff' : undefined,
                outlineOffset: -2,
                opacity: 1,
              }}
              title={reviewMode
                ? `${item.label || '(unlabeled)'} · ${fmtTime(item.start)}–${fmtTime(item.end)}${status ? ` · ${status}` : ' · pending review'}${hoverDescription ? '\n' + hoverDescription : ''}`
                : `${item.label || '(unlabeled)'} · ${fmtTime(item.start)}–${fmtTime(item.end)}${startSnapped && endSnapped ? ' · both ends snapped' : startSnapped ? ' · start snapped' : endSnapped ? ' · end snapped' : ''}${energy ? ` · ${envelopeSummary(energy)}${coverage ? ` · ${coverage}` : ''}` : prominenceSummary(item.prominence) ? ` · ${prominenceSummary(item.prominence)}` : ''}${item.envelope ? envelopeTitle(item.envelope) : ''}${item.pulse && !energy ? ` · pulse ${PULSE_RATE_INFO[item.pulse].badge}` : ''}${hoverDescription ? '\n' + hoverDescription : ''}`}
            >
              {item.envelope && !energy && (
                <SoundEnvelopeShape
                  shapes={[{ id: item.id, envelope: item.envelope }]}
                  from={item.start}
                  to={item.end}
                  loudestDb={loudestDb}
                />
              )}
              {energy
                ? <EnvelopeFill data={energy} color={bandColor} start={item.start} end={item.end} />
                : <ProminenceFill points={item.prominence} itemDuration={item.end - item.start} color={bandColor} />}
              {/* Over the fill rather than under it: the ticks are the thing
                * being annotated here, and a prominence arc would swallow the
                * thin ones. Never on an ⚡ Energy span — the card doesn't offer
                * a pulse there (see SpanEditPopover), so drawing one a stray
                * older file happens to carry would show a rate nothing in the
                * UI can explain or edit. */}
              {!energy && (
                <PulseTicks rate={item.pulse} start={item.start} end={item.end} color={bandColor} grid={pulseGrid ?? gridProps} labelNamesRate={labelNamesPulseRate(item.label, item.pulse)} blink={visualize} />
              )}
              {startSnapped && !reviewMode && <SnapTick style={{ top: 0, left: 0 }} title="Span start is on the beat grid" />}
              {endSnapped   && !reviewMode && <SnapTick style={{ top: 0, right: 0 }} title="Span end is on the beat grid" />}
              {/* An energy span draws its curve here instead of its label:
                * every one of them is called "Energy: <trends> (<stem>)", so on
                * a 15px band the text covered the only part that differed. The
                * label is still on the card, in the list below the timeline,
                * and in this band's tooltip. */}
              {!energy && <BandLabel text={item.label || `${(item.end - item.start).toFixed(1)}s`} />}
              {dragEnabled && (
                <>
                  <BandEdgeHandle
                    edge="start" widthClass="w-1.5" label="Drag to move span start"
                    onPointerDown={(e) => startDrag({ id: item.id, edge: 'start' }, e)}
                  />
                  <BandEdgeHandle
                    edge="end" widthClass="w-1.5" label="Drag to move span end"
                    onPointerDown={(e) => startDrag({ id: item.id, edge: 'end' }, e)}
                  />
                </>
              )}
            </button>
            {reviewMode && (
              <ReviewControls
                status={status}
                onAccept={() => onAccept?.(item.id)}
                onReject={() => onReject?.(item.id)}
                size={11}
                style={{ position: 'absolute', top: typeof top === 'number' ? Math.max(0, top - 1) : top, left: `${left + width / 2}%`, transform: 'translateX(-50%)', zIndex: 15 }}
              />
            )}
          </div>
        );
      })}

      {prominenceTarget && onProminenceChange && (
        <ProminenceStrip
          points={prominenceTarget.prominence}
          start={prominenceTarget.start}
          end={prominenceTarget.end}
          duration={duration}
          containerRef={containerRef}
          color={color}
          top={lanesHeight}
          snapTime={snapProminenceTime}
          onChange={(next) => onProminenceChange(prominenceTarget.id, next)}
          onDragStart={() => onSpanMoveStart?.(prominenceTarget.id)}
        />
      )}

      <PlayheadLine
        duration={duration}
        className="absolute top-0 bottom-0 w-px pointer-events-none z-10"
        style={{ background: 'rgba(255,255,255,0.75)' }}
      />
      {pendingSelection && (
        <PendingHighlightOverlay sel={pendingSelection} duration={duration} grid={gridProps} />
      )}
    </div>
  );
}

/** A band's label, split at its " · " parts ("Kick · Beat · 24 bars"). The
 *  parts wrap as whole words rather than the line truncating, and a narrow
 *  band (a container query on the band, so it follows zoom with no measuring)
 *  — under 90 px, about what "Kick Beat 24 bars" needs at full size —
 *  swaps each part for its short form and scales the text down to 7 px: a
 *  one-bar band zoomed out had room for "Ki… Be…", which hid both things the
 *  label is for — what plays, and at what rate. Now it reads "Kick" over "1b".
 *  The full label stays in the band's tooltip. The first part is the subject —
 *  the instrument, for a detector's span — so it is the one set in bold;
 *  weight tells the parts apart, not a "·", which would open a wrapped line
 *  and cost the narrowest bands their room. */
function BandLabel({ text }: { text: string }) {
  const parts = text.split(' · ').filter(Boolean);
  return (
    <span
      className="flex-1 min-w-0 flex flex-wrap items-center gap-x-[0.5em] overflow-hidden px-0.5 leading-[1.1] text-white pointer-events-none select-none"
      style={{
        // Full 10 px on a roomy band; below that, as large as three
        // characters across the band allow, never under 7 px.
        fontSize: 'clamp(7px, calc((100cqw - 4px) / 3), 10px)',
        // `safe`: centred while the lines fit, top-aligned once they don't — a
        // plain centre clips the overflow off both ends, and the top line is
        // the instrument.
        alignContent: 'safe center',
        textShadow: '0 0 3px rgba(0,0,0,1), 0 0 6px rgba(0,0,0,0.9)',
      }}
    >
      {parts.map((part, i) => {
        const short = compactBandLabelPart(part);
        return (
          <span key={i} className={`truncate max-w-full ${i === 0 ? 'font-semibold' : 'text-white/85'}`}>
            {short === part ? part : (
              <>
                <span className="@max-[90px]:hidden">{part}</span>
                <span className="hidden @max-[90px]:inline">{short}</span>
              </>
            )}
          </span>
        );
      })}
    </span>
  );
}
