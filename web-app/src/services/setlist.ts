// Setlist scoring + ordering — pure functions + thin HTTP client.
//
// Pure section is import-safe and unit-tested; HTTP section persists setlists
// to `/api/setlists` (per-annotator under `data/setlists/<annotator>/`).
//
// v0 scorer: BPM-only with a clamp at ±8 BPM. Meter and energy slots are
// already wired into the weights so adding them later is a matter of
// filling in `meterScore` / `energyScore`, not refactoring callers.

import { annotatorHeaders } from '../utils/annotatorHeaders';
import type {
  Setlist,
  SetlistEntry,
  SetlistScoringWeights,
  SetlistStrategyId,
} from '../types/setlist';

const API = '/api/setlists';

/** Maximum BPM gap (in BPM) above which the BPM score is 0. ~half-step on
 *  the wheel of tempo families; standard DJ-mixing rule of thumb. */
export const BPM_CLAMP = 8;

export const DEFAULT_WEIGHTS: SetlistScoringWeights = {
  bpm: 1,
  meter: 0,
  energy: 0,
};

export const STRATEGIES: { id: SetlistStrategyId; label: string; hint: string }[] = [
  {
    id: 'bpm-ladder',
    label: 'BPM ladder',
    hint: 'Ascending BPM, nearest-neighbour. Greedy from the lowest-BPM song.',
  },
];

// ─── Pure scoring ────────────────────────────────────────────────────────────

/** 0..1 — closer BPM = higher score. Returns 0 when either song is missing BPM. */
export function bpmScore(a: number | null | undefined, b: number | null | undefined): number {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const delta = Math.abs(b - a);
  if (delta >= BPM_CLAMP) return 0;
  return 1 - delta / BPM_CLAMP;
}

/** 0..1 — same meter = 1, different = 0.3, unknown on either side = 0.5. */
export function meterScore(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0.5;
  return a === b ? 1 : 0.3;
}

/** Weighted compatibility for an adjacent pair. */
export function pairScore(
  a: SetlistEntry,
  b: SetlistEntry,
  weights: SetlistScoringWeights,
): number {
  const wSum = weights.bpm + weights.meter + weights.energy;
  if (wSum <= 0) return 0;
  const sBpm = bpmScore(a.bpm, b.bpm) * weights.bpm;
  const sMeter = meterScore(a.meter, b.meter) * weights.meter;
  // Energy scorer reserved — currently always 0 contribution.
  const sEnergy = 0 * weights.energy;
  return (sBpm + sMeter + sEnergy) / wSum;
}

// ─── Ordering ────────────────────────────────────────────────────────────────

/** Greedy nearest-neighbour starting from the lowest-BPM song. Songs without
 *  a BPM go at the end in their original order (they can't be ladder-mixed).
 *  Deterministic: stable to insertion order; identical inputs → identical output. */
export function greedyBpmLadder(
  entries: SetlistEntry[],
  weights: SetlistScoringWeights = DEFAULT_WEIGHTS,
): { order: SetlistEntry[]; pairScores: number[] } {
  const withBpm = entries.filter((e) => e.bpm != null && Number.isFinite(e.bpm));
  const withoutBpm = entries.filter((e) => e.bpm == null || !Number.isFinite(e.bpm));
  if (withBpm.length === 0) {
    return { order: [...withoutBpm], pairScores: [] };
  }

  // Seed with the lowest BPM. Ties broken by slug for determinism.
  const sorted = [...withBpm].sort((a, b) => {
    const d = (a.bpm ?? 0) - (b.bpm ?? 0);
    return d !== 0 ? d : a.slug.localeCompare(b.slug);
  });
  const remaining = new Set(sorted.map((e) => e.slug));
  const order: SetlistEntry[] = [sorted[0]];
  remaining.delete(sorted[0].slug);

  while (remaining.size > 0) {
    const tail = order[order.length - 1];
    let bestSlug: string | null = null;
    let bestScore = -Infinity;
    for (const slug of remaining) {
      const candidate = sorted.find((e) => e.slug === slug)!;
      const s = pairScore(tail, candidate, weights);
      if (s > bestScore) {
        bestScore = s;
        bestSlug = slug;
      }
    }
    if (bestSlug == null) break;
    const next = sorted.find((e) => e.slug === bestSlug)!;
    order.push(next);
    remaining.delete(bestSlug);
  }

  // Compute the score for each adjacent pair so the UI can show why.
  const pairScores: number[] = [];
  for (let i = 0; i < order.length - 1; i++) {
    pairScores.push(pairScore(order[i], order[i + 1], weights));
  }

  // No-BPM songs trail at the end, no pair score relative to them — they
  // print "—" in the UI and aren't mix-compatible by definition.
  return { order: [...order, ...withoutBpm], pairScores };
}

export function orderByStrategy(
  strategy: SetlistStrategyId,
  entries: SetlistEntry[],
  weights: SetlistScoringWeights,
): { order: SetlistEntry[]; pairScores: number[] } {
  switch (strategy) {
    case 'bpm-ladder':
      return greedyBpmLadder(entries, weights);
    default:
      return greedyBpmLadder(entries, weights);
  }
}

// ─── HTTP client ─────────────────────────────────────────────────────────────

/** List the current annotator's saved setlist names. */
export async function listSetlists(): Promise<string[]> {
  try {
    const res = await fetch(API, { headers: annotatorHeaders() });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.names) ? (data.names as string[]) : [];
  } catch {
    return [];
  }
}

/** Fetch a single saved setlist by name. Returns null when absent. */
export async function loadSetlist(name: string): Promise<Setlist | null> {
  try {
    const res = await fetch(`${API}/${encodeURIComponent(name)}`, { headers: annotatorHeaders() });
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data === 'object' && 'entries' in data ? (data as Setlist) : null;
  } catch {
    return null;
  }
}

/** Persist a setlist. Server enforces team membership. */
export async function saveSetlist(setlist: Setlist): Promise<boolean> {
  try {
    const res = await fetch(`${API}/${encodeURIComponent(setlist.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...annotatorHeaders() },
      body: JSON.stringify(setlist),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteSetlist(name: string): Promise<boolean> {
  try {
    const res = await fetch(`${API}/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: annotatorHeaders(),
    });
    return res.ok;
  } catch {
    return false;
  }
}
