/**
 * Unified source picker that lives below the annotation-type tabs. Replaces
 * the old `Manual | Auto-guess` sub-chip row under the Boundaries tab
 * and adds the same picker for every other annotation type (cues / spans /
 * loops / riff-patterns).
 *
 * Options:
 *   - `manual`     — user-authored annotations (the existing editor).
 *   - `autoGuess`  — clustering of detector outputs. For boundaries this loads
 *                    the existing AutoGuessPanel; for other types it renders a
 *                    "coming soon" banner (no algorithm yet).
 *   - `detector:<name>` — one option per custom detector whose `output_kind`
 *                    matches the active annotation category. Selecting it
 *                    shows the detector's output as a read-only virtual layer
 *                    with ✓/✗/@ Accept-Reject controls; first edit triggers a
 *                    copy-on-write snapshot at
 *                    `data/annotations/detector-outputs/<name>/<annotator>/<slug>.json`.
 *
 * Visual style borrowed from EvalReferenceDropdown — same chevron, hover, and
 * click-outside-to-close behavior, so the two dropdowns feel like one family.
 */

import { Fragment, useEffect, useRef, useState } from 'react';
import { groupByDetectorOrigin } from '../../../utils/detectorOrigin';

/** Identifier for a single source option. `detector:<name>` is opaque on
 *  purpose — the parent extracts the detector name and looks up the entry in
 *  `customDetectors`. */
export type SourceId = 'manual' | 'autoGuess' | `detector:${string}`;

/** True when the source is a user-authored custom detector. Used to render
 *  the leading `{}` glyph that distinguishes detector entries from built-in
 *  Manual / Auto-guess sources. Text color stays regular so the row
 *  reads like any other option; only the glyph is themed. */
function isDetectorSource(id: SourceId): boolean {
  return typeof id === 'string' && id.startsWith('detector:');
}

/** Annotation categories that get a picker. Boundaries handle AutoGuess
 *  (real clustering); the others get AutoGuess as a "coming soon" stub. */
export type AnnotationCategory = 'boundaries' | 'cues' | 'spans' | 'loops' | 'riff-patterns' | 'lyrics';

export interface SourceOption {
  id: SourceId;
  label: string;
  /** False renders the option grey and non-interactive (used for AutoGuess on
   *  non-boundary types until algorithms ship). */
  comingSoon?: boolean;
  /** Distinct styling so an experimental source's status is visually obvious
   *  from the picker. */
  experimental?: boolean;
  /** Detector entry has a per-annotator edited output file on disk — render
   *  a small dot next to the label so the user knows there's pending work. */
  inProgress?: boolean;
  /** Detector options only: shipped (custom-default/) — listed under
   *  "Default", apart from the user's own under "Custom". */
  isDefault?: boolean;
}

interface Props {
  category: AnnotationCategory;
  value: SourceId;
  onChange: (next: SourceId) => void;
  options: SourceOption[];
  /** Narrow-sidebar mode: instead of reserving a fixed 140px the trigger
   *  becomes a flex child that takes whatever the row has left and truncates
   *  its label (full name stays in the tooltip). Used by the Info panel, whose
   *  details row has to fit the source picker, Record, the clock and
   *  import/export on one line inside a ~230px sidebar. */
  compact?: boolean;
}

export function AnnotationSourcePicker({ category, value, onChange, options, compact }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    // Pointerdown, not mousedown: the timeline cancels its touch pointerdowns,
    // so a tap there never fires a mousedown and would leave this open.
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [open]);

  const activeOption = options.find((o) => o.id === value) ?? options[0];
  const activeLabel = activeOption?.label ?? 'Manual';
  const activeIsExperimental = !!activeOption?.experimental;
  const activeIsDetector = !!activeOption && isDetectorSource(activeOption.id);

  return (
    <div className={`relative ${compact ? 'flex-1 min-w-[52px] max-w-[160px]' : ''}`} ref={ref}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={`Select source for ${category}`}
          title={activeIsDetector ? `Custom Python detector — ${activeLabel}` : activeLabel}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] transition-colors ${
            compact ? 'w-full' : 'min-w-[140px]'
          } ${
            activeIsExperimental
              ? 'border border-fuchsia-400/40 bg-fuchsia-500/10 text-fuchsia-200 hover:bg-fuchsia-500/20'
              : 'border border-cyan-400/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20'
          }`}
        >
          {activeIsDetector && (
            <span className="font-mono text-amber-300 dark:text-amber-300 text-[10px] leading-none">{'{}'}</span>
          )}
          <span className="flex-1 min-w-0 text-left truncate">{activeLabel}</span>
          <svg
            className={`w-3 h-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
            viewBox="0 0 10 6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M1 1l4 4 4-4" />
          </svg>
        </button>
        {open && (
          <div className="absolute z-50 top-full mt-1 left-0 min-w-[200px] rounded border border-white/[0.08] bg-slate-900 shadow-xl py-1">
            {[
              ...options.filter((o) => !isDetectorSource(o.id)).map((opt) => ({ opt, header: null as string | null })),
              ...groupByDetectorOrigin(options.filter((o) => isDetectorSource(o.id)), (o) => !!o.isDefault)
                .flatMap((g) => g.items.map((opt, i) => ({ opt, header: i === 0 ? g.title : null }))),
            ].map(({ opt, header }) => {
              const isActive = opt.id === value;
              const disabled = !!opt.comingSoon;
              const isDetector = isDetectorSource(opt.id);
              return (
                <Fragment key={opt.id}>
                {header && (
                  <div className="px-3 pt-2 pb-0.5 text-[9px] uppercase tracking-[0.16em] text-slate-500 border-t border-white/[0.06] mt-1">
                    {header}
                  </div>
                )}
                <button
                  type="button"
                  disabled={disabled}
                  title={
                    opt.comingSoon
                      ? 'No algorithm yet — coming soon'
                      : isDetector
                        ? 'Custom Python detector'
                        : undefined
                  }
                  onClick={() => {
                    if (disabled) return;
                    onChange(opt.id);
                    setOpen(false);
                  }}
                  className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors flex items-center justify-between gap-2 ${
                    isActive
                      ? (opt.experimental
                          ? 'bg-fuchsia-500/15 text-fuchsia-200'
                          : 'bg-cyan-500/15 text-cyan-200')
                      : disabled
                        ? 'text-slate-600 cursor-not-allowed'
                        : (opt.experimental
                            ? 'text-fuchsia-300/70 hover:bg-fuchsia-500/10'
                            : 'text-slate-300 hover:bg-white/[0.04]')
                  }`}
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    {isDetector && (
                      <span className="font-mono text-amber-300 dark:text-amber-300 text-[10px] leading-none shrink-0">{'{}'}</span>
                    )}
                    {opt.inProgress && (
                      <span
                        className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0"
                        title="Edited output in progress"
                      />
                    )}
                    <span className="truncate">{opt.label}</span>
                  </span>
                  {opt.comingSoon ? (
                    <span className="text-[9px] uppercase tracking-wider text-slate-600 shrink-0">soon</span>
                  ) : null}
                </button>
                </Fragment>
              );
            })}
          </div>
        )}
    </div>
  );
}
