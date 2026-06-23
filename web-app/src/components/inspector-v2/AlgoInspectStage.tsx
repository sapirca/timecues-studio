import { useEffect, useMemo, useRef, useState } from 'react';
import type { ToolResultData } from '../../tools/runTool';
import { useMirEvalSingle } from '../../services/mirEvalClient';
import { evaluateCustom } from '../../utils/evaluation';
import type { ManualSection } from '../../types/manualAnnotation';
import { CustomEvalControls, DEFAULT_CUSTOM_EVAL_SETTINGS, type CustomEvalSettings } from './CustomEvalControls';
import { EvalReferenceDropdown, type EvalReferenceMode } from './EvalReferenceDropdown';
import { ConsensusClusterControls } from './ConsensusClusterControls';
import { PreviewWindow, type PreviewRegion } from './PreviewWindow';

type ReferenceMode = EvalReferenceMode;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolState {
  status: 'idle' | 'running' | 'done' | 'error';
  result?: ToolResultData;
  error?: string;
}

export interface AlgorithmRow {
  id: string;
  label: string;
  sections: { time: number; endTime: number; label: string; type: string; color?: string }[];
}

// ─── Tool-state → row builder constants ───────────────────────────────────────

const ALGO_LABELS: Record<string, string> = {
  'msaf-olda':                 'OLDA',
  'msaf-cnmf':                 'CNMF',
  'msaf-foote':                'Foote',
  'msaf-sf':                   'SF',
  'allin1':                    'All-In-One',
  'ruptures-pelt-default':     'PELT (default)',
  'ruptures-binseg-default':   'BinSeg (default)',
  'ruptures-window-default':   'Window (default)',
  'band-gradient':             'BandGrad',
  // SPAN family — experimental. The rows render under the boundary inspector
  // since the visual model (timeline section bars) fits, but their per-kind
  // eval (IoU / frame-F1 / on-off F1) is deferred to the Phase 2 eval rework
  // — until then their eval columns show "—".
  'silero-vad':                'Silero-VAD',
  'jdcnet-voicing':            'JDCNet (voicing)',
  'panns-cnn14':               'PANNs CNN14',
  'chroma-autocorr':           'Chroma loops',
  'basic-pitch':               'basic-pitch',
  'librosa-key':               'librosa key',
  'autochord-chords':          'autochord',
  'librosa-onsets':            'librosa onsets',
  'hpss-percussive':           'HPSS percussive',
  'whisper-base':              'Whisper-base lyrics',
  'ctc-forced-aligner':        'CTC forced aligner (lyrics)',
  'locomotif':                 'LoCoMotif',
};

/** SPAN-family algo IDs. Exported so consumers (the run-options sidebar in
 *  InspectorPageV2) can filter them out when `experimentalSpanFamily` is off.
 *  panns-cnn14 lives here too — same output kind, separate sidecar. */
export const SPAN_ALGO_IDS = ['silero-vad', 'jdcnet-voicing', 'panns-cnn14'] as const;
export type SpanAlgoId = typeof SPAN_ALGO_IDS[number];

/** LOOP-family algo IDs (gated by `experimentalLoopFamily`). */
export const LOOP_ALGO_IDS = ['chroma-autocorr'] as const;
export type LoopAlgoId = typeof LOOP_ALGO_IDS[number];

/** CUE-family note-onset detector IDs (gated by `experimentalCueExtras`). */
export const PITCH_ALGO_IDS = ['basic-pitch'] as const;
export type PitchAlgoId = typeof PITCH_ALGO_IDS[number];

/** CUE-family extras (librosa key, autochord chords, librosa onsets) — gated by
 *  `experimentalCueExtras`. */
export const CUE_EXTRAS_ALGO_IDS = ['librosa-key', 'autochord-chords', 'librosa-onsets'] as const;
export type CueExtrasAlgoId = typeof CUE_EXTRAS_ALGO_IDS[number];

/** Percussive SPAN-family detector (HPSS) — gated by `experimentalSpanFamily`. */
export const PERCUSSIVE_ALGO_IDS = ['hpss-percussive'] as const;
export type PercussiveAlgoId = typeof PERCUSSIVE_ALGO_IDS[number];

/** LYRICS-family detector IDs — gated by `experimentalLyricsFamily`. */
export const LYRICS_ALGO_IDS = ['whisper-base', 'ctc-forced-aligner'] as const;
export type LyricsAlgoId = typeof LYRICS_ALGO_IDS[number];

/** PATTERN-family detector IDs — gated by `experimentalPatternFamily`. */
export const PATTERN_ALGO_IDS = ['locomotif'] as const;
export type PatternAlgoId = typeof PATTERN_ALGO_IDS[number];

const ALGO_ORDER = [
  'band-gradient',
  'ruptures-pelt-default', 'ruptures-binseg-default', 'ruptures-window-default',
  'msaf-olda', 'msaf-cnmf', 'msaf-foote', 'msaf-sf',
  'allin1',
  ...[0,1,2,3,4,5,6,7].map((n) => `allin1-fold${n}`),
  ...SPAN_ALGO_IDS,
  ...LOOP_ALGO_IDS,
  ...PITCH_ALGO_IDS,
  ...CUE_EXTRAS_ALGO_IDS,
  ...PERCUSSIVE_ALGO_IDS,
  ...LYRICS_ALGO_IDS,
  ...PATTERN_ALGO_IDS,
];

