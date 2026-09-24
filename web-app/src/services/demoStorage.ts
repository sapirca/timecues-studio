// localStorage-backed annotation store for Demo Mode.
//
// Goals:
//   - Demo edits NEVER hit the server (no leakage across visitors, no auth).
//   - Edits survive refresh on the same browser. They die when the user
//     clears site data ("clear cache / cookies").
//   - The shape of stored payloads mirrors what the server would have
//     written, so swapping the storage backend is a 1-line change later.
//
// Keys are namespaced under "tc:demo:" + kind + ":" + slug to keep demo
// data clearly separated from any other localStorage we own.

import type { AutoGuessManualAnnotation } from '../types/autoGuess';
import type { AutoGuessSongStatus } from './autoGuessAnnotations';
import type { SongInfo } from '../types/songInfo';

// Annotation LAYERS (boundaries, cues, spans, …) are deliberately absent:
// they were never mirrored here, and a demo visitor's layers go to the server
// under the `demo-anonymous` annotator id like any other annotator's would.
// Only the two kinds that have their own document and no layer equivalent
// live in localStorage.
type Kind = 'autoGuess' | 'songInfo';

function key(kind: Kind, slug: string): string {
  return `tc:demo:${kind}:${slug}`;
}

function safeGet<T>(k: string): T | null {
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function safeSet(k: string, v: unknown): boolean {
  try {
    localStorage.setItem(k, JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
}

function safeDel(k: string): boolean {
  try {
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

// ─── Auto-guess ────────────────────────────────────────────────────────────────

// ─── Auto-guess ──────────────────────────────────────────────────────────────

export function demoLoadAutoGuess(slug: string): AutoGuessManualAnnotation | null {
  return safeGet<AutoGuessManualAnnotation>(key('autoGuess', slug));
}
export function demoSaveAutoGuess(slug: string, ann: AutoGuessManualAnnotation): boolean {
  return safeSet(key('autoGuess', slug), ann);
}
export function demoDeleteAutoGuess(slug: string): boolean {
  return safeDel(key('autoGuess', slug));
}

// ─── Song info (BPM / time signature / grid offset) ──────────────────────────
//
// Demo users can edit BPM and align the grid in /prep; the result is stored
// here so the edit survives a refresh without touching the canonical
// `data/song-info/*.json` on the server.

export function demoLoadSongInfo(slug: string): SongInfo | null {
  return safeGet<SongInfo>(key('songInfo', slug));
}
export function demoSaveSongInfo(slug: string, info: SongInfo): boolean {
  return safeSet(key('songInfo', slug), info);
}

// ─── Status sweep (for loadAllAutoGuessStatuses parity) ──────────────────────

/** Build the same {slug → AutoGuessSongStatus} map the server's LIST endpoint
 *  returns, but from localStorage. Used by Demo mode so the sidebar's
 *  has-annotation indicator behaves correctly. */
export function demoLoadAllAutoGuessStatuses(): Record<string, AutoGuessSongStatus> {
  const out: Record<string, AutoGuessSongStatus> = {};
  const prefix = 'tc:demo:autoGuess:';
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const slug = k.slice(prefix.length);
      const ann = safeGet<AutoGuessManualAnnotation>(k);
      if (!ann) continue;
      out[slug] = {
        slug,
        auto_guess_status: ann.auto_guess_status,
        points_count: ann.points?.length ?? 0,
      };
    }
  } catch {
    // ignore — caller treats {} as "no annotations".
  }
  return out;
}

/** Count distinct song slugs that have any user-authored demo work held in
 *  localStorage. Auto-guess is excluded because it's cached algorithm output,
 *  not something the user typed; annotation layers are excluded because they
 *  live on the server under `demo-anonymous`, not here. Used to decide whether
 *  exiting demo needs a confirmation prompt. */
export function demoCountSavedWork(): number {
  const slugs = new Set<string>();
  const userKinds: Kind[] = ['songInfo'];
  const prefixes = userKinds.map((k) => `tc:demo:${k}:`);
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      for (const p of prefixes) {
        if (k.startsWith(p)) { slugs.add(k.slice(p.length)); break; }
      }
    }
  } catch {
    // ignore — caller treats 0 as "nothing to lose".
  }
  return slugs.size;
}

/** Wipe every demo-namespaced key. Called by the "Reset demo" affordance and
 *  surfaced to users as "clear browser cache/cookies clears the demo." */
export function demoClearAll(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('tc:demo:')) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch {
    // best-effort
  }
}
