/**
 * The edit lease for one shared song, as React state.
 *
 * A collaborative song opens read-only. Taking the lock and handing it back
 * are both deliberate acts — this hook never acquires on your behalf, and
 * never releases behind your back, because a lock that moves on its own is
 * exactly what the explicit model exists to avoid.
 *
 * While you hold it, the tab beats once a minute so the rest of the team can
 * tell "Alice is editing" from "Alice's tab closed 8 minutes ago". The beat is
 * gated on visibility: a hidden tab stops beating, so silence means nobody is
 * looking at this song rather than merely that a browser process exists.
 * Coming back to the tab beats immediately and silently reclaims the lease if
 * nobody took it in the meantime.
 *
 * Solo songs short-circuit the whole thing: `shared` is false and no request
 * is ever made.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchLock, lockSong, unlockSong, takeOverSong, heartbeat,
  stanceFor, type LockOutcome, type LockState, type LockStance, type LockView,
} from '../services/annotationLocks';
import { getCurrentAnnotatorId } from '../context/AnnotatorContext';

/** How often the holder's tab re-asserts the lease. Must stay below the
 *  server's stale window (3 beats) — see server/sharedAnnotations.ts. */
const HEARTBEAT_MS = 60_000;
/** How often a NON-holder re-checks, so "Alice is editing" turns back into
 *  "no one is editing" without a page reload. Slower: nothing depends on it
 *  being fresh to the second. */
const WATCH_MS = 30_000;

export interface AnnotationLockApi {
  /** Is this song collaborative at all? False for ordinary per-annotator songs. */
  shared: boolean;
  lock: LockView | null;
  stance: LockStance;
  /** Whether YOU may write to this song right now. Always true for a solo
   *  song; for a shared one, true only while you hold the lease. */
  canEdit: boolean;
  youAre: string | null;
  busy: boolean;
  error: string | null;
  takeLock: () => Promise<void>;
  releaseLock: () => Promise<void>;
  takeOver: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useAnnotationLock(slug: string | null): AnnotationLockApi {
  // State is stored WITH the song it describes, and read back only when the
  // two still match. That way switching songs needs no clearing effect — the
  // previous song's holder simply stops being current — and a response that
  // lands after the switch can never be shown under the wrong song.
  const [stored, setStored] = useState<{ slug: string; value: LockState | null } | null>(null);
  const [failure, setFailure] = useState<{ slug: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const youAre = getCurrentAnnotatorId();

  // Which song the UI is on *now*, for discarding late responses. Updated in
  // an effect (never during render) and declared first, so it is current
  // before any effect below reads it.
  const slugRef = useRef<string | null>(slug);
  useEffect(() => { slugRef.current = slug; }, [slug]);

  const state = stored && stored.slug === slug ? stored.value : null;
  const error = failure && failure.slug === slug ? failure.message : null;

  const apply = useCallback((next: LockState | null, forSlug: string) => {
    if (slugRef.current !== forSlug) return;
    setStored({ slug: forSlug, value: next });
  }, []);

  const refresh = useCallback(async () => {
    const s = slugRef.current;
    if (!s) return;
    apply(await fetchLock(s), s);
  }, [apply]);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    void fetchLock(slug).then((v) => { if (!cancelled) setStored({ slug, value: v }); });
    return () => { cancelled = true; };
  }, [slug]);

  const shared = state?.shared ?? false;
  const lock = state?.lock ?? null;
  const stance = stanceFor(lock, youAre);
  const holding = shared && stance === 'yours';

  // Heartbeat while holding AND visible. Losing the lease to another tab (or
  // to a take-over) comes back as a 409 carrying the current lease — so the
  // losing tab learns who has it now from the same round trip.
  useEffect(() => {
    if (!holding || !slug) return;
    let cancelled = false;
    const beat = async () => {
      if (document.visibilityState !== 'visible') return;
      const r = await heartbeat(slug);
      if (cancelled) return;
      if (r.ok) apply(r.state, slug);
      else {
        apply(r.conflict, slug);
        setFailure({ slug, message: r.error });
      }
    };
    const id = window.setInterval(() => { void beat(); }, HEARTBEAT_MS);
    // Coming back to a hidden tab beats at once: while hidden we deliberately
    // stop, so the lease may be a minute stale the moment you return.
    const onVisible = () => { if (document.visibilityState === 'visible') void beat(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [holding, slug, apply]);

  // Watch someone else's lease, so it stops saying "Alice is editing" once she
  // has handed the song back.
  useEffect(() => {
    if (!shared || holding || !slug) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, WATCH_MS);
    return () => window.clearInterval(id);
  }, [shared, holding, slug, refresh]);

  const run = useCallback(async (fn: (s: string) => Promise<LockOutcome>) => {
    const s = slugRef.current;
    if (!s) return;
    setBusy(true);
    setFailure(null);
    const r = await fn(s);
    if (r.ok) apply(r.state, s);
    else {
      setFailure({ slug: s, message: r.error });
      if (r.conflict) apply(r.conflict, s);
      else await refresh();
    }
    setBusy(false);
  }, [apply, refresh]);

  return {
    shared,
    lock,
    stance,
    canEdit: !shared || stance === 'yours',
    youAre,
    busy,
    error,
    takeLock: useCallback(() => run(lockSong), [run]),
    releaseLock: useCallback(() => run(unlockSong), [run]),
    takeOver: useCallback(() => run(takeOverSong), [run]),
    refresh,
  };
}
