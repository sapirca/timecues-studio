// Per-song reference lyrics text client. Shared across annotators —
// downstream lyric aligners (Whisper, SOFA, ctc-forced-aligner) score
// their per-word timestamps against this objective truth.
// Experimental: surfaced only when `experimentalLyricsFamily` is on.

export async function loadLyricsText(slug: string): Promise<string> {
  try {
    const res = await fetch(`/api/lyrics-text/${encodeURIComponent(slug)}`);
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  }
}

export async function saveLyricsText(slug: string, text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/lyrics-text/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: text,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => ({}));
    return { ok: !!data?.ok };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
