// The three screens of a full-backup restore inside ImportDatasetDialog:
// what's in the backup → copying → what landed. The logic lives in
// services/backupRestore.ts; this file only shows it.

import { groupFailures, type Backup, type RestoreProgress, type RestoreResult, type SummaryRow } from '../../services/backupRestore';

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function RestoreReviewStage(props: {
  backup: Backup;
  summary: SummaryRow[];
  hasConfig: boolean;
  includeConfig: boolean;
  configLocksOut: boolean;
  onIncludeConfig: (on: boolean) => void;
}) {
  const { backup, summary, hasConfig, includeConfig, configLocksOut, onIncludeConfig } = props;
  const files = backup.entries.length;
  const bytes = backup.entries.reduce((n, e) => n + e.file.size, 0);
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-slate-300 leading-relaxed">
        This folder is a <span className="text-emerald-300">full server backup</span>. Restoring copies every file back to the
        exact place it came from: each annotator's work stays under their own name, and every detector's output comes back
        too, not just the ones the song-by-song import knows about. Each file is checked against the backup after it's written.
      </p>
      <div className="border border-white/[0.06] rounded overflow-hidden">
        <div className="grid grid-cols-[1.4fr_1.6fr_70px_80px] gap-2 px-3 py-2 border-b border-white/[0.06] bg-white/[0.02] text-[10px] uppercase tracking-wider text-slate-500">
          <div>What</div><div>Detail</div><div className="text-right">Files</div><div className="text-right">Size</div>
        </div>
        <div className="max-h-[38vh] overflow-y-auto">
          {summary.map((row) => (
            <div key={`${row.label}|${row.detail}`} className="grid grid-cols-[1.4fr_1.6fr_70px_80px] gap-2 px-3 py-1.5 border-b border-white/[0.04] text-[11px]">
              <div className="text-slate-200 truncate">{row.label}</div>
              <div className="text-slate-400 truncate" title={row.detail}>{row.detail}</div>
              <div className="text-right text-slate-300 tabular-nums">{row.files}</div>
              <div className="text-right text-slate-400 tabular-nums">{formatBytes(row.bytes)}</div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-[1.4fr_1.6fr_70px_80px] gap-2 px-3 py-2 bg-white/[0.02] text-[11px]">
          <div className="text-slate-200">Total</div><div className="text-slate-500 truncate" title={backup.rootLabel}>from {backup.rootLabel}</div>
          <div className="text-right text-slate-100 tabular-nums">{files}</div>
          <div className="text-right text-slate-200 tabular-nums">{formatBytes(bytes)}</div>
        </div>
      </div>

      {hasConfig && (
        <label className={`flex items-start gap-2 rounded border px-3 py-2 text-[11px] leading-relaxed cursor-pointer ${
          configLocksOut ? 'border-amber-400/40 bg-amber-500/[0.06]' : 'border-white/[0.08] bg-white/[0.02]'
        }`}>
          <input
            type="checkbox"
            checked={includeConfig}
            onChange={(e) => onIncludeConfig(e.target.checked)}
            className="accent-emerald-400 mt-0.5"
          />
          <span>
            <span className="text-slate-200">Also restore the people list</span>
            <span className="text-slate-400"> ({'dataset-config.json'}: who is admin, team or researcher).</span>
            {configLocksOut && (
              <span className="block text-amber-200/90 mt-0.5">
                ⚠ You are not an admin in the backup's list, so restoring it would lock you out of this install's admin pages.
                Leave it off, or sign in with Google as an admin from the backup first.
              </span>
            )}
          </span>
        </label>
      )}

      <p className="text-[11px] text-amber-300/80">
        ⚠ A file already on this server at the same path is replaced. Nothing else is deleted.
      </p>
      {backup.ignored.length > 0 && (
        <details className="text-[11px] text-slate-500">
          <summary className="cursor-pointer hover:text-slate-300">
            {backup.ignored.length} file{backup.ignored.length === 1 ? '' : 's'} outside the data folder, left out (click to see)
          </summary>
          <ul className="mt-1.5 pl-4 list-disc space-y-0.5 max-h-32 overflow-auto">
            {backup.ignored.slice(0, 500).map((p) => (<li key={p} className="truncate">{p}</li>))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function RestoringStage({ progress }: { progress: RestoreProgress }) {
  const pct = progress.totalBytes > 0 ? Math.round((progress.bytesDone / progress.totalBytes) * 100) : 0;
  return (
    <div className="space-y-3">
      <div className="text-[12px] text-slate-300 tabular-nums">
        {progress.filesDone} / {progress.totalFiles} files · {formatBytes(progress.bytesDone)} of {formatBytes(progress.totalBytes)}
      </div>
      <div className="relative h-2 rounded-full overflow-hidden bg-white/[0.06] border border-white/10">
        <div
          className="absolute inset-y-0 left-0 bg-emerald-400/70 rounded-full transition-[width] duration-200 ease-out"
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </div>
      <div className="text-[10px] text-slate-500 truncate" title={progress.current}>{progress.current}</div>
      <p className="text-[11px] text-slate-500">Keep this tab open until it finishes.</p>
    </div>
  );
}

export function RestoreDoneStage({ result, saved }: { result: RestoreResult; saved?: boolean }) {
  const failed = result.failures.length;
  const groups = groupFailures(result.failures);
  const when = new Date(result.finishedAt).toLocaleString();
  return (
    <div className="space-y-3">
      {saved && <div className="text-[11px] text-slate-500">Report from the last restore, {when}.</div>}
      <div className={`text-[12px] ${failed === 0 && !result.stoppedEarly ? 'text-emerald-200' : 'text-slate-300'}`}>
        {result.verified} of {result.total} files restored and verified byte-for-byte.
        {failed > 0 && <span className="text-rose-300"> {failed} failed.</span>}
      </div>
      {result.stoppedEarly && (
        <div className="rounded border border-rose-400/40 bg-rose-500/[0.06] px-3 py-2 text-[11px] leading-relaxed">
          <div className="text-rose-200">
            Stopped after the first {failed} files all failed for the same reason, so the rest were not tried and
            the people list was left as it was:
          </div>
          <div className="text-rose-100 font-mono mt-1 break-words">{result.stoppedEarly}</div>
        </div>
      )}
      {groups.map((g) => (
        <details key={g.error} className="border border-rose-400/30 rounded" open={groups.length === 1 && g.paths.length <= 20}>
          <summary className="px-3 py-1.5 cursor-pointer text-[11px] hover:bg-white/[0.03]">
            <span className="text-rose-300 tabular-nums">{g.paths.length} file{g.paths.length === 1 ? '' : 's'}</span>
            <span className="text-slate-300"> — {g.error}</span>
          </summary>
          <ul className="px-3 pb-2 max-h-[30vh] overflow-y-auto text-[10px] text-slate-400 space-y-0.5">
            {g.paths.map((p) => (<li key={p} className="truncate" title={p}>{p}</li>))}
          </ul>
        </details>
      ))}
      <p className="text-[11px] text-slate-500">
        {failed > 0
          ? 'Fix what the error says, then pick the same folder and restore again — files that made it are simply written again. This report stays here until the next restore.'
          : 'Click Done to reload the song list.'}
      </p>
    </div>
  );
}
