import { annotatorHeaders } from '../utils/annotatorHeaders';

export interface TeamStatsSourceStats {
  count: number;
  reviewedCount: number;
  totalTimeSeconds: number;
  totalBoundaries: number;
  lastModified: string | null;
  songs: string[];
}

export interface TeamStatsCustomStats {
  count: number;
  scripts: string[];
  songs: string[];
}

export interface TeamStatsAnnotator {
  id: string;
  manual: TeamStatsSourceStats;
  eye: TeamStatsSourceStats;
  autoGuess: TeamStatsSourceStats;
  custom: TeamStatsCustomStats;
  totalTimeSeconds: number;
  totalAnnotations: number;
  lastModified: string | null;
}

export interface TeamStatsResponse {
  annotators: TeamStatsAnnotator[];
  multiAnnotatorSongs: string[];
}

export async function fetchTeamStats(): Promise<TeamStatsResponse> {
  const res = await fetch('/api/team-stats', { headers: annotatorHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<TeamStatsResponse>;
}
