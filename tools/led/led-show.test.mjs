// node --test tools/led/led-show.test.mjs
// The LED show builder, the WLED player (against a fake WLED on localhost),
// and the C header the FastLED sketch includes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECTION_COLORS, buildShow, readLanes, stateAt, toHeader } from './led-show.mjs';
import { buildCommands, speedFor } from './wled-play.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.join(HERE, 'example');
const exampleShow = () => buildShow(readLanes([EXAMPLE]));

test('section colors match the app', () => {
  const src = fs.readFileSync(path.join(HERE, '../../web-app/src/components/inspector-v2/sectionConstants.ts'), 'utf8');
  const block = src.match(/SECTION_COLORS[^=]*=\s*\{([\s\S]*?)\n\};/)[1];
  const app = Object.fromEntries([...block.matchAll(/^\s*(\w+):\s*'(#[0-9a-fA-F]{6})'/gm)].map((m) => [m[1], m[2]]));
  assert.deepEqual(SECTION_COLORS, app);
});

test('the example layers make a 30 s show', () => {
  const show = exampleShow();
  const kinds = show.events.map((e) => e.kind);
  assert.equal(kinds.filter((k) => k === 'section').length, 3, 'the end cap is not a section');
  assert.equal(kinds.filter((k) => k === 'span').length, 1);
  assert.equal(kinds.filter((k) => k === 'cue').length, 4);
  assert.equal(show.durationMs, 30000);
  const span = show.events.find((e) => e.kind === 'span');
  assert.equal(span.stepMs, 250, '8th pulse at 120 BPM (24 beats over 12 s)');
  const buildup = show.events.find((e) => e.label === 'Buildup');
  assert.equal(buildup.color, SECTION_COLORS.buildup, 'a section without its own color takes its type color');
  assert.deepEqual(show.events.find((e) => e.startMs === 20000 && e.kind === 'cue').rgb, [255, 255, 255], 'an item color beats its lane color');
});

test('stateAt: section under a span, then a fading cue', () => {
  const show = exampleShow();
  let s = stateAt(show, 10000);
  assert.equal(s.section.label, 'Buildup');
  assert.equal(s.span.label, 'Strip: chase, speeding up');
  assert.equal(s.cue, null);
  s = stateAt(show, 20200);
  assert.equal(s.section.label, 'Drop');
  assert.ok(s.flash > 0.4 && s.flash < 0.6);
  assert.equal(stateAt(show, 20500).cue, null);
});

test('reads the export-timing-files manifest too', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'led-show-'));
  fs.writeFileSync(path.join(dir, 'x_annotations.json'), JSON.stringify({
    song: 'x', grid: { bpm: 100, beats_per_bar: 4 },
    lanes: [
      { name: 'Phrases', type: 'boundaries', color: '#f472b6', items: [
        { start: 0, end: 0, label: 'Intro', section_type: 'intro' },
        { start: 4.8, end: 4.8, label: 'Drop', section_type: 'drop' },
        { start: 9.6, end: 9.6, label: '—', section_type: 'unset' }] },
      { name: 'Mine', type: 'spans', color: '#818cf8', items: [
        { start: 0, end: 4.8, label: 'chase', start_beat: 0, end_beat: 8, pulse: { rate: '16th', interval_ms: 150 } }] },
      { name: 'Onsets', type: 'cues', color: '#22d3ee', detector: 'drums', items: [{ start: 1, end: 1, label: 'x' }] },
    ],
  }));
  const read = readLanes([dir]);
  const show = buildShow(read);
  assert.deepEqual(show.lanes, ['Phrases (boundaries)', 'Mine (spans)'], 'detector lanes stay out by default');
  assert.equal(show.events.find((e) => e.kind === 'span').stepMs, 150, 'the manifest pulse wins');
  assert.equal(show.events.filter((e) => e.kind === 'section').at(-1).endMs, 9600);
  const picked = buildShow(read, { lanes: ['Onsets'] });
  assert.deepEqual(picked.lanes, ['Onsets (cues)']);
  assert.throws(() => buildShow(read, { lanes: ['Nope'] }), /no usable lane named: nope/);
});

