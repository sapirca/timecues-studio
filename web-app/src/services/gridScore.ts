// Scoring the grid on screen against every beat tracker that has run.
//
// The curated grid IS beat annotation — a rule (gridOffset + bpm + splits)
// rather than a list — so a tracker's output can be scored against it with
// mir_eval, the same way any beat-tracking paper reports F-measure. That
// turns "is this grid right?" from a question you answer by listening into
// one with a number attached.
//
// The grid travels in the REQUEST, not read from disk server-side, so this
// scores unsaved edits. Drag the downbeat and the score moves; reading
// song-info would always be one autosave behind.
//
// Served by the mir_eval server (:8001, core-mir) rather than by a tracker
// sidecar, so checking a grid works without the experimental profile running.

import type { SongInfo } from '../types/songInfo';

/** One mir_eval scoring of a (reference, estimate) pair. */
export interface BeatScore {
  /** ±70 ms F-measure — the field's convention, so these numbers are
   *  directly comparable to published ones. */
  f_measure: number;
  /** Continuity at the correct metrical level. */
  cmlt: number;
  /** Continuity allowing half/double time and offbeat. A high AMLt next to a
   *  low CMLt is the signature of an octave disagreement rather than an
   *  error. */
  amlt: number;
  n_ref: number;
  n_est: number;
}

export interface TrackerScore {
  beat: BeatScore | null;
  /** Null for detectors that report no downbeats (librosa, madmom-rnn-beats). */
  downbeat: BeatScore | null;
  /** The tempo this tracker actually heard, from its median inter-beat
   *  interval. Shown in place of the beat F-measure because it answers the
   *  question a curator has: an F1 of 0.02 says "disagrees with your grid"
   *  without saying how, and a tracker can have the tempo exactly right and
   *  still score near zero when only the phase is off. */
  bpm: number | null;
}

/** What the trackers collectively think the grid should be. */
export interface GridSuggestion {
  /** Median BPM across trackers — median so one detector locking onto
   *  double-time doesn't drag the number halfway there. */
  bpm: number | null;
  /** First downbeat, i.e. a candidate `gridOffset`. */
  firstDownbeat: number | null;
}

/** The four states, in the order a curator cares about them.
 *  - `confirmed` — models agree with this grid. Nothing to do.
 *  - `disputed`  — models agree with each OTHER and not with the grid.
 *                  Independent architectures don't fail identically.
 *  - `octave`    — low F1, high AMLt: right pulse, different metrical level.
 *                  A judgment call, NOT an error.
 *  - `weak`      — nothing matches and the models disagree with each other
 *                  too, so there's no verdict to give. */
export type GridVerdict = 'confirmed' | 'disputed' | 'octave' | 'weak' | 'unscorable';

export interface GridScoreResult {
  ok: true;
  slug: string;
  duration: number;
  /** Set when the grid is scorable but something about it weakens the
   *  result (e.g. offset is exactly 0, so the downbeat may never have been
   *  aligned — and phase is most of what's being measured). */
  caveat: string | null;
  /** Mean pairwise agreement among the trackers themselves. */
  consensus: number | null;
  verdict: GridVerdict;
  reason: string;
  refBeats: number;
  trackers: Record<string, TrackerScore>;
  suggestion: GridSuggestion;
}

export interface GridScoreRefusal {
  ok: false;
  slug: string;
  /** Why this grid can't be scored — no tracker has run, the grid is a shape
   *  the expander doesn't model (Hand-placed overrides, Drifting anchors), or
   *  the scoring server isn't reachable. Shown to the curator instead of a
   *  number. */
  reason: string;
  /** A command that would fix it, when there is one — the dev proxy answers
   *  an unreachable sidecar with exactly this. */
  hint?: string;
}

export type GridScoreResponse = GridScoreResult | GridScoreRefusal;

/** Score `info` — the grid as currently edited — for `slug`.
 *
 *  Never returns null for a reachable-but-unhappy server: an unreachable one
 *  comes back as a refusal carrying the reason and, where the dev proxy
 *  supplies one, the command that fixes it. Returning nothing would leave a
 *  curator who deliberately opened the step looking at a blank card, which is
 *  the one answer that explains nothing.
 *
 *  Null is reserved for an aborted request — a superseded keystroke, which
 *  the caller should ignore rather than report.
 */
export async function scoreGrid(
  slug: string,
  info: SongInfo,
  duration?: number,
  signal?: AbortSignal,
): Promise<GridScoreResponse | null> {
  try {
    const res = await fetch('/api/mir-eval/grid-score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, grid: info, duration }),
      signal,
    });
    if (res.ok) return await res.json() as GridScoreResponse;

    // The dev proxy 503s an unreachable sidecar with {error, hint}; a real
    // server error carries {error}. Either way there is something to say.
    const body = await res.json().catch(() => null) as
      { error?: string; hint?: string } | null;
    return {
      ok: false,
      slug,
      reason: body?.error
        ?? `The scoring server answered ${res.status}.`,
      hint: body?.hint,
    };
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return null;
    return {
      ok: false,
      slug,
      reason: "Can't reach the scoring server.",
      hint: 'python tools/python/mir_eval_server.py',
    };
  }
}

/** Trackers that report downbeats, best-scoring first on this corpus.
 *  Used to order the table so the row that matters most is at the top. */
export const TRACKER_ORDER = [
  'beat-transformer',
  'beat-this',
  'madmom-dbn-downbeats',
  'beatnet',
  'madmom-rnn-beats',
  'librosa-beat-track',
];

/** How a tracker's tempo relates to the grid's. Drives the BPM cell's colour.
 *
 *  `octave` is deliberately not `off`: a tracker reporting 65 against a grid
 *  of 130 heard the right pulse and counted it at a different level, which is
 *  the same distinction the verdict badge makes. Colouring it red would send
 *  a curator to "fix" a grid that is already right. */
export type BpmRelation = 'match' | 'close' | 'octave' | 'off' | 'unknown';

/** Within half a BPM is the same tempo — below the resolution any of this
 *  matters at. Within 2 is close enough to be a rounding or a detector's
 *  frame-grid artifact rather than a disagreement. */
const BPM_MATCH = 0.5;
const BPM_CLOSE = 2;
/** 6% of the ratio, matching OCTAVE_TOLERANCE in tools/python/beat_segments.py. */
const OCTAVE_TOLERANCE = 0.06;

export function bpmRelation(trackerBpm: number | null | undefined, gridBpm: number | null | undefined): BpmRelation {
  if (trackerBpm == null || !gridBpm) return 'unknown';
  const diff = Math.abs(trackerBpm - gridBpm);
  if (diff <= BPM_MATCH) return 'match';
  if (diff <= BPM_CLOSE) return 'close';
  const ratio = Math.max(trackerBpm, gridBpm) / Math.min(trackerBpm, gridBpm);
  if ([2, 4].some((f) => Math.abs(ratio - f) / f <= OCTAVE_TOLERANCE)) return 'octave';
  return 'off';
}

/** The ×2 / ÷2 hint shown beside an octave-related tempo, so the reader can
 *  see at a glance that it is a level difference and not a wrong answer. */
export function octaveHint(trackerBpm: number, gridBpm: number): string | null {
  const ratio = trackerBpm / gridBpm;
  for (const [factor, label] of [[2, '×2'], [4, '×4'], [0.5, '÷2'], [0.25, '÷4']] as const) {
    if (Math.abs(ratio - factor) / factor <= OCTAVE_TOLERANCE) return label;
  }
  return null;
}

export function orderTrackers(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const ia = TRACKER_ORDER.indexOf(a);
    const ib = TRACKER_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}
