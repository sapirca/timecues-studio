import { Fragment, useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { BEAT_GRID_UNIT_OPTIONS, type BeatGridUnit } from './SharedVizPanel';
import { beatGridUnitLabel } from '../../utils/beatTimeFormat';
import { useBarBeatOrigin } from '../../context/SettingsContext';
import type { BarBeatOrigin } from '../../utils/beatGrid';
import { MODE_LABEL } from './shared/gridModeLabels';
import { getIsMobile } from '../../mobile/mobileMode';
import { groupByDetectorOrigin } from '../../utils/detectorOrigin';

// The slim sticky transport reuses this whole bar at a fixed small size with
// no labels; that is just another value of the density attribute the bar puts
// on itself (`compact`), so nothing needs to be threaded through the tree.

/** Density tiers for the full (non-compact) bar, roomiest first.
 *
 *  Every size that differs between tiers is a CSS custom property keyed off
 *  `data-viz-bar-density` on the bar (see `.tc-viz-bar` in index.css), so
 *  trying a tier costs one attribute write. That's what lets `settleBar`
 *  below walk the whole ladder synchronously inside a layout effect: the user
 *  sees the tier that fits, not the bar shrinking its way down to it. */
type BarDensity = 'roomy' | 'snug' | 'cozy' | 'tight' | 'dense' | 'micro';
const DENSITY_ORDER: BarDensity[] = ['roomy', 'snug', 'cozy', 'tight', 'dense', 'micro'];

export interface AlgoOverlayOption {
  id: string;
  label: string;
  /** Set when this row is ticked but the stem filter is keeping it off the
   *  canvas — the stem the filter is pinned to. A ticked checkbox that draws
   *  nothing is the one state the picker has to explain in place. */
  hiddenByStemFilter?: string;
}

export interface CustomAnnotationOption {
  id: string;     // detector name
  label: string;  // human-facing detector label
  color: string;  // row's distinct strip color
  /** Shipped detector (custom-default/) — listed under "Default". */
  isDefault?: boolean;
}

export interface CueLayerOption {
  id: string;     // layer uuid
  label: string;  // user-given layer name
  color: string;  // layer color
  visible: boolean;
  count: number;  // number of cues in the layer (rendered as a badge)
  /** Detector rows only: shipped (custom-default/) — listed under "Default". */
  isDefault?: boolean;
}

/** Shared shape for user-created layer toggles (Loops, Spans). Identical to
 *  CueLayerOption — kept as a separate type for documentation clarity. */
export interface InteriorLayerOption {
  id: string;
  label: string;
  color: string;
  visible: boolean;
  count: number;
  /** Detector rows only: shipped (custom-default/) — listed under "Default". */
  isDefault?: boolean;
}

export interface VizControlBarProps {
  /** Slim variant for the sticky scroll header: drops the column labels and
   *  the text chips (mode/BPM badge, warnings, Detected pills), shrinks the
   *  buttons, and lays everything out on a single borderless inline row so it
   *  fits next to the slim transport. Defaults to the full bar. */
  compact?: boolean;
  /** Hide the entire Annotations dropdown (e.g. data-prep, where the curator
   *  shouldn't be distracted by annotation layers). Defaults to shown. */
  showAnnotations?: boolean;
  // Annotation toggles
  showManual: boolean;      onToggleManual: (v: boolean) => void;
  /** False in Algorithm Inspect: boundary layers live in the annotator's own
   *  folder like every other kind, so they are the Annotator Tool's to show.
   *  Auto-guess stays either way — it is a proposal, not an annotation. */
  showBoundariesGroup?: boolean;
  showAutoGuess: boolean; onToggleAutoGuess: (v: boolean) => void;
  /** The Prominence lane — one derived row across every layer, so it toggles
   *  on its own rather than sitting in a layer list. Omit the callback to hide
   *  the control (surfaces that don't render the lane). */
  showProminence?: boolean; onToggleProminence?: (v: boolean) => void;
  /** The Auto-consensus lane — the blend Consensus Inspect is showing. Its
   *  checkbox lives in the ALGOS dropdown, not Annotations: it is an
   *  algorithm result, not something the annotator authored. Omit the callback
   *  (or pass consensusAvailable false) on surfaces with no consensus to
   *  draw. */
  showConsensus?: boolean; onToggleConsensus?: (v: boolean) => void;
  /** Whether Consensus Inspect currently has a consensus at all — the
   *  checkbox is pointless without one. */
  consensusAvailable?: boolean;
  minConsensus?: number;  onMinConsensusChange?: (n: number) => void;
  totalAlgos?: number;
  // Signal toggles
  showWaveform: boolean;    onToggleWaveform: (v: boolean) => void;
  showEQ: boolean;          onToggleEQ: (v: boolean) => void;
  showSpectrogram: boolean; onToggleSpectrogram: (v: boolean) => void;
  showCepstrogram: boolean; onToggleCepstrogram: (v: boolean) => void;
  showChroma: boolean;      onToggleChroma: (v: boolean) => void;
  showTempogram: boolean;   onToggleTempogram: (v: boolean) => void;
  showSsm: boolean;         onToggleSsm: (v: boolean) => void;
  showEnergy: boolean;      onToggleEnergy: (v: boolean) => void;
  showBrightness: boolean;  onToggleBrightness: (v: boolean) => void;
  showNovelty: boolean;     onToggleNovelty: (v: boolean) => void;
  showOnsets: boolean;      onToggleOnsets: (v: boolean) => void;
  showFlux: boolean;        onToggleFlux: (v: boolean) => void;
  // Beat grid
  showBeatGrid: boolean;   onToggleBeatGrid: (v: boolean) => void;
  beatGridUnit: BeatGridUnit; onBeatGridUnitChange: (u: BeatGridUnit) => void;
  beatGridUnitOptions?: BeatGridUnit[];
  /** Active grid mode. When provided, a status badge appears next to the
   *  Beat grid toggle showing the mode + BPM (or anchor count) + time
   *  signature. */
  gridMode?: import('../../types/songInfo').GridMode;
  /** How many grids the song's tempo map divides it into, for the Mapped
   *  badge. 1 (or absent) = one grid, whole song. */
  segmentCount?: number;
  /** Number of pinned beats (per-beat overrides). Shown on a second line of
   *  the status badge in manual mode when > 0. */
  overrideCount?: number;
  /** Resolved track BPM. When missing the grid silently won't render, so the
   *  toggle shows a "(set BPM)" hint to make that visible. */
  bpm?: number;
  /** Numerator of the active time signature. Drives which divisions are
   *  meaningful — `compound-beat` (every 3 beats) is hidden in simple meters. */
  beatsPerBar?: number;
  /** Full time-signature string ("4/4", "6/8", …). Rendered on the second
   *  line of the grid-mode badge so the song's meter is always visible. */
  timeSignature?: string;
  // Snap — only meaningful while annotating (snaps new boundaries / cues /
  // span edges to the beat grid). Hidden in Dataset Prep and Algo Inspect
  // where the user isn't placing annotations.
  snapToGrid: boolean; onToggleSnapToGrid: (v: boolean) => void;
  showSnap?: boolean;
  // GRID LOCK — strict enforcement: snapping is always on (locked), existing
  // annotations are bulk-re-snapped to the grid unit selected above on enable,
  // and annotation cards display beat-relative times. Independent of the
  // grid-visibility toggle above.
  gridLock?: boolean;
  onRequestGridLock?: (enable: boolean) => void;
  showGridLock?: boolean;
  // When on, horizontal trackpad/wheel gestures *anywhere on the page* get
  // redirected to scroll the viz timeline (and the browser swipe-back/forward
  // gesture is suppressed). When off (default), only gestures over the
  // waveform/viz panels are intercepted.
  captureGlobalHScroll: boolean; onToggleCaptureGlobalHScroll: (v: boolean) => void;
  // When on (the page's default), the player's stem and the Algo-Inspect stem
  // filter move together: picking a stem on either picks it on the other. Off
  // lets you hear one stem while reading another's rows. The checkbox only
  // renders when the page passes the setter.
  stemLock?: boolean; onStemLockChange?: (v: boolean) => void;
  // Beat-grid line width multiplier (Misc dropdown slider). 1 = default;
  // scales bar/beat/sub-beat lines uniformly across every viz row.
  gridLineThickness: number; onGridLineThicknessChange: (v: number) => void;
  // When on, the multiplier above rides the player's zoom — thin lines at fit,
  // thicker as you zoom in. `effectiveGridLineThickness` is what the grid is
  // actually drawn with right now, so the dropdown can show it.
  gridThicknessAdaptive?: boolean; onGridThicknessAdaptiveChange?: (v: boolean) => void;
  effectiveGridLineThickness?: number;
  // Zoom — controlled by the WaveSurfer player; the toolbar invokes the
  // callbacks and reflects the current state. `zoomFactor` is the player's
  // multiplier relative to fit (1 = fit, 2 = ×2 …). `atMaxZoom` disables `+`.
  zoomFactor?: number;
  atMaxZoom?: boolean;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
  // Playback speed — slows the whole song (and every currentTime-driven viz:
  // karaoke, beat-grid sweep) by multiplying WaveSurfer's playback rate at the
  // source. `playbackRate` is the current multiplier (1 = normal). When
  // `onPlaybackRateChange` is omitted the Speed control is hidden.
  playbackRate?: number;
  onPlaybackRateChange?: (rate: number) => void;
  // Algorithm overlays
  algoOptions?: AlgoOverlayOption[];
  selectedAlgos?: Set<string>;
  onToggleAlgo?: (id: string) => void;
  showAlgos?: boolean;
  /** The stem the Algo-Inspect stem filter is pinned to, and how many ticked
   *  algo rows it is keeping off the canvas. When the count is non-zero the
   *  Algos badge reads "drawn/ticked" and the popover offers a one-click way
   *  back to every stem — otherwise the only clue is a tick that does nothing.
   *  `onClearStemFilter` resets the filter to "all". */
  algoStemFilter?: string;
  algoStemFilterHiddenCount?: number;
  onClearAlgoStemFilter?: () => void;
  // Single-value detector outputs (global key, detected language, …). These
  // detectors produce one value for the whole track, not a timeline, so they
  // render as always-visible read-only pills instead of overlay toggles.
  singleInfoDetections?: { id: string; label: string; value: string; color?: string }[];
  // Custom detector annotations — appended to the Annotations dropdown so the
  // user can hide individual detector strips from the canvas.
  customAnnotationOptions?: CustomAnnotationOption[];
  hiddenCustomAnnotations?: Set<string>;
  onToggleCustomAnnotation?: (id: string) => void;
  /** Lift the Detectors section out of the Annotations dropdown into a
   *  big-icon column of its own (Algo Inspect, where the detectors ARE the
   *  subject). The Annotations dropdown then covers only human-authored
   *  layers — its badge, All / None and section list all follow. */
  showDetectors?: boolean;
  // User-created Cue layers — each appears as a row on the canvas; this
  // dropdown lets the user toggle each layer's visibility.
  boundaryLayerOptions?: CueLayerOption[];
  onToggleBoundaryLayerVisibility?: (id: string) => void;
  cueLayerOptions?: CueLayerOption[];
  onToggleCueLayerVisibility?: (id: string) => void;
  // User-created Span layers (experimental).
  spanLayerOptions?: InteriorLayerOption[];
  onToggleSpanLayerVisibility?: (id: string) => void;
  // User-created Loop layers (experimental).
  loopLayerOptions?: InteriorLayerOption[];
  onToggleLoopLayerVisibility?: (id: string) => void;
  // User-created Lyrics layers (experimental) — plus detector-sourced
  // curated-lyrics layers, tagged "(detector)" like the other kinds.
  lyricsLayerOptions?: InteriorLayerOption[];
  onToggleLyricsLayerVisibility?: (id: string) => void;
  // User-created Riff Pattern layers (experimental). No detector variant.
  riffPatternLayerOptions?: InteriorLayerOption[];
  onToggleRiffPatternLayerVisibility?: (id: string) => void;
}

interface AllNoneProps {
  /** Give both to grow an All / None pair on the heading; omit both for a
   *  plain heading. A group of one item passes neither — flipping a single
   *  checkbox needs no shortcut. */
  onAll?: () => void;
  onNone?: () => void;
  allTitle?: string;
  noneTitle?: string;
}

/** The All / None pair that flips a whole section at once. One implementation
 *  so the gesture, size and hover state are identical everywhere it appears
 *  (Annotations, its sections, Signals, Algos). */
function AllNone({ onAll, onNone, allTitle, noneTitle }: AllNoneProps) {
  if (!onAll || !onNone) return null;
  const cls = 'px-1 h-4 rounded text-[9px] font-mono leading-none bg-[#0a0b0d] text-slate-400 '
    + 'border border-white/[0.12] hover:text-slate-200 hover:border-white/[0.22] transition-colors cursor-pointer';
  return (
    <div className="flex items-center gap-1 shrink-0">
      <button type="button" onClick={onAll} title={allTitle ?? 'Turn everything in this group on'} className={cls}>
        All
      </button>
      <button type="button" onClick={onNone} title={noneTitle ?? 'Turn everything in this group off'} className={cls}>
        None
      </button>
    </div>
  );
}

/** Group heading inside a popover (Boundaries / Cues / Spans / Signals / …).
 *  Adds a thin divider above every group except the first so the popover
 *  reads as discrete sections rather than one long list, and carries the
 *  section's All / None when it has one. */
function GroupHeader({ children, ...allNone }: { children: React.ReactNode } & AllNoneProps) {
  return (
    <div className="flex items-center justify-between gap-2 pt-2 mt-1 border-t border-white/[0.12] first:pt-0 first:mt-0 first:border-t-0">
      <span className="text-[10px] uppercase tracking-wider text-slate-300 font-semibold">{children}</span>
      <AllNone {...allNone} />
    </div>
  );
}

/** Flip every layer in a list to `visible`. Each toggle is idempotent per id
 *  and routes through a functional state update upstream, so a loop is safe —
 *  but the `visible` flags are props that don't move mid-loop, so no id may be
 *  handed to this twice in one gesture. */
function setLayersVisible(
  opts: { id: string; visible: boolean }[] | undefined,
  onToggle: ((id: string) => void) | undefined,
  visible: boolean,
) {
  if (!opts || !onToggle) return;
  opts.forEach((o) => { if (o.visible !== visible) onToggle(o.id); });
}

/** "Default" / "Custom" title over a detector origin group. Sits between
 *  GroupHeader and SubGroupHeader. */
function OriginHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-[0.16em] text-amber-300/70 font-medium pl-1 pt-1.5">
      {children}
    </div>
  );
}

