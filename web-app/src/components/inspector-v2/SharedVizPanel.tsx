import { isSnappableLane } from '../../utils/laneSnap';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTimelineDrag, useRegionSelectDrag } from '../../hooks/useTimelineDrag';
import { PlayerPanel, type PlayerAccent, type ZoomToRange } from '../PlayerPanel';
import { StemSourcePicker } from './StemSourcePicker';
import type { DemucsModel, KitPart } from '../../hooks/useDemucsStems';
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
import { isOrphanedSection, sectionColor } from './sectionConstants';
import { PreviewWindow, type PreviewRegion } from './PreviewWindow';
import { LayerAudioControls, type LayerAudioConfig, DEFAULT_LAYER_AUDIO } from './LayerAudioControls';
import { TimeDisplayBar } from './TimeDisplayBar';
import { BeatGridOverlay, type LaneGridProps } from './BeatGridOverlay';
import { InlineEditableName } from './InlineEditableName';
import { UserLaneMenuItems, LockGlyph, type UserLaneActions, type UserLaneOps } from './UserLaneMenuItems';
import { envelopeTargets, isEnvelopeLayer } from '../../utils/soundEnvelopes';
import { MENU_DIVIDER, MENU_HEADING, MENU_ROW, MENU_ROW_SHAPE } from './laneMenuStyle';
import { splitKinds, itemsInRegion, regionLabel } from '../../services/laneActions';
import { CueLayerRow } from './CueLayerRow';
import { LyricsLayerRow } from './LyricsLayerRow';
import { LoopLayerRow } from './LoopLayerRow';
import { SpanLaneRow } from './SpanLaneRow';
import { RiffGrooveLaneRow, type RiffItemMove } from './RiffGrooveLaneRow';
import type { RiffLayerEdit } from './RiffLaneEditor';
import type { RiffCellRef } from './riffGrooves';
import { AnnotationPointCard } from './shared/AnnotationPointCard';
import { CopiedCellFlash, CopiedTag } from './shared/CopyFeedback';
import { useCopyFeedback } from './shared/useCopyFeedback';
import { useAnnotationPopover } from './shared/useAnnotationPopover';
import { SIGNAL_INFO } from './signalInfo';
import { layerMarkerCounts, type LayerMarkerCounts } from '../../utils/layerMarkerCounts';
import { GROUP_ROW_PREFIX, buildGroupedRowOrder, resolveGroupDrop, type ReorderPlace } from './layerGroupRows';
import type { GroupDrop } from './layerGroupRows';
import type { AutoGuessPoint } from '../../types/autoGuess';
import type {
  AnnotationLayer, AnnotationLayerGroup, ProminenceEnvelope, ProminenceLevel,
} from '../../types/annotationLayer';
import { CROSS_LANE_ITEM_TYPES, itemStartTime, loopsWouldOverlap, type LoopItem } from '../../types/annotationLayer';
import type { CrossLaneDropOptions } from '../../hooks/useCrossLaneDrop';
import { useBoundaryAudioFeedback } from '../../hooks/useBoundaryAudioFeedback';
import { usePaintClock, usePlayheadEffect, usePlayheadValue } from '../../hooks/usePlayhead';
import { PlayheadLine } from '../Playhead';
import { SongOverviewStrip, type OverviewSection } from './SongOverviewStrip';
import { isTypingTarget } from '../../hooks/useAnnotationShortcuts';
import { useSettings } from '../../context/SettingsContext';
import { beatIndexAt, beatTimeAt, snapTimeToGrid, type SnapDivision } from '../../utils/beatGrid';
import { beatStrengthCurve, busynessCurve, onsetDensityCurve } from '../../utils/rhythmSignals';
import { frameAxis as makeFrameAxis, frameAtColumn, frameAtTime, frameCenterTime, type FrameAxis } from '../../utils/frameTime';
import { MergeControlsBar } from './MergeControlsBar';
import { HAND_LANE_ID, fmtMergeTime, keptInOrder, mergedStart, type MergedBoundary, type MergeSourceLane } from './boundaryMerge';
import { LeadLaneRow } from './LeadLaneRow';
import type { LeadCandidate } from '../../utils/leadLane';
import { beatGridUnitToSnapDivision } from '../../utils/beatTimeFormat';
import { agreementCount } from '../../utils/boundaryClustering';
import { drumHitTitle } from '../../utils/drumHits';
import { stackTicks, tickHeightPct } from '../../utils/tickStacking';
import { VisualizeCardButton, VisualizeModeBar, VisualizePickCover, VisualizePickMarker, VisualizeToggle } from './shared/VisualizeToggle';
import { GRID_VIZ_ID, PICKABLE_ATTR, VisualizePickContext, useVisualizedLanes } from './shared/visualizeLanes';
import { litShadow } from './shared/litShadow';
import { MIN_BAND_PX } from './shared/bandGeometry';
import { isHorizontalWheel } from '../../utils/wheel';

/** How a lane says "let go here and the item moves into me" during a
 *  cross-lane drag. Keyed off the attribute useCrossLaneDrop sets on the
 *  lane's track wrapper, so the highlight costs no render. Drawn as an overlay
 *  above the track: the track is positioned and opaque, so an outline or a
 *  background on the wrapper itself would be painted over. */
const LANE_DROP_TARGET_CLASS =
  'relative data-[lane-drop-target]:after:absolute data-[lane-drop-target]:after:inset-0 data-[lane-drop-target]:after:z-30 data-[lane-drop-target]:after:pointer-events-none data-[lane-drop-target]:after:rounded-sm data-[lane-drop-target]:after:ring-2 data-[lane-drop-target]:after:ring-inset data-[lane-drop-target]:after:ring-sky-300 data-[lane-drop-target]:after:bg-sky-400/20';

/** What the cross-lane drag label calls one item and several, per lane type. */
const CROSS_LANE_NOUNS: Partial<Record<string, readonly [string, string]>> = {
  cues: ['cue', 'cues'],
  spans: ['span', 'spans'],
  loops: ['loop', 'loops'],
  lyrics: ['word', 'words'],
};

// ─── Section color map ────────────────────────────────────────────────────────

const AUTO_GUESS_COLOR = '#e879f9';
function sectionBg(type: string) { return type === 'autoGuess' ? AUTO_GUESS_COLOR : sectionColor(type); }

export type BoundaryColoringMode = 'by-type' | 'alternating';

const ALTERNATING_PALETTE = [
  '#60a5fa', '#f472b6', '#34d399', '#fb923c',
  '#a78bfa', '#fbbf24', '#22d3ee', '#f87171',
];

// ─── Row ordering ─────────────────────────────────────────────────────────────

export type VizRowId = string; // fixed IDs + dynamic algo overlay IDs
export const DEFAULT_FIXED_ROW_ORDER: VizRowId[] = ['waveform', 'eq', 'lead', 'autoGuess', 'merge', 'consensus', 'spectrogram', 'cepstrogram', 'chroma', 'tempogram', 'ssm', 'volume', 'energy', 'brightness', 'novelty', 'onsets', 'density', 'busyness', 'bandwidth', 'flux'];
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
 *  selected lane's 16px ⓘ / ⬇ / ◇ column beside it, clear of the 3px bar a
 *  selected lane draws down its left edge (the cell adds its 0.5rem). At 28
 *  the column didn't fit and squeezed the name out of a selected lane. */
const VERTICAL_GUTTER_W = 32;
/** Dragged below this, the gutter snaps to the sideways strip. */
const HORIZONTAL_SNAP_W = 52;
/** The narrowest gutter names read across in. */
const HORIZONTAL_MIN_W = 56;
const LABEL_COL_W_MAX = 240;
/** Remembered per browser, phone and desktop apart (a phone opened out to a
 *  desktop-wide column would leave it no timeline). A fresh key: the old
 *  `tc:viz-label-col-w` came from the 72px default and is left ignored. */
const labelColWKey = (mobile: boolean) => (mobile ? 'tc:viz-label-w:phone' : 'tc:viz-label-w');
function readLabelColW(mobile: boolean): number {
  try {
    const raw = Number(localStorage.getItem(labelColWKey(mobile)));
    return raw > 0 ? snapGutterW(raw) : VERTICAL_GUTTER_W;
  } catch { return VERTICAL_GUTTER_W; }
}

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
const LABEL_LINE_PX = 12.5; // text-[10px] × leading-tight (1.25)
const LABEL_ICONS_PX = 22; // the ⓘ / ⬇ / ◇ affordance strip (20px) on its own line, plus the gap
/** Every gutter control's box — ⋮, ⬇, ◇, a band's chevron: 20px, big enough to
 *  see and to hit. They were 10–14px, and read as specks. */
const LABEL_ICON_BOX = 'w-5 h-5';
/** Room a label keeps on its right for the ⋮ in its top corner. */
const MENU_CLEARANCE_PX = 22;
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

/** Overlay that holds a label cell's contents without adding to its height.
 *  `pl-1.5` keeps the first letter clear of the 2–3px rule a selected,
 *  auditioned or grouped lane draws down its left edge, and `safe` centring
 *  means a name wider than the gutter overflows at its END — clipped or
 *  elided there — never at both ends, where it lost its first letters. */
const LABEL_CELL_BODY = 'absolute inset-0 pl-1.5 pr-2 flex items-center justify-center-safe gap-0.5 overflow-hidden';

/**
 * Measures the gutter cell — which stretches to the row's own height — and
 * returns the clamp for the lane name plus the floor the cell is allowed to
 * push the row to. A name may claim up to `LABEL_MAX_LINES`; past that it
 * elides. Taller rows (the tall signal lanes) spend their extra height on more
 * lines of name, since it costs nothing. The ⓘ / ⬇ / ◇ affordances share the
 * name's line when the whole name still fits beside them, and otherwise drop
 * to their own strip under it — never squeezing it to a couple of characters
 * — so they are never what gets elided.
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

/** Leading words a sideways name trades for a short form. Upright, the
 *  gutter wraps the whole name; sideways every letter is a pixel of row
 *  height, and six of "Boundaries 1" bought a tall lane that still read
 *  "Bounda…" — the same for every boundary lane. "Bnd 1" is shorter and tells
 *  them apart. The full name stays in the cell's tooltip. */
const VERTICAL_ABBREV: [RegExp, string][] = [
  [/^boundar(?:y|ies)\b/i, 'Bnd'],
];

/** The name as the sideways gutter prints it. */
function verticalRowName(name: string): string {
  const n = name.replace(/\s+/g, ' ').trim();
  for (const [re, short] of VERTICAL_ABBREV) if (re.test(n)) return n.replace(re, short);
  return n;
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

/** Marks a label's icon strip so the fit measure can find it in the cell. */
const LABEL_ICONS_MARK = 'label-icons';

/** Whether the whole name — on one line, bold, with its ✏ — plus the icon
 *  strip and the gap between them fit the label body's width. Measured from
 *  the text and the strip, never from the name's rendered box, which is the
 *  thing this decision lays out (that way lies a flicker loop). */
function fitsOneLine(cell: HTMLElement, name: HTMLElement, text: string, cs: CSSStyleDeclaration): boolean {
  const ctx = wordMeasurer();
  const icons = cell.querySelector<HTMLElement>(`.${LABEL_ICONS_MARK}`);
  const body = icons?.parentElement;
  if (!ctx || !icons || !body) return false;
  ctx.font = `${cs.fontStyle} 700 ${cs.fontSize} ${cs.fontFamily}`;
  const flat = text.replace(/\s+/g, ' ').trim();
  const textPx = ctx.measureText(flat).width + (parseFloat(cs.letterSpacing) || 0) * flat.length;
  // The ✏ and its gap: whatever the name's wrapper holds beyond the name.
  const wrapper = [...body.children].find((c) => c !== icons && c.contains(name)) as HTMLElement | undefined;
  const pencilPx = wrapper ? Math.max(0, wrapper.offsetWidth - name.offsetWidth) : 0;
  const bs = getComputedStyle(body);
  const avail = body.clientWidth - (parseFloat(bs.paddingLeft) || 0) - (parseFloat(bs.paddingRight) || 0);
  const gap = parseFloat(bs.columnGap) || 0;
  return Math.ceil(textPx) + pencilPx + gap + icons.offsetWidth <= avail;
}

/** `extraPx`: height the cell spends on controls stacked above a sideways
 *  name (a group header's chevron) — added to the row's floor and taken off
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
  const shown = vertical ? verticalRowName(text) : text;
  // Whether the name and the ⓘ / ⬇ / ◇ strip fit side by side on one line.
  // When they do they share it — a second line for three small icons wastes
  // the row's height and reads as two things — and only a name that needs the
  // width pushes the strip underneath.
  const [iconsInline, setIconsInline] = useState(false);
  // Sideways, the strip stands beside the name as a column instead of taking
  // a line under it, so it costs the row no height either; inline, likewise.
  const iconsH = hasIcons && !vertical && !iconsInline ? LABEL_ICONS_PX : 0;
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
      setVerticalPx(verticalNamePx(shown, `${cs.fontStyle} 700 ${cs.fontSize} ${cs.fontFamily}`, parseFloat(cs.letterSpacing) || 0));
      const widest = widestWordPx(text, font);
      setUnbreakable(widest > 0 && widest > name.clientWidth);
      setIconsInline(hasIcons && !vertical && fitsOneLine(cell, name, text, cs));
    };
    measure();
    // Observing the cell alone catches both axes: the row growing taller and
    // the gutter being dragged wider. Observing the name too would feed the
    // clamp back into its own measurement.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(cell);
    return () => ro.disconnect();
  }, [text, shown, hasIcons, vertical]);
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
    // Untracked: every pixel of the name is a pixel of row height.
    ? {
        writingMode: 'vertical-rl', transform: 'rotate(180deg)',
        letterSpacing: 0,
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
    /** The name to print: `text`, or its short form in the sideways gutter. */
    shown,
    // The body's pr-2 keeps the name clear of the resize grip, which a
    // sideways gutter doesn't have — there it would squeeze the name and the
    // selected lane's icon column. pl-1 keeps the name off the selected
    // lane's 3px edge bar.
    // Sideways, the name (always the body's first child) never shrinks: it
    // is one line wide, and giving way to the icon column hid it entirely.
    bodyClass: vertical
      ? `${LABEL_CELL_BODY.replace('pl-1.5 pr-2', 'pl-1 pr-1')} gap-0.5 [&>:first-child]:shrink-0`
      : `${LABEL_CELL_BODY}${hasIcons && !iconsInline ? ' flex-col' : ''}`,
    // Sideways the strip is a column beside a one-line name, so its buttons
    // drop to 16px (glyphs to 12px) to leave the name its room.
    iconsClass: `${LABEL_ICONS_MARK} shrink-0 flex ${vertical
      ? 'flex-col gap-0.5 [&>button]:w-4 [&>button]:h-4 [&>button]:ml-0 [&>button:not(.rounded-full)]:text-[12px]'
      : ''} items-center justify-center leading-none`,
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

function RowLabel({ text, color = 'text-gray-600', colorStyle, dragHandlers, onResizeStart, signalId, onRemoveLane, visualize = false, onVisualizeToggle }: {
  text: string; color?: string;
  /** Whether this lane is visualized with playback (see VisualizeToggle). */
  visualize?: boolean;
  /** Turn this lane's Visualize on or off. */
  onVisualizeToggle?: () => void;
  /** Inline colour, for rows whose hue is data-driven rather than a class. */
  colorStyle?: React.CSSProperties;
  dragHandlers?: RowDragHandlers;
  onResizeStart?: (e: React.PointerEvent) => void;
  /** A signal lane's row id: clicking the name opens a card saying what the
   *  signal is and how it is computed (SIGNAL_INFO). */
  signalId?: string;
  /** The last item of the lane's ⋮ menu (see LaneRemove). A signal row hides
   *  itself without one. */
  onRemoveLane?: LaneRemove;
}) {
  // Room kept for the ⋮ in the corner, as on every lane (see MENU_CLEARANCE_PX).
  const { cellRef, nameRef, bodyClass, nameStyle, minHeight, shown, vertical } = useLabelFit(false, text, MENU_CLEARANCE_PX);
  const info = signalId ? SIGNAL_INFO[signalId] : undefined;
  const hideSignal = useContext(HideSignalContext);
  const remove: LaneRemove | undefined = onRemoveLane
    ?? (signalId && hideSignal ? { kind: 'hide', from: 'SIGNALS', run: () => hideSignal(signalId) } : undefined);
  const pop = useAnnotationPopover({ width: 320, height: 220 });
  const open = !!info && pop.open?.layerId === signalId;
  const accent = (signalId && SIGNAL_COLOR[signalId]) || '#94a3b8';
  const picking = useContext(VisualizePickContext);
  const menu = useLaneMenu({
    id: `row-menu:${signalId ?? text}`,
    name: (signalId && SIGNAL_LABEL[signalId]) || text,
    remove,
    common: {
      visualize: onVisualizeToggle ? { on: visualize, color: accent, toggle: onVisualizeToggle } : undefined,
      about: info ? () => {
        const r = cellRef.current?.getBoundingClientRect();
        if (r) pop.openAt(signalId!, 'info', { x: r.right, y: r.top });
      } : undefined,
    },
  });
  // The card's own outside-click closes it on pointerdown, before this click
  // lands — so a click on the name that is meant to close it would reopen it.
  const wasOpenRef = useRef(false);
  const name = (signalId && SIGNAL_LABEL[signalId]) || text;
  const hint = info ? 'click for what this signal is' : '';
  const title = [text, hint, dragHandlers ? 'drag to reorder' : ''].filter(Boolean).join(' — ');
  return (
    <>
    <div
      ref={cellRef}
      style={{ minHeight, ...colorStyle }}
      className={`${STICKY_LABEL_CELL} group/rowlabel ${color} ${dragHandlers ? 'cursor-grab active:cursor-grabbing' : ''} ${info ? 'hover:bg-[#161a21]' : ''}`}
      data-label={text}
      data-short={shortRowName(text)}
      draggable={dragHandlers?.draggable}
      onDragStart={dragHandlers?.onDragStart}
      onDragEnd={dragHandlers?.onDragEnd}
      onPointerDownCapture={info ? () => { wasOpenRef.current = open; } : undefined}
      onClick={info ? (e) => {
        if (wasOpenRef.current) { wasOpenRef.current = false; pop.close(); return; }
        const r = e.currentTarget.getBoundingClientRect();
        pop.openAt(signalId!, 'info', { x: r.right, y: r.top });
      } : undefined}
      role={info ? 'button' : undefined}
      aria-expanded={info ? open : undefined}
      title={title}
    >
      <div className={bodyClass} style={laneMenuClearance(menu.has, vertical)}>
        <span
          ref={nameRef}
          className={`text-[10px] tracking-wide text-center leading-tight min-w-0 ${color}`}
          style={{ ...nameStyle, ...colorStyle }}
        >{shown}</span>
      </div>
      {/* A visualized row keeps its lit ◈ up, as every other lane does, so
          it says which lanes are playing along and is one click from off. */}
      <LaneMenuCorner button={menu.button}>
        {visualize && onVisualizeToggle && (
          <VisualizeToggle on color={accent} onToggle={onVisualizeToggle} />
        )}
      </LaneMenuCorner>
      {onVisualizeToggle && (picking
        ? <VisualizePickCover on={visualize} color={accent} name={name} onToggle={onVisualizeToggle} />
        : <VisualizePickMarker />)}
      <LabelResizeHandle onResizeStart={onResizeStart} />
    </div>
    {menu.popover}
    {info && open && (
      <div
        ref={pop.popoverRef}
        style={pop.positionStyle}
        className="z-50 w-[320px] rounded-md border border-gray-700 bg-[#0d0f13] p-3.5 shadow-xl text-left normal-case"
      >
        <div className="flex items-start gap-2 mb-2.5">
          <span className="mt-1 w-3 h-3 rounded-full shrink-0" style={{ background: accent }} />
          <span className="text-[15px] font-semibold text-gray-100 leading-snug">{name}</span>
        </div>
        <dl className="text-[13px] leading-snug space-y-2">
          <div>
            <dt className="text-gray-500 text-[11px] uppercase tracking-wider mb-0.5">What it shows</dt>
            <dd className="text-gray-200">{info.shows}</dd>
          </div>
          <div>
            <dt className="text-gray-500 text-[11px] uppercase tracking-wider mb-0.5">How it's computed</dt>
            <dd className="text-gray-300">{info.computed}</dd>
          </div>
        </dl>
      </div>
    )}
    </>
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

/** A group header's collapse chevron, beside its sideways name, with the
 *  padding around it: the least a header can be. */
const GROUP_CONTROLS_PX = 26;

/** How far a band's member labels sit in from the gutter's edge. While the
 *  band is open this strip is where the band itself lives — its chevron and
 *  sideways name, drawn over every member's label (see `bandRows`) — so an
 *  open band costs no row of its own. */
const GROUP_INDENT_PX = 22;

/** A member label's left edge: the band's rule, then a tinted indent strip. */
function groupIndentShadow(color: string): string {
  return `inset 2px 0 0 0 ${color}, inset ${GROUP_INDENT_PX}px 0 0 0 ${color}26`;
}

/** One member lane's marks, flattened for the collapsed band: ticks where it
 *  marks an instant, bands where it marks a stretch. */
export interface GroupOverlayLane {
  id: string;
  name: string;
  color: string;
  /** Each mark's time(s) and, when the item carries its own, its colour. */
  points: { t: number; color?: string }[];
  spans: { a: number; b: number; color?: string }[];
}

/** A collapsed band's timeline: every member lane drawn on top of the others in
 *  its own colour, so folding the lanes away doesn't hide what they found.
 *  Read-only — expand the band to work a lane. */
function GroupOverlayStrip({ lanes, duration }: { lanes: GroupOverlayLane[]; duration: number }) {
  if (duration <= 0) return null;
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / duration) * 100))}%`;
  // Stacked stretches add up: split one lane's fill across the band so where
  // they overlap reads darker, instead of every lane burning to a flat wash.
  const fill = Math.round(255 * Math.max(0.06, Math.min(0.2, 0.4 / lanes.length))).toString(16).padStart(2, '0');
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-sm" data-testid="group-overlay">
      {lanes.map((lane) => (
        <div key={lane.id} className="contents">
          {lane.spans.map(({ a, b, color = lane.color }, i) => (
            <span
              key={`s${i}`}
              className="absolute top-[3px] bottom-[3px]"
              style={{
                left: pct(a),
                width: `calc(${pct(b)} - ${pct(a)})`,
                background: `${color}${fill}`,
                boxShadow: `inset 1px 0 0 0 ${color}`,
              }}
            />
          ))}
          {lane.points.map(({ t, color = lane.color }, i) => (
            <span
              key={`p${i}`}
              className="absolute top-[3px] bottom-[3px] w-[2px] -translate-x-1/2 rounded-[1px]"
              style={{ left: pct(t), background: color, boxShadow: `0 0 4px ${color}88` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A group's header row: the band's name, how many lanes it holds, and the two
 *  ways to end it. Members render underneath with a rule in the same colour —
 *  see `groupColor` on LayerRowLabel. A detector band also takes the lanes'
 *  ⬇, for all of them at once. */
function GroupHeaderRow({
  group, memberCount, onToggleCollapsed, onRename, onUngroup, onDelete,
  dragHandlers, onResizeStart, isDropTarget = false, overlay, duration = 0, asStrip = false,
  onCopy, existingCopyCount = 0,
}: {
  group: AnnotationLayerGroup;
  /** The band is open: draw it as the strip down its members' gutter, not
   *  as a row. Only a collapsed band — which has nothing else to show it —
   *  takes a lane. */
  asStrip?: boolean;
  memberCount: number;
  /** The members' marks, drawn over each other while the band is collapsed. */
  overlay?: GroupOverlayLane[];
  duration?: number;
  onToggleCollapsed: () => void;
  onRename?: (name: string) => void;
  onUngroup?: () => void;
  onDelete?: () => void;
  dragHandlers?: RowDragHandlers;
  onResizeStart?: (e: React.PointerEvent) => void;
  /** A lane is hovering over the band right now — say what letting go does. */
  isDropTarget?: boolean;
  /** Copy every lane the band shows into new layers of the annotator's own. */
  onCopy?: () => void;
  /** Copies its lanes already have, summed — turns the ⬇ amber, as a lane's. */
  existingCopyCount?: number;
}) {
  const menu = useAnnotationPopover({ width: 260, height: 200 });
  const copyFeedback = useCopyFeedback(existingCopyCount);
  const menuOpen = menu.open?.layerId === group.id;
  const collapsed = group.collapsed === true;
  const lanes = `${memberCount} ${memberCount === 1 ? 'lane' : 'lanes'}`;
  const showOverlay = collapsed && !isDropTarget && !!overlay && overlay.length > 0;
  // A band with nothing to edit — a detector group, which no document holds —
  // keeps the chevron but neither the rename field nor an empty ⋯ menu.
  const readOnly = !onRename && !onUngroup && !onDelete;
  // Sideways, the chevron stands beside the name — the way a
  // lane's ⓘ / ⬇ strip does — so the header is only as tall as its name, not
  // the name plus a stack of controls on top. The name reads up like every
  // lane's, and Rename lives in the ⋯ menu.
  const fit = useLabelFit(false, group.name);
  const { cellRef, nameRef, nameStyle, vertical } = fit;
  const minHeight = vertical ? Math.max(fit.minHeight, GROUP_CONTROLS_PX + (onCopy ? 22 : 0) + (readOnly ? 0 : 22)) : fit.minHeight;
  const [renameRequest, setRenameRequest] = useState(0);

  // The band's one control: collapse / expand. Showing and hiding lanes is
  // each lane's own business, as everywhere else on the timeline.
  const toggles = (
    <button
      type="button"
      aria-label={collapsed ? `Expand ${group.name}` : `Collapse ${group.name}`}
      title={collapsed ? 'Expand — show every lane' : 'Collapse — fold the lanes behind the header'}
      // Space is play / pause. A clicked button keeps focus, and a focused
      // button takes Space as a click — so the song played AND the band
      // folded. Clicking doesn't take focus; tabbed to, Enter toggles it.
      onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
      onKeyUp={(e) => { if (e.key === ' ') e.preventDefault(); }}
      onClick={(e) => { e.stopPropagation(); onToggleCollapsed(); }}
      className={`shrink-0 ${LABEL_ICON_BOX} flex items-center justify-center rounded hover:bg-white/10 transition-colors`}
      style={{ color: group.color }}
    >
      <svg
        viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        className="transition-transform duration-150"
        style={{ transform: collapsed ? 'rotate(-90deg)' : undefined }}
      >
        <path d="M4 6l4 4 4-4" />
      </svg>
    </button>
  );
  // The lanes' ⬇, once for the band: the same colours and the same "copied"
  // tag, so it reads as that button rather than a new one to learn.
  const copyButton = onCopy && (
    <>
      <button
        type="button"
        aria-label={`Copy every lane of ${group.name} to the Annotate tab`}
        disabled={copyFeedback.copied}
        onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
        onClick={(e) => { e.stopPropagation(); copyFeedback.arm(e.currentTarget); onCopy(); }}
        title={copyFeedback.copied
          ? 'Copied — the new layers are in the Annotate tab'
          : `Copy all ${lanes} of "${group.name}" to new editable layers, together in a group of this name`
            + (existingCopyCount > 0 ? ` — ${existingCopyCount} existing ${existingCopyCount === 1 ? 'copy' : 'copies'} of its lanes` : '')}
        className={`shrink-0 ${LABEL_ICON_BOX} inline-flex items-center justify-center rounded text-[14px] leading-none transition-colors ${
          copyFeedback.copied
            ? 'text-[#0a0b0d] bg-emerald-400 font-bold'
            : existingCopyCount > 0
              ? 'text-amber-300 hover:text-amber-100 hover:bg-amber-500/25'
              : 'text-emerald-300 hover:text-emerald-100 hover:bg-emerald-500/20'
        }`}
      >
        {copyFeedback.copied ? '✓' : '⬇'}
      </button>
      <CopiedTag show={copyFeedback.copied} unchanged={copyFeedback.unchanged} at={copyFeedback.tagAt} />
    </>
  );
  // The band's ⋮ — the lanes' own glyph, in the label column beside the
  // chevron, so Delete and Ungroup are found where every lane keeps them, open
  // or collapsed. It used to be the sideways name (a button that did not look
  // like one) or a ⋯ at the far end of the timeline row, off-screen.
  const menuButton = !readOnly && (
    <LaneMenuButton
      name={group.name}
      what="group"
      title="Group actions — rename, ungroup, delete"
      open={menuOpen}
      onToggle={(r) => {
        if (menuOpen) { menu.close(); return; }
        menu.openAt(group.id, 'group-menu', { x: r.right, y: r.top });
      }}
      className="shrink-0 !ml-0"
    />
  );
  const nameEl = readOnly ? (
    <span className="min-w-0 flex items-center gap-1">
      <span
        ref={nameRef}
        className={vertical ? 'text-[11px] font-bold tracking-wide' : 'text-[10px] font-bold tracking-wide truncate'}
        style={vertical ? { ...nameStyle, color: group.color } : { color: group.color }}
      >
        {group.name}
      </span>
    </span>
  ) : (
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
      pencilClassName="shrink-0 w-4 h-4 inline-flex items-center justify-center rounded text-[12px] leading-none opacity-75 hover:opacity-100 hover:bg-white/10"
      inputClassName="absolute left-0 top-1/2 -translate-y-1/2 z-[60] min-w-full w-[220px] h-[26px] bg-[#0a0b0d] border border-white/40 rounded px-1.5 text-[12px] text-current shadow-lg shadow-black/60 focus:outline-none focus:border-cyan-400/80"
    />
  );

  // A group is not a lane, so its items are its own — but the panel is the
  // one every lane's ⋮ opens.
  const menuEl = menuOpen && !readOnly && (
    <div ref={menu.popoverRef} style={menu.positionStyle} className="z-50">
      <LaneMenuPanel name={group.name} width={260} onDone={() => menu.close()}>
        {onRename && (
          <button type="button" onClick={() => { menu.close(); setRenameRequest((n) => n + 1); }} className={MENU_ROW}>
            Rename…
          </button>
        )}
        <button type="button" onClick={() => { onToggleCollapsed(); menu.close(); }} className={MENU_ROW}>
          {collapsed ? 'Expand' : 'Collapse'}
        </button>
        <div className={MENU_DIVIDER} />
        <button type="button" onClick={() => { onUngroup?.(); menu.close(); }} className={MENU_ROW}>
          Ungroup — keeps {lanes}
        </button>
        <button
          type="button"
          onClick={() => { onDelete?.(); menu.close(); }}
          className={`${MENU_ROW_SHAPE} text-red-300 hover:bg-red-500/15`}
        >
          Delete group and its {lanes}…
        </button>
      </LaneMenuPanel>
    </div>
  );

  if (asStrip) {
    const tint = `${group.color}${isDropTarget ? '55' : '2e'}`;
    return (
      <>
        <div
          className="h-full flex flex-col items-center gap-1 pt-1 pb-1 overflow-hidden transition-colors"
          style={{
            width: GROUP_INDENT_PX,
            color: group.color,
            // Opaque under the tint: the strip is sticky, and lane content
            // scrolls beneath it.
            background: `linear-gradient(${tint}, ${tint}), #0a0b0d`,
            boxShadow: `inset 2px 0 0 0 ${group.color}`,
          }}
          draggable={dragHandlers?.draggable}
          onDragStart={dragHandlers?.onDragStart}
          onDragEnd={dragHandlers?.onDragEnd}
          title={isDropTarget
            ? `Drop to add to the top of ${group.name}`
            : `${group.name} — ${lanes}${readOnly ? ' · detector group' : ''}`}
        >
          {toggles}
          {copyButton}
          {menuButton}
          {readOnly ? (
            <span
              className="flex-1 min-h-0 text-[10px] font-bold leading-none"
              style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {group.name}
            </span>
          ) : (
            <button
              type="button"
              aria-label={`${group.name} — open group actions`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (menuOpen) { menu.close(); return; }
                const r = e.currentTarget.getBoundingClientRect();
                menu.openAt(group.id, 'group-menu', { x: r.right, y: r.top });
              }}
              className="flex-1 min-h-0 text-[10px] font-bold leading-none hover:brightness-125"
              style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {group.name}
            </button>
          )}
        </div>
        {menuEl}
      </>
    );
  }

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
          ? 'absolute inset-0 flex items-center justify-center gap-0.5 pl-1 pr-1 overflow-hidden'
          : 'flex items-center gap-1 min-w-0 w-full pl-1'}>
          {vertical
            ? <>{nameEl}<span className="shrink-0 flex flex-col items-center gap-0.5">{toggles}{copyButton}{menuButton}</span></>
            : <>{toggles}{nameEl}{copyButton}{menuButton}</>}
        </div>
        {onResizeStart && (
          <span
            onPointerDown={onResizeStart}
            className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize opacity-0 group-hover:opacity-100 bg-white/20"
          />
        )}
      </div>
      <div
        className="relative flex-1 min-w-0 flex items-center gap-3 px-2 rounded-sm transition-colors"
        style={{
          ...(showOverlay ? { minHeight: 26 } : {}),
          background: `${group.color}${isDropTarget ? '2e' : '14'}`,
          boxShadow: `inset 0 0 0 ${isDropTarget ? '1.5px' : '1px'} ${group.color}${isDropTarget ? 'bb' : '33'}`,
        }}
        title={showOverlay ? `${group.name} — every lane drawn together. Expand to work one lane.` : undefined}
      >
        {showOverlay && <GroupOverlayStrip lanes={overlay!} duration={duration} />}
        <span
          className={`relative font-mono text-[9.5px] ${showOverlay ? 'px-1 rounded-sm bg-[#0a0b0d]/80' : ''}`}
          style={{ color: group.color }}
        >
          {lanes}
        </span>
        {readOnly && !showOverlay && (
          <span className="text-[9.5px] text-slate-500" title="These lanes come from detectors that belong together. Copy one into your layers and it joins a group of this name.">
            detector group
          </span>
        )}
        {isDropTarget ? (
          <span className="text-[9.5px] font-semibold" style={{ color: group.color }}>
            drop to add to the top of {group.name}
          </span>
        ) : memberCount === 0 && (
          <span className="text-[9.5px] text-slate-500 italic">
            empty — drag a lane onto this header, or use its ⋮ menu
          </span>
        )}
      </div>
      {menuEl}
    </>
  );
}

