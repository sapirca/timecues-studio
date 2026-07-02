// SPAN-family eval table for the all-songs view. Renders when
// `experimentalSpanFamily` is on — appears below the boundary algorithms
// table in GlobalEvalStage. Compares each SPAN detector's per-song output
// (cached at /api/span/detect/<slug>/<algo>) against the user's first span
// reference layer (loaded via /api/annotation-layers/<slug>); songs without
// a span layer show '—' across the eval columns.
//
// The eval primitives live in utils/evaluation.ts (evaluateSpans); this
// file only handles fetching, aggregation, and rendering.

import { useEffect, useMemo, useState } from 'react';
import { loadCachedSpan, runSpanDetection, type SpanDetectionResult } from '../../services/spanDetection';
import { loadLayers } from '../../services/annotationLayers';
import { evaluateSpans, effectiveLayerMode, type SpanEvalResult } from '../../utils/evaluation';
import type { SpanItem, AnnotationLayer } from '../../types/annotationLayer';
import { useSettings } from '../../context/SettingsContext';
import { InfoDot } from './InfoDot';

export interface SpanEvalAudioEntry {
  id: string;
  name: string;
}

interface PerSongRow {
  songId: string;
  songName: string;
  /** Number of span items in the (first) reference span layer. 0 = no ref. */
  refCount: number;
  /** Per-algo eval result keyed by algo id. Null when prediction missing. */
  results: Record<string, SpanEvalResult | null>;
}

interface AlgoAggregate {
  algo: string;
  label: string;
  songs: number;
  /** Mean of per-song matched metrics, ignoring songs without a ref. */
  iou: number;
  frameF1: number;
  onsetF1: number;
  offsetF1: number;
  coverage: number;
}

const SPAN_ALGO_IDS = ['silero-vad', 'jdcnet-voicing'] as const;
const SPAN_LABELS: Record<string, string> = {
  'silero-vad':     'Silero-VAD',
  'jdcnet-voicing': 'JDCNet',
};

/** Pull the first span layer with items. Returns an empty array when the
 *  document has no span layer or every span layer is empty — that's the
 *  signal callers use to render '—' in eval columns rather than 0%. The
 *  layer's `mode` (defaults to 'full-annotation') travels alongside so
 *  evaluateSpans can honour the annotator's mode picker selection. */
function pickSpanReference(
  layers: AnnotationLayer[],
): { items: SpanItem[]; mode: import('../../types/annotationLayer').LayerEvalMode } {
  for (const l of layers) {
    if (l.type !== 'spans') continue;
    const items = l.items as unknown as SpanItem[];
    if (items.length > 0) return { items, mode: l.mode ?? 'full-annotation' };
  }
  return { items: [], mode: 'full-annotation' };
}

async function loadPredictedSpans(slug: string, algo: string, force: boolean): Promise<SpanDetectionResult | null> {
  if (!force) {
    const cached = await loadCachedSpan(slug, algo);
    if (cached && cached.ok !== false) return cached;
  }
  return runSpanDetection(slug, algo, force);
}

function predsToSpanItems(pred: SpanDetectionResult): SpanItem[] {
  return pred.spans.map((s, i) => ({
    id: `${pred.algorithm}:${i}`,
    start: s.start,
    end: s.end,
    label: s.label,
  }));
}