/** Indented sub-heading (currently used for the "Detectors" subgroup under
 *  Boundaries and Cues). Visually subordinate to GroupHeader. */
function SubGroupHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[9px] uppercase tracking-wider text-slate-400 font-medium pl-2 pt-1">
      {children}
    </div>
  );
}

/** Small `{}` glyph that marks a row as a script-defined detector (as opposed
 *  to a user-created layer). Rendered as a leading element in detector rows
 *  across Boundaries / Cues / Spans / Loops / Riff Patterns. */
const DetectorIcon = (
  <span
    className="text-[9px] font-mono text-slate-500 leading-none select-none shrink-0"
    title="Script-defined detector"
    aria-hidden="true"
  >
    {'{}'}
  </span>
);

/** A layer whose label carries the " (detector)" suffix is a script-defined
 *  detector output rather than a user-created layer — these get pulled out of
 *  their type group and listed under the "Detectors" section. */
const isDetectorLayer = (l: { label: string }) => /\(detector\)\s*$/.test(l.label);

/** A user-created or detector-sourced layer row inside the Annotations popover.
 *  Uses Checkbox for the toggle and a right-aligned monospace item count. When
 *  `leadingIcon` is set, it's rendered before the checkbox — used by detector
 *  rows to display the `{}` marker. */
function LayerRow({ label, color, checked, count, onChange, leadingIcon }: {
  label: string; color: string; checked: boolean; count: number;
  onChange: () => void;
  leadingIcon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {leadingIcon}
      <Checkbox label={label} color={color} checked={checked} onChange={onChange} />
      <span className="text-[9px] font-mono text-slate-400 ml-auto">{count}</span>
    </div>
  );
}

