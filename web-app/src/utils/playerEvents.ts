// Lets any part of the app pause the main audio transport without a ref into
// PlayerPanel. The three inspector tabs (Dataprep / Annotator / Algo Inspect)
// share one mounted InspectorPageV2 + WaveSurfer instance, so switching between
// them does NOT unmount the player — playback would keep running across a tab
// change unless we explicitly pause it first. WorkspaceTabHeader fires this on
// every tab click; PlayerPanel listens and calls ws.pause().
export const PAUSE_PLAYBACK_EVENT = 'tcz:pausePlayback';

export function requestPausePlayback(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PAUSE_PLAYBACK_EVENT));
}