export function GlobalEvalSpanTable({
  audioFiles,
  trackDurationFallback = 180,
}: {
  audioFiles: SpanEvalAudioEntry[];
  /** Used when an algo result didn't include a duration field. The
   *  rasterised frame-F1 doesn't materially depend on this — overshoot
   *  is fine, as long as the value is bigger than every reference end. */
  trackDurationFallback?: number;
}) {
  const [rows, setRows] = useState<PerSongRow[]>([]);
  const [loading, setLoading] = useState(false);
  const { settings } = useSettings();
  const forceCandidates = settings.evalRegionLayersAsCandidates;

  // Load all (song × algo) pairs in parallel. Cancelled when the component
  // unmounts or audioFiles changes by tracking a `cancelled` flag.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (audioFiles.length === 0) { setRows([]); return; }
      setLoading(true);
      const out: PerSongRow[] = await Promise.all(audioFiles.map(async (a) => {
        // Reference span layer (first non-empty one) and its evaluation mode.
        const doc = await loadLayers(a.id);
        const { items: ref, mode } = pickSpanReference(doc.layers);
        const results: Record<string, SpanEvalResult | null> = {};
        for (const algo of SPAN_ALGO_IDS) {
          const pred = await loadPredictedSpans(a.id, algo, false);
          if (!pred || pred.ok === false) {
            results[algo] = null;
            continue;
          }
          if (ref.length === 0) {
            // No reference yet — store a "computed" sentinel with refCount=0.
            // Eval columns will render '—' downstream.
            results[algo] = null;
            continue;
          }
          const duration = pred.duration || trackDurationFallback;
          results[algo] = evaluateSpans(ref, predsToSpanItems(pred), duration, {
            mode: effectiveLayerMode(mode, forceCandidates),
          });
        }
        return { songId: a.id, songName: a.name, refCount: ref.length, results };
      }));
      if (!cancelled) {
        setRows(out);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [audioFiles, trackDurationFallback, forceCandidates]);

  const aggregates = useMemo<AlgoAggregate[]>(() => {
    return SPAN_ALGO_IDS.map((algo) => {
      const scored = rows
        .map((r) => r.results[algo])
        .filter((r): r is SpanEvalResult => r !== null);
      const n = scored.length || 1;
      return {
        algo,
        label: SPAN_LABELS[algo],
        songs: scored.length,
        iou:      scored.reduce((s, r) => s + r.meanIoU,  0) / n,
        frameF1:  scored.reduce((s, r) => s + r.frameF1,  0) / n,
        onsetF1:  scored.reduce((s, r) => s + r.onsetF1,  0) / n,
        offsetF1: scored.reduce((s, r) => s + r.offsetF1, 0) / n,
        coverage: scored.reduce((s, r) => s + r.coverage, 0) / n,
      };
    });
  }, [rows]);

  const songsWithRef = rows.filter((r) => r.refCount > 0).length;

  return (
    <div className="rounded-lg border border-violet-400/20 bg-violet-500/[0.04] p-4 mt-6">
      <div className="flex items-center justify-between mb-3 gap-3">
        <div>
          <h3 className="text-sm font-semibold text-violet-200">
            Span algorithms <span className="text-[10px] uppercase tracking-wider text-slate-500 ml-1">· experimental</span>
            <InfoDot className="ml-1.5" label="How span algorithms are scored" align="left">
              Evaluated against the first span layer in each song's annotation document.
            </InfoDot>
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {audioFiles.length === 0
              ? 'No songs loaded.'
              : `${songsWithRef}/${audioFiles.length} song${audioFiles.length === 1 ? '' : 's'} have a span reference.`}
          </p>
        </div>
        {loading && <span className="text-[11px] text-slate-500">Loading…</span>}
      </div>

      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 border-b border-white/[0.06]">
            <th className="py-1.5 pr-3">Algorithm</th>
            <th className="py-1.5 pr-3">Songs</th>
            <th className="py-1.5 pr-3">IoU</th>
            <th className="py-1.5 pr-3">Frame F1</th>
            <th className="py-1.5 pr-3">Onset F1</th>
            <th className="py-1.5 pr-3">Offset F1</th>
            <th className="py-1.5">Coverage</th>
          </tr>
        </thead>
        <tbody>
          {aggregates.map((a) => (
            <tr key={a.algo} className="border-b border-white/[0.04]">
              <td className="py-1.5 pr-3 font-mono text-slate-200">{a.label}</td>
              <td className="py-1.5 pr-3 text-slate-400">{a.songs} / {audioFiles.length}</td>
              <td className="py-1.5 pr-3 text-slate-200">{a.songs > 0 ? a.iou.toFixed(2)      : '—'}</td>
              <td className="py-1.5 pr-3 text-slate-200">{a.songs > 0 ? a.frameF1.toFixed(2)  : '—'}</td>
              <td className="py-1.5 pr-3 text-slate-200">{a.songs > 0 ? a.onsetF1.toFixed(2)  : '—'}</td>
              <td className="py-1.5 pr-3 text-slate-200">{a.songs > 0 ? a.offsetF1.toFixed(2) : '—'}</td>
              <td className="py-1.5 text-slate-200">{a.songs > 0 ? a.coverage.toFixed(2) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {songsWithRef === 0 && audioFiles.length > 0 && (
        <p className="text-[11px] text-amber-300/70 mt-3">
          No span reference annotations on disk yet. Open the Span tab in any song's annotation
          panel and add at least one span — the columns above will populate on the next refresh.
        </p>
      )}
    </div>
  );
}
