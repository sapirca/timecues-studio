// Dataset import — scan a folder (or file selection) for audio + song-info +
// annotations + stems, then push each detected song to the corpus through the
// same endpoints that the single-file upload + per-feature save flows use.
//
// Supported source layouts (auto-detected per file path):
//   1. Server-mirror layout — folders shaped like data/:
//        songs/<slug>/<slug>.mp3
//        song-info/<slug>.json
//        annotations/{manual,eye,auto-guess,layers}/<annotator>/<slug>.json
//        stems/<slug>/{drums,bass,other,vocals}.{wav,mp3,...}
//   2. Flat per-song bundle — audio + sibling JSONs sharing a basename:
//        track_a.mp3
//        track_a.info.json
//        track_a.layers.json
//        track_a.manual.json     ← also .eye.json, .auto-guess.json
//        track_a.stems/{vocals,drums,...}.wav
//   3. Export-bundle layout — what ExportManagerModal writes (one dir per slug):
//        <slug>/boundaries/{manual,eye,auto-guess}/[<annotator>/]<slug>.json
//        <slug>/{cues,spans,loops,patterns}/[<annotator>/]<layer-name>.json
//        <slug>/song-info.json
//        <slug>/audio.<ext>
//        <slug>/stems/{drums,bass,other,vocals}.<ext>
//      Only `.json` boundary/layer files round-trip — the flat marker formats
//      (.txt/.csv/.lab/.jams/.mid) are lossy and skipped. The per-type user-layer
//      files are reassembled into one AnnotationLayersDocument at import time.

import { annotatorHeaders } from '../utils/annotatorHeaders';
import type { AnnotationLayer, AnnotationLayersDocument } from '../types/annotationLayer';

