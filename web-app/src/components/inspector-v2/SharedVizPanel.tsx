import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTimelineDrag, useRegionSelectDrag } from '../../hooks/useTimelineDrag';
import { PlayerPanel, type PlayerAccent, type ZoomToRange } from '../PlayerPanel';
import { StemSourcePicker } from './StemSourcePicker';
import type { DemucsModel } from '../../hooks/useDemucsStems';
import { detectorBadgeLabel } from './shared/detectorBadge';
import type { StemSource } from '../../pages/InspectorPageV2';
import { getIsMobile } from '../../mobile/mobileMode';
import { MobileRowSheet } from './MobileRowSheet';
import { SignalMarksOverlay, type SignalMark } from './SignalMarksOverlay';
import { ROW_SIZE_SCALE, SIGNAL_ROWS, SIGNAL_ROW_IDS, type RowSheetTarget, type RowSize } from './mobileRows';
import { FrequencyWaveform } from '../FrequencyWaveform';
import { SpectrogramAnnotated } from '../SpectrogramAnnotated';
import { CepstrogramAnnotated } from '../CepstrogramAnnotated';
import { ChromagramAnnotated } from '../ChromagramAnnotated';
import { TempogramAnnotated } from '../TempogramAnnotated';
import { SsmAnnotated } from '../SsmAnnotated';
import EQVisualizer from '../EQVisualizer';
import { TiledStrip, type TileGeom } from '../TiledStrip';
import { TimeRuler } from '../TimeRuler';
import {
  AnnotationOverlays,
  AutoGuessOverlay,
  PendingHighlightOverlay,
  RegionDragOverlay,
  type PendingSelection,
} from './AnnotationOverlays';
import { isOrphanedSection } from './sectionConstants';
import { PreviewWindow, type PreviewRegion } from './PreviewWindow';
import { LayerAudioControls, type LayerAudioConfig, DEFAULT_LAYER_AUDIO } from './LayerAudioControls';
import { TimeDisplayBar } from './TimeDisplayBar';
import { BeatGridOverlay, type LaneGridProps } from './BeatGridOverlay';
import { InlineEditableName } from './InlineEditableName';
import { CueLayerRow } from './CueLayerRow';
import { LyricsLayerRow } from './LyricsLayerRow';
import { LoopLayerRow } from './LoopLayerRow';
import { SpanLaneRow } from './SpanLaneRow';
import { RiffPatternLaneRow } from './RiffPatternLaneRow';
import { AnnotationPointCard } from './shared/AnnotationPointCard';
import { useAnnotationPopover } from './shared/useAnnotationPopover';
import { GROUP_ROW_PREFIX, buildGroupedRowOrder, resolveGroupDrop } from './layerGroupRows';
import type { GroupDrop } from './layerGroupRows';
import type { AutoGuessPoint } from '../../types/autoGuess';
import type {
  AnnotationLayer, AnnotationLayerGroup, ProminenceEnvelope, ProminenceLevel,
} from '../../types/annotationLayer';
import { useBoundaryAudioFeedback } from '../../hooks/useBoundaryAudioFeedback';
import { isTypingTarget } from '../../hooks/useAnnotationShortcuts';
import { useSettings } from '../../context/SettingsContext';
import { snapTimeToGrid, type SnapDivision } from '../../utils/beatGrid';
import { frameAxis as makeFrameAxis, frameAtColumn, frameCenterTime, type FrameAxis } from '../../utils/frameTime';
import { MergeControlsBar } from './MergeControlsBar';
import type { MergedBoundary, MergeSourceLane } from './boundaryMerge';
import { LeadLaneRow } from './LeadLaneRow';
import type { LeadCandidate } from '../../utils/leadLane';
import { beatGridUnitToSnapDivision } from '../../utils/beatTimeFormat';
import { agreementCount } from '../../utils/boundaryClustering';
import { drumHitTitle } from '../../utils/drumHits';

// ─── Section color map ────────────────────────────────────────────────────────

const SECTION_COLORS: Record<string, string> = {
  intro: '#a78bfa', bridge: '#fb7185', buildup: '#fde047',
  drop: '#4ade80', breakdown: '#e879f9', outro: '#64748b',
  silence: '#334155', autoGuess: '#e879f9', default: '#94a3b8',
};
function sectionBg(type: string) { return SECTION_COLORS[type] ?? SECTION_COLORS.default; }

export type BoundaryColoringMode = 'by-type' | 'alternating';

const ALTERNATING_PALETTE = [
  '#60a5fa', '#f472b6', '#34d399', '#fb923c',
  '#a78bfa', '#fbbf24', '#22d3ee', '#f87171',
];

// ─── Row ordering ─────────────────────────────────────────────────────────────

export type VizRowId = string; // fixed IDs + dynamic algo overlay IDs
export const DEFAULT_FIXED_ROW_ORDER: VizRowId[] = ['waveform', 'eq', 'lead', 'autoGuess', 'merge', 'consensus', 'spectrogram', 'cepstrogram', 'chroma', 'tempogram', 'ssm', 'energy', 'brightness', 'novelty', 'onsets', 'flux'];
const FIXED_ROW_IDS = new Set(DEFAULT_FIXED_ROW_ORDER);

// ─── Row label ────────────────────────────────────────────────────────────────
// The label cell doubles as a drag handle: drag any row's label to reorder.
//
// Labels stick to the scroll container's left edge so they stay visible when
// the user pans the horizontally-scrolling viz. The label cell itself drops
// `gap-2`, so its solid bg literally is the gutter: signals scrolling
// underneath hit a hard cut at content-start, with no thin strip peeking
// past the title. `pr-2` gives the right-aligned text breathing room.
//
// Width is `--viz-label-w` PLUS 0.5rem. The non-label sibling rows (player,
// palette, layer-audio, the auto-guess review strip) align their content
// with a `w-[var(--viz-label-w)]` spacer *followed by* a `gap-2`, so their
// content begins at `var + 0.5rem`. Folding that same 0.5rem into the label
// width lands the label's right edge — and thus every data row's content
// start — at the exact same x as those spacer rows. Without it, label rows
// sat 0.5rem to the left of the waveform/spectro/etc. and the per-row
// content visibly failed to line up.
//
// A single resize handle on any row label drives `--viz-label-w`, widening
// the gutter across every row uniformly. Falls back to 3.5rem (the minimum,
// = the width the gutter opens at) when the var is unset — e.g. when the
// cell renders inside a non-Shared-viz context.
// `tc-label-cell` + the cell's `data-label` and text colour are what the phone
// layout draws instead of the cell's contents: a narrow strip with the name
// written up its side (index.css), and a tap that opens the row sheet.
const STICKY_LABEL_CELL = 'tc-label-cell w-[calc(var(--viz-label-w,3.5rem)_+_0.5rem)] shrink-0 sticky left-0 z-30 bg-gray-900 pr-2 flex items-center justify-center relative overflow-hidden';

// ── Label-gutter width (resizable, session-only) ─────────────────────────
// The gutter opens as narrow as it goes and widens only when the user drags
// a row label's grippy. That pick is deliberately NOT persisted to storage:
// it lives in this module-scope variable, so it survives remounts within the
// running app (switching annotation tabs, changing song, leaving and
// re-entering the viz) but resets to the minimum on a page reload.
//
// The width also decides how names are written. At its narrowest the gutter
// is one sideways strip — every name runs up its row, as on the phone. Drag
// the grippy a little wider and it snaps to a column the names read across;
// drag it back under the threshold and it snaps down to the strip again.
// There is no in-between width: a gutter too narrow to read across but wider
// than the strip would only waste the timeline's room.
/** The gutter while row titles are sideways: one line of 12px text and the
 *  selected lane's ⓘ / ⋮ column beside it, clear of the 3px bar a selected
 *  lane draws down its left edge (the cell adds its 0.5rem). */
const VERTICAL_GUTTER_W = 28;
/** Dragged below this, the gutter snaps to the sideways strip. */
const HORIZONTAL_SNAP_W = 52;
/** The narrowest gutter names read across in. */
const HORIZONTAL_MIN_W = 56;
const LABEL_COL_W_MAX = 240;
let labelColWSession = VERTICAL_GUTTER_W;

/** Where a drag of the grippy lands: the strip, or a readable column. */
function snapGutterW(raw: number): number {
  if (raw < HORIZONTAL_SNAP_W) return VERTICAL_GUTTER_W;
  return Math.max(HORIZONTAL_MIN_W, Math.min(LABEL_COL_W_MAX, raw));
}

/** The phone gutter's tag for a row: its first five characters, whole
 *  letters only ("Boundaries 3" → "Bound"). Enough to tell rows apart; the
 *  full name is in the row sheet a tap opens. */
function shortRowName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 5).trim();
}

const SIGNAL_LABEL: Record<string, string> = Object.fromEntries(SIGNAL_ROWS.map((r) => [r.id, r.label]));
const SIGNAL_COLOR: Record<string, string> = Object.fromEntries(SIGNAL_ROWS.map((r) => [r.id, r.color]));

// ─── Lane names never grow their row ──────────────────────────────────────
// A gutter label used to wrap freely, so a long curated name like
// "EDM build/drop/breakdown (mix)" ballooned into five stacked lines and
// dragged the whole row's height up with it — a 22px span lane wearing a 60px
// title. The cell's contents now live in an absolutely-positioned overlay, so
// the label contributes nothing to the row's intrinsic height: the lane sets
// the height, and the name is line-clamped to however many lines actually fit,
// ending in an ellipsis when it doesn't. The full name stays one hover away in
// the cell's title tooltip (and in the ⓘ popover), and dragging the gutter
// wider fits more of it per line without making any row taller.
const LABEL_LINE_PX = 15; // text-[12px] × leading-tight (1.25)
const LABEL_ICONS_PX = 16; // the ⓘ / ⬇ / ◇ affordance strip (14px) on its own line, plus the gap
/** Most lines of name a label may claim before it starts eliding instead. */
const LABEL_MAX_LINES = 2;

/** True while the gutter is the sideways strip (see snapGutterW): every
 *  lane's name is written bottom-to-top along its row, the way the phone
 *  gutter draws it. False, it reads across on up to `LABEL_MAX_LINES` lines.
 *  Set once on the panel root. */
const RowTitlesVerticalContext = createContext(false);
/** True while the phone gutter is its CSS-drawn strip (index.css hides every
 *  cell's contents and paints the name itself), so a label must not claim any
 *  height for a name it isn't drawing. */
const GutterStripContext = createContext(false);

/** Overlay that holds a label cell's contents without adding to its height. */
const LABEL_CELL_BODY = 'absolute inset-0 pr-2 flex items-center justify-center gap-0.5 overflow-hidden';

/**
 * Measures the gutter cell — which stretches to the row's own height — and
 * returns the clamp for the lane name plus the floor the cell is allowed to
 * push the row to. A name may claim up to `LABEL_MAX_LINES`; past that it
 * elides. Taller rows (the tall signal lanes) spend their extra height on more
 * lines of name, since it costs nothing. The ⓘ / ⬇ / ◇ affordances sit on
 * their own strip under the name — never inline, where they would squeeze it
 * to a couple of characters — so they are never what gets elided.
 */
/** Shared 2D context for measuring text. One canvas for the whole panel; it is
 *  never drawn to, only asked how wide a word would be. */
let measureCtx: CanvasRenderingContext2D | null | undefined;
function wordMeasurer(): CanvasRenderingContext2D | null {
  if (measureCtx === undefined) {
    measureCtx = typeof document === 'undefined'
      ? null
      : document.createElement('canvas').getContext('2d');
  }
  return measureCtx;
}

/** Width of the widest chunk that cannot be broken across lines. Split points
 *  are the browser's own: whitespace, and after a slash or hyphen — so
 *  "EDM build/drop/breakdown (mix)" measures "breakdown", not the whole run. */
function widestWordPx(text: string, font: string): number {
  const ctx = wordMeasurer();
  if (!ctx) return 0;      // jsdom — fall back to the wrapping path
  ctx.font = font;
  let widest = 0;
  for (const word of text.trim().split(/(?<=[/\-])|\s+/)) {
    if (!word) continue;
    widest = Math.max(widest, ctx.measureText(word).width);
  }
  return widest;
}

/** Letters a sideways name always gets room for before it elides: enough to
 *  tell "Bound…" from "Bread…", at the price of a taller thin lane. */
const VERTICAL_MIN_LETTERS = 6;

/** The column a sideways name needs: the whole name, or its first
 *  `VERTICAL_MIN_LETTERS` and an ellipsis, whichever is shorter. */
function verticalNamePx(text: string, font: string, letterSpacingPx: number): number {
  const ctx = wordMeasurer();
  if (!ctx) return 0;
  ctx.font = font;
  // The canvas knows nothing of CSS letter-spacing (the labels are
  // tracking-wide), so it is added back per character.
  const px = (t: string) => ctx.measureText(t).width + letterSpacingPx * t.length;
  const name = text.replace(/\s+/g, ' ').trim();
  const full = px(name);
  if (name.length <= VERTICAL_MIN_LETTERS) return Math.ceil(full);
  return Math.ceil(Math.min(full, px(`${name.slice(0, VERTICAL_MIN_LETTERS)}…`)));
}

/** `extraPx`: height the cell spends on controls stacked above a sideways
 *  name (a group header's ▾ and box) — added to the row's floor and taken off
 *  the name's room. */
function useLabelFit(hasIcons: boolean, text: string, extraPx = 0) {
  // Whether the longest unbreakable chunk of the name fits the gutter. When it
  // doesn't, wrapping cannot help and `overflow-wrap: anywhere` splits the word
  // itself — which is where "Prominenc / e", "Boundarie / s" and "Riff / s 1"
  // came from. Measured against the WORD rather than the rendered box so that
  // widening the gutter puts a name back on two tidy lines instead of leaving
  // it elided forever.
  const [unbreakable, setUnbreakable] = useState(false);
  const cellRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLSpanElement>(null);
  const vertical = useContext(RowTitlesVerticalContext);
  // Sideways, the ⓘ / ⬇ / ◇ strip stands beside the name as a column instead
  // of taking a line under it, so it costs the row no height either.
  const iconsH = hasIcons && !vertical ? LABEL_ICONS_PX : 0;
  const [cellH, setCellH] = useState(LABEL_LINE_PX + iconsH);
  // How many lines the untruncated name wants at the gutter's current width.
  // `scrollHeight` reports the full content height even while the clamp hides
  // the overflow, so this stays honest as the user drags the gutter wider.
  const [wantLines, setWantLines] = useState(1);
  const [verticalPx, setVerticalPx] = useState(0);
  useLayoutEffect(() => {
    const cell = cellRef.current;
    if (!cell) return;
    const measure = () => {
      setCellH(cell.clientHeight);
      const name = nameRef.current;
      if (!name) return;
      setWantLines(Math.max(1, Math.round(name.scrollHeight / LABEL_LINE_PX)));
      const cs = getComputedStyle(name);
      const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      // Measured bold: a lane's name turns bold when it is selected, and the
      // row should not have to grow (or the name lose a letter) when it does.
      setVerticalPx(verticalNamePx(text, `${cs.fontStyle} 700 ${cs.fontSize} ${cs.fontFamily}`, parseFloat(cs.letterSpacing) || 0));
      const widest = widestWordPx(text, font);
      setUnbreakable(widest > 0 && widest > name.clientWidth);
    };
    measure();
    // Observing the cell alone catches both axes: the row growing taller and
    // the gutter being dragged wider. Observing the name too would feed the
    // clamp back into its own measurement.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(cell);
    return () => ro.disconnect();
  }, [text]);
  // Phone: the gutter draws the name vertically along the row (index.css), so
  // it never needs the row to grow to fit a line of text.
  const strip = useContext(GutterStripContext);
  const minHeight = strip ? 0
    : vertical ? (verticalPx ? verticalPx + 6 + extraPx : 0)
    : (unbreakable ? 1 : Math.min(wantLines, LABEL_MAX_LINES)) * LABEL_LINE_PX + iconsH;
  const lines = Math.max(1, Math.floor((Math.max(cellH, minHeight) - iconsH) / LABEL_LINE_PX));
  const nameStyle: React.CSSProperties = vertical
    // Up the row, reading bottom-to-top. The cap is the measured cell height:
    // the name sits inside inline wrappers, where a percentage would resolve
    // to nothing and the name would run out of the row instead of eliding.
    ? {
        writingMode: 'vertical-rl', transform: 'rotate(180deg)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        maxHeight: Math.max(0, Math.max(cellH, minHeight) - 4 - extraPx), lineHeight: 1,
      }
    : unbreakable
    // `text-overflow` rather than a line clamp: an unbreakable word overflows
    // its line box horizontally, which the clamp never sees and so never
    // ellipsises.
    ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }
    : {
        display: '-webkit-box',
        WebkitBoxOrient: 'vertical',
        WebkitLineClamp: lines,
        overflow: 'hidden',
        // Never inside a word: a name too wide to wrap takes the ellipsis
        // branch above instead of being sliced in half.
        overflowWrap: 'normal',
      };
  return {
    cellRef,
    nameRef,
    nameStyle,
    minHeight,
    vertical,
    // The body's pr-2 keeps the name clear of the resize grip, which a
    // sideways gutter doesn't have — there it would squeeze the name and the
    // selected lane's icon column. pl-1 keeps the name off the selected
    // lane's 3px edge bar.
    bodyClass: vertical
      ? `${LABEL_CELL_BODY.replace('pr-2', 'pl-1 pr-1')} gap-0.5`
      : `${LABEL_CELL_BODY}${hasIcons ? ' flex-col' : ''}`,
    iconsClass: `shrink-0 flex ${vertical ? 'flex-col gap-0.5' : ''} items-center justify-center leading-none`,
  };
}

interface RowDragHandlers {
  draggable: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
}

/** Thin vertical grippy on the right edge of every label cell — pointerdown
 *  starts a column-wide resize that updates `--viz-label-w`. Shared between
 *  RowLabel and LayerRowLabel so every gutter cell exposes the affordance.
 *
 *  It stays wholly INSIDE the gutter (no negative margin). It used to overhang
 *  2px into the canvas, which parked a z-40 col-resize strip right on top of
 *  t=0 on every row: a mousedown meant to start a selection at the very
 *  beginning of the song grabbed the column resizer instead. */
function LabelResizeHandle({ onResizeStart }: { onResizeStart?: (e: React.PointerEvent) => void }) {
  const vertical = useContext(RowTitlesVerticalContext);
  if (!onResizeStart) return null;
  return (
    <div
      onPointerDown={onResizeStart}
      // Stop the parent label's mousedown so HTML5 drag (row reorder) and
      // the click-to-select handler don't fire when the user grabs the
      // grippy. preventDefault on dragstart is the only thing that actually
      // suppresses the browser-initiated drag on a draggable=true parent.
      onMouseDown={(e) => e.stopPropagation()}
      onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onClick={(e) => e.stopPropagation()}
      draggable={false}
      title={vertical
        ? 'Drag right to widen the label column — names then read across'
        : 'Drag to resize the label column — narrow it all the way and names run up the row'}
      // 4px while sideways: the strip's right edge is the selected lane's ⋮
      // column, and a wider grip would sit on top of it.
      className={`absolute top-0 right-0 h-full ${vertical ? 'w-1' : 'w-1.5'} cursor-col-resize z-40 hover:bg-cyan-400/40 active:bg-cyan-400/60 transition-colors`}
    />
  );
}

function RowLabel({ text, color = 'text-gray-600', colorStyle, dragHandlers, onResizeStart }: {
  text: string; color?: string;
  /** Inline colour, for rows whose hue is data-driven rather than a class. */
  colorStyle?: React.CSSProperties;
  dragHandlers?: RowDragHandlers;
  onResizeStart?: (e: React.PointerEvent) => void;
}) {
  const { cellRef, nameRef, bodyClass, nameStyle, minHeight } = useLabelFit(false, text);
  return (
    <div
      ref={cellRef}
      style={{ minHeight, ...colorStyle }}
      className={`${STICKY_LABEL_CELL} ${color} ${dragHandlers ? 'cursor-grab active:cursor-grabbing' : ''}`}
      data-label={text}
      data-short={shortRowName(text)}
      draggable={dragHandlers?.draggable}
      onDragStart={dragHandlers?.onDragStart}
      onDragEnd={dragHandlers?.onDragEnd}
      title={dragHandlers ? `${text} — drag to reorder` : text}
    >
      <div className={bodyClass}>
        <span
          ref={nameRef}
          className={`text-[12px] tracking-wide text-center leading-tight min-w-0 ${color}`}
          style={{ ...nameStyle, ...colorStyle }}
          title={text}
        >{text}</span>
      </div>
      <LabelResizeHandle onResizeStart={onResizeStart} />
    </div>
  );
}

// ─── Layer row label — click-to-select with neon active highlight ─────────
/** Annotation-layer types whose viz rows accept click-to-select. */
type SelectableLayerType = 'boundaries' | 'cues' | 'spans' | 'loops' | 'riff-patterns' | 'lyrics';
/** Payload sent up when the user clicks a viz row label — same shape as the
 *  unified-sidebar selection so the page handler accepts both call sites. */
export interface VizLayerSelection {
  id: string;
  sourceId: 'manual' | `detector:${string}`;
  name: string;
  readOnly: boolean;
}

/** A group header's ▾ and visibility box stacked above its sideways name,
 *  with the gaps between them. */
const GROUP_CONTROLS_PX = 30;

/** Tri-state visibility box on a group header: every member shown, some of
 *  them, none. Clicking writes every member — each lane stays individually
 *  toggleable afterwards, so the box drops back to the dash as soon as one is
 *  flipped. */
