import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  deleteDetector,
  deleteDetectorOutputs,
  listDetectors,
  readDetectorSource,
  reloadDetectors,
  runDetector,
  updateDetectorFlags,
  uploadDetector,
} from '../services/customScripts';
import { loadAnnotation } from '../services/manualAnnotations';
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
  MissingModuleHint,
} from '../types/customScript';
import { isMissingModuleHint } from '../types/customScript';
import type { ManualAnnotation, ManualSection } from '../types/manualAnnotation';
import { InfoBanner } from '../components/InfoBanner';
const STARTER_CODE = `from custom_api import Boundary, CustomDetector, DetectionContext


class MyDetector(CustomDetector):
    # ── Identity (required) ──────────────────────────────────────────────
    # The Playground reads \`name\` and \`label\` from the lines below and shows
    # them as the title / subtitle in the editor — change them right here.
    name = "my_detector"            # ^[a-z][a-z0-9_-]{0,30}$, unique
    label = "My detector"           # 1–80 chars, shown as the human-readable title
    output_kind = "boundary"        # "boundary" or "cue"

    # ── Surfacing (at least one True) ─────────────────────────────────────
    is_algorithm = True             # show as an algorithm row in the inspector
    is_annotation = False           # surface as an editable annotation tab too

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
const OUTPUT_KINDS: readonly CustomOutputKind[] = ['boundary', 'cue', 'span', 'loop', 'pattern', 'lyrics'];

/** Python-side defaults for the must-have flags (custom_api.py CustomDetector).
 *  Used when a flag line is absent from the source so the editor controls match
 *  what the loader would actually read via getattr(). */
const FLAG_DEFAULTS = { is_algorithm: true, is_annotation: false, output_kind: 'boundary' as CustomOutputKind };

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
        <span className="flex-1 text-emerald-200 select-all">{hint.suggested_install}</span>
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

function FlagToggle({
  label, tip, checked, disabled, onChange,
}: {
  label: string;
  tip: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      className={`inline-flex items-center gap-1.5 ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
      title={tip}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-emerald-500 w-3 h-3"
      />
      <span className={checked ? 'text-slate-200' : 'text-slate-500'}>{label}</span>
    </label>
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
  manual: ManualAnnotation | null;
}

interface BatchRunState {
  running: boolean;
  cancelRequested: boolean;
  current: number;        // 1-indexed; 0 before the first song starts
  total: number;
  rows: BatchRow[];
}

