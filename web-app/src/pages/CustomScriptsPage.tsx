import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  copyDetector,
  createPackage,
  deleteDetector,
  deleteDetectorOutputs,
  getDetectorResult,
  installPackage,
  listDetectors,
  listPackages,
  moveDetector,
  PackageExistsError,
  type PackageFields,
  readDetectorSource,
  reloadDetectors,
  runDetector,
  setDetectorArchived,
  sharePackage,
  uninstallPackage,
  updatePackage,
  uploadDetector,
} from '../services/customScripts';
import { loadBoundaryItems } from '../services/annotationLayers';
import { annotatorHeaders } from '../utils/annotatorHeaders';
import { useDemucsStems, fetchStemManifest, stemsFromManifest, type StemManifest } from '../hooks/useDemucsStems';
import { StemsRunLog } from '../components/inspector-v2/StemsRunLog';
import { useCapabilities } from '../hooks/useCapabilities';
import { GPU_TOOLS_UNAVAILABLE_HINT } from '../services/capabilities';
import type {
  CustomBoundaryItem,
  CustomOutputKind,
  CustomRegistryEntry,
  CustomResultEnvelope,
  CustomValidationError,
  DetectorPackage,
  MissingModuleHint,
} from '../types/customScript';
import { isMissingModuleHint } from '../types/customScript';
import type { SectionBlock } from '../types/sectionBlock';
import type { BoundaryItem } from '../types/annotationLayer';
import { InfoBanner } from '../components/InfoBanner';
import { useResizableHeight } from '../hooks/useResizableHeight';
import { CollapsedSidebarRail, HeightResizeHandle, SidebarResizeHandle } from '../components/SidebarChrome';
import { useResizableSidebar } from '../hooks/useResizableSidebar';
import { clusterByDetectorGroup, groupByDetectorPackage } from '../utils/detectorPackages';
import { detectorColors, detectorItemCount } from '../components/inspector-v2/detectorLayers';
import { DetectorRail, RailFact, RailSection } from '../components/playground/DetectorRail';
import { PackageDialog } from '../components/playground/PackageDialog';
import { foldPerStem, parseStemAttr, runNameFor, setStemInCode } from '../utils/detectorStems';
import { StemPicker } from '../components/playground/StemPicker';
import { SongsSidebar, type SidebarSong, type SongRunStatus } from '../components/playground/SongsSidebar';
import type { PlaygroundMenuItem } from '../components/playground/PlaygroundMenu';
import { PlaygroundSongView } from '../components/playground/PlaygroundSongView';
const STARTER_CODE = `from custom_api import Boundary, CustomDetector, DetectionContext


class MyDetector(CustomDetector):
    # ── Identity (required) ──────────────────────────────────────────────
    # The Playground reads \`name\` and \`label\` from the lines below and shows
    # them as the title / subtitle in the editor — change them right here.
    name = "my_detector"            # ^[a-z][a-z0-9_-]{0,30}$, unique
    label = "My detector"           # 1–80 chars, shown as the human-readable title
    output_kind = "boundary"        # "boundary" or "cue"

    # ── Flags (optional) ──────────────────────────────────────────────────
    # Every detector shows in Algorithm Inspect as a read-only lane.
    is_annotation = False           # True: a run also copies the output into
                                    # a new layer of the annotator who ran it

    # ── Optional metadata ─────────────────────────────────────────────────
    description = "What this detector does, in one sentence."
    version = "0.1"

    def detect(self, ctx: DetectionContext) -> list[Boundary]:
        """Return your boundary predictions.

        Available on \`ctx\`:
          ctx.audio          : np.ndarray, mono, sr=22050
          ctx.sr             : 22050
          ctx.duration_ms    : int
          ctx.stems          : {"vocals","drums","bass","other"} → np.ndarray (may be {})
          ctx.features       : AudioFeatures (rms, chromagram, mfcc, spectral_*, ...)
          ctx.energy_curve   : np.ndarray in [0, 1], 100 ms / sample
          ctx.tension_curve  : np.ndarray in [0, 1], 100 ms / sample
          ctx.bpm            : float
          ctx.beat_times_ms  : list[int]

        Validation rules (each violation drops that item, others are kept):
          - Boundary.time_ms    : int, in [0, ctx.duration_ms]
          - Boundary.label      : str | None
          - Boundary.importance : "critical" | "optional" | None
          - Boundary.candidates : list[int] | None — each in [0, ctx.duration_ms]
        """
        # ─── Replace this with your logic ─────────────────────────────────
        return [
            Boundary(time_ms=t, label=f"step {t // 1000}s", importance="optional")
            for t in range(0, ctx.duration_ms + 1, 30_000)
        ]
`;


interface ManifestSong {
  id: string;
  /** Display name. Some manifest variants call it `title`, others `name`. */
  title?: string;
  name?: string;
  /** Audio URL — present in /analysis/manifest.json; used to locate the song's
   *  stem manifest so the Playground can show / trigger Demucs stems. */
  url?: string;
}

const STATUS_BADGE: Record<CustomRegistryEntry['status'], { label: string; className: string }> = {
  ok:                { label: 'OK',                 className: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50' },
  validation_error:  { label: 'Validation error',   className: 'bg-amber-900/40 text-amber-300 border-amber-700/50' },
  load_error:        { label: 'Load error',         className: 'bg-rose-900/40 text-rose-300 border-rose-700/50' },
};

/** Parse a class-attribute string-literal out of detector source.
 *  Returns the value of `key = "..."` for the first match — only handles the
 *  simple single-line form the contract uses, which is enough for `name` and
 *  `label`. */
function parseClassAttr(code: string, key: string): string | null {
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(?:"([^"\\n]*)"|'([^'\\n]*)')`, 'm');
  const m = code.match(re);
  if (!m) return null;
  const v = (m[1] ?? m[2] ?? '').trim();
  return v.length > 0 ? v : null;
}

/** Output kinds a detector may declare — mirrors CustomOutputKind / ALLOWED_OUTPUT_KIND. */
const OUTPUT_KINDS: readonly CustomOutputKind[] = ['boundary', 'cue', 'span', 'loop', 'lyrics'];

/** Python-side defaults for the must-have flags (custom_api.py CustomDetector).
 *  Used when a flag line is absent from the source so the editor controls match
 *  what the loader would actually read via getattr(). */
const FLAG_DEFAULTS = { is_annotation: false, review: false, output_kind: 'boundary' as CustomOutputKind };
const ANNOTATION_TIP = 'When an annotator runs this detector, also copy its output into a new layer of theirs — the lane\'s ⬇, done for them. Once: a re-run leaves an existing copy alone. Off: the output stays a proposal in the Inspect tab.';
const REVIEW_TIP = 'Put a ✓/✗ on every item this detector draws. Rejected items stay behind when the lane is copied. Off: the lane shows its items plainly.';

/** Parse a boolean class attribute (`key = True | False`). Returns null when the
 *  line is absent, so callers can fall back to the Python-side default. */
function parseBoolAttr(code: string, key: string): boolean | null {
  const m = code.match(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(True|False)\\b`, 'm'));
  return m ? m[1] === 'True' : null;
}

/** Parse a string-literal class attribute constrained to an allowed set. */
function parseEnumAttr<T extends string>(code: string, key: string, allowed: readonly T[]): T | null {
  const v = parseClassAttr(code, key);
  return v != null && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

/** Insert a new attribute assignment into the first CustomDetector subclass body,
 *  right after the class header, indented one level past the class keyword.
 *  Returns the code unchanged when no such class is found. */
function insertClassAttr(code: string, assignment: string): string {
  const lines = code.split('\n');
  const idx = lines.findIndex((l) => /^\s*class\s+\w+\s*\(.*\bCustomDetector\b.*\)\s*:/.test(l));
  if (idx === -1) return code;
  const classIndent = lines[idx].match(/^\s*/)?.[0] ?? '';
  lines.splice(idx + 1, 0, `${classIndent}    ${assignment}`);
  return lines.join('\n');
}

/** Rewrite (or insert) a boolean flag assignment, mirroring the server's
 *  patch_script_flags so the editor buffer stays the single source of truth.
 *  Preserves the existing line's indentation and trailing comment. */
function setBoolFlagInCode(code: string, key: string, value: boolean): string {
  const re = new RegExp(`^([ \\t]*)(${key})([ \\t]*=[ \\t]*)(?:True|False)([ \\t]*(?:#.*)?)$`, 'm');
  const lit = value ? 'True' : 'False';
  return re.test(code) ? code.replace(re, `$1$2$3${lit}$4`) : insertClassAttr(code, `${key} = ${lit}`);
}

/** Rewrite (or insert) a string-literal flag assignment, preserving indentation
 *  and trailing comment. */
function setStrFlagInCode(code: string, key: string, value: string): string {
  const re = new RegExp(`^([ \\t]*)(${key})([ \\t]*=[ \\t]*)(?:"[^"\\n]*"|'[^'\\n]*')([ \\t]*(?:#.*)?)$`, 'm');
  return re.test(code) ? code.replace(re, `$1$2$3"${value}"$4`) : insertClassAttr(code, `${key} = "${value}"`);
}

const NAME_RE_CLIENT = /^[a-z][a-z0-9_-]{0,30}$/;
/** localStorage key for editor autosave. `__new__` covers the "no file yet" case. */
const DRAFT_KEY = (identity: string) => `customscripts.draft.${identity || '__new__'}`;

function fmtError(e: CustomValidationError): string {
  const where = e.field ? `[${e.field}]` : e.index != null ? `(item ${e.index})` : '';
  // Skip dict-shaped values (those are structured hints rendered separately).
  const showValue = e.value !== undefined && e.value !== null && typeof e.value !== 'object';
  const value = showValue ? `  value=${JSON.stringify(e.value)}` : '';
  return `${where} ${e.message}${value}`.trim();
}

/** Pull the first missing-module hint from a list of validation errors, if any. */
function findMissingModule(errors: CustomValidationError[]): MissingModuleHint | null {
  for (const e of errors) {
    if (isMissingModuleHint(e.value)) return e.value;
  }
  return null;
}

function MissingModulePanel({
  hint,
  onReload,
}: {
  hint: MissingModuleHint;
  onReload?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hint.suggested_install);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (insecure context, etc.) — user can still
      // select the text manually.
    }
  };
  return (
    <div className="text-[12px] bg-amber-950/30 border border-amber-700/50 rounded p-3 space-y-2">
      <div className="text-amber-200 font-semibold flex items-center gap-2">
        <span>⚠</span>
        <span>Missing Python module: <code className="font-mono text-amber-100">{hint.missing_module}</code></span>
      </div>
      <div className="text-slate-300">
        Run this in a terminal on the host, then click Reload:
      </div>
      <div className="flex items-center gap-2 bg-black/40 border border-white/[0.06] rounded px-2 py-1.5 font-mono text-[12px]">
        <span className="text-slate-500 select-none">$</span>
        <span className="flex-1 min-w-0 break-all text-emerald-200 select-all">{hint.suggested_install}</span>
        <button
          onClick={copy}
          className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border border-white/[0.08] text-slate-300 hover:text-slate-100 hover:border-white/[0.16] transition-colors"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {hint.suggested_package !== hint.missing_module && (
        <div className="text-[10px] text-slate-500">
          (the import name <code className="font-mono text-slate-400">{hint.missing_module}</code> comes from pip package <code className="font-mono text-slate-400">{hint.suggested_package}</code>)
        </div>
      )}
      {onReload && (
        <div className="pt-1">
          <button
            onClick={onReload}
            className="text-[11px] px-2.5 py-1 rounded border border-amber-700/50 bg-amber-900/30 text-amber-200 hover:bg-amber-900/50 transition-colors"
          >
            ↻ Reload registry
          </button>
        </div>
      )}
    </div>
  );
}

/** An on/off switch for a boolean detector flag, used in the editor's Flags row.
 *  Shows the flag's source name, an explicit on/off state, and a "(default)"
 *  hint when the value is implied (no assignment line in the source yet). */
function FlagSwitch({
  name, tip, value, defaulted, onChange,
}: {
  name: string;
  tip: string;
  value: boolean;
  defaulted?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px]" title={tip}>
      <code className="text-slate-400">{name}</code>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={`${name}: ${value ? 'on' : 'off'}`}
        onClick={() => onChange(!value)}
        className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition ${
          value ? 'bg-emerald-600/70' : 'bg-slate-700'
        }`}
      >
        <span
          className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${
            value ? 'translate-x-3.5' : 'translate-x-0.5'
          }`}
        />
      </button>
      <span className={`w-6 ${value ? 'text-emerald-300' : 'text-slate-500'}`}>{value ? 'on' : 'off'}</span>
      {defaulted && <span className="text-slate-600">(default)</span>}
    </span>
  );
}

interface BatchRow {
  slug: string;
  title: string;
  envelope: CustomResultEnvelope | { error: string };
  manual: BoundaryItem[];
}

interface BatchRunState {
  running: boolean;
  cancelRequested: boolean;
  current: number;        // 1-indexed; 0 before the first song starts
  total: number;
  rows: BatchRow[];
}

/** A run's outcome as the page keeps it: the envelope, a request that failed
 *  outright, or `null` — asked, and the song has no cached run. */
type RunResult = CustomResultEnvelope | { error: string };

const DETECTOR_PREF = 'playground.detector';
const SONG_PREF = 'playground.song';

function readPref(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function writePref(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* a courtesy */ }
}

/** A detector's file as the repo names it — the registry reports it absolute. */
function repoPath(file: string): string {
  const i = file.indexOf('tools/python/');
  return i === -1 ? file : file.slice(i);
}

