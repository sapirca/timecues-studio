/**
 * Browser-side implementations for each tool.
 *
 * These run in the browser using Web Audio API + custom DSP.
 * For higher accuracy, use the Python versions in agent_versions/05/.
 */

import {
  analyzeBPM,
  analyzeEnergy,
  detectSilences,
  detectSections,
} from '../services/audioAnalysis';
import { computeMIRFeatures, type MIRFeatures } from '../services/mirAnalysis';
import { runBandGradient, type BandGradientResult, type BandGradientParams } from '../utils/bandGradient';

// ─── MIR feature cache ─────────────────────────────────────────────────────────
// WeakMap keyed on AudioBuffer — GC'd automatically when the buffer is released.
// Stores a Promise so concurrent calls for the same buffer share one computation.
const mirCache = new WeakMap<AudioBuffer, Promise<MIRFeatures>>();

function getCachedMIR(audioBuffer: AudioBuffer): Promise<MIRFeatures> {
  if (!mirCache.has(audioBuffer)) {
    mirCache.set(audioBuffer, computeMIRFeatures(audioBuffer, () => {}));
  }
  return mirCache.get(audioBuffer)!;
}

// ─── Result types ──────────────────────────────────────────────────────────────

export interface BPMResult {
  bpm: number;
  beatTimes: number[];
  beatInterval: number;
}

export interface EnergyResult {
  curve: number[];
  frameDuration: number;
  peakTimes: number[];
}

export interface SectionItem {
  time: number;
  label: string;
  endTime: number;
  type: string;
}

export interface SectionsResult {
  sections: SectionItem[];
}

export interface DropsResult {
  drops: { time: number; label: string; intensity: number }[];
}

export interface BuildupsResult {
  buildups: { start: number; end: number; label: string }[];
}

export interface BreakdownsResult {
  breakdowns: { start: number; end: number; label: string }[];
}

export interface SilenceResult {
  silences: { start: number; end: number; duration: number }[];
}

export interface SpectralResult {
  brightness: number[];
  frameDuration: number;
}

export interface OnsetResult {
  onsets: number[];
  curve: number[];
  frameDuration: number;
}

export interface SpectralFluxResult {
  /** Full L2 spectral flux curve (0-1) — sqrt(Σ(Δmag)²) per frame, both onsets and offsets */
  curve: number[];
  frameDuration: number;
}

export interface NoveltyResult {
  /** Novelty curve (cosine distance between adjacent feature vectors, Gaussian-smoothed, 0-1) */
  curve: number[];
  /** Frame duration in seconds (HOP_SIZE / sampleRate) */
  frameDuration: number;
  /** Detected transition events — local maxima of the novelty curve above threshold */
  events: { time: number; intensity: number; label: string }[];
}

export interface HPSResult {
  /** Harmonic energy curve (0-1) — sustained tones, melody, pads */
  harmonic: number[];
  /** Percussive energy curve (0-1) — drums, transients, rhythmic content */
  percussive: number[];
  /** H/P ratio per frame: harmonic / (harmonic + percussive), 0=fully percussive, 1=fully harmonic */
  hpRatio: number[];
  frameDuration: number;
  /** Regions where percussive energy drops below threshold for ≥ 4 s (instrument-detected breakdowns) */
  percussiveDropouts: { start: number; end: number; label: string }[];
}

// Demucs stem separation result (offline-cached, loaded from /stems/<slug>/manifest.json)
export interface DemucsResult {
  stems: { vocals: string; drums: string; bass: string; other: string };
  model: string;
  audioFile: string;
  computedAt: number;
  elapsedSec: number;
}

// MSAF structure result (offline-cached, loaded from /analysis/<slug>/<algo>.json)
export interface MsafSection {
  time: number;
  endTime: number;
  type: string;
  label: string;
  energy: number;
  centroid: number;
}

export interface MsafStructureResult {
  algorithm: string;
  algoName: string;
  audioFile: string;
  duration: number;
  sections: MsafSection[];
  rawBoundaries: number[];
  computedAt: number;
  elapsedSec: number;
}

// All-In-One result (offline-cached, loaded from /analysis/<slug>/allin1.json)
export interface AllIn1Section {
  time: number;
  endTime: number;
  type: string;
  label: string;
}

export interface AllIn1Result {
  algorithm: 'allin1';
  algoName: string;
  audioFile: string;
  duration: number;
  bpm: number;
  beatPositions: number[];
  downbeatPositions: number[];
  sections: AllIn1Section[];
  rawBoundaries: number[];
  computedAt: number;
  elapsedSec: number;
}

export type Allin1FoldId = `allin1-fold${0|1|2|3|4|5|6|7}`;

// Ruptures default-hyperparameter structure result (same shape as MsafStructureResult).
export interface CpdStructureResult extends MsafStructureResult {
  params?: Record<string, unknown>;
}

// SPAN-family detector result (experimental — gated by `experimentalSpanFamily`).
// Stored under data/algorithm-outputs/span/<slug>/<algo>.json by the python
// span_server. We flatten the server's `spans` array into the same
// {time, endTime, label, type} section shape the boundary inspector renders,
// so SPAN algos slot into `AlgorithmRow.sections` without a separate render
// path. The per-kind eval split (IoU / frame-F1 / on-off F1) lands in Phase 2.
export interface SpanStructureResult {
  algorithm: string;            // detector id, e.g. "silero-vad"
  algoName: string;
  audioFile: string;
  duration: number;
  sections: { time: number; endTime: number; type: string; label: string }[];
  computedAt: number;
  elapsedSec: number;
}

export type SpanToolId = 'silero-vad' | 'jdcnet-voicing' | 'panns-cnn14';

/** LOOP-family detector result (experimental — gated by `experimentalLoopFamily`).
 *  Stored under data/algorithm-outputs/loop/<slug>/<algo>.json. Sections shape
 *  matches the BOUNDARY-family inspector so the row visualization works without
 *  a separate render path. */
