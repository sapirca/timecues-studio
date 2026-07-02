// Settings-page panel that surfaces the install / readiness status of the
// experimental MIR detectors and lets the user warm their weights without
// having to trigger a per-song detect. Rendered conditionally — only when
// at least one of {experimentalSpanFamily, experimentalCueExtras} is on.
//
// Each model row has four possible states:
//   • Server unreachable — the `experimental-models` docker compose profile
//     isn't running. The row explains how to start it.
//   • Server reachable, deps missing — torch / BeatNet not installed inside
//     the container. The row shows the upstream error.
//   • Ready (cached / warm) — the model is loaded and a detect call will be
//     fast. Auto-detected from `available=true` on /algorithms.
//   • Initializing — the user just clicked Initialize and we're waiting for
//     the server to finish loading weights.

import { useCallback, useEffect, useState } from 'react';
import {
  listSpanAlgorithms,
  initializeSpanAlgorithm,
} from '../services/spanDetection';
import {
  beatnetHealth,
  initializeBeatnet,
} from '../services/beatnetDetection';
import {
  listPannsAlgorithms,
  initializePannsAlgorithm,
} from '../services/pannsDetection';
import {
  listPitchAlgorithms,
  initializePitchAlgorithm,
} from '../services/pitchDetection';
import {
  listCueExtrasAlgorithms,
  initializeCueExtrasAlgorithm,
} from '../services/cueExtrasDetection';
import {
  listPercussiveAlgorithms,
  initializePercussiveAlgorithm,
} from '../services/percussiveDetection';
import {
  listLyricsAlgorithms,
  initializeLyricsAlgorithm,
} from '../services/lyricsDetection';
import {
  listPatternAlgorithms,
  initializePatternAlgorithm,
} from '../services/patternDetection';

type RowStatus = 'idle' | 'warming' | 'ready' | 'error' | 'unreachable';

interface Row {
  id: string;
  family: 'span' | 'cue' | 'loop' | 'pitch' | 'panns' | 'cue-extras' | 'percussive' | 'lyrics' | 'pattern';
  name: string;
  description: string;
  /** Approximate weight size, surfaced before download so the user can opt out. */
  size: string;
  status: RowStatus;
  error?: string;
}

export interface ExperimentalModelsPanelProps {
  spanFamilyEnabled: boolean;
  cueExtrasEnabled: boolean;
  loopFamilyEnabled: boolean;
  lyricsFamilyEnabled: boolean;
  patternFamilyEnabled: boolean;
}

const SPAN_SIZE_BY_ID: Record<string, string> = {
  'silero-vad':      '~2 MB',
  'jdcnet-voicing':  '~30 MB',
};

const PANNS_SIZE_BY_ID: Record<string, string> = {
  'panns-cnn14':     '~80 MB',
};

const PITCH_SIZE_BY_ID: Record<string, string> = {
  'basic-pitch':     '~5 MB (bundled)',
};

const CUE_EXTRAS_SIZE_BY_ID: Record<string, string> = {
  'librosa-key':      'pure DSP',
  'autochord-chords': '~2 MB (pip)',
  'librosa-onsets':   'pure DSP',
};

const PERCUSSIVE_SIZE_BY_ID: Record<string, string> = {
  'hpss-percussive':  'pure DSP',
};

const LYRICS_SIZE_BY_ID: Record<string, string> = {
  'whisper-base':       '~140 MB',
  'ctc-forced-aligner': '~360 MB',
};

const PATTERN_SIZE_BY_ID: Record<string, string> = {
  'locomotif':        'pure DSP',
};

