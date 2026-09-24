import type { GridMode } from '../../../types/songInfo';

/** Plain-language names for the three grid modes. The stored values — and the
 *  names used in the data files — remain `static` / `mapped` / `manual`;
 *  these are what the curator reads in /prep. */
export const MODE_LABEL: Record<GridMode, string> = {
  static: 'Steady',
  mapped: 'Mapped',
  manual: 'Hand-placed',
};

/** One line under the tempo-mode picker saying what the active mode does.
 *  Replaces the old info-dot: the explanation is always on screen for the
 *  mode you're actually in, instead of hidden behind a hover for all of them. */
export const MODE_BLURB: Record<GridMode, string> = {
  static: 'One tempo for the whole song. Switching modes never deletes the others’ work.',
  mapped: 'A tempo map: each marker starts a new bar 1 with its own tempo and meter.',
  manual: 'Beats you pin by hand, riding on top of a base grid.',
};
