import { useEffect, useState, type ReactNode } from 'react';

// Shared title style for every collapsible subsection inside the Song-setup
// panel (Display name / Grid mode / Tempo & grid / Align bar 1). Same font /
// weight / casing as the parent "Song details" section title, just one size
// smaller — so the hierarchy reads cleanly (big section title, slightly
// smaller subtitles indented beneath it). Title-case, NOT uppercase, so it
// matches the parent header rather than looking like a different tier.
export const SUBSECTION_TITLE_CLASS = 'text-base sm:text-lg font-semibold tracking-tight text-slate-100';

function loadOpen(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch { /* ignore */ }
  return fallback;
}

export interface CollapsibleSubsectionProps {
  title: string;
  /** localStorage key persisting open/closed state across reloads. */
  storageKey: string;
  defaultOpen?: boolean;
  /** Right-aligned header content (status readout, Save/Clear, warnings). It
   *  sits outside the toggle button so its own clicks don't fold the section. */
  headerRight?: ReactNode;
  /** Full-width content rendered on its own row directly beneath the title row
   *  (e.g. an "unsaved" status badge) — for status that shouldn't crowd the
   *  Save/Clear buttons in headerRight. Only shows while expanded. */
  headerBelow?: ReactNode;
  children: ReactNode;
}

/** A uniform chevron-collapsible subsection: a ▸ toggle + title on the left,
 *  an optional right-aligned slot, and a body that hides when collapsed. The
 *  body stays mounted (so inputs keep their draft state and any effects keep
 *  running) — it's just visually hidden. */
export function CollapsibleSubsection({
  title,
  storageKey,
  defaultOpen = true,
  headerRight,
  headerBelow,
  children,
}: CollapsibleSubsectionProps) {
  const [open, setOpen] = useState<boolean>(() => loadOpen(storageKey, defaultOpen));
  useEffect(() => {
    try { window.localStorage.setItem(storageKey, open ? '1' : '0'); } catch { /* ignore quota */ }
  }, [storageKey, open]);

  return (
    // Indented inward from the parent section title so the subtitles read as
    // nested beneath it.
    <div className="space-y-2 pl-4">
      <div className="flex items-center gap-2 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="group flex min-w-0 items-center gap-2 text-left"
        >
          <span
            className={`inline-block text-base sm:text-lg leading-none text-slate-500 transition-transform duration-150 group-hover:text-slate-300 ${open ? 'rotate-90' : ''}`}
            aria-hidden="true"
          >
            ▸
          </span>
          <span className={SUBSECTION_TITLE_CLASS}>{title}</span>
        </button>
        {/* Header-right content (Save/Clear, status readouts, warnings, the
            Set-bar-start button) only shows while expanded — a collapsed row
            stays clean: just the chevron + title, nothing trailing. */}
        {open && headerRight && (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{headerRight}</div>
        )}
      </div>
      {/* Status row beneath the title — only when expanded and there's actually
          something relevant to show (the caller guards content to relevant
          state, so a falsy headerBelow renders nothing). */}
      {open && headerBelow && <div className="-mt-1">{headerBelow}</div>}
      <div className={open ? '' : 'hidden'}>{children}</div>
    </div>
  );
}
