/**
 * UnifiedAnnotationListPanel — "see everything" view that lives at the bottom
 * of the right-edge Annotate sidebar.
 *
 * Groups every annotation on the current song by top-level type
 * (BOUNDARIES · CUES · SPANS · LOOPS · RIFF PATTERNS) and renders each container
 * as a stack of layer cards in the same compact visualization. Rich editing
 * still happens in the per-type editors mounted below the waveform; this
 * panel adds three per-row affordances on top: click to seek the playhead,
 * toggle the critical/optional star, and delete with the X button. The
 * mutation handlers are wired by the parent so deletes/edits go through the
 * same setters as the rich editors and stay inside the existing undo stack.
 *
 * Layout is a horizontal tab row: all type tabs share one row across the top
 * (splitting the width evenly). Directly below sits an accent-tinted frame
 * (matching the active type) holding just the active type's edit controls
 * (actionsSlot), so the tab and its controls read as one panel; the layer
 * cards render below that frame, unframed.
 *
 * Boundaries are ordinary layers here, same as every other kind. Auto-guess is
 * the one exception left: it is a review workflow over clustered algorithm
 * output rather than a lane, so it is synthesized as a read-only virtual layer
 * inside the BOUNDARIES section and must be edited from its own panel below
 * the waveform.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { formatClockTime as fmtTime } from '../../utils/clockTime';
import type {
  AnnotationLayer,
  AnnotationLayersDocument,
  BoundaryItem,
  CueItem,
  SpanItem,
  LoopItem,
  RiffPatternItem,
  LyricsItem,
} from '../../types/annotationLayer';
import type { AutoGuessManualAnnotation } from '../../types/autoGuess';
import { sectionColor, sectionLabel } from './sectionConstants';
import { isExperimentalType, type AnnotationType } from './shared/tabConfig';
import type { SourceId } from './shared/AnnotationSourcePicker';
import { ImportanceStar } from './shared/ImportanceStar';
import { AnnotationTypeChip } from './shared/AnnotationTypeChip';
import { InlineEditableName } from './InlineEditableName';

// Each row in a unified layer card. Either a single point (cue / boundary) or
// an interval (span / loop / riff instance).
interface UnifiedItem {
  id: string;
  time: number;             // start time (point time for cues/boundaries)
  end: number | null;       // null = point event
  /** End of the stretch to AUDITION, when that's longer than `[time, end]`.
   *  Patterns and riff-patterns store one cycle in `[start, end]` and tile it
   *  `repeatCount` times, so playing the row should run through every repeat —
   *  the row still displays the cycle, which is what the editors edit. */
  playEnd?: number;
  /** Repeat count for tiled kinds, so the row can say what `playEnd` covers. */
  repeats?: number;
  label: string;
  color: string;            // accent color for the row marker
  importance?: 'critical' | 'optional';
  /** Optional sub-label rendered after the main label (e.g. section type). */
  sublabel?: string;
}

interface UnifiedLayer {
  id: string;
  name: string;
  color: string;
  /** When true the layer is from a custom detector / non-editable source —
   *  shown with a "read-only" badge and slightly muted styling. */
  readOnly?: boolean;
  /** Source identifier (mirrors AnnotationSourcePicker's SourceId) — lets a
   *  click on the layer card switch the source picker above the waveform
   *  back to the right entry without the parent having to decode our
   *  synthesized layer ids. */
  sourceId: SourceId;
  items: UnifiedItem[];
}

/** Public payload handed back when the user clicks a layer card. */
export interface UnifiedLayerSelection {
  id: string;
  sourceId: SourceId;
  name: string;
  readOnly: boolean;
}

// ─── Item adapters: convert each storage shape into UnifiedItem rows ───────

/** End of the whole REPEATED region of a tiled item (pattern / riff-pattern).
 *  These store ONE cycle in `[start, end]` and tile it `repeatCount` times, so
 *  the stretch the item actually covers on the canvas — and the stretch a row
 *  should audition — runs to here, not to `end`. Mirrors the tiling in
 *  `PatternLaneRow` / `RiffPatternLaneRow`. Degenerate cycles fall back to
 *  `end`. */
function repeatedRegionEnd(item: { start: number; end: number; repeatCount: number }): number {
  const cycle = item.end - item.start;
  if (cycle <= 0) return item.end;
  return item.start + Math.max(1, Math.floor(item.repeatCount)) * cycle;
}

/** Resolve the SourceId for a typed layer (user vs detector). */
function layerSourceId(layer: AnnotationLayer): SourceId {
  return layer.source && layer.source.startsWith('detector:')
    ? (layer.source as SourceId)
    : 'manual';
}

