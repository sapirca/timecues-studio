import type { SectionBlock } from '../../types/sectionBlock';
/* UNRESOLVED: ManualAnnotation */

/** Sentinel type for "filler" boundaries auto-inserted around a selection.
 *  Renders transparently on the timeline strip and shows as "—" in the
 *  section card. Always recognised by `normalizeSectionType` and always
 *  present in `getSectionTypes`, regardless of the user's vocabulary, so
 *  filler sections survive round-trips and remain selectable in dropdowns. */
export const UNSET_TYPE = 'unset';

export const SECTION_TYPES = [
  'intro', 'buildup', 'drop', 'breakdown', 'bridge', 'outro', 'silence',
  'verse', 'prechorus', 'chorus', 'groove',
  UNSET_TYPE,
] as const;

/** Curated subset shipped as the dropdown default for new users — the EDM-style
 *  types plus the two song-form terms (`verse`, `chorus`) that vocal-led EDM
 *  needs constantly, kept short so the picker is not overwhelming on first
 *  launch. Ordered song-form-first so the two reachable-by-eye groups read as
 *  groups. Must stay identical to `CANONICAL_VOCAB` in genrePresets.ts, which
 *  is the same list seen from the genre-card side — the shipped default is
 *  exactly the EDM/House/Mainstage/Bass card's vocabulary, so the Settings
 *  genre cards light up correctly for a user who never touched them.
 *  `unset` is appended by `getSectionTypes`, so it's always present without
 *  needing to live in the user-facing default list. */
export const DEFAULT_VOCABULARY: readonly string[] =
  ['intro', 'verse', 'chorus', 'buildup', 'drop', 'breakdown', 'bridge', 'outro', 'silence'];

export const ALLOWED_SECTION_TYPES = new Set<string>(SECTION_TYPES);

export function getSectionTypes(vocabulary?: readonly string[]): string[] {
  const cleaned = (vocabulary ?? SECTION_TYPES)
    .map((type) => type.trim().toLowerCase())
    .filter((type) => type.length > 0);
  const base = cleaned.length > 0 ? cleaned : [...SECTION_TYPES];
  return Array.from(new Set([...base, UNSET_TYPE]));
}

export const SECTION_COLORS: Record<string, string> = {
  intro:     '#a78bfa',
  buildup:   '#fde047',
  drop:      '#4ade80',
  breakdown: '#e879f9',
  bridge:    '#fb7185',
  outro:     '#64748b',
  silence:   '#334155',
  verse:     '#38bdf8',
  prechorus: '#f59e0b',
  chorus:    '#10b981',
  groove:    '#c084fc',
  // Subtle visible gray for card borders/text. The timeline strip in
  // SharedVizPanel/AnnotationOverlays force-renders the bg to transparent
  // for this type, so the strip looks empty even though the card is visible.
  unset:     '#64748b',
  default:   '#94a3b8',
};

export const SECTION_INFO: Record<string, string> = {
  intro:     'Opening section — gradual build-up of elements, typically minimal energy.',
  buildup:   'Rising tension before the drop — drum rolls, filtering, rising synths; energy escalates.',
  drop:      'Main high-energy peak — full bassline, kick, lead synth; the defining moment of the track.',
  breakdown: 'Stripped-back section after the drop — tension release, often ambient or rhythmically sparse.',
  bridge:    'Transitional passage between major sections; often introduces a new melodic or harmonic idea.',
  outro:     'Closing section — gradual element removal, mirror of the intro.',
  silence:   'Moment of near-silence — used for dramatic effect before a drop or at the track\'s end.',
  verse:     'Song-form verse — narrative or melodic content between choruses.',
  prechorus: 'Short rise that sets up the chorus — lifts energy and signals the hook.',
  chorus:    'Main hook of the song — most memorable, highest-energy vocal/melodic section.',
  groove:    'Steady-state evolving loop — minimal techno/house section without a clear drop.',
  unset:     'Filler — placeholder boundary with no assigned section type. Inserted automatically when ADDing a selection into empty space or into a same-type parent, so the new section ends cleanly. Pick a real type from the dropdown to convert it.',
};

export function sectionColor(type: string): string {
  return SECTION_COLORS[type] ?? SECTION_COLORS.default;
}

export function sectionLabel(type: string): string {
  if (type === UNSET_TYPE) return '—';
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/** True for a section that carries the `unset` type but is NOT one of the
 *  automatic filler caps — a real section whose type left the vocabulary (the
 *  user dropped the name in Settings, or the section was imported in someone
 *  else's vocabulary) and was normalized to `unset` with its written label
 *  kept by `normalizeSection`.
 *
 *  The label is the discriminator: caps are created as `{ type: unset, label:
 *  '—' }` and never carry anything else, so any other label means a human
 *  named this section. The distinction matters because caps are deliberately
 *  invisible — hidden from the section-card list, drawn transparent on the
 *  lane — and an orphan inheriting that would silently disappear from the two
 *  places the user could re-type it. */
export function isOrphanedSection(section: { type: string; label?: string }): boolean {
  if (section.type !== UNSET_TYPE) return false;
  const label = (section.label ?? '').trim();
  return label.length > 0 && label !== sectionLabel(UNSET_TYPE);
}

export function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${m}:${(sec % 60).toFixed(1).padStart(4, '0')}`;
}

export function sectionEnd(sections: SectionBlock[], i: number, duration: number): number {
  return i + 1 < sections.length ? sections[i + 1].time : duration;
}

/** Coerce a stored section type into the active vocabulary.
 *
 *  Anything unrecognised lands on `unset` (the "—" filler), NOT on the first
 *  word of the vocabulary. A type falls through here for two reasons — the user
 *  dropped that name in Settings, or the section came from an import written in
 *  someone else's vocabulary (a SALAMI `solo`, say) — and in both cases the
 *  honest answer is "this section has no type I can name". Mapping it to the
 *  first word instead would silently assert something specific and wrong: every
 *  orphaned section would read as a real Intro. `normalizeSection` keeps the
 *  original written label, so the section still shows what it used to be.
 *
 *  Settings warns before dropping a name in use — see VocabularyRemovalDialog. */
export function normalizeSectionType(type: string | undefined, sectionTypes: readonly string[] = SECTION_TYPES): string {
  const normalized = (type ?? '').trim().toLowerCase();
  // `unset` is always valid — filler sections must survive normalization
  // even when the user's configured vocabulary doesn't list it.
  if (normalized === UNSET_TYPE) return UNSET_TYPE;
  const allowed = new Set(sectionTypes);
  return allowed.has(normalized) ? normalized : UNSET_TYPE;
}

/** Auto-numbered label for a new section of `type` (e.g. "Drop 3"). */
export function autoLabel(sections: Array<{ type: string }>, type: string): string {
  const n = sections.filter((s) => s.type === type).length + 1;
  return `${sectionLabel(type)} ${n}`;
}

export function normalizeSectionLabel(label: string | undefined): string {
  return label ?? '';
}

export function normalizeSection(section: SectionBlock, sectionTypes: readonly string[]): SectionBlock {
  const type = normalizeSectionType(section.type, sectionTypes);
  const normalizedLabel = normalizeSectionLabel(section.label);
  const original = (section.label ?? '').trim();
  const isAutoLike = original === '' || sectionTypes.some((t) => sectionLabel(t).toLowerCase() === original.toLowerCase());
  return { ...section, type, label: isAutoLike ? sectionLabel(type) : normalizedLabel };
}

export function normalizeSections(sections: SectionBlock[], sectionTypes: readonly string[]): SectionBlock[] {
  return sections.map((section) => normalizeSection(section, sectionTypes));
}