// The four Demucs stems, in the order per-stem rows stack under their base row.
const STEM_ROW_ORDER = ['vocals', 'drums', 'bass', 'other'] as const;

function algoLabel(id: string): string {
  // Composite per-stem id "<algo>__<stem>" → "<base label> · <stem>".
  const i = id.indexOf('__');
  if (i !== -1) return `${algoLabel(id.slice(0, i))} · ${id.slice(i + 2)}`;
  return ALGO_LABELS[id] ?? id.replace('allin1-', 'allin1 ');
}

// ─── Section colour palette ───────────────────────────────────────────────────

const SECTION_COLORS: Record<string, string> = {
  intro: '#a78bfa', bridge: '#fb7185', buildup: '#fde047',
  drop: '#4ade80', breakdown: '#e879f9', outro: '#64748b',
  silence: '#334155', section: '#64748b', default: '#94a3b8',
  // hit/miss tints used by the Consensus row to show evaluation status
  hit: '#22c55e', miss: '#ef4444',
};

function sectionBg(type: string) { return SECTION_COLORS[type] ?? SECTION_COLORS.default; }

// Hit/miss marker palette (used for tick overlays on the reference row)
const HIT_COLOR = '#22c55e';
const MISS_COLOR = '#ef4444';

// ─── Build annotation rows from toolStates ────────────────────────────────────

export function buildAnnotationRows(toolStates: Record<string, ToolState>): AlgorithmRow[] {
  // Walk the canonical order, and right after each base detector emit any
  // per-stem variants ("<base>__<stem>") that have a cached result — so a
  // detector's stem rows group directly beneath its full-mix row.
  const ids: string[] = [];
  for (const base of ALGO_ORDER) {
    ids.push(base);
    for (const stem of STEM_ROW_ORDER) {
      if (toolStates[`${base}__${stem}`]) ids.push(`${base}__${stem}`);
    }
  }
  return ids.flatMap((id) => {
    const state = toolStates[id];
    if (!state || state.status !== 'done' || !state.result) return [];
    // Every id here comes from ALGO_ORDER (or a per-stem variant of one), so the
    // result always carries `sections`. The old per-toolId dispatch existed only
    // to narrow the discriminated union; the composite stem ids can't be
    // narrowed that way, so read sections structurally instead.
    const sections =
      (state.result.result as { sections?: { time: number; endTime: number; label: string; type: string }[] })
        .sections ?? [];
    if (!sections.length) return [];
    return [{ id, label: algoLabel(id), sections }];
  });
}

// ─── Auto-Consensus clustering ────────────────────────────────────────────────

type CentroidMethod = 'mean' | 'median' | 'trimmed' | 'tightest' | 'eqgroup' | 'metamed' | 'plural' | 'nearraw';

const CENTROID_METHODS: { id: CentroidMethod; short: string; desc: string; example: string }[] = [
  {
    id: 'eqgroup', short: 'EqGrp',
    desc: 'Gives each algorithm one equal vote, no matter how many boundaries it placed here.',
    example: 'MSAF-SF fires at 3.1s & 3.15s → counts as one rep (3.13s). Foote: 3.3s, allin1: 3.5s → result: (3.13+3.3+3.5)/3 = 3.31s',
  },
  {
    id: 'metamed', short: 'MetaMed',
    desc: 'Computes four internal candidates (median, trimmed-mean, tightest-span, group-equal), then picks whichever is closest to their median — always an actual method\'s output, never a synthetic blend.',
    example: 'Candidates: 3.1, 3.2, 3.4, 3.5 → their median is 3.3 → picks 3.2 (nearest real candidate)',
  },
  {
    id: 'plural', short: 'Plural',
    desc: 'Picks the candidate that agrees with the most others (within 0.5s). Ties broken by proximity to the cluster mean.',
    example: 'Candidates: 3.1, 3.15, 3.4, 3.8 → 3.1 & 3.15 agree with each other (score 2 each); 3.4 and 3.8 are alone (score 1) → picks 3.1 or 3.15',
  },
  {
    id: 'nearraw', short: 'NearRaw',
    desc: 'Returns the actual raw algorithm timestamp with the smallest total distance to every other timestamp in the cluster (L1 minimizer — effectively the median of the raw sources).',
    example: 'Sources: 3.0, 3.2, 4.0 → 3.2 wins: total dist = 0.2+0+0.8 = 1.0, beats 3.0 (1.2) and 4.0 (1.8)',
  },
];

interface ConsensusCluster {
  members: { algorithmId: string; time: number }[];
  times: Record<CentroidMethod, number>;
  size: number;
}

