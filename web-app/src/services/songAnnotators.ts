// How many people have annotated each song — the data behind the sidebar's
// "Shared / private" grouping.
//
// Counts only, never identities: the question this answers is "will my reading
// of this song be compared against somebody else's?", which everyone on the
// team may ask. Who those people are, and how long they spent, stays behind
// the admin/researcher-gated Team dashboard (`services/teamStats.ts`).

import { annotatorHeaders } from '../utils/annotatorHeaders';

export interface SongAnnotatorsResponse {
  /** True when the corpus is in shared mode, where annotations are one set of
   *  files everybody edits. There are no per-annotator counts to report then —
   *  the distinction the grouping draws does not exist. */
  sharedCorpus: boolean;
  /** slug → number of annotators with work on that song. Songs nobody has
   *  annotated are absent rather than zero. */
  counts: Record<string, number>;
  /** The caller's own annotated songs. */
  mine: string[];
}

/** One annotator on one song. No id: names are resolved server-side precisely
 *  so a non-admin caller never receives another annotator's raw id, which for
 *  a Google sign-in is their email. */
export interface SongAnnotatorEntry {
  /** Display name, or the raw id when that annotator has no profile yet —
   *  the same fallback the editing-lock bar uses. */
  name: string;
  /** True for the caller's own row. */
  mine: boolean;
  /** Markers on the song: layer items plus auto-guess points. */
  items: number;
}

export interface SongAnnotatorRoster {
  slug: string;
  sharedCorpus: boolean;
  /** The caller first, then whoever has the most on the song. */
  annotators: SongAnnotatorEntry[];
}

/** Who has work on ONE song, by name. Asked only when someone opens the row's
 *  head-count badge — the list view never needs names, and not sending them
 *  until they are looked at keeps the sidebar's routine fetch anonymous. */
export async function fetchSongAnnotatorRoster(slug: string): Promise<SongAnnotatorRoster> {
  const res = await fetch(`/api/song-annotators?slug=${encodeURIComponent(slug)}`, {
    headers: annotatorHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<SongAnnotatorRoster>;
}

export async function fetchSongAnnotators(): Promise<SongAnnotatorsResponse> {
  const res = await fetch('/api/song-annotators', { headers: annotatorHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<SongAnnotatorsResponse>;
}

/** The row badge's rule and wording in one place, so the sidebar and its tests
 *  agree on when a head count is worth drawing.
 *
 *  It is drawn only when somebody OTHER than you has work on the song. A "1" on
 *  every song you annotated yourself is noise, and the status dot beside it
 *  already reports your own progress — the badge exists to say "you are not
 *  alone on this one". */
export function describeAnnotatorCount(
  count: number,
  includesMe: boolean,
): { show: boolean; title: string } {
  if (count <= 0 || (count === 1 && includesMe)) return { show: false, title: '' };
  if (count === 1) {
    return { show: true, title: 'One annotator has work on this song, and it is not you' };
  }
  const others = count - 1;
  return {
    show: true,
    title: includesMe
      ? `${count} annotators have work on this song: you and ${others} other${others === 1 ? '' : 's'}`
      : `${count} annotators have work on this song, none of them you`,
  };
}
