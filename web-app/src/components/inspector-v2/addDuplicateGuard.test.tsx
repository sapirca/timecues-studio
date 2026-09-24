/**
 * Adding twice at the same instant must not stack two items on the same spot.
 *
 * Driven through each panel's controller handle, which is the path the M
 * shortcut and the page-level "+ Add" both take. The transport is paused here
 * (`getSongTime` returns a fixed reading), which is exactly the case that
 * produced the invisible duplicates: the clock isn't moving, so a second press
 * resolves to the identical time.
 */

import { useRef, useState, useEffect } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { act, render, cleanup } from '@testing-library/react';
import { SettingsProvider } from '../../context/SettingsContext';
import { CueEditorPanel } from './CueEditorPanel';
import { SpanEditorPanel } from './SpanEditorPanel';
import type { AnnotationPanelController } from './shared/AnnotationPanelController';
import {
  emptyDocument,
  newCueLayer,
  newSpanLayer,
  type AnnotationLayer,
  type AnnotationLayersDocument,
  type CueItem,
  type SpanItem,
} from '../../types/annotationLayer';

afterEach(() => { cleanup(); localStorage.clear(); });

const PAUSED_AT = 12.345;

function docWith(layer: AnnotationLayer): AnnotationLayersDocument {
  return { ...emptyDocument('song'), layers: [layer] };
}

/** Mount a panel, hand back its controller and the live document. */
function mountPanel(
  initial: AnnotationLayersDocument,
  render_: (args: {
    doc: AnnotationLayersDocument;
    onDocChange: (next: AnnotationLayersDocument) => void;
    controllerRef: React.RefObject<AnnotationPanelController | null>;
    onDuplicateSkipped: (message: string) => void;
  }) => React.ReactNode,
) {
  const notices: string[] = [];
  const seen = { doc: initial };
  let controller: AnnotationPanelController | null = null;

  function Harness() {
    const [doc, setDoc] = useState(initial);
    const controllerRef = useRef<AnnotationPanelController | null>(null);
    useEffect(() => { controller = controllerRef.current; seen.doc = doc; }, [doc]);
    return <>{render_({
      doc,
      onDocChange: setDoc,
      controllerRef,
      onDuplicateSkipped: (m) => { notices.push(m); },
    })}</>;
  }

  render(<SettingsProvider><Harness /></SettingsProvider>);
  return {
    notices,
    add: () => act(() => { controller?.addAtPlayhead?.(); }),
    addAt: (t: number) => act(() => { controller?.addAtPlayhead?.(t); }),
    items: () => seen.doc.layers[0].items,
  };
}

describe('CueEditorPanel duplicate guard', () => {
  function mountCues() {
    const layer = newCueLayer('Cues 1', '#38bdf8');
    return mountPanel(docWith(layer), ({ doc, onDocChange, controllerRef, onDuplicateSkipped }) => (
      <CueEditorPanel
        ref={controllerRef}
        currentTime={PAUSED_AT}
        doc={doc}
        onDocChange={onDocChange}
        selectedLayerId={layer.id}
        getSongTime={() => PAUSED_AT}
        onDuplicateSkipped={onDuplicateSkipped}
      />
    ));
  }

  it('adds one cue for the first press', () => {
    const panel = mountCues();
    panel.add();
    expect(panel.items()).toHaveLength(1);
    expect(panel.notices).toHaveLength(0);
  });

  it('refuses a second cue on the identical instant and says why', () => {
    const panel = mountCues();
    panel.add();
    panel.add();
    expect(panel.items()).toHaveLength(1);
    expect(panel.notices).toHaveLength(1);
    expect(panel.notices[0]).toContain('0:12.345');
  });

  it('still adds a cue the annotator could hear as a second event', () => {
    const panel = mountCues();
    panel.add();
    panel.addAt(PAUSED_AT + 0.03);
    expect(panel.items()).toHaveLength(2);
    expect((panel.items() as CueItem[]).map((c) => c.time))
      .toEqual([PAUSED_AT, PAUSED_AT + 0.03]);
  });
});

describe('SpanEditorPanel duplicate guard', () => {
  function mountSpans() {
    const layer = newSpanLayer('Spans 1', '#a78bfa');
    return mountPanel(docWith(layer), ({ doc, onDocChange, controllerRef, onDuplicateSkipped }) => (
      <SpanEditorPanel
        ref={controllerRef}
        currentTime={PAUSED_AT}
        duration={200}
        doc={doc}
        onDocChange={onDocChange}
        grid={null}
        selectedLayerId={layer.id}
        getSongTime={() => PAUSED_AT}
        onDuplicateSkipped={onDuplicateSkipped}
      />
    ));
  }

  it('refuses a second span with the identical edges', () => {
    const panel = mountSpans();
    panel.add();
    expect(panel.items()).toHaveLength(1);
    panel.add();
    expect(panel.items()).toHaveLength(1);
    expect(panel.notices).toHaveLength(1);
  });

  it('adds a span that starts elsewhere', () => {
    const panel = mountSpans();
    panel.add();
    panel.addAt(PAUSED_AT + 1);
    expect(panel.items()).toHaveLength(2);
    expect((panel.items() as SpanItem[])[1].start).toBeCloseTo(PAUSED_AT + 1, 6);
  });
});

