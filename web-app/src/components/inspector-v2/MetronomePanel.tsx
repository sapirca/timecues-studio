import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { SongInfo } from '../../types/songInfo';
import { beatIndexAt, beatTimeAt } from '../../utils/beatGrid';
import {
  applyTap,
  emptyTapTempoState,
  type TapTempoState,
} from './tapTempo';

export interface MetronomePanelProps {
  songInfo: SongInfo | null;
  /** Current playhead time in seconds — drives the click scheduler. */
  playerTime: number;
  /** Whether the song is currently playing — clicks only schedule while true.
   *  The Metronome ON/OFF toggle is just a flag; it does NOT start the song. */
  playerIsPlaying: boolean;
  /** When true, suppress the outer card chrome + "Metronome" title — caller
   *  is wrapping this in their own container (e.g. CollapsibleSection). */
  embedded?: boolean;
  /** Imperative tap-tempo trigger — the T keyboard shortcut wires here so
   *  users can tap along without clicking the Tap button. Same reducer as
   *  the button. */
  tapRef?: RefObject<(() => void) | null>;
}

const SCHED_INTERVAL_MS = 25;
const LOOKAHEAD_S = 0.1;
const SEEK_BACKWARD_THRESHOLD = -0.05;
const SEEK_FORWARD_THRESHOLD = 0.5;
const CLICK_DURATION_S = 0.04;
const VOLUME_STORAGE_KEY = 'tc:metronome:volume';
const PITCH_STORAGE_KEY = 'tc:metronome:pitch';
const DEFAULT_VOLUME = 0.6;
/** Allow up to 200% to give the click headroom over busy mixes. Above 100% the
 *  master gain exceeds unity; some systems will distort, but most material lets
 *  you push to ~150–200% before the click clips audibly. */
const MAX_VOLUME = 2.0;

type Pitch = 'low' | 'mid' | 'high' | 'highest';

const PITCH_FREQS: Record<Pitch, { beat: number; downbeat: number }> = {
  low:      { beat: 600,  downbeat: 900 },
  mid:      { beat: 1400, downbeat: 2200 }, // legacy default
  high:     { beat: 2800, downbeat: 4200 },
  highest:  { beat: 5000, downbeat: 7000 },
};
const DEFAULT_PITCH: Pitch = 'mid';

function loadVolume(): number {
  try {
    const raw = window.localStorage.getItem(VOLUME_STORAGE_KEY);
    if (raw == null) return DEFAULT_VOLUME;
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return DEFAULT_VOLUME;
    return Math.max(0, Math.min(MAX_VOLUME, v));
  } catch { return DEFAULT_VOLUME; }
}

function loadPitch(): Pitch {
  try {
    const raw = window.localStorage.getItem(PITCH_STORAGE_KEY);
    if (raw === 'low' || raw === 'mid' || raw === 'high' || raw === 'highest') return raw;
    return DEFAULT_PITCH;
  } catch { return DEFAULT_PITCH; }
}

function parseBeatsPerBar(ts: string): number {
  const top = parseInt((ts ?? '4/4').split('/')[0], 10);
  return Number.isFinite(top) && top > 0 ? top : 4;
}

/** Enumerate beat times in [from, to] (song-time seconds) given the current
 *  grid. Routes through the anchor-aware engine helpers in beatGrid.ts so
 *  Dynamic / Manual modes tick at the right segment-local tempo when their
 *  anchors are present. When Manual-mode beat overrides exist, clicks land
 *  on the pinned positions rather than the macro grid. Static mode (no
 *  anchors, no overrides) is unchanged. */
