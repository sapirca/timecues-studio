/**
 * Position-stable "+ Add" panel rendered below the toolbar. Consolidates the
 * three separate add-flows that today live inside Manual/Eye/Cues/Spans/Loops/
 * Patterns editor panels:
 *   1. Pending-selection pill (drag the viz → confirm to adopt as a region)
 *   2. "+ Add @ playhead" inline action (point-style types: Manual/Eye/Cues)
 *
 * Variations across types:
 *   - Boundaries (Manual/Eye) — both modes; pending can be a click (t2 null) OR a drag.
 *   - Cues — playhead-add only; no pending pill.
 *   - Spans/Loops/Patterns — pending-only and `pendingRequiresRegion = true`,
 *     so a single-click pending (t2 null) renders as a "needs a drag" hint.
 *   - Auto-guess — read-only; this panel renders nothing.
 *
 * Layer picker (cues / spans / loops / patterns): when more than one layer
 * exists, both the playhead-add chip and the confirm pill render a ▾ that
 * opens a list of layers. Clicking a layer adds into that specific layer and
 * promotes it to "selected". The label shows the currently-targeted layer's
 * name so the user always sees where the next add will land.
 *
 * Hidden entirely when there is no pending selection and the type has no
 * playhead-add affordance.
 */

import { useEffect, useRef, useState } from 'react';
import type { PendingSelection } from '../AnnotationOverlays';

interface AnnotationAddPanelProps {
  pending: PendingSelection | null;
  /** Region-typed annotations (spans/loops/patterns) require a drag, not a
   *  click. When true and pending.t2 is null, the confirm pill becomes a
   *  passive hint. */
  pendingRequiresRegion: boolean;
  onConfirmPending?: () => void;
  onClearPending?: () => void;
  /** Add-at-playhead config. When omitted the inline "+ Add @ <time>" chip
   *  is hidden (e.g. Spans/Loops/Patterns which only accept dragged regions). */
  addAtPlayhead?: {
    label: string;            // e.g. "+ Add @ 0:30.0"
    onAdd: () => void;
    disabled?: boolean;
    disabledReason?: string;
  };
  /** Layer-picker — when set with two or more options, both the playhead-add
   *  button and the pending-confirm pill grow a ▾ that lets the annotator
   *  pick which layer the next add goes into. Picking a layer immediately
   *  adds into it and promotes it to the active target.
   *
   *  Omit (or pass < 2 options) to hide the picker — single-layer types stay
   *  unchanged. Manual/Eye never set this. */
  layerPicker?: {
    options: { id: string; name: string; color: string }[];
    selectedLayerId: string | null;
    /** Add at playhead, into the given layer. Wired to controller.addAtPlayheadInLayer. */
    onAddAtPlayheadInLayer?: (layerId: string) => void;
    /** Confirm the pending viz-selection into the given layer. Wired to controller.confirmPendingInLayer. */
    onConfirmPendingInLayer?: (layerId: string) => void;
  };
  /** Accent color used by the pill border + confirm button — typically the
   *  same color tier the type uses on the canvas (violet for Manual, cyan for
   *  Eye, emerald for Spans, fuchsia for Loops/Patterns). */
  accent?: 'violet' | 'cyan' | 'emerald' | 'fuchsia';
  /** Short hint rendered to the right of the pill / add chip, e.g.
   *  "Drag the visualization to set a region". Optional. */
  hint?: string;
}

function fmtTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '0:00.0';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

const ACCENT_CLASSES = {
  violet:  { pill: 'bg-violet-500/10 border-violet-400/40',  text: 'text-violet-300',  btn: 'bg-violet-500/25 hover:bg-violet-500/35 text-violet-100' },
  cyan:    { pill: 'bg-cyan-500/10 border-cyan-400/40',      text: 'text-cyan-300',    btn: 'bg-cyan-500/25 hover:bg-cyan-500/35 text-cyan-100' },
  emerald: { pill: 'bg-emerald-500/10 border-emerald-400/40', text: 'text-emerald-300', btn: 'bg-emerald-500/25 hover:bg-emerald-500/35 text-emerald-100' },
  fuchsia: { pill: 'bg-fuchsia-500/10 border-fuchsia-400/40', text: 'text-fuchsia-300', btn: 'bg-fuchsia-500/25 hover:bg-fuchsia-500/35 text-fuchsia-100' },
} as const;

/** Inline ▾ button that lists every layer of the active type and lets the
 *  user pick which one to add into. Closes on outside-click / Esc. Shows the
 *  currently selected layer with a check; clicking a row calls `onPick(id)`. */
