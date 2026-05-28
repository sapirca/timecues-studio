import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAnnotator } from '../context/AnnotatorContext';
import { useDemo } from '../context/DemoContext';

/** Shows the current annotator + sign-out menu.
 *  Default mode (`inline` omitted) renders as a floating top-right badge,
 *  globally mounted. Pass `inline` to embed it inside a layout container
 *  (e.g. a page header) — the fixed positioning is dropped but the dropdown
 *  still anchors to the badge. */
export function AnnotatorBadge({ inline = false }: { inline?: boolean } = {}) {
  const { annotator, signOut } = useAnnotator();
  const { isDemo, requestExitDemo } = useDemo();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  if (!annotator) return null;

  const initials = annotator.displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <div ref={ref} className={`${inline ? 'relative' : 'fixed top-3 right-3 z-50'} text-xs flex items-center gap-1.5`}>
      <button
        type="button"
        onClick={() => navigate('/settings')}
        className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-800/90 hover:bg-gray-700/90 border border-gray-700 text-gray-300 hover:text-white shadow-lg backdrop-blur-sm text-base leading-none"
        title="Settings"
        aria-label="Settings"
      >
        <span aria-hidden>⚙</span>
      </button>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-full bg-gray-800/90 hover:bg-gray-700/90 border border-gray-700 text-gray-200 shadow-lg backdrop-blur-sm"
        title={annotator.email ?? annotator.id}
      >
        <span className="w-5 h-5 rounded-full bg-indigo-600 flex items-center justify-center text-[10px] font-bold">
          {initials || '?'}
        </span>
        <span className="max-w-[140px] truncate">{annotator.displayName}</span>
        <span className="text-gray-500">▾</span>
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 w-64 bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-3 space-y-2">
          <div className="space-y-0.5">
            <div className="text-sm text-gray-200">{annotator.displayName}</div>
            {annotator.email && <div className="text-xs text-gray-400 truncate">{annotator.email}</div>}
            {annotator.role && <div className="text-xs text-gray-500">{annotator.role}</div>}
            {annotator.affiliation && <div className="text-xs text-gray-500">{annotator.affiliation}</div>}
            <div className="text-[10px] text-gray-600 pt-1">
              id: <code>{annotator.id}</code>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              // signOut() navigates to '/' and raises an isSigningOut flag so
              // AppShell's auth gate can't bounce us through /login during the
              // transition (see AnnotatorContext). Demo Mode synthesises an
              // annotator outside of auth, so it has to be cleared separately.
              // requestExitDemo opens a Keep / Discard / Cancel dialog when
              // there are saved edits; cancel runs no callback and stays in
              // demo. No saved work = no dialog.
              if (isDemo) {
                requestExitDemo(() => signOut());
                return;
              }
              signOut();
            }}
            className="w-full px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200"
          >
            {isDemo ? 'Exit demo' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  );
}
