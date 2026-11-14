/**
 * Tests for the timing-files exporter.
 *
 *   node --test tools/export-timing-files.test.mjs
 *
 * Stdlib only (`node:test`, `node:assert`), like the exporter itself — it has
 * zero dependencies on purpose so it can be dropped into any checkout, and a
 * test that needed a package install would undo that.
 *
 * The exporter resolves its data root from its own location (`__dirname/..`),
 * so each test copies the script into a temp directory beside a synthetic
 * `data/` tree and runs it there. Nothing here reads the real corpus: a test
 * that depends on one song's annotations is a test that breaks when somebody
 * annotates that song.
 *
 * What these guard is the failure that motivated schema v2 — the exporter
 * silently reducing every annotation to `{start, end, label}`. Every
 * assertion below is a field that was recorded by the app and dropped here.
 * The hook at .claude/hooks/export_guard.py catches a NEW field nobody
 * exported; these catch an existing one quietly regressing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EXPORTER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'export-timing-files.mjs');

const ENERGY_BLOB = {
  type: 'energy_span', song: 'fx', stem: 'drums',
  start_ms: 8000, end_ms: 12000, duration_ms: 4000,
  trend: 'increasing', start_energy: 0.2, end_energy: 0.9,
  brightness_trend: 'increasing', brightness_hz: { start: 1100, end: 5600, peak: 5900 },
  curve: [
    { t_ms: 0, energy: 0.2000001, brightness: 0.41234, beat_strength: 0.3, flux: 0.25 },
    { t_ms: 2000, energy: 0.5, brightness: 0.7, beat_strength: 0.6, flux: 0.5 },
    { t_ms: 4000, energy: 0.9, brightness: 1, beat_strength: 1, flux: 1 },
  ],
  envelope: {
    shape: 'sustained', attack_ms: 120, decay_ms: 400, sustain_ms: 1200,
    release_ms: 900, sustain_level: 0.8, peak_at_ms: 150, peak_rms: 0.44,
  },
  description: 'Energy on the drums stem rises from 0.20 to 0.90 over 4.0s.',
};

/** One song, one annotator, every layer type that carries something worth
 *  exporting. Deliberately small: each item exists to pin one field. */
