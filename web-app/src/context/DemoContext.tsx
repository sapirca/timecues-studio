import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { getIsDemo, setIsDemo, subscribeIsDemo } from '../state/demoFlag';
import { demoClearAll, demoCountSavedWork } from '../services/demoStorage';

interface DemoContextValue {
  /** True while the visitor is in Demo Mode. */
  isDemo: boolean;
  /** True for one tick while a demo exit is tearing down the synthetic
   *  annotator and navigating away. AppShell's auth gate observes this so it
   *  doesn't see (annotator=null, isDemo=false) on a protected pathname
   *  mid-transition and bounce the user to /login. Mirrors the isSigningOut
   *  shield in AnnotatorContext. */
  isExitingDemo: boolean;
  /** Enter demo. Subsequent renders see isDemo=true and the auth gate stops
   *  redirecting to /login. */
  enterDemo: () => void;
  /** Exit demo and wipe the localStorage demo namespace. Primitive; UI code
   *  should normally go through requestExitDemo so the user gets a choice. */
  exitDemo: () => void;
  /** Exit demo but leave the localStorage demo namespace intact, so re-entering
   *  demo on this browser picks up the saved edits. */
  exitDemoKeepWork: () => void;
  /** Open the three-choice exit dialog (Keep & exit / Discard & exit / Cancel)
   *  and run `after` once the user has chosen Keep or Discard. If there's no
   *  saved work to lose, skips the dialog and exits immediately. Cancel runs
   *  no callback. */
  requestExitDemo: (after?: () => void) => void;
}

const DemoContext = createContext<DemoContextValue | null>(null);

