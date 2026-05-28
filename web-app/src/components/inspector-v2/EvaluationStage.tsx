import { useEffect, useMemo, useState } from 'react';
import type { AlgorithmRow } from './AlgoInspectStage';
import {
  isMirEvalResult,
  useMirEvalPairs,
  type MirEvalPairWithId,
  type MirEvalResult,
} from '../../services/mirEvalClient';
import { evaluateCustom, type AlgoEvalResult } from '../../utils/evaluation';
import { CustomEvalControls, DEFAULT_CUSTOM_EVAL_SETTINGS, type CustomEvalSettings } from './CustomEvalControls';
import { EvalReferenceDropdown } from './EvalReferenceDropdown';
import type { ManualSection } from '../../types/manualAnnotation';

// ─── Color helpers ────────────────────────────────────────────────────────────

function metricColor(value: number): string {
  const p = value * 100;
  if (p >= 70) return 'text-green-400';
  if (p >= 50) return 'text-yellow-400';
  if (p >= 30) return 'text-orange-400';
  return 'text-red-400';
}

function metricBg(value: number): string {
  const p = value * 100;
  if (p >= 70) return 'bg-green-900/20';
  if (p >= 50) return 'bg-yellow-900/20';
  if (p >= 30) return 'bg-orange-900/20';
  return 'bg-red-900/20';
}

// ─── Sort key type ────────────────────────────────────────────────────────────

type SortKey =
  | 'label' | 'sections'
  | 'precision' | 'recall' | 'f1' | 'hits'
  | 'cPrecision' | 'cRecall' | 'cF1' | 'mnbd' | 'csr';

function mnbdColor(value: number): string {
  if (value <= 0.5) return 'text-green-400';
  if (value <= 1.5) return 'text-yellow-400';
  if (value <= 3)   return 'text-orange-400';
  return 'text-red-400';
}

// ─── Props ────────────────────────────────────────────────────────────────────

function isRupturesId(id: string): boolean {
  return id.startsWith('ruptures-');
}

