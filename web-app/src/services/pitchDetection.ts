// basic-pitch polyphonic note transcription — talks to the Python pitch
// server (proxied at /api/pitch). CUE-family. Experimental: gated by
// `experimentalCueExtras`.

import { createDetectionClient } from './detectionClient';

export interface PitchNoteResult {
  time: number;
  end: number;
  midi: number;
  pitch: string;
  amplitude: number;
}

export interface PitchDetectionResult {
  slug: string;
  audio_file: string;
  algorithm: string;
  duration: number;
  notes: PitchNoteResult[];
  ok: boolean;
  error?: string | null;
  ms: number;
  computed_at: string;
}

export interface PitchAlgorithmInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
}

const client = createDetectionClient<PitchAlgorithmInfo, PitchDetectionResult>('pitch', 'notes');

export const listPitchAlgorithms = client.listAlgorithms;
export const loadCachedPitch = client.loadCached;
export const initializePitchAlgorithm = client.initializeAlgorithm;
