/** A label part's zoomed-out form: the units shortened to a letter or two, so
 *  a one-bar band can still say what rate it's hitting at. "Beat" → "1b",
 *  "1/2 beat" → "1/2b", "Bar" → "1br", "24 bars" → "24br". Anything that isn't
 *  a count of beats or bars (the instrument) comes back unchanged. */
export function compactBandLabelPart(part: string): string {
  const m = /^(\d+(?:\/\d+)?)?\s*(beats?|bars?)$/i.exec(part.trim());
  if (m) return `${m[1] ?? '1'}${m[2].toLowerCase().startsWith('beat') ? 'b' : 'br'}`;
  if (/^triplets?$/i.test(part.trim())) return 'trip';
  return part;
}
