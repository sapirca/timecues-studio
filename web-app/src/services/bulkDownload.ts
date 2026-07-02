/**
 * Bulk download helpers for annotations.
 *
 * Per-song downloads are handled directly in the editor panels (e.g.
 * `downloadAnnotation` in manualAnnotations.ts). This module covers the
 * "all songs" cases — Manual, Auto-Guess, or everything together.
 *
 * The dev-server `/api/bulk-annotations/<kind>` endpoint returns a single
 * JSON bundle, which we save to a date-stamped file.
 */

import type { ManualAnnotation, AutoGuessManualAnnotation } from '../types/manualAnnotation';

export type BulkKind = 'manual' | 'auto-guess' | 'all';

interface BulkBundleSingle<T> {
  exported_at: string;
  type: 'manual' | 'auto-guess';
  count: number;
  annotations: Record<string, T>;
}

interface BulkBundleAll {
  exported_at: string;
  type: 'all';
  count: number;
  annotations: Record<string, {
    manual: ManualAnnotation | null;
    autoGuess: AutoGuessManualAnnotation | null;
  }>;
}

export type BulkBundle =
  | BulkBundleSingle<ManualAnnotation>
  | BulkBundleSingle<ManualAnnotation>
  | BulkBundleSingle<AutoGuessManualAnnotation>
  | BulkBundleAll;

function todayStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Fetch and download a bundle of annotations of the given kind. */
export async function downloadAllAnnotations(kind: BulkKind): Promise<{ ok: boolean; count: number }> {
  try {
    const res = await fetch(`/api/bulk-annotations/${kind}`);
    if (!res.ok) return { ok: false, count: 0 };
    const data = (await res.json()) as BulkBundle;
    const stamp = todayStamp();
    const filename = `annotations-${kind}-${stamp}.json`;
    downloadJson(filename, data);
    return { ok: true, count: data.count };
  } catch {
    return { ok: false, count: 0 };
  }
}