function GroupVisibilityBox({ state, color, onToggle, groupName }: {
  state: 'all' | 'some' | 'none';
  color: string;
  onToggle: () => void;
  groupName: string;
}) {
  const label = state === 'all'
    ? `Hide every lane in ${groupName}`
    : `Show every lane in ${groupName}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className="shrink-0 w-3 h-3 rounded-[3px] flex items-center justify-center transition-colors"
      style={state === 'none'
        ? { border: '1px solid #94a3b877' }
        : { background: state === 'all' ? color : `${color}22`, border: `1px solid ${state === 'all' ? color : `${color}99`}` }}
    >
      {state === 'all' && <span className="block w-1.5 h-1.5 rounded-[1px]" style={{ background: '#0a0b0d' }} />}
      {state === 'some' && <span className="block w-1.5 h-[2px] rounded-[1px]" style={{ background: color }} />}
    </button>
  );
}

/** A group's header row: the band's name, how many lanes it holds, and the two
 *  ways to end it. Members render underneath with a rule in the same colour —
 *  see `groupColor` on LayerRowLabel. */
function GroupHeaderRow({
  group, memberCount, visibility, onToggleCollapsed, onSetVisible, onRename, onUngroup, onDelete,
  dragHandlers, onResizeStart, isDropTarget = false,
}: {
  group: AnnotationLayerGroup;
  memberCount: number;
  visibility: 'all' | 'some' | 'none';
  onToggleCollapsed: () => void;
  onSetVisible: (visible: boolean) => void;
  onRename?: (name: string) => void;
  onUngroup?: () => void;
  onDelete?: () => void;
  dragHandlers?: RowDragHandlers;
  onResizeStart?: (e: React.PointerEvent) => void;
  /** A lane is hovering over the band right now — say what letting go does. */
  isDropTarget?: boolean;
}) {
  const menu = useAnnotationPopover({ width: 260, height: 200 });
  const menuOpen = menu.open?.layerId === group.id;
  const collapsed = group.collapsed === true;
  const lanes = `${memberCount} ${memberCount === 1 ? 'lane' : 'lanes'}`;
  // Sideways, the header stacks ▾, the box and the name down the cell; the
  // name reads up like every lane's, and Rename lives in the ⋯ menu.
  const { cellRef, nameRef, nameStyle, minHeight, vertical } = useLabelFit(false, group.name, GROUP_CONTROLS_PX);
  const [renameRequest, setRenameRequest] = useState(0);

  return (
    <>
      <div
        ref={cellRef}
        className={`${STICKY_LABEL_CELL} group`}
        data-label={group.name}
        data-short={shortRowName(group.name)}
        style={{
          ...(vertical ? { minHeight } : {}),
          color: group.color,
          background: `linear-gradient(90deg, ${group.color}22 0%, #0a0b0d 100%), #0a0b0d`,
          boxShadow: `inset 3px 0 0 0 ${group.color}`,
        }}
        draggable={dragHandlers?.draggable}
        onDragStart={dragHandlers?.onDragStart}
        onDragEnd={dragHandlers?.onDragEnd}
        title={`${group.name} — ${lanes}`}
      >
        <div className={vertical
          ? 'absolute inset-0 flex flex-col items-center gap-1 py-1 pr-1 overflow-hidden'
          : 'flex items-center gap-1 min-w-0 w-full pl-1'}>
          <button
            type="button"
            aria-label={collapsed ? `Expand ${group.name}` : `Collapse ${group.name}`}
            title={collapsed ? 'Expand — show every lane' : 'Collapse — hide the lanes behind the header'}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onToggleCollapsed(); }}
            className="shrink-0 w-2.5 text-[8px] leading-none transition-transform"
            style={{ color: group.color }}
          >
            {collapsed ? '▸' : '▾'}
          </button>
          <GroupVisibilityBox
            state={visibility}
            color={group.color}
            groupName={group.name}
            onToggle={() => onSetVisible(visibility !== 'all')}
          />
          <InlineEditableName
            value={group.name}
            onChange={(next) => onRename?.(next)}
            stopPropagation
            placeholder="group"
            editLabel={`Rename ${group.name}`}
            hidePencil={vertical}
            editRequest={renameRequest}
            textRef={nameRef}
            className="min-w-0 flex items-center gap-1"
            textClassName={vertical ? 'text-[11px] font-bold tracking-wide' : 'text-[10px] font-bold tracking-wide truncate'}
            textStyle={vertical ? { ...nameStyle, color: group.color } : { color: group.color }}
            pencilClassName="shrink-0 w-3 h-3 inline-flex items-center justify-center rounded text-[8px] leading-none opacity-60 hover:opacity-100"
            inputClassName="absolute left-0 top-1/2 -translate-y-1/2 z-[60] min-w-full w-[220px] h-[26px] bg-[#0a0b0d] border border-white/40 rounded px-1.5 text-[12px] text-current shadow-lg shadow-black/60 focus:outline-none focus:border-cyan-400/80"
          />
        </div>
        {onResizeStart && (
          <span
            onPointerDown={onResizeStart}
            className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize opacity-0 group-hover:opacity-100 bg-white/20"
          />
        )}
      </div>
      <div
        className="flex-1 min-w-0 flex items-center gap-3 px-2 rounded-sm transition-colors"
        style={{
          background: `${group.color}${isDropTarget ? '2e' : '14'}`,
          boxShadow: `inset 0 0 0 ${isDropTarget ? '1.5px' : '1px'} ${group.color}${isDropTarget ? 'bb' : '33'}`,
        }}
      >
        <span className="font-mono text-[9.5px]" style={{ color: group.color }}>{lanes}</span>
        {isDropTarget ? (
          <span className="text-[9.5px] font-semibold" style={{ color: group.color }}>
            drop to add to the top of {group.name}
          </span>
        ) : memberCount === 0 && (
          <span className="text-[9.5px] text-slate-500 italic">
            empty — drag a lane onto this header, or use its ⋮ menu
          </span>
        )}
        <button
          type="button"
          aria-label={`${group.name} — group actions`}
          title="Group actions"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (menuOpen) { menu.close(); return; }
            const r = e.currentTarget.getBoundingClientRect();
            menu.openAt(group.id, 'group-menu', { x: r.right, y: r.bottom });
          }}
          className="ml-auto shrink-0 px-1 text-[12px] leading-none text-slate-400 hover:text-slate-100 transition-colors"
        >
          ⋯
        </button>
      </div>
      {menuOpen && (
        <div ref={menu.popoverRef} style={menu.positionStyle} className="z-50">
          <div className="w-[260px] rounded-md border border-white/[0.08] bg-[#14171d] shadow-2xl shadow-black/60 py-1">
            <div className="px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-slate-400 truncate">
              {group.name}
            </div>
            {onRename && (
              <button
                type="button"
                onClick={() => { menu.close(); setRenameRequest((n) => n + 1); }}
                className="w-full px-2.5 py-1.5 text-left text-[11px] text-slate-200 hover:bg-white/[0.06] transition-colors"
              >
                Rename…
              </button>
            )}
            <button
              type="button"
              onClick={() => { onToggleCollapsed(); menu.close(); }}
              className="w-full px-2.5 py-1.5 text-left text-[11px] text-slate-200 hover:bg-white/[0.06] transition-colors"
            >
              {collapsed ? 'Expand' : 'Collapse'}
            </button>
            <div className="h-px bg-white/[0.08] my-1" />
            <button
              type="button"
              onClick={() => { onUngroup?.(); menu.close(); }}
              className="w-full px-2.5 py-1.5 text-left text-[11px] text-slate-200 hover:bg-white/[0.06] transition-colors"
            >
              Ungroup — keeps {lanes}
            </button>
            <button
              type="button"
              onClick={() => { onDelete?.(); menu.close(); }}
              className="w-full px-2.5 py-1.5 text-left text-[11px] text-red-300 hover:bg-red-500/15 transition-colors"
            >
              Delete group and its {lanes}…
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function LayerRowLabel({
  layer,
  isSelected,
  onSelect,
  onRename,
  dragHandlers,
  onResizeStart,
  auditionedStem,
  onCopyToManual,
  existingCopyCount = 0,
  karaokeActive,
  onKaraokeToggle,
  groupColor,
  groupMenu,
}: {
  layer: AnnotationLayer;
  isSelected: boolean;
  onSelect?: () => void;
  /** Rename this lane inline. When set, a pencil follows the name; clicking it
   *  swaps in an input. Only wired for editable user layers. */
  onRename?: (name: string) => void;
  dragHandlers?: RowDragHandlers;
  onResizeStart?: (e: React.PointerEvent) => void;
  /** Copy this read-only detector/algo layer into a new editable manual layer.
   *  When undefined the copy affordance is hidden. */
  onCopyToManual?: () => void;
  /** Count of manual layers already imported from this detector source. Shows
   *  an amber warning in the copy popup so duplicates are obvious. */
  existingCopyCount?: number;
  /** Stem currently being auditioned in the player. Detector layers built from
   *  this stem light up so the annotator can see, at a glance, which curated
   *  layers belong to the stem they're listening to. 'mix' (the whole track)
   *  matches nothing — every layer would qualify, so it's not a useful cue. */
  auditionedStem?: StemSource;
  /** Whether karaoke playhead highlight is enabled for this layer. */
  karaokeActive?: boolean;
  /** Toggle karaoke highlight on/off for this layer. */
  onKaraokeToggle?: () => void;
  /** Colour of the group this lane belongs to, when it belongs to one. Draws
   *  the rule down the gutter's left edge that ties the lane to the header
   *  above it. The selected treatment wins on the lane you're working — you
   *  already know which band it is from the header. */
  groupColor?: string;
  /** Group membership controls for this lane: which band it is in, which bands
   *  exist, and how to change that. Absent on lanes that cannot be grouped —
   *  a detector lane is re-derived each render, so a groupId on it would not
   *  survive the round trip. */
  groupMenu?: {
    groups: readonly AnnotationLayerGroup[];
    currentGroupId?: string;
    onNewGroup: () => void;
    onMoveTo: (groupId: string | null) => void;
  };
}) {
  const auditioned =
    !!auditionedStem && auditionedStem !== 'mix' && layer.sourceStem === auditionedStem;
  // Detector-sourced lanes carry provenance (which heuristic/algorithm + which
  // Demucs stem). Surface it behind a small inline ⓘ at the end of the lane
  // name so the annotator can confirm what a curated layer actually is without
  // leaving the canvas. Inlining it (rather than a separate cell with margin)
  // keeps it from eating lane width. User-authored layers have no detector
  // origin, so they get no icon.
  const detectorId =
    layer.source && layer.source.startsWith('detector:') ? detectorBadgeLabel(layer.source) : undefined;
  // Caveats the detector raised about this run. They ride the ⓘ popover
  // rather than a lane of their own, but they change the BUTTON: a lane whose
  // hits could not be named has to look different from one whose could,
  // without being opened first.
  const runNotes = layer.sourceNotes ?? [];
  const hasInfo = !!(layer.sourceDescription || layer.sourceStem || detectorId || runNotes.length);
  const info = useAnnotationPopover({ width: 300, height: 220 });
  const infoOpen = info.open?.layerId === layer.id;
  const groups = useAnnotationPopover({ width: 240, height: 240 });
  const groupsOpen = groups.open?.layerId === layer.id && groups.open.itemId === 'group-menu';
  // The ⓘ / ⬇ / ◇ strip costs the row a whole line, which is too much rent for
  // a lane you're only looking at. It appears on the selected lane only — the
  // one you're actually working — so every other gutter cell is just its name.
  const vertical = useContext(RowTitlesVerticalContext);
  // Sideways, the ✎ would sit beside a one-column name and read as part of it,
  // so Rename moves into the ⋮ menu instead — which is therefore offered on
  // any renamable lane, grouped or not.
  const menuRename = vertical && !!onRename;
  const hasMenu = !!groupMenu || menuRename;
  const hasIcons = isSelected && (hasInfo || !!onCopyToManual || !!onKaraokeToggle || hasMenu);
  const { cellRef, nameRef, bodyClass, iconsClass, nameStyle, minHeight } = useLabelFit(hasIcons, layer.name);
  const [renameRequest, setRenameRequest] = useState(0);
  // While the rename input is up the gutter cell stops clipping and jumps above
  // its neighbours, so the field can be a readable box (wider than the gutter,
  // taller than a 12px lane) instead of the two-character sliver a 22px row
  // would otherwise allow.
  const [renaming, setRenaming] = useState(false);
  const renamingStyle: React.CSSProperties | undefined = renaming
    ? { overflow: 'visible', zIndex: 60 }
    : undefined;
  return (
    <>
    <div
      ref={cellRef}
      className={`${STICKY_LABEL_CELL} group transition-colors ${
        dragHandlers ? 'cursor-grab active:cursor-grabbing' : ''
      } ${onSelect ? 'hover:bg-[#161a21]' : ''}`}
      data-label={layer.name}
        data-short={shortRowName(layer.name)}
      style={{ color: layer.color, ...(isSelected ? {
        ...renamingStyle,
        minHeight,
        // Solid #0a0b0d base under the tint gradient. The gradient's left stop
        // is the layer color at ~13% alpha, so without an opaque layer behind
        // it, horizontally-scrolled row content bleeds through the sticky title.
        background: `linear-gradient(90deg, ${layer.color}22 0%, #0a0b0d 100%), #0a0b0d`,
        boxShadow: `inset 3px 0 0 0 ${layer.color}, inset -1px 0 0 0 ${layer.color}66`,
      } : auditioned ? {
        ...renamingStyle,
        minHeight,
        // Auditioning this layer's source stem: tint + a soft inset ring so the
        // lane reads as "this is what you're hearing" without stealing the
        // bolder treatment reserved for the actively-selected layer.
        background: `linear-gradient(90deg, ${layer.color}1a 0%, #0a0b0d 100%), #0a0b0d`,
        boxShadow: `inset 2px 0 0 0 ${layer.color}aa`,
      } : groupColor ? {
        ...renamingStyle,
        minHeight,
        boxShadow: `inset 2px 0 0 0 ${groupColor}66`,
      } : { ...renamingStyle, minHeight }) }}
      draggable={dragHandlers?.draggable}
      onDragStart={dragHandlers?.onDragStart}
      onDragEnd={dragHandlers?.onDragEnd}
      onClick={onSelect}
      onKeyDown={onSelect ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }
      } : undefined}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      title={onSelect
        ? `${layer.name} — click to make this the active layer (switches the tab + ADD+ target)${auditioned ? `\nBuilt from the ${auditionedStem} stem you're auditioning.` : ''}`
        : (dragHandlers ? 'Drag to reorder' : layer.name)}
    >
      <div
        className={bodyClass}
        style={{
          ...renamingStyle,
          color: layer.color,
          textShadow: isSelected
            ? `0 0 6px ${layer.color}cc, 0 0 12px ${layer.color}66`
            : auditioned ? `0 0 6px ${layer.color}88` : undefined,
        }}
      >
      <span
        className={`text-[12px] tracking-wide text-center leading-tight min-w-0 max-w-full ${
          isSelected || auditioned ? 'font-bold' : ''
        }`}
      >
        {onRename ? (
          <InlineEditableName
            value={layer.name}
            onChange={onRename}
            placeholder="layer name"
            editLabel="Rename layer"
            stopPropagation
            onEditingChange={setRenaming}
            hidePencil={vertical}
            editRequest={renameRequest}
            className="inline-flex items-center gap-0.5 min-w-0 max-w-full align-middle"
            textClassName="min-w-0"
            textStyle={nameStyle}
            textRef={nameRef}
            pencilClassName="shrink-0 w-3 h-3 inline-flex items-center justify-center rounded text-[8px] leading-none opacity-60 hover:opacity-100"
            // Lifted out of the flow and sized in its own right: as wide as the
            // gutter but never under 220px, and 26px tall, so the name stays
            // readable while it is being typed even on a one-line lane. It
            // overhangs the canvas to the right; the cell's z-60 keeps it on top.
            inputClassName="absolute left-0 top-1/2 -translate-y-1/2 z-[60] min-w-full w-[220px] max-w-none h-[26px] bg-[#0a0b0d] border border-white/40 rounded px-1.5 text-[12px] tracking-wide text-left text-current shadow-lg shadow-black/60 focus:outline-none focus:border-cyan-400/80"
          />
        ) : <span ref={nameRef} style={nameStyle}>{layer.name}</span>}
      </span>
      {hasIcons && (
        <span className={iconsClass}>
          {hasInfo && (
            <button
              type="button"
              aria-label={runNotes.length
                ? `${layer.name} — ${runNotes.length} caveat${runNotes.length > 1 ? 's' : ''} about this result`
                : `${layer.name} — show source detector & stem`}
              title={runNotes.length
                ? runNotes.map((n) => n.message).join('\n\n')
                : 'What built this layer?'}
              // Inline, right after the last word of the name — not a separate
              // cell — so it costs almost no lane width. Stop the click bubbling
              // to the row's select/drag handlers: it only toggles the popover.
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (infoOpen) { info.close(); return; }
                const r = e.currentTarget.getBoundingClientRect();
                info.openAt(layer.id, 'info', { x: r.right, y: r.top });
              }}
              className={`ml-0.5 inline-flex items-center justify-center align-middle w-2.5 h-2.5 rounded-full text-[7px] font-bold leading-none transition-colors ${
                infoOpen
                  ? 'text-[#0a0b0d]'
                  : runNotes.length
                    ? 'text-amber-300 hover:text-amber-200'
                    : 'text-gray-500 hover:text-gray-200'
              }`}
              style={infoOpen ? { background: layer.color } : { border: `1px solid currentColor` }}
            >
              {runNotes.length ? '!' : 'i'}
            </button>
          )}
          {/* ⬇ copy shortcut. Amber = this detector already has copies (a
              duplicate warning), emerald = it would be the first. Rides the
              affordance strip, so it shows on the selected lane. */}
          {onCopyToManual && (
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onCopyToManual(); }}
              title={existingCopyCount > 0
                ? `Copy to manual layer — ${existingCopyCount} existing ${existingCopyCount === 1 ? 'copy' : 'copies'}`
                : `Copy "${layer.name}" to a new editable manual layer`}
              className={`ml-0.5 inline-flex items-center justify-center align-middle w-3.5 h-3.5 rounded text-[9px] leading-none transition-all ${
                isSelected || existingCopyCount > 0
                  ? existingCopyCount > 0
                    ? 'opacity-100 text-amber-300 hover:text-amber-100 hover:bg-amber-500/25'
                    : 'opacity-100 text-emerald-300 hover:text-emerald-100 hover:bg-emerald-500/20'
                  : 'opacity-0 pointer-events-none'
              }`}
            >
              ⬇
            </button>
          )}
          {/* Karaoke highlight toggle — dim ◇ when off, bright ◈ in layer
              color when on. */}
          {onKaraokeToggle && (
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onKaraokeToggle(); }}
              title={karaokeActive
                ? 'Karaoke highlight on — click to disable'
                : 'Enable karaoke playhead highlight for this layer'}
              className="ml-0.5 inline-flex items-center justify-center align-middle w-3 h-3 rounded text-[9px] leading-none transition-all"
              style={{
                color: karaokeActive ? layer.color : '#4b5563',
                textShadow: karaokeActive ? `0 0 6px ${layer.color}cc` : undefined,
                opacity: karaokeActive ? 1 : 0.6,
              }}
            >
              {karaokeActive ? '◈' : '◇'}
            </button>
          )}
          {/* Group membership. ⋮ rather than a word: the strip is 14px tall and
              the menu it opens names every action in full. */}
          {hasMenu && (
            <button
              type="button"
              aria-label={`${layer.name} — lane actions`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (groupsOpen) { groups.close(); return; }
                const r = e.currentTarget.getBoundingClientRect();
                groups.openAt(layer.id, 'group-menu', { x: r.right, y: r.bottom });
              }}
              title={!groupMenu ? 'Rename'
                : groupMenu.currentGroupId
                ? `In "${groupMenu.groups.find((g) => g.id === groupMenu.currentGroupId)?.name ?? 'a group'}" — click to change`
                : menuRename ? 'Rename, or add this lane to a group'
                : 'Add this lane to a group'}
              className={`ml-0.5 inline-flex items-center justify-center align-middle w-3 h-3 rounded text-[10px] leading-none transition-colors ${
                groupsOpen ? 'text-slate-100 bg-white/10' : 'text-gray-500 hover:text-gray-200'
              }`}
            >
              ⋮
            </button>
          )}
        </span>
      )}
      </div>
      <LabelResizeHandle onResizeStart={onResizeStart} />
    </div>
    {hasMenu && groupsOpen && (
      <div ref={groups.popoverRef} style={groups.positionStyle} className="z-50">
        <div className="w-[240px] rounded-md border border-white/[0.08] bg-[#14171d] shadow-2xl shadow-black/60 py-1">
          <div className="px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-slate-400 truncate">
            {layer.name}
          </div>
          {menuRename && (
            <button
              type="button"
              onClick={() => { groups.close(); setRenameRequest((n) => n + 1); }}
              className="w-full px-2.5 py-1.5 text-left text-[11px] text-slate-200 hover:bg-white/[0.06] transition-colors"
            >
              Rename…
            </button>
          )}
          {menuRename && groupMenu && <div className="h-px bg-white/[0.08] my-1" />}
          {groupMenu && (<>
          <button
            type="button"
            onClick={() => { groupMenu.onNewGroup(); groups.close(); }}
            className="w-full px-2.5 py-1.5 text-left text-[11px] text-slate-200 hover:bg-white/[0.06] transition-colors"
          >
            New group from this lane
          </button>
          {groupMenu.groups.length > 0 && (
            <>
              <div className="h-px bg-white/[0.08] my-1" />
              <div className="px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">
                Move to
              </div>
              {groupMenu.groups.map((g) => {
                const current = g.id === groupMenu.currentGroupId;
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => { groupMenu.onMoveTo(current ? null : g.id); groups.close(); }}
                    className="w-full px-2.5 py-1.5 text-left text-[11px] text-slate-200 hover:bg-white/[0.06] flex items-center gap-2 transition-colors"
                  >
                    <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ background: g.color }} />
                    <span className="flex-1 truncate">{g.name}</span>
                    {current && <span className="text-[10px] text-slate-400">●</span>}
                  </button>
                );
              })}
            </>
          )}
          {groupMenu.currentGroupId && (
            <>
              <div className="h-px bg-white/[0.08] my-1" />
              <button
                type="button"
                onClick={() => { groupMenu.onMoveTo(null); groups.close(); }}
                className="w-full px-2.5 py-1.5 text-left text-[11px] text-slate-200 hover:bg-white/[0.06] transition-colors"
              >
                Remove from group
              </button>
            </>
          )}
          </>)}
        </div>
      </div>
    )}
    {infoOpen && (
      <div
        ref={info.popoverRef}
        style={info.positionStyle}
        className="z-50 w-[280px] rounded-md border border-gray-700 bg-[#0d0f13] p-3 shadow-xl text-left"
      >
        <div className="flex items-start gap-2 mb-2">
          <span
            className="mt-0.5 w-2.5 h-2.5 rounded-full shrink-0"
            style={{ background: layer.color }}
          />
          <span className="text-[12px] font-semibold text-gray-100 leading-snug normal-case">
            {layer.name}
          </span>
        </div>
        {runNotes.length > 0 && (
          <ul className="mb-2 space-y-1.5 normal-case list-none">
            {runNotes.map((n) => (
              <li
                key={n.code}
                className="rounded border border-amber-400/30 bg-amber-500/[0.08] px-2 py-1.5 text-[11px] text-amber-100 leading-snug"
              >
                <span aria-hidden className="mr-1">⚠</span>
                {n.message}
              </li>
            ))}
          </ul>
        )}
        {layer.sourceDescription && (
          <p className="text-[11px] text-gray-300 leading-snug mb-2 normal-case">
            {layer.sourceDescription}
          </p>
        )}
        <dl className="text-[10px] leading-tight space-y-1 normal-case">
          {layer.sourceStem && (
            <div className="flex gap-2">
              <dt className="text-gray-500 w-14 shrink-0">Stem</dt>
              <dd className="text-gray-200 font-mono">{layer.sourceStem}</dd>
            </div>
          )}
          {detectorId && (
            <div className="flex gap-2">
              <dt className="text-gray-500 w-14 shrink-0">Detector</dt>
              <dd className="text-gray-200 font-mono break-all">{detectorId}</dd>
            </div>
          )}
        </dl>
        {onCopyToManual && (
          <div className="mt-3 pt-2 border-t border-gray-700/70">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onCopyToManual(); info.close(); }}
              className="w-full px-2 py-1.5 rounded text-[11px] text-emerald-200 border border-emerald-400/30 bg-emerald-500/[0.08] hover:bg-emerald-500/[0.16] transition-colors flex items-center justify-center gap-1.5"
            >
              <span aria-hidden>⬇</span>
              Copy to manual layer
            </button>
            {existingCopyCount > 0 && (
              <p className="mt-1.5 text-center text-[10px] text-amber-400/80">
                {existingCopyCount} existing {existingCopyCount === 1 ? 'copy' : 'copies'} already imported
              </p>
            )}
          </div>
        )}
      </div>
    )}
    </>
  );
}

// ─── Shared grid overlay props ────────────────────────────────────────────────

type GridProps = LaneGridProps;

// ─── Section block row ────────────────────────────────────────────────────────

function SectionBlockRow({ sections, duration, currentTime, height = 22, onBoundaryChange, onBoundaryDragStart, onSectionClick, sectionColorOverrides, boundaryColoringMode, gridProps, pendingSelection }: {
  sections: { time: number; endTime: number; label: string; type: string; color?: string; importance?: string }[];
  duration: number;
  currentTime: number;
  height?: number;
  onBoundaryChange?: (nextSectionIndex: number, newTime: number) => void;
  onBoundaryDragStart?: () => void;
  onSectionClick?: (sectionIndex: number, anchor: { x: number; y: number }) => void;
  sectionColorOverrides?: Record<string, string>;
  boundaryColoringMode?: BoundaryColoringMode;
  gridProps?: GridProps;
  pendingSelection?: PendingSelection | null;
}) {
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const containerRef = useRef<HTMLDivElement>(null);
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;

  const { startDrag: startBoundaryDrag } = useTimelineDrag<{ nextIdx: number }>({
    containerRef,
    duration,
    onDragStart: () => { onBoundaryDragStart?.(); },
    onDrag: ({ nextIdx }, t) => { onBoundaryChange?.(nextIdx, t); },
    clamp: ({ nextIdx }, raw) => {
      const secs = sectionsRef.current;
      const prevTime = secs[nextIdx - 1]?.time ?? 0;
      const nextTime = secs[nextIdx + 1]?.time ?? duration;
      return Math.max(prevTime + 0.1, Math.min(nextTime - 0.1, raw));
    },
  });

  return (
    <div ref={containerRef} className="flex-1 relative rounded overflow-hidden bg-gray-950" style={{ height }}>
      {sections.map((s, i) => {
        const left  = duration > 0 ? (s.time / duration) * 100 : 0;
        const width = Math.max(0.3, duration > 0 ? ((s.endTime - s.time) / duration) * 100 : 0);
        // Filler caps are drawn as empty space; an orphaned section (unset
        // only because its type left the vocabulary) is real annotation and
        // keeps its block and label, in the neutral unset gray.
        const isUnset = s.type === 'unset' && !isOrphanedSection(s);
        const baseColor = boundaryColoringMode === 'alternating'
          ? ALTERNATING_PALETTE[i % ALTERNATING_PALETTE.length]
          : (s.color ?? sectionColorOverrides?.[s.type] ?? sectionBg(s.type));
        const isOptional = s.importance === 'optional';
        const bg = isUnset
          ? 'transparent'
          : isOptional
            ? `radial-gradient(circle, ${baseColor}55 1px, transparent 1.6px) 0 0 / 6px 6px, ${baseColor}aa`
            : baseColor;
        return (
          <div
            key={i}
            className={`absolute top-0 bottom-0 overflow-hidden ${onSectionClick ? 'cursor-pointer hover:ring-1 hover:ring-white/40' : ''}`}
            style={{ left: `${left}%`, width: `${width}%`, background: bg, opacity: isUnset ? 1 : (isOptional ? 0.85 : (i % 2 === 0 ? 1 : 0.85)), borderRight: '1px solid rgba(0,0,0,0.4)' }}
            title={onSectionClick ? `Click to edit · ${s.label}` : `${s.label} @ ${(s.time / 60 | 0)}:${(s.time % 60).toFixed(0).padStart(2, '0')}${isOptional ? ' (optional)' : ''}`}
            onClick={onSectionClick ? (e) => { e.stopPropagation(); onSectionClick(i, { x: e.clientX, y: e.clientY }); } : undefined}
          >
            {!isUnset && (
              <span className="absolute inset-x-0.5 top-0.5 text-[10px] truncate text-white/80 pointer-events-none select-none leading-none">
                {isOptional ? `○ ${s.label}` : s.label}
              </span>
            )}
          </div>
        );
      })}
      {/* Handles must be siblings (not children) of the section divs: each
          section's opacity creates a stacking context, so a handle nested
          inside section 0 was unreachable past the boundary line. */}
      {onBoundaryChange && sections.map((s, i) => {
        // Boundary i sits at sections[i].start. The leftmost boundary only
        // renders when the first section starts past t=0 — otherwise the 8px
        // handle would be half-clipped at the container edge with nowhere to
        // slide. When the user did push section 0 in from t=0 (e.g. there's
        // silence/lead-in before it), they need this handle to move its
        // start back.
        if (i === 0 && s.time <= 0.01) return null;
        const leftPct = duration > 0 ? (s.time / duration) * 100 : 0;
        return (
          <div
            key={`boundary-${i}`}
            className="absolute top-0 bottom-0 z-30 cursor-ew-resize touch-none tc-hit"
            style={{
              left: `${leftPct}%`,
              width: 8,
              transform: 'translateX(-50%)',
              background: 'rgba(255,255,255,0.18)',
            }}
            onPointerDown={(e) => startBoundaryDrag({ nextIdx: i }, e)}
            onClick={(e) => e.stopPropagation()}
            title={`Boundary @ ${(s.time / 60 | 0)}:${(s.time % 60).toFixed(1).padStart(4, '0')} · drag to reposition`}
          />
        );
      })}
      {gridProps && (
        <BeatGridOverlay {...gridProps} duration={duration} />
      )}
      <div
        className="absolute top-0 bottom-0 w-px pointer-events-none z-10"
        style={{ left: `${pct}%`, background: 'rgba(255,255,255,0.75)' }}
      />
      {pendingSelection && (
        <PendingHighlightOverlay sel={pendingSelection} duration={duration} grid={gridProps} />
      )}
    </div>
  );
}

// ─── Sparkline row ────────────────────────────────────────────────────────────

/** Stand-in for a curve that hasn't been computed yet. A module constant, not
 *  a fresh `[]` per render: the lane's paint callback is keyed on `data`, and
 *  a new array every render would repaint the whole strip for nothing. */
const EMPTY_CURVE: number[] = [];

// Max internal-buffer width before the canvas hits the browser's max-canvas
// size and renders a broken-image placeholder. At Ultra zoom the CSS width can
// exceed this, so we drop the effective dpr to keep the buffer underneath the
// limit — the sparkline appears softer but always paints.

