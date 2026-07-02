import { useEffect, useRef } from 'react';

export interface ShortcutDef {
  /** Group label rendered as a section header in the help panel. */
  group: string;
  /** Human-readable key combo, e.g. "M", "Shift + ←", "Ctrl + Z", "?". */
  display: string;
  /** What this shortcut does, shown next to the key combo. */
  description: string;
  /** Returns true if `e` should trigger this shortcut. */
  match: (e: KeyboardEvent) => boolean;
  /** Invoked when match() returns true. Free to call e.preventDefault(). */
  run: (e: KeyboardEvent) => void;
}

interface Options {
  shortcuts: ShortcutDef[];
  /** When true, only the help-toggle (?) and Escape are honoured; other shortcuts pause. */
  isHelpOpen: boolean;
  /** Called for `?` (Shift + /). Toggles the help panel. */
  onToggleHelp: () => void;
  /** Called for Escape while the help panel is open. */
  onCloseHelp: () => void;
}

// Click-only input types — focusing one of these (e.g. the "Block browser
// swipe-back" checkbox in the Misc popover) must NOT swallow global shortcuts
// like Space (play/pause). Deliberately excludes `range`/`radio`: those consume
// Arrow keys, and our Arrow shortcuts preventDefault(), so treating them as
// typing targets keeps focused-slider/radio keyboard nudging intact. Genuine
// text-entry inputs (text, number, search, …) still pause the shortcut layer.
const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox', 'button', 'submit', 'reset', 'color', 'file', 'image',
]);

export function isTypingTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) {
    return !NON_TEXT_INPUT_TYPES.has(target.type);
  }
  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export function useAnnotationShortcuts({ shortcuts, isHelpOpen, onToggleHelp, onCloseHelp }: Options) {
  // Stash latest values in refs so the listener can stay registered once.
  const shortcutsRef = useRef(shortcuts);
  const helpOpenRef = useRef(isHelpOpen);
  const onToggleHelpRef = useRef(onToggleHelp);
  const onCloseHelpRef = useRef(onCloseHelp);

  useEffect(() => { shortcutsRef.current = shortcuts; }, [shortcuts]);
  useEffect(() => { helpOpenRef.current = isHelpOpen; }, [isHelpOpen]);
  useEffect(() => { onToggleHelpRef.current = onToggleHelp; }, [onToggleHelp]);
  useEffect(() => { onCloseHelpRef.current = onCloseHelp; }, [onCloseHelp]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;

      // `?` toggles the help panel from any state.
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        onToggleHelpRef.current();
        return;
      }

      // While help is open, swallow every other shortcut except Escape (close).
      if (helpOpenRef.current) {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCloseHelpRef.current();
        }
        return;
      }

      for (const s of shortcutsRef.current) {
        if (s.match(e)) {
          s.run(e);
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
