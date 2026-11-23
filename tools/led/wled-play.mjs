#!/usr/bin/env node
/**
 * Play a song's TimeCues annotations on a WLED controller, in time with the
 * song, over WLED's JSON API (POST /json/state). No firmware changes, no
 * dependencies: Node 18+ and a WLED device on the same network.
 *
 *   section  the segment sits in the section's color, dimmed
 *   span     WLED's Theater chase in the span's color; its speed follows
 *            the span's Pulse (a beat when none is set)
 *   cue      a flash in the cue's color that fades back out
 *
 * Usage:
 *   node tools/led/wled-play.mjs <input...> --host <ip> [options]
 *
 *   <input>         The exported annotations, as for led-show.mjs: the
 *                   export-timing-files manifest, or "TimeCues JSON" layer
 *                   files from the app's Export dialog (files or a folder).
 *   --host <ip>     The WLED device (e.g. 192.168.1.50 or wled.local).
 *   --lanes a,b     Lanes to play (default: sections + hand-made cues/spans).
 *   --start <sec>   Begin partway into the song.
 *   --audio <file>  Play the song too, with ffplay (or afplay on a Mac when
 *                   starting from 0). Without it, press Enter on the song's
 *                   first beat.
 *   --map <file>    JSON object of label pattern → WLED state, for effects or
 *                   presets of your own, e.g.
 *                     { "Shockwave": { "ps": 3 }, "^Matrix": { "seg": [{ "fx": 66 }] } }
 *                   A matching cue or span sends that state instead of the
 *                   default flash or chase. Patterns are case-insensitive.
 *   --brightness n  Master brightness while playing, 1-255 (default 128).
 *   --segment n     Segment id to drive (default 0).
 *   --latency ms    Send each change this much early (default 0).
 *   --dry-run       Print what would be sent, and send nothing.
 *
 * The device's state is saved before the show and put back after it, also
 * on Ctrl-C.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadShow, parseArgs } from './led-show.mjs';

const SECTION_LEVEL = 0.3;   // a section's base color, dimmed so spans and cues read over it
const FLASH_HOLD_MS = 100;   // how long a cue holds full color before fading

const scale = ([r, g, b], k) => [Math.round(r * k), Math.round(g * k), Math.round(b * k)];

/** WLED speed (0-255) for a chase step in ms. WLED's speed is not in ms and
 *  differs per effect, so this is an approximation: faster pulse → higher. */
export function speedFor(stepMs) {
  if (!stepMs) return 0;
  return Math.max(0, Math.min(255, Math.round(255 - (stepMs - 40) / 2)));
}

function compileMap(map) {
  return Object.entries(map ?? {}).map(([pattern, state]) => ({ re: new RegExp(pattern, 'i'), state }));
}

/** Every state change of the show, in order: [{ atMs, body, why }]. */
export function buildCommands(show, { theaterFx = null, segment = 0, map = {}, flashMs = 400 } = {}) {
  const rules = compileMap(map);
  const custom = (label) => rules.find((r) => r.re.test(label ?? ''))?.state ?? null;
  const seg = (o) => ({ id: segment, ...o });

  // What the strip shows underneath any flash at time t.
  const sections = show.events.filter((e) => e.kind === 'section');
  const spans = show.events.filter((e) => e.kind === 'span');
  const under = (t) => {
    const s = sections.find((e) => e.startMs <= t && t < e.endMs);
    const base = s ? scale(s.rgb, SECTION_LEVEL) : [0, 0, 0];
    const p = spans.find((e) => e.startMs <= t && t < e.endMs);
    if (p) {
      const own = custom(p.label);
      if (own) return { body: own, why: `span: ${p.label} (mapped)` };
      if (theaterFx != null && p.stepMs > 0) {
        return { body: { seg: [seg({ fx: theaterFx, sx: speedFor(p.stepMs), col: [p.rgb, base, [0, 0, 0]] })] }, why: `span: ${p.label}` };
      }
      return { body: { seg: [seg({ fx: 0, col: [p.rgb, base, [0, 0, 0]] })] }, why: `span: ${p.label}` };
    }
    return { body: { seg: [seg({ fx: 0, col: [base, [0, 0, 0], [0, 0, 0]] })] }, why: s ? `section: ${s.label}` : 'gap' };
  };

  const cmds = [];
  const marks = new Set();
  for (const e of show.events) {
    if (e.kind !== 'cue') { marks.add(e.startMs); marks.add(e.endMs); }
  }
  for (const t of [...marks].sort((a, b) => a - b)) {
    const u = under(t);
    cmds.push({ atMs: t, body: { transition: 0, ...u.body }, why: u.why });
  }
  for (const c of show.events.filter((e) => e.kind === 'cue')) {
    const own = custom(c.label);
    cmds.push({
      atMs: c.startMs, why: `cue: ${c.label}${own ? ' (mapped)' : ''}`,
      body: own ? { transition: 0, ...own } : { transition: 0, seg: [seg({ fx: 0, col: [c.rgb, [0, 0, 0], [0, 0, 0]] })] },
    });
    const back = Math.min(c.startMs + FLASH_HOLD_MS, c.endMs);
    const u = under(back);
    const fade = Math.max(0, Math.round((flashMs - FLASH_HOLD_MS) / 100));   // WLED counts 100 ms units
    cmds.push({ atMs: back, body: { transition: fade, ...u.body }, why: `  ↳ back to ${u.why}` });
  }
  // A later command at the same moment wins; keep the input order stable.
  return cmds.map((c, i) => ({ ...c, i })).sort((a, b) => a.atMs - b.atMs || a.i - b.i).map(({ i, ...c }) => c);
}

