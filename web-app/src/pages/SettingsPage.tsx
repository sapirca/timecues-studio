import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAnnotator } from '../context/AnnotatorContext';
import {
  useSettings,
  DEFAULT_SETTINGS,
  type TimeUnit,
  type Theme,
  type ManualBoundariesDefault,
  type ManualBoundariesPresetKey,
} from '../context/SettingsContext';
import {
  PRESETS as MANUAL_BOUNDARY_PRESETS,
  parseCustomLayout,
} from '../components/inspector-v2/FillDefaultsModal';
import {
  GENRE_PRESETS,
  unionVocabulary,
  type GenrePresetKey,
} from '../components/inspector-v2/genrePresets';
import { sectionColor, sectionLabel } from '../components/inspector-v2/sectionConstants';
import type { Annotator } from '../types/annotator';
import type { AutoGuessCentroidMethod } from '../types/manualAnnotation';
import { BAND_PALETTES, type BandPaletteId } from '../utils/bandPalettes';
import {
  clearAllCaches,
  deleteAllSongs,
  deleteDataset,
  factoryReset,
  fetchStorageStats,
  formatBytes,
  type StorageStatsResponse,
} from '../services/storageStats';
import { DeleteConfirmDialog } from '../components/DeleteConfirmDialog';
import { AppPageHeader } from '../components/AppPageHeader';
import { ExperimentalModelsPanel } from '../components/ExperimentalModelsPanel';
import { InfoBanner, resetAllInfoBanners } from '../components/InfoBanner';
import { useCapabilities } from '../hooks/useCapabilities';
import type { Capabilities } from '../services/capabilities';
import { useAdmin } from '../hooks/useAdmin';
import { useExperimentalAvailability } from '../hooks/useExperimentalAvailability';
import { loadDatasetConfig, saveDatasetConfig } from '../services/datasetConfig';
import {
  DEFAULT_DATASET_CONFIG,
  type AccessTier,
  type DatasetConfig,
} from '../types/datasetConfig';

const ALL_BPM_DETECTORS = [
  'librosa-beat-track',
  'librosa-tempo-static',
  'librosa-tempo-dynamic',
  'madmom-rnn-beats',
  'madmom-tempo',
] as const;

const ALL_ALGORITHMS = [
  { id: 'allin1',      label: 'all-in-one (ensemble)' },
  { id: 'msaf-sf',     label: 'MSAF · sf' },
  { id: 'msaf-foote',  label: 'MSAF · foote' },
  { id: 'msaf-cnmf',   label: 'MSAF · cnmf' },
  { id: 'msaf-olda',   label: 'MSAF · olda' },
  { id: 'msaf-scluster', label: 'MSAF · scluster' },
  { id: 'msaf-vmo',    label: 'MSAF · vmo' },
] as const;

const CENTROID_METHODS: { id: AutoGuessCentroidMethod; label: string; hint: string }[] = [
  { id: 'mean',    label: 'Mean',      hint: 'Average of clustered times' },
  { id: 'eqgroup', label: 'Equal grp', hint: 'One vote per detector group' },
  { id: 'metamed', label: 'Meta-median', hint: 'Median of detector medians' },
  { id: 'plural',  label: 'Plurality', hint: 'Most-common label in cluster' },
  { id: 'nearraw', label: 'Nearest raw', hint: 'Closest single raw point' },
];

// Case-insensitive, order-sensitive comparison — matches how vocabularies are
// normalized when parsed from the textarea (lowercased + de-duplicated).
function vocabsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].toLowerCase() !== b[i].toLowerCase()) return false;
  }
  return true;
}

