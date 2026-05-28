import { makeEmptySongInfo, type SongInfo } from '../types/songInfo';
import { annotatorHeaders } from '../utils/annotatorHeaders';
import { getIsDemo } from '../state/demoFlag';
import { demoLoadSongInfo, demoSaveSongInfo } from './demoStorage';

/** Load song info; the server seeds from any legacy manual/eye annotation fields on first read.
 *  In Demo Mode, any local edit overrides the canonical server copy so the user's tweaks
 *  to BPM / grid offset survive a refresh without touching the shared dataset. */
export async function loadSongInfo(slug: string): Promise<SongInfo> {
  if (getIsDemo()) {
    const local = demoLoadSongInfo(slug);
    if (local) return local;
  }
  try {
    const res = await fetch(`/api/song-info/${encodeURIComponent(slug)}`);
    if (!res.ok) return makeEmptySongInfo(slug);
    const data = await res.json();
    return data ?? makeEmptySongInfo(slug);
  } catch {
    return makeEmptySongInfo(slug);
  }
}

/** Persist song info. In Demo Mode writes go to localStorage only — never to the server. */
export async function saveSongInfo(slug: string, info: SongInfo): Promise<boolean> {
  if (getIsDemo()) return demoSaveSongInfo(slug, info);
  try {
    const res = await fetch(`/api/song-info/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(info, null, 2),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Load song info for many slugs in parallel. Used by the sidebar to drive
 *  per-song readiness indicators without waiting for each row to be selected. */
export async function loadAllSongInfo(slugs: readonly string[]): Promise<Record<string, SongInfo>> {
  const entries = await Promise.all(slugs.map(async (slug) => {
    const info = await loadSongInfo(slug);
    return [slug, info] as const;
  }));
  const map: Record<string, SongInfo> = {};
  for (const [slug, info] of entries) map[slug] = info;
  return map;
}
