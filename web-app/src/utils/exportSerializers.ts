/**
 * Serializers for the Advanced Export Manager.
 *
 * Each output format takes the neutral `{start, duration, section}` shape so
 * converters stay independent of our richer ManualSection / AutoGuessManualAnnotation
 * types. Adapters at the bottom translate from those types into ExportSection[]
 * for use at the call site.
 *
 * Audacity round-trips fine for both labelled regions and zero-duration
 * markers; Sonic Visualiser layers are point-based, so duration is dropped
 * on that side. JAMS emits the `segment_open` namespace (open-vocabulary
 * structural segments) — see convertToJams below for the validation contract.
 */

import type {
  ManualAnnotation,
  ManualSection,
  AutoGuessManualAnnotation,
} from '../types/manualAnnotation';
import type {
  CueItem,
  SpanItem,
  LoopItem,
} from '../types/annotationLayer';
import type { SongInfo } from '../types/songInfo';
import { effectiveAnchors } from '../types/songInfo';
import { beatsPerBarFromTimeSignature, visibleGridLines } from './beatGrid';

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

// Sonic Visualiser expects comma-separated CSV with frame/second points.
// Quote labels containing commas/quotes/newlines per RFC 4180.
export function convertToSonicVisualiser(sections: ExportSection[]): string {
  if (sections.length === 0) return '';
  const body = sections
    .map((s) => `${s.start.toFixed(6)},${csvQuote(s.section)}`)
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

// MIDI marker track. Standard MIDI File format 0, single track, 480 PPQ.
// Emits one marker meta-event (0xFF 0x06) per section at its time, with the
// tempo set so seconds-position is preserved when the file is loaded in a DAW
// (Ableton / Logic / Reaper / FL Studio all import marker meta-events as
// project markers). If `bpm` is provided we use it so bar-grid positions also
// land where the annotator placed them; otherwise we fall back to 120 BPM —
// marker *seconds* are unaffected by the choice.
//
// Hand-rolled rather than pulling in a JS MIDI library: the wire format we
// need is tiny (header + one track + a couple of meta-events) and avoiding
// the dependency keeps the bundle lean.

const MIDI_PPQ = 480;

export interface MidiMarkersOptions {
  /** Project tempo, used for tempo meta-event and tick conversion. Defaults to 120. */
  bpm?: number;
}

export function convertToMidiMarkers(
  sections: ExportSection[],
  opts: MidiMarkersOptions = {},
): Uint8Array {
  const bpm = opts.bpm && opts.bpm > 0 ? opts.bpm : 120;
  const usPerQuarter = Math.round(60_000_000 / bpm);
  const ticksPerSecond = (MIDI_PPQ * 1_000_000) / usPerQuarter;

  // Events: tempo, then markers (sorted ascending by time), then end-of-track.
  const sorted = [...sections].sort((a, b) => a.start - b.start);
  const absTicks: number[] = sorted.map((s) => Math.max(0, Math.round(s.start * ticksPerSecond)));

  const trackBytes: number[] = [];

  // Tempo: delta=0, 0xFF 0x51 0x03 [3 bytes BE us/quarter]
  trackBytes.push(...vlq(0), 0xFF, 0x51, 0x03,
    (usPerQuarter >> 16) & 0xFF, (usPerQuarter >> 8) & 0xFF, usPerQuarter & 0xFF);

  let prevTick = 0;
  for (let i = 0; i < sorted.length; i++) {
    const delta = absTicks[i] - prevTick;
    prevTick = absTicks[i];
    const label = sorted[i].section.replace(/[\r\n]+/g, ' ');
    const labelBytes = new TextEncoder().encode(label);
    trackBytes.push(...vlq(delta), 0xFF, 0x06, ...vlq(labelBytes.length), ...labelBytes);
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

export function manualToExportSections(ann: ManualAnnotation): ExportSection[] {
  const sections: ManualSection[] = ann.sections;
  return sections.map((s, i) => {
    const next = sections[i + 1]?.time;
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
 *  visibleGridLines, which already resolves tempoAnchors and per-beat
 *  beatOverrides — so the caller doesn't have to branch on gridMode. Each grid
 *  line becomes a zero-duration marker; the label is the 1-indexed
 *  Rekordbox-style string the UI shows (bar / bar.beat / bar.beat.frac, or
 *  "P<n>" for phrases). Returns [] when the song has no usable BPM or a
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
  const anchors = effectiveAnchors(info);
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
    anchors,
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
      label = `P${Math.floor((l.barNumber - 1) / PHRASE_BARS) + 1}`;
    } else {
      // beats / sub-beats — bar.beat, with a trailing fractional component for
      // off-grid sub-beats (e.g. "1.3.5" for the 8th after bar 1 beat 3).
      const barIdx = Math.floor(l.beatIndex / beatsPerBar);
      const beatInBar = l.beatIndex - barIdx * beatsPerBar;
      const intBeat = Math.floor(beatInBar);
      const frac = beatInBar - intBeat;
      label = `${barIdx + 1}.${intBeat + 1}`;
      // frac is an exact binary fraction (½ / ¼ / ¾) so its decimals are stable.
      if (frac > 1e-6) label += `.${String(frac).slice(2)}`;
    }
    sections.push({ start: Math.max(0, l.t), duration: 0, section: label });
  }
  return sections;
}
