/**
 * Client for the editable per-annotator detector-output files served by
 * tools/python/custom_server.py at /api/detector-outputs/*.
 *
 * Lifecycle:
 *   1. The user opens a detector source in the AnnotationSourcePicker.
 *   2. Detector items are rendered read-only from the algorithm-cache
 *      envelope (CustomResultEnvelope) loaded via `getDetectorResult`.
 *   3. On the user's first ✓/✗ click, the page seeds an EditableDetectorOutput
 *      from that envelope, adds the review decision, and POSTs it here —
 *      this is the copy-on-write moment.
 *   4. Subsequent edits write through to the same file. The algorithm cache
 *      at /api/custom-scripts/result/* is never mutated, so a future re-run
 *      can regenerate it from scratch.
 *   5. Re-running a detector when an editable file exists returns 409 from
 *      /api/custom-scripts/run/*. `runDetectorWithConfirm` round-trips that —
 *      the caller is expected to surface a dialog with the server's
 *      `message` field and pass `confirmOverwrite: true` to proceed.
 */

import { annotatorHeaders } from '../utils/annotatorHeaders';
import type { CustomResultEnvelope } from '../types/customScript';

const DETECTOR_OUTPUTS = '/api/detector-outputs';

/** Per-item review decision. `pending` is implicit — items without an entry
 *  in the `review` map are treated as not yet reviewed. */
export type DetectorReviewStatus = 'accepted' | 'rejected';

/** The on-disk shape — a CustomResultEnvelope augmented with the review map
 *  and an `in_progress` flag the UI uses to render the "edited" dot in the
 *  picker. */
export interface EditableDetectorOutput extends CustomResultEnvelope {
  review: Record<string, DetectorReviewStatus>;
  in_progress: true;
}

/** GET — returns the editable doc, or null when no copy-on-write file exists
 *  yet. The detector is "pristine" in that case (algorithm cache only). */
export async function loadDetectorOutput(
  name: string,
  slug: string,
): Promise<EditableDetectorOutput | null> {
  const res = await fetch(
    `${DETECTOR_OUTPUTS}/${encodeURIComponent(name)}/${encodeURIComponent(slug)}`,
    { headers: annotatorHeaders() },
  );
  if (!res.ok) return null;
  const body = (await res.json()) as EditableDetectorOutput | null;
  return body ?? null;
}

/** POST — writes the editable doc. Creates the file on first save (the
 *  copy-on-write moment). */
export async function saveDetectorOutput(
  name: string,
  slug: string,
  doc: EditableDetectorOutput,
): Promise<boolean> {
  const res = await fetch(
    `${DETECTOR_OUTPUTS}/${encodeURIComponent(name)}/${encodeURIComponent(slug)}`,
    {
      method: 'POST',
      headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(doc),
    },
  );
  return res.ok;
}

/** DELETE — wipes the editable file. The algorithm cache is preserved. */
export async function deleteDetectorOutput(
  name: string,
  slug: string,
): Promise<boolean> {
  const res = await fetch(
    `${DETECTOR_OUTPUTS}/${encodeURIComponent(name)}/${encodeURIComponent(slug)}`,
    { method: 'DELETE', headers: annotatorHeaders() },
  );
  return res.ok;
}

/** GET /index — { [detectorName]: [slug, slug, ...] } of every detector that
 *  has at least one editable output file for the current annotator. Polled
 *  once on song load; drives the "edited" dot on detector entries in the
 *  source picker. */
export async function listInProgressDetectorOutputs(): Promise<Record<string, string[]>> {
  const res = await fetch(`${DETECTOR_OUTPUTS}/index`, { headers: annotatorHeaders() });
  if (!res.ok) return {};
  return (await res.json()) as Record<string, string[]>;
}

// ─── Conflict-aware re-run ───────────────────────────────────────────────────

/** Body shape returned by /api/custom-scripts/run/:name when an editable
 *  output file already exists and `confirm_overwrite` was not passed.
 *  `message` is verbatim user-facing text — surface it in the modal. */
export interface DetectorRunConflict {
  error: 'edited_output_exists';
  detector: string;
  slug: string;
  path: string;
  message: string;
}

export type DetectorRunResult =
  | { status: 'ok'; envelope: CustomResultEnvelope }
  | { status: 'conflict'; conflict: DetectorRunConflict };

/** Runs a detector and surfaces a structured conflict result instead of
 *  throwing when the server returns 409. Callers handle 'conflict' by
 *  opening the overwrite dialog. */
export async function runDetectorWithConflictCheck(
  name: string,
  slug: string,
  opts?: { force?: boolean; confirmOverwrite?: boolean },
): Promise<DetectorRunResult> {
  const params = new URLSearchParams({ slug });
  if (opts?.force) params.set('force', '1');
  if (opts?.confirmOverwrite) params.set('confirm_overwrite', '1');
  const res = await fetch(
    `/api/custom-scripts/run/${encodeURIComponent(name)}?${params}`,
    { method: 'POST', headers: annotatorHeaders() },
  );
  if (res.status === 409) {
    const conflict = (await res.json()) as DetectorRunConflict;
    return { status: 'conflict', conflict };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ?? `run failed: ${res.status}`);
  }
  const envelope = (await res.json()) as CustomResultEnvelope;
  return { status: 'ok', envelope };
}
