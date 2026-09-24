/**
 * Client for the auto-guess annotation API.
 *
 * Auto-guess is the last annotation kind with a document of its own — it is a
 * review workflow over clustered algorithm output, not a lane the curator
 * draws on. Everything hand-authored, boundaries included, goes through
 * services/annotationLayers.ts instead.
 */

import type { AutoGuessManualAnnotation, AutoGuessStatus } from '../types/autoGuess';
import { annotatorHeaders } from '../utils/annotatorHeaders';
import { getIsDemo } from '../state/demoFlag';
import {
  demoLoadAutoGuess, demoSaveAutoGuess, demoDeleteAutoGuess,
  demoLoadAllAutoGuessStatuses,
} from './demoStorage';

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

/** Save an auto-guess annotation to the dev server. Returns true on success.
 *  No call site here flushes on unload, so this never needs `keepalive` —
 *  and must not set it unconditionally, since Chromium caps keepalive fetch
 *  bodies at ~64KiB and silently rejects larger ones (no network attempt). */
export async function saveAutoGuessAnnotation(slug: string, ann: AutoGuessManualAnnotation): Promise<boolean> {
  if (getIsDemo()) return demoSaveAutoGuess(slug, ann);
  try {
    const res = await fetch(`/api/auto-guess-annotations/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(ann),
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

/** Per-song auto-guess summary for the song-list indicator. Boundary / layer
 *  counts come from `loadAllLayerStatuses` in services/annotationLayers.ts. */
export interface AutoGuessSongStatus {
  slug: string;
  auto_guess_status?: AutoGuessStatus;
  points_count: number;
}

/** Load auto-guess statuses for every song the current annotator has one for.
 *  Returns a map of slug → status. */
export async function loadAllAutoGuessStatuses(): Promise<Record<string, AutoGuessSongStatus>> {
  if (getIsDemo()) return demoLoadAllAutoGuessStatuses();
  try {
    const res = await fetch('/api/auto-guess-annotations', { headers: annotatorHeaders() });
    if (!res.ok) return {};
    const list: AutoGuessSongStatus[] = await res.json();
    if (!Array.isArray(list)) return {};
    return Object.fromEntries(list.map((s) => [s.slug, s]));
  } catch {
    return {};
  }
}
