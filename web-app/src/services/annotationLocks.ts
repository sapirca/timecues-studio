/**
 * Client for the shared-song edit lease.
 *
 * A shared song is edited by one person at a time. Opening one gives you
 * read-only access; you take the lock deliberately, and you hand it back
 * deliberately. Nobody's lock is ever taken away by a timer — a lapsed
 * heartbeat only marks a lease STALE, which changes what the UI says and how
 * hard it asks before someone takes over.
 *
 * Two clocks travel with every lease, and they answer different questions:
 *   • `renewedAt` — the holder's tab said "still here". Proves a tab is open.
 *   • `lastEditAt` — a write landed. Proves a person is working.
 * Both are stamped server-side, and every response carries the server's `now`,
 * so a browser with a skewed clock can't render "idle -3 minutes".
 *
 * Backend: web-app/vite.config.ts — serveAnnotationLocks()
 * Storage: web-app/server/sharedAnnotations.ts
 */

import { annotatorHeaders } from '../utils/annotatorHeaders';

export interface LockView {
  slug: string;
  /** Annotator id — the lease belongs to the person, not the tab. */
  holder: string;
  /** Resolved from the holder's profile server-side: non-admins never receive
   *  the member roster, so the client cannot look this up itself. */
  holderName: string;
  sessionId: string;
  acquiredAt: string;
  renewedAt: string;
  lastEditAt: string | null;
  expiresAt: string;
  /** No heartbeat for a while — the holder's tab is probably gone. Probably:
   *  we observed silence, not a closed tab, and the copy should say so. */
  stale: boolean;
  /** Holder is present but has written nothing lately. */
  idle: boolean;
  idleMs: number;
  heldMs: number;
  stolenFrom?: string | null;
}

export interface LockState {
  now: string;
  slug: string;
  shared: boolean;
  lock: LockView | null;
}

export interface LocksListing {
  now: string;
  heartbeatMs: number;
  staleAfterMs: number;
  idleAfterMs: number;
  locks: LockView[];
}

export interface HistoryEntry {
  sha: string;
  date: string;
  author: string;
  email: string;
  subject: string;
  event: string;
  rev: number | null;
}

/** What happened when we asked for the lock. `conflict` carries the current
 *  lease so the caller can name who is in the way without a second request. */
export type LockOutcome =
  | { ok: true; state: LockState }
  | { ok: false; conflict: LockState | null; error: string };

const LOCKS = '/api/annotation-locks';
const HISTORY = '/api/annotation-history';
const SHARED = '/api/shared-annotations';

/** Per-TAB identity, so one person's second tab can be told apart from their
 *  first — that is how a reload reclaims the lock while a duplicate tab takes
 *  it over and the original is told what happened. sessionStorage (not local)
 *  is exactly per-tab; a private window or a blocked store just yields a fresh
 *  id each call, which degrades to "can't distinguish tabs", not to an error. */
let memoSession: string | null = null;
export function sessionId(): string {
  if (memoSession) return memoSession;
  const KEY = 'timecues.lockSession';
  try {
    const found = window.sessionStorage.getItem(KEY);
    if (found) { memoSession = found; return found; }
  } catch { /* storage unavailable */ }
  const made = `s${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  try { window.sessionStorage.setItem(KEY, made); } catch { /* ignore */ }
  memoSession = made;
  return made;
}

/** Headers for any request that may write to a shared document. The session id
 *  rides along so the server can reject a tab that has lost the lease to
 *  another tab of the same person. */
export function lockHeaders(extra?: Record<string, string>): Record<string, string> {
  return annotatorHeaders({ 'X-Session-Id': sessionId(), ...(extra ?? {}) });
}

async function post(slug: string, action: string): Promise<LockOutcome> {
  try {
    const res = await fetch(`${LOCKS}/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: lockHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ action, sessionId: sessionId() }),
    });
    const body = await res.json().catch(() => null);
    if (res.ok) return { ok: true, state: body as LockState };
    return {
      ok: false,
      conflict: body && typeof body === 'object' && 'lock' in body ? (body as LockState) : null,
      error: (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`,
    };
  } catch {
    return { ok: false, conflict: null, error: 'network error' };
  }
}

/** Take the lock so you can edit. Refused while someone else holds a live
 *  lease — the caller then shows who, and offers `takeOver`. */
export function lockSong(slug: string): Promise<LockOutcome> {
  return post(slug, 'lock');
}

/** Hand the lock back. You become read-only; the song is free for the next
 *  person. Snapshots the document as a new version on the way out. */
export function unlockSong(slug: string): Promise<LockOutcome> {
  return post(slug, 'unlock');
}

/** Take the lock from whoever has it. Always allowed, never silent: the
 *  outgoing holder's work is committed to history first, and their client is
 *  told at its next heartbeat. */
export function takeOverSong(slug: string): Promise<LockOutcome> {
  return post(slug, 'takeover');
}

/** Re-assert the lease. Send while the document is VISIBLE, so silence means
 *  "nobody is looking at this song" rather than "a browser process exists". */
export function heartbeat(slug: string): Promise<LockOutcome> {
  return post(slug, 'heartbeat');
}

export async function fetchLock(slug: string): Promise<LockState | null> {
  try {
    const res = await fetch(`${LOCKS}/${encodeURIComponent(slug)}`, { headers: lockHeaders() });
    if (!res.ok) return null;
    return (await res.json()) as LockState;
  } catch { return null; }
}

/** Every live lease, for the song-list "🔒 Alice" chips — one request, so the
 *  sidebar can show who is on what before anything is opened. */
export async function fetchAllLocks(): Promise<LocksListing | null> {
  try {
    const res = await fetch(LOCKS, { headers: lockHeaders() });
    if (!res.ok) return null;
    return (await res.json()) as LocksListing;
  } catch { return null; }
}

export async function fetchHistory(slug: string, limit = 100): Promise<HistoryEntry[]> {
  try {
    const res = await fetch(`${HISTORY}/${encodeURIComponent(slug)}?limit=${limit}`, { headers: lockHeaders() });
    if (!res.ok) return [];
    return ((await res.json()) as { entries?: HistoryEntry[] }).entries ?? [];
  } catch { return []; }
}

/** One past version's document, for previewing before restoring. */
export async function fetchVersion(slug: string, sha: string): Promise<unknown | null> {
  try {
    const res = await fetch(`${HISTORY}/${encodeURIComponent(slug)}?sha=${encodeURIComponent(sha)}`, {
      headers: lockHeaders(),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { doc?: unknown }).doc ?? null;
  } catch { return null; }
}

/** Bring an old version back. Requires the lock, and writes forward as a NEW
 *  version rather than rewriting history — so a wrong restore is undoable the
 *  same way everything else is. */
export async function restoreVersion(slug: string, sha: string): Promise<boolean> {
  try {
    const res = await fetch(`${HISTORY}/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: lockHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ sha }),
    });
    return res.ok;
  } catch { return false; }
}

