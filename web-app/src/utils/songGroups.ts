// Grouping for the song sidebar's list.
//
// Most modes store nothing new — they file a song by data the sidebar already
// reads: the artist it prints on the row, the tempo/grid readiness behind its
// ♩ glyph, or the annotation verdict behind its status dot. Because the row and
// the heading must never disagree, each of those derives its key from the SAME
// helper the row renders from.
//
// Two modes need more than the sidebar has:
//   • Collection is the curator's own grouping, which nothing can infer — it
//     rides on song-info as `collection` (see types/songInfo.ts).
//   • Shared / per-annotator is the app's own collaborative flag — whether a
//     song has ONE team document behind an edit lock, or a copy per annotator
//     (services/annotationLocks.ts).
//   • Who else annotated counts the annotators with work on each song
//     (services/songAnnotators.ts).
//
// Both of those are the server's answer: they arrive late and can fail, so each
// is passed in as a state rather than a map — a heading that says "still
// asking" is honest, and an empty map would quietly read as "nobody".

import { isGridReady, songCollection, splitDisplayName } from '../types/songInfo';
import type { SongInfo } from '../types/songInfo';
import { deriveSongTracks } from './songAnnotationTracks';
import type { SongLayerStatuses } from '../services/annotationLayers';
import type { AutoGuessSongStatus } from '../services/autoGuessAnnotations';

/** The shape grouping needs from a catalogue entry — satisfied structurally by
 *  the sidebar's AudioEntry. `title` / `artist` are the manifest's mirrored
 *  copy of song-info, absent for uncurated songs. */
export interface GroupableSong {
  id: string;
  name: string;
  title?: string;
  artist?: string;
}

/** Title / artist for one catalogue entry, preferring the live song-info over
 *  the manifest's mirrored fields — so a curator's rename refiles the song
 *  without waiting for a manifest refetch. */
export function songNameParts(
  entry: GroupableSong,
  info: SongInfo | undefined,
): { title: string; artist?: string } {
  return splitDisplayName(entry.name, {
    title: info?.title ?? entry.title,
    artist: info?.title ? info.artist : entry.artist,
  });
}

/** Heading for the songs whose artist nobody has filled in — neither a curated
 *  song-info artist nor an "Artist — Title" file name. Always sorts last. */
export const UNKNOWN_ARTIST_LABEL = 'Unknown artist';

/** Heading for the songs the curator has not filed into a collection. Sorts
 *  last, same as the artist-less bucket. */
export const UNCOLLECTED_LABEL = 'No collection';

export type SongGroupMode = 'none' | 'artist' | 'collection' | 'readiness' | 'annotation' | 'collaborative' | 'sharing';

export const DEFAULT_SONG_GROUP_MODE: SongGroupMode = 'artist';

/** The Group by picker's options, in menu order. `hint` is the control's
 *  tooltip — it says what the headings will read, since that is the part the
 *  user is actually choosing between. */
export const SONG_GROUP_MODES: readonly { mode: SongGroupMode; label: string; hint: string }[] = [
  { mode: 'none', label: 'Nothing', hint: 'One flat list, sorted by title.' },
  { mode: 'artist', label: 'Artist', hint: 'A heading per artist, alphabetical, with the artist-less songs last.' },
  { mode: 'collection', label: 'Collection', hint: 'Your own grouping — a heading per collection name, typed per song in Dataset Prep.' },
  { mode: 'readiness', label: 'Tempo readiness', hint: 'No BPM yet / ready to annotate — the ♩ glyph on each row, as headings. Songs still missing a BPM lead.' },
  { mode: 'annotation', label: 'Annotation status', hint: 'All reviewed / in progress / not started — the status dot on each row, as headings.' },
  { mode: 'collaborative', label: 'Shared / per-annotator', hint: "The song's own setting: one shared team annotation behind an edit lock, or a copy per annotator. Set it on the song header — “Make collaborative”." },
  { mode: 'sharing', label: 'Who else annotated', hint: 'The team-shared songs first, then how many annotators have work on each of the rest.' },
];

