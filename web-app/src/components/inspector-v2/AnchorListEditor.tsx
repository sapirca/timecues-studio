// Per-anchor editor that swaps into SongInfoBar in Dynamic / Manual grid
// modes — the global BPM input + Auto-detected chips don't apply when the
// tempo is anchor-driven, so this list replaces them. The user can edit
// each anchor's timestamp + BPM inline, jump the playhead to an anchor,
// delete an anchor, or add a new one at the current playhead position.
//
// In Manual mode the editor also surfaces pinned beats (the
// `beatOverrides` map):
//   - Dynamic base: pinned beats render as collapsible child rows under
//     the anchor whose segment they fall into.
//   - Static base: the anchor table is suppressed entirely and a flat
//     "Pinned beats" list replaces it.

import { Fragment, useEffect, useState } from 'react';
import type { TempoAnchor, GridMode, ManualBaseGridMode } from '../../types/songInfo';
import { normalizeAnchors } from '../../types/songInfo';
import { cumulativeBeatsAtAnchor } from '../../utils/beatGrid';

const BPM_MIN = 20;
const BPM_MAX = 300;

export interface PinnedBeat {
  /** Global integer beat index — same key as `beatOverrides[String(idx)]`. */
  beatIndex: number;
  /** Override timestamp in seconds (the current pinned position). */
  time: number;
}

export interface AnchorListEditorProps {
  anchors: readonly TempoAnchor[];
  duration: number;
  playerTime: number;
  mode: 'dynamic' | 'manual';
  /** Manual base — only meaningful when `mode === 'manual'`. 'static'
   *  hides the anchor table (anchors are inactive); 'dynamic' renders
   *  anchors with pinned-beat children. */
  manualBase?: ManualBaseGridMode;
  /** Sparse beat overrides for Manual mode — surfaced as either nested
   *  children (dynamic base) or a flat list (static base). Empty/missing
   *  outside Manual mode. */
  beatOverrides?: Readonly<Record<string, number>>;
  /** Grid offset (seconds) — used when computing which anchor segment a
   *  pinned beat falls under (the cumulative-beat math needs the same
   *  origin the renderer uses). */
  gridOffset?: number;
  /** When true, all edit controls render disabled (non-admin viewer). */
  locked?: boolean;
  /** Optional global BPM — used as the default for newly inserted anchors
   *  when no neighbor exists, and to label pinned-beat bar.beat positions. */
  globalBpm?: number;
  onChange: (anchors: TempoAnchor[]) => void;
  /** Seek the player to `time` (seconds). Hidden when not provided. */
  onSeek?: (time: number) => void;
  /** Remove the override for `beatIndex` — sent when the curator clicks
   *  the ✕ next to a pinned beat. */
  onClearPinnedBeat?: (beatIndex: number) => void;
}

const TIER: Record<GridMode, { accent: string; ring: string; badge: string }> = {
  static:  { accent: 'text-slate-200',  ring: 'border-slate-500/30',  badge: 'bg-slate-500/20 text-slate-200' },
  dynamic: { accent: 'text-cyan-200',   ring: 'border-cyan-500/30',   badge: 'bg-cyan-500/20 text-cyan-100' },
  manual:  { accent: 'text-emerald-200',ring: 'border-emerald-500/30',badge: 'bg-emerald-500/20 text-emerald-100' },
};

function formatTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '0:00.000';
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(3).padStart(6, '0');
  return `${m}:${s}`;
}

/** Inline editable text field that keeps a local buffer so the user can
 *  type intermediate states (empty / mid-decimal) without committing
 *  every keystroke and re-snapping on each render. */
function NumericCell({
  value,
  onCommit,
  min,
  max,
  step,
  width,
  disabled,
  suffix,
  title,
}: {
  value: number;
  onCommit: (v: number) => void;
  min: number;
  max: number;
  step: number;
  width: string;
  disabled?: boolean;
  suffix?: string;
  title?: string;
}) {
  const [text, setText] = useState(value.toString());
  useEffect(() => { setText(value.toString()); }, [value]);
  const parsed = parseFloat(text);
  const outOfRange = !Number.isFinite(parsed) || parsed < min || parsed > max;
  return (
    <span className="inline-flex items-center gap-0.5" title={title}>
      <input
        type="number"
        value={text}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (outOfRange) { setText(value.toString()); return; }
          if (Math.abs(parsed - value) < 1e-6) return;
          onCommit(parsed);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') { setText(value.toString()); (e.target as HTMLInputElement).blur(); }
        }}
        className={`bg-[#0a0b0d] border text-[11px] font-mono tabular-nums rounded px-1.5 py-0.5 focus:outline-none transition-colors disabled:opacity-50 ${
          outOfRange
            ? 'border-red-500/40 focus:border-red-500/70 focus:ring-1 focus:ring-red-500/40 text-red-200'
            : 'border-white/[0.08] focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/50 text-slate-100'
        } ${width}`}
      />
      {suffix && <span className="text-[10px] text-slate-500">{suffix}</span>}
    </span>
  );
}

