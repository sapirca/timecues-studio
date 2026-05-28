import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAnnotator } from '../context/AnnotatorContext';
import {
  buildAnnotatorId,
  candidateIdsForIdentity,
  IDENTITY_MIN_LEN,
  IDENTITY_RE,
  isValidIdentity,
} from '../types/annotator';
import type { Annotator } from '../types/annotator';
import { fetchProfileById } from '../services/annotatorProfile';
import { checkAccess } from '../services/datasetConfig';
import { AppPageHeader } from './AppPageHeader';

type Tab = 'google' | 'identity';

/** Display form of an annotator id. Strips the legacy `email-` and current
 *  `local-` namespace prefixes so what we show is the underlying identity
 *  the user typed, not the storage form. Google ids carry no prefix. */
function displayAnnotatorId(id: string): string {
  return id.replace(/^email-/, '').replace(/^local-/, '');
}

const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '';

/** Whitelist of in-app destinations a `?returnTo=` may resolve to. Prevents
 *  open-redirect to external origins (only same-app paths allowed). */
const ALLOWED_RETURN_TO = new Set([
  '/', '/prep', '/annotate', '/inspect', '/custom', '/team', '/settings', '/demo',
]);

function safeReturnTo(raw: string | null): string {
  if (!raw) return '/';
  if (!raw.startsWith('/')) return '/';
  if (raw.includes('//')) return '/'; // blocks //evil.com style protocol-relative URLs
  const path = raw.split('?')[0].split('#')[0];
  return ALLOWED_RETURN_TO.has(path) ? raw : '/';
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: {
          initialize: (cfg: { client_id: string; callback: (r: { credential: string }) => void }) => void;
          renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
        };
      };
    };
  }
}

export function LoginScreen() {
  const [tab, setTab] = useState<Tab>(GOOGLE_CLIENT_ID ? 'google' : 'identity');
  const { annotator, signIn } = useAnnotator();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const returnTo = safeReturnTo(params.get('returnTo'));

  const [denied, setDenied] = useState<{ id: string } | null>(null);

  const guardedSignIn = useCallback(async (a: Annotator) => {
    // Server-side denial: the whitelist never reaches the bundle, so we can't
    // resolve the tier locally. Ask the server whether this id is allowed; a
    // null tier means denied.
    const tier = await checkAccess(a.id);
    if (tier === null) {
      setDenied({ id: a.id });
      return;
    }
    setDenied(null);
    signIn(a);
  }, [signIn]);

  useEffect(() => {
    if (annotator) navigate(returnTo, { replace: true });
  }, [annotator, navigate, returnTo]);

  return (
    <div className="min-h-screen bg-[#0a0b0d] text-slate-200 flex flex-col">
      <AppPageHeader back={{ title: 'Back to home' }} />

      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-[#14171d] border border-white/[0.06] rounded-md shadow-2xl shadow-black/60 p-6 space-y-5">
        <header className="text-center space-y-1.5 pb-3 border-b border-white/[0.05]">
          <h1 className="text-base font-medium text-slate-100">Sign in to annotate</h1>
          <p className="text-[11px] text-slate-500">Pick how you'd like to identify yourself.</p>
        </header>

        {denied ? (
          <AccessDeniedPanel
            attemptedId={denied.id}
            onReset={() => setDenied(null)}
          />
        ) : (
          <>
            {GOOGLE_CLIENT_ID && (
              <nav className="grid grid-cols-2 gap-px bg-[#0a0b0d] border border-white/[0.06] rounded-md p-0.5 text-[11px] uppercase tracking-wider">
                {(['google', 'identity'] as Tab[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    className={`px-2 py-1.5 rounded transition-colors ${
                      tab === t ? 'bg-violet-500/20 text-violet-200 border border-violet-400/40' : 'text-slate-500 hover:text-slate-200 border border-transparent'
                    }`}
                  >
                    {t === 'google' ? 'Google' : 'Username or email'}
                  </button>
                ))}
              </nav>
            )}

            {GOOGLE_CLIENT_ID && tab === 'google' && <GooglePane onSignIn={guardedSignIn} />}
            {(!GOOGLE_CLIENT_ID || tab === 'identity') && <IdentityPane onSignIn={guardedSignIn} />}
          </>
        )}

        <p className="text-[10px] text-slate-600 text-center leading-relaxed">
          Your identity is attached to every annotation you save, so multiple annotators can be compared later.
        </p>
        </div>
      </main>
    </div>
  );
}

function AccessDeniedPanel({
  attemptedId,
  onReset,
}: {
  attemptedId: string;
  onReset: () => void;
}) {
  const attempted = displayAnnotatorId(attemptedId);
  return (
    <div className="rounded border border-red-500/30 bg-red-500/[0.06] p-4 space-y-3">
      <div className="flex items-start gap-2">
        <span className="text-red-300 text-base leading-none mt-0.5">⛔</span>
        <div className="space-y-1">
          <p className="text-[12px] font-medium text-red-200">Access denied</p>
          <p className="text-[11px] text-slate-300 leading-relaxed">
            <span className="font-mono text-slate-100 break-all">{attempted}</span> isn't on this
            dataset's access list. Contact your dataset admin to request access, then try signing in again.
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onReset}
        className="w-full px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-slate-300 transition-colors"
      >
        Try a different account
      </button>
    </div>
  );
}

