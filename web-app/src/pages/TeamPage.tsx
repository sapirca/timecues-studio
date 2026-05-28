import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAnnotator } from '../context/AnnotatorContext';
import {
  fetchTeamStats,
  type TeamStatsAnnotator,
  type TeamStatsResponse,
  type TeamStatsSourceStats,
} from '../services/teamStats';
import { AnnotatorComparisonPanel } from '../components/AnnotatorComparisonPanel';
import { useAdmin } from '../hooks/useAdmin';
import { loadDatasetConfig, purgePerson, saveDatasetConfig } from '../services/datasetConfig';
import { DEFAULT_DATASET_CONFIG, type AccessTier, type PersonEntry } from '../types/datasetConfig';
import { fetchAllProfiles, fetchProfileById, inviteAnnotator } from '../services/annotatorProfile';
import { DeleteConfirmDialog } from '../components/DeleteConfirmDialog';
import { InfoBanner } from '../components/InfoBanner';
import type { Annotator } from '../types/annotator';
import {
  buildAnnotatorId,
  candidateIdsForIdentity,
  IDENTITY_MIN_LEN,
  IDENTITY_RE,
  isValidIdentity,
} from '../types/annotator';

type Tab = 'annotators' | 'agreement' | 'members';

const SOURCE_TONE = {
  manual: 'text-amber-300',
  eye: 'text-cyan-300',
  autoGuess: 'text-violet-300',
} as const;

