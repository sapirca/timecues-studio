/**
 * Position-stable "+ Add" panel rendered below the toolbar. Consolidates the
 * three separate add-flows that today live inside Manual/Eye/Cues/Spans/Loops/
 * Loops editor panels:
 *   1. Pending-selection pill (drag the viz → confirm to adopt as a region)
 *   2. "+ Add @ playhead" inline action (point-style types: Manual/Eye/Cues)
 *
 * Variations across types:
 *   - Boundaries (Manual/Eye) — both modes; pending can be a click (t2 null) OR a drag.
 *   - Cues — playhead-add only; no pending pill.
 *   - Spans/Loops — pending-only and `pendingRequiresRegion = true`,
 *     so a single-click pending (t2 null) renders as a "needs a drag" hint.
 *   - Auto-guess — read-only; this panel renders nothing.
 *
 * Layer picker (cues / spans / loops): when more than one layer
 * exists, both the playhead-add chip and the confirm pill render a ▾ that
 * opens a list of layers. Clicking a layer adds into that specific layer and
 * promotes it to "selected". The label shows the currently-targeted layer's
 * name so the user always sees where the next add will land.
 *
 * Hidden entirely when there is no pending selection and the type has no
 * playhead-add affordance.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PendingSelection } from '../AnnotationOverlays';
import { formatClockTime as fmtTime } from '../../../utils/clockTime';

interface AnnotationAddPanelProps {
  pending: PendingSelection | null;
  /** Region-typed annotations (spans/loops) require a drag, not a
   *  click. When true and pending.t2 is null, the confirm pill becomes a
   *  passive hint. */
  pendingRequiresRegion: boolean;
  /** True while the transport is running under a click-pending (point) pill.
   *  The add then commits at the cursor rather than at the mark — playing on
   *  past a mark and pressing ADD means "the section ends HERE" — so the pill
   *  stops advertising a timestamp it is no longer going to use. */
  pointFollowsPlayhead?: boolean;
  onConfirmPending?: () => void;
  onClearPending?: () => void;
  /** Add-at-playhead config. When omitted the inline "+ Add @ <time>" chip
   *  is hidden (e.g. Spans/Loops which only accept dragged regions). */
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
  /** Riff Patterns only: a second ▾ next to the "+" button that asks what kind
   *  of thing to create (Node / Combo / Instance) instead of the "+" always
   *  defaulting to one kind. Reuses the same dropdown as `layerPicker` — the
   *  two are mutually exclusive per type so there's no visual clash. */
  addKindPicker?: {
    options: { id: string; name: string; color: string }[];
    onPick: (id: string) => void;
  };
  /** Cross-cutting escape hatch for a dragged region: send it to a *different*
   *  annotation type's layer instead of the active tab's own item. Today only
   *  Cues uses this — "Generate Riff Node" from an onset selection, targeting
   *  a riff-patterns layer picked from the same `LayerPickerMenu` used for
   *  in-type layer targeting. Only rendered when a full region (t1 & t2) is
   *  pending; a single click has no duration to seed a node's length with. */
  crossLayerAction?: {
    label: string; // e.g. "→ Riff Node"
    /** Tooltip on the trigger button, e.g. "Generate a riff node from this
     *  selection". Required so a second consumer of this escape hatch can't
     *  accidentally inherit another action's copy. */
    title: string;
    /** Full precomposed Tailwind classes (bg/hover/text) for the trigger +
     *  menu accent. Defaults to the orange treatment Riff Node generation
     *  has always used. */
    accentClassName?: string;
    /** Layer choices, e.g. every riff-patterns layer plus a "+ New layer"
     *  entry appended by the caller. */
    options: { id: string; name: string; color: string }[];
    onPick: (layerId: string) => void;
  };
  /** Opens a popover that computes the dragged region's energy trend on a
   *  stem the user picks, then saves it as a new Span item (for handing off
   *  to an external consumer via the normal Span export flow). Set by the
   *  Spans tab only: a trend is measurable over any dragged range, but what
   *  the popover *saves* is a span in the `energies` lane, and a button that
   *  files its result under someone else's type reads as a bug from inside
   *  the panel that offered it. Receives the triggering click's viewport
   *  position to anchor the popover near it. */
  onExportEnergy?: (anchor: { x: number; y: number }) => void;
  /** Accent color used by the pill border + confirm button — typically the
   *  same color tier the type uses on the canvas (violet for Manual, cyan for
   *  Eye, emerald for Spans, fuchsia for Loops). */
  accent?: 'violet' | 'cyan' | 'emerald' | 'fuchsia';
  /** Short hint rendered to the right of the pill / add chip, e.g.
   *  "Drag the visualization to set a region". Optional. */
  hint?: string;
  /** Caveat rendered inside the pending pill when the active type can't
   *  consume the highlighted region as drawn — Cues are points, so only the
   *  region's start becomes an item. Shown before the add, so the annotator
   *  isn't surprised by what lands. */
  pendingNote?: string;
}