export function isSongGroupMode(value: unknown): value is SongGroupMode {
  return SONG_GROUP_MODES.some((o) => o.mode === value);
}

export interface SongGroup<T extends GroupableSong = GroupableSong> {
  /** Stable identity for collapse state. Prefixed with the mode, so a fold
   *  under one grouping can never silently fold a same-named group under
   *  another. */
  key: string;
  label: string;
  /** True for the catch-all bucket (unknown artist / nothing annotated yet),
   *  which the sidebar dims — it is an absence of information, not a name. */
  unknown?: boolean;
  songs: T[];
}

/** Where the "who else annotated this?" answer stands. Modelled as a state
 *  rather than an optional map because every one of these is something the
 *  heading has to be able to say out loud: a request that is still in flight, a
 *  corpus where the question has no meaning, and a request that was refused all
 *  look like "nobody has annotated anything" if they collapse into an empty
 *  map, which is a lie the user cannot see through. */
export type SongSharingInfo =
  | { state: 'loading' }
  /** The request failed or was refused (public/demo visitors have no team). */
  | { state: 'unavailable' }
  /** Shared-corpus mode: one set of annotation files, edited by everyone, so
   *  there is no private half to separate out. */
  | { state: 'shared-corpus' }
  | {
      state: 'ready';
      /** slug → how many annotators have work on it. Absent = nobody. */
      counts: Record<string, number>;
      /** The caller's own annotated slugs. */
      mine: ReadonlySet<string>;
    };

/** Where the "is this song collaborative?" answer stands. Same shape and same
 *  reasoning as SongSharingInfo — a pending or refused request must be able to
 *  say so, because "no song is shared" is a different answer from "I could not
 *  find out". */
export type SongCollaborationInfo =
  | { state: 'loading' }
  | { state: 'unavailable' }
  /** The slugs the corpus has turned collaborative; everything else is
   *  per-annotator. */
  | { state: 'ready'; shared: ReadonlySet<string> };

/** What the non-artist modes need to file a song. Everything here except
 *  `sharing` is already loaded by the sidebar for its per-row indicators. */
export interface SongGroupingContext {
  infos: Record<string, SongInfo>;
  layerStatuses: Record<string, SongLayerStatuses>;
  autoGuessStatuses: Record<string, AutoGuessSongStatus>;
  /** Mirrors settings.experimentalLoopsAndPatterns — see deriveSongTracks. */
  includeLoopsAndPatterns: boolean;
  /** Omitted until the sidebar has reason to ask the server — the Who else
   *  annotated mode treats a missing state as still loading. */
  sharing?: SongSharingInfo;
  /** Likewise for Shared / per-annotator. */
  collaboration?: SongCollaborationInfo;
}

/** Bucket by a free-text name the songs carry — an artist, a collection.
 *
 *  Songs keep the manifest's order inside a bucket (it already sorts by the
 *  title the row prints), the buckets themselves sort by name, and the songs
 *  with no name collect in one trailing group instead of scattering through the
 *  list. Keys are case-folded so "Radiohead" and "radiohead" are one group,
 *  and the first spelling seen supplies the heading — the manifest arrives
 *  sorted, so that is deterministic rather than whichever row rendered first. */
function groupByName<T extends GroupableSong>(
  files: readonly T[],
  prefix: string,
  unknownLabel: string,
  nameOf: (entry: T) => string | undefined,
): SongGroup<T>[] {
  const byKey = new Map<string, SongGroup<T>>();
  for (const entry of files) {
    const name = nameOf(entry)?.trim();
    const key = name ? `${prefix}:${name.toLowerCase()}` : `${prefix}:`;
    const existing = byKey.get(key);
    if (existing) {
      existing.songs.push(entry);
      continue;
    }
    byKey.set(key, {
      key,
      label: name ?? unknownLabel,
      unknown: !name,
      songs: [entry],
    });
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.unknown) return 1;
    if (b.unknown) return -1;
    return a.label.localeCompare(b.label);
  });
}

