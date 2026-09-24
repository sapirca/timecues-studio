/**
 * Delete and Split, from the boundary card, actually change the annotation.
 *
 * The card closes before it deletes (so a close guard can cancel the whole
 * action), and the panel sorts its items on every close. Both of those write
 * the WHOLE document — and the page hands the panel its doc as a prop, which
 * only arrives a render later. So the sort-on-close, computed from the doc as
 * it was before the click, wrote the deleted section straight back: the card
 * vanished, the boundary stayed. Split lost the same race in the other order
 * (split, then close sorted the pre-split doc back over it).
 *
 * These tests feed the panel back its own writes the way the page does — one
 * render LATER — so two writes inside one click have to compose to pass.
 */

import { describe, it, expect, vi } from 'vitest';
import { createRef, type ReactElement } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SettingsProvider } from '../../context/SettingsContext';
import { BoundaryEditorPanel } from './BoundaryEditorPanel';
import type { AnnotationPanelController } from './shared/AnnotationPanelController';
import type { AnnotationLayer, AnnotationLayersDocument } from '../../types/annotationLayer';

const wrap = (el: ReactElement) => <SettingsProvider>{el}</SettingsProvider>;

function boundaryDoc(): AnnotationLayersDocument {
  return {
    song: 'song',
    annotated_at: '2026-01-01T00:00:00.000Z',
    layers: [{
      id: 'B1', name: 'Boundaries 1', type: 'boundaries', visible: true,
      color: '#f472b6', snap: 'beat',
      items: [
        { id: 'b0', time: 0,  type: 'intro',  label: 'Intro' },
        { id: 'b1', time: 10, type: 'verse',  label: 'Verse' },
        { id: 'b2', time: 20, type: 'chorus', label: 'Chorus' },
      ],
    } as unknown as AnnotationLayer],
  };
}

/** Mounts the panel against a doc the harness owns, applying every write the
 *  way the page does: into state, visible on the NEXT render. */
function mountPanel(currentTime: number) {
  const openEditorRef = createRef<((idx: number | null, anchor?: { x: number; y: number }) => void) | null>() as
    React.RefObject<((idx: number | null, anchor?: { x: number; y: number }) => void) | null>;
  let doc = boundaryDoc();
  const onDocChange = vi.fn((
    next: AnnotationLayersDocument | ((prev: AnnotationLayersDocument) => AnnotationLayersDocument),
  ) => {
    doc = typeof next === 'function' ? next(doc) : next;
  });
  const view = () => wrap(
    <BoundaryEditorPanel
      ref={createRef<AnnotationPanelController>()}
      songId="song" currentTime={currentTime} duration={30}
      songBpm={120} songBeatsPerBar={4} songGridOffset={0}
      doc={doc} onDocChange={onDocChange} docLoaded
      selectedLayerId="B1" openEditorRef={openEditorRef}
    />,
  );
  const { rerender } = render(view());
  return {
    openEditorRef,
    times: () => (doc.layers[0].items as { time: number }[]).map((i) => i.time),
    labels: () => (doc.layers[0].items as { label?: string }[]).map((i) => i.label),
    settle: () => rerender(view()),
  };
}

describe('the boundary card footer edits the annotation', () => {
  it('Delete removes the boundary — it does not come back on close', () => {
    const panel = mountPanel(15);
    panel.openEditorRef.current!(1);
    panel.settle();

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    panel.settle();

    expect(panel.times()).toEqual([0, 20]);
  });

  it('Split cuts the section at the playhead', () => {
    const panel = mountPanel(15);
    panel.openEditorRef.current!(1);
    panel.settle();

    fireEvent.click(screen.getByRole('button', { name: /^split$/i }));
    panel.settle();

    expect(panel.times()).toEqual([0, 10, 15, 20]);
  });
});
