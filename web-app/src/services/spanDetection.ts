// SPAN-family detection — talks to the Python span server (proxied at /api/span).
//
// Experimental: gated by the `experimentalSpanFamily` user setting and by the
// `experimental-models` docker compose profile being up. When either is off,
// the calls below return null instead of throwing, so consumers can degrade
// quietly without breaking the page.
//
// Server start (docker):
//   docker compose --profile experimental-models up --build span
// Server start (manual, requires torch + torchaudio + librosa locally):
//   python tools/python/span_server.py

export interface SpanItemResult {
  /** Start time of the span in seconds. */
  start: number;
  /** End time of the span in seconds. */
  end: number;
  /** Coarse label, e.g. "voice", "instrumental", or an instrument family name. */
  label: string;
  /** Optional 0..1 confidence. Null when the detector doesn't expose one. */
  confidence: number | null;
}

export interface SpanDetectionResult {
  slug: string;
  audio_file: string;
  /** Detector id, e.g. "silero-vad", "jdcnet-voicing". */
  algorithm: string;
  duration: number;
  spans: SpanItemResult[];
  ok: boolean;
  error?: string | null;
  ms: number;
  computed_at: string;
}

export interface SpanAlgorithmInfo {
  id: string;
  name: string;
  description: string;
  /** False when the underlying dependency / weights aren't installed. The UI
   *  should grey out the option in that case. */
  available: boolean;
}

/** List the detectors the SPAN server is willing to run. Returns null if the
 *  server isn't reachable (which is the expected state when the experimental
 *  profile isn't running — don't treat it as an error). */
export async function listSpanAlgorithms(): Promise<SpanAlgorithmInfo[] | null> {
  try {
    const res = await fetch('/api/span/algorithms');
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data as SpanAlgorithmInfo[] : null;
  } catch {
    return null;
  }
}

/** Read a cached SPAN detection. Returns null if no cache exists or the
 *  server is unreachable. */
export async function loadCachedSpan(slug: string, algo: string): Promise<SpanDetectionResult | null> {
  try {
    const res = await fetch(`/api/span/detect/${encodeURIComponent(slug)}/${encodeURIComponent(algo)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data && typeof data === 'object' && 'spans' in data) ? data as SpanDetectionResult : null;
  } catch {
    return null;
  }
}

/** Warm a SPAN detector's weights without running detection. Drives the
 *  "Initialize models" experimental settings panel. Returns the server's
 *  `{ok, error?}` envelope so the UI can show why initialization failed
 *  (e.g. torch missing in the container). */
export async function initializeSpanAlgorithm(algo: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/span/initialize', {
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

/** Run one SPAN-family detector on the song. `force=true` skips the cache. */
export async function runSpanDetection(
  slug: string,
  algo: string,
  force = false,
): Promise<SpanDetectionResult | null> {
  try {
    const res = await fetch('/api/span/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, algo, force }),
    });
    if (!res.ok) return null;
    return await res.json() as SpanDetectionResult;
  } catch {
    return null;
  }
}
