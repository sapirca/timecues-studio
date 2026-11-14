/**
 * After collaboration stops on a song, say which annotation you're on.
 *
 * Nobody is asked up front: the server gives each annotator the newer of the
 * team's last version and their own file from before the song was shared, the
 * first time they open it. This bar names which one they got and offers the
 * other. The switch keeps whatever it replaces, so it can be undone by
 * switching again — no confirmation needed.
 */

import { useEffect, useState } from 'react';
import { fetchAfterShared, postAfterShared, type AfterShared } from '../../services/annotationLocks';

function fmtDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function describe(a: AfterShared): string {
  const until = `This song was collaborative until ${fmtDay(a.archivedAt)}.`;
  if (a.kept === 'team') {
    if (!a.automatic) return `${until} You switched to the team's version.`;
    return a.hadOwn
      ? `${until} You're on the team's version — it's newer than your own.`
      : `${until} You're on the team's version.`;
  }
  if (!a.automatic) return a.hadOwn
    ? `${until} You switched back to your own annotation.`
    : `${until} You switched to an empty annotation of your own.`;
  return `${until} You're on your own annotation — it's newer than the team's.`;
}

export function AfterSharedBar({ slug, onDocumentReplaced }: {
  slug: string;
  /** This annotator's document for the song was swapped; reload the song. */
  onDocumentReplaced: () => void;
}) {
  // Keyed by slug so one song's answer never renders under another's name.
  const [state, setState] = useState<{ slug: string; after: AfterShared | null } | null>(null);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchAfterShared(slug).then((after) => { if (live) setState({ slug, after }); });
    return () => { live = false; };
  }, [slug]);

  const after = state?.slug === slug ? state.after : null;
  if (!after || after.dismissed) return null;

  async function act(action: 'switch' | 'dismiss') {
    setWorking(true);
    setFailed(false);
    const next = await postAfterShared(slug, action);
    setWorking(false);
    if (!next) { setFailed(true); return; }
    setState({ slug, after: next });
    if (action === 'switch') onDocumentReplaced();
  }

  const other = after.kept === 'team'
    ? (after.hadOwn ? 'Use my own instead' : 'Start empty instead')
    : "Use the team's instead";
  const otherTitle = after.kept === 'team'
    ? (after.hadOwn
        ? 'Go back to the annotation you had before the song was shared. The team’s version, with any changes you made to it, is kept — you can switch back.'
        : 'Start this song from an empty annotation. The team’s version, with any changes you made to it, is kept — you can switch back.')
    : 'Take the team’s last version instead. Your own annotation is kept — you can switch back.';

  return (
    <div className="rounded-md border border-sky-400/40 bg-sky-500/[0.06] px-2.5 py-1.5 flex items-center gap-x-3 gap-y-1.5 flex-wrap">
      <span className="flex-1 min-w-[16rem] text-[12px] text-slate-200">{describe(after)}</span>
      <span className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => void act('switch')}
          disabled={working}
          title={otherTitle}
          className="min-h-[32px] px-3 text-[12px] font-semibold rounded border border-sky-400/70 bg-sky-500/25 hover:bg-sky-500/40 text-white disabled:opacity-40 transition-colors"
        >{working ? 'Working…' : other}</button>
        <button
          onClick={() => void act('dismiss')}
          disabled={working}
          title="Hide this notice. You can't switch back afterwards from here."
          className="min-h-[32px] px-3 text-[12px] rounded border border-white/15 hover:bg-white/[0.08] text-slate-300 disabled:opacity-40 transition-colors"
        >Keep this</button>
      </span>
      {failed && <span className="basis-full text-[11px] text-red-300">⚠ Could not change this song — try again.</span>}
    </div>
  );
}
