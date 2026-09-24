import { describe, it, expect } from 'vitest';
import { groupSongs, groupSongsByArtist, groupSongsByCollection, isSongGroupMode, songNameParts, UNCOLLECTED_LABEL, UNKNOWN_ARTIST_LABEL } from './songGroups';
import type { SongGroupingContext } from './songGroups';
import { makeEmptySongInfo } from '../types/songInfo';
import type { SongInfo } from '../types/songInfo';

const song = (id: string, name: string, extra: { title?: string; artist?: string } = {}) =>
  ({ id, name, ...extra });

/** song-info carrying a curated title (and optionally an artist). */
const curated = (slug: string, title: string, artist?: string): SongInfo =>
  ({ ...makeEmptySongInfo(slug), title, artist });

describe('songNameParts', () => {
  it('prefers live song-info over the manifest mirror', () => {
    const entry = song('s1', 'Old Artist — Old Title', { title: 'Old Title', artist: 'Old Artist' });
    expect(songNameParts(entry, curated('s1', 'New Title', 'New Artist')))
      .toEqual({ title: 'New Title', artist: 'New Artist' });
  });

  it('falls back to splitting the file-name convention', () => {
    expect(songNameParts(song('s1', 'Boards of Canada — Roygbiv'), undefined))
      .toEqual({ title: 'Roygbiv', artist: 'Boards of Canada' });
  });

  it('leaves the artist undefined when the name carries no separator', () => {
    expect(songNameParts(song('s1', 'untitled_take_3'), undefined))
      .toEqual({ title: 'untitled_take_3' });
  });
});