test('the C header has one row per event, in flash', () => {
  const h = toHeader(exampleShow());
  assert.match(h, /TC_EVENT_COUNT = 8;/);
  assert.match(h, /TC_SONG_MS = 30000UL;/);
  assert.match(h, /\{ 8000UL, 20000UL, 250, 1, 129, 140, 248 \}/);
  assert.equal((h.match(/^ {2}\{ /gm) ?? []).length, 8);
  assert.doesNotMatch(toHeader({ ...exampleShow(), events: [{ ...exampleShow().events[0], label: 'a */ b' }] }), /a \*\/ b/);
});

test('the shipped sketch header is the example show', () => {
  const shipped = fs.readFileSync(path.join(HERE, 'fastled/TimeCuesShow/timecues_show.h'), 'utf8');
  assert.equal(shipped, toHeader(exampleShow()), 'regenerate: node tools/led/led-show.mjs tools/led/example --header tools/led/fastled/TimeCuesShow/timecues_show.h');
});

test('WLED commands: chase in the span, flash and fade back on a cue', () => {
  const cmds = buildCommands(exampleShow(), { theaterFx: 13, flashMs: 400 });
  const at = (ms) => cmds.filter((c) => c.atMs === ms);
  assert.equal(at(8000)[0].body.seg[0].fx, 13);
  assert.equal(at(8000)[0].body.seg[0].sx, speedFor(250));
  const drop = at(20000);
  assert.equal(drop.length, 2);
  assert.deepEqual(drop.at(-1).body.seg[0].col[0], [255, 255, 255], 'the flash is sent after the section change');
  assert.equal(at(20100)[0].body.transition, 3);
  assert.ok(speedFor(60) > speedFor(250));
  const mapped = buildCommands(exampleShow(), { theaterFx: 13, map: { 'white flash': { ps: 4 } } });
  assert.equal(mapped.find((c) => c.atMs === 20000 && c.why.startsWith('cue')).body.ps, 4);
});

test('WLED player drives a device in time and restores it', async () => {
  const posts = [];
  const original = { on: false, bri: 40, seg: [{ id: 0, fx: 9, col: [[1, 2, 3]] }] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/json/info') return res.end(JSON.stringify({ ver: '0.15.0', name: 'fake', leds: { count: 30 } }));
      if (req.url === '/json/effects') return res.end(JSON.stringify(['Solid', 'Blink', 'Theater', 'Chase']));
      if (req.url === '/json/state' && req.method === 'GET') return res.end(JSON.stringify(original));
      posts.push({ at: performance.now(), body: JSON.parse(body) });
      res.end('{"success":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${server.address().port}`;
  try {
    const child = spawn(process.execPath, [path.join(HERE, 'wled-play.mjs'), EXAMPLE, '--host', host, '--start', '27.5'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (/Press Enter/.test(out) && !child.pressed) { child.pressed = performance.now(); child.stdin.write('\n'); } });
    child.stderr.on('data', (d) => { out += d; });
    const guard = setTimeout(() => child.kill(), 15000);
    const code = await new Promise((r) => child.on('close', r));
    clearTimeout(guard);
    assert.equal(code, 0, out);
    const go = child.pressed;
    const cue = posts.find((p) => p.body.seg?.[0]?.col?.[0]?.join() === '232,121,249');
    assert.ok(cue, 'the 28 s cue was sent');
    const late = cue.at - go - 500;                 // 28.0 s cue, started at 27.5 s
    assert.ok(Math.abs(late) < 120, `cue off by ${late.toFixed(0)} ms`);
    assert.equal(posts[0].body.on, true);
    assert.equal(posts[1].body.seg[0].fx, 0, 'the Drop section is set before the clock starts');
    assert.deepEqual(posts.at(-1).body.seg, original.seg, 'the earlier state is put back');
  } finally {
    server.close();
  }
});
