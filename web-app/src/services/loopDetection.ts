// LOOP-family detection — talks to the Python loop server (proxied at
// /api/loop). Pure DSP; no model weights so the chip never shows
// "Downloading…" — only "Server off" when the experimental-models profile
// isn't running. Experimental: gated by `experimentalLoopFamily`.

export interface LoopItemResult {
  start: number;
  end: number;
  label: string;
  bars: number | null;
  confidence: number;
}

export interface LoopDetectionResult {
  slug: string;
  audio_file: string;
  algorithm: string;
  duration: number;
  loops: LoopItemResult[];
  ok: boolean;
  error?: string | null;
  ms: number;
  computed_at: string;
}

export interface LoopAlgorithmInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
}

export async function listLoopAlgorithms(): Promise<LoopAlgorithmInfo[] | null> {
  try {
    const res = await fetch('/api/loop/algorithms');
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data as LoopAlgorithmInfo[] : null;
  } catch { return null; }
}

export async function loadCachedLoop(slug: string, algo: string): Promise<LoopDetectionResult | null> {
  try {
    const res = await fetch(`/api/loop/detect/${encodeURIComponent(slug)}/${encodeURIComponent(algo)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data && typeof data === 'object' && 'loops' in data) ? data as LoopDetectionResult : null;
  } catch { return null; }
}

export async function runLoopDetection(slug: string, algo: string, force = false): Promise<LoopDetectionResult | null> {
  try {
    const res = await fetch('/api/loop/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, algo, force }),
    });
    if (!res.ok) return null;
    return await res.json() as LoopDetectionResult;
  } catch { return null; }
}

export async function initializeLoopAlgorithm(algo: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/loop/initialize', {
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