function fixtureDoc() {
  return {
    song: 'fx',
    annotated_at: '2026-09-17T00:00:00Z',
    groups: [{ id: 'g1', name: 'Rhythm', color: '#ffffff' }],
    layers: [
      {
        id: 'L1', name: 'Hats', type: 'spans', visible: true, color: '#00ff00',
        snap: 'beat', groupId: 'g1', summary: '1 main loop over 4 bars, most played first. A — 4 bars (1–4).',
        items: [
          {
            id: 's1', start: 4, end: 12, startBeat: 8, endBeat: 24, label: 'Hi-hats',
            description: 'steady through the breakdown', pulse: '16th', importance: 'optional',
            prominence: [{ t: 0, level: 'lead' }, { t: 4, level: 'backing', ramp: 'ramp' }],
            candidates: [[4, 11.5]],
          },
          { id: 's2', start: 8, end: 12, label: 'Energy: rising (drums)', description: JSON.stringify(ENERGY_BLOB) },
          { id: 's3', start: 1, end: 2, label: 'bar hits', pulse: 'bar' },
          { id: 's4', start: 3, end: 4, label: 'violin', color: '#38bdf8',
            envelope: { start: 3.02, peak: 3.1, decayEnd: 3.3, release: 3.8, end: 4, peakDb: -11.5, source: 'drums', peaks: 3 } },
        ],
      },
      {
        // Doubles as the detector-provenance fixture: read-only, with a source,
        // a description and a caveat the detector raised about its own run.
        id: 'L2', name: 'Loop A', type: 'loops', visible: true, color: '#0000ff', snap: 'bar',
        readOnly: true, source: 'detector:kit_groove_detector', sourceStem: 'drums',
        sourceDescription: 'Repeating drum grooves.',
        sourceNotes: [{ code: 'empty-band:hat', message: 'holds 0.1% of this stem energy' }],
        items: [{ id: 'lp1', start: 0, end: 8, label: '8s loop', bars: 4, snapZeroCross: true, color: '#a3e635' }],
      },
      {
        id: 'L3', name: 'Vocals', type: 'lyrics', visible: true, color: '#ff00ff', snap: 'off',
        vocalRuns: [{ id: 'r1', start: 2, end: 6, prominence: [{ t: 0, level: 'lead' }] }],
        items: [
          { id: 'w1', time: 2, text: 'hello', kind: 'word' },
          { id: 'w3', time: 7, end: 7.6, text: 'a-la', kind: 'word',
            onsets: [{ time: 6.9, text: 'x' }, { time: 7, text: 'a' }, { time: 7.25 }, { time: 7.4, text: 'la' }],
            envelope: { start: 6.95, peak: 7.05, decayEnd: 7.2, release: 7.5, end: 8.1, peakDb: -14.2, sustainDb: -9 } },
          { id: 'w2', time: 3, end: 6, text: 'hello world', kind: 'line', description: 'sung as a question' },
        ],
      },
      {
        id: 'L4', name: 'Riff', type: 'riff-patterns', visible: true, color: '#ffaa00', snap: 'beat', drum: 'hat',
        nodes: [
          {
            id: 'n1', name: 'Tick', color: '#ffaa00', stepsPerCycle: 16, subbeatsPerBeat: 4, names: ['four on the floor'],
            segments: [
              { start: 0, end: 0.25, kind: 'tick', accent: 120 }, { start: 0.25, end: 0.5, kind: 'empty' },
              { start: 0.5, end: 1, kind: 'tick' }, { start: 1, end: 2, kind: 'empty' },
              { start: 2, end: 2.25, kind: 'tick', accent: 55 }, { start: 2.25, end: 4, kind: 'empty' },
            ],
          },
          {
            id: 'n2', name: 'Bass', color: '#ffaa00', stepsPerCycle: 16, subbeatsPerBeat: 4,
            segments: [
              { start: 0, end: 2, kind: 'empty' },
              { start: 2, end: 2.25, kind: 'tick', label: 'ghost' },
              { start: 2.25, end: 3, kind: 'empty' },
              { start: 3, end: 4, kind: 'tick', label: 'C1', note: 24 },
            ],
          },
        ],
        combos: [{ id: 'c1', name: 'Combo 1', color: '#818cf8', sequence: [{ type: 'n1', lengthSteps: 16 }, { type: '__silence__', lengthSteps: 16 }] }],
        items: [{
          id: 'ri1', start: 0, end: 8, label: 'Instance 1', sequence: [{ type: 'c1', lengthSteps: 32 }],
          repeatCount: 2, importance: 'critical', prominence: [{ t: 0, level: 'counter' }],
          occurrences: [{ index: 1, event: 'fill', added: [{ start: 3.5, end: 3.75, accent: 70 }], missing: [{ start: 0.5 }] }],
        }],
      },
      {
        id: 'L5', name: 'Structure', type: 'boundaries', visible: true, color: '#aaaaaa',
        snap: 'bar', mode: 'multiple-candidates',
        items: [
          { id: 'b1', time: 0, beat: 0, type: 'intro', label: 'Intro', description: 'cold open', candidates: [0, 0.25] },
          { id: 'b2', time: 8, beat: 16, type: 'drop', label: 'Drop', importance: 'critical', color: '#f87171' },
        ],
      },
      {
        id: 'L6', name: 'Drum hits', type: 'cues', visible: true, color: '#eab308', snap: 'off',
        items: [
          { id: 'c1', time: 1, label: 'kick', velocity: 112, levelDb: -3.2, color: '#f87171', note: 36, decay: 0.18 },
          { id: 'c2', time: 1.5, label: 'clap' },
        ],
      },
    ],
  };
}

/** Run the exporter against a synthetic corpus; return { manifest, tracks }. */
function runExport({ info, doc, args = [], detectors = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-export-'));
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'song-info'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'annotations', 'layers', 'tester'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'algorithm-outputs', 'bpm-detections'), { recursive: true });
  fs.copyFileSync(EXPORTER, path.join(root, 'tools', 'export-timing-files.mjs'));
  // The exporter draws beats/bars with the app's own grid code.
  fs.mkdirSync(path.join(root, 'web-app'));
  fs.symlinkSync(path.resolve(path.dirname(EXPORTER), '..', 'web-app', 'src'), path.join(root, 'web-app', 'src'));

  fs.writeFileSync(path.join(root, 'data', 'song-info', 'fx.json'), JSON.stringify(info ?? {
    song: 'fx', bpm: 120, timeSignature: '4/4', gridOffset: 0, gridMode: 'static',
    title: 'Fixture', artist: 'T',
  }));
  fs.writeFileSync(path.join(root, 'data', 'algorithm-outputs', 'bpm-detections', 'fx.json'), JSON.stringify({
    algorithms: [{ source: 'madmom-rnn-beats', ok: true, bpm: 120, beat_times: Array.from({ length: 16 }, (_, i) => i * 0.5) }],
  }));
  fs.writeFileSync(path.join(root, 'data', 'annotations', 'layers', 'tester', 'fx.json'),
    JSON.stringify(doc ?? fixtureDoc()));
  for (const [dir, out] of Object.entries(detectors)) {
    fs.mkdirSync(path.join(root, 'data', 'algorithm-outputs', dir), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'algorithm-outputs', dir, 'fx.json'), JSON.stringify(out));
  }

  execFileSync(process.execPath, [
    path.join(root, 'tools', 'export-timing-files.mjs'), 'fx',
    '--annotator', 'tester', '--out', path.join(root, 'out'), ...args,
  ], { stdio: 'pipe' });

  const dir = path.join(root, 'out', 'fx');
  const read = (name) => fs.readFileSync(path.join(dir, name), 'utf-8');
  const manifestFile = path.join(dir, 'fx_annotations.json');
  return {
    // null when the song was skipped (--units beats on a song with no grid)
    manifest: fs.existsSync(manifestFile) ? JSON.parse(read('fx_annotations.json')) : null,
    read,
    dir,
  };
}

