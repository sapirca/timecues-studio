import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IdentityPane } from './LoginScreen';
import type { Annotator } from '../types/annotator';

// IdentityPane is the meaningful, exportable sub-component of LoginScreen
// (the full LoginScreen wraps it in a router + tab chooser + Google flow).
// These tests cover what the access-gate scaffolding actually does: it
// builds a `local-…` namespaced id and never produces a bare Google id.
//
// We mock fetchProfileById (returning-user check) and `global.fetch` (the
// id-available probe) so we don't touch the network.

vi.mock('../services/annotatorProfile', () => ({
  fetchProfileById: vi.fn(async () => null),
}));

import { fetchProfileById } from '../services/annotatorProfile';

const originalFetch = global.fetch;

function mockAvailability(available: boolean) {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ available }),
  })) as typeof global.fetch;
}

afterEach(() => {
  global.fetch = originalFetch;
  vi.clearAllMocks();
});

// ─── Validation messages ─────────────────────────────────────────────────────

describe('IdentityPane — input validation', () => {
  it('shows the placeholder help text before any input', () => {
    render(<IdentityPane onSignIn={vi.fn()} />);
    expect(
      screen.getByText(/Use letters, numbers, underscore, dot, hyphen/i),
    ).toBeInTheDocument();
  });

  it('rejects spaces and other off-alphabet characters with a red error', async () => {
    const user = userEvent.setup();
    render(<IdentityPane onSignIn={vi.fn()} />);
    await user.type(screen.getByRole('textbox'), 'jane doe');
    expect(
      screen.getByText(/Only letters, numbers, and/i),
    ).toBeInTheDocument();
  });

  it('shows the min-length message for a single character', async () => {
    const user = userEvent.setup();
    render(<IdentityPane onSignIn={vi.fn()} />);
    await user.type(screen.getByRole('textbox'), 'a');
    expect(screen.getByText(/At least 2 characters/)).toBeInTheDocument();
  });

  it('previews the storage form with a local- prefix once input is valid', async () => {
    // This preview is the user-visible expression of the impersonation
    // guarantee — what they type goes under `local-…`, not bare.
    const user = userEvent.setup();
    mockAvailability(true);
    render(<IdentityPane onSignIn={vi.fn()} />);
    await user.type(screen.getByRole('textbox'), 'jane');
    expect(await screen.findByText(/Stored as/)).toBeInTheDocument();
    expect(screen.getByText('local-jane')).toBeInTheDocument();
  });
});

// ─── Available-id flow → submit produces an Annotator with local- prefix ───

describe('IdentityPane — available-id submit', () => {
  it('shows the Continue button once the id is available and submits a local- annotator', async () => {
    const user = userEvent.setup();
    mockAvailability(true);
    const onSignIn = vi.fn();

    render(<IdentityPane onSignIn={onSignIn} />);
    await user.type(screen.getByRole('textbox'), 'jane');

    // Wait for the debounced availability check to land.
    const submit = await screen.findByRole('button', { name: /continue/i });
    expect(submit).toBeEnabled();

    await user.click(submit);

    expect(onSignIn).toHaveBeenCalledTimes(1);
    const annotator = onSignIn.mock.calls[0][0] as Annotator;
    // The impersonation guarantee, end-to-end through the UI.
    expect(annotator.id).toBe('local-jane');
    expect(annotator.authMethod).toBe('identity');
    expect(annotator.displayName).toBe('jane');
    // Bare-word identity → no email field populated.
    expect(annotator.email).toBeUndefined();
  });

  it('populates email when the identity is an email-shaped string', async () => {
    const user = userEvent.setup();
    mockAvailability(true);
    const onSignIn = vi.fn();

    render(<IdentityPane onSignIn={onSignIn} />);
    await user.type(screen.getByRole('textbox'), 'Jane@Example.com');

    const submit = await screen.findByRole('button', { name: /continue/i });
    await user.click(submit);

    const annotator = onSignIn.mock.calls[0][0] as Annotator;
    expect(annotator.id).toBe('local-jane@example.com');
    expect(annotator.email).toBe('jane@example.com');
  });
});

// ─── Existing-profile flow → submit returns the stored Annotator ────────────

describe('IdentityPane — existing-profile path', () => {
  it('greets a returning user and submits the stored Annotator (not a freshly-built one)', async () => {
    const stored: Annotator = {
      id: 'local-jane',
      displayName: 'Jane Doe',
      authMethod: 'identity',
      createdAt: '2026-01-01T00:00:00.000Z',
      role: 'Researcher',
    };
    vi.mocked(fetchProfileById).mockResolvedValueOnce(stored);
    // The id-available probe is skipped when a profile is found; but the
    // pane may issue the request anyway, so leave fetch mocked safely.
    mockAvailability(true);

    const user = userEvent.setup();
    const onSignIn = vi.fn();
    render(<IdentityPane onSignIn={onSignIn} />);
    await user.type(screen.getByRole('textbox'), 'jane');

    // The welcome-back banner identifies the returning user.
    expect(await screen.findByText(/Welcome back, Jane Doe/)).toBeInTheDocument();

    const submit = await screen.findByRole('button', { name: /sign in/i });
    await user.click(submit);

    expect(onSignIn).toHaveBeenCalledTimes(1);
    // We hand back the *stored* Annotator object, not a freshly minted one
    // — preserves createdAt, role, displayName, etc.
    expect(onSignIn.mock.calls[0][0]).toEqual(stored);
  });
});

// ─── Unavailable-id flow → amber warning + recovery affordances ─────────────

describe('IdentityPane — unavailable-id flow', () => {
  it('warns when the id already has annotations on file and offers a Continue-anyway path', async () => {
    mockAvailability(false);
    const user = userEvent.setup();
    const onSignIn = vi.fn();

    render(<IdentityPane onSignIn={onSignIn} />);
    await user.type(screen.getByRole('textbox'), 'jane');

    // The amber-bordered warning explains the collision.
    expect(
      await screen.findByText(/already has annotations on file/i),
    ).toBeInTheDocument();

    // The continue-as button is the user's escape hatch.
    const continueAs = await screen.findByRole('button', { name: /Continue as jane/i });
    await user.click(continueAs);

    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect((onSignIn.mock.calls[0][0] as Annotator).id).toBe('local-jane');
  });
});
