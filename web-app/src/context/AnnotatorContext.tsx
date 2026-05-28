import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Annotator } from '../types/annotator';
import { getIsDemo, subscribeIsDemo, DEMO_ANNOTATOR_ID } from '../state/demoFlag';

const STORAGE_KEY = 'annotator';
const COOKIE_KEY = 'annotator_id';

/** Synthetic annotator used while the visitor is in Demo Mode. Lives only
 *  in memory (never persisted to localStorage) so leaving demo doesn't
 *  pollute the real sign-in slot. */
const DEMO_ANNOTATOR: Annotator = {
  id: DEMO_ANNOTATOR_ID,
  displayName: 'Demo visitor',
  authMethod: 'username',
  createdAt: '1970-01-01T00:00:00.000Z',
};

function readStored(): Annotator | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.displayName !== 'string') return null;
    return parsed as Annotator;
  } catch {
    return null;
  }
}

// Mirror the annotator id into a cookie so requests that can't carry the
// X-Annotator-Id header — notably WaveSurfer audio loads and any other
// <audio>/<img>/static-asset request — still identify the signed-in user.
// Without this, /audio/<file> for user-uploaded songs 404s because the
// server falls through the team-only gate.
function writeAnnotatorCookie(id: string) {
  const oneYear = 60 * 60 * 24 * 365;
  document.cookie = `${COOKIE_KEY}=${encodeURIComponent(id)}; path=/; SameSite=Lax; Max-Age=${oneYear}`;
}
function clearAnnotatorCookie() {
  document.cookie = `${COOKIE_KEY}=; path=/; SameSite=Lax; Max-Age=0`;
}

// Seed from localStorage at module load so service-layer fetchers
// (fetchAdminStatus, annotation reads) see the current id before
// AnnotatorProvider's mirror-effect runs. Without this, child useEffects
// fire first on initial mount and ship requests with no X-Annotator-Id,
// which the server treats as anonymous — causing a signed-in admin to
// briefly look non-admin on first paint.
let _currentAnnotatorId: string | null = readStored()?.id ?? null;

/** Write whichever identity is currently effective into the cookie. Demo
 *  mode wins over a real sign-in so static-asset routes (/audio, /stems)
 *  resolve to the demo corpus while demo is on — they can't carry the
 *  X-Annotator-Id header that API fetches use. */
function syncAnnotatorCookie(): void {
  if (getIsDemo()) writeAnnotatorCookie(DEMO_ANNOTATOR_ID);
  else if (_currentAnnotatorId) writeAnnotatorCookie(_currentAnnotatorId);
  else clearAnnotatorCookie();
}

// Initial sync at module load + re-sync on every demo toggle.
syncAnnotatorCookie();
subscribeIsDemo(syncAnnotatorCookie);

/** Read-anywhere accessor for the current annotator id. Used by service-layer fetchers
 *  that don't have access to React context. Kept in sync by AnnotatorProvider.
 *  In Demo Mode the synthetic demo id is returned regardless of localStorage. */
export function getCurrentAnnotatorId(): string | null {
  if (getIsDemo()) return DEMO_ANNOTATOR_ID;
  return _currentAnnotatorId;
}

interface AnnotatorContextValue {
  annotator: Annotator | null;
  signIn: (a: Annotator) => void;
  signOut: () => void;
  /** True for one tick while signOut() is tearing down auth state and
   *  navigating to '/'. AppShell uses this to suppress its auth gate so it
   *  doesn't see (annotator=null) on a protected pathname mid-transition and
   *  bounce the user to /login?returnTo=… before the route change lands. */
  isSigningOut: boolean;
}

const AnnotatorContext = createContext<AnnotatorContextValue | null>(null);

export function AnnotatorProvider({ children }: { children: ReactNode }) {
  const [annotator, setAnnotator] = useState<Annotator | null>(readStored);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const navigate = useNavigate();
  // Mirror the demo flag into React state so a context value swap re-renders
  // every consumer (badge, admin-status fetchers, etc.) when demo flips.
  const [isDemoState, setIsDemoState] = useState<boolean>(() => getIsDemo());
  useEffect(() => subscribeIsDemo(setIsDemoState), []);

  useEffect(() => {
    _currentAnnotatorId = annotator?.id ?? null;
  }, [annotator]);

  const signIn = useCallback((a: Annotator) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(a));
    _currentAnnotatorId = a.id;
    syncAnnotatorCookie();
    setAnnotator(a);
    // Persist the profile server-side so returning Email/Google users can
    // be recognised and the sign-in form can prefill their details. The
    // server treats this as idempotent (won't overwrite an existing record).
    // Fire-and-forget — failures are non-fatal.
    void fetch('/api/annotators/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(a),
    }).catch(() => { /* non-fatal */ });
  }, []);

  const signOut = useCallback(() => {
    // Raise the "signing out" flag in the SAME batch as the auth clear, so
    // AppShell's auth gate (which observes both flags) is suppressed
    // throughout the transition. Without this flag, even with navigate's
    // flushSync, React could schedule a render where pathname is still
    // /inspect but annotator is already null → the gate fires <Navigate to
    // "/login?returnTo=/inspect"> before our navigate to '/' commits.
    setIsSigningOut(true);
    localStorage.removeItem(STORAGE_KEY);
    _currentAnnotatorId = null;
    syncAnnotatorCookie();
    setAnnotator(null);
    navigate('/', { replace: true });
    // Clear the flag on the next task, after the route change has landed.
    // setTimeout(0) is the safest hand-off; queueMicrotask runs in the same
    // task and can race with React's commit phase.
    setTimeout(() => setIsSigningOut(false), 0);
  }, [navigate]);

  // While in Demo Mode, every consumer sees the synthetic demo annotator
  // (so admin-status checks, X-Annotator-Id headers, badge, etc. all line up).
  // The real localStorage annotator is preserved underneath and reappears
  // when demo ends.
  const effectiveAnnotator = isDemoState ? DEMO_ANNOTATOR : annotator;

  return (
    <AnnotatorContext.Provider value={{ annotator: effectiveAnnotator, signIn, signOut, isSigningOut }}>
      {children}
    </AnnotatorContext.Provider>
  );
}

export function useAnnotator(): AnnotatorContextValue {
  const ctx = useContext(AnnotatorContext);
  if (!ctx) throw new Error('useAnnotator must be used within AnnotatorProvider');
  return ctx;
}
