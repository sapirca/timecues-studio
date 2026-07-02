import { useEffect, useRef, useState } from 'react';
import type { BoundarySource } from './shared/tabConfig';

/** The eval-reference dropdown picks among the boundary sources, so it
 *  reuses `BoundarySource` directly. Re-exported under the legacy name for the
 *  files that already import `EvalReferenceMode`. */
export type EvalReferenceMode = BoundarySource;

const LABELS: Record<EvalReferenceMode, string> = {
  manual: 'Boundaries',
  autoGuess: 'Auto-guess',
};

export interface EvalReferenceOption {
  mode: EvalReferenceMode;
  hasData: boolean;
}

interface Props {
  value: EvalReferenceMode;
  onChange: (mode: EvalReferenceMode) => void;
  options: EvalReferenceOption[];
  label?: string;
}

export function EvalReferenceDropdown({ value, onChange, options, label = 'Evaluate vs' }: Props) {
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

  const activeLabel = LABELS[value];

  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-gray-500">{label}</span>
      <div className="relative" ref={ref}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded border border-indigo-600 bg-indigo-900/30 text-indigo-300 text-[11px] hover:bg-indigo-900/50 transition-colors min-w-[88px]"
        >
          <span className="flex-1 text-left">{activeLabel}</span>
          <svg
            className={`w-3 h-3 text-indigo-400 transition-transform ${open ? 'rotate-180' : ''}`}
            viewBox="0 0 10 6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M1 1l4 4 4-4" />
          </svg>
        </button>
        {open && (
          <div className="absolute z-50 top-full mt-1 left-0 min-w-[140px] rounded border border-gray-700 bg-gray-900 shadow-xl py-1">
            {options.map(({ mode, hasData }) => {
              const isActive = mode === value;
              const disabled = !hasData;
              return (
                <button
                  key={mode}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    if (disabled) return;
                    onChange(mode);
                    setOpen(false);
                  }}
                  className={`w-full text-left px-3 py-1 text-[11px] transition-colors ${
                    isActive
                      ? 'bg-indigo-900/40 text-indigo-300'
                      : disabled
                        ? 'text-gray-700 cursor-not-allowed'
                        : 'text-gray-300 hover:bg-gray-800'
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span>{LABELS[mode]}</span>
                    {!hasData && <span className="text-[9px] text-gray-700">no data</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
