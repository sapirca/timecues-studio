// Which beat grid an algorithm that cuts its features per beat runs on.
//
// MSAF, ruptures and LoCoMotif average their features over each beat. The
// annotator picks, per run, whose beats those are: the song's grid as they set
// it ('user', the default) or the algorithm's own tracked beats ('auto'). The
// sidecar records the choice under `grid` in the result, and a saved result is
// "done" only for the grid it was made on. All-In-One is not here: its model
// predicts beats and sections together and cannot be handed a grid.

export type AlgoGrid = 'user' | 'auto';

/** Does this algorithm (or a per-stem run of it, "<algo>__<stem>") take a grid? */
export function isGridCutAlgo(id: string): boolean {
  return id.startsWith('msaf-') || id.startsWith('ruptures-') || id.split('__')[0] === 'locomotif';
}

/** The grid a saved result was made on. Results from before the choice carry
 *  no `grid`, and every one of them was made on the algorithm's own beats. */
export function savedAlgoGrid(result: unknown): AlgoGrid {
  return (result as { grid?: unknown } | null | undefined)?.grid === 'user' ? 'user' : 'auto';
}

/** The lane badge for a grid-cut result (see GridSourceBadge). */
export function algoGridBadge(grid: AlgoGrid): string {
  return grid === 'user' ? 'my grid' : 'auto grid';
}
