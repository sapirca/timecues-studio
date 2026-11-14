/**
 * A layer that is passed to the canvas is not thereby DRAWN. SharedVizPanel
 * walks `rowOrder` and renders what it finds there, so a layer with no row id
 * is filtered, found visible, handed over — and silently skipped. That is a
 * failure with no error and no empty state: the detector appears in the
 * Detectors sidebar, its checkbox is ticked, and the canvas is simply blank.
 *
 * InspectorPageV2 keeps five near-identical effects that seed those row ids,
 * one per layer family. Four of them included the detector-sourced layers and
 * the fifth did not — riff patterns had no detector source when it was written
 * ("user-only — no detector source", it said so), and gained one later without
 * the effect being revisited. So this pins the invariant the copies share
 * rather than any one copy: every family that has a `detector*Layers` memo
 * seeds rows from it.
 *
 * The page is 14k lines of hooks over AudioContext, fetch and layer storage —
 * mounting it would test the stubs (see InspectorPageV2.test.tsx). Reading the
 * source is the coarse check that still catches the real mistake.
 *
 * The second block below guards the same class of omission for a different
 * field, for the same reason: five near-identical memos, and a family that
 * forgets one of them fails silently.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Not `import.meta.url` — the jsdom environment rewrites it to an http URL.
// Vitest runs with web-app/ as the cwd (see vitest.config.ts).
const SOURCE = readFileSync(
  resolve(process.cwd(), 'src/pages/InspectorPageV2.tsx'),
  'utf-8',
);

/** Row-id prefix → the memo holding that family's detector-sourced layers. */
const FAMILIES: Array<[prefix: string, memo: string]> = [
  ['cue-layer:', 'detectorCueLayers'],
  ['loop-layer:', 'detectorLoopLayers'],
  ['span-layer:', 'detectorSpanLayers'],
  ['riff-layer:', 'detectorRiffLayers'],
  ['lyrics-layer:', 'detectorLyricsLayers'],
];

describe('detector layers seed viz rows', () => {
  it.each(FAMILIES)('%s rows are seeded from %s', (prefix, memo) => {
    expect(SOURCE).toContain('...' + memo + '.map((l) => `' + prefix + '${l.id}`)');
  });

  it.each(FAMILIES)('%s sync re-runs when %s changes', (prefix, memo) => {
    // Seeding from the memo is not enough — an effect that does not depend on
    // it keeps the stale row set when a detector result arrives later, which
    // it always does: results are fetched per song, long after mount.
    const seed = SOURCE.indexOf('...' + memo + '.map((l) => `' + prefix + '${l.id}`)');
    expect(seed).toBeGreaterThan(-1);
    const deps = /\}, \[([^\]]*)\]\);/.exec(SOURCE.slice(seed));
    expect(deps).not.toBeNull();
    expect(deps![1]).toContain(memo);
  });
});

/**
 * A detector's caveats about its own run reach the lane through `sourceNotes`.
 * A family that builds its layers without it drops them on the floor — and the
 * lane then positively asserts there was nothing to say, which is worse than
 * saying nothing: an unreliable groove renders identically to a clean one.
 *
 * Every family's lane is built in inspector-v2/detectorLayers.ts, and all of
 * them take their source fields from one helper there; the page's memos only
 * pick the colour and call the builder. So this pins both halves: the helper
 * carries the notes, every family's builder goes through the helper, and every
 * memo calls its builder.
 */
const LAYERS_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/components/inspector-v2/detectorLayers.ts'),
  'utf-8',
);

/** Memo → the builder it must call. */
const BUILDERS: Record<string, string> = {
  detectorCueLayers: 'detectorCueLayer',
  detectorLoopLayers: 'detectorLoopLayer',
  // The whole lane; the canvas's detectorSpanLayers cuts it by part.
  detectorSpanLayersWhole: 'detectorSpanLayer',
  detectorRiffLayers: 'detectorRiffLayer',
  detectorLyricsLayers: 'detectorLyricsLayer',
};

describe('detector layers carry their run notes', () => {
  it('the shared source fields include the notes', () => {
    const helper = LAYERS_SOURCE.slice(LAYERS_SOURCE.indexOf('function laneSource('));
    expect(helper.slice(0, helper.indexOf('\n}\n'))).toContain('sourceNotes:');
  });

  it.each(Object.values(BUILDERS))('%s builds from the shared source fields', (builder) => {
    const start = LAYERS_SOURCE.indexOf(`export function ${builder}(`);
    expect(start).toBeGreaterThan(-1);
    const body = LAYERS_SOURCE.slice(start, LAYERS_SOURCE.indexOf('\n}\n', start));
    expect(body).toContain('laneSource(d, env)');
  });

  it.each(Object.entries(BUILDERS))('%s is built by %s', (memo, builder) => {
    const start = SOURCE.indexOf(`const ${memo} = useMemo`);
    expect(start).toBeGreaterThan(-1);
    const body = SOURCE.slice(start, SOURCE.indexOf('\n  }, [', start));
    // `laneResults` is customResults with every `lanes` detector expanded to
    // one single-kind entry per lane (expandDetectorLanes) — the same runs.
    expect(body).toContain(`${builder}(d, laneResults[d.name]`);
  });

  it('passes undefined rather than an empty array when there is nothing to say', () => {
    // An empty array is truthy in JS, so a lane with no caveats would light up
    // its ⚠ and open a popover listing none.
    expect(LAYERS_SOURCE).toContain('(env.notes && env.notes.length) ? env.notes : undefined');
  });
});
