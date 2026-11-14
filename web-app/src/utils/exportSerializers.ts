/**
 * Serializers for the Advanced Export Manager.
 *
 * Each output format takes the neutral `{start, duration, section}` shape so
 * converters stay independent of our richer BoundaryItem /
 * AutoGuessManualAnnotation types. Adapters at the bottom translate from those types into ExportSection[]
 * for use at the call site.
 *
 * Audacity round-trips fine for both labelled regions and zero-duration
 * markers; Sonic Visualiser layers are point-based, so duration is dropped
 * on that side. JAMS emits the `segment_open` namespace (open-vocabulary
 * structural segments) — see convertToJams below for the validation contract.
 */

import type { AutoGuessManualAnnotation } from '../types/autoGuess';
import { ACCENT_FULL } from '../types/annotationLayer';
import type {
  AnnotationLayer,
  BoundaryItem,
  CueItem,
  SpanItem,
  LoopItem,
  LyricsItem,
} from '../types/annotationLayer';
import { riffPlays, riffPlayNotes } from './riffPlays';
import type { SongInfo } from '../types/songInfo';
import { beatsPerBarFromTimeSignature, getBarBeatOrigin, visibleGridLines } from './beatGrid';
import { karaokeRowsOf } from './karaokeRows';

export interface ExportSection {
  start: number;
  duration: number;
  section: string;
}

// Audacity label-track format: <start>\t<end>\t<label>, one per line, trailing
// newline required (some Audacity versions reject the last entry without it).
// Tabs/newlines inside the label are stripped — they would corrupt the row
// boundary on import.
export function convertToAudacity(sections: ExportSection[]): string {
  if (sections.length === 0) return '';
  const body = sections
    .map((s) => {
      const startSec = s.start.toFixed(6);
      const endSec = (s.start + s.duration).toFixed(6);
      const label = s.section.replace(/[\t\r\n]+/g, ' ');
      return `${startSec}\t${endSec}\t${label}`;
    })
    .join('\n');
  return body + '\n';
}

// Sonic Visualiser CSV. A file of instants is `time,label` (a Time Instants
// layer); a file where anything has a length is `time,duration,label`, which
// SV's CSV import reads as a Regions layer — so a span, a loop or a riff play
// keeps its end instead of collapsing to its start. An instant in such a file
// gets duration 0. Labels are quoted per RFC 4180.
export function convertToSonicVisualiser(sections: ExportSection[]): string {
  if (sections.length === 0) return '';
  const regions = sections.some((s) => s.duration > 0);
  const body = sections
    .map((s) => regions
      ? `${s.start.toFixed(6)},${Math.max(0, s.duration).toFixed(6)},${csvQuote(s.section)}`
      : `${s.start.toFixed(6)},${csvQuote(s.section)}`)
    .join('\n');
  return body + '\n';
}

