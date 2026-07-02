import { useEffect, useMemo, useState } from 'react';
import { annotatorHeaders } from '../utils/annotatorHeaders';
import type { ManualAnnotation, AutoGuessManualAnnotation } from '../types/manualAnnotation';
import {
  autoGuessBoundaries,
  buildAgreementMatrix,
  type AgreementMatrix,
} from '../utils/annotatorAgreement';
import type { BoundarySource } from './inspector-v2/shared/tabConfig';

/** The comparison panel picks among the boundary sources. */
type AnnotationKind = BoundarySource;

interface AllAnnotationsResponse {
  slug: string;
  manual: Record<string, ManualAnnotation>;
  autoGuess: Record<string, AutoGuessManualAnnotation>;
}

const KIND_LABEL: Record<AnnotationKind, string> = {
  manual: 'Boundaries',
  autoGuess: 'Auto-guess',
};

const TOLERANCES = [0.5, 3] as const;

export function AnnotatorComparisonPanel({ slug }: { slug: string }) {
  const KINDS: AnnotationKind[] = useMemo(
    () => ['manual', 'autoGuess'],
    [],
  );
  const [data, setData] = useState<AllAnnotationsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [kind, setKind] = useState<AnnotationKind>('manual');

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    setErr(null);
    setData(null);
    fetch(`/api/annotations/${encodeURIComponent(slug)}/all`, {
      headers: annotatorHeaders(),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<AllAnnotationsResponse>;
      })
      .then(setData)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [slug]);

  const matricesByKind = useMemo(() => {
    if (!data) return null;
    const out: Partial<Record<AnnotationKind, Record<number, AgreementMatrix>>> = {};

    for (const k of KINDS) {
      const bucket = data[k];
      const ids = Object.keys(bucket).sort();
      if (ids.length < 2) continue;
      const perTol: Record<number, AgreementMatrix> = {};
      for (const tol of TOLERANCES) {
        if (k === 'autoGuess') {
          perTol[tol] = buildAgreementMatrix(
            ids,
            (id) => autoGuessBoundaries(bucket[id] as AutoGuessManualAnnotation).map((t) => ({ time: t, type: '' })),
            tol,
          );
        } else {
          perTol[tol] = buildAgreementMatrix(
            ids,
            (id) => (bucket[id] as ManualAnnotation).sections.map((s) => ({ time: s.time, type: s.type })),
            tol,
          );
        }
      }
      out[k] = perTol;
    }
    return out;
  }, [data, KINDS]);

  const availableKinds = useMemo<AnnotationKind[]>(() => {
    if (!data) return [];
    return KINDS.filter((k) => Object.keys(data[k]).length >= 2);
  }, [data, KINDS]);

  // Auto-select an available kind when current selection has no comparison
  useEffect(() => {
    if (availableKinds.length > 0 && !availableKinds.includes(kind)) {
      setKind(availableKinds[0]);
    }
  }, [availableKinds, kind]);

  if (loading) {
    return <Shell><p className="text-xs text-slate-500">Loading…</p></Shell>;
  }
  if (err) {
    return <Shell><p className="text-xs text-red-400">Failed to load: {err}</p></Shell>;
  }
  if (!data) return null;

  const totalAnnotators = new Set([
    ...Object.keys(data.manual),
    ...Object.keys(data.autoGuess),
  ]).size;

  if (totalAnnotators < 2) {
    return (
      <Shell>
        <p className="text-xs text-slate-500">
          Only one annotator has data for this song so far — nothing to compare yet.
        </p>
      </Shell>
    );
  }

  if (availableKinds.length === 0) {
    return (
      <Shell>
        <p className="text-xs text-slate-500">
          {totalAnnotators} annotators have data, but no single annotation type
          has ≥2 entries to compare. Save the same type as another annotator to compare.
        </p>
      </Shell>
    );
  }

  const matrices = matricesByKind?.[kind];

  return (
    <Shell>
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="text-[11px] text-slate-400">
          {totalAnnotators} annotators have data for this song
        </div>
        <nav className="flex gap-1 text-[10px] uppercase tracking-wider">
          {availableKinds.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`px-2 py-0.5 rounded transition-colors ${
                kind === k
                  ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-400/40'
                  : 'bg-white/[0.04] text-slate-500 hover:text-slate-300 border border-transparent'
              }`}
            >
              {KIND_LABEL[k]} ({Object.keys(data[k]).length})
            </button>
          ))}
        </nav>
      </div>

      {matrices && (
        <div className="space-y-4">
          {TOLERANCES.map((tol) => (
            <MatrixView key={tol} matrix={matrices[tol]} tolerance={tol} kind={kind} />
          ))}
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-white/[0.06] bg-[#14171d]/60 p-4">
      <header className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-200 mb-2">
        Annotator comparison
      </header>
      {children}
    </section>
  );
}

function MatrixView({ matrix, tolerance, kind }: { matrix: AgreementMatrix; tolerance: number; kind: AnnotationKind }) {
  const ids = matrix.ids;
  const showLabels = kind !== 'autoGuess';

  return (
    <div>
      <div className="text-[11px] text-slate-400 mb-1.5">
        Boundary F1 (±{tolerance}s)
      </div>
      <div className="overflow-x-auto">
        <table className="text-[11px] border-separate border-spacing-0">
          <thead>
            <tr>
              <th className="px-2 py-1 text-slate-500 text-left font-normal sticky left-0 bg-[#14171d]">
                <span className="opacity-0">x</span>
              </th>
              {ids.map((id) => (
                <th
                  key={id}
                  className="px-2 py-1 text-slate-400 font-normal text-left whitespace-nowrap"
                  title={`${matrix.counts[id]} boundaries`}
                >
                  <IdChip id={id} />
                  <span className="text-slate-600 ml-1">·{matrix.counts[id]}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ids.map((rowId, i) => (
              <tr key={rowId}>
                <td className="px-2 py-1 text-slate-400 font-medium text-left whitespace-nowrap sticky left-0 bg-[#14171d]">
                  <IdChip id={rowId} />
                </td>
                {ids.map((colId, j) => {
                  if (i === j) {
                    return (
                      <td key={colId} className="px-2 py-1 text-slate-700 text-center">—</td>
                    );
                  }
                  const f1 = matrix.f1[i][j];
                  const lab = matrix.labels[i][j];
                  return (
                    <td
                      key={colId}
                      className="px-2 py-1 text-center"
                      style={{ background: f1Color(f1) }}
                      title={`${rowId} → ${colId}: F1=${f1.toFixed(3)}${
                        showLabels && lab !== null ? `, label=${(lab * 100).toFixed(0)}%` : ''
                      }`}
                    >
                      <div className="text-slate-100 tabular-nums">{f1.toFixed(2)}</div>
                      {showLabels && lab !== null && (
                        <div className="text-[9px] text-slate-400 tabular-nums">
                          {(lab * 100).toFixed(0)}%
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showLabels && (
        <div className="text-[10px] text-slate-600 mt-1">
          Top number = boundary F1. Bottom = % of matched boundaries with same section type.
        </div>
      )}
    </div>
  );
}

function IdChip({ id }: { id: string }) {
  const short = id.length > 22 ? `${id.slice(0, 11)}…${id.slice(-8)}` : id;
  return (
    <span
      className="inline-block px-1.5 py-0.5 rounded text-[10px] bg-cyan-900/40 text-cyan-200"
      title={id}
    >
      {short}
    </span>
  );
}

function f1Color(f1: number): string {
  // 0 → near-transparent slate; 1 → vivid green
  if (!Number.isFinite(f1)) return 'transparent';
  const a = Math.max(0.04, Math.min(1, f1)) * 0.35;
  return `rgba(34, 197, 94, ${a.toFixed(2)})`;
}