export interface LoopStructureResult {
  algorithm: string;
  algoName: string;
  audioFile: string;
  duration: number;
  sections: { time: number; endTime: number; type: string; label: string }[];
  computedAt: number;
  elapsedSec: number;
}

export type LoopToolId = 'chroma-autocorr';

/** PATTERN-family detector result (experimental — gated by `experimentalPatternFamily`).
 *  Stored under data/algorithm-outputs/pattern/<slug>/<algo>.json. Each detected
 *  motif occurrence becomes one section so the inspector row can render them
 *  individually (LoCoMotif motif occurrences are variable-length and not
 *  evenly spaced — the contiguous-tile model of PatternItem.repeatCount would
 *  misrepresent them). The `type` field carries `motif-<id>` so the renderer
 *  can color same-motif tiles consistently. */
export interface PatternStructureResult {
  algorithm: string;
  algoName: string;
  audioFile: string;
  duration: number;
  sections: { time: number; endTime: number; type: string; label: string }[];
  computedAt: number;
  elapsedSec: number;
}

export type PatternToolId = 'locomotif';

/** CUE-family note-onset detector result (basic-pitch). Each transcribed note
 *  collapses to a single cue at its onset time, labeled with the pitch name
 *  (e.g. `"C4"`). The note's end time is kept on the result for downstream
 *  consumers (eval, MIDI export) but isn't part of the boundary inspector. */
export interface PitchNoteCueResult {
  algorithm: string;
  algoName: string;
  audioFile: string;
  duration: number;
  /** One cue per transcribed note. Used by the inspector row renderer. */
  sections: { time: number; endTime: number; type: string; label: string }[];
  computedAt: number;
  elapsedSec: number;
}

export type PitchToolId = 'basic-pitch';

/** CUE-family extras (librosa key, autochord, librosa onsets). Three pure-DSP
 *  detectors share the same `cue-extras` sidecar at :8014. Sections are derived
 *  from the server's `cues` list with a vanishing `endTime = time` so the
 *  boundary inspector renders each as a point tick. */
export interface CueExtrasResult {
  algorithm: string;
  algoName: string;
  audioFile: string;
  duration: number;
  sections: { time: number; endTime: number; type: string; label: string }[];
  computedAt: number;
  elapsedSec: number;
  /** Optional global key, set only by `librosa-key`. */
  key?: string | null;
}

export type CueExtrasToolId = 'librosa-key' | 'autochord-chords' | 'librosa-onsets';

/** HPSS percussive-span result (SPAN family). Same shape as SpanStructureResult. */
export type PercussiveToolId = 'hpss-percussive';

/** Whisper-base lyrics result. The boundary inspector renders one row of
 *  word-level cues; downstream consumers (LyricsLayer) read the full payload. */
export interface LyricsToolResult {
  algorithm: string;
  algoName: string;
  audioFile: string;
  duration: number;
  language: string | null;
  /** Per-word cues used by the boundary inspector row. */
  sections: { time: number; endTime: number; type: string; label: string }[];
  computedAt: number;
  elapsedSec: number;
}

export type LyricsToolId = 'whisper-base' | 'ctc-forced-aligner';

// Re-export for use in InspectorPage
export type { BandGradientResult };

export type ToolResultData =
  | { toolId: 'allin1'; result: AllIn1Result }
  | { toolId: Allin1FoldId; result: AllIn1Result }
  | { toolId: 'demucs'; result: DemucsResult }
  | { toolId: 'bpm'; result: BPMResult }
  | { toolId: 'beats'; result: BPMResult }
  | { toolId: 'energy'; result: EnergyResult }
  | { toolId: 'sections'; result: SectionsResult }
  | { toolId: 'drops'; result: DropsResult }
  | { toolId: 'buildups'; result: BuildupsResult }
  | { toolId: 'breakdowns'; result: BreakdownsResult }
  | { toolId: 'silence'; result: SilenceResult }
  | { toolId: 'spectral'; result: SpectralResult }
  | { toolId: 'onsets'; result: OnsetResult }
  | { toolId: 'novelty-function'; result: NoveltyResult }
  | { toolId: 'hps'; result: HPSResult }
  | { toolId: 'spectral-flux'; result: SpectralFluxResult }
  | { toolId: 'msaf-sf';    result: MsafStructureResult }
  | { toolId: 'msaf-foote'; result: MsafStructureResult }
  | { toolId: 'msaf-cnmf';  result: MsafStructureResult }
  | { toolId: 'msaf-olda';  result: MsafStructureResult }
  | { toolId: 'ruptures-pelt-default';   result: CpdStructureResult }
  | { toolId: 'ruptures-binseg-default'; result: CpdStructureResult }
  | { toolId: 'ruptures-window-default'; result: CpdStructureResult }
  | { toolId: 'band-gradient'; result: BandGradientResult }
  | { toolId: 'silero-vad';     result: SpanStructureResult }
  | { toolId: 'jdcnet-voicing'; result: SpanStructureResult }
  | { toolId: 'panns-cnn14';    result: SpanStructureResult }
  | { toolId: 'chroma-autocorr'; result: LoopStructureResult }
  | { toolId: 'basic-pitch';    result: PitchNoteCueResult }
  | { toolId: 'librosa-key';      result: CueExtrasResult }
  | { toolId: 'autochord-chords'; result: CueExtrasResult }
  | { toolId: 'librosa-onsets';   result: CueExtrasResult }
  | { toolId: 'hpss-percussive';  result: SpanStructureResult }
  | { toolId: 'whisper-base';         result: LyricsToolResult }
  | { toolId: 'ctc-forced-aligner';   result: LyricsToolResult }
  | { toolId: 'locomotif';        result: PatternStructureResult };

// ─── Helpers ───────────────────────────────────────────────────────────────────

function normalize(arr: number[]): number[] {
  const max = Math.max(...arr, 1e-9);
  return arr.map((v) => v / max);
}

