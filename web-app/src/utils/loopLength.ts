// A loop's length in plain words, as Butler's sound-palette tables give it
// (Unlocking the Groove, p. 180): "1 bar", "½ bar", "1½ beats". The words
// alone — a note value beside them ("2" + a whole note) read as a second "2".

const FRACTIONS: [number, string][] = [
  [1 / 4, '¼'], [1 / 3, '⅓'], [1 / 2, '½'], [2 / 3, '⅔'], [3 / 4, '¾'],
];
const EPS = 1e-6;

/** "1", "½", "1½" — or null when the value isn't a whole number plus one of
 *  the common fractions, so the caller can fall back to decimals. */
function friendlyNumber(x: number): string | null {
  const whole = Math.floor(x + EPS);
  const frac = x - whole;
  if (frac < EPS) return String(whole);
  const hit = FRACTIONS.find(([v]) => Math.abs(frac - v) < EPS);
  if (!hit) return null;
  return whole === 0 ? hit[1] : `${whole}${hit[1]}`;
}

/** A loop's length in plain words: bars when it is a whole or half number of
 *  bars, beats otherwise. */
export function loopLengthWords(beats: number, beatsPerBar = 4): string {
  if (!(beats > 0)) return '';
  const bpb = Math.max(1, beatsPerBar);
  const bars = beats / bpb;
  const barsIsHalves = Math.abs(bars * 2 - Math.round(bars * 2)) < EPS;
  if (barsIsHalves) {
    const n = friendlyNumber(bars)!;
    return `${n} ${bars > 1 + EPS ? 'bars' : 'bar'}`;
  }
  const n = friendlyNumber(beats) ?? String(+beats.toFixed(2));
  return `${n} ${beats > 1 + EPS ? 'beats' : 'beat'}`;
}