const laneOf = (m, id) => m.lanes.find((l) => l.id === id);
const itemOf = (m, laneId, itemId) => laneOf(m, laneId).items.find((i) => i.id === itemId);

test('a pulse crosses the border as a rate, with the grid it was resolved against', () => {
  const { manifest } = runExport();
  const hats = itemOf(manifest, 'layer:L1', 's1');
  assert.equal(hats.pulse.rate, '16th', 'the enum the annotation stores is what travels');
  assert.equal(hats.pulse.label, '1/4 beat');
  assert.equal(hats.pulse.period_beats, 0.25);
  // 120bpm → a beat is 500ms → a quarter-beat is 125ms, 16 per 4/4 bar.
  assert.equal(hats.pulse.interval_ms, 125);
  assert.equal(hats.pulse.per_bar, 16);
  assert.equal(hats.pulse.derived_from_bpm, 120);

  // 'bar' is the one rate that depends on the meter rather than being a fixed
  // fraction of a beat — 4 beats in 4/4, and it must resolve, not pass through.
  const bars = itemOf(manifest, 'layer:L1', 's3');
  assert.equal(bars.pulse.period_beats, 4);
  assert.equal(bars.pulse.interval_ms, 2000);
});

test('beats and bars are the annotator\'s grid — their downbeat, not the detector\'s first beat', () => {
  const lines = (txt) => txt.trim().split('\n').map((l) => l.split('\t'));
  const { read, manifest } = runExport({
    info: { song: 'fx', bpm: 120, timeSignature: '4/4', gridOffset: 0.3, gridMode: 'static' },
    detectors: { 'bpm-detections': { duration: 5,
      algorithms: [{ source: 'madmom-rnn-beats', ok: true, bpm: 119, beat_times: [0, 0.51, 1.02] }] } },
  });
  const bars = lines(read('fx_bars.txt'));
  assert.deepEqual(bars.map((b) => [b[0], b[2]]), [['0.3', 'bar 1'], ['2.3', 'bar 2'], ['4.3', 'bar 3']]);
  const beats = lines(read('fx_beats.txt'));
  assert.equal(beats[0][0], '0.3', 'beats run from the downbeat, as on screen');
  assert.equal(beats[beats.length - 1][0], '4.8', 'and to the end of the song');
  assert.equal(manifest.grid.beats_source, 'grid');

  // No BPM: no grid, so the detector's beats are what there is.
  const bare = runExport({ info: { song: 'fx', timeSignature: '4/4', gridOffset: 0.3 } });
  assert.equal(lines(bare.read('fx_bars.txt'))[0][0], '0');
  assert.equal(bare.manifest.grid.beats_source, 'detector');
});

test('a derived pulse interval is absent, not invented, when the song has no tempo', () => {
  const { manifest } = runExport({ info: { song: 'fx', timeSignature: '4/4', gridOffset: 0 } });
  const hats = itemOf(manifest, 'layer:L1', 's1');
  assert.equal(hats.pulse.rate, '16th', 'the annotation still stands without a grid');
  assert.equal(hats.pulse.interval_ms, undefined, 'nothing to resolve against, so nothing is claimed');
  assert.equal(manifest.grid.bpm, null);
  // A beat detector DID report 120 for this fixture. That is a guess about the
  // audio, not a grid the annotator stands behind, so it is reported as what it
  // is and never used to resolve a rate into milliseconds.
  assert.equal(manifest.grid.bpm_source, null);
  assert.equal(manifest.grid.detected_bpm, 120);
});

test('the grid is stamped so a consumer can tell the export has gone stale', () => {
  const { manifest } = runExport();
  assert.equal(manifest.schema_version, 2);
  assert.equal(manifest.grid.bpm, 120);
  assert.equal(manifest.grid.beats_per_bar, 4);
  assert.equal(manifest.grid.grid_mode, 'static');
  assert.match(manifest.grid.signature, /bpm=120/);

  const faster = runExport({
    info: { song: 'fx', bpm: 140, timeSignature: '4/4', gridOffset: 0, gridMode: 'static' },
  }).manifest;
  assert.notEqual(faster.grid.signature, manifest.grid.signature,
    'a grid edit has to change the signature, or nothing downstream can notice it');
  assert.notEqual(itemOf(faster, 'layer:L1', 's1').pulse.interval_ms, 125,
    'and the derived milliseconds have to follow the new tempo');
});

