import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';

export interface ResizableHeightOptions {
  /** localStorage key for the height, e.g. 'tc:playground-output-h'. */
  storageKey: string;
  minHeight: number;
  /** The most of its parent the pane may take, 0..1. */
  maxFraction?: number;
}

function readStored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStored(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* a courtesy */ }
}

/** A pane's height, dragged on the strip along its top edge (persisted per
 *  browser). `height` is null until the first drag, and again after a reset,
 *  so the pane keeps its own CSS size until someone asks for another one.
 *  The vertical sibling of useResizableSidebar — pair it with
 *  HeightResizeHandle and pass `setPane` as the pane's ref. */
export function useResizableHeight<T extends HTMLElement = HTMLDivElement>({ storageKey, minHeight, maxFraction = 0.85 }: ResizableHeightOptions) {
  const [height, setHeight] = useState<number | null>(() => {
    const n = parseInt(readStored(storageKey) ?? '', 10);
    return Number.isFinite(n) && n >= minHeight ? n : null;
  });
  useEffect(() => { writeStored(storageKey, height === null ? null : String(Math.round(height))); }, [storageKey, height]);

  // A callback ref: the pane is measured when a drag starts.
  const [pane, setPane] = useState<T | null>(null);
  const [resizing, setResizing] = useState(false);

  const startResize = (e: ReactMouseEvent) => {
    if (!pane) return;
    e.preventDefault();
    setResizing(true);
    const startY = e.clientY;
    const startH = pane.offsetHeight;
    const maxH = Math.max(minHeight, (pane.parentElement?.clientHeight ?? Infinity) * maxFraction);
    const onMove = (ev: MouseEvent) => {
      // The handle sits on the pane's top edge: dragging up grows it.
      setHeight(Math.min(maxH, Math.max(minHeight, startH + startY - ev.clientY)));
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  };

  return { height, setHeight, setPane, resizing, startResize, resetHeight: () => setHeight(null) };
}

export type ResizableHeight = ReturnType<typeof useResizableHeight<HTMLElement>>;