/** One bucket per artist, artist-less songs last. */
export function groupSongsByArtist<T extends GroupableSong>(
  files: readonly T[],
  infos: Record<string, SongInfo>,
): SongGroup<T>[] {
  return groupByName(files, 'artist', UNKNOWN_ARTIST_LABEL, (entry) =>
    songNameParts(entry, infos[entry.id]).artist);
}

/** One bucket per curator-typed collection, uncollected songs last. Reads the
 *  live song-info only: the manifest does not mirror `collection`, and a
 *  freshly typed name should refile its song immediately. */
export function groupSongsByCollection<T extends GroupableSong>(
  files: readonly T[],
  infos: Record<string, SongInfo>,
): SongGroup<T>[] {
  return groupByName(files, 'collection', UNCOLLECTED_LABEL, (entry) =>
    songCollection(infos[entry.id]));
}

/** Fixed-order modes: a bucket list in workflow order, each song dropped into
 *  exactly one. Empty buckets are dropped — a heading with nothing under it
 *  says nothing. */
function groupByFixedBuckets<T extends GroupableSong>(
  files: readonly T[],
  buckets: readonly { key: string; label: string; unknown?: boolean }[],
  keyOf: (entry: T) => string,
): SongGroup<T>[] {
  const byKey = new Map<string, SongGroup<T>>(
    buckets.map((b) => [b.key, { ...b, songs: [] as T[] }]),
  );
  for (const entry of files) byKey.get(keyOf(entry))?.songs.push(entry);
  return [...byKey.values()].filter((g) => g.songs.length > 0);
}

/** Tempo readiness. Two buckets, not three: `isGridReady` is "has a BPM", and
 *  the grid lock it is often confused with is dataset-wide, not per-song — so
 *  "BPM set but not locked" is not a state a song can be in. */
const READINESS_BUCKETS = [
  { key: 'ready:no-bpm', label: 'No BPM yet', unknown: true },
  { key: 'ready:locked', label: 'Ready to annotate' },
] as const;

/** Annotation progress — the same verdict the row's status dot shows. */
const ANNOTATION_BUCKETS = [
  { key: 'ann:in_progress', label: 'In progress' },
  { key: 'ann:all_reviewed', label: 'All reviewed' },
  { key: 'ann:none', label: 'Not started', unknown: true },
] as const;

/** The song's own collaborative setting — the same one the song header offers
 *  as "Make collaborative…". These two buckets are both real states, so neither
 *  is dimmed: a per-annotator song is a decision, not missing information. */
const COLLABORATION_BUCKETS = [
  { key: 'collab:shared', label: 'Shared with the team' },
  { key: 'collab:solo', label: 'Per-annotator' },
] as const;

const COLLABORATION_NOTICES: Record<'loading' | 'unavailable', string> = {
  loading: 'Checking which songs are shared…',
  unavailable: 'Shared setting unknown — sign in to a team corpus',
};

/** The whole list under one dimmed heading that says why no per-song answer
 *  exists — never a silent flat list, and never a verdict the data does not
 *  support. */
function noticeGroup<T extends GroupableSong>(key: string, label: string, files: readonly T[]): SongGroup<T>[] {
  return [{ key, label, unknown: true, songs: [...files] }];
}

function groupSongsByCollaboration<T extends GroupableSong>(
  files: readonly T[],
  collaboration: SongCollaborationInfo | undefined,
): SongGroup<T>[] {
  const state = collaboration?.state ?? 'loading';
  if (state !== 'ready') {
    return noticeGroup(`collab:notice:${state}`, COLLABORATION_NOTICES[state], files);
  }
  const { shared } = collaboration as Extract<SongCollaborationInfo, { state: 'ready' }>;
  return groupByFixedBuckets(files, COLLABORATION_BUCKETS, (entry) =>
    shared.has(entry.id) ? 'collab:shared' : 'collab:solo');
}

