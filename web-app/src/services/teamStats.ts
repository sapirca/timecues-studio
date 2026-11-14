import { annotatorHeaders } from '../utils/annotatorHeaders';

/** Per-layer-type tally for one annotator: `count` songs hold at least one
 *  item of this type, `reviewedCount` of them are marked reviewed. */
export interface TeamStatsLayerStats {
  count: number;
  reviewedCount: number;
  totalItems: number;
  songs: string[];
}

export interface TeamStatsCustomStats {
  count: number;
  scripts: string[];
  songs: string[];
}

export interface TeamStatsAnnotator {
  id: string;
  songCount: number;
  layers: Record<string, TeamStatsLayerStats>;
  custom: TeamStatsCustomStats;
  totalTimeSeconds: number;
  totalAnnotations: number;
  lastModified: string | null;
}

export interface TeamStatsResponse {
  /** Layer types in display order. */
  layerTypes: string[];
  annotators: TeamStatsAnnotator[];
  multiAnnotatorSongs: string[];
}

export async function fetchTeamStats(): Promise<TeamStatsResponse> {
  const res = await fetch('/api/team-stats', { headers: annotatorHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<TeamStatsResponse>;
}
