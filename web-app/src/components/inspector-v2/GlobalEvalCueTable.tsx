// CUE-family eval table for the all-songs view. Mirrors the SPAN/LOOP/
// PATTERN/LYRICS tables but the prediction side is heterogeneous: cue-
// emitting algorithms live across five different sidecars (beatnet,
// pitch, cue-extras, span — for HPSS onsets). Each algorithm's
// detection result is projected to `{ time, label }[]` before being
// scored via `evaluateCueLayer` at a kind-specific tolerance.
//
// Reference: first non-empty `cues` layer in the song's annotation
// document (loaded via /api/annotation-layers/<slug>). Songs without a
// cue layer show '—' across the eval columns.

import { useEffect, useMemo, useState } from 'react';
import { loadCachedBeatnet } from '../../services/beatnetDetection';
import { loadCachedPitch } from '../../services/pitchDetection';
import { loadCachedCueExtras } from '../../services/cueExtrasDetection';
import { loadLayers } from '../../services/annotationLayers';
import { evaluateCueLayer, type AlgoEvalResult } from '../../utils/evaluation';
import type { CueItem, AnnotationLayer } from '../../types/annotationLayer';

export interface CueEvalAudioEntry {
  id: string;
  name: string;
}

interface PerSongRow {
  songId: string;
  songName: string;
  refCount: number;
  results: Record<string, AlgoEvalResult | null>;
}

interface AlgoAggregate {
  algo: string;
  label: string;
  songs: number;
  precision: number;
  recall: number;
  f1: number;
  mnbd: number;
}

// (algorithm id, display label, per-kind point-tolerance in seconds).
// Tolerance reflects the perceptual event each algorithm reports — beat
// onsets cluster tighter than chord changes, which is why basic-pitch /
// librosa-onsets get 50 ms while chord/key changes get 250 ms.
const CUE_ALGOS: Array<{ id: string; label: string; tol: number }> = [
  { id: 'beatnet-downbeats', label: 'BeatNet downbeats',  tol: 0.10 },
  { id: 'basic-pitch',       label: 'basic-pitch onsets', tol: 0.05 },
  { id: 'librosa-key',       label: 'librosa key changes', tol: 0.25 },
  { id: 'autochord-chords',  label: 'autochord chord changes', tol: 0.25 },
  { id: 'librosa-onsets',    label: 'librosa onsets',     tol: 0.05 },
];

function pickCueReference(layers: AnnotationLayer[]): CueItem[] {
  for (const l of layers) {
    if (l.type !== 'cues') continue;
    const items = l.items as unknown as CueItem[];
    if (items.length > 0) return items;
  }
  return [];
}

async function fetchPredictedCues(slug: string, algoId: string): Promise<CueItem[] | null> {
  if (algoId === 'beatnet-downbeats') {
    const beat = await loadCachedBeatnet(slug);
    if (!beat || !beat.result.ok || !beat.result.downbeats) return null;
    return beat.result.downbeats.map((t, i) => ({
      id: `beatnet:db:${i}`, time: t, label: 'downbeat',
    }));
  }
  if (algoId === 'basic-pitch') {
    const pitch = await loadCachedPitch(slug, 'basic-pitch');
    if (!pitch || pitch.ok === false) return null;
    return pitch.notes.map((n, i) => ({
      id: `basic-pitch:${i}`, time: n.time, label: n.pitch,
    }));
  }
  if (algoId === 'librosa-key' || algoId === 'autochord-chords' || algoId === 'librosa-onsets') {
    const extras = await loadCachedCueExtras(slug, algoId);
    if (!extras || extras.ok === false) return null;
    return extras.cues.map((c, i) => ({
      id: `${algoId}:${i}`, time: c.time, label: c.label,
    }));
  }
  return null;
}

