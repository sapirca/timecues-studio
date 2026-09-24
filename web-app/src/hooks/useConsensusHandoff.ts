// Receiving half of the Auto-guess ↔ Auto Consensus parameter hand-off.
//
// A panel calls this with its own target; whenever a config is waiting — on
// mount, which is the normal case since the sender navigates to the receiver,
// or while already mounted — `apply` runs once with it and the slot empties.

import { useEffect, useRef } from 'react';
import {
  subscribeConsensusHandoff,
  takeConsensusConfig,
  type BoundaryConsensusConfig,
  type HandoffTarget,
} from '../state/consensusHandoff';

export function useConsensusHandoff(
  target: HandoffTarget,
  apply: (config: BoundaryConsensusConfig) => void,
): void {
  // Held in a ref so a caller passing an inline closure doesn't re-subscribe
  // (and re-consume) on every render.
  const applyRef = useRef(apply);
  useEffect(() => { applyRef.current = apply; });

  useEffect(() => {
    const drain = () => {
      const config = takeConsensusConfig(target);
      if (config) applyRef.current(config);
    };
    drain();
    return subscribeConsensusHandoff((t) => { if (t === target) drain(); });
  }, [target]);
}
