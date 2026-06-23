/**
 * ExportManagerModal — advanced multi-scope / multi-layer / multi-format
 * exporter. Triggered from the Download dropdown's "Advanced Export Manager"
 * entry. Built on Radix Dialog so we get focus trap, Esc-to-close, and
 * pointer-outside-to-close for free.
 *
 * Behaviour
 *  - Scope: current track | selected tracks (multi-select) | entire dataset
 *  - Layers: manual / eye / auto-guess / cues / spans / loops / patterns
 *    (any subset, must pick at least one)
 *  - Formats: any subset of TimeCues JSON | Audacity Label Track |
 *    Sonic Visualiser CSV | JAMS | mir_eval | MIDI markers | REAPER regions.
 *    Picking >1 format duplicates each emitted file across the chosen formats
 *    (forces a .zip). Patterns are JSON-only — non-JSON formats just skip
 *    pattern files.
 *  - Auto-bundle: any time we'd produce >1 file, output is forced into a
 *    single .zip with a per-song directory layout:
 *      <slug>/boundaries/{manual|eye|auto-guess}/<slug>.<ext>
 *      <slug>/{cues|spans|loops|patterns}/<layer-name>.<ext>
 *      <slug>/{song-info.json, audio.<ext>, algos/…, stems/…}
 *    Multi-annotator corpus dumps (Entire dataset + researcher tier) insert an
 *    <annotator-id> sub-dir inside the type dir per (slug, type) when more
 *    than one annotator contributed.
 */

import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import JSZip from 'jszip';
import type {
  ManualAnnotation,
  AutoGuessManualAnnotation,
} from '../../types/manualAnnotation';
import type {
  AnnotationLayersDocument,
  AnnotationLayer,
  CueItem,
  SpanItem,
  LoopItem,
} from '../../types/annotationLayer';
import { getCurrentAnnotatorId } from '../../context/AnnotatorContext';
import { useSettings } from '../../context/SettingsContext';
import { annotatorHeaders } from '../../utils/annotatorHeaders';
import {
  convertToAudacity,
  convertToJams,
  convertToMidiMarkers,
  convertToMirEval,
  convertToReaper,
  convertToSonicVisualiser,
  manualToExportSections,
  autoGuessAcceptedToExportSections,
  cueItemsToExportSections,
  spanItemsToExportSections,
  loopItemsToExportSections,
  gridToExportSections,
} from '../../utils/exportSerializers';
import type { ExportSection, JamsLayerKind, GridExportGranularity } from '../../utils/exportSerializers';
import { loadSongInfo } from '../../services/songInfo';
import type { SongInfo } from '../../types/songInfo';
import { loadAllAnnotatorLayers, loadLayers } from '../../services/annotationLayers';
import type { BoundarySource } from './shared/tabConfig';

type Scope = 'current' | 'selected' | 'all';
/** Built-in single-document layers (server has per-kind APIs + bulk endpoint).
 *  Same shape as `BoundarySource` — re-aliased here for export-modal semantics. */
type ManualLayer = BoundarySource;
/** User-created layer types persisted in annotation-layers documents.
 *  `loops` and `patterns` are gated by `experimentalLoopsAndPatterns`. */
type UserLayer = 'cues' | 'spans' | 'loops' | 'patterns';
type Layer = ManualLayer | UserLayer;
type Format = 'json' | 'audacity' | 'sonicVis' | 'jams' | 'mirEval' | 'midi' | 'reaper';

const FORMAT_EXT: Record<Format, string> = {
  json: 'json',
  audacity: 'txt',
  sonicVis: 'csv',
  jams: 'jams',
  mirEval: 'lab',
  midi: 'mid',
  reaper: 'csv',
};

const JAMS_LAYER_KIND: Record<ManualLayer, 'manual' | 'eye' | 'auto-guess'> = {
  manual: 'manual',
  eye: 'eye',
  autoGuess: 'auto-guess',
};

/** In-zip directory for each layer type. Boundary kinds (manual/eye/
 *  auto-guess) are nested under `boundaries/` so all three sit together inside
 *  each song folder; user-layer kinds (cues/spans/loops/patterns) sit as
 *  siblings of `boundaries/`. */
const LAYER_DIR: Record<Layer, string> = {
  manual: 'boundaries/manual',
  eye: 'boundaries/eye',
  autoGuess: 'boundaries/auto-guess',
  cues: 'cues',
  spans: 'spans',
  loops: 'loops',
  patterns: 'patterns',
};

const LAYER_LABEL: Record<Layer, string> = {
  manual: 'Boundaries (ground truth)',
  eye: 'Eye (visual only)',
  autoGuess: 'Auto-Guess (algorithm clustering)',
  cues: 'Cues (timestamped events)',
  spans: 'Spans (labeled intervals)',
  loops: 'Loops (bar-quantised regions)',
  patterns: 'Patterns (repeating motifs)',
};

const ALL_LAYERS: Layer[] = ['manual', 'eye', 'autoGuess', 'cues', 'spans', 'loops', 'patterns'];

/** Whether a (layer, format) pair has a sensible serializer.
 *  - Marker formats (audacity/sonicVis/jams/mirEval/midi/reaper) work for any
 *    point or interval layer.
 *  - Patterns are inherently cyclical with sub-beat highlights; no flat marker
 *    format expresses that, so we restrict them to TimeCues JSON.
 *  - JSON works for everything (it's the layer's own document shape). */
function layerSupportsFormat(layer: Layer, format: Format): boolean {
  if (format === 'json') return true;
  if (layer === 'patterns') return false;
  return true;
}

interface SongEntry {
  id: string;
  name: string;
  /** Audio URL on the dev server (e.g. `/audio/<filename>.mp3`).
   *  Optional — only needed when the user opts to bundle audio. */
  url?: string;
  /** Original audio filename, used to derive the in-zip extension. */
  file?: string;
}

export interface ExportManagerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current track in focus, used for the "Current Track" scope and as a label hint. */
  currentSong: SongEntry | null;
  /** Full song catalogue (from manifest) for the multi-select. */
  allSongs: SongEntry[];
  /** Already-loaded annotations for the current song, used for the fast single-song path. */
  manualAnnotation: ManualAnnotation | null;
  eyeAnnotation: ManualAnnotation | null;
  autoGuessAnnotation: AutoGuessManualAnnotation | null;
  /** Already-loaded user layers for the current song (cues/spans/loops/patterns).
   *  When null the modal lazy-loads them for the current-song scope path. */
  layersDocument?: AnnotationLayersDocument | null;
  /** UI variant. `'single'` locks scope to the current track and hides the
   *  scope picker — used from the per-song /annotate header. `'multi'`
   *  exposes the full scope/bucket controls — used from the /prep sidebar. */
  presentation?: 'single' | 'multi';
}

interface CacheEntry {
  /** Static URL the client should fetch (null when this entry came inline). */
  url: string | null;
  /** Inline file contents when the file lives outside Vite's static roots
   *  (e.g. data/algorithm-outputs/{bpm-detections,algo-clusters}/<slug>.json).
   *  Either `url` or `inline` is non-null, never both. */
  inline: string | null;
  /** Filename used inside the zip — preserves the source basename. */
  name: string;
}

interface SongCacheListing {
  slug: string;
  /** Backend's per-song fileStem (audio basename without ext). Used to route
   *  stems entries into a stable in-zip subdirectory. */
  fileStem: string;
  analysis: CacheEntry[];
  stems: CacheEntry[];
}

