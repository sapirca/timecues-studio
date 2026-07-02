// Centralized on-disk paths for all data folders consumed by the dev server
// (vite.config.ts plugins) and supporting Node scripts.
//
// Two parallel trees:
//
//   data/         — user/local data. Bind-mounted at runtime, dockerignored.
//                   This is where uploads, annotation saves, BPM caches, etc.
//                   are written. Reads check here first.
//
//   data-default/ — read-only seeds shipped inside the docker image. Reads
//                   fall back here when a slug is absent in data/. Used for
//                   the CC0 tracks that come with the container so a fresh
//                   install has something to play.
//
// All paths resolve from the repo root (one level above /web-app).
// If you move a folder on disk, update the value here and nowhere else.

import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

export const REPO_ROOT = path.resolve(__dirname, '..')

const DATA_ROOT              = path.join(REPO_ROOT, 'data')
const DEFAULT_DATA_ROOT      = path.join(REPO_ROOT, 'data-default')
const ANNOTATIONS_ROOT       = path.join(DATA_ROOT, 'annotations')
const ALGORITHM_OUTPUTS_ROOT = path.join(DATA_ROOT, 'algorithm-outputs')
const DEFAULT_ANNOTATIONS_ROOT = path.join(DEFAULT_DATA_ROOT, 'annotations')

export const DATA_DIRS = {
  // Annotation folders (per-annotator subdirs: <dir>/<annotator>/<slug>.json)
  manualAnnotations:      path.join(ANNOTATIONS_ROOT, 'manual'),
  autoGuessAnnotations: path.join(ANNOTATIONS_ROOT, 'auto-guess'),

  // Custom-script annotations (per-script subdir + per-annotator subdir):
  // <dir>/<script_name>/<annotator>/<slug>.json
  customAnnotations:    path.join(ANNOTATIONS_ROOT, 'custom'),

  // Annotation-layers documents (per-annotator subdir, one file per song):
  // <dir>/<annotator>/<slug>.json — holds cues/spans/loops/patterns together.
  annotationLayers:     path.join(ANNOTATIONS_ROOT, 'layers'),

  // Algorithm output caches (flat: <dir>/<slug>.json)
  analysis:       path.join(ALGORITHM_OUTPUTS_ROOT, 'analysis'),
  algoClusters:    path.join(ALGORITHM_OUTPUTS_ROOT, 'algo-clusters'),
  bpmDetections:   path.join(ALGORITHM_OUTPUTS_ROOT, 'bpm-detections'),
  mirFeatures:     path.join(ALGORITHM_OUTPUTS_ROOT, 'mir-features'),

  // Custom-script algorithm-mode result cache: <dir>/<script_name>/<slug>.json
  customResults:   path.join(ALGORITHM_OUTPUTS_ROOT, 'custom'),

  // MSAF raw outputs (per-slug subdir: msaf/<slug>/msaf-{algo}.json + estimations.jams)
  msaf:            path.join(ALGORITHM_OUTPUTS_ROOT, 'msaf'),
  msafBatchJams:   path.join(ALGORITHM_OUTPUTS_ROOT, 'msaf-batch-jams'),

  // Experimental SPAN-family detector outputs (per-slug subdir:
  // span/<slug>/<algo>.json). Gated by the `experimentalSpanFamily` user
  // setting and the `experimental-models` docker compose profile.
  span:            path.join(ALGORITHM_OUTPUTS_ROOT, 'span'),
  // BeatNet (experimental CUE-family). Flat layout, one file per slug.
  beatnet:         path.join(ALGORITHM_OUTPUTS_ROOT, 'beatnet'),
  // PANNs AudioSet tagging (SPAN family, separate sidecar). Per-slug subdir.
  panns:           path.join(ALGORITHM_OUTPUTS_ROOT, 'panns'),
  // LOOP family — chroma autocorrelation v0. Per-slug subdir.
  loop:            path.join(ALGORITHM_OUTPUTS_ROOT, 'loop'),
  // basic-pitch polyphonic note transcription (CUE family). Per-slug subdir.
  pitch:           path.join(ALGORITHM_OUTPUTS_ROOT, 'pitch'),
  // CUE-family extras (librosa key / autochord / librosa onsets).
  cueExtras:       path.join(ALGORITHM_OUTPUTS_ROOT, 'cue-extras'),
  // HPSS percussive-span detector (SPAN family).
  percussive:      path.join(ALGORITHM_OUTPUTS_ROOT, 'percussive'),
  // Whisper-base lyrics transcription (LYRICS family).
  lyrics:          path.join(ALGORITHM_OUTPUTS_ROOT, 'lyrics'),
  // LoCoMotif motif discovery (PATTERN family). Per-slug subdir.
  pattern:         path.join(ALGORITHM_OUTPUTS_ROOT, 'pattern'),

  // Per-song metadata (<dir>/<slug>.json)
  songInfo: path.join(DATA_ROOT, 'song-info'),

  // Audio library (one folder per song slug): <dir>/<slug>/<file>.mp3
  songs: path.join(DATA_ROOT, 'songs'),

  // One file per annotator: <dir>/<id>.json with the saved sign-up profile
  // (displayName, email, role, affiliation, authMethod, invitedBy). Used by
  // the Email login pane to detect returning users (so they don't re-type
  // their details) and by the Team page's invite-annotator flow.
  annotatorProfiles: path.join(DATA_ROOT, 'annotators'),

  // Per-song reference lyrics text (one .txt per slug). Shared across
  // annotators since lyrics text is generally objective; used as the
  // alignment source for SOFA / ctc-forced-aligner when those land.
  // Experimental: gated by `experimentalLyricsFamily` user setting.
  lyricsText: path.join(DATA_ROOT, 'lyrics-text'),

  // Saved Setlists (per-annotator: <dir>/<annotator>/<name>.json). Each file
  // is an ordered list of slugs + the scoring strategy that produced it. New
  // top-level workspace at /setlist, gated by the `experimentalSetlist`
  // user setting.
  setlists: path.join(DATA_ROOT, 'setlists'),
} as const