function csvQuote(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// REAPER region/marker CSV — the shape REAPER's own "Region/Marker Manager
// → Export project regions/markers" emits, which it can also re-import via
// "Import project regions/markers". Header row:
//
//   #,Name,Start,End,Length,Color
//
// Rows with a duration are written as regions (`R<n>`); zero-duration rows
// (auto-guess boundaries, manual's trailing section) become markers (`M<n>`)
// with empty End/Length cells. Times are `H:MM:SS.mmm`. Color is left
// blank — REAPER's importer treats that as "use default".
export function convertToReaper(sections: ExportSection[]): string {
  const header = '#,Name,Start,End,Length,Color';
  if (sections.length === 0) return header + '\n';

  const rows = sections.map((s, i) => {
    const name = csvQuote(s.section);
    // Round to ms first, then derive Length from the rounded Start/End so the
    // three columns stay self-consistent in the file (independent rounding of
    // start/end/duration can otherwise drift by 1 ms — REAPER ignores this,
    // but the CSV should still reconcile).
    const startMs = Math.round(Math.max(0, s.start) * 1000);
    const endMs = startMs + Math.round(Math.max(0, s.duration) * 1000);
    const start = formatReaperTime(startMs);
    if (s.duration > 0) {
      const end = formatReaperTime(endMs);
      const length = formatReaperTime(endMs - startMs);
      return `R${i + 1},${name},${start},${end},${length},`;
    }
    return `M${i + 1},${name},${start},,,`;
  });
  return [header, ...rows].join('\n') + '\n';
}

/** Format a millisecond count as REAPER's `H:MM:SS.mmm`. */
function formatReaperTime(ms: number): string {
  const total = Math.max(0, ms);
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const milli = total % 1000;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
}

// MIDI. Standard MIDI File format 0, single track, 480 PPQ, with the tempo set
// so seconds-position is preserved when the file is loaded in a DAW. If `bpm`
// is provided we use it so bar-grid positions also land where the annotator
// placed them; otherwise we fall back to 120 BPM — *seconds* are unaffected by
// the choice.
//
// Two files share one writer: a marker track (one 0xFF 0x06 marker per
// section — Ableton / Logic / Reaper / FL Studio import them as project
// markers), and a note track for a cue layer whose cues carry a pitch, where
// every pitched cue is a note-on / note-off pair a DAW plays back.
//
// Hand-rolled rather than pulling in a JS MIDI library: the wire format we
// need is tiny (header + one track + a few event kinds) and avoiding the
// dependency keeps the bundle lean.

const MIDI_PPQ = 480;

export interface MidiMarkersOptions {
  /** Project tempo, used for tempo meta-event and tick conversion. Defaults to 120. */
  bpm?: number;
}

/** One event of the track, at an absolute tick. `rank` orders events that
 *  share a tick: a note-off (0) before a marker (1) before a note-on (2), so a
 *  note that ends where the next one starts never cuts that one off. */
interface MidiEvent { tick: number; rank: number; bytes: number[] }

function midiTempo(bpm: number | undefined) {
  const usPerQuarter = Math.round(60_000_000 / (bpm && bpm > 0 ? bpm : 120));
  const ticksPerSecond = (MIDI_PPQ * 1_000_000) / usPerQuarter;
  return { usPerQuarter, tickAt: (s: number) => Math.max(0, Math.round(s * ticksPerSecond)) };
}

function metaText(type: number, text: string): number[] {
  const bytes = new TextEncoder().encode(text.replace(/[\r\n]+/g, ' '));
  return [0xFF, type, ...vlq(bytes.length), ...bytes];
}

/** Header + one track: tempo first, `events` in time order, end-of-track. */
function smfFormat0(usPerQuarter: number, head: number[][], events: MidiEvent[]): Uint8Array {
  const trackBytes: number[] = [];
  for (const meta of head) trackBytes.push(...vlq(0), ...meta);
  // Tempo: delta=0, 0xFF 0x51 0x03 [3 bytes BE us/quarter]
  trackBytes.push(...vlq(0), 0xFF, 0x51, 0x03,
    (usPerQuarter >> 16) & 0xFF, (usPerQuarter >> 8) & 0xFF, usPerQuarter & 0xFF);
  const sorted = events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.tick - b.e.tick || a.e.rank - b.e.rank || a.i - b.i)
    .map(({ e }) => e);
  let prevTick = 0;
  for (const e of sorted) {
    trackBytes.push(...vlq(e.tick - prevTick), ...e.bytes);
    prevTick = e.tick;
  }
  // End of track: delta=0, 0xFF 0x2F 0x00
  trackBytes.push(0x00, 0xFF, 0x2F, 0x00);

  // Header: 'MThd' + length=6 + format=0 + ntrks=1 + division=PPQ
  const header = [
    0x4D, 0x54, 0x68, 0x64,
    0x00, 0x00, 0x00, 0x06,
    0x00, 0x00,
    0x00, 0x01,
    (MIDI_PPQ >> 8) & 0xFF, MIDI_PPQ & 0xFF,
  ];
  // Track: 'MTrk' + length + bytes
  const trackLen = trackBytes.length;
  const track = [
    0x4D, 0x54, 0x72, 0x6B,
    (trackLen >> 24) & 0xFF, (trackLen >> 16) & 0xFF, (trackLen >> 8) & 0xFF, trackLen & 0xFF,
    ...trackBytes,
  ];
  return new Uint8Array([...header, ...track]);
}

export function convertToMidiMarkers(
  sections: ExportSection[],
  opts: MidiMarkersOptions = {},
): Uint8Array {
  const { usPerQuarter, tickAt } = midiTempo(opts.bpm);
  return smfFormat0(usPerQuarter, [], sections.map((s) => ({
    tick: tickAt(s.start), rank: 1, bytes: metaText(0x06, s.section),
  })));
}

export interface MidiNote {
  /** Seconds. */
  time: number;
  /** Seconds. */
  end: number;
  /** 0-127. */
  midi: number;
  /** 1-127. */
  velocity: number;
  /** 0-15; absent = 0. Channel 9 is General MIDI's drum kit, where the key
   *  names the drum instead of a pitch. */
  channel?: number;
}