function clusterForConsensus(rows: AlgorithmRow[], toleranceSec: number): ConsensusCluster[] {
  const allPoints = rows.flatMap((r) => r.sections.map((s) => ({ algorithmId: r.id, time: s.time })));
  if (!allPoints.length) return [];
  const sorted = [...allPoints].sort((a, b) => a.time - b.time);
  const raw: { sum: number; count: number; members: { algorithmId: string; time: number }[] }[] = [];

  for (const pt of sorted) {
    let bestIdx = -1, bestDist = Infinity;
    for (let k = raw.length - 1; k >= 0; k--) {
      const cent = raw[k].sum / raw[k].count;
      if (pt.time - cent > toleranceSec) break;
      const dist = Math.abs(pt.time - cent);
      if (dist <= toleranceSec && dist < bestDist) { bestDist = dist; bestIdx = k; }
    }
    if (bestIdx >= 0) {
      raw[bestIdx].members.push(pt); raw[bestIdx].sum += pt.time; raw[bestIdx].count += 1;
    } else {
      raw.push({ sum: pt.time, count: 1, members: [pt] });
    }
  }

  return raw.map(({ members }) => {
    const ts = [...members.map((m) => m.time)].sort((a, b) => a - b);
    const n = ts.length;
    const mean = ts.reduce((s, t) => s + t, 0) / n;

    const mid = Math.floor(n / 2);
    const median = n % 2 === 1 ? ts[mid] : (ts[mid - 1] + ts[mid]) / 2;

    let trimmed: number;
    if (n <= 2) {
      trimmed = mean;
    } else {
      const fi = ts.reduce((bi, t, i) => Math.abs(t - mean) > Math.abs(ts[bi] - mean) ? i : bi, 0);
      const arr = ts.filter((_, i) => i !== fi);
      trimmed = arr.reduce((s, t) => s + t, 0) / arr.length;
    }

    let tightest: number;
    {
      const majority = Math.ceil(n / 2);
      let bestSpan = Infinity, bestCenter = ts[0];
      for (let i = 0; i <= n - majority; i++) {
        const span = ts[i + majority - 1] - ts[i];
        if (span < bestSpan) { bestSpan = span; bestCenter = (ts[i] + ts[i + majority - 1]) / 2; }
      }
      tightest = bestCenter;
    }

    let eqgroup: number;
    {
      const gm = new Map<string, number[]>();
      for (const m of members) {
        if (!gm.has(m.algorithmId)) gm.set(m.algorithmId, []);
        gm.get(m.algorithmId)!.push(m.time);
      }
      const reps = [...gm.values()].map((gts) => gts.reduce((s, t) => s + t, 0) / gts.length);
      eqgroup = reps.reduce((s, t) => s + t, 0) / reps.length;
    }

    let metamed: number;
    {
      const cands = [median, trimmed, tightest, eqgroup].sort((x, y) => x - y);
      const mm = cands.length % 2 === 1
        ? cands[Math.floor(cands.length / 2)]
        : (cands[cands.length / 2 - 1] + cands[cands.length / 2]) / 2;
      metamed = [median, trimmed, tightest, eqgroup].reduce(
        (best, v) => Math.abs(v - mm) < Math.abs(best - mm) ? v : best, median);
    }

    let plural: number;
    {
      const cands = [median, trimmed, tightest, eqgroup];
      const scores = cands.map((v) => cands.filter((u) => Math.abs(u - v) <= 0.5).length);
      const maxS = Math.max(...scores);
      const winners = cands.filter((_, i) => scores[i] === maxS);
      plural = winners.reduce((best, v) => Math.abs(v - mean) < Math.abs(best - mean) ? v : best, winners[0]);
    }

    const nearraw = ts.reduce((best, t) => {
      const sd = ts.reduce((s, u) => s + Math.abs(t - u), 0);
      const bd = ts.reduce((s, u) => s + Math.abs(best - u), 0);
      return sd < bd ? t : best;
    }, ts[0]);

    return { members, size: n, times: { mean, median, trimmed, tightest, eqgroup, metamed, plural, nearraw } };
  });
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function MetricChip({ label, value, isMnbd = false }: { label: string; value: number | null; isMnbd?: boolean }) {
  if (value === null) return null;
  let color: string;
  let display: string;
  if (isMnbd) {
    color = value <= 0.5 ? 'text-green-400' : value <= 1.5 ? 'text-yellow-400' : 'text-red-400';
    display = `${value.toFixed(2)}s`;
  } else {
    const pct = Math.round(value * 100);
    color = pct >= 70 ? 'text-green-400' : pct >= 45 ? 'text-yellow-400' : 'text-red-400';
    display = `${pct}%`;
  }
  return (
    <span className="inline-flex items-baseline gap-0.5">
      <span className="text-[9px] uppercase text-gray-500">{label}</span>
      <span className={`text-[11px] font-mono ${color}`}>{display}</span>
    </span>
  );
}

interface BoundaryMarker {
  time: number;
  status: 'hit' | 'miss';
  /** Distance to matched counterpart (sec). Only set on hits. */
  error?: number;
}

function MiniBlockRow({
  sections, duration, label, color = '#64748b', cursorTime, onSeek, boundaryMarkers,
  previewRegion, previewIsPlaying, onOpenPreviewRegion, onPreviewRegionChange,
  onPreviewPlay, onPreviewPause, onPreviewLoopToggle, onPreviewDismiss, onPreviewClear,
  showPreviewControls = false,
}: {
  sections: { time: number; endTime: number; label: string; type: string }[];
  duration: number;
  label: string;
  color?: string;
  cursorTime?: number;
  onSeek?: (time: number) => void;
  boundaryMarkers?: BoundaryMarker[];
  /** Active preview region; renders as the same cyan band as the viz panel. */
  previewRegion?: PreviewRegion | null;
  previewIsPlaying?: boolean;
  /** Drag-to-listen — fires on a row drag (NOT a plain click). Plain click
   *  falls through to `onSeek`. */
  onOpenPreviewRegion?: (start: number, end: number) => void;
  onPreviewRegionChange?: (next: PreviewRegion) => void;
  onPreviewPlay?: () => void;
  onPreviewPause?: () => void;
  onPreviewLoopToggle?: () => void;
  /** × button — restores the playback anchor (where the cursor was before the
   *  preview opened). */
  onPreviewDismiss?: () => void;
  /** Click-on-row clear — like `onPreviewDismiss` but does NOT restore the
   *  anchor; the playhead stays at the just-clicked position. */
  onPreviewClear?: () => void;
  /** Only the topmost row in a stack should render the floating control bar
   *  — the other rows show the band-only mirror. */
  showPreviewControls?: boolean;
}) {
  const cursorPct = cursorTime != null && duration > 0
    ? Math.max(0, Math.min(100, (cursorTime / duration) * 100))
    : null;
  const barRef = useRef<HTMLDivElement | null>(null);
  // Tracks the in-progress click/drag so we can distinguish a plain click
  // (→ onSeek) from a drag (→ onOpenPreviewRegion). Global window listeners
  // (installed on mousedown) keep the drag alive even when the cursor leaves
  // the 20-px-tall row — using only React's onMouseLeave/onMouseUp would
  // silently drop most drags on a row this thin.
  const dragRef = useRef<{ time: number; x: number } | null>(null);
  const [dragSel, setDragSel] = useState<{ s: number; e: number } | null>(null);

  const timeAtClientX = (clientX: number): number => {
    const el = barRef.current;
    if (!el || duration <= 0) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.max(0, Math.min(duration, ((clientX - rect.left) / rect.width) * duration));
  };

  const supportsRegion = !!onOpenPreviewRegion;
  const onSeekRef = useRef(onSeek);
  const onOpenPreviewRegionRef = useRef(onOpenPreviewRegion);
  const onPreviewClearRef = useRef(onPreviewClear);
  const hasPreviewRef = useRef(!!previewRegion);
  useEffect(() => { onSeekRef.current = onSeek; }, [onSeek]);
  useEffect(() => { onOpenPreviewRegionRef.current = onOpenPreviewRegion; }, [onOpenPreviewRegion]);
  useEffect(() => { onPreviewClearRef.current = onPreviewClear; }, [onPreviewClear]);
  useEffect(() => { hasPreviewRef.current = !!previewRegion; }, [previewRegion]);
  // The wrapper is intentionally NOT overflow-hidden so the preview band's
  // floating control bar (which sits ~28 px above the row) doesn't get
  // clipped. The inner bar div keeps overflow-hidden for clipping the
  // section blocks at the row's edges.
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-gray-500 w-16 shrink-0 text-right truncate">{label}</span>
      <div ref={barRef} className="flex-1 relative h-5">
      <div
        className={`absolute inset-0 rounded overflow-hidden bg-gray-950 ${onSeek ? 'cursor-pointer' : ''}`}
        onMouseDown={onSeek && duration > 0 ? (e) => {
          // The PreviewWindow band sets pointer-events:none on its background
          // so clicks fall through to here; its resize handles call
          // e.stopPropagation() in beginDrag so handle-drags never reach this
          // handler. So there is nothing to filter out at this layer — every
          // mousedown that arrives is a legitimate row interaction.
          const t0 = timeAtClientX(e.clientX);
          const x0 = e.clientX;
          dragRef.current = { time: t0, x: x0 };
          if (supportsRegion) setDragSel({ s: t0, e: t0 });
          // Global listeners — survive the cursor leaving the 20-px row
          // mid-drag, which is the common case for a fast horizontal drag.
          const onMove = (ev: MouseEvent) => {
            if (!dragRef.current) return;
            setDragSel({ s: dragRef.current.time, e: timeAtClientX(ev.clientX) });
          };
          const onUp = (ev: MouseEvent) => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            const drag = dragRef.current;
            dragRef.current = null;
            setDragSel(null);
            if (!drag) return;
            const endT = timeAtClientX(ev.clientX);
            const px = Math.abs(ev.clientX - drag.x);
            const t1 = Math.min(drag.time, endT);
            const t2 = Math.max(drag.time, endT);
            if (supportsRegion && px > 6 && t2 - t1 > 0.1) {
              onOpenPreviewRegionRef.current?.(t1, t2);
            } else {
              // Plain click → seek to the clicked time, and clear any active
              // preview (without restoring the dismiss-anchor) so the playhead
              // stays where the user just clicked. Matches viz-panel UX.
              onSeekRef.current?.(drag.time);
              if (hasPreviewRef.current) onPreviewClearRef.current?.();
            }
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
          e.preventDefault();
        } : undefined}
      >
        {sections.map((s, i) => {
          const left  = duration > 0 ? (s.time / duration) * 100 : 0;
          const width = Math.max(0.3, duration > 0 ? ((s.endTime - s.time) / duration) * 100 : 0);
          const bg    = sectionBg(s.type) !== SECTION_COLORS.default ? sectionBg(s.type) : color;
          const isStatus = s.type === 'hit' || s.type === 'miss';
          return (
            <div key={i} className="absolute top-0 bottom-0 overflow-hidden"
              style={{ left: `${left}%`, width: `${width}%`, background: bg, opacity: isStatus ? 0.85 : 0.62, borderRight: '1px solid rgba(0,0,0,0.3)' }}
              title={`${s.label} @ ${(s.time / 60 | 0)}:${(s.time % 60).toFixed(0).padStart(2, '0')}`}
            >
              <span className={`absolute inset-x-0.5 top-0.5 truncate pointer-events-none select-none leading-none ${isStatus ? 'text-[9px] text-white font-bold' : 'text-[7px] text-white/70'}`}>
                {s.label}
              </span>
            </div>
          );
        })}
        {boundaryMarkers && duration > 0 && boundaryMarkers.map((m, i) => {
          const leftPct = (m.time / duration) * 100;
          const fill = m.status === 'hit' ? HIT_COLOR : MISS_COLOR;
          const tip = m.status === 'hit'
            ? `✓ matched (Δ${m.error != null ? m.error.toFixed(2) : '0.00'}s) @ ${m.time.toFixed(2)}s`
            : `✗ missed by consensus @ ${m.time.toFixed(2)}s`;
          return (
            <div
              key={i}
              className="absolute pointer-events-auto"
              style={{
                left: `${leftPct}%`,
                top: 0,
                height: '5px',
                width: '5px',
                background: fill,
                transform: 'translateX(-2px)',
                zIndex: 5,
                boxShadow: `0 0 3px ${fill}`,
                borderBottomLeftRadius: '1px',
                borderBottomRightRadius: '1px',
              }}
              title={tip}
            />
          );
        })}
        {cursorPct != null && (
          <div
            className="absolute top-0 bottom-0 pointer-events-none"
            style={{ left: `${cursorPct}%`, width: '2px', background: '#fff', boxShadow: '0 0 4px rgba(255,255,255,0.7)', transform: 'translateX(-1px)', zIndex: 10 }}
          />
        )}
        {/* In-progress drag rectangle (transient — replaced by the real
            previewRegion band once mouseup commits the gesture). */}
        {dragSel && duration > 0 && Math.abs(dragSel.e - dragSel.s) > 0.05 && (
          <div
            className="absolute top-0 bottom-0 pointer-events-none"
            style={{
              left: `${(Math.min(dragSel.s, dragSel.e) / duration) * 100}%`,
              width: `${(Math.abs(dragSel.e - dragSel.s) / duration) * 100}%`,
              background: 'rgba(45,212,191,0.13)',
              borderLeft: '2px solid rgba(45,212,191,0.7)',
              borderRight: '2px solid rgba(45,212,191,0.7)',
              zIndex: 8,
            }}
          />
        )}
      </div>
      {/* Committed preview band — same cyan strip + handles + (top row only)
          control bar as the viz panel. Lives OUTSIDE the overflow-hidden bar
          so the -28 px floating control bar isn't clipped. data-preview-band
          marker lets the bar's mousedown handler skip drags originating
          inside the band's handles / controls. */}
      {previewRegion && duration > 0 && onPreviewRegionChange && onPreviewPlay && onPreviewPause && onPreviewDismiss && onPreviewLoopToggle && (
        <div data-preview-band className="absolute inset-0 pointer-events-none" style={{ zIndex: 12 }}>
          <PreviewWindow
            region={previewRegion}
            duration={duration}
            isPlaying={!!previewIsPlaying}
            parentRef={barRef}
            onChange={onPreviewRegionChange}
            onPlay={onPreviewPlay}
            onPause={onPreviewPause}
            onDismiss={onPreviewDismiss}
            onLoopToggle={onPreviewLoopToggle}
            showControls={showPreviewControls}
          />
        </div>
      )}
      </div>
    </div>
  );
}

