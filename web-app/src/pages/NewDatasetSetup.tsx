import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAnnotator } from '../context/AnnotatorContext';
import type { Annotator } from '../types/annotator';
import { fetchAdminStatus } from '../services/admin';
import { loadDatasetConfig } from '../services/datasetConfig';
import { type DatasetConfig, type PersonEntry } from '../types/datasetConfig';
import { AppPageHeader } from '../components/AppPageHeader';
import { GooglePane, IdentityPane } from '../components/LoginScreen';

const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '';

type Tab = 'google' | 'identity';

/**
 * Bootstrap a brand-new dataset. The visitor names the corpus and signs in
 * (Google when configured, or email/username as a fallback); on success we
 * atomically save `corpusName` and add their annotator id to `peopleByEmail`
 * as `admin`, then route to /prep.
 *
 * Google is preferred when available because it's a verified identity, but
 * deploys without `VITE_GOOGLE_CLIENT_ID` (or operators who simply don't have
 * a Google account) can still claim the dataset via the Email/Username pane.
 *
 * Only reachable when the dataset is in bootstrap mode — the LandingPage
 * hides the "Start a new dataset" card once any admin is set. If a user
 * deep-links here after a claim has happened we send them back to /.
 */
export function NewDatasetSetup() {
  const navigate = useNavigate();
  const { signIn, annotator } = useAnnotator();
  const [corpusName, setCorpusName] = useState('');
  const [checking, setChecking] = useState(true);
  const [claimed, setClaimed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(GOOGLE_CLIENT_ID ? 'google' : 'identity');

  // Refs mirror the form state so the GooglePane/IdentityPane callbacks
  // (which capture the callback identity once and re-init only when it
  // changes) always read the latest value at click time.
  const corpusNameRef = useRef(corpusName);
  useEffect(() => { corpusNameRef.current = corpusName; }, [corpusName]);

  // Gate: if the dataset already has an admin, this flow shouldn't run.
  // Bounce home; the LandingPage will route the user to /login instead.
  // The "claimed" signal comes from /api/admin-status: mode === 'bootstrap'
  // means no admin attached yet (matches tierForId() on the server).
  useEffect(() => {
    let cancelled = false;
    fetchAdminStatus()
      .then((status) => {
        if (cancelled) return;
        if (status.mode !== 'bootstrap') setClaimed(true);
      })
      .catch(() => { /* network blip — leave bootstrap path open */ })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (claimed) navigate('/', { replace: true });
  }, [claimed, navigate]);

  const claimAndSignIn = useCallback(async (a: Annotator) => {
    const trimmedName = corpusNameRef.current.trim();
    if (!trimmedName) {
      setError('Please enter a corpus name first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Re-check claim state right before writing: a concurrent admin might
      // have raced us. If somebody else claimed it, abort cleanly.
      const status = await fetchAdminStatus().catch(() => null);
      if (status && status.mode !== 'bootstrap') {
        setClaimed(true);
        return;
      }

      // We're in bootstrap mode (no admin attached yet), so the whitelist is
      // empty by definition — nothing to merge. Load the trimmed config just
      // to preserve any public fields (corpusName may have been set by an
      // earlier visit) and overlay the form values + claim. `sharedCorpus`
      // is no longer settable from the signup flow; admins flip it later
      // from Settings → Corpus management.
      const cfg: DatasetConfig = (await loadDatasetConfig().catch(() => ({}))) ?? {};
      // `peopleByEmail` is keyed by the annotator id. For Google ids that
      // happens to equal the email; for email- and username-method ids it's
      // the namespaced form (`email-…` / `local-…`).
      const people: Record<string, PersonEntry> = {
        [a.id]: { tier: 'admin', invitedAt: new Date().toISOString(), invitedBy: a.id },
      };
      const nextCfg: DatasetConfig = {
        ...cfg,
        corpusName: trimmedName,
        peopleByEmail: people,
        adminEmails: [a.id],
      };
      // `callerTier` is a server-only convenience field; don't write it back.
      delete nextCfg.callerTier;

      // Save dataset-config with explicit X-Annotator-Id. The signed-in state
      // hasn't been mirrored to the module-level annotator yet (signIn runs
      // after this), so we can't rely on getCurrentAnnotatorId() here.
      // In bootstrap mode the server accepts the first signed-in id as admin.
      const res = await fetch('/api/dataset-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Annotator-Id': a.id },
        body: JSON.stringify(nextCfg),
      });
      if (!res.ok) {
        throw new Error(res.status === 403 ? 'Server refused the claim (admin required)' : `HTTP ${res.status}`);
      }

      signIn(a);
      navigate('/prep', { replace: true });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Sign-in failed');
      setBusy(false);
    }
  }, [navigate, signIn]);

  const alreadySignedIn = !!annotator;
  const trimmedName = corpusName.trim();

  if (checking) {
    return (
      <div className="min-h-screen bg-[#0a0b0d] text-slate-500 flex items-center justify-center text-[11px] font-mono">
        Checking dataset state…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0b0d] text-slate-200 flex flex-col">
      <AppPageHeader back={{ title: 'Back to home' }} />
      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-[#14171d] border border-white/[0.06] rounded-md shadow-2xl shadow-black/60 p-6 space-y-5">
        <header className="text-center space-y-1.5 pb-3 border-b border-white/[0.05]">
          <h1 className="text-base font-medium text-slate-100">Start a new dataset</h1>
          <p className="text-[11px] text-slate-500 leading-relaxed">
            Name your corpus, then sign in to claim it. You'll be the dataset's
            first admin.
          </p>
        </header>

        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">
            Corpus name<span className="text-red-400 ml-0.5">*</span>
          </span>
          <input
            type="text"
            value={corpusName}
            onChange={(e) => setCorpusName(e.target.value)}
            placeholder="e.g. Israeli Pop 2026"
            maxLength={80}
            disabled={busy}
            className="mt-1 w-full px-2.5 py-1.5 rounded bg-[#0a0b0d] border border-white/[0.08] focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/40 focus:outline-none text-slate-200 text-xs font-mono transition-colors disabled:opacity-50"
          />
          <span className="block mt-1 text-[10px] text-slate-600 font-mono">
            Shown on the main page and in the workspace header. You can rename it later in Settings.
          </span>
        </label>

        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">
            Sign in as admin
          </div>

          {!trimmedName && (
            <p className="text-[10px] text-slate-500 font-mono">
              Enter a corpus name above to enable sign-in.
            </p>
          )}

          <div className={(!trimmedName || busy) ? 'pointer-events-none opacity-40 space-y-3' : 'space-y-3'}>
            {GOOGLE_CLIENT_ID ? (
              <>
                <nav className="grid grid-cols-2 gap-px bg-[#0a0b0d] border border-white/[0.06] rounded-md p-0.5 text-[11px] uppercase tracking-wider">
                  {(['google', 'identity'] as Tab[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTab(t)}
                      className={`px-2 py-1.5 rounded transition-colors ${
                        tab === t ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-400/40' : 'text-slate-500 hover:text-slate-200 border border-transparent'
                      }`}
                    >
                      {t === 'google' ? 'Google' : 'Email or username'}
                    </button>
                  ))}
                </nav>
                {tab === 'google' && <GooglePane onSignIn={claimAndSignIn} />}
                {tab === 'identity' && <IdentityPane onSignIn={claimAndSignIn} />}
              </>
            ) : (
              <>
                <p className="text-[10px] text-slate-500 font-mono leading-relaxed">
                  Google sign-in is not configured on this deploy. Sign in with
                  an email or pick a username — that identity becomes the
                  dataset's first admin.
                </p>
                <IdentityPane onSignIn={claimAndSignIn} />
              </>
            )}
          </div>

          {busy && (
            <p className="text-[10px] text-slate-500 font-mono text-center">Claiming dataset…</p>
          )}
          {error && (
            <p className="text-[11px] text-red-400 font-mono text-center">{error}</p>
          )}
          {alreadySignedIn && !busy && (
            <p className="text-[10px] text-amber-300 font-mono text-center leading-relaxed">
              You're already signed in as {annotator!.displayName}. Signing in here will replace that identity.
            </p>
          )}
        </div>
        </div>
      </main>
    </div>
  );
}

