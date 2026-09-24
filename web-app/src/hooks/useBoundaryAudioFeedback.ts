import { useCallback, useEffect, useRef } from 'react';

export interface BoundaryLayer {
  id: string;
  /** Boundary times in seconds. Sorted ascending. */
  times: number[];
  enabled: boolean;
  /** Hz of the click sine pip; differentiate layers aurally. */
  clickFreq: number;
  /** -1 (full L) ... +1 (full R). 0 = center. */
  pan: number;
  /** 0..1 */
  gain: number;
}

const LOOKAHEAD_S = 0.1;
const SCHED_INTERVAL_MS = 25;
const CLICK_DURATION_S = 0.030;
const CLICK_ATTACK_S = 0.0005;
// Treat any time-delta outside this window as a seek (backward jump or forward skip).
const SEEK_BACKWARD_THRESHOLD = -0.05;
const SEEK_FORWARD_THRESHOLD = 0.5;

/**
 * Schedules short sine-pip clicks on the AudioContext timeline whenever the
 * playhead crosses a layer's boundary. Clicks are panned per-layer so the user
 * can compare e.g. Manual (left ear) against Consensus (right ear).
 *
 * `currentTime` and `isPlaying` come from the parent's PlayerPanel callbacks.
 * Boundaries falling within [cursor, currentTime + 0.1s) are scheduled ahead
 * via Web Audio's sample-accurate timeline; the cursor advances each tick to
 * avoid duplicates. Seek detection (large or backward time jumps) resets the
 * per-layer cursors so clicks aren't replayed or skipped.
 *
 * Placement runs off a song↔audio clock anchor rather than off the incoming
 * `currentTime` prop — see clockAnchorRef below for why that distinction is
 * the difference between pips that sit on the beat and pips that wander.
 */