// ── Slugification — must match vite.config.ts:serveUploadSong/slugify ────────
export function slugify(stem: string): string {
  return stem
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const AUDIO_EXTS = ['.mp3', '.wav', '.flac', '.ogg', '.m4a'] as const;
const STEM_NAMES = ['drums', 'bass', 'other', 'vocals'] as const;
export type StemName = (typeof STEM_NAMES)[number];

function relPath(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
  return rel || file.name;
}

function isAudioName(name: string): boolean {
  const lower = name.toLowerCase();
  return AUDIO_EXTS.some((ext) => lower.endsWith(ext));
}

function audioExt(name: string): string {
  const lower = name.toLowerCase();
  for (const ext of AUDIO_EXTS) if (lower.endsWith(ext)) return ext;
  return '';
}

function basenameNoExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

// ── Scanned model ────────────────────────────────────────────────────────────

export type AnnotationKind = 'manual' | 'eye' | 'auto-guess' | 'layers';
/** User-created layer kinds the export-bundle layout splits into one file each.
 *  On the server they all live inside a single annotation-layers document, so
 *  the importer reassembles them before POSTing. */
export type UserLayer = 'cues' | 'spans' | 'loops' | 'patterns';
export type ScannedSong = {
  slug: string;            // derived from audio basename (server slugify)
  displayName: string;     // raw basename before slugify
  audio: File | null;      // null if a song was inferred from annotations alone
  songInfo: File | null;
  annotations: Partial<Record<AnnotationKind, File>>;
  /** Per-layer JSON files from the export-bundle layout (cues/spans/loops/
   *  patterns), each a single AnnotationLayer. Folded into one document by the
   *  `layers` import step alongside any whole-document `annotations.layers`. */
  layerFiles: { type: UserLayer; name: string; file: File }[];
  stems: Partial<Record<StemName, { file: File; ext: string }>>;
  warnings: string[];
};

/** Shared classifier result — `layer` carries the user-layer type + display
 *  name (filename basename); the real layer name lives inside the JSON. */
type Classified = {
  kind: 'audio' | 'song-info' | AnnotationKind | 'stem' | 'layer';
  slug: string;
  stemName?: StemName;
  layerType?: UserLayer;
  layerName?: string;
};

export type ScanResult = {
  songs: ScannedSong[];
  unrecognized: string[]; // paths skipped (for the dialog's "ignored" tally)
};

// ── Path classifiers ─────────────────────────────────────────────────────────
// Each helper returns the slug + kind if the path matches its layout pattern.

function classifyServerMirror(parts: string[], file: File): Classified | null {
  // Look for the FIRST segment that names a known top-level bucket. This
  // tolerates the user picking the parent of the data/ folder, or selecting
  // data/ itself, or selecting an even-deeper subdir.
  for (let i = 0; i < parts.length - 1; i += 1) {
    const seg = parts[i];
    const tail = parts.slice(i + 1);

    if (seg === 'songs' && tail.length >= 2) {
      const slug = tail[0];
      const fileName = tail[tail.length - 1];
      if (isAudioName(fileName)) return { kind: 'audio', slug };
    }

    if (seg === 'song-info' && tail.length >= 1) {
      const fileName = tail[tail.length - 1];
      if (fileName.toLowerCase().endsWith('.json')) return { kind: 'song-info', slug: basenameNoExt(fileName) };
    }

    if (seg === 'annotations' && tail.length >= 2) {
      const bucket = tail[0];
      const fileName = tail[tail.length - 1];
      if (!fileName.toLowerCase().endsWith('.json')) continue;
      const slug = basenameNoExt(fileName);
      if (bucket === 'manual')     return { kind: 'manual', slug };
      if (bucket === 'eye')        return { kind: 'eye', slug };
      if (bucket === 'auto-guess') return { kind: 'auto-guess', slug };
      if (bucket === 'layers')     return { kind: 'layers', slug };
      // 'custom' is intentionally skipped — multi-script routing is out of
      // scope for this importer.
    }

    if (seg === 'stems' && tail.length >= 2) {
      const slug = tail[0];
      const fileName = tail[tail.length - 1].toLowerCase();
      const stemBase = basenameNoExt(fileName);
      if ((STEM_NAMES as readonly string[]).includes(stemBase) && isAudioName(fileName)) {
        return { kind: 'stem', slug, stemName: stemBase as StemName };
      }
    }
  }
  void file;
  return null;
}

function classifyFlatBundle(parts: string[]): Classified | null {
  const fileName = parts[parts.length - 1];

  // 1. Audio file: <slug>.<audio-ext>
  if (isAudioName(fileName)) {
    return { kind: 'audio', slug: basenameNoExt(fileName) };
  }

  // 2. Stems folder: <slug>.stems/<stem>.<audio-ext> (or <slug>_stems/...)
  if (parts.length >= 2) {
    const stemsDir = parts[parts.length - 2];
    const m = stemsDir.match(/^(.+?)[._-]stems$/i);
    if (m) {
      const lower = fileName.toLowerCase();
      const stemBase = basenameNoExt(lower);
      if ((STEM_NAMES as readonly string[]).includes(stemBase) && isAudioName(lower)) {
        return { kind: 'stem', slug: m[1], stemName: stemBase as StemName };
      }
    }
  }

  // 3. Sidecar JSONs: <slug>.{info,manual,eye,auto-guess,layers}.json
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.json')) {
    const stripped = basenameNoExt(lower);
    // Try each known suffix; the slug is everything before it.
    const sidecars: { suffix: string; kind: 'song-info' | AnnotationKind }[] = [
      { suffix: '.info',        kind: 'song-info'  },
      { suffix: '.song-info',   kind: 'song-info'  },
      { suffix: '.manual',      kind: 'manual'     },
      { suffix: '.eye',         kind: 'eye'        },
      { suffix: '.auto-guess',  kind: 'auto-guess' },
      { suffix: '.autoguess',   kind: 'auto-guess' },
      { suffix: '.layers',      kind: 'layers'     },
    ];
    for (const { suffix, kind } of sidecars) {
      if (stripped.endsWith(suffix)) {
        return { kind, slug: stripped.slice(0, stripped.length - suffix.length) };
      }
    }
  }
  return null;
}

// Boundary kind sub-dirs under `<slug>/boundaries/` map straight onto the
// annotation kind. (custom is intentionally absent — out of scope, same as
// the server-mirror classifier.)
const BOUNDARY_DIR_KIND: Record<string, 'manual' | 'eye' | 'auto-guess'> = {
  manual: 'manual',
  eye: 'eye',
  'auto-guess': 'auto-guess',
};
const USER_LAYER_DIRS = new Set<UserLayer>(['cues', 'spans', 'loops', 'patterns']);
// Type dirs the export-bundle layout places directly under `<slug>/`. grid +
// algos are recognised as part of the layout but have no import endpoint, so
// they fall through to "unrecognised" honestly rather than silently vanishing.
const EXPORT_TYPE_DIRS = new Set([
  'boundaries', 'cues', 'spans', 'loops', 'patterns', 'stems', 'grid', 'algos',
]);