const DEFAULT_CROSS_LAYER_ACCENT = 'bg-orange-500/25 hover:bg-orange-500/35 text-orange-100';

/** Dropdown width. A number rather than `w-48` because the menu is
 *  fixed-positioned and has to be clamped against the viewport by hand. */
const MENU_WIDTH = 192;

const ACCENT_CLASSES = {
  violet:  { pill: 'bg-violet-500/10 border-violet-400/40',  text: 'text-violet-300',  btn: 'bg-violet-500/25 hover:bg-violet-500/35 text-violet-100' },
  cyan:    { pill: 'bg-cyan-500/10 border-cyan-400/40',      text: 'text-cyan-300',    btn: 'bg-cyan-500/25 hover:bg-cyan-500/35 text-cyan-100' },
  emerald: { pill: 'bg-emerald-500/10 border-emerald-400/40', text: 'text-emerald-300', btn: 'bg-emerald-500/25 hover:bg-emerald-500/35 text-emerald-100' },
  fuchsia: { pill: 'bg-fuchsia-500/10 border-fuchsia-400/40', text: 'text-fuchsia-300', btn: 'bg-fuchsia-500/25 hover:bg-fuchsia-500/35 text-fuchsia-100' },
} as const;

/** Inline ▾ button that lists every layer of the active type and lets the
 *  user pick which one to add into. Closes on outside-click / Esc. Shows the
 *  currently selected layer with a check; clicking a row calls `onPick(id)`.
 *
 *  Also doubles as the whole primary "+" control for types where "+" always
 *  has to ask what to create (Riff Patterns) — pass `triggerLabel`/
 *  `triggerClassName`/`wrapperClassName` to restyle the trigger from a small
 *  ▾ caret into the big flex-1 "+" button; the dropdown mechanics (outside
 *  click, Esc, row list) are identical either way. */
