/**
 * Marker **Actions** panel — one bordered box gathering every edit verb scoped
 * to the active annotation type. Rendered directly below the MarkerConfigPanel
 * (Info) strip in the Annotate sidebar. Unlike the old single-strip layout,
 * nothing hides behind a "⋯ More" toggle: all buttons show inline.
 *
 *   ┌──────────────────────────────────────────┐
 *   │ [↶][↷][✂][▶|][|◀][+][⚡][≡][⊞][✕] │  one row
 *   └──────────────────────────────────────────┘
 *
 * Every edit verb sits on ONE non-wrapping row, each button `flex-1` so they
 * split the available width evenly. Buttons are icon-only (the full label is in
 * each button's `title` tooltip) so the row fits regardless of how many verbs
 * the active type exposes. Import / Export are NOT here — they live in the
 * Marker **info** panel's timer row (see MarkerConfigPanel). The add / fill /
 * add-layer slots arrive as `ReactNode` because the page builds them from its
 * own state (AnnotationAddPanel, the Manual-only fill buttons, and the unified
 * + Add layer button); each slot's root is itself `flex-1`. The discrete
 * buttons reuse the shared building blocks from AnnotationToolbar.
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
  /** Manual-boundaries setup buttons (⚡ Fill defaults · ≡ Choose structure). */
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
      {/* Every edit verb shares one non-wrapping row, each button flexing to an
          equal width. Buttons are icon-only (hover for the full label) so all
          types fit on a single line regardless of how many verbs apply. No
          min-w-0 here: each button's min-content stays its floor so a shrunk
          box never spills its glyph over a neighbour. */}
      <div className="flex items-stretch gap-1">
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
        {addSlot}
        {fillSlot}
        {addLayerSlot}
        {showDelete && <DeleteButton onDeleteAll={onDeleteAll} />}
      </div>
    </div>
  );
}