test('an energy measurement is lifted out of the description it was hidden in', () => {
  const { manifest } = runExport();
  const energy = itemOf(manifest, 'layer:L1', 's2');
  assert.equal(energy.description, undefined, 'the blob was never prose; it must not be re-emitted as prose');
  assert.equal(energy.energy.stem, 'drums');
  assert.equal(energy.energy.trend, 'increasing');
  assert.equal(energy.energy.envelope.shape, 'sustained');
  assert.equal(energy.energy.envelope.attack_ms, 120);
  assert.equal(energy.energy.brightness_hz.end, 5600);
  assert.deepEqual(energy.energy.curve[0],
    { t_ms: 0, energy: 0.2, brightness: 0.412, beat_strength: 0.3, flux: 0.25 },
    'every reading on a curve point survives, rounded — not the point itself turned to null');
  assert.equal(energy.energy.curve.length, 3);
});

test('a hand-typed description stays a description', () => {
  const { manifest } = runExport();
  assert.equal(itemOf(manifest, 'layer:L1', 's1').description, 'steady through the breakdown');
  assert.equal(itemOf(manifest, 'layer:L1', 's1').energy, undefined);
});

test('prominence travels with both its own clock and the track clock', () => {
  const { manifest } = runExport();
  const hats = itemOf(manifest, 'layer:L1', 's1');
  assert.deepEqual(hats.prominence, [
    { t: 0, at: 4, level: 'lead' },
    { t: 4, at: 8, level: 'backing', ramp: 'ramp' },
  ]);
  assert.equal(hats.prominence_summary, 'lead → backing');
});

test('every authored layer type reaches the manifest', () => {
  const { manifest } = runExport();
  const types = manifest.lanes.map((l) => l.type).sort();
  assert.deepEqual(types, ['boundaries', 'cues', 'lyrics', 'loops', 'riff-patterns', 'sections', 'spans'].sort());
});

test('riff patterns cross the border in the shape the app stores them', () => {
  const { manifest } = runExport();
  const riff = laneOf(manifest, 'layer:L4');
  const inst = riff.items[0];
  assert.equal(inst.repeatCount, 2);
  assert.deepEqual(inst.sequence, [{ type: 'c1', lengthSteps: 32, name: 'Combo 1' }],
    'an entry resolves to a name; a bare uuid is unreadable downstream');
  // The play that differed from its node: the same node, played differently.
  assert.deepEqual(inst.occurrences, [
    { index: 1, event: 'fill', added: [{ start: 3.5, end: 3.75, accent: 70 }], missing: [{ start: 0.5 }] },
  ]);

  const tick = riff.nodes.find((n) => n.id === 'n1');
  assert.deepEqual(Object.keys(tick).sort(), ['color', 'id', 'name', 'names', 'segments', 'stepsPerCycle', 'subbeatsPerBeat']);
  assert.deepEqual(tick.names, ['four on the floor']);
  // How hard each measured note is struck; a note nobody measured carries no
  // accent and is played at full strength.
  assert.deepEqual(tick.segments.filter((sg) => sg.kind === 'tick').map((sg) => sg.accent), [120, undefined, 55]);

  const bass = riff.nodes.find((n) => n.id === 'n2');
  assert.equal(bass.segments[1].label, 'ghost');
  // A pitched note carries its MIDI number; an unpitched one carries none.
  assert.equal(bass.segments[3].note, 24);
  assert.equal('note' in bass.segments[1], false);
  assert.equal('names' in bass, false);

  assert.equal(riff.combos[0].sequence[1].name, 'silence');
  assert.equal(riff.combos[0].color, '#818cf8');
  assert.equal(riff.drum, 'hat');
  assert.ok(!('drum' in laneOf(manifest, 'layer:L1')));
});

test('lyrics export as words and lines, with their vocal runs', () => {
  const { manifest, read } = runExport();
  const lyrics = laneOf(manifest, 'layer:L3');
  assert.equal(lyrics.items[0].kind, 'word');
  assert.equal(lyrics.items[0].start, lyrics.items[0].end, 'a word is a point');
  assert.equal(lyrics.items[1].kind, 'line');
  assert.equal(lyrics.items[1].end, 6, 'a line has a duration');
  assert.equal(lyrics.items[1].description, 'sung as a question');
  assert.ok(!('description' in lyrics.items[0]), 'no description, no key');
  assert.equal(lyrics.vocal_runs[0].prominence_summary, 'lead');
  assert.equal(read('fx_lyrics.txt').trim(), '2\t2\thello\n3\t6\thello world\n7\t7.6\ta-la');
});

test('a lyric word keeps where each sound inside it begins', () => {
  const { manifest } = runExport();
  const w = itemOf(manifest, 'layer:L3', 'w3');
  // The onset before the word (it was trimmed by hand) stays behind; an
  // untexted one is still an onset.
  // Each carries its beat on the grid (120 BPM: two beats a second).
  assert.deepEqual(w.onsets, [
    { time: 7, beat: 14, text: 'a' }, { time: 7.25, beat: 14.5 }, { time: 7.4, beat: 14.8, text: 'la' },
  ]);
  assert.equal(itemOf(manifest, 'layer:L3', 'w1').onsets, undefined);
});