/** Recognise the export-bundle layout (layout #3 above). The slug always comes
 *  from the song-folder segment — the segment immediately before the type dir
 *  (boundaries/cues/…), or the parent of a bare song-info.json / audio.<ext>.
 *  Anchoring on the folder (not the filename) is what makes user-layer files
 *  like `cues/kick-hits.json` resolve to the right song. */
function classifyExportBundle(parts: string[]): Classified | null {
  const fileName = parts[parts.length - 1];
  const lower = fileName.toLowerCase();

  // Find the first known type dir that has a parent segment to act as slug.
  // This tolerates wrapper dirs above <slug>/ (e.g. an unzipped export folder).
  let dirIdx = -1;
  for (let i = 1; i < parts.length - 1; i += 1) {
    if (EXPORT_TYPE_DIRS.has(parts[i])) { dirIdx = i; break; }
  }

  if (dirIdx >= 1) {
    const slug = parts[dirIdx - 1];
    const typeDir = parts[dirIdx];

    if (typeDir === 'boundaries') {
      // boundaries/<kind>/[<annotator>/]<file>.json
      const kind = BOUNDARY_DIR_KIND[parts[dirIdx + 1]];
      if (!kind) return null;
      if (!lower.endsWith('.json')) return null; // flat marker formats are lossy
      return { kind, slug };
    }
    if (USER_LAYER_DIRS.has(typeDir as UserLayer)) {
      // <type>/[<annotator>/]<layer-name>.json — one AnnotationLayer per file.
      if (!lower.endsWith('.json')) return null;
      return { kind: 'layer', slug, layerType: typeDir as UserLayer, layerName: basenameNoExt(fileName) };
    }
    if (typeDir === 'stems') {
      // stems/<stem>.<audio-ext>
      const stemBase = basenameNoExt(lower);
      if ((STEM_NAMES as readonly string[]).includes(stemBase) && isAudioName(lower)) {
        return { kind: 'stem', slug, stemName: stemBase as StemName };
      }
      return null;
    }
    // grid / algos — layout-recognised but not importable.
    return null;
  }

  // No type dir: only song-info.json and audio.<ext> sit directly under <slug>/.
  if (parts.length >= 2) {
    const parentSlug = parts[parts.length - 2];
    if (lower === 'song-info.json') return { kind: 'song-info', slug: parentSlug };
    if (isAudioName(lower) && basenameNoExt(lower) === 'audio') return { kind: 'audio', slug: parentSlug };
  }
  return null;
}

// ── Main scanner ─────────────────────────────────────────────────────────────

