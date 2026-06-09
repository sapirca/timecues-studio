import { useCallback, useEffect, useState } from 'react';
import { listSpanAlgorithms } from '../services/spanDetection';
import { listPannsAlgorithms } from '../services/pannsDetection';
import { listPercussiveAlgorithms } from '../services/percussiveDetection';
import { beatnetHealth } from '../services/beatnetDetection';
import { listPitchAlgorithms } from '../services/pitchDetection';
import { listCueExtrasAlgorithms } from '../services/cueExtrasDetection';
import { listLoopAlgorithms } from '../services/loopDetection';
import { listLyricsAlgorithms } from '../services/lyricsDetection';
import { listPatternAlgorithms } from '../services/patternDetection';

export interface ExperimentalAvailability {
  /** SPAN family — span ∪ panns ∪ percussive sidecars reachable. */
  spanFamily: boolean;
  /** CUE extras — beatnet ∪ pitch ∪ cue-extras sidecars reachable. */
  cueExtras: boolean;
  /** LOOP family — loop sidecar reachable. */
  loopFamily: boolean;
  /** LYRICS family — lyrics sidecar reachable. */
  lyricsFamily: boolean;
  /** PATTERN family — pattern sidecar reachable. */
  patternFamily: boolean;
  loading: boolean;
  refresh: () => void;
}

const FALSE: Omit<ExperimentalAvailability, 'loading' | 'refresh'> = {
  spanFamily: false,
  cueExtras: false,
  loopFamily: false,
  lyricsFamily: false,
  patternFamily: false,
};

/** Probe whether each experimental detector family's sidecar(s) are part of the
 *  running image. A family counts as available when *any* of its servers is
 *  reachable — the `list*Algorithms()` / `beatnetHealth()` services all return
 *  null on a 503 / network error (the expected state when the
 *  `experimental-models` docker compose profile isn't up). Reachability — not
 *  `available:true` — is the gate: a freshly-started sidecar whose weights still
 *  need warming should stay usable via the Initialize-models panel. */
export function useExperimentalAvailability(): ExperimentalAvailability {
  const [state, setState] = useState(FALSE);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [span, panns, perc, beat, pitch, cueExtras, loop, lyrics, pattern] = await Promise.all([
      listSpanAlgorithms(),
      listPannsAlgorithms(),
      listPercussiveAlgorithms(),
      beatnetHealth(),
      listPitchAlgorithms(),
      listCueExtrasAlgorithms(),
      listLoopAlgorithms(),
      listLyricsAlgorithms(),
      listPatternAlgorithms(),
    ]);
    setState({
      spanFamily: span !== null || panns !== null || perc !== null,
      cueExtras: beat !== null || pitch !== null || cueExtras !== null,
      loopFamily: loop !== null,
      lyricsFamily: lyrics !== null,
      patternFamily: pattern !== null,
    });
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return { ...state, loading, refresh: () => void refresh() };
}
