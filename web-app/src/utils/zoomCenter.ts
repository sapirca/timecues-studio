// What a ± zoom step puts in the middle of the viewport.
//
// Pulled out of PlayerPanel as a pure function because it is a *rule*, not a
// rendering detail: the page nominates a focus (a range with its picker open,
// the highlighted region, a selected item) and that always wins; with nothing
// nominated the playhead is the anchor. Which of those two applies decides
// where the user lands on every zoom, so it is worth being able to test it
// without a browser.
export function zoomCenterFor(
  focus: number | null | undefined,
  playhead: number,
  duration: number,
): number {
  const t = focus != null && Number.isFinite(focus) ? focus : playhead;
  const safe = Number.isFinite(t) ? t : 0;
  // Clamping is what lets the caller be unconditional about the playhead: near
  // either end of the track the viewport stops at the edge and the anchor sits
  // off-centre, rather than the caller having to refuse to follow it there.
  return duration > 0 ? Math.max(0, Math.min(duration, safe)) : Math.max(0, safe);
}
