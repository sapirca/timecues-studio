import type { ResizableSidebar } from '../hooks/useResizableSidebar';
import type { ResizableHeight } from '../hooks/useResizableHeight';

const ACCENT = {
  sky:    { active: 'bg-sky-500/40',    hover: 'hover:bg-sky-500/30',    line: 'bg-sky-400',    lineHover: 'group-hover:bg-sky-400/60' },
  violet: { active: 'bg-violet-500/40', hover: 'hover:bg-violet-500/30', line: 'bg-violet-400', lineHover: 'group-hover:bg-violet-400/60' },
};

/** The drag strip on a sidebar's inner edge: drag to resize, double-click to
 *  reset. A visible grip, so the edge reads as something to grab — an
 *  invisible strip that only lit up on hover left people thinking a sidebar
 *  could not be resized. The sidebar must be `relative`. */
export function SidebarResizeHandle({
  sidebar,
  accent = 'sky',
}: {
  sidebar: Pick<ResizableSidebar, 'side' | 'resizing' | 'startResize' | 'resetWidth'>;
  accent?: keyof typeof ACCENT;
}) {
  const a = ACCENT[accent];
  const edge = sidebar.side === 'left' ? '-right-1' : '-left-1';
  return (
    <div
      data-resize-handle
      role="separator"
      aria-orientation="vertical"
      onMouseDown={sidebar.startResize}
      onDoubleClick={sidebar.resetWidth}
      title="Drag to resize · double-click to reset"
      className={`absolute top-0 ${edge} h-full w-2 cursor-col-resize z-20 group flex items-center justify-center ${sidebar.resizing ? a.active : a.hover} transition-colors`}
    >
      <div className={`absolute top-0 left-1 h-full w-px ${sidebar.resizing ? a.line : `bg-transparent ${a.lineHover}`}`} />
      <div className="relative w-1 h-10 rounded-full bg-white/25 group-hover:bg-white/50" aria-hidden />
    </div>
  );
}

/** The drag strip on a pane's top edge (useResizableHeight): drag up or down
 *  to trade height with the pane above, double-click to reset. A visible
 *  grip, so the seam reads as something to grab. The parent must be
 *  `relative`; the strip straddles the edge without taking layout room. */
export function HeightResizeHandle({
  pane,
  accent = 'sky',
  className = '',
}: {
  pane: Pick<ResizableHeight, 'resizing' | 'startResize' | 'resetHeight'>;
  accent?: keyof typeof ACCENT;
  className?: string;
}) {
  const a = ACCENT[accent];
  return (
    <div
      data-resize-handle
      role="separator"
      aria-orientation="horizontal"
      onMouseDown={pane.startResize}
      onDoubleClick={pane.resetHeight}
      title="Drag to resize · double-click to reset"
      className={`absolute left-0 right-0 -top-1 h-2 cursor-row-resize z-20 group flex items-center justify-center ${pane.resizing ? a.active : a.hover} transition-colors ${className}`}
    >
      <div className={`absolute left-0 right-0 top-1 h-px ${pane.resizing ? a.line : `bg-white/20 ${a.lineHover}`}`} />
      <div className="relative w-10 h-1 rounded-full bg-white/30 group-hover:bg-white/50" aria-hidden />
    </div>
  );
}

/** What a collapsed sidebar leaves behind: a slim column with its name
 *  written down it. Click to open the sidebar again. */
export function CollapsedSidebarRail({
  side,
  label,
  title,
  onExpand,
  className = 'self-start',
}: {
  side: 'left' | 'right';
  label: string;
  title: string;
  onExpand: () => void;
  /** Placement classes for the rail's column. */
  className?: string;
}) {
  return (
    <aside className={`shrink-0 tc-aside ${className} ${side === 'left' ? 'border-r border-white/[0.10]' : 'border-l border-white/[0.06]'} bg-[#14171d]/80`}>
      <button
        onClick={onExpand}
        title={title}
        className="h-full w-9 flex flex-col items-center gap-3 pt-3 text-slate-300 hover:text-white hover:bg-white/[0.03] transition-colors"
      >
        <span className="text-xl leading-none font-bold">{side === 'left' ? '›' : '‹'}</span>
        <span className="text-[11px] uppercase tracking-[0.18em] font-semibold" style={{ writingMode: 'vertical-rl' }}>{label}</span>
      </button>
    </aside>
  );
}