export function DemoProvider({ children }: { children: ReactNode }) {
  // Keep React state in sync with the module-level flag. The flag is the
  // source of truth so service-layer code (which has no React) can read it.
  const [isDemo, setLocalIsDemo] = useState<boolean>(() => getIsDemo());
  useEffect(() => subscribeIsDemo(setLocalIsDemo), []);

  // When set, the exit dialog is mounted. `count` is captured at request time
  // so the message stays stable even if storage changes underneath. `after`
  // runs after Keep or Discard (typically navigate or signOut).
  const [exitPrompt, setExitPrompt] = useState<{ count: number; after: () => void } | null>(null);

  // Shield against the brief tick between (isDemo flipped to false) and (the
  // route change to '/' committing). Without it, AppShell's auth gate can see
  // a protected pathname with no annotator and bounce to /login?returnTo=…
  const [isExitingDemo, setIsExitingDemo] = useState(false);
  const { pathname } = useLocation();

  // Primary: drop the shield only after the pathname has actually changed.
  // react-router 7's useSyncExternalStore routing does not necessarily batch
  // with our setStates, so a one-tick timer can clear the shield before
  // AppShell ever observes the new pathname. Watching [pathname] guarantees
  // we hold the shield until the navigation lands.
  useEffect(() => {
    if (isExitingDemo) setIsExitingDemo(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Fallback: if the exit didn't change the pathname (e.g., "Exit demo" from
  // the avatar menu while already on '/'), drop the shield after a short
  // delay so it doesn't get stuck on. Cancelled if the primary effect clears
  // first.
  useEffect(() => {
    if (!isExitingDemo) return;
    const id = window.setTimeout(() => setIsExitingDemo(false), 300);
    return () => window.clearTimeout(id);
  }, [isExitingDemo]);

  const enterDemo = useCallback(() => { setIsDemo(true); }, []);

  // Run the demo teardown + the caller's follow-up (typically navigate or
  // signOut) inside the same render batch as setIsExitingDemo(true), so the
  // gate observes the shield from the very render that also drops the demo
  // annotator. The pathname-watching useEffect above clears the shield once
  // the navigation lands.
  const tearDownDemo = useCallback((wipeStorage: boolean, after: () => void) => {
    setIsExitingDemo(true);
    if (wipeStorage) demoClearAll();
    setIsDemo(false);
    after();
  }, []);

  const exitDemo = useCallback(() => {
    tearDownDemo(true, () => {});
  }, [tearDownDemo]);
  const exitDemoKeepWork = useCallback(() => {
    tearDownDemo(false, () => {});
  }, [tearDownDemo]);

  const requestExitDemo = useCallback((after?: () => void) => {
    const fn = after ?? (() => {});
    const count = demoCountSavedWork();
    if (count === 0) {
      // Nothing to decide about. Exit straight through.
      tearDownDemo(true, fn);
      return;
    }
    setExitPrompt({ count, after: fn });
  }, [tearDownDemo]);

  return (
    <DemoContext.Provider value={{ isDemo, isExitingDemo, enterDemo, exitDemo, exitDemoKeepWork, requestExitDemo }}>
      {children}
      {exitPrompt && (
        <ExitDemoDialog
          count={exitPrompt.count}
          onCancel={() => setExitPrompt(null)}
          onKeep={() => {
            const { after } = exitPrompt;
            setExitPrompt(null);
            tearDownDemo(false, after);
          }}
          onDiscard={() => {
            const { after } = exitPrompt;
            setExitPrompt(null);
            tearDownDemo(true, after);
          }}
        />
      )}
    </DemoContext.Provider>
  );
}

export function useDemo(): DemoContextValue {
  const ctx = useContext(DemoContext);
  if (!ctx) throw new Error('useDemo must be used within DemoProvider');
  return ctx;
}

function ExitDemoDialog({
  count,
  onCancel,
  onKeep,
  onDiscard,
}: {
  count: number;
  onCancel: () => void;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const noun = count === 1 ? 'song' : 'songs';

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="exit-demo-title"
        className="w-full max-w-md bg-[#14171d] border border-violet-500/30 rounded-md shadow-2xl shadow-black/60 p-6 space-y-5"
      >
        <div className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.2em] uppercase text-violet-300">
          <span className="tc-led tc-led-mute !bg-violet-400 !shadow-[0_0_6px_rgba(167,139,250,0.55)]" />
          Exit demo
        </div>
        <h2 id="exit-demo-title" className="text-base font-medium text-slate-100">
          What should happen to your demo edits?
        </h2>
        <p className="text-[12px] text-slate-400 leading-relaxed">
          You have demo edits for <strong className="text-slate-100">{count} {noun}</strong> saved in this browser.
        </p>
        <ul className="text-[11px] text-slate-400 leading-relaxed space-y-2 bg-black/30 border border-white/[0.05] rounded p-3">
          <li>
            <span className="text-emerald-300">●</span>{' '}
            <strong className="text-slate-300">Keep my work</strong> — edits stay in this browser's localStorage. Re-entering demo on this device picks them up; signing in as a real user ignores them. Clearing site data still wipes them.
          </li>
          <li>
            <span className="text-amber-300">●</span>{' '}
            <strong className="text-slate-300">Discard my work</strong> — deletes every <code className="font-mono text-slate-300">tc:demo:*</code> key. Cannot be undone.
          </li>
        </ul>
        <div className="flex flex-col gap-2 pt-1">
          <button
            type="button"
            onClick={onKeep}
            className="w-full px-4 py-2 rounded text-[11px] uppercase tracking-wider bg-violet-500/20 hover:bg-violet-500/30 border border-violet-400/40 text-violet-100 font-medium transition-colors"
          >
            Keep my work & exit →
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="w-full px-4 py-2 rounded text-[11px] uppercase tracking-wider bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-200 font-medium transition-colors"
          >
            Discard my work & exit
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="w-full px-2.5 py-1 rounded text-[11px] font-mono text-slate-500 hover:text-slate-200 hover:bg-white/[0.04] transition-colors"
          >
            Cancel — stay in demo
          </button>
        </div>
      </div>
    </div>
  );
}
