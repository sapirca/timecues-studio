import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { effectiveGridMode, type SongInfo } from '../../types/songInfo';
import { beatsInRange as gridBeatsInRange } from '../../utils/beatGrid';
import { resolveGridSegments } from '../../utils/gridSegments';
import { gridSignature } from '../../utils/beatAnchoring';
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
  /** Whether the click track is armed. Controlled by the host so the
   *  Song-setup panel can show "click on / off" in the collapsed step
   *  header without reaching into this component's state. */
  clickEnabled: boolean;
  onClickEnabledChange: (next: boolean) => void;
  /** Reader for the LIVE media clock (PlayerPanel's `getTimeRef`). The click is
   *  placed against this, never against `playerTime` — that prop is the same
   *  number after a rAF coalesce, a setState and a full inspector re-render, so
   *  anchoring on it put the render's lag into the click's phase and the
   *  woodblock landed tens of milliseconds off the grid it is meant to verify.
   *  Optional: without it the panel falls back to the prop, as it used to. */
  getSongTime?: () => number | null;
  /** Player speed multiplier. Song seconds advance this much per wall second,
   *  so a beat `d` song-seconds away is `d / rate` wall-seconds away on the
   *  audio clock. Ignoring it made the click run at 1/rate the song's tempo —
   *  twice as many woodblocks as beats at 0.5x. */
  playbackRate?: number;
  /** Writes a tapped tempo back to the song's grid BPM. Omitted for
   *  read-only viewers; without it the tap tempo stays local to the click,
   *  which is the old behaviour. */
  onAdoptTappedBpm?: (bpm: number) => void;
  /** Imperative tap-tempo trigger — the T keyboard shortcut wires here so
   *  users can tap along without clicking the Tap button. Same reducer as
   *  the button. */
  tapRef?: RefObject<(() => void) | null>;
}

const SCHED_INTERVAL_MS = 25;
// How far ahead clicks are queued into the Web Audio clock. This must exceed
// the worst-case gap between scheduler ticks. Browsers throttle setInterval to
// ~1s once the tab is backgrounded, so a small (e.g. 0.1s) horizon would let
// the playhead outrun the queued clicks and the metronome would fall silent
// even though the song keeps playing. 2s gives comfortable margin over the ~1s
// throttle; already-queued clicks fire on time from the audio clock while the
// JS timer is stalled. The trade-off — up to 2s of clicks are queued ahead —
// is handled by cancelFutureClicks() on seek/stop.
const LOOKAHEAD_S = 2.0;
const SEEK_BACKWARD_THRESHOLD = -0.05;
const SEEK_FORWARD_THRESHOLD = 0.5;
/** How far the scheduler's extrapolated song time may drift from the media
 *  element's own clock before it re-anchors. Well above the sampling jitter of
 *  reading two clocks a statement apart, well below the smallest seek worth
 *  reacting to — and below a beat at any tempo, so a re-anchor never silently
 *  swallows one. */
const REANCHOR_TOLERANCE_S = 0.05;
/** Two beats closer together than this are the same beat, re-offered after a
 *  rewind. Nothing musical clicks at 3000 BPM. */
const DUPLICATE_BEAT_S = 0.02;
const CLICK_DURATION_S = 0.04;
const VOLUME_STORAGE_KEY = 'tc:metronome:volume';
const PITCH_STORAGE_KEY = 'tc:metronome:pitch';
const DEFAULT_VOLUME = 0.6;
/** Slider ceiling, as a multiplier on the click's master gain (800%). The click
 *  is a narrow bandpassed noise burst (Q=8), so most of the noise energy is
 *  filtered away and the rendered peak is far below full scale: at the previous
 *  200% ceiling it measured 0.09–0.36 depending on pitch preset. That left ~6x
 *  of clean headroom unused, which is why the click could be inaudible under a
 *  loud song at "maximum". 800% spends 4x of it — a straight +12 dB. */
const MAX_VOLUME = 8.0;
/** Amplitude at which the master soft-clip curve leaves the identity line. Below
 *  it the signal is passed through untouched, so nothing that was already clean
 *  changes; the knee only shapes peaks that would otherwise overflow. */
