/**
 * Prominence editor for a `sections` slot of AnnotationPointCard — the
 * popover half of the front/back feature. The band-drag half lives in
 * ProminenceLane.
 *
 * `prominenceSection()` at the bottom is what the four kinds that carry a
 * prominence envelope (spans, loops, patterns, riff instances) actually use;
 * they were each building the same block by hand.
 *
 * Level buttons apply AT THE PLAYHEAD, mapped into item-relative time, which
 * is what makes the feature quick to use: scrub to where the vocal enters,
 * click Counter, done. When the playhead is outside the item there is no
 * meaningful position to place a breakpoint at, so the buttons fall back to
 * setting the t=0 anchor and say so in their tooltip.
 *
 * This block and the lane's ProminenceStrip are never on screen together: the
 * card stops drawing itself while the strip is up (see AnnotationPointCard),
 * so the two can't compete. This one is what you get when the strip can't
 * open at all — a read-only detector card, review mode, the Prep workspace —
 * and the way into the strip when it can.
 */

import { useRef } from 'react';
import type { CardSectionSpec } from './CardSection';
import {
  PROMINENCE_INFO,
  PROMINENCE_LEVELS,
  prominenceAt,
  prominenceSummary,
  removeProminencePoint,
  setProminenceAt,
  toggleProminenceRamp,
  type ProminenceEnvelope,
} from '../../../types/annotationLayer';
import { formatClockTime as fmtTime } from '../../../utils/clockTime';
import { usePlayheadClock, usePlayheadEffect, usePlayheadValue } from '../../../hooks/usePlayhead';

/** Read-only arc summary ("Lead → Backing") for the editor-panel item cards,
 *  so the shape is visible without opening the canvas popover. Renders nothing
 *  when the item has no prominence annotation. */
export function ProminenceBadge({ points, color }: {
  points: ProminenceEnvelope | undefined;
  color: string;
}) {
  const summary = prominenceSummary(points);
  if (!summary) return null;
  return (
    <span
      className="text-[9px] font-mono px-1 py-0.5 rounded self-start"
      style={{ color, background: `${color}1a`, boxShadow: `inset 0 0 0 1px ${color}33` }}
      title={`Prominence (front ↔ back): ${(points ?? [])
        .map((p) => `${PROMINENCE_INFO[p.level].label}${p.ramp === 'ramp' ? ' (crossfaded in)' : ''}`)
        .join(' → ')}`}
    >
      {summary}
    </span>
  );
}

export interface ProminenceControlProps {
  points: ProminenceEnvelope | undefined;
  /** Item bounds in track seconds — used to map the playhead into item time. */
  start: number;
  end: number;
  /** Layer colour, so the active chip matches the band on the canvas. */
  color: string;
  readOnly?: boolean;
  onChange: (points: ProminenceEnvelope | undefined) => void;
}

