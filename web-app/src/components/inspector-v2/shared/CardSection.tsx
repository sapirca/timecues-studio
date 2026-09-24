/**
 * Compact collapsible section for the annotation edit cards.
 *
 * The cards had grown to the point where every kind-specific block
 * (prominence, sub-beat grid, riff sequence) stacked on top of the label /
 * time / description rows in one long unlabelled column — a tall, noisy
 * popover where nothing was named and nothing could be put away. This is the
 * one grouping primitive every card body uses: a ▸ toggle + title on the
 * left, an at-a-glance summary on the right, and a body that folds away.
 *
 * Sibling of `StepSection`, which does the same job for the Song-setup
 * panel — that one is a numbered step in a walkthrough, with a badge and a
 * done state. This one matches the cards' own
 * 9px-uppercase field-label scale so a section header reads as a peer of the
 * "Label" / "Description" captions next to it, not as a heading pasted in
 * from another screen.
 *
 * Open/closed state persists per section id (NOT per card), so folding
 * Prominence away once folds it away on every kind that has one — the point
 * is to stop seeing a block you don't use, and that preference isn't
 * per-annotation.
 *
 * The body stays mounted while collapsed — just visually hidden — so drafts,
 * effects and live playback state (a nested Tap Along session, the riff
 * sequence's auto-expand) survive a fold.
 */

import { useCallback, useSyncExternalStore, type ReactNode } from 'react';

export interface CardSectionSpec {
  /** Stable id — also the localStorage key for the open/closed preference.
   *  Shared across kinds on purpose (see the note above). */
  id: string;
  title: string;
  /** At-a-glance content shown at the right of the header, so a folded
   *  section still says what's inside it ("Lead → Backing", "3 entries").
   *  Sits outside the toggle button; keep it non-interactive. */
  summary?: ReactNode;
  defaultOpen?: boolean;
  content: ReactNode;
}

const storageKey = (id: string) => `tc.cardSection.${id}`;

function loadOpen(id: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(storageKey(id));
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch { /* private mode / quota — fall through to the default */ }
  return fallback;
}

/**
 * Open/closed lives in a module store rather than in each CardSection's own
 * `useState`, because the preference is shared by id across every card AND
 * read from outside the cards entirely: the timeline decides whether to open
 * an item's prominence strip by asking whether the Prominence section is
 * expanded (see InspectorPageV2). A section's fold is the user's statement of
 * which editor they want; one place has to own it.
 */
const openState = new Map<string, boolean>();
const listeners = new Map<string, Set<() => void>>();

function readOpen(id: string, fallback: boolean): boolean {
  let v = openState.get(id);
  if (v === undefined) {
    v = loadOpen(id, fallback);
    openState.set(id, v);
  }
  return v;
}

export function setCardSectionOpen(id: string, open: boolean): void {
  if (openState.get(id) === open) return;
  openState.set(id, open);
  try { window.localStorage.setItem(storageKey(id), open ? '1' : '0'); } catch { /* ignore quota */ }
  listeners.get(id)?.forEach((fn) => fn());
}

/** Subscribe to one section's fold state — inside a card or anywhere else. */
export function useCardSectionOpen(id: string, defaultOpen = true): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    let set = listeners.get(id);
    if (!set) { set = new Set(); listeners.set(id, set); }
    set.add(onChange);
    return () => { set!.delete(onChange); };
  }, [id]);
  const get = useCallback(() => readOpen(id, defaultOpen), [id, defaultOpen]);
  return useSyncExternalStore(subscribe, get, get);
}

export function CardSection({ id, title, summary, defaultOpen = true, content }: CardSectionSpec) {
  const open = useCardSectionOpen(id, defaultOpen);
  const toggle = () => setCardSectionOpen(id, !open);

  return (
    // A hairline above each section (bar the first) is what makes the folded
    // stack read as a list of drawers rather than a run of loose captions.
    <div className="border-t border-white/[0.05] pt-1.5 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="group flex min-w-0 items-center gap-1.5 py-0.5 text-left"
        >
          <span
            className={`inline-block w-2 shrink-0 text-[9px] leading-none text-slate-500 transition-transform duration-150 group-hover:text-slate-300 ${open ? 'rotate-90' : ''}`}
            aria-hidden="true"
          >
            ▸
          </span>
          <span className="text-[9px] uppercase tracking-wider text-slate-300 group-hover:text-slate-100">
            {title}
          </span>
        </button>
        {summary != null && summary !== false && (
          // Dimmer while expanded: the content below already says it, so the
          // summary shouldn't compete with it — it's there for the folded state.
          <span className={`ml-auto min-w-0 truncate text-[9px] font-mono ${open ? 'text-slate-600' : 'text-slate-400'}`}>
            {summary}
          </span>
        )}
      </div>
      <div className={open ? 'pt-1' : 'hidden'}>{content}</div>
    </div>
  );
}
