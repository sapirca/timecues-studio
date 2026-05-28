/**
 * Unified source picker that lives below the annotation-type tabs. Replaces
 * the old `Manual | Eye | Auto-guess` sub-chip row under the Boundaries tab
 * and adds the same picker for every other annotation type (cues / spans /
 * loops / patterns).
 *
 * Options:
 *   - `manual`     — user-authored annotations (the existing editor).
 *   - `eye`        — boundaries only, experimental.
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

import { useEffect, useRef, useState } from 'react';

/** Identifier for a single source option. `detector:<name>` is opaque on
 *  purpose — the parent extracts the detector name and looks up the entry in
 *  `customDetectors`. */
export type SourceId = 'manual' | 'eye' | 'autoGuess' | `detector:${string}`;

/** True when the source is a user-authored custom detector. Used to render
 *  the leading `{}` glyph that distinguishes detector entries from built-in
 *  Manual / Eye / Auto-guess sources. Text color stays regular so the row
 *  reads like any other option; only the glyph is themed. */
function isDetectorSource(id: SourceId): boolean {
  return typeof id === 'string' && id.startsWith('detector:');
}

/** Annotation categories that get a picker. Boundaries handle Eye + AutoGuess
 *  (real clustering); the others get AutoGuess as a "coming soon" stub. */
export type AnnotationCategory = 'boundaries' | 'cues' | 'spans' | 'loops' | 'patterns';

export interface SourceOption {
  id: SourceId;
  label: string;
  /** False renders the option grey and non-interactive (used for AutoGuess on
   *  non-boundary types until algorithms ship). */
  comingSoon?: boolean;
  /** Dashed-border styling — currently only for Eye when experimental flag is
   *  on, so the experimental status is visually obvious from the picker. */
  experimental?: boolean;
  /** Detector entry has a per-annotator edited output file on disk — render
   *  a small dot next to the label so the user knows there's pending work. */
  inProgress?: boolean;
}

interface Props {
  category: AnnotationCategory;
  value: SourceId;
  onChange: (next: SourceId) => void;
  options: SourceOption[];
}

export function AnnotationSourcePicker({ category, value, onChange, options }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const activeOption = options.find((o) => o.id === value) ?? options[0];
  const activeLabel = activeOption?.label ?? 'Manual';
  const activeIsExperimental = !!activeOption?.experimental;
  const activeIsDetector = !!activeOption && isDetectorSource(activeOption.id);

  return (
    <div className="relative" ref={ref}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={`Select source for ${category}`}
          title={activeIsDetector ? 'Custom Python detector' : undefined}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] transition-colors min-w-[140px] ${
            activeIsExperimental
              ? 'border border-fuchsia-400/40 bg-fuchsia-500/10 text-fuchsia-200 hover:bg-fuchsia-500/20'
              : 'border border-cyan-400/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20'
          }`}
        >
          {activeIsDetector && (
            <span className="font-mono text-amber-300 dark:text-amber-300 text-[10px] leading-none">{'{}'}</span>
          )}
          <span className="flex-1 text-left truncate">{activeLabel}</span>
          <svg
            className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`}
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
            {options.map((opt) => {
              const isActive = opt.id === value;
              const disabled = !!opt.comingSoon;
              const isDetector = isDetectorSource(opt.id);
              return (
                <button
                  key={opt.id}
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
              );
            })}
          </div>
        )}
    </div>
  );
}
