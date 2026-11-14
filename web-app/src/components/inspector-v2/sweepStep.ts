/** The karaoke sweep position handed to the chip grid, the block editor and
 *  Tap Along, at the precision they consume. A live Tap Along session samples
 *  the exact fractional step at each press, and the block editor and piano
 *  roll draw a cursor at the fraction, so `fractional` keeps it whole. The
 *  chip grid alone only asks for `Math.floor` (the played trail) and
 *  `Math.round` (the ring a tap would land on), and both of those are fixed
 *  by the half-step the position is in — so without the others, the sweep
 *  changes twice a step instead of every frame. */
export function sweepStep(step: number, fractional: boolean): number {
  return fractional ? step : Math.floor(step * 2) / 2;
}
