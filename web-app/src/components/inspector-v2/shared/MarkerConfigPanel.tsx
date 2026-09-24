/**
 * Marker **Info** panel — the identity/state strip for the active annotation
 * type. Sits at the top of the Annotate sidebar's per-marker controls, above
 * the sibling MarkerActionsPanel that holds every edit button.
 *
 *   ┌────────────────────────────────────────────────────┐
 *   │  BOUNDARIES  ● In progress            ⋯ More        │  title · status · toggle
 *   │  ──────────────────────────────────────────────     │
 *   │  [ Manual ▾ ] ✓ Saved ↻ │ ● Record ↺ 00:42 │ ↑▾ ↓   │  (⋯ More) details
 *   └────────────────────────────────────────────────────┘
 *
 * Two rows, never more. Collapsed the panel is a single line: the active type's
 * title, its workflow status pill, and the ⋯ More toggle. Expanding adds one
 * more line that carries every remaining control — source picker, save
 * indicator and detector Re-run, the Record controls with the elapsed-time
 * readout, Import / Export, and the optional coloring toggle — separated by
 * hairline dividers and wrapping only if the sidebar is too narrow to hold
 * them. The big title names the active marker type and is driven by the page
 * from `activeAnnotationType`, so clicking a type chip in the All-annotations
 * list re-labels this panel. Source, the timer halves and the import/export
 * pair take `ReactNode` slots because their content is built by the page from
 * its own state. The remaining action verbs (Mark In/Out, Undo/Redo, Split,
 * Delete, + Add, Fill defaults, Add layer) live in MarkerActionsPanel.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { AnnotationStage } from '../../../types/annotationLayer';
import { StatusPill, SaveIndicator } from './AnnotationToolbar';

const MORE_STORAGE_KEY = 'tc:annotate-info-more-open';

interface Props {
  /** Active annotation type's display label, e.g. "Boundaries". Re-rendered
   *  when the user clicks a different type chip. */
  typeTitle: string;
  status: AnnotationStage;
  hasItems: boolean;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  /** Source dropdown — the page passes the existing AnnotationSourcePicker. */
  sourceSlot: ReactNode;
  /** Elapsed-time readout — page-owned JSX. Sits next to the Record controls on
   *  the "⋯ More" details row, so the clock is hidden while collapsed. `null`
   *  hides it. */
  timeSlot?: ReactNode;
  /** Record / Stop / Reset controls — page-owned JSX. Tucked into the "⋯ More"
   *  details row alongside the time readout. `null` hides it. */
  timerSlot?: ReactNode;
  /** Import / Export buttons — moved here from the actions panel so the edit
   *  row stays compact. Tucked into the "⋯ More" details row after the record
   *  controls. */
  ioSlot?: ReactNode;
  /** Optional coloring-mode toggle — e.g. "By type / Alternating" for Boundaries.
   *  Rendered at the end of the "⋯ More" details row when provided. */
  coloringSlot?: ReactNode;
  onStatusChange?: (s: AnnotationStage) => void;
  /** Re-run handler shown only when the active source is a custom detector.
   *  Detector outputs are produced by re-running the Python script; the button
   *  shows a confirm dialog when an edited copy-on-write file would be
   *  overwritten (see runDetectorWithConflictCheck in services/detectorOutputs.ts). */
  onRerunDetector?: () => void;
  rerunBusy?: boolean;
}

export function MarkerConfigPanel({
  typeTitle,
  status, hasItems, saveStatus,
  sourceSlot, timeSlot, timerSlot, ioSlot, coloringSlot,
  onStatusChange,
  onRerunDetector, rerunBusy,
}: Props) {
  const isDetectorSource = !!onRerunDetector;

  const [moreOpen, setMoreOpen] = useState<boolean>(() => {
    try { return window.localStorage.getItem(MORE_STORAGE_KEY) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(MORE_STORAGE_KEY, moreOpen ? '1' : '0'); } catch { /* ignore quota */ }
  }, [moreOpen]);

  return (
    <div className="rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2 space-y-2">
      {/* Row 1 — identity + workflow state, always visible. */}
      <div className="flex items-center gap-1">
        <h3
          title={typeTitle}
          className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-[0.04em] text-slate-100"
        >
          {typeTitle}
        </h3>
        <div className="flex-1" />
        <StatusPill status={status} hasItems={hasItems} onChange={onStatusChange} />
        <button
          type="button"
          onClick={() => setMoreOpen((o) => !o)}
          aria-expanded={moreOpen}
          aria-label={moreOpen ? 'Hide extra controls' : 'Show more controls'}
          title={moreOpen ? 'Hide record, import/export, source & save details' : 'Record, Import/Export, source picker, save status, re-run…'}
          className={`shrink-0 px-1 py-1 leading-none rounded text-[13px] transition-colors ${
            moreOpen
              ? 'bg-white/[0.08] text-slate-200'
              : 'bg-white/[0.02] hover:bg-white/[0.06] text-slate-400'
          }`}
        >
          ⋯
        </button>
      </div>
      {/* Row 2 — everything behind ⋯ More on a single wrapping line: source ·
          save · re-run │ record · elapsed │ import · export │ coloring. Hairline
          dividers keep the groups readable when they share the row. */}
      {moreOpen && (
        <div className="flex items-center gap-x-1 gap-y-1.5 flex-wrap pt-1.5 border-t border-white/[0.04]">
          {sourceSlot}
          <SaveIndicator saveStatus={saveStatus} />
          {isDetectorSource && (
            <button
              onClick={onRerunDetector}
              disabled={rerunBusy}
              title="Re-run this detector. If you've already edited its output (✓/✗) on this song, you'll be asked to confirm overwriting your edits."
              className={`px-2.5 py-1 text-[11px] uppercase tracking-wider rounded transition-colors ${
                rerunBusy
                  ? 'bg-white/[0.02] text-slate-700 cursor-wait'
                  : 'bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 border border-amber-400/40'
              }`}
            >{rerunBusy ? '↻ Running…' : '↻ Re-run'}</button>
          )}
          {timerSlot}
          {timeSlot}
          {ioSlot}
          {/* Coloring keeps its own line — it is a labelled pair of chips, far
              too wide to share the row without squeezing the source picker. */}
          {coloringSlot && (
            <div className="basis-full flex items-center gap-1.5 flex-wrap">{coloringSlot}</div>
          )}
        </div>
      )}
    </div>
  );
}