// Single-file paths (not directories). Stored under DATA_ROOT.
export const DATA_FILES = {
  // Dataset-wide BPM/grid lock state (single file, not per-song).
  datasetConfig: path.join(DATA_ROOT, 'dataset-config.json'),
} as const

// Parallel paths under data-default/. Only the entries that actually have
// shipped seed content; other entries are intentionally undefined so the
// resolver below falls through cleanly.
export const DEFAULT_DATA_DIRS = {
  manualAnnotations:      path.join(DEFAULT_ANNOTATIONS_ROOT, 'manual'),
  autoGuessAnnotations: path.join(DEFAULT_ANNOTATIONS_ROOT, 'auto-guess'),
  songInfo:             path.join(DEFAULT_DATA_ROOT, 'song-info'),
  songs:                path.join(DEFAULT_DATA_ROOT, 'songs'),
  // Pre-computed Demucs stems shipped with the docker image so demo/public
  // visitors can hear individual stems on the CC0 tracks without us running
  // Demucs on demand. Encoded as 192 kbps MP3 to keep the image lightweight
  // (vs. the ~33 MB-per-stem WAVs that the live Demucs runner emits).
  stems:                path.join(DEFAULT_DATA_ROOT, 'stems'),
} as const

// API URL prefixes used by client services (src/services/*) and the dev-server
// plugins. These are decoupled from on-disk paths so we can rename folders
// without breaking the wire format.
export const API_PATHS = {
  manualAnnotations:      '/api/manual-annotations',
  autoGuessAnnotations: '/api/auto-guess-annotations',
  annotationTimes:      '/api/annotation-times',
  songInfo:             '/api/song-info',
  datasetConfig:        '/api/dataset-config',
  algoClusters:         '/api/algo-clusters',
} as const
