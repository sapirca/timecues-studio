// MIR-Eval client — talks to the Python mir_eval server (proxied at /api/mir-eval).
//
// All boundary P/R/F numbers reported in the dashboard come from the upstream
// `mir_eval` library via this client; there is no client-side reimplementation.
// Equivalence is asserted by tools/python/tests/test_mir_eval_pairs.py.
//
// Server start:  python tools/python/mir_eval_server.py

import { useEffect, useMemo, useRef, useState } from 'react';

// ─── Wire types ──────────────────────────────────────────────────────────────

export interface MirEvalPair {
  /** Reference boundary times in seconds (user manual). */
  refTimes: number[];
  /** Estimated boundary times in seconds (algorithm output). */
  estTimes: number[];
  /** Tolerance window in seconds (default 0.5 server-side). */
  tolerance: number;
  /** Track duration in seconds — required so the server can build [0, T] intervals. */
  trackDuration: number;
}

export interface MirEvalPairWithId extends MirEvalPair {
  id: string;
}

export interface MirEvalResult {
  precision: number;
  recall: number;
  fmeasure: number;
  /** Original ref boundary count (before any server-side normalization). */
  refCount: number;
  /** Original est boundary count. */
  estCount: number;
  /** True positives — derived from precision × scored est count. */
  hitCount: number;
  tolerance: number;
  /** Per-ref nearest-est distance, in caller order. For per-marker UI coloring. */
  t2eErrors: number[];
  /** Per-est nearest-ref distance, in caller order. */
  e2tErrors: number[];
}

export type MirEvalEntry = MirEvalResult | { error: string };
export type MirEvalResponse = Record<string, MirEvalEntry>;

export function isMirEvalResult(entry: MirEvalEntry | null | undefined): entry is MirEvalResult {
  return !!entry && !('error' in entry);
}

// ─── Fetch ───────────────────────────────────────────────────────────────────

export async function fetchMirEvalPairs(
  pairs: MirEvalPairWithId[],
  signal?: AbortSignal,
): Promise<MirEvalResponse> {
  const res = await fetch('/api/mir-eval/pairs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairs }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`mir-eval server error ${res.status}: ${text || res.statusText}`);
  }
  const data = await res.json() as { results?: MirEvalResponse };
  return data.results ?? {};
}

// ─── React hook (debounced) ──────────────────────────────────────────────────

export interface UseMirEvalState {
  results: MirEvalResponse | null;
  loading: boolean;
  error: string | null;
}

/**
 * Debounced fetch of `/api/mir-eval/pairs`. Re-fires when `pairs` changes,
 * after `debounceMs` of stillness. In-flight requests are aborted when a new
 * one supersedes them.
 *
 * The caller is responsible for memoizing `pairs` (typically inside a
 * `useMemo`) so reference equality reflects content equality — this hook
 * uses a JSON-stringify key for change detection but referentially stable
 * inputs let React skip re-running the effect setup.
 */
export function useMirEvalPairs(
  pairs: MirEvalPairWithId[] | null,
  debounceMs = 400,
): UseMirEvalState {
  const [state, setState] = useState<UseMirEvalState>({
    results: null, loading: false, error: null,
  });
  const abortRef = useRef<AbortController | null>(null);
  const key = useMemo(() => (pairs?.length ? JSON.stringify(pairs) : ''), [pairs]);

  useEffect(() => {
    if (!pairs || pairs.length === 0) {
      abortRef.current?.abort();
      setState({ results: null, loading: false, error: null });
      return;
    }

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    const timer = window.setTimeout(() => {
      fetchMirEvalPairs(pairs, ac.signal)
        .then((results) => {
          if (ac.signal.aborted) return;
          setState({ results, loading: false, error: null });
        })
        .catch((err: unknown) => {
          if (ac.signal.aborted) return;
          const msg = err instanceof Error ? err.message : String(err);
          setState((prev) => ({ ...prev, loading: false, error: msg }));
        });
    }, debounceMs);

    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  // `key` captures content equality; including `pairs` would re-fire on every
  // render of the parent even when the input is unchanged. eslint-disable...
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, debounceMs]);

  return state;
}

/** Convenience wrapper for the common single-pair case. */
export function useMirEvalSingle(
  pair: MirEvalPair | null,
  debounceMs?: number,
): { result: MirEvalResult | null; loading: boolean; error: string | null } {
  const pairs = useMemo<MirEvalPairWithId[] | null>(
    () => (pair ? [{ ...pair, id: '_single' }] : null),
    [pair],
  );
  const { results, loading, error } = useMirEvalPairs(pairs, debounceMs);
  const entry = results?.['_single'] ?? null;
  return {
    result: isMirEvalResult(entry) ? entry : null,
    loading,
    error: entry && 'error' in entry ? entry.error : error,
  };
}
