/**
 * FillDefaultsModal — pre-fill a new manual annotation from a genre preset,
 * an equal-bar split, or a custom "type:bars" list. Bars are converted to
 * seconds using the song's BPM + time signature; sections starting past the
 * song's duration are trimmed.
 */

import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { ManualSection } from '../../types/manualAnnotation';
import { ALLOWED_SECTION_TYPES, SECTION_TYPES, sectionColor, sectionLabel, fmtTime } from './sectionConstants';
import { GENRE_PRESETS, type GenrePresetKey, type BarEntry } from './genrePresets';
import type { ManualBoundariesPresetKey } from '../../context/SettingsContext';
import { useSettings } from '../../context/SettingsContext';

export type { BarEntry } from './genrePresets';

/** Re-export of {@link GENRE_PRESETS} for the fill-default UI. The modal only reads
 *  `name`, `description`, and `layout`; the bundled `vocabulary` field is harmless here. */
export const PRESETS: Record<ManualBoundariesPresetKey, typeof GENRE_PRESETS[GenrePresetKey]> = GENRE_PRESETS;

export type PresetKey = GenrePresetKey;
type Mode = PresetKey | 'equal' | 'custom';

function secsPerBar(bpm: number, beatsPerBar: number): number {
  return (60 / bpm) * beatsPerBar;
}

export function layoutToSections(
  layout: readonly BarEntry[],
  bpm: number,
  beatsPerBar: number,
  duration: number,
): ManualSection[] {
  if (!bpm || bpm <= 0 || layout.length === 0) return [];
  const spb = secsPerBar(bpm, beatsPerBar);
  let t = 0;
  const out: ManualSection[] = [];
  for (const { type, bars } of layout) {
    if (duration > 0 && t >= duration) break;
    out.push({ time: Math.round(t * 1000) / 1000, type, label: sectionLabel(type) });
    t += spb * bars;
  }
  return out;
}

export function parseCustomLayout(text: string): { layout: BarEntry[]; errors: string[] } {
  const parts = text.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  const errors: string[] = [];
  const layout: BarEntry[] = [];
  for (const part of parts) {
    const m = part.match(/^([a-z]+)\s*:\s*(\d+(?:\.\d+)?)$/i);
    if (!m) {
      errors.push(`Bad entry "${part}" — use type:bars (e.g. "drop:32")`);
      continue;
    }
    const type = m[1].toLowerCase();
    const bars = Number(m[2]);
    if (!ALLOWED_SECTION_TYPES.has(type)) {
      errors.push(`Unknown type "${type}" — allowed: ${SECTION_TYPES.join(', ')}`);
      continue;
    }
    if (!isFinite(bars) || bars <= 0) {
      errors.push(`Bad bar count in "${part}"`);
      continue;
    }
    layout.push({ type, bars });
  }
  return { layout, errors };
}

function buildEqualLayout(barsPer: number, bpm: number, beatsPerBar: number, duration: number): BarEntry[] {
  if (!bpm || bpm <= 0 || !duration || !barsPer || barsPer <= 0) return [];
  const sec = secsPerBar(bpm, beatsPerBar) * barsPer;
  const n = Math.max(1, Math.floor(duration / sec));
  const middle = ['buildup', 'drop', 'breakdown'];
  const out: BarEntry[] = [];
  for (let i = 0; i < n; i++) {
    const type =
      i === 0 ? 'intro' :
      i === n - 1 && n > 1 ? 'outro' :
      middle[(i - 1) % middle.length];
    out.push({ type, bars: barsPer });
  }
  return out;
}

export interface FillDefaultsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bpm: number;
  beatsPerBar: number;
  duration: number;
  onApply: (sections: ManualSection[]) => void;
}

