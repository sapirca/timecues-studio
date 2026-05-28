import type { ManualAnnotation, AnnotationStatus, AutoGuessManualAnnotation, AlgoClusteredData } from '../types/manualAnnotation';
import { annotatorHeaders } from '../utils/annotatorHeaders';
import { getIsDemo } from '../state/demoFlag';
import {
  demoLoadManual, demoSaveManual, demoDeleteManual,
  demoLoadEye, demoSaveEye, demoDeleteEye,
  demoLoadAutoGuess, demoSaveAutoGuess, demoDeleteAutoGuess,
  demoLoadAllStatuses,
} from './demoStorage';

/** Defensive strip of legacy per-annotation BPM fields. These now live on
 *  SongInfo (/api/song-info/:slug); keeping the strip here guards against
 *  any code path that might reintroduce them (legacy downloads, manual edits). */
function stripLegacyBpmFields(ann: ManualAnnotation): ManualAnnotation {
  const dirty = ann as ManualAnnotation & { bpm?: unknown; timeSignature?: unknown; gridOffset?: unknown };
  if (dirty.bpm === undefined && dirty.timeSignature === undefined && dirty.gridOffset === undefined) return ann;
  const { bpm: _bpm, timeSignature: _ts, gridOffset: _go, ...rest } = dirty;
  void _bpm; void _ts; void _go;
  return rest as ManualAnnotation;
}

/** Load an existing annotation from the dev server. Returns null if not found.
 *  In Demo Mode, reads from localStorage exclusively — never touches the
 *  network, so the demo can never leak server annotations or sign-in data. */