function withoutKey<T>(rec: Record<string, T>, key: string): Record<string, T> {
  const next = { ...rec };
  delete next[key];
  return next;
}

const KIND_NOUN: Record<CustomOutputKind, [string, string]> = {
  boundary: ['boundary', 'boundaries'],
  cue:      ['cue', 'cues'],
  span:     ['span', 'spans'],
  loop:     ['loop', 'loops'],
  lyrics:   ['line', 'lines'],
  riff:     ['instance', 'instances'],
  // A lanes detector's count is of the items across its lanes.
  lanes:    ['item', 'items'],
};
function countOf(n: number, kind: CustomOutputKind): string {
  const [one, many] = KIND_NOUN[kind] ?? ['item', 'items'];
  return `${n} ${n === 1 ? one : many}`;
}

export function CustomScriptsPage() {
  const navigate = useNavigate();
  const railSidebar = useResizableSidebar({
    storageKey: 'tc:playground-rail', side: 'left', minWidth: 200, maxWidth: 520, defaultWidth: 256,
    widthFraction: 0.18,  // the same share of the window as the workspace side panels
  });
  const songsSidebar = useResizableSidebar({
    storageKey: 'tc:playground-songs', side: 'right', minWidth: 220, maxWidth: 520, defaultWidth: 280,
    widthFraction: 0.18,
  });
  // The seams between the panes drag too: editor ↕ Output, and the top row ↕
  // the song under it. Each keeps its CSS size until first dragged.
  const { setPane: setOutputPane, ...outputPane } = useResizableHeight({ storageKey: 'tc:playground-output-h', minHeight: 64 });
  const { setPane: setSongPane, ...songPane } = useResizableHeight<HTMLElement>({ storageKey: 'tc:playground-song-h', minHeight: 120 });
  const [detectors, setDetectors] = useState<CustomRegistryEntry[]>([]);
  const [registryLoaded, setRegistryLoaded] = useState(false);
  const [reloading, setReloading] = useState(false);
  const detectorsRef = useRef(detectors);
  detectorsRef.current = detectors;
  /** Detector packages (folders under tools/python/custom/), by id. */
  const [packages, setPackages] = useState<Record<string, DetectorPackage>>({});
  /** Non-null while a package is being installed / shared / removed. */
  const [packageBusy, setPackageBusy] = useState<string | null>(null);
  const [songs, setSongs] = useState<ManifestSong[]>([]);
  const [songsLoading, setSongsLoading] = useState(true);
  const [songsError, setSongsError] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string>('');
  const [busy, setBusy] = useState<Record<string, 'run' | 'delete' | 'clear' | 'rename' | null>>({});
  /** Non-null while an every-detector Run / Clear sweep is in flight. */
  const [bulkBusy, setBulkBusy] = useState<'run' | 'clear' | null>(null);
  /** Runs per `[detectorName][songSlug]`: the last run this session made, or
   *  the cached one read back from the server; `null` = asked, none cached. */
  const [results, setResults] = useState<Record<string, Record<string, RunResult | null>>>({});
  const resultsRef = useRef(results);
  resultsRef.current = results;
  /** The detector whose cached runs are being read back, while they are. */
  const [loadingCached, setLoadingCached] = useState<string | null>(null);
  /** Manual annotation snapshot per detector run, keyed `[detectorName][songSlug]`.
   *  Refetched each run so post-edit boundary changes show up on the next Run
   *  without a reload. `[]` = the song has no boundary layer yet. */
  const [manualByRun, setManualByRun] = useState<Record<string, Record<string, BoundaryItem[]>>>({});
  /** Per-detector "Run all" state — survives single-song Run clicks so users can
   *  iterate on one song without losing the batch overview. */
  const [batchByDetector, setBatchByDetector] = useState<Record<string, BatchRunState>>({});
  /** Cancel flag for an in-flight batch. Lives in a ref so the loop sees writes
   *  without depending on React state propagation between awaits. */
  const cancelBatchRef = useRef<Record<string, boolean>>({});
  /** When each detector was last saved from this page — a run older than that
   *  is of code that has since changed. */
  const [savedAt, setSavedAt] = useState<Record<string, number>>({});
  const [topMessage, setTopMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  // ── The editor ─────────────────────────────────────────────────────────────
  // Always open, on one detector: the one picked in the rail, or a new one.
  /** The detector in the editor; null while a new one is. */
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [code, setCode] = useState(STARTER_CODE);
  /** What the file on disk holds (the starter, for a new detector). The buffer
   *  differing from it is an unsaved edit. */
  const [savedCode, setSavedCode] = useState(STARTER_CODE);
  const [loadingSource, setLoadingSource] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Bumped on every open, so a slow source read can't land on a newer pick. */
  const openTokenRef = useRef(0);
  const dirty = isNew || code !== savedCode;
  /** Parsed `name`/`label` from the live editor buffer — re-derived on every
   *  keystroke so the title/subtitle preview stays in sync. */
  const parsedName = useMemo(() => parseClassAttr(code, 'name'), [code]);
  const parsedLabel = useMemo(() => parseClassAttr(code, 'label'), [code]);
  /** Must-have flags parsed live from the editor buffer. null = no assignment
   *  line yet, so the dedicated controls fall back to the Python-side default
   *  and flag a "(default)" hint. Re-derived on every keystroke / paste, so the
   *  controls always reflect what the loader would read from the source. */
  const parsedAnnotation = useMemo(() => parseBoolAttr(code, 'is_annotation'), [code]);
  const parsedOutputKind = useMemo(() => parseEnumAttr(code, 'output_kind', OUTPUT_KINDS), [code]);
  const effAnnotation = parsedAnnotation ?? FLAG_DEFAULTS.is_annotation;
  const parsedReview = useMemo(() => parseBoolAttr(code, 'review'), [code]);
  const effReview = parsedReview ?? FLAG_DEFAULTS.review;
  const effOutputKind = parsedOutputKind ?? FLAG_DEFAULTS.output_kind;
  /** Errors of the open detector: the registry's, then the latest save's. */
  const [editorErrors, setEditorErrors] = useState<CustomValidationError[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);
  // Full view: the editor alone over the whole window, to read the code.
  // The same section, restyled — the editor never remounts. Esc leaves it,
  // unless CodeMirror used the Esc itself (closing search or a completion).
  const [codeFull, setCodeFull] = useState(false);
  useEffect(() => {
    if (!codeFull) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) setCodeFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [codeFull]);

  /** One entry per detector FILE. A detector declaring several stems is
   *  registered once per stem (`<name>__<stem>`); the editor opens, saves,
   *  renames and deletes the file, so it lists it once (utils/detectorStems). */
  const files = useMemo(() => foldPerStem(detectors), [detectors]);
  const sel = useMemo(
    () => (selectedName ? files.find((d) => d.name === selectedName) ?? null : null),
    [files, selectedName],
  );
  const colors = useMemo(() => detectorColors(files), [files]);
  const parsedStem = useMemo(() => parseStemAttr(code), [code]);
  /** Which stem ▶ Run runs, for a detector run once per stem. Each stem is its
   *  own run with its own results, so the song list and the output pane show
   *  this one. Reset to the first declared stem when it stops being one. */
  const [runStem, setRunStem] = useState<string | null>(null);
  const savedStems = sel?.stems && sel.stems.length > 0 ? sel.stems : null;
  const effRunStem = savedStems ? (runStem && (savedStems as string[]).includes(runStem) ? runStem : savedStems[0]) : null;
  /** The registry name a run of the open detector goes under. */
  const runName = selectedName ? (savedStems ? runNameFor(selectedName, effRunStem) : selectedName) : null;

  // ── Demucs stems for the selected song ─────────────────────────────────────
  // Reuses the exact run/poll/cancel/kill flow from the inspector (useDemucsStems)
  // so the Playground can stem a song before running stem-scoped curators. The
  // manifest tells us which stems already exist on disk.
  const { capabilities } = useCapabilities();
  const selectedSong = useMemo(() => songs.find((s) => s.id === selectedSlug) ?? null, [songs, selectedSlug]);
  const selectedSongTitle = selectedSong?.title ?? selectedSong?.name ?? selectedSlug;
  const [stemManifest, setStemManifest] = useState<StemManifest | null>(null);
  const [stemManifestLoading, setStemManifestLoading] = useState(false);
  const selectedSlugRef = useRef(selectedSlug);
  useEffect(() => { selectedSlugRef.current = selectedSlug; }, [selectedSlug]);

  const {
    job: demucsJob,
    runStems,
    cancelStems,
    killStems,
    dismissError: dismissStemsError,
    elapsedSec: stemsElapsedSec,
  } = useDemucsStems({
    onComplete: (audio, m) => {
      if (selectedSlugRef.current === audio.id) setStemManifest(m);
    },
  });

  // Refetch the stem manifest whenever the selected song changes so the
  // "has stems" readout reflects what's actually on disk for that track.
  useEffect(() => {
    if (!selectedSong?.url) { setStemManifest(null); return; }
    let cancelled = false;
    setStemManifestLoading(true);
    fetchStemManifest(selectedSong.url)
      .then((m) => { if (!cancelled) setStemManifest(m); })
      .finally(() => { if (!cancelled) setStemManifestLoading(false); });
    return () => { cancelled = true; };
  }, [selectedSong?.url]);

  const presentStems = useMemo(() => stemsFromManifest(stemManifest), [stemManifest]);
  const stemsRunning = demucsJob?.slug === selectedSlug && demucsJob?.status === 'running';
  const handleRunStems = useCallback(() => {
    if (!selectedSong?.url) return;
    runStems({ id: selectedSong.id, name: selectedSong.title ?? selectedSong.name ?? selectedSong.id, url: selectedSong.url });
  }, [selectedSong, runStems]);

  const refresh = useCallback(async () => {
    // Both requests at once, and both lists set together: each re-scans every
    // detector, so one after the other drew the package titles bare for half
    // a second before their details arrived. A server that predates packages
    // still lists its detectors, just without package details.
    const pkgs = listPackages().catch(() => [] as DetectorPackage[]);
    try {
      const [list, packageList] = await Promise.all([
        // …and the archived ones: this is the one page that still opens them.
        listDetectors({ includeArchived: true }),
        pkgs,
      ]);
      setDetectors(list);
      setPackages(Object.fromEntries(packageList.map((p) => [p.id, p])));
    } catch (e) {
      setTopMessage({ kind: 'error', text: `Failed to load registry: ${(e as Error).message}` });
    } finally {
      setRegistryLoaded(true);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Fetch the song list so we can run detectors on a chosen song. Mirrors the
  // logic in InspectorPageV2.fetchManifest — accept both a flat array (current
  // shape) and {songs: [...]} so this keeps working if the format ever flips.
  // Surfacing songsLoading/songsError lets the list explain why it's empty
  // instead of silently saying "no songs found".
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/analysis/manifest.json', {
          headers: annotatorHeaders(),
        });
        if (!res.ok) {
          if (!cancelled) {
            setSongsError(`manifest fetch returned ${res.status}`);
            setSongsLoading(false);
          }
          return;
        }
        const data: unknown = await res.json();
        const list: ManifestSong[] = Array.isArray(data)
          ? (data as ManifestSong[])
          : ((data as { songs?: ManifestSong[] } | null)?.songs ?? []);
        if (cancelled) return;
        setSongs(list);
        setSongsError(null);
        setSongsLoading(false);
        // The song this viewer last ran on, when it is still in the dataset.
        const pref = readPref(SONG_PREF);
        if (list.length) setSelectedSlug(pref && list.some((s) => s.id === pref) ? pref : list[0].id);
      } catch (e) {
        if (!cancelled) {
          setSongsError((e as Error).message);
          setSongsLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const pickSong = (slug: string) => {
    setSelectedSlug(slug);
    writePref(SONG_PREF, slug);
  };

  // ── Opening a detector ─────────────────────────────────────────────────────

  const selectDetector = useCallback(async (name: string) => {
    const token = ++openTokenRef.current;
    setSelectedName(name);
    setIsNew(false);
    setLoadingSource(true);
    setHelpOpen(false);
    writePref(DETECTOR_PREF, name);
    const src = await readDetectorSource(name);
    if (token !== openTokenRef.current) return;
    const disk = src ?? '';
    // An unsaved edit left in this browser wins over the file: it is what the
    // user was last typing. The title row marks it unsaved.
    let initial = disk;
    try {
      const draft = window.localStorage.getItem(DRAFT_KEY(name));
      if (draft && draft.trim().length > 0) initial = draft;
    } catch {
      // Storage unavailable — use the file.
    }
    setSavedCode(disk);
    setCode(initial);
    const entry = detectorsRef.current.find((d) => d.name === name);
    setEditorErrors(entry?.errors ?? []);
    setLoadingSource(false);
    if (src == null) setTopMessage({ kind: 'error', text: `Source for "${name}" not available.` });
  }, []);

  const startNew = useCallback(() => {
    ++openTokenRef.current;
    setSelectedName(null);
    setIsNew(true);
    setLoadingSource(false);
    setHelpOpen(false);
    let initial = STARTER_CODE;
    try {
      const draft = window.localStorage.getItem(DRAFT_KEY(''));
      if (draft && draft.trim().length > 0) initial = draft;
    } catch {
      // Storage unavailable — start from the template.
    }
    setSavedCode(STARTER_CODE);
    setCode(initial);
    setEditorErrors([]);
  }, []);

  // Open something as soon as the registry is in: the detector this viewer
  // last had open, else the first in the rail, else a new one.
  useEffect(() => {
    if (!registryLoaded || selectedName || isNew) return;
    if (files.length === 0) { startNew(); return; }
    const pref = readPref(DETECTOR_PREF);
    const pick = pref && files.some((d) => d.name === pref)
      ? pref
      : clusterByDetectorGroup(groupByDetectorPackage(files.filter((d) => !d.archived))[0]?.items ?? [])[0]?.items[0]?.name;
    if (pick) void selectDetector(pick);
  }, [registryLoaded, files, selectedName, isNew, selectDetector, startNew]);

  /** Keep an unsaved edit in this browser, keyed by the detector (or `__new__`),
   *  so a closed tab or a switch to another detector doesn't lose it. Dropped
   *  the moment the buffer matches the file again. */
  useEffect(() => {
    if (loadingSource || (!isNew && !selectedName)) return;
    const key = DRAFT_KEY(isNew ? '' : selectedName ?? '');
    try {
      if (code === savedCode) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, code);
    } catch {
      // Storage quota / privacy mode — autosave is a courtesy, not a contract.
    }
  }, [loadingSource, isNew, selectedName, code, savedCode]);

  // ── Cached runs of the open detector ───────────────────────────────────────
  // Read back what it has on every song, a few at a time, so each song row can
  // say so before anything is run this session.
  useEffect(() => {
    if (!runName || isNew || songs.length === 0) return;
    const name = runName;
    const todo = songs.map((s) => s.id).filter((id) => resultsRef.current[name]?.[id] === undefined);
    if (todo.length === 0) return;
    let cancelled = false;
    setLoadingCached(name);
    let next = 0;
    const worker = async () => {
      while (!cancelled && next < todo.length) {
        const slug = todo[next++];
        let env: CustomResultEnvelope | null = null;
        try { env = await getDetectorResult(name, slug); } catch { env = null; }
        if (cancelled) return;
        setResults((r) => (r[name]?.[slug] !== undefined ? r : { ...r, [name]: { ...(r[name] ?? {}), [slug]: env } }));
      }
    };
    Promise.all([worker(), worker(), worker(), worker()]).then(() => {
      if (!cancelled) setLoadingCached((c) => (c === name ? null : c));
    });
    return () => { cancelled = true; };
  }, [runName, isNew, songs]);

  const current = runName ? results[runName]?.[selectedSlug] : undefined;
  const currentEnvelope = current && !('error' in current) ? current : null;

  // A boundary detector's run is scored against the song's manual boundaries.
  useEffect(() => {
    if (!runName || !currentEnvelope || currentEnvelope.output_kind !== 'boundary') return;
    if (manualByRun[runName]?.[selectedSlug] !== undefined) return;
    const name = runName;
    const slug = selectedSlug;
    let cancelled = false;
    loadBoundaryItems(slug).then((manual) => {
      if (!cancelled) setManualByRun((g) => ({ ...g, [name]: { ...(g[name] ?? {}), [slug]: manual } }));
    });
    return () => { cancelled = true; };
  }, [runName, selectedSlug, currentEnvelope, manualByRun]);

  const handleReload = async () => {
    setReloading(true);
    try {
      const list = await reloadDetectors({ includeArchived: true });
      setDetectors(list);
      setPackages(Object.fromEntries((await listPackages().catch(() => [])).map((p) => [p.id, p])));
      if (selectedName) setEditorErrors(foldPerStem(list).find((d) => d.name === selectedName)?.errors ?? []);
      setTopMessage({ kind: 'info', text: `Re-scanned tools/python/custom/ — ${list.length} detector${list.length === 1 ? '' : 's'} found.` });
    } catch (e) {
      setTopMessage({ kind: 'error', text: `Reload failed: ${(e as Error).message}` });
    } finally {
      setReloading(false);
    }
  };

  /** Patch the matching slug's row in an existing batch — so a single-song
   *  re-run refreshes a stale "failed" badge instead of leaving it behind. */
  const patchBatchRow = (
    name: string,
    slug: string,
    envelope: RunResult,
    manual: BoundaryItem[],
  ) => {
    setBatchByDetector((prev) => {
      const cur = prev[name];
      if (!cur) return prev;
      const idx = cur.rows.findIndex((r) => r.slug === slug);
      if (idx < 0) return prev;
      const nextRows = cur.rows.slice();
      nextRows[idx] = { ...nextRows[idx], envelope, manual };
      return { ...prev, [name]: { ...cur, rows: nextRows } };
    });
  };

  const handleRun = async (name: string) => {
    if (!selectedSlug) {
      setTopMessage({ kind: 'error', text: 'Select a song first.' });
      return;
    }
    const runSlug = selectedSlug;
    setBusy((b) => ({ ...b, [name]: 'run' }));
    try {
      // Fetch manual in parallel — comparison appears the moment the run lands,
      // and a fresh load picks up manual edits made between runs.
      const [env, manual] = await Promise.all([
        runDetector(name, runSlug, { force: true }),
        loadBoundaryItems(runSlug),
      ]);
      setResults((r) => ({ ...r, [name]: { ...(r[name] ?? {}), [runSlug]: env } }));
      setManualByRun((g) => ({ ...g, [name]: { ...(g[name] ?? {}), [runSlug]: manual } }));
      patchBatchRow(name, runSlug, env, manual);
      if (env.fatal) {
        setOutputOpen(true);
        setTopMessage({ kind: 'error', text: `${name}: ${env.fatal.type} — ${env.fatal.message}` });
      } else {
        setTopMessage({
          kind: 'info',
          text: `${name}: accepted ${env.stats.accepted}, rejected ${env.stats.rejected}.`,
        });
      }
    } catch (e) {
      const errEnvelope = { error: (e as Error).message };
      setResults((r) => ({ ...r, [name]: { ...(r[name] ?? {}), [runSlug]: errEnvelope } }));
      patchBatchRow(name, runSlug, errEnvelope, []);
      setOutputOpen(true);
      setTopMessage({ kind: 'error', text: `Run failed: ${(e as Error).message}` });
    } finally {
      setBusy((b) => ({ ...b, [name]: null }));
    }
  };

  const handleRunAll = async (name: string) => {
    if (songs.length === 0) {
      setTopMessage({ kind: 'error', text: 'Song manifest is empty — nothing to run on.' });
      return;
    }
    cancelBatchRef.current[name] = false;
    const total = songs.length;
    setBatchByDetector((prev) => ({
      ...prev,
      [name]: { running: true, cancelRequested: false, current: 0, total, rows: [] },
    }));
    setTopMessage({ kind: 'info', text: `${name}: running across ${total} song${total === 1 ? '' : 's'}…` });

    const rows: BatchRow[] = [];
    for (let i = 0; i < songs.length; i++) {
      if (cancelBatchRef.current[name]) break;
      const s = songs[i];
      const title = s.title ?? s.name ?? s.id;
      setBatchByDetector((prev) => ({
        ...prev,
        [name]: { ...prev[name], current: i + 1, rows: [...rows] },
      }));
      let row: BatchRow;
      try {
        const [env, manual] = await Promise.all([
          runDetector(name, s.id, { force: true }),
          loadBoundaryItems(s.id),
        ]);
        row = { slug: s.id, title, envelope: env, manual };
      } catch (e) {
        row = { slug: s.id, title, envelope: { error: (e as Error).message }, manual: [] };
      }
      rows.push(row);
      // Each song's row in the list fills in the moment its run lands.
      setResults((r) => ({ ...r, [name]: { ...(r[name] ?? {}), [row.slug]: row.envelope } }));
      setManualByRun((g) => ({ ...g, [name]: { ...(g[name] ?? {}), [row.slug]: row.manual } }));
    }

    const cancelled = cancelBatchRef.current[name];
    setBatchByDetector((prev) => ({
      ...prev,
      [name]: {
        running: false,
        cancelRequested: cancelled,
        current: rows.length,
        total,
        rows: [...rows],
      },
    }));
    setTopMessage({
      kind: 'info',
      text: cancelled
        ? `${name}: stopped after ${rows.length}/${total} songs.`
        : `${name}: finished — ${rows.length}/${total} songs processed.`,
    });
  };

  const handleCancelBatch = (name: string) => {
    cancelBatchRef.current[name] = true;
    setBatchByDetector((prev) =>
      prev[name] ? { ...prev, [name]: { ...prev[name], cancelRequested: true } } : prev,
    );
  };

  const handleInstallPackage = async (file: File) => {
    setPackageBusy('install');
    try {
      let pkg: DetectorPackage;
      try {
        pkg = await installPackage(file);
      } catch (e) {
        if (!(e instanceof PackageExistsError)) throw e;
        if (!confirm(
          `${e.message}.\n\nReplace it with the one in ${file.name}? ` +
          `The installed copy is moved to tools/python/custom/.trash/, not erased.`
        )) return;
        pkg = await installPackage(file, { replace: true });
      }
      await refresh();
      const n = pkg.detectors.length;
      setTopMessage({
        kind: 'info',
        text: `Installed “${pkg.title}” — ${n} detector${n === 1 ? '' : 's'} in tools/python/custom/${pkg.id}/.`,
      });
    } catch (e) {
      setTopMessage({ kind: 'error', text: `Install failed: ${(e as Error).message}` });
    } finally {
      setPackageBusy(null);
    }
  };

  const handleSharePackage = async (id: string) => {
    setPackageBusy(id);
    try {
      await sharePackage(id);
      setTopMessage({
        kind: 'info',
        text: `Saved ${id}.zip — send it as is. Your colleague installs it with Install, or unzips it into tools/python/custom/.`,
      });
    } catch (e) {
      setTopMessage({ kind: 'error', text: `Share failed: ${(e as Error).message}` });
    } finally {
      setPackageBusy(null);
    }
  };

  const handleRemovePackage = async (id: string, title: string) => {
    const pkg = packages[id];
    const held = (pkg?.detectors.length ?? 0) + (pkg?.archived?.length ?? 0);
    if (!confirm(
      (held === 0 ? `Remove the empty package “${title}”?\n\n` : `Remove the package “${title}” and every detector in it?\n\n`) +
      `The folder is moved to the app trash (tools/python/custom/.trash/), not erased. ` +
      `Cached algorithm results of its detectors are wiped.`
    )) return;
    setPackageBusy(id);
    try {
      const { trashed_to } = await uninstallPackage(id);
      await refresh();
      if (sel?.package === id) setSelectedName(null);
      setTopMessage({ kind: 'info', text: `Removed “${title}”. The folder is kept at ${trashed_to}.` });
    } catch (e) {
      setTopMessage({ kind: 'error', text: `Remove failed: ${(e as Error).message}` });
    } finally {
      setPackageBusy(null);
    }
  };

  /** The package dialog: a new package (with a detector to move into it once
   *  made, when opened from that detector's Move menu) or an existing one. */
  const [packageDialog, setPackageDialog] = useState<{ editId?: string; moveName?: string } | null>(null);

  const handleSubmitPackage = async (fields: PackageFields) => {
    const editId = packageDialog?.editId;
    const moveName = packageDialog?.moveName;
    if (editId) {
      const pkg = await updatePackage(editId, fields);
      setPackageDialog(null);
      await refresh();
      setTopMessage({ kind: 'info', text: `Saved “${pkg.title}” — tools/python/custom/${pkg.id}/package.json.` });
      return;
    }
    const pkg = await createPackage({ title: fields.title ?? '', description: fields.description });
    setPackageDialog(null);
    if (moveName) {
      await handleMove(moveName, pkg.id, pkg.title);
      return;
    }
    await refresh();
    setTopMessage({ kind: 'info', text: `Made “${pkg.title}” — tools/python/custom/${pkg.id}/. Drag detectors onto it to move them in.` });
  };

  const handleMove = async (name: string, packageId: string | null, title?: string) => {
    if (batchByDetector[name]?.running) {
      setTopMessage({ kind: 'error', text: `"${name}" is running on every song — stop it before moving it.` });
      return;
    }
    const where = packageId ? `“${title ?? packages[packageId]?.title ?? packageId}”` : 'no package';
    try {
      const entry = await moveDetector(name, packageId);
      await refresh();
      setTopMessage({ kind: 'info', text: `Moved "${name}" to ${where} — ${repoPath(entry.file)}. Its runs and outputs stay with it.` });
    } catch (e) {
      await refresh();
      setTopMessage({ kind: 'error', text: `Move failed: ${(e as Error).message}` });
    }
  };

  const handleArchive = async (name: string, archived: boolean) => {
    if (archived && batchByDetector[name]?.running) {
      setTopMessage({ kind: 'error', text: `"${name}" is running on every song — stop it before archiving it.` });
      return;
    }
    try {
      await setDetectorArchived(name, archived);
      await refresh();
      setTopMessage({
        kind: 'info',
        text: archived
          ? `Archived "${name}". Its code and outputs are kept; it waits under Archived at the bottom of the list, and no other page lists it.`
          : `Restored "${name}" — the Inspect tab lists it again, and Share package carries it.`,
      });
    } catch (e) {
      setTopMessage({ kind: 'error', text: `${archived ? 'Archive' : 'Restore'} failed: ${(e as Error).message}` });
    }
  };

  const handleDelete = async (name: string) => {
    if (!confirm(
      `Delete custom detector "${name}"?\n\n` +
      `The .py source is moved to the app trash (tools/python/custom/.trash/), ` +
      `not erased — delete it from disk manually if you want it gone for good. ` +
      `Cached algorithm results are wiped.`
    )) return;
    setBusy((b) => ({ ...b, [name]: 'delete' }));
    try {
      cancelBatchRef.current[name] = true;
      const { message } = await deleteDetector(name);
      setResults((r) => { const next = { ...r }; delete next[name]; return next; });
      setManualByRun((g) => { const next = { ...g }; delete next[name]; return next; });
      setBatchByDetector((b) => { const next = { ...b }; delete next[name]; return next; });
      try { window.localStorage.removeItem(DRAFT_KEY(name)); } catch { /* noop */ }
      await refresh();
      // The editor moves on to another detector (see the auto-open above).
      if (selectedName === name) setSelectedName(null);
      setTopMessage({ kind: 'info', text: message });
    } catch (e) {
      setTopMessage({ kind: 'error', text: `Delete failed: ${(e as Error).message}` });
    } finally {
      setBusy((b) => ({ ...b, [name]: null }));
    }
  };

  /** Forget what the page holds under a detector's old name. */
  const forgetDetector = (name: string) => {
    setResults((r) => withoutKey(r, name));
    setManualByRun((g) => withoutKey(g, name));
    setBatchByDetector((b) => withoutKey(b, name));
    setSavedAt((t) => withoutKey(t, name));
  };

  const handleRename = async (name: string, newName: string) => {
    if (name === selectedName && dirty) {
      setTopMessage({ kind: 'error', text: `Save or revert "${name}" before renaming it — the unsaved code still names it "${name}".` });
      return;
    }
    if (batchByDetector[name]?.running) {
      setTopMessage({ kind: 'error', text: `"${name}" is running on every song — stop it before renaming.` });
      return;
    }
    setBusy((b) => ({ ...b, [name]: 'rename' }));
    try {
      const entry = await copyDetector(name, newName, { move: true });
      forgetDetector(name);
      try { window.localStorage.removeItem(DRAFT_KEY(name)); } catch { /* noop */ }
      await refresh();
      if (selectedName === name) await selectDetector(newName);
      setTopMessage({ kind: 'info', text: `Renamed "${name}" to "${newName}" — ${repoPath(entry.file)}. Its runs moved with it.` });
    } catch (e) {
      setTopMessage({ kind: 'error', text: `Rename failed: ${(e as Error).message}` });
    } finally {
      setBusy((b) => ({ ...b, [name]: null }));
    }
  };

  /** Copy a detector's saved file to the first free "<name>_copy…" beside it,
   *  and open the copy. */
  const handleDuplicate = async (name: string): Promise<string | null> => {
    const taken = new Set([...detectors.map((d) => d.name), ...files.map((d) => d.name)]);
    let newName = '';
    for (let i = 1; !newName || taken.has(newName); i++) {
      const suffix = i === 1 ? '_copy' : `_copy${i}`;
      newName = name.slice(0, 31 - suffix.length) + suffix;
    }
    try {
      const entry = await copyDetector(name, newName);
      await refresh();
      await selectDetector(newName);
      setTopMessage({ kind: 'info', text: `Duplicated "${name}" as ${repoPath(entry.file)}.` });
      return newName;
    } catch (e) {
      setTopMessage({ kind: 'error', text: `Duplicate failed: ${(e as Error).message}` });
      return null;
    }
  };

  const copyText = (text: string, what: string) => {
    navigator.clipboard.writeText(text).then(
      () => setTopMessage({ kind: 'info', text: `Copied ${what}: ${text}` }),
      () => setTopMessage({ kind: 'error', text: `Could not copy ${what} — the browser refused the clipboard.` }),
    );
  };

  /** A rail row's right-click menu, after the rail's own Open / Rename / Duplicate. */
  const rowMenuItems = (d: CustomRegistryEntry): PlaygroundMenuItem[] => [
    { label: 'Copy name', separated: true, onSelect: () => copyText(d.name, 'the name') },
    { label: 'Copy path', title: 'The file\'s path from the repo root.', onSelect: () => copyText(repoPath(d.file), 'the path') },
    {
      label: 'Open in Inspect',
      separated: true,
      disabled: !selectedSlug,
      title: `Open ${selectedSongTitle || 'the song'} in the Inspect tab with this detector's lane drawn.`,
      onSelect: () => navigate(`/inspect?song=${encodeURIComponent(selectedSlug)}&dets=${encodeURIComponent(d.name)}`),
    },
    {
      label: `Clear outputs on ${selectedSongTitle || 'the song'}…`,
      title: 'Wipe this detector\'s outputs for the selected song only. Keeps the .py source. Cannot be undone.',
      disabled: busy[d.name] === 'clear' || !!batchByDetector[d.name]?.running || !selectedSlug,
      onSelect: () => { void handleClearOutputs(d.name, selectedSlug); },
    },
    {
      label: 'Clear outputs on every song…',
      title: 'Wipe this detector\'s algorithm cache and your annotation files for every song. Keeps the .py source. Cannot be undone.',
      disabled: busy[d.name] === 'clear' || !!batchByDetector[d.name]?.running,
      onSelect: () => { void handleClearOutputs(d.name); },
    },
    {
      label: 'Delete…',
      title: d.is_default
        ? 'A shipped example can\'t be deleted.'
        : 'Move the .py file to tools/python/custom/.trash/ and wipe its cached results.',
      disabled: d.is_default || busy[d.name] === 'delete',
      danger: true,
      separated: true,
      onSelect: () => { void handleDelete(d.name); },
    },
  ];

  /** Wipe the detector's outputs — on one song, or on every song. The algorithm
   *  cache and this annotator's annotation files go; the .py source stays. */
  const handleClearOutputs = async (name: string, slug?: string) => {
    const where = slug ? `the song "${selectedSongTitle}"` : 'every song';
    if (!confirm(
      `Clear the outputs of "${name}" on ${where}?\n\n` +
      `This wipes the detector's algorithm cache and your annotation files ` +
      `there. The .py source is kept. Other annotators' work is not touched.\n\n` +
      `This cannot be undone.`
    )) return;
    setBusy((b) => ({ ...b, [name]: 'clear' }));
    try {
      cancelBatchRef.current[name] = true;
      const { annotations_removed } = await deleteDetectorOutputs(name, slug);
      if (slug) {
        setResults((r) => ({ ...r, [name]: { ...(r[name] ?? {}), [slug]: null } }));
        setManualByRun((g) => (g[name] ? { ...g, [name]: withoutKey(g[name], slug) } : g));
      } else {
        setResults((r) => ({ ...r, [name]: Object.fromEntries(songs.map((s) => [s.id, null])) }));
        setManualByRun((g) => { const next = { ...g }; delete next[name]; return next; });
        setBatchByDetector((b) => { const next = { ...b }; delete next[name]; return next; });
      }
      setTopMessage({
        kind: 'info',
        text: `Cleared outputs of "${name}" on ${where} — algorithm cache wiped, ${annotations_removed} annotation file${annotations_removed === 1 ? '' : 's'} removed.`,
      });
    } catch (e) {
      setTopMessage({ kind: 'error', text: `Clear outputs failed: ${(e as Error).message}` });
    } finally {
      setBusy((b) => ({ ...b, [name]: null }));
    }
  };

  /** Every-detector clear: wipe the outputs of all detectors across either the
   *  selected song or every song. Same semantics as handleClearOutputs. */
  const handleBulkClear = async (songScope: 'song' | 'all') => {
    const targets = detectors.filter((d) => !d.archived);
    if (targets.length === 0) {
      setTopMessage({ kind: 'error', text: 'No detectors to clear.' });
      return;
    }
    const perSong = songScope === 'song';
    if (perSong && !selectedSlug) {
      setTopMessage({ kind: 'error', text: 'Select a song first.' });
      return;
    }
    const scopeLabel = `all ${targets.length} detectors`;
    const songLabel = perSong ? `the song "${selectedSongTitle}"` : 'every song';
    if (!confirm(
      `Clear outputs for ${scopeLabel} on ${songLabel}?\n\n` +
      `This wipes the algorithm cache and your annotation files for that scope. ` +
      `The .py source is kept. Other annotators' work is not touched.\n\n` +
      `This cannot be undone.`
    )) return;
    setBulkBusy('clear');
    try {
      let totalAnn = 0;
      for (const d of targets) {
        cancelBatchRef.current[d.name] = true;
        const { annotations_removed } = await deleteDetectorOutputs(d.name, perSong ? selectedSlug : undefined);
        totalAnn += annotations_removed;
        if (perSong) {
          setResults((r) => ({ ...r, [d.name]: { ...(r[d.name] ?? {}), [selectedSlug]: null } }));
          setManualByRun((g) => (g[d.name] ? { ...g, [d.name]: withoutKey(g[d.name], selectedSlug) } : g));
        } else {
          setResults((r) => ({ ...r, [d.name]: Object.fromEntries(songs.map((s) => [s.id, null])) }));
          setManualByRun((g) => { const next = { ...g }; delete next[d.name]; return next; });
          setBatchByDetector((b) => { const next = { ...b }; delete next[d.name]; return next; });
        }
      }
      setTopMessage({
        kind: 'info',
        text: `Cleared outputs for ${scopeLabel} on ${songLabel} — ${totalAnn} annotation file${totalAnn === 1 ? '' : 's'} removed.`,
      });
    } catch (e) {
      setTopMessage({ kind: 'error', text: `Bulk clear failed: ${(e as Error).message}` });
    } finally {
      setBulkBusy(null);
    }
  };

  /** Every-detector run: sweep every runnable detector over either the
   *  selected song or every song, reusing the per-detector run paths. */
  const handleBulkRun = async (songScope: 'song' | 'allSongs') => {
    const targets = detectors.filter((d) => d.status === 'ok' && !d.archived);
    if (targets.length === 0) {
      setTopMessage({ kind: 'error', text: 'No runnable (OK) detectors.' });
      return;
    }
    if (songScope === 'song' && !selectedSlug) {
      setTopMessage({ kind: 'error', text: 'Select a song first.' });
      return;
    }
    if (songScope === 'allSongs' && songs.length === 0) {
      setTopMessage({ kind: 'error', text: 'Song manifest is empty — nothing to run on.' });
      return;
    }
    const scopeLabel = `all ${targets.length} runnable detectors`;
    if (songScope === 'allSongs' && !confirm(
      `Run ${scopeLabel} across all ${songs.length} song${songs.length === 1 ? '' : 's'}?\n\n` +
      `That's ${targets.length * songs.length} run${targets.length * songs.length === 1 ? '' : 's'} — this can take a while.`
    )) return;
    setBulkBusy('run');
    try {
      for (const d of targets) {
        if (songScope === 'song') await handleRun(d.name);
        else await handleRunAll(d.name);
      }
      setTopMessage({
        kind: 'info',
        text: `Finished running ${scopeLabel} on ${songScope === 'song' ? 'the selected song' : `all ${songs.length} songs`}.`,
      });
    } finally {
      setBulkBusy(null);
    }
  };

  /** Write the buffer to its file and re-scan. Returns the registry entry the
   *  save produced (runnable or not), or null when nothing was written. */
  const handleSave = async (): Promise<CustomRegistryEntry | null> => {
    if (!code.trim()) {
      setTopMessage({ kind: 'error', text: 'Editor is empty — nothing to save.' });
      return null;
    }
    const newName = parsedName ?? '';
    if (!newName) {
      setTopMessage({
        kind: 'error',
        text: 'Could not parse `name = "..."` from the code. Add an identity line inside the class.',
      });
      return null;
    }
    if (!NAME_RE_CLIENT.test(newName)) {
      setTopMessage({
        kind: 'error',
        text: `Invalid name "${newName}" — must match ^[a-z][a-z0-9_-]{0,30}$ (lowercase, starts with letter, max 31 chars).`,
      });
      return null;
    }

    // Refuse a rename-by-edit: the user changed the `name` line while editing
    // an existing file. Offer to save it as a copy and leave the old one.
    const originalName = isNew ? '' : selectedName ?? '';
    if (originalName && newName !== originalName) {
      const confirmed = window.confirm(
        `You changed the detector's name from "${originalName}" to "${newName}".\n\n` +
        `I won't rename or delete files for you. I can save this as a NEW detector ` +
        `("${newName}.py"). Your existing "${originalName}.py" will stay where it is — ` +
        `delete it afterwards if you want.\n\n` +
        `Save as new "${newName}.py"?`,
      );
      if (!confirmed) return null;
    }

    setSaving(true);
    try {
      const saved = await uploadDetector(newName, code);
      // A detector run once per stem comes back as its first stem's entry;
      // the editor stays on the file.
      const entry = { ...saved, name: saved.base_name ?? saved.name };
      await refresh();
      try { window.localStorage.removeItem(DRAFT_KEY(originalName)); } catch { /* noop */ }
      ++openTokenRef.current;
      setSelectedName(entry.name);
      setIsNew(false);
      setSavedCode(code);
      writePref(DETECTOR_PREF, entry.name);
      setSavedAt((s) => ({ ...s, [entry.name]: Date.now() }));
      if (entry.status === 'ok') {
        setEditorErrors([]);
        setTopMessage({ kind: 'info', text: `Saved "${entry.name}" — ready to run.` });
      } else {
        // Written, but it doesn't load: the errors go under the editor, which
        // stays on it so the code can be fixed in place.
        setEditorErrors(entry.errors);
        setOutputOpen(true);
        setTopMessage({ kind: 'error', text: `"${entry.name}" failed validation — see Output under the editor.` });
      }
      return entry;
    } catch (e) {
      // Server-side failure (4xx/5xx). Surface as a single error below the editor too.
      setEditorErrors([{ index: null, field: null, value: null, message: (e as Error).message }]);
      setOutputOpen(true);
      setTopMessage({ kind: 'error', text: `Save failed: ${(e as Error).message}` });
      return null;
    } finally {
      setSaving(false);
    }
  };

  /** The name to run: the open detector, saved first when the buffer holds an
   *  edit — a run executes the file, so running unsaved code would run the old
   *  code. Null when it isn't runnable. */
  const saveForRun = async (): Promise<string | null> => {
    if (!dirty && sel) {
      if (sel.status === 'ok') return runName;
      setOutputOpen(true);
      setTopMessage({ kind: 'error', text: `"${sel.name}" doesn't load — fix the errors in Output, then run it.` });
      return null;
    }
    const entry = await handleSave();
    if (!entry || entry.status !== 'ok') return null;
    // The save may have changed which stems it runs on: keep the picked one
    // when it is still declared, else the first.
    const stems = entry.stems && entry.stems.length > 0 ? (entry.stems as string[]) : null;
    return stems ? runNameFor(entry.name, stems.includes(effRunStem ?? '') ? effRunStem : stems[0]) : entry.name;
  };

  const handleRunOnSong = async () => {
    const name = await saveForRun();
    if (name) await handleRun(name);
  };
  const handleRunOnAllSongs = async () => {
    const name = await saveForRun();
    if (name) await handleRunAll(name);
  };

  const revertToSaved = () => {
    if (!confirm('Throw away your unsaved changes and go back to the file on disk?')) return;
    setCode(savedCode);
  };

  // ── Per-song status of the open detector ──
  const batch = runName ? batchByDetector[runName] : undefined;
  const songStatus = useMemo(() => {
    const out: Record<string, SongRunStatus | undefined> = {};
    if (!selectedName || !runName || isNew) return out;
    const kind = sel?.output_kind ?? 'cue';
    const lastSave = savedAt[selectedName] ?? 0;
    songs.forEach((s, i) => {
      if (batch?.running) {
        if (i === batch.current - 1) { out[s.id] = { state: 'running', text: 'running' }; return; }
        if (i >= batch.current) { out[s.id] = { state: 'queued', text: 'queued' }; return; }
      }
      if (busy[runName] === 'run' && s.id === selectedSlug) {
        out[s.id] = { state: 'running', text: 'running' };
        return;
      }
      const r = results[runName]?.[s.id];
      if (r === undefined) {
        out[s.id] = loadingCached === runName ? { state: 'loading', text: '…' } : { state: 'none', text: 'not run' };
      } else if (r === null) {
        out[s.id] = { state: 'none', text: 'not run' };
      } else if ('error' in r) {
        out[s.id] = { state: 'failed', text: 'failed', title: r.error };
      } else if (r.fatal) {
        out[s.id] = { state: 'failed', text: 'failed', title: `${r.fatal.type}: ${r.fatal.message}` };
      } else {
        const ran = Date.parse(r.ran_at);
        const text = countOf(r.items.length, r.output_kind ?? kind);
        out[s.id] = Number.isFinite(ran) && ran < lastSave
          ? { state: 'stale', text, title: `Ran ${new Date(r.ran_at).toLocaleString()} — before your last save. Run it again to see the new code's output.` }
          : { state: 'ok', text, title: `Ran ${new Date(r.ran_at).toLocaleString()}` };
      }
    });
    return out;
  }, [selectedName, runName, isNew, sel, savedAt, songs, batch, busy, selectedSlug, results, loadingCached]);

  const runnable = isNew || (sel != null && (dirty || sel.status === 'ok'));
  const runBusy = !!runName && busy[runName] === 'run';
  const songListed: SidebarSong[] = useMemo(
    () => songs.map((s) => ({ id: s.id, title: s.title ?? s.name ?? s.id })),
    [songs],
  );

  const nameValid = parsedName != null && NAME_RE_CLIENT.test(parsedName);
  // While a detector's source is on its way, the buffer still holds the one
  // before — read from it, the title named the old detector and the banner
  // below claimed a rename nobody made. Name it from the registry until then.
  const opening = loadingSource && !!sel;
  const shownName = opening ? sel.name : parsedName;
  const shownLabel = opening ? sel.label : parsedLabel;
  const nameChangedMidEdit = !opening && !isNew && !!selectedName && !!parsedName && parsedName !== selectedName;
  const missingModule = findMissingModule(editorErrors);
  const outputCount = editorErrors.length + (current && ('error' in current || current.fatal) ? 1 : 0);

  const everyDetectorActions: PlaygroundMenuItem[] = [
    {
      label: `Run every detector on ${selectedSongTitle || 'the song'}`,
      disabled: !!bulkBusy || !selectedSlug,
      onSelect: () => { void handleBulkRun('song'); },
    },
    {
      label: 'Run every detector on all songs…',
      disabled: !!bulkBusy || songs.length === 0,
      onSelect: () => { void handleBulkRun('allSongs'); },
    },
    {
      label: `Clear every detector's outputs on ${selectedSongTitle || 'the song'}…`,
      title: 'Wipe every detector\'s outputs for the selected song only. Keeps the .py sources. Cannot be undone.',
      disabled: !!bulkBusy || !selectedSlug,
      separated: true,
      onSelect: () => { void handleBulkClear('song'); },
    },
    {
      label: 'Clear every detector\'s outputs on every song…',
      title: 'Wipe every detector\'s outputs for every song. Keeps the .py sources. Cannot be undone.',
      disabled: !!bulkBusy,
      danger: true,
      onSelect: () => { void handleBulkClear('all'); },
    },
  ];

  const emptyNote = isNew
    ? 'Save the detector and run it to see its output here.'
    : !sel ? null
    : sel.status !== 'ok' && !dirty ? `"${sel.name}" doesn't load — fix the errors in Output first.`
    : current === undefined && loadingCached === runName ? 'Looking for an earlier run on this song…'
    : current == null ? `${sel.name} hasn't run on this song yet — ▶ Run on ${selectedSongTitle}.`
    : 'error' in current || current.fatal ? 'The last run on this song failed — see Output under the editor.'
    : detectorItemCount(current) === 0 ? 'The last run found nothing on this song.'
    : null;

  return (
    <div
      className="bg-[#0a0b0d] text-slate-200 flex flex-col lg:grid lg:h-[calc(100dvh-var(--tc-header-h,0px))] lg:grid-cols-[var(--rail-w)_minmax(0,1fr)_var(--songs-w)] lg:grid-rows-[minmax(0,1fr)_auto] gap-3 p-3 lg:overflow-hidden"
      style={{
        '--rail-w': railSidebar.collapsed ? '36px' : `${railSidebar.width}px`,
        '--songs-w': songsSidebar.collapsed ? '36px' : `${songsSidebar.width}px`,
      } as CSSProperties}
    >
      {/* ── Left: detectors, by package — resizable and collapsible like Inspect's sidebars ── */}
      <div className="relative lg:row-span-2 lg:col-start-1 lg:row-start-1 flex flex-col min-h-0 max-h-[26rem] lg:max-h-none">
        {railSidebar.collapsed && (
          <CollapsedSidebarRail
            side="left"
            label="Detectors"
            title="Show detectors"
            onExpand={() => railSidebar.setCollapsed(false)}
            className="hidden lg:flex h-full! static! rounded-lg overflow-hidden border border-white/[0.06]"
          />
        )}
        <div className={`flex flex-col flex-1 min-h-0 ${railSidebar.collapsed ? 'lg:hidden' : ''}`}>
        <DetectorRail
          onCollapse={() => railSidebar.setCollapsed(true)}
          detectors={files}
          packages={packages}
          selectedName={selectedName}
          isNew={isNew}
          onSelect={(name) => { void selectDetector(name); }}
          onNew={startNew}
          onInstall={(file) => { void handleInstallPackage(file); }}
          installing={packageBusy === 'install'}
          onReload={() => { void handleReload(); }}
          loading={!registryLoaded || reloading}
          packageBusy={packageBusy}
          onSharePackage={(id) => { void handleSharePackage(id); }}
          onRemovePackage={(id, title) => { void handleRemovePackage(id, title); }}
          onNewPackage={(moveName) => setPackageDialog({ moveName })}
          onEditPackage={(editId) => setPackageDialog({ editId })}
          onMove={handleMove}
          onArchive={handleArchive}
          everyDetectorActions={everyDetectorActions}
          onRename={handleRename}
          onDuplicate={handleDuplicate}
          rowMenuItems={rowMenuItems}
        >
          <RailSection title="Input · what it reads">
            {sel?.stem_parts && Object.keys(sel.stem_parts).length > 1 ? (
              // One lane holding several stems' parts (Pulse) is its own contract.
              <RailFact label="Stems">{Object.keys(sel.stem_parts).join(' · ')}</RailFact>
            ) : (
              <RailFact label="Stems">
                <StemPicker parsed={parsedStem} onChange={(stems) => setCode((c) => setStemInCode(c, stems))} />
              </RailFact>
            )}
            {savedStems && savedStems.length > 1 && (
              <RailFact label="Run on">
                <select
                  value={effRunStem ?? ''}
                  onChange={(e) => setRunStem(e.target.value)}
                  title="Which stem ▶ Run runs. Each stem is its own run, with its own results on every song."
                  className="bg-[#0a0b0d] border border-white/10 rounded px-1 py-0.5 text-[11px] text-slate-200"
                >
                  {savedStems.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </RailFact>
            )}
          </RailSection>
          <RailSection title="Output · what it returns">
            <RailFact label="Kind">
              <select
                value={effOutputKind}
                onChange={(e) => setCode((c) => setStrFlagInCode(c, 'output_kind', e.target.value))}
                title="What kind of timed output detect() returns. Changing it rewrites the output_kind line in the code."
                className="bg-[#0a0b0d] border border-white/10 rounded px-1 py-0.5 text-[11px] text-slate-200"
              >
                {OUTPUT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              {parsedOutputKind == null && <span className="ml-1 text-slate-600">(default)</span>}
            </RailFact>
          </RailSection>
          <RailSection title="Detector">
            {sel && <RailFact label="Version">{sel.version || '0.1'}</RailFact>}
            {sel && (
              <RailFact label="Package">
                {sel.is_default ? (
                  sel.package_title ?? sel.package ?? 'Default'
                ) : (
                  <select
                    value={sel.package ?? ''}
                    onChange={(e) => { void handleMove(sel.name, e.target.value || null); }}
                    title="Which package the file sits in. Choosing another moves it there; its runs and outputs stay with it."
                    aria-label="Move to package"
                    className="max-w-full bg-[#0a0b0d] border border-white/10 rounded px-1 py-0.5 text-[11px] text-slate-200"
                  >
                    <option value="">No package</option>
                    {Object.values(packages).sort((a, b) => a.title.localeCompare(b.title)).map((p) => (
                      <option key={p.id} value={p.id}>{p.title}</option>
                    ))}
                  </select>
                )}
              </RailFact>
            )}
            {isNew && <RailFact label="File">tools/python/custom/{parsedName ?? '…'}.py</RailFact>}
          </RailSection>
          <RailSection title="Flags">
            <div className="flex flex-col gap-1.5">
              <FlagSwitch
                name="is_annotation"
                tip={ANNOTATION_TIP}
                value={effAnnotation}
                defaulted={parsedAnnotation == null}
                onChange={(v) => setCode((c) => setBoolFlagInCode(c, 'is_annotation', v))}
              />
              <FlagSwitch
                name="review"
                tip={REVIEW_TIP}
                value={effReview}
                defaulted={parsedReview == null}
                onChange={(v) => setCode((c) => setBoolFlagInCode(c, 'review', v))}
              />
            </div>
          </RailSection>
          {sel && (
            <RailSection title={`Last run · ${selectedSongTitle || 'song'}`}>
              {currentEnvelope && !currentEnvelope.fatal ? (
                <div className="space-y-1 text-[11px]">
                  <div className="text-slate-200">
                    {countOf(currentEnvelope.stats.accepted, currentEnvelope.output_kind)}
                    {currentEnvelope.stats.rejected > 0 && (
                      <span className="text-amber-300"> · {currentEnvelope.stats.rejected} turned away</span>
                    )}
                  </div>
                  {currentEnvelope.notes && currentEnvelope.notes.length > 0 && (
                    <div className="text-slate-400">{currentEnvelope.notes.length} note{currentEnvelope.notes.length === 1 ? '' : 's'} from the detector</div>
                  )}
                  <div className="text-slate-500">{new Date(currentEnvelope.ran_at).toLocaleString()}</div>
                </div>
              ) : current && ('error' in current || current.fatal) ? (
                <button type="button" onClick={() => setOutputOpen(true)} className="text-[11px] text-rose-300 hover:text-rose-200">
                  Failed — show Output
                </button>
              ) : (
                <p className="text-[11px] text-slate-500">Not run on this song yet.</p>
              )}
            </RailSection>
          )}
        </DetectorRail>
        </div>
        {!railSidebar.collapsed && (
          <div className="hidden lg:block">
            <SidebarResizeHandle sidebar={railSidebar} />
          </div>
        )}
      </div>

      {/* ── Centre: the editor ── */}
      <section
        aria-label="Detector code"
        className={codeFull
          ? 'fixed inset-0 z-[70] flex flex-col min-h-0 min-w-0 bg-[#14171d] overflow-hidden'
          : 'lg:col-start-2 lg:row-start-1 relative flex flex-col min-h-0 min-w-0 rounded-lg border border-white/[0.06] bg-[#14171d]/80 overflow-hidden'}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            void handleSave();
          }
        }}
      >
        <div className={`px-4 pt-3 shrink min-h-0 overflow-y-auto ${codeFull ? 'hidden' : ''}`}>
          <InfoBanner id="custom.v2" title="Playground" accent="amber">
            Write a Python detector that finds moments in a song — beats, drops, section boundaries —
            and see its output under the waveform. Pick a detector on the left, or <strong>+ New</strong> for
            a starter. Pick a song on the right and <strong>▶ Run</strong> it there — it saves first — or{' '}
            <strong>Run all</strong> to sweep every song. The <strong>?</strong> next to Save explains the API.
          </InfoBanner>
        </div>
        <header className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3 pb-1">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-[0.12em] text-slate-500 truncate">
              {shownLabel ?? <span className="italic normal-case tracking-normal text-slate-600">no label — add `label = "..."` to the class</span>}
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h1 className="text-[15px] text-slate-100 font-mono break-all">
                {shownName
                  ? <>{shownName}<span className="text-slate-500">.py</span></>
                  : <span className="italic text-slate-500 text-sm">no name — add `name = "..."` to the class</span>}
              </h1>
              {isNew ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded border uppercase tracking-wider border-amber-700/50 bg-amber-900/30 text-amber-200">New</span>
              ) : sel && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded border uppercase tracking-wider ${STATUS_BADGE[sel.status].className}`}>
                  {STATUS_BADGE[sel.status].label}
                </span>
              )}
              {dirty && !isNew && (
                <span className="text-[11px] text-amber-300" title="The editor holds changes the file doesn't have yet. They are kept in this browser until you save or revert.">● unsaved</span>
              )}
              {sel && <span className="text-[11px] text-slate-600 font-mono truncate" title={sel.file}>{repoPath(sel.file)}</span>}
            </div>
          </div>
          {dirty && !isNew && (
            <button
              type="button"
              onClick={revertToSaved}
              className="h-8 px-3 rounded border border-white/10 text-[12px] text-slate-400 hover:border-white/25 hover:text-slate-200"
              title="Throw away the unsaved edits and go back to the file on disk."
            >
              Revert
            </button>
          )}
          {isNew && (
            <button
              type="button"
              onClick={() => {
                try { window.localStorage.removeItem(DRAFT_KEY('')); } catch { /* noop */ }
                setIsNew(false);
              }}
              className="h-8 px-3 rounded border border-white/10 text-[12px] text-slate-400 hover:border-white/25 hover:text-slate-200"
              title="Throw away this new detector without saving it."
            >
              Discard
            </button>
          )}
          <button
            type="button"
            onClick={() => { void handleSave(); }}
            disabled={saving || loadingSource || (!dirty && !isNew)}
            className="h-8 px-3 rounded border border-white/15 text-[12px] text-slate-100 hover:border-white/30 hover:bg-white/[0.04] disabled:opacity-40 disabled:cursor-not-allowed"
            title="Write the file, re-scan the registry, and report validation errors under the editor (⌘S / Ctrl+S)."
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => setHelpOpen((v) => !v)}
            aria-label={helpOpen ? 'Hide the guide' : 'Show the guide'}
            aria-pressed={helpOpen}
            title="How this works — the detector API, packages, output types"
            className={`h-8 w-8 grid place-items-center rounded border text-[12px] font-semibold transition ${
              helpOpen ? 'border-sky-400/60 bg-sky-500/15 text-sky-300' : 'border-white/10 text-slate-400 hover:border-white/25 hover:text-slate-200'
            }`}
          >
            ?
          </button>
          <button
            type="button"
            onClick={() => setCodeFull((v) => !v)}
            aria-label={codeFull ? 'Exit full view' : 'Full view'}
            aria-pressed={codeFull}
            title={codeFull ? 'Back to the Playground (Esc)' : 'Full view — the code alone, over the whole window'}
            className={`h-8 w-8 grid place-items-center rounded border transition ${
              codeFull ? 'border-amber-400/60 bg-amber-500/15 text-amber-200' : 'border-white/10 text-slate-400 hover:border-white/25 hover:text-slate-200'
            }`}
          >
            <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {codeFull
                ? <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" />
                : <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />}
            </svg>
          </button>
        </header>

        {!opening && parsedName != null && !nameValid && (
          <div className="mx-4 mt-2 text-[11px] px-2 py-1.5 rounded border border-rose-700/40 bg-rose-900/20 text-rose-200">
            "{parsedName}" doesn't match <code>^[a-z][a-z0-9_-]{`{0,30}`}$</code> — lowercase letters/digits/_/-, starts with a letter, max 31 chars.
          </div>
        )}
        {sel?.archived && (
          <div className="mx-4 mt-2 flex items-center gap-3 text-[11px] px-2 py-1.5 rounded border border-white/10 bg-white/[0.03] text-slate-300">
            <span className="flex-1">
              Archived. Its code and outputs are kept, but the Inspect tab doesn't list it,
              “every detector” runs skip it and Share package leaves it out.
            </span>
            <button
              type="button"
              onClick={() => { void handleArchive(sel.name, false); }}
              className="h-6 px-2 rounded border border-white/15 text-slate-200 hover:border-white/30 whitespace-nowrap"
            >
              Restore
            </button>
          </div>
        )}

        {nameChangedMidEdit && (
          <div className="mx-4 mt-2 text-[11px] px-2 py-1.5 rounded border border-amber-700/40 bg-amber-900/20 text-amber-200">
            You changed the name from <code>{selectedName}</code> to <code>{parsedName}</code>. Saving will create <code>{parsedName}.py</code> as a new file — your existing <code>{selectedName}.py</code> will stay. Delete it afterwards if you want.
          </div>
        )}

        {/* The editor keeps a usable height; the Output drawer under it gives
            way first when the column is short. */}
        <div className="flex-1 min-h-[420px] lg:min-h-[140px] relative">
          <div className="absolute inset-x-3 inset-y-3 overflow-hidden rounded-md border border-white/[0.06]">
            <CodeMirror
              value={code}
              onChange={(v) => setCode(v)}
              height="100%"
              className="h-full text-[13px]"
              theme={oneDark}
              extensions={[python()]}
              editable={!loadingSource}
              basicSetup={{
                lineNumbers: true,
                highlightActiveLine: true,
                highlightActiveLineGutter: true,
                foldGutter: true,
                bracketMatching: true,
                closeBrackets: true,
                autocompletion: true,
                indentOnInput: true,
                tabSize: 4,
              }}
            />
          </div>
          {(loadingSource || (!selectedName && !isNew)) && (
            <div className="absolute inset-3 z-10 flex items-center justify-center gap-2 rounded-md bg-[#14171d] text-[12px] text-slate-400" role="status">
              <span className="inline-block w-3 h-3 rounded-full border-[1.5px] border-amber-300/30 border-t-amber-300 animate-spin" aria-hidden />
              {selectedName ? `Opening ${selectedName}.py…` : 'Loading detectors…'}
            </div>
          )}
          {helpOpen && (
            <div className="absolute inset-0 z-20 overflow-y-auto bg-[#0a0b0d]/95 p-4">
              <HelpPanel onClose={() => setHelpOpen(false)} />
            </div>
          )}
        </div>

        {/* ── Output: what saving and running said ── */}
        <div
          ref={setOutputPane}
          className={`relative flex flex-col min-h-0 border-t border-white/[0.06] ${outputOpen && outputPane.height !== null ? 'shrink-0' : 'shrink'}`}
          style={outputOpen && outputPane.height !== null ? { height: outputPane.height } : undefined}
        >
          {outputOpen && <HeightResizeHandle pane={outputPane} />}
          <div className="shrink-0 flex items-center gap-3 px-4 h-8">
            <button
              type="button"
              onClick={() => setOutputOpen((v) => !v)}
              aria-expanded={outputOpen}
              className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400 hover:text-slate-200"
            >
              <span className={`text-[8px] transition-transform ${outputOpen ? 'rotate-90' : ''}`} aria-hidden>▶</span>
              Output
              {outputCount > 0 && (
                <span className="px-1.5 rounded bg-rose-900/50 text-rose-200 normal-case tracking-normal font-normal">{outputCount}</span>
              )}
            </button>
            {topMessage && (
              <span
                role="status"
                title={topMessage.text}
                className={`min-w-0 flex-1 truncate text-[11px] ${topMessage.kind === 'error' ? 'text-rose-300' : 'text-slate-400'}`}
              >
                {topMessage.text}
              </span>
            )}
          </div>
          {outputOpen && (
            <div className={`overflow-y-auto px-4 pb-3 space-y-3 ${outputPane.height === null ? 'min-h-[96px] max-h-[38vh]' : 'flex-1 min-h-0'}`}>
              {editorErrors.length > 0 && (
                <div className="space-y-2">
                  {missingModule && <MissingModulePanel hint={missingModule} onReload={() => { void handleReload(); }} />}
                  <div className="bg-rose-950/30 border border-rose-800/40 rounded p-3 space-y-1">
                    <div className="text-[11px] uppercase tracking-wider text-rose-300/80">
                      {editorErrors.length} validation error{editorErrors.length === 1 ? '' : 's'}
                    </div>
                    <pre className="text-[11px] font-mono text-rose-200 whitespace-pre-wrap leading-snug max-h-56 overflow-auto">
                      {editorErrors.map((e) => fmtError(e)).join('\n')}
                    </pre>
                    <div className="text-[10px] text-rose-300/70 pt-1 border-t border-rose-800/30">
                      Fix the code above and <span className="text-rose-200">Save</span> again.
                    </div>
                  </div>
                </div>
              )}
              {current && 'error' in current && (
                <div className="text-[11px] bg-rose-950/30 border border-rose-800/40 rounded p-2 text-rose-200 font-mono space-y-1">
                  <div className="text-rose-300 text-[10px] uppercase tracking-wider">{selectedSongTitle}</div>
                  <div>run failed: {current.error}</div>
                </div>
              )}
              {currentEnvelope && selectedName && (
                <RunSummary
                  envelope={currentEnvelope}
                  manual={runName ? manualByRun[runName]?.[selectedSlug] : undefined}
                  songTitle={selectedSongTitle}
                  onReload={() => { void handleReload(); }}
                />
              )}
              {batch && (batch.rows.length > 0 || batch.running) && selectedName && (
                <BatchSummary
                  state={batch}
                  activeSlug={selectedSlug}
                  onSelectRow={(row) => pickSong(row.slug)}
                />
              )}
              {demucsJob && demucsJob.slug === selectedSlug && (
                <StemsRunLog
                  job={demucsJob}
                  elapsedSec={stemsElapsedSec}
                  presentStems={presentStems}
                  onCancel={cancelStems}
                  onKill={killStems}
                  onDismiss={dismissStemsError}
                />
              )}
              {editorErrors.length === 0 && !current && !batch && !(demucsJob && demucsJob.slug === selectedSlug) && (
                <p className="text-[11px] text-slate-500">Nothing yet — Save reports validation errors here, and Run the detector's output on the song.</p>
              )}
            </div>
          )}
        </div>
      </section>

      {/* ── Right: the song it runs on — resizable and collapsible like the rail ── */}
      <div className="relative lg:col-start-3 lg:row-start-1 flex flex-col min-h-0 max-h-[30rem] lg:max-h-none">
        {songsSidebar.collapsed && (
          <CollapsedSidebarRail
            side="right"
            label="Songs"
            title="Show songs"
            onExpand={() => songsSidebar.setCollapsed(false)}
            className="hidden lg:flex h-full! static! rounded-lg overflow-hidden border border-white/[0.06]"
          />
        )}
        <div className={`flex flex-col flex-1 min-h-0 ${songsSidebar.collapsed ? 'lg:hidden' : ''}`}>
        <SongsSidebar
          onCollapse={() => songsSidebar.setCollapsed(true)}
          songs={songListed}
          loading={songsLoading}
          error={songsError}
          selectedSlug={selectedSlug}
          onSelect={pickSong}
          status={songStatus}
          runLabel={`${dirty ? 'Save & run' : 'Run'} on ${selectedSongTitle || '…'}`}
          runTitle={dirty
            ? 'Saves the editor to its file, then runs it on the selected song — a run executes the file, not the editor.'
            : 'Run the open detector on the selected song.'}
          onRun={() => { void handleRunOnSong(); }}
          runDisabled={!runnable || !selectedSlug || runBusy || !!batch?.running || saving}
          running={runBusy}
          onRunAll={() => { void handleRunOnAllSongs(); }}
          runAllDisabled={!runnable || songs.length === 0 || runBusy || saving}
          batch={batch?.running ? { current: batch.current, total: batch.total, cancelRequested: batch.cancelRequested } : null}
          onStopAll={() => { if (runName) handleCancelBatch(runName); }}
        >
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Stems</span>
            <span className="min-w-0 flex-1 truncate">
              {!selectedSlug ? (
                <span className="text-slate-500">—</span>
              ) : stemManifestLoading ? (
                <span className="text-slate-500">checking…</span>
              ) : presentStems.length > 0 ? (
                <span className="text-emerald-300" title={`On disk: ${presentStems.join(', ')}`}>
                  ✓ {presentStems.length} ({presentStems.join(', ')})
                </span>
              ) : (
                <span className="text-amber-300" title="No Demucs stems cached for this song yet.">none cached</span>
              )}
            </span>
            <button
              type="button"
              onClick={() => { handleRunStems(); setOutputOpen(true); }}
              disabled={!selectedSlug || !selectedSong?.url || stemsRunning}
              className="shrink-0 px-2 py-1 rounded border border-violet-700/50 bg-violet-900/30 text-violet-200 hover:bg-violet-900/50 disabled:opacity-40 disabled:cursor-not-allowed"
              title={
                // The capability probe can be slow / report a false negative,
                // so (like the inspector) we still let the user click and let
                // the backend be the source of truth — surfacing the hint only
                // as advice when the probe says Demucs is unreachable.
                !capabilities.demucs
                  ? `Demucs may be unavailable — ${GPU_TOOLS_UNAVAILABLE_HINT}`
                  : presentStems.length > 0
                    ? 'Re-run Demucs (overwrites the cached stems for this song).'
                    : 'Run Demucs stem separation for this song — for detectors that read a stem.'
              }
            >
              {stemsRunning
                ? `⏳ ${demucsJob?.progressPct != null ? `${demucsJob.progressPct}%` : '…'}`
                : presentStems.length > 0 ? '↻ Re-run' : '▶ Run stems'}
            </button>
          </div>
        </SongsSidebar>
        </div>
        {!songsSidebar.collapsed && (
          <div className="hidden lg:block">
            <SidebarResizeHandle sidebar={songsSidebar} />
          </div>
        )}
      </div>

      {/* ── Bottom: the song, with the detector's output under it ── */}
      <section
        aria-label="Song"
        ref={setSongPane}
        className={`relative flex flex-col lg:col-start-2 lg:col-span-2 lg:row-start-2 rounded-lg border border-white/[0.05] bg-[#14171d]/60 ${songPane.height === null ? 'lg:max-h-[46vh]' : 'lg:h-[var(--song-h)]'}`}
        style={songPane.height === null ? undefined : { '--song-h': `${songPane.height}px` } as CSSProperties}
      >
        <div className="hidden lg:block">
          <HeightResizeHandle pane={songPane} />
        </div>
        <div className="flex-1 min-h-0 p-2 overflow-y-auto">
        {selectedSong?.url ? (
          <PlaygroundSongView
            song={{ id: selectedSong.id, name: selectedSongTitle, url: selectedSong.url }}
            detector={isNew ? null : sel}
            envelope={currentEnvelope}
            color={(selectedName && colors[selectedName]) || '#fbbf24'}
            emptyNote={emptyNote}
          />
        ) : (
          <p className="px-4 py-6 text-[12px] text-slate-500">
            {songsLoading ? 'Loading songs…' : 'Pick a song on the right to hear it here, with the detector\'s output under it.'}
          </p>
        )}
        </div>
      </section>

      {packageDialog && (
        <PackageDialog
          pkg={packageDialog.editId ? packages[packageDialog.editId] : undefined}
          onSubmit={handleSubmitPackage}
          onClose={() => setPackageDialog(null)}
        />
      )}
    </div>
  );
}

function HelpPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="bg-[#14171d] border border-sky-900/50 rounded p-4 space-y-3 text-[12px] leading-relaxed">
      <div className="flex items-start justify-between">
        <h2 className="text-sm font-medium text-slate-100">How custom detectors work</h2>
        <button
          onClick={onClose}
          className="text-[10px] text-slate-500 hover:text-slate-300 uppercase tracking-wider"
        >
          Close
        </button>
      </div>

      <p className="text-slate-300">
        A custom detector is a single Python file that subclasses{' '}
        <code className="text-slate-100">CustomDetector</code>, sets a few class attributes, and
        implements <code className="text-slate-100">detect(ctx)</code>. The server validates every
        field of every returned item — bad items are dropped with a structured error, good items
        are kept, and exceptions inside <code className="text-slate-100">detect()</code> never
        crash anything.
      </p>

      <div className="grid sm:grid-cols-2 gap-3">
        <section className="bg-[#0a0b0d] border border-white/[0.06] rounded p-3 space-y-1.5">
          <h3 className="text-[11px] uppercase tracking-wider text-slate-500">Two ways to add one</h3>
          <ul className="text-slate-300 list-disc pl-4 space-y-1">
            <li>
              <span className="text-slate-100">Drop a file</span> in{' '}
              <code className="text-slate-200">tools/python/custom/</code> and click{' '}
              <span className="text-slate-100">Reload</span>.
            </li>
            <li>
              <span className="text-slate-100">Upload .py</span> from this page — the server saves
              it to the same folder and validates immediately.
            </li>
          </ul>
        </section>

        <section className="bg-[#0a0b0d] border border-white/[0.06] rounded p-3 space-y-1.5 sm:col-span-2">
          <h3 className="text-[11px] uppercase tracking-wider text-slate-500">Packages — sharing detectors</h3>
          <ul className="text-slate-300 list-disc pl-4 space-y-1">
            <li>
              A <span className="text-slate-100">package</span> is a folder of detectors:{' '}
              <code className="text-slate-200">tools/python/custom/&lt;package&gt;/</code>. Each{' '}
              <code className="text-slate-200">.py</code> directly inside it is one detector; code in its
              subfolders is helper code they import. An optional{' '}
              <code className="text-slate-200">package.json</code> gives it a title, description,
              author and version. This page lists detectors under their package's title.
            </li>
            <li>
              <span className="text-slate-100">Share package</span> downloads the folder as a{' '}
              <code className="text-slate-200">.zip</code>. Send it as is — nothing to encode or build.
            </li>
            <li>
              <span className="text-slate-100">Install package</span> takes that zip and unpacks it into{' '}
              <code className="text-slate-200">tools/python/custom/</code>. Copying or unzipping the
              folder there by hand and clicking <span className="text-slate-100">Reload</span> does the
              same. Installing runs the package's Python on this machine, like any detector — install
              packages from people you trust.
            </li>
          </ul>
        </section>

        <section className="bg-[#0a0b0d] border border-white/[0.06] rounded p-3 space-y-1.5">
          <h3 className="text-[11px] uppercase tracking-wider text-slate-500">Where it shows up</h3>
          <ul className="text-slate-300 list-disc pl-4 space-y-1">
            <li>
              Every detector → a read-only lane in the Inspect tab, listed and run from
              its Detectors sidebar. Copy the lane (⬇) to make it a layer of your own.
            </li>
            <li>
              <span className="text-slate-100">is_annotation = True</span> → a run also makes
              that copy by itself, into the layers of whoever ran it — once; a re-run leaves
              the copy alone.
            </li>
            <li>
              <span className="text-slate-100">review = True</span> → a ✓/✗ on every item in
              the lane.
            </li>
          </ul>
        </section>

        <section className="bg-[#0a0b0d] border border-white/[0.06] rounded p-3 space-y-1.5">
          <h3 className="text-[11px] uppercase tracking-wider text-slate-500">Status badges</h3>
          <ul className="text-slate-300 list-none pl-0 space-y-1">
            <li>
              <span className="inline-block w-20 text-emerald-300">OK</span>{' '}
              file imports clean, manifest valid — runnable.
            </li>
            <li>
              <span className="inline-block w-20 text-amber-300">Validation</span>{' '}
              imported, but a class attribute is wrong (name, label, output_kind, …).
            </li>
            <li>
              <span className="inline-block w-20 text-rose-300">Load</span>{' '}
              the file raised on import (syntax error, missing dep). Errors include line numbers.
            </li>
          </ul>
        </section>

        <section className="bg-[#0a0b0d] border border-white/[0.06] rounded p-3 space-y-1.5">
          <h3 className="text-[11px] uppercase tracking-wider text-slate-500">Output types</h3>
          <ul className="text-slate-300 list-disc pl-4 space-y-1">
            <li>
              <code className="text-slate-100">output_kind = "boundary"</code> →{' '}
              <code className="text-slate-200">Boundary(time_ms, label?, importance?, candidates?)</code>
            </li>
            <li>
              <code className="text-slate-100">output_kind = "cue"</code> →{' '}
              <code className="text-slate-200">Cue(time_ms, label?, description?, intensity?)</code>
            </li>
            <li>
              All times are <span className="text-slate-100">int</span> milliseconds in{' '}
              <span className="text-slate-100">[0, ctx.duration_ms]</span>.
            </li>
          </ul>
        </section>
      </div>

      <div className="bg-[#0a0b0d] border border-white/[0.06] rounded p-3 space-y-1.5">
        <h3 className="text-[11px] uppercase tracking-wider text-slate-500">Read more</h3>
        <ul className="text-slate-300 list-disc pl-4 space-y-1">
          <li>
            <code className="text-slate-100">tools/python/custom/README.md</code> — feature
            overview, file layout, run/verify recipe.
          </li>
          <li>
            <code className="text-slate-100">tools/python/custom/CLAUDE.md</code> — the full
            contract, every input/output bound, two worked examples. Paste this into your
            Claude Code to scaffold a detector.
          </li>
          <li>
            <code className="text-slate-100">tools/python/custom-default/template.py</code> — minimal
            starter to copy. Also registered live as the <code className="text-slate-100">template</code> detector.
          </li>
          <li>
            <code className="text-slate-100">tools/python/custom-default/example_energy.py</code> —
            working RMS-jump boundary detector. Registered live as <code className="text-slate-100">example_energy</code>.
          </li>
        </ul>
      </div>
    </div>
  );
}

