#!/usr/bin/env node
/**
 * Turn TimeCues annotations into an LED show: a list of sections, spans and
 * cues with times, colors and chase speeds, which an LED controller plays in
 * time with the song.
 *
 * Audio-reactive LED setups (WLED's sound-reactive mode, LedFx, an FFT in a
 * FastLED sketch) react to loudness after it happens. They cannot know a drop
 * is coming, ramp through a 16-bar buildup, or treat one roar differently
 * from the beat around it. An annotation knows all of that ahead of time.
 *
 * Input, either of:
 *   - the manifest from tools/export-timing-files.mjs (<slug>_annotations.json)
 *   - layer files from the app's Export dialog, format "TimeCues JSON"
 *     (one JSON per layer; pass the files or the unzipped folder)
 *
 * Show model (the same for every output):
 *   section  the whole strip sits in the section's color, dimmed
 *   span     a chase in the span's color over the section, one step per
 *            pulse tick (the span's Pulse; a beat when none is set)
 *   cue      a full-strip flash in the cue's color that fades out
 *
 * Usage:
 *   node tools/led/led-show.mjs <input...> --list
 *   node tools/led/led-show.mjs <input...> --header <file.h> [--lanes a,b]
 *   node tools/led/led-show.mjs <input...> --json <show.json> [--lanes a,b]
 *
 *   --lanes    Comma-separated lane names to use. Default: the first
 *              boundaries lane plus every hand-made cues and spans lane
 *              (detector lanes are left out). Name a lyrics lane to flash
 *              on each of its words or sounds.
 *   --bpm      Tempo for pulse speeds when the input carries no grid.
 *   --flash-ms Cue flash length (default 400).
 *
 * The WLED player (wled-play.mjs) and the FastLED sketch (fastled/) both read
 * this module, so a show looks the same on either.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Section colors by type, as the app draws them. Kept equal to
 *  SECTION_COLORS in web-app/src/components/inspector-v2/sectionConstants.ts
 *  (led-show.test.mjs fails when the two drift). */
export const SECTION_COLORS = {
  intro: '#a78bfa',
  buildup: '#fde047',
  drop: '#4ade80',
  breakdown: '#e879f9',
  bridge: '#fb7185',
  outro: '#64748b',
  silence: '#334155',
  verse: '#38bdf8',
  prechorus: '#f59e0b',
  chorus: '#10b981',
  groove: '#c084fc',
  other: '#d4a373',
  unset: '#64748b',
  default: '#94a3b8',
};

/** Beats per pulse tick, by the app's pulse rates (PULSE_RATES in
 *  web-app/src/types/annotationLayer.ts). `bar` is resolved per song. */
const PULSE_BEATS = {
  '32nd': 1 / 8, '16th-triplet': 1 / 6, '16th': 1 / 4, '8th-triplet': 1 / 3, '8th': 1 / 2, beat: 1, bar: 'bar',
};

const KINDS = { section: 0, span: 1, cue: 2 };

// ── Reading ──────────────────────────────────────────────────────────────────

function walkJson(p, out) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const f of fs.readdirSync(p).sort()) walkJson(path.join(p, f), out);
  } else if (p.endsWith('.json')) {
    try { out.push({ file: p, json: JSON.parse(fs.readFileSync(p, 'utf8')) }); } catch { /* not ours */ }
  }
  return out;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One lane in a single shape, whichever file it came from. Times in seconds. */
function laneFromManifest(lane, grid) {
  return {
    name: lane.name, type: lane.type, color: lane.color ?? null,
    detected: Boolean(lane.detector),
    items: (lane.items ?? []).map((it) => ({
      start: num(it.start), end: num(it.end), label: it.label ?? it.text ?? '',
      sectionType: it.section_type ?? null, color: it.color ?? null,
      pulseMs: num(it.pulse?.interval_ms), pulseRate: it.pulse?.rate ?? null,
      startBeat: num(it.start_beat ?? it.beat), endBeat: num(it.end_beat),
    })),
    grid,
  };
}

function laneFromLayer(layer) {
  return {
    name: layer.name, type: layer.type, color: layer.color ?? null,
    detected: Boolean(layer.source && layer.source !== 'manual') || Boolean(layer.importedFrom),
    items: (layer.items ?? []).map((it) => ({
      start: num(it.start ?? it.time), end: num(it.end ?? it.time),
      label: it.label ?? it.text ?? '', sectionType: layer.type === 'boundaries' ? (it.type ?? null) : null,
      color: it.color ?? null, pulseMs: null, pulseRate: it.pulse ?? null,
      startBeat: num(it.startBeat ?? it.beat), endBeat: num(it.endBeat),
    })),
    grid: null,
  };
}

