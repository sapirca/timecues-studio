import type { CustomResultEnvelope } from '../../../types/customScript';

/**
 * Raw detector output object for a synthetic detector-layer item.
 *
 * Detector layers are derived from a cached detector run; each synthetic item
 * carries an id of the form `${detName}:${index}:${ms}`, where `index` points
 * back into the run's envelope `items[]`. Given the layer's `source`
 * (`detector:<name>`) and the item id, this returns the original emitted item
 * (a Custom*Item) so a read-only card can show the model's raw output.
 *
 * Returns undefined for user layers, or when the envelope / index can't be
 * resolved (e.g. the run was evicted from the cache).
 */
export function rawDetectorItem(
  source: string | undefined,
  itemId: string,
  results: Record<string, CustomResultEnvelope>,
): unknown {
  if (!source || !source.startsWith('detector:')) return undefined;
  const env = results[source.slice('detector:'.length)];
  if (!env || !Array.isArray(env.items)) return undefined;
  // The index is the second-to-last colon segment (the last is the ms stamp);
  // detector names don't contain colons, but slicing from the end is robust.
  const parts = itemId.split(':');
  const idx = Number(parts[parts.length - 2]);
  if (!Number.isInteger(idx) || idx < 0 || idx >= env.items.length) return undefined;
  return env.items[idx];
}
