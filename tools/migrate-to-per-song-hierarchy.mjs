#!/usr/bin/env node
/**
 * Migrate from per-type structure to per-song structure.
 *
 * OLD:
 *   data/
 *   ├── songs/<slug>/<slug>.mp3
 *   ├── song-info/<annotator>/<slug>.json
 *   ├── stems/<slug>/...
 *   ├── annotations/
 *   │   ├── manual/<annotator>/<slug>.json
 *   │   ├── eye/<annotator>/<slug>.json
 *   │   ├── auto-guess/<annotator>/<slug>.json
 *   │   └── layers/<annotator>/<slug>.json
 *   └── algorithm-outputs/
 *       ├── algo-clusters/<slug>.json
 *       ├── bpm-detections/<slug>.json
 *       ├── msaf/<slug>/...
 *       └── custom/<script>/<slug>.json
 *
 * NEW:
 *   data/songs/
 *   └── <slug>/
 *       ├── audio/
 *       │   └── <slug>.mp3
 *       ├── song-info/
 *       │   └── <annotator>/<slug>.json (or flat <annotator>.json)
 *       ├── stems/
 *       │   └── (demix files)
 *       ├── annotations/
 *       │   ├── manual/
 *       │   │   └── <annotator>/<slug>.json
 *       │   ├── eye/
 *       │   │   └── <annotator>/<slug>.json
 *       │   ├── auto-guess/
 *       │   │   └── <annotator>/<slug>.json
 *       │   └── layers/
 *       │       └── <annotator>/<slug>.json
 *       └── analysis/
 *           ├── algo-clusters.json
 *           ├── bpm-detections.json
 *           ├── msaf/...
 *           └── custom/...
 *
 * Usage:
 *   node tools/migrate-to-per-song-hierarchy.mjs              # dry run
 *   node tools/migrate-to-per-song-hierarchy.mjs --apply      # execute
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const APPLY = process.argv.includes('--apply');

// Helper functions
function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return null;
    }
}

function writeJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function copyFile(src, dst) {
    ensureDir(path.dirname(dst));
    fs.copyFileSync(src, dst);
}

function copyDirRecursive(src, dst) {
    if (!fs.existsSync(src)) return;
    ensureDir(dst);
    for (const item of fs.readdirSync(src)) {
        const srcPath = path.join(src, item);
        const dstPath = path.join(dst, item);
        const stat = fs.statSync(srcPath);
        if (stat.isDirectory()) {
            copyDirRecursive(srcPath, dstPath);
        } else {
            copyFile(srcPath, dstPath);
        }
    }
}

function getAllSlugs() {
    const slugs = new Set();

    // Get slugs from songs/
    const songsDir = path.join(DATA_DIR, 'songs');
    if (fs.existsSync(songsDir)) {
        for (const item of fs.readdirSync(songsDir)) {
            const itemPath = path.join(songsDir, item);
            if (fs.statSync(itemPath).isDirectory()) {
                slugs.add(item);
            }
        }
    }

    // Get slugs from song-info/
    const songInfoDir = path.join(DATA_DIR, 'song-info');
    if (fs.existsSync(songInfoDir)) {
        for (const annotator of fs.readdirSync(songInfoDir)) {
            const annotatorPath = path.join(songInfoDir, annotator);
            if (fs.statSync(annotatorPath).isDirectory()) {
                for (const file of fs.readdirSync(annotatorPath)) {
                    if (file.endsWith('.json')) {
                        slugs.add(file.replace('.json', ''));
                    }
                }
            }
        }
    }

    // Get slugs from annotations/
    const annotationsDir = path.join(DATA_DIR, 'annotations');
    if (fs.existsSync(annotationsDir)) {
        for (const type of fs.readdirSync(annotationsDir)) {
            const typeDir = path.join(annotationsDir, type);
            if (!fs.statSync(typeDir).isDirectory()) continue;
            for (const annotator of fs.readdirSync(typeDir)) {
                const annotatorPath = path.join(typeDir, annotator);
                if (fs.statSync(annotatorPath).isDirectory()) {
                    for (const file of fs.readdirSync(annotatorPath)) {
                        if (file.endsWith('.json')) {
                            slugs.add(file.replace('.json', ''));
                        }
                    }
                }
            }
        }
    }

    // Get slugs from algorithm-outputs/
    const algoOutputsDir = path.join(DATA_DIR, 'algorithm-outputs');
    if (fs.existsSync(algoOutputsDir)) {
        for (const item of fs.readdirSync(algoOutputsDir)) {
            const itemPath = path.join(algoOutputsDir, item);
            if (!fs.statSync(itemPath).isDirectory()) continue;

            if (item === 'algo-clusters' || item === 'bpm-detections' || item === 'mir-features') {
                // Flat structure: <type>/<slug>.json
                for (const file of fs.readdirSync(itemPath)) {
                    if (file.endsWith('.json')) {
                        slugs.add(file.replace('.json', ''));
                    }
                }
            } else if (item === 'msaf' || item === 'custom') {
                // Per-slug or per-script structure
                for (const subitem of fs.readdirSync(itemPath)) {
                    const subPath = path.join(itemPath, subitem);
                    if (fs.statSync(subPath).isDirectory()) {
                        slugs.add(subitem);
                    }
                }
            }
        }
    }

    // Get slugs from stems/
    const stemsDir = path.join(DATA_DIR, 'stems');
    if (fs.existsSync(stemsDir)) {
        for (const item of fs.readdirSync(stemsDir)) {
            const itemPath = path.join(stemsDir, item);
            if (fs.statSync(itemPath).isDirectory()) {
                slugs.add(item);
            }
        }
    }

    return Array.from(slugs).sort();
}

function migrateSlug(slug) {
    const oldSongsDir = path.join(DATA_DIR, 'songs', slug);
    const oldSongInfoDir = path.join(DATA_DIR, 'song-info');
    const oldAnnotationsDir = path.join(DATA_DIR, 'annotations');
    const oldAlgoOutputsDir = path.join(DATA_DIR, 'algorithm-outputs');
    const oldStemsDir = path.join(DATA_DIR, 'stems', slug);

    const newSongDir = path.join(DATA_DIR, 'songs', slug);
    const newAudioDir = path.join(newSongDir, 'audio');
    const newSongInfoDir = path.join(newSongDir, 'song-info');
    const newAnnotationsDir = path.join(newSongDir, 'annotations');
    const newAnalysisDir = path.join(newSongDir, 'analysis');
    const newStemsDir = path.join(newSongDir, 'stems');

    const operations = [];

    // 1. Audio files (songs/<slug>/*.mp3, *.wav, etc.)
    if (fs.existsSync(oldSongsDir)) {
        for (const file of fs.readdirSync(oldSongsDir)) {
            if (file.match(/\.(mp3|wav|flac|ogg|m4a)$/i)) {
                operations.push({
                    type: 'copy-file',
                    src: path.join(oldSongsDir, file),
                    dst: path.join(newAudioDir, file),
                    desc: `Audio: ${file}`,
                });
            }
        }
    }

    // 2. Song info (song-info/<annotator>/<slug>.json)
    if (fs.existsSync(oldSongInfoDir)) {
        for (const annotator of fs.readdirSync(oldSongInfoDir).filter(d =>
            fs.statSync(path.join(oldSongInfoDir, d)).isDirectory()
        )) {
            const oldFile = path.join(oldSongInfoDir, annotator, `${slug}.json`);
            if (fs.existsSync(oldFile)) {
                const newFile = path.join(newSongInfoDir, `${annotator}.json`);
                operations.push({
                    type: 'copy-file',
                    src: oldFile,
                    dst: newFile,
                    desc: `Song info: ${annotator}/${slug}.json → ${annotator}.json`,
                });
            }
        }
    }

    // 3. Annotations (manual, eye, auto-guess, layers)
    if (fs.existsSync(oldAnnotationsDir)) {
        const annotationTypes = ['manual', 'eye', 'auto-guess', 'layers'];
        for (const type of annotationTypes) {
            const oldTypeDir = path.join(oldAnnotationsDir, type);
            if (!fs.existsSync(oldTypeDir)) continue;

            for (const annotator of fs.readdirSync(oldTypeDir).filter(d =>
                fs.statSync(path.join(oldTypeDir, d)).isDirectory()
            )) {
                const oldFile = path.join(oldTypeDir, annotator, `${slug}.json`);
                if (fs.existsSync(oldFile)) {
                    const newFile = path.join(newAnnotationsDir, type, annotator, `${slug}.json`);
                    operations.push({
                        type: 'copy-file',
                        src: oldFile,
                        dst: newFile,
                        desc: `Annotation: ${type}/${annotator}/${slug}.json`,
                    });
                }
            }
        }
    }

    // 4. Algorithm outputs
    if (fs.existsSync(oldAlgoOutputsDir)) {
        const algoTypes = ['algo-clusters', 'bpm-detections', 'mir-features'];
        for (const type of algoTypes) {
            const oldFile = path.join(oldAlgoOutputsDir, type, `${slug}.json`);
            if (fs.existsSync(oldFile)) {
                const newFile = path.join(newAnalysisDir, type, `${slug}.json`);
                operations.push({
                    type: 'copy-file',
                    src: oldFile,
                    dst: newFile,
                    desc: `Analysis: ${type}/${slug}.json`,
                });
            }
        }

        // 5. MSAF outputs (per-slug directory)
        const oldMsafDir = path.join(oldAlgoOutputsDir, 'msaf', slug);
        if (fs.existsSync(oldMsafDir)) {
            operations.push({
                type: 'copy-dir',
                src: oldMsafDir,
                dst: path.join(newAnalysisDir, 'msaf'),
                desc: `MSAF analysis: msaf/${slug}/`,
            });
        }

        // 6. Custom results (per-script structure)
        const oldCustomDir = path.join(oldAlgoOutputsDir, 'custom');
        if (fs.existsSync(oldCustomDir)) {
            for (const script of fs.readdirSync(oldCustomDir)) {
                const scriptPath = path.join(oldCustomDir, script);
                if (!fs.statSync(scriptPath).isDirectory()) continue;

                const oldScriptSlugFile = path.join(scriptPath, `${slug}.json`);
                if (fs.existsSync(oldScriptSlugFile)) {
                    const newFile = path.join(newAnalysisDir, 'custom', script, `${slug}.json`);
                    operations.push({
                        type: 'copy-file',
                        src: oldScriptSlugFile,
                        dst: newFile,
                        desc: `Custom: ${script}/${slug}.json`,
                    });
                }
            }
        }
    }

    // 7. Stems (stems/<slug>/...)
    if (fs.existsSync(oldStemsDir)) {
        operations.push({
            type: 'copy-dir',
            src: oldStemsDir,
            dst: newStemsDir,
            desc: `Stems: ${slug}/`,
        });
    }

    return operations;
}

function main() {
    console.log('Migration: per-type structure → per-song structure\n');
    console.log('This will reorganize ALL data under data/songs/<slug>/ subdirectories.\n');

    const slugs = getAllSlugs();
    console.log(`Found ${slugs.length} song(s):\n`);

    let totalOps = 0;

    for (const slug of slugs) {
        const ops = migrateSlug(slug);
        if (ops.length > 0) {
            console.log(`  📁 ${slug}/`);
            for (const op of ops) {
                console.log(`     → ${op.desc}`);
            }
            console.log('');
            totalOps += ops.length;

            if (APPLY) {
                for (const op of ops) {
                    if (op.type === 'copy-file') {
                        copyFile(op.src, op.dst);
                    } else if (op.type === 'copy-dir') {
                        copyDirRecursive(op.src, op.dst);
                    }
                }
            }
        }
    }

    console.log('='.repeat(50));
    console.log(`Total: ${totalOps} operation(s) to perform`);

    if (!APPLY) {
        console.log('\n✓ Dry run complete. Re-run with --apply to execute migration.');
        console.log('\n⚠️  After migration, update path constants in:');
        console.log('   - web-app/dataPaths.ts');
        console.log('   - tools/python/paths.py');
        console.log('   - web-app/vite.config.ts (plugin paths)');
    } else {
        console.log('\n✓ Migration complete! All files moved to per-song structure.');
        console.log('\n⚠️  Next steps:');
        console.log('   1. Update path constants in web-app/dataPaths.ts');
        console.log('   2. Update path constants in tools/python/paths.py');
        console.log('   3. Update plugin paths in web-app/vite.config.ts');
        console.log('   4. Delete old directories: songs/, song-info/, stems/, annotations/, algorithm-outputs/');
    }
}

main();
