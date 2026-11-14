/**
 * A custom detector can run once per stem: `stem = ["vocals", "other"]`. The
 * loader then registers `<name>__vocals` and `<name>__other` — one detector,
 * one lane, one cache per stem, the same `<algo>__<stem>` id the built-in
 * algorithms use — while the file keeps the `name` written in it
 * (custom_loader._per_stem). The editor works on files, so it folds the
 * per-stem entries back into one, and addresses a run by its per-stem name.
 */
import { SEVERAL_STEMS, type CustomDetectorStem, type CustomRegistryEntry } from '../types/customScript';

/** Every stem a detector may read, in the order the picker shows them. */
export const DETECTOR_STEMS: readonly CustomDetectorStem[] = ['mix', 'vocals', 'drums', 'bass', 'other', 'guitar', 'piano'];

/** The Demucs stem a detector cannot run without, or null when it is filed
 *  under the mix, under several stems (it reads whichever it finds), or none. */
export function requiredStem(stem: string | null | undefined): string | null {
  return stem && stem !== 'mix' && stem !== SEVERAL_STEMS ? stem : null;
}

/** How a detector's filing reads in the UI: the stem's own name, or "several
 *  stems" for one lane read from several (lane titles, chips, ⓘ lines). */
export function stemFilingLabel(stem: string): string {
  return stem === SEVERAL_STEMS ? 'several stems' : stem;
}

/** The registry name of one stem's run: `<base>__<stem>`, bare for the mix. */
export function runNameFor(base: string, stem: string | null | undefined): string {
  return stem && stem !== 'mix' ? `${base}__${stem}` : base;
}

/** One entry per detector file: the per-stem entries of a detector declaring
 *  several stems become one, named by its file's `name`, `stem` null and
 *  `stems` the full list. Order follows each file's first entry. */
export function foldPerStem(entries: CustomRegistryEntry[]): CustomRegistryEntry[] {
  const out: CustomRegistryEntry[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e.stems || e.stems.length === 0 || !e.base_name) {
      out.push(e);
      continue;
    }
    if (seen.has(e.base_name)) continue;
    seen.add(e.base_name);
    out.push({ ...e, name: e.base_name, stem: null });
  }
  return out;
}

export type ParsedStems =
  | { kind: 'absent' }
  | { kind: 'stems'; stems: CustomDetectorStem[] }
  /** Set in a way the picker can't rewrite safely (a variable, a multi-line
   *  list, an unknown stem) — the code stays the only place to change it. */
  | { kind: 'unparsed'; text: string };

const STEM_LINE = /^([ \t]*)stem([ \t]*=[ \t]*)(.*?)([ \t]*(?:#.*)?)$/m;
const STRING_LIT = /^(?:"([^"\n]*)"|'([^'\n]*)')$/;

function isStem(s: string): s is CustomDetectorStem {
  return (DETECTOR_STEMS as readonly string[]).includes(s);
}

/** Read the `stem = …` class attribute: one quoted stem, or a one-line list. */
export function parseStemAttr(code: string): ParsedStems {
  const m = code.match(STEM_LINE);
  if (!m) return { kind: 'absent' };
  const raw = m[3].trim();
  if (raw === 'None') return { kind: 'absent' };
  const one = raw.match(STRING_LIT);
  if (one) {
    const s = one[1] ?? one[2] ?? '';
    return isStem(s) ? { kind: 'stems', stems: [s] } : { kind: 'unparsed', text: raw };
  }
  const list = raw.match(/^\[(.*)\]$/);
  if (list) {
    const items = list[1].split(',').map((t) => t.trim()).filter(Boolean);
    const stems = items.map((t) => t.match(STRING_LIT)).map((mm) => (mm ? mm[1] ?? mm[2] ?? '' : ''));
    if (stems.length > 0 && stems.every(isStem)) return { kind: 'stems', stems: stems as CustomDetectorStem[] };
  }
  return { kind: 'unparsed', text: raw };
}

/** Write the picked stems back into the source, keeping the line's indent and
 *  trailing comment: one stem as a string, several as a list, in picker order.
 *  Inserts the line after the class header when there is none. */
export function setStemInCode(code: string, stems: readonly CustomDetectorStem[]): string {
  const ordered = DETECTOR_STEMS.filter((s) => stems.includes(s));
  if (ordered.length === 0) return code;
  const literal = ordered.length === 1 ? `"${ordered[0]}"` : `[${ordered.map((s) => `"${s}"`).join(', ')}]`;
  if (STEM_LINE.test(code)) {
    return code.replace(STEM_LINE, (_all, lead: string, gap: string, _old: string, tail: string) => `${lead}stem${gap}${literal}${tail}`);
  }
  const lines = code.split('\n');
  const idx = lines.findIndex((l) => /^\s*class\s+\w+\s*\(.*\bCustomDetector\b.*\)\s*:/.test(l));
  if (idx === -1) return code;
  const classIndent = lines[idx].match(/^\s*/)?.[0] ?? '';
  lines.splice(idx + 1, 0, `${classIndent}    stem = ${literal}`);
  return lines.join('\n');
}
