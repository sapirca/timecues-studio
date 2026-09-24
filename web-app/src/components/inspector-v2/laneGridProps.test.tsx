/**
 * Every lane draws the grid the user asked for — the whole grid.
 *
 * Each lane used to declare its own narrow `gridProps` shape and forward the
 * handful of fields it happened to know about, so a grid unit finer than a
 * beat (1/3 beat, 1/6, 1/8 …) reached the player and the waveforms and no
 * annotation lane at all: the same song, ruled two different ways, one row
 * apart. Structural typing had nothing to complain about — a narrower shape
 * accepts the wider bundle and silently drops the rest — which is why this is
 * a test and not a type. It renders each lane with a triplet grid and looks
 * for the lines between the beats.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SpanLaneRow } from './SpanLaneRow';
import { CueLayerRow } from './CueLayerRow';
import { LoopLayerRow } from './LoopLayerRow';
import { LyricsLayerRow } from './LyricsLayerRow';
import { RiffPatternLaneRow } from './RiffPatternLaneRow';
import { LeadLaneRow } from './LeadLaneRow';
import { newRiffPatternLayer } from '../../types/annotationLayer';
import type { LaneGridProps } from './BeatGridOverlay';

const DURATION = 4;        // seconds
const BPM = 120;           // → a beat every 0.5 s
const BEAT = 60 / BPM;

const GRID: LaneGridProps = { bpm: BPM, gridOffset: 0, beatsPerBar: 4 };
const TRIPLETS: LaneGridProps = { ...GRID, subBeatDivision: 3 };

/** Times (seconds) of every grid line the lane drew, read back off the
 *  overlay's `left: %` positions. */
function gridTimes(root: HTMLElement): number[] {
  const overlay = root.querySelector('.absolute.inset-0.pointer-events-none.overflow-hidden');
  if (!overlay) return [];
  return Array.from(overlay.children).map(
    (el) => (parseFloat((el as HTMLElement).style.left) / 100) * DURATION,
  );
}

function hasLineAt(times: number[], t: number): boolean {
  return times.some((x) => Math.abs(x - t) < 1e-6);
}

const LANES: [string, (grid: LaneGridProps) => React.ReactElement][] = [
  ['SpanLaneRow',        (g) => <SpanLaneRow items={[]} color="#38bdf8" duration={DURATION} currentTime={0} gridProps={g} />],
  ['CueLayerRow',        (g) => <CueLayerRow items={[]} color="#4ade80" duration={DURATION} currentTime={0} gridProps={g} />],
  ['LoopLayerRow',       (g) => <LoopLayerRow items={[]} color="#f472b6" duration={DURATION} currentTime={0} gridProps={g} />],
  ['LyricsLayerRow',     (g) => <LyricsLayerRow items={[]} color="#fbbf24" duration={DURATION} currentTime={0} gridProps={g} />],
  ['RiffPatternLaneRow', (g) => <RiffPatternLaneRow layer={newRiffPatternLayer('Riffs', '#38bdf8')} duration={DURATION} currentTime={0} gridProps={g} />],
  ['LeadLaneRow',        (g) => <LeadLaneRow candidates={[]} duration={DURATION} currentTime={0} gridProps={g} />],
];

describe('lane grid props', () => {
  for (const [name, renderLane] of LANES) {
    it(`${name} draws the sub-beat lines of a 1/3-beat grid`, () => {
      const { container, unmount } = render(renderLane(TRIPLETS));
      const times = gridTimes(container);
      expect(hasLineAt(times, BEAT / 3)).toBe(true);
      expect(hasLineAt(times, (2 * BEAT) / 3)).toBe(true);
      expect(hasLineAt(times, BEAT)).toBe(true);
      unmount();
    });

    it(`${name} rules beats only when no subdivision was asked for`, () => {
      const { container, unmount } = render(renderLane(GRID));
      const times = gridTimes(container);
      expect(hasLineAt(times, BEAT)).toBe(true);
      expect(hasLineAt(times, BEAT / 3)).toBe(false);
      unmount();
    });
  }
});