function cueLayerToUnified(layer: AnnotationLayer<'cues'>): UnifiedLayer {
  return {
    id: layer.id,
    name: layer.name,
    color: layer.color,
    readOnly: layer.readOnly === true,
    sourceId: layerSourceId(layer),
    items: (layer.items as CueItem[]).slice().sort((a, b) => a.time - b.time).map((c) => ({
      id: c.id,
      time: c.time,
      end: null,
      label: c.label,
      color: layer.color,
      importance: c.importance,
    })),
  };
}

function spanLayerToUnified(layer: AnnotationLayer<'spans'>): UnifiedLayer {
  return {
    id: layer.id,
    name: layer.name,
    color: layer.color,
    readOnly: layer.readOnly === true,
    sourceId: layerSourceId(layer),
    items: (layer.items as SpanItem[]).slice().sort((a, b) => a.start - b.start).map((s) => ({
      id: s.id,
      time: s.start,
      end: s.end,
      label: s.label,
      color: layer.color,
      importance: s.importance,
    })),
  };
}

function loopLayerToUnified(layer: AnnotationLayer<'loops'>): UnifiedLayer {
  return {
    id: layer.id,
    name: layer.name,
    color: layer.color,
    readOnly: layer.readOnly === true,
    sourceId: layerSourceId(layer),
    items: (layer.items as LoopItem[]).slice().sort((a, b) => a.start - b.start).map((l) => ({
      id: l.id,
      time: l.start,
      end: l.end,
      label: l.label,
      color: layer.color,
      importance: l.importance,
    })),
  };
}

function riffPatternLayerToUnified(layer: AnnotationLayer<'riff-patterns'>): UnifiedLayer {
  return {
    id: layer.id,
    name: layer.name,
    color: layer.color,
    readOnly: layer.readOnly === true,
    sourceId: layerSourceId(layer),
    items: (layer.items as RiffPatternItem[]).slice().sort((a, b) => a.start - b.start).map((p) => ({
      id: p.id,
      time: p.start,
      end: p.end,
      playEnd: repeatedRegionEnd(p),
      repeats: Math.max(1, Math.floor(p.repeatCount)),
      sublabel: p.repeatCount > 1 ? `×${Math.floor(p.repeatCount)}` : undefined,
      label: p.label || `×${p.repeatCount}`,
      color: layer.color,
      importance: p.importance,
    })),
  };
}

function lyricsLayerToUnified(layer: AnnotationLayer<'lyrics'>): UnifiedLayer {
  return {
    id: layer.id,
    name: layer.name,
    color: layer.color,
    readOnly: layer.readOnly === true,
    sourceId: layerSourceId(layer),
    items: (layer.items as LyricsItem[]).slice().sort((a, b) => a.time - b.time).map((l) => ({
      id: l.id,
      time: l.time,
      end: l.end ?? null,
      label: l.text || `(${l.kind})`,
      color: layer.color,
    })),
  };
}

/** Boundary layers are ordinary layers now: real ids, real items, the same
 *  rename / delete / add affordances as every other kind. Rows carry the
 *  SECTION-TYPE colour rather than the layer colour, because the type is what
 *  the annotator reads a row by — identifying the lane is the card header's
 *  job, and that already wears the layer colour. */
function boundaryLayerToUnified(layer: AnnotationLayer<'boundaries'>): UnifiedLayer {
  return {
    id: layer.id,
    name: layer.name,
    color: layer.color,
    readOnly: layer.readOnly === true,
    sourceId: layerSourceId(layer),
    items: (layer.items as BoundaryItem[]).slice().sort((a, b) => a.time - b.time).map((s) => ({
      id: s.id,
      time: s.time,
      end: null,
      label: s.label || sectionLabel(s.type),
      color: sectionColor(s.type),
      importance: s.importance,
      sublabel: s.label ? sectionLabel(s.type) : undefined,
    })),
  };
}

function autoGuessToUnified(ann: AutoGuessManualAnnotation | null, color: string): UnifiedLayer | null {
  if (!ann || !ann.points.length) return null;
  return {
    id: 'boundaries:autoGuess',
    name: 'Auto-guess',
    color,
    readOnly: true,
    sourceId: 'autoGuess',
    items: ann.points.slice().sort((a, b) => a.time - b.time).map((p, i) => ({
      id: p.id || `autoGuess:${i}`,
      time: p.time,
      end: null,
      label: '',
      color,
      sublabel: p.status === 'correct' ? '✓' : p.status === 'incorrect' ? '✗' : p.status === 'partial' ? '@' : '·',
    })),
  };
}

// ─── Props ──────────────────────────────────────────────────────────────────