export async function loadAnnotation(slug: string): Promise<ManualAnnotation | null> {
  if (getIsDemo()) return demoLoadManual(slug);
  try {
    const res = await fetch(`/api/manual-annotations/${encodeURIComponent(slug)}`, {
      headers: annotatorHeaders(),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data ?? null;
  } catch {
    return null;
  }
}

/** Save an annotation to the dev server. Returns true on success.
 *  `keepalive: true` lets the request survive tab close / unmount-time flushes.
 *  In Demo Mode, writes go to localStorage only — the server is never called. */
export async function saveToServer(slug: string, ann: ManualAnnotation): Promise<boolean> {
  if (getIsDemo()) return demoSaveManual(slug, stripLegacyBpmFields(ann));
  try {
    const res = await fetch(`/api/manual-annotations/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(stripLegacyBpmFields(ann), null, 2),
      keepalive: true,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Trigger a browser download as Audacity label track (.txt). */
export function downloadAudacityLabels(slug: string, ann: ManualAnnotation): void {
  const lines = ann.sections.map((s, i) => {
    const nextStart = ann.sections[i + 1]?.time;
    const end = nextStart ?? s.time;
    return `${s.time.toFixed(6)}\t${end.toFixed(6)}\t${s.label}`;
  });
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Trigger a browser download of the annotation JSON. */
export function downloadAnnotation(slug: string, ann: ManualAnnotation): void {
  const blob = new Blob([JSON.stringify(ann, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Save to dev server; if that fails (e.g. production build), fall back to download.
 * Returns 'server' or 'download' to indicate which path was used.
 *
 * Demo Mode never falls back to a download — demo edits must stay in the
 * browser by design, so a failed write is just a failed write (very unlikely
 * with localStorage; only happens on quota exhaustion).
 */
export async function saveAnnotation(slug: string, ann: ManualAnnotation): Promise<'server' | 'download'> {
  const ok = await saveToServer(slug, ann);
  if (ok) return 'server';
  if (getIsDemo()) return 'server'; // best-effort; localStorage rarely fails
  downloadAnnotation(slug, ann);
  return 'download';
}

/** Delete a manual annotation from the dev server. Returns true on success. */
export async function deleteAnnotation(slug: string): Promise<boolean> {
  if (getIsDemo()) return demoDeleteManual(slug);
  try {
    const res = await fetch(`/api/manual-annotations/${encodeURIComponent(slug)}`, {
      method: 'DELETE',
      headers: annotatorHeaders(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Auto-Guess Manual Annotation API ──────────────────────────────────────────

// Legacy algorithmIds renamed during the CPD → Ruptures consolidation.
// Old saved annotations may still reference these; rewrite on load so cluster
// sources stay attached to the same (now renamed) algorithm.
const LEGACY_ALGORITHM_ID_MAP: Record<string, string> = {
  'cpd-pelt':   'ruptures-pelt-default',
  'cpd-binseg': 'ruptures-binseg-default',
  'cpd-window': 'ruptures-window-default',
};

function migrateAutoGuessAnnotation(ann: AutoGuessManualAnnotation): AutoGuessManualAnnotation {
  const points = ann.points.map((p) => {
    const sources = p.sources.map((s) => {
      const renamed = LEGACY_ALGORITHM_ID_MAP[s.algorithmId];
      return renamed ? { ...s, algorithmId: renamed } : s;
    });
    const renamedCorr = p.correctionSource ? LEGACY_ALGORITHM_ID_MAP[p.correctionSource] : undefined;
    const sourceStatuses = p.sourceStatuses
      ? Object.fromEntries(Object.entries(p.sourceStatuses).map(
          ([k, v]) => [LEGACY_ALGORITHM_ID_MAP[k] ?? k, v],
        )) as typeof p.sourceStatuses
      : p.sourceStatuses;
    return { ...p, sources, correctionSource: renamedCorr ?? p.correctionSource, sourceStatuses };
  });
  return { ...ann, points };
}

/** Load an existing auto-guess annotation from the dev server. Returns null if not found. */
export async function loadAutoGuessAnnotation(slug: string): Promise<AutoGuessManualAnnotation | null> {
  if (getIsDemo()) {
    const ann = demoLoadAutoGuess(slug);
    return ann ? migrateAutoGuessAnnotation(ann) : null;
  }
  try {
    const res = await fetch(`/api/auto-guess-annotations/${encodeURIComponent(slug)}`, {
      headers: annotatorHeaders(),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data) return null;
    return migrateAutoGuessAnnotation(data as AutoGuessManualAnnotation);
  } catch {
    return null;
  }
}

/** Save an auto-guess annotation to the dev server. Returns true on success. */
export async function saveAutoGuessAnnotation(slug: string, ann: AutoGuessManualAnnotation): Promise<boolean> {
  if (getIsDemo()) return demoSaveAutoGuess(slug, ann);
  try {
    const res = await fetch(`/api/auto-guess-annotations/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(ann, null, 2),
      keepalive: true,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Delete an auto-guess annotation from the dev server. Returns true on success. */
export async function deleteAutoGuessAnnotation(slug: string): Promise<boolean> {
  if (getIsDemo()) return demoDeleteAutoGuess(slug);
  try {
    const res = await fetch(`/api/auto-guess-annotations/${encodeURIComponent(slug)}`, {
      method: 'DELETE',
      headers: annotatorHeaders(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Algorithm Cluster Cache API ─────────────────────────────────────────────

/** Load cached algorithm cluster data for a song. Returns null if not yet computed. */
export async function loadAlgoClusteredData(slug: string): Promise<AlgoClusteredData | null> {
  try {
    const res = await fetch(`/api/algo-clusters/${encodeURIComponent(slug)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data ?? null;
  } catch {
    return null;
  }
}

/** Save algorithm cluster data to the dev server cache. Returns true on success. */
export async function saveAlgoClusteredData(slug: string, data: AlgoClusteredData): Promise<boolean> {
  try {
    const res = await fetch(`/api/algo-clusters/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data, null, 2),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Eye ("By-Eye") Annotation API ───────────────────────────────────────────

/** Load an existing eye annotation from the dev server. Returns null if not found. */
export async function loadEyeAnnotation(slug: string): Promise<ManualAnnotation | null> {
  if (getIsDemo()) return demoLoadEye(slug);
  try {
    const res = await fetch(`/api/eye-annotations/${encodeURIComponent(slug)}`, {
      headers: annotatorHeaders(),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data ?? null;
  } catch {
    return null;
  }
}

/** Save an eye annotation to the dev server. Returns true on success. */
export async function saveEyeAnnotationToServer(slug: string, ann: ManualAnnotation): Promise<boolean> {
  if (getIsDemo()) return demoSaveEye(slug, stripLegacyBpmFields(ann));
  try {
    const res = await fetch(`/api/eye-annotations/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(stripLegacyBpmFields(ann), null, 2),
      keepalive: true,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Delete an eye annotation from the dev server. Returns true on success. */
export async function deleteEyeAnnotation(slug: string): Promise<boolean> {
  if (getIsDemo()) return demoDeleteEye(slug);
  try {
    const res = await fetch(`/api/eye-annotations/${encodeURIComponent(slug)}`, {
      method: 'DELETE',
      headers: annotatorHeaders(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Load statuses for all annotated songs. Returns a map of slug → status. */
export async function loadAllStatuses(): Promise<Record<string, AnnotationStatus>> {
  if (getIsDemo()) return demoLoadAllStatuses();
  try {
    const res = await fetch('/api/manual-annotations', { headers: annotatorHeaders() });
    if (!res.ok) return {};
    const list: AnnotationStatus[] = await res.json();
    return Object.fromEntries(list.map((s) => [s.slug, s]));
  } catch {
    return {};
  }
}

// ─── Multi-annotator queries ─────────────────────────────────────────────────

export interface AnnotatorPresence {
  /** Annotator id (sanitized; matches the on-disk subdir name). */
  id: string;
  /** Which annotation types this annotator has saved for the song. */
  has: { manual: boolean; eye: boolean; autoGuess: boolean };
}

/** List all annotators who have annotated this song. Used
 *  by the cross-annotator comparison view. */
export async function listAnnotatorsForSong(slug: string): Promise<AnnotatorPresence[]> {
  try {
    const res = await fetch(`/api/annotations/${encodeURIComponent(slug)}/annotators`, {
      headers: annotatorHeaders(),
    });
    if (!res.ok) return [];
    return (await res.json()) as AnnotatorPresence[];
  } catch {
    return [];
  }
}
