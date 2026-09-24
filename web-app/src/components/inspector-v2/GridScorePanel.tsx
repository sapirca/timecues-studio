import { useEffect, useRef, useState } from 'react';
import type { SongInfo } from '../../types/songInfo';
import {
  scoreGrid, orderTrackers, bpmRelation, octaveHint,
  type GridScoreResponse, type GridScoreResult, type GridVerdict,
  type BpmRelation,
} from '../../services/gridScore';

/** Step ④ — check the grid against the beat trackers.
 *
 *  Step ③ checks the grid by ear. This is the same check with a different
 *  judge: every tracker that has run on the song is scored against the grid
 *  on screen using mir_eval, the way a beat-tracking paper reports
 *  F-measure. A curator gets a number instead of a feeling.
 *
 *  The single most useful thing here is not any one score but the
 *  DISAGREEMENT between them. The trackers are independent — different
 *  architectures, training sets and decades — so when they agree with each
 *  other and all disagree with the grid, the grid is the outlier. Three
 *  models do not fail identically. That verdict is what the badge says.
 *
 *  Deliberately read-only about the audio and cheap to show: it scores
 *  CACHED tracker output, so it costs a few milliseconds and never triggers
 *  a model run. Nothing appears at all when the Python stack is down.
 */

const VERDICT: Record<GridVerdict, { label: string; tone: string; blurb: string }> = {
  confirmed: {
    label: 'Confirmed',
    tone: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200',
    blurb: 'The trackers agree with this grid.',
  },
  disputed: {
    label: 'Disputed',
    tone: 'border-rose-500/50 bg-rose-500/15 text-rose-200',
    blurb: 'The trackers agree with each other — and not with this grid.',
  },
  octave: {
    label: 'Half / double time',
    tone: 'border-amber-500/50 bg-amber-500/15 text-amber-100',
    blurb: 'Right pulse, counted at a different level. Probably not an error.',
  },
  weak: {
    label: 'No verdict',
    tone: 'border-slate-500/40 bg-white/[0.04] text-slate-300',
    blurb: 'Nothing matches well, and the trackers disagree with each other too.',
  },
  unscorable: {
    label: 'Not scored',
    tone: 'border-slate-500/40 bg-white/[0.04] text-slate-300',
    blurb: '',
  },
};

/** A score's colour band. The thresholds are the ones the verdict logic
 *  uses, so the colours never contradict the badge. */
function band(value: number): string {
  if (value >= 0.9) return 'text-emerald-300';
  if (value >= 0.7) return 'text-amber-300';
  return 'text-rose-300';
}

function num(value: number | null | undefined): string {
  return value == null ? '—' : value.toFixed(3);
}

/** Colour for a tracker's tempo, read against the grid's own. `octave` is
 *  amber rather than red on purpose — see bpmRelation. */
const BPM_TONE: Record<BpmRelation, string> = {
  match:   'text-emerald-300',
  close:   'text-emerald-400/70',
  octave:  'text-amber-300',
  off:     'text-rose-300',
  unknown: 'text-slate-600',
};

export interface GridScorePanelProps {
  songInfo: SongInfo | null;
  /** Audio duration in seconds. The grid is a rule; expanding it into beats
   *  needs to know where to stop. */
  duration?: number;
  /** Apply the trackers' suggested tempo. Omitted for non-admin viewers, who
   *  see the numbers but can't act on them. */
  onApplyBpm?: (bpm: number) => void;
  /** Apply the trackers' suggested bar 1. */
  onApplyOffset?: (seconds: number) => void;
}

