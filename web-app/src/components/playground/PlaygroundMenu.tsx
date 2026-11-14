import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

export interface PlaygroundMenuItem {
  label: string;
  onSelect: () => void;
  title?: string;
  disabled?: boolean;
  /** Destructive: drawn in rose. */
  danger?: boolean;
  /** Draw a divider above this item. */
  separated?: boolean;
  /** Keyboard shortcut, shown right-aligned. */
  hint?: string;
}

/** Close on a press outside `root` or on Escape, while `open`. */
function useDismiss(open: boolean, root: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [open, root, close]);
}

function MenuItems({ items, close }: { items: PlaygroundMenuItem[]; close: () => void }) {
  return (
    <>
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          disabled={it.disabled}
          title={it.title}
          onClick={() => { close(); it.onSelect(); }}
          className={`flex items-center gap-4 w-full text-left px-3 py-1.5 text-[12px] disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/[0.05] ${
            it.separated ? 'border-t border-white/[0.06] mt-1 pt-2' : ''
          } ${it.danger ? 'text-rose-300' : 'text-slate-200'}`}
        >
          <span className="flex-1">{it.label}</span>
          {it.hint && <span className="text-[10px] text-slate-500">{it.hint}</span>}
        </button>
      ))}
    </>
  );
}

const MENU_PANEL = 'z-50 min-w-[14rem] py-1 rounded border border-white/10 bg-[#161920] shadow-xl shadow-black/50';

/** The menu a right-click opens, at the pointer — kept inside the window. */
export function PlaygroundContextMenu({
  at,
  label,
  items,
  onClose,
}: {
  at: { x: number; y: number };
  label: string;
  items: PlaygroundMenuItem[];
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(true, rootRef, onClose);
  // Measured before paint, so a menu opened near an edge never flashes past it.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4))}px`;
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [at]);
  return (
    <div
      ref={rootRef}
      role="menu"
      aria-label={label}
      className={`fixed ${MENU_PANEL}`}
      style={{ left: at.x, top: at.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuItems items={items} close={onClose} />
    </div>
  );
}

/** A ⋯ button with a short list of actions under it — where the Playground
 *  keeps the actions you reach for rarely, so the ones you use all the time
 *  are the only buttons on screen. */
export function PlaygroundMenu({
  label,
  items,
  align = 'right',
  children,
}: {
  /** Accessible name of the button. */
  label: string;
  items: PlaygroundMenuItem[];
  align?: 'left' | 'right';
  /** The button's face; ⋯ when absent. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, rootRef, close);
  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`h-7 min-w-[1.75rem] px-1.5 grid place-items-center rounded border text-[12px] transition ${
          open ? 'border-white/20 bg-white/[0.06] text-slate-100' : 'border-white/10 text-slate-400 hover:text-slate-200 hover:border-white/20'
        }`}
      >
        {children ?? '⋯'}
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute top-full mt-1 ${MENU_PANEL} ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          <MenuItems items={items} close={close} />
        </div>
      )}
    </div>
  );
}
