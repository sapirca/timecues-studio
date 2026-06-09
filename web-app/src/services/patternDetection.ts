// PATTERN-family detection — talks to the Python pattern server (proxied at
// /api/pattern). LoCoMotif uses numba JIT so the first call after server
// boot pays a ~15 s warm-up cost; subsequent calls are fast.
// Experimental: gated by `experimentalPatternFamily`.

export interface PatternItemResult {
  start: number;
  end: number;
  label: string;
  motif_id: number;
  occurrence_index: number;
  occurrence_count: number;
  confidence: number;
}

export interface PatternDetectionResult {
  slug: string;
  audio_file: string;
  algorithm: string;
  duration: number;
  patterns: PatternItemResult[];
  ok: boolean;
  error?: string | null;
  ms: number;
  computed_at: string;
}

export interface PatternAlgorithmInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
}

export async function listPatternAlgorithms(): Promise<PatternAlgorithmInfo[] | null> {
  try {
    const res = await fetch('/api/pattern/algorithms');
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data as PatternAlgorithmInfo[] : null;
  } catch { return null; }
}

export async function loadCachedPattern(slug: string, algo: string): Promise<PatternDetectionResult | null> {
  try {
    const res = await fetch(`/api/pattern/detect/${encodeURIComponent(slug)}/${encodeURIComponent(algo)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data && typeof data === 'object' && 'patterns' in data) ? data as PatternDetectionResult : null;
  } catch { return null; }
}

export async function runPatternDetection(slug: string, algo: string, force = false): Promise<PatternDetectionResult | null> {
  try {
    const res = await fetch('/api/pattern/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, algo, force }),
    });
    if (!res.ok) return null;
    return await res.json() as PatternDetectionResult;
  } catch { return null; }
}

export async function initializePatternAlgorithm(algo: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/pattern/initialize', {
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
}
