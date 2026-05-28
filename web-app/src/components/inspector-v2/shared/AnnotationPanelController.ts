/**
 * Imperative contract each editor panel exposes via useImperativeHandle so the
 * page-level AnnotationToolbar + AnnotationAddPanel can drive the panel
 * without prop-drilling N action handlers per type.
 *
 * Design: methods are imperative verbs; reactive state (status, capability
 * flags, pending selection) lives in normal React state on the page or panel
 * and is passed to the toolbar as props. The controller intentionally does
 * NOT carry mutable state — that would force the page into useImperativeHandle
 * change-detection patterns. Toolbar disabled-states come from props that
 * track regular React re-renders.
 */

import type { PendingSelection } from '../AnnotationOverlays';

/** Concrete file formats a panel may accept on import. Manual/Eye support the
 *  full set; layer-types support JSON only; Auto-guess supports none. */
export type ImportFormat = 'json' | 'audacity' | 'csv' | 'jams' | 'lab';

/** What a panel can be asked to do. Every verb is optional — panels declare
 *  only what they can handle, and the toolbar hides controls for absent
 *  verbs (or surfaces them as disabled when a capability flag says so). */
export interface AnnotationPanelController {
  // ─── Workflow status ──────────────────────────────────────────────────────
  setStatus?: (stage: import('../../../types/annotationLayer').AnnotationStage) => void;

  // ─── Edit history ─────────────────────────────────────────────────────────
  undo?: () => void;
  redo?: () => void;

  // ─── Split (Manual/Eye: split section at playhead; Spans/Loops/Patterns:
  //     split focused interval at playhead; Cues: not applicable) ───────────
  split?: () => void;

  // ─── Add affordances ──────────────────────────────────────────────────────
  /** Insert a new item/section at the playhead. */
  addAtPlayhead?: () => void;
  /** Insert at the playhead into a specific layer, bypassing the panel's
   *  usual "selected → focused-item → first" fallback. Used by the layer
   *  picker on the AnnotationAddPanel. Layer-typed panels only. */
  addAtPlayheadInLayer?: (layerId: string) => void;
  /** Adopt the page-level pending viz-selection as a new item. */
  confirmPending?: () => void;
  /** Confirm the pending viz-selection into a specific layer. Layer-typed
   *  panels only — Manual/Eye ignore this since they're single-section. */
  confirmPendingInLayer?: (layerId: string) => void;
  /** Create a new empty layer of the panel's type. Layer-typed panels only
   *  (cues/spans/loops/patterns); Manual/Eye/Auto-guess don't carry a
   *  multi-layer model and leave this undefined. Wired to the sidebar's
   *  unified "+ Add layer" button. */
  addLayer?: () => void;
  /** Apply the user's saved default layout (genre preset / custom bars list)
   *  to the current annotation, replacing any existing sections. When no
   *  annotation file exists yet, this bootstraps one. Manual boundaries only. */
  fillDefaults?: () => void;
  /** Open the "Choose structure" modal so the annotator can pick a one-off
   *  layout (genre preset, equal-bar split, or `type:bars` list) without
   *  changing their saved default. Manual boundaries only. */
  chooseStructure?: () => void;

  // ─── File I/O ─────────────────────────────────────────────────────────────
  exportJson?: () => void;
  importJson?: (file: File) => void | Promise<void>;
  importAudacity?: (file: File) => void | Promise<void>;
  importCsv?: (file: File) => void | Promise<void>;
  importJams?: (file: File) => void | Promise<void>;
  importLab?: (file: File) => void | Promise<void>;

  // ─── Destructive ──────────────────────────────────────────────────────────
  /** Wipe the type's data for the current song. For layer types this means
   *  removing every layer of this type; for Manual/Eye this resets the
   *  annotation back to an empty sections list. */
  deleteAll?: () => void;
  /** Single-item delete used by the keyboard shortcut. Each panel picks its
   *  own target — focused item first, otherwise the nearest item to the
   *  playhead within a small tolerance. Distinct from `deleteAll` (which is
   *  always destructive for the entire layer-type slice). */
  deleteFocused?: () => void;

  // ─── Two-step "Mark In / Mark Out" ADD flow (Spans/Loops/Patterns) ────────
  /** Create a brand-new item with the given [start, end] range and focus it.
   *  Used by the two-step Mark In / Mark Out toolbar buttons + I/O hotkeys:
   *  Mark In stashes the start as a pending flag on the viz; Mark Out calls
   *  this with [stashed, currentPlayhead] to commit the new span / loop /
   *  pattern in one go. Layer routing matches the page's "+ Add" logic
   *  (forced override > page-selected > focused-item's > first > fresh). */
  commitItemRange?: (start: number, end: number) => void;

