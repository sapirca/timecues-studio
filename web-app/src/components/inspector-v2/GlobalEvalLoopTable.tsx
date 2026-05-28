// LOOP-family eval table for the all-songs view. Sibling to
// GlobalEvalSpanTable — appears below it when `experimentalLoopFamily`
// is on. Compares each LOOP detector's per-song output (cached at
// /api/loop/detect/<slug>/<algo>) against the user's first loop
// reference layer; songs without a loop layer show '—'.

import { useEffect, useMemo, useState } from 'react';
import { loadCachedLoop, runLoopDetection, type LoopDetectionResult } from '../../services/loopDetection';
import { loadLayers } from '../../services/annotationLayers';
import { evaluateLoops, effectiveLayerMode, type LoopEvalResult } from '../../utils/evaluation';
import type { LoopItem, AnnotationLayer, LayerEvalMode } from '../../types/annotationLayer';
import { useSettings } from '../../context/SettingsContext';

export interface LoopEvalAudioEntry {
  id: string;
  name: string;
}

interface PerSongRow {
  songId: string;
  songName: string;
  refCount: number;
  results: Record<string, LoopEvalResult | null>;
}

interface AlgoAggregate {
  algo: string;
  label: string;
  songs: number;
  iou: number;
  frameF1: number;
  onsetF1: number;
  offsetF1: number;
  coverage: number;
}

const LOOP_ALGO_IDS = ['chroma-autocorr'] as const;
const LOOP_LABELS: Record<string, string> = {
  'chroma-autocorr': 'Chroma autocorr',
};

function pickLoopReference(
  layers: AnnotationLayer[],
): { items: LoopItem[]; mode: LayerEvalMode } {
  for (const l of layers) {
    if (l.type !== 'loops') continue;
    const items = l.items as unknown as LoopItem[];
    if (items.length > 0) return { items, mode: l.mode ?? 'full-annotation' };
  }
  return { items: [], mode: 'full-annotation' };
}

async function loadPredictedLoops(slug: string, algo: string, force: boolean): Promise<LoopDetectionResult | null> {
  if (!force) {
    const cached = await loadCachedLoop(slug, algo);
    if (cached && cached.ok !== false) return cached;
  }
  return runLoopDetection(slug, algo, force);
}

function predsToLoopItems(pred: LoopDetectionResult): LoopItem[] {
  return pred.loops.map((l, i) => ({
    id: `${pred.algorithm}:${i}`,
    start: l.start,
    end: l.end,
    label: l.label,
    bars: l.bars ?? undefined,
  }));
}

export function GlobalEvalLoopTable({
  audioFiles,
  trackDurationFallback = 180,
}: {
  audioFiles: LoopEvalAudioEntry[];
  trackDurationFallback?: number;
}) {
  const [rows, setRows] = useState<PerSongRow[]>([]);
  const [loading, setLoading] = useState(false);
  const { settings } = useSettings();
  const forceCandidates = settings.evalRegionLayersAsCandidates;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (audioFiles.length === 0) { setRows([]); return; }
      setLoading(true);
      const out: PerSongRow[] = await Promise.all(audioFiles.map(async (a) => {
        const doc = await loadLayers(a.id);
        const { items: ref, mode } = pickLoopReference(doc.layers);
        const results: Record<string, LoopEvalResult | null> = {};
        for (const algo of LOOP_ALGO_IDS) {
          const pred = await loadPredictedLoops(a.id, algo, false);
          if (!pred || pred.ok === false) { results[algo] = null; continue; }
          if (ref.length === 0) { results[algo] = null; continue; }
          const duration = pred.duration || trackDurationFallback;
          results[algo] = evaluateLoops(ref, predsToLoopItems(pred), duration, {
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
    return LOOP_ALGO_IDS.map((algo) => {
      const scored = rows
        .map((r) => r.results[algo])
        .filter((r): r is LoopEvalResult => r !== null);
      const n = scored.length || 1;
      return {
        algo,
        label: LOOP_LABELS[algo],
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
    <div className="rounded-lg border border-fuchsia-400/20 bg-fuchsia-500/[0.04] p-4 mt-6">
      <div className="flex items-center justify-between mb-3 gap-3">
        <div>
          <h3 className="text-sm font-semibold text-fuchsia-200">
            Loop algorithms <span className="text-[10px] uppercase tracking-wider text-slate-500 ml-1">· experimental</span>
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Evaluated against the first loop layer in each song's annotation document.{' '}
            {audioFiles.length === 0
              ? 'No songs loaded.'
              : `${songsWithRef}/${audioFiles.length} song${audioFiles.length === 1 ? '' : 's'} have a loop reference.`}
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
          No loop reference annotations on disk yet. Open the Loops tab in any song's annotation
          panel and add at least one loop — the columns above will populate on the next refresh.
        </p>
      )}
    </div>
  );
}
