import { useCallback, useEffect, useRef, useState, type RefObject, type CSSProperties } from 'react';

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
 */
export function useSectionEditPopover(options: UseSectionEditPopoverOptions = {}) {
  const { openEditorRef } = options;
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingAnchor, setEditingAnchor] = useState<SectionAnchor | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const onCloseRef = useRef(options.onClose);
  useEffect(() => { onCloseRef.current = options.onClose; });

  const open = useCallback((idx: number, anchor?: SectionAnchor) => {
    setEditingIdx(idx);
    setEditingAnchor(anchor ?? null);
  }, []);

  const close = useCallback(() => {
    onCloseRef.current?.();
    setEditingIdx(null);
    setEditingAnchor(null);
  }, []);

  // Imperative handle wiring
  useEffect(() => {
    if (!openEditorRef) return;
    const setter = (idx: number | null, anchor?: SectionAnchor) => {
      if (idx === null) { close(); return; }
      setEditingIdx(idx);
      setEditingAnchor(anchor ?? null);
    };
    openEditorRef.current = setter;
    return () => { if (openEditorRef.current === setter) openEditorRef.current = null; };
  }, [openEditorRef, close]);

  // Outside-click closes
  useEffect(() => {
    if (editingIdx === null) return;
    const onDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
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