export function AnchorListEditor({
  anchors,
  duration,
  playerTime,
  mode,
  manualBase,
  beatOverrides,
  gridOffset = 0,
  locked = false,
  globalBpm,
  onChange,
  onSeek,
  onClearPinnedBeat,
}: AnchorListEditorProps) {
  const tier = TIER[mode];
  const count = anchors.length;

  // Sorted list of pinned beats (override entries) — used by both the
  // nested (dynamic base) and flat (static base) renderings.
  const pinned: PinnedBeat[] = beatOverrides
    ? Object.entries(beatOverrides)
        .map(([k, v]) => ({ beatIndex: parseInt(k, 10), time: v }))
        .filter((p) => Number.isFinite(p.beatIndex) && Number.isFinite(p.time))
        .sort((a, b) => a.beatIndex - b.beatIndex)
    : [];
  const pinnedCount = pinned.length;

  // Hide the anchor table entirely when Manual + Static base — anchors
  // are inert in that mode, so showing them invites confusion. Show the
  // pinned beat list instead.
  const showAnchorTable = !(mode === 'manual' && manualBase === 'static');

  // Group pinned beats under the anchor segment they fall into. Returns
  // a map: anchorIndex → pinned[]; key -1 = pre-anchor segment (legacy
  // origin). Only used when nested rendering is active.
  const pinnedByAnchor: Map<number, PinnedBeat[]> = (() => {
    const out = new Map<number, PinnedBeat[]>();
    if (!showAnchorTable || mode !== 'manual' || manualBase !== 'dynamic' || pinned.length === 0) {
      return out;
    }
    const bpmFallback = globalBpm && globalBpm > 0 ? globalBpm : 120;
    const segStarts: number[] = anchors.map((_, i) =>
      cumulativeBeatsAtAnchor(anchors, i, bpmFallback, gridOffset),
    );
    for (const p of pinned) {
      let bucket = -1;
      for (let i = anchors.length - 1; i >= 0; i--) {
        if (p.beatIndex >= segStarts[i]) { bucket = i; break; }
      }
      const arr = out.get(bucket) ?? [];
      arr.push(p);
      out.set(bucket, arr);
    }
    return out;
  })();

  const commit = (next: TempoAnchor[]) => {
    onChange(normalizeAnchors(next));
  };

  const updateAt = (index: number, patch: Partial<TempoAnchor>) => {
    const next = anchors.map((a, i) => (i === index ? { ...a, ...patch } : a));
    commit(next);
  };

  const deleteAt = (index: number) => {
    commit(anchors.filter((_, i) => i !== index));
  };

  const addAtPlayhead = () => {
    const t = Math.max(0, Math.min(duration, playerTime));
    // Pick the BPM of the nearest existing anchor to avoid jolts;
    // fall back to the global BPM, then to 120.
    let bpm = globalBpm ?? 120;
    if (anchors.length > 0) {
      let best = anchors[0];
      let bestDist = Math.abs(best.timestamp - t);
      for (const a of anchors) {
        const d = Math.abs(a.timestamp - t);
        if (d < bestDist) { best = a; bestDist = d; }
      }
      bpm = best.bpm;
    }
    commit([...anchors, { timestamp: t, bpm }]);
  };

  // Render a single pinned-beat row used by both the nested and flat
  // layouts. Indent controls whether it sits under an anchor or flush left.
  const renderPinnedRow = (p: PinnedBeat, indent: boolean) => (
    <tr key={`p-${p.beatIndex}`} className="border-t border-white/[0.03] bg-amber-500/[0.04]">
      <td className={`px-2 py-1 text-amber-300/70 text-[10px] ${indent ? 'pl-6' : ''}`}>
        <span title="Pinned beat (manual override)" className="inline-flex items-center gap-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 shadow-[0_0_4px_rgba(251,191,36,0.7)]" />
          #{p.beatIndex + 1}
        </span>
      </td>
      <td className="px-2 py-1 text-amber-200 font-mono text-[11px] tabular-nums">
        {p.time.toFixed(3)}s
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
  );

  // Static-base flat layout: the anchor table is suppressed; the
  // section header switches to "Pinned beats" and the table lists every
  // override in beat-index order.
  if (!showAnchorTable) {
    return (
      <div className="pt-2 mt-1 border-t border-white/[0.08] space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold text-slate-200 uppercase tracking-wider">
            Pinned beats <span className="ml-1 px-1.5 py-0.5 rounded text-[9px] font-mono bg-amber-500/20 text-amber-100">{pinnedCount}</span>
          </span>
          <span className="text-[10px] text-slate-500 font-mono italic">
            base: Static BPM
          </span>
        </div>
        {pinnedCount === 0 ? (
          <p className="text-[11px] text-slate-500 italic px-1">
            No pinned beats yet — drag any beat line on the waveform to pin it. Right-click a pinned beat to unpin.
          </p>
        ) : (
          <div className="max-h-[220px] overflow-y-auto rounded border border-white/[0.06] bg-black/20">
            <table className="w-full text-[11px] font-mono">
              <thead className="sticky top-0 bg-[#0e1015] text-slate-500 text-[9px] uppercase tracking-wider">
                <tr>
                  <th className="text-left px-2 py-1 w-16">Beat #</th>
                  <th className="text-left px-2 py-1">Time (s)</th>
                  <th className="text-left px-2 py-1">Status</th>
                  <th className="text-right px-2 py-1 w-16">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pinned.map((p) => renderPinnedRow(p, false))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  const headerLabel = mode === 'manual' ? 'Anchors & pinned beats' : 'Anchors';

  return (
    <div className={`pt-2 mt-1 border-t border-white/[0.08] space-y-1.5`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold text-slate-200 uppercase tracking-wider">
          {headerLabel} <span className={`ml-1 px-1.5 py-0.5 rounded text-[9px] font-mono ${tier.badge}`}>{count}</span>
          {mode === 'manual' && pinnedCount > 0 && (
            <span className="ml-1 px-1.5 py-0.5 rounded text-[9px] font-mono bg-amber-500/20 text-amber-100">
              +{pinnedCount} pinned
            </span>
          )}
        </span>
        {!locked && (
          <button
            type="button"
            onClick={addAtPlayhead}
            className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold border ${tier.ring} ${tier.accent} hover:bg-white/[0.04] transition-colors`}
            title={`Insert an anchor at the playhead (${formatTime(playerTime)}). BPM defaults to the nearest existing anchor's BPM.`}
          >
            + Add at playhead
          </button>
        )}
      </div>
      {count === 0 ? (
        <>
          <p className="text-[11px] text-slate-500 italic px-1">
            No anchors yet — {mode === 'dynamic'
              ? 'click ↻ Re-derive above to generate a baseline from the tempo curve, or'
              : 'switch to Dynamic to seed a baseline, or'} click + Add at playhead.
          </p>
          {mode === 'manual' && pinnedCount > 0 && (
            <div className="max-h-[180px] overflow-y-auto rounded border border-white/[0.06] bg-black/20">
              <table className="w-full text-[11px] font-mono">
                <thead className="sticky top-0 bg-[#0e1015] text-slate-500 text-[9px] uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-2 py-1 w-16">Beat #</th>
                    <th className="text-left px-2 py-1">Time (s)</th>
                    <th className="text-left px-2 py-1">Status</th>
                    <th className="text-right px-2 py-1 w-16">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pinned.map((p) => renderPinnedRow(p, false))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <div className="max-h-[240px] overflow-y-auto rounded border border-white/[0.06] bg-black/20">
          <table className="w-full text-[11px] font-mono">
            <thead className="sticky top-0 bg-[#0e1015] text-slate-500 text-[9px] uppercase tracking-wider">
              <tr>
                <th className="text-left px-2 py-1 w-8">#</th>
                <th className="text-left px-2 py-1">Time (s)</th>
                <th className="text-left px-2 py-1">BPM</th>
                <th className="text-right px-2 py-1 w-16">Actions</th>
              </tr>
            </thead>
            <tbody>
              {/* Pre-anchor pinned beats — only appear when the user has
                  pinned beats before the first anchor. Rare but worth
                  surfacing so they aren't hidden. */}
              {pinnedByAnchor.get(-1)?.map((p) => renderPinnedRow(p, false))}
              {anchors.map((a, i) => {
                const next = anchors[i + 1];
                const tsMax = next ? next.timestamp - 0.05 : duration;
                const tsMin = i === 0 ? 0 : anchors[i - 1].timestamp + 0.05;
                const children = pinnedByAnchor.get(i) ?? [];
                return (
                  <Fragment key={`a-${i}-${a.timestamp}`}>
                    <tr className="border-t border-white/[0.04] hover:bg-white/[0.02]">
                      <td className="px-2 py-1 text-slate-500">{i + 1}</td>
                      <td className="px-2 py-1">
                        <NumericCell
                          value={a.timestamp}
                          onCommit={(v) => updateAt(i, { timestamp: Math.max(tsMin, Math.min(tsMax, v)) })}
                          min={tsMin}
                          max={tsMax}
                          step={0.001}
                          width="w-20"
                          disabled={locked}
                          title={`Clamped to [${tsMin.toFixed(3)}, ${tsMax.toFixed(3)}] s by neighboring anchors.`}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <NumericCell
                          value={a.bpm}
                          onCommit={(v) => updateAt(i, { bpm: v })}
                          min={BPM_MIN}
                          max={BPM_MAX}
                          step={0.01}
                          width="w-16"
                          disabled={locked}
                          suffix="BPM"
                        />
                      </td>
                      <td className="px-2 py-1 text-right">
                        <span className="inline-flex items-center gap-1">
                          {onSeek && (
                            <button
                              type="button"
                              onClick={() => onSeek(a.timestamp)}
                              className="px-1.5 py-0.5 rounded text-slate-400 hover:text-slate-100 hover:bg-white/[0.06] transition-colors"
                              title="Jump playhead to this anchor"
                            >
                              ▶
                            </button>
                          )}
                          {!locked && (
                            <button
                              type="button"
                              onClick={() => deleteAt(i)}
                              className="px-1.5 py-0.5 rounded text-slate-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                              title="Delete this anchor"
                            >
                              ✕
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                    {children.map((p) => renderPinnedRow(p, true))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