export function scanDatasetFiles(files: File[]): ScanResult {
  const songs = new Map<string, ScannedSong>();
  const unrecognized: string[] = [];

  function ensure(slug: string, displayName: string): ScannedSong {
    let entry = songs.get(slug);
    if (!entry) {
      entry = {
        slug,
        displayName,
        audio: null,
        songInfo: null,
        annotations: {},
        layerFiles: [],
        stems: {},
        warnings: [],
      };
      songs.set(slug, entry);
    }
    return entry;
  }

  for (const file of files) {
    const rel = relPath(file);
    const parts = rel.split('/').filter(Boolean);

    // Most specific first: server-mirror (top-level buckets), then the
    // export-bundle layout (anchored on <slug>/ + type dirs), then the greedy
    // flat-bundle catch-all (which would otherwise grab `audio.mp3` as slug
    // "audio" and stems as their own phantom songs).
    const cls =
      classifyServerMirror(parts, file) ??
      classifyExportBundle(parts) ??
      classifyFlatBundle(parts);
    if (!cls) {
      unrecognized.push(rel);
      continue;
    }

    // Slugify every branch — the server stores everything under the slugified
    // key, so an audio file named `foo-bar.mp3` (slug `foo_bar`) and an
    // annotation named `foo-bar.json` (slug `foo-bar` if taken literally) must
    // collapse into the same Map entry, not split into two phantom rows.
    const rawSlug = cls.slug;
    const slug = slugify(rawSlug);

    const fileName = parts[parts.length - 1];
    const entry = ensure(slug, rawSlug);

    if (cls.kind === 'audio') {
      if (entry.audio) {
        entry.warnings.push(`Multiple audio files for "${slug}" — keeping ${entry.audio.name}, ignoring ${fileName}`);
      } else {
        entry.audio = file;
        entry.displayName = rawSlug;
      }
    } else if (cls.kind === 'song-info') {
      entry.songInfo = file;
    } else if (cls.kind === 'stem' && cls.stemName) {
      entry.stems[cls.stemName] = { file, ext: audioExt(fileName) };
    } else if (cls.kind === 'layer' && cls.layerType) {
      entry.layerFiles.push({ type: cls.layerType, name: cls.layerName ?? basenameNoExt(fileName), file });
    } else if (cls.kind === 'manual' || cls.kind === 'eye' || cls.kind === 'auto-guess' || cls.kind === 'layers') {
      entry.annotations[cls.kind] = file;
    }
  }

  // Songs detected from annotation-only paths get a warning so the user
  // knows the audio is missing from the source folder.
  for (const song of songs.values()) {
    if (!song.audio) {
      song.warnings.unshift('No audio file in source — annotations will only land if the song already exists on the server.');
    }
  }

  return { songs: [...songs.values()].sort((a, b) => a.slug.localeCompare(b.slug)), unrecognized };
}

// ── Server-side conflict check ──────────────────────────────────────────────

export type ServerStatus = {
  songExists: boolean;
  hasSongInfo: boolean;
  hasManual: boolean;
  hasEye: boolean;
  hasAutoGuess: boolean;
  hasLayers: boolean;
};

const EMPTY_STATUS: ServerStatus = {
  songExists: false,
  hasSongInfo: false,
  hasManual: false,
  hasEye: false,
  hasAutoGuess: false,
  hasLayers: false,
};

async function jsonExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: annotatorHeaders() });
    if (!res.ok) return false;
    const text = await res.text();
    if (!text || text === 'null') return false;
    try {
      const data = JSON.parse(text);
      return data !== null && data !== undefined;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

export async function checkServerStatus(slugs: string[]): Promise<Record<string, ServerStatus>> {
  // Pull the existing manifest once so we know which slugs already have audio
  // on the server, then probe per-feature endpoints in parallel.
  let existingAudio = new Set<string>();
  try {
    const res = await fetch('/analysis/manifest.json', { headers: annotatorHeaders() });
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list)) existingAudio = new Set(list.map((row) => String(row.id)));
    }
  } catch { /* fall through with empty set */ }

  const result: Record<string, ServerStatus> = {};
  await Promise.all(slugs.map(async (slug) => {
    const enc = encodeURIComponent(slug);
    const [hasSongInfo, hasManual, hasEye, hasAutoGuess, hasLayers] = await Promise.all([
      jsonExists(`/api/song-info/${enc}`),
      jsonExists(`/api/manual-annotations/${enc}`),
      jsonExists(`/api/eye-annotations/${enc}`),
      jsonExists(`/api/auto-guess-annotations/${enc}`),
      jsonExists(`/api/annotation-layers/${enc}`),
    ]);
    result[slug] = {
      songExists: existingAudio.has(slug),
      hasSongInfo,
      hasManual,
      hasEye,
      hasAutoGuess,
      hasLayers,
    };
  }));
  // Songs the server doesn't know about land with EMPTY_STATUS — fill missing
  // entries so callers can `result[slug].songExists` unconditionally.
  for (const slug of slugs) if (!result[slug]) result[slug] = { ...EMPTY_STATUS };
  return result;
}

// ── Per-piece importers ─────────────────────────────────────────────────────

const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024; // mirrors InspectorPageV2's cap

async function readFileAsJson(file: File): Promise<unknown> {
  const text = await file.text();
  return JSON.parse(text);
}

