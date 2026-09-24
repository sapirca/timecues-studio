// The pinned-beat list that fills step 2 (Downbeat) of the Song-setup panel
// while Hand-placed is the active mode. Pinned beats are the `beatOverrides`
// map — individual beats dragged off the base grid — and this lists them in
// beat-index order so they can be reviewed, jumped to, and unpinned from the
// panel rather than only from the waveform.
//
// The base grid (Steady or Mapped) keeps its own editor in step ①; this list
// only ever shows what the curator has pinned on top of it.

import { formatClockTime } from '../../utils/clockTime';
import type { ManualBaseGridMode } from '../../types/songInfo';

export interface PinnedBeat {
  /** Global integer beat index — same key as `beatOverrides[String(idx)]`. */
  beatIndex: number;
  /** Override timestamp in seconds (the current pinned position). */
  time: number;
}

export interface PinnedBeatListEditorProps {
  /** Sparse beat overrides for Hand-placed mode. */
  beatOverrides?: Readonly<Record<string, number>>;
  /** Base grid the pinned beats ride on, named in the list's header. */
  manualBase?: ManualBaseGridMode;
  /** When true, the unpin buttons render disabled (non-admin viewer). */
  locked?: boolean;
  /** Seek the player to `time` (seconds). Hidden when not provided. */
  onSeek?: (time: number) => void;
  /** Remove the override for `beatIndex` — sent when the curator clicks
   *  the ✕ next to a pinned beat. */
  onClearPinnedBeat?: (beatIndex: number) => void;
}

export function PinnedBeatListEditor({
  beatOverrides,
  manualBase,
  locked = false,
  onSeek,
  onClearPinnedBeat,
}: PinnedBeatListEditorProps) {
  const pinned: PinnedBeat[] = beatOverrides
    ? Object.entries(beatOverrides)
        .map(([k, v]) => ({ beatIndex: parseInt(k, 10), time: v }))
        .filter((p) => Number.isFinite(p.beatIndex) && Number.isFinite(p.time))
        .sort((a, b) => a.beatIndex - b.beatIndex)
    : [];

  return (
    <div className="pt-2 mt-1 border-t border-white/[0.08] space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold text-slate-200 uppercase tracking-wider">
          Pinned beats <span className="ml-1 px-1.5 py-0.5 rounded text-[9px] font-mono bg-amber-500/20 text-amber-100">{pinned.length}</span>
        </span>
        <span className="text-[10px] text-slate-500 font-mono italic">
          base: {manualBase === 'mapped' ? 'Mapped' : 'Steady'}
        </span>
      </div>
      {pinned.length === 0 ? (
        <p className="text-[11px] text-slate-500 italic px-1">
          No pinned beats yet — drag any beat line on the waveform to pin it. Right-click a pinned beat to unpin.
        </p>
      ) : (
        <div className="max-h-[220px] overflow-y-auto rounded border border-white/[0.06] bg-black/20">
          <table className="w-full text-[11px] font-mono">
            <thead className="sticky top-0 bg-[#0e1015] text-slate-500 text-[9px] uppercase tracking-wider">
              <tr>
                <th className="text-left px-2 py-1 w-16">Beat #</th>
                <th className="text-left px-2 py-1">Time</th>
                <th className="text-left px-2 py-1">Status</th>
                <th className="text-right px-2 py-1 w-16">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pinned.map((p) => (
                <tr key={`p-${p.beatIndex}`} className="border-t border-white/[0.03] bg-amber-500/[0.04]">
                  <td className="px-2 py-1 text-amber-300/70 text-[10px]">
                    <span title="Pinned beat (manual override)" className="inline-flex items-center gap-1">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 shadow-[0_0_4px_rgba(251,191,36,0.7)]" />
                      #{p.beatIndex + 1}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-amber-200 font-mono text-[11px] tabular-nums">
                    {formatClockTime(p.time, 3)}
                  </td>
                  <td className="px-2 py-1 text-slate-500 text-[10px] italic">pinned</td>
                  <td className="px-2 py-1 text-right">
                    <span className="inline-flex items-center gap-1">
                      {onSeek && (
                        <button
                          type="button"
                          onClick={() => onSeek(p.time)}
                          className="px-1.5 py-0.5 rounded text-slate-400 hover:text-slate-100 hover:bg-white/[0.06] transition-colors"
                          title="Jump playhead to this pinned beat"
                        >
                          ▶
                        </button>
                      )}
                      {!locked && onClearPinnedBeat && (
                        <button
                          type="button"
                          onClick={() => onClearPinnedBeat(p.beatIndex)}
                          className="px-1.5 py-0.5 rounded text-slate-400 hover:text-amber-300 hover:bg-amber-500/10 transition-colors"
                          title="Unpin this beat — returns it to its macro-grid position"
                        >
                          ✕
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
