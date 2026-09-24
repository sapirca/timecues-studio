/**
 * useLoopPlayback — seamless audio looping over a (start, end) interval.
 *
 * Wraps the Web Audio API's AudioBufferSourceNode's native loop facility,
 * which is sample-accurate (no JS-timer drift between repetitions). On each
 * play call we snap the start/end to the nearest zero-crossing in the
 * AudioBuffer to suppress the audible click that otherwise occurs at the
 * seam where the loop wraps. The snap window is ±20 ms, which is wider
 * than one period of a 50 Hz tone (the lower edge of any musical content)
 * so even sustained bass should find a clean crossing.
 *
 * Use case: phrase auditioning. Pressing "Loop play" on a Loop annotation
 * lets the user verify that the rhythmic signature and instrumentation
 * remain consistent through the marked region.
 *
 * Because this engine is a separate Web Audio source, the main WaveSurfer
 * player is paused while it runs and therefore emits no time updates. We
 * report the live position off the AudioContext clock through `onPosition`
 * so the caller can drive the playhead (and every currentTime-driven overlay)
 * through the loop instead of leaving it frozen where playback stopped.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** ±20 ms search window for zero-crossing snap. Larger gives better
 *  suppression for low-frequency content; smaller is more time-accurate. */
const ZERO_CROSS_SEARCH_MS = 20;

interface UseLoopPlaybackArgs {
  audioBuffer: AudioBuffer | null;
  /** Live playback position in seconds within the source buffer, wrapping at
   *  the loop seam — once per animation frame while a loop plays, then `null`
   *  when it ends so the caller can hand the playhead back to the player.
   *
   *  A callback, not returned state, on purpose: a 60 Hz value in this hook's
   *  state would make every consumer re-render from inside a passive effect
   *  each frame, which React counts as a runaway nested update and aborts with
   *  "Maximum update depth exceeded". Calling out from the rAF instead makes
   *  each frame an ordinary top-level update — the same shape PlayerPanel uses
   *  for its own coalesced time updates. */
  onPosition?: (timeSec: number | null) => void;
}

interface UseLoopPlaybackResult {
  /** True while a loop is currently playing. */
  isPlaying: boolean;
  /** Which loop is playing, if any. Use this to mark the corresponding row
   *  in the editor / canvas. The caller assigns the id (often the LoopItem id). */
  playingId: string | null;
  /** The live position inside the source buffer, read straight off the
   *  AudioContext clock at the moment of the call — `null` when no loop is
   *  sounding. The `onPosition` callback publishes the same number, but only
   *  once per animation frame and through the caller's React state; anything
   *  that has to place a mark where the annotator is *listening* (a cue
   *  dropped with M during a loop preview) must read it here instead. */
  getTime: () => number | null;
  /** Start looping [startSec, endSec], snapping each boundary to a nearby
   *  zero-crossing in the buffer. Re-callable: stops any running loop first.
   *  Pass an id (the LoopItem id) so the caller can tell which loop is live.
   *  `rate` mirrors the player's speed control so a loop auditioned at half
   *  speed still sounds at half speed. */
  play: (id: string, startSec: number, endSec: number, opts?: PlayOpts) => void;
  /** Move the seam of a loop that is already sounding, without restarting it.
   *  `loopStart` / `loopEnd` are live-settable on a playing source node, so
   *  dragging the preview band's handles re-cuts the phrase under the audio
   *  instead of re-triggering it on every pointer frame — which would click
   *  and throw playback back to the head of the phrase each time. No-op when
   *  nothing is playing. */
  setBounds: (startSec: number, endSec: number) => void;
  /** Change the speed of a loop that is already sounding — the player's SPEED
   *  control applies live to the media element, so it has to here too. No-op
   *  when nothing is playing or the rate is unchanged. */
  setRate: (rate: number) => void;
  stop: () => void;
}

interface PlayOpts {
  snapZeroCross?: boolean;
  /** Playback speed multiplier, 1 = as recorded. */
  rate?: number;
}