export interface MidiNotesOptions extends MidiMarkersOptions {
  /** Track name (meta 0x03) — the layer's name, so the DAW names the track. */
  name?: string;
  /** Cues with no pitch, written as markers alongside the notes. */
  markers?: ExportSection[];
  /** Sung words or syllables, written as lyric events (meta 0x05) — what a
   *  DAW's lyric track and a karaoke player read. */
  lyrics?: { time: number; text: string }[];
}

/** A cue layer's pitched cues as a playable note track. Notes are taken from
 *  `karaokeRowsOf` — the piano roll's own reading — so a note is exactly as
 *  long in the DAW as it is drawn in the karaoke: its `decay` when it has
 *  one, else until the next note. A note that would still be sounding when
 *  the same pitch starts again is cut there, because one key cannot be held
 *  down twice. */
export function cueItemsToMidiNotes(items: readonly CueItem[]): MidiNote[] {
  const row = karaokeRowsOf('export', 'export', '#000000', items).find((r) => r.kind === 'notes');
  if (!row || row.kind !== 'notes') return [];
  const notes = row.notes
    .filter((n) => n.midi >= 0 && n.midi <= 127)
    .map((n) => ({ time: n.time, end: n.end, midi: n.midi, velocity: Math.round(n.velocity) }));
  const nextSame = new Map<number, number>();
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i];
    const next = nextSame.get(n.midi);
    if (next !== undefined && n.end > next) n.end = next;
    nextSame.set(n.midi, n.time);
  }
  return notes;
}

export function convertToMidiNotes(notes: readonly MidiNote[], opts: MidiNotesOptions = {}): Uint8Array {
  const { usPerQuarter, tickAt } = midiTempo(opts.bpm);
  const events: MidiEvent[] = [];
  for (const n of notes) {
    const on = tickAt(n.time);
    const off = Math.max(on + 1, tickAt(n.end));
    const vel = Math.max(1, Math.min(127, Math.round(n.velocity)));
    const ch = (n.channel ?? 0) & 0x0F;
    events.push({ tick: on, rank: 2, bytes: [0x90 | ch, n.midi & 0x7F, vel] });
    events.push({ tick: off, rank: 0, bytes: [0x80 | ch, n.midi & 0x7F, 0x40] });
  }
  for (const s of opts.markers ?? []) events.push({ tick: tickAt(s.start), rank: 1, bytes: metaText(0x06, s.section) });
  for (const l of opts.lyrics ?? []) events.push({ tick: tickAt(l.time), rank: 1, bytes: metaText(0x05, l.text) });
  return smfFormat0(usPerQuarter, opts.name ? [metaText(0x03, opts.name)] : [], events);
}

/** Variable-length quantity (SMF spec section 1.1). Encodes 7 bits per byte,
 *  MSB set on every byte except the last. */
function vlq(n: number): number[] {
  if (n < 0 || !Number.isFinite(n)) throw new Error(`vlq: invalid ${n}`);
  const bytes: number[] = [];
  let v = n >>> 0;
  do {
    bytes.unshift(v & 0x7F);
    v >>>= 7;
  } while (v > 0);
  for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80;
  return bytes;
}

// mir_eval / SALAMI-style boundary file: `<time>\t<label>\n` per line. This is
// the shape `mir_eval.io.load_labeled_events` reads — used directly by
// `mir_eval.segment.detection` and `mir_eval.onset.f_measure` for boundary
// F-measure evaluation. Tabs/newlines inside labels are stripped to keep one
// row per event. Convention: `.lab` extension.
export function convertToMirEval(sections: ExportSection[]): string {
  if (sections.length === 0) return '';
  const body = sections
    .map((s) => {
      const t = s.start.toFixed(6);
      const label = s.section.replace(/[\t\r\n]+/g, ' ');
      return `${t}\t${label}`;
    })
    .join('\n');
  return body + '\n';
}

// ─── JAMS (JSON Annotated Music Specification, v0.3) ────────────────────────
//
// One annotation per file, namespace `segment_open` (open-vocab structural
// segments). file_metadata.duration is REQUIRED by jams.load(validate=True),
// so we derive it from max(start+duration) across the sections — if the
// caller doesn't pass an explicit duration. Zero-duration tail markers (the
// last manual section, all auto-guess boundaries) are preserved as instants.

