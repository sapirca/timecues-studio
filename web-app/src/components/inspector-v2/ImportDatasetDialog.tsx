import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  scanDatasetFiles,
  checkServerStatus,
  runImport,
  type ScannedSong,
  type ScanResult,
  type ServerStatus,
  type SongImportResult,
  type StepKey,
  type ImportProgress,
} from '../../services/datasetImport';
import {
  detectBackup,
  summarizeBackup,
  configLocksOut as backupConfigLocksOut,
  restoreBackup,
  saveRestoreReport,
  loadRestoreReport,
  type Backup,
  type RestoreProgress,
  type RestoreResult,
} from '../../services/backupRestore';
import { getCurrentAnnotatorId } from '../../context/AnnotatorContext';
import { fetchAdminStatus } from '../../services/admin';
import { RestoreReviewStage, RestoringStage, RestoreDoneStage } from './RestoreBackupStages';

export interface ImportDatasetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the user clicks Done so the parent can refresh its
   *  manifest + per-song status maps. */
  onImported?: () => void;
}

type Phase = 'pick' | 'scanning' | 'review' | 'importing' | 'done'
  // A full server backup (a data/ tree) gets its own path: copied verbatim.
  | 'restore-review' | 'restoring' | 'restore-done';

const STEP_LABEL: Record<StepKey, string> = {
  audio:    'Audio',
  songInfo: 'Song info',
  autoGuess: 'Auto-guess',
  layers:   'Layers',
  algos:    'Algos',
  stems:    'Stems',
};

// One field per step + a master toggle keyed by slug. The master toggle
// drops the song from the import plan entirely; individual step toggles
// let the user keep audio but skip a particular annotation.
type SongSelection = Record<StepKey, boolean> & { include: boolean };

function defaultSelection(song: ScannedSong): SongSelection {
  // "If something missing or defected just upload the song." Default to ON
  // whenever the file exists in the source — server-overwrite is surfaced as
  // an amber chip in the row, not auto-suppressed.
  return {
    include: true,
    audio:     !!song.audio,
    songInfo:  !!song.songInfo,
    autoGuess: !!song.annotations['auto-guess'],
    layers:    !!song.annotations.layers || song.layerFiles.length > 0,
    algos:     song.algoFiles.length > 0,
    stems:     Object.keys(song.stems).length > 0,
  };
}

