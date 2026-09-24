// HPSS percussive-span detector — talks to the Python percussive_server
// (proxied at /api/percussive). SPAN-family. Experimental: gated by
// `experimentalSpanFamily`.

import { createDetectionClient } from './detectionClient';

export interface PercussiveSpanResult {
  start: number;
  end: number;
  label: string;
  confidence: number;
}

export interface PercussiveDetectionResult {
  slug: string;
  audio_file: string;
  algorithm: string;
  duration: number;
  spans: PercussiveSpanResult[];
  ok: boolean;
  error?: string | null;
  ms: number;
  computed_at: string;
}

export interface PercussiveAlgorithmInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
}

const client = createDetectionClient<PercussiveAlgorithmInfo, PercussiveDetectionResult>('percussive', 'spans');

export const listPercussiveAlgorithms = client.listAlgorithms;
export const initializePercussiveAlgorithm = client.initializeAlgorithm;
