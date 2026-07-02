/**
 * UnifiedAnnotationListPanel — "see everything" view that lives at the bottom
 * of the right-edge Annotate sidebar.
 *
 * Groups every annotation on the current song by top-level type
 * (BOUNDARIES · CUES · SPANS · LOOPS · PATTERNS) and renders each container
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
 * Boundaries are special: until the deferred boundaries-as-layers refactor
 * lands, we synthesize one virtual layer per "listening" (Manual /
 * Auto-guess / each custom boundary detector with a cached result) from the
 * existing single-doc state. Only Manual exposes an external section setter
 * (setSectionsRef), so it's the only boundary source where the sidebar's X
 * and ★ are active; the rest stay read-only here and must be edited from
 * their dedicated panel below the waveform.
 */

import { useMemo, useState, type ReactNode } from 'react';
import type {
  AnnotationLayer,
  AnnotationLayersDocument,
  CueItem,
  SpanItem,
  LoopItem,
  PatternItem,
  LyricsItem,
} from '../../types/annotationLayer';
import type {
  ManualAnnotation,
  AutoGuessManualAnnotation,
} from '../../types/manualAnnotation';
import { sectionColor, sectionLabel } from './sectionConstants';
import { isExperimentalType, type AnnotationType } from './shared/tabConfig';
import type { SourceId } from './shared/AnnotationSourcePicker';
import { ImportanceStar } from './shared/ImportanceStar';
import { AnnotationTypeChip } from './shared/AnnotationTypeChip';

