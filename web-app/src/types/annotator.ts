/** Identity provider for the sign-in method that produced this annotator.
 *
 *  - `google`   — verified via Google OAuth; id = sanitized email (no prefix).
 *  - `identity` — self-attested handle (any string that passes IDENTITY_RE,
 *                 including an email address); id = `local-<sanitized>`.
 *  - `email` / `username` — legacy values kept for backward compatibility
 *                 with profiles written before the unified flow. New sign-ins
 *                 must use one of the two values above. */
export type AuthMethod = 'google' | 'identity' | 'email' | 'username';

export interface Annotator {
  /** Canonical id used as on-disk subdirectory name. Sanitized & filesystem-safe. */
  id: string;
  /** Human-friendly name shown in the UI. */
  displayName: string;
  email?: string;
  role?: string;
  affiliation?: string;
  authMethod: AuthMethod;
  createdAt: string;
}

/** Accepted identity input: letters, digits, dot, underscore, hyphen, `@`.
 *  Explicitly forbids spaces and other punctuation. Email addresses pass
 *  because they're a subset of this alphabet — the field is "username or
 *  email", not two separate flows. */
export const IDENTITY_RE = /^[A-Za-z0-9._@-]+$/;

/** Minimum length for the identity field. Two chars is the same floor the
 *  legacy username flow used. */
export const IDENTITY_MIN_LEN = 2;

/** True iff `value` is a syntactically valid identity input. */
export function isValidIdentity(value: string): boolean {
  const v = value.trim();
  return v.length >= IDENTITY_MIN_LEN && IDENTITY_RE.test(v);
}

const ID_REPLACE = /[^a-z0-9._@+\-]/g;

function basicSanitize(raw: string): string {
  return raw.trim().toLowerCase().replace(ID_REPLACE, '_').replace(/\.{2,}/g, '_').replace(/^\.+/, '_');
}

/** Build the canonical annotator id from a sign-in choice.
 *
 *  Google ids carry no prefix so that an admin who adds `jane@example.com`
 *  to the access list reaches the same id Google issues at sign-in.
 *  Identity ids are namespaced under `local-` so a self-attested user
 *  typing a Google user's address cannot impersonate them. */
export function buildAnnotatorId(input: {
  method: AuthMethod;
  email?: string;
  username?: string;
  identity?: string;
}): string {
  if (input.method === 'google') {
    if (!input.email) throw new Error('email required');
    return basicSanitize(input.email);
  }
  // All non-Google methods funnel through the same `local-<sanitized>` form.
  // Legacy callers may pass `username` or `email`; new callers pass `identity`.
  const raw = input.identity ?? input.username ?? input.email;
  if (!raw) throw new Error('identity required');
  const u = basicSanitize(raw);
  return `local-${u}`;
}

/** Set of id forms to try when looking up an existing profile for a typed
 *  identity. Returns the new `local-…` id plus the two legacy prefixes
 *  (`email-…`, `local-…` from the old username flow — already covered),
 *  so a returning user whose profile predates the unified flow is still
 *  recognized. Order is "preferred first" (new form, then legacy email). */
export function candidateIdsForIdentity(value: string): string[] {
  const sanitized = basicSanitize(value);
  if (!sanitized) return [];
  return [`local-${sanitized}`, `email-${sanitized}`];
}
