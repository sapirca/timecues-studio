// Tiny module-level flag for "demo mode". Lives outside React context so
// service-layer code (fetchers, save handlers) can branch without prop
// drilling. Mirrored into sessionStorage so reloads within the demo tab
// preserve the mode; closing the tab ends it (which is the right default —
// the user is "just looking", their session ends with the window).
//
// DemoProvider stays in lockstep with this module — its setter calls
// setIsDemo(...) here so subscribers (e.g. hooks reading via the React
// context) react.

const STORAGE_KEY = 'tc:demo';

function readStored(): boolean {
  try { return sessionStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
}

let _isDemo = readStored();
const listeners = new Set<(v: boolean) => void>();

export function getIsDemo(): boolean {
  return _isDemo;
}

export function setIsDemo(v: boolean): void {
  if (_isDemo === v) return;
  _isDemo = v;
  try {
    if (v) sessionStorage.setItem(STORAGE_KEY, '1');
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // sessionStorage might be unavailable (private mode etc.); the in-memory
    // flag still drives the current tab.
  }
  for (const l of listeners) l(v);
}

export function subscribeIsDemo(listener: (v: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Fixed annotator id used for the demo session. All localStorage demo data
 *  is keyed under this id (so future multi-profile demo support — if we ever
 *  add it — can fan out cleanly). */
export const DEMO_ANNOTATOR_ID = 'demo-anonymous';
