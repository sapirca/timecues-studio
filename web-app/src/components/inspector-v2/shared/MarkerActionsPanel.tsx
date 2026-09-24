/**
 * Marker **Actions** panel — one bordered box gathering every edit verb scoped
 * to the active annotation type. Rendered directly below the MarkerConfigPanel
 * (Info) strip in the Annotate sidebar. Unlike the old single-strip layout,
 * nothing hides behind a "⋯ More" toggle: all buttons show inline.
 *
 *   ┌──────────────────────────────────────────┐
 *   │ [Undo    ][Redo    ][Split   ]             │  edit verbs — even lanes
 *   │ [Mark In ][Mark Out][New layr]             │
 *   │ [Delete a]                                 │
 *   │ [ 1:35.4 → 1:42.0            ✕ ]           │  add / pending slot
 *   │ [ + ADD ▾ ][ ⚡ Energy ]                    │
 *   └──────────────────────────────────────────┘
 *
 * The edit verbs sit in an auto-fit **grid**, not a wrapping flex row. Every
 * button then occupies the same column width on every line, and a verb left
 * alone on the last line keeps that width instead of stretching across the
 * whole panel — which is what made the old `flex-1` row read as a broken
 * layout the moment the verb count wasn't a multiple of the line capacity.
 * The `title` tooltip still carries the longer explanation (and the keyboard
 * shortcut). The **add / pending-selection slot** gets its OWN
 * second row: when the annotator drags a region the pending pill can be wide
 * ("1:35.4 → 1:42.0 + ADD ✕"), and sharing row 1 used to shove the icon
 * buttons off-screen — a dedicated row keeps the verbs put. The row 2 slot
 * renders nothing (no DOM node, so the `gap` collapses) until there is a
 * pending selection or a playhead-add affordance. Import / Export are NOT here
 * — they live in the Marker **info** panel's timer row (see MarkerConfigPanel).
 * The add / fill / add-layer slots arrive as `ReactNode` because the page
 * builds them from its own state (AnnotationAddPanel, the Manual-only fill
 * buttons, and the unified + Add layer button); each slot's root is itself
 * `flex-1`. The discrete buttons reuse the shared building blocks from
 * AnnotationToolbar.
 */
import { type ReactNode } from 'react';
import type { AnnotationPanelCapabilities } from './AnnotationPanelController';
import {
  UndoButton,
  RedoButton,
  SplitButton,
  SnapStartButton,
  SnapEndButton,
  DeleteButton,
} from './AnnotationToolbar';

interface Props extends AnnotationPanelCapabilities {
  onUndo?: () => void;
  onRedo?: () => void;
  onSplit?: () => void;
  /** Mark In — stash the playhead as the start of a brand-new item. */
  onMarkIn?: () => void;
  /** Mark Out — commit a new item with [stashed Mark In, playhead]. */
  onMarkOut?: () => void;
  onDeleteAll?: () => void;
  /** Pending pill + "+ Add @ <time>" — the page's AnnotationAddPanel. */
  addSlot?: ReactNode;
  /** Manual-boundaries setup buttons (✨ Fill defaults · ≡ Choose structure). */
  fillSlot?: ReactNode;
  /** Unified "+ Add layer" button. */
  addLayerSlot?: ReactNode;
}

export function MarkerActionsPanel({
  canUndo, canRedo,
  canSplit, splitVisible, splitDisabledReason, splitLabel,
  snapBoundaryVisible, canMarkIn, canMarkOut, snapStartLabel, snapEndLabel,
  canDeleteAll,
  onUndo, onRedo, onSplit,
  onMarkIn, onMarkOut,
  onDeleteAll,
  addSlot, fillSlot, addLayerSlot,
}: Props) {
  const showDelete = canDeleteAll && !!onDeleteAll;
  const showSnap = snapBoundaryVisible;
  const showSplit = splitVisible;

  return (
    <div className="rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-2">
      <div className="flex flex-col gap-2">
        {/* Row 1 — every edit verb, each button word-labelled ("Undo", "Mark
            In", "New layer"…) rather than a bare glyph, because a glyph row is
            unreadable to anyone who hasn't memorised it. `auto-fit` columns of
            at least 64px give every verb the same lane on every line, so the
            types that expose many (Manual boundaries, Spans with Mark In/Out)
            wrap into a tidy block rather than a ragged one, and a lone verb on
            the last line stays button-sized instead of spanning the panel. */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(64px,1fr))] items-stretch gap-1">
          <UndoButton canUndo={canUndo} onUndo={onUndo} />
          <RedoButton canRedo={canRedo} onRedo={onRedo} />
          {showSplit && (
            <SplitButton
              label={splitLabel}
              canSplit={canSplit}
              disabledReason={splitDisabledReason}
              onSplit={onSplit}
            />
          )}
          {showSnap && (
            <>
              <SnapStartButton label={snapStartLabel} canSnap={canMarkIn} onSnap={onMarkIn} />
              <SnapEndButton label={snapEndLabel} canSnap={canMarkOut} onSnap={onMarkOut} />
            </>
          )}
          {fillSlot}
          {addLayerSlot}
          {showDelete && <DeleteButton onDeleteAll={onDeleteAll} />}
        </div>
        {/* Row 2 — the add / pending-selection slot on its own line so a wide
            pending pill never displaces the edit verbs above. AnnotationAddPanel
            returns null when there is nothing to add, so this row contributes no
            DOM node (and the flex-col gap collapses) until it is needed. */}
        {addSlot}
      </div>
    </div>
  );
}
