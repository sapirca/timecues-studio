import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAnnotator } from '../context/AnnotatorContext';
import type { Annotator } from '../types/annotator';
import { fetchAdminStatus } from '../services/admin';
import { fetchSession } from '../services/session';
import { loadDatasetConfig } from '../services/datasetConfig';
import { type DatasetConfig, type PersonEntry } from '../types/datasetConfig';
import { AppPageHeader } from '../components/AppPageHeader';
import { GooglePane, IdentityPane } from '../components/LoginScreen';

const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '';

type Tab = 'google' | 'identity';

/** Google's four-colour "G", so the Admin box says at a glance that the
 *  account is a Google sign-in — the same mark its sign-in button shows. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="w-5 h-5" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/**
 * Bootstrap a brand-new dataset. The visitor names the corpus, signs in if
 * they aren't already (Google when configured, or email/username as a
 * fallback), and clicks **Create dataset**; that atomically saves `corpusName`
 * and adds their annotator id to `peopleByEmail` as `admin`, then routes to
 * /prep. Signing in and creating are separate steps: signing in only signs in,
 * and someone already signed in creates with one click instead of having to
 * sign in again.
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
  // Signed in, but chose "Use a different account": show the sign-in panes.
  const [switching, setSwitching] = useState(false);

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

  const claim = useCallback(async (a: Annotator) => {
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
      // The server makes whoever its session names the admin — not the name
      // this page shows. If they differ (the session lapsed, or another
      // TimeCues on this machine replaced it), creating would hand the
      // dataset to nobody; ask for a fresh sign-in instead.
      const session = await fetchSession();
      if (!session || session.id !== a.id) {
        setSwitching(true);
        setBusy(false);
        setError(`Your sign-in as ${a.displayName} has expired on this server. Sign in again, then click Create dataset.`);
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

      // In bootstrap mode the server accepts the first signed-in id as admin.
      const res = await fetch('/api/dataset-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Annotator-Id': a.id },
        body: JSON.stringify(nextCfg),
      });
      if (!res.ok) {
        throw new Error(res.status === 403 ? 'Server refused the claim (admin required)' : `HTTP ${res.status}`);
      }

      navigate('/prep', { replace: true });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Creating the dataset failed');
      setBusy(false);
    }
  }, [navigate]);

  const onSignedIn = useCallback((a: Annotator) => {
    signIn(a);
    setSwitching(false);
    setError(null);
  }, [signIn]);

  const alreadySignedIn = !!annotator;
  const trimmedName = corpusName.trim();

  if (checking) {
    return (
      <div className="min-h-screen bg-[#0a0b0d] text-slate-500 flex items-center justify-center text-[12px] sm:text-[11px] font-mono">
        Checking dataset state…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0b0d] text-slate-200 flex flex-col">
      <AppPageHeader back={{ title: 'Back to home' }} />
      <main className="flex-1 flex items-center justify-center px-4 py-6 sm:p-6">
        <div className="w-full max-w-md min-w-0 bg-[#14171d] border border-white/[0.06] rounded-md shadow-2xl shadow-black/60 p-5 sm:p-6 space-y-5">
        <header className="text-center space-y-1.5 pb-3 border-b border-white/[0.05]">
          <h1 className="text-base font-medium text-slate-100">Start a new dataset</h1>
          <p className="text-[12px] sm:text-[11px] text-slate-500 leading-relaxed">
            Name your corpus and create it. The account you're signed in with
            becomes the dataset's first admin.
          </p>
        </header>

        <label className="block">
          <span className="text-[12px] sm:text-[10px] uppercase tracking-wider text-slate-500">
            Corpus name<span className="text-red-400 ml-0.5">*</span>
          </span>
          <input
            type="text"
            value={corpusName}
            onChange={(e) => setCorpusName(e.target.value)}
            placeholder="e.g. Israeli Pop 2026"
            maxLength={80}
            disabled={busy}
            className="mt-1 w-full px-2.5 py-2 sm:py-1.5 rounded bg-[#0a0b0d] border border-white/[0.08] focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/40 focus:outline-none text-slate-200 text-base sm:text-xs font-mono transition-colors disabled:opacity-50"
          />
          <span className="block mt-1 text-[12px] sm:text-[10px] text-slate-600 font-mono">
            Shown on the main page and in the workspace header. You can rename it later in Settings.
          </span>
        </label>

        <div className="space-y-3">
          <div className="text-[12px] sm:text-[10px] uppercase tracking-wider text-slate-500">
            Admin
          </div>

          {alreadySignedIn && !switching ? (
            <div className="flex items-center justify-between gap-3 rounded border border-white/[0.08] bg-white/[0.02] px-3 py-2.5">
              <div className="flex items-center gap-3 min-w-0">
                {annotator!.authMethod === 'google' && (
                  <span className="shrink-0 w-8 h-8 rounded-full bg-white flex items-center justify-center" title="Signed in with Google">
                    <GoogleMark />
                  </span>
                )}
                <div className="min-w-0">
                  <div className="text-[13px] sm:text-xs text-slate-100 truncate">{annotator!.displayName}</div>
                  <div className="text-[12px] sm:text-[10px] text-slate-500 font-mono truncate">{annotator!.id}</div>
                  <div className="text-[12px] sm:text-[10px] text-slate-500">
                    {annotator!.authMethod === 'google' ? 'Signed in with Google' : 'Signed in with a username'}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => { setSwitching(true); setError(null); }}
                disabled={busy}
                className="shrink-0 text-[12px] sm:text-[10px] uppercase tracking-wider text-slate-400 hover:text-slate-100 disabled:opacity-40"
              >
                Use a different account
              </button>
            </div>
          ) : (
            <div className={busy ? 'pointer-events-none opacity-40 space-y-3' : 'space-y-3'}>
              <p className="text-[12px] sm:text-[10px] text-slate-500 font-mono leading-relaxed">
                Sign in with the account that will own this dataset. Signing in doesn't create anything yet.
              </p>
              {GOOGLE_CLIENT_ID ? (
                <>
                  <nav className="grid grid-cols-2 gap-px bg-[#0a0b0d] border border-white/[0.06] rounded-md p-0.5 text-[12px] sm:text-[11px] uppercase tracking-wider">
                    {(['google', 'identity'] as Tab[]).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setTab(t)}
                        className={`px-2 py-2.5 sm:py-1.5 rounded transition-colors ${
                          tab === t ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-400/40' : 'text-slate-500 hover:text-slate-200 border border-transparent'
                        }`}
                      >
                        {t === 'google' ? 'Google' : 'Email or username'}
                      </button>
                    ))}
                  </nav>
                  {tab === 'google' && <GooglePane onSignIn={onSignedIn} />}
                  {tab === 'identity' && <IdentityPane onSignIn={onSignedIn} />}
                </>
              ) : (
                <>
                  <p className="text-[12px] sm:text-[10px] text-slate-500 font-mono leading-relaxed">
                    Google sign-in is not configured on this deploy. Sign in with
                    an email or pick a username — that identity becomes the
                    dataset's first admin.
                  </p>
                  <IdentityPane onSignIn={onSignedIn} />
                </>
              )}
              {alreadySignedIn && (
                <button
                  type="button"
                  onClick={() => { setSwitching(false); setError(null); }}
                  className="text-[12px] sm:text-[10px] uppercase tracking-wider text-slate-500 hover:text-slate-200"
                >
                  Keep {annotator!.displayName}
                </button>
              )}
            </div>
          )}

          {alreadySignedIn && !switching && (
            <button
              type="button"
              onClick={() => void claim(annotator!)}
              disabled={!trimmedName || busy}
              title={!trimmedName ? 'Enter a corpus name first' : undefined}
              className="w-full px-4 py-3 sm:py-2 rounded text-[12px] sm:text-[11px] uppercase tracking-wider font-medium bg-emerald-500/25 hover:bg-emerald-500/35 border border-emerald-400/50 text-emerald-100 disabled:bg-white/[0.04] disabled:border-white/[0.06] disabled:text-slate-600 disabled:cursor-not-allowed transition-colors"
            >
              {busy ? 'Creating dataset…' : 'Create dataset'}
            </button>
          )}
          {alreadySignedIn && !switching && !trimmedName && (
            <p className="text-[12px] sm:text-[10px] text-slate-500 font-mono text-center">Enter a corpus name above to create the dataset.</p>
          )}
          {error && (
            <p className="text-[12px] sm:text-[11px] text-red-400 font-mono text-center">{error}</p>
          )}
        </div>
        </div>
      </main>
    </div>
  );
}

