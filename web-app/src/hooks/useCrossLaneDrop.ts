/**
 * useCrossLaneDrop — carry items into another lane by dragging them there.
 *
 * Two gestures, decided at pointerdown by what the press carries:
 *
 *  - ONE item (nothing selected, or a press outside the selection). This runs
 *    alongside the row's own time drag, which moves the item along time exactly
 *    as before; the hook only watches where the pointer is vertically.
 *  - A GROUP — the selection: items ⇧/⌘-clicked, or picked with a ⇧/⌘-drag
 *    across the lane's empty space, even when that is a single item. The hook takes
 *    the gesture over (the caller must not start its time drag) and nothing
 *    moves along time at all. A row that has to work out which item a press
 *    means first (Lyrics, where touching words share grips) asks for
 *    `groupOnly` at the press and begins the single-item hand-off once it
 *    knows.
 *
 * Any lane of the same type takes the drop, however far away: holding the
 * pointer near the top or bottom edge scrolls the timeline to bring one in.
 *
 * Either way, while the pointer is over another lane of the same type that lane
 * is marked as the drop target, and letting go there hands the items over at
 * the times they had when the press began — copied, or moved while ⌥ is held.
 * Anywhere else the drop is a plain time move (one item) or nothing (a group).
 *
 * Lanes opt in by carrying `data-drop-lane="<layerId>"`,
 * `data-drop-type="<layer type>"` and `data-drop-name` on their wrapper; only
 * writable lanes carry them. The highlight is a `data-lane-drop-target`
 * attribute set on that element directly, and the label beside the pointer is
 * a plain DOM node — neither re-renders the timeline on every pointermove.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { isSamePointer, isSecondaryPointer, pointerIdOf, type PressEvent } from './useTimelineDrag';

export const DROP_TARGET_ATTR = 'data-lane-drop-target';

/** The click modifier that adds an item to (or takes it out of) the selection
 *  instead of opening its card. */
export function isSelectToggle(e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.shiftKey || e.metaKey || e.ctrlKey;
}

export interface CrossLaneDropOptions {
  /** The lane the items are dragged out of. */
  layerId: string;
  /** Its layer type; only lanes of the same type accept the drop. */
  type: string;
  /** What the label calls one item and several ("word", "words"). */
  noun: readonly [string, string];
  /** Items in this lane that are selected right now. */
  selectedIds: ReadonlySet<string>;
  /** A ⇧/⌘-click on an item. */
  onToggleSelect: (itemId: string) => void;
  /** A ⇧/⌘-drag across the lane's empty space: pick every item starting
   *  inside the stretch. */
  onSelectRange: (t1: number, t2: number) => void;
  /** The ids a press on `itemId` carries when it starts on a selected item,
   *  or null when it carries just this one. */
  groupFor: (itemId: string) => string[] | null;
  /** Those items as they are now, before any time drag moves one. */
  snapshot: (ids: readonly string[]) => { id: string }[];
  /** Why `targetLayerId` can't take these items, or null when it can. */
  reject?: (targetLayerId: string, items: readonly { id: string }[]) => string | null;
  /** Letting go over another lane of the same type. `joinsDrag` is true when a
   *  time drag ran in the same gesture, so the two can share one undo step. */
  onDrop: (
    items: { id: string }[],
    targetLayerId: string,
    opts: { move: boolean; joinsDrag: boolean },
  ) => void;
}

/** The lane element under the pointer of the same type as the source, or null. */
export function laneDropTargetAt(
  clientX: number,
  clientY: number,
  sourceLayerId: string,
  type: string,
): HTMLElement | null {
  const hit = document.elementFromPoint(clientX, clientY);
  const lane = hit instanceof Element ? hit.closest<HTMLElement>('[data-drop-lane]') : null;
  if (!lane) return null;
  if (lane.dataset.dropType !== type || lane.dataset.dropLane === sourceLayerId) return null;
  return lane;
}

