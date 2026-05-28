import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AutoGuessCentroidMethod } from '../types/manualAnnotation';
import type { BandPaletteId } from '../utils/bandPalettes';
import { DEFAULT_BAND_PALETTE } from '../utils/bandPalettes';
import { DEFAULT_VOCABULARY } from '../components/inspector-v2/sectionConstants';
import { GENRE_PRESETS, type GenrePresetKey } from '../components/inspector-v2/genrePresets';

const STORAGE_KEY = 'timecues.settings.v1';

export type TimeUnit = 'ms' | 'beats';
export type Theme = 'dark' | 'light' | 'system';

/** Genre presets shared with FillDefaultsModal — see {@link GENRE_PRESETS}. The keys
 *  here MUST match `GenrePresetKey` so single-select fill-default and multi-select
 *  vocabulary draw from the same list. */
export type ManualBoundariesPresetKey = GenrePresetKey;
/** `'custom'` means "use the user's free-form `manualBoundariesCustomLayout` instead of a preset". */
export type ManualBoundariesDefault = ManualBoundariesPresetKey | 'custom';

export interface UserSettings {
  // Theme
  theme: Theme;

  // Display + playback
  defaultSidebarCollapsed: boolean;
  defaultPlaybackRate: number; // 0.5 .. 2.0
  defaultShowWaveform: boolean;
  /** Color palette for the 3-band frequency waveform. */
  bandPalette: BandPaletteId;
  defaultShowSpectrogram: boolean;
  defaultShowEQ: boolean;
  defaultShowCepstrogram: boolean;
  defaultShowBeatGrid: boolean;

  /** Three configurable seek-arrow step sizes, in seconds.
   *  - small:  bound to plain `←/→`
   *  - medium: bound to `Shift + ←/→`
   *  - large:  bound to `Alt + ←/→`
   *  Defaults 1 / 5 / 10 match a generic video-editor "frame-step / chunk / page" feel. */
  seekStepSmallSeconds: number;
  seekStepMediumSeconds: number;
  seekStepLargeSeconds: number;

  // MIR signal overlays (the analysis curves below the waveform)
  defaultShowSignalOverlays: boolean;
  defaultShowEnergy: boolean;
  defaultShowBrightness: boolean;
  defaultShowNovelty: boolean;
  defaultShowOnsets: boolean;
  defaultShowFlux: boolean;
  defaultShowChroma: boolean;
  defaultShowTempogram: boolean;
  defaultShowSsm: boolean;

  // Annotations
  defaultShowManual: boolean;
  defaultShowEye: boolean;
  defaultShowAutoGuess: boolean;
  /** Time unit used in annotation editors / cue lists. */
  annotationTimeUnit: TimeUnit;
  /** Vocabulary used by the Manual/Eye section type dropdowns — flat de-duplicated list.
   *  This is the authoritative input the editors read; consumers don't look at genres. */
  sectionTypeVocabulary: string[];
  /** Which genre cards are toggled ON in the multi-select vocabulary UI.
   *  `null` = custom mode (the user is hand-editing `sectionTypeVocabulary`). When
   *  non-null, `sectionTypeVocabulary` is the de-duplicated union of these genres'
   *  vocabularies. Empty array = no genres selected, vocabulary frozen at prior union. */
  sectionVocabularyGenres: GenrePresetKey[] | null;

  // Algorithms — IDs that should be pre-selected when entering the inspector.
  defaultAlgorithms: string[];

  // BPM detection — which detector sources are surfaced in the BPM picker.
  // An empty array means "show all" (preserves current behavior for new users).
  enabledBpmDetectors: string[];

  // Auto-guess defaults
  autoGuessClusterTolerance: number; // seconds
  autoGuessCentroidMethod: AutoGuessCentroidMethod;
  autoGuessMinConsensus: number;
  /** Zoom multiplier at which per-point review buttons (play/pick/✓/✗) auto-expand
   *  in the Auto-Guess and custom-detector rows. Below this threshold each point
   *  shows only a single expand chevron, keeping the macro view less noisy.
   *  Set to 0 to always show the full button cluster (the legacy behavior). */
  autoGuessExpandZoomThreshold: number;

