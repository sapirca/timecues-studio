import { DEFAULT_DATASET_CONFIG, type AccessTier, type DatasetConfig } from '../types/datasetConfig';
import { annotatorHeaders } from '../utils/annotatorHeaders';

const ENDPOINT = '/api/dataset-config';

/** Server-side access check for a candidate annotator id. Used by the sign-in
 *  flow before the annotator cookie is set, so the denial decision is made on
 *  the server against the on-disk whitelist (which never reaches the client).
 *  Returns the resolved tier — `null` means "denied / public". */
export async function checkAccess(id: string): Promise<AccessTier | null> {
  try {
    const res = await fetch(`/api/check-access?id=${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { tier: AccessTier | null };
    return data.tier ?? null;
  } catch {
    return null;
  }
}

export async function loadDatasetConfig(): Promise<DatasetConfig> {
  try {
    const res = await fetch(ENDPOINT);
    if (!res.ok) return { ...DEFAULT_DATASET_CONFIG };
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) return { ...DEFAULT_DATASET_CONFIG };
    const data = await res.json();
    if (!data || typeof data !== 'object') return { ...DEFAULT_DATASET_CONFIG };
    return { ...DEFAULT_DATASET_CONFIG, ...data } as DatasetConfig;
  } catch {
    return { ...DEFAULT_DATASET_CONFIG };
  }
}

export async function saveDatasetConfig(cfg: DatasetConfig): Promise<void> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(cfg),
  });
  if (!res.ok) {
    throw new Error(res.status === 403 ? 'admin required' : `HTTP ${res.status}`);
  }
}

export interface PurgePersonResult {
  ok: boolean;
  deletedIds: string[];
  removedDirs: number;
  removedFiles: number;
  removedProfiles: number;
}

// Admin-only destructive purge: drops the person from peopleByEmail and
// deletes every annotation file they own plus their annotator profile from
// disk. Server-side guard refuses to remove the last admin (409).
export async function purgePerson(email: string): Promise<PurgePersonResult> {
  const res = await fetch(`/api/people/${encodeURIComponent(email)}`, {
    method: 'DELETE',
    headers: annotatorHeaders(),
  });
  if (!res.ok) {
    if (res.status === 403) throw new Error('admin required');
    if (res.status === 409) throw new Error('cannot remove the last admin');
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as PurgePersonResult;
}
