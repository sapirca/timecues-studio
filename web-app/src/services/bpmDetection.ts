// BPM detection — talks to the Python BPM server (proxied at /api/bpm).
//
// Each detector returns its own estimate; we surface every estimate and let
// the user pick. The server caches results to bpm-detections/<slug>.json.
//
// Server start:  python tools/python/bpm_server.py

export interface BpmCandidate {
  bpm: number;
  strength: number;
}

export interface BpmAlgorithmResult {
  /** Detector identifier, e.g. 'librosa-beat-track', 'madmom-tempo'. */
  source: string;
  ok: boolean;
  bpm?: number;
  /** Beat timestamps in seconds (only some detectors return these). */
  beat_times?: number[];
  /** Multiple tempo candidates with strengths (madmom-tempo). */
  candidates?: BpmCandidate[];
  /** Error message when ok=false. */
  error?: string;
  /** Wall-clock detector runtime in milliseconds. */
  ms?: number;
}

export interface BpmDetectionResult {
  slug: string;
  audio_file: string;
  duration: number;
  algorithms: BpmAlgorithmResult[];
  computed_at: string;
}

/** Read a cached BPM detection result. Returns null if no cache exists or the
 *  server is unreachable. */
export async function loadCachedBpm(slug: string): Promise<BpmDetectionResult | null> {
  try {
    const res = await fetch(`/api/bpm/detect/${encodeURIComponent(slug)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data && typeof data === 'object' && 'algorithms' in data) ? data as BpmDetectionResult : null;
  } catch {
    return null;
  }
}

/** Run every available detector on the song. `force=true` skips the cache. */
export async function runBpmDetection(slug: string, force = false): Promise<BpmDetectionResult | null> {
  try {
    const res = await fetch('/api/bpm/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, force }),
    });
    if (!res.ok) return null;
    return await res.json() as BpmDetectionResult;
  } catch {
    return null;
  }
}

/** Convenience: cached → fall back to fresh run. */
export async function getOrRunBpmDetection(slug: string): Promise<BpmDetectionResult | null> {
  const cached = await loadCachedBpm(slug);
  if (cached) return cached;
  return runBpmDetection(slug, false);
}

// ─── Tempo curve (per-frame BPM trace) ───────────────────────────────────────
//
// Returned by the Python server's /api/bpm/tempo-curve endpoint. Feeds the
// Dynamic-mode anchor derivation in anchorEdit.ts (anchorsFromTempoCurve).

export interface TempoCurveResult {
  slug: string;
  audio_file: string;
  duration: number;
  curve: {
    source: string;
    ok: boolean;
    frame_times?: number[];
    bpms?: number[];
    hop_length?: number;
    sr?: number;
    error?: string;
    ms?: number;
  };
  computed_at: string;
}

/** Read a cached tempo curve. null = no cache yet (or server unreachable). */
export async function loadCachedTempoCurve(slug: string): Promise<TempoCurveResult | null> {
  try {
    const res = await fetch(`/api/bpm/tempo-curve/${encodeURIComponent(slug)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data && typeof data === 'object' && 'curve' in data) ? data as TempoCurveResult : null;
  } catch {
    return null;
  }
}

/** Compute (and cache) the tempo curve. `force=true` ignores the cache. */
export async function runTempoCurve(slug: string, force = false): Promise<TempoCurveResult | null> {
  try {
    const res = await fetch('/api/bpm/tempo-curve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, force }),
    });
    if (!res.ok) return null;
    return await res.json() as TempoCurveResult;
  } catch {
    return null;
  }
}