export function GooglePane({ onSignIn }: { onSignIn: (a: Annotator) => void }) {
  const btnRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;
    let cancelled = false;

    const ensureScript = () =>
      new Promise<void>((resolve, reject) => {
        if (window.google?.accounts?.id) return resolve();
        const existing = document.getElementById('gis-script') as HTMLScriptElement | null;
        if (existing) {
          existing.addEventListener('load', () => resolve());
          existing.addEventListener('error', () => reject(new Error('Failed to load Google Identity Services')));
          return;
        }
        const s = document.createElement('script');
        s.id = 'gis-script';
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        s.defer = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Failed to load Google Identity Services'));
        document.head.appendChild(s);
      });

    ensureScript()
      .then(() => {
        if (cancelled || !window.google?.accounts?.id || !btnRef.current) return;
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: (resp) => {
            try {
              const middle = resp.credential.split('.')[1];
              const json = atob(middle.replace(/-/g, '+').replace(/_/g, '/'));
              const payload = JSON.parse(json) as { email?: string; name?: string };
              const email = (payload.email ?? '').toLowerCase();
              const name = payload.name || email;
              if (!email) throw new Error('No email in Google response');
              onSignIn({
                id: buildAnnotatorId({ method: 'google', email }),
                displayName: name,
                email,
                authMethod: 'google',
                createdAt: new Date().toISOString(),
              });
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Google sign-in failed');
            }
          },
        });
        window.google.accounts.id.renderButton(btnRef.current, {
          theme: 'filled_black',
          size: 'large',
          width: 320,
          shape: 'pill',
        });
      })
      .catch((e: Error) => setError(e.message));

    return () => {
      cancelled = true;
    };
  }, [onSignIn]);

  if (!GOOGLE_CLIENT_ID) {
    return (
      <div className="text-[11px] text-slate-400 space-y-2 bg-[#0a0b0d] border border-white/[0.06] rounded p-3 leading-relaxed">
        <p>Google sign-in is not configured.</p>
        <p>
          Add <code className="bg-white/[0.06] px-1 rounded font-mono text-slate-300">VITE_GOOGLE_CLIENT_ID</code> to{' '}
          <code className="bg-white/[0.06] px-1 rounded font-mono text-slate-300">web-app/.env.local</code> and restart the dev server, or use Username
          or Email instead.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div ref={btnRef} className="flex justify-center min-h-[40px]" />
      {error && <p className="text-[11px] text-red-400 font-mono">{error}</p>}
    </div>
  );
}

/** Unified passwordless pane. A single field accepts either a username or
 *  an email address — both flow through the same logic. The typed value is
 *  sanitized and namespaced under `local-…` to keep it disjoint from
 *  Google-verified ids (so typing a Google user's email here cannot
 *  impersonate them). */
