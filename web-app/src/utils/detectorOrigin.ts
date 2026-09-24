// Default vs Custom: where a detector came from, and how every list titles it.
//
// Shipped detectors live in tools/python/custom-default/ (the registry marks
// them `is_default`); the user's own live in tools/python/custom/. Every list
// of detectors in the app splits them under those two titles, the same way
// everywhere. When one side is empty the titles would only label the one list
// there is, so they are left off and the list renders flat.

export type DetectorOrigin = 'default' | 'custom';

export interface DetectorOriginGroup<T> {
  origin: DetectorOrigin;
  /** Section title — `null` when the other group is empty (render flat). */
  title: string | null;
  items: T[];
}

export const DETECTOR_ORIGIN_TITLE: Record<DetectorOrigin, string> = {
  default: 'Default',
  custom: 'Custom',
};

/** Split `items` into Custom (the user's own) then Default (shipped), keeping each side's input order.
 *  Empty groups are dropped; titles are set only when both groups have items. */
export function groupByDetectorOrigin<T>(
  items: readonly T[],
  isDefault: (item: T) => boolean,
): DetectorOriginGroup<T>[] {
  const defaults = items.filter((it) => isDefault(it));
  const custom = items.filter((it) => !isDefault(it));
  const titled = defaults.length > 0 && custom.length > 0;
  const groups: DetectorOriginGroup<T>[] = [];
  if (custom.length > 0) groups.push({ origin: 'custom', title: titled ? DETECTOR_ORIGIN_TITLE.custom : null, items: custom });
  if (defaults.length > 0) groups.push({ origin: 'default', title: titled ? DETECTOR_ORIGIN_TITLE.default : null, items: defaults });
  return groups;
}