  // Experimental: Loops + Patterns annotation tabs. Off by default so they
  // stay hidden in shipped builds; flip on locally to test as the UI lands.
  // Boundaries (Manual), Cues, and Spans are always available.
  experimentalLoopsAndPatterns: boolean;
  // Experimental: Eye sub-tab under Boundaries (independent second observer
  // pass over the same structural sections). Hidden by default; flip on to
  // expose the Eye tab, editor, canvas overlay, and visibility toggle.
  experimentalEyeAnnotation: boolean;
  // Experimental: SPAN-family detection algorithms (Silero-VAD, JDCNet voicing,
  // future MIRFLEX). Output is voiced/instrument intervals. Hidden by default;
  // needs the `experimental-models` docker compose profile to be running so the
  // span server is reachable. Eval columns ship as `—` until the Phase 2 eval
  // rework lands.
  experimentalSpanFamily: boolean;
  // Experimental: CUE-family extensions (BeatNet — beats + downbeats + meter;
  // basic-pitch — polyphonic note transcription).
  // The CUE-family sidecars run on their own ports under the
  // `experimental-models` profile.
  experimentalCueExtras: boolean;
  // Experimental: LOOP-family detectors (chroma autocorrelation v0). Output is
  // `LoopItem[]` — labeled intervals representing seamless N-bar phrases.
  // Distinct from `experimentalLoopsAndPatterns` which gates the *manual*
  // loop annotation tab. This flag gates the *detector* outputs.
  experimentalLoopFamily: boolean;
  // Experimental: LYRICS family detectors (Whisper vocal transcription).
  // Output is `LyricsItem[]` (word- and line-level entries). Lazy-downloads
  // a ~140 MB Whisper-base checkpoint on first use.
  experimentalLyricsFamily: boolean;

  // Manual BOUNDARIES (sections) default — which layout the "⚡ Fill default"
  // button applies when there are no algorithm-suggested sections.
  manualBoundariesDefault: ManualBoundariesDefault;
  /** Custom "type:bars" list, used when manualBoundariesDefault === 'custom'. */
  manualBoundariesCustomLayout: string;

  // LOOPS — the two configurable quick-add bar sizes in the Loop editor.
  loopQuickAddBars: [number, number];

  // Evaluation — when ON, region layers (spans / loops / patterns) are scored
  // as if their whole layer were one set of alternative candidates of the same
  // event: a prediction that hits ANY item in the layer satisfies it, and the
  // others are not penalised as misses. Overrides each layer's per-layer mode
  // picker (`'multiple-candidates'`). Off ⇒ each layer's own mode is honoured
  // (default `'full-annotation'`). Does not affect cues/boundaries, which carry
  // their own per-item `candidates`.
  evalRegionLayersAsCandidates: boolean;

  // CUES / SPANS taxonomy — when enabled, the label input on cues/spans
  // surfaces these as autocomplete suggestions (free text is still accepted).
  cueTaxonomyEnabled: boolean;
  cueTaxonomy: string[];
  spanTaxonomyEnabled: boolean;
  spanTaxonomy: string[];

}

export const DEFAULT_SETTINGS: UserSettings = {
  theme: 'dark',

  defaultSidebarCollapsed: false,
  defaultPlaybackRate: 1,
  defaultShowWaveform: true,        // "3-Band" in the SIGNALS dropdown
  bandPalette: DEFAULT_BAND_PALETTE,
  defaultShowSpectrogram: false,
  defaultShowEQ: false,
  defaultShowCepstrogram: false,
  defaultShowBeatGrid: true,

  seekStepSmallSeconds: 1,
  seekStepMediumSeconds: 5,
  seekStepLargeSeconds: 10,

  defaultShowSignalOverlays: true,
  defaultShowEnergy: false,
  defaultShowBrightness: false,
  defaultShowNovelty: false,
  defaultShowOnsets: false,
  defaultShowFlux: false,
  defaultShowChroma: false,
  defaultShowTempogram: false,
  defaultShowSsm: false,

  defaultShowManual: true,
  defaultShowEye: true,
  defaultShowAutoGuess: true,
  annotationTimeUnit: 'ms',
  sectionTypeVocabulary: [...DEFAULT_VOCABULARY],
  sectionVocabularyGenres: null,

  defaultAlgorithms: [
    'msaf-sf', 'msaf-foote', 'msaf-cnmf', 'msaf-olda', 'allin1',
  ],

  enabledBpmDetectors: [],

  autoGuessClusterTolerance: 3,
  autoGuessCentroidMethod: 'mean',
  autoGuessMinConsensus: 1,
  autoGuessExpandZoomThreshold: 2,

  experimentalLoopsAndPatterns: false,
  experimentalEyeAnnotation: false,
  experimentalSpanFamily: false,
  experimentalCueExtras: false,
  experimentalLoopFamily: false,
  experimentalLyricsFamily: false,

  manualBoundariesDefault: 'house',
  manualBoundariesCustomLayout: 'intro:16, buildup:8, drop:32, breakdown:16, buildup:8, drop:32, outro:16',

  loopQuickAddBars: [4, 8],

  evalRegionLayersAsCandidates: false,

  cueTaxonomyEnabled: false,
  cueTaxonomy: ['kick', 'snare', 'hat', 'fx', 'vox'],
  spanTaxonomyEnabled: false,
  spanTaxonomy: ['vocals', 'pad', 'bass', 'lead', 'fx'],
};

