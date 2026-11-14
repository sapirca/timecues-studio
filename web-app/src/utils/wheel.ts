/** Whether a wheel event is a sideways swipe — the only kind the timeline's
 *  wheel handlers may take over (and `preventDefault`).
 *
 *  A vertical two-finger swipe on a trackpad almost never has `deltaX === 0`:
 *  it drifts a pixel or two sideways. Cancelling it for that drift cancels the
 *  vertical scroll with it, and since Chrome settles a whole gesture by its
 *  first event, the page ignored the swipe outright — "the scroll was missed,
 *  do it again". So a swipe is sideways only when it is mostly sideways;
 *  anything else is left to the browser, which scrolls both axes natively. */
export function isHorizontalWheel(e: WheelEvent): boolean {
  return Math.abs(e.deltaX) > Math.abs(e.deltaY);
}