describe('groupSongsByArtist', () => {
  it('buckets by artist and sorts the headings alphabetically', () => {
    const groups = groupSongsByArtist(
      [
        song('a', 'Zappa — Peaches'),
        song('b', 'Aphex Twin — Xtal'),
        song('c', 'Zappa — Montana'),
      ],
      {},
    );
    expect(groups.map((g) => [g.label, g.songs.map((s) => s.id)]))
      .toEqual([['Aphex Twin', ['b']], ['Zappa', ['a', 'c']]]);
  });

  it('preserves the manifest order inside a bucket', () => {
    const groups = groupSongsByArtist(
      [song('a', 'Zappa — Alpha'), song('b', 'Zappa — Beta'), song('c', 'Zappa — Gamma')],
      {},
    );
    expect(groups[0].songs.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('case-folds so one artist is never split across two headings', () => {
    const groups = groupSongsByArtist(
      [song('a', 'Radiohead — Idioteque'), song('b', 'radiohead — Reckoner')],
      {},
    );
    expect(groups).toHaveLength(1);
    // First spelling seen wins the heading.
    expect(groups[0].label).toBe('Radiohead');
    expect(groups[0].songs.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('collects artist-less songs in one trailing group', () => {
    const groups = groupSongsByArtist(
      [song('a', 'untitled_take_3'), song('b', 'Zappa — Peaches'), song('c', 'field_recording')],
      {},
    );
    expect(groups.map((g) => g.label)).toEqual(['Zappa', UNKNOWN_ARTIST_LABEL]);
    expect(groups[1].key).toBe('artist:');
    expect(groups[1].songs.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('refiles a song the moment its song-info artist changes', () => {
    const files = [song('a', 'untitled_take_3'), song('b', 'Zappa — Peaches')];
    expect(groupSongsByArtist(files, {}).map((g) => g.label))
      .toEqual(['Zappa', UNKNOWN_ARTIST_LABEL]);
    expect(groupSongsByArtist(files, { a: curated('a', 'Take 3', 'Zappa') }).map((g) => g.label))
      .toEqual(['Zappa']);
  });

  it('treats a curated title with no artist as unknown, not as the title', () => {
    const groups = groupSongsByArtist([song('a', 'Zappa — Peaches')], { a: curated('a', 'Peaches') });
    expect(groups.map((g) => g.label)).toEqual([UNKNOWN_ARTIST_LABEL]);
  });

  it('returns nothing for an empty catalogue', () => {
    expect(groupSongsByArtist([], {})).toEqual([]);
  });
});

/** Grouping context with nothing in it — each test fills only what it needs. */
const ctx = (over: Partial<SongGroupingContext> = {}): SongGroupingContext => ({
  infos: {},
  layerStatuses: {},
  autoGuessStatuses: {},
  includeLoopsAndPatterns: false,
  ...over,
});

const gridded = (slug: string, bpm?: number): SongInfo => ({ ...makeEmptySongInfo(slug), bpm });

/** song-info carrying a collection name. */
const filed = (slug: string, collection?: string): SongInfo =>
  ({ ...makeEmptySongInfo(slug), collection });

describe('isSongGroupMode', () => {
  it('accepts the modes the picker offers and rejects anything else', () => {
    expect(isSongGroupMode('artist')).toBe(true);
    expect(isSongGroupMode('none')).toBe(true);
    expect(isSongGroupMode('by-vibes')).toBe(false);
    expect(isSongGroupMode(null)).toBe(false);
  });
});

describe('groupSongs', () => {
  const three = [song('a', 'Zappa — Peaches'), song('b', 'Aphex Twin — Xtal'), song('c', 'untitled')];

  it('returns nothing for an empty catalogue, whatever the mode', () => {
    for (const mode of ['none', 'artist', 'collection', 'readiness', 'annotation', 'collaborative', 'sharing'] as const) {
      expect(groupSongs(mode, [], ctx())).toEqual([]);
    }
  });

  it('none keeps one flat group in manifest order', () => {
    const groups = groupSongs('none', three, ctx());
    expect(groups).toHaveLength(1);
    expect(groups[0].songs.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('artist matches the dedicated artist grouping', () => {
    expect(groupSongs('artist', three, ctx())).toEqual(groupSongsByArtist(three, {}));
  });

  it('readiness leads with the songs still missing a BPM', () => {
    const groups = groupSongs('readiness', three, ctx({
      infos: { a: gridded('a', 120), b: gridded('b') },
    }));
    expect(groups.map((g) => [g.label, g.songs.map((s) => s.id)])).toEqual([
      ['No BPM yet', ['b', 'c']],
      ['Ready to annotate', ['a']],
    ]);
  });

  it('annotation files by the same verdict the row status dot shows', () => {
    const groups = groupSongs('annotation', three, ctx({
      layerStatuses: {
        a: { slug: 'a', layers: { cues: { count: 3, status: 'reviewed' } } },
        b: { slug: 'b', layers: { cues: { count: 3, status: 'in_progress' } } },
      },
    }));
    expect(groups.map((g) => [g.label, g.songs.map((s) => s.id)])).toEqual([
      ['In progress', ['b']],
      ['All reviewed', ['a']],
      ['Not started', ['c']],
    ]);
  });

  it('drops buckets nothing lands in', () => {
    const groups = groupSongs('readiness', three, ctx());
    expect(groups.map((g) => g.label)).toEqual(['No BPM yet']);
  });

  it('marks the catch-all bucket so the sidebar can dim it', () => {
    expect(groupSongs('artist', [song('c', 'untitled')], ctx())[0].unknown).toBe(true);
    expect(groupSongs('readiness', [song('c', 'untitled')], ctx())[0].unknown).toBe(true);
    expect(groupSongs('artist', [song('a', 'Zappa — Peaches')], ctx())[0].unknown).toBe(false);
  });

  it('keys are mode-prefixed, so a fold under one mode cannot fold another', () => {
    const artistKeys = groupSongs('artist', three, ctx()).map((g) => g.key);
    const readinessKeys = groupSongs('readiness', three, ctx()).map((g) => g.key);
    expect(artistKeys.every((k) => k.startsWith('artist:'))).toBe(true);
    expect(readinessKeys.every((k) => k.startsWith('ready:'))).toBe(true);
    expect(artistKeys.filter((k) => readinessKeys.includes(k))).toEqual([]);
  });
});

describe('groupSongsByCollection', () => {
  const three = [song('a', 'Alpha'), song('b', 'Beta'), song('c', 'Gamma')];

  it('buckets by the curator-typed name, uncollected last', () => {
    const groups = groupSongsByCollection(three, {
      a: filed('a', 'Set 2'),
      b: filed('b', 'Set 1'),
    });
    expect(groups.map((g) => [g.label, g.songs.map((s) => s.id)])).toEqual([
      ['Set 1', ['b']],
      ['Set 2', ['a']],
      [UNCOLLECTED_LABEL, ['c']],
    ]);
    expect(groups[2].unknown).toBe(true);
  });

  it('treats a blank or whitespace collection as uncollected', () => {
    const groups = groupSongsByCollection([song('a', 'Alpha'), song('b', 'Beta')], {
      a: filed('a', '   '),
      b: filed('b', ''),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe(UNCOLLECTED_LABEL);
  });

  it('case-folds so one collection is never split across two headings', () => {
    const groups = groupSongsByCollection([song('a', 'Alpha'), song('b', 'Beta')], {
      a: filed('a', 'Set 1'),
      b: filed('b', 'set 1'),
    });
    expect(groups).toHaveLength(1);
    // First spelling seen wins the heading, as with artists.
    expect(groups[0].label).toBe('Set 1');
    expect(groups[0].songs.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('refiles a song as soon as its song-info changes', () => {
    const files = [song('a', 'Alpha')];
    expect(groupSongsByCollection(files, {})[0].label).toBe(UNCOLLECTED_LABEL);
    expect(groupSongsByCollection(files, { a: filed('a', 'Encores') })[0].label).toBe('Encores');
  });
});

describe('groupSongs — shared / per-annotator', () => {
  const three = [song('a', 'Alpha'), song('b', 'Beta'), song('c', 'Gamma')];

  it("splits on the song's own collaborative setting", () => {
    const groups = groupSongs('collaborative', three, ctx({
      collaboration: { state: 'ready', shared: new Set(['b']) },
    }));
    expect(groups.map((g) => [g.label, g.songs.map((s) => s.id)])).toEqual([
      ['Shared with the team', ['b']],
      ['Per-annotator', ['a', 'c']],
    ]);
  });

  it('dims neither bucket — per-annotator is a decision, not missing data', () => {
    const groups = groupSongs('collaborative', three, ctx({
      collaboration: { state: 'ready', shared: new Set(['a']) },
    }));
    expect(groups.map((g) => g.unknown)).toEqual([undefined, undefined]);
  });

  it('never claims nothing is shared while the answer is in flight or refused', () => {
    for (const [state, label] of [
      ['loading', 'Checking which songs are shared…'],
      ['unavailable', 'Shared setting unknown — sign in to a team corpus'],
    ] as const) {
      const groups = groupSongs('collaborative', three, ctx({ collaboration: { state } }));
      expect(groups).toHaveLength(1);
      expect(groups[0].label).toBe(label);
      expect(groups[0].songs).toHaveLength(3);
      expect(groups[0].unknown).toBe(true);
    }
    // A missing state is still loading, not an empty answer.
    expect(groupSongs('collaborative', three, ctx())[0].label).toBe('Checking which songs are shared…');
  });

  it('keeps its keys apart from the annotator-count mode, which sounds alike', () => {
    const collabKeys = groupSongs('collaborative', three, ctx({
      collaboration: { state: 'ready', shared: new Set(['a']) },
    })).map((g) => g.key);
    const countKeys = groupSongs('sharing', three, ctx({
      sharing: { state: 'ready', counts: { a: 2 }, mine: new Set() },
    })).map((g) => g.key);
    expect(collabKeys.every((k) => k.startsWith('collab:'))).toBe(true);
    expect(countKeys.every((k) => k.startsWith('share:'))).toBe(true);
    expect(collabKeys.filter((k) => countKeys.includes(k))).toEqual([]);
  });
});

describe('groupSongs — who else annotated', () => {
  const three = [song('a', 'Alpha'), song('b', 'Beta'), song('c', 'Gamma')];
  const ready = (counts: Record<string, number>, mine: string[]) =>
    ctx({ sharing: { state: 'ready', counts, mine: new Set(mine) } });

  it('leads with the collaborative songs, whatever their head count', () => {
    // Peter the Wolf's own header says SHARED SONG; filing it under "Only mine"
    // because one id has a leftover file is the bug this bucket fixes.
    const groups = groupSongs('sharing', three, ctx({
      sharing: { state: 'ready', counts: { a: 1, b: 2, c: 1 }, mine: new Set(['a', 'b']) },
      collaboration: { state: 'ready', shared: new Set(['a']) },
    }));
    expect(groups.map((g) => [g.label, g.songs.map((s) => s.id)])).toEqual([
      ['Shared with the team', ['a']],
      ['More than one annotator', ['b']],
      ["Someone else's", ['c']],
    ]);
  });

  it('files by head count alone while the collaborative flag is missing', () => {
    const groups = groupSongs('sharing', three, ctx({
      sharing: { state: 'ready', counts: { a: 1 }, mine: new Set(['a']) },
      collaboration: { state: 'loading' },
    }));
    expect(groups.map((g) => g.label)).toEqual(['Only mine', 'Not annotated yet']);
  });

  it('separates multi-annotator, mine, someone else’s and untouched', () => {
    const groups = groupSongs('sharing', three, ready({ a: 2, b: 1, c: 1 }, ['b']));
    expect(groups.map((g) => [g.label, g.songs.map((s) => s.id)])).toEqual([
      ['More than one annotator', ['a']],
      ['Only mine', ['b']],
      ["Someone else's", ['c']],
    ]);
  });

  it('files a song nobody has annotated under its own dimmed heading', () => {
    const groups = groupSongs('sharing', [song('a', 'Alpha')], ready({}, []));
    expect(groups.map((g) => g.label)).toEqual(['Not annotated yet']);
    expect(groups[0].unknown).toBe(true);
  });

  it('never reports "not annotated" while the answer is still in flight', () => {
    const groups = groupSongs('sharing', three, ctx({ sharing: { state: 'loading' } }));
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Checking who else annotated…');
    expect(groups[0].songs.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('treats a missing sharing state as still loading, not as an empty corpus', () => {
    expect(groupSongs('sharing', three, ctx())[0].label).toBe('Checking who else annotated…');
  });

  it('says so when the corpus has no private half, instead of grouping', () => {
    const groups = groupSongs('sharing', three, ctx({ sharing: { state: 'shared-corpus' } }));
    expect(groups[0].label).toBe('Shared corpus — everyone edits one set of files');
    expect(groups[0].songs).toHaveLength(3);
  });

  it('says so when the answer was refused, and still lists every song', () => {
    const groups = groupSongs('sharing', three, ctx({ sharing: { state: 'unavailable' } }));
    expect(groups[0].label).toBe('Unknown — needs a team corpus');
    expect(groups[0].songs).toHaveLength(3);
  });

  it('keeps its keys out of every other mode\'s fold state', () => {
    const keys = groupSongs('sharing', three, ready({ a: 2 }, [])).map((g) => g.key);
    expect(keys.every((k) => k.startsWith('share:'))).toBe(true);
    const collectionKeys = groupSongs('collection', three, ctx()).map((g) => g.key);
    expect(collectionKeys.every((k) => k.startsWith('collection:'))).toBe(true);
    expect(keys.filter((k) => collectionKeys.includes(k))).toEqual([]);
  });
});
