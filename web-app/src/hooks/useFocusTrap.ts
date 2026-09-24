import { useEffect, type RefObject } from 'react';

/** Everything the browser will focus with Tab, in DOM order. `inert` and
 *  `aria-hidden` subtrees are excluded by the :not() chain plus the closest()
 *  check below — a hidden-but-mounted panel (see ShortcutsHelpPanel) would
 *  otherwise donate stops to the trap. */
const FOCUSABLE = [
  'a[href]', 'button', 'input', 'select', 'textarea',
  '[tabindex]', 'audio[controls]', 'video[controls]', '[contenteditable]',
].map((s) => `${s}:not([disabled]):not([tabindex="-1"])`).join(',');

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) =>
      !el.closest('[inert]') &&
      !el.closest('[aria-hidden="true"]') &&
      el.offsetParent !== null,
  );
}

/**
 * Keeps Tab inside a modal surface while it is open, gives it an initial
 * focus, and hands focus back to whatever opened it on close.
 *
 * Only for surfaces that are genuinely modal — a scrim behind them, nothing
 * else operable. Non-modal popovers must NOT trap: Tab leaving them is the
 * correct behaviour. The Radix-based dialogs already do all of this
 * internally; this is for the hand-rolled ones.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;

    // Remember who had focus so we can give it back — otherwise closing the
    // modal drops focus onto <body> and the next Tab restarts from the top of
    // the page, which on this page is ~180 stops away from where you were.
    const restoreTo = document.activeElement as HTMLElement | null;

    const first = focusableIn(root)[0];
    if (first) first.focus();
    else {
      // Nothing focusable inside — focus the container itself so screen
      // readers announce the dialog and Escape still reaches it.
      root.setAttribute('tabindex', '-1');
      root.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusableIn(root);
      if (items.length === 0) { e.preventDefault(); return; }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === firstEl || !root.contains(current))) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && (current === lastEl || !root.contains(current))) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      // Only restore if focus is still inside (or was lost to body) — if the
      // close handler already moved focus somewhere deliberate, leave it.
      const now = document.activeElement;
      if (restoreTo && restoreTo.isConnected && (now === document.body || root.contains(now))) {
        restoreTo.focus();
      }
    };
  }, [ref, active]);
}
