// One-time conversion: groove copies made before 2026-10-16 — three spans
// layers per groove lane, "<name> · 1 groove", "· 2 versions", "· 3 changes" —
// into what Copy to manual layer makes now: riff-patterns layers, one per
// drum, each node carrying its groove as data (RiffNode.groove).
//
// The old spans kept the groove only as sentences, so the groove is taken from
// the detector's cached output instead — the lane model Copy itself reads —
// and only where that output still IS what was copied: every "1 groove"
// sentence must read the same off it (grooveRhythm) and every "3 changes" bar
// must hit the same steps. Anything else is left as it is and reported.
//
// Usage (from web-app/):
//   ./node_modules/.bin/vite-node scripts/convert-legacy-groove-copies.ts -- [--data ../data] [--backup DIR] [--apply]
//
// A dry run by default. --apply writes each converted layers file, after
// copying the original to --backup (required with --apply).

import fs from 'node:fs';
import path from 'node:path';
import {
  addLayerToGroupNamed,
  pickDefaultLayerColor,
  pruneGroups,
  type AnnotationLayer,
  type AnnotationLayersDocument,
  type SpanItem,
} from '../src/types/annotationLayer';
import type { CustomPatternItem } from '../src/types/customScript';
import {
  grooveLaneModel,
  grooveRhythm,
  grooveSummary,
  isGrooveOutput,
  type GrooveLaneModel,
} from '../src/components/inspector-v2/drumGrooves';
import { riffLayersFromGroove } from '../src/components/inspector-v2/grooveToRiff';

const LEVELS = [' · 1 groove', ' · 2 versions', ' · 3 changes'] as const;

/** What the old "3 changes" spans carried on each bar. */
interface OldBar { groove: string; hits: Record<string, number[]> }

interface Candidate {
  /** The lane's own name (Percussion layers' "Hi-hat pattern"), or null for a
   *  detector with one groove lane. */
  lane: string | null;
  laneGroup: string | null;
  model: GrooveLaneModel;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
}

/** Every groove lane the detectors' cached outputs hold for `slug`. */
function candidates(dataDir: string, slug: string): Candidate[] {
  const root = path.join(dataDir, 'algorithm-outputs', 'custom');
  if (!fs.existsSync(root)) return [];
  const out: Candidate[] = [];
  for (const det of fs.readdirSync(root)) {
    const env = readJson<{
      items?: CustomPatternItem[];
      lanes?: { label: string; group?: string; output_kind: string; items: CustomPatternItem[] }[];
    }>(path.join(root, det, `${slug}.json`));
    if (!env) continue;
    if (env.items?.length && isGrooveOutput(env.items)) out.push({ lane: null, laneGroup: null, model: grooveLaneModel(env.items) });
    for (const lane of env.lanes ?? []) {
      if (lane.output_kind === 'pattern' && isGrooveOutput(lane.items)) {
        out.push({ lane: lane.label, laneGroup: lane.group ?? null, model: grooveLaneModel(lane.items) });
      }
    }
  }
  return out;
}

/** The hits each drum struck in the bar starting at `start`, by the model. */
function modelBar(model: GrooveLaneModel, start: number): Record<string, number[]> | null {
  for (const cell of model.bars) {
    const barSec = (cell.end - cell.start) / cell.bars;
    for (let b = 0; b < cell.bars; b += 1) {
      if (Math.abs(cell.start + b * barSec - start) > 0.02) continue;
      const lo = b * cell.stepsPerBar;
      return Object.fromEntries(model.rows.map((row) => [row, cell.rows[row]
        .filter((st) => st.state !== 'missing' && st.step >= lo && st.step < lo + cell.stepsPerBar)
        .map((st) => st.step - lo)]));
    }
  }
  return null;
}