const clock = (ms) => {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};

async function api(host, route, body) {
  const res = await fetch(`http://${host}/json${route}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(1500),
  });
  if (!res.ok) throw new Error(`${route}: HTTP ${res.status}`);
  return res.json();
}

function startAudio(file, startSec) {
  const has = (bin) => spawnSync('which', [bin]).status === 0;
  if (has('ffplay')) return spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-ss', String(startSec), file], { stdio: 'ignore' });
  if (startSec === 0 && has('afplay')) return spawn('afplay', [file], { stdio: 'ignore' });
  throw new Error('--audio needs ffplay (or afplay on a Mac, from the start of the song)');
}

const waitForEnter = (prompt) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(prompt, () => { rl.close(); resolve(); });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    const doc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1];
    process.stdout.write(doc.replace(/^ \* ?/gm, '') + '\n');
    return;
  }
  const dry = Boolean(opts.dryRun);
  if (!opts.host && !dry) throw new Error('--host <ip> is required (or --dry-run)');
  const { show } = loadShow(opts);
  const startMs = Math.round(Number(opts.start ?? 0) * 1000);
  const segment = Number(opts.segment ?? 0);
  const bri = Math.max(1, Math.min(255, Number(opts.brightness ?? 128)));
  const latency = Number(opts.latency ?? 0);
  const map = opts.map ? JSON.parse(fs.readFileSync(opts.map, 'utf8')) : {};

  let theaterFx = 13;   // Theater in WLED's stock effect list; a real device is asked below
  let saved = null;
  if (!dry) {
    const info = await api(opts.host, '/info');
    const names = await api(opts.host, '/effects');
    theaterFx = names.findIndex((n) => /^theater/i.test(n));
    if (theaterFx < 0) theaterFx = names.findIndex((n) => /^chase$/i.test(n));
    saved = await api(opts.host, '/state');
    console.log(`WLED ${info.ver ?? '?'} "${info.name ?? opts.host}", ${info.leds?.count ?? '?'} LEDs · chase effect: ${theaterFx >= 0 ? names[theaterFx] : 'none, using solid color'}`);
    if (theaterFx < 0) theaterFx = null;
  }
  const cmds = buildCommands(show, { theaterFx, segment, map, flashMs: Number(opts.flashMs ?? 400) })
    .filter((c) => c.atMs >= startMs || c.atMs === 0);
  console.log(`${show.events.length} events from ${show.lanes.join(', ')} → ${cmds.length} state changes`);

  if (dry) {
    for (const c of cmds) if (c.atMs >= startMs) console.log(`${clock(c.atMs)}  ${c.why}  ${JSON.stringify(c.body)}`);
    return;
  }

  let stopped = false;
  const restore = async () => {
    if (stopped) return; stopped = true;
    try { await api(opts.host, '/state', { ...saved, transition: 7 }); console.log('\nRestored the device\'s earlier state.'); } catch { /* best effort */ }
  };
  process.on('SIGINT', async () => { await restore(); process.exit(130); });

  await api(opts.host, '/state', { on: true, bri, transition: 0, seg: [{ id: segment, fx: 0, col: [[0, 0, 0]] }] });
  // Put the strip in whatever is playing at the start point before the clock runs.
  const before = cmds.filter((c) => c.atMs <= startMs && !c.why.startsWith('cue')).pop();
  if (before) await api(opts.host, '/state', before.body);

  let audio = null;
  if (opts.audio) audio = startAudio(opts.audio, startMs / 1000);
  else await waitForEnter(`Ready at ${clock(startMs)}. Press Enter on the song's ${startMs ? 'matching moment' : 'first beat'}… `);
  const t0 = performance.now() - startMs;

  for (const c of cmds.filter((x) => x.atMs > startMs)) {
    await sleep(c.atMs - latency - (performance.now() - t0));
    if (stopped) break;
    api(opts.host, '/state', c.body).catch((e) => console.error(`  ! ${e.message}`));
    if (!c.why.startsWith('  ↳')) console.log(`${clock(c.atMs)}  ${c.why}`);
  }
  await sleep(show.durationMs - (performance.now() - t0));
  audio?.kill();
  await restore();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Exit explicitly: the Enter prompt leaves stdin referenced, which would keep Node alive.
  main().then(() => process.exit(0), (e) => { console.error(`wled-play: ${e.message}`); process.exit(1); });
}