function beatsInRange(songInfo: SongInfo, from: number, to: number): Array<{ t: number; isDownbeat: boolean }> {
  const bpm = songInfo.bpm;
  if (!bpm || bpm <= 0) return [];
  const beatsPerBar = parseBeatsPerBar(songInfo.timeSignature);
  const offset = songInfo.gridOffset ?? 0;
  const anchors = songInfo.tempoAnchors && songInfo.tempoAnchors.length > 0 ? songInfo.tempoAnchors : undefined;
  const overrides = songInfo.gridMode === 'manual' && songInfo.beatOverrides ? songInfo.beatOverrides : undefined;

  // Walk by beat index. For static this is `idx = ceil((from-offset)/dBeat)`;
  // anchored mode uses the cumulative-beat math via beatIndexAt + beatTimeAt.
  // We start a couple of beats early so an overridden beat that pulled
  // forward earlier than its macro position is still in range.
  const startIdx = Math.max(0, beatIndexAt(from, bpm, offset, anchors) - 2);
  const out: Array<{ t: number; isDownbeat: boolean }> = [];
  const HARD_CAP = 128;
  for (let i = startIdx; out.length < HARD_CAP; i++) {
    const t = beatTimeAt(i, bpm, offset, anchors, overrides);
    if (t < from) continue;
    if (t > to) break;
    out.push({ t, isDownbeat: i % beatsPerBar === 0 });
  }
  return out;
}

/** Resolve the grid the click scheduler should tick against. The metronome is
 *  decoupled from the song's saved grid: tapping sets a local `tappedBpm` that
 *  drives the click WITHOUT writing anything back to the dataset. When the user
 *  has tapped a value we click a steady pulse at that BPM (anchors / per-beat
 *  overrides are grid concerns, so they're dropped); otherwise we fall back to
 *  the song's own grid so the panel still works out of the box. Either way we
 *  keep the song's gridOffset + timeSignature for phase + downbeat accenting. */
function effectiveMetroInfo(base: SongInfo | null, tappedBpm: number | null): SongInfo | null {
  if (tappedBpm != null) {
    return { ...(base ?? {}), bpm: tappedBpm, tempoAnchors: undefined, beatOverrides: undefined } as SongInfo;
  }
  return base;
}

/** Schedule a single beat click. Downbeats are louder + higher-pitched (woodblock-ish). */
function scheduleClick(ctx: AudioContext, master: GainNode, startAt: number, isDownbeat: boolean, pitch: Pitch) {
  const sampleRate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(CLICK_DURATION_S * sampleRate));
  const buf = ctx.createBuffer(1, len, sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  const freqs = PITCH_FREQS[pitch];
  bp.frequency.value = isDownbeat ? freqs.downbeat : freqs.beat;
  bp.Q.value = 8;
  const env = ctx.createGain();
  const peak = isDownbeat ? 1.0 : 0.65;
  env.gain.setValueAtTime(0, startAt);
  env.gain.linearRampToValueAtTime(peak, startAt + 0.0008);
  env.gain.exponentialRampToValueAtTime(0.0001, startAt + CLICK_DURATION_S);
  src.connect(bp).connect(env).connect(master);
  src.start(startAt);
  src.stop(startAt + CLICK_DURATION_S + 0.01);
}