interface UnifiedAnnotationListPanelProps {
  /** Owns every layer for the active song — boundaries included. The
   *  Annotate list is manual-only by design — curated / detector layers live
   *  in their own Curated sidebar, so none of them flow into this panel. */
  cueLayersDoc: AnnotationLayersDocument | null;
  /** Auto-guess is still its own document — a review workflow, not a lane —
   *  so it is synthesized into a read-only virtual layer below. */
  autoGuessAnnotation: AutoGuessManualAnnotation | null;
  /** Active tab — drives the highlighted (cyan/fuchsia) section chip-title. */
  activeAnnotationType: AnnotationType;
  /** Click a section chip-title to make that type active. Mirrors the old
   *  top TabGroup's onChange (the chips moved here as the section titles). */
  onSelectType?: (type: AnnotationType) => void;
  /** Click handler — seeks the playhead and (optionally) starts playback. */
  onSeekAndPlay: (time: number, stop?: number) => void;
  /** Focus-sync hooks: when the user clicks a row, we also focus the item so
   *  the canvas popover and editor highlight line up. */
  focusedCue?: { layerId: string; itemId: string } | null;
  onFocusCue?: (selection: { layerId: string; itemId: string } | null) => void;
  focusedSpan?: { layerId: string; itemId: string } | null;
  onFocusSpan?: (selection: { layerId: string; itemId: string } | null) => void;
  focusedLoop?: { layerId: string; itemId: string } | null;
  onFocusLoop?: (selection: { layerId: string; itemId: string } | null) => void;
  focusedLyrics?: { layerId: string; itemId: string } | null;
  onFocusLyrics?: (selection: { layerId: string; itemId: string } | null) => void;
  /** Delete a single item from an editable layer. Wired by the parent so the
   *  mutation goes through the same state setters as the editor below the
   *  waveform (manual sections, cueLayersDoc, …). Read-only layers ignore
   *  this — the buttons aren't rendered for them. */
  onItemDelete?: (layerId: string, itemId: string, sectionType: AnnotationType) => void;
  /** Toggle critical ↔ optional for a single item. Same dispatch story as
   *  onItemDelete. */
  onItemToggleImportance?: (layerId: string, itemId: string, sectionType: AnnotationType) => void;
  /** Delete an entire layer. Wired by the parent so the mutation goes through
   *  the same state setters as the rich editor (and stays inside the undo
   *  stack). Read-only layers don't reach this — the button isn't rendered. */
  onDeleteLayer?: (layerId: string, sectionType: AnnotationType) => void;
  /** Rename a layer inline from the card header. Wired for every editable
   *  layer, boundaries included; read-only layers stay non-editable. */
  onRenameLayer?: (layerId: string, sectionType: AnnotationType, name: string) => void;
  /** Edit a single item's label inline from its row. Wired for every editable
   *  (non-read-only) layer, boundary items included. */
  onChangeItemLabel?: (layerId: string, itemId: string, sectionType: AnnotationType, label: string) => void;
  /** Currently-active layer id per section — drives the highlighted row
   *  in each section. The id should match a UnifiedLayer.id within that
   *  section (e.g. `'boundaries:Manual'`, `'detector-cue:foo'`, or the
   *  user cue/span/loop/riff layer id). */
  selectedLayerIdByType?: Partial<Record<AnnotationType, string | null>>;
  /** Clicking a layer card switches the tab above and points the ADD+
   *  panel at the chosen layer. The parent owns active-tab + active-source
   *  state; this callback just hands back the user's pick. */
  onSelectLayer?: (type: AnnotationType, selection: UnifiedLayerSelection) => void;
  /** Experimental gates — mirror the page-level settings flags. */
  experimentalLoopsAndPatterns: boolean;
  experimentalLyricsFamily: boolean;
  /** Per-type marker controls (the Info + Actions panels). Rendered inside the
   *  currently-active section, directly under its chip-title header, so every
   *  edit button (Mark In/Out, + Add, Add layer, Fill defaults, Undo/Redo…)
   *  sits under the focused annotation type rather than in a detached strip. */
  actionsSlot?: ReactNode;
  /** Per-layer "+ Add @ playhead", rendered in the header of every editable
   *  layer card of the active type. Replaces the single big "+" that used to
   *  sit in the actions frame above the cards: pressing Add on a card makes
   *  it unambiguous which layer the new item lands in. Read-only layers never
   *  get one. */
  addAtPlayhead?: {
    /** Full label, e.g. "+ Add @ 0:30.0". A function when what Add does
     *  depends on the lane it lands in — the energies lane measures energy
     *  over the range rather than dropping a blank span, and says so. */
    label: string | ((layerId: string) => string);
    /** The anchor is the Add button's own click point, for the handlers that
     *  answer with a popover instead of committing an item outright. */
    onAdd: (layerId: string, anchor: { x: number; y: number }) => void;
  };
}