/** MIREX-style boundary-detection tolerance. A detection within this window of a
 *  manual section counts as a hit. */
const MANUAL_TOLERANCE_MS = 500;

interface BoundaryComparison {
  /** Indices into `envelope.items` that matched a manual section. */
  hits: Set<number>;
  /** Manual section indices that were NOT matched by any detection. */
  missedManual: number[];
  /** detection index → matched manual index (only entries for hits). */
  matchedToManual: Map<number, number>;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

/** Greedy 1:1 match: each detection consumes at most one manual section (the closest
 *  unmatched one within tolerance), and each manual section can only be claimed once.
 *  Both sides honour `candidates` — any candidate time within tolerance counts. */
function compareWithManual(
  items: CustomBoundaryItem[],
  manual: SectionBlock[],
  toleranceMs: number = MANUAL_TOLERANCE_MS,
): BoundaryComparison {
  const hits = new Set<number>();
  const matchedManual = new Set<number>();
  const matchedToManual = new Map<number, number>();

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const itemTimes = [it.time_ms, ...(it.candidates ?? [])];
    let bestJ = -1;
    let bestDelta = Infinity;
    for (let j = 0; j < manual.length; j++) {
      if (matchedManual.has(j)) continue;
      const g = manual[j];
      const manualTimes = [g.time * 1000, ...((g.candidates ?? []).map((c) => c * 1000))];
      for (const a of itemTimes) {
        for (const b of manualTimes) {
          const d = Math.abs(a - b);
          if (d <= toleranceMs && d < bestDelta) {
            bestDelta = d;
            bestJ = j;
          }
        }
      }
    }
    if (bestJ >= 0) {
      hits.add(i);
      matchedManual.add(bestJ);
      matchedToManual.set(i, bestJ);
    }
  }

