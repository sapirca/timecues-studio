// PATTERN-family eval table for the all-songs view. Sibling to
// GlobalEvalLoopTable — appears below it when `experimentalPatternFamily`
// is on. Two columns of information per detector:
//   • Aggregate stats (always shown when predictions exist) — songs with
//     a cached prediction, mean motif count, mean occurrence count.
//   • Eval metrics against the first `patterns` reference layer in each
//     song's annotation document (IoU / frame-F1 / on-off F1 / coverage).
//     Songs without a pattern reference are excluded from the eval columns.

import { useEffect, useMemo, useState } from 'react';
import { loadCachedPattern, runPatternDetection, type PatternDetectionResult } from '../../services/patternDetection';
import { loadLayers } from '../../services/annotationLayers';
import { evaluatePatterns, effectiveLayerMode, type PatternEvalResult } from '../../utils/evaluation';
import type { PatternItem, AnnotationLayer, LayerEvalMode } from '../../types/annotationLayer';
import { useSettings } from '../../context/SettingsContext';

export interface PatternEvalAudioEntry {
  id: string;
  name: string;
}

interface PerSongRow {
  songId: string;
  songName: string;
  refCount: number;
  pred: PatternDetectionResult | null;
  results: Record<string, PatternEvalResult | null>;
}

interface AlgoAggregate {
  algo: string;
  label: string;
  songsWithPred: number;
  meanMotifs: number;
  meanOccurrences: number;
  songsScored: number;
  iou: number;
  frameF1: number;
  onsetF1: number;
  offsetF1: number;
  coverage: number;
}

const PATTERN_ALGO_IDS = ['locomotif'] as const;
const PATTERN_LABELS: Record<string, string> = {
  'locomotif': 'LoCoMotif',
};

function pickPatternReference(
  layers: AnnotationLayer[],
): { items: PatternItem[]; mode: LayerEvalMode } {
  for (const l of layers) {
    if (l.type !== 'patterns') continue;
    const items = l.items as unknown as PatternItem[];
    if (items.length > 0) return { items, mode: l.mode ?? 'full-annotation' };
  }
  return { items: [], mode: 'full-annotation' };
}

async function loadPredictedPatterns(slug: string, algo: string, force: boolean): Promise<PatternDetectionResult | null> {
  if (!force) {
    const cached = await loadCachedPattern(slug, algo);
    if (cached && cached.ok !== false) return cached;
  }
  return runPatternDetection(slug, algo, force);
}

function predsToPatternItems(pred: PatternDetectionResult): PatternItem[] {
  // LoCoMotif occurrences are not evenly spaced — project each to its own
  // PatternItem with repeatCount=1 so the eval logic (which inherits the
  // span shape) sees one interval per occurrence.
  return pred.patterns.map((p, i) => ({
    id: `${pred.algorithm}:${p.motif_id}:${i}`,
    start: p.start,
    end: p.end,
    label: p.label,
    repeatCount: 1,
    highlightedBeats: [],
  }));
}

function countMotifs(pred: PatternDetectionResult): number {
  return new Set(pred.patterns.map((p) => p.motif_id)).size;
}

