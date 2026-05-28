import { describe, it, expect } from 'vitest';
import {
  buildAnnotatorId,
  candidateIdsForIdentity,
  isValidIdentity,
  IDENTITY_MIN_LEN,
} from './annotator';

// Identity construction is the impersonation boundary: a self-attested user
// must NEVER land on the same on-disk id as a Google-verified one, otherwise
// typing a colleague's email at the local-identity prompt could read or
// overwrite their annotations. These tests pin that contract.

// ─── isValidIdentity (the login-screen gatekeeper) ──────────────────────────

describe('isValidIdentity', () => {
  it('accepts handles, emails, and a few other punctuation characters', () => {
    expect(isValidIdentity('jane')).toBe(true);
    expect(isValidIdentity('jane.doe')).toBe(true);
    expect(isValidIdentity('jane_doe')).toBe(true);
    expect(isValidIdentity('jane-doe')).toBe(true);
    expect(isValidIdentity('jane@example.com')).toBe(true);
    expect(isValidIdentity('a1')).toBe(true); // exactly at the minimum length
  });

  it('rejects spaces, slashes, and other off-alphabet characters', () => {
    expect(isValidIdentity('jane doe')).toBe(false);
    expect(isValidIdentity('jane/doe')).toBe(false);
    expect(isValidIdentity('jane!')).toBe(false);
    expect(isValidIdentity('jane#doe')).toBe(false);
  });

  it('rejects strings shorter than IDENTITY_MIN_LEN', () => {
    expect(IDENTITY_MIN_LEN).toBe(2);  // pin the minimum so a relax shows up loud
    expect(isValidIdentity('a')).toBe(false);
    expect(isValidIdentity('')).toBe(false);
  });

  it('trims before counting length, so " a" still rejects', () => {
    expect(isValidIdentity(' a ')).toBe(false);
    expect(isValidIdentity('  ab  ')).toBe(true);
  });
});

// ─── buildAnnotatorId — the impersonation guard ─────────────────────────────

describe('buildAnnotatorId — Google route', () => {
  it('returns the sanitized email with no local- prefix', () => {
    const id = buildAnnotatorId({ method: 'google', email: 'Jane.Doe@Example.COM' });
    expect(id).toBe('jane.doe@example.com');
    expect(id.startsWith('local-')).toBe(false);
  });

  it('throws when email is missing', () => {
    expect(() => buildAnnotatorId({ method: 'google' })).toThrow(/email required/);
  });

  it('lowercases and strips off-alphabet characters', () => {
    const id = buildAnnotatorId({ method: 'google', email: 'My Name+tag@x.com' });
    // "+" is in the sanitizer's keep-set; spaces become "_".
    expect(id).toBe('my_name+tag@x.com');
  });
});

describe('buildAnnotatorId — identity (self-attested) route', () => {
  it('always namespaces under local- so a typed email cannot impersonate a Google id', () => {
    // CRITICAL: the same email at the Google route produced 'jane@x.com'.
    // Through identity it must produce 'local-jane@x.com'. These cannot collide.
    const google   = buildAnnotatorId({ method: 'google',   email:    'jane@x.com' });
    const identity = buildAnnotatorId({ method: 'identity', identity: 'jane@x.com' });
    expect(google).toBe('jane@x.com');
    expect(identity).toBe('local-jane@x.com');
    expect(google).not.toBe(identity);
  });

  it('accepts a plain handle', () => {
    expect(buildAnnotatorId({ method: 'identity', identity: 'jane' })).toBe('local-jane');
  });

  it('falls back to username or email when identity is omitted (legacy callers)', () => {
    expect(buildAnnotatorId({ method: 'identity', username: 'older' })).toBe('local-older');
    expect(buildAnnotatorId({ method: 'identity', email:    'e@x.com' })).toBe('local-e@x.com');
  });

  it('throws when no usable input is provided', () => {
    expect(() => buildAnnotatorId({ method: 'identity' })).toThrow(/identity required/);
  });

  it('lowercases and replaces unsafe characters consistently with the Google route', () => {
    const id = buildAnnotatorId({ method: 'identity', identity: 'Jane Doe!' });
    expect(id).toBe('local-jane_doe_');
  });

  it('collapses repeated dots and trims leading dots (path traversal guard)', () => {
    // basicSanitize replaces consecutive `..` and a leading `.` with `_`
    // — keeps the id away from anything resembling parent-directory escapes.
    expect(buildAnnotatorId({ method: 'identity', identity: '..jane' })).toBe('local-_jane');
    expect(buildAnnotatorId({ method: 'identity', identity: 'jane..doe' })).toBe('local-jane_doe');
  });
});

// ─── candidateIdsForIdentity (returning-user lookup) ────────────────────────

describe('candidateIdsForIdentity', () => {
  it('returns the new local- id first and the legacy email- id second', () => {
    const ids = candidateIdsForIdentity('Jane.Doe');
    expect(ids).toEqual(['local-jane.doe', 'email-jane.doe']);
  });

  it('returns [] for input that sanitizes to empty', () => {
    expect(candidateIdsForIdentity('')).toEqual([]);
    expect(candidateIdsForIdentity('   ')).toEqual([]);
  });

  it('sanitizes the same way buildAnnotatorId does, so lookup matches storage', () => {
    const stored = buildAnnotatorId({ method: 'identity', identity: 'Jane Doe' });
    const candidates = candidateIdsForIdentity('Jane Doe');
    expect(candidates).toContain(stored);
  });
});
