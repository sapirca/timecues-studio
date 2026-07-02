import { useCallback, useEffect, useState } from 'react';

// ─── Demucs stems — shared run/poll/cancel/kill logic ──────────────────────────
// This hook is the SINGLE source of truth for triggering a per-song Demucs
// stem-separation job and tracking its progress. It was lifted verbatim out of
// InspectorPageV2 (Dataset Prep sidebar) so the Playground can reuse the exact
// same backend flow — POST /api/run-demucs/<id>, poll status, parse tqdm,
// cancel/kill — without a second copy drifting out of sync. The UI around it
// (StemSourcePicker vs. the Playground's compact panel) differs; the job
// lifecycle here does not.

/** A song's stem manifest at /stems/<filename-stem>/manifest.json — maps each
 *  Demucs source to its on-disk URL. Absent stems are simply missing keys. */
export interface StemManifest {
  stems: Partial<Record<'vocals' | 'drums' | 'bass' | 'other' | 'guitar' | 'piano', string>>;
}

/** The six htdemucs_6s stems, in SOURCE-picker order (mix is the whole track,
 *  not a separated stem, so it's excluded here). */
export const ALL_DEMUCS_STEMS = ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'] as const;
export type DemucsStem = (typeof ALL_DEMUCS_STEMS)[number];

/** Stems present in a manifest, in canonical order. Empty when not demuxed. */
export function stemsFromManifest(m: StemManifest | null): DemucsStem[] {
  if (!m) return [];
  return ALL_DEMUCS_STEMS.filter((s) => !!m.stems[s]);
}

// Derive the raw filename stem (no extension) from an /audio/<name>.mp3 URL.
// Stems on disk live under that exact name — see web-app/public/stems/<stem>/.
export function stemSlugFromUrl(url: string): string {
  const last = url.split('/').pop() ?? url;
  return decodeURIComponent(last).replace(/\.[^.]+$/, '');
}

export async function fetchStemManifest(audioUrl: string): Promise<StemManifest | null> {
  const slug = stemSlugFromUrl(audioUrl);
  try {
    const res = await fetch(`/stems/${encodeURIComponent(slug)}/manifest.json`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data !== 'object' || !data.stems) return null;
    return data as StemManifest;
  } catch {
    return null;
  }
}

/** Minimal song shape the runner needs: `id` keys the run endpoint, `url`
 *  locates the stem manifest, `name` is shown in the overwrite prompt. */
export interface StemRunTarget {
  id: string;
  name: string;
  url: string;
}

export interface DemucsJob {
  slug: string;
  jobId: string;
  status: string;
  logs: string;
  startedAt: number;
  progressPct?: number;
  lastLine?: string;
  cancelMode?: 'soft' | 'hard';
}

export interface UseDemucsStemsResult {
  /** The in-flight (or last-terminal) job, or null when idle. */
  job: DemucsJob | null;
  /** Kick off (or overwrite, after confirm) stem separation for `audio`. */
  runStems: (audio: StemRunTarget) => Promise<void>;
  /** SIGINT the subprocess — graceful, lands between chunks. */
  cancelStems: () => Promise<void>;
  /** SIGKILL the subprocess group — immediate. */
  killStems: () => Promise<void>;
  /** Clear a terminal error pill. */
  dismissError: () => void;
  /** Seconds since the current job started (advances every second). */
  elapsedSec: number;
}

/**
 * Owns the Demucs stem-separation job lifecycle.
 *
 * @param onComplete Called after a job reaches a terminal status with a fresh
 *   manifest fetch for the song — lets the caller refresh its "available stems"
 *   view. Receives the same `audio` that was passed to `runStems`.
 */