// ─── Panel ──────────────────────────────────────────────────────────────────

export function UnifiedAnnotationListPanel({
  cueLayersDoc,
  autoGuessAnnotation,
  activeAnnotationType,
  onSelectType,
  onSeekAndPlay,
  focusedCue, onFocusCue,
  focusedSpan, onFocusSpan,
  focusedLoop, onFocusLoop,
  focusedLyrics, onFocusLyrics,
  onItemDelete,
  onItemToggleImportance,
  onDeleteLayer,
  onRenameLayer,
  onChangeItemLabel,
  selectedLayerIdByType,
  onSelectLayer,
  experimentalLoopsAndPatterns,
  experimentalLyricsFamily,
  actionsSlot,
  addAtPlayhead,
}: UnifiedAnnotationListPanelProps) {
  // ── Boundaries ────────────────────────────────────────────────────────────
  // Real layers from the document, plus the auto-guess review strip as a
  // read-only virtual layer alongside them.
  const boundaryLayers = useMemo<UnifiedLayer[]>(() => {
    const out: UnifiedLayer[] = (cueLayersDoc?.layers ?? [])
      .filter((l): l is AnnotationLayer<'boundaries'> => l.type === 'boundaries')
      .map(boundaryLayerToUnified);
    const ag = autoGuessToUnified(autoGuessAnnotation, '#f59e0b');
    if (ag) out.push(ag);
    return out;
  }, [cueLayersDoc, autoGuessAnnotation]);

  // ── Cue / Span / Loop / Riff layers (user-authored only) ─────────────────
  // Detector-sourced (curated) layers are deliberately excluded — they live in
  // the Curated sidebar, so the Annotate list never mixes manual with curated.
  const cueLayersUnified = useMemo<UnifiedLayer[]>(() => {
    return (cueLayersDoc?.layers ?? [])
      .filter((l): l is AnnotationLayer<'cues'> => l.type === 'cues')
      .map(cueLayerToUnified);
  }, [cueLayersDoc]);

  const spanLayersUnified = useMemo<UnifiedLayer[]>(() => {
    return (cueLayersDoc?.layers ?? [])
      .filter((l): l is AnnotationLayer<'spans'> => l.type === 'spans')
      .map(spanLayerToUnified);
  }, [cueLayersDoc]);

  const loopLayersUnified = useMemo<UnifiedLayer[]>(() => {
    if (!experimentalLoopsAndPatterns) return [];
    return (cueLayersDoc?.layers ?? [])
      .filter((l): l is AnnotationLayer<'loops'> => l.type === 'loops')
      .map(loopLayerToUnified);
  }, [cueLayersDoc, experimentalLoopsAndPatterns]);

  const riffPatternLayersUnified = useMemo<UnifiedLayer[]>(() => {
    if (!experimentalLoopsAndPatterns) return [];
    return (cueLayersDoc?.layers ?? [])
      .filter((l): l is AnnotationLayer<'riff-patterns'> => l.type === 'riff-patterns')
      .map(riffPatternLayerToUnified);
  }, [cueLayersDoc, experimentalLoopsAndPatterns]);

  const lyricsLayersUnified = useMemo<UnifiedLayer[]>(() => {
    if (!experimentalLyricsFamily) return [];
    return (cueLayersDoc?.layers ?? [])
      .filter((l): l is AnnotationLayer<'lyrics'> => l.type === 'lyrics')
      .map(lyricsLayerToUnified);
  }, [cueLayersDoc, experimentalLyricsFamily]);

  const sections: Array<{ type: AnnotationType; title: string; layers: UnifiedLayer[]; description: string; emptyHint: string }> = [
    { type: 'boundaries', title: 'Boundaries', layers: boundaryLayers,
      description: 'Split the song into non-overlapping sections (intro, verse, chorus…).',
      emptyHint: 'No boundary annotations yet. Pick a source above and click the visualization where the first section ends — it starts at 0:00.' },
    { type: 'cues',       title: 'Cues',        layers: cueLayersUnified,
      description: 'Single events at a point in time (downbeats, drops, hits).',
      emptyHint: 'No cue layers yet — add a layer above to start.' },
    { type: 'spans',      title: 'Spans',       layers: spanLayersUnified,
      description: 'Ranged regions with a start and end; multiple spans may overlap.',
      emptyHint: 'No span layers yet — drag a region on the visualization to add one.' },
    ...(experimentalLoopsAndPatterns ? [{ type: 'loops' as AnnotationType, title: 'Loops', layers: loopLayersUnified,
      description: 'Repeating segments — a region plus the cycle length that repeats inside it.',
      emptyHint: 'No loop layers yet.' }] : []),
    ...(experimentalLoopsAndPatterns ? [{ type: 'riff-patterns' as AnnotationType, title: 'Riff Patterns', layers: riffPatternLayersUnified,
      description: 'Hierarchical riff composer: nodes → combos → timeline instances.',
      emptyHint: 'No riff-pattern layers yet — add a layer to start building riffs.' }] : []),
    ...(experimentalLyricsFamily ? [{ type: 'lyrics' as AnnotationType, title: 'Lyrics', layers: lyricsLayersUnified,
      description: 'Word- and line-level lyric timestamps (vocal transcription).',
      emptyHint: 'No lyrics layers yet — run the Lyrics detector or add a layer above.' }] : []),
  ];

  const activeSection = sections.find((s) => s.type === activeAnnotationType);
  const activeExperimental = isExperimentalType(activeAnnotationType);

  return (
    <div className="pt-3 mt-3 border-t border-white/[0.10]">
      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-300 font-semibold mb-2 px-1">
        All annotations
      </div>
      <div className="space-y-1.5">
        {/* Tab row — type tabs fill the width and wrap to a second row when the
            panel is too narrow for all six, so labels stay legible (never
            truncated to "BOU…"). */}
        <nav
          aria-label="Annotation types"
          className="flex flex-wrap gap-1"
        >
          {sections.map(({ type, title, layers, description }) => (
            <AnnotationTypeChip
              key={type}
              label={title}
              active={activeAnnotationType === type}
              experimental={isExperimentalType(type)}
              count={layers.reduce((acc, l) => acc + l.items.length, 0)}
              layerCount={layers.length}
              title={description}
              onClick={() => onSelectType?.(type)}
            />
          ))}
        </nav>

        {/* Active-type frame — the tab above + the edit controls (actionsSlot)
            grouped in one accent-tinted frame (cyan, or fuchsia for
            experimental types) so they read as a single panel. The layer
            cards render below, outside the frame. */}
        <div
          className={`min-w-0 rounded-lg border p-2 ${
            activeExperimental
              ? 'border-fuchsia-400/35 bg-fuchsia-500/[0.04] shadow-[0_0_18px_-7px_rgba(232,121,249,0.55)]'
              : 'border-cyan-400/35 bg-cyan-500/[0.04] shadow-[0_0_18px_-7px_rgba(34,211,238,0.55)]'
          }`}
        >
          {actionsSlot}
        </div>

        {/* Layer cards for the active type — below the frame, unframed. */}
        {activeSection && (
            activeSection.layers.length === 0 ? (
              <div className="px-3 py-2 rounded border border-white/[0.12] bg-white/[0.04] text-[10.5px] text-slate-300 italic">
                {activeSection.emptyHint}
              </div>
            ) : (
              <div className="space-y-2">
                {activeSection.layers.map((layer) => {
                  const type = activeSection.type;
                  return (
                    <UnifiedLayerCard
                      key={layer.id}
                      layer={layer}
                      sectionType={type}
                      isSelected={selectedLayerIdByType?.[type] === layer.id}
                      onSelect={onSelectLayer
                        ? () => onSelectLayer(type, {
                            id: layer.id,
                            sourceId: layer.sourceId,
                            name: layer.name,
                            readOnly: layer.readOnly === true,
                          })
                        : undefined}
                      selectedItemId={(() => {
                        if (type === 'cues')     return focusedCue?.layerId === layer.id ? focusedCue.itemId : null;
                        if (type === 'spans')    return focusedSpan?.layerId === layer.id ? focusedSpan.itemId : null;
                        if (type === 'loops')    return focusedLoop?.layerId === layer.id ? focusedLoop.itemId : null;
                        if (type === 'lyrics')   return focusedLyrics?.layerId === layer.id ? focusedLyrics.itemId : null;
                        return null;
                      })()}
                      onSeekItem={(item) => {
                        // Play the item's whole extent. A tiled kind (a riff
                        // instance) runs through every repeat, not just the
                        // one cycle the row displays; any other interval runs to
                        // its own end; a boundary runs to the *next* boundary,
                        // since that stretch is the section it opens (the last
                        // one runs to the end of the track). Only a lone point —
                        // a cue — has no extent to play, so it keeps the short
                        // audition blip.
                        const nextBoundaryTime = type === 'boundaries'
                          ? layer.items.reduce<number | null>(
                              (best, other) => (other.time > item.time && (best === null || other.time < best)
                                ? other.time
                                : best),
                              null,
                            )
                          : null;
                        const stop = item.playEnd
                          ?? item.end
                          ?? (type === 'boundaries'
                            ? (nextBoundaryTime ?? undefined)
                            : item.time + 0.5);
                        onSeekAndPlay(item.time, stop);
                        if (type === 'cues' && onFocusCue && !layer.readOnly) {
                          onFocusCue({ layerId: layer.id, itemId: item.id });
                        } else if (type === 'spans' && onFocusSpan && !layer.readOnly) {
                          onFocusSpan({ layerId: layer.id, itemId: item.id });
                        } else if (type === 'loops' && onFocusLoop && !layer.readOnly) {
                          onFocusLoop({ layerId: layer.id, itemId: item.id });
                        } else if (type === 'lyrics' && onFocusLyrics && !layer.readOnly) {
                          onFocusLyrics({ layerId: layer.id, itemId: item.id });
                        }
                      }}
                      onDeleteItem={onItemDelete && !layer.readOnly
                        ? (item) => onItemDelete(layer.id, item.id, type)
                        : undefined}
                      onToggleItemImportance={onItemToggleImportance && !layer.readOnly
                        ? (item) => onItemToggleImportance(layer.id, item.id, type)
                        : undefined}
                      onDeleteLayer={onDeleteLayer && !layer.readOnly
                        ? () => onDeleteLayer(layer.id, type)
                        : undefined}
                      onRenameLayer={onRenameLayer && !layer.readOnly && type !== 'boundaries'
                        ? (name) => onRenameLayer(layer.id, type, name)
                        : undefined}
                      onChangeItemLabel={onChangeItemLabel && !layer.readOnly
                        ? (item, label) => onChangeItemLabel(layer.id, item.id, type, label)
                        : undefined}
                      addAtPlayheadLabel={typeof addAtPlayhead?.label === 'function'
                        ? addAtPlayhead.label(layer.id)
                        : addAtPlayhead?.label}
                      onAddAtPlayhead={addAtPlayhead && !layer.readOnly
                        ? (anchor) => addAtPlayhead.onAdd(layer.id, anchor)
                        : undefined}
                    />
                  );
                })}
              </div>
            )
          )}
      </div>
    </div>
  );
}

