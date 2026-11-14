// Full-backup restore — put every file of a server backup back where it came
// from, byte for byte, through POST /api/restore-backup (vite.config.ts).
//
// A backup is the server's data/ tree (tar'd off the VM, then unpacked):
//   songs/  song-info/  annotations/  algorithm-outputs/  stems/
//   annotators/  lyrics-text/  dataset-config.json
// The song-by-song importer (datasetImport.ts) reads that layout too, but only
// the parts it has endpoints for; a restore copies all of it, keeps every
// annotator's files under their own id, and checks each file afterwards.

import { annotatorHeaders } from '../utils/annotatorHeaders';
import { tierForAnnotator, type DatasetConfig } from '../types/datasetConfig';

/** Top-level entries of a data/ tree. Mirrors RESTORE_TOP_LEVEL on the server. */
const TOP_LEVEL = new Set([
  'songs', 'song-info', 'annotations', 'algorithm-outputs', 'stems',
  'annotators', 'lyrics-text', 'dataset-config.json',
]);
const CONFIG_PATH = 'dataset-config.json';
const CHUNK = 8 * 1024 * 1024;
const PARALLEL_FILES = 4;
// An 8 MB chunk to this machine takes well under a second. A chunk with no
// answer after this long is a stuck server: report it as a failed file
// instead of leaving the progress bar frozen.
const CHUNK_TIMEOUT_MS = 120_000;

export type BackupEntry = { rel: string; file: File };

export type Backup = {
  /** Folder the user picked, down to the data/ root (for the summary line). */
  rootLabel: string;
  entries: BackupEntry[];
  /** Files under the picked folder that aren't part of a data/ tree — the
   *  backup's own older tarballs, custom-scripts/, Finder's .DS_Store. */
  ignored: string[];
};

function relPath(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

/** Find the data/ root inside a picked folder: the shallowest directory that
 *  holds both songs/ and annotations/. Null when the folder isn't a backup. */
export function detectBackup(files: File[]): Backup | null {
  const withSongs = new Set<string>();
  const withAnnotations = new Set<string>();
  for (const f of files) {
    const parts = relPath(f).split('/');
    for (let i = 0; i < parts.length - 1; i += 1) {
      const prefix = parts.slice(0, i).join('/');
      if (parts[i] === 'songs') withSongs.add(prefix);
      if (parts[i] === 'annotations') withAnnotations.add(prefix);
    }
  }
  const roots = [...withSongs].filter((p) => withAnnotations.has(p));
  if (roots.length === 0) return null;
  const root = roots.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)[0];
  const prefix = root ? `${root}/` : '';

  const entries: BackupEntry[] = [];
  const ignored: string[] = [];
  for (const file of files) {
    const p = relPath(file);
    const rel = p.startsWith(prefix) ? p.slice(prefix.length) : null;
    const parts = rel?.split('/') ?? [];
    const dotted = parts.some((s) => s.startsWith('.') && s !== '.git');
    if (rel && TOP_LEVEL.has(parts[0]) && !dotted && !rel.endsWith('.restore-part')) {
      entries.push({ rel, file });
    } else {
      ignored.push(p);
    }
  }
  return { rootLabel: root || '(picked folder)', entries, ignored };
}

// ── Summary ──────────────────────────────────────────────────────────────────

export type SummaryRow = { label: string; detail: string; files: number; bytes: number };

/** One row per thing a person would recognise: the songs, each annotator's
 *  annotations, each detector family, the people list. */