export function useLoopPlayback({ audioBuffer, onPosition }: UseLoopPlaybackArgs): UseLoopPlaybackResult {
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const onPositionRef = useRef(onPosition);
  useEffect(() => { onPositionRef.current = onPosition; }, [onPosition]);
  // What's currently sounding, for the position clock: the context to read
  // the time off, when the source started, and the interval it wraps within.
  const spanRef = useRef<{ ctx: AudioContext; startedAt: number; from: number; length: number; rate: number } | null>(null);
  const rafRef = useRef<number | null>(null);

  // The same arithmetic the position clock's rAF does below, on demand — for
  // callers that need the instant they asked, not the last frame's. See the
  // `getTime` doc above.
  const getTime = useCallback((): number | null => {
    const span = spanRef.current;
    if (!span) return null;
    const elapsed = Math.max(0, span.ctx.currentTime - span.startedAt) * span.rate;
    return span.from + (elapsed % span.length);
  }, []);

  // Position clock. The AudioContext clock is the same one driving the
  // sample-accurate loop, so the cursor can't drift away from what is heard —
  // a JS timer accumulating its own elapsed time would. One update per frame
  // matches the cadence the main player already publishes at.
  const stopClock = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    const wasPlaying = spanRef.current !== null;
    spanRef.current = null;
    // Only hand the playhead back if we had taken it — stop() also runs on
    // mount and on every song switch, where the caller owns it already.
    if (wasPlaying) onPositionRef.current?.(null);
  }, []);

  const startClock = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    const tick = () => {
      const span = spanRef.current;
      if (!span) { rafRef.current = null; return; }
      const elapsed = Math.max(0, span.ctx.currentTime - span.startedAt) * span.rate;
      onPositionRef.current?.(span.from + (elapsed % span.length));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  // Lazily construct the AudioContext on first play so we don't hold an
  // active audio device for users who never trigger a loop.
  //
  // We pin the context's sample rate to the AudioBuffer's own rate. WaveSurfer
  // decodes at the file's native rate (commonly 44.1 kHz); a default context
  // runs at the hardware rate (commonly 48 kHz). Playing the buffer through a
  // mismatched-rate context forces an in-graph resample — often cheap linear
  // interpolation — which dulls the audio and is audibly lower quality than
  // the main WaveSurfer player. Matching rates removes that resample so the
  // loop preview sounds identical to the original player. If the rate changes
  // (e.g. a different song), we close and rebuild the context.
  const ensureCtx = useCallback((sampleRate: number): AudioContext | null => {
    const existing = ctxRef.current;
    if (existing && existing.sampleRate === sampleRate) return existing;
    if (existing) { try { void existing.close(); } catch { /* already closed */ } }
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctxRef.current = new Ctor({ sampleRate });
    } catch {
      // Some browsers reject an explicit sampleRate they can't honor; fall
      // back to a default context rather than failing to play at all.
      ctxRef.current = new Ctor();
    }
    return ctxRef.current;
  }, []);

  const stop = useCallback(() => {
    const src = sourceRef.current;
    if (src) {
      try { src.stop(); } catch { /* already stopped */ }
      try { src.disconnect(); } catch { /* not connected */ }
    }
    sourceRef.current = null;
    stopClock();
    setIsPlaying(false);
    setPlayingId(null);
  }, [stopClock]);

  // Tear down on unmount + when the audio buffer changes (e.g. song switch).
  useEffect(() => () => stop(), [stop]);
  useEffect(() => { stop(); }, [audioBuffer, stop]);

  // stop() silences the source but leaves the context open, and an
  // AudioContext is not memory the collector can reclaim on its own: it holds
  // an output thread on the audio hardware for as long as it lives, and Chrome
  // refuses to construct more than a handful per document. Leaving one behind
  // per mount of the page that owns this hook meant a session that navigated
  // away and back a few times could no longer open a context at all, and loop
  // previews went silent for the rest of the session. Closing at unmount is
  // also what releases the AudioBuffer the last source still referenced.
  useEffect(() => () => {
    const ctx = ctxRef.current;
    ctxRef.current = null;
    spanRef.current = null;
    if (ctx) { try { void ctx.close().catch(() => {}); } catch { /* already closed */ } }
  }, []);

  const play = useCallback((
    id: string,
    startSec: number,
    endSec: number,
    opts: PlayOpts = {},
  ) => {
    if (!audioBuffer) return;
    const ctx = ensureCtx(audioBuffer.sampleRate);
    if (!ctx) return;
    // Resume in case the context was suspended by a prior interaction policy.
    if (ctx.state === 'suspended') { void ctx.resume(); }

    const rate = opts.rate && opts.rate > 0 ? opts.rate : 1;
    const { s, e } = resolveBounds(audioBuffer, startSec, endSec, opts.snapZeroCross !== false);

    // Stop any running loop before starting a new one.
    stop();

    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.loop = true;
    src.loopStart = s;
    src.loopEnd = e;
    src.playbackRate.value = rate;
    src.connect(ctx.destination);
    src.onended = () => {
      // Native onended fires when stop() is called or the audio device
      // detaches. We only clear our refs if this is still the active source
      // (a new play() may have replaced it).
      if (sourceRef.current === src) {
        sourceRef.current = null;
        stopClock();
        setIsPlaying(false);
        setPlayingId(null);
      }
    };
    sourceRef.current = src;
    src.start(0, s);
    // start(0) means "now" on the context clock, so `now` is the zero point
    // the cursor counts from.
    spanRef.current = { ctx, startedAt: ctx.currentTime, from: s, length: e - s, rate };
    onPositionRef.current?.(s);
    startClock();
    setIsPlaying(true);
    setPlayingId(id);
  }, [audioBuffer, ensureCtx, stop, startClock, stopClock]);

  const setBounds = useCallback((startSec: number, endSec: number) => {
    const src = sourceRef.current;
    const span = spanRef.current;
    if (!src || !span || !audioBuffer) return;
    const { s, e } = resolveBounds(audioBuffer, startSec, endSec, true);
    src.loopStart = s;
    src.loopEnd = e;
    // Re-anchor the position clock on the new interval. The source keeps
    // playing from wherever it is and wraps at the new seam, so hold the
    // position it reports right now if that still falls inside the loop, and
    // otherwise count from the head — which is where it is about to wrap to.
    const cur = getTime();
    const pos = cur !== null && cur >= s && cur < e ? cur : s;
    spanRef.current = {
      ...span,
      startedAt: span.ctx.currentTime - (pos - s) / span.rate,
      from: s,
      length: e - s,
    };
  }, [audioBuffer, getTime]);

  const setRate = useCallback((rate: number) => {
    const src = sourceRef.current;
    const span = spanRef.current;
    if (!src || !span || !(rate > 0) || rate === span.rate) return;
    // Re-anchor before the rate changes: `startedAt` is only meaningful
    // together with the rate the clock has been counting at.
    const cur = getTime() ?? span.from;
    src.playbackRate.value = rate;
    spanRef.current = { ...span, rate, startedAt: span.ctx.currentTime - (cur - span.from) / rate };
  }, [getTime]);

  return { isPlaying, playingId, getTime, play, setBounds, setRate, stop };
}

