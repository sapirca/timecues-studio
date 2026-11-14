/**
 * Geometry shared by the interval lanes — Spans and Loops — where an item is
 * drawn as a band whose left/width are a percentage of the whole song.
 *
 * Both numbers exist for the same reason: a band can be drawn narrower than a
 * hand can aim at, and the fixes for that must not lie about where the item
 * sits in the audio.
 */

/** Floor for a band's drawn width, in PIXELS — enough that a very short item
 *  stays visible and clickable.
 *
 *  It has to be a screen measure, not a musical one. The floor used to be
 *  0.5% of the SONG, which is a fixed slice of the timeline rather than of the
 *  viewport: a 1.7 s span in a six-minute track was drawn 1.8 s wide at every
 *  zoom, so the deeper you zoomed the further its right edge sat past the beat
 *  it was actually snapped to — a correctly-snapped item that looked like the
 *  snap had failed, and an edge handle that wasn't over the edge. In pixels
 *  the fudge is a couple of pixels at fit zoom and nothing at all as soon as
 *  the band is wide enough to read. */
export const MIN_BAND_PX = 4;

/** An edge handle keeps its fixed width until it would claim more than this
 *  share of the band. Without the cap the two handles meet in the middle of a
 *  narrow band and swallow the body, so every drag resized the item instead of
 *  moving it — the gesture the user reaches for first. */
export const EDGE_HANDLE_MAX_SHARE = '30%';

/** The start edge of an interval band: a 2px stripe of the band's colour at
 *  full strength, brighter than the washed body, so back-to-back items read
 *  as two items and the stripe reads as "begins here" rather than as one more
 *  of the 1px beat / pulse ticks drawn inside the band.
 *
 *  An inset shadow, never a border. A border is layout: it moved the band's
 *  padding box — which is what every absolutely-placed child (snap tick,
 *  pulse ticks, energy curve, groove hits, edge handles) is positioned
 *  against — 2px right of the band's time and squeezed it 4px short, so the
 *  contents sat off the grid line the band itself was snapped to. The end
 *  used to carry a 2px notch in the lane colour too, which drew every band
 *  ending 2px before its time and opened a gap between items that touch;
 *  the next item's own start stripe already marks that seam, exactly on it.
 *
 *  Compose it into the band's `boxShadow` with `withBandStart`. */
export function bandStartShadow(color: string): string {
  return `inset 2px 0 0 ${color}`;
}

/** `boxShadow` for a band: its start stripe first — the first shadow in the
 *  list paints on top, so a focus / active ring never hides where it begins. */
export function withBandStart(color: string, boxShadow?: string): string {
  return boxShadow ? `${bandStartShadow(color)}, ${boxShadow}` : bandStartShadow(color);
}
