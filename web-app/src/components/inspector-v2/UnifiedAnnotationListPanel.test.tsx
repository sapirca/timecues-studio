/**
 * Auditioning a tiled item from the Annotate list. A riff instance stores ONE
 * cycle in `[start, end]` and tiles it `repeatCount` times, so playing its row
 * has to run through every repeat — stopping at the cycle end plays a quarter
 * of what the user sees on the canvas.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UnifiedAnnotationListPanel } from './UnifiedAnnotationListPanel';
import type { AnnotationLayersDocument } from '../../types/annotationLayer';

function docWithRiff(over: { repeatCount: number }): AnnotationLayersDocument {
  return {
    song: 'song',
    annotated_at: '2026-01-01T00:00:00.000Z',
    layers: [{
      id: 'L1',
      name: 'Riff Patterns 1',
      type: 'riff-patterns',
      visible: true,
      color: '#f0f',
      snap: 'off',
      source: 'user',
      nodes: [],
      combos: [],
      items: [{
        id: 'p1',
        start: 0.4,
        end: 4.1,
        label: 'kick',
        repeatCount: over.repeatCount,
        sequence: [],
      }],
    }],
  };
}

function renderPanel(doc: AnnotationLayersDocument, onSeekAndPlay: (t: number, stop?: number) => void) {
  render(
    <UnifiedAnnotationListPanel
      cueLayersDoc={doc}
      autoGuessAnnotation={null}
      activeAnnotationType="riff-patterns"
      onSeekAndPlay={onSeekAndPlay}
      experimentalLoopsAndPatterns
      experimentalLyricsFamily={false}
    />,
  );
}

describe('riff instance row audition', () => {
  it('plays every repeat, not just the cycle the row shows', () => {
    const onSeekAndPlay = vi.fn();
    renderPanel(docWithRiff({ repeatCount: 4 }), onSeekAndPlay);

    fireEvent.click(screen.getByText('kick'));

    // 0.4 + 4 × (4.1 − 0.4) = 15.2, not the cycle end 4.1.
    expect(onSeekAndPlay).toHaveBeenCalledTimes(1);
    const [start, stop] = onSeekAndPlay.mock.calls[0];
    expect(start).toBeCloseTo(0.4, 6);
    expect(stop).toBeCloseTo(15.2, 6);
  });

  it('stops at the cycle end when the instance does not repeat', () => {
    const onSeekAndPlay = vi.fn();
    renderPanel(docWithRiff({ repeatCount: 1 }), onSeekAndPlay);

    fireEvent.click(screen.getByText('kick'));

    const [start, stop] = onSeekAndPlay.mock.calls[0];
    expect(start).toBeCloseTo(0.4, 6);
    expect(stop).toBeCloseTo(4.1, 6);
  });

  it('marks a repeating row with its repeat count', () => {
    renderPanel(docWithRiff({ repeatCount: 4 }), () => {});
    expect(screen.getByText('×4')).toBeTruthy();
  });
});
