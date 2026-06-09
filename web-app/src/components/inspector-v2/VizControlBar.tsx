import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { BEAT_GRID_UNIT_OPTIONS, type BeatGridUnit } from './SharedVizPanel';

export interface AlgoOverlayOption {
  id: string;
  label: string;
}

export interface CustomAnnotationOption {
  id: string;     // detector name
  label: string;  // human-facing detector label
  color: string;  // row's distinct strip color
}

export interface CueLayerOption {
  id: string;     // layer uuid
  label: string;  // user-given layer name
  color: string;  // layer color
  visible: boolean;
  count: number;  // number of cues in the layer (rendered as a badge)
}

/** Shared shape for user-created layer toggles (Loops, Spans). Identical to
 *  CueLayerOption — kept as a separate type for documentation clarity. */
export interface InteriorLayerOption {
  id: string;
  label: string;
  color: string;
  visible: boolean;
  count: number;
}

export interface VizControlBarProps {
  /** Hide the entire Annotations dropdown (e.g. data-prep, where the curator
   *  shouldn't be distracted by annotation layers). Defaults to shown. */
  showAnnotations?: boolean;
  // Annotation toggles
  showManual: boolean;      onToggleManual: (v: boolean) => void;
  showEye: boolean;       onToggleEye: (v: boolean) => void;
  /** When false, hide the Eye checkbox entirely (gated by the
   *  `experimentalEyeAnnotation` Settings flag). */
  eyeEnabled?: boolean;
  showAutoGuess: boolean; onToggleAutoGuess: (v: boolean) => void;
  /** Draw section markers on top of 3-Band / Spectrogram. Off lets you see the bar grid clearly. */
  showSignalOverlays?: boolean; onToggleSignalOverlays?: (v: boolean) => void;
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
  gridMode?: 'static' | 'dynamic' | 'manual';
  /** Number of active tempo anchors. Shown inside the status badge for
   *  dynamic / manual modes. */
  anchorCount?: number;
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
  // When on, horizontal trackpad/wheel gestures *anywhere on the page* get
  // redirected to scroll the viz timeline (and the browser swipe-back/forward
  // gesture is suppressed). When off (default), only gestures over the
  // waveform/viz panels are intercepted.
  captureGlobalHScroll: boolean; onToggleCaptureGlobalHScroll: (v: boolean) => void;
  // Beat-grid line width multiplier (Misc dropdown slider). 1 = default;
  // scales bar/beat/sub-beat lines uniformly across every viz row.
  gridLineThickness: number; onGridLineThicknessChange: (v: number) => void;
  // Zoom — controlled by the WaveSurfer player; the toolbar invokes the
  // callbacks and reflects the current state. `zoomFactor` is the player's
  // multiplier relative to fit (1 = fit, 2 = ×2 …). `atMaxZoom` disables `+`.
  zoomFactor?: number;
  atMaxZoom?: boolean;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
  // Algorithm overlays
  algoOptions?: AlgoOverlayOption[];
  selectedAlgos?: Set<string>;
  onToggleAlgo?: (id: string) => void;
  showAlgos?: boolean;
  // Single-value detector outputs (global key, detected language, …). These
  // detectors produce one value for the whole track, not a timeline, so they
  // render as always-visible read-only pills instead of overlay toggles.
  singleInfoDetections?: { id: string; label: string; value: string; color?: string }[];
  // Custom detector annotations — appended to the Annotations dropdown so the
  // user can hide individual detector strips from the canvas.
  customAnnotationOptions?: CustomAnnotationOption[];
  hiddenCustomAnnotations?: Set<string>;
  onToggleCustomAnnotation?: (id: string) => void;
  // User-created Cue layers — each appears as a row on the canvas; this
  // dropdown lets the user toggle each layer's visibility.
  cueLayerOptions?: CueLayerOption[];
  onToggleCueLayerVisibility?: (id: string) => void;
  // User-created Span layers (experimental).
  spanLayerOptions?: InteriorLayerOption[];
  onToggleSpanLayerVisibility?: (id: string) => void;
  // User-created Loop layers (experimental).
  loopLayerOptions?: InteriorLayerOption[];
  onToggleLoopLayerVisibility?: (id: string) => void;
  // User-created Pattern layers (experimental).
  patternLayerOptions?: InteriorLayerOption[];
  onTogglePatternLayerVisibility?: (id: string) => void;
}

