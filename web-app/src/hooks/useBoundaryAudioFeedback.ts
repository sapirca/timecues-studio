import { useEffect, useRef } from 'react';

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
 */
export function useBoundaryAudioFeedback(
  layers: BoundaryLayer[],
  currentTime: number,
  isPlaying: boolean,
) {
  const ctxRef = useRef<AudioContext | null>(null);
  const cursorRef = useRef<Map<string, number>>(new Map());
  const layersRef = useRef(layers);
  const currentTimeRef = useRef(currentTime);
  const lastSeenTimeRef = useRef(currentTime);
  layersRef.current = layers;
  currentTimeRef.current = currentTime;

  useEffect(() => {
    const delta = currentTime - lastSeenTimeRef.current;
    if (delta < SEEK_BACKWARD_THRESHOLD || delta > SEEK_FORWARD_THRESHOLD) {
      cursorRef.current = new Map(
        layersRef.current.map((l) => [l.id, currentTime]),
      );
    }
    lastSeenTimeRef.current = currentTime;
  }, [currentTime]);

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

    const tick = () => {
      const now = currentTimeRef.current;
      const horizon = now + LOOKAHEAD_S;

      for (const layer of layersRef.current) {
        if (!layer.enabled || layer.times.length === 0) continue;
        const cursor = cursorRef.current.get(layer.id) ?? now;
        for (const t of layer.times) {
          if (t < cursor) continue;
          if (t >= horizon) break;
          scheduleClick(ctx, t - now, layer);
        }
        cursorRef.current.set(layer.id, horizon);
      }
    };

    const interval = window.setInterval(tick, SCHED_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [isPlaying]);
}

function scheduleClick(ctx: AudioContext, dtFromNow: number, layer: BoundaryLayer) {
  const startAt = ctx.currentTime + Math.max(0, dtFromNow);
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
}