/** Clamp a requested interval to the buffer, optionally pulling each edge to
 *  the nearest zero crossing. Shared by `play` and `setBounds` so a loop
 *  re-cut mid-flight lands on the same boundaries it would have if started
 *  there. */
function resolveBounds(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number,
  snapZeroCross: boolean,
): { s: number; e: number } {
  let s = Math.max(0, Math.min(buffer.duration, startSec));
  let e = Math.max(s + 0.01, Math.min(buffer.duration, endSec));
  if (snapZeroCross) {
    s = snapToZeroCrossing(buffer, s);
    e = snapToZeroCrossing(buffer, e);
    if (e <= s) e = Math.min(buffer.duration, s + 0.05);
  }
  return { s, e };
}

/** Find the nearest sample where the waveform crosses zero, within
 *  ±ZERO_CROSS_SEARCH_MS of `timeSec`. Falls back to `timeSec` unchanged
 *  if nothing is found in the window. Operates on channel 0 only — for
 *  stereo material a mismatch between channels is rare enough to ignore. */
export function snapToZeroCrossing(buffer: AudioBuffer, timeSec: number): number {
  const sr = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const targetSample = Math.round(timeSec * sr);
  const windowSamples = Math.round((ZERO_CROSS_SEARCH_MS / 1000) * sr);
  const lo = Math.max(1, targetSample - windowSamples);
  const hi = Math.min(data.length - 1, targetSample + windowSamples);

  let bestDelta = Infinity;
  let bestSample = -1;
  for (let i = lo; i <= hi; i++) {
    const a = data[i - 1];
    const b = data[i];
    // Sign change detected — interpolate linearly to find the sub-sample
    // crossing for slightly better accuracy. (Sample-accurate is enough,
    // but linear interp is cheap and reduces residual click further.)
    if ((a <= 0 && b > 0) || (a >= 0 && b < 0)) {
      const t = a / (a - b);
      const crossSample = (i - 1) + t;
      const delta = Math.abs(crossSample - targetSample);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestSample = crossSample;
      }
    }
  }
  return bestSample >= 0 ? bestSample / sr : timeSec;
}
