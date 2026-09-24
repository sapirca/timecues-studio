// Assemble the static Cloudflare Pages mirror of the public/demo tier.
//
// Run AFTER `vite build` (which must have been built with VITE_STATIC_DEMO=1).
// The dev server (vite.config.ts) serves the demo corpus through middleware
// that does NOT exist in a static build, so this script bakes the exact same
// URLs the SPA fetches into real files under dist/, and writes the Cloudflare
// Pages routing/header rules.
//
// URL → file mapping (mirrors the dev middleware in web-app/vite.config.ts):
//   /analysis/manifest.json     ← generated from data-default/songs (buildManifest parity)
//   /audio/<file>               ← data-default/songs/<slug>/<file>
//   /stems/<slug>/<file>        ← data-default/stems/<slug>/<file>
//   /analysis/<slug>/<file>     ← data-default/algorithm-outputs/analysis/<slug>/<file>
//   /api/song-info/<slug>       ← data-default/song-info/<slug>.json  (loadSongInfo falls
//                                  through to this for real BPM/grid in demo mode)
//   /api/<fam>/cached           ← which demo slugs have cached results for an
//                                 experimental family (the visibility gate)
//   /api/<fam>/detect/<slug>/<id> ← data-default/algorithm-outputs/<fam>/<slug>/<id>.json
//   /api/custom-scripts         ← data-default/demo-custom-registry.json (the curated
//                                  detector registry; served via an exact _redirects
//                                  rule since the path also roots the result files below)
//   /api/custom-scripts/result/<name>/<slug>
//                               ← data-default/algorithm-outputs/custom/<name>/<slug>.json
//                                  (curated detector outputs — Karaoke lyrics, cues, spans…)
//   /api/dataset-config         ← public-safe stub  { callerTier: "public" }
//   /api/corpus/stats           ← { songs, admins, researchers, team }
//
// Everything else under /api, /analysis, /stems, /audio that ISN'T baked here
// resolves to a 404 (see _redirects) so the SPA's graceful `!res.ok` / catch
// fallbacks fire instead of being fed index.html by the SPA catch-all.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_APP = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(WEB_APP, '..');
const DIST = path.join(WEB_APP, 'dist');
const DEFAULT_DATA = path.join(REPO_ROOT, 'data-default');

const SONGS_DIR = path.join(DEFAULT_DATA, 'songs');
const STEMS_DIR = path.join(DEFAULT_DATA, 'stems');
const ANALYSIS_DIR = path.join(DEFAULT_DATA, 'algorithm-outputs', 'analysis');
const SONGINFO_DIR = path.join(DEFAULT_DATA, 'song-info');
const CUSTOM_DIR = path.join(DEFAULT_DATA, 'algorithm-outputs', 'custom');
const CUSTOM_REGISTRY_FIXTURE = path.join(DEFAULT_DATA, 'demo-custom-registry.json');
// Experimental loop/pattern detectors are hidden by the real backend unless the
// experimentalLoopsAndPatterns Settings flag is on; the demo defaults it off, so
// match that and leave them out of the baked registry.
const GATED_OUTPUT_KINDS = new Set(['loop', 'pattern']);

const AUDIO_EXT = /\.(mp3|wav|flac|ogg|m4a)$/i;

function die(msg) { console.error(`[assemble-cf-demo] ERROR: ${msg}`); process.exit(1); }
function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } }
function writeFile(rel, data) {
  const dst = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, typeof data === 'string' ? data : JSON.stringify(data));
}
function copyInto(srcFile, rel) {
  const dst = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(srcFile, dst);
}
function copyDir(srcDir, relDir) {
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const s = path.join(srcDir, e.name);
    const rel = path.join(relDir, e.name);
    if (e.isDirectory()) copyDir(s, rel);
    else copyInto(s, rel);
  }
}

// Parity with readSongInfoName() / deriveDisplayName() in web-app/vite.config.ts.
function readSongInfoName(slug) {
  const meta = readJSON(path.join(SONGINFO_DIR, `${slug}.json`));
  const title = meta?.title?.trim();
  if (title) return { title, artist: meta.artist?.trim() || undefined };
  return {};
}
function deriveDisplayName(meta, slug, filenameStem) {
  if (meta.title) return meta.artist ? `${meta.artist} — ${meta.title}` : meta.title;
  if (filenameStem) return filenameStem.replace(/\s*-\s*/g, ' — ');
  return slug;
}

if (!fs.existsSync(DIST)) die(`dist/ not found at ${DIST} — run \`vite build\` first.`);
if (!fs.existsSync(SONGS_DIR)) die(`data-default/songs not found at ${SONGS_DIR}.`);

// ─── 1. Manifest + audio + stems + analysis + song-info, per song ────────────
const manifest = [];
let audioCount = 0, stemCount = 0, analysisCount = 0, songInfoCount = 0;