// Each row in a unified layer card. Either a single point (cue / boundary) or
// an interval (span / loop / pattern).
interface UnifiedItem {
  id: string;
  time: number;             // start time (point time for cues/boundaries)
  end: number | null;       // null = point event
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

function fmtTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '0:00.0';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

// ─── Item adapters: convert each storage shape into UnifiedItem rows ───────

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

function patternLayerToUnified(layer: AnnotationLayer<'patterns'>): UnifiedLayer {
  return {
    id: layer.id,
    name: layer.name,
    color: layer.color,
    readOnly: layer.readOnly === true,
    sourceId: layerSourceId(layer),
    items: (layer.items as PatternItem[]).slice().sort((a, b) => a.start - b.start).map((p) => ({
      id: p.id,
      time: p.start,
      end: p.end,
      label: p.label,
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

function manualToUnified(
  ann: ManualAnnotation | null,
  name: string,
  color: string,
  sourceId: SourceId,
  opts?: { readOnly?: boolean; idKey?: string },
): UnifiedLayer | null {
  // `sections` is optional on storage — a time-only annotation omits it. Use
  // optional chaining so an empty/absent list collapses the layer instead of
  // throwing and blanking the whole panel.
  if (!ann || !ann.sections?.length) return null;
  // The layer id is a *stable* key the parent page matches on (e.g.
  // `'boundaries:Manual'` in InspectorPageV2's
  // delete / toggle / select handlers), so it must NOT track the
  // human-visible `name` (which the user can rename, e.g. "Boundaries 1").
  // Use the source-derived idKey for the id and item ids; fall back to the
  // capitalized sourceId so existing handlers keep resolving correctly.
  const idKey = opts?.idKey ?? name;
  // Encode the original (unsorted) index in the synthesized id so external
  // mutation handlers (delete / toggle-importance) can resolve back to the
  // right slot in the page-owned sections array, which is *not* sorted.
  return {
    id: `boundaries:${idKey}`,
    name,
    color,
    readOnly: opts?.readOnly === true,
    sourceId,
    items: ann.sections
      .map((s, originalIndex) => ({ s, originalIndex }))
      .sort((a, b) => a.s.time - b.s.time)
      .map(({ s, originalIndex }) => ({
        id: `${idKey}:idx${originalIndex}`,
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
  /** Owns cues / spans / loops / patterns layers for the active song. The
   *  Annotate list is manual-only by design — curated / detector layers live
   *  in their own Curated sidebar, so none of them flow into this panel. */
  cueLayersDoc: AnnotationLayersDocument | null;
  /** Boundary single-doc state — one virtual layer per source until the
   *  deferred boundaries-as-layers refactor lands. */
  manualAnnotation: ManualAnnotation | null;
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
  focusedPattern?: { layerId: string; itemId: string } | null;
  onFocusPattern?: (selection: { layerId: string; itemId: string } | null) => void;
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
  /** Rename a layer inline from the card header. Only wired for editable
   *  typed user layers (cues/spans/loops/patterns); boundary layers carry a
   *  fixed source name and read-only layers stay non-editable. */
  onRenameLayer?: (layerId: string, sectionType: AnnotationType, name: string) => void;
  /** Edit a single item's label inline from its row. Same gating as
   *  onRenameLayer — editable typed user layers only. */
  onChangeItemLabel?: (layerId: string, itemId: string, sectionType: AnnotationType, label: string) => void;
  /** Currently-active layer id per section — drives the highlighted row
   *  in each section. The id should match a UnifiedLayer.id within that
   *  section (e.g. `'boundaries:Manual'`, `'detector-cue:foo'`, or the
   *  user cue/span/loop/pattern layer id). */
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
}

// ─── Panel ──────────────────────────────────────────────────────────────────

export function UnifiedAnnotationListPanel({
  cueLayersDoc,
  manualAnnotation,
  autoGuessAnnotation,
  activeAnnotationType,
  onSelectType,
  onSeekAndPlay,
  focusedCue, onFocusCue,
  focusedSpan, onFocusSpan,
  focusedLoop, onFocusLoop,
  focusedPattern, onFocusPattern,
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
}: UnifiedAnnotationListPanelProps) {
  // ── Boundaries virtual layers ─────────────────────────────────────────────
  const boundaryLayers = useMemo<UnifiedLayer[]>(() => {
    const out: UnifiedLayer[] = [];
    // Display name is "Boundaries 1" (mirrors "Cues 1" / "Spans 1"), but the
    // layer id stays `boundaries:Manual` so InspectorPageV2's mutation/select
    // handlers keep matching it.
    const manual = manualToUnified(manualAnnotation, 'Boundaries 1', '#a78bfa', 'manual', { readOnly: false, idKey: 'Manual' });
    if (manual) out.push(manual);
    const ag = autoGuessToUnified(autoGuessAnnotation, '#f59e0b');
    if (ag) out.push(ag);
    return out;
  }, [manualAnnotation, autoGuessAnnotation]);

  // ── Cue / Span / Loop / Pattern layers (user-authored only) ───────────────
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

  const patternLayersUnified = useMemo<UnifiedLayer[]>(() => {
    if (!experimentalLoopsAndPatterns) return [];
    return (cueLayersDoc?.layers ?? [])
      .filter((l): l is AnnotationLayer<'patterns'> => l.type === 'patterns')
      .map(patternLayerToUnified);
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
      emptyHint: 'No boundary annotations yet. Pick a source above and click the visualization to drop a point.' },
    { type: 'cues',       title: 'Cues',        layers: cueLayersUnified,
      description: 'Single events at a point in time (downbeats, drops, hits).',
      emptyHint: 'No cue layers yet — add a layer above to start.' },
    { type: 'spans',      title: 'Spans',       layers: spanLayersUnified,
      description: 'Ranged regions with a start and end; multiple spans may overlap.',
      emptyHint: 'No span layers yet — drag a region on the visualization to add one.' },
    ...(experimentalLoopsAndPatterns ? [{ type: 'loops' as AnnotationType, title: 'Loops', layers: loopLayersUnified,
      description: 'Repeating segments — a region plus the cycle length that repeats inside it.',
      emptyHint: 'No loop layers yet.' }] : []),
    ...(experimentalLoopsAndPatterns ? [{ type: 'patterns' as AnnotationType, title: 'Patterns', layers: patternLayersUnified,
      description: 'Recurring rhythmic motifs that show up at multiple points in the song.',
      emptyHint: 'No pattern layers yet.' }] : []),
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
                        if (type === 'patterns') return focusedPattern?.layerId === layer.id ? focusedPattern.itemId : null;
                        if (type === 'lyrics')   return focusedLyrics?.layerId === layer.id ? focusedLyrics.itemId : null;
                        return null;
                      })()}
                      onSeekItem={(item) => {
                        const stop = item.end ?? item.time + 0.5;
                        onSeekAndPlay(item.time, stop);
                        if (type === 'cues' && onFocusCue && !layer.readOnly) {
                          onFocusCue({ layerId: layer.id, itemId: item.id });
                        } else if (type === 'spans' && onFocusSpan && !layer.readOnly) {
                          onFocusSpan({ layerId: layer.id, itemId: item.id });
                        } else if (type === 'loops' && onFocusLoop && !layer.readOnly) {
                          onFocusLoop({ layerId: layer.id, itemId: item.id });
                        } else if (type === 'patterns' && onFocusPattern && !layer.readOnly) {
                          onFocusPattern({ layerId: layer.id, itemId: item.id });
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
                      onChangeItemLabel={onChangeItemLabel && !layer.readOnly && type !== 'boundaries'
                        ? (item, label) => onChangeItemLabel(layer.id, item.id, type, label)
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
        className={`w-full flex items-center gap-2 px-2 py-1.5 bg-[#0f1116] transition-colors ${
          onSelect ? 'hover:bg-[#161a21] cursor-pointer' : ''
        } ${collapsed ? '' : 'border-b border-white/[0.10]'}`}
      >
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
          className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
          style={{ background: layer.color, boxShadow: `0 0 6px ${layer.color}aa` }}
        />
        {onRenameLayer ? (
          // Nested inside the card's role=button header, so swallow click/key
          // events that would otherwise seek/select the card while editing.
          <input
            value={layer.name}
            onChange={(e) => onRenameLayer(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            spellCheck={false}
            title="Rename layer"
            className={`flex-1 min-w-0 bg-transparent border-0 rounded px-1 -mx-1 text-[12px] font-semibold text-left focus:outline-none focus:bg-white/[0.06] ${
              isSelected ? 'text-white' : 'text-slate-50'
            }`}
          />
        ) : (
          <span className={`flex-1 min-w-0 truncate text-[12px] font-semibold text-left ${
            isSelected ? 'text-white' : 'text-slate-50'
          }`}>
            {layer.name}
          </span>
        )}
        {isSelected && (
          <span className="shrink-0 text-[8.5px] uppercase tracking-wider font-semibold text-cyan-100 border border-cyan-400/40 bg-cyan-500/20 rounded px-1 py-0.5">
            active
          </span>
        )}
        <span className="text-[10px] font-mono text-slate-200 shrink-0">
          {layer.items.length}
        </span>
        {onDeleteLayer && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDeleteLayer(); }}
            title="Delete this layer (⌘Z to undo)"
            className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-slate-300 hover:text-red-300 hover:bg-red-500/15 text-[12px] leading-none"
          >
            ×
          </button>
        )}
      </div>
      {collapsed ? null : layer.items.length === 0 ? (
        <div className="px-3 py-2 text-[10.5px] text-slate-300 italic">
          {sectionType === 'boundaries' ? 'No points.'
            : sectionType === 'cues' ? 'No cues yet.'
            : sectionType === 'spans' ? 'No spans yet.'
            : sectionType === 'loops' ? 'No loops yet.'
            : 'No patterns yet.'}
        </div>
      ) : (
        <ul className="divide-y divide-white/[0.08]">
          {layer.items.map((item, i) => {
            const isItemSelected = item.id === selectedItemId;
            const isInterval = item.end !== null;
            const seekTitle = isInterval
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
                  className={`w-full flex items-center gap-2 px-2 py-1 text-left transition-colors cursor-pointer ${
                    isItemSelected ? 'bg-white/[0.10]' : 'hover:bg-white/[0.05]'
                  }`}
                >
                  <span className="text-[9px] font-mono text-slate-300 w-6 shrink-0">#{i + 1}</span>
                  <span
                    className="inline-block w-1 h-3 shrink-0 rounded-sm"
                    style={{ background: item.color }}
                  />
                  {isInterval ? (
                    <span className="font-mono text-[11px] text-slate-100 shrink-0">
                      {fmtTime(item.time)}<span className="text-slate-400"> → </span>{fmtTime(item.end!)}
                    </span>
                  ) : (
                    <span className="font-mono text-[11px] text-slate-100 w-14 shrink-0">
                      {fmtTime(item.time)}
                    </span>
                  )}
                  {onChangeItemLabel ? (
                    // Same event-swallowing as the layer-name input: the row is
                    // a role=button that seeks on click / Enter / Space.
                    <input
                      value={item.label}
                      onChange={(e) => onChangeItemLabel(item, e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      }}
                      placeholder="label"
                      spellCheck={false}
                      className="flex-1 min-w-0 bg-transparent border-0 rounded px-1 -mx-1 text-[11px] text-slate-100 focus:outline-none focus:bg-white/[0.06] placeholder:text-slate-400 placeholder:italic"
                    />
                  ) : (
                    <span className="flex-1 min-w-0 truncate text-[11px] text-slate-100">
                      {item.label || <span className="text-slate-400 italic">label</span>}
                    </span>
                  )}
                  {item.sublabel && (
                    <span className="shrink-0 text-[9px] text-slate-200 font-mono">
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
                      className={`shrink-0 w-5 h-5 flex items-center justify-center text-[10px] ${
                        item.importance === 'critical' ? 'text-amber-300' : 'text-slate-400'
                      }`}
                      title={item.importance === 'critical' ? 'Critical' : 'Optional'}
                      aria-hidden
                    >
                      {item.importance === 'critical' ? '★' : '☆'}
                    </span>
                  )}
                  <span
                    className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-emerald-300 text-[11px]"
                    aria-hidden
                  >
                    ▶
                  </span>
                  {onDeleteItem && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onDeleteItem(item); }}
                      title="Delete (⌘Z to undo)"
                      className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-slate-300 hover:text-red-300 hover:bg-red-500/15 text-[12px] leading-none"
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