async function fetchSongCacheListing(slug: string): Promise<SongCacheListing> {
  const empty: SongCacheListing = { slug, fileStem: slug, analysis: [], stems: [] };
  try {
    const res = await fetch(`/api/song-cache-listing/${encodeURIComponent(slug)}`);
    if (!res.ok) return empty;
    const data = (await res.json()) as Partial<SongCacheListing>;
    return {
      slug: data.slug ?? slug,
      fileStem: data.fileStem ?? slug,
      analysis: Array.isArray(data.analysis) ? (data.analysis as CacheEntry[]) : [],
      stems: Array.isArray(data.stems) ? (data.stems as CacheEntry[]) : [],
    };
  } catch {
    return empty;
  }
}

// ─── Bulk fetch helpers ──────────────────────────────────────────────────────

interface BulkSingle<T> {
  annotations: Record<string, T>;
}

interface BulkAllAnnotators<T> {
  annotations: Record<string /*slug*/, Record<string /*annotator*/, T>>;
}

/** Bulk fetch annotations for the *current* annotator. Returns slug → ann. */
async function fetchBulkMine<T>(kind: 'manual' | 'eye' | 'auto-guess'): Promise<Record<string, T>> {
  const res = await fetch(`/api/bulk-annotations/${kind}`, {
    headers: annotatorHeaders(),
  });
  if (!res.ok) return {};
  const data = (await res.json()) as BulkSingle<T>;
  return data.annotations ?? {};
}

/** Bulk fetch annotations across every annotator (researcher/admin only).
 *  Returns slug → annotator → ann. Empty `{}` on auth failure — caller is
 *  expected to fall back to the current-annotator shape. */
async function fetchBulkAll<T>(kind: 'manual' | 'eye' | 'auto-guess'): Promise<Record<string, Record<string, T>>> {
  const res = await fetch(`/api/bulk-annotations/${kind}?scope=all`, {
    headers: annotatorHeaders(),
  });
  if (!res.ok) return {};
  const data = (await res.json()) as BulkAllAnnotators<T>;
  return data.annotations ?? {};
}

function todayStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Probe an audio URL for its duration using HTMLAudioElement metadata
 *  preload. Browser fetches just enough bytes to read the format header —
 *  no full decode, no AudioBuffer allocation. Resolves to null on network
 *  error, format error, or missing/non-finite duration. */
function probeAudioDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = 'metadata';
    const cleanup = () => {
      a.onloadedmetadata = null;
      a.onerror = null;
      // Drop the src so the browser stops streaming if it hadn't finished.
      a.removeAttribute('src');
      a.load();
    };
    a.onloadedmetadata = () => {
      const d = a.duration;
      cleanup();
      resolve(Number.isFinite(d) && d > 0 ? d : null);
    };
    a.onerror = () => { cleanup(); resolve(null); };
    a.src = url;
  });
}

