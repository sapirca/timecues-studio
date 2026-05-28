/**
 * Annotation import parsers — round-trip every format produced by the
 * Advanced Export Manager except JAMS / MIDI when the source did not come
 * from us (we read what we wrote; we don't read every dialect in the wild).
 *
 * Currently:
 *   • TimeCues JSON            (.json)
 *   • Audacity Label Track     (.txt)
 *   • Sonic Visualiser layers  (.csv) — content-disambiguated from REAPER
 *   • JAMS                     (.jams) — `segment_open` namespace
 *   • mir_eval boundaries      (.lab)
 *   • REAPER region/marker CSV (.csv) — detected by header sniff
 *
 * Audacity / Sonic Vis / mir_eval / REAPER are flat boundary-list formats,
 * so the parser returns plain `ManualSection[]` and the caller wraps it into
 * the right annotation shape. JSON returns the full parsed object so
 * callers can preserve unknown fields (e.g. `eye_status`, `ready_for_review`).
 * JAMS keeps just the segments — the `file_metadata` block is discarded
 * because it does not map onto any TimeCues field.
 */

import type { ManualSection } from '../types/manualAnnotation';

const ALLOWED_TYPES = new Set([
  'intro', 'buildup', 'drop', 'breakdown', 'bridge', 'outro', 'silence',
]);

function normalizeType(raw: string | undefined): string {
  const v = (raw ?? '').trim().toLowerCase();
  if (ALLOWED_TYPES.has(v)) return v;
  for (const t of ALLOWED_TYPES) if (v.includes(t)) return t;
  return 'drop';
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── TimeCues JSON ───────────────────────────────────────────────────────────

export interface ParsedJsonAnnotation {
  sections: ManualSection[];
  /** Remaining top-level fields (song, reviewed, annotated_at, eye_status, …). */
  rest: Record<string, unknown>;
}

export function parseTimeCuesJson(text: string): ParsedJsonAnnotation {
  const obj = JSON.parse(text);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Not a TimeCues annotation object.');
  }
  if (!Array.isArray(obj.sections)) {
    throw new Error('JSON has no `sections` array.');
  }
  const sections: ManualSection[] = obj.sections
    .map((s: Record<string, unknown>): ManualSection | null => {
      const time = Number(s.time);
      if (!Number.isFinite(time)) return null;
      const type = normalizeType(typeof s.type === 'string' ? s.type : undefined);
      const label = typeof s.label === 'string' && s.label ? s.label : titleCase(type);
      const out: ManualSection = { time, type, label };
      if (s.importance === 'optional' || s.importance === 'critical') out.importance = s.importance;
      if (Array.isArray(s.candidates)) {
        const cands = s.candidates.map(Number).filter(Number.isFinite);
        if (cands.length) out.candidates = cands;
      }
      return out;
    })
    .filter((s: ManualSection | null): s is ManualSection => s !== null);
  if (!sections.length) throw new Error('JSON contains no valid sections.');
  sections.sort((a, b) => a.time - b.time);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { sections: _drop, ...rest } = obj as Record<string, unknown>;
  return { sections, rest };
}

// ─── Audacity Label Track ────────────────────────────────────────────────────

export function parseAudacity(text: string): ManualSection[] {
  const sections: ManualSection[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const time = parseFloat(parts[0]);
    if (!Number.isFinite(time)) continue;
    const label = parts.slice(2).join('\t').trim();
    if (!label) continue;
    sections.push({ time, type: normalizeType(label), label });
  }
  if (!sections.length) throw new Error('No valid Audacity rows found.');
  sections.sort((a, b) => a.time - b.time);
  return sections;
}

// ─── Sonic Visualiser CSV ────────────────────────────────────────────────────

export function parseSonicVisualiser(text: string): ManualSection[] {
  const sections: ManualSection[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    const fields = parseCsvRow(line);
    if (!fields.length) continue;
    const time = parseFloat(fields[0]);
    if (!Number.isFinite(time)) continue; // skip header / junk rows
    const label = (fields[1] ?? '').trim();
    const type = normalizeType(label);
    sections.push({ time, type, label: label || titleCase(type) });
  }
  if (!sections.length) throw new Error('No valid CSV rows found.');
  sections.sort((a, b) => a.time - b.time);
  return sections;
}

