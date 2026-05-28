/**
 * Marker **Info** panel — the identity/state strip for the active annotation
 * type. Sits at the top of the Annotate sidebar's per-marker controls, above
 * the sibling MarkerActionsPanel that holds every edit button.
 *
 *   ┌──────────────────────────────────────────┐
 *   │  BOUNDARIES              ● In progress  ⋯  │  title + status + ⋯ More
 *   │  ↑▾  ↓            00:42  ▶ Record ↺        │  import/export · timer (right)
 *   │  ── (⋯ More) ──                            │
 *   │  [ Manual ▾ ]   ✓ Saved   ↻ Re-run         │  source · save · re-run
 *   └──────────────────────────────────────────┘
 *
 * Only the high-signal fields show by default — the active type's title, its
 * workflow status, the Import / Export buttons and the (right-aligned)
 * recording timer. The source picker, save indicator and detector Re-run hide
 * behind a "⋯ More" toggle so the panel stays compact. The big title names the
 * active marker type and is driven by the page from `activeAnnotationType`, so
 * clicking a type chip in the All-annotations list re-labels this panel.
 * Source, Time and the import/export pair take `ReactNode` slots because their
 * content is built by the page from its own state. The remaining action verbs
 * (Mark In/Out, Undo/Redo, Split, Delete, + Add, Fill defaults, Add layer)
 * live in MarkerActionsPanel.
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
  /** Recording timer — page-owned JSX. `null` hides it. Right-aligned in its
   *  row. */
  timerSlot?: ReactNode;
  /** Import / Export buttons — moved here from the actions panel so the edit
   *  row stays compact. Sits at the left of the timer row. */
  ioSlot?: ReactNode;
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
  sourceSlot, timerSlot, ioSlot,
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
      <div className="flex items-center gap-2">
        <h3 className="flex-1 min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-100">
          {typeTitle}
        </h3>
        <StatusPill status={status} hasItems={hasItems} onChange={onStatusChange} />
        <button
          type="button"
          onClick={() => setMoreOpen((o) => !o)}
          aria-expanded={moreOpen}
          title={moreOpen ? 'Hide source & save details' : 'Source picker, save status, re-run…'}
          className={`px-2 py-1 rounded text-[11px] transition-colors ${
            moreOpen
              ? 'bg-white/[0.08] text-slate-200'
              : 'bg-white/[0.02] hover:bg-white/[0.06] text-slate-400'
          }`}
        >
          {moreOpen ? '⋯ Less' : '⋯ More'}
        </button>
      </div>
      {(timerSlot || ioSlot) && (
        <div className="flex items-center gap-2">
          {ioSlot && <div className="flex items-center gap-1">{ioSlot}</div>}
          {timerSlot && <div className="ml-auto flex items-center gap-2">{timerSlot}</div>}
        </div>
      )}
      {moreOpen && (
        <div className="flex items-center gap-2 flex-wrap pt-1.5 border-t border-white/[0.04]">
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
        </div>
      )}
    </div>
  );
}