export type JamsLayerKind = 'manual' | 'auto-guess' | 'grid';

export interface JamsOptions {
  /** Song slug — written to file_metadata.identifiers.slug. */
  slug: string;
  /** Which TimeCues layer this annotation came from — written to data_source. */
  layer: JamsLayerKind;
  /** Annotator id (typically email). Optional; omitted from annotator metadata
   *  if absent. */
  annotatorId?: string | null;
  /** Optional override for file_metadata.duration. When omitted we infer from
   *  the sections. Schema requires duration > 0, so we floor at 1.0 if nothing
   *  larger is available. */
  fileDuration?: number;
}

interface JamsObservation {
  time: number;
  duration: number;
  value: string;
  confidence: number | null;
}

const JAMS_VERSION = '0.3.4';

export function convertToJams(sections: ExportSection[], opts: JamsOptions): string {
  const data: JamsObservation[] = sections.map((s) => ({
    time: Number(s.start.toFixed(6)),
    duration: Number(Math.max(0, s.duration).toFixed(6)),
    value: s.section,
    confidence: null,
  }));

  const inferred = sections.reduce((max, s) => {
    const end = s.start + Math.max(0, s.duration);
    return end > max ? end : max;
  }, 0);
  const fileDuration = opts.fileDuration && opts.fileDuration > 0
    ? Number(opts.fileDuration.toFixed(6))
    : Number(Math.max(inferred, 1).toFixed(6));

  const annotationDuration = data.length > 0
    ? Number(
        (Math.max(...data.map((d) => d.time + d.duration)) - data[0].time).toFixed(6),
      )
    : 0;
  const annotationStart = data.length > 0 ? data[0].time : 0;

  const jams = {
    file_metadata: {
      duration: fileDuration,
      title: opts.slug,
      artist: '',
      release: '',
      identifiers: { slug: opts.slug },
      jams_version: JAMS_VERSION,
    },
    annotations: [
      {
        namespace: 'segment_open',
        data,
        annotation_metadata: {
          curator: { name: '', email: '' },
          annotator: opts.annotatorId ? { id: opts.annotatorId } : {},
          version: '',
          corpus: 'timecues',
          annotation_tools: 'timecues-studio',
          annotation_rules: '',
          validation: '',
          data_source: opts.layer,
        },
        sandbox: {},
        time: annotationStart,
        duration: annotationDuration,
      },
    ],
    sandbox: {},
  };

  return JSON.stringify(jams, null, 2) + '\n';
}

// ─── Adapters ────────────────────────────────────────────────────────────────

/** Boundary items tile their layer, so each one's duration runs to the next
 *  item's start. Sorted defensively — an unsorted layer would otherwise emit
 *  negative durations clamped to 0, silently collapsing sections. */
export function boundaryItemsToExportSections(items: readonly BoundaryItem[]): ExportSection[] {
  const sorted = [...items].sort((a, b) => a.time - b.time);
  return sorted.map((s, i) => {
    const next = sorted[i + 1]?.time;
    const duration = next != null ? Math.max(0, next - s.time) : 0;
    return { start: s.time, duration, section: s.label };
  });
}

/**
 * Auto-guess: only points the reviewer has accepted (status 'correct' or
 * 'partial') are exported, as zero-duration boundary markers. The label is
 * the cluster id so it survives the round-trip back into our tools.
 */
export function autoGuessAcceptedToExportSections(
  ann: AutoGuessManualAnnotation,
): ExportSection[] {
  return ann.points
    .filter((p) => p.status === 'correct' || p.status === 'partial')
    .map((p) => ({
      start: p.time,
      duration: 0,
      section: `boundary-${p.clusterId}`,
    }));
}

/** Cue items become zero-duration markers — same shape as auto-guess points,
 *  preserving the user's label text. */
export function cueItemsToExportSections(items: CueItem[]): ExportSection[] {
  return items
    .slice()
    .sort((a, b) => a.time - b.time)
    .map((c) => ({ start: c.time, duration: 0, section: c.label || 'cue' }));
}

/** Span items become labeled intervals. Empty labels fall back to 'span' so
 *  the row is still distinguishable in plain-text formats like Audacity. */
export function spanItemsToExportSections(items: SpanItem[]): ExportSection[] {
  return items
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((s) => ({
      start: s.start,
      duration: Math.max(0, s.end - s.start),
      section: s.label || 'span',
    }));
}