// ─── Layer card (same compact visualization across every annotation type) ──

interface UnifiedLayerCardProps {
  layer: UnifiedLayer;
  sectionType: AnnotationType;
  selectedItemId: string | null;
  /** True when this layer is the active target for the ADD+ panel — the
   *  card gets an accent ring + "active" badge so the user can see what
   *  they just picked. */
  isSelected: boolean;
  /** Clicking the card body fires this and ensures the layer is expanded so
   *  the user immediately sees the items they'll be adding to. */
  onSelect?: () => void;
  onSeekItem: (item: UnifiedItem) => void;
  /** Per-row delete. When absent (read-only layer or parent didn't wire it)
   *  the X button is hidden. */
  onDeleteItem?: (item: UnifiedItem) => void;
  /** Per-row critical ↔ optional toggle. Same hiding rule as onDeleteItem. */
  onToggleItemImportance?: (item: UnifiedItem) => void;
  /** Delete the whole layer. Hidden when absent (read-only layer or parent
   *  didn't wire it). */
  onDeleteLayer?: () => void;
  /** Rename the layer. When absent the name renders as static text. */
  onRenameLayer?: (name: string) => void;
  /** Edit a row's label. When absent the label renders as static text. */
  onChangeItemLabel?: (item: UnifiedItem, label: string) => void;
  /** Add a new item at the playhead into *this* layer. Rendered in the card
   *  header, beside the layer name, so it stays reachable however long the
   *  item list grows. Absent for read-only layers and types with no
   *  playhead-add. */
  onAddAtPlayhead?: (anchor: { x: number; y: number }) => void;
  /** Label for that button, e.g. "+ Add @ 0:30.0". */
  addAtPlayheadLabel?: string;
}

