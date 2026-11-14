// Detectors by package: how the Playground lists them.
//
// A package is a folder of detectors (tools/python/custom/<package>/), titled
// by its package.json. Each package is its own section, alphabetical by title,
// the user's own before shipped ones. Loose files — the ones not in any
// package — follow under the same Custom / Default titles every other list
// uses (see detectorOrigin.ts). With no packages at all the list is exactly
// what groupByDetectorOrigin gives.

import { DETECTOR_ORIGIN_TITLE, groupByDetectorOrigin } from './detectorOrigin';

interface Packaged {
  is_default: boolean;
  package?: string | null;
  package_title?: string | null;
}

export interface DetectorPackageGroup<T> {
  key: string;
  /** Section title — `null` only when this is the one and only section. */
  title: string | null;
  /** The package id, or `null` for the loose-files sections. */
  packageId: string | null;
  items: T[];
}

/** `empty` adds a section for each package that holds no detector here — a
 *  package just made, or one whose detectors are all archived — so it stays
 *  somewhere to move detectors into. */
export function groupByDetectorPackage<T extends Packaged>(
  items: readonly T[],
  empty: readonly { id: string; title: string; is_default: boolean }[] = [],
): DetectorPackageGroup<T>[] {
  const packages = new Map<string, T[]>();
  const loose: T[] = [];
  for (const it of items) {
    if (it.package) {
      const list = packages.get(it.package) ?? [];
      list.push(it);
      packages.set(it.package, list);
    } else {
      loose.push(it);
    }
  }
  const packaged = [...packages.entries()]
    .map(([id, list]) => ({ id, list, title: list[0].package_title || id, shipped: list.every((d) => d.is_default) }))
    .concat(empty.filter((p) => !packages.has(p.id))
      .map((p) => ({ id: p.id, list: [] as T[], title: p.title || p.id, shipped: p.is_default })))
    .sort((a, b) => Number(a.shipped) - Number(b.shipped) || a.title.localeCompare(b.title));

  const groups: DetectorPackageGroup<T>[] = packaged.map((p) => ({
    key: `package:${p.id}`, title: p.title, packageId: p.id, items: p.list,
  }));
  const origins = groupByDetectorOrigin(loose, (d) => d.is_default);
  for (const g of origins) {
    groups.push({
      key: `origin:${g.origin}`,
      // Beside a package, a loose group is always titled.
      title: g.title ?? (groups.length > 0 ? DETECTOR_ORIGIN_TITLE[g.origin] : null),
      packageId: null,
      items: g.items,
    });
  }
  if (groups.length === 1 && groups[0].packageId === null) groups[0].title = null;
  return groups;
}

export interface DetectorCluster<T> {
  /** The detectors' shared `group` — `null` for the untitled rest. */
  title: string | null;
  items: T[];
}

/** Inside one section, the detectors by their `group` (the family each one
 *  declares — Hits, Energy, Call & response …), alphabetical by group, each
 *  keeping its input order. The ones with no group come last under "Other" —
 *  or untitled, when nobody in the section declares a group, so a section of
 *  plain files stays the flat list it was. */
export function clusterByDetectorGroup<T extends { group?: string | null }>(items: readonly T[]): DetectorCluster<T>[] {
  const byGroup = new Map<string, T[]>();
  const rest: T[] = [];
  for (const it of items) {
    const g = it.group?.trim();
    if (!g) { rest.push(it); continue; }
    const list = byGroup.get(g) ?? [];
    list.push(it);
    byGroup.set(g, list);
  }
  if (byGroup.size === 0) return items.length ? [{ title: null, items: [...items] }] : [];
  const clusters: DetectorCluster<T>[] = [...byGroup.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([title, list]) => ({ title, items: list }));
  if (rest.length) clusters.push({ title: 'Other', items: rest });
  return clusters;
}
