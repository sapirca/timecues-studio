// PANNs AudioSet-527 tagging — talks to the Python panns server (proxied at
// /api/panns). SPAN-family. Experimental: gated by `experimentalSpanFamily`.

export interface PannsSpanResult {
  start: number;
  end: number;
  label: string;
  confidence: number;
}

export interface PannsDetectionResult {
  slug: string;
  audio_file: string;
  algorithm: string;
  duration: number;
  spans: PannsSpanResult[];
  ok: boolean;
  error?: string | null;
  ms: number;
  computed_at: string;
}

export interface PannsAlgorithmInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
}

export async function listPannsAlgorithms(): Promise<PannsAlgorithmInfo[] | null> {
  try {
    const res = await fetch('/api/panns/algorithms');
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data as PannsAlgorithmInfo[] : null;
  } catch { return null; }
}

export async function loadCachedPanns(slug: string, algo: string): Promise<PannsDetectionResult | null> {
  try {
    const res = await fetch(`/api/panns/detect/${encodeURIComponent(slug)}/${encodeURIComponent(algo)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data && typeof data === 'object' && 'spans' in data) ? data as PannsDetectionResult : null;
  } catch { return null; }
}

export async function runPannsDetection(slug: string, algo: string, force = false): Promise<PannsDetectionResult | null> {
  try {
    const res = await fetch('/api/panns/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, algo, force }),
    });
    if (!res.ok) return null;
    return await res.json() as PannsDetectionResult;
  } catch { return null; }
}

export async function initializePannsAlgorithm(algo: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/panns/initialize', {
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