/** Loop items export as labeled intervals — same shape as Spans, since the
 *  seamless-playback affordance is a UI concern and not preserved by any
 *  interchange format. */
export function loopItemsToExportSections(items: LoopItem[]): ExportSection[] {
  return items
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((l) => ({
      start: l.start,
      duration: Math.max(0, l.end - l.start),
      section: l.label || 'loop',
    }));
}

/** Lyrics export as labelled intervals, word or line alike — a lyric is a
 *  span from `time` to `end` — labelled with what is sung. A layer holding
 *  both lines and the words inside them writes both, overlapping, as it draws
 *  them. A lyric with no usable end is an instant. */
export function lyricsItemsToExportSections(items: readonly LyricsItem[]): ExportSection[] {
  return items
    .slice()
    .sort((a, b) => a.time - b.time)
    .map((l) => ({
      start: l.time,
      duration: typeof l.end === 'number' && l.end > l.time ? l.end - l.time : 0,
      section: l.text || (l.kind === 'line' ? 'line' : 'word'),
    }));
}

/** A lyrics layer as MIDI: every word a lyric event, split into its
 *  syllables where the annotator laid them on the word's onsets (only those
 *  inside the word, as the lane draws them); every line a marker. No notes —
 *  a lyric says what is sung, not at what pitch. */
export function convertLyricsToMidi(
  items: readonly LyricsItem[],
  opts: MidiMarkersOptions & { name?: string } = {},
): Uint8Array {
  const lyrics: { time: number; text: string }[] = [];
  const lines: LyricsItem[] = [];
  for (const it of items) {
    if (it.kind === 'line') { lines.push(it); continue; }
    const end = typeof it.end === 'number' ? it.end : it.time;
    const sung = (it.onsets ?? [])
      .filter((o) => o.text && o.time >= it.time - 1e-6 && o.time <= end + 1e-6)
      .sort((a, b) => a.time - b.time);
    if (sung.length === 0) { lyrics.push({ time: it.time, text: it.text }); continue; }
    // A syllable laid after the word's start leaves the start unsung unless
    // the word itself is written there.
    if (sung[0].time > it.time + 1e-6) lyrics.push({ time: it.time, text: it.text });
    for (const o of sung) lyrics.push({ time: o.time, text: o.text! });
  }
  return convertToMidiNotes([], {
    ...opts,
    lyrics,
    markers: lyricsItemsToExportSections(lines),
  });
}

/** The figure's name as an export label, with how this play differed from
 *  it — `A`, `A · fill`. */
function riffPlayLabel(name: string, event: string | undefined): string {
  return event && event !== 'exact' ? `${name} · ${event}` : name;
}

/** A riff-patterns layer as labelled intervals: one per play of a node —
 *  every repeat of every instance, every entry of its sequence, every leaf of
 *  a combo — labelled with the node's name and, when the play differed from
 *  the node, how (`A · fill`). Rests are left out: a marker file says where
 *  something plays. The same plays the lane draws (`riffPlays`), so the file
 *  and the lane cannot disagree about where A is. */
export function riffLayerToExportSections(
  layer: Pick<AnnotationLayer<'riff-patterns'>, 'items' | 'nodes' | 'combos'>,
  bpm: number | undefined,
): ExportSection[] {
  return riffPlays(layer, bpm)
    .filter((p) => p.node)
    .map((p) => ({
      start: p.start,
      duration: Math.max(0, p.end - p.start),
      section: riffPlayLabel(p.node!.name || 'riff', p.occ?.event),
    }));
}

/** General MIDI drum keys for the drums a copied groove can be. */
const GM_DRUM_KEY: Record<string, number> = {
  kick: 36, snare: 38, hat: 42, toms: 45, crash: 49, ride: 51,
};
/** A struck note with no pitch on a layer that names no drum: a rhythm, so
 *  it goes on the drum channel, as a side stick — a click a DAW will play
 *  without implying a pitch nobody annotated. */
const GM_UNNAMED_HIT = 37;
const GM_DRUM_CHANNEL = 9;

/** Every note a riff layer plays, in song seconds, as MIDI notes: a note with
 *  a pitch at that pitch, a hit without one on the drum channel at its drum's
 *  key (`layer.drum`), so a copied kick groove opens in a DAW as a kick
 *  pattern. Velocity is the note's accent; no accent is full strength. */