export function useBoundaryAudioFeedback(
  layers: BoundaryLayer[],
  currentTime: number,
  isPlaying: boolean,
  /** Player speed multiplier; song seconds advance this much per wall second. */
  playbackRate: number = 1,
) {
  const ctxRef = useRef<AudioContext | null>(null);
  const cursorRef = useRef<Map<string, number>>(new Map());
  const layersRef = useRef(layers);
  const currentTimeRef = useRef(currentTime);
  const lastSeenTimeRef = useRef(currentTime);
  const rateRef = useRef(playbackRate);
  // Maps the song clock to the Web Audio clock: { ctxT, songT }. `currentTime`
  // arrives via WaveSurfer audioprocess → rAF → a setState on the whole
  // inspector page, so by the time a scheduler tick reads it, it is stale by a
  // render's worth — tens of milliseconds, and more the heavier the tree is.
  // Deriving each pip's audio-clock time from that prop (the old
  // `ctx.currentTime + (t - now)`) folded that lag straight into the pip:
  // every pip landed late by however long the last render took, so the same
  // marker sat somewhere different against the music on every playthrough.
  // Anchoring once per playback segment removes the prop from the placement
  // math entirely — a pip's time reduces to `ctxT + (t - songT) / rate`, which
  // depends only on the anchor. The media element and the AudioContext share
  // the audio hardware clock, so one anchor holds for the whole segment.
  // Mirrors the fix already in MetronomePanel's scheduler.
  const clockAnchorRef = useRef<{ ctxT: number; songT: number } | null>(null);
  // Pips queued ahead into the audio clock (up to LOOKAHEAD_S). Tracked so a
  // seek or a stop can silence the ones that haven't fired yet.
  const scheduledRef = useRef<Array<{ osc: OscillatorNode; env: GainNode; at: number }>>([]);
  layersRef.current = layers;
  currentTimeRef.current = currentTime;
  rateRef.current = playbackRate;

  useEffect(() => {
    return () => {
      ctxRef.current?.close();
      ctxRef.current = null;
    };
  }, []);

  /** Song time extrapolated from the audio clock — immune to the prop's lag,
   *  and still ticking when a backgrounded tab freezes rAF. */
  const estimateSongTime = useCallback((): number => {
    const ctx = ctxRef.current;
    const anchor = clockAnchorRef.current;
    if (!ctx || !anchor) return currentTimeRef.current;
    return anchor.songT + (ctx.currentTime - anchor.ctxT) * rateRef.current;
  }, []);

  /** Silence every queued pip that hasn't started yet. Called on seek and on
   *  stop so the lookahead never leaves pips ringing at the wrong position. */
  const cancelFutureClicks = useCallback(() => {
    const ctx = ctxRef.current;
    const now = ctx ? ctx.currentTime : 0;
    const keep: typeof scheduledRef.current = [];
    for (const node of scheduledRef.current) {
      if (ctx && node.at > now) {
        try {
          node.env.gain.cancelScheduledValues(now);
          node.env.gain.setValueAtTime(0, now);
          node.osc.stop(now);
        } catch { /* node already started/stopped — nothing to cancel */ }
      } else {
        keep.push(node); // already firing/fired — let it ring out
      }
    }
    scheduledRef.current = keep;
  }, []);

  useEffect(() => {
    const delta = currentTime - lastSeenTimeRef.current;
    if (delta < SEEK_BACKWARD_THRESHOLD || delta > SEEK_FORWARD_THRESHOLD) {
      cursorRef.current = new Map(
        layersRef.current.map((l) => [l.id, currentTime]),
      );
      cancelFutureClicks();
      // Re-anchor ONLY on a real discontinuity. Re-anchoring on every prop
      // value would put the prop's staleness back into the placement math,
      // which is the whole thing the anchor exists to keep out.
      const ctx = ctxRef.current;
      if (ctx) clockAnchorRef.current = { ctxT: ctx.currentTime, songT: currentTime };
    }
    lastSeenTimeRef.current = currentTime;
  }, [currentTime, cancelFutureClicks]);

  // A speed change rescales song-time-per-wall-second, so the standing anchor
  // no longer describes the transport. Re-anchor and drop what was queued
  // against the old rate.
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx || !isPlaying) return;
    cancelFutureClicks();
    clockAnchorRef.current = { ctxT: ctx.currentTime, songT: currentTimeRef.current };
  }, [playbackRate, isPlaying, cancelFutureClicks]);

  useEffect(() => {
    if (!isPlaying) return;

    if (!ctxRef.current) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctxRef.current = new Ctor();
    }
    const ctx = ctxRef.current;
    if (ctx.state === 'suspended') void ctx.resume();

    cursorRef.current = new Map(
      layersRef.current.map((l) => [l.id, currentTimeRef.current]),
    );
    clockAnchorRef.current = { ctxT: ctx.currentTime, songT: currentTimeRef.current };

    const tick = () => {
      const anchor = clockAnchorRef.current;
      if (!anchor) return;
      const rate = rateRef.current || 1;
      const now = estimateSongTime();
      const horizon = now + LOOKAHEAD_S;

      for (const layer of layersRef.current) {
        if (!layer.enabled || layer.times.length === 0) continue;
        const cursor = cursorRef.current.get(layer.id) ?? now;
        for (const t of layer.times) {
          if (t < cursor) continue;
          if (t >= horizon) break;
          // Song time → audio clock through the anchor alone.
          const startAt = Math.max(
            ctx.currentTime,
            anchor.ctxT + (t - anchor.songT) / rate,
          );
          scheduledRef.current.push(scheduleClick(ctx, startAt, layer));
        }
        cursorRef.current.set(layer.id, horizon);
      }

      // Forget pips that have already finished so the tracking array doesn't
      // grow without bound over a long playthrough.
      const cutoff = ctx.currentTime - CLICK_DURATION_S;
      if (scheduledRef.current.length > 64) {
        scheduledRef.current = scheduledRef.current.filter((n) => n.at >= cutoff);
      }
    };

    // Fill the lookahead window immediately so the first pips are placed
    // against the anchor just set, not one interval later.
    tick();
    const interval = window.setInterval(tick, SCHED_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
      cancelFutureClicks();
    };
  }, [isPlaying, estimateSongTime, cancelFutureClicks]);
}

function scheduleClick(ctx: AudioContext, startAt: number, layer: BoundaryLayer) {
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = layer.clickFreq;

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, startAt);
  env.gain.linearRampToValueAtTime(layer.gain, startAt + CLICK_ATTACK_S);
  env.gain.exponentialRampToValueAtTime(0.0001, startAt + CLICK_DURATION_S);

  const panner = ctx.createStereoPanner();
  panner.pan.value = layer.pan;

  osc.connect(env).connect(panner).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + CLICK_DURATION_S + 0.01);
  return { osc, env, at: startAt };
}