export function summarizeBackup(entries: BackupEntry[]): SummaryRow[] {
  const rows = new Map<string, SummaryRow>();
  const add = (key: string, label: string, detail: string, file: File) => {
    const row = rows.get(key) ?? { label, detail, files: 0, bytes: 0 };
    row.files += 1;
    row.bytes += file.size;
    rows.set(key, row);
  };
  const songs = new Set<string>();
  const stemSongs = new Set<string>();
  for (const { rel, file } of entries) {
    const [top, a, b] = rel.split('/');
    if (top === 'songs') { songs.add(a); add('songs', 'Songs', 'audio', file); }
    else if (top === 'stems') { stemSongs.add(a); add('stems', 'Stems', 'separated stems', file); }
    else if (top === 'song-info') add('song-info', 'Song info', 'BPM, grid, title', file);
    else if (top === 'annotations') {
      if (a === 'shared') add('ann:shared', 'Annotations · shared songs', 'with their edit history', file);
      else if (a === 'locks') add('ann:locks', 'Annotations · edit locks', '', file);
      else add(`ann:${a}:${b}`, `Annotations · ${a}`, b ?? '', file);
    }
    else if (top === 'algorithm-outputs') add(`algo:${a}`, 'Detector outputs', a, file);
    else if (top === 'annotators') add('annotators', 'Annotator profiles', '', file);
    else if (top === CONFIG_PATH) add('config', 'People & dataset settings', CONFIG_PATH, file);
    else if (top === 'lyrics-text') add('lyrics-text', 'Lyrics text', '', file);
  }
  const songsRow = rows.get('songs');
  if (songsRow) songsRow.detail = `${songs.size} songs`;
  const stemsRow = rows.get('stems');
  if (stemsRow) stemsRow.detail = `${stemSongs.size} songs`;
  // The big, recognisable things first; the people list last, beside its toggle.
  const ORDER = ['songs', 'stems', 'song-info', 'ann:', 'algo:', 'lyrics-text', 'annotators', 'config'];
  const rank = (key: string) => ORDER.findIndex((p) => key === p || (p.endsWith(':') && key.startsWith(p)));
  return [...rows.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([, row]) => row);
}

/** Would restoring this backup's people list leave the current user without
 *  admin? The restore itself needs admin, and the list is written last — but
 *  afterwards they'd be locked out of their own install. */
export async function configLocksOut(entries: BackupEntry[], annotatorId: string | null): Promise<boolean> {
  const cfgEntry = entries.find((e) => e.rel === CONFIG_PATH);
  if (!cfgEntry) return false;
  try {
    const cfg = JSON.parse(await cfgEntry.file.text()) as DatasetConfig;
    return tierForAnnotator(annotatorId, cfg) !== 'admin';
  } catch {
    return false;
  }
}

// ── Restore ──────────────────────────────────────────────────────────────────

export type RestoreProgress = { filesDone: number; totalFiles: number; bytesDone: number; totalBytes: number; current: string };
export type RestoreFailure = { rel: string; error: string };
export type RestoreResult = {
  restored: number;
  verified: number;
  /** Files the run meant to write — what "N of total" counts against. */
  total: number;
  failures: RestoreFailure[];
  /** Set when the run gave up: the first files all failed for one reason
   *  (not signed in as an admin, server gone), so the rest would too. */
  stoppedEarly?: string;
  finishedAt: string;
};

// Every early file failing for the same reason means the rest will as well;
// stopping there shows one clear error instead of thousands of identical rows.
const STOP_AFTER_SAME_FAILURES = 20;

// ── The last report, kept in this browser ───────────────────────────────────
// A restore's report is the only record of what failed, and a page reload (a
// dev server reacting to a code edit, a closed tab) used to take it with it.

const REPORT_KEY = 'tc.lastRestoreReport';
const REPORT_MAX_FAILURES = 1000;

export function saveRestoreReport(result: RestoreResult): void {
  try {
    const kept = { ...result, failures: result.failures.slice(0, REPORT_MAX_FAILURES) };
    localStorage.setItem(REPORT_KEY, JSON.stringify(kept));
  } catch { /* storage full or blocked — the report still shows on screen */ }
}

