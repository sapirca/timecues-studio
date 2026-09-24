/**
 * Format seconds as `m:ss[.fraction]`. `decimals` controls the fractional
 * digits: 0 truncates to whole seconds (matches the karaoke display), 1/3
 * round via toFixed (matches the annotation-editor and anchor-list
 * displays). Non-finite or negative input renders as the zero fallback.
 */
export function formatClockTime(t: number, decimals: 0 | 1 | 2 | 3 = 1): string {
  if (!Number.isFinite(t) || t < 0) {
    return decimals === 0 ? '0:00' : `0:00.${'0'.repeat(decimals)}`;
  }
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  if (decimals === 0) {
    return `${m}:${Math.floor(s).toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toFixed(decimals).padStart(3 + decimals, '0')}`;
}