test('a lyric word keeps its whole envelope, past its own span', () => {
  const { manifest } = runExport();
  assert.deepEqual(itemOf(manifest, 'layer:L3', 'w3').envelope, {
    start: 6.95, peak: 7.05, decay_end: 7.2, release: 7.5, end: 8.1, peak_db: -14.2, sustain_db: -9,
  });
  assert.equal(itemOf(manifest, 'layer:L3', 'w1').envelope, undefined);
});

test('a span carries its extracted envelope in the shape a lyric does', () => {
  const { manifest } = runExport();
  assert.deepEqual(itemOf(manifest, 'layer:L1', 's4').envelope, {
    start: 3.02, peak: 3.1, decay_end: 3.3, release: 3.8, end: 4, peak_db: -11.5, source: 'drums', peaks: 3,
  });
  assert.equal(itemOf(manifest, 'layer:L1', 's3').envelope, undefined);
});

test('boundaries keep what a boundary can carry', () => {
  const { manifest } = runExport();
  const b1 = itemOf(manifest, 'layer:L5', 'b1');
  assert.equal(b1.section_type, 'intro');
  assert.equal(b1.description, 'cold open');
  assert.deepEqual(b1.candidates, [0, 0.25]);
  assert.equal(itemOf(manifest, 'layer:L5', 'b2').importance, 'critical');
  assert.equal(laneOf(manifest, 'layer:L5').eval_mode, 'multiple-candidates');
});

test('a struck cue carries how hard, how loud, and the hue it was drawn in', () => {
  const { manifest } = runExport();
  const hit = itemOf(manifest, 'layer:L6', 'c1');
  assert.equal(hit.velocity, 112);
  assert.equal(hit.level_db, -3.2);
  assert.equal(hit.color, '#f87171');
  assert.equal(hit.note, 36);
  assert.equal(hit.decay, 0.18);
  const plain = itemOf(manifest, 'layer:L6', 'c2');
  for (const key of ['velocity', 'level_db', 'color', 'note', 'decay']) assert.ok(!(key in plain), key);
});

test('a span, loop or boundary carries its own colour, and only when it has one', () => {
  const { manifest } = runExport();
  assert.equal(itemOf(manifest, 'layer:L1', 's4').color, '#38bdf8');
  assert.equal(itemOf(manifest, 'layer:L2', 'lp1').color, '#a3e635');
  assert.equal(itemOf(manifest, 'layer:L5', 'b2').color, '#f87171');
  assert.ok(!('color' in itemOf(manifest, 'layer:L1', 's3')));
  assert.ok(!('color' in itemOf(manifest, 'layer:L5', 'b1')));
});

test("a layer's big picture crosses the border with the lane, and only when it has one", () => {
  const { manifest } = runExport();
  assert.equal(laneOf(manifest, 'layer:L1').summary, '1 main loop over 4 bars, most played first. A — 4 bars (1–4).');
  assert.ok(!('summary' in laneOf(manifest, 'layer:L2')));
});

test('the legacy sections lane still reads the way it always did', () => {
  const { manifest, read } = runExport();
  const sections = laneOf(manifest, 'sections');
  assert.equal(sections.type, 'sections');
  assert.equal(sections.items[0].kind, 'intro', 'the old key stays; something out there reads it');
  assert.equal(sections.items[0].label, 'Intro');
  assert.equal(read('fx_sections_labels.txt').trim().split('\n')[0], '0\t0\tIntro');
});

test('label tracks stay three columns — that contract must not grow', () => {
  const { read } = runExport();
  for (const name of ['fx_key_points.txt', 'fx_pattern.txt', 'fx_lyrics.txt', 'fx_beats.txt']) {
    for (const line of read(name).trim().split('\n').filter(Boolean)) {
      assert.equal(line.split('\t').length, 3, `${name}: ${line}`);
    }
  }
});

test('pattern.txt carries riff instances (it used to read a retired layer type and was always empty)', () => {
  const { read } = runExport();
  assert.equal(read('fx_pattern.txt').trim(), '0\t8\tInstance 1 ×2');
});

test('an absent annotation is absent, not a null claiming something', () => {
  const { manifest } = runExport();
  const plain = itemOf(manifest, 'layer:L1', 's3');
  assert.ok(!('prominence' in plain), 'no prominence annotated → no key at all');
  assert.ok(!('importance' in plain));
  assert.ok(!('description' in plain));
});

test('re-exporting the same song is deterministic apart from the timestamp', () => {
  const a = runExport().manifest;
  const b = runExport().manifest;
  delete a.generated_at;
  delete b.generated_at;
  assert.deepEqual(a, b);
});