/** Reverse-detect which genre cards' vocabularies, unioned, exactly reproduce
 *  `stored`. Returns the list of matching genre keys, or `null` if no exact cover
 *  exists (in which case the user falls into "custom" mode). Deterministic:
 *  iterates `GENRE_PRESETS` in declaration order, and prefers single-genre exact
 *  matches over multi-genre covers (so the canonical 7 maps to ['house'] alone,
 *  not ['house','mainstage','bass'] which all share that vocabulary). */
function detectVocabularyGenres(stored: readonly string[]): GenrePresetKey[] | null {
  const target = new Set(stored.map((s) => s.toLowerCase()));
  // 1. Single-genre exact match wins.
  for (const key of Object.keys(GENRE_PRESETS) as GenrePresetKey[]) {
    const vocab = GENRE_PRESETS[key].vocabulary.map((w) => w.toLowerCase());
    if (vocab.length !== target.size) continue;
    if (vocab.every((w) => target.has(w))) return [key];
  }
  // 2. Multi-genre exact cover: collect all subsets, accept if their union
  //    equals the target exactly.
  const matched: GenrePresetKey[] = [];
  const covered = new Set<string>();
  for (const key of Object.keys(GENRE_PRESETS) as GenrePresetKey[]) {
    const vocab = GENRE_PRESETS[key].vocabulary.map((w) => w.toLowerCase());
    if (vocab.every((w) => target.has(w))) {
      matched.push(key);
      for (const w of vocab) covered.add(w);
    }
  }
  if (covered.size !== target.size) return null;
  for (const w of target) if (!covered.has(w)) return null;
  return matched.length > 0 ? matched : null;
}

function readStored(): UserSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_SETTINGS;
    // Migrate pre-existing stores that only have `sectionTypeVocabulary` (a flat
    // list) but no `sectionVocabularyGenres` (the new multi-select state). Run the
    // reverse-detection once and write back so the Settings UI shows the right
    // cards highlighted on first open. If no exact cover exists, leave it as null
    // (custom mode), and the textarea will show the existing flat list.
    if (
      parsed.sectionVocabularyGenres === undefined &&
      Array.isArray(parsed.sectionTypeVocabulary)
    ) {
      parsed.sectionVocabularyGenres = detectVocabularyGenres(parsed.sectionTypeVocabulary);
    }
    // 2026-05-20 migration: experimentalAnnotationTypes split into two flags.
    // Old flag gated Spans+Loops+Patterns; Spans is now always-on so the old
    // setting maps cleanly onto Loops+Patterns. Eye gets its own new flag
    // defaulting to false (independent opt-in).
    if (
      parsed.experimentalLoopsAndPatterns === undefined &&
      parsed.experimentalAnnotationTypes !== undefined
    ) {
      parsed.experimentalLoopsAndPatterns = !!parsed.experimentalAnnotationTypes;
    }
    delete parsed.experimentalAnnotationTypes;
    return { ...DEFAULT_SETTINGS, ...parsed } as UserSettings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

let _currentSettings: UserSettings = DEFAULT_SETTINGS;

/** Read-anywhere accessor for the current settings. Used by code paths that
 *  initialize useState before SettingsProvider's value is in scope. */
export function getCurrentSettings(): UserSettings {
  return _currentSettings;
}

interface SettingsContextValue {
  settings: UserSettings;
  update: <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => void;
  reset: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<UserSettings>(() => {
    const s = readStored();
    _currentSettings = s;
    return s;
  });

  useEffect(() => {
    _currentSettings = settings;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* ignore quota */ }
  }, [settings]);

  // Apply theme attribute on <html> for CSS theme overrides. `system` honors
  // the OS preference and updates live when the user flips their OS theme.
  useEffect(() => {
    const apply = () => {
      const t = settings.theme === 'system'
        ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
        : settings.theme;
      document.documentElement.setAttribute('data-theme', t);
    };
    apply();
    if (settings.theme !== 'system') return;
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    mql.addEventListener('change', apply);
    return () => mql.removeEventListener('change', apply);
  }, [settings.theme]);

  const update = useCallback(<K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  const reset = useCallback(() => setSettings(DEFAULT_SETTINGS), []);

  const value = useMemo<SettingsContextValue>(() => ({ settings, update, reset }), [settings, update, reset]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}
