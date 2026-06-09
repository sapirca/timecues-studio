import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAnnotator } from '../context/AnnotatorContext';
import { useDemo } from '../context/DemoContext';
import { annotatorHeaders } from '../utils/annotatorHeaders';
import { AnnotatorBadge } from '../components/AnnotatorBadge';
import { AppPageHeader } from '../components/AppPageHeader';
import { loadDatasetConfig } from '../services/datasetConfig';
import { fetchAdminStatus } from '../services/admin';
import { IS_STATIC_DEMO, MAIN_APP_URL } from '../state/staticDemo';
import type { AccessTier } from '../types/datasetConfig';

interface CorpusSummary {
  /** Display name. Falls back to "TimeCues Studio" when corpusName unset. */
  name: string;
  /** Total members across all non-public tiers. */
  memberCount: number | null;
  /** Number of admins. Never an email address — anonymous visitors must not
   *  be able to enumerate identities from this page. */
  adminCount: number;
  /** True when no admin has claimed this dataset yet — bootstrap mode.
   *  Drives whether the page offers "Start a new dataset" or "Enter
   *  existing dataset" (we only support one corpus per deploy, so it's one
   *  or the other, never both). */
  isBootstrap: boolean;
  /** Resolved tier of the currently-signed-in annotator, or null when
   *  anonymous / not in peopleByEmail (i.e. public). Server-resolved. */
  signedInTier: AccessTier | null;
}

const DEFAULT_NAME = 'TimeCues Studio';

// Injected at container start from VITE_COMMIT_SHA (set by your deployment to
// the build's commit). Empty / unset in local dev (we don't show a placeholder
// there).
const COMMIT_SHA = (import.meta.env.VITE_COMMIT_SHA as string | undefined)?.trim() || '';
const COMMIT_SHORT = COMMIT_SHA ? COMMIT_SHA.slice(0, 7) : '';

// Captured at vite startup in vite.config.ts → ≈ container start ≈ deploy
// time in prod. ISO 8601 UTC; trimmed to `YYYY-MM-DD HH:MM UTC` for the footer.
const BUILD_TIME_ISO = (import.meta.env.VITE_BUILD_TIME as string | undefined)?.trim() || '';
const BUILD_TIME_SHORT = BUILD_TIME_ISO
  ? BUILD_TIME_ISO.replace('T', ' ').replace(/:\d\d\.\d+Z$/, ' UTC')
  : '';

/**
 * Main entry page. Two cards, always:
 *   1. Enter Demo — anonymous, full UI on the default corpus (edits in browser).
 *   2. Either "Start a new dataset" (bootstrap mode, no admin claimed) OR
 *      "Enter existing dataset" (admin already set) — never both, since
 *      this deploy hosts exactly one corpus.
 *
 * Login is lazy: anonymous visitors see this page; clicking a card that needs
 * an identity routes to /login?returnTo=<destination>, except the
 * "new dataset" card which routes to /new-dataset (Google-only claim flow).
 */
