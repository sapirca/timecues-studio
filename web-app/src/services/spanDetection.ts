// SPAN-family detection — talks to the Python span server (proxied at /api/span).
//
// Experimental: gated by the `experimentalSpanFamily` user setting and by the
// `experimental-models` docker compose profile being up. When either is off,
// the calls below return null instead of throwing, so consumers can degrade
// quietly without breaking the page.
//
// Server start (docker):
//   docker compose --profile experimental-models up --build span
// Server start (manual, requires torch + torchaudio + librosa locally):
//   python tools/python/span_server.py

import { createDetectionClient } from './detectionClient';

export interface SpanItemResult {
  /** Start time of the span in seconds. */
  start: number;
  /** End time of the span in seconds. */
  end: number;
  /** Coarse label, e.g. "voice", "instrumental", or an instrument family name. */
  label: string;
  /** Optional 0..1 confidence. Null when the detector doesn't expose one. */
  confidence: number | null;
}

export interface SpanDetectionResult {
  slug: string;
  audio_file: string;
  /** Detector id, e.g. "silero-vad", "jdcnet-voicing". */
  algorithm: string;
  duration: number;
  spans: SpanItemResult[];
  ok: boolean;
  error?: string | null;
  ms: number;
  computed_at: string;
}

export interface SpanAlgorithmInfo {
  id: string;
  name: string;
  description: string;
  /** False when the underlying dependency / weights aren't installed. The UI
   *  should grey out the option in that case. */
  available: boolean;
}

const client = createDetectionClient<SpanAlgorithmInfo, SpanDetectionResult>('span', 'spans');

/** List the detectors the SPAN server is willing to run. Returns null if the
 *  server isn't reachable (which is the expected state when the experimental
 *  profile isn't running — don't treat it as an error). */
export const listSpanAlgorithms = client.listAlgorithms;

/** Read a cached SPAN detection. Returns null if no cache exists or the
 *  server is unreachable. */
export const loadCachedSpan = client.loadCached;

/** Warm a SPAN detector's weights without running detection. Drives the
 *  "Initialize models" experimental settings panel. Returns the server's
 *  `{ok, error?}` envelope so the UI can show why initialization failed
 *  (e.g. torch missing in the container). */
export const initializeSpanAlgorithm = client.initializeAlgorithm;

/** Run one SPAN-family detector on the song. `force=true` skips the cache. */
export const runSpanDetection = client.runDetection;