export function GridScorePanel({
  songInfo, duration, onApplyBpm, onApplyOffset,
}: GridScorePanelProps) {
  const [state, setState] = useState<GridScoreResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const slug = songInfo?.song;
  // Only the fields that change the grid belong in the dependency key —
  // rescoring on an unrelated songInfo write (a title edit, a save bump)
  // would fire a request per keystroke.
  const key = songInfo
    ? JSON.stringify([
        slug, songInfo.bpm, songInfo.gridOffset, songInfo.timeSignature,
        songInfo.gridMode, songInfo.manualBaseGridMode,
        songInfo.gridSegments, duration,
      ])
    : null;

  useEffect(() => {
    if (!songInfo || !slug) { setState(null); return; }

    // Debounced: the offset arrives as a drag, not a commit, and every
    // intermediate value would otherwise be its own round trip.
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      scoreGrid(slug, songInfo, duration, controller.signal)
        .then((result) => { if (!controller.signal.aborted) setState(result); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 400);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!state) {
    // No answer yet, or the last request was superseded. Opening the step is
    // a request for information, so say we are working rather than showing a
    // blank card.
    return <p className="text-[10.5px] text-slate-500">Scoring…</p>;
  }

  if (!state.ok) {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-[10.5px] leading-snug text-slate-400">
          {state.reason}
          {state.reason.includes('no tracker') && (
            <> Run a detector from step ① first.</>
          )}
        </p>
        {state.hint && (
          <code className="block rounded-[4px] border border-white/[0.08] bg-black/40 px-1.5 py-1 text-[10px] text-slate-400">
            {state.hint}
          </code>
        )}
      </div>
    );
  }

  const result = state as GridScoreResult;
  const verdict = VERDICT[result.verdict];
  const names = orderTrackers(Object.keys(result.trackers));
  const { bpm: suggestedBpm, firstDownbeat } = result.suggestion;

  const bpmDiffers = suggestedBpm != null && songInfo
    && Math.abs(suggestedBpm - (songInfo.bpm ?? 0)) > 0.5;
  const offsetDiffers = firstDownbeat != null && songInfo
    && Math.abs(firstDownbeat - (songInfo.gridOffset ?? 0)) > 0.02;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span className={`rounded-[4px] border px-1.5 py-[2px] text-[10px] font-semibold ${verdict.tone}`}>
          {verdict.label}
        </span>
        {result.consensus != null && (
          <span className="text-[10px] text-slate-500">
            trackers agree with each other: {result.consensus.toFixed(2)}
          </span>
        )}
        {loading && <span className="text-[10px] text-slate-600">updating…</span>}
      </div>

      <p className="text-[10.5px] leading-snug text-slate-400">{verdict.blurb}</p>
      {result.caveat && (
        <p className="text-[10.5px] leading-snug text-amber-400/80">⚠ {result.caveat}</p>
      )}

      <table className="w-full text-[10.5px] tabular-nums">
        <thead>
          <tr className="text-slate-500">
            <th className="text-left font-normal">tracker</th>
            <th className="text-right font-normal" title="The tempo this tracker heard, from its median inter-beat interval. Compare it to the song's own BPM: when every tracker agrees on the tempo but the scores are still low, it is the downbeat that is wrong, not the tempo.">BPM</th>
            <th className="text-right font-normal" title="F-measure against this grid's downbeats — the number a segment's bar 1 depends on">down</th>
            <th className="text-right font-normal" title="Continuity allowing half/double time. High here with a low beat score means an octave disagreement, not an error.">AMLt</th>
          </tr>
        </thead>
        <tbody>
          {names.map((name) => {
            const scores = result.trackers[name];
            const beat = scores.beat;
            const down = scores.downbeat;
            const relation = bpmRelation(scores.bpm, songInfo?.bpm);
            const hint = (relation === 'octave' && scores.bpm && songInfo?.bpm)
              ? octaveHint(scores.bpm, songInfo.bpm)
              : null;
            return (
              <tr key={name}>
                <td className="text-slate-300 pr-2">{name}</td>
                <td
                  className={`text-right ${BPM_TONE[relation]}`}
                  // The beat F-measure still exists and still means something;
                  // it just answers a question a curator asks second.
                  title={beat ? `beat F-measure ${beat.f_measure.toFixed(3)} · CMLt ${beat.cmlt.toFixed(3)}` : undefined}
                >
                  {scores.bpm == null ? '—' : scores.bpm.toFixed(2)}
                  {hint && <span className="ml-1 text-[9px] text-amber-400/70">{hint}</span>}
                </td>
                <td className={`text-right ${down ? band(down.f_measure) : 'text-slate-600'}`}>
                  {num(down?.f_measure)}
                </td>
                <td className="text-right text-slate-500">{num(beat?.amlt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {(bpmDiffers || offsetDiffers) && (
        <div className="flex flex-col gap-1.5 rounded-[5px] border border-white/[0.08] bg-white/[0.02] p-2">
          <p className="text-[10px] text-slate-500">The trackers suggest</p>
          <div className="flex flex-wrap gap-1.5">
            {bpmDiffers && onApplyBpm && (
              <button
                type="button"
                onClick={() => onApplyBpm(suggestedBpm!)}
                className="rounded-[4px] border border-violet-400/40 bg-violet-500/10 px-2 py-[3px] text-[10.5px] font-semibold text-violet-100 hover:bg-violet-500/20"
              >
                {suggestedBpm!.toFixed(2)} BPM
              </button>
            )}
            {offsetDiffers && onApplyOffset && (
              <button
                type="button"
                onClick={() => onApplyOffset(firstDownbeat!)}
                className="rounded-[4px] border border-violet-400/40 bg-violet-500/10 px-2 py-[3px] text-[10.5px] font-semibold text-violet-100 hover:bg-violet-500/20"
              >
                bar 1 at {firstDownbeat!.toFixed(3)}s
              </button>
            )}
          </div>
          {/* Honesty about what the suggestion is worth: it is a median over
              detectors and a first downbeat, not a fix. On a song whose real
              problem is tempo drift, applying it barely moves the score. */}
          <p className="text-[10px] leading-snug text-slate-500">
            A starting point, not a fix — re-check the score after applying.
          </p>
        </div>
      )}
    </div>
  );
}
