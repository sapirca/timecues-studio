import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

export interface ResizableSidebarOptions {
  /** localStorage prefix: `<key>-width` and `<key>-collapsed`, e.g. 'tc:algo-sidebar'. */
  storageKey: string;
  /** Which page edge the sidebar sits on. Its resize handle is on the other
   *  edge, so dragging away from the page edge widens it. */
  side: 'left' | 'right';
  minWidth: number;
  maxWidth: number;
  defaultWidth: number;
  /** When set, the default width is this share of the window (layout px),
   *  clamped to min/max, and follows the window as it resizes — until the
   *  viewer drags the edge. `defaultWidth` is then only the fallback, and the
   *  width this sidebar used to open at before it was relative. */
  widthFraction?: number;
  /** Collapsed when nothing is stored. */
  defaultCollapsed?: boolean;
}

function readStored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStored(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* a courtesy */ }
}
function removeStored(key: string) {
  try { localStorage.removeItem(key); } catch { /* a courtesy */ }
}

function relativeWidth(fraction: number, minWidth: number, maxWidth: number) {
  return Math.min(maxWidth, Math.max(minWidth, Math.round(window.innerWidth * fraction)));
}

/** A sidebar's width (drag its edge; persisted per browser) and collapsed
 *  state (persisted too). One implementation for every sidebar in the app —
 *  pair it with SidebarResizeHandle and CollapsedSidebarRail. */
export function useResizableSidebar({
  storageKey, side, minWidth, maxWidth, defaultWidth, widthFraction, defaultCollapsed = false,
}: ResizableSidebarOptions) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const stored = readStored(`${storageKey}-collapsed`);
    return stored === null ? defaultCollapsed : stored === '1';
  });
  useEffect(() => { writeStored(`${storageKey}-collapsed`, collapsed ? '1' : '0'); }, [storageKey, collapsed]);

  // Only a width the viewer dragged to is stored. The default used to be
  // written on every mount, so a stored value equal to the old fixed default is
  // that auto-write, not a choice — with widthFraction it reads as unset and
  // the sidebar follows the window like a first visit.
  const [chosen, setChosen] = useState<number | null>(() => {
    const n = parseInt(readStored(`${storageKey}-width`) ?? '', 10);
    if (!Number.isFinite(n) || n < minWidth || n > maxWidth) return null;
    if (widthFraction !== undefined && n === defaultWidth) return null;
    return n;
  });
  const autoWidth = () =>
    widthFraction === undefined ? defaultWidth : relativeWidth(widthFraction, minWidth, maxWidth);
  const [auto, setAuto] = useState<number>(autoWidth);
  useEffect(() => {
    if (widthFraction === undefined) return;
    const onResize = () => setAuto(relativeWidth(widthFraction, minWidth, maxWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [widthFraction, minWidth, maxWidth]);
  const width = chosen ?? auto;
  const setWidth = (w: number) => {
    setChosen(w);
    writeStored(`${storageKey}-width`, String(w));
  };

  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(width);
  useEffect(() => { widthRef.current = width; }, [width]);

  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    setResizing(true);
    const startX = e.clientX;
    const startW = widthRef.current;
    const onMove = (ev: MouseEvent) => {
      const delta = side === 'left' ? ev.clientX - startX : startX - ev.clientX;
      setWidth(Math.min(maxWidth, Math.max(minWidth, startW + delta)));
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
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return {
    width, setWidth, collapsed, setCollapsed, resizing, startResize,
    // Double-click the edge: back to the default, which follows the window again.
    resetWidth: () => { setChosen(null); setAuto(autoWidth()); removeStored(`${storageKey}-width`); },
    side,
  };
}

export type ResizableSidebar = ReturnType<typeof useResizableSidebar>;
