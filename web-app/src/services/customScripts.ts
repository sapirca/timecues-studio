/**
 * Client for the custom-detector server (proxied via /api/custom-scripts and
 * /api/custom-annotations). Every call that writes forwards the current
 * annotator id: the proxy gates uploads, reloads, flags, runs and deletes on
 * it, and the annotator_id cookie is only a fallback. Every read sends it too:
 * a package marked "public": false is hidden from the demo and anonymous
 * callers, and the cookie still names the member who opened the demo.
 */

import { annotatorHeaders, fetchWithAnnotator } from '../utils/annotatorHeaders';
import type { EditableDetectorOutput } from './detectorOutputs';
import type {
  CustomRegistryEntry,
  CustomRegistryResponse,
  CustomResultEnvelope,
  DetectorPackage,
  DetectorStrictness,
  DrumSource,
  SectionSource,
} from '../types/customScript';

const SCRIPTS = '/api/custom-scripts';
const ANNOTATIONS = '/api/custom-annotations';

// ─── Registry ────────────────────────────────────────────────────────────────

/** Options for the two registry endpoints. */
export interface ListDetectorsOpts {
  /** Also list archived detectors. Only the Playground asks: everywhere else
   *  an archived detector is simply gone. */
  includeArchived?: boolean;
}

function registryQuery(opts?: ListDetectorsOpts): string {
  const params = new URLSearchParams();
  if (opts?.includeArchived) params.set('include_archived', '1');
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** Every registry read makes the server import every detector file, which
 *  takes seconds — and reads that overlap slow each other down. Callers that
 *  ask while the same read is already out get that read's answer. */
const inFlight = new Map<string, Promise<unknown>>();
function shared<T>(key: string, load: () => Promise<T>): Promise<T> {
  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;
  const p = load().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}
/** Called by every write: a read that started before it would answer with
 *  the old list, so later callers must not join it. */
function forgetPendingReads() {
  inFlight.clear();
}

export function listDetectors(opts?: ListDetectorsOpts): Promise<CustomRegistryEntry[]> {
  const url = `${SCRIPTS}${registryQuery(opts)}`;
  return shared(url, async () => {
    const res = await fetchWithAnnotator(url);
    if (!res.ok) throw new Error(`listDetectors failed: ${res.status}`);
    const body = (await res.json()) as CustomRegistryResponse;
    return body.detectors ?? [];
  });
}

export async function reloadDetectors(opts?: ListDetectorsOpts): Promise<CustomRegistryEntry[]> {
  forgetPendingReads();
  const res = await fetch(`${SCRIPTS}/reload${registryQuery(opts)}`, { method: 'POST', headers: annotatorHeaders() });
  if (!res.ok) throw new Error(`reloadDetectors failed: ${res.status}`);
  const body = (await res.json()) as CustomRegistryResponse;
  return body.detectors ?? [];
}

export async function uploadDetector(name: string, code: string): Promise<CustomRegistryEntry> {
  forgetPendingReads();
  const res = await fetch(`${SCRIPTS}/upload`, {
    method: 'POST',
    headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name, code }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `upload failed: ${res.status}`);
  return body.detector as CustomRegistryEntry;
}

// ─── Packages ────────────────────────────────────────────────────────────────
//
// A package is a folder of detectors (tools/python/custom/<id>/). Sharing it
// downloads the folder as <id>.zip; installing unpacks such a zip back into
// custom/. See tools/python/custom_packages.py.

export function listPackages(): Promise<DetectorPackage[]> {
  return shared(`${SCRIPTS}/packages`, async () => {
    const res = await fetchWithAnnotator(`${SCRIPTS}/packages`);
    if (!res.ok) throw new Error(`listPackages failed: ${res.status}`);
    const body = await res.json();
    return (body.packages ?? []) as DetectorPackage[];
  });
}

/** Download package `id` as `<id>.zip` — the file to hand a colleague. */
export async function sharePackage(id: string): Promise<void> {
  const res = await fetchWithAnnotator(`${SCRIPTS}/packages/${encodeURIComponent(id)}/export`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `share failed: ${res.status}`);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = `${id}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Make an empty package: a new folder tools/python/custom/<id>/ with a
 *  package.json holding its title. The id is the title as a folder name. */
export async function createPackage(fields: { title: string; description?: string }): Promise<DetectorPackage> {
  forgetPendingReads();
  const res = await fetch(`${SCRIPTS}/packages`, {
    method: 'POST',
    headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(fields),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `create package failed: ${res.status}`);
  return body.package as DetectorPackage;
}

/** The package.json fields the Playground edits. Every other key in the file
 *  (bundle, licenses …) is kept as it is. An empty text field is removed. */
export interface PackageFields {
  title?: string;
  description?: string;
  author?: string;
  version?: string;
  public?: boolean;
}

export async function updatePackage(id: string, fields: PackageFields): Promise<DetectorPackage> {
  forgetPendingReads();
  const res = await fetch(`${SCRIPTS}/packages/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(fields),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `edit package failed: ${res.status}`);
  return body.package as DetectorPackage;
}

