/**
 * LyricsRangeRerunPanel — re-transcribe ONE window of a song and write the
 * result over whatever the full run heard there.
 *
 * A whole-song transcription is a single take. Where it mis-hears a line, or
 * skips one entirely (Whisper goes quiet over a dense mix far more often than
 * over an isolated vocal), the only repair the app offered was running the
 * whole song again on a different stem — which throws away every line the
 * first take got right. This panel narrows both ends of that: the window, and
 * the stem it is read from.
 *
 * The window is the highlighted region, not a pair of typed numbers. The
 * annotator who wants to repair a line is already looking at it on the
 * timeline, and a second, independently-editable copy of those two times was
 * only ever a way to re-run the wrong stretch of audio. No highlight ⇒ this
 * panel doesn't render at all (see its call site); move the highlight and the
 * window moves with it.
 *
 * The re-run itself writes nothing. It comes back as a list of words the
 * annotator reads, edits and prunes before choosing where it lands — the
 * detector's cached result, or a lyrics layer they are editing. Either way the
 * write replaces the window and leaves the rest of the take alone.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatClockTime } from '../../utils/clockTime';
import {
  mergeLyricsWindow,
  runLyricsRangeDetection,
  type LyricsRangeResult,
} from '../../services/lyricsDetection';
import { InfoDot } from './InfoDot';

/** The two LYRICS detectors, in the order the curated generator prefers them.
 *  Kept local: this panel drives them directly rather than through the
 *  whole-song tool registry. */
const ALGOS = [
  { id: 'whisper-base', label: 'Whisper base' },
  { id: 'ctc-forced-aligner', label: 'CTC forced aligner' },
] as const;
type AlgoId = typeof ALGOS[number]['id'];

export interface LyricsMergeTarget {
  id: string;
  name: string;
}

export interface RangeWord {
  time: number;
  end: number;
  text: string;
}

export interface LyricsRangeRerunPanelProps {
  slug: string;
  /** The highlighted region — the window this panel re-reads. Required: with
   *  nothing highlighted there is no window, and the call site renders nothing. */
  selection: { start: number; end: number };
  /** Stems Demucs has actually separated for this song. 'mix' is prepended. */
  stems: readonly string[];
  /** Whisper language hint, shared with the family's own language picker so the
   *  window is read the same way the whole-song run would read it. '' ⇒ auto. */
  language?: string;
  /** Lyrics layers the merge can land in, on top of the detector cache.
   *  Empty ⇒ only the cache target renders. */
  layerTargets?: LyricsMergeTarget[];
  /** Write `words` over [start, end) of one lyrics layer. */
  onMergeIntoLayer?: (layerId: string, start: number, end: number, words: RangeWord[]) => void;
  /** Re-read the detector's cached result after a cache merge, so the algo row
   *  and its lane show the repaired window without a song reload. */
  onCacheMerged?: (algo: string, stem: string) => void;
  onSeek?: (t: number) => void;
}

type Draft = RangeWord & { id: string; keep: boolean };

