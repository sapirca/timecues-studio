// LYRICS-family eval table for the all-songs view. Renders when
// `experimentalLyricsFamily` is on. Mirrors GlobalEvalSpanTable but the
// reference comes from the first non-empty lyrics layer (loaded via
// /api/annotation-layers/<slug>) and the prediction is the cached lyrics
// sidecar result at /api/lyrics/detect/<slug>/<algo>.
//
// Whisper-base ships today; SOFA / ctc-forced-aligner slots in here as a
// second column once added — both expose the same words+lines envelope.
//
// Songs without a lyrics reference layer show '—' across the eval columns
// (precision/recall undefined without ref). WER and word-onset F1 only
// fire when the reference layer has `kind: 'word'` items.

import { useEffect, useMemo, useState } from 'react';
import { loadCachedLyrics, runLyricsDetection, type LyricsDetectionResult } from '../../services/lyricsDetection';
import { loadLyricsText } from '../../services/lyricsText';
import { loadLayers } from '../../services/annotationLayers';
import { evaluateLyrics, type LyricsEvalResult } from '../../utils/evaluation';
import type { LyricsItem, AnnotationLayer } from '../../types/annotationLayer';

export interface LyricsEvalAudioEntry {
  id: string;
  name: string;
}

interface PerSongRow {
  songId: string;
  songName: string;
  refCount: number;
  refWordCount: number;
  results: Record<string, LyricsEvalResult | null>;
}

interface AlgoAggregate {
  algo: string;
  label: string;
  songs: number;
  wer: number;
  wordOnsetF1: number;
  lineIoU: number;
  lineOnsetF1: number;
}

const LYRICS_ALGO_IDS = ['whisper-base', 'ctc-forced-aligner'] as const;
const LYRICS_LABELS: Record<string, string> = {
  'whisper-base':       'Whisper-base',
  'ctc-forced-aligner': 'CTC forced aligner',
};

function pickLyricsReference(layers: AnnotationLayer[]): LyricsItem[] {
  for (const l of layers) {
    if (l.type !== 'lyrics') continue;
    const items = l.items as unknown as LyricsItem[];
    if (items.length > 0) return items;
  }
  return [];
}

async function loadPredictedLyrics(slug: string, algo: string): Promise<LyricsDetectionResult | null> {
  const cached = await loadCachedLyrics(slug, algo);
  if (cached && cached.ok !== false) return cached;
  // ctc-forced-aligner needs the per-song reference text; whisper-base ignores it.
  const opts: { text?: string } = {};
  if (algo === 'ctc-forced-aligner') {
    const text = await loadLyricsText(slug);
    if (!text || !text.trim()) return null;
    opts.text = text;
  }
  return runLyricsDetection(slug, algo, opts);
}

function predsToLyricsItems(pred: LyricsDetectionResult): LyricsItem[] {
  const out: LyricsItem[] = [];
  for (let i = 0; i < pred.words.length; i++) {
    const w = pred.words[i];
    out.push({ id: `${pred.algorithm}:w${i}`, time: w.time, text: w.text, kind: 'word' });
  }
  for (let i = 0; i < pred.lines.length; i++) {
    const l = pred.lines[i];
    out.push({ id: `${pred.algorithm}:l${i}`, time: l.time, end: l.end, text: l.text, kind: 'line' });
  }
  return out;
}

