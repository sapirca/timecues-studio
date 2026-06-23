// Whisper-base vocal transcription — talks to the Python lyrics_server
// (proxied at /api/lyrics). LYRICS family. Experimental: gated by
// `experimentalLyricsFamily`.

export interface LyricsWordEntry {
  time: number;
  end: number;
  text: string;
  kind: 'word' | 'line';
}

export interface LyricsDetectionResult {
  slug: string;
  audio_file: string;
  algorithm: string;
  duration: number;
  language: string | null;
  words: LyricsWordEntry[];
  lines: LyricsWordEntry[];
  ok: boolean;
  error?: string | null;
  ms: number;
  computed_at: string;
}

export interface LyricsAlgorithmInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
}

export async function listLyricsAlgorithms(): Promise<LyricsAlgorithmInfo[] | null> {
  try {
    const res = await fetch('/api/lyrics/algorithms');
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data as LyricsAlgorithmInfo[] : null;
  } catch { return null; }
}

export async function loadCachedLyrics(slug: string, algo: string): Promise<LyricsDetectionResult | null> {
  try {
    const res = await fetch(`/api/lyrics/detect/${encodeURIComponent(slug)}/${encodeURIComponent(algo)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data && typeof data === 'object' && 'words' in data) ? data as LyricsDetectionResult : null;
  } catch { return null; }
}

export async function runLyricsDetection(
  slug: string, algo: string,
  opts: { force?: boolean; language?: string; text?: string } = {},
): Promise<LyricsDetectionResult | null> {
  try {
    const res = await fetch('/api/lyrics/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, algo, ...opts }),
    });
    if (!res.ok) return null;
    return await res.json() as LyricsDetectionResult;
  } catch { return null; }
}

export async function initializeLyricsAlgorithm(algo: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/lyrics/initialize', {
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