function parseVocabulary(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\n,]/)) {
    const v = part.trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

export function SettingsPage() {
  const navigate = useNavigate();
  const { annotator, signIn } = useAnnotator();
  const { settings, update, reset } = useSettings();
  const { capabilities: gpuCaps, loading: gpuLoading, refresh: refreshGpu } = useCapabilities();
  const { status: adminStatus, refresh: refreshAdmin } = useAdmin();
  const isAdmin = adminStatus?.isAdmin ?? false;
  const expAvail = useExperimentalAvailability();

  // Dataset config — read so non-admins can see whether they're overriding an
  // admin recommendation, and so admins can edit the corpus-wide defaults.
  const [datasetCfg, setDatasetCfg] = useState<DatasetConfig | null>(null);
  const refreshDatasetCfg = useCallback(async () => {
    setDatasetCfg(await loadDatasetConfig());
  }, []);
  useEffect(() => { void refreshDatasetCfg(); }, [refreshDatasetCfg]);

  const [adminDraftEmail, setAdminDraftEmail] = useState('');
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);

  // Editable corpus name. Draft tracks the input; we sync it whenever the
  // server-side config changes (e.g. another admin renamed it in parallel).
  const [corpusNameDraft, setCorpusNameDraft] = useState('');
  useEffect(() => {
    setCorpusNameDraft(datasetCfg?.corpusName ?? '');
  }, [datasetCfg?.corpusName]);

  const updateDatasetCfg = async (patch: Partial<DatasetConfig>) => {
    setAdminBusy(true);
    setAdminError(null);
    try {
      const cfg = { ...DEFAULT_DATASET_CONFIG, ...(await loadDatasetConfig()) };
      await saveDatasetConfig({ ...cfg, ...patch });
      await refreshAdmin();
      await refreshDatasetCfg();
    } catch (e: unknown) {
      setAdminError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdminBusy(false);
    }
  };

  const updateAdminEmails = (next: string[]) =>
    updateDatasetCfg({ adminEmails: next.length > 0 ? next : undefined });

  const trimmedCorpusName = corpusNameDraft.trim();
  const corpusNameDirty = trimmedCorpusName !== (datasetCfg?.corpusName ?? '');
  const saveCorpusName = async () => {
    setAdminBusy(true);
    setAdminError(null);
    try {
      // Empty input clears the field → falls back to "TimeCues Studio" everywhere.
      const cfg = { ...DEFAULT_DATASET_CONFIG, ...(await loadDatasetConfig()) };
      await saveDatasetConfig({ ...cfg, corpusName: trimmedCorpusName || undefined });
      // Force a hard reload so the landing card title, workspace header chip,
      // and browser tab title — all of which read corpusName on mount only —
      // pick up the new value immediately instead of on the next manual nav.
      window.location.reload();
    } catch (e: unknown) {
      setAdminError(e instanceof Error ? e.message : String(e));
      setAdminBusy(false);
    }
  };

  // Profile draft state — saved only when user clicks "Save profile"
  const [profileDraft, setProfileDraft] = useState<Annotator | null>(annotator);
  const [profileSaved, setProfileSaved] = useState(false);
  useEffect(() => { setProfileDraft(annotator); }, [annotator]);

  const [sectionVocabularyDraft, setSectionVocabularyDraft] = useState(settings.sectionTypeVocabulary.join(', '));
  useEffect(() => {
    setSectionVocabularyDraft(settings.sectionTypeVocabulary.join(', '));
  }, [settings.sectionTypeVocabulary]);

  // Drafts for the "Annotation defaults" section. Inputs hold strings
  // so the user can type freely; we commit normalized values on blur / Apply.
  const [manualCustomDraft, setManualCustomDraft] = useState(settings.manualBoundariesCustomLayout);
  useEffect(() => { setManualCustomDraft(settings.manualBoundariesCustomLayout); }, [settings.manualBoundariesCustomLayout]);
  const manualCustomParsed = parseCustomLayout(manualCustomDraft);

  // When true, the Fill-default picker bypasses the vocabulary filter and
  // lists every genre preset — lets the user pick any preset as the default
  // even if its genre isn't in their current Section vocabulary (badged
  // "not in vocab"). Local-only, resets on page leave.
  const [showAllFillDefaultPresets, setShowAllFillDefaultPresets] = useState(false);

  const [cueTaxonomyDraft, setCueTaxonomyDraft] = useState(settings.cueTaxonomy.join(', '));
  useEffect(() => { setCueTaxonomyDraft(settings.cueTaxonomy.join(', ')); }, [settings.cueTaxonomy]);
  const [spanTaxonomyDraft, setSpanTaxonomyDraft] = useState(settings.spanTaxonomy.join(', '));
  useEffect(() => { setSpanTaxonomyDraft(settings.spanTaxonomy.join(', ')); }, [settings.spanTaxonomy]);

  // Cache stats
  const [stats, setStats] = useState<StorageStatsResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  // Which corpus-wide destructive action is currently confirming. Drives the
  // shared DeleteConfirmDialog at the bottom of the page; null means closed.
  const [dangerPending, setDangerPending] = useState<'songs' | 'workspace' | 'factory' | null>(null);
  const refreshStats = async () => {
    setStatsLoading(true);
    setStats(await fetchStorageStats());
    setStatsLoading(false);
  };
  useEffect(() => { refreshStats(); }, []);

  const toggleAlgo = (id: string) => {
    const next = new Set(settings.defaultAlgorithms);
    if (next.has(id)) next.delete(id); else next.add(id);
    update('defaultAlgorithms', Array.from(next));
  };

  const toggleBpmDetector = (id: string) => {
    const current = settings.enabledBpmDetectors.length === 0
      ? new Set(ALL_BPM_DETECTORS)
      : new Set(settings.enabledBpmDetectors);
    if (current.has(id)) current.delete(id); else current.add(id);
    // If user re-enables all, store as empty (== "show all").
    const next = current.size === ALL_BPM_DETECTORS.length ? [] : Array.from(current);
    update('enabledBpmDetectors', next);
  };

  const bpmEnabled = (id: string) =>
    settings.enabledBpmDetectors.length === 0 || settings.enabledBpmDetectors.includes(id);

  const parsedSectionVocabulary = sectionVocabularyDraft
    .split(/[\n,]/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);

  const normalizedCurrentVocabulary = Array.from(new Set(parsedSectionVocabulary));

  /** True when the user is in "custom" vocabulary mode (no genre selection). */
  const inCustomVocabMode = settings.sectionVocabularyGenres === null;
  // Stable reference for downstream useMemo deps — `??` would build a new
  // empty array on each render and re-fire dependents pointlessly.
  const selectedGenres = useMemo<GenrePresetKey[]>(
    () => settings.sectionVocabularyGenres ?? [],
    [settings.sectionVocabularyGenres],
  );
  const isGenreSelected = (key: GenrePresetKey) => selectedGenres.includes(key);

  /** Toggle a genre on/off in the multi-select. Recomputes the effective vocabulary
   *  union and writes both fields. Deselecting the last genre switches to custom
   *  mode with the prior vocab preserved as the editable draft, so the user never
   *  ends up in an ambiguous "no card selected, where's my vocab from?" state. */
  const toggleVocabGenre = (key: GenrePresetKey) => {
    const next = isGenreSelected(key)
      ? selectedGenres.filter((k) => k !== key)
      : [...selectedGenres, key];
    if (next.length === 0) {
      // Last genre deselected → drop into custom mode, freeze prior vocab.
      update('sectionVocabularyGenres', null);
      return;
    }
    const vocab = unionVocabulary(next);
    update('sectionVocabularyGenres', next);
    update('sectionTypeVocabulary', vocab);
  };

  /** Click the Custom card: enter custom mode with the current vocab as the draft. */
  const enterCustomVocabMode = () => {
    update('sectionVocabularyGenres', null);
    setSectionVocabularyDraft(settings.sectionTypeVocabulary.join(', '));
  };

  const applySectionVocabulary = () => {
    const next = normalizedCurrentVocabulary.length > 0
      ? normalizedCurrentVocabulary
      : [...DEFAULT_SETTINGS.sectionTypeVocabulary];
    update('sectionTypeVocabulary', next);
    update('sectionVocabularyGenres', null);
  };

  // ── Fill-default layout — filtered by current vocabulary genres ─────────
  // The Fill-default picker shows only layout presets whose genre is among
  // the user's currently selected vocab genres, plus the current selection
  // (badged "not in vocab" when it falls outside the filter). In Custom
  // vocab mode, the picker collapses to just the Custom layout.
  const visibleFillDefaultKeys = useMemo<ManualBoundariesPresetKey[]>(() => {
    const allKeys = Object.keys(MANUAL_BOUNDARY_PRESETS) as ManualBoundariesPresetKey[];
    if (showAllFillDefaultPresets) return allKeys;
    if (inCustomVocabMode) return [];
    const set = new Set<ManualBoundariesPresetKey>();
    for (const g of selectedGenres) set.add(g as unknown as ManualBoundariesPresetKey);
    const current = settings.manualBoundariesDefault;
    if (current !== 'custom') set.add(current as ManualBoundariesPresetKey);
    return allKeys.filter((k) => set.has(k));
  }, [showAllFillDefaultPresets, inCustomVocabMode, selectedGenres, settings.manualBoundariesDefault]);

  const fillDefaultOutOfVocab = useMemo(() => {
    const current = settings.manualBoundariesDefault;
    if (current === 'custom') return false;
    if (inCustomVocabMode) return true;
    return !selectedGenres.includes(current as unknown as GenrePresetKey);
  }, [settings.manualBoundariesDefault, inCustomVocabMode, selectedGenres]);

  const fillDefaultSummary = useMemo<{
    title: string;
    meta: string;
    chips: { type: string; bars?: number }[];
  }>(() => {
    if (settings.manualBoundariesDefault === 'custom') {
      const layout = manualCustomParsed.layout;
      const totalBars = layout.reduce((a, b) => a + b.bars, 0);
      return {
        title: 'Custom layout',
        meta: layout.length === 0
          ? 'no sections yet'
          : `${totalBars} bars · ${layout.length} sections`,
        chips: layout,
      };
    }
    const preset = MANUAL_BOUNDARY_PRESETS[settings.manualBoundariesDefault as ManualBoundariesPresetKey];
    const totalBars = preset.layout.reduce((a, b) => a + b.bars, 0);
    return {
      title: preset.name,
      meta: `${totalBars} bars · ${preset.layout.length} sections`,
      chips: preset.layout.map((entry) => ({ type: entry.type, bars: entry.bars })),
    };
  }, [settings.manualBoundariesDefault, manualCustomParsed.layout]);

  // ── Override detection vs. admin-set dataset defaults ───────────────────
  // Each flag is true only when the admin has actually set a corpus-wide
  // recommendation AND the annotator's local value diverges. No badge is
  // shown when there's no dataset recommendation to compare against.
  const sectionVocabAdminDefault = datasetCfg?.sectionTypeVocabularyDefault;
  const sectionVocabOverride = useMemo(() =>
    !!sectionVocabAdminDefault && !vocabsEqual(settings.sectionTypeVocabulary, sectionVocabAdminDefault),
    [settings.sectionTypeVocabulary, sectionVocabAdminDefault],
  );

  const cueAdminDefault = datasetCfg?.cueTaxonomyDefault;
  const cueAdminEnabledDefault = datasetCfg?.cueTaxonomyEnabledDefault;
  const cueOverride = useMemo(() => {
    if (cueAdminDefault === undefined && cueAdminEnabledDefault === undefined) return false;
    if (cueAdminEnabledDefault !== undefined && settings.cueTaxonomyEnabled !== cueAdminEnabledDefault) return true;
    if (cueAdminDefault && !vocabsEqual(settings.cueTaxonomy, cueAdminDefault)) return true;
    return false;
  }, [settings.cueTaxonomy, settings.cueTaxonomyEnabled, cueAdminDefault, cueAdminEnabledDefault]);

  const spanAdminDefault = datasetCfg?.spanTaxonomyDefault;
  const spanAdminEnabledDefault = datasetCfg?.spanTaxonomyEnabledDefault;
  const spanOverride = useMemo(() => {
    if (spanAdminDefault === undefined && spanAdminEnabledDefault === undefined) return false;
    if (spanAdminEnabledDefault !== undefined && settings.spanTaxonomyEnabled !== spanAdminEnabledDefault) return true;
    if (spanAdminDefault && !vocabsEqual(settings.spanTaxonomy, spanAdminDefault)) return true;
    return false;
  }, [settings.spanTaxonomy, settings.spanTaxonomyEnabled, spanAdminDefault, spanAdminEnabledDefault]);

  const resetSectionVocabToDataset = () => {
    if (sectionVocabAdminDefault) update('sectionTypeVocabulary', [...sectionVocabAdminDefault]);
  };
  const resetCueTaxonomyToDataset = () => {
    if (cueAdminEnabledDefault !== undefined) update('cueTaxonomyEnabled', cueAdminEnabledDefault);
    if (cueAdminDefault) update('cueTaxonomy', [...cueAdminDefault]);
  };
  const resetSpanTaxonomyToDataset = () => {
    if (spanAdminEnabledDefault !== undefined) update('spanTaxonomyEnabled', spanAdminEnabledDefault);
    if (spanAdminDefault) update('spanTaxonomy', [...spanAdminDefault]);
  };

  // ── Tier resolution + capability bullets ───────────────────────────────
  // The banner label uses the server-resolved tier (`callerTier` on the
  // dataset config, or `adminStatus.tier`), and `isAdmin` (from useAdmin)
  // gates actions. Resolving client-side via `tierForAnnotator` no longer
  // works for non-admins because `peopleByEmail` isn't sent to them — the
  // whitelist is server-only now.
  const effectiveTier: TierKey = useMemo(() => {
    if (!annotator) return 'public';
    return adminStatus?.tier ?? datasetCfg?.callerTier ?? 'public';
  }, [annotator, adminStatus, datasetCfg]);
  const canResearch = effectiveTier === 'admin' || effectiveTier === 'researcher';
  const canAdmin = isAdmin;

  const handleResetAllSettings = () => {
    if (confirm('Reset all settings to defaults?')) reset();
  };
  const handleResetLocalStorage = () => {
    if (!confirm('Reset all local browser state? You will be signed out and all UI preferences cleared.')) return;
    localStorage.clear();
    location.href = '/';
  };
  const handleResetBanners = () => {
    if (!confirm('Reset all dismissed info banners? They will reappear next time you visit those pages.')) return;
    resetAllInfoBanners();
  };
  const handleClearCaches = async () => {
    if (!confirm('Clear ALL caches (stems, analysis, MSAF raw, BPM, algo clusters, MIR features, custom-script results)?\n\nAnnotations and audio files are NOT affected.')) return;
    setClearing(true);
    try {
      await clearAllCaches();
    } catch (err) {
      alert(`Clear caches failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
    await refreshStats();
    setClearing(false);
  };

  // After a workspace/factory wipe the current admin loses their tier (the
  // dataset-config that named them as admin is gone). Bounce to the landing
  // page so the next interaction re-bootstraps cleanly.
  const runDanger = async (kind: 'songs' | 'workspace' | 'factory') => {
    try {
      if (kind === 'songs') {
        await deleteAllSongs('everything');
        await refreshStats();
      } else if (kind === 'workspace') {
        await deleteDataset();
        navigate('/');
      } else {
        await factoryReset();
        navigate('/');
      }
    } catch (err) {
      alert(`${kind} delete failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0b0d] text-slate-200">
      <AppPageHeader back={{}} />
      <div className="max-w-3xl mx-auto space-y-8 p-6">
        <InfoBanner id="settings.v1" title="Settings" accent="slate">
          Expand a section to edit. <strong>Personal</strong> changes save locally; <strong>Corpus</strong> changes apply to everyone.
        </InfoBanner>
        <header className="border-b border-white/[0.06] pb-3">
          <h1 className="text-lg font-medium text-slate-100">Settings</h1>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Personal preferences are stored locally in this browser. Corpus sections write to{' '}
            <code>data/dataset-config.json</code> and apply to every annotator.
          </p>
        </header>

        <RoleBanner tier={effectiveTier} signedIn={!!annotator} />

        {/* ════════════════════════════════════════════════════════════════ */}
        {/* CATEGORY 1 — User info                                          */}
        {/* ════════════════════════════════════════════════════════════════ */}
        <Group
          icon="user"
          title="User info"
          subtitle="Who you are and how the app looks for you. Stored only in this browser."
          accent="cyan"
        >
          <Section title="Annotator profile" hint="Identifies the annotations you save on disk." defaultOpen>
            {!profileDraft && <p className="text-xs text-slate-500">Not signed in.</p>}
            {profileDraft && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Display name">
                  <input
                    value={profileDraft.displayName}
                    onChange={(e) => setProfileDraft({ ...profileDraft, displayName: e.target.value })}
                    className="bg-[#14171d] border border-white/10 rounded px-2 py-1.5 text-sm w-full"
                  />
                </Field>
                <Field label="Email">
                  <input
                    value={profileDraft.email ?? ''}
                    onChange={(e) => setProfileDraft({ ...profileDraft, email: e.target.value || undefined })}
                    className="bg-[#14171d] border border-white/10 rounded px-2 py-1.5 text-sm w-full"
                  />
                </Field>
                <Field label="Role">
                  <input
                    value={profileDraft.role ?? ''}
                    onChange={(e) => setProfileDraft({ ...profileDraft, role: e.target.value || undefined })}
                    placeholder="e.g. Researcher"
                    className="bg-[#14171d] border border-white/10 rounded px-2 py-1.5 text-sm w-full"
                  />
                </Field>
                <Field label="Affiliation">
                  <input
                    value={profileDraft.affiliation ?? ''}
                    onChange={(e) => setProfileDraft({ ...profileDraft, affiliation: e.target.value || undefined })}
                    placeholder="e.g. Tel Aviv University"
                    className="bg-[#14171d] border border-white/10 rounded px-2 py-1.5 text-sm w-full"
                  />
                </Field>
                <div className="col-span-2 text-[11px] text-slate-500">
                  id: <code>{profileDraft.id}</code> · auth: {profileDraft.authMethod}
                </div>
                <div className="col-span-2 flex items-center gap-2">
                  <button
                    onClick={() => { signIn(profileDraft); setProfileSaved(true); setTimeout(() => setProfileSaved(false), 2000); }}
                    className="px-3 py-1.5 rounded border border-emerald-700/50 bg-emerald-900/30 text-emerald-200 hover:bg-emerald-900/50 transition text-xs"
                  >
                    Save profile
                  </button>
                  {profileSaved && <span className="text-[11px] text-emerald-400">Saved.</span>}
                </div>
              </div>
            )}
          </Section>

          <Section
            title="Theme"
            hint="Light theme flips the main surfaces and text. Some component accents may still appear dark — this is a best-effort flip."
          >
            <Field label="Color scheme">
              <div className="flex gap-2">
                {(['dark', 'light', 'system'] as Theme[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => update('theme', t)}
                    className={`px-3 py-1.5 rounded border text-xs capitalize ${
                      settings.theme === t
                        ? 'border-indigo-500 bg-indigo-900/30 text-indigo-200'
                        : 'border-white/10 text-slate-300 hover:border-white/20'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </Field>
          </Section>

        </Group>

        {/* ════════════════════════════════════════════════════════════════ */}
        {/* CATEGORY 2 — Annotation                                         */}
        {/* ════════════════════════════════════════════════════════════════ */}
        <Group
          icon="pencil"
          title="Annotation"
          subtitle="What the inspector shows by default and which annotation layers you work with."
          accent="indigo"
        >
          <Section title="Display & playback" hint="Defaults applied when opening a song.">
            <Toggle
              label="Sidebar collapsed by default"
              value={settings.defaultSidebarCollapsed}
              onChange={(v) => update('defaultSidebarCollapsed', v)}
            />
            <Toggle
              label="Show beat grid"
              value={settings.defaultShowBeatGrid}
              onChange={(v) => update('defaultShowBeatGrid', v)}
            />
            <Field label={`Default playback rate (${settings.defaultPlaybackRate.toFixed(2)}×)`}>
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                value={settings.defaultPlaybackRate}
                onChange={(e) => update('defaultPlaybackRate', Number(e.target.value))}
                className="w-full accent-indigo-500"
              />
            </Field>
            <Field label="Arrow-key seek step sizes">
              <div className="flex items-center gap-3 flex-wrap">
                <label className="flex items-center gap-2 text-[11px] text-slate-400">
                  <span className="font-mono text-slate-300">←/→</span>
                  <input
                    type="number"
                    min={0.1}
                    max={120}
                    step={0.1}
                    value={settings.seekStepSmallSeconds}
                    onChange={(e) => {
                      const n = Math.max(0.1, Math.min(120, Number(e.target.value) || 1));
                      update('seekStepSmallSeconds', n);
                    }}
                    className="w-16 px-2 py-1 rounded bg-black/40 border border-white/[0.08] text-[12px] font-mono text-slate-100 focus:outline-none focus:border-indigo-400/50"
                  />
                  <span className="text-[10px] text-slate-500 font-mono">s</span>
                </label>
                <label className="flex items-center gap-2 text-[11px] text-slate-400">
                  <span className="font-mono text-slate-300">Shift + ←/→</span>
                  <input
                    type="number"
                    min={0.1}
                    max={120}
                    step={0.1}
                    value={settings.seekStepMediumSeconds}
                    onChange={(e) => {
                      const n = Math.max(0.1, Math.min(120, Number(e.target.value) || 5));
                      update('seekStepMediumSeconds', n);
                    }}
                    className="w-16 px-2 py-1 rounded bg-black/40 border border-white/[0.08] text-[12px] font-mono text-slate-100 focus:outline-none focus:border-indigo-400/50"
                  />
                  <span className="text-[10px] text-slate-500 font-mono">s</span>
                </label>
                <label className="flex items-center gap-2 text-[11px] text-slate-400">
                  <span className="font-mono text-slate-300">Alt + ←/→</span>
                  <input
                    type="number"
                    min={0.1}
                    max={120}
                    step={0.1}
                    value={settings.seekStepLargeSeconds}
                    onChange={(e) => {
                      const n = Math.max(0.1, Math.min(120, Number(e.target.value) || 10));
                      update('seekStepLargeSeconds', n);
                    }}
                    className="w-16 px-2 py-1 rounded bg-black/40 border border-white/[0.08] text-[12px] font-mono text-slate-100 focus:outline-none focus:border-indigo-400/50"
                  />
                  <span className="text-[10px] text-slate-500 font-mono">s</span>
                </label>
              </div>
              <p className="text-[11px] text-slate-500 mt-1.5">
                Three step sizes the arrow keys seek by. Use <span className="font-mono text-slate-400">Home</span> / <span className="font-mono text-slate-400">End</span> to jump to the start / end of the song.
              </p>
            </Field>
          </Section>

          <Section
            title="Default signals"
            hint="What's checked in the SIGNALS dropdown when a song opens."
          >
            <Toggle
              label="Signal overlays on (master toggle)"
              value={settings.defaultShowSignalOverlays}
              onChange={(v) => update('defaultShowSignalOverlays', v)}
            />
            <div className="pl-4 border-l border-white/[0.06] space-y-1.5">
              <Toggle
                label="3-Band (waveform)"
                value={settings.defaultShowWaveform}
                onChange={(v) => update('defaultShowWaveform', v)}
              />
              <div className="pl-6">
                <span className="text-[11px] text-slate-400 block mb-1.5">3-Band palette</span>
                <div className="flex flex-wrap gap-2">
                  {(Object.values(BAND_PALETTES)).map((p) => {
                    const active = settings.bandPalette === p.id;
                    const resolvedTheme = settings.theme === 'system'
                      ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
                      : settings.theme;
                    const colors = resolvedTheme === 'light' ? p.light : p.dark;
                    return (
                      <button
                        key={p.id}
                        onClick={() => update('bandPalette', p.id as BandPaletteId)}
                        title={p.hint}
                        className={`flex items-center gap-2 px-2.5 py-1 rounded border text-xs ${
                          active
                            ? 'border-indigo-500 bg-indigo-900/30 text-indigo-200'
                            : 'border-white/10 text-slate-300 hover:border-white/20'
                        }`}
                      >
                        <span className="flex gap-0.5" aria-hidden>
                          <span className="w-2.5 h-3.5 rounded-sm" style={{ background: colors.low }} />
                          <span className="w-2.5 h-3.5 rounded-sm" style={{ background: colors.mid }} />
                          <span className="w-2.5 h-3.5 rounded-sm" style={{ background: colors.high }} />
                        </span>
                        <span>{p.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <Toggle
                label="Spectrogram"
                value={settings.defaultShowSpectrogram}
                onChange={(v) => update('defaultShowSpectrogram', v)}
              />
              <Toggle
                label="Cepstrogram (MFCC)"
                value={settings.defaultShowCepstrogram}
                onChange={(v) => update('defaultShowCepstrogram', v)}
              />
              <Toggle
                label="Chromagram (pitch-class energy)"
                value={settings.defaultShowChroma}
                onChange={(v) => update('defaultShowChroma', v)}
              />
              <Toggle
                label="Tempogram (BPM strength over time)"
                value={settings.defaultShowTempogram}
                onChange={(v) => update('defaultShowTempogram', v)}
              />
              <Toggle
                label="SSM (chroma self-similarity matrix)"
                value={settings.defaultShowSsm}
                onChange={(v) => update('defaultShowSsm', v)}
              />
              <Toggle
                label="Energy (RMS)"
                value={settings.defaultShowEnergy}
                onChange={(v) => update('defaultShowEnergy', v)}
              />
              <Toggle
                label="Brightness (spectral centroid)"
                value={settings.defaultShowBrightness}
                onChange={(v) => update('defaultShowBrightness', v)}
              />
              <Toggle
                label="Novelty"
                value={settings.defaultShowNovelty}
                onChange={(v) => update('defaultShowNovelty', v)}
              />
              <Toggle
                label="Onsets (half-wave rectified flux — attacks only)"
                value={settings.defaultShowOnsets}
                onChange={(v) => update('defaultShowOnsets', v)}
              />
              <Toggle
                label="Spectral Flux (full L2 — attacks + releases)"
                value={settings.defaultShowFlux}
                onChange={(v) => update('defaultShowFlux', v)}
              />
              <Toggle
                label="EQ visualizer"
                value={settings.defaultShowEQ}
                onChange={(v) => update('defaultShowEQ', v)}
              />
            </div>
          </Section>

          <Section
            title="Annotations — display"
            hint="Which annotation layers are visible by default, and the time unit used by Manual editors."
          >
            <Toggle
              label="Show manual annotations"
              value={settings.defaultShowManual}
              onChange={(v) => update('defaultShowManual', v)}
            />
            <Toggle
              label="Show auto-guess annotations"
              value={settings.defaultShowAutoGuess}
              onChange={(v) => update('defaultShowAutoGuess', v)}
            />
            <Field label="Time unit for annotation editors">
              <div className="flex gap-2">
                {(['ms', 'beats'] as TimeUnit[]).map((u) => (
                  <button
                    key={u}
                    onClick={() => update('annotationTimeUnit', u)}
                    className={`px-3 py-1.5 rounded border text-xs ${
                      settings.annotationTimeUnit === u
                        ? 'border-indigo-500 bg-indigo-900/30 text-indigo-200'
                        : 'border-white/10 text-slate-300 hover:border-white/20'
                    }`}
                  >
                    {u === 'ms' ? 'Milliseconds' : 'Beats / bars'}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-slate-500 mt-1.5">
                Applies to the manual annotation editor when the song has a BPM set.
              </p>
            </Field>
          </Section>

          <Section
            title="Vocabularies & taxonomies"
            hint={isAdmin
              ? "Section names (Manual), cue labels, and span labels. Admins: each field has 'Save as dataset default' to push the current value to every annotator."
              : "Section names (Manual), cue labels, and span labels. Suggestions come from the dataset default set by an admin."}
            headerExtra={<OverrideBadge active={sectionVocabOverride} onReset={resetSectionVocabToDataset} />}
          >
            <Field label="Section vocabulary">
              {sectionVocabAdminDefault && (
                <p className="text-[11px] text-slate-500 mb-1.5">
                  Dataset default ({sectionVocabAdminDefault.length} names):{' '}
                  <span className="font-mono text-slate-400">{sectionVocabAdminDefault.join(', ')}</span>
                </p>
              )}
              <p className="text-[11px] text-slate-500 mb-1.5">
                Pick one or more genres — the dropdown vocabulary in the Manual editor becomes
                the union of their section names. Use Custom for a hand-edited list.
              </p>
              <div className="space-y-1.5">
                <div className="grid gap-2">
                  {(Object.keys(GENRE_PRESETS) as GenrePresetKey[]).map((key) => {
                    const preset = GENRE_PRESETS[key];
                    const selected = isGenreSelected(key);
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => toggleVocabGenre(key)}
                        aria-pressed={selected}
                        className={`w-full text-left rounded border px-3 py-2 transition-colors ${
                          selected
                            ? 'border-violet-400/40 bg-violet-500/[0.05]'
                            : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded-sm border text-[10px] leading-none ${
                                selected
                                  ? 'border-violet-400/70 bg-violet-500/40 text-violet-100'
                                  : 'border-white/20 text-transparent'
                              }`}
                              aria-hidden="true"
                            >
                              ✓
                            </span>
                            <div className="text-[12px] text-slate-100 font-medium">{preset.name}</div>
                          </div>
                          <div className="text-[10px] text-slate-500 font-mono">{preset.vocabulary.length} names</div>
                        </div>
                        <div className="text-[10px] text-slate-500 font-mono mt-0.5 leading-relaxed">
                          {preset.description}
                        </div>
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {preset.vocabulary.map((type) => (
                            <span
                              key={type}
                              className="px-1.5 py-0.5 rounded text-[10px] font-mono"
                              style={{
                                backgroundColor: `${sectionColor(type)}1A`,
                                color: sectionColor(type),
                                border: `1px solid ${sectionColor(type)}33`,
                              }}
                            >
                              {sectionLabel(type)}
                            </span>
                          ))}
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className={`rounded border transition-colors ${inCustomVocabMode ? 'border-violet-400/40 bg-violet-500/[0.05]' : 'border-white/[0.06] bg-white/[0.02]'}`}>
                  <button type="button" onClick={enterCustomVocabMode} className="w-full text-left px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded-sm border text-[10px] leading-none ${
                            inCustomVocabMode
                              ? 'border-violet-400/70 bg-violet-500/40 text-violet-100'
                              : 'border-white/20 text-transparent'
                          }`}
                          aria-hidden="true"
                        >
                          ✓
                        </span>
                        <div className="text-[12px] text-slate-100 font-medium">Custom vocabulary</div>
                      </div>
                      <div className="text-[10px] text-slate-500 font-mono">{normalizedCurrentVocabulary.length} names</div>
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                      Use any comma- or newline-separated list, then apply it to the Manual dropdown.
                    </div>
                  </button>
                  <div className="px-3 pb-3 space-y-2">
                    <textarea
                      value={sectionVocabularyDraft}
                      onChange={(e) => setSectionVocabularyDraft(e.target.value)}
                      rows={3}
                      className="bg-[#0a0b0d] border border-white/[0.08] rounded px-2 py-1.5 text-sm w-full font-mono text-slate-100 focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/40"
                      placeholder="intro, buildup, drop, breakdown, bridge, outro, silence"
                    />
                    <div className="flex flex-wrap gap-1">
                      {normalizedCurrentVocabulary.length > 0 ? normalizedCurrentVocabulary.map((type) => (
                        <span
                          key={type}
                          className="px-1.5 py-0.5 rounded text-[10px] font-mono"
                          style={{
                            backgroundColor: `${sectionColor(type)}1A`,
                            color: sectionColor(type),
                            border: `1px solid ${sectionColor(type)}33`,
                          }}
                        >
                          {sectionLabel(type)}
                        </span>
                      )) : (
                        <span className="text-[11px] text-slate-500">No section names entered yet.</span>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <p className="text-[11px] text-slate-500">
                        Comma- or newline-separated section names shown in the Manual type dropdown.
                      </p>
                      <button
                        onClick={applySectionVocabulary}
                        className="px-3 py-1.5 rounded border border-violet-500/40 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20 transition text-xs"
                      >
                        Apply vocabulary
                      </button>
                    </div>
                  </div>
                </div>

                {isAdmin && (
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="button"
                      disabled={adminBusy}
                      onClick={() => void updateDatasetCfg({
                        sectionTypeVocabularyDefault: settings.sectionTypeVocabulary.length > 0
                          ? [...settings.sectionTypeVocabulary]
                          : undefined,
                      })}
                      className="px-3 py-1.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 disabled:opacity-30 transition text-xs"
                      title="Push the current vocabulary above to every annotator as the dataset default."
                    >
                      Save as dataset default
                    </button>
                    {datasetCfg?.sectionTypeVocabularyDefault && (
                      <button
                        type="button"
                        disabled={adminBusy}
                        onClick={() => void updateDatasetCfg({ sectionTypeVocabularyDefault: undefined })}
                        className="px-3 py-1.5 rounded border border-white/10 hover:border-white/20 hover:bg-white/[0.03] text-xs disabled:opacity-30"
                      >
                        Clear dataset default
                      </button>
                    )}
                  </div>
                )}
              </div>
            </Field>

            {/* Manual "Fill default" layout — collapsible, filtered to vocabulary */}
            <Field
              label={
                <span className="inline-flex items-center gap-2">
                  Manual ‘Fill default’ layout
                  {fillDefaultOutOfVocab && (
                    <span
                      className="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider border border-amber-500/40 bg-amber-500/10 text-amber-200"
                      title="The selected layout's genre isn't in your current vocabulary."
                    >
                      Not in vocabulary
                    </span>
                  )}
                </span>
              }
            >
              <details className="group rounded border border-white/[0.06] bg-white/[0.02] open:bg-amber-500/[0.04] open:border-amber-400/30">
                <summary className="list-none cursor-pointer px-3 py-2 select-none">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="inline-block w-3.5 text-amber-300/80 transition-transform group-open:rotate-90 shrink-0"
                        aria-hidden
                      >
                        ▶
                      </span>
                      <div className="text-[12px] text-slate-100 font-medium truncate">
                        {fillDefaultSummary.title}
                      </div>
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono shrink-0">
                      {fillDefaultSummary.meta}
                    </div>
                  </div>
                  {fillDefaultSummary.chips.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {fillDefaultSummary.chips.map((chip, i) => (
                        <span
                          key={i}
                          className="px-1.5 py-0.5 rounded text-[10px] font-mono"
                          style={{
                            backgroundColor: `${sectionColor(chip.type)}1A`,
                            color: sectionColor(chip.type),
                            border: `1px solid ${sectionColor(chip.type)}33`,
                          }}
                        >
                          {sectionLabel(chip.type)}{chip.bars !== undefined ? ` ${chip.bars}` : ''}
                        </span>
                      ))}
                    </div>
                  )}
                </summary>
                <div className="px-3 pb-3 pt-1 space-y-1.5 border-t border-white/[0.06]">
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <label className="inline-flex items-center gap-1.5 text-[10px] text-slate-400 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={showAllFillDefaultPresets}
                        onChange={(e) => setShowAllFillDefaultPresets(e.target.checked)}
                        className="accent-amber-500"
                      />
                      Show all presets
                    </label>
                  </div>
                  {!showAllFillDefaultPresets && !inCustomVocabMode && visibleFillDefaultKeys.length === 0 && (
                    <p className="text-[11px] text-amber-300/80">
                      No layouts match your current vocabulary genres — toggle <span className="font-medium">Show all presets</span> above to pick from the full list, switch to Custom below, or select a genre in the Section vocabulary above.
                    </p>
                  )}
                  {!showAllFillDefaultPresets && inCustomVocabMode && (
                    <p className="text-[11px] text-slate-500">
                      You're on a Custom vocabulary — only the Custom layout is shown. Toggle <span className="font-medium">Show all presets</span> above to pick a genre preset as the default anyway.
                    </p>
                  )}
                  <div className="grid gap-2">
                    {visibleFillDefaultKeys.map((key) => {
                      const preset = MANUAL_BOUNDARY_PRESETS[key];
                      const selected = settings.manualBoundariesDefault === key;
                      const totalBars = preset.layout.reduce((a, b) => a + b.bars, 0);
                      const inVocab = isGenreSelected(key as GenrePresetKey);
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => update('manualBoundariesDefault', key as ManualBoundariesDefault)}
                          title={selected ? 'Current default' : `Set "${preset.name}" as default`}
                          className={`w-full text-left rounded border px-3 py-2 transition-colors ${
                            selected
                              ? 'border-amber-400/40 bg-amber-500/[0.05]'
                              : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5">
                              <div className="text-[12px] text-slate-100 font-medium">{preset.name}</div>
                              {!inVocab && (
                                <span className="px-1 py-0.5 rounded text-[9px] uppercase tracking-wider border border-amber-500/30 bg-amber-500/[0.06] text-amber-300/80">
                                  not in vocab
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] text-slate-500 font-mono">{totalBars} bars · {preset.layout.length} sections</div>
                          </div>
                          <div className="text-[10px] text-slate-500 font-mono mt-0.5 leading-relaxed">{preset.description}</div>
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {preset.layout.map((entry, i) => (
                              <span
                                key={i}
                                className="px-1.5 py-0.5 rounded text-[10px] font-mono"
                                style={{
                                  backgroundColor: `${sectionColor(entry.type)}1A`,
                                  color: sectionColor(entry.type),
                                  border: `1px solid ${sectionColor(entry.type)}33`,
                                }}
                              >
                                {sectionLabel(entry.type)} {entry.bars}
                              </span>
                            ))}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  <div className={`rounded border transition-colors ${settings.manualBoundariesDefault === 'custom' ? 'border-amber-400/40 bg-amber-500/[0.05]' : 'border-white/[0.06] bg-white/[0.02]'}`}>
                    <button
                      type="button"
                      onClick={() => update('manualBoundariesDefault', 'custom')}
                      className="w-full text-left px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[12px] text-slate-100 font-medium">Custom — type:bars list</div>
                        <div className="text-[10px] text-slate-500 font-mono">{manualCustomParsed.layout.length} sections</div>
                      </div>
                      <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                        Comma-separated. Example: <span className="text-slate-300">intro:32, buildup:8, drop:32, outro:32</span>
                      </div>
                    </button>
                    {settings.manualBoundariesDefault === 'custom' && (
                      <div className="px-3 pb-3 space-y-2">
                        <input
                          type="text"
                          value={manualCustomDraft}
                          onChange={(e) => setManualCustomDraft(e.target.value)}
                          onBlur={() => update('manualBoundariesCustomLayout', manualCustomDraft)}
                          placeholder="intro:16, drop:32, outro:16"
                          className="w-full px-2 py-1.5 rounded bg-black/40 border border-white/[0.08] text-[12px] font-mono text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-amber-400/50"
                        />
                        {manualCustomParsed.errors.length > 0 && (
                          <div className="space-y-0.5">
                            {manualCustomParsed.errors.map((err, i) => (
                              <div key={i} className="text-[10px] text-rose-400 font-mono">⚠ {err}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Applied by the ⚡ Fill default button on Manual annotations when there are no algorithm-suggested sections.
                    Bars convert to seconds using the song's BPM &amp; time signature at apply time.
                  </p>
                </div>
              </details>
            </Field>

            {/* Cue taxonomy — with override badge */}
            <Field
              label={
                <span className="inline-flex items-center gap-2">
                  Cues — label taxonomy
                  <OverrideBadge active={cueOverride} onReset={resetCueTaxonomyToDataset} />
                </span>
              }
            >
              {(cueAdminDefault !== undefined || cueAdminEnabledDefault !== undefined) && (
                <p className="text-[11px] text-slate-500 mb-1.5">
                  Dataset default: {cueAdminEnabledDefault ? 'fixed taxonomy' : 'free text'}
                  {cueAdminDefault && cueAdminDefault.length > 0 && (
                    <> · <span className="font-mono text-slate-400">{cueAdminDefault.join(', ')}</span></>
                  )}
                </p>
              )}
              <Toggle
                label="Use a fixed taxonomy for cue labels (otherwise free text)"
                value={settings.cueTaxonomyEnabled}
                onChange={(v) => update('cueTaxonomyEnabled', v)}
              />
              {settings.cueTaxonomyEnabled && (
                <div className="pl-4 border-l border-white/[0.06] mt-2 space-y-1.5">
                  <textarea
                    value={cueTaxonomyDraft}
                    onChange={(e) => setCueTaxonomyDraft(e.target.value)}
                    onBlur={() => update('cueTaxonomy', parseVocabulary(cueTaxonomyDraft))}
                    rows={2}
                    placeholder="kick, snare, hat, fx, vox"
                    className="bg-[#0a0b0d] border border-white/[0.08] rounded px-2 py-1.5 text-sm w-full font-mono text-slate-100 focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/40"
                  />
                  <p className="text-[11px] text-slate-500">
                    Comma- or newline-separated. Suggested as autocomplete in cue label inputs; free text is still accepted.
                  </p>
                </div>
              )}
              {isAdmin && (
                <div className="flex items-center justify-end gap-2 mt-2">
                  <button
                    type="button"
                    disabled={adminBusy}
                    onClick={() => void updateDatasetCfg({
                      cueTaxonomyEnabledDefault: settings.cueTaxonomyEnabled,
                      cueTaxonomyDefault: settings.cueTaxonomy.length > 0 ? [...settings.cueTaxonomy] : undefined,
                    })}
                    className="px-3 py-1.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 disabled:opacity-30 transition text-xs"
                    title="Push the current cue toggle + list above to every annotator as the dataset default."
                  >
                    Save as dataset default
                  </button>
                  {(datasetCfg?.cueTaxonomyDefault || datasetCfg?.cueTaxonomyEnabledDefault !== undefined) && (
                    <button
                      type="button"
                      disabled={adminBusy}
                      onClick={() => void updateDatasetCfg({ cueTaxonomyDefault: undefined, cueTaxonomyEnabledDefault: undefined })}
                      className="px-3 py-1.5 rounded border border-white/10 hover:border-white/20 hover:bg-white/[0.03] text-xs disabled:opacity-30"
                    >
                      Clear dataset default
                    </button>
                  )}
                </div>
              )}
            </Field>

            {/* Span taxonomy — with override badge */}
            <Field
              label={
                <span className="inline-flex items-center gap-2">
                  Spans — label taxonomy
                  <OverrideBadge active={spanOverride} onReset={resetSpanTaxonomyToDataset} />
                </span>
              }
            >
              {(spanAdminDefault !== undefined || spanAdminEnabledDefault !== undefined) && (
                <p className="text-[11px] text-slate-500 mb-1.5">
                  Dataset default: {spanAdminEnabledDefault ? 'fixed taxonomy' : 'free text'}
                  {spanAdminDefault && spanAdminDefault.length > 0 && (
                    <> · <span className="font-mono text-slate-400">{spanAdminDefault.join(', ')}</span></>
                  )}
                </p>
              )}
              <Toggle
                label="Use a fixed taxonomy for span labels (otherwise free text)"
                value={settings.spanTaxonomyEnabled}
                onChange={(v) => update('spanTaxonomyEnabled', v)}
              />
              {settings.spanTaxonomyEnabled && (
                <div className="pl-4 border-l border-white/[0.06] mt-2 space-y-1.5">
                  <textarea
                    value={spanTaxonomyDraft}
                    onChange={(e) => setSpanTaxonomyDraft(e.target.value)}
                    onBlur={() => update('spanTaxonomy', parseVocabulary(spanTaxonomyDraft))}
                    rows={2}
                    placeholder="vocals, pad, bass, lead, fx"
                    className="bg-[#0a0b0d] border border-white/[0.08] rounded px-2 py-1.5 text-sm w-full font-mono text-slate-100 focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/40"
                  />
                  <p className="text-[11px] text-slate-500">
                    Comma- or newline-separated. Suggested as autocomplete in span label inputs; free text is still accepted.
                  </p>
                </div>
              )}
              {isAdmin && (
                <div className="flex items-center justify-end gap-2 mt-2">
                  <button
                    type="button"
                    disabled={adminBusy}
                    onClick={() => void updateDatasetCfg({
                      spanTaxonomyEnabledDefault: settings.spanTaxonomyEnabled,
                      spanTaxonomyDefault: settings.spanTaxonomy.length > 0 ? [...settings.spanTaxonomy] : undefined,
                    })}
                    className="px-3 py-1.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 disabled:opacity-30 transition text-xs"
                    title="Push the current span toggle + list above to every annotator as the dataset default."
                  >
                    Save as dataset default
                  </button>
                  {(datasetCfg?.spanTaxonomyDefault || datasetCfg?.spanTaxonomyEnabledDefault !== undefined) && (
                    <button
                      type="button"
                      disabled={adminBusy}
                      onClick={() => void updateDatasetCfg({ spanTaxonomyDefault: undefined, spanTaxonomyEnabledDefault: undefined })}
                      className="px-3 py-1.5 rounded border border-white/10 hover:border-white/20 hover:bg-white/[0.03] text-xs disabled:opacity-30"
                    >
                      Clear dataset default
                    </button>
                  )}
                </div>
              )}
            </Field>
          </Section>

          <Section
            title="Loops"
            hint="Quick-add bar sizes for the Loop editor."
          >
            <Field label="Quick-add bar sizes">
              <div className="flex items-center gap-3 flex-wrap">
                <label className="flex items-center gap-2 text-[11px] text-slate-400">
                  Button A
                  <input
                    type="number"
                    min={1}
                    max={64}
                    value={settings.loopQuickAddBars[0]}
                    onChange={(e) => {
                      const n = Math.max(1, Math.min(64, Math.round(Number(e.target.value) || 1)));
                      update('loopQuickAddBars', [n, settings.loopQuickAddBars[1]]);
                    }}
                    className="w-16 px-2 py-1 rounded bg-black/40 border border-white/[0.08] text-[12px] font-mono text-slate-100 focus:outline-none focus:border-fuchsia-400/50"
                  />
                  <span className="text-[10px] text-slate-500 font-mono">bars</span>
                </label>
                <label className="flex items-center gap-2 text-[11px] text-slate-400">
                  Button B
                  <input
                    type="number"
                    min={1}
                    max={64}
                    value={settings.loopQuickAddBars[1]}
                    onChange={(e) => {
                      const n = Math.max(1, Math.min(64, Math.round(Number(e.target.value) || 1)));
                      update('loopQuickAddBars', [settings.loopQuickAddBars[0], n]);
                    }}
                    className="w-16 px-2 py-1 rounded bg-black/40 border border-white/[0.08] text-[12px] font-mono text-slate-100 focus:outline-none focus:border-fuchsia-400/50"
                  />
                  <span className="text-[10px] text-slate-500 font-mono">bars</span>
                </label>
              </div>
              <p className="text-[11px] text-slate-500 mt-1.5">
                The Loop editor shows two “+ N-bar loop” buttons at the playhead — these set their sizes.
              </p>
            </Field>
          </Section>

          <Section
            title="Experimental annotation types & models"
            hint="Coming soon. Each toggle is independent; flip on locally to test in-progress paradigms and MIR models before they ship."
          >
            <Toggle
              label="Enable Loops and Patterns (in development)"
              value={settings.experimentalLoopsAndPatterns}
              onChange={(v) => update('experimentalLoopsAndPatterns', v)}
            />
            <p className="text-[11px] text-slate-500">
              <span className="font-medium text-slate-400">Loops</span> are grid-aware
              seamless-playback regions for auditioning N-bar phrases.{' '}
              <span className="font-medium text-slate-400">Patterns</span> are labeled cycles
              that tile across the song. Backend supports both; the UI is still being built and
              won't show until this flag is on. Boundaries (Manual/Auto-guess), Cues, and Spans
              are always available — they don't need this flag.
            </p>
            <Toggle
              label="Enable SPAN-family detectors (Silero-VAD, JDCNet)"
              value={settings.experimentalSpanFamily}
              onChange={(v) => update('experimentalSpanFamily', v)}
              disabled={!expAvail.spanFamily}
            />
            <p className="text-[11px] text-slate-500">
              Voicing / instrument-activity detectors produce <em>span</em> intervals (start–end
              regions) rather than boundaries or cues. Requires the{' '}
              <code className="font-mono text-slate-400">experimental-models</code> docker compose
              profile to be running. Evaluation columns display{' '}
              <code className="font-mono text-slate-400">—</code> until per-kind span metrics
              (IoU / frame-F1 / onset-offset F1) ship in the eval rework. May break, no SLA.
            </p>
            {!expAvail.spanFamily && <ExpUnavailableNote />}
            <Toggle
              label="Enable CUE-family extras (BeatNet — beats + downbeats + meter; basic-pitch — polyphonic notes)"
              value={settings.experimentalCueExtras}
              onChange={(v) => update('experimentalCueExtras', v)}
              disabled={!expAvail.cueExtras}
            />
            <p className="text-[11px] text-slate-500">
              BeatNet runs alongside the 5 existing BPM detectors (librosa + madmom) and adds
              downbeat tracking + a song-level meter estimate (3/4 vs 4/4). basic-pitch
              (Spotify, ONNX) transcribes polyphonic notes into per-note CUE items labelled
              with their pitch (e.g. <code className="font-mono text-slate-400">C4</code>).
              Same profile requirement as SPAN. May break, no SLA.
            </p>
            {!expAvail.cueExtras && <ExpUnavailableNote />}
            <Toggle
              label="Enable LOOP-family detectors (chroma autocorrelation)"
              value={settings.experimentalLoopFamily}
              onChange={(v) => update('experimentalLoopFamily', v)}
              disabled={!expAvail.loopFamily}
            />
            <p className="text-[11px] text-slate-500">
              Pure-DSP loop finder built on beat-synchronous chroma + cosine similarity. No
              model weights, no GPU, no special install — works on every platform that runs
              the existing TimeCues stack. Outputs <code className="font-mono text-slate-400">LoopItem[]</code> —
              labeled intervals representing seamless N-bar phrases. Distinct from the
              <em>Loops + Patterns</em> flag above which gates the <em>manual</em> annotation tab.
            </p>
            {!expAvail.loopFamily && <ExpUnavailableNote />}
            <Toggle
              label="Enable LYRICS-family detectors (Whisper-base transcription)"
              value={settings.experimentalLyricsFamily}
              onChange={(v) => update('experimentalLyricsFamily', v)}
              disabled={!expAvail.lyricsFamily}
            />
            <p className="text-[11px] text-slate-500">
              OpenAI Whisper "base" multilingual transcription. ~140 MB checkpoint lazy-downloads
              into the shared model-cache volume on first detect. Output: per-word and per-line
              entries with coarse timestamps (~200 ms granularity). Refining the word-level
              alignment with WhisperX / ctc-forced-aligner is the planned follow-up.
            </p>
            {!expAvail.lyricsFamily && <ExpUnavailableNote />}
            <Toggle
              label="Enable PATTERN-family detectors (LoCoMotif motif discovery)"
              value={settings.experimentalPatternFamily}
              onChange={(v) => update('experimentalPatternFamily', v)}
              disabled={!expAvail.patternFamily}
            />
            <p className="text-[11px] text-slate-500">
              <a href="https://github.com/ML-KULeuven/locomotif" target="_blank" rel="noopener noreferrer"
                 className="text-emerald-400/80 hover:text-emerald-300 underline">LoCoMotif</a>{' '}
              (MIT, KU Leuven) finds variable-length repeating motifs in beat-synchronous chroma via DTW-warped
              matching. Each detected motif set surfaces as a group of <code className="font-mono text-slate-400">PatternItem</code>{' '}
              occurrences in <code className="font-mono text-slate-400">data/algorithm-outputs/pattern/</code>.
              No model weights — pure DSP + numba JIT (one-time ~15 s warm-up on first call after server boot).
            </p>
            {!expAvail.patternFamily && <ExpUnavailableNote />}
            <Toggle
              label="Enable Setlist workspace (algorithmic DJ-style ordering)"
              value={settings.experimentalSetlist}
              onChange={(v) => update('experimentalSetlist', v)}
            />
            <p className="text-[11px] text-slate-500">
              Adds a top-level <span className="font-medium text-slate-400">Setlist</span>{' '}
              workspace at <code className="font-mono text-slate-400">/setlist</code> that orders
              your corpus into a play sequence. v0 uses cached BPM (median across the 5 detectors)
              with a greedy nearest-neighbour pass; meter and energy scorers join next. Saved
              setlists persist per-annotator under{' '}
              <code className="font-mono text-slate-400">data/setlists/&lt;you&gt;/&lt;name&gt;.json</code>.
              No new model dependencies.
            </p>
            <ExperimentalModelsPanel
              spanFamilyEnabled={settings.experimentalSpanFamily}
              cueExtrasEnabled={settings.experimentalCueExtras}
              loopFamilyEnabled={settings.experimentalLoopFamily}
              lyricsFamilyEnabled={settings.experimentalLyricsFamily}
              patternFamilyEnabled={settings.experimentalPatternFamily}
            />
          </Section>
        </Group>

        {/* ════════════════════════════════════════════════════════════════ */}
        {/* CATEGORY 3 — Research (locked for team / public)                */}
        {/* ════════════════════════════════════════════════════════════════ */}
        <Group
          icon="lab"
          title="Research"
          subtitle="Algorithmic decisions: which detectors run, how their outputs cluster, and how auto-guess picks centroids."
          accent="violet"
          locked={!canResearch}
          lockReason="Researcher & Admin only — these settings affect cross-annotator algorithm runs."
        >
          <Section
            title="Default algorithms"
            hint="Pre-selected when you open the algorithm inspector. Ruptures CPD methods are excluded — toggle them per-song."
          >
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              {ALL_ALGORITHMS.map((a) => {
                const disabled = a.id === 'allin1' && !gpuCaps.allin1;
                return (
                  <Toggle
                    key={a.id}
                    label={disabled ? `${a.label} — Demucs profile needed` : a.label}
                    value={settings.defaultAlgorithms.includes(a.id) && !disabled}
                    onChange={() => toggleAlgo(a.id)}
                    disabled={disabled}
                  />
                );
              })}
            </div>
          </Section>

          <Section
            title="BPM detection"
            hint="The BPM server runs all installed detectors. Disabled ones are hidden from the BPM suggestions UI."
          >
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              {ALL_BPM_DETECTORS.map((id) => (
                <Toggle
                  key={id}
                  label={id}
                  value={bpmEnabled(id)}
                  onChange={() => toggleBpmDetector(id)}
                />
              ))}
            </div>
          </Section>

          <Section
            title="Evaluation"
            hint="How the dataset-evaluation tables score detector output against your reference layers."
          >
            <Toggle
              label="Score region layers as multiple candidates (spans / loops / patterns)"
              value={settings.evalRegionLayersAsCandidates}
              onChange={(v) => update('evalRegionLayersAsCandidates', v)}
            />
            <p className="text-[11px] text-slate-500">
              When on, every span, loop, and pattern layer is scored as one set of
              interchangeable alternatives for the same event: a detector that hits{' '}
              <em>any</em> item in the layer satisfies it, and the rest aren't counted as
              misses. Overrides each layer's per-layer{' '}
              <span className="font-medium text-slate-400">Full / Cands</span> picker while on.
              Cues and boundaries are unaffected — they carry their own per-item candidates.
            </p>
          </Section>

          <Section title="Auto-guess defaults" hint="Initial values when opening the Auto-Guess panel.">
            <Field label={`Cluster tolerance (${settings.autoGuessClusterTolerance.toFixed(1)} s)`}>
              <input
                type="range"
                min={0.5}
                max={10}
                step={0.5}
                value={settings.autoGuessClusterTolerance}
                onChange={(e) => update('autoGuessClusterTolerance', Number(e.target.value))}
                className="w-full accent-indigo-500"
              />
            </Field>
            <Field label={`Min consensus (${settings.autoGuessMinConsensus})`}>
              <input
                type="range"
                min={1}
                max={10}
                step={1}
                value={settings.autoGuessMinConsensus}
                onChange={(e) => update('autoGuessMinConsensus', Number(e.target.value))}
                className="w-full accent-indigo-500"
              />
            </Field>
            <Field label="Centroid method">
              <div className="flex flex-wrap gap-2">
                {CENTROID_METHODS.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => update('autoGuessCentroidMethod', m.id)}
                    title={m.hint}
                    className={`px-2.5 py-1 rounded border text-xs ${
                      settings.autoGuessCentroidMethod === m.id
                        ? 'border-indigo-500 bg-indigo-900/30 text-indigo-200'
                        : 'border-white/10 text-slate-300 hover:border-white/20'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </Field>
            <Field
              label={
                settings.autoGuessExpandZoomThreshold <= 0
                  ? 'Expand review buttons at zoom · always (×0)'
                  : `Expand review buttons at zoom · ×${settings.autoGuessExpandZoomThreshold}`
              }
            >
              <input
                type="range"
                min={0}
                max={16}
                step={1}
                value={settings.autoGuessExpandZoomThreshold}
                onChange={(e) => update('autoGuessExpandZoomThreshold', Number(e.target.value))}
                className="w-full accent-indigo-500"
              />
              <p className="text-[10px] text-slate-500 mt-1 leading-relaxed">
                Below this zoom level the Auto-Guess and custom-detector rows show a single chevron per point.
                Click the chevron — or the section block above — to reveal that point's play / pick / ✓ / ✗ buttons.
                Set to 0 to always show the full cluster.
              </p>
            </Field>
          </Section>

          <GpuToolingSection
            gpuCaps={gpuCaps}
            gpuLoading={gpuLoading}
            refreshGpu={refreshGpu}
          />
        </Group>

        {/* ════════════════════════════════════════════════════════════════ */}
        {/* CATEGORY 4 — Corpus management (locked for non-admin)           */}
        {/* ════════════════════════════════════════════════════════════════ */}
        <Group
          icon="shield"
          title="Corpus management"
          subtitle="Dataset-level configuration. Stored in data/dataset-config.json and applied to every annotator."
          accent="amber"
          locked={!canAdmin}
          lockReason="Admin only — these settings change what the whole team sees."
        >
          <Section
            title="Corpus identity"
            hint="Display name shown on the main page, the workspace header chip, and the browser tab. Saving reloads the page so every label updates immediately. Leave blank to fall back to “TimeCues Studio”."
          >
            <Field label="Corpus name">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={corpusNameDraft}
                  onChange={(e) => setCorpusNameDraft(e.target.value)}
                  disabled={!canAdmin || adminBusy}
                  placeholder="TimeCues Studio"
                  maxLength={80}
                  className="flex-1 bg-[#0e1015] border border-white/10 rounded px-2 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                />
                <button
                  type="button"
                  disabled={!canAdmin || adminBusy || !corpusNameDirty}
                  onClick={() => { void saveCorpusName(); }}
                  className="px-3 py-1.5 rounded border border-emerald-700/50 bg-emerald-900/30 text-emerald-200 hover:bg-emerald-900/50 disabled:opacity-30 disabled:cursor-not-allowed text-xs"
                >
                  Save
                </button>
              </div>
            </Field>
          </Section>

          <Section
            title="Shared corpus (experimental)"
            hint="When on, team annotators read & write a single set of annotation files at the corpus root instead of per-annotator subdirectories. Switching modes on a live dataset does not migrate existing files — flip with care."
          >
            <Toggle
              label="Shared annotation files for the whole team"
              value={!!datasetCfg?.sharedCorpus}
              disabled={!canAdmin || adminBusy}
              onChange={(v) => { void updateDatasetCfg({ sharedCorpus: v }); }}
            />
            {datasetCfg?.sharedCorpus && (
              <p className="mt-1.5 text-[11px] text-amber-300/80">
                ⚠ Shared mode is on. Per-annotator comparison views lose their meaning — every team member edits the same files.
              </p>
            )}
          </Section>

          <Section
            title="Admin & access"
            hint="Controls who can view the Team dashboard, lock the dataset, delete songs, and export cross-annotator data."
          >
            {!adminStatus && <p className="text-[11px] text-slate-500">Loading…</p>}
            {adminStatus && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-slate-500">Your status:</span>
                  <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${
                    adminStatus.isAdmin
                      ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-400/30'
                      : 'bg-slate-700/40 text-slate-300 border border-slate-600/40'
                  }`}>
                    {adminStatus.isAdmin ? 'Admin' : 'Annotator (no admin)'}
                  </span>
                  <span className="text-slate-500">·</span>
                  <span className="text-slate-500">Mode:</span>
                  <span className="text-slate-300 font-mono text-[11px]">{adminStatus.mode}</span>
                </div>

                {adminStatus.mode === 'bootstrap' && (
                  <p className="text-[11px] text-amber-300/80">
                    No admin attached to this dataset yet. The first person to add an email
                    below becomes admin.
                  </p>
                )}

                {adminStatus.isAdmin && (
                  <Field label={`Admin allowlist (${adminStatus.adminEmails?.length ?? 0})`}>
                    <div className="space-y-1.5">
                      {(adminStatus.adminEmails ?? []).map((email) => (
                        <div key={email} className="flex items-center gap-2 text-xs">
                          <span className="flex-1 font-mono text-slate-300 truncate">{email}</span>
                          {email === annotator?.id && (
                            <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-400/30">
                              You
                            </span>
                          )}
                          <button
                            type="button"
                            disabled={adminBusy || (adminStatus.adminEmails?.length === 1 && email === annotator?.id)}
                            onClick={() => {
                              const next = (adminStatus.adminEmails ?? []).filter((e) => e !== email);
                              void updateAdminEmails(next);
                            }}
                            title={adminStatus.adminEmails?.length === 1 && email === annotator?.id
                              ? 'Cannot remove yourself when you are the only admin'
                              : 'Remove admin'}
                            className="px-2 py-1 rounded text-[11px] border border-white/10 text-slate-400 hover:text-rose-300 hover:border-rose-500/40 disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                      {(adminStatus.adminEmails?.length ?? 0) === 0 && (
                        <p className="text-[11px] text-slate-500">
                          Allowlist is empty. Anyone signed in is currently treated as admin.
                        </p>
                      )}
                      <div className="flex gap-2 pt-1">
                        <input
                          type="email"
                          value={adminDraftEmail}
                          onChange={(e) => setAdminDraftEmail(e.target.value)}
                          placeholder="email@example.com"
                          className="flex-1 bg-[#0e1015] border border-white/10 rounded px-2 py-1.5 text-xs font-mono"
                        />
                        <button
                          type="button"
                          disabled={adminBusy || !adminDraftEmail.trim()}
                          onClick={() => {
                            const v = adminDraftEmail.trim().toLowerCase();
                            if (!v) return;
                            const current = adminStatus.adminEmails ?? [];
                            if (current.includes(v)) { setAdminDraftEmail(''); return; }
                            // Always include the current admin so they don't lock themselves out
                            // when transitioning from bootstrap mode to an explicit allowlist.
                            const seed = current.length === 0 && annotator?.id && annotator.id !== v
                              ? [annotator.id, v]
                              : [...current, v];
                            void updateAdminEmails(seed).then(() => setAdminDraftEmail(''));
                          }}
                          className="px-3 py-1.5 rounded border border-emerald-700/50 bg-emerald-900/30 text-emerald-200 hover:bg-emerald-900/50 disabled:opacity-30 disabled:cursor-not-allowed text-xs"
                        >
                          Add admin
                        </button>
                      </div>
                    </div>
                  </Field>
                )}

                {adminStatus.isAdmin && adminStatus.mode === 'bootstrap' && !adminStatus.adminEmails?.length && annotator?.id && (
                  <button
                    type="button"
                    disabled={adminBusy}
                    onClick={() => void updateAdminEmails([annotator.id])}
                    className="px-3 py-1.5 rounded border border-emerald-700/50 bg-emerald-900/30 text-emerald-200 hover:bg-emerald-900/50 disabled:opacity-30 text-xs"
                  >
                    Claim admin (lock to {annotator.id})
                  </button>
                )}

                {adminError && <p className="text-[11px] text-red-400">{adminError}</p>}
                {adminBusy && <p className="text-[11px] text-slate-500">Saving…</p>}
              </div>
            )}
          </Section>

          <Section
            title="Storage stats"
            hint="Inspect on-disk cache usage. Destructive cache clears now live in the Danger Zone below."
          >
            <div className="flex items-center gap-2 mb-3">
              <button
                onClick={refreshStats}
                className="px-3 py-1.5 rounded border border-white/10 hover:border-white/20 text-xs"
                disabled={statsLoading}
              >
                {statsLoading ? 'Refreshing…' : 'Refresh stats'}
              </button>
            </div>
            {stats && (
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs font-mono tabular-nums">
                <span className="text-slate-500">Stems</span>            <span className="text-slate-300 text-right">{formatBytes(stats.totals.stems)}</span>
                <span className="text-slate-500">Analysis</span>         <span className="text-slate-300 text-right">{formatBytes(stats.totals.analysis)}</span>
                <span className="text-slate-500">MSAF raw</span>         <span className="text-slate-300 text-right">{formatBytes(stats.totals.msafRaw)}</span>
                <span className="text-slate-500">BPM</span>              <span className="text-slate-300 text-right">{formatBytes(stats.totals.bpm)}</span>
                <span className="text-slate-500">Algo clusters</span>    <span className="text-slate-300 text-right">{formatBytes(stats.totals.algoClusters)}</span>
                <span className="text-slate-500">MIR features</span>     <span className="text-slate-300 text-right">{formatBytes(stats.totals.mirFeatures)}</span>
                <span className="text-slate-500">Custom-script results</span><span className="text-slate-300 text-right">{formatBytes(stats.totals.customResults)}</span>
                <span className="text-slate-400 border-t border-white/[0.06] pt-1">Cache total</span>
                <span className="text-slate-200 text-right border-t border-white/[0.06] pt-1">{formatBytes(stats.totals.cacheBytes)}</span>
                <span className="text-slate-500">Annotations (kept)</span><span className="text-slate-400 text-right">{formatBytes(stats.totals.annotations)}</span>
                <span className="text-slate-500">Audio (kept)</span>     <span className="text-slate-400 text-right">{formatBytes(stats.totals.audio)}</span>
              </div>
            )}
          </Section>
        </Group>

        {/* ════════════════════════════════════════════════════════════════ */}
        {/* CATEGORY 5 — Danger Zone                                        */}
        {/* ════════════════════════════════════════════════════════════════ */}
        <Group
          icon="warning"
          title="Danger Zone"
          subtitle="Destructive actions. Some are personal (just this browser); others affect every annotator and are admin-only."
          accent="rose"
        >
          <Section
            title="Personal — this browser only"
            hint="These don't touch anyone else's data, but you can't undo them."
          >
            <DangerRow
              label="Reset all settings to defaults"
              description="Reverts every preference on this page (theme, signals, vocabularies, taxonomies…) to its shipped default."
              onAction={handleResetAllSettings}
              actionLabel="Reset"
            />
            <DangerRow
              label="Reset local storage"
              description="Clears the entire browser store. Signs you out and discards every UI preference. Annotations on disk are NOT affected."
              onAction={handleResetLocalStorage}
              actionLabel="Reset"
            />
            <DangerRow
              label="Reset info banners"
              description="Restores all dismissed info banners (like workspace tips at the top of each page). You will see them again the next time you visit."
              onAction={handleResetBanners}
              actionLabel="Reset banners"
            />
          </Section>

          <Section
            title="Corpus-wide — affects every annotator"
            hint="Admin only. The whole team sees these effects."
            headerExtra={!canAdmin ? <AdminOnlyBadge /> : undefined}
          >
            <DangerRow
              label="Clear all caches"
              description="Stems, analysis JSONs, MSAF raw, BPM, algo clusters, MIR features, and custom-script results — everything regenerable. Triggers re-analysis for everyone the next time they open a song. Annotations and audio files are NOT affected."
              onAction={handleClearCaches}
              actionLabel={clearing ? 'Clearing…' : 'Clear caches'}
              disabled={!canAdmin || clearing}
            />
            <DangerRow
              label="Delete all songs"
              description="Remove every song from the dataset — audio, regenerable caches, AND every annotator's annotations for those songs. The member list and dataset settings stay intact."
              onAction={() => setDangerPending('songs')}
              actionLabel="Delete songs"
              disabled={!canAdmin}
            />
            <DangerRow
              label="Delete workspace"
              description="Wipes the entire dataset for this workspace: every song, every annotation, every annotator's saved sign-up profile, and dataset-config (members + admin list + lock state). You will lose admin and be signed out — the next sign-in re-bootstraps the workspace."
              onAction={() => setDangerPending('workspace')}
              actionLabel="Delete workspace"
              disabled={!canAdmin}
            />
            <DangerRow
              label="Factory reset"
              description="Full reset — wipes everything Delete workspace does, intended to also clear any future cross-dataset state. Today this is single-dataset and matches Delete workspace, but is wired through its own endpoint so multi-dataset support can extend it later."
              onAction={() => setDangerPending('factory')}
              actionLabel="Factory reset"
              disabled={!canAdmin}
            />
          </Section>
        </Group>

        <footer className="text-[10px] text-slate-600 pt-2">
          Settings key: <code>timecues.settings.v1</code> · Defaults version matches {Object.keys(DEFAULT_SETTINGS).length} fields.
        </footer>
      </div>

      {/* Shared confirmation dialog for the three corpus-wide destructive actions.
          Each scope has its own typed confirmation word so a slip on one option
          can't be reused to confirm a different one. */}
      <DeleteConfirmDialog
        open={dangerPending !== null}
        onOpenChange={(open) => { if (!open) setDangerPending(null); }}
        title={
          dangerPending === 'songs'    ? 'Delete ALL songs?' :
          dangerPending === 'workspace' ? 'Delete the workspace?' :
          dangerPending === 'factory'   ? 'Factory reset?' :
          ''
        }
        description={
          dangerPending === 'songs'    ? 'Every song in the dataset — audio, regenerable caches, and every annotator’s annotations for those songs — will be permanently removed. Dataset settings and the member list stay intact.' :
          dangerPending === 'workspace' ? 'Wipes every song (audio + caches + annotations), every annotator’s saved sign-up profile, and dataset-config (members + admin list + lock state). You will lose admin and be signed out.' :
          dangerPending === 'factory'   ? 'Full factory reset. Wipes the workspace and (in the multi-dataset future) any cross-dataset state. Today this matches Delete workspace. You will lose admin and be signed out.' :
          ''
        }
        confirmWord={
          dangerPending === 'songs'    ? 'DELETE_ALL_SONGS' :
          dangerPending === 'workspace' ? 'DELETE_WORKSPACE' :
          dangerPending === 'factory'   ? 'FACTORY_RESET' :
          'DELETE'
        }
        onConfirm={async () => {
          if (dangerPending) await runDanger(dangerPending);
          setDangerPending(null);
        }}
      />
    </div>
  );
}

// ── Tier + role banner ────────────────────────────────────────────────────
//
// `TierKey` extends `AccessTier` with the implicit 'public' bucket — emails
// not on the team get bucketed as public so the banner has something to show.

type TierKey = AccessTier | 'public';

const TIER_LABEL: Record<TierKey, string> = {
  admin:      'ADMIN',
  researcher: 'RESEARCHER',
  team:       'TEAM',
  public:     'PUBLIC',
};

const TIER_CAPABILITIES: Record<TierKey, string[]> = {
  admin: [
    'Manage members and assign tiers (admin / researcher / team)',
    'Configure corpus-wide vocabularies and label taxonomies',
    'Lock the dataset, upload songs, run any algorithm, export everything',
    'Clear caches and reset the corpus when needed',
  ],
  researcher: [
    'Full corpus access — annotate every song',
    'Run any algorithm and view all annotators’ outputs',
    'Upload songs and export cross-annotator data',
    'Cannot manage members or edit corpus-wide vocabularies',
  ],
  team: [
    'Full corpus access — annotate every song',
    'Create and edit your own annotations',
    'Cannot see other annotators’ work or run admin actions',
  ],
  public: [
    'Annotate the shipped default songs only',
    'The rest of the corpus unlocks once an admin adds you to the team',
  ],
};

const TIER_ACCENT: Record<TierKey, { border: string; text: string; bg: string; chip: string }> = {
  admin:      { border: 'border-amber-400/40',  text: 'text-amber-200',  bg: 'bg-amber-500/[0.06]',  chip: 'bg-amber-500/20 text-amber-200 border-amber-400/40' },
  researcher: { border: 'border-violet-400/40', text: 'text-violet-200', bg: 'bg-violet-500/[0.06]', chip: 'bg-violet-500/20 text-violet-200 border-violet-400/40' },
  team:       { border: 'border-cyan-400/40',   text: 'text-cyan-200',   bg: 'bg-cyan-500/[0.06]',   chip: 'bg-cyan-500/20 text-cyan-200 border-cyan-400/40' },
  public:     { border: 'border-slate-400/30',  text: 'text-slate-200',  bg: 'bg-slate-500/[0.06]',  chip: 'bg-slate-500/20 text-slate-200 border-slate-400/40' },
};

function RoleBanner({ tier, signedIn }: { tier: TierKey; signedIn: boolean }) {
  const accent = TIER_ACCENT[tier];
  return (
    <div className={`rounded border ${accent.border} ${accent.bg} px-4 py-3`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-slate-400">You are on the role:</span>
        <span className={`px-2 py-0.5 rounded-full border text-[11px] font-semibold tracking-wider ${accent.chip}`}>
          {TIER_LABEL[tier]}
        </span>
        {!signedIn && (
          <span className="text-[10px] text-slate-500">(not signed in — sign in to claim a higher tier)</span>
        )}
      </div>
      <p className={`text-[11px] mt-1.5 ${accent.text}`}>You can:</p>
      <ul className="mt-1 space-y-0.5">
        {TIER_CAPABILITIES[tier].map((line) => (
          <li key={line} className="text-[11px] text-slate-300 flex items-start gap-1.5">
            <span className={`mt-1 inline-block w-1 h-1 rounded-full shrink-0 ${accent.text.replace('text-', 'bg-')}`} aria-hidden />
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Group header that wraps a set of Sections under one category banner.
// When `locked`, the body is shown but interaction is suppressed and a small
// "Admin only" / lockReason badge is rendered next to the title.
function Group({
  icon,
  title,
  subtitle,
  accent,
  children,
  locked,
  lockReason,
}: {
  icon: 'user' | 'pencil' | 'lab' | 'shield' | 'warning';
  title: string;
  subtitle: string;
  accent: 'cyan' | 'indigo' | 'violet' | 'amber' | 'rose';
  children: ReactNode;
  locked?: boolean;
  lockReason?: string;
}) {
  const accentMap = {
    cyan:   { border: 'border-cyan-400/30',   text: 'text-cyan-200',   bg: 'bg-cyan-500/[0.04]'   },
    indigo: { border: 'border-indigo-400/30', text: 'text-indigo-200', bg: 'bg-indigo-500/[0.04]' },
    violet: { border: 'border-violet-400/30', text: 'text-violet-200', bg: 'bg-violet-500/[0.04]' },
    amber:  { border: 'border-amber-400/30',  text: 'text-amber-200',  bg: 'bg-amber-500/[0.04]'  },
    rose:   { border: 'border-rose-400/30',   text: 'text-rose-200',   bg: 'bg-rose-500/[0.04]'   },
  }[accent];

  return (
    <div className="space-y-3">
      <div className={`flex items-start gap-3 rounded border ${accentMap.border} ${accentMap.bg} px-4 py-3`}>
        <GroupIcon kind={icon} className={`w-5 h-5 mt-0.5 shrink-0 ${accentMap.text}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className={`text-base font-semibold ${accentMap.text}`}>{title}</h2>
            {locked && <LockBadge reason={lockReason} />}
          </div>
          <p className="text-[11px] text-slate-400 mt-0.5">{subtitle}</p>
        </div>
      </div>
      <div
        className={`space-y-3 pl-1 ${locked ? 'pointer-events-none opacity-50 select-none' : ''}`}
        aria-disabled={locked ? 'true' : undefined}
      >
        {children}
      </div>
    </div>
  );
}

// Read-only "Admin only" lock badge shown next to a category title when the
// current annotator's tier can't change anything inside that category.
function LockBadge({ reason }: { reason?: string }) {
  return (
    <span
      title={reason ?? 'You can view these settings but only an admin can change them.'}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-200 text-[10px] uppercase tracking-wider shrink-0"
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3" aria-hidden>
        <rect x="3" y="7" width="10" height="7" rx="1.5" />
        <path d="M5 7V5a3 3 0 0 1 6 0v2" />
      </svg>
      Admin only
    </span>
  );
}

// Inline "Admin only" tag for Sections inside otherwise-mixed groups (e.g. the
// corpus-wide portion of the Danger Zone).
function AdminOnlyBadge() {
  return (
    <span
      title="Only admins can run the actions in this section."
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-200 text-[10px] uppercase tracking-wider shrink-0"
    >
      Admin only
    </span>
  );
}

function GroupIcon({ kind, className }: { kind: 'user' | 'pencil' | 'lab' | 'shield' | 'warning'; className?: string }) {
  if (kind === 'user') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
      </svg>
    );
  }
  if (kind === 'pencil') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
        <path d="M14.5 3.5l6 6L9 21l-6 .5L3.5 15Z" />
        <path d="M13 5l6 6" />
      </svg>
    );
  }
  if (kind === 'lab') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
        <path d="M9 3v6L4 19a2 2 0 0 0 1.8 3h12.4A2 2 0 0 0 20 19L15 9V3" />
        <path d="M8 3h8" />
        <path d="M7 14h10" />
      </svg>
    );
  }
  if (kind === 'warning') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
        <path d="M12 3 L22 20 L2 20 Z" />
        <path d="M12 9 V14" />
        <circle cx="12" cy="17" r="0.9" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3Z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

// Row used inside the Danger Zone. Description on the left, single destructive
// button on the right. `comingSoon` marks UI stubs whose backend endpoint
// doesn't exist yet — the button stays clickable for admins (the onClick
// alert tells them so) but is visually muted so it's obvious it's not wired.
function DangerRow({
  label,
  description,
  onAction,
  actionLabel,
  disabled,
  comingSoon,
}: {
  label: string;
  description: string;
  onAction: () => void;
  actionLabel: string;
  disabled?: boolean;
  comingSoon?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-t border-white/[0.04] first:border-t-0 first:pt-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-slate-100 font-medium">{label}</span>
          {comingSoon && (
            <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-700/40 text-slate-300 border border-slate-600/40">
              UI stub
            </span>
          )}
        </div>
        <p className="text-[11px] text-slate-500 mt-0.5">{description}</p>
      </div>
      <button
        type="button"
        onClick={onAction}
        disabled={disabled}
        className={`px-3 py-1.5 rounded border text-xs transition shrink-0 ${
          disabled
            ? 'border-white/10 bg-white/[0.02] text-slate-500 cursor-not-allowed'
            : 'border-rose-700/50 bg-rose-900/20 text-rose-200 hover:bg-rose-900/40'
        }`}
      >
        {actionLabel}
      </button>
    </div>
  );
}

function Section({
  title,
  hint,
  headerExtra,
  defaultOpen = false,
  children,
}: {
  title: string;
  hint?: string;
  headerExtra?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="bg-[#14171d] border border-white/[0.08] rounded">
      <div className="flex items-start gap-3 p-4">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-start gap-2 flex-1 min-w-0 text-left hover:opacity-80 transition"
        >
          <svg
            viewBox="0 0 16 16"
            className={`w-3 h-3 mt-1 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <polyline points="5 3 11 8 5 13" />
          </svg>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm text-slate-100">{title}</h3>
            {hint && <p className="text-[11px] text-slate-500 mt-0.5">{hint}</p>}
          </div>
        </button>
        {headerExtra}
      </div>
      {open && <div className="px-4 pb-4 space-y-2">{children}</div>}
    </section>
  );
}

// "Local override" pill — shown next to a control when the annotator's local
// value differs from the admin-set dataset default. Clicking reset writes the
// dataset default back into local settings.
function OverrideBadge({ active, onReset }: { active: boolean; onReset: () => void }) {
  if (!active) return null;
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-200 text-[10px] uppercase tracking-wider shrink-0">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3" aria-hidden>
        <path d="M8 1.8 L14.5 13.5 L1.5 13.5 Z" />
        <path d="M8 6 V10" />
        <circle cx="8" cy="12" r="0.5" fill="currentColor" />
      </svg>
      Local override
      <button
        type="button"
        onClick={onReset}
        className="ml-1 normal-case tracking-normal underline-offset-2 hover:underline"
        title="Reset to dataset default"
      >
        reset
      </button>
    </span>
  );
}

// ── GPU tooling status (allin1 / Demucs availability) ─────────────────────────
//
// Drives the gated UI on the Prep + Inspector pages. The capability comes from
// /api/capabilities, which prefers a Docker-baked marker but falls back to a
// `python -c "import allin1; import demucs"` probe on the host. We show
// variant (cuda / cpu / host) and a speed hint so users can tell at a glance
// whether they're about to wait 30 seconds or 5 minutes per song.

const VARIANT_LABEL: Record<Capabilities['variant'], string> = {
  cuda:    'CUDA (demucs-gpu)',
  cpu:     'CPU torch (demucs-cpu)',
  host:    'host Python',
  unknown: '—',
};
const SPEED_LABEL: Record<Capabilities['speed'], string> = {
  fast:    'fast (~30–60s / song)',
  slow:    'slow (~3–5 min / song)',
  unknown: '—',
};

function statusChip(detected: boolean, speed: Capabilities['speed']): { label: string; cls: string } {
  if (!detected) return { label: 'not detected', cls: 'text-rose-300 bg-rose-950/40 border-rose-700/40' };
  if (speed === 'fast') return { label: 'detected · fast', cls: 'text-emerald-300 bg-emerald-950/40 border-emerald-700/40' };
  if (speed === 'slow') return { label: 'detected · slow', cls: 'text-amber-300 bg-amber-950/30 border-amber-700/40' };
  return { label: 'detected', cls: 'text-slate-300 bg-slate-800/40 border-white/10' };
}

function GpuToolingSection({
  gpuCaps,
  gpuLoading,
  refreshGpu,
}: {
  gpuCaps: Capabilities;
  gpuLoading: boolean;
  refreshGpu: () => Promise<void>;
}) {
  const overall = gpuCaps.allin1 || gpuCaps.demucs;
  const chip = statusChip(overall, gpuCaps.speed);
  const sourceLabel =
    gpuCaps.source === 'docker-marker' ? 'Docker marker'
    : gpuCaps.source === 'host-python' ? 'host Python probe'
    : 'no detection';

  return (
    <Section
      title="Optional GPU tooling"
      hint="allin1 (mir-aidj) and Demucs power the All-In-One algorithms and per-stem playback. They stay visible but disabled when unreachable."
      headerExtra={
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] uppercase tracking-wider shrink-0 ${chip.cls}`}>
          {gpuLoading ? 'checking…' : chip.label}
        </span>
      }
    >
      <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1 text-xs font-mono tabular-nums">
        <span className="text-slate-500">allin1</span>
        <span className={gpuCaps.allin1 ? 'text-emerald-400' : 'text-slate-500'}>
          {gpuCaps.allin1 ? 'available' : 'unavailable'}
        </span>

        <span className="text-slate-500">Demucs (htdemucs)</span>
        <span className={gpuCaps.demucs ? 'text-emerald-400' : 'text-slate-500'}>
          {gpuCaps.demucs ? 'available' : 'unavailable'}
        </span>

        <span className="text-slate-500">Variant</span>
        <span className="text-slate-300" title="cuda = demucs-gpu profile · cpu = demucs-cpu profile · host = local python install">
          {VARIANT_LABEL[gpuCaps.variant]}
        </span>

        <span className="text-slate-500">Speed</span>
        <span className={gpuCaps.speed === 'fast' ? 'text-emerald-400' : gpuCaps.speed === 'slow' ? 'text-amber-300' : 'text-slate-400'}>
          {SPEED_LABEL[gpuCaps.speed]}
        </span>

        <span className="text-slate-500">Source</span>
        <span className="text-slate-400">{sourceLabel}</span>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={refreshGpu}
          className="px-2.5 py-1 rounded border border-white/10 hover:border-white/20 text-xs"
          disabled={gpuLoading}
        >
          {gpuLoading ? 'Checking…' : 'Re-check'}
        </button>
        {!overall && (
          <span className="text-[11px] text-slate-500">
            Start <code className="text-slate-400">docker compose --profile demucs-cpu up</code> (or
            {' '}<code className="text-slate-400">--profile demucs-gpu</code> for CUDA hosts), or
            install <code className="text-slate-400">allin1</code> + <code className="text-slate-400">demucs</code> in the host Python env.
          </span>
        )}
      </div>
    </Section>
  );
}

function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] text-slate-400 block mb-1">{label}</span>
      {children}
    </label>
  );
}

/** Amber callout shown under an experimental-family toggle when its sidecar
 *  isn't reachable — the matching detectors aren't part of the running image,
 *  so the toggle is disabled until the profile is brought up. */
function ExpUnavailableNote() {
  return (
    <p className="text-[11px] text-amber-400/80">
      ⚠ Not detected — these detectors aren't part of the running image. Start
      the sidecars to enable:{' '}
      <code className="font-mono text-amber-300">
        docker compose --profile experimental-models up --build
      </code>
      , then Refresh.
    </p>
  );
}

function Toggle({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`flex items-center gap-2 text-xs select-none ${disabled ? 'text-slate-600 cursor-not-allowed' : 'text-slate-300 cursor-pointer'}`}>
      <input
        type="checkbox"
        checked={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-indigo-500 disabled:cursor-not-allowed"
      />
      <span>{label}</span>
    </label>
  );
}

