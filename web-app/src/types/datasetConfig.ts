// Dataset-wide config (data/dataset-config.json). Holds the access tier
// assignments and any corpus-wide defaults (vocabulary, corpus name, etc.).

/** Access tier for a single email. Higher tiers strictly include the
 *  abilities of lower tiers — see the matrix in USER_GUIDE.md (Sign-In &
 *  Identity → Tiers) for the full breakdown.
 *
 *  Important: emails NOT present in `peopleByEmail` are treated as `public`
 *  (limited to the shipped default corpus). We never store `public` in the
 *  map — absence is the signal. */
export type AccessTier = 'admin' | 'researcher' | 'team';

export interface PersonEntry {
  /** Access tier. Required. */
  tier: AccessTier;
  /** ISO timestamp set when the row is first written. */
  invitedAt?: string;
  /** Annotator id of the admin who added this row, when known. */
  invitedBy?: string;
}

export interface DatasetConfig {
  /** Optional explicit admin allowlist. When non-empty, ONLY these annotator
   *  ids may view team stats, delete songs, or export cross-annotator data.
   *  With neither this nor peopleByEmail set, the dataset is in bootstrap
   *  mode and any signed-in annotator can perform admin actions. */
  adminEmails?: string[];
  /** Team allowlist — annotators who get full corpus access (all user-uploaded
   *  songs, ability to annotate beyond the shipped defaults). Admins are
   *  implicitly on the team and don't need to be repeated here. When empty/
   *  undefined AND no adminEmails are set, the dataset is in bootstrap mode
   *  and any signed-in annotator counts as on-team. Once an explicit
   *  adminEmails list exists, anyone not in adminEmails ∪ teamEmails is
   *  treated as "public" and can only see/annotate songs in data-default/. */
  teamEmails?: string[];

  /** Single source of truth for per-email access. Each entry maps an email
   *  (lowercased) to its tier + invite metadata. When present, this takes
   *  precedence over the legacy `adminEmails` / `teamEmails` arrays (which
   *  are still written in parallel so older code paths keep working). */
  peopleByEmail?: Record<string, PersonEntry>;

  /** Human-readable name for this corpus, shown on the main page entry
   *  cards and the workspace tab strip. When undefined, falls back to a
   *  generic "TimeCues Studio" label. Admin-editable. */
  corpusName?: string;

  /** Corpus-wide section-type vocabulary recommended by the admin. Acts as
   *  the *dataset default*: each annotator still has their own
   *  `sectionTypeVocabulary` in local settings, but if it differs from this
   *  list the Settings page shows a "Local override" badge with a one-click
   *  reset. Undefined → no recommendation (no badge shown). */
  sectionTypeVocabularyDefault?: string[];
  /** Whether the admin recommends using a fixed cue-label taxonomy. */
  cueTaxonomyEnabledDefault?: boolean;
  /** Corpus-wide cue-label taxonomy recommended by the admin. */
  cueTaxonomyDefault?: string[];
  /** Whether the admin recommends using a fixed span-label taxonomy. */
  spanTaxonomyEnabledDefault?: boolean;
  /** Corpus-wide span-label taxonomy recommended by the admin. */
  spanTaxonomyDefault?: string[];

  /** When true, team annotators share a single set of annotation files
   *  (annotations live at <base>/<slug>.json) instead of being scoped to
   *  per-annotator subdirectories. Defaults to false for per-annotator
   *  isolation. */
  sharedCorpus?: boolean;

  /** Server-resolved tier for the calling annotator. Set by GET
   *  /api/dataset-config on every response; never persisted to disk.
   *  Use this instead of running `tierForAnnotator` against `peopleByEmail`
   *  on the client — non-admin callers don't receive `peopleByEmail`, so a
   *  client-side resolution would always return null/bootstrap-default. */
  callerTier?: AccessTier | null;
}

export const DEFAULT_DATASET_CONFIG: DatasetConfig = {
  sharedCorpus: false,
};