function Sparkline({ data, color, height = 40, currentTime, duration, label, signalName, loading = false, onSeek, onRegion, onRegionDragStart, dragHandlers, onResizeStart, pendingSelection, dragCursorTime, gridProps, frameAxis: axisProp, overlay }: {
  data: number[]; color: string; height?: number;
  /** Marks drawn over the curve (SignalMarksOverlay). */
  overlay?: React.ReactNode;
  currentTime: number; duration: number; label: string;
  /** What the SIGNALS dropdown calls this curve, when the lane's own label is
   *  an abbreviation of it. The empty state quotes the dropdown's wording, so
   *  the line answers the tick the reader just made. */
  signalName?: string;
  /** The analysis these samples come from is still being computed. Keeps the
   *  lane on screen saying so, rather than letting a ticked signal read as a
   *  control the app ignored. */
  loading?: boolean;
  /** Time axis of `data`. When absent the curve falls back to spreading the
   *  samples evenly across the width (the old, ~23 ms-skewed behaviour). */
  frameAxis?: FrameAxis;
  onSeek?: (t: number) => void;
  onRegion?: (t1: number, t2: number) => void;
  onRegionDragStart?: () => void;
  dragHandlers?: RowDragHandlers;
  onResizeStart?: (e: React.PointerEvent) => void;
  /** Pending Mark In/Out highlight — an in-progress two-step selection stays
   *  visible across every row. */
  pendingSelection?: PendingSelection | null;
  /** Mirrors an in-flight grid-segment head drag onto this row. */
  dragCursorTime?: number | null;
  gridProps?: GridProps;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const h = height;
  // The axis is handed down with the shared frame count; pin it to THIS row's
  // own array so a curve of a different length can't index past its end.
  const axis = useMemo<FrameAxis | undefined>(
    () => (axisProp ? { ...axisProp, count: data.length } : undefined),
    [axisProp, data.length],
  );

  // One tile's slice of the curve. Columns are DEVICE pixels of the whole
  // strip, so zooming in resolves more of the analysis instead of stretching a
  // clamped buffer — the row used to cap its horizontal resolution at 32 000
  // px for the entire track and soften from there.
  const paint = useCallback((ctx: CanvasRenderingContext2D, tile: TileGeom) => {
    if (!data.length) return;
    const totalCols = Math.max(1, Math.round(tile.totalW * tile.dpr));
    const H = Math.max(1, Math.round(tile.h * tile.dpr));
    const colOffset = Math.round(tile.x0 * tile.dpr);
    const colCount = Math.max(1, Math.round(tile.w * tile.dpr));
    const pad = 2 * tile.dpr;
    const usable = H - 2 * pad;

    ctx.clearRect(0, 0, colCount, H);
    ctx.strokeStyle = color;
    ctx.lineWidth = tile.dpr;
    ctx.lineJoin = 'round';
    ctx.beginPath();

    const n = data.length;
    // Sample index for pixel column x. These are analysis frames — windows,
    // not instants — so the column's time maps to the frame CENTRED there.
    // Spreading n samples evenly across the width instead draws the curve
    // ~23 ms early at the start of the track and ~12 ms late at the end,
    // which is what put these rows out of step with the waveform.
    const idxAt = (x: number) => (axis
      ? frameAtColumn(x, totalCols, duration, axis)
      : Math.floor((x / totalCols) * n));

    if (n > totalCols * 2) {
      // Start a column before the tile and end one after it, so the stroke
      // enters and leaves the canvas instead of being capped at its edges —
      // otherwise every tile boundary shows a break in the curve.
      for (let c = -1; c <= colCount; c++) {
        const gx = colOffset + c;
        const i0 = idxAt(gx);
        const i1 = Math.max(i0 + 1, Math.min(n, idxAt(gx + 1)));
        let mn = Infinity, mx = -Infinity;
        for (let i = i0; i < i1; i++) {
          const v = data[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        if (mn === Infinity) continue;
        const yHi = H - mn * usable - pad;
        const yLo = H - mx * usable - pad;
        if (c === -1) ctx.moveTo(c + 0.5, yLo);
        else ctx.lineTo(c + 0.5, yLo);
        ctx.lineTo(c + 0.5, yHi);
      }
    } else if (axis && duration > 0) {
      // Fewer samples than pixels: place each one at its own frame centre.
      // Walk one sample beyond the tile on each side so the segments that
      // cross a seam are drawn rather than clipped short.
      for (let i = 0; i < n; i++) {
        const gx = (frameCenterTime(i, axis) / duration) * totalCols;
        if (gx < colOffset - 4 * tile.dpr || gx > colOffset + colCount + 4 * tile.dpr) continue;
        const x = gx - colOffset;
        const y = H - data[i] * usable - pad;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    } else {
      for (let i = 0; i < n; i++) {
        const gx = n === 1 ? 0 : (i / (n - 1)) * (totalCols - 1);
        const x = gx - colOffset;
        const y = H - data[i] * usable - pad;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }, [data, color, axis, duration]);

  // A ticked signal always keeps its lane. Returning null here instead meant
  // the row silently disappeared whenever its curve was missing — the box
  // stayed ticked, the badge kept counting it, and nothing on screen said the
  // analysis wasn't there. Mirrors what the EQ lane has always done.
  const hasData = data.length > 0;
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  return (
    <div className="flex flex-1 min-w-0 items-stretch">
      <RowLabel text={label} dragHandlers={dragHandlers} onResizeStart={onResizeStart} />
      <div
        ref={boxRef}
        className="flex-1 relative bg-gray-950 rounded overflow-hidden"
        style={{ height }}
      >
        <TiledStrip height={h} paint={paint} />
        {!hasData && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-[11px] text-gray-500 pointer-events-none">
            {loading && (
              <svg className="animate-spin h-3.5 w-3.5 text-gray-400" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
                <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
              </svg>
            )}
            {loading ? `Computing ${signalName ?? label}…` : `No ${signalName ?? label} analysis`}
          </div>
        )}
        {gridProps && (
          <BeatGridOverlay {...gridProps} duration={duration} />
        )}
        {pendingSelection && (
          <div className="absolute inset-0 pointer-events-none">
            <PendingHighlightOverlay sel={pendingSelection} duration={duration} grid={gridProps} />
          </div>
        )}
        <SegmentDragCursorOverlay time={dragCursorTime} duration={duration} />
        {overlay}
        <div
          className="absolute top-0 bottom-0 w-px pointer-events-none"
          style={{ left: `${pct}%`, background: 'rgba(255,255,255,0.75)', boxShadow: '0 0 3px rgba(255,255,255,0.5)' }}
        />
        {onSeek && onRegion && (
          <RegionDragOverlay duration={duration} onVizClick={onSeek} onVizRegion={onRegion} onRegionDragStart={onRegionDragStart} />
        )}
      </div>
    </div>
  );
}

// ─── Segment head-drag cursor ─────────────────────────────────────────────────
// While a grid-segment head is being dragged in the lane under the waveform,
// what you are lining it up against is usually a transient on one of the signal
// rows below. This mirrors the in-flight position onto every row as a bright
// 2px line for the length of the drag. Pointer events stay off so it never
// blocks clicks / drag handles underneath.
function SegmentDragCursorOverlay({ time, duration }: {
  time?: number | null;
  duration: number;
}) {
  if (time == null || duration <= 0) return null;
  return (
    <div className="absolute inset-0 pointer-events-none z-[6]">
      <div
        className="absolute top-0 bottom-0"
        style={{ left: `${(time / duration) * 100}%`, width: 2, background: '#f8fafc' }}
      />
    </div>
  );
}

// ─── Algo timeline row ────────────────────────────────────────────────────────

/** Tiny lane badge naming the beat grid a LOOP detector aligned to. The grid
 *  is what makes loop boundaries line up with the curator's bars, so making it
 *  visible answers "why don't these loops sit on my grid?" at a glance:
 *    song-info → the curator-aligned grid (best)
 *    allin1    → auto-detected grid (no curator corrections applied)
 *    librosa   → the detector's own beat tracking (most likely to drift) */
function GridSourceBadge({ source }: { source: string }) {
  const tone: Record<string, string> = {
    'song-info': 'bg-emerald-900/50 text-emerald-300 border-emerald-700/50',
    allin1:      'bg-amber-900/50 text-amber-300 border-amber-700/50',
    librosa:     'bg-rose-900/50 text-rose-300 border-rose-700/50',
  };
  const title: Record<string, string> = {
    'song-info': 'Loops aligned to the curator-aligned grid (data/song-info) — best alignment with your bars.',
    allin1:      'Loops aligned to the auto-detected allin1 grid (no curator grid for this song).',
    librosa:     "Loops aligned to librosa's own beat tracking (no song-info or allin1 grid found) — may drift from your bars.",
  };
  return (
    <span
      title={title[source] ?? `Loop grid: ${source}`}
      className={`ml-0.5 inline-block align-middle px-1 rounded-sm text-[7px] font-semibold leading-[1.4] normal-case border ${
        tone[source] ?? 'bg-slate-800/60 text-slate-300 border-slate-600/50'
      }`}
    >
      {source}
    </span>
  );
}

function AlgoTimelineRow({ sections, duration, currentTime, label, labelColor, renderKind = 'boundary', dragHandlers, onResizeStart, sectionColorOverrides, boundaryColoringMode, gridProps, focusedSectionIdx, onSectionClick, info, infoId, gridSource, onSelect, isSelected, onCopyToManual, existingCopyCount = 0, onToggleMergeMember, isMergeMember = false }: {
  sections: { time: number; endTime: number; label: string; type: string; color?: string; velocity?: number; levelDb?: number }[];
  duration: number; currentTime: number; label: string;
  labelColor?: string;
  /** Model reference card behind an inline ⓘ at the end of the lane name. */
  info?: AlgoLaneInfo;
  /** Stable id for the ⓘ popover (the overlay row id). */
  infoId?: string;
  /** LOOP-family only: beat grid the detector aligned to — small lane badge. */
  gridSource?: string | null;
  /** Drives the per-section shape: contiguous blocks ('boundary'), translucent
   *  bands ('span'), or thin centred ticks ('point'). Defaults to 'boundary'. */
  renderKind?: AlgoRenderKind;
  dragHandlers?: RowDragHandlers;
  onResizeStart?: (e: React.PointerEvent) => void;
  sectionColorOverrides?: Record<string, string>;
  boundaryColoringMode?: BoundaryColoringMode;
  gridProps?: GridProps;
  /** Index of the section whose popover is currently open — gets a brighter outline. */
  focusedSectionIdx?: number | null;
  /** Click a block to open the read-only output card. */
  onSectionClick?: (sectionIdx: number, anchor: { x: number; y: number }) => void;
  /** Click the lane label to select/highlight this row. */
  onSelect?: () => void;
  isSelected?: boolean;
  /** Copy this algo row into a new editable manual layer. Shown only when selected. */
  onCopyToManual?: () => void;
  existingCopyCount?: number;
  /** Boundary rows only: add/remove this lane from the Merge row's blend.
   *  Undefined on span/point rows — there is nothing to reconcile there. */
  onToggleMergeMember?: () => void;
  /** This lane is already in the merge — its ⊕ shows filled, and the
   *  affordance strip stays up even when the lane isn't the selected one, so
   *  the merge's members are identifiable at a glance. */
  isMergeMember?: boolean;
}) {
  // For span/point rows the per-section `type` is content-derived (a chord
  // name, a note pitch, an event class…) and never matches SECTION_COLORS, so
  // it would fall through to the near-invisible slate-400 default. Use the
  // row's algo color as the base instead so these rows read as "their" hue.
  const baseColor = labelColor ?? sectionBg('default');
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  // ⓘ provenance popover — what model produced this lane, what it extracts, and
  // its input / output. Same control + placement as the curated lanes' ⓘ.
  const infoPop = useAnnotationPopover({ width: 330, height: 280 });
  const infoKey = infoId ?? label;
  const infoOpen = !!info && infoPop.open?.layerId === infoKey;
  const accent = labelColor ?? '#94a3b8';
  // Affordance strip on the selected lane only — see LayerRowLabel. A merge
  // member keeps its strip up unselected too: the ⊕ is how you see that this
  // lane is feeding the Merge row, and how you take it back out.
  const hasIcons = (!!isSelected && (!!info || !!gridSource || !!onCopyToManual || !!onToggleMergeMember)) || isMergeMember;
  const { cellRef, nameRef, bodyClass, iconsClass, nameStyle, minHeight } = useLabelFit(hasIcons, label);
  return (
    <>
    <div className="flex flex-1 min-w-0 items-stretch">
      <div
        ref={cellRef}
        className={`${STICKY_LABEL_CELL} transition-colors ${dragHandlers ? 'cursor-grab active:cursor-grabbing' : ''} ${onSelect ? 'hover:bg-[#161a21]' : ''}`}
        data-label={label}
        data-short={shortRowName(label)}
        style={isSelected ? {
          color: accent,
          minHeight,
          background: `linear-gradient(90deg, ${accent}22 0%, #0a0b0d 100%), #0a0b0d`,
          boxShadow: `inset 3px 0 0 0 ${accent}, inset -1px 0 0 0 ${accent}66`,
        } : { minHeight, color: accent }}
        draggable={dragHandlers?.draggable}
        onDragStart={dragHandlers?.onDragStart}
        onDragEnd={dragHandlers?.onDragEnd}
        onClick={onSelect}
        onKeyDown={onSelect ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } } : undefined}
        role={onSelect ? 'button' : undefined}
        tabIndex={onSelect ? 0 : undefined}
        title={onSelect && dragHandlers
          ? `${label} — click to highlight · drag to reorder`
          : onSelect ? `${label} — click to highlight this row`
          : (dragHandlers ? 'Drag to reorder' : label)}
      >
        <div
          className={bodyClass}
          style={{ color: labelColor ?? undefined, textShadow: isSelected ? `0 0 6px ${accent}cc, 0 0 12px ${accent}66` : undefined }}
        >
          <span
            ref={nameRef}
            className={`text-[12px] tracking-wide text-center leading-tight min-w-0 max-w-full ${isSelected ? 'font-bold' : ''}`}
            style={nameStyle}
          >{label}</span>
          {hasIcons && (
          <span className={iconsClass}>
            {info && (
              <button
                type="button"
                aria-label={`${label} — show model details`}
                title="What is this algorithm?"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (infoOpen) { infoPop.close(); return; }
                  const r = e.currentTarget.getBoundingClientRect();
                  infoPop.openAt(infoKey, 'info', { x: r.right, y: r.top });
                }}
                className={`ml-0.5 inline-flex items-center justify-center align-middle w-2.5 h-2.5 rounded-full text-[7px] font-bold leading-none transition-colors ${
                  infoOpen ? 'text-[#0a0b0d]' : 'text-gray-500 hover:text-gray-200'
                }`}
                style={infoOpen ? { background: accent } : { border: '1px solid currentColor' }}
              >
                i
              </button>
            )}
            {gridSource && <GridSourceBadge source={gridSource} />}
            {onCopyToManual && (
              <button
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onCopyToManual(); }}
                title={(existingCopyCount ?? 0) > 0
                  ? `Copy to manual layer — ${existingCopyCount} existing ${existingCopyCount === 1 ? 'copy' : 'copies'}`
                  : `Copy "${label}" to a new editable manual layer`}
                className={`ml-0.5 inline-flex items-center justify-center align-middle w-3.5 h-3.5 rounded text-[9px] leading-none transition-all ${
                  isSelected || (existingCopyCount ?? 0) > 0
                    ? (existingCopyCount ?? 0) > 0
                      ? 'opacity-100 text-amber-300 hover:text-amber-100 hover:bg-amber-500/25'
                      : 'opacity-100 text-emerald-300 hover:text-emerald-100 hover:bg-emerald-500/20'
                    : 'opacity-0 pointer-events-none'
                }`}
              >
                ⬇
              </button>
            )}
            {/* ⊕ / ⊖ merge membership. The click-based twin of dragging this
                lane onto the Merge row — same effect, for when the lane you
                want is already selected and a drag would be fussier. */}
            {onToggleMergeMember && (
              <button
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onToggleMergeMember(); }}
                title={isMergeMember
                  ? `Remove "${label}" from the merge`
                  : `Add "${label}" to the merge — blend its boundaries with the other lanes you pick`}
                className={`ml-0.5 inline-flex items-center justify-center align-middle w-3.5 h-3.5 rounded text-[10px] leading-none transition-all ${
                  isMergeMember
                    ? 'text-violet-200 bg-violet-500/30 hover:bg-violet-500/50'
                    : 'text-violet-300/70 hover:text-violet-100 hover:bg-violet-500/20'
                }`}
              >
                {isMergeMember ? '⊖' : '⊕'}
              </button>
            )}
          </span>
          )}
        </div>
        <LabelResizeHandle onResizeStart={onResizeStart} />
      </div>
      <div className="flex-1 relative h-5 rounded overflow-hidden bg-gray-950">
        {sections.map((s, i) => {
          const left  = (s.time / duration) * 100;
          const isFocused = focusedSectionIdx === i;
          const onClick = onSectionClick
            ? (e: React.MouseEvent) => { e.stopPropagation(); onSectionClick(i, { x: e.clientX, y: e.clientY }); }
            : undefined;
          const title = onSectionClick ? `Click to view output · ${s.label || s.type}` : (s.label || s.type);

          // ── Point ticks (onsets / key / chords) — half-transparent colored
          //    cue-style markers centred on the event time. ──
          if (renderKind === 'point') {
            const color = s.color ?? baseColor;
            // A drum hit's tick stands as tall as it was struck: velocity
            // 127 fills the lane, a ghost note is a stub at the bottom. The
            // 20% floor keeps the softest hit visible and clickable.
            const hasVelocity = typeof s.velocity === 'number';
            const tickHeight = hasVelocity
              ? `${Math.max(20, (s.velocity! / 127) * 100)}%`
              : '100%';
            const tickTitle = hasVelocity
              ? (onSectionClick ? `Click to view output · ${drumHitTitle(s)}` : drumHitTitle(s))
              : title;
            return (
              <button key={i}
                className={`absolute top-0 bottom-0 w-2 flex ${hasVelocity ? 'items-end' : 'items-stretch'} justify-center group/algotick ${onSectionClick ? 'cursor-pointer' : 'cursor-default'}`}
                style={{ left: `${left}%`, transform: 'translateX(-50%)' }}
                onClick={onClick}
                title={tickTitle}
              >
                <span
                  className="block w-[3px] rounded-sm transition-all group-hover/algotick:w-1.5"
                  style={{
                    height: tickHeight,
                    background: color,
                    opacity: isFocused ? 1 : 0.7,
                    boxShadow: isFocused ? `0 0 10px ${color}, 0 0 3px ${color}` : `0 0 5px ${color}aa, 0 0 1px ${color}`,
                  }}
                />
              </button>
            );
          }

          // ── Span bands (voicing / loops / notes / events / lyrics) —
          //    translucent colored intervals, like the span annotation markers. ──
          if (renderKind === 'span') {
            const color = s.color ?? baseColor;
            const width = Math.max(0.3, ((s.endTime - s.time) / duration) * 100);
            return (
              <div key={i}
                className={`absolute top-0 bottom-0 rounded-[2px] overflow-hidden ${onSectionClick ? 'cursor-pointer hover:brightness-125' : ''}`}
                style={{
                  left: `${left}%`, width: `${width}%`,
                  background: `${color}55`,
                  boxShadow: isFocused
                    ? `inset 0 0 0 1px ${color}, 0 0 6px ${color}66`
                    : `inset 0 0 0 1px ${color}88`,
                }}
                onClick={onClick}
                title={title}
              >
                <span className="absolute inset-x-0.5 top-0 text-[10px] truncate text-white/80 pointer-events-none select-none leading-tight">
                  {s.label}
                </span>
              </div>
            );
          }

          // ── Boundary blocks (MSAF / ruptures / allin1 / custom) — contiguous
          //    labeled section tiling. ──
          const width = Math.max(0.3, ((s.endTime - s.time) / duration) * 100);
          return (
            <div key={i}
              className={`absolute top-0 bottom-0 ${onSectionClick ? 'cursor-pointer hover:ring-1 hover:ring-white/40' : ''}`}
              style={{
                left: `${left}%`, width: `${width}%`,
                background: boundaryColoringMode === 'alternating'
                  ? ALTERNATING_PALETTE[i % ALTERNATING_PALETTE.length]
                  : (s.color ?? sectionColorOverrides?.[s.type] ?? sectionBg(s.type)),
                opacity: isFocused ? 1 : 0.78,
                borderRight: '1px solid rgba(0,0,0,0.5)',
                boxShadow: isFocused
                  ? 'inset 0 0 0 1px rgba(255,255,255,0.65), 0 0 6px rgba(255,255,255,0.25)'
                  : 'inset 0 0 0 1px rgba(255,255,255,0.22)',
              }}
              onClick={onClick}
              title={title}
            />
          );
        })}
        {gridProps && (
          <BeatGridOverlay {...gridProps} duration={duration} />
        )}
        <div className="absolute top-0 bottom-0 w-px pointer-events-none" style={{ left: `${pct}%`, background: 'rgba(255,255,255,0.75)' }} />
      </div>
    </div>
    {info && infoOpen && (
      <div
        ref={infoPop.popoverRef}
        style={infoPop.positionStyle}
        className="z-50 w-[330px] rounded-md border border-gray-700 bg-[#0d0f13] p-3.5 shadow-xl text-left"
      >
        <div className="flex items-start gap-2 mb-2.5">
          <span className="mt-1 w-3 h-3 rounded-full shrink-0" style={{ background: accent }} />
          <span className="text-[15px] font-semibold text-gray-100 leading-snug normal-case">{label}</span>
        </div>
        <dl className="text-[13px] leading-snug space-y-2 normal-case">
          <div className="flex gap-2">
            <dt className="text-gray-500 w-[72px] shrink-0">Model</dt>
            <dd className="text-gray-200">{info.model}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-gray-500 w-[72px] shrink-0">Extracts</dt>
            <dd className="text-gray-200">{info.extracts}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-gray-500 w-[72px] shrink-0">Input</dt>
            <dd className="text-gray-200">{info.input}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-gray-500 w-[72px] shrink-0">Output</dt>
            <dd className="text-gray-200">{info.output}</dd>
          </div>
        </dl>
      </div>
    )}
    </>
  );
}

// ─── Merge lane ───────────────────────────────────────────────────────────────
//
// The blend of several boundary algo lanes, drawn where the lanes it blends
// are. Empty, it is a drop target: drag any boundary lane's name onto it (or
// press the ⊕ on the lane's own affordance strip) to add that lane to the mix.
// Filled, it draws the reconciled boundaries as a tiling, each block labeled
// with how many member lanes agreed on its start.
//
// Every boundary every member found is on the lane, so a block is colored by
// the lane that FOUND it — the union's useful question is "who heard this?",
// not "how many agreed", and the answer reads straight off the strip against
// the member chips below. Where two lanes named the same instant the block
// carries a ×N badge and the first member's color.
//
// A boundary the annotator drops by hand is not discarded — it stays on the
// lane as a dim ghost tick, one click from coming back. See boundaryMerge.ts.

function MergeLaneRow({
  merged, memberLanes, duration, currentTime,
  dragHandlers, onResizeStart, gridProps,
  isDropTarget, onToggleBoundary,
}: {
  merged: MergedBoundary[];
  memberLanes: MergeSourceLane[];
  duration: number;
  currentTime: number;
  dragHandlers?: RowDragHandlers;
  onResizeStart?: (e: React.PointerEvent) => void;
  gridProps?: GridProps;
  /** A lane is being dragged over this row right now. */
  isDropTarget?: boolean;
  /** Drop one merged boundary by hand, or put a dropped one back. */
  onToggleBoundary?: (b: MergedBoundary) => void;
}) {
  const accent = memberLanes.length > 0 ? '#c084fc' : '#4b5563';
  const label = memberLanes.length > 0 ? `Merge ×${memberLanes.length}` : 'Merge';
  const { cellRef, nameRef, bodyClass, nameStyle, minHeight } = useLabelFit(false, label);
  const kept = merged.filter((b) => b.kept);
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const laneName = (id: string) => memberLanes.find((l) => l.id === id)?.label ?? id;
  const laneColor = (id: string) => memberLanes.find((l) => l.id === id)?.color ?? '#94a3b8';

  return (
    <div className="flex flex-1 min-w-0 items-stretch">
      <div
        ref={cellRef}
        className={`${STICKY_LABEL_CELL} transition-colors ${dragHandlers ? 'cursor-grab active:cursor-grabbing' : ''}`}
        data-label={label}
        data-short={shortRowName(label)}
        style={{
          color: accent,
          minHeight,
          background: `linear-gradient(90deg, ${accent}22 0%, #0a0b0d 100%), #0a0b0d`,
          boxShadow: isDropTarget
            ? `inset 3px 0 0 0 ${accent}, inset 0 0 0 1px ${accent}aa`
            : `inset 3px 0 0 0 ${accent}88`,
        }}
        draggable={dragHandlers?.draggable}
        onDragStart={dragHandlers?.onDragStart}
        onDragEnd={dragHandlers?.onDragEnd}
        title={memberLanes.length > 0
          ? `Merged from ${memberLanes.map((l) => l.label).join(', ')} — drag another boundary lane here to add it`
          : 'Drag a boundary lane onto this row to start a merge'}
      >
        <div className={bodyClass} style={{ color: accent }}>
          <span
            ref={nameRef}
            className="text-[12px] tracking-wide text-center leading-tight min-w-0 max-w-full font-bold"
            style={nameStyle}
          >{label}</span>
        </div>
        <LabelResizeHandle onResizeStart={onResizeStart} />
      </div>
      <div
        className={`flex-1 relative h-5 rounded overflow-hidden transition-colors ${
          isDropTarget ? 'bg-violet-500/20 ring-1 ring-violet-400/60' : 'bg-gray-950'
        }`}
      >
        {memberLanes.length === 0 ? (
          <div className="absolute inset-0 flex items-center px-2 pointer-events-none">
            <span className="text-[10px] text-gray-600 italic">
              {isDropTarget
                ? 'drop to add this lane to the merge'
                : 'drag a boundary lane’s name here — or press ⊕ on a selected lane — to blend several detectors'}
            </span>
          </div>
        ) : (
          <>
            {/* Kept boundaries as a tiling: each block runs to the next kept
                boundary, so the lane reads as a structure like every other
                boundary lane rather than as a scatter of marks. */}
            {kept.map((b, i) => {
              const end = kept[i + 1]?.time ?? duration;
              const left = (b.time / duration) * 100;
              const width = Math.max(0.3, ((end - b.time) / duration) * 100);
              const color = laneColor(b.laneIds[0]);
              return (
                <div
                  key={`k${b.time}`}
                  className="absolute top-0 bottom-0 cursor-pointer hover:ring-1 hover:ring-white/50"
                  style={{
                    left: `${left}%`, width: `${width}%`,
                    background: color,
                    opacity: 0.78,
                    borderRight: '1px solid rgba(0,0,0,0.5)',
                    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.22)',
                  }}
                  onClick={(e) => { e.stopPropagation(); onToggleBoundary?.(b); }}
                  title={`${b.laneIds.map(laneName).join(', ')}\nClick to drop this boundary from the merge`}
                >
                  {/* Only worth a badge when more than one lane landed here —
                      in a union "×1" is every block, which is no information. */}
                  {b.agreement > 1 && (
                    <span className="absolute left-0.5 top-0 text-[9px] leading-tight text-black/70 font-mono pointer-events-none select-none">
                      ×{b.agreement}
                    </span>
                  )}
                </div>
              );
            })}
            {/* Ghosts — the boundaries the annotator dropped by hand. Kept on
                the lane because they are one click from coming back, so they
                have to be seeable: a hairline loses to the beat grid it sits
                under, so each ghost is a 2px bar with a cap on the lane's top
                edge that survives being drawn over a block. */}
            {merged.filter((b) => !b.kept).map((b) => {
              const color = '#f87171';
              return (
                <button
                  key={`g${b.time}`}
                  type="button"
                  className="absolute top-0 bottom-0 w-2 flex items-stretch justify-center group/mergeghost"
                  style={{ left: `${(b.time / duration) * 100}%`, transform: 'translateX(-50%)' }}
                  onClick={(e) => { e.stopPropagation(); onToggleBoundary?.(b); }}
                  title={`Dropped by hand\n${b.laneIds.map(laneName).join(', ')}\nClick to put this boundary back`}
                >
                  <span
                    className="block w-[2px] h-full opacity-60 transition-all group-hover/mergeghost:w-[4px] group-hover/mergeghost:opacity-100"
                    style={{
                      background: `repeating-linear-gradient(${color} 0 3px, transparent 3px 6px)`,
                      boxShadow: '0 0 2px rgba(0,0,0,0.9)',
                    }}
                  />
                  <span
                    className="absolute top-0 left-1/2 -translate-x-1/2 w-[6px] h-[3px] rounded-b-sm opacity-80 transition-opacity group-hover/mergeghost:opacity-100"
                    style={{ background: color }}
                  />
                </button>
              );
            })}
            {kept.length === 0 && (
              <div className="absolute inset-0 flex items-center px-2 pointer-events-none">
                <span className="text-[10px] text-gray-600 italic">
                  every boundary dropped by hand — click a ghost to put one back
                </span>
              </div>
            )}
          </>
        )}
        {gridProps && (
          <BeatGridOverlay {...gridProps} duration={duration} />
        )}
        <div className="absolute top-0 bottom-0 w-px pointer-events-none" style={{ left: `${pct}%`, background: 'rgba(255,255,255,0.75)' }} />
      </div>
    </div>
  );
}


// ─── Consensus lane ──────────────────────────────────────────────────────────
// The Algorithm-Inspect stage blends every checked detector into one consensus
// boundary set and scores it against the reference. Its knobs stay down in the
// stage panel, but the RESULT belongs on the timeline: a "miss" is only
// readable next to the detector lanes it was blended from and the boundary
// lane it was scored against — half a bar out and a genuine disagreement look
// identical in a strip of its own. Same split the Merge row makes: lane up
// here, controls below.

const CONSENSUS_HIT_COLOR     = '#22c55e';
const CONSENSUS_MISS_COLOR    = '#ef4444';
const CONSENSUS_NEUTRAL_COLOR = '#8b5cf6';

/** One consensus tile, as the Algorithm-Inspect stage computes it: it runs to
 *  the next consensus boundary and carries that boundary's verdict. `type` is
 *  'hit' / 'miss', or 'consensus' when there is no reference to score against. */
export interface ConsensusBlock {
  time: number;
  endTime: number;
  /** One-glyph verdict drawn in the tile: ✓ / ✗ / C. */
  label: string;
  type: string;
}