function float32ToArray(f: Float32Array): number[] {
  return Array.from(f);
}

/** Detect drops: energy peaks where energy jumps sharply after a quiet period */
function detectDrops(
  energyCurve: number[],
  frameDuration: number,
  duration: number
): { time: number; label: string; intensity: number }[] {
  const drops: { time: number; label: string; intensity: number }[] = [];
  const lookback = Math.floor(2 / frameDuration); // 2s lookback
  const min_gap_frames = Math.floor(8 / frameDuration); // 8s between drops
  let lastDrop = -min_gap_frames;

  for (let i = lookback + 1; i < energyCurve.length - 1; i++) {
    const cur = energyCurve[i];
    const prev_avg =
      energyCurve.slice(i - lookback, i).reduce((a, b) => a + b, 0) / lookback;
    const delta = cur - prev_avg;

    // Drop = sharp energy jump (>0.35) that exceeds local average significantly
    if (delta > 0.35 && cur > 0.55 && i - lastDrop > min_gap_frames) {
      const time = i * frameDuration;
      if (time < duration - 2) {
        drops.push({
          time,
          label: `Drop ${drops.length + 1}`,
          intensity: Math.min(1, delta),
        });
        lastDrop = i;
      }
    }
  }
  return drops;
}

/** Detect buildups: sustained rising energy over 4–30s window */
function detectBuildups(
  energyCurve: number[],
  frameDuration: number,
  drops: { time: number }[]
): { start: number; end: number; label: string }[] {
  const buildups: { start: number; end: number; label: string }[] = [];
  const minFrames = Math.floor(4 / frameDuration);
  const maxFrames = Math.floor(30 / frameDuration);

  for (const drop of drops) {
    const dropFrame = Math.floor(drop.time / frameDuration);
    // Look back up to maxFrames before drop
    const searchStart = Math.max(0, dropFrame - maxFrames);
    const slice = energyCurve.slice(searchStart, dropFrame);

    // Find where the sustained rise begins (energy consistently below drop level)
    let riseStart = -1;
    const dropEnergy = energyCurve[dropFrame] ?? 0;
    for (let i = slice.length - 1; i >= minFrames; i--) {
      const sliceAvg = slice.slice(i - minFrames, i).reduce((a, b) => a + b, 0) / minFrames;
      if (sliceAvg < dropEnergy * 0.7) {
        riseStart = i;
        break;
      }
    }

    if (riseStart >= 0) {
      const start = (searchStart + riseStart) * frameDuration;
      const end = drop.time;
      if (end - start >= 3) {
        buildups.push({ start, end, label: `Buildup ${buildups.length + 1}` });
      }
    }
  }
  return buildups;
}

/** Detect breakdowns: low-energy sections of 6–60s */
function detectBreakdowns(
  energyCurve: number[],
  frameDuration: number,
  drops: { time: number }[]
): { start: number; end: number; label: string }[] {
  const breakdowns: { start: number; end: number; label: string }[] = [];
  const threshold = 0.35;
  const minFrames = Math.floor(6 / frameDuration);
  let inBreakdown = false;
  let startFrame = 0;

  for (let i = 0; i < energyCurve.length; i++) {
    if (!inBreakdown && energyCurve[i] < threshold) {
      inBreakdown = true;
      startFrame = i;
    } else if (inBreakdown && energyCurve[i] >= threshold) {
      if (i - startFrame >= minFrames) {
        const start = startFrame * frameDuration;
        const end = i * frameDuration;
        // Only count if not overlapping a drop within 1s
        const nearDrop = drops.some((d) => Math.abs(d.time - start) < 1 || Math.abs(d.time - end) < 1);
        if (!nearDrop) {
          breakdowns.push({ start, end, label: `Breakdown ${breakdowns.length + 1}` });
        }
      }
      inBreakdown = false;
    }
  }
  return breakdowns;
}

// ─── Main dispatcher ───────────────────────────────────────────────────────────

// ─── MSAF cached-result loader ─────────────────────────────────────────────────
//
// MSAF tools don't run in the browser — their results are pre-computed by
// scripts/analyze_structure.py and cached as JSON under data/algorithm-outputs/analysis/.
// runTool accepts an optional audioSlug so the loader knows which file to fetch.

async function loadDemucsCache(audioSlug: string): Promise<DemucsResult> {
  const url = `/stems/${encodeURIComponent(audioSlug)}/manifest.json`;
  const res = await fetch(url);
  // Guard against Vite's SPA fallback returning 200 + HTML for missing paths
  const ct = res.headers.get('content-type') ?? '';
  if (!res.ok || !ct.includes('application/json')) {
    throw new Error(
      `No cached Demucs stems found for "${audioSlug}". ` +
      `Run: python tools/python/tools/demucs_separator.py --all`
    );
  }
  return res.json() as Promise<DemucsResult>;
}

