// Setlist workspace — algorithmic DJ-style ordering of the corpus.
//
// Experimental: gated by `experimentalSetlist`. Mounted at /setlist; the
// WorkspaceTabHeader hides the tab when the flag is off and AppShell bounces
// the route to /. v0 scorer = BPM-only (with meter + energy weights wired
// for the next pass). Persistence is per-annotator under /api/setlists.

import { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useSettings } from '../context/SettingsContext';
import { useAnnotator } from '../context/AnnotatorContext';
import { annotatorHeaders } from '../utils/annotatorHeaders';
import { loadCachedBpm } from '../services/bpmDetection';
import { loadCachedBeatnet } from '../services/beatnetDetection';
import {
  DEFAULT_WEIGHTS,
  STRATEGIES,
  deleteSetlist,
  listSetlists,
  loadSetlist,
  orderByStrategy,
  saveSetlist,
} from '../services/setlist';
import type {
  Setlist,
  SetlistEntry,
  SetlistScoringWeights,
  SetlistStrategyId,
} from '../types/setlist';

interface ManifestEntry {
  id: string;
  name: string;
  url: string;
}

async function fetchManifest(): Promise<ManifestEntry[]> {
  try {
    const res = await fetch('/analysis/manifest.json', { headers: annotatorHeaders() });
    if (!res.ok) return [];
    return (await res.json()) as ManifestEntry[];
  } catch {
    return [];
  }
}

/** Pick the median BPM across the cached detectors (matches the inspector's
 *  default display). Falls back to the first OK detector, then null. */
function medianBpm(algos: Array<{ ok: boolean; bpm?: number }>): number | null {
  const vals = algos.filter((a) => a.ok && a.bpm != null && Number.isFinite(a.bpm)).map((a) => a.bpm as number);
  if (vals.length === 0) return null;
  vals.sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 === 0 ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid];
}