function ConsensusLaneRow({
  blocks, refMisses, duration, currentTime,
  referenceLabel, tolerance,
  dragHandlers, onResizeStart, gridProps, onSeek, onHide, onCopy, existingCopyCount = 0,
}: {
  blocks: ConsensusBlock[];
  /** Reference boundaries the consensus never matched (FN), as ticks. */
  refMisses?: number[];
  duration: number;
  currentTime: number;
  referenceLabel?: string;
  tolerance?: number;
  dragHandlers?: RowDragHandlers;
  onResizeStart?: (e: React.PointerEvent) => void;
  gridProps?: GridProps;
  onSeek?: (time: number) => void;
  /** Take the lane off the timeline. The checkbox that puts it back lives in
   *  Algos ▾ under Consensus, so the ✕ says so rather than stranding the user
   *  with a row they can hide but not recover. */
  onHide?: () => void;
  /** Write the blend into a boundary layer the annotator owns — the same ⬇
   *  the detector and algorithm lanes carry, and the reason the lane can be
   *  read as a proposal rather than a dead end. */
  onCopy?: () => void;
  /** How many layers this consensus has already been copied into. */
  existingCopyCount?: number;
}) {
  const accent = CONSENSUS_NEUTRAL_COLOR;
  // Just the name. "×28" would read as a member count next to Merge's "×2",
  // and the boundary tally is already stated by the stage that built it.
  const label = 'Consensus';
  const hasIcons = !!onHide || !!onCopy;
  const { cellRef, nameRef, bodyClass, iconsClass, nameStyle, minHeight } = useLabelFit(hasIcons, label);
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const hits = blocks.filter((b) => b.type === 'hit').length;
  const scored = blocks.some((b) => b.type === 'hit' || b.type === 'miss');

  return (
    <div className="flex flex-1 min-w-0 items-stretch">
      <div
        ref={cellRef}
        className={`${STICKY_LABEL_CELL} transition-colors ${dragHandlers ? 'cursor-grab active:cursor-grabbing' : ''}`}
        data-label={label}
        data-short={shortRowName(label)}
        style={{
          color: accent,
          minHeight,
          background: `linear-gradient(90deg, ${accent}22 0%, #0a0b0d 100%), #0a0b0d`,
          boxShadow: `inset 3px 0 0 0 ${accent}88`,
        }}
        draggable={dragHandlers?.draggable}
        onDragStart={dragHandlers?.onDragStart}
        onDragEnd={dragHandlers?.onDragEnd}
        title={scored
          ? `Auto-consensus — ${hits}/${blocks.length} boundaries matched ${referenceLabel ?? 'the reference'} within ±${tolerance ?? 0}s. Tune it under Consensus Inspect.`
          : `Auto-consensus — ${blocks.length} boundaries. Tune it under Consensus Inspect.`}
      >
        <div className={bodyClass} style={{ color: accent }}>
          <span
            ref={nameRef}
            className="text-[12px] tracking-wide text-center leading-tight min-w-0 max-w-full font-bold"
            style={nameStyle}
          >{label}</span>
          {/* The lane has no layer row in the sidebar and no items to edit, so
              everything you can do to it has to live here: ⬇ takes the blend
              into a layer you own, ✕ takes the row off the timeline. Both name
              where they lead — the copy lands in a boundary layer, and the
              checkbox that undoes the hide is one level into Algos ▾. */}
          {hasIcons && (
            <span className={iconsClass}>
              {onCopy && (
                <button
                  type="button"
                  aria-label="Copy the consensus into a boundary layer"
                  title={existingCopyCount > 0
                    ? `Copy the consensus into a new boundary layer you can edit — ${existingCopyCount} existing ${existingCopyCount === 1 ? 'copy' : 'copies'}`
                    : 'Copy the consensus into a new boundary layer you can edit. The blend itself stays read-only; the copy is yours, and its sections start untyped.'}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onCopy(); }}
                  className={`inline-flex items-center justify-center align-middle w-3.5 h-3.5 rounded text-[9px] leading-none transition-colors ${
                    existingCopyCount > 0
                      ? 'text-amber-300 hover:text-amber-100 hover:bg-amber-500/25'
                      : 'text-emerald-300/80 hover:text-emerald-100 hover:bg-emerald-500/20'
                  }`}
                >
                  ⬇
                </button>
              )}
              {onHide && (
                <button
                  type="button"
                  aria-label="Hide the Consensus lane"
                  title="Hide the Consensus lane — bring it back under Algos ▾ → Consensus"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onHide(); }}
                  className="ml-0.5 inline-flex items-center justify-center align-middle w-3.5 h-3.5 rounded text-[10px] leading-none transition-colors text-violet-300/70 hover:text-violet-100 hover:bg-violet-500/25"
                >
                  ✕
                </button>
              )}
            </span>
          )}
        </div>
        <LabelResizeHandle onResizeStart={onResizeStart} />
      </div>
      <div className="flex-1 relative h-5 rounded overflow-hidden bg-gray-950">
        {blocks.map((b, i) => {
          const left  = duration > 0 ? (b.time / duration) * 100 : 0;
          const width = Math.max(0.3, duration > 0 ? ((b.endTime - b.time) / duration) * 100 : 0);
          const isStatus = b.type === 'hit' || b.type === 'miss';
          const bg = b.type === 'hit' ? CONSENSUS_HIT_COLOR
            : b.type === 'miss' ? CONSENSUS_MISS_COLOR
            : CONSENSUS_NEUTRAL_COLOR;
          return (
            <div
              key={`${b.time}-${i}`}
              className={`absolute top-0 bottom-0 overflow-hidden ${onSeek ? 'cursor-pointer hover:ring-1 hover:ring-white/50' : ''}`}
              style={{
                left: `${left}%`, width: `${width}%`, background: bg,
                opacity: isStatus ? 0.85 : 0.62,
                borderRight: '1px solid rgba(0,0,0,0.3)',
              }}
              onClick={onSeek ? (e) => { e.stopPropagation(); onSeek(b.time); } : undefined}
              title={`${b.type === 'hit' ? '✓ matched' : b.type === 'miss' ? `✗ no ${referenceLabel ?? 'reference'} boundary within ±${tolerance ?? 0}s` : 'consensus boundary'} @ ${b.time.toFixed(2)}s`}
            >
              <span className={`absolute inset-x-0.5 top-0.5 truncate pointer-events-none select-none leading-none ${isStatus ? 'text-[9px] text-white font-bold' : 'text-[7px] text-white/70'}`}>
                {b.label}
              </span>
            </div>
          );
        })}
        {/* Reference boundaries the consensus never proposed. They have no tile
            of their own — the whole point is that nothing is here — so they ride
            the lane's top edge as a tick at the time the consensus should have
            fired. */}
        {duration > 0 && (refMisses ?? []).map((t) => (
          <div
            key={`fn${t}`}
            className="absolute top-0 pointer-events-auto"
            style={{
              left: `${(t / duration) * 100}%`,
              height: '5px', width: '5px',
              background: CONSENSUS_MISS_COLOR,
              transform: 'translateX(-2px)',
              zIndex: 5,
              boxShadow: `0 0 3px ${CONSENSUS_MISS_COLOR}`,
              borderBottomLeftRadius: '1px',
              borderBottomRightRadius: '1px',
            }}
            title={`✗ ${referenceLabel ?? 'reference'} boundary missed by consensus @ ${t.toFixed(2)}s`}
          />
        ))}
        {gridProps && (
          <BeatGridOverlay {...gridProps} duration={duration} />
        )}
        <div className="absolute top-0 bottom-0 w-px pointer-events-none" style={{ left: `${pct}%`, background: 'rgba(255,255,255,0.75)' }} />
      </div>
    </div>
  );
}

// ─── Spectrogram interactive overlay ─────────────────────────────────────────