export function loadRestoreReport(): RestoreResult | null {
  try {
    const raw = localStorage.getItem(REPORT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RestoreResult;
    return Array.isArray(parsed?.failures) && typeof parsed.total === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

/** Failures grouped by their message, largest group first — one refusal
 *  repeated over 6000 files reads as one line. */
export function groupFailures(failures: RestoreFailure[]): { error: string; paths: string[] }[] {
  const by = new Map<string, string[]>();
  for (const f of failures) by.set(f.error, [...(by.get(f.error) ?? []), f.rel]);
  return [...by.entries()].map(([error, paths]) => ({ error, paths })).sort((a, b) => b.paths.length - a.paths.length);
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function serverError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch { /* not JSON */ }
  return text.slice(0, 200) || `HTTP ${res.status}`;
}

/** Upload one file in order-preserving chunks; resolves with the server's
 *  SHA-256 of what it wrote. */
async function restoreFile(entry: BackupEntry, onBytes: (n: number) => void): Promise<string> {
  const { rel, file } = entry;
  const total = Math.max(1, Math.ceil(file.size / CHUNK));
  let sha = '';
  for (let i = 0; i < total; i += 1) {
    const body = file.slice(i * CHUNK, Math.min(file.size, (i + 1) * CHUNK));
    const qs = `path=${encodeURIComponent(rel)}&chunk=${i}&total=${total}`;
    let res: Response;
    try {
      res = await fetch(`/api/restore-backup?${qs}`, {
        method: 'POST',
        headers: annotatorHeaders({ 'Content-Type': 'application/octet-stream' }),
        body,
        signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS),
      });
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') {
        throw new Error(`the server didn't answer within ${CHUNK_TIMEOUT_MS / 1000} s — check that it's running, then restore again`);
      }
      throw err;
    }
    if (!res.ok) throw new Error(await serverError(res));
    onBytes(body.size);
    if (i === total - 1) sha = String(((await res.json()) as { sha256?: string }).sha256 ?? '');
  }
  return sha;
}

/** Restore every entry and check each one against the server's checksum.
 *  The people list goes last: it decides who may call this endpoint, so
 *  writing it first could refuse the rest of the restore. One failed file
 *  never stops the others. */
export async function restoreBackup(
  entries: BackupEntry[],
  onProgress: (p: RestoreProgress) => void,
): Promise<RestoreResult> {
  const ordered = [
    ...entries.filter((e) => e.rel !== CONFIG_PATH),
    ...entries.filter((e) => e.rel === CONFIG_PATH),
  ];
  const progress: RestoreProgress = {
    filesDone: 0,
    totalFiles: ordered.length,
    bytesDone: 0,
    totalBytes: ordered.reduce((n, e) => n + e.file.size, 0),
    current: '',
  };
  const failures: RestoreFailure[] = [];
  let verified = 0;
  let stoppedEarly: string | undefined;

  const runOne = async (entry: BackupEntry) => {
    progress.current = entry.rel;
    onProgress({ ...progress });
    try {
      const [serverSha, localSha] = await Promise.all([
        restoreFile(entry, (n) => { progress.bytesDone += n; onProgress({ ...progress }); }),
        sha256Hex(entry.file),
      ]);
      if (serverSha === localSha) verified += 1;
      else failures.push({ rel: entry.rel, error: 'written file does not match the backup (checksum differs)' });
    } catch (err) {
      failures.push({ rel: entry.rel, error: (err as Error).message });
    }
    progress.filesDone += 1;
    onProgress({ ...progress });
    if (!stoppedEarly && verified === 0 && failures.length >= STOP_AFTER_SAME_FAILURES
        && failures.every((f) => f.error === failures[0].error)) {
      stoppedEarly = failures[0].error;
    }
  };

  const body = ordered.filter((e) => e.rel !== CONFIG_PATH);
  let next = 0;
  await Promise.all(Array.from({ length: PARALLEL_FILES }, async () => {
    while (next < body.length && !stoppedEarly) await runOne(body[next++]);
  }));
  // The people list only after everything else landed — never on a run that
  // gave up, which would leave a half-restored corpus with a new owner.
  if (!stoppedEarly) for (const e of ordered.slice(body.length)) await runOne(e);

  return {
    restored: progress.filesDone - failures.length,
    verified,
    total: ordered.length,
    failures,
    stoppedEarly,
    finishedAt: new Date().toISOString(),
  };
}
