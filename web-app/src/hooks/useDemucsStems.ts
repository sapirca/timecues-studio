import { useCallback, useEffect, useRef, useState } from 'react';

// ─── Demucs stems — shared run/poll/cancel/kill logic ──────────────────────────
// This hook is the SINGLE source of truth for triggering a per-song Demucs
// stem-separation job and tracking its progress. It was lifted verbatim out of
// InspectorPageV2 (Dataset Prep sidebar) so the Playground can reuse the exact
// same backend flow — POST /api/run-demucs/<id>, poll status, parse tqdm,
// cancel/kill — without a second copy drifting out of sync. The UI around it
// (StemSourcePicker vs. the Playground's compact panel) differs; the job
// lifecycle here does not.
//
// Two entry points share that one lifecycle:
//   • runStems()     — the interactive "▶ Stem this song" button: confirms
//                      before overwriting, refuses while another job runs.
//   • enqueueStems() — the background queue that a song upload feeds. One job
//                      at a time, no prompts, songs that already have stems are
//                      skipped, and a failure doesn't stop the rest of the batch.

/** A song's stem manifest at /stems/<filename-stem>/manifest.json — maps each
 *  Demucs source to its on-disk URL. Absent stems are simply missing keys. */
export interface StemManifest {
  stems: Partial<Record<'vocals' | 'drums' | 'bass' | 'other' | 'guitar' | 'piano', string>>;
}

/** Which separation model a run should use.
 *  '6s' = htdemucs_6s — vocals/drums/bass/other/guitar/piano.
 *  '4s' = htdemucs    — vocals/drums/bass/other, appreciably quicker.
 *  The token travels verbatim to the stems daemon's `--model`. */
export type DemucsModel = '6s' | '4s';

export const DEFAULT_DEMUCS_MODEL: DemucsModel = '6s';

/** Label + tooltip for each model, so every surface that offers the choice
 *  (Dataset Prep picker, Settings) words it the same way. */
export const DEMUCS_MODEL_OPTIONS: { id: DemucsModel; label: string; hint: string }[] = [
  {
    id: '6s',
    label: '6 stems',
    hint: 'htdemucs_6s — vocals, drums, bass, other, guitar, piano. Slower, but guitar and piano land on their own tracks.',
  },
  {
    id: '4s',
    label: '4 stems',
    hint: 'htdemucs — vocals, drums, bass, other. Faster; guitar and piano stay folded into "other".',
  },
];

/** The six htdemucs_6s stems, in SOURCE-picker order (mix is the whole track,
 *  not a separated stem, so it's excluded here). The 4-stem model writes the
 *  first four; guitar/piano are simply absent from its manifest. */
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
  /** Which model this job is running — lets the UI label it "6 stems". */
  model: DemucsModel;
  /** True when the job came off the background queue rather than a button.
   *  The UI uses it to word progress as automatic rather than user-initiated. */
  auto: boolean;
}

/** Terminal outcome of one job, as seen by the queue. */
type JobOutcome = 'done' | 'error' | 'cancelled';

export interface UseDemucsStemsResult {
  /** The in-flight (or last-terminal) job, or null when idle. */
  job: DemucsJob | null;
  /** Kick off (or overwrite, after confirm) stem separation for `audio`. */
  runStems: (audio: StemRunTarget, opts?: { model?: DemucsModel }) => Promise<void>;
  /** Queue songs for background separation — one job at a time, no prompts.
   *  Songs that already have stems are skipped unless `force` is set. */
  enqueueStems: (audio: StemRunTarget[], opts?: { model?: DemucsModel; force?: boolean }) => void;
  /** Songs still waiting in the background queue (excludes the running one). */
  queued: StemRunTarget[];
  /** SIGINT the subprocess — graceful, lands between chunks. */
  cancelStems: () => Promise<void>;
  /** SIGKILL the subprocess group — immediate. */
  killStems: () => Promise<void>;
  /** Drop everything still waiting in the background queue. Does not touch the
   *  job that's already running — cancel/kill that separately. */
  clearQueue: () => void;
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
  const [queued, setQueued] = useState<StemRunTarget[]>([]);
  // Wall-clock sampled once per second while a job runs, so callers' MM:SS
  // readouts advance between the 2-second status polls. Kept in state (rather
  // than reading Date.now() during render) so the render stays pure.
  const [nowMs, setNowMs] = useState(0);