export interface EvaluationStageProps {
  annotationRows: AlgorithmRow[];
  manualSections: ManualSection[];
  eyeSections?: ManualSection[];
  /** When false, hide the Eye option from the eval-reference dropdown
   *  entirely (gated by the `experimentalEyeAnnotation` Settings flag). */
  eyeEnabled?: boolean;
  duration: number;
  tolerance: number;
  onToleranceChange: (t: number) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function EvaluationStage({
  annotationRows,
  manualSections,
  eyeSections = [],
  eyeEnabled = true,
  duration,
  tolerance,
  onToleranceChange,
}: EvaluationStageProps) {
  const [sortKey, setSortKey] = useState<SortKey>('f1');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [evalRef, setEvalRef] = useState<'manual' | 'eye'>('manual');
  const [customSettings, setCustomSettings] = useState<CustomEvalSettings>(DEFAULT_CUSTOM_EVAL_SETTINGS);

  // If the experimental Eye flag flips off while Eye was the eval reference,
  // fall back to manual so the (hidden) Eye option can't stay selected.
  useEffect(() => {
    if (!eyeEnabled && evalRef === 'eye') setEvalRef('manual');
  }, [eyeEnabled, evalRef]);

  const refSections = evalRef === 'manual' ? manualSections : eyeSections;

  // ── mir_eval (server-side via /api/mir-eval/pairs) — debounced ──────────
  const mirPairs = useMemo<MirEvalPairWithId[] | null>(() => {
    if (!refSections.length || duration <= 0 || !annotationRows.length) return null;
    const refTimes = refSections.map((s) => s.time);
    const pairs = annotationRows
      .filter((r) => r.sections.length > 0)
      .map((r) => ({
        id: r.id,
        refTimes,
        estTimes: r.sections.map((s) => s.time),
        tolerance,
        trackDuration: duration,
      }));
    return pairs.length ? pairs : null;
  }, [annotationRows, refSections, duration, tolerance]);

  const { results: mirResults, loading: mirLoading, error: mirError } = useMirEvalPairs(mirPairs);

  // ── Scheme-aware custom evaluator (client-side, instant) ──────────────────
  const customResults = useMemo<Record<string, AlgoEvalResult>>(() => {
    const out: Record<string, AlgoEvalResult> = {};
    if (!refSections.length || duration <= 0) return out;
    for (const { id, sections } of annotationRows) {
      if (!sections.length) continue;
      out[id] = evaluateCustom(refSections, sections.map((s) => s.time), duration, {
        toleranceSec: tolerance,
        optionalWeight: customSettings.optionalWeight,
        useSecondary: customSettings.useSecondary,
      });
    }
    return out;
  }, [annotationRows, refSections, duration, tolerance, customSettings.optionalWeight, customSettings.useSecondary]);

  const evalResults = useMemo((): Array<{
    id: string; label: string; sectionCount: number;
    mir: MirEvalResult | null;
    custom: AlgoEvalResult;
    isRuptures?: boolean;
  }> => {
    return annotationRows.flatMap(({ id, label, sections }) => {
      if (!sections.length) return [];
      const custom = customResults[id];
      if (!custom) return [];
      const entry = mirResults?.[id];
      const mir = isMirEvalResult(entry) ? entry : null;
      return [{ id, label, sectionCount: sections.length, mir, custom, isRuptures: isRupturesId(id) }];
    });
  }, [annotationRows, customResults, mirResults]);

  const sorted = useMemo(() => {
    const rows = [...evalResults];
    rows.sort((a, b) => {
      let diff = 0;
      switch (sortKey) {
        case 'label':    diff = a.label.localeCompare(b.label); break;
        case 'sections': diff = a.sectionCount - b.sectionCount; break;
        case 'precision': diff = (a.mir?.precision ?? 0) - (b.mir?.precision ?? 0); break;
        case 'recall':   diff = (a.mir?.recall    ?? 0) - (b.mir?.recall    ?? 0); break;
        case 'f1':       diff = (a.mir?.fmeasure  ?? 0) - (b.mir?.fmeasure  ?? 0); break;
        case 'hits':     diff = (a.mir?.hitCount  ?? 0) - (b.mir?.hitCount  ?? 0); break;
        case 'cPrecision': diff = a.custom.precision - b.custom.precision; break;
        case 'cRecall':    diff = a.custom.recall    - b.custom.recall;    break;
        case 'cF1':        diff = a.custom.f1        - b.custom.f1;        break;
        case 'mnbd':       diff = b.custom.mnbd      - a.custom.mnbd;      break; // lower is better — invert so desc still puts best on top
        case 'csr':        diff = a.custom.csr       - b.custom.csr;       break;
      }
      return sortDir === 'desc' ? -diff : diff;
    });
    return rows;
  }, [evalResults, sortKey, sortDir]);

  function handleSortClick(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  function SortArrow({ col }: { col: SortKey }) {
    if (sortKey !== col) return <span className="text-gray-700 ml-0.5">↕</span>;
    return <span className="text-indigo-400 ml-0.5">{sortDir === 'desc' ? '↓' : '↑'}</span>;
  }

  const bestRow  = sorted[0];
  const worstRow = sorted[sorted.length - 1];

  const noRef = !refSections.length;

  if (noRef) {
    return (
      <div className="py-6 text-center">
        <p className="text-sm text-gray-500">
          No {evalRef} annotation loaded.
        </p>
        <p className="text-[11px] text-gray-600 mt-1">
          Load a {evalRef} annotation in the Annotation tab, or switch the reference below.
        </p>
        <div className="mt-3 flex justify-center">
          <EvalReferenceDropdown
            value={evalRef}
            onChange={(mode) => {
              if (mode === 'manual' || mode === 'eye') setEvalRef(mode);
            }}
            options={[
              { mode: 'manual',      hasData: manualSections.length > 0 },
              ...(eyeEnabled ? [{ mode: 'eye' as const, hasData: eyeSections.length > 0 }] : []),
              { mode: 'autoGuess', hasData: false },
            ]}
          />
        </div>
      </div>
    );
  }

  const rupturesCount = useMemo(() => annotationRows.filter((r) => isRupturesId(r.id)).length, [annotationRows]);

  if (!annotationRows.length) {
    return (
      <div className="py-6 text-center">
        <p className="text-sm text-gray-500">No algorithm results loaded.</p>
        <p className="text-[11px] text-gray-600 mt-1">Algorithm JSONs are loaded automatically from <code className="text-gray-500">/analysis/</code>.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header + controls */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-gray-300">Evaluation Results</h3>
          <p className="text-[11px] text-gray-600 mt-0.5">
            {refSections.length} {evalRef} boundaries · {annotationRows.length} algorithms{rupturesCount > 0 ? ` (${rupturesCount} CPD)` : ''}
          </p>
        </div>

        {/* Evaluate against selector */}
        <EvalReferenceDropdown
          value={evalRef}
          onChange={(mode) => {
            if (mode === 'manual' || mode === 'eye') setEvalRef(mode);
          }}
          options={[
            { mode: 'manual',      hasData: manualSections.length > 0 },
            ...(eyeEnabled ? [{ mode: 'eye' as const, hasData: eyeSections.length > 0 }] : []),
            { mode: 'autoGuess', hasData: false },
          ]}
        />

        {/* Tolerance */}
        <div className="flex items-center gap-2 text-[11px] text-gray-500">
          <span>τ =</span>
          <input
            type="range" min="0.25" max="5" step="0.25"
            value={tolerance}
            onChange={(e) => onToleranceChange(Number(e.target.value))}
            className="w-20 accent-indigo-500"
          />
          <span className="font-mono text-gray-300 w-8">{tolerance}s</span>
        </div>
      </div>

      {/* Custom evaluator controls */}
      <div className="flex items-center gap-3 flex-wrap rounded border border-amber-800/40 bg-amber-950/10 px-3 py-1.5">
        <span className="text-[10px] text-amber-400 uppercase tracking-wide">Custom eval</span>
        <CustomEvalControls settings={customSettings} onChange={setCustomSettings} />
      </div>

      {/* Best / worst callouts (only when mir results are loaded) */}
      {sorted.length >= 2 && bestRow && worstRow && bestRow.id !== worstRow.id && bestRow.mir && worstRow.mir && (
        <div className="flex gap-3">
          <div className="flex-1 rounded-lg border border-green-800/50 bg-green-900/10 px-3 py-2">
            <div className="text-[10px] text-green-600 uppercase tracking-wide">Best</div>
            <div className="text-sm font-semibold text-green-300 mt-0.5">{bestRow.label}</div>
            <div className="text-[11px] font-mono text-green-400">F1 {Math.round(bestRow.mir.fmeasure * 100)}%</div>
          </div>
          <div className="flex-1 rounded-lg border border-red-900/40 bg-red-900/10 px-3 py-2">
            <div className="text-[10px] text-red-700 uppercase tracking-wide">Worst</div>
            <div className="text-sm font-semibold text-red-400 mt-0.5">{worstRow.label}</div>
            <div className="text-[11px] font-mono text-red-500">F1 {Math.round(worstRow.mir.fmeasure * 100)}%</div>
          </div>
        </div>
      )}

      {/* mir-eval fetch error banner */}
      {mirError && (
        <div className="rounded border border-red-900/50 bg-red-900/10 px-3 py-1.5 text-[11px] text-red-400">
          mir_eval server unreachable: {mirError}{' '}
          <span className="text-red-600">— run <code className="text-red-500">python tools/python/mir_eval_server.py</code></span>
        </div>
      )}

      {/* Results table */}
      <div className="rounded-lg border border-gray-800 overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-900 text-[9px] uppercase tracking-widest">
              <th colSpan={2} className="px-3 py-1 text-left text-gray-700 border-r border-gray-800/60">&nbsp;</th>
              <th colSpan={4} className="px-2 py-1 text-center text-indigo-400 border-r border-gray-800/60">
                mir_eval
                {mirLoading && (
                  <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-indigo-400 animate-pulse" title="updating…" />
                )}
              </th>
              <th colSpan={5} className="px-2 py-1 text-center text-amber-400">custom</th>
            </tr>
            <tr className="bg-gray-900 text-gray-500 text-[10px] uppercase tracking-wide">
              {([
                ['label', 'Algorithm', 'text-left', ''],
                ['sections', 'Sections', 'text-center', 'border-r border-gray-800/60'],
                ['precision', 'P', 'text-center', ''],
                ['recall', 'R', 'text-center', ''],
                ['f1', 'F1', 'text-center', ''],
                ['hits', 'Hits', 'text-center', 'border-r border-gray-800/60'],
                ['cPrecision', 'P', 'text-center', ''],
                ['cRecall', 'R', 'text-center', ''],
                ['cF1', 'F1', 'text-center', ''],
                ['mnbd', 'MNBD', 'text-center', ''],
                ['csr', 'CSR', 'text-center', ''],
              ] as [SortKey, string, string, string][]).map(([key, heading, align, extra]) => (
                <th
                  key={key}
                  className={`px-3 py-2 font-medium cursor-pointer hover:text-gray-300 select-none ${align} ${extra}`}
                  onClick={() => handleSortClick(key)}
                >
                  {heading}<SortArrow col={key} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/60">
            {sorted.map(({ id, label, sectionCount, mir, custom, isRuptures }, rank) => {
              const isTop = rank === 0 && sortKey === 'f1' && sortDir === 'desc' && mir !== null;
              const mirDim = mir === null ? 'opacity-40' : '';
              return (
                <tr key={id} className={`${isTop ? 'bg-green-900/5' : 'bg-gray-900/20'} hover:bg-gray-800/40 transition-colors`}>
                  <td className="px-3 py-2 font-medium text-gray-300">
                    <div className="flex items-center gap-1.5">
                      {isTop && <span className="text-green-500">★</span>}
                      {label}
                      {isRuptures && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-900/50 text-emerald-400 border border-emerald-800/60 leading-none">
                          CPD
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-center font-mono text-gray-500 border-r border-gray-800/60">{sectionCount}</td>
                  <td className={`px-3 py-2 text-center font-mono font-semibold ${mir ? `${metricColor(mir.precision)} ${metricBg(mir.precision)}` : 'text-gray-600'} rounded ${mirDim}`}>
                    {mir ? `${Math.round(mir.precision * 100)}%` : '—'}
                  </td>
                  <td className={`px-3 py-2 text-center font-mono font-semibold ${mir ? `${metricColor(mir.recall)} ${metricBg(mir.recall)}` : 'text-gray-600'} rounded ${mirDim}`}>
                    {mir ? `${Math.round(mir.recall * 100)}%` : '—'}
                  </td>
                  <td className={`px-3 py-2 text-center font-mono font-semibold ${mir ? `${metricColor(mir.fmeasure)} ${metricBg(mir.fmeasure)}` : 'text-gray-600'} rounded ${mirDim}`}>
                    {mir ? `${Math.round(mir.fmeasure * 100)}%` : '—'}
                  </td>
                  <td className={`px-3 py-2 text-center font-mono text-gray-500 border-r border-gray-800/60 ${mirDim}`}>
                    {mir ? `${mir.hitCount}/${mir.refCount}` : '—'}
                  </td>
                  <td className={`px-3 py-2 text-center font-mono font-semibold ${metricColor(custom.precision)} ${metricBg(custom.precision)} rounded`}>
                    {Math.round(custom.precision * 100)}%
                  </td>
                  <td className={`px-3 py-2 text-center font-mono font-semibold ${metricColor(custom.recall)} ${metricBg(custom.recall)} rounded`}>
                    {Math.round(custom.recall * 100)}%
                  </td>
                  <td className={`px-3 py-2 text-center font-mono font-semibold ${metricColor(custom.f1)} ${metricBg(custom.f1)} rounded`}>
                    {Math.round(custom.f1 * 100)}%
                  </td>
                  <td className={`px-3 py-2 text-center font-mono ${mnbdColor(custom.mnbd)}`} title="Mean Nearest-Boundary Distance (s) — lower is better">
                    {custom.mnbd.toFixed(2)}s
                  </td>
                  <td className={`px-3 py-2 text-center font-mono ${metricColor(custom.csr)}`} title="Critical Section Recall — fraction of critical (★) manual sections hit">
                    {custom.criticalCount > 0 ? `${Math.round(custom.csr * 100)}%` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] text-gray-700">
        <span className="text-indigo-400/80">mir_eval</span>: strict bipartite boundary matching, no importance weighting.{' '}
        <span className="text-amber-400/80">custom</span>: applies optional-weight = {customSettings.optionalWeight.toFixed(2)}; MNBD = mean nearest-boundary distance, CSR = critical section recall.
        Both evaluators {customSettings.useSecondary ? 'count candidate alternates as valid hits' : 'ignore candidate alternates (primary boundary only)'}.
        Both at τ = {tolerance}s vs <strong className="text-gray-500">{evalRef}</strong> ({refSections.length} boundaries).
        {rupturesCount > 0 && <> Ruptures CPD methods marked <span className="text-emerald-600">CPD</span>.</>}
      </p>
    </div>
  );
}