/** Pixels the pointer travels before a press counts as a drag. */
const DRAG_THRESHOLD_PX = 4;
/** How close to the top or bottom of the scrolling area the pointer has to be
 *  before the timeline scrolls under it, and the fastest it scrolls there. */
const EDGE_SCROLL_ZONE_PX = 48;
const EDGE_SCROLL_MAX_PX_PER_FRAME = 18;

/** The element that scrolls `el` vertically: its nearest ancestor that can
 *  scroll, else the page. A lane that is out of view is only reachable if the
 *  drag can scroll it in. */
function verticalScroller(el: Element | null): HTMLElement {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/** Pixels to scroll this frame for a pointer at `y`: negative near the top
 *  edge, positive near the bottom, faster the deeper into the zone. */
export function edgeScrollStep(y: number, top: number, bottom: number): number {
  if (y < top + EDGE_SCROLL_ZONE_PX) {
    return -Math.ceil(EDGE_SCROLL_MAX_PX_PER_FRAME * Math.min(1, (top + EDGE_SCROLL_ZONE_PX - y) / EDGE_SCROLL_ZONE_PX));
  }
  if (y > bottom - EDGE_SCROLL_ZONE_PX) {
    return Math.ceil(EDGE_SCROLL_MAX_PX_PER_FRAME * Math.min(1, (y - (bottom - EDGE_SCROLL_ZONE_PX)) / EDGE_SCROLL_ZONE_PX));
  }
  return 0;
}

function makeLabel(): HTMLDivElement {
  const el = document.createElement('div');
  el.setAttribute('role', 'status');
  el.dataset.testid = 'lane-drop-label';
  Object.assign(el.style, {
    position: 'fixed', zIndex: '9999', pointerEvents: 'none', display: 'none',
    padding: '3px 7px', borderRadius: '4px', font: '600 11px/1.3 system-ui, sans-serif',
    color: '#f8fafc', background: 'rgba(15,23,42,0.94)', border: '1px solid rgba(125,211,252,0.7)',
    boxShadow: '0 2px 8px rgba(0,0,0,0.5)', whiteSpace: 'nowrap',
  });
  document.body.appendChild(el);
  return el;
}

export function useCrossLaneDrop(laneDrop: CrossLaneDropOptions | undefined) {
  // Read only from event handlers, so syncing after commit is soon enough.
  const optsRef = useRef(laneDrop);
  useLayoutEffect(() => { optsRef.current = laneDrop; });
  const teardownRef = useRef<(() => void) | null>(null);
  useEffect(() => () => teardownRef.current?.(), []);

  /** Wire to an item's onPointerDown, before the row's own drag. Returns true
   *  when the press carries a group: the hook owns that gesture, and the row
   *  must not start a time drag. With `groupOnly` a plain press is left
   *  entirely to the row. */
  const beginLaneDrop = useCallback((
    itemId: string,
    e: PressEvent,
    { groupOnly = false }: { groupOnly?: boolean } = {},
  ): boolean => {
    const o = optsRef.current;
    if (!o || isSecondaryPointer(e)) return false;
    const picked = o.groupFor(itemId);
    const group = picked !== null;
    if (!group && groupOnly) return false;
    teardownRef.current?.();
    const ids = picked ?? [itemId];
    const items = o.snapshot(ids);
    const count = items.length;
    const noun = count === 1 ? o.noun[0] : o.noun[1];
    const pointerId = pointerIdOf(e);
    const startX = e.clientX;
    const startY = e.clientY;
    if (group) { e.preventDefault(); e.stopPropagation(); }

    let target: HTMLElement | null = null;
    let reason: string | null = null;
    let moved = false;
    let alt = false;
    let x = startX;
    let y = startY;
    // Escape gives up the hand-off for the rest of the gesture; a single
    // item's time move underneath carries on.
    let aborted = false;
    const label = makeLabel();
    const scroller = verticalScroller(e.currentTarget as Element);
    let frame = 0;
    // Edge scrolling waits until the pointer has left the item's own lane: a
    // sideways drag of a band that happens to sit at the window's edge is a
    // move along time, and must not scroll the page out from under it.
    const ownLane = (e.currentTarget as Element).closest<HTMLElement>('[data-drop-lane]');
    let leftOwnLane = !ownLane;

    const render = () => {
      let text: string | null = null;
      if (aborted) text = null;
      else if (target && reason) text = reason;
      else if (target) {
        const name = target.dataset.dropName || 'that lane';
        text = alt
          ? `Move ${count} ${noun} → ${name}`
          : `Copy ${count} ${noun} → ${name} · hold ⌥ to move`;
      } else if (group && moved) text = `${count} ${noun} · drop on another ${o.type} lane`;
      label.style.display = text ? 'block' : 'none';
      if (text) {
        label.textContent = text;
        label.style.left = `${x + 14}px`;
        label.style.top = `${y + 12}px`;
        label.style.borderColor = reason ? 'rgba(248,113,113,0.8)' : 'rgba(125,211,252,0.7)';
      }
    };
    const mark = (next: HTMLElement | null) => {
      if (next !== target) {
        target?.removeAttribute(DROP_TARGET_ATTR);
        target = next;
        reason = next ? o.reject?.(next.dataset.dropLane ?? '', items) ?? null : null;
        if (next && !reason) next.setAttribute(DROP_TARGET_ATTR, '');
      }
      render();
    };
    // While the pointer rests near the top or bottom edge, scroll the timeline
    // a little every frame and look again at what is under the pointer — the
    // lanes move under a pointer that doesn't.
    const edgeScroll = () => {
      frame = 0;
      if (aborted || !moved || !leftOwnLane) return;
      const page = scroller === document.scrollingElement || scroller === document.documentElement;
      const rect = page ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
      const step = edgeScrollStep(y, Math.max(0, rect.top), Math.min(window.innerHeight, rect.bottom));
      if (!step) return;
      const before = scroller.scrollTop;
      scroller.scrollTop = before + step;
      if (scroller.scrollTop === before) return; // already at the end
      mark(laneDropTargetAt(x, y, o.layerId, o.type));
      frame = requestAnimationFrame(edgeScroll);
    };
    const onMove = (ev: PointerEvent) => {
      if (!isSamePointer(pointerId, ev)) return;
      x = ev.clientX; y = ev.clientY; alt = ev.altKey;
      if (!moved && Math.hypot(x - startX, y - startY) > DRAG_THRESHOLD_PX) moved = true;
      if (aborted || !moved) return;
      if (!leftOwnLane && ownLane) {
        const r = ownLane.getBoundingClientRect();
        leftOwnLane = y < r.top || y > r.bottom;
      }
      mark(laneDropTargetAt(x, y, o.layerId, o.type));
      if (!frame) frame = requestAnimationFrame(edgeScroll);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { aborted = true; mark(null); return; }
      if (ev.key === 'Alt') { alt = ev.type === 'keydown'; render(); }
    };
    const finish = (ev: PointerEvent | null) => {
      const landed = ev && target && !reason ? target.dataset.dropLane ?? null : null;
      mark(null);
      teardown();
      // A group press that travelled isn't a click: the browser still sends
      // one to the item, and it would open the card or toggle the selection.
      if (group && moved) {
        const swallow = (c: Event) => { c.stopPropagation(); c.preventDefault(); };
        document.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 0);
      }
      if (landed && ev) o.onDrop(items, landed, { move: ev.altKey, joinsDrag: !group });
    };
    const onUp = (ev: PointerEvent) => { if (isSamePointer(pointerId, ev)) finish(ev); };
    const onCancel = (ev: PointerEvent) => { if (isSamePointer(pointerId, ev)) finish(null); };
    const teardown = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('keyup', onKey);
      label.remove();
      teardownRef.current = null;
    };
    teardownRef.current = teardown;
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onKey);
    return group;
  }, []);

  return { beginLaneDrop };
}
