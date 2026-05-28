/**
 * Building blocks for the marker-config panel and the slim section-header
 * export. Each subcomponent (StatusPill, ImportMenu, UndoButton, RedoButton,
 * SplitButton, DeleteButton, SaveIndicator, ExportButton) is exported so the
 * page can compose them inside `MarkerConfigPanel` while keeping Export by
 * itself in the section header.
 *
 * Historical note: this file used to export a single `AnnotationToolbar`
 * wrapper that bundled every control in one horizontal row. The new layout
 * splits those controls between the per-marker panel (everything that
 * configures the active annotation type) and the section header (Export
 * only), so the wrapper is no longer rendered.
 */

import { useEffect, useRef, useState } from 'react';
import { derivePillDisplay, type AnnotationStage } from '../../../types/annotationLayer';
import type { ImportFormat } from './AnnotationPanelController';

const ACCEPT: Record<ImportFormat, string> = {
  json: '.json',
  audacity: '.txt',
  csv: '.csv',
  jams: '.jams,.json',
  lab: '.lab,.txt',
};

const IMPORT_LABEL: Record<ImportFormat, string> = {
  json: '↑ TimeCues JSON',
  audacity: '↑ Audacity (.txt)',
  csv: '↑ Sonic Vis / REAPER (.csv)',
  jams: '↑ JAMS (.jams)',
  lab: '↑ mir_eval (.lab)',
};

/** Workflow pill. Three user-visible states — *Not started* / *In progress* /
 *  *Reviewed* — collapse onto two storage stages (`in_progress` + `reviewed`).
 *  Display is derived symmetrically from `hasItems`: with no items the pill is
 *  always "Not started" (even if the file still says `reviewed` — that flip
 *  back is intentional so deleting every marker resets the workflow), and the
 *  first added section/point/item flips it to "In progress". Only "Reviewed"
 *  is user-selectable; the not-started / in-progress options are disabled in
 *  whichever direction doesn't match the current item count so the user can't
 *  lie about progress. Legacy `ready_for_review` storage values still load —
 *  they display as "In progress" and re-save as `in_progress` on next user
 *  change. Shared across every marker type — single source of truth. */
export function StatusPill({
  status, hasItems, onChange,
}: {
  status: AnnotationStage;
  hasItems: boolean;
  onChange?: (s: AnnotationStage) => void;
}) {
  const displayValue = derivePillDisplay(hasItems, status);
  const disabled = !onChange;
  const tone =
    displayValue === 'reviewed'    ? 'bg-emerald-500/10 border-emerald-400/40 text-emerald-300 focus:ring-emerald-500/40' :
    displayValue === 'in_progress' ? 'bg-amber-500/10 border-amber-400/40 text-amber-300 focus:ring-amber-500/40' :
                                     'bg-slate-500/10 border-slate-400/30 text-slate-400 focus:ring-slate-500/40';
  return (
    <select
      value={displayValue}
      disabled={disabled}
      onChange={(e) => {
        const next = e.target.value as 'not_started' | 'in_progress' | 'reviewed';
        // Map UI → storage: not_started & in_progress collapse to 'in_progress',
        // since "not started" is just "in progress with no items yet" — never
        // a user choice. Reviewed is the only user-selectable storage state.
        onChange?.(next === 'reviewed' ? 'reviewed' : 'in_progress');
      }}
      title={disabled ? 'Read-only annotation type' : 'Annotation workflow status'}
      className={`text-[11px] font-mono rounded px-2.5 py-1 border focus:outline-none focus:ring-1 transition-colors ${
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
      } ${tone}`}
    >
      <option value="not_started" disabled={hasItems}>● Not started</option>
      <option value="in_progress" disabled={!hasItems}>● In progress</option>
      <option value="reviewed"    disabled={!hasItems}>● Reviewed</option>
    </select>
  );
}

export function SaveIndicator({ saveStatus }: { saveStatus: 'idle' | 'saving' | 'saved' | 'error' }) {
  if (saveStatus === 'idle') return null;
  return (
    <span className="text-[10px] font-mono uppercase tracking-wider text-slate-600">
      {saveStatus === 'saving' && 'Saving…'}
      {saveStatus === 'saved'  && <span className="text-emerald-400">✓ Saved</span>}
      {saveStatus === 'error'  && <span className="text-red-400">⚠ Save failed</span>}
    </span>
  );
}

export function UndoButton({ canUndo, onUndo }: { canUndo: boolean; onUndo?: () => void }) {
  return (
    <button
      onClick={onUndo}
      disabled={!canUndo || !onUndo}
      title={canUndo ? 'Undo last edit (⌘Z)' : 'Nothing to undo'}
      className={`flex-1 flex items-center justify-center px-2 py-1 text-[13px] leading-none rounded transition-colors ${
        canUndo && onUndo
          ? 'bg-white/[0.04] hover:bg-white/[0.08] text-slate-300'
          : 'bg-white/[0.02] text-slate-700 cursor-not-allowed'
      }`}
    >↶</button>
  );
}