export function CustomScriptsPage() {
  const [detectors, setDetectors] = useState<CustomRegistryEntry[]>([]);
  const [songs, setSongs] = useState<ManifestSong[]>([]);
  const [songsLoading, setSongsLoading] = useState(true);
  const [songsError, setSongsError] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string>('');
  const [busy, setBusy] = useState<Record<string, 'run' | 'delete' | 'clear' | 'flag' | null>>({});
  /** Detector scope for the top-level bulk-actions bar. '' = every detector. */
  const [bulkScope, setBulkScope] = useState<string>('');
  /** Non-null while a bulk Run / Clear sweep is in flight — disables the bar. */
  const [bulkBusy, setBulkBusy] = useState<'run' | 'clear' | null>(null);
  /** Last-run envelope per `[detectorName][songSlug]`. Nesting by slug means
   *  switching the song dropdown doesn't wipe earlier runs — each song keeps
   *  its own card so users can compare without re-running. */
  const [results, setResults] = useState<Record<string, Record<string, CustomResultEnvelope | { error: string }>>>({});
  /** Manual annotation snapshot per detector run, keyed `[detectorName][songSlug]`.
   *  Refetched each run so post-edit manual changes show up on the next Run
   *  without a reload. `null` = no manual annotation exists for the song yet. */
  const [manualByRun, setManualByRun] = useState<Record<string, Record<string, ManualAnnotation | null>>>({});
  /** Per-detector "Run all" state — survives single-song Run clicks so users can
   *  iterate on one song without losing the batch overview. */
  const [batchByDetector, setBatchByDetector] = useState<Record<string, BatchRunState>>({});
  /** Cancel flag for an in-flight batch. Lives in a ref so the loop sees writes
   *  without depending on React state propagation between awaits. */
  const cancelBatchRef = useRef<Record<string, boolean>>({});
  const [topMessage, setTopMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadCode, setUploadCode] = useState(STARTER_CODE);
  /** When editing an existing detector, the identity at the time the editor
   *  was opened. Used to detect a `name = "..."` change in the code mid-edit
   *  (which we refuse — the user is asked to save-as-copy instead). Empty for
   *  a brand-new detector. */
   const [uploadOriginalName, setUploadOriginalName] = useState('');
  /** True when the editor was opened by clicking Edit on an existing row.
   *  Used to distinguish "overwrite same file" from "first-time write". */
  const [uploadIsEditing, setUploadIsEditing] = useState(false);
  /** Parsed `name`/`label` from the live editor buffer — re-derived on every
   *  keystroke so the title/subtitle preview stays in sync. */
  const parsedName = useMemo(() => parseClassAttr(uploadCode, 'name'), [uploadCode]);
  const parsedLabel = useMemo(() => parseClassAttr(uploadCode, 'label'), [uploadCode]);
  /** Must-have flags parsed live from the editor buffer. null = no assignment
   *  line yet, so the dedicated controls fall back to the Python-side default
   *  and flag a "(default)" hint. Re-derived on every keystroke / paste, so the
   *  controls always reflect what the loader would read from the source. */
  const parsedAlgorithm = useMemo(() => parseBoolAttr(uploadCode, 'is_algorithm'), [uploadCode]);
  const parsedAnnotation = useMemo(() => parseBoolAttr(uploadCode, 'is_annotation'), [uploadCode]);
  const parsedOutputKind = useMemo(() => parseEnumAttr(uploadCode, 'output_kind', OUTPUT_KINDS), [uploadCode]);
  const effAlgorithm = parsedAlgorithm ?? FLAG_DEFAULTS.is_algorithm;
  const effAnnotation = parsedAnnotation ?? FLAG_DEFAULTS.is_annotation;
  const effOutputKind = parsedOutputKind ?? FLAG_DEFAULTS.output_kind;
  /** At least one surfacing flag must stay on, mirroring the loader's rule. */
  const flagsValid = effAlgorithm || effAnnotation;
  /** Errors from the latest save attempt. Rendered BELOW the editor so the
   *  user can fix the code without losing context. Cleared on successful save. */
  const [uploadErrors, setUploadErrors] = useState<CustomValidationError[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  /** Anchor used to scroll the editor into view when the user opens it from
   *  a row that's currently mid-page — without this the editor pops up above
   *  the click point and looks like nothing happened. */
  const editorRef = useRef<HTMLDivElement | null>(null);

  // ── Demucs stems for the selected song ─────────────────────────────────────
  // Reuses the exact run/poll/cancel/kill flow from the inspector (useDemucsStems)
  // so the Playground can stem a song before running stem-scoped curators. The
  // manifest tells us which stems already exist on disk.
  const { capabilities } = useCapabilities();
  const selectedSong = useMemo(() => songs.find((s) => s.id === selectedSlug) ?? null, [songs, selectedSlug]);
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
    try {
      // Authors must see every detector they wrote, even loop/pattern ones
      // when the user has experimentalLoopsAndPatterns off — otherwise the
      // detector file looks orphaned in the registry view.
      const list = await listDetectors({ includeExperimentalLoopsAndPatterns: true });
      setDetectors(list);
    } catch (e) {
      setTopMessage({ kind: 'error', text: `Failed to load registry: ${(e as Error).message}` });
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Fetch the song list so we can run detectors on a chosen song. Mirrors the
  // logic in InspectorPageV2.fetchManifest — accept both a flat array (current
  // shape) and {songs: [...]} so this keeps working if the format ever flips.
  // Surfacing songsLoading/songsError lets the dropdown explain why it's empty
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
        if (list.length && !selectedSlug) setSelectedSlug(list[0].id);
      } catch (e) {
        if (!cancelled) {
          setSongsError((e as Error).message);
          setSongsLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
    // selectedSlug intentionally excluded — we only auto-pick on first load.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleReload = async () => {
    try {
      const list = await reloadDetectors({ includeExperimentalLoopsAndPatterns: true });
      setDetectors(list);
      setTopMessage({ kind: 'info', text: `Re-scanned tools/python/custom/ — ${list.length} detector${list.length === 1 ? '' : 's'} found.` });
    } catch (e) {
      setTopMessage({ kind: 'error', text: `Reload failed: ${(e as Error).message}` });
    }
  };

  /** Patch the matching slug's row in an existing batch — so a single-song
   *  re-run refreshes a stale "failed" badge instead of leaving it behind. */
  const patchBatchRow = (
    name: string,
    slug: string,
    envelope: CustomResultEnvelope | { error: string },
    manual: ManualAnnotation | null,
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
        loadAnnotation(runSlug),
      ]);
      setResults((r) => ({ ...r, [name]: { ...(r[name] ?? {}), [runSlug]: env } }));
      setManualByRun((g) => ({ ...g, [name]: { ...(g[name] ?? {}), [runSlug]: manual } }));
      patchBatchRow(name, runSlug, env, manual);
      if (env.fatal) {
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
      patchBatchRow(name, runSlug, errEnvelope, null);
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
      try {
        const [env, manual] = await Promise.all([
          runDetector(name, s.id, { force: true }),
          loadAnnotation(s.id),
        ]);
        rows.push({ slug: s.id, title, envelope: env, manual });
      } catch (e) {
        rows.push({ slug: s.id, title, envelope: { error: (e as Error).message }, manual: null });
      }
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

  /** Promote a single song's batch row into the per-detector "current result"
   *  view above, so the user can see the timeline / preview / missed-manual list
   *  for that song without re-running. */
  const handleSelectBatchRow = (name: string, row: BatchRow) => {
    if ('error' in row.envelope) {
      setTopMessage({ kind: 'error', text: `${name} @ ${row.slug}: ${row.envelope.error}` });
      return;
    }
    setSelectedSlug(row.slug);
    setResults((r) => ({ ...r, [name]: { ...(r[name] ?? {}), [row.slug]: row.envelope } }));
    setManualByRun((g) => ({ ...g, [name]: { ...(g[name] ?? {}), [row.slug]: row.manual } }));
  };

  const handleFlagChange = async (
    entry: CustomRegistryEntry,
    next: { is_algorithm: boolean; is_annotation: boolean },
  ) => {
    if (!next.is_algorithm && !next.is_annotation) {
      setTopMessage({
        kind: 'error',
        text: `"${entry.name}": at least one of algorithm / annotation must stay enabled.`,
      });
      return;
    }
    if (next.is_algorithm === entry.is_algorithm && next.is_annotation === entry.is_annotation) return;
    setBusy((b) => ({ ...b, [entry.name]: 'flag' }));
    try {
      const updated = await updateDetectorFlags(entry.name, next);
      setDetectors((list) => list.map((d) => (d.name === updated.name ? updated : d)));
      setTopMessage({
        kind: 'info',
        text: `"${entry.name}" — algorithm=${updated.is_algorithm}, annotation=${updated.is_annotation}`,
      });
    } catch (e) {
      setTopMessage({ kind: 'error', text: `Flag update failed: ${(e as Error).message}` });
    } finally {
      setBusy((b) => ({ ...b, [entry.name]: null }));
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
      await refresh();
      setTopMessage({ kind: 'info', text: message });
    } catch (e) {
      setTopMessage({ kind: 'error', text: `Delete failed: ${(e as Error).message}` });
    } finally {
      setBusy((b) => ({ ...b, [name]: null }));
    }
  };

  const handleClearOutputs = async (name: string) => {
    if (!confirm(
      `Clear ALL outputs of "${name}"?\n\n` +
      `This wipes the detector's algorithm cache and your annotation files ` +
      `for every song. The .py source is kept. Other annotators' work is not touched.\n\n` +
      `This cannot be undone.`
    )) return;
    setBusy((b) => ({ ...b, [name]: 'clear' }));
    try {
      cancelBatchRef.current[name] = true;
      const { annotations_removed } = await deleteDetectorOutputs(name);
      setResults((r) => { const next = { ...r }; delete next[name]; return next; });
      setManualByRun((g) => { const next = { ...g }; delete next[name]; return next; });
      setBatchByDetector((b) => { const next = { ...b }; delete next[name]; return next; });
      setTopMessage({
        kind: 'info',
        text: `Cleared outputs for "${name}" — algorithm cache wiped, ${annotations_removed} annotation file${annotations_removed === 1 ? '' : 's'} removed.`,
      });
    } catch (e) {
      setTopMessage({ kind: 'error', text: `Clear outputs failed: ${(e as Error).message}` });
    } finally {
      setBusy((b) => ({ ...b, [name]: null }));
    }
  };

  /** Detectors targeted by the bulk bar — one when scoped, all otherwise. */
  const bulkTargets = useMemo(
    () => (bulkScope ? detectors.filter((d) => d.name === bulkScope) : detectors),
    [bulkScope, detectors],
  );

  /** Top-level clear: wipe outputs for the scoped detector(s) across either the
   *  selected song or every song. Mirrors handleClearOutputs' semantics
   *  (algorithm cache + this annotator's annotation files; .py source kept). */
  const handleBulkClear = async (songScope: 'song' | 'all') => {
    const targets = bulkTargets;
    if (targets.length === 0) {
      setTopMessage({ kind: 'error', text: 'No detectors to clear.' });
      return;
    }
    const perSong = songScope === 'song';
    if (perSong && !selectedSlug) {
      setTopMessage({ kind: 'error', text: 'Select a song first.' });
      return;
    }
    const selectedSong = songs.find((s) => s.id === selectedSlug);
    const songTitle = selectedSong?.title ?? selectedSong?.name ?? selectedSlug;
    const scopeLabel = bulkScope ? `detector "${bulkScope}"` : `all ${targets.length} detectors`;
    const songLabel = perSong ? `the song "${songTitle}"` : 'every song';
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
          setResults((r) => {
            if (!r[d.name]) return r;
            const { [selectedSlug]: _drop, ...rest } = r[d.name];
            return { ...r, [d.name]: rest };
          });
          setManualByRun((g) => {
            if (!g[d.name]) return g;
            const { [selectedSlug]: _drop, ...rest } = g[d.name];
            return { ...g, [d.name]: rest };
          });
        } else {
          setResults((r) => { const next = { ...r }; delete next[d.name]; return next; });
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

  /** Top-level run: sweep the scoped runnable detector(s) over either the
   *  selected song or every song, reusing the per-detector run paths. */
  const handleBulkRun = async (songScope: 'song' | 'allSongs') => {
    const targets = bulkTargets.filter((d) => d.status === 'ok');
    if (targets.length === 0) {
      setTopMessage({ kind: 'error', text: 'No runnable (OK) detectors in scope.' });
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
    const scopeLabel = bulkScope ? `detector "${bulkScope}"` : `all ${targets.length} runnable detectors`;
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

  const openEditor = (opts: { name?: string; code?: string; errors?: CustomValidationError[]; editing?: boolean } = {}) => {
    const identity = opts.name ?? '';
    setUploadOriginalName(identity);
    // Prefer a previously-autosaved draft over the server source. The
    // localStorage copy is what the user was last typing; falling back to
    // server source on first open or after a successful save covers the
    // "no draft yet" / "draft has been cleared" cases.
    let initial = opts.code ?? STARTER_CODE;
    try {
      const draft = window.localStorage.getItem(DRAFT_KEY(identity));
      if (draft && draft.trim().length > 0) initial = draft;
    } catch {
      // Storage unavailable — use the provided source.
    }
    setUploadCode(initial);
    setUploadErrors(opts.errors ?? []);
    setUploadIsEditing(!!opts.editing);
    setUploadOpen(true);
    // Defer to next paint so the ref is attached.
    requestAnimationFrame(() => {
      editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const closeEditor = () => {
    setUploadOpen(false);
    setUploadOriginalName('');
    setUploadCode(STARTER_CODE);
    setUploadErrors([]);
    setUploadIsEditing(false);
  };

  /** Open the editor pre-filled with an existing detector's source.
   *  Errors from the registry entry are shown below the editor so the user
   *  can fix them in place. */
  const handleEdit = async (entry: CustomRegistryEntry) => {
    const code = await readDetectorSource(entry.name);
    if (code == null) {
      setTopMessage({ kind: 'error', text: `Source for "${entry.name}" not available.` });
      return;
    }
    openEditor({ name: entry.name, code, errors: entry.errors, editing: true });
  };

  /** Persist the editor buffer to localStorage on every keystroke, keyed by
   *  whichever detector is being edited (or `__new__` for a fresh detector).
   *  Restored on reopen below — survives accidental tab closes / refreshes. */
  useEffect(() => {
    if (!uploadOpen) return;
    try {
      window.localStorage.setItem(DRAFT_KEY(uploadOriginalName), uploadCode);
    } catch {
      // Storage quota / privacy mode — autosave is a courtesy, not a contract.
    }
  }, [uploadOpen, uploadOriginalName, uploadCode]);

  const handleUpload = async () => {
    if (!uploadCode.trim()) {
      setTopMessage({ kind: 'error', text: 'Editor is empty — nothing to save.' });
      return;
    }
    const newName = parsedName ?? '';
    if (!newName) {
      setTopMessage({
        kind: 'error',
        text: 'Could not parse `name = "..."` from the code. Add an identity line inside the class.',
      });
      return;
    }
    if (!NAME_RE_CLIENT.test(newName)) {
      setTopMessage({
        kind: 'error',
        text: `Invalid name "${newName}" — must match ^[a-z][a-z0-9_-]{0,30}$ (lowercase, starts with letter, max 31 chars).`,
      });
      return;
    }

    // Surfacing flags: re-validate against the live buffer so a pasted-in code
    // block with both flags off is caught here, not just server-side.
    if (!((parseBoolAttr(uploadCode, 'is_algorithm') ?? FLAG_DEFAULTS.is_algorithm) ||
          (parseBoolAttr(uploadCode, 'is_annotation') ?? FLAG_DEFAULTS.is_annotation))) {
      setTopMessage({
        kind: 'error',
        text: 'At least one of is_algorithm / is_annotation must be on — toggle one in Flags before saving.',
      });
      return;
    }

    // Refuse a rename-by-edit: the user changed the `name` line while editing
    // an existing file. Tell them to save-as-copy and clean up the old one.
    if (uploadIsEditing && uploadOriginalName && newName !== uploadOriginalName) {
      const confirmed = window.confirm(
        `You changed the detector's name from "${uploadOriginalName}" to "${newName}".\n\n` +
        `I won't rename or delete files for you. I can save this as a NEW detector ` +
        `("${newName}.py"). Your existing "${uploadOriginalName}.py" will stay where it is — ` +
        `delete it from the list afterwards if you want.\n\n` +
        `Save as new "${newName}.py"?`,
      );
      if (!confirmed) return;
    }

    try {
      const entry = await uploadDetector(newName, uploadCode);
      await refresh();
      if (entry.status === 'ok') {
        try { window.localStorage.removeItem(DRAFT_KEY(uploadOriginalName)); } catch { /* noop */ }
        closeEditor();
        setTopMessage({ kind: 'info', text: `Saved "${entry.name}" — ready to run.` });
        return;
      }
      // Validation failed: KEEP the editor open, show errors below it.
      setUploadErrors(entry.errors);
      setUploadIsEditing(true); // saving an existing-but-broken file is a re-edit from now on
      setUploadOriginalName(newName);
      setTopMessage({ kind: 'error', text: `"${entry.name}" failed validation — see errors below the editor.` });
      return;
    } catch (e) {
      // Server-side failure (4xx/5xx). Surface as a single error below the editor too.
      setUploadErrors([{ index: null, field: null, value: null, message: (e as Error).message }]);
      setTopMessage({ kind: 'error', text: `Save failed: ${(e as Error).message}` });
    }
  };

  const okCount = useMemo(() => detectors.filter((d) => d.status === 'ok').length, [detectors]);

  return (
    <div className="min-h-screen bg-[#0a0b0d] text-slate-200 px-6 pb-6 pt-3">
      <div className="max-w-5xl mx-auto space-y-6">
        <InfoBanner id="custom.v1" title="Playground" accent="amber">
          Write a Python detector that finds moments in a song — beats, drops, section
          boundaries — and see its output on the waveform. <strong>New detector</strong> opens the
          editor; your code goes in <code>tools/python/custom/</code> and must return a list of
          timed cues (see <strong>How this works</strong> below for the API and a copy-paste
          starter). Save it, pick a song from the dropdown, and hit <strong>Run</strong> to
          execute it on that track — or <strong>Run all</strong> to sweep every song at once.
        </InfoBanner>
        <header className="pb-3 border-b border-white/[0.06]">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-medium text-slate-100">Playground</h1>
            <button
              onClick={() => setHelpOpen((v) => !v)}
              aria-label={helpOpen ? 'Hide the on-page guide' : 'Show the on-page guide'}
              aria-pressed={helpOpen}
              title="How this works — show / hide the on-page guide"
              className={`grid place-items-center w-5 h-5 rounded-full border text-[11px] font-semibold leading-none transition ${
                helpOpen
                  ? 'border-sky-400/60 bg-sky-500/15 text-sky-300'
                  : 'border-white/15 text-slate-400 hover:border-white/30 hover:text-slate-200'
              }`}
            >
              i
            </button>
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {detectors.length} file{detectors.length === 1 ? '' : 's'} in <code>tools/python/custom/</code> · {okCount} runnable
          </p>
        </header>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-[#14171d] border border-white/[0.06] rounded px-3 py-2 text-xs">
          <select
            className="bg-[#0a0b0d] border border-white/10 rounded px-2 py-1.5 text-slate-200 min-w-[12rem]"
            value={selectedSlug}
            onChange={(e) => setSelectedSlug(e.target.value)}
            title={
              songsError
                ? `Manifest load failed: ${songsError}`
                : `Song that the "This song" Run / Clear actions (and per-row Run) act on (${songs.length} available)`
            }
            disabled={songsLoading || songs.length === 0}
          >
            {songsLoading && <option value="">loading songs…</option>}
            {!songsLoading && songsError && <option value="">manifest error: {songsError}</option>}
            {!songsLoading && !songsError && songs.length === 0 && (
              <option value="">no songs in manifest</option>
            )}
            {songs.map((s) => (
              <option key={s.id} value={s.id}>{s.title ?? s.name ?? s.id}</option>
            ))}
          </select>

          {/* ── Demucs stems for the selected song ── */}
          <span className="text-slate-700" aria-hidden>·</span>
          <span className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-slate-500">Stems</span>
            {!selectedSlug ? (
              <span className="text-slate-500">—</span>
            ) : stemManifestLoading ? (
              <span className="text-slate-500">checking…</span>
            ) : presentStems.length > 0 ? (
              <span className="text-emerald-300" title={`On disk: ${presentStems.join(', ')}`}>
                ✓ {presentStems.length} stem{presentStems.length === 1 ? '' : 's'} ({presentStems.join(', ')})
              </span>
            ) : (
              <span className="text-amber-300" title="No Demucs stems cached for this song yet.">
                none cached
              </span>
            )}

            <button
              onClick={handleRunStems}
              disabled={!selectedSlug || !selectedSong?.url || stemsRunning}
              className="px-2 py-1 rounded border border-violet-700/50 bg-violet-900/30 text-violet-200 hover:bg-violet-900/50 disabled:opacity-40 disabled:cursor-not-allowed"
              title={
                // The capability probe can be slow / report a false negative,
                // so (like the inspector) we still let the user click and let
                // the backend be the source of truth — surfacing the hint only
                // as advice when the probe says Demucs is unreachable.
                !capabilities.demucs
                  ? `Demucs may be unavailable — ${GPU_TOOLS_UNAVAILABLE_HINT}`
                  : presentStems.length > 0
                    ? 'Re-run Demucs (overwrites the cached stems for this song).'
                    : 'Run Demucs stem separation for this song.'
              }
            >
              {stemsRunning
                ? `⏳ Stemming${demucsJob?.progressPct != null ? ` ${demucsJob.progressPct}%` : '…'}`
                : presentStems.length > 0 ? '↻ Re-run stems' : '▶ Run stems'}
            </button>
          </span>

          {detectors.length > 0 && (
            <>
              <span className="text-slate-700" aria-hidden>·</span>
              <label className="flex items-center gap-1.5 text-slate-400">
                <span className="text-[10px] uppercase tracking-wider text-slate-500">Bulk scope</span>
                <select
                  className="bg-[#0a0b0d] border border-white/10 rounded px-2 py-1 text-slate-200"
                  value={bulkScope}
                  onChange={(e) => setBulkScope(e.target.value)}
                  disabled={!!bulkBusy}
                  title="Limit the Run / Clear actions below to one detector, or apply them to every detector."
                >
                  <option value="">All detectors</option>
                  {detectors.map((d) => (
                    <option key={d.name} value={d.name}>{d.name}</option>
                  ))}
                </select>
              </label>

              <span className="flex items-center gap-1.5">
                <span className="text-slate-500">Run:</span>
                <button
                  onClick={() => handleBulkRun('song')}
                  disabled={!!bulkBusy || !selectedSlug}
                  className="px-2 py-1 rounded border border-sky-700/50 bg-sky-900/30 text-sky-200 hover:bg-sky-900/50 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Run the scoped detector(s) on the selected song."
                >
                  This song
                </button>
                <button
                  onClick={() => handleBulkRun('allSongs')}
                  disabled={!!bulkBusy || songs.length === 0}
                  className="px-2 py-1 rounded border border-sky-700/50 text-sky-200 hover:bg-sky-900/30 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Run the scoped detector(s) on every song in the manifest."
                >
                  All songs
                </button>
              </span>

              <span className="flex items-center gap-1.5">
                <span className="text-slate-500">Clear outputs:</span>
                <button
                  onClick={() => handleBulkClear('song')}
                  disabled={!!bulkBusy || !selectedSlug}
                  className="px-2 py-1 rounded border border-amber-700/50 text-amber-200 hover:bg-amber-900/30 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Wipe the scoped detector(s) outputs for the selected song only. Keeps the .py source. Cannot be undone."
                >
                  This song
                </button>
                <button
                  onClick={() => handleBulkClear('all')}
                  disabled={!!bulkBusy}
                  className="px-2 py-1 rounded border border-rose-700/50 text-rose-200 hover:bg-rose-900/30 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Wipe the scoped detector(s) outputs for every song. Keeps the .py source. Cannot be undone."
                >
                  All songs
                </button>
              </span>

              {bulkBusy && (
                <span className="text-slate-500">{bulkBusy === 'run' ? 'Running…' : 'Clearing…'}</span>
              )}
            </>
          )}

          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={handleReload}
              className="px-3 py-1.5 rounded border border-white/10 hover:border-white/20 hover:bg-white/[0.03] transition"
              title="Re-scan tools/python/custom/ — pick up file changes without restarting the server"
            >
              Reload
            </button>
            <button
              onClick={() => uploadOpen ? closeEditor() : openEditor()}
              className="px-3 py-1.5 rounded border border-emerald-700/50 bg-emerald-900/30 text-emerald-200 hover:bg-emerald-900/50 transition"
              title="Open the code editor with a starter template, then save it as tools/python/custom/<name>.py"
            >
              {uploadOpen ? 'Close editor' : 'New detector'}
            </button>
          </div>
        </div>

        {/* Demucs stem-separation report — live terminal log + per-stem progress
            for the selected song, modelled on the algorithm-run log panel. */}
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

        {helpOpen && <HelpPanel onClose={() => setHelpOpen(false)} />}

        {topMessage && (
          <div
            role="status"
            className={`text-xs px-3 py-2 rounded border ${
              topMessage.kind === 'error'
                ? 'border-rose-700/50 bg-rose-900/20 text-rose-200'
                : 'border-sky-700/50 bg-sky-900/20 text-sky-200'
            }`}
          >
            {topMessage.text}
          </div>
        )}

        {uploadOpen && (() => {
          const nameValid = parsedName != null && NAME_RE_CLIENT.test(parsedName);
          const nameChangedMidEdit =
            uploadIsEditing && !!uploadOriginalName && !!parsedName && parsedName !== uploadOriginalName;
          return (
          <div ref={editorRef} className="bg-[#14171d] border border-white/[0.08] rounded p-4 space-y-3">
            <div className="flex items-baseline justify-between">
              <div>
                {/* Subtitle: human-readable label parsed from `label = "..."` */}
                <div className="text-[11px] uppercase tracking-wider text-slate-500">
                  {parsedLabel ?? <span className="italic text-slate-600">no label — add `label = "..."` to the class</span>}
                </div>
                {/* Title: filename derived from `name = "..."` */}
                <h2 className="text-base text-slate-100 font-mono">
                  {parsedName
                    ? <>{parsedName}<span className="text-slate-500">.py</span></>
                    : <span className="italic text-slate-500 text-sm">no name — add `name = "..."` to the class</span>}
                </h2>
              </div>
              <span className="text-[10px] text-slate-500 text-right">
                {uploadIsEditing
                  ? <>Editing <code className="text-slate-300">{uploadOriginalName}.py</code></>
                  : 'New detector — will be written to tools/python/custom/'}
                <br />
                <span className="text-slate-600">Autosaved locally on every keystroke.</span>
              </span>
            </div>

            {parsedName != null && !nameValid && (
              <div className="text-[11px] px-2 py-1.5 rounded border border-rose-700/40 bg-rose-900/20 text-rose-200">
                "{parsedName}" doesn't match <code>^[a-z][a-z0-9_-]{`{0,30}`}$</code> — lowercase letters/digits/_/-, starts with a letter, max 31 chars.
              </div>
            )}
            {nameChangedMidEdit && (
              <div className="text-[11px] px-2 py-1.5 rounded border border-amber-700/40 bg-amber-900/20 text-amber-200">
                You changed the name from <code>{uploadOriginalName}</code> to <code>{parsedName}</code>. Saving will create <code>{parsedName}.py</code> as a new file — your existing <code>{uploadOriginalName}.py</code> will stay. Delete it from the list afterwards if you want.
              </div>
            )}

            {/* ── Must-have flags ──────────────────────────────────────────
                Dedicated controls for the flags the loader reads from the
                source. Two-way synced with the code buffer: pasting new code
                updates these instantly (they're derived from `uploadCode`), and
                flipping a control rewrites the matching assignment line. */}
            <div className="flex gap-3">
              <label className="text-[11px] uppercase tracking-wider text-slate-500 w-14 mt-1.5">Flags</label>
              <div className="flex-1 flex flex-wrap items-center gap-x-5 gap-y-2">
                <FlagSwitch
                  name="is_algorithm"
                  tip="Show as a read-only row in the inspector's algorithm picker."
                  value={effAlgorithm}
                  defaulted={parsedAlgorithm == null}
                  onChange={(v) => setUploadCode((c) => setBoolFlagInCode(c, 'is_algorithm', v))}
                />
                <FlagSwitch
                  name="is_annotation"
                  tip="Surface as an editable annotation track in the inspector with ✓/✗/@ review cards."
                  value={effAnnotation}
                  defaulted={parsedAnnotation == null}
                  onChange={(v) => setUploadCode((c) => setBoolFlagInCode(c, 'is_annotation', v))}
                />
                <label
                  className="inline-flex items-center gap-1.5 text-[11px]"
                  title="What kind of timed output detect() returns."
                >
                  <code className="text-slate-400">output_kind</code>
                  <select
                    value={effOutputKind}
                    onChange={(e) => setUploadCode((c) => setStrFlagInCode(c, 'output_kind', e.target.value))}
                    className="bg-[#0a0b0d] border border-white/10 rounded px-1.5 py-0.5 text-slate-200"
                  >
                    {OUTPUT_KINDS.map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                  {parsedOutputKind == null && <span className="text-slate-600">(default)</span>}
                </label>
              </div>
            </div>
            {!flagsValid && (
              <div className="text-[11px] px-2 py-1.5 rounded border border-rose-700/40 bg-rose-900/20 text-rose-200">
                At least one of <code>is_algorithm</code> / <code>is_annotation</code> must be on — otherwise the
                detector won't surface anywhere in the inspector, and Save will be rejected.
              </div>
            )}

            <div className="flex gap-3">
              <label className="text-[11px] uppercase tracking-wider text-slate-500 w-14 mt-2">Code</label>
              <div className="flex-1 border border-white/10 rounded overflow-hidden">
                <CodeMirror
                  value={uploadCode}
                  onChange={(v) => setUploadCode(v)}
                  height="380px"
                  theme={oneDark}
                  extensions={[python()]}
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
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={closeEditor}
                className="px-3 py-1.5 rounded border border-white/10 text-xs hover:bg-white/[0.03]"
              >
                Cancel
              </button>
              <button
                onClick={handleUpload}
                className="px-3 py-1.5 rounded border border-emerald-700/50 bg-emerald-900/30 text-emerald-200 text-xs hover:bg-emerald-900/50"
                title="Writes the file, re-scans the registry, and reports validation errors below the editor."
              >
                Save &amp; validate
              </button>
            </div>

            {uploadErrors.length > 0 && (() => {
              const missing = findMissingModule(uploadErrors);
              return (
                <div className="space-y-2">
                  {missing && <MissingModulePanel hint={missing} />}
                  <div className="bg-rose-950/30 border border-rose-800/40 rounded p-3 space-y-1">
                    <div className="text-[11px] uppercase tracking-wider text-rose-300/80">
                      {uploadErrors.length} validation error{uploadErrors.length === 1 ? '' : 's'}
                    </div>
                    <pre className="text-[11px] font-mono text-rose-200 whitespace-pre-wrap leading-snug max-h-56 overflow-auto">
                      {uploadErrors.map((e) => fmtError(e)).join('\n')}
                    </pre>
                    <div className="text-[10px] text-rose-300/70 pt-1 border-t border-rose-800/30">
                      Edit the code above and click <span className="text-rose-200">Save &amp; validate</span> to try again.
                    </div>
                  </div>
                </div>
              );
            })()}

            <p className="text-[11px] text-slate-500">
              The code must subclass <code className="text-slate-300">CustomDetector</code> and override{' '}
              <code className="text-slate-300">detect()</code>. See the contract at{' '}
              <code className="text-slate-300">tools/python/custom/CLAUDE.md</code>.
            </p>
          </div>
          );
        })()}

        {detectors.length === 0 ? (
          <div className="text-xs text-slate-400 py-8 px-6 border border-dashed border-white/[0.08] rounded space-y-3">
            <div className="text-slate-300 font-medium">No detectors yet — pick one of these to start:</div>
            <ol className="list-decimal pl-5 space-y-1.5 text-slate-400">
              <li>
                <span className="text-slate-300">Drop a file</span> into{' '}
                <code className="text-slate-200">tools/python/custom/</code>, then click{' '}
                <span className="text-slate-300">Reload</span>. Use{' '}
                <code className="text-slate-200">template.py</code> as a starting point.
              </li>
              <li>
                <span className="text-slate-300">Or click "Upload .py"</span> to paste source directly into this page —
                the server writes it to disk and validates immediately.
              </li>
              <li>
                <span className="text-slate-300">Or hand the contract to your Claude Code:</span>{' '}
                point it at <code className="text-slate-200">tools/python/custom/CLAUDE.md</code> and ask it to
                generate a detector. The validator catches anything that drifts from the contract.
              </li>
            </ol>
            <div className="text-[10px] text-slate-500 pt-1 border-t border-white/[0.06]">
              First time? Click <span className="text-slate-300">"How this works"</span> above for a quick tour.
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {detectors.map((d) => {
              const last = results[d.name]?.[selectedSlug];
              const lastManual = manualByRun[d.name]?.[selectedSlug];
              const selectedSong = songs.find((s) => s.id === selectedSlug);
              const selectedSongTitle = selectedSong?.title ?? selectedSong?.name ?? selectedSlug;
              return (
                <div
                  key={d.file}
                  className="bg-[#14171d] border border-white/[0.06] rounded p-3 space-y-2"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded border uppercase tracking-wider ${STATUS_BADGE[d.status].className}`}
                    >
                      {STATUS_BADGE[d.status].label}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <code className="text-sm text-slate-100">{d.name}</code>
                        {d.label && <span className="text-xs text-slate-400">— {d.label}</span>}
                      </div>
                      <div className="text-[11px] text-slate-500 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span>{d.output_kind}</span>
                        <span className="text-slate-700">·</span>
                        <FlagToggle
                          label="algorithm"
                          tip="Show as a read-only row in the inspector's algorithm picker."
                          disabled={d.status !== 'ok' || busy[d.name] === 'flag'}
                          checked={d.is_algorithm}
                          onChange={(next) => handleFlagChange(d, { is_algorithm: next, is_annotation: d.is_annotation })}
                        />
                        <FlagToggle
                          label="annotation"
                          tip="Surface as an editable annotation track in the inspector with ✓/✗/@ review cards."
                          disabled={d.status !== 'ok' || busy[d.name] === 'flag'}
                          checked={d.is_annotation}
                          onChange={(next) => handleFlagChange(d, { is_algorithm: d.is_algorithm, is_annotation: next })}
                        />
                        <span className="text-slate-700">·</span>
                        <span>v{d.version || '0.1'}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <button
                        onClick={() => handleEdit(d)}
                        className="px-2 py-1 rounded border border-white/10 hover:bg-white/[0.04]"
                        title="Open the source in the editor — fix any errors and Save & validate."
                      >
                        Edit
                      </button>
                      <button
                        disabled={d.status !== 'ok' || !selectedSlug || busy[d.name] === 'run' || batchByDetector[d.name]?.running}
                        onClick={() => handleRun(d.name)}
                        className="px-2 py-1 rounded border border-sky-700/50 bg-sky-900/30 text-sky-200 hover:bg-sky-900/50 disabled:opacity-40 disabled:cursor-not-allowed"
                        title="Run on the song chosen in the top dropdown."
                      >
                        {busy[d.name] === 'run' ? 'Running…' : 'Run'}
                      </button>
                      {batchByDetector[d.name]?.running ? (
                        <button
                          onClick={() => handleCancelBatch(d.name)}
                          disabled={batchByDetector[d.name]?.cancelRequested}
                          className="px-2 py-1 rounded border border-amber-700/50 bg-amber-900/30 text-amber-200 hover:bg-amber-900/50 disabled:opacity-40"
                          title="Stop after the current song finishes."
                        >
                          {batchByDetector[d.name]?.cancelRequested ? 'Stopping…' : `Stop (${batchByDetector[d.name]?.current}/${batchByDetector[d.name]?.total})`}
                        </button>
                      ) : (
                        <button
                          disabled={d.status !== 'ok' || songs.length === 0 || busy[d.name] === 'run'}
                          onClick={() => handleRunAll(d.name)}
                          className="px-2 py-1 rounded border border-sky-700/50 text-sky-200 hover:bg-sky-900/30 disabled:opacity-40 disabled:cursor-not-allowed"
                          title={`Re-run on every song in the manifest (${songs.length}). Caches results and reports per-song F1 vs manual.`}
                        >
                          Run all
                        </button>
                      )}
                      <button
                        disabled={busy[d.name] === 'clear' || batchByDetector[d.name]?.running}
                        onClick={() => handleClearOutputs(d.name)}
                        className="px-2 py-1 rounded border border-amber-700/50 text-amber-200 hover:bg-amber-900/30 disabled:opacity-40 disabled:cursor-not-allowed"
                        title="Wipe this detector's algorithm cache and your annotation files for every song. Keeps the .py source. Cannot be undone."
                      >
                        {busy[d.name] === 'clear' ? 'Clearing…' : 'Clear outputs'}
                      </button>
                      <button
                        disabled={busy[d.name] === 'delete'}
                        onClick={() => handleDelete(d.name)}
                        className="px-2 py-1 rounded border border-rose-700/50 text-rose-200 hover:bg-rose-900/30 disabled:opacity-40"
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  {(() => {
                    if (d.errors.length === 0) return null;
                    const missing = findMissingModule(d.errors);
                    return (
                      <div className="space-y-2">
                        {missing && <MissingModulePanel hint={missing} onReload={handleReload} />}
                        <div className="text-[11px] bg-rose-950/30 border border-rose-800/40 rounded p-2 space-y-1 font-mono">
                          {d.errors.map((e, i) => (
                            <div key={i} className="text-rose-200">{fmtError(e)}</div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  {last && 'error' in last && (
                    <div className="text-[11px] bg-rose-950/30 border border-rose-800/40 rounded p-2 text-rose-200 font-mono space-y-1">
                      <div className="text-rose-300 text-[10px] uppercase tracking-wider">
                        {selectedSongTitle}
                      </div>
                      <div>run failed: {last.error}</div>
                    </div>
                  )}

                  {last && !('error' in last) && (
                    <RunSummary
                      envelope={last}
                      manual={lastManual}
                      songTitle={selectedSongTitle}
                      onReload={handleReload}
                    />
                  )}

                  {batchByDetector[d.name] && (batchByDetector[d.name].rows.length > 0 || batchByDetector[d.name].running) && (
                    <BatchSummary
                      state={batchByDetector[d.name]}
                      activeSlug={selectedSlug}
                      onSelectRow={(row) => handleSelectBatchRow(d.name, row)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

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

        <section className="bg-[#0a0b0d] border border-white/[0.06] rounded p-3 space-y-1.5">
          <h3 className="text-[11px] uppercase tracking-wider text-slate-500">Where it shows up</h3>
          <ul className="text-slate-300 list-disc pl-4 space-y-1">
            <li>
              <span className="text-slate-100">is_algorithm = True</span> → read-only row in the
              inspector, alongside MSAF / allin1.
            </li>
            <li>
              <span className="text-slate-100">is_annotation = True</span> → editable tab next to
              Manual / Eye / Auto-guess (reuses the manual editor for boundaries).
            </li>
            <li>Both can be true on the same detector.</li>
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
            <code className="text-slate-100">tools/python/custom/template.py</code> — minimal
            starter to copy. Also registered live as the <code className="text-slate-100">template</code> detector.
          </li>
          <li>
            <code className="text-slate-100">tools/python/custom/example_energy.py</code> —
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
  manual: ManualSection[],
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
  manual: ManualAnnotation;
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
        {manual.sections.map((s, j) => {
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
  manual: ManualAnnotation | null | undefined;
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
  const comparison = isBoundary && manual && manual.sections.length > 0
    ? compareWithManual(envelope.items as CustomBoundaryItem[], manual.sections)
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
              title={`vs manual (${manual!.sections.length} sections, ±${MANUAL_TOLERANCE_MS}ms tolerance). Each manual section matches at most one detection; ✓ on a row = matched, ◯ = false positive.`}
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
        {isBoundary && manual && manual.sections.length === 0 && (
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
              const s = manual!.sections[j];
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
  if (env.fatal || env.output_kind !== 'boundary' || !row.manual || row.manual.sections.length === 0) {
    return { items, hits: null, extra: null, missed: null, precision: null, recall: null, f1: null };
  }
  const cmp = compareWithManual(env.items as CustomBoundaryItem[], row.manual.sections);
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
    !('error' in r.envelope) && !r.envelope.fatal && (!r.manual || r.manual.sections.length === 0),
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