export function GlobalEvalLyricsTable({
  audioFiles,
  trackDurationFallback = 180,
}: {
  audioFiles: LyricsEvalAudioEntry[];
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
        const ref = pickLyricsReference(doc.layers);
        const refWordCount = ref.filter((l) => l.kind === 'word').length;
        const results: Record<string, LyricsEvalResult | null> = {};
        for (const algo of LYRICS_ALGO_IDS) {
          const pred = await loadPredictedLyrics(a.id, algo);
          if (!pred || pred.ok === false || ref.length === 0) {
            results[algo] = null;
            continue;
          }
          const duration = pred.duration || trackDurationFallback;
          results[algo] = evaluateLyrics(ref, predsToLyricsItems(pred), duration);
        }
        return { songId: a.id, songName: a.name, refCount: ref.length, refWordCount, results };
      }));
      if (!cancelled) {
        setRows(out);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [audioFiles, trackDurationFallback]);

  const aggregates = useMemo<AlgoAggregate[]>(() => {
    return LYRICS_ALGO_IDS.map((algo) => {
      const scored = rows
        .map((r) => r.results[algo])
        .filter((r): r is LyricsEvalResult => r !== null);
      const wordSongs = scored.filter((r) => r.refWordCount > 0);
      const nWord = wordSongs.length || 1;
      const n = scored.length || 1;
      return {
        algo,
        label: LYRICS_LABELS[algo],
        songs: scored.length,
        wer:         wordSongs.reduce((s, r) => s + r.wer,         0) / nWord,
        wordOnsetF1: wordSongs.reduce((s, r) => s + r.wordOnsetF1, 0) / nWord,
        lineIoU:     scored.reduce((s, r) => s + r.meanIoU, 0) / n,
        lineOnsetF1: scored.reduce((s, r) => s + r.onsetF1, 0) / n,
      };
    });
  }, [rows]);

  const songsWithRef = rows.filter((r) => r.refCount > 0).length;
  const songsWithWordRef = rows.filter((r) => r.refWordCount > 0).length;

  return (
    <div className="rounded-lg border border-violet-400/20 bg-violet-500/[0.04] p-4 mt-6">
      <div className="flex items-center justify-between mb-3 gap-3">
        <div>
          <h3 className="text-sm font-semibold text-violet-200">
            Lyrics algorithms <span className="text-[10px] uppercase tracking-wider text-slate-500 ml-1">· experimental</span>
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Evaluated against the first lyrics layer in each song's annotation document.{' '}
            {audioFiles.length === 0
              ? 'No songs loaded.'
              : `${songsWithRef}/${audioFiles.length} with a lyrics layer · ${songsWithWordRef} with word-level reference (drives WER + word onset F1).`}
          </p>
        </div>
        {loading && <span className="text-[11px] text-slate-500">Loading…</span>}
      </div>

      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 border-b border-white/[0.06]">
            <th className="py-1.5 pr-3">Algorithm</th>
            <th className="py-1.5 pr-3">Songs</th>
            <th className="py-1.5 pr-3">WER</th>
            <th className="py-1.5 pr-3">Word onset F1</th>
            <th className="py-1.5 pr-3">Line IoU</th>
            <th className="py-1.5">Line onset F1</th>
          </tr>
        </thead>
        <tbody>
          {aggregates.map((a) => (
            <tr key={a.algo} className="border-b border-white/[0.04]">
              <td className="py-1.5 pr-3 font-mono text-slate-200">{a.label}</td>
              <td className="py-1.5 pr-3 text-slate-400">{a.songs} / {audioFiles.length}</td>
              <td className="py-1.5 pr-3 text-slate-200">{songsWithWordRef > 0 ? a.wer.toFixed(2)         : '—'}</td>
              <td className="py-1.5 pr-3 text-slate-200">{songsWithWordRef > 0 ? a.wordOnsetF1.toFixed(2) : '—'}</td>
              <td className="py-1.5 pr-3 text-slate-200">{a.songs > 0          ? a.lineIoU.toFixed(2)     : '—'}</td>
              <td className="py-1.5 text-slate-200">{a.songs > 0               ? a.lineOnsetF1.toFixed(2) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {songsWithRef === 0 && audioFiles.length > 0 && (
        <p className="text-[11px] text-amber-300/70 mt-3">
          No lyrics reference annotations on disk yet. Open the Lyrics tab in any song's annotation
          panel and add at least one word or line — the columns above will populate on the next refresh.
        </p>
      )}
    </div>
  );
}
