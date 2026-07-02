// Static fallback registry of experimental-detector algorithms.
//
// Each family's sidecar normally answers GET /api/<family>/algorithms with its
// live registry. When the experimental-models stack is brought DOWN to reclaim
// disk, that endpoint 503s — but the cached results are still served in-process
// (see serveExperimentalCache in vite.config.ts) and the UI must still be able
// to LABEL them. This is that label source: the stable algo id + display name
// per family, mirrored from each *_server.py ALGORITHMS registry.
//
// `available` is intentionally absent here — availability ("can re-run now") is
// a runtime signal from useExperimentalAvailability (the sidecar's reachability),
// not a static property. Consumers fall back to this list only for the algo
// id/name/description when the live list is null.

export interface ExperimentalAlgoInfo {
  id: string;
  name: string;
  description: string;
}

/** Keyed by URL family (the `<family>` in /api/<family>/...). */
export const EXPERIMENTAL_ALGOS: Record<string, ExperimentalAlgoInfo[]> = {
  span: [
    { id: 'silero-vad', name: 'Silero-VAD', description: 'Voice-activity detection — voicing spans.' },
    { id: 'jdcnet-voicing', name: 'JDCNet voicing', description: 'Melody/voicing contour (skeleton detector).' },
  ],
  panns: [
    { id: 'panns-cnn14', name: 'PANNs CNN14', description: 'AudioSet-527 multi-label tag spans.' },
  ],
  percussive: [
    { id: 'hpss-percussive', name: 'HPSS percussive', description: 'Percussive-activity spans (HPSS).' },
  ],
  beatnet: [
    { id: 'beatnet', name: 'BeatNet', description: 'Beats, downbeats and meter.' },
  ],
  pitch: [
    { id: 'basic-pitch', name: 'basic-pitch', description: 'Polyphonic note transcription.' },
  ],
  'cue-extras': [
    { id: 'librosa-key', name: 'librosa key (KS templates)', description: 'Krumhansl-Schmuckler key estimation.' },
    { id: 'autochord-chords', name: 'autochord (chord recognition)', description: 'Chroma-template chord recognition.' },
    { id: 'librosa-onsets', name: 'librosa onsets', description: 'Onset detection.' },
  ],
  lyrics: [
    { id: 'whisper-base', name: 'Whisper-base', description: 'Vocal transcription (Whisper base).' },
    { id: 'ctc-forced-aligner', name: 'CTC forced aligner', description: 'Force-aligns the reference lyrics (Lyrics text panel) against the audio with wav2vec2-base-960h.' },
  ],
  pattern: [
    { id: 'locomotif', name: 'LoCoMotif', description: 'Motif / repeated-pattern discovery.' },
  ],
};

/** Does any cached result exist for a family? (GET /api/<family>/cached is the
 *  in-process index served from disk regardless of sidecar state.) */
export async function familyHasCached(family: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/${family}/cached`);
    if (!res.ok) return false;
    const data = await res.json();
    return typeof data?.count === 'number' && data.count > 0;
  } catch {
    return false;
  }
}
