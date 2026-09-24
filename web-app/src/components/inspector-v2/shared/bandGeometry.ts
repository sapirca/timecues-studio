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