export function useDemucsStems(opts?: {
  onComplete?: (audio: StemRunTarget, manifest: StemManifest | null) => void;
}): UseDemucsStemsResult {
  const [job, setJob] = useState<DemucsJob | null>(null);
  // Wall-clock sampled once per second while a job runs, so callers' MM:SS
  // readouts advance between the 2-second status polls. Kept in state (rather
  // than reading Date.now() during render) so the render stays pure.
  const [nowMs, setNowMs] = useState(0);

  const onComplete = opts?.onComplete;

  const runStems = useCallback(async (audio: StemRunTarget) => {
    if (job?.status === 'running') {
      alert('A Demucs stem job is already running. Wait for it to finish before starting another.');
      return;
    }
    // Surface a client-side error as the persistent red pill AND console.
    // Every catch in this function routes through fail() so nothing fails
    // silently — the user can always inspect what went wrong via the pill's
    // modal or by filtering devtools for "[stems]".
    const fail = (where: string, err: unknown, extra?: string) => {
      const msg = err instanceof Error
        ? `${err.name}: ${err.message}${err.stack ? '\n' + err.stack : ''}`
        : err == null ? '' : String(err);
      console.error(`[stems] ${where}`, err, extra ?? '');
      const body = [`[client] ${where}`, msg, extra].filter(Boolean).join('\n');
      setJob({
        slug: audio.id,
        jobId: '(client-error)',
        status: 'error',
        logs: body,
        startedAt: Date.now(),
      });
    };
    try {
      const existing = await fetchStemManifest(audio.url).catch((e) => {
        console.warn('[stems] pre-check fetchStemManifest failed (continuing):', e);
        return null;
      });
      if (existing) {
        const ok = confirm(
          `Stems for "${audio.name}" already exist.\n` +
          `Re-running Demucs will overwrite them. Continue?`,
        );
        if (!ok) return;
      }
      let res: Response;
      try {
        res = await fetch(`/api/run-demucs/${encodeURIComponent(audio.id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: !!existing }),
        });
      } catch (e) {
        fail('POST /api/run-demucs network error', e);
        return;
      }
      const rawBody = await res.text().catch((e) => {
        console.error('[stems] response.text() failed:', e);
        return '';
      });
      if (!res.ok) {
        fail('POST /api/run-demucs returned non-OK', null, `HTTP ${res.status}\n${rawBody.slice(0, 600)}`);
        return;
      }
      let data: { jobId?: string } = {};
      try { data = JSON.parse(rawBody); }
      catch (e) { console.error('[stems] start response JSON parse failed:', e, { body: rawBody }); }
      if (!data.jobId) {
        fail('start response missing jobId', null, `body: ${rawBody.slice(0, 600)}`);
        return;
      }
      const jobId: string = data.jobId;
      console.log('[stems] job started', { jobId, slug: audio.id });
      const startedAt = Date.now();
      setNowMs(startedAt);
      setJob({ slug: audio.id, jobId, status: 'running', logs: '', startedAt });
      let lastLogsLen = 0;
      let lastStatus: { status: string; logs: string } = { status: 'running', logs: '' };
      while (true) {
        await new Promise((r) => setTimeout(r, 2000));
        // Per-poll fetch + JSON parse can fail independently (network blip,
        // server restart, malformed body). Catch each separately and log
        // with the actual error so the user can tell flaky polling apart
        // from a genuine Demucs failure.
        let status: { status: string; logs: string };
        try {
          const statusRes = await fetch(`/api/run-demucs/status/${encodeURIComponent(jobId)}`);
          if (!statusRes.ok) {
            const body = await statusRes.text().catch(() => '');
            console.error('[stems] status poll non-OK', { httpStatus: statusRes.status, body: body.slice(0, 400) });
            status = { status: 'error', logs: `[client] status poll returned HTTP ${statusRes.status}\n${body.slice(0, 400)}` };
          } else {
            status = await statusRes.json();
          }
        } catch (e) {
          console.error('[stems] status poll failed:', e);
          status = { status: 'error', logs: `[client] status poll failed: ${e instanceof Error ? e.message : String(e)}` };
        }
        lastStatus = status;
        // Stream new log output to the devtools console as it arrives so the
        // user can debug stuck/failing jobs without docker logs access.
        const logs: string = status.logs ?? '';
        if (logs.length > lastLogsLen) {
          const delta = logs.slice(lastLogsLen);
          console.log('[stems]', delta.replace(/\n+$/, ''));
          lastLogsLen = logs.length;
        }
        // Parse Demucs's tqdm output for the running pill. tqdm overwrites
        // the same line with \r so we split on both \r and \n and take the
        // rightmost non-empty token as the "current step" subtitle. The
        // rightmost \d+% inside that token is the progress bar percentage.
        const tokens = logs.split(/[\r\n]+/);
        let lastLine: string | undefined;
        for (let i = tokens.length - 1; i >= 0; i--) {
          const t = tokens[i].trim();
          if (t.length > 0) { lastLine = t.slice(0, 140); break; }
        }
        const pctMatch = lastLine?.match(/(\d{1,3})%/);
        const progressPct = pctMatch
          ? Math.min(100, Math.max(0, parseInt(pctMatch[1], 10)))
          : undefined;
        const cancelMode = (status as { cancelMode?: 'soft' | 'hard' }).cancelMode;
        setJob((prev) => prev && prev.jobId === jobId
          ? { ...prev, status: status.status, logs, progressPct, lastLine, cancelMode }
          : prev);
        if (status.status !== 'running') break;
      }
      // Terminal status: log to console; the persistent red "Stems failed —
      // view log" pill surfaces failure (with a click-to-open modal showing
      // the log tail), so we no longer fire an alert() that the user might
      // miss or dismiss.
      if (lastStatus.status === 'error') {
        console.error(`[stems] job ${jobId} failed:\n${lastStatus.logs || '(no logs returned)'}`);
      } else if (lastStatus.status === 'cancelled') {
        console.warn(`[stems] job ${jobId} cancelled`);
      } else if (lastStatus.status === 'done') {
        console.log(`[stems] job ${jobId} done`);
      }
      const m = await fetchStemManifest(audio.url).catch((e) => {
        // Job succeeded but the caller's view won't refresh — log loudly so
        // the user knows why the stems stay greyed out.
        console.error('[stems] post-job fetchStemManifest failed:', e);
        return null;
      });
      onComplete?.(audio, m);
    } catch (e) {
      // Catch-all so nothing slips into an unhandled rejection. If we land
      // here the error pill + modal will tell the user what happened.
      fail('runStems unexpected throw', e);
    }
  }, [job, onComplete]);

  // Soft cancel: SIGINT the demucs subprocess. Demucs cleans up between
  // chunks, then the polling loop sees status='cancelled' and the pill
  // returns to idle. Optimistically set cancelMode='soft' so the pill flips
  // to "⌛ Cancelling…" without waiting for the next poll tick.
  const cancelStems = useCallback(async () => {
    if (!job || job.status !== 'running') return;
    setJob((prev) => prev ? { ...prev, cancelMode: 'soft' } : prev);
    try {
      const res = await fetch(`/api/run-demucs/cancel/${encodeURIComponent(job.jobId)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error('[stems] cancel returned non-OK', { status: res.status, body: body.slice(0, 400) });
      } else {
        console.log('[stems] cancel requested', { jobId: job.jobId });
      }
    } catch (e) {
      console.error('[stems] cancel request failed:', e);
    }
  }, [job]);

  // Hard kill: SIGKILL the whole subprocess group. GPU/CPU work stops
  // immediately. Same optimistic UX as cancel: pill flips to "⌛ Killing…"
  // until the polling loop confirms status='cancelled'.
  const killStems = useCallback(async () => {
    if (!job || job.status !== 'running') return;
    setJob((prev) => prev ? { ...prev, cancelMode: 'hard' } : prev);
    try {
      const res = await fetch(`/api/run-demucs/kill/${encodeURIComponent(job.jobId)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error('[stems] kill returned non-OK', { status: res.status, body: body.slice(0, 400) });
      } else {
        console.log('[stems] kill requested', { jobId: job.jobId });
      }
    } catch (e) {
      console.error('[stems] kill request failed:', e);
    }
  }, [job]);

  const dismissError = useCallback(() => setJob(null), []);

  useEffect(() => {
    if (job?.status !== 'running') return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [job?.status]);

  const elapsedSec = job?.startedAt && nowMs ? Math.max(0, Math.floor((nowMs - job.startedAt) / 1000)) : 0;

  return { job, runStems, cancelStems, killStems, dismissError, elapsedSec };
}
