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

import type {
  ManualAnnotation,
  AutoGuessManualAnnotation,
  AnnotationStatus,
} from '../types/manualAnnotation';
import type { SongInfo } from '../types/songInfo';

type Kind = 'manual' | 'autoGuess' | 'songInfo';

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

// ─── Manual ────────────────────────────────────────────────────────────────────

export function demoLoadManual(slug: string): ManualAnnotation | null {
  return safeGet<ManualAnnotation>(key('manual', slug));
}
export function demoSaveManual(slug: string, ann: ManualAnnotation): boolean {
  return safeSet(key('manual', slug), ann);
}
export function demoDeleteManual(slug: string): boolean {
  return safeDel(key('manual', slug));
}

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

// ─── Status sweep (for loadAllStatuses parity) ───────────────────────────────

/** Build the same {slug → AnnotationStatus} map the server's bulk endpoint
 *  returns, but from localStorage. Used by Demo mode so the sidebar's
 *  has-annotation indicator behaves correctly. */
export function demoLoadAllStatuses(): Record<string, AnnotationStatus> {
  const out: Record<string, AnnotationStatus> = {};
  const prefix = 'tc:demo:manual:';
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const slug = k.slice(prefix.length);
      const ann = safeGet<ManualAnnotation>(k);
      if (!ann) continue;
      out[slug] = { slug, reviewed: false };
    }
  } catch {
    // ignore — caller treats {} as "no annotations".
  }
  return out;
}

/** Count distinct song slugs that have any user-authored demo work
 *  (manual or songInfo). Auto-guess is excluded because it's cached
 *  algorithm output, not something the user typed. Used to decide whether
 *  exiting demo needs a confirmation prompt. */
export function demoCountSavedWork(): number {
  const slugs = new Set<string>();
  const userKinds: Kind[] = ['manual', 'songInfo'];
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