/** Which songs are collaborative.
 *
 *  Throws rather than reporting an empty list when the request fails: "no song
 *  is collaborative" and "I could not find out" are different answers, and the
 *  sidebar's grouping draws a heading for each. */
export async function fetchSharedSlugs(): Promise<{ shared: string[]; git: boolean }> {
  const res = await fetch(SHARED, { headers: lockHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { shared: string[]; git: boolean };
}

/** Who already has a document for this song — the candidates for seeding a
 *  shared annotation. Reads the cross-annotator listing the Compare view uses. */
export async function fetchSongAnnotators(slug: string): Promise<string[]> {
  try {
    const res = await fetch(`/api/annotations/${encodeURIComponent(slug)}/annotators`, {
      headers: lockHeaders(),
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<{ id?: string; has?: { layers?: boolean } }>;
    return rows.filter((r) => r?.has?.layers && typeof r.id === 'string').map((r) => r.id as string);
  } catch { return []; }
}

/** Admin: turn one song collaborative, seeding the team's shared document from
 *  an existing annotator's work (or starting empty). Idempotent-ish: refuses
 *  rather than overwriting a song that is already shared. */
export async function makeSongShared(slug: string, seedFrom?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${SHARED}/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: lockHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(seedFrom ? { seedFrom } : {}),
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: ((await res.json().catch(() => null)) as { error?: string } | null)?.error };
  } catch { return { ok: false, error: 'network error' }; }
}

/** Admin: back to per-annotator editing. The shared document and its whole
 *  history are archived, not deleted. */
export async function makeSongSolo(slug: string): Promise<boolean> {
  try {
    const res = await fetch(`${SHARED}/${encodeURIComponent(slug)}`, {
      method: 'DELETE', headers: lockHeaders(),
    });
    return res.ok;
  } catch { return false; }
}

// ─── Display ────────────────────────────────────────────────────────────────

function humanDuration(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** One line naming who holds a song and what we actually observed about them.
 *  Deliberately hedged on the stale case: a silent heartbeat is evidence the
 *  tab closed, not proof — claiming certainty we don't have is how a takeover
 *  dialog talks someone into the wrong decision. */
export function describeLock(lock: LockView | null, youAre: string | null): string {
  if (!lock) return 'No one is editing';
  const who = lock.holder === youAre ? 'You' : lock.holderName;
  if (lock.stale) {
    return `${who} · no heartbeat for ${humanDuration(Date.parse(lock.expiresAt) - Date.parse(lock.renewedAt) + lock.idleMs)} (tab likely closed)`;
  }
  if (lock.idle) return `${who} holds this · no changes for ${humanDuration(lock.idleMs)}`;
  return lock.holder === youAre ? `You're editing · ${humanDuration(lock.heldMs)}` : `${who} is editing`;
}

/** The three states the UI has to render for a shared song. */
export type LockStance = 'free' | 'yours' | 'theirs' | 'theirs-stale';

export function stanceFor(lock: LockView | null, youAre: string | null): LockStance {
  if (!lock) return 'free';
  if (lock.holder === youAre) return 'yours';
  return lock.stale ? 'theirs-stale' : 'theirs';
}