/** Group heading inside the Annotations popover (Boundaries / Cues / Spans / …).
 *  Adds a thin divider above every group except the first so the popover
 *  reads as discrete sections rather than one long list. */
function GroupHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-slate-300 font-semibold pt-2 mt-1 border-t border-white/[0.12] first:pt-0 first:mt-0 first:border-t-0">
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
 *  across Boundaries / Cues / Spans / Loops / Patterns. */
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
 *  their type group and listed under the "Custom Detectors" section. */
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

function Checkbox({ label, color, checked, onChange, title }: {
  label: string; color: string; checked: boolean; onChange: (v: boolean) => void;
  title?: string;
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
      <span className={`text-[11px] font-mono transition-colors whitespace-nowrap ${checked ? 'text-slate-200' : 'text-slate-600 group-hover:text-slate-400'}`}>
        {label}
      </span>
    </label>
  );
}

/** Wraps a single big-icon control (or a tight cluster of them) and renders
 *  its label below — every control in the bar uses this so heights line up
 *  perfectly. The wrapper is `position: relative` so popovers/menus on the
 *  buttons inside can anchor to the column. */
function Column({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="relative flex flex-col items-center gap-1">
      <div className="flex items-center gap-px">{children}</div>
      <span className="text-[9px] uppercase tracking-wider text-slate-300 font-semibold leading-none">
        {label}
      </span>
    </div>
  );
}

/** A big-icon dropdown trigger (Annotations / Signals / Algos / Misc). Same
 *  40x40 shape as IconButton so heights match; opens its `children` as an
 *  absolutely-positioned popover beneath the column. */