export function ProminenceControl({
  points, start, end, color, readOnly = false, onChange,
}: ProminenceControlProps) {
  const duration = Math.max(0, end - start);
  // Where a click lands: the playhead when it's inside the item, else the
  // t=0 anchor (the only position that's always meaningful). Read from the
  // playhead clock — what renders is only whether the playhead is inside and
  // which level is active there, so the card re-renders on those changes and
  // not on every frame of playback.
  const applyAtFor = (t: number) => {
    const tRel = t - start;
    return tRel >= 0 && tRel <= duration ? tRel : 0;
  };
  const playheadClock = usePlayheadClock();
  const playheadInside = usePlayheadValue((t) => t - start >= 0 && t - start <= duration);
  const activeLevel = usePlayheadValue((t) => prominenceAt(points, applyAtFor(t))?.level ?? null);

  // The tooltips name the exact spot, so they follow the clock by writing the
  // attribute directly instead of through a render.
  const levelButtons = useRef(new Map<string, HTMLButtonElement>());
  usePlayheadEffect((t) => {
    const tRel = t - start;
    const inside = tRel >= 0 && tRel <= duration;
    const applyHint = inside
      ? `at the playhead (${fmtTime(t)}, ${tRel.toFixed(2)}s in)`
      : 'at the start of this annotation — move the playhead inside it to place a breakpoint mid-way';
    for (const level of PROMINENCE_LEVELS) {
      const info = PROMINENCE_INFO[level];
      const el = levelButtons.current.get(level);
      if (el) el.title = `${info.label}\n${info.description}\n\nSets ${info.short} ${applyHint}.`;
    }
  }, [start, duration]);

  return (
    <div>
      {/* No "Prominence" caption here — the enclosing CardSection header
       *  already carries it. What's left is the bit that actually changes as
       *  you scrub: where the next click will land. */}
      <span className="block text-[9px] text-slate-400 mb-1">
        front ↔ back · {playheadInside ? 'applies at playhead' : 'applies at start'}
      </span>

      <div className="flex gap-1">
        {PROMINENCE_LEVELS.map((level) => {
          const info = PROMINENCE_INFO[level];
          const isActive = activeLevel === level;
          return (
            <button
              key={level}
              ref={(el) => {
                if (el) levelButtons.current.set(level, el);
                else levelButtons.current.delete(level);
              }}
              type="button"
              disabled={readOnly}
              onClick={() => onChange(setProminenceAt(points, applyAtFor(playheadClock.get()), level))}
              className={`flex-1 rounded px-1 py-1 text-[10px] leading-none border transition-colors ${
                readOnly ? 'cursor-not-allowed opacity-60' : 'hover:bg-white/[0.06]'
              } ${isActive ? 'text-slate-50' : 'text-slate-300 border-white/[0.06] bg-[#0a0b0d]'}`}
              style={isActive ? {
                borderColor: color,
                background: `${color}33`,
                boxShadow: `inset 0 0 0 1px ${color}88`,
              } : undefined}
            >
              {info.short}
            </button>
          );
        })}
      </div>

      {points && points.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {points.map((p, i) => (
            <span
              key={`${p.t}-${i}`}
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[9px] font-mono border border-white/[0.06] bg-[#0a0b0d] text-slate-300"
              title={`${PROMINENCE_INFO[p.level].label} from ${fmtTime(start + p.t)}${p.ramp === 'ramp' ? ' — crossfaded in from the previous level' : ''}`}
            >
              {/* Ramp is per-breakpoint rather than a "next click crossfades"
                *  mode, so the band's breakpoint editor and this list stay in
                *  agreement and nothing is placed under a hidden setting. The
                *  first point has nothing to arrive from, so it can't ramp. */}
              {i > 0 && (
                <button
                  type="button"
                  disabled={readOnly}
                  onClick={() => onChange(toggleProminenceRamp(points, i))}
                  className={`${readOnly ? 'cursor-not-allowed' : 'hover:text-slate-100'} ${
                    p.ramp === 'ramp' ? 'text-slate-200' : 'text-slate-600'
                  }`}
                  title={p.ramp === 'ramp'
                    ? 'Crossfades in from the previous level — click for an instant switch instead'
                    : 'Switches instantly — click to crossfade in from the previous level'}
                >
                  {p.ramp === 'ramp' ? '∿' : '⌐'}
                </button>
              )}
              {fmtTime(start + p.t)} {PROMINENCE_INFO[p.level].short}
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => onChange(removeProminencePoint(points, i))}
                  className="text-slate-500 hover:text-slate-200"
                  title="Remove this breakpoint"
                >
                  ×
                </button>
              )}
            </span>
          ))}
          {!readOnly && (
            <button
              type="button"
              onClick={() => onChange(undefined)}
              className="ml-auto text-[10px] text-slate-400 hover:text-slate-200 underline decoration-dotted"
              title="Remove the prominence annotation entirely — the band goes back to its plain appearance."
            >
              clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The card section every prominence-carrying kind mounts — one definition
 *  instead of the four hand-copied `extras` blocks that preceded it. Folded
 *  by default: it's the least-used block on the card, and the arc summary in
 *  the header says whether there's anything inside worth opening. */
export function prominenceSection(props: ProminenceControlProps): CardSectionSpec {
  return {
    id: 'prominence',
    title: 'Prominence',
    defaultOpen: false,
    summary: prominenceSummary(props.points) ?? undefined,
    content: <ProminenceControl {...props} />,
  };
}
