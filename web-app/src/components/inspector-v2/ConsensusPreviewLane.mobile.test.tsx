/**
 * The Consensus preview's row names on a phone: the same 20px vertical strip
 * the timeline rows use, five letters, full name in the tooltip.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../mobile/mobileMode', () => ({ getIsMobile: () => true }));

import { ConsensusPreviewLane } from './ConsensusPreviewLane';

describe('ConsensusPreviewLane on a phone', () => {
  it('writes the row names as short vertical tags', () => {
    render(
      <ConsensusPreviewLane
        duration={100}
        blocks={[{ time: 0, endTime: 50, type: 'hit' }]}
        clusters={[{ time: 10, agree: 9, detectors: [] }]}
        minAgreement={8}
        totalDetectors={14}
        clusterWindow={1}
        referenceSections={[]}
        referenceLabel="Boundaries 3"
        matchedRefTimes={new Set()}
        tolerance={3}
      />,
    );
    expect(screen.getByTitle('Agreement ≥8 of 14').textContent).toBe('Agree≥8/14');
    expect(screen.getByTitle('Consensus').textContent).toBe('Conse');
    expect(screen.getByTitle('Boundaries 3').textContent).toBe('Bound');
    expect(screen.getByTitle('Consensus').className).toMatch(/w-5/);
  });
});