function SpectrogramDragOverlay({
  duration, currentTime,
  pendingSelection,
  onVizClick, onVizRegion, onRegionDragStart,
  snapToGrid, snapDivision, snapTimeOverride,
  bpm, beatOffset, beatsPerBar, beatOverrides,
}: {
  duration: number; currentTime: number;
  pendingSelection?: PendingSelection | null;
  onVizClick: (t: number) => void;
  onVizRegion: (t1: number, t2: number) => void;
  onRegionDragStart?: () => void;
  snapToGrid?: boolean;
  /** Snap division to use when snapToGrid is on. Defaults to 'beat'. */
  snapDivision?: SnapDivision;
  /** Replaces the snap entirely — see FrequencyWaveform's prop of the same name. */
  snapTimeOverride?: (t: number) => number;
  bpm?: number;
  beatOffset?: number;
  beatsPerBar?: number;
  beatOverrides?: Readonly<Record<string, number>>;
}) {
  const snap = (t: number) => {
    if (snapTimeOverride) return snapTimeOverride(t);
    if (!snapToGrid || !bpm || bpm <= 0) return t;
    return snapTimeToGrid(t, bpm, beatOffset ?? 0, beatsPerBar ?? 4, snapDivision ?? 'beat', beatOverrides);
  };
  // Same gesture as RegionDragOverlay — useRegionSelectDrag tracks on the
  // document, so a drag that leaves the spectrogram keeps painting, and it is
  // pointer-driven, so a finger can paint one too. A plain click only seeks:
  // the teal selection box appears once the drag passes the 6px threshold,
  // and a range commits only past 0.1s.
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const drag = useRegionSelectDrag({
    containerRef: surfaceRef,
    durationGetter: () => duration,
    transform: snap,
    onDragStart: onRegionDragStart,
    onClick: onVizClick,
    onRegion: (t1, t2) => onVizRegion(t1, t2),
  });
  const dragSel = drag.preview;

  return (
    <div
      ref={surfaceRef}
      className="absolute inset-0 touch-pan-y"
      style={{ cursor: 'crosshair' }}
      onPointerDown={drag.onPointerDown}
    >
      <AnnotationOverlays
        duration={duration}
        currentTime={currentTime}
        isPlaying={false}
        pendingSelection={pendingSelection}
        grid={bpm ? { bpm, gridOffset: beatOffset, beatsPerBar } : undefined}
      />
      {dragSel && duration > 0 && (
        <div className="absolute top-0 bottom-0 pointer-events-none z-25"
          style={{
            left: `${(Math.min(dragSel.s, dragSel.e) / duration) * 100}%`,
            width: `${(Math.abs(dragSel.e - dragSel.s) / duration) * 100}%`,
            minWidth: 1,
            background: 'rgba(45,212,191,0.13)',
            borderLeft: '2px solid rgba(45,212,191,0.7)',
            borderRight: Math.abs(dragSel.e - dragSel.s) > 0.1 ? '2px solid rgba(45,212,191,0.7)' : 'none',
          }}
        />
      )}
    </div>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

// All grid resolutions are expressed *relative to the beat* (where 1 beat =
// 60 / BPM seconds). This sidesteps the time-signature-denominator ambiguity:
// in 6/8 the "beat" the BPM counts is an 8th note, so "1/2 beat" is a 16th —
// the labels stay honest regardless of meter.
//   '32nd'          = 1/8 of a beat  (= 32nd note in 4/4)
//   '16th-triplet'  = 1/6 of a beat  (= 16th triplet, 6 per beat)
//   '16th'          = 1/4 of a beat  (= 16th note in 4/4)
//   '8th-triplet'   = 1/3 of a beat  (= 8th triplet, 3 per beat)
//   '8th'           = 1/2 of a beat  (= 8th note in 4/4)
//   'beat'          = 1 beat
//   'compound-beat' = 3 beats (the "felt" pulse in 6/8, 9/8, 12/8)
//   'bar' .. '16bar'= 1, 2, 4, 8, 16 bars
export const BEAT_GRID_UNIT_OPTIONS = [
  '32nd', '16th-triplet', '16th', '8th-triplet', '8th',
  'beat', 'compound-beat',
  'bar', '2bar', '4bar', '8bar', '16bar',
] as const;
export type BeatGridUnit = typeof BEAT_GRID_UNIT_OPTIONS[number];

/** How an algo overlay row is drawn. 'boundary' tiles the track into contiguous
 *  labeled section blocks (MSAF / ruptures / allin1 / custom-boundary). 'span'
 *  draws each section as a translucent colored band (voicing / loops / notes /
 *  events / lyrics). 'point' draws each section as a thin colored tick centred
 *  on its start time (onsets / key / chords) — like cue markers. */
export type AlgoRenderKind = 'boundary' | 'span' | 'point';

/** Reference card shown behind the ⓘ on an algo lane — what the model is, what
 *  it extracts, and its input / output. Mirrors the curated layers' ⓘ. */
export interface AlgoLaneInfo { model: string; extracts: string; input: string; output: string; }

export interface AlgoOverlay {
  id: string;
  label: string;
  labelColor?: string;
  /** Defaults to 'boundary' when unset. */
  renderKind?: AlgoRenderKind;
  /** `raw` is the detector's original per-section JSON (energy/centroid,
   *  candidates, per-word fields, …) — surfaced as "Raw model output" in the
   *  algo Inspect card. Falls back to the mapped section when absent. */
  sections: { time: number; endTime: number; label: string; type: string; color?: string; velocity?: number; levelDb?: number; raw?: unknown }[];
  /** Optional model reference card surfaced behind an inline ⓘ on the lane. */
  info?: AlgoLaneInfo;
  /** LOOP-family only: which beat grid the detector aligned to
   *  ("song-info" | "allin1" | "librosa"). Rendered as a small lane badge. */
  gridSource?: string | null;
}

export interface MirCurves {
  energy: number[]; spectral: number[]; novelty: number[]; onsets: number[];
  /** Full spectral flux (L2 norm of frame-to-frame magnitude differences). Captures both attacks AND releases, unlike `onsets` which is half-wave rectified. */
  flux?: number[];
  /** Raw per-frame RMS (normalised 0-1) — loudness, not the `energy` composite
   *  above, which folds in bandwidth and onset strength. Whatever needs to know
   *  how long a sound LASTS has to read this one: `energy` is 35% onsets, so it
   *  spikes on attacks the same way flux does. Optional — an older cached
   *  MirCurves predates it. */
  rms?: number[];
  lowBand?: number[]; midBand?: number[]; highBand?: number[];
  frameDuration: number;
  /** Framing of the analysis run, so renderers can place a frame at its window
   *  CENTRE instead of spreading frame indices evenly across the width — see
   *  utils/frameTime. Optional so an older cached MirCurves still renders. */
  hopSize?: number;
  fftSize?: number;
  sampleRate?: number;
  /** Row-major MFCC matrix (frame × coef). Optional — only required for the cepstrogram row. */
  mfcc?: Float32Array;
  nMfcc?: number;
  /** Row-major chroma matrix (frame × 12). Optional — only required for the chromagram row. Each column already per-frame max-normalised to [0,1]. */
  chroma?: Float32Array;
  nChroma?: number;
  /** Row-major tempogram matrix (tempoFrame × nTempo). Optional — only required for the tempogram row. Each column already per-frame max-normalised to [0,1]. */
  tempogram?: Float32Array;
  nTempo?: number;
  tempogramFrameCount?: number;
  /** BPM value at each tempo row (length = nTempo). Used to draw y-axis labels. */
  tempoBpm?: Float32Array;
  /** Chroma-based self-similarity matrix. Square row-major (ssmFrameCount²). Optional — only required for the SSM row. */
  ssm?: Float32Array;
  ssmFrameCount?: number;
  frameCount?: number;
}

export interface SharedVizPanelProps {
  // Audio / player
  playerUrl: string | null;
  trackName?: string;
  audioBuffer: AudioBuffer | null;
  duration: number;
  currentTime: number;
  // Beat grid
  bpm?: number;
  /** Display-only time signature string (e.g. '4/4'). Shown next to the
   *  BPM pill in the player toolbar. Beat-grid math uses `beatsPerBar`. */
  timeSignature?: string;
  beatOffset?: number;
  beatsPerBar?: number;
  barGroupSize?: number;
  showBeatGrid?: boolean;
  beatGridUnit?: BeatGridUnit;
  /** Per-beat overrides (Manual mode). Sparse map keyed by global integer
   *  beat index → absolute timestamp in seconds. */
  beatOverrides?: Readonly<Record<string, number>>;
  /** Resolved grid segments. More than one means the song is split, and the
   *  beat grid is drawn per segment rather than from one global tempo. */
  gridSegments?: readonly import('../../utils/gridSegments').ResolvedSegment[];
  /** Show the editable grid-segment lane under the player (DataPrep only). */
  showGridSegmentLane?: boolean;
  selectedSegmentId?: string | null;
  cutLabelSegmentId?: string | null;
  onSegmentSelect?: (segment: import('../../utils/gridSegments').ResolvedSegment, anchor: { x: number; y: number }) => void;
  onSegmentHeadDrag?: (segment: import('../../utils/gridSegments').ResolvedSegment, time: number) => void;
  onDeleteGridSegment?: (segment: import('../../utils/gridSegments').ResolvedSegment) => void;
  onSplitGridAt?: (time: number) => void;
  snapSegmentTime?: (time: number, dragged: import('../../utils/gridSegments').ResolvedSegment, shiftKey: boolean) => number;
  /** Whether a plain segment-head drag snaps right now (Snap / Grid Lock). */
  segmentSnapOn?: boolean;
  /** Active grid mode. */
  gridMode?: import('../../types/songInfo').GridMode;
  /** Fired when the curator drag-drops a beat line in the manual editor.
   *  Receives the dragged beat's original time, the dropped time, and the
   *  integer beat index. Host writes the new position into
   *  `SongInfo.beatOverrides[beatIndex]`. Only used when
   *  gridMode === 'manual'. */
  onBeatDrag?: (tOrig: number, tNew: number, beatIndex: number) => void;
  /** Fired when the curator right-clicks a pinned beat in the manual
   *  editor. Host deletes the matching entry from
   *  `SongInfo.beatOverrides`. */
  onClearBeatOverride?: (beatIndex: number) => void;
  /** When true, manual-mode editing is read-only (non-admin viewer). */
  manualEditLocked?: boolean;
  /** When true (and bpm is set), drag-selections on the 3-Band waveform and Spectrogram snap to the beat grid. */
  snapToGrid?: boolean;
  /** Overrides that snap for the active layer type. Lyrics pass their layer's
   *  own SnapMode resolver here so a drag-region lands at the granularity the
   *  layer asked for rather than the global whole-beat. */
  snapTimeOverride?: (t: number) => number;
  // Marker data
  /** Every boundary layer, in document order. Each renders its own lane, and
   *  together they drive the section-colour palette. */
  boundaryLayers?: AnnotationLayer<'boundaries'>[];
  autoGuessPoints?: AutoGuessPoint[];
  pendingSelection?: PendingSelection | null;
  // Visibility
  showManual: boolean;
  showAutoGuess: boolean;
  /** Show the Prominence lane. The lane still self-hides when nothing
   *  durational is annotated; this is the user's own hide. Defaults to true. */
  showProminence?: boolean;
  showWaveform: boolean;
  showEQ?: boolean;
  showSpectrogram: boolean;
  showCepstrogram: boolean;
  showChroma: boolean;
  showTempogram: boolean;
  showSsm: boolean;
  mirCurves: MirCurves | null;
  mirComputing?: boolean;
  showEnergy: boolean;
  showBrightness: boolean;
  showNovelty: boolean;
  showOnsets: boolean;
  showFlux: boolean;
  // Algo section rows
  algoOverlays: AlgoOverlay[];
  // Interaction routing
  onVizClick: (time: number) => void;
  onVizRegion: (t1: number, t2: number) => void;
  /** Fires once when the user mousedowns to start a region drag on any row.
   *  Parents wire this to clear any committed pending highlight so it doesn't
   *  render at the same time as the in-progress drag rectangle. */
  onRegionDragStart?: () => void;
  onManualBoundaryChange?: (layerId: string, sectionIndex: number, newTime: number) => void;
  onManualBoundaryDragStart?: () => void;
  onManualSectionClick?: (layerId: string, sectionIndex: number, anchor: { x: number; y: number }) => void;
  /** Every prominence-carrying item across the annotator's layers, flattened.
   *  Drives the Lead lane, which is pure derivation — the lane renders nothing
   *  when this is empty. */
  leadCandidates?: LeadCandidate[];
  /** Hand the lead over [t0, t1] to `winnerItemId`, demoting whoever held it.
   *  `null` clears the range. Absent ⇒ the Lead lane is read-only. */
  onAssignLead?: (t0: number, t1: number, winnerItemId: string | null) => void;
  /** Put one annotation at a prominence level over a range, touching nobody
   *  else — the non-exclusive twin of `onAssignLead`. */
  onSetLevel?: (t0: number, t1: number, itemId: string, level: ProminenceLevel) => void;
  // Auto-guess callbacks
  onMarkCorrect?: (id: string) => void;
  onMarkIncorrect?: (id: string) => void;
  onMarkPending?: (id: string) => void;
  // Custom-detector annotation rows (is_annotation detectors) — one row per detector,
  // rendered with AutoGuess-style ✓/✗/@ review cards. Each row's id is `custom-annotation:<name>`.
  customAnnotationRows?: Array<{ rowId: string; detectorName: string; label: string; color: string; points: AutoGuessPoint[] }>;
  /** Detector names the user has toggled off in the Annotations dropdown. Hidden rows are skipped during render. */
  hiddenCustomAnnotations?: Set<string>;
  onCustomAnnotationMarkCorrect?: (detectorName: string, pointId: string) => void;
  onCustomAnnotationMarkIncorrect?: (detectorName: string, pointId: string) => void;
  onCustomAnnotationMarkPending?: (detectorName: string, pointId: string) => void;
  /** Per-layer review state for detector-sourced cue/span/loop layers.
   *  Keyed by layer.id, then by item.id. When a layer has an entry here, the
   *  row component renders inline ✓/✗ controls and disables edit affordances. */
  detectorLayerReview?: Record<string, Record<string, 'accepted' | 'rejected'>>;
  onDetectorLayerAccept?: (layerId: string, itemId: string) => void;
  onDetectorLayerReject?: (layerId: string, itemId: string) => void;
  /** Copy a read-only detector/algo layer to a new editable manual layer. */
  onCopyDetectorLayer?: (layer: AnnotationLayer) => void;
  /** Pre-computed count of existing manual layers already imported from each
   *  detector layer, keyed by layer.id. Used by LayerRowLabel to show the
   *  amber duplicate-count badge without an inline lookup per render. */
  detectorLayerCopyCounts?: Record<string, number>;
  /** Copy an algo overlay row (SILERO-VAD, DYNP, SF, OLDA, …) to a new
   *  editable manual layer. */
  onCopyAlgoOverlay?: (overlay: AlgoOverlay) => void;
  /** Pre-computed count of existing manual layers already imported from each
   *  algo overlay, keyed by overlay.id. */
  algoCopyCounts?: Record<string, number>;

  // ── Boundary merge (the "Merge" row) ──────────────────────────────────
  // A per-song blend of several boundary algo lanes. The page owns the member
  // list, the settings and the hand overrides; this panel owns the gestures
  // that edit them — dragging a lane onto the row, the ⊕ on a lane, and
  // clicking a merged boundary. Pass `onMergeAddLane` to enable the feature;
  // without it no Merge row is drawn and no ⊕ appears.
  /** Member lanes, in the order they were added. */
  mergeLanes?: MergeSourceLane[];
  /** Every cluster the members produced — kept and rejected alike. */
  mergeBoundaries?: MergedBoundary[];
  /** Add a boundary algo lane to the blend (drag-drop, or the lane's ⊕). */
  onMergeAddLane?: (overlayId: string) => void;
  onMergeRemoveLane?: (overlayId: string) => void;
  onMergeClear?: () => void;
  /** Flip one merged boundary between kept and dropped. */
  onMergeToggleBoundary?: (b: MergedBoundary) => void;
  onMergeRestoreDropped?: () => void;
  /** Write the kept boundaries into a new editable boundary layer. */
  onMergeCommit?: () => void;
  /** How many layers this merge has already been committed into. */
  mergeCommittedCount?: number;
  mergeCommittedNote?: string | null;

  // ── Auto-consensus (the "Consensus" row) ──────────────────────────────
  // Computed by the Algorithm-Inspect stage below the panel, drawn up here so
  // it lines up with the detector lanes it was blended from. Pass no blocks
  // and no row is drawn.
  /** Consensus boundaries, tiled and typed by their verdict against the
   *  reference. */
  consensusBlocks?: ConsensusBlock[];
  /** Reference boundaries the consensus never matched (FN). */
  consensusRefMisses?: number[];
  /** Which reference the verdicts were scored against ("Boundaries" /
   *  "Auto-guess") — tooltips only. */
  consensusReferenceLabel?: string;
  /** The ± window a match had to land in, in seconds — tooltips only. */
  consensusTolerance?: number;
  /** Take the Consensus lane off the timeline, from the lane itself. Omit and
   *  the lane's ✕ isn't drawn (the Algos ▾ checkbox still works). */
  onHideConsensus?: () => void;
  /** Copy the consensus into a new editable boundary layer. Omit and the
   *  lane's ⬇ isn't drawn. */
  onCopyConsensus?: () => void;
  /** How many boundary layers this consensus has already been copied into. */
  consensusCopyCount?: number;
  // Player refs
  seekRef: RefObject<((time: number) => void) | null>;
  playRef: RefObject<(() => void) | null>;
  pauseRef: RefObject<(() => void) | null>;
  /** Populated by the player with a reader for the live media clock. */
  getTimeRef?: RefObject<(() => number) | null>;
  /** Populated by the player with a playhead setter for the stretches where
   *  the loop-preview engine — not the media element — is sounding the audio. */
  externalTimeRef?: RefObject<((time: number | null) => void) | null>;
  wsScrollRef: RefObject<((scrollLeft: number) => void) | null>;
  zoomInRef?: RefObject<(() => void) | null>;
  zoomOutRef?: RefObject<(() => void) | null>;
  zoomResetRef?: RefObject<(() => void) | null>;
  /** What the ± zoom buttons keep centred — see [PlayerPanel docs]. The page
   *  resolves the selected annotation item / highlighted region; returning
   *  null lets the player fall back to the playhead or the viewport middle. */
  getZoomFocusTime?: () => number | null;
  /** The Prominence lane's open lead-assign range, reported so the page can use
   *  it as a zoom focus. Null once the picker closes. */
  onLeadRangeChange?: (range: { start: number; end: number } | null) => void;
  /** Prompt-free pinch zoom — see [PlayerPanel docs]. Used by the viz
   *  Ctrl/⌘+wheel handler so trackpad pinch can't auto-cross into Extended
   *  or Ultra zoom; those tiers require the toolbar + button. */
  pinchZoomInRef?: RefObject<(() => void) | null>;
  pinchZoomOutRef?: RefObject<(() => void) | null>;
  /** Scroll viewport so `time` is centered (or near-left if align='left'). */
  scrollToTimeRef?: RefObject<((time: number, align?: 'center' | 'left') => void) | null>;
  /** Zoom + scroll so [t1, t2] fills the viewport. */
  zoomToRangeRef?: RefObject<ZoomToRange | null>;
  onBufferReady: (buf: AudioBuffer) => void;
  onReady?: () => void;
  onTimeUpdate: (t: number) => void;
  onPlayingChange: (playing: boolean) => void;
  /** Playback-speed multiplier forwarded to the PlayerPanel (1 = normal). */
  playbackRate?: number;
  onScrollChange: (scrollLeft: number) => void;
  onViewChange: (zoomFactor: number, containerWidth: number, atMaxZoom: boolean) => void;
  // Viz scroll sync
  vizScrollContainerRef: RefObject<HTMLDivElement | null>;
  vizSignalWidth: number;
  /** Current player zoom multiplier (1 = fit, 2 = ×2 …). Drives the auto-guess
   *  per-point collapse/expand threshold (see autoGuessExpandZoomThreshold). */
  vizZoomFactor?: number;
  onVizScroll: () => void;
  playerIsPlaying: boolean;
  onSeekAndPlay?: (time: number, stopTime?: number) => void;
  onPause?: () => void;
  // Preview window — drag-to-listen region with movable/resizable band
  previewRegion?: PreviewRegion | null;
  onPreviewRegionChange?: (region: PreviewRegion) => void;
  onPreviewPlay?: () => void;
  onPreviewPause?: () => void;
  onPreviewDismiss?: () => void;
  /** Fired by PlayerPanel when a non-looping preview reaches its end — the
   *  pause itself already happened there, against the media clock. */
  onPreviewEnd?: () => void;
  onPreviewLoopToggle?: () => void;
  /** True while the preview region is sounding, on either engine — a looping
   *  preview plays on the Web Audio loop engine with the media element
   *  paused, so `playerIsPlaying` alone would show it stopped. Defaults to
   *  `playerIsPlaying` when the page doesn't distinguish the two. */
  previewIsPlaying?: boolean;
  rowOrder?: VizRowId[];
  onReorderRow?: (draggedId: VizRowId, targetId: VizRowId) => void;
  /** Show or hide one signal row (row ids as in DEFAULT_FIXED_ROW_ORDER). The
   *  phone's row sheet uses it to swap a row's signal and to hide a row. */
  onSetSignalShown?: (rowId: VizRowId, shown: boolean) => void;
  // ─── Layer groups ───────────────────────────────────────────────────────
  /** Groups in the song's layers document, looked up by the header rows. */
  layerGroups?: AnnotationLayerGroup[];
  /** rowId → groupId, for every lane that belongs to a group. Ungrouped lanes
   *  are simply absent. Built by the page, which is the side that knows both
   *  the layers and the rowId spelling each type uses. */
  rowGroupId?: Record<string, string>;
  /** Per-group header facts the panel can't derive from its per-type layer
   *  arrays: the tri-state visibility and how many lanes are in the band. */
  groupState?: Record<string, { visibility: 'all' | 'some' | 'none'; count: number }>;
  onGroupToggleCollapsed?: (groupId: string) => void;
  onGroupSetVisible?: (groupId: string, visible: boolean) => void;
  onGroupRename?: (groupId: string, name: string) => void;
  onGroupUngroup?: (groupId: string) => void;
  onGroupDelete?: (groupId: string) => void;
  /** Start a new group holding just this lane. */
  onCreateGroupFromLayer?: (rowId: VizRowId) => void;
  /** Move a lane into a group, or out of every group when null. */
  onMoveLayerToGroup?: (rowId: VizRowId, groupId: string | null) => void;
  /** Rows whose group membership can actually be persisted — the page's own
   *  lanes, minus the detector ones. Only these may be dragged onto a band;
   *  anything else leaves the header inert rather than swallowing the drop. */
  groupableRowIds?: ReadonlySet<string>;
  /** A drag that lands on a band (or on one of its lanes). Distinct from
   *  `onReorderRow` because it has to rewrite membership *and* place the row,
   *  in one gesture. `beforeRowId` is null for "top of the band", which is
   *  what dropping on the header itself means. */
  onDropRowInGroup?: (rowId: VizRowId, groupId: string | null, beforeRowId: VizRowId | null) => void;
  // Section-color palette overrides (keyed by section type, e.g. 'intro' → '#a78bfa').
  // Applies to manual/auto-guess block rows + algo overlay rows.
  sectionColorOverrides?: Record<string, string>;
  onSectionColorChange?: (type: string, color: string) => void;
  onResetSectionColors?: () => void;
  boundaryColoringMode?: BoundaryColoringMode;
  onBoundaryColoringModeChange?: (mode: BoundaryColoringMode) => void;
  // Reset row order back to default; shown when user has reordered.
  onResetRowOrder?: () => void;
  hasCustomRowOrder?: boolean;
  /** Per-layer auralisation config (manual/autoGuess). Plays a panned click on each boundary during playback. */
  layerAudioConfig?: Record<string, LayerAudioConfig>;
  onLayerAudioChange?: (layerId: string, config: LayerAudioConfig) => void;
  /** Theme accent for the embedded PlayerPanel (waveform color, play btn, BPM pill, etc.) */
  playerAccent?: PlayerAccent;
  /** Hide the crosshair icon next to the Playback time (used in algorithm-inspect mode). */
  hidePlaybackIcon?: boolean;
  /** Hide the entire Playback/Selection readout row above the player. Used in
   *  Dataset Prep, where the numeric readout adds clutter to grid setup. */
  hideTimeDisplay?: boolean;
  /** Called while the user holds Alt and drags any waveform horizontally to slide the grid. */
  onGridOffsetChange?: (newOffset: number) => void;
  /** Called once when an Alt-drag begins. Use to snapshot the previous offset for undo. */
  onGridOffsetDragStart?: (currentOffset: number) => void;
  /** When true, render bar numbers above bar lines on the main player waveform. */
  showBarNumbers?: boolean;
  /** Multiplier on every beat-grid line's width across all rows (1 = default). */
  gridLineThickness?: number;
  /** Demucs stem playback. When provided, a Source picker is shown above the player. */
  stemSource?: StemSource;
  availableStemSources?: StemSource[];
  onStemSourceChange?: (next: StemSource) => void;
  /** When provided, the Source picker also shows a "▶ Stem this song" button.
   *  While a job is in flight the button is replaced by a "⏳ Stemming… N% ·
   *  MM:SS" pill with the current step as a subtitle; on failure it flips to
   *  a persistent red "✗ Stems failed — view log" pill. Intended for Dataset Prep. */
  onRunStems?: () => void;
  /** How many stems a (re-)run should produce — rendered as a 6/4 segmented
   *  control beside the stem button. Owned by the page so the choice also
   *  applies to the automatic post-upload runs. */
  stemModel?: DemucsModel;
  onStemModelChange?: (next: DemucsModel) => void;
  /** Model of the job currently running — named in the progress pill. */
  runStemsModel?: DemucsModel;
  runStemsStatus?: 'idle' | 'running' | 'error';
  /** Parsed progress % from Demucs's tqdm output (rightmost \d+% in the log tail). */
  runStemsProgressPct?: number;
  /** Wall-clock seconds since the job started — for the pill's MM:SS display. */
  runStemsElapsedSec?: number;
  /** Latest non-empty log line — shown as a dim subtitle under the pill. */
  runStemsLastLine?: string;
  /** Set when the user has requested cancel/kill — pill flips to "⌛ Cancelling…" / "⌛ Killing…". */
  runStemsCancelMode?: 'soft' | 'hard';
  /** SIGINT the demucs subprocess — graceful, lands between chunks. */
  onCancelStems?: () => void;
  /** SIGKILL the demucs subprocess group — immediate, no cleanup. */
  onKillStems?: () => void;
  /** Tail of the log when the job failed — shown in the inline error modal. */
  runStemsErrorTail?: string;
  /** Dismiss the persistent error pill (clears the failed job from state). */
  onDismissStemsError?: () => void;
  /** User-created Cue layers. Each visible layer renders as a tick-mark row. */
  cueLayers?: AnnotationLayer<'cues'>[];
  /** Cue currently focused (selected in editor or open in popover). Highlighted on the row. */
  focusedCue?: { layerId: string; itemId: string } | null;
  /** Fired when the user clicks a tick on a Cue row. The anchor is the mouse position. */
  onCueClick?: (layerId: string, itemId: string, anchor: { x: number; y: number }) => void;
  /** Drag a cue tick to retime it. */
  onCueDrag?: (layerId: string, itemId: string, newTime: number) => void;
  onCueDragStart?: (layerId: string, itemId: string) => void;
  /** User-created Loop layers (gated by experimentalLoopsAndPatterns Settings flag in the parent).
   *  Each visible layer renders as an interval-band row. */
  loopLayers?: AnnotationLayer<'loops'>[];
  /** Loop currently focused in the editor — highlighted on the canvas band. */
  focusedLoop?: { layerId: string; itemId: string } | null;
  /** Loop currently playing — rendered with a brighter glow on the canvas. */
  playingLoopId?: string | null;
  /** Fired when the user clicks a loop band on the canvas. */
  onLoopClick?: (layerId: string, itemId: string, anchor: { x: number; y: number }) => void;
  /** Drag a loop band's edge to retime it. Edge is 'start' or 'end'. */
  onLoopEdgeDrag?: (layerId: string, itemId: string, edge: 'start' | 'end', newTime: number) => void;
  onLoopEdgeDragStart?: (layerId: string, itemId: string, edge: 'start' | 'end') => void;
  /** Drag the body of a loop band to move it without changing its width. */
  onLoopMove?: (layerId: string, itemId: string, newStart: number, newEnd: number) => void;
  onLoopMoveStart?: (layerId: string, itemId: string) => void;
  /** User-created Span layers. Each visible layer renders as a stacked-lane
   *  overlap-aware band row. */
  spanLayers?: AnnotationLayer<'spans'>[];
  /** Span currently focused in editor or popover — highlighted on the canvas band. */
  focusedSpan?: { layerId: string; itemId: string } | null;
  /** Fired when the user clicks a span band on the canvas. */
  onSpanClick?: (layerId: string, itemId: string, anchor: { x: number; y: number }) => void;
  /** Drag a span band's edge to retime it. */
  onSpanEdgeDrag?: (layerId: string, itemId: string, edge: 'start' | 'end', newTime: number) => void;
  onSpanEdgeDragStart?: (layerId: string, itemId: string, edge: 'start' | 'end') => void;
  /** Drag the body of a span band to move it without changing its width. */
  onSpanMove?: (layerId: string, itemId: string, newStart: number, newEnd: number) => void;
  onSpanMoveStart?: (layerId: string, itemId: string) => void;
  /** Prominence (front/back) edits from the open span popover's breakpoint editor. */
  onSpanProminenceChange?: (layerId: string, itemId: string, points: ProminenceEnvelope | undefined) => void;
  /** Span whose edit popover is open — gates the inline prominence editor. */
  spanProminenceEdit?: { layerId: string; itemId: string } | null;
  onLoopProminenceChange?: (layerId: string, itemId: string, points: ProminenceEnvelope | undefined) => void;
  loopProminenceEdit?: { layerId: string; itemId: string } | null;
  onRiffPatternProminenceChange?: (layerId: string, itemId: string, points: ProminenceEnvelope | undefined) => void;
  riffPatternProminenceEdit?: { layerId: string; itemId: string } | null;
  /** Snap a prominence breakpoint onto the beat grid as it's dragged or placed
   *  in any of the four band editors. The host passes its own snap function —
   *  the identity while Snap to grid and Grid Lock are both off — so a
   *  breakpoint obeys the same switch as moving the band it belongs to. */
  snapProminenceTime?: (trackSeconds: number) => number;
  /** Riff-pattern layers (gated by experimentalLoopsAndPatterns). Each layer
   *  renders its placed instances tiled `repeatCount` times, with proportional
   *  sequence blocks inside each cycle. */
  riffPatternLayers?: AnnotationLayer<'riff-patterns'>[];
  /** Riff-pattern instance currently focused in the editor panel. */
  focusedRiffPattern?: { layerId: string; itemId: string } | null;
  /** Fired when the user clicks the tile background (not a specific block). */
  onRiffPatternItemClick?: (layerId: string, itemId: string, anchor: { x: number; y: number }) => void;
  /** Fired when the user clicks a specific sequence block. */
  onRiffPatternEntryClick?: (layerId: string, itemId: string, entryIndex: number, nodeId: string | null, anchor: { x: number; y: number }) => void;
  /** Fired continuously while dragging a sequence block's resize handle. */
  onRiffPatternEntryResize?: (layerId: string, itemId: string, entryIndex: number, newLengthSteps: number, gestureKey?: string) => void;
  /** Trims a riff node to a new length in beats — the plain edge-drag on a
   *  bare node entry. See `RiffPatternLaneRow.onEntryTrimNode`. */
  onRiffNodeTrim?: (layerId: string, nodeId: string, lengthBeats: number, gestureKey?: string) => void;
  /** Drag the body of a riff pattern's first cycle to slide the whole
   *  instance (and all its repeats) without changing the cycle length. */
  onRiffPatternItemMove?: (layerId: string, itemId: string, newStart: number, newEnd: number) => void;
  onRiffPatternItemMoveStart?: (layerId: string, itemId: string) => void;
  /** User-created + detector-sourced Lyrics layers (gated by
   *  experimentalLyricsFamily). Each renders word/line ticks with text. */
  lyricsLayers?: AnnotationLayer<'lyrics'>[];
  /** Lyric currently focused in editor/popover — highlighted on the canvas. */
  focusedLyrics?: { layerId: string; itemId: string } | null;
  /** Fired when the user clicks a lyric tick on the canvas. */
  onLyricsClick?: (layerId: string, itemId: string, anchor: { x: number; y: number }) => void;
  /** Seek the playhead to a clicked word (works on read-only detector rows too). */
  onLyricsSeek?: (time: number) => void;
  /** Drag a lyric tick to retime it. */
  onLyricsDrag?: (layerId: string, itemId: string, newTime: number) => void;
  onLyricsDragStart?: (layerId: string, itemId: string) => void;
  onLyricsEdgeDrag?: (layerId: string, itemId: string, edge: 'start' | 'end', time: number) => void;
  onLyricsEdgeDragStart?: (layerId: string, itemId: string, edge: 'start' | 'end') => void;
  /** When true, register a window-level wheel listener that redirects every
   *  horizontal trackpad/wheel gesture on the page to scroll the viz timeline
   *  (and suppresses the browser swipe-back/forward gesture). Default false. */
  captureGlobalHScroll?: boolean;
  /** Currently-active annotation tab. Drives the "selected layer" highlight
   *  on the matching viz row label (neon accent + glow). */
  activeAnnotationType?: 'boundaries' | 'cues' | 'spans' | 'loops' | 'patterns' | 'riff-patterns' | 'lyrics';
  /** Selected layer id per type (same map fed to the unified sidebar). Used
   *  to mark exactly one viz row as the active target. */
  selectedLayerIdByType?: Partial<Record<'boundaries' | 'cues' | 'spans' | 'loops' | 'patterns' | 'riff-patterns' | 'lyrics', string | null>>;
  /** Fired when the user clicks a viz row label. The parent should switch
   *  the active tab + source picker to this layer (same handler the unified
   *  sidebar uses). When omitted, viz labels stay non-interactive. */
  onSelectLayer?: (type: SelectableLayerType, selection: VizLayerSelection) => void;
  /** An algo lane's label was clicked (or un-clicked). The selection itself
   *  stays local to this panel — this only tells the page which detector lane
   *  the user is pointing at, so a stage below can follow it (e.g. a lyrics
   *  detector opening the karaoke). Null when the lane is deselected. */
  onAlgoOverlaySelect?: (overlayId: string | null) => void;
  /** Rename an editable typed user layer inline from its lane label. Wired for
   *  non-read-only cue/span/loop layers only; when omitted, lane labels
   *  show no rename affordance. */
  onRenameLayer?: (layerId: string, name: string) => void;
}

// ─── Beat grid resolver ───────────────────────────────────────────────────────

/** Exported for the contract test that holds this and
 *  `beatGridUnitToSnapDivision` together: every line this draws for a unit
 *  must be a place that unit's snap can land. */
export function resolveBeatGrid(
  bpm: number | undefined,
  beatsPerBar: number,
  showBeatGrid: boolean | undefined,
  beatGridUnit: BeatGridUnit | undefined,
): { bpm?: number; beatsPerBar?: number; barGroupSize?: number; subBeatDivision?: number; beatGroupSize?: number } {
  if (!showBeatGrid || !bpm) return {};
  switch (beatGridUnit) {
    case '32nd':          return { bpm, beatsPerBar, subBeatDivision: 8 };
    case '16th-triplet':  return { bpm, beatsPerBar, subBeatDivision: 6 };
    case '16th':          return { bpm, beatsPerBar, subBeatDivision: 4 };
    case '8th-triplet':   return { bpm, beatsPerBar, subBeatDivision: 3 };
    case '8th':           return { bpm, beatsPerBar, subBeatDivision: 2 };
    case 'compound-beat': return { bpm, beatsPerBar, beatGroupSize: 3 };
    case '2bar':          return { bpm, beatsPerBar, barGroupSize: 2 };
    case '4bar':          return { bpm, beatsPerBar, barGroupSize: 4 };
    case '8bar':          return { bpm, beatsPerBar, barGroupSize: 8 };
    case '16bar':         return { bpm, beatsPerBar, barGroupSize: 16 };
    case 'bar':           return { bpm, beatsPerBar, barGroupSize: 1 };
    case 'beat':
    default:              return { bpm, beatsPerBar };
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SharedVizPanel({
  playerUrl, trackName,
  audioBuffer, duration, currentTime,
  bpm, timeSignature, beatOffset, beatsPerBar = 4,
  showBeatGrid, beatGridUnit, beatOverrides, gridSegments, showGridSegmentLane, selectedSegmentId, cutLabelSegmentId, onSegmentSelect, onSegmentHeadDrag, onDeleteGridSegment, onSplitGridAt, snapSegmentTime, segmentSnapOn, gridMode, onBeatDrag, onClearBeatOverride, manualEditLocked,
  snapToGrid = false,
  snapTimeOverride,
  snapProminenceTime,
  boundaryLayers, autoGuessPoints, pendingSelection,
  showManual, showAutoGuess,
  showProminence = true,
  showWaveform, showEQ = false, showSpectrogram, showCepstrogram, showChroma, showTempogram, showSsm,
  mirCurves, mirComputing = false, showEnergy, showBrightness, showNovelty, showOnsets, showFlux,
  algoOverlays,
  onVizClick, onVizRegion, onRegionDragStart, onManualBoundaryChange, onManualBoundaryDragStart,
  onManualSectionClick,
  leadCandidates, onAssignLead, onSetLevel,
  onMarkCorrect, onMarkIncorrect, onMarkPending,
  customAnnotationRows,
  hiddenCustomAnnotations,
  onCustomAnnotationMarkCorrect, onCustomAnnotationMarkIncorrect,
  onCustomAnnotationMarkPending,
  detectorLayerReview, onDetectorLayerAccept, onDetectorLayerReject,
  onCopyDetectorLayer, detectorLayerCopyCounts,
  onCopyAlgoOverlay, algoCopyCounts,
  mergeLanes, mergeBoundaries,
  onMergeAddLane, onMergeRemoveLane, onMergeClear,
  onMergeToggleBoundary, onMergeRestoreDropped, onMergeCommit,
  mergeCommittedCount = 0,
  mergeCommittedNote = null,
  consensusBlocks, consensusRefMisses, consensusReferenceLabel, consensusTolerance,
  onHideConsensus, onCopyConsensus, consensusCopyCount = 0,
  seekRef, playRef, pauseRef, getTimeRef, externalTimeRef, wsScrollRef, zoomInRef, zoomOutRef, zoomResetRef, getZoomFocusTime, onLeadRangeChange, pinchZoomInRef, pinchZoomOutRef, scrollToTimeRef, zoomToRangeRef,
  onBufferReady, onReady, onTimeUpdate, onPlayingChange, playbackRate, onScrollChange, onViewChange,
  vizScrollContainerRef, vizSignalWidth, vizZoomFactor = 1, onVizScroll,
  playerIsPlaying, onSeekAndPlay, onPause,
  previewRegion, onPreviewRegionChange, onPreviewPlay, onPreviewPause, onPreviewDismiss, onPreviewEnd, onPreviewLoopToggle, previewIsPlaying,
  rowOrder, onReorderRow, onSetSignalShown,
  layerGroups, rowGroupId, groupState,
  onGroupToggleCollapsed, onGroupSetVisible, onGroupRename, onGroupUngroup, onGroupDelete,
  onCreateGroupFromLayer, onMoveLayerToGroup, groupableRowIds, onDropRowInGroup,
  sectionColorOverrides, onSectionColorChange, onResetSectionColors,
  boundaryColoringMode, onBoundaryColoringModeChange,
  onResetRowOrder, hasCustomRowOrder,
  layerAudioConfig, onLayerAudioChange,
  playerAccent,
  hidePlaybackIcon,
  hideTimeDisplay = false,
  onGridOffsetChange,
  onGridOffsetDragStart,
  showBarNumbers = false,
  gridLineThickness = 1,
  stemSource, availableStemSources, onStemSourceChange, onRunStems,
  stemModel, onStemModelChange, runStemsModel, runStemsStatus,
  runStemsProgressPct, runStemsElapsedSec, runStemsLastLine, runStemsCancelMode,
  onCancelStems, onKillStems, runStemsErrorTail, onDismissStemsError,
  cueLayers, focusedCue, onCueClick, onCueDrag, onCueDragStart,
  loopLayers, focusedLoop, playingLoopId, onLoopClick, onLoopEdgeDrag, onLoopEdgeDragStart, onLoopMove, onLoopMoveStart,
  spanLayers, focusedSpan, onSpanClick, onSpanEdgeDrag, onSpanEdgeDragStart, onSpanMove, onSpanMoveStart,
  onSpanProminenceChange, spanProminenceEdit,
  onLoopProminenceChange, loopProminenceEdit,
  onRiffPatternProminenceChange, riffPatternProminenceEdit,
  riffPatternLayers, focusedRiffPattern, onRiffPatternItemClick, onRiffPatternEntryClick, onRiffPatternEntryResize,
  onRiffNodeTrim,
  onRiffPatternItemMove, onRiffPatternItemMoveStart,
  lyricsLayers, focusedLyrics, onLyricsClick, onLyricsSeek, onLyricsDrag, onLyricsDragStart,
  onLyricsEdgeDrag, onLyricsEdgeDragStart,
  captureGlobalHScroll = false,
  activeAnnotationType,
  selectedLayerIdByType,
  onSelectLayer,
  onAlgoOverlaySelect,
  onRenameLayer,
}: SharedVizPanelProps) {

  // Drag-to-reorder: tracks the row currently being dragged and the row hovered as drop target.
  const [draggedRowId, setDraggedRowId] = useState<VizRowId | null>(null);
  const [dropTargetRowId, setDropTargetRowId] = useState<VizRowId | null>(null);

  // ── Label column width (resizable gutter) ─────────────────────────────────
  // Width applied to every sticky row label via the `--viz-label-w` CSS var
  // set on the panel root. Seeded from `labelColWSession` (see the module
  // constant above): starts at the 56px minimum on a fresh load, keeps the
  // user's drag for the rest of the session, never touches storage. Capped
  // at 240px — enough for long renamed layer names without wrapping the
  // spectrogram column too tightly.
  const [labelColW, setLabelColW] = useState<number>(labelColWSession);
  const labelColWRef = useRef(labelColW);
  useEffect(() => {
    labelColWRef.current = labelColW;
    labelColWSession = labelColW;
  }, [labelColW]);
  // Phone: a fixed 12px gutter (20px with the gap) — the name is written up
  // the strip and read in full from the row sheet a tap opens, so the
  // timeline keeps nearly the whole screen width. Desktop is untouched.
  // The strip width means sideways names (see snapGutterW). On a phone the
  // strip is the CSS-drawn 12px one (index.css); opened out, a phone gutter
  // reads across exactly like the desktop's.
  const isMobile = getIsMobile();
  const atStrip = labelColW <= VERTICAL_GUTTER_W;
  const mobileStrip = isMobile && atStrip;
  const gutterW = mobileStrip ? 12 : labelColW;
  const verticalRowTitles = !isMobile && atStrip;

  // ── Row sizes (S / M / L / XL) ───────────────────────────────────────────
  // Per signal row, chosen from the row sheet and remembered per browser. M is
  // each row's own height; XL is the tall spectrogram without leaving the
  // stack of rows it lines up with.
  const [rowSizes, setRowSizes] = useState<Record<string, RowSize>>(() => {
    try { return JSON.parse(localStorage.getItem('tc:viz-row-sizes') ?? '{}') ?? {}; } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem('tc:viz-row-sizes', JSON.stringify(rowSizes)); } catch { /* quota */ }
  }, [rowSizes]);
  const rowH = (rowId: string, base: number) => Math.round(base * ROW_SIZE_SCALE[rowSizes[rowId] ?? 'M']);

  // ── Marks drawn over a signal row ────────────────────────────────────────
  // Per row, the boundary layers (`layer:<id>`) and boundary detectors
  // (`algo:<id>`) drawn on top of it — see SignalMarksOverlay. Chosen in the
  // row sheet, remembered per browser. A source that is gone (a deleted
  // layer, a detector not run on this song) simply draws nothing.
  const [rowMarks, setRowMarks] = useState<Record<string, string[]>>(() => {
    try { return JSON.parse(localStorage.getItem('tc:viz-row-marks') ?? '{}') ?? {}; } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem('tc:viz-row-marks', JSON.stringify(rowMarks)); } catch { /* quota */ }
  }, [rowMarks]);
  const markSources = useMemo(() => [
    ...(boundaryLayers ?? []).map((l) => ({
      key: `layer:${l.id}`, name: l.name, color: l.color, kind: 'line' as const,
      times: l.items.map((it) => it.time),
    })),
    ...algoOverlays
      .filter((o) => (o.renderKind ?? 'boundary') === 'boundary')
      .map((o) => ({
        key: `algo:${o.id}`, name: o.label, color: o.labelColor ?? '#94a3b8', kind: 'bar' as const,
        times: o.sections.map((sec) => sec.time),
      })),
  ], [boundaryLayers, algoOverlays]);
  const marksFor = useCallback((rowId: string) => {
    const keys = rowMarks[rowId];
    const lines: SignalMark[] = [];
    const bars: SignalMark[] = [];
    if (keys?.length) {
      for (const src of markSources) {
        if (!keys.includes(src.key)) continue;
        const into = src.kind === 'line' ? lines : bars;
        for (const t of src.times) into.push({ t, color: src.color });
      }
    }
    return { lines, bars };
  }, [rowMarks, markSources]);

  // ── Phone row sheet ──────────────────────────────────────────────────────
  // A tap on a row's (vertical, 20px) name opens it: the full name, and the
  // controls to change that row. The tap still reaches the label's own
  // handler, so tapping a lane also makes it the active layer, as on desktop.
  const panelRootRef = useRef<HTMLDivElement | null>(null);
  const [rowSheet, setRowSheet] = useState<RowSheetTarget | null>(null);
  // A sideways drag that starts on the phone's name column resizes it — the
  // desktop's 6px grip is no target for a finger. Decided on the first 8px
  // of travel: mostly sideways is a resize, anything else is left alone
  // (`touch-action: pan-y` has already given vertical swipes to the page).
  // A drag that did resize swallows the click that follows, so letting go
  // doesn't also open the row sheet.
  const gutterDraggedRef = useRef(false);
  const onGutterPointerDown = useCallback((e: React.PointerEvent) => {
    if (!(e.target as HTMLElement).closest('.tc-label-cell')) return;
    if ((e.target as HTMLElement).closest('input, button')) return;
    gutterDraggedRef.current = false;
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = labelColWRef.current;
    let resizing = false;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!resizing) {
        if (Math.hypot(dx, ev.clientY - startY) < 8) return;
        if (Math.abs(dx) <= Math.abs(ev.clientY - startY)) { done(); return; }
        resizing = true;
        gutterDraggedRef.current = true;
      }
      setLabelColW(snapGutterW(startW + dx));
    };
    const done = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
  }, []);

  const onMobileLabelTap = useCallback((e: React.MouseEvent) => {
    if (gutterDraggedRef.current) {
      gutterDraggedRef.current = false;
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    // Opened out, the cell's own ✎ / ⓘ / ⋮ answer their taps themselves.
    if ((e.target as HTMLElement).closest('input, button')) return;
    const cell = (e.target as HTMLElement).closest<HTMLElement>('.tc-label-cell');
    if (!cell?.dataset.label) return;
    const row = cell.closest<HTMLElement>('[data-viz-row]');
    const rowId = row?.dataset.vizRow;
    // Signal lanes wear short names ("Spectro", "Bright"); the sheet has the
    // room for the one the SIGNALS menu uses.
    setRowSheet({ rowId, name: (rowId && SIGNAL_LABEL[rowId]) || cell.dataset.label, color: getComputedStyle(cell).color });
  }, []);
  const shownSignalIds = useMemo(() => new Set(Object.entries({
    waveform: showWaveform, eq: showEQ, spectrogram: showSpectrogram, cepstrogram: showCepstrogram,
    chroma: showChroma, tempogram: showTempogram, ssm: showSsm, energy: showEnergy,
    brightness: showBrightness, novelty: showNovelty, onsets: showOnsets, flux: showFlux,
  }).filter(([, on]) => on).map(([id]) => id)), [showWaveform, showEQ, showSpectrogram, showCepstrogram,
    showChroma, showTempogram, showSsm, showEnergy, showBrightness, showNovelty, showOnsets, showFlux]);
  const visibleRowIds = useCallback((): string[] => {
    const root = panelRootRef.current;
    if (!root) return [];
    return [...root.querySelectorAll<HTMLElement>('[data-viz-row]')]
      .map((el) => el.dataset.vizRow ?? '')
      .filter((id) => id && !id.startsWith(GROUP_ROW_PREFIX));
  }, []);

  // ── "Display options" disclosure (layer-audio mixer + section-color palette).
  // Collapsed by default to keep the timeline flush under the player; the
  // open/closed choice is remembered per-browser. ──
  const DISPLAY_OPTS_KEY = 'tc:viz-display-options-open';
  const [displayOptionsOpen, setDisplayOptionsOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(DISPLAY_OPTS_KEY) === '1';
  });
  const toggleDisplayOptions = useCallback(() => {
    setDisplayOptionsOpen((prev) => {
      const next = !prev;
      try { window.localStorage.setItem(DISPLAY_OPTS_KEY, next ? '1' : '0'); } catch { /* private mode */ }
      return next;
    });
  }, []);
  // ── Karaoke playhead highlight — per-layer opt-in set ────────────────────
  const [karaokeLayerIds, setKaraokeLayerIds] = useState<ReadonlySet<string>>(() => new Set());
  const toggleKaraokeLayer = useCallback((layerId: string) => {
    setKaraokeLayerIds((prev) => {
      const next = new Set(prev);
      if (next.has(layerId)) next.delete(layerId); else next.add(layerId);
      return next;
    });
  }, []);

  const handleLabelColResizeStart = useCallback((e: React.PointerEvent) => {
    // Stop the parent label's HTML5-drag (row reorder) and click-to-select
    // from firing when the user grabs the grippy.
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = labelColWRef.current;
    const onMove = (ev: PointerEvent) => {
      setLabelColW(snapGutterW(startW + (ev.clientX - startX)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  // ── Layer-row click-to-select helper ──────────────────────────────────────
  // Build the per-layer selection payload + isSelected flag for the four
  // multi-layer types. Returns null when click-to-select isn't wired so the
  // label stays passive (drag-to-reorder still works, no onClick attached).
  const layerSelectionFor = useCallback((
    type: SelectableLayerType,
    layer: AnnotationLayer,
  ): { isSelected: boolean; onSelect?: () => void; onRename?: (name: string) => void } => {
    const isSelected = activeAnnotationType === type
      && selectedLayerIdByType?.[type] === layer.id;
    // Read-only (detector-sourced) layers regenerate from their source, so a
    // renamed name wouldn't stick — only offer rename on user-authored layers.
    const onRename = onRenameLayer && layer.readOnly !== true
      ? (name: string) => onRenameLayer(layer.id, name)
      : undefined;
    if (!onSelectLayer) return { isSelected, onRename };
    const sourceId: VizLayerSelection['sourceId'] = layer.source && layer.source.startsWith('detector:')
      ? (layer.source as `detector:${string}`)
      : 'manual';
    return {
      isSelected,
      onRename,
      onSelect: () => onSelectLayer(type, {
        id: layer.id,
        sourceId,
        name: layer.name,
        readOnly: layer.readOnly === true,
      }),
    };
  }, [activeAnnotationType, selectedLayerIdByType, onSelectLayer, onRenameLayer]);

  // Auto-guess per-point manual-expand toggle. The set is shared across the
  // built-in auto-guess row and every custom-detector row since point IDs are
  // globally unique. When the row's auto-expand threshold is met (zoom factor
  // ≥ autoGuessExpandZoomThreshold) this set is bypassed.
  const { settings } = useSettings();
  const expandThreshold = settings.autoGuessExpandZoomThreshold;
  const [expandedAutoGuessPointIds, setExpandedAutoGuessPointIds] = useState<Set<string>>(() => new Set());
  const [selectedAlgoOverlayId, setSelectedAlgoOverlayId] = useState<string | null>(null);
  const toggleAutoGuessExpanded = useCallback((pointId: string) => {
    setExpandedAutoGuessPointIds((prev) => {
      const next = new Set(prev);
      if (next.has(pointId)) next.delete(pointId);
      else next.add(pointId);
      return next;
    });
  }, []);

  // Parent of the 3-Band waveform — kept for layout (no longer used by PreviewWindow).
  const waveformBoxRef = useRef<HTMLDivElement | null>(null);

  // Parent of the tall PreviewBand — spans every viz row's content column, used by
  // PreviewWindow for time↔pixel conversion when the user resizes the band.
  const previewBandParentRef = useRef<HTMLDivElement | null>(null);

  // Intercept trackpad horizontal wheel deltas on the viz scroll container so
  // the browser's swipe-back/forward gesture doesn't fire when scrubbing.
  // React's onWheel synthetic event is always passive, so we need a native
  // listener with { passive: false } to make preventDefault() take effect.
  // Skips ctrl-modified events — those are pinch-zoom / Ctrl+wheel and are
  // handled by the zoom listener below.
  useEffect(() => {
    const el = vizScrollContainerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return;
      if (e.deltaX === 0) return;
      e.preventDefault();
      el.scrollLeft += e.deltaX;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [vizScrollContainerRef]);

  // Intercept the browser's pinch-zoom / Ctrl+wheel gesture over the viz and
  // remap it to the app's zoomIn/zoomOut. Browsers fire pinch as
  // `wheel` events with `ctrlKey: true` and a deltaY proportional to the
  // pinch velocity, so a single listener covers both Ctrl/⌘+wheel on mice
  // and two-finger pinch on trackpads.
  //
  // zoomIn/Out are 2× step functions, so we rate-limit by accumulating deltaY
  // and only firing once the magnitude crosses ZOOM_STEP_THRESHOLD — otherwise
  // a single pinch frame produces a runaway cascade. preventDefault stops the
  // browser's native page-zoom from also firing.
  useEffect(() => {
    const el = vizScrollContainerRef.current;
    if (!el) return;
    const ZOOM_STEP_THRESHOLD = 40;
    let accumDelta = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      accumDelta += e.deltaY;
      while (accumDelta <= -ZOOM_STEP_THRESHOLD) {
        pinchZoomInRef?.current?.();
        accumDelta += ZOOM_STEP_THRESHOLD;
      }
      while (accumDelta >= ZOOM_STEP_THRESHOLD) {
        pinchZoomOutRef?.current?.();
        accumDelta -= ZOOM_STEP_THRESHOLD;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [vizScrollContainerRef, pinchZoomInRef, pinchZoomOutRef]);

  // Opt-in: redirect *every* horizontal wheel gesture on the page to the viz
  // timeline. Captures at the window level so it runs before any other
  // horizontal scroll container (e.g. the workspace tab strip) or the local
  // viz/WaveSurfer listeners get a chance. stopPropagation() prevents the
  // local listeners from also firing — they'd otherwise double-scroll, since
  // the global handler already scrolls the viz container and the WaveSurfer
  // scroll syncs via the existing onScroll → wsScrollRef plumbing.
  // Skips ctrl-modified events so pinch-zoom over any element falls through
  // to the local viz zoom handler instead of being eaten as a pan.
  useEffect(() => {
    if (!captureGlobalHScroll) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return;
      if (e.deltaX === 0) return;
      const viz = vizScrollContainerRef.current;
      if (!viz) return;
      e.preventDefault();
      e.stopPropagation();
      viz.scrollLeft += e.deltaX;
    };
    window.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => window.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
  }, [captureGlobalHScroll, vizScrollContainerRef]);

  const makeDragHandlers = useCallback((rowId: VizRowId): RowDragHandlers | undefined => {
    if (!onReorderRow) return undefined;
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.effectAllowed = 'move';
        setDraggedRowId(rowId);
      },
      onDragEnd: () => {
        setDraggedRowId(null);
        setDropTargetRowId(null);
      },
    };
  }, [onReorderRow]);

  // Where the row in flight would land if it were dropped on `rowId`, or null
  // when the drop wouldn't change any band — which is the plain reorder case.
  // A lane only reads as a band drop when the page can persist the membership
  // (`groupableRowIds` / `onDropRowInGroup`); a detector lane or a signal row
  // dragged over a header is refused, rather than accepted and then dropped on
  // the floor by a no-op write.
  const groupDropFor = useCallback((rowId: VizRowId): GroupDrop | null => {
    if (!draggedRowId || !onDropRowInGroup) return null;
    if (!groupableRowIds?.has(draggedRowId)) return null;
    const drop = resolveGroupDrop(rowId, rowGroupId);
    // Dropping on the header is always a band move — "put it at the top" is
    // worth honouring even for a lane already in that band. Every other row
    // only counts when the band on the far side of the drop differs.
    if (drop.beforeRowId == null) return drop;
    return drop.groupId === (rowGroupId?.[draggedRowId] ?? null) ? null : drop;
  }, [draggedRowId, onDropRowInGroup, groupableRowIds, rowGroupId]);

  const makeRowDropHandlers = useCallback((rowId: VizRowId) => {
    // `data-viz-row` rides on every row (it is spread with the drop handlers):
    // the phone's row sheet reads it off the tapped label to know which row
    // it is changing, and walks them for the on-screen order.
    if (!onReorderRow) return { 'data-viz-row': rowId };
    const isHeader = rowId.startsWith(GROUP_ROW_PREFIX);
    return {
      'data-viz-row': rowId,
      onDragOver: (e: React.DragEvent) => {
        if (!draggedRowId || draggedRowId === rowId) return;
        // A header can only take a lane that can join it; it has no reorder
        // fallback, since it isn't in the stored row order at all.
        if (isHeader && !groupDropFor(rowId)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (dropTargetRowId !== rowId) setDropTargetRowId(rowId);
      },
      onDragLeave: () => {
        if (dropTargetRowId === rowId) setDropTargetRowId(null);
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        setDropTargetRowId(null);
        if (!draggedRowId || draggedRowId === rowId) { setDraggedRowId(null); return; }
        const drop = groupDropFor(rowId);
        if (drop) onDropRowInGroup!(draggedRowId, drop.groupId, drop.beforeRowId);
        else if (!isHeader) onReorderRow(draggedRowId, rowId);
        setDraggedRowId(null);
      },
    };
  }, [onReorderRow, onDropRowInGroup, groupDropFor, draggedRowId, dropTargetRowId]);

  const beatGrid = useMemo(
    () => resolveBeatGrid(bpm, beatsPerBar, showBeatGrid, beatGridUnit),
    [bpm, beatsPerBar, showBeatGrid, beatGridUnit],
  );

  // When the song is split into grids (Mapped, or Hand-placed on a Mapped
  // base), the user's bar-level beatGridUnit choice (Bar, 2bar, 4bar, …) is
  // augmented to also emit the beats inside each bar — otherwise a 100-BPM
  // segment next to a 130-BPM segment is indistinguishable from a uniform
  // grid. Finer-than-bar units (8th, 16th, etc.) already show beats and are
  // left alone.
  const augmentForSegments = !!(gridSegments && gridSegments.length > 1 && beatGrid.barGroupSize != null);
  const effectiveBeatGrid = useMemo(() => (
    augmentForSegments
      ? { ...beatGrid, barGroupSize: undefined, subBeatDivision: 1, beatGroupSize: undefined }
      : beatGrid
  ), [beatGrid, augmentForSegments]);

  // Bundled props for the BeatGridOverlay used by section/sparkline/algo rows
  // — the canvas-based waveforms and spectrogram render their own grid directly.
  const gridProps: GridProps | undefined = useMemo(() => {
    if (!effectiveBeatGrid.bpm) return undefined;
    return {
      bpm: effectiveBeatGrid.bpm,
      gridOffset: beatOffset ?? 0,
      beatsPerBar: effectiveBeatGrid.beatsPerBar,
      barGroupSize: effectiveBeatGrid.barGroupSize ?? null,
      subBeatDivision: effectiveBeatGrid.subBeatDivision,
      beatGroupSize: effectiveBeatGrid.beatGroupSize,
      beatOverrides,
      segments: gridSegments,
      thickness: gridLineThickness,
    };
  }, [effectiveBeatGrid, beatOffset, beatOverrides, gridSegments, gridLineThickness]);

  // One tiling per boundary layer. Boundaries carry no stored end, so each
  // item's block runs to the next item's start (and the last to the track's
  // end) — the tiling that makes a boundary layer a reading of the structure
  // rather than a scatter of points.
  const boundaryBlocksByLayer = useMemo(() => {
    const out = new Map<string, { time: number; endTime: number; label: string; type: string; importance?: 'critical' | 'optional' }[]>();
    for (const l of boundaryLayers ?? []) {
      const items = [...l.items].sort((a, b) => a.time - b.time);
      out.set(l.id, items.map((s, i) => ({
        time: s.time,
        endTime: items[i + 1]?.time ?? duration,
        label: s.label,
        type: s.type,
        importance: s.importance,
      })));
    }
    return out;
  }, [boundaryLayers, duration]);

  // Auto-guess block sections (colored by review status)
  const autoGuessBlockSections = useMemo(() => {
    if (!autoGuessPoints?.length) return [];
    const sorted = [...autoGuessPoints].sort((a, b) => a.time - b.time);
    return sorted.map((p, i) => ({
      time: p.time,
      endTime: sorted[i + 1]?.time ?? duration,
      label: `×${agreementCount(p)}`,
      type: 'default',
      color: p.status === 'correct' ? '#14b8a6' : p.status === 'incorrect' ? '#f87171' : p.status === 'partial' ? '#f59e0b' : '#4b5563',
    }));
  }, [autoGuessPoints, duration]);

  // ── Dragging a grid-segment head ─────────────────────────────────────────
  // The head lives in the lane under the waveform, but what you are lining it
  // up against is usually a transient on one of the signal rows below. So the
  // in-flight position is mirrored onto every signal row as a bright cursor
  // for the length of the drag. Kept here rather than in the page: this is the
  // component that owns both the lane (via the player) and the rows.
  const [segmentHeadDragTime, setSegmentHeadDragTime] = useState<number | null>(null);
  const handleSegmentHeadDrag = useCallback((
    segment: import('../../utils/gridSegments').ResolvedSegment,
    time: number,
  ) => {
    setSegmentHeadDragTime(time);
    onSegmentHeadDrag?.(segment, time);
  }, [onSegmentHeadDrag]);
  // A drag that ends while the lane is unmounting (song switch) never fires its
  // end callback — drop the cursor whenever the lane goes away.
  useEffect(() => {
    if (!showGridSegmentLane) setSegmentHeadDragTime(null);
  }, [showGridSegmentLane]);

  // Row order with each group's band spliced in: header first, members behind
  // it, nothing but the header when the group is collapsed.
  const collapsedGroupIds = useMemo(
    () => new Set((layerGroups ?? []).filter((g) => g.collapsed).map((g) => g.id)),
    [layerGroups],
  );
  const groupMenuForRow = useCallback((rid: VizRowId, layer: AnnotationLayer) => {
    // Detector lanes are re-derived each render and never persisted, so a
    // groupId on one would vanish on reload. No menu rather than a dead one.
    if (layer.readOnly || !onCreateGroupFromLayer || !onMoveLayerToGroup) return undefined;
    return {
      groups: layerGroups ?? [],
      currentGroupId: rowGroupId?.[rid],
      onNewGroup: () => onCreateGroupFromLayer(rid),
      onMoveTo: (groupId: string | null) => onMoveLayerToGroup(rid, groupId),
    };
  }, [layerGroups, rowGroupId, onCreateGroupFromLayer, onMoveLayerToGroup]);
  const groupColorForRow = useCallback((rid: VizRowId): string | undefined => {
    const gid = rowGroupId?.[rid];
    return gid ? layerGroups?.find((g) => g.id === gid)?.color : undefined;
  }, [rowGroupId, layerGroups]);
  const groupedRowOrder = useMemo(
    () => buildGroupedRowOrder(rowOrder ?? DEFAULT_FIXED_ROW_ORDER, rowGroupId, collapsedGroupIds),
    [rowOrder, rowGroupId, collapsedGroupIds],
  );

  // Section types currently rendered → used by the section-color palette picker.
  // Walks Manual + visible algo overlays. Auto-guess uses per-section status colors so it's excluded.
  const visibleSectionTypes = useMemo(() => {
    const order = rowOrder ?? DEFAULT_FIXED_ROW_ORDER;
    const types = new Set<string>();
    if (showManual) {
      for (const l of boundaryLayers ?? []) {
        if (!l.visible) continue;
        for (const it of l.items) types.add(it.type);
      }
    }
    for (const rowId of order) {
      if (FIXED_ROW_IDS.has(rowId)) continue;
      const overlay = algoOverlays.find((o) => o.id === rowId);
      if (overlay) for (const s of overlay.sections) types.add(s.type);
    }
    return Array.from(types).sort();
  }, [rowOrder, showManual, boundaryLayers, algoOverlays]);

  // No section overlay on spectrogram — manual already shown as dedicated block row above

  const handlePlay = useCallback((time: number, stopTime: number) => {
    onSeekAndPlay?.(time, stopTime);
  }, [onSeekAndPlay]);

  const handlePause = useCallback(() => { onPause?.(); }, [onPause]);

  // ── Algo block popover (click a section in any algo row to read its output) ──
  // Reuses the unified AnnotationPointCard in read-only mode so the algo card
  // matches every other annotation popover (cues / spans / loops).
  const algoPopover = useAnnotationPopover({ width: 340, height: 240 });

  // ── Auralisation: per-layer click pips on boundary crossings ───────────────
  const autoGuessAudio = layerAudioConfig?.autoGuess ?? DEFAULT_LAYER_AUDIO;

  const autoGuessTimes = useMemo(
    () =>
      (autoGuessPoints ?? [])
        .filter((p) => p.status === 'correct' || p.status === 'partial')
        .map((p) => p.time)
        .sort((a, b) => a - b),
    [autoGuessPoints],
  );

  // Per-layer auralisation for user-created Cue/Span/Loop layers. Cues click
  // on every tick; Span/Loop click on entry (start). Frequencies are spread
  // across a small palette so multiple layers stay distinguishable by ear.
  const userLayerAudioEntries = useMemo(() => {
    const out: Array<{ id: string; label: string; accent: string; freq: number; times: number[] }> = [];
    const slots = [800, 1100, 1700, 2200, 2700, 3000, 3300];
    let i = 0;
    const nextFreq = () => slots[(i++) % slots.length];
    for (const l of boundaryLayers ?? []) {
      if (!l.visible || !l.items.length) continue;
      const times = l.items.map((it) => it.time).sort((a, b) => a - b);
      out.push({ id: `boundary-layer:${l.id}`, label: l.name, accent: l.color, freq: 2500, times });
    }
    for (const l of cueLayers ?? []) {
      if (!l.visible || !l.items.length) continue;
      const times = l.items.map((it) => it.time).sort((a, b) => a - b);
      out.push({ id: `cue-layer:${l.id}`, label: l.name, accent: l.color, freq: nextFreq(), times });
    }
    for (const l of spanLayers ?? []) {
      if (!l.visible || !l.items.length) continue;
      const times = l.items.map((it) => it.start).sort((a, b) => a - b);
      out.push({ id: `span-layer:${l.id}`, label: l.name, accent: l.color, freq: nextFreq(), times });
    }
    for (const l of loopLayers ?? []) {
      if (!l.visible || !l.items.length) continue;
      const times = l.items.map((it) => it.start).sort((a, b) => a - b);
      out.push({ id: `loop-layer:${l.id}`, label: l.name, accent: l.color, freq: nextFreq(), times });
    }
    return out;
  }, [boundaryLayers, cueLayers, spanLayers, loopLayers]);

  // Time axis shared by every per-frame curve row. `frameCount` is the number
  // of STFT frames; the curve arrays are that long. See utils/frameTime for
  // why the frame's window CENTRE is the right x, not its index share.
  const curveFrameAxis = useMemo<FrameAxis | undefined>(() => {
    const hop = mirCurves?.hopSize, fft = mirCurves?.fftSize, sr = mirCurves?.sampleRate;
    const count = mirCurves?.energy?.length ?? 0;
    if (!hop || !fft || !sr || count <= 0) return undefined;
    return makeFrameAxis(hop, fft, sr, count);
  }, [mirCurves?.hopSize, mirCurves?.fftSize, mirCurves?.sampleRate, mirCurves?.energy]);

  const audioLayers = useMemo(
    () => [
      { id: 'autoGuess', times: autoGuessTimes, clickFreq: 3500, ...autoGuessAudio },
      ...userLayerAudioEntries.map((e) => {
        const cfg = layerAudioConfig?.[e.id] ?? DEFAULT_LAYER_AUDIO;
        return { id: e.id, times: e.times, clickFreq: e.freq, ...cfg };
      }),
    ],
    [autoGuessTimes, autoGuessAudio, userLayerAudioEntries, layerAudioConfig],
  );

  useBoundaryAudioFeedback(audioLayers, currentTime, playerIsPlaying, playbackRate ?? 1);

  // Layers eligible for the audio mixer row: only those currently rendered with data.
  const audioMixerLayers = useMemo(() => {
    const out: { id: string; label: string; accent: string; freq: number }[] = [];
    if (showAutoGuess && autoGuessTimes.length) out.push({ id: 'autoGuess', label: 'Auto-G', accent: '#a78bfa', freq: 3500 });
    for (const e of userLayerAudioEntries) {
      out.push({ id: e.id, label: e.label, accent: e.accent, freq: e.freq });
    }
    return out;
  }, [showAutoGuess, autoGuessTimes.length, userLayerAudioEntries]);

  if (!playerUrl) return null;

  // Release focus from a sidebar description input (cue/span/loop/
  // marker editors) the moment the user presses anywhere on the viz —
  // waveform, transport, markers, lane rows. Without this, the textarea
  // keeps focus and the next Space keystroke types into it instead of
  // hitting the global play/pause shortcut. Pointerdown, not mousedown: the
  // timeline's drag handles cancel their pointerdown, and a cancelled
  // pointerdown never produces a mousedown, so a mousedown listener here
  // would miss exactly the presses that start a drag.
  const blurTypingTargetOnPointerDown = useCallback(() => {
    const active = document.activeElement;
    if (isTypingTarget(active)) (active as HTMLElement).blur();
  }, []);

  return (
    <RowTitlesVerticalContext.Provider value={verticalRowTitles}>
    <GutterStripContext.Provider value={mobileStrip}>
    <div
      ref={panelRootRef}
      className={`bg-gray-900 rounded-xl overflow-hidden${mobileStrip ? ' tc-gutter-strip' : ''}`}
      onPointerDownCapture={blurTypingTargetOnPointerDown}
      onPointerDown={isMobile ? onGutterPointerDown : undefined}
      onClickCapture={isMobile ? onMobileLabelTap : undefined}
      style={{ ['--viz-label-w' as string]: `${gutterW}px` } as React.CSSProperties}
    >

      {rowSheet && (() => {
        const rid = rowSheet.rowId;
        const isSignal = !!rid && SIGNAL_ROW_IDS.has(rid);
        const order = visibleRowIds();
        const idx = rid ? order.indexOf(rid) : -1;
        const prev = idx > 0 ? order[idx - 1] : undefined;
        const next = idx >= 0 && idx < order.length - 1 ? order[idx + 1] : undefined;
        const close = () => setRowSheet(null);
        return (
          <MobileRowSheet
            target={rowSheet}
            onClose={close}
            shownSignals={shownSignalIds}
            size={rid ? rowSizes[rid] ?? 'M' : undefined}
            onSize={isSignal ? (sz) => setRowSizes((m) => ({ ...m, [rid!]: sz })) : undefined}
            onSwap={isSignal && onSetSignalShown ? (to) => {
              // The new signal takes this row's place, and the old one goes —
              // if the new one was already another row, it moves here.
              setRowSizes((m) => ({ ...m, [to]: m[rid!] ?? 'M' }));
              setRowMarks((m) => ({ ...m, [to]: m[rid!] ?? [] }));
              onSetSignalShown(to, true);
              onSetSignalShown(rid!, false);
              onReorderRow?.(to, rid!);
              setRowSheet({ rowId: to, name: SIGNAL_LABEL[to] ?? to, color: SIGNAL_COLOR[to] ?? rowSheet.color });
            } : undefined}
            onHide={isSignal && onSetSignalShown ? () => { onSetSignalShown(rid!, false); close(); } : undefined}
            markSources={isSignal ? markSources : undefined}
            markedKeys={rid ? rowMarks[rid] ?? [] : []}
            onToggleMark={isSignal ? (key) => setRowMarks((m) => {
              const cur = m[rid!] ?? [];
              return { ...m, [rid!]: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] };
            }) : undefined}
            onMoveUp={rid && prev && onReorderRow ? () => onReorderRow(rid, prev) : undefined}
            onMoveDown={rid && next && onReorderRow ? () => onReorderRow(next, rid) : undefined}
          />
        );
      })()}

      {/* ── Big timer + selection readout (Audacity-style) ── */}
      {!hideTimeDisplay && (
        <div className="flex items-stretch gap-2 pr-2 pt-2">
          <div className="w-[var(--viz-label-w,3.5rem)] shrink-0" />
          <div className="flex-1 min-w-0">
            <TimeDisplayBar
              currentTime={currentTime}
              pendingSelection={pendingSelection}
              previewRegion={previewRegion}
              showPlaybackIcon={!hidePlaybackIcon}
            />
          </div>
        </div>
      )}

      {/* The Manual-mode per-beat editor now overlays the waveform itself
          (see PlayerPanel's `gridMode === 'manual'` branch), so the
          previous dedicated strip here has been removed. */}

      {/* ── Player row — same horizontal alignment as viz rows ── */}
      <div className="flex items-stretch gap-2 pr-2 pt-2">
        <div className="w-[var(--viz-label-w,3.5rem)] shrink-0" />
        <div className="flex-1 min-w-0">
          {stemSource && availableStemSources && onStemSourceChange && (
            <StemSourcePicker
              value={stemSource}
              available={availableStemSources}
              onChange={onStemSourceChange}
              onRunStems={onRunStems}
              stemModel={stemModel}
              onStemModelChange={onStemModelChange}
              runStemsModel={runStemsModel}
              runStemsStatus={runStemsStatus}
              runStemsProgressPct={runStemsProgressPct}
              runStemsElapsedSec={runStemsElapsedSec}
              runStemsLastLine={runStemsLastLine}
              runStemsCancelMode={runStemsCancelMode}
              onCancelStems={onCancelStems}
              onKillStems={onKillStems}
              runStemsErrorTail={runStemsErrorTail}
              onDismissStemsError={onDismissStemsError}
              isSongLoaded={audioBuffer != null}
            />
          )}
          <PlayerPanel
            url={playerUrl}
            trackName={trackName}
            bpm={effectiveBeatGrid.bpm}
            timeSignature={timeSignature}
            beatOffset={beatOffset}
            beatsPerBar={effectiveBeatGrid.beatsPerBar}
            barGroupSize={effectiveBeatGrid.barGroupSize} beatGroupSize={effectiveBeatGrid.beatGroupSize} gridThickness={gridLineThickness}
            subBeatDivision={effectiveBeatGrid.subBeatDivision}
            onBufferReady={onBufferReady}
            onReady={onReady}
            onTimeUpdate={onTimeUpdate}
            onViewChange={onViewChange}
            seekRef={seekRef}
            playRef={playRef}
            pauseRef={pauseRef}
            getTimeRef={getTimeRef}
            externalTimeRef={externalTimeRef}
            wsScrollRef={wsScrollRef}
            zoomInRef={zoomInRef}
            zoomOutRef={zoomOutRef}
            zoomResetRef={zoomResetRef}
            getZoomFocusTime={getZoomFocusTime}
            pinchZoomInRef={pinchZoomInRef}
            pinchZoomOutRef={pinchZoomOutRef}
            scrollToTimeRef={scrollToTimeRef}
            zoomToRangeRef={zoomToRangeRef}
            onScrollChange={onScrollChange}
            onPlayingChange={onPlayingChange}
            playbackRate={playbackRate}
            accent={playerAccent}
            onGridOffsetChange={onGridOffsetChange}
            onGridOffsetDragStart={onGridOffsetDragStart}
            showBarNumbers={showBarNumbers}
            beatOverrides={beatOverrides}
            gridSegments={gridSegments}
            showGridSegmentLane={showGridSegmentLane}
            selectedSegmentId={selectedSegmentId}
            cutLabelSegmentId={cutLabelSegmentId}
            onSegmentSelect={onSegmentSelect}
            onSegmentHeadDrag={handleSegmentHeadDrag}
            onSegmentHeadDragEnd={() => setSegmentHeadDragTime(null)}
            onDeleteGridSegment={onDeleteGridSegment}
            onSplitGridAt={onSplitGridAt}
            snapSegmentTime={snapSegmentTime}
            segmentSnapOn={segmentSnapOn}
            // PlayerPanel's grid mode only gates the Hand-placed per-beat
            // editor, so it is narrowed here rather than taught the whole
            // union: Mapped has a lane, not a per-beat overlay.
            gridMode={gridMode === 'manual' ? 'manual' : undefined}
            onBeatDrag={onBeatDrag}
            onClearBeatOverride={onClearBeatOverride}
            manualEditLocked={manualEditLocked}
            pendingSelection={pendingSelection}
            previewRegion={previewRegion}
            onUserSeek={onVizClick}
            onUserRegion={onVizRegion}
            onPreviewEnd={onPreviewEnd}
            previewControls={previewRegion && onPreviewPlay && onPreviewPause && onPreviewLoopToggle && onPreviewDismiss ? {
              isPlaying: previewIsPlaying ?? playerIsPlaying,
              loop: previewRegion.loop,
              onPlay: onPreviewPlay,
              onPause: onPreviewPause,
              onLoopToggle: onPreviewLoopToggle,
              onDismiss: onPreviewDismiss,
            } : null}
          />
        </div>
      </div>

      {/* ── "Display options" disclosure — folds the layer-audio mixer and the
           section-color palette behind a single toggle so the timeline sits
           flush under the player. Both blocks live OUTSIDE the scroll container
           so their popovers/swatches aren't clipped and don't slide off-screen
           when the timeline is panned horizontally. ── */}
      {(() => {
        const showLayerAudioBlock = !!onLayerAudioChange && audioMixerLayers.length > 0;
        const showSectionColorBlock =
          visibleSectionTypes.length > 0
          || hasCustomRowOrder
          || (sectionColorOverrides != null && Object.keys(sectionColorOverrides).length > 0)
          || !!onBoundaryColoringModeChange;
        if (!showLayerAudioBlock && !showSectionColorBlock) return null;
        return (
          <div className="relative z-30">
            <div className="flex items-stretch gap-2 pr-2 pt-1">
              <div className="w-[var(--viz-label-w,3.5rem)] shrink-0" />
              <div className="flex-1 flex items-center">
                <button
                  onClick={toggleDisplayOptions}
                  aria-expanded={displayOptionsOpen}
                  className="flex items-center gap-1 text-[9px] text-gray-500 hover:text-gray-300 uppercase tracking-wide transition-colors"
                  title="Layer audio cues and section-color palette"
                >
                  <span className="inline-block w-2 text-center">{displayOptionsOpen ? '▾' : '▸'}</span>
                  <span aria-hidden>⚙</span>
                  Display options
                </button>
              </div>
            </div>

            {displayOptionsOpen && showLayerAudioBlock && (
              <div className="flex items-stretch gap-2 pr-2 pt-1">
                <div className="w-[var(--viz-label-w,3.5rem)] shrink-0" />
                <div className="flex-1 flex flex-wrap items-center gap-2">
                  <span
                    className="text-[9px] text-gray-500 uppercase tracking-wide"
                    title="Plays a short click pip whenever the playhead crosses a boundary in this layer. Useful for aurally checking annotation timing — try panning Manual to one ear and Auto-Guess to the other to hear the offset."
                  >
                    Layer audio:
                  </span>
                  {audioMixerLayers.map((l) => (
                    <LayerAudioControls
                      key={l.id}
                      label={l.label}
                      accentColor={l.accent}
                      testFreq={l.freq}
                      value={layerAudioConfig?.[l.id] ?? DEFAULT_LAYER_AUDIO}
                      onChange={(next) => onLayerAudioChange!(l.id, next)}
                    />
                  ))}
                </div>
              </div>
            )}

            {displayOptionsOpen && onBoundaryColoringModeChange && (
              <div className="flex items-stretch gap-2 pr-2 pt-1">
                <div className="w-[var(--viz-label-w,3.5rem)] shrink-0" />
                <div className="flex-1 flex flex-wrap items-center gap-2">
                  <span className="text-[9px] text-gray-500 uppercase tracking-wide">Boundary coloring:</span>
                  {(['by-type', 'alternating'] as BoundaryColoringMode[]).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => onBoundaryColoringModeChange(mode)}
                      className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                        (boundaryColoringMode ?? 'by-type') === mode
                          ? 'border-violet-500/60 text-violet-300 bg-violet-500/[0.12]'
                          : 'border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-400'
                      }`}
                    >
                      {mode === 'by-type' ? 'By type' : 'Alternating'}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {displayOptionsOpen && showSectionColorBlock && (
              <div className="flex items-stretch gap-2 pr-2 pt-1">
                <div className="w-[var(--viz-label-w,3.5rem)] shrink-0" />
                <div className="flex-1 flex flex-wrap items-center gap-2">
                  {visibleSectionTypes.length > 0 && onSectionColorChange && boundaryColoringMode !== 'alternating' && (
                    <>
                      <span className="text-[9px] text-gray-500 uppercase tracking-wide">Section colors:</span>
                      {visibleSectionTypes.map((type) => {
                        const current = sectionColorOverrides?.[type] ?? sectionBg(type);
                        return (
                          <label key={type} className="flex items-center gap-1 cursor-pointer" title={`Recolor "${type}" sections across all rows`}>
                            <span className="relative w-3 h-3 rounded-full border border-gray-700 shrink-0" style={{ backgroundColor: current }}>
                              <input
                                type="color"
                                value={current}
                                onChange={(e) => onSectionColorChange(type, e.target.value)}
                                className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                              />
                            </span>
                            <span className="text-[10px] text-gray-400">{type}</span>
                          </label>
                        );
                      })}
                    </>
                  )}
                  {(hasCustomRowOrder || (sectionColorOverrides && Object.keys(sectionColorOverrides).length > 0)) && (
                    <button
                      onClick={() => { onResetRowOrder?.(); onResetSectionColors?.(); }}
                      className="ml-auto text-[10px] text-gray-500 hover:text-gray-300 px-2 py-0.5 rounded border border-gray-800 hover:border-gray-700 transition-colors"
                      title="Reset row order and section colors to defaults"
                    >
                      ↺ Reset
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Scrollable viz rows (same horizontal alignment via pr-2 — no
           left padding, so the sticky label gutter sits flush at the panel's
           left edge; player/time-display rows above drop their left padding
           the same way to stay aligned) ── */}
      <div
        ref={vizScrollContainerRef}
        className="overflow-x-auto overflow-y-hidden overscroll-x-none pr-2 pb-2"
        style={{ scrollbarWidth: 'thin', scrollbarColor: '#374151 #111827' }}
        onScroll={onVizScroll}
      >
        {/* vizSignalWidth is the player's bare waveform width at this zoom. Add
            the sticky label gutter — labelColW (var(--viz-label-w)) plus the
            0.5rem gap folded into STICKY_LABEL_CELL — so every row's flex-1
            content column ends up exactly as wide as the player's waveform.
            Using a fixed gutter here instead of the real (resizable) labelColW
            drifts the cursor/highlight by (gutterError)·(t/duration) px. */}
        <div
          className="relative space-y-1 pt-1"
          style={{ minWidth: vizSignalWidth > 0 ? `${vizSignalWidth + gutterW + 8}px` : undefined }}
        >
          {/* Rows in configurable order */}
          {groupedRowOrder.map((rowId) => {
            const dragHandlers = makeDragHandlers(rowId);
            const dropProps = makeRowDropHandlers(rowId);
            const isDragging = draggedRowId === rowId;
            const isDropTarget = dropTargetRowId === rowId && draggedRowId !== rowId;
            // No `gap-2`: STICKY_LABEL_CELL is widened to include the gap, so
            // the label's solid bg butts directly against the content edge.
            const rowClass = `flex items-stretch transition-opacity ${isDragging ? 'opacity-40' : ''} ${isDropTarget ? 'bg-violet-900/20 ring-1 ring-violet-700/40 rounded' : ''}`;

            switch (rowId) {
              case 'waveform':
                if (!showWaveform) return null;
                return (
                  <div key="waveform" className={rowClass} {...dropProps}>
                    <RowLabel text="3-Band" color="text-blue-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
                        <div className="flex-1 min-w-0 overflow-hidden">
                      <TimeRuler duration={duration} height={16} />
                      <div ref={waveformBoxRef} className="relative">
                        <FrequencyWaveform
                          height={rowH('waveform', 70)}
                          audioBuffer={audioBuffer}
                          currentTime={currentTime}
                          duration={duration || undefined}
                          bpm={beatGrid.bpm}
                          beatOffset={beatOffset}
                          beatsPerBar={beatGrid.beatsPerBar}
                          barGroupSize={effectiveBeatGrid.barGroupSize} beatGroupSize={effectiveBeatGrid.beatGroupSize} gridThickness={gridLineThickness}
                          subBeatDivision={effectiveBeatGrid.subBeatDivision}
                          beatOverrides={beatOverrides}
                          segments={gridSegments}
                          onSeek={onVizClick}
                          onRegion={onVizRegion}
                          onRegionDragStart={onRegionDragStart}
                          onGridOffsetChange={onGridOffsetChange}
                          onGridOffsetDragStart={onGridOffsetDragStart}
                          snapToGrid={snapToGrid && !!beatGrid.bpm}
                          snapTimeOverride={snapTimeOverride}
                        />
                        <AnnotationOverlays
                          duration={duration}
                          currentTime={currentTime}
                          isPlaying={playerIsPlaying}
                          pendingSelection={pendingSelection}
                          grid={gridProps}
                        />
                        <SegmentDragCursorOverlay time={segmentHeadDragTime} duration={duration} />
                        <SignalMarksOverlay {...marksFor('waveform')} duration={duration} />
                      </div>
                    </div>
                  </div>
                );

              case 'eq':
                if (!showEQ) return null;
                return (
                  <div key="eq" className={rowClass} {...dropProps}>
                    <RowLabel text="EQ" color="text-blue-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
                    <div className="flex-1 min-w-0 relative overflow-hidden">
                      <EQVisualizer
                        height={rowH('eq', 54)}
                        mirCurves={mirCurves}
                        loading={mirComputing}
                        duration={duration}
                        currentTime={currentTime}
                        onSeek={onVizClick}
                        gridProps={gridProps}
                      />
                      <SegmentDragCursorOverlay time={segmentHeadDragTime} duration={duration} />
                      {pendingSelection && (
                        <PendingHighlightOverlay sel={pendingSelection} duration={duration} grid={gridProps} />
                      )}
                      <RegionDragOverlay duration={duration} onVizClick={onVizClick} onVizRegion={onVizRegion} onRegionDragStart={onRegionDragStart} />
                    </div>
                  </div>
                );

              // Who sits where in the mix, tier by tier. Derived from the same
              // prominence envelopes the annotation bands render, so it never
              // needs its own state — and it self-hides on songs with nothing
              // durational annotated. The row id stays `lead`: it is persisted
              // in the saved row order, and only the lane's scope grew.
              case 'lead':
                if (!showProminence) return null;
                if (!leadCandidates || leadCandidates.length === 0) return null;
                return (
                  <div key="lead" className={rowClass} {...dropProps}>
                    <RowLabel text="Prominence" color="text-emerald-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
                    <LeadLaneRow
                      candidates={leadCandidates}
                      duration={duration}
                      currentTime={currentTime}
                      gridProps={gridProps}
                      onSeek={onVizClick}
                      onRegionDragStart={onRegionDragStart}
                      onAssignLead={onAssignLead}
                      onSetLevel={onSetLevel}
                      onPendingRangeChange={onLeadRangeChange}
                    />
                  </div>
                );

              case 'autoGuess':
                if (!showAutoGuess) return null;
                return (
                  <div key="autoGuess" {...dropProps} className={`${isDragging ? 'opacity-40' : ''} ${isDropTarget ? 'bg-violet-900/20 ring-1 ring-violet-700/40 rounded' : ''}`}>
                    <div className="flex items-stretch">
                      <RowLabel text="Auto-guess" color="text-violet-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
                      <div className="flex-1 min-w-0 overflow-hidden flex items-stretch">
                        {autoGuessBlockSections.length > 0
                          ? <SectionBlockRow
                              sections={autoGuessBlockSections}
                              duration={duration}
                              currentTime={currentTime}
                              height={20}
                              gridProps={gridProps}
                              pendingSelection={pendingSelection}
                              onSectionClick={expandThreshold > 0 ? (i) => {
                                const sortedIds = [...(autoGuessPoints ?? [])].sort((a, b) => a.time - b.time);
                                const id = sortedIds[i]?.id;
                                if (id) toggleAutoGuessExpanded(id);
                              } : undefined}
                            />
                          : <div className="flex-1 h-5 rounded bg-gray-900/30 flex items-center px-2"><span className="text-[10px] text-gray-700 italic">no auto-guess annotation</span></div>
                        }
                      </div>
                    </div>
                    {autoGuessBlockSections.length > 0 && (
                      <div className="flex items-stretch">
                        {/* Opaque sticky gutter cell (matches the title column) so the
                            review overlay slides *behind* the labels when scrolled
                            horizontally, instead of over them. */}
                        <div className="w-[calc(var(--viz-label-w,3.5rem)_+_0.5rem)] shrink-0 sticky left-0 z-30 bg-gray-900" />
                        <div className="flex-1 min-w-0 overflow-hidden">
                          <AutoGuessOverlay
                            points={autoGuessPoints!}
                            duration={duration}
                            currentTime={currentTime}
                            isPlaying={playerIsPlaying}
                            onMarkCorrect={onMarkCorrect ?? (() => {})}
                            onMarkIncorrect={onMarkIncorrect ?? (() => {})}
                            onMarkPending={onMarkPending ?? (() => {})}
                            onPlay={handlePlay}
                            onPause={handlePause}
                            expandedPointIds={expandedAutoGuessPointIds}
                            onToggleExpanded={toggleAutoGuessExpanded}
                            expandZoomThreshold={expandThreshold}
                            zoomFactor={vizZoomFactor}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );

              case 'merge': {
                if (!onMergeAddLane) return null;
                const lanes = mergeLanes ?? [];
                const merged = mergeBoundaries ?? [];
                // The row exists to blend boundary ALGO lanes, so it appears
                // exactly when there is something to blend — one on the canvas,
                // or members already picked. Otherwise (the Annotator and
                // Dataprep, where no algo lane is drawn) it would be a
                // permanent empty strip inviting a drag that has no source.
                const hasBoundaryAlgoLane = algoOverlays.some((o) => (o.renderKind ?? 'boundary') === 'boundary');
                if (lanes.length === 0 && !hasBoundaryAlgoLane) return null;
                // A lane being dragged over this row means "add to the merge",
                // not "reorder to here" — so the row swaps out the shared
                // reorder drop handlers for its own whenever the thing in
                // flight is a boundary algo lane that isn't already a member.
                const dragged = draggedRowId ? algoOverlays.find((o) => o.id === draggedRowId) : undefined;
                const draggedIsMergeable = !!dragged
                  && (dragged.renderKind ?? 'boundary') === 'boundary'
                  && !lanes.some((l) => l.id === dragged.id);
                const mergeDrop = draggedIsMergeable ? {
                  onDragOver: (e: React.DragEvent) => {
                    e.preventDefault();
                    // 'move' to match the drag's effectAllowed — a dropEffect
                    // the drag didn't allow makes the browser skip the drop
                    // event entirely, with no error anywhere.
                    e.dataTransfer.dropEffect = 'move';
                    if (dropTargetRowId !== 'merge') setDropTargetRowId('merge');
                  },
                  onDragLeave: () => { if (dropTargetRowId === 'merge') setDropTargetRowId(null); },
                  onDrop: (e: React.DragEvent) => {
                    e.preventDefault();
                    setDropTargetRowId(null);
                    onMergeAddLane(dragged!.id);
                    setDraggedRowId(null);
                  },
                } : dropProps;
                const keptCount = merged.filter((b) => b.kept).length;
                return (
                  <div key="merge" {...mergeDrop} className={isDragging ? 'opacity-40' : ''}>
                    <div className="flex items-stretch">
                      <MergeLaneRow
                        merged={merged}
                        memberLanes={lanes}
                        duration={duration}
                        currentTime={currentTime}
                        dragHandlers={dragHandlers}
                        onResizeStart={handleLabelColResizeStart}
                        gridProps={gridProps}
                        isDropTarget={draggedIsMergeable && dropTargetRowId === 'merge'}
                        onToggleBoundary={onMergeToggleBoundary}
                      />
                    </div>
                    {lanes.length > 0 && (
                      <div className="flex items-stretch">
                        {/* Opaque sticky gutter cell so the control strip slides
                            behind the labels on a horizontal scroll. */}
                        <div className="w-[calc(var(--viz-label-w,3.5rem)_+_0.5rem)] shrink-0 sticky left-0 z-30 bg-gray-900" />
                        <div className="flex-1 min-w-0">
                          <MergeControlsBar
                            lanes={lanes}
                            onRemoveLane={onMergeRemoveLane ?? (() => {})}
                            onClear={onMergeClear ?? (() => {})}
                            onCommit={onMergeCommit ?? (() => {})}
                            onRestoreDropped={onMergeRestoreDropped ?? (() => {})}
                            keptCount={keptCount}
                            totalCount={merged.length}
                            droppedCount={merged.length - keptCount}
                            committedCount={mergeCommittedCount}
                            committedNote={mergeCommittedNote}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              }

              // The consensus the Algorithm-Inspect stage built, on the same
              // timeline as its ingredients. The stage keeps the knobs.
              case 'consensus': {
                if (!consensusBlocks || consensusBlocks.length === 0) return null;
                return (
                  <div key="consensus" className={rowClass} {...dropProps}>
                    <ConsensusLaneRow
                      blocks={consensusBlocks}
                      refMisses={consensusRefMisses}
                      duration={duration}
                      currentTime={currentTime}
                      referenceLabel={consensusReferenceLabel}
                      tolerance={consensusTolerance}
                      dragHandlers={dragHandlers}
                      onResizeStart={handleLabelColResizeStart}
                      gridProps={gridProps}
                      onSeek={onVizClick}
                      onHide={onHideConsensus}
                      onCopy={onCopyConsensus}
                      existingCopyCount={consensusCopyCount}
                    />
                  </div>
                );
              }

              case 'spectrogram':
                if (!showSpectrogram || !audioBuffer) return null;
                return (
                  <div key="spectrogram" className={rowClass} {...dropProps}>
                    <RowLabel text="Spectro" color="text-violet-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
                    <div className="flex-1 min-w-0 overflow-hidden">
                      <TimeRuler duration={duration} height={16} />
                      <div className="relative">
                        <SpectrogramAnnotated
                          audioBuffer={audioBuffer}
                          sections={[]}
                          duration={duration}
                          currentTime={currentTime}
                          height={rowH('spectrogram', 80)}
                          bpm={beatGrid.bpm}
                          beatOffset={beatOffset}
                          beatsPerBar={beatGrid.beatsPerBar}
                          barGroupSize={effectiveBeatGrid.barGroupSize} beatGroupSize={effectiveBeatGrid.beatGroupSize} gridThickness={gridLineThickness}
                          subBeatDivision={effectiveBeatGrid.subBeatDivision}
                        />
                        <SpectrogramDragOverlay
                          duration={duration}
                          currentTime={currentTime}
                          pendingSelection={pendingSelection}
                          onVizClick={onVizClick}
                          onVizRegion={onVizRegion}
                          onRegionDragStart={onRegionDragStart}
                          snapToGrid={snapToGrid && !!beatGrid.bpm}
                          snapDivision={showBeatGrid && beatGridUnit ? beatGridUnitToSnapDivision(beatGridUnit) : 'beat'}
                          snapTimeOverride={snapTimeOverride}
                          bpm={beatGrid.bpm}
                          beatOffset={beatOffset}
                          beatsPerBar={beatGrid.beatsPerBar}
                          beatOverrides={beatOverrides}
                        />
                        <SegmentDragCursorOverlay time={segmentHeadDragTime} duration={duration} />
                        <SignalMarksOverlay {...marksFor('spectrogram')} duration={duration} />
                      </div>
                    </div>
                  </div>
                );

              case 'cepstrogram': {
                if (!showCepstrogram || !mirCurves?.mfcc || !mirCurves.nMfcc || !mirCurves.frameCount) return null;
                return (
                  <div key="cepstrogram" className={rowClass} {...dropProps}>
                    <RowLabel text="MFCC" color="text-violet-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
                    <div className="flex-1 min-w-0 relative overflow-hidden">
                      <CepstrogramAnnotated
                        hopSize={mirCurves.hopSize}
                        fftSize={mirCurves.fftSize}
                        sampleRate={mirCurves.sampleRate}
                        mfcc={mirCurves.mfcc}
                        nMfcc={mirCurves.nMfcc}
                        frameCount={mirCurves.frameCount}
                        duration={duration}
                        currentTime={currentTime}
                        height={rowH('cepstrogram', 70)}
                        bpm={beatGrid.bpm}
                        beatOffset={beatOffset}
                        beatsPerBar={beatGrid.beatsPerBar}
                        barGroupSize={effectiveBeatGrid.barGroupSize} beatGroupSize={effectiveBeatGrid.beatGroupSize} gridThickness={gridLineThickness}
                        subBeatDivision={effectiveBeatGrid.subBeatDivision}
                      />
                      <SegmentDragCursorOverlay time={segmentHeadDragTime} duration={duration} />
                      <SignalMarksOverlay {...marksFor('cepstrogram')} duration={duration} />
                      {pendingSelection && (
                        <PendingHighlightOverlay sel={pendingSelection} duration={duration} grid={gridProps} />
                      )}
                      <RegionDragOverlay duration={duration} onVizClick={onVizClick} onVizRegion={onVizRegion} onRegionDragStart={onRegionDragStart} />
                    </div>
                  </div>
                );
              }

              case 'chroma': {
                if (!showChroma || !mirCurves?.chroma || !mirCurves.nChroma || !mirCurves.frameCount) return null;
                return (
                  <div key="chroma" className={rowClass} {...dropProps}>
                    <RowLabel text="Chroma" color="text-lime-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
                    <div className="flex-1 min-w-0 relative overflow-hidden">
                      <ChromagramAnnotated
                        hopSize={mirCurves.hopSize}
                        fftSize={mirCurves.fftSize}
                        sampleRate={mirCurves.sampleRate}
                        chroma={mirCurves.chroma}
                        nChroma={mirCurves.nChroma}
                        frameCount={mirCurves.frameCount}
                        duration={duration}
                        currentTime={currentTime}
                        height={rowH('chroma', 80)}
                        bpm={beatGrid.bpm}
                        beatOffset={beatOffset}
                        beatsPerBar={beatGrid.beatsPerBar}
                        barGroupSize={effectiveBeatGrid.barGroupSize} beatGroupSize={effectiveBeatGrid.beatGroupSize} gridThickness={gridLineThickness}
                      />
                      <SegmentDragCursorOverlay time={segmentHeadDragTime} duration={duration} />
                      <SignalMarksOverlay {...marksFor('chroma')} duration={duration} />
                      {pendingSelection && (
                        <PendingHighlightOverlay sel={pendingSelection} duration={duration} grid={gridProps} />
                      )}
                      <RegionDragOverlay duration={duration} onVizClick={onVizClick} onVizRegion={onVizRegion} onRegionDragStart={onRegionDragStart} />
                    </div>
                  </div>
                );
              }

              case 'tempogram': {
                if (!showTempogram || !mirCurves?.tempogram || !mirCurves.nTempo || !mirCurves.tempogramFrameCount || !mirCurves.tempoBpm) return null;
                return (
                  <div key="tempogram" className={rowClass} {...dropProps}>
                    <RowLabel text="Tempo" color="text-fuchsia-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
                    <div className="flex-1 min-w-0 relative overflow-hidden">
                      <TempogramAnnotated
                        hopSize={mirCurves.hopSize}
                        fftSize={mirCurves.fftSize}
                        sampleRate={mirCurves.sampleRate}
                        tempogram={mirCurves.tempogram}
                        nTempo={mirCurves.nTempo}
                        tempogramFrameCount={mirCurves.tempogramFrameCount}
                        tempoBpm={mirCurves.tempoBpm}
                        duration={duration}
                        currentTime={currentTime}
                        height={rowH('tempogram', 90)}
                        bpm={beatGrid.bpm}
                        beatOffset={beatOffset}
                        beatsPerBar={beatGrid.beatsPerBar}
                        barGroupSize={effectiveBeatGrid.barGroupSize} beatGroupSize={effectiveBeatGrid.beatGroupSize} gridThickness={gridLineThickness}
                      />
                      <SegmentDragCursorOverlay time={segmentHeadDragTime} duration={duration} />
                      <SignalMarksOverlay {...marksFor('tempogram')} duration={duration} />
                      {pendingSelection && (
                        <PendingHighlightOverlay sel={pendingSelection} duration={duration} grid={gridProps} />
                      )}
                      <RegionDragOverlay duration={duration} onVizClick={onVizClick} onVizRegion={onVizRegion} onRegionDragStart={onRegionDragStart} />
                    </div>
                  </div>
                );
              }

              case 'ssm': {
                if (!showSsm || !mirCurves?.ssm || !mirCurves.ssmFrameCount) return null;
                return (
                  <div key="ssm" className={rowClass} {...dropProps}>
                    <RowLabel text="SSM" color="text-orange-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
                    <div className="flex-1 min-w-0 relative overflow-hidden">
                      <SsmAnnotated
                        hopSize={mirCurves.hopSize}
                        fftSize={mirCurves.fftSize}
                        sampleRate={mirCurves.sampleRate}
                        ssm={mirCurves.ssm}
                        ssmFrameCount={mirCurves.ssmFrameCount}
                        duration={duration}
                        currentTime={currentTime}
                        height={rowH('ssm', 180)}
                        bpm={beatGrid.bpm}
                        beatOffset={beatOffset}
                        beatsPerBar={beatGrid.beatsPerBar}
                        barGroupSize={effectiveBeatGrid.barGroupSize} beatGroupSize={effectiveBeatGrid.beatGroupSize} gridThickness={gridLineThickness}
                      />
                      <SegmentDragCursorOverlay time={segmentHeadDragTime} duration={duration} />
                      <SignalMarksOverlay {...marksFor('ssm')} duration={duration} />
                      {pendingSelection && (
                        <PendingHighlightOverlay sel={pendingSelection} duration={duration} grid={gridProps} />
                      )}
                      <RegionDragOverlay duration={duration} onVizClick={onVizClick} onVizRegion={onVizRegion} onRegionDragStart={onRegionDragStart} />
                    </div>
                  </div>
                );
              }

              case 'energy':
                if (!showEnergy) return null;
                return <div key="energy" className={rowClass} {...dropProps}><Sparkline overlay={<SignalMarksOverlay {...marksFor('energy')} duration={duration} />} label="Energy" data={mirCurves?.energy ?? EMPTY_CURVE} loading={mirComputing} color="#f59e0b" height={rowH('energy', 40)} currentTime={currentTime} duration={duration} onSeek={onVizClick} onRegion={onVizRegion} onRegionDragStart={onRegionDragStart} dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} pendingSelection={pendingSelection} dragCursorTime={segmentHeadDragTime} gridProps={gridProps} frameAxis={curveFrameAxis} /></div>;

              case 'brightness':
                if (!showBrightness) return null;
                return <div key="brightness" className={rowClass} {...dropProps}><Sparkline overlay={<SignalMarksOverlay {...marksFor('brightness')} duration={duration} />} label="Bright" signalName="Brightness" data={mirCurves?.spectral ?? EMPTY_CURVE} loading={mirComputing} color="#22d3ee" height={rowH('brightness', 36)} currentTime={currentTime} duration={duration} onSeek={onVizClick} onRegion={onVizRegion} onRegionDragStart={onRegionDragStart} dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} pendingSelection={pendingSelection} dragCursorTime={segmentHeadDragTime} gridProps={gridProps} frameAxis={curveFrameAxis} /></div>;

              case 'novelty':
                if (!showNovelty) return null;
                return <div key="novelty" className={rowClass} {...dropProps}><Sparkline overlay={<SignalMarksOverlay {...marksFor('novelty')} duration={duration} />} label="Novelty" data={mirCurves?.novelty ?? EMPTY_CURVE} loading={mirComputing} color="#a78bfa" height={rowH('novelty', 36)} currentTime={currentTime} duration={duration} onSeek={onVizClick} onRegion={onVizRegion} onRegionDragStart={onRegionDragStart} dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} pendingSelection={pendingSelection} dragCursorTime={segmentHeadDragTime} gridProps={gridProps} frameAxis={curveFrameAxis} /></div>;

              case 'onsets':
                if (!showOnsets) return null;
                return <div key="onsets" className={rowClass} {...dropProps}><Sparkline overlay={<SignalMarksOverlay {...marksFor('onsets')} duration={duration} />} label="Onsets" data={mirCurves?.onsets ?? EMPTY_CURVE} loading={mirComputing} color="#f472b6" height={rowH('onsets', 32)} currentTime={currentTime} duration={duration} onSeek={onVizClick} onRegion={onVizRegion} onRegionDragStart={onRegionDragStart} dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} pendingSelection={pendingSelection} dragCursorTime={segmentHeadDragTime} gridProps={gridProps} frameAxis={curveFrameAxis} /></div>;

              case 'flux':
                if (!showFlux) return null;
                return <div key="flux" className={rowClass} {...dropProps}><Sparkline overlay={<SignalMarksOverlay {...marksFor('flux')} duration={duration} />} label="Flux" signalName="Spectral Flux" data={mirCurves?.flux ?? EMPTY_CURVE} loading={mirComputing} color="#10b981" height={rowH('flux', 32)} currentTime={currentTime} duration={duration} onSeek={onVizClick} onRegion={onVizRegion} onRegionDragStart={onRegionDragStart} dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} pendingSelection={pendingSelection} dragCursorTime={segmentHeadDragTime} gridProps={gridProps} frameAxis={curveFrameAxis} /></div>;

              default: {
                // A group's header band. Emitted by buildGroupedRowOrder, never
                // present in the stored row order.
                if (rowId.startsWith(GROUP_ROW_PREFIX)) {
                  const groupId = rowId.slice(GROUP_ROW_PREFIX.length);
                  const group = layerGroups?.find((g) => g.id === groupId);
                  if (!group) return null;
                  const state = groupState?.[groupId];
                  return (
                    <div key={rowId} className={rowClass} {...dropProps}>
                      <GroupHeaderRow
                        group={group}
                        memberCount={state?.count ?? 0}
                        visibility={state?.visibility ?? 'none'}
                        onToggleCollapsed={() => onGroupToggleCollapsed?.(groupId)}
                        onSetVisible={(visible) => onGroupSetVisible?.(groupId, visible)}
                        onRename={onGroupRename ? (name) => onGroupRename(groupId, name) : undefined}
                        onUngroup={onGroupUngroup ? () => onGroupUngroup(groupId) : undefined}
                        onDelete={onGroupDelete ? () => onGroupDelete(groupId) : undefined}
                        dragHandlers={dragHandlers}
                        onResizeStart={handleLabelColResizeStart}
                        isDropTarget={isDropTarget}
                      />
                    </div>
                  );
                }
                // User-created Riff-pattern layer row.
                if (rowId.startsWith('riff-layer:')) {
                  const layer = riffPatternLayers?.find((l) => `riff-layer:${l.id}` === rowId);
                  if (!layer || !layer.visible) return null;
                  const { isSelected, onSelect, onRename } = layerSelectionFor('riff-patterns', layer);
                  return (
                    <div key={rowId} className={rowClass} {...dropProps}>
                      <LayerRowLabel
                        groupColor={groupColorForRow(rowId)}
                        groupMenu={groupMenuForRow(rowId, layer)}
                        layer={layer}
                        auditionedStem={stemSource}
                        isSelected={isSelected}
                        onSelect={onSelect}
                        onRename={onRename}
                        dragHandlers={dragHandlers}
                        onResizeStart={handleLabelColResizeStart}
                      />
                      <div
                        className={`flex-1 min-w-0 flex items-stretch ${isSelected ? 'rounded-sm' : ''}`}
                        style={isSelected ? { boxShadow: `0 0 0 1px ${layer.color}aa, 0 0 14px ${layer.color}55`, clipPath: 'inset(-16px -16px -16px 0)' } : undefined}
                      >
                        <RiffPatternLaneRow
                          layer={layer}
                          duration={duration}
                          currentTime={currentTime}
                          focusedItemId={focusedRiffPattern?.layerId === layer.id ? focusedRiffPattern.itemId : null}
                          prominenceEditItemId={riffPatternProminenceEdit?.layerId === layer.id ? riffPatternProminenceEdit.itemId : null}
                          onProminenceChange={onRiffPatternProminenceChange
                            ? (itemId, points) => onRiffPatternProminenceChange(layer.id, itemId, points)
                            : undefined}
                          snapProminenceTime={snapProminenceTime}
                          onItemClick={(itemId, anchor) => onRiffPatternItemClick?.(layer.id, itemId, anchor)}
                          onEntryClick={(itemId, entryIndex, nodeId, anchor) => onRiffPatternEntryClick?.(layer.id, itemId, entryIndex, nodeId, anchor)}
                          onEntryResize={(itemId, entryIndex, newLengthSteps, gestureKey) => onRiffPatternEntryResize?.(layer.id, itemId, entryIndex, newLengthSteps, gestureKey)}
                          onEntryTrimNode={onRiffNodeTrim ? (nodeId, lengthBeats, gestureKey) => onRiffNodeTrim(layer.id, nodeId, lengthBeats, gestureKey) : undefined}
                          onItemMove={onRiffPatternItemMove
                            ? (itemId, ns, ne) => onRiffPatternItemMove(layer.id, itemId, ns, ne)
                            : undefined}
                          onItemMoveStart={onRiffPatternItemMoveStart
                            ? (itemId) => onRiffPatternItemMoveStart(layer.id, itemId)
                            : undefined}
                          gridProps={gridProps}
                          pendingSelection={pendingSelection}
                          onSeek={onVizClick}
                          onRegion={onVizRegion}
                          onRegionDragStart={onRegionDragStart}
                        />
                      </div>
                    </div>
                  );
                }
                // User-created Span layer row. Spans MAY overlap, so the
                // row uses lane-assignment rendering (variable height).
                // User-created Boundary layer row. Boundaries tile, so the
                // lane is the same contiguous section-block strip the fixed
                // "Boundaries" row used to draw — now once per layer, wearing
                // the standard layer label (select ring, inline rename, ⓘ).
                if (rowId.startsWith('boundary-layer:')) {
                  const layer = boundaryLayers?.find((l) => `boundary-layer:${l.id}` === rowId);
                  if (!layer || !layer.visible) return null;
                  const blocks = boundaryBlocksByLayer.get(layer.id) ?? [];
                  const { isSelected, onSelect, onRename } = layerSelectionFor('boundaries', layer);
                  return (
                    <div key={rowId} className={rowClass} {...dropProps}>
                      <LayerRowLabel
                        groupColor={groupColorForRow(rowId)}
                        groupMenu={groupMenuForRow(rowId, layer)}
                        layer={layer}
                        auditionedStem={stemSource}
                        isSelected={isSelected}
                        onSelect={onSelect}
                        onRename={onRename}
                        dragHandlers={dragHandlers}
                        onResizeStart={handleLabelColResizeStart}
                        onCopyToManual={layer.readOnly && onCopyDetectorLayer ? () => onCopyDetectorLayer(layer) : undefined}
                        existingCopyCount={layer.readOnly ? (detectorLayerCopyCounts?.[layer.id] ?? 0) : 0}
                      />
                      <div
                        className={`flex-1 min-w-0 flex items-stretch ${isSelected ? 'rounded-sm' : ''}`}
                        style={isSelected ? { boxShadow: `0 0 0 1px ${layer.color}aa, 0 0 14px ${layer.color}55`, clipPath: 'inset(-16px -16px -16px 0)' } : undefined}
                      >
                        <SectionBlockRow
                          sections={blocks}
                          duration={duration}
                          currentTime={currentTime}
                          onBoundaryChange={layer.readOnly || !onManualBoundaryChange
                            ? undefined
                            : (idx, t) => onManualBoundaryChange(layer.id, idx, t)}
                          onBoundaryDragStart={onManualBoundaryDragStart}
                          onSectionClick={onManualSectionClick
                            ? (idx, anchor) => onManualSectionClick(layer.id, idx, anchor)
                            : undefined}
                          sectionColorOverrides={sectionColorOverrides}
                          boundaryColoringMode={boundaryColoringMode}
                          gridProps={gridProps}
                          pendingSelection={pendingSelection}
                        />
                      </div>
                    </div>
                  );
                }

                if (rowId.startsWith('span-layer:')) {
                  const layer = spanLayers?.find((l) => `span-layer:${l.id}` === rowId);
                  if (!layer || !layer.visible) return null;
                  const { isSelected, onSelect, onRename } = layerSelectionFor('spans', layer);
                  return (
                    <div
                      key={rowId}
                      className={rowClass}
                      {...dropProps}
                    >
                      <LayerRowLabel
                        groupColor={groupColorForRow(rowId)}
                        groupMenu={groupMenuForRow(rowId, layer)}
                        layer={layer}
                        auditionedStem={stemSource}
                        isSelected={isSelected}
                        onSelect={onSelect}
                        onRename={onRename}
                        onCopyToManual={layer.readOnly && onCopyDetectorLayer ? () => onCopyDetectorLayer(layer) : undefined}
                        existingCopyCount={layer.readOnly ? (detectorLayerCopyCounts?.[layer.id] ?? 0) : 0}
                        dragHandlers={dragHandlers}
                        onResizeStart={handleLabelColResizeStart}
                        karaokeActive={karaokeLayerIds.has(layer.id)}
                        onKaraokeToggle={() => toggleKaraokeLayer(layer.id)}
                      />
                      <div
                        className={`flex-1 min-w-0 flex items-stretch ${isSelected ? 'rounded-sm' : ''}`}
                        style={isSelected ? { boxShadow: `0 0 0 1px ${layer.color}aa, 0 0 14px ${layer.color}55`, clipPath: 'inset(-16px -16px -16px 0)' } : undefined}
                      >
                      <SpanLaneRow
                        onSeek={onVizClick}
                        onRegion={onVizRegion}
                        onRegionDragStart={onRegionDragStart}
                        items={layer.items}
                        color={layer.color}
                        duration={duration}
                        currentTime={currentTime}
                        karaokeActive={karaokeLayerIds.has(layer.id)}
                        focusedItemId={focusedSpan?.layerId === layer.id ? focusedSpan.itemId : null}
                        prominenceEditItemId={spanProminenceEdit?.layerId === layer.id ? spanProminenceEdit.itemId : null}
                        onSpanClick={(itemId, anchor) => onSpanClick?.(layer.id, itemId, anchor)}
                        onSpanEdgeDrag={onSpanEdgeDrag
                          ? (itemId, edge, time) => onSpanEdgeDrag(layer.id, itemId, edge, time)
                          : undefined}
                        onSpanEdgeDragStart={onSpanEdgeDragStart
                          ? (itemId, edge) => onSpanEdgeDragStart(layer.id, itemId, edge)
                          : undefined}
                        onSpanMove={onSpanMove
                          ? (itemId, ns, ne) => onSpanMove(layer.id, itemId, ns, ne)
                          : undefined}
                        onSpanMoveStart={onSpanMoveStart
                          ? (itemId) => onSpanMoveStart(layer.id, itemId)
                          : undefined}
                        onProminenceChange={onSpanProminenceChange
                          ? (itemId, points) => onSpanProminenceChange(layer.id, itemId, points)
                          : undefined}
                        snapProminenceTime={snapProminenceTime}
                        gridProps={gridProps}
                        pendingSelection={pendingSelection}
                        reviewState={detectorLayerReview?.[layer.id]}
                        onAccept={(itemId) => onDetectorLayerAccept?.(layer.id, itemId)}
                        onReject={(itemId) => onDetectorLayerReject?.(layer.id, itemId)}
                      />
                      </div>
                    </div>
                  );
                }
                // User-created Loop layer row. Each Loop layer renders as
                // interval bands; clicking a band fires onLoopClick.
                if (rowId.startsWith('loop-layer:')) {
                  const layer = loopLayers?.find((l) => `loop-layer:${l.id}` === rowId);
                  if (!layer || !layer.visible) return null;
                  const { isSelected, onSelect, onRename } = layerSelectionFor('loops', layer);
                  return (
                    <div
                      key={rowId}
                      className={rowClass}
                      {...dropProps}
                    >
                      <LayerRowLabel
                        groupColor={groupColorForRow(rowId)}
                        groupMenu={groupMenuForRow(rowId, layer)}
                        layer={layer}
                        auditionedStem={stemSource}
                        isSelected={isSelected}
                        onSelect={onSelect}
                        onRename={onRename}
                        dragHandlers={dragHandlers}
                        onResizeStart={handleLabelColResizeStart}
                        onCopyToManual={layer.readOnly && onCopyDetectorLayer ? () => onCopyDetectorLayer(layer) : undefined}
                        existingCopyCount={layer.readOnly ? (detectorLayerCopyCounts?.[layer.id] ?? 0) : 0}
                        karaokeActive={karaokeLayerIds.has(layer.id)}
                        onKaraokeToggle={() => toggleKaraokeLayer(layer.id)}
                      />
                      <div
                        className={`flex-1 min-w-0 flex items-stretch ${isSelected ? 'rounded-sm' : ''}`}
                        style={isSelected ? { boxShadow: `0 0 0 1px ${layer.color}aa, 0 0 14px ${layer.color}55`, clipPath: 'inset(-16px -16px -16px 0)' } : undefined}
                      >
                      <LoopLayerRow
                        onSeek={onVizClick}
                        onRegion={onVizRegion}
                        onRegionDragStart={onRegionDragStart}
                        items={layer.items}
                        color={layer.color}
                        duration={duration}
                        currentTime={currentTime}
                        karaokeActive={karaokeLayerIds.has(layer.id)}
                        focusedItemId={focusedLoop?.layerId === layer.id ? focusedLoop.itemId : null}
                        prominenceEditItemId={loopProminenceEdit?.layerId === layer.id ? loopProminenceEdit.itemId : null}
                        onProminenceChange={onLoopProminenceChange
                          ? (itemId, points) => onLoopProminenceChange(layer.id, itemId, points)
                          : undefined}
                        snapProminenceTime={snapProminenceTime}
                        playingItemId={playingLoopId ?? null}
                        onLoopClick={(itemId, anchor) => onLoopClick?.(layer.id, itemId, anchor)}
                        onLoopEdgeDrag={onLoopEdgeDrag
                          ? (itemId, edge, time) => onLoopEdgeDrag(layer.id, itemId, edge, time)
                          : undefined}
                        onLoopEdgeDragStart={onLoopEdgeDragStart
                          ? (itemId, edge) => onLoopEdgeDragStart(layer.id, itemId, edge)
                          : undefined}
                        onLoopMove={onLoopMove
                          ? (itemId, ns, ne) => onLoopMove(layer.id, itemId, ns, ne)
                          : undefined}
                        onLoopMoveStart={onLoopMoveStart
                          ? (itemId) => onLoopMoveStart(layer.id, itemId)
                          : undefined}
                        gridProps={gridProps}
                        pendingSelection={pendingSelection}
                        reviewState={detectorLayerReview?.[layer.id]}
                        onAccept={(itemId) => onDetectorLayerAccept?.(layer.id, itemId)}
                        onReject={(itemId) => onDetectorLayerReject?.(layer.id, itemId)}
                      />
                      </div>
                    </div>
                  );
                }
                // User-created Cue layer row. Each Cue layer renders as a single
                // tick-mark row; clicking a tick fires onCueClick so the parent
                // can open the inline edit popover.
                if (rowId.startsWith('cue-layer:')) {
                  const layer = cueLayers?.find((l) => `cue-layer:${l.id}` === rowId);
                  if (!layer || !layer.visible) return null;
                  const { isSelected, onSelect, onRename } = layerSelectionFor('cues', layer);
                  return (
                    <div
                      key={rowId}
                      className={rowClass}
                      {...dropProps}
                    >
                      <LayerRowLabel
                        groupColor={groupColorForRow(rowId)}
                        groupMenu={groupMenuForRow(rowId, layer)}
                        layer={layer}
                        auditionedStem={stemSource}
                        isSelected={isSelected}
                        onSelect={onSelect}
                        onRename={onRename}
                        dragHandlers={dragHandlers}
                        onResizeStart={handleLabelColResizeStart}
                        onCopyToManual={layer.readOnly && onCopyDetectorLayer ? () => onCopyDetectorLayer(layer) : undefined}
                        existingCopyCount={layer.readOnly ? (detectorLayerCopyCounts?.[layer.id] ?? 0) : 0}
                        karaokeActive={karaokeLayerIds.has(layer.id)}
                        onKaraokeToggle={() => toggleKaraokeLayer(layer.id)}
                      />
                      <div
                        className={`flex-1 min-w-0 flex items-stretch ${isSelected ? 'rounded-sm' : ''}`}
                        style={isSelected ? { boxShadow: `0 0 0 1px ${layer.color}aa, 0 0 14px ${layer.color}55`, clipPath: 'inset(-16px -16px -16px 0)' } : undefined}
                      >
                        <CueLayerRow
                          onSeek={onVizClick}
                          onRegion={onVizRegion}
                          onRegionDragStart={onRegionDragStart}
                          items={layer.items}
                          color={layer.color}
                          duration={duration}
                          currentTime={currentTime}
                          karaokeActive={karaokeLayerIds.has(layer.id)}
                          focusedItemId={focusedCue?.layerId === layer.id ? focusedCue.itemId : null}
                          onCueClick={(itemId, anchor) => onCueClick?.(layer.id, itemId, anchor)}
                          onCueDrag={onCueDrag
                            ? (itemId, time) => onCueDrag(layer.id, itemId, time)
                            : undefined}
                          onCueDragStart={onCueDragStart
                            ? (itemId) => onCueDragStart(layer.id, itemId)
                            : undefined}
                          gridProps={gridProps}
                          pendingSelection={pendingSelection}
                          reviewState={detectorLayerReview?.[layer.id]}
                          onAccept={(itemId) => onDetectorLayerAccept?.(layer.id, itemId)}
                          onReject={(itemId) => onDetectorLayerReject?.(layer.id, itemId)}
                        />
                      </div>
                    </div>
                  );
                }
                if (rowId.startsWith('lyrics-layer:')) {
                  const layer = lyricsLayers?.find((l) => `lyrics-layer:${l.id}` === rowId);
                  if (!layer || !layer.visible) return null;
                  const { isSelected, onSelect, onRename } = layerSelectionFor('lyrics', layer);
                  return (
                    <div key={rowId} className={rowClass} {...dropProps}>
                      <LayerRowLabel
                        groupColor={groupColorForRow(rowId)}
                        groupMenu={groupMenuForRow(rowId, layer)}
                        layer={layer}
                        auditionedStem={stemSource}
                        isSelected={isSelected}
                        onSelect={onSelect}
                        onRename={onRename}
                        dragHandlers={dragHandlers}
                        onResizeStart={handleLabelColResizeStart}
                        onCopyToManual={layer.readOnly && onCopyDetectorLayer ? () => onCopyDetectorLayer(layer) : undefined}
                        existingCopyCount={layer.readOnly ? (detectorLayerCopyCounts?.[layer.id] ?? 0) : 0}
                        karaokeActive={karaokeLayerIds.has(layer.id)}
                        onKaraokeToggle={() => toggleKaraokeLayer(layer.id)}
                      />
                      <div className="flex-1 min-w-0 flex items-stretch">
                        <LyricsLayerRow
                          onSeek={onVizClick}
                          onRegion={onVizRegion}
                          onRegionDragStart={onRegionDragStart}
                          items={layer.items}
                          color={layer.color}
                          duration={duration}
                          currentTime={currentTime}
                          karaokeActive={karaokeLayerIds.has(layer.id)}
                          focusedItemId={focusedLyrics?.layerId === layer.id ? focusedLyrics.itemId : null}
                          onLyricsClick={(itemId, anchor) => onLyricsClick?.(layer.id, itemId, anchor)}
                          onLyricsSeek={onLyricsSeek}
                          onLyricsDrag={onLyricsDrag
                            ? (itemId, time) => onLyricsDrag(layer.id, itemId, time)
                            : undefined}
                          onLyricsDragStart={onLyricsDragStart
                            ? (itemId) => onLyricsDragStart(layer.id, itemId)
                            : undefined}
                          onLyricsEdgeDrag={onLyricsEdgeDrag
                            ? (itemId, edge, time) => onLyricsEdgeDrag(layer.id, itemId, edge, time)
                            : undefined}
                          onLyricsEdgeDragStart={onLyricsEdgeDragStart
                            ? (itemId, edge) => onLyricsEdgeDragStart(layer.id, itemId, edge)
                            : undefined}
                          gridProps={gridProps}
                          pendingSelection={pendingSelection}
                          reviewState={detectorLayerReview?.[layer.id]}
                          onAccept={(itemId) => onDetectorLayerAccept?.(layer.id, itemId)}
                          onReject={(itemId) => onDetectorLayerReject?.(layer.id, itemId)}
                        />
                      </div>
                    </div>
                  );
                }
                // Custom annotation row (is_annotation detector). Layout mirrors the
                // built-in autoGuess row: a colored block strip on top, AutoGuessOverlay
                // review cards below, each scoped to this detector's pointId namespace.
                if (rowId.startsWith('custom-annotation:')) {
                  const cfg = customAnnotationRows?.find((r) => r.rowId === rowId);
                  if (!cfg) return null;
                  if (hiddenCustomAnnotations?.has(cfg.detectorName)) return null;
                  const sorted = [...cfg.points].sort((a, b) => a.time - b.time);
                  const blocks = sorted.map((p, i) => ({
                    time: p.time,
                    endTime: sorted[i + 1]?.time ?? duration,
                    label: p.status === 'pending' ? '?' : p.status === 'correct' ? '✓' : p.status === 'incorrect' ? '✗' : '~',
                    type: 'autoGuess',
                    color:
                      p.status === 'correct'   ? '#14b8a6' :
                      p.status === 'incorrect' ? '#f87171' :
                      p.status === 'partial'   ? '#f59e0b' :
                      Math.abs(p.time - p.originalTime) > 0.01 ? '#6366f1' :
                                                 '#4b5563',
                  }));
                  return (
                    <div key={rowId} {...dropProps} className={`${isDragging ? 'opacity-40' : ''} ${isDropTarget ? 'bg-amber-900/20 ring-1 ring-amber-700/40 rounded' : ''}`}>
                      <div className="flex items-stretch">
                        <RowLabel
                          text={cfg.label}
                          colorStyle={{ color: cfg.color }}
                          dragHandlers={dragHandlers}
                          onResizeStart={handleLabelColResizeStart}
                        />
                        {blocks.length > 0
                          ? <SectionBlockRow
                              sections={blocks}
                              duration={duration}
                              currentTime={currentTime}
                              height={20}
                              gridProps={gridProps}
                              onSectionClick={expandThreshold > 0 ? (i) => {
                                const id = sorted[i]?.id;
                                if (id) toggleAutoGuessExpanded(id);
                              } : undefined}
                            />
                          : <div className="flex-1 h-5 rounded bg-gray-900/30 flex items-center px-2"><span className="text-[10px] text-gray-700 italic">no items — run the detector on this song</span></div>
                        }
                      </div>
                      {cfg.points.length > 0 && (
                        <div className="flex items-stretch">
                          {/* Opaque sticky gutter cell (matches the title column) so the
                              review overlay slides *behind* the labels when scrolled
                              horizontally, instead of over them. */}
                          <div className="w-[calc(var(--viz-label-w,3.5rem)_+_0.5rem)] shrink-0 sticky left-0 z-30 bg-gray-900" />
                          <div className="flex-1 min-w-0 overflow-hidden">
                            <AutoGuessOverlay
                              points={cfg.points}
                              duration={duration}
                              currentTime={currentTime}
                              isPlaying={playerIsPlaying}
                              onMarkCorrect={(id) => onCustomAnnotationMarkCorrect?.(cfg.detectorName, id)}
                              onMarkIncorrect={(id) => onCustomAnnotationMarkIncorrect?.(cfg.detectorName, id)}
                              onMarkPending={(id) => onCustomAnnotationMarkPending?.(cfg.detectorName, id)}
                              onPlay={handlePlay}
                              onPause={handlePause}
                              expandedPointIds={expandedAutoGuessPointIds}
                              onToggleExpanded={toggleAutoGuessExpanded}
                              expandZoomThreshold={expandThreshold}
                              zoomFactor={vizZoomFactor}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                }
                const overlay = algoOverlays.find((o) => o.id === rowId);
                if (!overlay) return null;
                const focusedIdx = algoPopover.open && algoPopover.open.layerId === rowId
                  ? Number(algoPopover.open.itemId)
                  : null;
                return (
                  <div key={rowId} className={rowClass} {...dropProps}>
                    <AlgoTimelineRow
                      label={overlay.label}
                      labelColor={overlay.labelColor}
                      renderKind={overlay.renderKind}
                      sections={overlay.sections}
                      info={overlay.info}
                      infoId={overlay.id}
                      gridSource={overlay.gridSource}
                      duration={duration}
                      currentTime={currentTime}
                      dragHandlers={dragHandlers}
                      onResizeStart={handleLabelColResizeStart}
                      sectionColorOverrides={sectionColorOverrides}
                      boundaryColoringMode={boundaryColoringMode}
                      gridProps={gridProps}
                      focusedSectionIdx={focusedIdx}
                      onSectionClick={(idx, anchor) => algoPopover.openAt(rowId, String(idx), anchor)}
                      isSelected={selectedAlgoOverlayId === overlay.id}
                      onSelect={() => {
                        // Read the current selection here rather than inside a
                        // setState updater: the updater is not the place for a
                        // callback out to the page (it can run twice).
                        const next = selectedAlgoOverlayId === overlay.id ? null : overlay.id;
                        setSelectedAlgoOverlayId(next);
                        onAlgoOverlaySelect?.(next);
                      }}
                      onCopyToManual={onCopyAlgoOverlay ? () => onCopyAlgoOverlay(overlay) : undefined}
                      existingCopyCount={algoCopyCounts?.[overlay.id] ?? 0}
                      onToggleMergeMember={
                        onMergeAddLane && (overlay.renderKind ?? 'boundary') === 'boundary'
                          ? () => {
                              if (mergeLanes?.some((l) => l.id === overlay.id)) onMergeRemoveLane?.(overlay.id);
                              else onMergeAddLane(overlay.id);
                            }
                          : undefined
                      }
                      isMergeMember={!!mergeLanes?.some((l) => l.id === overlay.id)}
                    />
                  </div>
                );
              }
            }
          })}

          {/* ── Tall PreviewBand — single highlight spanning every viz row's
               content column. Background is pointer-events:none so row
               interactions (drag-to-region, marker drag, click-to-clear) keep
               working under the band. The left offset must equal the sticky
               label gutter — var(--viz-label-w) (= resizable labelColW) plus
               the 0.5rem gap folded into STICKY_LABEL_CELL — so the band's
               content column lines up with every row's flex-1 content (and the
               player's waveform). A fixed 4.5rem here drew the band ~8px off
               from the cursor / pending highlight once the gutter was widened.

               The band scrolls with the content, so once the region is scrolled
               past the left edge the band slides *under* the sticky label
               gutter — exactly like every row's waveform does. Rows hide that
               overhang because their sticky label cell is opaque and sits at
               z-30; the band used to sit at z-30 too and, being last in the
               DOM, painted straight over the labels, leaving a teal slab
               parked in the gutter after its content had scrolled away. So the
               band now lives *below* the labels (z-20) and carries its own
               full-height sticky gutter curtain, which also covers the 4px
               inter-row gaps and the bottom spacer that no label reaches. ── */}
          {previewRegion && (
            <div className="absolute inset-0 flex pointer-events-none z-20">
              {/* Opaque gutter curtain — same width/colour as STICKY_LABEL_CELL
                  so it is invisible against the panel, and z-40 *within this
                  wrapper* so it clips the band (z-30) without ever reaching the
                  row labels, which paint above the whole wrapper. */}
              <div
                aria-hidden="true"
                className="w-[calc(var(--viz-label-w,3.5rem)_+_0.5rem)] shrink-0 sticky left-0 z-40 bg-gray-900"
              />
              <div ref={previewBandParentRef} className="flex-1 min-w-0 relative">
                <PreviewWindow
                  region={previewRegion}
                  duration={duration}
                  isPlaying={previewIsPlaying ?? playerIsPlaying}
                  parentRef={previewBandParentRef}
                  onChange={onPreviewRegionChange ?? (() => {})}
                  onPlay={onPreviewPlay ?? (() => {})}
                  onPause={onPreviewPause ?? (() => {})}
                  onDismiss={onPreviewDismiss ?? (() => {})}
                  onLoopToggle={onPreviewLoopToggle ?? (() => {})}
                  // The single control bar lives on PlayerPanel above (its
                  // overflow-y context isn't clipped). In-band controls here
                  // would be hidden by the viz scroll container anyway.
                  showControls={false}
                />
              </div>
            </div>
          )}

          {/* Bottom breathing room — without this the last row butts against
              the scroll container's clipped edge and reads as trimmed. Roughly
              one-to-two empty lane-heights of slack. */}
          <div aria-hidden="true" className="h-12 shrink-0" />
        </div>
      </div>

      {/* Floating algo-output card — opens on click of any algo timeline
          block. Uses the same AnnotationPointCard as the cue/span/loop
          popovers, in read-only mode (the detector authored these values; the
          user can play through the section but can't edit it here). */}
      {algoPopover.open && (() => {
        const overlay = algoOverlays.find((o) => o.id === algoPopover.open!.layerId);
        if (!overlay) return null;
        const idx = Number(algoPopover.open.itemId);
        const section = overlay.sections[idx];
        if (!section) return null;
        const isInside = playerIsPlaying && currentTime >= section.time && currentTime < section.endTime;
        return (
          <AnnotationPointCard
            kind="span"
            layerName={overlay.label}
            layerColor={overlay.labelColor ?? '#94a3b8'}
            badge="algo"
            start={section.time}
            end={section.endTime}
            endEditable={false}
            label={section.label}
            description=""
            hideDescription
            hideImportance
            hideDelete
            readOnly
            rawOutput={section.raw ?? section}
            bpm={gridProps?.bpm}
            gridOffset={gridProps?.gridOffset}
            beatsPerBar={gridProps?.beatsPerBar}
            currentTime={currentTime}
            onChange={() => {}}
            onClose={algoPopover.close}
            onPlay={() => handlePlay(section.time, section.endTime)}
            onStop={handlePause}
            isPlaying={isInside}
            popoverRef={algoPopover.popoverRef}
            positionStyle={algoPopover.positionStyle}
            extras={(section.type || section.color) ? (
              <div className="flex items-center gap-2 text-[10px]">
                {section.type && (
                  <>
                    <span className="text-slate-500 uppercase tracking-wider w-12 shrink-0">Type</span>
                    <span className="px-1.5 py-0.5 rounded bg-slate-800/60 text-slate-200 font-mono">{section.type}</span>
                  </>
                )}
                {section.color && (
                  <span className="ml-auto flex items-center gap-1.5 min-w-0">
                    <span className="inline-block w-3 h-3 rounded-sm border border-white/20 shrink-0" style={{ background: section.color }} />
                    <span className="font-mono text-slate-400 truncate">{section.color}</span>
                  </span>
                )}
              </div>
            ) : undefined}
          />
        );
      })()}
    </div>
    </GutterStripContext.Provider>
    </RowTitlesVerticalContext.Provider>
  );
}