export function TeamPage() {
  const { annotator } = useAnnotator();
  const { status: adminStatus } = useAdmin();
  const [tab, setTab] = useState<Tab>('annotators');
  const [data, setData] = useState<TeamStatsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    fetchTeamStats()
      .then(setData)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  // Tier-by-email lookup for the Annotators-tab badges. Prefer the unified
  // peopleByEmail map; fall back to legacy adminEmails so older configs
  // still render Admin chips correctly.
  const tiersByEmail = useMemo<Record<string, AccessTier>>(() => {
    if (adminStatus?.peopleByEmail) {
      const out: Record<string, AccessTier> = {};
      for (const [email, entry] of Object.entries(adminStatus.peopleByEmail)) out[email] = entry.tier;
      return out;
    }
    const out: Record<string, AccessTier> = {};
    for (const e of adminStatus?.adminEmails ?? []) out[e] = 'admin';
    for (const e of adminStatus?.teamEmails  ?? []) out[e] = 'team';
    return out;
  }, [adminStatus]);

  return (
    <div className="min-h-screen bg-[#0a0b0d] text-slate-200 px-6 pb-6 pt-3">
      <div className="max-w-5xl mx-auto space-y-5">
        <InfoBanner id="team.v1" title="Team" accent="pink">
          See <strong>who annotated what</strong>, inter-annotator agreement, and manage access for collaborators.
        </InfoBanner>
        <header className="pb-3 border-b border-white/[0.06]">
          <h1 className="text-xl font-medium text-slate-100">Team</h1>
          <p className="text-sm text-slate-400 mt-1">
            Who has annotated what, how long they spent, and how they agree.
          </p>
        </header>

        <nav className="flex gap-1 text-xs uppercase tracking-wider">
          {(['annotators', 'agreement', 'members'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 rounded transition-colors ${
                tab === t
                  ? 'bg-cyan-500/15 text-cyan-200 border border-cyan-400/40'
                  : 'bg-white/[0.03] text-slate-500 hover:text-slate-300 border border-transparent'
              }`}
            >
              {t === 'annotators' ? 'Annotators' : t === 'agreement' ? 'Agreement' : 'Members'}
            </button>
          ))}
        </nav>

        {loading && tab !== 'members' && <p className="text-sm text-slate-400">Loading…</p>}
        {err && tab !== 'members' && <p className="text-sm text-red-400">Failed to load team stats: {err}</p>}

        {data && tab === 'annotators' && (
          <AnnotatorsTab
            data={data}
            currentAnnotatorId={annotator?.id ?? null}
            tiersByEmail={tiersByEmail}
          />
        )}
        {data && tab === 'agreement' && (
          <AgreementTab slugs={data.multiAnnotatorSongs} />
        )}
        {tab === 'members' && <MembersTab currentAnnotatorId={annotator?.id ?? null} />}
      </div>
    </div>
  );
}

// ─── Annotators tab ──────────────────────────────────────────────────────────

function AnnotatorsTab({
  data,
  currentAnnotatorId,
  tiersByEmail,
}: {
  data: TeamStatsResponse;
  currentAnnotatorId: string | null;
  tiersByEmail: Record<string, AccessTier>;
}) {
  const totals = useMemo(() => {
    let manual = 0, eye = 0, autoGuess = 0, custom = 0, time = 0;
    for (const a of data.annotators) {
      manual += a.manual.count;
      eye += a.eye.count;
      autoGuess += a.autoGuess.count;
      custom += a.custom.count;
      time += a.totalTimeSeconds;
    }
    return { manual, eye, autoGuess, custom, time, annotators: data.annotators.length };
  }, [data.annotators]);

  if (data.annotators.length === 0) {
    return (
      <section className="rounded-lg border border-white/[0.06] bg-[#14171d]/60 p-6 text-center">
        <p className="text-sm text-slate-300">No annotation data on disk yet.</p>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-white/[0.06] bg-[#14171d]/60 p-4">
        <header className="text-xs uppercase tracking-wider text-slate-400 mb-3">
          Overview
        </header>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat label="Annotators" value={totals.annotators.toString()} />
          <Stat label="Boundaries" value={totals.manual.toString()} tone="text-amber-300" />
          <Stat label="Eye" value={totals.eye.toString()} tone="text-cyan-300" />
          <Stat label="Auto-guess" value={totals.autoGuess.toString()} tone="text-violet-300" />
          <Stat label="Custom" value={totals.custom.toString()} tone="text-emerald-300" />
          <Stat label="Time logged" value={fmtDuration(totals.time)} />
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {data.annotators.map((a) => (
          <AnnotatorCard
            key={a.id}
            a={a}
            isMe={a.id === currentAnnotatorId}
            tier={tiersByEmail[a.id] ?? null}
          />
        ))}
      </div>
    </div>
  );
}

function AnnotatorCard({ a, isMe, tier }: { a: TeamStatsAnnotator; isMe: boolean; tier: AccessTier | null }) {
  const tierBadge = tier ? TIER_TONE[tier] : null;
  return (
    <article className={`rounded-lg border ${isMe ? 'border-cyan-500/30' : 'border-white/[0.06]'} bg-[#14171d]/60 p-4 space-y-3`}>
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-medium text-slate-100 truncate" title={a.id}>{a.id}</h3>
            {isMe && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-200 border border-cyan-400/30">
                You
              </span>
            )}
            {tier && tierBadge && (
              <span
                title={`Tier: ${tier}`}
                className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${tierBadge.bg} ${tierBadge.text} ${tierBadge.border} border`}
              >
                {tier}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-1">
            {a.totalAnnotations} annotation{a.totalAnnotations === 1 ? '' : 's'} ·{' '}
            {fmtDuration(a.totalTimeSeconds)} logged
          </p>
        </div>
        <div className="text-right text-xs text-slate-400 shrink-0">
          {a.lastModified ? `Last: ${fmtRelative(a.lastModified)}` : '—'}
        </div>
      </header>

      <div className="grid grid-cols-3 gap-2">
        <SourceCell label="Boundaries" stats={a.manual} tone={SOURCE_TONE.manual} />
        <SourceCell label="Eye" stats={a.eye} tone={SOURCE_TONE.eye} />
        <SourceCell label="Auto-guess" stats={a.autoGuess} tone={SOURCE_TONE.autoGuess} />
      </div>

      {a.custom.count > 0 && (
        <div className="text-xs text-slate-300 pt-2 border-t border-white/[0.04]">
          <span className="text-emerald-300 font-medium">Custom:</span>{' '}
          {a.custom.count} file{a.custom.count === 1 ? '' : 's'} across{' '}
          {a.custom.scripts.length} script{a.custom.scripts.length === 1 ? '' : 's'}
          {a.custom.scripts.length > 0 && (
            <span className="text-slate-400"> ({a.custom.scripts.join(', ')})</span>
          )}
        </div>
      )}
    </article>
  );
}

function SourceCell({
  label,
  stats,
  tone,
}: {
  label: string;
  stats: TeamStatsSourceStats;
  tone: string;
}) {
  const reviewedPct = stats.count > 0 ? Math.round((stats.reviewedCount / stats.count) * 100) : 0;
  return (
    <div className="rounded border border-white/[0.04] bg-black/20 p-2.5">
      <div className={`text-xs uppercase tracking-wider ${tone}`}>{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-xl font-medium text-slate-100 tabular-nums">{stats.count}</span>
        <span className="text-xs text-slate-400">songs</span>
      </div>
      <div className="text-xs text-slate-300 mt-1 space-y-0.5">
        <div title={`${stats.reviewedCount} of ${stats.count} reviewed`}>
          {stats.count > 0 ? `${reviewedPct}% reviewed` : '—'}
        </div>
        <div className="text-slate-400 tabular-nums">
          {fmtDuration(stats.totalTimeSeconds)}
          {stats.count > 0 && stats.totalTimeSeconds > 0 && (
            <span className="text-slate-500">
              {' · '}
              {fmtDuration(stats.totalTimeSeconds / stats.count)} avg
            </span>
          )}
        </div>
        <div className="text-slate-400 tabular-nums">{stats.totalBoundaries} pts</div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded border border-white/[0.04] bg-black/20 p-3">
      <div className="text-xs uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`text-lg font-medium tabular-nums mt-1 ${tone ?? 'text-slate-100'}`}>{value}</div>
    </div>
  );
}

// ─── Agreement tab ───────────────────────────────────────────────────────────

function AgreementTab({ slugs }: { slugs: string[] }) {
  const [selected, setSelected] = useState<string | null>(slugs[0] ?? null);

  if (slugs.length === 0) {
    return (
      <section className="rounded-lg border border-white/[0.06] bg-[#14171d]/60 p-6 text-center">
        <p className="text-sm text-slate-300">
          No song has been annotated by ≥2 annotators yet — nothing to compare.
        </p>
        <p className="text-xs text-slate-400 mt-1">
          Once two or more annotators save the same song, it shows up here.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-3">
      <section className="rounded-lg border border-white/[0.06] bg-[#14171d]/60 p-4">
        <header className="text-xs uppercase tracking-wider text-slate-400 mb-3">
          Songs with ≥2 annotators ({slugs.length})
        </header>
        <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto">
          {slugs.map((slug) => (
            <button
              key={slug}
              type="button"
              onClick={() => setSelected(slug)}
              className={`px-2.5 py-1 rounded text-xs transition-colors ${
                slug === selected
                  ? 'bg-cyan-500/20 text-cyan-100 border border-cyan-400/40'
                  : 'bg-white/[0.03] text-slate-300 hover:text-slate-100 border border-white/[0.04]'
              }`}
              title={slug}
            >
              {slug}
            </button>
          ))}
        </div>
      </section>

      {selected && <AnnotatorComparisonPanel slug={selected} />}
    </div>
  );
}

// ─── Members tab ─────────────────────────────────────────────────────────────
// Admins manage two allowlists here:
//   - Admins (full control: corpus + config + member management)
//   - Team members (full corpus access; cannot manage members or upload)
// Everyone NOT on either list is "public" and limited to the shipped default
// songs in data-default/. The TeamPage route is already gated by RequireAdmin,
// so we render the editor unconditionally inside.

type TierFilter = 'all' | AccessTier;

function MembersTab({ currentAnnotatorId }: { currentAnnotatorId: string | null }) {
  const navigate = useNavigate();
  const { status, refresh } = useAdmin();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TierFilter>('all');
  const [pendingRemove, setPendingRemove] = useState<{ email: string } | null>(null);

  const canEdit = !!status?.isAdmin;

  // Build the unified people list. peopleByEmail is the canonical source;
  // for legacy configs we synthesize it from adminEmails/teamEmails so the
  // table always shows everyone, even before the first peopleByEmail write.
  const people = useMemo<Array<{ email: string; tier: AccessTier; invitedAt?: string; invitedBy?: string }>>(() => {
    if (status?.peopleByEmail) {
      return Object.entries(status.peopleByEmail).map(([email, entry]) => ({ email, ...entry }));
    }
    const out: Array<{ email: string; tier: AccessTier }> = [];
    for (const e of status?.adminEmails ?? []) out.push({ email: e, tier: 'admin' });
    for (const e of status?.teamEmails ?? []) out.push({ email: e, tier: 'team' });
    return out;
  }, [status]);

  const visiblePeople = useMemo(() => {
    const list = filter === 'all' ? people : people.filter((p) => p.tier === filter);
    return [...list].sort((a, b) => {
      const order: Record<AccessTier, number> = { admin: 0, researcher: 1, team: 2 };
      if (order[a.tier] !== order[b.tier]) return order[a.tier] - order[b.tier];
      return a.email.localeCompare(b.email);
    });
  }, [people, filter]);

  const adminCount = people.filter((p) => p.tier === 'admin').length;

  // Persist a tier change by rebuilding peopleByEmail and writing it via
  // /api/dataset-config. The server seeds legacy entries on the first write.
  const persistTier = async (mutate: (m: Record<string, PersonEntry>) => Record<string, PersonEntry>) => {
    setBusy(true);
    setError(null);
    try {
      const cfg = { ...DEFAULT_DATASET_CONFIG, ...(await loadDatasetConfig()) };
      const seeded: Record<string, PersonEntry> = { ...(cfg.peopleByEmail ?? {}) };
      // Seed from legacy fields on first edit so nobody is silently demoted.
      if (!cfg.peopleByEmail) {
        for (const e of cfg.adminEmails ?? []) if (!seeded[e]) seeded[e] = { tier: 'admin' };
        for (const e of cfg.teamEmails ?? []) if (!seeded[e]) seeded[e] = { tier: 'team' };
      }
      const nextPeople = mutate(seeded);
      // Derive legacy adminEmails/teamEmails so anything still reading them
      // keeps working. Researchers are NOT folded into adminEmails — they
      // get their access through peopleByEmail only.
      const adminEmails: string[] = [];
      const teamEmails: string[] = [];
      for (const [email, entry] of Object.entries(nextPeople)) {
        if (entry.tier === 'admin') adminEmails.push(email);
        else if (entry.tier === 'team') teamEmails.push(email);
      }
      await saveDatasetConfig({
        ...cfg,
        peopleByEmail: Object.keys(nextPeople).length > 0 ? nextPeople : undefined,
        adminEmails: adminEmails.length > 0 ? adminEmails : undefined,
        teamEmails: teamEmails.length > 0 ? teamEmails : undefined,
      });
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setTier = async (email: string, tier: AccessTier) => {
    const isSelfDemote = email === currentAnnotatorId
      && people.find((p) => p.email === email)?.tier === 'admin'
      && tier !== 'admin';
    if (isSelfDemote && adminCount <= 1) return;
    await persistTier((m) => {
      const next = { ...m };
      next[email] = { ...(next[email] ?? {}), tier };
      return next;
    });
    if (isSelfDemote) navigate('/');
  };

  const requestRemovePerson = (email: string) => {
    const isAdminRow = people.find((p) => p.email === email)?.tier === 'admin';
    if (isAdminRow && adminCount <= 1) return;
    setError(null);
    setPendingRemove({ email });
  };

  // Destructive: drops the row from peopleByEmail AND purges every
  // annotation file + profile on disk that belongs to the person. The
  // DELETE_USER typed confirmation is enforced by DeleteConfirmDialog
  // before we get here.
  const confirmRemovePerson = async () => {
    if (!pendingRemove) return;
    const email = pendingRemove.email;
    const isSelf = email === currentAnnotatorId;
    setBusy(true);
    setError(null);
    try {
      await purgePerson(email);
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
    if (isSelf) navigate('/');
  };

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-white/[0.06] bg-[#14171d]/60 p-4 space-y-2">
        <header className="text-xs uppercase tracking-wider text-slate-400">
          About access
        </header>
        <p className="text-sm text-slate-300 leading-relaxed">
          Each email is assigned one tier. Tiers stack — every capability of a lower tier is
          included in the tiers above it.
        </p>
        <ul className="text-sm text-slate-300 leading-relaxed list-disc list-inside space-y-1">
          <li><span className="text-emerald-300 font-medium">Admin</span> — everything: manage members, lock grid, set BPM, upload/delete songs, see and export every annotator's work.</li>
          <li><span className="text-violet-300 font-medium">Researcher</span> — full data access: upload/delete songs, see all annotators, open the Team Dashboard, export the full dataset. Cannot manage members or set grid lock.</li>
          <li><span className="text-cyan-300 font-medium">Team</span> — annotate freely on the full corpus, but only see their own work.</li>
          <li><span className="text-slate-200 font-medium">Public</span> (absent from the list) — limited to the shipped default songs.</li>
        </ul>
        {status?.mode === 'bootstrap' && (
          <p className="text-sm text-amber-300">
            No admin attached yet — the dataset is in bootstrap mode and every signed-in
            annotator counts as admin. Invite someone or assign yourself a tier below to lock things down.
          </p>
        )}
        {!canEdit && status?.tier === 'researcher' && (
          <p className="text-sm text-violet-300">
            Researcher view — you can see who has access but can't edit. Ask an admin to change tiers.
          </p>
        )}
      </section>

      {/* Invite annotator (admin) */}
      {canEdit && <InviteAnnotatorSection onChanged={refresh} />}

      {/* Unified People table */}
      <section className="rounded-lg border border-white/[0.08] bg-[#14171d]/60 p-4 space-y-3">
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-xs uppercase tracking-wider text-slate-200">
            People ({people.length})
          </div>
          <div className="flex gap-1 text-xs uppercase tracking-wider">
            {(['all', 'admin', 'researcher', 'team'] as TierFilter[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setFilter(t)}
                className={`px-2.5 py-1 rounded border transition-colors ${
                  filter === t
                    ? 'bg-white/[0.08] text-slate-100 border-white/20'
                    : 'bg-transparent text-slate-400 hover:text-slate-200 border-white/[0.06]'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </header>

        {visiblePeople.length === 0 && (
          <p className="text-sm text-slate-400">
            {people.length === 0
              ? 'Nobody added yet. Use the Invite annotator form above to add a teammate.'
              : 'No matches for this filter.'}
          </p>
        )}

        <div className="space-y-1">
          {visiblePeople.map((p) => (
            <PersonRow
              key={p.email}
              email={p.email}
              tier={p.tier}
              isMe={p.email === currentAnnotatorId}
              canEdit={canEdit}
              busy={busy}
              isLastAdmin={p.tier === 'admin' && adminCount <= 1}
              onChangeTier={(t) => void setTier(p.email, t)}
              onRemove={() => requestRemovePerson(p.email)}
            />
          ))}
        </div>
      </section>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {busy && <p className="text-sm text-slate-400">Saving…</p>}

      <DeleteConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(o) => { if (!o) setPendingRemove(null); }}
        title="Remove user"
        description={
          pendingRemove
            ? `This permanently deletes ${pendingRemove.email}'s membership AND every annotation they have ever saved (manual, eye, auto-guess, and per-script custom) plus their saved profile. There is no undo.`
            : undefined
        }
        confirmWord="DELETE_USER"
        onConfirm={confirmRemovePerson}
      />
    </div>
  );
}

const TIER_TONE: Record<AccessTier, { text: string; bg: string; border: string }> = {
  admin:      { text: 'text-emerald-300', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30' },
  researcher: { text: 'text-violet-300',  bg: 'bg-violet-500/10',  border: 'border-violet-500/30' },
  team:       { text: 'text-cyan-300',    bg: 'bg-cyan-500/10',    border: 'border-cyan-500/30' },
};

function PersonRow({
  email, tier, isMe, canEdit, busy, isLastAdmin, onChangeTier, onRemove,
}: {
  email: string;
  tier: AccessTier;
  isMe: boolean;
  canEdit: boolean;
  busy: boolean;
  isLastAdmin: boolean;
  onChangeTier: (t: AccessTier) => void;
  onRemove: () => void;
}) {
  const tone = TIER_TONE[tier];
  return (
    <div className={`flex flex-wrap items-center gap-2 px-2.5 py-2 rounded border ${tone.border} ${tone.bg}`}>
      <span className="flex-1 min-w-[16ch] font-mono text-sm text-slate-100 truncate" title={email}>
        {email}
      </span>
      {isMe && (
        <span className="text-xs uppercase tracking-wider px-2 py-0.5 rounded bg-cyan-500/15 text-cyan-200 border border-cyan-400/30">
          You
        </span>
      )}
      {canEdit ? (
        <select
          value={tier}
          disabled={busy || isLastAdmin}
          onChange={(e) => onChangeTier(e.target.value as AccessTier)}
          title={isLastAdmin ? 'Cannot change the last admin' : 'Change tier'}
          className={`px-2.5 py-1.5 rounded bg-[#0e1015] border border-white/10 text-sm font-mono ${tone.text} disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          <option value="admin">Admin</option>
          <option value="researcher">Researcher</option>
          <option value="team">Team</option>
        </select>
      ) : (
        <span className={`px-2 py-0.5 rounded border border-white/[0.06] text-xs uppercase tracking-wider ${tone.text}`}>
          {tier}
        </span>
      )}
      {canEdit && (
        <button
          type="button"
          disabled={busy || isLastAdmin}
          onClick={onRemove}
          title={isLastAdmin ? 'Cannot remove the last admin' : 'Remove from dataset and delete all of their annotation data'}
          className="px-2.5 py-1.5 rounded text-sm border border-white/10 text-slate-300 hover:text-rose-300 hover:border-rose-500/40 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Remove
        </button>
      )}
    </div>
  );
}

// ─── Invite annotator (admin) ────────────────────────────────────────────────
// One-step "pre-register a teammate" form. Writes a profile to
// data/annotators/<id>.json AND adds the identity to the allowlist atomically.
// The identity field uses the same "username or email" validation as the
// login screen (see IDENTITY_RE in types/annotator.ts). When the invitee
// later signs in with the matching value, they're recognized and don't have
// to retype name/role/affiliation. If the identity is an email address, the
// server also adds the Google-form id (no prefix) to the allowlist so the
// invitee can equivalently sign in via Google.

// Loose email shape check matching the login screen — Google sign-in
// requires the input to be an addressable email, but we don't try to
// verify the mailbox (Google itself does that at OAuth time).
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function InviteAnnotatorSection({ onChanged }: { onChanged: () => void | Promise<void> }) {
  const [identity, setIdentity] = useState('');
  const [authMethod, setAuthMethod] = useState<'identity' | 'google'>('identity');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState('');
  const [affiliation, setAffiliation] = useState('');
  const [tier, setTier] = useState<AccessTier>('team');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const [profiles, setProfiles] = useState<Annotator[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  const refreshList = async () => {
    setLoadingList(true);
    try { setProfiles(await fetchAllProfiles()); }
    catch { /* keep last list */ }
    finally { setLoadingList(false); }
  };

  useEffect(() => { void refreshList(); }, []);

  const trimmedIdentity = identity.trim();
  const identityHasInput = trimmedIdentity.length > 0;
  const identityCharsValid = identityHasInput && IDENTITY_RE.test(trimmedIdentity);
  const looksLikeEmail = EMAIL_RE.test(trimmedIdentity);
  const identityBaseValid = isValidIdentity(trimmedIdentity);
  // For Google sign-in the input must be a real email; for local sign-in
  // any IDENTITY_RE-valid string works.
  const identityValid = authMethod === 'google'
    ? identityBaseValid && looksLikeEmail
    : identityBaseValid;

  // Preview id mirrors how the matching sign-in path will build it:
  // Google → bare email (no prefix); identity → local-<sanitized>.
  const previewId = useMemo(() => {
    if (!identityBaseValid) return authMethod === 'google' ? '…' : 'local-…';
    if (authMethod === 'google') {
      if (!looksLikeEmail) return '…';
      return buildAnnotatorId({ method: 'google', email: trimmedIdentity });
    }
    return buildAnnotatorId({ method: 'identity', identity: trimmedIdentity });
  }, [identityBaseValid, authMethod, looksLikeEmail, trimmedIdentity]);

  // Mirror the login screen's "is this id already on file?" check.
  const [existing, setExisting] = useState<Annotator | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (!identityValid) { setExisting(null); setChecking(false); return; }
    // For Google invites: look up the bare-email id directly. For local:
    // try the same candidates the login flow checks.
    const candidates = authMethod === 'google'
      ? [buildAnnotatorId({ method: 'google', email: trimmedIdentity })]
      : candidateIdsForIdentity(trimmedIdentity);
    const ctrl = new AbortController();
    setChecking(true);
    const t = setTimeout(() => {
      (async () => {
        let found: Annotator | null = null;
        for (const id of candidates) {
          found = await fetchProfileById(id);
          if (found) break;
        }
        if (!ctrl.signal.aborted) {
          setExisting(found);
          setChecking(false);
        }
      })();
    }, 250);
    return () => { ctrl.abort(); clearTimeout(t); };
  }, [trimmedIdentity, identityValid, authMethod]);

  const submit = async () => {
    if (!identityValid) return;
    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const effectiveDisplayName = displayName.trim() || existing?.displayName || trimmedIdentity;
      const created = await inviteAnnotator({
        identity: trimmedIdentity,
        authMethod,
        displayName: effectiveDisplayName,
        role: role.trim() || undefined,
        affiliation: affiliation.trim() || undefined,
        tier,
      });
      setOkMsg(`Invited ${created.displayName} as ${tier}.`);
      setIdentity('');
      setDisplayName('');
      setRole('');
      setAffiliation('');
      await Promise.all([refreshList(), Promise.resolve(onChanged())]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-violet-500/20 bg-[#14171d]/60 p-4 space-y-3">
      <header className="flex items-baseline justify-between gap-3">
        <div className="text-xs uppercase tracking-wider text-violet-300">
          Invite annotator
        </div>
        <span className="text-xs text-slate-400">Pre-fills their profile so they don't have to retype it</span>
      </header>

      <p className="text-sm text-slate-300 leading-relaxed">
        Add a teammate's username or email — the field accepts the same characters
        as the sign-in screen ({' '}letters, digits, <code>. _ - @</code>,
        no spaces{' '}). They'll be marked as{' '}
        <span className={
          tier === 'admin' ? 'text-emerald-300'
          : tier === 'researcher' ? 'text-violet-300'
          : 'text-cyan-300'
        }>
          {tier === 'admin' ? 'admin' : tier === 'researcher' ? 'researcher' : 'team member'}
        </span>{' '}
        and recognized automatically when they sign in. Flip <span className="text-violet-200">Google verified</span>{' '}
        below if you want this id to match the Google OAuth address (no <code>local-</code> prefix).
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-slate-400">
            {authMethod === 'google' ? 'Email' : 'Username or email'} <span className="text-red-400">*</span>
          </span>
          <input
            type="text"
            value={identity}
            onChange={(e) => setIdentity(e.target.value)}
            placeholder={authMethod === 'google' ? 'jane@example.com' : 'jane or jane@example.com'}
            className="mt-1 w-full px-3 py-2 rounded bg-[#0e1015] border border-white/10 focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/40 focus:outline-none text-slate-100 text-sm font-mono transition-colors"
          />
          {/* Inline auth-method toggle — sits right under the input so the
              label, validation, and preview id all read top-to-bottom. */}
          <div className="mt-2 inline-flex items-center text-xs uppercase tracking-wider rounded border border-white/[0.08] overflow-hidden">
            <button
              type="button"
              onClick={() => setAuthMethod('identity')}
              className={`px-2.5 py-1 transition-colors ${authMethod === 'identity' ? 'bg-violet-500/20 text-violet-200' : 'text-slate-400 hover:text-slate-200'}`}
            >
              Local
            </button>
            <button
              type="button"
              onClick={() => setAuthMethod('google')}
              disabled={identityHasInput && !looksLikeEmail}
              title={identityHasInput && !looksLikeEmail ? 'Google sign-in needs a valid email' : undefined}
              className={`px-2.5 py-1 border-l border-white/[0.08] transition-colors ${authMethod === 'google' ? 'bg-violet-500/20 text-violet-200' : 'text-slate-400 hover:text-slate-200 disabled:text-slate-600 disabled:hover:text-slate-600 disabled:cursor-not-allowed'}`}
            >
              Google verified
            </button>
          </div>
          {identityHasInput && !identityCharsValid && (
            <span className="block mt-1.5 text-xs text-red-400 font-mono">
              Only letters, numbers, and <code>. _ - @</code> are allowed — no spaces.
            </span>
          )}
          {identityHasInput && identityCharsValid && trimmedIdentity.length < IDENTITY_MIN_LEN && (
            <span className="block mt-1.5 text-xs text-slate-400 font-mono">
              At least {IDENTITY_MIN_LEN} characters.
            </span>
          )}
          {authMethod === 'google' && identityBaseValid && !looksLikeEmail && (
            <span className="block mt-1.5 text-xs text-red-400 font-mono">
              Google sign-in needs a valid email address (must contain <code>@</code> and a domain).
            </span>
          )}
          {identityValid && (
            <span className="block mt-1.5 text-xs text-slate-400 font-mono">
              Stored as <code className="bg-white/[0.06] px-1 rounded text-slate-200">{previewId}</code>
              {authMethod === 'google'
                ? ' — they sign in via Google OAuth only.'
                : looksLikeEmail
                  ? ' — they can also sign in via Google with this email.'
                  : '.'}
            </span>
          )}
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-slate-400">Display name</span>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={existing?.displayName ?? (identityValid ? trimmedIdentity : 'Jane Doe')}
            className="mt-1 w-full px-3 py-2 rounded bg-[#0e1015] border border-white/10 focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/40 focus:outline-none text-slate-100 text-sm font-mono transition-colors"
          />
          <span className="block mt-1.5 text-xs text-slate-400 font-mono">
            Optional — defaults to the identity above.
          </span>
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-slate-400">Role</span>
          <input
            type="text"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="PhD student (optional)"
            className="mt-1 w-full px-3 py-2 rounded bg-[#0e1015] border border-white/10 focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/40 focus:outline-none text-slate-100 text-sm font-mono transition-colors"
          />
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-slate-400">Affiliation</span>
          <input
            type="text"
            value={affiliation}
            onChange={(e) => setAffiliation(e.target.value)}
            placeholder="Tel Aviv University (optional)"
            className="mt-1 w-full px-3 py-2 rounded bg-[#0e1015] border border-white/10 focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/40 focus:outline-none text-slate-100 text-sm font-mono transition-colors"
          />
        </label>
      </div>

      {identityValid && checking && (
        <p className="text-sm text-slate-400 font-mono">Checking…</p>
      )}
      {identityValid && !checking && existing && (
        <p className="text-sm text-amber-300 leading-relaxed">
          ⚠ <span className="font-mono">{existing.id}</span> is already on file as{' '}
          <span className="font-medium text-amber-200">{existing.displayName}</span>. Inviting will
          update their tier and overwrite any name/role/affiliation you fill in here.
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-slate-400">Tier</span>
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value as AccessTier)}
            className="mt-1 px-3 py-2 rounded bg-[#0e1015] border border-white/10 text-sm text-slate-100"
          >
            <option value="team">Team — annotate full corpus, see own work only</option>
            <option value="researcher">Researcher — full data access, no member mgmt</option>
            <option value="admin">Admin — everything</option>
          </select>
        </label>
        <button
          type="button"
          disabled={!identityValid || busy}
          onClick={() => void submit()}
          className="ml-auto px-4 py-2 rounded border border-violet-700/50 bg-violet-900/30 text-violet-100 hover:bg-violet-900/50 disabled:opacity-30 disabled:cursor-not-allowed text-sm font-medium"
        >
          {busy ? 'Inviting…' : 'Invite'}
        </button>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {okMsg && <p className="text-sm text-emerald-400">{okMsg}</p>}

      {profiles.length > 0 && (
        <details className="pt-1 group">
          <summary className="text-xs uppercase tracking-wider text-slate-400 cursor-pointer hover:text-slate-200 select-none">
            Saved profiles ({profiles.length}){loadingList && <span className="text-slate-500"> · refreshing…</span>}
          </summary>
          <div className="mt-2 space-y-1">
            {profiles.map((p) => (
              <div key={p.id} className="flex items-center gap-2 text-sm py-1.5 border-b border-white/[0.04] last:border-b-0">
                <span className="text-slate-200 truncate flex-1" title={p.id}>
                  <span className="font-medium">{p.displayName}</span>
                  {p.email && <span className="text-slate-400"> · {p.email}</span>}
                </span>
                <span className="text-xs uppercase tracking-wider px-2 py-0.5 rounded bg-white/[0.04] text-slate-300 border border-white/[0.06]">
                  {p.authMethod}
                </span>
                {p.role && <span className="text-xs text-slate-400 truncate max-w-[20ch]">{p.role}</span>}
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return '—';
  const s = Math.round(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmtRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diff = Date.now() - then;
  const days = Math.floor(diff / 86400000);
  if (days < 1) {
    const hours = Math.floor(diff / 3600000);
    if (hours < 1) return 'just now';
    return `${hours}h ago`;
  }
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return new Date(iso).toLocaleDateString();
}
