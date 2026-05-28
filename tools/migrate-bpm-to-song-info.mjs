#!/usr/bin/env node
// One-time migration: consolidate per-annotator BPM/timeSignature/gridOffset
// from annotation files into the per-song source of truth at
// data/song-info/<slug>.json, then strip the legacy fields from annotations.
//
// Policy:
//   - song-info is the source of truth. If song-info/<slug>.json exists, its
//     values win over any annotation values.
//   - If song-info is missing, seed it from the annotation with the most
//     recent annotated_at timestamp across all annotators (gold preferred
//     over eye when timestamps tie, since gold is the primary annotation).
//   - After seeding, every annotation file has its bpm/timeSignature/
//     gridOffset fields stripped.
//
// Usage:
//   node tools/migrate-bpm-to-song-info.mjs            # dry run, prints plan
//   node tools/migrate-bpm-to-song-info.mjs --apply    # writes changes

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SONG_INFO_DIR = path.join(REPO_ROOT, 'data', 'song-info');
const ANNOTATION_TYPES = ['gold', 'eye'];
const APPLY = process.argv.includes('--apply');

const LEGACY_KEYS = ['bpm', 'timeSignature', 'gridOffset'];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function loadSongInfo(slug) {
  const file = path.join(SONG_INFO_DIR, `${slug}.json`);
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

function collectAnnotationFiles() {
  // Returns: Map<slug, Array<{type, annotator, file, ann}>>
  const bySlug = new Map();
  for (const type of ANNOTATION_TYPES) {
    const typeDir = path.join(REPO_ROOT, 'data', 'annotations', type);
    if (!fs.existsSync(typeDir)) continue;
    for (const annotator of fs.readdirSync(typeDir)) {
      const annotatorDir = path.join(typeDir, annotator);
      if (!fs.statSync(annotatorDir).isDirectory()) continue;
      for (const name of fs.readdirSync(annotatorDir)) {
        if (!name.endsWith('.json')) continue;
        const slug = name.replace(/\.json$/, '');
        const file = path.join(annotatorDir, name);
        let ann;
        try { ann = readJson(file); }
        catch (err) { console.warn(`  ! skip unreadable ${file}: ${err.message}`); continue; }
        const arr = bySlug.get(slug) ?? [];
        arr.push({ type, annotator, file, ann });
        bySlug.set(slug, arr);
      }
    }
  }
  return bySlug;
}

function pickBestSeed(entries) {
  // Prefer gold over eye on ties; otherwise newest annotated_at wins.
  const withTime = entries
    .filter((e) => LEGACY_KEYS.some((k) => e.ann[k] !== undefined))
    .map((e) => ({
      ...e,
      ts: Date.parse(e.ann.annotated_at ?? e.ann.updated_at ?? '') || 0,
    }))
    .sort((a, b) => {
      if (b.ts !== a.ts) return b.ts - a.ts;
      if (a.type === 'gold' && b.type !== 'gold') return -1;
      if (b.type === 'gold' && a.type !== 'gold') return 1;
      return 0;
    });
  return withTime[0] ?? null;
}

function buildSeedSongInfo(slug, seed) {
  const info = {
    song: slug,
    timeSignature: '4/4',
    gridOffset: 0,
    updated_at: new Date().toISOString(),
  };
  if (seed.ann.bpm !== undefined) info.bpm = seed.ann.bpm;
  if (seed.ann.timeSignature) info.timeSignature = seed.ann.timeSignature;
  if (seed.ann.gridOffset !== undefined) info.gridOffset = seed.ann.gridOffset;
  // Place bpm before timeSignature/gridOffset for readability.
  return {
    song: info.song,
    ...(info.bpm !== undefined ? { bpm: info.bpm } : {}),
    timeSignature: info.timeSignature,
    gridOffset: info.gridOffset,
    updated_at: info.updated_at,
  };
}

function stripLegacy(ann) {
  const out = { ...ann };
  let changed = false;
  for (const k of LEGACY_KEYS) {
    if (k in out) { delete out[k]; changed = true; }
  }
  return { out, changed };
}

function main() {
  if (!fs.existsSync(SONG_INFO_DIR)) {
    if (APPLY) fs.mkdirSync(SONG_INFO_DIR, { recursive: true });
  }

  const bySlug = collectAnnotationFiles();
  const seeded = [];        // {slug, info, fromFile}
  const conflicts = [];     // {slug, songInfo, ann, file}
  const stripped = [];      // {file, removed: {bpm?,timeSignature?,gridOffset?}}

  for (const [slug, entries] of [...bySlug.entries()].sort()) {
    const songInfo = loadSongInfo(slug);

    if (!songInfo || songInfo.bpm === undefined) {
      const seed = pickBestSeed(entries);
      if (seed) {
        const newInfo = buildSeedSongInfo(slug, seed);
        // Preserve any existing non-bpm fields if song-info exists already.
        const merged = songInfo ? { ...songInfo, ...newInfo, updated_at: newInfo.updated_at } : newInfo;
        seeded.push({ slug, info: merged, fromFile: seed.file });
      }
    } else {
      // song-info wins; record any annotation values that disagree.
      for (const e of entries) {
        for (const k of LEGACY_KEYS) {
          if (e.ann[k] !== undefined && e.ann[k] !== songInfo[k]) {
            conflicts.push({ slug, key: k, songInfo: songInfo[k], ann: e.ann[k], file: e.file });
          }
        }
      }
    }

    // Always strip legacy fields from every annotation file.
    for (const e of entries) {
      const { out, changed } = stripLegacy(e.ann);
      if (changed) {
        const removed = {};
        for (const k of LEGACY_KEYS) if (k in e.ann) removed[k] = e.ann[k];
        stripped.push({ file: e.file, removed, newAnn: out });
      }
    }
  }

  // ── Report ───────────────────────────────────────────────────────────────
  console.log(`\n${APPLY ? 'APPLY' : 'DRY RUN'} — migrate BPM/timeSignature/gridOffset to song-info\n`);

  console.log(`Will seed ${seeded.length} song-info file(s):`);
  for (const s of seeded) {
    console.log(`  + ${s.slug}.json  (from ${path.relative(REPO_ROOT, s.fromFile)})`);
    console.log(`      bpm=${s.info.bpm} ts=${s.info.timeSignature} offset=${s.info.gridOffset}`);
  }

  console.log(`\nWill strip legacy fields from ${stripped.length} annotation file(s).`);

  if (conflicts.length) {
    console.log(`\n${conflicts.length} conflict(s) — song-info wins, annotation value will be discarded:`);
    for (const c of conflicts) {
      console.log(`  ${c.slug} [${c.key}]: song-info=${JSON.stringify(c.songInfo)} vs ann=${JSON.stringify(c.ann)} (${path.relative(REPO_ROOT, c.file)})`);
    }
  }

  if (!APPLY) {
    console.log('\n(dry run — re-run with --apply to write changes)');
    return;
  }

  // ── Apply ────────────────────────────────────────────────────────────────
  for (const s of seeded) writeJson(path.join(SONG_INFO_DIR, `${s.slug}.json`), s.info);
  for (const s of stripped) writeJson(s.file, s.newAnn);
  console.log('\nDone.');
}

main();