for (const slug of fs.readdirSync(SONGS_DIR)) {
  const slugDir = path.join(SONGS_DIR, slug);
  try { if (!fs.statSync(slugDir).isDirectory()) continue; } catch { continue; }
  const audioFile = fs.readdirSync(slugDir).find((f) => AUDIO_EXT.test(f));
  if (!audioFile) continue;
  const stem = audioFile.slice(0, audioFile.length - path.extname(audioFile).length);
  const hasAnalysis = fs.existsSync(path.join(ANALYSIS_DIR, slug));

  const songMeta = readSongInfoName(slug);
  manifest.push({
    id: slug,
    name: deriveDisplayName(songMeta, slug, stem),
    title: songMeta.title,
    artist: songMeta.artist,
    file: audioFile,
    url: `/audio/${audioFile}`,
    hasAnalysis,
  });

  // Audio → /audio/<file>
  copyInto(path.join(slugDir, audioFile), path.join('audio', audioFile));
  audioCount++;

  // Stems → /stems/<slug>/*
  const songStems = path.join(STEMS_DIR, slug);
  if (fs.existsSync(songStems)) {
    copyDir(songStems, path.join('stems', slug));
    stemCount++;
  }

  // Analysis → /analysis/<slug>/*
  const songAnalysis = path.join(ANALYSIS_DIR, slug);
  if (fs.existsSync(songAnalysis)) {
    copyDir(songAnalysis, path.join('analysis', slug));
    analysisCount++;
  }

  // Song-info → /api/song-info/<slug> (extensionless, matches the fetch URL).
  // loadSongInfo() falls through to this in demo mode for the real BPM/grid.
  const sip = path.join(SONGINFO_DIR, `${slug}.json`);
  if (fs.existsSync(sip)) {
    writeFile(path.join('api', 'song-info', slug), fs.readFileSync(sip, 'utf-8'));
    songInfoCount++;
  }
}

// Same title-first ordering as buildManifest() in web-app/vite.config.ts.
const manifestSortKey = (e) => {
  if (e.title) return `${e.title} ${e.artist ?? ''}`;
  const i = e.name.indexOf(' — ');
  return i > 0 ? `${e.name.slice(i + 3)} ${e.name.slice(0, i)}` : e.name;
};
manifest.sort((a, b) => manifestSortKey(a).localeCompare(manifestSortKey(b)));
writeFile(path.join('analysis', 'manifest.json'), JSON.stringify(manifest));

// ─── 1b. Curated custom-detector outputs + registry ──────────────────────────
// The Inspector loads each registered detector's cached result and turns
// `lyrics`/`cue`/`span`/… envelopes into overlay + Karaoke layers. With no
// backend, the static mirror serves the committed demo cache instead:
//   listDetectors()      → GET /api/custom-scripts                  (registry)
//   getDetectorResult()  → GET /api/custom-scripts/result/<n>/<s>   (envelope)
// The registry is filtered to detectors that actually have demo data and
// aren't experimental loop/pattern, mirroring the flag-off backend response.
const demoSlugs = new Set(manifest.map((m) => m.id));
const registryFixture = readJSON(CUSTOM_REGISTRY_FIXTURE);
const kindByName = new Map(
  (registryFixture?.detectors ?? []).map((d) => [d.name, d.output_kind]),
);
let customResultCount = 0;
const detectorsWithDemoData = new Set();
if (fs.existsSync(CUSTOM_DIR)) {
  for (const name of fs.readdirSync(CUSTOM_DIR)) {
    const detDir = path.join(CUSTOM_DIR, name);
    try { if (!fs.statSync(detDir).isDirectory()) continue; } catch { continue; }
    // Skip detectors the registry won't list (unknown or gated kind) so we
    // don't bake orphan result files the SPA never fetches.
    const kind = kindByName.get(name);
    if (!kind || GATED_OUTPUT_KINDS.has(kind)) continue;
    for (const slug of demoSlugs) {
      const src = path.join(detDir, `${slug}.json`);
      if (!fs.existsSync(src)) continue;
      writeFile(path.join('api', 'custom-scripts', 'result', name, slug),
        fs.readFileSync(src, 'utf-8'));
      detectorsWithDemoData.add(name);
      customResultCount++;
    }
  }
}
// Registry → /api/custom-scripts-registry.json (an exact _redirects rule maps
// the real fetch URL /api/custom-scripts onto it; see _redirects below).
let customDetectorCount = 0;
if (registryFixture && Array.isArray(registryFixture.detectors)) {
  const detectors = registryFixture.detectors.filter(
    (d) => detectorsWithDemoData.has(d.name) && !GATED_OUTPUT_KINDS.has(d.output_kind),
  );
  writeFile(path.join('api', 'custom-scripts-registry.json'), JSON.stringify({ detectors }));
  customDetectorCount = detectors.length;
} else {
  console.warn('[assemble-cf-demo] WARN: no demo-custom-registry.json — curated/Karaoke layers will be absent from the mirror.');
}