export function FillDefaultsModal({ open, onOpenChange, bpm, beatsPerBar, duration, onApply }: FillDefaultsModalProps) {
  const { settings, update } = useSettings();
  const [mode, setMode] = useState<Mode>(settings.manualBoundariesDefault);
  const [equalBars, setEqualBars] = useState('16');
  const [customText, setCustomText] = useState(settings.manualBoundariesCustomLayout);
  const [shrinkToFit, setShrinkToFit] = useState(false);

  // Reset to user's saved defaults on the rising edge of `open`. Tracked via a
  // mirrored state value so we can detect the change during render (React's
  // recommended pattern for "reset state when a prop changes") rather than
  // setState-in-effect.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setMode(settings.manualBoundariesDefault);
      setCustomText(settings.manualBoundariesCustomLayout);
      setShrinkToFit(false);
    }
  }

  const customParsed = useMemo(() => parseCustomLayout(customText), [customText]);

  const rawLayout = useMemo<readonly BarEntry[]>(() => {
    if (mode === 'equal') return buildEqualLayout(Number(equalBars) || 0, bpm, beatsPerBar, duration);
    if (mode === 'custom') return customParsed.layout;
    return PRESETS[mode].layout;
  }, [mode, equalBars, customParsed.layout, bpm, beatsPerBar, duration]);

  const rawTotalBars = rawLayout.reduce((a, b) => a + b.bars, 0);
  const songBars = bpm > 0 && duration > 0 ? Math.floor(duration / secsPerBar(bpm, beatsPerBar)) : 0;
  const rawExceedsSong = songBars > 0 && rawTotalBars > songBars;
  const shrinkScale = shrinkToFit && rawExceedsSong && rawTotalBars > 0
    ? songBars / rawTotalBars
    : 1;
  // When shrink is active, scale each section's bar count so the ratios are
  // preserved but the total fits within the song. `layoutToSections` accepts
  // fractional bars (it just multiplies by seconds-per-bar).
  const layout = useMemo<readonly BarEntry[]>(
    () => shrinkScale === 1 ? rawLayout : rawLayout.map(({ type, bars }) => ({ type, bars: bars * shrinkScale })),
    [rawLayout, shrinkScale],
  );

  const previewSections = useMemo(
    () => layoutToSections(layout, bpm, beatsPerBar, duration),
    [layout, bpm, beatsPerBar, duration],
  );

  const totalBars = layout.reduce((a, b) => a + b.bars, 0);
  const totalSecs = bpm > 0 ? totalBars * secsPerBar(bpm, beatsPerBar) : 0;
  const placedCount = previewSections.length;
  const droppedCount = layout.length - placedCount;
  const exceedsSong = songBars > 0 && totalBars > songBars;
  const usedPct = songBars > 0 ? Math.min(100, Math.round((totalBars / songBars) * 100)) : 0;

  const canApply = previewSections.length > 0 && (mode !== 'custom' || customParsed.errors.length === 0);

  // "Set as default" persists the current selection to user settings so it's
  // pre-selected next time. Equal-sections layouts adapt to each song's length
  // and aren't representable as a stored default, so they're excluded.
  const canSaveDefault = mode === 'custom'
    ? customParsed.errors.length === 0 && customParsed.layout.length > 0
    : mode !== 'equal';
  const currentIsDefault = mode === 'custom'
    ? settings.manualBoundariesDefault === 'custom'
      && settings.manualBoundariesCustomLayout.trim() === customText.trim()
    : mode !== 'equal' && settings.manualBoundariesDefault === mode;
  const setDefaultTitle = mode === 'equal'
    ? "Equal-sections layouts adapt to each song's length, so they can't be saved as a default — pick a preset or a custom list."
    : !canSaveDefault
      ? 'Fix the custom layout before saving it as the default.'
      : 'Use this structure as the default — it will be pre-selected for every song from now on.';

  const handleApply = () => {
    if (!canApply) return;
    onApply(previewSections);
    onOpenChange(false);
  };

  const handleSetDefault = () => {
    if (!canSaveDefault || currentIsDefault) return;
    if (mode === 'custom') {
      update('manualBoundariesCustomLayout', customText);
      update('manualBoundariesDefault', 'custom');
    } else {
      update('manualBoundariesDefault', mode as ManualBoundariesPresetKey);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[101] w-[min(680px,95vw)] max-h-[90vh] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-white/[0.08] bg-[#14171d] shadow-2xl shadow-black/70 outline-none flex flex-col"
          onKeyDown={(e) => { if (e.key === 'Enter' && canApply && mode !== 'custom') handleApply(); }}
        >
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
            <Dialog.Title className="text-[12px] font-semibold tracking-[0.18em] uppercase text-amber-300">
              Choose structure
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="text-slate-500 hover:text-slate-200 text-lg leading-none w-6 h-6 flex items-center justify-center rounded hover:bg-white/[0.06]"
                aria-label="Close"
              >×</button>
            </Dialog.Close>
          </div>

          <div className="px-5 py-4 space-y-3 overflow-y-auto">
            <p className="text-[11px] text-slate-400">
              Pick a preset to pre-fill the manual annotation. Bars convert to seconds using the song's BPM
              ({bpm > 0 ? bpm : <span className="text-amber-400">missing</span>})
              and {beatsPerBar}/4 time signature.
              {songBars > 0 && (
                <> Song fits ~<span className="text-slate-200 font-mono">{songBars}</span> bars (<span className="font-mono">{fmtTime(duration)}</span>).</>
              )}
            </p>

            <div className="space-y-1.5">
              {(Object.keys(PRESETS) as PresetKey[]).map((key) => (
                <PresetRow
                  key={key}
                  selected={mode === key}
                  name={PRESETS[key].name}
                  description={PRESETS[key].description}
                  layout={PRESETS[key].layout}
                  songBars={songBars}
                  onClick={() => setMode(key)}
                />
              ))}
            </div>

            <div className={`rounded border transition-colors ${mode === 'equal' ? 'border-amber-400/40 bg-amber-500/[0.04]' : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]'}`}>
              <button onClick={() => setMode('equal')} className="w-full text-left px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[12px] text-slate-100 font-medium">Equal sections of X bars</div>
                  <div className="text-[10px] text-slate-500 font-mono">auto-count from song length</div>
                </div>
                <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                  Splits the song into N equal sections. First = Intro, last = Outro, middle cycle through buildup → drop → breakdown.
                </div>
              </button>
              <div className="px-3 pb-3 flex items-center gap-2 flex-wrap">
                <label className="text-[11px] text-slate-400 font-mono">Bars per section:</label>
                <input
                  type="number"
                  min={1}
                  value={equalBars}
                  onChange={(e) => { setEqualBars(e.target.value); setMode('equal'); }}
                  onFocus={() => setMode('equal')}
                  className="w-20 px-2 py-1 rounded bg-black/40 border border-white/[0.08] text-[12px] font-mono text-slate-100 focus:outline-none focus:border-amber-400/50"
                />
                {mode === 'equal' && (
                  <span className="text-[10px] text-slate-500 font-mono">→ {placedCount} section{placedCount === 1 ? '' : 's'}</span>
                )}
              </div>
            </div>

            <div className={`rounded border transition-colors ${mode === 'custom' ? 'border-amber-400/40 bg-amber-500/[0.04]' : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]'}`}>
              <button onClick={() => setMode('custom')} className="w-full text-left px-3 py-2">
                <div className="text-[12px] text-slate-100 font-medium">Custom — type:bars list</div>
                <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                  Comma-separated. Example: <span className="text-slate-300">intro:32, buildup:8, drop:32, breakdown:16, buildup:8, drop:32, outro:32</span>
                </div>
              </button>
              <div className="px-3 pb-3 space-y-2">
                <input
                  type="text"
                  value={customText}
                  onChange={(e) => { setCustomText(e.target.value); setMode('custom'); }}
                  onFocus={() => setMode('custom')}
                  placeholder="intro:16, drop:32, outro:16"
                  className="w-full px-2 py-1.5 rounded bg-black/40 border border-white/[0.08] text-[12px] font-mono text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-amber-400/50"
                />
                {mode === 'custom' && customParsed.errors.length > 0 && (
                  <div className="space-y-0.5">
                    {customParsed.errors.map((err, i) => (
                      <div key={i} className="text-[10px] text-rose-400 font-mono">⚠ {err}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="pt-2 border-t border-white/[0.06] space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="text-[10px] uppercase tracking-wider text-slate-500 font-mono">
                  Preview · {placedCount} section{placedCount === 1 ? '' : 's'} ·{' '}
                  <span className={exceedsSong ? 'text-rose-400' : 'text-slate-300'}>
                    {totalBars % 1 === 0 ? totalBars : totalBars.toFixed(1)}
                    {songBars > 0 && <> / {songBars}</>} bars
                  </span>
                  {songBars > 0 && <span className="text-slate-600"> ({usedPct}%)</span>}
                  {' '}(~{fmtTime(totalSecs)})
                </div>
                {droppedCount > 0 && (
                  <div className="text-[10px] text-amber-400 font-mono">{droppedCount} trimmed (past song end)</div>
                )}
              </div>
              {songBars > 0 && (
                <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
                  <div
                    className={`h-full transition-all ${exceedsSong ? 'bg-rose-400/70' : 'bg-amber-400/60'}`}
                    style={{ width: `${usedPct}%` }}
                  />
                </div>
              )}
              {rawExceedsSong && (
                <label
                  className="flex items-start gap-2 text-[11px] text-slate-300 cursor-pointer select-none py-1"
                  title="Multiplies every section's bar count by the same factor so the ratios are preserved and the whole layout fits within the song."
                >
                  <input
                    type="checkbox"
                    checked={shrinkToFit}
                    onChange={(e) => setShrinkToFit(e.target.checked)}
                    className="mt-0.5 accent-amber-400"
                  />
                  <span>
                    Shrink to fit song length
                    <span className="text-slate-500 font-mono">
                      {' '}— keep ratios, scale each section by ×{(songBars / rawTotalBars).toFixed(2)}
                    </span>
                  </span>
                </label>
              )}
              {exceedsSong && !shrinkToFit && (
                <div className="text-[10px] text-rose-400 font-mono">
                  ⚠ Layout exceeds song by {(totalBars - songBars).toFixed(totalBars % 1 === 0 ? 0 : 1)} bar{Math.abs(totalBars - songBars) === 1 ? '' : 's'} — extra sections will be trimmed.
                </div>
              )}
              {previewSections.length === 0 && (
                <div className="text-[11px] text-slate-600 font-mono">
                  {bpm > 0 ? 'No sections to place — check inputs.' : 'Set the song BPM to enable filling defaults.'}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-white/[0.06]">
            <div className="flex items-center min-w-0">
              {currentIsDefault ? (
                <span
                  className="inline-flex items-center gap-1.5 text-[11px] text-amber-300/90 font-medium"
                  title="This structure is your saved default — it's pre-selected whenever you open this dialog."
                >
                  <span aria-hidden>★</span> Default structure
                </span>
              ) : (
                <button
                  type="button"
                  onClick={handleSetDefault}
                  disabled={!canSaveDefault}
                  title={setDefaultTitle}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] transition-colors ${
                    canSaveDefault
                      ? 'text-slate-400 hover:text-amber-200 hover:bg-white/[0.06]'
                      : 'text-slate-600 cursor-not-allowed'
                  }`}
                >
                  <span aria-hidden>☆</span> Set as default
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Dialog.Close asChild>
                <button className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 transition-colors">
                  Cancel
                </button>
              </Dialog.Close>
              <button
                onClick={handleApply}
                disabled={!canApply}
                className={`px-4 py-1.5 rounded text-[11px] uppercase tracking-wider transition-colors ${
                  canApply
                    ? 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 border border-amber-400/50'
                    : 'bg-white/[0.04] text-slate-600 border border-white/[0.06] cursor-not-allowed'
                }`}
              >
                Apply
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface PresetRowProps {
  selected: boolean;
  name: string;
  description: string;
  layout: readonly BarEntry[];
  songBars: number;
  onClick: () => void;
}

function PresetRow({ selected, name, description, layout, songBars, onClick }: PresetRowProps) {
  const totalBars = layout.reduce((a, b) => a + b.bars, 0);
  const exceeds = songBars > 0 && totalBars > songBars;
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded border px-3 py-2 transition-colors ${
        selected
          ? 'border-amber-400/40 bg-amber-500/[0.04]'
          : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] text-slate-100 font-medium">{name}</div>
        <div className={`text-[10px] font-mono ${exceeds ? 'text-rose-400' : 'text-slate-500'}`}>
          {totalBars} bars · {layout.length} sections
          {exceeds && <> · exceeds by {totalBars - songBars}</>}
        </div>
      </div>
      <div className="text-[10px] text-slate-500 font-mono mt-0.5 leading-relaxed">{description}</div>
      <div className="flex flex-wrap gap-1 mt-1.5">
        {layout.map((entry, i) => (
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
}
