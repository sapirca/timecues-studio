import { useEffect, useRef, useState } from 'react';
import { annotatorHeaders } from '../../utils/annotatorHeaders';

interface AnnotatorEntry {
  id: string;
  has: { manual: boolean; autoGuess: boolean };
}

interface Props {
  slug: string;
  /** Current signed-in annotator id (rendered as "Yourself" at the top). */
  currentAnnotatorId: string | null;
  /** `null` = use the current user's annotations. Otherwise the picked id. */
  value: string | null;
  onChange: (next: string | null) => void;
}

function shortId(id: string): string {
  if (id.length <= 22) return id;
  return `${id.slice(0, 11)}…${id.slice(-8)}`;
}

export function ReferenceAnnotatorPicker({ slug, currentAnnotatorId, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<AnnotatorEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!slug) return;
    let alive = true;
    fetch(`/api/annotations/${encodeURIComponent(slug)}/annotators`, {
      headers: annotatorHeaders(),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<AnnotatorEntry[]>;
      })
      .then((rows) => { if (alive) { setEntries(rows); setError(null); } })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [slug]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const others = (entries ?? [])
    .map((e) => e.id)
    .filter((id) => id !== currentAnnotatorId)
    .sort();

  // Hide the picker entirely when there is no one else to compare against.
  if (!error && entries && others.length === 0) return null;

  const activeLabel =
    value === null ? 'Yourself' : shortId(value);

  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-slate-500">Reference from</span>
      <div className="relative" ref={ref}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] transition-colors min-w-[120px] ${
            value === null
              ? 'border-slate-700 bg-slate-900/40 text-slate-300 hover:bg-slate-900/60'
              : 'border-cyan-600 bg-cyan-900/30 text-cyan-200 hover:bg-cyan-900/50'
          }`}
          title={value ?? 'Yourself'}
        >
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
          <div className="absolute z-50 top-full mt-1 left-0 min-w-[180px] rounded border border-gray-700 bg-gray-900 shadow-xl py-1">
            <button
              type="button"
              onClick={() => { onChange(null); setOpen(false); }}
              className={`w-full text-left px-3 py-1 text-[11px] transition-colors ${
                value === null ? 'bg-slate-800 text-slate-100' : 'text-slate-300 hover:bg-gray-800'
              }`}
            >
              Yourself
            </button>
            {error && (
              <div className="px-3 py-1 text-[10px] text-red-400" title={error}>
                Couldn't load other annotators
              </div>
            )}
            {!error && entries === null && (
              <div className="px-3 py-1 text-[10px] text-slate-500">Loading…</div>
            )}
            {others.map((id) => {
              const isActive = value === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => { onChange(id); setOpen(false); }}
                  className={`w-full text-left px-3 py-1 text-[11px] transition-colors ${
                    isActive ? 'bg-cyan-900/40 text-cyan-200' : 'text-slate-300 hover:bg-gray-800'
                  }`}
                  title={id}
                >
                  {shortId(id)}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
