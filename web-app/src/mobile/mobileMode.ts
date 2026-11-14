/**
 * Which shell this visit gets — the desktop workspace, or the phone one.
 *
 * The phone shell is the same app with a different frame: a slim top bar
 * (song ▾ · avatar), the desktop workspace tabs moved to a bottom bar, and the
 * workspace sidebars opened one at a time over the timeline instead of
 * squeezed beside it. Nothing is forked — every route renders the page it
 * renders on desktop — so the decision can be made once, before the first
 * paint, and read as a plain flag everywhere after.
 *
 * **The address decides.** `m.<host>` is the phone one, everywhere the app
 * runs: `m.timecues-studio.lol` in production and `m.localhost:5174` in dev
 * (every `*.localhost` name resolves to 127.0.0.1, and Vite serves it), so the
 * two shells keep two URLs instead of one URL that remembers what you last
 * asked for. Nothing is stored for those visits.
 *
 * Order of precedence, first match wins:
 *   1. `?mobile=1` / `?mobile=0` — this TAB only, for a quick look without
 *      changing the address (it survives reloads in that tab, which is what
 *      makes it usable while signing in, and dies with the tab). Deliberately
 *      not remembered beyond it: a single `?mobile=1` used to leave that
 *      browser in the phone shell on every later visit.
 *   2. The `m.` host.
 *   3. A phone-sized touch screen, unless this browser has asked for the
 *      desktop site (the only thing stored, written by the account menu's
 *      **Desktop site** row). Someone who opens the desktop address on a
 *      phone should not get a distorted desktop and have to know about `m.`,
 *      but they must be able to say otherwise and have it stick.
 */

/** "This browser asked for the desktop site." The only remembered choice.
 *  A fresh key: the old one also held the phone shell, written by every
 *  `?mobile=1` visit, which is exactly the stickiness this removed. */
export const DESKTOP_SITE_KEY = 'tc:desktop-site';

/** Narrow AND touch-first: a small desktop window keeps the desktop shell. */
export const PHONE_MEDIA_QUERY = '(max-width: 760px) and (pointer: coarse)';

export interface DetectEnv {
  hostname: string;
  search: string;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Tab-scoped store for the `?mobile` override (sessionStorage). */
  tabStorage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  matchesPhone: boolean;
}

/** Where a `?mobile` override lives for the rest of the tab's life. */
export const TAB_OVERRIDE_KEY = 'tc:mobile-shell-tab';

function readEnv(): DetectEnv {
  let storage: DetectEnv['storage'] = null;
  try { storage = window.localStorage; } catch { /* private mode / blocked */ }
  let tabStorage: DetectEnv['tabStorage'] = null;
  try { tabStorage = window.sessionStorage; } catch { /* private mode / blocked */ }
  let matchesPhone = false;
  try { matchesPhone = window.matchMedia?.(PHONE_MEDIA_QUERY).matches ?? false; } catch { /* old engine */ }
  return {
    hostname: window.location.hostname,
    search: window.location.search,
    storage,
    tabStorage,
    matchesPhone,
  };
}

export function isMobileHost(hostname: string): boolean {
  return hostname.startsWith('m.');
}

export function detectMobileMode(env: DetectEnv = readEnv()): boolean {
  const q = new URLSearchParams(env.search).get('mobile');
  if (q === '1' || q === '0') {
    // Kept for the tab, not the browser: a reload (or a sign-in that reloads
    // the page) should not drop you back into the other shell.
    try { env.tabStorage?.setItem(TAB_OVERRIDE_KEY, q); } catch { /* quota */ }
    return q === '1';
  }
  let tab: string | null = null;
  try { tab = env.tabStorage?.getItem(TAB_OVERRIDE_KEY) ?? null; } catch { /* blocked */ }
  if (tab === '1' || tab === '0') return tab === '1';
  if (isMobileHost(env.hostname)) return true;
  if (!env.matchesPhone) return false;
  let optedOut = false;
  try { optedOut = env.storage?.getItem(DESKTOP_SITE_KEY) === '1'; } catch { /* blocked */ }
  return !optedOut;
}

/** The same address on the other shell's host: `m.` added or removed. */
export function shellHostUrl(to: 'mobile' | 'desktop'): string {
  const { hostname, pathname, search, hash, protocol, port } = window.location;
  const params = new URLSearchParams(search);
  params.delete('mobile');
  const qs = params.toString() ? `?${params}` : '';
  const bare = isMobileHost(hostname) ? hostname.slice(2) : hostname;
  const host = (to === 'mobile' ? `m.${bare}` : bare) + (port ? `:${port}` : '');
  return `${protocol}//${host}${pathname}${qs}${hash}`;
}

/** Leave the phone shell: the same page on the desktop host. Remembered, so
 *  a phone that asked for the desktop site is not handed the phone shell
 *  again on its next visit to that host. */
export function switchToDesktop(): void {
  try { window.localStorage.setItem(DESKTOP_SITE_KEY, '1'); } catch { /* blocked */ }
  window.location.assign(shellHostUrl('desktop'));
}

let current = false;

/** Decide once, before React renders, and stamp the root element so plain
 *  CSS (the header height, the sidebars-become-panels rules in index.css)
 *  follows without a render. */
export function initMobileMode(): boolean {
  // Drop the pre-2026-09-23 key, which also stored "phone shell" and was
  // written by every ?mobile=1 visit — the stickiness this replaced.
  try { window.localStorage.removeItem('tc:mobile-shell'); } catch { /* blocked */ }
  current = detectMobileMode();
  document.documentElement.classList.toggle('tc-mobile', current);
  return current;
}

export function getIsMobile(): boolean {
  return current;
}
