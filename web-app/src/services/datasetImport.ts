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

import { annotatorHeaders } from '../utils/annotatorHeaders';

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
export type ScannedSong = {
  slug: string;            // derived from audio basename (server slugify)
  displayName: string;     // raw basename before slugify
  audio: File | null;      // null if a song was inferred from annotations alone
  songInfo: File | null;
  annotations: Partial<Record<AnnotationKind, File>>;
  stems: Partial<Record<StemName, { file: File; ext: string }>>;
  warnings: string[];
};

export type ScanResult = {
  songs: ScannedSong[];
  unrecognized: string[]; // paths skipped (for the dialog's "ignored" tally)
};

// ── Path classifiers ─────────────────────────────────────────────────────────
// Each helper returns the slug + kind if the path matches its layout pattern.

function classifyServerMirror(parts: string[], file: File): {
  kind: 'audio' | 'song-info' | AnnotationKind | 'stem';
  slug: string;
  stemName?: StemName;
} | null {
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

function classifyFlatBundle(parts: string[]): {
  kind: 'audio' | 'song-info' | AnnotationKind | 'stem';
  slug: string;
  stemName?: StemName;
} | null {
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

    // Try server-mirror first (more specific), then fall back to flat bundle.
    const cls = classifyServerMirror(parts, file) ?? classifyFlatBundle(parts);
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

    // 3. Annotations — manual/eye/auto-guess/layers (independent, in parallel
    //    is fine but sequential keeps the dialog's per-step status legible).
    const annTargets: { key: StepKey; file: File | undefined; url: string }[] = [
      { key: 'manual',    file: song.annotations.manual,    url: `/api/manual-annotations/${encodeURIComponent(song.slug)}` },
      { key: 'eye',       file: song.annotations.eye,       url: `/api/eye-annotations/${encodeURIComponent(song.slug)}` },
      { key: 'autoGuess', file: song.annotations['auto-guess'], url: `/api/auto-guess-annotations/${encodeURIComponent(song.slug)}` },
      { key: 'layers',    file: song.annotations.layers,    url: `/api/annotation-layers/${encodeURIComponent(song.slug)}` },
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