test("a detector's caveats about its own run cross the border with the lane", () => {
  // Out here they matter more than in the app, not less: a curator can hover
  // the lane's ⓘ, while a light show or a training set reads the manifest and
  // nothing else. A groove built on hits that could not be named exports
  // identically to one built on clean hits, so dropping these would turn "we
  // could not tell" into silence — which reads as "fine".
  const { manifest } = runExport();
  const lane = manifest.lanes.find((l) => l.id === 'layer:L2');
  assert.deepEqual(lane.detector_notes, [
    { code: 'empty-band:hat', message: 'holds 0.1% of this stem energy' },
  ]);
  // The provenance it belongs to travels too, or a caveat names nothing.
  assert.equal(lane.detector, 'kit_groove_detector');
  assert.equal(lane.detector_description, 'Repeating drum grooves.');
});

test('a lane whose detector had nothing to flag exports no notes key', () => {
  // Not an empty array: a consumer testing truthiness would light a warning
  // on every clean lane in the manifest.
  const { manifest } = runExport();
  const clean = manifest.lanes.find((l) => l.id === 'layer:L1');
  assert.equal('detector_notes' in clean, false);
});

/** The fixture (120 BPM, 4/4: a bar is 2 s) plus two detector-copied cue
 *  lanes in one group and a hand-made lane just as dense. */
function withHitStreams() {
  const doc = fixtureDoc();
  const ticks = (n, every, label) => Array.from({ length: n }, (_, k) => ({ id: `${label}${k}`, time: k * every, label }));
  doc.groups = [...doc.groups, { id: 'g2', name: 'Bass line', color: '#22d3ee' }];
  doc.layers.push(
    { // a detected bass line, bars 1–2 then 6: C1 three times, G1 once
      id: 'N1', name: 'Bass notes', type: 'cues', visible: true, color: '#22d3ee', snap: 'off',
      source: 'user', importedFrom: 'Bass notes', groupId: 'g2',
      items: [0, 1, 2, 10].map((t, k) => ({ id: `n${k}`, time: t, label: k === 3 ? 'G1' : 'C1', note: k === 3 ? 31 : 24, velocity: 90 })),
    },
    { // a detected drum split: kicks and snares over bars 1–4
      id: 'O1', name: 'Drum hits', type: 'cues', visible: true, color: '#888888', snap: 'off',
      source: 'user', importedFrom: 'drum_kit_split',
      items: ticks(16, 0.5, 'kick').map((it, k) => (k % 2 ? { ...it, label: 'snare' } : it)),
    },
    { // the user's own lane, just as dense: theirs, so it travels as rows
      id: 'H1', name: 'My hats', type: 'cues', visible: true, color: '#eeeeee', snap: 'off',
      items: ticks(16, 0.125, 'hat'),
    },
  );
  return doc;
}

test('a detected cue lane exports as what it adds up to, never as its rows', () => {
  const { manifest, read } = runExport({ doc: withHitStreams() });
  assert.equal(laneOf(manifest, 'layer:N1'), undefined);
  assert.equal(laneOf(manifest, 'layer:O1'), undefined);
  assert.doesNotMatch(read('fx_key_points.txt'), /snare|C1/);
  const [bass, drums] = manifest.summarized_lanes;
  assert.deepEqual(bass, {
    name: 'Bass notes', type: 'cues', count: 4, group: 'Bass line', detector: 'Bass notes',
    summary: '4 notes · 0.67/bar · C1–G1, mostly C1 75%, G1 25% · bars 1–2, 6',
  });
  assert.equal(drums.summary, '16 hits · 4/bar · kick 8 · snare 8 · bars 1–4');
  assert.match(read('fx_info.txt'), /Bass line \/ Bass notes: 4 notes/);
});

test('a cue lane the user made still exports as rows, however dense', () => {
  const { manifest } = runExport({ doc: withHitStreams() });
  assert.equal(laneOf(manifest, 'layer:H1').count, 16);
  assert.ok(laneOf(manifest, 'layer:L6'));
});

test('--with-notes exports the detected rows instead of the summary', () => {
  const { manifest } = runExport({ doc: withHitStreams(), args: ['--with-notes'] });
  assert.equal(itemOf(manifest, 'layer:N1', 'n0').note, 24);
  assert.equal(laneOf(manifest, 'layer:O1').count, 16);
  assert.equal('summarized_lanes' in manifest, false);
});