// ─── 1b. Experimental detector families ──────────────────────────────────────
// The mirror runs no Python sidecars, so these lanes can only ever come from
// the committed demo cache. Two URLs matter, and both have to be baked:
//   familyHasCached()  → GET /api/<fam>/cached            (the visibility gate:
//                        a family whose slug list is empty is hidden outright)
//   readExperimental() → GET /api/<fam>/detect/<slug>/<id> (the result itself)
// Families are read off disk rather than listed here, so shipping a new one
// under data-default/algorithm-outputs/ is all it takes. `analysis` and
// `custom` are excluded: they are not experimental families and are baked to
// different URLs above.
const EXPERIMENTAL_FAMILY_DIRS_SKIP = new Set(['analysis', 'custom']);
let familyCount = 0;
let familyResultCount = 0;
const ALGO_OUTPUTS_DIR = path.join(DEFAULT_DATA, 'algorithm-outputs');
if (fs.existsSync(ALGO_OUTPUTS_DIR)) {
  for (const fam of fs.readdirSync(ALGO_OUTPUTS_DIR)) {
    if (EXPERIMENTAL_FAMILY_DIRS_SKIP.has(fam)) continue;
    const famDir = path.join(ALGO_OUTPUTS_DIR, fam);
    try { if (!fs.statSync(famDir).isDirectory()) continue; } catch { continue; }
    const slugs = [];
    for (const slug of fs.readdirSync(famDir)) {
      if (!demoSlugs.has(slug)) continue;            // demo corpus only
      const slugDir = path.join(famDir, slug);
      try { if (!fs.statSync(slugDir).isDirectory()) continue; } catch { continue; }
      let any = false;
      for (const f of fs.readdirSync(slugDir)) {
        if (!f.endsWith('.json')) continue;
        // Extensionless, matching the fetch URL — same trick as song-info.
        writeFile(path.join('api', fam, 'detect', slug, f.slice(0, -5)),
          fs.readFileSync(path.join(slugDir, f), 'utf-8'));
        familyResultCount++;
        any = true;
      }
      if (any) slugs.push(slug);
    }
    if (!slugs.length) continue;
    slugs.sort();
    writeFile(path.join('api', fam, 'cached'),
      JSON.stringify({ family: fam, slugs, count: slugs.length }));
    familyCount++;
  }
}

// ─── 2. Public-safe API stubs ────────────────────────────────────────────────
// dataset-config: server filters sensitive keys for public callers; the static
// mirror has none to filter — ship only the resolved tier. Never the real
// config (it holds member emails).
writeFile(path.join('api', 'dataset-config'), JSON.stringify({ callerTier: 'public' }));

// corpus/stats: honest counts for what the mirror actually serves.
writeFile(path.join('api', 'corpus', 'stats'), JSON.stringify({
  songs: manifest.length,
  admins: 0,
  researchers: 0,
  team: 0,
}));

// ─── 3. Cloudflare Pages routing + headers ───────────────────────────────────
// Real files are served first; these rules only apply to paths with no file.
// Data namespaces 404 (so fetch().json() never gets fed the SPA's index.html);
// every other path serves the SPA so client-side routing works on refresh.
writeFile('_static-demo-404.json', JSON.stringify({ error: 'not available on the static mirror' }));
writeFile('_redirects', [
  '# Static Cloudflare mirror of the TimeCues public/demo tier.',
  '# Unbaked data paths 404 (the SPA degrades gracefully); all other paths',
  '# fall through to the SPA so deep links / refresh work.',
  '# Curated detector registry: the fetch URL has no file (the path roots the',
  '# baked result files), so map it explicitly. Result files are real assets,',
  '# served before any rule. This exact rule must precede the /api/* 404.',
  '/api/custom-scripts   /api/custom-scripts-registry.json   200',
  '/api/*       /_static-demo-404.json   404',
  '/analysis/*  /_static-demo-404.json   404',
  '/stems/*     /_static-demo-404.json   404',
  '/audio/*     /_static-demo-404.json   404',
  '/*           /index.html              200',
  '',
].join('\n'));
writeFile('_headers', [
  '# JSON for the extensionless API files (browsers parse regardless, but be tidy).',
  '/api/*',
  '  Content-Type: application/json; charset=utf-8',
  '# Immutable hashed bundle assets.',
  '/assets/*',
  '  Cache-Control: public, max-age=31536000, immutable',
  '# Audio + stems: cache hard, they never change for the demo corpus.',
  '/audio/*',
  '  Cache-Control: public, max-age=86400',
  '/stems/*',
  '  Cache-Control: public, max-age=86400',
  '',
].join('\n'));

console.log(
  `[assemble-cf-demo] OK — ${manifest.length} songs ` +
  `(${audioCount} audio, ${stemCount} stem sets, ${analysisCount} analysis dirs, ` +
  `${songInfoCount} song-info, ${customDetectorCount} curated detectors / ` +
  `${customResultCount} cached outputs, ${familyCount} detector families / ` +
  `${familyResultCount} cached results), stubs + _redirects + _headers written to dist/.`
);
