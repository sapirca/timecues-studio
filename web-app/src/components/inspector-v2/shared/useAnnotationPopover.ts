/**
 * Generic floating-popover state machine for annotation point cards.
 *
 * Extracted from the four near-identical hooks that used to live in
 * CueEditPopover / SpanEditPopover / LoopEditPopover / PatternEditPopover
 * and the inline popover in EyeEditorPanel.
 *
 * Behaviour:
 *  - `openAt(layerId, itemId, anchor?)` opens the popover positioned near the
 *    click; viewport-clamped, falls back to centered when no anchor is given.
 *  - Outside-click closes; Escape closes.
 *  - Generic over the popover's footprint so per-kind cards can declare their
 *    own width/height for clamping math.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

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

export function useAnnotationPopover(opts: UseAnnotationPopoverOptions = {}) {
  const width = opts.width ?? 340;
  const height = opts.height ?? 290;
  const margin = opts.margin ?? 12;

  const [open, setOpen] = useState<OpenState | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const openAt = useCallback((layerId: string, itemId: string, anchor?: PopoverAnchor) => {
    setOpen({ layerId, itemId, anchor: anchor ?? null });
  }, []);

  const close = useCallback(() => setOpen(null), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  const positionStyle: CSSProperties = open?.anchor
    ? {
        position: 'fixed',
        left: Math.min(
          Math.max(margin, open.anchor.x + 8),
          (typeof window !== 'undefined' ? window.innerWidth : 1200) - width - margin,
        ),
        top: Math.min(
          Math.max(margin, open.anchor.y + 8),
          (typeof window !== 'undefined' ? window.innerHeight : 800) - height - margin,
        ),
      }
    : { position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };

  return { open, popoverRef, positionStyle, openAt, close };
}
