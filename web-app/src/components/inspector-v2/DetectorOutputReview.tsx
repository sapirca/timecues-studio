/**
 * Read-only review of a custom detector's output for one annotation type
 * (cues / spans / loops / patterns / boundaries). Each row summarises the
 * item; clicking it opens the shared AnnotationPointCard in read-only mode,
 * with Accept ✓ / Reject ✗ buttons as footer extras and a Play preview
 * affordance.
 *
 * State model — copy-on-write per annotator:
 *   - The detector's `CustomResultEnvelope` (algorithm cache) drives the
 *     items list; never edited.
 *   - The first ✓/✗ click in this component creates an `EditableDetectorOutput`
 *     by deep-copying the envelope and stamping a `review` map. That file
 *     lives at data/annotations/detector-outputs/<detector>/<annotator>/<slug>.json.
 *   - All subsequent edits patch the in-memory editable doc and persist it.
 *   - Re-running the detector while this file exists triggers a 409 + user
 *     confirmation; see runDetectorWithConflictCheck.
 *
 * The component is intentionally render-only for the underlying envelope:
 * parents own the `EditableDetectorOutput` state and pass it down. This
 * keeps the copy-on-write logic in one place (InspectorPageV2's detector-
 * output state) rather than scattered across panels.
 */

import { useMemo } from 'react';
import type {
  CustomBoundaryItem,
  CustomCueItem,
  CustomSpanItem,
  CustomLoopItem,
  CustomPatternItem,
} from '../../types/customScript';
import type { TempoAnchor } from '../../types/songInfo';
import { AnnotationPointCard, type AnnotationCardKind } from './shared/AnnotationPointCard';
import { useAnnotationPopover } from './shared/useAnnotationPopover';
import {
  newId,
  type CueItem,
  type SpanItem,
  type LoopItem,
  type PatternItem,
} from '../../types/annotationLayer';

export type DetectorReviewStatus = 'accepted' | 'rejected';

type ReviewableCategory = 'cues' | 'spans' | 'loops' | 'patterns' | 'boundaries';

interface Props {
  detectorName: string;
  detectorLabel: string;
  category: ReviewableCategory;
  /** Items from the detector envelope. Shape depends on `category`. */
  items: (CustomBoundaryItem | CustomCueItem | CustomSpanItem | CustomLoopItem | CustomPatternItem)[];
  /** Map keyed by item-id (`${index}:${primaryTimeField}`) → decision. */
  reviewState: Record<string, DetectorReviewStatus>;
  onAccept: (itemId: string) => void;
  onReject: (itemId: string) => void;
  /** Wipe the editable copy and revert to the read-only algorithm cache. */
  onResetReview?: () => void;
  /** Copy this detector's items into a brand-new MANUAL annotation layer
   *  (`source: 'user'`, `importedFrom: detectorName`). The parent appends
   *  it to the song's AnnotationLayersDocument and persists. Omitted for
   *  boundaries (which don't have a manual-layer equivalent yet). */
  onCopyToManualLayer?: (params: {
    type: 'cues' | 'spans' | 'loops' | 'patterns';
    items: CueItem[] | SpanItem[] | LoopItem[] | PatternItem[];
    layerName: string;
    importedFrom: string;
  }) => void;
  /** Audio wiring for the play button on the popover card. When omitted the
   *  card hides the play button. */
  onSeekAndPlay?: (time: number, stopTime?: number) => void;
  onPause?: () => void;
  playerIsPlaying?: boolean;
  /** Current playhead — used to detect "is this item currently playing?". */
  playerTime?: number;
  /** Beat-grid context — drives the bar.beat read-out next to the seconds
   *  field on the read-only review card. Detector cards never edit; this is
   *  view-only context. */
  bpm?: number;
  gridOffset?: number;
  beatsPerBar?: number;
  anchors?: readonly TempoAnchor[];
}