export function RedoButton({ canRedo, onRedo }: { canRedo: boolean; onRedo?: () => void }) {
  return (
    <button
      onClick={onRedo}
      disabled={!canRedo || !onRedo}
      title={canRedo ? 'Redo (⇧⌘Z)' : 'Nothing to redo'}
      className={`flex-1 flex items-center justify-center px-2 py-1 text-[13px] leading-none rounded transition-colors ${
        canRedo && onRedo
          ? 'bg-white/[0.04] hover:bg-white/[0.08] text-slate-300'
          : 'bg-white/[0.02] text-slate-700 cursor-not-allowed'
      }`}
    >↷</button>
  );
}

export function SplitButton({
  label, canSplit, disabledReason, onSplit,
}: {
  label: string; canSplit: boolean; disabledReason?: string; onSplit?: () => void;
}) {
  return (
    <button
      onClick={onSplit}
      disabled={!canSplit || !onSplit}
      title={canSplit ? `${label} (S)` : (disabledReason ?? 'Split is not available here')}
      className={`flex-1 flex items-center justify-center px-2 py-1 text-[13px] leading-none rounded transition-colors ${
        canSplit && onSplit
          ? 'bg-violet-500/15 hover:bg-violet-500/25 text-violet-200 border border-violet-400/40'
          : 'bg-white/[0.02] text-slate-700 border border-white/[0.04] cursor-not-allowed'
      }`}
    >✂</button>
  );
}

/** Mark In / Mark Out — Rekordbox-style two-step ADD for Spans / Loops /
 *  Patterns. Mark In stashes the playhead as the start of a brand-new item
 *  and draws a flag at that position; Mark Out completes the add with the
 *  current playhead as the end. Distinct from the per-row ⌐ / ¬ chips,
 *  which still snap an existing focused item's boundary. In is green, Out
 *  is red — same color coding as DAW loop markers. Keyboard shortcuts: I
 *  and O. Mark Out is disabled until Mark In has been clicked. */
export function SnapStartButton({
  label, canSnap, onSnap,
}: {
  label: string; canSnap: boolean; onSnap?: () => void;
}) {
  return (
    <button
      onClick={onSnap}
      disabled={!canSnap || !onSnap}
      title={canSnap
        ? `Mark In — stash this as the start of a new item (${label}). Shortcut: I. Click Mark Out next to complete the region.`
        : 'Switch to Spans / Loops / Patterns to use Mark In'}
      className={`flex-1 flex items-center justify-center px-2 py-1 font-mono text-[12px] leading-none rounded border transition-colors ${
        canSnap && onSnap
          ? 'bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 border-emerald-400/50'
          : 'bg-white/[0.02] text-slate-700 border-white/[0.04] cursor-not-allowed'
      }`}
    >▶|</button>
  );
}

export function SnapEndButton({
  label, canSnap, onSnap,
}: {
  label: string; canSnap: boolean; onSnap?: () => void;
}) {
  return (
    <button
      onClick={onSnap}
      disabled={!canSnap || !onSnap}
      title={canSnap
        ? `Mark Out — commit a new item ending at ${label}. Shortcut: O.`
        : 'Click Mark In first to start a new region'}
      className={`flex-1 flex items-center justify-center px-2 py-1 font-mono text-[12px] leading-none rounded border transition-colors ${
        canSnap && onSnap
          ? 'bg-rose-500/15 hover:bg-rose-500/25 text-rose-200 border-rose-400/50'
          : 'bg-white/[0.02] text-slate-700 border-white/[0.04] cursor-not-allowed'
      }`}
    >|◀</button>
  );
}

export function DeleteButton({ onDeleteAll }: { onDeleteAll?: () => void }) {
  return (
    <button
      onClick={onDeleteAll}
      disabled={!onDeleteAll}
      className="flex-1 flex items-center justify-center px-2 py-1 bg-white/[0.04] hover:bg-red-500/15 hover:text-red-300 text-slate-300 text-[13px] leading-none rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white/[0.04] disabled:hover:text-slate-300"
      title="Delete all data for this annotation type on this song"
    >✕</button>
  );
}

export function ExportButton({ onExport, canExport }: { onExport?: () => void; canExport: boolean }) {
  return (
    <button
      onClick={onExport}
      disabled={!canExport || !onExport}
      className={`px-2 py-1 text-[13px] leading-none rounded transition-colors ${
        canExport && onExport
          ? 'bg-white/[0.04] hover:bg-white/[0.08] text-slate-300'
          : 'bg-white/[0.02] text-slate-700 cursor-not-allowed'
      }`}
      title="Export annotations"
    >↓</button>
  );
}

export function ImportMenu({
  formats, onImport,
}: {
  formats: ImportFormat[]; onImport?: (format: ImportFormat, file: File) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  if (formats.length === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="px-2 py-1 bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 text-[13px] leading-none rounded transition-colors"
        title="Import annotations from a file"
      >↑<span className="text-[9px] align-middle">▾</span></button>
      {open && (
        <div className="absolute left-0 mt-1 w-52 rounded-md border border-white/[0.08] bg-[#14171d] shadow-2xl shadow-black/60 z-30 py-1">
          {formats.map((fmt) => (
            <label
              key={fmt}
              className="w-full px-3 py-1.5 text-left text-[11px] text-slate-300 hover:bg-white/[0.04] hover:text-slate-100 cursor-pointer flex transition-colors"
            >
              {IMPORT_LABEL[fmt]}
              <input
                type="file"
                accept={ACCEPT[fmt]}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f && onImport) onImport(fmt, f);
                  e.target.value = '';
                  setOpen(false);
                }}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
