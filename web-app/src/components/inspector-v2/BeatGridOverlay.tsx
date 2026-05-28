import { useMemo } from 'react';
import { visibleGridLines } from '../../utils/beatGrid';
import type { TempoAnchor } from '../../types/songInfo';

export interface BeatGridOverlayProps {
  bpm?: number;
  gridOffset?: number;
  beatsPerBar?: number;
  /** null/undefined → dense (every beat). Else only every Nth bar. */
  barGroupSize?: number | null;
  /** Subdivide each beat (2 = 1/2 beat, 3 = triplet, 4 = 1/4 beat, 6 = 16th
   *  triplet, 8 = 1/8 beat). Ignored when barGroupSize is set. */
  subBeatDivision?: number;
  /** Compound-pulse step: only emit lines every N beats (3 for 6/8/9/8/12/8).
   *  Ignored when barGroupSize or subBeatDivision (>1) is set. */
  beatGroupSize?: number;
  /** Track duration in seconds — used to project beat times to %-of-row. */
  duration: number;
  /** Show "1, 2, 3…" bar numbers above the lines. Off by default. */
  showBarNumbers?: boolean;
  /**
   * Minimum spacing in time (seconds) between rendered lines. The component
   * doesn't know its rendered pixel width, so callers can pass this to cull
   * lines on very long tracks. Default 0 = no culling.
   */
  minSpacingSec?: number;
  /** Optional tempo anchors. When non-empty, the grid becomes piecewise
   *  constant per segment (Dynamic / Manual adjustment modes). */
  anchors?: readonly TempoAnchor[];
  /** Optional per-beat overrides (Manual mode). Sparse map keyed by
   *  global integer beat index → absolute timestamp in seconds. */
  beatOverrides?: Readonly<Record<string, number>>;
  /** Multiplier on every line's width (1 = default). Scales the bar/beat/
   *  sub-beat hierarchy uniformly so bars stay thicker than beats. */
  thickness?: number;
}

/**
 * Absolutely-positioned beat/bar grid overlay. Drop into any `relative` row
 * that uses `(t / duration) * 100%` time projection. `pointer-events: none`
 * so click-to-seek on the parent still works.
 */
export function BeatGridOverlay({
  bpm,
  gridOffset = 0,
  beatsPerBar = 4,
  barGroupSize = null,
  subBeatDivision = 1,
  beatGroupSize,
  duration,
  showBarNumbers = false,
  minSpacingSec = 0,
  anchors,
  beatOverrides,
  thickness = 1,
}: BeatGridOverlayProps) {
  const lines = useMemo(() => {
    if (!bpm || !Number.isFinite(bpm) || bpm <= 0 || duration <= 0) return [];
    const all = visibleGridLines({
      bpm,
      gridOffset,
      beatsPerBar,
      startTime: 0,
      endTime: duration,
      barGroupSize: barGroupSize ?? null,
      subBeatDivision,
      beatGroupSize,
      anchors,
      beatOverrides,
    });
    if (minSpacingSec <= 0) return all;
    const out: typeof all = [];
    let lastT = -Infinity;
    for (const l of all) {
      if (l.t - lastT < minSpacingSec && !l.isPhrase) continue;
      out.push(l);
      lastT = l.t;
    }
    return out;
  }, [bpm, gridOffset, beatsPerBar, barGroupSize, subBeatDivision, beatGroupSize, duration, minSpacingSec, anchors, beatOverrides]);

  if (!lines.length) return null;

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {lines.map((l, i) => {
        const left = (l.t / duration) * 100;
        // Visual hierarchy (Rekordbox-ish):
        //  - phrase boundary (every 4 bars by default) → amber, thickest
        //  - bar boundary                                → bright white, 2px
        //  - beat (dense mode)                           → faint white, 1px dashed
        //  - sub-beat (8th/16th)                         → very faint, 1px shorter dashes
        //  - manually-overridden beat                    → emerald tint so
        //    the curator can see at a glance which beats are pinned.
        const bg = l.isOverridden
          ? 'rgba(52,211,153,0.85)'
          : l.isPhrase
            ? 'rgba(251,191,36,0.55)'
            : l.isBar
              ? 'rgba(255,255,255,0.32)'
              : l.isSubBeat
                ? 'rgba(255,255,255,0.04)'
                : 'rgba(255,255,255,0.07)';
        // Base widths mirror the old w-1 (bar/phrase) / w-0.5 (beat/sub-beat)
        // Tailwind classes; the `thickness` multiplier scales them uniformly.
        const lineWidthPx = (l.isPhrase || l.isBar ? 4 : 2) * thickness;
        // Non-bar lines render dashed so a beat can never be mistaken for a bar boundary.
        // Sub-beats use shorter dashes + lower opacity than beats.
        // Overridden beats stay solid (no dash) so the pinned position is obvious.
        const dashedStyle = !l.isBar && !l.isOverridden
          ? {
              backgroundImage: l.isSubBeat
                ? 'repeating-linear-gradient(to bottom, rgba(255,255,255,0.09) 0 1px, transparent 1px 4px)'
                : 'repeating-linear-gradient(to bottom, rgba(255,255,255,0.18) 0 2px, transparent 2px 5px)',
              background: 'transparent' as const,
            }
          : null;
        return (
          <div
            key={`${l.beatIndex}-${i}`}
            className="absolute top-0 bottom-0"
            style={{ left: `${left}%`, width: `${lineWidthPx}px`, background: bg, ...(dashedStyle ?? {}) }}
          >
            {showBarNumbers && l.isBar && l.barNumber > 0 && (
              <span
                className="absolute top-0 left-0 text-[8px] font-mono leading-none select-none px-0.5 whitespace-nowrap"
                style={{
                  color: l.isPhrase ? 'rgba(251,191,36,0.95)' : 'rgba(203,213,225,0.85)',
                  textShadow: '0 0 3px rgba(0,0,0,0.9)',
                }}
              >
                Bar {l.barNumber}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