const num = (v: string, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export function LyricsRangeRerunPanel({
  slug, selection, stems, language = '',
  layerTargets = [], onMergeIntoLayer, onCacheMerged, onSeek,
}: LyricsRangeRerunPanelProps) {
  const { start, end } = selection;
  const [algo, setAlgo] = useState<AlgoId>('whisper-base');
  const [stem, setStem] = useState('vocals');
  const [pad, setPad] = useState(1);
  const [text, setText] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LyricsRangeResult | null>(null);
  const [draft, setDraft] = useState<Draft[]>([]);
  const [target, setTarget] = useState<string>('cache');
  const [merging, setMerging] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const stemOptions = useMemo(
    () => ['mix', ...stems.filter((s) => s !== 'mix')],
    [stems],
  );
  // Vocals is the right default — reading the isolated vocal is the whole
  // reason to re-run a window — but the stem manifest arrives after this panel
  // mounts, so on first render the only option is the mix. Keep claiming
  // vocals until the user picks a stem themselves, then leave their choice
  // alone; and never sit on a stem this song doesn't have.
  const [stemChosen, setStemChosen] = useState(false);
  useEffect(() => {
    if (stemChosen) {
      if (!stemOptions.includes(stem)) setStem('mix');
      return;
    }
    const want = stemOptions.includes('vocals') ? 'vocals' : 'mix';
    if (stem !== want) setStem(want);
  }, [stemOptions, stem, stemChosen]);

  // A result belongs to the window it was heard in. Move the highlight and it
  // stops describing anything on screen — and the merge, which writes over
  // whatever the window is *now*, would put the old words over new audio.
  useEffect(() => {
    setResult(null);
    setDraft([]);
    setError(null);
    setNote(null);
  }, [start, end]);

  const length = end - start;
  const windowOk = length >= 0.25;

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    setNote(null);
    try {
      const res = await runLyricsRangeDetection(slug, algo, start, end, {
        stem,
        pad,
        ...(language.trim() ? { language: language.trim() } : {}),
        ...(algo === 'ctc-forced-aligner' && text.trim() ? { text: text.trim() } : {}),
      });
      setResult(res);
      setDraft((res.words ?? []).map((w, i) => ({
        id: `${i}:${w.time}`, time: w.time, end: w.end, text: w.text, keep: true,
      })));
    } catch (e) {
      setResult(null);
      setDraft([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [slug, algo, start, end, stem, pad, language, text]);

  const kept = useMemo(
    () => draft.filter((w) => w.keep && w.text.trim())
      .map(({ time, end: e, text: t }) => ({ time, end: e, text: t.trim() })),
    [draft],
  );

  const write = useCallback(async (words: RangeWord[]) => {
    setMerging(true);
    setError(null);
    setNote(null);
    try {
      if (target === 'cache') {
        const merged = await mergeLyricsWindow(slug, algo, start, end, words, { stem });
        onCacheMerged?.(algo, stem);
        setNote(
          `${merged.added} word${merged.added === 1 ? '' : 's'} written over `
          + `${merged.removed} in ${algo}${stem === 'mix' ? '' : ` · ${stem}`}.`,
        );
      } else {
        onMergeIntoLayer?.(target, start, end, words);
        const name = layerTargets.find((l) => l.id === target)?.name ?? 'layer';
        setNote(`${words.length} word${words.length === 1 ? '' : 's'} written into "${name}".`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMerging(false);
    }
  }, [target, slug, algo, start, end, stem, onCacheMerged, onMergeIntoLayer, layerTargets]);

  const fieldCls = 'bg-[#0c0d12] border border-white/[0.08] rounded px-1.5 py-0.5 text-[11px] text-slate-200 focus:outline-none focus:border-fuchsia-400/40';

  return (
    <div className="rounded-lg border border-fuchsia-400/20 bg-fuchsia-500/[0.04] p-3 mt-3 space-y-2">
      <h3 className="text-[12px] font-semibold text-fuchsia-200">
        Re-transcribe this section
        <InfoDot className="ml-1.5" label="What a section re-run does" align="left">
          Transcribes only the highlighted region, on the stem you pick, and writes
          the words over that stretch of an existing result. The rest of the take is
          left alone — this is for the line a whole-song run mis-heard or skipped.
          Move or resize the highlight to change the window.
        </InfoDot>
      </h3>

      {/* ── The window, as highlighted ─────────────────────────────────── */}
      <div className="flex items-baseline flex-wrap gap-x-2 text-[11px]">
        <span className="font-mono text-slate-300">
          {formatClockTime(start, 1)} – {formatClockTime(end, 1)}
        </span>
        <span className={windowOk ? 'text-slate-500' : 'text-amber-400'}>
          {length > 0 ? `${length.toFixed(2)}s` : 'empty'}
        </span>
      </div>
      {!windowOk && (
        <div className="text-[10px] leading-snug text-amber-400/90">
          Too short to transcribe — widen the highlighted region.
        </div>
      )}

      {/* ── What reads it ──────────────────────────────────────────────
           One labelled row each, matching the family's own "Whisper language"
           row above: the sidebar is 256 px wide, and a single inline row of
           select · select · number clips the stem name against its own
           dropdown arrow. */}
      <div className="space-y-1.5 text-[11px] text-slate-500">
        <label className="flex items-center gap-1.5">
          <span className="w-9 shrink-0">Read</span>
          <select
            value={algo}
            onChange={(e) => setAlgo(e.target.value as AlgoId)}
            className={`${fieldCls} flex-1 min-w-0 font-mono`}
          >
            {ALGOS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="w-9 shrink-0">Stem</span>
          <select
            value={stem}
            onChange={(e) => { setStemChosen(true); setStem(e.target.value); }}
            className={`${fieldCls} flex-1 min-w-0 font-mono`}
          >
            {stemOptions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5" title="Seconds of surrounding audio the model hears for context. Words outside the window are discarded — this only stops the first and last word being clipped mid-syllable.">
          <span className="w-9 shrink-0">Pad</span>
          <input
            type="number" step="0.5" min="0" value={pad}
            onChange={(e) => setPad(Math.max(0, num(e.target.value, pad)))}
            className={`${fieldCls} w-14 font-mono`}
          />
          <span>s</span>
        </label>
      </div>

      {algo === 'ctc-forced-aligner' && (
        <label className="block text-[11px] text-slate-500 space-y-1">
          <span title="The whole-song reference is deliberately not used for a window — force-aligning every line of a song into eight seconds would place them all inside it and call that an alignment.">
            Words sung here (the aligner has nothing to align without them)
          </span>
          <textarea
            value={text} onChange={(e) => setText(e.target.value)}
            rows={2}
            className={`${fieldCls} w-full`}
            placeholder="type the line as it is actually sung here"
          />
        </label>
      )}

      <button
        className="w-full px-2 py-1 rounded bg-fuchsia-600/70 hover:bg-fuchsia-600 text-white text-[11px] uppercase tracking-wider disabled:opacity-40 disabled:hover:bg-fuchsia-600/70"
        onClick={run}
        disabled={running || !windowOk || !slug}
      >
        {running ? 'Transcribing…' : 'Transcribe section'}
      </button>

      {error && (
        <div className="text-[10px] text-red-400 whitespace-pre-wrap">{error}</div>
      )}
      {note && (
        <div className="text-[10px] text-emerald-400">{note}</div>
      )}

      {/* ── What it heard ──────────────────────────────────────────────── */}
      {result && (
        <div className="space-y-2">
          <div className="text-[10px] text-slate-500">
            {draft.length === 0
              ? 'Nothing heard in this window — silence, or the wrong stem.'
              : `${kept.length} of ${draft.length} word${draft.length === 1 ? '' : 's'}`}
            {result.language ? ` · ${result.language}` : ''}
            {result.ms ? ` · ${(result.ms / 1000).toFixed(1)}s` : ''}
          </div>

          {draft.length > 0 && (
            <div className="max-h-56 overflow-y-auto rounded border border-white/[0.06] divide-y divide-white/[0.04]">
              {draft.map((w) => (
                <div key={w.id} className="flex items-center flex-wrap gap-1.5 px-1.5 py-1 text-[11px]">
                  <input
                    type="checkbox" checked={w.keep}
                    onChange={(e) => setDraft((d) => d.map((x) => (
                      x.id === w.id ? { ...x, keep: e.target.checked } : x
                    )))}
                    className="accent-fuchsia-500 w-3 h-3 shrink-0"
                  />
                  <button
                    className="font-mono text-[10px] text-slate-500 hover:text-slate-300 shrink-0"
                    onClick={() => onSeek?.(w.time)}
                    title="Seek here"
                  >
                    {w.time.toFixed(2)}–{w.end.toFixed(2)}
                  </button>
                  <input
                    value={w.text}
                    onChange={(e) => setDraft((d) => d.map((x) => (
                      x.id === w.id ? { ...x, text: e.target.value } : x
                    )))}
                    className={`${fieldCls} flex-1 min-w-[6rem] ${w.keep ? '' : 'opacity-40 line-through'}`}
                  />
                </div>
              ))}
            </div>
          )}

          {/* ── Where it lands ───────────────────────────────────────────── */}
          <div className="space-y-1.5 text-[11px] text-slate-500">
            <label className="flex items-center gap-1.5">
              <span className="shrink-0">Write into</span>
              <select
                value={target} onChange={(e) => setTarget(e.target.value)}
                className={`${fieldCls} flex-1 min-w-0 truncate font-mono`}
              >
                <option value="cache">
                  {algo}{stem === 'mix' ? '' : ` · ${stem}`} (detector result)
                </option>
                {layerTargets.map((l) => (
                  <option key={l.id} value={l.id}>{l.name} (layer)</option>
                ))}
              </select>
            </label>
            <div className="flex items-center gap-1.5">
              <button
                className="flex-1 px-2 py-1 rounded bg-emerald-600/80 hover:bg-emerald-600 text-white text-[11px] disabled:opacity-40 disabled:hover:bg-emerald-600/80"
                onClick={() => write(kept)}
                disabled={merging || kept.length === 0}
                title="Replace everything the target says about this window with the words above"
              >
                {merging ? 'Writing…' : `Replace window (${kept.length})`}
              </button>
              <button
                className="px-2 py-1 rounded border border-white/10 text-slate-300 hover:bg-white/5 text-[11px] disabled:opacity-40 disabled:hover:bg-transparent"
                onClick={() => write([])}
                disabled={merging}
                title="Delete every word the target has in this window and put nothing back — for a line hallucinated over silence"
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