/** Every lane found in the inputs (files or folders). */
export function readLanes(inputs) {
  const lanes = [];
  let song = null;
  let grid = null;
  for (const input of inputs) {
    for (const { json } of walkJson(input, [])) {
      if (Array.isArray(json?.lanes)) {                       // export-timing-files manifest
        song = song ?? json.song ?? null;
        grid = grid ?? json.grid ?? null;
        for (const lane of json.lanes) lanes.push(laneFromManifest(lane, json.grid ?? null));
      } else if (Array.isArray(json?.layers)) {               // a whole layers document
        for (const layer of json.layers) lanes.push(laneFromLayer(layer));
      } else if (json && typeof json.type === 'string' && Array.isArray(json.items)) {
        lanes.push(laneFromLayer(json));                      // one layer from the Export dialog
      } else if (json && num(json.bpm)) {
        grid = grid ?? { bpm: json.bpm, beats_per_bar: json.beatsPerBar ?? json.beats_per_bar ?? 4 };
      }
    }
  }
  return { lanes, song, grid };
}

// ── Building ─────────────────────────────────────────────────────────────────

const USABLE = new Set(['boundaries', 'sections', 'spans', 'cues', 'lyrics']);

/** The lanes a show is made of: the ones named, or a sensible default. */
export function pickLanes(lanes, names) {
  if (names?.length) {
    const want = names.map((n) => n.trim().toLowerCase());
    const picked = lanes.filter((l) => want.includes(String(l.name).toLowerCase()) && USABLE.has(l.type));
    const missing = want.filter((n) => !picked.some((l) => String(l.name).toLowerCase() === n));
    if (missing.length) throw new Error(`no usable lane named: ${missing.join(', ')}`);
    return picked;
  }
  const boundaries = lanes.find((l) => l.type === 'boundaries' && !l.detected)
    ?? lanes.find((l) => l.type === 'boundaries');
  return [
    ...(boundaries ? [boundaries] : []),
    ...lanes.filter((l) => (l.type === 'cues' || l.type === 'spans') && !l.detected),
  ];
}

/** Seconds per beat for a span: from the stamped beats when present (this
 *  survives tempo maps), else the song's BPM. */
function secondsPerBeat(item, bpm) {
  if (item.startBeat != null && item.endBeat != null && item.endBeat > item.startBeat && item.end > item.start) {
    return (item.end - item.start) / (item.endBeat - item.startBeat);
  }
  return bpm ? 60 / bpm : null;
}

function stepMs(item, bpm, beatsPerBar) {
  if (item.pulseMs) return item.pulseMs;
  const spb = secondsPerBeat(item, bpm);
  if (item.pulseRate === 'silent') return 0;
  const beats = PULSE_BEATS[item.pulseRate] ?? 1;
  const b = beats === 'bar' ? beatsPerBar : beats;
  return spb ? Math.max(20, Math.round(b * spb * 1000)) : 250;
}

/** The show: events sorted by start, times in ms, colors as [r,g,b]. */
export function buildShow({ lanes, song, grid }, opts = {}) {
  const bpm = num(opts.bpm) ?? num(grid?.bpm);
  const beatsPerBar = num(grid?.beats_per_bar) ?? 4;
  const flashMs = num(opts.flashMs) ?? 400;
  const picked = pickLanes(lanes, opts.lanes);
  const events = [];
  const songEnd = Math.max(0, ...lanes.flatMap((l) => l.items.map((i) => i.end ?? i.start ?? 0)));

  for (const lane of picked) {
    const items = lane.items.filter((i) => i.start != null).sort((a, b) => a.start - b.start);
    if (lane.type === 'boundaries' || lane.type === 'sections') {
      items.forEach((it, i) => {
        const next = items[i + 1]?.start ?? (num(opts.durationSec) ?? songEnd);
        if (it.sectionType === 'unset' && (it.label === '—' || !it.label)) return;   // the song's end cap
        if (next <= it.start) return;
        const color = it.color ?? SECTION_COLORS[it.sectionType] ?? lane.color ?? SECTION_COLORS.default;
        events.push({ kind: 'section', start: it.start, end: next, label: it.label, color, lane: lane.name });
      });
    } else if (lane.type === 'spans') {
      for (const it of items) {
        if (!(it.end > it.start)) continue;
        events.push({
          kind: 'span', start: it.start, end: it.end, label: it.label, lane: lane.name,
          color: it.color ?? lane.color ?? '#ffffff', stepMs: stepMs(it, bpm, beatsPerBar),
        });
      }
    } else {                                                   // cues, lyrics
      for (const it of items) {
        events.push({
          kind: 'cue', start: it.start, end: it.start + flashMs / 1000, label: it.label, lane: lane.name,
          color: it.color ?? lane.color ?? '#ffffff',
        });
      }
    }
  }
  events.sort((a, b) => a.start - b.start || KINDS[a.kind] - KINDS[b.kind]);
  return {
    song: song ?? null,
    bpm: bpm ?? null,
    durationMs: Math.round(Math.max(songEnd, ...events.map((e) => e.end)) * 1000),
    lanes: picked.map((l) => `${l.name} (${l.type})`),
    events: events.map((e) => ({
      ...e, startMs: Math.round(e.start * 1000), endMs: Math.round(e.end * 1000), rgb: hexToRgb(e.color),
    })),
  };
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!m) return [255, 255, 255];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** What the show looks like at time `ms`: base section color, the span chase
 *  (if any) and the cue flash level (0..1). The WLED player plays exactly
 *  this; the FastLED sketch computes the same thing on the board. */