function LayerPickerMenu({
  options,
  selectedLayerId,
  onPick,
  accentBtn,
  title,
  triggerLabel = '▾',
  triggerClassName,
  wrapperClassName = 'relative shrink-0',
}: {
  options: { id: string; name: string; color: string }[];
  selectedLayerId: string | null;
  onPick: (id: string) => void;
  accentBtn: string;
  title: string;
  triggerLabel?: string;
  triggerClassName?: string;
  wrapperClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: PointerEvent) => {
      const t = e.target as Node;
      // The menu lives in a portal, so it is NOT inside `ref` — without this
      // second check the outside-click handler would close it on pointerdown and
      // the row's own click would never land.
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    // Pointerdown, not mousedown: the timeline cancels its touch pointerdowns,
    // so a tap there never fires a mousedown and would leave this open.
    window.addEventListener('pointerdown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  // Anchor the portal-rendered menu to the trigger in viewport coords. It used
  // to be `absolute right-0` inside the panel, which the annotate column's own
  // clipping sliced down the middle once the menu grew wider than the trigger.
  useLayoutEffect(() => {
    if (!open) { setMenuPos(null); return; }
    const update = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      const margin = 8;
      // Right-aligned to the trigger, as `right-0` was, then pushed back inside
      // the viewport instead of off its edge.
      const maxLeft = window.innerWidth - MENU_WIDTH - margin;
      const left = Math.min(Math.max(margin, r.right - MENU_WIDTH), Math.max(margin, maxLeft));
      const h = menuRef.current?.offsetHeight ?? 0;
      let top = r.bottom + 4;
      // Flip above the trigger when the list would run off the bottom.
      if (h > 0 && top + h + margin > window.innerHeight) top = Math.max(margin, r.top - h - 4);
      setMenuPos({ top, left });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);
  return (
    <div className={wrapperClassName} ref={ref}>
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        title={title}
        className={triggerClassName ?? `px-1.5 py-1 text-[11px] rounded transition-colors ${accentBtn} border border-transparent`}
      >{triggerLabel}</button>
      {open && createPortal(
        <div
          ref={menuRef}
          // Hidden for the first paint only: the flip-up decision needs the
          // rendered height, so the menu is measured before it is shown.
          style={{ top: menuPos?.top ?? 0, left: menuPos?.left ?? 0, width: MENU_WIDTH, visibility: menuPos ? 'visible' : 'hidden' }}
          className="fixed rounded-md border border-white/[0.08] bg-[#14171d] shadow-2xl shadow-black/60 z-[1000] py-1 max-h-[60vh] overflow-y-auto"
        >
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
        </div>,
        document.body,
      )}
    </div>
  );
}

export function AnnotationAddPanel({
  pending, pendingRequiresRegion,
  pointFollowsPlayhead = false,
  onConfirmPending, onClearPending,
  addAtPlayhead,
  layerPicker,
  addKindPicker,
  crossLayerAction,
  onExportEnergy,
  accent = 'violet',
  hint,
  pendingNote,
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
  // The active layer's name, appended to the playhead-add tooltip so the user
  // can see where the next add will land without opening the dropdown. The
  // confirm pill shows it as a chip on its caption line instead — as a button
  // label it made "+ ADD" as wide as the layer name.
  const targetSuffix = showPicker && selectedLayer ? ` → ${selectedLayer.name}` : '';
  const addBtnLabel = (addAtPlayhead?.label ?? '') + targetSuffix;

  return (
    <div className="flex-1 flex items-stretch gap-1">
      {/* The pending pill is two deliberate lanes, never a ragged wrap:
          a caption line that says WHAT is selected and WHERE the add will
          land, and an action line whose buttons share equal grid columns.
          Letting the readout and the buttons wrap against each other (the
          old flex-wrap) put "+ ADD" and "⚡ ENERGY" on different lines at
          unrelated widths, which read as a broken toolbar. */}
      {showPending && pending && (
        <div className={`flex-1 min-w-0 flex flex-col gap-1 px-2 py-1.5 rounded border ${a.pill}`}>
          {/* Caption lane — read-only. Nothing clickable but the ✕, so the
              time never has to fight a button for the line. */}
          <div className="flex items-center gap-1.5 min-w-0">
            {/* The time is the one thing that must stay legible, so it keeps
                its width and the layer chip beside it truncates instead. */}
            <span
              className={`font-mono text-[10px] whitespace-nowrap shrink-0 ${a.text}`}
              title={pointFollowsPlayhead ? 'Playing — ADD marks the cursor, not the earlier click' : undefined}
            >
              {pendingNote && pending.t2 !== null ? (
                // The type can't use the region as drawn, so show the time it
                // WILL use plus the caveat — a `t1 → t2` readout here would
                // promise a range the add is never going to create.
                <>
                  {`@ ${fmtTime(Math.min(pending.t1, pending.t2))} · `}
                  <span className="text-amber-300/90">{pendingNote}</span>
                </>
              ) : pending.t2 !== null
                ? `${fmtTime(pending.t1)} → ${fmtTime(pending.t2)}`
                : pointFollowsPlayhead
                  ? '@ playhead'
                  : `@ ${fmtTime(pending.t1)}`}
            </span>
            {/* Target layer lives here rather than inside the ADD label. The
                label used to carry "→ <layer name>", which made the button
                as wide as the layer's name and pushed every sibling action
                onto another line. */}
            {showPicker && selectedLayer && (
              <span
                className="flex items-center gap-1 min-w-0 text-[10px] text-slate-400"
                title={`The next add lands in "${selectedLayer.name}"`}
              >
                <span className="text-slate-600">→</span>
                <span
                  className="inline-block w-2 h-2 rounded-sm shrink-0"
                  style={{ background: selectedLayer.color, boxShadow: `0 0 4px ${selectedLayer.color}88` }}
                />
                <span className="truncate">{selectedLayer.name}</span>
              </span>
            )}
            {onClearPending && (
              <button
                onClick={onClearPending}
                className="ml-auto shrink-0 text-slate-500 hover:text-slate-300 transition-colors px-0.5 leading-none"
                title="Clear selection"
              >✕</button>
            )}
          </div>
          {/* Action lane — equal columns, so two or three actions line up
              instead of each sizing to its own label. */}
          {needsRegion ? (
            <span className="text-[10px] text-slate-500 italic">Click Mark Out or drag for a region</span>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(84px,1fr))] gap-1">
              {addKindPicker ? (
                // Riff Patterns: a dragged region still has to ask what kind of
                // thing to create — Node/Combo ignore the range, Instance uses it.
                <LayerPickerMenu
                  options={addKindPicker.options}
                  selectedLayerId={null}
                  onPick={addKindPicker.onPick}
                  accentBtn={a.btn}
                  title="Choose what to add"
                  triggerLabel="+ Add"
                  triggerClassName={`w-full px-1.5 py-1 rounded text-[10px] font-medium uppercase tracking-wider transition-colors ${a.btn} border border-transparent`}
                  wrapperClassName="relative min-w-0"
                />
              ) : (
                onConfirmPending && (
                  // ADD and its layer ▾ are one split control in one column —
                  // the caret belongs to the button it modifies, not to a
                  // column of its own.
                  <div className="flex items-stretch gap-0.5 min-w-0">
                    <button
                      onClick={onConfirmPending}
                      title={showPicker && selectedLayer
                        ? `Adopt as new item in "${selectedLayer.name}" (Enter)`
                        : 'Adopt this selection as a new item (Enter)'}
                      className={`flex-1 min-w-0 px-1.5 py-1 rounded text-[10px] font-medium uppercase tracking-wider transition-colors ${a.btn}`}
                    >+ Add</button>
                    {showPicker && layerPicker?.onConfirmPendingInLayer && (
                      <LayerPickerMenu
                        options={pickerOpts}
                        selectedLayerId={layerPicker.selectedLayerId}
                        onPick={(id) => layerPicker.onConfirmPendingInLayer?.(id)}
                        accentBtn={a.btn}
                        title="Add into a different layer"
                      />
                    )}
                  </div>
                )
              )}
              {crossLayerAction && pending.t2 != null && (
                <LayerPickerMenu
                  options={crossLayerAction.options}
                  selectedLayerId={null}
                  onPick={crossLayerAction.onPick}
                  accentBtn={crossLayerAction.accentClassName ?? DEFAULT_CROSS_LAYER_ACCENT}
                  title={crossLayerAction.title}
                  triggerLabel={crossLayerAction.label}
                  triggerClassName={`w-full truncate px-1.5 py-1 rounded text-[10px] font-medium uppercase tracking-wider transition-colors ${crossLayerAction.accentClassName ?? DEFAULT_CROSS_LAYER_ACCENT} border border-transparent`}
                  wrapperClassName="relative min-w-0"
                />
              )}
              {onExportEnergy && pending.t2 != null && (
                <button
                  onClick={(e) => onExportEnergy({ x: e.clientX, y: e.clientY })}
                  title="Export this selection's energy trend (pick a stem) for use elsewhere"
                  className="w-full truncate px-1.5 py-1 rounded text-[10px] font-medium uppercase tracking-wider transition-colors bg-sky-500/25 hover:bg-sky-500/35 text-sky-100 border border-transparent"
                >
                  ⚡ Energy
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {showAdd && addAtPlayhead && (
        <div className="flex-1 flex items-stretch gap-0.5">
          {addKindPicker && !addAtPlayhead.disabled ? (
            // Riff Patterns: "+" always has to ask what to create, so it IS
            // the picker trigger — no separate quick-add button alongside it.
            <LayerPickerMenu
              options={addKindPicker.options}
              selectedLayerId={null}
              onPick={addKindPicker.onPick}
              accentBtn={a.btn}
              title="Choose what to add"
              triggerLabel="+"
              triggerClassName={`flex-1 flex items-center justify-center px-2 py-1 text-[14px] leading-none rounded transition-colors ${a.btn} border border-transparent`}
              wrapperClassName="relative flex-1"
            />
          ) : (
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
          )}
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
