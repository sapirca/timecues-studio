import { useCallback, useEffect, useState, type ReactNode } from 'react';

export interface CollapsibleSectionProps {
  title: string;
  children: ReactNode;
  /** localStorage key to persist open/closed state across reloads. Omit to use ephemeral state. */
  storageKey?: string;
  defaultOpen?: boolean;
  /** Optional small label rendered to the right of the title (e.g. status). */
  hint?: ReactNode;
}

function loadOpen(storageKey: string | undefined, fallback: boolean): boolean {
  if (!storageKey) return fallback;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch { /* ignore */ }
  return fallback;
}

export function CollapsibleSection({
  title,
  children,
  storageKey,
  defaultOpen = false,
  hint,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState<boolean>(() => loadOpen(storageKey, defaultOpen));

  useEffect(() => {
    if (!storageKey) return;
    try { window.localStorage.setItem(storageKey, open ? '1' : '0'); } catch { /* ignore quota */ }
  }, [storageKey, open]);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <div className="space-y-2 rounded-lg border border-white/[0.06] bg-white/[0.015] px-3 py-2">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="w-full group flex items-center gap-3 text-left px-1 py-1 rounded transition-colors hover:bg-white/[0.03]"
      >
        <span
          className={`inline-block text-2xl sm:text-3xl leading-none text-slate-500 group-hover:text-slate-300 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
          aria-hidden="true"
        >
          ▸
        </span>
        <span className="text-lg sm:text-xl font-semibold tracking-tight text-slate-100 group-hover:text-white transition-colors">
          {title}
        </span>
        {hint && (
          <span className="ml-2 text-[11px] font-mono text-slate-500 normal-case tracking-normal">
            {hint}
          </span>
        )}
      </button>
      {/* Children stay mounted when collapsed so their effects (data loads,
          state updates that the visualization above depends on) keep running. */}
      <div className={open ? '' : 'hidden'}>
        {children}
      </div>
    </div>
  );
}