const SOFT_CLIP_KNEE = 0.6;

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
 *  grid. Thin adapter over beatGrid's `beatsInRange`: it pulls the click-track
 *  inputs off SongInfo (the overrides and the segment table each only in the
 *  mode that actually owns them) and delegates the actual walk. The shared
 *  helper treats gridOffset as phase only, so clicks sound the same before and
 *  after the offset.
 *
 *  The segments come from the same `resolveGridSegments` the waveform's grid
 *  lines are drawn from, so a mapped song clicks the tempo and the meter of
 *  whichever segment the playhead is in, and accents that segment's own bar 1.
 *  Without them the click ran the opening segment's tempo over the whole song
 *  and drifted away from the very lines it is meant to verify. */
export function metronomeBeatsInRange(songInfo: SongInfo, from: number, to: number): Array<{ t: number; isDownbeat: boolean }> {
  const bpm = songInfo.bpm;
  if (!bpm || bpm <= 0) return [];
  const beatsPerBar = parseBeatsPerBar(songInfo.timeSignature);
  const offset = songInfo.gridOffset ?? 0;
  const overrides = effectiveGridMode(songInfo) === 'manual' && songInfo.beatOverrides ? songInfo.beatOverrides : undefined;
  const segments = resolveGridSegments(songInfo);
  return gridBeatsInRange(bpm, offset, beatsPerBar, from, to, overrides, segments);
}

/** Resolve the grid the click scheduler should tick against. The metronome is
 *  decoupled from the song's saved grid: tapping sets a local `tappedBpm` that
 *  drives the click WITHOUT writing anything back to the dataset. When the user
 *  has tapped a value we click a steady pulse at that BPM (per-beat overrides
 *  are a grid concern, so they're dropped); otherwise we fall back to
 *  the song's own grid so the panel still works out of the box. Either way we
 *  keep the song's gridOffset + timeSignature for phase + downbeat accenting. */
function effectiveMetroInfo(base: SongInfo | null, tappedBpm: number | null): SongInfo | null {
  if (tappedBpm != null) {
    return {
      ...(base ?? {}),
      bpm: tappedBpm,
      beatOverrides: undefined,
      // A tapped tempo is a steady pulse by definition, so the segment map goes
      // with the pinned beats — otherwise the taps would set the opening
      // segment's tempo and every later segment would ignore them.
      gridSegments: undefined,
    } as SongInfo;
  }
  return base;
}

/** Identity of the grid the CLICK is ticking against. Two SongInfos with the
 *  same signature place every woodblock at the same time, so nothing that is
 *  already queued needs throwing away.
 *
 *  Built on the shared `gridSignature` — same bpm / offset / meter / mode /
 *  segments — with the two inputs that are the click's alone bolted
 *  on: the Manual-mode pinned beats (which move individual clicks and are not
 *  part of the shared identity) and the local tapped tempo, which lives only in
 *  this panel and never reaches SongInfo. Fed `effectiveMetroInfo`, so a tapped
 *  tempo correctly reads as "steady pulse, no splits". */
export function metronomeGridSignature(base: SongInfo | null, tappedBpm: number | null): string {
  const info = effectiveMetroInfo(base, tappedBpm);
  if (!info) return 'none';
  const overrides = effectiveGridMode(info) === 'manual' && info.beatOverrides
    ? Object.keys(info.beatOverrides)
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => `${k}@${(info.beatOverrides as Record<string, number>)[k].toFixed(6)}`)
        .join(',')
    : '';
  return `${gridSignature(info)}|${overrides}|tap:${tappedBpm ?? ''}`;
}

/** Build the master soft-clip curve: identity up to SOFT_CLIP_KNEE, then a tanh
 *  knee that flattens out at the ceiling. This is the safety net for the top of
 *  the volume range. The bandpass passes more energy the higher its centre
 *  frequency sits, so the High and Top pitch presets are the loud ones: measured
 *  at 800% they peak at 1.26 and 1.45 — over full scale, which the DAC would
 *  turn into an audible crackle. The knee rounds those peaks back to 0.93 / 0.97
 *  with nothing clipped, and leaves Low and Mid (0.36 / 0.65 at the same
 *  setting) bit-for-bit untouched. */