/** What a lane's label reads off its lane. Every annotation layer is one; a
 *  detector lane with no annotation layer behind it (Drum grooves) is one too,
 *  and hands its own `counts` for the card. */
type LaneLabelLayer = Pick<AnnotationLayer, 'id' | 'name' | 'color' | 'readOnly' | 'source'
  | 'sourceStem' | 'sourceDescription' | 'sourceNotes'>
  & Partial<Pick<AnnotationLayer, 'type' | 'items'>>;

/** The lane card's counts: the lane's own when it hands them, else counted
 *  from its annotation items. */
function laneCounts(layer: LaneLabelLayer, counts: LayerMarkerCounts | undefined): LayerMarkerCounts | null {
  if (counts) return counts;
  return layer.type && layer.items ? layerMarkerCounts({ type: layer.type, items: layer.items }) : null;
}

/** Kinds listed on a lane card before "+N more". */
const CARD_KINDS_SHOWN = 5;
/** A description longer than this is clamped to three lines with a "more". */
const CARD_DESC_CLAMP_CHARS = 180;

/** What the last item of a lane's ⋮ menu does — the same item on every lane.
 *  A lane that shows stored output deletes it, and `scope` says what goes:
 *  one lane of a detector that draws several (`lane`), one part of a lane cut
 *  by part (`part`), a detector's whole output for the song with your review
 *  of it (`detector`), an algorithm's result (`algo`), a layer of yours
 *  (`layer`), or the Auto-guess annotation (`auto-guess`). A row that stores nothing — a signal, a view computed from
 *  other lanes — can only be hidden, and `from` says where it comes back. */
export type LaneRemove =
  | { kind: 'delete'; scope: 'lane' | 'part' | 'detector' | 'algo' | 'layer' | 'auto-guess' | 'merge'; run: () => Promise<void> | void }
  | { kind: 'hide'; from: string; run: () => void };

/** What a delete will do, said before it does it. */
function deleteNote(scope: Extract<LaneRemove, { kind: 'delete' }>['scope'], name: string): React.ReactNode {
  const n = <b className="text-gray-100">{name}</b>;
  switch (scope) {
    case 'lane': return <>Deletes {n} from this song, for every annotator, and keeps the detector's other lanes. Running the detector on the whole song again brings it back.</>;
    case 'part': return <>Deletes the {n} part of this detector's lane on this song, for every annotator; its other parts stay. Running the detector again brings it back.</>;
    case 'detector': return <>Deletes {n}'s output for this song, for every annotator, with your ✓/✗ review of it. Layers you copied with ⬇ are kept. Running the detector again brings it back.</>;
    case 'algo': return <>Deletes the result of {n} for this song, for every annotator. Running it again brings it back.</>;
    case 'layer': return <>Deletes your layer {n}. ⌘Z brings it back.</>;
    case 'auto-guess': return <>Deletes your Auto-guess annotation for this song, its ✓/✗ included. This can't be undone.</>;
    case 'merge': return <>Empties {n} on this song and takes the row away, with the boundaries you dropped or edited in it. The lanes you merged stay on the canvas, and layers you saved from it are kept. <b className="text-gray-100">⊕ Add to merge</b> on a boundary lane's ⋮ starts a new one.</>;
  }
}

/** The last item of a lane's ⋮ menu. "Delete this lane…" asks twice — the
 *  first click says what it will do, the second does it, and a failure stays
 *  up with the server's reason. "Hide this lane" just hides. */
function LaneRemoveItem({ remove, name, onDone }: {
  remove: LaneRemove;
  name: string;
  onDone: () => void;
}) {
  const [step, setStep] = useState<'idle' | 'confirm' | 'deleting'>('idle');
  const [error, setError] = useState<string | null>(null);
  const row = MENU_ROW_SHAPE;
  if (remove.kind === 'hide') {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); remove.run(); onDone(); }}
        title={`Nothing is deleted. Turn it back on from ${remove.from}.`}
        className={`${row} text-slate-200 hover:bg-white/[0.06]`}
      >
        <span aria-hidden>✕</span>
        <span className="flex-1">Hide this lane</span>
      </button>
    );
  }
  const { run } = remove;
  return (
    <div className="normal-case">
      {step === 'idle' ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setError(null); setStep('confirm'); }}
          className={`${row} text-rose-300 hover:bg-rose-500/10`}
        >
          <span aria-hidden>✕</span>
          <span className="flex-1">Delete this lane…</span>
        </button>
      ) : (
        <div className="px-2.5 py-1.5">
          <p className="text-[10px] text-gray-300 leading-snug mb-1.5">{deleteNote(remove.scope, name)}</p>
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={step === 'deleting'}
              onClick={async (e) => {
                e.stopPropagation();
                setStep('deleting');
                try {
                  await run();
                  onDone();
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                  setStep('confirm');
                }
              }}
              className="flex-1 px-2 py-1.5 rounded text-[11px] text-white bg-rose-600 hover:bg-rose-500 disabled:opacity-60 transition-colors"
            >
              {step === 'deleting' ? 'Deleting…' : 'Delete'}
            </button>
            <button
              type="button"
              disabled={step === 'deleting'}
              onClick={(e) => { e.stopPropagation(); setStep('idle'); setError(null); }}
              className="flex-1 px-2 py-1.5 rounded text-[11px] text-gray-300 border border-gray-600 hover:bg-gray-800 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="px-2.5 pb-1.5 text-[10px] text-rose-300 leading-snug">{error}</p>}
    </div>
  );
}

/** The items every kind of lane offers in the same words and the same place —
 *  the top of its ⋮ — whenever it can do them. A lane that can't simply has
 *  no such row; nothing is renamed or moved per lane type, so the menu reads
 *  the same on a detector lane, a signal curve, a layer of yours or the Merge. */
export interface LaneMenuCommon {
  /** Play along with the playhead (see VisualizeToggle). */
  visualize?: { on: boolean; color: string; toggle: () => void };
  /** Open the lane's card: what built it, or what the signal is. */
  about?: () => void;
  /** Copy a read-only lane into a new layer of yours (the ⬇). */
  copy?: { run: () => void; existing: number };
}

const hasCommon = (c?: LaneMenuCommon) => !!(c && (c.visualize || c.about || c.copy));