/** Stable per-item id, identical to the seed used when the editable doc is
 *  first written. Re-running the detector reorders items, so item-index is
 *  not durable on its own — pairing it with the primary time field keeps
 *  the review state aligned through small re-runs. */
function itemKey(
  category: ReviewableCategory,
  index: number,
  item: CustomCueItem | CustomSpanItem | CustomLoopItem | CustomPatternItem | CustomBoundaryItem,
): string {
  if (category === 'cues') {
    return `${index}:${(item as CustomCueItem).time_ms}`;
  }
  if (category === 'boundaries') {
    return `${index}:${(item as CustomBoundaryItem).time_ms}`;
  }
  // spans / loops / patterns all keyed by start_ms
  const start = (item as CustomSpanItem | CustomLoopItem | CustomPatternItem).start_ms;
  return `${index}:${start}`;
}

/** Map review category → card kind. */
const KIND_FROM_CATEGORY: Record<ReviewableCategory, AnnotationCardKind> = {
  cues: 'cue', spans: 'span', loops: 'loop', patterns: 'pattern', boundaries: 'boundary',
};

/** Neutral palette for detector-sourced cards (no layer to inherit from). */
const DETECTOR_LAYER_COLOR = '#94a3b8'; // slate-400

export function DetectorOutputReview({
  detectorName,
  detectorLabel,
  category,
  items,
  reviewState,
  onAccept,
  onReject,
  onResetReview,
  onCopyToManualLayer,
  onSeekAndPlay,
  onPause,
  playerIsPlaying = false,
  playerTime = 0,
  bpm,
  gridOffset,
  beatsPerBar,
  anchors,
}: Props) {
  const popover = useAnnotationPopover({ width: 360, height: 380 });

  const counts = useMemo(() => {
    let accepted = 0, rejected = 0;
    for (const v of Object.values(reviewState)) {
      if (v === 'accepted') accepted++;
      else if (v === 'rejected') rejected++;
    }
    return { accepted, rejected, pending: items.length - accepted - rejected };
  }, [reviewState, items.length]);

  // Mapping from review category → user-layer type. Boundaries have no
  // manual-layer equivalent (they live in ManualAnnotation, not the layers
  // doc), so the Copy buttons are hidden in that case.
  const manualLayerType: 'cues' | 'spans' | 'loops' | 'patterns' | null =
    category === 'cues' ? 'cues'
    : category === 'spans' ? 'spans'
    : category === 'loops' ? 'loops'
    : category === 'patterns' ? 'patterns'
    : null;

  const canCopy = !!onCopyToManualLayer && manualLayerType !== null && items.length > 0;

  const handleCopy = (mode: 'accepted' | 'all') => {
    if (!onCopyToManualLayer || !manualLayerType) return;
    // Filter: 'accepted' = only ✓; 'all' = everything except explicit ✗.
    // Pending items count as kept under 'all' so a single click can pull the
    // raw detector output into an editable manual layer.
    const keep: typeof items = items.filter((it, i) => {
      const status = reviewState[itemKey(category, i, it)];
      if (mode === 'accepted') return status === 'accepted';
      return status !== 'rejected';
    });
    if (keep.length === 0) return;
    const converted = convertDetectorItems(category, keep);
    if (!converted) return;
    const suffix = mode === 'accepted' ? ` (✓ accepted)` : '';
    onCopyToManualLayer({
      type: manualLayerType,
      items: converted as CueItem[] | SpanItem[] | LoopItem[] | PatternItem[],
      layerName: `${detectorLabel}${suffix}`,
      importedFrom: detectorName,
    });
  };

  if (!items.length) {
    return (
      <div className="p-4 rounded border border-white/[0.06] bg-white/[0.02] text-[12px] text-slate-400">
        <span className="font-medium text-slate-300">{detectorLabel}</span> didn't emit any {category}.
        Run it first from the Detectors panel, or pick another source.
      </div>
    );
  }

  // Resolved open item — for the popover render. We use the item index from
  // the open state's itemId since the list is stable for the lifetime of the
  // popover (the envelope doesn't mutate under us).
  const openItem = (() => {
    if (!popover.open) return null;
    const [idxStr] = popover.open.itemId.split(':');
    const idx = Number(idxStr);
    if (!Number.isFinite(idx) || idx < 0 || idx >= items.length) return null;
    return { idx, item: items[idx] };
  })();

  return (
    <div className="rounded border border-white/[0.06] bg-white/[0.02]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.06]">
        <div className="text-[11px] text-slate-400">
          <span className="text-slate-200 font-medium">{detectorLabel}</span>
          <span className="ml-2 text-slate-500">·</span>
          <span className="ml-2">{items.length} item{items.length === 1 ? '' : 's'}</span>
          {counts.accepted > 0 && (
            <span className="ml-2 text-emerald-400">{counts.accepted} accepted</span>
          )}
          {counts.rejected > 0 && (
            <span className="ml-2 text-rose-400">{counts.rejected} rejected</span>
          )}
          {counts.pending > 0 && counts.pending !== items.length && (
            <span className="ml-2 text-slate-500">{counts.pending} pending</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {canCopy && (
            <span className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-slate-500">
              Copy to manual layer:
              <button
                type="button"
                disabled={counts.accepted === 0}
                onClick={() => handleCopy('accepted')}
                className="px-1.5 py-0.5 rounded border border-emerald-400/30 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40 disabled:hover:bg-transparent"
                title={counts.accepted === 0
                  ? 'Accept at least one item with ✓ before copying'
                  : `Create a new manual layer containing the ${counts.accepted} accepted item${counts.accepted === 1 ? '' : 's'}`}
              >
                ✓ accepted
              </button>
              <button
                type="button"
                onClick={() => handleCopy('all')}
                className="px-1.5 py-0.5 rounded border border-white/[0.12] text-slate-300 hover:bg-white/[0.04]"
                title={counts.rejected > 0
                  ? `Create a new manual layer containing every item except the ${counts.rejected} explicitly rejected`
                  : `Create a new manual layer containing all ${items.length} items`}
              >
                all
              </button>
            </span>
          )}
          {onResetReview && (counts.accepted + counts.rejected > 0) && (
            <button
              type="button"
              onClick={onResetReview}
              className="text-[10px] uppercase tracking-wider text-slate-500 hover:text-slate-300"
              title="Discard all accept/reject decisions and remove the editable file"
            >
              Reset review
            </button>
          )}
        </div>
      </div>
      <ul className="divide-y divide-white/[0.04]">
        {items.map((item, i) => {
          const id = itemKey(category, i, item);
          const status = reviewState[id];
          return (
            <li
              key={id}
              className={`flex items-center justify-between gap-3 px-3 py-1.5 text-[11px] cursor-pointer hover:bg-white/[0.03] ${
                status === 'accepted'
                  ? 'bg-emerald-500/[0.12]'
                  : status === 'rejected'
                    ? 'bg-rose-500/[0.12] opacity-60'
                    : ''
              }`}
              onClick={(e) => popover.openAt('detector', id, { x: e.clientX, y: e.clientY })}
              title="Click to open the edit/preview card"
            >
              <span className="flex-1 truncate text-slate-300">{summarizeItem(category, item)}</span>
              <span className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                <ReviewChip
                  active={status === 'accepted'}
                  tone="accept"
                  title="Accept"
                  onClick={() => onAccept(id)}
                >✓</ReviewChip>
                <ReviewChip
                  active={status === 'rejected'}
                  tone="reject"
                  title="Reject"
                  onClick={() => onReject(id)}
                >✗</ReviewChip>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="px-3 py-2 border-t border-white/[0.06] text-[10px] text-slate-500">
        Edits live at <code className="text-slate-400">data/annotations/detector-outputs/{detectorName}/&lt;you&gt;/&lt;slug&gt;.json</code>.
        Re-running this detector will warn before overwriting.
      </div>

      {/* Read-only preview card — same component used by user-editable layers. */}
      {popover.open && openItem && (() => {
        const kind = KIND_FROM_CATEGORY[category];
        const id = popover.open!.itemId;
        const status = reviewState[id];
        const { start, end, regionEnd, label, description } = detectorItemView(category, openItem.item);
        const stopTime = end ?? start + 0.5;
        const itemIsPlaying = playerIsPlaying && playerTime >= start && playerTime < stopTime;
        return (
          <AnnotationPointCard
            kind={kind}
            layerName={detectorLabel}
            layerColor={DETECTOR_LAYER_COLOR}
            badge="detector"
            start={start}
            end={end}
            endEditable={false}
            regionEnd={regionEnd}
            label={label}
            description={description}
            bpm={bpm}
            gridOffset={gridOffset}
            beatsPerBar={beatsPerBar}
            anchors={anchors}
            readOnly
            hideImportance
            hideDelete
            width={360}
            onChange={() => { /* read-only — inputs are disabled */ }}
            onPlay={onSeekAndPlay ? () => onSeekAndPlay(start, stopTime) : undefined}
            onStop={onPause}
            isPlaying={itemIsPlaying}
            onClose={popover.close}
            popoverRef={popover.popoverRef}
            positionStyle={popover.positionStyle}
            footerExtras={
              <>
                <ReviewChip
                  active={status === 'accepted'}
                  tone="accept"
                  title="Accept"
                  onClick={() => onAccept(id)}
                >✓</ReviewChip>
                <ReviewChip
                  active={status === 'rejected'}
                  tone="reject"
                  title="Reject"
                  onClick={() => onReject(id)}
                >✗</ReviewChip>
              </>
            }
          />
        );
      })()}
    </div>
  );
}

interface DetectorItemView {
  start: number;       // seconds
  end?: number;        // seconds — absent for cues/boundaries
  regionEnd?: number;  // seconds — patterns only (start + repeats × cycle)
  label: string;
  description: string;
}

/** Normalise a detector item to the shape AnnotationPointCard consumes. */
function detectorItemView(
  category: ReviewableCategory,
  item: CustomBoundaryItem | CustomCueItem | CustomSpanItem | CustomLoopItem | CustomPatternItem,
): DetectorItemView {
  if (category === 'cues') {
    const c = item as CustomCueItem;
    return {
      start: c.time_ms / 1000,
      label: c.label ?? '',
      description: c.description ?? '',
    };
  }
  if (category === 'boundaries') {
    const b = item as CustomBoundaryItem;
    return {
      start: b.time_ms / 1000,
      label: b.label ?? '',
      description: '',
    };
  }
  if (category === 'spans') {
    const s = item as CustomSpanItem;
    return {
      start: s.start_ms / 1000,
      end: (s.start_ms + s.duration_ms) / 1000,
      label: s.label ?? '',
      description: '',
    };
  }
  if (category === 'loops') {
    const l = item as CustomLoopItem;
    return {
      start: l.start_ms / 1000,
      end: (l.start_ms + l.duration_ms) / 1000,
      label: l.label ?? '',
      description: '',
    };
  }
  // patterns
  const p = item as CustomPatternItem;
  const start = p.start_ms / 1000;
  const cycle = p.duration_ms / 1000;
  return {
    start,
    end: start + cycle,
    regionEnd: start + Math.max(1, p.repeat_count) * cycle,
    label: p.label ?? '',
    description: '',
  };
}

/** Convert a slice of detector items into the matching user-layer item shape.
 *  Returns null for the 'boundaries' category (no manual-layer equivalent).
 *  All time fields are converted from ms (custom envelope) to seconds (layer
 *  doc). Per-item ids are minted fresh — the layer-doc id space is uuid, and
 *  the detector envelope's index-based keys would collide on a second copy. */
function convertDetectorItems(
  category: ReviewableCategory,
  items: (CustomBoundaryItem | CustomCueItem | CustomSpanItem | CustomLoopItem | CustomPatternItem)[],
): CueItem[] | SpanItem[] | LoopItem[] | PatternItem[] | null {
  if (category === 'cues') {
    return (items as CustomCueItem[]).map<CueItem>((c) => ({
      id: newId(),
      time: c.time_ms / 1000,
      label: c.label ?? '',
      description: c.description ?? undefined,
      candidates: c.candidates && c.candidates.length > 0
        ? c.candidates.map((ms) => ms / 1000)
        : undefined,
    }));
  }
  if (category === 'spans') {
    return (items as CustomSpanItem[]).map<SpanItem>((s) => ({
      id: newId(),
      start: s.start_ms / 1000,
      end: (s.start_ms + s.duration_ms) / 1000,
      label: s.label ?? '',
    }));
  }
  if (category === 'loops') {
    return (items as CustomLoopItem[]).map<LoopItem>((l) => ({
      id: newId(),
      start: l.start_ms / 1000,
      end: (l.start_ms + l.duration_ms) / 1000,
      label: l.label ?? '',
      snapZeroCross: l.snap_zero_cross ?? undefined,
    }));
  }
  if (category === 'patterns') {
    return (items as CustomPatternItem[]).map<PatternItem>((p) => ({
      id: newId(),
      start: p.start_ms / 1000,
      end: (p.start_ms + p.duration_ms) / 1000,
      label: p.label ?? '',
      repeatCount: Math.max(1, Math.floor(p.repeat_count)),
      highlightedBeats: p.highlighted_beats ?? [],
      subbeatGrid: true,
    }));
  }
  return null; // boundaries — no manual-layer equivalent
}

function ReviewChip({
  active, tone, title, onClick, children,
}: {
  active: boolean;
  tone: 'accept' | 'reject';
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const base = 'w-6 h-6 rounded text-[12px] flex items-center justify-center transition-colors';
  const activeCls = tone === 'accept'
    ? 'bg-emerald-500/80 text-emerald-50 border border-emerald-400/70'
    : 'bg-rose-500/80 text-rose-50 border border-rose-400/70';
  const idleCls = tone === 'accept'
    ? 'text-slate-500 hover:bg-emerald-500/10 hover:text-emerald-300 border border-white/[0.06]'
    : 'text-slate-500 hover:bg-rose-500/10 hover:text-rose-300 border border-white/[0.06]';
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`${base} ${active ? activeCls : idleCls}`}
    >{children}</button>
  );
}

function summarizeItem(
  category: ReviewableCategory,
  item: CustomBoundaryItem | CustomCueItem | CustomSpanItem | CustomLoopItem | CustomPatternItem,
): string {
  const fmt = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
  if (category === 'cues') {
    const c = item as CustomCueItem;
    const lbl = c.label ?? '(unlabeled)';
    return `${fmt(c.time_ms)} — ${lbl}`;
  }
  if (category === 'boundaries') {
    const b = item as CustomBoundaryItem;
    const lbl = b.label ?? '(unlabeled)';
    return `${fmt(b.time_ms)} — ${lbl}`;
  }
  if (category === 'spans') {
    const s = item as CustomSpanItem;
    return `${fmt(s.start_ms)} → ${fmt(s.start_ms + s.duration_ms)} — ${s.label ?? '(unlabeled)'}`;
  }
  if (category === 'loops') {
    const l = item as CustomLoopItem;
    return `${fmt(l.start_ms)} (${fmt(l.duration_ms)}) — ${l.label ?? 'loop'}`;
  }
  // patterns
  const p = item as CustomPatternItem;
  return `${fmt(p.start_ms)} × ${p.repeat_count} cycles of ${fmt(p.duration_ms)} — ${p.label ?? 'pattern'}`;
}
