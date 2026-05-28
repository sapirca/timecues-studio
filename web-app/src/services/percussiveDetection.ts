// HPSS percussive-span detector — talks to the Python percussive_server
// (proxied at /api/percussive). SPAN-family. Experimental: gated by
// `experimentalSpanFamily`.

export interface PercussiveSpanResult {
  start: number;
  end: number;
  label: string;
  confidence: number;
}

export interface PercussiveDetectionResult {
  slug: string;
  audio_file: string;
  algorithm: string;
  duration: number;
  spans: PercussiveSpanResult[];
  ok: boolean;
  error?: string | null;
  ms: number;
  computed_at: string;
}

export interface PercussiveAlgorithmInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
}

export async function listPercussiveAlgorithms(): Promise<PercussiveAlgorithmInfo[] | null> {
  try {
    const res = await fetch('/api/percussive/algorithms');
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data as PercussiveAlgorithmInfo[] : null;
  } catch { return null; }
}

export async function loadCachedPercussive(slug: string, algo: string): Promise<PercussiveDetectionResult | null> {
  try {
    const res = await fetch(`/api/percussive/detect/${encodeURIComponent(slug)}/${encodeURIComponent(algo)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data && typeof data === 'object' && 'spans' in data) ? data as PercussiveDetectionResult : null;
  } catch { return null; }
}

export async function runPercussiveDetection(slug: string, algo: string, force = false): Promise<PercussiveDetectionResult | null> {
  try {
    const res = await fetch('/api/percussive/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, algo, force }),
    });
    if (!res.ok) return null;
    return await res.json() as PercussiveDetectionResult;
  } catch { return null; }
}

export async function initializePercussiveAlgorithm(algo: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/percussive/initialize', {
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