export function IdentityPane({ onSignIn }: { onSignIn: (a: Annotator) => void }) {
  const [value, setValue] = useState('');
  const trimmed = value.trim();
  const previewId = useMemo(() => {
    if (!isValidIdentity(trimmed)) return 'local-…';
    return buildAnnotatorId({ method: 'identity', identity: trimmed });
  }, [trimmed]);

  const hasInput = trimmed.length > 0;
  const charsValid = hasInput && IDENTITY_RE.test(trimmed);
  const lenValid = trimmed.length >= IDENTITY_MIN_LEN;
  const validForSubmit = isValidIdentity(trimmed);

  // Server lookup: does a profile already exist for this identity? We check
  // both the new `local-…` id and the legacy `email-…` form so returning
  // users from before the unified flow are still recognized.
  const [existing, setExisting] = useState<Annotator | null>(null);
  const [available, setAvailable] = useState<null | boolean>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  useEffect(() => {
    if (!validForSubmit) {
      setExisting(null); setAvailable(null); setCheckError(null); setChecking(false);
      return;
    }
    const candidates = candidateIdsForIdentity(trimmed);
    const ctrl = new AbortController();
    setChecking(true);
    setCheckError(null);
    const t = setTimeout(() => {
      (async () => {
        try {
          let found: Annotator | null = null;
          for (const id of candidates) {
            found = await fetchProfileById(id);
            if (found) break;
          }
          if (ctrl.signal.aborted) return;
          setExisting(found);

          if (!found) {
            const r = await fetch(
              `/api/annotators/id-available/${encodeURIComponent(candidates[0])}`,
              { signal: ctrl.signal },
            );
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const j = (await r.json()) as { available: boolean };
            if (ctrl.signal.aborted) return;
            setAvailable(j.available);
          } else {
            setAvailable(false);
          }
        } catch (e) {
          if ((e as Error).name !== 'AbortError') {
            setCheckError('Could not check availability');
          }
        } finally {
          if (!ctrl.signal.aborted) setChecking(false);
        }
      })();
    }, 250);
    return () => { ctrl.abort(); clearTimeout(t); };
  }, [trimmed, validForSubmit]);

  const suggestions = useMemo(() => {
    if (!validForSubmit || existing || available !== false) return [];
    const base = trimmed.toLowerCase().replace(/[^a-z0-9._-]/g, '_');
    const rand = Math.random().toString(36).slice(2, 6);
    return [`${base}-2`, `${base}-${new Date().getFullYear() % 100}`, `${base}-${rand}`];
  }, [trimmed, validForSubmit, existing, available]);

  const buildNewAnnotator = (): Annotator => ({
    id: buildAnnotatorId({ method: 'identity', identity: trimmed }),
    displayName: trimmed,
    email: trimmed.includes('@') ? trimmed.toLowerCase() : undefined,
    authMethod: 'identity',
    createdAt: new Date().toISOString(),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!validForSubmit) return;
        if (existing) onSignIn(existing);
        else if (available === true) onSignIn(buildNewAnnotator());
      }}
      className="space-y-3"
    >
      <Field
        label="Username or email"
        value={value}
        onChange={setValue}
        type="text"
        required
        placeholder="jane or jane@example.com"
        autoFocus
      />

      {!hasInput && (
        <p className="text-[10px] text-slate-500 leading-relaxed">
          No password needed. Use letters, numbers, underscore, dot, hyphen, or <code className="font-mono">@</code>.
          Spaces and other characters aren't allowed.
        </p>
      )}

      {hasInput && !charsValid && (
        <p className="text-[10px] text-red-400 font-mono">
          Only letters, numbers, and <code>. _ - @</code> are allowed — no spaces.
        </p>
      )}

      {hasInput && charsValid && !lenValid && (
        <p className="text-[10px] text-slate-500 font-mono">
          At least {IDENTITY_MIN_LEN} characters.
        </p>
      )}

      {validForSubmit && (
        <p className="text-[10px] text-slate-500 font-mono">
          Stored as <code className="bg-white/[0.06] px-1 rounded text-slate-300">{previewId}</code>.
        </p>
      )}

      {validForSubmit && checking && (
        <p className="text-[10px] text-slate-500 font-mono">Checking…</p>
      )}

      {validForSubmit && !checking && checkError && (
        <p className="text-[10px] text-amber-400 font-mono">{checkError}</p>
      )}

      {validForSubmit && !checking && existing && (
        <div className="rounded border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-1">
          <p className="text-[11px] text-emerald-300 font-medium">
            Welcome back, {existing.displayName}.
          </p>
          <p className="text-[10px] text-slate-400 font-mono break-all">
            Signed up as {existing.id}
            {existing.role ? ` · ${existing.role}` : ''}
            {existing.affiliation ? ` · ${existing.affiliation}` : ''}
          </p>
        </div>
      )}

      {validForSubmit && !checking && !existing && available === true && (
        <p className="text-[10px] text-emerald-400 font-mono">✓ Available.</p>
      )}

      {validForSubmit && !checking && !existing && available === false && (
        <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
          <p className="text-[11px] text-amber-200">
            ⚠ <span className="font-medium">{previewId}</span> already has annotations on file
            but no profile. If that's you, sign in to pick up your work; otherwise pick a
            different identity.
          </p>
          <button
            type="button"
            onClick={() => onSignIn(buildNewAnnotator())}
            className="w-full px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 text-amber-100"
          >
            Continue as {trimmed}
          </button>
          {suggestions.length > 0 && (
            <div className="pt-1">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Or try:</div>
              <div className="flex flex-wrap gap-1.5">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setValue(s)}
                    className="px-2 py-1 rounded text-[11px] bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-slate-300 font-mono"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {validForSubmit && (existing || available === true) && (
        <button
          type="submit"
          disabled={checking}
          className="w-full px-4 py-2 rounded text-[11px] uppercase tracking-wider bg-violet-500/20 hover:bg-violet-500/30 border border-violet-400/40 disabled:bg-white/[0.04] disabled:border-white/[0.06] disabled:text-slate-600 text-violet-100 font-medium transition-colors"
        >
          {existing ? 'Sign in' : 'Continue'}
        </button>
      )}
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  required,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-slate-500">
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="mt-1 w-full px-2.5 py-1.5 rounded bg-[#0a0b0d] border border-white/[0.08] focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/40 focus:outline-none text-slate-200 text-xs font-mono transition-colors"
      />
    </label>
  );
}