export function LandingPage() {
  const navigate = useNavigate();
  const { annotator } = useAnnotator();
  const { isDemo } = useDemo();
  // The synthetic demo annotator is not a real identity; treat the user as
  // anonymous on the chooser so the corpus card doesn't falsely advertise
  // "Signed in" / "Continue →" for a session that still needs real auth.
  const realAnnotator = annotator && !isDemo ? annotator : null;
  const annotatorId = annotator?.id ?? null;
  const [summary, setSummary] = useState<CorpusSummary | null>(null);
  const [songCount, setSongCount] = useState<number | null>(null);

  // Two independent loads so the card renders as soon as the cheap one (config)
  // arrives. The manifest is bigger and only contributes the song-count
  // fragment — letting it block the whole card costs us a visible ~1s of
  // placeholder pulse. Both endpoints are anonymous-friendly so the landing
  // page can describe the dataset before the visitor signs in; errors collapse
  // to "TimeCues Studio" with no counts.
  useEffect(() => {
    let cancelled = false;

    // Two parallel loads. `loadDatasetConfig` is the trimmed (public) config —
    // it gives us `corpusName` but NOT the whitelist. `fetchAdminStatus`
    // gives us aggregate counts + the caller's server-resolved tier + mode
    // (bootstrap detection), with no peer addresses for non-admins.
    Promise.all([
      loadDatasetConfig().catch(() => null),
      fetchAdminStatus().catch(() => null),
    ]).then(([cfg, status]) => {
      if (cancelled) return;
      const memberCount = status
        ? (status.adminCount + status.teamCount + status.researcherCount) || null
        : null;
      setSummary({
        name: cfg?.corpusName?.trim() || DEFAULT_NAME,
        memberCount,
        adminCount: status?.adminCount ?? 0,
        isBootstrap: status?.mode === 'bootstrap',
        signedInTier: status?.tier ?? null,
      });
    });

    // Manifest is the slow load — full song list. Only needed for the count,
    // so it fills in independently after the card has already rendered.
    fetch('/analysis/manifest.json', {
      headers: annotatorHeaders(),
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((manifest) => {
        if (cancelled) return;
        const songs: unknown = Array.isArray(manifest) ? manifest : manifest?.songs;
        if (Array.isArray(songs)) setSongCount(songs.length);
      });

    return () => { cancelled = true; };
  }, [annotatorId]);

  const goWithAuth = (returnTo: string) => {
    if (realAnnotator) navigate(returnTo);
    else navigate(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  };

  const corpusName = summary?.name ?? DEFAULT_NAME;

  return (
    <div className="min-h-screen bg-[#0a0b0d] text-slate-200 flex flex-col">
      <AppPageHeader
        back={false}
        rightSlot={annotator ? <AnnotatorBadge inline /> : null}
      />

      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-5xl space-y-10">
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-medium text-slate-100">Where to start?</h1>
            <p className="text-[12px] text-slate-500">
              {IS_STATIC_DEMO ? (
                <>
                  Always-on public mirror — explore the sample songs, no install.
                  {MAIN_APP_URL && (
                    <>
                      {' '}The full app (sign-in, your own corpus) lives{' '}
                      <a
                        href={MAIN_APP_URL}
                        className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2"
                      >
                        here
                      </a>
                      .
                    </>
                  )}
                </>
              ) : realAnnotator ? (
                `Signed in as ${realAnnotator.displayName}.`
              ) : (
                'Try it anonymously, or sign in to work on a real corpus.'
              )}
            </p>
          </div>

          {/* Two cards: Demo + exactly ONE of (new dataset | enter existing),
              chosen by whether an admin has claimed this deploy yet. We
              optimistically render the "enter existing" variant before config
              loads — on GCP the config fetch can cost 1–2s and a skeleton
              placeholder felt worse than briefly-stub text that fills in.
              Bootstrap-mode deploys (no admin yet) will swap the card once
              config arrives; that's a one-time event per deploy. */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-3xl mx-auto">
            <EntryCard
              accent="violet"
              led="!bg-violet-400 !shadow-[0_0_8px_rgba(167,139,250,0.55)]"
              eyebrow="No sign-in"
              title="Enter Demo"
              body="Full annotator UI on the public sample songs. Uploading and downloading are disabled; your edits are cached in this browser and never leave it."
              cta="Try the demo →"
              onClick={() => navigate('/demo')}
            />
            {/* The second card needs the backend (sign-in / admin bootstrap),
                so on the static mirror it's replaced by an outbound link to the
                full app when one is configured, and otherwise omitted. */}
            {IS_STATIC_DEMO ? (
              MAIN_APP_URL && (
                <EntryCard
                  accent="cyan"
                  led="!bg-cyan-400 !shadow-[0_0_8px_rgba(34,211,238,0.55)]"
                  eyebrow="Full app"
                  title="Sign in & work on a corpus"
                  body="The complete app — Google sign-in, your own annotator namespace, detectors, and saving — runs on the main server."
                  cta="Open the full app →"
                  onClick={() => { window.location.href = MAIN_APP_URL; }}
                />
              )
            ) : summary?.isBootstrap ? (
              <EntryCard
                accent="emerald"
                led="!bg-emerald-400 !shadow-[0_0_8px_rgba(52,211,153,0.55)]"
                eyebrow="As admin"
                title="Start a new dataset"
                body="No admin has claimed this deploy yet. Name your corpus and sign in with Google to become its first admin."
                cta="Set up new dataset →"
                onClick={() => navigate('/new-dataset')}
              />
            ) : (
              <EntryCard
                accent="cyan"
                led="!bg-cyan-400 !shadow-[0_0_8px_rgba(34,211,238,0.55)]"
                eyebrow={realAnnotator ? 'Signed in' : 'Returning user'}
                title={summary ? `Enter ${corpusName}` : 'Enter dataset'}
                body={describeCorpus(summary, songCount, !!realAnnotator)}
                cta={realAnnotator ? 'Continue →' : 'Sign in →'}
                onClick={() => goWithAuth('/prep')}
              />
            )}
          </div>
        </div>
      </main>

      {COMMIT_SHORT && (
        <footer className="px-6 py-3 text-center font-mono text-[10px] text-slate-600">
          <a
            href={`https://github.com/sapirca/timecues-studio/commit/${COMMIT_SHA}`}
            target="_blank"
            rel="noreferrer"
            title={`Deployed build: ${COMMIT_SHA}`}
            className="hover:text-slate-400 transition-colors"
          >
            build {COMMIT_SHORT}
          </a>
          {BUILD_TIME_SHORT && (
            <span title={BUILD_TIME_ISO} className="ml-2 text-slate-700">
              · {BUILD_TIME_SHORT}
            </span>
          )}
        </footer>
      )}
    </div>
  );
}

const TIER_LABEL: Record<AccessTier, string> = {
  admin: 'admin',
  researcher: 'researcher',
  team: 'team member',
};

function describeCorpus(summary: CorpusSummary | null, songCount: number | null, signedIn: boolean): string {
  if (!summary) {
    return signedIn
      ? 'Pick up where you left off — your annotations and the corpus you\'ve been working on.'
      : 'Sign in and pick up where you left off — your annotations and the corpus you\'ve been working on.';
  }
  const parts: string[] = [];
  if (songCount != null) parts.push(`${songCount} song${songCount === 1 ? '' : 's'}`);
  if (summary.memberCount != null) parts.push(`${summary.memberCount} member${summary.memberCount === 1 ? '' : 's'}`);
  if (summary.adminCount > 0) {
    parts.push(`${summary.adminCount} admin${summary.adminCount === 1 ? '' : 's'}`);
  }
  const stats = parts.length > 0 ? ` (${parts.join(' · ')})` : '';
  // When signed in we name the tier — "Resume work as admin" reads better
  // than the generic "Resume work on this corpus" and answers "what can I
  // do here?" before clicking. Public/null tier (signed in but not in
  // peopleByEmail) falls back to the generic phrasing.
  let lead: string;
  if (signedIn) {
    const tier = summary.signedInTier;
    lead = tier ? `Resume work on this corpus as ${TIER_LABEL[tier]}` : 'Resume work on this corpus';
  } else {
    lead = 'Sign in to resume work on this corpus';
  }
  return `${lead}${stats}.`;
}

const ACCENT_BORDER: Record<string, string> = {
  violet:  'hover:border-violet-500/40',
  emerald: 'hover:border-emerald-500/40',
  cyan:    'hover:border-cyan-500/40',
};

const ACCENT_EYEBROW: Record<string, string> = {
  violet:  'text-violet-300',
  emerald: 'text-emerald-300',
  cyan:    'text-cyan-300',
};

function EntryCard({
  accent, led, eyebrow, title, body, cta, onClick,
}: {
  accent: 'violet' | 'emerald' | 'cyan';
  led: string;
  eyebrow: string;
  title: string;
  body: string;
  cta: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`group text-left rounded-lg border border-white/[0.06] bg-[#14171d] hover:bg-[#1b1f27] transition-colors p-6 space-y-3 ${ACCENT_BORDER[accent]}`}
    >
      <div className="flex items-center gap-2">
        <span className={`tc-led tc-led-mute group-hover:${led} transition-all`} />
        <span className={`text-[10px] uppercase tracking-[0.18em] ${ACCENT_EYEBROW[accent]}`}>{eyebrow}</span>
      </div>
      <h2 className="text-lg font-medium text-slate-100">{title}</h2>
      <p className="text-[12px] text-slate-400 leading-relaxed">{body}</p>
      <p className="text-[11px] text-slate-500 group-hover:text-slate-300 transition-colors pt-1">{cta}</p>
    </button>
  );
}
