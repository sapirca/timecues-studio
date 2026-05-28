// Client-side BPM estimation. Complements the server-side detectors
// (Python :8004 — librosa + madmom) by adding two fast, browser-only paths:
//
//   - One-shot (web-audio-beat-detector) — runs once on the decoded audio
//     buffer when a song is opened. Returns in ~100-300 ms for a 3-min
//     track, so its chip appears before the server detectors finish.
//   - Streaming (realtime-bpm-analyzer) — windowed live estimate from the
//     playing <audio> element. Used for the Dynamic mode preview readout.
//
// Both libraries are MIT-licensed and ship as plain ESM, so no extra
// bundler config is needed.

import { analyze } from 'web-audio-beat-detector';

export interface ClientBpmResult {
  /** Identifier the UI uses to label the chip — distinct from the server
   *  detectors so they don't collide on the same row. */
  source: 'client-wabd' | 'client-realtime';
  ok: boolean;
  bpm?: number;
  /** Wall-clock detection time in ms. */
  ms?: number;
  error?: string;
}

/** One-shot tempo estimation on a decoded `AudioBuffer`. Resolves with the
 *  detector's verdict. Never throws — failures are returned as `ok:false`
 *  so the chip-rendering code can show a graceful error state. */
export async function detectInitialBpm(buffer: AudioBuffer): Promise<ClientBpmResult> {
  const t0 = performance.now();
  try {
    const bpm = await analyze(buffer);
    return {
      source: 'client-wabd',
      ok: true,
      bpm: typeof bpm === 'number' ? bpm : Number(bpm),
      ms: Math.round(performance.now() - t0),
    };
  } catch (e) {
    return {
      source: 'client-wabd',
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      ms: Math.round(performance.now() - t0),
    };
  }
}

// ─── Streaming (windowed) ───────────────────────────────────────────────────
//
// `realtime-bpm-analyzer` exposes `createRealtimeBpmAnalyzer(ctx)` which
// returns a typed event emitter wrapping an AudioWorkletNode. Use
// `analyzer.node` for the audio graph connection and `analyzer.on(...)`
// for BPM events.

export interface StreamingBpmAnalyzer {
  /** Most recent best-guess BPM, or null until enough audio has been seen. */
  getCurrentBpm(): number | null;
  /** Unsubscribe and disconnect the analyzer. */
  stop(): void;
}

export interface StreamingBpmOptions {
  /** Called with the latest best-guess BPM every time the analyzer emits an
   *  update. Use this to drive a live readout. */
  onUpdate?: (bpm: number) => void;
}

/** Attach a streaming BPM analyzer to a source node. The caller owns the
 *  AudioContext, the source, and the lifecycle of the playing audio. */
export async function createStreamingBpmAnalyzer(
  ctx: AudioContext,
  source: AudioNode,
  options: StreamingBpmOptions = {},
): Promise<StreamingBpmAnalyzer> {
  const { createRealtimeBpmAnalyzer } = await import('realtime-bpm-analyzer');
  const analyzer = await createRealtimeBpmAnalyzer(ctx);
  let currentBpm: number | null = null;

  const handleBpm = (data: { bpm: ReadonlyArray<{ tempo: number; count: number }> }) => {
    const top = data.bpm[0];
    if (top && typeof top.tempo === 'number' && top.tempo > 0) {
      currentBpm = top.tempo;
      options.onUpdate?.(currentBpm);
    }
  };
  analyzer.on('bpm', handleBpm);
  analyzer.on('bpmStable', handleBpm);
  source.connect(analyzer.node);
  // The worklet node is a sink — no further connect is required for it to
  // receive samples. Output goes nowhere (we don't want to double-route
  // audio to speakers).

  return {
    getCurrentBpm() { return currentBpm; },
    stop() {
      try { analyzer.disconnect(); } catch { /* noop */ }
      try { source.disconnect(analyzer.node); } catch { /* noop */ }
    },
  };
}
