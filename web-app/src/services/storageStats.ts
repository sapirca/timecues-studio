// Frontend client for /api/storage-stats — disk usage per song + cache deletion.
// Backend plugin lives in vite.config.ts (serveStorageStats).

import { annotatorHeaders } from '../utils/annotatorHeaders';

export interface StorageCaches {
  /** Demucs stems under web-app/public/stems/<filename-stem>/ */
  stems: number;
  /** Algorithm JSONs under data/algorithm-outputs/analysis/<slug>/ (allin1, ruptures, MSAF) */
  analysis: number;
  /** Raw MSAF outputs under data/algorithm-outputs/msaf/<slug>/ */
  msafRaw: number;
  /** BPM detector cache under data/algorithm-outputs/bpm-detections/<slug>.json */
  bpm: number;
  /** Algorithm cluster cache under data/algorithm-outputs/algo-clusters/<slug>.json */
  algoClusters: number;
  /** MIR feature server cache under data/algorithm-outputs/mir-features/<slug>.json */
  mirFeatures: number;
  /** Custom-script algorithm-mode results, summed across every
   *  data/algorithm-outputs/custom/<script>/<slug>.json file. */
  customResults: number;
}

export interface PerSongStorage {
  /** Slugified id (matches manifest.id) */
  slug: string;
  /** Raw filename without extension — the key under public/stems/ */
  fileStem: string;
  caches: StorageCaches;
  /** Sum of all caches.* — what DELETE will erase. */
  cacheBytes: number;
  /** Bytes of annotation JSONs (manual + auto-guess + song-info, all annotators). NEVER deleted. */
  annotations: number;
  /** Bytes of the audio file in songs/<slug>/. NEVER deleted. */
  audio: number;
  totalBytes: number;
}

export interface StorageTotals extends StorageCaches {
  cacheBytes: number;
  annotations: number;
  audio: number;
  totalBytes: number;
}

export interface StorageStatsResponse {
  perSong: PerSongStorage[];
  totals: StorageTotals;
}

export async function fetchStorageStats(): Promise<StorageStatsResponse | null> {
  try {
    const res = await fetch('/api/storage-stats');
    if (!res.ok) return null;
    return (await res.json()) as StorageStatsResponse;
  } catch {
    return null;
  }
}

// Destructive endpoints throw on non-2xx so the caller can surface the HTTP
// status + response body — silently swallowing the error left the user staring
// at a "deleted" dialog while the file was still on disk.
async function deleteJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: 'DELETE', headers: annotatorHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`DELETE ${url} failed: HTTP ${res.status}${text ? ` — ${text}` : ''}`);
  }
  return (await res.json()) as T;
}

export async function clearSongCaches(slug: string): Promise<PerSongStorage> {
  return deleteJson<PerSongStorage>(`/api/storage/${encodeURIComponent(slug)}`);
}

/** Erase only the Demucs stems for one song. Other caches + annotations + audio kept. */
export async function clearSongStems(slug: string): Promise<PerSongStorage> {
  return deleteJson<PerSongStorage>(`/api/storage/${encodeURIComponent(slug)}?scope=stems`);
}

/**
 * Nuke a song entirely: audio file, all annotators' annotations (manual/auto-guess/
 * custom + song-info), and all regenerable caches. Cannot be undone.
 */
export async function deleteSongEverything(slug: string): Promise<{ deleted: number; slug: string }> {
  return deleteJson<{ deleted: number; slug: string }>(
    `/api/songs/${encodeURIComponent(slug)}?scope=everything`,
  );
}

export async function clearAllCaches(): Promise<{ cleared: number }> {
  return deleteJson<{ cleared: number }>('/api/storage');
}

/** Delete every song from the dataset. scope=audio keeps annotations as orphans,
 *  scope=everything also wipes per-song annotations + caches across all annotators. */
export async function deleteAllSongs(scope: 'audio' | 'everything' = 'everything'): Promise<{ deleted: number }> {
  return deleteJson<{ deleted: number }>(`/api/songs?scope=${scope}`);
}

/** Wipe the entire current dataset: every song (audio + caches + annotations),
 *  the dataset-config (members, admin list, lock state), and every annotator's
 *  saved sign-up profile. The next sign-in re-enters bootstrap mode and the
 *  first signer becomes admin. */
export async function deleteDataset(): Promise<{ ok: true }> {
  return deleteJson<{ ok: true }>('/api/dataset');
}

/** Factory-reset: identical scope to deleteDataset today (single-dataset app)
 *  but routed through a distinct endpoint so the multi-dataset future can
 *  differentiate "this dataset" from "all datasets + global state". */
export async function factoryReset(): Promise<{ ok: true }> {
  return deleteJson<{ ok: true }>('/api/factory-reset');
}

/** Format a byte count as a human-readable size (e.g. 1234567 → "1.2 MB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  // Show 1 decimal under 100 (e.g. 1.2 MB) but no decimals beyond 100 (e.g. 234 MB).
  return `${v < 100 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