export function MetronomePanel({
  songInfo,
  playerTime,
  playerIsPlaying,
  embedded = false,
  tapRef,
}: MetronomePanelProps) {
  const [clickEnabled, setClickEnabled] = useState(false);
  const [clickVolume, setClickVolume] = useState<number>(() => loadVolume());
  const [clickPitch, setClickPitch] = useState<Pitch>(() => loadPitch());

  // The metronome's own tempo. `null` means "follow the song's grid BPM"; a
  // tap sets a local override that the click plays at WITHOUT touching the
  // dataset grid. Detect (tap) and Listen (click) are two separate features.
  const [tappedBpm, setTappedBpm] = useState<number | null>(null);
  const tappedBpmRef = useRef<number | null>(null);

  const songBpm = songInfo?.bpm ?? null;
  const metroBpm = tappedBpm ?? songBpm;
  const hasGrid = !!metroBpm && metroBpm > 0;

  const songInfoRef = useRef(songInfo);
  const playerTimeRef = useRef(playerTime);
  const lastSeenTimeRef = useRef(playerTime);
  const cursorRef = useRef(playerTime);
  const ctxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  songInfoRef.current = songInfo;
  playerTimeRef.current = playerTime;

  // Detect seeks (large playhead jumps) and reset the scheduler cursor so
  // clicks aren't replayed or skipped.
  useEffect(() => {
    const delta = playerTime - lastSeenTimeRef.current;
    if (delta < SEEK_BACKWARD_THRESHOLD || delta > SEEK_FORWARD_THRESHOLD) {
      cursorRef.current = playerTime;
    }
    lastSeenTimeRef.current = playerTime;
  }, [playerTime]);

  // Create or reuse the AudioContext + master gain. Chrome's autoplay policy
  // requires resume() to be called inside a user gesture, so we run this from
  // the toggle's onClick — not from the scheduler effect (which fires on a
  // state change that's already past the gesture phase).
  const ensureAudioContext = useCallback(() => {
    if (!ctxRef.current) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctxRef.current = new Ctor();
      const g = ctxRef.current.createGain();
      g.gain.value = clickVolume;
      g.connect(ctxRef.current.destination);
      masterGainRef.current = g;
    }
    const ctx = ctxRef.current;
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  }, [clickVolume]);

  // Keep the master gain synced with the slider — live, while playing.
  useEffect(() => {
    if (masterGainRef.current) masterGainRef.current.gain.value = clickVolume;
    try { window.localStorage.setItem(VOLUME_STORAGE_KEY, String(clickVolume)); } catch { /* ignore quota */ }
  }, [clickVolume]);

  // Persist pitch selection. Used by scheduleClick at the next tick — no live
  // re-routing needed, since each click is a fresh BiquadFilter.
  const clickPitchRef = useRef<Pitch>(clickPitch);
  useEffect(() => {
    clickPitchRef.current = clickPitch;
    try { window.localStorage.setItem(PITCH_STORAGE_KEY, clickPitch); } catch { /* ignore quota */ }
  }, [clickPitch]);

  // The scheduler. Runs only when song plays AND the click is enabled.
  useEffect(() => {
    if (!playerIsPlaying || !clickEnabled || !hasGrid) return;
    const ctx = ctxRef.current;
    const master = masterGainRef.current;
    if (!ctx || !master) return; // ensureAudioContext() wasn't called yet — toggle must be clicked first
    if (ctx.state === 'suspended') void ctx.resume();
    cursorRef.current = playerTimeRef.current;

    const tick = () => {
      const info = effectiveMetroInfo(songInfoRef.current, tappedBpmRef.current);
      if (!info || !info.bpm) return;
      const now = playerTimeRef.current;
      const horizon = now + LOOKAHEAD_S;
      const from = Math.max(cursorRef.current, now);
      const beats = beatsInRange(info, from, horizon);
      for (const b of beats) {
        const startAt = ctx.currentTime + Math.max(0, b.t - now);
        scheduleClick(ctx, master, startAt, b.isDownbeat, clickPitchRef.current);
      }
      cursorRef.current = horizon;
    };

    const id = window.setInterval(tick, SCHED_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [playerIsPlaying, clickEnabled, hasGrid]);

  // ── Tap tempo ─────────────────────────────────────────────────────────────
  // Each tap feeds the pure reducer in ./tapTempo.ts, which maintains the
  // rolling window, debounces fast taps, and resets when the user shifts
  // tempos. A ref mirrors the state so the tempo write (tappedBpmRef) sits
  // outside the setState updater — keeps both calls StrictMode-safe.
  const [tapState, setTapState] = useState<TapTempoState>(emptyTapTempoState);
  const tapStateRef = useRef<TapTempoState>(emptyTapTempoState);

  const handleTap = useCallback(() => {
    const now = performance.now();
    const prev = tapStateRef.current;
    const next = applyTap(prev, now);
    tapStateRef.current = next;
    setTapState(next);
    // Drive the metronome's local tempo only — never the dataset grid.
    if (next.currentBpm != null && next.currentBpm !== prev.currentBpm) {
      tappedBpmRef.current = next.currentBpm;
      setTappedBpm(next.currentBpm);
    }
  }, []);

  useEffect(() => {
    if (tapRef) tapRef.current = handleTap;
    return () => { if (tapRef) tapRef.current = null; };
  }, [tapRef, handleTap]);

  // Clear both the tap buffer and the local tempo override, so the metronome
  // falls back to the song's grid BPM.
  const handleClearTap = useCallback(() => {
    tapStateRef.current = emptyTapTempoState;
    setTapState(emptyTapTempoState);
    tappedBpmRef.current = null;
    setTappedBpm(null);
  }, []);

  const tapTimes = tapState.taps;
  const tapBpm = tapState.currentBpm;

  // Status hint for the Listen section — the toggle is a passive flag; we show
  // why the user is or isn't hearing clicks right now.
  const clickStatus: string =
    !hasGrid ? 'tap a tempo first'
    : !clickEnabled ? 'sound off'
    : !playerIsPlaying ? 'press play to hear it'
    : 'playing';

  // Where the metronome's current tempo is coming from.
  const bpmSource: string =
    tappedBpm != null ? 'from your taps'
    : songBpm != null ? "from the song's BPM"
    : 'no tempo yet';

  const containerClass = embedded
    ? 'space-y-3'
    : 'rounded-md border border-white/[0.06] bg-[#14171d]/80 p-3 space-y-3';

  const canClear = tapTimes.length > 0 || tappedBpm != null;

  return (
    <div className={containerClass}>
      {!embedded && (
        <span className="block text-sm font-semibold uppercase tracking-[0.18em] text-slate-200">Metronome</span>
      )}

      {/* ── 1. DETECT — tap along to find the tempo. This only sets the
              metronome's own value; it never writes back to the song's grid. ── */}
      <section className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-300"
            title="Tap along on every beat and the BPM updates live from the rolling average of your last few taps. This sets the metronome's own tempo only — it does NOT change the song's grid BPM. Once it locks onto a tempo it stays put: a single off-beat tap is ignored as a slip, and only a sustained change (two off-tempo taps in a row) re-locks onto the new tempo so you can switch songs without clearing first."
          >
            Detect tempo
          </span>
          <span className="text-[10px] text-slate-500">tap along to find the BPM</span>
        </div>

        <div className="flex items-center justify-between gap-4">
          {/* Big detected value — the metronome's current tempo. Width varies
              with the BPM digits / tap count, so it lives on the left and the
              buttons are pinned right (justify-between) to stay put while tapping. */}
          <div
            className="flex min-w-0 flex-col leading-none"
            title={tapTimes.length === 0
              ? (tappedBpm != null
                  ? 'The metronome is set to this tempo from your taps.'
                  : songBpm != null
                  ? "Following the song's BPM. Tap below to set a different metronome tempo."
                  : 'Tap on every beat to detect a tempo.')
              : tapTimes.length === 1
              ? 'Tap once more to get a first BPM estimate.'
              : tapBpm == null
              ? 'Estimate is outside 60–240 BPM; keep tapping to refine.'
              : `Estimated from the last ${tapTimes.length} taps.`}
          >
            <span className="text-3xl font-bold tabular-nums text-slate-100">
              {metroBpm != null ? metroBpm : '—'}
              <span className="ml-1.5 text-sm font-medium text-slate-500">BPM</span>
            </span>
            <span className="mt-1 text-[10px] font-mono text-slate-500">
              {bpmSource} · {tapTimes.length} tap{tapTimes.length === 1 ? '' : 's'}
            </span>
          </div>

          {/* Main actions — Tap (dominant) + Clear. */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onMouseDown={handleTap}
              title="Tap on every beat. The metronome's tempo updates live from the second tap onward and settles once it locks on — a stray tap won't throw it off. Tap a different tempo twice in a row to re-lock. Does not change the song's grid. (T)"
              className="px-6 py-3 rounded-md text-base font-bold uppercase tracking-[0.18em] border border-emerald-500/60 bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30 active:bg-emerald-500/50 active:scale-[0.97] select-none transition-all"
            >
              Tap
            </button>
            <button
              type="button"
              onClick={handleClearTap}
              disabled={!canClear}
              title="Reset the detected tempo and clear the tap buffer. The metronome falls back to the song's BPM. Never changes the song's grid."
              className="px-3 py-2 rounded text-[11px] font-mono border border-white/[0.08] bg-white/[0.02] text-slate-400 hover:border-white/20 hover:text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Clear
            </button>
          </div>
        </div>
      </section>

      {/* ── 2. LISTEN — the metronome sound. A separate feature: it plays a
              woodblock click on every beat at the detected tempo while the song
              is playing. The controls here only shape that sound. ── */}
      <section className="space-y-2 pt-3 border-t border-white/[0.06]">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-300"
            title="The metronome's sound. When ON, you'll hear a click on every beat at the tempo above while the song plays. These controls only shape the click — they do not detect or change the tempo."
          >
            Metronome sound
          </span>
          <span className="text-[10px] font-mono text-slate-500" title="The metronome only sounds while the song is playing. Turn it on, then press Spacebar or the player's ▶ button.">
            {clickStatus}
          </span>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* ON/OFF toggle — a passive flag; it does not start playback. */}
          <button
            type="button"
            onClick={() => {
              // Create + resume the AudioContext inside the user gesture so
              // Chrome's autoplay policy lets clicks through. Schedule clicks
              // continue to come from the effect; this just unlocks audio.
              if (!clickEnabled) ensureAudioContext();
              setClickEnabled((v) => !v);
            }}
            disabled={!hasGrid}
            title="Turn the click track on or off. When ON, you'll hear a click on every beat while the song plays at the detected tempo. It does NOT start the song; press Spacebar to play."
            className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-md text-sm font-semibold uppercase tracking-wider border-2 transition-colors ${
              clickEnabled
                ? 'border-emerald-500/70 bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30'
                : 'border-slate-600/60 bg-slate-800/40 text-slate-300 hover:bg-slate-700/60'
            } disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            <span aria-hidden="true" className="text-base leading-none">{clickEnabled ? '🔊' : '🔇'}</span>
            {clickEnabled ? 'Sound ON' : 'Sound OFF'}
          </button>

          {/* Pitch preset — picks the bandpass frequency of the woodblock click.
              Higher pitches sit above most song content and are easier to pick
              out in dense mixes. Persisted per-user in localStorage. */}
          <div className="flex items-center gap-1" title="Pitch of the click. If you can't hear it in a dense mix, try a higher preset — it'll sit above most musical content. Persisted across sessions.">
            <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">Pitch</span>
            {(['low', 'mid', 'high', 'highest'] as const).map((p) => {
              const labels: Record<Pitch, string> = { low: 'Low', mid: 'Mid', high: 'High', highest: 'Top' };
              const titles: Record<Pitch, string> = {
                low: 'Low pitch (≈600 Hz, downbeat 900 Hz). Best when the song is bright and high-frequency-heavy.',
                mid: 'Mid pitch (≈1.4 kHz, downbeat 2.2 kHz). The default.',
                high: 'High pitch (≈2.8 kHz, downbeat 4.2 kHz). Cuts through most kicks and bass; may clash with vocals.',
                highest: 'Highest pitch (≈5 kHz, downbeat 7 kHz). Sits above almost all musical content — use when the click is being masked.',
              };
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setClickPitch(p)}
                  title={titles[p]}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition-colors ${
                    clickPitch === p
                      ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200'
                      : 'border-white/[0.08] bg-white/[0.02] text-slate-400 hover:border-emerald-500/30 hover:text-emerald-200'
                  }`}
                >
                  {labels[p]}
                </button>
              );
            })}
          </div>

          {/* Volume slider — controls the click master gain (0–200%). Persisted
              per-user in localStorage. Values above 100% give headroom over
              busy mixes; some systems will distort near 200%. */}
          <div className="flex items-center gap-1.5" title={`Metronome click volume: ${Math.round(clickVolume * 100)}%. Range 0–200% — values above 100% push the master gain past unity so the click can cut through loud songs (may distort on some systems).`}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-slate-500">
              {clickVolume === 0 ? (
                <>
                  <polygon points="2,6 5,6 9,3 9,13 5,10 2,10" fill="currentColor" />
                  <line x1="12" y1="6" x2="15" y2="10" />
                  <line x1="15" y1="6" x2="12" y2="10" />
                </>
              ) : (
                <>
                  <polygon points="2,6 5,6 9,3 9,13 5,10 2,10" fill="currentColor" />
                  <path d="M11 5 Q13 8 11 11" />
                  {clickVolume > 0.8 && <path d="M13 3 Q16 8 13 13" />}
                </>
              )}
            </svg>
            <input
              type="range" min={0} max={MAX_VOLUME} step={0.01}
              value={clickVolume}
              onChange={(e) => setClickVolume(parseFloat(e.target.value))}
              className="accent-emerald-500 w-28"
              aria-label="Metronome click volume"
              title={`Metronome click volume: ${Math.round(clickVolume * 100)}% (max 200%)`}
            />
            <span className={`text-[10px] font-mono tabular-nums w-10 text-right ${clickVolume > 1 ? 'text-amber-400' : 'text-slate-500'}`}>
              {Math.round(clickVolume * 100)}%
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