export function ImportDatasetDialog({ open, onOpenChange, onImported }: ImportDatasetDialogProps) {
  const [phase, setPhase] = useState<Phase>('pick');
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [serverStatus, setServerStatus] = useState<Record<string, ServerStatus>>({});
  const [selections, setSelections] = useState<Record<string, SongSelection>>({});
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [results, setResults] = useState<SongImportResult[] | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef   = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  const [backup, setBackup] = useState<Backup | null>(null);
  const [includeConfig, setIncludeConfig] = useState(true);
  const [configLocksOut, setConfigLocksOut] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState<RestoreProgress | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  // Showing a saved report from an earlier run (opened from the pick screen),
  // rather than the result of one that just finished.
  const [reportIsSaved, setReportIsSaved] = useState(false);
  const [savedReport, setSavedReport] = useState<RestoreResult | null>(loadRestoreReport);
  const [restoreBlocked, setRestoreBlocked] = useState<string | null>(null);
  const backupSummary = useMemo(() => (backup ? summarizeBackup(backup.entries) : []), [backup]);
  const backupHasConfig = !!backup?.entries.some((e) => e.rel === 'dataset-config.json');

  // Reset when the dialog is closed so reopening always starts fresh.
  useEffect(() => {
    if (!open) {
      setPhase('pick');
      setScan(null);
      setServerStatus({});
      setSelections({});
      setProgress(null);
      setResults(null);
      setDragActive(false);
      dragDepthRef.current = 0;
      setPickedFiles([]);
      setBackup(null);
      setRestoreProgress(null);
      setRestoreResult(null);
      setReportIsSaved(false);
      setRestoreBlocked(null);
    }
  }, [open]);

  // A reload mid-restore abandons it and, before the report was saved, lost
  // every error with it. Ask first.
  useEffect(() => {
    if (phase !== 'restoring') return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  const scanSongBySong = useCallback(async (files: File[]) => {
    setPhase('scanning');
    const result = scanDatasetFiles(files);
    setScan(result);
    if (result.songs.length === 0) {
      setPhase('review'); // empty review screen so the user sees "nothing detected"
      return;
    }
    // Probe the server in parallel so the per-row overwrite warnings can
    // surface before the user confirms.
    const status = await checkServerStatus(result.songs.map((s) => s.slug));
    setServerStatus(status);
    const nextSelections: Record<string, SongSelection> = {};
    for (const song of result.songs) nextSelections[song.slug] = defaultSelection(song);
    setSelections(nextSelections);
    setPhase('review');
  }, []);

  const onFilesPicked = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setPickedFiles(files);
    const found = detectBackup(files);
    if (!found) { void scanSongBySong(files); return; }
    const locksOut = await backupConfigLocksOut(found.entries, getCurrentAnnotatorId());
    setBackup(found);
    setConfigLocksOut(locksOut);
    setIncludeConfig(!locksOut);
    setPhase('restore-review');
  }, [scanSongBySong]);

  const beginRestore = useCallback(async () => {
    if (!backup) return;
    // The endpoint is admin-only. Checking first turns "6225 files failed"
    // into one sentence saying who you're signed in as.
    setRestoreBlocked(null);
    try {
      const status = await fetchAdminStatus();
      if (!status.isAdmin) {
        const who = getCurrentAnnotatorId();
        setRestoreBlocked(`You're signed in as ${who ?? 'nobody'}, which isn't an admin on this install, so the server would refuse every file. Sign in with Google as an admin, then restore again.`);
        return;
      }
    } catch {
      setRestoreBlocked("The server didn't answer. Check that TimeCues is running, then try again.");
      return;
    }
    const entries = includeConfig ? backup.entries : backup.entries.filter((e) => e.rel !== 'dataset-config.json');
    setPhase('restoring');
    const out = await restoreBackup(entries, setRestoreProgress);
    saveRestoreReport(out);
    setSavedReport(out);
    setRestoreResult(out);
    setReportIsSaved(false);
    setPhase('restore-done');
  }, [backup, includeConfig]);

  const collectDataTransfer = useCallback(async (items: DataTransferItemList | null): Promise<File[]> => {
    if (!items) return [];
    const files: File[] = [];
    // Use the legacy webkitGetAsEntry API to walk dropped folders. It's still
    // the only cross-browser way to enumerate folder contents from a drop.
    type FileSystemEntry = {
      isFile: boolean;
      isDirectory: boolean;
      fullPath: string;
      file?: (cb: (f: File) => void, err?: (e: unknown) => void) => void;
      createReader?: () => { readEntries: (cb: (entries: FileSystemEntry[]) => void, err?: (e: unknown) => void) => void };
    };
    async function walk(entry: FileSystemEntry, relPath: string): Promise<void> {
      if (entry.isFile && entry.file) {
        await new Promise<void>((resolve) => {
          entry.file!((file) => {
            try {
              Object.defineProperty(file, 'webkitRelativePath', { value: relPath, configurable: true });
            } catch { /* some browsers seal File; the scanner falls back to file.name */ }
            files.push(file);
            resolve();
          }, () => resolve());
        });
      } else if (entry.isDirectory && entry.createReader) {
        const reader = entry.createReader();
        // readEntries chunks at 100 entries — keep calling until it returns [].
        while (true) {
          const batch = await new Promise<FileSystemEntry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
          if (batch.length === 0) break;
          await Promise.all(batch.map((child) => walk(child, `${relPath}/${child.fullPath.split('/').pop()}`)));
        }
      }
    }
    const entries: FileSystemEntry[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const entry = (items[i] as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
    for (const entry of entries) {
      const rootName = entry.fullPath.replace(/^\//, '').split('/').pop() ?? '';
      await walk(entry, rootName);
    }
    return files;
  }, []);

  const beginImport = useCallback(async () => {
    if (!scan) return;
    const plan = scan.songs
      .filter((song) => selections[song.slug]?.include)
      .map((song) => {
        const sel = selections[song.slug];
        return {
          song,
          include: {
            audio:    sel.audio,
            songInfo: sel.songInfo,
            autoGuess: sel.autoGuess,
            layers:   sel.layers,
            algos:    sel.algos,
            stems:    sel.stems,
          },
        };
      });
    if (plan.length === 0) return;
    setPhase('importing');
    setProgress({ stage: 'song', songIndex: 0, totalSongs: plan.length });
    const out = await runImport(plan, setProgress);
    setResults(out);
    setPhase('done');
  }, [scan, selections]);

  const closeAndNotify = useCallback(() => {
    if ((results && results.length > 0) || (restoreResult && restoreResult.restored > 0)) onImported?.();
    onOpenChange(false);
  }, [results, restoreResult, onImported, onOpenChange]);

  // ── Header ────────────────────────────────────────────────────────────────
  const title = useMemo(() => {
    switch (phase) {
      case 'pick':       return 'Import dataset';
      case 'scanning':   return 'Scanning…';
      case 'review':     return 'Review what was found';
      case 'importing':  return 'Importing…';
      case 'done':       return 'Import complete';
      case 'restore-review': return 'Restore full backup';
      case 'restoring':      return 'Restoring backup…';
      case 'restore-done':   return 'Restore complete';
    }
  }, [phase]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[101] w-[min(880px,96vw)] max-h-[90vh] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-emerald-500/40 bg-[#14171d] shadow-2xl shadow-black/70 outline-none flex flex-col"
          aria-describedby={undefined}
        >
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
            <Dialog.Title className="text-[12px] font-semibold tracking-[0.18em] uppercase text-emerald-300">
              {title}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="text-slate-500 hover:text-slate-200 text-lg leading-none w-6 h-6 flex items-center justify-center rounded hover:bg-white/[0.06]"
                aria-label="Close"
              >
                ×
              </button>
            </Dialog.Close>
          </div>

          <div className="px-5 py-4 overflow-y-auto flex-1 min-h-0">
            {phase === 'pick' && (
              <PickStage
                folderInputRef={folderInputRef}
                fileInputRef={fileInputRef}
                dragActive={dragActive}
                onDragEnter={(e) => {
                  if (!e.dataTransfer?.types?.includes('Files')) return;
                  dragDepthRef.current += 1;
                  if (!dragActive) setDragActive(true);
                }}
                onDragLeave={() => {
                  dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
                  if (dragDepthRef.current === 0) setDragActive(false);
                }}
                onDragOver={(e) => {
                  if (!e.dataTransfer?.types?.includes('Files')) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'copy';
                }}
                onDrop={async (e) => {
                  if (!e.dataTransfer?.types?.includes('Files')) return;
                  e.preventDefault();
                  setDragActive(false);
                  dragDepthRef.current = 0;
                  const files = await collectDataTransfer(e.dataTransfer.items);
                  if (files.length > 0) void onFilesPicked(files);
                }}
                onFiles={(files) => void onFilesPicked(files)}
                lastReport={savedReport}
                onShowLastReport={() => {
                  if (!savedReport) return;
                  setRestoreResult(savedReport);
                  setReportIsSaved(true);
                  setPhase('restore-done');
                }}
              />
            )}

            {phase === 'scanning' && (
              <div className="text-[12px] text-slate-400">Walking the file tree…</div>
            )}

            {phase === 'review' && scan && (
              <ReviewStage
                scan={scan}
                serverStatus={serverStatus}
                selections={selections}
                onToggleSong={(slug, on) => {
                  setSelections((prev) => ({ ...prev, [slug]: { ...prev[slug], include: on } }));
                }}
                onToggleStep={(slug, step, on) => {
                  setSelections((prev) => ({ ...prev, [slug]: { ...prev[slug], [step]: on } }));
                }}
                onBulkInclude={(on) => {
                  setSelections((prev) => {
                    const next: typeof prev = {};
                    for (const [slug, sel] of Object.entries(prev)) next[slug] = { ...sel, include: on };
                    return next;
                  });
                }}
                onBulkStep={(step, on) => {
                  setSelections((prev) => {
                    const next: typeof prev = {};
                    for (const song of scan.songs) {
                      const sel = prev[song.slug];
                      if (!sel) continue;
                      // Only flip step state where the local file actually
                      // exists — a step is meaningless without a source file
                      // (the row already renders `—` or `server`, not a chip).
                      if (!stepHasLocal(song, step)) { next[song.slug] = sel; continue; }
                      next[song.slug] = { ...sel, [step]: on };
                    }
                    return next;
                  });
                }}
              />
            )}

            {phase === 'importing' && progress && scan && (
              <ImportingStage progress={progress} scan={scan} />
            )}

            {phase === 'done' && results && (
              <DoneStage results={results} scan={scan} />
            )}

            {phase === 'restore-review' && backup && (
              <RestoreReviewStage
                backup={backup}
                summary={backupSummary}
                hasConfig={backupHasConfig}
                includeConfig={includeConfig}
                configLocksOut={configLocksOut}
                onIncludeConfig={setIncludeConfig}
              />
            )}
            {phase === 'restore-review' && restoreBlocked && (
              <div className="mt-3 rounded border border-rose-400/40 bg-rose-500/[0.06] px-3 py-2 text-[11px] text-rose-200 leading-relaxed">
                {restoreBlocked}
              </div>
            )}

            {phase === 'restoring' && restoreProgress && (
              <RestoringStage progress={restoreProgress} />
            )}

            {phase === 'restore-done' && restoreResult && (
              <RestoreDoneStage result={restoreResult} saved={reportIsSaved} />
            )}
          </div>

          <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-white/[0.06]">
            <div className="text-[11px] text-slate-500">
              {phase === 'review' && scan && (
                <>
                  {scan.songs.length} song{scan.songs.length === 1 ? '' : 's'} detected
                  {scan.unrecognized.length > 0 ? ` · ${scan.unrecognized.length} file${scan.unrecognized.length === 1 ? '' : 's'} ignored` : ''}
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              {phase === 'pick' && (
                <Dialog.Close asChild>
                  <button className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-white/[0.04] hover:bg-white/[0.08] text-slate-300">
                    Cancel
                  </button>
                </Dialog.Close>
              )}
              {phase === 'review' && (
                <>
                  <button
                    onClick={() => setPhase('pick')}
                    className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-white/[0.04] hover:bg-white/[0.08] text-slate-300"
                  >
                    Back
                  </button>
                  <button
                    onClick={beginImport}
                    disabled={!Object.values(selections).some((s) => s.include)}
                    className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-emerald-500/25 hover:bg-emerald-500/35 text-emerald-100 border border-emerald-400/50 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    OK · Import
                  </button>
                </>
              )}
              {phase === 'importing' && (
                <span className="text-[11px] text-slate-400">In progress…</span>
              )}
              {phase === 'restore-review' && (
                <>
                  <button
                    onClick={() => setPhase('pick')}
                    className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-white/[0.04] hover:bg-white/[0.08] text-slate-300"
                  >
                    Back
                  </button>
                  <button
                    onClick={() => void scanSongBySong(pickedFiles)}
                    title="Pick songs and parts one by one instead. Only the parts the song importer knows are copied, and every annotation is saved under your name."
                    className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-white/[0.04] hover:bg-white/[0.08] text-slate-300"
                  >
                    Import song by song instead
                  </button>
                  <button
                    onClick={() => void beginRestore()}
                    className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-emerald-500/25 hover:bg-emerald-500/35 text-emerald-100 border border-emerald-400/50"
                  >
                    Restore everything
                  </button>
                </>
              )}
              {phase === 'restoring' && (
                <span className="text-[11px] text-slate-400">In progress…</span>
              )}
              {(phase === 'done' || phase === 'restore-done') && (
                <button
                  onClick={closeAndNotify}
                  className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-emerald-500/25 hover:bg-emerald-500/35 text-emerald-100 border border-emerald-400/50"
                >
                  Done
                </button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── Pick stage ──────────────────────────────────────────────────────────────

function PickStage(props: {
  folderInputRef: React.RefObject<HTMLInputElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  dragActive: boolean;
  onDragEnter: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onFiles: (files: File[]) => void;
  lastReport: RestoreResult | null;
  onShowLastReport: () => void;
}) {
  const { folderInputRef, fileInputRef, dragActive, onDragEnter, onDragLeave, onDragOver, onDrop, onFiles, lastReport, onShowLastReport } = props;
  const lastFailed = lastReport ? lastReport.failures.length : 0;
  return (
    <div className="space-y-4">
      {lastReport && (
        <div className={`flex items-center justify-between gap-3 rounded border px-3 py-2 text-[11px] ${
          lastFailed > 0 || lastReport.stoppedEarly ? 'border-rose-400/40 bg-rose-500/[0.06]' : 'border-emerald-400/30 bg-emerald-500/[0.05]'
        }`}>
          <span className="text-slate-300">
            Last restore, {new Date(lastReport.finishedAt).toLocaleString()}: {lastReport.verified} of {lastReport.total} files verified
            {lastFailed > 0 && <span className="text-rose-300"> · {lastFailed} failed</span>}
          </span>
          <button
            type="button"
            onClick={onShowLastReport}
            className="shrink-0 px-2 py-1 rounded uppercase tracking-wider bg-white/[0.04] hover:bg-white/[0.08] text-slate-200"
          >
            Show report
          </button>
        </div>
      )}
      <p className="text-[12px] text-slate-300 leading-relaxed">
        Pick a dataset folder to import. The scanner accepts three layouts:
      </p>
      <p className="text-[11px] text-slate-400 leading-relaxed">
        <span className="text-emerald-300">Restoring a full backup?</span> Unpack the backup's <code className="text-slate-300">.tar</code> and
        pick the folder: when it has the server's <code className="text-slate-300">songs/</code> and <code className="text-slate-300">annotations/</code>,
        you'll be offered an exact restore of everything in it.
      </p>
      <ul className="text-[11px] text-slate-400 leading-relaxed space-y-1 pl-4 list-disc">
        <li>
          <span className="text-emerald-300">Server-mirror</span> — a folder shaped like the server's <code className="text-emerald-200/80">data/</code> tree
          ({' '}
          <code className="text-slate-300">songs/&lt;slug&gt;/&lt;slug&gt;.mp3</code>,{' '}
          <code className="text-slate-300">song-info/&lt;slug&gt;.json</code>,{' '}
          <code className="text-slate-300">annotations/&#123;layers,auto-guess&#125;/&lt;annotator&gt;/&lt;slug&gt;.json</code>,{' '}
          <code className="text-slate-300">stems/&lt;slug&gt;/&#123;drums,bass,other,vocals,guitar,piano&#125;.wav</code>).
        </li>
        <li>
          <span className="text-emerald-300">Export bundle</span> — a ZIP from this app's <span className="text-slate-300">Export</span> button, unzipped: one folder per song with
          {' '}<code className="text-slate-300">&lt;slug&gt;/&#123;boundaries,cues,spans&#125;/&lt;layer&gt;.json</code>,{' '}
          <code className="text-slate-300">&lt;slug&gt;/&#123;cues,spans,loops&#125;/&lt;layer&gt;.json</code>,{' '}
          <code className="text-slate-300">&lt;slug&gt;/song-info.json</code>, <code className="text-slate-300">&lt;slug&gt;/audio.&lt;ext&gt;</code>, and cached algorithm outputs under <code className="text-slate-300">&lt;slug&gt;/algos/</code>.
          {' '}(Only JSON round-trips — Audacity / CSV / JAMS / MIDI exports are skipped.)
        </li>
        <li>
          <span className="text-emerald-300">Flat bundle</span> — audio files with sibling sidecars: <code className="text-slate-300">track.mp3</code> + <code className="text-slate-300">track.info.json</code> + <code className="text-slate-300">track.layers.json</code>, etc.
          Stems live under <code className="text-slate-300">track.stems/</code>.
        </li>
      </ul>
      <div
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        className={`rounded-lg border border-dashed transition-colors px-6 py-10 text-center ${
          dragActive ? 'border-emerald-400/70 bg-emerald-500/[0.06]' : 'border-white/15 bg-white/[0.02]'
        }`}
      >
        <div className="text-[13px] text-slate-300 mb-3">Drop a folder here…</div>
        <div className="text-[11px] text-slate-500 mb-4">or</div>
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => props.folderInputRef.current?.click()}
            className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-100 border border-emerald-400/40"
          >
            Pick folder
          </button>
          <button
            onClick={() => props.fileInputRef.current?.click()}
            className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-white/[0.04] hover:bg-white/[0.08] text-slate-300"
          >
            Pick files
          </button>
        </div>
      </div>
      <input
        ref={folderInputRef}
        type="file"
        // @ts-expect-error — webkitdirectory is not in the React types
        webkitdirectory=""
        directory=""
        multiple
        className="hidden"
        onChange={(e) => {
          const files = e.target.files ? Array.from(e.target.files) : [];
          e.target.value = '';
          if (files.length > 0) onFiles(files);
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = e.target.files ? Array.from(e.target.files) : [];
          e.target.value = '';
          if (files.length > 0) onFiles(files);
        }}
      />
    </div>
  );
}

// ── Review stage ────────────────────────────────────────────────────────────

const STEP_KEYS_IN_ORDER: StepKey[] = ['audio', 'songInfo', 'autoGuess', 'layers', 'algos', 'stems'];

function ReviewStage(props: {
  scan: ScanResult;
  serverStatus: Record<string, ServerStatus>;
  selections: Record<string, SongSelection>;
  onToggleSong: (slug: string, on: boolean) => void;
  onToggleStep: (slug: string, step: StepKey, on: boolean) => void;
  onBulkInclude: (on: boolean) => void;
  onBulkStep: (step: StepKey, on: boolean) => void;
}) {
  const { scan, serverStatus, selections, onToggleSong, onToggleStep, onBulkInclude, onBulkStep } = props;
  if (scan.songs.length === 0) {
    return (
      <div className="text-[12px] text-slate-400 space-y-2">
        <p>No audio or annotation files were detected.</p>
        <p className="text-slate-500">
          Try picking a folder one level higher — the scanner looks for either a server-mirror layout (with a{' '}
          <code className="text-slate-300">songs/</code>{' '}subdir) or audio files with sibling <code className="text-slate-300">*.info.json</code> /{' '}
          <code className="text-slate-300">*.layers.json</code> sidecars.
        </p>
      </div>
    );
  }
  // Aggregate state for the master row checkbox: indeterminate when some-but-
  // not-all songs are included, so the user can see at a glance what a click
  // is about to do.
  const includedCount = scan.songs.reduce((acc, s) => acc + (selections[s.slug]?.include ? 1 : 0), 0);
  const allIncluded  = includedCount === scan.songs.length;
  const noneIncluded = includedCount === 0;
  // Per-column aggregate: is every eligible cell (song where the file exists
  // locally) currently on? Used to flip the column the right direction.
  const columnAllOn: Record<StepKey, boolean> = STEP_KEYS_IN_ORDER.reduce((acc, step) => {
    const eligible = scan.songs.filter((s) => stepHasLocal(s, step));
    acc[step] = eligible.length > 0 && eligible.every((s) => selections[s.slug]?.[step]);
    return acc;
  }, {} as Record<StepKey, boolean>);
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-slate-400">
        Uncheck any song you don't want to import. Click a piece to toggle just that step (e.g. keep the audio but skip the layers file).
        <span className="text-amber-300/80"> Orange chips overwrite an existing file on the server.</span>
        <span className="text-slate-500"> Click the header checkbox to select / deselect all songs, or a column header to bulk-toggle that step.</span>
      </p>
      <div className="border border-white/[0.06] rounded overflow-hidden">
        <div className="grid grid-cols-[24px_1.6fr_repeat(8,minmax(0,1fr))] gap-2 px-3 py-2 border-b border-white/[0.06] bg-white/[0.02] text-[10px] uppercase tracking-wider text-slate-500">
          <input
            type="checkbox"
            // Tri-state: indeterminate when some-but-not-all songs are
            // selected. The ref callback is the only way to set
            // `indeterminate` since React doesn't accept it as a prop.
            ref={(el) => { if (el) el.indeterminate = !allIncluded && !noneIncluded; }}
            checked={allIncluded}
            onChange={(e) => onBulkInclude(e.target.checked)}
            aria-label={allIncluded ? 'Deselect all songs' : 'Select all songs'}
            title={allIncluded ? 'Deselect all songs' : 'Select all songs'}
            className="accent-emerald-400 cursor-pointer"
          />
          <div>Song</div>
          {STEP_KEYS_IN_ORDER.map((step) => {
            const anyEligible = scan.songs.some((s) => stepHasLocal(s, step));
            return (
              <button
                key={step}
                type="button"
                onClick={() => onBulkStep(step, !columnAllOn[step])}
                disabled={!anyEligible}
                title={!anyEligible ? 'No source files for this step' : columnAllOn[step] ? `Deselect all ${STEP_LABEL[step]}` : `Select all ${STEP_LABEL[step]}`}
                className={`text-center uppercase tracking-wider transition-colors ${
                  !anyEligible
                    ? 'text-slate-700 cursor-not-allowed'
                    : columnAllOn[step]
                      ? 'text-emerald-300 hover:text-emerald-200'
                      : 'text-slate-500 hover:text-slate-200'
                }`}
              >
                {STEP_LABEL[step]}
              </button>
            );
          })}
        </div>
        {scan.songs.map((song) => {
          const sel = selections[song.slug];
          const status = serverStatus[song.slug];
          return (
            <div
              key={song.slug}
              className={`grid grid-cols-[24px_1.6fr_repeat(8,minmax(0,1fr))] gap-2 px-3 py-2 border-b border-white/[0.04] items-center ${sel?.include ? '' : 'opacity-40'}`}
            >
              <input
                type="checkbox"
                checked={!!sel?.include}
                onChange={(e) => onToggleSong(song.slug, e.target.checked)}
                aria-label={`Include ${song.slug}`}
                className="accent-emerald-400"
              />
              <div className="min-w-0">
                <div className="text-[12px] text-slate-200 truncate">{song.displayName || song.slug}</div>
                <div className="text-[10px] text-slate-500 truncate">
                  {song.slug}
                  {status?.songExists && <span className="text-emerald-300/70"> · already on server</span>}
                </div>
                {song.warnings.length > 0 && (
                  <div className="text-[10px] text-amber-300/80 truncate" title={song.warnings.join('\n')}>
                    ⚠ {song.warnings[0]}
                  </div>
                )}
              </div>
              {STEP_KEYS_IN_ORDER.map((step) => {
                const localPresent = stepHasLocal(song, step);
                const serverPresent = stepHasServer(status, step);
                const stepOn = !!sel?.[step];
                if (!localPresent && !serverPresent) {
                  return <div key={step} className="flex justify-center text-slate-700">—</div>;
                }
                if (!localPresent && serverPresent) {
                  return (
                    <div key={step} className="flex justify-center" title="Present on server, not in source — left untouched.">
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-500/10 text-slate-400 border border-slate-500/20">
                        server
                      </span>
                    </div>
                  );
                }
                // localPresent
                const willOverwrite = serverPresent;
                const items = stepItems(song, step);
                const baseTitle = willOverwrite ? 'Overwrites the file on the server' : 'Will upload this file';
                const title = items.length ? `${baseTitle}\n• ${items.join('\n• ')}` : baseTitle;
                return (
                  <div key={step} className="flex flex-col items-center gap-0.5 min-w-0">
                    <button
                      onClick={() => onToggleStep(song.slug, step, !stepOn)}
                      disabled={!sel?.include}
                      title={title}
                      className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border transition-colors ${
                        !stepOn
                          ? 'bg-white/[0.03] text-slate-500 border-white/[0.06] line-through'
                          : willOverwrite
                            ? 'bg-amber-500/15 text-amber-200 border-amber-400/40 hover:bg-amber-500/25'
                            : 'bg-emerald-500/15 text-emerald-200 border-emerald-400/40 hover:bg-emerald-500/25'
                      }`}
                    >
                      {willOverwrite ? 'overwrite' : 'upload'}{items.length > 1 ? ` ·${items.length}` : ''}
                    </button>
                    {items.length > 0 && (
                      <span
                        className={`text-[9px] leading-tight max-w-full truncate ${stepOn ? 'text-slate-400' : 'text-slate-600 line-through'}`}
                        title={items.join(', ')}
                      >
                        {items.join(' ')}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {scan.unrecognized.length > 0 && (
        <details className="text-[11px] text-slate-500">
          <summary className="cursor-pointer hover:text-slate-300">
            {scan.unrecognized.length} file{scan.unrecognized.length === 1 ? '' : 's'} ignored (click to see paths)
          </summary>
          <ul className="mt-1.5 pl-4 list-disc space-y-0.5 max-h-32 overflow-auto">
            {scan.unrecognized.map((p) => (<li key={p} className="truncate">{p}</li>))}
          </ul>
        </details>
      )}
    </div>
  );
}

// Steps that fold several source files into one chip — stems (up to 6 WAVs),
// layers (the doc + per-type cues/spans/loops files), and algos (N
// cache JSONs). Itemising them is what keeps the table honest: a single
// "Stems" chip otherwise hides which of drums/bass/other/vocals/guitar/piano
// actually landed. Returns [] for the one-file steps, which render a plain chip.
const STEM_ORDER = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'] as const;

function stepItems(song: ScannedSong, step: StepKey): string[] {
  switch (step) {
    case 'stems':
      return STEM_ORDER.filter((n) => (song.stems as Record<string, unknown>)[n]);
    case 'algos':
      return song.algoFiles.map((a) => a.name);
    case 'layers': {
      const out: string[] = [];
      if (song.annotations.layers) out.push('layers.json');
      for (const lf of song.layerFiles) out.push(`${lf.type}: ${lf.name}`);
      return out;
    }
    default:
      return [];
  }
}

function stepHasLocal(song: ScannedSong, step: StepKey): boolean {
  switch (step) {
    case 'audio':    return !!song.audio;
    case 'songInfo': return !!song.songInfo;
    case 'autoGuess': return !!song.annotations['auto-guess'];
    case 'layers':   return !!song.annotations.layers || song.layerFiles.length > 0;
    case 'algos':    return song.algoFiles.length > 0;
    case 'stems':    return Object.keys(song.stems).length > 0;
  }
}

function stepHasServer(status: ServerStatus | undefined, step: StepKey): boolean {
  if (!status) return false;
  switch (step) {
    case 'audio':    return status.songExists;
    case 'songInfo': return status.hasSongInfo;
    case 'autoGuess': return status.hasAutoGuess;
    case 'layers':   return status.hasLayers;
    case 'algos':    return false; // no cheap server probe; treat as "unknown"
    case 'stems':    return false; // no cheap server probe; treat as "unknown"
  }
}

// ── Importing stage ─────────────────────────────────────────────────────────

function ImportingStage({ progress, scan }: { progress: ImportProgress; scan: ScanResult }) {
  const currentSlug = progress.songSlug;
  const total = progress.totalSongs;
  const pct = total > 0 ? Math.round(((progress.songIndex + (progress.frac ?? 0)) / total) * 100) : 0;
  const currentSong = scan.songs.find((s) => s.slug === currentSlug);
  return (
    <div className="space-y-3">
      <div className="text-[12px] text-slate-300">
        {progress.songIndex + 1} / {total} —{' '}
        <span className="text-slate-100">{currentSong?.displayName || currentSlug}</span>
        {progress.step && <span className="text-slate-400"> · {STEP_LABEL[progress.step]}</span>}
      </div>
      <div className="relative h-2 rounded-full overflow-hidden bg-white/[0.06] border border-white/10">
        <div
          className="absolute inset-y-0 left-0 bg-emerald-400/70 rounded-full transition-[width] duration-200 ease-out"
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </div>
    </div>
  );
}

// ── Done stage ──────────────────────────────────────────────────────────────

function DoneStage({ results, scan }: { results: SongImportResult[]; scan: ScanResult | null }) {
  const errorCount = results.reduce((acc, r) => acc + Object.values(r.steps).filter((s) => s?.status === 'error').length, 0);
  const okCount = results.reduce((acc, r) => acc + Object.values(r.steps).filter((s) => s?.status === 'ok').length, 0);
  return (
    <div className="space-y-3">
      <div className="text-[12px] text-slate-300">
        {results.length} song{results.length === 1 ? '' : 's'} processed · {okCount} step{okCount === 1 ? '' : 's'} OK
        {errorCount > 0 && <span className="text-rose-300"> · {errorCount} failed</span>}
      </div>
      <div className="border border-white/[0.06] rounded overflow-hidden max-h-[50vh] overflow-y-auto">
        {results.map((r) => {
          const song = scan?.songs.find((s) => s.slug === r.slug);
          const stepEntries = Object.entries(r.steps) as [StepKey, { status: 'ok' | 'error' | 'skip'; message?: string } | undefined][];
          return (
            <div key={r.slug} className="px-3 py-2 border-b border-white/[0.04]">
              <div className="text-[12px] text-slate-200">{song?.displayName || r.slug}</div>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {stepEntries.map(([key, info]) => {
                  if (!info) return null;
                  const tone = info.status === 'ok'
                    ? 'bg-emerald-500/15 text-emerald-200 border-emerald-400/40'
                    : info.status === 'error'
                      ? 'bg-rose-500/15 text-rose-200 border-rose-400/40'
                      : 'bg-white/[0.03] text-slate-500 border-white/[0.06]';
                  return (
                    <span
                      key={key}
                      title={info.message ?? ''}
                      className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${tone}`}
                    >
                      {STEP_LABEL[key]} · {info.status}
                    </span>
                  );
                })}
              </div>
              {/* An OK step with something to say — the server re-encoded a
                  VBR mp3 — says it in the open, not only in a hover title. */}
              {stepEntries.map(([key, info]) => info?.status === 'ok' && info.message ? (
                <div key={key} className="mt-1 text-[11px] text-sky-200">
                  {STEP_LABEL[key]}: {info.message}
                </div>
              ) : null)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