async function loadAllIn1Cache(audioSlug: string): Promise<AllIn1Result> {
  const url = `/analysis/${encodeURIComponent(audioSlug)}/allin1.json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `No cached All-In-One analysis found for "${audioSlug}". ` +
      `Run: python tools/run_allin1.py <audio.mp3> --save`
    );
  }
  return res.json() as Promise<AllIn1Result>;
}

const MSAF_ALGO_IDS: Record<string, string> = {
  'msaf-sf':    'sf',
  'msaf-foote': 'foote',
  'msaf-cnmf':  'cnmf',
  'msaf-olda':  'olda',
};

/**
 * Load a Ruptures default-hyperparameter result.
 *
 *   1. Try the static cache at /analysis/<slug>/ruptures-<suffix>.json
 *   2. On miss, POST to /api/ruptures/analyze, which computes and writes the cache.
 */
async function loadRupturesDefaultResult(
  toolId: string,
  audioSlug: string,
): Promise<CpdStructureResult> {
  const suffix = toolId.replace('ruptures-', '');  // "pelt-default" | "binseg-default" | "window-default"
  const cacheUrl = `/analysis/${encodeURIComponent(audioSlug)}/ruptures-${suffix}.json`;

  const cacheRes = await fetch(cacheUrl);
  const ct = cacheRes.headers.get('content-type') ?? '';
  if (cacheRes.ok && ct.includes('application/json')) {
    return cacheRes.json() as Promise<CpdStructureResult>;
  }

  const serverRes = await fetch('/api/ruptures/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: audioSlug, suffix }),
  });

  if (!serverRes.ok) {
    const err = await serverRes.json().catch(() => ({ error: `HTTP ${serverRes.status}` }));
    if (serverRes.status === 503) {
      throw new Error(
        `Ruptures server is not running. Start it with:\n  python tools/python/ruptures_server.py\n` +
        `Then re-run this tool.`
      );
    }
    throw new Error((err as { error?: string }).error ?? `Ruptures analysis failed (${serverRes.status})`);
  }

  return serverRes.json() as Promise<CpdStructureResult>;
}

/** Load (or compute then load) a SPAN-family detector's cached result via
 *  the python span_server (/api/span). Sticking to the rest-of-runTool
 *  pattern: try the static cache first, then POST to /detect on miss.
 *  The endpoint returns ok=false in the body when the model fails to load
 *  (e.g. dependencies missing in the sidecar) — we surface that as an Error
 *  the inspector renders inline. */
async function loadOrRunSpan(
  toolId: 'silero-vad' | 'jdcnet-voicing',
  audioSlug: string,
): Promise<SpanStructureResult> {
  // GET cache first.
  const cacheUrl = `/api/span/detect/${encodeURIComponent(audioSlug)}/${encodeURIComponent(toolId)}`;
  let raw: unknown = null;
  try {
    const cacheRes = await fetch(cacheUrl);
    if (cacheRes.ok) raw = await cacheRes.json();
  } catch {
    raw = null;
  }

  if (!raw || typeof raw !== 'object' || !('spans' in raw)) {
    // Compute via POST.
    const post = await fetch('/api/span/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: audioSlug, algo: toolId }),
    });
    if (!post.ok) {
      const err = await post.json().catch(() => ({ error: `HTTP ${post.status}` }));
      if (post.status === 503) {
        throw new Error(
          `SPAN sidecar is not running. Start it with:\n  docker compose --profile experimental-models up --build span`
        );
      }
      throw new Error((err as { error?: string }).error ?? `SPAN detect failed (${post.status})`);
    }
    raw = await post.json();
  }

  const payload = raw as {
    audio_file?: string;
    duration?: number;
    spans?: { start: number; end: number; label: string }[];
    ms?: number;
    ok?: boolean;
    error?: string | null;
  };
  if (payload.ok === false) {
    throw new Error(payload.error ?? `SPAN detector ${toolId} returned ok=false`);
  }
  return {
    algorithm:  toolId,
    algoName:   toolId,
    audioFile:  payload.audio_file ?? `${audioSlug}.mp3`,
    duration:   payload.duration ?? 0,
    sections:   (payload.spans ?? []).map((s) => ({
      time:    s.start,
      endTime: s.end,
      type:    s.label,
      label:   s.label,
    })),
    computedAt: Date.now(),
    elapsedSec: (payload.ms ?? 0) / 1000,
  };
}

/** Mirror of `loadOrRunSpan` for the PANNs sidecar at /api/panns. Returns the
 *  same `SpanStructureResult` shape because panns-cnn14 emits SPAN-family
 *  items (one span per (class, time-range) hit). */
async function loadOrRunPanns(audioSlug: string): Promise<SpanStructureResult> {
  const toolId = 'panns-cnn14';
  const cacheUrl = `/api/panns/detect/${encodeURIComponent(audioSlug)}/${encodeURIComponent(toolId)}`;
  let raw: unknown = null;
  try {
    const cacheRes = await fetch(cacheUrl);
    if (cacheRes.ok) raw = await cacheRes.json();
  } catch { raw = null; }

  if (!raw || typeof raw !== 'object' || !('spans' in raw)) {
    const post = await fetch('/api/panns/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: audioSlug, algo: toolId }),
    });
    if (!post.ok) {
      const err = await post.json().catch(() => ({ error: `HTTP ${post.status}` }));
      if (post.status === 503) {
        throw new Error('PANNs sidecar is not running. Start it with:\n  docker compose --profile experimental-models up --build panns');
      }
      throw new Error((err as { error?: string }).error ?? `PANNs detect failed (${post.status})`);
    }
    raw = await post.json();
  }
  const payload = raw as { audio_file?: string; duration?: number; spans?: { start: number; end: number; label: string }[]; ms?: number; ok?: boolean; error?: string };
  if (payload.ok === false) throw new Error(payload.error ?? 'PANNs returned ok=false');
  return {
    algorithm:  toolId,
    algoName:   toolId,
    audioFile:  payload.audio_file ?? `${audioSlug}.mp3`,
    duration:   payload.duration ?? 0,
    sections:   (payload.spans ?? []).map((s) => ({
      time: s.start, endTime: s.end, type: s.label, label: s.label,
    })),
    computedAt: Date.now(),
    elapsedSec: (payload.ms ?? 0) / 1000,
  };
}

/** Load a LOOP-family detector's cached result via the python loop_server
 *  (/api/loop). Falls back to POST on cache miss. Sections are the `loops`
 *  array projected onto the boundary inspector's row shape. */
async function loadOrRunLoop(audioSlug: string): Promise<LoopStructureResult> {
  const toolId = 'chroma-autocorr';
  const cacheUrl = `/api/loop/detect/${encodeURIComponent(audioSlug)}/${encodeURIComponent(toolId)}`;
  let raw: unknown = null;
  try {
    const cacheRes = await fetch(cacheUrl);
    if (cacheRes.ok) raw = await cacheRes.json();
  } catch { raw = null; }

  if (!raw || typeof raw !== 'object' || !('loops' in raw)) {
    const post = await fetch('/api/loop/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: audioSlug, algo: toolId }),
    });
    if (!post.ok) {
      const err = await post.json().catch(() => ({ error: `HTTP ${post.status}` }));
      if (post.status === 503) {
        throw new Error('LOOP sidecar is not running. Start it with:\n  docker compose --profile experimental-models up --build loop');
      }
      throw new Error((err as { error?: string }).error ?? `LOOP detect failed (${post.status})`);
    }
    raw = await post.json();
  }
  const payload = raw as { audio_file?: string; duration?: number; loops?: { start: number; end: number; label: string; bars: number | null }[]; ms?: number; ok?: boolean; error?: string };
  if (payload.ok === false) throw new Error(payload.error ?? 'LOOP returned ok=false');
  return {
    algorithm:  toolId,
    algoName:   toolId,
    audioFile:  payload.audio_file ?? `${audioSlug}.mp3`,
    duration:   payload.duration ?? 0,
    sections:   (payload.loops ?? []).map((l) => ({
      time: l.start, endTime: l.end, type: 'loop', label: l.label,
    })),
    computedAt: Date.now(),
    elapsedSec: (payload.ms ?? 0) / 1000,
  };
}

/** Load a LoCoMotif PATTERN-family motif cache via /api/pattern. Each motif
 *  occurrence projects to one section with `type = "motif-<id>"` so the
 *  inspector colors occurrences of the same motif consistently. */
async function loadOrRunPattern(audioSlug: string): Promise<PatternStructureResult> {
  const toolId = 'locomotif';
  const cacheUrl = `/api/pattern/detect/${encodeURIComponent(audioSlug)}/${encodeURIComponent(toolId)}`;
  let raw: unknown = null;
  try {
    const cacheRes = await fetch(cacheUrl);
    if (cacheRes.ok) raw = await cacheRes.json();
  } catch { raw = null; }

  if (!raw || typeof raw !== 'object' || !('patterns' in raw)) {
    const post = await fetch('/api/pattern/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: audioSlug, algo: toolId }),
    });
    if (!post.ok) {
      const err = await post.json().catch(() => ({ error: `HTTP ${post.status}` }));
      if (post.status === 503) {
        throw new Error('PATTERN sidecar is not running. Start it with:\n  docker compose --profile experimental-models up --build pattern');
      }
      throw new Error((err as { error?: string }).error ?? `PATTERN detect failed (${post.status})`);
    }
    raw = await post.json();
  }
  const payload = raw as {
    audio_file?: string;
    duration?: number;
    patterns?: { start: number; end: number; label: string; motif_id: number }[];
    ms?: number;
    ok?: boolean;
    error?: string;
  };
  if (payload.ok === false) throw new Error(payload.error ?? 'PATTERN returned ok=false');
  return {
    algorithm:  toolId,
    algoName:   toolId,
    audioFile:  payload.audio_file ?? `${audioSlug}.mp3`,
    duration:   payload.duration ?? 0,
    sections:   (payload.patterns ?? []).map((p) => ({
      time: p.start, endTime: p.end, type: `motif-${p.motif_id}`, label: p.label,
    })),
    computedAt: Date.now(),
    elapsedSec: (payload.ms ?? 0) / 1000,
  };
}

/** Load a basic-pitch CUE-family note-onset cache via /api/pitch. Notes are
 *  projected to per-note cues with `time = note.time`, `endTime = note.end`,
 *  `label = note.pitch` (e.g. "C4"). The pitch name doubles as both the
 *  display label and the `type` for the inspector's section-color logic. */
async function loadOrRunPitch(audioSlug: string): Promise<PitchNoteCueResult> {
  const toolId = 'basic-pitch';
  const cacheUrl = `/api/pitch/detect/${encodeURIComponent(audioSlug)}/${encodeURIComponent(toolId)}`;
  let raw: unknown = null;
  try {
    const cacheRes = await fetch(cacheUrl);
    if (cacheRes.ok) raw = await cacheRes.json();
  } catch { raw = null; }

  if (!raw || typeof raw !== 'object' || !('notes' in raw)) {
    const post = await fetch('/api/pitch/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: audioSlug, algo: toolId }),
    });
    if (!post.ok) {
      const err = await post.json().catch(() => ({ error: `HTTP ${post.status}` }));
      if (post.status === 503) {
        throw new Error('Pitch sidecar is not running. Start it with:\n  docker compose --profile experimental-models up --build pitch');
      }
      throw new Error((err as { error?: string }).error ?? `Pitch detect failed (${post.status})`);
    }
    raw = await post.json();
  }
  const payload = raw as { audio_file?: string; duration?: number; notes?: { time: number; end: number; pitch: string; midi: number }[]; ms?: number; ok?: boolean; error?: string };
  if (payload.ok === false) throw new Error(payload.error ?? 'Pitch returned ok=false');
  return {
    algorithm:  toolId,
    algoName:   toolId,
    audioFile:  payload.audio_file ?? `${audioSlug}.mp3`,
    duration:   payload.duration ?? 0,
    sections:   (payload.notes ?? []).map((n) => ({
      time: n.time, endTime: n.end, type: n.pitch, label: n.pitch,
    })),
    computedAt: Date.now(),
    elapsedSec: (payload.ms ?? 0) / 1000,
  };
}

/** CUE-extras loader (key / autochord / onsets). Each algo returns a `cues`
 *  array; we project each cue to a zero-duration section so the boundary
 *  inspector's tick renderer handles them naturally. */
async function loadOrRunCueExtras(toolId: CueExtrasToolId, audioSlug: string): Promise<CueExtrasResult> {
  const cacheUrl = `/api/cue-extras/detect/${encodeURIComponent(audioSlug)}/${encodeURIComponent(toolId)}`;
  let raw: unknown = null;
  try {
    const cacheRes = await fetch(cacheUrl);
    if (cacheRes.ok) raw = await cacheRes.json();
  } catch { raw = null; }

  if (!raw || typeof raw !== 'object' || !('cues' in raw)) {
    const post = await fetch('/api/cue-extras/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: audioSlug, algo: toolId }),
    });
    if (!post.ok) {
      const err = await post.json().catch(() => ({ error: `HTTP ${post.status}` }));
      if (post.status === 503) {
        throw new Error('CUE-extras sidecar is not running. Start it with:\n  docker compose --profile experimental-models up --build cue-extras');
      }
      throw new Error((err as { error?: string }).error ?? `CUE-extras detect failed (${post.status})`);
    }
    raw = await post.json();
  }
  const payload = raw as {
    audio_file?: string; duration?: number; ms?: number; key?: string | null; ok?: boolean; error?: string;
    cues?: { time: number; label: string }[];
  };
  if (payload.ok === false) throw new Error(payload.error ?? `${toolId} returned ok=false`);
  return {
    algorithm:  toolId,
    algoName:   toolId,
    audioFile:  payload.audio_file ?? `${audioSlug}.mp3`,
    duration:   payload.duration ?? 0,
    sections:   (payload.cues ?? []).map((c) => ({
      time: c.time, endTime: c.time, type: 'cue', label: c.label,
    })),
    computedAt: Date.now(),
    elapsedSec: (payload.ms ?? 0) / 1000,
    key:        payload.key ?? null,
  };
}

/** HPSS percussive-span loader. Same response shape as span_server (`spans`). */
async function loadOrRunPercussive(audioSlug: string): Promise<SpanStructureResult> {
  const toolId = 'hpss-percussive';
  const cacheUrl = `/api/percussive/detect/${encodeURIComponent(audioSlug)}/${encodeURIComponent(toolId)}`;
  let raw: unknown = null;
  try {
    const cacheRes = await fetch(cacheUrl);
    if (cacheRes.ok) raw = await cacheRes.json();
  } catch { raw = null; }

  if (!raw || typeof raw !== 'object' || !('spans' in raw)) {
    const post = await fetch('/api/percussive/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: audioSlug, algo: toolId }),
    });
    if (!post.ok) {
      const err = await post.json().catch(() => ({ error: `HTTP ${post.status}` }));
      if (post.status === 503) {
        throw new Error('Percussive sidecar is not running. Start it with:\n  docker compose --profile experimental-models up --build percussive');
      }
      throw new Error((err as { error?: string }).error ?? `Percussive detect failed (${post.status})`);
    }
    raw = await post.json();
  }
  const payload = raw as { audio_file?: string; duration?: number; ms?: number; ok?: boolean; error?: string;
    spans?: { start: number; end: number; label: string }[];
  };
  if (payload.ok === false) throw new Error(payload.error ?? 'Percussive returned ok=false');
  return {
    algorithm:  toolId,
    algoName:   toolId,
    audioFile:  payload.audio_file ?? `${audioSlug}.mp3`,
    duration:   payload.duration ?? 0,
    sections:   (payload.spans ?? []).map((s) => ({
      time: s.start, endTime: s.end, type: s.label, label: s.label,
    })),
    computedAt: Date.now(),
    elapsedSec: (payload.ms ?? 0) / 1000,
  };
}

/** Lyrics-family loader. Projects per-word entries into per-word cues for the
 *  boundary inspector; full payload (lines, language) is preserved on
 *  `LyricsToolResult` for downstream consumers that need the structure.
 *
 *  For `ctc-forced-aligner`, the loader also pulls the per-song reference text
 *  from `/api/lyrics-text/<slug>` and posts it along with the detect request.
 *  Without a transcript on disk the sidecar returns ok=false with a clear
 *  error message asking the annotator to fill the Lyrics text panel first. */
async function loadOrRunLyrics(audioSlug: string, toolId: LyricsToolId): Promise<LyricsToolResult> {
  const cacheUrl = `/api/lyrics/detect/${encodeURIComponent(audioSlug)}/${encodeURIComponent(toolId)}`;
  let raw: unknown = null;
  try {
    const cacheRes = await fetch(cacheUrl);
    if (cacheRes.ok) raw = await cacheRes.json();
  } catch { raw = null; }

  if (!raw || typeof raw !== 'object' || !('words' in raw)) {
    const body: Record<string, unknown> = { slug: audioSlug, algo: toolId };
    if (toolId === 'ctc-forced-aligner') {
      try {
        const txtRes = await fetch(`/api/lyrics-text/${encodeURIComponent(audioSlug)}`);
        if (txtRes.ok) body.text = await txtRes.text();
      } catch { /* sidecar returns a clear error when text is missing */ }
    }
    const post = await fetch('/api/lyrics/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!post.ok) {
      const err = await post.json().catch(() => ({ error: `HTTP ${post.status}` }));
      if (post.status === 503) {
        throw new Error('Lyrics sidecar is not running. Start it with:\n  docker compose --profile experimental-models up --build lyrics');
      }
      throw new Error((err as { error?: string }).error ?? `Lyrics detect failed (${post.status})`);
    }
    raw = await post.json();
  }
  const payload = raw as {
    audio_file?: string; duration?: number; ms?: number; language?: string | null; ok?: boolean; error?: string;
    words?: { time: number; end: number; text: string }[];
  };
  if (payload.ok === false) throw new Error(payload.error ?? 'Lyrics returned ok=false');
  return {
    algorithm:  toolId,
    algoName:   toolId,
    audioFile:  payload.audio_file ?? `${audioSlug}.mp3`,
    duration:   payload.duration ?? 0,
    language:   payload.language ?? null,
    sections:   (payload.words ?? []).map((w) => ({
      time: w.time, endTime: w.end, type: 'word', label: w.text,
    })),
    computedAt: Date.now(),
    elapsedSec: (payload.ms ?? 0) / 1000,
  };
}

async function loadMsafCache(
  toolId: string,
  audioSlug: string
): Promise<MsafStructureResult> {
  const algo = MSAF_ALGO_IDS[toolId];
  const url  = `/analysis/${audioSlug}/${algo}.json`;
  const res  = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `No cached analysis found for "${audioSlug}" / ${algo}. ` +
      `Run: python scripts/analyze_structure.py`
    );
  }
  return res.json() as Promise<MsafStructureResult>;
}

export async function runTool(
  toolId: string,
  audioBuffer: AudioBuffer,
  audioSlug?: string,
  extra?: { bandGradientParams?: BandGradientParams },
): Promise<ToolResultData> {
  const duration = audioBuffer.duration;

  switch (toolId) {
    case 'allin1': {
      if (!audioSlug) throw new Error('All-In-One requires an audioSlug to load cached results.');
      const result = await loadAllIn1Cache(audioSlug);
      return { toolId: 'allin1', result };
    }

    case 'allin1-fold0':
    case 'allin1-fold1':
    case 'allin1-fold2':
    case 'allin1-fold3':
    case 'allin1-fold4':
    case 'allin1-fold5':
    case 'allin1-fold6':
    case 'allin1-fold7': {
      if (!audioSlug) throw new Error('allin1 fold variant requires an audioSlug.');
      const fold = toolId.replace('allin1-', ''); // e.g. "fold3"
      const url = `/analysis/${encodeURIComponent(audioSlug)}/allin1-${fold}.json`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(
          `No cached result for "${audioSlug}" / ${toolId}. ` +
          `Run: python tools/run_allin1.py <audio.mp3> --save --model harmonix-${fold}`
        );
      }
      const result = await res.json() as AllIn1Result;
      return { toolId: toolId as Allin1FoldId, result };
    }

    case 'demucs': {
      if (!audioSlug) throw new Error('Demucs requires an audioSlug to load cached stems.');
      const result = await loadDemucsCache(audioSlug);
      return { toolId: 'demucs', result };
    }

    case 'bpm':
    case 'beats': {
      const res = await analyzeBPM(audioBuffer);
      const data: BPMResult = {
        bpm: res.bpm,
        beatTimes: res.beatTimes,
        beatInterval: 60 / res.bpm,
      };
      return { toolId: toolId as 'bpm' | 'beats', result: data };
    }

    case 'energy': {
      const mir = await getCachedMIR(audioBuffer);
      const curve = normalize(float32ToArray(mir.energy));
      const frameDuration = mir.hopSize / mir.sampleRate;
      const peakRes = await analyzeEnergy(audioBuffer, 0.7, 0.5);
      return { toolId: 'energy', result: { curve, frameDuration, peakTimes: peakRes.peakTimes } };
    }

    case 'sections': {
      const raw = await detectSections(audioBuffer);
      const sections: SectionItem[] = raw.map((s, i) => ({
        time: s.time,
        label: s.label,
        endTime: raw[i + 1]?.time ?? duration,
        type: s.label.toLowerCase().replace(/\s+/g, '_'),
      }));
      return { toolId: 'sections', result: { sections } };
    }

    case 'drops': {
      const mir = await getCachedMIR(audioBuffer);
      const curve = normalize(float32ToArray(mir.energy));
      const frameDuration = mir.hopSize / mir.sampleRate;
      const drops = detectDrops(curve, frameDuration, duration);
      return { toolId: 'drops', result: { drops } };
    }

    case 'buildups': {
      const mir = await getCachedMIR(audioBuffer);
      const curve = normalize(float32ToArray(mir.energy));
      const frameDuration = mir.hopSize / mir.sampleRate;
      const drops = detectDrops(curve, frameDuration, duration);
      const buildups = detectBuildups(curve, frameDuration, drops);
      return { toolId: 'buildups', result: { buildups } };
    }

    case 'breakdowns': {
      const mir = await getCachedMIR(audioBuffer);
      const curve = normalize(float32ToArray(mir.energy));
      const frameDuration = mir.hopSize / mir.sampleRate;
      const drops = detectDrops(curve, frameDuration, duration);
      const breakdowns = detectBreakdowns(curve, frameDuration, drops);
      return { toolId: 'breakdowns', result: { breakdowns } };
    }

    case 'silence': {
      const silenceRegions = await detectSilences(audioBuffer, 0.01, 0.5);
      const silences = silenceRegions.map((s) => ({
        start: s.start,
        end: s.end,
        duration: s.end - s.start,
      }));
      return { toolId: 'silence', result: { silences } };
    }

    case 'spectral': {
      const mir = await getCachedMIR(audioBuffer);
      const brightness = normalize(float32ToArray(mir.centroid));
      const frameDuration = mir.hopSize / mir.sampleRate;
      return { toolId: 'spectral', result: { brightness, frameDuration } };
    }

    case 'onsets': {
      const mir = await getCachedMIR(audioBuffer);
      const curve = normalize(float32ToArray(mir.onsets));
      const frameDuration = mir.hopSize / mir.sampleRate;
      // Pick onset events: frames above 0.6 threshold with min gap
      const minGapFrames = Math.floor(0.1 / frameDuration);
      const onsets: number[] = [];
      let lastOnset = -minGapFrames;
      for (let i = 1; i < curve.length - 1; i++) {
        if (curve[i] > 0.6 && curve[i] > curve[i - 1] && curve[i] > curve[i + 1] && i - lastOnset > minGapFrames) {
          onsets.push(i * frameDuration);
          lastOnset = i;
        }
      }
      return { toolId: 'onsets', result: { onsets, curve, frameDuration } };
    }

    case 'novelty-function': {
      const mir = await getCachedMIR(audioBuffer);
      const curve = float32ToArray(mir.novelty);
      const frameDuration = mir.hopSize / mir.sampleRate;
      // Detect local maxima above 0.45 threshold with min gap of 4 s
      const minGapFrames = Math.floor(4 / frameDuration);
      const events: { time: number; intensity: number; label: string }[] = [];
      let lastEvent = -minGapFrames;
      for (let i = 1; i < curve.length - 1; i++) {
        if (
          curve[i] > 0.45 &&
          curve[i] > curve[i - 1] &&
          curve[i] > curve[i + 1] &&
          i - lastEvent > minGapFrames
        ) {
          events.push({
            time: i * frameDuration,
            intensity: curve[i],
            label: `Transition ${events.length + 1}`,
          });
          lastEvent = i;
        }
      }
      return { toolId: 'novelty-function', result: { curve, frameDuration, events } };
    }

    case 'hps': {
      const mir = await getCachedMIR(audioBuffer);
      const harmonic   = float32ToArray(mir.harmonic);
      const percussive = float32ToArray(mir.percussive);
      const frameDuration = mir.hopSize / mir.sampleRate;
      const hpRatio = harmonic.map((h, i) => {
        const s = h + percussive[i];
        return s > 0 ? h / s : 0.5;
      });
      // Detect percussive dropouts: percussive energy < 0.25 for ≥ 4 s
      const dropoutThreshold = 0.25;
      const minDropoutFrames = Math.floor(4 / frameDuration);
      const percussiveDropouts: { start: number; end: number; label: string }[] = [];
      let inDropout = false;
      let dropoutStart = 0;
      for (let i = 0; i < percussive.length; i++) {
        if (!inDropout && percussive[i] < dropoutThreshold) {
          inDropout = true;
          dropoutStart = i;
        } else if (inDropout && percussive[i] >= dropoutThreshold) {
          if (i - dropoutStart >= minDropoutFrames) {
            percussiveDropouts.push({
              start: dropoutStart * frameDuration,
              end: i * frameDuration,
              label: `P-Dropout ${percussiveDropouts.length + 1}`,
            });
          }
          inDropout = false;
        }
      }
      return { toolId: 'hps', result: { harmonic, percussive, hpRatio, frameDuration, percussiveDropouts } };
    }

    case 'spectral-flux': {
      const mir = await getCachedMIR(audioBuffer);
      const curve = float32ToArray(mir.flux);
      const frameDuration = mir.hopSize / mir.sampleRate;
      return { toolId: 'spectral-flux', result: { curve, frameDuration } };
    }

    case 'msaf-sf':
    case 'msaf-foote':
    case 'msaf-cnmf':
    case 'msaf-olda': {
      if (!audioSlug) {
        throw new Error('MSAF tools require an audioSlug to load cached results.');
      }
      const result = await loadMsafCache(toolId, audioSlug);
      return { toolId: toolId as 'msaf-sf' | 'msaf-foote' | 'msaf-cnmf' | 'msaf-olda', result };
    }

    case 'ruptures-pelt-default':
    case 'ruptures-binseg-default':
    case 'ruptures-window-default': {
      if (!audioSlug) {
        throw new Error('Ruptures tools require an audioSlug.');
      }
      const result = await loadRupturesDefaultResult(toolId, audioSlug);
      return { toolId: toolId as 'ruptures-pelt-default' | 'ruptures-binseg-default' | 'ruptures-window-default', result };
    }

    case 'band-gradient': {
      const result = await runBandGradient(audioBuffer, extra?.bandGradientParams);
      return { toolId: 'band-gradient', result };
    }

    case 'silero-vad':
    case 'jdcnet-voicing': {
      if (!audioSlug) {
        throw new Error('SPAN-family tools require an audioSlug.');
      }
      const result = await loadOrRunSpan(toolId as 'silero-vad' | 'jdcnet-voicing', audioSlug);
      return { toolId: toolId as 'silero-vad' | 'jdcnet-voicing', result };
    }

    case 'panns-cnn14': {
      if (!audioSlug) throw new Error('PANNs requires an audioSlug.');
      const result = await loadOrRunPanns(audioSlug);
      return { toolId: 'panns-cnn14', result };
    }

    case 'chroma-autocorr': {
      if (!audioSlug) throw new Error('LOOP tools require an audioSlug.');
      const result = await loadOrRunLoop(audioSlug);
      return { toolId: 'chroma-autocorr', result };
    }

    case 'basic-pitch': {
      if (!audioSlug) throw new Error('basic-pitch requires an audioSlug.');
      const result = await loadOrRunPitch(audioSlug);
      return { toolId: 'basic-pitch', result };
    }

    case 'librosa-key':
    case 'autochord-chords':
    case 'librosa-onsets': {
      if (!audioSlug) throw new Error('CUE-extras tools require an audioSlug.');
      const result = await loadOrRunCueExtras(toolId as CueExtrasToolId, audioSlug);
      return { toolId: toolId as CueExtrasToolId, result };
    }

    case 'hpss-percussive': {
      if (!audioSlug) throw new Error('HPSS percussive requires an audioSlug.');
      const result = await loadOrRunPercussive(audioSlug);
      return { toolId: 'hpss-percussive', result };
    }

    case 'whisper-base': {
      if (!audioSlug) throw new Error('Whisper-base requires an audioSlug.');
      const result = await loadOrRunLyrics(audioSlug, 'whisper-base');
      return { toolId: 'whisper-base', result };
    }

    case 'ctc-forced-aligner': {
      if (!audioSlug) throw new Error('CTC forced aligner requires an audioSlug.');
      const result = await loadOrRunLyrics(audioSlug, 'ctc-forced-aligner');
      return { toolId: 'ctc-forced-aligner', result };
    }

    case 'locomotif': {
      if (!audioSlug) throw new Error('PATTERN tools require an audioSlug.');
      const result = await loadOrRunPattern(audioSlug);
      return { toolId: 'locomotif', result };
    }

    default:
      throw new Error(`Unknown tool: ${toolId}`);
  }
}
