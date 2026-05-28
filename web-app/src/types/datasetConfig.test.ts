import { describe, it, expect } from 'vitest';
import {
  tierForAnnotator,
  isAnnotatorAdmin,
  isAnnotatorResearcher,
  isAnnotatorOnTeam,
  deriveLegacyEmailsFromPeople,
  type DatasetConfig,
  type PersonEntry,
} from './datasetConfig';

// These are the *gates* that decide who sees what. Every UI access check —
// admin nav items, member management, cross-annotator stats, dataset export —
// resolves through tierForAnnotator. A regression here is a privilege
// boundary regression, so the cases below pin all five resolution branches
// plus the bootstrap, demo, and absence-as-public invariants.

// ─── Bootstrap mode (fresh clone, no config attached) ───────────────────────

describe('tierForAnnotator — bootstrap mode', () => {
  it('promotes the first signed-in user to admin when no config exists', () => {
    expect(tierForAnnotator('first@example.com', null)).toBe('admin');
    expect(tierForAnnotator('first@example.com', undefined)).toBe('admin');
    expect(tierForAnnotator('first@example.com', {})).toBe('admin');
  });

  it('keeps the demo synthetic id public even in bootstrap mode', () => {
    // Without this carve-out, a fresh clone would promote the demo visitor to
    // admin and route them at data/ instead of data-default/, hiding the
    // shipped CC0 seed songs from public demo users.
    expect(tierForAnnotator('demo-anonymous', null)).toBeNull();
    expect(tierForAnnotator('demo-anonymous', {})).toBeNull();
  });

  it('returns null for an unsigned user regardless of config', () => {
    expect(tierForAnnotator(null, null)).toBeNull();
    expect(tierForAnnotator(undefined, { peopleByEmail: { 'a@b.com': { tier: 'admin' } } })).toBeNull();
    expect(tierForAnnotator('', null)).toBeNull();
  });
});

// ─── peopleByEmail (the canonical store) ────────────────────────────────────

describe('tierForAnnotator — peopleByEmail (canonical)', () => {
  const cfg: DatasetConfig = {
    peopleByEmail: {
      'admin@x.com':      { tier: 'admin'      },
      'researcher@x.com': { tier: 'researcher' },
      'team@x.com':       { tier: 'team'       },
    },
  };

  it('returns the listed tier verbatim', () => {
    expect(tierForAnnotator('admin@x.com',      cfg)).toBe('admin');
    expect(tierForAnnotator('researcher@x.com', cfg)).toBe('researcher');
    expect(tierForAnnotator('team@x.com',       cfg)).toBe('team');
  });

  it('treats unlisted ids as public (null) when peopleByEmail has at least one entry', () => {
    expect(tierForAnnotator('nobody@x.com', cfg)).toBeNull();
  });

  it('falls through to legacy/bootstrap when peopleByEmail is present but empty', () => {
    // An empty map is the same signal as no map at all.
    const empty: DatasetConfig = { peopleByEmail: {} };
    expect(tierForAnnotator('anyone@x.com', empty)).toBe('admin');
  });

  it('peopleByEmail takes precedence over legacy arrays', () => {
    const mixed: DatasetConfig = {
      peopleByEmail: { 'a@b.com': { tier: 'team' } },
      adminEmails: ['a@b.com'],  // legacy says admin
      teamEmails: [],
    };
    expect(tierForAnnotator('a@b.com', mixed)).toBe('team');
  });
});

// ─── Legacy adminEmails / teamEmails fallback ───────────────────────────────

describe('tierForAnnotator — legacy fallback', () => {
  it('resolves adminEmails → admin', () => {
    const cfg: DatasetConfig = { adminEmails: ['boss@x.com'] };
    expect(tierForAnnotator('boss@x.com', cfg)).toBe('admin');
  });

  it('resolves teamEmails → team', () => {
    const cfg: DatasetConfig = { teamEmails: ['t@x.com'] };
    expect(tierForAnnotator('t@x.com', cfg)).toBe('team');
  });

  it('returns null when an explicit allowlist exists but the user is not on it', () => {
    const cfg: DatasetConfig = { adminEmails: ['boss@x.com'] };
    expect(tierForAnnotator('outsider@x.com', cfg)).toBeNull();
  });

  it('admin and team can be set together with admin winning', () => {
    const cfg: DatasetConfig = {
      adminEmails: ['both@x.com'],
      teamEmails: ['both@x.com'],
    };
    expect(tierForAnnotator('both@x.com', cfg)).toBe('admin');
  });
});

// ─── Convenience helpers ─────────────────────────────────────────────────────

describe('isAnnotatorAdmin / isAnnotatorResearcher / isAnnotatorOnTeam', () => {
  const cfg: DatasetConfig = {
    peopleByEmail: {
      'a@x.com': { tier: 'admin' },
      'r@x.com': { tier: 'researcher' },
      't@x.com': { tier: 'team' },
    },
  };

  it('isAnnotatorAdmin is true only for admins', () => {
    expect(isAnnotatorAdmin('a@x.com', cfg)).toBe(true);
    expect(isAnnotatorAdmin('r@x.com', cfg)).toBe(false);
    expect(isAnnotatorAdmin('t@x.com', cfg)).toBe(false);
    expect(isAnnotatorAdmin('public@x.com', cfg)).toBe(false);
    expect(isAnnotatorAdmin(null, cfg)).toBe(false);
  });

  it('isAnnotatorResearcher includes both admin and researcher tiers', () => {
    expect(isAnnotatorResearcher('a@x.com', cfg)).toBe(true);
    expect(isAnnotatorResearcher('r@x.com', cfg)).toBe(true);
    expect(isAnnotatorResearcher('t@x.com', cfg)).toBe(false);
    expect(isAnnotatorResearcher('public@x.com', cfg)).toBe(false);
  });

  it('isAnnotatorOnTeam covers admin/researcher/team but not public', () => {
    expect(isAnnotatorOnTeam('a@x.com', cfg)).toBe(true);
    expect(isAnnotatorOnTeam('r@x.com', cfg)).toBe(true);
    expect(isAnnotatorOnTeam('t@x.com', cfg)).toBe(true);
    expect(isAnnotatorOnTeam('public@x.com', cfg)).toBe(false);
    expect(isAnnotatorOnTeam(null, cfg)).toBe(false);
  });
});

// ─── Legacy mirror writer (peopleByEmail → adminEmails/teamEmails) ──────────

describe('deriveLegacyEmailsFromPeople', () => {
  it('splits admins and team members into their legacy arrays', () => {
    const people: Record<string, PersonEntry> = {
      'a@x.com': { tier: 'admin' },
      't@x.com': { tier: 'team' },
      'a2@x.com': { tier: 'admin' },
    };
    const { adminEmails, teamEmails } = deriveLegacyEmailsFromPeople(people);
    expect(adminEmails.sort()).toEqual(['a2@x.com', 'a@x.com'].sort());
    expect(teamEmails).toEqual(['t@x.com']);
  });

  it('does NOT fold researchers into admin (would silently grant member-management)', () => {
    // This is a security guarantee — see the comment block in
    // deriveLegacyEmailsFromPeople for the rationale.
    const people: Record<string, PersonEntry> = {
      'r@x.com': { tier: 'researcher' },
    };
    const { adminEmails, teamEmails } = deriveLegacyEmailsFromPeople(people);
    expect(adminEmails).toEqual([]);
    expect(teamEmails).toEqual([]);
  });

  it('returns empty arrays for an empty map', () => {
    expect(deriveLegacyEmailsFromPeople({})).toEqual({ adminEmails: [], teamEmails: [] });
  });
});
