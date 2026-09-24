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
  curve: [0.2000001, 0.5, 0.9],
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
        snap: 'beat', groupId: 'g1',
        items: [
          {
            id: 's1', start: 4, end: 12, startBeat: 8, endBeat: 24, label: 'Hi-hats',
            description: 'steady through the breakdown', pulse: '16th', importance: 'optional',
            prominence: [{ t: 0, level: 'lead' }, { t: 4, level: 'backing', ramp: 'ramp' }],
            candidates: [[4, 11.5]],
          },
          { id: 's2', start: 8, end: 12, label: 'Energy: rising (drums)', description: JSON.stringify(ENERGY_BLOB) },
          { id: 's3', start: 1, end: 2, label: 'bar hits', pulse: 'bar' },
        ],
      },
      {
        // Doubles as the detector-provenance fixture: read-only, with a source,
        // a description and a caveat the detector raised about its own run.
        id: 'L2', name: 'Loop A', type: 'loops', visible: true, color: '#0000ff', snap: 'bar',
        readOnly: true, source: 'detector:kit_groove_detector', sourceStem: 'drums',
        sourceDescription: 'Repeating drum grooves.',
        sourceNotes: [{ code: 'empty-band:hat', message: 'holds 0.1% of this stem energy' }],
        items: [{ id: 'lp1', start: 0, end: 8, label: '8s loop', bars: 4, snapZeroCross: true }],
      },
      {
        id: 'L3', name: 'Vocals', type: 'lyrics', visible: true, color: '#ff00ff', snap: 'off',
        vocalRuns: [{ id: 'r1', start: 2, end: 6, prominence: [{ t: 0, level: 'lead' }] }],
        items: [
          { id: 'w1', time: 2, text: 'hello', kind: 'word' },
          { id: 'w2', time: 3, end: 6, text: 'hello world', kind: 'line' },
        ],
      },
      {
        id: 'L4', name: 'Riff', type: 'riff-patterns', visible: true, color: '#ffaa00', snap: 'beat',
        nodes: [
          { id: 'n1', name: 'Tick', color: '#ffaa00', highlightedBeats: [0, 4, 8, 12], spans: [[2, 2]], stepsPerCycle: 16, subbeatsPerBeat: 4, accents: { 0: 120, 8: 55 } },
          {
            id: 'n2', name: 'Blocks', color: '#ffaa00', highlightedBeats: [], spans: [],
            stepsPerCycle: 16, subbeatsPerBeat: 4, kind: 'boundary',
            segments: [
              { start: 0, end: 2, kind: 'empty' },
              { start: 2, end: 2.37, kind: 'tick', label: 'ghost' },
              { start: 2.37, end: 4, kind: 'empty' },
            ],
          },
        ],
        combos: [{ id: 'c1', name: 'Combo 1', color: '#818cf8', sequence: [{ type: 'n1', lengthSteps: 16 }, { type: '__silence__', lengthSteps: 16 }] }],
        items: [{
          id: 'ri1', start: 0, end: 8, label: 'Instance 1', sequence: [{ type: 'c1', lengthSteps: 32 }],
          repeatCount: 2, importance: 'critical', prominence: [{ t: 0, level: 'counter' }],
        }],
      },
      {
        id: 'L5', name: 'Structure', type: 'boundaries', visible: true, color: '#aaaaaa',
        snap: 'bar', mode: 'multiple-candidates',
        items: [
          { id: 'b1', time: 0, beat: 0, type: 'intro', label: 'Intro', description: 'cold open', candidates: [0, 0.25] },
          { id: 'b2', time: 8, beat: 16, type: 'drop', label: 'Drop', importance: 'critical' },
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
function runExport({ info, doc } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-export-'));
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'song-info'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'annotations', 'layers', 'tester'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'algorithm-outputs', 'bpm-detections'), { recursive: true });
  fs.copyFileSync(EXPORTER, path.join(root, 'tools', 'export-timing-files.mjs'));

  fs.writeFileSync(path.join(root, 'data', 'song-info', 'fx.json'), JSON.stringify(info ?? {
    song: 'fx', bpm: 120, timeSignature: '4/4', gridOffset: 0, gridMode: 'static',
    title: 'Fixture', artist: 'T',
  }));
  fs.writeFileSync(path.join(root, 'data', 'algorithm-outputs', 'bpm-detections', 'fx.json'), JSON.stringify({
    algorithms: [{ source: 'madmom-rnn-beats', ok: true, bpm: 120, beat_times: Array.from({ length: 16 }, (_, i) => i * 0.5) }],
  }));
  fs.writeFileSync(path.join(root, 'data', 'annotations', 'layers', 'tester', 'fx.json'),
    JSON.stringify(doc ?? fixtureDoc()));

  execFileSync(process.execPath, [
    path.join(root, 'tools', 'export-timing-files.mjs'), 'fx',
    '--annotator', 'tester', '--out', path.join(root, 'out'),
  ], { stdio: 'pipe' });

  const dir = path.join(root, 'out', 'fx');
  const read = (name) => fs.readFileSync(path.join(dir, name), 'utf-8');
  return {
    manifest: JSON.parse(read('fx_annotations.json')),
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
  assert.deepEqual(energy.energy.curve, [0.2, 0.5, 0.9], 'the curve survives, rounded');
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

test('riff patterns carry the motifs their sequences reference', () => {
  const { manifest } = runExport();
  const riff = laneOf(manifest, 'layer:L4');
  const inst = riff.items[0];
  assert.equal(inst.repeats, 2);
  assert.deepEqual(inst.sequence, [{ ref: 'c1', length_steps: 32, name: 'Combo 1' }],
    'an entry resolves to a name; a bare uuid is unreadable downstream');

  const grid = riff.nodes.find((n) => n.id === 'n1');
  assert.deepEqual(grid.ticks, [0, 4, 8, 12]);
  assert.deepEqual(grid.holds, [[2, 2]]);
  assert.equal(grid.kind, 'grid');
  // How hard each measured step is struck. Sparse on purpose: steps 4 and 12
  // carry no entry and are played at full strength.
  assert.deepEqual(grid.accents, { 0: 120, 8: 55 });

  // A node nobody measured exports no accents key at all, rather than an
  // empty object a reader would have to special-case.
  const boundaryNode = riff.nodes.find((n) => n.id === 'n2');
  assert.equal('accents' in boundaryNode, false);

  // A boundary node quantises nothing — 2.37 beats must arrive as 2.37.
  const boundary = riff.nodes.find((n) => n.id === 'n2');
  assert.equal(boundary.kind, 'boundary');
  assert.equal(boundary.segments[1].start, 2);
  assert.equal(boundary.segments[1].end, 2.37);
  assert.equal(boundary.segments[1].label, 'ghost');

  assert.equal(riff.combos[0].sequence[1].name, 'silence');
});

test('lyrics export as words and lines, with their vocal runs', () => {
  const { manifest, read } = runExport();
  const lyrics = laneOf(manifest, 'layer:L3');
  assert.equal(lyrics.items[0].kind, 'word');
  assert.equal(lyrics.items[0].start, lyrics.items[0].end, 'a word is a point');
  assert.equal(lyrics.items[1].kind, 'line');
  assert.equal(lyrics.items[1].end, 6, 'a line has a duration');
  assert.equal(lyrics.vocal_runs[0].prominence_summary, 'lead');
  assert.equal(read('fx_lyrics.txt').trim(), '2\t2\thello\n3\t6\thello world');
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