/** Does `model` say what the old copy said, sentence for sentence and bar for bar? */
function reproduces(model: GrooveLaneModel, grooveLayer: AnnotationLayer, changes: AnnotationLayer): boolean {
  for (const it of grooveLayer.items as SpanItem[]) {
    const said = it.description?.match(/ · (\S+)'s rhythm.*$/u);
    if (said && grooveRhythm(model, said[1]) !== said[0].slice(3)) return false;
  }
  for (const it of changes.items as (SpanItem & { groove?: OldBar })[]) {
    if (!it.groove) return false;
    const bar = modelBar(model, it.start);
    if (!bar) return false;
    const drums = new Set([...Object.keys(bar), ...Object.keys(it.groove.hits)]);
    for (const d of drums) {
      if ((bar[d] ?? []).join(',') !== (it.groove.hits[d] ?? []).join(',')) return false;
    }
  }
  return true;
}

function convert(doc: AnnotationLayersDocument, dataDir: string, bpm: number | undefined, log: (s: string) => void): AnnotationLayersDocument | null {
  const groovesLayers = doc.layers.filter((l) => l.type === 'spans' && l.name.endsWith(LEVELS[0]));
  if (groovesLayers.length === 0) return null;
  const pool = candidates(dataDir, doc.song);
  let next = doc;
  let changed = false;
  for (const g of groovesLayers) {
    const base = g.name.slice(0, -LEVELS[0].length);
    // The three levels of one copy: same name, same group, in order.
    const start = next.layers.findIndex((l) => l.id === g.id);
    const trio = next.layers.slice(start, start + 3);
    const ok = trio.length === 3 && trio.every((l, i) => l.type === 'spans' && l.name === base + LEVELS[i] && l.groupId === g.groupId);
    if (!ok) { log(`  ${g.name}: its 2 versions / 3 changes layers are not beside it — left as it is`); continue; }
    const matches = pool.filter((c) => reproduces(c.model, trio[0], trio[2]));
    if (matches.length !== 1) {
      log(`  ${g.name} (group ${(doc.groups ?? []).find((x) => x.id === g.groupId)?.name ?? '-'}): ${matches.length} detector lanes reproduce it — left as it is`);
      continue;
    }
    const [{ lane, laneGroup, model }] = matches;
    const name = lane ?? base;
    const groupName = laneGroup ? `${base} · ${laneGroup}` : ((doc.groups ?? []).find((x) => x.id === g.groupId)?.name ?? base);
    const taken = next.layers.filter((l) => !trio.includes(l));
    const made = riffLayersFromGroove(model, bpm, {
      name,
      importedFrom: name,
      summary: grooveSummary(model),
      colorFor: () => {
        const color = pickDefaultLayerColor(taken);
        taken.push({ color } as AnnotationLayer);
        return color;
      },
    });
    // The old copy's group is where the annotator keeps it — maybe renamed,
    // maybe holding other lanes — so the new layers stay in it; a copy with
    // no group gets the one Copy would make.
    const layers = [...next.layers];
    layers.splice(start, 3, ...made.map((m) => (g.groupId ? { ...m, groupId: g.groupId } : m)));
    next = { ...next, layers };
    if (!g.groupId) for (const m of made) next = addLayerToGroupNamed(next, m.id, groupName);
    changed = true;
    const where = (next.groups ?? []).find((x) => x.id === g.groupId)?.name ?? groupName;
    log(`  ${g.name} → ${made.map((m) => `"${m.name}" (${m.nodes?.length ?? 0} nodes, ${m.items.length} instances)`).join(', ')} in "${where}"`);
  }
  return changed ? pruneGroups(next) : null;
}

function main() {
  const dataDir = path.resolve(arg('--data') ?? path.join(process.cwd(), '..', 'data'));
  const apply = process.argv.includes('--apply');
  const backup = arg('--backup');
  if (apply && !backup) throw new Error('--apply needs --backup DIR');
  const layersRoot = path.join(dataDir, 'annotations', 'layers');
  for (const ann of fs.existsSync(layersRoot) ? fs.readdirSync(layersRoot) : []) {
    const dir = path.join(layersRoot, ann);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const file = path.join(dir, f);
      const doc = readJson<AnnotationLayersDocument>(file);
      if (!doc?.layers?.some((l) => l.type === 'spans' && l.name.endsWith(LEVELS[0]))) continue;
      const songInfo = readJson<{ bpm?: number }>(path.join(dataDir, 'song-info', f));
      const bpm = (songInfo?.bpm ?? 0) > 20 ? songInfo!.bpm : undefined;
      console.log(`${ann}/${f}${bpm ? '' : ' (no tempo: instances left untimed to it)'}`);
      const next = convert({ ...doc, song: doc.song ?? f.slice(0, -5) }, dataDir, bpm, (s) => console.log(s));
      if (!next || !apply) continue;
      const to = path.join(backup!, ann);
      fs.mkdirSync(to, { recursive: true });
      fs.copyFileSync(file, path.join(to, f));
      fs.writeFileSync(file, JSON.stringify(next, null, 2));
      console.log(`  written; original kept in ${path.join(to, f)}`);
    }
  }
  if (!apply) console.log('\nDry run — nothing written. Add --apply --backup DIR to convert.');
}

main();
