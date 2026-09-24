// Generic HTTP client factory for the experimental ML-detector sidecars.
//
// Every family server proxied under /api/<family> exposes (a subset of) the
// same four endpoints:
//   GET  /api/<family>/algorithms
//   GET  /api/<family>/detect/<slug>/<algo>
//   POST /api/<family>/detect        { slug, algo, force }
//   POST /api/<family>/initialize    { algo }
//
// This factory collapses the near-identical fetch/try-catch bodies that used
// to be hand-rolled per family. Each family's own service file keeps its own
// exported TS types and thin named exports; only the request plumbing lives
// here. `resultMarkerField` is the property `loadCached` checks for on the
// parsed response to decide whether it looks like a valid result (rather
// than an empty/error payload).

export function createDetectionClient<TAlgoInfo, TResult>(
  family: string,
  resultMarkerField: keyof TResult,
) {
  const base = `/api/${family}`;

  /** List the detectors this family's server is willing to run. Returns null
   *  if the server isn't reachable (expected when the experimental profile
   *  isn't running — don't treat it as an error). */
  const listAlgorithms = async (): Promise<TAlgoInfo[] | null> => {
    try {
      const res = await fetch(`${base}/algorithms`);
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data) ? data as TAlgoInfo[] : null;
    } catch {
      return null;
    }
  };

  /** Read a cached detection. Returns null when no cache exists or the
   *  server isn't reachable. */
  const loadCached = async (slug: string, algo: string): Promise<TResult | null> => {
    try {
      const res = await fetch(`${base}/detect/${encodeURIComponent(slug)}/${encodeURIComponent(algo)}`);
      if (!res.ok) return null;
      const data = await res.json();
      return (data && typeof data === 'object' && resultMarkerField in data) ? data as TResult : null;
    } catch {
      return null;
    }
  };

  /** Run one detector on the song. `force=true` skips the cache. */
  const runDetection = async (slug: string, algo: string, force = false): Promise<TResult | null> => {
    try {
      const res = await fetch(`${base}/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, algo, force }),
      });
      if (!res.ok) return null;
      return await res.json() as TResult;
    } catch {
      return null;
    }
  };

  /** Warm a detector's weights without running detection. Returns the
   *  server's `{ok, error?}` envelope so the UI can show why it failed. */
  const initializeAlgorithm = async (algo: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`${base}/initialize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algo }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data?.error ?? `HTTP ${res.status}` };
      return { ok: !!data?.ok, error: data?.error };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  };

  return { listAlgorithms, loadCached, runDetection, initializeAlgorithm };
}