function LaneCommonItems({ common, onDone }: { common: LaneMenuCommon; onDone: () => void }) {
  const { visualize, about, copy } = common;
  return (
    <>
      {visualize && (
        <button
          type="button"
          aria-pressed={visualize.on}
          onClick={(e) => { e.stopPropagation(); visualize.toggle(); onDone(); }}
          title="Light what is sounding under the playhead on this lane"
          className={MENU_ROW}
        >
          <span aria-hidden className="w-3 text-center" style={{ color: visualize.on ? visualize.color : '#6b7280' }}>
            {visualize.on ? '◈' : '◇'}
          </span>
          <span className="flex-1">{visualize.on ? 'Stop visualizing' : 'Visualize with playback'}</span>
        </button>
      )}
      {about && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDone(); about(); }}
          className={MENU_ROW}
        >
          <span aria-hidden className="w-3 text-center text-slate-400">ⓘ</span>
          <span className="flex-1">About this lane</span>
        </button>
      )}
      {copy && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); copy.run(); onDone(); }}
          title={copy.existing > 0
            ? `${copy.existing} existing ${copy.existing === 1 ? 'copy' : 'copies'} already imported`
            : 'Copy this lane into a new layer you can edit'}
          className={MENU_ROW}
        >
          <span aria-hidden className={`w-3 text-center ${copy.existing > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>⬇</span>
          <span className="flex-1">Copy to a layer of yours</span>
          {copy.existing > 0 && <span className="text-[10px] text-amber-400/80 tabular-nums">{copy.existing}</span>}
        </button>
      )}
    </>
  );
}

/** The menu panel every lane's ⋮ opens, in one order on every lane: the
 *  lane's name, the common items (LaneMenuCommon), the lane's own actions,
 *  and the remove item last. */
function LaneMenuPanel({ name, width = 240, common, children, remove, onDone }: {
  name: string;
  width?: number;
  common?: LaneMenuCommon;
  children?: React.ReactNode;
  remove?: LaneRemove;
  onDone: () => void;
}) {
  const showCommon = hasCommon(common);
  return (
    <div style={{ width }} className="rounded-md border border-white/[0.08] bg-[#14171d] shadow-2xl shadow-black/60 py-1">
      <div className="px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-slate-400 truncate">
        {name}
      </div>
      {showCommon && <LaneCommonItems common={common!} onDone={onDone} />}
      {showCommon && children && <div className={MENU_DIVIDER} />}
      {children}
      {remove && (
        <>
          {(children || showCommon) && <div className={MENU_DIVIDER} />}
          <LaneRemoveItem remove={remove} name={name} onDone={onDone} />
        </>
      )}
    </div>
  );
}

/** The ⋮ glyph that opens a lane's menu — one look on every lane. */
function LaneMenuButton({ name, open, onToggle, title = 'Lane actions', className = '', what = 'lane' }: {
  name: string;
  open: boolean;
  onToggle: (anchor: DOMRect) => void;
  title?: string;
  className?: string;
  /** Whose actions: a lane's, or a group header's. */
  what?: 'lane' | 'group';
}) {
  // A right-click anywhere on this lane — its label or its body — opens the
  // same menu, at the pointer. One listener on the lane's row, owned here, so
  // every lane kind gets it without each row wiring it. A body that uses the
  // right button itself (removing a prominence point) calls preventDefault
  // and keeps it; the browser's own menu is replaced only where a lane is.
  const buttonRef = useRef<HTMLButtonElement>(null);
  const latest = useRef({ open, onToggle });
  latest.current = { open, onToggle };
  useEffect(() => {
    const row = buttonRef.current?.closest('[data-lane-row]');
    if (!row) return;
    const onContextMenu = (e: Event) => {
      const me = e as MouseEvent;
      if (me.defaultPrevented) return;
      // The innermost lane wins: a lane inside a group's row answers, not the group.
      if ((me.target as Element | null)?.closest('[data-lane-row]') !== row) return;
      me.preventDefault();
      if (!latest.current.open) latest.current.onToggle(new DOMRect(me.clientX, me.clientY, 0, 0));
    };
    row.addEventListener('contextmenu', onContextMenu);
    return () => row.removeEventListener('contextmenu', onContextMenu);
  }, []);
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={`${name} — ${what} actions`}
      aria-expanded={open}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onToggle(e.currentTarget.getBoundingClientRect()); }}
      title={title}
      className={`ml-0.5 inline-flex items-center justify-center align-middle ${LABEL_ICON_BOX} rounded leading-none transition-colors ${
        open ? 'text-slate-100 bg-white/15' : 'text-gray-400 hover:text-white hover:bg-white/10'
      } ${className}`}
    >
      {/* Three solid dots, not the ⋮ character: a font draws that as specks
          a pixel or two across at any size the gutter can afford. */}
      <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
        <circle cx="8" cy="3" r="1.8" /><circle cx="8" cy="8" r="1.8" /><circle cx="8" cy="13" r="1.8" />
      </svg>
    </button>
  );
}

/** What a lane's ⋮ holds. Every lane kind describes its menu with this and
 *  nothing else; the glyph, its corner, its open state and the panel are
 *  useLaneMenu's, so they cannot drift apart per lane. */
interface LaneMenuSpec {
  /** Unique among lanes: which lane's menu is the open one. */
  id: string;
  name: string;
  common?: LaneMenuCommon;
  /** The lane's own items, between the common ones and the remove item.
   *  `close` dismisses the menu. Omit when the lane has none. */
  items?: (close: () => void) => React.ReactNode;
  /** The last item (see LaneRemove). */
  remove?: LaneRemove;
  /** The ⋮'s tooltip, when it has more to say than "Lane actions". */
  title?: string;
  /** The panel's expected height, for placing it on screen. */
  height?: number;
}

/** A lane's ⋮ and its menu. `button` goes in the label through
 *  LaneMenuCorner, `popover` beside the label cell, outside its clipping.
 *  `has` is false when the lane has nothing to offer, and there is no ⋮. */
function useLaneMenu({ id, name, common, items, remove, title, height = 200 }: LaneMenuSpec) {
  const pop = useAnnotationPopover({ width: 240, height });
  const has = !!remove || hasCommon(common) || !!items;
  const open = has && pop.open?.layerId === id && pop.open.itemId === 'lane-menu';
  const close = () => pop.close();
  const button = has ? (
    <LaneMenuButton
      name={name}
      open={open}
      title={title}
      onToggle={(r) => { if (open) pop.close(); else pop.openAt(id, 'lane-menu', { x: r.right, y: r.bottom }); }}
    />
  ) : null;
  const popover = open ? (
    <div ref={pop.popoverRef} style={pop.positionStyle} className="z-50">
      <LaneMenuPanel name={name} common={common} remove={remove} onDone={close}>
        {items?.(close)}
      </LaneMenuPanel>
    </div>
  ) : null;
  return { has, open, button, popover };
}

/** Where every lane keeps its ⋮: the label cell's top-right corner. Anything
 *  that rides with it (a padlock, a lit ◈) goes in `children`, before it. */
function LaneMenuCorner({ button, children }: { button: React.ReactNode; children?: React.ReactNode }) {
  if (!button && !children) return null;
  return (
    <span className="absolute top-0.5 right-1 z-10 flex items-center pointer-events-auto">
      {children}
      {button}
    </span>
  );
}

/** Padding that keeps a lane's name out from under the ⋮ in its corner —
 *  above a sideways name, beside one that reads across. */
function laneMenuClearance(has: boolean, vertical: boolean): React.CSSProperties {
  if (!has) return {};
  return vertical ? { paddingTop: MENU_CLEARANCE_PX } : { paddingRight: MENU_CLEARANCE_PX };
}

/** Hides a signal row — the same as unticking it under SIGNALS. Provided by
 *  the panel so every signal row's ⋮ can offer "Hide this lane". */
const HideSignalContext = createContext<((rowId: string) => void) | null>(null);

function LayerRowLabel({
  layer,
  counts,
  isSelected,
  onSelect,
  onRename,
  dragHandlers,
  onResizeStart,
  auditionedStem,
  onCopyToManual,
  existingCopyCount = 0,
  visualize,
  onVisualizeToggle,
  groupColor,
  groupMenu,
  userLane,
  onRemoveLane,
}: {
  layer: LaneLabelLayer;
  /** The card's marker counts, for a lane whose items are not annotation items.
   *  Otherwise they are counted from `layer.items`. */
  counts?: LayerMarkerCounts;
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
  /** Whether this lane is visualized with playback (see VisualizeToggle). */
  visualize?: boolean;
  /** Turn this lane's Visualize on or off. */
  onVisualizeToggle?: () => void;
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
  /** The ⋮ items only a lane of yours has (see UserLaneActions). */
  userLane?: UserLaneActions;
  /** The last item of the lane's ⋮ menu (see LaneRemove). */
  onRemoveLane?: LaneRemove;
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
  // A detector lane (Algo Inspect) opens its card from a click on the name
  // itself: the name is elided to a few letters in a narrow gutter, and the
  // card is where the whole of it, the marker counts and every lane action
  // live. A user lane's click stays plain select — that's the annotator's
  // working surface, and a card on every click would be in the way.
  const cardOnClick = !!layer.readOnly;
  const markerCounts = useMemo(
    () => (infoOpen ? laneCounts(layer, counts) : null),
    // The lane object is rebuilt every render; what the counts read off it is
    // its type and items, so those are what re-count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [infoOpen, counts, layer.type, layer.items],
  );
  // The card closes on any pointerdown outside it — including the one on this
  // name — so the click that follows would reopen it. Remember whether it was
  // open when the press began, and let that click close it for good.
  const cardWasOpenRef = useRef(false);
  // The card opens short: top kinds, three lines of description, notes folded.
  // Each expands on a click and folds back when the card closes.
  const [allKinds, setAllKinds] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  useEffect(() => {
    if (!infoOpen) { setAllKinds(false); setDescOpen(false); setNotesOpen(false); }
  }, [infoOpen]);
  const handleCellClick = (onSelect || cardOnClick) ? (e: React.SyntheticEvent<HTMLDivElement>) => {
    onSelect?.();
    if (!cardOnClick) return;
    if (cardWasOpenRef.current) { cardWasOpenRef.current = false; return; }
    const r = e.currentTarget.getBoundingClientRect();
    info.openAt(layer.id, 'info', { x: r.right, y: r.top });
  } : undefined;
  // The ⓘ / ⬇ / ◇ strip costs the row a whole line, which is too much rent for
  // a lane you're only looking at. It appears on the selected lane only — the
  // one you're actually working — so every other gutter cell is just its name.
  const vertical = useContext(RowTitlesVerticalContext);
  const picking = useContext(VisualizePickContext);
  // Sideways, the ✎ would sit beside a one-column name and read as part of it,
  // so Rename moves into the ⋮ menu instead — which is therefore offered on
  // any renamable lane, grouped or not.
  const menuRename = vertical && !!onRename;
  // Declared before the label fit, which keeps the name clear of the ⋮; the
  // items it reads (cellRef, copyFeedback, renameRequest) are only touched
  // when an item is clicked.
  const menu = useLaneMenu({
    id: layer.id,
    name: layer.name,
    height: 240,
    remove: onRemoveLane,
    title: groupMenu?.currentGroupId
      ? `In "${groupMenu.groups.find((g) => g.id === groupMenu.currentGroupId)?.name ?? 'a group'}" — click to change`
      : undefined,
    common: {
      visualize: onVisualizeToggle ? { on: !!visualize, color: layer.color, toggle: onVisualizeToggle } : undefined,
      // The card for "About this lane" opens beside the name.
      about: (hasInfo || cardOnClick) ? () => {
        const r = cellRef.current?.getBoundingClientRect();
        if (r) info.openAt(layer.id, 'info', { x: r.right, y: r.top });
      } : undefined,
      copy: onCopyToManual ? {
        existing: existingCopyCount,
        run: () => {
          const el = copyButtonRef.current ?? cellRef.current;
          if (el) copyFeedback.arm(el);
          onCopyToManual();
        },
      } : undefined,
    },
    items: (menuRename || userLane || groupMenu) ? (close) => (<>
      {menuRename && (
        <button type="button" onClick={() => { close(); setRenameRequest((n) => n + 1); }} className={MENU_ROW}>
          Rename…
        </button>
      )}
      {userLane && <UserLaneMenuItems name={layer.name} actions={userLane} onDone={close} />}
      {groupMenu && (<>
        {(menuRename || userLane) && <div className={MENU_DIVIDER} />}
        <button type="button" onClick={() => { groupMenu.onNewGroup(); close(); }} className={MENU_ROW}>
          New group from this lane
        </button>
        {groupMenu.groups.length > 0 && (<>
          <div className={MENU_DIVIDER} />
          <div className={MENU_HEADING}>Move to</div>
          {groupMenu.groups.map((g) => {
            const current = g.id === groupMenu.currentGroupId;
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => { groupMenu.onMoveTo(current ? null : g.id); close(); }}
                className={MENU_ROW}
              >
                <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ background: g.color }} />
                <span className="flex-1 truncate">{g.name}</span>
                {current && <span className="text-[10px] text-slate-400">●</span>}
              </button>
            );
          })}
        </>)}
        {groupMenu.currentGroupId && (<>
          <div className={MENU_DIVIDER} />
          <button type="button" onClick={() => { groupMenu.onMoveTo(null); close(); }} className={MENU_ROW}>
            Remove from group
          </button>
        </>)}
      </>)}
    </>) : undefined,
  });
  // A visualized lane keeps its strip up unselected, so the lit ◈ says which
  // lanes are playing along and is one click from turning off. The ⋮ is not
  // in the strip: it sits in the cell's top-right corner on every lane, so the
  // menu is findable without first selecting the lane.
  const hasIcons = (isSelected && (hasInfo || !!onCopyToManual || !!onVisualizeToggle))
    || (!!visualize && !!onVisualizeToggle);
  const { cellRef, nameRef, bodyClass, iconsClass, nameStyle, minHeight, shown } = useLabelFit(hasIcons, layer.name, menu.has ? MENU_CLEARANCE_PX : 0);
  const copyFeedback = useCopyFeedback(existingCopyCount);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
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
        boxShadow: `inset 3px 0 0 0 ${layer.color}, inset -1px 0 0 0 ${layer.color}66${groupColor ? `, inset ${GROUP_INDENT_PX}px 0 0 0 ${groupColor}26` : ''}`,
      } : auditioned ? {
        ...renamingStyle,
        minHeight,
        // Auditioning this layer's source stem: tint + a soft inset ring so the
        // lane reads as "this is what you're hearing" without stealing the
        // bolder treatment reserved for the actively-selected layer.
        background: `linear-gradient(90deg, ${layer.color}1a 0%, #0a0b0d 100%), #0a0b0d`,
        boxShadow: `inset 2px 0 0 0 ${layer.color}aa${groupColor ? `, inset ${GROUP_INDENT_PX}px 0 0 0 ${groupColor}26` : ''}`,
      } : groupColor ? {
        ...renamingStyle,
        minHeight,
        boxShadow: groupIndentShadow(groupColor),
      } : { ...renamingStyle, minHeight }) }}
      draggable={dragHandlers?.draggable}
      onDragStart={dragHandlers?.onDragStart}
      onDragEnd={dragHandlers?.onDragEnd}
      onPointerDownCapture={cardOnClick ? () => { cardWasOpenRef.current = infoOpen; } : undefined}
      onClick={handleCellClick}
      onKeyDown={handleCellClick ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          cardWasOpenRef.current = infoOpen;
          handleCellClick(e);
        }
      } : undefined}
      role={handleCellClick ? 'button' : undefined}
      tabIndex={handleCellClick ? 0 : undefined}
      aria-haspopup={cardOnClick ? 'dialog' : undefined}
      aria-expanded={cardOnClick ? infoOpen : undefined}
      title={cardOnClick
        ? `${layer.name} — click for marker counts and lane actions${auditioned ? `\nBuilt from the ${auditionedStem} stem you're auditioning.` : ''}`
        : onSelect
        ? `${layer.name} — click to make this the active layer (switches the tab + ADD+ target)${auditioned ? `\nBuilt from the ${auditionedStem} stem you're auditioning.` : ''}`
        : (dragHandlers ? 'Drag to reorder' : layer.name)}
    >
      <CopiedCellFlash show={copyFeedback.copied} />
      <LaneMenuCorner button={menu.button}>
        {userLane?.locked && (
          <span title="Locked — unlock it from the ⋮ menu">
            <LockGlyph className="w-2.5 h-2.5 opacity-80" />
          </span>
        )}
      </LaneMenuCorner>
      <div
        className={bodyClass}
        style={{
          ...renamingStyle,
          ...(groupColor ? { paddingLeft: GROUP_INDENT_PX + 4 } : {}),
          ...laneMenuClearance(menu.has, vertical),
          color: layer.color,
          textShadow: isSelected
            ? `0 0 6px ${layer.color}cc, 0 0 12px ${layer.color}66`
            : auditioned ? `0 0 6px ${layer.color}88` : undefined,
        }}
      >
      <span
        className={`text-[10px] tracking-wide text-center leading-tight min-w-0 max-w-full ${
          isSelected || auditioned ? 'font-bold' : ''
        }`}
      >
        {onRename ? (
          <InlineEditableName
            value={layer.name}
            displayValue={shown}
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
            pencilClassName="shrink-0 w-4 h-4 inline-flex items-center justify-center rounded text-[12px] leading-none opacity-75 hover:opacity-100 hover:bg-white/10"
            // Lifted out of the flow and sized in its own right: as wide as the
            // gutter but never under 220px, and 26px tall, so the name stays
            // readable while it is being typed even on a one-line lane. It
            // overhangs the canvas to the right; the cell's z-60 keeps it on top.
            inputClassName="absolute left-0 top-1/2 -translate-y-1/2 z-[60] min-w-full w-[220px] max-w-none h-[26px] bg-[#0a0b0d] border border-white/40 rounded px-1.5 text-[12px] tracking-wide text-left text-current shadow-lg shadow-black/60 focus:outline-none focus:border-cyan-400/80"
          />
        ) : (
          // Block, not inline: an inline span has no clientWidth, so the fit
          // measure read every word as unbreakable, and it ignores
          // overflow / text-overflow, so the "elided" name ran out of the cell
          // with no ellipsis at all.
          <span ref={nameRef} className="block max-w-full" style={nameStyle}>{shown}</span>
        )}
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
                // By now the press has already closed an open card (see
                // cardWasOpenRef), so ask the ref, not `infoOpen`.
                if (infoOpen || cardWasOpenRef.current) { info.close(); return; }
                const r = e.currentTarget.getBoundingClientRect();
                info.openAt(layer.id, 'info', { x: r.right, y: r.top });
              }}
              className={`ml-0.5 inline-flex items-center justify-center align-middle w-4 h-4 rounded-full text-[10px] font-bold leading-none transition-colors ${
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
              ref={copyButtonRef}
              type="button"
              disabled={copyFeedback.copied}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); copyFeedback.arm(e.currentTarget); onCopyToManual(); }}
              title={copyFeedback.copied
                ? 'Copied — the new layer is in the Annotate tab'
                : existingCopyCount > 0
                  ? `Copy to manual layer — ${existingCopyCount} existing ${existingCopyCount === 1 ? 'copy' : 'copies'}`
                  : `Copy "${layer.name}" to a new editable manual layer`}
              className={`ml-0.5 inline-flex items-center justify-center align-middle ${LABEL_ICON_BOX} rounded text-[14px] leading-none transition-all ${
                copyFeedback.copied
                  ? 'opacity-100 text-[#0a0b0d] bg-emerald-400 font-bold'
                  : isSelected || existingCopyCount > 0
                    ? existingCopyCount > 0
                      ? 'opacity-100 text-amber-300 hover:text-amber-100 hover:bg-amber-500/25'
                      : 'opacity-100 text-emerald-300 hover:text-emerald-100 hover:bg-emerald-500/20'
                    : 'opacity-0 pointer-events-none'
              }`}
            >
              {copyFeedback.copied ? '✓' : '⬇'}
            </button>
          )}
          <CopiedTag show={copyFeedback.copied} unchanged={copyFeedback.unchanged} at={copyFeedback.tagAt} />
          {onVisualizeToggle && (
            <VisualizeToggle on={!!visualize} color={layer.color} onToggle={onVisualizeToggle} />
          )}
        </span>
      )}
      </div>
      {onVisualizeToggle && (picking
        ? <VisualizePickCover on={!!visualize} color={layer.color} name={layer.name} onToggle={onVisualizeToggle} />
        : <VisualizePickMarker />)}
      <LabelResizeHandle onResizeStart={onResizeStart} />
    </div>
    {menu.popover}
    {infoOpen && (
      <div
        ref={info.popoverRef}
        style={info.positionStyle}
        className="z-50 w-[280px] rounded-md border border-gray-700 bg-[#0d0f13] p-3 shadow-xl text-left"
      >
        <div className="flex items-start gap-2 mb-2">
          <span
            className="mt-1 w-2.5 h-2.5 rounded-full shrink-0"
            style={{ background: layer.color }}
          />
          <div className="min-w-0 normal-case">
            <div className="text-[12px] font-semibold text-gray-100 leading-snug">
              {layer.name}
            </div>
            {/* What built it, on one line: the detector and the stem it read. */}
            {(detectorId || layer.sourceStem) && (
              <div className="text-[10px] text-gray-500 font-mono break-all leading-tight mt-0.5">
                {[detectorId, layer.sourceStem && (layer.sourceStem === 'stems'
                  ? 'read from several stems' : `${layer.sourceStem} stem`)].filter(Boolean).join(' · ')}
              </div>
            )}
          </div>
        </div>
        {markerCounts && (
          <div className="mb-2 normal-case">
            <div className="text-[11px] text-gray-200 mb-1">
              <span className="font-mono font-semibold text-gray-100">{markerCounts.total}</span>{' '}
              {markerCounts.noun}
              {markerCounts.kinds.length > 1 && (
                <span className="text-gray-500"> · {markerCounts.kinds.length} kinds</span>
              )}
            </div>
            {markerCounts.kinds.length > 0 && (
              <ul className="space-y-0.5 list-none max-h-[168px] overflow-y-auto pr-1">
                {(allKinds ? markerCounts.kinds : markerCounts.kinds.slice(0, CARD_KINDS_SHOWN)).map(({ kind, count }) => (
                  <li key={kind} className="flex items-center gap-2 text-[10px] leading-tight">
                    <span className="flex-1 min-w-0 truncate text-gray-300" title={kind}>{kind}</span>
                    <span
                      aria-hidden
                      className="h-1.5 rounded-full shrink-0"
                      style={{ width: `${Math.max(2, Math.round((count / markerCounts.kinds[0].count) * 64))}px`, background: `${layer.color}aa` }}
                    />
                    <span className="w-8 shrink-0 text-right font-mono text-gray-200">{count}</span>
                  </li>
                ))}
              </ul>
            )}
            {markerCounts.kinds.length > CARD_KINDS_SHOWN && (
              <button
                type="button"
                onClick={() => setAllKinds((v) => !v)}
                className="mt-1 text-[10px] text-gray-400 hover:text-gray-200 transition-colors"
              >
                {allKinds ? 'show fewer' : `+${markerCounts.kinds.length - CARD_KINDS_SHOWN} more kinds`}
              </button>
            )}
          </div>
        )}
        {layer.sourceDescription && (
          <div className="mb-2 normal-case">
            <p className={`text-[11px] text-gray-300 leading-snug ${descOpen ? '' : 'line-clamp-3'}`}>
              {layer.sourceDescription}
            </p>
            {layer.sourceDescription.length > CARD_DESC_CLAMP_CHARS && (
              <button
                type="button"
                onClick={() => setDescOpen((v) => !v)}
                className="mt-0.5 text-[10px] text-gray-400 hover:text-gray-200 transition-colors"
              >
                {descOpen ? 'less' : 'more'}
              </button>
            )}
          </div>
        )}
        {/* The detector's own account of what it kept and turned away. Useful
            when a lane looks wrong, noise when it doesn't — so one line that
            says they exist, and the notes themselves a click away. */}
        {runNotes.length > 0 && (
          <div className="mb-1 normal-case">
            <button
              type="button"
              aria-expanded={notesOpen}
              onClick={() => setNotesOpen((v) => !v)}
              className="w-full flex items-center gap-1.5 text-left text-[11px] text-amber-300 hover:text-amber-200 transition-colors"
            >
              <span aria-hidden>⚠</span>
              <span className="flex-1">
                {runNotes.length} note{runNotes.length > 1 ? 's' : ''} from this run
              </span>
              <svg
                aria-hidden
                viewBox="0 0 10 10"
                className={`w-3 h-3 shrink-0 fill-current transition-transform ${notesOpen ? 'rotate-90' : ''}`}
              >
                <path d="M2 0.5 L9 5 L2 9.5 Z" />
              </svg>
            </button>
            {notesOpen && (
              <ul className="mt-1.5 space-y-1.5 list-none border-l border-amber-400/30 pl-2 max-h-[220px] overflow-y-auto pr-1">
                {runNotes.map((n) => (
                  <li key={n.code} className="text-[10px] text-amber-100/90 leading-snug">
                    {n.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {onCopyToManual && (
          <div className="mt-3 pt-2 border-t border-gray-700/70">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); copyFeedback.arm(copyButtonRef.current ?? e.currentTarget); onCopyToManual(); info.close(); }}
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
        {onVisualizeToggle && (
          <div className={onCopyToManual ? 'mt-1.5' : 'mt-3 pt-2 border-t border-gray-700/70'}>
            <VisualizeCardButton on={!!visualize} color={layer.color} onToggle={onVisualizeToggle} />
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

function SectionBlockRow({ sections, duration, height = 22, onBoundaryChange, onBoundaryDragStart, onSectionClick, sectionColorOverrides, boundaryColoringMode, gridProps, pendingSelection, visualize }: {
  /** `color` is a derived row's own hue (a review status, a detector); the
   *  alternating palette may replace it. `ownColor` is a colour the curator
   *  chose for that one section in its card, and wins in every mode. */
  sections: { time: number; endTime: number; label: string; type: string; color?: string; ownColor?: string; importance?: string }[];
  duration: number;
  height?: number;
  onBoundaryChange?: (nextSectionIndex: number, newTime: number) => void;
  onBoundaryDragStart?: () => void;
  onSectionClick?: (sectionIndex: number, anchor: { x: number; y: number }) => void;
  sectionColorOverrides?: Record<string, string>;
  boundaryColoringMode?: BoundaryColoringMode;
  gridProps?: GridProps;
  pendingSelection?: PendingSelection | null;
  /** Visualize: light the section under the playhead. */
  visualize?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;
  const litIdx = usePlayheadValue((t) => (visualize
    ? sections.findIndex((s) => s.time <= t && t < s.endTime)
    : -1));

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
    <div ref={containerRef} className="flex-1 relative rounded overflow-hidden bg-gray-950" style={{ minHeight: height }}>
      {sections.map((s, i) => {
        const left  = duration > 0 ? (s.time / duration) * 100 : 0;
        // No floor in % of the song: 0.3% of a six-minute track is a second,
        // drawn past the section's real end at every zoom. A short section
        // gets MIN_BAND_PX of screen instead — nothing once it can be seen.
        const width = duration > 0 ? ((s.endTime - s.time) / duration) * 100 : 0;
        // Filler caps are drawn as empty space; an orphaned section (unset
        // only because its type left the vocabulary) is real annotation and
        // keeps its block and label, in the neutral unset gray.
        const isUnset = s.type === 'unset' && !isOrphanedSection(s);
        const baseColor = s.ownColor ?? (boundaryColoringMode === 'alternating'
          ? ALTERNATING_PALETTE[i % ALTERNATING_PALETTE.length]
          : (s.color ?? sectionColorOverrides?.[s.type] ?? sectionBg(s.type)));
        const isOptional = s.importance === 'optional';
        const lit = i === litIdx && !isUnset;
        const bg = isUnset
          ? 'transparent'
          : isOptional
            ? `radial-gradient(circle, ${baseColor}55 1px, transparent 1.6px) 0 0 / 6px 6px, ${baseColor}aa`
            : baseColor;
        return (
          <div
            key={i}
            data-section-index={i}
            className={`absolute top-0 bottom-0 overflow-hidden ${onSectionClick ? 'cursor-pointer hover:ring-1 hover:ring-white/40' : ''}`}
            style={{
              left: `${left}%`, width: `${width}%`, minWidth: MIN_BAND_PX, background: bg,
              opacity: isUnset || lit ? 1 : (isOptional ? 0.85 : (i % 2 === 0 ? 1 : 0.85)),
              // The seam between sections is drawn on the boundary itself — the
              // first pixel of the section it opens. A right border painted the
              // section ending a pixel early, inside its own box.
              boxShadow: lit ? `inset 1px 0 0 rgba(0,0,0,0.4), ${litShadow(baseColor)}` : 'inset 1px 0 0 rgba(0,0,0,0.4)',
              filter: lit ? 'brightness(1.3)' : undefined,
            }}
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

// ─── Sparkline row ────────────────────────────────────────────────────────────

/** Stand-in for a curve that hasn't been computed yet. A module constant, not
 *  a fresh `[]` per render: the lane's paint callback is keyed on `data`, and
 *  a new array every render would repaint the whole strip for nothing. */
const EMPTY_CURVE: number[] = [];

// Max internal-buffer width before the canvas hits the browser's max-canvas
// size and renders a broken-image placeholder. At Ultra zoom the CSS width can
// exceed this, so we drop the effective dpr to keep the buffer underneath the
// limit — the sparkline appears softer but always paints.

/**
 * Visualize on a signal curve: a dot riding the curve at the playhead, its
 * glow and size following the value there — so an onset lane flashes on each
 * attack and a volume lane swells with the music. It follows the clock by
 * writing its own style, so the canvas under it never re-renders.
 */
function LitCurveDot({ data, axis, duration, color }: {
  data: readonly number[];
  axis?: FrameAxis;
  duration: number;
  color: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  usePlayheadEffect((t) => {
    const el = ref.current;
    if (!el) return;
    const n = data.length;
    if (!n || !(duration > 0)) { el.style.display = 'none'; return; }
    const i = axis
      ? frameAtTime(t, axis)
      : Math.max(0, Math.min(n - 1, Math.round((t / duration) * (n - 1))));
    const v = Math.max(0, Math.min(1, data[i] ?? 0));
    const size = 4 + v * 6;
    el.style.display = '';
    el.style.left = `${(Math.max(0, Math.min(duration, t)) / duration) * 100}%`;
    el.style.bottom = `calc(2px + (100% - 4px) * ${v})`;
    el.style.width = el.style.height = `${size}px`;
    el.style.boxShadow = `0 0 ${3 + v * 12}px ${color}, 0 0 ${2 + v * 4}px ${color}`;
    el.style.opacity = String(0.55 + v * 0.45);
  }, [data, axis, duration, color], usePaintClock());
  return (
    <span
      ref={ref}
      aria-hidden
      data-testid="signal-lit-dot"
      className="absolute rounded-full pointer-events-none z-[7] -translate-x-1/2 translate-y-1/2"
      style={{ background: '#ffffff' }}
    />
  );
}

function Sparkline({ data, color, height = 40, duration, label, signalName, signalId, loading = false, onSeek, onRegion, onRegionDragStart, dragHandlers, onResizeStart, pendingSelection, dragCursorTime, gridProps, frameAxis: axisProp, overlay, visualize = false, onVisualizeToggle }: {
  data: number[]; color: string; height?: number;
  /** Visualize with playback: light the curve's value under the playhead. */
  visualize?: boolean;
  /** Turn this lane's Visualize on or off. */
  onVisualizeToggle?: () => void;
  /** Marks drawn over the curve (SignalMarksOverlay). */
  overlay?: React.ReactNode;
  duration: number; label: string;
  /** What the SIGNALS dropdown calls this curve, when the lane's own label is
   *  an abbreviation of it. The empty state quotes the dropdown's wording, so
   *  the line answers the tick the reader just made. */
  signalName?: string;
  /** Row id — the lane name opens this signal's info card. */
  signalId?: string;
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
  return (
    <div className="flex flex-1 min-w-0 items-stretch">
      <RowLabel text={label} dragHandlers={dragHandlers} onResizeStart={onResizeStart} signalId={signalId} visualize={visualize} onVisualizeToggle={onVisualizeToggle} />
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
        {visualize && hasData && <LitCurveDot data={data} axis={axis} duration={duration} color={color} />}
        <PlayheadLine
          duration={duration}
          style={{ background: 'rgba(255,255,255,0.75)', boxShadow: '0 0 3px rgba(255,255,255,0.5)' }}
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
function GridSourceBadge({ source, large = false, vertical = false }: { source: string; large?: boolean; vertical?: boolean }) {
  const tone: Record<string, string> = {
    'song-info': 'bg-emerald-900/50 text-emerald-300 border-emerald-700/50',
    allin1:      'bg-amber-900/50 text-amber-300 border-amber-700/50',
    librosa:     'bg-rose-900/50 text-rose-300 border-rose-700/50',
    'my grid':   'bg-emerald-900/50 text-emerald-300 border-emerald-700/50',
    'auto grid': 'bg-amber-900/50 text-amber-300 border-amber-700/50',
  };
  const title: Record<string, string> = {
    'song-info': 'Loops aligned to the curator-aligned grid (data/song-info) — best alignment with your bars.',
    allin1:      'Loops aligned to the auto-detected allin1 grid (no curator grid for this song).',
    librosa:     "Loops aligned to librosa's own beat tracking (no song-info or allin1 grid found) — may drift from your bars.",
    'my grid':   "Run on this song's grid, as you set it in Dataset Prep → Song Setup.",
    'auto grid': "Run on the algorithm's own tracked beats, not your grid — may drift from your bars.",
  };
  return (
    <span
      title={title[source] ?? `Loop grid: ${source}`}
      // Read along the lane name: up the row when the titles run vertically.
      style={vertical ? { writingMode: 'vertical-rl', transform: 'rotate(180deg)' } : undefined}
      className={`${large ? (vertical ? 'ml-0.5 py-1 px-0 text-[9px]' : 'mt-0.5 px-1 text-[9px]') : 'ml-0.5 px-1 text-[7px]'} inline-block align-middle whitespace-nowrap rounded-sm font-semibold leading-[1.4] normal-case border ${
        tone[source] ?? 'bg-slate-800/60 text-slate-300 border-slate-600/50'
      }`}
    >
      {source}
    </span>
  );
}

/** A point tick is `w-2` (8 px) wide, centred on its time and nudged sideways
 *  when it shares an onset (stackTicks). Done with a margin, not a transform:
 *  a transform per tick is one more compositor node per hit, and with a drum
 *  lane's thousands of hits re-layering them was most of every scrolled
 *  frame. */
function tickMarginLeft(offsetPx: number): string {
  return `${offsetPx - 4}px`;
}

/**
 * The one point tick the playhead crossed last, drawn lit over the lane. It
 * follows the clock on its own, so crossing a hit re-renders this element and
 * not the thousands of ticks under it.
 */
function LitTick({ sections, duration, heights, stacks, baseColor }: {
  sections: readonly { time: number; color?: string; velocity?: number }[];
  duration: number;
  heights: readonly number[];
  stacks: readonly { offsetPx: number; zIndex: number }[];
  baseColor: string;
}) {
  // Detector cues arrive in time order; a hand-built list might not, and then
  // the scan is linear rather than wrong.
  const sorted = useMemo(() => sections.every((s, i) => i === 0 || sections[i - 1].time <= s.time), [sections]);
  const i = usePlayheadValue((t) => {
    if (sorted) {
      let lo = 0, hi = sections.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (sections[m].time <= t) lo = m + 1; else hi = m; }
      return lo - 1;
    }
    let last = -1;
    sections.forEach((s, j) => { if (s.time <= t) last = j; });
    return last;
  });
  const s = i >= 0 ? sections[i] : undefined;
  if (!s || duration <= 0) return null;
  const color = s.color ?? baseColor;
  return (
    <span
      aria-hidden
      data-testid="algo-lit-tick"
      className={`absolute top-0 bottom-0 w-2 flex ${typeof s.velocity === 'number' ? 'items-end' : 'items-stretch'} justify-center pointer-events-none`}
      style={{ left: `${(s.time / duration) * 100}%`, marginLeft: tickMarginLeft(stacks[i]?.offsetPx ?? 0), zIndex: (stacks[i]?.zIndex ?? 0) + 1 }}
    >
      <span
        className="block w-[3px] rounded-sm"
        style={{ height: `${heights[i]}%`, background: '#ffffff', boxShadow: `0 0 10px ${color}, 0 0 3px ${color}` }}
      />
    </span>
  );
}

function AlgoTimelineRow({ sections, duration, label, labelColor, renderKind = 'boundary', dragHandlers, onResizeStart, sectionColorOverrides, boundaryColoringMode, gridProps, focusedSectionIdx, onSectionClick, info, infoId, gridSource, onSelect, isSelected, onCopyToManual, existingCopyCount = 0, onToggleMergeMember, isMergeMember = false, visualize = false, onVisualizeToggle, onRemoveLane }: {
  sections: { time: number; endTime: number; label: string; type: string; color?: string; velocity?: number; levelDb?: number }[];
  duration: number; label: string;
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
  /** Visualize with playback: light the section or band under the playhead,
   *  or the tick most recently crossed. */
  visualize?: boolean;
  onVisualizeToggle?: () => void;
  /** The last item of the lane's ⋮ menu (see LaneRemove). */
  onRemoveLane?: LaneRemove;
}) {
  // For span/point rows the per-section `type` is content-derived (a chord
  // name, a note pitch, an event class…) and never matches SECTION_COLORS, so
  // it would fall through to the near-invisible slate-400 default. Use the
  // row's algo color as the base instead so these rows read as "their" hue.
  const baseColor = labelColor ?? sectionBg('default');
  // ⓘ provenance popover — what model produced this lane, what it extracts, and
  // its input / output. Same control + placement as the curated lanes' ⓘ.
  const infoPop = useAnnotationPopover({ width: 330, height: 280 });
  const infoKey = infoId ?? label;
  const infoOpen = !!info && infoPop.open?.layerId === infoKey;
  const accent = labelColor ?? '#94a3b8';
  // ⋮ lane actions — the merge membership lives here, as on the annotation
  // lanes, rather than as its own button: sideways, a ⊕ stacked under the ◇
  // ran past a short lane and was clipped to a purple sliver. Declared before
  // the label fit (see LayerRowLabel).
  const menu = useLaneMenu({
    id: infoKey,
    name: label,
    remove: onRemoveLane,
    title: isMergeMember ? 'In the merge — click to change' : undefined,
    common: {
      visualize: onVisualizeToggle ? { on: visualize, color: accent, toggle: onVisualizeToggle } : undefined,
      about: info ? () => {
        const r = cellRef.current?.getBoundingClientRect();
        if (r) infoPop.openAt(infoKey, 'info', { x: r.right, y: r.top });
      } : undefined,
      copy: onCopyToManual ? {
        existing: existingCopyCount ?? 0,
        run: () => {
          const el = copyButtonRef.current ?? cellRef.current;
          if (el) copyFeedback.arm(el);
          onCopyToManual();
        },
      } : undefined,
    },
    // The click-based twin of dragging this lane onto the Merge row.
    items: onToggleMergeMember ? (close) => (
      <button
        type="button"
        onClick={() => { close(); onToggleMergeMember(); }}
        title={isMergeMember ? undefined : 'Blend its boundaries with the other lanes you pick'}
        className={`${MENU_ROW_SHAPE} text-violet-200 hover:bg-violet-500/15`}
      >
        {isMergeMember ? '⊖ Remove from merge' : '⊕ Add to merge'}
      </button>
    ) : undefined,
  });
  // A grid-cut algorithm's "my grid" / "auto grid" tag, always on show.
  const laneGrid = gridSource === 'my grid' || gridSource === 'auto grid';
  // Affordance strip on the selected lane only, ⋮ in the corner — see LayerRowLabel.
  const hasIcons = (!!isSelected && (!!info || (!!gridSource && !laneGrid) || !!onCopyToManual || !!onVisualizeToggle))
    || (visualize && !!onVisualizeToggle);
  // What is sounding, as one string key so the row re-renders only when it
  // changes: every band under the playhead (bands may overlap), the section
  // under it, or — for ticks, which have no length — the last one crossed.
  // Ticks are lit by <LitTick> instead: a drum lane has thousands of them,
  // and re-rendering every one each time the playhead crossed a hit (several
  // times a second) is what made the lane stutter.
  const litKey = usePlayheadValue((t) => {
    if (!visualize || renderKind === 'point') return '';
    let key = '';
    sections.forEach((s, i) => { if (s.time <= t && t < s.endTime) key += `${i},`; });
    return key;
  });
  const lit = useMemo(() => new Set(litKey.split(',').filter(Boolean).map(Number)), [litKey]);
  const picking = useContext(VisualizePickContext);
  const { cellRef, nameRef, bodyClass, iconsClass, nameStyle, minHeight, shown, vertical } = useLabelFit(hasIcons, label, menu.has ? MENU_CLEARANCE_PX : 0);
  const copyFeedback = useCopyFeedback(existingCopyCount ?? 0);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  // A drum hit's tick stands as tall as it was struck (tickHeightPct), and
  // hits sharing an onset stack by the same rule as the cue lane, so a snare
  // under a kick is never hidden.
  const tickHeights = useMemo(
    () => renderKind === 'point'
      ? sections.map((s) => tickHeightPct(s.velocity))
      : [],
    [renderKind, sections],
  );
  const tickStacks = useMemo(
    () => stackTicks(tickHeights.map((heightPct, i) => ({ time: sections[i].time, heightPct }))),
    [tickHeights, sections],
  );
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
        <CopiedCellFlash show={copyFeedback.copied} />
        <LaneMenuCorner button={menu.button} />
        <div
          className={bodyClass}
          style={{
            color: labelColor ?? undefined,
            textShadow: isSelected ? `0 0 6px ${accent}cc, 0 0 12px ${accent}66` : undefined,
            ...laneMenuClearance(menu.has, vertical),
          }}
        >
          <span
            ref={nameRef}
            className={`text-[10px] tracking-wide text-center leading-tight min-w-0 max-w-full ${isSelected ? 'font-bold' : ''}`}
            style={nameStyle}
          >{shown}</span>
          {/* Whose beats a grid-cut algorithm ran on is part of what the lane
              IS, so it shows on every such lane, selected or not. */}
          {laneGrid && <GridSourceBadge source={gridSource!} large vertical={vertical} />}
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
                className={`ml-0.5 inline-flex items-center justify-center align-middle w-4 h-4 rounded-full text-[10px] font-bold leading-none transition-colors ${
                  infoOpen ? 'text-[#0a0b0d]' : 'text-gray-500 hover:text-gray-200'
                }`}
                style={infoOpen ? { background: accent } : { border: '1px solid currentColor' }}
              >
                i
              </button>
            )}
            {gridSource && !laneGrid && <GridSourceBadge source={gridSource} />}
            {onCopyToManual && (
              <button
                ref={copyButtonRef}
                type="button"
                disabled={copyFeedback.copied}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); copyFeedback.arm(e.currentTarget); onCopyToManual(); }}
                title={copyFeedback.copied
                  ? 'Copied — the new layer is in the Annotate tab'
                  : (existingCopyCount ?? 0) > 0
                    ? `Copy to manual layer — ${existingCopyCount} existing ${existingCopyCount === 1 ? 'copy' : 'copies'}`
                    : `Copy "${label}" to a new editable manual layer`}
                className={`ml-0.5 inline-flex items-center justify-center align-middle ${LABEL_ICON_BOX} rounded text-[14px] leading-none transition-all ${
                  copyFeedback.copied
                    ? 'opacity-100 text-[#0a0b0d] bg-emerald-400 font-bold'
                    : isSelected || (existingCopyCount ?? 0) > 0
                      ? (existingCopyCount ?? 0) > 0
                        ? 'opacity-100 text-amber-300 hover:text-amber-100 hover:bg-amber-500/25'
                        : 'opacity-100 text-emerald-300 hover:text-emerald-100 hover:bg-emerald-500/20'
                      : 'opacity-0 pointer-events-none'
                }`}
              >
                {copyFeedback.copied ? '✓' : '⬇'}
              </button>
            )}
            <CopiedTag show={copyFeedback.copied} unchanged={copyFeedback.unchanged} at={copyFeedback.tagAt} />
            {onVisualizeToggle && (
              <VisualizeToggle on={visualize} color={accent} onToggle={onVisualizeToggle} />
            )}
          </span>
          )}
        </div>
        {onVisualizeToggle && (picking
          ? <VisualizePickCover on={visualize} color={accent} name={label} onToggle={onVisualizeToggle} />
          : <VisualizePickMarker />)}
        <LabelResizeHandle onResizeStart={onResizeStart} />
      </div>
      <div className="flex-1 relative min-h-5 rounded overflow-hidden bg-gray-950">
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
            const hasVelocity = typeof s.velocity === 'number';
            const tickHeight = `${tickHeights[i]}%`;
            const stack = tickStacks[i];
            const together = stack.together.length > 1
              ? `\n${stack.together.length} hits at once: ${stack.together.map((j) => sections[j].label || sections[j].type).join(', ')}`
              : '';
            const tickTitle = (hasVelocity
              ? (onSectionClick ? `Click to view output · ${drumHitTitle(s)}` : drumHitTitle(s))
              : title) + together;
            return (
              <button key={i}
                className={`absolute top-0 bottom-0 w-2 flex ${hasVelocity ? 'items-end' : 'items-stretch'} justify-center group/algotick ${onSectionClick ? 'cursor-pointer' : 'cursor-default'}`}
                style={{ left: `${left}%`, marginLeft: tickMarginLeft(stack.offsetPx), zIndex: stack.zIndex }}
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
            const width = ((s.endTime - s.time) / duration) * 100;
            return (
              <div key={i}
                className={`absolute top-0 bottom-0 overflow-hidden ${onSectionClick ? 'cursor-pointer hover:brightness-125' : ''}`}
                style={{
                  left: `${left}%`, width: `${width}%`, minWidth: MIN_BAND_PX,
                  background: lit.has(i) ? `${color}99` : `${color}55`,
                  boxShadow: lit.has(i) ? litShadow(color)
                    : isFocused
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
          const width = ((s.endTime - s.time) / duration) * 100;
          const blockColor = boundaryColoringMode === 'alternating'
            ? ALTERNATING_PALETTE[i % ALTERNATING_PALETTE.length]
            : (s.color ?? sectionColorOverrides?.[s.type] ?? sectionBg(s.type));
          return (
            <div key={i}
              className={`absolute top-0 bottom-0 ${onSectionClick ? 'cursor-pointer hover:ring-1 hover:ring-white/40' : ''}`}
              style={{
                left: `${left}%`, width: `${width}%`, minWidth: MIN_BAND_PX,
                background: blockColor,
                opacity: isFocused || lit.has(i) ? 1 : 0.78,
                // Seam on the boundary (this block's first pixel), not a
                // border inside the previous block's end.
                boxShadow: `inset 1px 0 0 rgba(0,0,0,0.5), ${lit.has(i) ? litShadow(blockColor)
                  : isFocused
                    ? 'inset 0 0 0 1px rgba(255,255,255,0.65), 0 0 6px rgba(255,255,255,0.25)'
                    : 'inset 0 0 0 1px rgba(255,255,255,0.22)'}`,
                filter: lit.has(i) ? 'brightness(1.3)' : undefined,
              }}
              onClick={onClick}
              title={title}
            />
          );
        })}
        {visualize && renderKind === 'point' && (
          <LitTick sections={sections} duration={duration} heights={tickHeights} stacks={tickStacks} baseColor={baseColor} />
        )}
        {gridProps && (
          <BeatGridOverlay {...gridProps} duration={duration} />
        )}
        <PlayheadLine duration={duration} style={{ background: 'rgba(255,255,255,0.75)' }} />
      </div>
    </div>
    {menu.popover}
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
// carries a ×N badge and the first member's color. Neighbouring blocks
// alternate between that color and a darker shade of it: members often share
// a hue (two green lanes), and a run of same-colored blocks reads as one bar.
//
// A boundary the annotator drops by hand is not discarded — it stays on the
// lane as a dim ghost tick, one click from coming back. See boundaryMerge.ts.
//
// Click a block for the same popover a boundary on a layer opens — type,
// label, description, time, split, drop. A click never drops on its own: a
// boundary gone from the blend should be something the annotator chose in a
// card that said what it was, not a misfire while reaching for the playhead.

function MergeLaneRow({
  merged, memberLanes, duration, visualize = false, onVisualizeToggle,
  dragHandlers, onResizeStart, gridProps,
  isDropTarget, onToggleBoundary, onEditBoundary, selectedTime, onRemoveLane,
}: {
  merged: MergedBoundary[];
  memberLanes: MergeSourceLane[];
  duration: number;
  dragHandlers?: RowDragHandlers;
  onResizeStart?: (e: React.PointerEvent) => void;
  gridProps?: GridProps;
  /** A lane is being dragged over this row right now. */
  isDropTarget?: boolean;
  /** Drop one merged boundary by hand, or put a dropped one back. */
  onToggleBoundary?: (b: MergedBoundary) => void;
  /** Open the boundary popover on a kept boundary (click). */
  onEditBoundary?: (b: MergedBoundary, anchor: { x: number; y: number }) => void;
  /** The boundary whose popover is open (its reported time), to highlight. */
  selectedTime?: number;
  /** Visualize with playback: light the block under the playhead. */
  visualize?: boolean;
  /** Turn this lane's Visualize on or off. */
  onVisualizeToggle?: () => void;
  /** The last item of the lane's ⋮ menu (see LaneRemove): empty the merge and
   *  take the row away. */
  onRemoveLane?: LaneRemove;
}) {
  const accent = memberLanes.length > 0 ? '#c084fc' : '#4b5563';
  const label = memberLanes.length > 0 ? `Merge ×${memberLanes.length}` : 'Merge';
  const kept = keptInOrder(merged);
  // An empty merge has nothing to play along with, so it offers no Visualize.
  const canVisualize = !!onVisualizeToggle && kept.length > 0;
  // Declared before the label fit (see LayerRowLabel).
  const menu = useLaneMenu({
    id: 'merge',
    name: label,
    remove: onRemoveLane,
    common: { visualize: canVisualize ? { on: visualize, color: accent, toggle: onVisualizeToggle! } : undefined },
  });
  // The member names take the line an affordance strip would (hence the
  // `hasIcons` room); the sideways gutter has no such line, and there the
  // hover title names them instead.
  const { cellRef, nameRef, bodyClass, nameStyle, minHeight, shown, vertical } = useLabelFit(memberLanes.length > 0, label, menu.has ? MENU_CLEARANCE_PX : 0);
  const strip = useContext(GutterStripContext);
  const laneName = (id: string) => id === HAND_LANE_ID ? 'Split by hand' : memberLanes.find((l) => l.id === id)?.label ?? id;
  const laneColor = (id: string) => memberLanes.find((l) => l.id === id)?.color ?? '#94a3b8';
  const picking = useContext(VisualizePickContext);
  const litIdx = usePlayheadValue((t) => {
    if (!visualize || !canVisualize) return -1;
    for (let i = kept.length - 1; i >= 0; i--) if (mergedStart(kept[i]) <= t) return i;
    return -1;
  });

  return (
    <div className="flex flex-1 min-w-0 items-stretch">
      <div
        ref={cellRef}
        className={`${STICKY_LABEL_CELL} group/mergelabel transition-colors ${dragHandlers ? 'cursor-grab active:cursor-grabbing' : ''}`}
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
          ? `Merged from ${memberLanes.map((l) => `${l.label}${l.hidden ? ' (lane hidden)' : ''}`).join(', ')} — drag another boundary lane here to add it`
          : 'Drag a boundary lane onto this row to start a merge'}
      >
        <div className={bodyClass} style={{ color: accent, ...laneMenuClearance(menu.has, vertical) }}>
          <span
            ref={nameRef}
            className="text-[10px] tracking-wide text-center leading-tight min-w-0 max-w-full font-bold"
            style={nameStyle}
          >{shown}</span>
          {/* Who feeds the blend, named where the lane is — it is the only
              place a hidden member is still visible from the canvas. */}
          {memberLanes.length > 0 && !vertical && !strip && (
            <span className="flex flex-wrap justify-center gap-x-1 text-[9px] leading-tight font-medium min-w-0 max-w-full">
              {memberLanes.map((l) => (
                <span key={l.id} className={`truncate ${l.hidden ? 'italic opacity-70' : ''}`} style={{ color: l.color }}>
                  {l.label}
                </span>
              ))}
            </span>
          )}
        </div>
        {/* The member names own the line under the label; the ◈ rides with
            the ⋮ while the lane is visualized. */}
        <LaneMenuCorner button={menu.button}>
          {visualize && canVisualize && (
            <VisualizeToggle on color={accent} onToggle={onVisualizeToggle!} />
          )}
        </LaneMenuCorner>
        {canVisualize && (picking
          ? <VisualizePickCover on={visualize} color={accent} name={label} onToggle={onVisualizeToggle!} />
          : <VisualizePickMarker />)}
        <LabelResizeHandle onResizeStart={onResizeStart} />
      </div>
      {menu.popover}
      <div
        className={`flex-1 relative min-h-5 rounded overflow-hidden transition-colors ${
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
              const start = mergedStart(b);
              const end = kept[i + 1] ? mergedStart(kept[i + 1]) : duration;
              const left = (start / duration) * 100;
              const width = ((end - start) / duration) * 100;
              const color = b.edit?.color ?? laneColor(b.laneIds[0]);
              const selected = selectedTime === b.time;
              const lit = i === litIdx;
              return (
                <div
                  key={`k${b.time}`}
                  className="absolute top-0 bottom-0 overflow-hidden cursor-pointer hover:ring-1 hover:ring-white/50"
                  style={{
                    left: `${left}%`, width: `${width}%`, minWidth: MIN_BAND_PX,
                    // The boundary IS the block's left edge, so the open one
                    // lights that edge up, not just the block. The seam sits
                    // on that edge too — never as a border inside the end.
                    boxShadow: selected
                      ? 'inset 3px 0 0 0 #fff, inset 0 0 0 1px rgba(255,255,255,0.9)'
                      : `inset 1px 0 0 rgba(0,0,0,0.5), ${lit ? litShadow(color) : 'inset 0 0 0 1px rgba(255,255,255,0.22)'}`,
                    zIndex: selected ? 1 : undefined,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (onEditBoundary) onEditBoundary(b, { x: e.clientX, y: e.clientY });
                    else onToggleBoundary?.(b);
                  }}
                  title={`Boundary #${i + 1} — the line at this block's left edge, ${fmtMergeTime(start)}\n${b.edit?.label ? `${b.edit.label}\n` : ''}${b.laneIds.map(laneName).join(', ')}\n${b.smart ? `Placed ${b.smart.note} — the lanes said ${b.rawTimes.map(fmtMergeTime).join(', ')}\n` : ''}${onEditBoundary ? 'Click to edit, split or drop this boundary' : 'Click to drop this boundary from the merge'}`}
                >
                  {/* The fill sits on its own layer so the darker shade of every
                      other block doesn't darken the number and label too. */}
                  <div
                    className="absolute inset-0 pointer-events-none"
                    style={{
                      background: color,
                      opacity: selected || lit ? 1 : 0.78,
                      filter: lit ? 'brightness(1.3)' : i % 2 === 1 ? 'brightness(0.55) saturate(1.2)' : undefined,
                    }}
                  />
                  {b.edit?.label && (
                    <span className="absolute inset-x-0.5 bottom-0 text-[10px] truncate text-white/85 pointer-events-none select-none leading-tight">
                      {b.edit.label}
                    </span>
                  )}
                  {/* The number the popover's "Boundary #N" header uses, so a
                      block on the row and the card it opens name the same
                      boundary. "×2" only when more than one lane landed here —
                      in a union "×1" is every block, which is no information. */}
                  <span
                    className="absolute left-1 top-0 text-[9px] leading-tight text-white font-mono font-bold whitespace-nowrap pointer-events-none select-none"
                    style={{ textShadow: '0 0 2px #000, 0 0 2px #000' }}
                  >
                    #{i + 1}{b.agreement > 1 ? ` ×${b.agreement}` : ''}
                  </span>
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
                  style={{ left: `${(mergedStart(b) / duration) * 100}%`, transform: 'translateX(-50%)' }}
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
        <PlayheadLine duration={duration} style={{ background: 'rgba(255,255,255,0.75)' }} />
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
  blocks, refMisses, duration,
  referenceLabel, tolerance,
  dragHandlers, onResizeStart, gridProps, onSeek, onHide, onCopy, existingCopyCount = 0,
  visualize = false, onVisualizeToggle,
}: {
  blocks: ConsensusBlock[];
  /** Reference boundaries the consensus never matched (FN), as ticks. */
  refMisses?: number[];
  duration: number;
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
  /** Visualize with playback: light the block under the playhead. */
  visualize?: boolean;
  /** Turn this lane's Visualize on or off. */
  onVisualizeToggle?: () => void;
}) {
  const accent = CONSENSUS_NEUTRAL_COLOR;
  // Just the name. "×28" would read as a member count next to Merge's "×2",
  // and the boundary tally is already stated by the stage that built it.
  const label = 'Consensus';
  // Declared before the label fit (see LayerRowLabel).
  const menu = useLaneMenu({
    id: 'consensus',
    name: label,
    remove: onHide ? { kind: 'hide', from: 'Algos ▾ → Consensus', run: onHide } : undefined,
    common: {
      visualize: onVisualizeToggle ? { on: visualize, color: accent, toggle: onVisualizeToggle } : undefined,
      copy: onCopy ? {
        existing: existingCopyCount,
        run: () => {
          const el = copyButtonRef.current ?? cellRef.current;
          if (el) copyFeedback.arm(el);
          onCopy();
        },
      } : undefined,
    },
  });
  const hasIcons = !!onCopy || !!onVisualizeToggle;
  const { cellRef, nameRef, bodyClass, iconsClass, nameStyle, minHeight, shown, vertical } = useLabelFit(hasIcons, label, menu.has ? MENU_CLEARANCE_PX : 0);
  const copyFeedback = useCopyFeedback(existingCopyCount);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const picking = useContext(VisualizePickContext);
  const litIdx = usePlayheadValue((t) => (visualize
    ? blocks.findIndex((b) => b.time <= t && t < b.endTime)
    : -1));
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
        <CopiedCellFlash show={copyFeedback.copied} />
        <div className={bodyClass} style={{ color: accent, ...laneMenuClearance(menu.has, vertical) }}>
          <span
            ref={nameRef}
            className="text-[10px] tracking-wide text-center leading-tight min-w-0 max-w-full font-bold"
            style={nameStyle}
          >{shown}</span>
          {/* The lane has no layer row in the sidebar and no items to edit, so
              everything you can do to it has to live here: ⬇ takes the blend
              into a layer you own, and ⋮ → Hide this lane takes the row off
              the timeline, saying that the checkbox that undoes it is one
              level into Algos ▾. */}
          {hasIcons && (
            <span className={iconsClass}>
              {onCopy && (
                <button
                  type="button"
                  aria-label="Copy the consensus into a boundary layer"
                  title={existingCopyCount > 0
                    ? `Copy the consensus into a new boundary layer you can edit — ${existingCopyCount} existing ${existingCopyCount === 1 ? 'copy' : 'copies'}`
                    : 'Copy the consensus into a new boundary layer you can edit. The blend itself stays read-only; the copy is yours, and its sections start untyped.'}
                  ref={copyButtonRef}
                  disabled={copyFeedback.copied}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); copyFeedback.arm(e.currentTarget); onCopy(); }}
                  className={`inline-flex items-center justify-center align-middle ${LABEL_ICON_BOX} rounded text-[14px] leading-none transition-colors ${
                    copyFeedback.copied
                      ? 'text-[#0a0b0d] bg-emerald-400 font-bold'
                      : existingCopyCount > 0
                        ? 'text-amber-300 hover:text-amber-100 hover:bg-amber-500/25'
                        : 'text-emerald-300/80 hover:text-emerald-100 hover:bg-emerald-500/20'
                  }`}
                >
                  {copyFeedback.copied ? '✓' : '⬇'}
                </button>
              )}
              <CopiedTag show={copyFeedback.copied} unchanged={copyFeedback.unchanged} at={copyFeedback.tagAt} />
              {onVisualizeToggle && (
                <VisualizeToggle on={visualize} color={accent} onToggle={onVisualizeToggle} />
              )}
            </span>
          )}
        </div>
        <LaneMenuCorner button={menu.button} />
        {onVisualizeToggle && (picking
          ? <VisualizePickCover on={visualize} color={accent} name={label} onToggle={onVisualizeToggle} />
          : <VisualizePickMarker />)}
        <LabelResizeHandle onResizeStart={onResizeStart} />
      </div>
      {menu.popover}
      <div className="flex-1 relative min-h-5 rounded overflow-hidden bg-gray-950">
        {blocks.map((b, i) => {
          const left  = duration > 0 ? (b.time / duration) * 100 : 0;
          const width = duration > 0 ? ((b.endTime - b.time) / duration) * 100 : 0;
          const isStatus = b.type === 'hit' || b.type === 'miss';
          const bg = b.type === 'hit' ? CONSENSUS_HIT_COLOR
            : b.type === 'miss' ? CONSENSUS_MISS_COLOR
            : CONSENSUS_NEUTRAL_COLOR;
          const lit = i === litIdx;
          return (
            <div
              key={`${b.time}-${i}`}
              className={`absolute top-0 bottom-0 overflow-hidden ${onSeek ? 'cursor-pointer hover:ring-1 hover:ring-white/50' : ''}`}
              style={{
                left: `${left}%`, width: `${width}%`, minWidth: MIN_BAND_PX, background: bg,
                opacity: lit ? 1 : isStatus ? 0.85 : 0.62,
                boxShadow: lit ? `inset 1px 0 0 rgba(0,0,0,0.3), ${litShadow(bg)}` : 'inset 1px 0 0 rgba(0,0,0,0.3)',
                filter: lit ? 'brightness(1.3)' : undefined,
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
        <PlayheadLine duration={duration} style={{ background: 'rgba(255,255,255,0.75)' }} />
      </div>
    </div>
  );
}

// ─── Spectrogram interactive overlay ─────────────────────────────────────────

function SpectrogramDragOverlay({
  duration,
  pendingSelection,
  onVizClick, onVizRegion, onRegionDragStart,
  snapToGrid, snapDivision, snapTimeOverride,
  bpm, beatOffset, beatsPerBar, beatOverrides,
}: {
  duration: number;
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
  /** Per-frame onsets below 120 Hz — the kick and bass landing. Beat strength
   *  is read off these against the beat grid. Optional: an older cached
   *  MirCurves predates it. */
  bassHits?: number[];
  /** Spectral bandwidth per frame, 0–1. Optional: an older cached MirCurves
   *  predates it. */
  bandwidth?: number[];
  /** Busyness bands' levels in dB, frame × nBusyBands (services/mirAnalysis).
   *  Optional: an older cached MirCurves predates it. */
  bandLevels?: Float32Array;
  nBusyBands?: number;
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
  /** Show the full-song overview strip at every zoom, not only zoomed in (Annotate). */
  songOverviewAlways?: boolean;
  trackName?: string;
  audioBuffer: AudioBuffer | null;
  duration: number;
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
  /** The beat grid is one of the things Visualize can play along with
   *  (DataPrep, where the grid is what is being checked). */
  gridVisualizable?: boolean;
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
  /** Overrides that snap for the active layer type. Lyrics pass the identity
   *  here: a drag-region over a sung word is never pulled onto a beat. */
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
  /** Plain loudness — `mirCurves.rms`. */
  showVolume?: boolean;
  /** Onset density — hits per beat (utils/rhythmSignals). */
  showDensity?: boolean;
  /** Busyness — notes per beat across 8 bands (utils/rhythmSignals). */
  showBusyness?: boolean;
  /** Spectral bandwidth — `mirCurves.bandwidth`. */
  showBandwidth?: boolean;
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
  /** A detector band's ⬇: copy every lane it shows, in canvas order, each
   *  into its own new layer — one copy, undone together. */
  onCopyDetectorGroup?: (groupName: string, rowIds: VizRowId[]) => void;
  /** How a drawn detector lane is deleted (see LaneRemove), from its id and
   *  items: a lane of several, a part lane, a detector's only lane, or a
   *  boundary detector's review row (`custom-annotation:<detector>`). */
  onDeleteDetectorLane?: (lane: { id: string; items?: readonly { id: string }[] }) => LaneRemove | undefined;
  /** How an algorithm lane's saved result is deleted, by its overlay id —
   *  absent when nothing is saved for this song. */
  onDeleteAlgoOverlay?: (overlayId: string) => LaneRemove | undefined;
  /** Delete one of the annotator's own layers (undoable). */
  onDeleteUserLayer?: (layer: AnnotationLayer) => void;
  /** The ⋮ actions on the annotator's own layers — duplicate, copy region,
   *  split, lock, merge. All undoable. */
  userLaneOps?: UserLaneOps;
  /** Lanes and items whose envelopes Extract ADSR is reading right now. */
  extractingAdsrIds?: ReadonlySet<string>;
  /** Delete the song's Auto-guess annotation. */
  onDeleteAutoGuess?: () => Promise<void>;
  /** Hide the Prominence lane (its checkbox is under Annotations ▾). */
  onHideProminence?: () => void;
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
  /** Take member lanes off the canvas (or put them back) while they keep
   *  feeding the merge. */
  onMergeSetLanesHidden?: (overlayIds: string[], hidden: boolean) => void;
  onMergeClear?: () => void;
  /** Flip one merged boundary between kept and dropped. */
  onMergeToggleBoundary?: (b: MergedBoundary) => void;
  /** Open the boundary popover on a merged boundary (click). */
  onMergeEditBoundary?: (b: MergedBoundary, anchor: { x: number; y: number }) => void;
  /** The merged boundary whose popover is open, highlighted on the row. */
  mergeSelectedTime?: number;
  onMergeRestoreDropped?: () => void;
  /** Write the kept boundaries into a new editable boundary layer. */
  onMergeCommit?: () => void;
  /** How many layers this merge has already been committed into. */
  mergeCommittedCount?: number;
  mergeCommittedNote?: string | null;
  /** One candidate per place (smartMerge.ts) instead of the union. */
  mergeSmart?: boolean;
  onMergeSetSmart?: (on: boolean) => void;

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
  /** Move `draggedId` to `place` of `targetId` (default 'before'). A band
   *  header id moves the whole band. */
  onReorderRow?: (draggedId: VizRowId, targetId: VizRowId, place?: ReorderPlace) => void;
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
   *  arrays: how many lanes are in the band. */
  groupState?: Record<string, { visibility: 'all' | 'some' | 'none'; count: number }>;
  onGroupToggleCollapsed?: (groupId: string) => void;
  onGroupRename?: (groupId: string, name: string) => void;
  onGroupUngroup?: (groupId: string) => void;
  onGroupDelete?: (groupId: string) => void;
  /** Bands the page draws but cannot edit — a detector group over detector
   *  lanes, which no document holds. Their headers collapse
   *  but offer no rename, ungroup or delete; no lane is offered a move into
   *  one, and nothing dragged onto one joins it. */
  readOnlyGroupIds?: ReadonlySet<string>;
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
  onDropRowInGroup?: (rowId: VizRowId, groupId: string | null, beforeRowId: VizRowId | null, place?: ReorderPlace) => void;
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
  /** The player's transport row above its waveform rather than under it. */
  playerTransportAbove?: boolean;
  /** Controls appended to the end of the player's transport row. */
  playerTransportTrailing?: ReactNode;
  /** Hide the entire Playback/Selection readout row above the player. Used in
   *  Dataset Prep, where the numeric readout adds clutter to grid setup. */
  hideTimeDisplay?: boolean;
  /** Called while the user holds Alt and drags any waveform horizontally to slide the grid. */
  onGridOffsetChange?: (newOffset: number) => void;
  /** Called once when an Alt-drag begins. Use to snapshot the previous offset for undo. */
  onGridOffsetDragStart?: (currentOffset: number) => void;
  /** When true, render bar numbers above bar lines on the main player waveform. */
  showBarNumbers?: boolean;
  /** Misc → "Show beat numbers": number every beat through the song, not just bars. */
  numberEveryGridLine?: boolean;
  /** Multiplier on every beat-grid line's width across all rows (1 = default). */
  gridLineThickness?: number;
  /** Demucs stem playback. When provided, a Source picker is shown above the player. */
  stemSource?: StemSource;
  availableStemSources?: StemSource[];
  onStemSourceChange?: (next: StemSource) => void;
  /** Drum-kit pieces split out of the drums stem — a sub-choice under Drums in
   *  the Source picker (see StemSourcePicker). */
  kitParts?: KitPart[];
  kitPart?: KitPart | null;
  onKitPartChange?: (next: KitPart | null) => void;
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
  /** Drag the nub at the end of a cue's tail to set its decay (seconds);
   *  `undefined` clears it. Only offered on lanes that aren't read-only. */
  onCueDecayDrag?: (layerId: string, itemId: string, decay: number | undefined) => void;
  onCueDecayDragStart?: (layerId: string, itemId: string) => void;
  /** A keyboard step of the decay from the focused nub; `repeat` = auto-repeat. */
  onCueDecayKey?: (layerId: string, itemId: string, decay: number | undefined, repeat: boolean) => void;
  /** User-created Loop layers.
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
  /** Editing on the lane itself (see laneCreate.ts): a click on a cue lane
   *  (t2 null) or a drag on a span / loop / lyrics lane makes that item in
   *  that lane. Handed only to editable lanes — detector lanes keep seek and
   *  the teal highlight. */
  onLaneCreate?: (layerId: string, t1: number, t2: number | null) => void;
  /** How a lane drag of each type snaps — the same rule the created item
   *  gets, so the preview shows where it will land. */
  laneCreateSnap?: (type: 'spans' | 'loops' | 'lyrics' | 'riff-patterns') => (t: number) => number;
  /** Building a riff on its lane (see RiffLaneEditor): the instance open in
   *  the editor, and what the editor does to the lane. */
  riffEditor?: { layerId: string; itemId: string; draft: boolean } | null;
  onRiffLaneCreate?: (layerId: string, t1: number, t2: number) => void;
  onRiffLayerEdit?: (layerId: string, edit: RiffLayerEdit, opts?: { coalesceKey?: string }) => void;
  onRiffNodeCreated?: (nodeId: string) => void;
  onRiffEditorDone?: () => void;
  onRiffEditorDiscard?: () => void;
  onRiffEditOnLane?: (layerId: string, itemId: string) => void;
  onSpanClick?: (layerId: string, itemId: string, anchor: { x: number; y: number }) => void;
  /** Drag a span band's edge to retime it. */
  onSpanEdgeDrag?: (layerId: string, itemId: string, edge: 'start' | 'end', newTime: number) => void;
  onSpanEdgeDragStart?: (layerId: string, itemId: string, edge: 'start' | 'end') => void;
  /** Drag the body of a span band to move it without changing its width. */
  onSpanMove?: (layerId: string, itemId: string, newStart: number, newEnd: number) => void;
  onSpanMoveStart?: (layerId: string, itemId: string) => void;
  /** Items dragged out of one lane and dropped on another of the same type
   *  (Cues, Spans, Loops, Lyrics), as they were when the drag began — copied,
   *  or moved when `move`. `joinsDrag` says a time drag ran in the same
   *  gesture. Absent turns cross-lane dragging (and item selection) off. */
  onItemLaneMove?: (
    fromLayerId: string,
    toLayerId: string,
    items: { id: string }[],
    opts: { move: boolean; joinsDrag: boolean },
  ) => void;
  /** Delete / Backspace while items are ⇧/⌘-picked in a lane: delete them all
   *  at once. Absent leaves the key to the page's own Delete shortcut. */
  onDeleteItems?: (layerId: string, itemIds: string[]) => void;
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
  /** Riff-pattern layers. Each layer
   *  renders its placed instances tiled `repeatCount` times, with proportional
   *  sequence blocks inside each cycle. */
  riffPatternLayers?: AnnotationLayer<'riff-patterns'>[];
  /** Riff-pattern instance currently focused in the editor panel. */
  focusedRiffPattern?: { layerId: string; itemId: string } | null;
  /** Fired when the user clicks the tile background (not a specific block). */
  onRiffPatternItemClick?: (layerId: string, itemId: string, anchor: { x: number; y: number }) => void;
  /** Fired when the user clicks a specific sequence block. */
  onRiffPatternEntryClick?: (layerId: string, itemId: string, entryIndex: number, nodeId: string | null, anchor: { x: number; y: number }) => void;
  /** A step of a riff node toggled from the groove card, for every bar that
   *  plays the node. */
  onRiffNodeStepToggle?: (layerId: string, nodeId: string, step: number) => void;
  /** A step toggled on one bar of a riff lane alone, recorded as that play's
   *  occurrence (riffGrooves.ts `toggleBarStep`). */
  onRiffBarStepSplit?: (layerId: string, ref: RiffCellRef, step: number) => void;
  /** Drag the body of a riff pattern's first cycle to slide the whole
   *  instance (and all its repeats) without changing the cycle length. */
  /** A riff run dragged: every instance in it, each at its new start/end. */
  onRiffPatternItemMove?: (layerId: string, moves: RiffItemMove[]) => void;
  onRiffPatternItemMoveStart?: (layerId: string, itemId: string) => void;
  /** User-created + detector-sourced Lyrics layers. Each renders word/line ticks with text. */
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
  playerUrl, trackName, songOverviewAlways = false,
  audioBuffer, duration,
  bpm, timeSignature, beatOffset, beatsPerBar = 4,
  showBeatGrid, beatGridUnit, beatOverrides, gridSegments, showGridSegmentLane, gridVisualizable = false, selectedSegmentId, cutLabelSegmentId, onSegmentSelect, onSegmentHeadDrag, onDeleteGridSegment, onSplitGridAt, snapSegmentTime, segmentSnapOn, gridMode, onBeatDrag, onClearBeatOverride, manualEditLocked,
  snapToGrid = false,
  snapTimeOverride,
  snapProminenceTime,
  boundaryLayers, autoGuessPoints, pendingSelection,
  showManual, showAutoGuess,
  showProminence = true,
  showWaveform, showEQ = false, showSpectrogram, showCepstrogram, showChroma, showTempogram, showSsm,
  mirCurves, mirComputing = false, showEnergy, showBrightness, showNovelty, showOnsets, showFlux, showVolume = false, showDensity = false,
  showBusyness = false, showBandwidth = false,
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
  onCopyDetectorLayer, onCopyDetectorGroup, onDeleteDetectorLane, onDeleteAlgoOverlay, onDeleteUserLayer, userLaneOps, extractingAdsrIds, onDeleteAutoGuess, onHideProminence, detectorLayerCopyCounts,
  onCopyAlgoOverlay, algoCopyCounts,
  mergeLanes, mergeBoundaries,
  onMergeAddLane, onMergeRemoveLane, onMergeSetLanesHidden, onMergeClear,
  onMergeToggleBoundary, onMergeEditBoundary, mergeSelectedTime, onMergeRestoreDropped, onMergeCommit,
  mergeCommittedCount = 0,
  mergeCommittedNote = null,
  mergeSmart = false, onMergeSetSmart,
  consensusBlocks, consensusRefMisses, consensusReferenceLabel, consensusTolerance,
  onHideConsensus, onCopyConsensus, consensusCopyCount = 0,
  seekRef, playRef, pauseRef, getTimeRef, externalTimeRef, wsScrollRef, zoomInRef, zoomOutRef, zoomResetRef, getZoomFocusTime, onLeadRangeChange, pinchZoomInRef, pinchZoomOutRef, scrollToTimeRef, zoomToRangeRef,
  onBufferReady, onReady, onTimeUpdate, onPlayingChange, playbackRate, onScrollChange, onViewChange,
  vizScrollContainerRef, vizSignalWidth, vizZoomFactor = 1, onVizScroll,
  playerIsPlaying, onSeekAndPlay, onPause,
  previewRegion, onPreviewRegionChange, onPreviewPlay, onPreviewPause, onPreviewDismiss, onPreviewEnd, onPreviewLoopToggle, previewIsPlaying,
  rowOrder, onReorderRow, onSetSignalShown,
  layerGroups, rowGroupId, groupState,
  onGroupToggleCollapsed, onGroupRename, onGroupUngroup, onGroupDelete,
  readOnlyGroupIds,
  onCreateGroupFromLayer, onMoveLayerToGroup, groupableRowIds, onDropRowInGroup,
  sectionColorOverrides, onSectionColorChange, onResetSectionColors,
  boundaryColoringMode, onBoundaryColoringModeChange,
  onResetRowOrder, hasCustomRowOrder,
  layerAudioConfig, onLayerAudioChange,
  playerAccent,
  hidePlaybackIcon,
  playerTransportAbove = false,
  playerTransportTrailing,
  hideTimeDisplay = false,
  onGridOffsetChange,
  onGridOffsetDragStart,
  showBarNumbers = false,
  numberEveryGridLine = false,
  gridLineThickness = 1,
  stemSource, availableStemSources, onStemSourceChange, kitParts, kitPart, onKitPartChange, onRunStems,
  stemModel, onStemModelChange, runStemsModel, runStemsStatus,
  runStemsProgressPct, runStemsElapsedSec, runStemsLastLine, runStemsCancelMode,
  onCancelStems, onKillStems, runStemsErrorTail, onDismissStemsError,
  cueLayers, focusedCue, onCueClick, onCueDrag, onCueDragStart, onCueDecayDrag, onCueDecayDragStart, onCueDecayKey,
  loopLayers, focusedLoop, playingLoopId, onLoopClick, onLoopEdgeDrag, onLoopEdgeDragStart, onLoopMove, onLoopMoveStart,
  onLaneCreate, laneCreateSnap,
  riffEditor, onRiffLaneCreate, onRiffLayerEdit, onRiffNodeCreated, onRiffEditorDone, onRiffEditorDiscard, onRiffEditOnLane,
  spanLayers, focusedSpan, onSpanClick, onSpanEdgeDrag, onSpanEdgeDragStart, onSpanMove, onSpanMoveStart,
  onItemLaneMove,
  onDeleteItems,
  onSpanProminenceChange, spanProminenceEdit,
  onLoopProminenceChange, loopProminenceEdit,
  onRiffPatternProminenceChange, riffPatternProminenceEdit,
  riffPatternLayers, focusedRiffPattern, onRiffPatternItemClick, onRiffPatternEntryClick,
  onRiffNodeStepToggle, onRiffBarStepSplit,
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
  // Items picked with ⇧/⌘-click for a cross-lane drag. One lane at a time:
  // a pick in another lane starts over there. Esc clears it, and so does a drop.
  // Delete / Backspace deletes every picked item; it is heard on `document`,
  // before the page's own Delete (on `window`) would take just the nearest cue.
  // ⇧+Delete is left alone: it clears the focused cue's decay.
  const [itemSelection, setItemSelection] = useState<{ layerId: string; ids: string[] } | null>(null);
  useEffect(() => {
    if (!itemSelection) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === 'Escape') { setItemSelection(null); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && onDeleteItems
        && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        onDeleteItems(itemSelection.layerId, itemSelection.ids);
        setItemSelection(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [itemSelection, onDeleteItems]);
  const [draggedRowId, setDraggedRowId] = useState<VizRowId | null>(null);
  const [dropTargetRowId, setDropTargetRowId] = useState<VizRowId | null>(null);

  // ── Label column width (resizable gutter) ─────────────────────────────────
  // Width applied to every sticky row label via the `--viz-label-w` CSS var
  // set on the panel root. Starts as the sideways strip; once dragged, the
  // width is remembered across reloads (see `labelColWKey`). Capped at
  // 240px — enough for long renamed layer names without wrapping the
  // spectrogram column too tightly.
  const [labelColW, setLabelColW] = useState<number>(() => readLabelColW(getIsMobile()));
  // The Merge row was deleted (or, empty, hidden) from its ⋮. It stays away
  // while the merge is empty; a lane joining it brings the row back.
  const [mergeRowRemoved, setMergeRowRemoved] = useState(false);
  const mergeHasLanes = (mergeLanes?.length ?? 0) > 0;
  if (mergeHasLanes && mergeRowRemoved) setMergeRowRemoved(false);
  const labelColWRef = useRef(labelColW);
  useEffect(() => {
    labelColWRef.current = labelColW;
    try { localStorage.setItem(labelColWKey(getIsMobile()), String(labelColW)); } catch { /* quota */ }
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
    // The sheet carries the signal's explanation on the phone; the label's own
    // desktop info card would open underneath it.
    if (rowId && SIGNAL_INFO[rowId]) e.stopPropagation();
  }, []);
  const shownSignalIds = useMemo(() => new Set(Object.entries({
    waveform: showWaveform, eq: showEQ, spectrogram: showSpectrogram, cepstrogram: showCepstrogram,
    chroma: showChroma, tempogram: showTempogram, ssm: showSsm, energy: showEnergy,
    brightness: showBrightness, novelty: showNovelty, onsets: showOnsets, flux: showFlux, volume: showVolume,
    density: showDensity, busyness: showBusyness, bandwidth: showBandwidth,
  }).filter(([, on]) => on).map(([id]) => id)), [showWaveform, showEQ, showSpectrogram, showCepstrogram,
    showChroma, showTempogram, showSsm, showEnergy, showBrightness, showNovelty, showOnsets, showFlux, showVolume,
    showDensity, showBusyness, showBandwidth]);
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
  // ── Visualize with playback — per-lane opt-in, keyed by row id, picked
  // from the timeline's Visualize button and remembered per song ──────────
  const visualLanes = useVisualizedLanes(trackName ?? playerUrl ?? '');
  const visualRowIds = visualLanes.active;
  const toggleVisualRow = visualLanes.toggle;
  // The rows that can play along are the ones wearing a pick cover — only
  // rendered while picking, which is the only time All / Done ask.
  const pickableRowIds = useCallback((): string[] => {
    const root = panelRootRef.current;
    if (!root) return [];
    return [...root.querySelectorAll<HTMLElement>(`[${PICKABLE_ATTR}]`)]
      .map((el) => el.closest<HTMLElement>('[data-viz-row]')?.dataset.vizRow ?? '')
      .filter(Boolean)
      .concat(gridVisualizable ? [GRID_VIZ_ID] : []);
  }, [gridVisualizable]);
  const gridVisualized = gridVisualizable && visualRowIds.has(GRID_VIZ_ID);
  // The grid pick is kept on pages without a grid to play (picks are per song,
  // shared by every page), and left out of the count there.
  const visualCount = visualLanes.picked.size - (!gridVisualizable && visualLanes.picked.has(GRID_VIZ_ID) ? 1 : 0);
  // On Data Prep, the first Visualize starts with the grid already in: it is
  // what that page is for.
  const startVisualPicking = useCallback(() => {
    if (gridVisualizable && visualLanes.picked.size === 0) visualLanes.setIds([GRID_VIZ_ID]);
    visualLanes.startPicking();
  }, [gridVisualizable, visualLanes]);
  // Done forgets picks whose lane is gone (deleted, or a detector no longer
  // run), so the count on the button is the lanes you can actually see.
  const finishPicking = useCallback(() => {
    const present = new Set(pickableRowIds());
    if (present.size > 0) visualLanes.setIds([...visualLanes.picked].filter((id) => present.has(id) || id === GRID_VIZ_ID));
    visualLanes.stopPicking();
  }, [pickableRowIds, visualLanes]);

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

  // The pinned ruler sits right under the song header, whose height changes as
  // it swaps between full and slim. The ruler measures the header and writes
  // its own `top`. The header used to publish its height as a CSS variable on
  // its parent instead, but that parent holds every lane: changing an
  // inherited variable there restyled all of them (17k elements on the demo
  // song, ~70 ms), and the swap happens each time the player scrolls past the
  // header. No song header (a page without one) → pinned under the app header.
  //
  // A callback ref, not a mount effect: the `top` belongs to the node, so it
  // is written whenever a ruler node attaches. A one-shot effect wrote it
  // once, and a ruler that came back as a new node (a remount, a hot reload)
  // had no `top` at all — and `sticky` without one scrolls away like any row.
  //
  // The header box itself no longer changes height on the swap: its full and
  // slim headers share one cell and trade places by `data-off` alone. So the
  // ruler hugs whichever one is showing — heights come from the
  // ResizeObserver, the swap from a MutationObserver on `data-off`, and placing
  // reads no layout, so the swap costs one sticky `top`.
  //
  // `sticky` measures from the nearest scrolling ancestor, and the app header
  // only covers the page's own scroller. A panel inside a scrolling pane of
  // its own (the Playground's song pane) pins at that pane's top edge — with
  // the header's height added it stuck 72 px down, mid-lanes.
  const rulerPinRef = useCallback((pin: HTMLDivElement | null) => {
    if (!pin) return;
    let inPane = false;
    for (let p = pin.parentElement; p && p !== document.body; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if (oy !== 'visible' && oy !== 'clip') { inPane = true; break; }
    }
    const base = inPane ? '0px' : 'var(--tc-header-h, 0px)';
    let header: HTMLElement | null = null;
    for (let p = pin.parentElement; p && !header; p = p.parentElement) {
      header = p.querySelector<HTMLElement>(':scope > [data-songbar]');
    }
    if (!header) {
      pin.style.top = base;
      return;
    }
    const songbar = header;
    const parts = Array.from(songbar.querySelectorAll<HTMLElement>(':scope > [data-swap]'));
    const heights = new Map<Element, number>();
    const place = () => {
      const shown = parts.find((el) => !el.hasAttribute('data-off')) ?? songbar;
      const h = heights.get(shown) ?? shown.offsetHeight;
      pin.style.top = `calc(${base} + ${h}px)`;
    };
    place();
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) heights.set(e.target, e.borderBoxSize?.[0]?.blockSize ?? (e.target as HTMLElement).offsetHeight);
      place();
    });
    ro.observe(songbar);
    for (const el of parts) ro.observe(el);
    const mo = new MutationObserver(place);
    for (const el of parts) mo.observe(el, { attributes: true, attributeFilter: ['data-off'] });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, []);

  // The pinned time ruler's scroller mirrors the rows' scrollLeft, both ways.
  // Equal values fire no scroll event, so the pair settles after one hop.
  // Both scrollers round to the same device pixel, so they can match exactly:
  // a 1 px tolerance here let the ruler lag the rows and catch up in 1-2 px
  // jumps every few frames during a zoomed-in follow-scroll.
  const rulerScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const viz = vizScrollContainerRef.current;
    const ruler = rulerScrollRef.current;
    if (!viz || !ruler) return;
    const fromViz = () => { if (Math.abs(ruler.scrollLeft - viz.scrollLeft) > 0.01) ruler.scrollLeft = viz.scrollLeft; };
    const fromRuler = () => { if (Math.abs(viz.scrollLeft - ruler.scrollLeft) > 0.01) viz.scrollLeft = ruler.scrollLeft; };
    fromViz();
    viz.addEventListener('scroll', fromViz, { passive: true });
    ruler.addEventListener('scroll', fromRuler, { passive: true });
    // A zoom resizes both contents; re-align once the widths have landed.
    const ro = new ResizeObserver(fromViz);
    if (viz.firstElementChild) ro.observe(viz.firstElementChild);
    if (ruler.firstElementChild) ro.observe(ruler.firstElementChild);
    return () => {
      viz.removeEventListener('scroll', fromViz);
      ruler.removeEventListener('scroll', fromRuler);
      ro.disconnect();
    };
  }, [vizScrollContainerRef]);

  // Intercept trackpad horizontal wheel deltas on the viz scroll container and
  // its pinned ruler so the browser's swipe-back/forward gesture doesn't fire
  // when scrubbing. React's onWheel synthetic event is always passive, so we
  // need a native listener with { passive: false } to make preventDefault()
  // take effect. Skips ctrl-modified events — those are pinch-zoom /
  // Ctrl+wheel and are handled by the zoom listener below.
  //
  // This listener, not `overscroll-behavior-x: none`, is what keeps the swipe
  // from navigating. The CSS did that too, but Chrome latches a diagonal wheel
  // to a box with that rule and drops its vertical part, so a vertical swipe
  // over the lanes with a pixel of sideways drift scrolled nothing at all.
  useEffect(() => {
    const viz = vizScrollContainerRef.current;
    if (!viz) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return;
      if (!isHorizontalWheel(e)) return;
      e.preventDefault();
      // The ruler follows the rows' scrollLeft (see the sync above).
      viz.scrollLeft += e.deltaX;
    };
    const ruler = rulerScrollRef.current;
    viz.addEventListener('wheel', onWheel, { passive: false });
    ruler?.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      viz.removeEventListener('wheel', onWheel);
      ruler?.removeEventListener('wheel', onWheel);
    };
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
      if (!isHorizontalWheel(e)) return;
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
  // dropped on a band is a plain reorder around it (`reorderRow`), not a
  // membership write that would go nowhere.
  const groupDropFor = useCallback((rowId: VizRowId): GroupDrop | null => {
    if (!draggedRowId || !onDropRowInGroup) return null;
    if (!groupableRowIds?.has(draggedRowId)) return null;
    const drop = resolveGroupDrop(rowId, rowGroupId);
    if (drop.groupId && readOnlyGroupIds?.has(drop.groupId)) return null;
    // Dropping on the header is always a band move — "put it at the top" is
    // worth honouring even for a lane already in that band. Every other row
    // only counts when the band on the far side of the drop differs.
    if (drop.beforeRowId == null) return drop;
    return drop.groupId === (rowGroupId?.[draggedRowId] ?? null) ? null : drop;
  }, [draggedRowId, onDropRowInGroup, groupableRowIds, rowGroupId, readOnlyGroupIds]);

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

  // The grid a span's pulse ticks are measured against: the song's own tempo,
  // whether or not the grid overlay is switched on. Hiding the grid lines is a
  // display choice; it must not also erase every pulse a detector reported.
  const pulseGrid = useMemo(() => (
    bpm && bpm > 0
      ? { bpm, gridOffset: beatOffset ?? 0, beatsPerBar, beatOverrides, segments: gridSegments }
      : undefined
  ), [bpm, beatOffset, beatsPerBar, beatOverrides, gridSegments]);

  // One tiling per boundary layer. Boundaries carry no stored end, so each
  // item's block runs to the next item's start (and the last to the track's
  // end) — the tiling that makes a boundary layer a reading of the structure
  // rather than a scatter of points.
  const boundaryBlocksByLayer = useMemo(() => {
    const out = new Map<string, { time: number; endTime: number; label: string; type: string; importance?: 'critical' | 'optional'; ownColor?: string }[]>();
    for (const l of boundaryLayers ?? []) {
      const items = [...l.items].sort((a, b) => a.time - b.time);
      out.set(l.id, items.map((s, i) => ({
        time: s.time,
        endTime: items[i + 1]?.time ?? duration,
        label: s.label,
        type: s.type,
        importance: s.importance,
        ownColor: s.color,
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
  // The last item of an annotation lane's ⋮ menu: a detector's lane deletes
  // what the detector saved (the page says how, or that it cannot), a layer
  // of yours deletes the layer.
  const laneRemoveFor = (layer: AnnotationLayer): LaneRemove | undefined => {
    if (layer.readOnly) return onDeleteDetectorLane?.(layer);
    return onDeleteUserLayer ? { kind: 'delete', scope: 'layer', run: () => onDeleteUserLayer(layer) } : undefined;
  };
  // The ⋮ items only a lane of yours has. "Copy region" is offered while a
  // region is highlighted and some of the lane's items sound inside it.
  const selLo = pendingSelection && pendingSelection.t2 !== null ? Math.min(pendingSelection.t1, pendingSelection.t2) : null;
  const selHi = pendingSelection && pendingSelection.t2 !== null ? Math.max(pendingSelection.t1, pendingSelection.t2) : null;
  const userLaneFor = (layer: AnnotationLayer): UserLaneActions | undefined => {
    if (layer.readOnly || !userLaneOps) return undefined;
    const kinds = splitKinds(layer);
    const lo = selLo ?? 0;
    const hi = selHi ?? 0;
    const inRegion = hi > lo ? itemsInRegion(layer, lo, hi).length : 0;
    return {
      locked: !!layer.locked,
      toggleLock: () => userLaneOps.setLocked(layer, !layer.locked),
      duplicate: () => userLaneOps.duplicate(layer),
      region: inRegion > 0
        ? { label: regionLabel(lo, hi), count: inRegion, copy: () => userLaneOps.copyRegion(layer, lo, hi) }
        : null,
      split: kinds.length > 0 ? { kinds, run: () => userLaneOps.split(layer) } : null,
      mergeTargets: userLaneOps.mergeTargets(layer),
      mergeInto: (targetId) => userLaneOps.merge(layer, targetId),
      snap: !isSnappableLane(layer)
        ? null
        : userLaneOps.snap
        ? { count: (unit) => userLaneOps.snap!.count(layer, unit), run: (unit) => userLaneOps.snap!.run(layer, unit) }
        : { count: () => 0, run: () => {}, why: 'This song has no BPM yet, so there is no grid to snap to. Set it in the Song Info bar.' },
      extractAdsr: isEnvelopeLayer(layer) && envelopeTargets(layer).length > 0
        ? {
            run: (source) => userLaneOps.extractAdsr(layer, source),
            sources: userLaneOps.adsrSources,
            measured: (layer.items as { envelope?: unknown }[]).some((it) => it.envelope),
            running: !!extractingAdsrIds?.has(layer.id),
          }
        : null,
    };
  };
  // Cross-lane drag: a writable Cues / Spans / Loops / Lyrics lane both offers
  // its items (laneDrop) and accepts others' (the data-drop-* attributes on its
  // track wrapper, which useCrossLaneDrop finds under the pointer).
  const laneDropFor = (layer: AnnotationLayer): CrossLaneDropOptions | undefined => {
    if (layer.readOnly || !onItemLaneMove || !CROSS_LANE_ITEM_TYPES.has(layer.type)) return undefined;
    const items = layer.items as readonly ({ id: string; time?: number; start?: number })[];
    const selected = itemSelection?.layerId === layer.id
      ? itemSelection.ids.filter((id) => items.some((it) => it.id === id))
      : [];
    return {
      layerId: layer.id,
      type: layer.type,
      noun: CROSS_LANE_NOUNS[layer.type] ?? ['item', 'items'],
      selectedIds: new Set(selected),
      onToggleSelect: (itemId) => setItemSelection((cur) => {
        const ids = cur?.layerId === layer.id ? cur.ids : [];
        const next = ids.includes(itemId) ? ids.filter((id) => id !== itemId) : [...ids, itemId];
        return next.length ? { layerId: layer.id, ids: next } : null;
      }),
      // Adds to what this lane already has picked, so several stretches and
      // clicks can build one group.
      onSelectRange: (t1, t2) => {
        const [a, b] = [Math.min(t1, t2), Math.max(t1, t2)];
        const inside = items.filter((it) => itemStartTime(it) >= a && itemStartTime(it) <= b).map((it) => it.id);
        if (!inside.length) return;
        setItemSelection((cur) => {
          const ids = cur?.layerId === layer.id ? cur.ids : [];
          return { layerId: layer.id, ids: [...ids, ...inside.filter((id) => !ids.includes(id))] };
        });
      },
      groupFor: (itemId) => (selected.includes(itemId) ? selected : null),
      snapshot: (ids) => items.filter((it) => ids.includes(it.id)),
      reject: (to, carried) => {
        const target = loopLayers?.find((l) => l.id === to);
        return layer.type === 'loops' && target
          && loopsWouldOverlap(target.items, carried as readonly LoopItem[])
          ? `Would overlap a loop in ${target.name}: loops in a lane can't overlap`
          : null;
      },
      onDrop: (carried, to, opts) => {
        setItemSelection(null);
        onItemLaneMove(layer.id, to, carried, opts);
      },
    };
  };
  const laneDropAttrs = (layer: AnnotationLayer) =>
    laneDropFor(layer)
      ? { 'data-drop-lane': layer.id, 'data-drop-type': layer.type, 'data-drop-name': layer.name }
      : undefined;
  const hideSignal = useMemo(
    () => (onSetSignalShown ? (rid: string) => onSetSignalShown(rid as VizRowId, false) : null),
    [onSetSignalShown],
  );
  const groupMenuForRow = useCallback((rid: VizRowId, layer: AnnotationLayer) => {
    // Detector lanes are re-derived each render and never persisted, so a
    // groupId on one would vanish on reload. No menu rather than a dead one.
    if (layer.readOnly || !onCreateGroupFromLayer || !onMoveLayerToGroup) return undefined;
    return {
      groups: (layerGroups ?? []).filter((g) => !readOnlyGroupIds?.has(g.id)),
      currentGroupId: rowGroupId?.[rid],
      onNewGroup: () => onCreateGroupFromLayer(rid),
      onMoveTo: (groupId: string | null) => onMoveLayerToGroup(rid, groupId),
    };
  }, [layerGroups, rowGroupId, onCreateGroupFromLayer, onMoveLayerToGroup, readOnlyGroupIds]);
  // Membership as the canvas draws it: a band of one lane is drawn as that
  // lane alone — no strip, no chevron, nothing to fold — since collapsing it
  // would only trade the lane for a copy of itself. The band comes into view
  // once it has a second lane. Drops still read the real membership.
  const bandGroupId = useMemo(() => {
    if (!rowGroupId) return rowGroupId;
    const count = new Map<string, number>();
    for (const rid of rowOrder ?? DEFAULT_FIXED_ROW_ORDER) {
      const gid = rowGroupId[rid];
      if (gid) count.set(gid, (count.get(gid) ?? 0) + 1);
    }
    const out: Record<string, string> = {};
    for (const [rid, gid] of Object.entries(rowGroupId)) if ((count.get(gid) ?? 0) >= 2) out[rid] = gid;
    return out;
  }, [rowGroupId, rowOrder]);
  // A band's strip sits over the left GROUP_INDENT_PX of its lanes' label
  // cells, and those lanes pad their names past it. So while any band is
  // drawn, the gutter grows by the strip's width: the lane names keep the
  // room the user gave them instead of being squeezed (or hidden, at the
  // sideways width) under the group's title.
  const hasBands = !!bandGroupId && Object.keys(bandGroupId).length > 0;
  const gutterW = mobileStrip ? 12 : labelColW + (hasBands ? GROUP_INDENT_PX : 0);
  const groupColorForRow = useCallback((rid: VizRowId): string | undefined => {
    const gid = bandGroupId?.[rid];
    return gid ? layerGroups?.find((g) => g.id === gid)?.color : undefined;
  }, [bandGroupId, layerGroups]);
  // A collapsed band still shows what its lanes found: each member's marks,
  // flattened to ticks and stretches, in the band's own row order.
  const groupOverlays = useMemo(() => {
    const out = new Map<string, GroupOverlayLane[]>();
    if (!rowGroupId || collapsedGroupIds.size === 0) return out;
    const byRow = new Map<string, AnnotationLayer>();
    const index = (prefix: string, layers: AnnotationLayer[] | undefined) => {
      for (const l of layers ?? []) byRow.set(`${prefix}${l.id}`, l);
    };
    index('cue-layer:', cueLayers);
    index('loop-layer:', loopLayers);
    index('span-layer:', spanLayers);
    index('boundary-layer:', boundaryLayers);
    index('lyrics-layer:', lyricsLayers);
    index('riff-layer:', riffPatternLayers);
    for (const rid of rowOrder ?? DEFAULT_FIXED_ROW_ORDER) {
      const gid = rowGroupId[rid];
      if (!gid || !collapsedGroupIds.has(gid)) continue;
      const layer = byRow.get(rid);
      if (!layer || !layer.visible) continue;
      const points: GroupOverlayLane['points'] = [];
      const spans: GroupOverlayLane['spans'] = [];
      for (const item of layer.items as Array<{ time?: number; start?: number; end?: number; color?: string }>) {
        const color = item.color;
        if (typeof item.start === 'number' && typeof item.end === 'number') spans.push({ a: item.start, b: item.end, color });
        else if (typeof item.time === 'number' && typeof item.end === 'number' && item.end > item.time) spans.push({ a: item.time, b: item.end, color });
        else if (typeof item.time === 'number') points.push({ t: item.time, color });
      }
      const lane: GroupOverlayLane = { id: layer.id, name: layer.name, color: layer.color, points, spans };
      const bucket = out.get(gid);
      if (bucket) bucket.push(lane);
      else out.set(gid, [lane]);
    }
    return out;
  }, [rowOrder, rowGroupId, collapsedGroupIds, cueLayers, loopLayers, spanLayers, boundaryLayers, lyricsLayers, riffPatternLayers]);
  const groupedRowOrder = useMemo(
    () => buildGroupedRowOrder(rowOrder ?? DEFAULT_FIXED_ROW_ORDER, bandGroupId, collapsedGroupIds),
    [rowOrder, bandGroupId, collapsedGroupIds],
  );

  const makeRowDropHandlers = useCallback((rowId: VizRowId) => {
    // `data-viz-row` rides on every row (it is spread with the drop handlers):
    // the phone's row sheet reads it off the tapped label to know which row
    // it is changing, and walks them for the on-screen order.
    if (!onReorderRow) return { 'data-viz-row': rowId };
    return {
      'data-viz-row': rowId,
      onDragOver: (e: React.DragEvent) => {
        if (!draggedRowId || draggedRowId === rowId) return;
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
        // Dragged down → lands below the target, dragged up → above it, so
        // the row ends up where it was let go. Always "above" parked a
        // downward drag one row short: onto the next row, that is no move.
        const from = groupedRowOrder.indexOf(draggedRowId);
        const to = groupedRowOrder.indexOf(rowId);
        const place: ReorderPlace = from >= 0 && to >= 0 && from < to ? 'after' : 'before';
        const drop = groupDropFor(rowId);
        if (drop) onDropRowInGroup!(draggedRowId, drop.groupId, drop.beforeRowId, place);
        else onReorderRow(draggedRowId, rowId, place);
        setDraggedRowId(null);
      },
    };
  }, [onReorderRow, onDropRowInGroup, groupDropFor, draggedRowId, dropTargetRowId, groupedRowOrder]);
  // An open band takes no row: its members are drawn in one grid, and the
  // band's chevron and name ride down their gutter as a sticky strip spanning
  // all of them. Only a collapsed band — or an empty one, kept so lanes can be
  // dropped into it — falls back to the header row. A band whose lanes are all
  // hidden draws nothing at all: an empty "2 lanes" header with no way in is
  // noise, and the sidebar is where hidden lanes are turned back on.
  const bandRows = (order: VizRowId[], render: (rowId: VizRowId, asStrip: boolean) => React.ReactNode) => {
    const out: React.ReactNode[] = [];
    for (let i = 0; i < order.length; i++) {
      const rowId = order[i];
      if (!rowId.startsWith(GROUP_ROW_PREFIX)) { out.push(render(rowId, false)); continue; }
      const gid = rowId.slice(GROUP_ROW_PREFIX.length);
      let j = i + 1;
      while (j < order.length && bandGroupId?.[order[j]] === gid) j++;
      // A collapsed band has no member rows in `order` at all (see
      // buildGroupedRowOrder); an open one has them, drawn or not.
      const collapsed = j === i + 1;
      const members = order.slice(i + 1, j)
        .map((id) => [id, render(id, false)] as const)
        .filter(([, el]) => el != null && el !== false);
      i = j - 1;
      if (members.length === 0) {
        const state = groupState?.[gid];
        const allHidden = (state?.count ?? 0) > 0 && (state?.visibility === 'none' || !collapsed);
        if (!allHidden) out.push(render(rowId, false));
        continue;
      }
      out.push(
        <div key={rowId} className="grid gap-1" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
          <div
            // Above its lanes' z-30 label cells, below the z-40 ruler, page
            // header and slim transport — at z-40 it ties them and, coming
            // later in the DOM, paints over them as the page scrolls.
            className="sticky left-0 z-[35] self-stretch justify-self-start"
            style={{ gridRow: `1 / span ${members.length}`, gridColumn: 1 }}
          >
            {render(rowId, true)}
          </div>
          {members.map(([id, el], k) => (
            <div key={id} className="min-w-0" style={{ gridRow: k + 1, gridColumn: 1 }}>{el}</div>
          ))}
        </div>,
      );
    }
    return out;
  };

  // ── Full-song overview strip (SongOverviewStrip), only while zoomed in ──
  // It gets its own box below every lane — inside the lanes it read as one
  // more lane, and between the player and the timeline it split the two. Sections come from the selected boundary layer,
  // else the first visible one.
  const overviewSections = useMemo<OverviewSection[]>(() => {
    const layers = (boundaryLayers ?? []).filter((l) => l.visible && l.items.length);
    const want = selectedLayerIdByType?.boundaries;
    const layer = layers.find((l) => l.id === want) ?? layers[0];
    if (!layer) return [];
    return (boundaryBlocksByLayer.get(layer.id) ?? []).map((b) => ({
      time: b.time,
      endTime: b.endTime,
      color: b.ownColor ?? sectionColorOverrides?.[b.type] ?? sectionBg(b.type),
    }));
  }, [boundaryLayers, selectedLayerIdByType?.boundaries, boundaryBlocksByLayer, sectionColorOverrides]);
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
  // Whether the open card's section is sounding right now. Derived from the
  // playhead clock, so the panel re-renders only when it flips — on entering
  // or leaving that section — rather than every frame.
  const algoPopoverInside = usePlayheadValue((t) => {
    const open = algoPopover.open;
    if (!open || !playerIsPlaying) return false;
    const section = algoOverlays.find((o) => o.id === open.layerId)?.sections[Number(open.itemId)];
    return !!section && t >= section.time && t < section.endTime;
  });

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

  // Every beat of the song on its own grid (tempo map and pinned beats
  // included), for the two rhythm lanes. Null without a BPM: they fall back
  // to reading per second.
  const songBeatTimes = useMemo<number[] | null>(() => {
    if (!pulseGrid || !(duration > 0)) return null;
    const { bpm: b, gridOffset, beatOverrides: ov, segments } = pulseGrid;
    const out: number[] = [];
    const last = beatIndexAt(duration, b, gridOffset, segments) + 1;
    for (let i = beatIndexAt(0, b, gridOffset, segments); i <= last; i++) {
      const t = beatTimeAt(i, b, gridOffset, ov, segments);
      if (t >= 0 && t <= duration) out.push(t);
    }
    return out.length >= 2 ? out : null;
  }, [pulseGrid, duration]);

  // Beat strength (the row keeps its old id, 'energy') and Onset density.
  const beatStrength = useMemo(() => {
    if (!mirCurves?.bassHits || !curveFrameAxis) return EMPTY_CURVE;
    return Array.from(beatStrengthCurve(mirCurves.bassHits, curveFrameAxis, songBeatTimes));
  }, [mirCurves?.bassHits, curveFrameAxis, songBeatTimes]);
  const onsetDensity = useMemo(() => {
    if (!showDensity || !mirCurves?.onsets || !curveFrameAxis) return EMPTY_CURVE;
    return Array.from(onsetDensityCurve(mirCurves.onsets, curveFrameAxis, songBeatTimes));
  }, [showDensity, mirCurves?.onsets, curveFrameAxis, songBeatTimes]);
  const busyness = useMemo(() => {
    if (!showBusyness || !mirCurves?.bandLevels || !mirCurves.nBusyBands || !curveFrameAxis) return EMPTY_CURVE;
    return Array.from(busynessCurve(mirCurves.bandLevels, mirCurves.nBusyBands, curveFrameAxis, songBeatTimes));
  }, [showBusyness, mirCurves?.bandLevels, mirCurves?.nBusyBands, curveFrameAxis, songBeatTimes]);
  const bandwidthCurve = mirCurves?.bandwidth ?? EMPTY_CURVE;

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

  useBoundaryAudioFeedback(audioLayers, playerIsPlaying, playbackRate ?? 1);

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
  // A click or drag on a lane item (a lyric, a cue, a span) must not leave its
  // button focused: Chrome then draws its blue focus ring on the next key —
  // Esc included — and nothing on the page can clear it, so a word you only
  // dragged looks selected. Safari never focuses a clicked button, so this
  // just makes Chrome agree. Menu buttons keep their focus.
  const keepClickedButtonsUnfocused = useCallback((e: React.MouseEvent) => {
    const t = e.target as Element | null;
    if (t?.closest?.('button:not([aria-haspopup]):not([aria-expanded])')) e.preventDefault();
  }, []);

  return (
    <RowTitlesVerticalContext.Provider value={verticalRowTitles}>
    <VisualizePickContext.Provider value={visualLanes.picking}>
    <GutterStripContext.Provider value={mobileStrip}>
    <HideSignalContext.Provider value={hideSignal}>
    <div
      ref={panelRootRef}
      className={`bg-gray-900 rounded-xl overflow-clip${mobileStrip ? ' tc-gutter-strip' : ''}`}
      onPointerDownCapture={blurTypingTargetOnPointerDown}
      onMouseDownCapture={keepClickedButtonsUnfocused}
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
              kitParts={kitParts}
              kitPart={kitPart}
              onKitPartChange={onKitPartChange}
            />
          )}
          <PlayerPanel
            url={playerUrl}
            transportAbove={playerTransportAbove}
            transportTrailing={playerTransportTrailing}
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
            numberEveryLine={numberEveryGridLine}
            beatOverrides={beatOverrides}
            gridSegments={gridSegments}
            showGridSegmentLane={showGridSegmentLane}
            visualizeGrid={gridVisualized}
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
        const showDisplayOptions = showLayerAudioBlock || showSectionColorBlock;
        return (
          <div className="relative z-30">
            <div className="flex items-stretch gap-2 pr-2 pt-2.5 pb-2">
              <div className="w-[var(--viz-label-w,3.5rem)] shrink-0" />
              <div className="flex-1 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <VisualizeModeBar
                  on={visualLanes.on}
                  picking={visualLanes.picking}
                  count={visualCount}
                  onStart={startVisualPicking}
                  onDone={finishPicking}
                  onAll={() => visualLanes.setIds(pickableRowIds())}
                  onNone={() => visualLanes.setIds([])}
                  onOff={visualLanes.turnOff}
                  grid={gridVisualizable ? { on: visualLanes.picked.has(GRID_VIZ_ID), onToggle: () => toggleVisualRow(GRID_VIZ_ID) } : undefined}
                />
                {showDisplayOptions && (
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
                )}
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

      {/* ── Time ruler, pinned under the song header while the rows scroll
           past. It can't live inside the rows' scroller: that box scrolls on x,
           so it is also the box a `sticky top` would stick to, and it never
           scrolls on y. So the ruler gets a twin scroller with the same width
           and padding, its scrollLeft kept equal to the rows' (both ways —
           panning over the ruler pans the rows). The panel root is
           overflow-clip, not -hidden, for the same reason. ── */}
      <div ref={rulerPinRef} className="sticky top-[var(--tc-header-h)] z-40 bg-gray-900">
        <div
          ref={rulerScrollRef}
          className="overflow-x-auto overflow-y-hidden pr-2"
          style={{ scrollbarWidth: 'none' }}
        >
          <div
            className="flex"
            style={{ minWidth: vizSignalWidth > 0 ? `${vizSignalWidth + gutterW + 8}px` : undefined }}
          >
            <div className="w-[calc(var(--viz-label-w,3.5rem)_+_0.5rem)] shrink-0 sticky left-0 z-30 bg-gray-900" />
            <div className="flex-1 min-w-0 overflow-hidden relative">
              <TimeRuler duration={duration} height={16} />
              <PlayheadLine duration={duration} style={{ background: 'rgba(255,255,255,0.75)' }} />
            </div>
          </div>
        </div>
      </div>

      {/* ── Scrollable viz rows (same horizontal alignment via pr-2 — no
           left padding, so the sticky label gutter sits flush at the panel's
           left edge; player/time-display rows above drop their left padding
           the same way to stay aligned) ── */}
      <div
        ref={vizScrollContainerRef}
        className="overflow-x-auto overflow-y-hidden pr-2 pb-2"
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
          {bandRows(groupedRowOrder, (rowId, asStrip) => {
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
                  <div key="waveform" className={rowClass} data-lane-row {...dropProps}>
                    <RowLabel text="3-Band" signalId="waveform" color="text-blue-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
                        <div className="flex-1 min-w-0 overflow-hidden">
                      <div ref={waveformBoxRef} className="relative">
                        <FrequencyWaveform
                          height={rowH('waveform', 70)}
                          audioBuffer={audioBuffer}
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
                  <div key="eq" className={rowClass} data-lane-row {...dropProps}>
                    <RowLabel text="EQ" signalId="eq" color="text-blue-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
                    <div className="flex-1 min-w-0 relative overflow-hidden">
                      <EQVisualizer
                        height={rowH('eq', 54)}
                        mirCurves={mirCurves}
                        loading={mirComputing}
                        duration={duration}
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
                  <div key="lead" className={rowClass} data-lane-row {...dropProps}>
                    <RowLabel
                      text="Prominence" color="text-emerald-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart}
                      onRemoveLane={onHideProminence ? { kind: 'hide', from: 'Annotations ▾ → Prominence lane', run: onHideProminence } : undefined}
                    />
                    <LeadLaneRow
                      candidates={leadCandidates}
                      duration={duration}
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
                      <RowLabel
                        text="Auto-guess" color="text-violet-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart}
                        onRemoveLane={onDeleteAutoGuess && autoGuessBlockSections.length > 0
                          ? { kind: 'delete', scope: 'auto-guess', run: onDeleteAutoGuess } : undefined}
                      />
                      <div className="flex-1 min-w-0 overflow-hidden flex items-stretch">
                        {autoGuessBlockSections.length > 0
                          ? <SectionBlockRow
                              sections={autoGuessBlockSections}
                              duration={duration}
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
                // Deleted from its ⋮: gone until a lane joins again (⊕ Add to
                // merge on a boundary lane's ⋮ brings it back).
                if (lanes.length === 0 && mergeRowRemoved) return null;
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
                        dragHandlers={dragHandlers}
                        onResizeStart={handleLabelColResizeStart}
                        gridProps={gridProps}
                        isDropTarget={draggedIsMergeable && dropTargetRowId === 'merge'}
                        onToggleBoundary={onMergeToggleBoundary}
                        onEditBoundary={onMergeEditBoundary}
                        selectedTime={mergeSelectedTime}
                        visualize={visualRowIds.has('merge')}
                        onVisualizeToggle={() => toggleVisualRow('merge')}
                        onRemoveLane={lanes.length > 0
                          ? { kind: 'delete', scope: 'merge', run: () => { onMergeClear?.(); setMergeRowRemoved(true); } }
                          : { kind: 'hide', from: "any boundary lane's ⋮ → ⊕ Add to merge", run: () => setMergeRowRemoved(true) }}
                      />
                    </div>
                    {lanes.length > 0 && (
                      <div className="flex items-stretch">
                        {/* Opaque sticky gutter cell so the control strip slides
                            behind the labels on a horizontal scroll. It grabs
                            the Merge row like the label above it does — the
                            whole gutter of a row is its handle. */}
                        <div
                          className={`w-[calc(var(--viz-label-w,3.5rem)_+_0.5rem)] shrink-0 sticky left-0 z-30 bg-gray-900 ${dragHandlers ? 'cursor-grab active:cursor-grabbing' : ''}`}
                          draggable={dragHandlers?.draggable}
                          onDragStart={dragHandlers?.onDragStart}
                          onDragEnd={dragHandlers?.onDragEnd}
                          title={dragHandlers ? 'Merge — drag to reorder' : undefined}
                        />
                        <div className="flex-1 min-w-0">
                          <MergeControlsBar
                            lanes={lanes}
                            onRemoveLane={onMergeRemoveLane ?? (() => {})}
                            onSetLanesHidden={onMergeSetLanesHidden}
                            onClear={onMergeClear ?? (() => {})}
                            onCommit={onMergeCommit ?? (() => {})}
                            onRestoreDropped={onMergeRestoreDropped ?? (() => {})}
                            keptCount={keptCount}
                            totalCount={merged.length}
                            droppedCount={merged.length - keptCount}
                            committedCount={mergeCommittedCount}
                            committedNote={mergeCommittedNote}
                            smart={mergeSmart}
                            onSetSmart={onMergeSetSmart}
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
                  <div key="consensus" className={rowClass} data-lane-row {...dropProps}>
                    <ConsensusLaneRow
                      blocks={consensusBlocks}
                      refMisses={consensusRefMisses}
                      duration={duration}
                      referenceLabel={consensusReferenceLabel}
                      tolerance={consensusTolerance}
                      dragHandlers={dragHandlers}
                      onResizeStart={handleLabelColResizeStart}
                      gridProps={gridProps}
                      onSeek={onVizClick}
                      onHide={onHideConsensus}
                      onCopy={onCopyConsensus}
                      existingCopyCount={consensusCopyCount}
                      visualize={visualRowIds.has('consensus')}
                      onVisualizeToggle={() => toggleVisualRow('consensus')}
                    />
                  </div>
                );
              }

              case 'spectrogram':
                if (!showSpectrogram || !audioBuffer) return null;
                return (
                  <div key="spectrogram" className={rowClass} data-lane-row {...dropProps}>
                    <RowLabel text="Spectro" signalId="spectrogram" color="text-violet-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
                    <div className="flex-1 min-w-0 overflow-hidden">
                      <TimeRuler duration={duration} height={16} />
                      <div className="relative">
                        <SpectrogramAnnotated
                          audioBuffer={audioBuffer}
                          sections={[]}
                          duration={duration}
                          height={rowH('spectrogram', 80)}
                          bpm={beatGrid.bpm}
                          beatOffset={beatOffset}
                          beatsPerBar={beatGrid.beatsPerBar}
                          barGroupSize={effectiveBeatGrid.barGroupSize} beatGroupSize={effectiveBeatGrid.beatGroupSize} gridThickness={gridLineThickness}
                          subBeatDivision={effectiveBeatGrid.subBeatDivision}
                        />
                        <SpectrogramDragOverlay
                          duration={duration}
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
                  <div key="cepstrogram" className={rowClass} data-lane-row {...dropProps}>
                    <RowLabel text="MFCC" signalId="cepstrogram" color="text-violet-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
                    <div className="flex-1 min-w-0 relative overflow-hidden">
                      <CepstrogramAnnotated
                        hopSize={mirCurves.hopSize}
                        fftSize={mirCurves.fftSize}
                        sampleRate={mirCurves.sampleRate}
                        mfcc={mirCurves.mfcc}
                        nMfcc={mirCurves.nMfcc}
                        frameCount={mirCurves.frameCount}
                        duration={duration}
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
                  <div key="chroma" className={rowClass} data-lane-row {...dropProps}>
                    <RowLabel text="Chroma" signalId="chroma" color="text-lime-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
                    <div className="flex-1 min-w-0 relative overflow-hidden">
                      <ChromagramAnnotated
                        hopSize={mirCurves.hopSize}
                        fftSize={mirCurves.fftSize}
                        sampleRate={mirCurves.sampleRate}
                        chroma={mirCurves.chroma}
                        nChroma={mirCurves.nChroma}
                        frameCount={mirCurves.frameCount}
                        duration={duration}
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
                  <div key="tempogram" className={rowClass} data-lane-row {...dropProps}>
                    <RowLabel text="Tempo" signalId="tempogram" color="text-fuchsia-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
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
                  <div key="ssm" className={rowClass} data-lane-row {...dropProps}>
                    <RowLabel text="SSM" signalId="ssm" color="text-orange-400/70" dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} />
                    <div className="flex-1 min-w-0 relative overflow-hidden">
                      <SsmAnnotated
                        hopSize={mirCurves.hopSize}
                        fftSize={mirCurves.fftSize}
                        sampleRate={mirCurves.sampleRate}
                        ssm={mirCurves.ssm}
                        ssmFrameCount={mirCurves.ssmFrameCount}
                        duration={duration}
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

              // Loudness alone — raw RMS. The Energy row below it is a composite
              // (35% onset strength), so it spikes on every attack; this one
              // shows how loud the music is and for how long.
              case 'volume':
                if (!showVolume) return null;
                return <div key="volume" className={rowClass} data-lane-row {...dropProps}><Sparkline signalId="volume" visualize={visualRowIds.has('volume')} onVisualizeToggle={() => toggleVisualRow('volume')} overlay={<SignalMarksOverlay {...marksFor('volume')} duration={duration} />} label="Volume" data={mirCurves?.rms ?? EMPTY_CURVE} loading={mirComputing} color="#f1f5f9" height={rowH('volume', 36)} duration={duration} onSeek={onVizClick} onRegion={onVizRegion} onRegionDragStart={onRegionDragStart} dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} pendingSelection={pendingSelection} dragCursorTime={segmentHeadDragTime} gridProps={gridProps} frameAxis={curveFrameAxis} /></div>;

              case 'energy':
                if (!showEnergy) return null;
                return <div key="energy" className={rowClass} data-lane-row {...dropProps}><Sparkline signalId="energy" visualize={visualRowIds.has('energy')} onVisualizeToggle={() => toggleVisualRow('energy')} overlay={<SignalMarksOverlay {...marksFor('energy')} duration={duration} />} label="Beat" signalName="Beat strength" data={beatStrength} loading={mirComputing} color="#f59e0b" height={rowH('energy', 40)} duration={duration} onSeek={onVizClick} onRegion={onVizRegion} onRegionDragStart={onRegionDragStart} dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} pendingSelection={pendingSelection} dragCursorTime={segmentHeadDragTime} gridProps={gridProps} frameAxis={curveFrameAxis} /></div>;

              case 'brightness':
                if (!showBrightness) return null;
                return <div key="brightness" className={rowClass} data-lane-row {...dropProps}><Sparkline signalId="brightness" visualize={visualRowIds.has('brightness')} onVisualizeToggle={() => toggleVisualRow('brightness')} overlay={<SignalMarksOverlay {...marksFor('brightness')} duration={duration} />} label="Bright" signalName="Brightness" data={mirCurves?.spectral ?? EMPTY_CURVE} loading={mirComputing} color="#22d3ee" height={rowH('brightness', 36)} duration={duration} onSeek={onVizClick} onRegion={onVizRegion} onRegionDragStart={onRegionDragStart} dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} pendingSelection={pendingSelection} dragCursorTime={segmentHeadDragTime} gridProps={gridProps} frameAxis={curveFrameAxis} /></div>;

              case 'novelty':
                if (!showNovelty) return null;
                return <div key="novelty" className={rowClass} data-lane-row {...dropProps}><Sparkline signalId="novelty" visualize={visualRowIds.has('novelty')} onVisualizeToggle={() => toggleVisualRow('novelty')} overlay={<SignalMarksOverlay {...marksFor('novelty')} duration={duration} />} label="Novelty" data={mirCurves?.novelty ?? EMPTY_CURVE} loading={mirComputing} color="#a78bfa" height={rowH('novelty', 36)} duration={duration} onSeek={onVizClick} onRegion={onVizRegion} onRegionDragStart={onRegionDragStart} dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} pendingSelection={pendingSelection} dragCursorTime={segmentHeadDragTime} gridProps={gridProps} frameAxis={curveFrameAxis} /></div>;

              case 'onsets':
                if (!showOnsets) return null;
                return <div key="onsets" className={rowClass} data-lane-row {...dropProps}><Sparkline signalId="onsets" visualize={visualRowIds.has('onsets')} onVisualizeToggle={() => toggleVisualRow('onsets')} overlay={<SignalMarksOverlay {...marksFor('onsets')} duration={duration} />} label="Onsets" data={mirCurves?.onsets ?? EMPTY_CURVE} loading={mirComputing} color="#f472b6" height={rowH('onsets', 32)} duration={duration} onSeek={onVizClick} onRegion={onVizRegion} onRegionDragStart={onRegionDragStart} dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} pendingSelection={pendingSelection} dragCursorTime={segmentHeadDragTime} gridProps={gridProps} frameAxis={curveFrameAxis} /></div>;

              case 'density':
                if (!showDensity) return null;
                return <div key="density" className={rowClass} data-lane-row {...dropProps}><Sparkline signalId="density" visualize={visualRowIds.has('density')} onVisualizeToggle={() => toggleVisualRow('density')} overlay={<SignalMarksOverlay {...marksFor('density')} duration={duration} />} label="Density" signalName="Onset density" data={onsetDensity} loading={mirComputing} color="#f87171" height={rowH('density', 32)} duration={duration} onSeek={onVizClick} onRegion={onVizRegion} onRegionDragStart={onRegionDragStart} dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} pendingSelection={pendingSelection} dragCursorTime={segmentHeadDragTime} gridProps={gridProps} frameAxis={curveFrameAxis} /></div>;

              case 'busyness':
                if (!showBusyness) return null;
                return <div key="busyness" className={rowClass} data-lane-row {...dropProps}><Sparkline signalId="busyness" visualize={visualRowIds.has('busyness')} onVisualizeToggle={() => toggleVisualRow('busyness')} overlay={<SignalMarksOverlay {...marksFor('busyness')} duration={duration} />} label="Busy" signalName="Busyness" data={busyness} loading={mirComputing} color="#fde047" height={rowH('busyness', 32)} duration={duration} onSeek={onVizClick} onRegion={onVizRegion} onRegionDragStart={onRegionDragStart} dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} pendingSelection={pendingSelection} dragCursorTime={segmentHeadDragTime} gridProps={gridProps} frameAxis={curveFrameAxis} /></div>;

              case 'bandwidth':
                if (!showBandwidth) return null;
                return <div key="bandwidth" className={rowClass} data-lane-row {...dropProps}><Sparkline signalId="bandwidth" visualize={visualRowIds.has('bandwidth')} onVisualizeToggle={() => toggleVisualRow('bandwidth')} overlay={<SignalMarksOverlay {...marksFor('bandwidth')} duration={duration} />} label="Width" signalName="Bandwidth" data={bandwidthCurve} loading={mirComputing} color="#60a5fa" height={rowH('bandwidth', 32)} duration={duration} onSeek={onVizClick} onRegion={onVizRegion} onRegionDragStart={onRegionDragStart} dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} pendingSelection={pendingSelection} dragCursorTime={segmentHeadDragTime} gridProps={gridProps} frameAxis={curveFrameAxis} /></div>;

              case 'flux':
                if (!showFlux) return null;
                return <div key="flux" className={rowClass} data-lane-row {...dropProps}><Sparkline signalId="flux" visualize={visualRowIds.has('flux')} onVisualizeToggle={() => toggleVisualRow('flux')} overlay={<SignalMarksOverlay {...marksFor('flux')} duration={duration} />} label="Flux" signalName="Spectral Flux" data={mirCurves?.flux ?? EMPTY_CURVE} loading={mirComputing} color="#10b981" height={rowH('flux', 32)} duration={duration} onSeek={onVizClick} onRegion={onVizRegion} onRegionDragStart={onRegionDragStart} dragHandlers={dragHandlers} onResizeStart={handleLabelColResizeStart} pendingSelection={pendingSelection} dragCursorTime={segmentHeadDragTime} gridProps={gridProps} frameAxis={curveFrameAxis} /></div>;

              default: {
                // A group's header band. Emitted by buildGroupedRowOrder, never
                // present in the stored row order.
                if (rowId.startsWith(GROUP_ROW_PREFIX)) {
                  const groupId = rowId.slice(GROUP_ROW_PREFIX.length);
                  const group = layerGroups?.find((g) => g.id === groupId);
                  if (!group) return null;
                  const state = groupState?.[groupId];
                  const editable = !readOnlyGroupIds?.has(groupId);
                  // A detector band copies the lanes it shows (a hidden lane
                  // has no row in it), top to bottom as drawn.
                  const copyRows = !editable && onCopyDetectorGroup && rowGroupId
                    ? Object.keys(rowGroupId).filter((r) => rowGroupId[r] === groupId)
                    : [];
                  if (copyRows.length > 1) {
                    const order = rowOrder ?? DEFAULT_FIXED_ROW_ORDER;
                    const rank = new Map(order.map((r, i) => [r, i] as const));
                    copyRows.sort((a, b) => (rank.get(a) ?? order.length) - (rank.get(b) ?? order.length));
                  }
                  const copyProps = copyRows.length > 0 ? {
                    onCopy: () => onCopyDetectorGroup!(group.name, copyRows),
                    existingCopyCount: copyRows.reduce(
                      (n, r) => n + (detectorLayerCopyCounts?.[r.slice(r.indexOf(':') + 1)] ?? 0), 0),
                  } : {};
                  if (asStrip) {
                    return (
                      <div key={rowId} className="h-full" data-lane-row {...dropProps}>
                        <GroupHeaderRow
                          asStrip
                          group={group}
                          memberCount={state?.count ?? 0}
                          onToggleCollapsed={() => onGroupToggleCollapsed?.(groupId)}
                          onRename={editable && onGroupRename ? (name) => onGroupRename(groupId, name) : undefined}
                          onUngroup={editable && onGroupUngroup ? () => onGroupUngroup(groupId) : undefined}
                          onDelete={editable && onGroupDelete ? () => onGroupDelete(groupId) : undefined}
                          dragHandlers={dragHandlers}
                          isDropTarget={isDropTarget}
                          {...copyProps}
                        />
                      </div>
                    );
                  }
                  return (
                    <div key={rowId} className={rowClass} data-lane-row {...dropProps}>
                      <GroupHeaderRow
                        group={group}
                        memberCount={state?.count ?? 0}
                        onToggleCollapsed={() => onGroupToggleCollapsed?.(groupId)}
                        onRename={editable && onGroupRename ? (name) => onGroupRename(groupId, name) : undefined}
                        onUngroup={editable && onGroupUngroup ? () => onGroupUngroup(groupId) : undefined}
                        onDelete={editable && onGroupDelete ? () => onGroupDelete(groupId) : undefined}
                        dragHandlers={dragHandlers}
                        onResizeStart={handleLabelColResizeStart}
                        isDropTarget={isDropTarget}
                        overlay={groupOverlays.get(groupId)}
                        duration={duration}
                        {...copyProps}
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
                    <div key={rowId} className={rowClass} data-lane-row {...dropProps}>
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
                        visualize={visualRowIds.has(rowId)}
                        onVisualizeToggle={() => toggleVisualRow(rowId)}
                        onCopyToManual={layer.readOnly && onCopyDetectorLayer ? () => onCopyDetectorLayer(layer) : undefined}
                        existingCopyCount={layer.readOnly ? (detectorLayerCopyCounts?.[layer.id] ?? 0) : 0}
                        userLane={userLaneFor(layer)}
                        onRemoveLane={laneRemoveFor(layer)}
                      />
                      <div
                        className={`flex-1 min-w-0 flex items-stretch ${isSelected ? 'rounded-sm' : ''}`}
                        style={isSelected ? { boxShadow: `0 0 0 1px ${layer.color}aa, 0 0 14px ${layer.color}55`, clipPath: 'inset(-16px -16px -16px 0)' } : undefined}
                      >
                        <RiffGrooveLaneRow
                          layer={layer}
                          visualize={visualRowIds.has(rowId)}
                          duration={duration}
                          focusedItemId={focusedRiffPattern?.layerId === layer.id ? focusedRiffPattern.itemId : null}
                          prominenceEditItemId={riffPatternProminenceEdit?.layerId === layer.id ? riffPatternProminenceEdit.itemId : null}
                          onProminenceChange={onRiffPatternProminenceChange
                            ? (itemId, points) => onRiffPatternProminenceChange(layer.id, itemId, points)
                            : undefined}
                          snapProminenceTime={snapProminenceTime}
                          onItemClick={(itemId, anchor) => onRiffPatternItemClick?.(layer.id, itemId, anchor)}
                          onEntryClick={(itemId, entryIndex, nodeId, anchor) => onRiffPatternEntryClick?.(layer.id, itemId, entryIndex, nodeId, anchor)}
                          onNodeStepToggle={onRiffNodeStepToggle ? (nodeId, step) => onRiffNodeStepToggle(layer.id, nodeId, step) : undefined}
                          onBarStepSplit={onRiffBarStepSplit ? (ref, step) => onRiffBarStepSplit(layer.id, ref, step) : undefined}
                          onItemsMove={onRiffPatternItemMove
                            ? (moves) => onRiffPatternItemMove(layer.id, moves)
                            : undefined}
                          onItemMoveStart={onRiffPatternItemMoveStart
                            ? (itemId) => onRiffPatternItemMoveStart(layer.id, itemId)
                            : undefined}
                          gridProps={gridProps}
                          pendingSelection={pendingSelection}
                          onSeek={onVizClick}
                          onRegion={onVizRegion}
                          onRegionDragStart={onRegionDragStart}
                          onPlay={handlePlay}
                          onStop={handlePause}
                          isPlaying={playerIsPlaying}
                          onCreate={onRiffLaneCreate ? (t1, t2) => onRiffLaneCreate(layer.id, t1, t2) : undefined}
                          createSnap={laneCreateSnap?.('riff-patterns')}
                          editor={riffEditor?.layerId === layer.id ? riffEditor : null}
                          onLayerEdit={onRiffLayerEdit ? (edit, opts) => onRiffLayerEdit(layer.id, edit, opts) : undefined}
                          onNodeCreated={onRiffNodeCreated}
                          onEditorDone={onRiffEditorDone}
                          onEditorDiscard={onRiffEditorDiscard}
                          onEditOnLane={onRiffEditOnLane ? (itemId) => onRiffEditOnLane(layer.id, itemId) : undefined}
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
                    <div key={rowId} className={rowClass} data-lane-row {...dropProps}>
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
                        userLane={userLaneFor(layer)}
                        onRemoveLane={laneRemoveFor(layer)}
                        existingCopyCount={layer.readOnly ? (detectorLayerCopyCounts?.[layer.id] ?? 0) : 0}
                        visualize={visualRowIds.has(rowId)}
                        onVisualizeToggle={() => toggleVisualRow(rowId)}
                      />
                      <div
                        className={`flex-1 min-w-0 flex items-stretch ${isSelected ? 'rounded-sm' : ''}`}
                        style={isSelected ? { boxShadow: `0 0 0 1px ${layer.color}aa, 0 0 14px ${layer.color}55`, clipPath: 'inset(-16px -16px -16px 0)' } : undefined}
                        data-boundary-layer={layer.id}
                      >
                        <SectionBlockRow
                          visualize={visualRowIds.has(rowId)}
                          sections={blocks}
                          duration={duration}
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
                      className={rowClass} data-lane-row
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
                        userLane={userLaneFor(layer)}
                        onRemoveLane={laneRemoveFor(layer)}
                        existingCopyCount={layer.readOnly ? (detectorLayerCopyCounts?.[layer.id] ?? 0) : 0}
                        dragHandlers={dragHandlers}
                        onResizeStart={handleLabelColResizeStart}
                        visualize={visualRowIds.has(rowId)}
                        onVisualizeToggle={() => toggleVisualRow(rowId)}
                      />
                      <div
                        {...laneDropAttrs(layer)}
                        className={`flex-1 min-w-0 flex items-stretch ${LANE_DROP_TARGET_CLASS} ${isSelected ? 'rounded-sm' : ''}`}
                        style={isSelected ? { boxShadow: `0 0 0 1px ${layer.color}aa, 0 0 14px ${layer.color}55`, clipPath: 'inset(-16px -16px -16px 0)' } : undefined}
                      >
                      <SpanLaneRow
                        laneDrop={laneDropFor(layer)}
                        onCreate={onLaneCreate && !layer.readOnly ? (t1, t2) => onLaneCreate(layer.id, t1, t2) : undefined}
                        createSnap={laneCreateSnap?.('spans')}
                        onSeek={onVizClick}
                        onRegion={onVizRegion}
                        onRegionDragStart={onRegionDragStart}
                        items={layer.items}
                        color={layer.color}
                        duration={duration}
                        visualize={visualRowIds.has(rowId)}
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
                        pulseGrid={pulseGrid}
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
                      className={rowClass} data-lane-row
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
                        userLane={userLaneFor(layer)}
                        onRemoveLane={laneRemoveFor(layer)}
                        existingCopyCount={layer.readOnly ? (detectorLayerCopyCounts?.[layer.id] ?? 0) : 0}
                        visualize={visualRowIds.has(rowId)}
                        onVisualizeToggle={() => toggleVisualRow(rowId)}
                      />
                      <div
                        {...laneDropAttrs(layer)}
                        className={`flex-1 min-w-0 flex items-stretch ${LANE_DROP_TARGET_CLASS} ${isSelected ? 'rounded-sm' : ''}`}
                        style={isSelected ? { boxShadow: `0 0 0 1px ${layer.color}aa, 0 0 14px ${layer.color}55`, clipPath: 'inset(-16px -16px -16px 0)' } : undefined}
                      >
                      <LoopLayerRow
                        laneDrop={laneDropFor(layer)}
                        onCreate={onLaneCreate && !layer.readOnly ? (t1, t2) => onLaneCreate(layer.id, t1, t2) : undefined}
                        createSnap={laneCreateSnap?.('loops')}
                        onSeek={onVizClick}
                        onRegion={onVizRegion}
                        onRegionDragStart={onRegionDragStart}
                        items={layer.items}
                        color={layer.color}
                        duration={duration}
                        visualize={visualRowIds.has(rowId)}
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
                      className={rowClass} data-lane-row
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
                        userLane={userLaneFor(layer)}
                        onRemoveLane={laneRemoveFor(layer)}
                        existingCopyCount={layer.readOnly ? (detectorLayerCopyCounts?.[layer.id] ?? 0) : 0}
                        visualize={visualRowIds.has(rowId)}
                        onVisualizeToggle={() => toggleVisualRow(rowId)}
                      />
                      <div
                        {...laneDropAttrs(layer)}
                        className={`flex-1 min-w-0 flex items-stretch ${LANE_DROP_TARGET_CLASS} ${isSelected ? 'rounded-sm' : ''}`}
                        style={isSelected ? { boxShadow: `0 0 0 1px ${layer.color}aa, 0 0 14px ${layer.color}55`, clipPath: 'inset(-16px -16px -16px 0)' } : undefined}
                      >
                        <CueLayerRow
                          laneDrop={laneDropFor(layer)}
                          onCreate={onLaneCreate && !layer.readOnly ? (t) => onLaneCreate(layer.id, t, null) : undefined}
                          onSeek={onVizClick}
                          onRegion={onVizRegion}
                          onRegionDragStart={onRegionDragStart}
                          items={layer.items}
                          color={layer.color}
                          duration={duration}
                          visualize={visualRowIds.has(rowId)}
                          focusedItemId={focusedCue?.layerId === layer.id ? focusedCue.itemId : null}
                          onCueClick={(itemId, anchor) => onCueClick?.(layer.id, itemId, anchor)}
                          onCueDrag={onCueDrag
                            ? (itemId, time) => onCueDrag(layer.id, itemId, time)
                            : undefined}
                          onCueDragStart={onCueDragStart
                            ? (itemId) => onCueDragStart(layer.id, itemId)
                            : undefined}
                          onCueDecayDrag={onCueDecayDrag && !layer.readOnly
                            ? (itemId, decay) => onCueDecayDrag(layer.id, itemId, decay)
                            : undefined}
                          onCueDecayDragStart={onCueDecayDragStart
                            ? (itemId) => onCueDecayDragStart(layer.id, itemId)
                            : undefined}
                          onCueDecayKey={onCueDecayKey && !layer.readOnly
                            ? (itemId, decay, repeat) => onCueDecayKey(layer.id, itemId, decay, repeat)
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
                    <div key={rowId} className={rowClass} data-lane-row {...dropProps}>
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
                        userLane={userLaneFor(layer)}
                        onRemoveLane={laneRemoveFor(layer)}
                        existingCopyCount={layer.readOnly ? (detectorLayerCopyCounts?.[layer.id] ?? 0) : 0}
                        visualize={visualRowIds.has(rowId)}
                        onVisualizeToggle={() => toggleVisualRow(rowId)}
                      />
                      <div {...laneDropAttrs(layer)} className={`flex-1 min-w-0 flex items-stretch ${LANE_DROP_TARGET_CLASS}`}>
                        <LyricsLayerRow
                          heightKey={`tc:lyrics-lane-h:${layer.id}`}
                          laneDrop={laneDropFor(layer)}
                          onCreate={onLaneCreate && !layer.readOnly ? (t1, t2) => onLaneCreate(layer.id, t1, t2) : undefined}
                          createSnap={laneCreateSnap?.('lyrics')}
                          onSeek={onVizClick}
                          onRegion={onVizRegion}
                          onRegionDragStart={onRegionDragStart}
                          items={layer.items}
                          color={layer.color}
                          duration={duration}
                          visualize={visualRowIds.has(rowId)}
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
                    <div key={rowId} data-lane-row {...dropProps} className={`${isDragging ? 'opacity-40' : ''} ${isDropTarget ? 'bg-amber-900/20 ring-1 ring-amber-700/40 rounded' : ''}`}>
                      <div className="flex items-stretch">
                        <RowLabel
                          text={cfg.label}
                          onRemoveLane={onDeleteDetectorLane?.({ id: rowId })}
                          colorStyle={{ color: cfg.color }}
                          dragHandlers={dragHandlers}
                          onResizeStart={handleLabelColResizeStart}
                        />
                        {blocks.length > 0
                          ? <SectionBlockRow
                              sections={blocks}
                              duration={duration}
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
                  <div key={rowId} className={rowClass} data-lane-row {...dropProps}>
                    <AlgoTimelineRow
                      label={overlay.label}
                      labelColor={overlay.labelColor}
                      renderKind={overlay.renderKind}
                      sections={overlay.sections}
                      info={overlay.info}
                      infoId={overlay.id}
                      gridSource={overlay.gridSource}
                      duration={duration}
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
                      onRemoveLane={onDeleteAlgoOverlay?.(overlay.id)}
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
                      visualize={visualRowIds.has(rowId)}
                      onVisualizeToggle={() => toggleVisualRow(rowId)}
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

      {/* ── Full-song overview, below every lane and pinned to the window's
           bottom edge so it is always in reach (always on in Annotate, else
           only while zoomed in). ── */}
      {(songOverviewAlways || vizZoomFactor > 1) && !isMobile && (
        <div className="sticky bottom-0 z-40 flex items-stretch gap-2 pr-2 py-2 bg-gray-900 border-t border-gray-800">
          <div className="w-[var(--viz-label-w,3.5rem)] shrink-0" />
          <div className="flex-1 min-w-0">
            <SongOverviewStrip
              audioBuffer={audioBuffer}
              duration={duration}
              sections={overviewSections}
              scrollerRef={vizScrollContainerRef}
              contentWidth={vizSignalWidth}
              gutterWidth={gutterW}
              onSeek={onVizClick}
            />
          </div>
        </div>
      )}

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
            onChange={() => {}}
            onClose={algoPopover.close}
            onPlay={() => handlePlay(section.time, section.endTime)}
            onStop={handlePause}
            isPlaying={algoPopoverInside}
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
    </HideSignalContext.Provider>
    </GutterStripContext.Provider>
    </VisualizePickContext.Provider>
    </RowTitlesVerticalContext.Provider>
  );
}
