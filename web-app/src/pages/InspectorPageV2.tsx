import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, Fragment, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { parseViewUrl, writeViewUrl, URL_LAYERS, URL_SIGNALS, type UrlLayer, type UrlSignal, type ViewUrlState } from '../utils/viewUrl';
import { SharedVizPanel, DEFAULT_FIXED_ROW_ORDER, BEAT_GRID_UNIT_OPTIONS, type MirCurves, type BeatGridUnit, type VizRowId, type AlgoOverlay, type BoundaryColoringMode } from '../components/inspector-v2/SharedVizPanel';
import { moveRowInOrder } from '../components/inspector-v2/layerGroupRows';
import type { LayerAudioConfig } from '../components/inspector-v2/LayerAudioControls';
import type { PlayerAccent, ZoomToRange } from '../components/PlayerPanel';
import { VizControlBar } from '../components/inspector-v2/VizControlBar';
import { BoundaryEditorPanel } from '../components/inspector-v2/BoundaryEditorPanel';
import { AnnotationLockBar } from '../components/inspector-v2/AnnotationLockBar';
import { useAnnotationLock } from '../hooks/useAnnotationLock';
import { BoundaryEditPopover, useBoundaryEditPopover } from '../components/inspector-v2/BoundaryEditPopover';
import { sectionEnd } from '../components/inspector-v2/sectionConstants';
import {
  mergeBoundaryLanes, mergeLayerName, mergedToSectionBlocks,
  boundaryTimesToSectionBlocks, toggleMergeDropped, readMergeState, writeMergeState,
  type MergedBoundary, type MergeSourceLane,
} from '../components/inspector-v2/boundaryMerge';
import { CueEditorPanel } from '../components/inspector-v2/CueEditorPanel';
import { CueEditPopover, useCueEditPopover } from '../components/inspector-v2/CueEditPopover';
import { LoopEditorPanel } from '../components/inspector-v2/LoopEditorPanel';
import { LyricsTextPanel } from '../components/inspector-v2/LyricsTextPanel';
import { SpanEditorPanel } from '../components/inspector-v2/SpanEditorPanel';
import { SpanEditPopover, useSpanEditPopover } from '../components/inspector-v2/SpanEditPopover';
import { LoopEditPopover, useLoopEditPopover } from '../components/inspector-v2/LoopEditPopover';
import { TAP_PREROLL_SECONDS } from '../components/inspector-v2/BeatChipControls';
import { RiffPatternEditorPanel, resolveId as resolveRiffId } from '../components/inspector-v2/RiffPatternEditorPanel';
import { LyricsEditorPanel } from '../components/inspector-v2/LyricsEditorPanel';
import { LyricsEditPopover, useLyricsEditPopover } from '../components/inspector-v2/LyricsEditPopover';
import { riffLayerFromMotifs } from '../components/inspector-v2/motifToRiff';
import { rawDetectorItem } from '../components/inspector-v2/shared/detectorRaw';
import { useCardSectionOpen } from '../components/inspector-v2/shared/CardSection';
import { KaraokePanel } from '../components/inspector-v2/KaraokePanel';
import { RiffPatternEditPopover, useRiffPatternEditPopover } from '../components/inspector-v2/RiffPatternEditPopover';
import { NodeEditPopover, useNodeEditPopover } from '../components/inspector-v2/NodeEditPopover';
import type { BoundaryTickSource } from '../components/inspector-v2/BoundarySegmentEditor';
import { EnergySpanExportPopover, useEnergySpanExportPopover } from '../components/inspector-v2/EnergySpanExportPopover';
import {
  buildEnergySpanLayerOptions,
  NEW_SPAN_LAYER_ID, NEW_ENERGY_SPAN_LAYER_ID, ENERGY_SPAN_LAYER_NAME,
} from '../components/inspector-v2/energySpanLayerOptions';
import { energySpanLabel, type EnergySpanExport } from '../utils/energySpan';
import { UnifiedAnnotationListPanel, type UnifiedLayerSelection } from '../components/inspector-v2/UnifiedAnnotationListPanel';
import { loadLayers, saveLayers, loadAllLayerStatuses, primaryBoundaryItems, type SongLayerStatuses } from '../services/annotationLayers';
import {
  emptyDocument as emptyLayersDoc, pickDefaultLayerColor, newId,
  newRiffNode, newRiffCombo, pickRiffNodeColor, pickRiffComboColor, findFirstRiffNodeOccurrence,
  newRiffPatternLayer, resizeRiffNodeLength, normalizePatternAccents, nodeEntryLengthSteps, newRiffPatternItem, newRiffSeqEntry,
  newRiffBoundaryNode, resizeBoundaryNodeLength, boundarySegmentsFromHits, mergeBoundaryHits, riffNodeLengthBeats, isBoundaryNode, trimRiffNodeLength,
  withFittedRiffInstances,
  newSpanLayer, newSpanItem, newBoundaryLayer, shiftProminenceForStartEdge,
  deleteGroupAndLayers, findGroup, groupLayers, groupVisibility, layersInGroup,
  setGroupVisible, setLayerGroup, ungroupLayers, updateGroup, setLayerStatus,
} from '../types/annotationLayer';
import type { AnnotationLayerType } from '../types/annotationLayer';
import type { AnnotationLayer, AnnotationLayersDocument, BoundaryItem, CueItem, LoopItem, SpanItem, LyricsItem, RiffPatternItem, RiffNode, RiffCombo, ProminenceEnvelope, ProminenceLevel, VocalRun } from '../types/annotationLayer';
import { assignLeadOverRange, assignVocalLeadEverywhere, collectLeadCandidates, setLevelOverRange, type LeadPatch } from '../utils/leadLane';
import type { VocalRunGrid } from '../utils/vocalRuns';
import { frameAxis } from '../utils/frameTime';
import { sampleOnsetWindow, withMeasuredEnds } from '../utils/onsetWindow';
import {
  type AnnotationType,
  type BoundarySource,
  type ExaminableType,
  isExaminableType,
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
  s === 'manual' || s === 'autoGuess';

/** Per-source-or-type key for the annotation recording timer. Boundaries
 *  track time per source (manual/autoGuess separately); layer types
 *  track time per type. */
type TimerKey = BoundarySource | 'cues' | 'spans' | 'loops' | 'lyrics';

import { DetectorOutputReview } from '../components/inspector-v2/DetectorOutputReview';
import type { DetectorReviewStatus } from '../components/inspector-v2/DetectorOutputReview';
import { convertDetectorItems } from '../components/inspector-v2/detectorConvert';
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
import { ImportMenu, ExportButton, UndoButton, RedoButton } from '../components/inspector-v2/shared/AnnotationToolbar';
import { AnnotationAddPanel } from '../components/inspector-v2/shared/AnnotationAddPanel';
import { AnnotationTypeChip } from '../components/inspector-v2/shared/AnnotationTypeChip';
import {
  emptyCapabilities,
  type AnnotationPanelController,
  type AnnotationPanelCapabilities,
  type ImportFormat,
} from '../components/inspector-v2/shared/AnnotationPanelController';
import { useLoopPlayback } from '../hooks/useLoopPlayback';
import { useUndoableState, type SetUndoableOptions, type SetUndoableState } from '../hooks/useUndoableState';
import { SongSetupPanel } from '../components/inspector-v2/SongSetupPanel';
import { ExportManagerModal } from '../components/inspector-v2/ExportManagerModal';
import { ShortcutsHelpPanel } from '../components/inspector-v2/ShortcutsHelpPanel';
import { useAnnotationShortcuts, type ShortcutDef } from '../hooks/useAnnotationShortcuts';
import { useFocusTrap } from '../hooks/useFocusTrap';
import {
  AlgoInspectStage, buildAnnotationRows, type ToolState, type AlgorithmRow,
  type ConsensusVizState,
  SPAN_ALGO_IDS, PITCH_ALGO_IDS, CUE_EXTRAS_ALGO_IDS,
  PERCUSSIVE_ALGO_IDS, LYRICS_ALGO_IDS, PATTERN_ALGO_IDS,
} from '../components/inspector-v2/AlgoInspectStage';
import { LyricsRangeRerunPanel } from '../components/inspector-v2/LyricsRangeRerunPanel';
import { EvaluationStage } from '../components/inspector-v2/EvaluationStage';
import { InspectKindDropdown } from '../components/inspector-v2/InspectKindDropdown';
import { ReferenceAnnotatorPicker } from '../components/inspector-v2/ReferenceAnnotatorPicker';
import { GlobalEvalStage } from '../components/inspector-v2/GlobalEvalStage';
import AutoGuessPanel from '../components/AutoGuessPanel';
import { InfoBanner } from '../components/InfoBanner';
import { useMobile } from '../mobile/mobileState';
import type { PendingSelection } from '../components/inspector-v2/AnnotationOverlays';
import type { PreviewRegion } from '../components/inspector-v2/PreviewWindow';
import { loadAutoGuessAnnotation, saveAutoGuessAnnotation, loadAllAutoGuessStatuses, deleteAutoGuessAnnotation, type AutoGuessSongStatus } from '../services/autoGuessAnnotations';
import { fetchStorageStats, clearSongCaches, clearSongStems, deleteSongEverything, clearAllCaches, formatBytes, type StorageStatsResponse } from '../services/storageStats';
import { DeleteConfirmDialog } from '../components/DeleteConfirmDialog';
import { ClearScopeDialog, type ClearScope } from '../components/ClearScopeDialog';
import { BpmWarningDialog } from '../components/BpmWarningDialog';
import { ImportDatasetDialog } from '../components/inspector-v2/ImportDatasetDialog';
import { useAnnotator } from '../context/AnnotatorContext';
import { annotatorHeaders } from '../utils/annotatorHeaders';
import { getCurrentSettings, useSettings } from '../context/SettingsContext';
import { useDemo } from '../context/DemoContext';
import { loadSongInfo, saveSongInfo, loadAllSongInfo } from '../services/songInfo';
import { loadCachedBpm, runBpmDetection, type BpmDetectionResult } from '../services/bpmDetection';
import { loadCachedBeatnet, runBeatnetDetection, type BeatnetDetectionResult } from '../services/beatnetDetection';
import {
  listDetectors, getDetectorResult,
  loadCustomAnnotation, saveCustomAnnotation,
} from '../services/customScripts';
import { groupByDetectorOrigin } from '../utils/detectorOrigin';
import type { CustomRegistryEntry, CustomResultEnvelope, CustomBoundaryItem, CustomCueItem, CustomSpanItem, CustomLoopItem, CustomLyricsItem } from '../types/customScript';
import { computeMIRFeatures } from '../services/mirAnalysis';
import { useCapabilities } from '../hooks/useCapabilities';
import { useDemucsStems, fetchStemManifest, stemSlugFromUrl, type DemucsModel, type DemucsStem, type StemManifest } from '../hooks/useDemucsStems';
import { useAdmin } from '../hooks/useAdmin';
import { useExperimentalAvailability } from '../hooks/useExperimentalAvailability';
import { GPU_TOOLS_UNAVAILABLE_HINT } from '../services/capabilities';
import type { SectionBlock } from '../types/sectionBlock';
import type { AutoGuessManualAnnotation, AutoGuessPoint } from '../types/autoGuess';
import type { SongInfo } from '../types/songInfo';
import { makeEmptySongInfo, isGridReady, songCollection, effectiveGridMode, getActiveBeatOverrideCount, isMapMode, splitDisplayName, storedGridSegments, normalizeGridSegments, makeGridSegmentId } from '../types/songInfo';
import type { GridSegment } from '../types/songInfo';
import { groupSongs, songNameParts, isSongGroupMode, SONG_GROUP_MODES, DEFAULT_SONG_GROUP_MODE, type SongGroupMode, type SongSharingInfo, type SongCollaborationInfo } from '../utils/songGroups';
import { fetchSongAnnotators, fetchSongAnnotatorRoster, describeAnnotatorCount, type SongAnnotatorEntry } from '../services/songAnnotators';
import { fetchSharedSlugs } from '../services/annotationLocks';
import { deriveSongTracks, type SongTrack } from '../utils/songAnnotationTracks';
import { resolveGridSegments, resolveStoredGridSegments, segmentAtTime, canPlaceSegmentAt, canPlaceOriginAt, canMoveHeadTo, snapSegmentHeadTime, remapBeatOverrides, type ResolvedSegment } from '../utils/gridSegments';
import { GridSegmentListEditor } from '../components/inspector-v2/GridSegmentListEditor';
import { GridSegmentEditPopover, useGridSegmentPopover } from '../components/inspector-v2/GridSegmentEditPopover';
import { beatsPerBarFromTimeSignature, snapTimeToGrid, coarsenSnapDivision, formatBeatPosition, beatPositionAt, adaptiveGridThicknessScale } from '../utils/beatGrid';
import { snapModeToDivision, beatGridUnitToSnapDivision, beatGridUnitLabel, magneticToleranceSec } from '../utils/beatTimeFormat';
import { gridEditCoalesceKey } from '../utils/gridUndo';
import { GridLockModal, NoBpmModal } from '../components/inspector-v2/GridLockModal';
import { GridChangedModal } from '../components/inspector-v2/GridChangedModal';
import {
  gridOf, gridSignature, countRetimed, countStaleTimes, describeGridChange,
  retimedDocument, withStampedBeats, withClearedBeatStamps,
  withTimesFromBeats, type BeatGrid,
  withFoldedGridOffset, withShiftedBeatStamps,
} from '../utils/beatAnchoring';
import { agreementCount, clusterPoints } from '../utils/boundaryClustering';
import { riffLayerFromDrumGrooves, type GrooveItem } from '../components/inspector-v2/drumGrooveToRiff';
import type { ReviewableItem } from '../components/inspector-v2/detectorConvert';
import type { ToolResultData } from '../tools/runTool';
import { cueToSection, struckHitFields } from '../utils/drumHits';

// ─── Audio catalogue ──────────────────────────────────────────────────────────

interface AudioEntry {
  id: string;
  name: string;
  /** Curated title / artist mirrored from song-info by the manifest builder.
   *  Present only for songs with a curated title; surfaces that lay the two
   *  parts out separately go through splitDisplayName(), which falls back to
   *  splitting `name` on the "Artist — Title" file-name convention. */
  title?: string;
  artist?: string;
  url: string;
}

// ─── Demucs stems ─────────────────────────────────────────────────────────────
// Each song's manifest at /stems/<filename-stem>/manifest.json declares URLs
// for the six Demucs sources (htdemucs_6s). Picker swaps the player URL to one
// of these. `guitar` and `piano` are the 6-source split of the old `other`.

export type StemSource = 'mix' | 'vocals' | 'drums' | 'bass' | 'other' | 'guitar' | 'piano';
// What a run targets: the full mix, a single isolated stem, or 'all' — every
// separated stem at once (stem-capable detectors fan out to one <algo>__<stem>
// job per stem; boundary/custom detectors stay on the mix regardless).
export type RunStemTarget = StemSource | 'all';

// Canonical stem order — mirrors the SOURCE picker's button order (Full mix
// first, then the htdemucs_6s stems). Detector-sourced layers default-sort by
// the stem they were computed on so the lanes group the same way the SOURCE
// row reads: mix → vocals → drums → bass → other → guitar → piano.
const STEM_ORDER: StemSource[] = ['mix', 'vocals', 'drums', 'bass', 'other', 'guitar', 'piano'];
const STEM_RANK: Record<string, number> = Object.fromEntries(STEM_ORDER.map((s, i) => [s, i]));
/** Sort rank for a layer's source stem. Whole-track / stem-less detectors sort
 *  with the mix (rank 0); user-authored layers (no stem) sort ahead of all
 *  detectors so the user's own lanes stay on top. */
function stemRank(stem?: string | null, fallback = 0): number {
  return stem != null && stem in STEM_RANK ? STEM_RANK[stem] : fallback;
}
function byStemRank(a: { sourceStem?: string | null }, b: { sourceStem?: string | null }): number {
  return stemRank(a.sourceStem) - stemRank(b.sourceStem);
}

// Demucs stem run/poll/manifest logic lives in the shared useDemucsStems hook
// so the Playground reuses the exact same flow. Re-export stemSlugFromUrl here
// because InspectorPageV2.test.tsx pins it as one of the page's pure helpers.
export { stemSlugFromUrl };

// Browser-side JSON download used by the marker panel's ↓ Export for Manual /
// Auto-guess. Layer types route through their controller's exportJson,
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

// Codespaces' public-port nginx proxy rejects POSTs whose body exceeds its
// `client_max_body_size` with 413 — observed cap is below 20 MB. 8 MB stays
// comfortably under that and still gives sensible progress granularity.
/** Engine id for the highlight band's own loop — the loop-playback engine is
 *  keyed by LoopItem id everywhere else, and the preview is not an item. */
const PREVIEW_LOOP_ID = '__preview__';

const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;

// A local upload of a normal-length song finishes in a few hundred
// milliseconds, so the progress bar used to flash and vanish before anyone
// could read it — the indicator may as well not have existed. Keep it on
// screen for at least this long (the bar's own fill sweeps over 700ms, so
// this leaves a comfortable beat of the flowing gradient after it fills).
const MIN_UPLOAD_INDICATOR_MS = 2200;
const AUDIO_EXTENSIONS = /\.(mp3|wav|flac|ogg|m4a)$/i;

type ChunkProgress = { chunk: number; totalChunks: number; bytesSent: number; totalBytes: number };

/** Rejections carry an { error } body explaining what to do about it (a VBR
 *  mp3, an unsupported format). Surface that, not the HTTP envelope. */
function uploadErrorText(xhr: XMLHttpRequest, fallback: string): string {
  const raw = String(xhr.responseText || '');
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error;
  } catch { /* not JSON — fall through */ }
  return raw.slice(0, 400) || fallback;
}

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
          reject(new Error(uploadErrorText(xhr, `HTTP ${xhr.status} on chunk ${i + 1}/${total}`)));
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
            className="absolute inset-y-0 left-0 tc-upload-flow rounded-full transition-[width] duration-700 ease-out"
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
          className="absolute inset-y-0 left-0 tc-upload-flow rounded-full transition-[width] duration-700 ease-out"
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
    const raw: AudioEntry[] = await res.json();
    return raw;
  } catch {
    return [];
  }
}

export function firstVisibleSong(files: AudioEntry[]): AudioEntry | null {
  return files[0] ?? null;
}

/** Where the open song survives a reload. The `?song=` parameter is the
 *  source of truth — it is what a refresh, a bookmark or a pasted link
 *  carries (see utils/viewUrl) — and localStorage only answers when the URL
 *  says nothing, e.g. arriving from the landing page. A slug that is no longer
 *  in the dataset falls through to the first song. */
const LAST_SONG_KEY = 'timecues.lastSong';

function readLastSong(): string | null {
  try { return localStorage.getItem(LAST_SONG_KEY); } catch { return null; }
}

function writeLastSong(slug: string): void {
  try { localStorage.setItem(LAST_SONG_KEY, slug); } catch { /* storage blocked */ }
}

function initialSong(files: AudioEntry[], urlSlug: string | null): AudioEntry | null {
  for (const slug of [urlSlug, readLastSong()]) {
    const hit = slug ? files.find((f) => f.id === slug) : undefined;
    if (hit) return hit;
  }
  return firstVisibleSong(files);
}

// ─── Stage types ──────────────────────────────────────────────────────────────

type Stage = 'annotation' | 'algo' | 'eval' | 'karaoke' | 'global-eval';
/** The views Algorithm Inspect offers of the examined kind. `eval` is the only
 *  one that always exists; `algo` is offered for boundaries and `karaoke` while
 *  a lyrics layer is focused. */
type InspectSubStage = 'algo' | 'eval' | 'karaoke';
export type Feature = 'annotate' | 'inspect-song' | 'inspect-all' | 'prep';

/** Examine-kind → the Algorithms-sidebar family chip key that produces it.
 *  Switching the Examine dropdown auto-opens this family so the relevant
 *  detectors are visible. Keys match the `sections[].key` values built in
 *  renderRunOptionsPanel; boundaries map to the default MSAF family. */
const ALGO_FAMILY_FOR_INSPECT_KIND: Record<ExaminableType, string> = {
  boundaries: 'msaf',
  cues:       'cue-extras',
  spans:      'span',
  loops:      'loop',
  lyrics:     'lyrics',
};

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

// A standing answer to "the grid moved — what should annotations keep?", set
// by ticking "Remember my preference" in that modal. Only 'beats' / 'times'
// are storable; anything else is read as "keep asking".
const GRID_CHANGE_CHOICE_KEY = 'tc:grid-change-choice';

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

// One pill-chip row used by BOTH stem pickers — the Algorithms "Stem filter"
// (single-select: narrows shown rows to one stem) and the Detectors "Show per
// stem" (multi-toggle: show/hide every detector layer of a stem). They differ
// only in selection logic, which lives in the parent via each chip's `active`
// and `onClick`; the markup is shared so the two never drift apart.
type StemChip = {
  key: string;
  label: string;
  active: boolean;
  disabled?: boolean;
  count?: number | null;
  title?: string;
  onClick: () => void;
};

function StemChipGroup({ label, hint, accent, chips }: {
  label: string;
  hint: string;
  accent: FeatureAccent;
  chips: StemChip[];
}) {
  return (
    <div className="rounded border border-white/[0.06] bg-white/[0.02] p-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] uppercase tracking-[0.16em] text-slate-400">{label}</span>
        <span className="text-[9px] text-slate-600 normal-case tracking-normal">{hint}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {chips.map((c) => (
          <button
            key={c.key}
            disabled={c.disabled}
            onClick={c.onClick}
            title={c.title}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] capitalize tracking-wider transition-colors ${
              c.disabled
                ? 'text-slate-600 border-white/[0.06] opacity-50 cursor-not-allowed'
                : c.active
                  ? `${accent.pillBg} ${accent.primaryText} ${accent.tabBorderActive}`
                  : 'text-slate-500 border-white/10 hover:text-slate-200'
            }`}
          >
            {c.label}
            {c.count != null && c.count > 0 && (
              <span className={`font-mono tabular-nums text-[9px] ${c.active ? 'opacity-80' : 'opacity-60'}`}>{c.count}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// Waveform palette is a constant — high-contrast complementary pair (warm
// orange peak halo + vibrant violet RMS body) regardless of mode. The
// waveform is *data*; mode is signalled by chrome (tabs, buttons, labels)
// per the design spec ("saturated colors ONLY to represent data").
/** Name given to a boundary layer copied off the Consensus lane. It is also
 *  what marks the layer as having come from there, so the "already copied"
 *  count is read back off the document — delete the copy and it stops
 *  counting, exactly like the Merge row's. */
const CONSENSUS_LAYER_LABEL = 'Consensus';

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
  // CUE-family note-onset detector (`experimentalCueExtras`).
  'basic-pitch',
  // CUE-family extras (`experimentalCueExtras`): key, chords, onsets, drum hits.
  'librosa-key', 'autochord-chords', 'librosa-onsets', 'drum-transients',
  // SPAN family addition: percussive HPSS (`experimentalSpanFamily`).
  'hpss-percussive',
  // LYRICS family — Whisper-base + CTC forced aligner (`experimentalLyricsFamily`).
  'whisper-base', 'ctc-forced-aligner',
  // PATTERN family — LoCoMotif (`experimentalPatternFamily`).
  'locomotif',
] as const;

const ALLIN1_FOLD_IDS = new Set([0,1,2,3,4,5,6,7].map((n) => `allin1-fold${n}`));
const SPAN_TOOL_IDS  = new Set(['silero-vad', 'jdcnet-voicing']);
const PANNS_TOOL_IDS = new Set(['panns-cnn14']);
const PITCH_TOOL_IDS = new Set(['basic-pitch']);
const CUE_EXTRAS_TOOL_IDS = new Set(['librosa-key', 'autochord-chords', 'librosa-onsets', 'drum-transients']);
const PERCUSSIVE_TOOL_IDS = new Set(['hpss-percussive']);
const LYRICS_TOOL_IDS     = new Set(['whisper-base', 'ctc-forced-aligner']);
const PATTERN_TOOL_IDS    = new Set(['locomotif']);

// Plain-language hints shown as a small chip beside each experimental
// detector in the sidebar — the model names (CTC, JDCNet, PANNs, HPSS…)
// mean nothing on their own. `tag` is the short visible chip; `what` is the
// fuller explanation surfaced on hover.
const ALGO_HINTS: Record<string, { tag: string; what: string }> = {
  'silero-vad':         { tag: 'voice on/off', what: 'Where voice / speech is present vs. silence, over time.' },
  'jdcnet-voicing':     { tag: 'singing',      what: 'Where someone is actually singing (voiced melody).' },
  'panns-cnn14':        { tag: 'sound type',   what: 'Tags the kind of sound playing (music, speech, applause…).' },
  'hpss-percussive':    { tag: 'drums',        what: 'Isolates the percussive / drum layer from the mix.' },
  'basic-pitch':        { tag: 'notes',        what: 'Detects individual musical notes and when they start.' },
  'librosa-key':        { tag: 'key',          what: "Estimates the song's musical key (e.g. C major)." },
  'autochord-chords':   { tag: 'chords',       what: 'Recognizes the chord progression.' },
  'librosa-onsets':     { tag: 'note hits',    what: 'Marks note / transient onset times.' },
  'drum-transients':    { tag: 'drum hits',    what: 'Marks each drum hit and names it kick, snare or hat.' },
  'whisper-base':       { tag: 'subtitles',    what: 'Transcribes the sung lyrics with rough word timing (auto-subtitles).' },
  'ctc-forced-aligner': { tag: 'align lyrics', what: 'Lines your pasted reference lyrics up to the audio, word by word.' },
  'locomotif':          { tag: 'motifs',       what: 'Discovers recurring melodic / rhythmic patterns (motifs).' },
};

// The stem a stem-capable detector is built for. Unlike a custom detector's
// declared stem this is advice, not a constraint — the run picker's "Run on"
// still decides — so the row shows a "best on <stem>" chip whenever the target
// is elsewhere, and clicking it moves the target there. Only detectors whose
// output is noise off that stem belong here: a voice detector on the full mix
// fires on every synth pad, a drum classifier on it calls the bass a kick.
const BEST_STEM: Record<string, DemucsStem> = {
  'silero-vad':         'vocals',
  'jdcnet-voicing':     'vocals',
  'whisper-base':       'vocals',
  'ctc-forced-aligner': 'vocals',
  'drum-transients':    'drums',
};

// Per-algorithm reference card shown behind the ⓘ on each algo lane: what the
// model is, what it extracts, and its input / output. Keyed by BASE id — the
// fold variants of All-In-One and every Ruptures method collapse to one entry
// (see algoInfoFor). Mirrors the curated layers' ⓘ so an annotator can confirm
// what an algorithm row actually is without leaving the canvas.
export interface AlgoInfo { model: string; extracts: string; input: string; output: string; }
const ALGO_INFO: Record<string, AlgoInfo> = {
  'band-gradient':      { model: 'Spectral band-energy gradient (heuristic)', extracts: 'Section boundaries from large shifts in per-band energy', input: 'Full-mix audio', output: 'Section boundaries (structure)' },
  'msaf-olda':          { model: 'MSAF · OLDA (Ordinal LDA — McFee & Ellis)', extracts: 'Structural section boundaries', input: 'Full-mix audio', output: 'Boundaries + section labels' },
  'msaf-foote':         { model: 'MSAF · Foote novelty (self-similarity)', extracts: 'Section boundaries via a checkerboard novelty kernel', input: 'Full-mix audio', output: 'Section boundaries' },
  'msaf-cnmf':          { model: 'MSAF · C-NMF (convex non-negative matrix factorization)', extracts: 'Repeated structural segments', input: 'Full-mix audio', output: 'Boundaries + segment labels' },
  'msaf-sf':            { model: 'MSAF · SF (Structural Features — Serrà et al.)', extracts: 'Section boundaries from structural features', input: 'Full-mix audio', output: 'Section boundaries' },
  'allin1':             { model: 'All-In-One (Kim & Nam) music-structure analyzer', extracts: 'Beats, downbeats & functional segments (intro / verse / chorus…)', input: 'Full-mix audio (Demucs stems used internally)', output: 'Beats, downbeats, segments + functional labels' },
  'ruptures':           { model: 'ruptures · change-point detection (PELT / BinSeg / Window)', extracts: 'Change points in an audio-feature signal', input: 'Audio-feature series (e.g. chroma / MFCC)', output: 'Boundaries at detected change points' },
  'silero-vad':         { model: 'Silero VAD (neural voice-activity detector)', extracts: 'Where voice / speech is present vs. silence', input: 'Audio — best on the vocals stem', output: 'Voice on/off spans' },
  'jdcnet-voicing':     { model: 'JDCNet (joint detection & classification network)', extracts: 'Where a sung melody is actually voiced', input: 'Audio — vocals stem', output: 'Voicing spans' },
  'panns-cnn14':        { model: 'PANNs CNN14 (AudioSet audio tagging)', extracts: 'What kind of sound is playing (music / speech / applause…)', input: 'Audio', output: 'Tagged sound-type spans / cues' },
  'hpss-percussive':    { model: 'librosa HPSS (harmonic–percussive source separation)', extracts: 'The percussive / drum layer of the mix', input: 'Audio', output: 'Percussive spans' },
  'basic-pitch':        { model: 'Spotify Basic Pitch (note transcription)', extracts: 'Individual musical notes and their onsets', input: 'Audio — best on a pitched stem', output: 'Note events (pitch + start / stop)' },
  'librosa-key':        { model: 'librosa key estimation (Krumhansl–Schmuckler)', extracts: "The song's musical key", input: 'Audio (chroma)', output: 'Single global key (e.g. C major)' },
  'autochord-chords':   { model: 'autochord (chord recognition)', extracts: 'The chord progression', input: 'Audio', output: 'Chord-labelled spans' },
  'librosa-onsets':     { model: 'librosa onset detection (spectral flux)', extracts: 'Note / transient onset times', input: 'Audio', output: 'Onset cue markers (points)' },
  'drum-transients':    { model: 'librosa onset detection + per-band energy classifier', extracts: 'Drum hits, each labelled kick / snare / hat', input: 'Audio — the drums stem', output: 'One tick per hit — red kick, blue snare, green hat. Tick height is velocity: a full-height tick is that drum at its hardest, a stub is a ghost note. Hover a tick for its velocity and level.' },
  'whisper-base':       { model: 'OpenAI Whisper (base) — speech recognition', extracts: 'Sung lyrics with rough word timing', input: 'Audio — vocals stem', output: 'Transcribed lyrics + detected language' },
  'ctc-forced-aligner': { model: 'CTC forced aligner', extracts: 'Word-level alignment of your pasted reference lyrics', input: 'Audio + reference lyrics text', output: 'Word-aligned lyrics (timed)' },
  'locomotif':          { model: 'LoCoMotif (motif discovery)', extracts: 'Recurring melodic / rhythmic motifs', input: 'Audio / features', output: 'Motif pattern spans' },
};

// Resolve the ALGO_INFO card for any overlay id: strip the per-stem suffix, then
// collapse the All-In-One folds and the many Ruptures methods onto their single
// shared entry. Returns undefined for ids with no reference card (e.g. custom
// detectors), which simply get no ⓘ.
function algoInfoFor(id: string): AlgoInfo | undefined {
  let base = baseAlgoId(id);
  if (base.startsWith('allin1')) base = 'allin1';
  else if (base.startsWith('ruptures')) base = 'ruptures';
  return ALGO_INFO[base];
}

// Detectors that can run against an isolated Demucs stem (vocals/drums/bass/
// other) rather than the full mix — the CUE/SPAN/LOOP/PATTERN/LYRICS families.
// Boundary detectors (MSAF, ruptures, all-in-one) and custom scripts stay
// mix-only. A per-stem run is dispatched under the composite id "<algo>__<stem>"
// (mirrors cache_name() in tools/python/paths.py).
const STEM_CAPABLE_TOOL_IDS = new Set<string>([
  ...SPAN_TOOL_IDS, ...PANNS_TOOL_IDS, ...PITCH_TOOL_IDS,
  ...CUE_EXTRAS_TOOL_IDS, ...PERCUSSIVE_TOOL_IDS, ...LYRICS_TOOL_IDS, ...PATTERN_TOOL_IDS,
]);

// Rewrite a selection so that stem-capable detectors target the chosen stem
// ("<algo>__<stem>"); boundary/custom ids pass through unchanged. A no-op when
// stem === 'mix'.
function applyStemToSelection(sel: Set<string>, stem: string): Set<string> {
  if (!stem || stem === 'mix') return sel;
  const out = new Set<string>();
  for (const id of sel) out.add(STEM_CAPABLE_TOOL_IDS.has(id) ? `${id}__${stem}` : id);
  return out;
}

// "Run on: All stems" — fan every stem-capable detector out to one
// "<algo>__<stem>" id per stem so a single run covers all separated stems at
// once. Boundary/custom ids are mix-only and pass through a single time.
function applyAllStemsToSelection(sel: Set<string>, stems: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const id of sel) {
    if (STEM_CAPABLE_TOOL_IDS.has(id)) {
      for (const s of stems) out.add(`${id}__${s}`);
    } else {
      out.add(id);
    }
  }
  return out;
}

// Lane label for a detector-sourced layer: when the detector declares a source
// stem, swap its trailing parenthetical tag (e.g. "(curated)", "(LoCoMotif)")
// for that stem so the gutter reads "Vocals presence (vocals)" — telling the
// annotator which stem each curated layer was built upon. Falls back to the raw
// label when no stem is declared or the label has no trailing "(…)".
function detectorLaneName(label: string, stem?: string | null): string {
  const base = label || '';
  if (!stem) return base;
  const stripped = base.replace(/\s*\([^()]*\)\s*$/, '');
  return `${stripped} (${stem})`;
}

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
  type ExperimentalKind = { kind: 'spans' } | { kind: 'loops' } | { kind: 'notes' } | { kind: 'cues' } | { kind: 'words' } | { kind: 'patterns' };
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
        cues?:  { time: number; label: string; velocity?: number; levelDb?: number }[];
        words?: { time: number; end: number; text: string }[];
        patterns?: { start: number; end: number; label: string; motif_id: number }[];
        // Single-value globals: `key` (librosa-key), `language` (whisper-base).
        // Surfaced as toolbar pills, so they must survive the cache-load path.
        key?: string | null;
        language?: string | null;
        // LOOP family: which beat grid the detector aligned to
        // ("song-info" | "allin1" | "librosa"). Surfaced as a lane badge.
        grid_source?: string | null;
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
        kind.kind === 'cues'  ? (payload.cues ?? []).map(cueToSection) :
        kind.kind === 'patterns' ? (payload.patterns ?? []).map((p) => ({
          time: p.start, endTime: p.end, type: `motif-${p.motif_id}`, label: p.label,
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
          ...(kind.kind === 'loops' ? { gridSource: payload.grid_source ?? null } : {}),
        },
      } as ToolResultData;
      const error = payload.ok === false
        ? (payload.error?.trim() || 'detector reported ok=false')
        : undefined;
      return { result, error };
    } catch { return null; }
  }

  // A per-stem result carries the composite id "<algo>__<stem>"; the family is
  // keyed by the base algo, but readExperimental fetches by the composite
  // toolId (so /api/<fam>/detect/<slug>/<algo>__<stem> reads the right file).
  const expBase = toolId.includes('__') ? toolId.slice(0, toolId.indexOf('__')) : toolId;
  if (SPAN_TOOL_IDS.has(expBase))       return readExperimental('span',       { kind: 'spans' });
  if (PANNS_TOOL_IDS.has(expBase))      return readExperimental('panns',      { kind: 'spans' });
  if (PITCH_TOOL_IDS.has(expBase))      return readExperimental('pitch',      { kind: 'notes' });
  if (CUE_EXTRAS_TOOL_IDS.has(expBase)) return readExperimental('cue-extras', { kind: 'cues' });
  if (PERCUSSIVE_TOOL_IDS.has(expBase)) return readExperimental('percussive', { kind: 'spans' });
  if (LYRICS_TOOL_IDS.has(expBase))     return readExperimental('lyrics',     { kind: 'words' });
  if (PATTERN_TOOL_IDS.has(expBase))    return readExperimental('pattern',    { kind: 'patterns' });

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

// How far back a mark may be dated from the DOM event that asked for it. The
// real gap between a key going down and its handler running is a frame or two;
// anything larger means the timestamp isn't comparable to performance.now()
// (or the tab was suspended mid-press), and no correction is safer than a
// wild one. See `liveSongTime`.
const MAX_INPUT_LAG_SEC = 0.25;

// ─── Live auto-guess clustering (centroid-linkage, same algorithm as AutoGuessPanel) ───

const LIVE_CLUSTER_TOLERANCE = 3; // seconds

function computeLiveClusters(
  rows: { id: string; sections: { time: number }[] }[],
  toleranceSec: number,
): AutoGuessPoint[] {
  const allPoints = rows.flatMap((r) => r.sections.map((s) => ({ algorithmId: r.id, time: s.time })));
  return clusterPoints(allPoints, toleranceSec).map(({ members }, clusterId) => {
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
  // CUE-family note-onset detector — pink, distinct from boundary chips.
  'basic-pitch':      '#f472b6',
  // CUE-family extras — teal trio so key/chords/onsets cluster visually.
  'librosa-key':       '#2dd4bf',
  'autochord-chords':  '#2dd4bf',
  'librosa-onsets':    '#2dd4bf',
  // Drum transients — yellow, apart from the teal trio because it answers a
  // different question (which drum), and apart from HPSS orange because that
  // one is spans and this one is points.
  'drum-transients':   '#eab308',
  // HPSS percussive (SPAN family) — orange so it doesn't blend with voicing.
  'hpss-percussive':   '#fb923c',
  // LYRICS family — rose, distinct from cue-extras teal.
  'whisper-base':       '#fb7185',
  'ctc-forced-aligner': '#f43f5e',
  // PATTERN family — emerald, distinct from amber loops and rose lyrics.
  'locomotif':         '#10b981',
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
  ...SPAN_ALGO_IDS, ...PITCH_ALGO_IDS,
  ...PERCUSSIVE_ALGO_IDS, ...LYRICS_ALGO_IDS, ...PATTERN_ALGO_IDS,
]);
// Strip the per-stem suffix: "silero-vad__vocals" → "silero-vad". A bare id is
// returned unchanged. Per-stem overlays/rows must resolve color, render kind and
// single-info status from the base detector, not the composite id.
function baseAlgoId(id: string): string {
  const i = id.indexOf('__');
  return i === -1 ? id : id.slice(0, i);
}

/** Whether a stem filter is keeping an algo row off the canvas — and whether
 *  that is a surprise. Three outcomes:
 *
 *    'unticked'  nothing asked for this row
 *    'shown'     it draws
 *    'filtered'  it was asked for, and the stem filter vetoed it
 *
 *  Ticking a per-stem row by name is the only way to ask for that row, so the
 *  filter does not get to veto it (see the LYRICS vocals row). The filter
 *  narrows the rows that arrived implicitly — a family chip selects base ids,
 *  and their stem variants ride along.
 *
 *  A 'filtered' verdict on a row the user ticked BY NAME is the one state the
 *  UI has to say out loud: the checkbox is on and nothing is drawn. Both
 *  `algoOverlays` (which rows exist) and `algoOptions` (which rows the picker
 *  must explain) read this one function, so they can never disagree about it.
 */
export type AlgoOverlayGate = 'unticked' | 'shown' | 'filtered';

export function gateAlgoOverlay(
  id: string,
  selected: Set<string>,
  filter: StemSource | 'all',
): AlgoOverlayGate {
  const cut = id.indexOf('__');
  const stem = cut === -1 ? 'mix' : id.slice(cut + 2);
  // A row is "on" when its own id is selected, or (for a per-stem variant) its
  // base mix row is selected — the family chip selects the base, the stem
  // variant rides along without needing its own checkbox.
  const picked = selected.has(id);
  const ridingAlong = stem !== 'mix' && selected.has(baseAlgoId(id));
  if (!picked && !ridingAlong) return 'unticked';
  if (picked && stem !== 'mix') return 'shown';            // explicit per-stem tick wins
  if (filter === 'all') return 'shown';                    // mix rows + every selected algo's stem variants
  if (filter === 'mix') return stem === 'mix' ? 'shown' : 'filtered';
  return stem === filter ? 'shown' : 'filtered';           // one stem's rows only
}

function algoRenderKind(id: string): AlgoRenderKind {
  const base = baseAlgoId(id);
  if (POINT_ALGO_IDS.has(base)) return 'point';
  if (SPAN_RENDER_ALGO_IDS.has(base)) return 'span';
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

// Distinct hue per Demucs stem, so per-stem overlay rows ("<algo>__<stem>") of
// one family are easy to tell apart (vocals vs drums vs bass vs other).
const STEM_OVERLAY_COLORS: Record<string, string> = {
  vocals: '#22d3ee', // cyan
  drums:  '#fb923c', // orange
  bass:   '#a78bfa', // violet
  other:  '#4ade80', // green
};

// Convert a CustomResultEnvelope of boundary items into the section shape the canvas expects.
// Each detected boundary becomes the start of a section running up to the next boundary
// (or end-of-track for the final one), matching how the built-in detectors are flattened.
// `color` is per-detector and emitted on each section so the algo row paints with a vivid
// hue instead of falling through to the near-invisible slate-400 default.
function customEnvelopeToSections(
  env: CustomResultEnvelope,
  trackDuration: number,
  color: string,
): { time: number; endTime: number; label: string; type: string; color: string; raw?: unknown }[] {
  if (env.output_kind !== 'boundary') return [];
  // Carry the original CustomBoundaryItem (importance, candidates, …) as `raw`
  // so the algo Inspect card can show the detector's full emitted object.
  const items = (env.items as CustomBoundaryItem[])
    .map((it) => ({ time: it.time_ms / 1000, label: it.label ?? '', raw: it }))
    .sort((a, b) => a.time - b.time);
  return items.map((it, i) => ({
    time: it.time,
    endTime: items[i + 1]?.time ?? (trackDuration > 0 ? trackDuration : it.time),
    label: it.label || 'boundary',
    type: 'custom',
    color,
    raw: it.raw,
  }));
}

// Candidate steps-per-beat grids to fit a set of beat-relative onset
// positions onto, when generating a Riff Node from a Cues-layer selection —
// same set RiffPatternEditorPanel's "Divide beat into" dropdown offers.
const ONSET_SUBDIVISION_CANDIDATES = [1, 2, 4, 8, 3, 6];

// Picks the coarsest subdivision whose grid explains `beatPositions` (each a
// fractional beat offset from the selection start) within ~1/50th of a beat
// of the best-fitting candidate — so onsets landing squarely on the beat
// resolve to quarters, not an over-fit sixteenth/triplet grid. `beatPositions`
// must be non-empty.
function bestFitOnsetSubdivision(beatPositions: number[]): number {
  const scored = ONSET_SUBDIVISION_CANDIDATES.map((subbeats) => {
    const err = beatPositions.reduce((sum, b) => sum + Math.abs(b - Math.round(b * subbeats) / subbeats), 0)
      / beatPositions.length;
    return { subbeats, err };
  });
  const bestErr = Math.min(...scored.map((s) => s.err));
  const within = scored.filter((s) => s.err <= bestErr + 0.02);
  within.sort((a, b) => a.subbeats - b.subbeats);
  return within[0]?.subbeats ?? 4;
}

// ─── Component ────────────────────────────────────────────────────────────────

// `onBack` prop kept on the type so the caller in App.tsx remains stable —
// not currently consumed by the V2 page (mode-switcher is now in-page).
export function InspectorPageV2(props: { onBack: () => void; initialFeature?: Feature; feature?: Feature }) {
  const navigate = useNavigate();
  // The view the page was opened on — the song, tab, lanes and time window a
  // refresh or a shared link asks for. Read once: after this the URL is only
  // ever written, by the sync further down.
  const [urlView] = useState(() => parseViewUrl(window.location.search));
  // GPU tooling availability — single source of truth, baked into the
  // gpu-tools Docker image at build time. Drives the disabled/tooltip state
  // for allin1 + Demucs surfaces; the features stay visible so users see
  // what they're missing on a CPU-only install.
  const { capabilities: gpuCaps } = useCapabilities();
  const { status: adminStatus } = useAdmin();
  // Phone: is the docked annotation-tools sheet pulled up to full height?
  const [toolsSheetFull, setToolsSheetFull] = useState(false);
  // Phone shell: the sidebars below become full-screen panels, one at a time
  // (see mobile/MobileContext). All false/null on desktop.
  const { isMobile, panel: mobilePanel, setPanel: setMobilePanel, setSong: setMobileSong, setChoices: setMobileChoices } = useMobile();
  // ── Catalogue ────────────────────────────────────────────────────────────
  const [audioFiles, setAudioFiles] = useState<AudioEntry[]>([]);
  // Aggregate corpus size — for public users this lets the sidebar communicate
  // that the visible 3-song demo is a slice of a much larger real corpus,
  // without exposing any song slug, audio, email, or annotation.
  const [corpusStats, setCorpusStats] = useState<{ songs: number; admins: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/corpus/stats')
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (!cancelled && j && typeof j.songs === 'number') setCorpusStats({ songs: j.songs, admins: j.admins ?? 0 }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
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
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [actionsOpenSlug]);

  // ── Demucs stem player ───────────────────────────────────────────────────
  const [selectedStemSource, setSelectedStemSource] = useState<StemSource>('mix');
  const [stemManifest, setStemManifest] = useState<StemManifest | null>(null);
  // Which audio source the run picker computes detectors against. Independent of
  // the player's selectedStemSource (which only swaps playback). 'mix' is the
  // full track; a stem runs the ticked CUE/SPAN/LOOP/lyrics detectors on that
  // isolated stem and caches them under "<algo>__<stem>".
  const [runStemSource, setRunStemSource] = useState<RunStemTarget>('mix');
  const [songStatuses, setSongStatuses] = useState<Record<string, AutoGuessSongStatus>>({});
  // Per-song user-created layer summaries (cues/spans/loops) for the
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
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [statusPopoverSlug]);

  // Slug whose head-count badge is open, and the roster behind it. Names are
  // fetched per song on open rather than shipped with the counts: the list only
  // ever needs a number, and a name is the part worth asking for deliberately.
  const [annotatorPopoverSlug, setAnnotatorPopoverSlug] = useState<string | null>(null);
  const [annotatorRoster, setAnnotatorRoster] = useState<
    { slug: string; state: 'loading' } | { slug: string; state: 'error' } | { slug: string; state: 'ready'; annotators: SongAnnotatorEntry[] } | null
  >(null);
  const annotatorPopoverRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!annotatorPopoverSlug) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!annotatorPopoverRef.current?.contains(e.target as Node)) setAnnotatorPopoverSlug(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAnnotatorPopoverSlug(null); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [annotatorPopoverSlug]);
  useEffect(() => {
    const slug = annotatorPopoverSlug;
    if (!slug) return;
    let cancelled = false;
    setAnnotatorRoster({ slug, state: 'loading' });
    fetchSongAnnotatorRoster(slug)
      .then((res) => { if (!cancelled) setAnnotatorRoster({ slug, state: 'ready', annotators: res.annotators }); })
      .catch(() => { if (!cancelled) setAnnotatorRoster({ slug, state: 'error' }); });
    return () => { cancelled = true; };
  }, [annotatorPopoverSlug]);

  // Disk-usage stats per song + aggregate. Refreshed on mount, after upload,
  // after song delete, and after each cache-clear action.
  const [storageStats, setStorageStats] = useState<StorageStatsResponse | null>(null);
  const refreshStorageStats = useCallback(() => {
    fetchStorageStats().then(setStorageStats);
  }, []);
  // The disk-usage breakdown at the foot of the song sidebar is a reference
  // readout, not something you watch while working — so it folds away to its
  // one-line total and stays folded until you ask for it again.
  const [storageFooterOpen, setStorageFooterOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('tc:storage-footer-collapsed') !== '1'; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('tc:storage-footer-collapsed', storageFooterOpen ? '0' : '1'); } catch {}
  }, [storageFooterOpen]);
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
  // How the song sidebar's list is carved up. The user picks this from the
  // Group by control at the top of the list; it is remembered per browser.
  const [songGroupMode, setSongGroupMode] = useState<SongGroupMode>(() => {
    try {
      const stored = localStorage.getItem('tc:song-sidebar-group-by');
      if (isSongGroupMode(stored)) return stored;
    } catch { /* unreadable — fall through to the default */ }
    return DEFAULT_SONG_GROUP_MODE;
  });
  useEffect(() => {
    try { localStorage.setItem('tc:song-sidebar-group-by', songGroupMode); } catch { /* quota / private mode */ }
  }, [songGroupMode]);
  // Folded groups in the song sidebar, keyed by SongGroup.key. Persisted
  // like the sidebar's own collapse state so a long corpus stays folded the way
  // the user left it.
  const [collapsedSongGroups, setCollapsedSongGroups] = useState<ReadonlySet<string>>(() => {
    try {
      const raw = localStorage.getItem('tc:song-sidebar-collapsed-groups');
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((k: unknown): k is string => typeof k === 'string'));
      }
    } catch { /* unreadable/garbage value — start expanded */ }
    return new Set<string>();
  });
  useEffect(() => {
    try {
      localStorage.setItem('tc:song-sidebar-collapsed-groups', JSON.stringify([...collapsedSongGroups]));
    } catch { /* quota / private mode — folding just won't survive a reload */ }
  }, [collapsedSongGroups]);
  const toggleSongGroup = useCallback((key: string) => {
    setCollapsedSongGroups((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
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
  // Default + min match the left song-list sidebar (SIDEBAR_DEFAULT_WIDTH /
  // SIDEBAR_MIN_WIDTH) so the right edge doesn't dominate the layout and the
  // centre column gets the room it needs. Max stays wide for annotators who
  // want to spread out.
  const ANNOTATE_SIDEBAR_MIN_WIDTH = SIDEBAR_MIN_WIDTH;
  const ANNOTATE_SIDEBAR_MAX_WIDTH = 640;
  const ANNOTATE_SIDEBAR_DEFAULT_WIDTH = SIDEBAR_DEFAULT_WIDTH;
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
  // ── Curated sidebar (annotate mode) — a SECOND right column, left of the
  // Annotate sidebar, holding the per-stem show/hide filter for detector-sourced
  // ("curated") layers. Mirrors the annotate sidebar's collapse/width/resize
  // pattern; narrower max since the curated list is a thin column. ───────────
  const CURATED_SIDEBAR_MIN_WIDTH = SIDEBAR_MIN_WIDTH;
  const CURATED_SIDEBAR_MAX_WIDTH = 400;
  const CURATED_SIDEBAR_DEFAULT_WIDTH = 340;
  const [curatedSidebarCollapsed, setCuratedSidebarCollapsed] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem('tc:curated-sidebar-collapsed');
      return stored === '1';
    } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('tc:curated-sidebar-collapsed', curatedSidebarCollapsed ? '1' : '0'); } catch {}
  }, [curatedSidebarCollapsed]);
  const [curatedSidebarWidth, setCuratedSidebarWidth] = useState<number>(() => {
    try {
      const stored = localStorage.getItem('tc:curated-sidebar-width');
      const n = stored ? parseInt(stored, 10) : NaN;
      if (Number.isFinite(n) && n >= CURATED_SIDEBAR_MIN_WIDTH && n <= CURATED_SIDEBAR_MAX_WIDTH) return n;
    } catch {}
    return CURATED_SIDEBAR_DEFAULT_WIDTH;
  });
  useEffect(() => {
    try { localStorage.setItem('tc:curated-sidebar-width', String(curatedSidebarWidth)); } catch {}
  }, [curatedSidebarWidth]);
  const [curatedSidebarResizing, setCuratedSidebarResizing] = useState(false);
  const startCuratedSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setCuratedSidebarResizing(true);
    const startX = e.clientX;
    const startW = curatedSidebarWidth;
    const onMove = (ev: MouseEvent) => {
      // Right-anchored sidebar: dragging LEFT (clientX decreases) widens.
      const next = Math.min(CURATED_SIDEBAR_MAX_WIDTH, Math.max(CURATED_SIDEBAR_MIN_WIDTH, startW + (startX - ev.clientX)));
      setCuratedSidebarWidth(next);
    };
    const onUp = () => {
      setCuratedSidebarResizing(false);
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
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [annotateMenuOpen]);

  // Right-edge Algorithm-Inspect sidebar — lists every registered algorithm
  // (MSAF / All-In-One / Ruptures / band-gradient / custom) with cached
  // badges, and surfaces the ▶ Run for this song trigger. Mirrors the
  // Annotate sidebar's geometry (300–640 px, drag-left to widen, collapses
  // to a hover tab on the right edge). Persists per browser.
  // Match the left song-list sidebar's default + min (see the Annotate
  // sidebar note above) so both right-edge sidebars stay narrow by default.
  const ALGO_SIDEBAR_MIN_WIDTH = SIDEBAR_MIN_WIDTH;
  const ALGO_SIDEBAR_MAX_WIDTH = 640;
  const ALGO_SIDEBAR_DEFAULT_WIDTH = SIDEBAR_DEFAULT_WIDTH;
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

  // ── Run picker popover ──────────────────────────────────────────────
  // The inspect sidebar's per-row checkboxes now toggle *visibility* of cached
  // results. Choosing *what to compute* moved into this popover, opened from the
  // "▶ Run…" button: it hosts the same panel in 'run' mode (selectedAlgorithms)
  // plus a footer that runs the ticked set for the current song. Anchored via a
  // portal so it escapes the sidebar's overflow/stacking context.
  const [runPickerOpen, setRunPickerOpen] = useState(false);
  const runPickerBtnRef = useRef<HTMLButtonElement | null>(null);
  const runPickerRef = useRef<HTMLDivElement | null>(null);
  const [runPickerPos, setRunPickerPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 360 });
  useLayoutEffect(() => {
    if (!runPickerOpen || !runPickerBtnRef.current) return;
    const update = () => {
      const rect = runPickerBtnRef.current!.getBoundingClientRect();
      setRunPickerPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [runPickerOpen]);
  useEffect(() => {
    if (!runPickerOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (runPickerRef.current?.contains(t) || runPickerBtnRef.current?.contains(t)) return;
      setRunPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setRunPickerOpen(false); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [runPickerOpen]);

  // Right-edge DataPrep sidebar — holds Song details (BPM / grid mode /
  // time signature / alignment) + the Metronome, so the curator can tune the
  // grid alongside the waveform without scrolling past it. Mirrors the
  // Annotate / Algo sidebar geometry (drag-left to widen, collapses to a
  // hover tab on the right edge). Wider default than the others because the
  // grid params sit in a 3-up row. Persists per browser.
  const PREP_SIDEBAR_MIN_WIDTH = 360;
  const PREP_SIDEBAR_MAX_WIDTH = 760;
  const PREP_SIDEBAR_DEFAULT_WIDTH = 500;
  const [prepSidebarCollapsed, setPrepSidebarCollapsed] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem('tc:prep-sidebar-collapsed');
      return stored === '1';
    } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('tc:prep-sidebar-collapsed', prepSidebarCollapsed ? '1' : '0'); } catch {}
  }, [prepSidebarCollapsed]);
  const [prepSidebarWidth, setPrepSidebarWidth] = useState<number>(() => {
    try {
      const stored = localStorage.getItem('tc:prep-sidebar-width');
      const n = stored ? parseInt(stored, 10) : NaN;
      if (Number.isFinite(n) && n >= PREP_SIDEBAR_MIN_WIDTH && n <= PREP_SIDEBAR_MAX_WIDTH) return n;
    } catch {}
    return PREP_SIDEBAR_DEFAULT_WIDTH;
  });
  useEffect(() => {
    try { localStorage.setItem('tc:prep-sidebar-width', String(prepSidebarWidth)); } catch {}
  }, [prepSidebarWidth]);
  const [prepSidebarResizing, setPrepSidebarResizing] = useState(false);
  const startPrepSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setPrepSidebarResizing(true);
    const startX = e.clientX;
    const startW = prepSidebarWidth;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(PREP_SIDEBAR_MAX_WIDTH, Math.max(PREP_SIDEBAR_MIN_WIDTH, startW + (startX - ev.clientX)));
      setPrepSidebarWidth(next);
    };
    const onUp = () => {
      setPrepSidebarResizing(false);
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
  // The run picker draws a scrim over the page, so it is modal and Tab has to
  // stay inside it. Declared here rather than next to runPickerOpen because the
  // scrim is dropped once a job starts (the panel becomes a progress readout you
  // can tab away from), and that depends on runJob.
  useFocusTrap(runPickerRef, runPickerOpen && runJob?.status !== 'running');
  const logPreRef = useRef<HTMLPreElement>(null);
  const [, setElapsedTick] = useState(0);

  // ── Demucs stem job (per song, separate from runJob so stemming doesn't block the run-algo panel) ──
  // The whole run/poll/cancel/kill lifecycle lives in useDemucsStems so the
  // Playground reuses the identical flow. onComplete refreshes this page's
  // stem manifest (which drives the SOURCE picker + per-stem audition) when the
  // job finishes for the song that's still selected. progressPct + lastLine are
  // parsed from Demucs's tqdm output on each poll tick so the StemSourcePicker
  // pill can show "Stemming… 38% · 1:24" plus the current step; cancelMode
  // echoes the server's view so the pill can show "⌛ Cancelling…" / "⌛ Killing…".
  const {
    job: demucsJob,
    runStems: handleStemSong,
    enqueueStems: enqueueStemJobs,
    queued: stemQueue,
    cancelStems: handleCancelStems,
    killStems: handleKillStems,
    clearQueue: clearStemQueue,
    dismissError: dismissDemucsError,
  } = useDemucsStems({
    onComplete: (audio, m) => {
      if (selectedAudioRef.current?.id === audio.id) setStemManifest(m);
    },
  });

  // How many stems a (re-)run produces: '6s' = vocals/drums/bass/other/guitar/
  // piano, '4s' = vocals/drums/bass/other and roughly a third quicker. Seeded
  // from Settings, then whatever the user picks in the SOURCE row sticks for
  // the rest of the session — including the automatic post-upload runs.
  const [stemModel, setStemModel] = useState<DemucsModel>(() => getCurrentSettings().defaultStemModel);
  // Read through refs by the upload handler: taking either as a dependency
  // would hand every drop target a new callback on each capability poll.
  const stemModelRef = useRef(stemModel);
  useEffect(() => { stemModelRef.current = stemModel; }, [stemModel]);
  const gpuCapsRef = useRef(gpuCaps);
  useEffect(() => { gpuCapsRef.current = gpuCaps; }, [gpuCaps]);

  // ── Run options ───────────────────────────────────────────────────────────
  const DEMUCS_MODELS = [
    { id: 'htdemucs',  label: 'htdemucs (default, ~2 GB)' },
    { id: 'mdx',       label: 'mdx (lighter)' },
    { id: 'mdx_q',     label: 'mdx_q (quantized, lightest)' },
    { id: 'mdx_extra', label: 'mdx_extra' },
  ] as const;
  const [demucsModel, setDemucsModel] = useState<string>('htdemucs');
  // Empty string = auto-detect (Whisper's default). Set to an ISO 639-1 code
  // (e.g. "fr") to skip language detection and force a specific language.
  const [lyricsLanguage, setLyricsLanguage] = useState<string>('');
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
  // Which algorithm "type" chips are expanded in the run-options panel. Reuses
  // the annotation list's chip control, but as multi-select toggles: click a
  // chip to open/close its family's checkbox grid, and several can be open at
  // once (their frames stack below the chip row). Persisted across reloads.
  const [expandedAlgoTypes, setExpandedAlgoTypes] = useState<Set<string>>(() => {
    try {
      const raw = window.localStorage.getItem('tc.algoExpandedTypes');
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch { /* ignore */ }
    return new Set(['msaf']);
  });
  useEffect(() => {
    try { window.localStorage.setItem('tc.algoExpandedTypes', JSON.stringify([...expandedAlgoTypes])); }
    catch { /* ignore quota */ }
  }, [expandedAlgoTypes]);
  const toggleAlgoType = useCallback((key: string) => {
    setExpandedAlgoTypes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);
  // True once the user has hand-picked what to run (a checkbox, a family
  // Select all / None, a family chip). The Run… picker only seeds its
  // "everything still missing" default while this is false — after that the
  // selection is the user's, and re-opening the picker (or switching the stem
  // target) must show it back unchanged rather than silently re-seeding.
  // A ref, not state: it is only ever read inside callbacks, and nothing
  // renders from it, so it must not go stale in a memoised closure.
  const runSelectionTouchedRef = useRef(false);
  const updateSelectedAlgorithms = useCallback((update: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    runSelectionTouchedRef.current = true;
    setSelectedAlgorithms(update);
  }, []);
  const toggleAlgorithm = useCallback((id: string) => {
    updateSelectedAlgorithms((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [updateSelectedAlgorithms]);

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
  // Playback speed multiplier. Lives here (not in the player) so it survives
  // header collapse/expand and is the single source the viz bar reads/writes;
  // the slow-down itself is applied once at the WaveSurfer source, and every
  // currentTime-driven viz (karaoke sweep, beat grid) follows automatically.
  // Seeded from the user's saved default so the existing Settings preference
  // actually drives playback instead of sitting unused.
  const [playbackRate, setPlaybackRate] = useState(() => getCurrentSettings().defaultPlaybackRate ?? 1);
  // Where WaveSurfer itself sits. Same as `playerTime` except while a loop
  // preview has borrowed the playhead (see `handleLoopPosition`) — that's the
  // position the cursor returns to when the preview stops.
  const truePlayerTimeRef = useRef(0);
  const handlePlayerTime = useCallback((t: number) => {
    truePlayerTimeRef.current = t;
    setPlayerTime(t);
  }, []);
  // ── Sticky slim transport ────────────────────────────────────────────────
  // When the user scrolls the full waveform player up under the pinned header,
  // collapse the header to a one-line title + play/stop controls so playback
  // stays reachable (no waveform, no BPM) — a "slim" look on scroll.
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  const playerWrapRef = useRef<HTMLDivElement | null>(null);
  const headerBarRef = useRef<HTMLDivElement | null>(null);
  const collapsedRef = useRef(false);
  // The slim bar's own bottom edge — 72px app bar plus the bar itself. Learned
  // the first time it renders (it wraps to two lines on a narrow column); 120
  // is the one-line height it has the rest of the time.
  const slimBottomRef = useRef(120);
  // Where the player's transport row landed once the swap had reflowed. See
  // the hand-back rule in `update`.
  const handBackAtRef = useRef<number | null>(null);
  const transportRowRef = useRef<Element | null>(null);
  // The player's own transport row. Cached, because the lookup walks the whole
  // waveform subtree (the row sits below every lane) and this runs on each
  // scroll event; re-resolved when the player remounts.
  const findTransportRow = useCallback(() => {
    const wrap = playerWrapRef.current;
    if (!wrap) return null;
    if (!transportRowRef.current?.isConnected) {
      transportRowRef.current = wrap.querySelector('[data-transport-row]');
    }
    return transportRowRef.current;
  }, []);
  useLayoutEffect(() => {
    collapsedRef.current = headerCollapsed;
    if (!headerCollapsed) { handBackAtRef.current = null; return; }
    // Read after the swap has reflowed, so both numbers describe the world the
    // slim bar actually made.
    const header = headerBarRef.current;
    const row = findTransportRow();
    if (header) slimBottomRef.current = header.getBoundingClientRect().bottom;
    handBackAtRef.current = row ? row.getBoundingClientRect().bottom : null;
  }, [headerCollapsed, findTransportRow]);
  useEffect(() => {
    // Hand over the moment the player's OWN transport row goes under the slim
    // bar — not when the player's top edge passes a line, which is what this
    // used to test. The transport sits at the BOTTOM of the player, so the old
    // rule put the slim transport on screen while the real one was still
    // sitting right below it: two play buttons, two clocks, one of them
    // ignorable.
    //
    // Both states are judged against the same line, the slim bar's bottom
    // edge, because that is the header that exists whenever the slim transport
    // is up. Judging against the live header instead decides in one layout and
    // lands in another, and the two then chase each other across the boundary.
    //
    // Coming back needs its own threshold. Chrome's scroll anchoring cancels
    // most of the reflow — the header loses ~110px, the browser pays it back
    // in scrollTop, and the row drops toward the line instead of rising clear
    // of it — so `handBackAtRef` records where the row actually landed and the
    // full header only returns once the row has climbed past that. Without it
    // the two states sit either side of one pixel and flicker.
    //
    // The cost of an exact hand-off is a short stretch, while the row is
    // behind the tall header and the slim bar is not up yet, with no transport
    // on screen. Closing that gap means showing both, which is the bug.
    const update = () => {
      const wrap = playerWrapRef.current;
      const header = headerBarRef.current;
      if (!wrap || !header) { setHeaderCollapsed(false); return; }
      const row = findTransportRow();
      const line = slimBottomRef.current;
      // No player mounted yet: fall back to the player's own top edge.
      if (!row) { setHeaderCollapsed(wrap.getBoundingClientRect().top < line); return; }
      const rowBottom = row.getBoundingClientRect().bottom;
      if (!collapsedRef.current) {
        // A page with nothing much under the player can run out of scroll
        // before the row ever reaches the line. Rather than leave no transport
        // at all down there, hand over once the row is behind the tall header:
        // a duplicated play button beats an unreachable one.
        const scroller = document.scrollingElement;
        const stuck = !!scroller
          && scroller.scrollHeight > scroller.clientHeight + 1
          && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
        setHeaderCollapsed(rowBottom < line
          || (stuck && rowBottom < header.getBoundingClientRect().bottom));
        return;
      }
      setHeaderCollapsed(rowBottom <= Math.max(line, (handBackAtRef.current ?? line) + 1));
    };
    update();
    window.addEventListener('scroll', update, true);
    const onResize = () => {
      // Both bars wrap with the column width, so the recorded landing point
      // describes a layout that no longer exists.
      const header = headerBarRef.current;
      const row = findTransportRow();
      if (collapsedRef.current && header) slimBottomRef.current = header.getBoundingClientRect().bottom;
      if (collapsedRef.current && row) handBackAtRef.current = row.getBoundingClientRect().bottom;
      update();
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', onResize);
    };
  }, [selectedAudio, findTransportRow]);
  // A pending copy-undo belongs to one song; drop it when the song changes so
  // the banner can't revert an edit on a different track.
  useEffect(() => { setLastCopyUndo(null); }, [selectedAudio]);
  const [vizSignalWidth, setVizSignalWidth] = useState(0);
  // Latest zoom multiplier from the WaveSurfer player (1 = fit, 2 = ×2 …).
  // Drives the auto-guess collapse/expand UI threshold.
  const [vizZoomFactor, setVizZoomFactor] = useState(1);
  // True when WaveSurfer is at the canvas-safe maximum zoom — the VizControlBar's
  // ＋ button reads this to render itself disabled.
  const [vizAtMaxZoom, setVizAtMaxZoom] = useState(false);

  // ── Song info (BPM / time-sig / grid offset — applies to all annotation types) ──
  // Undoable: every grid edit in DataPrep — BPM, meter, downbeat, tempo
  // pinned beats and the grid segments — is a write to this one
  // object, so one history covers the lot. Kept separate from the annotation
  // history (see AnnotationDocsState) because they are edited in different
  // workspaces: ⌘Z in DataPrep walks the grid back, ⌘Z in Annotate walks the
  // annotations back, and neither can reach the other's stack.
  //
  // `stampShift` rides along because a grid edit can renumber the bars: setting
  // the downbeat to 0:54 folds ~29 bars out of the offset, and the annotations'
  // beat stamps were renumbered by exactly that much when it happened. Two
  // folded SongInfos can't tell you how far apart their numbering is, so the
  // running total is stored with them — undo reads the difference and renumbers
  // the stamps back.
  const [gridState, setGridState, songInfoCtl] = useUndoableState<{ info: SongInfo | null; stampShift: number }>(
    { info: null, stampShift: 0 },
  );
  const songInfo = gridState.info;
  // Opening the docked tools brings the lanes up into the half of the screen
  // they leave free — otherwise the sheet opens over the player and the rows
  // being annotated are the part that is hidden.
  useEffect(() => {
    if (!isMobile || mobilePanel !== 'tools') return;
    const id = window.setTimeout(() => {
      const row = document.querySelector('[data-viz-row]');
      if (!row) return;
      const headerH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tc-header-h')) || 92;
      window.scrollBy({ top: row.getBoundingClientRect().top - headerH - 8, behavior: 'smooth' });
    }, 60);
    return () => window.clearTimeout(id);
  }, [isMobile, mobilePanel]);
  // The phone's top bar names the song (its title is the song picker), so
  // hand it the same title/artist split the page header shows.
  useEffect(() => {
    if (!isMobile) return;
    if (!selectedAudio) { setMobileSong(null); return; }
    const { title, artist } = splitDisplayName(
      selectedAudio.name ?? '',
      { title: songInfo?.title ?? selectedAudio.title,
        artist: songInfo?.title ? songInfo.artist : selectedAudio.artist },
    );
    setMobileSong({ title, artist: artist || undefined });
  }, [isMobile, selectedAudio, songInfo?.title, songInfo?.artist, setMobileSong]);
  useEffect(() => () => setMobileSong(null), [setMobileSong]);
  // Picking a song from the phone's song panel is the end of that errand —
  // back to the timeline with the new song on it.
  const selectedAudioId = selectedAudio?.id;
  useEffect(() => {
    if (!isMobile) return;
    setMobilePanel((cur) => (cur === 'songs' ? null : cur));
  }, [isMobile, selectedAudioId, setMobilePanel]);
  const songInfoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set once the flush callback exists — the song-switch effect below is
  // defined above it and needs a stable handle to call.
  const flushSongInfoSaveRef = useRef<(() => void) | null>(null);
  // The exact payload the server refused, kept so a retry after a song switch
  // still writes the edit that never landed.
  const failedSongInfoSaveRef = useRef<{ slug: string; info: SongInfo } | null>(null);
  // Set when a title/artist edit lands during the debounce window, so the
  // pending save also refetches the manifest (the visible name lives there).
  const songNameDirty = useRef(false);
  // The SongInfo the server was last handed (or handed us on load), so an
  // undo can tell whether it needs to write anything back — and whether the
  // version it restored renames the song.
  const lastPersistedSongInfoRef = useRef<{ slug: string; info: SongInfo | null }>({ slug: '', info: null });
  // Autosave state for the grid / song setup, so "did that land?" is never a
  // guess. A failed POST used to be swallowed whole — the edit stayed on
  // screen, the server never heard about it, and the curator found out on the
  // next reload. Now the failure shows, and the payload is kept for a retry.
  const [songInfoSaveState, setSongInfoSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const savedFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current); }, []);

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
  // ONE document per song holds every layer the curator authored — boundaries,
  // cues, spans, loops, patterns, riff-patterns, lyrics — so ⌘Z / ⇧⌘Z has a
  // single history by construction and always undoes whatever was last edited,
  // regardless of which sidebar chip happens to be selected.
  // Read-only guard for shared songs. EVERY annotation edit funnels through
  // this setter, so refusing here is what makes "you don't hold the lock"
  // true rather than advisory: markers don't move, layers don't appear, and
  // nothing has to be explained away at save time. Refusing only at the save
  // was worse than not locking at all — the editor accepted the work and then
  // dropped it.
  //
  // The lease hook that fills this ref lives further down the component and
  // can't be hoisted above this line, so an effect keeps it current.
  const canEditDocRef = useRef(true);
  // Set when an edit was refused, so the lock bar can say why.
  const [blockedByLock, setBlockedByLock] = useState(false);
  const [cueLayersDoc, setCueLayersDocRaw, annotationDocsCtl] =
    useUndoableState<AnnotationLayersDocument | null>(null);
  const setCueLayersDoc = useCallback<SetUndoableState<AnnotationLayersDocument | null>>(
    (next, opts) => {
      if (!canEditDocRef.current) { setBlockedByLock(true); return; }
      setCueLayersDocRaw(next, opts);
    },
    [setCueLayersDocRaw],
  );
  // Mirror of cueLayersDoc, for callbacks that need the latest value without
  // rebinding (keyboard shortcuts, the flush-on-unload effect).
  const cueLayersDocRef = useRef<AnnotationLayersDocument | null>(null);
  useEffect(() => { cueLayersDocRef.current = cueLayersDoc; }, [cueLayersDoc]);

  /** Time-sorted items of the reference boundaries layer — the page-level
   *  read every shortcut / drag / popover handler below shares. */
  const boundaryLayersList = useMemo(
    () => (cueLayersDoc?.layers ?? []).filter(
      (l): l is AnnotationLayer<'boundaries'> => l.type === 'boundaries',
    ),
    [cueLayersDoc],
  );

  // Which boundary layer the page-level edits (canvas drags, shortcuts, the
  // out-of-tab popover) write to. Mirrors selectedCueLayerId / selectedSpanLayerId;
  // falls back to the first layer, which is the one the canvas draws on top.
  const [selectedBoundaryLayerId, setSelectedBoundaryLayerId] = useState<string | null>(null);
  const activeBoundaryLayer = useMemo<AnnotationLayer<'boundaries'> | null>(() => {
    if (selectedBoundaryLayerId) {
      const hit = boundaryLayersList.find((l) => l.id === selectedBoundaryLayerId);
      if (hit) return hit;
    }
    return boundaryLayersList[0] ?? null;
  }, [boundaryLayersList, selectedBoundaryLayerId]);
  // Ref mirror so drag / shortcut handlers can read the live layer without
  // rebinding on every marker placed.
  const activeBoundaryLayerRef = useRef<AnnotationLayer<'boundaries'> | null>(null);
  useEffect(() => { activeBoundaryLayerRef.current = activeBoundaryLayer; }, [activeBoundaryLayer]);

  /** Rewrite one boundary layer's items. The single funnel every page-level
   *  boundary edit goes through, so "which layer am I writing to?" is answered
   *  in exactly one place — and undo/coalescing work the same as for any other
   *  layer kind, because it IS the same document. */
  const updateBoundaryItems = useCallback((
    layerId: string,
    next: BoundaryItem[] | ((prev: BoundaryItem[]) => BoundaryItem[]),
    opts?: import('../hooks/useUndoableState').SetUndoableOptions,
  ) => {
    setCueLayersDoc((d) => d && ({
      ...d,
      layers: d.layers.map((l) => {
        if (l.id !== layerId) return l;
        const prev = l.items as BoundaryItem[];
        return { ...l, items: typeof next === 'function' ? next(prev) : next } as AnnotationLayer;
      }),
    }), opts);
  }, [setCueLayersDoc]);

  /** Copy a detector's accepted section blocks into a NEW boundary layer named
   *  after it — the boundary twin of the copy-to-layer every other detector
   *  kind gets. Returns the new layer's id so the caller can offer an undo. */
  const copyBoundarySectionsToNewLayer = useCallback((
    sections: readonly SectionBlock[],
    name: string,
  ): string | null => {
    if (sections.length === 0) return null;
    const created = newBoundaryLayer(name, pickDefaultLayerColor(cueLayersDocRef.current?.layers ?? []));
    const items: BoundaryItem[] = [...sections]
      .sort((a, b) => a.time - b.time)
      .map((sec) => ({ ...sec, id: newId() }));
    setCueLayersDoc((d) => {
      const base = d ?? emptyLayersDoc(selectedAudioRef.current?.id ?? '');
      return {
        ...base,
        layers: [...base.layers, { ...created, items, source: 'user', importedFrom: name } as AnnotationLayer],
      };
    });
    setSelectedBoundaryLayerId(created.id);
    return created.id;
  }, [setCueLayersDoc]);

  /** Merge accepted section blocks into the active boundary layer, creating
   *  "Boundaries 1" when the song has none yet. The target for every
   *  "copy this algorithm's output into my annotation" affordance — the
   *  boundary twin of DetectorOutputReview's copy-to-layer. */
  const appendBoundarySections = useCallback((sections: readonly SectionBlock[]) => {
    if (sections.length === 0) return;
    const incoming: BoundaryItem[] = sections.map((sec) => ({ ...sec, id: newId() }));
    const layer = activeBoundaryLayerRef.current;
    if (layer) {
      updateBoundaryItems(layer.id, (prev) => [...prev, ...incoming].sort((a, b) => a.time - b.time));
      return;
    }
    const created = newBoundaryLayer('Boundaries 1', pickDefaultLayerColor(cueLayersDocRef.current?.layers ?? []));
    setCueLayersDoc((d) => {
      const base = d ?? emptyLayersDoc(selectedAudioRef.current?.id ?? '');
      return { ...base, layers: [{ ...created, items: incoming }, ...base.layers] };
    });
    setSelectedBoundaryLayerId(created.id);
  }, [updateBoundaryItems, setCueLayersDoc]);
  // Identity check so we don't echo the just-loaded doc back to the server.
  const cueLayersJustLoadedRef = useRef<AnnotationLayersDocument | null>(null);
  // Most recent doc actually written to the server (or just loaded from it) —
  // lets the flush-on-unload effect below tell "nothing pending" from "a save
  // is still owed" without re-deriving it from the debounce timer.
  const lastSavedLayersDocRef = useRef<AnnotationLayersDocument | null>(null);
  // Most recent doc queued for the debounced save, kept outside the debounce
  // effect's own closure so the flush-on-unload effect (which intentionally
  // doesn't depend on cueLayersDoc, to avoid re-flushing on every keystroke)
  // can always read the latest value.
  const pendingLayersDocRef = useRef<{ slug: string; doc: AnnotationLayersDocument } | null>(null);
  // True once the per-song `loadLayers` call below has settled (whether or not
  // a file existed) — distinguishes "still loading" from "loaded, nothing
  // annotated yet" for the editor panels, which look the same otherwise.
  const [layersDocLoaded, setLayersDocLoaded] = useState(false);
  // Cue currently focused (selected in the list or opened via canvas popover).
  const [focusedCue, setFocusedCue] = useState<{ layerId: string; itemId: string } | null>(null);
  const cuePopover = useCueEditPopover();
  // Keep the focusedCue highlight in sync with whichever popover is open.
  useEffect(() => {
    if (cuePopover.open) {
      setFocusedCue({ layerId: cuePopover.open.layerId, itemId: cuePopover.open.itemId });
    }
  }, [cuePopover.open]);

  // Boundaries have their own in-tab popover (BoundaryEditorPanel, opened via
  // openManualEditorRef) for when that chip is active — but the panel is
  // `display:none`d on every other chip, so its popover can't render there.
  // This page-level twin covers every other tab (e.g. viewing Boundaries as
  // read-along context while editing Lyrics), writing through
  // `updateBoundaryItems`, mirroring the Cue/Span/Loop popover pattern above.
  const boundaryPopover = useBoundaryEditPopover();

  // Loops (experimental, gated by Settings.experimentalLoopsAndPatterns).
  // Loop layers live in the same AnnotationLayersDocument as cue layers; the
  // editor / canvas filter by `type` so they don't bleed into each other.
  const [focusedLoop, setFocusedLoop] = useState<{ layerId: string; itemId: string } | null>(null);
  // While a loop preview runs, its engine owns the playhead — mirroring its
  // position into `playerTime` sweeps the waveform cursor, the lane rows and
  // every other currentTime-driven overlay through the loop instead of
  // freezing them where the track was last stopped. On stop the playhead goes
  // back to where the main player actually sits, so pressing Play resumes
  // from the same spot the cursor shows.
  const handleLoopPosition = useCallback((timeSec: number | null) => {
    setPlayerTime(timeSec ?? truePlayerTimeRef.current);
    // `playerTime` reaches the lane rows through a re-render; the player's own
    // playhead is placed imperatively off the media clock and would otherwise
    // stay parked where WaveSurfer was paused, one cursor out of step with
    // every other one on screen.
    externalTimeRef.current?.(timeSec);
  }, []);
  const loopPlayback = useLoopPlayback({ audioBuffer, onPosition: handleLoopPosition });
  // The hook returns a fresh object every render, so anything that closes over
  // `loopPlayback` itself churns its identity once per frame while a loop is
  // sounding — and an effect keyed on it re-runs that often. These three
  // members are stable; depend on them instead. (Same reason as
  // `stopLoopPlayback` further down.)
  const { play: playLoop, stop: stopLoop, setBounds: setLoopBounds, setRate: setLoopRate } = loopPlayback;
  // The four-row prominence strip on an item's lane belongs to the Prominence
  // section of the open card: expanding it is the user saying "I want the
  // prominence editor", and only then does the lane grow to hold one. It used
  // to open with the card itself, which put a full-height card on top of the
  // strip it had just revealed and left two editors up for one value.
  const prominenceEditing = useCardSectionOpen('prominence', false);
  const loopPopover = useLoopEditPopover();
  useEffect(() => {
    if (loopPopover.open) {
      setFocusedLoop({ layerId: loopPopover.open.layerId, itemId: loopPopover.open.itemId });
    }
  }, [loopPopover.open]);

  // Span layers share the AnnotationLayersDocument with cues/loops;
  // filtered by `type`. Always available — no experimental flag.
  const [focusedSpan, setFocusedSpan] = useState<{ layerId: string; itemId: string } | null>(null);
  const spanPopover = useSpanEditPopover();
  useEffect(() => {
    if (spanPopover.open) {
      setFocusedSpan({ layerId: spanPopover.open.layerId, itemId: spanPopover.open.itemId });
    }
  }, [spanPopover.open]);

  const [focusedRiffPattern, setFocusedRiffPattern] = useState<{ layerId: string; itemId: string } | null>(null);
  // Lyrics layers (word/line timestamps). Display + detector-review for now;
  // the in-place editor panel is wired separately.
  const [focusedLyrics, setFocusedLyrics] = useState<{ layerId: string; itemId: string } | null>(null);
  const riffPatternPopover = useRiffPatternEditPopover();
  const [riffAutoExpandIndex, setRiffAutoExpandIndex] = useState<number | null>(null);
  useEffect(() => {
    if (riffPatternPopover.open) {
      setFocusedRiffPattern({ layerId: riffPatternPopover.open.layerId, itemId: riffPatternPopover.open.itemId });
    }
  }, [riffPatternPopover.open]);
  const nodePopover = useNodeEditPopover();
  const energySpanPopover = useEnergySpanExportPopover();
  const [energySpanRange, setEnergySpanRange] = useState<{ start: number; end: number } | null>(null);
  // Which lane the open export was asked for, when it was asked for by name —
  // the energies lane's own "+ ADD" sets it; the pending pill's ⚡ ENERGY
  // clears it and lets the picker preselect the energies lane as before.
  const [energySpanTargetLayerId, setEnergySpanTargetLayerId] = useState<string | null>(null);
  // The Prominence lane's open lead-assign range, reported up by LeadLaneRow.
  // Used as a zoom focus; null whenever that picker is closed.
  const [leadPendingRange, setLeadPendingRange] = useState<{ start: number; end: number } | null>(null);
  // Which specific timeline placement (if any) the node popover was opened
  // from — a node has its own natural length, but each place it's placed in
  // a sequence can be independently stretched (`RiffSeqEntry.lengthSteps`).
  // Set only when opened via a direct lane click on a placed occurrence, so
  // the LENGTH field can show/edit THAT placement's length instead of the
  // node's own; cleared (falls back to the node's own length) for every
  // other entry point (sidebar node list, ✎ buttons with no occurrence).
  const [nodePopoverEntryCtx, setNodePopoverEntryCtx] =
    useState<{ patternItemId: string; entryIndex: number } | null>(null);
  const lyricsPopover = useLyricsEditPopover();
  useEffect(() => {
    if (lyricsPopover.open) {
      setFocusedLyrics({ layerId: lyricsPopover.open.layerId, itemId: lyricsPopover.open.itemId });
    }
  }, [lyricsPopover.open]);

  // ── Active ADD-target layer per multi-layer type ──────────────────────────
  // Set by clicking a layer card (or by picking from the ▾ next to ADD), and
  // promoted automatically every time we add into a layer. Held at page level
  // so the AnnotationAddPanel can render the picker without each editor panel
  // having to re-derive it. Resets to null when the active song changes — see
  // the song-change effect below.
  const [selectedCueLayerId, setSelectedCueLayerId] = useState<string | null>(null);
  const [selectedSpanLayerId, setSelectedSpanLayerId] = useState<string | null>(null);
  const [selectedLoopLayerId, setSelectedLoopLayerId] = useState<string | null>(null);
  const [selectedRiffPatternLayerId, setSelectedRiffPatternLayerId] = useState<string | null>(null);
  const [selectedLyricsLayerId, setSelectedLyricsLayerId] = useState<string | null>(null);
  const openManualEditorRef = useRef<((idx: number | null, anchor?: { x: number; y: number }) => void) | null>(null);
  // Metronome tap-tempo imperative handle — wired through to the Tap button
  // in MetronomePanel. Used by the T shortcut in /prep. Tapping sets the
  // metronome's own tempo only; it does not write back to the song's grid.
  const metronomeTapRef = useRef<(() => void) | null>(null);
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
    /** Their reference boundary reading, already time-sorted. */
    manual: SectionBlock[];
    autoGuess: AutoGuessManualAnnotation | null;
  } | null>(null);

  // ── MIR curves ────────────────────────────────────────────────────────────
  const [mirCurves, setMirCurves] = useState<MirCurves | null>(null);
  const [mirComputing, setMirComputing] = useState(false);

  // The loudness under an arbitrary span, laid out on that span's own beat
  // axis. Every path that turns detected hits into boundary blocks asks for
  // this so each block can run for as long as its hit actually sounds: a
  // fixed block gives a staccato stab and a held chord the same picture, and
  // the node stops describing the audio the moment it is seeded from it.
  // Null before the browser-side analysis has run, and for an older cached
  // run that predates `rms` — both cases fall back to the fixed block.
  const levelCurveForSpan = useCallback((
    startSec: number, endSec: number, lengthBeats: number,
  ): number[] | null => {
    if (!mirCurves?.rms || !(endSec > startSec) || !(lengthBeats > 0)) return null;
    const axis = mirCurves.hopSize && mirCurves.fftSize && mirCurves.sampleRate
      ? frameAxis(mirCurves.hopSize, mirCurves.fftSize, mirCurves.sampleRate, mirCurves.onsets.length)
      : { step: mirCurves.frameDuration, offset: 0, count: mirCurves.onsets.length };
    const win = sampleOnsetWindow(
      mirCurves.onsets, axis, startSec, endSec, lengthBeats, { levels: mirCurves.rms },
    );
    return win.levelCurve ?? null;
  }, [mirCurves]);

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
  // Detectors the user just ran for the current song. Their layers are hidden
  // by default when they first appear, which after an explicit run reads as
  // "nothing happened" — so each is un-hidden, and the Detectors sidebar
  // opened, once its layer turns up (see the effect beside urlDetsPendingRef).
  const revealDetectorsPendingRef = useRef(new Set<string>());
  // Per-detector review state: { detectorName: { pointId: { status, time } } }.
  // The pointId is `<itemIndex>:<original_time_ms>` so renumbering after a re-run
  // does not silently steal another point's review state.
  type CustomAnnotationOverride = { status?: AutoGuessPoint['status']; time?: number };
  const [customAnnotationOverrides, setCustomAnnotationOverrides] = useState<Record<string, Record<string, CustomAnnotationOverride>>>({});
  // Ref kept in sync so selectAudio (defined with empty deps) sees the current list.
  // Shipped detectors (custom-default/), for the lists that title Default apart.
  const defaultDetectorNames = useMemo(
    () => new Set(customDetectors.filter((d) => d.is_default).map((d) => d.name)),
    [customDetectors],
  );
  const customDetectorsRef = useRef<CustomRegistryEntry[]>([]);
  useEffect(() => { customDetectorsRef.current = customDetectors; }, [customDetectors]);
  // Registry-race back-fill: the per-song loader reads customDetectorsRef at
  // select time, but the registry (listDetectors) resolves asynchronously. On a
  // fresh session the song often loads BEFORE the registry, leaving the ref
  // empty so no curated detector results (overlays / Karaoke lyrics) ever load
  // until the user re-selects a song. When the registry arrives, back-fill each
  // ok detector's cached result for the currently-selected song. Idempotent:
  // skips any result already in state, so it never clobbers a live run.
  useEffect(() => {
    const entry = selectedAudioRef.current;
    if (!entry || customDetectors.length === 0) return;
    for (const det of customDetectors) {
      if (det.status !== 'ok') continue;
      getDetectorResult(det.name, entry.id).then((env) => {
        if (!env || selectedAudioRef.current?.id !== entry.id) return;
        setCustomResults((prev) => (prev[det.name] ? prev : { ...prev, [det.name]: env }));
      }).catch(() => {});
    }
  }, [customDetectors]);
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
  const [inspectSubStage, setInspectSubStage] = useState<InspectSubStage>(urlView.view ?? 'algo');
  // Top-level "what am I examining" kind for the inspect-song workspace. It sits
  // ABOVE the tab strip, because it names the subject every tab is a view of:
  // it drives the Evaluation tab's table and gates the boundaries-only Consensus
  // Inspect tab, which is hidden for every non-boundary kind.
  const [inspectKind, setInspectKind] = useState<ExaminableType>(urlView.kind ?? 'boundaries');
  // Switching the "Examine" kind also focuses the right-hand Algorithms
  // sidebar on the family that *produces* that kind, so the detectors you'd
  // run for the examined annotation are immediately visible (the sidebar
  // itself now stays mounted for every kind — see the algo-sidebar gate).
  const handleInspectKindChange = useCallback((k: AnnotationType) => {
    // The dropdown is fed `inspectKindOptions`, which never offers a
    // non-examinable kind — the guard is what tells the compiler so.
    if (!isExaminableType(k)) return;
    setInspectKind(k);
    const family = ALGO_FAMILY_FOR_INSPECT_KIND[k];
    if (family) setExpandedAlgoTypes((prev) => (prev.has(family) ? prev : new Set(prev).add(family)));
  }, []);
  // Consensus Inspect ('algo') only exists for boundaries; every other kind
  // collapses to the Evaluation tab regardless of which sub-tab was last open.
  // The Karaoke tab has a gate too, but it needs the karaoke source, which is
  // derived far below — so that one is applied in `inspectStage`, and nothing
  // between here and there asks anything finer than "is this the annotation
  // stage".
  const kindGatedSubStage: InspectSubStage =
    inspectSubStage === 'algo' && inspectKind !== 'boundaries' ? 'eval' : inspectSubStage;

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
    feature === 'inspect-song' ? kindGatedSubStage :
    feature === 'inspect-all'  ? 'global-eval' :
                                  'annotation';

  // ── Main-column width ────────────────────────────────────────────────────
  // The content column is capped so it stays readable with both side panels
  // open. Collapsing a panel is a deliberate "give me room" gesture, so the
  // width it gives up (everything but the 36px rail it leaves behind) is
  // handed to the content instead of becoming dead margin — which means the
  // waveform / visualizer actually shows more of the song.
  const COLLAPSED_RAIL_WIDTH = 36; // the w-9 rail a collapsed panel leaves
  const BASE_CONTENT_MAX_WIDTH = 1152; // max-w-6xl, the both-panels-open cap
  const rightPanel: { collapsed: boolean; width: number } | null =
    !selectedAudio                                   ? null :
    feature === 'annotate'                           ? { collapsed: annotateSidebarCollapsed, width: annotateSidebarWidth } :
    feature === 'inspect-song'                       ? { collapsed: algoSidebarCollapsed, width: algoSidebarWidth } :
    feature === 'prep' && activeStage === 'annotation' ? { collapsed: prepSidebarCollapsed, width: prepSidebarWidth } :
                                                       null;
  const reclaimedWidth =
    ((mode === 'song' || mode === 'prep') && sidebarCollapsed ? Math.max(0, sidebarWidth - COLLAPSED_RAIL_WIDTH) : 0) +
    (rightPanel?.collapsed ? Math.max(0, rightPanel.width - COLLAPSED_RAIL_WIDTH) : 0);
  const contentMaxWidth = BASE_CONTENT_MAX_WIDTH + reclaimedWidth;

  // ── Sub-tab ──────────────────────────────────────────────────────────────
  const [activeAnnotationType, setActiveAnnotationType] = useState<AnnotationType>(urlView.type ?? 'boundaries');

  // Per-category "source" — the value the AnnotationSourcePicker reflects for
  // the currently-active top-tab. For boundaries the source distinguishes
  // Manual / Auto-guess (rendered by separate panels); for non-boundary
  // categories the picker only writes here.
  //
  // `'autoGuess'` for non-boundary categories renders a "coming soon" banner —
  // no clustering algorithm exists for spans/cues/loops yet.
  // `'detector:<name>'` mounts the read-only detector output with the
  // accept/reject review chips (see DetectorOutputReview).
  const [activeSourceByType, setActiveSourceByType] = useState<Record<AnnotationCategory, SourceId>>({
    boundaries:      'manual',
    cues:            'manual',
    spans:           'manual',
    loops:           'manual',
    'riff-patterns': 'manual',
    lyrics:          'manual',
  });

  /** Records the most recent "copy algorithm output → Manual" action so it can
   *  be reverted with a single click. The copy is otherwise only undoable via
   *  the page-level Ctrl+Z stack (layers) or the Manual panel stack
   *  (boundaries), neither of which is discoverable right after the click.
   *  Cleared on undo, on dismiss, or when the song changes. */
  const [lastCopyUndo, setLastCopyUndo] = useState<
    { layerId: string; label: string; prevSource: SourceId; type: AnnotationCategory } | null
  >(null);

  /** The current boundary source as a `BoundarySource`. Returns `null` when
   *  the picker has a `detector:<name>` selection — in that case the source
   *  override block (DetectorOutputReview) renders instead of the per-source
   *  Manual/Auto-guess panels. */
  const activeBoundarySource: BoundarySource | null = isBoundarySource(activeSourceByType.boundaries)
    ? activeSourceByType.boundaries
    : null;

  // ── Auto-guess ↔ Consensus Inspect round trip ───────────────────────────
  // The two panels cluster the same detector boundaries with the same four
  // knobs, but only Consensus Inspect can score a setting (live P/R/F1 against
  // a reference) and only Auto-guess can save what the setting produces. These
  // two callbacks are the trip between them; the parameters travel separately
  // through state/consensusHandoff, which the arriving panel drains.
  const openAutoGuessPanel = useCallback(() => {
    setActiveAnnotationType('boundaries');
    setActiveSourceByType((prev) => ({ ...prev, boundaries: 'autoGuess' }));
    navigate('/annotate');
  }, [navigate]);

  const openConsensusInspect = useCallback(() => {
    setInspectKind('boundaries');
    setInspectSubStage('algo');
    navigate('/inspect');
  }, [navigate]);

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
      (outputKind === 'loop'     && category === 'loops')
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
  const [showAutoGuess, setShowAutoGuess]   = useState(() => getCurrentSettings().defaultShowAutoGuess);
  // Algorithm Inspect starts with every human annotation layer hidden — the
  // canvas should default to detector-only so it isn't cluttered with the
  // signed-in user's own annotation work. This is an opt-in visibility set
  // (layer id -> shown), scoped to inspect mode only; annotate/prep keep
  // using each layer's persisted `.visible` flag untouched. '__manual__' and
  // '__autoguess__' are sentinel ids for the Boundaries checkboxes, which
  // don't have a real layer id of their own.
  const [visibleAnnotationsInspect, setVisibleAnnotationsInspect] = useState<Set<string>>(new Set());
  const toggleAnnotationVisibleInspect = useCallback((id: string) => {
    setVisibleAnnotationsInspect((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  // Each workspace shows its own kind of output. The annotator's editable
  // layers are the Annotator Tool's subject; Algorithm Inspect's is what the
  // DETECTORS said. So a user-authored layer is not drawn or listed there at
  // all — it used to be, unticked, which read as the layer having been filed
  // with the algorithms when the only lyrics lanes on the canvas were
  // Whisper's. Same rule the Prominence lane already follows, and for the same
  // reason: front/back placement is the annotator's own work.
  //
  // Boundaries cross over, and are not really an exception: the manual
  // boundary layer is the reference every score on the Inspect page is
  // computed against, so it keeps its own switch there (`__manual__`), as does
  // Auto-guess. Both are addressed by name, not through this helper.
  const ownWorkspaceLayers = useCallback(<T,>(layers: readonly T[]): T[] =>
    (isInspect(feature) ? [] : [...layers]),
  [feature]);
  // The mirror of it. A detector's output is a *proposal* until somebody copies
  // it into a layer — it lives in the algorithm cache, not the annotator's
  // folder, and nothing downstream reads it — so it belongs to Algorithm
  // Inspect. Copy it there (the lane's ⬇) and the copy, now an annotation,
  // turns up in the Annotator Tool. That is the whole approval gesture: the
  // lane moves workspaces when it stops being a guess.
  const proposedLayers = useCallback(<T,>(layers: readonly T[]): T[] =>
    (isInspect(feature) ? [...layers] : []),
  [feature]);
  // The Prominence lane defaults OFF and isn't a saved setting. It is a
  // derived, cross-layer read of who is in front — worth opening when you go
  // looking for it, not a row to spend canvas height on before anyone asks.
  const [showProminence, setShowProminence] = useState(false);
  // Algorithm Inspect starts it off too, and keeps its own switch. That canvas
  // is supposed to show what the sidebar asks for — the detector rows you
  // checked, and nothing else — and front/back placement is the annotator's
  // own work, not a detector output you went there to read. Separate state
  // rather than one shared flag, so opening it while inspecting doesn't also
  // open it back in the annotator.
  const [showProminenceInspect, setShowProminenceInspect] = useState(false);
  // Which of the two the current feature reads and writes.
  const effShowProminence = isInspect(feature) ? showProminenceInspect : showProminence;
  const setEffShowProminence = isInspect(feature) ? setShowProminenceInspect : setShowProminence;
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
  // Grid Lock — lock snap on, bulk-re-snap all existing annotations
  // to the selected grid unit, display beat-relative times in cards.
  const [gridLock, setGridLock]   = useState(false);
  const [showGridLockModal, setShowGridLockModal] = useState(false);
  const [showNoBpmModal, setShowNoBpmModal]   = useState(false);
  const [gridLockUndoLayers, setGridLockUndoLayers] = useState<AnnotationLayer[] | null>(null);
  const [showGridLockUndoToast, setShowGridLockUndoToast] = useState(false);
  // What the undo toast says — the same snapshot/undo pair backs both the
  // enable-time bulk snap and a re-time after a grid edit.
  const [gridLockUndoLabel, setGridLockUndoLabel] = useState('Annotations snapped to grid.');
  // A grid edit made while Grid Lock is on, waiting for the annotator to say
  // whether their markers keep their milliseconds or their bars & beats.
  // `from` is the grid as it stood BEFORE the edit — re-timing reads musical
  // positions off that, so it works on annotations saved before beats were
  // ever stamped, and can't be defeated by a stale stamp.
  const [pendingGridChange, setPendingGridChange] =
    useState<{ from: BeatGrid; fromInfo: SongInfo | null; summary: string } | null>(null);
  // A standing answer to that question, ticked via "Remember my preference" in
  // the modal. Only the two KEEP answers can be remembered — an always-discard
  // would make the grid uneditable. Survives reloads; cleared from the toast.
  const [gridChangeChoice, setGridChangeChoice] = useState<'beats' | 'times' | null>(() => {
    try {
      const v = localStorage.getItem(GRID_CHANGE_CHOICE_KEY);
      return v === 'beats' || v === 'times' ? v : null;
    } catch { return null; }
  });
  const gridChangeChoiceRef = useRef(gridChangeChoice);
  gridChangeChoiceRef.current = gridChangeChoice;
  const rememberGridChoice = useCallback((choice: 'beats' | 'times' | null) => {
    setGridChangeChoice(choice);
    try {
      if (choice) localStorage.setItem(GRID_CHANGE_CHOICE_KEY, choice);
      else localStorage.removeItem(GRID_CHANGE_CHOICE_KEY);
    } catch { /* ignore quota */ }
  }, []);
  // True while the toast on screen reports a re-time that happened WITHOUT
  // asking — it then also offers "Ask me next time".
  const [gridLockUndoRemembered, setGridLockUndoRemembered] = useState(false);
  // True while the undo on screen has a Grid Lock to put back: "keep their
  // milliseconds" turns the lock off, so undoing only the annotations would
  // leave the song half-restored — the old times back, the mode they were
  // written under still gone.
  const [gridLockUndoRelock, setGridLockUndoRelock] = useState(false);
  // The toast reports something already done, so it shouldn't sit on screen
  // waiting to be dismissed. The label is a dependency so a second re-time
  // restarts the clock instead of inheriting the first one's remaining time.
  // Hiding it leaves the undo snapshot intact — same as pressing ✕.
  useEffect(() => {
    if (!showGridLockUndoToast) return;
    const id = setTimeout(() => setShowGridLockUndoToast(false), 5000);
    return () => clearTimeout(id);
  }, [showGridLockUndoToast, gridLockUndoLabel]);
  // One-line, self-dismissing notice for adds that couldn't honor the
  // selection as-drawn (today: a region added to Cues, which are points).
  const [annotationNotice, setAnnotationNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!annotationNotice) return;
    const id = setTimeout(() => setAnnotationNotice(null), 6000);
    return () => clearTimeout(id);
  }, [annotationNotice]);
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
  // Hard-suppress the browser's two-finger swipe-back/forward at the compositor
  // level while capture is on. The viz/waveform wheel listeners call
  // preventDefault(), but on macOS Chrome/Safari history-swipe is driven on the
  // compositor thread and ignores wheel preventDefault() — so a left-swipe over
  // anything *outside* those containers (e.g. the algo-inspect rows) still
  // navigates back. overscroll-behavior-x:none on the root is the only reliable
  // cure. Scoped to documentElement + body so flipping the toggle off restores
  // native history-swipe.
  useEffect(() => {
    const root = document.documentElement;
    const { body } = document;
    const prevRoot = root.style.overscrollBehaviorX;
    const prevBody = body.style.overscrollBehaviorX;
    if (captureGlobalHScroll) {
      root.style.overscrollBehaviorX = 'none';
      body.style.overscrollBehaviorX = 'none';
    }
    return () => {
      root.style.overscrollBehaviorX = prevRoot;
      body.style.overscrollBehaviorX = prevBody;
    };
  }, [captureGlobalHScroll]);
  // Beat-grid line width multiplier (Misc dropdown). Scales every grid line
  // uniformly; persisted across sessions. Clamped to the slider's [0.5, 10].
  const [gridLineThickness, setGridLineThicknessState] = useState<number>(() => {
    if (typeof window === 'undefined') return 1;
    try {
      const n = parseFloat(window.localStorage.getItem('tc.gridLineThickness') ?? '');
      return Number.isFinite(n) && n >= 0.25 && n <= 10 ? n : 1;
    } catch { return 1; }
  });
  const setGridLineThickness = useCallback((v: number) => {
    const clamped = Math.max(0.25, Math.min(10, v));
    setGridLineThicknessState(clamped);
    try { window.localStorage.setItem('tc.gridLineThickness', String(clamped)); } catch { /* ignore quota */ }
  }, []);
  // …and whether that multiplier rides the player's zoom. On by default: at
  // fit the grid is dense enough that fixed-width lines smear the waveform,
  // while a deep zoom leaves them hairline-thin. Off = the slider's value is
  // taken literally at every zoom.
  const [gridThicknessAdaptive, setGridThicknessAdaptiveState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    try { return window.localStorage.getItem('tc.gridThicknessAdaptive') !== '0'; } catch { return true; }
  });
  const setGridThicknessAdaptive = useCallback((v: boolean) => {
    setGridThicknessAdaptiveState(v);
    try { window.localStorage.setItem('tc.gridThicknessAdaptive', v ? '1' : '0'); } catch { /* ignore quota */ }
  }, []);
  // What every grid-drawing surface actually gets.
  const effectiveGridLineThickness = gridThicknessAdaptive
    ? gridLineThickness * adaptiveGridThicknessScale(vizZoomFactor)
    : gridLineThickness;
  // Algo overlays
  const [selectedAlgoOverlays, setSelectedAlgoOverlays] = useState<Set<string>>(new Set());
  // Boundary merge — the hand-picked blend of boundary algo lanes drawn on the
  // viz "Merge" row. Per-song: it is a way of reading THIS song's lanes
  // against each other, not a detector. Member ids are an array, not a Set,
  // because the order they were picked in is the order their chips (and the
  // layer name) read; `mergeDropped` holds the times the annotator struck out
  // of the union by hand. Both are remembered per song (see the load/save
  // effects below) so a reload comes back to the blend you were reading —
  // committing is still what turns a merge into something durable and shared.
  const [mergeMemberIds, setMergeMemberIds] = useState<string[]>([]);
  const [mergeDropped, setMergeDropped] = useState<number[]>([]);
  // Which song the two above describe. The save effect reads this rather than
  // `selectedAudio`, so a song switch can never write the outgoing song's
  // merge under the incoming song's id.
  const mergeSongIdRef = useRef<string | null>(null);
  // Single-select stem sub-filter for Algorithm Inspect. It composes with the
  // family chips: the chips choose WHICH algorithms are shown, the stem filter
  // then narrows those to one stem's rows. 'mix' (default) = full-mix rows only
  // — the clean default, matching the old behavior where opening a chip showed
  // full-mix rows; a stem name = each selected algorithm's <stem> variant; 'all'
  // = full-mix rows plus every per-stem variant of a selected algorithm (the
  // opt-in "everything" view). The base (mix) row carries the chip selection;
  // the stem filter decides which variants ride along. Replaces the old
  // multi-toggle "Show per stem" + per-family "Stem layers" controls.
  const [inspectStemFilter, setInspectStemFilter] = useState<StemSource | 'all'>('mix');
  // Stem lock: the player's stem and the stem filter above move together, so
  // what you hear is what the sidebar narrows to. On by default; the Misc
  // dropdown unlocks it for hearing one stem while reading another's rows.
  // Persisted like the other Misc toggles — only an explicit '0' opts out.
  const [stemLock, setStemLockState] = useState<boolean>(() => {
    try { return window.localStorage.getItem('tc.stemLock') !== '0'; } catch { return true; }
  });
  const [mirTolerance, setMirTolerance]     = useState(0.5);
  // The consensus the Algorithm-Inspect stage is currently showing, lifted here
  // so the viz panel can draw it as a timeline row. The stage owns every knob
  // that shapes it and clears this on unmount, so the row lives exactly as long
  // as the stage that explains it.
  const [consensusViz, setConsensusViz] = useState<ConsensusVizState | null>(null);
  // Which LYRICS detector lane the user clicked on the inspect canvas. The
  // lane's own highlight lives inside SharedVizPanel; this is only the page's
  // copy of "the user is pointing at this transcript", which is what lets the
  // karaoke follow a detector lane and not just an annotation layer. Null for
  // every other algo lane, because pointing at a boundary detector is not
  // asking to read words.
  const [selectedLyricsAlgoId, setSelectedLyricsAlgoId] = useState<string | null>(null);
  // ...and whether its lane is drawn. A boundary source the user turns on like
  // any other, under Algos ▸ Consensus — OFF by default: the canvas starts as
  // whatever the sidebar has checked, and the consensus already draws itself
  // in the stage that builds it, right below. Ticking it here is asking for
  // the second copy, the one aligned with the detector lanes it was blended
  // from.
  const [showConsensus, setShowConsensus] = useState(false);
  // Row order — fixed rows only; algo IDs are inserted/removed dynamically
  const [rowOrder, setRowOrder] = useState<VizRowId[]>(DEFAULT_FIXED_ROW_ORDER);
  const [hasCustomRowOrder, setHasCustomRowOrder] = useState(false);
  // Section-color palette overrides (keyed by section type, e.g. 'intro' → '#ff00ff')
  const [sectionColorOverrides, setSectionColorOverrides] = useState<Record<string, string>>({});
  const [boundaryColoringMode, setBoundaryColoringMode] = useState<BoundaryColoringMode>(() => {
    try { return (localStorage.getItem('tc:boundary-coloring-mode') as BoundaryColoringMode) || 'by-type'; } catch { return 'by-type'; }
  });
  useEffect(() => {
    try { localStorage.setItem('tc:boundary-coloring-mode', boundaryColoringMode); } catch {}
  }, [boundaryColoringMode]);
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
  // Boundaries track time per source (manual/autoGuess); layer types
  // track time per type. See [[TimerKey]] for the union.
  const [annotationTimesSaved, setAnnotationTimesSaved] = useState<Record<TimerKey, number>>(
    { manual: 0, autoGuess: 0, cues: 0, spans: 0, loops: 0, lyrics: 0 },
  );                                                                   // persisted seconds for current song, per key
  const annotationSessionStartRef = useRef<number | null>(null);       // ms timestamp when current session started
  const annotationSessionTypeRef  = useRef<TimerKey | null>(null);     // which key the current session belongs to
  const [timerRunning, setTimerRunning] = useState(false);             // drives the ticker effect
  const [, setAnnotationTimerTick] = useState(0);                      // forces re-render every second

  // ── Player refs ───────────────────────────────────────────────────────────
  // Reactive state ref — keeps the latest songInfo accessible from shortcut
  // handlers that need to read bpm / gridOffset synchronously.
  const songInfoRef = useRef(songInfo);
  songInfoRef.current = songInfo;
  const seekRef    = useRef<((time: number) => void) | null>(null);
  const playRef    = useRef<(() => void) | null>(null);
  const pauseRef   = useRef<(() => void) | null>(null);
  // The live media clock, straight off WaveSurfer. `playerTime` below is this
  // same number one rAF + setState + inspector re-render later, which is fine
  // for drawing and wrong for placing audio — the click track anchors here.
  const getTimeRef = useRef<(() => number) | null>(null);
  // Places the player's own cursor while the loop-preview engine — not the
  // media element — is sounding the audio. See `handleLoopPosition`.
  const externalTimeRef = useRef<((time: number | null) => void) | null>(null);
  // `liveSongTime`, reachable from the handlers defined above it. It needs the
  // loop-playback ref, which is declared much further down, so rather than
  // reorder half the file the mark handlers late-bind through this — the same
  // trick `reviewDetectorAtPlayheadRef` uses.
  const liveSongTimeRef = useRef<((eventTs?: number) => number | null) | null>(null);
  const wsScrollRef = useRef<((scrollLeft: number) => void) | null>(null);
  const zoomInRef    = useRef<(() => void) | null>(null);
  const zoomOutRef   = useRef<(() => void) | null>(null);
  const zoomResetRef = useRef<(() => void) | null>(null);
  const pinchZoomInRef  = useRef<(() => void) | null>(null);
  const pinchZoomOutRef = useRef<(() => void) | null>(null);
  const scrollToTimeRef = useRef<((time: number, align?: 'center' | 'left') => void) | null>(null);
  const zoomToRangeRef  = useRef<ZoomToRange | null>(null);
  const vizScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const isProgrammaticScrollRef = useRef(false);
  // Scroll position the player asked the viz rows for while they were still
  // too narrow to honour it. See handleScrollChange.
  const desiredVizScrollRef = useRef<number | null>(null);

  // ── Shortcuts help panel ─────────────────────────────────────────────────
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [exportManagerOpen, setExportManagerOpen] = useState(false);
  // Bulk import — opens the dataset import dialog from the prep sidebar.
  const [importDatasetOpen, setImportDatasetOpen] = useState(false);
  // BPM-not-set warning. Two ways in: clicking a BPM-less song in Annotator
  // Tool ('select' — the dialog's actions still have to select it), or
  // switching into Annotator Tool while the already-selected song has no BPM
  // ('enter' — nothing to select, so those actions only navigate). Stored
  // with the candidate AudioEntry so the dialog can name the song.
  const [bpmWarningSong, setBpmWarningSong] =
    useState<{ song: AudioEntry; origin: 'select' | 'enter' } | null>(null);
  // Songs the user already waved through this session, so the entry gate
  // doesn't re-nag on every tab switch.
  const bpmWarningAcked = useRef<Set<string>>(new Set());
  // Entry gate: switching INTO Annotator Tool with a BPM-less song already
  // selected surfaces the same warning the song-row click does. Without it a
  // fresh upload (selected in Dataprep, no BPM yet) would slip into
  // annotation unwarned. Fires on the transition only — never on mount, and
  // never while the workspace stays put — and reads the same songInfos map
  // the sidebar rows use so a BPM set in Dataprep counts immediately.
  const prevFeatureRef = useRef<Feature>(feature);
  useEffect(() => {
    const prev = prevFeatureRef.current;
    prevFeatureRef.current = feature;
    if (prev === 'annotate' || feature !== 'annotate') return;
    if (!selectedAudio || bpmWarningAcked.current.has(selectedAudio.id)) return;
    const info = songInfo?.song === selectedAudio.id ? songInfo : songInfos[selectedAudio.id];
    const hasBpm = typeof info?.bpm === 'number' && info.bpm > 0;
    if (!hasBpm) setBpmWarningSong({ song: selectedAudio, origin: 'enter' });
  }, [feature, selectedAudio, songInfo, songInfos]);

  // ── Shared annotation toolbar / add-panel wiring ─────────────────────────
  // Each editor panel exposes an AnnotationPanelController via forwardRef and
  // emits a capabilities snapshot via onCapabilitiesChange. The page selects
  // the active type's snapshot + controller to drive the shared toolbar.
  const manualPanelRef = useRef<AnnotationPanelController>(null);
  const autoGuessPanelRef = useRef<AnnotationPanelController>(null);
  const cuesPanelRef = useRef<AnnotationPanelController>(null);
  const spansPanelRef = useRef<AnnotationPanelController>(null);
  const loopsPanelRef = useRef<AnnotationPanelController>(null);
  const riffPatternsPanelRef = useRef<AnnotationPanelController>(null);
  const lyricsPanelRef = useRef<AnnotationPanelController>(null);
  const [manualCaps, setManualCaps] = useState<AnnotationPanelCapabilities | null>(null);
  const [autoGuessCaps, setAutoGuessCaps] = useState<AnnotationPanelCapabilities | null>(null);
  const [cuesCaps, setCuesCaps] = useState<AnnotationPanelCapabilities | null>(null);
  const [spansCaps, setSpansCaps] = useState<AnnotationPanelCapabilities | null>(null);
  const [loopsCaps, setLoopsCaps] = useState<AnnotationPanelCapabilities | null>(null);
  const [riffPatternsCaps, setRiffPatternsCaps] = useState<AnnotationPanelCapabilities | null>(null);
  const [lyricsCaps, setLyricsCaps] = useState<AnnotationPanelCapabilities | null>(null);
  // Layers-doc save indicator state (the page owns the debounced saveLayers).
  // Cues/Spans/Loops all surface this same indicator in their
  // capability snapshot since they share the cueLayersDoc.
  const [layersDocSaveStatus, setLayersDocSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  // Shared-song edit lease. Solo songs (the default) short-circuit inside the
  // hook — `shared` comes back false and no request is ever made.
  const annotationLock = useAnnotationLock(selectedAudio?.id ?? null);
  // Keep the guard above in step with the lease, and clear a stale refusal
  // notice when the answer changes or the user moves to another song.
  useEffect(() => { canEditDocRef.current = annotationLock.canEdit; }, [annotationLock.canEdit]);
  useEffect(() => { setBlockedByLock(false); }, [selectedAudio?.id, annotationLock.canEdit]);
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

  // Kinds the inspect-song "Examine" picker offers. Mirrors EvaluationStage's
  // visible-tabs logic: boundaries always, the experimental families only when
  // a song is selected (their tables need a slug). When this collapses to just
  // boundaries the picker hides itself and the workspace looks unchanged.
  const inspectKindOptions = useMemo<ExaminableType[]>(() => {
    const out: ExaminableType[] = ['boundaries'];
    if (selectedAudio) {
      if (settings.experimentalCueExtras)     out.push('cues');
      if (settings.experimentalSpanFamily)    out.push('spans');
      if (settings.experimentalLoopFamily)    out.push('loops');
      if (settings.experimentalLyricsFamily)  out.push('lyrics');
    }
    return out;
  }, [
    selectedAudio,
    settings.experimentalCueExtras,
    settings.experimentalSpanFamily,
    settings.experimentalLoopFamily,
    settings.experimentalLyricsFamily,
  ]);

  // Snap the examined kind back to boundaries if it vanishes (flag flipped off
  // or song deselected) so a stale non-boundary kind can't strand the UI on a
  // hidden tab.
  useEffect(() => {
    if (!inspectKindOptions.includes(inspectKind)) setInspectKind('boundaries');
  }, [inspectKindOptions, inspectKind]);

  // Whether each experimental family's sidecar is part of the running image.
  // Gates the inspector run-sidebar sections below so a persisted-on flag whose
  // sidecar later disappears doesn't leak un-runnable "RUN MISSING" rows.
  const expAvail = useExperimentalAvailability();
  const performDeleteActive = useCallback(async () => {
    if (!selectedAudio) return;
    const id = selectedAudio.id;
    // Layer-types (cues/spans/loops) delegate to the panel's
    // controller — it filters its own type-slice out of the shared
    // cueLayersDoc and emits a new doc via onDocChange. The page-level
    // saveLayers debounce persists the change. No server-side endpoint to
    // call from here.
    // Boundaries on the `manual` source are a layer kind like any other, so
    // they go through their panel controller too; only auto-guess still has a
    // document of its own to delete.
    if (activeAnnotationType !== 'boundaries' || activeBoundarySource === 'manual') {
      const ctl = activeAnnotationType === 'boundaries' ? manualPanelRef.current
                : activeAnnotationType === 'cues'   ? cuesPanelRef.current
                : activeAnnotationType === 'spans'  ? spansPanelRef.current
                : activeAnnotationType === 'loops'  ? loopsPanelRef.current
                : activeAnnotationType === 'lyrics' ? lyricsPanelRef.current
                : null;
      ctl?.deleteAll?.();
      return;
    }
    if (activeBoundarySource !== 'autoGuess') {
      // Detector source — nothing to delete here (the source is the algorithm
      // output; the review file is handled inside DetectorOutputReview).
      return;
    }
    await deleteAutoGuessAnnotation(id);
    setAutoGuessAnnotation(null);
    // Clear the status field so the sidebar badge falls back to "Not started".
    // The status-sync effect uses `??` to preserve the existing status while
    // annotations are still loading, so it can't distinguish a delete from a
    // load — we have to clear it explicitly here.
    setSongStatuses((prev) => {
      const existing = prev[id];
      if (!existing) return prev;
      return { ...prev, [id]: { ...existing, auto_guess_status: undefined } };
    });
  }, [selectedAudio, activeAnnotationType, activeBoundarySource]);

  // Wipe every annotation (auto-guess + every layer: boundaries, cues,
  // spans, loops) for the current song. Triggered by the
  // ✕ Delete-all button in the Annotation section header next to Export.
  const performDeleteAllForSong = useCallback(async () => {
    if (!selectedAudio) return;
    const id = selectedAudio.id;
    await deleteAutoGuessAnnotation(id);
    setAutoGuessAnnotation(null);
    // Whole-song wipe — the auto-guess deletion is not undoable, so undoing
    // only the layers slice back would be misleading.
    annotationDocsCtl.reset(emptyLayersDoc(id));
    setSongStatuses((prev) => {
      const existing = prev[id];
      if (!existing) return prev;
      return { ...prev, [id]: { ...existing, auto_guess_status: undefined } };
    });
  }, [selectedAudio, annotationDocsCtl]);

  // Mirror the active annotation type + boundary source into refs so shortcut
  // handlers (which close over playerTimeRef etc. and never re-bind) can read
  // the latest values.
  const activeAnnotationTypeRef = useRef<AnnotationType>('boundaries');
  useEffect(() => { activeAnnotationTypeRef.current = activeAnnotationType; }, [activeAnnotationType]);
  const activeBoundarySourceRef = useRef<BoundarySource | null>('manual');
  useEffect(() => { activeBoundarySourceRef.current = activeBoundarySource; }, [activeBoundarySource]);

  const focusedCueRef = useRef<{ layerId: string; itemId: string } | null>(null);
  useEffect(() => { focusedCueRef.current = focusedCue; }, [focusedCue]);
  // Mirror pending drag-selection so the Enter shortcut can gate its match
  // function on "a region is selected" without rebinding when the selection
  // changes.
  const pendingAnnotationSelectionRef = useRef<PendingSelection | null>(null);
  useEffect(() => { pendingAnnotationSelectionRef.current = pendingAnnotationSelection; }, [pendingAnnotationSelection]);
  // Mirror Auto-guess annotations so [ / ] can navigate their points
  // without rebinding when the data changes.
  const autoGuessAnnotationRef = useRef<AutoGuessManualAnnotation | null>(null);
  useEffect(() => { autoGuessAnnotationRef.current = autoGuessAnnotation; }, [autoGuessAnnotation]);

  const sectionStopAtRef = useRef<number | null>(null);

  // Accept / reject the detector suggestion at the playhead (Y / N). Late-bound
  // through a ref because the detector layers it reads are assembled far below
  // the shortcut table, which is built earlier in this render. Returns false
  // when the active tab isn't showing a detector layer, so the key falls
  // through instead of silently doing nothing.
  const reviewDetectorAtPlayheadRef = useRef<(status: DetectorReviewStatus) => boolean>(() => false);

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

  // The highlighted region on the viz IS the selection every "+ Add" acts on.
  // Normally the pending pill and the drag-preview band are two views of the
  // same gesture, but the band outlives the pill: moving or resizing it clears
  // the pill (`onRegionDragStart`), and `L` opens a 6s preview window without
  // ever setting one. Whenever they disagree the user still sees exactly one
  // highlighted region, so adds follow it instead of silently falling back to
  // the playhead.
  const effectiveAnnotationSelection = useMemo<PendingSelection | null>(() => (
    pendingAnnotationSelection
    ?? (previewRegion ? { t1: previewRegion.start, t2: previewRegion.end } : null)
  ), [pendingAnnotationSelection, previewRegion]);
  // The same highlight as a plain [start, end) — the window the lyrics
  // section re-run reads. A one-ended selection (a click, no drag) spans no
  // audio, so it is no window at all and the panel stays hidden.
  const rerunSelection = useMemo(() => (
    effectiveAnnotationSelection?.t2 != null
      ? { start: effectiveAnnotationSelection.t1, end: effectiveAnnotationSelection.t2 }
      : null
  ), [effectiveAnnotationSelection]);
  // Ref twin, so the Enter shortcut and the selection-consuming handlers
  // (riff node, energy export) see the same fallback without rebinding.
  const effectiveAnnotationSelectionRef = useRef<PendingSelection | null>(null);
  useEffect(() => {
    effectiveAnnotationSelectionRef.current = effectiveAnnotationSelection;
  }, [effectiveAnnotationSelection]);

  // ── Zoom focus — what the ± buttons put in the middle of the viewport ─────
  // Priority: a canvas range with its picker open, then the highlighted region
  // (pending pill or preview band) or the selected annotation item — whichever
  // the user touched last. Returning null hands the decision back to
  // PlayerPanel, which centres the playhead.
  //
  // The highlight and an item's selection are both long-lived: a preview band
  // sits there until you click it away, and clicking the waveform moves the
  // cursor without deselecting a card. So both can be live at once — drag a
  // new band while an old span is still focused, or click a span in the list
  // while yesterday's band is still on the viz — and a fixed winner is wrong
  // half the time. The one the user reached for most recently is the one they
  // are looking at, so that is the one a zoom step frames.
  const zoomFocusSeqRef = useRef(0);
  const highlightStampRef = useRef(0);
  const itemFocusStampRef = useRef(0);
  useEffect(() => {
    if (effectiveAnnotationSelection) highlightStampRef.current = ++zoomFocusSeqRef.current;
  }, [effectiveAnnotationSelection]);
  useEffect(() => {
    if (focusedCue || focusedSpan || focusedLoop || focusedRiffPattern
        || focusedLyrics || boundaryPopover.open) {
      itemFocusStampRef.current = ++zoomFocusSeqRef.current;
    }
  }, [focusedCue, focusedSpan, focusedLoop, focusedRiffPattern,
      focusedLyrics, boundaryPopover.open]);

  const getZoomFocusTime = useCallback((): number | null => {
    // A range whose picker is open is the most explicit "this is what I'm
    // working on" there is, and it outlives no other gesture — so it goes first.
    if (leadPendingRange) return (leadPendingRange.start + leadPendingRange.end) / 2;
    if (energySpanPopover.open && energySpanRange) {
      return (energySpanRange.start + energySpanRange.end) / 2;
    }

    // The highlighted region — the pending pill or the drag preview band. It
    // is the thing on screen the user can point at, so it beats a selected
    // item unless that item was the more recent of the two gestures.
    const sel = effectiveAnnotationSelection;
    const selCenter = sel ? (sel.t2 == null ? sel.t1 : (sel.t1 + sel.t2) / 2) : null;
    if (selCenter != null && highlightStampRef.current >= itemFocusStampRef.current) return selCenter;

    // A selected item, of ANY layer type — not just the active tab's. A span
    // stays selected while you read the Boundaries list or work the Prominence
    // lane, and zooming should still frame it. The active type is tried first
    // so it wins whenever several types hold a selection at once.
    const focusedByType: Partial<Record<AnnotationType, { layerId: string; itemId: string } | null>> = {
      cues: focusedCue,
      spans: focusedSpan,
      loops: focusedLoop,
      'riff-patterns': focusedRiffPattern,
      lyrics: focusedLyrics,
    };
    const order: AnnotationType[] = [
      activeAnnotationType, 'cues', 'spans', 'loops', 'riff-patterns', 'lyrics',
    ];
    for (const type of order) {
      const focused = focusedByType[type];
      if (!focused || !cueLayersDoc) continue;
      const layer = cueLayersDoc.layers.find((l) => l.id === focused.layerId);
      const items = layer?.items as { id: string; time?: number; start?: number; end?: number }[] | undefined;
      const item = items?.find((it) => it.id === focused.itemId);
      // Point items carry `time`; intervals carry [start, end] and centre on
      // the middle of the interval so the whole item stays framed.
      if (item?.start != null) return item.end != null ? (item.start + item.end) / 2 : item.start;
      if (item?.time != null) return item.time;
    }

    // Boundaries have no persistent focus — the open edit popover is the
    // selection. A section spans from its own time to the next one's.
    if (boundaryPopover.open) {
      const layer = boundaryLayersList.find((l) => l.id === boundaryPopover.open!.layerId);
      const idx = layer?.items.findIndex((it) => it.id === boundaryPopover.open!.itemId) ?? -1;
      if (layer && idx >= 0) {
        const start = layer.items[idx].time;
        const end = idx + 1 < layer.items.length ? layer.items[idx + 1].time : duration;
        return end > start ? (start + end) / 2 : start;
      }
    }

    // Nothing focused after all (a stale focus pointing at a deleted item, an
    // empty popover) — the highlight is still there to fall back on.
    return selCenter;
  }, [leadPendingRange, energySpanPopover.open, energySpanRange,
      activeAnnotationType, focusedCue, focusedSpan, focusedLoop,
      focusedRiffPattern, focusedLyrics, cueLayersDoc, boundaryPopover.open,
      boundaryLayersList, duration, effectiveAnnotationSelection]);

  // ── Load manifest + reopen the song from the URL (or the last one) ───────
  useEffect(() => {
    // StrictMode mounts this twice in dev, and both fetches resolve. Opening
    // the song twice is not harmless: selectAudio clears the drawn lanes, so
    // the second open wiped whatever the link had just restored.
    let cancelled = false;
    fetchManifest().then((files) => {
      if (cancelled) return;
      setAudioFiles(files);
      if (!selectedAudio) {
        const first = initialSong(files, urlView.song);
        if (first) selectAudio(first);
      }
    });
    loadAllAutoGuessStatuses().then(setSongStatuses);
    loadAllLayerStatuses().then(setSongLayerStatuses);
    refreshStorageStats();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedAudio) writeLastSong(selectedAudio.id);
  }, [selectedAudio?.id]);

  // Refresh statuses when the logged-in annotator changes — the sidebar's
  // overall annotation indicator is scoped to that annotator's folder on disk.
  useEffect(() => {
    loadAllAutoGuessStatuses().then(setSongStatuses).catch(() => setSongStatuses({}));
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

  // ── Who else annotated what ───────────────────────────────────────────────
  // Only the Shared / private grouping needs this, and it is a walk of the
  // annotation tree server-side, so it is fetched when that mode is actually
  // picked rather than on every page load — except that every row now wears the
  // count as a badge, so the sidebar asks once as soon as it has a catalogue.
  // Kept once it arrives; re-asked when the Who-else-annotated grouping is
  // picked after a failure, or when the signed-in annotator changes (whose work
  // is "mine" moves with them).
  const [songSharing, setSongSharing] = useState<SongSharingInfo>({ state: 'loading' });
  useEffect(() => { setSongSharing({ state: 'loading' }); }, [annotator?.id]);
  // Picking the mode again after it came back empty-handed is a retry — the
  // corpus config or the caller's tier may have moved since. Keyed on the mode
  // alone, so it fires once per switch and can't chase its own failure.
  useEffect(() => {
    if (songGroupMode !== 'sharing') return;
    setSongSharing((prev) => (prev.state === 'unavailable' ? { state: 'loading' } : prev));
  }, [songGroupMode]);
  useEffect(() => {
    if (songSharing.state !== 'loading') return;
    // Nothing to ask about yet — and asking before the catalogue lands would
    // walk the annotation tree for an empty sidebar.
    if (audioFiles.length === 0) return;
    // Demo visitors have no team to share with, and the endpoint would refuse
    // them — say so without the round trip.
    if (isDemo) { setSongSharing({ state: 'unavailable' }); return; }
    let cancelled = false;
    fetchSongAnnotators()
      .then((res) => {
        if (cancelled) return;
        setSongSharing(res.sharedCorpus
          ? { state: 'shared-corpus' }
          : { state: 'ready', counts: res.counts, mine: new Set(res.mine) });
      })
      .catch(() => { if (!cancelled) setSongSharing({ state: 'unavailable' }); });
    return () => { cancelled = true; };
  }, [songSharing.state, isDemo, audioFiles.length]);

  // ── Which songs are collaborative ─────────────────────────────────────────
  // The song's own shared/per-annotator setting, the one its header offers as
  // "Make collaborative…". Same lazy shape as the annotator counts above: asked
  // when the grouping that needs it is picked, retried when it is re-picked
  // after a failure.
  const [songCollaboration, setSongCollaboration] = useState<SongCollaborationInfo>({ state: 'loading' });
  useEffect(() => { setSongCollaboration({ state: 'loading' }); }, [annotator?.id]);
  useEffect(() => {
    if (songGroupMode !== 'collaborative') return;
    setSongCollaboration((prev) => (prev.state === 'unavailable' ? { state: 'loading' } : prev));
  }, [songGroupMode]);
  useEffect(() => {
    if (songCollaboration.state !== 'loading') return;
    if (audioFiles.length === 0) return;
    // Demo visitors are shown the shipped corpus, which has no team and no
    // collaborative songs — and asking would read the team corpus's list.
    if (isDemo) { setSongCollaboration({ state: 'unavailable' }); return; }
    let cancelled = false;
    fetchSharedSlugs()
      .then((res) => { if (!cancelled) setSongCollaboration({ state: 'ready', shared: new Set(res.shared) }); })
      .catch(() => { if (!cancelled) setSongCollaboration({ state: 'unavailable' }); });
    return () => { cancelled = true; };
  }, [songCollaboration.state, isDemo, audioFiles.length]);

  // ── Sidebar grouping ──────────────────────────────────────────────────────
  // Recomputed when the catalogue or the song-info cache moves, so renaming a
  // song's artist — or typing a collection — in Dataset Prep refiles its row
  // without a manifest refetch.
  const songGroups = useMemo(
    () => groupSongs(songGroupMode, audioFiles, {
      infos: songInfos,
      layerStatuses: songLayerStatuses,
      autoGuessStatuses: songStatuses,
      includeLoopsAndPatterns: settings.experimentalLoopsAndPatterns,
      sharing: songSharing,
      collaboration: songCollaboration,
    }),
    [songGroupMode, audioFiles, songInfos, songLayerStatuses, songStatuses, settings.experimentalLoopsAndPatterns, songSharing, songCollaboration],
  );
  // Which songs are collaborative, once the answer exists. Rows read it for
  // their SHARED badge; the groupings read the state around it.
  const collaborationReady = songCollaboration.state === 'ready' ? songCollaboration : null;
  // The annotator counts, once they exist. Rows read this directly for their
  // badge; the grouping reads the state around it.
  const sharingReady = songSharing.state === 'ready' ? songSharing : null;
  // Every collection name in use, for the editor's reuse list. Derived here
  // because this is where every song's info is already loaded; the panel only
  // sees the one song it is editing, which is exactly how a second spelling of
  // an existing collection gets typed.
  const knownCollections = useMemo(() => {
    const names = new Set<string>();
    for (const info of Object.values(songInfos)) {
      const name = songCollection(info);
      if (name) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [songInfos]);
  // Group by is an explicit choice, so its headings are drawn even when every
  // song lands in one bucket — "all 12 of these still have no BPM" is an answer,
  // and a mode that silently rendered the same flat list would read as broken.
  // Only Nothing draws no headings.
  const showSongGroupHeadings = songGroupMode !== 'none';
  // Songs get selected from outside the list too — first-song auto-select, the
  // post-delete fallback, the BPM warning dialog. Unfold whichever group holds
  // the selection so the highlighted row is never hidden inside a folded group.
  // Folding it again afterwards sticks: this only re-runs when the selection or
  // the grouping itself changes, not when the user toggles a heading.
  useEffect(() => {
    const slug = selectedAudio?.id;
    if (!slug) return;
    const group = songGroups.find((g) => g.songs.some((song) => song.id === slug));
    if (!group) return;
    setCollapsedSongGroups((prev) => {
      if (!prev.has(group.key)) return prev;
      const next = new Set(prev);
      next.delete(group.key);
      return next;
    });
  }, [selectedAudio, songGroups]);

  // ── Sync current song status when the auto-guess annotation loads/changes ──
  // Layer statuses (boundaries included) come from `songLayerStatuses`, which
  // the layers-doc save path refreshes; only auto-guess needs mirroring here.
  useEffect(() => {
    if (!selectedAudio) return;
    setSongStatuses((prev) => {
      const existing = prev[selectedAudio.id];
      return {
        ...prev,
        [selectedAudio.id]: {
          ...existing,
          slug: selectedAudio.id,
          points_count: autoGuessAnnotation?.points?.length ?? existing?.points_count ?? 0,
          auto_guess_status: autoGuessAnnotation?.auto_guess_status ?? existing?.auto_guess_status,
        },
      };
    });
  }, [selectedAudio, autoGuessAnnotation]);

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
      // Clear the curves with the buffer they were computed from, never on
      // their own. They are pure client-side DSP over `audioBuffer`, and the
      // only thing that recomputes them is the effect keyed on it — so on a
      // same-song re-select (a finished algorithm run, a replaced shared
      // document) WaveSurfer keeps its decoded buffer, that effect never
      // refires, and a lone `setMirCurves(null)` here left Energy, Brightness,
      // Novelty, Onsets and Flux permanently unrendered with their boxes still
      // ticked, while 3-Band and Spectrogram — which read the buffer directly —
      // carried on as if nothing had happened.
      setMirCurves(null);
      setPlayerTime(0);
      setDuration(0);
    }
    setPreviewRegion(null);
    previewAnchorRef.current = null;
    setToolStates({});
    setRupturesResults({});
    setCustomResults({});
    setCustomAnnotationOverrides({});
    setPendingAnnotationSelection(null);
    // Song change — the previous song's edit history is meaningless for the
    // new song, so reset rather than push onto the undo stack.
    annotationDocsCtl.reset(null);
    cueLayersJustLoadedRef.current = null;
    setLayersDocLoaded(false);
    setFocusedCue(null);
    setFocusedLoop(null);
    setFocusedSpan(null);
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
    setAutoGuessAnnotation(null);
    // Song change — the previous song's grid history means nothing here.
    songInfoCtl.reset({ info: null, stampShift: 0 });
    setBpmDetection(null);
    setBpmDetectionStatus('idle');
    setBpmDetectionError(undefined);
    // Clear the client-side one-shot estimate too — otherwise its chip keeps
    // showing the previous song's BPM until the new audio buffer decodes.
    setClientBpm(null);
    // A grid edit made within the debounce window belongs to the song being
    // left, not to the one being opened — send it before switching rather
    // than dropping the timer on the floor.
    flushSongInfoSaveRef.current?.();
    setSelectedAlgoOverlays(new Set());
    // The merge is a reading of one song's lanes, and each song remembers its
    // own — the load effect keyed on the selected song swaps it in.

    // Demucs stem player: snap back to full mix for the new song; load the
    // per-song manifest if any. 404 (no stems cached) is the silent normal.
    setSelectedStemSource('mix');
    setRunStemSource('mix');
    setStemManifest(null);
    fetchStemManifest(entry.url).then((m) => {
      if (selectedAudioRef.current?.id !== entry.id) return;
      setStemManifest(m);
      // Pull any cached per-stem detector results into toolStates. Only the
      // stems that actually exist are probed (no blind 404 sweep), and absent
      // composites are silently dropped — same contract as the mix loaders.
      if (!m) return;
      // All six htdemucs_6s stems — guitar/piano are real stems under the 6s
      // model, so their per-stem runs (e.g. Chroma loops on guitar) must load
      // too. The `m.stems[stem]` guard below skips any a 4-stem song lacks.
      for (const stem of ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'] as const) {
        if (!m.stems[stem]) continue;
        for (const base of STEM_CAPABLE_TOOL_IDS) {
          const composite = `${base}__${stem}`;
          loadAlgoJson(entry.id, composite).then((loaded) => {
            if (!loaded || selectedAudioRef.current?.id !== entry.id) return;
            const { result, error } = loaded;
            setToolStates((prev) => ({
              ...prev,
              [composite]: error ? { status: 'error', result, error } : { status: 'done', result },
            }));
          });
        }
      }
    });

    // Load persisted per-type annotation times for the new song
    setAnnotationTimesSaved({ manual: 0, autoGuess: 0, cues: 0, spans: 0, loops: 0, lyrics: 0 });
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
            manual:     Number(data.perType.boundaries) || 0,
            autoGuess:  Number(data.perType.autoGuess)  || 0,
            cues:      Number(data.perType.cues)      || 0,
            spans:     Number(data.perType.spans)     || 0,
            loops:     Number(data.perType.loops)     || 0,
            lyrics:    Number(data.perType.lyrics)    || 0,
          });
        }
      })
      .catch(() => null);
    }

    // Songs saved before the offset became a within-bar phase can carry a
    // whole-bar offset, which numbers their intro backwards ("bar -4.4.964").
    // Fold it on the way in and persist the correction once, so the file and
    // the stamps below agree from here on. The documents load in parallel, so
    // they wait on this to learn how far their beat stamps renumber — the
    // fold moves no times, but every beat index in the song gains a fixed
    // whole-bar amount, and re-reading un-shifted stamps under the folded
    // grid would drag every Grid Lock annotation off by those bars.
    const gridFold = loadSongInfo(entry.id).then((info) => {
      // Guard against rapid song-switching: a slow request for the previous
      // song must not overwrite the current song's BPM / time-signature.
      if (selectedAudioRef.current?.id !== entry.id) return 0;
      const { info: folded, deltaBeats } = withFoldedGridOffset(info);
      setGridState({ info: folded, stampShift: 0 }, { skipHistory: true });
      lastPersistedSongInfoRef.current = { slug: entry.id, info: folded };
      if (deltaBeats !== 0 && folded) {
        const migrated = { ...folded, updated_at: new Date().toISOString() };
        setSongInfos((prev) => ({ ...prev, [entry.id]: migrated }));
        saveSongInfo(entry.id, migrated);
      }
      // Restore persisted Grid Lock preference for this song.
      setGridLock(folded?.annotatorGridMode === true);
      if (folded?.annotatorGridMode) setSnapToGrid(true);
      return deltaBeats;
    }).catch(() => 0);

    loadAutoGuessAnnotation(entry.id).then((ann) => { if (ann) setAutoGuessAnnotation(ann); });
    loadLayers(entry.id).then(async (doc) => {
      const deltaBeats = await gridFold;
      if (selectedAudioRef.current?.id !== entry.id) return;
      const shifted = doc && deltaBeats ? withShiftedBeatStamps(doc, deltaBeats) : doc;
      cueLayersJustLoadedRef.current = shifted;
      // Raw setter: loading the document is not an edit, and a reader must be
      // able to see a song they cannot change.
      setCueLayersDocRaw(shifted, { skipHistory: true });
      setLayersDocLoaded(true);
    });

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
    const startedAt = Date.now();
    let lastUploadedId: string | null = null;
    // Every slug that landed on disk this batch — the auto-stem queue takes
    // all of them, not just the one that ends up selected.
    const uploadedIds: string[] = [];
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
          if (entry.id) { lastUploadedId = entry.id; uploadedIds.push(entry.id); }
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
      // Stem the fresh songs in the background — one Demucs job at a time, no
      // dialogs, and the upload UI is already done by the time the first one
      // starts. Skipped when the Demucs tooling isn't installed (the job would
      // only fail) or when the user has turned the automation off in Settings.
      if (getCurrentSettings().autoStemOnUpload && gpuCapsRef.current.demucs && !isDemo) {
        const targets = uploadedIds
          .map((id) => refreshed.find((f) => f.id === id))
          .filter((f): f is AudioEntry => !!f)
          .map((f) => ({ id: f.id, name: f.name, url: f.url }));
        enqueueStemJobs(targets, { model: stemModelRef.current });
      }
      // No post-upload dialog: an upload happens in Dataprep and the fresh
      // song is already selected here, which is exactly where the BPM gets
      // set. Leaving for the Annotator Tool without a BPM is gated by
      // BpmWarningDialog, so nothing is lost by staying put silently.
      refreshStorageStats();
    } finally {
      // Everything above is already done — the song is on disk, selected, and
      // any stem jobs are queued — so this only delays tearing the bar down.
      const shownFor = Date.now() - startedAt;
      if (shownFor < MIN_UPLOAD_INDICATOR_MS) {
        await new Promise((r) => setTimeout(r, MIN_UPLOAD_INDICATOR_MS - shownFor));
      }
      setUploading(false);
      setUploadProgress(null);
    }
  }, [selectAudio, refreshStorageStats, enqueueStemJobs, isDemo]);

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
      // NOT mirCurves: those are computed in this tab from the decoded buffer,
      // not read from the caches that were just cleared, and nothing recomputes
      // them while the song stays selected — see selectAudio.
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
    opts?: { forceAlgos?: string[] },
  ): Promise<void> => {
    const sel = algoIds === undefined
      ? selectedAlgorithms
      : (algoIds instanceof Set ? algoIds : new Set(algoIds));
    const { builtins, custom } = splitAlgorithmSelection(sel);
    if (builtins.length === 0 && custom.length === 0) return;
    // Custom detectors now ride the SAME job as the built-ins — one POST, one
    // status stream, one report — instead of a parallel frontend track. Flag
    // them running so the Custom section's per-row spinners animate while the
    // unified job is in flight.
    if (custom.length) {
      setCustomRunning((prev) => { const next = new Set(prev); custom.forEach((n) => next.add(n)); return next; });
    }
    const res = await fetch(`/api/run-algorithms/${encodeURIComponent(audio.id)}`, {
      method: 'POST',
      headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ demucsModel, algorithms: builtins, customDetectors: custom, lyricsLanguage: lyricsLanguage || undefined, forceAlgos: opts?.forceAlgos ?? [] }),
    });
    const data = await res.json().catch(() => ({}));
    const jobId: string | undefined = data.jobId;
    if (jobId) {
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
    }
    // The job wrote each custom envelope to the shared cache; reload them so the
    // Custom section reflects fresh results, then clear the running flags.
    if (custom.length) {
      await Promise.allSettled(custom.map(async (name) => {
        try {
          const env = await getDetectorResult(name, audio.id);
          if (env && selectedAudioRef.current?.id === audio.id) {
            setCustomResults((prev) => ({ ...prev, [name]: env }));
            if (!env.fatal) revealDetectorsPendingRef.current.add(name);
          }
        } catch { /* leave the stale result; the Playground page surfaces detail */ }
      }));
      setCustomRunning((prev) => { const next = new Set(prev); custom.forEach((n) => next.delete(n)); return next; });
    }
  }, [selectedAlgorithms, demucsModel, lyricsLanguage, splitAlgorithmSelection]);

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

  // Which of these ids already have a result on disk for this song. The run
  // picker seeds only the *missing* detectors, so a cached row that is ticked
  // was ticked by hand — that is an explicit "run this again", not a leftover.
  // Those ids ride along as `forceAlgos` so the job recomputes and overwrites
  // the cached output instead of reporting it as skipped. Without this, a run
  // launched to change a detector's parameters (the Whisper language, say)
  // silently returned the old result. Mirrors seedMissingForStem's `isDone`,
  // including its ruptures / custom special cases.
  const cachedIdsIn = useCallback((sel: Set<string>): string[] => {
    const isCached = (id: string) => {
      if (id.startsWith('custom:')) return !!customResults[id.slice('custom:'.length)];
      const base = baseAlgoId(id);
      if (base.startsWith('ruptures-')) return !!rupturesResults[base.slice('ruptures-'.length)];
      return toolStates[id]?.status === 'done';
    };
    return [...sel].filter(isCached);
  }, [toolStates, rupturesResults, customResults]);

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
    // Stem-capable detectors target runStemSource; boundary/custom stay on the
    // mix. 'all' fans them out to every separated stem; a single stem targets
    // just that one; 'mix' is a no-op.
    const runStems = stemManifest
      ? (['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'] as const).filter((s) => stemManifest.stems[s])
      : [];
    const sel = runStemSource === 'all'
      ? applyAllStemsToSelection(selectedAlgorithms, runStems)
      : applyStemToSelection(selectedAlgorithms, runStemSource);
    const label = runStemSource === 'mix'
      ? `▶ ${selectedAudio.name}`
      : runStemSource === 'all'
        ? `▶ ${selectedAudio.name} · all stems`
        : `▶ ${selectedAudio.name} · ${runStemSource}`;
    const forceAlgos = cachedIdsIn(sel);
    await runAlgorithmsForOneSong(selectedAudio, label, sel, { forceAlgos });
    if (selectedAudioRef.current?.id === selectedAudio.id) {
      selectAudio(selectedAudio);
    }
  }, [selectedAudio, runJob, selectedAlgorithms, runStemSource, stemManifest, runAlgorithmsForOneSong, selectAudio, cachedIdsIn]);

  // Default the run-picker selection to the not-yet-cached ("missing") detectors
  // for the current song + the given stem, so the footer "Run" computes only the
  // gaps. Cached rows start unticked (re-running them is skipped anyway — to
  // force a recompute, delete their JSON, then tick). Mirrors each family's
  // availability gating so we never seed an algorithm that can't run. When stem
  // is a Demucs stem (not 'mix'), only the stem-capable families are seeded —
  // boundary detectors and custom scripts are mix-only — and "done" is tested
  // against the composite <id>__<stem> cache key.
  const seedMissingForStem = useCallback((stem: RunStemTarget) => {
    const missing = new Set<string>();
    const stemMode = stem !== 'mix';
    // For 'all', a stem-capable detector counts as done only when every
    // separated stem already has its cache — otherwise the run should fill the
    // gaps. Single-stem mode checks just that one stem's composite cache key.
    const allStems = stem === 'all' && stemManifest
      ? (['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'] as const).filter((s) => stemManifest.stems[s])
      : [];
    const isDone = (id: string) => {
      if (stem === 'all') {
        if (!STEM_CAPABLE_TOOL_IDS.has(id) || allStems.length === 0) return true;
        return allStems.every((s) => toolStates[`${id}__${s}`]?.status === 'done');
      }
      const key = stemMode && STEM_CAPABLE_TOOL_IDS.has(id) ? `${id}__${stem}` : id;
      return toolStates[key]?.status === 'done';
    };
    const addIfMissing = (id: string) => { if (!isDone(id)) missing.add(id); };
    // Only pre-select missing algos for families the run picker is actually
    // showing expanded (expandedAlgoTypes) — otherwise the seeded selection
    // (and the "Run N" count) includes categories the user never looked at,
    // e.g. opening the picker with just MSAF open would silently also tick
    // every missing Cue-extras / Lyrics algo behind their collapsed chips.
    const open = expandedAlgoTypes;
    if (!stemMode) {
      if (open.has('msaf')) ['msaf-sf', 'msaf-foote', 'msaf-cnmf', 'msaf-olda'].forEach(addIfMissing);
      if (open.has('allin1') && gpuCaps.allin1) ['allin1', ...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => `allin1-fold${n}`)].forEach(addIfMissing);
      if (open.has('ruptures')) RUPTURES_METHODS.forEach((m) => { if (!rupturesResults[m.suffix]) missing.add(`ruptures-${m.suffix}`); });
    }
    if (open.has('span') && settings.experimentalSpanFamily && expAvail.spanFamily) ['silero-vad', 'jdcnet-voicing', 'panns-cnn14', 'hpss-percussive'].forEach(addIfMissing);
    if (open.has('cue-extras') && settings.experimentalCueExtras && expAvail.cueExtras) ['basic-pitch', 'librosa-key', 'autochord-chords', 'librosa-onsets', 'drum-transients'].forEach(addIfMissing);
    if (open.has('lyrics') && settings.experimentalLyricsFamily && expAvail.lyricsFamily) ['whisper-base', 'ctc-forced-aligner'].forEach(addIfMissing);
    if (open.has('pattern') && settings.experimentalPatternFamily && expAvail.patternFamily) ['locomotif'].forEach(addIfMissing);
    // Custom detectors read their own declared stem, so a single-stem target
    // narrows them to that stem (as the picker lists them) rather than
    // retargeting; ones whose stem isn't separated yet can't run.
    if (open.has('custom')) {
      const target = stem !== 'mix' && stem !== 'all' ? stem : null;
      for (const d of customDetectors) {
        if (d.status !== 'ok' || !(d.is_algorithm || d.is_annotation)) continue;
        if (target && d.stem !== target) continue;
        if (d.stem && d.stem !== 'mix' && !stemManifest?.stems?.[d.stem]) continue;
        const env = customResults[d.name];
        if (!env || env.fatal) missing.add(`custom:${d.name}`);
      }
    }
    setSelectedAlgorithms(missing);
  }, [toolStates, gpuCaps, rupturesResults, settings, expAvail, stemManifest, expandedAlgoTypes, customDetectors, customResults]);

  // Availability gate shared by the run-picker seeders: can this detector be
  // computed at all right now? Mirrors the per-family conditions
  // seedMissingForStem applies. Ids outside the gated families (ruptures,
  // custom scripts, MSAF) are always runnable.
  const canRunAlgoId = useCallback((id: string): boolean => {
    if (id === 'allin1' || ALLIN1_FOLD_IDS.has(id)) return !!gpuCaps.allin1;
    if (SPAN_TOOL_IDS.has(id) || PANNS_TOOL_IDS.has(id) || PERCUSSIVE_TOOL_IDS.has(id)) {
      return !!(settings.experimentalSpanFamily && expAvail.spanFamily);
    }
    if (PITCH_TOOL_IDS.has(id) || CUE_EXTRAS_TOOL_IDS.has(id)) {
      return !!(settings.experimentalCueExtras && expAvail.cueExtras);
    }
    if (LYRICS_TOOL_IDS.has(id)) return !!(settings.experimentalLyricsFamily && expAvail.lyricsFamily);
    if (PATTERN_TOOL_IDS.has(id)) return !!(settings.experimentalPatternFamily && expAvail.patternFamily);
    return true;
  }, [gpuCaps, settings, expAvail]);

  // Seed the run selection from what the visibility sidebar has ticked, mapped
  // back to base detector ids ("silero-vad__vocals" → "silero-vad"; the stem is
  // a separate run-target choice). The picker and the sidebar share the same
  // chips and the same checkbox rows, so opening the picker on a *different*
  // set of ticks reads as the app changing the selection out from under you —
  // which is exactly what the old "everything still missing" seed did, arriving
  // with eleven detectors ticked that nobody chose. Detectors whose family
  // isn't installed or enabled are dropped: they can't run, so they must not
  // arrive pre-ticked.
  const seedFromVisibleOverlays = useCallback(() => {
    const next = new Set<string>();
    for (const rowId of selectedAlgoOverlays) {
      const id = baseAlgoId(rowId);
      if (canRunAlgoId(id)) next.add(id);
    }
    setSelectedAlgorithms(next);
  }, [selectedAlgoOverlays, canRunAlgoId]);

  // Opening the picker mirrors the sidebar: the same ticks, and the same stem
  // if that stem can actually be a run target. Running the vocals overlays you
  // were just looking at against the full mix writes results the stem filter
  // then hides, so the target follows the filter too. Once the user edits the
  // selection inside the picker it is theirs — re-opening shows it back
  // untouched rather than re-seeding, because Dataset Prep's batch panel
  // shares this same selection. "Select missing" is the explicit way to the
  // everything-not-yet-cached default.
  const openRunPicker = useCallback(() => {
    if (!runSelectionTouchedRef.current) {
      seedFromVisibleOverlays();
      if (inspectStemFilter !== 'all') {
        const runnable = inspectStemFilter === 'mix' || !!stemManifest?.stems[inspectStemFilter as DemucsStem];
        if (runnable) setRunStemSource(inspectStemFilter);
      }
    }
    setRunPickerOpen(true);
  }, [seedFromVisibleOverlays, inspectStemFilter, stemManifest]);

  // Explicit "Select missing" — re-seeds the selection from what has no cached
  // result for the current stem target. Counts as a user choice, so it sticks.
  const seedMissingFromPicker = useCallback(() => {
    seedMissingForStem(runStemSource);
    runSelectionTouchedRef.current = true;
  }, [seedMissingForStem, runStemSource]);

  // Switch the run-picker stem target. The selection is stem-agnostic (the stem
  // is applied at launch by applyStemToSelection), so changing the target never
  // touches the ticks — it used to re-seed them from "missing for the new stem",
  // which silently rewrote the selection mid-picker.
  const handleRunStemChange = useCallback((stem: RunStemTarget) => {
    setRunStemSource(stem);
  }, []);

  // Per-section "Run missing" — runs the supplied algorithm IDs directly
  // (bypassing the persistent selection) so the user can fill in gaps without
  // touching their ticks. Built-in and `custom:X` IDs alike flow through the
  // single /api/run-algorithms job (the orchestrator dispatches custom to the
  // :8005 sidecar). Caller is expected to have already filtered out cached
  // entries.
  const handleRunMissingForSection = useCallback(async (ids: string[]) => {
    if (!selectedAudio) return;
    if (runJob?.status === 'running') return;
    if (ids.length === 0) return;
    await runAlgorithmsForOneSong(selectedAudio, `▶ ${selectedAudio.name} · missing`, ids);
    if (selectedAudioRef.current?.id === selectedAudio.id) {
      selectAudio(selectedAudio);
    }
  }, [selectedAudio, runJob, runAlgorithmsForOneSong, selectAudio]);

  const handleForceRunForSection = useCallback(async (ids: string[]) => {
    if (!selectedAudio) return;
    if (runJob?.status === 'running') return;
    if (ids.length === 0) return;
    await runAlgorithmsForOneSong(selectedAudio, `▶ ${selectedAudio.name} · re-run`, ids, { forceAlgos: ids });
    if (selectedAudioRef.current?.id === selectedAudio.id) {
      selectAudio(selectedAudio);
    }
  }, [selectedAudio, runJob, runAlgorithmsForOneSong, selectAudio]);

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
        // `boundaries` is the clock for the whole layers document — see the
        // /api/annotation-times plugin. `manual` is the in-app timer key.
        boundaries: Math.round(perKey.manual),
        autoGuess:  Math.round(perKey.autoGuess),
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
  // Riff patterns own no timer slot at all (see the TimerKey union) — the riff
  // window composes nodes rather than authoring one of the timed annotation
  // types — so switching into that tab has to END the running session rather
  // than keep billing its seconds to the type the user just left.
  const activeTypeHasTimer = activeAnnotationType !== 'riff-patterns';
  const activeTimerKey: TimerKey | null = activeAnnotationType === 'boundaries'
    ? (activeBoundarySource ?? null)
    : activeAnnotationType === 'riff-patterns'
      ? null
      : activeAnnotationType;

  useEffect(() => {
    if (
      annotationSessionStartRef.current !== null &&
      annotationSessionTypeRef.current !== null &&
      (!activeTypeHasTimer
        || (activeTimerKey !== null && annotationSessionTypeRef.current !== activeTimerKey))
    ) {
      pauseAnnotationTimer(currentAnnotationSlug ?? undefined);
    }
  }, [activeTypeHasTimer, activeTimerKey, currentAnnotationSlug, pauseAnnotationTimer]);

  // Computed totals (saved + live session) per timer key
  const liveSessionSecs = annotationSessionStartRef.current !== null
    ? (Date.now() - annotationSessionStartRef.current) / 1000
    : 0;
  const annotationTimesTotal: Record<TimerKey, number> = {
    manual:      annotationTimesSaved.manual      + (annotationSessionTypeRef.current === 'manual'      ? liveSessionSecs : 0),
    autoGuess: annotationTimesSaved.autoGuess + (annotationSessionTypeRef.current === 'autoGuess' ? liveSessionSecs : 0),
    cues:      annotationTimesSaved.cues      + (annotationSessionTypeRef.current === 'cues'      ? liveSessionSecs : 0),
    spans:     annotationTimesSaved.spans     + (annotationSessionTypeRef.current === 'spans'     ? liveSessionSecs : 0),
    loops:     annotationTimesSaved.loops     + (annotationSessionTypeRef.current === 'loops'     ? liveSessionSecs : 0),
    lyrics:    annotationTimesSaved.lyrics    + (annotationSessionTypeRef.current === 'lyrics'    ? liveSessionSecs : 0),
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
    if (!audioBuffer) {
      setMirCurves(null);
      // A song is selected but its buffer hasn't decoded yet: the curves are
      // pending, not absent, and the signal lanes read this to say which. Flat
      // `false` here made every song switch flash "No Energy analysis" for the
      // second before the decode landed.
      setMirComputing(!!selectedAudioRef.current);
      return;
    }
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
        rms:      Array.from(mir.rms),
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
        hopSize: mir.hopSize,
        fftSize: mir.fftSize,
        sampleRate: mir.sampleRate,
      });
      setMirComputing(false);
    }).catch((err) => {
      if (cancelled) return;
      console.error('[mir] computeMIRFeatures failed', err);
      setMirComputing(false);
    });
    return () => { cancelled = true; };
  }, [audioBuffer]);

  // ── Auto-stop at section end ─────────────────────────────────────────────
  // The preview region's own end is NOT handled here any more. `playerTime` is
  // a re-render behind the media clock, and on a 157 ms preview that lag was
  // enough to play past the region and leak the next onset — see the
  // `audioprocess` handler in PlayerPanel, which now wraps/pauses the preview
  // against the media clock and calls back through `onPreviewEnd`.
  //
  // Section stop is left on this path deliberately: sections are seconds long,
  // so a render of overshoot is inaudible, and the stop time is owned here.
  useEffect(() => {
    if (!playerIsPlaying) return;
    if (previewRegion) return;
    if (sectionStopAtRef.current !== null && playerTime >= sectionStopAtRef.current) {
      pauseRef.current?.();
      sectionStopAtRef.current = null;
    }
  }, [playerTime, playerIsPlaying, previewRegion]);

  // Non-looping preview finished (PlayerPanel already paused at the exact
  // frame). Restore the cursor to wherever the user was before it opened.
  const handlePreviewEnd = useCallback(() => {
    const anchor = previewAnchorRef.current;
    if (anchor !== null) setTimeout(() => seekRef.current?.(anchor), 50);
  }, []);

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
  // Sound the highlighted band. A LOOPING preview goes to the sample-accurate
  // Web Audio engine (useLoopPlayback) rather than to the media element, which
  // has no seamless loop to offer: wrapping it means noticing `currentTime >=
  // end` on a 16 ms timer and then seeking, and by the time the seek lands the
  // output device has already been handed the milliseconds that follow the
  // seam — so a bar-length highlight plays a sliver of the *next* bar, then
  // clicks, then restarts. The buffer source loops inside the audio thread
  // instead: the seam is sample-accurate, pulled to the nearest zero crossing,
  // and never drifts however long it repeats. Straight (non-looping) previews
  // stay on the player — they have no seam, and PlayerPanel already stops them
  // against the media clock.
  //
  // The two engines are mutually exclusive: whichever one starts pauses the
  // other (see `playLoopExclusive` and the `playerIsPlaying` effect below).
  // SPEED applies to the media element live, through PlayerPanel's own effect;
  // a loop sounding on the Web Audio engine has to follow it the same way,
  // rather than staying at whatever the rate was when it started.
  useEffect(() => { setLoopRate(playbackRate); }, [playbackRate, setLoopRate]);

  const previewIsLooping = loopPlayback.playingId === PREVIEW_LOOP_ID;
  const previewIsLoopingRef = useRef(false);
  previewIsLoopingRef.current = previewIsLooping;
  const soundPreviewRegion = useCallback((region: PreviewRegion) => {
    if (region.loop && audioBuffer) {
      if (playerIsPlayingRef.current) pauseRef.current?.();
      playLoop(PREVIEW_LOOP_ID, region.start, region.end, { rate: playbackRate });
      return;
    }
    stopLoop();
    seekRef.current?.(region.start);
    setTimeout(() => playRef.current?.(), 50);
  }, [audioBuffer, playLoop, stopLoop, playbackRate]);

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
    soundPreviewRegion(next);
  }, [previewRegion, soundPreviewRegion]);

  const handlePreviewRegionChange = useCallback((next: PreviewRegion) => {
    setPreviewRegion(next);
    // In annotation modes where the "+ Add" pill mirrors the preview span (manual/loops),
    // keep them locked together so resizing the preview also updates the pending range.
    setPendingAnnotationSelection((prev) => {
      if (!prev || prev.t2 === null) return prev;
      return { t1: next.start, t2: next.end };
    });
    // A sounding loop is re-cut where it plays — dragging a handle moves the
    // seam under the audio instead of re-triggering the phrase from its head
    // on every pointer frame.
    if (previewIsLoopingRef.current) {
      setLoopBounds(next.start, next.end);
      return;
    }
    // If playback wandered outside the new bounds (e.g. region moved), jump to start.
    if (playerIsPlayingRef.current) {
      const t = playerTimeRef.current;
      if (t < next.start || t > next.end) seekRef.current?.(next.start);
    }
  }, [setLoopBounds]);

  const handlePreviewPlay = useCallback(() => {
    if (!previewRegion) return;
    soundPreviewRegion(previewRegion);
  }, [previewRegion, soundPreviewRegion]);

  const handlePreviewPause = useCallback(() => {
    pauseRef.current?.();
    stopLoop();
  }, [stopLoop]);

  const handlePreviewDismiss = useCallback(() => {
    pauseRef.current?.();
    stopLoop();
    const anchor = previewAnchorRef.current;
    previewAnchorRef.current = null;
    setPreviewRegion(null);
    // Manual mode pairs the preview with the "+ Add" pill — dismiss them together.
    setPendingAnnotationSelection(null);
    if (anchor !== null) setTimeout(() => seekRef.current?.(anchor), 30);
  }, [stopLoop]);

  const handlePreviewLoopToggle = useCallback(() => {
    if (!previewRegion) return;
    const next: PreviewRegion = { ...previewRegion, loop: !previewRegion.loop };
    setPreviewRegion(next);
    // The loop switch changes which engine owns the sound, so a preview that
    // is currently audible has to be handed across rather than left playing on
    // the engine that no longer applies (or silent on neither).
    if (playerIsPlayingRef.current || previewIsLoopingRef.current) {
      soundPreviewRegion(next);
    }
  }, [previewRegion, soundPreviewRegion]);

  // Keep keyboard handler stable across renders by reading latest handlers via refs.
  const openPreviewRegionRef = useRef(openPreviewRegion);
  const handlePreviewDismissRef = useRef(handlePreviewDismiss);
  const previewRegionRef = useRef(previewRegion);
  useEffect(() => { openPreviewRegionRef.current = openPreviewRegion; }, [openPreviewRegion]);
  useEffect(() => { handlePreviewDismissRef.current = handlePreviewDismiss; }, [handlePreviewDismiss]);
  useEffect(() => { previewRegionRef.current = previewRegion; }, [previewRegion]);

  // ── Viz scroll sync ───────────────────────────────────────────────────────
  // The player pushes its scroll offset here; the rows are moved to match in
  // the layout effect below rather than right now. Writing el.scrollLeft
  // immediately moves the rows' CONTENT in this frame while every playhead —
  // the player's and each row's — is a React-rendered element that only moves
  // on the next commit. At fit zoom that gap is invisible; at x128 the rows
  // had scrolled tens of pixels further than the cursor drawn on them, so the
  // player's playhead and the rows' playheads sat visibly apart while playing.
  // Deferring the write to a layout effect keyed on the same state update puts
  // the scroll and every playhead in one commit, one paint.
  // Mirror the player's scroll onto the viz rows SYNCHRONOUSLY, inside the
  // scroll callback itself. This used to stash the target in a ref, bump a
  // `playerScrollLeft` state and apply it from a layout effect — one full
  // inspector render later. WaveSurfer auto-scrolls once per frame while the
  // track plays, so the rows spent that render showing the previous scroll:
  // measured at ×9 zoom, they trailed the waveform on 13 of 69 frames by up
  // to 25 px. On screen that is the playhead appearing *twice* — once in the
  // waveform at the true position, once in each viz row at the stale one —
  // and the gap grows with zoom, so at ultra zoom they are far apart.
  // Nothing read `playerScrollLeft` except that effect's dependency array,
  // so the state is gone rather than merely bypassed.
  const applyVizScroll = useCallback((target: number) => {
    const el = vizScrollContainerRef.current;
    if (!el) return;
    isProgrammaticScrollRef.current = true;
    el.scrollLeft = target;
    // A zoom widens the player immediately but the viz rows only on the next
    // render, so a scroll target past the rows' current max is silently
    // clamped — leaving them parked left of the waveform for as long as the
    // user stays zoomed in. Remember the target; the layout effect below
    // re-applies it once the rows are wide enough.
    desiredVizScrollRef.current = Math.abs(el.scrollLeft - target) > 1 ? target : null;
    isProgrammaticScrollRef.current = false;
  }, []);

  // ── The view, in the URL ───────────────────────────────────────────────
  // What is on screen is written to the query string (see utils/viewUrl) so a
  // refresh reopens it and a copied link shows it to somebody else. Written
  // with replaceState rather than through the router: the time window moves
  // on every scroll frame, and a router navigation would re-render this whole
  // page for each one. Nothing reads the query back after `urlView`, so the
  // router's copy of it going stale costs nothing — the tabs navigate to a
  // bare path, and the sync below puts the view straight back on it.
  const viewScrollLeftRef = useRef(0);
  const viewContainerPxRef = useRef(0);
  const viewZoomRef = useRef(1);
  const viewSourceRef = useRef<Omit<ViewUrlState, 'window'> & { duration: number }>({
    song: null, type: null, kind: null, view: null, algos: [], dets: null, layers: null,
    signals: null, fams: null, stem: null, filter: null, lock: null, speed: null, unit: null,
    duration: 0,
  });
  /** Held until the linked window has been applied, so the fit-to-song view
   *  the player opens on is not written over the `t=` it is about to honour. */
  const urlWindowPendingRef = useRef(urlView.window != null);
  const urlWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleUrlWrite = useCallback(() => {
    if (urlWriteTimerRef.current) clearTimeout(urlWriteTimerRef.current);
    urlWriteTimerRef.current = setTimeout(() => {
      urlWriteTimerRef.current = null;
      const { duration: dur, ...src } = viewSourceRef.current;
      // Still loading: an empty song would strip the `song=` being opened.
      if (!src.song) return;
      const cw = viewContainerPxRef.current;
      const zoom = viewZoomRef.current;
      const px = cw * zoom;
      const window_ =
        urlWindowPendingRef.current ? urlView.window :
        zoom > 1.01 && px > 0 && dur > 0
          ? {
              start: (viewScrollLeftRef.current / px) * dur,
              end: Math.min(dur, ((viewScrollLeftRef.current + cw) / px) * dur),
            }
          : null;
      const { pathname, search, hash } = window.location;
      const next = writeViewUrl(search, { ...src, window: window_ });
      if (next !== search) window.history.replaceState(window.history.state, '', pathname + next + hash);
    }, 200);
  }, [urlView.window]);
  useEffect(() => () => {
    if (urlWriteTimerRef.current) clearTimeout(urlWriteTimerRef.current);
  }, []);

  // The linked lanes and window belong to the linked song. Applied once, to
  // the first song opened, and only if it is that one — a link to a song this
  // dataset does not have opens the first song as it is, not with somebody
  // else's lanes switched on. Runs after selectAudio's own reset of the
  // overlays, so it adds to a clean slate rather than being cleared by it.
  const urlSongRestorePendingRef = useRef(true);
  useEffect(() => {
    if (!selectedAudio || !urlSongRestorePendingRef.current) return;
    urlSongRestorePendingRef.current = false;
    if (urlView.song && urlView.song !== selectedAudio.id) {
      urlWindowPendingRef.current = false;
      return;
    }
    if (urlView.algos.length) {
      setSelectedAlgoOverlays((prev) => new Set([...prev, ...urlView.algos]));
    }
  }, [selectedAudio?.id, urlView]);

  // The window waits for the player: it needs the song's duration and its own
  // layout, which arrive a frame or so apart, so keep offering it until the
  // player takes it.
  useEffect(() => {
    const win = urlView.window;
    if (!win || !urlWindowPendingRef.current || duration <= 0) return;
    let raf = 0;
    let tries = 0;
    const attempt = () => {
      if (zoomToRangeRef.current?.(win.start, win.end, { pad: 0 })) {
        urlWindowPendingRef.current = false;
        return;
      }
      if (++tries < 120) raf = requestAnimationFrame(attempt);
      else urlWindowPendingRef.current = false;
    };
    attempt();
    return () => cancelAnimationFrame(raf);
  }, [duration, urlView.window]);

  const handleScrollChange = useCallback((scrollLeft: number) => {
    applyVizScroll(scrollLeft);
    viewScrollLeftRef.current = scrollLeft;
    scheduleUrlWrite();
  }, [applyVizScroll, scheduleUrlWrite]);

  const handleVizScroll = useCallback(() => {
    if (isProgrammaticScrollRef.current) return;
    const el = vizScrollContainerRef.current;
    if (!el) return;
    // The rows' own scroll event for a set we already know was clamped. Echoing
    // it back would drag the player off the point it just zoomed to, so leave
    // the pending re-apply standing — a real user scroll fails this test and
    // clears it.
    const want = desiredVizScrollRef.current;
    if (want != null && want > el.scrollLeft
        && el.scrollLeft >= el.scrollWidth - el.clientWidth - 1) return;
    desiredVizScrollRef.current = null;
    wsScrollRef.current?.(el.scrollLeft);
  }, []);

  /** Pixel width of the full timeline as the viz draws it (see
   *  handleViewChange). 0 until the player reports its first layout. */
  const vizContentPxRef = useRef(0);

  // Re-apply a clamped scroll target the moment the viz rows grow to the new
  // zoom width (vizSignalWidth is what sizes them).
  useLayoutEffect(() => {
    const el = vizScrollContainerRef.current;
    const want = desiredVizScrollRef.current;
    if (!el || want == null) return;
    isProgrammaticScrollRef.current = true;
    el.scrollLeft = want;
    isProgrammaticScrollRef.current = false;
    if (Math.abs(el.scrollLeft - want) <= 1) desiredVizScrollRef.current = null;
  }, [vizSignalWidth]);

  // vizSignalWidth: the player's waveform signal area at the current zoom
  // (containerWidth = WaveSurfer's flex-1 width, ×zoomFactor). SharedVizPanel
  // adds its own resizable label gutter on top, so pass the bare signal width
  // here — baking in a fixed 72 px gutter made the viz rows' content column a
  // few px off from the player's waveform, drifting the cursor/highlight.
  const handleViewChange = useCallback((zoomFactor: number, containerWidth: number, atMaxZoom: boolean) => {
    // How wide the whole timeline is drawn, at any zoom — vizSignalWidth is
    // zeroed at 1x (the rows size themselves from flex there), but the snap
    // still has to know how many pixels a beat is getting. In a ref: it is
    // read inside drag handlers, never rendered.
    vizContentPxRef.current = containerWidth * zoomFactor;
    setVizSignalWidth(zoomFactor > 1 ? containerWidth * zoomFactor : 0);
    setVizZoomFactor(zoomFactor);
    setVizAtMaxZoom(atMaxZoom);
    viewContainerPxRef.current = containerWidth;
    viewZoomRef.current = zoomFactor;
    scheduleUrlWrite();
  }, [scheduleUrlWrite]);

  // Snap a raw time onto the song's beat grid when Snap-to-grid is on. This is
  // the single snap point: the playhead cursor is snapped here (on click/seek),
  // and everything downstream — the "+ Add @ <time>" boundary/cue drops, the
  // time readout — just reads the already-snapped cursor. Also reused directly
  // by the boundary-drag handler. Returns the time unchanged when Snap is off
  // or the song has no usable BPM.
  const snapToGridIfEnabled = useCallback((
    t: number,
    /** Set by the gestures that DRAG an annotation across the canvas. Widens
     *  the snap to the finest unit still worth aiming at on screen — see
     *  `coarsenSnapDivision`. Placement by time (the + Add drops, a typed
     *  value, the playhead) keeps the exact unit asked for. */
    pixelAware = false,
  ): number => {
    const bpmVal = (songInfo?.bpm ?? 0) > 20 ? songInfo!.bpm! : 0;
    const effectivelyOn = snapToGrid || gridLock;
    if (!effectivelyOn || bpmVal <= 0) return t;
    const offset = songInfo?.gridOffset ?? 0;
    const beatsPerBarVal = beatsPerBarFromTimeSignature(songInfo?.timeSignature);
    const overridesForSnap = effectiveGridMode(songInfo) === 'manual' ? songInfo?.beatOverrides : undefined;
    // One unit for the whole song: whatever the Grid selector is showing. The
    // annotation types used to carry a granularity each, so what a drag landed
    // on depended on which tab was open rather than on the grid in front of
    // you. Lyrics keep their opt-out, and reach the grid by a different door
    // (`snapTimeByLayerMode`) — a sung word is timed to the voice.
    const asked = showBeatGrid && beatGridUnit ? beatGridUnitToSnapDivision(beatGridUnit) : 'beat';
    const division = pixelAware
      ? coarsenSnapDivision(asked, bpmVal, beatsPerBarVal, duration > 0 ? vizContentPxRef.current / duration : 0)
      : asked;
    return snapTimeToGrid(t, bpmVal, offset, beatsPerBarVal, division, overridesForSnap, undefined, resolveGridSegments(songInfo));
  }, [songInfo, snapToGrid, gridLock, showBeatGrid, beatGridUnit, duration]);

  // Snap driven purely by a layer's own SnapMode, ignoring the global Snap /
  // Grid Lock switches. Lyrics use this: their timings describe a sung
  // performance rather than the song's grid, so a global "align everything"
  // must not touch them — but a layer the annotator explicitly set to Magnetic
  // or 1/16 should behave that way immediately, without also flipping a
  // page-wide toggle that would drag every other layer along.
  const snapTimeByLayerMode = useCallback((t: number, mode: import('../types/annotationLayer').SnapMode): number => {
    const bpmVal = (songInfo?.bpm ?? 0) > 20 ? songInfo!.bpm! : 0;
    if (mode === 'off' || bpmVal <= 0) return t;
    const offset = songInfo?.gridOffset ?? 0;
    const beatsPerBarVal = beatsPerBarFromTimeSignature(songInfo?.timeSignature);
    const overridesForSnap = effectiveGridMode(songInfo) === 'manual' ? songInfo?.beatOverrides : undefined;
    const tolerance = mode === 'magnetic' ? magneticToleranceSec(bpmVal) : undefined;
    return snapTimeToGrid(t, bpmVal, offset, beatsPerBarVal, snapModeToDivision(mode), overridesForSnap, tolerance, resolveGridSegments(songInfo));
  }, [songInfo]);

  /** The SnapMode a lyrics layer is set to. `layerId` null means "whichever
   *  lyrics layer the editor currently has open" — the one an add-at-playhead
   *  would land in. Layers written before the picker existed carry no `snap`
   *  on disk, which reads as 'off', the same default a new one gets. */
  const lyricsSnapMode = useCallback((layerId: string | null): import('../types/annotationLayer').SnapMode => {
    const layers = cueLayersDocRef.current?.layers ?? [];
    const layer = layerId
      ? layers.find((l) => l.id === layerId)
      : (layers.find((l) => l.id === selectedLyricsLayerId) ?? layers.find((l) => l.type === 'lyrics'));
    return layer?.type === 'lyrics' ? (layer.snap ?? 'off') : 'off';
  }, [selectedLyricsLayerId]);

  // ── Count annotations that would be moved by a bulk-snap ─────────────────────
  const countSnappable = useCallback((): { boundaries: number; cues: number; spans: number; loops: number; riffPatterns: number } => {
    const bpmVal = (songInfo?.bpm ?? 0) > 20 ? songInfo!.bpm! : 0;
    if (bpmVal <= 0) return { boundaries: 0, cues: 0, spans: 0, loops: 0, riffPatterns: 0 };
    const layers = cueLayersDoc?.layers ?? [];
    const count = (type: AnnotationLayer['type']) =>
      layers.filter((l) => l.type === type).reduce((s, l) => s + l.items.length, 0);
    return {
      boundaries: count('boundaries'),
      cues:     count('cues'),
      spans:    count('spans'),
      loops:    count('loops'),
      riffPatterns: count('riff-patterns'),
    };
  }, [songInfo, cueLayersDoc]);

  // ── Bulk-snap every layer to the visible grid unit (called on Grid Lock ON) ──
  //
  // One unit for the whole song, the one the toolbar is showing. Layers used to
  // carry a granularity each — boundaries to the bar, cues to the beat — which
  // meant Grid Lock re-quantised five layers five different ways, none of them
  // the grid on screen, and a set of marks placed against a 1/3-beat grid came
  // back rounded to bars. Lyrics are still skipped below: a sung word is timed
  // to the voice, not the grid.
  const bulkSnapAllLayers = useCallback(() => {
    const bpmVal = (songInfo?.bpm ?? 0) > 20 ? songInfo!.bpm! : 0;
    if (bpmVal <= 0) return;
    const offset = songInfo?.gridOffset ?? 0;
    const beatsPerBarVal = beatsPerBarFromTimeSignature(songInfo?.timeSignature);
    const overrides = effectiveGridMode(songInfo) === 'manual' ? songInfo?.beatOverrides : undefined;
    const division = showBeatGrid && beatGridUnit ? beatGridUnitToSnapDivision(beatGridUnit) : 'beat';

    function snapT(t: number): number {
      return snapTimeToGrid(t, bpmVal, offset, beatsPerBarVal, division, overrides, undefined, resolveGridSegments(songInfo));
    }

    setCueLayersDoc((doc) => {
      if (!doc) return doc;
      const snapped: AnnotationLayer[] = doc.layers.map((layer) => {
        if (layer.type === 'lyrics') return layer;
        if (layer.type === 'boundaries' || layer.type === 'cues') {
          return {
            ...layer,
            items: (layer.items as { time: number; candidates?: number[] }[]).map((item) => ({
              ...item,
              time: snapT(item.time),
              candidates: item.candidates?.map((c) => snapT(c)),
            })),
          } as AnnotationLayer;
        }
        if (layer.type === 'spans') {
          return {
            ...layer,
            items: (layer.items as import('../types/annotationLayer').SpanItem[]).map((item) => ({
              ...item,
              start: snapT(item.start),
              end:   snapT(item.end),
              candidates: item.candidates?.map(([s, e]) => [snapT(s), snapT(e)] as [number, number]),
            })),
          } as AnnotationLayer;
        }
        if (layer.type === 'loops') {
          return {
            ...layer,
            items: (layer.items as import('../types/annotationLayer').LoopItem[]).map((item) => ({
              ...item,
              start: snapT(item.start),
              end:   snapT(item.end),
              candidates: item.candidates?.map(([s, e]) => [snapT(s), snapT(e)] as [number, number]),
            })),
          } as AnnotationLayer;
        }
        if (layer.type === 'riff-patterns') {
          // A riff instance's length is musical content — its sequence of nodes
          // times its repeat count — not two independent edges. Snapping `end`
          // on its own would stretch or squash the pattern, so move the whole
          // instance: snap the start and carry the duration, exactly what
          // dragging one on the canvas does (see handleRiffPatternMove).
          return {
            ...layer,
            items: (layer.items as import('../types/annotationLayer').RiffPatternItem[]).map((item) => {
              const start = snapT(item.start);
              return { ...item, start, end: start + (item.end - item.start) };
            }),
          } as AnnotationLayer;
        }
        return layer;
      });
      return { ...doc, layers: snapped };
    });
  }, [songInfo, setCueLayersDoc, showBeatGrid, beatGridUnit]);

  // ── Song info change handler (debounced save) ────────────────────────────
  /** Renumber every stamped beat in the document — the companion half of a
   *  grid-offset fold. Not an edit (no time moves), so it stays out of undo. */
  const shiftBeatStamps = useCallback((deltaBeats: number) => {
    if (!deltaBeats) return;
    setCueLayersDoc(
      (prev) => (prev ? withShiftedBeatStamps(prev, deltaBeats) : null),
      { skipHistory: true },
    );
  }, [setCueLayersDoc]);

  /** Write a SongInfo back to the server (debounced) and mirror it into the
   *  sidebar cache. Split out of the edit handler because an undo has to take
   *  the same path — restoring the grid on screen but leaving the edited
   *  version on disk would make ⌘Z a lie that outlives the session. */
  /** The actual POST, plus the save-state the UI reads. Separate from the
   *  debounce so a flush or a retry can reuse it. */
  const writeSongInfo = useCallback((slug: string, next: SongInfo) => {
    if (savedFlashTimer.current) { clearTimeout(savedFlashTimer.current); savedFlashTimer.current = null; }
    setSongInfoSaveState('saving');
    saveSongInfo(slug, next).then((ok) => {
      if (!ok) {
        // Left on 'error' deliberately: it clears when a later save succeeds,
        // not on a timer. An edit the server never took is worth staring at.
        failedSongInfoSaveRef.current = { slug, info: next };
        setSongInfoSaveState('error');
        return;
      }
      failedSongInfoSaveRef.current = null;
      setSongInfoSaveState('saved');
      savedFlashTimer.current = setTimeout(() => setSongInfoSaveState('idle'), 2000);
      if (!songNameDirty.current) return;
      songNameDirty.current = false;
      // The visible name (manifest entry .name) is derived server-side from
      // title/artist, so refetch and patch the song list + active song.
      fetchManifest().then((refreshed) => {
        setAudioFiles(refreshed);
        const updated = refreshed.find((f) => f.id === slug);
        if (updated) setSelectedAudio((cur) => (cur?.id === slug ? updated : cur));
      });
    });
  }, []);

  const persistSongInfo = useCallback((next: SongInfo) => {
    if (!selectedAudio) return;
    const slug = selectedAudio.id;
    const prevSaved = lastPersistedSongInfoRef.current;
    if (prevSaved.slug === slug
      && (prevSaved.info?.title !== next.title || prevSaved.info?.artist !== next.artist)) {
      songNameDirty.current = true;
    }
    lastPersistedSongInfoRef.current = { slug, info: next };
    // Mirror to the sidebar cache so the readiness indicator updates live.
    setSongInfos((prev) => ({ ...prev, [slug]: next }));
    if (songInfoSaveTimer.current) clearTimeout(songInfoSaveTimer.current);
    songInfoSaveTimer.current = setTimeout(() => {
      songInfoSaveTimer.current = null;
      writeSongInfo(slug, next);
    }, 500);
  }, [selectedAudio, writeSongInfo]);

  /** Send a pending debounced save right now — used when the ground is about
   *  to move under it (a song switch), where the timer would otherwise be
   *  cleared and the last edit lost without a trace. */
  const flushSongInfoSave = useCallback(() => {
    if (!songInfoSaveTimer.current) return;
    clearTimeout(songInfoSaveTimer.current);
    songInfoSaveTimer.current = null;
    const pending = lastPersistedSongInfoRef.current;
    if (pending.slug && pending.info) writeSongInfo(pending.slug, pending.info);
  }, [writeSongInfo]);

  useEffect(() => { flushSongInfoSaveRef.current = flushSongInfoSave; }, [flushSongInfoSave]);

  /** Retry the last save the server refused. The payload is whatever the
   *  screen is showing, so a retry after more edits saves the newest one. */
  const retrySongInfoSave = useCallback(() => {
    const failed = failedSongInfoSaveRef.current;
    const latest = lastPersistedSongInfoRef.current;
    // Prefer the newest edit of the same song — a retry after three more
    // nudges should save the grid on screen, not the one that failed. Once
    // the curator has moved on to another song, only the failed payload is
    // still the thing that never landed.
    const pending = failed && failed.slug !== latest.slug ? failed : latest;
    if (!pending?.slug || !pending.info) { setSongInfoSaveState('idle'); return; }
    if (songInfoSaveTimer.current) { clearTimeout(songInfoSaveTimer.current); songInfoSaveTimer.current = null; }
    writeSongInfo(pending.slug, pending.info);
  }, [writeSongInfo]);

  const handleSongInfoChange = useCallback((raw: SongInfo, opts?: SetUndoableOptions) => {
    // Bar 1 is the song's first bar, so the grid offset is a phase inside one
    // bar: a BPM edit, a meter change or a drag past a bar line can push it
    // out, and folding it back renumbers the bars without moving a grid line.
    // The beat stamps ride on that numbering, so they shift with it.
    const { info: next, deltaBeats } = withFoldedGridOffset(raw);
    shiftBeatStamps(deltaBeats);
    // Callers that know they're mid-gesture (a drag, a rollback) say so;
    // everyone else is read after the fact — a run of keystrokes in one field
    // is one undo step, a split is its own.
    setGridState(
      (prev) => ({ info: next, stampShift: prev.stampShift + deltaBeats }),
      opts ?? { coalesceKey: gridEditCoalesceKey(songInfo, next) ?? undefined },
    );
    persistSongInfo(next);
  }, [songInfo, shiftBeatStamps, setGridState, persistSongInfo]);

  // ── Grid undo / redo ──────────────────────────────────────────────────────
  // The history lives in songInfoCtl; these two wrappers exist so the restored
  // grid also reaches the server. The save is deferred to an effect because
  // undo() hands back the older value asynchronously — the ref is the flag
  // that says the next songInfo we see came from the undo stack.
  const gridHistoryMovedRef = useRef<{ fromShift: number } | null>(null);
  const gridStateRef = useRef(gridState);
  gridStateRef.current = gridState;
  const undoGridEdit = useCallback(() => {
    if (!songInfoCtl.canUndo) return;
    gridHistoryMovedRef.current = { fromShift: gridStateRef.current.stampShift };
    songInfoCtl.undo();
  }, [songInfoCtl]);
  const redoGridEdit = useCallback(() => {
    if (!songInfoCtl.canRedo) return;
    gridHistoryMovedRef.current = { fromShift: gridStateRef.current.stampShift };
    songInfoCtl.redo();
  }, [songInfoCtl]);
  useEffect(() => {
    const moved = gridHistoryMovedRef.current;
    if (!moved) return;
    gridHistoryMovedRef.current = null;
    // Put the bar numbering back where the restored grid expects it.
    shiftBeatStamps(gridState.stampShift - moved.fromShift);
    if (gridState.info) persistSongInfo(gridState.info);
  }, [gridState, shiftBeatStamps, persistSongInfo]);

  // ── Grid edits under Grid Lock ────────────────────────────────────────────
  //
  // Grid Lock promises that markers sit on the grid, but the grid itself keeps
  // moving: BPM edits, an offset drag, a split, a meter change. Each
  // of those makes an annotation's two readings disagree — the instant it was
  // placed at vs. the bar.beat it marks — so when one lands we ask which the
  // annotator meant. Without Grid Lock, seconds are simply canonical and the
  // grid slides underneath, as before.
  const gridWatchRef = useRef<{ slug: string | null; sig: string; grid: BeatGrid | null; info: SongInfo | null }>(
    { slug: null, sig: 'none', grid: null, info: null },
  );
  // Set while a discarded grid edit is being rolled back. The rollback is
  // itself a grid change, so without this the watcher would turn around and
  // ask about the undo.
  const revertingGridRef = useRef(false);
  // The grid as it stood before the current burst of edits — one drag fires
  // dozens of changes, and the question is about the whole gesture, not each
  // frame of it.
  const gridBurstRef = useRef<{ from: BeatGrid; fromInfo: SongInfo | null; sig: string } | null>(null);
  const layersDocRef = useRef(cueLayersDoc);
  layersDocRef.current = cueLayersDoc;

  /** Move every time onto the new grid so each marker holds the musical
   *  position it was placed on. Reads the live doc off refs so the remembered
   *  path can call it from inside the settle timer. */
  const retimeKeepBeats = useCallback((from: BeatGrid, remembered = false) => {
    const to = gridOf(songInfoRef.current);
    if (!to) return;
    const doc = layersDocRef.current;
    setGridLockUndoLayers(doc ? [...doc.layers] : null);
    setGridLockUndoRelock(false);
    setCueLayersDoc((d) => (d ? retimedDocument(d, from, to) : d));
    setGridLockUndoLabel(
      remembered
        ? 'Grid moved — annotations kept their bars & beats (remembered).'
        : 'Annotations moved to keep their bars & beats.',
    );
    setGridLockUndoRemembered(remembered);
    setShowGridLockUndoToast(true);
  }, [setCueLayersDoc]);

  /** Hold the instant each marker was placed at — exactly, to the millisecond,
   *  with nothing re-snapped. The grid moved; the sound did not, and a mark is
   *  a claim about the sound. This answer used to run the bulk snap, which is
   *  the one thing it promises not to do: rounding a mark to the nearest new
   *  line moves it off the instant it was placed at, and on a tempo edit that
   *  only *added* lines (a ×2) it moved marks that were already exactly right.
   *
   *  Two things follow from taking it literally, and both are the answer, not
   *  bookkeeping around it:
   *
   *  The beat companions are CLEARED rather than re-derived. A musical position
   *  read off a grid the annotator has just declined is not worth keeping, and
   *  an un-stamped item is skipped by the realign below — so there is no stamp
   *  left to pull the seconds onto a bar.beat nobody chose. (The next save
   *  re-derives them from the kept seconds, which is a description of where the
   *  marks are, not a move.)
   *
   *  And Grid Lock comes off. It means the BEAT is the annotation's real
   *  position; this answer says the millisecond is. Both cannot be true at
   *  once, and leaving the lock on would re-snap on the next grid edit, the
   *  next load, and every mark placed in between. Undo puts it back. */
  const retimeKeepTimes = useCallback((remembered = false) => {
    const doc = layersDocRef.current;
    setGridLockUndoLayers(doc ? [...doc.layers] : null);
    setCueLayersDoc((d) => (d ? withClearedBeatStamps(d) : d));
    setGridLockUndoRelock(gridLock);
    if (gridLock) {
      setGridLock(false);
      const info = songInfoRef.current;
      // Persisted, like the toggle's own off-switch: the song reopens unlocked
      // rather than re-snapping everything the moment it is selected again.
      if (info) handleSongInfoChange({ ...info, annotatorGridMode: false }, { skipHistory: true });
    }
    setGridLockUndoLabel(
      remembered
        ? 'Grid moved — annotations kept their exact times; Grid Lock off (remembered).'
        : 'Annotations kept their exact times. Bar.beats dropped, Grid Lock off.',
    );
    setGridLockUndoRemembered(remembered);
    setShowGridLockUndoToast(true);
  }, [setCueLayersDoc, gridLock, handleSongInfoChange]);

  // The watcher below reaches these through a ref, not its dependency array:
  // re-running that effect restarts the 700ms settle timer, and re-timing
  // depends on the layers document, which changes every time a marker is placed.
  // Listed as deps, an annotator working while the grid settles would keep the
  // question from ever being asked.
  const retimeRef = useRef({ keepBeats: retimeKeepBeats, keepTimes: retimeKeepTimes });
  retimeRef.current = { keepBeats: retimeKeepBeats, keepTimes: retimeKeepTimes };

  useEffect(() => {
    const slug = selectedAudio?.id ?? null;
    const sig = gridSignature(songInfo);
    const grid = gridOf(songInfo);
    const prev = gridWatchRef.current;

    // A song switch swaps in a whole different grid — adopt it silently.
    if (prev.slug !== slug) {
      gridWatchRef.current = { slug, sig, grid, info: songInfo };
      gridBurstRef.current = null;
      return;
    }
    // Rolling back a discarded edit: adopt the restored grid without asking.
    if (revertingGridRef.current) {
      if (sig !== prev.sig) revertingGridRef.current = false;
      gridWatchRef.current = { slug, sig, grid, info: songInfo };
      gridBurstRef.current = null;
      return;
    }
    if (sig === prev.sig) return;
    if (!gridBurstRef.current && prev.grid) {
      gridBurstRef.current = { from: prev.grid, fromInfo: prev.info, sig: prev.sig };
    }
    gridWatchRef.current = { slug, sig, grid, info: songInfo };

    const burst = gridBurstRef.current;
    if (!gridLock || !burst || !grid) { gridBurstRef.current = null; return; }
    if (pendingGridChange) return;   // already asking — don't stack prompts

    // Settle first: this effect re-runs (and clears the timer) on every frame
    // of a drag, so the question is asked once, when the gesture is over.
    const t = setTimeout(() => {
      gridBurstRef.current = null;
      const affected = countRetimed(layersDocRef.current, burst.from, grid);
      if (affected === 0) return;   // nothing would move — nothing to ask about
      // A remembered answer skips the question, never the undo: the toast still
      // comes up, and it carries the way back to being asked.
      const remembered = gridChangeChoiceRef.current;
      if (remembered === 'beats') { retimeRef.current.keepBeats(burst.from, true); return; }
      if (remembered === 'times') { retimeRef.current.keepTimes(true); return; }
      setPendingGridChange({
        from: burst.from,
        fromInfo: burst.fromInfo,
        summary: describeGridChange(burst.sig, sig),
      });
    }, 700);
    return () => clearTimeout(t);
  }, [songInfo, gridLock, selectedAudio, pendingGridChange]);

  /** "Keep their bars & beats" — answered in the modal. Undoable via the same
   *  toast the bulk snap uses. */
  const applyGridChangeKeepBeats = useCallback((remember: boolean) => {
    const pending = pendingGridChange;
    setPendingGridChange(null);
    if (!pending) return;
    if (remember) rememberGridChoice('beats');
    retimeKeepBeats(pending.from);
  }, [pendingGridChange, rememberGridChoice, retimeKeepBeats]);

  // Grid Lock means the BEAT is the annotation's real position, so a song can
  // open with times that no longer match it — the grid was edited in Data Prep,
  // in another session, or by another annotator since these were written. Pull
  // the times back onto the saved beats once per load, and say so. Nothing to
  // ask here: under Grid Lock the beat is what the annotator committed to.
  const realignedSlugRef = useRef<string | null>(null);
  useEffect(() => {
    const slug = selectedAudio?.id ?? null;
    if (!slug || !gridLock) { realignedSlugRef.current = null; return; }
    if (realignedSlugRef.current === slug) return;
    if (!cueLayersDoc || cueLayersDoc.song !== slug) return;
    const grid = gridOf(songInfo);
    if (!grid) return;
    realignedSlugRef.current = slug;
    const stale = countStaleTimes(cueLayersDoc, grid);
    if (stale === 0) return;
    setGridLockUndoLayers([...cueLayersDoc.layers]);
    setGridLockUndoRelock(false);
    setCueLayersDoc((doc) => (doc ? withTimesFromBeats(doc, grid) : doc));
    setGridLockUndoLabel(
      `${stale} annotation${stale === 1 ? '' : 's'} re-snapped to the updated grid`,
    );
    setGridLockUndoRemembered(false);   // this toast is not a remembered re-time
    setShowGridLockUndoToast(true);
  }, [selectedAudio, gridLock, cueLayersDoc, songInfo]);

  /** "Undo the grid change" — put the grid back where it was and leave every
   *  annotation exactly where it is. The escape hatch for an edit the
   *  annotator didn't mean to make (a mis-clicked ×2, a stray offset drag);
   *  nothing was re-timed yet, so restoring the SongInfo is the whole undo. */
  const discardGridChange = useCallback(() => {
    const pending = pendingGridChange;
    setPendingGridChange(null);
    if (!pending?.fromInfo) return;
    revertingGridRef.current = true;
    handleSongInfoChange({ ...pending.fromInfo, updated_at: new Date().toISOString() }, { skipHistory: true });
  }, [pendingGridChange, handleSongInfoChange]);

  /** "Keep their milliseconds" — every marker keeps the instant it was placed
   *  at, untouched. Only the beat companion is re-read from the new grid; see
   *  `retimeKeepTimes`. The other answer is the one that moves times. */
  const applyGridChangeKeepTimes = useCallback((remember: boolean) => {
    setPendingGridChange(null);
    if (remember) rememberGridChoice('times');
    retimeKeepTimes();
  }, [rememberGridChoice, retimeKeepTimes]);

  // ── GRID LOCK toggle handler ──────────────────────────────────────────────────
  const handleRequestGridLock = useCallback((enable: boolean) => {
    if (!enable) {
      setGridLock(false);
      setGridLockUndoLayers(null);
      setGridLockUndoRelock(false);
      setShowGridLockUndoToast(false);
      // Persist the off-state so the song reopens without Grid Lock.
      if (songInfo) handleSongInfoChange({ ...songInfo, annotatorGridMode: false }, { skipHistory: true });
      return;
    }
    const bpmVal = (songInfo?.bpm ?? 0) > 20 ? songInfo!.bpm! : 0;
    if (bpmVal <= 0) { setShowNoBpmModal(true); return; }
    setShowGridLockModal(true);
  }, [songInfo, handleSongInfoChange]);

  /** Turn Grid Lock on and pull every existing annotation onto the grid. */
  const confirmGridLock = useCallback(() => {
    setShowGridLockModal(false);
    // Save undo snapshot before snapping
    const currentLayers = cueLayersDoc?.layers ?? [];
    setGridLockUndoLayers([...currentLayers]);
    setGridLockUndoRelock(false);
    setGridLock(true);
    setSnapToGrid(true);
    bulkSnapAllLayers();
    // The snap just made the times authoritative for this song; their stamps
    // refresh on the next save. Mark the song as already realigned so the
    // load-time pass doesn't read those stale stamps and undo the snap.
    realignedSlugRef.current = selectedAudio?.id ?? null;
    setGridLockUndoLabel('Annotations snapped to grid.');
    setGridLockUndoRemembered(false);   // this toast is not a remembered re-time
    setShowGridLockUndoToast(true);
    // Persist so this song always opens in Grid Lock.
    if (songInfo) handleSongInfoChange({ ...songInfo, annotatorGridMode: true }, { skipHistory: true });
  }, [cueLayersDoc, bulkSnapAllLayers, songInfo, handleSongInfoChange, selectedAudio]);

  const undoGridLockSnap = useCallback(() => {
    if (!gridLockUndoLayers) return;
    setCueLayersDoc((doc) => doc && { ...doc, layers: gridLockUndoLayers });
    setGridLockUndoLayers(null);
    setShowGridLockUndoToast(false);
    // Whatever the answer also switched off goes back on with it — the layers
    // being restored are the ones that were written under Grid Lock.
    if (gridLockUndoRelock) {
      setGridLockUndoRelock(false);
      setGridLock(true);
      const info = songInfoRef.current;
      if (info) handleSongInfoChange({ ...info, annotatorGridMode: true }, { skipHistory: true });
    }
  }, [gridLockUndoLayers, gridLockUndoRelock, setCueLayersDoc, handleSongInfoChange]);

  // ── Viz click routing ─────────────────────────────────────────────────────
  // Preview-play on drag is the default everywhere (prep, algo, eval, annotation).
  // Pending "+ Add" pill is wired only to the annotation feature, since the
  // other stages have no annotation editor to receive it.
  const isAnnotateFeature = feature === 'annotate';
  // Depend on the stable `stop` callback, not on the `loopPlayback` object —
  // the hook returns a fresh object every render, and a handleVizClick that
  // churns with it re-runs every downstream effect keyed on the click handler.
  const stopLoopPlayback = loopPlayback.stop;
  // The canvas overlays (3-Band, Spectrogram) snap drag-regions themselves, to
  // a hardcoded whole beat. Hand them the lyrics rule while the Lyrics editor
  // is open so a dragged line lands where a dragged word does; every other
  // type keeps the overlay's own behaviour (undefined = no override).
  const lyricsSnapOverride = useCallback(
    (t: number) => snapTimeByLayerMode(t, lyricsSnapMode(null)),
    [snapTimeByLayerMode, lyricsSnapMode],
  );
  const vizSnapOverride = isAnnotateFeature && activeAnnotationType === 'lyrics'
    ? lyricsSnapOverride
    : undefined;

  const handleVizClick = useCallback((time: number) => {
    // Snap the cursor to the grid on click when Snap is on, so the playhead
    // lands on the beat and every add-at-playhead action inherits the snap.
    // Lyrics are the exception: they opt out of the global Snap / Grid Lock
    // switches and obey only their layer's own mode, so while the Lyrics
    // editor is open the cursor follows THAT granularity. Otherwise a
    // beat-snapped playhead would hand every "+ Add @ playhead" a beat-aligned
    // time however fine the layer was set — the picker would look ignored.
    time = isAnnotateFeature && activeAnnotationType === 'lyrics'
      ? snapTimeByLayerMode(time, lyricsSnapMode(null))
      : snapToGridIfEnabled(time);
    // Placing the cursor ends a loop preview — the loop drives the playhead
    // while it runs, so leaving it going would sweep the cursor straight back
    // off the spot the user just clicked.
    stopLoopPlayback();
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

    // Boundaries (Manual): with nothing to deselect, a click (re)anchors
    // the t1-only pending pill at the cursor — point-by-point authoring.
    if (supportsClickPending(activeAnnotationType, activeBoundarySource ?? undefined)) {
      setPendingAnnotationSelection({ t1: time, t2: null });
    }
  }, [isAnnotateFeature, activeAnnotationType, activeBoundarySource, previewRegion, snapToGridIfEnabled, snapTimeByLayerMode, lyricsSnapMode, stopLoopPlayback]);

  const handleVizRegion = useCallback((t1: number, t2: number) => {
    const snapEdge = isAnnotateFeature && activeAnnotationType === 'lyrics'
      ? (t: number) => snapTimeByLayerMode(t, lyricsSnapMode(null))
      : snapToGridIfEnabled;
    t1 = snapEdge(t1);
    t2 = snapEdge(t2);
    const supportsPending = isAnnotateFeature && supportsRangePending(activeAnnotationType, activeBoundarySource ?? undefined);
    if (supportsPending) setPendingAnnotationSelection({ t1, t2 });
    // Loop-annotation mode loops the highlighted selection by default.
    const defaultLoop = isAnnotateFeature && activeAnnotationType === 'loops';
    openPreviewRegion(t1, t2, defaultLoop);
  }, [isAnnotateFeature, activeAnnotationType, activeBoundarySource, openPreviewRegion, snapToGridIfEnabled, snapTimeByLayerMode, lyricsSnapMode]);

  const handleManualBoundaryChange = useCallback((layerId: string, sectionIndex: number, newTime: number) => {
    updateBoundaryItems(layerId, (prev) => {
      if (sectionIndex < 0 || sectionIndex >= prev.length) return prev;
      const next = [...prev];
      next[sectionIndex] = { ...next[sectionIndex], time: snapToGridIfEnabled(newTime) };
      return next;
    }, { coalesceKey: `boundary-drag:${layerId}` });
  }, [snapToGridIfEnabled, updateBoundaryItems]);

  const handleManualSectionDelete = useCallback((layerId: string, sectionIndex: number) => {
    updateBoundaryItems(layerId, (prev) => prev.filter((_, i) => i !== sectionIndex));
  }, [updateBoundaryItems]);

  // ── Layer-item drag handlers ─────────────────────────────────────────────
  // Cues / Loops / Spans all live in cueLayersDoc. Each drag
  // callback maps the affected layer's items, patching the single item by
  // id. Same shape as the popover edit handlers further down — kept inline
  // because TS struggles with a generic helper across the union of item types.
  //
  // A drag gesture fires patchItemById once per mousemove, so every call
  // must coalesce into ONE undo step instead of flooding useUndoableState's
  // history with one entry per pixel moved (see useUndoableState.ts's
  // coalesceKey doc). dragGestureIdRef bumps once per gesture (wired via
  // handleDragGestureStart below, on every onXDragStart/onXMoveStart prop);
  // all patches within that gesture share the resulting key.
  const dragGestureIdRef = useRef(0);
  const handleDragGestureStart = useCallback(() => {
    dragGestureIdRef.current += 1;
  }, []);

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
    }), { coalesceKey: `drag:${itemId}:${dragGestureIdRef.current}` });
  }, [setCueLayersDoc]);

  /** Same as patchItemById but the patch is derived from the item's CURRENT
   *  value. Needed where a change depends on what was there before — a
   *  start-edge drag has to re-anchor the item's prominence envelope by the
   *  delta it just moved, which a static patch can't express. */
  const patchItemFnById = useCallback(
    (layerId: string, itemId: string, fn: (item: never) => object) => {
      setCueLayersDoc((d) => d && ({
        ...d,
        layers: d.layers.map((l) =>
          l.id === layerId
            ? { ...l, items: (l.items as readonly { id: string }[]).map((it) =>
                it.id === itemId ? { ...it, ...fn(it as never) } : it,
              ) } as typeof l
            : l,
        ),
      }), { coalesceKey: `drag:${itemId}:${dragGestureIdRef.current}` });
    }, [setCueLayersDoc]);

  /** Start-edge drag for any durational item. Moving the start changes how far
   *  into the item every prominence breakpoint sits, so the envelope shifts by
   *  the same delta — otherwise the arc would slide against the audio. */
  const patchStartEdge = useCallback((layerId: string, itemId: string, newStart: number) => {
    patchItemFnById(layerId, itemId, (item: never) => {
      const prev = item as { start: number; prominence?: ProminenceEnvelope };
      return prev.prominence
        ? { start: newStart, prominence: shiftProminenceForStartEdge(prev.prominence, newStart - prev.start) }
        : { start: newStart };
    });
  }, [patchItemFnById]);

  const handleCueDrag = useCallback((layerId: string, itemId: string, time: number) => {
    patchItemById(layerId, itemId, { time: snapToGridIfEnabled(time) });
  }, [patchItemById, snapToGridIfEnabled]);

  const handleLyricsDrag = useCallback((layerId: string, itemId: string, time: number) => {
    patchItemById(layerId, itemId, { time: snapTimeByLayerMode(time, lyricsSnapMode(layerId)) });
  }, [patchItemById, snapTimeByLayerMode, lyricsSnapMode]);

  // Lyrics resize. Unlike spans this can't go through patchStartEdge — that
  // helper writes `start` (and shifts a prominence envelope), neither of which
  // a LyricsItem has. The start edge writes `time` and deliberately leaves
  // `end` alone, so dragging it changes the word's length rather than sliding
  // the whole word.
  const handleLyricsEdgeDrag = useCallback((layerId: string, itemId: string, edge: 'start' | 'end', time: number) => {
    const t = snapTimeByLayerMode(time, lyricsSnapMode(layerId));
    if (edge === 'start') patchItemById(layerId, itemId, { time: t });
    else patchItemById(layerId, itemId, { end: t });
  }, [patchItemById, snapTimeByLayerMode, lyricsSnapMode]);

  const handleLoopEdgeDrag = useCallback((layerId: string, itemId: string, edge: 'start' | 'end', time: number) => {
    const t = snapToGridIfEnabled(time, true);
    if (edge === 'start') patchStartEdge(layerId, itemId, t);
    else patchItemById(layerId, itemId, { end: t });
  }, [patchItemById, patchStartEdge, snapToGridIfEnabled]);

  const handleSpanEdgeDrag = useCallback((layerId: string, itemId: string, edge: 'start' | 'end', time: number) => {
    const t = snapToGridIfEnabled(time, true);
    if (edge === 'start') patchStartEdge(layerId, itemId, t);
    else patchItemById(layerId, itemId, { end: t });
  }, [patchItemById, patchStartEdge, snapToGridIfEnabled]);

  // Prominence (front/back) edits from the canvas breakpoint editors. One per
  // durational kind; all funnel through the same untyped item patch.
  const handleProminenceChange = useCallback(
    (layerId: string, itemId: string, points: ProminenceEnvelope | undefined) => {
      patchItemById(layerId, itemId, { prominence: points });
    }, [patchItemById]);

  // ─── Lead lane ──────────────────────────────────────────────────────────
  // Every prominence-carrying item across the annotator's own layers, flattened
  // for the "who's in front" lane. Derived, never stored: the lane reads the
  // same envelopes the bands render, so the two can't drift apart.
  //
  // The grid is threaded in for the lyrics layers only: their blocks are sung
  // stretches derived from word timings, and the edges snap out to the bar so a
  // chorus block lines up with the chorus rather than with its first syllable.
  // Built from `songInfo` here rather than reused from the `bpm` / `beatsPerBar`
  // derivations further down the component — those are declared below this
  // point, and a `useMemo` body runs where it is written.
  const vocalRunGrid = useMemo<VocalRunGrid>(() => ({
    bpm: (songInfo?.bpm ?? 0) > 20 ? songInfo?.bpm : undefined,
    gridOffset: songInfo?.gridOffset ?? 0,
    beatsPerBar: beatsPerBarFromTimeSignature(songInfo?.timeSignature),
    segments: resolveGridSegments(songInfo),
  }), [songInfo]);

  const leadCandidates = useMemo(
    () => collectLeadCandidates(cueLayersDoc?.layers, vocalRunGrid),
    [cueLayersDoc, vocalRunGrid],
  );

  /** Hand the lead over a range to one item, demoting whoever else held it.
   *  A handover spans several items in several layers, so it goes out as ONE
   *  document write — patching item by item would leave ⌘Z unwinding a single
   *  musical decision in three or four unrelated-looking steps. */
  /** Apply a batch of envelope patches as ONE document write, so a single
   *  musical decision is a single ⌘Z however many items and layers it spans. */
  const applyProminencePatches = useCallback((patches: readonly LeadPatch[]) => {
    if (patches.length === 0) return;
    const byLayer = new Map<string, Map<string, ProminenceEnvelope | undefined>>();
    // A patch aimed at a vocal run carries the layer's whole run list, because
    // the runs may still be derived from the word timings rather than stored.
    // Applying the patch is what freezes them: every run is written, ids and
    // all, so a later lyric correction can't renumber one the annotator has
    // already levelled. Every patch for a layer carries the same list, so the
    // first one seen is the base.
    const runBase = new Map<string, readonly VocalRun[]>();
    for (const patch of patches) {
      let forLayer = byLayer.get(patch.layerId);
      if (!forLayer) { forLayer = new Map(); byLayer.set(patch.layerId, forLayer); }
      forLayer.set(patch.itemId, patch.prominence);
      if (patch.runs && !runBase.has(patch.layerId)) runBase.set(patch.layerId, patch.runs);
    }
    setCueLayersDoc((d) => d && ({
      ...d,
      layers: d.layers.map((l) => {
        const forLayer = byLayer.get(l.id);
        if (!forLayer) return l;
        const base = runBase.get(l.id);
        if (base) {
          return { ...l, vocalRuns: base.map((r) => (
            forLayer.has(r.id) ? { ...r, prominence: forLayer.get(r.id) } : r
          )) } as typeof l;
        }
        return { ...l, items: (l.items as readonly { id: string }[]).map((it) => (
          forLayer.has(it.id) ? { ...it, prominence: forLayer.get(it.id) } : it
        )) } as typeof l;
      }),
    }));
  }, [setCueLayersDoc]);

  const handleAssignLead = useCallback(
    (t0: number, t1: number, winnerItemId: string | null) => {
      applyProminencePatches(assignLeadOverRange(leadCandidates, t0, t1, winnerItemId));
    }, [leadCandidates, applyProminencePatches]);

  /** Give the voice the front everywhere it sings.
   *
   *  The lane already DRAWS a vocal run on the Lead tier — that is a reading of
   *  an un-annotated voice, not an annotation, and it leaves the run sharing the
   *  front with whatever instrumental item was already there. This is the edit
   *  that resolves it, and it stays an explicit action because it can rewrite
   *  the envelope of every part in the song. One write, one ⌘Z. */
  const handleAssignVocalLead = useCallback(
    (layerId: string) => {
      applyProminencePatches(assignVocalLeadEverywhere(leadCandidates, layerId));
    }, [leadCandidates, applyProminencePatches]);

  /** The non-exclusive twin: one item, one level, nobody else touched. */
  const handleSetProminenceLevel = useCallback(
    (t0: number, t1: number, itemId: string, level: ProminenceLevel) => {
      applyProminencePatches(setLevelOverRange(leadCandidates, itemId, t0, t1, level));
    }, [leadCandidates, applyProminencePatches]);

  // Body-drag handlers — move the whole interval by shifting start AND end by
  // the same delta. The lane-row helper already clamps the new start into
  // [0, duration - itemDur] before calling these, so no extra bounds work here.
  // When snap is on, snap the start edge and preserve the duration.
  //
  // These snap `pixelAware`: a drag is aimed with a pointer, and a beat is
  // under 3px at fit zoom on a five-minute song — a snap that fine is one the
  // hand can neither see nor steer, which reads as "Grid Lock is on and
  // nothing snaps". The grid the band lands on widens to bars (and on to
  // phrases) until one step is worth aiming at, and hands the beat back as
  // soon as zoom makes it targetable again.
  const handleLoopMove = useCallback((layerId: string, itemId: string, newStart: number, newEnd: number) => {
    const dur = newEnd - newStart;
    const snappedStart = snapToGridIfEnabled(newStart, true);
    patchItemById(layerId, itemId, { start: snappedStart, end: snappedStart + dur });
  }, [patchItemById, snapToGridIfEnabled]);

  const handleSpanMove = useCallback((layerId: string, itemId: string, newStart: number, newEnd: number) => {
    const dur = newEnd - newStart;
    const snappedStart = snapToGridIfEnabled(newStart, true);
    patchItemById(layerId, itemId, { start: snappedStart, end: snappedStart + dur });
  }, [patchItemById, snapToGridIfEnabled]);

  const handleRiffPatternMove = useCallback((layerId: string, itemId: string, newStart: number, newEnd: number) => {
    const dur = newEnd - newStart;
    const snappedStart = snapToGridIfEnabled(newStart, true);
    patchItemById(layerId, itemId, { start: snappedStart, end: snappedStart + dur });
  }, [patchItemById, snapToGridIfEnabled]);

  /** Sets a riff node's own length as a trim — the node's content past the new
   *  end is dropped and every placement of it shrinks by the same ratio, so
   *  what survives keeps the size it's drawn at (see `trimRiffNodeLength`).
   *  One `setCueLayersDoc` for nodes + combos + items, so the whole thing is a
   *  single ⌘Z; `coalesceKey` then collapses a keystroke stream or a canvas
   *  drag into that one entry rather than one per pixel. */
  const handleRiffNodeTrim = useCallback((
    layerId: string,
    nodeId: string,
    lengthBeats: number,
    coalesceKey?: string,
  ) => {
    setCueLayersDoc((d) => d && ({
      ...d,
      layers: d.layers.map((l) => (
        l.id === layerId && l.type === 'riff-patterns'
          ? { ...l, ...trimRiffNodeLength(l as AnnotationLayer<'riff-patterns'>, nodeId, lengthBeats) } as AnnotationLayer
          : l
      )),
    }), coalesceKey ? { coalesceKey } : undefined);
  }, [setCueLayersDoc]);

  // ── Unified-sidebar per-row mutation handlers ─────────────────────────────
  // Wire the X delete + critical star toggle that UnifiedAnnotationListPanel
  // renders on every editable row. Every annotation kind is a layer in the one
  // document, so these are type-agnostic: address by (layerId, itemId) and the
  // single page-level undo history means ⌘Z always works. Read-only layers
  // don't reach these handlers — the panel hides the buttons for them.
  const handleUnifiedItemDelete = useCallback((
    layerId: string,
    itemId: string,
  ) => {
    setCueLayersDoc((d) => d && ({
      ...d,
      layers: d.layers.map((l) =>
        l.id === layerId
          ? { ...l, items: (l.items as readonly { id: string }[]).filter((it) => it.id !== itemId) } as typeof l
          : l,
      ),
    }));
  }, [setCueLayersDoc]);

  const handleUnifiedItemToggleImportance = useCallback((
    layerId: string,
    itemId: string,
  ) => {
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
  }, [setCueLayersDoc]);

  // Delete an entire layer from the unified sidebar — dropped from the one
  // document, whose useUndoableState owns ⌘Z. Read-only layers never reach
  // here: the panel hides the button for them.
  const handleUnifiedLayerDelete = useCallback((
    layerId: string,
    sectionType: AnnotationType,
  ) => {
    setCueLayersDoc((d) => d && ({ ...d, layers: d.layers.filter((l) => l.id !== layerId) }));
    if (sectionType === 'boundaries') setSelectedBoundaryLayerId((id) => (id === layerId ? null : id));
    if (sectionType === 'cues')     setSelectedCueLayerId((id) => (id === layerId ? null : id));
    if (sectionType === 'spans')    setSelectedSpanLayerId((id) => (id === layerId ? null : id));
    if (sectionType === 'loops')    setSelectedLoopLayerId((id) => (id === layerId ? null : id));
    if (sectionType === 'riff-patterns') setSelectedRiffPatternLayerId((id) => (id === layerId ? null : id));
    if (sectionType === 'lyrics')        setSelectedLyricsLayerId((id) => (id === layerId ? null : id));
    setFocusedCue((f) => (f?.layerId === layerId ? null : f));
    setFocusedSpan((f) => (f?.layerId === layerId ? null : f));
    setFocusedLoop((f) => (f?.layerId === layerId ? null : f));
    setFocusedRiffPattern((f) => (f?.layerId === layerId ? null : f));
    setFocusedLyrics((f) => (f?.layerId === layerId ? null : f));
  }, [setCueLayersDoc]);

  // Inline rename of a layer from the sidebar card header, boundaries included.
  // Keystrokes coalesce into one undo entry per layer.
  const handleUnifiedLayerRename = useCallback((
    layerId: string,
    _sectionType: AnnotationType,
    name: string,
  ) => {
    setCueLayersDoc(
      (d) => d && ({ ...d, layers: d.layers.map((l) => (l.id === layerId ? ({ ...l, name } as typeof l) : l)) }),
      { coalesceKey: `rename:${layerId}` },
    );
  }, [setCueLayersDoc]);

  // Rename a layer from its canvas lane label. The viz panel only knows the
  // layer id (not its section type), and handleUnifiedLayerRename ignores the
  // type anyway, so forward through it with a throwaway type.
  const handleVizLayerRename = useCallback((layerId: string, name: string) => {
    handleUnifiedLayerRename(layerId, 'cues', name);
  }, [handleUnifiedLayerRename]);

  // Inline edit of a single item's label from the sidebar row. Coalesced per
  // item so a typed word is one undo step, not one per keystroke.
  const handleUnifiedItemLabelChange = useCallback((
    layerId: string,
    itemId: string,
    label: string,
  ) => {
    setCueLayersDoc(
      (d) => d && ({
        ...d,
        layers: d.layers.map((l) => {
          if (l.id !== layerId) return l;
          return {
            ...l,
            items: (l.items as readonly { id: string; label: string }[]).map((it) =>
              it.id === itemId ? { ...it, label } : it,
            ),
          } as typeof l;
        }),
      }),
      { coalesceKey: `label:${layerId}:${itemId}` },
    );
  }, [setCueLayersDoc]);

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
      : boundarySrc === 'autoGuess' ? 'boundaries:autoGuess'
      : boundarySrc.startsWith('detector:')
        ? `boundaries:${boundarySrc}`
        : null;
    const pickLayerId = (
      type: 'cues' | 'spans' | 'loops' | 'lyrics',
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
      'riff-patterns':  selectedRiffPatternLayerId,
      lyrics:           pickLayerId('lyrics',        selectedLyricsLayerId,       'detector-lyrics'),
    };
  }, [activeSourceByType, selectedCueLayerId, selectedSpanLayerId, selectedLoopLayerId, selectedRiffPatternLayerId, selectedLyricsLayerId]);

  const handleUnifiedSelectLayer = useCallback((
    type: AnnotationType,
    selection: UnifiedLayerSelection,
  ) => {
    setActiveAnnotationType(type);
    setActiveSourceByType((prev) => ({ ...prev, [type]: selection.sourceId }));
    // Picking a layer is the newer, more specific click, so a lyrics detector
    // lane the karaoke was following stops being the thing the user means.
    setSelectedLyricsAlgoId(null);
    // For multi-layer types, pin the ADD+ panel's layer picker to the chosen
    // user layer. Detector layers are read-only and don't appear in the
    // picker's options, so we leave the per-type selectedXxxLayerId alone in
    // that case (the source switch above is what surfaces the detector view).
    if (selection.sourceId === 'manual') {
      if (type === 'cues')          setSelectedCueLayerId(selection.id);
      else if (type === 'spans')    setSelectedSpanLayerId(selection.id);
      else if (type === 'loops')    setSelectedLoopLayerId(selection.id);
      else if (type === 'riff-patterns') setSelectedRiffPatternLayerId(selection.id);
      else if (type === 'lyrics')        setSelectedLyricsLayerId(selection.id);
    }
    // Mirror TabGroup's onChange: drop the violet pending pill when the new
    // (type, source) pair can't consume it.
    const boundarySource = isBoundarySource(selection.sourceId) ? selection.sourceId : undefined;
    if (!supportsPending(type, boundarySource)) {
      setPendingAnnotationSelection(null);
    }
  }, []);

  // ── Canvas selection drives the side panel ────────────────────────────────
  // Clicking an item on the viz is the user pointing at that item's layer, so
  // the sidebar follows: the annotation-type chip switches to the item's type
  // and its layer becomes the selected one — exactly what clicking the layer's
  // label row does. Without this, a Loop's card could open over a sidebar
  // still showing Boundaries, and every toolbar verb (+ Add, Split, Delete,
  // undo) would keep addressing the type the user had left behind.
  //
  // Derived from whichever item popover is open — the same signal the
  // focusedXxx highlights above already track, and popovers are mutually
  // exclusive (see useAnnotationPopover's registry), so at most one wins.
  // Boundaries included: `boundaryPopover` is the page-level twin that keeps
  // sections clickable from any tab (see onManualSectionClick), and clicking
  // one is still the user pointing at Boundaries — the card that opens is a
  // full editor, not a read-only peek, so the sidebar should be pointed at
  // the same thing the card edits. Its follow-up clicks then route back
  // through the in-panel popover, which is where they belong.
  const openVizItem = useMemo<{ type: AnnotationType; layerId: string } | null>(() => {
    if (boundaryPopover.open)    return { type: 'boundaries',    layerId: boundaryPopover.open.layerId };
    if (cuePopover.open)         return { type: 'cues',          layerId: cuePopover.open.layerId };
    if (spanPopover.open)        return { type: 'spans',         layerId: spanPopover.open.layerId };
    if (loopPopover.open)        return { type: 'loops',         layerId: loopPopover.open.layerId };
    if (riffPatternPopover.open) return { type: 'riff-patterns', layerId: riffPatternPopover.open.layerId };
    if (nodePopover.open)        return { type: 'riff-patterns', layerId: nodePopover.open.layerId };
    if (lyricsPopover.open)      return { type: 'lyrics',        layerId: lyricsPopover.open.layerId };
    return null;
  }, [boundaryPopover.open, cuePopover.open, spanPopover.open, loopPopover.open,
      riffPatternPopover.open, nodePopover.open, lyricsPopover.open]);

  useEffect(() => {
    if (!openVizItem) return;
    const { type, layerId } = openVizItem;
    // Detector layers are synthesised per render and never live in the doc;
    // their id carries the detector name (`detector-loop:<name>`), which is
    // what the source picker keys on. Read the doc through its ref so an edit
    // to the item doesn't re-fire this and drag the sidebar back after the
    // user has switched tabs with the card still up.
    const layer = cueLayersDocRef.current?.layers.find((l) => l.id === layerId);
    const detectorName = !layer && layerId.startsWith('detector-')
      ? layerId.slice(layerId.indexOf(':') + 1)
      : null;
    handleUnifiedSelectLayer(type, {
      id: layerId,
      sourceId: detectorName ? `detector:${detectorName}` : 'manual',
      name: layer?.name ?? '',
      readOnly: detectorName !== null || layer?.readOnly === true,
    });
  }, [openVizItem, handleUnifiedSelectLayer]);

  // ── Keyboard-driven cue helpers ───────────────────────────────────────────
  // All read latest state via refs so they can be bound once into the shortcut config.

  // Look up the controller for whichever annotation tab is active. Shortcut
  // handlers below use this for non-Manual types — Manual keeps its page-level
  // logic because its undo stack lives here, not in the panel.
  const activePanelRef = useCallback((): AnnotationPanelController | null => {
    if (activeAnnotationTypeRef.current === 'boundaries') {
      switch (activeBoundarySourceRef.current) {
        case 'manual':    return manualPanelRef.current;
        case 'autoGuess': return autoGuessPanelRef.current;
        default:          return null;
      }
    }
    switch (activeAnnotationTypeRef.current) {
      case 'cues':      return cuesPanelRef.current;
      case 'lyrics':    return lyricsPanelRef.current;
      case 'spans':     return spansPanelRef.current;
      case 'loops':     return loopsPanelRef.current;
      case 'riff-patterns':  return riffPatternsPanelRef.current;
      default:               return null;
    }
  }, []);

  // Mark an item at the playhead. Every type routes through its panel's
  // controller, which owns that type's add semantics (the filler-cap workflow
  // for boundaries, a point for cues, a region for spans…) and adopts a
  // highlighted region when there is one. Auto-guess has no addAtPlayhead
  // (algorithm-driven) — no-op there.
  const handleMarkCueAtPlayhead = useCallback((eventTs?: number) => {
    activePanelRef()?.addAtPlayhead?.(liveSongTimeRef.current?.(eventTs) ?? undefined);
  }, [activePanelRef]);

  // Split: bisect the item the playhead currently sits inside. Only the
  // boundary panel implements it (sections tile, so a split is well-defined);
  // for every other type the controller simply has no `split`.
  const handleSplitCueAtPlayhead = useCallback(() => {
    activePanelRef()?.split?.();
  }, [activePanelRef]);

  // Delete the cue closest to the playhead, but only if it's within 5s — prevents
  // accidental deletions when the playhead is far from any boundary.
  const handleDeleteNearestCue = useCallback(() => {
    const type = activeAnnotationTypeRef.current;
    const source = activeBoundarySourceRef.current;
    // Auto-guess points are algorithm-generated; users review (✓/✗/@), they
    // don't delete. No-op so accidental Delete presses don't disturb data.
    if (type === 'boundaries' && source === 'autoGuess') return;
    // Spans / Loops delegate to the panel's `deleteFocused`,
    // which knows the per-type item semantics. Same path as Cues' fallback.
    if (type === 'spans' || type === 'loops') {
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
    // Boundaries: the nearest section start within the 5s tolerance, inside
    // whichever boundary layer is active.
    const layer = activeBoundaryLayerRef.current;
    if (!layer?.items.length) return;
    const t = playerTimeRef.current;
    let bestIdx = 0;
    let bestDist = Math.abs(layer.items[0].time - t);
    for (let i = 1; i < layer.items.length; i++) {
      const d = Math.abs(layer.items[i].time - t);
      if (d < bestDist) { bestIdx = i; bestDist = d; }
    }
    if (bestDist > 5) return;
    handleManualSectionDelete(layer.id, bestIdx);
  }, [handleManualSectionDelete, activePanelRef, setCueLayersDoc]);

  // Collect item start-times for the active layer-type, deduplicated and
  // sorted. Spans/Loops navigate by item `start`; Cues by `time`.
  function collectVisibleStartTimes(
    doc: AnnotationLayersDocument | null,
    layerType: 'cues' | 'spans' | 'loops',
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
  // Manual sections, Auto-guess points, or layer-type items.
  function collectNavTimes(): number[] {
    const type = activeAnnotationTypeRef.current;
    const source = activeBoundarySourceRef.current;
    if (type === 'boundaries' && source === 'manual') {
      return (activeBoundaryLayerRef.current?.items ?? []).map((s) => s.time);
    }
    if (type === 'boundaries' && source === 'autoGuess') {
      return (autoGuessAnnotationRef.current?.points ?? []).map((p) => p.time);
    }
    if (type === 'cues' || type === 'spans' || type === 'loops') {
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
    playLoop(id, start, end, opts);
  }, [playLoop]);
  // `loopPlayback` is a fresh object on every render, and a loop sounding at
  // 60 fps renders this page 60 times a second — so keyed on the object, this
  // effect re-ran every frame and stopped the loop for as long as
  // `playerIsPlaying` had not yet flipped false. A loop started while the
  // track was playing (the highlight band's own loop is always started that
  // way) was therefore silenced a frame after it began: one buffer source
  // started, then stopped, and the control bar fell back to "play". Keyed on
  // the stable `stop`, it runs only when the player actually starts.
  useEffect(() => {
    if (playerIsPlaying) stopLoop();
  }, [playerIsPlaying, stopLoop]);

  // Forward-declared ref so shortcuts can call handleAlignGridToPlayhead even
  // though the handler itself is defined further down (after songInfo state).
  // Wired by an effect right next to the handler.
  const alignGridToPlayheadRef = useRef<(() => void) | null>(null);

  // Refs that mirror loop state for the L hotkey — using refs keeps the
  // shortcut useMemo from re-running on every focusedLoop / playback change.
  // Loop layers are read off `cueLayersDocRef.current` (already mirrored above).
  const focusedLoopRef = useRef<{ layerId: string; itemId: string } | null>(null);
  const loopPlaybackRef = useRef<typeof loopPlayback | null>(null);
  useEffect(() => { focusedLoopRef.current = focusedLoop; }, [focusedLoop]);
  useEffect(() => { loopPlaybackRef.current = loopPlayback; }, [loopPlayback]);

  // ── The live playhead, for anything that PLACES a mark ────────────────────
  // `playerTime` is fine for drawing and wrong for marking: it is the media
  // clock after a rAF coalesce, a setState and a re-render of this (very
  // large) page, so a cue committed against it lands where the playhead was,
  // not where the annotator heard the thing they pressed M for. Every add
  // path reads this instead — the same rule PlayerPanel's audioprocess
  // handler already follows for ending a preview region.
  //
  // `eventTs` is the originating DOM event's `timeStamp` (same timebase as
  // performance.now()). The clock read here says "now"; the key went down
  // `eventTs` ago, and while the main thread is busy compositing the timeline
  // that gap is not always a frame. Backing it out puts the mark at the press,
  // not at the dispatch. Guarded to a sane window so a stale or differently
  // based timestamp can only be ignored, never shift a mark by seconds.
  const liveSongTime = useCallback((eventTs?: number): number | null => {
    // While a loop preview runs it owns the playhead and WaveSurfer is paused,
    // so the player's clock is a stale number — ask the loop engine instead.
    const playback = loopPlaybackRef.current;
    const live = (playback?.playingId ? playback.getTime() : null)
      ?? getTimeRef.current?.()
      ?? null;
    if (live == null || !Number.isFinite(live)) return null;
    if (eventTs == null) return live;
    const lag = (performance.now() - eventTs) / 1000;
    if (!(lag > 0) || lag > MAX_INPUT_LAG_SEC) return live;
    return Math.max(0, live - lag);
  }, []);
  useEffect(() => { liveSongTimeRef.current = liveSongTime; }, [liveSongTime]);

  // ── Mark In / Mark Out (two-step ADD for Spans / Loops) ─────────────────
  // Shared between the toolbar buttons and the I / O hotkeys. Mark In stashes
  // the playhead as a single-point pending selection (the viz already renders
  // it as a flag). Mark Out reads that stash, asks the active panel to commit
  // a fresh item with [stashed, currentPlayhead], and clears the stash. The
  // zoom level is left untouched — the new item draws on the layer + viz at
  // the user's current viewport. Mark Out is a no-op when there is no Mark In
  // stash — the toolbar / hotkey disabled state advertises that to the user.
  const handleMarkIn = useCallback((eventTs?: number) => {
    const t = liveSongTimeRef.current?.(eventTs) ?? playerTimeRef.current;
    setPendingAnnotationSelection({ t1: t, t2: null });
  }, []);

  const handleMarkOut = useCallback((eventTs?: number) => {
    const pending = pendingAnnotationSelectionRef.current;
    if (!pending || pending.t2 !== null) return;
    const start = pending.t1;
    const end = liveSongTimeRef.current?.(eventTs) ?? playerTimeRef.current;
    activePanelRef()?.commitItemRange?.(start, end);
    setPendingAnnotationSelection(null);
  }, [activePanelRef]);

  // Whether Mark Out is currently meaningful — drives both the button's
  // enabled state and the I / O hotkey gating. True when a Mark In has been
  // stashed (pending has t1 only, no t2) on a layer-typed tab.
  const canMarkOutNow = pendingAnnotationSelection !== null
    && pendingAnnotationSelection.t2 === null
    && (activeAnnotationType === 'spans'
      || activeAnnotationType === 'loops');

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  // Single source of truth: this config drives both the global keydown handler
  // (`useAnnotationShortcuts`) AND the help panel UI. Adding a shortcut here
  // automatically lists it in the help drawer.
  // Seek deltas are user-configurable in Settings → Display & playback.
  const seekSmall  = Math.max(0.1, Number(settings.seekStepSmallSeconds)  || 1);
  const seekMedium = Math.max(0.1, Number(settings.seekStepMediumSeconds) || 5);
  const seekLarge  = Math.max(0.1, Number(settings.seekStepLargeSeconds)  || 10);
  // Annotation-type chips the editor currently exposes, in display order.
  // Number keys 1-N below jump straight to the matching chip; loops and riff
  // patterns only appear when the experimental flag is on.
  const visibleAnnotationTypes = useMemo<AnnotationType[]>(
    () => TAB_CONFIG
      .filter((t) => {
        if (t.experimental === 'loopsAndPatterns') return settings.experimentalLoopsAndPatterns;
        if (t.experimental === 'lyrics') return settings.experimentalLyricsFamily;
        return true;
      })
      .map((t) => t.id),
    [settings.experimentalLoopsAndPatterns, settings.experimentalLyricsFamily],
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
    // (Manual, Cues, Spans, Loops). Auto-guess is algorithm-driven
    // and ignores most of these.
    {
      group: 'Annotation',
      display: 'M',
      description: 'Mark at playhead (section · point · cue · 1-bar span · '
        + 'quick-add loop depending on active tab)',
      match: (e) => (e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { e.preventDefault(); handleMarkCueAtPlayhead(e.timeStamp); },
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
      description: 'Delete focused / nearest item (Manual, Cues, Spans, Loops)',
      match: (e) => (e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { e.preventDefault(); handleDeleteNearestCue(); },
    },
    {
      group: 'Annotation',
      display: 'Y',
      description: 'Accept the detector suggestion at the playhead (active tab\u2019s detector layer)',
      match: (e) => (e.key === 'y' || e.key === 'Y') && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { if (reviewDetectorAtPlayheadRef.current('accepted')) e.preventDefault(); },
    },
    {
      group: 'Annotation',
      display: 'N',
      description: 'Reject the detector suggestion at the playhead (active tab\u2019s detector layer)',
      match: (e) => (e.key === 'n' || e.key === 'N') && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { if (reviewDetectorAtPlayheadRef.current('rejected')) e.preventDefault(); },
    },
    {
      group: 'Annotation',
      display: '[',
      description: 'Jump to previous item (Manual sections, Cues, Spans, Loops)',
      match: (e) => e.key === '[' && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { e.preventDefault(); handleJumpToPrevCue(); },
    },
    {
      group: 'Annotation',
      display: ']',
      description: 'Jump to next item (Manual sections, Cues, Spans, Loops)',
      match: (e) => e.key === ']' && !e.ctrlKey && !e.metaKey && !e.altKey,
      run:   (e) => { e.preventDefault(); handleJumpToNextCue(); },
    },
    {
      group: 'Annotation',
      display: 'Enter',
      description: 'Confirm the highlighted selection on every tab '
        + '(Manual boundaries, Cues, Spans, Loops) — turns '
        + 'the highlight into a new item (Cues get one point at its start).',
      match: (e) => e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
        && !!effectiveAnnotationSelectionRef.current
        && effectiveAnnotationSelectionRef.current.t2 !== null,
      run:   (e) => { e.preventDefault(); activePanelRef()?.confirmPending?.(); },
    },
    // I / O follow the DAW + NLE convention for "In" and "Out" markers, mapped
    // here to the two-step ADD flow: I stashes the playhead as the start of a
    // brand-new item and draws a flag on the viz; O completes the add by
    // committing a fresh span / loop with [stashed, playhead] and
    // zoom-to-fits the new range. Guarded to Spans / Loops since
    // only interval-typed tabs support intervals; Manual / Cues use
    // point-based shortcuts (M, S) instead. O is gated on having a Mark In
    // stashed — otherwise the keystroke is a no-op (matches the button's
    // disabled state with the "Click Mark In first" hint).
    {
      group: 'Annotation',
      display: 'I',
      description: 'Mark In — stash the playhead as the start of a brand-new Span / Loop. Draws a flag on the visualization at the cursor; press O next to commit the new item.',
      match: (e) => (e.key === 'i' || e.key === 'I') && !e.ctrlKey && !e.metaKey && !e.altKey
        && (activeAnnotationTypeRef.current === 'spans'
          || activeAnnotationTypeRef.current === 'loops'),
      run:   (e) => { e.preventDefault(); handleMarkIn(e.timeStamp); },
    },
    {
      group: 'Annotation',
      display: 'O',
      description: 'Mark Out — commit a brand-new Span / Loop with [Mark In, playhead], then zoom the waveform to fit the new item. No-op until Mark In is stashed.',
      match: (e) => (e.key === 'o' || e.key === 'O') && !e.ctrlKey && !e.metaKey && !e.altKey
        && (activeAnnotationTypeRef.current === 'spans'
          || activeAnnotationTypeRef.current === 'loops'),
      run:   (e) => { e.preventDefault(); handleMarkOut(e.timeStamp); },
    },
    {
      group: 'Annotation',
      display: 'Ctrl + Z',
      description: 'Undo last edit. In DataPrep this walks back the grid — BPM, '
        + 'meter, downbeat, pinned beats and grid segments all '
        + 'share one history. Everywhere else it walks back the annotations: '
        + 'Boundaries·Manual and Cues / Spans / Loops / Patterns / Riff Patterns '
        + 'share one history too, so it always undoes whichever was actually '
        + 'edited last, regardless of the active tab. You undo where you edited: '
        + 'neither history can reach the other.',
      match: (e) => (e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey,
      run:   (e) => {
        e.preventDefault();
        if (feature === 'prep') undoGridEdit();
        else annotationDocsCtl.undo();
      },
    },
    {
      group: 'Annotation',
      display: 'Shift + Ctrl + Z',
      description: 'Redo last undone edit — same histories as Ctrl+Z (the grid in '
        + 'DataPrep, the annotations everywhere else).',
      match: (e) => (e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey,
      run:   (e) => {
        e.preventDefault();
        if (feature === 'prep') redoGridEdit();
        else annotationDocsCtl.redo();
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
    // (annotate workspace only; loops and riff patterns appear only when experimental).
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
        group: 'Metronome',
        display: 'T',
        description: 'Tap tempo (tap along; BPM streams to the song from the 2nd tap)',
        // Guard against `repeat` — holding the key would otherwise flood the
        // reducer with sub-debounce taps and lock the readout at the auto-repeat rate.
        match: (e: KeyboardEvent) => (e.key === 't' || e.key === 'T') && !e.repeat && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey,
        run:   (e: KeyboardEvent) => { e.preventDefault(); metronomeTapRef.current?.(); },
      } as ShortcutDef,
    ] : []),
  ], [handleTogglePlay, handleSeekRelative, handleSeekToStart, handleSeekToEnd, handleMarkCueAtPlayhead, handleSplitCueAtPlayhead, handleDeleteNearestCue, handleJumpToPrevCue, handleJumpToNextCue, activePanelRef, feature, annotationDocsCtl, undoGridEdit, redoGridEdit, handleMarkIn, handleMarkOut, seekSmall, seekMedium, seekLarge, visibleAnnotationTypes, selectAnnotationTypeChip]);

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
    const regular = buildAnnotationRows(toolStates).filter((r) => !SINGLE_INFO_ONLY_IDS.has(baseAlgoId(r.id)));
    const ruptures: AlgorithmRow[] = RUPTURES_METHODS
      .filter((m) => rupturesResults[m.suffix])
      .map((m) => {
        const res = rupturesResults[m.suffix];
        return {
          id: `ruptures-${m.suffix}`,
          label: res.algoName,
          sections: res.sections.map((s) => ({ time: s.time, endTime: s.endTime, label: s.label, type: s.type, raw: s })),
        };
      });
    // Custom detectors are curators, not algorithm-family rows. Every one
    // surfaces through the Curated sidebar instead — boundary curators as
    // `detectorBoundaryOverlays`, the cue/span/loop/lyrics ones as
    // detector-sourced layers. Keeping them out of this list also keeps a
    // consensus-of-algorithms curator (e.g. phrases-msaf) from being folded
    // back into the auto-guess consensus pool it was derived from.
    return [...regular, ...ruptures];
  }, [toolStates, rupturesResults]);

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
      .filter((d) => d.status === 'ok' && d.is_algorithm && !d.is_annotation && d.output_kind === 'boundary')
      .forEach((d, i) => { m[d.name] = CUSTOM_ANNOTATION_PALETTE[i % CUSTOM_ANNOTATION_PALETTE.length]; });
    return m;
  }, [customDetectors]);

  // Global detector-name → palette colour across EVERY curated/custom layer of
  // any kind (boundary/cue/span/loop/lyrics). Indexing globally (sorted
  // by name for stability) keeps a span layer and a cue layer from colliding on
  // the same hue — without it each kind restarts the palette at rose.
  const detectorColorByName = useMemo(() => {
    const m: Record<string, string> = {};
    customDetectors
      .filter((d) => d.status === 'ok' && d.is_annotation)
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b))
      .forEach((name, i) => { m[name] = CUSTOM_ANNOTATION_PALETTE[i % CUSTOM_ANNOTATION_PALETTE.length]; });
    return m;
  }, [customDetectors]);

  // Resolve a label color for an algo row (mirrors the AlgoInspectStage grouping).
  const algoLabelColor = useCallback((id: string): string => {
    if (id.startsWith('ruptures-')) return rupturesLabelColor(id.slice('ruptures-'.length));
    if (id.startsWith('custom:')) return customAlgoColors[id.slice('custom:'.length)] ?? '#fbbf24';
    // Per-stem overlay rows ("<algo>__<stem>") get a stem-specific hue so the
    // four stems of one family are visually distinct, not one shared colour.
    const us = id.indexOf('__');
    if (us !== -1) return STEM_OVERLAY_COLORS[id.slice(us + 2)] ?? ALGO_LABEL_COLORS[baseAlgoId(id)] ?? '#94a3b8';
    return ALGO_LABEL_COLORS[baseAlgoId(id)] ?? '#94a3b8';
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
    // Pure-annotation boundary detectors (is_annotation, NOT is_algorithm) get
    // the ✓/✗ review strip. is_algorithm boundary curators (e.g. phrases-msaf)
    // are read-only curated layers instead — see detectorBoundaryLayers.
    const eligible = customDetectors.filter((d) => d.status === 'ok' && d.is_annotation && !d.is_algorithm && d.output_kind === 'boundary');
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
      const color = detectorColorByName[d.name] ?? CUSTOM_ANNOTATION_PALETTE[paletteIdx % CUSTOM_ANNOTATION_PALETTE.length];
      return [{ rowId: `custom-annotation:${d.name}`, detectorName: d.name, label: detectorLaneName(d.label || d.name, d.stem), color, points }];
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
      const color = detectorColorByName[d.name] ?? CUSTOM_ANNOTATION_PALETTE[paletteIdx % CUSTOM_ANNOTATION_PALETTE.length];
      const items = env.items as CustomCueItem[];
      const cueItems: CueItem[] = items.map((it, i) => ({
        id: `${d.name}:${i}:${it.time_ms}`,
        time: it.time_ms / 1000,
        label: it.label ?? '',
        description: it.description ?? undefined,
        candidates: it.candidates && it.candidates.length > 0
          ? it.candidates.map((ms) => ms / 1000)
          : undefined,
        ...struckHitFields(it),
      }));
      return [{
        id: `detector-cue:${d.name}`,
        name: detectorLaneName(d.label || d.name, d.stem),
        sourceStem: d.stem ?? undefined,
        sourceDescription: d.description || undefined,
        sourceNotes: (env.notes && env.notes.length) ? env.notes : undefined,
        type: 'cues' as const,
        visible: true,
        color,
        snap: 'beat' as const,
        items: cueItems,
        readOnly: true,
        source: `detector:${d.name}` as const,
      }];
    }).sort(byStemRank);
  }, [customDetectors, customResults]);

  // ── Detector-sourced Span/Loop layers ─────────────────────────────────────
  // Mirror detectorCueLayers for the remaining annotation kinds so a custom
  // detector that emits spans/loops surfaces alongside the user's
  // own layers under the Annotations dropdown's matching subgroup. Same
  // readOnly + source: 'detector:<name>' contract.
  const detectorSpanLayers = useMemo<AnnotationLayer<'spans'>[]>(() => {
    const eligible = customDetectors.filter((d) => d.status === 'ok' && d.is_annotation && d.output_kind === 'span');
    return eligible.flatMap((d, paletteIdx) => {
      const env = customResults[d.name];
      if (!env || env.fatal) return [];
      const color = detectorColorByName[d.name] ?? CUSTOM_ANNOTATION_PALETTE[paletteIdx % CUSTOM_ANNOTATION_PALETTE.length];
      const items = env.items as CustomSpanItem[];
      const spanItems: SpanItem[] = items.map((it, i) => ({
        id: `${d.name}:${i}:${it.start_ms}`,
        start: it.start_ms / 1000,
        end: (it.start_ms + it.duration_ms) / 1000,
        label: it.label ?? '',
      }));
      return [{
        id: `detector-span:${d.name}`,
        name: detectorLaneName(d.label || d.name, d.stem),
        sourceStem: d.stem ?? undefined,
        sourceDescription: d.description || undefined,
        sourceNotes: (env.notes && env.notes.length) ? env.notes : undefined,
        type: 'spans' as const,
        visible: true,
        color,
        snap: 'beat' as const,
        items: spanItems,
        readOnly: true,
        source: `detector:${d.name}` as const,
      }];
    }).sort(byStemRank);
  }, [customDetectors, customResults]);

  const detectorLoopLayers = useMemo<AnnotationLayer<'loops'>[]>(() => {
    const eligible = customDetectors.filter((d) => d.status === 'ok' && d.is_annotation && d.output_kind === 'loop');
    return eligible.flatMap((d, paletteIdx) => {
      const env = customResults[d.name];
      if (!env || env.fatal) return [];
      const color = detectorColorByName[d.name] ?? CUSTOM_ANNOTATION_PALETTE[paletteIdx % CUSTOM_ANNOTATION_PALETTE.length];
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
        name: detectorLaneName(d.label || d.name, d.stem),
        sourceStem: d.stem ?? undefined,
        sourceDescription: d.description || undefined,
        sourceNotes: (env.notes && env.notes.length) ? env.notes : undefined,
        type: 'loops' as const,
        visible: true,
        color,
        snap: 'beat' as const,
        items: loopItems,
        readOnly: true,
        source: `detector:${d.name}` as const,
      }];
    }).sort(byStemRank);
  }, [customDetectors, customResults]);

  const detectorLyricsLayers = useMemo<AnnotationLayer<'lyrics'>[]>(() => {
    const eligible = customDetectors.filter((d) => d.status === 'ok' && d.is_annotation && d.output_kind === 'lyrics');
    return eligible.flatMap((d, paletteIdx) => {
      const env = customResults[d.name];
      if (!env || env.fatal) return [];
      const color = detectorColorByName[d.name] ?? CUSTOM_ANNOTATION_PALETTE[paletteIdx % CUSTOM_ANNOTATION_PALETTE.length];
      const items = env.items as CustomLyricsItem[];
      const lyricsItems: LyricsItem[] = items.map((it, i) => ({
        id: `${d.name}:${i}:${it.time_ms}`,
        time: it.time_ms / 1000,
        text: it.text ?? '',
        kind: it.kind,
        ...(it.end_ms != null ? { end: it.end_ms / 1000 } : {}),
      }));
      return [{
        id: `detector-lyrics:${d.name}`,
        name: detectorLaneName(d.label || d.name, d.stem),
        sourceStem: d.stem ?? undefined,
        sourceDescription: d.description || undefined,
        sourceNotes: (env.notes && env.notes.length) ? env.notes : undefined,
        type: 'lyrics' as const,
        visible: true,
        color,
        snap: 'off' as const,
        items: lyricsItems,
        readOnly: true,
        source: `detector:${d.name}` as const,
      }];
    }).sort(byStemRank);
  }, [customDetectors, customResults]);

  // ── Detector-sourced riff-pattern layers (output_kind='pattern') ──────────
  // A pattern detector says "this figure recurs, here and here" — the riff
  // model's node/instance split. riffLayerFromDrumGrooves builds the nodes and
  // instances; a multi-row groove (drum_kit_pattern) gives one node per drum,
  // all placed over the same bars, which the lane stacks into the three-line
  // drum staff. Needs a bpm, since a node's length is measured in beats — a
  // song without a grid yields no layer rather than zero-length nodes.
  const detectorRiffLayers = useMemo<AnnotationLayer<'riff-patterns'>[]>(() => {
    const eligible = customDetectors.filter((d) => d.status === 'ok' && d.is_annotation && d.output_kind === 'pattern');
    return eligible.flatMap((d, paletteIdx) => {
      const env = customResults[d.name];
      if (!env || env.fatal) return [];
      const color = detectorColorByName[d.name] ?? CUSTOM_ANNOTATION_PALETTE[paletteIdx % CUSTOM_ANNOTATION_PALETTE.length];
      // The canonical `bpm` is derived in the Derived block further down, which
      // this memo sits above — same rule, applied here rather than reordering
      // a dozen unrelated declarations.
      const songBpm = (songInfo?.bpm ?? 0) > 20 ? songInfo!.bpm : undefined;
      const layer = riffLayerFromDrumGrooves(
        env.items as unknown as GrooveItem[],
        songBpm,
        { name: detectorLaneName(d.label || d.name, d.stem), layerColor: color, importedFrom: d.label || d.name },
      );
      if (!layer) return [];
      return [{
        ...layer,
        id: `detector-riff:${d.name}`,
        sourceStem: d.stem ?? undefined,
        sourceDescription: d.description || undefined,
        sourceNotes: (env.notes && env.notes.length) ? env.notes : undefined,
        visible: true,
        readOnly: true,
        source: `detector:${d.name}` as const,
      }];
    }).sort(byStemRank);
  }, [customDetectors, customResults, songInfo]);

  // Which custom-annotation rows are currently hidden in the Annotations
  // dropdown. Custom detectors are hidden by default — a sync effect below
  // pre-adds every newly discovered detectorName so it stays off the canvas
  // until the user opts in by checking it in the dropdown. Declared here (ahead
  // of the detector-layer memos below) because those memos read it during render.
  const [hiddenCustomAnnotations, setHiddenCustomAnnotations] = useState<Set<string>>(() => new Set());

  // ── Detector-sourced Boundary layers (is_algorithm boundary curators) ──────
  // Boundaries have no AnnotationLayer abstraction, so a boundary curator
  // (a phrase curator, say) renders as a read-only section-block overlay
  // — but it is listed and toggled in the Curated sidebar via the shared
  // `hiddenCustomAnnotations` set, exactly like every other curator. The
  // is_algorithm flag is what makes it a boundary-overlay curator; the
  // is_annotation flag is what lists it among the Annotator's curated layers.
  const detectorBoundaryLayers = useMemo(() => {
    const eligible = customDetectors.filter((d) => d.status === 'ok' && d.is_algorithm && d.output_kind === 'boundary');
    return eligible.flatMap((d, paletteIdx) => {
      const env = customResults[d.name];
      if (!env || env.fatal) return [];
      const color = detectorColorByName[d.name] ?? CUSTOM_ANNOTATION_PALETTE[paletteIdx % CUSTOM_ANNOTATION_PALETTE.length];
      return [{
        id: `detector-boundary:${d.name}`,
        detectorName: d.name,
        name: detectorLaneName(d.label || d.name, d.stem),
        stem: (d.stem ?? 'mix') as string,
        color,
        sections: customEnvelopeToSections(env, duration, color),
      }];
    });
  }, [customDetectors, customResults, duration]);

  // Boundary curators as algo-overlay-shaped section blocks, filtered by the
  // shared visibility set. Passed to SharedVizPanel in BOTH workspaces so a
  // boundary curator draws once per view (Inspect = its is_algorithm surface,
  // Annotator = its is_annotation surface), never twice.
  const detectorBoundaryOverlays = useMemo(() => {
    return detectorBoundaryLayers
      .filter((l) => !hiddenCustomAnnotations.has(l.detectorName))
      .map((l) => ({ id: l.id, label: l.name, labelColor: l.color, sections: l.sections }));
  }, [detectorBoundaryLayers, hiddenCustomAnnotations]);

  // Curated (detector-sourced) layers across every kind, grouped by the Demucs
  // stem they were built on. Powers the Curated sidebar's per-stem show/hide
  // chips + grouped list. Visibility is driven by the shared
  // `hiddenCustomAnnotations` set (keyed by detector name), so toggling here
  // propagates to both the canvas and the annotation list.
  const curatedLayersByStem = useMemo(() => {
    const all = [
      ...detectorCueLayers, ...detectorSpanLayers, ...detectorLoopLayers,
      ...detectorLyricsLayers, ...detectorRiffLayers,
    ];
    const rows = all.map((l) => {
      const detName = l.source!.slice('detector:'.length);
      const det = customDetectors.find((d) => d.name === detName);
      return {
        id: l.id,
        name: l.name,
        color: l.color,
        detectorName: detName,
        stem: (l.sourceStem ?? 'mix') as string,
        group: det?.group ?? null,
        isDefault: det?.is_default ?? false,
        type: l.type as 'cues' | 'spans' | 'loops' | 'lyrics',
      };
    });
    const boundaryRows = detectorBoundaryLayers.map((l) => {
      const det = customDetectors.find((d) => d.name === l.detectorName);
      return {
        id: l.id,
        name: l.name,
        color: l.color,
        detectorName: l.detectorName,
        stem: l.stem,
        group: det?.group ?? null,
        isDefault: det?.is_default ?? false,
        type: 'boundary' as const,
      };
    });
    const allRows = [...boundaryRows, ...rows];
    const splitByStem = (list: typeof allRows) => {
      const byStem = new Map<string, typeof allRows>();
      for (const r of list) {
        if (!byStem.has(r.stem)) byStem.set(r.stem, []);
        byStem.get(r.stem)!.push(r);
      }
      const stems = [...byStem.keys()].sort((a, b) => stemRank(a) - stemRank(b));
      return { byStem, stems };
    };
    // Default (shipped) vs Custom, titled only when both are present; the
    // stem headers and groups nest inside each.
    const origins = groupByDetectorOrigin(allRows, (r) => r.isDefault)
      .map((g) => ({ origin: g.origin, title: g.title, ...splitByStem(g.items) }));
    return { rows: allRows, ...splitByStem(allRows), origins };
  }, [detectorCueLayers, detectorSpanLayers, detectorLoopLayers, detectorLyricsLayers, detectorBoundaryLayers, customDetectors]);

  // Stem rank for every detector-sourced layer, keyed by the viz row id
  // (`<kind>-layer:<id>`). Drives the default stacking order of the lanes so
  // they read in SOURCE order (mix → vocals → drums → bass → other → guitar →
  // piano). User-authored layer rows are absent from this map and keep their
  // own positions; only detector lanes are reordered.
  const layerStemRank = useMemo<Map<string, number>>(() => {
    const m = new Map<string, number>();
    const add = (layers: AnnotationLayer[], prefix: string) => {
      for (const l of layers) m.set(`${prefix}:${l.id}`, stemRank(l.sourceStem));
    };
    add(detectorCueLayers, 'cue-layer');
    add(detectorSpanLayers, 'span-layer');
    add(detectorLoopLayers, 'loop-layer');
    add(detectorLyricsLayers, 'lyrics-layer');
    add(detectorRiffLayers, 'riff-layer');
    return m;
  }, [detectorCueLayers, detectorSpanLayers, detectorLoopLayers, detectorLyricsLayers, detectorRiffLayers]);

  // Per-layer accept/reject map for detector cue/span/loop layers,
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
    wire(detectorLyricsLayers);
    return out;
  }, [detectorCueLayers, detectorSpanLayers, detectorLoopLayers, detectorLyricsLayers, detectorOutputDocs]);

  // Count of already-imported copies per detector layer id. Passed to
  // SharedVizPanel so LayerRowLabel can show the amber duplicate badge without
  // a per-render cueLayersDoc scan inside the component.
  const detectorLayerCopyCounts = useMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    const all = [
      ...detectorCueLayers, ...detectorSpanLayers, ...detectorLoopLayers,
      ...detectorLyricsLayers, ...detectorRiffLayers,
    ];
    if (!cueLayersDoc) return counts;
    for (const layer of all) {
      const src = layer.source;
      if (!src?.startsWith('detector:')) continue;
      const detName = src.slice('detector:'.length);
      const det = customDetectors.find((d) => d.name === detName);
      const detLabel = det?.label ?? layer.name;
      counts[layer.id] = cueLayersDoc.layers.filter(
        (l) => l.importedFrom === detLabel || l.importedFrom === `${detLabel} (✓ accepted)`,
      ).length;
    }
    return counts;
  }, [detectorCueLayers, detectorSpanLayers, detectorLoopLayers, detectorLyricsLayers, customDetectors, cueLayersDoc]);

  // Copy a detector-sourced viz lane layer into a new editable manual layer.
  // Wired to SharedVizPanel's onCopyDetectorLayer so the lane-label ⓘ popup
  // and the inline ⬇ button both call the same logic.
  const handleCopyDetectorVizLayer = useCallback((layer: AnnotationLayer) => {
    if (!selectedAudio || !layer.source?.startsWith('detector:')) return;
    const detName = layer.source.slice('detector:'.length);
    const det = customDetectors.find((d) => d.name === detName);
    const envelope = customResults[detName];
    const doc = detectorOutputDocs[detName];
    const items = (doc ?? envelope)?.items ?? [];
    const review = doc?.review ?? {};
    const detLabel = det?.label ?? layer.name;
    const layerType = layer.type as 'cues' | 'spans' | 'loops' | 'lyrics';
    const primaryMs = (it: { time_ms?: number; start_ms?: number }) =>
      (layerType === 'cues' || layerType === 'lyrics')
        ? (it.time_ms ?? 0) : (it.start_ms ?? 0);
    const keep = items.filter((it, i) =>
      review[`${i}:${primaryMs(it as { time_ms?: number; start_ms?: number })}`] !== 'rejected',
    );
    if (keep.length === 0) return;
    const converted = convertDetectorItems(layerType, keep as Parameters<typeof convertDetectorItems>[1]);
    if (!converted) return;
    const newLayerId = newId();
    const prevSrc = activeSourceByType[layerType as AnnotationCategory];
    setCueLayersDoc((d) => {
      if (!d) return d;
      const color = pickDefaultLayerColor(d.layers);
      const newLayer: AnnotationLayer = {
        id: newLayerId,
        name: detLabel,
        type: layerType,
        visible: true,
        color,
        snap: layerType === 'loops' ? 'bar' : 'beat',
        items: converted as never,
        source: 'user',
        importedFrom: detLabel,
      };
      return { ...d, layers: [...d.layers, newLayer] };
    });
    setLastCopyUndo({ layerId: newLayerId, label: detLabel, prevSource: prevSrc, type: layerType as AnnotationCategory });
  }, [selectedAudio, customDetectors, customResults, detectorOutputDocs, activeSourceByType, setCueLayersDoc, setLastCopyUndo]);

  const handleCopyAlgoOverlay = useCallback((overlay: AlgoOverlay) => {
    if (!selectedAudio || overlay.sections.length === 0) return;

    // PATTERN family (LoCoMotif) copies into a RIFF layer, not spans: its
    // output is "the same figure, recurring", and only the riff model can say
    // that — one node per motif, one instance per occurrence. Needs a beat
    // grid, since a riff node's length is measured in beats; without one we
    // fall through to the ordinary span copy below.
    const songBpm = (songInfo?.bpm ?? 0) > 20 ? songInfo!.bpm : undefined;
    if (PATTERN_TOOL_IDS.has(baseAlgoId(overlay.id))) {
      const riffLayer = riffLayerFromMotifs(overlay.sections, songBpm, {
        name: overlay.label,
        layerColor: pickDefaultLayerColor(cueLayersDocRef.current?.layers ?? []),
        importedFrom: overlay.id,
      });
      if (riffLayer) {
        const prevRiffSrc = activeSourceByType['riff-patterns'];
        setCueLayersDoc((d) => (d ? { ...d, layers: [...d.layers, riffLayer] } : d));
        setLastCopyUndo({
          layerId: riffLayer.id,
          label: overlay.label,
          prevSource: prevRiffSrc,
          type: 'riff-patterns',
        });
        return;
      }
    }

    const isLyrics = new Set<string>(LYRICS_ALGO_IDS).has(baseAlgoId(overlay.id));
    const layerType: 'cues' | 'spans' | 'lyrics' = isLyrics ? 'lyrics' : overlay.renderKind === 'point' ? 'cues' : 'spans';
    const newLayerId = newId();
    const prevSrc = activeSourceByType[layerType === 'lyrics' ? 'lyrics' : layerType];
    setCueLayersDoc((d) => {
      if (!d) return d;
      const color = pickDefaultLayerColor(d.layers);
      let items: CueItem[] | SpanItem[] | LyricsItem[];
      if (layerType === 'lyrics') {
        items = overlay.sections.map((s) => ({
          id: newId(),
          time: s.time,
          end: s.endTime,
          text: s.label || s.type,
          kind: (s.type === 'word' ? 'word' : 'line') as 'word' | 'line',
        })) as LyricsItem[];
      } else if (layerType === 'cues') {
        items = overlay.sections.map((s) => ({ id: newId(), time: s.time, label: s.label || s.type, ...struckHitFields(s) })) as CueItem[];
      } else {
        items = overlay.sections.map((s) => ({ id: newId(), start: s.time, end: s.endTime, label: s.label || s.type })) as SpanItem[];
      }
      const newLayer: AnnotationLayer = {
        id: newLayerId,
        name: overlay.label,
        type: layerType,
        visible: true,
        color,
        snap: 'beat',
        items: items as never,
        source: 'user',
        importedFrom: overlay.id,
      };
      return { ...d, layers: [...d.layers, newLayer] };
    });
    setLastCopyUndo({ layerId: newLayerId, label: overlay.label, prevSource: prevSrc, type: layerType as AnnotationCategory });
  }, [selectedAudio, songInfo, activeSourceByType, setCueLayersDoc, setLastCopyUndo]);

  // ── Repairing one window of a transcription ───────────────────────────────
  // Algo Inspect's section re-run hands its words to one of two places. The
  // detector cache is handled by the sidecar (/api/lyrics/merge); a lyrics
  // LAYER is this document's business, so it is patched here. Both replace the
  // window and leave the rest of the take alone — the annotator judged that
  // stretch, not the song.
  const lyricsMergeTargets = useMemo(
    () => (cueLayersDoc?.layers ?? [])
      .filter((l) => l.type === 'lyrics')
      .map((l) => ({ id: l.id, name: l.name })),
    [cueLayersDoc],
  );

  const handleMergeLyricsWindowIntoLayer = useCallback((
    layerId: string,
    start: number,
    end: number,
    words: { time: number; end: number; text: string }[],
  ) => {
    setCueLayersDoc((d) => {
      if (!d) return d;
      return {
        ...d,
        layers: d.layers.map((l) => {
          if (l.id !== layerId || l.type !== 'lyrics') return l;
          const items = l.items as LyricsItem[];
          // A word overlapping the window belonged to the reading being
          // replaced, even if it starts just outside it.
          const kept = items.filter((it) => !((it.end ?? it.time) > start && it.time < end));
          const added: LyricsItem[] = words.map((w) => ({
            id: newId(), time: w.time, end: w.end, text: w.text, kind: 'word',
          }));
          const next = [...kept, ...added].sort(
            (a, b) => a.time - b.time || ((a.end ?? a.time) - (b.end ?? b.time)),
          );
          return { ...l, items: next } as AnnotationLayer;
        }),
      };
    });
  }, [setCueLayersDoc]);

  // A cache merge rewrote the detector's JSON on disk; re-read it so the algo
  // row and its lane show the repaired window without reloading the song.
  const handleLyricsCacheMerged = useCallback((algo: string, stem: string) => {
    const slug = selectedAudioRef.current?.id;
    if (!slug) return;
    const toolId = !stem || stem === 'mix' ? algo : `${algo}__${stem}`;
    void loadAlgoJson(slug, toolId).then((loaded) => {
      if (!loaded || selectedAudioRef.current?.id !== slug) return;
      const { result, error } = loaded;
      setToolStates((prev) => ({
        ...prev,
        [toolId]: error ? { status: 'error', result, error } : { status: 'done', result },
      }));
    });
  }, []);

  // Translate a (layerId, itemId) click on a detector layer back to the
  // (detectorName, reviewKey) pair that applyDetectorReview expects. layer.id
  // looks like `detector-{cue|span|loop|pattern}:${detName}`.
  const handleDetectorLayerReview = useCallback((
    layerId: string,
    itemId: string,
    status: DetectorReviewStatus,
  ) => {
    const match = layerId.match(/^detector-(?:cue|span|loop|pattern|lyrics):(.+)$/);
    if (!match) return;
    const detName = match[1];
    const colonIdx = itemId.indexOf(':');
    if (colonIdx < 0) return;
    const reviewKey = itemId.slice(colonIdx + 1);
    void applyDetectorReview(detName, reviewKey, status);
  }, [applyDetectorReview]);

  // Y / N accept or reject the detector suggestion the playhead is sitting in.
  // Accept/Reject were the highest-repetition action on the page and the only
  // way to reach them was the mouse: a detector layer can carry dozens of
  // suggestions, each with its own pair of 10px ✓/✗ buttons.
  //
  // Target = the item under the playhead in whichever detector layer the active
  // tab is pointed at. Spans/loops match when the playhead is inside
  // [start, end); cues match the nearest point within half a second. Nothing
  // matching is a no-op, so the key never touches a layer you can't see.
  const handleReviewDetectorAtPlayhead = useCallback((status: DetectorReviewStatus): boolean => {
    const type = activeAnnotationTypeRef.current;
    if (type === 'boundaries' || type === 'riff-patterns') return false;
    const layerId = selectedLayerIdByType[type];
    if (!layerId?.startsWith('detector-')) return false;

    const pool: AnnotationLayer[] =
      type === 'cues'     ? detectorCueLayers
      : type === 'spans'  ? detectorSpanLayers
      : type === 'loops'  ? detectorLoopLayers
      : type === 'lyrics' ? detectorLyricsLayers
      : [];
    const layer = pool.find((l) => l.id === layerId);
    if (!layer) return false;

    const t = playerTimeRef.current;
    const items = layer.items as Array<{ id: string; time?: number; start?: number; end?: number }>;
    let hit: { id: string } | undefined;
    if (type === 'cues') {
      // Points have no width — take the closest one, but only if the playhead
      // is actually near it, so a stray keypress can't review a distant cue.
      let best = Infinity;
      for (const it of items) {
        if (typeof it.time !== 'number') continue;
        const d = Math.abs(it.time - t);
        if (d < best) { best = d; hit = it; }
      }
      if (best > 0.5) hit = undefined;
    } else {
      hit = items.find((it) =>
        typeof it.start === 'number' && typeof it.end === 'number' && t >= it.start && t < it.end);
    }
    if (!hit) return false;

    handleDetectorLayerReview(layer.id, hit.id, status);
    return true;
  }, [
    selectedLayerIdByType, detectorCueLayers, detectorSpanLayers, detectorLoopLayers,
    detectorLyricsLayers, handleDetectorLayerReview,
  ]);
  useEffect(() => {
    reviewDetectorAtPlayheadRef.current = handleReviewDetectorAtPlayhead;
  }, [handleReviewDetectorAtPlayhead]);

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

  // If a loops top-level tab is active while its experimental flag is
  // off (e.g. user disabled the flag or restored session state from before the
  // flag existed), bounce back to Boundaries so we never render a hidden tab.
  useEffect(() => {
    const loopsGatedOff = activeAnnotationType === 'loops'
      && !settings.experimentalLoopsAndPatterns;
    if (loopsGatedOff) setActiveAnnotationType('boundaries');
  }, [activeAnnotationType, settings.experimentalLoopsAndPatterns]);

  // Snap gridOffset to the current playhead. Used by the SongInfoBar button
  // and by the Shift+G shortcut. Reads playerTime via ref so it can be bound
  // once into the shortcut config without re-binding on every tick.
  // ── Grid segments ─────────────────────────────────────────────────────────
  //
  // The song's ruler, divided. Each segment starts on its own bar 1, beat 1
  // with its own tempo and meter; the bar the previous one was in the middle
  // of is cut exactly where the next begins. Only the splits after the
  // opening are stored — the opening segment IS the song's gridOffset / bpm /
  // timeSignature, so those fields stay the single source of truth and every
  // existing reader of them keeps working.
  // Two views of the same map. `gridSegments` is the ACTIVE grid — it carries
  // splits only while Mapped is the mode in force — and is what every renderer
  // and every bar.beat conversion reads. `mapSegments` is the map as stored,
  // which is what the editors show and edit: a map you build stays intact on
  // disk while you look at the song in another mode.
  const gridSegments = useMemo(() => resolveGridSegments(songInfo), [songInfo]);
  const mapSegments = useMemo(() => resolveStoredGridSegments(songInfo), [songInfo]);
  // The lane is Mapped mode's editing surface, so it appears with the MODE
  // rather than with the second segment. The opening head is the song's own
  // downbeat — a song whose bar 1 isn't at 0:00 has something to drag there
  // before any split exists, and the sidebar list already shows row 1 from
  // the moment Mapped is picked.
  const gridMapActive = isMapMode(songInfo) && gridSegments.length > 0;
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const segmentPopover = useGridSegmentPopover();

  /** Write a new split list. Pinned beats are re-keyed across the change so a
   *  split never moves a beat the curator placed by hand. */
  const commitGridSegments = useCallback((nextStored: GridSegment[], patch?: Partial<SongInfo>, opts?: SetUndoableOptions) => {
    if (!selectedAudio) return;
    const base = songInfo ?? makeEmptySongInfo(selectedAudio.id);
    const merged: SongInfo = { ...base, ...patch };
    const normalized = normalizeGridSegments(nextStored, merged.gridOffset ?? 0);
    const before = resolveGridSegments(base);
    const after = resolveGridSegments({ ...merged, gridSegments: normalized });
    const nextOverrides = base.beatOverrides && Object.keys(base.beatOverrides).length > 0
      ? remapBeatOverrides(base.beatOverrides, before, after)
      : base.beatOverrides;
    handleSongInfoChange({
      ...merged,
      gridSegments: normalized,
      ...(nextOverrides ? { beatOverrides: nextOverrides } : {}),
      updated_at: new Date().toISOString(),
    }, opts);
  }, [selectedAudio, songInfo, handleSongInfoChange]);

  /** Start a new grid at `time`. It inherits the tempo and meter of the
   *  segment it splits, so the grid does not visibly jump until the curator
   *  changes something. */
  const handleSplitGridAt = useCallback((time: number) => {
    if (!selectedAudio || !songInfo) return;
    const t = Math.max(0, Math.round(time * 1000) / 1000);
    if (!canPlaceSegmentAt(mapSegments, t).ok) return;
    const parent = segmentAtTime(mapSegments, t);
    const next: GridSegment = {
      id: makeGridSegmentId(),
      start: t,
      bpm: parent?.bpm ?? songInfo.bpm ?? 120,
      timeSignature: parent?.timeSignature ?? songInfo.timeSignature,
    };
    commitGridSegments([...storedGridSegments(songInfo), next]);
    setSelectedSegmentId(next.id);
  }, [selectedAudio, songInfo, gridSegments, commitGridSegments]);

  /** Move a head. The opening segment's head is the song's downbeat, so it
   *  routes to gridOffset — the same value the Downbeat step edits. */
  const handleSegmentHeadDrag = useCallback((segment: ResolvedSegment, time: number) => {
    if (!songInfo) return;
    const t = Math.max(0, Math.round(time * 1000) / 1000);
    // The opening head plays by the origin's rules, not a split's: it has
    // nothing to come after, but it must not cross segment 2 — normalize()
    // drops every stored split at or before the offset, so dragging through
    // one would delete it in passing.
    if (!canMoveHeadTo(mapSegments, segment, t, duration).ok) return;
    const drag: SetUndoableOptions = { coalesceKey: `segment-head:${segment.id}` };
    if (segment.index === 0) {
      commitGridSegments(storedGridSegments(songInfo), { gridOffset: t }, drag);
      return;
    }
    commitGridSegments(
      storedGridSegments(songInfo).map((g) => (g.id === segment.id ? { ...g, start: t } : g)),
      undefined,
      drag,
    );
  }, [songInfo, gridSegments, commitGridSegments]);

  /** Merge a segment into the one before it. The stored head is dropped, so
   *  the earlier segment grows over the span and counts on at its own tempo
   *  and meter — the only thing lost is this segment's own count. The opening
   *  segment has nothing before it and is refused. */
  const handleMergeGridSegment = useCallback((segment: ResolvedSegment) => {
    if (!songInfo || segment.index === 0) return;
    commitGridSegments(storedGridSegments(songInfo).filter((g) => g.id !== segment.id));
    setSelectedSegmentId((cur) => (cur === segment.id ? null : cur));
  }, [songInfo, commitGridSegments]);

  /** Edit one segment's start / tempo / meter. Editing the opening segment
   *  writes the song's own fields, keeping the two in sync both ways.
   *
   *  `live` is a value still being typed: it lands on the grid immediately —
   *  a tempo is judged against the waveform, not against its own digits — but
   *  the whole run collapses to one undo step. A segment edit is a
   *  `gridSegments` change, which gridEditCoalesceKey deliberately refuses to
   *  coalesce (a split is not a keystroke), so the key is named here instead
   *  of inferred. */
  const handleSegmentPatch = useCallback((
    segment: ResolvedSegment,
    patch: { start?: number; bpm?: number; timeSignature?: string },
    opts?: { live?: boolean },
  ) => {
    if (!songInfo) return;
    const stored = storedGridSegments(songInfo);
    const undo: SetUndoableOptions | undefined = opts?.live
      ? { coalesceKey: `segment-edit:${segment.id}:${Object.keys(patch).join(',')}` }
      : undefined;
    if (segment.index === 0) {
      // Same guard the drag has: a typed downbeat past segment 2 would take
      // segment 2 with it.
      if (patch.start != null && !canPlaceOriginAt(mapSegments, patch.start, duration).ok) return;
      commitGridSegments(stored, {
        ...(patch.start != null ? { gridOffset: Math.max(0, patch.start) } : {}),
        ...(patch.bpm != null ? { bpm: patch.bpm } : {}),
        ...(patch.timeSignature ? { timeSignature: patch.timeSignature } : {}),
      }, undo);
      return;
    }
    if (patch.start != null && !canPlaceSegmentAt(mapSegments, patch.start, segment.id).ok) return;
    commitGridSegments(stored.map((g) => (g.id === segment.id ? {
      ...g,
      ...(patch.start != null ? { start: Math.max(0, patch.start) } : {}),
      ...(patch.bpm != null ? { bpm: patch.bpm } : {}),
      ...(patch.timeSignature ? { timeSignature: patch.timeSignature } : {}),
    } : g)), undefined, undo);
  }, [songInfo, gridSegments, commitGridSegments]);

  /** Reshaping the ruler is an admin job, and only in DataPrep. Everywhere
   *  else the segmented grid is read-only, exactly like BPM and meter. */
  const canEditGrid = feature === 'prep' && (adminStatus?.isAdmin || isDemo);

  /** Snap a head being dragged to the nearest beat of the grid it is cutting
   *  into — the OUTGOING segment, not the dragged one, because that is the
   *  grid the music is running on where the head is landing.
   *
   *  Only when snapping is actually on. A segment head is a marker like any
   *  other on this timeline, so it obeys the same Snap-to-grid switch (and
   *  Grid Lock, which implies it); with both off the head lands exactly where
   *  it was dropped — a section that starts a half-beat early is a real thing,
   *  and saying so is the whole point of a segment. Shift (read off the
   *  mousedown that started the drag, not a keyboard listener that can be left
   *  stuck) inverts whichever mode is current, so the other behaviour is
   *  always one key away. */
  const segmentSnapOn = snapToGrid || gridLock;
  const snapSegmentTime = useCallback((t: number, dragged: ResolvedSegment, shiftKey: boolean): number => {
    if (segmentSnapOn === shiftKey) return t;
    // Hand-placed pins are where the beat lines are actually drawn, so they are
    // what the head has to land on. Only in manual mode, matching every other
    // snap in the app.
    const overrides = effectiveGridMode(songInfo) === 'manual' ? songInfo?.beatOverrides : undefined;
    return snapSegmentHeadTime(mapSegments, t, dragged.id, overrides);
  }, [mapSegments, segmentSnapOn, songInfo]);

  const selectedSegment = useMemo(
    () => mapSegments.find((s) => s.id === selectedSegmentId) ?? null,
    [mapSegments, selectedSegmentId],
  );

  const handleAlignGridToPlayhead = useCallback(() => {
    if (!selectedAudio) return;
    const base = songInfo ?? makeEmptySongInfo(selectedAudio.id);
    const t = Math.max(0, Math.round(playerTimeRef.current * 1000) / 1000);
    handleSongInfoChange({ ...base, gridOffset: t, updated_at: new Date().toISOString() });
  }, [selectedAudio, songInfo, handleSongInfoChange]);
  useEffect(() => { alignGridToPlayheadRef.current = handleAlignGridToPlayhead; }, [handleAlignGridToPlayhead]);

  // Manual-mode beat drag. Writes a sparse override into
  // `SongInfo.beatOverrides[beatIndex]` so the dragged beat pins to its
  // new time without touching the base grid. Neighbours stay exactly
  // where the base grid (bpm + gridOffset, or the segment table) put them —
  // no segment-wide BPM rewrite, no butterfly effect.
  const handleBeatDrag = useCallback(async (_tOrig: number, tNew: number, beatIndex: number) => {
    if (!selectedAudio || !songInfo) return;
    if (!Number.isInteger(beatIndex)) return;
    const { updateManualBeatOverride } = await import('../utils/beatOverrideEdit');
    const nextOverrides = updateManualBeatOverride(songInfo, tNew, beatIndex);
    handleSongInfoChange({
      ...songInfo,
      beatOverrides: nextOverrides,
      gridMode: 'manual',
      updated_at: new Date().toISOString(),
    }, { coalesceKey: `beat-drag:${beatIndex}` });
  }, [selectedAudio, songInfo, handleSongInfoChange]);

  // Right-click on a pinned beat in the manual grid strip → drop the
  // override so that beat returns to its macro-grid position.
  const handleClearBeatOverride = useCallback(async (beatIndex: number) => {
    if (!selectedAudio || !songInfo) return;
    if (!Number.isInteger(beatIndex)) return;
    if (!songInfo.beatOverrides || songInfo.beatOverrides[String(beatIndex)] === undefined) return;
    const { clearBeatOverride } = await import('../utils/beatOverrideEdit');
    const nextOverrides = clearBeatOverride(songInfo.beatOverrides, beatIndex);
    handleSongInfoChange({
      ...songInfo,
      beatOverrides: nextOverrides,
      updated_at: new Date().toISOString(),
    });
  }, [selectedAudio, songInfo, handleSongInfoChange]);

  // Live-update grid offset during Alt-drag on the waveform. Also goes through
  // handleSongInfoChange so the debounced backend save kicks in once the user stops dragging.
  const handleGridOffsetDrag = useCallback((newOffset: number) => {
    if (!selectedAudio) return;
    const base = songInfo ?? makeEmptySongInfo(selectedAudio.id);
    handleSongInfoChange({
      ...base,
      gridOffset: Math.max(0, newOffset),
      updated_at: new Date().toISOString(),
    }, { coalesceKey: 'grid-offset-drag' });
  }, [selectedAudio, songInfo, handleSongInfoChange]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const bpm        = (songInfo?.bpm ?? 0) > 20 ? songInfo!.bpm : undefined;
  const beatOffset = songInfo?.gridOffset ?? 0;
  const beatsPerBar = beatsPerBarFromTimeSignature(songInfo?.timeSignature);

  // A riff instance's cycle IS its sequence: `end` is derived from `start` plus
  // whatever the sequence plays for, never a looser window around it. Enforced
  // here, once, rather than at each of the dozen places a sequence can change
  // (both sidebar panels, both popovers, the canvas resize handle, a node or
  // combo deleted out from under an instance) — an invariant maintained in one
  // place can't be forgotten at the thirteenth call site.
  //
  // `skipHistory` keeps the fit out of the undo stack: it is the tail of the
  // edit that caused it, not an edit of its own, so ⌘Z should step back over
  // both at once. Refitting is a fixed point, so this settles in one pass.
  // Held off while the song's edit lease is somebody else's: the fit would be
  // a document write this viewer never asked for, and the save effect below
  // would answer it by raising the lock bar on a song they only opened to read.
  useEffect(() => {
    if (!cueLayersDoc || !bpm || !annotationLock.canEdit) return;
    const fitted = withFittedRiffInstances(cueLayersDoc, bpm);
    if (fitted !== cueLayersDoc) setCueLayersDoc(fitted, { skipHistory: true });
  }, [cueLayersDoc, bpm, annotationLock.canEdit, setCueLayersDoc]);

  // The curator's own reference reading of the structure — the first boundary
  // layer, which is the one the canvas draws at the top. Every read-only
  // consumer (eval tables, algo overlays, the inspect canvas) wants one
  // reading per annotator, not a merge of every layer they drew.
  const manualSections = useMemo<SectionBlock[]>(
    () => [...(boundaryLayersList[0]?.items ?? [])].sort((a, b) => a.time - b.time),
    [boundaryLayersList],
  );
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
          layers: Record<string, AnnotationLayersDocument>;
          autoGuess: Record<string, AutoGuessManualAnnotation>;
        }>;
      })
      .then((data) => {
        if (!alive) return;
        if (selectedAudioRef.current?.id !== slug) return;
        setExternalRefData({
          // Their reference reading, same rule as our own `manualSections`.
          manual: primaryBoundaryItems(data.layers[targetId] ?? null),
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
  const refManualSections: SectionBlock[] = useExternalRef
    ? externalRefData!.manual
    : manualSections;
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

  // Apply min-agreement threshold filter for the viz. Counts distinct
  // algorithms, not cluster members, so the ≥2 / ≥3 / ≥4 chips mean the same
  // thing here, in the Auto-guess panel, and in Consensus Inspect.
  const displayAutoGuessPoints = useMemo(
    () => baseAutoGuessPoints.filter((p) => agreementCount(p) >= minConsensus),
    [baseAutoGuessPoints, minConsensus],
  );

  // Auto-guess is shown via the Annotations dropdown's dedicated layer toggle,
  // so it's intentionally absent from the algo overlay list to avoid a
  // duplicate row on the canvas.
  const algoOverlays = useMemo(() => {
    return annotationRows
      .filter((r) => gateAlgoOverlay(r.id, selectedAlgoOverlays, inspectStemFilter) === 'shown')
      .map((r) => ({ id: r.id, label: r.label, labelColor: algoLabelColor(r.id), renderKind: algoRenderKind(r.id), sections: r.sections, info: algoInfoFor(r.id), gridSource: r.gridSource }));
  }, [annotationRows, selectedAlgoOverlays, algoLabelColor, inspectStemFilter]);

  const algoCopyCounts = useMemo<Record<string, number>>(() => {
    const overlayIds = new Set(algoOverlays.map((o) => o.id));
    const counts: Record<string, number> = {};
    for (const layer of cueLayersDoc?.layers ?? []) {
      if (layer.importedFrom && overlayIds.has(layer.importedFrom)) {
        counts[layer.importedFrom] = (counts[layer.importedFrom] ?? 0) + 1;
      }
    }
    return counts;
  }, [cueLayersDoc?.layers, algoOverlays]);

  // ── Boundary merge ─────────────────────────────────────────────────────
  // Members are named by overlay id, so a lane that stops being visible (its
  // family chip switched off, the stem filter narrowed) silently drops out of
  // the blend and rejoins when it comes back — the merge can never be fed by a
  // lane the annotator can't see next to it.
  const mergeLanes = useMemo<MergeSourceLane[]>(() => {
    const byId = new Map(algoOverlays.map((o) => [o.id, o]));
    return mergeMemberIds.flatMap((id) => {
      const o = byId.get(id);
      if (!o || (o.renderKind ?? 'boundary') !== 'boundary') return [];
      return [{
        id: o.id,
        label: o.label,
        color: o.labelColor ?? '#94a3b8',
        times: o.sections.map((s) => s.time),
      }];
    });
  }, [algoOverlays, mergeMemberIds]);

  const mergeBoundaries = useMemo(
    () => mergeBoundaryLanes(mergeLanes, mergeDropped),
    [mergeLanes, mergeDropped],
  );

  const handleMergeAddLane = useCallback((overlayId: string) => {
    setMergeMemberIds((prev) => (prev.includes(overlayId) ? prev : [...prev, overlayId]));
  }, []);

  const handleMergeRemoveLane = useCallback((overlayId: string) => {
    setMergeMemberIds((prev) => prev.filter((id) => id !== overlayId));
  }, []);

  const handleMergeClear = useCallback(() => {
    setMergeMemberIds([]);
    setMergeDropped([]);
  }, []);

  const handleMergeToggleBoundary = useCallback((b: MergedBoundary) => {
    setMergeDropped((prev) => toggleMergeDropped(prev, b));
  }, []);

  // Removing a lane can leave a drop pointing at a boundary that no longer
  // exists. Harmless — a drop with nothing at that instant simply never
  // applies — but it would quietly bite again if that lane rejoined, so the
  // bar's "N dropped" counter only ever counts drops that are currently
  // taking a boundary off the lane.
  const handleMergeRestoreDropped = useCallback(() => setMergeDropped([]), []);

  // ── Remembering the merge across reloads ───────────────────────────────
  // Load first: this effect is declared before the save effect, so on a song
  // change it sets the id ref before anything can write. The save effect keys
  // off `mergeMemberIds` / `mergeDropped` alone, which do not change until the
  // render AFTER this one — by which time the ref names the right song.
  useEffect(() => {
    const id = selectedAudio?.id ?? null;
    if (mergeSongIdRef.current === id) return;
    mergeSongIdRef.current = id;
    const stored = id ? readMergeState(id) : null;
    setMergeMemberIds(stored?.memberIds ?? []);
    setMergeDropped(stored?.dropped ?? []);
    // Bring the member LANES back on too. The blend is fed by the overlays
    // currently drawn (see `mergeLanes`), so restoring only the member ids
    // would restore a merge that renders as nothing until you re-tick the same
    // detectors by hand — the row would look as empty as if nothing had been
    // remembered. A lane you deliberately switch off still drops out of the
    // blend; this is only about putting back what the reload took away.
    if (stored?.memberIds.length) {
      setSelectedAlgoOverlays((prev) => {
        const next = new Set(prev);
        for (const memberId of stored.memberIds) next.add(baseAlgoId(memberId));
        return next;
      });
    }
  }, [selectedAudio?.id]);

  useEffect(() => {
    const id = mergeSongIdRef.current;
    if (!id) return;
    writeMergeState(id, { memberIds: mergeMemberIds, dropped: mergeDropped });
  }, [mergeMemberIds, mergeDropped]);

  // The merge's name is what marks the layer as coming from this blend, so the
  // "already committed" count is read back off the document rather than
  // tallied in state — an undone commit stops counting, as it should.
  const mergeLayerLabel = useMemo(() => mergeLayerName(mergeLanes), [mergeLanes]);
  const mergeCommittedCount = useMemo(
    () => (cueLayersDoc?.layers ?? []).filter((l) => l.importedFrom === mergeLayerLabel).length,
    [cueLayersDoc?.layers, mergeLayerLabel],
  );

  // Said once, right by the button, and cleared on the next commit. See
  // MergeControlsBar's `committedNote`.
  const [mergeCommitNote, setMergeCommitNote] = useState<string | null>(null);

  const handleMergeCommit = useCallback(() => {
    const layerId = copyBoundarySectionsToNewLayer(mergedToSectionBlocks(mergeBoundaries), mergeLayerLabel);
    if (!layerId) return;
    setMergeCommitNote(isInspect(feature)
      ? '⤴ Saved to your annotations — open the Annotator Tool to see it.'
      : null);
    // Committing IS the approval: the blend stops being a proposal and becomes
    // a boundary layer in the annotator's own folder — the one the lol agent
    // reads. Which is also why it doesn't appear on this canvas: Algorithm
    // Inspect shows what the detectors said, and this is now your annotation.
    // In the Annotator Tool, where it does belong, put the group on.
    if (!isInspect(feature)) setShowManual(true);
  }, [copyBoundarySectionsToNewLayer, feature, mergeBoundaries, mergeLayerLabel]);

  // ── Copying the consensus into an annotation ──────────────────────────────
  // The blend is a proposal, not an annotation: it has no items to edit and
  // vanishes with the stage that computed it. The ⬇ on its lane is how it
  // becomes something the annotator owns — a plain boundary layer, sections
  // untyped, no link back. Same treatment the detector and algorithm lanes
  // already get, and the same tiling the Merge row commits, so a consensus and
  // a merge land as the same kind of object.
  const consensusCopyCount = useMemo(
    () => (cueLayersDoc?.layers ?? []).filter((l) => l.importedFrom === CONSENSUS_LAYER_LABEL).length,
    [cueLayersDoc?.layers],
  );
  const handleCopyConsensus = useCallback(() => {
    const blocks = consensusViz?.blocks ?? [];
    if (blocks.length === 0) return;
    // Tile from the boundary TIMES only. The lane's blocks carry a per-tile
    // verdict ('hit' / 'miss') against whatever reference is loaded, and that
    // is a score, not a section type — copying it in would put the reference's
    // opinion into the annotator's own layer.
    const layerId = copyBoundarySectionsToNewLayer(
      boundaryTimesToSectionBlocks(blocks.map((b) => b.time)),
      CONSENSUS_LAYER_LABEL,
    );
    if (!layerId) return;
    // Same as the Merge commit above: the copy is the approval, and what it
    // produces is an annotation, so it shows up in the Annotator Tool rather
    // than on this canvas.
    if (!isInspect(feature)) setShowManual(true);
  }, [consensusViz, copyBoundarySectionsToNewLayer, feature]);

  // Snap the stem filter back to 'all' when the chosen stem has no rows (e.g.
  // after switching to a song that was never split, or whose per-stem results
  // aren't cached) — otherwise the filter would silently hide every overlay
  // with no visible control to clear it (its chip row is gated on stem rows).
  useEffect(() => {
    if (inspectStemFilter === 'all' || inspectStemFilter === 'mix') return;
    const has = annotationRows.some((r) => {
      const i = r.id.indexOf('__');
      return i !== -1 && r.id.slice(i + 2) === inspectStemFilter;
    });
    if (!has) setInspectStemFilter('mix');
  }, [annotationRows, inspectStemFilter]);

  // The Algos picker lists every cached row, stem variants included, and is
  // deliberately NOT narrowed by the stem filter — hiding a row from the list
  // that the filter is hiding from the canvas would just move the mystery.
  // Instead each row carries the stem that is vetoing it, so a ticked checkbox
  // that draws nothing can say so where the tick was made.
  const algoOptions = useMemo(() => {
    return annotationRows.map((r) => ({
      id: r.id,
      label: r.label,
      hiddenByStemFilter:
        selectedAlgoOverlays.has(r.id)
        && gateAlgoOverlay(r.id, selectedAlgoOverlays, inspectStemFilter) === 'filtered'
          ? String(inspectStemFilter)
          : undefined,
    }));
  }, [annotationRows, selectedAlgoOverlays, inspectStemFilter]);

  // Summary for the picker's banner and the toolbar badge: how many rows the
  // user ticked by name are currently vetoed by the stem filter.
  const algoStemFilterHiddenCount = useMemo(
    () => algoOptions.filter((o) => o.hiddenByStemFilter).length,
    [algoOptions],
  );

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
    if (cueLayersDoc === cueLayersJustLoadedRef.current) {
      lastSavedLayersDocRef.current = cueLayersDoc;
      return;
    }
    // Guard against a stale doc mid-song-switch: `selectedAudio` updates
    // synchronously but `cueLayersDoc` lags until loadLayers resolves, so
    // without this the previous song's doc is written under the new slug —
    // this leaked empty docs across songs (filename ≠ doc.song). Mirrors the
    // same guard on the summary-sync effect below.
    if (cueLayersDoc.song !== selectedAudio.id) return;
    const slug = selectedAudio.id;
    // Shared song this annotator doesn't hold: the server would refuse the
    // write anyway (409), so don't fire it — but DO say so, loudly, via the
    // lock bar. A change that vanishes at save time with no explanation is the
    // worst outcome a lock can produce.
    if (!annotationLock.canEdit) {
      pendingLayersDocRef.current = null;
      setLayersDocSaveStatus('idle');
      setBlockedByLock(true);
      return;
    }
    pendingLayersDocRef.current = { slug, doc: cueLayersDoc };
    setLayersDocSaveStatus('saving');
    const t = setTimeout(async () => {
      // Persist both coordinates: seconds (canonical) and the musical position
      // they fall on. Stamped here rather than in state so the beat never
      // enters the undo history and can't re-trigger this effect.
      const ok = await saveLayers(slug, withStampedBeats(cueLayersDoc, gridOf(songInfoRef.current)));
      if (ok) lastSavedLayersDocRef.current = cueLayersDoc;
      setLayersDocSaveStatus(ok ? 'saved' : 'error');
      setTimeout(() => setLayersDocSaveStatus((s) => (s === 'saved' ? 'idle' : s)), 2000);
    }, 600);
    return () => clearTimeout(t);
  }, [cueLayersDoc, selectedAudio, annotationLock.canEdit]);

  // Flush a pending layers-doc save synchronously — otherwise an edit made
  // inside the 600ms debounce window above (e.g. copying a detector's output
  // into a new manual layer) is silently lost. Covers the two ways that can
  // happen: (1) SPA-level unmount/song-switch, mirroring ManualEditorPanel's
  // analogous flush-on-unmount effect; (2) an actual browser reload/tab close,
  // which never runs React's unmount cleanup, so `pagehide` is the one signal
  // that fires in time. Only this flush passes `keepalive: true` so the
  // request survives the page going away — the routine debounced save above
  // must NOT set it, since Chromium caps keepalive fetch bodies at ~64KiB and
  // was silently dropping normal saves once a copied algorithm-output layer
  // pushed the document over that limit.
  useEffect(() => {
    const flush = () => {
      const pending = pendingLayersDocRef.current;
      if (!pending || pending.doc === lastSavedLayersDocRef.current) return;
      void saveLayers(
        pending.slug,
        withStampedBeats(pending.doc, gridOf(songInfoRef.current)),
        { keepalive: true },
      );
      lastSavedLayersDocRef.current = pending.doc;
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [selectedAudio?.id]);

  // Keep the sidebar's per-song layer summary (counts + per-type status) in
  // lockstep with the live cue-layers doc — synchronously, NOT gated on the
  // debounced save above — so flipping a layer's status pill (or adding /
  // removing items) updates the song-list indicator at once. Mirrors the
  // boundary status sync effect, and derives the same shape the backend LIST
  // endpoint returns so the current song's entry matches its siblings'.
  // Guarded on `doc.song` so a stale doc mid-song-switch can't wipe or
  // cross-write another song's summary before its own doc has loaded.
  useEffect(() => {
    if (!selectedAudio || !cueLayersDoc || cueLayersDoc.song !== selectedAudio.id) return;
    const slug = selectedAudio.id;
    setSongLayerStatuses((prev) => {
      const layers: SongLayerStatuses['layers'] = {};
      for (const l of cueLayersDoc.layers) {
        // EVERY layer type the document can hold, including `boundaries` and
        // `riff-patterns` — the LIST endpoint's summarizeDoc() counts those
        // two, so leaving them out here made the popover LOSE rows the moment
        // the song was selected (a song with a Boundaries layer and three
        // riff layers read "3/4 reviewed" instead of "5/6").
        const entry = layers[l.type] ?? { count: 0, status: 'in_progress' as const };
        entry.count += l.items.length;
        layers[l.type] = entry;
      }
      for (const t of Object.keys(layers) as Array<keyof SongLayerStatuses['layers']>) {
        const stage = cueLayersDoc.statusByType?.[t];
        if (stage) layers[t]!.status = stage;
      }
      const hasAny = Object.keys(layers).length > 0;
      const next = { ...prev };
      if (hasAny) next[slug] = { slug, layers };
      else delete next[slug];
      return next;
    });
  }, [cueLayersDoc, selectedAudio]);

  // "Mark all reviewed" from the song-list status popover.
  //
  // The editor's StatusPill flips ONE layer type at a time, which is right
  // while annotating and wrong the moment a curator finishes a song: six
  // types means six trips through six panels. This flips every type the
  // popover is showing — i.e. exactly the types that have items, since a
  // type with none never gets a row — in one click.
  //
  // Two paths, because the open song is not just another row: it has a live
  // document that the debounced save owns. Writing its file behind its back
  // would be overwritten by the next autosave (and bypass the edit lease), so
  // the open song goes through `setCueLayersDoc` and every other song takes a
  // load-modify-save round trip against its own file.
  const [markingAllSlug, setMarkingAllSlug] = useState<string | null>(null);
  const [markAllError, setMarkAllError] = useState<{ slug: string; message: string } | null>(null);
  const markAllTypesReviewed = useCallback(async (slug: string, types: AnnotationLayerType[]) => {
    if (types.length === 0 || markingAllSlug) return;
    setMarkAllError(null);
    const flip = (doc: AnnotationLayersDocument) =>
      types.reduce((acc, t) => setLayerStatus(acc, t, 'reviewed'), doc);

    const live = cueLayersDocRef.current;
    if (selectedAudio?.id === slug && live && live.song === slug) {
      if (!annotationLock.canEdit) {
        setMarkAllError({ slug, message: 'Read-only — take the edit lock first.' });
        return;
      }
      // skipHistory, like the pill in BoundaryEditorPanel: a workflow-status
      // flip is not an edit the undo stack should step back through.
      setCueLayersDoc(flip(live), { skipHistory: true });
      return;
    }

    setMarkingAllSlug(slug);
    try {
      const doc = await loadLayers(slug);
      if (doc.layers.length === 0) {
        setMarkAllError({ slug, message: 'No layers document to update.' });
        return;
      }
      const ok = await saveLayers(slug, flip(doc));
      if (!ok) {
        setMarkAllError({ slug, message: 'Save refused — the song may be locked by someone else.' });
        // Re-read rather than leave the sidebar showing a state the file
        // doesn't have.
        loadAllLayerStatuses().then(setSongLayerStatuses).catch(() => null);
        return;
      }
      setSongLayerStatuses((prev) => {
        const entry = prev[slug];
        if (!entry) return prev;
        const layers: SongLayerStatuses['layers'] = {};
        for (const [t, info] of Object.entries(entry.layers)) {
          if (!info) continue;
          layers[t as AnnotationLayerType] = types.includes(t as AnnotationLayerType)
            ? { ...info, status: 'reviewed' }
            : info;
        }
        return { ...prev, [slug]: { slug, layers } };
      });
    } finally {
      setMarkingAllSlug(null);
    }
  }, [markingAllSlug, selectedAudio?.id, annotationLock.canEdit, setCueLayersDoc]);

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
  const riffPatternLayers = useMemo(
    () => cueLayersDoc?.layers.filter((l): l is AnnotationLayer<'riff-patterns'> => l.type === 'riff-patterns') ?? [],
    [cueLayersDoc],
  );

  // Sentinel option id for "+ New Riff Layer" in the cross-layer node picker.
  const NEW_RIFF_LAYER_ID = '__new_riff_layer__';
  // Prefix marking a cross-layer pick as "build a boundary node, not a grid
  // one" — see handleGenerateRiffNodeFromSelection.
  const RIFF_BOUNDARY_PICK_PREFIX = 'boundary:';
  // Cues (onset layer) → Riff Patterns escape hatch: turn a dragged selection
  // into a new RiffNode without leaving the Cues tab. Sizes the node from the
  // selection's exact duration in beats — same beats-from-bpm math
  // RiffPatternEditorPanel's own "New Node (from selection)" uses — and drops
  // it into whichever riff-patterns layer the user picked (or a fresh one).
  // Onsets from the source cues layer (manual or detector, e.g. librosa
  // onsets) that fall inside the selection seed the node's beat-chip grid
  // directly: each onset's position within the selection maps to the nearest
  // grid step and comes up already ON, so the generated node reproduces the
  // onset rhythm instead of an empty pattern. The grid's own resolution is
  // inferred from the onsets' spacing rather than hardcoded to sixteenths —
  // a bar of onsets that only land on beats fits a 1-per-beat grid, one with
  // off-beat hits needs 2, one with sixteenth-note hits needs 4, etc.
  // A node alone has no timeline placement (nodes are pure library
  // primitives), so alongside the node this also creates a RiffPatternItem
  // instance spanning the exact same selected timeframe, with the new node
  // as its sole sequence entry — the node is immediately audible/visible on
  // the timeline instead of sitting unplaced in the layer's node library.
  const handleGenerateRiffNodeFromSelection = useCallback((pickedId: string) => {
    // The menu offers each riff layer twice: once plainly (a grid node, the
    // original behaviour) and once under a `boundary:` prefix, which builds a
    // BOUNDARY node instead — same onsets, but kept at their exact fractional
    // beat positions as `[start, end)` blocks rather than rounded onto an
    // inferred subdivision. The grid path guesses a subdivision with
    // `bestFitOnsetSubdivision`, and when that guess is wrong every hit lands
    // on the wrong step and the node's karaoke sweep visibly drifts from the
    // audio; the boundary path has no guess to get wrong.
    const asBlocks = pickedId.startsWith(RIFF_BOUNDARY_PICK_PREFIX);
    const targetLayerId = asBlocks ? pickedId.slice(RIFF_BOUNDARY_PICK_PREFIX.length) : pickedId;
    const pending = effectiveAnnotationSelectionRef.current;
    if (!pending || pending.t2 == null) return;
    const selStart = Math.min(pending.t1, pending.t2);
    const selEnd = Math.max(pending.t1, pending.t2);
    const durationSec = selEnd - selStart;

    // Anchor the pattern's beat-0 to the nearest true beat on the song's
    // grid rather than the raw drag start — a drag almost never lands
    // exactly on a beat, and using it as beat 0 skews every onset's
    // fractional beat position by that same phase offset. That throws off
    // bestFitOnsetSubdivision, which "explains" the constant offset by
    // picking a too-fine subdivision (e.g. sixteenth triplets for a plain
    // on-beat rhythm) instead of the real one, and the resulting grid ends
    // up visibly out of sync with the actual onsets. The instance is placed
    // at this anchored time too so playback lines up with what the grid
    // shows.
    const anchoredStart = bpm
      ? snapTimeToGrid(selStart, bpm, beatOffset, beatsPerBar, 'beat')
      : selStart;
    const anchoredEnd = anchoredStart + durationSec;

    const existingLayer = riffPatternLayers.find((l) => l.id === targetLayerId) ?? null;
    const isNewLayer = !existingLayer;
    const layer = existingLayer
      ?? newRiffPatternLayer(`Riff Patterns ${riffPatternLayers.length + 1}`, pickDefaultLayerColor(cueLayersDoc?.layers ?? []));

    const allRiffNodes = riffPatternLayers.flatMap((l) => l.nodes ?? []);
    const nodeName = `${asBlocks ? 'Blocks' : 'Node'} ${(layer.nodes?.length ?? 0) + 1}`;
    const nodeColor = pickRiffNodeColor(allRiffNodes);
    let node = asBlocks
      ? newRiffBoundaryNode(nodeName, nodeColor)
      : newRiffNode(nodeName, nodeColor);
    // Measured on the song's actual beat grid (via beatPositionAt) rather than
    // a flat `durationSec * bpm/60` — a song in Dynamic/Manual grid mode can
    // have a tempo anchor land inside the selection, and a constant-bpm
    // conversion would silently drift from the true grid past that point,
    // reintroducing the same false-fine-subdivision failure the anchoredStart
    // snap above was meant to fix.
    const startBeatPos = bpm ? beatPositionAt(anchoredStart, bpm, beatOffset) : null;
    const beats = bpm && startBeatPos != null
      ? beatPositionAt(anchoredEnd, bpm, beatOffset) - startBeatPos
      : null;
    if (beats != null && beats > 0) {
      const sourceLayer = [...(cueLayers ?? []), ...detectorCueLayers]
        .find((l) => l.id === selectedLayerIdByType.cues) ?? null;
      // Filter against the *anchored* span, not the raw drag [selStart,
      // selEnd] — anchoredStart/anchoredEnd can sit up to half a beat off
      // the drag because of the nearest-beat snap above. An onset inside the
      // drag but outside the anchored span maps to a beat position <0 or
      // >beats, which normalizePatternAccents silently drops as out of
      // range — the onset was detected correctly, it just never made it
      // into the node.
      const onsetBeats = (sourceLayer?.items ?? [])
        .filter((it) => it.time >= anchoredStart && it.time <= anchoredEnd)
        .map((it) => beatPositionAt(it.time, bpm!, beatOffset) - startBeatPos!);

      if (asBlocks) {
        // No subdivision is inferred at all. Length still lands on the
        // sequence's own quarter-beat step grid (every placement does), so
        // the blocks are tiled against that resolved length rather than the
        // raw fractional selection — otherwise the last block would overrun
        // or fall short of the node's actual end by up to a sixteenth.
        node = { ...node, ...resizeBoundaryNodeLength(node, beats) };
        // Each onset opens a block that lasts as long as the sound does,
        // measured off the mix's loudness across the same span — not a flat
        // beat apiece, which is the one thing a node built "as blocks (no
        // grid)" was asked not to do.
        const nodeBeats = riffNodeLengthBeats(node);
        const hits = withMeasuredEnds(
          onsetBeats.map((beat) => ({ beat })),
          levelCurveForSpan(anchoredStart, anchoredEnd, nodeBeats),
          nodeBeats,
        );
        node = { ...node, segments: boundarySegmentsFromHits(hits, nodeBeats) };
      } else {
        const subbeatsPerBeat = onsetBeats.length > 0 ? bestFitOnsetSubdivision(onsetBeats) : node.subbeatsPerBeat;
        node = { ...node, subbeatsPerBeat, ...resizeRiffNodeLength({ ...node, subbeatsPerBeat }, beats) };

        if (onsetBeats.length > 0) {
          const onsetSteps = onsetBeats.map((b) => Math.round(b * subbeatsPerBeat));
          node = { ...node, ...normalizePatternAccents(onsetSteps, node.spans, node.stepsPerCycle) };
        }
      }
    }

    const instance = {
      ...newRiffPatternItem(anchoredStart, anchoredEnd, `Instance ${(layer.items?.length ?? 0) + 1}`),
      sequence: [newRiffSeqEntry(node.id, nodeEntryLengthSteps(node))],
    };

    setCueLayersDoc((d) => {
      if (!d) return d;
      const nodes = [...(layer.nodes ?? []), node];
      const items = [...(layer.items ?? []), instance];
      return {
        ...d,
        layers: isNewLayer
          ? [...d.layers, { ...layer, nodes, items }]
          : d.layers.map((l) => (l.id === layer.id ? { ...l, nodes, items } : l)),
      };
    });

    setSelectedRiffPatternLayerId(layer.id);
    setPendingAnnotationSelection(null);
    if (previewRegionRef.current) handlePreviewDismiss();
    setFocusedRiffPattern({ layerId: layer.id, itemId: instance.id });
    setNodePopoverEntryCtx(null);
    nodePopover.openAt(layer.id, node.id);
  }, [riffPatternLayers, cueLayersDoc, bpm, beatOffset, beatsPerBar, songInfo, cueLayers, detectorCueLayers, selectedLayerIdByType, setCueLayersDoc, handlePreviewDismiss, nodePopover, setFocusedRiffPattern]);

  // Opens the "⚡ Energy" popover for the current pending selection, anchored
  // at the triggering click — available on every tab with a dragged region,
  // not just Cues (unlike the Riff Node escape hatch above).
  const handleOpenEnergySpanExport = useCallback((anchor: { x: number; y: number }) => {
    const pending = effectiveAnnotationSelectionRef.current;
    if (!pending || pending.t2 == null) return;
    setEnergySpanRange({ start: Math.min(pending.t1, pending.t2), end: Math.max(pending.t1, pending.t2) });
    setEnergySpanTargetLayerId(null);
    energySpanPopover.openAt('energy-span', 'selection', anchor);
  }, [energySpanPopover]);

  // The energies lane's own "+ ADD". That lane exists to hold ⚡ Energy
  // exports and nothing else, so adding to it has to mean "measure the energy
  // here" — a blank span filed in it is an item the downstream consumer reads
  // as an energy export and finds no measurement inside. Same popover the
  // pill's ⚡ ENERGY opens, over the highlighted region when there is one and
  // a default-length window at the playhead otherwise, which is the rule
  // "+ Add span" already follows.
  const handleOpenEnergySpanExportForLayer = useCallback((
    layerId: string,
    anchor: { x: number; y: number },
  ) => {
    const pending = effectiveAnnotationSelectionRef.current;
    let start: number;
    let end: number;
    if (pending && pending.t2 != null) {
      start = Math.min(pending.t1, pending.t2);
      end = Math.max(pending.t1, pending.t2);
    } else {
      start = liveSongTime() ?? 0;
      end = start + (bpm ? (60 / bpm) * beatsPerBar : 2);
      if (duration > 0 && end > duration) end = duration;
    }
    if (end - start < 0.05) return;
    setSelectedSpanLayerId(layerId);
    setEnergySpanRange({ start, end });
    setEnergySpanTargetLayerId(layerId);
    energySpanPopover.openAt('energy-span', layerId, anchor);
  }, [energySpanPopover, liveSongTime, bpm, beatsPerBar, duration]);

  // Saves a computed energy-span export as a new Span item — label carries a
  // short human tag, description carries the full JSON (curve, trend, etc.)
  // for an external consumer to read via the normal Span export flow.
  const handleSaveEnergySpanToLayer = useCallback((targetLayerId: string, exportData: EnergySpanExport) => {
    const isSentinel = targetLayerId === NEW_ENERGY_SPAN_LAYER_ID || targetLayerId === NEW_SPAN_LAYER_ID;
    const existingLayer = isSentinel
      ? null
      : spanLayers.find((l) => l.id === targetLayerId) ?? null;
    const isNewLayer = !existingLayer;
    const layer = existingLayer
      ?? newSpanLayer(
        // The energies sentinel names the lane after what lands in it, so the
        // song's first export creates "energies" however many unrelated span
        // lanes it already has; "+ New Span Layer" keeps generic numbering.
        targetLayerId === NEW_ENERGY_SPAN_LAYER_ID
          ? ENERGY_SPAN_LAYER_NAME
          : `Spans ${spanLayers.length + 1}`,
        pickDefaultLayerColor(cueLayersDoc?.layers ?? []),
      );

    const item = newSpanItem(
      exportData.start_ms / 1000,
      exportData.end_ms / 1000,
      energySpanLabel(exportData),
      JSON.stringify(exportData, null, 2),
    );

    setCueLayersDoc((d) => {
      if (!d) return d;
      const items = [...(layer.items ?? []), item];
      return {
        ...d,
        layers: isNewLayer
          ? [...d.layers, { ...layer, items }]
          : d.layers.map((l) => (l.id === layer.id ? { ...l, items } : l)),
      };
    });

    setSelectedSpanLayerId(layer.id);
    energySpanPopover.close();
    setEnergySpanRange(null);
    setPendingAnnotationSelection(null);
    if (previewRegionRef.current) handlePreviewDismiss();
  }, [spanLayers, cueLayersDoc, setCueLayersDoc, energySpanPopover, handlePreviewDismiss]);

  const lyricsLayers = useMemo(
    () => cueLayersDoc?.layers.filter((l): l is AnnotationLayer<'lyrics'> => l.type === 'lyrics') ?? [],
    [cueLayersDoc],
  );
  // Explicit pick from the Karaoke panel's layer dropdown. It outranks every
  // implicit rule below, but only until the user clicks a different lyrics
  // word — clicking a word is the older, just-as-explicit way to steer this
  // panel, so it lifts the pin rather than being silently ignored.
  const [karaokeLayerOverride, setKaraokeLayerOverride] = useState<string | null>(null);
  const karaokeFocusKey = focusedLyrics ? `${focusedLyrics.layerId}:${focusedLyrics.itemId}` : null;
  const karaokePinFocusRef = useRef<string | null>(null);
  const handleKaraokeLayerPick = useCallback((layerId: string) => {
    karaokePinFocusRef.current = karaokeFocusKey;
    setKaraokeLayerOverride(layerId);
    // Reading a layer here is only useful if the rest of the workspace agrees:
    // the picked layer becomes the selected one (timeline row + the editor
    // below), and a layer that was toggled off the canvas is brought back —
    // otherwise you'd be singing along to a row you can't see.
    const layer = [...lyricsLayers, ...detectorLyricsLayers].find((l) => l.id === layerId);
    if (!layer) return;
    const source = layer.source?.startsWith('detector:') ? layer.source : null;
    if (source) {
      const detectorName = source.slice('detector:'.length);
      setHiddenCustomAnnotations((prev) => {
        if (!prev.has(detectorName)) return prev;
        const next = new Set(prev);
        next.delete(detectorName);
        return next;
      });
    } else if (isInspect(feature)) {
      setVisibleAnnotationsInspect((prev) => (prev.has(layerId) ? prev : new Set(prev).add(layerId)));
    } else if (!layer.visible) {
      setCueLayersDoc((d) => d && ({
        ...d,
        layers: d.layers.map((l) => (l.id === layerId ? { ...l, visible: true } : l)),
      }), { skipHistory: true });
    }
    handleUnifiedSelectLayer('lyrics', {
      id: layerId,
      sourceId: (source ?? 'manual') as SourceId,
      name: layer.name,
      readOnly: layer.readOnly === true,
    });
  }, [karaokeFocusKey, feature, lyricsLayers, detectorLyricsLayers, handleUnifiedSelectLayer, setCueLayersDoc]);
  useEffect(() => {
    if (karaokeLayerOverride && karaokeFocusKey !== karaokePinFocusRef.current) {
      setKaraokeLayerOverride(null);
    }
  }, [karaokeFocusKey, karaokeLayerOverride]);
  // The lyrics layer the Karaoke panel follows: the pinned one, else the
  // focused one, else the selected one, else the first visible layer that
  // actually has words. `options` feeds the panel's picker, and it lists
  // layers that are currently hidden too — picking one is how you get it back
  // on the canvas. The implicit fallbacks stay visibility-aware, so a layer
  // you toggled off never becomes the karaoke source on its own.
  const karaokeLyrics = useMemo(() => {
    if (feature === 'prep' || !settings.experimentalLyricsFamily) return null;
    const all = [...lyricsLayers, ...detectorLyricsLayers];
    if (!all.length) return null;
    const shown = all.filter((l) => (l.source?.startsWith('detector:')
      ? !hiddenCustomAnnotations.has(l.source.slice('detector:'.length))
      : l.visible));
    const byId = (id?: string | null) => (id ? all.find((l) => l.id === id) : undefined);
    const layer =
      byId(karaokeLayerOverride) ||
      byId(focusedLyrics?.layerId) ||
      byId(selectedLyricsLayerId) ||
      shown.find((l) => l.items.length) ||
      all[0];
    if (!layer || !layer.items.length) return null;
    const options = all
      .filter((l) => l.items.length)
      .map((l) => ({ id: l.id, name: l.name, color: l.color }));
    return { items: layer.items, title: layer.name, color: layer.color, layerId: layer.id, options };
  }, [feature, settings.experimentalLyricsFamily, lyricsLayers, detectorLyricsLayers, hiddenCustomAnnotations, karaokeLayerOverride, focusedLyrics, selectedLyricsLayerId]);
  // In Algorithm Inspect, clicking a lyrics layer is a request to READ the
  // words, not to score boundaries — so the karaoke takes over the Consensus
  // stage's slot below the sub-tabs instead of stacking a second panel on top
  // of a consensus nobody asked for. Clicking any other layer brings the
  // consensus straight back; the Evaluation sub-tab is left alone, since that
  // one is already the answer to a question the user asked with the Examine
  // picker.
  // A clicked lyrics DETECTOR lane, read as karaoke. Its words are the
  // overlay's own sections — the same mapping the lane's ⬇ uses to copy the
  // take into a layer — so reading and copying can never disagree about what
  // the detector said. No picker: the detector lane is the pick.
  const karaokeAlgoLyrics = useMemo(() => {
    if (!selectedLyricsAlgoId || feature !== 'inspect-song') return null;
    const overlay = algoOverlays.find((o) => o.id === selectedLyricsAlgoId);
    if (!overlay?.sections.length) return null;
    const items: LyricsItem[] = overlay.sections.map((sec, i) => ({
      id: `${overlay.id}:${i}:${sec.time}`,
      time: sec.time,
      end: sec.endTime,
      text: sec.label || sec.type,
      kind: (sec.type === 'word' ? 'word' : 'line') as 'word' | 'line',
    }));
    return { items, title: overlay.label, color: overlay.labelColor ?? '#fb7185', layerId: overlay.id, options: [] };
  }, [selectedLyricsAlgoId, algoOverlays, feature]);
  // What the karaoke actually reads. A clicked detector lane wins over the
  // layer-derived source because it is the more recent, more specific click —
  // and picking a lyrics LAYER clears it again (see handleUnifiedSelectLayer),
  // so the two never argue about which one the user meant last.
  const karaokeSource = karaokeAlgoLyrics ?? karaokeLyrics;
  /** A lyrics layer or a lyrics detector lane is focused, so Algorithm Inspect
   *  offers a Karaoke tab. The karaoke used to take over the Consensus stage's
   *  slot instead, which left the lit tab saying "Consensus Inspect" over a
   *  panel that was nothing of the sort — a tab is the honest home for it. */
  const karaokeTabAvailable = feature === 'inspect-song'
    && (!!karaokeAlgoLyrics || (activeAnnotationType === 'lyrics' && !!karaokeLyrics));
  /** The inspect view actually rendered, after both gates. */
  const inspectStage: InspectSubStage | null =
    feature !== 'inspect-song' ? null
    : kindGatedSubStage === 'karaoke' && !karaokeTabAvailable ? 'eval'
    : kindGatedSubStage;
  /** The "Reference from" annotator picker, or null where it has no business
   *  being offered. Built once because two stages lay it out differently —
   *  Consensus Inspect takes it as `leading` so it shares a line with "Evaluate
   *  vs", the Evaluation tab gets it on the row above its own header.
   *
   *  It is a BOUNDARIES control: all it moves is the reference sections the
   *  consensus and the boundaries table are scored against, and the auto-guess
   *  points on the canvas. The per-kind Evaluation tables (cues, spans, loops,
   *  lyrics) fetch against the signed-in user and never consult it,
   *  so on any other Examine kind it would be a dropdown that changes nothing
   *  the user is looking at. */
  const referencePicker = feature === 'inspect-song' && inspectKind === 'boundaries'
    && selectedAudio && (adminStatus?.isAdmin || adminStatus?.isResearcher)
    ? (
      <ReferenceAnnotatorPicker
        slug={selectedAudio.id}
        currentAnnotatorId={annotator?.id ?? null}
        value={referenceAnnotatorId}
        onChange={setReferenceAnnotatorId}
      />
    )
    : null;
  // Clicking a lyrics layer in Algorithm Inspect is a request to READ the words,
  // so the Karaoke tab opens itself the moment it appears — the click already
  // said what the user wants, and making them hunt for a new tab to see the
  // result would be the "where do I click?" defect all over again. When the
  // focus leaves lyrics the tab goes away and the tab they came from comes
  // back, rather than stranding them on Evaluation.
  const karaokeReturnTabRef = useRef<InspectSubStage>('algo');
  useEffect(() => {
    // Track the last tab that wasn't the karaoke — every route onto it, not
    // just the automatic one, so the way back is the tab they actually left.
    if (inspectSubStage !== 'karaoke') karaokeReturnTabRef.current = inspectSubStage;
  }, [inspectSubStage]);
  useEffect(() => {
    if (feature !== 'inspect-song') return;
    setInspectSubStage((prev) => (
      karaokeTabAvailable ? 'karaoke'
      : prev === 'karaoke' ? karaokeReturnTabRef.current
      : prev
    ));
  }, [karaokeTabAvailable, feature]);
  // One karaoke panel, two possible homes (below the canvas in the Annotator,
  // in the stage slot in Algorithm Inspect) — rendered from one place so the
  // two can't drift apart.
  const renderKaraokePanel = () => karaokeSource && (
    <KaraokePanel
      items={karaokeSource.items}
      currentTime={playerTime}
      onSeek={(t) => seekRef.current?.(t)}
      title={karaokeSource.title}
      color={karaokeSource.color}
      layerId={karaokeSource.layerId}
      layerOptions={karaokeSource.options}
      onLayerChange={handleKaraokeLayerPick}
    />
  );
  // Boundary layers get a canvas row each, like every other layer kind. They
  // go ABOVE the signal rows (index 2, right after 3-Band + EQ) because the
  // structure is the frame you read every other lane against — that is where
  // the old fixed "Boundaries" row sat, and the saved row order still carries
  // its retired `manual` id, which is filtered out here on the way past.
  const prevBoundaryLayerIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const visible = boundaryLayersList.map((l) => `boundary-layer:${l.id}`);
    const currentIds = new Set(visible);
    const prev = prevBoundaryLayerIdsRef.current;
    const added = visible.filter((id) => !prev.has(id));
    const removed = [...prev].filter((id) => !currentIds.has(id));
    prevBoundaryLayerIdsRef.current = currentIds;
    if (!added.length && !removed.length) return;
    setRowOrder((order) => {
      const next = order.filter((id) => id !== 'manual' && !removed.includes(id));
      for (const id of added) {
        const anchor = next.indexOf('eq');
        const insertAt = anchor >= 0 ? anchor + 1 : Math.min(1, next.length);
        next.splice(insertAt, 0, id);
      }
      return next;
    });
  }, [boundaryLayersList]);

  // ── Layer groups ──────────────────────────────────────────────────────────
  // A group is a band over lanes that already exist: membership is the
  // `groupId` each layer carries, and the band's order is the document's own
  // layer order. The page owns the rowId spelling per type, so it is the side
  // that translates membership into something the canvas can splice in.
  const layerGroups = useMemo(() => cueLayersDoc?.groups ?? [], [cueLayersDoc]);

  const rowIdForLayer = useCallback((layer: AnnotationLayer): string => {
    switch (layer.type) {
      case 'boundaries':    return `boundary-layer:${layer.id}`;
      case 'cues':          return `cue-layer:${layer.id}`;
      case 'spans':         return `span-layer:${layer.id}`;
      case 'loops':         return `loop-layer:${layer.id}`;
      case 'riff-patterns': return `riff-layer:${layer.id}`;
      case 'lyrics':        return `lyrics-layer:${layer.id}`;
    }
  }, []);

  const rowGroupId = useMemo(() => {
    const out: Record<string, string> = {};
    for (const l of cueLayersDoc?.layers ?? []) {
      if (l.groupId) out[rowIdForLayer(l)] = l.groupId;
    }
    return out;
  }, [cueLayersDoc, rowIdForLayer]);

  const groupState = useMemo(() => {
    const out: Record<string, { visibility: 'all' | 'some' | 'none'; count: number }> = {};
    for (const g of layerGroups) {
      out[g.id] = {
        visibility: groupVisibility(cueLayersDoc, g.id),
        count: layersInGroup(cueLayersDoc, g.id).length,
      };
    }
    return out;
  }, [layerGroups, cueLayersDoc]);

  const editGroups = useCallback((
    edit: (doc: AnnotationLayersDocument) => AnnotationLayersDocument,
  ) => {
    setCueLayersDoc((prev) => (prev ? edit(prev) : prev));
  }, [setCueLayersDoc]);

  const handleGroupToggleCollapsed = useCallback((groupId: string) => {
    editGroups((doc) => updateGroup(doc, groupId, {
      collapsed: !findGroup(doc, groupId)?.collapsed,
    }));
  }, [editGroups]);

  const handleGroupSetVisible = useCallback((groupId: string, visible: boolean) => {
    editGroups((doc) => setGroupVisible(doc, groupId, visible));
  }, [editGroups]);

  const handleGroupRename = useCallback((groupId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    editGroups((doc) => updateGroup(doc, groupId, { name: trimmed }));
  }, [editGroups]);

  const handleGroupUngroup = useCallback((groupId: string) => {
    editGroups((doc) => ungroupLayers(doc, groupId));
  }, [editGroups]);

  // Deleting takes the lanes with it, so it names them and asks first — the
  // one difference from Ungroup that the labels have to carry.
  const handleGroupDelete = useCallback((groupId: string) => {
    const doc = cueLayersDocRef.current;
    if (!doc) return;
    const group = findGroup(doc, groupId);
    const members = layersInGroup(doc, groupId);
    if (!group) return;
    const names = members.map((l) => `· ${l.name}`).join('\n');
    const ok = window.confirm(
      members.length === 0
        ? `Delete the empty group "${group.name}"?`
        : `Delete "${group.name}" and the ${members.length} ${members.length === 1 ? 'lane' : 'lanes'} in it?\n\n${names}\n\nUngroup keeps them; this does not.`,
    );
    if (!ok) return;
    editGroups((d) => deleteGroupAndLayers(d, groupId));
  }, [editGroups]);

  // rowId is `<prefix>:<layerId>`, and a detector layer's own id carries a
  // colon of its own — so split once, at the first one.
  const layerIdFromRowId = useCallback((rowId: string) => rowId.slice(rowId.indexOf(':') + 1), []);

  const handleCreateGroupFromLayer = useCallback((rowId: string) => {
    const layerId = layerIdFromRowId(rowId);
    editGroups((doc) => {
      const layer = doc.layers.find((l) => l.id === layerId);
      const name = `Group ${(doc.groups?.length ?? 0) + 1}`;
      const { doc: next } = groupLayers(doc, [layerId], layer ? `${layer.name} group` : name);
      return next;
    });
  }, [editGroups, layerIdFromRowId]);

  const handleMoveLayerToGroup = useCallback((rowId: string, groupId: string | null) => {
    editGroups((doc) => setLayerGroup(doc, layerIdFromRowId(rowId), groupId));
  }, [editGroups, layerIdFromRowId]);

  /** Lanes whose membership the document can actually hold — detector lanes
   *  are re-derived each render, so a groupId on one would not survive the
   *  reload. Gates the drag-into-a-band drop the same way the lane's ⋮ menu is
   *  gated, so the two surfaces can never disagree about what is groupable. */
  const groupableRowIds = useMemo(() => {
    const out = new Set<string>();
    for (const l of cueLayersDoc?.layers ?? []) {
      if (!l.readOnly) out.add(rowIdForLayer(l));
    }
    return out;
  }, [cueLayersDoc, rowIdForLayer]);

  /** A lane dropped on a band — or dragged out of one onto a row that isn't in
   *  it. Membership and row order have to move together: the canvas reads a
   *  band's member order out of `rowOrder`, so a lane that joins without being
   *  placed inside the band would drag the whole header up to wherever it
   *  happened to sit. */
  const handleDropRowInGroup = useCallback((
    rowId: VizRowId,
    groupId: string | null,
    beforeRowId: VizRowId | null,
  ) => {
    editGroups((doc) => {
      let next = setLayerGroup(doc, layerIdFromRowId(rowId), groupId);
      // Landing in a collapsed band would read as the lane vanishing, so the
      // band opens to show what it just took.
      if (groupId && findGroup(next, groupId)?.collapsed) {
        next = updateGroup(next, groupId, { collapsed: false });
      }
      return next;
    });
    setRowOrder((prev) => moveRowInOrder(prev, rowId, { groupId, beforeRowId }, rowGroupId));
    setHasCustomRowOrder(true);
  }, [editGroups, layerIdFromRowId, rowGroupId]);

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

  // Same row sync for Riff-pattern layers (user + detector-sourced). A
  // detector layer needs its row in the order like any other, or it is passed
  // to the canvas, filtered, found visible — and then never drawn, because the
  // renderer only walks rowOrder.
  const prevRiffPatternLayerIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const visible = [
      ...riffPatternLayers.map((l) => `riff-layer:${l.id}`),
      ...detectorRiffLayers.map((l) => `riff-layer:${l.id}`),
    ];
    const currentIds = new Set(visible);
    const prev = prevRiffPatternLayerIdsRef.current;
    const added = visible.filter((id) => !prev.has(id));
    const removed = [...prev].filter((id) => !currentIds.has(id));
    prevRiffPatternLayerIdsRef.current = currentIds;
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
  }, [riffPatternLayers, detectorRiffLayers]);

  // Same row sync for Lyrics layers (user + detector-sourced).
  const prevLyricsLayerIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const visible = [
      ...lyricsLayers.map((l) => `lyrics-layer:${l.id}`),
      ...detectorLyricsLayers.map((l) => `lyrics-layer:${l.id}`),
    ];
    const currentIds = new Set(visible);
    const prev = prevLyricsLayerIdsRef.current;
    const added = visible.filter((id) => !prev.has(id));
    const removed = [...prev].filter((id) => !currentIds.has(id));
    prevLyricsLayerIdsRef.current = currentIds;
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
  }, [lyricsLayers, detectorLyricsLayers]);

  // Default-sort detector lanes by stem. The row-sync effects above append each
  // freshly-cached detector lane right after 'autoGuess' in load order, which is
  // roughly registry order and mixes stems. Here we re-sort just the
  // detector-lane rows (those present in layerStemRank) into SOURCE order
  // (mix → vocals → drums → bass → other → guitar → piano), writing them back
  // into the slots they already occupy so fixed rows, algo overlays and
  // user-authored lanes stay put. Skipped once the user hand-drags a row
  // (hasCustomRowOrder) so their manual order is never clobbered.
  useEffect(() => {
    if (hasCustomRowOrder) return;
    setRowOrder((order) => {
      const slots: number[] = [];
      const ids: VizRowId[] = [];
      order.forEach((id, i) => {
        if (layerStemRank.has(id)) { slots.push(i); ids.push(id); }
      });
      if (ids.length < 2) return order;
      const sorted = ids
        .map((id, i) => ({ id, i, rank: layerStemRank.get(id)! }))
        .sort((a, b) => a.rank - b.rank || a.i - b.i)
        .map((e) => e.id);
      if (sorted.every((id, k) => id === ids[k])) return order;
      const next = order.slice();
      slots.forEach((slot, k) => { next[slot] = sorted[k]; });
      return next;
    });
  }, [rowOrder, layerStemRank, hasCustomRowOrder]);

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

  // Row id → that signal's switch. The phone's row sheet swaps and hides rows
  // through it; the SIGNALS menu sets the same switches directly.
  const handleSetSignalShown = useCallback((rowId: VizRowId, shown: boolean) => {
    const setters: Record<string, (v: boolean) => void> = {
      waveform: setShowWaveform, eq: setShowEQ, spectrogram: setShowSpectrogram,
      cepstrogram: setShowCepstrogram, chroma: setShowChroma, tempogram: setShowTempogram,
      ssm: setShowSsm, energy: setShowEnergy, brightness: setShowBrightness,
      novelty: setShowNovelty, onsets: setShowOnsets, flux: setShowFlux,
    };
    setters[rowId]?.(shown);
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
    for (const s of ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'] as const) {
      if (stemManifest.stems[s]) out.push(s);
    }
    return out;
  }, [stemManifest]);

  // The two ends of the stem lock. Each side sets itself, then — while locked —
  // pushes the same stem to the other side if the other side can take it: the
  // player only has the stems Demucs wrote, and the filter only has stems some
  // algorithm has rows for. 'All' is not a stem, so picking it leaves the
  // player alone. Done here in the handlers rather than in an effect, so the
  // filter's own snap-back to 'mix' (a song with no rows for the stem) never
  // yanks the audio off the stem the user chose to hear.
  const filterCanShowStem = useCallback((stem: StemSource) =>
    stem === 'mix' || annotationRows.some((r) => {
      const i = r.id.indexOf('__');
      return i !== -1 && r.id.slice(i + 2) === stem;
    }), [annotationRows]);

  // A stem the link asked for, not yet honoured — see the restore below. Any
  // stem the user picks themselves outranks it.
  const urlStemPendingRef = useRef(urlView.stem != null && urlView.stem !== 'mix');
  const urlFilterPendingRef = useRef(urlView.filter != null && urlView.filter !== 'mix');

  const pickPlayerStem = useCallback((stem: StemSource) => {
    urlStemPendingRef.current = false;
    urlFilterPendingRef.current = false;
    setSelectedStemSource(stem);
    if (stemLock && filterCanShowStem(stem)) setInspectStemFilter(stem);
  }, [stemLock, filterCanShowStem]);

  const pickStemFilter = useCallback((filter: StemSource | 'all') => {
    urlStemPendingRef.current = false;
    urlFilterPendingRef.current = false;
    setInspectStemFilter(filter);
    if (stemLock && filter !== 'all' && availableStemSources.includes(filter)) setSelectedStemSource(filter);
  }, [stemLock, availableStemSources]);

  // Re-locking brings the filter over to the stem that is playing — the audio
  // is the side the user is actually hearing, so it wins.
  const setStemLock = useCallback((v: boolean) => {
    setStemLockState(v);
    try { window.localStorage.setItem('tc.stemLock', v ? '1' : '0'); } catch { /* ignore quota */ }
    if (v && filterCanShowStem(selectedStemSource)) setInspectStemFilter(selectedStemSource);
  }, [filterCanShowStem, selectedStemSource]);

  // ── The view, in the URL: the rest of it ─────────────────────────────────
  // Declared down here because it reads nearly every visibility control on
  // the page, most of which are declared above. The writer itself, and the
  // song / lanes / window restore, sit with the scroll handlers.
  const inspecting = isInspect(feature);
  const shownDetectorNames = useMemo(() => {
    const names = new Set([
      ...customAnnotationRows.map((r) => r.detectorName),
      ...detectorBoundaryLayers.map((l) => l.detectorName),
    ]);
    return [...names].filter((n) => !hiddenCustomAnnotations.has(n));
  }, [customAnnotationRows, detectorBoundaryLayers, hiddenCustomAnnotations]);
  const shownSignals = useMemo(() => {
    const on: Record<UrlSignal, boolean> = {
      waveform: showWaveform, '3band': showEQ, spectrogram: showSpectrogram,
      cepstrogram: showCepstrogram, energy: showEnergy, brightness: showBrightness,
      novelty: showNovelty, onsets: showOnsets, flux: showFlux, chroma: showChroma,
      tempogram: showTempogram, ssm: showSsm, beatgrid: showBeatGrid,
    };
    return URL_SIGNALS.filter((k) => on[k]);
  }, [showWaveform, showEQ, showSpectrogram, showCepstrogram, showEnergy, showBrightness,
      showNovelty, showOnsets, showFlux, showChroma, showTempogram, showSsm, showBeatGrid]);
  const shownLayers = useMemo(() => {
    const on: Record<UrlLayer, boolean> = inspecting
      ? {
          manual: visibleAnnotationsInspect.has('__manual__'),
          autoguess: visibleAnnotationsInspect.has('__autoguess__'),
          prominence: showProminenceInspect,
          consensus: showConsensus,
        }
      : { manual: showManual, autoguess: showAutoGuess, prominence: showProminence, consensus: false };
    return URL_LAYERS.filter((k) => on[k]);
  }, [inspecting, visibleAnnotationsInspect, showProminenceInspect, showConsensus,
      showManual, showAutoGuess, showProminence]);

  useEffect(() => {
    viewSourceRef.current = {
      song: selectedAudio?.id ?? null,
      type: feature === 'annotate' ? activeAnnotationType : null,
      kind: feature === 'inspect-song' ? inspectKind : null,
      view: feature === 'inspect-song' ? kindGatedSubStage : null,
      algos: [...selectedAlgoOverlays],
      dets: shownDetectorNames,
      layers: shownLayers,
      signals: shownSignals,
      fams: inspecting ? [...expandedAlgoTypes] : null,
      stem: selectedStemSource,
      filter: inspecting ? inspectStemFilter : null,
      lock: stemLock,
      speed: playbackRate,
      unit: beatGridUnit,
      duration,
    };
    scheduleUrlWrite();
  }, [feature, selectedAudio?.id, activeAnnotationType, inspectKind, kindGatedSubStage,
      selectedAlgoOverlays, shownDetectorNames, shownLayers, shownSignals, inspecting,
      expandedAlgoTypes, selectedStemSource, inspectStemFilter, stemLock, playbackRate,
      beatGridUnit, duration, scheduleUrlWrite]);

  // The switches that do not depend on the song: applied once, when the first
  // song has opened — not on mount, because opening a song resets the signal
  // rows to the Settings defaults and would wipe them. The layer switches are read against the workspace the link was taken in —
  // Inspect and the Annotator keep separate ones. The stem lock is applied for
  // this visit only; it is the recipient's saved preference, and a link is
  // not a reason to change their Misc settings behind their back.
  const urlSwitchesPendingRef = useRef(true);
  useEffect(() => {
    if (!selectedAudio || !urlSwitchesPendingRef.current) return;
    urlSwitchesPendingRef.current = false;
    const sig = urlView.signals;
    if (sig) {
      const has = (k: UrlSignal) => sig.includes(k);
      setShowWaveform(has('waveform')); setShowEQ(has('3band'));
      setShowSpectrogram(has('spectrogram')); setShowCepstrogram(has('cepstrogram'));
      setShowEnergy(has('energy')); setShowBrightness(has('brightness'));
      setShowNovelty(has('novelty')); setShowOnsets(has('onsets')); setShowFlux(has('flux'));
      setShowChroma(has('chroma')); setShowTempogram(has('tempogram')); setShowSsm(has('ssm'));
      setShowBeatGrid(has('beatgrid'));
    }
    const lay = urlView.layers;
    if (lay) {
      if (inspecting) {
        setVisibleAnnotationsInspect((prev) => {
          const next = new Set(prev);
          for (const [key, id] of [['manual', '__manual__'], ['autoguess', '__autoguess__']] as const) {
            if (lay.includes(key)) next.add(id); else next.delete(id);
          }
          return next;
        });
        setShowProminenceInspect(lay.includes('prominence'));
        setShowConsensus(lay.includes('consensus'));
      } else {
        setShowManual(lay.includes('manual'));
        setShowAutoGuess(lay.includes('autoguess'));
        setShowProminence(lay.includes('prominence'));
      }
    }
    if (urlView.fams) setExpandedAlgoTypes(new Set(urlView.fams));
    if (urlView.lock != null) setStemLockState(urlView.lock);
    if (urlView.speed != null) setPlaybackRate(urlView.speed);
    if (urlView.unit) setBeatGridUnit(urlView.unit as BeatGridUnit);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAudio?.id]);

  // The stems wait for the song. Opening a song resets both to the full mix,
  // the player can only take a stem once the song's stem manifest is in, and
  // the filter snaps back to the mix until some per-stem result for that stem
  // has loaded — so each is offered until it can be honoured, and dropped the
  // moment the user picks a stem themselves or another song opens.
  const urlStemSongRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const id = selectedAudio?.id ?? null;
    if (!id) return;
    if (urlStemSongRef.current === undefined) {
      urlStemSongRef.current = id;
      if (urlView.song && urlView.song !== id) {
        urlStemPendingRef.current = false;
        urlFilterPendingRef.current = false;
      }
    } else if (urlStemSongRef.current !== id) {
      urlStemPendingRef.current = false;
      urlFilterPendingRef.current = false;
      return;
    }
    const stem = urlView.stem;
    if (urlStemPendingRef.current && stem && availableStemSources.includes(stem)) {
      urlStemPendingRef.current = false;
      setSelectedStemSource(stem);
    }
    const filter = urlView.filter;
    if (urlFilterPendingRef.current && filter && (filter === 'all' || filterCanShowStem(filter))) {
      urlFilterPendingRef.current = false;
      setInspectStemFilter(filter);
    }
  }, [selectedAudio?.id, availableStemSources, filterCanShowStem, urlView]);

  // Curated detectors are hidden as each one is discovered (the row-sync
  // effect above), and they are discovered one fetch at a time — so the ones
  // the link shows are un-hidden as they turn up, after that effect has run.
  const urlDetsPendingRef = useRef(new Set(urlView.dets ?? []));
  useEffect(() => {
    const pending = urlDetsPendingRef.current;
    if (!pending.size) return;
    const present = new Set([
      ...customAnnotationRows.map((r) => r.detectorName),
      ...detectorBoundaryLayers.map((l) => l.detectorName),
    ]);
    const now = [...pending].filter((n) => present.has(n));
    if (!now.length) return;
    for (const n of now) pending.delete(n);
    setHiddenCustomAnnotations((prev) => {
      const next = new Set(prev);
      for (const n of now) next.delete(n);
      return next;
    });
  }, [customAnnotationRows, detectorBoundaryLayers]);

  // Same pattern for detectors just run from the Run picker: un-hide each once
  // its layer exists (after the default-hide effect has had its turn) and open
  // the Detectors sidebar so the new output is where the user will look.
  useEffect(() => {
    const pending = revealDetectorsPendingRef.current;
    if (!pending.size) return;
    const present = new Set([
      ...customAnnotationRows.map((r) => r.detectorName),
      ...curatedLayersByStem.rows.map((r) => r.detectorName),
    ]);
    const now = [...pending].filter((n) => present.has(n));
    if (!now.length) return;
    for (const n of now) pending.delete(n);
    setHiddenCustomAnnotations((prev) => {
      const next = new Set(prev);
      for (const n of now) next.delete(n);
      return next;
    });
    setCuratedSidebarCollapsed(false);
  }, [customAnnotationRows, curatedLayersByStem]);

  // The stems a riff boundary node can measure its blocks against, on top of
  // whatever the player itself is loaded with. Whichever stem is already
  // playing is left out — the page analyses that one anyway, and it is the
  // list's first entry under its own name.
  const onsetStemSources = useMemo(() => {
    if (!stemManifest) return [];
    return availableStemSources
      .filter((s) => s !== 'mix' && s !== selectedStemSource)
      .map((s) => ({ id: s, name: `audio · ${s}`, url: stemManifest.stems[s as DemucsStem]! }))
      .filter((s) => !!s.url);
  }, [stemManifest, availableStemSources, selectedStemSource]);

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

  // Stem sub-filter for the Algorithm-Inspect sidebar. Single-select: it
  // narrows the algorithms the family chips have turned on to ONE stem's rows.
  // 'All' = no narrowing; 'Full mix' = mix rows only; a stem = each shown
  // algorithm's <stem> variant. Composes with the chips ("chips pick the
  // algorithms → stem filter picks the stem"). It renders in the sidebar's
  // pinned header rather than inside the scrolling panel: the chip list it
  // narrows is far taller than the column, and a filter you have to scroll
  // back up to reach reads as missing. Null until per-stem results exist —
  // before that every row is a mix row and the filter is a no-op.
  const renderStemFilter = () => {
    const stemOf = (id: string) => { const i = id.indexOf('__'); return i === -1 ? '' : id.slice(i + 2); };
    const stemRowsAll = annotationRows.filter((r) => r.id.includes('__'));
    if (stemRowsAll.length === 0) return null;
    // Always show all six Demucs stems as chips so the per-stem reality is
    // visible — a song split with the 6-stem model has guitar/piano even when
    // no algorithm has been run on them yet. Stems with no per-stem result
    // render disabled (greyed) rather than being dropped from the strip.
    const availableStems = ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'];
    const stemHasRows = (s: string) => stemRowsAll.some((r) => stemOf(r.id) === s);
    // A per-stem row is "selected" when its own id is ticked, or — the usual
    // case — its base mix row is (the family chip selects the base, the stem
    // variant rides along). Mirrors the timeline's matchesStem so the badge
    // counts exactly the rows the chips would show on that stem.
    const rowSelected = (r: { id: string }) =>
      selectedAlgoOverlays.has(r.id) || selectedAlgoOverlays.has(baseAlgoId(r.id));
    const stemSelectedCount = (s: string) =>
      stemRowsAll.filter((r) => stemOf(r.id) === s && rowSelected(r)).length;
    const allSelected = stemRowsAll.filter(rowSelected).length;
    const options: Array<{ key: StemSource | 'all'; label: string; enabled: boolean; count: number | null; title: string }> = [
      { key: 'all', label: 'All', enabled: true, count: allSelected, title: 'Show every selected algorithm on every stem it has run on.' },
      { key: 'mix', label: 'Full mix', enabled: true, count: null, title: 'Show only the full-mix rows of the selected algorithms.' },
      ...availableStems.map((s) => {
        const has = stemHasRows(s);
        const n = stemSelectedCount(s);
        return {
          key: s as StemSource,
          label: s,
          enabled: has,
          count: n,
          title: !has
            ? `No algorithm has a per-stem result for ${s} yet — run one on the ${s} stem to populate it.`
            : n > 0
              ? `${n} selected algorithm${n === 1 ? '' : 's'} ${n === 1 ? 'has' : 'have'} a ${s}-stem result — click to show just those rows.`
              : `No selected algorithm has a ${s}-stem result yet — tick one in its family chip, then this shows its ${s} row.`,
        };
      }),
    ];
    return (
      <StemChipGroup
        label="Stem filter"
        hint="narrows the chips’ rows"
        accent={accent}
        chips={options.map((o) => ({
          key: o.key,
          label: o.label,
          active: inspectStemFilter === o.key,
          disabled: !o.enabled,
          count: o.count,
          title: o.title,
          onClick: () => pickStemFilter(o.key),
        }))}
      />
    );
  };

  // Batch-algorithm options panel. Mounted three times — Dataset Management
  // card (scope='dataset'), under the song title (scope='song'), and inside
  // the Algorithm-Inspect right sidebar. The sidebar passes stacked=true to
  // get one-algorithm-per-row layout (its column is narrow); the wide-panel
  // call sites stay on the multi-per-row grid.
  const renderRunOptionsPanel = (stacked: boolean, purpose: 'run' | 'visibility' = 'run') => {
    // 'run'        → per-row checkbox = selectedAlgorithms (what to compute); the
    //                family action cluster is "▶ Run missing · Select all · None".
    //                Used by the Dataset-Prep batch panel, the Prep song scope, and
    //                the inspect sidebar's Run… popover.
    // 'visibility' → per-row checkbox = selectedAlgoOverlays (show the cached result
    //                on the timeline); missing rows are disabled; the family cluster
    //                is "Show all · Hide all" over cached rows. Used only by the
    //                inspect sidebar body.
    const isVis = purpose === 'visibility';
    const algoRowsCls = stacked ? 'flex flex-col gap-1' : 'flex flex-wrap gap-x-3 gap-y-1.5';
    // Build a lookup of per-algo failures from the most recent run job, so we
    // can render a red "failed" pill (with the error reason as a tooltip) next
    // to the matching row. Keys are canonical UI ids — same shape the section
    // headers use to compute "missing". Transient across runs.
    const runErrors = new Map<string, string>();
    for (const s of runJob?.sections ?? []) {
      for (const e of s.errors ?? []) runErrors.set(e.id, e.message);
    }
    const renderStatusPill = (id: string, cached: boolean, mixOnly?: boolean) => {
      // Under an active per-stem filter, detectors that only run on the full
      // mix (MSAF, ruptures, all-in-one, custom) have no output for the chosen
      // stem at all — say so instead of a misleading "cached"/"missing".
      if (mixOnly) {
        return (
          <span
            className="text-slate-600 text-[9px] uppercase tracking-wider cursor-help"
            title={`Runs on the full mix only — no per-stem output, so nothing shows under the ${inspectStemFilter} stem filter.`}
          >
            mix only
          </span>
        );
      }
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
    // Per-stem overlay rows (id "<algo>__<stem>").
    const stemRowsAll = annotationRows.filter((r) => r.id.includes('__'));
    // When the stem filter picks a single stem (visibility mode only), a row's
    // "available" state is its <id>__<stem> variant, not the full mix. Null when
    // the filter is 'All' / 'Full mix', which leaves the plain mix behaviour.
    const stemFilter = isVis && inspectStemFilter !== 'all' && inspectStemFilter !== 'mix'
      ? inspectStemFilter : null;
    const stemHasResult = (baseId: string) =>
      stemRowsAll.some((r) => r.id === `${baseId}__${stemFilter}`);
    // Resolve a detector row's {cached, disabled, pill} under the active stem
    // filter. `mixCached` is the row's own full-mix cache flag (each family
    // computes it differently); `stemCapable` is whether the detector can target
    // an isolated stem at all. With no stem filter this is the plain mix
    // behaviour; with one, stem-incapable detectors read "mix only" and
    // stem-capable ones reflect their per-stem variant.
    const stemRowState = (id: string, mixCached: boolean, stemCapable: boolean) => {
      if (!stemFilter) return { cached: mixCached, disabled: isVis && !mixCached, pill: renderStatusPill(id, mixCached) };
      if (!stemCapable) return { cached: false, disabled: true, pill: renderStatusPill(id, false, true) };
      const has = stemHasResult(id);
      return { cached: has, disabled: !has, pill: renderStatusPill(`${id}__${stemFilter}`, has) };
    };
    // Per-family granular stem checkboxes are retired: per-stem display is now
    // driven by the single-select stem filter at the top of the visibility
    // sidebar, which composes with the family chips (chip = which algorithms,
    // stem filter = which stem).
    return (
    <div className={`rounded-md border ${accent.panelBorder} bg-[#14171d]/80 p-3 space-y-3 text-xs`}>
      {/* Demucs model — a run parameter, so it belongs in the run picker, not
          the visibility sidebar. */}
      {!isVis && (
      <div
        className="flex flex-col gap-1 min-w-0"
        title={gpuCaps.demucs ? undefined : GPU_TOOLS_UNAVAILABLE_HINT}
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[10px] uppercase tracking-wider shrink-0 ${gpuCaps.demucs ? 'text-slate-500' : 'text-slate-600'}`}>Demucs model</span>
          {!gpuCaps.demucs && (
            <span className="text-[9px] uppercase tracking-wider text-amber-400/80">Demucs profile needed</span>
          )}
        </div>
        <select
          value={demucsModel}
          onChange={(e) => setDemucsModel(e.target.value)}
          disabled={!gpuCaps.demucs}
          className="w-full min-w-0 truncate bg-[#0a0b0d] border border-white/[0.08] text-slate-200 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {DEMUCS_MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <span className="text-slate-600 text-[10px] leading-snug">Used by All-In-One for stem separation.</span>
      </div>
      )}

      {/* Algorithm families as annotation-style tab chips: one family's
          checkboxes visible at a time, the rest collapsed behind their chips.
          Reuses <AnnotationTypeChip> from the unified annotation list so the
          two panels share one chip control (no duplicated markup). */}
      {(() => {
        type AlgoSection = {
          key: string;
          label: string;
          experimental: boolean;
          total: number;
          cached: number;
          // Every algo id in the family (run-mode select-all) and just the
          // cached subset (vis-mode "show all" — only cached rows can show).
          // Clicking a chip selects all of these; collapsing deselects them.
          ids: string[];
          visIds: string[];
          render: () => ReactNode;
        };
        const sections: AlgoSection[] = [];

        // Shared per-family actions, returned as two parts so the header can
        // lay them out for a narrow column: `select` (All · None, or Show all ·
        // Hide all in visibility mode) sits beside the family name, and `run`
        // (▶ Run missing) gets its own full-width row beneath it. One row with
        // all three overflowed the stacked sidebar and wrapped mid-label.
        // amber=true gives the Custom family its amber accent; every other
        // family is violet.
        const actionCluster = (o: {
          missing: string[];
          canRunMissing: boolean;
          onRun: (ids: string[]) => void;
          onSelectAll: () => void;
          onNone: () => void;
          runTitle: string;
          amber?: boolean;
          selectDisabled?: boolean;
          /** Cached row ids for this family — drives Show all / Hide all in
           *  visibility mode. The run-mode props above are ignored when isVis. */
          visIds?: string[];
        }): { select: ReactNode; run: ReactNode } => {
          const hov = o.amber ? 'hover:text-amber-300' : 'hover:text-violet-300';
          const linkCls = `text-slate-400 ${hov} transition-colors uppercase tracking-wide disabled:opacity-40 disabled:hover:text-slate-400 disabled:cursor-not-allowed`;
          const pair = (a: ReactNode, b: ReactNode) => (
            <div className="flex shrink-0 items-center gap-1.5 text-[10px] whitespace-nowrap">
              {a}
              <span aria-hidden className="text-slate-700">·</span>
              {b}
            </div>
          );
          // Visibility mode: no "Run missing" — just toggle the family's cached
          // overlays on/off. Operates on visIds (cached rows only) so missing
          // rows, which have nothing to show, are never touched.
          if (isVis) {
            const visIds = o.visIds ?? [];
            const allShown = visIds.length > 0 && visIds.every((id) => selectedAlgoOverlays.has(id));
            return {
              run: null,
              select: pair(
                <button
                  disabled={visIds.length === 0 || allShown}
                  onClick={() => setSelectedAlgoOverlays((prev) => { const n = new Set(prev); visIds.forEach((id) => n.add(id)); return n; })}
                  title={visIds.length === 0 ? 'No cached results in this family to show yet.' : 'Show every cached result in this family on the timeline.'}
                  className={linkCls}
                >
                  Show all
                </button>,
                <button
                  disabled={visIds.length === 0}
                  onClick={() => setSelectedAlgoOverlays((prev) => { const n = new Set(prev); visIds.forEach((id) => n.delete(id)); return n; })}
                  title="Hide this family's results from the timeline."
                  className={linkCls}
                >
                  Hide all
                </button>,
              ),
            };
          }
          const selectedMissing = o.missing.filter((id) => selectedAlgorithms.has(id));
          const runCls = o.amber
            ? 'border-amber-600/40 bg-amber-900/20 text-amber-200 hover:bg-amber-900/40 hover:border-amber-500/50 disabled:hover:bg-amber-900/20 disabled:hover:border-amber-600/40'
            : 'border-violet-600/40 bg-violet-900/20 text-violet-200 hover:bg-violet-900/40 hover:border-violet-500/50 disabled:hover:bg-violet-900/20 disabled:hover:border-violet-600/40';
          return {
            select: pair(
              <button disabled={o.selectDisabled} onClick={o.onSelectAll} title="Tick every algorithm in this family." className={linkCls}>
                All
              </button>,
              <button disabled={o.selectDisabled} onClick={o.onNone} title="Untick every algorithm in this family." className={linkCls}>
                None
              </button>,
            ),
            run: (
              <button
                disabled={!o.canRunMissing || selectedMissing.length === 0}
                onClick={() => o.onRun(selectedMissing)}
                title={o.runTitle}
                className={`${stacked ? 'flex w-full' : 'inline-flex'} items-center justify-center gap-1.5 h-7 px-3 rounded-md border ${runCls} text-[10px] font-medium whitespace-nowrap uppercase tracking-wider transition-colors disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                <span aria-hidden className="text-[8px]">▶</span>
                Run missing{selectedMissing.length > 0 ? ` (${selectedMissing.length})` : ''}
              </button>
            ),
          };
        };
        // Header inside a family's frame — the family name on the left (several
        // frames can be open at once, so each is labelled), an optional note
        // beside it (e.g. the All-In-One "requires allin1" hint), and the
        // action cluster on the right.
        // Small plain-language chip beside an algo name (e.g. "subtitles" next
        // to whisper-base). Hover shows the fuller `what` line. Null for algos
        // without a hint.
        const algoHint = (id: string) => {
          const h = ALGO_HINTS[id];
          if (!h) return null;
          return (
            <span
              title={h.what}
              className="shrink-0 rounded px-1 py-px text-[10px] leading-none normal-case tracking-normal text-slate-400 bg-slate-700/40 cursor-help"
            >
              {h.tag}
            </span>
          );
        };

        // Run picker only: nudge a stem-specific detector toward its stem. Hidden
        // once "Run on" already covers it (that stem, or All stems). The target
        // is one setting for the whole run, so the tooltip says so rather than
        // letting a click silently retarget the other ticked detectors.
        const bestStemChip = (id: string) => {
          const best = BEST_STEM[id];
          if (isVis || !best || runStemSource === best || runStemSource === 'all') return null;
          const separated = !!stemManifest?.stems?.[best];
          return (
            <button
              type="button"
              disabled={!separated}
              onClick={(e) => { e.preventDefault(); handleRunStemChange(best); }}
              title={separated
                ? `Works best on the ${best} stem. Click to set "Run on" to ${best} — that applies to every detector ticked in this run.`
                : `Works best on the ${best} stem, which this song hasn't had separated yet. Separate stems (Demucs) first.`}
              className="shrink-0 rounded px-1 py-px text-[10px] leading-none normal-case tracking-normal text-amber-300/80 bg-amber-500/10 hover:bg-amber-500/20 disabled:text-slate-500 disabled:bg-slate-700/30 disabled:cursor-not-allowed transition-colors"
            >
              best on {best}
            </button>
          );
        };

        const sectionHeader = (
          label: ReactNode,
          labelCls: string,
          note: ReactNode,
          cluster: { select: ReactNode; run: ReactNode },
        ) => (
          <div className="mb-2 space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
              <span className={`whitespace-nowrap text-[10px] uppercase tracking-wider font-medium ${labelCls}`}>{label}</span>
              {cluster.select}
            </div>
            {note && <div className="text-[10px] leading-snug normal-case tracking-normal text-amber-400/80">{note}</div>}
            {cluster.run}
          </div>
        );

        // ── MSAF ──────────────────────────────────────────────────────────
        {
          const ids = ['msaf-sf', 'msaf-foote', 'msaf-cnmf', 'msaf-olda'];
          const missing = ids.filter((id) => toolStates[id]?.status !== 'done');
          const canRunMissing = !!selectedAudio && runJob?.status !== 'running' && missing.length > 0;
          sections.push({
            key: 'msaf', label: 'MSAF', experimental: false,
            total: ids.length, cached: ids.length - missing.length,
            ids, visIds: ids.filter((id) => toolStates[id]?.status === 'done'),
            render: () => (
              <>
                {sectionHeader('MSAF', 'text-cyan-300/80', null, actionCluster({
                  missing, canRunMissing,
                  visIds: ids.filter((id) => toolStates[id]?.status === 'done'),
                  onRun: (toRun) => handleRunMissingForSection(toRun),
                  onSelectAll: () => updateSelectedAlgorithms((prev) => { const next = new Set(prev); ids.forEach((id) => next.add(id)); return next; }),
                  onNone: () => updateSelectedAlgorithms((prev) => { const next = new Set(prev); ids.forEach((id) => next.delete(id)); return next; }),
                  runTitle: !selectedAudio
                    ? 'Select a song first.'
                    : missing.length === 0
                      ? 'Every MSAF algorithm already has a cached result for this song.'
                      : `Run ${missing.length} MSAF algorithm${missing.length === 1 ? '' : 's'} that have no cached result yet for "${selectedAudio.name}".`,
                }))}
                <div className={algoRowsCls}>
                  {ids.map((id) => {
                    const { disabled, pill } = stemRowState(id, toolStates[id]?.status === 'done', STEM_CAPABLE_TOOL_IDS.has(id));
                    const checked = isVis ? selectedAlgoOverlays.has(id) : selectedAlgorithms.has(id);
                    const label = id.replace('msaf-', '').toUpperCase();
                    return (
                      <label key={id} className={`flex items-center gap-1.5 select-none ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
                        <input type="checkbox" checked={checked} disabled={disabled} onChange={() => (isVis ? toggleAlgoOverlay(id) : toggleAlgorithm(id))} className={`${accent.checkbox} disabled:cursor-not-allowed`} />
                        <span className={`font-mono ${checked ? 'text-slate-200' : 'text-slate-600'}`}>{label}</span>
                        {pill}
                      </label>
                    );
                  })}
                </div>
              </>
            ),
          });
        }

        // ── All-In-One ────────────────────────────────────────────────────
        {
          const ids = ['allin1', ...[0,1,2,3,4,5,6,7].map((n) => `allin1-fold${n}`)];
          const missing = ids.filter((id) => toolStates[id]?.status !== 'done');
          const canRunMissing = gpuCaps.allin1 && !!selectedAudio && runJob?.status !== 'running' && missing.length > 0;
          sections.push({
            key: 'allin1', label: 'All-In-One', experimental: false,
            total: ids.length, cached: ids.length - missing.length,
            ids, visIds: ids.filter((id) => toolStates[id]?.status === 'done'),
            render: () => (
              <div title={gpuCaps.allin1 ? undefined : GPU_TOOLS_UNAVAILABLE_HINT}>
                {sectionHeader(
                  'All-In-One',
                  gpuCaps.allin1 ? 'text-cyan-300/80' : 'text-slate-500',
                  gpuCaps.allin1 ? null : 'requires `allin1` (Demucs profile or `pip install -r tools/requirements-allin1.txt`)',
                  actionCluster({
                    missing, canRunMissing,
                    onRun: (toRun) => handleRunMissingForSection(toRun),
                    onSelectAll: () => updateSelectedAlgorithms((prev) => { const next = new Set(prev); ids.forEach((id) => next.add(id)); return next; }),
                    onNone: () => updateSelectedAlgorithms((prev) => { const next = new Set(prev); ids.forEach((id) => next.delete(id)); return next; }),
                    selectDisabled: !gpuCaps.allin1,
                    visIds: ids.filter((id) => toolStates[id]?.status === 'done'),
                    runTitle: !gpuCaps.allin1
                      ? GPU_TOOLS_UNAVAILABLE_HINT
                      : !selectedAudio
                        ? 'Select a song first.'
                        : missing.length === 0
                          ? 'Every All-In-One model already has a cached result for this song.'
                          : `Run ${missing.length} All-In-One model${missing.length === 1 ? '' : 's'} that have no cached result yet for "${selectedAudio.name}".`,
                  }),
                )}
                <div className={algoRowsCls}>
                  {ids.map((id) => {
                    // All-In-One is full-mix only; the stem state handles the
                    // visibility-mode cache + "mix only" pill, run mode stays
                    // gated by the gpu profile.
                    const stem = stemRowState(id, toolStates[id]?.status === 'done', STEM_CAPABLE_TOOL_IDS.has(id));
                    const checked = isVis ? selectedAlgoOverlays.has(id) : selectedAlgorithms.has(id);
                    const rowDisabled = isVis ? stem.disabled : !gpuCaps.allin1;
                    const label = id === 'allin1' ? 'Ensemble' : `fold${id.replace('allin1-fold', '')}`;
                    return (
                      <label
                        key={id}
                        className={`flex items-center gap-1.5 select-none ${rowDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                        title={gpuCaps.allin1 ? undefined : GPU_TOOLS_UNAVAILABLE_HINT}
                      >
                        <input type="checkbox" checked={checked} disabled={rowDisabled} onChange={() => (isVis ? toggleAlgoOverlay(id) : toggleAlgorithm(id))} className={`${accent.checkbox} disabled:cursor-not-allowed`} />
                        <span className={`font-mono ${checked ? 'text-slate-200' : 'text-slate-600'}`}>{label}</span>
                        {stem.pill}
                      </label>
                    );
                  })}
                </div>
              </div>
            ),
          });
        }

        // ── Ruptures (CPD) — 19 variants from Truong/Oudre/Vayatis ─────────
        {
          const missing = RUPTURES_METHODS
            .filter((m) => !rupturesResults[m.suffix])
            .map((m) => `ruptures-${m.suffix}`);
          const canRunMissing = !!selectedAudio && runJob?.status !== 'running' && missing.length > 0;
          sections.push({
            key: 'ruptures', label: 'Ruptures (CPD)', experimental: false,
            total: RUPTURES_METHODS.length, cached: RUPTURES_METHODS.length - missing.length,
            ids: RUPTURES_METHODS.map((m) => `ruptures-${m.suffix}`),
            visIds: RUPTURES_METHODS.filter((m) => rupturesResults[m.suffix]).map((m) => `ruptures-${m.suffix}`),
            render: () => (
              <>
                {sectionHeader('Ruptures (CPD)', 'text-cyan-300/80', null, actionCluster({
                  missing, canRunMissing,
                  visIds: RUPTURES_METHODS.filter((m) => rupturesResults[m.suffix]).map((m) => `ruptures-${m.suffix}`),
                  onRun: (ids) => handleRunMissingForSection(ids),
                  onSelectAll: () => updateSelectedAlgorithms((prev) => { const next = new Set(prev); RUPTURES_METHODS.forEach((m) => next.add(`ruptures-${m.suffix}`)); return next; }),
                  onNone: () => updateSelectedAlgorithms((prev) => { const next = new Set(prev); RUPTURES_METHODS.forEach((m) => next.delete(`ruptures-${m.suffix}`)); return next; }),
                  runTitle: !selectedAudio
                    ? 'Select a song first.'
                    : missing.length === 0
                      ? 'Every Ruptures method already has a cached result for this song.'
                      : `Run ${missing.length} Ruptures method${missing.length === 1 ? '' : 's'} that have no cached result yet for "${selectedAudio.name}".`,
                }))}
                <div className={algoRowsCls}>
                  {RUPTURES_METHODS.map((m) => {
                    const id = `ruptures-${m.suffix}`;
                    const { disabled, pill } = stemRowState(id, !!rupturesResults[m.suffix], STEM_CAPABLE_TOOL_IDS.has(id));
                    const checked = isVis ? selectedAlgoOverlays.has(id) : selectedAlgorithms.has(id);
                    return (
                      <label key={id} className={`flex items-center gap-1.5 select-none ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
                        <input type="checkbox" checked={checked} disabled={disabled} onChange={() => (isVis ? toggleAlgoOverlay(id) : toggleAlgorithm(id))} className={`${accent.checkbox} disabled:cursor-not-allowed`} />
                        <span className={`font-mono ${checked ? 'text-slate-200' : 'text-slate-600'}`}>{m.search}·{m.model}</span>
                        {pill}
                      </label>
                    );
                  })}
                </div>
              </>
            ),
          });
        }

        // ── Experimental families (SPAN / LOOP / CUE extras / LYRICS / PATTERN).
        // Same shape across all — only the algo IDs, label map, feature flag,
        // and optional trailing panel differ. Each becomes its own chip.
        const pushFamily = (
          key: string,
          title: string,
          ids: readonly string[],
          labels: Record<string, string>,
          extra?: ReactNode,
          desc?: string,
        ) => {
          const missing = ids.filter((id) => toolStates[id]?.status !== 'done');
          const canRunMissing = !!selectedAudio && runJob?.status !== 'running' && missing.length > 0;
          sections.push({
            key, label: title, experimental: true,
            total: ids.length, cached: ids.length - missing.length,
            ids: [...ids], visIds: ids.filter((id) => toolStates[id]?.status === 'done'),
            render: () => (
              <>
                {sectionHeader(
                  title,
                  'text-fuchsia-300/80',
                  <span className="inline-block rounded px-1 py-px text-[9px] leading-none uppercase tracking-wider text-slate-400 bg-slate-700/40">experimental</span>,
                  actionCluster({
                    missing, canRunMissing,
                    onRun: (toRun) => handleRunMissingForSection(toRun),
                    onSelectAll: () => updateSelectedAlgorithms((prev) => { const next = new Set(prev); ids.forEach((id) => next.add(id)); return next; }),
                    onNone: () => updateSelectedAlgorithms((prev) => { const next = new Set(prev); ids.forEach((id) => next.delete(id)); return next; }),
                    visIds: ids.filter((id) => toolStates[id]?.status === 'done'),
                    runTitle: !selectedAudio
                      ? 'Select a song first.'
                      : missing.length === 0
                        ? `Every ${title} model already has a cached result for this song.`
                        : `Run ${missing.length} ${title} model${missing.length === 1 ? '' : 's'} that have no cached result yet for "${selectedAudio.name}".`,
                  }),
                )}
                {desc && <div className="mb-1.5 text-[10px] leading-snug text-slate-500">{desc}</div>}
                <div className={algoRowsCls}>
                  {ids.map((id) => {
                    const cached = toolStates[id]?.status === 'done';
                    const { disabled, pill } = stemRowState(id, cached, STEM_CAPABLE_TOOL_IDS.has(id));
                    const checked = isVis ? selectedAlgoOverlays.has(id) : selectedAlgorithms.has(id);
                    return (
                      <label key={id} className={`flex flex-wrap items-center gap-x-1.5 gap-y-0.5 select-none ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
                        <input type="checkbox" checked={checked} disabled={disabled} onChange={() => (isVis ? toggleAlgoOverlay(id) : toggleAlgorithm(id))} className={`${accent.checkbox} disabled:cursor-not-allowed`} />
                        <span className={`font-mono ${checked ? 'text-slate-200' : 'text-slate-600'}`}>{labels[id] ?? id}</span>
                        {algoHint(id)}
                        {bestStemChip(id)}
                        {pill}
                        {!isVis && cached && runJob?.status !== 'running' && (
                          <button
                            onClick={(e) => { e.preventDefault(); handleForceRunForSection([id]); }}
                            className="shrink-0 text-slate-600 hover:text-fuchsia-300 transition-colors text-[10px] leading-none"
                            title={`Re-run ${labels[id] ?? id} (overrides cached result)`}
                          >
                            ↻
                          </button>
                        )}
                      </label>
                    );
                  })}
                </div>
                {extra}
              </>
            ),
          });
        };
        if (settings.experimentalSpanFamily && expAvail.spanFamily) pushFamily(
          'span', 'SPAN',
          ['silero-vad', 'jdcnet-voicing', 'panns-cnn14', 'hpss-percussive'],
          { 'silero-vad': 'Silero-VAD', 'jdcnet-voicing': 'JDCNet', 'panns-cnn14': 'PANNs CNN14', 'hpss-percussive': 'HPSS percussive' },
          undefined,
          'Time-region detectors: where voice, sound types, and drums occur.',
        );
        if (settings.experimentalCueExtras && expAvail.cueExtras) pushFamily(
          'cue-extras', 'CUE extras',
          ['basic-pitch', 'librosa-key', 'autochord-chords', 'librosa-onsets', 'drum-transients'],
          { 'basic-pitch': 'basic-pitch', 'librosa-key': 'librosa key', 'autochord-chords': 'autochord', 'librosa-onsets': 'librosa onsets', 'drum-transients': 'drum transients' },
          undefined,
          'Musical detail: notes, key, chords, onsets, and drum hits.',
        );
        if (settings.experimentalLyricsFamily && expAvail.lyricsFamily) pushFamily(
          'lyrics', 'LYRICS',
          ['whisper-base', 'ctc-forced-aligner'],
          { 'whisper-base': 'Whisper-base', 'ctc-forced-aligner': 'CTC forced aligner' },
          <>
            <div className="flex items-center gap-2 mt-3">
              <label className="text-[11px] text-slate-400 shrink-0">Whisper language</label>
              <select
                value={lyricsLanguage}
                onChange={(e) => setLyricsLanguage(e.target.value)}
                className="flex-1 min-w-0 rounded bg-[#0c0d12] border border-white/[0.08] px-2 py-0.5 text-[11px] text-slate-200 focus:outline-none focus:border-fuchsia-400/40"
              >
                <option value="">Auto-detect</option>
                <option value="af">Afrikaans</option>
                <option value="sq">Albanian</option>
                <option value="ar">Arabic</option>
                <option value="hy">Armenian</option>
                <option value="az">Azerbaijani</option>
                <option value="eu">Basque</option>
                <option value="be">Belarusian</option>
                <option value="bs">Bosnian</option>
                <option value="bg">Bulgarian</option>
                <option value="ca">Catalan</option>
                <option value="zh">Chinese</option>
                <option value="hr">Croatian</option>
                <option value="cs">Czech</option>
                <option value="da">Danish</option>
                <option value="nl">Dutch</option>
                <option value="en">English</option>
                <option value="et">Estonian</option>
                <option value="fi">Finnish</option>
                <option value="fr">French</option>
                <option value="gl">Galician</option>
                <option value="ka">Georgian</option>
                <option value="de">German</option>
                <option value="el">Greek</option>
                <option value="he">Hebrew</option>
                <option value="hi">Hindi</option>
                <option value="hu">Hungarian</option>
                <option value="is">Icelandic</option>
                <option value="id">Indonesian</option>
                <option value="it">Italian</option>
                <option value="ja">Japanese</option>
                <option value="kn">Kannada</option>
                <option value="kk">Kazakh</option>
                <option value="ko">Korean</option>
                <option value="lv">Latvian</option>
                <option value="lt">Lithuanian</option>
                <option value="mk">Macedonian</option>
                <option value="ms">Malay</option>
                <option value="mr">Marathi</option>
                <option value="mi">Maori</option>
                <option value="ne">Nepali</option>
                <option value="no">Norwegian</option>
                <option value="fa">Persian</option>
                <option value="pl">Polish</option>
                <option value="pt">Portuguese</option>
                <option value="ro">Romanian</option>
                <option value="ru">Russian</option>
                <option value="sr">Serbian</option>
                <option value="sk">Slovak</option>
                <option value="sl">Slovenian</option>
                <option value="es">Spanish</option>
                <option value="sw">Swahili</option>
                <option value="sv">Swedish</option>
                <option value="tl">Tagalog</option>
                <option value="ta">Tamil</option>
                <option value="th">Thai</option>
                <option value="tr">Turkish</option>
                <option value="uk">Ukrainian</option>
                <option value="ur">Urdu</option>
                <option value="vi">Vietnamese</option>
                <option value="cy">Welsh</option>
                <option value="yi">Yiddish</option>
              </select>
            </div>
            {/* Repairing one window of a lyrics take. Sits with the two
                detectors it re-runs, and only while a region is highlighted:
                the window IS the highlight, so with nothing selected the panel
                has nothing to transcribe and would only be a pair of zeroes. */}
            {isVis && selectedAudio && rerunSelection && (
              <LyricsRangeRerunPanel
                slug={selectedAudio.id}
                selection={rerunSelection}
                stems={availableStemSources}
                language={lyricsLanguage}
                layerTargets={lyricsMergeTargets}
                onMergeIntoLayer={handleMergeLyricsWindowIntoLayer}
                onCacheMerged={handleLyricsCacheMerged}
                onSeek={(t) => seekRef.current?.(t)}
              />
            )}
            {selectedAudio && <LyricsTextPanel slug={selectedAudio.id} />}
          </>,
          'Lyrics: transcription (Whisper) and word-level alignment of your pasted lyrics (CTC).',
        );
        if (settings.experimentalPatternFamily && expAvail.patternFamily) pushFamily(
          'pattern', 'PATTERN',
          ['locomotif'],
          { 'locomotif': 'LoCoMotif' },
          undefined,
          'Discovers recurring melodic / rhythmic patterns (motifs).',
        );

        // ── Custom detectors — Run picker only. Their OUTPUT is shown in the
        // Detectors sidebar (a detector appears there once it has a result for
        // this song), never among the visibility families here, so this family
        // exists solely to compute them. Each detector reads the one stem it
        // declares, so the "Run on" pill narrows the list to that stem instead
        // of retargeting it; a detector whose stem this song hasn't had
        // separated yet is listed but can't be ticked. ────────────────────────
        if (stacked && !isVis) {
          const stemTarget = runStemSource !== 'mix' && runStemSource !== 'all' ? runStemSource : null;
          const dets = customDetectors
            .filter((d) => d.status === 'ok' && (d.is_algorithm || d.is_annotation))
            .filter((d) => !stemTarget || d.stem === stemTarget)
            .sort((a, b) => stemRank(a.stem) - stemRank(b.stem) || (a.label || a.name).localeCompare(b.label || b.name));
          const needsStem = (d: CustomRegistryEntry) =>
            d.stem && d.stem !== 'mix' && !stemManifest?.stems?.[d.stem] ? d.stem : null;
          const isCached = (d: CustomRegistryEntry) => !!customResults[d.name] && !customResults[d.name].fatal;
          const runnable = dets.filter((d) => !needsStem(d)).map((d) => `custom:${d.name}`);
          const missing = dets.filter((d) => !needsStem(d) && !isCached(d)).map((d) => `custom:${d.name}`);
          const canRunMissing = !!selectedAudio && runJob?.status !== 'running' && missing.length > 0;
          if (dets.length > 0) sections.push({
            key: 'custom', label: 'Custom', experimental: false,
            total: dets.length, cached: dets.filter(isCached).length,
            ids: runnable, visIds: [],
            render: () => (
              <>
                {sectionHeader('Custom', 'text-amber-300/80', null, actionCluster({
                  missing, canRunMissing, amber: true,
                  onRun: (toRun) => handleRunMissingForSection(toRun),
                  onSelectAll: () => updateSelectedAlgorithms((prev) => { const next = new Set(prev); runnable.forEach((id) => next.add(id)); return next; }),
                  onNone: () => updateSelectedAlgorithms((prev) => { const next = new Set(prev); dets.forEach((d) => next.delete(`custom:${d.name}`)); return next; }),
                  runTitle: !selectedAudio
                    ? 'Select a song first.'
                    : missing.length === 0
                      ? 'Every custom detector you can run here already has a result for this song.'
                      : `Run ${missing.length} custom detector${missing.length === 1 ? '' : 's'} that have no result yet for "${selectedAudio.name}".`,
                }))}
                <div className="mb-1.5 text-[10px] leading-snug text-slate-500">
                  Each detector reads its own stem. Results appear in the Detectors sidebar.
                </div>
                {groupByDetectorOrigin(dets, (d) => d.is_default).map((group) => (
                  <div key={group.origin} className="mb-2 last:mb-0">
                    {group.title && (
                      <div className="text-[10px] uppercase tracking-[0.16em] text-amber-300/70 font-medium mb-1">{group.title}</div>
                    )}
                    {[...new Set(group.items.map((d) => d.stem ?? 'mix'))].map((s) => (
                      <div key={s} className="mb-1.5 last:mb-0">
                        <div className="text-[9px] uppercase tracking-[0.16em] text-slate-500 capitalize mb-0.5">{s === 'mix' ? 'Full mix' : s}</div>
                        <div className={algoRowsCls}>
                          {group.items.filter((d) => (d.stem ?? 'mix') === s).map((d) => {
                            const id = `custom:${d.name}`;
                            const missingStem = needsStem(d);
                            const cached = isCached(d);
                            const running = customRunning.has(d.name);
                            const fatal = customResults[d.name]?.fatal;
                            const checked = selectedAlgorithms.has(id);
                            const pill = missingStem ? (
                              <span className="text-slate-600 text-[9px] uppercase tracking-wider cursor-help" title={`Needs the ${missingStem} stem, which this song hasn't had separated yet. Separate stems (Demucs) first.`}>
                                needs {missingStem}
                              </span>
                            ) : running ? (
                              <span className="text-amber-300 text-[9px] uppercase tracking-wider animate-pulse">running</span>
                            ) : fatal ? (
                              <span className="text-red-400 text-[9px] uppercase tracking-wider cursor-help" title={`Failed: ${fatal.message}`}>failed</span>
                            ) : renderStatusPill(id, cached);
                            return (
                              <label
                                key={id}
                                title={d.description || undefined}
                                className={`flex items-center gap-1.5 select-none ${missingStem ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
                              >
                                <input type="checkbox" checked={checked} disabled={!!missingStem} onChange={() => toggleAlgorithm(id)} className={`${accent.checkbox} disabled:cursor-not-allowed`} />
                                <span className={`min-w-0 truncate ${checked ? 'text-slate-200' : 'text-slate-600'}`}>{d.label || d.name}</span>
                                {pill}
                                {cached && !running && runJob?.status !== 'running' && (
                                  <button
                                    onClick={(e) => { e.preventDefault(); handleForceRunForSection([id]); }}
                                    className="shrink-0 text-slate-600 hover:text-amber-300 transition-colors text-[10px] leading-none"
                                    title={`Re-run ${d.label || d.name} (overrides the cached result)`}
                                  >
                                    ↻
                                  </button>
                                )}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </>
            ),
          });
        }

        if (sections.length === 0) return null;
        // Every chip the user has toggled open, in panel order. Several can be
        // expanded at once; each renders its own framed family below the chips.
        const expanded = sections.filter((s) => expandedAlgoTypes.has(s.key));
        // Clicking a family chip both expands/collapses it AND bulk-selects its
        // algos: open → select every algo in the family ("show all"), collapse →
        // deselect them all (don't show them). In visibility mode only cached
        // rows can show, so opening adds just `visIds`; collapsing clears the
        // full `ids` set so nothing lingers selected/visible.
        const onChipToggle = (s: AlgoSection) => {
          const willOpen = !expandedAlgoTypes.has(s.key);
          toggleAlgoType(s.key);
          const apply = isVis ? setSelectedAlgoOverlays : updateSelectedAlgorithms;
          apply((prev) => {
            const next = new Set(prev);
            if (willOpen) (isVis ? s.visIds : s.ids).forEach((id) => next.add(id));
            else s.ids.forEach((id) => next.delete(id));
            return next;
          });
        };
        return (
          <div className="space-y-1.5">
            <nav aria-label="Algorithm families" className={stacked ? 'grid grid-cols-2 gap-1' : 'grid grid-cols-4 gap-1'}>
              {sections.map((s) => {
                const open = expandedAlgoTypes.has(s.key);
                // Under an active stem filter, the chip's "available" count is
                // how many of the family's detectors have a result for that stem
                // — zero for full-mix-only families (MSAF, ruptures, all-in-one,
                // custom), so the card reads honestly before it's even opened.
                const stemCapableFamily = s.ids.some((id) => STEM_CAPABLE_TOOL_IDS.has(baseAlgoId(id)));
                const layerCount = stemFilter
                  ? (stemCapableFamily ? s.ids.filter((id) => stemHasResult(id)).length : 0)
                  : s.cached;
                const title = stemFilter
                  ? (stemCapableFamily
                      ? `${layerCount} of ${s.total} have a ${inspectStemFilter}-stem result — click to ${open ? 'collapse' : 'expand'}`
                      : `${s.label} runs on the full mix only — no ${inspectStemFilter}-stem output`)
                  : `${s.cached} of ${s.total} cached — click to ${open ? 'collapse + deselect all' : 'expand + select all'}`;
                return (
                  <AnnotationTypeChip
                    key={s.key}
                    label={s.label}
                    active={open}
                    experimental={s.experimental}
                    count={s.total}
                    layerCount={layerCount}
                    title={title}
                    onClick={() => onChipToggle(s)}
                  />
                );
              })}
            </nav>
            {expanded.length === 0 ? (
              <div className="px-3 py-2 rounded border border-white/[0.12] bg-white/[0.04] text-[10.5px] text-slate-400 italic">
                Pick one or more families above to show their algorithms.
              </div>
            ) : (
              expanded.map((s) => (
                <div
                  key={s.key}
                  className={`min-w-0 rounded-lg border p-2 ${
                    s.key === 'custom'
                      ? 'border-amber-400/35 bg-amber-500/[0.04] shadow-[0_0_18px_-7px_rgba(251,191,36,0.55)]'
                      : s.experimental
                      ? 'border-fuchsia-400/35 bg-fuchsia-500/[0.04] shadow-[0_0_18px_-7px_rgba(232,121,249,0.55)]'
                      : 'border-cyan-400/35 bg-cyan-500/[0.04] shadow-[0_0_18px_-7px_rgba(34,211,238,0.55)]'
                  }`}
                >
                  {s.render()}
                </div>
              ))
            )}
          </div>
        );
      })()}
    </div>
    );
  };

  // The viz control bar (zoom / signals / annotation-layer pickers / grid …)
  // is rendered in two places: full under the big title, and `compact` inline
  // in the slim sticky transport once the player scrolls away. Both share this
  // identical prop wiring, so it lives in one closure to avoid drift.
  // The sidebars this workspace has on desktop, offered as labelled buttons
  // in the phone's top bar (second row). Each opens its sidebar full-screen.
  const mobileChoiceKey = !selectedAudio ? '' : feature ?? '';
  useEffect(() => {
    if (!isMobile) return;
    setMobileChoices(
      mobileChoiceKey === 'prep' ? [{ id: 'setup', label: 'Song setup' }]
      : mobileChoiceKey === 'annotate' ? [{ id: 'list', label: 'Edit list' }, { id: 'tools', label: 'Annotation tools' }]
      : mobileChoiceKey === 'inspect-song' ? [{ id: 'algorithms', label: 'Algorithms' }, { id: 'detectors', label: 'Detector layers' }]
      : [],
    );
  }, [isMobile, mobileChoiceKey, setMobileChoices]);
  useEffect(() => () => setMobileChoices([]), [setMobileChoices]);

  const renderVizControlBar = (compactBar: boolean) => (
    <VizControlBar
      compact={compactBar}
      showAnnotations={feature !== 'prep'}
      showManual={isInspect(feature) ? false : showManual}
      onToggleManual={setShowManual}
      showBoundariesGroup={!isInspect(feature)}
      showAutoGuess={isInspect(feature) ? visibleAnnotationsInspect.has('__autoguess__') : showAutoGuess}
      onToggleAutoGuess={isInspect(feature) ? () => toggleAnnotationVisibleInspect('__autoguess__') : setShowAutoGuess}
      showProminence={effShowProminence}
      // Prominence reads the annotator's own durational items, which Inspect no
      // longer draws — the switch would toggle an empty lane.
      onToggleProminence={isInspect(feature) ? undefined : setEffShowProminence}
      showConsensus={showConsensus} onToggleConsensus={setShowConsensus}
      consensusAvailable={!!consensusViz}
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
      segmentCount={gridSegments.length}
      overrideCount={getActiveBeatOverrideCount(songInfo)}
      bpm={bpm}
      beatsPerBar={beatsPerBar}
      timeSignature={songInfo?.timeSignature ?? '4/4'}
      snapToGrid={snapToGrid}       onToggleSnapToGrid={setSnapToGrid}
      showSnap={feature === 'annotate' || feature === 'prep'}
      gridLock={gridLock}
      onRequestGridLock={handleRequestGridLock}
      showGridLock={feature === 'annotate' || feature === 'prep'}
      captureGlobalHScroll={captureGlobalHScroll}
      onToggleCaptureGlobalHScroll={setCaptureGlobalHScroll}
      stemLock={stemLock}
      onStemLockChange={isInspect(feature) ? setStemLock : undefined}
      gridLineThickness={gridLineThickness}
      onGridLineThicknessChange={setGridLineThickness}
      gridThicknessAdaptive={gridThicknessAdaptive}
      onGridThicknessAdaptiveChange={setGridThicknessAdaptive}
      effectiveGridLineThickness={effectiveGridLineThickness}
      zoomFactor={vizZoomFactor}
      atMaxZoom={vizAtMaxZoom}
      onZoomIn={() => zoomInRef.current?.()}
      onZoomOut={() => zoomOutRef.current?.()}
      onZoomReset={() => zoomResetRef.current?.()}
      playbackRate={playbackRate}
      onPlaybackRateChange={setPlaybackRate}
      algoOptions={algoOptions}
      algoStemFilter={inspectStemFilter}
      algoStemFilterHiddenCount={algoStemFilterHiddenCount}
      onClearAlgoStemFilter={() => pickStemFilter('all')}
      selectedAlgos={selectedAlgoOverlays}
      onToggleAlgo={toggleAlgoOverlay}
      // Algo Inspect gets the Algos and Detectors dropdowns alongside
      // Annotations / Signals — the same overlay set the inspect sidebar's
      // per-row checkboxes drive, reachable without the sidebar open. The
      // other features have no algo rows and keep their detectors listed
      // inside the Annotations dropdown.
      showAlgos={isInspect(feature)}
      showDetectors={isInspect(feature)}
      singleInfoDetections={isInspect(feature) ? singleInfoDetections : undefined}
      customAnnotationOptions={feature === 'annotate' ? [] : customAnnotationRows.map((r) => ({ id: r.detectorName, label: r.label, color: r.color, isDefault: defaultDetectorNames.has(r.detectorName) }))}
      hiddenCustomAnnotations={hiddenCustomAnnotations}
      onToggleCustomAnnotation={toggleCustomAnnotationVisible}
      boundaryLayerOptions={ownWorkspaceLayers(boundaryLayersList).map((l) => ({
        id: l.id, label: l.name, color: l.color,
        visible: l.visible,
        count: l.items.length,
      }))}
      onToggleBoundaryLayerVisibility={(layerId) => {
        // Visibility is canvas metadata, so it stays out of the undo history.
        setCueLayersDoc((d) => d && ({
          ...d,
          layers: d.layers.map((l) => (l.id === layerId ? { ...l, visible: !l.visible } : l)),
        }), { skipHistory: true });
      }}
      cueLayerOptions={[
        ...ownWorkspaceLayers(cueLayers ?? []).map((l) => ({
          id: l.id, label: l.name, color: l.color,
          visible: l.visible,
          count: l.items.length,
        })),
        ...(isInspect(feature) ? detectorCueLayers.map((l) => ({
          id: l.id,
          label: `${l.name} (detector)`,
          color: l.color,
          isDefault: defaultDetectorNames.has(l.source!.slice('detector:'.length)),
          visible: !hiddenCustomAnnotations.has(l.source!.slice('detector:'.length)),
          count: l.items.length,
        })) : []),
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
        ...ownWorkspaceLayers(spanLayers).map((l) => ({
          id: l.id, label: l.name, color: l.color,
          visible: l.visible,
          count: l.items.length,
        })),
        ...(isInspect(feature) ? detectorSpanLayers.map((l) => ({
          id: l.id,
          label: `${l.name} (detector)`,
          color: l.color,
          isDefault: defaultDetectorNames.has(l.source!.slice('detector:'.length)),
          visible: !hiddenCustomAnnotations.has(l.source!.slice('detector:'.length)),
          count: l.items.length,
        })) : []),
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
        ...ownWorkspaceLayers(loopLayers).map((l) => ({
          id: l.id, label: l.name, color: l.color,
          visible: l.visible,
          count: l.items.length,
        })),
        ...(isInspect(feature) ? detectorLoopLayers.map((l) => ({
          id: l.id,
          label: `${l.name} (detector)`,
          color: l.color,
          isDefault: defaultDetectorNames.has(l.source!.slice('detector:'.length)),
          visible: !hiddenCustomAnnotations.has(l.source!.slice('detector:'.length)),
          count: l.items.length,
        })) : []),
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
      lyricsLayerOptions={settings.experimentalLyricsFamily ? [
        ...ownWorkspaceLayers(lyricsLayers).map((l) => ({
          id: l.id, label: l.name, color: l.color,
          visible: l.visible,
          count: l.items.length,
        })),
        ...(isInspect(feature) ? detectorLyricsLayers.map((l) => ({
          id: l.id,
          label: `${l.name} (detector)`,
          color: l.color,
          isDefault: defaultDetectorNames.has(l.source!.slice('detector:'.length)),
          visible: !hiddenCustomAnnotations.has(l.source!.slice('detector:'.length)),
          count: l.items.length,
        })) : []),
      ] : undefined}
      onToggleLyricsLayerVisibility={(layerId) => {
        const detector = detectorLyricsLayers.find((l) => l.id === layerId);
        if (detector) {
          toggleCustomAnnotationVisible(detector.source!.slice('detector:'.length));
          return;
        }
        setCueLayersDoc((d) => d && ({
          ...d,
          layers: d.layers.map((l) => (l.id === layerId ? { ...l, visible: !l.visible } : l)),
        }), { skipHistory: true });
      }}
      riffPatternLayerOptions={settings.experimentalLoopsAndPatterns ? ownWorkspaceLayers(riffPatternLayers).map((l) => ({
        id: l.id, label: l.name, color: l.color,
        visible: l.visible,
        count: l.items.length,
      })) : undefined}
      onToggleRiffPatternLayerVisibility={(layerId) => {
        setCueLayersDoc((d) => d && ({
          ...d,
          layers: d.layers.map((l) => (l.id === layerId ? { ...l, visible: !l.visible } : l)),
        }), { skipHistory: true });
      }}
    />
  );

  return (
    <div className={`min-h-screen text-slate-200 transition-colors duration-300 ${pageBg}`}>
      {/* ── Grid Lock modals ─────────────────────────────────────────────── */}
      {showNoBpmModal && <NoBpmModal onClose={() => setShowNoBpmModal(false)} />}
      {showGridLockModal && (
        <GridLockModal
          snapCount={countSnappable()}
          unitLabel={beatGridUnitLabel(showBeatGrid && beatGridUnit ? beatGridUnit : 'beat')}
          onConfirm={confirmGridLock}
          onCancel={() => setShowGridLockModal(false)}
        />
      )}
      {/* ── The grid moved under Grid Lock — ms or bar.beat? ──────────────── */}
      {pendingGridChange && (
        <GridChangedModal
          affected={countRetimed(cueLayersDoc, pendingGridChange.from, gridOf(songInfo))}
          changeSummary={pendingGridChange.summary}
          onKeepBeats={applyGridChangeKeepBeats}
          onKeepTimes={applyGridChangeKeepTimes}
          onDiscard={discardGridChange}
          revertSummary={
            pendingGridChange.fromInfo?.bpm
              ? `Back to ${pendingGridChange.fromInfo.bpm} BPM`
              : 'Puts the grid back'
          }
        />
      )}
      {/* ── Autosave failed ──────────────────────────────────────────────── */}
      {/* The grid edit is on screen but not on disk. Silence here used to mean
          the curator kept working on a song the server had stopped taking. */}
      {songInfoSaveState === 'error' && (
        <div className="fixed bottom-[calc(var(--tc-nav-h)+1.5rem)] left-1/2 -translate-x-1/2 w-max max-w-[calc(100vw-1.5rem)] z-[1600] flex items-center gap-3 bg-[#1a0f12] border border-rose-500/50 rounded-xl px-5 py-3 shadow-2xl shadow-black/60 text-[12px] font-mono">
          <span className="text-rose-200">
            Grid not saved — the server didn't take the last change.
          </span>
          <button
            type="button"
            onClick={retrySongInfoSave}
            className="px-3 py-1 rounded border border-rose-300/40 text-rose-100 hover:text-white hover:border-rose-200/70 transition-colors text-[11px]"
          >
            Retry
          </button>
        </div>
      )}
      {/* ── Grid Lock undo toast ─────────────────────────────────────────── */}
      {showGridLockUndoToast && (
        <div className="fixed bottom-[calc(var(--tc-nav-h)+1.5rem)] left-1/2 -translate-x-1/2 w-max max-w-[calc(100vw-1.5rem)] z-[1500] flex items-center gap-3 bg-[#14171d] border border-amber-500/40 rounded-xl px-5 py-3 shadow-2xl shadow-black/60 text-[12px] font-mono">
          <span className="text-amber-200">{gridLockUndoLabel}</span>
          {gridLockUndoRemembered && (
            <button
              type="button"
              onClick={() => { rememberGridChoice(null); setGridLockUndoRemembered(false); }}
              className="px-3 py-1 rounded border border-white/20 text-slate-200 hover:text-white hover:border-white/40 transition-colors text-[11px]"
              title="Stop applying a remembered answer — ask again on the next grid edit"
            >
              Ask me next time
            </button>
          )}
          <button
            type="button"
            onClick={undoGridLockSnap}
            className="px-3 py-1 rounded border border-white/20 text-slate-200 hover:text-white hover:border-white/40 transition-colors text-[11px]"
          >
            Undo
          </button>
          <button
            type="button"
            onClick={() => setShowGridLockUndoToast(false)}
            className="text-slate-500 hover:text-slate-300 transition-colors ml-1"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
      {/* ── Annotation notice toast ──────────────────────────────────────── */}
      {annotationNotice && (
        <div className="fixed bottom-[calc(var(--tc-nav-h)+1.5rem)] left-1/2 -translate-x-1/2 w-max max-w-[calc(100vw-1.5rem)] z-[1500] flex items-center gap-3 bg-[#14171d] border border-sky-500/40 rounded-xl px-5 py-3 shadow-2xl shadow-black/60 text-[12px] font-mono">
          <span className="text-sky-200">{annotationNotice}</span>
          <button
            type="button"
            onClick={() => setAnnotationNotice(null)}
            className="text-slate-500 hover:text-slate-300 transition-colors ml-1"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

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
        {(mode === 'song' || mode === 'prep') && sidebarCollapsed && !isMobile && (
          // In-layout rail (not a floating tab): occupies its own slim column
          // at the start of the flex row, so it can never overlap the song title.
          <aside className="shrink-0 tc-aside self-start border-r border-white/[0.10] bg-[#14171d]/80 backdrop-blur-sm">
            <button
              onClick={() => setSidebarCollapsed(false)}
              title="Show songs"
              className="h-full w-9 flex flex-col items-center gap-3 pt-3 text-slate-300 hover:text-white hover:bg-white/[0.03] transition-colors"
            >
              <span className="text-xl leading-none font-bold">›</span>
              <span className="text-[11px] uppercase tracking-[0.18em] font-semibold" style={{ writingMode: 'vertical-rl' }}>Songs</span>
            </button>
          </aside>
        )}
        {(mode === 'song' || mode === 'prep') && (!sidebarCollapsed || mobilePanel === 'songs') && (
          <aside
            ref={sidebarRef}
            style={{ width: sidebarWidth }}
            data-mobile-open={mobilePanel === 'songs' || undefined}
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
            className={`shrink-0 tc-aside self-start border-r ${sidebarDragActive ? 'border-emerald-400/50 bg-emerald-500/[0.04]' : 'border-white/[0.10] bg-[#14171d]/80'} backdrop-blur-sm flex flex-col relative transition-colors`}
          >
            <div
              data-resize-handle
              onMouseDown={startSidebarResize}
              onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
              title="Drag to resize · double-click to reset"
              className={`absolute top-0 right-0 h-full w-1.5 -mr-0.5 cursor-col-resize z-20 group ${sidebarResizing ? 'bg-sky-500/40' : 'hover:bg-sky-500/30'} transition-colors`}
            >
              <div className={`absolute top-0 right-0 h-full w-px ${sidebarResizing ? 'bg-sky-400' : 'bg-transparent group-hover:bg-sky-400/60'}`} />
            </div>
            <>
                <div className="flex items-center justify-between px-3 h-9 border-b border-white/[0.05] shrink-0">
                  <span className="flex items-baseline gap-2">
                    <span className="text-[13px] uppercase tracking-[0.18em] text-slate-100 font-bold">Songs</span>
                    {corpusStats && (
                      <span
                        className="text-[10px] uppercase tracking-[0.14em] text-slate-500 font-normal"
                        title={`Full corpus: ${corpusStats.songs} songs · ${corpusStats.admins} admin${corpusStats.admins === 1 ? '' : 's'}. The demo tier ships a 3-song CC0 subset; full corpus access is granted by an admin.`}
                      >
                        {audioFiles.length} / {corpusStats.songs} · {corpusStats.admins} admin{corpusStats.admins === 1 ? '' : 's'}
                      </span>
                    )}
                  </span>
                  <button
                    onClick={() => (isMobile ? setMobilePanel(null) : setSidebarCollapsed(true))}
                    title="Hide songs"
                    className="text-slate-500 hover:text-slate-200 transition-colors text-xl leading-none px-1"
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
                    {/* Background stem separation. Uploads queue themselves here
                        (Settings → Research → Stem separation), so this strip is
                        the only place the work is visible while the user moves on
                        to another song. "Clear queue" drops what's still waiting;
                        the running job is cancelled from the SOURCE row. */}
                    {(stemQueue.length > 0 || (demucsJob?.auto && demucsJob.status === 'running')) && (
                      <div className="w-full px-2 py-1.5 rounded border border-cyan-500/25 bg-cyan-500/[0.06] text-[10px] text-cyan-200/90 space-y-0.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate">
                            <span aria-hidden="true">⏳</span>{' '}
                            {demucsJob?.status === 'running'
                              ? `Auto-stemming ${audioFiles.find((f) => f.id === demucsJob.slug)?.name ?? demucsJob.slug}`
                              : 'Auto-stemming queued songs'}
                            {demucsJob?.status === 'running' && demucsJob.progressPct != null
                              ? ` · ${Math.round(demucsJob.progressPct)}%`
                              : ''}
                          </span>
                          {stemQueue.length > 0 && (
                            <button
                              onClick={clearStemQueue}
                              title="Drop every song still waiting in the background stem queue. The job already running is unaffected — cancel that from the SOURCE row."
                              className="shrink-0 text-cyan-300/70 hover:text-cyan-100 underline underline-offset-2"
                            >
                              clear queue
                            </button>
                          )}
                        </div>
                        {stemQueue.length > 0 && (
                          <div
                            className="text-cyan-300/60 truncate"
                            title={stemQueue.map((q) => q.name).join('\n')}
                          >
                            {stemQueue.length} song{stemQueue.length === 1 ? '' : 's'} waiting
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {/* Group by — how the list below is carved up. Sits above the
                    scroll area so the answer to "why is this list shaped like
                    this?" is always on screen, never scrolled past. Hidden
                    while there is nothing to group.

                    Label above, control below: side by side, the sidebar's
                    256px left barely half of it for the select, and the longer
                    modes read as "WHO ELSE ANNOTAT" — a menu that can't say
                    what you picked. */}
                {audioFiles.length > 1 && (
                  <label className="flex flex-col gap-1 px-3 py-1.5 border-b border-white/[0.05] shrink-0 text-[10px] uppercase tracking-[0.14em] text-slate-500">
                    <span className="shrink-0">Group by</span>
                    <select
                      value={songGroupMode}
                      onChange={(e) => setSongGroupMode(e.target.value as SongGroupMode)}
                      title={SONG_GROUP_MODES.find((o) => o.mode === songGroupMode)?.hint}
                      className="w-full min-w-0 bg-transparent text-slate-300 hover:text-white text-[10px] uppercase tracking-[0.14em] border border-white/[0.08] rounded px-1.5 py-0.5 cursor-pointer transition-colors focus:outline-none focus:border-sky-500/50"
                    >
                      {SONG_GROUP_MODES.map((o) => (
                        <option key={o.mode} value={o.mode} title={o.hint} className="bg-[#14171d] text-slate-200">
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="flex-1 overflow-y-auto py-1">
                  {/* Dataset heading. Framed the list before it was grouped and
                      still frames it — the per-artist headings sit underneath. */}
                  {audioFiles.length > 0 && (
                    <>
                      <div className="mt-2 mx-3 text-center text-[10px] uppercase tracking-[0.22em] font-semibold text-slate-300 select-none">
                        {audioFiles.length} {audioFiles.length === 1 ? 'song' : 'songs'}
                      </div>
                      <div
                        role="separator"
                        aria-label="Your dataset"
                        className="mt-3 mb-2 mx-3 flex items-center gap-2 select-none"
                      >
                        <div className="flex-1 h-px bg-gradient-to-r from-amber-400 via-fuchsia-500 to-cyan-400 shadow-[0_0_6px_rgba(217,70,239,0.35)]" />
                        <span className="text-[9px] uppercase tracking-[0.22em] font-semibold text-slate-400">
                          your songs
                        </span>
                        <div className="flex-1 h-px bg-gradient-to-r from-cyan-400 via-fuchsia-500 to-amber-400 shadow-[0_0_6px_rgba(217,70,239,0.35)]" />
                      </div>
                    </>
                  )}
                  {songGroups.map((songGroup) => {
                    // A heading can only fold when it is actually drawn, so a
                    // single-artist corpus can never end up with its whole list
                    // hidden behind a control that isn't there.
                    const groupFolded = showSongGroupHeadings && collapsedSongGroups.has(songGroup.key);
                    const groupHoldsSelection = songGroup.songs.some((song) => song.id === selectedAudio?.id);
                    return (
                      <Fragment key={songGroup.key || '\u0000ungrouped'}>
                        {showSongGroupHeadings && (
                          <button
                            type="button"
                            onClick={() => toggleSongGroup(songGroup.key)}
                            aria-expanded={!groupFolded}
                            title={`${groupFolded ? 'Show' : 'Hide'} the ${songGroup.songs.length} song${songGroup.songs.length === 1 ? '' : 's'} ${songGroupMode === 'artist' ? 'by' : 'under'} ${songGroup.label}`}
                            className={`sticky top-0 z-10 w-full flex items-center gap-1.5 px-3 py-1 text-left bg-[#14171d]/95 backdrop-blur-sm border-y border-white/[0.05] transition-colors hover:bg-white/[0.05] ${
                              groupHoldsSelection ? 'text-violet-300/90' : 'text-slate-400'
                            }`}
                          >
                            <span aria-hidden="true" className={`text-[10px] leading-none shrink-0 transition-transform ${groupFolded ? '' : 'rotate-90'}`}>›</span>
                            <span className={`truncate text-[10px] uppercase tracking-[0.18em] font-semibold ${songGroup.unknown ? 'italic text-slate-500' : ''}`}>
                              {songGroup.label}
                            </span>
                            <span className="ml-auto shrink-0 text-[10px] font-mono text-slate-500">{songGroup.songs.length}</span>
                          </button>
                        )}
                        {!groupFolded && songGroup.songs.map((a) => {
                    // The manifest is already corpus-filtered server-side
                    // (team → data/ songs, demo → data-default/ songs), so
                    // the sidebar can render every entry without
                    // client-side filtering.
                    const status = songStatuses[a.id];
                    const songInfoForRow = songInfos[a.id];
                    // Title first, artist second. Prefer the live song-info
                    // (so a curator's rename shows up without a manifest
                    // refetch), then the manifest's mirrored fields, and fall
                    // back to splitting the "Artist — Title" display name.
                    const { title: songTitle, artist: songArtist } = songNameParts(a, songInfoForRow);
                    const ready = isGridReady(songInfoForRow);
                    const hasBpm = typeof songInfoForRow?.bpm === 'number' && songInfoForRow.bpm > 0;
                    const isSelected = selectedAudio?.id === a.id;
                    const songStorage = storageStats?.perSong.find((s) => s.slug === a.id);
                    // How many annotators have work on this song — empty files
                    // don't count (see /api/song-annotators). The badge is only
                    // drawn when somebody OTHER than you has work here: a "1"
                    // on every song you annotated yourself is noise, and the
                    // status dot beside it already reports your own progress.
                    const annotatorCount = sharingReady ? (sharingReady.counts[a.id] ?? 0) : 0;
                    const { show: showAnnotatorCount, title: annotatorCountTitle } =
                      describeAnnotatorCount(annotatorCount, !!sharingReady?.mine.has(a.id));
                    // A collaborative song says so instead of wearing a head
                    // count: its work lives in one team document, so counting
                    // the per-annotator files left over from before it was
                    // shared would describe the wrong thing.
                    const isCollaborative = !!collaborationReady?.shared.has(a.id);
                    // Per-song annotation tracks aggregated from manual +
                    // auto-guess (built-in tracks, scoped to current annotator)
                    // and user-created layers (cues/spans/loops). The
                    // sidebar collapses these into ONE overall indicator dot
                    // because every track records the same kind of thing —
                    // boundary / marker positions — so a row of G/E/A pills was
                    // misleading. The full breakdown lives in a click-to-open
                    // popover below.
                    const { tracks, manualTracks, autoTracks, manualReviewedCount, overall } = deriveSongTracks({
                      layerSummary: songLayerStatuses[a.id],
                      autoGuess: status,
                      includeLoopsAndPatterns: settings.experimentalLoopsAndPatterns,
                    });
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
                        setBpmWarningSong({ song: a, origin: 'select' });
                        return;
                      }
                      selectAudio(a);
                      setActionsOpenSlug((prev) => (prev === a.id ? null : a.id));
                    };
                    return (
                      <Fragment key={a.id}>
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
                            {/* Title reads first and keeps the row's weight;
                                the artist trails it as a dimmer subtitle. Both
                                halves live on one line so the row height (and
                                the action buttons beside it) stay put. */}
                            {/* Under an ARTIST heading the trailing artist is
                                the heading repeated, so it is dropped and the
                                title gets the whole width. Every other grouping
                                keeps it — there the row is the only place the
                                artist appears. */}
                            <span className="truncate font-mono">
                              {songTitle}
                              {!(showSongGroupHeadings && songGroupMode === 'artist') && songArtist && (
                                <span className="text-slate-500"> — {songArtist}</span>
                              )}
                            </span>
                          </span>
                        <span className="flex items-center gap-1 shrink-0">
                          {/* How many people have work on this song. Reads as a
                              head count, not a status: it says nothing about
                              whether the song is shared — two annotators each
                              keeping their own copy is the ordinary case. */}
                          {isCollaborative ? (
                            <span
                              title="Shared song — one team annotation, edited by one person at a time"
                              className={`shrink-0 rounded border border-emerald-400/30 bg-emerald-400/10 px-1 py-[1px] font-mono text-[9px] leading-none tracking-[0.08em] text-emerald-300/90 transition-opacity ${actionsOpen ? 'opacity-40' : ''}`}
                            >
                              SHARED
                            </span>
                          ) : showAnnotatorCount && (
                            <span className="relative shrink-0">
                              <button
                                type="button"
                                title={`${annotatorCountTitle} — click for names`}
                                aria-label={`${annotatorCountTitle}. Click to see who.`}
                                aria-expanded={annotatorPopoverSlug === a.id}
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setAnnotatorPopoverSlug((prev) => (prev === a.id ? null : a.id));
                                  setStatusPopoverSlug(null);
                                  setActionsOpenSlug(null);
                                }}
                                className={`inline-flex items-center gap-0.5 rounded border border-sky-400/25 bg-sky-400/10 px-1 py-[1px] font-mono text-[9px] leading-none text-sky-300/90 hover:bg-sky-400/20 hover:border-sky-400/45 transition-colors ${actionsOpen ? 'opacity-40' : ''}`}
                              >
                                <svg viewBox="0 0 10 10" className="h-2 w-2" aria-hidden="true" fill="currentColor">
                                  <circle cx="5" cy="3" r="2" />
                                  <path d="M1 9c0-2.2 1.8-3.4 4-3.4S9 6.8 9 9z" />
                                </svg>
                                {annotatorCount}
                              </button>
                              {/* Who they are. A count alone says "you are not
                                  alone here" and then leaves you to guess; the
                                  names are one click behind it rather than in
                                  the list, so the sidebar's routine fetch never
                                  has to carry them. */}
                              {annotatorPopoverSlug === a.id && (
                                <div
                                  ref={annotatorPopoverRef}
                                  role="menu"
                                  onClick={(e) => e.stopPropagation()}
                                  className="absolute right-0 top-full mt-1 z-40 min-w-[190px] rounded-md border border-white/10 bg-slate-900/95 backdrop-blur-sm shadow-xl py-1.5 text-xs font-mono"
                                >
                                  <div className="px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-500 border-b border-white/5">
                                    {annotatorCount} annotator{annotatorCount === 1 ? '' : 's'}
                                  </div>
                                  {annotatorRoster?.slug === a.id && annotatorRoster.state === 'ready' ? (
                                    annotatorRoster.annotators.map((who) => (
                                      <div
                                        key={`${who.name}-${who.items}`}
                                        className="flex items-baseline gap-2 px-3 py-1"
                                      >
                                        <span className={`flex-1 truncate ${who.mine ? 'text-sky-300' : 'text-slate-300'}`}>
                                          {who.name}{who.mine && <span className="text-slate-500"> · you</span>}
                                        </span>
                                        <span className="shrink-0 text-[10px] text-slate-500 tabular-nums">
                                          {who.items} marker{who.items === 1 ? '' : 's'}
                                        </span>
                                      </div>
                                    ))
                                  ) : (
                                    <div className="px-3 py-1 text-slate-500">
                                      {annotatorRoster?.slug === a.id && annotatorRoster.state === 'error'
                                        ? 'Could not load the names'
                                        : 'Loading…'}
                                    </div>
                                  )}
                                </div>
                              )}
                            </span>
                          )}
                          {/* The annotation indicator rides every workspace,
                              Dataset Prep included. It used to be dropped there
                              to keep the rows compact, which left the one screen
                              you prepare a corpus on unable to answer "what have
                              I already annotated?" — so it sits beside the disk
                              total rather than instead of it. */}
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
                                setMarkAllError(null);
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
                                <div className="flex items-center gap-2 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-500 border-b border-white/5">
                                  <span className="flex-1">
                                    {tracks.length === 0
                                      ? 'No annotations yet'
                                      : manualTracks.length === 0
                                        ? `${autoTracks.length} auto only`
                                        : `${manualReviewedCount}/${manualTracks.length} reviewed`}
                                  </span>
                                  {/* One gesture for "I'm done with this song".
                                      Without it, finishing a six-type song means
                                      opening six panels to flip six pills. Only
                                      the types listed below are touched — a type
                                      with no items has no row and no status. */}
                                  {manualTracks.length > 0 && (() => {
                                    const pending = manualTracks.filter((t) => t.state !== 'reviewed');
                                    const busy = markingAllSlug === a.id;
                                    const done = pending.length === 0;
                                    return (
                                      <button
                                        type="button"
                                        disabled={done || busy}
                                        onClick={() => {
                                          void markAllTypesReviewed(
                                            a.id,
                                            pending.map((t) => t.kind as AnnotationLayerType),
                                          );
                                        }}
                                        title={done
                                          ? 'Every annotation type on this song is already reviewed'
                                          : `Mark all ${pending.length} remaining type${pending.length === 1 ? '' : 's'} reviewed`}
                                        className={`shrink-0 rounded px-1.5 py-0.5 border text-[9px] tracking-[0.12em] transition-colors ${
                                          done || busy
                                            ? 'border-white/5 text-slate-600 cursor-not-allowed'
                                            : 'border-emerald-400/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                                        }`}
                                      >
                                        {busy ? '…' : done ? '✓ all' : '✓ mark all'}
                                      </button>
                                    );
                                  })()}
                                </div>
                                {markAllError?.slug === a.id && (
                                  <div className="px-3 py-1 text-[10px] text-red-400 border-b border-white/5">
                                    {markAllError.message}
                                  </div>
                                )}
                                {tracks.length === 0 ? (
                                  <div className="px-3 py-2 text-slate-500">
                                    Start by adding boundaries or cues in the editor.
                                  </div>
                                ) : (() => {
                                  const renderRow = (t: SongTrack) => {
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
                          {/* /prep and Algorithm Inspect add a single neutral
                              disk total — stems + algos + annotations + audio —
                              beside the status dot. The full breakdown lives
                              inside the ⌫ dialog. Color tiers
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
                      </Fragment>
                    );
                  })}
                </div>

                {/* ── Footer: dataset disk-usage breakdown + clear-all ─────── */}
                {storageStats && (mode === 'prep' || feature === 'inspect-song') && (
                  <div className="border-t border-white/[0.05] shrink-0 px-3 py-2 space-y-1.5 bg-[#0f1218]/60">
                    <button
                      onClick={() => setStorageFooterOpen((v) => !v)}
                      title={storageFooterOpen ? 'Hide the disk-usage breakdown' : 'Show the disk-usage breakdown'}
                      aria-expanded={storageFooterOpen}
                      className="w-full text-[11px] uppercase tracking-[0.18em] text-slate-500 font-semibold flex items-center justify-between gap-2 hover:text-slate-300 transition-colors"
                    >
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span className={`text-[9px] leading-none transition-transform duration-150 ${storageFooterOpen ? 'rotate-90' : ''}`}>▶</span>
                        <span className="truncate">Disk · {audioFiles.length} song{audioFiles.length === 1 ? '' : 's'}</span>
                      </span>
                      <span className="font-mono text-slate-300 tabular-nums">{formatBytes(storageStats.totals.totalBytes)}</span>
                    </button>
                    {storageFooterOpen && (<>
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
                    </>)}
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
        <div
          style={{ maxWidth: contentMaxWidth }}
          className={`flex-1 min-w-0 mx-auto ${isMobile ? 'px-2 pt-2' : 'p-4'} pb-[50vh] space-y-3 transition-[max-width] duration-200`}
        >

        {/* Workspace tab header is mounted in App.tsx so its container is
            identical across all workspaces. */}

        {/* ── Dismissible page-purpose banner ──────────────────────────────
             One-liner that tells a first-time user what each workspace is
             for. Dismissed per-workspace via localStorage (see InfoBanner). */}
        {feature === 'prep' && (
          bpm ? (
            <InfoBanner id="prep.v4" title="Dataset Prep" accent="emerald">
              <strong>This song already has a BPM set</strong> ({Math.round(bpm)} BPM).
              You can fine-tune it or re-align the <strong>grid</strong> in the
              <strong> Song setup sidebar on the right</strong> —
              adjust the BPM, nudge the offset, or switch tempo mode
              (<strong>Steady / Mapped / Hand-placed</strong>). When you're happy with it,
              move on to the <strong>Annotator Tool</strong> tab above.
            </InfoBanner>
          ) : (
            <InfoBanner id="prep.v4" title="Dataset Prep" accent="emerald">
              Set <strong>BPM</strong> and align the <strong>grid</strong> for this
              song in the <strong>Song setup sidebar on the right</strong>. Under
              <strong> Tempo</strong>, pick a mode (<strong>Steady / Mapped / Hand-placed</strong>),
              then apply a <strong>detected</strong> BPM chip,
              type one in manually, or tap along under <strong>Check by ear</strong>. Once every song
              has a BPM, move on to the <strong>Annotator Tool</strong> tab above.
            </InfoBanner>
          )
        )}
        {feature === 'annotate' && (
          !bpm ? (
            <InfoBanner id="annotate.v4" title="Annotator Tool" accent="cyan">
              <strong>Set this song's BPM and grid in Dataset Prep first</strong> —
              boundaries and cues snap to the grid, so annotating before a tempo
              is locked won't line up. Open the <strong>Dataset Prep</strong> tab
              above, then come back here.
            </InfoBanner>
          ) : (
            <InfoBanner id="annotate.v4" title="Annotator Tool" accent="cyan">
              Mark the song with <strong>boundaries</strong> (non-overlapping
              sections), <strong>cues</strong> (single point events),
              <strong> spans</strong> (ranged regions that may overlap),
              <strong> loops</strong> (repeating segments with a cycle length),
              and <strong>riff patterns</strong> (motifs composed from reusable
              nodes). Switch
              types in the tab strip under the waveform; the edit list is in the
              panel <strong>below the visualization</strong>, and edits snap to
              the grid. Toggle <strong>signal rows</strong> (spectrogram, chroma,
              …) from the <strong>SIGNALS</strong> menu to surface different audio
              features. Press <strong>?</strong> for all shortcuts.
            </InfoBanner>
          )
        )}
        {feature === 'inspect-song' && (
          <InfoBanner id="inspect-song.v2" title="Algorithm Inspect — per song" accent="violet">
            Tick the algorithms you want in the <strong>right sidebar</strong> and
            hit <strong>Run</strong> — each prediction stacks as a colored timeline
            on the waveform, scored against your <strong>manual annotation</strong>
            (F1 / precision / recall) in the panel <strong>below the
            visualization</strong>. No manual annotation yet? Add one in the
            <strong> Annotator Tool</strong> first so there's a ground truth to
            compare against. Switch to <strong>All songs</strong> (tab just under
            this banner) for dataset-wide totals.
          </InfoBanner>
        )}
        {feature === 'inspect-all' && (
          <InfoBanner id="inspect-all.v2" title="Algorithm Inspect — all songs" accent="violet">
            Choose algorithms via the <strong>⚙ options</strong> button at the top,
            then <strong>Batch run</strong> to evaluate every song at once. The
            aggregate <strong>F1 / precision / recall</strong> table appears below,
            with expandable per-song rows to spot where an algorithm wins or fails.
            Only songs that have a <strong>manual annotation</strong> count toward
            the totals. To add or re-run a single algorithm, use the
            <strong> Per song</strong> tab above.
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
            <div ref={headerBarRef} data-mobile-timeline className={`sticky top-[var(--tc-header-h)] z-50 ${isMobile ? '-mx-2 px-2' : '-mx-4 px-4'} py-2 bg-[#0a0b0d]/95 backdrop-blur space-y-2`}>
              {/* Slim transport — shown once the waveform player scrolls up
                  under the header. One-line title + play/stop + time only;
                  the waveform and BPM tag fall away for a compact look. */}
              {headerCollapsed && (() => {
                const { title, artist } = splitDisplayName(
                  selectedAudio.name ?? '',
                  { title: songInfo?.title ?? selectedAudio.title,
                    artist: songInfo?.title ? songInfo.artist : selectedAudio.artist },
                );
                const fmt = (s: number) => {
                  if (!isFinite(s) || s < 0) s = 0;
                  const m = Math.floor(s / 60);
                  const ss = Math.floor(s % 60).toString().padStart(2, '0');
                  return `${m}:${ss}`;
                };
                return (
                  <div className="flex flex-wrap items-center gap-3 min-w-0">
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={handleTogglePlay}
                        aria-label={playerIsPlaying ? 'Pause' : 'Play'}
                        title={playerIsPlaying ? 'Pause (Space)' : 'Play (Space)'}
                        className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors text-slate-100 ${playerAccent.playBtn}`}
                      >
                        {playerIsPlaying ? (
                          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
                        ) : (
                          <svg className="w-3.5 h-3.5 ml-0.5" fill="currentColor" viewBox="0 0 24 24"><polygon points="5,3 19,12 5,21" /></svg>
                        )}
                      </button>
                      <button
                        onClick={() => { pauseRef.current?.(); seekRef.current?.(0); }}
                        aria-label="Stop"
                        title="Stop (return to start)"
                        className="w-7 h-7 rounded flex items-center justify-center transition-colors bg-white/[0.04] hover:bg-white/[0.10] text-slate-300"
                      >
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="1.5" /></svg>
                      </button>
                    </div>
                    <span className="font-mono text-[11px] text-slate-300 tabular-nums shrink-0 flex flex-col leading-tight">
                      <span>
                        {fmt(playerTime)}<span className="text-slate-600 mx-0.5">/</span><span className="text-slate-500">{fmt(duration)}</span>
                      </span>
                      {bpm && bpm > 20 && (() => {
                        const { bar, beat } = formatBeatPosition(
                          playerTime, bpm, songInfo?.gridOffset ?? 0,
                          beatsPerBarFromTimeSignature(songInfo?.timeSignature),
                          settings.barBeatOrigin,
                        );
                        return (
                          <span className="text-[9px] text-amber-400/80 leading-none mt-0.5">
                            Bar {bar} · Beat {beat}
                          </span>
                        );
                      })()}
                    </span>
                    {/* flex-1 (0 basis): the title soaks up whatever width is
                        left on its line and truncates, instead of pushing the
                        controls out of the column. */}
                    <span className={`flex-1 text-sm font-semibold text-white truncate min-w-0 ${isMobile ? 'hidden' : ''}`}>
                      {title}
                      {artist && <span className="font-normal text-slate-500"> · {artist}</span>}
                    </span>
                    {/* Slim versions of the viz controls (zoom / signals /
                        annotation layers / grid …) ride along on the right —
                        dropping to their own line (the row wraps) when the
                        column is too narrow to hold them beside the title.
                        Not shrink-0: the column is bounded by the Detectors /
                        Annotate sidebars, and an unshrinkable row spills across
                        them instead of staying inside it. */}
                    <div className="ml-auto min-w-0">
                      {renderVizControlBar(true)}
                    </div>
                  </div>
                );
              })()}
              {!headerCollapsed && (<>
              {/* On a phone the top bar already names the song. */}
              <div className={`flex items-center justify-between gap-3 ${isMobile ? 'hidden' : ''}`}>
                {/* Material-style title block: the song title reads big and
                    bold; the artist drops to a smaller, greyed subtitle line
                    beneath it. Prefer the explicit songInfo title/artist;
                    otherwise split the "Artist — Title" file-name convention. */}
                <div className="min-w-0">
                  {(() => {
                    const { title, artist } = splitDisplayName(
                      selectedAudio.name ?? '',
                      { title: songInfo?.title ?? selectedAudio.title,
                        artist: songInfo?.title ? songInfo.artist : selectedAudio.artist },
                    );
                    return (
                      <>
                        <h2 className="text-3xl font-bold text-white leading-tight truncate tracking-tight">{title}</h2>
                        {artist && (
                          <p className="text-base sm:text-lg font-medium text-slate-400 leading-tight truncate">{artist}</p>
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>
              {feature === 'annotate' && selectedAudio && (annotationLock.shared || !!adminStatus?.isAdmin) && (
                <AnnotationLockBar
                  slug={selectedAudio.id}
                  shared={annotationLock.shared}
                  isAdmin={!!adminStatus?.isAdmin}
                  lock={annotationLock.lock}
                  stance={annotationLock.stance}
                  busy={annotationLock.busy}
                  error={annotationLock.error}
                  youAre={annotationLock.youAre}
                  hasUnsavedEdits={blockedByLock}
                  onDocumentReplaced={() => {
                    void annotationLock.refresh();
                    if (selectedAudio) selectAudio(selectedAudio);
                  }}
                  onTake={() => { void annotationLock.takeLock(); }}
                  onRelease={() => { void annotationLock.releaseLock(); }}
                  onTakeOver={() => { void annotationLock.takeOver(); }}
                />
              )}
              <div className="flex flex-wrap items-start gap-2">
                <div className="flex-1 min-w-0">
                  {renderVizControlBar(false)}
                </div>
              </div>
              </>)}
            </div>

            {/* Run options panel — opens below the control bar when ⚙ is on */}
            {feature === 'prep' && runOptionsScope === 'song' && renderRunOptionsPanel(false)}
            <div ref={playerWrapRef} data-mobile-timeline>
            <SharedVizPanel
              playerUrl={playerUrl}
              trackName={selectedAudio.name}
              audioBuffer={audioBuffer}
              duration={duration}
              currentTime={playerTime}
              getTimeRef={getTimeRef}
              externalTimeRef={externalTimeRef}
              bpm={bpm}
              timeSignature={songInfo?.timeSignature}
              beatOffset={beatOffset}
              beatsPerBar={beatsPerBar}
              // The chosen mode (Steady / Mapped / Hand-placed) is the final
              // verdict everywhere: Steady suppresses the segment map so the
              // grid falls back to the global BPM in every workspace,
              // regardless of any map still parked on disk.
              gridSegments={gridSegments}
              // The lane is the DataPrep editing surface; other workspaces
              // read the segmented grid but never reshape it.
              showGridSegmentLane={feature === 'prep' && gridMapActive}
              selectedSegmentId={selectedSegmentId}
              // The chip on the cut bar, not the lane highlight: it goes up
              // with the segment's editor and comes down with it. The lane
              // keeps its selection after the editor closes — a chip that
              // outlived the popover would be back to sitting on the audio
              // for the rest of the session.
              cutLabelSegmentId={segmentPopover.open ? selectedSegmentId : null}
              onSegmentSelect={(seg, at) => {
                setSelectedSegmentId(seg.id);
                segmentPopover.openAt('grid-segments', seg.id, at);
              }}
              onSegmentHeadDrag={canEditGrid ? handleSegmentHeadDrag : undefined}
              onDeleteGridSegment={canEditGrid ? handleMergeGridSegment : undefined}
              onSplitGridAt={canEditGrid ? handleSplitGridAt : undefined}
              snapSegmentTime={snapSegmentTime}
              segmentSnapOn={segmentSnapOn}
              // Manual-mode per-beat overrides. Only apply when the mode
              // is 'manual'; in static/dynamic the map (if present) is
              // orphan data until the curator re-enters Manual.
              beatOverrides={effectiveGridMode(songInfo) === 'manual' ? songInfo?.beatOverrides : undefined}
              // Only prep mode renders anchor flags + the manual editor row.
              gridMode={feature === 'prep' ? effectiveGridMode(songInfo) : undefined}
              onBeatDrag={feature === 'prep' && (adminStatus?.isAdmin || isDemo) ? handleBeatDrag : undefined}
              onClearBeatOverride={feature === 'prep' && (adminStatus?.isAdmin || isDemo) ? handleClearBeatOverride : undefined}
              manualEditLocked={!(adminStatus?.isAdmin || isDemo)}
              showBeatGrid={showBeatGrid}
              beatGridUnit={beatGridUnit}
              snapToGrid={snapToGrid || gridLock}
              snapTimeOverride={vizSnapOverride}
              captureGlobalHScroll={captureGlobalHScroll}
              gridLineThickness={effectiveGridLineThickness}
              stemSource={selectedStemSource}
              availableStemSources={availableStemSources}
              onStemSourceChange={pickPlayerStem}
              onRunStems={feature === 'prep' && selectedAudio && !isDemo ? () => handleStemSong(selectedAudio, { model: stemModel }) : undefined}
              stemModel={stemModel}
              onStemModelChange={setStemModel}
              runStemsModel={demucsJob?.slug === selectedAudio?.id ? demucsJob?.model : undefined}
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
                ? dismissDemucsError
                : undefined}
              onGridOffsetChange={handleGridOffsetDrag}
              showBarNumbers={showBeatGrid}
              autoGuessPoints={feature === 'prep' ? [] : (refAutoGuessPoints ?? displayAutoGuessPoints)}
              pendingSelection={isAnnotateFeature && supportsPending(activeAnnotationType, activeBoundarySource ?? undefined) ? pendingAnnotationSelection : null}
              boundaryLayers={
                feature === 'prep' || isInspect(feature) || !showManual
                  ? []
                  : boundaryLayersList
              }
              showManual={feature === 'prep' || isInspect(feature) ? false : showManual}
              showAutoGuess={feature === 'prep' ? false : isInspect(feature) ? visibleAnnotationsInspect.has('__autoguess__') : showAutoGuess}
              showProminence={feature === 'prep' ? false : effShowProminence}
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
              algoOverlays={feature === 'prep' ? [] : [
                ...(isInspect(feature) ? algoOverlays : []),
                ...proposedLayers(detectorBoundaryOverlays),
              ]}
              cueLayers={feature === 'prep' ? [] : [
                ...ownWorkspaceLayers(cueLayers ?? []),
                ...proposedLayers(detectorCueLayers).filter((l) => !hiddenCustomAnnotations.has(l.source!.slice('detector:'.length))),
              ]}
              focusedCue={focusedCue}
              onCueClick={(layerId, itemId, anchor) => cuePopover.openAt(layerId, itemId, anchor)}
              onCueDrag={feature === 'prep' ? undefined : handleCueDrag}
              onCueDragStart={feature === 'prep' ? undefined : handleDragGestureStart}
              loopLayers={feature === 'prep' || !settings.experimentalLoopsAndPatterns ? [] : [
                ...ownWorkspaceLayers(loopLayers),
                ...proposedLayers(detectorLoopLayers).filter((l) => !hiddenCustomAnnotations.has(l.source!.slice('detector:'.length))),
              ]}
              focusedLoop={focusedLoop}
              playingLoopId={loopPlayback.playingId}
              onLoopClick={(layerId, itemId, anchor) => loopPopover.openAt(layerId, itemId, anchor)}
              onLoopEdgeDrag={feature === 'prep' ? undefined : handleLoopEdgeDrag}
              onLoopEdgeDragStart={feature === 'prep' ? undefined : handleDragGestureStart}
              onLoopMove={feature === 'prep' ? undefined : handleLoopMove}
              onLoopMoveStart={feature === 'prep' ? undefined : handleDragGestureStart}
              spanLayers={feature === 'prep' ? [] : [
                ...ownWorkspaceLayers(spanLayers),
                ...proposedLayers(detectorSpanLayers).filter((l) => !hiddenCustomAnnotations.has(l.source!.slice('detector:'.length))),
              ]}
              focusedSpan={focusedSpan}
              onSpanClick={(layerId, itemId, anchor) => spanPopover.openAt(layerId, itemId, anchor)}
              onSpanEdgeDrag={feature === 'prep' ? undefined : handleSpanEdgeDrag}
              onSpanEdgeDragStart={feature === 'prep' ? undefined : handleDragGestureStart}
              onSpanMove={feature === 'prep' ? undefined : handleSpanMove}
              onSpanMoveStart={feature === 'prep' ? undefined : handleDragGestureStart}
              onSpanProminenceChange={feature === 'prep' ? undefined : handleProminenceChange}
              spanProminenceEdit={spanPopover.open && prominenceEditing
                ? { layerId: spanPopover.open.layerId, itemId: spanPopover.open.itemId }
                : null}
              onLoopProminenceChange={feature === 'prep' ? undefined : handleProminenceChange}
              loopProminenceEdit={loopPopover.open && prominenceEditing
                ? { layerId: loopPopover.open.layerId, itemId: loopPopover.open.itemId }
                : null}
              onRiffPatternProminenceChange={feature === 'prep' ? undefined : handleProminenceChange}
              riffPatternProminenceEdit={riffPatternPopover.open && prominenceEditing
                ? { layerId: riffPatternPopover.open.layerId, itemId: riffPatternPopover.open.itemId }
                : null}
              // A breakpoint is "the vocal takes the lead HERE" — a musical
              // instant like every other time on this page, so it goes through
              // the same snap the band drags do, and does nothing while Snap
              // to grid and Grid Lock are both off.
              snapProminenceTime={snapToGridIfEnabled}
              riffPatternLayers={feature === 'prep' || !settings.experimentalLoopsAndPatterns ? [] : [
                ...ownWorkspaceLayers(riffPatternLayers),
                ...proposedLayers(detectorRiffLayers).filter((l) => !hiddenCustomAnnotations.has(l.source!.slice('detector:'.length))),
              ]}
              focusedRiffPattern={focusedRiffPattern}
              onRiffPatternItemMove={feature === 'prep' ? undefined : handleRiffPatternMove}
              onRiffPatternItemMoveStart={feature === 'prep' ? undefined : handleDragGestureStart}
              onRiffPatternItemClick={(layerId, itemId, anchor) => {
                setSelectedRiffPatternLayerId(layerId);
                setRiffAutoExpandIndex(null);
                riffPatternPopover.openAt(layerId, itemId, anchor);
              }}
              onRiffPatternEntryClick={(layerId, itemId, entryIndex, _leafNodeId, anchor) => {
                // A block that IS a node (not wrapped in a combo) goes straight
                // to the Node popup — clicking the thing on the canvas should
                // open that thing's editor, not the parent instance's. A combo
                // (or silence) block opens the Instance popup pre-expanded to
                // it — a nested node's own beats now render inline right
                // there (see RiffPatternEditPopover), so there's no need to
                // ask which popup the click meant.
                const layer = riffPatternLayers.find((l) => l.id === layerId);
                const entry = layer?.items.find((it) => it.id === itemId)?.sequence[entryIndex];
                const resolved = entry ? resolveRiffId(entry.type, layer?.nodes ?? [], layer?.combos ?? []) : null;
                if (resolved?.kind === 'node') {
                  setNodePopoverEntryCtx({ patternItemId: itemId, entryIndex });
                  nodePopover.openAt(layerId, resolved.item.id, anchor);
                  return;
                }
                setSelectedRiffPatternLayerId(layerId);
                setRiffAutoExpandIndex(entryIndex);
                riffPatternPopover.openAt(layerId, itemId, anchor);
              }}
              onRiffPatternEntryResize={(layerId, itemId, entryIndex, newLengthSteps, gestureKey) => {
                setCueLayersDoc((d) => d && ({
                  ...d,
                  layers: d.layers.map((l) => {
                    if (l.id !== layerId || l.type !== 'riff-patterns') return l;
                    return {
                      ...l,
                      items: l.items.map((it) => {
                        if (it.id !== itemId) return it;
                        const item = it as RiffPatternItem;
                        return {
                          ...item,
                          sequence: item.sequence.map((e, i) => (i === entryIndex ? { ...e, lengthSteps: newLengthSteps } : e)),
                        };
                      }),
                    } as AnnotationLayer;
                  }),
                // One undo step per drag, not per mousemove — the lane row
                // hands out a fresh key on each press.
                }), gestureKey ? { coalesceKey: gestureKey } : undefined);
              }}
              onRiffNodeTrim={(layerId, nodeId, lengthBeats, gestureKey) =>
                handleRiffNodeTrim(layerId, nodeId, lengthBeats, gestureKey)}
              lyricsLayers={feature === 'prep' || !settings.experimentalLyricsFamily ? [] : [
                ...ownWorkspaceLayers(lyricsLayers),
                ...proposedLayers(detectorLyricsLayers).filter((l) => !hiddenCustomAnnotations.has(l.source!.slice('detector:'.length))),
              ]}
              focusedLyrics={focusedLyrics}
              onLyricsClick={(layerId, itemId, anchor) => {
                setFocusedLyrics({ layerId, itemId });
                lyricsPopover.openAt(layerId, itemId, anchor);
              }}
              onLyricsSeek={(t) => seekRef.current?.(t)}
              onLyricsDrag={feature === 'prep' ? undefined : handleLyricsDrag}
              onLyricsDragStart={feature === 'prep' ? undefined : handleDragGestureStart}
              onLyricsEdgeDrag={feature === 'prep' ? undefined : handleLyricsEdgeDrag}
              onLyricsEdgeDragStart={feature === 'prep' ? undefined : (() => handleDragGestureStart())}
              activeAnnotationType={activeAnnotationType}
              selectedLayerIdByType={selectedLayerIdByType}
              onSelectLayer={handleUnifiedSelectLayer}
              onAlgoOverlaySelect={(id) => setSelectedLyricsAlgoId(
                id && new Set<string>(LYRICS_ALGO_IDS).has(baseAlgoId(id)) ? id : null,
              )}
              onRenameLayer={isAnnotateFeature ? handleVizLayerRename : undefined}
              onVizClick={handleVizClick}
              onVizRegion={handleVizRegion}
              onRegionDragStart={() => setPendingAnnotationSelection(null)}
              onManualBoundaryChange={handleManualBoundaryChange}
              onManualSectionClick={(layerId, idx, anchor) => {
                // Drag stays live under every chip. The in-panel popover only
                // renders while the (always-mounted, otherwise `display:none`d)
                // boundaries panel is visible, so route through it when that
                // chip is active; every other chip opens the page-level twin
                // (boundaryPopover) instead, so boundaries stay clickable as
                // read-along context from any tab (e.g. Lyrics).
                const layer = boundaryLayersList.find((l) => l.id === layerId);
                const item = layer?.items[idx];
                if (!item) return;
                if (activeAnnotationType === 'boundaries' && activeBoundarySource === 'manual'
                    && layerId === activeBoundaryLayer?.id) {
                  openManualEditorRef.current?.(idx, anchor);
                } else {
                  boundaryPopover.openAt(layerId, item.id, anchor);
                }
              }}
              onMarkCorrect={(id) => updateAutoGuessPoint(id, { status: 'correct' })}
              onMarkIncorrect={(id) => updateAutoGuessPoint(id, { status: 'incorrect' })}
              onMarkPending={(id) => updateAutoGuessPoint(id, { status: 'pending' })}
              customAnnotationRows={isAnnotateFeature ? [] : customAnnotationRows}
              hiddenCustomAnnotations={hiddenCustomAnnotations}
              onCustomAnnotationMarkCorrect={(det, id) => updateCustomAnnotationOverride(det, id, { status: 'correct' })}
              onCustomAnnotationMarkIncorrect={(det, id) => updateCustomAnnotationOverride(det, id, { status: 'incorrect' })}
              onCustomAnnotationMarkPending={(det, id) => updateCustomAnnotationOverride(det, id, { status: 'pending' })}
              detectorLayerReview={detectorLayerReview}
              onDetectorLayerAccept={(layerId, itemId) => handleDetectorLayerReview(layerId, itemId, 'accepted')}
              onDetectorLayerReject={(layerId, itemId) => handleDetectorLayerReview(layerId, itemId, 'rejected')}
              onCopyDetectorLayer={handleCopyDetectorVizLayer}
              detectorLayerCopyCounts={detectorLayerCopyCounts}
              onCopyAlgoOverlay={handleCopyAlgoOverlay}
              algoCopyCounts={algoCopyCounts}
              mergeLanes={mergeLanes}
              mergeBoundaries={mergeBoundaries}
              onMergeAddLane={handleMergeAddLane}
              onMergeRemoveLane={handleMergeRemoveLane}
              onMergeClear={handleMergeClear}
              onMergeToggleBoundary={handleMergeToggleBoundary}
              onMergeRestoreDropped={handleMergeRestoreDropped}
              onMergeCommit={handleMergeCommit}
              mergeCommittedCount={mergeCommittedCount}
              mergeCommittedNote={mergeCommitNote}
              consensusBlocks={showConsensus ? consensusViz?.blocks : undefined}
              consensusRefMisses={consensusViz?.refMisses}
              consensusReferenceLabel={consensusViz?.referenceLabel}
              consensusTolerance={consensusViz?.tolerance}
              onHideConsensus={() => setShowConsensus(false)}
              onCopyConsensus={consensusViz ? handleCopyConsensus : undefined}
              consensusCopyCount={consensusCopyCount}
              seekRef={seekRef}
              playRef={playRef}
              pauseRef={pauseRef}
              wsScrollRef={wsScrollRef}
              zoomInRef={zoomInRef}
              zoomOutRef={zoomOutRef}
              zoomResetRef={zoomResetRef}
              getZoomFocusTime={getZoomFocusTime}
              onLeadRangeChange={setLeadPendingRange}
              pinchZoomInRef={pinchZoomInRef}
              pinchZoomOutRef={pinchZoomOutRef}
              scrollToTimeRef={scrollToTimeRef}
              zoomToRangeRef={zoomToRangeRef}
              onBufferReady={(buf) => { setAudioBuffer(buf); setDuration(buf.duration); }}
              onTimeUpdate={handlePlayerTime}
              onPlayingChange={setPlayerIsPlaying}
              playbackRate={playbackRate}
              onScrollChange={handleScrollChange}
              onViewChange={handleViewChange}
              vizScrollContainerRef={vizScrollContainerRef}
              vizSignalWidth={vizSignalWidth}
              vizZoomFactor={vizZoomFactor}
              onVizScroll={handleVizScroll}
              playerIsPlaying={playerIsPlaying}
              onSeekAndPlay={handleSeekAndPlay}
              onPause={handlePause}
              previewRegion={previewRegion}
              previewIsPlaying={playerIsPlaying || previewIsLooping}
              onPreviewRegionChange={handlePreviewRegionChange}
              onPreviewPlay={handlePreviewPlay}
              onPreviewPause={handlePreviewPause}
              onPreviewDismiss={handlePreviewDismiss}
              onPreviewEnd={handlePreviewEnd}
              onPreviewLoopToggle={handlePreviewLoopToggle}
              leadCandidates={leadCandidates}
              onAssignLead={handleAssignLead}
              onSetLevel={handleSetProminenceLevel}
              rowOrder={rowOrder}
              onReorderRow={handleReorderRow}
              onSetSignalShown={handleSetSignalShown}
              // Groups belong to the Annotator canvas only. Dataprep draws no
              // authored lanes at all and Algorithm Inspect keeps them off
              // until you ask for them, so a band in either place would be a
              // header over nothing, carrying controls that edit lanes the
              // workspace is not showing. Withholding rowGroupId is what
              // suppresses it: buildGroupedRowOrder splices no header without
              // one, and groupMenuForRow drops the lane-label ⋮ as soon as its
              // callbacks are gone.
              layerGroups={isAnnotateFeature ? layerGroups : []}
              rowGroupId={isAnnotateFeature ? rowGroupId : undefined}
              groupState={isAnnotateFeature ? groupState : undefined}
              onGroupToggleCollapsed={isAnnotateFeature ? handleGroupToggleCollapsed : undefined}
              onGroupSetVisible={isAnnotateFeature ? handleGroupSetVisible : undefined}
              onGroupRename={isAnnotateFeature ? handleGroupRename : undefined}
              onGroupUngroup={isAnnotateFeature ? handleGroupUngroup : undefined}
              onGroupDelete={isAnnotateFeature ? handleGroupDelete : undefined}
              onCreateGroupFromLayer={isAnnotateFeature ? handleCreateGroupFromLayer : undefined}
              onMoveLayerToGroup={isAnnotateFeature ? handleMoveLayerToGroup : undefined}
              groupableRowIds={isAnnotateFeature ? groupableRowIds : undefined}
              onDropRowInGroup={isAnnotateFeature ? handleDropRowInGroup : undefined}
              hasCustomRowOrder={hasCustomRowOrder}
              onResetRowOrder={handleResetRowOrder}
              sectionColorOverrides={feature === 'prep' ? undefined : sectionColorOverrides}
              onSectionColorChange={feature === 'prep' ? undefined : handleSectionColorChange}
              onResetSectionColors={feature === 'prep' ? undefined : handleResetSectionColors}
              boundaryColoringMode={feature === 'prep' ? undefined : boundaryColoringMode}
              onBoundaryColoringModeChange={feature === 'prep' ? undefined : setBoundaryColoringMode}
              layerAudioConfig={feature === 'prep' ? undefined : layerAudioConfig}
              onLayerAudioChange={feature === 'prep' ? undefined : ((id, cfg) => setLayerAudioConfig((prev) => ({ ...prev, [id]: cfg })))}
              playerAccent={playerAccent}
              hidePlaybackIcon={feature !== 'annotate'}
              // Phone: the transport under the waveform already shows the
              // time, and the painted band shows the selection — the large
              // readout pair would fill half the screen above them.
              hideTimeDisplay={feature === 'prep' || isMobile}
            />
            </div>
            {/* Karaoke view — readable, playback-synced complement to the dense
                lyrics canvas row. Only on the Lyrics tab so it doesn't displace
                other tabs' review cards, and never in Algorithm Inspect, which
                gives the karaoke a tab of its own: one home per workspace, so
                the same panel can't appear twice on one screen. */}
            {activeAnnotationType === 'lyrics' && karaokeLyrics && feature !== 'inspect-song' && (
              <div className="mt-2">
                {renderKaraokePanel()}
              </div>
            )}
          </>
        )}

        {/* ── Inspect header — the subject, then the views of it ───────────
            "Examine" names WHAT is being inspected and every tab under it is a
            view of that, so it goes on top, once, above everything. */}
        {feature === 'inspect-song' && (
          <div className="border-b border-white/[0.05]">
            {/* Row 1 — the subject. InspectKindDropdown hides itself when only
                one kind is available, so the default workspace carries no band
                here at all. */}
            <InspectKindDropdown
              value={inspectKind}
              options={inspectKindOptions}
              onChange={handleInspectKindChange}
            />
            {/* Row 2 — the views. Evaluation is the one that exists for every
                examined kind, so it anchors the strip and the conditional tabs
                append after it instead of shuffling it sideways. */}
            <div className="flex items-center gap-4">
              {(([
                ['eval', 'Evaluation'] as const,
                // Consensus Inspect aggregates boundaries only — it's omitted
                // for every other examined kind.
                ...(inspectKind === 'boundaries' ? [['algo', 'Consensus Inspect'] as const] : []),
                // And the karaoke appears only while a lyrics layer is focused,
                // which is the click that asked for it.
                ...(karaokeTabAvailable ? [['karaoke', 'Karaoke'] as const] : []),
              ]) as readonly (readonly [InspectSubStage, string])[]).map(([sub, label]) => (
                <button
                  key={sub}
                  onClick={() => setInspectSubStage(sub)}
                  className={`px-1 py-1 text-lg sm:text-xl font-semibold tracking-tight transition-colors border-b-2 -mb-px ${
                    inspectStage === sub
                      ? `${accent.tabBorderActive} ${accent.tabTextActive}`
                      : 'border-transparent text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* "Reference from" belongs under the tabs, not up on the subject row:
            it is not a second axis of what you're examining, it is the first
            half of what you're scoring against — whose annotations count as
            truth — with the stage's own "Evaluate vs" (which of their layers)
            as the second half, on the same line at the right.

            And it is a BOUNDARIES control. Everything it moves is a boundary
            reading: the reference sections Consensus Inspect and the boundaries
            table score against, and the auto-guess points on the canvas. The
            per-kind Evaluation tables (cues, spans, loops, lyrics)
            fetch against the signed-in user and ignore it entirely — so on any
            other Examine kind it is a dropdown that changes nothing you are
            looking at, and it stays out of the way until boundaries are back. */}
        {/* Evaluation lays out its own header, so the picker goes on the row
            above it; Consensus Inspect takes it as `leading` and puts it on the
            same line as "Evaluate vs". Nothing renders it on the Karaoke tab —
            there is no reference in reading the words. */}
        {inspectStage === 'eval' && referencePicker && (
          <div className="flex items-center pt-2">{referencePicker}</div>
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
                  {/* DataPrep Song details + Metronome live in the right-edge
                      prep sidebar (see the `feature === 'prep'` aside near the
                      Annotate / Algo sidebars), keeping the grid controls
                      beside the waveform instead of stacked below it. */}
                  {feature !== 'prep' && (
                  <div className="mt-3">
                  <div className="flex items-baseline gap-2 mb-2 px-0.5">
                    <span className="text-[11px] uppercase tracking-[0.18em] text-slate-300 font-semibold">Current edited layer:</span>
                    <span className="text-[13px] font-semibold text-slate-100">
                      {TAB_CONFIG.find((t) => t.id === activeAnnotationType)?.label ?? ''}
                      {(() => {
                        const src = activeSourceByType[activeAnnotationType];
                        const label = src === 'manual' ? 'Manual'
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
                    // For boundaries the per-source panels (Manual / Auto-guess)
                    // mount below; only detector:<X> on boundaries falls into the
                    // detector branch.
                    const category: AnnotationCategory = activeAnnotationType;
                    const source = activeSourceByType[category];
                    if (source === 'manual') return null;
                    // Riff patterns are hand-composed in the riff window — no
                    // detector emits them, so there is no foreign source to
                    // review and the manual editor always owns the surface.
                    if (category === 'riff-patterns') return null;
                    if (source === 'autoGuess') {
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
                      if (!envelope) {
                        return (
                          <div className="p-4 rounded border border-white/[0.06] bg-white/[0.02] text-[12px] text-slate-400">
                            <span className="font-medium text-slate-300">{det?.label ?? detectorName}</span> hasn't
                            been run on this song yet. Open the Custom Detectors page to run it,
                            then come back to review its output.
                          </div>
                        );
                      }
                      // Pattern items are not reviewable (they become riff
                      // nodes, not accept/reject rows), and never reach this
                      // panel — `category` is a ReviewableCategory.
                      const items = (doc ?? envelope).items as ReviewableItem[];
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
                          onSeekAndPlay={handleSeekAndPlay}
                          onPause={handlePause}
                          playerIsPlaying={playerIsPlaying}
                          playerTime={playerTime}
                          bpm={bpm}
                          gridOffset={songInfo?.gridOffset ?? 0}
                          beatsPerBar={beatsPerBar}
                          segments={mapSegments}
                        />
                      );
                    }
                    return null;
                  })()}
                  {/* The Boundaries editor stays mounted under every chip
                      (hidden when another type is selected) so its boundary
                      markers remain draggable on the viz regardless of the
                      sidebar selection — same as the other layer types, whose
                      edit state also lives page-level and is always editable.
                      The wrapper is stable across chip switches so the panel
                      never unmounts; only its visibility (here) is gated. */}
                  {(() => {
                    const manualActive = activeAnnotationType === 'boundaries' && activeBoundarySource === 'manual';
                    return (
                      <div style={manualActive ? undefined : { display: 'none' }}>
                        <BoundaryEditorPanel
                          ref={manualPanelRef}
                          onCapabilitiesChange={setManualCaps}
                          saveStatus={layersDocSaveStatus}
                          songId={selectedAudio.id}
                          currentTime={playerTime}
                          duration={duration}
                          songBpm={songInfo?.bpm}
                          songBeatsPerBar={beatsPerBar}
                          songGridOffset={songInfo?.gridOffset ?? 0}
                          doc={cueLayersDoc ?? emptyLayersDoc(selectedAudio.id)}
                          onDocChange={(next, opts) => setCueLayersDoc(
                            // The panel writes through an updater so two edits
                            // inside one click compose; resolve it against the
                            // live doc, not the render-old copy it was handed.
                            (prev) => (typeof next === 'function'
                              ? next(prev ?? emptyLayersDoc(selectedAudio.id))
                              : next),
                            opts,
                          )}
                          docLoaded={layersDocLoaded}
                          selectedLayerId={selectedBoundaryLayerId}
                          onSelectLayer={setSelectedBoundaryLayerId}
                          openEditorRef={openManualEditorRef}
                          pendingSelection={effectiveAnnotationSelection}
                          onClearPendingSelection={() => {
                            setPendingAnnotationSelection(null);
                            // Pill and preview are two views of the same span — tear both down together.
                            if (previewRegionRef.current) handlePreviewDismiss();
                          }}
                          onDuplicateSkipped={setAnnotationNotice}
                          snapTime={snapToGridIfEnabled}
                          onSeekAndPlay={handleSeekAndPlay}
                          onPause={handlePause}
                          isPlaying={playerIsPlaying}
                          getSongTime={liveSongTime}
                        />
                      </div>
                    );
                  })()}
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
                      onCopyToManualAnnotation={appendBoundarySections}
                      onTuneInConsensus={openConsensusInspect}
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
                      snapToGrid={snapToGrid || gridLock}
                      snapTime={snapToGridIfEnabled}
                      gridLock={gridLock}
                      pendingSelection={effectiveAnnotationSelection}
                      onClearPendingSelection={() => {
                        setPendingAnnotationSelection(null);
                        if (previewRegionRef.current) handlePreviewDismiss();
                      }}
                      onRangeCollapsed={() => setAnnotationNotice(
                        'Cues are single points — added one cue at the selection start. Use Spans or Loops for a region.',
                      )}
                      onDuplicateSkipped={setAnnotationNotice}
                      grid={bpm ? { bpm, beatsPerBar, gridOffsetSec: beatOffset ?? 0 } : null}
                      getSongTime={liveSongTime}
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
                      snapToGrid={snapToGrid || gridLock}
                      snapTime={snapToGridIfEnabled}
                      gridLock={gridLock}
                      focusedLoop={focusedLoop}
                      onFocusLoop={setFocusedLoop}
                      selectedLayerId={selectedLoopLayerId}
                      onSelectLayer={setSelectedLoopLayerId}
                      playingLoopId={loopPlayback.playingId}
                      onPlayLoop={(id, s, e) => playLoopExclusive(id, s, e, { snapZeroCross: true })}
                      onStopLoop={loopPlayback.stop}
                      onDuplicateSkipped={setAnnotationNotice}
                      pendingSelection={effectiveAnnotationSelection}
                      onClearPendingSelection={() => {
                        setPendingAnnotationSelection(null);
                        // Pill and preview are two views of the same span — tear both down together.
                        if (previewRegionRef.current) handlePreviewDismiss();
                      }}
                      getSongTime={liveSongTime}
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
                      snapToGrid={snapToGrid || gridLock}
                      snapTime={snapToGridIfEnabled}
                      gridLock={gridLock}
                      focusedSpan={focusedSpan}
                      onFocusSpan={setFocusedSpan}
                      onDuplicateSkipped={setAnnotationNotice}
                      selectedLayerId={selectedSpanLayerId}
                      onSelectLayer={setSelectedSpanLayerId}
                      pendingSelection={effectiveAnnotationSelection}
                      onClearPendingSelection={() => {
                        setPendingAnnotationSelection(null);
                        if (previewRegionRef.current) handlePreviewDismiss();
                      }}
                      getSongTime={liveSongTime}
                    />
                  )}
                  {activeAnnotationType === 'riff-patterns' && activeSourceByType['riff-patterns'] === 'manual' && settings.experimentalLoopsAndPatterns && (
                    <RiffPatternEditorPanel
                      ref={riffPatternsPanelRef}
                      onCapabilitiesChange={setRiffPatternsCaps}
                      saveStatus={layersDocSaveStatus}
                      currentTime={playerTime}
                      duration={duration}
                      doc={cueLayersDoc ?? emptyLayersDoc(selectedAudio.id)}
                      onDocChange={setCueLayersDoc}
                      grid={bpm ? { bpm, beatsPerBar, gridOffsetSec: beatOffset ?? 0 } : null}
                      snapToGrid={snapToGrid || gridLock}
                      snapTime={snapToGridIfEnabled}
                      focusedInstance={focusedRiffPattern}
                      onFocusInstance={setFocusedRiffPattern}
                      selectedLayerId={selectedRiffPatternLayerId}
                      onSelectLayer={setSelectedRiffPatternLayerId}
                      pendingSelection={effectiveAnnotationSelection}
                      onClearPendingSelection={() => {
                        setPendingAnnotationSelection(null);
                        if (previewRegionRef.current) handlePreviewDismiss();
                      }}
                      onEditNode={(layerId, nodeId, anchor) => {
                        setNodePopoverEntryCtx(null);
                        nodePopover.openAt(layerId, nodeId, anchor);
                      }}
                      getSongTime={liveSongTime}
                    />
                  )}
                  {activeAnnotationType === 'lyrics' && activeSourceByType.lyrics === 'manual' && settings.experimentalLyricsFamily && (
                    <LyricsEditorPanel
                      ref={lyricsPanelRef}
                      onCapabilitiesChange={setLyricsCaps}
                      saveStatus={layersDocSaveStatus}
                      currentTime={playerTime}
                      duration={duration}
                      doc={cueLayersDoc ?? emptyLayersDoc(selectedAudio.id)}
                      onDocChange={setCueLayersDoc}
                      snapTime={snapTimeByLayerMode}
                      focusedLyrics={focusedLyrics}
                      onFocusLyrics={setFocusedLyrics}
                      onDuplicateSkipped={setAnnotationNotice}
                      selectedLayerId={selectedLyricsLayerId}
                      onSelectLayer={setSelectedLyricsLayerId}
                      onSeek={(t) => seekRef.current?.(t)}
                      vocalRunGrid={vocalRunGrid}
                      onAssignVocalLead={handleAssignVocalLead}
                      pendingSelection={effectiveAnnotationSelection}
                      onClearPendingSelection={() => {
                        setPendingAnnotationSelection(null);
                        if (previewRegionRef.current) handlePreviewDismiss();
                      }}
                      getSongTime={liveSongTime}
                    />
                  )}
                  </div>
                  )}
                </div>
              )}

              {/* Karaoke stage — reading the words along with playback, rather
                  than scoring anything. Its own tab, so nothing it displaces. */}
              {inspectStage === 'karaoke' && renderKaraokePanel()}

              {/* Algo inspect stage */}
              {inspectStage === 'algo' && (
                <AlgoInspectStage
                  annotationRows={annotationRows}
                  manualSections={refManualSections}
                  autoGuessSections={refAutoGuessSections}
                  showAutoGuess={showAutoGuess}
                  duration={duration}
                  tolerance={mirTolerance}
                  onToleranceChange={setMirTolerance}
                  onConsensusVizChange={setConsensusViz}
                  onHandoffToAutoGuess={openAutoGuessPanel}
                  leading={referencePicker}
                />
              )}

              {/* Evaluation stage */}
              {inspectStage === 'eval' && (
                <EvaluationStage
                  annotationRows={annotationRows}
                  manualSections={refManualSections}
                  duration={duration}
                  tolerance={mirTolerance}
                  onToleranceChange={setMirTolerance}
                  selectedAudio={selectedAudio ? { id: selectedAudio.id, name: selectedAudio.name } : null}
                  kind={inspectKind}
                  onKindChange={setInspectKind}
                />
              )}

            </>
          )}
        </div>

          </>
        ) : null}
        </div>

        {/* ── Right sidebar #1 — Curated (detector-sourced) layers ──
             A SECOND right column, sitting LEFT of the Algorithms sidebar. It
             lists the curated detectors' output — the is_annotation layers
             grouped by stem, and the is_algorithm boundary curators; a
             both-flagged curator (a phrase curator, say) appears under
             each. Visibility is the shared `hiddenCustomAnnotations` set (keyed
             by detector name), so a curator toggles the same way everywhere —
             driving both the timeline canvas and the annotation list. Collapses
             to a hover tab.

             Algorithm Inspect only. A curated layer is a machine's proposal:
             it is rebuilt from the detector's cache on every render, lives
             nowhere in the annotator's folder, and nothing downstream reads it.
             It used to be listed in the Annotator Tool too, which put guesses
             among the annotator's own work with only a colour to tell them
             apart. Copy one with the lane's ⬇ and the copy — a real layer —
             shows up over there. */}
        {selectedAudio && feature === 'inspect-song' && (() => {
          const accent = accentFor(feature);
          const allCuratedNames = curatedLayersByStem.rows.map((r) => r.detectorName);
          const namesForStem = (s: string) => (curatedLayersByStem.byStem.get(s) ?? []).map((r) => r.detectorName);
          const isStemShown = (names: string[]) => names.length > 0 && names.every((n) => !hiddenCustomAnnotations.has(n));
          const allShown = isStemShown(allCuratedNames);
          // "None" is lit when every curated layer is hidden — the symmetric
          // one-click clear next to "All", so the user can drop to zero visible
          // layers without unchecking each box.
          const noneShown = allCuratedNames.every((n) => hiddenCustomAnnotations.has(n));
          // Inverse polarity vs the inspect "SHOW PER STEM" block: visibility is
          // a HIDDEN set, so "show" deletes names and "hide" adds them.
          const setShown = (names: string[], show: boolean) => setHiddenCustomAnnotations((prev) => {
            const n = new Set(prev);
            if (show) names.forEach((nm) => n.delete(nm)); else names.forEach((nm) => n.add(nm));
            return n;
          });
          if (curatedSidebarCollapsed && mobilePanel !== 'detectors') {
            if (isMobile) return null;
            // In-layout rail (not a floating tab): occupies its own slim column
            // in the flex row, so it can never overlap the sibling panel.
            return (
              <aside className="shrink-0 tc-aside self-start border-l border-white/[0.06] bg-[#14171d]/80 backdrop-blur-sm">
                <button
                  onClick={() => setCuratedSidebarCollapsed(false)}
                  title="Show detector layers"
                  className="h-full w-9 flex flex-col items-center gap-3 pt-3 text-slate-300 hover:text-white hover:bg-white/[0.03] transition-colors"
                >
                  <span className="text-xl leading-none font-bold">‹</span>
                  <span className="text-[11px] uppercase tracking-[0.18em] font-semibold" style={{ writingMode: 'vertical-rl' }}>Detectors</span>
                </button>
              </aside>
            );
          }
          return (
            <aside
              style={{ width: curatedSidebarWidth }}
              data-mobile-open={mobilePanel === 'detectors' || undefined}
              className="shrink-0 tc-aside self-start border-l border-white/[0.06] bg-[#14171d]/80 backdrop-blur-sm flex flex-col relative"
            >
              <div
                data-resize-handle
                onMouseDown={startCuratedSidebarResize}
                onDoubleClick={() => setCuratedSidebarWidth(CURATED_SIDEBAR_DEFAULT_WIDTH)}
                title="Drag to resize · double-click to reset"
                className={`absolute top-0 left-0 h-full w-1.5 -ml-0.5 cursor-col-resize z-20 group ${curatedSidebarResizing ? 'bg-sky-500/40' : 'hover:bg-sky-500/30'} transition-colors`}
              >
                <div className={`absolute top-0 left-0 h-full w-px ${curatedSidebarResizing ? 'bg-sky-400' : 'bg-transparent group-hover:bg-sky-400/60'}`} />
              </div>
              <div className="flex items-center justify-between gap-2 px-3 h-9 border-b border-white/[0.05] shrink-0">
                <span className="text-[13px] uppercase tracking-[0.18em] text-slate-100 font-bold">Detectors</span>
                <button
                  onClick={() => (isMobile ? setMobilePanel(null) : setCuratedSidebarCollapsed(true))}
                  title="Hide detector layers"
                  className="text-slate-500 hover:text-slate-200 transition-colors text-xl leading-none px-1"
                >
                  ›
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
                {/* Empty state: the sidebar always mounts (so it never just
                    vanishes), but with nothing cached for this song yet —
                    e.g. detectors were never run against it, or a
                    stem-dependent one is waiting on a stem this song hasn't
                    had Demucs run on — say so instead of showing a blank
                    column. */}
                {curatedLayersByStem.rows.length === 0 && (() => {
                  const okDetectors = customDetectors.filter((d) => d.status === 'ok' && (d.is_algorithm || d.is_annotation));
                  if (okDetectors.length === 0) {
                    return (
                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        No custom detectors are registered on this server.
                      </p>
                    );
                  }
                  const missingStems = new Set<string>();
                  okDetectors.forEach((d) => {
                    if (d.stem && d.stem !== 'mix' && !stemManifest?.stems?.[d.stem]) missingStems.add(d.stem);
                  });
                  return (
                    <div className="text-[11px] text-slate-400 leading-relaxed space-y-2">
                      <p>No detector output for this song yet.</p>
                      {missingStems.size > 0 && (
                        <p>
                          Some detectors need the{' '}
                          <span className="text-slate-200">{[...missingStems].sort().join(', ')}</span>{' '}
                          stem{missingStems.size === 1 ? '' : 's'}, not yet generated for this song.
                        </p>
                      )}
                      <p>
                        Run detectors from the{' '}
                        <button
                          type="button"
                          onClick={() => navigate('/custom')}
                          className="text-sky-400 hover:text-sky-300 hover:underline"
                        >
                          Custom Detectors
                        </button>{' '}
                        page, or tick them under <span className="text-slate-200">Custom</span> in the Algorithms sidebar's <span className="text-slate-200">▶ Run…</span> picker.
                      </p>
                    </div>
                  );
                })()}
                {/* One-click per-stem show/hide for every detector layer of a stem. */}
                {curatedLayersByStem.stems.length > 0 && (
                  <StemChipGroup
                    label="Show per stem"
                    hint="all detectors at once"
                    accent={accent}
                    chips={[
                      { key: '__all', label: 'All', active: allShown, onClick: () => setShown(allCuratedNames, !allShown) },
                      {
                        key: '__none',
                        label: 'None',
                        active: noneShown,
                        title: 'Hide every detector layer on the timeline and the annotation list',
                        onClick: () => setShown(allCuratedNames, false),
                      },
                      ...curatedLayersByStem.stems.map((s) => {
                        const names = namesForStem(s);
                        const shown = isStemShown(names);
                        return {
                          key: s,
                          label: s,
                          active: shown,
                          title: `${shown ? 'Hide' : 'Show'} every detector ${s} layer on the timeline and the annotation list`,
                          onClick: () => setShown(names, !shown),
                        };
                      }),
                    ]}
                  />
                )}
                {/* Curated layers grouped by stem; each row toggles a single
                    detector layer via the shared hiddenCustomAnnotations set.
                    The ⬇ copy button duplicates the layer into a new editable
                    Manual layer; an amber count badge shows how many copies
                    already exist so the user can avoid unintentional doubles. */}
                {curatedLayersByStem.origins.map((origin) => (
                  <div key={origin.origin} className="space-y-2">
                    {origin.title && (
                      <div className="text-[10px] uppercase tracking-[0.16em] text-amber-300/70 font-medium pt-1">{origin.title}</div>
                    )}
                    {origin.stems.map((s) => {
                      const stemRows = origin.byStem.get(s) ?? [];
                      // Collect ordered unique groups (null = ungrouped, rendered last).
                      const groupOrder: Array<string | null> = [];
                      for (const r of stemRows) {
                        if (!groupOrder.includes(r.group)) groupOrder.push(r.group);
                      }
                      const namedGroups = groupOrder.filter((g): g is string => g !== null);
                      const hasUngrouped = groupOrder.includes(null);
                      const orderedGroups = [...namedGroups, ...(hasUngrouped ? [null] : [])];
                      return (
                      <div key={s} className="space-y-1">
                        <div className="text-[9px] uppercase tracking-[0.16em] text-slate-500 capitalize">{s}</div>
                        {orderedGroups.map((g) => {
                          const groupRows = stemRows.filter((r) => r.group === g);
                          return (
                            <div key={g ?? '__ungrouped'} className="space-y-0.5">
                              {g !== null && (
                                <div className="text-[9px] text-slate-600 uppercase tracking-[0.12em] pl-0.5 mt-1">{g}</div>
                              )}
                              <div className="flex flex-col gap-1">
                          {groupRows.map((r) => {
                            const rEnvelope = customResults[r.detectorName];
                            const rDoc = detectorOutputDocs[r.detectorName];
                            const rItems = (rDoc ?? rEnvelope)?.items ?? [];
                            const rReview = rDoc?.review ?? {};
                            const rDet = customDetectors.find((d) => d.name === r.detectorName);
                            const rLabel = rDet?.label ?? r.name;
                            const rPrimaryMs = (it: { time_ms?: number; start_ms?: number }) =>
                              (r.type === 'cues' || r.type === 'boundary' || r.type === 'lyrics')
                                ? (it.time_ms ?? 0) : (it.start_ms ?? 0);
                            const rKeepable = rItems.filter((it, i) =>
                              rReview[`${i}:${rPrimaryMs(it as { time_ms?: number; start_ms?: number })}`] !== 'rejected',
                            );
                            const rExisting = (r.type !== 'boundary'
                              ? (cueLayersDoc?.layers.filter(
                                  (l) => l.importedFrom === rLabel || l.importedFrom === `${rLabel} (✓ accepted)`,
                                ).length ?? 0)
                              : 0);
                            const rCopyDisabled = !selectedAudio || rKeepable.length === 0;
                            const doCopyLayer = () => {
                              if (rCopyDisabled) return;
                              if (r.type === 'boundary') {
                                const sections: SectionBlock[] = (rKeepable as CustomBoundaryItem[]).map((b) => ({
                                  time: b.time_ms / 1000,
                                  type: 'section' as const,
                                  label: b.label ?? '',
                                  ...(b.importance ? { importance: b.importance } : {}),
                                  ...((b.candidates && b.candidates.length > 0)
                                    ? { candidates: b.candidates.map((ms) => ms / 1000) }
                                    : {}),
                                }));
                                const createdId = copyBoundarySectionsToNewLayer(sections, rLabel);
                                if (createdId) {
                                  setLastCopyUndo({ layerId: createdId, label: rLabel, prevSource: activeSourceByType.boundaries, type: 'boundaries' });
                                }
                              } else {
                                const converted = convertDetectorItems(r.type, rKeepable as Parameters<typeof convertDetectorItems>[1]);
                                if (!converted) return;
                                const newLayerId = newId();
                                const prevSrc = activeSourceByType[r.type as AnnotationCategory];
                                setCueLayersDoc((d) => {
                                  if (!d) return d;
                                  const color = pickDefaultLayerColor(d.layers);
                                  const layer: AnnotationLayer = {
                                    id: newLayerId,
                                    name: rLabel,
                                    type: r.type as 'cues' | 'spans' | 'loops' | 'lyrics',
                                    visible: true,
                                    color,
                                    snap: r.type === 'loops' ? 'bar' : 'beat',
                                    items: converted as never,
                                    source: 'user',
                                    importedFrom: rLabel,
                                  };
                                  return { ...d, layers: [...d.layers, layer] };
                                });
                                setLastCopyUndo({ layerId: newLayerId, label: rLabel, prevSource: prevSrc, type: r.type as AnnotationCategory });
                              }
                            };
                            return (
                              <div key={r.id} className="flex items-center gap-1 group/curated-row">
                                <label className="flex items-center gap-1.5 cursor-pointer select-none flex-1 min-w-0">
                                  <input
                                    type="checkbox"
                                    checked={!hiddenCustomAnnotations.has(r.detectorName)}
                                    onChange={() => toggleCustomAnnotationVisible(r.detectorName)}
                                    className={accent.checkbox}
                                  />
                                  <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ background: r.color }} />
                                  <span className="text-[11px] text-slate-300 truncate">{r.name}</span>
                                </label>
                                <button
                                  type="button"
                                  onClick={doCopyLayer}
                                  disabled={rCopyDisabled}
                                  title={rCopyDisabled
                                    ? `${r.name} has no output yet — run it first`
                                    : rExisting > 0
                                      ? `Copy to a new manual layer — ${rExisting} existing ${rExisting === 1 ? 'copy' : 'copies'} already`
                                      : `Copy "${r.name}" to a new editable manual layer`}
                                  className={`shrink-0 flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] leading-none transition-all disabled:hidden ${
                                    rExisting > 0
                                      ? 'text-amber-300 hover:text-amber-100 hover:bg-amber-500/20'
                                      : 'opacity-0 group-hover/curated-row:opacity-100 focus:opacity-100 text-slate-400 hover:text-white hover:bg-white/[0.10]'
                                  }`}
                                >
                                  ⬇{rExisting > 0 && <span className="font-mono ml-px">{rExisting}</span>}
                                </button>
                              </div>
                            );
                          })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </aside>
          );
        })()}

        {/* ── Right sidebar — annotation toolbar (collapsible) ────────────────────
             Holds the per-marker config (Source / Status / Save / Import / Export /
             Undo / Redo / Split / Delete) plus the tabs and Add-pending pill that
             used to live in the "Start annotating" collapsible. The cards / layers
             editor panels stay below the waveform in the centre column. Collapses
             to a hover tab on the right edge; ShortcutsHelpPanel (also fixed-right
             at z-50) overlays this sidebar when the user presses `?`. */}
        {feature === 'annotate' && selectedAudio && annotateSidebarCollapsed && !isMobile && (
          // In-layout rail (not a floating tab): its own slim column in the flex
          // row, so it never overlaps the Curated panel when that one is open.
          <aside className="shrink-0 tc-aside self-start border-l border-white/[0.06] bg-[#14171d]/80 backdrop-blur-sm">
            <button
              onClick={() => setAnnotateSidebarCollapsed(false)}
              title="Show annotation tools"
              className="h-full w-9 flex flex-col items-center gap-3 pt-3 text-slate-300 hover:text-white hover:bg-white/[0.03] transition-colors"
            >
              <span className="text-xl leading-none font-bold">‹</span>
              <span className="text-[11px] uppercase tracking-[0.18em] font-semibold" style={{ writingMode: 'vertical-rl' }}>Annotate</span>
            </button>
          </aside>
        )}
        {feature === 'annotate' && selectedAudio && (!annotateSidebarCollapsed || mobilePanel === 'tools') && (
          <aside
            style={{ width: annotateSidebarWidth }}
            /* Phone: the annotation tools dock to the bottom half instead of
               covering the screen, so the timeline they act on stays visible
               and draggable above them; the grip below pulls them to full
               height for the long lists (see index.css). */
            data-mobile-open={mobilePanel === 'tools' ? (toolsSheetFull ? 'full' : 'dock') : undefined}
            className={`shrink-0 tc-aside self-start border-l border-white/[0.06] bg-[#14171d]/80 backdrop-blur-sm flex flex-col relative ${
              annotationLock.shared && !annotationLock.canEdit ? 'opacity-60' : ''
            }`}
          >
            {isMobile && (
              <button
                type="button"
                onClick={() => setToolsSheetFull((v) => !v)}
                aria-expanded={toolsSheetFull}
                aria-label={toolsSheetFull ? 'Shrink the tools, show more of the timeline' : 'Expand the tools to full height'}
                className="shrink-0 h-7 w-full flex items-center justify-center gap-2 text-[10px] uppercase tracking-[0.16em] text-slate-500"
              >
                <span className="block w-10 h-1 rounded-full bg-white/25" aria-hidden />
                {toolsSheetFull ? 'Shrink' : 'Expand'}
              </button>
            )}
            <div
              data-resize-handle
              onMouseDown={startAnnotateSidebarResize}
              onDoubleClick={() => setAnnotateSidebarWidth(ANNOTATE_SIDEBAR_DEFAULT_WIDTH)}
              title="Drag to resize · double-click to reset"
              className={`absolute top-0 left-0 h-full w-1.5 -ml-0.5 cursor-col-resize z-20 group ${annotateSidebarResizing ? 'bg-sky-500/40' : 'hover:bg-sky-500/30'} transition-colors`}
            >
              <div className={`absolute top-0 left-0 h-full w-px ${annotateSidebarResizing ? 'bg-sky-400' : 'bg-transparent group-hover:bg-sky-400/60'}`} />
            </div>
            <div className="flex items-center justify-between gap-2 px-3 h-9 border-b border-white/[0.05] shrink-0">
              <span className="text-[13px] uppercase tracking-[0.18em] text-slate-100 font-bold">Annotate</span>
              {annotationLock.shared && !annotationLock.canEdit && (
                // The panel stays readable but visibly inactive: every control
                // in it is refused while the lease is somebody else's, and a
                // control that looks live and does nothing is worse than one
                // that says so.
                <span
                  title="Someone else holds this song's edit lock. Take it from the bar below the waveform to make changes."
                  className="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-[0.12em] font-semibold border border-amber-400/40 bg-amber-500/15 text-amber-200 whitespace-nowrap"
                >🔒 Read-only</span>
              )}
              <div className="flex items-center gap-1">
                <div className="relative" ref={annotateMenuRef}>
                  <button
                    type="button"
                    onClick={() => setAnnotateMenuOpen((o) => !o)}
                    aria-expanded={annotateMenuOpen}
                    aria-haspopup="menu"
                    title="Export all · Delete all annotations for this track"
                    className={`px-1.5 py-0.5 rounded text-slate-400 hover:text-slate-200 hover:bg-white/[0.05] transition-colors text-xl leading-none ${annotateMenuOpen ? 'bg-white/[0.06] text-slate-200' : ''}`}
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
                        title={`Delete every annotation (Manual, Auto-guess, Cues, Spans, Loops) for "${selectedAudio.name}"`}
                        className="w-full text-left px-3 py-1.5 text-[11px] text-red-300 hover:bg-red-500/15 transition-colors"
                      >
                        ✕ Delete all annotations
                      </button>
                    </div>
                  )}
                </div>
                <button
                  onClick={() => (isMobile ? setMobilePanel(null) : setAnnotateSidebarCollapsed(true))}
                  title="Hide annotation tools"
                  className="text-slate-500 hover:text-slate-200 transition-colors text-xl leading-none px-1"
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
                } else if (activeAnnotationType === 'boundaries' && activeBoundarySource === 'autoGuess') {
                  ref = autoGuessPanelRef;   caps = autoGuessCaps;   accent = 'violet';
                } else if (activeAnnotationType === 'cues') {
                  ref = cuesPanelRef;        caps = cuesCaps;        accent = 'emerald';
                } else if (activeAnnotationType === 'spans') {
                  ref = spansPanelRef;       caps = spansCaps;       accent = 'emerald';
                } else if (activeAnnotationType === 'loops') {
                  ref = loopsPanelRef;       caps = loopsCaps;       accent = 'fuchsia';
                } else if (activeAnnotationType === 'riff-patterns') {
                  ref = riffPatternsPanelRef;    caps = riffPatternsCaps;    accent = 'fuchsia';
                } else if (activeAnnotationType === 'lyrics') {
                  ref = lyricsPanelRef;      caps = lyricsCaps;      accent = 'cyan';
                }
                // The unified all-annotations list always renders. Its
                // `actionsSlot` carries the per-type edit panel, which slots in
                // under the active type's chip-title inside the list. Defined
                // once so both the editor-mounted path and the detector-source
                // (ref null) path reuse the same list.
                const renderList = (
                  actionsSlot: React.ReactNode,
                  addAtPlayhead?: {
                    label: string | ((layerId: string) => string);
                    onAdd: (layerId: string, anchor: { x: number; y: number }) => void;
                  },
                ) => (
                  <UnifiedAnnotationListPanel
                    cueLayersDoc={cueLayersDoc}
                    autoGuessAnnotation={autoGuessAnnotation}
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
                    focusedLyrics={focusedLyrics}
                    onFocusLyrics={setFocusedLyrics}
                    onItemDelete={handleUnifiedItemDelete}
                    onItemToggleImportance={handleUnifiedItemToggleImportance}
                    onDeleteLayer={handleUnifiedLayerDelete}
                    onRenameLayer={handleUnifiedLayerRename}
                    onChangeItemLabel={handleUnifiedItemLabelChange}
                    selectedLayerIdByType={selectedLayerIdByType}
                    onSelectLayer={handleUnifiedSelectLayer}
                    experimentalLoopsAndPatterns={settings.experimentalLoopsAndPatterns}
                    experimentalLyricsFamily={settings.experimentalLyricsFamily}
                    actionsSlot={actionsSlot}
                    addAtPlayhead={addAtPlayhead}
                  />
                );
                // Undo the most recent detector->Manual copy. Kept next to the
                // copy button so undo lives where the action happened; not
                // source-gated so it survives the source flipping back to Manual.
                const copyUndoNode = lastCopyUndo
                    && lastCopyUndo.type === activeAnnotationType && (
                    <div className="mb-2 flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-amber-400/30 bg-amber-500/[0.08] text-[12px] text-amber-100">
                      <span className="truncate">
                        Copied “{lastCopyUndo.label}” into a new layer.
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            const u = lastCopyUndo;
                            setCueLayersDoc((d) => (d
                              ? { ...d, layers: d.layers.filter((l) => l.id !== u.layerId) }
                              : d));
                            setActiveSourceByType((m) => ({ ...m, [u.type]: u.prevSource }));
                            setLastCopyUndo(null);
                          }}
                          className="px-2.5 py-1 rounded border border-amber-400/40 bg-amber-500/15 text-amber-100 font-semibold hover:bg-amber-500/25"
                        >
                          Undo copy
                        </button>
                        <button
                          type="button"
                          onClick={() => setLastCopyUndo(null)}
                          title="Dismiss"
                          className="px-1.5 py-1 rounded text-amber-200/70 hover:text-amber-100 hover:bg-amber-500/15"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  );
                // Big "transfer detector output -> my annotation" button. Moved
                // here from the center column so it sits right under the source
                // picker. Renders only when the active source is a detector: copies
                // the whole output (or just the accepted items) into something
                // editable, then flips the source back to Manual so the copy is picked.
                const copyToLayerNode = (() => {
                    const src = activeSourceByType[activeAnnotationType];
                    if (typeof src !== 'string' || !src.startsWith('detector:')) return null;
                    // No detector produces riff patterns, so there is never
                    // anything to copy into one (see the review block above).
                    if (!isExaminableType(activeAnnotationType)) return null;
                    const detectorName = src.slice('detector:'.length);
                    const det = customDetectors.find((d) => d.name === detectorName);
                    const envelope = customResults[detectorName];
                    const doc = detectorOutputDocs[detectorName];
                    const items = (doc ?? envelope)?.items ?? [];
                    const review = doc?.review ?? {};
                    const typeLabel = TAB_CONFIG.find((t) => t.id === activeAnnotationType)?.label ?? activeAnnotationType;
                    const detLabel = det?.label ?? detectorName;
                    // Review keys mirror DetectorOutputReview.itemKey: `${index}:${primaryMs}`,
                    // where the primary time field is time_ms for cues/boundaries/lyrics and
                    // start_ms for spans/loops.
                    const primaryMs = (it: typeof items[number]): number => {
                      const t = it as { time_ms?: number; start_ms?: number };
                      return activeAnnotationType === 'cues' || activeAnnotationType === 'boundaries' || activeAnnotationType === 'lyrics'
                        ? (t.time_ms ?? 0)
                        : (t.start_ms ?? 0);
                    };
                    const acceptedCount = items.reduce(
                      (n, it, i) => n + (review[`${i}:${primaryMs(it)}`] === 'accepted' ? 1 : 0),
                      0,
                    );
                    const disabled = items.length === 0 || !selectedAudio;
                    const target = activeAnnotationType === 'boundaries'
                      ? 'Manual boundary sections'
                      : `a Manual ${typeLabel} layer`;
                    // mode 'accepted' → only ✓ items; 'all' → everything except explicit ✗.
                    const copy = (mode: 'accepted' | 'all') => {
                      if (items.length === 0 || !selectedAudio) return;
                      const keep = items.filter((it, i) => {
                        const status = review[`${i}:${primaryMs(it)}`];
                        return mode === 'accepted' ? status === 'accepted' : status !== 'rejected';
                      });
                      if (keep.length === 0) return;
                      const importedFrom = mode === 'accepted' ? `${detLabel} (✓ accepted)` : detLabel;
                      if (activeAnnotationType === 'boundaries') {
                        const sections: SectionBlock[] = (keep as CustomBoundaryItem[]).map((b) => ({
                          time: b.time_ms / 1000,
                          type: 'section',
                          label: b.label ?? '',
                          ...(b.importance ? { importance: b.importance } : {}),
                          ...(b.candidates && b.candidates.length > 0
                            ? { candidates: b.candidates.map((ms) => ms / 1000) }
                            : {}),
                        }));
                        const createdId = copyBoundarySectionsToNewLayer(sections, importedFrom);
                        setActiveSourceByType((m) => ({ ...m, boundaries: 'manual' }));
                        if (createdId) {
                          setLastCopyUndo({ layerId: createdId, label: importedFrom, prevSource: src, type: 'boundaries' });
                        }
                      } else {
                        const converted = convertDetectorItems(activeAnnotationType, keep as ReviewableItem[]);
                        if (!converted) return;
                        const layerType = activeAnnotationType as 'cues' | 'spans' | 'loops' | 'lyrics';
                        const newLayerId = newId();
                        setCueLayersDoc((d) => {
                          if (!d) return d;
                          const color = pickDefaultLayerColor(d.layers);
                          const layer: AnnotationLayer = {
                            id: newLayerId,
                            name: importedFrom,
                            type: layerType,
                            visible: true,
                            color,
                            snap: layerType === 'loops' ? 'bar' : 'beat',
                            items: converted as never,
                            source: 'user',
                            importedFrom,
                          };
                          return { ...d, layers: [...d.layers, layer] };
                        });
                        setActiveSourceByType((m) => ({ ...m, [activeAnnotationType]: 'manual' }));
                        setLastCopyUndo({ layerId: newLayerId, label: importedFrom, prevSource: src, type: activeAnnotationType });
                      }
                    };
                    // Primary action tracks the review: once items are accepted it
                    // copies just those (with an "or copy all" escape hatch); with
                    // nothing reviewed yet it grabs the whole output in one click.
                    const primaryMode: 'accepted' | 'all' = acceptedCount > 0 ? 'accepted' : 'all';
                    return (
                      <div className="mb-2">
                        <button
                          type="button"
                          onClick={() => copy(primaryMode)}
                          disabled={disabled}
                          title={disabled
                            ? `${detLabel} hasn't produced any ${typeLabel} output for this song yet — run it from the Detectors panel first`
                            : primaryMode === 'accepted'
                              ? `Create ${target} from the ${acceptedCount} item${acceptedCount === 1 ? '' : 's'} you accepted with ✓`
                              : `Copy all ${items.length} ${typeLabel} item${items.length === 1 ? '' : 's'} from ${detLabel} into ${target} you can edit`}
                          className={`w-full px-3 py-2.5 rounded-md border border-emerald-400/30 bg-emerald-500/[0.08] text-emerald-200 text-[13px] font-semibold hover:bg-emerald-500/[0.16] disabled:opacity-40 disabled:hover:bg-emerald-500/[0.08] flex items-center justify-center gap-2${acceptedCount > 0 && !disabled ? ' animate-pulse' : ''}`}
                        >
                          <span aria-hidden>⬇</span>
                          {primaryMode === 'accepted'
                            ? <>Copy {acceptedCount} accepted → {target}</>
                            : <>Copy “{detLabel}” → {target}</>}
                        </button>
                        {primaryMode === 'accepted' && !disabled && (
                          <button
                            type="button"
                            onClick={() => copy('all')}
                            title={`Copy every item except any you rejected with ✗ into ${target}`}
                            className="w-full mt-1 text-[11px] text-slate-400 hover:text-slate-200 underline decoration-dotted underline-offset-2"
                          >
                            or copy all {items.length} item{items.length === 1 ? '' : 's'} instead
                          </button>
                        )}
                        {(() => {
                          const existingCount = cueLayersDoc?.layers.filter(
                            (l) => l.importedFrom === detLabel || l.importedFrom === `${detLabel} (✓ accepted)`,
                          ).length ?? 0;
                          return existingCount > 0 ? (
                            <p className="mt-1.5 text-[10px] text-amber-400/80 text-center">
                              {existingCount} existing {existingCount === 1 ? 'copy' : 'copies'} already imported from this source
                            </p>
                          ) : null;
                        })()}
                      </div>
                    );
                  })();
                if (!ref) return (<>{renderList(<>{copyUndoNode}{copyToLayerNode}</>)}</>);
                const layerType = activeAnnotationType === 'cues' || activeAnnotationType === 'spans'
                  || activeAnnotationType === 'loops'
                  || activeAnnotationType === 'lyrics';
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
                // (cues/spans/loops) own a JSON-only export via their
                // controller — filenames already carry `all_layers`. Manual /
                // Auto-guess get a direct JSON download here so the
                // marker panel's `↓ Export` never opens a modal; the full
                // multi-scope Export Manager stays in the section header.
                const onExport: (() => void) | undefined = (() => {
                  if (layerType) {
                    return () => controllerRef.current?.exportJson?.();
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

                // Source picker options for the active category — Manual +
                // Auto-guess (real on boundaries, stub elsewhere) + one entry
                // per matching custom detector.
                const matchingDetectors = customDetectors.filter((det) =>
                  det.is_annotation
                  && det.status === 'ok'
                  && customDetectorMatchesCategory(det.output_kind, category),
                );
                const sourceOptions: SourceOption[] = [
                  { id: 'manual', label: 'Manual' },
                  { id: 'autoGuess', label: 'Auto-guess', comingSoon: category !== 'boundaries' },
                  ...matchingDetectors.map<SourceOption>((det) => ({
                    id: `detector:${det.name}` as SourceId,
                    label: det.label,
                    isDefault: det.is_default,
                    inProgress: !!(selectedAudio?.id
                      && detectorOutputIndex[det.name]?.includes(selectedAudio.id)),
                  })),
                ];
                const sourceValue = activeSourceByType[category];

                // Recording timer. Per-type time tracking: boundary sources key
                // on the active source (Manual / Auto-guess); the layer
                // types (cues/spans/loops) key on the type itself.
                // `annotationTimesTotal` carries a running total for every key,
                // so the timer follows whichever type is currently active.
                const timerKey: TimerKey | null =
                  activeAnnotationType === 'boundaries'
                    ? activeBoundarySource
                    : (activeAnnotationType === 'cues' || activeAnnotationType === 'spans'
                       || activeAnnotationType === 'loops')
                      ? activeAnnotationType
                      : null;
                // Split the timer into its readout and its Record/Stop/Reset
                // controls; both sit on the info panel's single "⋯" details
                // row, so the collapsed panel shows neither. The buttons are
                // glyph-only (● / ▶ / ■ / ↺ with tooltips) because that row also
                // has to hold the source picker and import/export inside a
                // ~230px sidebar.
                const timerParts = timerKey ? (() => {
                  const singleDocKey: TimerKey = timerKey;
                  const sessionType = annotationSessionTypeRef.current;
                  const isRunningActive = sessionType === singleDocKey;
                  const activeTime = annotationTimesTotal[singleDocKey];
                  const hasActiveTime = activeTime > 0;
                  const time = (
                    <span className={`font-mono tabular-nums text-[11px] ${isRunningActive ? 'text-emerald-400' : 'text-slate-200'}`}>
                      {fmtAnnotationTime(activeTime)}
                    </span>
                  );
                  const controls = (
                    <>
                      {isRunningActive ? (
                        <button
                          onClick={() => pauseAnnotationTimer(selectedAudio.id)}
                          title="Stop timing this annotation session"
                          className="px-1.5 py-1 rounded text-[11px] leading-none bg-red-500/15 hover:bg-red-500/25 text-red-300 transition-colors"
                        >■</button>
                      ) : (
                        <button
                          onClick={() => {
                            if (annotationSessionStartRef.current !== null) pauseAnnotationTimer(selectedAudio.id);
                            startAnnotationTimer(singleDocKey);
                          }}
                          title={hasActiveTime ? 'Resume timing this annotation session' : 'Start timing how long this annotation takes'}
                          className="px-1.5 py-1 rounded text-[11px] leading-none bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 transition-colors"
                        >{hasActiveTime ? '▶' : '●'}</button>
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
                  return { time, controls };
                })() : null;
                const timeSlot = timerParts?.time ?? null;
                const timerSlot = timerParts?.controls ?? null;

                // Undo/redo: every annotation type shares the one page-level
                // history (cueLayersDoc + manualAnnotation bundled together —
                // see AnnotationDocsState), so the toolbar always drives that
                // shared stack regardless of which tab is active. Every panel's
                // own capabilities report canUndo/canRedo: false (unused here).
                const onUndo = () => annotationDocsCtl.undo();
                const onRedo = () => annotationDocsCtl.redo();
                const canUndo = annotationDocsCtl.canUndo;
                const canRedo = annotationDocsCtl.canRedo;
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
                const hintNode = supportsPending(activeAnnotationType, activeBoundarySource ?? undefined) && !effectiveAnnotationSelection ? (
                  <span className="text-[10px] text-slate-500">
                    {activeAnnotationType === 'loops'
                      ? 'Drag the visualization to select a loop region.'
                      : activeAnnotationType === 'spans'
                        ? 'Drag the visualization to select a span region.'
                        : 'Click the visualization where the section ends — it runs from the last boundary (or 0:00) to your click.'}
                  </span>
                ) : null;

                // "+ Add @ playhead" now lives on each layer card in the list
                // below, not as one big "+" above them — the annotator presses
                // Add on the card they want the item in, so the target layer is
                // never a guess. Riff Patterns keeps the toolbar "+" because it
                // has to ask *what kind* of thing to create first.
                const perLayerAddType = c.canAddAtPlayhead && activeAnnotationType !== 'riff-patterns'
                  ? activeAnnotationType
                  : null;
                // Editable layers of the active type that could host the add.
                // With none, there is no card to press, so the toolbar "+"
                // stays as the bootstrap that creates the first layer/item.
                const addableLayerCount = (() => {
                  if (perLayerAddType === null) return 0;
                  const list =
                    perLayerAddType === 'boundaries' ? boundaryLayersList
                    : perLayerAddType === 'cues'     ? (cueLayers ?? [])
                    : perLayerAddType === 'spans'  ? spanLayers
                    : perLayerAddType === 'loops'  ? loopLayers
                    : perLayerAddType === 'lyrics' ? lyricsLayers
                    : [];
                  return list.filter((l) => l.readOnly !== true).length;
                })();
                // The energies lane answers Add with the ⚡ Energy popover
                // instead of a blank span — see handleOpenEnergySpanExportForLayer.
                const isEnergySpanLane = (layerId: string) => perLayerAddType === 'spans'
                  && spanLayers.some((l) => l.id === layerId && l.name === ENERGY_SPAN_LAYER_NAME);
                const perLayerAdd = perLayerAddType !== null && addableLayerCount > 0
                  ? {
                    label: (layerId: string) => (isEnergySpanLane(layerId)
                      ? '⚡ Measure energy'
                      : c.addLabel),
                    onAdd: (layerId: string, anchor: { x: number; y: number }) => {
                      if (isEnergySpanLane(layerId)) {
                        handleOpenEnergySpanExportForLayer(layerId, anchor);
                        return;
                      }
                      // Adding into a layer also makes it the active target,
                      // matching what the old layer-picker ▾ did.
                      if (perLayerAddType === 'boundaries')    setSelectedBoundaryLayerId(layerId);
                      else if (perLayerAddType === 'cues')     setSelectedCueLayerId(layerId);
                      else if (perLayerAddType === 'spans')    setSelectedSpanLayerId(layerId);
                      else if (perLayerAddType === 'loops')    setSelectedLoopLayerId(layerId);
                      else if (perLayerAddType === 'lyrics')   setSelectedLyricsLayerId(layerId);
                      const ctl = controllerRef.current;
                      const at = liveSongTime() ?? undefined;
                      if (ctl?.addAtPlayheadInLayer) ctl.addAtPlayheadInLayer(layerId, at);
                      else ctl?.addAtPlayhead?.(at);
                    },
                  }
                  : undefined;

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
                            compact
                            onChange={(next) => {
                              setActiveSourceByType((prev) => ({ ...prev, [category]: next }));
                              if (next !== 'manual') {
                                setPendingAnnotationSelection(null);
                              }
                            }}
                          />
                        )}
                        timeSlot={timeSlot}
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
                        coloringSlot={activeAnnotationType === 'boundaries' ? (
                          <>
                            <span className="text-[9px] text-gray-500 uppercase tracking-wide">Coloring:</span>
                            {(['by-type', 'alternating'] as BoundaryColoringMode[]).map((mode) => (
                              <button
                                key={mode}
                                onClick={() => setBoundaryColoringMode(mode)}
                                className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                                  boundaryColoringMode === mode
                                    ? 'border-violet-500/60 text-violet-300 bg-violet-500/[0.12]'
                                    : 'border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-400'
                                }`}
                              >
                                {mode === 'by-type' ? 'By type' : 'Alternating'}
                              </button>
                            ))}
                          </>
                        ) : undefined}
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
                            pending={effectiveAnnotationSelection}
                            pendingRequiresRegion={false}
                            pointFollowsPlayhead={
                              playerIsPlaying
                              && supportsClickPending(activeAnnotationType, activeBoundarySource ?? undefined)
                            }
                            onConfirmPending={() => controllerRef.current?.confirmPending?.()}
                            onClearPending={() => {
                              setPendingAnnotationSelection(null);
                              // Pill and preview are two views of the same span — tear both down together.
                              if (previewRegionRef.current) handlePreviewDismiss();
                            }}
                            addAtPlayhead={c.canAddAtPlayhead && !perLayerAdd ? {
                              label: c.addLabel,
                              onAdd: () => controllerRef.current?.addAtPlayhead?.(liveSongTime() ?? undefined),
                            } : undefined}
                            layerPicker={(() => {
                              // Layer-typed panels (cues/spans/loops) expose a picker —
                              // Manual/Auto-guess have no per-type layers, so omit.
                              if (activeAnnotationType === 'cues') {
                                return {
                                  options: (cueLayers ?? []).map((l) => ({ id: l.id, name: l.name, color: l.color })),
                                  selectedLayerId: selectedCueLayerId,
                                  onAddAtPlayheadInLayer: (id) => {
                                    setSelectedCueLayerId(id);
                                    controllerRef.current?.addAtPlayheadInLayer?.(id, liveSongTime() ?? undefined);
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
                                    controllerRef.current?.addAtPlayheadInLayer?.(id, liveSongTime() ?? undefined);
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
                                    controllerRef.current?.addAtPlayheadInLayer?.(id, liveSongTime() ?? undefined);
                                  },
                                  onConfirmPendingInLayer: (id) => {
                                    setSelectedLoopLayerId(id);
                                    controllerRef.current?.confirmPendingInLayer?.(id);
                                  },
                                };
                              }
                              return undefined;
                            })()}
                            addKindPicker={activeAnnotationType === 'riff-patterns' ? {
                              options: [
                                {
                                  id: 'node',
                                  name: effectiveAnnotationSelection?.t2 != null ? 'New Node (from selection)' : 'New Node',
                                  color: '#f97316',
                                },
                                {
                                  id: 'boundary-node',
                                  name: effectiveAnnotationSelection?.t2 != null
                                    ? 'New Boundary Node (from selection)'
                                    : 'New Boundary Node',
                                  color: '#f97316',
                                },
                                { id: 'combo', name: 'New Combo', color: '#818cf8' },
                                {
                                  id: 'instance',
                                  name: effectiveAnnotationSelection?.t2 != null ? 'New Instance (from selection)' : 'New Instance (4s @ playhead)',
                                  color: '#34d399',
                                },
                              ],
                              // Kind-specific branching (whether/how each kind consumes a
                              // pending viz-selection) lives in the panel's own addKind.
                              onPick: (id) => controllerRef.current?.addKind?.(id),
                            } : undefined}
                            crossLayerAction={
                              activeAnnotationType === 'cues' && settings.experimentalLoopsAndPatterns
                                ? {
                                  label: '→ Riff Node',
                                  title: 'Generate a riff node from this selection',
                                  // Each destination appears twice: as a grid
                                  // node (onsets snapped to an inferred
                                  // subdivision) and as a boundary node
                                  // ("blocks" — onsets kept at their exact
                                  // fractional beat positions, nothing
                                  // quantised). See
                                  // handleGenerateRiffNodeFromSelection.
                                  options: [
                                    ...riffPatternLayers.map((l) => ({ id: l.id, name: l.name, color: l.color })),
                                    { id: NEW_RIFF_LAYER_ID, name: '+ New Riff Layer', color: '#f97316' },
                                    ...riffPatternLayers.map((l) => ({
                                      id: `${RIFF_BOUNDARY_PICK_PREFIX}${l.id}`,
                                      name: `${l.name} — as blocks (no grid)`,
                                      color: l.color,
                                    })),
                                    {
                                      id: `${RIFF_BOUNDARY_PICK_PREFIX}${NEW_RIFF_LAYER_ID}`,
                                      name: '+ New Riff Layer — as blocks (no grid)',
                                      color: '#f97316',
                                    },
                                  ],
                                  onPick: handleGenerateRiffNodeFromSelection,
                                }
                                : undefined
                            }
                            // Spans only. ⚡ Energy always saves a *span* into
                            // the `energies` lane, so offering it under
                            // Boundaries / Cues / Riff Patterns put a button in
                            // a panel that made something the panel can't show
                            // — the annotator pressed it and the count next to
                            // their own type didn't move. A measurement is
                            // meaningful over any dragged range, but the thing
                            // it produces belongs to one type, and the button
                            // lives with what it produces.
                            onExportEnergy={activeAnnotationType === 'spans' ? handleOpenEnergySpanExport : undefined}
                            pendingNote={activeAnnotationType === 'cues'
                              ? 'start only'
                              : undefined}
                            accent={accent}
                          />
                        )}
                        fillSlot={c.canFillDefaults ? (
                          // Bulk-fill setup (Manual boundaries only). The panel
                          // exposes `fillDefaults` / `chooseStructure` on its
                          // controller and flips `canFillDefaults` to true once
                          // BPM is known; other types leave it false and these
                          // buttons stay hidden. Returned as a fragment, not a
                          // nested flex box, so each button wraps on its own in
                          // the actions panel's verb row.
                          <>
                            <button
                              type="button"
                              onClick={() => controllerRef.current?.fillDefaults?.()}
                              title={`${c.fillDefaultsLabel} — ${c.fillDefaultsTooltip || 'Pre-fill with your saved default layout'}`}
                              className="flex-1 flex items-center justify-center whitespace-nowrap px-1 py-1 text-[10px] leading-none rounded border border-amber-400/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 transition-colors"
                            >
                              {c.fillDefaultsLabel}
                            </button>
                            <button
                              type="button"
                              onClick={() => controllerRef.current?.chooseStructure?.()}
                              title="Choose structure — pick a different layout (genre preset, equal bars, or a custom list)"
                              className="flex-1 flex items-center justify-center whitespace-nowrap px-1 py-1 text-[10px] leading-none rounded border border-amber-400/30 bg-white/[0.04] text-amber-200/90 hover:bg-white/[0.08] transition-colors"
                            >
                              Structure
                            </button>
                          </>
                        ) : undefined}
                        addLayerSlot={(
                          // Unified "+ Add layer" — identical button across every
                          // annotation type. Enabled for layer-typed panels
                          // (cues/spans/loops) which expose `addLayer`
                          // via the controller; rendered disabled with a tooltip
                          // on the Boundary sources (manual/autoGuess) where
                          // the data model is still single-doc per source.
                          <button
                            type="button"
                            onClick={() => controllerRef.current?.addLayer?.()}
                            disabled={!c.canAddLayer}
                            title={c.canAddLayer
                              ? 'Add layer — create a new empty layer of this type'
                              : 'Boundaries live in a single layer for now — multi-layer support coming soon.'}
                            className={`flex-1 flex items-center justify-center whitespace-nowrap px-1 py-1 rounded text-[10px] leading-none font-semibold border transition-colors ${
                              c.canAddLayer
                                ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/25 hover:border-emerald-400/70 hover:text-white'
                                : 'border-white/[0.04] bg-white/[0.01] text-slate-700 cursor-not-allowed'
                            }`}
                          >
                            New layer
                          </button>
                        )}
                          />
                          {copyUndoNode}
                          {copyToLayerNode}
                        </div>,
                        perLayerAdd,
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
        {feature === 'inspect-song' && selectedAudio && algoSidebarCollapsed && !isMobile && (
          // In-layout rail (not a floating tab): occupies its own slim column
          // in the flex row, so it can never overlap the sibling panel.
          <aside className="shrink-0 tc-aside self-start border-l border-white/[0.06] bg-[#14171d]/80 backdrop-blur-sm">
            <button
              onClick={() => setAlgoSidebarCollapsed(false)}
              title="Show algorithms panel"
              className="h-full w-9 flex flex-col items-center gap-3 pt-3 text-slate-300 hover:text-white hover:bg-white/[0.03] transition-colors"
            >
              <span className="text-xl leading-none font-bold">‹</span>
              <span className="text-[11px] uppercase tracking-[0.18em] font-semibold" style={{ writingMode: 'vertical-rl' }}>Algorithms</span>
            </button>
          </aside>
        )}
        {feature === 'inspect-song' && selectedAudio && (!algoSidebarCollapsed || mobilePanel === 'algorithms') && (() => {
          const isRunning = runJob?.status === 'running';
          const noneSelected = selectedAlgorithms.size === 0;
          const runDisabled = isRunning || noneSelected;
          // Ticked rows that already have a cached result — the run recomputes
          // and overwrites those, so the footer says so before it is clicked.
          // Mirrors the stem mapping handleRunForCurrentSong applies, so the
          // count matches what the job will actually overwrite.
          const runStemsForCount = stemManifest
            ? (['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'] as const).filter((st) => stemManifest.stems[st])
            : [];
          const willOverwrite = cachedIdsIn(
            runStemSource === 'all'
              ? applyAllStemsToSelection(selectedAlgorithms, runStemsForCount)
              : applyStemToSelection(selectedAlgorithms, runStemSource),
          ).length;
          return (
            <aside
              style={{ width: algoSidebarWidth }}
              data-mobile-open={mobilePanel === 'algorithms' || undefined}
              className="shrink-0 tc-aside self-start border-l border-white/[0.06] bg-[#14171d]/80 backdrop-blur-sm flex flex-col relative"
            >
              <div
                data-resize-handle
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
                  onClick={() => (isMobile ? setMobilePanel(null) : setAlgoSidebarCollapsed(true))}
                  title="Hide algorithms panel"
                  className="text-slate-500 hover:text-slate-200 transition-colors text-xl leading-none px-1"
                >
                  ›
                </button>
              </div>
              {/* Pinned header. The Run… trigger and the stem filter are the two
                  controls you reach for *while* reading the chip list, and that
                  list is many screens tall — so they sit above the scroll area
                  instead of scrolling away with it. */}
              <div className="shrink-0 px-3 pt-3 pb-2 space-y-2 border-b border-white/[0.05]">
                {/* Trigger for the run picker. The sidebar body below shows
                    *visibility* toggles, so computing is a deliberate step:
                    open the picker, choose what to run, confirm. */}
                <button
                  ref={runPickerBtnRef}
                  onClick={() => (runPickerOpen ? setRunPickerOpen(false) : openRunPicker())}
                  disabled={isRunning}
                  aria-expanded={runPickerOpen}
                  title={isRunning
                    ? 'A run is already in progress for this song.'
                    : 'Choose which algorithms to compute for this song, then run them. Opens on the detectors ticked in this sidebar; anything you change inside the picker sticks.'}
                  className={`w-full px-3 py-2 rounded text-[11px] uppercase tracking-wider border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                    isRunning
                      ? 'border-emerald-500/60 bg-emerald-500/20 text-emerald-100'
                      : 'border-violet-500/40 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20 hover:border-violet-500/60 hover:text-violet-100'
                  }`}
                >
                  {isRunning ? '⏳ Running…' : '▶ Run…'}
                </button>
                {renderStemFilter()}
              </div>
              <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
                {renderRunOptionsPanel(true, 'visibility')}
              </div>
              {runPickerOpen && createPortal(
                <>
                  {/* Dimming scrim — signals a distinct "run/compute" mode so it
                      isn't mistaken for the inline visibility sidebar, which uses
                      the same chip panel. Click anywhere to dismiss. */}
                  {!isRunning && (
                    <div
                      className="fixed inset-0 z-[999] bg-black/50 backdrop-blur-[1px]"
                      onClick={() => setRunPickerOpen(false)}
                      aria-hidden="true"
                    />
                  )}
                <div
                  ref={runPickerRef}
                  role="dialog"
                  aria-modal={!isRunning}
                  aria-label="Run algorithms"
                  className="fixed z-[1000] rounded-lg border-2 border-violet-500/60 ring-2 ring-violet-500/20 bg-[#14171d] shadow-2xl shadow-violet-950/50 flex flex-col overflow-hidden"
                  style={{ top: runPickerPos.top, left: runPickerPos.left, width: runPickerPos.width, maxHeight: `calc(100vh - ${runPickerPos.top}px - 12px)` }}
                >
                  <div className="flex items-center justify-between gap-2 px-3 py-2 bg-violet-500/15 border-b-2 border-violet-500/40 shrink-0">
                    <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-violet-200 font-semibold">
                      <span aria-hidden="true">▶</span>
                      Run mode · choose what to compute
                    </span>
                    <button
                      onClick={() => setRunPickerOpen(false)}
                      title="Close"
                      className="text-violet-300/70 hover:text-violet-100 transition-colors text-lg leading-none px-1"
                    >
                      ×
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-3">
                    {/* The picker opens on the sidebar's ticks and keeps any
                        edit made here, so say whose selection this is and give
                        the old "everything missing" default a visible target. */}
                    <div className="flex items-center justify-between gap-2 mb-3 pb-3 border-b border-white/[0.06]">
                      <span
                        className="text-[10px] leading-snug text-slate-500 min-w-0"
                        title="Opened on the detectors ticked in the sidebar behind this panel. Anything you tick or untick here is kept for the next run."
                      >
                        Your sidebar ticks
                      </span>
                      <button
                        onClick={seedMissingFromPicker}
                        title="Replace the selection with every algorithm in the expanded families that has no cached result yet for this song."
                        className="shrink-0 px-1.5 py-0.5 rounded border border-violet-500/30 text-[9px] uppercase tracking-wider text-violet-300/80 hover:text-violet-100 hover:bg-violet-500/20 hover:border-violet-500/50 transition-colors"
                      >
                        Select missing
                      </button>
                    </div>
                    {availableStemSources.length <= 1 && selectedAudio && !isDemo && (() => {
                      // Per-stem runs need separated Demucs stems first. Without a
                      // cached manifest the "Run on" pills below never appear, so the
                      // whole per-stem capability is invisible. Surface it here with a
                      // one-click path to separation instead of silently hiding it.
                      const stemming = demucsJob?.slug === selectedAudio.id && demucsJob?.status === 'running';
                      return (
                        <div className="mb-3 pb-3 border-b border-white/[0.06]">
                          <div className="text-[10px] uppercase tracking-[0.16em] text-slate-400 mb-1.5">
                            Run on
                          </div>
                          <p className="text-[10px] leading-snug text-slate-500 mb-1.5">
                            Detectors run on the <span className="text-slate-300">full mix</span>. To run CUE / SPAN / LOOP / lyrics
                            detectors on an isolated <span className="text-slate-300">vocals / drums / bass</span> stem, separate the
                            song into stems first — then per-stem pills appear here.
                          </p>
                          <button
                            onClick={() => { if (!stemming) handleStemSong(selectedAudio, { model: stemModel }); }}
                            disabled={stemming}
                            title="Run Demucs source separation for this song. Once it finishes, per-stem run options appear here."
                            className="px-2 py-1 rounded text-[10px] border transition-colors disabled:opacity-60 disabled:cursor-not-allowed border-violet-500/40 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20 hover:border-violet-500/60 hover:text-violet-100"
                          >
                            {stemming
                              ? `⏳ Separating stems…${demucsJob?.progressPct != null ? ` ${Math.round(demucsJob.progressPct)}%` : ''}`
                              : '✂ Separate stems (Demucs)'}
                          </button>
                        </div>
                      );
                    })()}
                    {availableStemSources.length > 1 && (
                      <div className="mb-3 pb-3 border-b border-white/[0.06]">
                        <div className="text-[10px] uppercase tracking-[0.16em] text-slate-400 mb-1.5">
                          Run on
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {([...availableStemSources, 'all'] as RunStemTarget[]).map((s) => {
                            const active = runStemSource === s;
                            return (
                              <button
                                key={s}
                                onClick={() => handleRunStemChange(s)}
                                title={s === 'all'
                                  ? 'Run every stem-capable detector on all separated stems at once (one job per stem).'
                                  : s === 'mix' ? 'Run on the full mix.' : `Run stem-capable detectors on the ${s} stem only.`}
                                className={`px-2 py-1 rounded text-[10px] capitalize border transition-colors ${
                                  active
                                    ? 'border-violet-500/60 bg-violet-500/20 text-violet-100'
                                    : 'border-white/10 bg-white/[0.03] text-slate-400 hover:text-slate-200 hover:border-white/20'
                                }`}
                              >
                                {s === 'mix' ? 'Full mix' : s === 'all' ? 'All stems' : s}
                              </button>
                            );
                          })}
                        </div>
                        {runStemSource === 'all' ? (
                          <p className="mt-1.5 text-[10px] leading-snug text-slate-500">
                            CUE / SPAN / LOOP / lyrics detectors run on <span className="text-slate-300">every separated stem</span>
                            {' '}(one cached result per stem). Boundary detectors always use the full mix.
                          </p>
                        ) : runStemSource !== 'mix' && (
                          <p className="mt-1.5 text-[10px] leading-snug text-slate-500">
                            CUE / SPAN / LOOP / lyrics detectors run on the <span className="text-slate-300">{runStemSource}</span> stem
                            (cached separately). Boundary detectors always use the full mix.
                          </p>
                        )}
                      </div>
                    )}
                    {renderRunOptionsPanel(true, 'run')}
                  </div>
                  <div className="shrink-0 border-t border-white/[0.06] p-2.5">
                    <button
                      onClick={() => { handleRunForCurrentSong(); setRunPickerOpen(false); }}
                      disabled={runDisabled}
                      title={noneSelected
                        ? 'Tick at least one algorithm above to enable the run'
                        : willOverwrite > 0
                          ? `Runs the ticked algorithms on this song only. ${willOverwrite} of them already ${willOverwrite === 1 ? 'has a cached result, which will be' : 'have cached results, which will be'} recomputed and overwritten — untick ${willOverwrite === 1 ? 'it' : 'them'} to keep the cached output.`
                          : 'Runs the ticked algorithms on this song only. None of them has a cached result yet, so nothing is overwritten.'}
                      className="w-full px-3 py-2 rounded text-[11px] uppercase tracking-wider border transition-colors disabled:opacity-40 disabled:cursor-not-allowed border-violet-500/40 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20 hover:border-violet-500/60 hover:text-violet-100"
                    >
                      {/* The picker now opens mirroring the sidebar, so an empty
                          selection is a normal first state rather than an edge
                          case — say what to do about it instead of "Run  algorithms". */}
                      {selectedAlgorithms.size === 0
                        ? '▶ Nothing ticked — pick algorithms above'
                        : `▶ Run ${selectedAlgorithms.size} algorithm${selectedAlgorithms.size === 1 ? '' : 's'} for this song`}
                    </button>
                    {willOverwrite > 0 && !isRunning && (
                      <p className="mt-1.5 text-[10px] leading-snug text-amber-400/80">
                        {willOverwrite === 1
                          ? '1 ticked algorithm already has a cached result — it will be re-run and its output overwritten.'
                          : `${willOverwrite} ticked algorithms already have cached results — they will be re-run and their output overwritten.`}
                      </p>
                    )}
                  </div>
                </div>
                </>,
                document.body,
              )}
            </aside>
          );
        })()}

        {/* ── DataPrep sidebar (Song details + Metronome) ───────────────────
            Mirrors the Annotate / Algo asides: the grid / tempo controls live
            here beside the waveform instead of stacked below it. */}
        {feature === 'prep' && activeStage === 'annotation' && selectedAudio && prepSidebarCollapsed && !isMobile && (
          // In-layout rail (not a floating tab): occupies its own slim column
          // in the flex row, so it can never overlap the sibling panel.
          <aside className="shrink-0 tc-aside self-start border-l border-white/[0.06] bg-[#14171d]/80 backdrop-blur-sm">
            <button
              onClick={() => setPrepSidebarCollapsed(false)}
              title="Show song setup panel"
              className="h-full w-9 flex flex-col items-center gap-3 pt-3 text-slate-300 hover:text-white hover:bg-white/[0.03] transition-colors"
            >
              <span className="text-xl leading-none font-bold">‹</span>
              <span className="text-[11px] uppercase tracking-[0.18em] font-semibold" style={{ writingMode: 'vertical-rl' }}>Song setup</span>
            </button>
          </aside>
        )}
        {feature === 'prep' && activeStage === 'annotation' && selectedAudio && (!prepSidebarCollapsed || mobilePanel === 'setup') && (
          <aside
            style={{ width: prepSidebarWidth }}
            data-mobile-open={mobilePanel === 'setup' || undefined}
            className="shrink-0 tc-aside self-start border-l border-white/[0.06] bg-[#14171d]/80 backdrop-blur-sm flex flex-col relative"
          >
            <div
              data-resize-handle
              onMouseDown={startPrepSidebarResize}
              onDoubleClick={() => setPrepSidebarWidth(PREP_SIDEBAR_DEFAULT_WIDTH)}
              title="Drag to resize · double-click to reset"
              className={`absolute top-0 left-0 h-full w-1.5 -ml-0.5 cursor-col-resize z-20 group ${prepSidebarResizing ? 'bg-violet-500/40' : 'hover:bg-violet-500/30'} transition-colors`}
            >
              <div className={`absolute top-0 left-0 h-full w-px ${prepSidebarResizing ? 'bg-violet-400' : 'bg-transparent group-hover:bg-violet-400/60'}`} />
            </div>
            <div className="flex items-center justify-between gap-2 px-3 h-9 border-b border-white/[0.05] shrink-0">
              <span className="text-[10px] uppercase tracking-[0.18em] text-slate-400 font-semibold">Song setup</span>
              {/* Undo covers everything the panel below can change — BPM, meter,
                  downbeat, pinned beats, grid segments — because all of them
                  are edits to the one SongInfo this history tracks. */}
              {canEditGrid && (
                <div className="flex items-center gap-1 w-[104px] shrink-0">
                  <UndoButton canUndo={songInfoCtl.canUndo} onUndo={undoGridEdit} />
                  <RedoButton canRedo={songInfoCtl.canRedo} onRedo={redoGridEdit} />
                </div>
              )}
              <button
                onClick={() => (isMobile ? setMobilePanel(null) : setPrepSidebarCollapsed(true))}
                title="Hide song setup panel"
                className="text-slate-500 hover:text-slate-200 transition-colors text-xl leading-none px-1"
              >
                ›
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-3">
              <SongSetupPanel
                songInfo={songInfo ?? makeEmptySongInfo(selectedAudio.id)}
                onChange={handleSongInfoChange}
                knownCollections={knownCollections}
                suggestedBpms={suggestedBpms}
                // BeatNet (experimental CUE-family) is the only detector
                // today that infers meter; surface it as a click-to-apply
                // suggestion beside the meter chips. Null when the user
                // hasn't enabled the experimentalCueExtras flag or BeatNet
                // wasn't confident enough to commit to one.
                suggestedTimeSignature={
                  settings.experimentalCueExtras
                    ? beatnetDetection?.result?.meter ?? null
                    : null
                }
                bpmDetectionStatus={bpmDetectionStatus}
                bpmDetectionError={bpmDetectionError}
                // Re-run + manual edits are admin-only — non-admin
                // annotators consume the BPM the team leader set. Demo
                // users are also allowed to edit / align (their changes
                // live in localStorage; see services/songInfo.ts).
                onRerunBpmDetection={adminStatus?.isAdmin ? handleRerunBpmDetection : undefined}
                onAlignGridToPlayhead={(adminStatus?.isAdmin || isDemo) ? handleAlignGridToPlayhead : undefined}
                saveState={songInfoSaveState}
                onRetrySave={retrySongInfoSave}
                playerTime={playerTime}
                playerIsPlaying={playerIsPlaying}
                getSongTime={liveSongTime}
                playbackRate={playbackRate}
                locked={!adminStatus?.isAdmin && !isDemo}
                onSeek={(t) => seekRef.current?.(t)}
                onClearPinnedBeat={handleClearBeatOverride}
                tapRef={metronomeTapRef}
                // Grid segments — the keyboard-and-numbers path for the lane
                // on the waveform, and where the feature is discovered. It
                // rides in the panel's own accordion (step ③) rather than as a
                // block bolted underneath: a split is where the count restarts,
                // which is the same kind of decision as the tempo and the
                // downbeat above it, and it folds away like they do.
                segmentCount={mapSegments.length}
                segmentsSlot={(
                  <GridSegmentListEditor
                    segments={gridSegments}
                    playerTime={playerTime}
                    selectedId={selectedSegmentId}
                    locked={!canEditGrid}
                    onSelect={(seg, at) => {
                      setSelectedSegmentId(seg.id);
                      segmentPopover.openAt('grid-segments', seg.id, at);
                    }}
                    onSeek={(t) => seekRef.current?.(t)}
                    onDelete={canEditGrid ? handleMergeGridSegment : undefined}
                    onSplitAtPlayhead={canEditGrid ? () => handleSplitGridAt(playerTime) : undefined}
                    showHeader={false}
                  />
                )}
              />
            </div>
          </aside>
        )}
      </div>

      {/* Grid-segment editor — opens from the lane or the sidebar list. */}
      {segmentPopover.open && selectedSegment && (
        <GridSegmentEditPopover
          segment={selectedSegment}
          segments={mapSegments}
          total={mapSegments.length}
          popoverRef={segmentPopover.popoverRef}
          positionStyle={segmentPopover.positionStyle}
          barBeatOrigin={settings.barBeatOrigin}
          locked={!canEditGrid}
          onChange={(patch, opts) => handleSegmentPatch(selectedSegment, patch, opts)}
          onDelete={() => { handleMergeGridSegment(selectedSegment); segmentPopover.close(); }}
          onClose={segmentPopover.close}
          onPlayFrom={() => handleSeekAndPlay(selectedSegment.start, selectedSegment.start + 4)}
          // Detection is admin-only, exactly like the whole-song detector in
          // step ①: the dev proxy gates /api/bpm POSTs on team membership, so
          // for a demo visitor this button could only ever fail. Without a
          // slug the popover hides it rather than offering a dead control.
          slug={adminStatus?.isAdmin ? selectedAudio?.id : undefined}
          duration={duration}
        />
      )}

      <ShortcutsHelpPanel
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        shortcuts={shortcuts}
        accentText={FEATURE_THEME[feature].label}
      />

      {selectedAudio && (() => {
        const typeLabels: Record<AnnotationType, string> = { boundaries: 'Boundaries', cues: 'Cues', spans: 'Spans', loops: 'Loops', 'riff-patterns': 'Riff Patterns', lyrics: 'Lyrics' };
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
          description={`Every annotation for this song — Manual, Auto-guess, and all user-created Cues / Spans / Loops / Riff Patterns layers — will be permanently removed. Other songs are not touched. This cannot be undone.`}
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
          loadAllAutoGuessStatuses().then(setSongStatuses).catch(() => null);
          loadAllLayerStatuses().then(setSongLayerStatuses).catch(() => null);
        }}
      />

      <ExportManagerModal
        open={exportManagerOpen}
        onOpenChange={setExportManagerOpen}
        currentSong={selectedAudio ? { id: selectedAudio.id, name: selectedAudio.name, url: selectedAudio.url } : null}
        allSongs={audioFiles.map((f) => ({ id: f.id, name: f.name, url: f.url }))}
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
          songName={bpmWarningSong.song.name}
          onContinue={() => {
            const { song, origin } = bpmWarningSong;
            bpmWarningAcked.current.add(song.id);
            setBpmWarningSong(null);
            if (origin === 'select') {
              selectAudio(song);
              setActionsOpenSlug((prev) => (prev === song.id ? null : song.id));
            }
          }}
          onGoToPrep={() => {
            const { song, origin } = bpmWarningSong;
            setBpmWarningSong(null);
            if (origin === 'select') selectAudio(song);
            navigate('/prep');
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
                ? { ...l, items: l.items.map((it) => (it.id === cue.id ? ({ ...it, ...patch } as typeof it) : it)) }
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
            rawOutput={isReadOnly ? rawDetectorItem(layer.source, cue.id, customResults) : undefined}
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
            segments={gridSegments}
            currentTime={playerTime}
          />
        );
      })()}

      {/* Floating Span edit popover (opened by clicking a band on a span-layer row). */}
      {spanPopover.open && (() => {
        const userLayer = cueLayersDoc?.layers.find((l) => l.id === spanPopover.open!.layerId) as AnnotationLayer<'spans'> | undefined;
        const detLayer  = detectorSpanLayers.find((l) => l.id === spanPopover.open!.layerId);
        const layer = userLayer ?? detLayer;
        const span = layer?.items.find((it) => it.id === spanPopover.open!.itemId);
        if (!layer || !span) return null;
        const isReadOnly = layer.readOnly === true;
        const onChange = isReadOnly ? () => {} : (patch: Partial<SpanItem>) => {
          setCueLayersDoc((d) => d && ({
            ...d,
            layers: d.layers.map((l) =>
              l.id === layer.id
                ? { ...l, items: l.items.map((it) => (it.id === span.id ? ({ ...it, ...patch } as typeof it) : it)) }
                : l,
            ),
          }));
        };
        const onDelete = isReadOnly ? () => {} : () => {
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
            readOnly={isReadOnly}
            rawOutput={isReadOnly ? rawDetectorItem(layer.source, span.id, customResults) : undefined}
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
            segments={gridSegments}
            currentTime={playerTime}
          />
        );
      })()}

      {/* Floating Boundary edit popover — page-level twin of the editor panel's
          in-tab popover, covering every chip except Boundaries itself (see the
          `boundaryPopover` declaration for why that one can't reach here). */}
      {boundaryPopover.open && (() => {
        const layerId = boundaryPopover.open!.layerId;
        const layer = boundaryLayersList.find((l) => l.id === layerId);
        const idx = layer?.items.findIndex((it) => it.id === boundaryPopover.open!.itemId) ?? -1;
        const section = idx >= 0 ? layer!.items[idx] : undefined;
        if (!layer || !section) return null;
        const endT = sectionEnd(layer.items, idx, duration);
        const sectionIsPlaying = playerIsPlaying && playerTime >= section.time && playerTime < endT;
        const onChange = (patch: Partial<SectionBlock>) => {
          updateBoundaryItems(layerId, (prev) => prev.map(
            (it) => (it.id === section.id ? { ...it, ...patch } : it),
          ));
        };
        const onDelete = () => {
          updateBoundaryItems(layerId, (prev) => prev.filter((it) => it.id !== section.id));
          boundaryPopover.close();
        };
        return (
          <BoundaryEditPopover
            index={idx}
            section={section}
            endTime={endT}
            popoverRef={boundaryPopover.popoverRef}
            positionStyle={boundaryPopover.positionStyle}
            onChange={onChange}
            onDelete={onDelete}
            onClose={boundaryPopover.close}
            onPlay={() => handleSeekAndPlay(section.time, endT)}
            onStop={handlePause}
            isPlaying={sectionIsPlaying}
            bpm={bpm}
            gridOffset={songInfo?.gridOffset ?? 0}
            beatsPerBar={beatsPerBar}
            segments={gridSegments}
            currentTime={playerTime}
          />
        );
      })()}

      {/* Floating Loop edit popover (opened by clicking a band on a loop-layer row). */}
      {loopPopover.open && (() => {
        const userLayer = cueLayersDoc?.layers.find((l) => l.id === loopPopover.open!.layerId) as AnnotationLayer<'loops'> | undefined;
        const detLayer  = detectorLoopLayers.find((l) => l.id === loopPopover.open!.layerId);
        const layer = userLayer ?? detLayer;
        const loop = layer?.items.find((it) => it.id === loopPopover.open!.itemId);
        if (!layer || !loop) return null;
        const isReadOnly = layer.readOnly === true;
        const onChange = isReadOnly ? () => {} : (patch: Partial<LoopItem>) => {
          setCueLayersDoc((d) => d && ({
            ...d,
            layers: d.layers.map((l) =>
              l.id === layer.id
                ? { ...l, items: l.items.map((it) => (it.id === loop.id ? ({ ...it, ...patch } as typeof it) : it)) }
                : l,
            ),
          }));
        };
        const onDelete = isReadOnly ? () => {} : () => {
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
            readOnly={isReadOnly}
            rawOutput={isReadOnly ? rawDetectorItem(layer.source, loop.id, customResults) : undefined}
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
            segments={gridSegments}
            currentTime={playerTime}
          />
        );
      })()}

      {/* Floating Riff Pattern instance popover (opened by clicking a tile on a
          riff-patterns layer row). Combos are timeless library primitives
          with no popover of their own — they're composed and edited from
          inside this one; nodes get their own popover (`nodePopover` below)
          reachable from the sidebar's node list or a ✎ button anywhere a node
          chip appears in a sequence builder. See the tree model documented on
          RiffNode/RiffCombo/RiffPatternItem in types/annotationLayer.ts. */}
      {riffPatternPopover.open && (() => {
        const layer = riffPatternLayers.find((l) => l.id === riffPatternPopover.open!.layerId);
        const item = layer?.items.find((it) => it.id === riffPatternPopover.open!.itemId) as RiffPatternItem | undefined;
        if (!layer || !item) return null;
        const onChange = (patch: Partial<RiffPatternItem>) => {
          setCueLayersDoc((d) => d && ({
            ...d,
            layers: d.layers.map((l) =>
              l.id === layer.id
                ? { ...l, items: l.items.map((it) => (it.id === item.id ? { ...it, ...patch } : it)) }
                : l,
            ),
          }));
        };
        const onDelete = () => {
          setCueLayersDoc((d) => d && ({
            ...d,
            layers: d.layers.map((l) => (l.id === layer.id ? { ...l, items: l.items.filter((it) => it.id !== item.id) } : l)),
          }));
          // Closed by the card before it calls this — see the node popover's
          // onDelete for why closing again would double-prompt.
        };
        const onPatchCombo = (comboId: string, patch: Partial<RiffCombo>) => {
          setCueLayersDoc((d) => d && ({
            ...d,
            layers: d.layers.map((l) =>
              l.id === layer.id
                ? ({ ...l, combos: (l.combos ?? []).map((c) => (c.id === comboId ? { ...c, ...patch } : c)) } as AnnotationLayer)
                : l,
            ),
          }));
        };
        const onPatchNode = (nodeId: string, patch: Partial<RiffNode>) => {
          setCueLayersDoc((d) => d && ({
            ...d,
            layers: d.layers.map((l) =>
              l.id === layer.id
                ? ({ ...l, nodes: (l.nodes ?? []).map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) } as AnnotationLayer)
                : l,
            ),
          }));
        };
        const onCreateNode = (): string => {
          const existing = layer.nodes ?? [];
          // Pick against every riff-pattern layer's nodes, not just this one's,
          // so two different layers don't both start their palette at index 0.
          const allNodes = riffPatternLayers.flatMap((l) => l.nodes ?? []);
          const node = newRiffNode(`Node ${existing.length + 1}`, pickRiffNodeColor(allNodes));
          setCueLayersDoc((d) => d && ({
            ...d,
            layers: d.layers.map((l) =>
              l.id === layer.id ? ({ ...l, nodes: [...(l.nodes ?? []), node] } as AnnotationLayer) : l,
            ),
          }));
          return node.id;
        };
        const onCreateCombo = (): string => {
          const existing = layer.combos ?? [];
          const allCombos = riffPatternLayers.flatMap((l) => l.combos ?? []);
          const combo = newRiffCombo(`Combo ${existing.length + 1}`, pickRiffComboColor(allCombos));
          setCueLayersDoc((d) => d && ({
            ...d,
            layers: d.layers.map((l) =>
              l.id === layer.id ? ({ ...l, combos: [...(l.combos ?? []), combo] } as AnnotationLayer) : l,
            ),
          }));
          return combo.id;
        };
        const cycle = Math.max(0, item.end - item.start);
        const reps  = Math.max(1, Math.floor(item.repeatCount));
        const regionEnd = item.start + reps * cycle;
        const riffIsPlaying = playerIsPlaying && playerTime >= item.start && playerTime < regionEnd;
        return (
          <RiffPatternEditPopover
            layer={layer}
            item={item}
            beatsPerBar={beatsPerBar}
            popoverRef={riffPatternPopover.popoverRef}
            positionStyle={riffPatternPopover.positionStyle}
            onChange={onChange}
            onDelete={onDelete}
            onClose={riffPatternPopover.close}
            registerCloseGuard={riffPatternPopover.setCloseGuard}
            onPatchCombo={onPatchCombo}
            onPatchNode={onPatchNode}
            onTrimNode={(nodeId, beats) => handleRiffNodeTrim(layer.id, nodeId, beats, `riff-trim:${layer.id}:${nodeId}`)}
            onCreateNode={onCreateNode}
            onCreateCombo={onCreateCombo}
            onEditNode={(nodeId, e) => {
              setNodePopoverEntryCtx(null);
              // Opened from inside this popover — it stays on screen alongside
              // the Node popup, so opt out of single-popover exclusivity.
              nodePopover.openAt(layer.id, nodeId, { x: e.clientX, y: e.clientY }, { nested: true });
            }}
            onPlay={() => handleSeekAndPlay(item.start, regionEnd)}
            onStop={handlePause}
            onSeekAndPlay={handleSeekAndPlay}
            isPlaying={riffIsPlaying}
            bpm={bpm}
            gridOffset={songInfo?.gridOffset ?? 0}
            segments={gridSegments}
            currentTime={playerTime}
            initialExpandedIndex={riffAutoExpandIndex}
          />
        );
      })()}

      {/* Floating Riff Node popover — opened from the sidebar's node list or a
          ✎ button next to any node chip in a sequence builder (top-level or
          nested inside a combo/instance). Timeless (no start/end), so it's a
          standalone card rather than an AnnotationPointCard adapter. */}
      {nodePopover.open && (() => {
        const layer = riffPatternLayers.find((l) => l.id === nodePopover.open!.layerId);
        const node = layer?.nodes?.find((n) => n.id === nodePopover.open!.itemId);
        if (!layer || !node) return null;
        const onChange = (patch: Partial<RiffNode>) => {
          setCueLayersDoc((d) => d && ({
            ...d,
            layers: d.layers.map((l) =>
              l.id === layer.id
                ? ({ ...l, nodes: (l.nodes ?? []).map((n) => (n.id === node.id ? { ...n, ...patch } : n)) } as AnnotationLayer)
                : l,
            ),
          }));
        };
        const onDelete = () => {
          setCueLayersDoc((d) => d && ({
            ...d,
            layers: d.layers.map((l) => {
              if (l.id !== layer.id) return l;
              const nodes = (l.nodes ?? []).filter((n) => n.id !== node.id);
              const combos = (l.combos ?? []).map((c) => ({
                ...c,
                sequence: c.sequence.filter((e) => e.type !== node.id),
              }));
              const items = (l.items as RiffPatternItem[]).map((it) => ({
                ...it,
                sequence: it.sequence.filter((e) => e.type !== node.id),
              }));
              return { ...l, nodes, combos, items } as AnnotationLayer;
            }),
          }));
          // No close() here: the card's Delete button closes first (and only
          // calls this once the close actually went through), so closing
          // again would just re-run the Tap Along close guard.
        };
        // The Node popup previews the node's REAL recorded audio (not a
        // synthesized click) by locating the first place it's actually
        // placed on the timeline and looping that real span — same
        // seek+play mechanism the annotation lists use, so it stays in sync
        // with real playback instead of a separate audio-clock loop.
        const occurrence = bpm ? findFirstRiffNodeOccurrence(layer, node.id, bpm) : null;
        // Window starts `TAP_PREROLL_SECONDS` before the node's real start so
        // Tap Along's pre-roll lead-in (see NodeEditPopover) still produces a
        // valid (negative) `playheadStep` instead of a null one that would
        // silently drop an eager first tap — a normal (non-tap-along) play
        // never actually reaches this earlier window since it seeks exactly
        // to `occurrence.start` with no offset.
        const nodeIsPlaying = !!occurrence && playerIsPlaying &&
          playerTime >= occurrence.start - TAP_PREROLL_SECONDS && playerTime < occurrence.end;
        // If this popup was opened from a specific placed occurrence (a
        // direct lane click, not the sidebar list), resolve that entry so
        // the LENGTH field can reflect its actual (possibly drag-stretched)
        // length instead of the node's own natural stepsPerCycle. Re-checked
        // against `node.id` in case the sequence changed underneath us.
        const entryItem = nodePopoverEntryCtx
          ? (layer.items.find((it) => it.id === nodePopoverEntryCtx.patternItemId) as RiffPatternItem | undefined)
          : undefined;
        const entry = entryItem?.sequence[nodePopoverEntryCtx?.entryIndex ?? -1];
        const activeEntry = entry && entry.type === node.id ? entry : null;
        const onResizeEntry = activeEntry && nodePopoverEntryCtx
          ? (lengthSteps: number) => {
              const { patternItemId, entryIndex } = nodePopoverEntryCtx;
              setCueLayersDoc((d) => d && ({
                ...d,
                layers: d.layers.map((l) => {
                  if (l.id !== layer.id || l.type !== 'riff-patterns') return l;
                  return {
                    ...l,
                    items: l.items.map((it) => {
                      if (it.id !== patternItemId) return it;
                      const item = it as RiffPatternItem;
                      return {
                        ...item,
                        sequence: item.sequence.map((e, i) => (i === entryIndex ? { ...e, lengthSteps } : e)),
                      };
                    }),
                  } as AnnotationLayer;
                }),
              }));
            }
          : undefined;
        // Boundary nodes can re-seed their blocks straight from another
        // layer's items inside this node's real placement — every onset/cue
        // layer (the same source the Cues → Riff Node escape hatch reads) and
        // every lyrics layer, so a node created empty (or one whose placement
        // moved) can pick up a detected rhythm, or a sung line's own
        // syllables, without being rebuilt by hand. Positions stay fractional:
        // no subdivision is inferred anywhere in this path. A lyric that
        // carries its own `end` (line-level) arrives as a held block; a bare
        // timestamp is a point tick like an onset. Layers with nothing inside
        // the node's own span aren't offered at all.
        const tickSources: BoundaryTickSource[] = [];
        if (isBoundaryNode(node) && occurrence && bpm) {
          const startBeatPos = beatPositionAt(occurrence.start, bpm, beatOffset);
          const toBeat = (t: number) => beatPositionAt(t, bpm, beatOffset) - startBeatPos;
          const nodeBeats = riffNodeLengthBeats(node);
          const addSource = (
            kind: BoundaryTickSource['kind'],
            layer: { id: string; name: string },
            hits: { beat: number; endBeat?: number; label?: string }[],
          ) => {
            // Converted up front rather than at click time, so the count in
            // the menu is the number of blocks that will actually land — not
            // the number of items in range, which is a bigger number whenever
            // two of them sit closer together than a block can be wide, or
            // fall outside the node's own span (which the placement's seconds
            // don't bound: an entry can be drag-stretched away from its
            // node's length).
            // A hit that brought its own duration (a lyric line) keeps it;
            // the rest — a cue layer's bare timestamps — get the length the
            // audio under this placement says they ring for, so re-seeding
            // from a detector produces the same shaped blocks as marking the
            // onsets directly does.
            const inRange = withMeasuredEnds(
              hits.filter((h) => h.beat >= 0 && h.beat < nodeBeats),
              levelCurveForSpan(occurrence.start, occurrence.end, nodeBeats),
              nodeBeats,
            );
            const segments = boundarySegmentsFromHits(inRange, nodeBeats);
            const ticks = segments.filter((s) => s.kind === 'tick');
            if (ticks.length === 0) return;
            tickSources.push({
              id: `${kind}:${layer.id}`,
              name: layer.name,
              kind,
              count: ticks.length,
              apply: () => onChange({ segments }),
              // Merge reads the node's CURRENT blocks, so it has to convert at
              // click time — unlike `apply`, whose result doesn't depend on
              // what's already there.
              applyMerge: () => onChange({
                segments: mergeBoundaryHits(node.segments ?? [], inRange, nodeBeats),
              }),
              // Where this layer's ticks actually land, so the strip can draw
              // and snap to the same positions the menu would seed from.
              tickBeats: ticks.map((s) => s.start),
            });
          };
          for (const l of [...(cueLayers ?? []), ...detectorCueLayers]) {
            addSource('cues', l, (l.items as CueItem[])
              .map((it) => ({ beat: toBeat(it.time), label: it.label || undefined })));
          }
          for (const l of [...lyricsLayers, ...detectorLyricsLayers]) {
            addSource('lyrics', l, (l.items as LyricsItem[])
              .map((it) => ({
                beat: toBeat(it.time),
                endBeat: it.end != null && it.end > it.time ? toBeat(it.end) : undefined,
                label: it.text || undefined,
              })));
          }
        }
        return (
          <NodeEditPopover
            node={node}
            tickSources={tickSources}
            // The browser-side spectral-flux curve, with the frame axis that
            // says when each of its values happened — the boundary editor cuts
            // its own window out of it and draws the node's blocks against it.
            // Null until the analysis finishes (or with no audio decoded).
            onsetEnvelope={mirCurves
              ? {
                  values: mirCurves.onsets,
                  // Loudness on the same frames. The flux says where each hit
                  // is; this says how long it rings, which is what the block
                  // seeded from it gets for a length instead of a flat beat.
                  level: mirCurves.rms,
                  // Real framing when the run reported it, so each value is
                  // dated at its window CENTRE. An older cached MirCurves
                  // carries only the hop, which puts the curve half a window
                  // early — still worth drawing, just not worth pretending
                  // about (see utils/frameTime).
                  axis: mirCurves.hopSize && mirCurves.fftSize && mirCurves.sampleRate
                    ? frameAxis(mirCurves.hopSize, mirCurves.fftSize, mirCurves.sampleRate, mirCurves.onsets.length)
                    : { step: mirCurves.frameDuration, offset: 0, count: mirCurves.onsets.length },
                }
              : null}
            // That envelope is whatever the player is loaded with — the mix
            // unless the user switched the player to a stem — so the picker
            // names it for what it is rather than always saying "audio".
            onsetEnvelopeName={selectedStemSource === 'mix' ? 'audio' : `audio · ${selectedStemSource}`}
            // The other stems, read on demand: a boundary node marking the
            // kick has no business being scored against a full-mix flux that
            // also fires on every vocal and cymbal.
            onsetStems={onsetStemSources}
            popoverRef={nodePopover.popoverRef}
            positionStyle={nodePopover.positionStyle}
            onChange={onChange}
            onDelete={onDelete}
            onClose={nodePopover.close}
            registerCloseGuard={nodePopover.setCloseGuard}
            bpm={bpm}
            occurrence={occurrence}
            isPlaying={nodeIsPlaying}
            currentTime={playerTime}
            onPlay={occurrence
              ? (preRollSec?: number) => handleSeekAndPlay(Math.max(0, occurrence.start - (preRollSec ?? 0)), occurrence.end)
              : undefined}
            onStop={handlePause}
            entryLengthSteps={activeEntry?.lengthSteps ?? null}
            onResizeEntry={onResizeEntry}
            onTrimLength={(beats) => handleRiffNodeTrim(layer.id, node.id, beats, `riff-trim:${layer.id}:${node.id}`)}
          />
        );
      })()}

      {/* Floating "⚡ Energy" export popover — opened from any tab's pending-
          selection pill via AnnotationAddPanel's onExportEnergy. */}
      {energySpanPopover.open && energySpanRange && selectedAudio && (
        <EnergySpanExportPopover
          popoverRef={energySpanPopover.popoverRef}
          positionStyle={energySpanPopover.positionStyle}
          onClose={energySpanPopover.close}
          songSlug={selectedAudio.id}
          startSec={energySpanRange.start}
          endSec={energySpanRange.end}
          mixAudioUrl={selectedAudio.url}
          stemManifest={stemManifest}
          spanLayerOptions={buildEnergySpanLayerOptions(
            spanLayers,
            pickDefaultLayerColor(cueLayersDoc?.layers ?? []),
          )}
          initialLayerId={energySpanTargetLayerId ?? undefined}
          onSaveToLayer={handleSaveEnergySpanToLayer}
        />
      )}

      {/* Floating Lyrics info/edit popover (opened by clicking a word/line on a
          lyrics-layer row). Resolves from user layers (editable) and detector-
          sourced layers (read-only), like the Cue popover. */}
      {lyricsPopover.open && (() => {
        const userLayer = cueLayersDoc?.layers.find((l) => l.id === lyricsPopover.open!.layerId) as AnnotationLayer<'lyrics'> | undefined;
        const detLayer  = detectorLyricsLayers.find((l) => l.id === lyricsPopover.open!.layerId);
        const layer = userLayer ?? detLayer;
        const item = layer?.items.find((it) => it.id === lyricsPopover.open!.itemId);
        if (!layer || !item) return null;
        const isReadOnly = layer.readOnly === true;
        const onChange = isReadOnly ? () => {} : (patch: Partial<LyricsItem>) => {
          setCueLayersDoc((d) => d && ({
            ...d,
            layers: d.layers.map((l) =>
              l.id === layer.id
                ? { ...l, items: l.items.map((it) => (it.id === item.id ? ({ ...it, ...patch } as typeof it) : it)) }
                : l,
            ),
          }));
        };
        const onDelete = isReadOnly ? () => {} : () => {
          setCueLayersDoc((d) => d && ({
            ...d,
            layers: d.layers.map((l) =>
              l.id === layer.id ? { ...l, items: l.items.filter((it) => it.id !== item.id) } : l,
            ),
          }));
        };
        const previewEnd = item.end !== undefined && item.end > item.time ? item.end : item.time + 0.5;
        const lyricIsPlaying = playerIsPlaying && playerTime >= item.time && playerTime < previewEnd;
        return (
          <LyricsEditPopover
            layer={layer}
            item={item}
            readOnly={isReadOnly}
            rawOutput={isReadOnly ? rawDetectorItem(layer.source, item.id, customResults) : undefined}
            popoverRef={lyricsPopover.popoverRef}
            positionStyle={lyricsPopover.positionStyle}
            onChange={onChange}
            onDelete={onDelete}
            onClose={lyricsPopover.close}
            onPlay={() => handleSeekAndPlay(item.time, previewEnd)}
            onStop={handlePause}
            isPlaying={lyricIsPlaying}
            bpm={bpm}
            gridOffset={songInfo?.gridOffset ?? 0}
            beatsPerBar={beatsPerBar}
            segments={gridSegments}
            currentTime={playerTime}
          />
        );
      })()}
    </div>
  );
}
