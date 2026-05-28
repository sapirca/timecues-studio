/**
 * Batch-cache MSAF cluster analysis for all reviewed songs.
 * Usage: node tools/cache-algo-clusters.mjs --annotator <id> [--tolerance 2.0]
 *
 * Reads:  data/annotations/gold/<annotator>/<slug>.json  (reviewed: true)
 *         data/algorithm-outputs/analysis/<slug>/{sf,foote,cnmf,olda}.json
 * Writes: data/algorithm-outputs/algo-clusters/<slug>.json
 *
 * Paths below mirror web-app/dataPaths.ts — keep them in sync if folders move.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const ANNOTATOR = (() => {
  const i = process.argv.indexOf('--annotator');
  if (i < 0 || !process.argv[i + 1]) {
    console.error('error: --annotator <id> is required');
    process.exit(2);
  }
  return process.argv[i + 1];
})();

const GOLD_DIR     = path.join(ROOT, 'data/annotations/gold', ANNOTATOR);
const ANALYSIS_DIR = path.join(ROOT, 'data/algorithm-outputs/analysis');
const CLUSTERS_DIR = path.join(ROOT, 'data/algorithm-outputs/algo-clusters');

// Parse --tolerance flag (default 2.0)
const toleranceArg = process.argv.indexOf('--tolerance');
const TOLERANCE = toleranceArg >= 0 ? parseFloat(process.argv[toleranceArg + 1]) : 2.0;

// MSAF file → algo id mapping
const MSAF_FILES = [
  { file: 'sf.json',    id: 'msaf-sf'    },
  { file: 'foote.json', id: 'msaf-foote' },
  { file: 'cnmf.json',  id: 'msaf-cnmf'  },
  { file: 'olda.json',  id: 'msaf-olda'  },
];

// ── Centroid-linkage clustering (mirrors algoClustering.ts) ──────────────────

function computeAlgoClusters(rows, toleranceSec) {
  const msafIds = new Set(['msaf-sf', 'msaf-foote', 'msaf-cnmf', 'msaf-olda']);
  const msafRows = rows.filter((r) => msafIds.has(r.id));
  if (!msafRows.length) return [];

  const allPoints = msafRows.flatMap((row) =>
    row.sections.map((s) => ({ algoId: row.id, group: row.id, time: s.time })),
  );
  if (!allPoints.length) return [];

  const sorted = [...allPoints].sort((a, b) => a.time - b.time);
  const clusters = [];

  for (const pt of sorted) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let k = clusters.length - 1; k >= 0; k--) {
      const centroid = clusters[k].sum / clusters[k].count;
      if (pt.time - centroid > toleranceSec) break;
      const dist = Math.abs(pt.time - centroid);
      if (dist <= toleranceSec && dist < bestDist) {
        bestDist = dist;
        bestIdx = k;
      }
    }
    if (bestIdx >= 0) {
      clusters[bestIdx].members.push(pt);
      clusters[bestIdx].sum   += pt.time;
      clusters[bestIdx].count += 1;
    } else {
      clusters.push({ sum: pt.time, count: 1, members: [pt] });
    }
  }

  return clusters.map(({ members }, id) => {
    const meanTime = members.reduce((s, m) => s + m.time, 0) / members.length;
    const groupSet = new Set(members.map((m) => m.group));
    const groups   = [...groupSet];
    return {
      id,
      meanTime,
      sources:   members.map((m) => ({ algoId: m.algoId, group: m.group, time: m.time })),
      groups,
      numGroups: groups.length,
    };
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

if (!fs.existsSync(CLUSTERS_DIR)) fs.mkdirSync(CLUSTERS_DIR, { recursive: true });

const goldFiles = fs.readdirSync(GOLD_DIR).filter((f) => f.endsWith('.json'));
const reviewed  = goldFiles
  .map((f) => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(GOLD_DIR, f), 'utf-8'));
      return data.reviewed ? f.slice(0, -5) : null;
    } catch { return null; }
  })
  .filter(Boolean);

console.log(`Found ${reviewed.length} reviewed songs. Running clustering at τ=${TOLERANCE}s…\n`);

let saved = 0, skipped = 0, errors = 0;

for (const slug of reviewed) {
  const analysisDir = path.join(ANALYSIS_DIR, slug);
  if (!fs.existsSync(analysisDir)) {
    console.log(`  SKIP  ${slug}  (no analysis folder)`);
    skipped++;
    continue;
  }

  const rows = [];
  for (const { file, id } of MSAF_FILES) {
    const fp = path.join(analysisDir, file);
    if (!fs.existsSync(fp)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      rows.push({ id, sections: (data.sections ?? []).map((s) => ({ time: s.time })) });
    } catch (e) {
      console.warn(`  WARN  ${slug}/${file}: ${e.message}`);
    }
  }

  if (!rows.length) {
    console.log(`  SKIP  ${slug}  (no MSAF files found)`);
    skipped++;
    continue;
  }

  const clusters = computeAlgoClusters(rows, TOLERANCE);
  const result = {
    slug,
    generatedAt: new Date().toISOString(),
    tolerance:   TOLERANCE,
    totalAlgos:  rows.length,
    clusters,
  };

  const outPath = path.join(CLUSTERS_DIR, `${slug}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf-8');

  const filtered3 = clusters.filter((c) => c.numGroups >= 3).length;
  const filtered4 = clusters.filter((c) => c.numGroups === 4).length;
  console.log(`  OK    ${slug}  (${rows.length}/4 algos · ${clusters.length} clusters · ≥3: ${filtered3} · 4/4: ${filtered4})`);
  saved++;
}

console.log(`\nDone. Saved: ${saved}  Skipped: ${skipped}  Errors: ${errors}`);
