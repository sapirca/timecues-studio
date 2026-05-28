#!/usr/bin/env node
// Pull source-of-truth markdown from /docs and /DATA.md into the Starlight
// content folder, injecting Starlight frontmatter and rewriting cross-doc
// links. Idempotent — safe to run on every dev/build.
//
// The generated files are gitignored. Edit the originals in /docs.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Default: repo is two dirs up from this script
// (landing/scripts/ → landing/ → repo root).
// In Docker builds we copy only docs/ + DATA.md into /repo and set
// LANDING_REPO_ROOT=/repo so the script reads from there instead.
const repoRoot = process.env.LANDING_REPO_ROOT
  ? resolve(process.env.LANDING_REPO_ROOT)
  : resolve(here, '..', '..');
const outDir = resolve(here, '..', 'src', 'content', 'docs', 'timecues');

mkdirSync(outDir, { recursive: true });

/** @type {Array<{src: string, out: string, title: string, description: string}>} */
const docs = [
  {
    src: 'docs/USER_GUIDE.md',
    out: 'user-guide.md',
    title: 'User guide',
    description:
      'The definitive reference for the TimeCues web app — workspaces, panels, shortcuts, settings, file formats, REST API.',
  },
  {
    src: 'DATA.md',
    out: 'data-model.md',
    title: 'Data model',
    description:
      'How TimeCues lays out audio, annotations, and algorithm caches on disk. Multi-annotator scheme and per-folder file formats.',
  },
  {
    src: 'docs/EXPERIMENTAL_USER_GUIDE.md',
    out: 'experimental.md',
    title: 'Experimental models',
    description:
      'Opt-in detectors behind per-family feature flags. May break without notice.',
  },
];

// Map of original markdown link targets → Starlight-relative routes.
const linkRewrites = new Map([
  ['docs/USER_GUIDE.md', '/timecues/user-guide/'],
  ['USER_GUIDE.md', '/timecues/user-guide/'],
  ['docs/EXPERIMENTAL_USER_GUIDE.md', '/timecues/experimental/'],
  ['EXPERIMENTAL_USER_GUIDE.md', '/timecues/experimental/'],
  ['DATA.md', '/timecues/data-model/'],
  ['../DATA.md', '/timecues/data-model/'],
]);

function escapeFrontmatter(s) {
  return s.replace(/"/g, '\\"');
}

function rewriteLinks(md) {
  // Rewrite markdown links of the form [text](target#anchor) when the target
  // (sans anchor) matches a known doc.
  return md.replace(/\]\(([^)]+)\)/g, (whole, target) => {
    const [path, anchor] = target.split('#');
    if (linkRewrites.has(path)) {
      const route = linkRewrites.get(path);
      return `](${anchor ? `${route}#${anchor}` : route})`;
    }
    return whole;
  });
}

function stripFirstH1(md) {
  // Starlight renders the frontmatter title as the H1. Drop the markdown's
  // first H1 so we don't get a duplicate heading.
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('# ')) {
      lines.splice(i, 1);
      // Also drop a single blank line that may follow.
      if (lines[i] === '') lines.splice(i, 1);
      break;
    }
  }
  return lines.join('\n');
}

// Copy docs/images/ alongside the synced markdown so relative refs like
// ![](images/foo.png) in USER_GUIDE.md resolve from src/content/docs/timecues/.
const imagesSrc = resolve(repoRoot, 'docs', 'images');
const imagesOut = resolve(outDir, 'images');
if (existsSync(imagesSrc)) {
  cpSync(imagesSrc, imagesOut, { recursive: true });
  console.log(`sync-docs: docs/images/ → ${imagesOut}`);
}

for (const doc of docs) {
  const srcPath = resolve(repoRoot, doc.src);
  let body;
  try {
    body = readFileSync(srcPath, 'utf8');
  } catch (err) {
    console.error(`sync-docs: cannot read ${srcPath}: ${err.message}`);
    process.exitCode = 1;
    continue;
  }
  body = stripFirstH1(body);
  body = rewriteLinks(body);
  const frontmatter = [
    '---',
    `title: "${escapeFrontmatter(doc.title)}"`,
    `description: "${escapeFrontmatter(doc.description)}"`,
    'editUrl: false',
    '---',
    '',
  ].join('\n');
  const outPath = resolve(outDir, doc.out);
  writeFileSync(outPath, frontmatter + body);
  console.log(`sync-docs: ${doc.src} → ${doc.out}`);
}