function LayerPickerMenu({
  options,
  selectedLayerId,
  onPick,
  accentBtn,
  title,
}: {
  options: { id: string; name: string; color: string }[];
  selectedLayerId: string | null;
  onPick: (id: string) => void;
  accentBtn: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={title}
        className={`px-1.5 py-1 text-[11px] rounded transition-colors ${accentBtn} border border-transparent`}
      >▾</button>
      {open && (
        <div className="absolute right-0 mt-1 w-48 rounded-md border border-white/[0.08] bg-[#14171d] shadow-2xl shadow-black/60 z-30 py-1">
          {options.map((opt) => {
            const isSelected = opt.id === selectedLayerId;
            return (
              <button
                key={opt.id}
                onClick={() => { onPick(opt.id); setOpen(false); }}
                className="w-full px-2.5 py-1.5 text-left text-[11px] text-slate-200 hover:bg-white/[0.06] flex items-center gap-2 transition-colors"
              >
                <span
                  className="inline-block w-2 h-2 rounded-sm shrink-0"
                  style={{ background: opt.color, boxShadow: `0 0 4px ${opt.color}88` }}
                />
                <span className="flex-1 truncate">{opt.name}</span>
                {isSelected && <span className="text-[10px] text-slate-400">●</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function AnnotationAddPanel({
  pending, pendingRequiresRegion,
  onConfirmPending, onClearPending,
  addAtPlayhead,
  layerPicker,
  accent = 'violet',
  hint,
}: AnnotationAddPanelProps) {
  const showPending = pending !== null && (!!onConfirmPending || !!onClearPending);
  const a = ACCENT_CLASSES[accent];
  const needsRegion = pendingRequiresRegion && pending?.t2 == null;
  // When the pill is showing an actionable "+ Add" (drag region, or a click on
  // a point type), the playhead-add button would be a redundant second "Add".
  // Hide it so the user only sees the one that matches their selection.
  const pendingHasActionableAdd = showPending && !needsRegion && !!onConfirmPending;
  const showAdd = !!addAtPlayhead && !pendingHasActionableAdd;
  if (!showPending && !showAdd && !hint) return null;

  const pickerOpts = layerPicker?.options ?? [];
  const showPicker = pickerOpts.length > 1;
  const selectedLayer = pickerOpts.find((o) => o.id === layerPicker?.selectedLayerId) ?? pickerOpts[0] ?? null;
  // Append the active layer's name to the ADD label so the user can see where
  // the next add will land without opening the dropdown.
  const targetSuffix = showPicker && selectedLayer ? ` → ${selectedLayer.name}` : '';
  const addBtnLabel = (addAtPlayhead?.label ?? '') + targetSuffix;

  return (
    <div className="flex-1 flex items-stretch gap-1">
      {showPending && pending && (
        <div className={`flex-1 min-w-0 flex items-center justify-center gap-1.5 px-2 py-1 rounded border ${a.pill}`}>
          <span className={`font-mono text-[10px] truncate ${a.text}`}>
            {pending.t2 !== null
              ? `${fmtTime(pending.t1)} → ${fmtTime(pending.t2)}`
              : `@ ${fmtTime(pending.t1)}`}
          </span>
          {needsRegion ? (
            <span className="text-[10px] text-slate-500 italic">Click Mark Out or drag for a region</span>
          ) : (
            onConfirmPending && (
              <>
                <button
                  onClick={onConfirmPending}
                  title={showPicker && selectedLayer
                    ? `Adopt as new item in "${selectedLayer.name}" (Enter)`
                    : 'Adopt this selection as a new item (Enter)'}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider transition-colors ${a.btn}`}
                >+ Add{targetSuffix}</button>
                {showPicker && layerPicker?.onConfirmPendingInLayer && (
                  <LayerPickerMenu
                    options={pickerOpts}
                    selectedLayerId={layerPicker.selectedLayerId}
                    onPick={(id) => layerPicker.onConfirmPendingInLayer?.(id)}
                    accentBtn={a.btn}
                    title="Add into a different layer"
                  />
                )}
              </>
            )
          )}
          {onClearPending && (
            <button
              onClick={onClearPending}
              className="text-slate-500 hover:text-slate-300 transition-colors px-0.5"
              title="Clear selection"
            >✕</button>
          )}
        </div>
      )}
      {showAdd && addAtPlayhead && (
        <div className="flex-1 flex items-stretch gap-0.5">
          <button
            onClick={addAtPlayhead.onAdd}
            disabled={addAtPlayhead.disabled}
            title={addAtPlayhead.disabled
              ? (addAtPlayhead.disabledReason ?? 'Add is not available right now')
              : `${addBtnLabel} (M)`}
            className={`flex-1 flex items-center justify-center px-2 py-1 text-[14px] leading-none rounded transition-colors ${
              addAtPlayhead.disabled
                ? 'bg-white/[0.02] text-slate-700 border border-white/[0.04] cursor-not-allowed'
                : `${a.btn} border border-transparent`
            }`}
          >+</button>
          {showPicker && !addAtPlayhead.disabled && layerPicker?.onAddAtPlayheadInLayer && (
            <LayerPickerMenu
              options={pickerOpts}
              selectedLayerId={layerPicker.selectedLayerId}
              onPick={(id) => layerPicker.onAddAtPlayheadInLayer?.(id)}
              accentBtn={a.btn}
              title="Add into a different layer"
            />
          )}
        </div>
      )}
      {hint && <span className="text-[10px] text-slate-500">{hint}</span>}
    </div>
  );
}