  const missedManual: number[] = [];
  for (let j = 0; j < manual.length; j++) if (!matchedManual.has(j)) missedManual.push(j);

  const tp = matchedManual.size;
  const fp = items.length - hits.size;
  const fn = missedManual.length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { hits, missedManual, matchedToManual, tp, fp, fn, precision, recall, f1 };
}

function fmtMs(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Side-by-side timeline of manual sections (top, green/red) vs detector items
 *  (bottom, green/amber). Hover a mark for its time and matched counterpart. */
function ComparisonTimeline({
  envelope,
  manual,
  comparison,
}: {
  envelope: CustomResultEnvelope;
  manual: BoundaryItem[];
  comparison: BoundaryComparison;
}) {
  const duration = envelope.duration_ms;
  if (duration <= 0) return null;

  const pct = (ms: number) => `${Math.max(0, Math.min(100, (ms / duration) * 100))}%`;
  const items = envelope.items as CustomBoundaryItem[];
  const matchedManualSet = new Set(comparison.matchedToManual.values());

  // Invert matchedToManual so a manual-side hover can name its matched detection.
  const manualToMatched = new Map<number, number>();
  comparison.matchedToManual.forEach((j, i) => manualToMatched.set(j, i));

  // Minute gridlines for orientation — every 30s feels right for typical song length.
  const gridStep = 30_000;
  const gridCount = Math.max(0, Math.floor(duration / gridStep));

  return (
    <div className="space-y-1">
      <div className="relative h-10 bg-black/30 rounded border border-white/[0.06] overflow-hidden">
        {/* center axis */}
        <div className="absolute inset-x-0 top-1/2 h-px bg-white/10 -translate-y-1/2" />
        {/* 30s gridlines */}
        {Array.from({ length: gridCount }, (_, k) => (
          <div
            key={`tick-${k}`}
            className="absolute inset-y-0 w-px bg-white/[0.04]"
            style={{ left: pct((k + 1) * gridStep) }}
          />
        ))}
        {/* manual sections — top half */}
        {manual.map((s, j) => {
          const matched = matchedManualSet.has(j);
          const matchedI = manualToMatched.get(j);
          return (
            <div
              key={`g-${j}`}
              className={`absolute top-0.5 h-4 w-[2px] rounded-sm ${
                matched ? 'bg-emerald-400' : 'bg-rose-400'
              }`}
              style={{ left: pct(s.time * 1000) }}
              title={`manual ${j}: ${s.label} @ ${s.time.toFixed(2)}s${
                matched ? ` ✓ matched detection #${matchedI}` : ' ✗ missed'
              }`}
            />
          );
        })}
        {/* detector items — bottom half */}
        {items.map((it, i) => {
          const hit = comparison.hits.has(i);
          const matchedJ = comparison.matchedToManual.get(i);
          return (
            <div
              key={`d-${i}`}
              className={`absolute bottom-0.5 h-4 w-[2px] rounded-sm ${
                hit ? 'bg-emerald-400' : 'bg-amber-400'
              }`}
              style={{ left: pct(it.time_ms) }}
              title={`detection ${i} @ ${(it.time_ms / 1000).toFixed(2)}s${
                hit ? ` ✓ matched manual #${matchedJ}` : ' ◯ extra (no manual within tolerance)'
              }`}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-[9px] text-slate-500 font-mono">
        <span>0:00 · top = manual · bottom = detections</span>
        <span>{fmtMs(duration)}</span>
      </div>
    </div>
  );
}

function RunSummary({
  envelope,
  manual,
  songTitle,
  onReload,
}: {
  envelope: CustomResultEnvelope;
  /** undefined = not loaded yet, null = song has no manual annotation. */
  manual: BoundaryItem[] | undefined;
  /** Human-readable song name. Shown in the header so the user can tell which
   *  song this output belongs to after they've switched the dropdown. */
  songTitle: string;
  onReload?: () => void;
}) {
  if (envelope.fatal) {
    const missing: MissingModuleHint | null = envelope.fatal.missing_module
      ? {
          missing_module:    envelope.fatal.missing_module,
          suggested_package: envelope.fatal.suggested_package ?? envelope.fatal.missing_module,
          suggested_install: envelope.fatal.suggested_install ?? `pip install ${envelope.fatal.missing_module}`,
        }
      : null;
    return (
      <div className="space-y-2">
        {missing && <MissingModulePanel hint={missing} onReload={onReload} />}
        <div className="text-[11px] bg-rose-950/30 border border-rose-800/40 rounded p-2 space-y-1 font-mono">
          <div className="text-rose-300 text-[10px] uppercase tracking-wider">
            {songTitle}
          </div>
          <div className="text-rose-200 font-semibold">
            {envelope.fatal.type}: {envelope.fatal.message}
          </div>
          {envelope.fatal.traceback && (
            <pre className="text-rose-300/80 whitespace-pre-wrap text-[10px] max-h-40 overflow-auto">
              {envelope.fatal.traceback}
            </pre>
          )}
        </div>
      </div>
    );
  }
  const previewItems = envelope.items.slice(0, 5);
  const isBoundary = envelope.output_kind === 'boundary';
  const comparison = isBoundary && manual && manual.length > 0
    ? compareWithManual(envelope.items as CustomBoundaryItem[], manual)
    : null;
  return (
    <div className="text-[11px] space-y-1">
      <div className="text-slate-200 text-[11px] font-medium">
        <span className="text-slate-500 text-[10px] uppercase tracking-wider mr-2">song</span>
        {songTitle}
      </div>
      <div className="flex gap-3 text-slate-400 flex-wrap">
        <span>ran {new Date(envelope.ran_at).toLocaleString()}</span>
        <span>·</span>
        <span className="text-emerald-300">accepted {envelope.stats.accepted}</span>
        {envelope.stats.rejected > 0 && (
          <span className="text-amber-300">rejected {envelope.stats.rejected}</span>
        )}
        {comparison && (
          <>
            <span>·</span>
            <span
              className="text-slate-300"
              title={`vs manual (${manual!.length} sections, ±${MANUAL_TOLERANCE_MS}ms tolerance). Each manual section matches at most one detection; ✓ on a row = matched, ◯ = false positive.`}
            >
              vs manual:{' '}
              <span className="text-slate-100">F1 {comparison.f1.toFixed(2)}</span>
              {' · '}
              <span className="text-slate-400">P {comparison.precision.toFixed(2)} · R {comparison.recall.toFixed(2)}</span>
              {' · '}
              <span className="text-emerald-300">{comparison.tp} hit</span>
              {comparison.fp > 0 && <> · <span className="text-amber-300">{comparison.fp} extra</span></>}
              {comparison.fn > 0 && <> · <span className="text-rose-300">{comparison.fn} missed</span></>}
            </span>
          </>
        )}
        {isBoundary && manual === null && (
          <>
            <span>·</span>
            <span className="text-slate-500 italic">no manual annotation for "{envelope.slug}"</span>
          </>
        )}
        {isBoundary && manual && manual.length === 0 && (
          <>
            <span>·</span>
            <span className="text-slate-500 italic">manual annotation has 0 sections</span>
          </>
        )}
      </div>
      {comparison && manual && (
        <ComparisonTimeline envelope={envelope} manual={manual} comparison={comparison} />
      )}
      {previewItems.length > 0 && (
        <pre className="text-slate-400 font-mono whitespace-pre-wrap text-[10px] bg-black/30 p-2 rounded">
          {previewItems.map((it, i) => {
            const mark = comparison
              ? (comparison.hits.has(i) ? '✓ ' : '◯ ')
              : '';
            return `${mark}${i.toString().padStart(2)}. ${JSON.stringify(it)}`;
          }).join('\n')}
          {envelope.items.length > previewItems.length && `\n… ${envelope.items.length - previewItems.length} more`}
        </pre>
      )}
      {comparison && comparison.missedManual.length > 0 && (
        <details className="text-rose-200">
          <summary className="cursor-pointer">
            {comparison.missedManual.length} manual section{comparison.missedManual.length === 1 ? '' : 's'} missed
          </summary>
          <pre className="font-mono text-[10px] mt-1 max-h-40 overflow-auto bg-black/30 p-2 rounded">
            {comparison.missedManual.map((j) => {
              const s = manual![j];
              const imp = s.importance ? ` · ${s.importance}` : '';
              return `${j.toString().padStart(2)}. ${s.time.toFixed(3)}s — ${s.label}${imp}`;
            }).join('\n')}
          </pre>
        </details>
      )}
      {envelope.errors.length > 0 && (
        <details className="text-amber-200">
          <summary className="cursor-pointer">{envelope.errors.length} item error{envelope.errors.length === 1 ? '' : 's'}</summary>
          <pre className="font-mono text-[10px] mt-1 max-h-40 overflow-auto">
            {envelope.errors.map((e) => fmtError(e)).join('\n')}
          </pre>
        </details>
      )}
    </div>
  );
}

/** Score a single batch row vs. its manual annotation. Null if the song has no
 *  manual or the run errored — the renderer shows "—" for those columns. */
interface BatchRowStats {
  items: number;
  hits: number | null;
  extra: number | null;
  missed: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

function scoreBatchRow(row: BatchRow): BatchRowStats {
  if ('error' in row.envelope) {
    return { items: 0, hits: null, extra: null, missed: null, precision: null, recall: null, f1: null };
  }
  const env = row.envelope;
  const items = env.items.length;
  if (env.fatal || env.output_kind !== 'boundary' || !row.manual || row.manual.length === 0) {
    return { items, hits: null, extra: null, missed: null, precision: null, recall: null, f1: null };
  }
  const cmp = compareWithManual(env.items as CustomBoundaryItem[], row.manual);
  return {
    items,
    hits:      cmp.tp,
    extra:     cmp.fp,
    missed:    cmp.fn,
    precision: cmp.precision,
    recall:    cmp.recall,
    f1:        cmp.f1,
  };
}

function fmtScore(v: number | null): string {
  return v == null ? '—' : v.toFixed(2);
}

/** Per-song batch results: progress bar while running, then a sortable summary
 *  + table. Each row click promotes that song's result into the per-detector
 *  single-song view above. */
function BatchSummary({
  state,
  activeSlug,
  onSelectRow,
}: {
  state: BatchRunState;
  activeSlug: string;
  onSelectRow: (row: BatchRow) => void;
}) {
  const scored = useMemo(() => state.rows.map((r) => ({ row: r, stats: scoreBatchRow(r) })), [state.rows]);
  const withManual = scored.filter((s) => s.stats.f1 != null);
  const meanF1 = withManual.length ? withManual.reduce((acc, s) => acc + (s.stats.f1 ?? 0), 0) / withManual.length : null;
  const meanP  = withManual.length ? withManual.reduce((acc, s) => acc + (s.stats.precision ?? 0), 0) / withManual.length : null;
  const meanR  = withManual.length ? withManual.reduce((acc, s) => acc + (s.stats.recall ?? 0), 0) / withManual.length : null;
  // Sort: rows with manual first by F1 desc, then unmanual/errored at the bottom.
  const sorted = useMemo(() => {
    return [...scored].sort((a, b) => {
      const af = a.stats.f1, bf = b.stats.f1;
      if (af == null && bf == null) return 0;
      if (af == null) return 1;
      if (bf == null) return -1;
      return bf - af;
    });
  }, [scored]);

  const pct = state.total > 0 ? Math.round((state.current / state.total) * 100) : 0;
  const errorCount = state.rows.filter((r) => 'error' in r.envelope || (!('error' in r.envelope) && r.envelope.fatal)).length;
  const noManualCount = state.rows.filter((r) =>
    !('error' in r.envelope) && !r.envelope.fatal && (!r.manual || r.manual.length === 0),
  ).length;

  return (
    <div className="bg-black/30 border border-white/[0.06] rounded p-2.5 space-y-2">
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Run all</span>
          {state.running ? (
            <span className="text-sky-300">
              {state.current}/{state.total} {state.cancelRequested ? '(stopping…)' : '…'}
            </span>
          ) : (
            <span className="text-slate-400">
              {state.rows.length}/{state.total} song{state.total === 1 ? '' : 's'}
              {state.cancelRequested && <span className="text-amber-300"> · stopped</span>}
            </span>
          )}
          {withManual.length > 0 && meanF1 != null && (
            <>
              <span className="text-slate-700">·</span>
              <span
                className="text-slate-300"
                title={`Mean across the ${withManual.length} song${withManual.length === 1 ? '' : 's'} that have manual annotations. Songs without manual are excluded.`}
              >
                mean <span className="text-slate-100">F1 {meanF1.toFixed(2)}</span>
                {' · '}
                <span className="text-slate-400">P {fmtScore(meanP)} · R {fmtScore(meanR)}</span>
              </span>
            </>
          )}
          {noManualCount > 0 && (
            <>
              <span className="text-slate-700">·</span>
              <span className="text-slate-500" title="Songs whose manual annotation is missing or empty — excluded from mean F1/P/R.">
                {noManualCount} no manual
              </span>
            </>
          )}
          {errorCount > 0 && (
            <>
              <span className="text-slate-700">·</span>
              <span className="text-rose-300">{errorCount} error{errorCount === 1 ? '' : 's'}</span>
            </>
          )}
        </div>
      </div>

      {state.running && (
        <div className="h-1 bg-white/[0.05] rounded overflow-hidden">
          <div
            className="h-full bg-sky-500/70 transition-all duration-150"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {sorted.length > 0 && (
        <div className="max-h-72 overflow-auto rounded border border-white/[0.04]">
          <table className="w-full text-[11px] font-mono">
            <thead className="sticky top-0 bg-[#14171d] text-slate-500 text-[10px] uppercase tracking-wider">
              <tr>
                <th className="text-left  px-2 py-1 font-normal">Song</th>
                <th className="text-right px-2 py-1 font-normal" title="Boundaries the detector produced">items</th>
                <th className="text-right px-2 py-1 font-normal" title="True positives: matched a manual section within ±500 ms">hits</th>
                <th className="text-right px-2 py-1 font-normal" title="False positives: detector items with no manual within tolerance">extra</th>
                <th className="text-right px-2 py-1 font-normal" title="Manual sections nothing matched">missed</th>
                <th className="text-right px-2 py-1 font-normal">F1</th>
                <th className="text-right px-2 py-1 font-normal">P</th>
                <th className="text-right px-2 py-1 font-normal">R</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(({ row, stats }) => {
                // Aliased-discriminant narrowing: with `envelope` as a const local,
                // the `'error' in envelope` check propagates type info to both
                // branches via `errored` / `!errored`.
                const envelope = row.envelope;
                const errored = 'error' in envelope;
                const fatal = !errored ? envelope.fatal : null;
                const isActive = row.slug === activeSlug;
                const tip = errored
                  ? `Run failed: ${envelope.error}`
                  : fatal
                    ? `${fatal.type}: ${fatal.message}`
                    : stats.f1 == null
                      ? row.manual == null
                        ? 'No manual annotation for this song.'
                        : 'Manual annotation has 0 sections.'
                      : `Click to load this song's result above.`;
                return (
                  <tr
                    key={row.slug}
                    onClick={() => onSelectRow(row)}
                    title={tip}
                    className={`cursor-pointer border-t border-white/[0.04] hover:bg-white/[0.03] ${
                      isActive ? 'bg-sky-900/20' : ''
                    } ${errored || fatal ? 'text-rose-300' : ''}`}
                  >
                    <td className="px-2 py-1 truncate max-w-[16rem]">
                      <span className={isActive ? 'text-sky-200' : 'text-slate-200'}>{row.title}</span>
                      {(errored || fatal) && <span className="text-rose-300"> · failed</span>}
                      {!errored && !fatal && stats.f1 == null && (
                        <span className="text-slate-500"> · no manual</span>
                      )}
                    </td>
                    <td className="px-2 py-1 text-right text-slate-300">{stats.items}</td>
                    <td className="px-2 py-1 text-right text-emerald-300">{stats.hits ?? '—'}</td>
                    <td className="px-2 py-1 text-right text-amber-300">{stats.extra ?? '—'}</td>
                    <td className="px-2 py-1 text-right text-rose-300">{stats.missed ?? '—'}</td>
                    <td className="px-2 py-1 text-right text-slate-100">{fmtScore(stats.f1)}</td>
                    <td className="px-2 py-1 text-right text-slate-400">{fmtScore(stats.precision)}</td>
                    <td className="px-2 py-1 text-right text-slate-400">{fmtScore(stats.recall)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
