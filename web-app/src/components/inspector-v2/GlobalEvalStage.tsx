import { useState, useEffect, useMemo, useRef, Fragment } from 'react';
import { useSettings } from '../../context/SettingsContext';
import { loadAnnotation } from '../../services/manualAnnotations';
import {
  fetchMirEvalPairs,
  isMirEvalResult,
  useMirEvalPairs,
  type MirEvalPairWithId,
  type MirEvalResult,
} from '../../services/mirEvalClient';
import { evaluateCustom, type AlgoEvalResult } from '../../utils/evaluation';
import { CustomEvalControls, DEFAULT_CUSTOM_EVAL_SETTINGS, type CustomEvalSettings } from './CustomEvalControls';
import { EvalReferenceDropdown, type EvalReferenceMode } from './EvalReferenceDropdown';
import { GlobalEvalSpanTable } from './GlobalEvalSpanTable';
import { GlobalEvalLoopTable } from './GlobalEvalLoopTable';
import { GlobalEvalPatternTable } from './GlobalEvalPatternTable';
import { GlobalEvalLyricsTable } from './GlobalEvalLyricsTable';
import { GlobalEvalCueTable } from './GlobalEvalCueTable';
import type { ToolResultData, AllIn1Result } from '../../tools/runTool';
import type { AutoGuessCentroidMethod, ManualSection } from '../../types/manualAnnotation';

// ── Algo registry (mirrors InspectorPageV2) ─────────────────────────────────

const ALLIN1_FOLD_IDS = new Set([0, 1, 2, 3, 4, 5, 6, 7].map((n) => `allin1-fold${n}`));

// Ruptures CPD variants — 22 method/model combos cached as
// /analysis/<slug>/ruptures-<suffix>.json by tools/python/ruptures_server.py.
interface RupturesMethod { search: string; model: string; suffix: string }
const RUPTURES_METHODS: RupturesMethod[] = [
  { search: 'Pelt',     model: 'default', suffix: 'pelt-default'   },
  { search: 'Binseg',   model: 'default', suffix: 'binseg-default' },
  { search: 'Window',   model: 'default', suffix: 'window-default' },
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
const RUPTURES_TOOL_IDS = RUPTURES_METHODS.map((m) => `ruptures-${m.suffix}`);
const RUPTURES_TOOL_ID_SET = new Set(RUPTURES_TOOL_IDS);

const ALGO_ORDER: readonly string[] = [
  'msaf-olda', 'msaf-cnmf', 'msaf-foote', 'msaf-sf',
  'allin1',
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => `allin1-fold${n}`),
  ...RUPTURES_TOOL_IDS,
  'band-gradient',
];

const ALGO_META: Record<string, { label: string; group: string }> = {
  'msaf-olda':    { label: 'OLDA',         group: 'MSAF' },
  'msaf-cnmf':    { label: 'CNMF',         group: 'MSAF' },
  'msaf-foote':   { label: 'Foote',        group: 'MSAF' },
  'msaf-sf':      { label: 'SF',           group: 'MSAF' },
  'allin1':       { label: 'Ensemble',     group: 'AllIn1' },
  'allin1-fold0': { label: 'fold0',        group: 'AllIn1' },
  'allin1-fold1': { label: 'fold1',        group: 'AllIn1' },
  'allin1-fold2': { label: 'fold2',        group: 'AllIn1' },
  'allin1-fold3': { label: 'fold3',        group: 'AllIn1' },
  'allin1-fold4': { label: 'fold4',        group: 'AllIn1' },
  'allin1-fold5': { label: 'fold5',        group: 'AllIn1' },
  'allin1-fold6': { label: 'fold6',        group: 'AllIn1' },
  'allin1-fold7': { label: 'fold7',        group: 'AllIn1' },
  'band-gradient':{ label: 'Band Gradient',group: 'Other' },
  ...Object.fromEntries(RUPTURES_METHODS.map((m) => [
    `ruptures-${m.suffix}`,
    { label: `${m.search} · ${m.model}`, group: 'Ruptures' },
  ])),
};

const GROUP_ORDER = ['MSAF', 'AllIn1', 'Ruptures', 'Other'];

const GROUP_BADGE: Record<string, string> = {
  MSAF:     'bg-blue-900/40 text-blue-400 border-blue-800/40',
  AllIn1:   'bg-purple-900/40 text-purple-400 border-purple-800/40',
  Ruptures: 'bg-fuchsia-900/40 text-fuchsia-400 border-fuchsia-800/40',
  Other:    'bg-gray-800 text-gray-500 border-gray-700',
};

// ── Data loading helpers ─────────────────────────────────────────────────────

function sectionsFromResult(r: ToolResultData): { time: number }[] {
  const id = r.toolId;
  if (id === 'msaf-sf' || id === 'msaf-foote' || id === 'msaf-cnmf' || id === 'msaf-olda')
    return r.result.sections;
  if (id === 'allin1') return r.result.sections;
  if (ALLIN1_FOLD_IDS.has(id)) return (r.result as AllIn1Result).sections;
  if (RUPTURES_TOOL_ID_SET.has(id)) return (r.result as { sections: { time: number }[] }).sections;
  if (id === 'band-gradient') return r.result.sections;
  return [];
}