// RFC 4180-ish: handle quoted fields with escaped quotes ("").
function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// ─── JAMS ────────────────────────────────────────────────────────────────────
//
// Reads the first segment-style annotation (`segment_open`,
// `segment_salami_*`, or anything starting with `segment`) and converts each
// observation's `time` + `value` to a ManualSection. JAMS may carry
// `duration` on each observation; we drop it because ManualSection encodes
// duration implicitly via the *next* section's time. Tolerant of empty
// `value` (falls back to inferred type label).
export function parseJams(text: string): ManualSection[] {
  let obj: unknown;
  try { obj = JSON.parse(text); }
  catch { throw new Error('Not valid JSON — JAMS files are JSON.'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('JAMS root must be an object.');
  }
  const annotations = (obj as Record<string, unknown>).annotations;
  if (!Array.isArray(annotations)) {
    throw new Error('JAMS file is missing the `annotations` array.');
  }
  const ann = annotations.find((a: unknown): a is Record<string, unknown> => {
    if (!a || typeof a !== 'object') return false;
    const ns = (a as Record<string, unknown>).namespace;
    return typeof ns === 'string' && ns.startsWith('segment')
      && Array.isArray((a as Record<string, unknown>).data);
  });
  if (!ann) {
    throw new Error('No `segment_*` annotation found in JAMS file.');
  }
  const data = ann.data as unknown[];
  const sections: ManualSection[] = [];
  for (const obs of data) {
    if (!obs || typeof obs !== 'object') continue;
    const time = Number((obs as Record<string, unknown>).time);
    if (!Number.isFinite(time)) continue;
    const rawValue = (obs as Record<string, unknown>).value;
    const label = typeof rawValue === 'string' && rawValue.trim()
      ? rawValue.trim()
      : '';
    const type = normalizeType(label);
    sections.push({ time, type, label: label || titleCase(type) });
  }
  if (!sections.length) {
    throw new Error('JAMS contained no usable observations.');
  }
  sections.sort((a, b) => a.time - b.time);
  return sections;
}

// ─── mir_eval boundary file (.lab) ───────────────────────────────────────────
//
// SALAMI / Isophonics convention: `<time>\t<label>` per line. Tab is the
// canonical delimiter but published datasets sometimes use spaces, so we
// split on whitespace and re-join the label so multi-word labels survive.
// Rejects rows that look like Audacity intervals (3+ tab-separated columns
// where columns 1 and 2 both parse as numbers) so the user does not pick
// the wrong importer accidentally.
export function parseMirEvalLab(text: string): ManualSection[] {
  const sections: ManualSection[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line) continue;
    // Quick guard: looks like Audacity (start<TAB>end<TAB>label)?
    const tabParts = line.split('\t');
    if (tabParts.length >= 3
        && Number.isFinite(parseFloat(tabParts[0]))
        && Number.isFinite(parseFloat(tabParts[1]))) {
      throw new Error('This looks like an Audacity label track. Use the Audacity importer.');
    }
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const time = parseFloat(parts[0]);
    if (!Number.isFinite(time)) continue;
    const label = parts.slice(1).join(' ').trim();
    if (!label) continue;
    sections.push({ time, type: normalizeType(label), label });
  }
  if (!sections.length) throw new Error('No valid mir_eval rows found.');
  sections.sort((a, b) => a.time - b.time);
  return sections;
}

// ─── REAPER region/marker CSV ────────────────────────────────────────────────
//
// Header: `#,Name,Start,End,Length,Color`. Row kinds are `R<n>` (region:
// has End + Length) or `M<n>` (marker: empty End/Length). Time format is
// `H:MM:SS.mmm`, but REAPER also accepts `M:SS.mmm` and plain seconds, so
// we are lenient. Duration is dropped (ManualSection encodes it via the next
// row's time).
export function parseReaperCsv(text: string): ManualSection[] {
  const lines = text.split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim());
  if (!lines.length) throw new Error('Empty REAPER CSV.');

  const sections: ManualSection[] = [];
  for (const line of lines) {
    const fields = parseCsvRow(line);
    if (fields.length < 3) continue;
    const kind = (fields[0] ?? '').trim();
    if (!/^[RM]\d+$/i.test(kind)) continue;  // skip header and any non-row lines
    const name = (fields[1] ?? '').trim();
    const time = parseReaperTime((fields[2] ?? '').trim());
    if (!Number.isFinite(time)) continue;
    const label = name || titleCase(normalizeType(undefined));
    sections.push({ time, type: normalizeType(label), label });
  }
  if (!sections.length) throw new Error('No valid REAPER rows (R<n> / M<n>) found.');
  sections.sort((a, b) => a.time - b.time);
  return sections;
}

function parseReaperTime(s: string): number {
  if (!s) return NaN;
  const parts = s.split(':');
  if (parts.length === 3) {
    const h = Number(parts[0]), m = Number(parts[1]), sec = Number(parts[2]);
    if (![h, m, sec].every(Number.isFinite)) return NaN;
    return h * 3600 + m * 60 + sec;
  }
  if (parts.length === 2) {
    const m = Number(parts[0]), sec = Number(parts[1]);
    if (![m, sec].every(Number.isFinite)) return NaN;
    return m * 60 + sec;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// ─── Format detection (by extension, with CSV content-disambiguation) ────────

export type ImportFormat = 'json' | 'audacity' | 'sonicVis' | 'jams' | 'mirEval' | 'reaper';

/** Detect import format from filename. If a `content` preview is provided,
 *  CSV files are upgraded to `reaper` when the REAPER header or row prefix
 *  is detected — otherwise CSV stays `sonicVis` (the existing default). */
export function detectFormat(filename: string, content?: string): ImportFormat | null {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'json') return 'json';
  if (ext === 'jams') return 'jams';
  if (ext === 'txt') return 'audacity';
  if (ext === 'lab') return 'mirEval';
  if (ext === 'csv') {
    if (content) {
      const firstNonEmpty = content.split('\n').find((l) => l.trim());
      if (firstNonEmpty) {
        const t = firstNonEmpty.trim();
        if (t.startsWith('#,Name,Start') || /^[RM]\d+,/i.test(t)) return 'reaper';
      }
    }
    return 'sonicVis';
  }
  return null;
}
