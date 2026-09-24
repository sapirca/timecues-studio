import { useCallback, useEffect, useRef, useState, type RefObject, type CSSProperties } from 'react';
import { closeOtherPopovers, registerOpenPopover } from './shared/useAnnotationPopover';

const POP_W = 300;
const POP_H = 360;
const MARGIN = 12;

export interface SectionAnchor { x: number; y: number; }

export interface UseSectionEditPopoverOptions {
  /** Imperative handle for the parent to open/close the popover. */
  openEditorRef?: RefObject<((idx: number | null, anchor?: SectionAnchor) => void) | null>;
  /** Called whenever the popover closes (outside click, Done, Delete). Use this to sort/autosave. */
  onClose?: () => void;
}

/**
 * Floating section-edit popover state machine.
 * - Tracks editingIdx + click anchor for positioning.
 * - Exposes a popoverRef for outside-click detection (auto-wired).
 * - Exposes a positionStyle that anchors near the click point with viewport clamping,
 *   falling back to centered when no anchor is provided.
 * - Shares the annotation popovers' single-popover exclusivity registry, so
 *   opening a section card closes any open annotation card and vice versa.
 */
export function useSectionEditPopover(options: UseSectionEditPopoverOptions = {}) {
  const { openEditorRef } = options;
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingAnchor, setEditingAnchor] = useState<SectionAnchor | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const onCloseRef = useRef(options.onClose);
  useEffect(() => { onCloseRef.current = options.onClose; });

  const close = useCallback(() => {
    onCloseRef.current?.();
    setEditingIdx(null);
    setEditingAnchor(null);
  }, []);

  const open = useCallback((idx: number, anchor?: SectionAnchor) => {
    closeOtherPopovers(close);
    setEditingIdx(idx);
    setEditingAnchor(anchor ?? null);
  }, [close]);

  // Join the exclusivity registry for as long as the popover is open.
  useEffect(() => {
    if (editingIdx === null) return;
    return registerOpenPopover(close);
  }, [editingIdx, close]);

  // Imperative handle wiring
  useEffect(() => {
    if (!openEditorRef) return;
    const setter = (idx: number | null, anchor?: SectionAnchor) => {
      if (idx === null) { close(); return; }
      open(idx, anchor);
    };
    openEditorRef.current = setter;
    return () => { if (openEditorRef.current === setter) openEditorRef.current = null; };
  }, [openEditorRef, close, open]);

  // Outside-click closes
  useEffect(() => {
    if (editingIdx === null) return;
    const onDown = (e: PointerEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) close();
    };
    // Pointerdown, not mousedown: the timeline cancels its touch pointerdowns,
    // so a tap there never fires a mousedown and would leave this open.
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [editingIdx, close]);

  const positionStyle: CSSProperties = editingAnchor
    ? {
        position: 'fixed',
        left: Math.min(Math.max(MARGIN, editingAnchor.x + 8), (typeof window !== 'undefined' ? window.innerWidth : 1200) - POP_W - MARGIN),
        top:  Math.min(Math.max(MARGIN, editingAnchor.y + 8), (typeof window !== 'undefined' ? window.innerHeight : 800) - POP_H - MARGIN),
      }
    : { position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };

  return { editingIdx, popoverRef, positionStyle, open, close };
}