/** Resolve the effective access tier for an annotator id given the current
 *  dataset config. Returns null when no annotator is signed in.
 *
 *  Resolution order:
 *    1. `peopleByEmail` (new canonical) when present;
 *    2. `adminEmails` (legacy) → 'admin';
 *    3. `teamEmails` (legacy) → 'team';
 *    4. Bootstrap mode (no admin attached AND no team attached) → 'admin'
 *       so the first user can configure things;
 *    5. Otherwise → null, i.e. public (limited to data-default/ corpus). */
export function tierForAnnotator(
  annotatorId: string | null | undefined,
  cfg: DatasetConfig | null | undefined,
): AccessTier | null {
  if (!annotatorId) return null;
  // The synthetic demo id is always public, regardless of bootstrap state —
  // otherwise on a fresh clone (no dataset-config.json) the bootstrap branch
  // below would promote demo-anonymous to admin and route demo visitors at
  // data/ instead of data-default/, hiding the shipped CC0 seed songs.
  if (annotatorId === 'demo-anonymous') return null;
  if (cfg?.peopleByEmail) {
    const entry = cfg.peopleByEmail[annotatorId];
    if (entry) return entry.tier;
    // peopleByEmail is present but the id isn't there → public
    const hasAny = Object.keys(cfg.peopleByEmail).length > 0;
    if (hasAny) return null;
  }
  if (cfg?.adminEmails && cfg.adminEmails.length > 0) {
    if (cfg.adminEmails.includes(annotatorId)) return 'admin';
  }
  if (cfg?.teamEmails && cfg.teamEmails.includes(annotatorId)) return 'team';
  // Bootstrap mode: no admin AND no team configured → first user is admin.
  const hasAdmin = !!cfg?.adminEmails && cfg.adminEmails.length > 0;
  const hasTeam = !!cfg?.teamEmails && cfg.teamEmails.length > 0;
  const hasPeople = !!cfg?.peopleByEmail && Object.keys(cfg.peopleByEmail).length > 0;
  if (!hasAdmin && !hasTeam && !hasPeople) return 'admin';
  return null;
}

/** Resolve whether a given annotator id has admin privileges. */
export function isAnnotatorAdmin(
  annotatorId: string | null | undefined,
  cfg: DatasetConfig | null | undefined,
): boolean {
  return tierForAnnotator(annotatorId, cfg) === 'admin';
}

/** Resolve whether a given annotator id has researcher-or-higher privileges.
 *  Researchers get read access to every annotator's work plus dataset-wide
 *  upload/delete/export — basically "admin minus member management". */
export function isAnnotatorResearcher(
  annotatorId: string | null | undefined,
  cfg: DatasetConfig | null | undefined,
): boolean {
  const t = tierForAnnotator(annotatorId, cfg);
  return t === 'admin' || t === 'researcher';
}

/** Resolve whether a given annotator id is on the team (full-corpus access).
 *  Admins, researchers, and team members are all on-team; only public users
 *  are limited to the data-default/ corpus. */
export function isAnnotatorOnTeam(
  annotatorId: string | null | undefined,
  cfg: DatasetConfig | null | undefined,
): boolean {
  return tierForAnnotator(annotatorId, cfg) !== null;
}

/** Derive legacy `adminEmails` / `teamEmails` arrays from `peopleByEmail`.
 *  We write both shapes in parallel so any code still reading the legacy
 *  fields keeps working. Researchers fold into adminEmails so legacy code
 *  paths that gate on "isAdmin" still let researchers in for read-only
 *  research operations — anything stricter goes through the new
 *  `peopleByEmail` directly. */
export function deriveLegacyEmailsFromPeople(
  people: Record<string, PersonEntry>,
): { adminEmails: string[]; teamEmails: string[] } {
  const adminEmails: string[] = [];
  const teamEmails: string[] = [];
  for (const [email, entry] of Object.entries(people)) {
    if (entry.tier === 'admin') adminEmails.push(email);
    else if (entry.tier === 'team') teamEmails.push(email);
    // researchers are *not* folded into legacy lists — they should only be
    // granted access through the new tier check. Putting them in adminEmails
    // would silently give them member-management powers.
  }
  return { adminEmails, teamEmails };
}