export function ExperimentalModelsPanel({
  spanFamilyEnabled,
  cueExtrasEnabled,
  loopFamilyEnabled,
  lyricsFamilyEnabled,
  patternFamilyEnabled,
}: ExperimentalModelsPanelProps) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const next: Row[] = [];

    if (spanFamilyEnabled) {
      const algos = await listSpanAlgorithms();
      if (algos === null) {
        next.push({
          id: 'span:unreachable',
          family: 'span',
          name: 'SPAN family server',
          description: 'Silero-VAD, JDCNet, MIRFLEX (when wired).',
          size: '—',
          status: 'unreachable',
          error: 'docker compose --profile experimental-models up --build span',
        });
      } else {
        for (const a of algos) {
          next.push({
            id: `span:${a.id}`,
            family: 'span',
            name: a.name,
            description: a.description,
            size: SPAN_SIZE_BY_ID[a.id] ?? '?',
            status: a.available ? 'ready' : 'error',
            error: a.available ? undefined : 'dependencies missing in sidecar',
          });
        }
      }
    }

    if (cueExtrasEnabled) {
      const h = await beatnetHealth();
      const ready = h ? (h.beatnetOk && h.numpyOk) : false;
      next.push({
        id: 'cue:beatnet',
        family: 'cue',
        name: 'BeatNet',
        description: 'CRNN + DBN beat / downbeat / meter detector (Heydari & Duan 2021).',
        size: '~20 MB',
        status: h === null ? 'unreachable' : (ready ? 'ready' : 'error'),
        error: h === null
          ? 'docker compose --profile experimental-models up --build beatnet'
          : (ready ? undefined : 'BeatNet / numpy missing in sidecar'),
      });
      // basic-pitch lives in the same `experimentalCueExtras` switch as
      // BeatNet because both produce CUE-family items.
      const pitchAlgos = await listPitchAlgorithms();
      if (pitchAlgos === null) {
        next.push({
          id: 'cue:basic-pitch:server',
          family: 'pitch',
          name: 'basic-pitch server',
          description: 'Spotify polyphonic note transcription.',
          size: '—',
          status: 'unreachable',
          error: 'docker compose --profile experimental-models up --build pitch',
        });
      } else {
        for (const a of pitchAlgos) {
          next.push({
            id: `cue:${a.id}`,
            family: 'pitch',
            name: a.name,
            description: a.description,
            size: PITCH_SIZE_BY_ID[a.id] ?? '?',
            status: a.available ? 'ready' : 'error',
            error: a.available ? undefined : 'basic_pitch missing in sidecar',
          });
        }
      }
    }

    // PANNs lives under the SPAN family flag but has its own sidecar; include
    // it when the SPAN family is enabled.
    if (spanFamilyEnabled) {
      const pannsAlgos = await listPannsAlgorithms();
      if (pannsAlgos === null) {
        next.push({
          id: 'span:panns:server',
          family: 'panns',
          name: 'PANNs server',
          description: 'AudioSet-527 multi-label tagging (CNN14).',
          size: '—',
          status: 'unreachable',
          error: 'docker compose --profile experimental-models up --build panns',
        });
      } else {
        for (const a of pannsAlgos) {
          next.push({
            id: `span:${a.id}`,
            family: 'panns',
            name: a.name,
            description: a.description,
            size: PANNS_SIZE_BY_ID[a.id] ?? '?',
            status: a.available ? 'ready' : 'error',
            error: a.available ? undefined : 'panns_inference missing in sidecar',
          });
        }
      }

      // HPSS percussive (separate sidecar) — also SPAN family.
      const percAlgos = await listPercussiveAlgorithms();
      if (percAlgos === null) {
        next.push({
          id: 'span:percussive:server',
          family: 'percussive',
          name: 'HPSS percussive server',
          description: 'Harmonic-percussive source separation + threshold.',
          size: '—',
          status: 'unreachable',
          error: 'docker compose --profile experimental-models up --build percussive',
        });
      } else {
        for (const a of percAlgos) {
          next.push({
            id: `span:${a.id}`,
            family: 'percussive',
            name: a.name,
            description: a.description,
            size: PERCUSSIVE_SIZE_BY_ID[a.id] ?? '?',
            status: a.available ? 'ready' : 'error',
            error: a.available ? undefined : 'librosa missing in sidecar',
          });
        }
      }
    }

    // CUE-family extras (key, autochord, onsets) share the same sidecar.
    if (cueExtrasEnabled) {
      const cueExtrasAlgos = await listCueExtrasAlgorithms();
      if (cueExtrasAlgos === null) {
        next.push({
          id: 'cue-extras:server',
          family: 'cue-extras',
          name: 'CUE-extras server',
          description: 'librosa key / autochord chords / librosa onsets.',
          size: '—',
          status: 'unreachable',
          error: 'docker compose --profile experimental-models up --build cue-extras',
        });
      } else {
        for (const a of cueExtrasAlgos) {
          next.push({
            id: `cue-extras:${a.id}`,
            family: 'cue-extras',
            name: a.name,
            description: a.description,
            size: CUE_EXTRAS_SIZE_BY_ID[a.id] ?? '?',
            status: a.available ? 'ready' : 'error',
            error: a.available ? undefined : 'librosa / autochord missing in sidecar',
          });
        }
      }
    }

    if (lyricsFamilyEnabled) {
      const lyricsAlgos = await listLyricsAlgorithms();
      if (lyricsAlgos === null) {
        next.push({
          id: 'lyrics:server',
          family: 'lyrics',
          name: 'Whisper server',
          description: 'OpenAI Whisper base — multilingual vocal transcription.',
          size: '—',
          status: 'unreachable',
          error: 'docker compose --profile experimental-models up --build lyrics',
        });
      } else {
        for (const a of lyricsAlgos) {
          next.push({
            id: `lyrics:${a.id}`,
            family: 'lyrics',
            name: a.name,
            description: a.description,
            size: LYRICS_SIZE_BY_ID[a.id] ?? '?',
            status: a.available ? 'ready' : 'error',
            error: a.available ? undefined : 'whisper missing in sidecar',
          });
        }
      }
    }

    if (patternFamilyEnabled) {
      const patternAlgos = await listPatternAlgorithms();
      if (patternAlgos === null) {
        next.push({
          id: 'pattern:server',
          family: 'pattern',
          name: 'PATTERN family server',
          description: 'LoCoMotif — DTW-warped motif discovery on beat-synchronous chroma.',
          size: '—',
          status: 'unreachable',
          error: 'docker compose --profile experimental-models up --build pattern',
        });
      } else {
        for (const a of patternAlgos) {
          next.push({
            id: `pattern:${a.id}`,
            family: 'pattern',
            name: a.name,
            description: a.description,
            size: PATTERN_SIZE_BY_ID[a.id] ?? '?',
            status: a.available ? 'ready' : 'error',
            error: a.available ? undefined : 'dtai-locomotif / librosa missing in sidecar',
          });
        }
      }
    }

    setRows(next);
    setLoading(false);
  }, [spanFamilyEnabled, cueExtrasEnabled, loopFamilyEnabled, lyricsFamilyEnabled, patternFamilyEnabled]);

  useEffect(() => { void refresh(); }, [refresh]);

  const initOne = useCallback(async (row: Row) => {
    setRows((prev) => prev.map((r) => r.id === row.id ? { ...r, status: 'warming', error: undefined } : r));
    let res: { ok: boolean; error?: string };
    const algoId = row.id.split(':').slice(1).join(':');
    switch (row.family) {
      case 'span':       res = await initializeSpanAlgorithm(algoId); break;
      case 'panns':      res = await initializePannsAlgorithm(algoId); break;
      case 'pitch':      res = await initializePitchAlgorithm(algoId); break;
      case 'cue-extras': res = await initializeCueExtrasAlgorithm(algoId); break;
      case 'percussive': res = await initializePercussiveAlgorithm(algoId); break;
      case 'lyrics':     res = await initializeLyricsAlgorithm(algoId); break;
      case 'pattern':    res = await initializePatternAlgorithm(algoId); break;
      default:           res = await initializeBeatnet();
    }
    setRows((prev) => prev.map((r) => r.id === row.id
      ? { ...r, status: res.ok ? 'ready' : 'error', error: res.error }
      : r));
  }, []);

  const initAll = useCallback(async () => {
    for (const r of rows) {
      if (r.status === 'unreachable') continue;
      await initOne(r);
    }
  }, [rows, initOne]);

  if (!spanFamilyEnabled && !cueExtrasEnabled && !loopFamilyEnabled && !lyricsFamilyEnabled && !patternFamilyEnabled) return null;

  // Sum the MB hint baked into each row's `size` string so the user knows
  // the rough bandwidth cost before clicking "Initialize all". Rows that
  // can't be sized (pure DSP, unreachable, '?') just don't contribute.
  const downloadableMb = rows
    .filter((r) => r.status === 'idle' || r.status === 'error')
    .reduce((acc, r) => acc + parseMb(r.size), 0);

  return (
    <div className="mt-3 p-3 rounded-lg bg-black/30 border border-white/[0.06]">
      <div className="flex items-center justify-between gap-3 mb-2.5">
        <div className="text-[12px] font-medium text-slate-300">
          Initialize models
          {downloadableMb > 0 && (
            <span className="ml-2 text-[10px] uppercase tracking-wider text-slate-500">
              · ~{downloadableMb.toFixed(0)} MB pending
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="px-2 py-1 rounded text-[11px] font-medium border border-white/[0.08] bg-white/[0.04] text-slate-200 hover:bg-white/[0.08] disabled:opacity-40"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void initAll()}
            disabled={loading || rows.length === 0}
            className="px-2 py-1 rounded text-[11px] font-medium border border-violet-400/30 bg-violet-500/15 text-violet-200 hover:bg-violet-500/25 disabled:opacity-40"
          >
            Initialize all
          </button>
        </div>
      </div>

      {rows.length === 0 && !loading && (
        <p className="text-[11px] text-slate-500">
          No models to initialize for the currently enabled families.
        </p>
      )}

      <ul className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center justify-between gap-2 text-[11px]">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-slate-200">{row.name}</span>
                <span className="text-slate-500 font-mono">{row.size}</span>
                <span className="uppercase tracking-wider text-[9px] px-1.5 py-0.5 rounded bg-white/[0.05] border border-white/[0.08] text-slate-400">
                  {row.family}
                </span>
              </div>
              <p className="text-slate-500 mt-0.5 truncate">{row.description}</p>
              {row.error && (
                <p className="text-amber-400/80 mt-0.5 font-mono break-all">{row.error}</p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <StatusBadge status={row.status} />
              {(row.status === 'idle' || row.status === 'error') && (
                <button
                  type="button"
                  onClick={() => void initOne(row)}
                  className="px-2 py-1 rounded text-[10px] font-medium border border-white/[0.08] bg-white/[0.04] text-slate-200 hover:bg-white/[0.08]"
                >
                  Initialize
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Pull the leading MB number out of a size hint like "~80 MB" or
// "~5 MB (bundled)". Returns 0 for "pure DSP" / "?" / "—".
function parseMb(size: string): number {
  const m = size.match(/(\d+(?:\.\d+)?)\s*MB/i);
  return m ? parseFloat(m[1]) : 0;
}

function StatusBadge({ status }: { status: RowStatus }) {
  const tone: Record<RowStatus, string> = {
    idle:        'bg-white/[0.05] text-slate-400 border-white/[0.08]',
    warming:     'bg-sky-500/15 text-sky-300 border-sky-400/30',
    ready:       'bg-emerald-500/15 text-emerald-300 border-emerald-400/30',
    error:       'bg-amber-500/15 text-amber-300 border-amber-400/30',
    unreachable: 'bg-rose-500/15 text-rose-300 border-rose-400/30',
  };
  const label: Record<RowStatus, string> = {
    idle:        'Not loaded',
    warming:     'Loading…',
    ready:       'Ready',
    error:       'Deps missing',
    unreachable: 'Server off',
  };
  return (
    <span className={`px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wider ${tone[status]}`}>
      {label[status]}
    </span>
  );
}
