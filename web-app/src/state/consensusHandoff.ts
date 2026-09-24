// Hand-off of the boundary-consensus parameters between the two surfaces that
// cluster detector boundaries: the Auto-guess panel (Annotator Tool) and the
// Auto Consensus panel (Inspect → Consensus Inspect).
//
// Both run the same clustering (utils/boundaryClustering) behind the same
// controls (ConsensusClusterControls), but each owns its own copy of the four
// knobs, so tuning against the live F1 chips in Inspect never reached the
// auto-guess the annotator actually saves. This module carries one config
// across that gap.
//
// It is deliberately a one-shot courier, not shared live state: binding the
// two panels together would let a poke in Inspect silently rewrite the
// parameters recorded on a saved annotation. The user asks for the trip
// ("Use for Auto-guess" / "Tune in Consensus Inspect"), the target panel
// consumes the config once on arrival, and the slot empties again.

import type { AutoGuessCentroidMethod } from '../types/autoGuess';

/** The four knobs both surfaces expose, in the vocabulary they share. */
export interface BoundaryConsensusConfig {
  /** Cluster window τ in seconds — predictions closer than this merge. */
  clusterWindow: number;
  /** Minimum members (Auto-guess) / distinct algorithms (Consensus) per cluster. */
  minAgreement: number;
  centroid: AutoGuessCentroidMethod;
  /** Detector row ids feeding the clustering. */
  algoIds: string[];
}

/** Which panel a pending config is addressed to. */
export type HandoffTarget = 'autoGuess' | 'consensus';

const pending: Record<HandoffTarget, BoundaryConsensusConfig | null> = {
  autoGuess: null,
  consensus: null,
};

const listeners = new Set<(target: HandoffTarget) => void>();

/** Park a config for `target`. The next mount of that panel picks it up. */
export function sendConsensusConfig(target: HandoffTarget, config: BoundaryConsensusConfig): void {
  pending[target] = config;
  for (const l of listeners) l(target);
}

/** Take the pending config for `target`, emptying the slot. */
export function takeConsensusConfig(target: HandoffTarget): BoundaryConsensusConfig | null {
  const config = pending[target];
  pending[target] = null;
  return config;
}

export function subscribeConsensusHandoff(listener: (target: HandoffTarget) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
