import { describe, it, expect } from 'vitest';
import { scanDatasetFiles, type ScannedSong } from './datasetImport';

// Build a File whose webkitRelativePath drives the scanner's path classifier
// (matching how the folder-picker / drag-drop walker populate it).
function fileAt(relPath: string, body = '{}'): File {
  const name = relPath.split('/').pop() ?? relPath;
  const f = new File([body], name, { type: 'application/json' });
  Object.defineProperty(f, 'webkitRelativePath', { value: relPath, configurable: true });
  return f;
}

function songBySlug(songs: ScannedSong[], slug: string): ScannedSong {
  const s = songs.find((x) => x.slug === slug);
  if (!s) throw new Error(`no song ${slug} (have: ${songs.map((x) => x.slug).join(', ')})`);
  return s;
}

describe('scanDatasetFiles — export-bundle layout', () => {
  it('recognises a single-song export bundle (the previously-broken round-trip)', () => {
    const files = [
      fileAt('my_song/audio.mp3'),
      fileAt('my_song/song-info.json'),
      fileAt('my_song/boundaries/manual/my_song.json'),
      fileAt('my_song/boundaries/eye/my_song.json'),
      fileAt('my_song/boundaries/auto-guess/my_song.json'),
      fileAt('my_song/cues/kick-hits.json'),
      fileAt('my_song/cues/fx-triggers.json'),
      fileAt('my_song/spans/sections.json'),
      fileAt('my_song/stems/drums.wav'),
    ];
    const { songs, unrecognized } = scanDatasetFiles(files);

    expect(songs).toHaveLength(1);
    const song = songBySlug(songs, 'my_song');
    expect(song.audio).not.toBeNull();
    expect(song.songInfo).not.toBeNull();
    expect(song.annotations.manual).toBeTruthy();
    expect(song.annotations.eye).toBeTruthy();
    expect(song.annotations['auto-guess']).toBeTruthy();
    // The per-type user-layer files are collected (not dropped) for later
    // reassembly into one AnnotationLayersDocument.
    expect(song.layerFiles.map((l) => `${l.type}:${l.name}`).sort()).toEqual([
      'cues:fx-triggers',
      'cues:kick-hits',
      'spans:sections',
    ]);
    expect(song.stems.drums).toBeTruthy();
    expect(unrecognized).toHaveLength(0);
  });

  it('anchors the slug on the song folder, not the layer filename', () => {
    // `cues/kick-hits.json` must land under `my_song`, never a phantom
    // `kick_hits` / `kick-hits` row.
    const { songs } = scanDatasetFiles([fileAt('my_song/cues/kick-hits.json')]);
    expect(songs.map((s) => s.slug)).toEqual(['my_song']);
    expect(songs[0].layerFiles).toHaveLength(1);
  });

  it('tolerates a wrapper dir above the song folder (unzipped export)', () => {
    const { songs } = scanDatasetFiles([
      fileAt('timecues-export-2026-05-29/my_song/boundaries/manual/my_song.json'),
      fileAt('timecues-export-2026-05-29/my_song/audio.mp3'),
    ]);
    const song = songBySlug(songs, 'my_song');
    expect(song.annotations.manual).toBeTruthy();
    expect(song.audio).not.toBeNull();
  });

  it('reads through the <annotator> sub-dir in multi-annotator dumps', () => {
    const { songs } = scanDatasetFiles([
      fileAt('my_song/boundaries/manual/alice/my_song.json'),
      fileAt('my_song/cues/alice/kick-hits.json'),
    ]);
    const song = songBySlug(songs, 'my_song');
    expect(song.annotations.manual).toBeTruthy();
    expect(song.layerFiles).toHaveLength(1);
  });

  it('skips lossy flat-marker exports but keeps the JSON twin', () => {
    const { songs, unrecognized } = scanDatasetFiles([
      fileAt('my_song/boundaries/manual/my_song.json'),
      fileAt('my_song/boundaries/manual/my_song.txt'),     // Audacity — lossy
      fileAt('my_song/cues/kick-hits.jams'),               // JAMS — lossy
      fileAt('my_song/grid/my_song.txt'),                  // derived, no endpoint
      fileAt('my_song/algos/allin1.json'),                 // cache, no endpoint
    ]);
    const song = songBySlug(songs, 'my_song');
    expect(song.annotations.manual).toBeTruthy();
    expect(song.layerFiles).toHaveLength(0);
    expect(unrecognized.sort()).toEqual([
      'my_song/algos/allin1.json',
      'my_song/boundaries/manual/my_song.txt',
      'my_song/cues/kick-hits.jams',
      'my_song/grid/my_song.txt',
    ]);
  });

  it('does not mistake the literal audio.mp3 for a song named "audio"', () => {
    const { songs } = scanDatasetFiles([fileAt('my_song/audio.mp3')]);
    expect(songs.map((s) => s.slug)).toEqual(['my_song']);
  });
});
