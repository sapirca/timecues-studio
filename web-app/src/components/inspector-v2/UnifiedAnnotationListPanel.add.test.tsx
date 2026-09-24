/**
 * The per-lane "+ ADD" button in a layer card's header. What Add *means*
 * depends on the lane it lands in — the energies lane answers with the ⚡
 * Energy popover rather than dropping a blank span — so the button has to
 * hand its caller both the lane it was pressed on and the point it was
 * pressed at, and take its tooltip from the lane too.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UnifiedAnnotationListPanel } from './UnifiedAnnotationListPanel';
import type { AnnotationLayersDocument } from '../../types/annotationLayer';

const doc: AnnotationLayersDocument = {
  song: 'song',
  annotated_at: '2026-01-01T00:00:00.000Z',
  layers: [
    {
      id: 'S1', name: 'Spans 1', type: 'spans', visible: true, color: '#0ff',
      snap: 'off', source: 'user', items: [],
    },
    {
      id: 'S2', name: 'energies', type: 'spans', visible: true, color: '#09f',
      snap: 'off', source: 'user', items: [],
    },
  ],
};

function renderPanel(addAtPlayhead: {
  label: string | ((layerId: string) => string);
  onAdd: (layerId: string, anchor: { x: number; y: number }) => void;
}) {
  render(
    <UnifiedAnnotationListPanel
      cueLayersDoc={doc}
      autoGuessAnnotation={null}
      activeAnnotationType="spans"
      onSeekAndPlay={() => {}}
      experimentalLoopsAndPatterns
      experimentalLyricsFamily={false}
      addAtPlayhead={addAtPlayhead}
    />,
  );
}

/** The Add button of the card whose header carries `layerName`. */
function addButtonFor(layerName: string): HTMLElement {
  const match = screen.getAllByTitle(/→ /).find((el) => el.getAttribute('title')?.endsWith(`→ ${layerName}`));
  if (!match) throw new Error(`no Add button for lane ${layerName}`);
  return match;
}

describe('per-lane Add', () => {
  it('reports which lane was pressed and where', () => {
    const onAdd = vi.fn();
    renderPanel({ label: '+ Add span @ 0:30.0', onAdd });

    fireEvent.click(addButtonFor('energies'), { clientX: 120, clientY: 340 });

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0][0]).toBe('S2');
    expect(onAdd.mock.calls[0][1]).toEqual({ x: 120, y: 340 });
  });

  it('takes its label from the lane when the caller varies it', () => {
    renderPanel({
      label: (layerId: string) => (layerId === 'S2' ? '⚡ Measure energy' : '+ Add span @ 0:30.0'),
      onAdd: () => {},
    });

    expect(addButtonFor('energies').getAttribute('title')).toBe('⚡ Measure energy → energies');
    expect(addButtonFor('Spans 1').getAttribute('title')).toBe('+ Add span @ 0:30.0 → Spans 1');
  });
});