/** Thrown by installPackage when a package with that name is already
 *  installed; retry with `replace` to swap it (the old one goes to the trash). */
export class PackageExistsError extends Error {
  readonly packageId: string;
  constructor(message: string, packageId: string) {
    super(message);
    this.packageId = packageId;
  }
}

export async function installPackage(file: File, opts: { replace?: boolean } = {}): Promise<DetectorPackage> {
  forgetPendingReads();
  const params = new URLSearchParams({ filename: file.name });
  if (opts.replace) params.set('replace', '1');
  const res = await fetch(`${SCRIPTS}/packages/install?${params}`, {
    method: 'POST',
    headers: { ...annotatorHeaders(), 'Content-Type': 'application/zip' },
    body: file,
  });
  const body = await res.json().catch(() => null);
  if (res.status === 409 && body?.exists) {
    throw new PackageExistsError(body.error, String(body.package ?? ''));
  }
  if (!res.ok) throw new Error(body?.message ?? body?.error ?? `install failed: ${res.status}`);
  return body.package as DetectorPackage;
}

/** Remove an installed package: its folder moves to tools/python/custom/.trash. */
export async function uninstallPackage(id: string): Promise<{ trashed_to: string }> {
  forgetPendingReads();
  const res = await fetch(`${SCRIPTS}/packages/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: annotatorHeaders(),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message ?? body?.error ?? `remove failed: ${res.status}`);
  return { trashed_to: body?.trashed_to ?? '' };
}

/**
 * Soft-delete a detector. The server moves the `.py` into the in-app trash
 * (`tools/python/custom/.trash/`) rather than unlinking it, and wipes the
 * detector's cached algorithm results. Returns `{ message, trashed_to }` so
 * the caller can tell the user where the source landed on disk.
 */
export async function deleteDetector(
  name: string,
): Promise<{ message: string; trashed_to: string }> {
  forgetPendingReads();
  const res = await fetch(`${SCRIPTS}/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: annotatorHeaders(),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.message ?? body?.error ?? `delete failed: ${res.status}`);
  }
  return {
    message: body?.message ?? `"${name}" moved to the app trash.`,
    trashed_to: body?.trashed_to ?? '',
  };
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
  flags: { is_annotation?: boolean; review?: boolean },
): Promise<CustomRegistryEntry> {
  forgetPendingReads();
  const res = await fetch(`${SCRIPTS}/${encodeURIComponent(name)}/flags`, {
    method: 'POST',
    headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(flags),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `flag update failed: ${res.status}`);
  return body.detector as CustomRegistryEntry;
}

/** Duplicate detector `name` as `newName` — or, with `move`, rename it. The
 *  server rewrites the class's `name` line; a rename also carries the
 *  detector's cached runs and annotators' work over to the new name. */
export async function copyDetector(
  name: string,
  newName: string,
  opts: { move?: boolean } = {},
): Promise<CustomRegistryEntry> {
  forgetPendingReads();
  const res = await fetch(`${SCRIPTS}/${encodeURIComponent(name)}/copy`, {
    method: 'POST',
    headers: { ...annotatorHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ new_name: newName, move: !!opts.move }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `${opts.move ? 'rename' : 'duplicate'} failed: ${res.status}`);
  return body.detector as CustomRegistryEntry;
}

/** Move detector `name`'s file into package `packageId` — or, with null, out
 *  of every package to the top of tools/python/custom/. Its name stays, so its
 *  runs and annotators' work stay with it. */
export async function moveDetector(name: string, packageId: string | null): Promise<CustomRegistryEntry> {
  forgetPendingReads();
  const res = await fetch(`${SCRIPTS}/${encodeURIComponent(name)}/move`, {
    method: 'POST',
    headers: { ...annotatorHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ package: packageId }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `move failed: ${res.status}`);
  return body.detector as CustomRegistryEntry;
}

/** Archive detector `name`, or restore it (see CustomRegistryEntry.archived). */
export async function setDetectorArchived(name: string, archived: boolean): Promise<CustomRegistryEntry> {
  forgetPendingReads();
  const res = await fetch(`${SCRIPTS}/${encodeURIComponent(name)}/archive`, {
    method: 'POST',
    headers: { ...annotatorHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ archived }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `${archived ? 'archive' : 'restore'} failed: ${res.status}`);
  return body.detector as CustomRegistryEntry;
}

export async function readDetectorSource(name: string): Promise<string | null> {
  const res = await fetchWithAnnotator(`${SCRIPTS}/file/${encodeURIComponent(name)}`);
  if (!res.ok) return null;
  return res.text();
}

// ─── Run + cached results ────────────────────────────────────────────────────

export async function runDetector(
  name: string,
  slug: string,
  opts?: { force?: boolean; strictness?: DetectorStrictness; drumSource?: DrumSource; sectionSource?: SectionSource; switches?: Record<string, boolean> },
): Promise<CustomResultEnvelope> {
  const params = new URLSearchParams({ slug });
  if (opts?.force) params.set('force', '1');
  if (opts?.strictness !== undefined) params.set('strictness', String(opts.strictness));
  if (opts?.drumSource !== undefined) params.set('drum_source', opts.drumSource);
  if (opts?.sectionSource !== undefined) params.set('section_source', opts.sectionSource);
  // The ticked ones; empty says "none ticked", absent keeps the song's last.
  if (opts?.switches !== undefined) {
    params.set('switches', Object.keys(opts.switches).filter((k) => opts.switches![k]).join(','));
  }
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

/** Run a detector on only `[start, end)` seconds of the song. The detector
 *  hears nothing outside the range; its items come back in song time and are
 *  NOT written anywhere — apply them with `applyDetectorWindow`. Throws with
 *  the server's message on a bad range. `stems` narrows a detector that
 *  declares `stem_parts` to those stems' parts; `strictness` is the 0-100
 *  strictness of a detector that offers it. */
/** Ask a detector that measures (declares `measure()`) about items the
 *  annotator sends — Extract ADSR sends a lyrics lane's words — without
 *  running it on the song or saving anything. Throws with the detector's own
 *  message (no stem, nothing to measure). */
export async function measureWithDetector<T>(name: string, slug: string, body: unknown): Promise<T> {
  const res = await fetch(`${SCRIPTS}/measure/${encodeURIComponent(name)}?${new URLSearchParams({ slug })}`, {
    method: 'POST',
    headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error ?? `measure failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function runDetectorWindow(
  name: string,
  slug: string,
  start: number,
  end: number,
  stems?: readonly string[],
  strictness?: DetectorStrictness,
): Promise<CustomResultEnvelope> {
  const res = await fetch(`${SCRIPTS}/run-window/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      slug, start, end, ...(stems?.length ? { stems } : {}), ...(strictness !== undefined ? { strictness } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `window run failed: ${res.status}`);
  return body as CustomResultEnvelope;
}

export type DetectorWindowMode = 'merge' | 'replace';

export interface DetectorWindowApplied {
  /** The song's output for the detector, window folded in. */
  envelope: CustomResultEnvelope;
  /** This annotator's edited copy with the same window folded in and its ✓/✗
   *  re-keyed, or null when they have none. */
  edited: EditableDetectorOutput | null;
  stats: { added: number; removed: number; duplicates: number };
}

/** Fold a window run into the detector's output for the song.
 *  'merge' keeps what is there and adds what is new; 'replace' swaps the
 *  window's items for the run's. Outside the window nothing changes. */
export async function applyDetectorWindow(
  name: string,
  token: string,
  mode: DetectorWindowMode,
): Promise<DetectorWindowApplied> {
  const res = await fetch(`${SCRIPTS}/merge-window/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ token, mode }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message ?? body?.error ?? `apply failed: ${res.status}`);
  return body as DetectorWindowApplied;
}

export async function getDetectorResult(name: string, slug: string): Promise<CustomResultEnvelope | null> {
  const res = await fetchWithAnnotator(
    `${SCRIPTS}/result/${encodeURIComponent(name)}/${encodeURIComponent(slug)}`,
  );
  if (!res.ok) return null;
  return (await res.json()) as CustomResultEnvelope;
}

/** Delete the items at `indices` from a detector's output for the song — a
 *  part lane is the items of one part. Returns the new output and, when the
 *  annotator has one, their edited copy with its ✓/✗ re-keyed. */
export async function dropDetectorItems(
  name: string,
  slug: string,
  indices: number[],
): Promise<{ envelope: CustomResultEnvelope; edited: EditableDetectorOutput | null }> {
  const res = await fetch(`${SCRIPTS}/drop-items/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ slug, indices }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `delete failed: ${res.status}`);
  return body;
}

/** Delete one lane of a `lanes` detector's output for the song, keeping the
 *  rest. Returns the new output. A whole-song run of the detector brings the
 *  lane back. Throws with the server's message. */
export async function deleteDetectorLane(name: string, slug: string, laneId: string): Promise<CustomResultEnvelope> {
  const res = await fetch(
    `${SCRIPTS}/result/${encodeURIComponent(name)}/${encodeURIComponent(slug)}/lanes/${encodeURIComponent(laneId)}`,
    { method: 'DELETE', headers: annotatorHeaders() },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `delete failed: ${res.status}`);
  return body as CustomResultEnvelope;
}

// ─── Annotation-mode (editable)──────────────────────────────────────────────

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
