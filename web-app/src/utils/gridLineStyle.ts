// One place where a beat-grid line's *look* is decided.
//
// The grid is drawn on eight different surfaces — the WaveSurfer waveform, the
// frequency waveform, the EQ strip, every inspector lane row, and the five
// canvas heat-maps (spectrogram, cepstrogram, chromagram, SSM, tempogram).
// Each of those used to carry its own copy of the palette and its own width
// formula, so the same bar line came out white here, red there, 1 px on the
// waveform and 4 px on a lane row, solid in one place and dashed in another.
//
// Rendering still happens two ways — DOM divs for the surfaces that position
// by percent, canvas strokes for the ones that paint pixels — but both read
// their colour and width from here, in CSS pixels, so a line of a given kind
// is the same line everywhere. `components/GridLines.tsx` is the DOM half;
// `drawBeatGrid()` below is the canvas half.

import type { ResolvedSegment } from './gridSegments';
import { visibleGridLines } from './beatGrid';
import type { GridLine } from './beatGrid';

/** What a grid line means. Ordered by precedence — a pinned beat reads as
 *  pinned even when it also starts a bar. */
export type GridLineKind = 'overridden' | 'phrase' | 'bar' | 'subBeat' | 'beat';

/** The bits of a GridLine that decide its look. */
export interface GridLineShape {
  isBar: boolean;
  isPhrase: boolean;
  isSubBeat?: boolean;
  isOverridden?: boolean;
}

export function gridLineKind(line: GridLineShape): GridLineKind {
  if (line.isOverridden) return 'overridden';
  if (line.isPhrase) return 'phrase';
  if (line.isBar) return 'bar';
  if (line.isSubBeat) return 'subBeat';
  return 'beat';
}

/** Colour + base width (CSS px, before the user's thickness multiplier) per
 *  kind. The hierarchy: phrases carry the amber accent, bars are a readable
 *  white, beats a hairline, sub-beats barely there, pinned beats emerald so a
 *  curator can spot a hand-placed beat at a glance. */
export const GRID_LINE_STYLE: Record<GridLineKind, { color: string; width: number; halo: string }> = {
  overridden: { color: 'rgba(52,211,153,0.85)', width: 1,   halo: 'rgba(0,0,0,0.55)' },
  phrase:     { color: 'rgba(251,191,36,0.55)', width: 1,   halo: 'rgba(0,0,0,0.55)' },
  bar:        { color: 'rgba(255,255,255,0.38)', width: 1,   halo: 'rgba(0,0,0,0.50)' },
  beat:       { color: 'rgba(255,255,255,0.14)', width: 0.5, halo: 'rgba(0,0,0,0.30)' },
  subBeat:    { color: 'rgba(255,255,255,0.06)', width: 0.5, halo: 'rgba(0,0,0,0.16)' },
};

/** How much wider the halo is than the line it backs, in CSS px (split evenly
 *  either side). The grid is a light-on-dark palette, which disappears over the
 *  bright magma of the spectrogram, chromagram, tempogram and SSM. A dark halo
 *  costs nothing on a dark surface — black on near-black — and is what makes
 *  the same line readable over a hot orange one. */
export const GRID_HALO_EXTRA_PX = 1.5;

/** Tick caps and bar-number labels, for the surfaces that show them. */
export const GRID_CAP_COLOR   = { phrase: 'rgba(251,191,36,0.85)', bar: 'rgba(226,232,240,0.75)' } as const;
export const GRID_CAP_HEIGHT  = { phrase: 6, bar: 3 } as const;
export const GRID_LABEL_COLOR = { phrase: 'rgba(251,191,36,0.95)', bar: 'rgba(226,232,240,0.85)' } as const;

/** Colour, halo and width (CSS px) for one line at the user's thickness
 *  setting. `haloWidth` is what the halo is stroked at; the core goes on top. */
export function gridLineStyle(line: GridLineShape, thickness = 1): {
  color: string; width: number; halo: string; haloWidth: number;
} {
  const { color, width, halo } = GRID_LINE_STYLE[gridLineKind(line)];
  const w = width * thickness;
  return { color, width: w, halo, haloWidth: w + GRID_HALO_EXTRA_PX };
}

// ── Canvas half ──────────────────────────────────────────────────────────────

export interface DrawBeatGridOptions {
  /** Canvas backing-store size, i.e. already multiplied by `dpr`. */
  W: number;
  H: number;
  dpr?: number;
  /** User's grid-thickness multiplier (see `effectiveGridLineThickness`). */
  thickness?: number;
  duration: number;
  bpm?: number;
  /** Fallback grid origin when `beatOffset` is 0 — the first detected beat. */
  beatTimes?: number[];
  beatOffset?: number;
  beatsPerBar?: number;
  barGroupSize?: number | null;
  subBeatDivision?: number;
  beatGroupSize?: number;
  beatOverrides?: Readonly<Record<string, number>>;
  segments?: readonly ResolvedSegment[];
  /** Drop lines that would land closer together than this many CSS px. */
  minSpacingPx?: number;
}

/**
 * Draw the beat/bar grid onto a canvas, in the same colours and widths the DOM
 * surfaces use. `W`/`H` are backing-store pixels, so widths are scaled by
 * `dpr` here; a stroke is centred on its time, which is what the DOM half does
 * too (see GridLines' `marginLeft`).
 */
export function drawBeatGrid(ctx: CanvasRenderingContext2D, opts: DrawBeatGridOptions): void {
  const {
    W, H, dpr = 1, thickness = 1, duration, bpm, beatTimes, beatOffset = 0,
    beatsPerBar = 4, barGroupSize, subBeatDivision, beatGroupSize,
    beatOverrides, segments, minSpacingPx = 5,
  } = opts;
  if (!duration || !bpm) return;

  const origin = beatOffset > 0 ? beatOffset : (beatTimes && beatTimes.length > 0 ? beatTimes[0] : 0);
  const lines = visibleGridLines({
    bpm, gridOffset: origin, beatsPerBar,
    startTime: 0, endTime: duration,
    barGroupSize: barGroupSize ?? null,
    subBeatDivision,
    beatGroupSize,
    beatOverrides,
    segments,
  });
  if (lines.length < 2) return;

  // Cull lines that would render closer than `minSpacingPx` — at low zoom every
  // line becomes a hairline blur otherwise. The step is measured in beat
  // divisions so sub-beat (8th/16th) lines thin out along with the beats.
  const dense = barGroupSize == null;
  const div = (dense && subBeatDivision && subBeatDivision > 1) ? Math.floor(subBeatDivision) : 1;
  const pxPerStep = ((60 / bpm) / div / duration) * (W / dpr);
  const step = dense ? Math.max(1, Math.ceil(minSpacingPx / pxPerStep)) : 1;

  ctx.save();
  for (let i = 0; i < lines.length; i++) {
    if (step > 1 && i % step !== 0) continue;
    const line = lines[i];
    const { color, width, halo, haloWidth } = gridLineStyle(line, thickness);
    const x = (line.t / duration) * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H);
    ctx.strokeStyle = halo;
    ctx.lineWidth = haloWidth * dpr;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = width * dpr;
    ctx.stroke();
  }
  ctx.restore();
}

export type { GridLine };
