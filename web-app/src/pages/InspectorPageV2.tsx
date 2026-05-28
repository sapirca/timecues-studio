import { useState, useEffect, useCallback, useRef, useMemo, Fragment, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { SharedVizPanel, DEFAULT_FIXED_ROW_ORDER, BEAT_GRID_UNIT_OPTIONS, type MirCurves, type BeatGridUnit, type VizRowId } from '../components/inspector-v2/SharedVizPanel';
import type { LayerAudioConfig } from '../components/inspector-v2/LayerAudioControls';
import type { PlayerAccent } from '../components/PlayerPanel';
import { VizControlBar } from '../components/inspector-v2/VizControlBar';
import { ManualEditorPanel } from '../components/inspector-v2/ManualEditorPanel';
import { EyeEditorPanel } from '../components/inspector-v2/EyeEditorPanel';
import { CueEditorPanel } from '../components/inspector-v2/CueEditorPanel';
import { CueEditPopover, useCueEditPopover } from '../components/inspector-v2/CueEditPopover';
import { LoopEditorPanel } from '../components/inspector-v2/LoopEditorPanel';
import { LyricsTextPanel } from '../components/inspector-v2/LyricsTextPanel';
import { SpanEditorPanel } from '../components/inspector-v2/SpanEditorPanel';
import { SpanEditPopover, useSpanEditPopover } from '../components/inspector-v2/SpanEditPopover';
import { LoopEditPopover, useLoopEditPopover } from '../components/inspector-v2/LoopEditPopover';
import { PatternEditorPanel } from '../components/inspector-v2/PatternEditorPanel';
import { PatternEditPopover, usePatternEditPopover } from '../components/inspector-v2/PatternEditPopover';
import { UnifiedAnnotationListPanel, type UnifiedLayerSelection } from '../components/inspector-v2/UnifiedAnnotationListPanel';
import { loadLayers, saveLayers, loadAllLayerStatuses, type SongLayerStatuses } from '../services/annotationLayers';
import { emptyDocument as emptyLayersDoc, derivePillDisplay, pickDefaultLayerColor, newId, type AnnotationPillDisplay } from '../types/annotationLayer';
import type { AnnotationLayer, AnnotationLayersDocument, CueItem, LoopItem, SpanItem, PatternItem } from '../types/annotationLayer';
import {
  type AnnotationType,
  type BoundarySource,
  TAB_CONFIG,
  supportsClickPending,
  supportsRangePending,
  supportsPending,
} from '../components/inspector-v2/shared/tabConfig';
import {
  AnnotationSourcePicker,
  type AnnotationCategory,
  type SourceId,
  type SourceOption,
} from '../components/inspector-v2/shared/AnnotationSourcePicker';

/** Type-narrows a SourceId down to one of the three boundary modes. Detector
 *  sources fall through. AnnotationCategory and AnnotationType now coincide;
 *  this helper is the boundary equivalent. */
const isBoundarySource = (s: SourceId): s is BoundarySource =>
  s === 'manual' || s === 'eye' || s === 'autoGuess';

/** Per-source-or-type key for the annotation recording timer. Boundaries
 *  track time per source (manual/eye/autoGuess separately); layer types
 *  track time per type. */
type TimerKey = BoundarySource | 'cues' | 'spans' | 'loops' | 'patterns';

import { DetectorOutputReview } from '../components/inspector-v2/DetectorOutputReview';
import type { DetectorReviewStatus } from '../components/inspector-v2/DetectorOutputReview';
import {
  loadDetectorOutput,
  saveDetectorOutput,
  deleteDetectorOutput,
  listInProgressDetectorOutputs,
  runDetectorWithConflictCheck,
  type EditableDetectorOutput,
} from '../services/detectorOutputs';
import { MarkerConfigPanel } from '../components/inspector-v2/shared/MarkerConfigPanel';
import { MarkerActionsPanel } from '../components/inspector-v2/shared/MarkerActionsPanel';
import { ImportMenu, ExportButton } from '../components/inspector-v2/shared/AnnotationToolbar';
import { AnnotationAddPanel } from '../components/inspector-v2/shared/AnnotationAddPanel';
import {
  emptyCapabilities,
  type AnnotationPanelController,
  type AnnotationPanelCapabilities,
  type ImportFormat,
} from '../components/inspector-v2/shared/AnnotationPanelController';
import { useLoopPlayback } from '../hooks/useLoopPlayback';
import { useUndoableState } from '../hooks/useUndoableState';
import { SongInfoBar } from '../components/inspector-v2/SongInfoBar';
import { GridModeControls } from '../components/inspector-v2/GridModeControls';
import { AnchorListEditor } from '../components/inspector-v2/AnchorListEditor';
import { MetronomePanel } from '../components/inspector-v2/MetronomePanel';
import { CollapsibleSection } from '../components/inspector-v2/CollapsibleSection';
import { ExportManagerModal } from '../components/inspector-v2/ExportManagerModal';
import { ShortcutsHelpPanel } from '../components/inspector-v2/ShortcutsHelpPanel';
import { useAnnotationShortcuts, type ShortcutDef } from '../hooks/useAnnotationShortcuts';
import {
  AlgoInspectStage, buildAnnotationRows, type ToolState, type AlgorithmRow,
  SPAN_ALGO_IDS, LOOP_ALGO_IDS, PITCH_ALGO_IDS, CUE_EXTRAS_ALGO_IDS,
  PERCUSSIVE_ALGO_IDS, LYRICS_ALGO_IDS,
} from '../components/inspector-v2/AlgoInspectStage';
import { EvaluationStage } from '../components/inspector-v2/EvaluationStage';
import { ReferenceAnnotatorPicker } from '../components/inspector-v2/ReferenceAnnotatorPicker';
import { GlobalEvalStage } from '../components/inspector-v2/GlobalEvalStage';
import AutoGuessPanel from '../components/AutoGuessPanel';
import { InfoBanner } from '../components/InfoBanner';
import type { PendingSelection } from '../components/inspector-v2/AnnotationOverlays';
import type { PreviewRegion } from '../components/inspector-v2/PreviewWindow';
import { loadAnnotation, loadEyeAnnotation, loadAutoGuessAnnotation, saveAutoGuessAnnotation, saveAnnotation, loadAllStatuses, deleteAnnotation, deleteEyeAnnotation, deleteAutoGuessAnnotation } from '../services/manualAnnotations';
import { fetchStorageStats, clearSongCaches, clearSongStems, deleteSongEverything, clearAllCaches, formatBytes, type StorageStatsResponse } from '../services/storageStats';
import { DeleteConfirmDialog } from '../components/DeleteConfirmDialog';
import { ClearScopeDialog, type ClearScope } from '../components/ClearScopeDialog';
import { BpmWarningDialog } from '../components/BpmWarningDialog';
import { PostUploadGuideDialog } from '../components/PostUploadGuideDialog';
import { ImportDatasetDialog } from '../components/inspector-v2/ImportDatasetDialog';
import { useAnnotator } from '../context/AnnotatorContext';
import { annotatorHeaders } from '../utils/annotatorHeaders';
import { getCurrentSettings, useSettings } from '../context/SettingsContext';
import { useDemo } from '../context/DemoContext';
import { loadSongInfo, saveSongInfo, loadAllSongInfo } from '../services/songInfo';
import { loadCachedBpm, runBpmDetection, type BpmDetectionResult } from '../services/bpmDetection';
import { loadCachedBeatnet, runBeatnetDetection, type BeatnetDetectionResult } from '../services/beatnetDetection';
import {
  listDetectors, getDetectorResult, runDetector,
  loadCustomAnnotation, saveCustomAnnotation,
} from '../services/customScripts';
import type { CustomRegistryEntry, CustomResultEnvelope, CustomBoundaryItem, CustomSpanItem, CustomLoopItem, CustomPatternItem } from '../types/customScript';
import { computeMIRFeatures } from '../services/mirAnalysis';
import { useCapabilities } from '../hooks/useCapabilities';
import { useAdmin } from '../hooks/useAdmin';
import { useExperimentalAvailability } from '../hooks/useExperimentalAvailability';
import { GPU_TOOLS_UNAVAILABLE_HINT } from '../services/capabilities';
import type { ManualAnnotation, AutoGuessManualAnnotation, AutoGuessPoint, AnnotationStatus } from '../types/manualAnnotation';
import type { SongInfo } from '../types/songInfo';
import { makeEmptySongInfo, isGridReady, effectiveGridMode, effectiveAnchors, getActiveAnchorCount, getActiveBeatOverrideCount, isAnchorMode } from '../types/songInfo';
import { beatsPerBarFromTimeSignature, snapTimeToGrid } from '../utils/beatGrid';
import type { ToolResultData } from '../tools/runTool';

// ─── Audio catalogue ──────────────────────────────────────────────────────────

interface AudioEntry {
  id: string;
  name: string;
  url: string;
}

// ─── Demucs stems ─────────────────────────────────────────────────────────────
// Each song's manifest at /stems/<filename-stem>/manifest.json declares URLs
// for the four Demucs sources. Picker swaps the player URL to one of these.

export type StemSource = 'mix' | 'vocals' | 'drums' | 'bass' | 'other';

interface StemManifest {
  stems: Partial<Record<Exclude<StemSource, 'mix'>, string>>;
}

// Derive the raw filename stem (no extension) from an /audio/<name>.mp3 URL.
// Stems on disk live under that exact name — see web-app/public/stems/<stem>/.
export function stemSlugFromUrl(url: string): string {
  const last = url.split('/').pop() ?? url;
  return decodeURIComponent(last).replace(/\.[^.]+$/, '');
}

// Browser-side JSON download used by the marker panel's ↓ Export for Manual /
// Eye / Auto-guess. Layer types route through their controller's exportJson,
// which already names files like `cues-all_layers-<slug>-<stamp>.json`.
export function downloadJson(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function fetchStemManifest(audioUrl: string): Promise<StemManifest | null> {
  const slug = stemSlugFromUrl(audioUrl);
  try {
    const res = await fetch(`/stems/${encodeURIComponent(slug)}/manifest.json`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data !== 'object' || !data.stems) return null;
    return data as StemManifest;
  } catch {
    return null;
  }
}

// Codespaces' public-port nginx proxy rejects POSTs whose body exceeds its
// `client_max_body_size` with 413 — observed cap is below 20 MB. 8 MB stays
// comfortably under that and still gives sensible progress granularity.
const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
const AUDIO_EXTENSIONS = /\.(mp3|wav|flac|ogg|m4a)$/i;

type ChunkProgress = { chunk: number; totalChunks: number; bytesSent: number; totalBytes: number };

async function uploadSongChunked(
  file: File,
  onProgress?: (p: ChunkProgress) => void,
): Promise<{ id?: string; name?: string; url?: string; hasAnalysis?: boolean }> {
  const total = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK_SIZE));
  let lastResponse: { id?: string; name?: string; url?: string; hasAnalysis?: boolean } = {};
  onProgress?.({ chunk: 0, totalChunks: total, bytesSent: 0, totalBytes: file.size });
  for (let i = 0; i < total; i += 1) {
    const start = i * UPLOAD_CHUNK_SIZE;
    const end   = Math.min(file.size, start + UPLOAD_CHUNK_SIZE);
    const slice = file.slice(start, end);
    const qs = `name=${encodeURIComponent(file.name)}&chunk=${i}&total=${total}`;
    // XHR — fetch() doesn't expose upload progress, so the bar would only
    // tick at chunk boundaries. xhr.upload.onprogress gives byte-level updates.
    lastResponse = await new Promise<typeof lastResponse>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/upload-song?${qs}`);
      for (const [k, v] of Object.entries(annotatorHeaders())) {
        xhr.setRequestHeader(k, v);
      }
      xhr.upload.onprogress = (evt) => {
        if (!evt.lengthComputable) return;
        onProgress?.({
          chunk: i,
          totalChunks: total,
          bytesSent: start + evt.loaded,
          totalBytes: file.size,
        });
      };
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(`HTTP ${xhr.status} on chunk ${i + 1}/${total}: ${String(xhr.responseText || '').slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error(`Bad JSON on chunk ${i + 1}/${total}`));
        }
      };
      xhr.onerror = () => reject(new Error(`Network error on chunk ${i + 1}/${total}`));
      xhr.send(slice);
    });
    onProgress?.({ chunk: i + 1, totalChunks: total, bytesSent: end, totalBytes: file.size });
  }
  return lastResponse;
}

// ── Chunked-upload progress indicator ─────────────────────────────────────────
// Compact: thin animated rainbow bar + single-line summary (sidebar button).
// Wide:    name + chunk readout + thicker bar with a filled rainbow up to the
//          chunk fraction (prep page header). The flowing gradient runs in both
//          variants so the user sees motion even when a single chunk stalls.
type UploadProgressInfo = {
  fileIndex: number;
  totalFiles: number;
  fileName: string;
  chunk: number;
  totalChunks: number;
  bytesSent: number;
  totalBytes: number;
};

export function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function UploadProgressBar({ info, variant }: { info: UploadProgressInfo; variant: 'compact' | 'wide' }) {
  const pct = info.totalBytes > 0
    ? Math.min(100, Math.round((info.bytesSent / info.totalBytes) * 100))
    : 0;
  const chunkLabel = `chunk ${info.chunk}/${info.totalChunks}`;
  const fileLabel = info.totalFiles > 1
    ? `file ${info.fileIndex}/${info.totalFiles}`
    : null;

  if (variant === 'compact') {
    return (
      <div className="flex flex-col gap-1 items-stretch w-full">
        <div className="flex items-center justify-between gap-2 text-[10px] font-mono uppercase tracking-wider text-slate-300 tc-upload-pulse">
          <span>Uploading{fileLabel ? ` ${info.fileIndex}/${info.totalFiles}` : '…'}</span>
          <span className="text-slate-400">{chunkLabel}</span>
        </div>
        <div className="relative h-1.5 rounded-full overflow-hidden bg-white/[0.06]">
          <div
            className="absolute inset-y-0 left-0 tc-upload-flow rounded-full transition-[width] duration-200 ease-out"
            style={{ width: `${Math.max(8, pct)}%` }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 w-full">
      <div className="flex items-center justify-between gap-3 text-[11px] font-mono">
        <span className="text-emerald-200 tc-upload-pulse truncate">
          ⤒ Uploading{fileLabel ? ` ${fileLabel}` : ''} · <span className="text-slate-200">{info.fileName}</span>
        </span>
        <span className="text-slate-300 shrink-0">
          {chunkLabel} · {formatMB(info.bytesSent)} / {formatMB(info.totalBytes)} · {pct}%
        </span>
      </div>
      <div className="relative h-2 rounded-full overflow-hidden bg-white/[0.06] border border-white/10">
        <div
          className="absolute inset-y-0 left-0 tc-upload-flow rounded-full transition-[width] duration-200 ease-out"
          style={{ width: `${Math.max(4, pct)}%` }}
        />
      </div>
    </div>
  );
}

// /analysis/manifest.json is dynamically built by the Vite plugin from the
// corpus matching the request (team → data/, demo → data-default/). A failure
// to fetch yields an empty list rather than a hard-coded seed: showing the
// demo CC0 tracks to a corpus user (or vice-versa) would violate the
// strict-separation contract.
async function fetchManifest(): Promise<AudioEntry[]> {
  try {
    const res = await fetch('/analysis/manifest.json', {
      headers: annotatorHeaders(),
    });
    if (!res.ok) return [];
    const raw: { id: string; name: string; url: string }[] = await res.json();
    return raw;
  } catch {
    return [];
  }
}

export function firstVisibleSong(files: AudioEntry[]): AudioEntry | null {
  return files[0] ?? null;
}

// ─── Stage types ──────────────────────────────────────────────────────────────

type Stage = 'annotation' | 'algo' | 'eval' | 'global-eval';
export type Feature = 'annotate' | 'inspect-song' | 'inspect-all' | 'prep';

function isInspect(f: Feature | null): f is 'inspect-song' | 'inspect-all' {
  return f === 'inspect-song' || f === 'inspect-all';
}

// Per-feature visual theme: page background, header label color.
// Both modes share the dark obsidian canvas; the mode is signalled instead by
// the accent color of tabs, buttons, and the header label — so the page stays
// calm and DAW-like rather than swimming in saturated chrome.
const FEATURE_THEME: Record<Feature, { label: string; pageBg: string }> = {
  'annotate':     { label: 'text-cyan-300',    pageBg: 'bg-[#0a0b0d]' },
  'inspect-song': { label: 'text-violet-300',  pageBg: 'bg-[#0a0b0d]' },
  'inspect-all':  { label: 'text-violet-300',  pageBg: 'bg-[#0a0b0d]' },
  'prep':         { label: 'text-emerald-300', pageBg: 'bg-[#0a0b0d]' },
};

// v2 (2026-05-20): unit IDs were rewritten to be beat-relative and new
// resolutions (32nd, 8th/16th triplets, compound pulse) were added. Old
// v1 entries (e.g. user-customised dropdowns) are intentionally discarded
// so everyone sees the new options.
const BEAT_GRID_UNIT_OPTIONS_STORAGE_KEY = 'timecues.inspector.beatGridUnitOptions.v2';

function readStoredBeatGridUnitOptions(): BeatGridUnit[] {
  if (typeof window === 'undefined') return [...BEAT_GRID_UNIT_OPTIONS];
  try {
    const raw = window.localStorage.getItem(BEAT_GRID_UNIT_OPTIONS_STORAGE_KEY);
    if (!raw) return [...BEAT_GRID_UNIT_OPTIONS];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...BEAT_GRID_UNIT_OPTIONS];
    const next = parsed.filter((unit): unit is BeatGridUnit => BEAT_GRID_UNIT_OPTIONS.includes(unit));
    return next.length > 0 ? next.filter((unit, index) => next.indexOf(unit) === index) : [...BEAT_GRID_UNIT_OPTIONS];
  } catch {
    return [...BEAT_GRID_UNIT_OPTIONS];
  }
}

// Accent class fragments per-feature (used by buttons, tabs, panels, checkboxes, pills)
interface FeatureAccent {
  primary: string;        // primary action button background
  primaryHover: string;
  primaryText: string;
  settingsActive: string; // settings cog when open
  panelBorder: string;    // bordered panel like Run options
  checkbox: string;       // accent-* class for inputs
  tabBorderActive: string;
  tabTextActive: string;
  pillBg: string;         // step-pill running state
  pillText: string;
}

// Annotate mode → clinical surgical teal. Inspect → clinical violet.
// Both desaturated so they read as accent signal, not chrome.
const ACCENT_BLUE: FeatureAccent = {
  primary:         'bg-cyan-500/15',
  primaryHover:    'hover:bg-cyan-500/25',
  primaryText:     'text-cyan-300',
  settingsActive:  'bg-cyan-500/25 text-cyan-200',
  panelBorder:     'border-cyan-500/20',
  checkbox:        'accent-cyan-500',
  tabBorderActive: 'border-cyan-400',
  tabTextActive:   'text-cyan-200',
  pillBg:          'bg-cyan-500/15',
  pillText:        'text-cyan-300',
};

const ACCENT_FUCHSIA: FeatureAccent = {
  primary:         'bg-violet-500/15',
  primaryHover:    'hover:bg-violet-500/25',
  primaryText:     'text-violet-300',
  settingsActive:  'bg-violet-500/25 text-violet-200',
  panelBorder:     'border-violet-500/20',
  checkbox:        'accent-violet-500',
  tabBorderActive: 'border-violet-400',
  tabTextActive:   'text-violet-200',
  pillBg:          'bg-violet-500/15',
  pillText:        'text-violet-300',
};

const ACCENT_EMERALD: FeatureAccent = {
  primary:         'bg-emerald-500/15',
  primaryHover:    'hover:bg-emerald-500/25',
  primaryText:     'text-emerald-300',
  settingsActive:  'bg-emerald-500/25 text-emerald-200',
  panelBorder:     'border-emerald-500/20',
  checkbox:        'accent-emerald-500',
  tabBorderActive: 'border-emerald-400',
  tabTextActive:   'text-emerald-200',
  pillBg:          'bg-emerald-500/15',
  pillText:        'text-emerald-300',
};

function accentFor(feature: Feature | null): FeatureAccent {
  if (feature === 'prep') return ACCENT_EMERALD;
  return isInspect(feature) ? ACCENT_FUCHSIA : ACCENT_BLUE;
}

// Waveform palette is a constant — high-contrast complementary pair (warm
// orange peak halo + vibrant violet RMS body) regardless of mode. The
// waveform is *data*; mode is signalled by chrome (tabs, buttons, labels)
// per the design spec ("saturated colors ONLY to represent data").
const WAVEFORM_PEAK_COLOR = '#f97316'; // orange-500 — outer peak halo
const WAVEFORM_RMS_COLOR  = '#8b5cf6'; // violet-500 — inner RMS body

const PLAYER_ACCENT_BLUE: PlayerAccent = {
  playBtn:       'bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/30',
  songText:      'text-cyan-300',
  slider:        'accent-cyan-500',
  pill:          'text-cyan-300 bg-cyan-500/10',
  waveColor:     WAVEFORM_RMS_COLOR,
  progressColor: WAVEFORM_PEAK_COLOR,
};

const PLAYER_ACCENT_FUCHSIA: PlayerAccent = {
  playBtn:       'bg-violet-500/20 hover:bg-violet-500/30 border border-violet-400/30',
  songText:      'text-violet-300',
  slider:        'accent-violet-500',
  pill:          'text-violet-300 bg-violet-500/10',
  waveColor:     WAVEFORM_RMS_COLOR,
  progressColor: WAVEFORM_PEAK_COLOR,
};

function playerAccentFor(feature: Feature | null): PlayerAccent {
  return isInspect(feature) ? PLAYER_ACCENT_FUCHSIA : PLAYER_ACCENT_BLUE;
}

// ─── Algo JSON loading ────────────────────────────────────────────────────────

const ALGO_ORDER = [
  'msaf-olda', 'msaf-cnmf', 'msaf-foote', 'msaf-sf',
  'allin1',
  ...[0,1,2,3,4,5,6,7].map((n) => `allin1-fold${n}`),
  'ruptures-pelt-default', 'ruptures-binseg-default', 'ruptures-window-default',
  'band-gradient',
  // SPAN family (experimental — gated by `experimentalSpanFamily` further
  // down where the sidebar grid is rendered).
  'silero-vad', 'jdcnet-voicing', 'panns-cnn14',
  // LOOP family (`experimentalLoopFamily`).
  'chroma-autocorr',
  // CUE-family note-onset detector (`experimentalCueExtras`).
  'basic-pitch',
  // CUE-family extras (`experimentalCueExtras`): key, chords, onsets.
  'librosa-key', 'autochord-chords', 'librosa-onsets',
  // SPAN family addition: percussive HPSS (`experimentalSpanFamily`).
  'hpss-percussive',
  // LYRICS family — Whisper-base (`experimentalLyricsFamily`).
  'whisper-base',
] as const;

const ALLIN1_FOLD_IDS = new Set([0,1,2,3,4,5,6,7].map((n) => `allin1-fold${n}`));
const SPAN_TOOL_IDS  = new Set(['silero-vad', 'jdcnet-voicing']);
const PANNS_TOOL_IDS = new Set(['panns-cnn14']);
const LOOP_TOOL_IDS  = new Set(['chroma-autocorr']);
const PITCH_TOOL_IDS = new Set(['basic-pitch']);
const CUE_EXTRAS_TOOL_IDS = new Set(['librosa-key', 'autochord-chords', 'librosa-onsets']);
const PERCUSSIVE_TOOL_IDS = new Set(['hpss-percussive']);
const LYRICS_TOOL_IDS     = new Set(['whisper-base']);

// `null`  → the cache file truly doesn't exist (or fetch failed). UI treats
//           the tool as never-run.
// `{ result, error }` with a non-empty error → the file exists but the
//           sidecar reported `ok: false` (missing weights, missing deps,
//           audio decode failure). UI shows a "failed" pill with the
//           reason in a tooltip, and the next "Run missing" click retries.
// `{ result }` with empty sections → the run succeeded but the detector
//           found nothing (silero-vad on an instrumental, whisper on a
//           silent track). That's a legitimate cached result — without
//           returning it here the UI would loop on "Run missing" forever
//           because toolStates[id] would never flip to 'done'.
async function loadAlgoJson(
  songId: string,
  toolId: string,
): Promise<{ result: ToolResultData; error?: string } | null> {
  type ExperimentalKind = { kind: 'spans' } | { kind: 'loops' } | { kind: 'notes' } | { kind: 'cues' } | { kind: 'words' };
  async function readExperimental(
    prefix: string,
    kind: ExperimentalKind,
  ): Promise<{ result: ToolResultData; error?: string } | null> {
    try {
      const res = await fetch(`/api/${prefix}/detect/${encodeURIComponent(songId)}/${encodeURIComponent(toolId)}`);
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || typeof data !== 'object') return null;
      const payload = data as {
        audio_file?: string; duration?: number; ms?: number;
        ok?: boolean; error?: string | null;
        spans?: { start: number; end: number; label: string }[];
        loops?: { start: number; end: number; label: string }[];
        notes?: { time: number; end: number; pitch: string }[];
        cues?:  { time: number; label: string }[];
        words?: { time: number; end: number; text: string }[];
        // Single-value globals: `key` (librosa-key), `language` (whisper-base).
        // Surfaced as toolbar pills, so they must survive the cache-load path.
        key?: string | null;
        language?: string | null;
      };
      const sections =
        kind.kind === 'spans' ? (payload.spans ?? []).map((s) => ({
          time: s.start, endTime: s.end, type: s.label, label: s.label,
        })) :
        kind.kind === 'loops' ? (payload.loops ?? []).map((l) => ({
          time: l.start, endTime: l.end, type: 'loop', label: l.label,
        })) :
        kind.kind === 'notes' ? (payload.notes ?? []).map((n) => ({
          time: n.time, endTime: n.end, type: n.pitch, label: n.pitch,
        })) :
        kind.kind === 'cues'  ? (payload.cues ?? []).map((c) => ({
          time: c.time, endTime: c.time, type: 'cue', label: c.label,
        })) :
        /* words */ (payload.words ?? []).map((w) => ({
          time: w.time, endTime: w.end, type: 'word', label: w.text,
        }));
      const result: ToolResultData = {
        toolId,
        result: {
          algorithm:  toolId,
          algoName:   toolId,
          audioFile:  payload.audio_file ?? `${songId}.mp3`,
          duration:   payload.duration ?? 0,
          sections,
          computedAt: Date.now(),
          elapsedSec: (payload.ms ?? 0) / 1000,
          ...(kind.kind === 'cues'  ? { key:      payload.key ?? null } : {}),
          ...(kind.kind === 'words' ? { language: payload.language ?? null } : {}),
        },
      } as ToolResultData;
      const error = payload.ok === false
        ? (payload.error?.trim() || 'detector reported ok=false')
        : undefined;
      return { result, error };
    } catch { return null; }
  }

  if (SPAN_TOOL_IDS.has(toolId))       return readExperimental('span',       { kind: 'spans' });
  if (PANNS_TOOL_IDS.has(toolId))      return readExperimental('panns',      { kind: 'spans' });
  if (LOOP_TOOL_IDS.has(toolId))       return readExperimental('loop',       { kind: 'loops' });
  if (PITCH_TOOL_IDS.has(toolId))      return readExperimental('pitch',      { kind: 'notes' });
  if (CUE_EXTRAS_TOOL_IDS.has(toolId)) return readExperimental('cue-extras', { kind: 'cues' });
  if (PERCUSSIVE_TOOL_IDS.has(toolId)) return readExperimental('percussive', { kind: 'spans' });
  if (LYRICS_TOOL_IDS.has(toolId))     return readExperimental('lyrics',     { kind: 'words' });

  const algoSlug =
    toolId.startsWith('msaf-') ? toolId.replace('msaf-', '') :
    toolId === 'allin1' ? 'allin1' :
    ALLIN1_FOLD_IDS.has(toolId) ? toolId :
    toolId.startsWith('ruptures-') ? toolId :
    toolId === 'band-gradient' ? 'band-gradient' : null;
  if (!algoSlug) return null;
  try {
    const res = await fetch(`/analysis/${songId}/${algoSlug}.json`);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) return null;
    const data = await res.json();
    return { result: { toolId, result: data } as ToolResultData };
  } catch {
    return null;
  }
}

// ─── Live auto-guess clustering (centroid-linkage, same algorithm as AutoGuessPanel) ───

const LIVE_CLUSTER_TOLERANCE = 3; // seconds

function computeLiveClusters(
  rows: { id: string; sections: { time: number }[] }[],
  toleranceSec: number,
): AutoGuessPoint[] {
  const allPoints = rows.flatMap((r) => r.sections.map((s) => ({ algorithmId: r.id, time: s.time })));
  if (!allPoints.length) return [];
  const sorted = [...allPoints].sort((a, b) => a.time - b.time);
  const clusters: { sum: number; count: number; members: { algorithmId: string; time: number }[] }[] = [];
  for (const pt of sorted) {
    let bestIdx = -1, bestDist = Infinity;
    for (let k = clusters.length - 1; k >= 0; k--) {
      const centroid = clusters[k].sum / clusters[k].count;
      if (pt.time - centroid > toleranceSec) break;
      const dist = Math.abs(pt.time - centroid);
      if (dist <= toleranceSec && dist < bestDist) { bestDist = dist; bestIdx = k; }
    }
    if (bestIdx >= 0) {
      clusters[bestIdx].members.push(pt); clusters[bestIdx].sum += pt.time; clusters[bestIdx].count += 1;
    } else {
      clusters.push({ sum: pt.time, count: 1, members: [pt] });
    }
  }
  return clusters.map(({ members }, clusterId) => {
    const meanTime = members.reduce((s, m) => s + m.time, 0) / members.length;
    return {
      id: `live-${clusterId}`,
      time: meanTime,
      originalTime: meanTime,
      sources: members.map((m) => ({ algorithmId: m.algorithmId, originalTime: m.time })),
      clusterId,
      clusterSize: members.length,
      status: 'pending' as const,
    };
  });
}

// ─── Ruptures (CPD) cached results ────────────────────────────────────────────
// 19 method variants from Truong/Oudre/Vayatis. Cached as
// /analysis/<slug>/ruptures-<suffix>.json by tools/python/ruptures_server.py.

interface RupturesMethod { search: string; model: string; suffix: string }

const RUPTURES_METHODS: RupturesMethod[] = [
  { search: 'Dynp',     model: 'rbf',    suffix: 'dynp-rbf'      },
  { search: 'Dynp',     model: 'l2',     suffix: 'dynp-l2'       },
  { search: 'Dynp',     model: 'l1',     suffix: 'dynp-l1'       },
  { search: 'Dynp',     model: 'ar',     suffix: 'dynp-ar'       },
  { search: 'Pelt',     model: 'rbf',    suffix: 'pelt-rbf'      },
  { search: 'Pelt',     model: 'l2',     suffix: 'pelt-l2'       },
  { search: 'Pelt',     model: 'l1',     suffix: 'pelt-l1'       },
  { search: 'Pelt',     model: 'ar',     suffix: 'pelt-ar'       },
  { search: 'Pelt',     model: 'rank',   suffix: 'pelt-rank'     },
  { search: 'Window',   model: 'rbf',    suffix: 'window-rbf'    },
  { search: 'Window',   model: 'l2',     suffix: 'window-l2'     },
  { search: 'Window',   model: 'linear', suffix: 'window-linear' },
  { search: 'Binseg',   model: 'rbf',    suffix: 'binseg-rbf'    },
  { search: 'Binseg',   model: 'l2',     suffix: 'binseg-l2'     },
  { search: 'Binseg',   model: 'l1',     suffix: 'binseg-l1'     },
  { search: 'Binseg',   model: 'ar',     suffix: 'binseg-ar'     },
  { search: 'Binseg',   model: 'rank',   suffix: 'binseg-rank'   },
  { search: 'BottomUp', model: 'l2',     suffix: 'bottomup-l2'   },
  { search: 'BottomUp', model: 'rbf',    suffix: 'bottomup-rbf'  },
];

interface RupturesResultJson {
  algoName: string;
  suffix: string;
  duration: number;
  sections: { time: number; endTime: number; type: string; label: string }[];
  rawBoundaries: number[];
}

// Label colors per algo group — used to color the row labels in SharedVizPanel.
const ALGO_LABEL_COLORS: Record<string, string> = {
  'msaf-olda':   '#34d399', 'msaf-cnmf':  '#34d399', 'msaf-foote': '#34d399', 'msaf-sf': '#34d399',
  'ruptures-pelt-default':   '#60a5fa',
  'ruptures-binseg-default': '#60a5fa',
  'ruptures-window-default': '#60a5fa',
  'band-gradient': '#94a3b8',
  // SPAN family — violet tint signals "experimental", matches the Initialize
  // models panel's Initialize-all button.
  'silero-vad':       '#c084fc',
  'jdcnet-voicing':   '#c084fc',
  'panns-cnn14':      '#c084fc',
  // LOOP family — amber so the loop rows read distinctly from spans.
  'chroma-autocorr':  '#fbbf24',
  // CUE-family note-onset detector — pink, distinct from boundary chips.
  'basic-pitch':      '#f472b6',
  // CUE-family extras — teal trio so key/chords/onsets cluster visually.
  'librosa-key':       '#2dd4bf',
  'autochord-chords':  '#2dd4bf',
  'librosa-onsets':    '#2dd4bf',
  // HPSS percussive (SPAN family) — orange so it doesn't blend with voicing.
  'hpss-percussive':   '#fb923c',
  // LYRICS family — rose, distinct from cue-extras teal.
  'whisper-base':      '#fb7185',
  'allin1': '#f97316',
};
[0,1,2,3,4,5,6,7].forEach((n) => { ALGO_LABEL_COLORS[`allin1-fold${n}`] = '#f97316'; });

const RUPTURES_SEARCH_COLORS: Record<string, string> = {
  Dynp:     '#818cf8',
  Pelt:     '#a78bfa',
  Window:   '#fb923c',
  Binseg:   '#34d399',
  BottomUp: '#f87171',
};

function rupturesLabelColor(suffix: string): string {
  const m = RUPTURES_METHODS.find((x) => x.suffix === suffix);
  return (m && RUPTURES_SEARCH_COLORS[m.search]) ?? '#94a3b8';
}

// How an algo's output should be drawn on the timeline. Boundary detectors
// (MSAF / ruptures / allin1 / band-gradient / custom-boundary) tile the track
// into contiguous labeled section blocks. The experimental families don't:
// CUE-extras emit zero-duration events (onsets / key / chords) → point ticks
// like cue markers; SPAN / LOOP / PITCH / PERCUSSIVE / LYRICS emit sparse
// intervals → translucent bands like span markers.
type AlgoRenderKind = 'boundary' | 'span' | 'point';
const POINT_ALGO_IDS = new Set<string>(CUE_EXTRAS_ALGO_IDS);
const SPAN_RENDER_ALGO_IDS = new Set<string>([
  ...SPAN_ALGO_IDS, ...LOOP_ALGO_IDS, ...PITCH_ALGO_IDS,
  ...PERCUSSIVE_ALGO_IDS, ...LYRICS_ALGO_IDS,
]);
function algoRenderKind(id: string): AlgoRenderKind {
  if (POINT_ALGO_IDS.has(id)) return 'point';
  if (SPAN_RENDER_ALGO_IDS.has(id)) return 'span';
  return 'boundary';
}

// Detectors whose output is a single global value (e.g. the song key), not a
// timeline. They're shown as always-visible pills in the toolbar and kept out
// of the algo overlay rows / consensus clustering entirely.
const SINGLE_INFO_ONLY_IDS = new Set<string>(['librosa-key']);

// Distinct, vivid colors cycled per custom-annotation detector so each row's
// strip stands out from the others. Indexed by the detector's order in the
// registry; wraps around if there are more detectors than palette entries.
const CUSTOM_ANNOTATION_PALETTE: string[] = [
  '#f43f5e', // rose
  '#fb923c', // orange
  '#facc15', // yellow
  '#84cc16', // lime
  '#06b6d4', // cyan
  '#6366f1', // indigo
  '#d946ef', // fuchsia
  '#ec4899', // pink
];

// Convert a CustomResultEnvelope of boundary items into the section shape the canvas expects.
// Each detected boundary becomes the start of a section running up to the next boundary
// (or end-of-track for the final one), matching how the built-in detectors are flattened.
// `color` is per-detector and emitted on each section so the algo row paints with a vivid
// hue instead of falling through to the near-invisible slate-400 default.
function customEnvelopeToSections(
  env: CustomResultEnvelope,
  trackDuration: number,
  color: string,
): { time: number; endTime: number; label: string; type: string; color: string }[] {
  if (env.output_kind !== 'boundary') return [];
  const items = (env.items as CustomBoundaryItem[])
    .map((it) => ({ time: it.time_ms / 1000, label: it.label ?? '' }))
    .sort((a, b) => a.time - b.time);
  return items.map((it, i) => ({
    time: it.time,
    endTime: items[i + 1]?.time ?? (trackDuration > 0 ? trackDuration : it.time),
    label: it.label || 'boundary',
    type: 'custom',
    color,
  }));
}

// ─── Component ────────────────────────────────────────────────────────────────

// `onBack` prop kept on the type so the caller in App.tsx remains stable —
// not currently consumed by the V2 page (mode-switcher is now in-page).
export function InspectorPageV2(props: { onBack: () => void; initialFeature?: Feature; feature?: Feature }) {
  const navigate = useNavigate();
  // GPU tooling availability — single source of truth, baked into the
  // gpu-tools Docker image at build time. Drives the disabled/tooltip state
  // for allin1 + Demucs surfaces; the features stay visible so users see
  // what they're missing on a CPU-only install.
  const { capabilities: gpuCaps } = useCapabilities();
  const { status: adminStatus } = useAdmin();
  // ── Catalogue ────────────────────────────────────────────────────────────
  const [audioFiles, setAudioFiles] = useState<AudioEntry[]>([]);
  const [selectedAudio, setSelectedAudio] = useState<AudioEntry | null>(null);
  const selectedAudioRef = useRef<AudioEntry | null>(null);
  useEffect(() => { selectedAudioRef.current = selectedAudio; }, [selectedAudio]);
  // Sidebar row actions (X / clear-cache) — separate from selection so clicking
  // outside the song list dismisses them without un-selecting the active song.
  const [actionsOpenSlug, setActionsOpenSlug] = useState<string | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!actionsOpenSlug) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!sidebarRef.current?.contains(e.target as Node)) setActionsOpenSlug(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setActionsOpenSlug(null); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [actionsOpenSlug]);

  // ── Demucs stem player ───────────────────────────────────────────────────
  const [selectedStemSource, setSelectedStemSource] = useState<StemSource>('mix');
  const [stemManifest, setStemManifest] = useState<StemManifest | null>(null);
  const [songStatuses, setSongStatuses] = useState<Record<string, AnnotationStatus>>({});
  // Per-song user-created layer summaries (cues/spans/loops/patterns) for the
  // current annotator. Combined with `songStatuses` to drive the song-list's
  // overall annotation indicator + per-type popover. Reloaded when the
  // annotator changes.
  const [songLayerStatuses, setSongLayerStatuses] = useState<Record<string, SongLayerStatuses>>({});
  // Slug whose annotation-status popover is currently open in the sidebar.
  // Closes on outside-click + Escape, same pattern as the per-row action menu.
  const [statusPopoverSlug, setStatusPopoverSlug] = useState<string | null>(null);
  const statusPopoverRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!statusPopoverSlug) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!statusPopoverRef.current?.contains(e.target as Node)) setStatusPopoverSlug(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setStatusPopoverSlug(null); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [statusPopoverSlug]);

  // Disk-usage stats per song + aggregate. Refreshed on mount, after upload,
  // after song delete, and after each cache-clear action.
  const [storageStats, setStorageStats] = useState<StorageStatsResponse | null>(null);
  const refreshStorageStats = useCallback(() => {
    fetchStorageStats().then(setStorageStats);
  }, []);
  // Pending confirmation: a slug to clear, or 'all' for the global clear.
  const [pendingCacheClear, setPendingCacheClear] = useState<string | 'all' | null>(null);
  // Per-song tri-mode clear dialog (STEM / ALGOS / EVERYTHING). Used in /prep
  // mode where the sidebar exposes per-song storage breakdown instead of
  // annotation status LEDs. `null` when closed.
  const [pendingClearScope, setPendingClearScope] = useState<string | null>(null);
  // Per-song info cache for the sidebar's grid-readiness indicator. Loaded
  // when the manifest changes; refreshed locally whenever the active song's
  // info is edited so the sidebar mirrors the editor without a round-trip.
  const [songInfos, setSongInfos] = useState<Record<string, SongInfo>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem('tc:song-sidebar-collapsed');
      if (stored !== null) return stored === '1';
      return getCurrentSettings().defaultSidebarCollapsed;
    } catch { return getCurrentSettings().defaultSidebarCollapsed; }
  });
  useEffect(() => {
    try { localStorage.setItem('tc:song-sidebar-collapsed', sidebarCollapsed ? '1' : '0'); } catch {}
  }, [sidebarCollapsed]);
  const SIDEBAR_MIN_WIDTH = 180;
  const SIDEBAR_MAX_WIDTH = 560;
  const SIDEBAR_DEFAULT_WIDTH = 256;
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const stored = localStorage.getItem('tc:song-sidebar-width');
      const n = stored ? parseInt(stored, 10) : NaN;
      if (Number.isFinite(n) && n >= SIDEBAR_MIN_WIDTH && n <= SIDEBAR_MAX_WIDTH) return n;
    } catch {}
    return SIDEBAR_DEFAULT_WIDTH;
  });
  useEffect(() => {
    try { localStorage.setItem('tc:song-sidebar-width', String(sidebarWidth)); } catch {}
  }, [sidebarWidth]);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const startSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setSidebarResizing(true);
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, startW + (ev.clientX - startX)));
      setSidebarWidth(next);
    };
    const onUp = () => {
      setSidebarResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  // Right-edge annotation sidebar (replaces the legacy "Start annotating"
  // collapsible). Holds the marker config row, tabs, and add panel; the
  // section cards/layers stay in the centre column. Width & collapsed state
  // persist per browser; resize handle lives on the LEFT edge so dragging
  // leftwards widens the panel.
  const ANNOTATE_SIDEBAR_MIN_WIDTH = 300;
  const ANNOTATE_SIDEBAR_MAX_WIDTH = 640;
  const ANNOTATE_SIDEBAR_DEFAULT_WIDTH = 380;
  const [annotateSidebarCollapsed, setAnnotateSidebarCollapsed] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem('tc:annotate-sidebar-collapsed');
      return stored === '1';
    } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('tc:annotate-sidebar-collapsed', annotateSidebarCollapsed ? '1' : '0'); } catch {}
  }, [annotateSidebarCollapsed]);
  const [annotateSidebarWidth, setAnnotateSidebarWidth] = useState<number>(() => {
    try {
      const stored = localStorage.getItem('tc:annotate-sidebar-width');
      const n = stored ? parseInt(stored, 10) : NaN;
      if (Number.isFinite(n) && n >= ANNOTATE_SIDEBAR_MIN_WIDTH && n <= ANNOTATE_SIDEBAR_MAX_WIDTH) return n;
    } catch {}
    return ANNOTATE_SIDEBAR_DEFAULT_WIDTH;
  });
  useEffect(() => {
    try { localStorage.setItem('tc:annotate-sidebar-width', String(annotateSidebarWidth)); } catch {}
  }, [annotateSidebarWidth]);
  const [annotateSidebarResizing, setAnnotateSidebarResizing] = useState(false);
  const startAnnotateSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setAnnotateSidebarResizing(true);
    const startX = e.clientX;
    const startW = annotateSidebarWidth;
    const onMove = (ev: MouseEvent) => {
      // Right-anchored sidebar: dragging LEFT (clientX decreases) widens.
      const next = Math.min(ANNOTATE_SIDEBAR_MAX_WIDTH, Math.max(ANNOTATE_SIDEBAR_MIN_WIDTH, startW + (startX - ev.clientX)));
      setAnnotateSidebarWidth(next);
    };
    const onUp = () => {
      setAnnotateSidebarResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  // Overflow menu in the sidebar title row — holds rare actions (Export
  // Manager, Delete-all) that used to live in a dedicated header block
  // below the title. Closing on outside-click keeps it from sticking open
  // when the user clicks back into the editor.
  const [annotateMenuOpen, setAnnotateMenuOpen] = useState(false);
  const annotateMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!annotateMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (annotateMenuRef.current && !annotateMenuRef.current.contains(e.target as Node)) {
        setAnnotateMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [annotateMenuOpen]);

  // Right-edge Algorithm-Inspect sidebar — lists every registered algorithm
  // (MSAF / All-In-One / Ruptures / band-gradient / custom) with cached
  // badges, and surfaces the ▶ Run for this song trigger. Mirrors the
  // Annotate sidebar's geometry (300–640 px, drag-left to widen, collapses
  // to a hover tab on the right edge). Persists per browser.
  const ALGO_SIDEBAR_MIN_WIDTH = 320;
  const ALGO_SIDEBAR_MAX_WIDTH = 640;
  const ALGO_SIDEBAR_DEFAULT_WIDTH = 420;
  const [algoSidebarCollapsed, setAlgoSidebarCollapsed] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem('tc:algo-sidebar-collapsed');
      return stored === '1';
    } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('tc:algo-sidebar-collapsed', algoSidebarCollapsed ? '1' : '0'); } catch {}
  }, [algoSidebarCollapsed]);
  const [algoSidebarWidth, setAlgoSidebarWidth] = useState<number>(() => {
    try {
      const stored = localStorage.getItem('tc:algo-sidebar-width');
      const n = stored ? parseInt(stored, 10) : NaN;
      if (Number.isFinite(n) && n >= ALGO_SIDEBAR_MIN_WIDTH && n <= ALGO_SIDEBAR_MAX_WIDTH) return n;
    } catch {}
    return ALGO_SIDEBAR_DEFAULT_WIDTH;
  });
  useEffect(() => {
    try { localStorage.setItem('tc:algo-sidebar-width', String(algoSidebarWidth)); } catch {}
  }, [algoSidebarWidth]);
  const [algoSidebarResizing, setAlgoSidebarResizing] = useState(false);
  const startAlgoSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setAlgoSidebarResizing(true);
    const startX = e.clientX;
    const startW = algoSidebarWidth;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(ALGO_SIDEBAR_MAX_WIDTH, Math.max(ALGO_SIDEBAR_MIN_WIDTH, startW + (startX - ev.clientX)));
      setAlgoSidebarWidth(next);
    };
    const onUp = () => {
      setAlgoSidebarResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  // ── Upload ────────────────────────────────────────────────────────────────
  const [uploading, setUploading] = useState(false);
  // Granular chunk progress for the moving upload indicator. null while idle.
  const [uploadProgress, setUploadProgress] = useState<{
    fileIndex: number;       // 1-based
    totalFiles: number;
    fileName: string;
    chunk: number;           // 0..totalChunks (0 = starting)
    totalChunks: number;
    bytesSent: number;
    totalBytes: number;
  } | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [sidebarDragActive, setSidebarDragActive] = useState(false);
  const sidebarDragDepthRef = useRef(0);

  // ── Run algorithms ────────────────────────────────────────────────────────
  // `sections` arrives from /api/run-algorithms/status — one entry per
  // algorithm family (MSAF / All-In-One / Ruptures). Per-section pill colors
  // and the summary line are derived from these counts so a server outage
  // ("4 failed") can't masquerade as success.
  // `errors` lists each failed algorithm with the canonical UI id (e.g.
  // "msaf-sf", "ruptures-pelt-rbf", "allin1-fold3") and a short message — the
  // sidebar shows a red "failed" pill on the matching row with this message
  // as the hover tooltip.
  type RunJobAlgoError = { id: string; message: string };
  type RunJobSection = { label: string; total: number; ok: number; failed: number; cached: number; errors?: RunJobAlgoError[] };
  const [runJob, setRunJob] = useState<{ jobId: string; status: string; logs: string; startedAt: number; sections?: RunJobSection[] } | null>(null);
  const runJobPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logPreRef = useRef<HTMLPreElement>(null);
  const [, setElapsedTick] = useState(0);

  // ── Demucs stem job (per song, separate from runJob so stemming doesn't block the run-algo panel) ──
  // progressPct + lastLine are parsed from Demucs's tqdm output on each poll
  // tick so the StemSourcePicker pill can show "Stemming… 38% · 1:24" plus a
  // subtitle with the current step instead of a silent "⏳ Stemming…".
  // cancelMode echoes the server's view (set when /cancel or /kill is hit) so
  // the pill can show "⌛ Cancelling…" / "⌛ Killing…" between request and
  // subprocess exit.
  const [demucsJob, setDemucsJob] = useState<{ slug: string; jobId: string; status: string; logs: string; startedAt: number; progressPct?: number; lastLine?: string; cancelMode?: 'soft' | 'hard' } | null>(null);

  // ── Run options ───────────────────────────────────────────────────────────
  const DEMUCS_MODELS = [
    { id: 'htdemucs',  label: 'htdemucs (default, ~2 GB)' },
    { id: 'mdx',       label: 'mdx (lighter)' },
    { id: 'mdx_q',     label: 'mdx_q (quantized, lightest)' },
    { id: 'mdx_extra', label: 'mdx_extra' },
  ] as const;
  const [demucsModel, setDemucsModel] = useState<string>('htdemucs');
  const [selectedAlgorithms, setSelectedAlgorithms] = useState<Set<string>>(() => {
    const userDefaults = getCurrentSettings().defaultAlgorithms;
    return new Set([
      ...userDefaults,
      ...RUPTURES_METHODS.map((m) => `ruptures-${m.suffix}`),
    ]);
  });
  // null = closed. 'dataset' = opened from the Algo Inspect ⚙, rendered under
  // the inspect-scope tabs. 'song' = opened from a per-song ⚙, rendered under
  // the song title. Same panel JSX is mounted at whichever site matches.
  const [runOptionsScope, setRunOptionsScope] = useState<'dataset' | 'song' | null>(null);
  const toggleAlgorithm = useCallback((id: string) => {
    setSelectedAlgorithms((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Strip gpu-tools-only algorithms when the tooling isn't installed. Without
  // this, user settings or a previous session could leave allin1 IDs selected
  // and the disabled checkbox would block the user from unchecking them.
  useEffect(() => {
    if (gpuCaps.allin1) return;
    setSelectedAlgorithms((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of prev) {
        if (id === 'allin1' || id.startsWith('allin1-fold')) { next.delete(id); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [gpuCaps.allin1]);

  // ── Player state ─────────────────────────────────────────────────────────
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [playerTime, setPlayerTime] = useState(0);
  const [playerIsPlaying, setPlayerIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [vizSignalWidth, setVizSignalWidth] = useState(0);
  // Latest zoom multiplier from the WaveSurfer player (1 = fit, 2 = ×2 …).
  // Drives the auto-guess collapse/expand UI threshold.
  const [vizZoomFactor, setVizZoomFactor] = useState(1);
  // True when WaveSurfer is at the canvas-safe maximum zoom — the VizControlBar's
  // ＋ button reads this to render itself disabled.
  const [vizAtMaxZoom, setVizAtMaxZoom] = useState(false);

  // ── Song info (BPM / time-sig / grid offset — applies to all annotation types) ──
  const [songInfo, setSongInfo] = useState<SongInfo | null>(null);
  const songInfoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── BPM detection (every available estimator, suggested to the user) ─────
  const [bpmDetection, setBpmDetection] = useState<BpmDetectionResult | null>(null);
  const [bpmDetectionStatus, setBpmDetectionStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [bpmDetectionError, setBpmDetectionError] = useState<string | undefined>(undefined);
  // BeatNet — experimental CUE-family detector, sibling to the 5 bpm_server
  // detectors. Loaded only when the `experimentalCueExtras` flag is on; null
  // otherwise so the chip never appears in shipped builds.
  const [beatnetDetection, setBeatnetDetection] = useState<BeatnetDetectionResult | null>(null);
  // Client-side one-shot BPM estimate (web-audio-beat-detector). Runs in
  // parallel with the server detectors and surfaces as an additional chip
  // the moment the in-browser analyzer returns — usually well before the
  // librosa / madmom round-trip finishes.
  const [clientBpm, setClientBpm] = useState<{ bpm: number; ms: number } | null>(null);

  // ── Annotations ───────────────────────────────────────────────────────────
  const [manualAnnotation, setManualAnnotation] = useState<ManualAnnotation | null>(null);
  // User-created annotation layers (Cues today; Spans/Lyrics later). Holds the
  // entire per-song-per-annotator document — one file, many layers. Wrapped
  // in an undoable hook so the page-level toolbar can drive ⌘Z / ⇧⌘Z across
  // every layer-typed panel (Cues / Spans / Loops / Patterns).
  const [cueLayersDoc, setCueLayersDoc, cueLayersDocCtl] = useUndoableState<AnnotationLayersDocument | null>(null);
  // Identity check so we don't echo the just-loaded doc back to the server.
  const cueLayersJustLoadedRef = useRef<AnnotationLayersDocument | null>(null);
  // Cue currently focused (selected in the list or opened via canvas popover).
  const [focusedCue, setFocusedCue] = useState<{ layerId: string; itemId: string } | null>(null);
  const cuePopover = useCueEditPopover();
  // Keep the focusedCue highlight in sync with whichever popover is open.
  useEffect(() => {
    if (cuePopover.open) {
      setFocusedCue({ layerId: cuePopover.open.layerId, itemId: cuePopover.open.itemId });
    }
  }, [cuePopover.open]);

  // Loops (experimental, gated by Settings.experimentalLoopsAndPatterns).
  // Loop layers live in the same AnnotationLayersDocument as cue layers; the
  // editor / canvas filter by `type` so they don't bleed into each other.
  const [focusedLoop, setFocusedLoop] = useState<{ layerId: string; itemId: string } | null>(null);
  const loopPlayback = useLoopPlayback({ audioBuffer });
  const loopPopover = useLoopEditPopover();
  useEffect(() => {
    if (loopPopover.open) {
      setFocusedLoop({ layerId: loopPopover.open.layerId, itemId: loopPopover.open.itemId });
    }
  }, [loopPopover.open]);

  // Span layers share the AnnotationLayersDocument with cues/loops/patterns;
  // filtered by `type`. Always available — no experimental flag.
  const [focusedSpan, setFocusedSpan] = useState<{ layerId: string; itemId: string } | null>(null);
  const spanPopover = useSpanEditPopover();
  useEffect(() => {
    if (spanPopover.open) {
      setFocusedSpan({ layerId: spanPopover.open.layerId, itemId: spanPopover.open.itemId });
    }
  }, [spanPopover.open]);

  // Patterns (experimental, gated by Settings.experimentalLoopsAndPatterns).
  // Same document, filtered by `type === 'patterns'`. Each pattern tiles into
  // repeatCount copies on the canvas and carries a 4-beat chip set for the
  // tick scheduler in SharedVizPanel.
  const [focusedPattern, setFocusedPattern] = useState<{ layerId: string; itemId: string } | null>(null);
  const patternPopover = usePatternEditPopover();
  useEffect(() => {
    if (patternPopover.open) {
      setFocusedPattern({ layerId: patternPopover.open.layerId, itemId: patternPopover.open.itemId });
    }
  }, [patternPopover.open]);

  // ── Active ADD-target layer per multi-layer type ──────────────────────────
  // Set by clicking a layer card (or by picking from the ▾ next to ADD), and
  // promoted automatically every time we add into a layer. Held at page level
  // so the AnnotationAddPanel can render the picker without each editor panel
  // having to re-derive it. Resets to null when the active song changes — see
  // the song-change effect below.
  const [selectedCueLayerId, setSelectedCueLayerId] = useState<string | null>(null);
  const [selectedSpanLayerId, setSelectedSpanLayerId] = useState<string | null>(null);
  const [selectedLoopLayerId, setSelectedLoopLayerId] = useState<string | null>(null);
  const [selectedPatternLayerId, setSelectedPatternLayerId] = useState<string | null>(null);
  const manualAnnotationRef = useRef<ManualAnnotation | null>(null);
  useEffect(() => { manualAnnotationRef.current = manualAnnotation; }, [manualAnnotation]);
  const manualUndoStack = useRef<import('../types/manualAnnotation').ManualSection[][]>([]);
  const [canManualUndo, setCanManualUndo] = useState(false);
  const setSectionsRef = useRef<((sections: import('../types/manualAnnotation').ManualSection[]) => void) | null>(null);
  const openManualEditorRef = useRef<((idx: number | null, anchor?: { x: number; y: number }) => void) | null>(null);
  const openEyeEditorRef = useRef<((idx: number | null, anchor?: { x: number; y: number }) => void) | null>(null);
  const eyeAddPointRef = useRef<((time: number) => void) | null>(null);
  const eyeSetPointTimeRef = useRef<((idx: number, time: number) => void) | null>(null);
  // Metronome tap-tempo imperative handle — wired through to the Tap button
  // in MetronomePanel. Used by the T shortcut in /prep. The reducer streams
  // BPM to the engine on every accepted tap, so there is no separate Apply.
  const metronomeTapRef = useRef<(() => void) | null>(null);
  const [eyeAnnotation, setEyeAnnotation] = useState<ManualAnnotation | null>(null);
  const [autoGuessAnnotation, setAutoGuessAnnotation] = useState<AutoGuessManualAnnotation | null>(null);
  const [pendingAnnotationSelection, setPendingAnnotationSelection] = useState<PendingSelection | null>(null);

  // ── Reference annotator (algo inspect only) ───────────────────────────────
  // `null` means "use the signed-in user's own annotations as reference". A
  // non-null value names another annotator whose annotations are loaded via
  // /api/annotations/:slug/all and substituted on the inspect canvas + in the
  // evaluation table. Selection is preserved across song switches so a
  // researcher can flip through tracks comparing one specific annotator.
  const [referenceAnnotatorId, setReferenceAnnotatorId] = useState<string | null>(null);
  const [externalRefData, setExternalRefData] = useState<{
    manual: ManualAnnotation | null;
    eye: ManualAnnotation | null;
    autoGuess: AutoGuessManualAnnotation | null;
  } | null>(null);

  // ── MIR curves ────────────────────────────────────────────────────────────
  const [mirCurves, setMirCurves] = useState<MirCurves | null>(null);
  const [mirComputing, setMirComputing] = useState(false);

  // ── Tool states (pre-loaded JSONs) ────────────────────────────────────────
  const [toolStates, setToolStates] = useState<Record<string, ToolState>>({});

  // ── Ruptures CPD cached results (loaded per song) ─────────────────────────
  const [rupturesResults, setRupturesResults] = useState<Record<string, RupturesResultJson>>({});

  // ── Custom detectors (loaded once at mount; results loaded per song) ───────
  // Per-detector envelope is keyed by detector name. Cleared on song change so
  // a stale result from a previous song never bleeds onto the active canvas.
  const [customDetectors, setCustomDetectors] = useState<CustomRegistryEntry[]>([]);
  const [customResults, setCustomResults] = useState<Record<string, CustomResultEnvelope>>({});
  // Detectors currently executing on the Python side. Surfaced as a spinner on
  // the algo checkbox + a pulsing label on the canvas row, since custom runs
  // happen in parallel with the built-in runJob and don't share its log panel.
  const [customRunning, setCustomRunning] = useState<Set<string>>(() => new Set());
  // Per-detector review state: { detectorName: { pointId: { status, time } } }.
  // The pointId is `<itemIndex>:<original_time_ms>` so renumbering after a re-run
  // does not silently steal another point's review state.
  type CustomAnnotationOverride = { status?: AutoGuessPoint['status']; time?: number };
  const [customAnnotationOverrides, setCustomAnnotationOverrides] = useState<Record<string, Record<string, CustomAnnotationOverride>>>({});
  // Ref kept in sync so selectAudio (defined with empty deps) sees the current list.
  const customDetectorsRef = useRef<CustomRegistryEntry[]>([]);
  useEffect(() => { customDetectorsRef.current = customDetectors; }, [customDetectors]);
  // Debounce per-detector saves so a quick burst of clicks coalesces.
  const customAnnotationSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Fetch the registry. Re-fetches when the experimentalLoopsAndPatterns flag
  // flips, since the server filters loop/pattern detectors out of the response
  // when the flag is off — adding/removing the entries from the dropdown
  // would otherwise lag a page reload. A failure (Python server down) is silent
  // — built-in algorithms continue to work; the custom group stays empty.
  const experimentalLoopsAndPatternsFlag = useSettings().settings.experimentalLoopsAndPatterns;
  useEffect(() => {
    listDetectors({
      includeExperimentalLoopsAndPatterns: experimentalLoopsAndPatternsFlag,
    }).then(setCustomDetectors).catch(() => {});
  }, [experimentalLoopsAndPatternsFlag]);

  // ── Top-level feature ─────────────────────────────────────────────────────
  // The landing/mode picker has moved to <LandingPage> at `/`. This component
  // is always mounted on a workspace route, so `feature` is never null. When
  // `props.feature` is provided (route-driven), the component stays mounted
  // across tab switches and syncs its internal state to the incoming prop —
  // that's what makes /prep ↔ /annotate ↔ /inspect feel instant instead of
  // remounting and re-fetching everything.
  const [feature, setFeature] = useState<Feature>(props.feature ?? props.initialFeature ?? 'annotate');
  useEffect(() => {
    if (props.feature && props.feature !== feature) setFeature(props.feature);
  }, [props.feature]);
  const [inspectSubStage, setInspectSubStage] = useState<'algo' | 'eval'>('algo');

  // Derived mode/stage values for legacy code paths.
  // mode = null when no feature is chosen so the landing screen renders alone.
  const mode: 'song' | 'dataset' | 'prep' | null =
    feature === 'inspect-all'  ? 'dataset' :
    feature === 'annotate'     ? 'song' :
    feature === 'inspect-song' ? 'song' :
    feature === 'prep'         ? 'prep' :
                                  null;
  const activeStage: Stage =
    feature === 'annotate'     ? 'annotation' :
    feature === 'inspect-song' ? inspectSubStage :
    feature === 'inspect-all'  ? 'global-eval' :
                                  'annotation';

  // ── Sub-tab ──────────────────────────────────────────────────────────────
  const [activeAnnotationType, setActiveAnnotationType] = useState<AnnotationType>('boundaries');

  // Per-category "source" — the value the AnnotationSourcePicker reflects for
  // the currently-active top-tab. For boundaries the source distinguishes
  // Manual / Eye / Auto-guess (rendered by separate panels); for non-boundary
  // categories the picker only writes here.
  //
  // `'autoGuess'` for non-boundary categories renders a "coming soon" banner —
  // no clustering algorithm exists for spans/cues/loops/patterns yet.
  // `'detector:<name>'` mounts the read-only detector output with the
  // accept/reject review chips (see DetectorOutputReview).
  const [activeSourceByType, setActiveSourceByType] = useState<Record<AnnotationCategory, SourceId>>({
    boundaries: 'manual',
    cues:       'manual',
    spans:      'manual',
    loops:      'manual',
    patterns:   'manual',
  });

  /** The current boundary source as a `BoundarySource`. Returns `null` when
   *  the picker has a `detector:<name>` selection — in that case the source
   *  override block (DetectorOutputReview) renders instead of the per-source
   *  Manual/Eye/Auto-guess panels. */
  const activeBoundarySource: BoundarySource | null = isBoundarySource(activeSourceByType.boundaries)
    ? activeSourceByType.boundaries
    : null;

  /** True when a detector's `output_kind` belongs in the picker for a given
   *  annotation category. */
  const customDetectorMatchesCategory = (
    outputKind: string,
    category: AnnotationCategory,
  ): boolean => {
    return (
      (outputKind === 'boundary' && category === 'boundaries') ||
      (outputKind === 'cue'      && category === 'cues') ||
      (outputKind === 'span'     && category === 'spans') ||
      (outputKind === 'loop'     && category === 'loops') ||
      (outputKind === 'pattern'  && category === 'patterns')
    );
  };

  // ── Editable detector-output state (copy-on-write per annotator) ───────────
  // detectorOutputDocs is keyed by detector name; null = no editable file yet
  // (the detector is showing the read-only algorithm cache). On first
  // Accept/Reject the page seeds the doc from customResults[name] and writes
  // it through saveDetectorOutput — that's the copy-on-write moment.
  const [detectorOutputDocs, setDetectorOutputDocs] = useState<Record<string, EditableDetectorOutput | null>>({});
  // {detector_name: [slug, ...]} — slugs with an editable file on disk for
  // the current annotator. Powers the "in progress" dot on detector entries
  // in the AnnotationSourcePicker dropdown.
  const [detectorOutputIndex, setDetectorOutputIndex] = useState<Record<string, string[]>>({});

  /** Seed an EditableDetectorOutput from the algorithm-cache envelope when
   *  none has been written yet — this is the copy-on-write moment. */
  const seedDetectorOutputDoc = useCallback((
    envelope: CustomResultEnvelope,
  ): EditableDetectorOutput => {
    return {
      ...envelope,
      // Deep-copy items so editing the doc doesn't mutate customResults state.
      items: envelope.items.map((it) => ({ ...it })),
      review: {},
      in_progress: true,
    };
  }, []);

  /** Toggle Accept/Reject on a detector item — handles copy-on-write,
   *  in-memory patching, persistence, and index refresh. */
  const applyDetectorReview = useCallback(async (
    detectorName: string,
    itemId: string,
    next: DetectorReviewStatus,
  ) => {
    const slug = selectedAudioRef.current?.id;
    if (!slug) return;
    const envelope = customResults[detectorName];
    const existing = detectorOutputDocs[detectorName];
    // Toggle: clicking the same chip again clears the decision.
    const current = existing?.review?.[itemId];
    const clearing = current === next;
    const doc: EditableDetectorOutput | null = existing
      ? { ...existing, review: { ...existing.review } }
      : envelope
        ? seedDetectorOutputDoc(envelope)
        : null;
    if (!doc) return;
    if (clearing) delete doc.review[itemId];
    else doc.review[itemId] = next;
    setDetectorOutputDocs((prev) => ({ ...prev, [detectorName]: doc }));
    const ok = await saveDetectorOutput(detectorName, slug, doc);
    if (ok) {
      setDetectorOutputIndex((prev) => {
        const cur = new Set(prev[detectorName] ?? []);
        cur.add(slug);
        return { ...prev, [detectorName]: Array.from(cur).sort() };
      });
    }
  }, [customResults, detectorOutputDocs, seedDetectorOutputDoc]);

  /** Wipe the editable file for a detector + remove from the in-progress
   *  index. Algorithm-cache envelope is untouched, so the items still
   *  render — just without any review decisions. */
  const resetDetectorReview = useCallback(async (detectorName: string) => {
    const slug = selectedAudioRef.current?.id;
    if (!slug) return;
    await deleteDetectorOutput(detectorName, slug);
    setDetectorOutputDocs((prev) => ({ ...prev, [detectorName]: null }));
    setDetectorOutputIndex((prev) => {
      const remaining = (prev[detectorName] ?? []).filter((s) => s !== slug);
      if (remaining.length === 0) {
        const { [detectorName]: _drop, ...rest } = prev;
        return rest;
      }
      return { ...prev, [detectorName]: remaining };
    });
  }, []);

  // ── Viz toggles ───────────────────────────────────────────────────────────
  const [showManual, setShowManual]             = useState(() => getCurrentSettings().defaultShowManual);
  const [showEye, setShowEye]               = useState(() => getCurrentSettings().defaultShowEye);
  const [showAutoGuess, setShowAutoGuess]   = useState(() => getCurrentSettings().defaultShowAutoGuess);
  const [showSignalOverlays, setShowSignalOverlays] = useState(() => getCurrentSettings().defaultShowSignalOverlays);
  const [minConsensus, setMinConsensus]     = useState(2);
  const [showWaveform, setShowWaveform]     = useState(() => getCurrentSettings().defaultShowWaveform);
  const [showEQ, setShowEQ]                 = useState(() => getCurrentSettings().defaultShowEQ);
  const [showSpectrogram, setShowSpectrogram] = useState(() => getCurrentSettings().defaultShowSpectrogram);
  const [showCepstrogram, setShowCepstrogram] = useState(() => getCurrentSettings().defaultShowCepstrogram);
  const [showEnergy, setShowEnergy]         = useState(() => getCurrentSettings().defaultShowEnergy);
  const [showBrightness, setShowBrightness] = useState(() => getCurrentSettings().defaultShowBrightness);
  const [showNovelty, setShowNovelty]       = useState(() => getCurrentSettings().defaultShowNovelty);
  const [showOnsets, setShowOnsets]         = useState(() => getCurrentSettings().defaultShowOnsets);
  const [showFlux, setShowFlux]             = useState(() => getCurrentSettings().defaultShowFlux);
  const [showChroma, setShowChroma]         = useState(() => getCurrentSettings().defaultShowChroma);
  const [showTempogram, setShowTempogram]   = useState(() => getCurrentSettings().defaultShowTempogram);
  const [showSsm, setShowSsm]               = useState(() => getCurrentSettings().defaultShowSsm);
  // Beat grid
  const [showBeatGrid, setShowBeatGrid]     = useState(() => getCurrentSettings().defaultShowBeatGrid);
  const [beatGridUnit, setBeatGridUnit]     = useState<BeatGridUnit>('beat');
  const [beatGridUnitOptions] = useState<BeatGridUnit[]>(() => readStoredBeatGridUnitOptions());
  // Snap
  const [snapToGrid, setSnapToGrid]         = useState(false);
  // Global horizontal-scroll capture. When on, any horizontal trackpad/wheel
  // gesture anywhere on the page is redirected to scroll the viz timeline
  // (and the browser swipe-back/forward gesture is suppressed everywhere).
  // Default on — scrubbing the timeline is the dominant interaction here, so
  // the swipe-back gesture is almost always unwanted. Persisted across
  // sessions in localStorage; only an explicit '0' opts out so first-time
  // users get the default-on behavior.
  const [captureGlobalHScroll, setCaptureGlobalHScrollState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    try { return window.localStorage.getItem('tc.captureGlobalHScroll') !== '0'; } catch { return true; }
  });
  const setCaptureGlobalHScroll = useCallback((v: boolean) => {
    setCaptureGlobalHScrollState(v);
    try { window.localStorage.setItem('tc.captureGlobalHScroll', v ? '1' : '0'); } catch { /* ignore quota */ }
  }, []);
  // Beat-grid line width multiplier (Misc dropdown). Scales every grid line
  // uniformly; persisted across sessions. Clamped to the slider's [0.5, 10].
  const [gridLineThickness, setGridLineThicknessState] = useState<number>(() => {
    if (typeof window === 'undefined') return 1;
    try {
      const n = parseFloat(window.localStorage.getItem('tc.gridLineThickness') ?? '');
      return Number.isFinite(n) && n >= 0.5 && n <= 10 ? n : 1;
    } catch { return 1; }
  });
  const setGridLineThickness = useCallback((v: number) => {
    const clamped = Math.max(0.5, Math.min(10, v));
    setGridLineThicknessState(clamped);
    try { window.localStorage.setItem('tc.gridLineThickness', String(clamped)); } catch { /* ignore quota */ }
  }, []);
  // Algo overlays
  const [selectedAlgoOverlays, setSelectedAlgoOverlays] = useState<Set<string>>(new Set());
  const [mirTolerance, setMirTolerance]     = useState(0.5);
  // Row order — fixed rows only; algo IDs are inserted/removed dynamically
  const [rowOrder, setRowOrder] = useState<VizRowId[]>(DEFAULT_FIXED_ROW_ORDER);
  const [hasCustomRowOrder, setHasCustomRowOrder] = useState(false);
  // Section-color palette overrides (keyed by section type, e.g. 'intro' → '#ff00ff')
  const [sectionColorOverrides, setSectionColorOverrides] = useState<Record<string, string>>({});
  // Per-layer auralisation config (keyed by 'manual' | 'eye' | 'autoGuess')
  const [layerAudioConfig, setLayerAudioConfig] = useState<Record<string, LayerAudioConfig>>({});

  useEffect(() => {
    try {
      window.localStorage.setItem(BEAT_GRID_UNIT_OPTIONS_STORAGE_KEY, JSON.stringify(beatGridUnitOptions));
    } catch {
      // Ignore storage failures.
    }
  }, [beatGridUnitOptions]);

  useEffect(() => {
    if (!beatGridUnitOptions.includes(beatGridUnit)) {
      setBeatGridUnit(beatGridUnitOptions[0] ?? 'beat');
    }
  }, [beatGridUnitOptions, beatGridUnit]);

  // ── Annotation timer (per source-or-type) ─────────────────────────────────
  // Boundaries track time per source (manual/eye/autoGuess); layer types
  // track time per type. See [[TimerKey]] for the union.
  const [annotationTimesSaved, setAnnotationTimesSaved] = useState<Record<TimerKey, number>>(
    { manual: 0, eye: 0, autoGuess: 0, cues: 0, spans: 0, loops: 0, patterns: 0 },
  );                                                                   // persisted seconds for current song, per key
  const annotationSessionStartRef = useRef<number | null>(null);       // ms timestamp when current session started
  const annotationSessionTypeRef  = useRef<TimerKey | null>(null);     // which key the current session belongs to
  const [timerRunning, setTimerRunning] = useState(false);             // drives the ticker effect
  const [, setAnnotationTimerTick] = useState(0);                      // forces re-render every second

  // ── Player refs ───────────────────────────────────────────────────────────
  // Reactive state ref — keeps the latest songInfo accessible from shortcut
  // handlers that need to read tempoAnchors / bpm / gridOffset synchronously.
  const songInfoRef = useRef(songInfo);
  songInfoRef.current = songInfo;
  const seekRef    = useRef<((time: number) => void) | null>(null);
  const playRef    = useRef<(() => void) | null>(null);
  const pauseRef   = useRef<(() => void) | null>(null);
  const wsScrollRef = useRef<((scrollLeft: number) => void) | null>(null);
  const zoomInRef    = useRef<(() => void) | null>(null);
  const zoomOutRef   = useRef<(() => void) | null>(null);
  const zoomResetRef = useRef<(() => void) | null>(null);
  const pinchZoomInRef  = useRef<(() => void) | null>(null);
  const pinchZoomOutRef = useRef<(() => void) | null>(null);
  const scrollToTimeRef = useRef<((time: number, align?: 'center' | 'left') => void) | null>(null);
  const zoomToRangeRef  = useRef<((t1: number, t2: number) => void) | null>(null);
  const vizScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const isProgrammaticScrollRef = useRef(false);

  // ── Shortcuts help panel ─────────────────────────────────────────────────
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [exportManagerOpen, setExportManagerOpen] = useState(false);
  // Bulk import — opens the dataset import dialog from the prep sidebar.
  const [importDatasetOpen, setImportDatasetOpen] = useState(false);
  // BPM-not-set warning shown when a user clicks a song in Annotator Tool
  // without BPM configured. Stored as the candidate AudioEntry so the dialog
  // can name the song and the "Annotate anyway" / "Set BPM" actions can fall
  // through to selectAudio (optionally after switching the workspace to prep).
  const [bpmWarningSong, setBpmWarningSong] = useState<AudioEntry | null>(null);
  const [postUploadGuide, setPostUploadGuide] = useState<{ name: string; count: number } | null>(null);

  // ── Shared annotation toolbar / add-panel wiring ─────────────────────────
  // Each editor panel exposes an AnnotationPanelController via forwardRef and
  // emits a capabilities snapshot via onCapabilitiesChange. The page selects
  // the active type's snapshot + controller to drive the shared toolbar.
  const manualPanelRef = useRef<AnnotationPanelController>(null);
  const eyePanelRef = useRef<AnnotationPanelController>(null);
  const autoGuessPanelRef = useRef<AnnotationPanelController>(null);
  const cuesPanelRef = useRef<AnnotationPanelController>(null);
  const spansPanelRef = useRef<AnnotationPanelController>(null);
  const loopsPanelRef = useRef<AnnotationPanelController>(null);
  const patternsPanelRef = useRef<AnnotationPanelController>(null);
  const [manualCaps, setManualCaps] = useState<AnnotationPanelCapabilities | null>(null);
  const [eyeCaps, setEyeCaps] = useState<AnnotationPanelCapabilities | null>(null);
  const [autoGuessCaps, setAutoGuessCaps] = useState<AnnotationPanelCapabilities | null>(null);
  const [cuesCaps, setCuesCaps] = useState<AnnotationPanelCapabilities | null>(null);
  const [spansCaps, setSpansCaps] = useState<AnnotationPanelCapabilities | null>(null);
  const [loopsCaps, setLoopsCaps] = useState<AnnotationPanelCapabilities | null>(null);
  const [patternsCaps, setPatternsCaps] = useState<AnnotationPanelCapabilities | null>(null);
  // Layers-doc save indicator state (the page owns the debounced saveLayers).
  // Cues/Spans/Loops/Patterns all surface this same indicator in their
  // capability snapshot since they share the cueLayersDoc.
  const [layersDocSaveStatus, setLayersDocSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  // Pending song delete (single or all). null = no dialog open.
  // 'all' = batch delete; an AudioEntry = that single song.
  const [pendingSongDelete, setPendingSongDelete] = useState<AudioEntry | 'all' | null>(null);

  // ── Delete-active-annotation dialog (Annotation section header) ───────────
  const [deleteActiveOpen, setDeleteActiveOpen] = useState(false);
  // ── Delete-EVERY-annotation-for-this-song dialog (next to Export) ─────────
  const [deleteAllForSongOpen, setDeleteAllForSongOpen] = useState(false);
  const { annotator } = useAnnotator();
  const { isDemo } = useDemo();
  const { settings } = useSettings();
  // Whether each experimental family's sidecar is part of the running image.
  // Gates the inspector run-sidebar sections below so a persisted-on flag whose
  // sidecar later disappears doesn't leak un-runnable "RUN MISSING" rows.
  const expAvail = useExperimentalAvailability();
  // Bumped after a delete to force the editor panels (which keep their own
  // internal annotation state loaded from the server) to reload — clearing
  // setManualAnnotation/etc on the parent only resets the parent's mirror.
  const [panelReloadKey, setPanelReloadKey] = useState(0);
  const performDeleteActive = useCallback(async () => {
    if (!selectedAudio) return;
    const id = selectedAudio.id;
    // Layer-types (cues/spans/loops/patterns) delegate to the panel's
    // controller — it filters its own type-slice out of the shared
    // cueLayersDoc and emits a new doc via onDocChange. The page-level
    // saveLayers debounce persists the change. No server-side endpoint to
    // call from here.
    if (activeAnnotationType === 'cues' || activeAnnotationType === 'spans'
        || activeAnnotationType === 'loops' || activeAnnotationType === 'patterns') {
      const ctl = activeAnnotationType === 'cues'  ? cuesPanelRef.current
                : activeAnnotationType === 'spans' ? spansPanelRef.current
                : activeAnnotationType === 'loops' ? loopsPanelRef.current
                : patternsPanelRef.current;
      ctl?.deleteAll?.();
      setPanelReloadKey((k) => k + 1);
      return;
    }
    // Boundaries — dispatch by active source.
    const src = activeBoundarySource;
    if (src === 'manual') {
      await deleteAnnotation(id);
      setManualAnnotation(null);
    } else if (src === 'eye') {
      await deleteEyeAnnotation(id);
      setEyeAnnotation(null);
    } else if (src === 'autoGuess') {
      await deleteAutoGuessAnnotation(id);
      setAutoGuessAnnotation(null);
    } else {
      // Detector source — nothing to delete here (the source is the algorithm
      // output; the review file is handled inside DetectorOutputReview).
      return;
    }
    // Clear the corresponding status field so the sidebar badge falls back
    // to "Not started". The status-sync effect uses `??` to preserve the
    // existing status while annotations are still loading, so it can't
    // distinguish a delete from a load — we have to clear it explicitly here.
    setSongStatuses((prev) => {
      const existing = prev[id];
      if (!existing) return prev;
      const next = { ...existing };
      if (src === 'manual') {
        next.reviewed = false;
        next.ready_for_review = undefined;
      } else if (src === 'eye') {
        next.eye_status = undefined;
      } else {
        next.auto_guess_status = undefined;
      }
      return { ...prev, [id]: next };
    });
    setPanelReloadKey((k) => k + 1);
  }, [selectedAudio, activeAnnotationType, activeBoundarySource]);

  // Wipe every annotation (Manual, Eye, Auto-guess + all user-created cue/
  // span/loop/pattern layers) for the current song. Triggered by the
  // ✕ Delete-all button in the Annotation section header next to Export.
  const performDeleteAllForSong = useCallback(async () => {
    if (!selectedAudio) return;
    const id = selectedAudio.id;
    await Promise.allSettled([
      deleteAnnotation(id),
      deleteEyeAnnotation(id),
      deleteAutoGuessAnnotation(id),
    ]);
    setManualAnnotation(null);
    setEyeAnnotation(null);
    setAutoGuessAnnotation(null);
    // Whole-song wipe — the rest of the deletion (Manual/Eye/Auto-guess) is
    // not undoable, so undoing only the layers slice would be misleading.
    cueLayersDocCtl.reset(emptyLayersDoc(id));
    setSongStatuses((prev) => {
      const existing = prev[id];
      if (!existing) return prev;
      const next = { ...existing };
      next.reviewed = false;
      next.ready_for_review = undefined;
      next.eye_status = undefined;
      next.auto_guess_status = undefined;
      return { ...prev, [id]: next };
    });
    setPanelReloadKey((k) => k + 1);
  }, [selectedAudio]);

  // Mirror the active annotation type + boundary source into refs so shortcut
  // handlers (which close over playerTimeRef etc. and never re-bind) can read
  // the latest values.
  const activeAnnotationTypeRef = useRef<AnnotationType>('boundaries');
  useEffect(() => { activeAnnotationTypeRef.current = activeAnnotationType; }, [activeAnnotationType]);
  const activeBoundarySourceRef = useRef<BoundarySource | null>('manual');
  useEffect(() => { activeBoundarySourceRef.current = activeBoundarySource; }, [activeBoundarySource]);

  // Mirror cue-layer state so the keyboard shortcuts (Delete / [ / ]) can read
  // the latest cue items without re-binding. The CueEditorPanel owns mutation;
  // these refs are read-only snapshots of the page-level state.
  const cueLayersDocRef = useRef<AnnotationLayersDocument | null>(null);
  useEffect(() => { cueLayersDocRef.current = cueLayersDoc; }, [cueLayersDoc]);
  const focusedCueRef = useRef<{ layerId: string; itemId: string } | null>(null);
  useEffect(() => { focusedCueRef.current = focusedCue; }, [focusedCue]);
  // Mirror pending drag-selection so the Enter shortcut can gate its match
  // function on "a region is selected" without rebinding when the selection
  // changes.
  const pendingAnnotationSelectionRef = useRef<PendingSelection | null>(null);
  useEffect(() => { pendingAnnotationSelectionRef.current = pendingAnnotationSelection; }, [pendingAnnotationSelection]);
  // Mirror Eye + Auto-guess annotations so [ / ] can navigate their points
  // without rebinding when the data changes.
  const eyeAnnotationRef = useRef<ManualAnnotation | null>(null);
  useEffect(() => { eyeAnnotationRef.current = eyeAnnotation; }, [eyeAnnotation]);
  const autoGuessAnnotationRef = useRef<AutoGuessManualAnnotation | null>(null);
  useEffect(() => { autoGuessAnnotationRef.current = autoGuessAnnotation; }, [autoGuessAnnotation]);

  const sectionStopAtRef = useRef<number | null>(null);

  // ── Preview window — drag-to-listen region, cursor returns to anchor on end ─
  const [previewRegion, setPreviewRegion] = useState<PreviewRegion | null>(null);
  const previewAnchorRef = useRef<number | null>(null);
  // Refs mirroring player state — used inside event handlers without re-binding effects
  const playerTimeRef = useRef(0);
  const playerIsPlayingRef = useRef(false);
  useEffect(() => { playerTimeRef.current = playerTime; }, [playerTime]);
  useEffect(() => { playerIsPlayingRef.current = playerIsPlaying; }, [playerIsPlaying]);
  const durationRef = useRef(0);
  useEffect(() => { durationRef.current = duration; }, [duration]);

  // ── Load manifest + auto-select first song ────────────────────────────────
  useEffect(() => {
    fetchManifest().then((files) => {
      setAudioFiles(files);
      if (!selectedAudio) {
        const first = firstVisibleSong(files);
        if (first) selectAudio(first);
      }
    });
    loadAllStatuses().then(setSongStatuses);
    loadAllLayerStatuses().then(setSongLayerStatuses);
    refreshStorageStats();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh statuses when the logged-in annotator changes — the sidebar's
  // overall annotation indicator is scoped to that annotator's folder on disk.
  useEffect(() => {
    loadAllStatuses().then(setSongStatuses).catch(() => setSongStatuses({}));
    loadAllLayerStatuses().then(setSongLayerStatuses).catch(() => setSongLayerStatuses({}));
  }, [annotator?.id]);

  // ── Load per-song info for sidebar grid-readiness ──────────────────────────
  // Re-runs whenever the catalog changes (initial fetch, after upload).
  useEffect(() => {
    if (audioFiles.length === 0) return;
    const slugs = audioFiles.map((f) => f.id);
    let cancelled = false;
    loadAllSongInfo(slugs).then((map) => {
      if (!cancelled) setSongInfos(map);
    });
    return () => { cancelled = true; };
  }, [audioFiles]);

  // ── Sync current song status when manual/eye/auto-guess annotation loads/changes ──────
  useEffect(() => {
    if (!selectedAudio) return;
    setSongStatuses((prev) => {
      const existing = prev[selectedAudio.id];
      return {
        ...prev,
        [selectedAudio.id]: {
          ...existing,
          slug: selectedAudio.id,
          reviewed: manualAnnotation?.reviewed ?? existing?.reviewed ?? false,
          ready_for_review: manualAnnotation?.ready_for_review ?? existing?.ready_for_review,
          eye_status: eyeAnnotation?.eye_status ?? existing?.eye_status,
          auto_guess_status: autoGuessAnnotation?.auto_guess_status ?? existing?.auto_guess_status,
        },
      };
    });
  }, [selectedAudio, manualAnnotation, eyeAnnotation, autoGuessAnnotation]);

  // ── Select audio — eagerly load all annotations + algo JSONs ─────────────
  const selectAudio = useCallback((entry: AudioEntry) => {
    // Flush any in-progress timer session for the previous song before switching
    const prevAudio = selectedAudioRef.current;
    const sessionType = annotationSessionTypeRef.current;
    if (
      prevAudio && prevAudio.id !== entry.id &&
      annotationSessionStartRef.current !== null && sessionType !== null
    ) {
      const sessionSecs = (Date.now() - annotationSessionStartRef.current) / 1000;
      annotationSessionStartRef.current = null;
      annotationSessionTypeRef.current = null;
      setTimerRunning(false);
      setAnnotationTimesSaved((prev) => {
        const next = { ...prev, [sessionType]: prev[sessionType] + sessionSecs };
        fetch(`/api/annotation-times/${encodeURIComponent(prevAudio.id)}`, {
          method: 'POST',
          headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ perType: next }),
        }).catch(() => null);
        return next;
      });
    }

    // Reset audio-decode state only on an actual song switch. fireRunAlgorithms
    // re-calls selectAudio for the same song to refresh views — clobbering duration
    // there leaves the React state at 0 (WaveSurfer keeps its cached buffer, so
    // `decode` never refires and onBufferReady never restores it), which makes
    // every section/point's left/width compute as Infinity% and collapse to x=0.
    const isSongSwitch = prevAudio?.id !== entry.id;
    if (isSongSwitch && playerIsPlayingRef.current) pauseRef.current?.();
    setSelectedAudio(entry);
    if (isSongSwitch) {
      setAudioBuffer(null);
      setPlayerTime(0);
      setDuration(0);
      setVizTotalWidth(0);
    }
    setPreviewRegion(null);
    previewAnchorRef.current = null;
    setToolStates({});
    setRupturesResults({});
    setCustomResults({});
    setCustomAnnotationOverrides({});
    setMirCurves(null);
    setPendingAnnotationSelection(null);
    setManualAnnotation(null);
    // Song change — the previous song's edit history is meaningless for the
    // new song, so reset rather than push onto the undo stack.
    cueLayersDocCtl.reset(null);
    cueLayersJustLoadedRef.current = null;
    setFocusedCue(null);
    setFocusedLoop(null);
    setFocusedSpan(null);
    setFocusedPattern(null);
    // Reset signal visibility to configured defaults so every song opens with
    // the same baseline (3-Band, Spectrogram, Energy on by default).
    {
      const s = getCurrentSettings();
      setShowWaveform(s.defaultShowWaveform);
      setShowSpectrogram(s.defaultShowSpectrogram);
      setShowCepstrogram(s.defaultShowCepstrogram);
      setShowEnergy(s.defaultShowEnergy);
      setShowBrightness(s.defaultShowBrightness);
      setShowNovelty(s.defaultShowNovelty);
      setShowOnsets(s.defaultShowOnsets);
      setShowFlux(s.defaultShowFlux);
      setShowChroma(s.defaultShowChroma);
      setShowTempogram(s.defaultShowTempogram);
      setShowSsm(s.defaultShowSsm);
    }
    manualUndoStack.current = [];
    setCanManualUndo(false);
    setEyeAnnotation(null);
    setAutoGuessAnnotation(null);
    setSongInfo(null);
    setBpmDetection(null);
    setBpmDetectionStatus('idle');
    setBpmDetectionError(undefined);
    if (songInfoSaveTimer.current) { clearTimeout(songInfoSaveTimer.current); songInfoSaveTimer.current = null; }
    setSelectedAlgoOverlays(new Set());

    // Demucs stem player: snap back to full mix for the new song; load the
    // per-song manifest if any. 404 (no stems cached) is the silent normal.
    setSelectedStemSource('mix');
    setStemManifest(null);
    fetchStemManifest(entry.url).then((m) => {
      if (selectedAudioRef.current?.id !== entry.id) return;
      setStemManifest(m);
    });

    // Load persisted per-type annotation times for the new song
    setAnnotationTimesSaved({ manual: 0, eye: 0, autoGuess: 0, cues: 0, spans: 0, loops: 0, patterns: 0 });
    annotationSessionStartRef.current = null;
    annotationSessionTypeRef.current = null;
    {
      fetch(`/api/annotation-times/${encodeURIComponent(entry.id)}`, {
        headers: annotatorHeaders(),
      })
      .then((r) => r.json())
      .then((data) => {
        if (data?.perType) {
          setAnnotationTimesSaved({
            manual:      Number(data.perType.manual)      || 0,
            eye:       Number(data.perType.eye)       || 0,
            autoGuess: Number(data.perType.autoGuess) || 0,
            cues:      Number(data.perType.cues)      || 0,
            spans:     Number(data.perType.spans)     || 0,
            loops:     Number(data.perType.loops)     || 0,
            patterns:  Number(data.perType.patterns)  || 0,
          });
        }
      })
      .catch(() => null);
    }

    loadAnnotation(entry.id).then((ann) => { if (ann) setManualAnnotation(ann); });
    loadEyeAnnotation(entry.id).then((ann) => { if (ann) setEyeAnnotation(ann); });
    loadAutoGuessAnnotation(entry.id).then((ann) => { if (ann) setAutoGuessAnnotation(ann); });
    loadLayers(entry.id).then((doc) => {
      cueLayersJustLoadedRef.current = doc;
      // Fresh load = new baseline; clear any history from the previous song.
      cueLayersDocCtl.reset(doc);
    });
    loadSongInfo(entry.id).then(setSongInfo);

    // BPM detection — first try cache; if empty, kick off a run. The Python
    // server (tools/python/bpm_server.py) may not be running; we degrade silently.
    setBpmDetectionStatus('running');
    setBpmDetectionError(undefined);
    loadCachedBpm(entry.id).then((cached) => {
      // Guard against rapid song-switching: only apply if this entry is still selected.
      if (selectedAudioRef.current?.id !== entry.id) return;
      if (cached) {
        setBpmDetection(cached);
        setBpmDetectionStatus('done');
        return;
      }
      runBpmDetection(entry.id, false).then((result) => {
        if (selectedAudioRef.current?.id !== entry.id) return;
        if (result) {
          setBpmDetection(result);
          setBpmDetectionStatus('done');
        } else {
          setBpmDetectionStatus('error');
          setBpmDetectionError('BPM server unreachable — start with: python tools/python/bpm_server.py');
        }
      });
    });

    // BeatNet (experimental). Only attempt if the user has opted in — the
    // sidecar is in the `experimental-models` compose profile and most
    // installs won't have it running. Cache first, then a best-effort run.
    setBeatnetDetection(null);
    if (settings.experimentalCueExtras) {
      loadCachedBeatnet(entry.id).then((cached) => {
        if (selectedAudioRef.current?.id !== entry.id) return;
        if (cached) {
          setBeatnetDetection(cached);
          return;
        }
        runBeatnetDetection(entry.id, false).then((result) => {
          if (selectedAudioRef.current?.id !== entry.id) return;
          if (result) setBeatnetDetection(result);
        });
      });
    }

    for (const toolId of ALGO_ORDER) {
      loadAlgoJson(entry.id, toolId).then((loaded) => {
        if (!loaded) return;
        const { result, error } = loaded;
        setToolStates((prev) => ({
          ...prev,
          [toolId]: error
            ? { status: 'error', result, error }
            : { status: 'done', result },
        }));
      });
    }

    // Load any cached Ruptures CPD results (silently skip missing variants).
    for (const m of RUPTURES_METHODS) {
      fetch(`/analysis/${entry.id}/ruptures-${m.suffix}.json`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data) setRupturesResults((prev) => ({ ...prev, [m.suffix]: data as RupturesResultJson }));
        })
        .catch(() => {});
    }

    // Custom-detector cached envelopes — one per registered detector with status 'ok'.
    // A 404 (no cached run for this song) is silently dropped.
    for (const det of customDetectorsRef.current) {
      if (det.status !== 'ok') continue;
      getDetectorResult(det.name, entry.id).then((env) => {
        if (selectedAudioRef.current?.id !== entry.id) return;
        if (env) setCustomResults((prev) => ({ ...prev, [det.name]: env }));
      }).catch(() => {});
      // Annotation-mode detectors also have an editable review file per annotator.
      // Loaded only for detectors flagged is_annotation — the rest never write one.
      if (det.is_annotation) {
        loadCustomAnnotation<{ overrides?: Record<string, CustomAnnotationOverride> }>(det.name, entry.id)
          .then((doc) => {
            if (selectedAudioRef.current?.id !== entry.id) return;
            if (doc?.overrides) {
              setCustomAnnotationOverrides((prev) => ({ ...prev, [det.name]: doc.overrides! }));
            }
          })
          .catch(() => {});
        // Editable detector-output file (copy-on-write per annotator) for
        // non-boundary detectors. The picker reads `detectorOutputIndex` to
        // surface the "in progress" dot; the review panel reads
        // detectorOutputDocs[name] when source = 'detector:<name>'.
        loadDetectorOutput(det.name, entry.id)
          .then((doc) => {
            if (selectedAudioRef.current?.id !== entry.id) return;
            setDetectorOutputDocs((prev) => ({ ...prev, [det.name]: doc }));
          })
          .catch(() => {});
      }
    }
    // One index fetch per song load (cheap — lists files in one dir tree).
    listInProgressDetectorOutputs()
      .then((idx) => {
        if (selectedAudioRef.current?.id !== entry.id) return;
        setDetectorOutputIndex(idx);
      })
      .catch(() => {});
  }, []);

  // ── Upload song(s) ────────────────────────────────────────────────────────
  // Drop a folder of folders? Walk the FileSystemEntry tree the browser gives
  // us and gather every audio file we find. Returns a flat list plus a flag
  // when the dropped roots contained at least one subfolder (used to gate a
  // "Found N audio files across subfolders — proceed?" confirmation).
  const walkDataTransferItems = useCallback(async (items: DataTransferItemList): Promise<{ files: File[]; sawNestedFolder: boolean }> => {
    const out: File[] = [];
    let sawNestedFolder = false;
    const walk = async (entry: any, depth: number): Promise<void> => {
      if (!entry) return;
      if (entry.isFile) {
        await new Promise<void>((resolve) => {
          entry.file((f: File) => {
            if (AUDIO_EXTENSIONS.test(f.name)) out.push(f);
            resolve();
          }, () => resolve());
        });
        return;
      }
      if (entry.isDirectory) {
        if (depth >= 1) sawNestedFolder = true;
        const reader = entry.createReader();
        const readBatch = (): Promise<any[]> => new Promise((resolve) => reader.readEntries((es: any[]) => resolve(es), () => resolve([])));
        for (;;) {
          const batch = await readBatch();
          if (batch.length === 0) break;
          for (const child of batch) await walk(child, depth + 1);
        }
      }
    };
    const roots: any[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (it.kind !== 'file') continue;
      const entry = (it as any).webkitGetAsEntry?.();
      if (entry) roots.push(entry);
      else {
        const f = it.getAsFile();
        if (f && AUDIO_EXTENSIONS.test(f.name)) out.push(f);
      }
    }
    for (const root of roots) await walk(root, 0);
    return { files: out, sawNestedFolder };
  }, []);

  // Accepts a single File or an array. For arrays, uploads sequentially and
  // refreshes the manifest once at the end (so /prep's "upload full dataset"
  // doesn't trigger N redundant manifest fetches).
  const handleUploadSong = useCallback(async (input: File | File[]) => {
    const files = Array.isArray(input) ? input : [input];
    if (files.length === 0) return;
    setUploading(true);
    let lastUploadedId: string | null = null;
    const failures: string[] = [];
    try {
      for (let fi = 0; fi < files.length; fi += 1) {
        const file = files[fi];
        setUploadProgress({
          fileIndex: fi + 1,
          totalFiles: files.length,
          fileName: file.name,
          chunk: 0,
          totalChunks: Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK_SIZE)),
          bytesSent: 0,
          totalBytes: file.size,
        });
        try {
          const entry = await uploadSongChunked(file, (p) => {
            setUploadProgress({
              fileIndex: fi + 1,
              totalFiles: files.length,
              fileName: file.name,
              chunk: p.chunk,
              totalChunks: p.totalChunks,
              bytesSent: p.bytesSent,
              totalBytes: p.totalBytes,
            });
          });
          if (entry.id) lastUploadedId = entry.id;
          else {
            console.error('[upload]', file.name, 'no id in response', entry);
            failures.push(`${file.name}: server returned no id`);
          }
        } catch (err) {
          console.error('[upload]', file.name, err);
          failures.push(`${file.name}: ${err instanceof Error ? err.message : 'unknown error'}`);
        }
      }
      const refreshed = await fetchManifest();
      setAudioFiles(refreshed);
      let lastEntry: AudioEntry | undefined;
      if (lastUploadedId) {
        lastEntry = refreshed.find((f) => f.id === lastUploadedId);
        if (lastEntry) selectAudio(lastEntry);
      }
      if (failures.length > 0) {
        alert(`Upload failed for ${failures.length} file(s):\n${failures.join('\n')}\n\nCheck the dev console for details.`);
      }
      const successCount = files.length - failures.length;
      if (successCount > 0) {
        setPostUploadGuide({
          name: lastEntry?.name ?? files[0].name,
          count: successCount,
        });
      }
      refreshStorageStats();
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  }, [selectAudio, refreshStorageStats]);

  // Filters a picked/dropped FileList to audio files, asks for confirmation
  // when subfolders were involved, then delegates to handleUploadSong.
  const handleUploadFiles = useCallback(async (files: File[], opts: { sawNestedFolder: boolean }) => {
    const audio = files.filter((f) => AUDIO_EXTENSIONS.test(f.name));
    if (audio.length === 0) {
      alert('No audio files found (.mp3, .wav, .flac, .ogg, .m4a).');
      return;
    }
    if (opts.sawNestedFolder) {
      const ok = confirm(
        `Found ${audio.length} audio file${audio.length === 1 ? '' : 's'} across one or more subfolders. ` +
        `Upload them all flat (folder structure will not be preserved)?`,
      );
      if (!ok) return;
    }
    await handleUploadSong(audio);
  }, [handleUploadSong]);

  // ── Delete song(s) ────────────────────────────────────────────────────────
  // Hits DELETE /api/songs/<slug> (single) or DELETE /api/songs (all).
  // Caller is expected to gate with the typed-confirmation dialog below; this
  // function is purely the network + state-cleanup side.
  const handleDeleteSong = useCallback(async (slug: string | 'all') => {
    const url = slug === 'all' ? '/api/songs' : `/api/songs/${encodeURIComponent(slug)}`;
    try {
      const res = await fetch(url, { method: 'DELETE' });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error('[delete-song]', slug, 'HTTP', res.status, text);
        alert(`Delete failed: HTTP ${res.status}`);
        return;
      }
    } catch (err) {
      console.error('[delete-song]', slug, err);
      alert(`Delete failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      return;
    }
    const refreshed = await fetchManifest();
    setAudioFiles(refreshed);
    // Clear caches for the deleted slug(s) so the sidebar stops showing them.
    if (slug === 'all') {
      setSongInfos({});
      setSongStatuses({});
      setSelectedAudio(null);
    } else {
      setSongInfos((prev) => {
        const next = { ...prev };
        delete next[slug];
        return next;
      });
      setSongStatuses((prev) => {
        const next = { ...prev };
        delete next[slug];
        return next;
      });
      // If the active song was deleted, fall back to the first remaining one.
      if (selectedAudioRef.current?.id === slug) {
        const next = firstVisibleSong(refreshed);
        if (next) selectAudio(next);
        else setSelectedAudio(null);
      }
    }
    refreshStorageStats();
  }, [selectAudio, refreshStorageStats, isDemo]);

  // ── Clear regenerable caches (per song or all) ────────────────────────────
  // Wipes stems + analysis JSONs + MSAF raw + BPM + algo-clusters + MIR features
  // + custom-script results.
  // Annotations, song-info, and audio files are NEVER touched. Audio-related
  // tool-state (waveform/buffer/loaded JSONs) is reloaded from disk on the
  // next song select; here we only flush the in-memory caches that mirror it.
  const handleClearSongCaches = useCallback(async (slug: string) => {
    try {
      await clearSongCaches(slug);
    } catch (err) {
      console.error('[clear-song-caches]', slug, err);
      alert(`Clear caches failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      return;
    }
    refreshStorageStats();
    // If the cleared song is currently selected, drop the in-memory tool
    // results so the UI no longer shows stale chips. Re-selecting will refetch.
    if (selectedAudioRef.current?.id === slug) {
      setToolStates({});
      setRupturesResults({});
      setCustomResults({});
      setMirCurves(null);
      setBpmDetection(null);
      setBpmDetectionStatus('idle');
      setStemManifest(null);
      setSelectedStemSource('mix');
    }
  }, [refreshStorageStats]);

  const handleClearAllCaches = useCallback(async () => {
    try {
      await clearAllCaches();
    } catch (err) {
      console.error('[clear-all-caches]', err);
      alert(`Clear all caches failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      return;
    }
    refreshStorageStats();
    setToolStates({});
    setRupturesResults({});
    setCustomResults({});
    setCustomAnnotationOverrides({});
    setMirCurves(null);
    setBpmDetection(null);
    setBpmDetectionStatus('idle');
    setStemManifest(null);
    setSelectedStemSource('mix');
  }, [refreshStorageStats]);

  // Tri-mode per-song clear. STEM = stems only, ALGOS = all regenerable caches,
  // EVERYTHING = audio + every annotator's annotations + caches (irreversible).
  // After the destructive call, run the same in-memory cleanup as the existing
  // per-song flows so the UI doesn't show stale results.
  const handleClearScopeForSong = useCallback(async (slug: string, scope: ClearScope) => {
    try {
      if (scope === 'STEM') {
        await clearSongStems(slug);
      } else if (scope === 'ALGOS') {
        await clearSongCaches(slug);
      } else {
        // EVERYTHING — wipes audio + caches + every annotator's annotations.
        await deleteSongEverything(slug);
      }
    } catch (err) {
      console.error('[clear-scope]', slug, scope, err);
      alert(`${scope} failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      return;
    }

    // Flush in-memory state that mirrors the now-deleted disk state.
    if (selectedAudioRef.current?.id === slug) {
      setStemManifest(null);
      setSelectedStemSource('mix');
      if (scope !== 'STEM') {
        setToolStates({});
        setRupturesResults({});
        setCustomResults({});
        setMirCurves(null);
        setBpmDetection(null);
        setBpmDetectionStatus('idle');
      }
    }

    if (scope === 'EVERYTHING') {
      // Re-pull the manifest because the slug is gone. Mirrors handleDeleteSong.
      const refreshed = await fetchManifest();
      setAudioFiles(refreshed);
      setSongInfos((prev) => { const next = { ...prev }; delete next[slug]; return next; });
      setSongStatuses((prev) => { const next = { ...prev }; delete next[slug]; return next; });
      if (selectedAudioRef.current?.id === slug) {
        const next = firstVisibleSong(refreshed);
        if (next) selectAudio(next);
        else setSelectedAudio(null);
      }
    }

    refreshStorageStats();
  }, [refreshStorageStats, selectAudio, isDemo]);

  // ── Run algorithms ────────────────────────────────────────────────────────
  // Split the selection into built-ins (handled by /api/run-algorithms) and custom
  // detectors (handled per-name by /api/custom-scripts/run). The two paths run
  // concurrently — custom detectors are typically much faster than allin1/Demucs.
  const splitAlgorithmSelection = useCallback((sel: Set<string>) => {
    const builtins: string[] = [];
    const custom: string[] = [];
    for (const id of sel) {
      if (id.startsWith('custom:')) custom.push(id.slice('custom:'.length));
      else builtins.push(id);
    }
    return { builtins, custom };
  }, []);

  // Re-run a single detector for the current song, surfacing the 409
  // edited-output conflict as a confirm dialog. On confirm the run is retried
  // with `confirm_overwrite=1` and the edited copy-on-write file is wiped.
  // The marker-config "↻ Re-run" button hits this path.
  const rerunDetectorForCurrentSong = useCallback(async (name: string, slug: string) => {
    setCustomRunning((prev) => {
      if (prev.has(name)) return prev;
      const next = new Set(prev);
      next.add(name);
      return next;
    });
    try {
      let result = await runDetectorWithConflictCheck(name, slug, { force: true });
      if (result.status === 'conflict') {
        const c = result.conflict;
        const ok = window.confirm(
          `You have edited output for "${c.detector}" on this song.\n\n` +
          `Re-running will overwrite your edits at:\n${c.path}\n\n` +
          `Consider renaming the detector (e.g. ${c.detector}_v01, ${c.detector}_v02) ` +
          `instead. Continue and overwrite?`,
        );
        if (!ok) return;
        result = await runDetectorWithConflictCheck(name, slug, {
          force: true,
          confirmOverwrite: true,
        });
      }
      if (result.status === 'ok' && selectedAudioRef.current?.id === slug) {
        setCustomResults((prev) => ({ ...prev, [name]: result.envelope }));
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Detector re-run failed.');
    } finally {
      setCustomRunning((prev) => {
        if (!prev.has(name)) return prev;
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
  }, []);

  const runCustomDetectors = useCallback(async (slug: string, names: string[]) => {
    setCustomRunning((prev) => {
      const next = new Set(prev);
      names.forEach((n) => next.add(n));
      return next;
    });
    await Promise.allSettled(names.map(async (name) => {
      try {
        const env = await runDetector(name, slug, { force: true });
        if (selectedAudioRef.current?.id === slug) {
          setCustomResults((prev) => ({ ...prev, [name]: env }));
        }
      } catch {
        // surfacing per-detector failures is the Playground page's job; here we
        // just skip so a broken script doesn't poison the batch.
      } finally {
        setCustomRunning((prev) => {
          if (!prev.has(name)) return prev;
          const next = new Set(prev);
          next.delete(name);
          return next;
        });
      }
    }));
  }, []);

  // Run the currently selected algorithms (built-ins + custom) for one song.
  // Shared by the dataset-wide batch button and the per-song "Run for this song"
  // button in AlgoInspectStage. Does not refresh toolStates — callers decide
  // whether to re-fire the per-song loaders after completion.
  // Passing `algoIds` overrides the persistent selection — used by the
  // per-section "Run missing" buttons so they don't disturb the user's ticks.
  const runAlgorithmsForOneSong = useCallback(async (
    audio: AudioEntry,
    progressLabel: string,
    algoIds?: Set<string> | string[],
  ): Promise<void> => {
    const sel = algoIds === undefined
      ? selectedAlgorithms
      : (algoIds instanceof Set ? algoIds : new Set(algoIds));
    const { builtins, custom } = splitAlgorithmSelection(sel);
    const customRun = custom.length ? runCustomDetectors(audio.id, custom) : Promise.resolve();
    if (builtins.length === 0) {
      setRunJob({
        jobId: `custom-${audio.id}`,
        status: 'running',
        logs: `${progressLabel} (custom only)\n`,
        startedAt: Date.now(),
      });
      await customRun;
      setRunJob((prev) => prev ? { ...prev, status: 'done' } : null);
      return;
    }
    const res = await fetch(`/api/run-algorithms/${encodeURIComponent(audio.id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ demucsModel, algorithms: builtins }),
    });
    const data = await res.json();
    if (!data.jobId) {
      await customRun;
      return;
    }
    const jobId: string = data.jobId;
    setRunJob({
      jobId,
      status: 'running',
      logs: `${progressLabel}\n`,
      startedAt: Date.now(),
    });
    while (true) {
      await new Promise((r) => setTimeout(r, 2000));
      const statusRes = await fetch(`/api/run-algorithms/status/${encodeURIComponent(jobId)}`);
      const status = await statusRes.json();
      setRunJob((prev) => prev
        ? { ...prev, status: status.status, logs: status.logs ?? prev.logs, sections: status.sections ?? prev.sections }
        : { jobId, status: status.status, logs: status.logs ?? '', startedAt: Date.now(), sections: status.sections });
      if (status.status !== 'running') break;
    }
    await customRun;
  }, [selectedAlgorithms, demucsModel, splitAlgorithmSelection, runCustomDetectors]);

  // Batch: fire the same per-song run sequentially across the entire dataset.
  // Reuses /api/run-algorithms/<slug> from the inspect path; each song's job
  // is polled to completion before the next one fires, so backend pressure
  // stays bounded.
  const handleBatchRunAlgorithms = useCallback(async () => {
    if (audioFiles.length === 0) return;
    if (runJob?.status === 'running') return;
    if (selectedAlgorithms.size === 0) {
      alert('Pick at least one algorithm in the ⚙ options panel first.');
      return;
    }
    const ok = confirm(
      `Run ${selectedAlgorithms.size} algorithm(s) across ${audioFiles.length} song(s)?\n` +
      `Songs run one at a time and may take a while.`,
    );
    if (!ok) return;
    setRunOptionsScope(null);
    for (let i = 0; i < audioFiles.length; i++) {
      const audio = audioFiles[i];
      await runAlgorithmsForOneSong(audio, `▶ Batch ${i + 1}/${audioFiles.length}: ${audio.name}`);
    }
  }, [audioFiles, runJob, selectedAlgorithms, runAlgorithmsForOneSong]);

  // Per-song trigger surfaced from AlgoInspectStage's empty state. Reuses the
  // algorithm selection + Demucs model owned by Dataset Prep (one source of
  // truth), then re-selects the song so the per-song loaders pick up the
  // freshly written analysis JSON.
  const handleRunForCurrentSong = useCallback(async () => {
    if (!selectedAudio) return;
    if (runJob?.status === 'running') return;
    if (selectedAlgorithms.size === 0) {
      alert('Pick at least one algorithm in Dataset Prep → ⚙ Batch algorithm options first.');
      return;
    }
    await runAlgorithmsForOneSong(selectedAudio, `▶ ${selectedAudio.name}`);
    if (selectedAudioRef.current?.id === selectedAudio.id) {
      selectAudio(selectedAudio);
    }
  }, [selectedAudio, runJob, selectedAlgorithms, runAlgorithmsForOneSong, selectAudio]);

  // Per-section "Run missing" — runs the supplied algorithm IDs directly
  // (bypassing the persistent selection) so the user can fill in gaps without
  // touching their ticks. Built-in IDs go to /api/run-algorithms, `custom:X`
  // IDs go through runCustomDetectors. Caller is expected to have already
  // filtered out cached entries.
  const handleRunMissingForSection = useCallback(async (ids: string[]) => {
    if (!selectedAudio) return;
    if (runJob?.status === 'running') return;
    if (ids.length === 0) return;
    await runAlgorithmsForOneSong(selectedAudio, `▶ ${selectedAudio.name} · missing`, ids);
    if (selectedAudioRef.current?.id === selectedAudio.id) {
      selectAudio(selectedAudio);
    }
  }, [selectedAudio, runJob, runAlgorithmsForOneSong, selectAudio]);

  // Per-song Demucs stem separation. Lives in the Dataset Prep sidebar row
  // (next to ⌫). Always runs htdemucs — the Demucs-model dropdown in the
  // header only applies to algorithm runs (the separator script is hardcoded
  // to htdemucs upstream). If stems are already cached for this song, we
  // confirm before overwriting them.
  const handleStemSong = useCallback(async (audio: AudioEntry) => {
    if (demucsJob?.status === 'running') {
      alert('A Demucs stem job is already running. Wait for it to finish before starting another.');
      return;
    }
    // Surface a client-side error as the persistent red pill AND console.
    // Every catch in this function routes through fail() so nothing fails
    // silently — the user can always inspect what went wrong via the pill's
    // modal or by filtering devtools for "[stems]".
    const fail = (where: string, err: unknown, extra?: string) => {
      const msg = err instanceof Error
        ? `${err.name}: ${err.message}${err.stack ? '\n' + err.stack : ''}`
        : err == null ? '' : String(err);
      console.error(`[stems] ${where}`, err, extra ?? '');
      const body = [`[client] ${where}`, msg, extra].filter(Boolean).join('\n');
      setDemucsJob({
        slug: audio.id,
        jobId: '(client-error)',
        status: 'error',
        logs: body,
        startedAt: Date.now(),
      });
    };
    try {
      const existing = await fetchStemManifest(audio.url).catch((e) => {
        console.warn('[stems] pre-check fetchStemManifest failed (continuing):', e);
        return null;
      });
      if (existing) {
        const ok = confirm(
          `Stems for "${audio.name}" already exist.\n` +
          `Re-running Demucs will overwrite them. Continue?`,
        );
        if (!ok) return;
      }
      let res: Response;
      try {
        res = await fetch(`/api/run-demucs/${encodeURIComponent(audio.id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: !!existing }),
        });
      } catch (e) {
        fail('POST /api/run-demucs network error', e);
        return;
      }
      const rawBody = await res.text().catch((e) => {
        console.error('[stems] response.text() failed:', e);
        return '';
      });
      if (!res.ok) {
        fail('POST /api/run-demucs returned non-OK', null, `HTTP ${res.status}\n${rawBody.slice(0, 600)}`);
        return;
      }
      let data: { jobId?: string } = {};
      try { data = JSON.parse(rawBody); }
      catch (e) { console.error('[stems] start response JSON parse failed:', e, { body: rawBody }); }
      if (!data.jobId) {
        fail('start response missing jobId', null, `body: ${rawBody.slice(0, 600)}`);
        return;
      }
      const jobId: string = data.jobId;
      console.log('[stems] job started', { jobId, slug: audio.id });
      setDemucsJob({ slug: audio.id, jobId, status: 'running', logs: '', startedAt: Date.now() });
      let lastLogsLen = 0;
      let lastStatus: { status: string; logs: string } = { status: 'running', logs: '' };
      while (true) {
        await new Promise((r) => setTimeout(r, 2000));
        // Per-poll fetch + JSON parse can fail independently (network blip,
        // server restart, malformed body). Catch each separately and log
        // with the actual error so the user can tell flaky polling apart
        // from a genuine Demucs failure.
        let status: { status: string; logs: string };
        try {
          const statusRes = await fetch(`/api/run-demucs/status/${encodeURIComponent(jobId)}`);
          if (!statusRes.ok) {
            const body = await statusRes.text().catch(() => '');
            console.error('[stems] status poll non-OK', { httpStatus: statusRes.status, body: body.slice(0, 400) });
            status = { status: 'error', logs: `[client] status poll returned HTTP ${statusRes.status}\n${body.slice(0, 400)}` };
          } else {
            status = await statusRes.json();
          }
        } catch (e) {
          console.error('[stems] status poll failed:', e);
          status = { status: 'error', logs: `[client] status poll failed: ${e instanceof Error ? e.message : String(e)}` };
        }
        lastStatus = status;
        // Stream new log output to the devtools console as it arrives so the
        // user can debug stuck/failing jobs without docker logs access.
        const logs: string = status.logs ?? '';
        if (logs.length > lastLogsLen) {
          const delta = logs.slice(lastLogsLen);
          console.log('[stems]', delta.replace(/\n+$/, ''));
          lastLogsLen = logs.length;
        }
        // Parse Demucs's tqdm output for the running pill. tqdm overwrites
        // the same line with \r so we split on both \r and \n and take the
        // rightmost non-empty token as the "current step" subtitle. The
        // rightmost \d+% inside that token is the progress bar percentage.
        const tokens = logs.split(/[\r\n]+/);
        let lastLine: string | undefined;
        for (let i = tokens.length - 1; i >= 0; i--) {
          const t = tokens[i].trim();
          if (t.length > 0) { lastLine = t.slice(0, 140); break; }
        }
        const pctMatch = lastLine?.match(/(\d{1,3})%/);
        const progressPct = pctMatch
          ? Math.min(100, Math.max(0, parseInt(pctMatch[1], 10)))
          : undefined;
        const cancelMode = (status as { cancelMode?: 'soft' | 'hard' }).cancelMode;
        setDemucsJob((prev) => prev && prev.jobId === jobId
          ? { ...prev, status: status.status, logs, progressPct, lastLine, cancelMode }
          : prev);
        if (status.status !== 'running') break;
      }
      // Terminal status: log to console; the persistent red "Stems failed —
      // view log" pill in StemSourcePicker now surfaces failure (with a
      // click-to-open modal showing the log tail), so we no longer fire an
      // alert() that the user might miss or dismiss.
      if (lastStatus.status === 'error') {
        console.error(`[stems] job ${jobId} failed:\n${lastStatus.logs || '(no logs returned)'}`);
      } else if (lastStatus.status === 'cancelled') {
        console.warn(`[stems] job ${jobId} cancelled`);
      } else if (lastStatus.status === 'done') {
        console.log(`[stems] job ${jobId} done`);
      }
      if (selectedAudioRef.current?.id === audio.id) {
        const m = await fetchStemManifest(audio.url).catch((e) => {
          // Job succeeded but the picker won't refresh — log loudly so the
          // user knows why "Vocals/Drums/Bass/Other" stay greyed out.
          console.error('[stems] post-job fetchStemManifest failed:', e);
          return null;
        });
        setStemManifest(m);
      }
    } catch (e) {
      // Catch-all so nothing slips into an unhandled rejection. If we land
      // here the error pill + modal will tell the user what happened.
      fail('handleStemSong unexpected throw', e);
    }
  }, [demucsJob]);

  // Soft cancel: SIGINT the demucs subprocess. Demucs cleans up between
  // chunks, then the polling loop sees status='cancelled' and the pill
  // returns to idle. Optimistically set cancelMode='soft' so the pill flips
  // to "⌛ Cancelling…" without waiting for the next poll tick.
  const handleCancelStems = useCallback(async () => {
    if (!demucsJob || demucsJob.status !== 'running') return;
    setDemucsJob((prev) => prev ? { ...prev, cancelMode: 'soft' } : prev);
    try {
      const res = await fetch(`/api/run-demucs/cancel/${encodeURIComponent(demucsJob.jobId)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error('[stems] cancel returned non-OK', { status: res.status, body: body.slice(0, 400) });
      } else {
        console.log('[stems] cancel requested', { jobId: demucsJob.jobId });
      }
    } catch (e) {
      console.error('[stems] cancel request failed:', e);
    }
  }, [demucsJob]);

  // Hard kill: SIGKILL the whole subprocess group. GPU/CPU work stops
  // immediately. Same optimistic UX as cancel: pill flips to "⌛ Killing…"
  // until the polling loop confirms status='cancelled'.
  const handleKillStems = useCallback(async () => {
    if (!demucsJob || demucsJob.status !== 'running') return;
    setDemucsJob((prev) => prev ? { ...prev, cancelMode: 'hard' } : prev);
    try {
      const res = await fetch(`/api/run-demucs/kill/${encodeURIComponent(demucsJob.jobId)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error('[stems] kill returned non-OK', { status: res.status, body: body.slice(0, 400) });
      } else {
        console.log('[stems] kill requested', { jobId: demucsJob.jobId });
      }
    } catch (e) {
      console.error('[stems] kill request failed:', e);
    }
  }, [demucsJob]);

  const handleStopJob = useCallback(async () => {
    if (!runJob || runJob.status !== 'running') return;
    await fetch(`/api/run-algorithms/cancel/${encodeURIComponent(runJob.jobId)}`, { method: 'DELETE' });
    if (runJobPollRef.current) { clearInterval(runJobPollRef.current); runJobPollRef.current = null; }
    setRunJob((prev) => prev ? { ...prev, status: 'cancelled' } : null);
  }, [runJob]);

  // Cleanup poll on unmount
  useEffect(() => () => {
    if (runJobPollRef.current) clearInterval(runJobPollRef.current);
  }, []);

  // Elapsed-time ticker: re-render every second while either an algorithm
  // job or a Demucs stem job is running (the stem pill shows MM:SS that
  // needs to advance between the 2-second polling ticks).
  useEffect(() => {
    if (runJob?.status !== 'running' && demucsJob?.status !== 'running') return;
    const id = setInterval(() => setElapsedTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [runJob?.status, demucsJob?.status]);

  // Auto-scroll log pane to bottom when new output arrives
  useEffect(() => {
    if (logPreRef.current) logPreRef.current.scrollTop = logPreRef.current.scrollHeight;
  }, [runJob?.logs]);

  // ── Annotation timer helpers ──────────────────────────────────────────────

  const saveAnnotationTimes = useCallback((slug: string, perKey: Record<TimerKey, number>) => {
    fetch(`/api/annotation-times/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ perType: {
        manual:      Math.round(perKey.manual),
        eye:       Math.round(perKey.eye),
        autoGuess: Math.round(perKey.autoGuess),
      }}),
    }).catch(() => null);
  }, []);

  // Flush current session into the appropriate per-type total and optionally persist
  const pauseAnnotationTimer = useCallback((slug?: string) => {
    const sessionType = annotationSessionTypeRef.current;
    if (annotationSessionStartRef.current === null || sessionType === null) return 0;
    const sessionSecs = (Date.now() - annotationSessionStartRef.current) / 1000;
    annotationSessionStartRef.current = null;
    annotationSessionTypeRef.current = null;
    setTimerRunning(false);
    setAnnotationTimesSaved((prev) => {
      const next = { ...prev, [sessionType]: prev[sessionType] + sessionSecs };
      if (slug) saveAnnotationTimes(slug, next);
      return next;
    });
    return sessionSecs;
  }, [saveAnnotationTimes]);

  const startAnnotationTimer = useCallback((key: TimerKey) => {
    if (annotationSessionStartRef.current !== null) return; // already running
    annotationSessionStartRef.current = Date.now();
    annotationSessionTypeRef.current = key;
    setTimerRunning(true);
  }, []);

  // Ticker: re-render every second while a session is active
  useEffect(() => {
    if (!timerRunning) return;
    const id = setInterval(() => setAnnotationTimerTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [timerRunning]);

  // Auto-pause timer when leaving the annotation stage or switching songs.
  // Starting is user-driven via the Start/Continue button — do not auto-start
  // on enter. Switching the active annotation type while a session is running
  // also auto-stops, so recorded time always belongs to the type the user was on.
  const isAnnotationStage = activeStage === 'annotation' && mode === 'song';
  const currentAnnotationSlug = selectedAudio?.id ?? null;

  useEffect(() => {
    if (!isAnnotationStage && currentAnnotationSlug) {
      pauseAnnotationTimer(currentAnnotationSlug);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAnnotationStage, currentAnnotationSlug]);

  // Active timer key derived from {type, source}. Detector sources don't have
  // their own timer slot — fall back to 'manual' so the boundary timer stays
  // visible even while the user is reviewing a detector output.
  const activeTimerKey: TimerKey | null = activeAnnotationType === 'boundaries'
    ? (activeBoundarySource ?? null)
    : activeAnnotationType;

  useEffect(() => {
    if (
      annotationSessionStartRef.current !== null &&
      annotationSessionTypeRef.current !== null &&
      activeTimerKey !== null &&
      annotationSessionTypeRef.current !== activeTimerKey
    ) {
      pauseAnnotationTimer(currentAnnotationSlug ?? undefined);
    }
  }, [activeTimerKey, currentAnnotationSlug, pauseAnnotationTimer]);

  // Computed totals (saved + live session) per timer key
  const liveSessionSecs = annotationSessionStartRef.current !== null
    ? (Date.now() - annotationSessionStartRef.current) / 1000
    : 0;
  const annotationTimesTotal: Record<TimerKey, number> = {
    manual:      annotationTimesSaved.manual      + (annotationSessionTypeRef.current === 'manual'      ? liveSessionSecs : 0),
    eye:       annotationTimesSaved.eye       + (annotationSessionTypeRef.current === 'eye'       ? liveSessionSecs : 0),
    autoGuess: annotationTimesSaved.autoGuess + (annotationSessionTypeRef.current === 'autoGuess' ? liveSessionSecs : 0),
    cues:      annotationTimesSaved.cues      + (annotationSessionTypeRef.current === 'cues'      ? liveSessionSecs : 0),
    spans:     annotationTimesSaved.spans     + (annotationSessionTypeRef.current === 'spans'     ? liveSessionSecs : 0),
    loops:     annotationTimesSaved.loops     + (annotationSessionTypeRef.current === 'loops'     ? liveSessionSecs : 0),
    patterns:  annotationTimesSaved.patterns  + (annotationSessionTypeRef.current === 'patterns'  ? liveSessionSecs : 0),
  };

  function fmtAnnotationTime(secs: number): string {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // ── Compute MIR curves when audio buffer arrives ──────────────────────────
  useEffect(() => {
    if (!audioBuffer) { setMirCurves(null); setMirComputing(false); return; }
    let cancelled = false;
    setMirComputing(true);
    computeMIRFeatures(audioBuffer, () => {}).then((mir) => {
      if (cancelled) return;
      setMirCurves({
        energy:   Array.from(mir.energy),
        spectral: Array.from(mir.centroid),
        novelty:  Array.from(mir.novelty),
        onsets:   Array.from(mir.onsets),
        flux:     Array.from(mir.flux),
        lowBand:  Array.from(mir.lowBand),
        midBand:  Array.from(mir.midBand),
        highBand: Array.from(mir.highBand),
        frameDuration: mir.hopSize / mir.sampleRate,
        mfcc: mir.mfcc,
        nMfcc: mir.nMfcc,
        chroma: mir.chroma,
        nChroma: mir.nChroma,
        tempogram: mir.tempogram,
        nTempo: mir.nTempo,
        tempogramFrameCount: mir.tempogramFrameCount,
        tempoBpm: mir.tempoBpm,
        ssm: mir.ssm,
        ssmFrameCount: mir.ssmFrameCount,
        frameCount: mir.frameCount,
      });
      setMirComputing(false);
    }).catch((err) => {
      if (cancelled) return;
      console.error('[mir] computeMIRFeatures failed', err);
      setMirComputing(false);
    });
    return () => { cancelled = true; };
  }, [audioBuffer]);

  // ── Auto-stop at section / preview-window end ────────────────────────────
  // Preview takes priority: when active, it controls end-of-region behaviour
  // (loop or pause+restore-anchor). Otherwise fall back to section stop.
  useEffect(() => {
    if (!playerIsPlaying) return;
    if (previewRegion && playerTime >= previewRegion.end) {
      if (previewRegion.loop) {
        seekRef.current?.(previewRegion.start);
      } else {
        pauseRef.current?.();
        const anchor = previewAnchorRef.current;
        if (anchor !== null) setTimeout(() => seekRef.current?.(anchor), 50);
      }
      return;
    }
    if (sectionStopAtRef.current !== null && playerTime >= sectionStopAtRef.current) {
      pauseRef.current?.();
      sectionStopAtRef.current = null;
    }
  }, [playerTime, playerIsPlaying, previewRegion]);

  // ── Imperative player helpers ─────────────────────────────────────────────
  const handleSeekAndPlay = useCallback((time: number, stopTime?: number) => {
    sectionStopAtRef.current = stopTime ?? null;
    seekRef.current?.(time);
    setTimeout(() => playRef.current?.(), 50);
  }, []);

  const handlePause = useCallback(() => {
    pauseRef.current?.();
    sectionStopAtRef.current = null;
  }, []);

  // ── Preview window handlers ──────────────────────────────────────────────
  // Save current cursor as anchor before opening, then play start→end. Subsequent
  // edits keep the anchor. End/dismiss restores the cursor to anchor.
  const openPreviewRegion = useCallback((start: number, end: number, defaultLoop = false) => {
    if (start >= end) return;
    if (!previewRegion) previewAnchorRef.current = playerTimeRef.current;
    // In loop-annotation mode, every new highlight loops by default — even if the user
    // toggled the prior preview's loop off. Otherwise, preserve the prior loop setting.
    const loop = defaultLoop ? true : (previewRegion?.loop ?? false);
    const next: PreviewRegion = { start, end, loop };
    setPreviewRegion(next);
    sectionStopAtRef.current = null;
    seekRef.current?.(start);
    setTimeout(() => playRef.current?.(), 50);
  }, [previewRegion]);

  const handlePreviewRegionChange = useCallback((next: PreviewRegion) => {
    setPreviewRegion(next);
    // In annotation modes where the "+ Add" pill mirrors the preview span (manual/loops),
    // keep them locked together so resizing the preview also updates the pending range.
    setPendingAnnotationSelection((prev) => {
      if (!prev || prev.t2 === null) return prev;
      return { t1: next.start, t2: next.end };
    });
    // If playback wandered outside the new bounds (e.g. region moved), jump to start.
    if (playerIsPlayingRef.current) {
      const t = playerTimeRef.current;
      if (t < next.start || t > next.end) seekRef.current?.(next.start);
    }
  }, []);

  const handlePreviewPlay = useCallback(() => {
    if (!previewRegion) return;
    seekRef.current?.(previewRegion.start);
    setTimeout(() => playRef.current?.(), 50);
  }, [previewRegion]);

  const handlePreviewPause = useCallback(() => {
    pauseRef.current?.();
  }, []);

  const handlePreviewDismiss = useCallback(() => {
    pauseRef.current?.();
    const anchor = previewAnchorRef.current;
    previewAnchorRef.current = null;
    setPreviewRegion(null);
    // Manual mode pairs the preview with the "+ Add" pill — dismiss them together.
    setPendingAnnotationSelection(null);
    if (anchor !== null) setTimeout(() => seekRef.current?.(anchor), 30);
  }, []);

  const handlePreviewLoopToggle = useCallback(() => {
    setPreviewRegion((prev) => prev ? { ...prev, loop: !prev.loop } : prev);
  }, []);

  // Click-on-row clear — used by Algo Inspect's MiniBlockRow when the user
  // clicks (instead of drags) on a row that has an active preview band.
  // Unlike handlePreviewDismiss this does NOT restore the anchor cursor —
  // the click already seeked the playhead, and re-seeking to the anchor
  // would undo that.
  const handlePreviewClear = useCallback(() => {
    previewAnchorRef.current = null;
    setPreviewRegion(null);
  }, []);

  // Keep keyboard handler stable across renders by reading latest handlers via refs.
  const openPreviewRegionRef = useRef(openPreviewRegion);
  const handlePreviewDismissRef = useRef(handlePreviewDismiss);
  const previewRegionRef = useRef(previewRegion);
  useEffect(() => { openPreviewRegionRef.current = openPreviewRegion; }, [openPreviewRegion]);
  useEffect(() => { handlePreviewDismissRef.current = handlePreviewDismiss; }, [handlePreviewDismiss]);
  useEffect(() => { previewRegionRef.current = previewRegion; }, [previewRegion]);

  // ── Viz scroll sync ───────────────────────────────────────────────────────
  const handleScrollChange = useCallback((scrollLeft: number) => {
    isProgrammaticScrollRef.current = true;
    const el = vizScrollContainerRef.current;
    if (el) el.scrollLeft = scrollLeft;
    isProgrammaticScrollRef.current = false;
  }, []);

  const handleVizScroll = useCallback(() => {
    if (isProgrammaticScrollRef.current) return;
    const el = vizScrollContainerRef.current;
    if (!el) return;
    wsScrollRef.current?.(el.scrollLeft);
  }, []);

  // vizSignalWidth: the player's waveform signal area at the current zoom
  // (containerWidth = WaveSurfer's flex-1 width, ×zoomFactor). SharedVizPanel
  // adds its own resizable label gutter on top, so pass the bare signal width
  // here — baking in a fixed 72 px gutter made the viz rows' content column a
  // few px off from the player's waveform, drifting the cursor/highlight.
  const handleViewChange = useCallback((zoomFactor: number, containerWidth: number, atMaxZoom: boolean) => {
    setVizSignalWidth(zoomFactor > 1 ? containerWidth * zoomFactor : 0);
    setVizZoomFactor(zoomFactor);
    setVizAtMaxZoom(atMaxZoom);
  }, []);

  // ── Viz click routing ─────────────────────────────────────────────────────
  // Preview-play on drag is the default everywhere (prep, algo, eval, annotation).
  // Only the Eye annotation mode suppresses it — that's a silent-by-design mode.
  // Pending "+ Add" pill is wired only to the annotation feature, since the
  // other stages have no annotation editor to receive it.
  const isAnnotateFeature = feature === 'annotate';
  const handleVizClick = useCallback((time: number) => {
    seekRef.current?.(time);

    // Unified deselect: any highlighted selection — drag preview-region or a
    // ranged pending pill — is torn down by a click in every stage/feature
    // (prep, algo, eval, and all annotation modes). The click also seeks
    // (above), so the cursor lands where the user clicked.
    const hasRange = pendingAnnotationSelectionRef.current?.t2 != null;
    if (hasRange || previewRegion) {
      previewAnchorRef.current = null;
      setPreviewRegion(null);
      setPendingAnnotationSelection(null);
      return;
    }

    if (!isAnnotateFeature) return;

    // Boundaries (Manual/Eye): with nothing to deselect, a click (re)anchors
    // the t1-only pending pill at the cursor — point-by-point authoring.
    if (supportsClickPending(activeAnnotationType, activeBoundarySource ?? undefined)) {
      setPendingAnnotationSelection({ t1: time, t2: null });
    }
  }, [isAnnotateFeature, activeAnnotationType, activeBoundarySource, previewRegion]);

  const handleVizRegion = useCallback((t1: number, t2: number) => {
    const isEye = isAnnotateFeature && activeAnnotationType === 'boundaries' && activeBoundarySource === 'eye';
    const supportsPending = isAnnotateFeature && supportsRangePending(activeAnnotationType, activeBoundarySource ?? undefined);
    if (supportsPending) setPendingAnnotationSelection({ t1, t2 });
    if (isEye) {
      // Eye is a silent annotation mode — seek to the start but don't auto-play the region.
      seekRef.current?.(t1);
    } else {
      // Loop-annotation mode loops the highlighted selection by default.
      const defaultLoop = isAnnotateFeature && activeAnnotationType === 'loops';
      openPreviewRegion(t1, t2, defaultLoop);
    }
  }, [isAnnotateFeature, activeAnnotationType, activeBoundarySource, openPreviewRegion]);

  const pushManualSnapshot = useCallback(() => {
    const current = manualAnnotationRef.current;
    if (!current) return;
    manualUndoStack.current.push([...current.sections]);
    setCanManualUndo(true);
  }, []);

  const handleManualBoundaryDragStart = useCallback(() => {
    pushManualSnapshot();
  }, [pushManualSnapshot]);

  const handleManualBoundaryChange = useCallback((sectionIndex: number, newTime: number) => {
    const current = manualAnnotationRef.current;
    if (!current || !setSectionsRef.current) return;
    const bpmVal = (songInfo?.bpm ?? 0) > 20 ? songInfo!.bpm! : 0;
    const offset = songInfo?.gridOffset ?? 0;
    const beatsPerBarVal = beatsPerBarFromTimeSignature(songInfo?.timeSignature);
    const anchorsForSnap = effectiveAnchors(songInfo);
    const overridesForSnap = effectiveGridMode(songInfo) === 'manual' ? songInfo?.beatOverrides : undefined;
    const snapped = snapToGrid && bpmVal > 0
      ? snapTimeToGrid(newTime, bpmVal, offset, beatsPerBarVal, 'beat', anchorsForSnap, overridesForSnap)
      : newTime;
    const sections = [...current.sections];
    sections[sectionIndex] = { ...sections[sectionIndex], time: snapped };
    setSectionsRef.current(sections);
  }, [songInfo, snapToGrid]);

  const handleManualSectionDelete = useCallback((sectionIndex: number) => {
    const current = manualAnnotationRef.current;
    if (!current || !setSectionsRef.current) return;
    pushManualSnapshot();
    setSectionsRef.current(current.sections.filter((_, i) => i !== sectionIndex));
  }, [pushManualSnapshot]);

  const handleManualUndo = useCallback(() => {
    const prevSections = manualUndoStack.current.pop();
    if (!prevSections || !setSectionsRef.current) return;
    setCanManualUndo(manualUndoStack.current.length > 0);
    setSectionsRef.current(prevSections);
  }, []);

  // ── Layer-item drag handlers ─────────────────────────────────────────────
  // Cues / Loops / Spans / Patterns all live in cueLayersDoc. Each drag
  // callback maps the affected layer's items, patching the single item by
  // id. Same shape as the popover edit handlers further down — kept inline
  // because TS struggles with a generic helper across the union of item types.
  const patchItemById = useCallback((layerId: string, itemId: string, patch: object) => {
    setCueLayersDoc((d) => d && ({
      ...d,
      layers: d.layers.map((l) =>
        l.id === layerId
          ? { ...l, items: (l.items as readonly { id: string }[]).map((it) =>
              it.id === itemId ? { ...it, ...patch } : it,
            ) } as typeof l
          : l,
      ),
    }));
  }, [setCueLayersDoc]);

  const handleCueDrag = useCallback((layerId: string, itemId: string, time: number) => {
    patchItemById(layerId, itemId, { time });
  }, [patchItemById]);

  const handleLoopEdgeDrag = useCallback((layerId: string, itemId: string, edge: 'start' | 'end', time: number) => {
    patchItemById(layerId, itemId, edge === 'start' ? { start: time } : { end: time });
  }, [patchItemById]);

  const handleSpanEdgeDrag = useCallback((layerId: string, itemId: string, edge: 'start' | 'end', time: number) => {
    patchItemById(layerId, itemId, edge === 'start' ? { start: time } : { end: time });
  }, [patchItemById]);

  const handlePatternEdgeDrag = useCallback((layerId: string, itemId: string, edge: 'start' | 'end', time: number) => {
    patchItemById(layerId, itemId, edge === 'start' ? { start: time } : { end: time });
  }, [patchItemById]);

  // Body-drag handlers — move the whole interval by shifting start AND end by
  // the same delta. The lane-row helper already clamps the new start into
  // [0, duration - itemDur] before calling these, so no extra bounds work here.
  const handleLoopMove = useCallback((layerId: string, itemId: string, newStart: number, newEnd: number) => {
    patchItemById(layerId, itemId, { start: newStart, end: newEnd });
  }, [patchItemById]);

  const handleSpanMove = useCallback((layerId: string, itemId: string, newStart: number, newEnd: number) => {
    patchItemById(layerId, itemId, { start: newStart, end: newEnd });
  }, [patchItemById]);

  const handlePatternMove = useCallback((layerId: string, itemId: string, newStart: number, newEnd: number) => {
    patchItemById(layerId, itemId, { start: newStart, end: newEnd });
  }, [patchItemById]);

  // Eye ghost-marker drag. The panel routes its own undo via the coalesceKey
  // inside setPointTimeAt so a continuous drag is one undo entry — no need
  // for a separate snapshot here.
  const handleEyeMarkerDrag = useCallback((idx: number, time: number) => {
    eyeSetPointTimeRef.current?.(idx, time);
  }, []);

  // ── Unified-sidebar per-row mutation handlers ─────────────────────────────
  // Wire the X delete + critical star toggle that UnifiedAnnotationListPanel
  // renders on every editable row. Dispatch by (layerId, sectionType):
  //   - boundaries:Manual → reuse handleManualSectionDelete / setSectionsRef
  //     so the manual-undo snapshot is recorded (matches the rich editor).
  //   - cues/spans/loops/patterns user layers → mutate cueLayersDoc; its
  //     useUndoableState owns the undo stack, so ⌘Z still works.
  // Read-only layers don't reach these handlers — the panel hides the
  // buttons when layer.readOnly is true.
  const handleUnifiedItemDelete = useCallback((
    layerId: string,
    itemId: string,
    sectionType: AnnotationType,
  ) => {
    if (sectionType === 'boundaries' && layerId === 'boundaries:Manual') {
      const m = itemId.match(/^Manual:idx(\d+)$/);
      if (!m) return;
      handleManualSectionDelete(Number(m[1]));
      return;
    }
    setCueLayersDoc((d) => d && ({
      ...d,
      layers: d.layers.map((l) =>
        l.id === layerId
          ? { ...l, items: (l.items as readonly { id: string }[]).filter((it) => it.id !== itemId) } as typeof l
          : l,
      ),
    }));
  }, [handleManualSectionDelete, setCueLayersDoc]);

  const handleUnifiedItemToggleImportance = useCallback((
    layerId: string,
    itemId: string,
    sectionType: AnnotationType,
  ) => {
    if (sectionType === 'boundaries' && layerId === 'boundaries:Manual') {
      const m = itemId.match(/^Manual:idx(\d+)$/);
      if (!m) return;
      const idx = Number(m[1]);
      const current = manualAnnotationRef.current;
      if (!current || !setSectionsRef.current) return;
      const s = current.sections[idx];
      if (!s) return;
      pushManualSnapshot();
      const nextImp = s.importance === 'optional' ? 'critical' : 'optional';
      const sections = current.sections.map((sec, i) =>
        i === idx ? { ...sec, importance: nextImp as typeof sec.importance } : sec,
      );
      setSectionsRef.current(sections);
      return;
    }
    setCueLayersDoc((d) => d && ({
      ...d,
      layers: d.layers.map((l) => {
        if (l.id !== layerId) return l;
        return {
          ...l,
          items: (l.items as readonly { id: string; importance?: 'critical' | 'optional' }[]).map((it) =>
            it.id === itemId
              ? { ...it, importance: it.importance === 'optional' ? 'critical' : 'optional' }
              : it,
          ),
        } as typeof l;
      }),
    }));
  }, [pushManualSnapshot, setCueLayersDoc]);

  // ── Unified sidebar: click-a-layer → switch tab + aim ADD+ at it ─────────
  // The unified list shows every annotation type's layers in one place; the
  // user wants clicking a card to act as "make this the current layer" so
  // the tab above flips and the ADD+ panel below it adds new items to that
  // specific layer. Two pieces wire this:
  //   1. `selectedLayerIdByType` — the id of whichever UnifiedLayer is the
  //      active target per section, used by the panel to render the "active"
  //      accent. For boundaries, only one layer per source can exist so we
  //      synthesize the id from `activeSourceByType.boundaries`. For the
  //      multi-layer types, a `detector:<name>` source pins the active
  //      layer to its synthesized detector layer id; otherwise it's the
  //      user's currently-selected user layer id.
  //   2. `handleUnifiedSelectLayer` — runs the actual switch: tab + source
  //      + (for user layers) the per-type `selectedXxxLayerId` so ADD+'s
  //      layer picker reflects the new target.
  const selectedLayerIdByType = useMemo<Partial<Record<AnnotationType, string | null>>>(() => {
    const boundarySrc = activeSourceByType.boundaries;
    const boundaryId: string | null =
      boundarySrc === 'manual'    ? 'boundaries:Manual'
      : boundarySrc === 'eye'       ? 'boundaries:Eye'
      : boundarySrc === 'autoGuess' ? 'boundaries:autoGuess'
      : boundarySrc.startsWith('detector:')
        ? `boundaries:${boundarySrc}`
        : null;
    const pickLayerId = (
      type: 'cues' | 'spans' | 'loops' | 'patterns',
      userLayerId: string | null,
      detectorPrefix: string,
    ): string | null => {
      const src = activeSourceByType[type];
      if (src.startsWith('detector:')) {
        return `${detectorPrefix}:${src.slice('detector:'.length)}`;
      }
      return userLayerId;
    };
    return {
      boundaries: boundaryId,
      cues:     pickLayerId('cues',     selectedCueLayerId,     'detector-cue'),
      spans:    pickLayerId('spans',    selectedSpanLayerId,    'detector-span'),
      loops:    pickLayerId('loops',    selectedLoopLayerId,    'detector-loop'),
      patterns: pickLayerId('patterns', selectedPatternLayerId, 'detector-pattern'),
    };
  }, [activeSourceByType, selectedCueLayerId, selectedSpanLayerId, selectedLoopLayerId, selectedPatternLayerId]);

  const handleUnifiedSelectLayer = useCallback((
    type: AnnotationType,
    selection: UnifiedLayerSelection,
  ) => {
    setActiveAnnotationType(type);
    setActiveSourceByType((prev) => ({ ...prev, [type]: selection.sourceId }));
    // For multi-layer types, pin the ADD+ panel's layer picker to the chosen
    // user layer. Detector layers are read-only and don't appear in the
    // picker's options, so we leave the per-type selectedXxxLayerId alone in
    // that case (the source switch above is what surfaces the detector view).
    if (selection.sourceId === 'manual') {
      if (type === 'cues')          setSelectedCueLayerId(selection.id);
      else if (type === 'spans')    setSelectedSpanLayerId(selection.id);
      else if (type === 'loops')    setSelectedLoopLayerId(selection.id);
      else if (type === 'patterns') setSelectedPatternLayerId(selection.id);
    }
    // Mirror TabGroup's onChange: drop the violet pending pill when the new
    // (type, source) pair can't consume it.
    const boundarySource = isBoundarySource(selection.sourceId) ? selection.sourceId : undefined;
    if (!supportsPending(type, boundarySource)) {
      setPendingAnnotationSelection(null);
    }
  }, []);

  // ── Keyboard-driven cue helpers ───────────────────────────────────────────
  // All read latest state via refs so they can be bound once into the shortcut config.

  // Look up the controller for whichever annotation tab is active. Shortcut
  // handlers below use this for non-Manual types — Manual keeps its page-level
  // logic because its undo stack lives here, not in the panel.
  const activePanelRef = useCallback((): AnnotationPanelController | null => {
    if (activeAnnotationTypeRef.current === 'boundaries') {
      switch (activeBoundarySourceRef.current) {
        case 'manual':    return manualPanelRef.current;
        case 'eye':       return eyePanelRef.current;
        case 'autoGuess': return autoGuessPanelRef.current;
        default:          return null;
      }
    }
    switch (activeAnnotationTypeRef.current) {
      case 'cues':      return cuesPanelRef.current;
      case 'spans':     return spansPanelRef.current;
      case 'loops':     return loopsPanelRef.current;
      case 'patterns':  return patternsPanelRef.current;
      default:          return null;
    }
  }, []);

  // Mark cue at the playhead. Manual/Eye keep the existing page-level paths so
  // the page-level manualUndoStack (Ctrl+Z) stays consistent; every other type
  // delegates to its panel's `addAtPlayhead`.
  const handleMarkCueAtPlayhead = useCallback(() => {
    const type = activeAnnotationTypeRef.current;
    const source = activeBoundarySourceRef.current;
    if (type === 'boundaries' && source === 'eye') {
      eyeAddPointRef.current?.(playerTimeRef.current);
      return;
    }
    if (type === 'boundaries' && source === 'manual') {
      const current = manualAnnotationRef.current;
      if (!current || !setSectionsRef.current) {
        // No annotation yet — let the panel controller bootstrap one. It
        // already handles the null case via startAnnotatingAtCursor; the
        // page-level undo stack picks up from the next edit.
        activePanelRef()?.addAtPlayhead?.();
        return;
      }
      const t = Math.round(playerTimeRef.current * 1000) / 1000;
      if (current.sections.some((s) => Math.abs(s.time - t) < 0.01)) return;
      pushManualSnapshot();
      const sections = [...current.sections, { time: t, type: 'drop', label: 'Drop' }]
        .sort((a, b) => a.time - b.time);
      setSectionsRef.current(sections);
      return;
    }
    // Cues / Spans / Loops / Patterns route through the panel's controller.
    // Auto-guess has no addAtPlayhead (algorithm-driven) — no-op there.
    activePanelRef()?.addAtPlayhead?.();
  }, [pushManualSnapshot, activePanelRef]);

  // Split: bisect the section the playhead currently sits inside.
  const handleSplitCueAtPlayhead = useCallback(() => {
    if (activeAnnotationTypeRef.current === 'boundaries' && activeBoundarySourceRef.current === 'eye') return;
    const current = manualAnnotationRef.current;
    if (!current || !setSectionsRef.current) return;
    const t = playerTimeRef.current;
    const sections = current.sections;
    let idx = -1;
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].time <= t) idx = i;
      else break;
    }
    if (idx < 0) return;
    const s = sections[idx];
    const end = idx + 1 < sections.length ? sections[idx + 1].time : durationRef.current;
    const mid = Math.round(t * 1000) / 1000;
    if (mid <= s.time || mid >= end) return;
    pushManualSnapshot();
    const next = [...sections];
    next.splice(
      idx, 1,
      { time: s.time, type: s.type, label: `${s.label} A` },
      { time: mid,    type: s.type, label: `${s.label} B` },
    );
    setSectionsRef.current(next);
  }, [pushManualSnapshot]);

  // Delete the cue closest to the playhead, but only if it's within 5s — prevents
  // accidental deletions when the playhead is far from any boundary.
  const handleDeleteNearestCue = useCallback(() => {
    const type = activeAnnotationTypeRef.current;
    const source = activeBoundarySourceRef.current;
    // Auto-guess points are algorithm-generated; users review (✓/✗/@), they
    // don't delete. No-op so accidental Delete presses don't disturb data.
    if (type === 'boundaries' && source === 'autoGuess') return;
    // Eye / Spans / Loops / Patterns delegate to the panel's `deleteFocused`,
    // which knows the per-type item semantics. Same path as Cues' fallback.
    if ((type === 'boundaries' && source === 'eye')
        || type === 'spans' || type === 'loops' || type === 'patterns') {
      activePanelRef()?.deleteFocused?.();
      return;
    }
    if (type === 'cues') {
      // Cues: prefer the focused cue; otherwise the nearest cue across all
      // visible cue layers within the 5s tolerance.
      const doc = cueLayersDocRef.current;
      if (!doc) return;
      const focused = focusedCueRef.current;
      if (focused) {
        const next: AnnotationLayersDocument = {
          ...doc,
          layers: doc.layers.map((l) =>
            l.id === focused.layerId
              ? ({ ...l, items: l.items.filter((it) => it.id !== focused.itemId) } as typeof l)
              : l,
          ),
        };
        setCueLayersDoc(next);
        setFocusedCue(null);
        return;
      }
      const t = playerTimeRef.current;
      let bestLayerId: string | null = null;
      let bestItemId: string | null = null;
      let bestDist = Infinity;
      for (const l of doc.layers) {
        if (l.type !== 'cues' || !l.visible) continue;
        for (const it of l.items) {
          const cueTime = (it as { time: number }).time;
          const d = Math.abs(cueTime - t);
          if (d < bestDist) { bestDist = d; bestLayerId = l.id; bestItemId = it.id; }
        }
      }
      if (!bestLayerId || !bestItemId || bestDist > 5) return;
      const matchLayer = bestLayerId;
      const matchItem = bestItemId;
      setCueLayersDoc({
        ...doc,
        layers: doc.layers.map((l) =>
          l.id === matchLayer
            ? ({ ...l, items: l.items.filter((it) => it.id !== matchItem) } as typeof l)
            : l,
        ),
      });
      return;
    }
    const current = manualAnnotationRef.current;
    if (!current?.sections.length) return;
    const t = playerTimeRef.current;
    let bestIdx = 0;
    let bestDist = Math.abs(current.sections[0].time - t);
    for (let i = 1; i < current.sections.length; i++) {
      const d = Math.abs(current.sections[i].time - t);
      if (d < bestDist) { bestIdx = i; bestDist = d; }
    }
    if (bestDist > 5) return;
    handleManualSectionDelete(bestIdx);
  }, [handleManualSectionDelete, activePanelRef]);

  // Collect item start-times for the active layer-type, deduplicated and
  // sorted. Spans/Loops/Patterns navigate by item `start`; Cues by `time`.
  function collectVisibleStartTimes(
    doc: AnnotationLayersDocument | null,
    layerType: 'cues' | 'spans' | 'loops' | 'patterns',
  ): number[] {
    if (!doc) return [];
    const times: number[] = [];
    for (const l of doc.layers) {
      if (l.type !== layerType || !l.visible) continue;
      for (const it of l.items) {
        const t = layerType === 'cues'
          ? (it as { time: number }).time
          : (it as { start: number }).start;
        times.push(t);
      }
    }
    times.sort((a, b) => a - b);
    return times;
  }

  // Pick the right sorted list of times to navigate based on the active type.
  // Manual + Eye sections, Auto-guess points, or layer-type items.
  function collectNavTimes(): number[] {
    const type = activeAnnotationTypeRef.current;
    const source = activeBoundarySourceRef.current;
    if (type === 'boundaries' && source === 'manual') {
      return (manualAnnotationRef.current?.sections ?? []).map((s) => s.time);
    }
    if (type === 'boundaries' && source === 'eye') {
      return (eyeAnnotationRef.current?.sections ?? []).map((s) => s.time);
    }
    if (type === 'boundaries' && source === 'autoGuess') {
      return (autoGuessAnnotationRef.current?.points ?? []).map((p) => p.time);
    }
    if (type === 'cues' || type === 'spans' || type === 'loops' || type === 'patterns') {
      return collectVisibleStartTimes(cueLayersDocRef.current, type);
    }
    return [];
  }

  const handleJumpToPrevCue = useCallback(() => {
    if (!seekRef.current) return;
    const times = collectNavTimes().slice().sort((a, b) => a - b);
    if (!times.length) return;
    // Tolerance pulls "previous" away from the boundary the playhead is glued to.
    const t = playerTimeRef.current - 0.1;
    let prev: number | null = null;
    for (const ct of times) { if (ct < t) prev = ct; else break; }
    if (prev === null) return;
    seekRef.current(prev);
  }, []);

  const handleJumpToNextCue = useCallback(() => {
    if (!seekRef.current) return;
    const times = collectNavTimes().slice().sort((a, b) => a - b);
    if (!times.length) return;
    const t = playerTimeRef.current + 0.1;
    const next = times.find((ct) => ct > t);
    if (next === undefined) return;
    seekRef.current(next);
  }, []);

  // Seek by a relative number of seconds (clamped to [0, duration]).
  const handleSeekRelative = useCallback((delta: number) => {
    if (!seekRef.current) return;
    const dur = durationRef.current;
    const next = Math.max(0, Math.min(dur || Infinity, playerTimeRef.current + delta));
    seekRef.current(next);
  }, []);

  const handleSeekToStart = useCallback(() => {
    seekRef.current?.(0);
  }, []);

  const handleSeekToEnd = useCallback(() => {
    const dur = durationRef.current;
    if (dur > 0) seekRef.current?.(dur);
  }, []);

  const handleTogglePlay = useCallback(() => {
    if (playerIsPlayingRef.current) pauseRef.current?.();
    else playRef.current?.();
  }, []);

  // Mutual exclusion between the main WaveSurfer player and the loop-preview
  // engine (separate Web Audio source in useLoopPlayback). Without this, both
  // sources play simultaneously when the user starts a loop while the track
  // is already playing, or hits Play after starting a loop preview.
  const playLoopExclusive = useCallback((id: string, start: number, end: number, opts?: { snapZeroCross?: boolean }) => {
    if (playerIsPlayingRef.current) pauseRef.current?.();
    loopPlayback.play(id, start, end, opts);
  }, [loopPlayback]);
  useEffect(() => {
    if (playerIsPlaying) loopPlayback.stop();
  }, [playerIsPlaying, loopPlayback]);

  // Forward-declared ref so shortcuts can call handleAlignGridToPlayhead even
  // though the handler itself is defined further down (after songInfo state).
  // Wired by an effect right next to the handler.
  const alignGridToPlayheadRef = useRef<(() => void) | null>(null);
  // Same pattern for handleDeleteAnchor — the Delete/Backspace shortcut would
  // hit a TDZ on the dep-array reference if we depended on the callback directly.
  const deleteAnchorRef = useRef<((index: number) => void) | null>(null);

  // Refs that mirror loop state for the L hotkey — using refs keeps the
  // shortcut useMemo from re-running on every focusedLoop / playback change.
  // Loop layers are read off `cueLayersDocRef.current` (already mirrored above).
  const focusedLoopRef = useRef<{ layerId: string; itemId: string } | null>(null);
  const loopPlaybackRef = useRef<typeof loopPlayback | null>(null);
  useEffect(() => { focusedLoopRef.current = focusedLoop; }, [focusedLoop]);
  useEffect(() => { loopPlaybackRef.current = loopPlayback; }, [loopPlayback]);

  // ── Mark In / Mark Out (two-step ADD for Spans / Loops / Patterns) ───────
  // Shared between the toolbar buttons and the I / O hotkeys. Mark In stashes
  // the playhead as a single-point pending selection (the viz already renders
  // it as a flag). Mark Out reads that stash, asks the active panel to commit
  // a fresh item with [stashed, currentPlayhead], and clears the stash. The
  // zoom level is left untouched — the new item draws on the layer + viz at
  // the user's current viewport. Mark Out is a no-op when there is no Mark In
  // stash — the toolbar / hotkey disabled state advertises that to the user.
  const handleMarkIn = useCallback(() => {
    const t = playerTimeRef.current;
    setPendingAnnotationSelection({ t1: t, t2: null });
  }, []);

  const handleMarkOut = useCallback(() => {
    const pending = pendingAnnotationSelectionRef.current;
    if (!pending || pending.t2 !== null) return;
    const start = pending.t1;
    const end = playerTimeRef.current;
    activePanelRef()?.commitItemRange?.(start, end);
    setPendingAnnotationSelection(null);
  }, [activePanelRef]);

  // Whether Mark Out is currently meaningful — drives both the button's
  // enabled state and the I / O hotkey gating. True when a Mark In has been
  // stashed (pending has t1 only, no t2) on a layer-typed tab.
  const canMarkOutNow = pendingAnnotationSelection !== null
    && pendingAnnotationSelection.t2 === null
    && (activeAnnotationType === 'spans'
      || activeAnnotationType === 'loops'
      || activeAnnotationType === 'patterns');

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  // Single source of truth: this config drives both the global keydown handler
  // (`useAnnotationShortcuts`) AND the help panel UI. Adding a shortcut here
  // automatically lists it in the help drawer.
  // Seek deltas are user-configurable in Settings → Display & playback.
  const seekSmall  = Math.max(0.1, Number(settings.seekStepSmallSeconds)  || 1);
  const seekMedium = Math.max(0.1, Number(settings.seekStepMediumSeconds) || 5);
  const seekLarge  = Math.max(0.1, Number(settings.seekStepLargeSeconds)  || 10);
  // Annotation-type chips the editor currently exposes, in display order.
  // Number keys 1-N below jump straight to the matching chip; loops/patterns
  // only appear when the experimental flag is on.
  const visibleAnnotationTypes = useMemo<AnnotationType[]>(
    () => TAB_CONFIG
      .filter((t) => t.experimental !== 'loopsAndPatterns' || settings.experimentalLoopsAndPatterns)
      .map((t) => t.id),
    [settings.experimentalLoopsAndPatterns],
  );
  const selectAnnotationTypeChip = useCallback((type: AnnotationType) => {
    setActiveAnnotationType(type);
    // Mirror the chip's onSelectType: drop the pending pill when the new type
    // can't consume it.
    if (!supportsPending(type, activeBoundarySourceRef.current ?? undefined)) {
      setPendingAnnotationSelection(null);
    }
  }, []);
  const shortcuts = useMemo<ShortcutDef[]>(() => [
    // Playback
    {
      group: 'Playback',
      display: 'Space',
      description: 'Play / pause',
      match: (e) => e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { e.preventDefault(); handleTogglePlay(); },
    },
    {
      group: 'Playback',
      display: '→',
      description: `Skip forward ${seekSmall}s`,
      match: (e) => e.key === 'ArrowRight' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { e.preventDefault(); handleSeekRelative(seekSmall); },
    },
    {
      group: 'Playback',
      display: '←',
      description: `Skip back ${seekSmall}s`,
      match: (e) => e.key === 'ArrowLeft' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { e.preventDefault(); handleSeekRelative(-seekSmall); },
    },
    {
      group: 'Playback',
      display: 'Shift + →',
      description: `Skip forward ${seekMedium}s`,
      match: (e) => e.key === 'ArrowRight' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { e.preventDefault(); handleSeekRelative(seekMedium); },
    },
    {
      group: 'Playback',
      display: 'Shift + ←',
      description: `Skip back ${seekMedium}s`,
      match: (e) => e.key === 'ArrowLeft' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { e.preventDefault(); handleSeekRelative(-seekMedium); },
    },
    {
      group: 'Playback',
      display: 'Alt + →',
      description: `Skip forward ${seekLarge}s`,
      match: (e) => e.key === 'ArrowRight' && e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey,
      run:   (e) => { e.preventDefault(); handleSeekRelative(seekLarge); },
    },
    {
      group: 'Playback',
      display: 'Alt + ←',
      description: `Skip back ${seekLarge}s`,
      match: (e) => e.key === 'ArrowLeft' && e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey,
      run:   (e) => { e.preventDefault(); handleSeekRelative(-seekLarge); },
    },
    {
      group: 'Playback',
      display: 'Home',
      description: 'Jump to start of song',
      match: (e) => e.key === 'Home' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { e.preventDefault(); handleSeekToStart(); },
    },
    {
      group: 'Playback',
      display: 'End',
      description: 'Jump to end of song',
      match: (e) => e.key === 'End' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { e.preventDefault(); handleSeekToEnd(); },
    },
    {
      group: 'Playback',
      display: 'L',
      description: 'Play / stop focused loop — or preview 6s window when no loop is focused',
      match: (e) => (e.key === 'l' || e.key === 'L') && !e.ctrlKey && !e.metaKey && !e.altKey,
      run: (e) => {
        const dur = durationRef.current;
        if (dur <= 0) return;
        e.preventDefault();
        // Loop-aware path: when a loop is focused (canvas popover, clicking a
        // loop band, or selecting it in the Loops editor) and the playback
        // engine has its audio buffer, toggle seamless loop playback. Falls
        // back to the generic 6s preview when no loop is focused — keeps the
        // hotkey useful even when the user isn't actively editing loops.
        const fl = focusedLoopRef.current;
        const playback = loopPlaybackRef.current;
        if (fl && playback) {
          const doc = cueLayersDocRef.current;
          const layer = doc?.layers.find(
            (l): l is AnnotationLayer<'loops'> => l.type === 'loops' && l.id === fl.layerId,
          );
          const item = layer?.items.find((i) => i.id === fl.itemId);
          if (item) {
            if (playback.playingId === item.id) playback.stop();
            else playLoopExclusive(item.id, item.start, item.end, { snapZeroCross: item.snapZeroCross ?? true });
            return;
          }
        }
        const t = playerTimeRef.current;
        openPreviewRegionRef.current(Math.max(0, t - 3), Math.min(dur, t + 3));
      },
    },

    // Zoom
    {
      group: 'Zoom',
      display: '+',
      description: 'Zoom in',
      // Match both Shift+= ('+') and bare '=' so US keyboards don't need the modifier.
      match: (e) => (e.key === '+' || e.key === '=') && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { e.preventDefault(); zoomInRef.current?.(); },
    },
    {
      group: 'Zoom',
      display: '−',
      description: 'Zoom out',
      match: (e) => (e.key === '-' || e.key === '_') && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { e.preventDefault(); zoomOutRef.current?.(); },
    },
    {
      group: 'Zoom',
      display: '0',
      description: 'Reset zoom',
      match: (e) => e.key === '0' && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { e.preventDefault(); zoomResetRef.current?.(); },
    },

    // Annotation — context-aware verbs dispatch to whichever tab is active
    // (Manual, Eye, Cues, Spans, Loops, Patterns). Auto-guess is algorithm-driven
    // and ignores most of these.
    {
      group: 'Annotation',
      display: 'M',
      description: 'Mark at playhead (section · point · cue · 1-bar span · '
        + 'quick-add loop · 1-bar pattern depending on active tab)',
      match: (e) => (e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { e.preventDefault(); handleMarkCueAtPlayhead(); },
    },
    {
      group: 'Annotation',
      display: 'S',
      description: 'Split focused item at playhead (Manual sections, Spans, Loops)',
      match: (e) => (e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => {
        e.preventDefault();
        const type = activeAnnotationTypeRef.current;
        const source = activeBoundarySourceRef.current;
        if (type === 'boundaries' && source === 'manual') handleSplitCueAtPlayhead();
        else activePanelRef()?.split?.();
      },
    },
    {
      group: 'Annotation',
      display: 'Delete',
      description: 'Delete focused / nearest item (Manual, Cues, Spans, Loops, Patterns)',
      match: (e) => (e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { e.preventDefault(); handleDeleteNearestCue(); },
    },
    {
      group: 'Annotation',
      display: '[',
      description: 'Jump to previous item (Manual sections, Cues, Spans, Loops, Patterns)',
      match: (e) => e.key === '[' && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { e.preventDefault(); handleJumpToPrevCue(); },
    },
    {
      group: 'Annotation',
      display: ']',
      description: 'Jump to next item (Manual sections, Cues, Spans, Loops, Patterns)',
      match: (e) => e.key === ']' && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { e.preventDefault(); handleJumpToNextCue(); },
    },
    {
      group: 'Annotation',
      display: 'Enter',
      description: 'Confirm the highlighted drag-selection on every tab '
        + '(Manual + Eye boundaries, Cues, Spans, Loops, Patterns) — turns '
        + 'the highlight into one or two new items.',
      match: (e) => e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
        && !!pendingAnnotationSelectionRef.current
        && pendingAnnotationSelectionRef.current.t2 !== null,
      run:   (e) => { e.preventDefault(); activePanelRef()?.confirmPending?.(); },
    },
    // I / O follow the DAW + NLE convention for "In" and "Out" markers, mapped
    // here to the two-step ADD flow: I stashes the playhead as the start of a
    // brand-new item and draws a flag on the viz; O completes the add by
    // committing a fresh span / loop / pattern with [stashed, playhead] and
    // zoom-to-fits the new range. Guarded to Spans / Loops / Patterns since
    // only interval-typed tabs support intervals; Manual / Eye / Cues use
    // point-based shortcuts (M, S) instead. O is gated on having a Mark In
    // stashed — otherwise the keystroke is a no-op (matches the button's
    // disabled state with the "Click Mark In first" hint).
    {
      group: 'Annotation',
      display: 'I',
      description: 'Mark In — stash the playhead as the start of a brand-new Span / Loop / Pattern. Draws a flag on the visualization at the cursor; press O next to commit the new item.',
      match: (e) => (e.key === 'i' || e.key === 'I') && !e.ctrlKey && !e.metaKey && !e.altKey
        && (activeAnnotationTypeRef.current === 'spans'
          || activeAnnotationTypeRef.current === 'loops'
          || activeAnnotationTypeRef.current === 'patterns'),
      run:   (e) => { e.preventDefault(); handleMarkIn(); },
    },
    {
      group: 'Annotation',
      display: 'O',
      description: 'Mark Out — commit a brand-new Span / Loop / Pattern with [Mark In, playhead], then zoom the waveform to fit the new item. No-op until Mark In is stashed.',
      match: (e) => (e.key === 'o' || e.key === 'O') && !e.ctrlKey && !e.metaKey && !e.altKey
        && (activeAnnotationTypeRef.current === 'spans'
          || activeAnnotationTypeRef.current === 'loops'
          || activeAnnotationTypeRef.current === 'patterns'),
      run:   (e) => { e.preventDefault(); handleMarkOut(); },
    },
    {
      group: 'Annotation',
      display: 'Ctrl + Z',
      description: 'Undo last edit. Manual / Eye use their panel undo stack; '
        + 'Cues / Spans / Loops / Patterns share a page-level stack on the layers document.',
      match: (e) => (e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey,
      run:   (e) => {
        e.preventDefault();
        const type = activeAnnotationTypeRef.current;
        const source = activeBoundarySourceRef.current;
        if (type === 'cues' || type === 'spans' || type === 'loops' || type === 'patterns') {
          cueLayersDocCtl.undo();
          return;
        }
        if (type === 'boundaries' && source === 'eye') activePanelRef()?.undo?.();
        else handleManualUndo();
      },
    },
    {
      group: 'Annotation',
      display: 'Shift + Ctrl + Z',
      description: 'Redo last undone edit. Manual / Eye redo is handled by their own panel '
        + 'window listener; this shortcut covers Cues / Spans / Loops / Patterns.',
      match: (e) => (e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey,
      run:   (e) => {
        const type = activeAnnotationTypeRef.current;
        if (type === 'cues' || type === 'spans' || type === 'loops' || type === 'patterns') {
          e.preventDefault();
          cueLayersDocCtl.redo();
        }
        // Manual & Eye: leave it to the panel's own keydown listener so we
        // don't double-fire redo on the same keystroke.
      },
    },

    // Loop-specific (only fire when the Loops tab is active so they don't
    // interfere with text input or page chrome in other modes).
    {
      group: 'Loops',
      display: ',',
      description: 'Halve focused loop length (÷2)',
      match: (e) => activeAnnotationTypeRef.current === 'loops'
        && (e.key === ',' || e.key === '<') && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { e.preventDefault(); loopsPanelRef.current?.halveFocused?.(); },
    },
    {
      group: 'Loops',
      display: '.',
      description: 'Double focused loop length (×2)',
      match: (e) => activeAnnotationTypeRef.current === 'loops'
        && (e.key === '.' || e.key === '>') && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { e.preventDefault(); loopsPanelRef.current?.doubleFocused?.(); },
    },
    {
      group: 'Loops',
      display: 'P',
      description: 'Play / stop focused loop',
      match: (e) => activeAnnotationTypeRef.current === 'loops'
        && (e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { e.preventDefault(); loopsPanelRef.current?.togglePlayFocused?.(); },
    },

    // Layers / Grid — plain G is context-aware:
    //   - in /prep there's no Manual layer to toggle, so it aligns the grid
    //     (matches the Rekordbox-style "set grid start" workflow in the spec).
    //   - elsewhere it toggles the Manual annotation overlay.
    {
      group: feature === 'prep' ? 'Grid' : 'Layers',
      display: 'G',
      description: feature === 'prep' ? 'Align grid to playhead (set bar 1 here)' : 'Toggle Manual layer',
      match: (e) => (e.key === 'g' || e.key === 'G') && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => {
        e.preventDefault();
        if (feature === 'prep') alignGridToPlayheadRef.current?.();
        else setShowManual((v) => !v);
      },
    },
    // Grid — Shift+G aligns the grid in /prep only. Annotation flow is locked,
    // so accidentally bumping the grid mid-session would corrupt timings.
    ...(feature === 'prep' ? [{
      group: 'Grid',
      display: 'Shift + G',
      description: 'Align grid to playhead (set bar 1 here)',
      match: (e: KeyboardEvent) => (e.key === 'G' || (e.key === 'g' && e.shiftKey)) && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e: KeyboardEvent) => { e.preventDefault(); alignGridToPlayheadRef.current?.(); },
    } as ShortcutDef] : []),
    {
      group: 'Layers',
      display: 'A',
      description: 'Toggle Auto-guess layer',
      match: (e) => (e.key === 'a' || e.key === 'A') && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { e.preventDefault(); setShowAutoGuess((v) => !v); },
    },

    // Annotation-type switching — number keys jump straight to each chip
    // (annotate workspace only; loops/patterns appear only when experimental).
    ...(feature === 'annotate' ? visibleAnnotationTypes.map((t, i) => ({
      group: 'Annotation',
      display: String(i + 1),
      description: `Switch to ${TAB_CONFIG.find((c) => c.id === t)?.label ?? t}`,
      match: (e: KeyboardEvent) => e.key === String(i + 1)
        && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey,
      run: (e: KeyboardEvent) => { e.preventDefault(); selectAnnotationTypeChip(t); },
    } as ShortcutDef)) : []),

    // Selection
    {
      group: 'Selection',
      display: 'Esc',
      description: 'Dismiss preview region',
      match: (e) => e.key === 'Escape' && !!previewRegionRef.current,
      run:   (e) => { e.preventDefault(); handlePreviewDismissRef.current(); },
    },

    // /prep-only anchor + metronome shortcuts. Gated on feature === 'prep'
    // inside each match() so they don't leak into the annotation workspace.
    ...(feature === 'prep' ? [
      {
        group: 'Grid',
        display: '[',
        description: 'Jump to previous tempo anchor',
        match: (e: KeyboardEvent) => e.key === '[' && !e.ctrlKey && !e.metaKey && !e.altKey,
        run:   (e: KeyboardEvent) => {
          e.preventDefault();
          const anchors = effectiveAnchors(songInfoRef.current) ?? [];
          if (anchors.length === 0) return;
          const t = playerTimeRef.current;
          const sorted = [...anchors].sort((a, b) => a.timestamp - b.timestamp);
          const prev = sorted.filter((a) => a.timestamp < t - 0.02).pop();
          if (prev && seekRef.current) seekRef.current(prev.timestamp);
        },
      } as ShortcutDef,
      {
        group: 'Grid',
        display: ']',
        description: 'Jump to next tempo anchor',
        match: (e: KeyboardEvent) => e.key === ']' && !e.ctrlKey && !e.metaKey && !e.altKey,
        run:   (e: KeyboardEvent) => {
          e.preventDefault();
          const anchors = effectiveAnchors(songInfoRef.current) ?? [];
          if (anchors.length === 0) return;
          const t = playerTimeRef.current;
          const sorted = [...anchors].sort((a, b) => a.timestamp - b.timestamp);
          const next = sorted.find((a) => a.timestamp > t + 0.02);
          if (next && seekRef.current) seekRef.current(next.timestamp);
        },
      } as ShortcutDef,
      {
        group: 'Grid',
        display: 'Delete',
        description: 'Delete nearest tempo anchor (within 3s of playhead)',
        match: (e: KeyboardEvent) => (e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey && !e.altKey,
        run:   (e: KeyboardEvent) => {
          e.preventDefault();
          const anchors = effectiveAnchors(songInfoRef.current) ?? [];
          if (anchors.length === 0) return;
          const t = playerTimeRef.current;
          let bestIdx = -1, bestDist = Infinity;
          anchors.forEach((a, i) => {
            const d = Math.abs(a.timestamp - t);
            if (d < bestDist) { bestDist = d; bestIdx = i; }
          });
          if (bestIdx >= 0 && bestDist <= 3) deleteAnchorRef.current?.(bestIdx);
        },
      } as ShortcutDef,
      {
        group: 'Metronome',
        display: 'T',
        description: 'Tap tempo (tap along; BPM streams to the song from the 2nd tap)',
        // Guard against `repeat` — holding the key would otherwise flood the
        // reducer with sub-debounce taps and lock the readout at the auto-repeat rate.
        match: (e: KeyboardEvent) => (e.key === 't' || e.key === 'T') && !e.repeat && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey,
        run:   (e: KeyboardEvent) => { e.preventDefault(); metronomeTapRef.current?.(); },
      } as ShortcutDef,
    ] : []),
  ], [handleTogglePlay, handleSeekRelative, handleSeekToStart, handleSeekToEnd, handleMarkCueAtPlayhead, handleSplitCueAtPlayhead, handleDeleteNearestCue, handleJumpToPrevCue, handleJumpToNextCue, handleManualUndo, activePanelRef, feature, cueLayersDocCtl, handleMarkIn, handleMarkOut, seekSmall, seekMedium, seekLarge, visibleAnnotationTypes, selectAnnotationTypeChip]);

  useAnnotationShortcuts({
    shortcuts,
    isHelpOpen: shortcutsOpen,
    onToggleHelp: useCallback(() => setShortcutsOpen((v) => !v), []),
    onCloseHelp: useCallback(() => setShortcutsOpen(false), []),
  });

  // ── Algorithm rows + live auto-guess (needed before updateAutoGuessPoint) ────
  // Combines tool-loaded MSAF/AllIn1/CPD/etc. with cached Ruptures variants so they
  // all flow into VizControlBar overlays + Auto-guess clustering uniformly.
  const annotationRows = useMemo<AlgorithmRow[]>(() => {
    const regular = buildAnnotationRows(toolStates).filter((r) => !SINGLE_INFO_ONLY_IDS.has(r.id));
    const ruptures: AlgorithmRow[] = RUPTURES_METHODS
      .filter((m) => rupturesResults[m.suffix])
      .map((m) => {
        const res = rupturesResults[m.suffix];
        return {
          id: `ruptures-${m.suffix}`,
          label: res.algoName,
          sections: res.sections.map((s) => ({ time: s.time, endTime: s.endTime, label: s.label, type: s.type })),
        };
      });
    // Custom detectors flagged is_algorithm. Only boundary detectors flow into algo rows;
    // 'cue' kinds carry duration semantics that don't map to the boundary-detection canvas.
    // Each detector gets its own palette entry so its sections are immediately
    // distinguishable from neighboring rows (and from MSAF/allin1/CPD groups above).
    const eligibleCustom = customDetectors.filter((d) => d.status === 'ok' && d.is_algorithm && d.output_kind === 'boundary');
    const custom: AlgorithmRow[] = eligibleCustom.flatMap((d, i) => {
      const env = customResults[d.name];
      if (!env || env.fatal) return [];
      const color = CUSTOM_ANNOTATION_PALETTE[i % CUSTOM_ANNOTATION_PALETTE.length];
      return [{
        id: `custom:${d.name}`,
        label: d.label || d.name,
        sections: customEnvelopeToSections(env, duration, color),
      }];
    });
    return [...regular, ...ruptures, ...custom];
  }, [toolStates, rupturesResults, customDetectors, customResults, duration]);

  // Single-value detector outputs surfaced as always-visible toolbar pills:
  // librosa-key's global key and whisper-base's detected language. Whisper still
  // renders its word-level lyrics as a timeline row; only the language is global.
  const singleInfoDetections = useMemo(() => {
    const out: { id: string; label: string; value: string; color: string }[] = [];
    const keySt = toolStates['librosa-key'];
    if (keySt?.status === 'done' && keySt.result?.toolId === 'librosa-key' && keySt.result.result.key) {
      out.push({ id: 'librosa-key', label: 'Key', value: keySt.result.result.key, color: '#2dd4bf' });
    }
    const lyrSt = toolStates['whisper-base'];
    if (lyrSt?.status === 'done' && lyrSt.result?.toolId === 'whisper-base' && lyrSt.result.result.language) {
      out.push({ id: 'whisper-base', label: 'Language', value: lyrSt.result.result.language, color: '#fb7185' });
    }
    return out;
  }, [toolStates]);

  // Detector-name → palette color, shared between the row's section strip and its
  // label below so each custom row is visually self-consistent.
  const customAlgoColors = useMemo(() => {
    const m: Record<string, string> = {};
    customDetectors
      .filter((d) => d.status === 'ok' && d.is_algorithm && d.output_kind === 'boundary')
      .forEach((d, i) => { m[d.name] = CUSTOM_ANNOTATION_PALETTE[i % CUSTOM_ANNOTATION_PALETTE.length]; });
    return m;
  }, [customDetectors]);

  // Resolve a label color for an algo row (mirrors the AlgoInspectStage grouping).
  const algoLabelColor = useCallback((id: string): string => {
    if (id.startsWith('ruptures-')) return rupturesLabelColor(id.slice('ruptures-'.length));
    if (id.startsWith('custom:')) return customAlgoColors[id.slice('custom:'.length)] ?? '#fbbf24';
    return ALGO_LABEL_COLORS[id] ?? '#94a3b8';
  }, [customAlgoColors]);

  const liveAutoGuessPoints = useMemo(
    () => computeLiveClusters(annotationRows, LIVE_CLUSTER_TOLERANCE),
    [annotationRows],
  );

  // ── Custom annotation rows (is_annotation detectors → AutoGuess-style review) ────
  // Each ok+is_annotation detector with a cached run becomes its own canvas row
  // with ✓/✗/@ cards over each predicted boundary, mirroring the AutoGuess panel.
  // Each row gets a distinct color from CUSTOM_ANNOTATION_PALETTE so the strips
  // are visually distinguishable across detectors.
  const customAnnotationRows = useMemo(() => {
    const eligible = customDetectors.filter((d) => d.status === 'ok' && d.is_annotation && d.output_kind === 'boundary');
    return eligible.flatMap((d, paletteIdx) => {
      const env = customResults[d.name];
      if (!env || env.fatal) return [];
      const items = env.items as CustomBoundaryItem[];
      const overrides = customAnnotationOverrides[d.name] ?? {};
      const points: AutoGuessPoint[] = items.map((it, i) => {
        const pointId = `${i}:${it.time_ms}`;
        const original = it.time_ms / 1000;
        const ov = overrides[pointId] ?? {};
        return {
          id: pointId,
          time: ov.time ?? original,
          originalTime: original,
          sources: [{ algorithmId: `custom:${d.name}`, originalTime: original }],
          clusterId: 0,
          clusterSize: 1,
          status: ov.status ?? 'pending',
        };
      });
      const color = CUSTOM_ANNOTATION_PALETTE[paletteIdx % CUSTOM_ANNOTATION_PALETTE.length];
      return [{ rowId: `custom-annotation:${d.name}`, detectorName: d.name, label: d.label || d.name, color, points }];
    });
  }, [customDetectors, customResults, customAnnotationOverrides]);

  // ── Detector-sourced Cue layers (output_kind='cue' + is_annotation=true) ────
  // Each cue-output annotation detector becomes a synthetic AnnotationLayer
  // marked readOnly so the editor / popover disable their controls. These
  // layers are re-derived each render from the detector's cached envelope —
  // they are NOT persisted to /api/annotation-layers (which only holds
  // user-authored layers).
  const detectorCueLayers = useMemo<AnnotationLayer<'cues'>[]>(() => {
    const eligible = customDetectors.filter((d) => d.status === 'ok' && d.is_annotation && d.output_kind === 'cue');
    return eligible.flatMap((d, paletteIdx) => {
      const env = customResults[d.name];
      if (!env || env.fatal) return [];
      const color = CUSTOM_ANNOTATION_PALETTE[paletteIdx % CUSTOM_ANNOTATION_PALETTE.length];
      const items = env.items as Array<{ time_ms: number; label: string | null; description?: string | null; intensity?: number | null; candidates?: number[] | null }>;
      const cueItems: CueItem[] = items.map((it, i) => ({
        id: `${d.name}:${i}:${it.time_ms}`,
        time: it.time_ms / 1000,
        label: it.label ?? '',
        description: it.description ?? undefined,
        candidates: it.candidates && it.candidates.length > 0
          ? it.candidates.map((ms) => ms / 1000)
          : undefined,
      }));
      return [{
        id: `detector-cue:${d.name}`,
        name: d.label || d.name,
        type: 'cues' as const,
        visible: true,
        color,
        snap: 'beat' as const,
        items: cueItems,
        readOnly: true,
        source: `detector:${d.name}` as const,
      }];
    });
  }, [customDetectors, customResults]);

  // ── Detector-sourced Span/Loop/Pattern layers ─────────────────────────────
  // Mirror detectorCueLayers for the remaining annotation kinds so a custom
  // detector that emits spans/loops/patterns surfaces alongside the user's
  // own layers under the Annotations dropdown's matching subgroup. Same
  // readOnly + source: 'detector:<name>' contract.
  const detectorSpanLayers = useMemo<AnnotationLayer<'spans'>[]>(() => {
    const eligible = customDetectors.filter((d) => d.status === 'ok' && d.is_annotation && d.output_kind === 'span');
    return eligible.flatMap((d, paletteIdx) => {
      const env = customResults[d.name];
      if (!env || env.fatal) return [];
      const color = CUSTOM_ANNOTATION_PALETTE[paletteIdx % CUSTOM_ANNOTATION_PALETTE.length];
      const items = env.items as CustomSpanItem[];
      const spanItems: SpanItem[] = items.map((it, i) => ({
        id: `${d.name}:${i}:${it.start_ms}`,
        start: it.start_ms / 1000,
        end: (it.start_ms + it.duration_ms) / 1000,
        label: it.label ?? '',
      }));
      return [{
        id: `detector-span:${d.name}`,
        name: d.label || d.name,
        type: 'spans' as const,
        visible: true,
        color,
        snap: 'beat' as const,
        items: spanItems,
        readOnly: true,
        source: `detector:${d.name}` as const,
      }];
    });
  }, [customDetectors, customResults]);

  const detectorLoopLayers = useMemo<AnnotationLayer<'loops'>[]>(() => {
    const eligible = customDetectors.filter((d) => d.status === 'ok' && d.is_annotation && d.output_kind === 'loop');
    return eligible.flatMap((d, paletteIdx) => {
      const env = customResults[d.name];
      if (!env || env.fatal) return [];
      const color = CUSTOM_ANNOTATION_PALETTE[paletteIdx % CUSTOM_ANNOTATION_PALETTE.length];
      const items = env.items as CustomLoopItem[];
      const loopItems: LoopItem[] = items.map((it, i) => ({
        id: `${d.name}:${i}:${it.start_ms}`,
        start: it.start_ms / 1000,
        end: (it.start_ms + it.duration_ms) / 1000,
        label: it.label ?? '',
        snapZeroCross: it.snap_zero_cross ?? undefined,
      }));
      return [{
        id: `detector-loop:${d.name}`,
        name: d.label || d.name,
        type: 'loops' as const,
        visible: true,
        color,
        snap: 'beat' as const,
        items: loopItems,
        readOnly: true,
        source: `detector:${d.name}` as const,
      }];
    });
  }, [customDetectors, customResults]);

  const detectorPatternLayers = useMemo<AnnotationLayer<'patterns'>[]>(() => {
    const eligible = customDetectors.filter((d) => d.status === 'ok' && d.is_annotation && d.output_kind === 'pattern');
    return eligible.flatMap((d, paletteIdx) => {
      const env = customResults[d.name];
      if (!env || env.fatal) return [];
      const color = CUSTOM_ANNOTATION_PALETTE[paletteIdx % CUSTOM_ANNOTATION_PALETTE.length];
      const items = env.items as CustomPatternItem[];
      const patternItems: PatternItem[] = items.map((it, i) => ({
        id: `${d.name}:${i}:${it.start_ms}`,
        start: it.start_ms / 1000,
        end: (it.start_ms + it.duration_ms) / 1000,
        label: it.label ?? '',
        repeatCount: Math.max(1, Math.floor(it.repeat_count ?? 1)),
        highlightedBeats: it.highlighted_beats ?? [],
        subbeatGrid: true,
      }));
      return [{
        id: `detector-pattern:${d.name}`,
        name: d.label || d.name,
        type: 'patterns' as const,
        visible: true,
        color,
        snap: 'beat' as const,
        items: patternItems,
        readOnly: true,
        source: `detector:${d.name}` as const,
      }];
    });
  }, [customDetectors, customResults]);

  // Per-layer accept/reject map for detector cue/span/loop/pattern layers,
  // keyed as `detectorLayerReview[layer.id][item.id]`. The layer's item.id is
  // `${detName}:${index}:${ms}`; the underlying review map is keyed by
  // `${index}:${ms}` (see DetectorOutputReview.itemKey), so stripping the
  // leading `${detName}:` from the item id yields the review key.
  const detectorLayerReview = useMemo<Record<string, Record<string, DetectorReviewStatus>>>(() => {
    const out: Record<string, Record<string, DetectorReviewStatus>> = {};
    const wire = (layers: AnnotationLayer[]) => {
      for (const l of layers) {
        const src = l.source;
        if (!src || !src.startsWith('detector:')) continue;
        const detName = src.slice('detector:'.length);
        const review = detectorOutputDocs[detName]?.review;
        // Detector layers are review-only, so every row enters review mode from
        // the start — an empty map means "all items pending", which still turns
        // on the inline ✓/✗ controls. (A missing entry would leave the row with
        // no controls until a decision was first seeded from the side panel.)
        const m: Record<string, DetectorReviewStatus> = {};
        if (review) {
          for (const it of l.items as Array<{ id: string }>) {
            const colonIdx = it.id.indexOf(':');
            if (colonIdx < 0) continue;
            const reviewKey = it.id.slice(colonIdx + 1);
            const status = review[reviewKey];
            if (status) m[it.id] = status;
          }
        }
        out[l.id] = m;
      }
    };
    wire(detectorCueLayers);
    wire(detectorSpanLayers);
    wire(detectorLoopLayers);
    wire(detectorPatternLayers);
    return out;
  }, [detectorCueLayers, detectorSpanLayers, detectorLoopLayers, detectorPatternLayers, detectorOutputDocs]);

  // Translate a (layerId, itemId) click on a detector layer back to the
  // (detectorName, reviewKey) pair that applyDetectorReview expects. layer.id
  // looks like `detector-{cue|span|loop|pattern}:${detName}`.
  const handleDetectorLayerReview = useCallback((
    layerId: string,
    itemId: string,
    status: DetectorReviewStatus,
  ) => {
    const match = layerId.match(/^detector-(?:cue|span|loop|pattern):(.+)$/);
    if (!match) return;
    const detName = match[1];
    const colonIdx = itemId.indexOf(':');
    if (colonIdx < 0) return;
    const reviewKey = itemId.slice(colonIdx + 1);
    void applyDetectorReview(detName, reviewKey, status);
  }, [applyDetectorReview]);

  // Which custom-annotation rows are currently hidden in the Annotations
  // dropdown. Custom detectors are hidden by default — a sync effect below
  // pre-adds every newly discovered detectorName so it stays off the canvas
  // until the user opts in by checking it in the dropdown.
  const [hiddenCustomAnnotations, setHiddenCustomAnnotations] = useState<Set<string>>(() => new Set());
  const toggleCustomAnnotationVisible = useCallback((detectorName: string) => {
    setHiddenCustomAnnotations((prev) => {
      const next = new Set(prev);
      if (next.has(detectorName)) next.delete(detectorName);
      else next.add(detectorName);
      return next;
    });
  }, []);

  const updateCustomAnnotationOverride = useCallback((
    detectorName: string,
    pointId: string,
    patch: CustomAnnotationOverride,
  ) => {
    const slug = selectedAudioRef.current?.id;
    if (!slug) return;
    setCustomAnnotationOverrides((prev) => {
      const det = { ...(prev[detectorName] ?? {}) };
      det[pointId] = { ...(det[pointId] ?? {}), ...patch };
      const next = { ...prev, [detectorName]: det };
      // Debounced save — coalesce a quick burst of clicks into one HTTP write per detector.
      const existing = customAnnotationSaveTimers.current[detectorName];
      if (existing) clearTimeout(existing);
      customAnnotationSaveTimers.current[detectorName] = setTimeout(() => {
        saveCustomAnnotation(detectorName, slug, { overrides: det }).catch(() => {});
      }, 800);
      return next;
    });
  }, []);

  // ── Auto-guess update ─────────────────────────────────────────────────────
  const saveAutoGuessTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref keeps liveAutoGuessPoints accessible inside updateAutoGuessPoint without
  // requiring it as a dep (avoiding declaration-order issues).
  const liveAutoGuessPointsRef = useRef<AutoGuessPoint[]>([]);
  const updateAutoGuessPoint = useCallback((id: string, patch: Partial<AutoGuessPoint>) => {
    const fallbackPoints = liveAutoGuessPointsRef.current;
    setAutoGuessAnnotation((prev) => {
      const now = new Date().toISOString();
      const basePoints = prev?.points ?? fallbackPoints;
      if (!basePoints.length) return prev;
      const next: AutoGuessManualAnnotation = {
        song: prev?.song ?? selectedAudio?.id ?? '',
        created_at: prev?.created_at ?? now,
        updated_at: now,
        clusterTolerance: prev?.clusterTolerance ?? LIVE_CLUSTER_TOLERANCE,
        points: basePoints.map((p) => p.id === id ? { ...p, ...patch } : p),
      };
      if (saveAutoGuessTimer.current) clearTimeout(saveAutoGuessTimer.current);
      saveAutoGuessTimer.current = setTimeout(() => {
        if (selectedAudio) saveAutoGuessAnnotation(selectedAudio.id, next);
      }, 800);
      return next;
    });
  }, [selectedAudio, liveAutoGuessPoints]);

  // ── BPM detection — flatten algorithm results into suggestion chips ──────
  const suggestedBpms = useMemo(() => {
    const out: { source: string; bpm: number; strength?: number }[] = [];
    // Client-side chip first so it sits at the front of the row — it's
    // typically the fastest one to land.
    if (clientBpm && Number.isFinite(clientBpm.bpm) && clientBpm.bpm > 0) {
      out.push({ source: 'client-wabd', bpm: clientBpm.bpm });
    }
    if (bpmDetection) {
      for (const a of bpmDetection.algorithms) {
        if (!a.ok || a.bpm == null || !Number.isFinite(a.bpm)) continue;
        out.push({ source: a.source, bpm: a.bpm });
        // madmom-tempo also exposes alternate candidates; surface the next two
        // so the user can pick e.g. half-time / double-time directly.
        if (a.candidates && a.candidates.length > 1) {
          for (const c of a.candidates.slice(1, 3)) {
            if (Number.isFinite(c.bpm)) {
              out.push({ source: `${a.source} alt`, bpm: c.bpm, strength: c.strength });
            }
          }
        }
      }
    }
    // BeatNet appears at the end so its chip is visually distinct from the
    // 5 always-on detectors. The meter and downbeats live on the result
    // but aren't surfaced here — that lands when the song-meta panel grows
    // a meter field in a later phase.
    if (settings.experimentalCueExtras && beatnetDetection?.result?.ok && beatnetDetection.result.bpm != null && Number.isFinite(beatnetDetection.result.bpm)) {
      out.push({ source: 'beatnet', bpm: beatnetDetection.result.bpm });
    }
    return out;
  }, [bpmDetection, clientBpm, beatnetDetection, settings.experimentalCueExtras]);

  // Run the client-side detector when an audioBuffer becomes available.
  // Reset on song change so the chip clears between selections.
  useEffect(() => {
    if (!audioBuffer) { setClientBpm(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const { detectInitialBpm } = await import('../services/clientBpmDetection');
        const res = await detectInitialBpm(audioBuffer);
        if (cancelled || !res.ok || res.bpm == null) return;
        setClientBpm({ bpm: res.bpm, ms: res.ms ?? 0 });
      } catch {
        if (!cancelled) setClientBpm(null);
      }
    })();
    return () => { cancelled = true; };
  }, [audioBuffer]);

  const handleRerunBpmDetection = useCallback(() => {
    const audio = selectedAudioRef.current;
    if (!audio) return;
    setBpmDetectionStatus('running');
    setBpmDetectionError(undefined);
    runBpmDetection(audio.id, true).then((result) => {
      if (selectedAudioRef.current?.id !== audio.id) return;
      if (result) {
        setBpmDetection(result);
        setBpmDetectionStatus('done');
      } else {
        setBpmDetectionStatus('error');
        setBpmDetectionError('BPM server unreachable — start with: python tools/python/bpm_server.py');
      }
    });
  }, []);

  // ── Eye mode isolation ────────────────────────────────────────────────────
  const isEyeMode = activeStage === 'annotation'
    && activeAnnotationType === 'boundaries' && activeBoundarySource === 'eye';

  // Pause when entering eye mode
  useEffect(() => {
    if (isEyeMode) pauseRef.current?.();
  }, [isEyeMode]);

  // If the active source is Eye and its experimental flag is off (e.g. user
  // disabled the flag or restored session state from before the flag
  // existed), bounce the source back to Manual so we never render an editor
  // whose source is hidden from the picker. Similarly for the loops/patterns
  // top-level tabs.
  useEffect(() => {
    const eyeGatedOff = activeAnnotationType === 'boundaries'
      && activeBoundarySource === 'eye'
      && !settings.experimentalEyeAnnotation;
    if (eyeGatedOff) {
      setActiveSourceByType((prev) => ({ ...prev, boundaries: 'manual' }));
    }
    const loopsGatedOff = (activeAnnotationType === 'loops' || activeAnnotationType === 'patterns')
      && !settings.experimentalLoopsAndPatterns;
    if (loopsGatedOff) setActiveAnnotationType('boundaries');
  }, [activeAnnotationType, activeBoundarySource, settings.experimentalEyeAnnotation, settings.experimentalLoopsAndPatterns]);

  // Block playback while eye mode is active
  useEffect(() => {
    if (isEyeMode && playerIsPlaying) pauseRef.current?.();
  }, [isEyeMode, playerIsPlaying]);

  // ── Song info change handler (debounced save) ────────────────────────────
  const handleSongInfoChange = useCallback((next: SongInfo) => {
    setSongInfo(next);
    if (!selectedAudio) return;
    // Mirror to the sidebar cache so the readiness indicator updates live.
    setSongInfos((prev) => ({ ...prev, [selectedAudio.id]: next }));
    if (songInfoSaveTimer.current) clearTimeout(songInfoSaveTimer.current);
    songInfoSaveTimer.current = setTimeout(() => {
      saveSongInfo(selectedAudio.id, next);
    }, 500);
  }, [selectedAudio]);

  // Snap gridOffset to the current playhead. Used by the SongInfoBar button
  // and by the Shift+G shortcut. Reads playerTime via ref so it can be bound
  // once into the shortcut config without re-binding on every tick.
  const handleAlignGridToPlayhead = useCallback(() => {
    if (!selectedAudio) return;
    const base = songInfo ?? makeEmptySongInfo(selectedAudio.id);
    const t = Math.max(0, Math.round(playerTimeRef.current * 1000) / 1000);
    handleSongInfoChange({ ...base, gridOffset: t, updated_at: new Date().toISOString() });
  }, [selectedAudio, songInfo, handleSongInfoChange]);
  useEffect(() => { alignGridToPlayheadRef.current = handleAlignGridToPlayhead; }, [handleAlignGridToPlayhead]);

  // Manual-mode beat drag. Writes a sparse override into
  // `SongInfo.beatOverrides[beatIndex]` so the dragged beat pins to its
  // new time without touching the macro tempo. Neighbours stay exactly
  // where the macro grid (bpm + tempoAnchors) put them — no segment-wide
  // BPM rewrite, no butterfly effect.
  //
  // Macro tempo changes go through the triangle anchor flags above the
  // waveform (handleAnchorDrag / handleDeleteAnchor); this handler never
  // touches tempoAnchors.
  const handleBeatDrag = useCallback(async (_tOrig: number, tNew: number, beatIndex: number) => {
    if (!selectedAudio || !songInfo) return;
    if (!Number.isInteger(beatIndex)) return;
    const { updateManualBeatOverride } = await import('../utils/anchorEdit');
    const nextOverrides = updateManualBeatOverride(songInfo, tNew, beatIndex);
    handleSongInfoChange({
      ...songInfo,
      beatOverrides: nextOverrides,
      gridMode: 'manual',
      updated_at: new Date().toISOString(),
    });
  }, [selectedAudio, songInfo, handleSongInfoChange]);

  // Right-click on a pinned beat in the manual grid strip → drop the
  // override so that beat returns to its macro-grid position.
  const handleClearBeatOverride = useCallback(async (beatIndex: number) => {
    if (!selectedAudio || !songInfo) return;
    if (!Number.isInteger(beatIndex)) return;
    if (!songInfo.beatOverrides || songInfo.beatOverrides[String(beatIndex)] === undefined) return;
    const { clearBeatOverride } = await import('../utils/anchorEdit');
    const nextOverrides = clearBeatOverride(songInfo.beatOverrides, beatIndex);
    handleSongInfoChange({
      ...songInfo,
      beatOverrides: nextOverrides,
      updated_at: new Date().toISOString(),
    });
  }, [selectedAudio, songInfo, handleSongInfoChange]);

  // Right-click delete on an anchor flag. Splices the anchor out of
  // SongInfo.tempoAnchors. No confirm — the Reset Grid button is the
  // bulk-clear path; individual deletions are reversible by re-running
  // Dynamic derivation or by hand.
  const handleDeleteAnchor = useCallback((index: number) => {
    if (!selectedAudio || !songInfo) return;
    const current = songInfo.tempoAnchors ?? [];
    if (index < 0 || index >= current.length) return;
    const next = current.filter((_, i) => i !== index);
    handleSongInfoChange({
      ...songInfo,
      tempoAnchors: next,
      updated_at: new Date().toISOString(),
    });
  }, [selectedAudio, songInfo, handleSongInfoChange]);
  useEffect(() => { deleteAnchorRef.current = handleDeleteAnchor; }, [handleDeleteAnchor]);

  // Drag an anchor flag in manual grid mode. Clamps between neighbouring
  // anchors so the timestamp order is preserved (the editor sorts on save,
  // but a mid-drag swap would re-shuffle the index under the user's cursor).
  const handleAnchorDrag = useCallback((index: number, newTime: number) => {
    if (!selectedAudio || !songInfo) return;
    const current = songInfo.tempoAnchors ?? [];
    if (index < 0 || index >= current.length) return;
    const prevT = current[index - 1]?.timestamp ?? 0;
    const nextT = current[index + 1]?.timestamp ?? duration;
    const clamped = Math.max(prevT + 0.05, Math.min(nextT - 0.05, newTime));
    const next = current.map((a, i) => (i === index ? { ...a, timestamp: clamped } : a));
    handleSongInfoChange({
      ...songInfo,
      tempoAnchors: next,
      updated_at: new Date().toISOString(),
    });
  }, [selectedAudio, songInfo, handleSongInfoChange, duration]);

  // Dynamic-mode anchor derivation. Two entry points:
  //   - handleEnterDynamic: fired when the mode pill flips to Dynamic.
  //     Skips when anchors already exist so re-entering doesn't clobber
  //     a tuned baseline.
  //   - handleRederiveDynamic(threshold): fired by the slider's
  //     "Re-derive" button. Always replaces anchors at the given
  //     threshold.
  const deriveDynamicAnchors = useCallback(async (thresholdBpm: number) => {
    if (!selectedAudio) return null;
    const { loadCachedTempoCurve, runTempoCurve } = await import('../services/bpmDetection');
    const { anchorsFromTempoCurve } = await import('../utils/anchorEdit');
    const slug = selectedAudio.id;
    let result = await loadCachedTempoCurve(slug);
    if (!result || !result.curve.ok) {
      result = await runTempoCurve(slug, false);
    }
    if (!result || !result.curve.ok || !result.curve.frame_times || !result.curve.bpms) return null;
    return anchorsFromTempoCurve(
      { frameTimes: result.curve.frame_times, bpms: result.curve.bpms },
      { thresholdBpm, minSpacingSec: 4 },
    );
  }, [selectedAudio]);

  const handleEnterDynamic = useCallback(async () => {
    if (!selectedAudio) return;
    if (songInfo?.tempoAnchors && songInfo.tempoAnchors.length > 0) return;
    const anchors = await deriveDynamicAnchors(5);
    if (!anchors || anchors.length === 0) return;
    const base = songInfo ?? makeEmptySongInfo(selectedAudio.id);
    handleSongInfoChange({ ...base, tempoAnchors: anchors, gridMode: 'dynamic', updated_at: new Date().toISOString() });
  }, [selectedAudio, songInfo, handleSongInfoChange, deriveDynamicAnchors]);

  const handleRederiveDynamic = useCallback(async (thresholdBpm: number) => {
    if (!selectedAudio) return;
    const anchors = await deriveDynamicAnchors(thresholdBpm);
    if (!anchors) return;
    const base = songInfo ?? makeEmptySongInfo(selectedAudio.id);
    handleSongInfoChange({ ...base, tempoAnchors: anchors, gridMode: 'dynamic', updated_at: new Date().toISOString() });
  }, [selectedAudio, songInfo, handleSongInfoChange, deriveDynamicAnchors]);

  // Live-update grid offset during Alt-drag on the waveform. Also goes through
  // handleSongInfoChange so the debounced backend save kicks in once the user stops dragging.
  const handleGridOffsetDrag = useCallback((newOffset: number) => {
    if (!selectedAudio) return;
    const base = songInfo ?? makeEmptySongInfo(selectedAudio.id);
    handleSongInfoChange({
      ...base,
      gridOffset: Math.max(0, newOffset),
      updated_at: new Date().toISOString(),
    });
  }, [selectedAudio, songInfo, handleSongInfoChange]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const bpm        = (songInfo?.bpm ?? 0) > 20 ? songInfo!.bpm : undefined;
  const beatOffset = songInfo?.gridOffset ?? 0;
  const beatsPerBar = beatsPerBarFromTimeSignature(songInfo?.timeSignature);

  const manualSections    = manualAnnotation?.sections ?? [];
  const eyeSections     = eyeAnnotation?.sections ?? [];
  const autoGuessSections = useMemo(() =>
    (autoGuessAnnotation?.points ?? [])
      .filter((p) => p.status !== 'incorrect')
      .sort((a, b) => a.time - b.time)
      .map((p) => ({ time: p.time, type: 'autoGuess', label: 'C' })),
  [autoGuessAnnotation]);

  // Fetch another annotator's annotations as the inspect reference. /all is
  // gated to researcher/admin server-side; on 401/403 we clear the picker and
  // fall back to the user's own annotations rather than show a broken state.
  useEffect(() => {
    if (!selectedAudio || referenceAnnotatorId === null) {
      setExternalRefData(null);
      return;
    }
    const slug = selectedAudio.id;
    const targetId = referenceAnnotatorId;
    let alive = true;
    fetch(`/api/annotations/${encodeURIComponent(slug)}/all`, {
      headers: annotatorHeaders(),
    })
      .then((r) => {
        if (!r.ok) {
          if (r.status === 401 || r.status === 403) {
            if (alive) setReferenceAnnotatorId(null);
          }
          throw new Error(`HTTP ${r.status}`);
        }
        return r.json() as Promise<{
          slug: string;
          manual: Record<string, ManualAnnotation>;
          eye: Record<string, ManualAnnotation>;
          autoGuess: Record<string, AutoGuessManualAnnotation>;
        }>;
      })
      .then((data) => {
        if (!alive) return;
        if (selectedAudioRef.current?.id !== slug) return;
        setExternalRefData({
          manual: data.manual[targetId] ?? null,
          eye: data.eye[targetId] ?? null,
          autoGuess: data.autoGuess[targetId] ?? null,
        });
      })
      .catch(() => { if (alive) setExternalRefData(null); });
    return () => { alive = false; };
  }, [selectedAudio, referenceAnnotatorId]);

  // Effective reference sections — when the algo-inspect picker has chosen
  // another annotator, swap in their data; otherwise use the signed-in user's
  // own annotations. Only takes effect in the inspect feature; annotate and
  // prep always edit the user's own files. The picker is hidden when the
  // inspect canvas isn't visible, but we still gate here so a stale selection
  // never leaks into an unrelated workspace.
  const isInspectFeature = feature === 'inspect-song' || feature === 'inspect-all';
  const useExternalRef = isInspectFeature && referenceAnnotatorId !== null && externalRefData !== null;
  const refManualSections = useExternalRef
    ? (externalRefData!.manual?.sections ?? [])
    : manualSections;
  const refEyeSections = useExternalRef
    ? (externalRefData!.eye?.sections ?? [])
    : eyeSections;
  const refAutoGuessSections = useMemo(() => {
    if (!useExternalRef) return autoGuessSections;
    return (externalRefData!.autoGuess?.points ?? [])
      .filter((p) => p.status !== 'incorrect')
      .sort((a, b) => a.time - b.time)
      .map((p) => ({ time: p.time, type: 'autoGuess', label: 'C' }));
  }, [useExternalRef, externalRefData, autoGuessSections]);

  // Raw points (not mapped to sections) — needed by the canvas overlay in
  // SharedVizPanel which renders the auto-guess cluster points themselves.
  const refAutoGuessPoints = useMemo<AutoGuessPoint[] | null>(() => {
    if (!useExternalRef) return null;
    return externalRefData!.autoGuess?.points ?? [];
  }, [useExternalRef, externalRefData]);

  liveAutoGuessPointsRef.current = liveAutoGuessPoints;


  // Prefer saved annotation; fall back to live-computed clusters
  const baseAutoGuessPoints = autoGuessAnnotation?.points?.length
    ? autoGuessAnnotation.points
    : liveAutoGuessPoints;

  // Apply min-agreement threshold filter for the viz
  const displayAutoGuessPoints = useMemo(
    () => baseAutoGuessPoints.filter((p) => p.clusterSize >= minConsensus),
    [baseAutoGuessPoints, minConsensus],
  );

  // Auto-guess as a read-only algo overlay (centroid-linkage, fully automated)
  const autoGuessAlgoSections = useMemo(() => {
    const sorted = liveAutoGuessPoints
      .filter((p) => p.clusterSize >= minConsensus)
      .sort((a, b) => a.time - b.time);
    return sorted.map((p, i) => ({
      time: p.time,
      endTime: sorted[i + 1]?.time ?? duration,
      label: `×${p.clusterSize}`,
      type: 'autoGuess',
    }));
  }, [liveAutoGuessPoints, minConsensus, duration]);

  const algoOverlays = useMemo(() => {
    const overlays = annotationRows
      .filter((r) => selectedAlgoOverlays.has(r.id))
      .map((r) => ({ id: r.id, label: r.label, labelColor: algoLabelColor(r.id), renderKind: algoRenderKind(r.id), sections: r.sections }));
    if (selectedAlgoOverlays.has('auto-guess-algo') && autoGuessAlgoSections.length) {
      overlays.unshift({ id: 'auto-guess-algo', label: 'Auto-guess', labelColor: '#a78bfa', renderKind: 'boundary', sections: autoGuessAlgoSections });
    }
    return overlays;
  }, [annotationRows, selectedAlgoOverlays, autoGuessAlgoSections, algoLabelColor]);

  const algoOptions = useMemo(() => {
    const options = annotationRows.map((r) => ({ id: r.id, label: r.label }));
    if (liveAutoGuessPoints.length > 0) {
      options.unshift({ id: 'auto-guess-algo', label: 'Auto-guess' });
    }
    return options;
  }, [annotationRows, liveAutoGuessPoints]);

  const toggleAlgoOverlay = useCallback((id: string) => {
    setSelectedAlgoOverlays((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // Keep rowOrder in sync with algoOverlays: insert new algo IDs after the last
  // existing algo row (or after 'spectrogram'), remove deselected ones.
  const prevAlgoIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const currentIds = new Set(algoOverlays.map((o) => o.id));
    const prev = prevAlgoIdsRef.current;
    const added = algoOverlays.filter((o) => !prev.has(o.id));
    const removed = [...prev].filter((id) => !currentIds.has(id));
    prevAlgoIdsRef.current = currentIds;
    if (!added.length && !removed.length) return;
    setRowOrder((order) => {
      let next = order.filter((id) => !removed.includes(id));
      for (const overlay of added) {
        // Insert after the last algo row already in next, else after 'spectrogram'
        let insertAfter = -1;
        next.forEach((id, i) => { if (!DEFAULT_FIXED_ROW_ORDER.includes(id)) insertAfter = i; });
        if (insertAfter < 0) insertAfter = next.indexOf('spectrogram');
        next.splice(insertAfter + 1, 0, overlay.id);
      }
      return next;
    });
  }, [algoOverlays]);

  // Debounced auto-save for the cue-layers document. Skips the just-loaded
  // reference so we don't echo the server response back. Mirrors the implicit
  // save pattern used by ManualEditorPanel for its own annotation.
  useEffect(() => {
    if (!cueLayersDoc || !selectedAudio) return;
    if (cueLayersDoc === cueLayersJustLoadedRef.current) return;
    const slug = selectedAudio.id;
    setLayersDocSaveStatus('saving');
    const t = setTimeout(async () => {
      const ok = await saveLayers(slug, cueLayersDoc);
      setLayersDocSaveStatus(ok ? 'saved' : 'error');
      if (ok) {
        // Keep the sidebar's overall-annotation indicator in sync without
        // re-fetching the whole list. Mirrors the per-type summary the
        // backend LIST endpoint would have returned for this song.
        setSongLayerStatuses((prev) => {
          const layers: SongLayerStatuses['layers'] = {};
          for (const l of cueLayersDoc.layers) {
            if (l.type !== 'cues' && l.type !== 'spans' && l.type !== 'loops' && l.type !== 'patterns' && l.type !== 'lyrics') continue;
            const entry = layers[l.type] ?? { count: 0, status: 'in_progress' as const };
            entry.count += l.items.length;
            layers[l.type] = entry;
          }
          for (const t of Object.keys(layers) as Array<keyof SongLayerStatuses['layers']>) {
            const stage = cueLayersDoc.statusByType?.[t as 'cues' | 'spans' | 'loops' | 'patterns'];
            if (stage) layers[t]!.status = stage;
          }
          const hasAny = Object.keys(layers).length > 0;
          const next = { ...prev };
          if (hasAny) next[slug] = { slug, layers };
          else delete next[slug];
          return next;
        });
      }
      setTimeout(() => setLayersDocSaveStatus((s) => (s === 'saved' ? 'idle' : s)), 2000);
    }, 600);
    return () => clearTimeout(t);
  }, [cueLayersDoc, selectedAudio]);

  // Sync cue-layer rowIds into rowOrder. Mirrors the customAnnotationRows
  // pattern: new layers are inserted just after 'autoGuess'; removed layers
  // are filtered out. Reorder events from drag-handles are preserved.
  // The sync watches BOTH user-created layers and detector-derived cue
  // layers so a freshly-cached detector envelope spawns a row immediately.
  const cueLayers = useMemo(
    () => cueLayersDoc?.layers.filter((l): l is AnnotationLayer<'cues'> => l.type === 'cues'),
    [cueLayersDoc],
  );
  const loopLayers = useMemo(
    () => cueLayersDoc?.layers.filter((l): l is AnnotationLayer<'loops'> => l.type === 'loops') ?? [],
    [cueLayersDoc],
  );
  const spanLayers = useMemo(
    () => cueLayersDoc?.layers.filter((l): l is AnnotationLayer<'spans'> => l.type === 'spans') ?? [],
    [cueLayersDoc],
  );
  const patternLayers = useMemo(
    () => cueLayersDoc?.layers.filter((l): l is AnnotationLayer<'patterns'> => l.type === 'patterns') ?? [],
    [cueLayersDoc],
  );
  const prevCueLayerIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const visible = [
      ...(cueLayers ?? []).map((l) => `cue-layer:${l.id}`),
      ...detectorCueLayers.map((l) => `cue-layer:${l.id}`),
    ];
    const currentIds = new Set(visible);
    const prev = prevCueLayerIdsRef.current;
    const added = visible.filter((id) => !prev.has(id));
    const removed = [...prev].filter((id) => !currentIds.has(id));
    prevCueLayerIdsRef.current = currentIds;
    if (!added.length && !removed.length) return;
    setRowOrder((order) => {
      let next = order.filter((id) => !removed.includes(id));
      for (const id of added) {
        const anchor = next.indexOf('autoGuess');
        const insertAt = anchor >= 0 ? anchor + 1 : 0;
        next.splice(insertAt, 0, id);
      }
      return next;
    });
  }, [cueLayers, detectorCueLayers]);

  // Mirror the row sync for Loop layers — inserted after autoGuess too so
  // the Loops stack appears right under the section rows. Includes detector-
  // sourced loop layers so a freshly-cached envelope spawns a row immediately.
  const prevLoopLayerIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const visible = [
      ...loopLayers.map((l) => `loop-layer:${l.id}`),
      ...detectorLoopLayers.map((l) => `loop-layer:${l.id}`),
    ];
    const currentIds = new Set(visible);
    const prev = prevLoopLayerIdsRef.current;
    const added = visible.filter((id) => !prev.has(id));
    const removed = [...prev].filter((id) => !currentIds.has(id));
    prevLoopLayerIdsRef.current = currentIds;
    if (!added.length && !removed.length) return;
    setRowOrder((order) => {
      let next = order.filter((id) => !removed.includes(id));
      for (const id of added) {
        const anchor = next.indexOf('autoGuess');
        const insertAt = anchor >= 0 ? anchor + 1 : 0;
        next.splice(insertAt, 0, id);
      }
      return next;
    });
  }, [loopLayers, detectorLoopLayers]);

  // Same row sync for Span layers (user + detector-sourced).
  const prevSpanLayerIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const visible = [
      ...spanLayers.map((l) => `span-layer:${l.id}`),
      ...detectorSpanLayers.map((l) => `span-layer:${l.id}`),
    ];
    const currentIds = new Set(visible);
    const prev = prevSpanLayerIdsRef.current;
    const added = visible.filter((id) => !prev.has(id));
    const removed = [...prev].filter((id) => !currentIds.has(id));
    prevSpanLayerIdsRef.current = currentIds;
    if (!added.length && !removed.length) return;
    setRowOrder((order) => {
      let next = order.filter((id) => !removed.includes(id));
      for (const id of added) {
        const anchor = next.indexOf('autoGuess');
        const insertAt = anchor >= 0 ? anchor + 1 : 0;
        next.splice(insertAt, 0, id);
      }
      return next;
    });
  }, [spanLayers, detectorSpanLayers]);

  // Same row sync for Pattern layers (user + detector-sourced).
  const prevPatternLayerIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const visible = [
      ...patternLayers.map((l) => `pattern-layer:${l.id}`),
      ...detectorPatternLayers.map((l) => `pattern-layer:${l.id}`),
    ];
    const currentIds = new Set(visible);
    const prev = prevPatternLayerIdsRef.current;
    const added = visible.filter((id) => !prev.has(id));
    const removed = [...prev].filter((id) => !currentIds.has(id));
    prevPatternLayerIdsRef.current = currentIds;
    if (!added.length && !removed.length) return;
    setRowOrder((order) => {
      let next = order.filter((id) => !removed.includes(id));
      for (const id of added) {
        const anchor = next.indexOf('autoGuess');
        const insertAt = anchor >= 0 ? anchor + 1 : 0;
        next.splice(insertAt, 0, id);
      }
      return next;
    });
  }, [patternLayers, detectorPatternLayers]);


  // Mirror the algoOverlays sync for custom-annotation rows. Each is_annotation
  // detector gets its own row inserted just after 'autoGuess' so review surfaces
  // stay grouped at the top of the canvas. Newly discovered detectors are also
  // pre-hidden so they don't clutter the canvas until the user opts in via the
  // Annotations dropdown.
  const prevCustomAnnotIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const currentIds = new Set(customAnnotationRows.map((r) => r.rowId));
    const prev = prevCustomAnnotIdsRef.current;
    const added = customAnnotationRows.filter((r) => !prev.has(r.rowId));
    const removed = [...prev].filter((id) => !currentIds.has(id));
    prevCustomAnnotIdsRef.current = currentIds;
    if (!added.length && !removed.length) return;
    setRowOrder((order) => {
      let next = order.filter((id) => !removed.includes(id));
      for (const r of added) {
        const anchor = next.indexOf('autoGuess');
        const insertAt = anchor >= 0 ? anchor + 1 : 0;
        next.splice(insertAt, 0, r.rowId);
      }
      return next;
    });
    setHiddenCustomAnnotations((prevHidden) => {
      const removedNames = new Set(
        removed
          .map((rowId) => rowId.startsWith('custom-annotation:') ? rowId.slice('custom-annotation:'.length) : null)
          .filter((n): n is string => !!n),
      );
      const next = new Set(prevHidden);
      for (const name of removedNames) next.delete(name);
      for (const r of added) next.add(r.detectorName);
      return next;
    });
  }, [customAnnotationRows]);

  // Drag-to-reorder: insert dragged row before target's position.
  const handleReorderRow = useCallback((draggedId: VizRowId, targetId: VizRowId) => {
    if (draggedId === targetId) return;
    setRowOrder((prev) => {
      const fromIdx = prev.indexOf(draggedId);
      const toIdx   = prev.indexOf(targetId);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      const insertAt = next.indexOf(targetId);
      next.splice(insertAt, 0, moved);
      return next;
    });
    setHasCustomRowOrder(true);
  }, []);

  const handleResetRowOrder = useCallback(() => {
    setHasCustomRowOrder(false);
    // Recompute default order: fixed rows first, then current algo overlay IDs in their natural order.
    setRowOrder([
      ...DEFAULT_FIXED_ROW_ORDER,
      ...algoOverlays.map((o) => o.id).filter((id) => !DEFAULT_FIXED_ROW_ORDER.includes(id as VizRowId)),
    ]);
  }, [algoOverlays]);

  const handleSectionColorChange = useCallback((type: string, color: string) => {
    setSectionColorOverrides((prev) => ({ ...prev, [type]: color }));
  }, []);

  const handleResetSectionColors = useCallback(() => {
    setSectionColorOverrides({});
  }, []);

  const availableStemSources = useMemo<StemSource[]>(() => {
    const out: StemSource[] = ['mix'];
    if (!stemManifest) return out;
    for (const s of ['vocals', 'drums', 'bass', 'other'] as const) {
      if (stemManifest.stems[s]) out.push(s);
    }
    return out;
  }, [stemManifest]);

  const playerUrl = useMemo<string | null>(() => {
    if (!selectedAudio) return null;
    if (selectedStemSource === 'mix') return selectedAudio.url;
    const stemUrl = stemManifest?.stems[selectedStemSource];
    return stemUrl ?? selectedAudio.url; // fall back to mix if the chosen stem is missing
  }, [selectedAudio, selectedStemSource, stemManifest]);

  // ── Render ────────────────────────────────────────────────────────────────
  const pageBg = FEATURE_THEME[feature].pageBg;
  const accent = accentFor(feature);
  const playerAccent = playerAccentFor(feature);

  // Batch-algorithm options panel. Mounted three times — Dataset Management
  // card (scope='dataset'), under the song title (scope='song'), and inside
  // the Algorithm-Inspect right sidebar. The sidebar passes stacked=true to
  // get one-algorithm-per-row layout (its column is narrow); the wide-panel
  // call sites stay on the multi-per-row grid.
  const renderRunOptionsPanel = (stacked: boolean) => {
    const algoRowsCls = stacked ? 'flex flex-col gap-1' : 'flex flex-wrap gap-x-3 gap-y-1.5';
    // Build a lookup of per-algo failures from the most recent run job, so we
    // can render a red "failed" pill (with the error reason as a tooltip) next
    // to the matching row. Keys are canonical UI ids — same shape the section
    // headers use to compute "missing". Transient across runs.
    const runErrors = new Map<string, string>();
    for (const s of runJob?.sections ?? []) {
      for (const e of s.errors ?? []) runErrors.set(e.id, e.message);
    }
    const renderStatusPill = (id: string, cached: boolean) => {
      // Prefer the transient runJob error (most recent attempt), then fall
      // back to the persistent toolStates error — that's how a "failed" pill
      // survives a page reload when the sidecar wrote an ok=false cache file
      // (e.g. basic-pitch on Python 3.12, JDCNet without weights).
      const error = runErrors.get(id)
        ?? (toolStates[id]?.status === 'error' ? toolStates[id]?.error : undefined);
      if (error) {
        return (
          <span
            className="text-red-400 text-[9px] uppercase tracking-wider cursor-help"
            title={`Failed: ${error}\n\nFull log in the run panel below the song title.`}
          >
            failed
          </span>
        );
      }
      if (cached) {
        return <span className="text-emerald-500/80 text-[9px] uppercase tracking-wider">cached</span>;
      }
      return <span className="text-slate-600 text-[9px] uppercase tracking-wider">missing</span>;
    };
    return (
    <div className={`rounded-md border ${accent.panelBorder} bg-[#14171d]/80 p-3 space-y-3 text-xs`}>
      {/* Demucs model */}
      <div
        className="flex items-center gap-2"
        title={gpuCaps.demucs ? undefined : GPU_TOOLS_UNAVAILABLE_HINT}
      >
        <span className={`text-[10px] uppercase tracking-wider shrink-0 ${gpuCaps.demucs ? 'text-slate-500' : 'text-slate-600'}`}>Demucs model</span>
        <select
          value={demucsModel}
          onChange={(e) => setDemucsModel(e.target.value)}
          disabled={!gpuCaps.demucs}
          className="bg-[#0a0b0d] border border-white/[0.08] text-slate-200 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {DEMUCS_MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <span className="text-slate-600 text-[10px]">(used by All-In-One for stem separation)</span>
        {!gpuCaps.demucs && (
          <span className="text-[9px] uppercase tracking-wider text-amber-400/80 ml-1">Demucs profile needed</span>
        )}
      </div>

      {/* MSAF algorithms */}
      {(() => {
        const ids = ['msaf-sf', 'msaf-foote', 'msaf-cnmf', 'msaf-olda'] as const;
        const missing = ids.filter((id) => toolStates[id]?.status !== 'done');
        const canRunMissing = !!selectedAudio && runJob?.status !== 'running' && missing.length > 0;
        return (
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">MSAF</div>
              <div className="flex items-center gap-1.5 text-[10px]">
                <button
                  disabled={!canRunMissing}
                  onClick={() => handleRunMissingForSection([...missing])}
                  title={!selectedAudio
                    ? 'Select a song first.'
                    : missing.length === 0
                      ? 'Every MSAF algorithm already has a cached result for this song.'
                      : `Run ${missing.length} MSAF algorithm${missing.length === 1 ? '' : 's'} that have no cached result yet for "${selectedAudio.name}".`}
                  className="px-1.5 py-0.5 rounded border border-violet-700/40 bg-violet-900/20 text-violet-200 hover:bg-violet-900/40 transition-colors uppercase tracking-wider disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-violet-900/20"
                >
                  ▶ Run missing{missing.length > 0 ? ` (${missing.length})` : ''}
                </button>
                <span className="text-slate-700">·</span>
                <button
                  onClick={() => setSelectedAlgorithms((prev) => {
                    const next = new Set(prev);
                    ids.forEach((id) => next.add(id));
                    return next;
                  })}
                  className="text-slate-500 hover:text-violet-300 transition-colors uppercase tracking-wider"
                >
                  Select all
                </button>
                <span className="text-slate-700">·</span>
                <button
                  onClick={() => setSelectedAlgorithms((prev) => {
                    const next = new Set(prev);
                    ids.forEach((id) => next.delete(id));
                    return next;
                  })}
                  className="text-slate-500 hover:text-violet-300 transition-colors uppercase tracking-wider"
                >
                  None
                </button>
              </div>
            </div>
            <div className={algoRowsCls}>
              {ids.map((id) => {
                const cached = toolStates[id]?.status === 'done';
                const checked = selectedAlgorithms.has(id);
                const label = id.replace('msaf-', '').toUpperCase();
                return (
                  <label key={id} className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input type="checkbox" checked={checked} onChange={() => toggleAlgorithm(id)}
                      className={accent.checkbox} />
                    <span className={`font-mono ${checked ? 'text-slate-200' : 'text-slate-600'}`}>{label}</span>
                    {renderStatusPill(id, cached)}
                  </label>
                );
              })}
            </div>
          </div>
        );
      })()}

      {(() => {
        const ids = ['allin1', ...[0,1,2,3,4,5,6,7].map((n) => `allin1-fold${n}`)];
        const missing = ids.filter((id) => toolStates[id]?.status !== 'done');
        const canRunMissing = gpuCaps.allin1 && !!selectedAudio && runJob?.status !== 'running' && missing.length > 0;
        return (
          <div title={gpuCaps.allin1 ? undefined : GPU_TOOLS_UNAVAILABLE_HINT}>
            <div className="flex items-center justify-between mb-1.5">
              <div className={`text-[10px] uppercase tracking-wider font-medium ${gpuCaps.allin1 ? 'text-slate-500' : 'text-slate-600'}`}>
                All-In-One
                {!gpuCaps.allin1 && (
                  <span className="ml-2 text-amber-400/80 normal-case tracking-normal">· requires `allin1` (Demucs profile or `pip install -r tools/requirements-allin1.txt`)</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 text-[10px]">
                <button
                  disabled={!canRunMissing}
                  onClick={() => handleRunMissingForSection(missing)}
                  title={!gpuCaps.allin1
                    ? GPU_TOOLS_UNAVAILABLE_HINT
                    : !selectedAudio
                      ? 'Select a song first.'
                      : missing.length === 0
                        ? 'Every All-In-One model already has a cached result for this song.'
                        : `Run ${missing.length} All-In-One model${missing.length === 1 ? '' : 's'} that have no cached result yet for "${selectedAudio.name}".`}
                  className="px-1.5 py-0.5 rounded border border-violet-700/40 bg-violet-900/20 text-violet-200 hover:bg-violet-900/40 transition-colors uppercase tracking-wider disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-violet-900/20"
                >
                  ▶ Run missing{missing.length > 0 ? ` (${missing.length})` : ''}
                </button>
                <span className="text-slate-700">·</span>
                <button
                  disabled={!gpuCaps.allin1}
                  onClick={() => setSelectedAlgorithms((prev) => {
                    const next = new Set(prev);
                    ids.forEach((id) => next.add(id));
                    return next;
                  })}
                  className="text-slate-500 hover:text-violet-300 transition-colors uppercase tracking-wider disabled:opacity-40 disabled:hover:text-slate-500 disabled:cursor-not-allowed"
                >
                  Select all
                </button>
                <span className="text-slate-700">·</span>
                <button
                  disabled={!gpuCaps.allin1}
                  onClick={() => setSelectedAlgorithms((prev) => {
                    const next = new Set(prev);
                    ids.forEach((id) => next.delete(id));
                    return next;
                  })}
                  className="text-slate-500 hover:text-violet-300 transition-colors uppercase tracking-wider disabled:opacity-40 disabled:hover:text-slate-500 disabled:cursor-not-allowed"
                >
                  None
                </button>
              </div>
            </div>
            <div className={algoRowsCls}>
              {ids.map((id) => {
                const cached = toolStates[id]?.status === 'done';
                const checked = selectedAlgorithms.has(id);
                const label = id === 'allin1' ? 'Ensemble' : `fold${id.replace('allin1-fold', '')}`;
                return (
                  <label
                    key={id}
                    className={`flex items-center gap-1.5 select-none ${gpuCaps.allin1 ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
                    title={gpuCaps.allin1 ? undefined : GPU_TOOLS_UNAVAILABLE_HINT}
                  >
                    <input type="checkbox" checked={checked} disabled={!gpuCaps.allin1} onChange={() => toggleAlgorithm(id)}
                      className={`${accent.checkbox} disabled:cursor-not-allowed`} />
                    <span className={`font-mono ${checked ? 'text-slate-200' : 'text-slate-600'}`}>{label}</span>
                    {renderStatusPill(id, cached)}
                  </label>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Ruptures (CPD) — 19 variants from Truong/Oudre/Vayatis */}
      {(() => {
        const missing = RUPTURES_METHODS
          .filter((m) => !rupturesResults[m.suffix])
          .map((m) => `ruptures-${m.suffix}`);
        const canRunMissing = !!selectedAudio && runJob?.status !== 'running' && missing.length > 0;
        return (
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">Ruptures (CPD)</div>
              <div className="flex items-center gap-1.5 text-[10px]">
                <button
                  disabled={!canRunMissing}
                  onClick={() => handleRunMissingForSection(missing)}
                  title={!selectedAudio
                    ? 'Select a song first.'
                    : missing.length === 0
                      ? 'Every Ruptures method already has a cached result for this song.'
                      : `Run ${missing.length} Ruptures method${missing.length === 1 ? '' : 's'} that have no cached result yet for "${selectedAudio.name}".`}
                  className="px-1.5 py-0.5 rounded border border-violet-700/40 bg-violet-900/20 text-violet-200 hover:bg-violet-900/40 transition-colors uppercase tracking-wider disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-violet-900/20"
                >
                  ▶ Run missing{missing.length > 0 ? ` (${missing.length})` : ''}
                </button>
                <span className="text-slate-700">·</span>
                <button
                  onClick={() => setSelectedAlgorithms((prev) => {
                    const next = new Set(prev);
                    RUPTURES_METHODS.forEach((m) => next.add(`ruptures-${m.suffix}`));
                    return next;
                  })}
                  className="text-slate-500 hover:text-violet-300 transition-colors uppercase tracking-wider"
                >
                  Select all
                </button>
                <span className="text-slate-700">·</span>
                <button
                  onClick={() => setSelectedAlgorithms((prev) => {
                    const next = new Set(prev);
                    RUPTURES_METHODS.forEach((m) => next.delete(`ruptures-${m.suffix}`));
                    return next;
                  })}
                  className="text-slate-500 hover:text-violet-300 transition-colors uppercase tracking-wider"
                >
                  None
                </button>
              </div>
            </div>
            <div className={algoRowsCls}>
              {RUPTURES_METHODS.map((m) => {
                const id = `ruptures-${m.suffix}`;
                const cached = !!rupturesResults[m.suffix];
                const checked = selectedAlgorithms.has(id);
                return (
                  <label key={id} className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input type="checkbox" checked={checked} onChange={() => toggleAlgorithm(id)}
                      className={accent.checkbox} />
                    <span className={`font-mono ${checked ? 'text-slate-200' : 'text-slate-600'}`}>{m.search}·{m.model}</span>
                    {renderStatusPill(id, cached)}
                  </label>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Helper: generic "experimental family" sub-section. Same shape across
          SPAN / LOOP / CUE-notes — only the algo IDs, label map, accent color,
          and feature flag differ. Kept inline so closure-captured state
          (selectedAlgorithms, toolStates, toggleAlgorithm, accent) is in scope. */}
      {(() => {
        const renderFamilySection = (
          title: string,
          accentText: string,
          ids: readonly string[],
          labels: Record<string, string>,
        ) => {
          const missing = ids.filter((id) => toolStates[id]?.status !== 'done');
          const canRunMissing = !!selectedAudio && runJob?.status !== 'running' && missing.length > 0;
          return (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <div className={`text-[10px] uppercase tracking-wider ${accentText} font-medium`}>
                  {title} <span className="normal-case tracking-normal text-slate-500">· experimental</span>
                </div>
                <div className="flex items-center gap-1.5 text-[10px]">
                  <button
                    disabled={!canRunMissing}
                    onClick={() => handleRunMissingForSection([...missing])}
                    title={!selectedAudio
                      ? 'Select a song first.'
                      : missing.length === 0
                        ? `Every ${title} model already has a cached result for this song.`
                        : `Run ${missing.length} ${title} model${missing.length === 1 ? '' : 's'} that have no cached result yet for "${selectedAudio.name}".`}
                    className="px-1.5 py-0.5 rounded border border-violet-700/40 bg-violet-900/20 text-violet-200 hover:bg-violet-900/40 transition-colors uppercase tracking-wider disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-violet-900/20"
                  >
                    ▶ Run missing{missing.length > 0 ? ` (${missing.length})` : ''}
                  </button>
                  <span className="text-slate-700">·</span>
                  <button
                    onClick={() => setSelectedAlgorithms((prev) => {
                      const next = new Set(prev);
                      ids.forEach((id) => next.add(id));
                      return next;
                    })}
                    className="text-slate-500 hover:text-violet-300 transition-colors uppercase tracking-wider"
                  >
                    Select all
                  </button>
                  <span className="text-slate-700">·</span>
                  <button
                    onClick={() => setSelectedAlgorithms((prev) => {
                      const next = new Set(prev);
                      ids.forEach((id) => next.delete(id));
                      return next;
                    })}
                    className="text-slate-500 hover:text-violet-300 transition-colors uppercase tracking-wider"
                  >
                    None
                  </button>
                </div>
              </div>
              <div className={algoRowsCls}>
                {ids.map((id) => {
                  const cached = toolStates[id]?.status === 'done';
                  const checked = selectedAlgorithms.has(id);
                  return (
                    <label key={id} className="flex items-center gap-1.5 cursor-pointer select-none">
                      <input type="checkbox" checked={checked} onChange={() => toggleAlgorithm(id)}
                        className={accent.checkbox} />
                      <span className={`font-mono ${checked ? 'text-slate-200' : 'text-slate-600'}`}>{labels[id] ?? id}</span>
                      {renderStatusPill(id, cached)}
                    </label>
                  );
                })}
              </div>
            </div>
          );
        };
        return (
          <>
            {settings.experimentalSpanFamily && expAvail.spanFamily && renderFamilySection(
              'SPAN',
              'text-violet-400/80',
              ['silero-vad', 'jdcnet-voicing', 'panns-cnn14', 'hpss-percussive'],
              {
                'silero-vad': 'Silero-VAD',
                'jdcnet-voicing': 'JDCNet',
                'panns-cnn14': 'PANNs CNN14',
                'hpss-percussive': 'HPSS percussive',
              },
            )}
            {settings.experimentalLoopFamily && expAvail.loopFamily && renderFamilySection(
              'LOOP',
              'text-amber-400/80',
              ['chroma-autocorr'],
              { 'chroma-autocorr': 'Chroma loops' },
            )}
            {settings.experimentalCueExtras && expAvail.cueExtras && renderFamilySection(
              'CUE extras',
              'text-pink-400/80',
              ['basic-pitch', 'librosa-key', 'autochord-chords', 'librosa-onsets'],
              {
                'basic-pitch': 'basic-pitch',
                'librosa-key': 'librosa key',
                'autochord-chords': 'autochord',
                'librosa-onsets': 'librosa onsets',
              },
            )}
            {settings.experimentalLyricsFamily && expAvail.lyricsFamily && renderFamilySection(
              'LYRICS',
              'text-rose-400/80',
              ['whisper-base'],
              { 'whisper-base': 'Whisper-base' },
            )}
            {settings.experimentalLyricsFamily && expAvail.lyricsFamily && selectedAudio && (
              <LyricsTextPanel slug={selectedAudio.id} />
            )}
          </>
        );
      })()}

      {/* Custom detectors flagged is_algorithm. Empty when no detectors are registered
          or when none have is_algorithm=True — toggle the flag on the Playground page. */}
      {(() => {
        const algos = customDetectors.filter((d) => d.is_algorithm && d.status === 'ok');
        if (algos.length === 0) return null;
        // Missing = registered + flagged + no successful cached envelope + not already running.
        // We re-run "fatal" envelopes too: a missing dep that's since been installed should
        // get a fresh shot when the user clicks Run missing.
        const missing = algos.filter((d) => {
          if (customRunning.has(d.name)) return false;
          const env = customResults[d.name];
          return !env || !!env.fatal;
        });
        const canRunMissing = !!selectedAudio && missing.length > 0;
        return (
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">Custom</div>
              <div className="flex items-center gap-1.5 text-[10px]">
                <button
                  disabled={!canRunMissing}
                  onClick={() => {
                    if (!selectedAudio || missing.length === 0) return;
                    runCustomDetectors(selectedAudio.id, missing.map((d) => d.name));
                  }}
                  title={!selectedAudio
                    ? 'Select a song first.'
                    : missing.length === 0
                      ? 'Every custom algorithm already has a cached result for this song.'
                      : `Run ${missing.length} custom detector${missing.length === 1 ? '' : 's'} that have no cached result yet for "${selectedAudio.name}".`}
                  className="px-1.5 py-0.5 rounded border border-amber-700/40 bg-amber-900/20 text-amber-200 hover:bg-amber-900/40 transition-colors uppercase tracking-wider disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-amber-900/20"
                >
                  ▶ Run missing{missing.length > 0 ? ` (${missing.length})` : ''}
                </button>
                <span className="text-slate-700">·</span>
                <button
                  onClick={() => setSelectedAlgorithms((prev) => {
                    const next = new Set(prev);
                    algos.forEach((d) => next.add(`custom:${d.name}`));
                    return next;
                  })}
                  className="text-slate-500 hover:text-amber-300 transition-colors uppercase tracking-wider"
                >
                  Select all
                </button>
                <span className="text-slate-700">·</span>
                <button
                  onClick={() => setSelectedAlgorithms((prev) => {
                    const next = new Set(prev);
                    algos.forEach((d) => next.delete(`custom:${d.name}`));
                    return next;
                  })}
                  className="text-slate-500 hover:text-amber-300 transition-colors uppercase tracking-wider"
                >
                  None
                </button>
              </div>
            </div>
            <div className={algoRowsCls}>
              {algos.map((d) => {
                const id = `custom:${d.name}`;
                const env = customResults[d.name];
                const cached = !!env && !env.fatal;
                const fatalMessage = env?.fatal
                  ? `${env.fatal.type ?? 'error'}: ${env.fatal.message ?? ''}`.trim()
                    + (env.fatal.suggested_install ? `\n\nTry: ${env.fatal.suggested_install}` : '')
                  : null;
                const checked = selectedAlgorithms.has(id);
                const running = customRunning.has(d.name);
                return (
                  <label
                    key={id}
                    className="flex items-center gap-1.5 cursor-pointer select-none"
                    title={d.description || d.label || d.name}
                  >
                    <input type="checkbox" checked={checked} onChange={() => toggleAlgorithm(id)}
                      className={accent.checkbox} />
                    <span className={`font-mono ${checked ? 'text-slate-200' : 'text-slate-600'}`}>{d.label || d.name}</span>
                    {running
                      ? <span className="text-amber-300 text-[9px] uppercase tracking-wider inline-flex items-center gap-1">
                          <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />running
                        </span>
                      : fatalMessage
                        ? <span
                            className="text-red-400 text-[9px] uppercase tracking-wider cursor-help"
                            title={`Failed: ${fatalMessage}`}
                          >
                            failed
                          </span>
                        : cached
                          ? <span className="text-emerald-500/80 text-[9px] uppercase tracking-wider">cached</span>
                          : <span className="text-slate-600 text-[9px] uppercase tracking-wider">missing</span>}
                  </label>
                );
              })}
            </div>
          </div>
        );
      })()}
    </div>
    );
  };

  return (
    <div className={`min-h-screen text-slate-200 transition-colors duration-300 ${pageBg}`}>
      <div className="flex">

        {/* ── Hidden file/folder inputs (Dataset Prep only) ─────────────
             Live outside the collapsible <aside> so any "Upload Songs"
             trigger still works when the sidebar is collapsed. Annotate
             and Algorithm Inspect deliberately have no upload affordance —
             curating the corpus is a Dataset Prep concern. */}
        {mode === 'prep' && (
          <>
            <input
              ref={uploadInputRef}
              type="file"
              accept=".mp3,.wav,.flac,.ogg,.m4a"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = e.target.files ? Array.from(e.target.files) : [];
                if (files.length > 0) void handleUploadFiles(files, { sawNestedFolder: false });
                e.target.value = '';
              }}
            />
            {/* Folder picker — webkitdirectory hands us every file inside the
                chosen folder (recursively). Each File carries a
                webkitRelativePath like "albumA/track1.mp3", so we flag nested
                cases when any audio file lives more than one segment deep. */}
            <input
              ref={folderInputRef}
              type="file"
              // @ts-expect-error — webkitdirectory is not in the React types yet
              webkitdirectory=""
              directory=""
              multiple
              className="hidden"
              onChange={(e) => {
                const files = e.target.files ? Array.from(e.target.files) : [];
                if (files.length === 0) { e.target.value = ''; return; }
                const sawNestedFolder = files.some((f) => {
                  const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
                  return rel.split('/').length > 2;
                });
                void handleUploadFiles(files, { sawNestedFolder });
                e.target.value = '';
              }}
            />
          </>
        )}

        {/* ── Left sidebar — song list (collapsible) ───────────────────── */}
        {(mode === 'song' || mode === 'prep') && sidebarCollapsed && (
          <button
            onClick={() => setSidebarCollapsed(false)}
            title="Show songs"
            className="fixed left-0 top-16 z-30 flex items-center gap-1.5 pl-2.5 pr-3 py-2 rounded-r-lg bg-[#1a1f28]/95 backdrop-blur-sm border border-l-0 border-white/15 text-slate-200 hover:text-white hover:bg-[#222833] hover:border-white/25 hover:pl-3.5 transition-all shadow-lg shadow-black/40"
          >
            <span className="text-[11px] uppercase tracking-[0.18em] font-semibold">Songs</span>
            <span className="text-sm leading-none font-bold">›</span>
          </button>
        )}
        {(mode === 'song' || mode === 'prep') && !sidebarCollapsed && (
          <aside
            ref={sidebarRef}
            style={{ width: sidebarWidth }}
            onDragEnter={(e) => {
              if (mode !== 'prep' || !adminStatus?.isAdmin) return;
              if (!e.dataTransfer?.types?.includes('Files')) return;
              sidebarDragDepthRef.current += 1;
              if (!sidebarDragActive) setSidebarDragActive(true);
            }}
            onDragLeave={() => {
              sidebarDragDepthRef.current = Math.max(0, sidebarDragDepthRef.current - 1);
              if (sidebarDragDepthRef.current === 0 && sidebarDragActive) setSidebarDragActive(false);
            }}
            onDragOver={(e) => {
              if (mode !== 'prep' || !adminStatus?.isAdmin) return;
              if (!e.dataTransfer?.types?.includes('Files')) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }}
            onDrop={async (e) => {
              if (mode !== 'prep' || !adminStatus?.isAdmin) return;
              if (!e.dataTransfer?.types?.includes('Files')) return;
              e.preventDefault();
              sidebarDragDepthRef.current = 0;
              setSidebarDragActive(false);
              if (uploading) return;
              const { files, sawNestedFolder } = await walkDataTransferItems(e.dataTransfer.items);
              void handleUploadFiles(files, { sawNestedFolder });
            }}
            className={`shrink-0 sticky top-16 self-start h-[calc(100vh-4rem)] border-r ${sidebarDragActive ? 'border-emerald-400/50 bg-emerald-500/[0.04]' : 'border-white/[0.10] bg-[#14171d]/80'} backdrop-blur-sm flex flex-col relative transition-colors`}
          >
            <div
              onMouseDown={startSidebarResize}
              onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
              title="Drag to resize · double-click to reset"
              className={`absolute top-0 right-0 h-full w-1.5 -mr-0.5 cursor-col-resize z-20 group ${sidebarResizing ? 'bg-sky-500/40' : 'hover:bg-sky-500/30'} transition-colors`}
            >
              <div className={`absolute top-0 right-0 h-full w-px ${sidebarResizing ? 'bg-sky-400' : 'bg-transparent group-hover:bg-sky-400/60'}`} />
            </div>
            <>
                <div className="flex items-center justify-between px-3 h-9 border-b border-white/[0.05] shrink-0">
                  <span className="text-[13px] uppercase tracking-[0.18em] text-slate-100 font-bold">Songs</span>
                  <button
                    onClick={() => setSidebarCollapsed(true)}
                    title="Hide songs"
                    className="text-slate-500 hover:text-slate-200 transition-colors text-sm leading-none px-1"
                  >
                    ‹
                  </button>
                </div>
                {/* Upload + Full-export controls. Restricted to Dataset Prep
                    so Annotate / Algorithm Inspect cannot mutate the corpus. */}
                {mode === 'prep' && (
                  <div className="px-2 py-1.5 border-b border-white/[0.05] shrink-0 space-y-1">
                    {adminStatus?.isAdmin && (uploading && uploadProgress ? (
                      <div className="w-full px-2 py-1.5">
                        <UploadProgressBar info={uploadProgress} variant="compact" />
                      </div>
                    ) : (
                      <div className="flex items-stretch gap-1">
                        <button
                          onClick={() => uploadInputRef.current?.click()}
                          disabled={uploading}
                          title="Upload one or more audio files. You can also drag a folder onto the sidebar — subfolders will be walked recursively."
                          className="flex-1 px-2 py-1.5 rounded text-[11px] uppercase tracking-wider text-slate-400 hover:text-slate-200 hover:bg-white/[0.04] transition-colors disabled:opacity-40 text-left"
                        >
                          + Upload songs
                        </button>
                        <button
                          onClick={() => folderInputRef.current?.click()}
                          disabled={uploading}
                          title="Pick a folder — every audio file inside (including subfolders) will be uploaded."
                          aria-label="Upload folder"
                          className="px-2 py-1.5 rounded text-[11px] text-slate-500 hover:text-slate-200 hover:bg-white/[0.04] transition-colors disabled:opacity-40"
                        >
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M2 4.5a1 1 0 0 1 1-1h3.2L8 5h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
                          </svg>
                        </button>
                      </div>
                    ))}
                    {/* Bulk import — walks a folder for audio + song-info +
                        annotations + stems and uploads the lot in one shot.
                        Same researcher/admin gate as the per-file upload. */}
                    {adminStatus?.isAdmin && (
                      <button
                        onClick={() => setImportDatasetOpen(true)}
                        disabled={uploading}
                        title="Import a full dataset folder — audio, song-info, annotations, and stems are detected and uploaded together."
                        className="w-full px-2 py-1.5 rounded text-[11px] uppercase tracking-wider text-slate-400 hover:text-emerald-200 hover:bg-emerald-500/10 border border-white/[0.04] hover:border-emerald-500/30 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
                      >
                        <span>⤒</span><span>Import dataset</span>
                      </button>
                    )}
                    {/* Full annotation export — sits next to Upload so the
                        dataset-wide download flow is reachable without having
                        to scroll past the storage-stats footer. Multi-song
                        scope, layer/format chooser, and per-bucket toggles
                        (audio / annotations / algo caches / stems) live in
                        the modal. Available to all team members in prep
                        (not gated on admin). */}
                    <button
                      onClick={() => setExportManagerOpen(true)}
                      disabled={audioFiles.length === 0}
                      title="Open the export manager: pick songs, layers, format, and bundle audio / algo caches / stems alongside annotations."
                      className="w-full px-2 py-1.5 rounded text-[11px] uppercase tracking-wider text-slate-400 hover:text-emerald-200 hover:bg-emerald-500/10 border border-white/[0.04] hover:border-emerald-500/30 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
                    >
                      <span>⤓</span><span>Full annotation export</span>
                    </button>
                  </div>
                )}
                <div className="flex-1 overflow-y-auto py-1">
                  {audioFiles.map((a, idx) => {
                    // The manifest is already corpus-filtered server-side
                    // (team → data/ songs, demo → data-default/ songs), so
                    // the sidebar can render every entry without
                    // client-side filtering. The divider sits at the top so
                    // the section heading still frames the list.
                    const showDivider = idx === 0;
                    const status = songStatuses[a.id];
                    const songInfoForRow = songInfos[a.id];
                    const ready = isGridReady(songInfoForRow);
                    const hasBpm = typeof songInfoForRow?.bpm === 'number' && songInfoForRow.bpm > 0;
                    const isSelected = selectedAudio?.id === a.id;
                    const songStorage = storageStats?.perSong.find((s) => s.slug === a.id);
                    // Per-song annotation tracks aggregated from manual + eye +
                    // auto-guess (built-in tracks, scoped to current annotator)
                    // and user-created layers (cues/spans/loops/patterns). The
                    // sidebar collapses these into ONE overall indicator dot
                    // because every track records the same kind of thing —
                    // boundary / marker positions — so a row of G/E/A pills was
                    // misleading. The full breakdown lives in a click-to-open
                    // popover below.
                    const layerSummary = songLayerStatuses[a.id];
                    type TrackKind = 'manual' | 'eye' | 'autoGuess' | 'cues' | 'spans' | 'loops' | 'patterns';
                    // Tracks are split into two groups: manual (user-authored —
                    // Boundaries, By-eye, Cues/Spans/Loops/Patterns/Lyrics) and
                    // auto (algorithm-produced — Auto-guess + custom detectors).
                    // Only manual tracks gate the green ✓ on the per-song
                    // indicator; auto tracks are listed below a divider in the
                    // popover for reference but don't block "all reviewed".
                    interface Track { kind: TrackKind; label: string; state: AnnotationPillDisplay; detail?: string; color: string; group: 'manual' | 'auto'; }
                    const tracks: Track[] = [];
                    // Manual/Eye/Auto-guess + every layer type share the same
                    // (hasItems × stage) → display rule via `derivePillDisplay`.
                    // A track only appears here once it has at least one item —
                    // the popover never lists "Not started" rows because there
                    // are no real markers behind them, matching the
                    // StatusPill's "Not started ⇔ no items" contract.
                    if (status && (status.sections_count ?? 0) > 0) {
                      tracks.push({
                        kind: 'manual',
                        label: 'Boundaries',
                        state: derivePillDisplay(true, status.reviewed ? 'reviewed' : (status.ready_for_review ? 'ready_for_review' : 'in_progress')),
                        detail: `${status.sections_count} section${status.sections_count === 1 ? '' : 's'}`,
                        color: 'amber',
                        group: 'manual',
                      });
                    }
                    if (settings.experimentalEyeAnnotation && status && (status.eye_sections_count ?? 0) > 0) {
                      tracks.push({
                        kind: 'eye',
                        label: 'By-eye',
                        state: derivePillDisplay(true, status.eye_status === 'done' ? 'reviewed' : 'in_progress'),
                        detail: `${status.eye_sections_count} section${status.eye_sections_count === 1 ? '' : 's'}`,
                        color: 'cyan',
                        group: 'manual',
                      });
                    }
                    if (layerSummary) {
                      const layerColors: Record<string, string> = {
                        cues: 'emerald', spans: 'sky', loops: 'pink', patterns: 'rose', lyrics: 'fuchsia',
                      };
                      const layerLabels: Record<string, string> = {
                        cues: 'Cues', spans: 'Spans', loops: 'Loops', patterns: 'Patterns', lyrics: 'Lyrics',
                      };
                      for (const [type, info] of Object.entries(layerSummary.layers)) {
                        if (!info || info.count === 0) continue;
                        tracks.push({
                          kind: type as TrackKind,
                          label: layerLabels[type] ?? type,
                          state: derivePillDisplay(true, info.status),
                          detail: `${info.count} item${info.count === 1 ? '' : 's'}`,
                          color: layerColors[type] ?? 'slate',
                          group: 'manual',
                        });
                      }
                    }
                    if (status && (status.auto_guess_points_count ?? 0) > 0) {
                      tracks.push({
                        kind: 'autoGuess',
                        label: 'Auto-guess',
                        state: derivePillDisplay(true, status.auto_guess_status === 'done' ? 'reviewed' : 'in_progress'),
                        detail: `${status.auto_guess_points_count} point${status.auto_guess_points_count === 1 ? '' : 's'}`,
                        color: 'violet',
                        group: 'auto',
                      });
                    }
                    const manualTracks = tracks.filter((t) => t.group === 'manual');
                    const autoTracks = tracks.filter((t) => t.group === 'auto');
                    const manualReviewedCount = manualTracks.filter((t) => t.state === 'reviewed').length;
                    const overall: 'none' | 'in_progress' | 'all_reviewed' =
                      manualTracks.length === 0 ? 'none' :
                      manualReviewedCount === manualTracks.length ? 'all_reviewed' :
                      'in_progress';
                    const overallTitle =
                      overall === 'none'
                        ? (autoTracks.length > 0
                            ? 'No manual annotations yet — click to see auto-guess / detectors'
                            : 'No annotations yet — click to see types')
                        : overall === 'all_reviewed'
                          ? `All ${manualTracks.length} manual annotation${manualTracks.length === 1 ? '' : 's'} reviewed — click to see breakdown`
                          : `${manualReviewedCount}/${manualTracks.length} manual reviewed — click to see breakdown`;
                    // Primary indicator: BPM/Grid readiness from /prep. Uses a
                    // quarter-note ♩ glyph so it reads as "tempo" and stays
                    // visually distinct from the right-side ✓/dot annotation
                    // status indicator.
                    //  - emerald ♩ when locked AND bpm set
                    //  - amber ♩ when bpm set but grid not locked yet
                    //  - red ♩ when no bpm (can't even start)
                    const readyTitle = ready
                      ? 'Ready for annotation: BPM and grid are locked.'
                      : hasBpm
                        ? 'BPM set but grid is not locked yet — open Dataset Prep to lock it.'
                        : 'No BPM set — open Dataset Prep to detect or enter one.';
                    const readyColor = ready
                      ? 'text-emerald-400'
                      : hasBpm
                        ? 'text-amber-400 [text-shadow:0_0_6px_rgba(251,191,36,0.55)]'
                        : 'text-red-500/80';
                    const readyDot = (
                      <span
                        title={readyTitle}
                        aria-label={readyTitle}
                        className={`text-sm leading-none shrink-0 select-none ${readyColor}`}
                      >
                        ♩
                      </span>
                    );
                    const rowTitle = songStorage && songStorage.totalBytes > 0
                      ? `${a.name}\n` +
                        `Disk usage: ${formatBytes(songStorage.totalBytes)}\n` +
                        `  Stems         ${formatBytes(songStorage.caches.stems)}\n` +
                        `  Analysis      ${formatBytes(songStorage.caches.analysis)}\n` +
                        `  MSAF raw      ${formatBytes(songStorage.caches.msafRaw)}\n` +
                        `  BPM           ${formatBytes(songStorage.caches.bpm)}\n` +
                        `  Algo clusters ${formatBytes(songStorage.caches.algoClusters)}\n` +
                        `  ─────────────\n` +
                        `  Caches        ${formatBytes(songStorage.cacheBytes)} (clear-able)\n` +
                        `  Annotations   ${formatBytes(songStorage.annotations)}\n` +
                        `  Audio         ${formatBytes(songStorage.audio)}`
                      : a.name;
                    const actionsOpen = actionsOpenSlug === a.id;
                    const activate = () => {
                      // Annotator Tool requires a BPM-locked grid to snap to.
                      // If the row's song has no BPM yet, surface a warning
                      // dialog instead of jumping straight into annotation —
                      // the user can still proceed, but they're told to set
                      // BPM in Dataset Prep first. Re-selecting the same song
                      // (toggling the actions popover) skips the gate.
                      const isReselect = selectedAudio?.id === a.id;
                      if (feature === 'annotate' && !hasBpm && !isReselect) {
                        setBpmWarningSong(a);
                        return;
                      }
                      selectAudio(a);
                      setActionsOpenSlug((prev) => (prev === a.id ? null : a.id));
                    };
                    return (
                      <Fragment key={a.id}>
                        {showDivider && (
                          <div
                            role="separator"
                            aria-label="Your dataset"
                            className="my-2 mx-3 flex items-center gap-2 select-none"
                          >
                            <div className="flex-1 h-px bg-gradient-to-r from-amber-400 via-fuchsia-500 to-cyan-400 shadow-[0_0_8px_rgba(217,70,239,0.45)]" />
                            <span className="text-[9px] uppercase tracking-[0.22em] font-semibold text-slate-400">
                              your songs
                            </span>
                            <div className="flex-1 h-px bg-gradient-to-r from-cyan-400 via-fuchsia-500 to-amber-400 shadow-[0_0_8px_rgba(217,70,239,0.45)]" />
                          </div>
                        )}
                        <div
                          role="button"
                          tabIndex={0}
                          title={rowTitle}
                          onClick={activate}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } }}
                          className={`group relative w-full text-left px-3 py-2 text-sm flex items-center justify-between gap-2 hover:bg-white/[0.04] transition-colors cursor-pointer ${
                            isSelected ? 'text-violet-300 bg-white/[0.03]' : 'text-slate-300'
                          }`}
                        >
                          <span className="flex items-center gap-2 min-w-0">
                            {readyDot}
                            <span className="truncate font-mono">{a.name}</span>
                          </span>
                        <span className="flex items-center gap-1 shrink-0">
                          {mode !== 'prep' && (
                          <span className={`relative flex items-center gap-1 transition-opacity ${actionsOpen ? 'opacity-40' : ''}`}>
                            <button
                              type="button"
                              title={overallTitle}
                              aria-label={overallTitle}
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                setStatusPopoverSlug((prev) => (prev === a.id ? null : a.id));
                                setActionsOpenSlug(null);
                              }}
                              className="flex items-center justify-center h-4 w-4 rounded-full hover:bg-white/10 transition-colors"
                            >
                              {overall === 'all_reviewed' ? (
                                <span className="text-[11px] leading-none text-emerald-400 font-semibold">✓</span>
                              ) : overall === 'in_progress' ? (
                                <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.7)]" />
                              ) : (
                                <span className="h-1.5 w-1.5 rounded-full border border-slate-600 bg-transparent" />
                              )}
                            </button>
                            {statusPopoverSlug === a.id && (
                              <div
                                ref={statusPopoverRef}
                                role="menu"
                                onClick={(e) => e.stopPropagation()}
                                className="absolute right-0 top-full mt-1 z-40 min-w-[200px] rounded-md border border-white/10 bg-slate-900/95 backdrop-blur-sm shadow-xl py-1.5 text-xs font-mono"
                              >
                                <div className="px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-500 border-b border-white/5">
                                  {tracks.length === 0
                                    ? 'No annotations yet'
                                    : manualTracks.length === 0
                                      ? `${autoTracks.length} auto only`
                                      : `${manualReviewedCount}/${manualTracks.length} reviewed`}
                                </div>
                                {tracks.length === 0 ? (
                                  <div className="px-3 py-2 text-slate-500">
                                    Start by adding boundaries, cues, or by-eye markers in the editor.
                                  </div>
                                ) : (() => {
                                  const renderRow = (t: Track) => {
                                    const dotCls =
                                      t.color === 'amber'   ? 'bg-amber-400'   :
                                      t.color === 'cyan'    ? 'bg-cyan-400'    :
                                      t.color === 'violet'  ? 'bg-violet-400'  :
                                      t.color === 'emerald' ? 'bg-emerald-400' :
                                      t.color === 'sky'     ? 'bg-sky-400'     :
                                      t.color === 'pink'    ? 'bg-pink-400'    :
                                      t.color === 'rose'    ? 'bg-rose-400'    :
                                      t.color === 'fuchsia' ? 'bg-fuchsia-400' :
                                                              'bg-slate-400';
                                    // Display labels match the StatusPill pill
                                    // tones (emerald reviewed, amber in
                                    // progress) — never "ready for review",
                                    // since the new lifecycle collapses to
                                    // not started / in progress / reviewed.
                                    const stateLabel =
                                      t.state === 'reviewed'    ? 'reviewed' :
                                      t.state === 'in_progress' ? 'in progress' :
                                                                  'not started';
                                    const stateCls =
                                      t.state === 'reviewed'    ? 'text-emerald-300' :
                                      t.state === 'in_progress' ? 'text-amber-300' :
                                                                  'text-slate-400';
                                    return (
                                      <div key={t.kind} className="flex items-center gap-2 px-3 py-1.5">
                                        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${dotCls}`} />
                                        <span className="text-slate-200 flex-1">{t.label}</span>
                                        {t.detail && <span className="text-slate-500 text-[10px]">{t.detail}</span>}
                                        <span className={`text-[10px] ${stateCls}`}>
                                          {t.state === 'reviewed' ? '✓ ' : ''}{stateLabel}
                                        </span>
                                      </div>
                                    );
                                  };
                                  return (
                                    <>
                                      {manualTracks.map(renderRow)}
                                      {manualTracks.length > 0 && autoTracks.length > 0 && (
                                        <div className="my-1 mx-3 border-t border-white/5" />
                                      )}
                                      {autoTracks.length > 0 && (
                                        <div className="px-3 pt-1 pb-0.5 text-[9px] uppercase tracking-[0.18em] text-slate-600">
                                          auto-guess · detectors
                                        </div>
                                      )}
                                      {autoTracks.map(renderRow)}
                                    </>
                                  );
                                })()}
                              </div>
                            )}
                          </span>
                          )}
                          {/* /prep replaces the annotation-status LEDs with a
                              single neutral total — stems + algos + annotations
                              + audio — so each row stays compact. The full
                              breakdown lives inside the ⌫ dialog. Color tiers
                              draw attention to rows that are eating disk:
                                < 1 GB  → slate (KB/MB stay quiet)
                                ≥ 1 GB  → cyan  (notable; usually means stems)
                                ≥ 2 GB  → amber (review whether to clear)
                                ≥ 5 GB  → red   (almost certainly cruft)
                              Also surfaced in Algorithm Inspect (alongside the
                              status LEDs), where disk-cost per song matters
                              for deciding what to re-run vs. evict. */}
                          {(mode === 'prep' || feature === 'inspect-song') && (() => {
                            const bytes = songStorage?.totalBytes ?? 0;
                            const GB = 1024 ** 3;
                            const tone =
                              bytes >= 5 * GB ? 'text-red-400/90' :
                              bytes >= 2 * GB ? 'text-amber-300/90' :
                              bytes >= 1 * GB ? 'text-cyan-300/80' :
                                                'text-slate-400';
                            return (
                              <span
                                title={rowTitle}
                                className={`text-[10px] font-mono tabular-nums ${tone} transition-opacity ${actionsOpen ? 'opacity-40' : ''}`}
                              >
                                {formatBytes(bytes)}
                              </span>
                            );
                          })()
                          }
                          {actionsOpen && mode !== 'prep' && (
                            <button
                              onClick={(e) => { e.stopPropagation(); setPendingCacheClear(a.id); }}
                              disabled={!songStorage || songStorage.cacheBytes === 0}
                              title={songStorage && songStorage.cacheBytes > 0
                                ? `Clear ${formatBytes(songStorage.cacheBytes)} of regenerable caches for this song (annotations + audio kept)`
                                : 'No regenerable caches to clear'}
                              className="text-[11px] leading-none w-4 h-4 flex items-center justify-center rounded text-slate-200 hover:text-amber-300 hover:bg-amber-500/15 transition-all disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-slate-200"
                            >
                              ⌫
                            </button>
                          )}
                          {actionsOpen && mode === 'prep' && !isDemo && (
                            <button
                              onClick={(e) => { e.stopPropagation(); setPendingSongDelete(a); }}
                              title="Delete this song from the dataset (requires typing DELETE_SONG)"
                              className="text-[11px] leading-none w-4 h-4 flex items-center justify-center rounded text-slate-200 hover:text-red-300 hover:bg-red-500/15 transition-all"
                            >
                              ✕
                            </button>
                          )}
                          {actionsOpen && mode === 'prep' && (
                            <button
                              onClick={(e) => { e.stopPropagation(); setPendingClearScope(a.id); }}
                              title={`Clear storage for "${a.name}" — choose STEM, ALGOS, or EVERYTHING.`}
                              className="text-[11px] leading-none w-4 h-4 flex items-center justify-center rounded text-slate-200 hover:text-amber-300 hover:bg-amber-500/15 transition-all"
                            >
                              ⌫
                            </button>
                          )}
                        </span>
                        </div>
                      </Fragment>
                    );
                  })}
                </div>

                {/* ── Footer: dataset disk-usage breakdown + clear-all ─────── */}
                {storageStats && (mode === 'prep' || feature === 'inspect-song') && (
                  <div className="border-t border-white/[0.05] shrink-0 px-3 py-2 space-y-1.5 bg-[#0f1218]/60">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500 font-semibold flex items-center justify-between">
                      <span>Disk · {audioFiles.length} song{audioFiles.length === 1 ? '' : 's'}</span>
                      <span className="font-mono text-slate-300 tabular-nums">{formatBytes(storageStats.totals.totalBytes)}</span>
                    </div>
                    <div className="text-[12px] font-mono text-slate-300 grid grid-cols-[1fr_auto] gap-x-2 gap-y-0.5 tabular-nums">
                      <span className="text-slate-500">Stems</span>          <span>{formatBytes(storageStats.totals.stems)}</span>
                      <span className="text-slate-500">Analysis</span>       <span>{formatBytes(storageStats.totals.analysis)}</span>
                      <span className="text-slate-500">MSAF raw</span>       <span>{formatBytes(storageStats.totals.msafRaw)}</span>
                      <span className="text-slate-500">BPM</span>            <span>{formatBytes(storageStats.totals.bpm)}</span>
                      <span className="text-slate-500">Algo clusters</span>  <span>{formatBytes(storageStats.totals.algoClusters)}</span>
                      <div
                        className="col-span-2 my-1.5 h-px"
                        style={{
                          background: 'linear-gradient(90deg, transparent 0%, rgba(56,189,248,0.7) 20%, rgba(167,139,250,0.8) 50%, rgba(244,114,182,0.7) 80%, transparent 100%)',
                          boxShadow: '0 0 6px rgba(167,139,250,0.6), 0 0 12px rgba(56,189,248,0.35)',
                        }}
                      />
                      <span className="text-slate-300">Caches</span>         <span className="text-slate-300">{formatBytes(storageStats.totals.cacheBytes)}</span>
                      <span className="text-slate-500">Annotations</span>    <span>{formatBytes(storageStats.totals.annotations)}</span>
                      <span className="text-slate-500">Audio</span>          <span>{formatBytes(storageStats.totals.audio)}</span>
                    </div>
                    <button
                      onClick={() => setPendingCacheClear('all')}
                      disabled={storageStats.totals.cacheBytes === 0}
                      title="Wipe regenerable caches across the whole dataset. Annotations and audio files are kept."
                      className="w-full mt-1 px-2 py-1.5 rounded text-[11px] uppercase tracking-wider text-slate-400 hover:text-amber-300 hover:bg-amber-500/10 border border-white/[0.06] hover:border-amber-500/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      ⌫ Clear all caches ({formatBytes(storageStats.totals.cacheBytes)})
                    </button>
                  </div>
                )}
                {/* ── Prep-only Delete-All (admin) ──────────────────────────
                     Visible only in Dataset Prep so it doesn't clutter the
                     Annotator workspace. Full-annotation export lives at the
                     top of the sidebar (next to Upload) so users don't have
                     to scroll past the storage-stats footer to find it. */}
                {mode === 'prep' && adminStatus?.isAdmin && (
                  <div className="border-t border-white/[0.05] shrink-0 px-2 py-2 space-y-1 bg-[#0f1218]/60">
                    <button
                      onClick={() => setPendingSongDelete('all')}
                      disabled={audioFiles.length === 0}
                      title="Permanently remove every song from the dataset. Requires typing DELETE_ALL to confirm."
                      className="w-full px-2 py-1.5 rounded text-[10px] uppercase tracking-wider text-red-400/90 hover:text-red-200 hover:bg-red-500/10 border border-red-500/20 hover:border-red-500/50 transition-colors text-left flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <span>✕</span><span>Delete all songs</span>
                    </button>
                  </div>
                )}
              </>
          </aside>
        )}

        {/* ── Main content ─────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 max-w-6xl mx-auto p-4 pb-[50vh] space-y-3">

        {/* Workspace tab header is mounted in App.tsx so its container is
            identical across all workspaces. */}

        {/* ── Dismissible page-purpose banner ──────────────────────────────
             One-liner that tells a first-time user what each workspace is
             for. Dismissed per-workspace via localStorage (see InfoBanner). */}
        {feature === 'prep' && (
          <InfoBanner id="prep.v2" title="Dataset Prep" accent="emerald">
            Set <strong>BPM</strong> and align the <strong>grid</strong> for each
            song using the edit panel <strong>below the song visualization</strong> —
            try auto-detect, or tap along with the metronome. If every song already
            has a BPM, move on to the <strong>Annotator Tool</strong> tab above.
          </InfoBanner>
        )}
        {feature === 'annotate' && (
          <InfoBanner id="annotate.v4" title="Annotator Tool" accent="cyan">
            Annotate the song with <strong>boundaries</strong> (split the song
            into non-overlapping sections), <strong>cues</strong> (single
            events at a point in time), <strong>spans</strong> (ranged regions
            that may overlap), <strong>loops</strong> (repeating segments
            with cycle length), and <strong>patterns</strong> (recurring
            rhythmic motifs) — switch types in the tab strip just under the
            waveform; edit list lives in the panel <strong>below the
            visualization</strong>. Press <strong>?</strong> for the full
            shortcut list. Toggle <strong>signal rows</strong> (e.g.
            spectrogram, chroma) from the <strong>SIGNALS</strong> menu in
            the audio visualization panel to surface different audio features.
            <strong> BPM and grid must be set in Dataset Prep first</strong> —
            boundaries snap to the grid.
          </InfoBanner>
        )}
        {feature === 'inspect-song' && (
          <InfoBanner id="inspect-song.v2" title="Algorithm Inspect — per song" accent="violet">
            Tick the algorithms you want in the <strong>right sidebar</strong>,
            then hit <strong>Run</strong> — predictions stack as colored timelines
            on the waveform, with metrics vs. your manual annotation in the panel
            <strong> below the visualization</strong>. Switch to <strong>All songs</strong>
            (tab just under this banner) for dataset-wide totals.
          </InfoBanner>
        )}
        {feature === 'inspect-all' && (
          <InfoBanner id="inspect-all.v2" title="Algorithm Inspect — all songs" accent="violet">
            Pick algorithms via the <strong>⚙ options</strong> button at the top,
            then click <strong>Batch run</strong> to evaluate every song at once.
            The aggregate F1 / precision / recall table appears below, with
            expandable per-song rows. New algorithms can be added or re-run on a
            single song from the <strong>Per song</strong> tab above.
          </InfoBanner>
        )}

        {/* ── Inspect scope tabs (Per song / All songs) ─────────────────── */}
        {isInspect(feature) && (
          <div className="flex border-b border-white/[0.05]">
            {([
              ['inspect-song', 'Per song'],
              ['inspect-all',  'All songs'],
            ] as ['inspect-song' | 'inspect-all', string][]).map(([f, label]) => (
              <button
                key={f}
                onClick={() => setFeature(f)}
                className={`px-4 py-1.5 text-[11px] uppercase tracking-wider font-medium transition-colors border-b-2 -mb-px ${
                  feature === f
                    ? `${accent.tabBorderActive} ${accent.tabTextActive}`
                    : 'border-transparent text-slate-500 hover:text-slate-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* ── Run algorithms (All-songs batch only) ─────────────────────────
             In Per-song mode the right-edge Algorithms sidebar carries the
             run button + options, so we don't render anything here to avoid
             duplication. */}
        {feature === 'inspect-all' && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handleBatchRunAlgorithms}
                disabled={runJob?.status === 'running'}
                title={selectedAlgorithms.size === 0
                  ? 'Open the ⚙ batch algorithm options to pick algorithms first.'
                  : `Run ${selectedAlgorithms.size} algorithm(s) across ${audioFiles.length} song(s) sequentially.`}
                className={`px-3 py-1.5 rounded text-[11px] uppercase tracking-wider border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  runJob?.status === 'running'
                    ? 'border-violet-500/60 bg-violet-500/20 text-violet-100'
                    : 'border-white/10 bg-white/[0.03] text-slate-300 hover:bg-violet-500/10 hover:border-violet-500/50 hover:text-violet-200'
                }`}
              >
                {runJob?.status === 'running'
                  ? '⏳ Running…'
                  : `▶ Batch run across ${audioFiles.length} song${audioFiles.length === 1 ? '' : 's'}`}
              </button>
              <button
                onClick={() => setRunOptionsScope((s) => (s === 'dataset' ? null : 'dataset'))}
                title="Batch algorithm options"
                aria-label="Batch algorithm options"
                className={`px-2 py-1.5 rounded text-[11px] border transition-colors ${
                  runOptionsScope === 'dataset'
                    ? 'border-violet-500/60 bg-violet-500/25 text-violet-100'
                    : 'border-white/10 bg-white/[0.03] text-slate-300 hover:bg-violet-500/10 hover:border-violet-500/50 hover:text-violet-200'
                }`}
              >
                ⚙
              </button>
            </div>
            {runOptionsScope === 'dataset' && renderRunOptionsPanel(false)}
          </>
        )}

        {/* ── Algorithm job log panel ──────────────────────────────────────── */}
        {isInspect(feature) && runJob && (() => {
          const logs = runJob.logs;
          // Prefer structured per-section counts (MSAF/All-In-One/Ruptures) from the
          // backend; fall back to the old log-marker parse when there's no
          // sections payload yet (custom-only runs, in-flight first poll).
          const sections = runJob.sections ?? [];
          const fallbackLabels = sections.length === 0
            ? [...logs.matchAll(/(?:^|\n)▶ ([^\n]+)/g)].map((m) => m[1])
            : [];
          const elapsedSec = Math.floor((Date.now() - runJob.startedAt) / 1000);
          const elapsedStr = elapsedSec >= 60
            ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
            : `${elapsedSec}s`;
          const isRunning = runJob.status === 'running';

          const SectionPill = ({ section }: { section: RunJobSection }) => {
            const { label, total, ok, failed, cached } = section;
            const inFlight = isRunning && ok + failed < total;
            let cls = 'bg-slate-500/15 text-slate-400';
            let icon: ReactNode = '⊝';
            if (inFlight) {
              cls = `${accent.pillBg} ${accent.pillText}`;
              icon = <span className="inline-block w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin" />;
            } else if (failed > 0 && ok === 0 && cached === 0) {
              cls = 'bg-red-500/15 text-red-300'; icon = '✗';
            } else if (failed > 0) {
              cls = 'bg-amber-500/15 text-amber-300'; icon = '⚠';
            } else if (ok > 0) {
              cls = 'bg-emerald-500/15 text-emerald-300'; icon = '✓';
            }
            const detail = !inFlight && (failed > 0 || (ok > 0 && cached > 0))
              ? ` (${[ok > 0 && `${ok} ok`, failed > 0 && `${failed} failed`, cached > 0 && `${cached} cached`].filter(Boolean).join(' · ')})`
              : '';
            return (
              <span className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider ${cls}`}>
                {icon}
                {label}{detail}
              </span>
            );
          };

          const FallbackPill = ({ label, idx }: { label: string; idx: number }) => {
            const isLast = idx === fallbackLabels.length - 1;
            const isCancelled = isLast && runJob.status === 'cancelled';
            const done = !isLast || (!isRunning && !isCancelled);
            const isError = isLast && runJob.status === 'error';
            return (
              <span className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider ${
                isError     ? 'bg-red-500/15 text-red-300' :
                isCancelled ? 'bg-amber-500/15 text-amber-300' :
                done        ? 'bg-emerald-500/15 text-emerald-300' :
                              `${accent.pillBg} ${accent.pillText}`
              }`}>
                {isError ? '✗' : isCancelled ? '■' : done ? '✓' : (
                  <span className="inline-block w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin" />
                )}
                {label}
              </span>
            );
          };

          // Build the honest summary line. Parts include only non-zero counts;
          // the verb ("done" / "partially done" / "failed") follows job.status.
          const totals = sections.reduce(
            (acc, s) => ({ ok: acc.ok + s.ok, failed: acc.failed + s.failed, cached: acc.cached + s.cached }),
            { ok: 0, failed: 0, cached: 0 },
          );
          const parts = [
            totals.ok > 0     && `${totals.ok} ran`,
            totals.cached > 0 && `${totals.cached} cached`,
            totals.failed > 0 && `${totals.failed} failed`,
          ].filter(Boolean) as string[];
          const detailSuffix = parts.length > 0 ? ` — ${parts.join(', ')}` : '';
          const summary =
            runJob.status === 'done'      ? { color: 'text-emerald-400', text: `done in ${elapsedStr}${detailSuffix}` } :
            runJob.status === 'partial'   ? { color: 'text-amber-400',   text: `partially done in ${elapsedStr}${detailSuffix}` } :
            runJob.status === 'error'     ? { color: 'text-red-400',     text: `failed after ${elapsedStr}${detailSuffix}` } :
            runJob.status === 'cancelled' ? { color: 'text-amber-400',   text: `stopped after ${elapsedStr}${detailSuffix}` } :
            null;

          return (
            <div className="rounded-md border border-white/[0.06] bg-[#14171d]/80 p-3 space-y-2">
              <div className="flex items-center gap-1.5 flex-wrap">
                {sections.length > 0
                  ? sections.map((s, idx) => <SectionPill key={idx} section={s} />)
                  : fallbackLabels.map((label, idx) => <FallbackPill key={idx} label={label} idx={idx} />)}
                {isRunning && (
                  <span className="text-[10px] font-mono text-slate-500 ml-1">{elapsedStr}</span>
                )}
                {summary && (
                  <span className={`text-[10px] font-mono ${summary.color} ml-1`}>{summary.text}</span>
                )}
                {runJob.status === 'running' && (
                  <button
                    onClick={handleStopJob}
                    className="ml-auto text-[10px] px-2 py-0.5 rounded bg-red-500/15 hover:bg-red-500/25 text-red-300 shrink-0 transition-colors"
                  >
                    ■ Stop
                  </button>
                )}
                <button
                  onClick={() => navigator.clipboard.writeText(logs || '(starting…)')}
                  title="Copy output"
                  className={`text-[10px] text-slate-600 hover:text-slate-300 shrink-0 transition-colors ${runJob.status !== 'running' ? 'ml-auto' : ''}`}
                >
                  ⎘ Copy
                </button>
                <button
                  onClick={() => { if (runJobPollRef.current) clearInterval(runJobPollRef.current); setRunJob(null); }}
                  className="text-[10px] text-slate-600 hover:text-slate-300 shrink-0 transition-colors"
                >
                  ✕
                </button>
              </div>
              <pre
                ref={logPreRef}
                className="text-[10px] text-slate-500 bg-[#0a0b0d] border border-white/[0.04] rounded p-2 max-h-40 overflow-y-auto font-mono whitespace-pre-wrap"
              >
                {logs || '(starting…)'}
              </pre>
            </div>
          );
        })()}

        {/* ── Mode content ─────────────────────────────────────────────── */}
        {mode === 'dataset' ? (
          <GlobalEvalStage audioFiles={audioFiles} />
        ) : (mode === 'song' || mode === 'prep') ? (
          <>

        {/* Song-specific viz */}
        {selectedAudio && (
          <>
            <div className="sticky top-16 z-50 -mx-4 px-4 py-2 bg-[#0a0b0d]/95 backdrop-blur space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-3xl font-bold text-white leading-tight truncate tracking-tight">{selectedAudio.name}</h2>
              </div>
              <div className="flex flex-wrap items-start gap-2">
                <div className="flex-1 min-w-0">
                  <VizControlBar
                  showAnnotations={feature !== 'prep'}
                  showManual={showManual}           onToggleManual={setShowManual}
                  showEye={showEye}             onToggleEye={setShowEye}
                  eyeEnabled={settings.experimentalEyeAnnotation}
                  showAutoGuess={showAutoGuess} onToggleAutoGuess={setShowAutoGuess}
                  showSignalOverlays={showSignalOverlays} onToggleSignalOverlays={setShowSignalOverlays}
                  minConsensus={minConsensus}   onMinConsensusChange={setMinConsensus}
                  totalAlgos={annotationRows.length || undefined}
                  showWaveform={showWaveform}   onToggleWaveform={setShowWaveform}
                  showEQ={showEQ}               onToggleEQ={setShowEQ}
                  showSpectrogram={showSpectrogram} onToggleSpectrogram={setShowSpectrogram}
                  showCepstrogram={showCepstrogram} onToggleCepstrogram={setShowCepstrogram}
                  showChroma={showChroma}       onToggleChroma={setShowChroma}
                  showTempogram={showTempogram} onToggleTempogram={setShowTempogram}
                  showSsm={showSsm}             onToggleSsm={setShowSsm}
                  showEnergy={showEnergy}       onToggleEnergy={setShowEnergy}
                  showBrightness={showBrightness} onToggleBrightness={setShowBrightness}
                  showNovelty={showNovelty}     onToggleNovelty={setShowNovelty}
                  showOnsets={showOnsets}       onToggleOnsets={setShowOnsets}
                  showFlux={showFlux}           onToggleFlux={setShowFlux}
                  showBeatGrid={showBeatGrid}   onToggleBeatGrid={setShowBeatGrid}
                  beatGridUnit={beatGridUnit}   onBeatGridUnitChange={setBeatGridUnit}
                  beatGridUnitOptions={beatGridUnitOptions}
                  gridMode={effectiveGridMode(songInfo)}
                  anchorCount={getActiveAnchorCount(songInfo)}
                  overrideCount={getActiveBeatOverrideCount(songInfo)}
                  bpm={bpm}
                  beatsPerBar={beatsPerBar}
                  timeSignature={songInfo?.timeSignature ?? '4/4'}
                  snapToGrid={snapToGrid}       onToggleSnapToGrid={setSnapToGrid}
                  showSnap={feature === 'annotate'}
                  captureGlobalHScroll={captureGlobalHScroll}
                  onToggleCaptureGlobalHScroll={setCaptureGlobalHScroll}
                  gridLineThickness={gridLineThickness}
                  onGridLineThicknessChange={setGridLineThickness}
                  zoomFactor={vizZoomFactor}
                  atMaxZoom={vizAtMaxZoom}
                  onZoomIn={() => zoomInRef.current?.()}
                  onZoomOut={() => zoomOutRef.current?.()}
                  onZoomReset={() => zoomResetRef.current?.()}
                  algoOptions={algoOptions}
                  selectedAlgos={selectedAlgoOverlays}
                  onToggleAlgo={toggleAlgoOverlay}
                  showAlgos={isInspect(feature)}
                  singleInfoDetections={isInspect(feature) ? singleInfoDetections : undefined}
                  customAnnotationOptions={customAnnotationRows.map((r) => ({ id: r.detectorName, label: r.label, color: r.color }))}
                  hiddenCustomAnnotations={hiddenCustomAnnotations}
                  onToggleCustomAnnotation={toggleCustomAnnotationVisible}
                  cueLayerOptions={[
                    ...(cueLayers ?? []).map((l) => ({
                      id: l.id, label: l.name, color: l.color, visible: l.visible, count: l.items.length,
                    })),
                    ...detectorCueLayers.map((l) => ({
                      id: l.id,
                      label: `${l.name} (detector)`,
                      color: l.color,
                      visible: !hiddenCustomAnnotations.has(l.source!.slice('detector:'.length)),
                      count: l.items.length,
                    })),
                  ]}
                  onToggleCueLayerVisibility={(layerId) => {
                    // Detector layer? Piggy-back on the shared "hide custom detector" Set
                    // so toggling here matches the existing detector visibility model.
                    const detector = detectorCueLayers.find((l) => l.id === layerId);
                    if (detector) {
                      toggleCustomAnnotationVisible(detector.source!.slice('detector:'.length));
                      return;
                    }
                    // Visibility is canvas metadata, not an annotation edit —
                    // keep it out of the undo history so ⌘Z doesn't surprise
                    // the user by toggling a checkbox back on/off.
                    setCueLayersDoc((d) => d && ({
                      ...d,
                      layers: d.layers.map((l) => (l.id === layerId ? { ...l, visible: !l.visible } : l)),
                    }), { skipHistory: true });
                  }}
                  spanLayerOptions={[
                    ...spanLayers.map((l) => ({
                      id: l.id, label: l.name, color: l.color, visible: l.visible, count: l.items.length,
                    })),
                    ...detectorSpanLayers.map((l) => ({
                      id: l.id,
                      label: `${l.name} (detector)`,
                      color: l.color,
                      visible: !hiddenCustomAnnotations.has(l.source!.slice('detector:'.length)),
                      count: l.items.length,
                    })),
                  ]}
                  onToggleSpanLayerVisibility={(layerId) => {
                    const detector = detectorSpanLayers.find((l) => l.id === layerId);
                    if (detector) {
                      toggleCustomAnnotationVisible(detector.source!.slice('detector:'.length));
                      return;
                    }
                    setCueLayersDoc((d) => d && ({
                      ...d,
                      layers: d.layers.map((l) => (l.id === layerId ? { ...l, visible: !l.visible } : l)),
                    }), { skipHistory: true });
                  }}
                  loopLayerOptions={settings.experimentalLoopsAndPatterns ? [
                    ...loopLayers.map((l) => ({
                      id: l.id, label: l.name, color: l.color, visible: l.visible, count: l.items.length,
                    })),
                    ...detectorLoopLayers.map((l) => ({
                      id: l.id,
                      label: `${l.name} (detector)`,
                      color: l.color,
                      visible: !hiddenCustomAnnotations.has(l.source!.slice('detector:'.length)),
                      count: l.items.length,
                    })),
                  ] : undefined}
                  onToggleLoopLayerVisibility={(layerId) => {
                    const detector = detectorLoopLayers.find((l) => l.id === layerId);
                    if (detector) {
                      toggleCustomAnnotationVisible(detector.source!.slice('detector:'.length));
                      return;
                    }
                    setCueLayersDoc((d) => d && ({
                      ...d,
                      layers: d.layers.map((l) => (l.id === layerId ? { ...l, visible: !l.visible } : l)),
                    }), { skipHistory: true });
                  }}
                  patternLayerOptions={settings.experimentalLoopsAndPatterns ? [
                    ...patternLayers.map((l) => ({
                      id: l.id, label: l.name, color: l.color, visible: l.visible, count: l.items.length,
                    })),
                    ...detectorPatternLayers.map((l) => ({
                      id: l.id,
                      label: `${l.name} (detector)`,
                      color: l.color,
                      visible: !hiddenCustomAnnotations.has(l.source!.slice('detector:'.length)),
                      count: l.items.length,
                    })),
                  ] : undefined}
                  onTogglePatternLayerVisibility={(layerId) => {
                    const detector = detectorPatternLayers.find((l) => l.id === layerId);
                    if (detector) {
                      toggleCustomAnnotationVisible(detector.source!.slice('detector:'.length));
                      return;
                    }
                    setCueLayersDoc((d) => d && ({
                      ...d,
                      layers: d.layers.map((l) => (l.id === layerId ? { ...l, visible: !l.visible } : l)),
                    }), { skipHistory: true });
                  }}
                  />
                </div>
              </div>
            </div>

            {/* Run options panel — opens below the control bar when ⚙ is on */}
            {feature === 'prep' && runOptionsScope === 'song' && renderRunOptionsPanel(false)}
            <SharedVizPanel
              playerUrl={playerUrl}
              trackName={selectedAudio.name}
              audioBuffer={audioBuffer}
              duration={duration}
              currentTime={playerTime}
              bpm={bpm}
              timeSignature={songInfo?.timeSignature}
              beatOffset={beatOffset}
              beatsPerBar={beatsPerBar}
              // The chosen mode (Static / Dynamic / Manual) is the final
              // verdict everywhere: Static suppresses anchors so the grid
              // falls back to the global BPM in every workspace, regardless
              // of any orphan anchor data that might still be on disk.
              anchors={effectiveAnchors(songInfo)}
              // Manual-mode per-beat overrides. Only apply when the mode
              // is 'manual'; in static/dynamic the map (if present) is
              // orphan data until the curator re-enters Manual.
              beatOverrides={effectiveGridMode(songInfo) === 'manual' ? songInfo?.beatOverrides : undefined}
              // Only prep mode renders anchor flags + the manual editor row.
              gridMode={feature === 'prep' ? effectiveGridMode(songInfo) : undefined}
              onDeleteAnchor={feature === 'prep' && (adminStatus?.isAdmin || isDemo) ? handleDeleteAnchor : undefined}
              onAnchorDrag={feature === 'prep' && (adminStatus?.isAdmin || isDemo) ? handleAnchorDrag : undefined}
              onBeatDrag={feature === 'prep' && (adminStatus?.isAdmin || isDemo) ? handleBeatDrag : undefined}
              onClearBeatOverride={feature === 'prep' && (adminStatus?.isAdmin || isDemo) ? handleClearBeatOverride : undefined}
              manualEditLocked={!(adminStatus?.isAdmin || isDemo)}
              showBeatGrid={showBeatGrid}
              beatGridUnit={beatGridUnit}
              snapToGrid={snapToGrid || (isAnnotateFeature && activeAnnotationType === 'patterns')}
              captureGlobalHScroll={captureGlobalHScroll}
              gridLineThickness={gridLineThickness}
              stemSource={selectedStemSource}
              availableStemSources={availableStemSources}
              onStemSourceChange={setSelectedStemSource}
              onRunStems={feature === 'prep' && selectedAudio && !isDemo ? () => handleStemSong(selectedAudio) : undefined}
              runStemsStatus={
                demucsJob?.slug === selectedAudio?.id && demucsJob?.status === 'running' ? 'running'
                : demucsJob?.slug === selectedAudio?.id && demucsJob?.status === 'error' ? 'error'
                : 'idle'
              }
              runStemsProgressPct={demucsJob?.slug === selectedAudio?.id ? demucsJob?.progressPct : undefined}
              runStemsElapsedSec={demucsJob?.slug === selectedAudio?.id && demucsJob?.startedAt
                ? Math.floor((Date.now() - demucsJob.startedAt) / 1000)
                : undefined}
              runStemsLastLine={demucsJob?.slug === selectedAudio?.id ? demucsJob?.lastLine : undefined}
              runStemsCancelMode={demucsJob?.slug === selectedAudio?.id ? demucsJob?.cancelMode : undefined}
              onCancelStems={demucsJob?.slug === selectedAudio?.id && demucsJob?.status === 'running' && !demucsJob?.cancelMode
                ? handleCancelStems
                : undefined}
              onKillStems={demucsJob?.slug === selectedAudio?.id && demucsJob?.status === 'running' && demucsJob?.cancelMode !== 'hard'
                ? handleKillStems
                : undefined}
              runStemsErrorTail={demucsJob?.slug === selectedAudio?.id && demucsJob?.status === 'error'
                ? (demucsJob.logs.length > 1500 ? '…\n' + demucsJob.logs.slice(-1500) : demucsJob.logs)
                : undefined}
              onDismissStemsError={demucsJob?.slug === selectedAudio?.id && demucsJob?.status === 'error'
                ? () => setDemucsJob(null)
                : undefined}
              onGridOffsetChange={handleGridOffsetDrag}
              showBarNumbers={showBeatGrid}
              manualSections={feature === 'prep' ? [] : refManualSections}
              eyeSections={feature === 'prep' || !settings.experimentalEyeAnnotation ? [] : refEyeSections}
              autoGuessPoints={feature === 'prep' ? [] : (refAutoGuessPoints ?? displayAutoGuessPoints)}
              pendingSelection={isAnnotateFeature && supportsPending(activeAnnotationType, activeBoundarySource ?? undefined) ? pendingAnnotationSelection : null}
              showManual={feature === 'prep' ? false : (isEyeMode ? false : showManual)}
              showEye={feature === 'prep' || !settings.experimentalEyeAnnotation ? false : showEye}
              showAutoGuess={feature === 'prep' ? false : (isEyeMode ? false : showAutoGuess)}
              showSignalOverlays={showSignalOverlays}
              showWaveform={showWaveform}
              showEQ={showEQ}
              showSpectrogram={showSpectrogram}
              showCepstrogram={showCepstrogram}
              showChroma={showChroma}
              showTempogram={showTempogram}
              showSsm={showSsm}
              mirCurves={mirCurves}
              mirComputing={mirComputing}
              showEnergy={showEnergy}
              showBrightness={showBrightness}
              showNovelty={showNovelty}
              showOnsets={showOnsets}
              showFlux={showFlux}
              algoOverlays={isInspect(feature) ? algoOverlays : []}
              cueLayers={feature === 'prep' ? [] : [
                ...(cueLayers ?? []),
                ...detectorCueLayers.filter((l) => !hiddenCustomAnnotations.has(l.source!.slice('detector:'.length))),
              ]}
              focusedCue={focusedCue}
              onCueClick={(layerId, itemId, anchor) => cuePopover.openAt(layerId, itemId, anchor)}
              onCueDrag={feature === 'prep' ? undefined : handleCueDrag}
              loopLayers={feature === 'prep' || !settings.experimentalLoopsAndPatterns ? [] : [
                ...loopLayers,
                ...detectorLoopLayers.filter((l) => !hiddenCustomAnnotations.has(l.source!.slice('detector:'.length))),
              ]}
              focusedLoop={focusedLoop}
              playingLoopId={loopPlayback.playingId}
              onLoopClick={(layerId, itemId, anchor) => loopPopover.openAt(layerId, itemId, anchor)}
              onLoopEdgeDrag={feature === 'prep' ? undefined : handleLoopEdgeDrag}
              onLoopMove={feature === 'prep' ? undefined : handleLoopMove}
              spanLayers={feature === 'prep' ? [] : [
                ...spanLayers,
                ...detectorSpanLayers.filter((l) => !hiddenCustomAnnotations.has(l.source!.slice('detector:'.length))),
              ]}
              focusedSpan={focusedSpan}
              onSpanClick={(layerId, itemId, anchor) => spanPopover.openAt(layerId, itemId, anchor)}
              onSpanEdgeDrag={feature === 'prep' ? undefined : handleSpanEdgeDrag}
              onSpanMove={feature === 'prep' ? undefined : handleSpanMove}
              patternLayers={feature === 'prep' || !settings.experimentalLoopsAndPatterns ? [] : [
                ...patternLayers,
                ...detectorPatternLayers.filter((l) => !hiddenCustomAnnotations.has(l.source!.slice('detector:'.length))),
              ]}
              enablePatternBeatAudio={feature === 'prep'}
              focusedPattern={focusedPattern}
              playingPatternId={(() => {
                if (!playerIsPlaying) return null;
                for (const layer of patternLayers) {
                  for (const p of layer.items) {
                    const cycle = p.end - p.start;
                    if (cycle <= 0) continue;
                    const reps = Math.max(1, Math.floor(p.repeatCount));
                    if (playerTime >= p.start && playerTime < p.start + reps * cycle) return p.id;
                  }
                }
                return null;
              })()}
              onPatternClick={(layerId, itemId, anchor) => patternPopover.openAt(layerId, itemId, anchor)}
              onPatternEdgeDrag={feature === 'prep' ? undefined : handlePatternEdgeDrag}
              onPatternMove={feature === 'prep' ? undefined : handlePatternMove}
              activeAnnotationType={activeAnnotationType}
              selectedLayerIdByType={selectedLayerIdByType}
              onSelectLayer={isAnnotateFeature ? handleUnifiedSelectLayer : undefined}
              onVizClick={handleVizClick}
              onVizRegion={handleVizRegion}
              onRegionDragStart={() => setPendingAnnotationSelection(null)}
              onManualBoundaryChange={handleManualBoundaryChange}
              onManualBoundaryDragStart={handleManualBoundaryDragStart}
              onManualMarkerDrag={feature === 'prep' ? undefined : handleManualBoundaryChange}
              onEyeMarkerDrag={feature === 'prep' ? undefined : handleEyeMarkerDrag}
              onManualSectionClick={(idx, anchor) => openManualEditorRef.current?.(idx, anchor)}
              onEyeSectionClick={(idx, anchor) => openEyeEditorRef.current?.(idx, anchor)}
              onManualUndo={handleManualUndo}
              canManualUndo={canManualUndo}
              onMarkCorrect={(id) => updateAutoGuessPoint(id, { status: 'correct' })}
              onMarkIncorrect={(id) => updateAutoGuessPoint(id, { status: 'incorrect' })}
              onMarkPending={(id) => updateAutoGuessPoint(id, { status: 'pending' })}
              customAnnotationRows={feature === 'prep' ? [] : customAnnotationRows}
              hiddenCustomAnnotations={hiddenCustomAnnotations}
              onCustomAnnotationMarkCorrect={(det, id) => updateCustomAnnotationOverride(det, id, { status: 'correct' })}
              onCustomAnnotationMarkIncorrect={(det, id) => updateCustomAnnotationOverride(det, id, { status: 'incorrect' })}
              onCustomAnnotationMarkPending={(det, id) => updateCustomAnnotationOverride(det, id, { status: 'pending' })}
              detectorLayerReview={detectorLayerReview}
              onDetectorLayerAccept={(layerId, itemId) => handleDetectorLayerReview(layerId, itemId, 'accepted')}
              onDetectorLayerReject={(layerId, itemId) => handleDetectorLayerReview(layerId, itemId, 'rejected')}
              seekRef={seekRef}
              playRef={playRef}
              pauseRef={pauseRef}
              wsScrollRef={wsScrollRef}
              zoomInRef={zoomInRef}
              zoomOutRef={zoomOutRef}
              zoomResetRef={zoomResetRef}
              pinchZoomInRef={pinchZoomInRef}
              pinchZoomOutRef={pinchZoomOutRef}
              scrollToTimeRef={scrollToTimeRef}
              zoomToRangeRef={zoomToRangeRef}
              onBufferReady={(buf) => { setAudioBuffer(buf); setDuration(buf.duration); }}
              onTimeUpdate={setPlayerTime}
              onPlayingChange={setPlayerIsPlaying}
              onScrollChange={handleScrollChange}
              onViewChange={handleViewChange}
              vizScrollContainerRef={vizScrollContainerRef}
              vizSignalWidth={vizSignalWidth}
              vizZoomFactor={vizZoomFactor}
              onVizScroll={handleVizScroll}
              playerIsPlaying={playerIsPlaying}
              onSeekAndPlay={handleSeekAndPlay}
              onPause={handlePause}
              previewRegion={feature === 'prep' ? null : (isEyeMode ? null : previewRegion)}
              onPreviewRegionChange={feature === 'prep' ? undefined : handlePreviewRegionChange}
              onPreviewPlay={feature === 'prep' ? undefined : handlePreviewPlay}
              onPreviewPause={feature === 'prep' ? undefined : handlePreviewPause}
              onPreviewDismiss={feature === 'prep' ? undefined : handlePreviewDismiss}
              onPreviewLoopToggle={feature === 'prep' ? undefined : handlePreviewLoopToggle}
              rowOrder={rowOrder}
              onReorderRow={handleReorderRow}
              hasCustomRowOrder={hasCustomRowOrder}
              onResetRowOrder={handleResetRowOrder}
              sectionColorOverrides={feature === 'prep' ? undefined : sectionColorOverrides}
              onSectionColorChange={feature === 'prep' ? undefined : handleSectionColorChange}
              onResetSectionColors={feature === 'prep' ? undefined : handleResetSectionColors}
              layerAudioConfig={feature === 'prep' ? undefined : layerAudioConfig}
              onLayerAudioChange={feature === 'prep' ? undefined : ((id, cfg) => setLayerAudioConfig((prev) => ({ ...prev, [id]: cfg })))}
              playerAccent={playerAccent}
              hidePlaybackIcon={feature !== 'annotate'}
              hideTimeDisplay={feature === 'prep'}
            />
          </>
        )}

        {/* ── Inspect sub-tabs (Consensus Inspect / Evaluation) — only in inspect-song ── */}
        {feature === 'inspect-song' && (
          <div className="flex items-center justify-between gap-4 border-b border-white/[0.05]">
            <div className="flex items-center gap-4">
              {([
                ['algo', 'Consensus Inspect'],
                ['eval', 'Evaluation'],
              ] as ['algo' | 'eval', string][]).map(([sub, label]) => (
                <button
                  key={sub}
                  onClick={() => setInspectSubStage(sub)}
                  className={`px-1 py-1 text-lg sm:text-xl font-semibold tracking-tight transition-colors border-b-2 -mb-px ${
                    inspectSubStage === sub
                      ? `${accent.tabBorderActive} ${accent.tabTextActive}`
                      : 'border-transparent text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {selectedAudio && (adminStatus?.isAdmin || adminStatus?.isResearcher) && (
              <div className="pb-1">
                <ReferenceAnnotatorPicker
                  slug={selectedAudio.id}
                  currentAnnotatorId={annotator?.id ?? null}
                  value={referenceAnnotatorId}
                  onChange={setReferenceAnnotatorId}
                />
              </div>
            )}
          </div>
        )}

        {/* ── Stage content ─────────────────────────────────────────────── */}
        <div className="pt-1">

          {/* Empty corpus vs. no selection — different prompts so an unprepped
              user lands on "upload songs" instead of the dead-end "select a
              song above" when the sidebar list is empty. Once songs exist,
              the message shifts per-workspace to set the next concrete step
              (prep grid · annotate · inspect algos). */}
          {!selectedAudio && (
            <div className="py-20 text-center text-slate-400 text-xs uppercase tracking-[0.2em]">
              {audioFiles.length === 0 ? (
                feature === 'prep' ? (
                  <>
                    Upload songs to begin
                    {adminStatus?.isAdmin && (
                      <>
                        <span className="mx-2 text-slate-600">·</span>
                        <button
                          type="button"
                          onClick={() => uploadInputRef.current?.click()}
                          className="text-emerald-300 hover:text-emerald-200 underline-offset-4 hover:underline transition-colors normal-case tracking-normal"
                        >
                          + Upload songs
                        </button>
                      </>
                    )}
                  </>
                ) : (
                  <>No songs yet — open <span className="text-emerald-300">Dataset Prep</span> to upload</>
                )
              ) : feature === 'prep' ? (
                <>Select a song above, then set <span className="text-emerald-300">BPM</span> and align the <span className="text-emerald-300">grid</span> to start annotating</>
              ) : feature === 'annotate' ? (
                'Select a song above to begin annotating'
              ) : feature === 'inspect-song' ? (
                'Select a song above to compare algorithms'
              ) : (
                'Select a song above to begin'
              )}
            </div>
          )}

          {/* Song-specific stages */}
          {selectedAudio && (
            <>
              {/* Annotation stage */}
              {activeStage === 'annotation' && (
                <div className="space-y-3">
                  {isEyeMode && (
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded border border-cyan-500/20 bg-cyan-500/5 text-[11px] text-cyan-300">
                      <span className="tc-led tc-led-mute !bg-cyan-400 !shadow-[0_0_6px_rgba(34,211,238,0.65)]" />
                      <span>Eye mode — audio disabled · Manual and Auto-guess annotations hidden</span>
                    </div>
                  )}
                  {feature === 'prep' ? (
                    <>
                      <CollapsibleSection
                        title="BPM and Grid"
                        storageKey="tc:prep:bpmgrid:open"
                        defaultOpen={false}
                      >
                        <SongInfoBar
                          songInfo={songInfo ?? makeEmptySongInfo(selectedAudio.id)}
                          onChange={handleSongInfoChange}
                          suggestedBpms={suggestedBpms}
                          // BeatNet (experimental CUE-family) is the only
                          // detector today that infers meter; surface it as
                          // a click-to-apply chip next to the Time Signature
                          // select. Null when the user hasn't enabled the
                          // experimentalCueExtras flag or BeatNet wasn't
                          // confident enough to commit to one.
                          suggestedTimeSignature={
                            settings.experimentalCueExtras
                              ? beatnetDetection?.result?.meter ?? null
                              : null
                          }
                          bpmDetectionStatus={bpmDetectionStatus}
                          bpmDetectionError={bpmDetectionError}
                          // Re-run + manual edits are admin-only — non-admin
                          // annotators consume the BPM the team leader set.
                          // Demo users are also allowed to edit / align (their
                          // changes live in localStorage; see services/songInfo.ts).
                          onRerunBpmDetection={adminStatus?.isAdmin ? handleRerunBpmDetection : undefined}
                          onAlignGridToPlayhead={(adminStatus?.isAdmin || isDemo) ? handleAlignGridToPlayhead : undefined}
                          playerTime={playerTime}
                          locked={!adminStatus?.isAdmin && !isDemo}
                          embedded
                          gridMode={effectiveGridMode(songInfo)}
                          anchorListSlot={
                            isAnchorMode(effectiveGridMode(songInfo)) ? (
                              <AnchorListEditor
                                anchors={songInfo?.tempoAnchors ?? []}
                                duration={duration}
                                playerTime={playerTime}
                                mode={effectiveGridMode(songInfo) as 'dynamic' | 'manual'}
                                manualBase={songInfo?.manualBaseGridMode}
                                beatOverrides={effectiveGridMode(songInfo) === 'manual' ? songInfo?.beatOverrides : undefined}
                                gridOffset={songInfo?.gridOffset ?? 0}
                                locked={!adminStatus?.isAdmin && !isDemo}
                                globalBpm={songInfo?.bpm}
                                onChange={(nextAnchors) => {
                                  if (!songInfo) return;
                                  handleSongInfoChange({
                                    ...songInfo,
                                    tempoAnchors: nextAnchors,
                                    updated_at: new Date().toISOString(),
                                  });
                                }}
                                onSeek={(t) => seekRef.current?.(t)}
                                onClearPinnedBeat={handleClearBeatOverride}
                              />
                            ) : undefined
                          }
                          extraControls={
                            <GridModeControls
                              songInfo={songInfo ?? makeEmptySongInfo(selectedAudio.id)}
                              onChange={handleSongInfoChange}
                              locked={!adminStatus?.isAdmin && !isDemo}
                              onEnterDynamic={handleEnterDynamic}
                              onRederive={handleRederiveDynamic}
                            />
                          }
                        />
                      </CollapsibleSection>
                      <CollapsibleSection
                        title="Metronome"
                        storageKey="tc:prep:metronome:open"
                        defaultOpen={false}
                      >
                        <MetronomePanel
                          songInfo={songInfo}
                          onBpmChange={(adminStatus?.isAdmin || isDemo) ? (nextBpm) => {
                            if (!selectedAudio) return;
                            const base = songInfo ?? makeEmptySongInfo(selectedAudio.id);
                            handleSongInfoChange({ ...base, bpm: nextBpm, updated_at: new Date().toISOString() });
                          } : undefined}
                          playerTime={playerTime}
                          playerIsPlaying={playerIsPlaying}
                          locked={!adminStatus?.isAdmin && !isDemo}
                          embedded
                          tapRef={metronomeTapRef}
                        />
                      </CollapsibleSection>
                    </>
                  ) : null}
                  {feature !== 'prep' && (
                  <div className="mt-3">
                  <div className="flex items-baseline gap-2 mb-2 px-0.5">
                    <span className="text-[11px] uppercase tracking-[0.18em] text-slate-300 font-semibold">Current edited layer:</span>
                    <span className="text-[13px] font-semibold text-slate-100">
                      {TAB_CONFIG.find((t) => t.id === activeAnnotationType)?.label ?? ''}
                      {(() => {
                        const src = activeSourceByType[activeAnnotationType];
                        const label = src === 'manual' ? 'Manual'
                          : src === 'eye' ? 'Eye'
                          : src === 'autoGuess' ? 'Auto-guess'
                          : typeof src === 'string' && src.startsWith('detector:')
                            ? (customDetectors.find((d) => d.name === src.slice('detector:'.length))?.label ?? src.slice('detector:'.length))
                            : '';
                        return label ? ` · ${label}` : '';
                      })()}
                    </span>
                  </div>
                  {(() => {
                    // Source-override block: when the AnnotationSourcePicker is on
                    // a non-Manual source for a non-boundary category, render
                    // either the "Auto-guess coming soon" banner or the read-only
                    // detector review with ✓/✗ chips instead of the manual editor.
                    // For boundaries the per-source panels (Manual / Eye / Auto-guess)
                    // mount below; only detector:<X> on boundaries falls into the
                    // detector branch.
                    const category: AnnotationCategory = activeAnnotationType;
                    const source = activeSourceByType[category];
                    if (source === 'manual') return null;
                    if (source === 'eye' || source === 'autoGuess') {
                      if (category === 'boundaries') return null;
                      return (
                        <div className="p-4 rounded border border-fuchsia-400/20 bg-fuchsia-500/[0.04] text-[12px] text-slate-300">
                          <div className="font-medium text-fuchsia-200 mb-1">Auto-guess for {category} — coming soon</div>
                          <div className="text-slate-400">
                            No clustering algorithm has been wired up for this annotation type yet.
                            Use the Manual source to author {category} by hand, or pick a Custom Detector
                            source above to review its output.
                          </div>
                        </div>
                      );
                    }
                    if (typeof source === 'string' && source.startsWith('detector:')) {
                      const detectorName = source.slice('detector:'.length);
                      const det = customDetectors.find((d) => d.name === detectorName);
                      const envelope = customResults[detectorName];
                      const doc = detectorOutputDocs[detectorName];
                      if (category === 'boundaries') {
                        return (
                          <div className="p-4 rounded border border-white/[0.06] bg-white/[0.02] text-[12px] text-slate-400">
                            Boundary detector review is rendered inside the Auto-guess clusters today —
                            switch to the Auto-guess source and use the per-source approve/reject controls.
                          </div>
                        );
                      }
                      if (!envelope) {
                        return (
                          <div className="p-4 rounded border border-white/[0.06] bg-white/[0.02] text-[12px] text-slate-400">
                            <span className="font-medium text-slate-300">{det?.label ?? detectorName}</span> hasn't
                            been run on this song yet. Open the Custom Detectors page to run it,
                            then come back to review its output.
                          </div>
                        );
                      }
                      const items = (doc ?? envelope).items;
                      return (
                        <DetectorOutputReview
                          detectorName={detectorName}
                          detectorLabel={det?.label ?? detectorName}
                          category={category}
                          items={items}
                          reviewState={doc?.review ?? {}}
                          onAccept={(id) => void applyDetectorReview(detectorName, id, 'accepted')}
                          onReject={(id) => void applyDetectorReview(detectorName, id, 'rejected')}
                          onResetReview={doc ? () => void resetDetectorReview(detectorName) : undefined}
                          onCopyToManualLayer={({ type, items, layerName, importedFrom }) => {
                            // Build the new layer in the parent so it can read
                            // the existing layer set to pick a non-clashing
                            // color. `source: 'user'` keeps the layer grouped
                            // under Manual (not under the detector); the new
                            // `importedFrom` field carries the provenance
                            // without changing merge/visibility semantics.
                            setCueLayersDoc((d) => {
                              if (!d) return d;
                              const color = pickDefaultLayerColor(d.layers);
                              const layer: AnnotationLayer = {
                                id: newId(),
                                name: layerName,
                                type,
                                visible: true,
                                color,
                                snap: type === 'loops' || type === 'patterns' ? 'bar' : 'beat',
                                items: items as never,
                                source: 'user',
                                importedFrom,
                              };
                              return { ...d, layers: [...d.layers, layer] };
                            });
                          }}
                          onSeekAndPlay={handleSeekAndPlay}
                          onPause={handlePause}
                          playerIsPlaying={playerIsPlaying}
                          playerTime={playerTime}
                          bpm={bpm}
                          gridOffset={songInfo?.gridOffset ?? 0}
                          beatsPerBar={beatsPerBar}
                          anchors={effectiveAnchors(songInfo)}
                        />
                      );
                    }
                    return null;
                  })()}
                  {activeAnnotationType === 'boundaries' && activeBoundarySource === 'manual' && (
                    <ManualEditorPanel
                      ref={manualPanelRef}
                      onCapabilitiesChange={setManualCaps}
                      songId={selectedAudio.id}
                      currentTime={playerTime}
                      duration={duration}
                      songBpm={songInfo?.bpm}
                      songBeatsPerBar={beatsPerBar}
                      songGridOffset={songInfo?.gridOffset ?? 0}
                      onAnnotationChange={setManualAnnotation}
                      setSectionsRef={setSectionsRef}
                      openEditorRef={openManualEditorRef}
                      pendingSelection={pendingAnnotationSelection}
                      onClearPendingSelection={() => {
                        setPendingAnnotationSelection(null);
                        // Pill and preview are two views of the same span — tear both down together.
                        if (previewRegionRef.current) handlePreviewDismiss();
                      }}
                      onSeekAndPlay={handleSeekAndPlay}
                      onPause={handlePause}
                      isPlaying={playerIsPlaying}
                      reloadKey={panelReloadKey}
                    />
                  )}
                  {activeAnnotationType === 'boundaries' && activeBoundarySource === 'eye' && (
                    <EyeEditorPanel
                      ref={eyePanelRef}
                      onCapabilitiesChange={setEyeCaps}
                      songId={selectedAudio.id}
                      currentTime={playerTime}
                      duration={duration}
                      songInfo={songInfo}
                      pendingSelection={pendingAnnotationSelection}
                      onClearPendingSelection={() => setPendingAnnotationSelection(null)}
                      onAnnotationChange={setEyeAnnotation}
                      snapToGrid={snapToGrid}
                      openEditorRef={openEyeEditorRef}
                      addPointAtRef={eyeAddPointRef}
                      setPointTimeRef={eyeSetPointTimeRef}
                      reloadKey={panelReloadKey}
                      onSeekAndPlay={handleSeekAndPlay}
                      onPause={handlePause}
                      playerIsPlaying={playerIsPlaying}
                    />
                  )}
                  {activeAnnotationType === 'boundaries' && activeBoundarySource === 'autoGuess' && (
                    <AutoGuessPanel
                      ref={autoGuessPanelRef}
                      onCapabilitiesChange={setAutoGuessCaps}
                      songId={selectedAudio.id}
                      currentTime={playerTime}
                      algorithmRows={annotationRows}
                      initialAnnotation={autoGuessAnnotation}
                      onAnnotationChange={setAutoGuessAnnotation}
                      onSeekAndPlay={handleSeekAndPlay}
                      manualSections={manualSections}
                      songInfo={songInfo}
                      onCopyToManualAnnotation={(sections) => {
                        // Append into the song's existing ManualAnnotation
                        // (creating it if absent). Boundaries don't have a
                        // layer-doc home, so this is the canonical target —
                        // parallels DetectorOutputReview's copy-to-layer for
                        // non-boundary detector types.
                        const slug = selectedAudio.id;
                        const existing = manualAnnotationRef.current;
                        const merged: ManualAnnotation = existing
                          ? {
                              ...existing,
                              sections: [...existing.sections, ...sections].sort((a, b) => a.time - b.time),
                              annotated_at: new Date().toISOString(),
                            }
                          : {
                              song: slug,
                              annotated_at: new Date().toISOString(),
                              reviewed: false,
                              sections,
                            };
                        setManualAnnotation(merged);
                        void saveAnnotation(slug, merged);
                      }}
                    />
                  )}
                  {activeAnnotationType === 'cues' && activeSourceByType.cues === 'manual' && (
                    <CueEditorPanel
                      ref={cuesPanelRef}
                      onCapabilitiesChange={setCuesCaps}
                      saveStatus={layersDocSaveStatus}
                      currentTime={playerTime}
                      doc={cueLayersDoc ?? emptyLayersDoc(selectedAudio.id)}
                      onDocChange={setCueLayersDoc}
                      focusedCue={focusedCue}
                      onFocusCue={setFocusedCue}
                      selectedLayerId={selectedCueLayerId}
                      onSelectLayer={setSelectedCueLayerId}
                      snapToGrid={snapToGrid}
                      pendingSelection={pendingAnnotationSelection}
                      onClearPendingSelection={() => {
                        setPendingAnnotationSelection(null);
                        if (previewRegionRef.current) handlePreviewDismiss();
                      }}
                      grid={bpm ? { bpm, beatsPerBar, gridOffsetSec: beatOffset ?? 0 } : null}
                    />
                  )}
                  {activeAnnotationType === 'loops' && activeSourceByType.loops === 'manual' && settings.experimentalLoopsAndPatterns && (
                    <LoopEditorPanel
                      ref={loopsPanelRef}
                      onCapabilitiesChange={setLoopsCaps}
                      saveStatus={layersDocSaveStatus}
                      currentTime={playerTime}
                      duration={duration}
                      doc={cueLayersDoc ?? emptyLayersDoc(selectedAudio.id)}
                      onDocChange={setCueLayersDoc}
                      grid={bpm ? { bpm, beatsPerBar, gridOffsetSec: beatOffset ?? 0 } : null}
                      snapToGrid={snapToGrid}
                      focusedLoop={focusedLoop}
                      onFocusLoop={setFocusedLoop}
                      selectedLayerId={selectedLoopLayerId}
                      onSelectLayer={setSelectedLoopLayerId}
                      playingLoopId={loopPlayback.playingId}
                      onPlayLoop={(id, s, e) => playLoopExclusive(id, s, e, { snapZeroCross: true })}
                      onStopLoop={loopPlayback.stop}
                      pendingSelection={pendingAnnotationSelection}
                      onClearPendingSelection={() => {
                        setPendingAnnotationSelection(null);
                        // Pill and preview are two views of the same span — tear both down together.
                        if (previewRegionRef.current) handlePreviewDismiss();
                      }}
                    />
                  )}
                  {activeAnnotationType === 'spans' && activeSourceByType.spans === 'manual' && (
                    <SpanEditorPanel
                      ref={spansPanelRef}
                      onCapabilitiesChange={setSpansCaps}
                      saveStatus={layersDocSaveStatus}
                      currentTime={playerTime}
                      duration={duration}
                      doc={cueLayersDoc ?? emptyLayersDoc(selectedAudio.id)}
                      onDocChange={setCueLayersDoc}
                      grid={bpm ? { bpm, beatsPerBar, gridOffsetSec: beatOffset ?? 0 } : null}
                      snapToGrid={snapToGrid}
                      focusedSpan={focusedSpan}
                      onFocusSpan={setFocusedSpan}
                      selectedLayerId={selectedSpanLayerId}
                      onSelectLayer={setSelectedSpanLayerId}
                      pendingSelection={pendingAnnotationSelection}
                      onClearPendingSelection={() => {
                        setPendingAnnotationSelection(null);
                        if (previewRegionRef.current) handlePreviewDismiss();
                      }}
                    />
                  )}
                  {activeAnnotationType === 'patterns' && activeSourceByType.patterns === 'manual' && settings.experimentalLoopsAndPatterns && (
                    <PatternEditorPanel
                      ref={patternsPanelRef}
                      onCapabilitiesChange={setPatternsCaps}
                      saveStatus={layersDocSaveStatus}
                      currentTime={playerTime}
                      duration={duration}
                      doc={cueLayersDoc ?? emptyLayersDoc(selectedAudio.id)}
                      onDocChange={setCueLayersDoc}
                      grid={bpm ? { bpm, beatsPerBar, gridOffsetSec: beatOffset ?? 0 } : null}
                      snapToGrid={snapToGrid}
                      focusedPattern={focusedPattern}
                      onFocusPattern={setFocusedPattern}
                      selectedLayerId={selectedPatternLayerId}
                      onSelectLayer={setSelectedPatternLayerId}
                      playingPatternId={(() => {
                        if (!playerIsPlaying) return null;
                        for (const layer of patternLayers) {
                          for (const p of layer.items) {
                            const cycle = p.end - p.start;
                            if (cycle <= 0) continue;
                            const reps = Math.max(1, Math.floor(p.repeatCount));
                            if (playerTime >= p.start && playerTime < p.start + reps * cycle) return p.id;
                          }
                        }
                        return null;
                      })()}
                      onPlayPattern={(_id, start, end) => handleSeekAndPlay(start, end)}
                      onStopPattern={handlePause}
                      pendingSelection={pendingAnnotationSelection}
                      onClearPendingSelection={() => {
                        setPendingAnnotationSelection(null);
                        if (previewRegionRef.current) handlePreviewDismiss();
                      }}
                    />
                  )}
                  </div>
                  )}
                </div>
              )}

              {/* Algo inspect stage */}
              {activeStage === 'algo' && (
                <AlgoInspectStage
                  annotationRows={annotationRows}
                  manualSections={refManualSections}
                  eyeSections={refEyeSections}
                  autoGuessSections={refAutoGuessSections}
                  eyeEnabled={settings.experimentalEyeAnnotation}
                  duration={duration}
                  tolerance={mirTolerance}
                  onToleranceChange={setMirTolerance}
                  currentTime={playerTime}
                  onSeek={handleSeekAndPlay}
                  previewRegion={previewRegion}
                  previewIsPlaying={playerIsPlaying}
                  onOpenPreviewRegion={openPreviewRegion}
                  onPreviewRegionChange={handlePreviewRegionChange}
                  onPreviewPlay={handlePreviewPlay}
                  onPreviewPause={handlePreviewPause}
                  onPreviewLoopToggle={handlePreviewLoopToggle}
                  onPreviewDismiss={handlePreviewDismiss}
                  onPreviewClear={handlePreviewClear}
                />
              )}

              {/* Evaluation stage */}
              {activeStage === 'eval' && (
                <EvaluationStage
                  annotationRows={annotationRows}
                  manualSections={refManualSections}
                  eyeSections={refEyeSections}
                  eyeEnabled={settings.experimentalEyeAnnotation}
                  duration={duration}
                  tolerance={mirTolerance}
                  onToleranceChange={setMirTolerance}
                />
              )}

            </>
          )}
        </div>

          </>
        ) : null}
        </div>

        {/* ── Right sidebar — annotation toolbar (collapsible) ────────────────────
             Holds the per-marker config (Source / Status / Save / Import / Export /
             Undo / Redo / Split / Delete) plus the tabs and Add-pending pill that
             used to live in the "Start annotating" collapsible. The cards / layers
             editor panels stay below the waveform in the centre column. Collapses
             to a hover tab on the right edge; ShortcutsHelpPanel (also fixed-right
             at z-50) overlays this sidebar when the user presses `?`. */}
        {feature === 'annotate' && selectedAudio && annotateSidebarCollapsed && (
          <button
            onClick={() => setAnnotateSidebarCollapsed(false)}
            title="Show annotation tools"
            className="fixed right-0 top-16 z-30 flex items-center gap-1.5 pl-3 pr-2.5 py-2 rounded-l-lg bg-[#1a1f28]/95 backdrop-blur-sm border border-r-0 border-white/15 text-slate-200 hover:text-white hover:bg-[#222833] hover:border-white/25 hover:pr-3.5 transition-all shadow-lg shadow-black/40"
          >
            <span className="text-sm leading-none font-bold">‹</span>
            <span className="text-[11px] uppercase tracking-[0.18em] font-semibold">Annotate</span>
          </button>
        )}
        {feature === 'annotate' && selectedAudio && !annotateSidebarCollapsed && (
          <aside
            style={{ width: annotateSidebarWidth }}
            className={`shrink-0 sticky top-16 self-start h-[calc(100vh-4rem)] border-l border-white/[0.06] bg-[#14171d]/80 backdrop-blur-sm flex flex-col relative`}
          >
            <div
              onMouseDown={startAnnotateSidebarResize}
              onDoubleClick={() => setAnnotateSidebarWidth(ANNOTATE_SIDEBAR_DEFAULT_WIDTH)}
              title="Drag to resize · double-click to reset"
              className={`absolute top-0 left-0 h-full w-1.5 -ml-0.5 cursor-col-resize z-20 group ${annotateSidebarResizing ? 'bg-sky-500/40' : 'hover:bg-sky-500/30'} transition-colors`}
            >
              <div className={`absolute top-0 left-0 h-full w-px ${annotateSidebarResizing ? 'bg-sky-400' : 'bg-transparent group-hover:bg-sky-400/60'}`} />
            </div>
            <div className="flex items-center justify-between gap-2 px-3 h-9 border-b border-white/[0.05] shrink-0">
              <span className="text-[13px] uppercase tracking-[0.18em] text-slate-100 font-bold">Annotate</span>
              <div className="flex items-center gap-1">
                <div className="relative" ref={annotateMenuRef}>
                  <button
                    type="button"
                    onClick={() => setAnnotateMenuOpen((o) => !o)}
                    aria-expanded={annotateMenuOpen}
                    aria-haspopup="menu"
                    title="Export all · Delete all annotations for this track"
                    className={`px-1.5 py-0.5 rounded text-slate-400 hover:text-slate-200 hover:bg-white/[0.05] transition-colors text-sm leading-none ${annotateMenuOpen ? 'bg-white/[0.06] text-slate-200' : ''}`}
                  >
                    ⋯
                  </button>
                  {annotateMenuOpen && (
                    <div
                      role="menu"
                      className="absolute z-50 top-full right-0 mt-1 min-w-[220px] rounded border border-white/[0.08] bg-slate-900 shadow-xl py-1"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => { setAnnotateMenuOpen(false); setExportManagerOpen(true); }}
                        className="w-full text-left px-3 py-1.5 text-[11px] text-slate-300 hover:bg-white/[0.04] transition-colors"
                      >
                        ↓ Export annotations…
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => { setAnnotateMenuOpen(false); setDeleteAllForSongOpen(true); }}
                        title={`Delete every annotation (Manual, Eye, Auto-guess, Cues, Spans, Loops, Patterns) for "${selectedAudio.name}"`}
                        className="w-full text-left px-3 py-1.5 text-[11px] text-red-300 hover:bg-red-500/15 transition-colors"
                      >
                        ✕ Delete all annotations
                      </button>
                    </div>
                  )}
                </div>
                <button
                  onClick={() => setAnnotateSidebarCollapsed(true)}
                  title="Hide annotation tools"
                  className="text-slate-500 hover:text-slate-200 transition-colors text-sm leading-none px-1"
                >
                  ›
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
              {(() => {
                let ref: React.RefObject<AnnotationPanelController | null> | null = null;
                let caps: AnnotationPanelCapabilities | null = null;
                let accent: 'violet' | 'cyan' | 'emerald' | 'fuchsia' = 'violet';
                if (activeAnnotationType === 'boundaries' && activeBoundarySource === 'manual') {
                  ref = manualPanelRef;      caps = manualCaps;      accent = 'violet';
                } else if (activeAnnotationType === 'boundaries' && activeBoundarySource === 'eye') {
                  ref = eyePanelRef;         caps = eyeCaps;         accent = 'cyan';
                } else if (activeAnnotationType === 'boundaries' && activeBoundarySource === 'autoGuess') {
                  ref = autoGuessPanelRef;   caps = autoGuessCaps;   accent = 'violet';
                } else if (activeAnnotationType === 'cues') {
                  ref = cuesPanelRef;        caps = cuesCaps;        accent = 'emerald';
                } else if (activeAnnotationType === 'spans') {
                  ref = spansPanelRef;       caps = spansCaps;       accent = 'emerald';
                } else if (activeAnnotationType === 'loops') {
                  ref = loopsPanelRef;       caps = loopsCaps;       accent = 'fuchsia';
                } else if (activeAnnotationType === 'patterns') {
                  ref = patternsPanelRef;    caps = patternsCaps;    accent = 'fuchsia';
                }
                // The unified all-annotations list always renders. Its
                // `actionsSlot` carries the per-type edit panel, which slots in
                // under the active type's chip-title inside the list. Defined
                // once so both the editor-mounted path and the detector-source
                // (ref null) path reuse the same list.
                const renderList = (actionsSlot: React.ReactNode) => (
                  <UnifiedAnnotationListPanel
                    cueLayersDoc={cueLayersDoc}
                    detectorCueLayers={detectorCueLayers}
                    detectorSpanLayers={detectorSpanLayers}
                    detectorLoopLayers={detectorLoopLayers}
                    detectorPatternLayers={detectorPatternLayers}
                    manualAnnotation={manualAnnotation}
                    eyeAnnotation={eyeAnnotation}
                    autoGuessAnnotation={autoGuessAnnotation}
                    customDetectors={customDetectors}
                    customResults={customResults}
                    activeAnnotationType={activeAnnotationType}
                    onSelectType={(next) => {
                      setActiveAnnotationType(next);
                      // Drop the violet pending pill when the new type can't
                      // consume it (mirrors the old top TabGroup's onChange).
                      if (!supportsPending(next, activeBoundarySource ?? undefined)) {
                        setPendingAnnotationSelection(null);
                      }
                    }}
                    onSeekAndPlay={handleSeekAndPlay}
                    focusedCue={focusedCue}
                    onFocusCue={setFocusedCue}
                    focusedSpan={focusedSpan}
                    onFocusSpan={setFocusedSpan}
                    focusedLoop={focusedLoop}
                    onFocusLoop={setFocusedLoop}
                    focusedPattern={focusedPattern}
                    onFocusPattern={setFocusedPattern}
                    onItemDelete={handleUnifiedItemDelete}
                    onItemToggleImportance={handleUnifiedItemToggleImportance}
                    selectedLayerIdByType={selectedLayerIdByType}
                    onSelectLayer={handleUnifiedSelectLayer}
                    experimentalLoopsAndPatterns={settings.experimentalLoopsAndPatterns}
                    experimentalEyeAnnotation={settings.experimentalEyeAnnotation}
                    actionsSlot={actionsSlot}
                  />
                );
                if (!ref) return renderList(null);
                const layerType = activeAnnotationType === 'cues' || activeAnnotationType === 'spans'
                  || activeAnnotationType === 'loops' || activeAnnotationType === 'patterns';
                // For layer types, the per-source editor only mounts when source ===
                // 'manual'. If we still showed `caps` from a previous Manual mount,
                // the marker panel would render an Add/Status/Export chip whose click
                // targets a now-null ref — a silent no-op the user (correctly) read
                // as a bug. Force empty caps unless the editor is actually mounted.
                const category: AnnotationCategory = activeAnnotationType;
                const editorIsMounted = layerType
                  ? activeSourceByType[category] === 'manual'
                  : true;
                const c = (editorIsMounted ? caps : null) ?? emptyCapabilities();
                const controllerRef = ref;
                const onImport = (fmt: ImportFormat, file: File) => {
                  const ctl = controllerRef.current; if (!ctl) return;
                  if (fmt === 'json' && ctl.importJson) void ctl.importJson(file);
                  else if (fmt === 'audacity' && ctl.importAudacity) void ctl.importAudacity(file);
                  else if (fmt === 'csv' && ctl.importCsv) void ctl.importCsv(file);
                  else if (fmt === 'jams' && ctl.importJams) void ctl.importJams(file);
                  else if (fmt === 'lab' && ctl.importLab) void ctl.importLab(file);
                };
                // Single-click export for the active marker only. Layer types
                // (cues/spans/loops/patterns) own a JSON-only export via their
                // controller — filenames already carry `all_layers`. Manual /
                // Eye / Auto-guess get a direct JSON download here so the
                // marker panel's `↓ Export` never opens a modal; the full
                // multi-scope Export Manager stays in the section header.
                const onExport: (() => void) | undefined = (() => {
                  if (layerType) {
                    return () => controllerRef.current?.exportJson?.();
                  }
                  if (activeAnnotationType === 'boundaries' && activeBoundarySource === 'manual') {
                    return () => {
                      if (!manualAnnotation) return;
                      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
                      downloadJson(`manual-${selectedAudio.id}-${stamp}.json`, manualAnnotation);
                    };
                  }
                  if (activeAnnotationType === 'boundaries' && activeBoundarySource === 'eye') {
                    return () => {
                      if (!eyeAnnotation) return;
                      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
                      downloadJson(`eye-${selectedAudio.id}-${stamp}.json`, eyeAnnotation);
                    };
                  }
                  if (activeAnnotationType === 'boundaries' && activeBoundarySource === 'autoGuess') {
                    return () => {
                      if (!autoGuessAnnotation) return;
                      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
                      downloadJson(`auto-guess-${selectedAudio.id}-${stamp}.json`, autoGuessAnnotation);
                    };
                  }
                  return undefined;
                })();

                // Source picker options for the active category — Manual + (Eye on
                // boundaries when experimental) + Auto-guess (real on boundaries,
                // stub elsewhere) + one entry per matching custom detector.
                const matchingDetectors = customDetectors.filter((det) =>
                  det.is_annotation
                  && det.status === 'ok'
                  && customDetectorMatchesCategory(det.output_kind, category),
                );
                const sourceOptions: SourceOption[] = [
                  { id: 'manual', label: 'Manual' },
                  ...(category === 'boundaries' && settings.experimentalEyeAnnotation
                    ? [{ id: 'eye' as SourceId, label: 'Eye', experimental: true }]
                    : []),
                  { id: 'autoGuess', label: 'Auto-guess', comingSoon: category !== 'boundaries' },
                  ...matchingDetectors.map<SourceOption>((det) => ({
                    id: `detector:${det.name}` as SourceId,
                    label: det.label,
                    inProgress: !!(selectedAudio?.id
                      && detectorOutputIndex[det.name]?.includes(selectedAudio.id)),
                  })),
                ];
                const sourceValue = activeSourceByType[category];

                // Recording timer. Per-type time tracking: boundary sources key
                // on the active source (Manual / Eye / Auto-guess); the layer
                // types (cues/spans/loops/patterns) key on the type itself.
                // `annotationTimesTotal` carries a running total for every key,
                // so the timer follows whichever type is currently active.
                const timerKey: TimerKey | null =
                  activeAnnotationType === 'boundaries'
                    ? activeBoundarySource
                    : (activeAnnotationType === 'cues' || activeAnnotationType === 'spans'
                       || activeAnnotationType === 'loops' || activeAnnotationType === 'patterns')
                      ? activeAnnotationType
                      : null;
                const timerSlot = timerKey ? (() => {
                  const singleDocKey: TimerKey = timerKey;
                  const sessionType = annotationSessionTypeRef.current;
                  const isRunningActive = sessionType === singleDocKey;
                  const activeTime = annotationTimesTotal[singleDocKey];
                  const hasActiveTime = activeTime > 0;
                  return (
                    <>
                      <span className={`font-mono tabular-nums text-[11px] ${isRunningActive ? 'text-emerald-400' : 'text-slate-200'}`}>
                        {fmtAnnotationTime(activeTime)}
                      </span>
                      {isRunningActive ? (
                        <button
                          onClick={() => pauseAnnotationTimer(selectedAudio.id)}
                          className="px-2 py-0.5 rounded text-[11px] bg-red-500/15 hover:bg-red-500/25 text-red-300 transition-colors"
                        >■ Stop</button>
                      ) : (
                        <button
                          onClick={() => {
                            if (annotationSessionStartRef.current !== null) pauseAnnotationTimer(selectedAudio.id);
                            startAnnotationTimer(singleDocKey);
                          }}
                          className="px-2 py-0.5 rounded text-[11px] bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 transition-colors"
                        >{hasActiveTime ? '▶' : '●'} Record</button>
                      )}
                      {hasActiveTime && (
                        <button
                          onClick={() => {
                            if (annotationSessionTypeRef.current === singleDocKey) {
                              annotationSessionStartRef.current = null;
                              annotationSessionTypeRef.current = null;
                              setTimerRunning(false);
                            }
                            setAnnotationTimesSaved((prev) => {
                              const next = { ...prev, [singleDocKey]: 0 };
                              saveAnnotationTimes(selectedAudio.id, next);
                              return next;
                            });
                          }}
                          title="Reset time to 0"
                          className="px-1.5 py-0.5 rounded text-[11px] text-slate-500 hover:text-slate-300 hover:bg-white/[0.04] transition-colors"
                        >↺</button>
                      )}
                    </>
                  );
                })() : null;

                // Undo/redo: layer-typed panels (cues / spans / loops /
                // patterns) share the page-level layers document's history;
                // boundary panels own their own. The caps coming back from the
                // layer panels always report false, so override here.
                const isLayerType =
                  activeAnnotationType === 'cues' ||
                  activeAnnotationType === 'spans' ||
                  activeAnnotationType === 'loops' ||
                  activeAnnotationType === 'patterns';
                const onUndo = isLayerType
                  ? () => cueLayersDocCtl.undo()
                  : () => controllerRef.current?.undo?.();
                const onRedo = isLayerType
                  ? () => cueLayersDocCtl.redo()
                  : () => controllerRef.current?.redo?.();
                const canUndo = isLayerType ? cueLayersDocCtl.canUndo : c.canUndo;
                const canRedo = isLayerType ? cueLayersDocCtl.canRedo : c.canRedo;
                // Detector sources don't mount the layer editor, so `c.hasItems`
                // is always false; override → true while running / after a
                // result so the StatusPill reads "In progress" not "Not started".
                const detectorName = sourceValue.startsWith('detector:')
                  ? sourceValue.slice('detector:'.length)
                  : null;
                const detectorHasItems = detectorName !== null
                  && (customRunning.has(detectorName) || !!customResults[detectorName]);
                const pillHasItems = c.hasItems || detectorHasItems;

                // Add-mode hint (how to add to the active type). Travels with
                // the add controls inside the actions panel under the chip.
                const hintNode = supportsPending(activeAnnotationType, activeBoundarySource ?? undefined) && !pendingAnnotationSelection ? (
                  <span className="text-[10px] text-slate-500">
                    {activeAnnotationType === 'loops'
                      ? 'Drag the visualization to select a loop region.'
                      : activeAnnotationType === 'spans'
                        ? 'Drag the visualization to select a span region.'
                        : activeAnnotationType === 'patterns'
                          ? 'Drag the visualization to select one cycle of the pattern.'
                          : 'Click the visualization to place a boundary at the cursor.'}
                  </span>
                ) : null;

                // Top: Info panel (title · status · timer · ⋯ source). The
                // Actions panel (every edit verb) is handed to the list as
                // `actionsSlot`, so it renders under the active type's chip.
                return (
                  <>
                      <MarkerConfigPanel
                        typeTitle={TAB_CONFIG.find((t) => t.id === activeAnnotationType)?.label ?? ''}
                        status={c.status}
                        hasItems={pillHasItems}
                        saveStatus={c.saveStatus}
                        sourceSlot={(
                          <AnnotationSourcePicker
                            category={category}
                            value={sourceValue}
                            options={sourceOptions}
                            onChange={(next) => {
                              setActiveSourceByType((prev) => ({ ...prev, [category]: next }));
                              if (next !== 'manual') {
                                setPendingAnnotationSelection(null);
                              }
                            }}
                          />
                        )}
                        timerSlot={timerSlot}
                        ioSlot={(() => {
                          // Import / Export moved here from the actions row so
                          // that row stays a compact single line. Import hides
                          // for detector sources (re-run produces their data).
                          const showImport = !sourceValue.startsWith('detector:') && c.importFormats.length > 0;
                          if (!showImport && !onExport) return undefined;
                          return (
                            <>
                              {showImport && <ImportMenu formats={c.importFormats} onImport={onImport} />}
                              {onExport && <ExportButton onExport={onExport} canExport={c.canExport} />}
                            </>
                          );
                        })()}
                        onStatusChange={(s) => controllerRef.current?.setStatus?.(s)}
                        onRerunDetector={(() => {
                          if (!sourceValue.startsWith('detector:')) return undefined;
                          const detectorName = sourceValue.slice('detector:'.length);
                          const slug = selectedAudio.id;
                          return () => rerunDetectorForCurrentSong(detectorName, slug);
                        })()}
                        rerunBusy={
                          sourceValue.startsWith('detector:')
                          && customRunning.has(sourceValue.slice('detector:'.length))
                        }
                      />
                      {renderList(
                        <div className="space-y-2">
                          {hintNode}
                          <MarkerActionsPanel
                        {...c}
                        canUndo={canUndo}
                        canRedo={canRedo}
                        canMarkOut={canMarkOutNow}
                        onUndo={onUndo}
                        onRedo={onRedo}
                        onSplit={() => controllerRef.current?.split?.()}
                        onMarkIn={handleMarkIn}
                        onMarkOut={handleMarkOut}
                        onDeleteAll={() => setDeleteActiveOpen(true)}
                        addSlot={(
                          <AnnotationAddPanel
                            pending={pendingAnnotationSelection}
                            pendingRequiresRegion={false}
                            onConfirmPending={() => controllerRef.current?.confirmPending?.()}
                            onClearPending={() => {
                              setPendingAnnotationSelection(null);
                              // Pill and preview are two views of the same span — tear both down together.
                              if (previewRegionRef.current) handlePreviewDismiss();
                            }}
                            addAtPlayhead={c.canAddAtPlayhead ? {
                              label: c.addLabel,
                              onAdd: () => controllerRef.current?.addAtPlayhead?.(),
                            } : undefined}
                            layerPicker={(() => {
                              // Layer-typed panels (cues/spans/loops/patterns) expose a picker —
                              // Manual/Eye/Auto-guess have no per-type layers, so omit.
                              if (activeAnnotationType === 'cues') {
                                return {
                                  options: (cueLayers ?? []).map((l) => ({ id: l.id, name: l.name, color: l.color })),
                                  selectedLayerId: selectedCueLayerId,
                                  onAddAtPlayheadInLayer: (id) => {
                                    setSelectedCueLayerId(id);
                                    controllerRef.current?.addAtPlayheadInLayer?.(id);
                                  },
                                  onConfirmPendingInLayer: (id) => {
                                    setSelectedCueLayerId(id);
                                    controllerRef.current?.confirmPendingInLayer?.(id);
                                  },
                                };
                              }
                              if (activeAnnotationType === 'spans') {
                                return {
                                  options: spanLayers.map((l) => ({ id: l.id, name: l.name, color: l.color })),
                                  selectedLayerId: selectedSpanLayerId,
                                  onAddAtPlayheadInLayer: (id) => {
                                    setSelectedSpanLayerId(id);
                                    controllerRef.current?.addAtPlayheadInLayer?.(id);
                                  },
                                  onConfirmPendingInLayer: (id) => {
                                    setSelectedSpanLayerId(id);
                                    controllerRef.current?.confirmPendingInLayer?.(id);
                                  },
                                };
                              }
                              if (activeAnnotationType === 'loops') {
                                return {
                                  options: loopLayers.map((l) => ({ id: l.id, name: l.name, color: l.color })),
                                  selectedLayerId: selectedLoopLayerId,
                                  onAddAtPlayheadInLayer: (id) => {
                                    setSelectedLoopLayerId(id);
                                    controllerRef.current?.addAtPlayheadInLayer?.(id);
                                  },
                                  onConfirmPendingInLayer: (id) => {
                                    setSelectedLoopLayerId(id);
                                    controllerRef.current?.confirmPendingInLayer?.(id);
                                  },
                                };
                              }
                              if (activeAnnotationType === 'patterns') {
                                return {
                                  options: patternLayers.map((l) => ({ id: l.id, name: l.name, color: l.color })),
                                  selectedLayerId: selectedPatternLayerId,
                                  onAddAtPlayheadInLayer: (id) => {
                                    setSelectedPatternLayerId(id);
                                    controllerRef.current?.addAtPlayheadInLayer?.(id);
                                  },
                                  onConfirmPendingInLayer: (id) => {
                                    setSelectedPatternLayerId(id);
                                    controllerRef.current?.confirmPendingInLayer?.(id);
                                  },
                                };
                              }
                              return undefined;
                            })()}
                            accent={accent}
                          />
                        )}
                        fillSlot={c.canFillDefaults ? (
                          // Bulk-fill setup (Manual boundaries only). The panel
                          // exposes `fillDefaults` / `chooseStructure` on its
                          // controller and flips `canFillDefaults` to true once
                          // BPM is known; other types leave it false and these
                          // buttons stay hidden.
                          <div className="flex-1 flex items-stretch gap-1">
                            <button
                              type="button"
                              onClick={() => controllerRef.current?.fillDefaults?.()}
                              title={`${c.fillDefaultsLabel} — ${c.fillDefaultsTooltip || 'Pre-fill with your saved default layout'}`}
                              className="flex-1 flex items-center justify-center px-2 py-1 text-[13px] leading-none rounded border border-amber-400/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 transition-colors"
                            >
                              ⚡
                            </button>
                            <button
                              type="button"
                              onClick={() => controllerRef.current?.chooseStructure?.()}
                              title="Choose structure — pick a different layout (genre preset, equal bars, or a custom list)"
                              className="flex-1 flex items-center justify-center px-2 py-1 text-[13px] leading-none rounded border border-amber-400/30 bg-white/[0.04] text-amber-200/90 hover:bg-white/[0.08] transition-colors"
                            >
                              ≡
                            </button>
                          </div>
                        ) : undefined}
                        addLayerSlot={(
                          // Unified "+ Add layer" — identical button across every
                          // annotation type. Enabled for layer-typed panels
                          // (cues/spans/loops/patterns) which expose `addLayer`
                          // via the controller; rendered disabled with a tooltip
                          // on the Boundary sources (manual/eye/autoGuess) where
                          // the data model is still single-doc per source.
                          <button
                            type="button"
                            onClick={() => controllerRef.current?.addLayer?.()}
                            disabled={!c.canAddLayer}
                            title={c.canAddLayer
                              ? 'Add layer — create a new empty layer of this type'
                              : 'Boundaries live in a single layer for now — multi-layer support coming soon.'}
                            className={`flex-1 flex items-center justify-center px-2 py-1 rounded text-[14px] leading-none font-semibold border transition-colors ${
                              c.canAddLayer
                                ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/25 hover:border-emerald-400/70 hover:text-white'
                                : 'border-white/[0.04] bg-white/[0.01] text-slate-700 cursor-not-allowed'
                            }`}
                          >
                            ⊞
                          </button>
                        )}
                          />
                        </div>
                      )}
                  </>
                );
              })()}
            </div>
          </aside>
        )}

        {/* ── Right sidebar — Algorithm Inspector controls (collapsible) ────────
             Lists every registered algorithm (MSAF / All-In-One / Ruptures /
             band-gradient / custom) with cached badges + checkboxes that drive
             the per-song run, and surfaces the ▶ Run for this song button.
             Selection is shared with Dataset Prep's ⚙ Batch algorithm options
             so it stays the single source of truth. Collapses to a hover tab
             on the right edge, same geometry as the Annotate sidebar. */}
        {feature === 'inspect-song' && activeStage === 'algo' && selectedAudio && algoSidebarCollapsed && (
          <button
            onClick={() => setAlgoSidebarCollapsed(false)}
            title="Show algorithms panel"
            className="fixed right-0 top-16 z-30 flex items-center gap-1.5 pl-3 pr-2.5 py-2 rounded-l-lg bg-[#1a1f28]/95 backdrop-blur-sm border border-r-0 border-white/15 text-slate-200 hover:text-white hover:bg-[#222833] hover:border-white/25 hover:pr-3.5 transition-all shadow-lg shadow-black/40"
          >
            <span className="text-sm leading-none font-bold">‹</span>
            <span className="text-[11px] uppercase tracking-[0.18em] font-semibold">Algorithms</span>
          </button>
        )}
        {feature === 'inspect-song' && activeStage === 'algo' && selectedAudio && !algoSidebarCollapsed && (() => {
          const isRunning = runJob?.status === 'running';
          const noneSelected = selectedAlgorithms.size === 0;
          const runDisabled = isRunning || noneSelected;
          return (
            <aside
              style={{ width: algoSidebarWidth }}
              className="shrink-0 sticky top-16 self-start h-[calc(100vh-4rem)] border-l border-white/[0.06] bg-[#14171d]/80 backdrop-blur-sm flex flex-col relative"
            >
              <div
                onMouseDown={startAlgoSidebarResize}
                onDoubleClick={() => setAlgoSidebarWidth(ALGO_SIDEBAR_DEFAULT_WIDTH)}
                title="Drag to resize · double-click to reset"
                className={`absolute top-0 left-0 h-full w-1.5 -ml-0.5 cursor-col-resize z-20 group ${algoSidebarResizing ? 'bg-violet-500/40' : 'hover:bg-violet-500/30'} transition-colors`}
              >
                <div className={`absolute top-0 left-0 h-full w-px ${algoSidebarResizing ? 'bg-violet-400' : 'bg-transparent group-hover:bg-violet-400/60'}`} />
              </div>
              <div className="flex items-center justify-between gap-2 px-3 h-9 border-b border-white/[0.05] shrink-0">
                <span className="text-[10px] uppercase tracking-[0.18em] text-slate-400 font-semibold">Algorithms</span>
                <button
                  onClick={() => setAlgoSidebarCollapsed(true)}
                  title="Hide algorithms panel"
                  className="text-slate-500 hover:text-slate-200 transition-colors text-sm leading-none px-1"
                >
                  ›
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
                <button
                  onClick={handleRunForCurrentSong}
                  disabled={runDisabled}
                  title={
                    noneSelected
                      ? 'Tick at least one algorithm below to enable the run'
                      : 'Runs the ticked algorithms on this song only. Algorithms with cached results are skipped — only the missing ones are computed. To force a re-run, delete the cached JSON for that algorithm first.'
                  }
                  className={`w-full px-3 py-2 rounded text-[11px] uppercase tracking-wider border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                    isRunning
                      ? 'border-emerald-500/60 bg-emerald-500/20 text-emerald-100'
                      : 'border-violet-500/40 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20 hover:border-violet-500/60 hover:text-violet-100'
                  }`}
                >
                  {isRunning
                    ? '⏳ Running…'
                    : `▶ Run ${selectedAlgorithms.size || ''} algorithm${selectedAlgorithms.size === 1 ? '' : 's'} for this song`}
                </button>
                {renderRunOptionsPanel(true)}
              </div>
            </aside>
          );
        })()}
      </div>

      <ShortcutsHelpPanel
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        shortcuts={shortcuts}
        accentText={FEATURE_THEME[feature].label}
      />

      {selectedAudio && (() => {
        const typeLabels: Record<AnnotationType, string> = { manual: 'Boundaries', eye: 'Eye', autoGuess: 'Auto-guess', cues: 'Cues', spans: 'Spans', loops: 'Loops', patterns: 'Patterns' };
        return (
          <DeleteConfirmDialog
            open={deleteActiveOpen}
            onOpenChange={setDeleteActiveOpen}
            title={`Delete ${typeLabels[activeAnnotationType]} annotation?`}
            description={`The ${typeLabels[activeAnnotationType]} annotation for "${selectedAudio.name}" will be permanently removed. This cannot be undone.`}
            onConfirm={performDeleteActive}
          />
        );
      })()}

      {selectedAudio && (
        <DeleteConfirmDialog
          open={deleteAllForSongOpen}
          onOpenChange={setDeleteAllForSongOpen}
          title={`Delete ALL annotations for "${selectedAudio.name}"?`}
          description={`Every annotation for this song — Manual, Eye, Auto-guess, and all user-created Cues / Spans / Loops / Patterns layers — will be permanently removed. Other songs are not touched. This cannot be undone.`}
          confirmWord="DELETE_ALL"
          onConfirm={performDeleteAllForSong}
        />
      )}

      <ImportDatasetDialog
        open={importDatasetOpen}
        onOpenChange={setImportDatasetOpen}
        onImported={async () => {
          // After a successful import the manifest, per-song info, and
          // annotation-status maps are stale. Refetch the same way the upload
          // flow does — the sidebar will pick up the new rows on next render.
          try {
            const refreshed = await fetchManifest();
            setAudioFiles(refreshed);
          } catch { /* leave the sidebar as-is on transient errors */ }
          loadAllStatuses().then(setSongStatuses).catch(() => null);
          loadAllLayerStatuses().then(setSongLayerStatuses).catch(() => null);
        }}
      />

      <ExportManagerModal
        open={exportManagerOpen}
        onOpenChange={setExportManagerOpen}
        currentSong={selectedAudio ? { id: selectedAudio.id, name: selectedAudio.name, url: selectedAudio.url } : null}
        allSongs={audioFiles.map((f) => ({ id: f.id, name: f.name, url: f.url }))}
        manualAnnotation={manualAnnotation}
        eyeAnnotation={eyeAnnotation}
        autoGuessAnnotation={autoGuessAnnotation}
        layersDocument={cueLayersDoc}
        // /prep is the only place where multi-song / bucket controls make
        // sense ("Full annotation export"). Everywhere else (the toolbar's
        // per-type Export, the annotate-sidebar ⋯ menu) is locked to the
        // current track.
        presentation={mode === 'prep' ? 'multi' : 'single'}
      />

      <DeleteConfirmDialog
        open={pendingSongDelete !== null}
        onOpenChange={(open) => { if (!open) setPendingSongDelete(null); }}
        title={pendingSongDelete === 'all' ? 'Delete ALL songs?' : 'Delete song?'}
        description={pendingSongDelete === 'all'
          ? `Every song in the dataset (${audioFiles.length}) will be permanently removed from disk along with its audio file. Annotations stored elsewhere are not touched.`
          : pendingSongDelete
            ? `"${pendingSongDelete.name}" will be permanently removed from the dataset. Its audio file is deleted from disk; annotations stored elsewhere are not touched.`
            : ''}
        confirmWord={pendingSongDelete === 'all' ? 'DELETE_ALL' : 'DELETE_SONG'}
        onConfirm={async () => {
          if (pendingSongDelete === 'all') await handleDeleteSong('all');
          else if (pendingSongDelete) await handleDeleteSong(pendingSongDelete.id);
          setPendingSongDelete(null);
        }}
      />

      {(() => {
        if (pendingCacheClear === null) return null;
        const isAll = pendingCacheClear === 'all';
        const songEntry = !isAll ? audioFiles.find((f) => f.id === pendingCacheClear) : null;
        const songStats = !isAll ? storageStats?.perSong.find((s) => s.slug === pendingCacheClear) : null;
        const bytes = isAll
          ? (storageStats?.totals.cacheBytes ?? 0)
          : (songStats?.cacheBytes ?? 0);
        const subjectName = isAll ? `all ${audioFiles.length} songs` : (songEntry?.name ?? 'song');
        return (
          <DeleteConfirmDialog
            open={pendingCacheClear !== null}
            onOpenChange={(open) => { if (!open) setPendingCacheClear(null); }}
            title={isAll ? 'Clear ALL caches?' : 'Clear caches for this song?'}
            description={
              `This frees ${formatBytes(bytes)} for ${subjectName} by deleting regenerable caches: ` +
              `Demucs stems, allin1/MSAF/ruptures outputs, BPM cache, algorithm clusters, MIR features, and custom-script results. ` +
              `Annotations and audio files are NOT touched. Re-running the algorithms will recreate the caches.`
            }
            confirmWord={isAll ? 'CLEAR_ALL_CACHES' : 'CLEAR_CACHE'}
            onConfirm={async () => {
              if (isAll) await handleClearAllCaches();
              else if (pendingCacheClear) await handleClearSongCaches(pendingCacheClear);
              setPendingCacheClear(null);
            }}
          />
        );
      })()}

      {/* Tri-mode clear dialog for /prep (STEM · ALGOS · EVERYTHING).
          Opened from the per-song ⌫ button in the sidebar; the radio + typed
          confirmation lives inside the dialog. EVERYTHING is irreversible and
          wipes audio + every annotator's annotations + all caches. */}
      {pendingClearScope !== null && (() => {
        const songEntry = audioFiles.find((f) => f.id === pendingClearScope);
        const songStats = storageStats?.perSong.find((s) => s.slug === pendingClearScope) ?? null;
        return (
          <ClearScopeDialog
            open={pendingClearScope !== null}
            onOpenChange={(open) => { if (!open) setPendingClearScope(null); }}
            songName={songEntry?.name ?? pendingClearScope}
            storage={songStats}
            isDemo={isDemo}
            onConfirm={async (scope) => {
              await handleClearScopeForSong(pendingClearScope, scope);
              setPendingClearScope(null);
            }}
          />
        );
      })()}

      {bpmWarningSong && (
        <BpmWarningDialog
          open={bpmWarningSong !== null}
          onOpenChange={(open) => { if (!open) setBpmWarningSong(null); }}
          songName={bpmWarningSong.name}
          onContinue={() => {
            const song = bpmWarningSong;
            setBpmWarningSong(null);
            selectAudio(song);
            setActionsOpenSlug((prev) => (prev === song.id ? null : song.id));
          }}
          onGoToPrep={() => {
            const song = bpmWarningSong;
            setBpmWarningSong(null);
            selectAudio(song);
            navigate('/prep');
          }}
        />
      )}

      {postUploadGuide && (
        <PostUploadGuideDialog
          open={postUploadGuide !== null}
          onOpenChange={(open) => { if (!open) setPostUploadGuide(null); }}
          songName={postUploadGuide.name}
          count={postUploadGuide.count}
          onOpenAnnotator={() => {
            setPostUploadGuide(null);
            navigate('/annotate');
          }}
        />
      )}

      {/* Floating Cue edit popover (opened by clicking a tick on a cue-layer row).
          Looks up the layer in BOTH user-created layers (editable) and detector-
          sourced layers (read-only). For read-only layers, onChange/onDelete
          become no-ops; CueEditPopover hides the controls. */}
      {cuePopover.open && (() => {
        const userLayer = cueLayersDoc?.layers.find((l) => l.id === cuePopover.open!.layerId) as AnnotationLayer<'cues'> | undefined;
        const detLayer  = detectorCueLayers.find((l) => l.id === cuePopover.open!.layerId);
        const layer = userLayer ?? detLayer;
        const cue: CueItem | undefined = layer?.items.find((it) => it.id === cuePopover.open!.itemId);
        if (!layer || !cue) return null;
        const isReadOnly = layer.readOnly === true;
        const onChange = isReadOnly ? () => {} : (patch: Partial<CueItem>) => {
          setCueLayersDoc((d) => d && ({
            ...d,
            layers: d.layers.map((l) =>
              l.id === layer.id
                ? { ...l, items: l.items.map((it) => (it.id === cue.id ? { ...it, ...patch } : it)) }
                : l,
            ),
          }));
        };
        const onDelete = isReadOnly ? () => {} : () => {
          setCueLayersDoc((d) => d && ({
            ...d,
            layers: d.layers.map((l) =>
              l.id === layer.id ? { ...l, items: l.items.filter((it) => it.id !== cue.id) } : l,
            ),
          }));
        };
        const cueIsPlaying = playerIsPlaying && playerTime >= cue.time && playerTime < cue.time + 0.5;
        return (
          <CueEditPopover
            layer={layer}
            cue={cue}
            readOnly={isReadOnly}
            popoverRef={cuePopover.popoverRef}
            positionStyle={cuePopover.positionStyle}
            onChange={onChange}
            onDelete={onDelete}
            onClose={cuePopover.close}
            onPlay={() => handleSeekAndPlay(cue.time, cue.time + 0.5)}
            onStop={handlePause}
            isPlaying={cueIsPlaying}
            bpm={bpm}
            gridOffset={songInfo?.gridOffset ?? 0}
            beatsPerBar={beatsPerBar}
            anchors={effectiveAnchors(songInfo)}
            currentTime={playerTime}
          />
        );
      })()}

      {/* Floating Span edit popover (opened by clicking a band on a span-layer row). */}
      {spanPopover.open && (() => {
        const layer = cueLayersDoc?.layers.find((l) => l.id === spanPopover.open!.layerId) as AnnotationLayer<'spans'> | undefined;
        const span = layer?.items.find((it) => it.id === spanPopover.open!.itemId);
        if (!layer || !span) return null;
        const onChange = (patch: Partial<SpanItem>) => {
          setCueLayersDoc((d) => d && ({
            ...d,
            layers: d.layers.map((l) =>
              l.id === layer.id
                ? { ...l, items: l.items.map((it) => (it.id === span.id ? { ...it, ...patch } : it)) }
                : l,
            ),
          }));
        };
        const onDelete = () => {
          setCueLayersDoc((d) => d && ({
            ...d,
            layers: d.layers.map((l) =>
              l.id === layer.id ? { ...l, items: l.items.filter((it) => it.id !== span.id) } : l,
            ),
          }));
        };
        const spanIsPlaying = playerIsPlaying && playerTime >= span.start && playerTime < span.end;
        return (
          <SpanEditPopover
            layer={layer}
            span={span}
            popoverRef={spanPopover.popoverRef}
            positionStyle={spanPopover.positionStyle}
            onChange={onChange}
            onDelete={onDelete}
            onClose={spanPopover.close}
            onPlay={() => handleSeekAndPlay(span.start, span.end)}
            onStop={handlePause}
            isPlaying={spanIsPlaying}
            bpm={bpm}
            gridOffset={songInfo?.gridOffset ?? 0}
            beatsPerBar={beatsPerBar}
            anchors={effectiveAnchors(songInfo)}
            currentTime={playerTime}
          />
        );
      })()}

      {/* Floating Loop edit popover (opened by clicking a band on a loop-layer row). */}
      {loopPopover.open && (() => {
        const layer = cueLayersDoc?.layers.find((l) => l.id === loopPopover.open!.layerId) as AnnotationLayer<'loops'> | undefined;
        const loop = layer?.items.find((it) => it.id === loopPopover.open!.itemId);
        if (!layer || !loop) return null;
        const onChange = (patch: Partial<LoopItem>) => {
          setCueLayersDoc((d) => d && ({
            ...d,
            layers: d.layers.map((l) =>
              l.id === layer.id
                ? { ...l, items: l.items.map((it) => (it.id === loop.id ? { ...it, ...patch } : it)) }
                : l,
            ),
          }));
        };
        const onDelete = () => {
          setCueLayersDoc((d) => d && ({
            ...d,
            layers: d.layers.map((l) =>
              l.id === layer.id ? { ...l, items: l.items.filter((it) => it.id !== loop.id) } : l,
            ),
          }));
        };
        const loopIsPlaying = loopPlayback.playingId === loop.id;
        return (
          <LoopEditPopover
            layer={layer}
            loop={loop}
            popoverRef={loopPopover.popoverRef}
            positionStyle={loopPopover.positionStyle}
            onChange={onChange}
            onDelete={onDelete}
            onClose={loopPopover.close}
            onPlay={() => playLoopExclusive(loop.id, loop.start, loop.end, { snapZeroCross: true })}
            onStop={loopPlayback.stop}
            isPlaying={loopIsPlaying}
            bpm={bpm}
            gridOffset={songInfo?.gridOffset ?? 0}
            beatsPerBar={beatsPerBar}
            anchors={effectiveAnchors(songInfo)}
            currentTime={playerTime}
          />
        );
      })()}

      {/* Floating Pattern edit popover (opened by clicking a tile on a pattern-layer row). */}
      {patternPopover.open && (() => {
        const layer = cueLayersDoc?.layers.find((l) => l.id === patternPopover.open!.layerId) as AnnotationLayer<'patterns'> | undefined;
        const pattern = layer?.items.find((it) => it.id === patternPopover.open!.itemId);
        if (!layer || !pattern) return null;
        const onChange = (patch: Partial<PatternItem>) => {
          setCueLayersDoc((d) => d && ({
            ...d,
            layers: d.layers.map((l) =>
              l.id === layer.id
                ? { ...l, items: l.items.map((it) => (it.id === pattern.id ? { ...it, ...patch } : it)) }
                : l,
            ),
          }));
        };
        const onDelete = () => {
          setCueLayersDoc((d) => d && ({
            ...d,
            layers: d.layers.map((l) =>
              l.id === layer.id ? { ...l, items: l.items.filter((it) => it.id !== pattern.id) } : l,
            ),
          }));
        };
        const cycle = Math.max(0, pattern.end - pattern.start);
        const reps  = Math.max(1, Math.floor(pattern.repeatCount));
        const regionEnd = pattern.start + reps * cycle;
        const patternIsPlaying = playerIsPlaying && playerTime >= pattern.start && playerTime < regionEnd;
        return (
          <PatternEditPopover
            layer={layer}
            pattern={pattern}
            beatsPerBar={beatsPerBar}
            popoverRef={patternPopover.popoverRef}
            positionStyle={patternPopover.positionStyle}
            onChange={onChange}
            onDelete={onDelete}
            onClose={patternPopover.close}
            onPlay={() => handleSeekAndPlay(pattern.start, regionEnd)}
            onStop={handlePause}
            isPlaying={patternIsPlaying}
            bpm={bpm}
            gridOffset={songInfo?.gridOffset ?? 0}
            anchors={effectiveAnchors(songInfo)}
            currentTime={playerTime}
          />
        );
      })()}
    </div>
  );
}