test('--detectors summarises each detector per group: its riffs, its hits, its warnings', () => {
  const { read } = runExport({
    args: ['--detectors'],
    detectors: {
      'custom/pitched_layers': {
        name: 'pitched_layers', output_kind: 'lanes', items: [], fatal: null,
        notes: [{ code: 'mostly-unpitched', message: 'Half the attacks had no pitch. More detail here.' }],
        lanes: [
          { id: 'bass_notes', label: 'Bass notes', output_kind: 'cue', group: 'Bass line',
            items: [0, 500, 1000, 1500].map((t) => ({ time_ms: t, label: 'C1', note: 24 })) },
          { id: 'bass_pattern', label: 'Bass pattern', output_kind: 'riff', group: 'Bass line',
            nodes: [{ id: 'a', name: 'A', stepsPerCycle: 16, subbeatsPerBeat: 4, segments: [
              { start: 0, end: 2, kind: 'tick', note: 24 }, { start: 2, end: 4, kind: 'tick', note: 31 }] }],
            items: [
              { start: 0, end: 2, label: 'A', repeatCount: 2, sequence: [{ type: 'a', lengthSteps: 16 }] },
              { start: 20, end: 22, label: 'A', repeatCount: 3, sequence: [{ type: 'a', lengthSteps: 16 }] },
            ] },
        ],
      },
      'custom/booms': { name: 'booms', output_kind: 'cue', items: [] },
      'custom/melody': { name: 'melody', output_kind: 'cue', items: [{ time_ms: 0, note: 60 }, { time_ms: 900, note: 62 }] },
    },
  });
  const txt = read('fx_detectors.txt');
  assert.match(txt, /## pitched_layers — lanes\n  ! mostly-unpitched: Half the attacks had no pitch\.\n/);
  // The group has a pattern, so its notes lane is left out: the group is its loops.
  assert.doesNotMatch(txt, /Bass notes/);
  // A detector that is only hits has nothing else to say, so it gets its one line.
  assert.match(txt, /## melody — cue\n  melody: 2 notes · /);
  // One node played in two places is one figure: plays summed, both places.
  assert.match(txt, /\n    A · 2 notes\/bar ×5 · 16 steps: 0:C1 8:G1 · bars 1–2, 11–13\n/);
  assert.match(txt, /## booms — cue\n  \(found nothing\)/);
  assert.doesNotMatch(txt, /time_ms|1\.5\b/, 'never the hits themselves');
});

test('no detectors file unless asked for', () => {
  const { dir } = runExport();
  assert.equal(fs.existsSync(path.join(dir, 'fx_detectors.txt')), false);
});

test("a copied group with a pattern exports the pattern, and not its notes lane even as a summary", () => {
  const doc = withHitStreams();
  doc.layers.push({
    id: 'R1', name: 'Bass line pattern', type: 'riff-patterns', visible: true, color: '#22d3ee', snap: 'beat',
    source: 'user', importedFrom: 'Bass line pattern', groupId: 'g2', nodes: [], combos: [],
    items: [{ id: 'r1', startBeat: 0, endBeat: 8, repeatCount: 2, sequence: [] }],
  });
  const { manifest } = runExport({ doc });
  assert.ok(laneOf(manifest, 'layer:R1'));
  assert.deepEqual(manifest.summarized_lanes.map((l) => l.name), ['Drum hits'],
    'the Bass line notes are gone; the drum hits have no pattern in their group, so they keep their line');
});

// ── Beats ────────────────────────────────────────────────────────────────────

/** The fixture as the app saves it under Grid Lock: every stamped item by its
 *  beat alone, the grid it was counted on beside it (120 BPM, offset 0). */
function beatsOnlyDoc() {
  const d = fixtureDoc();
  d.timebase = 'beats';
  d.grid = { bpm: 120, gridOffset: 0, timeSignature: '4/4', beatsPerBar: 4, gridMode: 'static',
    tempoMap: [{ beat: 0, time: 0, bpm: 120 }] };
  for (const layer of d.layers) {
    if (layer.type === 'lyrics') continue;
    for (const it of layer.items) {
      if (typeof it.time === 'number') {
        it.beat = it.time * 2;
        if (it.candidates) it.candidates = it.candidates.map((c) => c * 2);
        delete it.time;
      } else {
        it.startBeat = it.start * 2; it.endBeat = it.end * 2;
        if (it.candidates) it.candidates = it.candidates.map(([a, b]) => [a * 2, b * 2]);
        delete it.start; delete it.end;
      }
    }
  }
  return d;
}

test('a Grid Lock file that stores beats alone exports the seconds it always did', () => {
  const fromSeconds = runExport().manifest;
  const fromBeats = runExport({ doc: beatsOnlyDoc() }).manifest;
  for (const lane of fromSeconds.lanes) {
    assert.deepEqual(laneOf(fromBeats, lane.id).items, lane.items, lane.id);
  }
});

test('a Grid Lock file is placed on the grid the song has now', () => {
  // Re-fitted to 60 BPM since the save: beat 16 (the drop) is now at 16 s.
  const info = { song: 'fx', bpm: 60, timeSignature: '4/4', gridOffset: 0, gridMode: 'static' };
  const { manifest } = runExport({ info, doc: beatsOnlyDoc() });
  assert.equal(itemOf(manifest, 'layer:L5', 'b2').start, 16);
  assert.equal(itemOf(manifest, 'layer:L5', 'b2').beat, 16);
});

test('the grid is exported whole: bpm, offset, meter and a tempo map to place a beat', () => {
  const info = { song: 'fx', bpm: 128, timeSignature: '3/4', gridOffset: 0.137, gridMode: 'static' };
  const { grid } = runExport({ info }).manifest;
  assert.equal(grid.bpm, 128);
  assert.equal(grid.grid_offset, 0.137);
  assert.equal(grid.time_signature, '3/4');
  assert.equal(grid.beats_per_bar, 3);
  assert.deepEqual(grid.tempo_map, [{ beat: 0, time: 0.137, bpm: 128 }]);
});

test('a mark on a 1/8 of a beat exports as that fraction, not a float near it', () => {
  // 128 BPM: 1/8 beat is 58.59375 ms, so the stored millisecond is never exact.
  const info = { song: 'fx', bpm: 128, timeSignature: '4/4', gridOffset: 0, gridMode: 'static' };
  const d = fixtureDoc();
  d.layers.find((l) => l.id === 'L6').items = [{ id: 'c1', time: Number((12.375 * 60 / 128).toFixed(3)), label: '32nd' }];
  const { manifest } = runExport({ info, doc: d });
  assert.equal(itemOf(manifest, 'layer:L6', 'c1').beat, 12.375);
});

test('--units beats: every position is a beat, and no seconds are left in the items', () => {
  const { manifest, read } = runExport({ args: ['--units', 'beats'] });
  assert.equal(manifest.units, 'beats');
  assert.deepEqual(manifest.grid.tempo_map, [{ beat: 0, time: 0, bpm: 120 }]);
  const kick = itemOf(manifest, 'layer:L6', 'c1');
  assert.equal(kick.beat, 2);
  assert.equal(kick.start, undefined);
  assert.equal(kick.end, undefined);
  assert.equal(kick.decay, undefined);
  assert.equal(kick.decay_beats, 0.36);
  const hats = itemOf(manifest, 'layer:L1', 's1');
  assert.equal(hats.start, undefined);
  assert.equal(hats.end, undefined);
  assert.equal(hats.start_beat, 8);
  assert.equal(hats.end_beat, 24);
  assert.deepEqual(hats.candidate_beats, [[8, 23]]);
  assert.equal(hats.candidates, undefined);
  assert.equal(hats.pulse.interval_ms, undefined);
  assert.equal(hats.pulse.period_beats, 0.25);
  assert.deepEqual(hats.prominence.map((p) => p.at_beat), [8, 16]);
  assert.deepEqual(itemOf(manifest, 'layer:L1', 's4').envelope.peak_beat, 6.2);
  const energy = itemOf(manifest, 'layer:L1', 's2').energy;
  assert.deepEqual(energy.curve.map((p) => p.at_beat), [16, 20, 24]);
  assert.equal(energy.duration_beats, 8);
  assert.equal(energy.envelope.attack_beats, 0.24);
  assert.deepEqual(itemOf(manifest, 'layer:L5', 'b1').candidate_beats, [0, 0.5]);
  const word = itemOf(manifest, 'layer:L3', 'w3');
  assert.equal(word.beat, 14);
  assert.equal(word.end_beat, 15.2);
  assert.deepEqual(word.onsets, [{ beat: 14, text: 'a' }, { beat: 14.5 }, { beat: 14.8, text: 'la' }]);
  assert.deepEqual(laneOf(manifest, 'layer:L3').vocal_runs[0].start_beat, 4);
  assert.equal(laneOf(manifest, 'layer:L3').vocal_runs[0].start, undefined);
  // No seconds key survives anywhere an item is.
  const secondsKeys = new Set(['time', 'start', 'end', 'peak', 'decay_end', 'release', 'decay', 'interval_ms', 'candidates', 't', 'at']);
  const walk = (v, where) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${where}[${i}]`));
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      // A riff note's start/end are beats from its node's start, already.
      if ((secondsKeys.has(k) || k.endsWith('_ms')) && !/\.(segments|added|missing)\[|\.brightness_hz$/.test(where)) {
        assert.fail(`${where}.${k} is still in seconds`);
      }
      walk(x, `${where}.${k}`);
    }
  };
  walk(manifest.lanes, 'lanes');
  // The label tracks and sections file say beats too.
  assert.match(read('fx_key_points.txt'), /^2\t2\tkick$/m);
  assert.match(read('fx_sections_labels.txt'), /^16\t16\tDrop$/m);
  assert.deepEqual(JSON.parse(read('fx_sections.json')).sections.map((x) => x.beat), [0, 16]);
  assert.match(read('fx_beats.txt'), /^1\t1\tb1$/m);
  assert.match(read('fx_info.txt'), /units: beats/);
});

test('--units beats on a song with no grid writes nothing rather than guess', () => {
  const info = { song: 'fx', timeSignature: '4/4', gridMode: 'static' };
  const { manifest } = runExport({ info, args: ['--units', 'beats'] });
  assert.equal(manifest, null);
});