async function loadAlgoJson(songId: string, toolId: string): Promise<ToolResultData | null> {
  const algoSlug =
    toolId.startsWith('msaf-') ? toolId.replace('msaf-', '') :
    toolId === 'allin1' ? 'allin1' :
    ALLIN1_FOLD_IDS.has(toolId) ? toolId :
    toolId;
  try {
    const res = await fetch(`/analysis/${songId}/${algoSlug}.json`);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) return null;
    const data = await res.json();
    return { toolId, result: data } as ToolResultData;
  } catch {
    return null;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface AudioEntry { id: string; name: string; }

interface RawSongData {
  songId: string;
  songName: string;
  manualTimes: number[];
  manualSections: ManualSection[];
  algoTimes: Record<string, number[]>;
}

interface AlgoAggregate {
  toolId: string;
  label: string;
  group: string;
  songCount: number;
  precision: number;
  recall: number;
  f1: number;
  minF1: number;
  maxF1: number;
  // Custom evaluator aggregates
  cPrecision: number;
  cRecall: number;
  cF1: number;
  mnbd: number;
  csr: number;
  perSong: Array<{ songId: string; songName: string; mir: MirEvalResult | null; custom: AlgoEvalResult }>;
}

type SortKey =
  | 'algo' | 'group' | 'songs'
  | 'precision' | 'recall' | 'f1' | 'minF1' | 'maxF1'
  | 'cPrecision' | 'cRecall' | 'cF1' | 'mnbd' | 'csr';
type EvalRef = Extract<EvalReferenceMode, 'manual'>;

// ── Color helpers ─────────────────────────────────────────────────────────────

function metricColor(v: number) {
  const p = v * 100;
  if (p >= 70) return 'text-green-400';
  if (p >= 50) return 'text-yellow-400';
  if (p >= 30) return 'text-orange-400';
  return 'text-red-400';
}

function metricBg(v: number) {
  const p = v * 100;
  if (p >= 70) return 'bg-green-900/20';
  if (p >= 50) return 'bg-yellow-900/20';
  if (p >= 30) return 'bg-orange-900/20';
  return 'bg-red-900/20';
}

function mnbdColor(value: number): string {
  if (value <= 0.5) return 'text-green-400';
  if (value <= 1.5) return 'text-yellow-400';
  if (value <= 3)   return 'text-orange-400';
  return 'text-red-400';
}

function pct(v: number) { return `${Math.round(v * 100)}%`; }

// ── CSV download ─────────────────────────────────────────────────────────────

function csvField(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCSV(filename: string, rows: (string | number | null | undefined)[][]) {
  const csv = rows.map((r) => r.map(csvField).join(',')).join('\n') + '\n';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Sentinel duration for evaluateCustom — GlobalEvalStage doesn't load real
// track durations, but P/R/F1/MNBD/CSR don't depend on it (only the unused
// MDE-* metrics do).
const DURATION_SENTINEL = Number.MAX_SAFE_INTEGER;

// ── Consensus helpers (mirror AutoGuessPanel) ────────────────────────────────

const CENTROID_METHODS: { id: AutoGuessCentroidMethod; short: string; tooltip: string }[] = [
  { id: 'mean',    short: 'Mean',    tooltip: 'Arithmetic mean of all raw member times' },
  { id: 'eqgroup', short: 'EqGrp',   tooltip: 'One vote per algorithm — average of per-algo means' },
  { id: 'metamed', short: 'MetaMed', tooltip: 'Closest of {median, trimmed, tightest, eqgroup} to their mutual median' },
  { id: 'plural',  short: 'Plural',  tooltip: 'Most-agreed-upon of the four internal candidates (within 0.5s)' },
  { id: 'nearraw', short: 'NearRaw', tooltip: 'Raw timestamp with smallest total L1 distance to all others' },
];

function computeClusterTime(
  members: { algorithmId: string; time: number }[],
  method: AutoGuessCentroidMethod,
): number {
  const ts = [...members.map((m) => m.time)].sort((a, b) => a - b);
  const n = ts.length;
  const mean = ts.reduce((s, t) => s + t, 0) / n;
  if (method === 'mean' || n === 1) return mean;

  const mid = Math.floor(n / 2);
  const median = n % 2 === 1 ? ts[mid] : (ts[mid - 1] + ts[mid]) / 2;

  let trimmed = mean;
  if (n > 2) {
    const fi = ts.reduce((bi, t, i) => Math.abs(t - mean) > Math.abs(ts[bi] - mean) ? i : bi, 0);
    const arr = ts.filter((_, i) => i !== fi);
    trimmed = arr.reduce((s, t) => s + t, 0) / arr.length;
  }

  let tightest = ts[0];
  {
    const majority = Math.ceil(n / 2);
    let bestSpan = Infinity;
    for (let i = 0; i <= n - majority; i++) {
      const span = ts[i + majority - 1] - ts[i];
      if (span < bestSpan) { bestSpan = span; tightest = (ts[i] + ts[i + majority - 1]) / 2; }
    }
  }

  let eqgroup = mean;
  {
    const gm = new Map<string, number[]>();
    for (const m of members) {
      if (!gm.has(m.algorithmId)) gm.set(m.algorithmId, []);
      gm.get(m.algorithmId)!.push(m.time);
    }
    const reps = [...gm.values()].map((gts) => gts.reduce((s, t) => s + t, 0) / gts.length);
    eqgroup = reps.reduce((s, t) => s + t, 0) / reps.length;
  }

  if (method === 'eqgroup') return eqgroup;

  if (method === 'nearraw') {
    return ts.reduce((best, t) => {
      const sd = ts.reduce((s, u) => s + Math.abs(t - u), 0);
      const bd = ts.reduce((s, u) => s + Math.abs(best - u), 0);
      return sd < bd ? t : best;
    }, ts[0]);
  }

  const cands = [median, trimmed, tightest, eqgroup];

  if (method === 'metamed') {
    const sorted = [...cands].sort((a, b) => a - b);
    const mm = sorted.length % 2 === 1
      ? sorted[Math.floor(sorted.length / 2)]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    return cands.reduce((best, v) => Math.abs(v - mm) < Math.abs(best - mm) ? v : best, cands[0]);
  }

  // plural
  const scores = cands.map((v) => cands.filter((u) => Math.abs(u - v) <= 0.5).length);
  const maxS = Math.max(...scores);
  const winners = cands.filter((_, i) => scores[i] === maxS);
  return winners.reduce((best, v) => Math.abs(v - mean) < Math.abs(best - mean) ? v : best, winners[0]);
}

// Compute consensus boundary times for one song.
function computeConsensusTimes(
  algoTimes: Record<string, number[]>,
  includedAlgos: Set<string>,
  toleranceSec: number,
  minAgreement: number,
  method: AutoGuessCentroidMethod,
): number[] {
  const allPoints: { algorithmId: string; time: number }[] = [];
  for (const id of Object.keys(algoTimes)) {
    if (!includedAlgos.has(id)) continue;
    for (const t of algoTimes[id]) allPoints.push({ algorithmId: id, time: t });
  }
  if (!allPoints.length) return [];

  const sorted = [...allPoints].sort((a, b) => a.time - b.time);
  const clusters: { sum: number; count: number; members: { algorithmId: string; time: number }[] }[] = [];
  for (const pt of sorted) {
    let bestIdx = -1, bestDist = Infinity;
    for (let k = clusters.length - 1; k >= 0; k--) {
      const cent = clusters[k].sum / clusters[k].count;
      if (pt.time - cent > toleranceSec) break;
      const dist = Math.abs(pt.time - cent);
      if (dist <= toleranceSec && dist < bestDist) { bestDist = dist; bestIdx = k; }
    }
    if (bestIdx >= 0) {
      clusters[bestIdx].members.push(pt); clusters[bestIdx].sum += pt.time; clusters[bestIdx].count += 1;
    } else {
      clusters.push({ sum: pt.time, count: 1, members: [pt] });
    }
  }

  return clusters
    .filter((c) => new Set(c.members.map((m) => m.algorithmId)).size >= minAgreement)
    .map((c) => computeClusterTime(c.members, method));
}

// Aggregate consensus metrics across songs for a given parameter set.
// Sends a single batched request to /api/mir-eval/pairs with one pair per song;
// aggregates the returned P/R/F locally. The `useCandidates` flag is ignored —
// real mir_eval has no candidate-aware mode; the scheme-aware evaluator
// covers that case separately via `evaluateCustom`.
async function evaluateConsensusForDataset(
  rawData: RawSongData[],
  params: { tolEval: number; clusterTol: number; minAgreement: number; method: AutoGuessCentroidMethod; algos: Set<string> },
): Promise<{ precision: number; recall: number; f1: number; minF1: number; maxF1: number; songCount: number; meanBoundaries: number } | null> {
  const pairs: MirEvalPairWithId[] = [];
  const pairBoundaryCount = new Map<string, number>();
  for (const song of rawData) {
    const refTimes = song.manualTimes;
    if (!refTimes.length) continue;
    const cons = computeConsensusTimes(song.algoTimes, params.algos, params.clusterTol, params.minAgreement, params.method);
    if (!cons.length) continue;
    pairs.push({
      id: song.songId,
      refTimes,
      estTimes: cons,
      tolerance: params.tolEval,
      trackDuration: DURATION_SENTINEL,
    });
    pairBoundaryCount.set(song.songId, cons.length);
  }
  if (!pairs.length) return null;

  const results = await fetchMirEvalPairs(pairs);
  let pSum = 0, rSum = 0, f1Sum = 0, nbSum = 0, n = 0;
  let f1Min = 1, f1Max = 0;
  for (const pair of pairs) {
    const entry = results[pair.id];
    if (!isMirEvalResult(entry)) continue;
    pSum += entry.precision; rSum += entry.recall; f1Sum += entry.fmeasure;
    nbSum += pairBoundaryCount.get(pair.id) ?? 0;
    f1Min = Math.min(f1Min, entry.fmeasure);
    f1Max = Math.max(f1Max, entry.fmeasure);
    n++;
  }
  if (n === 0) return null;
  return {
    precision: pSum / n, recall: rSum / n, f1: f1Sum / n,
    minF1: f1Min, maxF1: f1Max, songCount: n, meanBoundaries: nbSum / n,
  };
}

interface BestParamsRow {
  algoIds: string[];
  source: 'sweep' | 'once';
  clusterTol: number;
  minAgreement: number;
  method: AutoGuessCentroidMethod;
  tolEval: number;
  songCount: number;
  precision: number;
  recall: number;
  f1: number;
  minF1: number;
  maxF1: number;
  meanBoundaries: number;
}

type BestParamsSortKey =
  | 'algoCount' | 'clusterTol' | 'minAgreement' | 'method' | 'tolEval'
  | 'precision' | 'recall' | 'f1' | 'songCount' | 'meanBoundaries';

// Configurable grid for the "Find best parameters" brute-force sweep.
// Algorithms are shared with the live Settings panel (selectedAlgos) — the
// sweep never iterates over algorithm subsets, only over τ / min-agreement /
// centroid (and optionally eval τ).
interface BestParamsSearchConfig {
  clusterTol:   { min: number; max: number; step: number };
  minAgreement: { min: number; max: number };
  evalTau:      { sweep: boolean; min: number; max: number; step: number };
  methods:      Set<AutoGuessCentroidMethod>;
}

const ALL_CENTROID_METHODS: AutoGuessCentroidMethod[] = ['mean', 'eqgroup', 'metamed', 'plural', 'nearraw'];

const DEFAULT_SEARCH_CONFIG: BestParamsSearchConfig = {
  clusterTol:   { min: 1,   max: 5, step: 0.5 },
  minAgreement: { min: 1,   max: 5 },
  evalTau:      { sweep: false, min: 0.5, max: 3, step: 0.5 },
  methods:      new Set(ALL_CENTROID_METHODS),
};

function buildNumericGrid(min: number, max: number, step: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step) || step <= 0 || min > max) return [];
  const out: number[] = [];
  // Guard against absurdly large grids (e.g. step=0.001 with min=0, max=100 → 100k values)
  const cap = 1000;
  for (let v = min; v <= max + 1e-9 && out.length < cap; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

function buildIntRange(min: number, max: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  const lo = Math.max(1, Math.round(min));
  const hi = Math.round(max);
  if (lo > hi) return [];
  const out: number[] = [];
  for (let v = lo; v <= hi; v++) out.push(v);
  return out;
}

const MAX_ALGOS_AVAILABLE = ALGO_ORDER.length;

type EvalMode = 'per-algo' | 'consensus';

// ── Component ─────────────────────────────────────────────────────────────────

export function GlobalEvalStage({ audioFiles }: { audioFiles: AudioEntry[] }) {
  const { settings } = useSettings();
  const [evalRef, setEvalRef] = useState<EvalRef>('manual');
  const [tolerance, setTolerance] = useState(0.5);
  const [sortKey, setSortKey] = useState<SortKey>('f1');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [expandedAlgo, setExpandedAlgo] = useState<string | null>(null);
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set());
  const [collapseFolds, setCollapseFolds] = useState(false);
  const [showControls, setShowControls] = useState(false);

  // ── Consensus mode state ─────────────────────────────────────────────────
  const [evalMode, setEvalMode] = useState<EvalMode>('per-algo');
  // Individual mode = single values (one Run once); Scan mode = ranges (Find best parameters).
  const [consensusMode, setConsensusMode] = useState<'individual' | 'scan'>('individual');
  const [clusterTol, setClusterTol] = useState(3);
  const [centroidMethod, setCentroidMethod] = useState<AutoGuessCentroidMethod>('metamed');
  const [minAgreement, setMinAgreement] = useState(2);
  const [selectedAlgos, setSelectedAlgos] = useState<Set<string>>(() => new Set(ALGO_ORDER));
  const [showParamsPopover, setShowParamsPopover] = useState(false);
  const [hoveredCentroidId, setHoveredCentroidId] = useState<AutoGuessCentroidMethod | null>(null);
  const [expandConsensusSongs, setExpandConsensusSongs] = useState(false);
  const [consensusSongSort, setConsensusSongSort] = useState<'f1' | 'precision' | 'recall' | 'name'>('f1');

  // ── Custom evaluator settings ────────────────────────────────────────────
  const [customSettings, setCustomSettings] = useState<CustomEvalSettings>(DEFAULT_CUSTOM_EVAL_SETTINGS);

  // ── Find best parameters state ───────────────────────────────────────────
  const [searching, setSearching] = useState(false);
  const [searchProgress, setSearchProgress] = useState(0);
  const [searchTotal, setSearchTotal] = useState(0);
  const [bestParamsRows, setBestParamsRows] = useState<BestParamsRow[] | null>(null);
  const [bestParamsTopN, setBestParamsTopN] = useState(20);
  const [bestParamsSortKey, setBestParamsSortKey] = useState<BestParamsSortKey>('f1');
  const [bestParamsSortDir, setBestParamsSortDir] = useState<'asc' | 'desc'>('desc');
  const [searchConfig, setSearchConfig] = useState<BestParamsSearchConfig>(DEFAULT_SEARCH_CONFIG);
  const [liveBest, setLiveBest] = useState<BestParamsRow | null>(null);
  const searchCancelRef = useRef(false);
  const paramsPopoverRef = useRef<HTMLDivElement>(null);
  const [showConsensusHelp, setShowConsensusHelp] = useState(false);

  // Raw data (loaded per audioFiles / loadKey)
  const [rawData, setRawData] = useState<RawSongData[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'done'>('loading');
  const [songsLoaded, setSongsLoaded] = useState(0);
  const [loadKey, setLoadKey] = useState(0);
  const totalSongs = audioFiles.length;

  // Close unified consensus-params popover on outside click
  useEffect(() => {
    if (!showParamsPopover) return;
    const handler = (e: MouseEvent) => {
      if (paramsPopoverRef.current && !paramsPopoverRef.current.contains(e.target as Node)) {
        setShowParamsPopover(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showParamsPopover]);

  // Clamp minAgreement when selection shrinks
  useEffect(() => {
    const max = Math.max(1, selectedAlgos.size);
    if (minAgreement > max) setMinAgreement(max);
  }, [selectedAlgos.size, minAgreement]);

  // ── Data loading ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!audioFiles.length) return;
    let cancelled = false;
    setLoadState('loading');
    setSongsLoaded(0);
    setRawData([]);

    async function loadAll() {
      const results: RawSongData[] = [];
      for (const song of audioFiles) {
        if (cancelled) break;
        const [manualAnn, ...algoResults] = await Promise.all([
          loadAnnotation(song.id),
          ...ALGO_ORDER.map((toolId) => loadAlgoJson(song.id, toolId)),
        ]);
        const algoTimes: Record<string, number[]> = {};
        ALGO_ORDER.forEach((toolId, idx) => {
          const r = algoResults[idx];
          if (r) {
            const secs = sectionsFromResult(r);
            if (secs.length) algoTimes[toolId] = secs.map((s) => s.time);
          }
        });
        // Defensive optional chain on `.sections` — some annotation files
        // (e.g. early stubs that only record metadata like `time_spent_seconds`)
        // have no sections field; without the chain `.map` throws on undefined.
        const manualSections = manualAnn?.sections ?? [];
        results.push({
          songId: song.id,
          songName: song.name,
          manualTimes: manualSections.map((s) => s.time),
          manualSections,
          algoTimes,
        });
        if (!cancelled) {
          setSongsLoaded(results.length);
          setRawData([...results]);
        }
      }
      if (!cancelled) setLoadState('done');
    }

    loadAll();
    return () => { cancelled = true; };
  }, [audioFiles, loadKey]);

  // ── Compute per-song × per-algo metrics ────────────────────────────────
  // mir_eval via debounced server fetch; scheme-aware `custom` evaluator stays
  // client-side. Pair IDs encode `${songId}|${toolId}` so the response maps
  // back cleanly. Hides `useCandidates` from the mir-eval column (real
  // mir_eval has no candidate-aware mode; the custom column carries that
  // logic alongside).
  const songAlgoPairs = useMemo<MirEvalPairWithId[] | null>(() => {
    const pairs: MirEvalPairWithId[] = [];
    for (const song of rawData) {
      const refTimes = song.manualTimes;
      if (!refTimes.length) continue;
      for (const [toolId, estTimes] of Object.entries(song.algoTimes)) {
        if (!estTimes.length) continue;
        pairs.push({
          id: `${song.songId}|${toolId}`,
          refTimes, estTimes, tolerance,
          trackDuration: DURATION_SENTINEL,
        });
      }
    }
    return pairs.length ? pairs : null;
  }, [rawData, evalRef, tolerance]);

  const { results: songAlgoMir, loading: mirLoading, error: mirError } = useMirEvalPairs(songAlgoPairs);

  const songMetrics = useMemo(() => {
    return rawData.map((song) => {
      const refTimes = song.manualTimes;
      const refSections = song.manualSections;
      const algoResults: Record<string, { mir: MirEvalResult | null; custom: AlgoEvalResult }> = {};
      if (refTimes.length) {
        for (const [toolId, estTimes] of Object.entries(song.algoTimes)) {
          if (estTimes.length) {
            const entry = songAlgoMir?.[`${song.songId}|${toolId}`];
            const mir = isMirEvalResult(entry) ? entry : null;
            const custom = evaluateCustom(refSections, estTimes, DURATION_SENTINEL, {
              toleranceSec: tolerance,
              optionalWeight: customSettings.optionalWeight,
              useSecondary: customSettings.useSecondary,
            });
            algoResults[toolId] = { mir, custom };
          }
        }
      }
      return { songId: song.songId, songName: song.songName, algoResults };
    });
  }, [rawData, evalRef, tolerance, customSettings.optionalWeight, customSettings.useSecondary, songAlgoMir]);

  // ── Aggregate per-algo ────────────────────────────────────────────────
  const algoAggregates = useMemo((): AlgoAggregate[] => {
    return ALGO_ORDER
      .filter((toolId) => {
        const meta = ALGO_META[toolId];
        if (!meta) return false;
        if (hiddenGroups.has(meta.group)) return false;
        if (collapseFolds && meta.group === 'AllIn1' && toolId !== 'allin1') return false;
        return true;
      })
      .map((toolId) => {
        const meta = ALGO_META[toolId] ?? { label: toolId, group: 'Other' };
        // Per-song entries where mir has loaded (custom is always present).
        // While the mir fetch is in flight, mir is null and that song
        // contributes 0 to the aggregate temporarily.
        const perSong = songMetrics
          .filter((sm) => sm.algoResults[toolId] !== undefined)
          .map((sm) => ({
            songId: sm.songId, songName: sm.songName,
            mir: sm.algoResults[toolId]!.mir,
            custom: sm.algoResults[toolId]!.custom,
          }));

        if (!perSong.length) {
          return {
            toolId, ...meta, songCount: 0,
            precision: 0, recall: 0, f1: 0, minF1: 0, maxF1: 0,
            cPrecision: 0, cRecall: 0, cF1: 0, mnbd: 0, csr: 0,
            perSong: [],
          };
        }
        const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
        const mirSongs = perSong.filter((r) => r.mir !== null) as Array<{ songId: string; songName: string; mir: MirEvalResult; custom: AlgoEvalResult }>;
        const f1s = mirSongs.map((r) => r.mir.fmeasure);
        const csrSongs = perSong.filter((r) => r.custom.criticalCount > 0);
        return {
          toolId, ...meta,
          songCount: perSong.length,
          precision: mean(mirSongs.map((r) => r.mir.precision)),
          recall:    mean(mirSongs.map((r) => r.mir.recall)),
          f1:        mean(f1s),
          minF1:     f1s.length ? Math.min(...f1s) : 0,
          maxF1:     f1s.length ? Math.max(...f1s) : 0,
          cPrecision: mean(perSong.map((r) => r.custom.precision)),
          cRecall:    mean(perSong.map((r) => r.custom.recall)),
          cF1:        mean(perSong.map((r) => r.custom.f1)),
          mnbd:       mean(perSong.map((r) => r.custom.mnbd)),
          csr:        csrSongs.length ? mean(csrSongs.map((r) => r.custom.csr)) : 1,
          perSong,
        };
      });
  }, [songMetrics, hiddenGroups, collapseFolds]);

  // ── Sort ─────────────────────────────────────────────────────────────
  const sortedAggregates = useMemo(() => {
    const rows = [...algoAggregates];
    rows.sort((a, b) => {
      let diff = 0;
      switch (sortKey) {
        case 'algo':       diff = a.label.localeCompare(b.label); break;
        case 'group':      diff = GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group); break;
        case 'songs':      diff = a.songCount - b.songCount; break;
        case 'precision':  diff = a.precision - b.precision; break;
        case 'recall':     diff = a.recall    - b.recall;    break;
        case 'f1':         diff = a.f1        - b.f1;        break;
        case 'minF1':      diff = a.minF1     - b.minF1;     break;
        case 'maxF1':      diff = a.maxF1     - b.maxF1;     break;
        case 'cPrecision': diff = a.cPrecision - b.cPrecision; break;
        case 'cRecall':    diff = a.cRecall   - b.cRecall;   break;
        case 'cF1':        diff = a.cF1       - b.cF1;       break;
        case 'mnbd':       diff = b.mnbd      - a.mnbd;      break; // lower is better — invert
        case 'csr':        diff = a.csr       - b.csr;       break;
      }
      return sortDir === 'desc' ? -diff : diff;
    });
    return rows;
  }, [algoAggregates, sortKey, sortDir]);

  function handleSortClick(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortKey(key); setSortDir('desc'); }
  }

  function SortArrow({ col }: { col: SortKey }) {
    if (sortKey !== col) return <span className="text-gray-700 ml-0.5">↕</span>;
    return <span className="text-indigo-400 ml-0.5">{sortDir === 'desc' ? '↓' : '↑'}</span>;
  }

  // ── Best parameters table sort ───────────────────────────────────────────
  const sortedBestParamsRows = useMemo(() => {
    if (!bestParamsRows) return null;
    const rows = [...bestParamsRows];
    rows.sort((a, b) => {
      let diff = 0;
      switch (bestParamsSortKey) {
        case 'algoCount':       diff = a.algoIds.length  - b.algoIds.length;  break;
        case 'method':          diff = a.method.localeCompare(b.method); break;
        case 'clusterTol':      diff = a.clusterTol      - b.clusterTol;      break;
        case 'minAgreement':    diff = a.minAgreement    - b.minAgreement;    break;
        case 'tolEval':         diff = a.tolEval         - b.tolEval;         break;
        case 'precision':       diff = a.precision       - b.precision;       break;
        case 'recall':          diff = a.recall          - b.recall;          break;
        case 'f1':              diff = a.f1              - b.f1;              break;
        case 'songCount':       diff = a.songCount       - b.songCount;       break;
        case 'meanBoundaries':  diff = a.meanBoundaries  - b.meanBoundaries;  break;
      }
      return bestParamsSortDir === 'desc' ? -diff : diff;
    });
    return rows;
  }, [bestParamsRows, bestParamsSortKey, bestParamsSortDir]);

  function handleBestParamsSortClick(key: BestParamsSortKey) {
    if (bestParamsSortKey === key) setBestParamsSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setBestParamsSortKey(key); setBestParamsSortDir('desc'); }
  }

  function BestParamsSortArrow({ col }: { col: BestParamsSortKey }) {
    if (bestParamsSortKey !== col) return <span className="text-gray-700 ml-0.5">↕</span>;
    return <span className="text-indigo-400 ml-0.5">{bestParamsSortDir === 'desc' ? '↓' : '↑'}</span>;
  }

  // Insert group-header rows when sorting by group or algo
  const tableRows = useMemo(() => {
    type RowItem =
      | { type: 'group'; group: string }
      | { type: 'algo'; algo: AlgoAggregate };

    if (sortKey !== 'group' && sortKey !== 'algo') {
      return sortedAggregates.map((algo): RowItem => ({ type: 'algo', algo }));
    }
    const result: RowItem[] = [];
    let lastGroup = '';
    for (const algo of sortedAggregates) {
      if (algo.group !== lastGroup) {
        result.push({ type: 'group', group: algo.group });
        lastGroup = algo.group;
      }
      result.push({ type: 'algo', algo });
    }
    return result;
  }, [sortedAggregates, sortKey]);

  const songsWithManual = rawData.filter((d) => d.manualTimes.length > 0).length;

  // ── Consensus per-song & aggregate (for consensus mode) ───────────────
  // Pre-compute consensus times per song (no mir_eval yet), then batch P/R/F
  // for the populated ones through the debounced server fetch.
  const consensusBySong = useMemo(() => {
    return rawData.map((song) => ({
      songId: song.songId,
      songName: song.songName,
      cons: computeConsensusTimes(song.algoTimes, selectedAlgos, clusterTol, minAgreement, centroidMethod),
      refTimes: song.manualTimes,
      refSections: song.manualSections,
    }));
  }, [rawData, evalRef, selectedAlgos, clusterTol, minAgreement, centroidMethod]);

  const consensusPairs = useMemo<MirEvalPairWithId[] | null>(() => {
    const pairs = consensusBySong
      .filter((s) => s.refTimes.length > 0 && s.cons.length > 0)
      .map((s) => ({
        id: s.songId,
        refTimes: s.refTimes,
        estTimes: s.cons,
        tolerance,
        trackDuration: DURATION_SENTINEL,
      }));
    return pairs.length ? pairs : null;
  }, [consensusBySong, tolerance]);

  const { results: consensusMir } = useMirEvalPairs(consensusPairs);

  const consensusPerSong = useMemo(() => {
    return consensusBySong.map((s) => {
      const entry = consensusMir?.[s.songId];
      const result = isMirEvalResult(entry) ? entry : null;
      const custom = (s.refTimes.length && s.cons.length)
        ? evaluateCustom(s.refSections, s.cons, DURATION_SENTINEL, {
            toleranceSec: tolerance,
            optionalWeight: customSettings.optionalWeight,
            useSecondary: customSettings.useSecondary,
          })
        : null;
      return {
        songId: s.songId, songName: s.songName,
        consensusTimes: s.cons, refCount: s.refTimes.length,
        result, custom,
      };
    });
  }, [consensusBySong, tolerance, customSettings.optionalWeight, customSettings.useSecondary, consensusMir]);

  const consensusAggregate = useMemo(() => {
    const valid = consensusPerSong.filter((s) => s.result !== null);
    if (!valid.length) return null;
    const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const f1s = valid.map((s) => s.result!.fmeasure);
    const customValid = valid.filter((s) => s.custom !== null);
    const csrSongs = customValid.filter((s) => s.custom!.criticalCount > 0);
    return {
      songCount: valid.length,
      precision: mean(valid.map((s) => s.result!.precision)),
      recall:    mean(valid.map((s) => s.result!.recall)),
      f1:        mean(f1s),
      minF1:     Math.min(...f1s),
      maxF1:     Math.max(...f1s),
      meanBoundaries: mean(valid.map((s) => s.consensusTimes.length)),
      // Custom evaluator aggregates
      cPrecision: customValid.length ? mean(customValid.map((s) => s.custom!.precision)) : 0,
      cRecall:    customValid.length ? mean(customValid.map((s) => s.custom!.recall))    : 0,
      cF1:        customValid.length ? mean(customValid.map((s) => s.custom!.f1))        : 0,
      mnbd:       customValid.length ? mean(customValid.map((s) => s.custom!.mnbd))      : 0,
      csr:        csrSongs.length    ? mean(csrSongs.map((s)    => s.custom!.csr))       : 1,
    };
  }, [consensusPerSong]);

  const sortedConsensusSongs = useMemo(() => {
    const rows = [...consensusPerSong];
    const metric = (r: MirEvalResult | null): number => {
      if (!r) return -1;
      if (consensusSongSort === 'precision') return r.precision;
      if (consensusSongSort === 'recall')    return r.recall;
      return r.fmeasure;
    };
    rows.sort((a, b) => {
      if (consensusSongSort === 'name') return a.songName.localeCompare(b.songName);
      return metric(b.result) - metric(a.result);
    });
    return rows;
  }, [consensusPerSong, consensusSongSort]);

  // ── CSV exports (in current sort order) ────────────────────────────────
  function exportPerAlgoCSV() {
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `per-algo_vs-${evalRef}_tau${tolerance}s_${stamp}.csv`;
    const rows: (string | number | null | undefined)[][] = [
      [
        'Algorithm', 'Group', 'Songs', 'TotalSongs',
        'Precision', 'Recall', 'F1', 'WorstF1', 'BestF1',
        'CustomP', 'CustomR', 'CustomF1', 'MNBD', 'CSR',
      ],
    ];
    for (const a of sortedAggregates) {
      if (a.songCount === 0) {
        rows.push([a.label, a.group, 0, totalSongs, '', '', '', '', '', '', '', '', '', '']);
        continue;
      }
      rows.push([
        a.label, a.group, a.songCount, totalSongs,
        a.precision.toFixed(4), a.recall.toFixed(4), a.f1.toFixed(4),
        a.minF1.toFixed(4), a.maxF1.toFixed(4),
        a.cPrecision.toFixed(4), a.cRecall.toFixed(4), a.cF1.toFixed(4),
        a.mnbd.toFixed(4), a.csr.toFixed(4),
      ]);
    }
    downloadCSV(filename, rows);
  }

  function exportConsensusCSV() {
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `auto-consensus_vs-${evalRef}_tau${tolerance}s_clust${clusterTol}s_min${minAgreement}_${centroidMethod}_${stamp}.csv`;
    const rows: (string | number | null | undefined)[][] = [
      [
        'Song',
        'Precision', 'Recall', 'F1', 'Hits', 'Ref',
        'CustomP', 'CustomR', 'CustomF1', 'MNBD', 'CSR', 'CriticalCount',
        'ConsensusBoundaries',
      ],
    ];
    for (const sr of sortedConsensusSongs) {
      rows.push([
        sr.songName,
        sr.result?.precision.toFixed(4) ?? '',
        sr.result?.recall.toFixed(4) ?? '',
        sr.result?.fmeasure.toFixed(4) ?? '',
        sr.result?.hitCount ?? '',
        sr.result?.refCount ?? '',
        sr.custom?.precision.toFixed(4) ?? '',
        sr.custom?.recall.toFixed(4) ?? '',
        sr.custom?.f1.toFixed(4) ?? '',
        sr.custom?.mnbd.toFixed(4) ?? '',
        sr.custom && sr.custom.criticalCount > 0 ? sr.custom.csr.toFixed(4) : '',
        sr.custom?.criticalCount ?? '',
        sr.consensusTimes.length,
      ]);
    }
    downloadCSV(filename, rows);
  }

  // ── Find best parameters (grid search) ─────────────────────────────────

  // Computes effective combo count + validation issues from the current
  // searchConfig. Effective = combos that survive the "minA > algos.size"
  // skip in runFindBestParams.
  const searchPlan = useMemo(() => {
    const tolGrid = buildNumericGrid(searchConfig.clusterTol.min, searchConfig.clusterTol.max, searchConfig.clusterTol.step);
    const minAgreeGrid = buildIntRange(searchConfig.minAgreement.min, Math.min(MAX_ALGOS_AVAILABLE, searchConfig.minAgreement.max));
    const evalGrid = searchConfig.evalTau.sweep
      ? buildNumericGrid(searchConfig.evalTau.min, searchConfig.evalTau.max, searchConfig.evalTau.step)
      : [tolerance];
    const algoCount = selectedAlgos.size;
    const tolN = tolGrid.length;
    const minA = minAgreeGrid.length;
    const mN = searchConfig.methods.size;
    const eN = evalGrid.length;
    const upperBound = tolN * minA * mN * eN;
    const validMinACount = minAgreeGrid.filter((m) => m <= algoCount).length;
    const effective = tolN * validMinACount * mN * eN;
    const issues: string[] = [];
    if (tolN === 0)    issues.push('Cluster τ range is empty — check min/max/step.');
    if (minA === 0)    issues.push('Min-agreement range is empty — min must be ≤ max.');
    if (mN === 0)      issues.push('No centroid methods selected.');
    if (algoCount === 0) issues.push('No algorithms selected.');
    if (eN === 0)      issues.push('Eval τ range is empty.');
    if (!issues.length && effective === 0) issues.push(`Min-agreement ${minAgreeGrid[0]} exceeds the selected algorithm count (${algoCount}).`);
    return { tolN, minA, mN, eN, algoCount, upperBound, effective, skipped: upperBound - effective, issues, invalid: issues.length > 0 };
  }, [searchConfig, tolerance, selectedAlgos]);

  async function runFindBestParams() {
    if (!rawData.length) return;
    setSearching(true);
    setBestParamsRows(null);
    setLiveBest(null);
    searchCancelRef.current = false;

    const tolGrid = buildNumericGrid(searchConfig.clusterTol.min, searchConfig.clusterTol.max, searchConfig.clusterTol.step);
    const minAgreeGrid = buildIntRange(searchConfig.minAgreement.min, Math.min(MAX_ALGOS_AVAILABLE, searchConfig.minAgreement.max));
    const methods = ALL_CENTROID_METHODS.filter((m) => searchConfig.methods.has(m));
    const evalTauGrid = searchConfig.evalTau.sweep
      ? buildNumericGrid(searchConfig.evalTau.min, searchConfig.evalTau.max, searchConfig.evalTau.step)
      : [tolerance];
    const algos = new Set(selectedAlgos);
    const algoIds = [...algos];

    if (tolGrid.length === 0 || minAgreeGrid.length === 0 || methods.length === 0 || algos.size === 0 || evalTauGrid.length === 0) {
      setSearching(false);
      return;
    }

    const total = tolGrid.length * minAgreeGrid.length * methods.length * evalTauGrid.length;
    setSearchTotal(total);
    setSearchProgress(0);

    const out: BestParamsRow[] = [];
    let bestSoFar: BestParamsRow | null = null;
    let done = 0;
    for (const tolC of tolGrid) {
      if (searchCancelRef.current) break;
      for (const minA of minAgreeGrid) {
        if (minA > algos.size) { done += methods.length * evalTauGrid.length; continue; }
        for (const m of methods) {
          for (const tauE of evalTauGrid) {
            if (searchCancelRef.current) break;
            const r = await evaluateConsensusForDataset(rawData, {
              tolEval: tauE, clusterTol: tolC, minAgreement: minA, method: m, algos,
            });
            if (r) {
              const row: BestParamsRow = {
                algoIds,
                source: 'sweep',
                clusterTol: tolC,
                minAgreement: minA,
                method: m,
                tolEval: tauE,
                ...r,
              };
              out.push(row);
              if (!bestSoFar || row.f1 > bestSoFar.f1) bestSoFar = row;
            }
            done++;
          }
        }
      }
      setSearchProgress(done);
      setLiveBest(bestSoFar);
      // UI yield happens naturally via the awaited fetch per inner-loop iter.
    }

    out.sort((a, b) => b.f1 - a.f1);
    setBestParamsRows(out);
    setLiveBest(out[0] ?? null);
    setSearching(false);
  }

  async function runOnceConsensus() {
    if (!rawData.length || selectedAlgos.size === 0) return;
    const r = await evaluateConsensusForDataset(rawData, {
      tolEval: tolerance,
      clusterTol,
      minAgreement: Math.min(minAgreement, selectedAlgos.size),
      method: centroidMethod,
      algos: selectedAlgos,
    });
    if (!r) return;
    const row: BestParamsRow = {
      algoIds: [...selectedAlgos],
      source: 'once',
      clusterTol,
      minAgreement: Math.min(minAgreement, selectedAlgos.size),
      method: centroidMethod,
      tolEval: tolerance,
      ...r,
    };
    setBestParamsRows((prev) => {
      const merged = prev ? [...prev, row] : [row];
      merged.sort((a, b) => b.f1 - a.f1);
      return merged;
    });
  }

  function applyBestParams(row: BestParamsRow) {
    setClusterTol(row.clusterTol);
    setMinAgreement(row.minAgreement);
    setCentroidMethod(row.method);
    setSelectedAlgos(new Set(row.algoIds));
    setTolerance(row.tolEval);
    setEvalMode('consensus');
  }

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4 pt-1">

      {/* ── Header (collapsible) ─────────────────────────────────────────── */}
      <div className="space-y-2">
        <button
          onClick={() => setShowControls((v) => !v)}
          className="flex items-center gap-2 text-sm font-semibold text-gray-200 hover:text-gray-100 transition-colors w-full text-left"
        >
          <svg
            className={`w-3 h-3 text-gray-500 transition-transform ${showControls ? 'rotate-90' : ''}`}
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
          </svg>
          Dataset Evaluation
          <span className="text-[11px] text-gray-600 font-normal">· {totalSongs} songs</span>
          {!showControls && (
            <span className="text-[11px] text-gray-500 font-normal ml-1">
              · {evalMode === 'per-algo' ? 'Per-algorithm' : 'Auto-Consensus'}
              {' '}vs <span className="text-gray-400">{evalRef}</span>
              {' '}· τ = <span className="font-mono text-gray-400">{tolerance}s</span>
              {evalMode === 'per-algo' && <> · sort <span className="text-gray-400">{sortKey}</span></>}
            </span>
          )}
        </button>

        {showControls && (
          <div className="bg-[#14171d] border border-white/[0.08] rounded-md p-3 space-y-3">
            {/* Row 1: Mode | Reference | Tolerance | Sort | CSV */}
            <div className="flex items-center gap-x-4 gap-y-2 flex-wrap">
              {/* Mode toggle */}
              <div className="inline-flex rounded border border-gray-700 overflow-hidden">
                {(['per-algo', 'consensus'] as EvalMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setEvalMode(m)}
                    className={`px-3 py-1 text-xs transition-colors ${
                      evalMode === m
                        ? m === 'consensus'
                          ? 'bg-violet-700 text-white'
                          : 'bg-indigo-700 text-white'
                        : 'bg-gray-800 text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    {m === 'per-algo' ? 'Per-algorithm' : 'Auto-Consensus'}
                  </button>
                ))}
              </div>

              {/* Reference */}
              <EvalReferenceDropdown
                value={evalRef}
                onChange={(mode) => {
                  if (mode === 'manual') setEvalRef(mode);
                }}
                options={[
                  { mode: 'manual',    hasData: songsWithManual > 0 },
                  { mode: 'autoGuess', hasData: false },
                ]}
              />

              {/* Tolerance */}
              <div className="flex items-center gap-2 text-[11px] text-gray-500">
                <span>τ =</span>
                <input
                  type="range" min="0.25" max="5" step="0.25"
                  value={tolerance}
                  onChange={(e) => setTolerance(Number(e.target.value))}
                  className="w-20 accent-indigo-500"
                />
                <span className="font-mono text-gray-300 w-8">{tolerance}s</span>
              </div>

              {/* Sort-by (per-algo only) */}
              {evalMode === 'per-algo' && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-gray-500">Sort</span>
                  <select
                    value={sortKey}
                    onChange={(e) => { setSortKey(e.target.value as SortKey); setSortDir('desc'); }}
                    className="bg-gray-800 border border-gray-700 text-gray-300 rounded px-2 py-0.5 text-[11px]"
                  >
                    <option value="group">Group</option>
                    <option value="algo">Algorithm</option>
                    <option value="songs">Songs</option>
                    <optgroup label="mir_eval">
                      <option value="precision">Precision</option>
                      <option value="recall">Recall</option>
                      <option value="f1">Mean F1</option>
                      <option value="minF1">Worst F1</option>
                      <option value="maxF1">Best F1</option>
                    </optgroup>
                    <optgroup label="custom">
                      <option value="cPrecision">Custom P</option>
                      <option value="cRecall">Custom R</option>
                      <option value="cF1">Custom F1</option>
                      <option value="mnbd">MNBD (asc.)</option>
                      <option value="csr">CSR</option>
                    </optgroup>
                  </select>
                  <button
                    onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
                    title="Toggle sort direction"
                    className="text-gray-500 hover:text-gray-300 transition-colors text-xs px-1"
                  >
                    {sortDir === 'desc' ? '↓' : '↑'}
                  </button>
                </div>
              )}

              {/* CSV export (per-algo only) */}
              {evalMode === 'per-algo' && (
                <button
                  onClick={exportPerAlgoCSV}
                  disabled={sortedAggregates.length === 0}
                  title="Download the per-algorithm table as CSV in the current sort order"
                  className="ml-auto text-[11px] px-2.5 py-1 rounded border border-gray-700 bg-gray-800 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  ⬇ CSV
                </button>
              )}
            </div>

            {/* Row 2: Groups + AllIn1 collapse (per-algo only) */}
            {evalMode === 'per-algo' && (
              <div className="pt-3 border-t border-white/[0.06] space-y-1.5">
                <span className="text-[10px] uppercase tracking-wider text-slate-500">Groups</span>
                <div className="flex items-center gap-3 flex-wrap">
                  {GROUP_ORDER.map((group) => (
                    <label key={group} className="flex items-center gap-1.5 cursor-pointer select-none text-[11px]">
                      <input
                        type="checkbox"
                        checked={!hiddenGroups.has(group)}
                        onChange={() => setHiddenGroups((prev) => {
                          const next = new Set(prev);
                          if (next.has(group)) next.delete(group); else next.add(group);
                          return next;
                        })}
                        className="accent-indigo-500"
                      />
                      <span className={!hiddenGroups.has(group) ? 'text-gray-200' : 'text-gray-600'}>{group}</span>
                    </label>
                  ))}
                  <label className="flex items-center gap-1.5 cursor-pointer select-none text-[11px]">
                    <input
                      type="checkbox"
                      checked={collapseFolds}
                      onChange={() => setCollapseFolds((v) => !v)}
                      className="accent-indigo-500"
                    />
                    <span className="text-gray-400">AllIn1: Ensemble only (hide folds)</span>
                  </label>
                </div>
              </div>
            )}

            {/* Row 3: Custom eval (per-algo only) */}
            {evalMode === 'per-algo' && (
              <div className="pt-3 border-t border-white/[0.06] space-y-1.5">
                <span className="text-[10px] uppercase tracking-wider text-amber-400">Custom eval</span>
                <CustomEvalControls settings={customSettings} onChange={setCustomSettings} compact />
              </div>
            )}

            {/* Row 4: Reload */}
            <div className="pt-3 border-t border-white/[0.06]">
              <button
                onClick={() => {
                  setRawData([]);
                  setSongsLoaded(0);
                  setLoadState('loading');
                  setLoadKey((k) => k + 1);
                }}
                className="text-[11px] px-2.5 py-1 rounded border border-gray-700 bg-gray-800 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
                title="Re-fetch all per-song JSON and recompute aggregates"
              >
                ↻ Reload all songs
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Status bar ───────────────────────────────────────────────────── */}
      {loadState === 'loading' ? (
        <div className="flex items-center gap-2 text-[11px] text-gray-500">
          <span className="inline-block w-3 h-3 border border-indigo-400 border-t-transparent rounded-full animate-spin" />
          Loading {songsLoaded} / {totalSongs} songs…
        </div>
      ) : mirLoading ? (
        <div className="flex items-center gap-2 text-[11px] text-gray-500">
          <span className="inline-block w-3 h-3 border border-indigo-400 border-t-transparent rounded-full animate-spin" />
          Computing mir_eval for {songAlgoPairs?.length ?? 0} song × algorithm pairs…
        </div>
      ) : (
        <div className="text-[11px] text-gray-600">
          {totalSongs} songs · {songsWithManual} with Manual ·{' '}
          evaluating against <span className="text-gray-400">{evalRef}</span> at τ = {tolerance}s
        </div>
      )}

      {mirError && (
        <div className="rounded border border-red-900/50 bg-red-900/10 px-3 py-1.5 text-[11px] text-red-400">
          mir_eval server unreachable: {mirError}{' '}
          <span className="text-red-600">— run <code className="text-red-500">python tools/python/mir_eval_server.py</code></span>
        </div>
      )}

      {loadState === 'done' && !mirLoading && !mirError && rawData.length > 0 && songAlgoPairs === null && (
        <div className="rounded border border-amber-900/50 bg-amber-900/10 px-3 py-1.5 text-[11px] text-amber-400 leading-relaxed">
          {songsWithManual === 0 ? (
            <>No <span className="text-amber-300">Manual</span> annotations to evaluate against.</>
          ) : (
            <>No algorithms cache — please run algorithms.</>
          )}
        </div>
      )}

      {/* ── Consensus controls (consensus mode only) ───────────────────── */}
      {evalMode === 'consensus' && (
        <div className="rounded-lg border border-violet-800/40 bg-violet-950/20 p-3 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-violet-300 uppercase tracking-wide">
                Auto-Consensus parameters
              </span>
              <button
                type="button"
                onClick={() => setShowConsensusHelp((v) => !v)}
                className={`text-[10px] w-4 h-4 rounded-full border flex items-center justify-center transition-colors ${
                  showConsensusHelp
                    ? 'border-violet-400 bg-violet-700 text-white'
                    : 'border-violet-700 text-violet-400 hover:bg-violet-900/40'
                }`}
                aria-label="Toggle help"
                title="What is Auto-Consensus?"
              >
                ?
              </button>
              <span className="text-[10px] text-violet-400/60 italic hidden md:inline">
                pool every algorithm's boundaries → keep the moments most algos agree on
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Mode toggle: Individual / Scan */}
              <div className="inline-flex rounded border border-violet-700/60 overflow-hidden text-[10px] uppercase tracking-wider">
                {(['individual', 'scan'] as const).map((m) => {
                  const isActive = consensusMode === m;
                  return (
                    <button key={m}
                      onClick={() => setConsensusMode(m)}
                      disabled={searching}
                      className={`px-2.5 py-1 transition-colors ${
                        isActive
                          ? m === 'scan' ? 'bg-amber-700/40 text-amber-200' : 'bg-violet-700/40 text-violet-200'
                          : 'bg-gray-900 text-gray-500 hover:text-gray-300'
                      } disabled:opacity-40 disabled:cursor-not-allowed`}
                      title={m === 'individual' ? 'Pick exact values and run once' : 'Sweep ranges to find the best F1'}
                    >
                      {m === 'individual' ? '▶ Individual' : '🔍 Scan'}
                    </button>
                  );
                })}
              </div>

              {/* Unified params popover (Individual = single values, Scan = ranges) */}
              <div className="relative" ref={paramsPopoverRef}>
                <button
                  onClick={() => setShowParamsPopover((v) => !v)}
                  disabled={searching}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[10px] uppercase tracking-wider border transition-colors ${
                    consensusMode === 'scan' && searchPlan.invalid
                      ? 'bg-red-900/30 border-red-600/60 text-red-300'
                      : showParamsPopover
                        ? 'bg-violet-500/15 border-violet-400/40 text-violet-200'
                        : 'bg-white/[0.04] border-white/[0.06] text-slate-300 hover:border-white/[0.12]'
                  } disabled:opacity-40 disabled:cursor-not-allowed`}
                  title={consensusMode === 'individual'
                    ? 'Edit single values (cluster τ, min-agreement, centroid, algorithms)'
                    : (searchPlan.invalid ? `Scan settings invalid: ${searchPlan.issues.join(' · ')}` : `${searchPlan.effective.toLocaleString()} combinations will run`)}
                >
                  <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
                  </svg>
                  Params
                  <span className="text-slate-500 font-mono normal-case tracking-normal">
                    {consensusMode === 'individual'
                      ? `${selectedAlgos.size}/${ALGO_ORDER.length} · ${clusterTol}s · ${CENTROID_METHODS.find((m) => m.id === centroidMethod)?.short ?? centroidMethod}${minAgreement > 1 ? ` · ≥${minAgreement}` : ''}`
                      : `${searchPlan.effective.toLocaleString()} combos`}
                  </span>
                  {consensusMode === 'scan' && searchPlan.skipped > 0 && !searchPlan.invalid && (
                    <span className="text-amber-500" title={`${searchPlan.skipped.toLocaleString()} combos skipped because min-agreement exceeds selected algorithm count`}>⚠</span>
                  )}
                  <svg className={`w-3 h-3 text-slate-500 transition-transform ${showParamsPopover ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                </button>

                {showParamsPopover && (
                  <div className="absolute z-50 top-full mt-1 right-0 bg-[#14171d] border border-white/[0.08] rounded-md shadow-2xl shadow-black/60 p-3 w-[28rem] max-h-[34rem] overflow-y-auto space-y-3">
                    {/* Mode toggle inside popover + Scan reset */}
                    <div className="flex items-center justify-between">
                      <div className="inline-flex rounded border border-white/[0.08] overflow-hidden text-[10px] uppercase tracking-wider">
                        {(['individual', 'scan'] as const).map((m) => {
                          const isActive = consensusMode === m;
                          return (
                            <button key={m}
                              onClick={() => setConsensusMode(m)}
                              className={`px-2 py-0.5 transition-colors ${
                                isActive
                                  ? m === 'scan' ? 'bg-amber-700/40 text-amber-200' : 'bg-violet-700/40 text-violet-200'
                                  : 'bg-black/30 text-slate-500 hover:text-slate-300'
                              }`}
                            >
                              {m === 'individual' ? 'Individual' : 'Scan'}
                            </button>
                          );
                        })}
                      </div>
                      {consensusMode === 'scan' && (
                        <button
                          onClick={() => setSearchConfig(DEFAULT_SEARCH_CONFIG)}
                          className="text-[10px] uppercase tracking-wider text-slate-500 hover:text-slate-200"
                          title="Reset all scan ranges to defaults"
                        >
                          reset ranges
                        </button>
                      )}
                    </div>

                    {/* Cluster τ */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] uppercase tracking-wider text-slate-400">Cluster τ (s)</label>
                        {consensusMode === 'scan' && (
                          <span className="text-[10px] font-mono text-slate-600">{searchPlan.tolN} values</span>
                        )}
                      </div>
                      {consensusMode === 'individual' ? (
                        <div className="flex items-center gap-2">
                          <input type="range" min={0.5} max={10} step={0.5}
                            value={clusterTol}
                            onChange={(e) => setClusterTol(Number(e.target.value))}
                            className="flex-1 accent-violet-500" />
                          <span className="text-[11px] font-mono text-violet-300 w-10 text-right tabular-nums">{clusterTol}s</span>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-1.5 text-[11px]">
                            <input type="number" step="0.25" min="0.25" max="20" value={searchConfig.clusterTol.min}
                              onChange={(e) => {
                                const v = Math.max(0.05, Math.min(20, Number(e.target.value)));
                                setSearchConfig((c) => ({ ...c, clusterTol: { ...c.clusterTol, min: Number.isFinite(v) ? v : 0.25 } }));
                              }}
                              className="w-14 bg-[#0a0b0d] border border-white/[0.08] text-slate-200 font-mono rounded px-1.5 py-0.5 focus:outline-none focus:border-amber-500/50" />
                            <span className="text-slate-500">→</span>
                            <input type="number" step="0.25" min="0.25" max="20" value={searchConfig.clusterTol.max}
                              onChange={(e) => {
                                const v = Math.max(0.05, Math.min(20, Number(e.target.value)));
                                setSearchConfig((c) => ({ ...c, clusterTol: { ...c.clusterTol, max: Number.isFinite(v) ? v : 5 } }));
                              }}
                              className="w-14 bg-[#0a0b0d] border border-white/[0.08] text-slate-200 font-mono rounded px-1.5 py-0.5 focus:outline-none focus:border-amber-500/50" />
                            <span className="text-slate-500 ml-2">step</span>
                            <input type="number" step="0.25" min="0.05" max="5" value={searchConfig.clusterTol.step}
                              onChange={(e) => {
                                const v = Math.max(0.05, Math.min(5, Number(e.target.value)));
                                setSearchConfig((c) => ({ ...c, clusterTol: { ...c.clusterTol, step: Number.isFinite(v) ? v : 0.5 } }));
                              }}
                              className="w-14 bg-[#0a0b0d] border border-white/[0.08] text-slate-200 font-mono rounded px-1.5 py-0.5 focus:outline-none focus:border-amber-500/50" />
                          </div>
                          {searchConfig.clusterTol.min > searchConfig.clusterTol.max && (
                            <div className="text-[10px] text-red-400/90">⚠ min &gt; max — range is empty.</div>
                          )}
                        </>
                      )}
                    </div>

                    {/* Min agreement */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] uppercase tracking-wider text-slate-400">Min agreement</label>
                        {consensusMode === 'scan' && (
                          <span className="text-[10px] font-mono text-slate-600">{searchPlan.minA} values · max {MAX_ALGOS_AVAILABLE}</span>
                        )}
                      </div>
                      {consensusMode === 'individual' ? (
                        <div className="flex items-center gap-2">
                          <input type="range" min={1} max={Math.max(1, selectedAlgos.size)} step={1}
                            value={Math.min(minAgreement, Math.max(1, selectedAlgos.size))}
                            onChange={(e) => setMinAgreement(Number(e.target.value))}
                            className="flex-1 accent-violet-500" />
                          <span className="text-[11px] font-mono text-cyan-300 w-20 text-right tabular-nums">
                            {minAgreement === 1 ? 'All' : `≥${minAgreement}/${selectedAlgos.size}`}
                          </span>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-1.5 text-[11px]">
                            <input type="number" step="1" min="1" max={MAX_ALGOS_AVAILABLE} value={searchConfig.minAgreement.min}
                              onChange={(e) => {
                                const raw = Math.round(Number(e.target.value));
                                const v = Number.isFinite(raw) ? Math.max(1, Math.min(MAX_ALGOS_AVAILABLE, raw)) : 1;
                                setSearchConfig((c) => ({ ...c, minAgreement: { ...c.minAgreement, min: v } }));
                              }}
                              className="w-14 bg-[#0a0b0d] border border-white/[0.08] text-slate-200 font-mono rounded px-1.5 py-0.5 focus:outline-none focus:border-amber-500/50" />
                            <span className="text-slate-500">→</span>
                            <input type="number" step="1" min="1" max={MAX_ALGOS_AVAILABLE} value={searchConfig.minAgreement.max}
                              onChange={(e) => {
                                const raw = Math.round(Number(e.target.value));
                                const v = Number.isFinite(raw) ? Math.max(1, Math.min(MAX_ALGOS_AVAILABLE, raw)) : 1;
                                setSearchConfig((c) => ({ ...c, minAgreement: { ...c.minAgreement, max: v } }));
                              }}
                              className="w-14 bg-[#0a0b0d] border border-white/[0.08] text-slate-200 font-mono rounded px-1.5 py-0.5 focus:outline-none focus:border-amber-500/50" />
                            <span className="text-[10px] text-slate-600 ml-2 italic">values above selected-algo count skipped</span>
                          </div>
                          {searchPlan.skipped > 0 && (
                            <div className="text-[10px] text-amber-400/80">
                              ⚠ {searchPlan.skipped.toLocaleString()} combos skipped — min-agreement exceeds selected algorithm count ({searchPlan.algoCount}).
                            </div>
                          )}
                        </>
                      )}
                    </div>

                    {/* Eval τ — Scan mode only */}
                    {consensusMode === 'scan' && (
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-400 cursor-pointer select-none">
                            <input type="checkbox" checked={searchConfig.evalTau.sweep}
                              onChange={(e) => setSearchConfig((c) => ({ ...c, evalTau: { ...c.evalTau, sweep: e.target.checked } }))}
                              className="accent-amber-500 w-3 h-3" />
                            Sweep eval τ (s)
                          </label>
                          <span className="text-[10px] font-mono text-slate-600">{searchPlan.eN} {searchPlan.eN === 1 ? 'value' : 'values'}</span>
                        </div>
                        <div className={`flex items-center gap-1.5 text-[11px] ${searchConfig.evalTau.sweep ? '' : 'opacity-40'}`}>
                          <input type="number" step="0.25" min="0.25" max="20" disabled={!searchConfig.evalTau.sweep} value={searchConfig.evalTau.min}
                            onChange={(e) => {
                              const v = Math.max(0.05, Math.min(20, Number(e.target.value)));
                              setSearchConfig((c) => ({ ...c, evalTau: { ...c.evalTau, min: Number.isFinite(v) ? v : 0.5 } }));
                            }}
                            className="w-14 bg-[#0a0b0d] border border-white/[0.08] text-slate-200 font-mono rounded px-1.5 py-0.5 focus:outline-none focus:border-amber-500/50 disabled:cursor-not-allowed" />
                          <span className="text-slate-500">→</span>
                          <input type="number" step="0.25" min="0.25" max="20" disabled={!searchConfig.evalTau.sweep} value={searchConfig.evalTau.max}
                            onChange={(e) => {
                              const v = Math.max(0.05, Math.min(20, Number(e.target.value)));
                              setSearchConfig((c) => ({ ...c, evalTau: { ...c.evalTau, max: Number.isFinite(v) ? v : 3 } }));
                            }}
                            className="w-14 bg-[#0a0b0d] border border-white/[0.08] text-slate-200 font-mono rounded px-1.5 py-0.5 focus:outline-none focus:border-amber-500/50 disabled:cursor-not-allowed" />
                          <span className="text-slate-500 ml-2">step</span>
                          <input type="number" step="0.25" min="0.05" max="5" disabled={!searchConfig.evalTau.sweep} value={searchConfig.evalTau.step}
                            onChange={(e) => {
                              const v = Math.max(0.05, Math.min(5, Number(e.target.value)));
                              setSearchConfig((c) => ({ ...c, evalTau: { ...c.evalTau, step: Number.isFinite(v) ? v : 0.5 } }));
                            }}
                            className="w-14 bg-[#0a0b0d] border border-white/[0.08] text-slate-200 font-mono rounded px-1.5 py-0.5 focus:outline-none focus:border-amber-500/50 disabled:cursor-not-allowed" />
                        </div>
                        {searchConfig.evalTau.sweep && searchConfig.evalTau.min > searchConfig.evalTau.max && (
                          <div className="text-[10px] text-red-400/90">⚠ min &gt; max — range is empty.</div>
                        )}
                        {!searchConfig.evalTau.sweep && (
                          <div className="text-[10px] font-mono text-slate-600">using current τ = {tolerance}s</div>
                        )}
                      </div>
                    )}

                    {/* Centroid: pick one (Individual) or multi (Scan) — chips share the same UI */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] uppercase tracking-wider text-slate-400">
                          Centroid{consensusMode === 'scan' ? 's' : ''}
                        </label>
                        {consensusMode === 'scan' && (
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-mono text-slate-600">{searchPlan.mN}/{ALL_CENTROID_METHODS.length}</span>
                            <button onClick={() => setSearchConfig((c) => ({ ...c, methods: new Set(ALL_CENTROID_METHODS) }))}
                              className="text-[10px] uppercase tracking-wider text-amber-400 hover:text-amber-200">all</button>
                            <button onClick={() => setSearchConfig((c) => ({ ...c, methods: new Set() }))}
                              className="text-[10px] uppercase tracking-wider text-slate-500 hover:text-slate-300">none</button>
                          </div>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {CENTROID_METHODS.map((m) => {
                          const on = consensusMode === 'individual'
                            ? centroidMethod === m.id
                            : searchConfig.methods.has(m.id);
                          return (
                            <button key={m.id}
                              onClick={() => {
                                if (consensusMode === 'individual') {
                                  setCentroidMethod(m.id);
                                } else {
                                  setSearchConfig((c) => {
                                    const next = new Set(c.methods);
                                    if (next.has(m.id)) next.delete(m.id); else next.add(m.id);
                                    return { ...c, methods: next };
                                  });
                                }
                              }}
                              onMouseEnter={() => setHoveredCentroidId(m.id)}
                              onMouseLeave={() => setHoveredCentroidId(null)}
                              title={m.tooltip}
                              className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                                on
                                  ? 'border-violet-500/60 bg-violet-900/30 text-violet-200'
                                  : 'border-white/[0.08] text-slate-500 hover:text-slate-300'
                              }`}
                            >
                              {m.short}
                            </button>
                          );
                        })}
                      </div>
                      {consensusMode === 'individual' && (() => {
                        const active = CENTROID_METHODS.find((m) => m.id === (hoveredCentroidId ?? centroidMethod));
                        if (!active) return null;
                        return (
                          <div className="text-[10px] text-slate-500 leading-snug">
                            <span className="text-violet-400 font-mono mr-1">{active.short}:</span>
                            {active.tooltip}
                          </div>
                        );
                      })()}
                    </div>

                    {/* Algorithms — shared across both modes */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between flex-wrap gap-1">
                        <label className="text-[10px] uppercase tracking-wider text-slate-400">Algorithms</label>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] font-mono text-slate-600">{selectedAlgos.size}/{ALGO_ORDER.length}</span>
                          <button onClick={() => setSelectedAlgos(new Set(ALGO_ORDER))}
                            className="text-[10px] uppercase tracking-wider text-violet-400 hover:text-violet-200">all</button>
                          <button onClick={() => setSelectedAlgos(new Set())}
                            className="text-[10px] uppercase tracking-wider text-slate-500 hover:text-slate-300">none</button>
                          <button onClick={() => setSelectedAlgos((prev) => new Set([...prev].filter((id) => !ALLIN1_FOLD_IDS.has(id))))}
                            title="Remove the 8 AllIn1 fold variants"
                            className="text-[10px] uppercase tracking-wider text-teal-400 hover:text-teal-200">no folds</button>
                          <button onClick={() => setSelectedAlgos((prev) => new Set([...prev].filter((id) => !RUPTURES_TOOL_ID_SET.has(id))))}
                            title="Remove all Ruptures CPD variants"
                            className="text-[10px] uppercase tracking-wider text-teal-400 hover:text-teal-200">no rpt</button>
                          <button onClick={() => setSelectedAlgos(new Set(RUPTURES_TOOL_IDS))}
                            title="Use only Ruptures CPD variants"
                            className="text-[10px] uppercase tracking-wider text-fuchsia-400 hover:text-fuchsia-200">rpt only</button>
                        </div>
                      </div>
                      <div className="border border-white/[0.06] rounded p-1 max-h-40 overflow-y-auto bg-black/30">
                        {ALGO_ORDER.map((id) => {
                          const meta = ALGO_META[id];
                          const checked = selectedAlgos.has(id);
                          return (
                            <label key={id} className="flex items-center gap-2 px-2 py-0.5 rounded cursor-pointer hover:bg-white/[0.04] text-[11px] transition-colors">
                              <input type="checkbox" checked={checked}
                                onChange={() => setSelectedAlgos((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(id)) next.delete(id); else next.add(id);
                                  return next;
                                })}
                                className="accent-violet-500 w-3 h-3" />
                              <span className={`font-mono ${checked ? 'text-slate-200' : 'text-slate-500'}`}>{meta?.label ?? id}</span>
                              <span className="text-slate-600 text-[10px] font-mono ml-auto">{meta?.group}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>

                    {/* Custom eval — always shown */}
                    <div className="pt-2 border-t border-white/[0.06] space-y-1.5">
                      <span className="text-[10px] uppercase tracking-wider text-amber-400">Custom eval</span>
                      <CustomEvalControls settings={customSettings} onChange={setCustomSettings} compact />
                    </div>

                    {/* Reload — always shown */}
                    <div className="pt-2 border-t border-white/[0.06]">
                      <button
                        onClick={() => {
                          setRawData([]);
                          setSongsLoaded(0);
                          setLoadState('loading');
                          setLoadKey((k) => k + 1);
                          setShowParamsPopover(false);
                        }}
                        className="text-[11px] px-2.5 py-1 rounded border border-gray-700 bg-gray-800 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
                        title="Re-fetch all per-song JSON and recompute aggregates"
                      >
                        ↻ Reload all songs
                      </button>
                    </div>

                    {/* Scan-mode footer: validation + combo count */}
                    {consensusMode === 'scan' && (
                      <>
                        {searchPlan.invalid && (
                          <div className="rounded border border-red-700/40 bg-red-950/30 p-2 text-[10px] text-red-300 space-y-0.5">
                            {searchPlan.issues.map((msg, i) => <div key={i}>⚠ {msg}</div>)}
                          </div>
                        )}
                        <div className="flex items-center justify-between pt-2 border-t border-white/[0.05] text-[10px]">
                          <span className="font-mono text-slate-500">
                            {searchPlan.tolN} × {searchPlan.minA} × {searchPlan.mN} × {searchPlan.eN}
                            {searchPlan.skipped > 0 && <span className="text-amber-500"> − {searchPlan.skipped.toLocaleString()} skipped</span>}
                          </span>
                          <span className={`font-mono ${searchPlan.invalid ? 'text-red-400' : 'text-amber-300'}`}>
                            = {searchPlan.effective.toLocaleString()} combos
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Single Run button — label adapts to mode */}
              <button
                onClick={consensusMode === 'individual' ? runOnceConsensus : runFindBestParams}
                disabled={
                  searching ||
                  rawData.length === 0 ||
                  selectedAlgos.size === 0 ||
                  (consensusMode === 'scan' && searchPlan.invalid)
                }
                className={`text-[11px] px-3 py-1 rounded border disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${
                  consensusMode === 'scan'
                    ? 'border-amber-600/60 bg-amber-900/30 text-amber-300 hover:bg-amber-800/40'
                    : 'border-violet-600/60 bg-violet-900/30 text-violet-300 hover:bg-violet-800/40'
                }`}
                title={consensusMode === 'individual'
                  ? 'Score the current Individual settings (cluster τ, min-agreement, centroid, selected algorithms) once.'
                  : (searchPlan.invalid
                      ? `Scan settings invalid: ${searchPlan.issues.join(' · ')}`
                      : 'Brute-force every combination in the configured ranges to find the highest-F1 settings.')}
              >
                {searching
                  ? `🔍 Searching… ${searchProgress}/${searchTotal}`
                  : consensusMode === 'individual'
                    ? '▶ Run once'
                    : '🔍 Find best parameters'}
              </button>

              {searching && (
                <button
                  onClick={() => { searchCancelRef.current = true; }}
                  className="text-[10px] px-2 py-1 rounded border border-gray-700 bg-gray-800 text-gray-400 hover:text-gray-200"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>

          {showConsensusHelp && (
            <div className="rounded border border-violet-700/40 bg-violet-950/40 p-3 text-[11px] text-gray-300 space-y-2">
              <div>
                <span className="text-violet-300 font-semibold">What this does:</span> every selected algorithm
                outputs section boundaries (in seconds). We pool all those timestamps across algorithms,
                merge nearby ones into clusters, and keep only the clusters that enough <em>different</em> algorithms
                voted for. Each surviving cluster becomes one consensus boundary at a single moment in time.
                Then we score those consensus boundaries against the manual reference (precision/recall/F1)
                with the standard tolerance τ.
              </div>
              <ul className="space-y-1 list-disc pl-5 text-gray-400">
                <li>
                  <strong className="text-violet-300">Cluster τ</strong> — how close two algorithm boundaries must be (in seconds)
                  to be merged into the same cluster. Smaller = stricter agreement; larger = more boundaries collapse together.
                </li>
                <li>
                  <strong className="text-violet-300">Min agreement</strong> — how many <em>distinct</em> algorithms must contribute
                  to a cluster for it to count. Higher = fewer but more confident boundaries.
                </li>
                <li>
                  <strong className="text-violet-300">Centroid</strong> — once a cluster passes, which timestamp do we report?
                  (mean, median-style, etc.)
                </li>
                <li>
                  <strong className="text-violet-300">Algorithms</strong> — which algorithms are eligible to vote.
                </li>
                <li>
                  <strong className="text-violet-300">Find best parameters</strong> — brute-force search across all of the above
                  to maximize dataset-wide F1.
                </li>
              </ul>
            </div>
          )}

          {searching && liveBest && (
            <div className="flex items-center gap-2 text-[10px] text-amber-300/80 bg-amber-950/20 border border-amber-800/30 rounded px-2 py-1">
              <span className="font-mono">Best so far:</span>
              <span className={`font-mono font-bold ${metricColor(liveBest.f1)}`}>{pct(liveBest.f1)}</span>
              <span className="text-gray-500">·</span>
              <span className="text-gray-400">{liveBest.algoIds.length} algos</span>
              <span className="text-gray-500">·</span>
              <span className="font-mono">cluster {liveBest.clusterTol}s</span>
              <span className="text-gray-500">·</span>
              <span className="font-mono">≥{liveBest.minAgreement}</span>
              <span className="text-gray-500">·</span>
              <span className="font-mono text-violet-400">{liveBest.method}</span>
              {searchConfig.evalTau.sweep && (<>
                <span className="text-gray-500">·</span>
                <span className="font-mono">eval τ {liveBest.tolEval}s</span>
              </>)}
            </div>
          )}

          {/* Best parameters found — appears after a scan completes; lets the
              user copy the winning combo into their Individual settings. */}
          {!searching && bestParamsRows && bestParamsRows.length > 0 && (() => {
            const top = bestParamsRows[0];
            const centroidShort = CENTROID_METHODS.find((m) => m.id === top.method)?.short ?? top.method;
            const alreadyApplied =
              top.clusterTol === clusterTol &&
              top.minAgreement === minAgreement &&
              top.method === centroidMethod &&
              top.algoIds.length === selectedAlgos.size &&
              top.algoIds.every((id) => selectedAlgos.has(id));
            return (
              <div className="rounded border border-emerald-700/40 bg-emerald-950/20 p-3 space-y-2">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-300">
                      ⚡ Best parameters found
                    </span>
                    <span className="text-[10px] text-emerald-400/70 italic">
                      from {bestParamsRows.length.toLocaleString()} combos tested
                    </span>
                  </div>
                  <button
                    onClick={() => applyBestParams(top)}
                    disabled={alreadyApplied}
                    className="text-[11px] px-3 py-1 rounded border border-emerald-500/60 bg-emerald-700/40 text-emerald-100 hover:bg-emerald-600/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    title={alreadyApplied
                      ? 'These values already match your Individual settings.'
                      : 'Copy these values into your Individual settings (overwrites cluster τ, min-agreement, centroid, eval τ, and selected algorithms). Switches mode to Individual.'}
                  >
                    {alreadyApplied ? '✓ Already applied' : '⤓ Save as current settings'}
                  </button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 text-[10px]">
                  <div className="bg-black/30 rounded px-2 py-1 border border-white/[0.04]">
                    <div className="text-slate-500 uppercase tracking-wider text-[9px]">F1</div>
                    <div className={`font-mono font-bold ${metricColor(top.f1)}`}>{pct(top.f1)}</div>
                  </div>
                  <div className="bg-black/30 rounded px-2 py-1 border border-white/[0.04]">
                    <div className="text-slate-500 uppercase tracking-wider text-[9px]">Cluster τ</div>
                    <div className="font-mono text-slate-200">{top.clusterTol}s</div>
                  </div>
                  <div className="bg-black/30 rounded px-2 py-1 border border-white/[0.04]">
                    <div className="text-slate-500 uppercase tracking-wider text-[9px]">Min agree</div>
                    <div className="font-mono text-slate-200">≥{top.minAgreement}</div>
                  </div>
                  <div className="bg-black/30 rounded px-2 py-1 border border-white/[0.04]">
                    <div className="text-slate-500 uppercase tracking-wider text-[9px]">Centroid</div>
                    <div className="font-mono text-violet-300">{centroidShort}</div>
                  </div>
                  <div className="bg-black/30 rounded px-2 py-1 border border-white/[0.04]">
                    <div className="text-slate-500 uppercase tracking-wider text-[9px]">Algos · Eval τ</div>
                    <div className="font-mono text-slate-200">{top.algoIds.length} · {top.tolEval}s</div>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* ── Consensus aggregate result ──────────────────────────────────── */}
      {evalMode === 'consensus' && rawData.length > 0 && (() => {
        const refSongCount = rawData.filter((s) => s.manualTimes.length > 0).length;
        const songsWithBoundaries = consensusPerSong.filter((s) => s.consensusTimes.length > 0).length;
        const noConsensusReason = !consensusAggregate
          ? (refSongCount === 0
              ? `No songs have a ${evalRef} annotation to evaluate against — switch the "vs" toggle, or annotate some songs first.`
              : songsWithBoundaries === 0
                ? `All clusters were rejected: no moment in any song had ≥${minAgreement} algorithms agreeing within ${clusterTol}s. Try lowering Min agreement or widening Cluster τ.`
                : `Songs produced consensus boundaries but none also had a ${evalRef} reference — try the other "vs" toggle.`)
          : null;
        return (
        <div className="rounded-lg border border-gray-800 overflow-hidden">
          <div className="bg-gray-900/60 p-4 flex items-stretch gap-4 flex-wrap">
            {/* mir_eval strip */}
            <div className="rounded border border-indigo-800/40 bg-indigo-950/20 px-3 py-2 flex items-center gap-5 flex-wrap">
              <div className="text-[10px] uppercase tracking-widest text-indigo-400 self-start">mir_eval</div>
              <div title="F1 = harmonic mean of precision and recall, averaged across all songs that have both consensus boundaries and a reference annotation.">
                <div className="text-[10px] uppercase tracking-wide text-gray-500">F1</div>
                <div className={`text-3xl font-mono font-bold ${consensusAggregate ? metricColor(consensusAggregate.f1) : 'text-gray-700'}`}>
                  {consensusAggregate ? pct(consensusAggregate.f1) : '—'}
                </div>
              </div>
              <div title="Mean precision: of the consensus boundaries we predicted, what fraction matched a reference boundary within ±τ. Higher = fewer false alarms.">
                <div className="text-[10px] uppercase tracking-wide text-gray-500">P</div>
                <div className={`text-xl font-mono ${consensusAggregate ? metricColor(consensusAggregate.precision) : 'text-gray-700'}`}>
                  {consensusAggregate ? pct(consensusAggregate.precision) : '—'}
                </div>
              </div>
              <div title="Mean recall: of the reference boundaries that exist, what fraction did the consensus actually find within ±τ. Higher = fewer misses.">
                <div className="text-[10px] uppercase tracking-wide text-gray-500">R</div>
                <div className={`text-xl font-mono ${consensusAggregate ? metricColor(consensusAggregate.recall) : 'text-gray-700'}`}>
                  {consensusAggregate ? pct(consensusAggregate.recall) : '—'}
                </div>
              </div>
            </div>

            {/* custom strip */}
            <div className="rounded border border-amber-800/40 bg-amber-950/20 px-3 py-2 flex items-center gap-5 flex-wrap">
              <div className="text-[10px] uppercase tracking-widest text-amber-400 self-start" title={`Optional weight = ${customSettings.optionalWeight.toFixed(2)} · ${customSettings.useSecondary ? 'candidates ON' : 'candidates OFF'}`}>custom</div>
              <div title="Custom evaluator F1 — uses optional-weight and (optionally) candidate alternates.">
                <div className="text-[10px] uppercase tracking-wide text-gray-500">F1</div>
                <div className={`text-3xl font-mono font-bold ${consensusAggregate ? metricColor(consensusAggregate.cF1) : 'text-gray-700'}`}>
                  {consensusAggregate ? pct(consensusAggregate.cF1) : '—'}
                </div>
              </div>
              <div title="Weighted precision under the custom evaluator.">
                <div className="text-[10px] uppercase tracking-wide text-gray-500">P</div>
                <div className={`text-xl font-mono ${consensusAggregate ? metricColor(consensusAggregate.cPrecision) : 'text-gray-700'}`}>
                  {consensusAggregate ? pct(consensusAggregate.cPrecision) : '—'}
                </div>
              </div>
              <div title="Weighted recall under the custom evaluator. Optional manual sections contribute fractionally.">
                <div className="text-[10px] uppercase tracking-wide text-gray-500">R</div>
                <div className={`text-xl font-mono ${consensusAggregate ? metricColor(consensusAggregate.cRecall) : 'text-gray-700'}`}>
                  {consensusAggregate ? pct(consensusAggregate.cRecall) : '—'}
                </div>
              </div>
              <div title="Mean Nearest-Boundary Distance (s) — average distance from each predicted boundary to its nearest manual. Lower is better.">
                <div className="text-[10px] uppercase tracking-wide text-gray-500">MNBD</div>
                <div className={`text-xl font-mono ${consensusAggregate ? mnbdColor(consensusAggregate.mnbd) : 'text-gray-700'}`}>
                  {consensusAggregate ? `${consensusAggregate.mnbd.toFixed(2)}s` : '—'}
                </div>
              </div>
              <div title="Critical Section Recall — fraction of critical (★) manual sections hit. Computed only over songs that have at least one critical manual.">
                <div className="text-[10px] uppercase tracking-wide text-gray-500">CSR</div>
                <div className={`text-xl font-mono ${consensusAggregate ? metricColor(consensusAggregate.csr) : 'text-gray-700'}`}>
                  {consensusAggregate ? pct(consensusAggregate.csr) : '—'}
                </div>
              </div>
            </div>

            <div className="h-auto w-px bg-gray-800" />
            <div title="The lowest and highest per-song mir_eval F1 in the dataset — shows how consistent the consensus is across songs.">
              <div className="text-[10px] uppercase tracking-wide text-gray-500">Worst → Best F1</div>
              <div className="text-sm font-mono text-gray-400">
                {consensusAggregate
                  ? <><span className={metricColor(consensusAggregate.minF1)}>{pct(consensusAggregate.minF1)}</span> → <span className={metricColor(consensusAggregate.maxF1)}>{pct(consensusAggregate.maxF1)}</span></>
                  : '—'}
              </div>
            </div>
            <div title="Average number of consensus boundaries kept per song under the current Cluster τ / Min agreement settings.">
              <div className="text-[10px] uppercase tracking-wide text-gray-500">Avg boundaries / song</div>
              <div className="text-sm font-mono text-gray-300">
                {consensusAggregate ? consensusAggregate.meanBoundaries.toFixed(1) : '—'}
              </div>
            </div>
            <div title={`Songs counted in the average: only songs that produced ≥1 consensus boundary AND have a ${evalRef} reference annotation. Total in dataset: ${totalSongs}.`}>
              <div className="text-[10px] uppercase tracking-wide text-gray-500">Songs scored</div>
              <div className="text-sm font-mono text-gray-300">
                {consensusAggregate ? `${consensusAggregate.songCount}/${totalSongs}` : `0/${totalSongs}`}
              </div>
            </div>
            <div className="h-auto w-px bg-gray-800" />
            <div title="The active parameters that produced this score. Change them via the ⚙ Settings popover, or use ⚡ Apply best from the Best parameters table.">
              <div className="text-[10px] uppercase tracking-wide text-gray-500">Params</div>
              <div className="text-[11px] font-mono text-gray-300 flex flex-wrap gap-x-2 gap-y-0.5">
                <span title="Cluster window: max gap (s) to merge two algo boundaries into one cluster"><span className="text-gray-500">clust</span> {clusterTol}s</span>
                <span title="Minimum number of distinct algorithms that must vote in a cluster"><span className="text-gray-500">min</span> ≥{minAgreement}</span>
                <span className="text-violet-400" title="Centroid method: which timestamp is reported for each surviving cluster">{centroidMethod}</span>
                <span title="Evaluation tolerance: max distance (s) for a predicted boundary to count as a match"><span className="text-gray-500">τ</span> {tolerance}s</span>
                <span title={`Active algorithms: ${[...selectedAlgos].join(', ')}`}><span className="text-gray-500">algos</span> {selectedAlgos.size}/{ALGO_ORDER.length}</span>
                <span title="Custom evaluator: weight given to optional manual sections (0 = ignore, 1 = same as required)"><span className="text-amber-500/70">opt</span> {customSettings.optionalWeight.toFixed(2)}</span>
                <span className={customSettings.useSecondary ? 'text-amber-400/80' : 'text-gray-600'} title="Both evaluators: whether secondary/candidate boundaries on a manual section count as valid matches">
                  {customSettings.useSecondary ? 'cand✓' : 'cand✗'}
                </span>
              </div>
            </div>
            <div className="ml-auto flex items-center gap-2 self-center">
              <button
                onClick={exportConsensusCSV}
                disabled={consensusPerSong.length === 0}
                title="Download the per-song auto-consensus table as CSV in the current sort order"
                className="text-[11px] px-2.5 py-1 rounded border border-gray-700 bg-gray-800 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ⬇ CSV
              </button>
              <button
                onClick={() => setExpandConsensusSongs((v) => !v)}
                className="text-[11px] px-2.5 py-1 rounded border border-gray-700 bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
              >
                {expandConsensusSongs ? '▲ Hide per-song' : '▼ Show per-song breakdown'}
              </button>
            </div>
          </div>
          {noConsensusReason && (
            <div className="px-4 py-2 border-t border-gray-800 bg-amber-950/20 text-[11px] text-amber-300/90">
              <span className="font-semibold">No score yet:</span> {noConsensusReason}
            </div>
          )}

          {expandConsensusSongs && (
            <div className="border-t border-gray-800">
              <div className="px-3 py-1.5 bg-gray-900/40 flex items-center gap-2 text-[10px] text-gray-600">
                <span>Sort by</span>
                {(['f1', 'precision', 'recall', 'name'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setConsensusSongSort(s)}
                    className={`px-1.5 py-0.5 rounded ${consensusSongSort === s ? 'bg-indigo-700/60 text-indigo-200' : 'text-gray-500 hover:text-gray-300'}`}
                  >
                    {s === 'f1' ? 'F1' : s === 'precision' ? 'P' : s === 'recall' ? 'R' : 'Name'}
                  </button>
                ))}
              </div>
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="bg-gray-900 text-[9px] uppercase tracking-widest">
                    <th className="px-3 py-1 text-left text-gray-700 border-r border-gray-800/60">&nbsp;</th>
                    <th colSpan={4} className="px-2 py-1 text-center text-indigo-400 border-r border-gray-800/60">mir_eval{mirLoading && (<span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-indigo-400 animate-pulse" title="updating…" />)}</th>
                    <th colSpan={5} className="px-2 py-1 text-center text-amber-400 border-r border-gray-800/60">custom</th>
                    <th className="px-2 py-1" />
                  </tr>
                  <tr className="bg-gray-900 text-gray-600 text-[9px] uppercase tracking-wide">
                    <th className="px-3 py-1.5 text-left font-medium">Song</th>
                    <th className="px-2 py-1.5 text-center font-medium">P</th>
                    <th className="px-2 py-1.5 text-center font-medium">R</th>
                    <th className="px-2 py-1.5 text-center font-medium">F1</th>
                    <th className="px-2 py-1.5 text-center font-medium border-r border-gray-800/60">Hits/Ref</th>
                    <th className="px-2 py-1.5 text-center font-medium">P</th>
                    <th className="px-2 py-1.5 text-center font-medium">R</th>
                    <th className="px-2 py-1.5 text-center font-medium">F1</th>
                    <th className="px-2 py-1.5 text-center font-medium">MNBD</th>
                    <th className="px-2 py-1.5 text-center font-medium border-r border-gray-800/60">CSR</th>
                    <th className="px-2 py-1.5 text-center font-medium">Bnds</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/40">
                  {sortedConsensusSongs.map((sr) => (
                    <tr key={sr.songId} className={`hover:bg-gray-800/30 transition-colors ${sr.result === null ? 'opacity-40' : ''}`}>
                      <td className="px-3 py-1.5 text-gray-400 max-w-xs truncate">{sr.songName}</td>
                      {sr.result ? (
                        <>
                          <td className={`px-2 py-1.5 text-center font-mono ${metricColor(sr.result.precision)}`}>{pct(sr.result.precision)}</td>
                          <td className={`px-2 py-1.5 text-center font-mono ${metricColor(sr.result.recall)}`}>{pct(sr.result.recall)}</td>
                          <td className={`px-2 py-1.5 text-center font-mono font-semibold ${metricColor(sr.result.fmeasure)}`}>{pct(sr.result.fmeasure)}</td>
                          <td className="px-2 py-1.5 text-center font-mono text-gray-500 border-r border-gray-800/60">{sr.result.hitCount}/{sr.result.refCount}</td>
                          {sr.custom ? (
                            <>
                              <td className={`px-2 py-1.5 text-center font-mono ${metricColor(sr.custom.precision)}`}>{pct(sr.custom.precision)}</td>
                              <td className={`px-2 py-1.5 text-center font-mono ${metricColor(sr.custom.recall)}`}>{pct(sr.custom.recall)}</td>
                              <td className={`px-2 py-1.5 text-center font-mono font-semibold ${metricColor(sr.custom.f1)}`}>{pct(sr.custom.f1)}</td>
                              <td className={`px-2 py-1.5 text-center font-mono ${mnbdColor(sr.custom.mnbd)}`}>{sr.custom.mnbd.toFixed(2)}s</td>
                              <td className={`px-2 py-1.5 text-center font-mono border-r border-gray-800/60 ${sr.custom.criticalCount > 0 ? metricColor(sr.custom.csr) : 'text-gray-700'}`}>
                                {sr.custom.criticalCount > 0 ? pct(sr.custom.csr) : '—'}
                              </td>
                            </>
                          ) : (
                            <td colSpan={5} className="px-2 py-1.5 text-center text-gray-700 border-r border-gray-800/60">—</td>
                          )}
                        </>
                      ) : (
                        <td colSpan={9} className="px-3 py-1.5 text-center text-gray-700 text-[10px] border-r border-gray-800/60">
                          {sr.refCount === 0 ? 'no ref annotation' : 'no consensus boundaries (try widening τ or lowering min-agreement)'}
                        </td>
                      )}
                      <td className="px-2 py-1.5 text-center font-mono text-gray-500">{sr.consensusTimes.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        );
      })()}

      {/* ── Best parameters results table ────────────────────────────────── */}
      {evalMode === 'consensus' && bestParamsRows && bestParamsRows.length > 0 && (
        <div className="rounded-lg border border-amber-800/40 bg-amber-950/10 overflow-hidden">
          <div className="px-3 py-2 bg-amber-950/30 border-b border-amber-800/40 flex items-center gap-3 flex-wrap">
            <span className="text-[11px] font-semibold text-amber-300 uppercase tracking-wide">
              Best parameters · {bestParamsRows.length} combinations tested
            </span>
            <span className="text-[10px] text-amber-300/70">
              Top result: <span className="font-mono">F1 = {pct(bestParamsRows[0].f1)}</span>
            </span>
            <div className="ml-auto flex items-center gap-2 text-[10px] text-gray-500">
              <span>Show top</span>
              {[10, 20, 50, 100, bestParamsRows.length].map((n) => (
                <button
                  key={n}
                  onClick={() => setBestParamsTopN(n)}
                  className={`px-1.5 py-0.5 rounded ${bestParamsTopN === n ? 'bg-amber-700/60 text-amber-200' : 'text-gray-500 hover:text-gray-300'}`}
                >
                  {n === bestParamsRows.length ? 'all' : n}
                </button>
              ))}
              <button
                onClick={() => setBestParamsRows(null)}
                className="ml-2 text-gray-500 hover:text-gray-300"
              >✕</button>
            </div>
          </div>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="bg-gray-900 text-gray-600 text-[9px] uppercase tracking-wide">
                <th className="px-2 py-1.5 text-center font-medium" title="Rank in the current sort order (1 = top)">#</th>
                <th
                  className="px-2 py-1.5 text-left font-medium cursor-pointer select-none hover:text-gray-300"
                  title="How many algorithms voted in this combination (hover a cell for the full list). ▶ marks rows added via Run-once."
                  onClick={() => handleBestParamsSortClick('algoCount')}
                >Algos<BestParamsSortArrow col="algoCount" /></th>
                <th
                  className="px-2 py-1.5 text-center font-medium cursor-pointer select-none hover:text-gray-300"
                  title="Cluster window: max gap (s) between two algo boundaries to merge into one cluster"
                  onClick={() => handleBestParamsSortClick('clusterTol')}
                >Cluster τ<BestParamsSortArrow col="clusterTol" /></th>
                <th
                  className="px-2 py-1.5 text-center font-medium cursor-pointer select-none hover:text-gray-300"
                  title="Minimum number of distinct algorithms that must vote in a cluster for it to count"
                  onClick={() => handleBestParamsSortClick('minAgreement')}
                >Min agree<BestParamsSortArrow col="minAgreement" /></th>
                <th
                  className="px-2 py-1.5 text-center font-medium cursor-pointer select-none hover:text-gray-300"
                  title="Centroid method: which timestamp is reported for each surviving cluster"
                  onClick={() => handleBestParamsSortClick('method')}
                >Method<BestParamsSortArrow col="method" /></th>
                <th
                  className="px-2 py-1.5 text-center font-medium cursor-pointer select-none hover:text-gray-300"
                  title="Evaluation tolerance: max distance (s) for a predicted boundary to count as a match against the reference"
                  onClick={() => handleBestParamsSortClick('tolEval')}
                >Eval τ<BestParamsSortArrow col="tolEval" /></th>
                <th
                  className="px-2 py-1.5 text-center font-medium cursor-pointer select-none hover:text-gray-300"
                  title="Mean precision across scored songs"
                  onClick={() => handleBestParamsSortClick('precision')}
                >P<BestParamsSortArrow col="precision" /></th>
                <th
                  className="px-2 py-1.5 text-center font-medium cursor-pointer select-none hover:text-gray-300"
                  title="Mean recall across scored songs"
                  onClick={() => handleBestParamsSortClick('recall')}
                >R<BestParamsSortArrow col="recall" /></th>
                <th
                  className="px-2 py-1.5 text-center font-medium cursor-pointer select-none hover:text-gray-300"
                  title="Mean F1 across scored songs"
                  onClick={() => handleBestParamsSortClick('f1')}
                >F1<BestParamsSortArrow col="f1" /></th>
                <th
                  className="px-2 py-1.5 text-center font-medium cursor-pointer select-none hover:text-gray-300"
                  title="How many songs had both consensus boundaries and a reference annotation under these settings"
                  onClick={() => handleBestParamsSortClick('songCount')}
                >Songs<BestParamsSortArrow col="songCount" /></th>
                <th
                  className="px-2 py-1.5 text-center font-medium cursor-pointer select-none hover:text-gray-300"
                  title="Average number of consensus boundaries kept per song"
                  onClick={() => handleBestParamsSortClick('meanBoundaries')}
                >⌀ bnds<BestParamsSortArrow col="meanBoundaries" /></th>
                <th className="px-2 py-1.5 text-center font-medium" title="Load these settings into the sliders above">Apply</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/40">
              {(sortedBestParamsRows ?? bestParamsRows).slice(0, bestParamsTopN).map((row, i) => {
                const isCurrent =
                  row.clusterTol === clusterTol &&
                  row.minAgreement === minAgreement &&
                  row.method === centroidMethod &&
                  row.tolEval === tolerance &&
                  row.algoIds.length === selectedAlgos.size &&
                  row.algoIds.every((id) => selectedAlgos.has(id));
                return (
                  <tr key={i} className={`transition-colors ${isCurrent ? 'bg-violet-900/20' : 'hover:bg-gray-800/30'}`}>
                    <td className="px-2 py-1.5 text-center font-mono text-gray-600">{i + 1}</td>
                    <td className="px-2 py-1.5 text-gray-400 truncate max-w-[160px]" title={row.algoIds.join(', ')}>
                      {row.source === 'once' && <span className="text-violet-400 mr-1" title="Added via Run-once">▶</span>}
                      <span className="font-mono">{row.algoIds.length}</span>
                      <span className="text-gray-600">/{ALGO_ORDER.length}</span>
                    </td>
                    <td className="px-2 py-1.5 text-center font-mono text-gray-400">{row.clusterTol}s</td>
                    <td className="px-2 py-1.5 text-center font-mono text-gray-400">≥{row.minAgreement}</td>
                    <td className="px-2 py-1.5 text-center font-mono text-violet-400">{row.method}</td>
                    <td className={`px-2 py-1.5 text-center font-mono ${row.tolEval === tolerance ? 'text-gray-400' : 'text-amber-400'}`} title={row.tolEval === tolerance ? 'Same as current eval τ' : `Different from current eval τ (${tolerance}s) — Apply will switch it`}>{row.tolEval}s</td>
                    <td className={`px-2 py-1.5 text-center font-mono ${metricColor(row.precision)}`}>{pct(row.precision)}</td>
                    <td className={`px-2 py-1.5 text-center font-mono ${metricColor(row.recall)}`}>{pct(row.recall)}</td>
                    <td className={`px-2 py-1.5 text-center font-mono font-semibold ${metricColor(row.f1)}`}>{pct(row.f1)}</td>
                    <td className="px-2 py-1.5 text-center font-mono text-gray-500">{row.songCount}</td>
                    <td className="px-2 py-1.5 text-center font-mono text-gray-500">{row.meanBoundaries.toFixed(1)}</td>
                    <td className="px-2 py-1.5 text-center">
                      <button
                        onClick={() => applyBestParams(row)}
                        disabled={isCurrent}
                        className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
                          isCurrent
                            ? 'bg-violet-800/60 text-violet-300 cursor-default'
                            : 'bg-amber-700/60 text-amber-200 hover:bg-amber-600/80'
                        }`}
                      >
                        {isCurrent ? '✓ active' : 'Apply'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Aggregate table ──────────────────────────────────────────────── */}
      {evalMode === 'per-algo' && rawData.length > 0 && (
        <div className="rounded-lg border border-gray-800 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-900 text-[9px] uppercase tracking-widest">
                <th colSpan={2} className="px-3 py-1 text-left text-gray-700 border-r border-gray-800/60">&nbsp;</th>
                <th colSpan={5} className="px-2 py-1 text-center text-indigo-400 border-r border-gray-800/60">mir_eval{mirLoading && (<span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-indigo-400 animate-pulse" title="updating…" />)}</th>
                <th colSpan={5} className="px-2 py-1 text-center text-amber-400 border-r border-gray-800/60">custom</th>
                <th className="px-2 py-1" />
              </tr>
              <tr className="bg-gray-900 text-gray-500 text-[10px] uppercase tracking-wide">
                <th
                  className="px-3 py-2 text-left font-medium cursor-pointer select-none hover:text-gray-300"
                  onClick={() => handleSortClick('algo')}
                >
                  Algorithm<SortArrow col="algo" />
                </th>
                <th
                  className="px-2 py-2 text-center font-medium cursor-pointer select-none hover:text-gray-300 border-r border-gray-800/60"
                  onClick={() => handleSortClick('songs')}
                >
                  Songs<SortArrow col="songs" />
                </th>
                <th
                  className="px-2 py-2 text-center font-medium cursor-pointer select-none hover:text-gray-300"
                  onClick={() => handleSortClick('precision')}
                >
                  P<SortArrow col="precision" />
                </th>
                <th
                  className="px-2 py-2 text-center font-medium cursor-pointer select-none hover:text-gray-300"
                  onClick={() => handleSortClick('recall')}
                >
                  R<SortArrow col="recall" />
                </th>
                <th
                  className="px-2 py-2 text-center font-medium cursor-pointer select-none hover:text-gray-300"
                  onClick={() => handleSortClick('f1')}
                >
                  F1<SortArrow col="f1" />
                </th>
                <th
                  className="px-2 py-2 text-center font-medium cursor-pointer select-none hover:text-gray-300"
                  onClick={() => handleSortClick('minF1')}
                >
                  Worst<SortArrow col="minF1" />
                </th>
                <th
                  className="px-2 py-2 text-center font-medium cursor-pointer select-none hover:text-gray-300 border-r border-gray-800/60"
                  onClick={() => handleSortClick('maxF1')}
                >
                  Best<SortArrow col="maxF1" />
                </th>
                <th
                  className="px-2 py-2 text-center font-medium cursor-pointer select-none hover:text-gray-300"
                  onClick={() => handleSortClick('cPrecision')}
                >
                  P<SortArrow col="cPrecision" />
                </th>
                <th
                  className="px-2 py-2 text-center font-medium cursor-pointer select-none hover:text-gray-300"
                  onClick={() => handleSortClick('cRecall')}
                >
                  R<SortArrow col="cRecall" />
                </th>
                <th
                  className="px-2 py-2 text-center font-medium cursor-pointer select-none hover:text-gray-300"
                  onClick={() => handleSortClick('cF1')}
                >
                  F1<SortArrow col="cF1" />
                </th>
                <th
                  className="px-2 py-2 text-center font-medium cursor-pointer select-none hover:text-gray-300"
                  onClick={() => handleSortClick('mnbd')}
                  title="Mean Nearest-Boundary Distance — lower is better"
                >
                  MNBD<SortArrow col="mnbd" />
                </th>
                <th
                  className="px-2 py-2 text-center font-medium cursor-pointer select-none hover:text-gray-300 border-r border-gray-800/60"
                  onClick={() => handleSortClick('csr')}
                  title="Critical Section Recall — fraction of critical (★) manual sections hit"
                >
                  CSR<SortArrow col="csr" />
                </th>
                <th className="px-2 py-2 w-5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/60">
              {tableRows.map((row, i) => {
                if (row.type === 'group') {
                  return (
                    <tr key={`g-${row.group}-${i}`}>
                      <td
                        colSpan={13}
                        className="px-3 py-1.5 bg-gray-900/80 text-[10px] font-semibold uppercase tracking-widest text-gray-600 border-t border-gray-800"
                      >
                        {row.group}
                      </td>
                    </tr>
                  );
                }

                const algo = row.algo;
                const isExpanded = expandedAlgo === algo.toolId;
                const hasData = algo.songCount > 0;
                const badgeCls = GROUP_BADGE[algo.group] ?? GROUP_BADGE.Other;

                return (
                  <Fragment key={algo.toolId}>
                    <tr
                      onClick={() => hasData && setExpandedAlgo(isExpanded ? null : algo.toolId)}
                      className={`transition-colors ${
                        hasData ? 'cursor-pointer hover:bg-gray-800/40' : 'opacity-40'
                      } ${isExpanded ? 'bg-gray-800/30' : 'bg-gray-900/20'}`}
                    >
                      <td className="px-3 py-2 font-medium text-gray-300">
                        <div className="flex items-center gap-1.5">
                          <span className={`text-[9px] px-1.5 py-0.5 rounded leading-none font-medium border ${badgeCls}`}>
                            {algo.group}
                          </span>
                          {algo.label}
                        </div>
                      </td>
                      <td className="px-2 py-2 text-center font-mono text-gray-500 text-[11px] border-r border-gray-800/60">
                        {algo.songCount}/{totalSongs}
                      </td>
                      {hasData ? (
                        <>
                          <td className={`px-2 py-2 text-center font-mono font-semibold ${metricColor(algo.precision)} ${metricBg(algo.precision)} rounded`}>
                            {pct(algo.precision)}
                          </td>
                          <td className={`px-2 py-2 text-center font-mono font-semibold ${metricColor(algo.recall)} ${metricBg(algo.recall)} rounded`}>
                            {pct(algo.recall)}
                          </td>
                          <td className={`px-2 py-2 text-center font-mono font-semibold ${metricColor(algo.f1)} ${metricBg(algo.f1)} rounded`}>
                            {pct(algo.f1)}
                          </td>
                          <td className={`px-2 py-2 text-center font-mono text-[11px] ${metricColor(algo.minF1)}`}>
                            {pct(algo.minF1)}
                          </td>
                          <td className={`px-2 py-2 text-center font-mono text-[11px] border-r border-gray-800/60 ${metricColor(algo.maxF1)}`}>
                            {pct(algo.maxF1)}
                          </td>
                          <td className={`px-2 py-2 text-center font-mono font-semibold ${metricColor(algo.cPrecision)} ${metricBg(algo.cPrecision)} rounded`}>
                            {pct(algo.cPrecision)}
                          </td>
                          <td className={`px-2 py-2 text-center font-mono font-semibold ${metricColor(algo.cRecall)} ${metricBg(algo.cRecall)} rounded`}>
                            {pct(algo.cRecall)}
                          </td>
                          <td className={`px-2 py-2 text-center font-mono font-semibold ${metricColor(algo.cF1)} ${metricBg(algo.cF1)} rounded`}>
                            {pct(algo.cF1)}
                          </td>
                          <td className={`px-2 py-2 text-center font-mono text-[11px] ${mnbdColor(algo.mnbd)}`}>
                            {algo.mnbd.toFixed(2)}s
                          </td>
                          <td className={`px-2 py-2 text-center font-mono text-[11px] border-r border-gray-800/60 ${metricColor(algo.csr)}`}>
                            {pct(algo.csr)}
                          </td>
                        </>
                      ) : (
                        <td colSpan={10} className="px-3 py-2 text-center text-gray-700 text-[10px] border-r border-gray-800/60">
                          no data
                        </td>
                      )}
                      <td className="px-2 py-2 text-center text-gray-600 text-[10px]">
                        {hasData && (isExpanded ? '▲' : '▼')}
                      </td>
                    </tr>

                    {isExpanded && (
                      <tr>
                        <td colSpan={13} className="bg-gray-950/60 px-4 py-3">
                          <div className="rounded border border-gray-800 overflow-hidden">
                            <table className="w-full text-[11px]">
                              <thead>
                                <tr className="bg-gray-900 text-[9px] uppercase tracking-widest">
                                  <th className="px-3 py-1 text-left text-gray-700 border-r border-gray-800/60">&nbsp;</th>
                                  <th colSpan={4} className="px-2 py-1 text-center text-indigo-400 border-r border-gray-800/60">mir_eval{mirLoading && (<span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-indigo-400 animate-pulse" title="updating…" />)}</th>
                                  <th colSpan={5} className="px-2 py-1 text-center text-amber-400">custom</th>
                                </tr>
                                <tr className="bg-gray-900 text-gray-600 text-[9px] uppercase tracking-wide">
                                  <th className="px-3 py-1.5 text-left font-medium">Song</th>
                                  <th className="px-2 py-1.5 text-center font-medium">P</th>
                                  <th className="px-2 py-1.5 text-center font-medium">R</th>
                                  <th className="px-2 py-1.5 text-center font-medium">F1</th>
                                  <th className="px-2 py-1.5 text-center font-medium border-r border-gray-800/60">Hits/Ref</th>
                                  <th className="px-2 py-1.5 text-center font-medium">P</th>
                                  <th className="px-2 py-1.5 text-center font-medium">R</th>
                                  <th className="px-2 py-1.5 text-center font-medium">F1</th>
                                  <th className="px-2 py-1.5 text-center font-medium">MNBD</th>
                                  <th className="px-2 py-1.5 text-center font-medium">CSR</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-gray-800/40">
                                {[...algo.perSong]
                                  .sort((a, b) => (b.mir?.fmeasure ?? -1) - (a.mir?.fmeasure ?? -1))
                                  .map((sr) => (
                                    <tr key={sr.songId} className="hover:bg-gray-800/30 transition-colors">
                                      <td className="px-3 py-1.5 text-gray-400 max-w-xs truncate">{sr.songName}</td>
                                      <td className={`px-2 py-1.5 text-center font-mono ${sr.mir ? metricColor(sr.mir.precision) : 'text-gray-700'}`}>
                                        {sr.mir ? pct(sr.mir.precision) : '—'}
                                      </td>
                                      <td className={`px-2 py-1.5 text-center font-mono ${sr.mir ? metricColor(sr.mir.recall) : 'text-gray-700'}`}>
                                        {sr.mir ? pct(sr.mir.recall) : '—'}
                                      </td>
                                      <td className={`px-2 py-1.5 text-center font-mono font-semibold ${sr.mir ? metricColor(sr.mir.fmeasure) : 'text-gray-700'}`}>
                                        {sr.mir ? pct(sr.mir.fmeasure) : '—'}
                                      </td>
                                      <td className="px-2 py-1.5 text-center font-mono text-gray-500 border-r border-gray-800/60">
                                        {sr.mir ? `${sr.mir.hitCount}/${sr.mir.refCount}` : '—'}
                                      </td>
                                      <td className={`px-2 py-1.5 text-center font-mono ${metricColor(sr.custom.precision)}`}>
                                        {pct(sr.custom.precision)}
                                      </td>
                                      <td className={`px-2 py-1.5 text-center font-mono ${metricColor(sr.custom.recall)}`}>
                                        {pct(sr.custom.recall)}
                                      </td>
                                      <td className={`px-2 py-1.5 text-center font-mono font-semibold ${metricColor(sr.custom.f1)}`}>
                                        {pct(sr.custom.f1)}
                                      </td>
                                      <td className={`px-2 py-1.5 text-center font-mono ${mnbdColor(sr.custom.mnbd)}`}>
                                        {sr.custom.mnbd.toFixed(2)}s
                                      </td>
                                      <td className={`px-2 py-1.5 text-center font-mono ${sr.custom.criticalCount > 0 ? metricColor(sr.custom.csr) : 'text-gray-700'}`}>
                                        {sr.custom.criticalCount > 0 ? pct(sr.custom.csr) : '—'}
                                      </td>
                                    </tr>
                                  ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {loadState === 'done' && rawData.length === 0 && (
        <div className="py-6 text-center text-gray-600 text-sm">No songs found in catalogue.</div>
      )}

      {/* SPAN family eval table — experimental. Renders only when the user
          has opted in via Settings → Experimental. Sits below the boundary
          table because Phase 2's per-family split is incremental (eventually
          every family gets its own table; for now boundary is still the
          mixed-shape default). */}
      {settings.experimentalCueExtras && (
        <GlobalEvalCueTable audioFiles={audioFiles} />
      )}

      {settings.experimentalSpanFamily && (
        <GlobalEvalSpanTable audioFiles={audioFiles} />
      )}

      {settings.experimentalLoopFamily && (
        <GlobalEvalLoopTable audioFiles={audioFiles} />
      )}

      {settings.experimentalPatternFamily && (
        <GlobalEvalPatternTable audioFiles={audioFiles} />
      )}

      {settings.experimentalLyricsFamily && (
        <GlobalEvalLyricsTable audioFiles={audioFiles} />
      )}

      <p className="text-[10px] text-gray-700 leading-relaxed">
        Each predicted boundary is paired one-to-one with the closest unmatched <strong className="text-gray-600">{evalRef}</strong> boundary
        within ±{tolerance}s (bipartite matching). Precision / recall / F1 are then averaged across songs that have both
        {evalMode === 'consensus' ? ' consensus boundaries' : ' algorithm output'} and a {evalRef} reference.
        {evalMode === 'per-algo'
          ? ' Click any row to expand its per-song breakdown.'
          : ' Click the ? next to "Auto-Consensus parameters" for a full explanation of the pipeline. "Find best parameters" brute-forces all combinations of cluster-window, min-agreement, centroid-method, and algorithm-subset to find the highest-F1 setup for this dataset.'}
      </p>
    </div>
  );
}
