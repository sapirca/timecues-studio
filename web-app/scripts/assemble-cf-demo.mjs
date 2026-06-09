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

// Parity with deriveDisplayName() in web-app/vite.config.ts.
function deriveDisplayName(slug, filenameStem) {
  const meta = readJSON(path.join(SONGINFO_DIR, `${slug}.json`));
  if (meta) {
    if (meta.artist && meta.title) return `${meta.artist} — ${meta.title}`;
    if (meta.title) return meta.title;
  }
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

  manifest.push({
    id: slug,
    name: deriveDisplayName(slug, stem),
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

manifest.sort((a, b) => a.name.localeCompare(b.name));
writeFile(path.join('analysis', 'manifest.json'), JSON.stringify(manifest));

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
  `${songInfoCount} song-info), stubs + _redirects + _headers written to dist/.`
);
