// CUE-family extras (key / autochord / onsets) — talks to the Python
// cue_extras_server (proxied at /api/cue-extras). Experimental: gated by
// `experimentalCueExtras`.

export interface CueExtrasCue {
  time: number;
  label: string;
  confidence: number | null;
}

export interface CueExtrasDetectionResult {
  slug: string;
  audio_file: string;
  algorithm: string;
  duration: number;
  cues: CueExtrasCue[];
  /** Only set when `algorithm === 'librosa-key'`. */
  key?: string | null;
  ok: boolean;
  error?: string | null;
  ms: number;
  computed_at: string;
}

export interface CueExtrasAlgorithmInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
}

export async function listCueExtrasAlgorithms(): Promise<CueExtrasAlgorithmInfo[] | null> {
  try {
    const res = await fetch('/api/cue-extras/algorithms');
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data as CueExtrasAlgorithmInfo[] : null;
  } catch { return null; }
}

export async function loadCachedCueExtras(slug: string, algo: string): Promise<CueExtrasDetectionResult | null> {
  try {
    const res = await fetch(`/api/cue-extras/detect/${encodeURIComponent(slug)}/${encodeURIComponent(algo)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data && typeof data === 'object' && 'cues' in data) ? data as CueExtrasDetectionResult : null;
  } catch { return null; }
}

export async function runCueExtrasDetection(slug: string, algo: string, force = false): Promise<CueExtrasDetectionResult | null> {
  try {
    const res = await fetch('/api/cue-extras/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, algo, force }),
    });
    if (!res.ok) return null;
    return await res.json() as CueExtrasDetectionResult;
  } catch { return null; }
}

export async function initializeCueExtrasAlgorithm(algo: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/cue-extras/initialize', {
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