function makeSoftClipCurve(samples = 4096): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(samples);
  const knee = SOFT_CLIP_KNEE;
  const span = 1 - knee;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    const mag = Math.abs(x);
    curve[i] = mag <= knee
      ? x
      : Math.sign(x) * (knee + span * Math.tanh((mag - knee) / span));
  }
  return curve;
}

/** Schedule a single beat click. Downbeats are louder + higher-pitched
 *  (woodblock-ish). Returns the source + envelope nodes so a later seek/stop
 *  can silence clicks that were queued ahead but haven't fired yet. */
function scheduleClick(ctx: AudioContext, master: GainNode, startAt: number, isDownbeat: boolean, pitch: Pitch): { src: AudioBufferSourceNode; env: GainNode } {
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
  return { src, env };
}

export function MetronomePanel({
  songInfo,
  playerTime,
  playerIsPlaying,
  clickEnabled,
  onClickEnabledChange,
  getSongTime,
  playbackRate = 1,
  onAdoptTappedBpm,
  tapRef,
}: MetronomePanelProps) {
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
  // Clicks queued ahead into the audio clock (up to LOOKAHEAD_S). Tracked so a
  // seek or stop can silence the ones that haven't fired yet.
  const scheduledRef = useRef<Array<{ src: AudioBufferSourceNode; env: GainNode; at: number }>>([]);
  // Maps the song clock to the Web Audio clock: { ctxT, songT }. Both ends come
  // from a clock that cannot lie: `songT` is read off the media element itself,
  // `ctxT` off the AudioContext, and the two share the audio hardware clock, so
  // one anchor holds for a whole playback segment. Every click's placement then
  // reduces to `ctxT + (beat - songT) / rate` — no React value anywhere in it.
  // That matters twice over: the `playerTime` prop is a render behind the audio
  // (its lag became the click's phase error), and it stops arriving altogether
  // in a backgrounded tab, where ctx.currentTime keeps counting and the clicks
  // keep landing. Re-anchored only when the media clock says we have actually
  // jumped — see the scheduler tick.
  const clockAnchorRef = useRef<{ ctxT: number; songT: number } | null>(null);
  // Song time of the last beat handed to scheduleClick. Guards against the same
  // beat being queued twice when a re-anchor rewinds the cursor into a window
  // that was already scheduled — the audible symptom was a doubled woodblock,
  // read as "the metronome is making more beats than the song has".
  const lastScheduledBeatRef = useRef<number | null>(null);
  // True while the anchor was taken from the `playerTime` prop because the
  // player had not yet handed over its clock reader — a remount mid-playback,
  // a hot reload in dev. Such an anchor carries the prop's lag, and that lag is
  // smaller than REANCHOR_TOLERANCE_S, so nothing else would ever correct it:
  // the first tick that can read the media clock re-anchors unconditionally.
  const anchorIsProvisionalRef = useRef(false);
  const getSongTimeRef = useRef(getSongTime);
  const rateRef = useRef(playbackRate);
  songInfoRef.current = songInfo;
  playerTimeRef.current = playerTime;
  getSongTimeRef.current = getSongTime;
  rateRef.current = playbackRate > 0 ? playbackRate : 1;

  /** The song clock as the media element itself keeps it, or null when the
   *  player hasn't handed us a reader yet. This is the only truthful "where are
   *  we" in the component: `playerTime` is this same number after a rAF
   *  coalesce, a setState and a re-render of the whole inspector. */
  const readMediaTime = useCallback((): number | null => {
    const t = getSongTimeRef.current?.();
    return typeof t === 'number' && Number.isFinite(t) ? t : null;
  }, []);

  // Best estimate of the current song time, robust to a stalled rAF time feed.
  // Song seconds advance `rate` per wall second, so the elapsed audio-clock time
  // is scaled by the player's speed.
  const estimateSongTime = useCallback((): number => {
    const ctx = ctxRef.current;
    const anchor = clockAnchorRef.current;
    if (!ctx || !anchor) return readMediaTime() ?? playerTimeRef.current;
    return anchor.songT + (ctx.currentTime - anchor.ctxT) * rateRef.current;
  }, [readMediaTime]);

  // Silence every queued click that hasn't started yet, and forget the ones
  // that already fired. Called on seek and on stop so a long lookahead never
  // leaves stale clicks ringing at the wrong song position.
  const cancelFutureClicks = useCallback(() => {
    const ctx = ctxRef.current;
    const now = ctx ? ctx.currentTime : 0;
    const keep: typeof scheduledRef.current = [];
    for (const node of scheduledRef.current) {
      if (ctx && node.at > now) {
        try {
          node.env.gain.cancelScheduledValues(now);
          node.env.gain.setValueAtTime(0, now);
          node.src.stop(now);
        } catch { /* node already started/stopped — nothing to cancel */ }
      } else {
        keep.push(node); // already firing/fired — let it ring out
      }
    }
    scheduledRef.current = keep;
  }, []);

  // Detect seeks (large playhead jumps) and reset the scheduler cursor so
  // clicks aren't replayed or skipped. Only a fallback: when the player gives
  // us a live clock reader, the scheduler tick spots a discontinuity itself by
  // comparing its own extrapolation against the media clock, which cannot be
  // fooled by a prop that merely arrived late. This prop-delta test could be —
  // a render that took longer than SEEK_FORWARD_THRESHOLD looks exactly like a
  // forward seek, and "re-anchoring" on one both shifted the click's phase and
  // re-queued a beat that had already sounded.
  useEffect(() => {
    if (getSongTimeRef.current) { lastSeenTimeRef.current = playerTime; return; }
    const delta = playerTime - lastSeenTimeRef.current;
    if (delta < SEEK_BACKWARD_THRESHOLD || delta > SEEK_FORWARD_THRESHOLD) {
      cursorRef.current = playerTime;
      // Drop clicks queued for the old position so the jump doesn't replay them.
      cancelFutureClicks();
      // Re-anchor the song↔audio clock map ONLY on a real discontinuity. A
      // click's audio-clock time reduces to `anchor.ctxT + (b.t - anchor.songT)`,
      // so its placement depends solely on this anchor — NOT on the per-beat
      // clock read. Re-anchoring every frame from the rAF-fed `playerTime` (which
      // carries ±10ms sampling jitter between when the player time is true and
      // when ctx.currentTime is read) injected that jitter straight into the
      // click spacing, so a steady tempo wobbled audibly. The media element and
      // the AudioContext share the audio hardware clock, so a single anchor stays
      // in sync for the whole playback segment without per-frame correction. A
      // backgrounded tab (rAF frozen) is covered because estimateSongTime()
      // extrapolates from ctx.currentTime; returning to the foreground produces a
      // large playerTime jump that lands here and re-anchors.
      const ctx = ctxRef.current;
      if (ctx) clockAnchorRef.current = { ctxT: ctx.currentTime, songT: playerTime };
    }
    lastSeenTimeRef.current = playerTime;
  }, [playerTime, cancelFutureClicks]);

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
      // Master chain: gain → soft-clip → speakers. The shaper is what makes the
      // above-unity part of the volume range usable (see makeSoftClipCurve).
      const shaper = ctxRef.current.createWaveShaper();
      shaper.curve = makeSoftClipCurve();
      shaper.oversample = '4x'; // limits the aliasing the knee would otherwise fold back in
      g.connect(shaper).connect(ctxRef.current.destination);
      masterGainRef.current = g;
    }
    const ctx = ctxRef.current;
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  }, [clickVolume]);

  // Hand the audio device back when the panel closes.
  //
  // An AudioContext is not memory the collector can reclaim on its own: for as
  // long as it lives it holds an output thread on the audio hardware, and
  // Chrome refuses to construct more than a handful per document. This panel
  // unmounts every time its step section is collapsed or the setup pane is
  // left, so a context left behind here was leaked once per visit — a long
  // session eventually hit the ceiling and `new AudioContext()` started
  // throwing, which is the click going permanently silent with no way back
  // short of a reload.
  //
  // close() stops anything still queued, but drop our handles on the scheduled
  // nodes too so the click buffers that were waiting on them go with it.
  useEffect(() => () => {
    const ctx = ctxRef.current;
    ctxRef.current = null;
    masterGainRef.current = null;
    scheduledRef.current = [];
    clockAnchorRef.current = null;
    if (ctx) { try { void ctx.close().catch(() => {}); } catch { /* already closed */ } }
  }, []);

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
    // Anchor on the media element's own clock, not on `playerTime`. The prop is
    // the last value that made it through rAF + setState + a render of the whole
    // inspector, so at the instant playback starts it is already tens of
    // milliseconds behind the audio — and because every click's audio-clock time
    // is derived from this one anchor, that lag became the click's permanent
    // phase error. Measured against a 64.75 BPM / 0.406 s grid the woodblock sat
    // 31-55 ms late on every beat: audible as a flam against the drums, which is
    // exactly the drift the click exists to expose.
    const mediaAtStart = readMediaTime();
    const startT = mediaAtStart ?? playerTimeRef.current;
    anchorIsProvisionalRef.current = mediaAtStart == null;
    cursorRef.current = startT;
    lastScheduledBeatRef.current = null;
    clockAnchorRef.current = { ctxT: ctx.currentTime, songT: startT };

    const tick = () => {
      const info = effectiveMetroInfo(songInfoRef.current, tappedBpmRef.current);
      if (!info || !info.bpm) return;
      const rate = rateRef.current;
      // Use the extrapolated song time, not the raw prop: in a backgrounded tab
      // the prop's rAF feed freezes while the song (and ctx.currentTime) play on.
      let now = estimateSongTime();
      // Re-anchor only on a REAL discontinuity, and let the media clock be what
      // says so: a seek, a rate change, or the element stalling all show up as
      // the extrapolation disagreeing with the element. Everything queued for
      // the old position is dropped, and the cursor rewinds to the true
      // position so the new one gets its clicks.
      const media = readMediaTime();
      if (media != null && (anchorIsProvisionalRef.current || Math.abs(media - now) > REANCHOR_TOLERANCE_S)) {
        anchorIsProvisionalRef.current = false;
        clockAnchorRef.current = { ctxT: ctx.currentTime, songT: media };
        cancelFutureClicks();
        now = media;
        cursorRef.current = media;
        // The queue was just thrown away, so "the last beat we scheduled" no
        // longer describes anything audible. Beats before `media` have already
        // sounded and are excluded by the window; beats after it are new.
        lastScheduledBeatRef.current = null;
      }
      const horizon = now + LOOKAHEAD_S;
      const from = Math.max(cursorRef.current, now);
      const beats = metronomeBeatsInRange(info, from, horizon);
      for (const b of beats) {
        // A beat this close to the one we just queued is the same beat coming
        // round again at the seam between two look-ahead windows, not a new one
        // — no grid clicks twice inside DUPLICATE_BEAT_S (that'd be 3000 BPM).
        const last = lastScheduledBeatRef.current;
        if (last != null && Math.abs(b.t - last) < DUPLICATE_BEAT_S) continue;
        // Song seconds -> wall seconds: at 0.5x the beat 1 s of song away is
        // 2 s of wall clock away. Dividing by the rate is what keeps the click
        // on the beat instead of running the grid at double tempo.
        const startAt = ctx.currentTime + Math.max(0, b.t - now) / rate;
        const nodes = scheduleClick(ctx, master, startAt, b.isDownbeat, clickPitchRef.current);
        scheduledRef.current.push({ ...nodes, at: startAt });
        lastScheduledBeatRef.current = b.t;
      }
      cursorRef.current = horizon;
      // Forget clicks that have already finished so the tracking array doesn't
      // grow without bound over a long playthrough.
      const cutoff = ctx.currentTime - CLICK_DURATION_S;
      if (scheduledRef.current.length > 64) {
        scheduledRef.current = scheduledRef.current.filter((n) => n.at >= cutoff);
      }
    };

    // Fill the look-ahead window immediately so the first beats are queued at
    // playback start instead of after the first 25ms interval — and so they're
    // placed against the anchor just set above, before any other effect runs.
    tick();
    const id = window.setInterval(tick, SCHED_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
      // Stopping playback (or losing the grid) silences anything still queued.
      cancelFutureClicks();
    };
  }, [playerIsPlaying, clickEnabled, hasGrid, cancelFutureClicks, estimateSongTime, readMediaTime]);

  // Re-tempo the click the instant the grid changes under it.
  //
  // The scheduler tick already reads `songInfoRef.current` fresh, so it starts
  // using a new grid straight away — but that alone is not enough, and the gap
  // is audible. Up to LOOKAHEAD_S of woodblocks are ALREADY queued on the Web
  // Audio clock at the old tempo and nothing was cancelling them, while
  // `cursorRef` had been parked a full look-ahead into the future, so
  // `from = max(cursor, now)` skipped every new-grid beat inside that same
  // window. Flipping Static <-> Dynamic, nudging BPM, or dragging the offset
  // mid-playback therefore bought 2 s of the OLD tempo before the new one
  // arrived — the exact wrong-tempo click the panel exists to rule out, and the
  // worst possible moment for it: right when the curator is listening to judge
  // the change they just made.
  //
  // So on a real change of grid identity: kill what is queued, rewind the
  // cursor to the live position, and forget the last beat (it described the old
  // grid). The next tick, <=25 ms later, refills the whole window from the new
  // one. Only the effective grid counts — `metronomeGridSignature` is content-
  // based, so a re-render that merely rebuilds an identical SongInfo object is
  // not a change and never interrupts a click that is already correct.
  const gridSig = useMemo(
    () => metronomeGridSignature(songInfo, tappedBpm),
    [songInfo, tappedBpm],
  );
  const gridSigRef = useRef(gridSig);
  useEffect(() => {
    if (gridSigRef.current === gridSig) return;
    gridSigRef.current = gridSig;
    // Paused, or the click is off: nothing is queued, and the scheduler effect
    // re-anchors from scratch next time it starts. Recording the new signature
    // above is all this case needs.
    if (!playerIsPlaying || !clickEnabled) return;
    cancelFutureClicks();
    cursorRef.current = estimateSongTime();
    lastScheduledBeatRef.current = null;
  }, [gridSig, playerIsPlaying, clickEnabled, cancelFutureClicks, estimateSongTime]);

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

  // Whether clicks are actually sounding right now — the toggle is a passive
  // flag, so being armed isn't enough; the song has to be playing too.
  const clicksAudible = hasGrid && clickEnabled && playerIsPlaying;

  // Where the metronome's current tempo is coming from.
  const bpmSource: string =
    tappedBpm != null ? 'from your taps'
    : songBpm != null ? "from the song's BPM"
    : 'no tempo yet';
  const canClear = tapTimes.length > 0 || tappedBpm != null;
  // Only offer "use this as the song BPM" once the taps have settled on a
  // value that actually differs from what the grid already has — otherwise
  // the button is a no-op sitting in the way.
  const adoptable =
    onAdoptTappedBpm && tappedBpm != null && (songBpm == null || Math.abs(songBpm - tappedBpm) >= 0.05)
      ? tappedBpm
      : null;

  return (
    <div className="space-y-3.5">
      {/* ── LISTEN — the click track. This is what verifies the grid: if the
              click drifts off the drums, the BPM or the downbeat is wrong. ── */}
      <button
        type="button"
        onClick={() => {
          // Create + resume the AudioContext inside the user gesture so
          // Chrome's autoplay policy lets clicks through. Schedule clicks
          // continue to come from the effect; this just unlocks audio.
          if (!clickEnabled) ensureAudioContext();
          onClickEnabledChange(!clickEnabled);
        }}
        disabled={!hasGrid}
        title="Turn the click track on or off. When ON, you'll hear a click on every beat while the song plays. It does NOT start the song; press Spacebar to play."
        className={`w-full inline-flex items-center justify-center gap-2.5 px-4 py-3 rounded-md text-sm font-semibold border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
          clickEnabled
            ? 'border-emerald-500/60 bg-emerald-500/20 text-emerald-50 hover:bg-emerald-500/30'
            : 'border-slate-600/60 bg-slate-800/40 text-slate-200 hover:bg-slate-700/60'
        }`}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polygon points="2,6 5,6 9,3 9,13 5,10 2,10" fill="currentColor" stroke="none" />
          {clickEnabled ? (
            <>
              <path d="M11.5 5 Q13.5 8 11.5 11" />
              <path d="M13.8 3 Q16.4 8 13.8 13" />
            </>
          ) : (
            <>
              <line x1="12" y1="5.5" x2="15" y2="10.5" />
              <line x1="15" y1="5.5" x2="12" y2="10.5" />
            </>
          )}
        </svg>
        {clickEnabled ? 'Click is on' : 'Turn the click on'}
      </button>
      <p className="-mt-1.5 text-[11px] leading-snug text-slate-500 text-pretty">
        A woodblock on every beat, accented on bar 1. {clicksAudible
          ? 'Listen for it drifting off the drums.'
          : 'Press Space to play the song and listen for drift.'}
      </p>

      <div className="flex items-center gap-2.5">
        <span className="shrink-0 w-[52px] text-[11px] text-slate-400">Volume</span>
        <input
          type="range" min={0} max={MAX_VOLUME} step={0.05}
          value={clickVolume}
          onChange={(e) => setClickVolume(parseFloat(e.target.value))}
          className="flex-1 min-w-0 accent-emerald-500"
          aria-label="Metronome click volume"
          title={`Metronome click volume: ${Math.round(clickVolume * 100)}%. Range 0–800% — 100% is normal full volume, not the maximum. The range above 100% is what makes the click audible over a loud song; a limiter keeps the top of the range from breaking up.`}
        />
        <span className={`shrink-0 w-9 text-right font-mono text-[11px] tabular-nums ${clickVolume > 4 ? 'text-rose-400' : clickVolume > 1 ? 'text-amber-400' : 'text-slate-400'}`}>
          {Math.round(clickVolume * 100)}%
        </span>
      </div>

      <div className="flex items-center gap-2.5">
        <span
          className="shrink-0 w-[52px] text-[11px] text-slate-400"
          title="Pitch of the click. If you can't hear it in a dense mix, try a higher preset — it'll sit above most musical content. Persisted across sessions."
        >
          Tone
        </span>
        <div className="flex-1 min-w-0 flex gap-1.5">
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
                className={`flex-1 basis-0 min-w-0 py-1.5 rounded-[5px] border text-[11px] transition-colors ${
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
      </div>

      {/* ── DETECT — tap along to find a tempo by ear. It drives the click
              immediately; writing it back to the song's grid is a separate,
              explicit click, so the two BPMs can never silently diverge. ── */}
      <div className="space-y-2.5 pt-3 border-t border-white/[0.05]">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className="text-xs font-semibold text-slate-300"
            title="Tap along on every beat and the BPM updates live from the rolling average of your last few taps. Once it locks onto a tempo it stays put: a single off-beat tap is ignored as a slip, and only a sustained change (two off-tempo taps in a row) re-locks onto the new tempo."
          >
            Can't place it? Tap along.
          </span>
          <span className="font-mono text-[10px] tabular-nums text-slate-500">
            {tapTimes.length} tap{tapTimes.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onMouseDown={handleTap}
            title="Tap on every beat. The click's tempo updates live from the second tap onward and settles once it locks on — a stray tap won't throw it off. (T)"
            className="shrink-0 px-5 py-2.5 rounded-md text-sm font-semibold tracking-wider border border-white/[0.12] bg-white/[0.04] text-slate-100 hover:bg-white/[0.08] active:bg-emerald-500/30 active:scale-[0.97] select-none transition-all"
          >
            TAP · T
          </button>
          <div className="min-w-0 flex flex-col leading-none">
            <span className="font-mono text-lg font-semibold tabular-nums text-slate-100">
              {metroBpm != null ? metroBpm : '—'}
            </span>
            <span className="mt-1 text-[10px] text-slate-500 truncate">
              {bpmSource}
              {tappedBpm != null && songBpm != null && ` · song is ${songBpm}`}
            </span>
          </div>
          {canClear && (
            <button
              type="button"
              onClick={handleClearTap}
              title="Reset the tapped tempo and the tap buffer. The click falls back to the song's BPM. Never changes the song's grid."
              className="ml-auto shrink-0 px-2.5 py-1.5 rounded text-[11px] border border-white/[0.08] bg-white/[0.02] text-slate-400 hover:border-white/20 hover:text-slate-200 transition-colors"
            >
              Discard
            </button>
          )}
        </div>

        {adoptable != null && (
          <button
            type="button"
            onClick={() => onAdoptTappedBpm?.(adoptable)}
            title="Write the tapped tempo into the song's grid BPM. Until you do, tapping only changes what you hear."
            className="w-full px-3 py-2 rounded-md text-xs font-semibold border border-violet-400/50 bg-violet-500/15 text-violet-100 hover:bg-violet-500/25 transition-colors"
          >
            Use {adoptable} as the song BPM
          </button>
        )}
      </div>
    </div>
  );
}
