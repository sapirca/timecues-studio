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
import { familyHasCached } from '../services/experimentalAlgorithms';

/** Per-family booleans (the five UI groupings). */
export interface FamilyFlags {
  spanFamily: boolean;
  cueExtras: boolean;
  loopFamily: boolean;
  lyricsFamily: boolean;
  patternFamily: boolean;
}

export interface ExperimentalAvailability extends FamilyFlags {
  // The top-level flags mean VISIBLE: the family's UI surface should render
  // because its sidecar is reachable OR it has cached results on disk. This is
  // the gate the inspector uses to show/hide a family.
  //
  /** Per-family: is the SIDECAR reachable, i.e. can a result be (re-)RUN now?
   *  When false the surface is view-only: cached results render, re-run is
   *  disabled (the `experimental-models` stack is down). */
  serverUp: FamilyFlags;
  loading: boolean;
  refresh: () => void;
}

const FALSE_FLAGS: FamilyFlags = {
  spanFamily: false,
  cueExtras: false,
  loopFamily: false,
  lyricsFamily: false,
  patternFamily: false,
};

/** Probe each experimental family two ways:
 *  - `serverUp.*` — is any of the family's sidecars reachable (can RE-RUN)? The
 *    `list*Algorithms()` / `beatnetHealth()` services return null on a 503 /
 *    network error (the state when the `experimental-models` profile is down).
 *  - top-level `*` (VISIBLE) — serverUp OR cached results exist on disk
 *    (GET /api/<family>/cached, served in-process by Vite regardless of sidecar
 *    state). This keeps already-computed results viewable after the stack is
 *    torn down to reclaim disk; only re-running needs the sidecar back up. */
export function useExperimentalAvailability(): ExperimentalAvailability {
  const [state, setState] = useState<{ visible: FamilyFlags; serverUp: FamilyFlags }>(
    { visible: FALSE_FLAGS, serverUp: FALSE_FLAGS });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [
      span, panns, perc, beat, pitch, cueExtras, loop, lyrics, pattern,
      cSpan, cPanns, cPerc, cBeat, cPitch, cCue, cLoop, cLyrics, cPattern,
    ] = await Promise.all([
      listSpanAlgorithms(),
      listPannsAlgorithms(),
      listPercussiveAlgorithms(),
      beatnetHealth(),
      listPitchAlgorithms(),
      listCueExtrasAlgorithms(),
      listLoopAlgorithms(),
      listLyricsAlgorithms(),
      listPatternAlgorithms(),
      familyHasCached('span'),
      familyHasCached('panns'),
      familyHasCached('percussive'),
      familyHasCached('beatnet'),
      familyHasCached('pitch'),
      familyHasCached('cue-extras'),
      familyHasCached('loop'),
      familyHasCached('lyrics'),
      familyHasCached('pattern'),
    ]);
    const serverUp: FamilyFlags = {
      spanFamily: span !== null || panns !== null || perc !== null,
      cueExtras: beat !== null || pitch !== null || cueExtras !== null,
      loopFamily: loop !== null,
      lyricsFamily: lyrics !== null,
      patternFamily: pattern !== null,
    };
    const cached: FamilyFlags = {
      spanFamily: cSpan || cPanns || cPerc,
      cueExtras: cBeat || cPitch || cCue,
      loopFamily: cLoop,
      lyricsFamily: cLyrics,
      patternFamily: cPattern,
    };
    setState({
      serverUp,
      visible: {
        spanFamily: serverUp.spanFamily || cached.spanFamily,
        cueExtras: serverUp.cueExtras || cached.cueExtras,
        loopFamily: serverUp.loopFamily || cached.loopFamily,
        lyricsFamily: serverUp.lyricsFamily || cached.lyricsFamily,
        patternFamily: serverUp.patternFamily || cached.patternFamily,
      },
    });
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return { ...state.visible, serverUp: state.serverUp, loading, refresh: () => void refresh() };
}