  // ─── Loop-specific verbs (panels other than Loops leave these undefined) ──
  /** Halve the focused loop's length (DJ-style ÷2). */
  halveFocused?: () => void;
  /** Double the focused loop's length (×2). Clamps to song duration. */
  doubleFocused?: () => void;
  /** Toggle seamless loop playback for the focused loop. */
  togglePlayFocused?: () => void;
}

/** Capability + status snapshot the page derives and feeds to the toolbar as
 *  props. The page owns this state — undo controllers, focused-item refs,
 *  save indicators — so it doesn't need to subscribe through the controller. */
export interface AnnotationPanelCapabilities {
  /** Current workflow status; missing → 'in_progress'. */
  status: import('../../../types/annotationLayer').AnnotationStage;
  /** Whether this annotation has any items yet (sections, points, layer items
   *  …). Drives the StatusPill's "Not started" → "In progress" auto-transition
   *  the moment the annotator adds the first item. "Reviewed" stays
   *  user-set — never derived. */
  hasItems: boolean;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';

  // Edit history
  canUndo: boolean;
  canRedo: boolean;

  // Split
  /** When false the Split button is hidden (Cues) or disabled with a tooltip
   *  (intervals with no focused item under the playhead). */
  canSplit: boolean;
  /** When true, render Split as disabled-with-tooltip; when false, hide it. */
  splitVisible: boolean;
  splitDisabledReason?: string;
  /** Display label for the split chip, e.g. "Split at 0:30.0". */
  splitLabel: string;

  // Mark In / Mark Out — two-step "create new item" buttons (Spans/Loops/Patterns)
  /** When true, the Mark In / Mark Out chips render. Cues / Manual / Eye /
   *  Auto-guess leave this false — they have no notion of an interval
   *  boundary to mark. */
  snapBoundaryVisible: boolean;
  /** Mark In is always enabled for layer-typed panels (clicking stashes a
   *  pending start at the playhead). The page passes this through unchanged. */
  canMarkIn: boolean;
  /** Mark Out is enabled only when a pending Mark In has been stashed (i.e.
   *  the page-level pending selection has `t1` set and `t2 === null`). The
   *  page computes this from `pendingAnnotationSelection`; panels just
   *  declare visibility, not gating. */
  canMarkOut: boolean;
  /** Display label for the Mark In chip, e.g. "@ 0:30.0" (current playhead). */
  snapStartLabel: string;
  /** Display label for the Mark Out chip, e.g. "@ 0:30.0" (current playhead). */
  snapEndLabel: string;

  // Add
  canAddAtPlayhead: boolean;
  /** Display label for the inline add chip, e.g. "+ Add @ 0:30.0". */
  addLabel: string;
  /** Whether the active panel supports creating new layers via the sidebar's
   *  unified "+ Add layer" button. True for cues/spans/loops/patterns; false
   *  for boundary sources (which today are single-doc per source). */
  canAddLayer: boolean;
  /** When true, the sidebar renders the "⚡ Fill defaults" / "≡ Choose
   *  structure…" pair below the +Add button. Manual boundaries only; gated
   *  on a known BPM (without one, the bar-based layouts can't be projected
   *  onto song time). */
  canFillDefaults: boolean;
  /** Display label for the ⚡ Fill chip — typically "⚡ Fill defaults" or
   *  "⚡ Fill (N)" when a detector suggestion is available. */
  fillDefaultsLabel: string;
  /** Tooltip describing what the saved default layout currently produces. */
  fillDefaultsTooltip: string;

  // Pending viz selection
  pending: PendingSelection | null;
  /** When true and pending.t2 is null, the confirm pill renders in a
   *  "drag the viz to set a region" disabled state (Spans/Loops/Patterns). */
  pendingRequiresRegion: boolean;

  // Files
  importFormats: ImportFormat[];
  canExport: boolean;

  // Destructive
  canDeleteAll: boolean;
}

/** Build the default capability snapshot. Per-type defaults: nothing
 *  enabled. Panel/page code overrides selectively. */
export function emptyCapabilities(): AnnotationPanelCapabilities {
  return {
    status: 'in_progress',
    hasItems: false,
    saveStatus: 'idle',
    canUndo: false,
    canRedo: false,
    canSplit: false,
    splitVisible: false,
    splitLabel: 'Split',
    snapBoundaryVisible: false,
    canMarkIn: false,
    canMarkOut: false,
    snapStartLabel: 'Mark In',
    snapEndLabel: 'Mark Out',
    canAddAtPlayhead: false,
    addLabel: '+ Add',
    canAddLayer: false,
    canFillDefaults: false,
    fillDefaultsLabel: '⚡ Fill defaults',
    fillDefaultsTooltip: '',
    pending: null,
    pendingRequiresRegion: false,
    importFormats: [],
    canExport: false,
    canDeleteAll: false,
  };
}
