/**
 * Generic floating-popover state machine for annotation point cards.
 *
 * Extracted from the four near-identical hooks that used to live in
 * CueEditPopover / SpanEditPopover / LoopEditPopover / RiffPatternEditPopover
 * and the inline popover in EyeEditorPanel.
 *
 * Behaviour:
 *  - `openAt(layerId, itemId, anchor?)` opens the popover just right of and
 *    below the click; flips to the left of the click when the right side has
 *    no room, viewport-clamped, and falls back to centered with no anchor.
 *  - Outside-click closes; Escape closes.
 *  - Only one popover is open at a time: `openAt` closes every other
 *    registered popover first (see the module-level registry below).
 *  - Generic over the popover's footprint so per-kind cards can declare their
 *    own width/height for clamping math.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

export interface PopoverAnchor { x: number; y: number; }

interface OpenState {
  layerId: string;
  itemId: string;
  anchor: PopoverAnchor | null;
}

export interface UseAnnotationPopoverOptions {
  /** Rough card width — only used for viewport clamping. Default 340. */
  width?: number;
  /** Rough card height — only used for viewport clamping. Default 290. */
  height?: number;
  /** Pixel margin from the viewport edges. Default 12. */
  margin?: number;
}

/**
 * Single-popover exclusivity registry.
 *
 * Every open popover keeps its `close` in here, and `openAt` closes all the
 * others before opening. The outside-click listener below can't carry this on
 * its own: timeline items call `stopPropagation()` on their pointerdown to arm
 * a drag (see `useTimelineDrag`), and React 18 attaches its listeners at the
 * root container — so that pointerdown never reaches the `document` listener,
 * and the already-open card survives the very click that opens the next one.
 *
 * `close` respects each popover's close guard, so a card holding an unsaved
 * Tap Along recording still gets to ask before it goes away.
 */
const openPopovers = new Set<() => void>();

/** Keeps `close` in the exclusivity registry; returns the unregister fn. */
export function registerOpenPopover(close: () => void): () => void {
  openPopovers.add(close);
  return () => { openPopovers.delete(close); };
}

/** Closes every registered popover except `self`. */
export function closeOtherPopovers(self: () => void): void {
  for (const close of [...openPopovers]) {
    if (close !== self) close();
  }
}

export function useAnnotationPopover(opts: UseAnnotationPopoverOptions = {}) {
  const width = opts.width ?? 340;
  const height = opts.height ?? 290;
  const margin = opts.margin ?? 12;

  const [open, setOpen] = useState<OpenState | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Measure the real card footprint so the viewport clamp uses actual size, not
  // a guess — otherwise a taller-than-estimate card (span/loop) clips at the
  // bottom. Re-measures on resize.
  const [measured, setMeasured] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = popoverRef.current;
    if (!open || !el) { setMeasured(null); return; }
    const update = () => setMeasured({ w: el.offsetWidth, h: el.offsetHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  // A card can register a check here (e.g. "is there an unsaved Tap Along
  // recording?") that every close path — Done/× inside the card, outside
  // click, and Escape alike — must pass before the popover actually closes.
  // Kept as a ref (not state) so registering it doesn't itself trigger a
  // render, and so the outside-click/Escape listener below (which only
  // depends on `open`) always reads the latest registered guard.
  const closeGuardRef = useRef<(() => boolean) | null>(null);
  const setCloseGuard = useCallback((fn: (() => boolean) | null) => {
    closeGuardRef.current = fn;
  }, []);

  // Returns whether the popover actually closed: `false` means the guard
  // vetoed it (the user cancelled). Callers that do something destructive on
  // the way out — the cards' Delete button — must close FIRST and bail on
  // `false`, so cancelling the guard's prompt cancels the whole action
  // rather than leaving the item deleted behind a still-open card.
  const close = useCallback((): boolean => {
    if (closeGuardRef.current && !closeGuardRef.current()) return false;
    setOpen(null);
    return true;
  }, []);

  const openAt = useCallback((
    layerId: string,
    itemId: string,
    anchor?: PopoverAnchor,
    /** `nested: true` for a popover opened from *inside* another one (the Node
     *  popup launched from the Riff instance popup) — the parent has to stay
     *  on screen, so skip the exclusivity sweep. */
    opts?: { nested?: boolean },
  ) => {
    if (!opts?.nested) closeOtherPopovers(close);
    setOpen({ layerId, itemId, anchor: anchor ?? null });
  }, [close]);

  // Join the exclusivity registry for as long as this popover is open.
  useEffect(() => {
    if (!open) return;
    return registerOpenPopover(close);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    // Pointerdown rather than mousedown: a tap on a touchscreen whose
    // pointerdown was cancelled (every timeline drag surface does that)
    // never produces a mousedown, so a mousedown listener would leave the
    // card open over whatever the finger just touched.
    const onDown = (e: PointerEvent) => {
      if (!popoverRef.current || popoverRef.current.contains(e.target as Node)) return;
      // A click inside a DIFFERENT floating popover (e.g. opening the Node
      // popup from within the Riff instance popup) isn't "outside" for the
      // purpose of auto-closing THIS one — only a click outside every
      // popover should close it. Each popover root carries the
      // `data-annotation-popover` marker (see AnnotationPointCard /
      // NodeEditPopover) so this check stays generic across kinds.
      if ((e.target as HTMLElement | null)?.closest?.('[data-annotation-popover]')) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const w = measured?.w ?? width;
  const h = measured?.h ?? height;
  // Cap height to the viewport and scroll internally, so a very tall card is
  // always fully on-screen instead of being clipped off the bottom.
  const fit: CSSProperties = { maxHeight: `calc(100vh - ${2 * margin}px)`, overflowY: 'auto' };
  // Just right of the click, just below it. When the card would run off the
  // right edge it FLIPS to the left of the click rather than sliding back
  // over it: these clicks often come from the right-hand sidebar, where a
  // clamped card would bury the very row that opened it. Only flip when the
  // left side actually has room; otherwise clamp, which at least keeps the
  // whole card on screen.
  const flip = open?.anchor ? open.anchor.x + 8 + w > vw - margin && open.anchor.x - 8 - w >= margin : false;
  const positionStyle: CSSProperties = open?.anchor
    ? {
        position: 'fixed',
        left: flip
          ? open.anchor.x - 8 - w
          : Math.min(Math.max(margin, open.anchor.x + 8), vw - w - margin),
        top: Math.min(Math.max(margin, open.anchor.y + 8), vh - h - margin),
        ...fit,
      }
    : { position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', ...fit };

  return { open, popoverRef, positionStyle, openAt, close, setCloseGuard };
}