export function SetlistPage() {
  const { settings } = useSettings();
  const { annotator } = useAnnotator();

  // Catalogue of all songs in the corpus + cached metadata.
  const [songs, setSongs] = useState<SetlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [included, setIncluded] = useState<Set<string>>(new Set());

  // Scoring controls.
  const [strategy, setStrategy] = useState<SetlistStrategyId>('bpm-ladder');
  const [weights, setWeights] = useState<SetlistScoringWeights>(DEFAULT_WEIGHTS);

  // Generated order (null until the user hits Generate).
  const [generated, setGenerated] = useState<{ order: SetlistEntry[]; pairScores: number[] } | null>(null);

  // Saved-setlist picker.
  const [savedNames, setSavedNames] = useState<string[]>([]);
  const [activeName, setActiveName] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // ── Load corpus + per-song BPM and meter on mount. ────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const manifest = await fetchManifest();
      // Sequential fetch — corpus is at most ~100 songs and the server caches
      // both responses to disk. A batch endpoint is in the audio-performance
      // backlog; not worth blocking the MVP on it.
      const entries: SetlistEntry[] = [];
      for (const m of manifest) {
        if (cancelled) return;
        const [bpmRes, beatnetRes] = await Promise.all([
          loadCachedBpm(m.id),
          settings.experimentalCueExtras ? loadCachedBeatnet(m.id) : Promise.resolve(null),
        ]);
        entries.push({
          slug: m.id,
          name: m.name,
          bpm: bpmRes ? medianBpm(bpmRes.algorithms) : null,
          meter: beatnetRes?.result?.meter ?? null,
        });
      }
      if (cancelled) return;
      setSongs(entries);
      setIncluded(new Set(entries.map((e) => e.slug)));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [settings.experimentalCueExtras]);

  // ── Saved setlists picker. ────────────────────────────────────────────────
  useEffect(() => {
    listSetlists().then(setSavedNames).catch(() => setSavedNames([]));
  }, []);

  const includedEntries = useMemo(() => songs.filter((s) => included.has(s.slug)), [songs, included]);

  const toggleSong = (slug: string) => {
    setIncluded((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug); else next.add(slug);
      return next;
    });
  };

  const handleGenerate = () => {
    if (includedEntries.length === 0) {
      setStatus('Select at least one song to include.');
      return;
    }
    setGenerated(orderByStrategy(strategy, includedEntries, weights));
    setStatus(null);
  };

  const handleSave = async () => {
    if (!generated) { setStatus('Generate an order first.'); return; }
    const trimmed = activeName.trim();
    if (!trimmed) { setStatus('Name the setlist before saving.'); return; }
    // File-safe: same shape as slugs everywhere else in the app.
    if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
      setStatus('Name can contain letters, digits, dot, dash, and underscore only.');
      return;
    }
    const payload: Setlist = {
      name: trimmed,
      strategy,
      weights,
      entries: generated.order,
      pairScores: generated.pairScores,
    };
    setSaving(true);
    const ok = await saveSetlist(payload);
    setSaving(false);
    if (ok) {
      setStatus(`Saved "${trimmed}".`);
      const next = await listSetlists();
      setSavedNames(next);
    } else {
      setStatus(`Save failed — are you signed in as a team member?`);
    }
  };

  const handleLoad = async (name: string) => {
    if (!name) return;
    const sl = await loadSetlist(name);
    if (!sl) { setStatus(`Could not load "${name}".`); return; }
    setStrategy(sl.strategy);
    setWeights(sl.weights);
    setGenerated({ order: sl.entries, pairScores: sl.pairScores });
    setIncluded(new Set(sl.entries.map((e) => e.slug)));
    setActiveName(name);
    setStatus(`Loaded "${name}".`);
  };

  const handleDelete = async () => {
    if (!activeName) return;
    if (!confirm(`Delete setlist "${activeName}"?`)) return;
    const ok = await deleteSetlist(activeName);
    if (ok) {
      setSavedNames(await listSetlists());
      setStatus(`Deleted "${activeName}".`);
      setActiveName('');
    } else {
      setStatus('Delete failed.');
    }
  };

  const handleExport = () => {
    if (!generated) return;
    const payload: Setlist = {
      name: activeName.trim() || 'setlist',
      strategy,
      weights,
      entries: generated.order,
      pairScores: generated.pairScores,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${payload.name}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (!settings.experimentalSetlist) return <Navigate to="/" replace />;

  return (
    <div className="px-3 pt-3 pb-12 text-slate-200">
      <div className="max-w-6xl mx-auto space-y-4">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Setlist <span className="text-[10px] uppercase tracking-[0.18em] text-rose-300 ml-2 align-middle">experimental</span>
          </h1>
          <p className="text-[12px] text-slate-400 max-w-3xl">
            Algorithmic ordering of {annotator?.email ? `your` : `the`} corpus into a
            DJ-style setlist. v0 uses cached BPM (median across the 5 detectors)
            to ladder songs from slow → fast with a greedy nearest-neighbour pass.
            Meter and energy scorers will join once their cached signals are
            wired in.
          </p>
        </header>

        {/* Controls */}
        <section className="rounded-lg border border-white/[0.06] bg-[#14171d]/80 p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-[11px] uppercase tracking-wider text-slate-500">Strategy</label>
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as SetlistStrategyId)}
              className="bg-[#0e1015] border border-white/[0.08] rounded px-2 py-1 text-[12px] text-slate-200"
            >
              {STRATEGIES.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
            <span className="text-[11px] text-slate-500">
              {STRATEGIES.find((s) => s.id === strategy)?.hint}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <WeightSlider label="BPM"    value={weights.bpm}    onChange={(v) => setWeights({ ...weights, bpm: v })} />
            <WeightSlider label="Meter"  value={weights.meter}  onChange={(v) => setWeights({ ...weights, meter: v })} />
            <WeightSlider label="Energy" value={weights.energy} onChange={(v) => setWeights({ ...weights, energy: v })} disabled />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleGenerate}
              disabled={loading || includedEntries.length === 0}
              className="px-3 py-1.5 rounded text-[12px] font-medium bg-rose-500/20 text-rose-200 border border-rose-400/40 hover:bg-rose-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Generate order
            </button>
            <button
              onClick={() => { setGenerated(null); setStatus(null); }}
              className="px-3 py-1.5 rounded text-[12px] text-slate-400 hover:text-slate-200 hover:bg-white/[0.04] transition-colors"
            >
              Reset
            </button>
            <span className="text-[11px] text-slate-500 ml-auto">
              {included.size} of {songs.length} song(s) included
            </span>
          </div>
        </section>

        {/* Saved picker */}
        <section className="rounded-lg border border-white/[0.06] bg-[#14171d]/80 p-3 flex flex-wrap items-center gap-2">
          <label className="text-[11px] uppercase tracking-wider text-slate-500">Setlist</label>
          <input
            value={activeName}
            onChange={(e) => setActiveName(e.target.value)}
            placeholder="my-warmup-set"
            className="bg-[#0e1015] border border-white/[0.08] rounded px-2 py-1 text-[12px] text-slate-200 w-48"
          />
          <button
            onClick={handleSave}
            disabled={saving || !generated}
            className="px-3 py-1.5 rounded text-[12px] bg-emerald-500/20 text-emerald-200 border border-emerald-400/40 hover:bg-emerald-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {savedNames.length > 0 && (
            <>
              <span className="text-[11px] text-slate-500 ml-2">Open:</span>
              <select
                value={activeName}
                onChange={(e) => handleLoad(e.target.value)}
                className="bg-[#0e1015] border border-white/[0.08] rounded px-2 py-1 text-[12px] text-slate-200"
              >
                <option value="">—</option>
                {savedNames.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <button
                onClick={handleDelete}
                disabled={!activeName}
                className="px-2 py-1.5 rounded text-[11px] text-rose-300 hover:text-rose-200 hover:bg-rose-500/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Delete
              </button>
            </>
          )}
          <button
            onClick={handleExport}
            disabled={!generated}
            className="px-3 py-1.5 rounded text-[12px] text-slate-300 hover:text-white border border-white/[0.08] hover:bg-white/[0.04] disabled:opacity-40 disabled:cursor-not-allowed transition-colors ml-auto"
          >
            Export JSON
          </button>
        </section>

        {status && (
          <div className="text-[11px] text-slate-400 px-1">{status}</div>
        )}

        {/* Two-column body: corpus picker + generated order */}
        <div className="grid md:grid-cols-2 gap-4">
          <section className="rounded-lg border border-white/[0.06] bg-[#14171d]/80 p-3">
            <h2 className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">Corpus ({songs.length})</h2>
            {loading ? (
              <div className="text-[11px] text-slate-500">Loading songs + BPM cache…</div>
            ) : (
              <ul className="max-h-[60vh] overflow-y-auto divide-y divide-white/[0.04] text-[12px]">
                {songs.map((s) => (
                  <li key={s.slug} className="flex items-center gap-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={included.has(s.slug)}
                      onChange={() => toggleSong(s.slug)}
                      className="accent-rose-400"
                    />
                    <span className="flex-1 truncate text-slate-200">{s.name}</span>
                    <span className="font-mono text-[11px] text-slate-400 tabular-nums w-16 text-right">
                      {s.bpm != null ? `${s.bpm.toFixed(1)} BPM` : '— BPM'}
                    </span>
                    <span className="font-mono text-[11px] text-slate-500 w-10 text-right">
                      {s.meter ?? '—'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-white/[0.06] bg-[#14171d]/80 p-3">
            <h2 className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">
              Generated order {generated && `(${generated.order.length})`}
            </h2>
            {!generated ? (
              <div className="text-[11px] text-slate-500">Hit <strong>Generate order</strong> to build a setlist.</div>
            ) : (
              <ol className="max-h-[60vh] overflow-y-auto text-[12px]">
                {generated.order.map((e, i) => (
                  <li key={e.slug} className="py-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-slate-500 w-6 text-right">{i + 1}.</span>
                      <span className="flex-1 truncate text-slate-200">{e.name}</span>
                      <span className="font-mono text-[11px] text-slate-400 tabular-nums w-16 text-right">
                        {e.bpm != null ? `${e.bpm.toFixed(1)} BPM` : '— BPM'}
                      </span>
                      <span className="font-mono text-[11px] text-slate-500 w-10 text-right">{e.meter ?? '—'}</span>
                    </div>
                    {i < generated.order.length - 1 && (
                      <div className="ml-8 mt-0.5 text-[10px] text-slate-500">
                        {(() => {
                          const next = generated.order[i + 1];
                          const score = generated.pairScores[i];
                          if (score == null) return <span>↓ — (no BPM)</span>;
                          const dBpm = (e.bpm != null && next.bpm != null) ? Math.abs(next.bpm - e.bpm).toFixed(1) : '—';
                          return (
                            <span>
                              ↓ Δ {dBpm} BPM · meter {e.meter === next.meter ? '✓' : '✗'} · score {score.toFixed(2)}
                            </span>
                          );
                        })()}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function WeightSlider({
  label, value, onChange, disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className={`uppercase tracking-wider w-14 ${disabled ? 'text-slate-600' : 'text-slate-500'}`}>{label}</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-28 accent-rose-400 disabled:cursor-not-allowed"
      />
      <span className="font-mono w-10 text-right text-slate-400 tabular-nums">{value.toFixed(2)}</span>
    </div>
  );
}
