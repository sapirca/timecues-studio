// PATTERN-family detection — talks to the Python pattern server (proxied at
// /api/pattern). LoCoMotif uses numba JIT so the first call after server
// boot pays a ~15 s warm-up cost; subsequent calls are fast.
// Experimental: gated by `experimentalPatternFamily`.

import { createDetectionClient } from './detectionClient';

export interface PatternItemResult {
  start: number;
  end: number;
  label: string;
  motif_id: number;
  occurrence_index: number;
  occurrence_count: number;
  confidence: number;
}

export interface PatternDetectionResult {
  slug: string;
  audio_file: string;
  algorithm: string;
  duration: number;
  patterns: PatternItemResult[];
  ok: boolean;
  error?: string | null;
  ms: number;
  computed_at: string;
}

export interface PatternAlgorithmInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
}

const client = createDetectionClient<PatternAlgorithmInfo, PatternDetectionResult>('pattern', 'patterns');

export const listPatternAlgorithms = client.listAlgorithms;
export const loadCachedPattern = client.loadCached;
export const runPatternDetection = client.runDetection;
export const initializePatternAlgorithm = client.initializeAlgorithm;
