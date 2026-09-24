// PANNs AudioSet-527 tagging — talks to the Python panns server (proxied at
// /api/panns). SPAN-family. Experimental: gated by `experimentalSpanFamily`.

import { createDetectionClient } from './detectionClient';

export interface PannsSpanResult {
  start: number;
  end: number;
  label: string;
  confidence: number;
}

export interface PannsDetectionResult {
  slug: string;
  audio_file: string;
  algorithm: string;
  duration: number;
  spans: PannsSpanResult[];
  ok: boolean;
  error?: string | null;
  ms: number;
  computed_at: string;
}

export interface PannsAlgorithmInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
}

const client = createDetectionClient<PannsAlgorithmInfo, PannsDetectionResult>('panns', 'spans');

export const listPannsAlgorithms = client.listAlgorithms;
export const initializePannsAlgorithm = client.initializeAlgorithm;
