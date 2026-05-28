/**
 * Genre presets — single source of truth for both the "Section vocabulary" picker
 * (multi-select, in Settings) and the "⚡ Fill default" bar layout (single-select).
 *
 * Each preset bundles:
 *   - `vocabulary` — the section names exposed in Manual/Eye dropdowns
 *   - `layout` — the bar layout the ⚡ Fill default button applies
 *
 * Invariant: every type used in `layout` must appear in the same preset's `vocabulary`,
 * so picking a genre for fill-default never inserts a section type the user can't edit.
 */

export interface BarEntry { type: string; bars: number }

export interface GenrePreset {
  readonly name: string;
  readonly description: string;
  readonly vocabulary: readonly string[];
  readonly layout: readonly BarEntry[];
}

const CANONICAL_VOCAB: readonly string[] =
  ['intro', 'buildup', 'drop', 'breakdown', 'bridge', 'outro', 'silence'];

export const GENRE_PRESETS = {
  edm: {
    name: 'EDM / Club',
    description: 'Intro → buildup → drop → breakdown phrases (120–128 BPM, 16-bar drops).',
    vocabulary: CANONICAL_VOCAB,
    layout: [
      { type: 'intro', bars: 16 },
      { type: 'buildup', bars: 8 },
      { type: 'drop', bars: 16 },
      { type: 'breakdown', bars: 16 },
      { type: 'buildup', bars: 8 },
      { type: 'drop', bars: 16 },
      { type: 'outro', bars: 16 },
    ],
  },
  pop: {
    name: 'Pop / Vocal-led',
    description: 'Verse → pre-chorus → chorus with a late bridge (90–120 BPM).',
    vocabulary: ['intro', 'verse', 'prechorus', 'chorus', 'bridge', 'outro', 'silence'],
    layout: [
      { type: 'intro', bars: 4 },
      { type: 'verse', bars: 16 },
      { type: 'prechorus', bars: 8 },
      { type: 'chorus', bars: 16 },
      { type: 'verse', bars: 16 },
      { type: 'prechorus', bars: 8 },
      { type: 'chorus', bars: 16 },
      { type: 'bridge', bars: 8 },
      { type: 'chorus', bars: 16 },
      { type: 'outro', bars: 4 },
    ],
  },
  house: {
    name: 'House / Progressive',
    description: 'Deep / Tech / Progressive — long DJ-friendly intros & outros, 32-bar phrases (120–128 BPM).',
    vocabulary: CANONICAL_VOCAB,
    layout: [
      { type: 'intro', bars: 32 },
      { type: 'breakdown', bars: 24 },
      { type: 'buildup', bars: 16 },
      { type: 'drop', bars: 32 },
      { type: 'breakdown', bars: 24 },
      { type: 'buildup', bars: 16 },
      { type: 'drop', bars: 32 },
      { type: 'outro', bars: 32 },
    ],
  },
  techno: {
    name: 'Techno / Minimal',
    description: 'Linear, evolving — long grooves and breaks instead of buildups (125–135 BPM).',
    vocabulary: ['intro', 'groove', 'breakdown', 'drop', 'outro', 'silence'],
    layout: [
      { type: 'intro', bars: 32 },
      { type: 'groove', bars: 32 },
      { type: 'breakdown', bars: 24 },
      { type: 'drop', bars: 48 },
      { type: 'groove', bars: 32 },
      { type: 'breakdown', bars: 24 },
      { type: 'drop', bars: 48 },
      { type: 'outro', bars: 32 },
    ],
  },
  mainstage: {
    name: 'Mainstage / Big Room',
    description: 'Festival EDM — fast tension/release, short builds, 16-bar drops (126–130 BPM).',
    vocabulary: CANONICAL_VOCAB,
    layout: [
      { type: 'intro', bars: 16 },
      { type: 'breakdown', bars: 16 },
      { type: 'buildup', bars: 8 },
      { type: 'drop', bars: 16 },
      { type: 'breakdown', bars: 16 },
      { type: 'buildup', bars: 8 },
      { type: 'drop', bars: 24 },
      { type: 'outro', bars: 16 },
    ],
  },
  bass: {
    name: 'Bass / Dubstep / Trap',
    description: 'Half-time, explosive — standardized 16-bar phrases (140–150 BPM).',
    vocabulary: CANONICAL_VOCAB,
    layout: [
      { type: 'intro', bars: 16 },
      { type: 'breakdown', bars: 16 },
      { type: 'buildup', bars: 8 },
      { type: 'drop', bars: 16 },
      { type: 'breakdown', bars: 16 },
      { type: 'buildup', bars: 8 },
      { type: 'drop', bars: 16 },
      { type: 'outro', bars: 16 },
    ],
  },
  dnb: {
    name: 'Drum & Bass',
    description: 'Fast — larger bar counts to match standard time lengths (170–175 BPM).',
    vocabulary: ['intro', 'breakdown', 'buildup', 'drop', 'outro', 'silence'],
    layout: [
      { type: 'intro', bars: 32 },
      { type: 'breakdown', bars: 24 },
      { type: 'buildup', bars: 16 },
      { type: 'drop', bars: 48 },
      { type: 'breakdown', bars: 24 },
      { type: 'buildup', bars: 16 },
      { type: 'drop', bars: 48 },
      { type: 'outro', bars: 32 },
    ],
  },
} as const satisfies Record<string, GenrePreset>;

export type GenrePresetKey = keyof typeof GENRE_PRESETS;

/** Union of vocabularies for the given genres, de-duplicated, preserving first-seen order. */
export function unionVocabulary(keys: readonly GenrePresetKey[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of keys) {
    for (const word of GENRE_PRESETS[key].vocabulary) {
      const lc = word.toLowerCase();
      if (seen.has(lc)) continue;
      seen.add(lc);
      out.push(lc);
    }
  }
  return out;
}
