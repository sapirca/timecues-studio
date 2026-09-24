// Undo granularity for grid edits.
//
// Every grid edit — a BPM keystroke, an offset drag frame, a segment split —
// arrives at the page through the one `handleSongInfoChange` funnel, so the
// undo history is only as useful as its ability to tell a *gesture* from an
// *edit*. Typing "1", "3", "0" into the BPM box must undo as one step, not
// three; splitting the grid twice must undo as two.
//
// Continuous gestures the page can see coming (drags) pass their own
// coalesceKey. This module handles the ones it can't: a value the user types
// or nudges, recognized after the fact by what actually changed between the
// old SongInfo and the new one.

import type { SongInfo } from '../types/songInfo';

/** Fields a user edits by typing or nudging, where a run of consecutive edits
 *  is one intent. Everything else on SongInfo — segments, anchors, pinned
 *  beats, meter, mode — is a discrete change that earns its own undo step. */
const COALESCING_FIELDS = ['bpm', 'gridOffset', 'title', 'artist'] as const;

type CoalescingField = (typeof COALESCING_FIELDS)[number];

/** Everything about a SongInfo except `updated_at` (stamped on every edit, so
 *  never evidence of one) and `except` (the field under examination). */
function restSignature(info: SongInfo, except: CoalescingField): string {
  const keys = Object.keys(info).filter((k) => k !== 'updated_at' && k !== except).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = (info as unknown as Record<string, unknown>)[k];
  return JSON.stringify(out);
}

/**
 * The coalesceKey for an edit that took `prev` to `next`, or null when the
 * edit deserves its own undo step.
 *
 * Non-null only when exactly one typed/nudged field moved and nothing else
 * did — so a run of BPM keystrokes collapses, while a BPM change bundled with
 * a meter change (or any structural edit) stays its own step. Returning null
 * is always the safe answer: it costs an extra undo press, never a lost one.
 */
export function gridEditCoalesceKey(prev: SongInfo | null | undefined, next: SongInfo): string | null {
  if (!prev) return null;
  const changed = COALESCING_FIELDS.filter((f) => prev[f] !== next[f]);
  if (changed.length !== 1) return null;
  const field = changed[0];
  return restSignature(prev, field) === restSignature(next, field) ? `field:${field}` : null;
}