export function GlobalEvalCueTable({
  audioFiles,
  trackDurationFallback = 180,
}: {
  audioFiles: CueEvalAudioEntry[];
  trackDurationFallback?: number;
}) {
  const [rows, setRows] = useState<PerSongRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (audioFiles.length === 0) { setRows([]); return; }
      setLoading(true);
      const out: PerSongRow[] = await Promise.all(audioFiles.map(async (a) => {
        const doc = await loadLayers(a.id);
        const ref = pickCueReference(doc.layers);
        const results: Record<string, AlgoEvalResult | null> = {};
        for (const { id, tol } of CUE_ALGOS) {
          const pred = await fetchPredictedCues(a.id, id);
          if (!pred || ref.length === 0) { results[id] = null; continue; }
          results[id] = evaluateCueLayer(ref, pred, trackDurationFallback, tol);
        }
        return { songId: a.id, songName: a.name, refCount: ref.length, results };
      }));
      if (!cancelled) {
        setRows(out);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [audioFiles, trackDurationFallback]);

  const aggregates = useMemo<AlgoAggregate[]>(() => {
    return CUE_ALGOS.map(({ id, label }) => {
      const scored = rows
        .map((r) => r.results[id])
        .filter((r): r is AlgoEvalResult => r !== null);
      const n = scored.length || 1;
      return {
        algo: id,
        label,
        songs:     scored.length,
        precision: scored.reduce((s, r) => s + r.precision, 0) / n,
        recall:    scored.reduce((s, r) => s + r.recall,    0) / n,
        f1:        scored.reduce((s, r) => s + r.f1,        0) / n,
        mnbd:      scored.reduce((s, r) => s + r.mnbd,      0) / n,
      };
    });
  }, [rows]);

  const songsWithRef = rows.filter((r) => r.refCount > 0).length;

  return (
    <div className="rounded-lg border border-amber-400/20 bg-amber-500/[0.04] p-4 mt-6">
      <div className="flex items-center justify-between mb-3 gap-3">
        <div>
          <h3 className="text-sm font-semibold text-amber-200">
            Cue algorithms <span className="text-[10px] uppercase tracking-wider text-slate-500 ml-1">· experimental</span>
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Evaluated against the first cue layer in each song's annotation document.{' '}
            {audioFiles.length === 0
              ? 'No songs loaded.'
              : `${songsWithRef}/${audioFiles.length} song${audioFiles.length === 1 ? '' : 's'} have a cue reference.`}
          </p>
        </div>
        {loading && <span className="text-[11px] text-slate-500">Loading…</span>}
      </div>

      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 border-b border-white/[0.06]">
            <th className="py-1.5 pr-3">Algorithm</th>
            <th className="py-1.5 pr-3">Songs</th>
            <th className="py-1.5 pr-3" title="Per-kind tolerance window">τ</th>
            <th className="py-1.5 pr-3">Precision</th>
            <th className="py-1.5 pr-3">Recall</th>
            <th className="py-1.5 pr-3">F1</th>
            <th className="py-1.5" title="Mean nearest-cue distance (s)">MNBD</th>
          </tr>
        </thead>
        <tbody>
          {aggregates.map((a, i) => (
            <tr key={a.algo} className="border-b border-white/[0.04]">
              <td className="py-1.5 pr-3 font-mono text-slate-200">{a.label}</td>
              <td className="py-1.5 pr-3 text-slate-400">{a.songs} / {audioFiles.length}</td>
              <td className="py-1.5 pr-3 text-slate-500 font-mono">{CUE_ALGOS[i].tol.toFixed(2)}s</td>
              <td className="py-1.5 pr-3 text-slate-200">{a.songs > 0 ? a.precision.toFixed(2) : '—'}</td>
              <td className="py-1.5 pr-3 text-slate-200">{a.songs > 0 ? a.recall.toFixed(2)    : '—'}</td>
              <td className="py-1.5 pr-3 text-slate-200">{a.songs > 0 ? a.f1.toFixed(2)        : '—'}</td>
              <td className="py-1.5 text-slate-200">{a.songs > 0 ? a.mnbd.toFixed(2)           : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {songsWithRef === 0 && audioFiles.length > 0 && (
        <p className="text-[11px] text-amber-300/70 mt-3">
          No cue reference annotations on disk yet. Open the Cues tab in any song's annotation
          panel and add at least one cue — the columns above will populate on the next refresh.
        </p>
      )}
    </div>
  );
}