export function stateAt(show, ms, flashMs = 400) {
  let section = null; let span = null; let cue = null;
  for (const e of show.events) {
    if (e.startMs > ms) break;
    if (e.kind === 'section' && ms < e.endMs) section = e;
    else if (e.kind === 'span' && ms < e.endMs) span = e;
    else if (e.kind === 'cue' && ms - e.startMs < flashMs) cue = e;
  }
  return { section, span, cue, flash: cue ? 1 - (ms - cue.startMs) / flashMs : 0 };
}

// ── Writing ──────────────────────────────────────────────────────────────────

const cComment = (s) => String(s).replace(/\*\//g, '* /').replace(/[\r\n]+/g, ' ').slice(0, 70);

/** A C header the FastLED sketch includes. Events live in flash (PROGMEM). */
export function toHeader(show) {
  const rows = show.events.map((e) => {
    const [r, g, b] = e.rgb;
    return `  { ${e.startMs}UL, ${e.endMs}UL, ${e.stepMs ?? 0}, ${KINDS[e.kind]}, ${r}, ${g}, ${b} },  // ${e.kind}: ${cComment(e.label)}`;
  });
  return [
    '// Generated by tools/led/led-show.mjs from TimeCues annotations. Regenerate, don\'t edit.',
    `// Song: ${cComment(show.song ?? 'unknown')}`,
    `// Lanes: ${cComment(show.lanes.join(', '))}`,
    '#pragma once',
    '#include <stdint.h>',
    '#ifndef PROGMEM',
    '#define PROGMEM',
    '#endif',
    '',
    '// kind: 0 = section (base color), 1 = span (chase, one step per step_ms), 2 = cue (flash)',
    'typedef struct { uint32_t start_ms; uint32_t end_ms; uint16_t step_ms; uint8_t kind, r, g, b; } TcEvent;',
    '',
    `static const uint32_t TC_SONG_MS = ${show.durationMs}UL;`,
    `static const uint16_t TC_EVENT_COUNT = ${show.events.length};`,
    `static const TcEvent TC_EVENTS[${Math.max(1, show.events.length)}] PROGMEM = {`,
    ...(rows.length ? rows : ['  { 0UL, 0UL, 0, 0, 0, 0, 0 },  // empty show']),
    '};',
    '',
  ].join('\n');
}

export function toJson(show) {
  return JSON.stringify({
    song: show.song, bpm: show.bpm, duration_ms: show.durationMs, lanes: show.lanes,
    events: show.events.map((e) => ({
      kind: e.kind, start_ms: e.startMs, end_ms: e.endMs, label: e.label, lane: e.lane,
      color: e.color, ...(e.kind === 'span' ? { step_ms: e.stepMs } : {}),
    })),
  }, null, 2) + '\n';
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = { inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v == null) throw new Error(`${a} needs a value`); return v; };
    if (a === '--lanes') opts.lanes = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--bpm') opts.bpm = Number(val());
    else if (a === '--flash-ms') opts.flashMs = Number(val());
    else if (a === '--header') opts.header = val();
    else if (a === '--json') opts.json = val();
    else if (a === '--list') opts.list = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('--')) opts[a.slice(2)] = val();
    else opts.inputs.push(a);
  }
  return opts;
}

export function loadShow(opts) {
  if (!opts.inputs.length) throw new Error('give the exported annotations: a manifest, layer JSON files, or a folder');
  for (const p of opts.inputs) if (!fs.existsSync(p)) throw new Error(`not found: ${p}`);
  const read = readLanes(opts.inputs);
  if (!read.lanes.length) throw new Error('no TimeCues lanes found in the input');
  return { read, show: buildShow(read, opts) };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    const doc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1];
    process.stdout.write(doc.replace(/^ \* ?/gm, '') + '\n');
    return;
  }
  const { read, show } = loadShow(opts);
  if (opts.list) {
    for (const l of read.lanes) {
      const used = show.lanes.includes(`${l.name} (${l.type})`) ? '*' : ' ';
      console.log(`${used} ${l.name}  [${l.type}${l.detected ? ', detector' : ''}]  ${l.items.length} items`);
    }
    console.log('\n* = in the show. Pick others with --lanes "Name 1,Name 2".');
  }
  if (opts.header) fs.writeFileSync(opts.header, toHeader(show));
  if (opts.json) fs.writeFileSync(opts.json, toJson(show));
  const n = (k) => show.events.filter((e) => e.kind === k).length;
  console.log(`${n('section')} sections, ${n('span')} spans, ${n('cue')} cues · ${(show.durationMs / 1000).toFixed(1)} s`
    + (opts.header ? ` → ${opts.header}` : '') + (opts.json ? ` → ${opts.json}` : ''));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(`led-show: ${e.message}`); process.exit(1); }
}
