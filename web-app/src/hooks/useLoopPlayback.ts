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
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** ±20 ms search window for zero-crossing snap. Larger gives better
 *  suppression for low-frequency content; smaller is more time-accurate. */
const ZERO_CROSS_SEARCH_MS = 20;

interface UseLoopPlaybackArgs {
  audioBuffer: AudioBuffer | null;
}

interface UseLoopPlaybackResult {
  /** True while a loop is currently playing. */
  isPlaying: boolean;
  /** Which loop is playing, if any. Use this to mark the corresponding row
   *  in the editor / canvas. The caller assigns the id (often the LoopItem id). */
  playingId: string | null;
  /** Start looping [startSec, endSec], snapping each boundary to a nearby
   *  zero-crossing in the buffer. Re-callable: stops any running loop first.
   *  Pass an id (the LoopItem id) so the caller can tell which loop is live. */
  play: (id: string, startSec: number, endSec: number, opts?: { snapZeroCross?: boolean }) => void;
  stop: () => void;
}

export function useLoopPlayback({ audioBuffer }: UseLoopPlaybackArgs): UseLoopPlaybackResult {
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);

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
    setIsPlaying(false);
    setPlayingId(null);
  }, []);

  // Tear down on unmount + when the audio buffer changes (e.g. song switch).
  useEffect(() => () => stop(), [stop]);
  useEffect(() => { stop(); }, [audioBuffer, stop]);

  const play = useCallback((
    id: string,
    startSec: number,
    endSec: number,
    opts: { snapZeroCross?: boolean } = {},
  ) => {
    if (!audioBuffer) return;
    const ctx = ensureCtx(audioBuffer.sampleRate);
    if (!ctx) return;
    // Resume in case the context was suspended by a prior interaction policy.
    if (ctx.state === 'suspended') { void ctx.resume(); }

    let s = Math.max(0, Math.min(audioBuffer.duration, startSec));
    let e = Math.max(s + 0.01, Math.min(audioBuffer.duration, endSec));
    if (opts.snapZeroCross !== false) {
      s = snapToZeroCrossing(audioBuffer, s);
      e = snapToZeroCrossing(audioBuffer, e);
      if (e <= s) e = Math.min(audioBuffer.duration, s + 0.05);
    }

    // Stop any running loop before starting a new one.
    stop();

    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.loop = true;
    src.loopStart = s;
    src.loopEnd = e;
    src.connect(ctx.destination);
    src.onended = () => {
      // Native onended fires when stop() is called or the audio device
      // detaches. We only clear our refs if this is still the active source
      // (a new play() may have replaced it).
      if (sourceRef.current === src) {
        sourceRef.current = null;
        setIsPlaying(false);
        setPlayingId(null);
      }
    };
    sourceRef.current = src;
    src.start(0, s);
    setIsPlaying(true);
    setPlayingId(id);
  }, [audioBuffer, ensureCtx, stop]);

  return { isPlaying, playingId, play, stop };
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