// ─── Auto-Consensus Panel ─────────────────────────────────────────────────────

const REFERENCE_ROW_LABELS: Record<ReferenceMode, string> = {
  manual: 'Boundaries',
  eye: 'Eye',
  autoGuess: 'Auto-guess',
};
const REFERENCE_ROW_COLORS: Record<ReferenceMode, string> = {
  manual: '#f59e0b',
  eye: '#2dd4bf',
  autoGuess: '#a855f7',
};

function AutoConsensusPanel({
  rows,
  referenceSections,
  referenceMode,
  duration,
  evalTolerance,
  customSettings,
  onCustomSettingsChange,
  currentTime,
  onSeek,
  previewRegion,
  previewIsPlaying,
  onOpenPreviewRegion,
  onPreviewRegionChange,
  onPreviewPlay,
  onPreviewPause,
  onPreviewLoopToggle,
  onPreviewDismiss,
  onPreviewClear,
}: {
  rows: AlgorithmRow[];
  referenceSections: ManualSection[];
  referenceMode: ReferenceMode;
  duration: number;
  evalTolerance: number;
  customSettings: CustomEvalSettings;
  onCustomSettingsChange: (next: CustomEvalSettings) => void;
  currentTime?: number;
  onSeek?: (time: number) => void;
  previewRegion?: PreviewRegion | null;
  previewIsPlaying?: boolean;
  onOpenPreviewRegion?: (start: number, end: number) => void;
  onPreviewRegionChange?: (next: PreviewRegion) => void;
  onPreviewPlay?: () => void;
  onPreviewPause?: () => void;
  onPreviewLoopToggle?: () => void;
  onPreviewDismiss?: () => void;
  onPreviewClear?: () => void;
}) {
  const [clusterTol, setClusterTol] = useState(3);
  const [minAgreement, setMinAgreement] = useState(2);
  const [method, setMethod] = useState<CentroidMethod>('metamed');
  const [selectedAlgoIds, setSelectedAlgoIds] = useState<Set<string>>(() => new Set(rows.map((r) => r.id)));

  useEffect(() => {
    setSelectedAlgoIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      rows.forEach((r) => { if (!next.has(r.id)) { next.add(r.id); changed = true; } });
      return changed ? next : prev;
    });
  }, [rows]);

  const activeRows = useMemo(() => rows.filter((r) => selectedAlgoIds.has(r.id)), [rows, selectedAlgoIds]);

  const clusters = useMemo(() => clusterForConsensus(activeRows, clusterTol), [activeRows, clusterTol]);
  const filtered = useMemo(() => clusters.filter((c) => new Set(c.members.map((m) => m.algorithmId)).size >= minAgreement), [clusters, minAgreement]);
  const consensusTimes = useMemo(() => filtered.map((c) => c.times[method]), [filtered, method]);

  const referenceBlocks = useMemo(() => referenceSections.map((s, i) => ({
    time: s.time, endTime: referenceSections[i + 1]?.time ?? duration, label: s.label ?? s.type, type: s.type,
  })), [referenceSections, duration]);

  // mir_eval (server-side, debounced) — strict boundary retrieval against ref.
  const sortedConsensus = useMemo(() => [...consensusTimes].sort((a, b) => a - b), [consensusTimes]);
  const mirPair = useMemo(() => {
    if (!referenceSections.length || !sortedConsensus.length || duration <= 0) return null;
    return {
      refTimes: referenceSections.map((s) => s.time),
      estTimes: sortedConsensus,
      tolerance: evalTolerance,
      trackDuration: duration,
    };
  }, [referenceSections, sortedConsensus, duration, evalTolerance]);
  const { result: evalResult } = useMirEvalSingle(mirPair);

  // Map est/ref boundary times → nearest-neighbor error, used to color
  // consensus blocks (hit/miss) and to overlay green/red ticks on the active
  // reference row. Uses the server's per-boundary nearest-neighbor distances;
  // a marker counts as 'hit' iff its nearest counterpart is within tolerance.
  const estMatch = useMemo(() => {
    const m = new Map<number, number>();
    if (!evalResult) return m;
    sortedConsensus.forEach((t, i) => {
      const err = evalResult.e2tErrors[i];
      if (err !== undefined && err <= evalTolerance) m.set(t, err);
    });
    return m;
  }, [evalResult, sortedConsensus, evalTolerance]);
  const refMatch = useMemo(() => {
    const m = new Map<number, number>();
    if (!evalResult) return m;
    referenceSections.forEach((s, i) => {
      const err = evalResult.t2eErrors[i];
      if (err !== undefined && err <= evalTolerance) m.set(s.time, err);
    });
    return m;
  }, [evalResult, referenceSections, evalTolerance]);

  const consensusBlocks = useMemo(() => {
    const sorted = [...consensusTimes].sort((a, b) => a - b);
    const hasEval = evalResult != null;
    return sorted.map((t, i) => {
      const isHit = estMatch.has(t);
      // No reference loaded → keep neutral 'consensus' blocks (no green/red noise).
      const type = !hasEval ? 'consensus' : isHit ? 'hit' : 'miss';
      const label = !hasEval ? 'C' : isHit ? '✓' : '✗';
      return { time: t, endTime: sorted[i + 1] ?? duration, label, type };
    });
  }, [consensusTimes, duration, estMatch, evalResult]);

  // Reference-row markers: green tick on matched ref boundaries (TP), red tick
  // on missed ones (FN). Only shown on the row that's actively being evaluated.
  const referenceMarkers = useMemo<BoundaryMarker[] | undefined>(() => {
    if (!evalResult) return undefined;
    return referenceSections.map((s) => {
      const err = refMatch.get(s.time);
      return err !== undefined
        ? { time: s.time, status: 'hit' as const, error: err }
        : { time: s.time, status: 'miss' as const };
    });
  }, [evalResult, referenceSections, refMatch]);

  const referenceLabel = REFERENCE_ROW_LABELS[referenceMode];
  const referenceColor = REFERENCE_ROW_COLORS[referenceMode];

  const customEvalResult = useMemo(() => {
    if (!referenceSections.length || !consensusTimes.length || duration <= 0) return null;
    return evaluateCustom(referenceSections, consensusTimes, duration, {
      toleranceSec: evalTolerance,
      optionalWeight: customSettings.optionalWeight,
      useSecondary: customSettings.useSecondary,
    });
  }, [referenceSections, consensusTimes, duration, evalTolerance, customSettings.optionalWeight, customSettings.useSecondary]);

  if (!rows.length) {
    return (
      <div className="py-6 flex flex-col items-center gap-3">
        <p className="text-xs text-gray-600 text-center">
          No algorithm results loaded yet. Open the <span className="text-violet-300">Algorithms</span> sidebar on the right and click <span className="text-violet-300">▶ Run for this song</span> to generate consensus boundaries.
        </p>
      </div>
    );
  }

  const totalAlgos = activeRows.length;

  return (
    <div className="rounded-lg border border-violet-800/40 bg-violet-950/20 p-3 space-y-3">
      {/* ── Section header: mirrors the Auto-guess panel so the controls below read the same ── */}
      {rows.length > 0 && (
        <div className="border-l-2 border-violet-400/40 pl-3 py-1">
          <h4 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-violet-200">
            Evaluate as &apos;Boundaries&apos;
          </h4>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Configure the consensus parameters: <span className="text-slate-500 uppercase tracking-wider text-[10px]">settings</span>
          </p>
        </div>
      )}

      {/* ── Header: title · counts · metrics · settings popover · cluster window ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-semibold text-violet-400 uppercase tracking-wide">Auto Consensus</span>
        <span className="text-[10px] text-gray-600">{filtered.length} bnds · {totalAlgos}/{rows.length}</span>

        {evalResult && (
          <span
            className="inline-flex items-center gap-2 px-2 py-0.5 rounded border border-indigo-800/40 bg-indigo-950/20"
            title={`Strict mir_eval boundary retrieval — no importance weighting. Candidate alternates ${customSettings.useSecondary ? 'count as valid matches' : 'are ignored (primary boundary only)'}.`}
          >
            <span className="text-[9px] text-indigo-400 uppercase tracking-wide">mir_eval</span>
            <MetricChip label="P"  value={evalResult.precision} />
            <MetricChip label="R"  value={evalResult.recall} />
            <MetricChip label="F1" value={evalResult.fmeasure} />
          </span>
        )}
        {customEvalResult && (
          <span
            className="inline-flex items-center gap-2 px-2 py-0.5 rounded border border-amber-800/40 bg-amber-950/20"
            title="Custom evaluator — applies optional-weight; adds MNBD and CSR. Candidate-alternate matching is shared with mir_eval and controlled by the 'Use candidates' toggle."
          >
            <span className="text-[9px] text-amber-400 uppercase tracking-wide">custom</span>
            <MetricChip label="P"   value={customEvalResult.precision} />
            <MetricChip label="R"   value={customEvalResult.recall} />
            <MetricChip label="F1"  value={customEvalResult.f1} />
            <MetricChip label="MNBD" value={customEvalResult.mnbd} isMnbd />
            <MetricChip label="CSR" value={customEvalResult.csr} />
          </span>
        )}

        <div className="flex-1" />

        <ConsensusClusterControls
          algoRows={rows.map((r) => ({ id: r.id, displayLabel: r.label, count: r.sections.length }))}
          selectedAlgoIds={selectedAlgoIds}
          onSelectedAlgoIdsChange={setSelectedAlgoIds}
          clusterWindow={clusterTol}
          onClusterWindowChange={setClusterTol}
          centroidMethod={method}
          onCentroidMethodChange={setMethod}
          centroidOptions={CENTROID_METHODS.map((m) => ({ id: m.id, short: m.short, description: m.desc, example: m.example }))}
          minConsensus={minAgreement}
          onMinConsensusChange={setMinAgreement}
          minConsensusLabel="Min agreement"
          popoverAlign="right"
          extraPopoverSection={
            <div className="pt-3 border-t border-white/[0.06] space-y-2">
              <span className="text-[10px] uppercase tracking-wider text-amber-400">Custom eval</span>
              <CustomEvalControls settings={customSettings} onChange={onCustomSettingsChange} compact />
            </div>
          }
        />
      </div>

      {/* ── Visualization rows ───────────────────────────────────────────── */}
      {duration > 0 ? (
        <div className="space-y-1.5">
          {referenceBlocks.length > 0 ? (
            <MiniBlockRow
              sections={referenceBlocks} duration={duration} label={referenceLabel} color={referenceColor}
              cursorTime={currentTime} onSeek={onSeek} boundaryMarkers={referenceMarkers}
              previewRegion={previewRegion} previewIsPlaying={previewIsPlaying}
              onOpenPreviewRegion={onOpenPreviewRegion}
              onPreviewRegionChange={onPreviewRegionChange}
              onPreviewPlay={onPreviewPlay} onPreviewPause={onPreviewPause}
              onPreviewLoopToggle={onPreviewLoopToggle} onPreviewDismiss={onPreviewDismiss}
              onPreviewClear={onPreviewClear}
            />
          ) : (
            <p className="text-[11px] text-gray-600 text-center py-1">
              No {referenceLabel} annotation for this song.
            </p>
          )}
          {consensusBlocks.length > 0 ? (
            <MiniBlockRow
              sections={consensusBlocks} duration={duration} label="Consensus" color="#8b5cf6"
              cursorTime={currentTime} onSeek={onSeek}
              previewRegion={previewRegion} previewIsPlaying={previewIsPlaying}
              onOpenPreviewRegion={onOpenPreviewRegion}
              onPreviewRegionChange={onPreviewRegionChange}
              onPreviewPlay={onPreviewPlay} onPreviewPause={onPreviewPause}
              onPreviewLoopToggle={onPreviewLoopToggle} onPreviewDismiss={onPreviewDismiss}
              onPreviewClear={onPreviewClear}
            />
          ) : (
            <p className="text-[11px] text-gray-600 text-center py-1">
              {activeRows.length === 0 ? 'No algorithms selected.' : `No clusters with ≥${minAgreement}/${totalAlgos} agreeing algorithms.`}
            </p>
          )}
          {evalResult && consensusBlocks.length > 0 && (() => {
            const tp = evalResult.hitCount;
            const fp = evalResult.estCount - tp;
            const fn = evalResult.refCount - tp;
            const refLabel = REFERENCE_ROW_LABELS[referenceMode];
            return (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 pl-[72px] text-[10px] text-gray-500">
                <span className="flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: HIT_COLOR, opacity: 0.85 }} />
                  Hit · matched within ±{evalTolerance}s ({tp})
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: MISS_COLOR, opacity: 0.85 }} />
                  Miss · consensus w/ no {refLabel} match ({fp})
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-1.5 h-2.5" style={{ background: MISS_COLOR }} />
                  {refLabel} boundary missed by consensus ({fn})
                </span>
              </div>
            );
          })()}
        </div>
      ) : (
        <p className="text-[11px] text-gray-600 text-center py-1">
          {activeRows.length === 0 ? 'No algorithms selected.' : `No clusters with ≥${minAgreement}/${totalAlgos} agreeing algorithms.`}
        </p>
      )}
    </div>
  );
}

