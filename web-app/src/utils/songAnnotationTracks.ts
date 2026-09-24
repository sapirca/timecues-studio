// Per-song annotation tracks, as the song sidebar reads them.
//
// One song's annotation state is a handful of tracks — the layer types the user
// authored, plus the algorithm-produced auto-guess — each carrying its own
// workflow stage. The sidebar collapses them into ONE indicator dot (every
// track records the same kind of thing: marker positions), lists them in a
// popover, and — when the list is grouped by annotation status — files the song
// under the collapsed verdict. All three have to agree, so the collapse happens
// exactly once, here.

import { derivePillDisplay, type AnnotationPillDisplay } from '../types/annotationLayer';
import type { SongLayerStatuses } from '../services/annotationLayers';
import type { AutoGuessSongStatus } from '../services/autoGuessAnnotations';

export type TrackKind =
  | 'boundaries' | 'autoGuess' | 'cues' | 'spans' | 'loops'
  | 'lyrics' | 'riff-patterns';

/** Tracks split two ways: **manual** (user-authored — Boundaries, Cues, Spans,
 *  Loops, Riff Patterns, Lyrics) and **auto** (algorithm-produced — auto-guess).
 *  Only manual tracks gate the green ✓: requiring machine output to be
 *  "reviewed" would hold the indicator hostage to something the user never
 *  wrote. Auto tracks are still listed, below a divider. */
export interface SongTrack {
  kind: TrackKind;
  label: string;
  state: AnnotationPillDisplay;
  detail?: string;
  color: string;
  group: 'manual' | 'auto';
}

/** Collapsed verdict over a song's MANUAL tracks. */
export type OverallAnnotationState = 'none' | 'in_progress' | 'all_reviewed';

export interface SongTrackSummary {
  tracks: SongTrack[];
  manualTracks: SongTrack[];
  autoTracks: SongTrack[];
  manualReviewedCount: number;
  overall: OverallAnnotationState;
}

const LAYER_COLORS: Record<string, string> = {
  boundaries: 'amber',
  cues: 'emerald', spans: 'sky', loops: 'pink', lyrics: 'fuchsia',
  'riff-patterns': 'cyan',
};

/** Fixed display order, so a song's rows don't reshuffle between the LIST
 *  endpoint's file order and the live document order of the open song. */
const TYPE_ORDER = ['boundaries', 'cues', 'spans', 'loops', 'riff-patterns', 'lyrics'];

const LAYER_LABELS: Record<string, string> = {
  boundaries: 'Boundaries',
  cues: 'Cues', spans: 'Spans', loops: 'Loops', lyrics: 'Lyrics',
  'riff-patterns': 'Riff Patterns',
};

/** Every track a song actually has, plus the collapsed verdict over the manual
 *  ones.
 *
 *  A track appears only once it has at least one item — there is no
 *  "Not started" row, because there would be no markers behind it. That matches
 *  the StatusPill's "Not started ⇔ no items" contract, and it is why
 *  `derivePillDisplay` is always called with `hasItems = true` here. */
export function deriveSongTracks(args: {
  layerSummary: SongLayerStatuses | undefined;
  autoGuess: AutoGuessSongStatus | undefined;
  /** Mirrors settings.experimentalLoopsAndPatterns. With the flag off the
   *  editor doesn't render those layers (loops AND riff-patterns —
   *  the same flag gates all three), so counting them here produced phantom
   *  "in progress" songs the user could neither see nor edit. */
  includeLoopsAndPatterns: boolean;
}): SongTrackSummary {
  const { layerSummary, autoGuess, includeLoopsAndPatterns } = args;
  const tracks: SongTrack[] = [];

  if (layerSummary) {
    const entries = Object.entries(layerSummary.layers).sort(
      ([a], [b]) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b),
    );
    for (const [type, info] of entries) {
      if (!info || info.count === 0) continue;
      if ((type === 'loops' || type === 'riff-patterns') && !includeLoopsAndPatterns) continue;
      tracks.push({
        kind: type as TrackKind,
        label: LAYER_LABELS[type] ?? type,
        state: derivePillDisplay(true, info.status),
        detail: `${info.count} item${info.count === 1 ? '' : 's'}`,
        color: LAYER_COLORS[type] ?? 'slate',
        group: 'manual',
      });
    }
  }

  if (autoGuess && (autoGuess.points_count ?? 0) > 0) {
    tracks.push({
      kind: 'autoGuess',
      label: 'Auto-guess',
      state: derivePillDisplay(true, autoGuess.auto_guess_status === 'done' ? 'reviewed' : 'in_progress'),
      detail: `${autoGuess.points_count} point${autoGuess.points_count === 1 ? '' : 's'}`,
      color: 'violet',
      group: 'auto',
    });
  }

  const manualTracks = tracks.filter((t) => t.group === 'manual');
  const autoTracks = tracks.filter((t) => t.group === 'auto');
  const manualReviewedCount = manualTracks.filter((t) => t.state === 'reviewed').length;
  const overall: OverallAnnotationState =
    manualTracks.length === 0 ? 'none' :
    manualReviewedCount === manualTracks.length ? 'all_reviewed' :
    'in_progress';

  return { tracks, manualTracks, autoTracks, manualReviewedCount, overall };
}
