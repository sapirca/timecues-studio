// CUE-family extras (key / autochord / onsets) — talks to the Python
// cue_extras_server (proxied at /api/cue-extras). Experimental: gated by
// `experimentalCueExtras`.

import { createDetectionClient } from './detectionClient';

export interface CueExtrasCue {
  time: number;
  label: string;
  confidence: number | null;
}

export interface CueExtrasDetectionResult {
  slug: string;
  audio_file: string;
  algorithm: string;
  duration: number;
  cues: CueExtrasCue[];
  /** Only set when `algorithm === 'librosa-key'`. */
  key?: string | null;
  ok: boolean;
  error?: string | null;
  ms: number;
  computed_at: string;
}

export interface CueExtrasAlgorithmInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
}

const client = createDetectionClient<CueExtrasAlgorithmInfo, CueExtrasDetectionResult>('cue-extras', 'cues');

export const listCueExtrasAlgorithms = client.listAlgorithms;
export const loadCachedCueExtras = client.loadCached;
export const initializeCueExtrasAlgorithm = client.initializeAlgorithm;
