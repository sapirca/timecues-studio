// Headless capture of paper figures in light theme.
//
// Usage:
//   npm run capture-figures               # capture all known shots
//   npm run capture-figures -- landing    # capture just one
//   npm run capture-figures -- landing custom
//
// Assumes a dev server is reachable. Override with BASE_URL=http://host:port.
// Outputs to ../paper/figures/. Each shot can be tuned via the SHOTS table
// below — add `prep` steps (clicks, waits) before the screenshot fires.

import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const VIEWPORT = { width: 1440, height: 900 };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../../paper/figures');

const SETTINGS_KEY = 'timecues.settings.v1';
const ANNOTATOR_KEY = 'annotator';

// App requires an annotator before rendering. Pre-seed one so the LoginScreen
// is bypassed. Override with ANNOTATOR_ID/ANNOTATOR_NAME env vars.
const ANNOTATOR = {
  id: process.env.ANNOTATOR_ID ?? 'screenshot-capture',
  displayName: process.env.ANNOTATOR_NAME ?? 'Screenshot Capture',
  authMethod: 'username',
  createdAt: new Date().toISOString(),
};

// Each shot: { name, file, route, prep?, fullPage? }.
// `prep(page)` runs after navigation, before screenshot — use it to dismiss
// modals, click into views, wait for selectors, etc.
const SHOTS = {
  landing: {
    file: 'landing-five-modes.png',
    route: '/',
    prep: async (page) => {
      await page.getByText('Select a workspace', { exact: false }).waitFor();
    },
  },

  custom: {
    file: 'custom-detectors.png',
    route: '/custom',
    prep: async (page) => {
      // CustomScriptsPage renders the editor + script list. Open the
      // CodeMirror editor on an existing detector so the screenshot
      // shows the in-browser Python editor in Edit mode.
      await page.waitForLoadState('networkidle');
      // Wait for the registry list to populate, then click the first
      // row's Edit button — example_energy is always at the top.
      await page.locator('code', { hasText: 'example_energy' }).first().waitFor();
      await page.getByRole('button', { name: /^Edit$/ }).first().click();
      await page.locator('.cm-editor').first().waitFor({ state: 'visible' });
      // CodeMirror paints syntax highlighting on a microtask — give it
      // a frame before snapping.
      await page.waitForTimeout(500);
    },
  },

  'studio-overview': {
    file: 'studio-overview.jpeg',
    route: '/',
    prep: async (page) => {
      await page.getByText('Select a workspace', { exact: false }).waitFor();
      await page.getByText('Annotation Tool', { exact: true }).click();
      await waitForSongLoaded(page);
    },
  },

  'studio-evaluation': {
    file: 'studio-evaluation.png',
    route: '/',
    prep: async (page) => {
      await page.getByText('Select a workspace', { exact: false }).waitFor();
      await page.getByRole('button', { name: /^Algorithm Inspect/ }).click();
      await waitForSongLoaded(page);
    },
  },

  '3band': {
    file: '3band_screenshot.png',
    route: '/',
    prep: async (page) => {
      await page.getByText('Select a workspace', { exact: false }).waitFor();
      await page.getByText('Annotation Tool', { exact: true }).click();
      await waitForSongLoaded(page);
    },
  },

  'studio-viz': {
    file: 'studio-viz.png',
    route: '/',
    prep: async (page) => {
      await page.getByText('Select a workspace', { exact: false }).waitFor();
      await page.getByText('Annotation Tool', { exact: true }).click();
      await waitForSongLoaded(page);
    },
    fullPage: true,
  },

  'section-card-active': {
    file: 'section-card-active.png',
    route: '/',
    prep: async (page) => {
      await page.getByText('Select a workspace', { exact: false }).waitFor();
      await page.getByText('Annotation Tool', { exact: true }).click();
      await waitForSongLoaded(page);
    },
  },

  'evaluation-tab': {
    file: 'evaluation-tab.png',
    route: '/',
    prep: async (page) => {
      await page.getByText('Select a workspace', { exact: false }).waitFor();
      await page.getByRole('button', { name: /^Algorithm Inspect/ }).click();
      await waitForSongLoaded(page);
    },
  },
};

// The app auto-selects the first song on mount, fetches its audio + analysis
// JSON, decodes, then renders waveform/spectrogram canvases. Wait for the
// signal that all of that is on screen rather than guessing with a sleep.
async function waitForSongLoaded(page) {
  await page.waitForLoadState('networkidle');
  // WaveSurfer mounts a <canvas> once decoding is done. Multiple canvases
  // (waveform, spectrogram, overview) confirm full render.
  await page.waitForFunction(
    () => document.querySelectorAll('canvas').length >= 2,
    null,
    { timeout: 60_000 },
  );
  // Small settle for the last paint (spectrogram fills progressively).
  await page.waitForTimeout(1500);
}

async function capture(browser, name, shot) {
  const file = path.join(OUT_DIR, shot.file);
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2, // retina-quality PNGs for print
  });

  // Prime light theme + an annotator before the app boots so first paint is
  // already light and the LoginScreen is bypassed.
  await ctx.addInitScript(({ settingsKey, annotatorKey, annotator }) => {
    const existing = (() => {
      try { return JSON.parse(localStorage.getItem(settingsKey) ?? '{}'); }
      catch { return {}; }
    })();
    localStorage.setItem(settingsKey, JSON.stringify({ ...existing, theme: 'light' }));
    localStorage.setItem(annotatorKey, JSON.stringify(annotator));
  }, { settingsKey: SETTINGS_KEY, annotatorKey: ANNOTATOR_KEY, annotator: ANNOTATOR });

  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`  [${name}] page error:`, e.message));

  await page.goto(`${BASE_URL}${shot.route}`, { waitUntil: 'domcontentloaded' });
  if (shot.prep) await shot.prep(page);

  // Final paint settle before snapshot.
  await page.waitForTimeout(200);
  await page.screenshot({ path: file, fullPage: shot.fullPage ?? false });
  console.log(`  ✓ ${name} → ${path.relative(process.cwd(), file)}`);

  await ctx.close();
}

async function main() {
  const requested = process.argv.slice(2);
  const names = requested.length > 0 ? requested : Object.keys(SHOTS);

  for (const n of names) {
    if (!SHOTS[n]) {
      console.error(`unknown shot "${n}". Known: ${Object.keys(SHOTS).join(', ')}`);
      process.exit(2);
    }
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // Reachability check — fail loud rather than block on a 30s nav timeout.
  try {
    const r = await fetch(BASE_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    console.error(`Dev server unreachable at ${BASE_URL}: ${e.message}`);
    console.error('Run `npm run dev` in another shell, or set BASE_URL.');
    process.exit(1);
  }

  console.log(`Capturing ${names.length} shot(s) to ${OUT_DIR}`);
  const browser = await chromium.launch();
  try {
    for (const n of names) await capture(browser, n, SHOTS[n]);
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
