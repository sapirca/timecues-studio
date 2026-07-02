import { useEffect, useRef, useState } from 'react';
import type { AnnotationType } from './shared/tabConfig';
import { TAB_CONFIG } from './shared/tabConfig';

/** Top-level "what am I examining" picker for the inspect-song workspace.
 *  Drives both sub-tabs: it selects the annotation kind the Evaluation tab
 *  scores, and it gates the boundaries-only Consensus Inspect tab (which is
 *  hidden whenever the kind is anything other than `boundaries`).
 *
 *  Labels come from TAB_CONFIG so this stays in sync with the annotate-mode
 *  type chips. Renders nothing when only one kind is available (no choice to
 *  make), so the default boundaries-only experience is unchanged. */

const LABELS = Object.fromEntries(TAB_CONFIG.map((t) => [t.id, t.label])) as Record<AnnotationType, string>;

interface Props {
  value: AnnotationType;
  options: AnnotationType[];
  onChange: (kind: AnnotationType) => void;
}

export function InspectKindDropdown({ value, options, onChange }: Props) {
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

  // No choice to offer — collapse to plain context (keeps the default
  // boundaries-only workspace visually unchanged).
  if (options.length <= 1) return null;

  return (
    <div className="flex items-center gap-2 pb-1">
      <span className="text-[11px] text-gray-500">Examine</span>
      <div className="relative" ref={ref}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded border border-indigo-600 bg-indigo-900/30 text-indigo-300 text-[11px] hover:bg-indigo-900/50 transition-colors min-w-[96px]"
        >
          <span className="flex-1 text-left">{LABELS[value]}</span>
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
            {options.map((kind) => {
              const isActive = kind === value;
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() => {
                    onChange(kind);
                    setOpen(false);
                  }}
                  className={`w-full text-left px-3 py-1 text-[11px] transition-colors ${
                    isActive ? 'bg-indigo-900/40 text-indigo-300' : 'text-gray-300 hover:bg-gray-800'
                  }`}
                >
                  {LABELS[kind]}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
