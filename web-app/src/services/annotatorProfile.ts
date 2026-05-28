import type { Annotator } from '../types/annotator';
import { annotatorHeaders } from '../utils/annotatorHeaders';

/** Fetch an annotator profile by id. Returns null on 404 or network error. */
export async function fetchProfileById(id: string): Promise<Annotator | null> {
  try {
    const r = await fetch(`/api/annotators/profile/${encodeURIComponent(id)}`);
    if (r.status === 404) return null;
    if (!r.ok) return null;
    return (await r.json()) as Annotator;
  } catch {
    return null;
  }
}

/** Persist the annotator profile on the server. Idempotent — the server
 *  refuses to overwrite an existing record from an anonymous caller. Fire-
 *  and-forget; failures are non-fatal (the local sign-in still works). */
export async function saveProfile(a: Annotator): Promise<void> {
  try {
    await fetch('/api/annotators/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(a),
    });
  } catch {
    /* non-fatal */
  }
}

export interface InvitePayload {
  /** Username or email — same validation as the login screen's identity
   *  field (IDENTITY_RE in types/annotator.ts). */
  identity: string;
  /** Which sign-in form this invitee is expected to use.
   *  - `'google'`   — `identity` must be a valid email; the profile is
   *                   stored under that email with no prefix, matching what
   *                   Google OAuth produces at sign-in.
   *  - `'identity'` — self-attested; profile is stored under `local-…`.
   *                   For email-shaped identities the server also pre-
   *                   authorises the Google-form id so the invitee can sign
   *                   in via either route. */
  authMethod: 'google' | 'identity';
  displayName: string;
  role?: string;
  affiliation?: string;
  /** Access tier the invitee will land on. See AccessTier in
   *  types/datasetConfig.ts for what each tier unlocks. */
  tier: 'team' | 'researcher' | 'admin';
}

/** Admin-only: create a profile for a teammate and add their email to the
 *  team or admin allowlist in one server-side operation. */
export async function inviteAnnotator(payload: InvitePayload): Promise<Annotator> {
  const r = await fetch('/api/annotators/invite', {
    method: 'POST',
    headers: annotatorHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => `HTTP ${r.status}`);
    throw new Error(msg || `HTTP ${r.status}`);
  }
  return (await r.json()) as Annotator;
}

/** Admin-only: list every saved annotator profile. */
export async function fetchAllProfiles(): Promise<Annotator[]> {
  const r = await fetch('/api/annotators/profiles', { headers: annotatorHeaders() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = (await r.json()) as { profiles: Annotator[] };
  return j.profiles ?? [];
}

/** Admin-only: remove a saved profile. Does NOT touch annotation files on
 *  disk — those are kept around so the work isn't lost. */
export async function deleteProfile(id: string): Promise<void> {
  const r = await fetch(`/api/annotators/profile/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: annotatorHeaders(),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}
