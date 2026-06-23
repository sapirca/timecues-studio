/**
 * Client for the custom-detector server (proxied via /api/custom-scripts and
 * /api/custom-annotations). All annotation calls forward the current
 * annotator id; script-management calls do not need it.
 */

import { annotatorHeaders } from '../utils/annotatorHeaders';
import type {
  CustomRegistryEntry,
  CustomRegistryResponse,
  CustomResultEnvelope,
} from '../types/customScript';

const SCRIPTS = '/api/custom-scripts';
const ANNOTATIONS = '/api/custom-annotations';

// ─── Registry ────────────────────────────────────────────────────────────────

/** Options for the two registry endpoints.
 *
 *  `includeExperimentalLoopsAndPatterns` mirrors the
 *  `experimentalLoopsAndPatterns` Settings flag. When false (the default),
 *  the server filters out detectors whose `output_kind` is `loop` or
 *  `pattern`, matching how the Loops/Patterns annotation tabs are hidden in
 *  the UI when the flag is off. */
export interface ListDetectorsOpts {
  includeExperimentalLoopsAndPatterns?: boolean;
}

function registryQuery(opts?: ListDetectorsOpts): string {
  const params = new URLSearchParams();
  if (opts?.includeExperimentalLoopsAndPatterns) {
    params.set('include_experimental_loops_patterns', '1');
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export async function listDetectors(opts?: ListDetectorsOpts): Promise<CustomRegistryEntry[]> {
  const res = await fetch(`${SCRIPTS}${registryQuery(opts)}`);
  if (!res.ok) throw new Error(`listDetectors failed: ${res.status}`);
  const body = (await res.json()) as CustomRegistryResponse;
  return body.detectors ?? [];
}

export async function reloadDetectors(opts?: ListDetectorsOpts): Promise<CustomRegistryEntry[]> {
  const res = await fetch(`${SCRIPTS}/reload${registryQuery(opts)}`, { method: 'POST' });
  if (!res.ok) throw new Error(`reloadDetectors failed: ${res.status}`);
  const body = (await res.json()) as CustomRegistryResponse;
  return body.detectors ?? [];
}

export async function uploadDetector(name: string, code: string): Promise<CustomRegistryEntry> {
  const res = await fetch(`${SCRIPTS}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, code }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `upload failed: ${res.status}`);
  return body.detector as CustomRegistryEntry;
}

export async function deleteDetector(name: string): Promise<boolean> {
  const res = await fetch(`${SCRIPTS}/${encodeURIComponent(name)}`, { method: 'DELETE' });
  return res.ok;
}

/**
 * Wipe one detector's algorithm cache + the current annotator's annotation
 * files. The .py source is preserved. Other annotators' annotations are
 * untouched.
 *
 * Pass `slug` to scope the wipe to a single song; omit it to clear every
 * song's output for the detector.
 */
export async function deleteDetectorOutputs(
  name: string,
  slug?: string,
): Promise<{ annotations_removed: number }> {
  const query = slug ? `?slug=${encodeURIComponent(slug)}` : '';
  const res = await fetch(`${SCRIPTS}/${encodeURIComponent(name)}/outputs${query}`, {
    method: 'DELETE',
    headers: annotatorHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `clear outputs failed: ${res.status}`);
  return { annotations_removed: Number(body?.annotations_removed ?? 0) };
}

export async function updateDetectorFlags(
  name: string,
  flags: { is_algorithm: boolean; is_annotation: boolean },
): Promise<CustomRegistryEntry> {
  const res = await fetch(`${SCRIPTS}/${encodeURIComponent(name)}/flags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(flags),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `flag update failed: ${res.status}`);
  return body.detector as CustomRegistryEntry;
}

export async function readDetectorSource(name: string): Promise<string | null> {
  const res = await fetch(`${SCRIPTS}/file/${encodeURIComponent(name)}`);
  if (!res.ok) return null;
  return res.text();
}

// ─── Run + cached results ────────────────────────────────────────────────────

export async function runDetector(
  name: string,
  slug: string,
  opts?: { force?: boolean },
): Promise<CustomResultEnvelope> {
  const params = new URLSearchParams({ slug });
  if (opts?.force) params.set('force', '1');
  const res = await fetch(`${SCRIPTS}/run/${encodeURIComponent(name)}?${params}`, {
    method: 'POST',
    headers: annotatorHeaders(),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ?? `run failed: ${res.status}`);
  }
  return (await res.json()) as CustomResultEnvelope;
}

export async function getDetectorResult(name: string, slug: string): Promise<CustomResultEnvelope | null> {
  const res = await fetch(
    `${SCRIPTS}/result/${encodeURIComponent(name)}/${encodeURIComponent(slug)}`,
  );
  if (!res.ok) return null;
  return (await res.json()) as CustomResultEnvelope;
}

// ─── Annotation-mode (editable) ──────────────────────────────────────────────

export async function loadCustomAnnotation<T = unknown>(
  name: string,
  slug: string,
): Promise<T | null> {
  const res = await fetch(
    `${ANNOTATIONS}/${encodeURIComponent(name)}/${encodeURIComponent(slug)}`,
    { headers: annotatorHeaders() },
  );
  if (!res.ok) return null;
  return (await res.json()) as T;
}

export async function saveCustomAnnotation(
  name: string,
  slug: string,
  data: unknown,
): Promise<boolean> {
  const res = await fetch(
    `${ANNOTATIONS}/${encodeURIComponent(name)}/${encodeURIComponent(slug)}`,
    {
      method: 'POST',
      headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(data),
    },
  );
  return res.ok;
}

export async function deleteCustomAnnotation(name: string, slug: string): Promise<boolean> {
  const res = await fetch(
    `${ANNOTATIONS}/${encodeURIComponent(name)}/${encodeURIComponent(slug)}`,
    { method: 'DELETE', headers: annotatorHeaders() },
  );
  return res.ok;
}
