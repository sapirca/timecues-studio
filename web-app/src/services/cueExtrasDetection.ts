// CUE-family extras (key / autochord / onsets) — talks to the Python
// cue_extras_server (proxied at /api/cue-extras). Experimental: gated by
// `experimentalCueExtras`.

import { createDetectionClient } from './detectionClient';

export interface CueExtrasCue {
  time: number;
  label: string;
  confidence: number | null;
  /** How hard this drum was struck, 1-127, against the hardest hit of the
   *  SAME drum in the track — so a full-force hi-hat is 127 even though it is
   *  far quieter than any kick. Set only by `drum-transients`. */
  velocity?: number;
  /** The hit's actual level against the loudest hit anywhere in the track, in
   *  dB (always <= 0). Unlike `velocity` this IS comparable across
   *  instruments. Set only by `drum-transients`. */
  levelDb?: number;
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
