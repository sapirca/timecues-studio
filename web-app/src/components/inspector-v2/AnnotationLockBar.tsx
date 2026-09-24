/**
 * The edit lease, on screen.
 *
 * Shown only for collaborative songs, and never behind a "more" toggle: on a
 * shared song this bar is the answer to "why can't I change anything?", so it
 * has to be the first thing in the annotation area, not a control you learn
 * about. It names the holder, says what we actually observed about them, and
 * offers exactly one action for the state you are in.
 *
 * The read-only state is the one that has to be loud. A shared song you don't
 * hold looks identical to one you do until you try to change something, so the
 * bar says so up front — and if edits happen anyway, it escalates to a warning
 * rather than letting them disappear quietly at save time.
 */

import { useState } from 'react';
import {
  describeLock, fetchHistory, fetchSongAnnotators, makeSongShared, makeSongSolo,
  restoreVersion, type HistoryEntry, type LockStance, type LockView,
} from '../../services/annotationLocks';

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

const EVENT_LABEL: Record<string, string> = {
  seed: 'started',
  unlock: 'handed back',
  takeover: 'taken over',
  'stale-claim': 'claimed',
  acquire: 'locked',
  restore: 'restored',
};

export function AnnotationLockBar({
  slug, shared, lock, stance, busy, error, youAre, isAdmin,
  hasUnsavedEdits, onDocumentReplaced,
  onTake, onRelease, onTakeOver,
}: {
  slug: string;
  shared: boolean;
  /** Admins can turn collaboration on and off for a song; everyone else only
   *  ever sees the lease for songs that are already collaborative. */
  isAdmin: boolean;
  lock: LockView | null;
  stance: LockStance;
  busy: boolean;
  error: string | null;
  youAre: string | null;
  /** The document in the editor differs from what is on disk while this
   *  annotator cannot write. Drives the "these aren't being saved" warning. */
  hasUnsavedEdits: boolean;
  /** The document under this song was replaced — collaboration turned on or
   *  off, or a version restored. The page reloads the song rather than the
   *  window: a full reload drops the user back at the workspace picker with
   *  no song selected, which is a worse answer than the one they asked for. */
  onDocumentReplaced: () => void;
  onTake: () => void;
  onRelease: () => void;
  onTakeOver: () => void;
}) {
  // Both of these are scoped to the situation they belong to rather than reset
  // by an effect: a half-finished take-over must not survive the holder
  // handing the song back, and one song's history must never render under
  // another's name.
  const [confirmingFor, setConfirmingFor] = useState<string | null>(null);
  const [historyFor_, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [seedOpen, setSeedOpen] = useState(false);
  const [seedFrom, setSeedFrom] = useState('');
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [working, setWorking] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);

  const situation = `${slug}:${stance}`;
  const confirming = confirmingFor === situation;
  const historyOpen = historyFor_ === slug;

  function toggleHistory() {
    if (historyOpen) { setHistoryFor(null); return; }
    setHistoryFor(slug);
    setHistory(null);
    void fetchHistory(slug).then(setHistory);
  }

  function openSeedPicker() {
    setSeedOpen(true);
    setAdminError(null);
    if (candidates === null) void fetchSongAnnotators(slug).then(setCandidates);
  }

  async function convert(toShared: boolean) {
    setWorking(true);
    setAdminError(null);
    const r = toShared
      ? await makeSongShared(slug, seedFrom || undefined)
      : { ok: await makeSongSolo(slug) };
    setWorking(false);
    // The document under this song changes identity — the team's copy replaces
    // the annotator's, or the other way round — so every view holding the old
    // one has to be re-pointed.
    if (r.ok) { setSeedOpen(false); onDocumentReplaced(); }
    else setAdminError(('error' in r && r.error) || 'could not change this song');
  }

  // A solo song shows nothing at all to a normal annotator: collaboration is
  // opt-in per song, and a corpus of ordinary songs should not grow a bar
  // explaining a mode nobody turned on. Admins get one quiet line, in the
  // exact place the lease bar would appear if they did turn it on.
  if (!shared) {
    if (!isAdmin) return null;
    return (
      <div className="flex items-center gap-2.5 flex-wrap text-[12px] text-slate-400 px-0.5">
        <span>Per-annotator song — everyone keeps their own annotation.</span>
        {!seedOpen ? (
          <button
            onClick={openSeedPicker}
            className="px-3 py-1.5 text-[12px] font-medium rounded-md border border-white/15 bg-white/[0.06] hover:bg-white/[0.12] text-slate-200 transition-colors"
          >Make collaborative…</button>
        ) : (
          <span className="flex items-center gap-1.5 flex-wrap">
            <span className="text-slate-400">Seed the team's annotation from</span>
            <select
              value={seedFrom}
              onChange={(e) => setSeedFrom(e.target.value)}
              className="bg-[#0e1015] border border-white/10 rounded px-1.5 py-0.5 text-[11px] text-slate-200"
            >
              <option value="">an empty annotation</option>
              {(candidates ?? []).map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
            <button
              onClick={() => void convert(true)}
              disabled={working}
              className="px-2 py-0.5 rounded border border-sky-400/50 bg-sky-500/15 hover:bg-sky-500/25 text-sky-100 disabled:opacity-40 transition-colors"
            >{working ? 'Working…' : 'Make collaborative'}</button>
            <button
              onClick={() => setSeedOpen(false)}
              className="px-1.5 py-0.5 rounded hover:text-slate-300 transition-colors"
            >Cancel</button>
            {adminError && <span className="text-red-300">⚠ {adminError}</span>}
          </span>
        )}
      </div>
    );
  }

  const readOnly = stance !== 'yours';
  const tone =
    stance === 'yours'        ? 'border-emerald-400/40 bg-emerald-500/[0.07]' :
    stance === 'theirs'       ? 'border-amber-400/40 bg-amber-500/[0.07]' :
    stance === 'theirs-stale' ? 'border-slate-400/30 bg-white/[0.03]' :
                                'border-sky-400/40 bg-sky-500/[0.06]';

  const dot =
    stance === 'yours'        ? 'bg-emerald-400' :
    stance === 'theirs'       ? 'bg-amber-400' :
    stance === 'theirs-stale' ? 'bg-slate-500' :
                                'bg-sky-400';

  async function doRestore(sha: string) {
    setRestoring(sha);
    const ok = await restoreVersion(slug, sha);
    setRestoring(null);
    if (ok) { setHistoryFor(null); onDocumentReplaced(); }
  }

  return (
    <div className={`rounded-md border px-2.5 py-1.5 ${tone}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
        <span className="text-[10px] uppercase tracking-[0.12em] text-slate-400 shrink-0">
          Shared song
        </span>
        <span className="text-[12px] font-semibold text-slate-100">
          {describeLock(lock, youAre)}
        </span>

        <span className="flex-1" />

        {stance === 'free' && (
          <button
            onClick={onTake}
            disabled={busy}
            title="Take the edit lock. Everyone else stays read-only until you unlock."
            className="px-2.5 py-1 text-[12px] font-semibold rounded border border-sky-400/70 bg-sky-500/30 hover:bg-sky-500/45 text-white disabled:opacity-40 transition-colors"
          >🔓 Lock to edit</button>
        )}

        {stance === 'yours' && (
          <button
            onClick={onRelease}
            disabled={busy}
            title="Hand the song back. You become read-only and anyone else can take it."
            className="px-2.5 py-1 text-[12px] font-semibold rounded border border-emerald-400/70 bg-emerald-500/25 hover:bg-emerald-500/40 text-white disabled:opacity-40 transition-colors"
          >🔒 Unlock</button>
        )}

        {readOnly && stance !== 'free' && (
          confirming ? (
            <span className="flex items-center gap-1.5">
              <span className="text-[12px] text-amber-200">
                {stance === 'theirs'
                  ? `${lock?.holderName ?? 'They'} may be typing right now — take it anyway?`
                  : 'Take it?'}
              </span>
              <button
                onClick={() => { setConfirmingFor(null); onTakeOver(); }}
                disabled={busy}
                className="px-2.5 py-1 text-[12px] font-semibold rounded border border-amber-400/70 bg-amber-500/35 hover:bg-amber-500/50 text-white disabled:opacity-40 transition-colors"
              >Take over</button>
              <button
                onClick={() => setConfirmingFor(null)}
                className="px-2 py-1 text-[12px] rounded text-slate-400 hover:text-slate-200 transition-colors"
              >Cancel</button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmingFor(situation)}
              disabled={busy}
              title="Take the lock from the current holder. Their work so far is saved as a version first."
              className="px-2.5 py-1 text-[12px] font-semibold rounded border border-amber-400/60 bg-amber-500/20 hover:bg-amber-500/35 text-white disabled:opacity-40 transition-colors"
            >Take over</button>
          )
        )}

        <button
          onClick={toggleHistory}
          title="Every hand-off of this song, oldest to newest"
          className="px-2 py-1 text-[11px] rounded text-slate-400 hover:text-slate-200 hover:bg-white/[0.05] transition-colors"
        >{historyOpen ? 'Hide history' : 'History'}</button>

        {isAdmin && (
          <button
            onClick={() => void convert(false)}
            disabled={working}
            title="Return this song to per-annotator editing. The shared annotation and its versions are archived, not deleted."
            className="px-2 py-1 text-[11px] rounded text-slate-500 hover:text-slate-300 hover:bg-white/[0.05] disabled:opacity-40 transition-colors"
          >{working ? '…' : 'Stop collaborating'}</button>
        )}
      </div>

      {readOnly && (
        <p className={`mt-1.5 text-[12px] ${hasUnsavedEdits ? 'text-red-300 font-semibold' : 'text-slate-300'}`}>
          {hasUnsavedEdits
            ? '⚠ You don’t hold the lock, so nothing you change here is being saved. Take over to keep working — your edits stay on screen until you reload.'
            : 'Read-only. You can play, inspect and export; take the lock to change anything.'}
        </p>
      )}

      {(error || adminError) && (
        <p className="mt-1.5 text-[11px] text-red-300">⚠ {error ?? adminError}</p>
      )}

      {historyOpen && (
        <div className="mt-2 border-t border-white/[0.06] pt-2">
          {history === null && <p className="text-[11px] text-slate-500">Loading…</p>}
          {history?.length === 0 && (
            <p className="text-[11px] text-slate-500">
              No versions yet — the first hand-off after an edit records one.
            </p>
          )}
          {history && history.length > 0 && (
            <ul className="space-y-0.5 max-h-40 overflow-y-auto">
              {history.map((h) => (
                <li key={h.sha} className="flex items-center gap-2 text-[11px] text-slate-300">
                  <span className="font-mono text-slate-600 shrink-0">{h.sha.slice(0, 7)}</span>
                  <span className="text-slate-500 shrink-0">{fmtWhen(h.date)}</span>
                  <span className="truncate">
                    {h.author} · {EVENT_LABEL[h.event] ?? h.event}
                    {h.rev != null && <span className="text-slate-600"> · rev {h.rev}</span>}
                  </span>
                  <span className="flex-1" />
                  {!readOnly && (
                    <button
                      onClick={() => void doRestore(h.sha)}
                      disabled={restoring !== null}
                      title="Bring this version back. It is written forward as a NEW version, so nothing is overwritten."
                      className="px-1.5 py-0.5 rounded text-slate-400 hover:text-slate-100 hover:bg-white/[0.06] disabled:opacity-40 transition-colors shrink-0"
                    >{restoring === h.sha ? '…' : 'Restore'}</button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {readOnly && history && history.length > 0 && (
            <p className="mt-1 text-[11px] text-slate-500">Take the lock to restore a version.</p>
          )}
        </div>
      )}
    </div>
  );
}
