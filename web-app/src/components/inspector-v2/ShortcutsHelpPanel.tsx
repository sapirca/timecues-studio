import { useMemo } from 'react';
import type { ShortcutDef } from '../../hooks/useAnnotationShortcuts';

interface Props {
  open: boolean;
  onClose: () => void;
  shortcuts: ShortcutDef[];
  /** Tailwind text color class for accents (e.g. 'text-cyan-300'). */
  accentText?: string;
}

/**
 * Right-edge sliding drawer that lists every available keyboard shortcut.
 * Toggled via `?`; closed via Esc, the backdrop, or the × button.
 */
export function ShortcutsHelpPanel({ open, onClose, shortcuts, accentText = 'text-cyan-300' }: Props) {
  // Group shortcuts by their `group` field, preserving the order they appear in the array.
  const groups = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, ShortcutDef[]>();
    for (const s of shortcuts) {
      if (!map.has(s.group)) {
        order.push(s.group);
        map.set(s.group, []);
      }
      map.get(s.group)!.push(s);
    }
    return order.map((g) => ({ group: g, items: map.get(g)! }));
  }, [shortcuts]);

  return (
    <>
      {/* Backdrop — fades in when open, click-to-close. pointer-events disabled when closed
          so the drawer doesn't block interactions while invisible. */}
      <div
        className={`fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 ${
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
        aria-hidden={!open}
      />

      {/* Drawer */}
      <aside
        role="dialog"
        aria-label="Keyboard shortcuts"
        aria-hidden={!open}
        className={`fixed top-0 right-0 z-50 h-full w-[360px] max-w-[90vw] bg-[#14171d] border-l border-white/[0.08] shadow-2xl shadow-black/80 transition-transform duration-200 ease-out ${
          open ? 'translate-x-0' : 'translate-x-full'
        } flex flex-col`}
      >
        <header className="flex items-center justify-between px-5 py-4 border-b border-white/[0.05]">
          <div>
            <div className={`text-[11px] font-medium uppercase tracking-wider ${accentText}`}>Keyboard Shortcuts</div>
            <div className="text-[10px] text-slate-500 mt-1 font-mono">Press <Kbd>?</Kbd> to toggle</div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-200 transition-colors text-base leading-none"
            aria-label="Close shortcuts panel"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {groups.map(({ group, items }) => (
            <section key={group}>
              <h3 className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-2">{group}</h3>
              <ul className="space-y-1.5">
                {items.map((s) => (
                  <li key={`${group}-${s.display}-${s.description}`} className="flex items-center justify-between gap-3 text-[12px]">
                    <span className="text-slate-400 leading-snug">{s.description}</span>
                    <KeyCombo combo={s.display} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <footer className="px-5 py-3 border-t border-white/[0.05] text-[10px] text-slate-600 font-mono">
          Shortcuts are disabled while typing in input fields.
        </footer>
      </aside>
    </>
  );
}

function KeyCombo({ combo }: { combo: string }) {
  // Split on " + " so we can render each key as its own pill.
  const parts = combo.split(' + ');
  return (
    <span className="flex items-center gap-1 shrink-0">
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <span className="text-slate-600 text-[10px]">+</span>}
          <Kbd>{p}</Kbd>
        </span>
      ))}
    </span>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded border border-white/[0.08] bg-[#1c2027] text-slate-300 text-[10px] font-mono leading-none shadow-[0_1px_0_rgba(0,0,0,0.4)]">
      {children}
    </kbd>
  );
}
