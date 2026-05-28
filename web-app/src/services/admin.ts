import { annotatorHeaders } from '../utils/annotatorHeaders';
import type { AccessTier, PersonEntry } from '../types/datasetConfig';

export type AdminMode = 'people-by-email' | 'allowlist' | 'bootstrap';

export interface AdminStatus {
  annotatorId: string | null;
  /** Effective access tier. null means "public" (data-default/ only). */
  tier: AccessTier | null;
  /** True when tier === 'admin'. Convenience flag mirroring tier. */
  isAdmin: boolean;
  /** True when tier === 'admin' or 'researcher'. Gates the Team Dashboard,
   *  upload/delete songs, see-all-annotators, full-dataset export. */
  isResearcher: boolean;
  /** True when the annotator is on the team (any non-public tier). */
  isOnTeam: boolean;
  /** How tiers are currently resolved. 'bootstrap' = no admin attached yet,
   *  every signed-in user counts as admin. */
  mode: AdminMode;
  /** Total entries per tier (always returned). */
  adminCount: number;
  teamCount: number;
  researcherCount: number;
  /** Full per-email people map — only present when the requester is admin
   *  or researcher. The single source of truth for tier assignments. */
  peopleByEmail?: Record<string, PersonEntry> | null;
  /** Legacy admin allowlist — only present when requester is admin/researcher.
   *  Kept in sync with peopleByEmail for backward compat. */
  adminEmails?: string[];
  /** Legacy team allowlist — only present when requester is admin/researcher. */
  teamEmails?: string[];
}

export async function fetchAdminStatus(): Promise<AdminStatus> {
  const res = await fetch('/api/admin-status', { headers: annotatorHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<AdminStatus>;
}