// ─── AlgoInspectStage — thin wrapper around AutoConsensusPanel ────────────────

export interface AlgoInspectStageProps {
  annotationRows: AlgorithmRow[];
  manualSections: ManualSection[];
  eyeSections?: ManualSection[];
  autoGuessSections?: ManualSection[];
  /** When false, hide the Eye option from the eval-reference dropdown
   *  entirely (gated by the `experimentalEyeAnnotation` Settings flag). */
  eyeEnabled?: boolean;
  duration: number;
  tolerance: number;
  onToleranceChange: (t: number) => void;
  currentTime?: number;
  onSeek?: (time: number) => void;
  // Drag-to-listen preview region — same cyan band + play/loop controls as
  // the viz panel. Wired from InspectorPageV2's existing handlers so the
  // region state is shared (a region opened in algo-inspect also paints on
  // the OverviewWaveform and vice-versa).
  previewRegion?: PreviewRegion | null;
  previewIsPlaying?: boolean;
  onOpenPreviewRegion?: (start: number, end: number) => void;
  onPreviewRegionChange?: (next: PreviewRegion) => void;
  onPreviewPlay?: () => void;
  onPreviewPause?: () => void;
  onPreviewLoopToggle?: () => void;
  onPreviewDismiss?: () => void;
  /** Click-on-row clear — used to dismiss the preview without restoring the
   *  anchor cursor (so the playhead stays where the user just clicked). */
  onPreviewClear?: () => void;
}

