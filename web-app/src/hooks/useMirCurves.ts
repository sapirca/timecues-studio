import { useEffect, useState } from 'react';
import { computeMIRFeatures } from '../services/mirAnalysis';
import { computeFullRateBands } from '../utils/fullRateBands';
import type { MirCurves } from '../components/inspector-v2/SharedVizPanel';

type MirFeatures = Awaited<ReturnType<typeof computeMIRFeatures>>;

/** The signal lanes' curves, from one pass of the client-side MIR analysis. */
export function mirFeaturesToCurves(mir: MirFeatures): MirCurves {
  return {
    energy:   Array.from(mir.energy),
    spectral: Array.from(mir.centroid),
    novelty:  Array.from(mir.novelty),
    onsets:   Array.from(mir.onsets),
    flux:     Array.from(mir.flux),
    rms:      Array.from(mir.rms),
    bassHits: Array.from(mir.bassHits),
    bandwidth: Array.from(mir.bandwidth),
    bandLevels: mir.bandLevels,
    nBusyBands: mir.nBusyBands,
    lowBand:  Array.from(mir.lowBand),
    midBand:  Array.from(mir.midBand),
    highBand: Array.from(mir.highBand),
    frameDuration: mir.hopSize / mir.sampleRate,
    mfcc: mir.mfcc,
    nMfcc: mir.nMfcc,
    chroma: mir.chroma,
    nChroma: mir.nChroma,
    tempogram: mir.tempogram,
    nTempo: mir.nTempo,
    tempogramFrameCount: mir.tempogramFrameCount,
    tempoBpm: mir.tempoBpm,
    ssm: mir.ssm,
    ssmFrameCount: mir.ssmFrameCount,
    frameCount: mir.frameCount,
    hopSize: mir.hopSize,
    fftSize: mir.fftSize,
    sampleRate: mir.sampleRate,
  };
}

/** The signal lanes' curves for the decoded song in `audioBuffer`, then its EQ
 *  bands re-measured at full quality from `url` — the buffer is WaveSurfer's
 *  8 kHz decode, which cannot hold anything over 4 kHz (see
 *  utils/fullRateBands.ts). `computing` is true from the moment a song is
 *  selected (`url` set) until its curves land, so a lane can say "pending"
 *  rather than "absent" while the audio decodes. */
export function useMirCurves(audioBuffer: AudioBuffer | null, url: string | null): { curves: MirCurves | null; computing: boolean } {
  const [curves, setCurves] = useState<MirCurves | null>(null);
  const [computing, setComputing] = useState(() => !!audioBuffer || !!url);
  // Curves belong to the buffer they were computed from: a new one clears them.
  const [input, setInput] = useState({ audioBuffer, url });
  if (input.audioBuffer !== audioBuffer || input.url !== url) {
    setInput({ audioBuffer, url });
    setCurves(null);
    setComputing(!!audioBuffer || !!url);
  }
  useEffect(() => {
    if (!audioBuffer) return;
    let cancelled = false;
    const eqAbort = new AbortController();
    computeMIRFeatures(audioBuffer, () => {}).then((mir) => {
      if (cancelled) return;
      setCurves(mirFeaturesToCurves(mir));
      setComputing(false);
      if (!url) return;
      computeFullRateBands(url, eqAbort.signal).then((bands) => {
        if (cancelled) return;
        setCurves((c) => c && {
          ...c,
          lowBand:  Array.from(bands.low),
          midBand:  Array.from(bands.mid),
          highBand: Array.from(bands.high),
        });
      }).catch((err) => {
        if (cancelled) return;
        console.warn('[mir] full-quality EQ bands failed; keeping the 8 kHz ones', err);
      });
    }).catch((err) => {
      if (cancelled) return;
      console.error('[mir] computeMIRFeatures failed', err);
      setComputing(false);
    });
    return () => { cancelled = true; eqAbort.abort(); };
  }, [audioBuffer, url]);
  return { curves, computing };
}
