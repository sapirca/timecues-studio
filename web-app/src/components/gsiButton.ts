/** Google's rendered button accepts a width between 200 and 400 px and
 *  otherwise keeps whatever it was given, overflowing a narrow parent. 320
 *  is the width it has always had on desktop; on a phone the card is
 *  narrower than that, so the button shrinks to the container it sits in
 *  instead of poking out past the card's edge. */
export const GSI_BUTTON_MAX_WIDTH = 320;
export const GSI_BUTTON_MIN_WIDTH = 200;

export function gsiButtonWidth(containerWidth: number): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return GSI_BUTTON_MAX_WIDTH;
  return Math.max(GSI_BUTTON_MIN_WIDTH, Math.min(GSI_BUTTON_MAX_WIDTH, Math.floor(containerWidth)));
}

/** Options for `renderButton`. The locale is pinned to English: left alone,
 *  Google picks the browser's language, so a phone set to Hebrew showed a
 *  right-to-left button inside an otherwise English card. */
export function gsiButtonOptions(width: number): Record<string, unknown> {
  return {
    theme: 'filled_black',
    size: 'large',
    width,
    shape: 'pill',
    locale: 'en',
  };
}