export function AlgoInspectStage({
  annotationRows,
  manualSections,
  eyeSections = [],
  autoGuessSections = [],
  eyeEnabled = true,
  duration,
  tolerance,
  onToleranceChange,
  currentTime,
  onSeek,
  previewRegion,
  previewIsPlaying,
  onOpenPreviewRegion,
  onPreviewRegionChange,
  onPreviewPlay,
  onPreviewPause,
  onPreviewLoopToggle,
  onPreviewDismiss,
  onPreviewClear,
}: AlgoInspectStageProps) {
  const [referenceMode, setReferenceMode] = useState<ReferenceMode>('manual');
  const [customSettings, setCustomSettings] = useState<CustomEvalSettings>(DEFAULT_CUSTOM_EVAL_SETTINGS);

  // Fall back to manual if the chosen reference disappears (including when
  // the experimental Eye flag flips off while Eye was selected).
  useEffect(() => {
    if (referenceMode === 'eye'       && (!eyeEnabled || !eyeSections.length) && manualSections.length) setReferenceMode('manual');
    if (referenceMode === 'autoGuess' && !autoGuessSections.length && manualSections.length) setReferenceMode('manual');
  }, [referenceMode, eyeEnabled, eyeSections.length, autoGuessSections.length, manualSections.length]);

  const referenceSections = useMemo(() => {
    if (referenceMode === 'eye')       return eyeSections;
    if (referenceMode === 'autoGuess') return autoGuessSections;
    return manualSections;
  }, [referenceMode, manualSections, eyeSections, autoGuessSections]);

  return (
    <div className="space-y-3">
      {/* Header layout mirrors the Evaluation tab: title on the left, reference + τ on the right. */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-gray-300">Consensus Inspect</h3>
          <p className="text-[11px] text-gray-600 mt-0.5">
            Aggregate algorithm boundaries into a single consensus and score it against {referenceMode}.
          </p>
        </div>

        <EvalReferenceDropdown
          value={referenceMode}
          onChange={setReferenceMode}
          options={[
            { mode: 'manual',      hasData: manualSections.length      > 0 },
            ...(eyeEnabled ? [{ mode: 'eye' as const, hasData: eyeSections.length > 0 }] : []),
            { mode: 'autoGuess', hasData: autoGuessSections.length > 0 },
          ]}
        />

        <div className="flex items-center gap-2 text-[11px] text-gray-500">
          <span>τ =</span>
          <input
            type="range" min="0.25" max="5" step="0.25"
            value={tolerance} onChange={(e) => onToleranceChange(Number(e.target.value))}
            className="w-20 accent-indigo-500"
          />
          <span className="font-mono text-gray-300 w-8">{tolerance}s</span>
        </div>
      </div>

      <AutoConsensusPanel
        rows={annotationRows}
        referenceSections={referenceSections}
        referenceMode={referenceMode}
        duration={duration}
        evalTolerance={tolerance}
        customSettings={customSettings}
        onCustomSettingsChange={setCustomSettings}
        currentTime={currentTime}
        onSeek={onSeek}
        previewRegion={previewRegion}
        previewIsPlaying={previewIsPlaying}
        onOpenPreviewRegion={onOpenPreviewRegion}
        onPreviewRegionChange={onPreviewRegionChange}
        onPreviewPlay={onPreviewPlay}
        onPreviewPause={onPreviewPause}
        onPreviewLoopToggle={onPreviewLoopToggle}
        onPreviewDismiss={onPreviewDismiss}
        onPreviewClear={onPreviewClear}
      />
    </div>
  );
}