  // The queue and the "a job is in flight" flag live in refs, not state: the
  // drain loop is a plain async function and would otherwise read whatever
  // values its closure captured when it started.
  const queueRef = useRef<{ audio: StemRunTarget; model: DemucsModel; force: boolean }[]>([]);
  const busyRef = useRef(false);
  const drainingRef = useRef(false);

  // onComplete is read through a ref so the runner keeps a stable identity —
  // a caller passing an inline arrow (all of them do) would otherwise rebuild
  // every callback on each render, and the drain loop with it.
  const onCompleteRef = useRef(opts?.onComplete);
  useEffect(() => { onCompleteRef.current = opts?.onComplete; }, [opts?.onComplete]);

  /**
   * Start one Demucs job and poll it to a terminal status.
   *
   * Shared by the interactive button and the background queue; `auto` only
   * changes how things are worded and logged, never what runs. Resolves with
   * the outcome so the queue can keep going after a failure.
   */
  const startJob = useCallback(async (
    audio: StemRunTarget,
    runOpts: { model: DemucsModel; force: boolean; auto: boolean },
  ): Promise<JobOutcome> => {
    const { model, force, auto } = runOpts;
    const tag = auto ? '[stems:auto]' : '[stems]';
    // Surface a client-side error as the persistent red pill AND console.
    // Every catch in this function routes through fail() so nothing fails
    // silently — the user can always inspect what went wrong via the pill's
    // modal or by filtering devtools for "[stems]".
    const fail = (where: string, err: unknown, extra?: string): JobOutcome => {
      const msg = err instanceof Error
        ? `${err.name}: ${err.message}${err.stack ? '\n' + err.stack : ''}`
        : err == null ? '' : String(err);
      console.error(`${tag} ${where}`, err, extra ?? '');
      const body = [`[client] ${where}`, msg, extra].filter(Boolean).join('\n');
      setJob({
        slug: audio.id,
        jobId: '(client-error)',
        status: 'error',
        logs: body,
        startedAt: Date.now(),
        model,
        auto,
      });
      return 'error';
    };
    busyRef.current = true;
    try {
      let res: Response;
      try {
        res = await fetch(`/api/run-demucs/${encodeURIComponent(audio.id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force, model }),
        });
      } catch (e) {
        return fail('POST /api/run-demucs network error', e);
      }
      const rawBody = await res.text().catch((e) => {
        console.error(`${tag} response.text() failed:`, e);
        return '';
      });
      if (!res.ok) {
        return fail('POST /api/run-demucs returned non-OK', null, `HTTP ${res.status}\n${rawBody.slice(0, 600)}`);
      }
      let data: { jobId?: string } = {};
      try { data = JSON.parse(rawBody); }
      catch (e) { console.error(`${tag} start response JSON parse failed:`, e, { body: rawBody }); }
      if (!data.jobId) {
        return fail('start response missing jobId', null, `body: ${rawBody.slice(0, 600)}`);
      }
      const jobId: string = data.jobId;
      console.log(`${tag} job started`, { jobId, slug: audio.id, model });
      const startedAt = Date.now();
      setNowMs(startedAt);
      setJob({ slug: audio.id, jobId, status: 'running', logs: '', startedAt, model, auto });
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
            console.error(`${tag} status poll non-OK`, { httpStatus: statusRes.status, body: body.slice(0, 400) });
            status = { status: 'error', logs: `[client] status poll returned HTTP ${statusRes.status}\n${body.slice(0, 400)}` };
          } else {
            status = await statusRes.json();
          }
        } catch (e) {
          console.error(`${tag} status poll failed:`, e);
          status = { status: 'error', logs: `[client] status poll failed: ${e instanceof Error ? e.message : String(e)}` };
        }
        lastStatus = status;
        // Stream new log output to the devtools console as it arrives so the
        // user can debug stuck/failing jobs without docker logs access.
        const logs: string = status.logs ?? '';
        if (logs.length > lastLogsLen) {
          const delta = logs.slice(lastLogsLen);
          console.log(tag, delta.replace(/\n+$/, ''));
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
        console.error(`${tag} job ${jobId} failed:\n${lastStatus.logs || '(no logs returned)'}`);
      } else if (lastStatus.status === 'cancelled') {
        console.warn(`${tag} job ${jobId} cancelled`);
      } else if (lastStatus.status === 'done') {
        console.log(`${tag} job ${jobId} done`);
      }
      const m = await fetchStemManifest(audio.url).catch((e) => {
        // Job succeeded but the caller's view won't refresh — log loudly so
        // the user knows why the stems stay greyed out.
        console.error(`${tag} post-job fetchStemManifest failed:`, e);
        return null;
      });
      onCompleteRef.current?.(audio, m);
      return lastStatus.status === 'done' ? 'done'
        : lastStatus.status === 'cancelled' ? 'cancelled'
        : 'error';
    } catch (e) {
      // Catch-all so nothing slips into an unhandled rejection. If we land
      // here the error pill + modal will tell the user what happened.
      return fail('runStems unexpected throw', e);
    } finally {
      busyRef.current = false;
    }
  }, []);

  const runStems = useCallback(async (audio: StemRunTarget, runOpts?: { model?: DemucsModel }) => {
    if (busyRef.current) {
      alert('A Demucs stem job is already running. Wait for it to finish before starting another.');
      return;
    }
    const model = runOpts?.model ?? DEFAULT_DEMUCS_MODEL;
    const existing = await fetchStemManifest(audio.url).catch((e) => {
      console.warn('[stems] pre-check fetchStemManifest failed (continuing):', e);
      return null;
    });
    if (existing) {
      const ok = confirm(
        `Stems for "${audio.name}" already exist.\n` +
        `Re-running Demucs (${model === '6s' ? '6 stems' : '4 stems'}) will overwrite them. Continue?`,
      );
      if (!ok) return;
    }
    await startJob(audio, { model, force: !!existing, auto: false });
  }, [startJob]);

  // Work the queue until it's empty. Only one drain loop ever runs; a second
  // enqueueStems() while one is in flight just appends. If the user starts an
  // interactive job mid-drain, we wait it out rather than doubling up on a
  // machine that can only usefully run one separation at a time.
  const drainQueue = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        if (busyRef.current) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        const next = queueRef.current[0];
        // Already stemmed (an earlier run, or a dataset import that shipped
        // stems)? Don't spend minutes of CPU redoing it.
        if (!next.force) {
          const existing = await fetchStemManifest(next.audio.url).catch(() => null);
          if (existing) {
            console.log('[stems:auto] skipping — stems already on disk', { slug: next.audio.id });
            queueRef.current = queueRef.current.slice(1);
            setQueued(queueRef.current.map((q) => q.audio));
            continue;
          }
        }
        // Pop before running so `queued` reflects what's still waiting, and a
        // failure can't put the same song back at the head of the queue.
        queueRef.current = queueRef.current.slice(1);
        setQueued(queueRef.current.map((q) => q.audio));
        // One song's failure must not strand the rest of an upload batch —
        // startJob resolves (never rejects) so the loop just carries on.
        await startJob(next.audio, { model: next.model, force: next.force, auto: true });
      }
    } finally {
      drainingRef.current = false;
    }
  }, [startJob]);

  const enqueueStems = useCallback((
    targets: StemRunTarget[],
    runOpts?: { model?: DemucsModel; force?: boolean },
  ) => {
    if (targets.length === 0) return;
    const model = runOpts?.model ?? DEFAULT_DEMUCS_MODEL;
    const force = !!runOpts?.force;
    // Drop songs already queued (a re-upload of the same slug, say) so the
    // same separation can't be scheduled twice.
    const pending = new Set(queueRef.current.map((q) => q.audio.id));
    const added = targets.filter((t) => !pending.has(t.id));
    if (added.length === 0) return;
    queueRef.current = [...queueRef.current, ...added.map((audio) => ({ audio, model, force }))];
    setQueued(queueRef.current.map((q) => q.audio));
    console.log('[stems:auto] queued', added.map((a) => a.id), { model });
    void drainQueue();
  }, [drainQueue]);

  const clearQueue = useCallback(() => {
    queueRef.current = [];
    setQueued([]);
  }, []);

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

  return { job, runStems, enqueueStems, queued, cancelStems, killStems, clearQueue, dismissError, elapsedSec };
}
