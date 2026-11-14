import { useEffect, useMemo, useState } from 'react';
import { annotatorHeaders } from '../utils/annotatorHeaders';
import type { AnnotationLayersDocument } from '../types/annotationLayer';
import { primaryBoundaryItems } from '../services/annotationLayers';
import { buildAgreementMatrix, type AgreementMatrix } from '../utils/annotatorAgreement';

/** One comparison per annotation layer type. Boundaries compare each
 *  annotator's primary boundaries layer (one reference reading); every other
 *  type pools all of that annotator's layers of the type and compares item
 *  onsets (`time`, or `start` for spans / loops / riffs). */
type AnnotationKind = 'boundaries' | 'cues' | 'spans' | 'loops' | 'riff-patterns' | 'lyrics';

const KINDS: AnnotationKind[] = ['boundaries', 'cues', 'spans', 'loops', 'riff-patterns', 'lyrics'];

interface AllAnnotationsResponse {
  slug: string;
  /** One annotation-layers document per annotator. */
  layers: Record<string, AnnotationLayersDocument>;
}

const KIND_LABEL: Record<AnnotationKind, string> = {
  boundaries: 'Boundaries',
  cues: 'Cues',
  spans: 'Spans',
  loops: 'Loops',
  'riff-patterns': 'Riff Patterns',
  lyrics: 'Lyrics',
};

/** What one item is called, for headers and the footnote. */
const KIND_NOUN: Record<AnnotationKind, string> = {
  boundaries: 'boundaries',
  cues: 'cues',
  spans: 'spans',
  loops: 'loops',
  'riff-patterns': 'riffs',
  lyrics: 'words',
};

/** What the bottom number compares for each kind. */
const KIND_LABEL_NOTE: Record<AnnotationKind, string> = {
  boundaries: 'the same section type',
  cues: 'the same label',
  spans: 'the same label',
  loops: 'the same label',
  'riff-patterns': 'the same label',
  lyrics: 'the same word',
};

const TOLERANCES = [0.5, 3] as const;

type Mark = { time: number; type: string };

function marksFor(doc: AnnotationLayersDocument | undefined, kind: AnnotationKind): Mark[] {
  if (!doc) return [];
  if (kind === 'boundaries') {
    return primaryBoundaryItems(doc).map((b) => ({ time: b.time, type: b.type ?? '' }));
  }
  const out: Mark[] = [];
  for (const layer of doc.layers ?? []) {
    if (layer.type !== kind) continue;
    for (const raw of layer.items as unknown[]) {
      const it = raw as { time?: number; start?: number; label?: string; text?: string };
      const t = typeof it.time === 'number' ? it.time : it.start;
      if (typeof t !== 'number' || !Number.isFinite(t)) continue;
      const lab = kind === 'lyrics' ? it.text : it.label;
      out.push({ time: t, type: normaliseLabel(lab) });
    }
  }
  return out;
}

function normaliseLabel(s: string | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function AnnotatorComparisonPanel({ slug }: { slug: string }) {
  const [data, setData] = useState<AllAnnotationsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [kind, setKind] = useState<AnnotationKind>('boundaries');

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

  /** Per kind: the annotators who have at least one item of it, with their marks. */
  const marksByKind = useMemo(() => {
    const out: Partial<Record<AnnotationKind, Record<string, Mark[]>>> = {};
    if (!data) return out;
    for (const k of KINDS) {
      const byId: Record<string, Mark[]> = {};
      for (const id of Object.keys(data.layers ?? {}).sort()) {
        const m = marksFor(data.layers[id], k);
        if (m.length > 0) byId[id] = m;
      }
      out[k] = byId;
    }
    return out;
  }, [data]);

  const availableKinds = useMemo<AnnotationKind[]>(
    () => KINDS.filter((k) => Object.keys(marksByKind[k] ?? {}).length >= 2),
    [marksByKind],
  );

  const activeKind: AnnotationKind | null = availableKinds.includes(kind) ? kind : availableKinds[0] ?? null;

  const matrices = useMemo(() => {
    if (!activeKind) return null;
    const byId = marksByKind[activeKind] ?? {};
    const ids = Object.keys(byId);
    const perTol: Record<number, AgreementMatrix> = {};
    for (const tol of TOLERANCES) perTol[tol] = buildAgreementMatrix(ids, (id) => byId[id], tol);
    return perTol;
  }, [activeKind, marksByKind]);

  if (loading) {
    return <Shell><p className="text-xs text-slate-500">Loading…</p></Shell>;
  }
  if (err) {
    return <Shell><p className="text-xs text-red-400">Failed to load: {err}</p></Shell>;
  }
  if (!data) return null;

  const totalAnnotators = Object.keys(data.layers ?? {}).length;

  if (totalAnnotators < 2) {
    return (
      <Shell>
        <p className="text-xs text-slate-500">
          Only one annotator has data for this song so far — nothing to compare yet.
        </p>
      </Shell>
    );
  }

  if (!activeKind) {
    return (
      <Shell>
        <p className="text-xs text-slate-500">
          {totalAnnotators} annotators have data, but no single annotation type
          has ≥2 entries to compare. Save the same type as another annotator to compare.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="text-[11px] text-slate-400">
          {totalAnnotators} annotators have data for this song
        </div>
        <nav className="flex flex-wrap justify-end gap-1 text-[10px] uppercase tracking-wider">
          {availableKinds.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`px-2 py-0.5 rounded transition-colors ${
                activeKind === k
                  ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-400/40'
                  : 'bg-white/[0.04] text-slate-500 hover:text-slate-300 border border-transparent'
              }`}
            >
              {KIND_LABEL[k]} ({Object.keys(marksByKind[k] ?? {}).length})
            </button>
          ))}
        </nav>
      </div>

      {matrices && (
        <div className="space-y-4">
          {TOLERANCES.map((tol) => (
            <MatrixView key={tol} matrix={matrices[tol]} tolerance={tol} kind={activeKind} />
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
  // Show the label line only when some matched pair actually carried labels.
  const showLabels = matrix.labels.some((row) => row.some((v) => v !== null && v > 0));

  return (
    <div>
      <div className="text-[11px] text-slate-400 mb-1.5">
        {KIND_LABEL[kind]} F1 (±{tolerance}s)
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
                  title={`${matrix.counts[id]} ${KIND_NOUN[kind]}`}
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
          Top number = F1 of {KIND_NOUN[kind]} matched by time. Bottom = % of matched {KIND_NOUN[kind]} with{' '}
          {KIND_LABEL_NOTE[kind]}.
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