/** How many annotators have work on the song. A different question from the
 *  one above, and deliberately worded so it cannot be read as the same: a song
 *  two people have annotated separately is NOT a shared song. "Someone else's"
 *  is kept apart from "Only mine" because one is work waiting for you and the
 *  other is work you would be duplicating. */
const SHARING_BUCKETS = [
  // A collaborative song leads, and is never filed by its head count. The work
  // on it lives in ONE team document, so counting per-annotator files there
  // answers a question nobody asked and can land the song under "Only mine"
  // while its own header says SHARED SONG — which is how this bucket got added.
  { key: 'share:collab', label: 'Shared with the team' },
  { key: 'share:multi', label: 'More than one annotator' },
  { key: 'share:mine', label: 'Only mine' },
  { key: 'share:theirs', label: "Someone else's" },
  { key: 'share:none', label: 'Not annotated yet', unknown: true },
] as const;

const SHARING_NOTICES: Record<'loading' | 'unavailable' | 'shared-corpus', string> = {
  loading: 'Checking who else annotated…',
  unavailable: 'Unknown — needs a team corpus',
  'shared-corpus': 'Shared corpus — everyone edits one set of files',
};

function groupSongsBySharing<T extends GroupableSong>(
  files: readonly T[],
  sharing: SongSharingInfo | undefined,
  collaboration: SongCollaborationInfo | undefined,
): SongGroup<T>[] {
  const state = sharing?.state ?? 'loading';
  if (state !== 'ready') {
    return noticeGroup(`share:notice:${state}`, SHARING_NOTICES[state], files);
  }
  const { counts, mine } = sharing as Extract<SongSharingInfo, { state: 'ready' }>;
  // The collaborative flag is a second request, and this mode works without it
  // — an answer that hasn't arrived just means no song is pulled out in front,
  // never a song filed under the wrong heading.
  const shared = collaboration?.state === 'ready' ? collaboration.shared : null;
  return groupByFixedBuckets(files, SHARING_BUCKETS, (entry) => {
    if (shared?.has(entry.id)) return 'share:collab';
    const count = counts[entry.id] ?? 0;
    if (count >= 2) return 'share:multi';
    if (count === 0) return 'share:none';
    return mine.has(entry.id) ? 'share:mine' : 'share:theirs';
  });
}

/** Group a catalogue for the sidebar. `none` returns a single unnamed group —
 *  the caller draws no headings for it, which is the flat list. */
export function groupSongs<T extends GroupableSong>(
  mode: SongGroupMode,
  files: readonly T[],
  ctx: SongGroupingContext,
): SongGroup<T>[] {
  if (files.length === 0) return [];
  switch (mode) {
    case 'artist':
      return groupSongsByArtist(files, ctx.infos);
    case 'collection':
      return groupSongsByCollection(files, ctx.infos);
    case 'collaborative':
      return groupSongsByCollaboration(files, ctx.collaboration);
    case 'sharing':
      return groupSongsBySharing(files, ctx.sharing, ctx.collaboration);
    case 'readiness':
      // Songs that still need a BPM lead: they are the ones blocking work.
      return groupByFixedBuckets(files, READINESS_BUCKETS, (entry) =>
        isGridReady(ctx.infos[entry.id]) ? 'ready:locked' : 'ready:no-bpm');
    case 'annotation':
      return groupByFixedBuckets(files, ANNOTATION_BUCKETS, (entry) => {
        const { overall } = deriveSongTracks({
          layerSummary: ctx.layerStatuses[entry.id],
          autoGuess: ctx.autoGuessStatuses[entry.id],
          includeLoopsAndPatterns: ctx.includeLoopsAndPatterns,
        });
        return `ann:${overall}`;
      });
    case 'none':
    default:
      return [{ key: 'none:all', label: '', songs: [...files] }];
  }
}