async function uploadAudioChunked(file: File, slug: string, onProgress?: (frac: number) => void): Promise<{ id: string }> {
  const total = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK_SIZE));
  // Send `<slug><ext>` as the upload name so the server's slugify lands on the
  // same id the importer already grouped sidecars under. Using `file.name`
  // here let the server diverge when filenames contained characters the two
  // slugify steps treated differently (e.g. apostrophe vs hyphen), splitting
  // audio and song-info into separate slugs.
  const ext = audioExt(file.name) || '.mp3';
  const uploadName = `${slug}${ext}`;
  let last: { id?: string } = {};
  for (let i = 0; i < total; i += 1) {
    const start = i * UPLOAD_CHUNK_SIZE;
    const end = Math.min(file.size, start + UPLOAD_CHUNK_SIZE);
    const slice = file.slice(start, end);
    const qs = `name=${encodeURIComponent(uploadName)}&chunk=${i}&total=${total}`;
    last = await new Promise<{ id?: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/upload-song?${qs}`);
      for (const [k, v] of Object.entries(annotatorHeaders())) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (evt) => {
        if (!evt.lengthComputable) return;
        onProgress?.((start + evt.loaded) / file.size);
      };
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(`HTTP ${xhr.status}`));
        try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error('bad json')); }
      };
      xhr.onerror = () => reject(new Error('network'));
      xhr.send(slice);
    });
    onProgress?.(end / file.size);
  }
  if (!last.id) throw new Error('upload-song did not return an id');
  return { id: last.id };
}

async function uploadStemChunked(slug: string, stem: StemName, ext: string, file: File): Promise<void> {
  const total = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK_SIZE));
  for (let i = 0; i < total; i += 1) {
    const start = i * UPLOAD_CHUNK_SIZE;
    const end = Math.min(file.size, start + UPLOAD_CHUNK_SIZE);
    const slice = file.slice(start, end);
    const qs = `stem=${encodeURIComponent(stem)}&ext=${encodeURIComponent(ext)}&chunk=${i}&total=${total}`;
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/upload-stem/${encodeURIComponent(slug)}?${qs}`);
      for (const [k, v] of Object.entries(annotatorHeaders())) xhr.setRequestHeader(k, v);
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`)));
      xhr.onerror = () => reject(new Error('network'));
      xhr.send(slice);
    });
  }
}

async function finaliseStemsManifest(slug: string): Promise<void> {
  const res = await fetch(`/api/upload-stem-manifest/${encodeURIComponent(slug)}`, {
    method: 'POST',
    headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`manifest finalise: HTTP ${res.status}`);
}

async function postJson(url: string, payload: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload, null, 2),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
}

// ── Top-level import orchestrator ───────────────────────────────────────────
//
// Per-song step report — the dialog renders this as a checklist so the user
// can see exactly what landed and what failed. We never throw out of the
// orchestrator: a partial result (audio OK, layers failed) is more useful than
// a single error for the whole song.

export type StepKey = 'audio' | 'songInfo' | 'manual' | 'eye' | 'autoGuess' | 'layers' | 'stems';
export type StepStatus = 'skip' | 'ok' | 'error';
export type SongImportResult = {
  slug: string;
  steps: Partial<Record<StepKey, { status: StepStatus; message?: string }>>;
};

export type ImportPlan = {
  song: ScannedSong;
  include: Record<StepKey, boolean>;
};

export type ImportProgress = {
  stage: 'song' | 'step' | 'done';
  songIndex: number;
  totalSongs: number;
  songSlug?: string;
  step?: StepKey;
  frac?: number;
};

export async function runImport(
  plan: ImportPlan[],
  onProgress: (p: ImportProgress) => void,
): Promise<SongImportResult[]> {
  const results: SongImportResult[] = [];
  for (let i = 0; i < plan.length; i += 1) {
    const { song, include } = plan[i];
    const steps: SongImportResult['steps'] = {};
    onProgress({ stage: 'song', songIndex: i, totalSongs: plan.length, songSlug: song.slug });

    // 1. Audio first — without it the slug may not exist on the server, so
    // annotation POSTs are still allowed (they create the dir) but the
    // sidebar manifest won't list the song until audio is present.
    if (include.audio && song.audio) {
      onProgress({ stage: 'step', songIndex: i, totalSongs: plan.length, songSlug: song.slug, step: 'audio', frac: 0 });
      try {
        await uploadAudioChunked(song.audio, song.slug, (frac) => {
          onProgress({ stage: 'step', songIndex: i, totalSongs: plan.length, songSlug: song.slug, step: 'audio', frac });
        });
        steps.audio = { status: 'ok' };
      } catch (err) {
        steps.audio = { status: 'error', message: (err as Error).message };
      }
    } else if (include.audio) {
      steps.audio = { status: 'skip', message: 'no audio file in source' };
    }

    // 2. Song info
    if (include.songInfo && song.songInfo) {
      try {
        const info = await readFileAsJson(song.songInfo);
        await postJson(`/api/song-info/${encodeURIComponent(song.slug)}`, info);
        steps.songInfo = { status: 'ok' };
      } catch (err) {
        steps.songInfo = { status: 'error', message: (err as Error).message };
      }
    }

    // 3. Boundary annotations — manual/eye/auto-guess each POST one document
    //    verbatim. Sequential keeps the dialog's per-step status legible.
    const annTargets: { key: StepKey; file: File | undefined; url: string }[] = [
      { key: 'manual',    file: song.annotations.manual,    url: `/api/manual-annotations/${encodeURIComponent(song.slug)}` },
      { key: 'eye',       file: song.annotations.eye,       url: `/api/eye-annotations/${encodeURIComponent(song.slug)}` },
      { key: 'autoGuess', file: song.annotations['auto-guess'], url: `/api/auto-guess-annotations/${encodeURIComponent(song.slug)}` },
    ];
    for (const t of annTargets) {
      if (!include[t.key]) continue;
      if (!t.file) continue;
      try {
        const data = await readFileAsJson(t.file);
        await postJson(t.url, data);
        steps[t.key] = { status: 'ok' };
      } catch (err) {
        steps[t.key] = { status: 'error', message: (err as Error).message };
      }
    }

    // 3b. Annotation layers. Two source shapes collapse to one POST:
    //   - a whole-document file (server-mirror / flat `.layers.json`) — POSTed
    //     verbatim so its statusByType / annotated_at survive;
    //   - the export-bundle's per-layer files (cues/spans/loops/patterns), each
    //     a single AnnotationLayer — reassembled into one document. When both
    //     are present (mixed sources) the per-layer files extend the document.
    if (include.layers && (song.annotations.layers || song.layerFiles.length > 0)) {
      try {
        if (song.layerFiles.length === 0 && song.annotations.layers) {
          const doc = await readFileAsJson(song.annotations.layers);
          await postJson(`/api/annotation-layers/${encodeURIComponent(song.slug)}`, doc);
        } else {
          const layers: AnnotationLayer[] = [];
          if (song.annotations.layers) {
            const doc = (await readFileAsJson(song.annotations.layers)) as AnnotationLayersDocument;
            if (Array.isArray(doc?.layers)) layers.push(...doc.layers);
          }
          for (const lf of song.layerFiles) {
            layers.push((await readFileAsJson(lf.file)) as AnnotationLayer);
          }
          const document: AnnotationLayersDocument = {
            song: song.slug,
            annotated_at: new Date().toISOString(),
            layers,
          };
          await postJson(`/api/annotation-layers/${encodeURIComponent(song.slug)}`, document);
        }
        steps.layers = { status: 'ok' };
      } catch (err) {
        steps.layers = { status: 'error', message: (err as Error).message };
      }
    }

    // 4. Stems — upload each stem file then finalise the manifest. Order:
    // drums → bass → other → vocals (matches Demucs source order).
    if (include.stems) {
      const stemKeys = (STEM_NAMES as readonly StemName[]).filter((n) => song.stems[n]);
      if (stemKeys.length > 0) {
        try {
          for (const name of stemKeys) {
            const s = song.stems[name];
            if (!s) continue;
            await uploadStemChunked(song.slug, name, s.ext, s.file);
          }
          await finaliseStemsManifest(song.slug);
          steps.stems = { status: 'ok' };
        } catch (err) {
          steps.stems = { status: 'error', message: (err as Error).message };
        }
      }
    }

    results.push({ slug: song.slug, steps });
  }

  onProgress({ stage: 'done', songIndex: plan.length, totalSongs: plan.length });
  return results;
}