export function riffLayerToMidiNotes(
  layer: Pick<AnnotationLayer<'riff-patterns'>, 'items' | 'nodes' | 'combos' | 'drum'>,
  bpm: number | undefined,
): MidiNote[] {
  const drumKey = (layer.drum && GM_DRUM_KEY[layer.drum]) || GM_UNNAMED_HIT;
  const out: MidiNote[] = [];
  for (const p of riffPlays(layer, bpm)) {
    for (const n of riffPlayNotes(p)) {
      const pitched = typeof n.note === 'number' && n.note >= 0 && n.note <= 127;
      out.push({
        time: n.time,
        end: n.end,
        midi: pitched ? Math.round(n.note!) : drumKey,
        velocity: n.accent ?? ACCENT_FULL,
        ...(pitched ? {} : { channel: GM_DRUM_CHANNEL }),
      });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Grid resolution the user can pick when exporting the grid-labels sidecar.
 *   - `bars`        — one marker per bar (downbeat). Labels "1", "2", "3", …
 *   - `beats`       — one marker per beat. Labels "1.1", "1.2", … (default)
 *   - `subbeats-8`  — beats + 8th-note offbeats. Labels "1.1", "1.1.5", "1.2", …
 *   - `subbeats-16` — beats + 16th-note ticks. Labels "1.1", "1.1.25", "1.1.5", …
 *   - `phrases`     — one marker per phrase (4 bars). Labels "P1", "P2", … */
export type GridExportGranularity =
  | 'bars' | 'beats' | 'subbeats-8' | 'subbeats-16' | 'phrases';

/** Phrase length in bars — matches visibleGridLines' default `phraseBars`. */
const PHRASE_BARS = 4;

/** Enumerate the song's active grid between 0 and `durationSec` at the chosen
 *  `granularity`. Static / Dynamic / Manual modes are all routed through
 *  visibleGridLines, which already resolves grid segments and per-beat
 *  beatOverrides — so the caller doesn't have to branch on gridMode. Each grid
 *  line becomes a zero-duration marker; the label is the Rekordbox-style
 *  string the UI shows (bar / bar.beat / bar.beat.frac, or "P<n>" for
 *  phrases), numbered from the user's `barBeatOrigin` so an export reads the
 *  same way the annotator does. Returns [] when the song has no usable BPM or a
 *  non-positive duration. */
export function gridToExportSections(
  info: SongInfo,
  durationSec: number,
  granularity: GridExportGranularity = 'beats',
): ExportSection[] {
  const bpm = info.bpm;
  if (!Number.isFinite(bpm) || !bpm || bpm <= 0) return [];
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const beatsPerBar = beatsPerBarFromTimeSignature(info.timeSignature);
  const origin = getBarBeatOrigin();
  // Map the granularity onto visibleGridLines' knobs: bar-only modes set
  // barGroupSize (which suppresses sub-beats), sub-beat modes set the division.
  const subBeatDivision = granularity === 'subbeats-8' ? 2
    : granularity === 'subbeats-16' ? 4 : 1;
  const barGroupSize = granularity === 'bars' ? 1
    : granularity === 'phrases' ? PHRASE_BARS : null;
  const lines = visibleGridLines({
    bpm,
    gridOffset: info.gridOffset ?? 0,
    beatsPerBar,
    startTime: 0,
    endTime: durationSec,
    beatOverrides: info.gridMode === 'manual' ? info.beatOverrides : undefined,
    subBeatDivision,
    barGroupSize,
  });
  const sections: ExportSection[] = [];
  for (const l of lines) {
    let label: string;
    if (granularity === 'bars') {
      if (!l.isBar) continue;
      label = `${l.barNumber}`;
    } else if (granularity === 'phrases') {
      if (!l.isBar) continue;
      label = `P${Math.floor((l.barNumber - origin) / PHRASE_BARS) + origin}`;
    } else {
      // beats / sub-beats — bar.beat, with a trailing fractional component for
      // off-grid sub-beats (e.g. "1.3.5" for the 8th after bar 1 beat 3).
      const barIdx = Math.floor(l.beatIndex / beatsPerBar);
      const beatInBar = l.beatIndex - barIdx * beatsPerBar;
      const intBeat = Math.floor(beatInBar);
      const frac = beatInBar - intBeat;
      label = `${barIdx + origin}.${intBeat + origin}`;
      // frac is an exact binary fraction (½ / ¼ / ¾) so its decimals are stable.
      if (frac > 1e-6) label += `.${String(frac).slice(2)}`;
    }
    sections.push({ start: Math.max(0, l.t), duration: 0, section: label });
  }
  return sections;
}