// Run an async mapper over items with a bounded number of in-flight tasks.
// Large-audio exports were fetching every song's full body at once via an
// unbounded Promise.all; under that load individual fetches/res.blob() calls
// abort, and because each failure was caught-and-skipped the archive shipped
// silently without the songs. Capping concurrency keeps each transfer healthy.
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await mapper(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function triggerBlobDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ─── Per-format serialization (any layer → string) ───────────────────────────

/** The single place that maps already-flattened ExportSections to a flat
 *  marker format. Every layer serializer + the grid-labels sidecar route
 *  through here, so a format's quirks (column order, precision, JAMS metadata)
 *  live in exactly one spot and can't drift between callers. JSON is excluded
 *  because each layer emits its own native document shape — callers handle it
 *  before reaching this. */
function sectionsToMarkerFormat(
  sections: ExportSection[],
  format: Exclude<Format, 'json'>,
  ctx: { slug: string; jamsLayer: JamsLayerKind; annotatorId: string | null; bpm?: number },
): string | Uint8Array {
  if (format === 'audacity') return convertToAudacity(sections);
  if (format === 'sonicVis') return convertToSonicVisualiser(sections);
  if (format === 'mirEval') return convertToMirEval(sections);
  if (format === 'midi') return convertToMidiMarkers(sections, { bpm: ctx.bpm });
  if (format === 'reaper') return convertToReaper(sections);
  return convertToJams(sections, {
    slug: ctx.slug,
    layer: ctx.jamsLayer,
    annotatorId: ctx.annotatorId,
  });
}

function serializeManual(
  ann: ManualAnnotation,
  format: Format,
  ctx: { slug: string; layer: ManualLayer; annotatorId: string | null; bpm?: number },
): string | Uint8Array {
  if (format === 'json') return JSON.stringify(ann, null, 2);
  return sectionsToMarkerFormat(manualToExportSections(ann), format, {
    slug: ctx.slug,
    jamsLayer: JAMS_LAYER_KIND[ctx.layer],
    annotatorId: ctx.annotatorId,
    bpm: ctx.bpm,
  });
}

/** Filter the layers in a document to a single user-layer type, returning the
 *  raw layer documents (multiple layers of the same type can coexist per song —
 *  e.g. "Kick hits" + "FX triggers" are both Cues layers). */
function filterUserLayers<T extends UserLayer>(
  doc: AnnotationLayersDocument,
  type: T,
): AnnotationLayer[] {
  return doc.layers.filter((l) => l.type === type);
}

/** Serialize a single user layer. Patterns + JSON return the layer document
 *  itself; everything else flattens through the shared ExportSection helpers
 *  in exportSerializers.ts. */
function serializeUserLayer(
  layer: AnnotationLayer,
  format: Format,
  ctx: { slug: string; annotatorId: string | null; bpm?: number },
): string | Uint8Array | null {
  if (format === 'json') return JSON.stringify(layer, null, 2);
  if (layer.type === 'patterns') return null;
  let sections;
  if (layer.type === 'cues') sections = cueItemsToExportSections(layer.items as CueItem[]);
  else if (layer.type === 'spans') sections = spanItemsToExportSections(layer.items as SpanItem[]);
  else if (layer.type === 'loops') sections = loopItemsToExportSections(layer.items as LoopItem[]);
  else return null;
  return sectionsToMarkerFormat(sections, format, {
    slug: ctx.slug,
    // JAMS namespace is open-vocab segment_open; reusing the manual kind keeps
    // downstream tooling happy. The layer name is in the file path.
    jamsLayer: 'manual',
    annotatorId: ctx.annotatorId,
    bpm: ctx.bpm,
  });
}

/** Slugify a layer name so it's safe to put in a zip path (e.g. "Kick hits"
 *  → "kick-hits"). Layers of the same type with the same slugified name fall
 *  back to a numeric suffix in the caller. */
function slugifyLayerName(name: string): string {
  return (name || 'layer')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'layer';
}

function serializeAutoGuess(
  ann: AutoGuessManualAnnotation,
  format: Format,
  ctx: { slug: string; annotatorId: string | null; bpm?: number },
): string | Uint8Array {
  if (format === 'json') return JSON.stringify(ann, null, 2);
  return sectionsToMarkerFormat(autoGuessAcceptedToExportSections(ann), format, {
    slug: ctx.slug,
    jamsLayer: 'auto-guess',
    annotatorId: ctx.annotatorId,
    bpm: ctx.bpm,
  });
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ExportManagerModal({
  open,
  onOpenChange,
  currentSong,
  allSongs,
  manualAnnotation,
  eyeAnnotation,
  autoGuessAnnotation,
  layersDocument,
  presentation = 'multi',
}: ExportManagerModalProps) {
  const { settings } = useSettings();
  const showLoopsAndPatterns = settings.experimentalLoopsAndPatterns;
  const showEye = settings.experimentalEyeAnnotation;

  // Single-presentation locks scope to the current track. The selectable
  // layer set still allows everything available for the current song.
  const [scope, setScope] = useState<Scope>('current');
  useEffect(() => {
    if (presentation === 'single') setScope('current');
  }, [presentation]);

  const [selectedSlugs, setSelectedSlugs] = useState<Set<string>>(() => new Set());
  const [layers, setLayers] = useState<Record<Layer, boolean>>({
    manual: true, eye: false, autoGuess: false,
    cues: true, spans: true, loops: true, patterns: true,
  });
  const [selectedFormats, setSelectedFormats] = useState<Set<Format>>(() => new Set(['json']));
  const toggleFormat = (fmt: Format) => {
    setSelectedFormats((prev) => {
      const next = new Set(prev);
      if (next.has(fmt)) next.delete(fmt);
      else next.add(fmt);
      return next;
    });
  };
  const formatsArr = useMemo(() => Array.from(selectedFormats), [selectedFormats]);
  const anyNonJsonFormat = formatsArr.some((f) => f !== 'json');
  const [zipToggle, setZipToggle] = useState(false);
  // Audio bundling: each in-scope song's audio file is added at <slug>/audio.<ext>.
  // Forces a zip output.
  const [includeAudio, setIncludeAudio] = useState(false);
  // Algorithm-cache bundling (multi only): per-song /analysis/<slug>/*.json
  // files. Adds the bytes the Storage Stats panel calls "Analysis" + "MSAF raw"
  // + "BPM" + "Algo clusters".
  const [includeAlgos, setIncludeAlgos] = useState(false);
  // Stems bundling (multi only): Demucs WAVs + manifest under <slug>/stems/.
  // Often the biggest contributor to a bundle (~100MB+ per song).
  const [includeStems, setIncludeStems] = useState(false);
  // Grid metadata bundling: each in-scope song's BPM/TS/offset/locked flag is
  // exported as <slug>/song-info.json (read from /api/song-info).
  // Defaults to true because annotations are timing-meaningless without the
  // grid that produced them.
  const [includeSongInfo, setIncludeSongInfo] = useState(true);
  // Resolution of the grid-labels sidecar (one marker per bar / beat / sub-beat
  // / phrase). 'off' suppresses the sidecar entirely; 'beats' matches the
  // historic one-label-per-beat behaviour and is the default.
  const [gridGranularity, setGridGranularity] = useState<GridExportGranularity | 'off'>('beats');
  const [busy, setBusy] = useState(false);
  const [zipProgress, setZipProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [trackPickerOpen, setTrackPickerOpen] = useState(false);
  const [trackFilter, setTrackFilter] = useState('');
  // Per-slug audio byte counts (null = HEAD failed / no content-length).
  // Populated lazily when includeAudio flips on, so we don't HEAD-spam.
  const [audioSizes, setAudioSizes] = useState<Map<string, number | null>>(() => new Map());
  const [audioSizesLoading, setAudioSizesLoading] = useState(false);
  // Actual byte size of the most recent zip we generated this session.
  const [lastZipBytes, setLastZipBytes] = useState<number | null>(null);

  // Reset transient UI state whenever the dialog re-opens.
  useEffect(() => {
    if (open) {
      setError(null);
      setWarning(null);
      setBusy(false);
      setZipProgress(null);
      setTrackPickerOpen(false);
    }
  }, [open]);

  // Fetch audio file sizes (HEAD → Content-Length) whenever the user has
  // opted into audio bundling and the in-scope song set changes. This lets
  const inScopeSlugs = useMemo<string[]>(() => {
    if (scope === 'current') return currentSong ? [currentSong.id] : [];
    if (scope === 'selected') return Array.from(selectedSlugs);
    return allSongs.map((s) => s.id);
  }, [scope, currentSong, selectedSlugs, allSongs]);

  // us show a "before zip" estimate so users know the download size up-front.
  useEffect(() => {
    if (!open || !includeAudio) {
      setAudioSizes(new Map());
      setAudioSizesLoading(false);
      return;
    }
    const songsById = new Map(allSongs.map((s) => [s.id, s] as const));
    if (currentSong) songsById.set(currentSong.id, currentSong);
    const targets = inScopeSlugs.slice();
    let cancelled = false;
    setAudioSizesLoading(true);
    (async () => {
      const next = new Map<string, number | null>();
      await Promise.all(
        targets.map(async (slug) => {
          const entry = songsById.get(slug);
          if (!entry?.url) { next.set(slug, null); return; }
          try {
            const res = await fetch(entry.url, { method: 'HEAD', headers: annotatorHeaders() });
            const len = res.headers.get('content-length');
            next.set(slug, len ? Number.parseInt(len, 10) : null);
          } catch {
            next.set(slug, null);
          }
        }),
      );
      if (!cancelled) {
        setAudioSizes(next);
        setAudioSizesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, includeAudio, inScopeSlugs, allSongs, currentSong]);

  const audioTotal = useMemo(() => {
    let bytes = 0;
    let known = 0;
    let unknown = 0;
    for (const v of audioSizes.values()) {
      if (v == null) unknown++;
      else { bytes += v; known++; }
    }
    return { bytes, known, unknown };
  }, [audioSizes]);

  // Layer kinds currently surfaced in the UI. Patterns/Loops and Eye are
  // hidden when their experimental flag is off so we don't tease the UI.
  const visibleLayerKinds: Layer[] = useMemo(() => {
    return ALL_LAYERS.filter((k) => {
      if ((k === 'loops' || k === 'patterns') && !showLoopsAndPatterns) return false;
      if (k === 'eye' && !showEye) return false;
      // Patterns can't be expressed in any flat marker format. With multiple
      // formats, the layer stays visible as long as at least one selected
      // format can carry it (i.e. JSON is in the set when Patterns is the
      // layer in question).
      if (formatsArr.length > 0 && !formatsArr.some((f) => layerSupportsFormat(k, f))) {
        return false;
      }
      return true;
    });
  }, [showLoopsAndPatterns, showEye, formatsArr]);

  const activeLayers: Layer[] = useMemo(
    () => visibleLayerKinds.filter((k) => layers[k]),
    [layers, visibleLayerKinds],
  );

  const targetSongCount = inScopeSlugs.length;

  // Annotation file count accounts for per-layer format support: a (slug,
  // layer) emits one file per selected format that actually serializes for
  // that layer (Patterns × any-non-JSON contributes zero).
  const annotationFileCount = useMemo(() => {
    let n = 0;
    for (const l of activeLayers) {
      n += targetSongCount * formatsArr.filter((f) => layerSupportsFormat(l, f)).length;
    }
    return n;
  }, [activeLayers, targetSongCount, formatsArr]);

  // The spec's auto-bundle test: more than one file is produced. Includes
  // per-format duplication, so picking >1 format always forces a .zip.
  const isMultiExport = annotationFileCount > 1;
  // Anything that produces extra files (audio, song-info, algos, stems) also
  // forces zip, since they live at distinct paths inside the archive.
  const willZip = isMultiExport
    || zipToggle
    || includeAudio
    || includeSongInfo
    || includeAlgos
    || includeStems;

  const filteredSongs = useMemo(() => {
    const q = trackFilter.trim().toLowerCase();
    if (!q) return allSongs;
    return allSongs.filter(
      (s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q),
    );
  }, [trackFilter, allSongs]);

  // The user can export when at least one bucket is producing files for the
  // in-scope songs: a selected layer (paired with ≥1 format), audio, grid
  // metadata, algo caches, or stems. A "stems-only" or "audio-only" download
  // is a valid /prep workflow.
  const hasAnnotationBucket = activeLayers.length > 0 && formatsArr.length > 0;
  const hasAnyBucket =
    hasAnnotationBucket ||
    includeAudio ||
    includeSongInfo ||
    includeAlgos ||
    includeStems;
  const canExport = !busy && targetSongCount > 0 && hasAnyBucket;

  // ─── Export action ─────────────────────────────────────────────────────────
  const runExport = async () => {
    setError(null);
    setWarning(null);
    setBusy(true);
    try {
      const stamp = todayStamp();

      // Resolve the target slug list.
      const slugs: string[] =
        scope === 'current' ? (currentSong ? [currentSong.id] : []) :
        scope === 'selected' ? Array.from(selectedSlugs) :
        allSongs.map((s) => s.id);

      // Build per-layer maps shaped as `slug → annotatorId → ann`, so the
      // emit loop can decide per (slug, kind) whether to insert an annotator
      // dir in the zip path (only when more than one annotator contributed).
      const currentAnnotatorId = getCurrentAnnotatorId() ?? 'unknown';
      const manualMap: Record<string, Record<string, ManualAnnotation>> = {};
      const eyeMap: Record<string, Record<string, ManualAnnotation>> = {};
      const autoGuessMap: Record<string, Record<string, AutoGuessManualAnnotation>> = {};
      const layerDocs: Record<string, Record<string, AnnotationLayersDocument>> = {};
      const needAnyUserLayer =
        (layers.cues || layers.spans || layers.loops || layers.patterns) &&
        // Patterns drop out of every non-JSON format — skip the fetch if the
        // only requested user layer is patterns and the user picked, say,
        // Audacity. layerSupportsFormat would otherwise have un-checked it.
        activeLayers.some((l) => l === 'cues' || l === 'spans' || l === 'loops' || l === 'patterns');

      const wrapSingle = <T,>(map: Record<string, Record<string, T>>, slug: string, ann: T) => {
        if (!map[slug]) map[slug] = {};
        map[slug][currentAnnotatorId] = ann;
      };

      if (scope === 'current' && currentSong) {
        if (layers.manual && manualAnnotation) wrapSingle(manualMap, currentSong.id, manualAnnotation);
        if (layers.eye && eyeAnnotation) wrapSingle(eyeMap, currentSong.id, eyeAnnotation);
        if (layers.autoGuess && autoGuessAnnotation) wrapSingle(autoGuessMap, currentSong.id, autoGuessAnnotation);
        if (needAnyUserLayer) {
          // Prefer the already-loaded layers document so we don't re-hit the
          // server. Fall back to a fetch when the caller didn't pass one.
          const doc = layersDocument ?? await loadLayers(currentSong.id);
          if (doc.layers.length > 0) wrapSingle(layerDocs, currentSong.id, doc);
        }
      } else {
        // Corpus scope tries the cross-annotator endpoint first; non-researcher
        // callers transparently fall back to their own data only (the
        // {annotator} dir level just stays collapsed because there'll only be
        // one contributor per song).
        const wantsAllAnnotators = scope === 'all';
        const fetches: Promise<void>[] = [];

        const ingestMine = <T,>(map: Record<string, Record<string, T>>, mine: Record<string, T>) => {
          for (const slug of slugs) {
            const ann = mine[slug];
            if (!ann) continue;
            if (!map[slug]) map[slug] = {};
            map[slug][currentAnnotatorId] = ann;
          }
        };
        const ingestAll = <T,>(map: Record<string, Record<string, T>>, all: Record<string, Record<string, T>>) => {
          for (const slug of slugs) {
            const byAnn = all[slug];
            if (!byAnn) continue;
            map[slug] = { ...(map[slug] ?? {}), ...byAnn };
          }
        };
        const fetchKind = async <T,>(
          kind: 'manual' | 'eye' | 'auto-guess',
          map: Record<string, Record<string, T>>,
        ) => {
          if (wantsAllAnnotators) {
            const all = await fetchBulkAll<T>(kind);
            if (Object.keys(all).length > 0) { ingestAll(map, all); return; }
            // Fall back to mine — researcher gate failed or no cross-annotator data.
          }
          ingestMine(map, await fetchBulkMine<T>(kind));
        };

        if (layers.manual) fetches.push(fetchKind<ManualAnnotation>('manual', manualMap));
        if (layers.eye) fetches.push(fetchKind<ManualAnnotation>('eye', eyeMap));
        if (layers.autoGuess) fetches.push(fetchKind<AutoGuessManualAnnotation>('auto-guess', autoGuessMap));

        if (needAnyUserLayer) {
          fetches.push((async () => {
            let merged = false;
            if (wantsAllAnnotators) {
              const all = await loadAllAnnotatorLayers();
              if (Object.keys(all).length > 0) {
                for (const slug of slugs) {
                  const byAnn = all[slug];
                  if (!byAnn) continue;
                  layerDocs[slug] = { ...(layerDocs[slug] ?? {}), ...byAnn };
                }
                merged = true;
              }
            }
            if (!merged) {
              // Per-slug fallback — current annotator's data only.
              await Promise.all(slugs.map(async (slug) => {
                try {
                  const doc = await loadLayers(slug);
                  if (doc.layers.length > 0) {
                    if (!layerDocs[slug]) layerDocs[slug] = {};
                    layerDocs[slug][currentAnnotatorId] = doc;
                  }
                } catch (err) {
                  console.warn('[export-layers]', slug, err);
                }
              }));
            }
          })());
        }
        await Promise.all(fetches);
      }

      // MIDI export wants per-song BPM (from song-info) so DAW bar-grid
      // positions match the annotator's grid. The grid-labels sidecar (one
      // label per beat across the song) is now emitted for every selected
      // format, so song-info — which carries the BPM / time-signature /
      // tempo-anchors the grid is expanded from — is needed whenever any
      // format is selected. Pre-fetch it up-front.
      const songInfoMap: Record<string, SongInfo> = {};
      const songInfoFailures: string[] = [];
      if (includeSongInfo || selectedFormats.size > 0) {
        await Promise.all(slugs.map(async (slug) => {
          try {
            songInfoMap[slug] = await loadSongInfo(slug);
          } catch (err) {
            console.error('[export-songinfo]', slug, err);
            songInfoFailures.push(slug);
          }
        }));
      }

      // Collate into emit-able files. New hierarchy (see USER_GUIDE Export &
      // Import section): one folder per song slug holds boundaries/, every
      // user-layer kind, plus aux files (song-info, audio, algos, stems) as
      // siblings. Within each type dir we insert an {annotator} sub-dir only
      // when more than one annotator contributed for that (slug, kind) —
      // keeps single-annotator exports flat while still differentiating
      // multi-annotator corpus dumps.
      type Entry = { path: string; body: string | Blob | Uint8Array };
      const entries: Entry[] = [];
      const requestedFormats = formatsArr;

      /** Build the in-zip parent dir for a (slug, type, annotator) tuple,
       *  collapsing the annotator level when only one contributor exists. */
      const dirFor = (slug: string, layer: Layer, annotatorId: string, contributors: number): string => {
        const base = `${slug}/${LAYER_DIR[layer]}`;
        return contributors > 1 ? `${base}/${annotatorId}` : base;
      };

      for (const slug of slugs) {
        const bpm = songInfoMap[slug]?.bpm;

        // Boundary kinds — one document per annotator per song, per format.
        for (const kind of ['manual', 'eye', 'autoGuess'] as ManualLayer[]) {
          if (!layers[kind]) continue;
          const byAnn =
            kind === 'manual' ? manualMap[slug] :
            kind === 'eye' ? eyeMap[slug] :
            autoGuessMap[slug];
          if (!byAnn) continue;
          const annotatorIds = Object.keys(byAnn);
          for (const annId of annotatorIds) {
            const ann = byAnn[annId];
            const dir = dirFor(slug, kind, annId, annotatorIds.length);
            const ctx = { slug, annotatorId: annId, bpm };
            for (const fmt of requestedFormats) {
              if (!layerSupportsFormat(kind, fmt)) continue;
              const fmtExt = FORMAT_EXT[fmt];
              const body = kind === 'autoGuess'
                ? serializeAutoGuess(ann as AutoGuessManualAnnotation, fmt, ctx)
                : serializeManual(ann as ManualAnnotation, fmt, { ...ctx, layer: kind });
              entries.push({ path: `${dir}/${slug}.${fmtExt}`, body });
            }
          }
        }

        // User-layer kinds — one file per (annotator, layer-of-that-kind, format).
        // A single annotator may have multiple layers of the same kind
        // (e.g. "Kick hits" + "FX triggers" Cues); each becomes its own file.
        const byAnnLayers = layerDocs[slug];
        if (byAnnLayers) {
          for (const userKind of ['cues', 'spans', 'loops', 'patterns'] as UserLayer[]) {
            if (!layers[userKind]) continue;
            const fmtsForKind = requestedFormats.filter((f) => layerSupportsFormat(userKind, f));
            if (fmtsForKind.length === 0) continue;
            // Only annotators with ≥1 layer of this kind count as contributors
            // — keeps the {annotator} dir collapsed when one person did Cues
            // and another did Spans (no overlap on this kind).
            const contributors = Object.entries(byAnnLayers).filter(
              ([, doc]) => filterUserLayers(doc, userKind).length > 0,
            );
            if (contributors.length === 0) continue;
            const annotatorCount = contributors.length;
            for (const [annId, doc] of contributors) {
              const ls = filterUserLayers(doc, userKind);
              const usedNames = new Map<string, number>();
              for (const layer of ls) {
                const baseName = slugifyLayerName(layer.name);
                const collisions = (usedNames.get(baseName) ?? 0);
                usedNames.set(baseName, collisions + 1);
                const finalName = collisions === 0 ? baseName : `${baseName}-${collisions + 1}`;
                const dir = dirFor(slug, userKind, annId, annotatorCount);
                for (const fmt of fmtsForKind) {
                  const body = serializeUserLayer(layer, fmt, { slug, annotatorId: annId, bpm });
                  if (body == null) continue;
                  // Patterns are JSON-only — fmtsForKind already filters out
                  // non-JSON formats, but the per-layer ext override stays as
                  // defensive belt-and-braces.
                  const layerExt = userKind === 'patterns' ? 'json' : FORMAT_EXT[fmt];
                  entries.push({ path: `${dir}/${finalName}.${layerExt}`, body });
                }
              }
            }
          }
        }
      }

      // Bundle grid metadata (BPM / TS / offset) as <slug>/song-info.json
      // from the map we already populated. Dataset-wide lock state lives in
      // data/dataset-config.json and is not bundled here.
      if (includeSongInfo) {
        for (const slug of slugs) {
          const info = songInfoMap[slug];
          if (info) {
            entries.push({
              path: `${slug}/song-info.json`,
              body: JSON.stringify(info, null, 2),
            });
          }
        }
      }

      // Grid-labels sidecar — one marker per bar / beat / sub-beat / phrase
      // (user-chosen via gridGranularity) across the song, emitted as an
      // individual labels file once per selected format (not just Audacity).
      // The grid is expanded once per song via gridToExportSections — active
      // grid mode (static / dynamic / manual) is resolved through
      // visibleGridLines, so anchors and per-beat overrides are honored without
      // branching here — then each format serializes through the same shared
      // path the layers use (sectionsToMarkerFormat / the cue-list JSON shape),
      // so there's a single source of truth per format. JSON ships the expanded
      // grid as a re-importable cue list, complementing (not replacing) the
      // grid params in song-info.json. Duration is probed from the audio URL
      // using HTMLAudioElement metadata; skipped silently for songs with no
      // URL, no BPM, or a failed probe. 'off' suppresses the sidecar entirely.
      const gridFailures: string[] = [];
      const gridFormats = [...selectedFormats];
      if (gridGranularity !== 'off' && gridFormats.length > 0) {
        const songsById = new Map(allSongs.map((s) => [s.id, s] as const));
        if (currentSong) songsById.set(currentSong.id, currentSong);
        await Promise.all(slugs.map(async (slug) => {
          const info = songInfoMap[slug];
          if (!info || !Number.isFinite(info.bpm) || !info.bpm) return;
          const entry = songsById.get(slug);
          if (!entry?.url) { gridFailures.push(`${slug} (no url)`); return; }
          const duration = await probeAudioDuration(entry.url);
          if (duration == null) { gridFailures.push(`${slug} (duration probe failed)`); return; }
          const sections = gridToExportSections(info, duration, gridGranularity);
          if (sections.length === 0) return;
          for (const fmt of gridFormats) {
            const body = fmt === 'json'
              ? JSON.stringify(
                  sections.map((s) => ({ time: s.start, label: s.section })),
                  null,
                  2,
                )
              : sectionsToMarkerFormat(sections, fmt, {
                  slug,
                  jamsLayer: 'grid',
                  annotatorId: null,
                  bpm: info.bpm,
                });
            entries.push({ path: `${slug}/grid/${slug}.${FORMAT_EXT[fmt]}`, body });
          }
        }));
      }

      // Bundle algo caches + stems for each in-scope song. We hit a small
      // backend endpoint that lists per-song cache files (analysis + stems
      // URLs); the client then fetches each file and adds it to the zip at a
      // stable path. Missing files are skipped silently. Bucket toggles are
      // hidden in `single` presentation mode but the runtime guard is still
      // present so a custom caller can't accidentally pull megabytes of cache.
      const cacheFailures: string[] = [];
      const stemFailures: string[] = [];
      if ((includeAlgos || includeStems) && presentation === 'multi') {
        const listings = await mapWithConcurrency(slugs, 6, async (slug) => ({
          slug,
          listing: await fetchSongCacheListing(slug),
        }));
        await mapWithConcurrency(listings, 4, async ({ slug, listing }) => {
          if (includeAlgos) {
            await Promise.all(listing.analysis.map(async (entry) => {
              // Inline entries (data/algorithm-outputs/*) ship as plain JSON.
              if (entry.inline != null) {
                entries.push({ path: `${slug}/algos/${entry.name}`, body: entry.inline });
                return;
              }
              if (!entry.url) return;
              try {
                const res = await fetch(entry.url, { headers: annotatorHeaders() });
                if (!res.ok) { cacheFailures.push(`${slug} ${entry.url}`); return; }
                const blob = await res.blob();
                entries.push({ path: `${slug}/algos/${entry.name}`, body: blob });
              } catch (err) {
                console.error('[export-algos]', slug, entry.url, err);
                cacheFailures.push(`${slug} ${entry.url}`);
              }
            }));
          }
          if (includeStems) {
            await Promise.all(listing.stems.map(async (entry) => {
              if (!entry.url) return;
              try {
                const res = await fetch(entry.url, { headers: annotatorHeaders() });
                if (!res.ok) { stemFailures.push(`${slug} ${entry.url}`); return; }
                const blob = await res.blob();
                entries.push({ path: `${slug}/stems/${entry.name}`, body: blob });
              } catch (err) {
                console.error('[export-stems]', slug, entry.url, err);
                stemFailures.push(`${slug} ${entry.url}`);
              }
            }));
          }
        });
      }

      // Bundle audio for each in-scope song, in parallel. Skipped silently for
      // any song that lacks a usable URL or whose fetch fails (we don't want to
      // fail the entire archive over a single missing audio).
      const audioFailures: string[] = [];
      if (includeAudio) {
        const songsById = new Map(allSongs.map((s) => [s.id, s] as const));
        if (currentSong) songsById.set(currentSong.id, currentSong);
        const fetched = (await mapWithConcurrency(slugs, 4, async (slug) => {
          const entry = songsById.get(slug);
          if (!entry?.url) { audioFailures.push(`${slug} (no url)`); return null; }
          try {
            const res = await fetch(entry.url, { headers: annotatorHeaders() });
            if (!res.ok) { audioFailures.push(`${slug} (HTTP ${res.status})`); return null; }
            const blob = await res.blob();
            const audioExt = (entry.file?.match(/\.[a-z0-9]+$/i)?.[0]
              ?? entry.url.match(/\.[a-z0-9]+$/i)?.[0]
              ?? '.mp3').toLowerCase();
            return { path: `${slug}/audio${audioExt}`, body: blob } as Entry;
          } catch (err) {
            console.error('[export-audio]', slug, err);
            audioFailures.push(`${slug} (${err instanceof Error ? err.message : 'network'})`);
            return null;
          }
        })).filter((e): e is Entry => e !== null);
        entries.push(...fetched);
      }

      if (entries.length === 0) {
        setError('Nothing to export — no matching annotations found for the selected scope.');
        setBusy(false);
        return;
      }

      if (willZip) {
        const zip = new JSZip();
        for (const e of entries) {
          // Audio/stems/algo binaries make up the bulk of large exports and are
          // already compact (mp3/flac/wav blobs). DEFLATE-ing ~1GB of them in
          // single-threaded JS takes minutes and makes the tab look frozen — the
          // classic "stuck export". Store binaries uncompressed (near-instant,
          // just CRC + concat) and only DEFLATE the tiny text bodies (JSON/CSV/
          // markers), where compression actually pays off.
          const compression = typeof e.body === 'string' ? 'DEFLATE' : 'STORE';
          zip.file(e.path, e.body, { compression });
        }
        setZipProgress(0);
        const blob = await zip.generateAsync(
          // streamFiles avoids buffering each entry twice while packing.
          { type: 'blob', streamFiles: true },
          (meta) => setZipProgress(meta.percent),
        );
        setZipProgress(null);
        setLastZipBytes(blob.size);
        const tag = includeAudio ? 'with-audio' : 'export';
        triggerBlobDownload(`timecues-${tag}-${stamp}.zip`, blob);
        if (audioFailures.length > 0) console.warn('[export] audio skipped for:', audioFailures);
        if (songInfoFailures.length > 0) console.warn('[export] song-info skipped for:', songInfoFailures);
        if (gridFailures.length > 0) console.warn('[export] grid-labels skipped for:', gridFailures);
        if (cacheFailures.length > 0) console.warn('[export] algo caches skipped for:', cacheFailures);
        if (stemFailures.length > 0) console.warn('[export] stems skipped for:', stemFailures);
        // Surface dropped content so a partial archive is never mistaken for a
        // complete one. Audio especially — a "with-audio" zip that quietly
        // shipped without songs is the bug we're guarding against here.
        const skips: string[] = [];
        if (audioFailures.length > 0) skips.push(`${audioFailures.length} audio`);
        if (stemFailures.length > 0) skips.push(`${stemFailures.length} stem file(s)`);
        if (cacheFailures.length > 0) skips.push(`${cacheFailures.length} algo file(s)`);
        if (skips.length > 0) {
          setWarning(
            `Exported, but skipped ${skips.join(', ')} (fetch failed). `
            + 'See the browser console for the list. The archive is incomplete.',
          );
        }
      } else {
        // Exactly one file — flatten the path so the user gets just <slug>.<ext>.
        const only = entries[0];
        const flat = only.path.split('/').pop() ?? only.path;
        if (typeof only.body === 'string') {
          const onlyExt = (flat.match(/\.[a-z0-9]+$/i)?.[0] ?? '').toLowerCase();
          const mime =
            onlyExt === '.json' || onlyExt === '.jams' ? 'application/json' :
            onlyExt === '.csv' ? 'text/csv' : 'text/plain';
          triggerBlobDownload(flat, new Blob([only.body], { type: mime }));
        } else if (only.body instanceof Uint8Array) {
          // Cast: TS lib types Uint8Array as Uint8Array<ArrayBufferLike>, but
          // BlobPart only accepts ArrayBuffer-backed views (not SharedArrayBuffer).
          // The body here is always plain-ArrayBuffer-backed MIDI bytes.
          triggerBlobDownload(flat, new Blob([only.body as BlobPart], { type: 'audio/midi' }));
        } else {
          triggerBlobDownload(flat, only.body);
        }
      }

      setBusy(false);
      // Keep the modal open after an audio bundle so the user can see the
      // resulting zip size, or whenever something was skipped so the warning is
      // visible; otherwise close it as before.
      const hadSkips =
        audioFailures.length > 0 || stemFailures.length > 0 || cacheFailures.length > 0;
      if (!includeAudio && !hadSkips) onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed.');
      setBusy(false);
      setZipProgress(null);
    }
  };

  // ─── UI helpers ────────────────────────────────────────────────────────────

  const toggleLayer = (k: Layer) => setLayers((prev) => ({ ...prev, [k]: !prev[k] }));

  const toggleSlug = (slug: string) => {
    setSelectedSlugs((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[101] w-[min(720px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-white/[0.08] bg-[#14171d] shadow-2xl shadow-black/70 outline-none"
          aria-describedby={undefined}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
            <Dialog.Title className="text-[12px] font-semibold tracking-[0.18em] uppercase text-slate-100">
              {presentation === 'single'
                ? `Export — ${currentSong?.name ?? 'current track'}`
                : 'Advanced Export'}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="text-slate-500 hover:text-slate-200 text-lg leading-none w-6 h-6 flex items-center justify-center rounded hover:bg-white/[0.06]"
                aria-label="Close"
              >
                ×
              </button>
            </Dialog.Close>
          </div>

          {/* Body — three-column form (two when scope picker is hidden) */}
          <div className={`grid gap-5 px-5 py-4 ${presentation === 'single' ? 'grid-cols-2' : 'grid-cols-3'}`}>
            {/* Column 1: Scope (multi-presentation only) */}
            {presentation === 'multi' && (
            <Column title="Scope">
              <RadioRow
                name="scope" value="current" checked={scope === 'current'}
                onChange={() => setScope('current')}
                disabled={!currentSong}
                label="Current track"
                hint={currentSong?.name ?? 'No track loaded'}
              />
              <RadioRow
                name="scope" value="selected" checked={scope === 'selected'}
                onChange={() => setScope('selected')}
                disabled={allSongs.length === 0}
                label="Selected tracks"
                hint={selectedSlugs.size > 0 ? `${selectedSlugs.size} chosen` : 'Pick below'}
              />
              {scope === 'selected' && (
                <div className="ml-5 mt-1 mb-1">
                  <button
                    type="button"
                    onClick={() => setTrackPickerOpen((v) => !v)}
                    className="px-2 py-1 text-[11px] rounded bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 border border-white/[0.06]"
                  >
                    {trackPickerOpen ? 'Hide picker ▴' : 'Open picker ▾'}
                  </button>
                  {trackPickerOpen && (
                    <div className="mt-2 rounded border border-white/[0.06] bg-black/30 p-2">
                      <input
                        type="text"
                        placeholder="Filter songs…"
                        value={trackFilter}
                        onChange={(e) => setTrackFilter(e.target.value)}
                        className="w-full mb-2 px-2 py-1 text-[11px] rounded bg-white/[0.03] border border-white/[0.06] text-slate-200 placeholder:text-slate-600 outline-none focus:border-cyan-500/40"
                      />
                      <div className="max-h-40 overflow-y-auto pr-1 space-y-0.5">
                        {filteredSongs.length === 0 && (
                          <div className="text-[10px] text-slate-600 italic px-1 py-2">No matches</div>
                        )}
                        {filteredSongs.map((s) => {
                          const checked = selectedSlugs.has(s.id);
                          return (
                            <label
                              key={s.id}
                              className="flex items-center gap-2 px-1 py-0.5 rounded text-[11px] text-slate-300 hover:bg-white/[0.04] cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleSlug(s.id)}
                                className="accent-cyan-500"
                              />
                              <span className="truncate">{s.name}</span>
                            </label>
                          );
                        })}
                      </div>
                      <div className="flex gap-2 mt-2 pt-2 border-t border-white/[0.04]">
                        <button
                          type="button"
                          onClick={() => setSelectedSlugs(new Set(allSongs.map((s) => s.id)))}
                          className="text-[10px] text-slate-400 hover:text-slate-200"
                        >
                          Select all
                        </button>
                        <button
                          type="button"
                          onClick={() => setSelectedSlugs(new Set())}
                          className="text-[10px] text-slate-400 hover:text-slate-200"
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              <RadioRow
                name="scope" value="all" checked={scope === 'all'}
                onChange={() => setScope('all')}
                disabled={allSongs.length === 0}
                label="Entire dataset"
                hint={allSongs.length > 0 ? `${allSongs.length} songs` : '—'}
              />
            </Column>
            )}

            {/* Column 2: Layers */}
            <Column title="Layers">
              {visibleLayerKinds.map((k) => (
                <CheckRow
                  key={k}
                  checked={layers[k]}
                  onChange={() => toggleLayer(k)}
                  label={LAYER_LABEL[k]}
                />
              ))}
              {layers.autoGuess && anyNonJsonFormat && (
                <p className="mt-2 text-[10px] leading-snug text-slate-500 italic">
                  Auto-guess in non-JSON formats: only points marked correct or
                  partial are exported.
                </p>
              )}
              {anyNonJsonFormat && !showLoopsAndPatterns && (
                <p className="mt-2 text-[10px] leading-snug text-slate-500 italic">
                  Loops &amp; Patterns are hidden (experimental — enable in Settings).
                </p>
              )}
              {anyNonJsonFormat && showLoopsAndPatterns && (
                <p className="mt-2 text-[10px] leading-snug text-slate-500 italic">
                  Patterns export as TimeCues JSON only — flat formats can&apos;t
                  represent the per-cycle sub-beat grid.
                </p>
              )}
            </Column>

            {/* Column 3: Formats (multi-select — picking >1 forces a .zip) */}
            <Column title="Formats">
              <FormatCheckRow
                value="json" checked={selectedFormats.has('json')}
                onChange={() => toggleFormat('json')}
                label="TimeCues JSON" hint=".json"
              />
              <FormatCheckRow
                value="audacity" checked={selectedFormats.has('audacity')}
                onChange={() => toggleFormat('audacity')}
                label="Audacity Label Track" hint=".txt"
              />
              <FormatCheckRow
                value="sonicVis" checked={selectedFormats.has('sonicVis')}
                onChange={() => toggleFormat('sonicVis')}
                label="Sonic Visualiser Layers" hint=".csv"
              />
              <FormatCheckRow
                value="jams" checked={selectedFormats.has('jams')}
                onChange={() => toggleFormat('jams')}
                label="JAMS (MIR standard)" hint=".jams"
              />
              <FormatCheckRow
                value="mirEval" checked={selectedFormats.has('mirEval')}
                onChange={() => toggleFormat('mirEval')}
                label="mir_eval boundaries" hint=".lab"
              />
              <FormatCheckRow
                value="midi" checked={selectedFormats.has('midi')}
                onChange={() => toggleFormat('midi')}
                label="MIDI markers (DAW import)" hint=".mid"
              />
              <FormatCheckRow
                value="reaper" checked={selectedFormats.has('reaper')}
                onChange={() => toggleFormat('reaper')}
                label="REAPER regions" hint=".csv"
              />
              {formatsArr.length === 0 && activeLayers.length > 0 && (
                <p className="mt-1 text-[10px] leading-snug text-amber-300/80 italic">
                  Pick at least one format to export annotation layers.
                </p>
              )}
              {formatsArr.length > 1 && (
                <p className="mt-1 text-[10px] leading-snug text-slate-500 italic">
                  Multiple formats → each (song, layer) is emitted in every
                  format you pick. Forces a .zip.
                </p>
              )}

              <div className="mt-3 pt-3 border-t border-white/[0.04] space-y-2">
                <label
                  className={`flex items-center gap-2 text-[11px] ${(isMultiExport || includeAudio || includeSongInfo || includeAlgos || includeStems) ? 'text-slate-500' : 'text-slate-300 cursor-pointer'}`}
                  title={isMultiExport
                    ? 'Forced on for multi-file exports'
                    : (includeAudio || includeSongInfo || includeAlgos || includeStems) ? 'Forced on when bundling extra files' : undefined}
                >
                  <input
                    type="checkbox"
                    checked={willZip}
                    disabled={isMultiExport || includeAudio || includeSongInfo || includeAlgos || includeStems}
                    onChange={(e) => setZipToggle(e.target.checked)}
                    className="accent-cyan-500"
                  />
                  Bundle as .zip
                </label>
                <label
                  className="flex items-start gap-2 text-[11px] text-slate-300 cursor-pointer"
                  title="Includes BPM, time signature, grid offset, and lock state for each song at <slug>/song-info.json. Without this, exported annotation timings can't be reproduced."
                >
                  <input
                    type="checkbox"
                    checked={includeSongInfo}
                    onChange={(e) => setIncludeSongInfo(e.target.checked)}
                    className="accent-emerald-500 mt-0.5"
                  />
                  <span>
                    Include grid metadata
                    <span className="block text-[10px] text-slate-500 leading-tight">
                      BPM / time signature / grid offset per song. Recommended.
                    </span>
                  </span>
                </label>
                <label
                  className="flex items-start gap-2 text-[11px] text-slate-300"
                  title="Expands the song's beat grid into an individual labels file at <slug>/grid/<slug>.<ext>, written once per selected format. Pick the resolution: bars (downbeats), beats, sub-beats (8th/16th), or phrases (every 4 bars)."
                >
                  <span className="flex-1">
                    Grid labels
                    <span className="block text-[10px] text-slate-500 leading-tight">
                      Expanded grid markers at <code className="text-slate-400">grid/&lt;slug&gt;</code>, one file per selected format.
                    </span>
                  </span>
                  <select
                    value={gridGranularity}
                    onChange={(e) => setGridGranularity(e.target.value as GridExportGranularity | 'off')}
                    className="shrink-0 bg-[#0a0b0d] border border-white/10 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-cyan-500/50 cursor-pointer"
                  >
                    <option value="bars">Bars (1, 2, 3…)</option>
                    <option value="beats">Beats (1.1, 1.2…)</option>
                    <option value="subbeats-8">Sub-beats · 8th</option>
                    <option value="subbeats-16">Sub-beats · 16th</option>
                    <option value="phrases">Phrases (P1, P2…)</option>
                    <option value="off">Off</option>
                  </select>
                </label>
                <label
                  className="flex items-start gap-2 text-[11px] text-slate-300 cursor-pointer"
                  title="Adds the audio file for each in-scope song to the archive at <slug>/audio.<ext>."
                >
                  <input
                    type="checkbox"
                    checked={includeAudio}
                    onChange={(e) => setIncludeAudio(e.target.checked)}
                    className="accent-emerald-500 mt-0.5"
                  />
                  <span>
                    Include audio
                    <span className="block text-[10px] text-slate-500 leading-tight">
                      Bundles the song file alongside annotations (forces .zip).
                    </span>
                    {includeAudio && (
                      <span className="block text-[10px] leading-tight mt-0.5 text-emerald-300/80">
                        {audioSizesLoading
                          ? 'Measuring audio…'
                          : audioTotal.known === 0
                            ? 'Size unavailable'
                            : <>Before zip: ~{formatBytes(audioTotal.bytes)}
                                {audioTotal.unknown > 0 && (
                                  <span className="text-slate-500"> (+{audioTotal.unknown} unknown)</span>
                                )}
                              </>}
                        {lastZipBytes !== null && (
                          <span className="block text-cyan-300/80">
                            After zip: {formatBytes(lastZipBytes)}
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                </label>

                {/* Algo caches + Stems are only meaningful in multi-presentation
                    (the /prep "Full annotation export" entry). Hidden in
                    single-presentation /annotate to keep that modal focused
                    on the per-song annotation output. */}
                {presentation === 'multi' && (<>
                <label
                  className="flex items-start gap-2 text-[11px] text-slate-300 cursor-pointer"
                  title="Bundles cached algorithm outputs from /analysis/<slug>/ (allin1 folds, MSAF, ruptures, foote, BPM detector results) at <slug>/algos/<file>."
                >
                  <input
                    type="checkbox"
                    checked={includeAlgos}
                    onChange={(e) => setIncludeAlgos(e.target.checked)}
                    className="accent-emerald-500 mt-0.5"
                  />
                  <span>
                    Include algorithm caches
                    <span className="block text-[10px] text-slate-500 leading-tight">
                      Cached algo outputs per song (allin1, MSAF, ruptures, BPM). Forces .zip.
                    </span>
                  </span>
                </label>
                <label
                  className="flex items-start gap-2 text-[11px] text-slate-300 cursor-pointer"
                  title="Bundles Demucs-separated stems (drums / bass / vocals / other) at <slug>/stems/<stem>.wav. Often hundreds of MB per song — forces .zip."
                >
                  <input
                    type="checkbox"
                    checked={includeStems}
                    onChange={(e) => setIncludeStems(e.target.checked)}
                    className="accent-emerald-500 mt-0.5"
                  />
                  <span>
                    Include stems
                    <span className="block text-[10px] text-slate-500 leading-tight">
                      Demucs WAVs (drums / bass / vocals / other) per song. Large.
                    </span>
                  </span>
                </label>
                </>)}
              </div>
            </Column>
          </div>

          {/* Auto-bundle banner */}
          {isMultiExport && (
            <div className="mx-5 mb-3 px-3 py-2 rounded border border-cyan-500/20 bg-cyan-500/5 text-[11px] text-cyan-200/90">
              📦 Auto-bundling into a single .zip to preserve directory structure
              ({targetSongCount} song{targetSongCount === 1 ? '' : 's'} × {activeLayers.length} layer{activeLayers.length === 1 ? '' : 's'}
              {formatsArr.length > 1 && <> × {formatsArr.length} formats</>}).
            </div>
          )}

          {error && (
            <div className="mx-5 mb-3 px-3 py-2 rounded border border-red-500/30 bg-red-500/10 text-[11px] text-red-200">
              {error}
            </div>
          )}

          {warning && (
            <div className="mx-5 mb-3 px-3 py-2 rounded border border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-200">
              {warning}
            </div>
          )}

          {/* Footer */}
          <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-white/[0.06]">
            <div className="text-[10px] text-slate-600 uppercase tracking-wider">
              {!hasAnyBucket ? (
                <>Select scope and at least one layer or bucket</>
              ) : targetSongCount === 0 ? (
                <>Pick at least one song</>
              ) : activeLayers.length > 0 && formatsArr.length === 0 ? (
                <>Pick at least one format</>
              ) : activeLayers.length > 0 ? (
                <>{annotationFileCount} annotation file{annotationFileCount === 1 ? '' : 's'} → {willZip ? '.zip' : `.${FORMAT_EXT[formatsArr[0]]}`}</>
              ) : (
                <>{targetSongCount} song{targetSongCount === 1 ? '' : 's'} → .zip (no annotation layers selected)</>
              )}
            </div>
            <div className="flex gap-2">
              <Dialog.Close asChild>
                <button
                  className="px-3 py-1.5 text-[11px] rounded text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                disabled={!canExport}
                onClick={runExport}
                className={`px-3 py-1.5 text-[11px] rounded uppercase tracking-wider transition-colors ${
                  canExport
                    ? 'bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-200 border border-cyan-500/30'
                    : 'bg-white/[0.03] text-slate-600 border border-white/[0.04] cursor-not-allowed'
                }`}
              >
                {busy
                  ? zipProgress != null
                    ? `Zipping ${Math.round(zipProgress)}%`
                    : 'Exporting…'
                  : 'Export'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─── Tiny presentational helpers ─────────────────────────────────────────────

function Column({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[10px] uppercase tracking-wider text-slate-500 font-medium mb-2">
        {title}
      </h3>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function RadioRow({
  name, value, checked, onChange, label, hint, disabled,
}: {
  name: string; value: string; checked: boolean;
  onChange: () => void; label: string; hint?: string; disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-baseline gap-2 text-[11px] ${
        disabled ? 'text-slate-600 cursor-not-allowed' : 'text-slate-300 cursor-pointer'
      }`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="accent-cyan-500 mt-0.5"
      />
      <span className="flex-1">{label}</span>
      {hint && <span className="text-[10px] text-slate-600 font-mono">{hint}</span>}
    </label>
  );
}

function CheckRow({
  checked, onChange, label,
}: {
  checked: boolean; onChange: () => void; label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={onChange} className="accent-cyan-500" />
      <span>{label}</span>
    </label>
  );
}

/** Format picker row — checkbox + flex label + monospace extension hint.
 *  Mirrors the visual rhythm of the scope RadioRow so the Format column
 *  still reads as a single tidy list even though it now multi-selects. */
function FormatCheckRow({
  value, checked, onChange, label, hint,
}: {
  value: string; checked: boolean; onChange: () => void;
  label: string; hint?: string;
}) {
  return (
    <label className="flex items-baseline gap-2 text-[11px] text-slate-300 cursor-pointer">
      <input
        type="checkbox"
        value={value}
        checked={checked}
        onChange={onChange}
        className="accent-cyan-500 mt-0.5"
      />
      <span className="flex-1">{label}</span>
      {hint && <span className="text-[10px] text-slate-600 font-mono">{hint}</span>}
    </label>
  );
}