function Checkbox({ label, color, checked, onChange, title, tag }: {
  label: string; color: string; checked: boolean; onChange: (v: boolean) => void;
  title?: string;
  /** Small trailing note (e.g. "hidden") for a row whose tick isn't taking
   *  effect. Pushed to the right so the labels still read as one column. */
  tag?: string;
}) {
  return (
    <label className="flex items-center gap-1.5 cursor-pointer select-none group" title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="sr-only" />
      <span
        className={`w-3 h-3 rounded-[2px] border flex items-center justify-center transition-colors shrink-0 ${checked ? 'border-transparent' : 'border-white/[0.12] bg-[#0a0b0d]'}`}
        style={checked ? { background: color, borderColor: color, boxShadow: `0 0 6px ${color}66` } : {}}
      >
        {checked && (
          <svg className="w-2 h-2 text-black" fill="none" viewBox="0 0 10 10">
            <path d="M1.5 5l2.5 2.5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span className={`text-[11px] font-mono transition-colors whitespace-nowrap ${
        tag ? 'text-slate-500 line-through decoration-slate-600' : checked ? 'text-slate-200' : 'text-slate-600 group-hover:text-slate-400'
      }`}>
        {label}
      </span>
      {tag && (
        <span className="ml-auto pl-1.5 text-[9px] uppercase tracking-wider text-amber-400/80 whitespace-nowrap">
          {tag}
        </span>
      )}
    </label>
  );
}

/** Wraps a single big-icon control (or a tight cluster of them) and renders
 *  its label below — every control in the bar uses this so heights line up
 *  perfectly. The wrapper is `position: relative` so popovers/menus on the
 *  buttons inside can anchor to the column. */
function Column({ label, children }: { label: string; children: React.ReactNode }) {
  // The label is hidden by CSS at the tiers that can't afford it (and in the
  // compact bar), which is why the name is also on the wrapper as a tooltip.
  return (
    <div className="relative flex flex-col items-center gap-1" title={label}>
      <div className="flex items-center gap-px">{children}</div>
      <span className="tc-viz-label uppercase text-slate-300 font-semibold leading-none">
        {label}
      </span>
    </div>
  );
}

/** A big-icon dropdown trigger (Annotations / Signals / Algos / Misc). Same
 *  square shape as IconButton so heights match; opens its `children` as an
 *  absolutely-positioned popover beneath the column. */
function DropdownGroup({ icon, label, badge, isOpen, onToggle, children, accent }: {
  icon: React.ReactNode;
  /** Accessible name for the icon-only trigger — it has no text of its own,
   *  so without this the button reaches the tab order unnamed. */
  label: string;
  badge?: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  /** Pressed-tint color (badge color + open-state highlight). */
  accent: string;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const isMobile = getIsMobile();
  // "Signals — choose which …" → "Signals": the name before the explanation.
  const shortLabel = label.startsWith('More ') ? 'More' : label.split(' — ')[0];

  // The popover renders through a portal so it escapes the toolbar's stacking
  // context — otherwise the viz panel's sticky row labels (their own stacking
  // context) paint on top of it. Position it just below the trigger in viewport
  // coords, flipping to right-aligned if it would overflow the right edge.
  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current) return;
    const update = () => {
      const rect = triggerRef.current!.getBoundingClientRect();
      const popoverWidth = 220;
      const margin = 8;
      let left = rect.left;
      if (left + popoverWidth + margin > window.innerWidth) {
        left = Math.max(margin, window.innerWidth - popoverWidth - margin);
      }
      setPos({ top: rect.bottom + 4, left });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [isOpen]);

  const style: React.CSSProperties | undefined = isOpen
    ? {
        background: `${accent}33`,
        borderColor: `${accent}99`,
        boxShadow: `0 0 8px ${accent}55`,
        color: accent,
      }
    : undefined;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={onToggle}
        style={style}
        aria-expanded={isOpen}
        aria-haspopup="true"
        aria-label={label}
        title={label}
        className={`${isMobile ? 'tc-viz-ctl px-2 gap-1.5 pr-4' : 'tc-viz-sq'} relative flex items-center justify-center rounded border tc-viz-transition cursor-pointer hover:border-white/[0.30] hover:text-slate-100 ${
          isOpen ? '' : 'bg-transparent border-white/[0.18] tc-viz-icon-inactive'
        }`}
      >
        {icon}
        {/* Phone: the menu says its name. An unlabeled icon is a guess on a
            touch screen, where there is no hover tooltip to settle it. */}
        {isMobile && <span className="text-[12px] font-medium whitespace-nowrap">{shortLabel}</span>}
        {badge && (
          <span
            className="absolute -top-1 -right-1 text-[9px] font-mono px-1 rounded leading-none py-0.5 min-w-[14px] text-center"
            style={{ background: accent, color: '#0a0b0d' }}
          >
            {badge}
          </span>
        )}
        <svg
          className={`absolute bottom-0.5 right-0.5 w-2 h-2 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      </button>
      {isOpen && isMobile && createPortal(
        // Phone: a bottom sheet over the tab bar instead of a 220px popover
        // hanging off the trigger — full width, thumb-reachable, and closed
        // by its own Done or a tap on the dimmed timeline.
        <div data-viz-dropdown-popover="" className="fixed inset-0 z-[1000]">
          <button type="button" aria-label="Close menu" onClick={onToggle} className="absolute inset-0 bg-black/50" />
          <div
            role="dialog"
            aria-label={shortLabel}
            className="absolute inset-x-0 bottom-0 max-h-[70dvh] flex flex-col bg-[#14171d] border-t border-white/[0.18] rounded-t-xl shadow-2xl shadow-black/60"
            style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
          >
            <div className="flex items-center justify-between h-11 px-4 border-b border-white/[0.08] shrink-0">
              <span className="text-[12px] uppercase tracking-[0.18em] font-semibold" style={{ color: accent }}>{shortLabel}</span>
              <button type="button" onClick={onToggle} className="h-9 px-3 -mr-2 text-[13px] text-slate-200">Done</button>
            </div>
            <div className="tc-mobile-sheet-body flex-1 overflow-y-auto p-3 space-y-2">{children}</div>
          </div>
        </div>,
        document.body,
      )}
      {isOpen && !isMobile && createPortal(
        <div
          data-viz-dropdown-popover=""
          className="fixed z-[1000] bg-[#14171d] border border-white/[0.18] rounded-md shadow-2xl shadow-black/60 p-2.5 min-w-[200px] space-y-1.5 max-h-72 overflow-y-auto"
          style={{ top: pos.top, left: pos.left }}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}


/** A single big square icon button used by every "always-visible" toggle
 *  in the bar (Grid, Snap, etc.). Heights match the dropdown triggers above
 *  by construction — both take the same per-tier size. Inactive coloring
 *  goes through the `tc-viz-icon-inactive` class so light mode picks up a
 *  darker slate. */
function IconButton({
  pressed, accent, onClick, title, icon, disabled, dataTestId,
}: {
  pressed?: boolean;
  accent: string;
  onClick?: () => void;
  title?: string;
  icon: React.ReactNode;
  disabled?: boolean;
  dataTestId?: string;
}) {
  const style: React.CSSProperties | undefined = pressed
    ? {
        background: `${accent}33`,
        borderColor: `${accent}99`,
        boxShadow: `0 0 8px ${accent}55`,
        color: accent,
      }
    : undefined;
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
      data-testid={dataTestId}
      aria-pressed={pressed}
      style={style}
      className={`tc-viz-sq flex items-center justify-center rounded border tc-viz-transition ${
        pressed ? '' : 'bg-transparent border-white/[0.18] tc-viz-icon-inactive'
      } ${
        disabled
          ? 'opacity-40 cursor-not-allowed'
          : 'cursor-pointer hover:border-white/[0.30] hover:text-slate-100'
      }`}
    >
      {icon}
    </button>
  );
}

const AnnotationsIcon = (
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {/* Three stacked layer markers — annotations form layers */}
    <path d="M10 3 3 6.5l7 3.5 7-3.5L10 3z" />
    <path d="M3 10.5l7 3.5 7-3.5" />
    <path d="M3 14.5l7 3.5 7-3.5" />
  </svg>
);
const SignalsIcon = (
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {/* Audio-bars / waveform */}
    <path d="M3 10v0M6 7v6M9 4v12M12 7v6M15 10v0M18 8v4" />
  </svg>
);
const DetectorsIcon = (
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {/* Curly braces — the same `{}` that marks every detector row in the lists */}
    <path d="M8.5 3.5c-2 0-2.2 1.2-2.2 2.6 0 1.5-.3 2.6-1.8 2.9v.5c1.5.3 1.8 1.4 1.8 2.9 0 1.4.2 2.6 2.2 2.6" />
    <path d="M11.5 3.5c2 0 2.2 1.2 2.2 2.6 0 1.5.3 2.6 1.8 2.9v.5c-1.5.3-1.8 1.4-1.8 2.9 0 1.4-.2 2.6-2.2 2.6" />
  </svg>
);
const AlgosIcon = (
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {/* A processor / chip — algorithmic baseline */}
    <rect x="5" y="5" width="10" height="10" rx="1" />
    <path d="M2 8h3M2 12h3M15 8h3M15 12h3M8 2v3M12 2v3M8 15v3M12 15v3" />
  </svg>
);
const MiscIcon = (
  <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
    {/* Three horizontal sliders — "miscellaneous knobs" */}
    <circle cx="5" cy="5" r="1.6" />
    <path d="M9 4h8v2H9z" />
    <circle cx="13" cy="10" r="1.6" />
    <path d="M3 9h8v2H3zM15 9h2v2h-2z" />
    <circle cx="7" cy="15" r="1.6" />
    <path d="M3 14h2v2H3zM11 14h6v2h-6z" />
  </svg>
);

const ZoomOutIcon = (
  <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="9" r="6" />
    <path d="m17 17-3.5-3.5M6 9h6" />
  </svg>
);
const ZoomInIcon = (
  <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="9" r="6" />
    <path d="m17 17-3.5-3.5M6 9h6M9 6v6" />
  </svg>
);
const GridIcon = (
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M4 3v14M10 3v14M16 3v14" />
    <path d="M3 7h14M3 13h14" strokeWidth="1.2" />
  </svg>
);
const SnapIcon = (
  // Stylized U-magnet — universally read as "snap"
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 4v7a6 6 0 0012 0V4" />
    <path d="M4 4h3v7M16 4h-3v7" />
  </svg>
);

const GridLockIcon = (
  // Lock + grid: strict enforcement
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="9" width="14" height="9" rx="1.5" />
    <path d="M7 9V6a3 3 0 016 0v3" />
    <path d="M7 13h6M10 11v4" />
  </svg>
);

/** Renders the inline grid-mode badge. Two-line layout keeps the pill narrow
 *  and matches the height of adjacent icon buttons: first line = mode name +
 *  `GRID`, second line = BPM (or anchor count) + time signature + the bar
 *  numbering convention. In manual mode with overrides, the pinned-beat count
 *  is appended inline (amber-tinted) to the subtitle so the badge stays two
 *  lines tall. The `bars from 1` / `bars from 0` tag is the one always-visible cue
 *  that the grid is counted from zero — without it a zero-based song just
 *  reads as off-by-one. Returns null when no mode is active. */
function renderModeBadge(
  gridMode: import('../../types/songInfo').GridMode | undefined,
  overrideCount: number,
  segmentCount: number,
  bpm: number | undefined,
  timeSignature: string | undefined,
  showBeatGrid: boolean,
  barBeatOrigin: BarBeatOrigin,
): React.ReactNode {
  if (!showBeatGrid || !gridMode || !bpm) return null;
  // Same plain-language names the Song-setup panel uses, so the badge and
  // the panel never disagree about what mode you're in.
  const title = `${MODE_LABEL[gridMode]} GRID`;
  const showPinned = gridMode === 'manual' && overrideCount > 0;
  // The badge is as tall as the buttons beside it (`tc-viz-ctl`) at every
  // tier, and always two lines: when space runs short it gives up only the
  // bar-numbering origin, which the tooltip still spells out in full — never
  // the tempo line, which is what left it a short one-line sliver.
  const cls = gridMode === 'static'
    ? 'border-slate-500/40 bg-slate-500/10 text-slate-300'
    : gridMode === 'mapped'
      ? 'border-violet-500/40 bg-violet-500/10 text-violet-300'
      : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300';
  return (
    <span
      className={`tc-viz-badge tc-viz-ctl flex flex-col items-center justify-center leading-tight rounded text-[10px] font-mono border whitespace-nowrap ${cls}`}
      data-testid="grid-mode-badge"
      title={`Bars and beats are numbered from ${barBeatOrigin} — the first downbeat is `
        + `bar ${barBeatOrigin} · beat ${barBeatOrigin}. Change it under `
        + `Settings → Annotations — display → First bar / first beat numbered.`}
    >
      <span className="font-medium">{title}</span>
      <span className="tc-viz-badge-detail text-[9px] opacity-90">
        {gridMode === 'static' ? (
          <>
            {Math.round(bpm)} BPM
            {timeSignature && <> · {timeSignature}</>}
            <span className="tc-viz-badge-origin opacity-70"> · bars from {barBeatOrigin}</span>
          </>
        ) : gridMode === 'mapped' ? (
          <>
            ({segmentCount} grid{segmentCount === 1 ? '' : 's'})
            {timeSignature && <> · {timeSignature}</>}
            <span className="tc-viz-badge-origin opacity-70"> · bars from {barBeatOrigin}</span>
          </>
        ) : (
          <>
            {Math.round(bpm)} BPM
            {showPinned && (
              <span className="text-amber-300/90"> · {overrideCount} pinned</span>
            )}
            {timeSignature && <> · {timeSignature}</>}
            <span className="tc-viz-badge-origin opacity-70"> · bars from {barBeatOrigin}</span>
          </>
        )}
      </span>
    </span>
  );
}

/** Width the bar's controls want on a single line at the current tier, and
 *  the width it has. Measured from intrinsic child widths rather than from
 *  wrapping: the row is `items-end` with per-item bottom margins, so children
 *  on the same visual line don't share an offsetTop and wrap-detection by
 *  position would lie. `needed` carries the bar's own horizontal padding, so
 *  it compares directly against clientWidth. */
function measureBar(el: HTMLElement): { needed: number; avail: number } {
  // Only laid-out children count. A `display: none` child (the group dividers
  // at the last tier) is not a flex item, so it takes neither width nor a gap
  // — counting one would make the row look wider than it is and push the walk
  // a tier down.
  const widths = (Array.from(el.children) as HTMLElement[])
    .map((k) => k.getBoundingClientRect().width)
    .filter((w) => w > 0);
  const cs = getComputedStyle(el);
  const gap = parseFloat(cs.columnGap) || 0;
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const needed = widths.reduce((sum, w) => sum + w, 0)
    + gap * Math.max(0, widths.length - 1) + padX;
  return { needed, avail: el.clientWidth };
}

/** Whether the bar's controls fit on one line as it is currently sized. */
function barFits(el: HTMLElement): boolean {
  const { needed, avail } = measureBar(el);
  // Half a pixel of slack keeps sub-pixel layout from rejecting a tier that
  // does fit. A bar with no width yet (hidden panel) can't be judged — treat
  // it as fitting so the walk leaves it alone until it's on screen.
  return avail <= 0 || needed <= avail + 0.5;
}

/** Put a tier on the bar. One attribute write — every size hangs off it in
 *  CSS — so the caller can measure the result immediately. */
function applyTier(el: HTMLElement, tier: BarDensity): void {
  el.dataset.vizBarDensity = tier;
}

/** Pick the roomiest tier whose controls fit on one line, and leave the bar
 *  wearing it. Runs top to bottom in one go: step down while the row doesn't
 *  fit, then try each roomier tier in turn and keep the last one that did.
 *
 *  Every step is an attribute write followed by a measurement, which forces a
 *  synchronous reflow — that's the point. Called from a layout effect, the
 *  whole search happens before the browser paints, so the bar appears at its
 *  final size instead of visibly shrinking through the tiers. Tiers are
 *  monotonic in width, so this terminates after at most one pass each way. */
function settleBar(el: HTMLElement, start: BarDensity): BarDensity {
  let i = Math.max(0, DENSITY_ORDER.indexOf(start));
  applyTier(el, DENSITY_ORDER[i]);
  while (i < DENSITY_ORDER.length - 1 && !barFits(el)) {
    i += 1;
    applyTier(el, DENSITY_ORDER[i]);
  }
  while (i > 0) {
    applyTier(el, DENSITY_ORDER[i - 1]);
    if (!barFits(el)) {
      applyTier(el, DENSITY_ORDER[i]);
      break;
    }
    i -= 1;
  }
  return DENSITY_ORDER[i];
}

export function VizControlBar({
  compact = false,
  showAnnotations = true,
  showManual, onToggleManual, showBoundariesGroup = true,
  showAutoGuess, onToggleAutoGuess,
  showProminence = true, onToggleProminence,
  showConsensus = true, onToggleConsensus, consensusAvailable = false,
  minConsensus = 1, onMinConsensusChange, totalAlgos,
  showWaveform, onToggleWaveform,
  showEQ, onToggleEQ,
  showSpectrogram, onToggleSpectrogram,
  showCepstrogram, onToggleCepstrogram,
  showChroma, onToggleChroma,
  showTempogram, onToggleTempogram,
  showSsm, onToggleSsm,
  showEnergy, onToggleEnergy,
  showBrightness, onToggleBrightness,
  showNovelty, onToggleNovelty,
  showOnsets, onToggleOnsets,
  showFlux, onToggleFlux,
  showBeatGrid, onToggleBeatGrid,
  beatGridUnit, onBeatGridUnitChange,
  beatGridUnitOptions,
  gridMode,
  segmentCount = 1,
  overrideCount = 0,
  bpm,
  beatsPerBar,
  timeSignature,
  snapToGrid, onToggleSnapToGrid, showSnap = true,
  gridLock = false, onRequestGridLock, showGridLock = false,
  captureGlobalHScroll, onToggleCaptureGlobalHScroll,
  stemLock = true, onStemLockChange,
  gridLineThickness, onGridLineThicknessChange,
  gridThicknessAdaptive = true, onGridThicknessAdaptiveChange,
  effectiveGridLineThickness,
  zoomFactor = 1, atMaxZoom = false, onZoomIn, onZoomOut, onZoomReset,
  playbackRate = 1, onPlaybackRateChange,
  algoOptions, selectedAlgos, onToggleAlgo, showAlgos = true,
  algoStemFilter, algoStemFilterHiddenCount = 0, onClearAlgoStemFilter,
  singleInfoDetections,
  customAnnotationOptions, hiddenCustomAnnotations, onToggleCustomAnnotation,
  showDetectors = false,
  boundaryLayerOptions, onToggleBoundaryLayerVisibility,
  cueLayerOptions, onToggleCueLayerVisibility,
  spanLayerOptions, onToggleSpanLayerVisibility,
  loopLayerOptions, onToggleLoopLayerVisibility,
  lyricsLayerOptions, onToggleLyricsLayerVisibility,
  riffPatternLayerOptions, onToggleRiffPatternLayerVisibility,
}: VizControlBarProps) {
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Element | null;
      // pointerdown, not mousedown: a tap on a timeline row cancels its
      // pointerdown default (so the drag can start), and on touch that also
      // cancels the mousedown — a mousedown closer never heard the tap.
      // Dropdown popovers render through a portal (in document.body), so they
      // live outside containerRef — exempt them explicitly or any in-popover
      // click would read as "outside" and close the menu.
      if (target?.closest('[data-viz-dropdown-popover]')) return;
      if (containerRef.current && !containerRef.current.contains(target as Node)) {
        setOpenGroup(null);
      }
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, []);

  // ── Adaptive density ────────────────────────────────────────────────
  // The bar wears its tier as a data attribute that CSS reads, and the walk
  // below sets it directly on the DOM — no React state, so a tier change is
  // never a render and can happen inside the layout effect, before paint.
  const tierRef = useRef<BarDensity>('roomy');
  const settledRef = useRef<{ needed: number; avail: number } | null>(null);

  const resettle = useCallback((force = false) => {
    const el = containerRef.current;
    if (!el) return;
    if (compact) {
      el.dataset.vizBarDensity = 'compact';
      return;
    }
    // Cheap gate: re-walk only when the row's own width or the width its
    // controls want has actually moved. Without it every unrelated re-render
    // of the page would pay for a search.
    const now = measureBar(el);
    const prev = settledRef.current;
    if (!force && prev && Math.abs(prev.avail - now.avail) < 0.5
        && Math.abs(prev.needed - now.needed) < 0.5) return;
    // Start from where we already are: the walk goes both ways, and most
    // re-settles land a tier or two from the last one.
    tierRef.current = settleBar(el, tierRef.current);
    settledRef.current = measureBar(el);
  }, [compact]);

  // Every render: the set of controls can change without the bar's width
  // changing (a layer toggled on, the zoom readout widening), and `resettle`
  // is a no-op when nothing moved.
  useLayoutEffect(resettle);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || compact || typeof ResizeObserver === 'undefined') return;
    // Re-walk from scratch on a width change — window resize, a sidebar
    // collapsing, the panel the bar lives in growing. Only the bar's own
    // children resize, so this can't feed itself a new observation.
    const ro = new ResizeObserver(() => resettle(true));
    ro.observe(el);
    return () => ro.disconnect();
  }, [compact, resettle]);

  const toggle = (group: string) => setOpenGroup((prev) => (prev === group ? null : group));

  // Which layers the Annotations dropdown speaks for. When the detectors have
  // been lifted into their own column they are no longer this dropdown's
  // business, so its badge and its All / None stop at the human-authored
  // layers — the per-type sections below already filtered to those.
  const ownLayers = <T extends { label: string }>(list: T[] | undefined): T[] => (
    showDetectors ? (list ?? []).filter((l) => !isDetectorLayer(l)) : (list ?? [])
  );
  const annotationCueLayers = ownLayers(cueLayerOptions);
  const annotationSpanLayers = ownLayers(spanLayerOptions);
  const annotationLoopLayers = ownLayers(loopLayerOptions);
  const annotationLyricsLayers = ownLayers(lyricsLayerOptions);

  const visibleCustomAnnotations = showDetectors
    ? []
    : (customAnnotationOptions ?? []).filter((o) => !hiddenCustomAnnotations?.has(o.id));
  const visibleCueLayers = annotationCueLayers.filter((o) => o.visible);
  const visibleSpanLayers = annotationSpanLayers.filter((o) => o.visible);
  const visibleLoopLayers = annotationLoopLayers.filter((o) => o.visible);
  const visibleLyricsLayers = annotationLyricsLayers.filter((o) => o.visible);
  const visibleRiffPatternLayers = (riffPatternLayerOptions ?? []).filter((o) => o.visible);

  // Detectors are collected out of every annotation type and listed together
  // under the "Detectors" section. Boundary detectors arrive as their
  // own prop; the cue/span/loop/lyrics ones are layers tagged
  // "(detector)". Riff patterns have no detector variant.
  const boundaryDetectors = customAnnotationOptions ?? [];
  const cueDetectors = (cueLayerOptions ?? []).filter(isDetectorLayer);
  const spanDetectors = (spanLayerOptions ?? []).filter(isDetectorLayer);
  const loopDetectors = (loopLayerOptions ?? []).filter(isDetectorLayer);
  const lyricsDetectors = (lyricsLayerOptions ?? []).filter(isDetectorLayer);
  // Default (shipped) vs Custom — titled only when both kinds are listed.
  const detectorOrigins = groupByDetectorOrigin(
    [...boundaryDetectors, ...cueDetectors, ...spanDetectors, ...loopDetectors, ...lyricsDetectors],
    (o) => !!o.isDefault,
  );
  const detectorCount = boundaryDetectors.length + cueDetectors.length
    + spanDetectors.length + loopDetectors.length + lyricsDetectors.length;
  // Same two-shapes problem as the flips below: boundary detectors read their
  // state off the hidden set, every other kind carries a `visible` flag.
  const detectorsActive = boundaryDetectors.filter((o) => !hiddenCustomAnnotations?.has(o.id)).length
    + [cueDetectors, spanDetectors, loopDetectors, lyricsDetectors]
      .reduce((n, list) => n + list.filter((o) => o.visible).length, 0);
  // ── All / None flips ──────────────────────────────────────────────
  // Boundary detectors are the odd ones out: they're hidden by a set rather
  // than carrying a `visible` flag, so they get their own flip and every
  // caller below reaches them through it exactly once.
  const setAllBoundaryDetectors = (visible: boolean) => {
    boundaryDetectors.forEach((o) => {
      if ((!hiddenCustomAnnotations?.has(o.id)) !== visible) onToggleCustomAnnotation?.(o.id);
    });
  };
  const setAllDetectors = (visible: boolean) => {
    setAllBoundaryDetectors(visible);
    setLayersVisible(cueDetectors, onToggleCueLayerVisibility, visible);
    setLayersVisible(spanDetectors, onToggleSpanLayerVisibility, visible);
    setLayersVisible(loopDetectors, onToggleLoopLayerVisibility, visible);
    setLayersVisible(lyricsDetectors, onToggleLyricsLayerVisibility, visible);
  };
  const setAllProminence = (visible: boolean) => {
    if (onToggleProminence && showProminence !== visible) onToggleProminence(visible);
  };
  const setAllBoundaries = (visible: boolean) => {
    if (showManual !== visible) onToggleManual(visible);
    if (showAutoGuess !== visible) onToggleAutoGuess(visible);
  };
  const setAllConsensus = (visible: boolean) => {
    if (consensusAvailable && onToggleConsensus && showConsensus !== visible) onToggleConsensus(visible);
  };
  // The popover-wide flip. Walks each list in one pass rather than composing
  // the section flips, so no id is toggled twice — a second pass would read
  // the same stale `visible` and flip it straight back. The lists are the
  // dropdown's own (`ownLayers`), so with detectors split out this reaches
  // exactly what the popover shows.
  const setAllAnnotations = (visible: boolean) => {
    setAllBoundaries(visible);
    setAllProminence(visible);
    if (!showDetectors) setAllBoundaryDetectors(visible);
    setLayersVisible(annotationCueLayers, onToggleCueLayerVisibility, visible);
    setLayersVisible(annotationSpanLayers, onToggleSpanLayerVisibility, visible);
    setLayersVisible(annotationLoopLayers, onToggleLoopLayerVisibility, visible);
    setLayersVisible(annotationLyricsLayers, onToggleLyricsLayerVisibility, visible);
    setLayersVisible(riffPatternLayerOptions, onToggleRiffPatternLayerVisibility, visible);
  };
  const annotationsActive = [showManual, showAutoGuess].filter(Boolean).length
    + visibleCustomAnnotations.length
    + visibleCueLayers.length
    + visibleSpanLayers.length
    + visibleLoopLayers.length
    + visibleLyricsLayers.length
    + visibleRiffPatternLayers.length;
  const barBeatOrigin = useBarBeatOrigin();
  // One list drives the badge count, the checkbox rows and the All / None, so
  // a signal can't be counted without being listed (or flipped without both).
  const signalRows: { label: string; color: string; checked: boolean; onChange: (v: boolean) => void }[] = [
    { label: '3-Band',        color: '#6366f1', checked: showWaveform,    onChange: onToggleWaveform },
    { label: 'EQ',            color: '#60a5fa', checked: showEQ,          onChange: onToggleEQ },
    { label: 'Spectrogram',   color: '#8b5cf6', checked: showSpectrogram, onChange: onToggleSpectrogram },
    { label: 'MFCC',          color: '#c084fc', checked: showCepstrogram, onChange: onToggleCepstrogram },
    { label: 'Chroma',        color: '#84cc16', checked: showChroma,      onChange: onToggleChroma },
    { label: 'Tempogram',     color: '#d946ef', checked: showTempogram,   onChange: onToggleTempogram },
    { label: 'SSM',           color: '#f97316', checked: showSsm,         onChange: onToggleSsm },
    { label: 'Energy',        color: '#f59e0b', checked: showEnergy,      onChange: onToggleEnergy },
    { label: 'Brightness',    color: '#22d3ee', checked: showBrightness,  onChange: onToggleBrightness },
    { label: 'Novelty',       color: '#a78bfa', checked: showNovelty,     onChange: onToggleNovelty },
    { label: 'Onsets',        color: '#f472b6', checked: showOnsets,      onChange: onToggleOnsets },
    { label: 'Spectral Flux', color: '#10b981', checked: showFlux,        onChange: onToggleFlux },
  ];
  const signalsActive = signalRows.filter((r) => r.checked).length;
  const setAllSignals = (visible: boolean) => {
    signalRows.forEach((r) => { if (r.checked !== visible) r.onChange(visible); });
  };
  const algosActive = (selectedAlgos?.size ?? 0)
    + (consensusAvailable && showConsensus ? 1 : 0);
  // A plain count lies when the stem filter is vetoing some of what's ticked —
  // the badge says 3 and two lanes are on screen. Read it as "drawn/ticked"
  // instead, so the discrepancy is visible without opening the popover.
  const algosBadge = algoStemFilterHiddenCount > 0
    ? `${algosActive - algoStemFilterHiddenCount}/${algosActive}`
    : String(algosActive);

  // Zoom multiplier == 1 (within fp slack) means WaveSurfer is at "fit" —
  // the − button no-ops there and should look disabled.
  const atFit = Math.abs(zoomFactor - 1) < 1e-3;
  const zoomLabel = atFit
    ? 'fit'
    : `×${zoomFactor < 10 ? zoomFactor.toFixed(1) : Math.round(zoomFactor)}`;
  const gridWarn = showBeatGrid && !bpm;
  const modeBadge = renderModeBadge(gridMode, overrideCount, segmentCount, bpm, timeSignature, showBeatGrid, barBeatOrigin);
  // The Detectors section — every script-defined detector overlay,
  // grouped by the annotation type it produces, pulled out of the type groups
  // so the human-authored layers stay uncluttered. One definition, two homes:
  // it sits inside the Annotations dropdown by default, and Algo Inspect
  // (`showDetectors`) lifts it into a column of its own instead, where
  // detectors are the subject rather than one group among many.
  // The Consensus lane's visibility, as a group of the Algos popover. It goes
  // in the LIST — directly under the boundary families (Ruptures / MSAF /
  // All-In-One), which are the lanes it is blended from — rather than in the
  // popover's tail after the cue / span detectors, which have nothing to do
  // with it. Named here rather than written inline because the list has two
  // branches (groups, or the "nothing cached yet" note) and the consensus
  // belongs in both: it can exist on a song whose only rows came from
  // detectors. Deliberately outside the Algorithms All / None above, which
  // speaks for the overlay rows only.
  const consensusSection = consensusAvailable && onToggleConsensus ? (
    <>
      <GroupHeader
        onAll={() => setAllConsensus(true)}
        onNone={() => setAllConsensus(false)}
        allTitle="Show the Consensus lane"
        noneTitle="Hide the Consensus lane"
      >
        Consensus
      </GroupHeader>
      <Checkbox
        label="Consensus"
        color="#8b5cf6"
        checked={showConsensus}
        onChange={onToggleConsensus}
        title="Show the Consensus lane — the blend Consensus Inspect built from the checked detectors. Its settings live in that stage, below the timeline; its ⬇ copies the blend into a boundary layer you own."
      />
    </>
  ) : null;
  const detectorSections = (
    <>
      <GroupHeader
        onAll={() => setAllDetectors(true)}
        onNone={() => setAllDetectors(false)}
        allTitle="Show every detector overlay"
        noneTitle="Hide every detector overlay"
      >
        Detectors
      </GroupHeader>

      {detectorOrigins.map(({ origin, title }) => {
        const mine = <T extends { isDefault?: boolean }>(opts: T[]) =>
          opts.filter((o) => (origin === 'default') === !!o.isDefault);
        return (
        <Fragment key={origin}>
          {title && <OriginHeader>{title}</OriginHeader>}
          {mine(boundaryDetectors).length > 0 && onToggleCustomAnnotation && (
            <>
              <SubGroupHeader>Boundaries</SubGroupHeader>
              {mine(boundaryDetectors).map((opt) => (
                <div key={opt.id} className="flex items-center gap-1.5">
                  {DetectorIcon}
                  <Checkbox
                    label={opt.label}
                    color={opt.color}
                    checked={!hiddenCustomAnnotations?.has(opt.id)}
                    onChange={() => onToggleCustomAnnotation(opt.id)}
                  />
                </div>
              ))}
            </>
          )}

          {mine(cueDetectors).length > 0 && onToggleCueLayerVisibility && (
            <>
              <SubGroupHeader>Cues</SubGroupHeader>
              {mine(cueDetectors).map((opt) => (
                <LayerRow
                  key={opt.id}
                  label={opt.label.replace(/\s*\(detector\)\s*$/, '')}
                  color={opt.color}
                  checked={opt.visible}
                  count={opt.count}
                  onChange={() => onToggleCueLayerVisibility(opt.id)}
                  leadingIcon={DetectorIcon}
                />
              ))}
            </>
          )}

          {mine(spanDetectors).length > 0 && onToggleSpanLayerVisibility && (
            <>
              <SubGroupHeader>Spans</SubGroupHeader>
              {mine(spanDetectors).map((opt) => (
                <LayerRow
                  key={opt.id}
                  label={opt.label.replace(/\s*\(detector\)\s*$/, '')}
                  color={opt.color}
                  checked={opt.visible}
                  count={opt.count}
                  onChange={() => onToggleSpanLayerVisibility(opt.id)}
                  leadingIcon={DetectorIcon}
                />
              ))}
            </>
          )}

          {mine(loopDetectors).length > 0 && onToggleLoopLayerVisibility && (
            <>
              <SubGroupHeader>Loops</SubGroupHeader>
              {mine(loopDetectors).map((opt) => (
                <LayerRow
                  key={opt.id}
                  label={opt.label.replace(/\s*\(detector\)\s*$/, '')}
                  color={opt.color}
                  checked={opt.visible}
                  count={opt.count}
                  onChange={() => onToggleLoopLayerVisibility(opt.id)}
                  leadingIcon={DetectorIcon}
                />
              ))}
            </>
          )}

          {mine(lyricsDetectors).length > 0 && onToggleLyricsLayerVisibility && (
            <>
              <SubGroupHeader>Lyrics</SubGroupHeader>
              {mine(lyricsDetectors).map((opt) => (
                <LayerRow
                  key={opt.id}
                  label={opt.label.replace(/\s*\(detector\)\s*$/, '')}
                  color={opt.color}
                  checked={opt.visible}
                  count={opt.count}
                  onChange={() => onToggleLyricsLayerVisibility(opt.id)}
                  leadingIcon={DetectorIcon}
                />
              ))}
            </>
          )}
        </Fragment>
        );
      })}
    </>
  );

  const miscOpen = openGroup === 'misc';

  return (
    <div
      ref={containerRef}
      // The compact bar wraps like the full one: the slim transport lives in
      // the main column, which sits between two sidebars, so a single
      // unwrappable row would spill out of the column and paint over the
      // Detectors / Annotate panels next to it.
      className={compact
        ? 'tc-viz-bar flex flex-wrap items-center justify-end'
        : 'tc-viz-bar flex flex-wrap items-end bg-[#14171d]/80 border border-white/[0.14] rounded-md'}
    >
      {/* ── GRID LOCK — first so it's always visible in compact mode ────── */}
      {showGridLock && (
        <Column label="Grid Lock">
          <button
            type="button"
            onClick={() => onRequestGridLock?.(!gridLock)}
            title={gridLock
              ? 'Grid Lock is ON — snapping locked, beat display active. Click to disable.'
              : 'Enable Grid Lock: lock snapping on and re-snap all annotations to the beat grid'}
            data-testid="viz-grid-lock"
            aria-pressed={gridLock}
            className={[
              'tc-viz-lock tc-viz-ctl flex items-center',
              'rounded border font-mono text-[11px] font-semibold tc-viz-transition cursor-pointer',
              gridLock
                ? 'bg-amber-500/20 border-amber-400/70 text-amber-200 shadow-[0_0_10px_rgba(251,191,36,0.35)]'
                : 'bg-transparent border-white/[0.18] text-slate-400 hover:text-slate-100 hover:border-white/30',
            ].join(' ')}
          >
            {GridLockIcon}
            <span>GRID LOCK</span>
          </button>
        </Column>
      )}

      {/* ── Signals ────────────────────────────────────────────────── */}
      <Column label="Signals">
      <DropdownGroup
        icon={SignalsIcon}
        label="Signals — choose which MIR signal lanes are drawn"
        accent="#8b5cf6"
        badge={signalsActive > 0 ? String(signalsActive) : undefined}
        isOpen={openGroup === 'signals'}
        onToggle={() => toggle('signals')}
      >
        <GroupHeader
          onAll={() => setAllSignals(true)}
          onNone={() => setAllSignals(false)}
          allTitle="Show every signal panel"
          noneTitle="Hide every signal panel"
        >
          Signals
        </GroupHeader>
        {signalRows.map((r) => (
          <Checkbox key={r.label} label={r.label} color={r.color} checked={r.checked} onChange={r.onChange} />
        ))}
      </DropdownGroup>
      </Column>

      {/* ── Annotations ────────────────────────────────────────────── */}
      {showAnnotations && (
      <Column label="Annotations">
      <DropdownGroup
        icon={AnnotationsIcon}
        label="Annotations — choose which annotation layers are drawn"
        accent="#a78bfa"
        badge={annotationsActive > 0 ? String(annotationsActive) : undefined}
        isOpen={openGroup === 'annotations'}
        onToggle={() => toggle('annotations')}
      >
        {/* Reaches every section below in one gesture, which is why it sits
            above them rather than inside a section. */}
        <GroupHeader
          onAll={() => setAllAnnotations(true)}
          onNone={() => setAllAnnotations(false)}
          allTitle="Show every annotation layer"
          noneTitle="Hide every annotation layer"
        >
          Annotations
        </GroupHeader>

        {/* ── Prominence ─────────────────────────────────────────
            One derived row, not a layer list — every durational item's
            envelope, read top-down. Hence a lone checkbox and no All / None. */}
        {onToggleProminence && (
          <>
            <GroupHeader>Prominence</GroupHeader>
            <Checkbox
              label="Prominence lane"
              color="#34d399"
              checked={showProminence}
              onChange={onToggleProminence}
              title="Show the Prominence lane — who is in front, across every layer at once. The lane still hides itself on songs with nothing durational annotated."
            />
          </>
        )}

        {/* ── Boundaries ─────────────────────────────────────────── */}
        {/* One row per boundary LAYER, like Cues and Spans — plus the
            whole-type toggle (G), which is what the keyboard shortcut and the
            Inspect workspace's visibility set still address. Auto-guess sits
            here too: it reads as a boundary source even though it is a review
            document rather than a lane. */}
        <GroupHeader
          onAll={() => setAllBoundaries(true)}
          onNone={() => setAllBoundaries(false)}
          allTitle="Show every boundary layer and Auto-guess"
          noneTitle="Hide every boundary layer and Auto-guess"
        >
          Boundaries
        </GroupHeader>
        {showBoundariesGroup && (
          <Checkbox label="Manual" color="#f59e0b" checked={showManual} onChange={onToggleManual} title="Toggle every boundary layer (G)" />
        )}
        {showManual && boundaryLayerOptions && onToggleBoundaryLayerVisibility
          && boundaryLayerOptions.filter((l) => !isDetectorLayer(l)).map((opt) => (
            <LayerRow
              key={opt.id}
              label={opt.label}
              color={opt.color}
              checked={opt.visible}
              count={opt.count}
              onChange={() => onToggleBoundaryLayerVisibility(opt.id)}
            />
          ))}
        <div className="flex items-center gap-1.5 flex-wrap">
          <Checkbox label="Auto-guess" color="#a78bfa" checked={showAutoGuess} onChange={onToggleAutoGuess} title="Toggle Auto-guess layer (A)" />
          {showAutoGuess && onMinConsensusChange && [2, 3, 4].map((n) => (
            <button
              key={n}
              onClick={() => onMinConsensusChange(minConsensus === n ? Math.max(2, n - 1) : n)}
              title={totalAlgos ? `Show only clusters with ≥${n}/${totalAlgos} algorithms agreeing` : `Show only clusters with ≥${n} algorithms agreeing`}
              className={`px-1 h-4 rounded text-[9px] font-mono leading-none transition-colors ${
                minConsensus === n
                  ? 'bg-violet-500/25 text-violet-200 border border-violet-400/40'
                  : 'bg-[#0a0b0d] text-slate-400 border border-white/[0.12] hover:text-slate-200 hover:border-white/[0.22]'
              }`}
            >
              ≥{n}{totalAlgos ? `/${totalAlgos}` : ''}
            </button>
          ))}
        </div>
        {/* ── Cues (user layers only — detectors live under Detectors) ── */}
        {cueLayerOptions && onToggleCueLayerVisibility && (() => {
          const userLayers = cueLayerOptions.filter((l) => !isDetectorLayer(l));
          if (userLayers.length === 0) return null;
          return (
            <>
              <GroupHeader
                onAll={() => setLayersVisible(userLayers, onToggleCueLayerVisibility, true)}
                onNone={() => setLayersVisible(userLayers, onToggleCueLayerVisibility, false)}
                allTitle="Show every Cues layer"
                noneTitle="Hide every Cues layer"
              >
                Cues
              </GroupHeader>
              {userLayers.map((opt) => (
                <LayerRow
                  key={opt.id}
                  label={opt.label}
                  color={opt.color}
                  checked={opt.visible}
                  count={opt.count}
                  onChange={() => onToggleCueLayerVisibility(opt.id)}
                />
              ))}
            </>
          );
        })()}

        {/* ── Spans (user layers only) ──────────────────────────── */}
        {spanLayerOptions && onToggleSpanLayerVisibility && (() => {
          const userLayers = spanLayerOptions.filter((l) => !isDetectorLayer(l));
          if (userLayers.length === 0) return null;
          return (
            <>
              <GroupHeader
                onAll={() => setLayersVisible(userLayers, onToggleSpanLayerVisibility, true)}
                onNone={() => setLayersVisible(userLayers, onToggleSpanLayerVisibility, false)}
                allTitle="Show every Spans layer"
                noneTitle="Hide every Spans layer"
              >
                Spans
              </GroupHeader>
              {userLayers.map((opt) => (
                <LayerRow
                  key={opt.id}
                  label={opt.label}
                  color={opt.color}
                  checked={opt.visible}
                  count={opt.count}
                  onChange={() => onToggleSpanLayerVisibility(opt.id)}
                />
              ))}
            </>
          );
        })()}

        {/* ── Loops (user layers only) ──────────────────────────── */}
        {loopLayerOptions && onToggleLoopLayerVisibility && (() => {
          const userLayers = loopLayerOptions.filter((l) => !isDetectorLayer(l));
          if (userLayers.length === 0) return null;
          return (
            <>
              <GroupHeader
                onAll={() => setLayersVisible(userLayers, onToggleLoopLayerVisibility, true)}
                onNone={() => setLayersVisible(userLayers, onToggleLoopLayerVisibility, false)}
                allTitle="Show every Loops layer"
                noneTitle="Hide every Loops layer"
              >
                Loops
              </GroupHeader>
              {userLayers.map((opt) => (
                <LayerRow
                  key={opt.id}
                  label={opt.label}
                  color={opt.color}
                  checked={opt.visible}
                  count={opt.count}
                  onChange={() => onToggleLoopLayerVisibility(opt.id)}
                />
              ))}
            </>
          );
        })()}

        {/* ── Lyrics (user layers only — detectors live under Detectors) ── */}
        {lyricsLayerOptions && onToggleLyricsLayerVisibility && (() => {
          const userLayers = lyricsLayerOptions.filter((l) => !isDetectorLayer(l));
          if (userLayers.length === 0) return null;
          return (
            <>
              <GroupHeader
                onAll={() => setLayersVisible(userLayers, onToggleLyricsLayerVisibility, true)}
                onNone={() => setLayersVisible(userLayers, onToggleLyricsLayerVisibility, false)}
                allTitle="Show every Lyrics layer"
                noneTitle="Hide every Lyrics layer"
              >
                Lyrics
              </GroupHeader>
              {userLayers.map((opt) => (
                <LayerRow
                  key={opt.id}
                  label={opt.label}
                  color={opt.color}
                  checked={opt.visible}
                  count={opt.count}
                  onChange={() => onToggleLyricsLayerVisibility(opt.id)}
                />
              ))}
            </>
          );
        })()}

        {/* ── Riff Patterns (user layers only — no detector variant) ─── */}
        {riffPatternLayerOptions && onToggleRiffPatternLayerVisibility && riffPatternLayerOptions.length > 0 && (
          <>
            <GroupHeader
              onAll={() => setLayersVisible(riffPatternLayerOptions, onToggleRiffPatternLayerVisibility, true)}
              onNone={() => setLayersVisible(riffPatternLayerOptions, onToggleRiffPatternLayerVisibility, false)}
              allTitle="Show every Riff Pattern layer"
              noneTitle="Hide every Riff Pattern layer"
            >
              Riff Patterns
            </GroupHeader>
            {riffPatternLayerOptions.map((opt) => (
              <LayerRow
                key={opt.id}
                label={opt.label}
                color={opt.color}
                checked={opt.visible}
                count={opt.count}
                onChange={() => onToggleRiffPatternLayerVisibility(opt.id)}
              />
            ))}
          </>
        )}

        {/* ── Detectors ──────────────────────────────────────
            Lifted into its own column in Algo Inspect; listed here as one
            more group everywhere else. */}
        {!showDetectors && detectorCount > 0 && detectorSections}
      </DropdownGroup>
      </Column>
      )}

      {/* ── Algos (Inspect only) ─────────────────────────────────── */}
      {showAlgos && algoOptions && onToggleAlgo && selectedAlgos && (
        <>
        <Column label="Algos">
        <DropdownGroup
          icon={AlgosIcon}
          label="Algorithms — choose which algorithm outputs, and the consensus blended from them, are drawn"
          accent="#10b981"
          badge={algosActive > 0 ? algosBadge : undefined}
          isOpen={openGroup === 'algos'}
          onToggle={() => toggle('algos')}
        >
          {algoStemFilterHiddenCount > 0 && (
            <div className="mb-1 rounded-[3px] border border-amber-500/30 bg-amber-500/[0.07] px-1.5 py-1 max-w-[204px]">
              <p className="text-[10px] leading-snug text-amber-200/90">
                Stem filter is on <span className="font-mono text-amber-100">{algoStemFilter}</span> —{' '}
                {algoStemFilterHiddenCount} ticked {algoStemFilterHiddenCount === 1 ? 'row is' : 'rows are'} full-mix
                and {algoStemFilterHiddenCount === 1 ? 'is' : 'are'} not drawn.
              </p>
              {onClearAlgoStemFilter && (
                <button
                  type="button"
                  onClick={onClearAlgoStemFilter}
                  className="mt-1 text-[10px] font-mono text-amber-300 underline underline-offset-2 hover:text-amber-100 cursor-pointer"
                  title="Set the stem filter back to “all”, so full-mix rows and per-stem rows are both drawn"
                >
                  show all stems
                </button>
              )}
            </div>
          )}
          {algoOptions.length === 0 ? (
            <>
              <p className="text-[10px] text-slate-500 leading-snug px-0.5 py-1 max-w-[180px]">
                No algorithm results for this song yet. Run algorithms from the sidebar to populate this list.
              </p>
              {consensusSection}
            </>
          ) : (() => {
            const groupOf = (id: string): GroupKey => {
              if (id.startsWith('msaf-')) return 'msaf';
              if (id.startsWith('ruptures-')) return 'ruptures';
              if (id === 'allin1' || id.startsWith('allin1-')) return 'allin1';
              if (id.startsWith('custom:')) return 'custom';
              return 'other';
            };
            type GroupKey = 'msaf' | 'allin1' | 'ruptures' | 'custom' | 'other';
            const grouped: Record<GroupKey, AlgoOverlayOption[]> = {
              msaf: [], allin1: [], ruptures: [], custom: [], other: [],
            };
            algoOptions.forEach((opt) => { grouped[groupOf(opt.id)].push(opt); });

            const setSelected = (ids: string[], select: boolean) => {
              ids.forEach((id) => {
                const isOn = selectedAlgos.has(id);
                if (select && !isOn) onToggleAlgo(id);
                else if (!select && isOn) onToggleAlgo(id);
              });
            };

            // A Fragment, not a wrapper div: GroupHeader's divider keys off
            // being the popover's first child, so nesting the headers one
            // level deeper would give every group a top border.
            const renderGroup = (key: GroupKey, label: string) => {
              const items = grouped[key];
              if (items.length === 0) return null;
              const ids = items.map((o) => o.id);
              return (
                <Fragment key={key}>
                  <GroupHeader
                    onAll={() => setSelected(ids, true)}
                    onNone={() => setSelected(ids, false)}
                    allTitle={`Show every ${label} overlay`}
                    noneTitle={`Hide every ${label} overlay`}
                  >
                    {label}
                  </GroupHeader>
                  {items.map((opt) => (
                    <Checkbox
                      key={opt.id}
                      label={opt.label}
                      color="#10b981"
                      checked={selectedAlgos.has(opt.id)}
                      onChange={() => onToggleAlgo(opt.id)}
                      tag={opt.hiddenByStemFilter ? 'hidden' : undefined}
                      title={opt.hiddenByStemFilter
                        ? `Ticked, but not drawn: the stem filter is on “${opt.hiddenByStemFilter}” and this row is the full mix. Switch the filter to mix or all to see it.`
                        : undefined}
                    />
                  ))}
                </Fragment>
              );
            };

            return (
              <>
                <GroupHeader
                  onAll={() => setSelected(algoOptions.map((o) => o.id), true)}
                  onNone={() => setSelected(algoOptions.map((o) => o.id), false)}
                  allTitle="Show every algorithm overlay"
                  noneTitle="Hide every algorithm overlay"
                >
                  Algorithms
                </GroupHeader>
                {renderGroup('ruptures', 'Ruptures')}
                {renderGroup('msaf', 'MSAF')}
                {renderGroup('allin1', 'All-In-One')}
                {consensusSection}
                {renderGroup('custom', 'Custom')}
                {renderGroup('other', 'Other')}
              </>
            );
          })()}
        </DropdownGroup>
        </Column>
        </>
      )}

      {/* ── Detectors (Algo Inspect only) ──────────────────────────
           The Detectors section the Annotations dropdown carries
           everywhere else, promoted to a column of its own: in Algo Inspect
           the detector outputs are what the user came to look at. */}
      {showDetectors && (
        <Column label="Detectors">
        <DropdownGroup
          icon={DetectorsIcon}
          label="Detectors — choose which detector layers are drawn"
          accent="#f43f5e"
          badge={detectorsActive > 0 ? String(detectorsActive) : undefined}
          isOpen={openGroup === 'detectors'}
          onToggle={() => toggle('detectors')}
        >
          {detectorCount === 0 ? (
            <p className="text-[10px] text-slate-500 leading-snug px-0.5 py-1 max-w-[180px]">
              No custom detector results for this song yet. Run detectors from the sidebar to populate this list.
            </p>
          ) : detectorSections}
        </DropdownGroup>
        </Column>
      )}

      <span className="tc-viz-rule tc-viz-drop w-px bg-white/[0.18]" aria-hidden="true" />

      {/* ── Zoom (− · ×N/fit · +) ─────────────────────────────────── */}
      <Column label="Zoom">
        <IconButton
          icon={ZoomOutIcon}
          accent="#60a5fa"
          onClick={onZoomOut}
          disabled={atFit}
          title="Zoom out (−)"
          dataTestId="viz-zoom-out"
        />
        <button
          type="button"
          onClick={onZoomReset}
          disabled={atFit}
          title="Reset zoom — fit (0)"
          data-testid="viz-zoom-reset"
          className={`tc-viz-ctl tc-viz-zoom px-2 text-[11px] font-mono text-center border border-white/[0.18] transition-colors ${
            atFit
              ? 'bg-transparent text-slate-300 cursor-default'
              : 'bg-white/[0.05] hover:bg-white/[0.10] text-slate-100 cursor-pointer'
          }`}
        >
          {zoomLabel}
        </button>
        <IconButton
          icon={ZoomInIcon}
          accent="#60a5fa"
          onClick={onZoomIn}
          disabled={atMaxZoom}
          title={atMaxZoom ? 'Maximum zoom' : 'Zoom in (+)'}
          dataTestId="viz-zoom-in"
        />
      </Column>

      {/* ── Speed (slow the whole song + its karaoke/grid sweep) ──── */}
      {onPlaybackRateChange && (
        <Column label="Speed">
          <select
            value={playbackRate}
            onChange={(e) => onPlaybackRateChange(Number(e.target.value))}
            title="Playback speed — slows the song and the karaoke/beat-grid sweep together (pitch preserved)"
            data-testid="viz-playback-speed"
            className={`tc-viz-ctl w-auto pl-2 pr-0.5 text-[11px] font-mono rounded border transition-colors focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/50 cursor-pointer ${
              Math.abs(playbackRate - 1) < 1e-3
                ? 'bg-white/[0.05] hover:bg-white/[0.10] border-white/[0.22] text-slate-100'
                : 'bg-emerald-500/15 border-emerald-500/50 text-emerald-200'
            }`}
          >
            <option value={1}>1×</option>
            <option value={0.75}>0.75×</option>
            <option value={0.5}>0.5×</option>
            <option value={0.25}>0.25×</option>
          </select>
        </Column>
      )}

      <span className="tc-viz-rule tc-viz-drop w-px bg-white/[0.18]" aria-hidden="true" />

      {/* ── Grid (toggle + inline unit selector) ─────────────────── */}
      <Column label="Grid">
        <IconButton
          icon={GridIcon}
          accent={gridWarn ? '#f59e0b' : '#818cf8'}
          pressed={showBeatGrid}
          onClick={() => onToggleBeatGrid(!showBeatGrid)}
          title={gridWarn ? 'Grid is on, but no BPM is set for this song — the grid can only render once BPM is known.' : 'Show beat grid'}
          dataTestId="viz-grid-toggle"
        />
        <select
          value={beatGridUnit}
          onChange={(e) => onBeatGridUnitChange(e.target.value as BeatGridUnit)}
          disabled={!showBeatGrid || !bpm}
          title="Grid granularity"
          data-testid="viz-grid-unit"
          // Capped in compact mode: w-auto sizes a <select> to its widest
          // option ("Compound (×3 beats)"), which is 185px of a slim transport
          // that has to fit between two sidebars. The open list is drawn by the
          // browser at full width, so only the closed label truncates.
          className={`tc-viz-ctl tc-viz-select w-auto pl-2 pr-0.5 text-[11px] font-mono rounded border transition-colors focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/50 ${
            !showBeatGrid || !bpm
              ? 'bg-transparent border-white/[0.15] text-slate-500 cursor-not-allowed'
              : 'bg-white/[0.05] hover:bg-white/[0.10] border-white/[0.22] text-slate-100 cursor-pointer'
          }`}
        >
          {(beatGridUnitOptions ?? BEAT_GRID_UNIT_OPTIONS)
            .filter((unit) => unit !== 'compound-beat' || (beatsPerBar != null && beatsPerBar >= 6 && beatsPerBar % 3 === 0))
            .map((unit) => (
              <option key={unit} value={unit}>{beatGridUnitLabel(unit)}</option>
            ))}
        </select>
      </Column>

      {/* ── Snap (very visible, next to Grid) ─────────────────────── */}
      {showSnap && (
        <Column label="Snap">
          <IconButton
            icon={SnapIcon}
            accent="#818cf8"
            pressed={snapToGrid || gridLock}
            onClick={gridLock ? undefined : () => onToggleSnapToGrid(!snapToGrid)}
            disabled={gridLock}
            title={gridLock ? 'Snap is locked on in Grid Lock' : 'Snap new boundaries / cues to the beat grid'}
            dataTestId="viz-snap-toggle"
          />
        </Column>
      )}

      {/* Inline grid status (warning chip when BPM missing, mode badge in prep).
          Stacks into two lines to match the mode-badge layout and keep the
          chip the same height as the adjacent icon buttons. */}
      {gridWarn && !compact && (
        <Column label="Grid">
        <span
          className="tc-viz-badge tc-viz-ctl flex flex-col items-center justify-center leading-tight rounded text-[10px] font-mono border border-amber-500/50 bg-amber-500/15 text-amber-200 whitespace-nowrap"
          data-testid="beat-grid-no-bpm-warning"
        >
          <span className="font-medium"><span aria-hidden="true">⚠ </span>Grid can&apos;t render</span>
          <span className="text-[9px] opacity-90">set a BPM for this song</span>
        </span>
        </Column>
      )}
      {/* In a Column like every other control, so its box sits on the same
          line as theirs: a label-less item had to guess the height of the
          caption row and came out 4px high. */}
      {modeBadge && !compact && <Column label="Mode">{modeBadge}</Column>}

      {/* ── Misc (extras dropdown — swipe-back, stem lock, grid thickness) ─ */}
      <Column label="Misc">
        <DropdownGroup
          icon={MiscIcon}
          label="More visualization options"
          accent="#22d3ee"
          isOpen={miscOpen}
          onToggle={() => toggle('misc')}
        >
          <div title="When on, the browser's swipe-back/forward gesture is suppressed everywhere on the page — every horizontal trackpad/wheel gesture scrolls the timeline instead. When off (default), only gestures over the waveform and viz panels are intercepted; horizontal swipes elsewhere still navigate history.">
            <Checkbox
              label="Block browser swipe-back"
              color="#22d3ee"
              checked={captureGlobalHScroll}
              onChange={onToggleCaptureGlobalHScroll}
            />
          </div>
          {onStemLockChange && (
            <div className="mt-1.5">
              <Checkbox
                label="Lock player stem to stem filter"
                color="#22d3ee"
                checked={stemLock}
                onChange={onStemLockChange}
                title="When on (default), the stem you play and the stem filter in the Algorithms sidebar move together — picking vocals on either one picks it on the other. Turn off to listen to one stem while reading another stem's rows."
              />
            </div>
          )}
          <div
            className="pt-2 mt-1 border-t border-white/[0.12]"
            title="Scales the width of every beat-grid line (bars, beats, sub-beats) across all rows. 1× is the default."
          >
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-[11px] font-mono text-slate-200">Grid line thickness</span>
              <span className="text-[10px] font-mono text-cyan-300 shrink-0">
                {gridLineThickness}×
                {gridThicknessAdaptive && effectiveGridLineThickness != null && (
                  <span className="text-slate-500"> → {Math.round(effectiveGridLineThickness * 100) / 100}×</span>
                )}
              </span>
            </div>
            <input
              type="range"
              min={0.25}
              max={10}
              step={0.25}
              value={gridLineThickness}
              onChange={(e) => onGridLineThicknessChange(Number(e.target.value))}
              className="w-full accent-cyan-400 cursor-pointer"
              data-testid="viz-grid-thickness"
            />
            {onGridThicknessAdaptiveChange && (
              <div className="mt-1.5">
                <Checkbox
                  label="Adapt to zoom"
                  color="#22d3ee"
                  checked={gridThicknessAdaptive}
                  onChange={onGridThicknessAdaptiveChange}
                  title="When on (default), the thickness above rides the zoom: hairline lines when the whole song is fitted, thicker as you zoom into a few bars. When off, the slider's value is used as-is at every zoom."
                />
              </div>
            )}
          </div>
        </DropdownGroup>
      </Column>

      {/* ── Detected single-value info (Key / Language) ──────────────
           Always-visible read-only pills. These detectors produce one value
           for the whole track, so they don't get a timeline overlay row. ── */}
      {singleInfoDetections && singleInfoDetections.length > 0 && !compact && (
        <>
        <span className="tc-viz-rule tc-viz-drop w-px bg-white/[0.18]" aria-hidden="true" />
        <Column label="Detected">
          <div className="flex items-center gap-1.5 flex-wrap max-w-[260px]">
            {singleInfoDetections.map((d) => {
              const c = d.color ?? '#94a3b8';
              return (
                <span
                  key={d.id}
                  className="inline-flex items-center gap-1.5 h-[26px] px-2 rounded border bg-white/[0.04]"
                  style={{ borderColor: `${c}55` }}
                  title={`${d.label}: ${d.value}`}
                >
                  <span className="text-[9px] uppercase tracking-wider font-semibold" style={{ color: c }}>{d.label}</span>
                  <span className="text-[11px] font-mono text-slate-100 truncate max-w-[120px]">{d.value}</span>
                </span>
              );
            })}
          </div>
        </Column>
        </>
      )}
    </div>
  );
}