export function GlobalEvalPatternTable({
  audioFiles,
  trackDurationFallback = 180,
}: {
  audioFiles: PatternEvalAudioEntry[];
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
        const { items: ref, mode } = pickPatternReference(doc.layers);
        const results: Record<string, PatternEvalResult | null> = {};
        let firstPred: PatternDetectionResult | null = null;
        for (const algo of PATTERN_ALGO_IDS) {
          const pred = await loadPredictedPatterns(a.id, algo, false);
          if (!firstPred) firstPred = pred;
          if (!pred || pred.ok === false) { results[algo] = null; continue; }
          if (ref.length === 0) { results[algo] = null; continue; }
          const duration = pred.duration || trackDurationFallback;
          results[algo] = evaluatePatterns(ref, predsToPatternItems(pred), duration, {
            mode: effectiveLayerMode(mode, forceCandidates),
          });
        }
        return { songId: a.id, songName: a.name, refCount: ref.length, pred: firstPred, results };
      }));
      if (!cancelled) {
        setRows(out);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [audioFiles, trackDurationFallback, forceCandidates]);

  const aggregates = useMemo<AlgoAggregate[]>(() => {
    return PATTERN_ALGO_IDS.map((algo) => {
      const preds = rows
        .map((r) => r.pred)
        .filter((p): p is PatternDetectionResult => p !== null && p.ok !== false && p.patterns.length > 0);
      const predN = preds.length || 1;
      const meanMotifs = preds.reduce((s, p) => s + countMotifs(p), 0) / predN;
      const meanOccs   = preds.reduce((s, p) => s + p.patterns.length, 0) / predN;
      const scored = rows
        .map((r) => r.results[algo])
        .filter((r): r is PatternEvalResult => r !== null);
      const n = scored.length || 1;
      return {
        algo,
        label: PATTERN_LABELS[algo],
        songsWithPred: preds.length,
        meanMotifs,
        meanOccurrences: meanOccs,
        songsScored: scored.length,
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
    <div className="rounded-lg border border-emerald-400/20 bg-emerald-500/[0.04] p-4 mt-6">
      <div className="flex items-center justify-between mb-3 gap-3">
        <div>
          <h3 className="text-sm font-semibold text-emerald-200">
            Pattern algorithms <span className="text-[10px] uppercase tracking-wider text-slate-500 ml-1">· experimental</span>
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Aggregate stats over all cached pattern detections, plus eval against the first pattern layer in each song's
            annotation document.{' '}
            {audioFiles.length === 0
              ? 'No songs loaded.'
              : `${songsWithRef}/${audioFiles.length} song${audioFiles.length === 1 ? '' : 's'} have a pattern reference.`}
          </p>
        </div>
        {loading && <span className="text-[11px] text-slate-500">Loading…</span>}
      </div>

      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 border-b border-white/[0.06]">
            <th className="py-1.5 pr-3">Algorithm</th>
            <th className="py-1.5 pr-3">Songs w/ pred</th>
            <th className="py-1.5 pr-3" title="Mean number of distinct motifs across songs with cached predictions">Motifs / song</th>
            <th className="py-1.5 pr-3" title="Mean number of motif occurrences (across all motifs) per song">Occurrences / song</th>
            <th className="py-1.5 pr-3 border-l border-white/[0.06] pl-3">Scored</th>
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
              <td className="py-1.5 pr-3 text-slate-200">{a.songsWithPred} / {audioFiles.length}</td>
              <td className="py-1.5 pr-3 text-slate-200">{a.songsWithPred > 0 ? a.meanMotifs.toFixed(1) : '—'}</td>
              <td className="py-1.5 pr-3 text-slate-200">{a.songsWithPred > 0 ? a.meanOccurrences.toFixed(1) : '—'}</td>
              <td className="py-1.5 pr-3 text-slate-400 border-l border-white/[0.06] pl-3">{a.songsScored} / {audioFiles.length}</td>
              <td className="py-1.5 pr-3 text-slate-200">{a.songsScored > 0 ? a.iou.toFixed(2)      : '—'}</td>
              <td className="py-1.5 pr-3 text-slate-200">{a.songsScored > 0 ? a.frameF1.toFixed(2)  : '—'}</td>
              <td className="py-1.5 pr-3 text-slate-200">{a.songsScored > 0 ? a.onsetF1.toFixed(2)  : '—'}</td>
              <td className="py-1.5 pr-3 text-slate-200">{a.songsScored > 0 ? a.offsetF1.toFixed(2) : '—'}</td>
              <td className="py-1.5 text-slate-200">{a.songsScored > 0 ? a.coverage.toFixed(2) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {aggregates.every((a) => a.songsWithPred === 0) && audioFiles.length > 0 && (
        <p className="text-[11px] text-amber-300/70 mt-3">
          No cached pattern detections yet. Tick LoCoMotif in the run-options sidebar and click Run on a song,
          or use Dataset Prep → ⚙ Batch algorithm options → Run on all songs.
        </p>
      )}

      {songsWithRef === 0 && audioFiles.length > 0 && (
        <p className="text-[11px] text-slate-500 mt-2">
          No pattern reference annotations on disk yet — eval columns stay "—" until at least one song has
          a manually-annotated <code className="font-mono text-slate-400">patterns</code> layer with one or more items.
        </p>
      )}
    </div>
  );
}
