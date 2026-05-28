// basic-pitch polyphonic note transcription — talks to the Python pitch
// server (proxied at /api/pitch). CUE-family. Experimental: gated by
// `experimentalCueExtras`.

export interface PitchNoteResult {
  time: number;
  end: number;
  midi: number;
  pitch: string;
  amplitude: number;
}

export interface PitchDetectionResult {
  slug: string;
  audio_file: string;
  algorithm: string;
  duration: number;
  notes: PitchNoteResult[];
  ok: boolean;
  error?: string | null;
  ms: number;
  computed_at: string;
}

export interface PitchAlgorithmInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
}

export async function listPitchAlgorithms(): Promise<PitchAlgorithmInfo[] | null> {
  try {
    const res = await fetch('/api/pitch/algorithms');
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data as PitchAlgorithmInfo[] : null;
  } catch { return null; }
}

export async function loadCachedPitch(slug: string, algo: string): Promise<PitchDetectionResult | null> {
  try {
    const res = await fetch(`/api/pitch/detect/${encodeURIComponent(slug)}/${encodeURIComponent(algo)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data && typeof data === 'object' && 'notes' in data) ? data as PitchDetectionResult : null;
  } catch { return null; }
}

export async function runPitchDetection(slug: string, algo: string, force = false): Promise<PitchDetectionResult | null> {
  try {
    const res = await fetch('/api/pitch/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, algo, force }),
    });
    if (!res.ok) return null;
    return await res.json() as PitchDetectionResult;
  } catch { return null; }
}

export async function initializePitchAlgorithm(algo: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/pitch/initialize', {
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