function DropdownGroup({ icon, badge, isOpen, onToggle, children, accent }: {
  icon: React.ReactNode;
  badge?: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  /** Pressed-tint color (badge color + open-state highlight). */
  accent: string;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

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
        className={`relative flex items-center justify-center w-10 h-10 rounded border transition-all cursor-pointer hover:border-white/[0.30] hover:text-slate-100 ${
          isOpen ? '' : 'bg-transparent border-white/[0.18] tc-viz-icon-inactive'
        }`}
      >
        {icon}
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
      {isOpen && createPortal(
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

function beatGridUnitLabel(unit: BeatGridUnit): string {
  // Labels are beat-relative so they stay accurate across time signatures.
  // In 4/4 these line up with classical 1/16, 1/8, 1/4, … note values; in
  // 6/8 (where the BPM counts 8ths) "1/2 beat" really is a 16th note.
  switch (unit) {
    case '32nd':          return '1/8 beat';
    case '16th-triplet':  return '1/6 beat · triplet';
    case '16th':          return '1/4 beat';
    case '8th-triplet':   return '1/3 beat · triplet';
    case '8th':           return '1/2 beat';
    case 'beat':          return 'Beat';
    case 'compound-beat': return 'Compound (×3 beats)';
    case 'bar':           return 'Bar';
    case '2bar':          return '2 Bars';
    case '4bar':          return '4 Bars (Phrase)';
    case '8bar':          return '8 Bars (Block)';
    case '16bar':         return '16 Bars';
  }
}

/** A single big square icon button used by every "always-visible" toggle
 *  in the bar (Grid, Snap, etc.). Heights match the dropdown triggers above
 *  by construction — both are 40x40. Inactive coloring goes through the
 *  `tc-viz-icon-inactive` class so light mode picks up a darker slate. */
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
      className={`flex items-center justify-center w-10 h-10 rounded border transition-all ${
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

/** Renders the inline grid-mode badge. Two-line layout keeps the pill narrow
 *  and matches the height of adjacent icon buttons: first line = mode name +
 *  `GRID`, second line = BPM (or anchor count) + time signature. In manual
 *  mode with overrides, the pinned-beat count is appended inline (amber-
 *  tinted) to the subtitle so the badge stays two lines tall. Returns null
 *  when no mode is active. */
function renderModeBadge(
  gridMode: 'static' | 'dynamic' | 'manual' | undefined,
  anchorCount: number,
  overrideCount: number,
  bpm: number | undefined,
  timeSignature: string | undefined,
  showBeatGrid: boolean,
): React.ReactNode {
  if (!showBeatGrid || !gridMode || !bpm) return null;
  const title = gridMode === 'static'
    ? 'Static GRID'
    : gridMode === 'dynamic'
      ? 'Dynamic GRID'
      : 'Manual GRID';
  const anchorsLabel = `${anchorCount} anchor${anchorCount === 1 ? '' : 's'}`;
  const showPinned = gridMode === 'manual' && overrideCount > 0;
  const cls = gridMode === 'static'
    ? 'border-slate-500/40 bg-slate-500/10 text-slate-300'
    : gridMode === 'dynamic'
      ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300'
      : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300';
  return (
    <span
      className={`flex flex-col items-center justify-center leading-tight px-1.5 py-0.5 rounded text-[10px] font-mono border whitespace-nowrap ${cls}`}
      data-testid="grid-mode-badge"
    >
      <span className="font-medium">{title}</span>
      <span className="text-[9px] opacity-90">
        {gridMode === 'static' ? (
          <>
            {Math.round(bpm)} BPM
            {timeSignature && <> · {timeSignature}</>}
          </>
        ) : (
          <>
            ({anchorsLabel}
            {showPinned && (
              <span className="text-amber-300/90"> · {overrideCount} pinned</span>
            )}
            )
            {timeSignature && <> · {timeSignature}</>}
          </>
        )}
      </span>
    </span>
  );
}

export function VizControlBar({
  showAnnotations = true,
  showManual, onToggleManual,
  showEye, onToggleEye, eyeEnabled = true,
  showAutoGuess, onToggleAutoGuess,
  showSignalOverlays = true, onToggleSignalOverlays,
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
  anchorCount = 0,
  overrideCount = 0,
  bpm,
  beatsPerBar,
  timeSignature,
  snapToGrid, onToggleSnapToGrid, showSnap = true,
  captureGlobalHScroll, onToggleCaptureGlobalHScroll,
  gridLineThickness, onGridLineThicknessChange,
  zoomFactor = 1, atMaxZoom = false, onZoomIn, onZoomOut, onZoomReset,
  algoOptions, selectedAlgos, onToggleAlgo, showAlgos = true,
  singleInfoDetections,
  customAnnotationOptions, hiddenCustomAnnotations, onToggleCustomAnnotation,
  cueLayerOptions, onToggleCueLayerVisibility,
  spanLayerOptions, onToggleSpanLayerVisibility,
  loopLayerOptions, onToggleLoopLayerVisibility,
  patternLayerOptions, onTogglePatternLayerVisibility,
}: VizControlBarProps) {
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Element | null;
      // Dropdown popovers render through a portal (in document.body), so they
      // live outside containerRef — exempt them explicitly or any in-popover
      // click would read as "outside" and close the menu.
      if (target?.closest('[data-viz-dropdown-popover]')) return;
      if (containerRef.current && !containerRef.current.contains(target as Node)) {
        setOpenGroup(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggle = (group: string) => setOpenGroup((prev) => (prev === group ? null : group));

  const visibleCustomAnnotations = (customAnnotationOptions ?? []).filter((o) => !hiddenCustomAnnotations?.has(o.id));
  const visibleCueLayers = (cueLayerOptions ?? []).filter((o) => o.visible);
  const visibleSpanLayers = (spanLayerOptions ?? []).filter((o) => o.visible);
  const visibleLoopLayers = (loopLayerOptions ?? []).filter((o) => o.visible);
  const visiblePatternLayers = (patternLayerOptions ?? []).filter((o) => o.visible);

  // Detectors are collected out of every annotation type and listed together
  // under the "Custom Detectors" section. Boundary detectors arrive as their
  // own prop; the cue/span/loop/pattern ones are layers tagged "(detector)".
  const boundaryDetectors = customAnnotationOptions ?? [];
  const cueDetectors = (cueLayerOptions ?? []).filter(isDetectorLayer);
  const spanDetectors = (spanLayerOptions ?? []).filter(isDetectorLayer);
  const loopDetectors = (loopLayerOptions ?? []).filter(isDetectorLayer);
  const patternDetectors = (patternLayerOptions ?? []).filter(isDetectorLayer);
  const detectorCount = boundaryDetectors.length + cueDetectors.length
    + spanDetectors.length + loopDetectors.length + patternDetectors.length;
  // Flip every detector to `visible` — used by the All / None header controls.
  // Each toggle is idempotent per id and routes through a functional state
  // update upstream, so calling them in a loop is safe.
  const setAllDetectors = (visible: boolean) => {
    boundaryDetectors.forEach((o) => {
      if ((!hiddenCustomAnnotations?.has(o.id)) !== visible) onToggleCustomAnnotation?.(o.id);
    });
    cueDetectors.forEach((o) => { if (o.visible !== visible) onToggleCueLayerVisibility?.(o.id); });
    spanDetectors.forEach((o) => { if (o.visible !== visible) onToggleSpanLayerVisibility?.(o.id); });
    loopDetectors.forEach((o) => { if (o.visible !== visible) onToggleLoopLayerVisibility?.(o.id); });
    patternDetectors.forEach((o) => { if (o.visible !== visible) onTogglePatternLayerVisibility?.(o.id); });
  };
  const annotationsActive = [showManual, eyeEnabled && showEye, showAutoGuess].filter(Boolean).length
    + visibleCustomAnnotations.length
    + visibleCueLayers.length
    + visibleSpanLayers.length
    + visibleLoopLayers.length
    + visiblePatternLayers.length;
  const signalsActive = [showWaveform, showEQ, showSpectrogram, showCepstrogram, showChroma, showTempogram, showSsm, showEnergy, showBrightness, showNovelty, showOnsets, showFlux].filter(Boolean).length;
  const algosActive = selectedAlgos?.size ?? 0;

  // Zoom multiplier == 1 (within fp slack) means WaveSurfer is at "fit" —
  // the − button no-ops there and should look disabled.
  const atFit = Math.abs(zoomFactor - 1) < 1e-3;
  const zoomLabel = atFit
    ? 'fit'
    : `×${zoomFactor < 10 ? zoomFactor.toFixed(1) : Math.round(zoomFactor)}`;
  const gridWarn = showBeatGrid && !bpm;
  const modeBadge = renderModeBadge(gridMode, anchorCount, overrideCount, bpm, timeSignature, showBeatGrid);
  const miscOpen = openGroup === 'misc';

  return (
    <div
      ref={containerRef}
      className="flex flex-wrap items-end gap-3 px-3 py-2 bg-[#14171d]/80 border border-white/[0.14] rounded-md"
    >
      {/* ── Annotations ────────────────────────────────────────────── */}
      {showAnnotations && (
      <Column label="Annotations">
      <DropdownGroup
        icon={AnnotationsIcon}
        accent="#a78bfa"
        badge={annotationsActive > 0 ? String(annotationsActive) : undefined}
        isOpen={openGroup === 'annotations'}
        onToggle={() => toggle('annotations')}
      >
        {/* ── Display ────────────────────────────────────────────────
            Sits above every annotation group because it's a viz toggle
            that affects how ALL annotation types render on the signal
            panels — not another annotation kind. */}
        {onToggleSignalOverlays && (
          <>
            <GroupHeader>Display</GroupHeader>
            <div
              className="rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-1 flex items-start gap-1.5"
              title="Applies to every annotation below. Off lets you see the bar grid clearly on the 3-Band / Spectrogram panels."
            >
              <Checkbox
                label="Overlay all on signals"
                color="#94a3b8"
                checked={showSignalOverlays}
                onChange={onToggleSignalOverlays}
              />
            </div>
          </>
        )}

        {/* ── Boundaries ─────────────────────────────────────────── */}
        <GroupHeader>Boundaries</GroupHeader>
        <Checkbox label="Manual" color="#f59e0b" checked={showManual} onChange={onToggleManual} title="Toggle Manual layer (G)" />
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
        {eyeEnabled && (
          <Checkbox label="Eye" color="#2dd4bf" checked={showEye} onChange={onToggleEye} />
        )}

        {/* ── Cues (user layers only — detectors live under Custom Detectors) ── */}
        {cueLayerOptions && onToggleCueLayerVisibility && (() => {
          const userLayers = cueLayerOptions.filter((l) => !isDetectorLayer(l));
          if (userLayers.length === 0) return null;
          return (
            <>
              <GroupHeader>Cues</GroupHeader>
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
              <GroupHeader>Spans</GroupHeader>
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
              <GroupHeader>Loops</GroupHeader>
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

        {/* ── Patterns (user layers only) ───────────────────────── */}
        {patternLayerOptions && onTogglePatternLayerVisibility && (() => {
          const userLayers = patternLayerOptions.filter((l) => !isDetectorLayer(l));
          if (userLayers.length === 0) return null;
          return (
            <>
              <GroupHeader>Patterns</GroupHeader>
              {userLayers.map((opt) => (
                <LayerRow
                  key={opt.id}
                  label={opt.label}
                  color={opt.color}
                  checked={opt.visible}
                  count={opt.count}
                  onChange={() => onTogglePatternLayerVisibility(opt.id)}
                />
              ))}
            </>
          );
        })()}

        {/* ── Custom Detectors ──────────────────────────────────────
            Every script-defined detector overlay, grouped by the annotation
            type it produces. Pulled out of the type groups above so the
            human-authored layers stay uncluttered. All / None flip the whole
            set at once. */}
        {detectorCount > 0 && (
          <>
            <div className="flex items-center justify-between gap-2 pt-2 mt-1 border-t border-white/[0.12]">
              <span className="text-[10px] uppercase tracking-wider text-slate-300 font-semibold">
                Custom Detectors
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setAllDetectors(true)}
                  title="Show every detector overlay"
                  className="px-1 h-4 rounded text-[9px] font-mono leading-none bg-[#0a0b0d] text-slate-400 border border-white/[0.12] hover:text-slate-200 hover:border-white/[0.22] transition-colors"
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={() => setAllDetectors(false)}
                  title="Hide every detector overlay"
                  className="px-1 h-4 rounded text-[9px] font-mono leading-none bg-[#0a0b0d] text-slate-400 border border-white/[0.12] hover:text-slate-200 hover:border-white/[0.22] transition-colors"
                >
                  None
                </button>
              </div>
            </div>

            {boundaryDetectors.length > 0 && onToggleCustomAnnotation && (
              <>
                <SubGroupHeader>Boundaries</SubGroupHeader>
                {boundaryDetectors.map((opt) => (
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

            {cueDetectors.length > 0 && onToggleCueLayerVisibility && (
              <>
                <SubGroupHeader>Cues</SubGroupHeader>
                {cueDetectors.map((opt) => (
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

            {spanDetectors.length > 0 && onToggleSpanLayerVisibility && (
              <>
                <SubGroupHeader>Spans</SubGroupHeader>
                {spanDetectors.map((opt) => (
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

            {loopDetectors.length > 0 && onToggleLoopLayerVisibility && (
              <>
                <SubGroupHeader>Loops</SubGroupHeader>
                {loopDetectors.map((opt) => (
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

            {patternDetectors.length > 0 && onTogglePatternLayerVisibility && (
              <>
                <SubGroupHeader>Patterns</SubGroupHeader>
                {patternDetectors.map((opt) => (
                  <LayerRow
                    key={opt.id}
                    label={opt.label.replace(/\s*\(detector\)\s*$/, '')}
                    color={opt.color}
                    checked={opt.visible}
                    count={opt.count}
                    onChange={() => onTogglePatternLayerVisibility(opt.id)}
                    leadingIcon={DetectorIcon}
                  />
                ))}
              </>
            )}
          </>
        )}
      </DropdownGroup>
      </Column>
      )}

      {/* ── Signals ────────────────────────────────────────────────── */}
      <Column label="Signals">
      <DropdownGroup
        icon={SignalsIcon}
        accent="#8b5cf6"
        badge={signalsActive > 0 ? String(signalsActive) : undefined}
        isOpen={openGroup === 'signals'}
        onToggle={() => toggle('signals')}
      >
        <Checkbox label="3-Band"      color="#6366f1" checked={showWaveform}    onChange={onToggleWaveform} />
        <Checkbox label="EQ"          color="#60a5fa" checked={showEQ}         onChange={onToggleEQ} />
        <Checkbox label="Spectrogram" color="#8b5cf6" checked={showSpectrogram} onChange={onToggleSpectrogram} />
        <Checkbox label="MFCC"        color="#c084fc" checked={showCepstrogram} onChange={onToggleCepstrogram} />
        <Checkbox label="Chroma"      color="#84cc16" checked={showChroma}      onChange={onToggleChroma} />
        <Checkbox label="Tempogram"   color="#d946ef" checked={showTempogram}   onChange={onToggleTempogram} />
        <Checkbox label="SSM"         color="#f97316" checked={showSsm}         onChange={onToggleSsm} />
        <Checkbox label="Energy"      color="#f59e0b" checked={showEnergy}      onChange={onToggleEnergy} />
        <Checkbox label="Brightness"  color="#22d3ee" checked={showBrightness}  onChange={onToggleBrightness} />
        <Checkbox label="Novelty"     color="#a78bfa" checked={showNovelty}     onChange={onToggleNovelty} />
        <Checkbox label="Onsets"      color="#f472b6" checked={showOnsets}      onChange={onToggleOnsets} />
        <Checkbox label="Spectral Flux" color="#10b981" checked={showFlux}      onChange={onToggleFlux} />
      </DropdownGroup>
      </Column>

      <span className="w-px h-10 bg-white/[0.18] mb-4" aria-hidden="true" />

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
          className={`px-2 h-10 text-[11px] font-mono min-w-[3rem] text-center border border-white/[0.18] transition-colors ${
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

      <span className="w-px h-10 bg-white/[0.18] mb-4" aria-hidden="true" />

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
          className={`h-10 w-auto pl-2 pr-0.5 text-[11px] font-mono rounded border transition-colors focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/50 ${
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
            pressed={snapToGrid}
            onClick={() => onToggleSnapToGrid(!snapToGrid)}
            title="Snap new boundaries / cues to the beat grid"
            dataTestId="viz-snap-toggle"
          />
        </Column>
      )}

      {/* Inline grid status (warning chip when BPM missing, mode badge in prep).
          Stacks into two lines to match the mode-badge layout and keep the
          chip the same height as the adjacent icon buttons. */}
      {gridWarn && (
        <span
          className="flex flex-col items-center justify-center leading-tight px-1.5 py-0.5 rounded text-[10px] font-mono border border-amber-500/50 bg-amber-500/15 text-amber-200 whitespace-nowrap mb-4 self-end"
          data-testid="beat-grid-no-bpm-warning"
        >
          <span className="font-medium"><span aria-hidden="true">⚠ </span>Grid can&apos;t render</span>
          <span className="text-[9px] opacity-90">set a BPM for this song</span>
        </span>
      )}
      {modeBadge && <span className="mb-4 self-end">{modeBadge}</span>}

      {/* ── Misc (extras dropdown — currently just block swipe-back) ─ */}
      <Column label="Misc">
        <DropdownGroup
          icon={MiscIcon}
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
          <div
            className="pt-2 mt-1 border-t border-white/[0.12]"
            title="Scales the width of every beat-grid line (bars, beats, sub-beats) across all rows. 1× is the default."
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-mono text-slate-200">Grid line thickness</span>
              <span className="text-[10px] font-mono text-cyan-300">{gridLineThickness}×</span>
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
          </div>
        </DropdownGroup>
      </Column>

      {/* ── Algos (Inspect only) ─────────────────────────────────── */}
      {showAlgos && algoOptions && onToggleAlgo && selectedAlgos && (
        <>
        <span className="w-px h-10 bg-white/[0.18] mb-4" aria-hidden="true" />
        <Column label="Algos">
        <DropdownGroup
          icon={AlgosIcon}
          accent="#10b981"
          badge={algosActive > 0 ? String(algosActive) : undefined}
          isOpen={openGroup === 'algos'}
          onToggle={() => toggle('algos')}
        >
          {algoOptions.length === 0 ? (
            <p className="text-[10px] text-slate-500 leading-snug px-0.5 py-1 max-w-[180px]">
              No algorithm results for this song yet. Run algorithms from the sidebar to populate this list.
            </p>
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

            const allSelected = algoOptions.every((opt) => selectedAlgos.has(opt.id));

            const renderGroup = (key: GroupKey, label: string) => {
              const items = grouped[key];
              if (items.length === 0) return null;
              const ids = items.map((o) => o.id);
              const groupAllSelected = ids.every((id) => selectedAlgos.has(id));
              const groupHasMultiple = items.length > 1;
              return (
                <div key={key} className="pt-1">
                  <div className="border-t border-white/[0.05] mb-1" />
                  {groupHasMultiple && (
                    <Checkbox
                      label={`Select all ${label}`}
                      color="#10b981"
                      checked={groupAllSelected}
                      onChange={() => setSelected(ids, !groupAllSelected)}
                    />
                  )}
                  {items.map((opt) => (
                    <Checkbox
                      key={opt.id}
                      label={opt.label}
                      color="#10b981"
                      checked={selectedAlgos.has(opt.id)}
                      onChange={() => onToggleAlgo(opt.id)}
                    />
                  ))}
                </div>
              );
            };

            return (
              <>
                <Checkbox
                  label="Select all"
                  color="#10b981"
                  checked={allSelected}
                  onChange={() => setSelected(algoOptions.map((o) => o.id), !allSelected)}
                />
                {renderGroup('ruptures', 'Ruptures')}
                {renderGroup('msaf', 'MSAF')}
                {renderGroup('allin1', 'All-In-One')}
                {renderGroup('custom', 'Custom')}
                {renderGroup('other', 'Other')}
              </>
            );
          })()}
        </DropdownGroup>
        </Column>
        </>
      )}

      {/* ── Detected single-value info (Key / Language) ──────────────
           Always-visible read-only pills. These detectors produce one value
           for the whole track, so they don't get a timeline overlay row. ── */}
      {singleInfoDetections && singleInfoDetections.length > 0 && (
        <>
        <span className="w-px h-10 bg-white/[0.18] mb-4" aria-hidden="true" />
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