function UnifiedLayerCard({
  layer,
  sectionType,
  selectedItemId,
  isSelected,
  onSelect,
  onSeekItem,
  onDeleteItem,
  onToggleItemImportance,
  onDeleteLayer,
  onRenameLayer,
  onChangeItemLabel,
  onAddAtPlayhead,
  addAtPlayheadLabel,
}: UnifiedLayerCardProps) {
  const [collapsed, setCollapsed] = useState(false);
  // Selecting a layer always expands it: the user clicked to *use* this
  // layer, so showing its items matches intent. The caret button is still
  // available for a manual collapse afterwards.
  const handleSelect = () => {
    if (collapsed) setCollapsed(false);
    onSelect?.();
  };
  return (
    <div
      className={`rounded border bg-[#14171d]/60 overflow-hidden transition-shadow ${
        isSelected ? 'ring-2 ring-cyan-300/80 shadow-[0_0_0_1px_rgba(103,232,249,0.25)]' : ''
      }`}
      style={{
        // Inactive cards keep only the left color stripe so the active card's
        // bright accent border + cyan ring read as clearly different (was
        // every card sitting at the same brightness, making the highlight
        // disappear in a row of equally-bordered cards).
        borderColor: isSelected ? `${layer.color}ee` : 'rgba(255,255,255,0.06)',
        borderLeft: `3px solid ${isSelected ? layer.color : `${layer.color}55`}`,
      }}
    >
      <div
        role={onSelect ? 'button' : undefined}
        tabIndex={onSelect ? 0 : undefined}
        onClick={onSelect ? handleSelect : undefined}
        onKeyDown={onSelect ? (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleSelect();
          }
        } : undefined}
        title={onSelect ? 'Select this layer — switches the tab above and aims ADD+ at it' : undefined}
        className={`w-full flex flex-col gap-1 px-2 py-1.5 bg-[#0f1116] transition-colors ${
          onSelect ? 'hover:bg-[#161a21] cursor-pointer' : ''
        } ${collapsed ? '' : 'border-b border-white/[0.10]'}`}
      >
        {/* Title row: the (renamable) layer name with its pencil right beside
            it, and the layer's "+ Add" pinned to the far right. Add lives up
            here rather than under the item list so it stays reachable when a
            layer holds hundreds of items and the list scrolls far past it. */}
        <div className="flex items-center gap-1.5 min-w-0">
        {onRenameLayer ? (
          // Nested inside the card's role=button header, so swallow click/key
          // events that would otherwise seek/select the card while editing.
          <InlineEditableName
            value={layer.name}
            onChange={onRenameLayer}
            placeholder="layer name"
            title={layer.name}
            editLabel="Rename layer"
            stopPropagation
            className={`min-w-0 flex items-center gap-1 ${isSelected ? 'text-white' : 'text-slate-50'}`}
            textClassName="min-w-0 truncate text-[13px] font-semibold text-left"
            pencilClassName="shrink-0 w-4 h-4 flex items-center justify-center rounded text-slate-400 hover:text-white hover:bg-white/[0.10] text-[12px] leading-none"
            inputClassName={`flex-1 min-w-0 bg-transparent border-0 rounded px-1 -mx-1 text-[13px] font-semibold text-left focus:outline-none focus:bg-white/[0.06] ${
              isSelected ? 'text-white' : 'text-slate-50'
            }`}
          />
        ) : (
          <span className={`min-w-0 truncate text-[13px] font-semibold text-left ${
            isSelected ? 'text-white' : 'text-slate-50'
          }`}>
            {layer.name}
          </span>
        )}
        {onAddAtPlayhead && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onAddAtPlayhead({ x: e.clientX, y: e.clientY }); }}
            title={`${addAtPlayheadLabel ?? '+ Add'} \u2192 ${layer.name}`}
            className="ml-auto shrink-0 flex items-center gap-1 px-2 py-0.5 rounded border border-white/[0.12] bg-white/[0.04] hover:bg-white/[0.10] text-[11px] font-semibold uppercase tracking-wider text-slate-100 transition-colors"
          >
            <span className="text-[13px] leading-none" style={{ color: layer.color }}>+</span>
            <span>Add</span>
          </button>
        )}
        </div>
        {/* Controls row: disclosure + color swatch + ACTIVE on the left; the
            count and × delete are pushed to the right (ml-auto on the count). */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setCollapsed((c) => !c);
            }}
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand layer' : 'Collapse layer'}
            className="shrink-0 w-6 h-6 flex items-center justify-center text-[16px] font-mono text-slate-200 hover:text-white rounded leading-none"
          >
            {collapsed ? '▸' : '▾'}
          </button>
          <span
            className="inline-block w-3 h-3 rounded-sm shrink-0"
            style={{ background: layer.color, boxShadow: `0 0 6px ${layer.color}aa` }}
          />
          {isSelected && (
            <span className="text-[10px] uppercase tracking-wider font-semibold text-cyan-100 border border-cyan-400/40 bg-cyan-500/20 rounded px-1.5 py-0.5">
              active
            </span>
          )}
          <span className="ml-auto text-[12px] font-mono text-slate-200 tabular-nums text-right min-w-[1.5rem]">
            {layer.items.length}
          </span>
          {onDeleteLayer && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDeleteLayer(); }}
              title="Delete this layer (⌘Z to undo)"
              className="w-6 h-6 flex items-center justify-center rounded text-slate-300 hover:text-red-300 hover:bg-red-500/15 text-[15px] leading-none"
            >
              ×
            </button>
          )}
        </div>
      </div>
      {collapsed ? null : layer.items.length === 0 ? (
        <div className="px-3 py-2 text-[12px] text-slate-300 italic">
          {sectionType === 'boundaries' ? 'No points.'
            : sectionType === 'cues' ? 'No cues yet.'
            : sectionType === 'spans' ? 'No spans yet.'
            : sectionType === 'loops' ? 'No loops yet.'
            : 'No items yet.'}
        </div>
      ) : (
        <ul className="divide-y divide-white/[0.08]">
          {layer.items.map((item, i) => {
            const isItemSelected = item.id === selectedItemId;
            const isInterval = item.end !== null;
            // A tiled item plays past the cycle shown in the row, so the
            // tooltip says where it actually stops and how many repeats that is.
            const playsRepeats = item.playEnd !== undefined && item.end !== null
              && item.playEnd > item.end;
            const seekTitle = playsRepeats
              ? `Seek to ${fmtTime(item.time)} → play all ${item.repeats ?? ''}${item.repeats ? ' ' : ''}repeats to ${fmtTime(item.playEnd!)} (cycle ends ${fmtTime(item.end!)})`
              : isInterval
                ? `Seek to ${fmtTime(item.time)} → ${fmtTime(item.end!)}`
                : `Seek to ${fmtTime(item.time)}`;
            // Use a div with role=button so we can nest real <button> elements
            // for the per-row star toggle and X delete (nested <button> in
            // <button> is invalid HTML). The row still behaves like a seek
            // button on click + Enter/Space.
            return (
              <li key={item.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSeekItem(item)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSeekItem(item);
                    }
                  }}
                  title={seekTitle}
                  className={`w-full flex items-center gap-1.5 px-2 py-1 text-left transition-colors cursor-pointer ${
                    isItemSelected ? 'bg-white/[0.10]' : 'hover:bg-white/[0.05]'
                  }`}
                >
                  <span className="text-[10.5px] font-mono text-slate-300 w-6 shrink-0">#{i + 1}</span>
                  <span
                    className="inline-block w-1.5 h-3.5 shrink-0 rounded-sm"
                    style={{ background: item.color }}
                  />
                  {isInterval ? (
                    <span className="font-mono text-[11px] text-slate-100 shrink-0">
                      {fmtTime(item.time)}<span className="text-slate-400">→</span>{fmtTime(item.end!)}
                    </span>
                  ) : (
                    <span className="font-mono text-[12px] text-slate-100 w-14 shrink-0">
                      {fmtTime(item.time)}
                    </span>
                  )}
                  {onChangeItemLabel ? (
                    // Same event-swallowing as the layer-name input: the row is
                    // a role=button that seeks on click / Enter / Space.
                    <InlineEditableName
                      value={item.label}
                      onChange={(label) => onChangeItemLabel(item, label)}
                      placeholder="label"
                      editLabel="Rename"
                      stopPropagation
                      className="flex-auto min-w-0 flex items-center gap-1"
                      textClassName="flex-1 min-w-0 truncate text-[12px] text-slate-100"
                      pencilClassName="shrink-0 w-4 h-4 flex items-center justify-center rounded text-slate-400 hover:text-white hover:bg-white/[0.10] text-[12px] leading-none"
                      inputClassName="flex-1 min-w-0 bg-transparent border-0 rounded px-1 -mx-1 text-[12px] text-slate-100 focus:outline-none focus:bg-white/[0.06] placeholder:text-slate-400 placeholder:italic"
                    />
                  ) : (
                    <span className="flex-auto min-w-0 truncate text-[12px] text-slate-100">
                      {item.label || <span className="text-slate-400 italic">label</span>}
                    </span>
                  )}
                  {item.sublabel && item.sublabel !== item.label && (
                    <span className="min-w-0 truncate text-[10.5px] text-slate-200 font-mono">
                      {item.sublabel}
                    </span>
                  )}
                  {onToggleItemImportance ? (
                    <ImportanceStar
                      importance={item.importance}
                      onToggle={() => onToggleItemImportance(item)}
                      size="sm"
                    />
                  ) : item.importance && (
                    <span
                      className={`shrink-0 w-5 h-5 flex items-center justify-center text-[12px] ${
                        item.importance === 'critical' ? 'text-amber-300' : 'text-slate-400'
                      }`}
                      title={item.importance === 'critical' ? 'Critical' : 'Optional'}
                      aria-hidden
                    >
                      {item.importance === 'critical' ? '★' : '☆'}
                    </span>
                  )}
                  <span
                    className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-emerald-300 text-[13px]"
                    aria-hidden
                  >
                    ▶
                  </span>
                  {onDeleteItem && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onDeleteItem(item); }}
                      title="Delete (⌘Z to undo)"
                      className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-slate-300 hover:text-red-300 hover:bg-red-500/15 text-[15px] leading-none"
                    >
                      ×
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
