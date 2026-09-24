/**
 * A mark placed from the keyboard lands on the grid the user is looking at.
 *
 * The editor panels used to snap their own add times with `snapToBeat`, which
 * knows exactly one unit: the whole beat. The GRID selector ("1/2 beat", a
 * bar), per-beat overrides and tempo segments all live in the page's
 * `snapToGridIfEnabled`, and only the canvas drags went through it — so the
 * same cue landed on a different line depending on whether it was placed with
 * M or dragged there. At 145 BPM that is a 207 ms disagreement, and two M
 * presses inside one beat produced one time twice, which the duplicate guard
 * then refuses: M reads as a dead key.
 *
 * These tests pin the wiring, not the arithmetic — `snapTimeToGrid` has its
 * own tests. Each panel must route its add through the injected snapper.
 */

import { describe, it, expect, vi } from 'vitest';
import { createRef, type ReactElement } from 'react';
import { render } from '@testing-library/react';
import { SettingsProvider } from '../../context/SettingsContext';
import { CueEditorPanel } from './CueEditorPanel';
import { SpanEditorPanel } from './SpanEditorPanel';
import { BoundaryEditorPanel } from './BoundaryEditorPanel';
import type { AnnotationPanelController } from './shared/AnnotationPanelController';
import type { AnnotationLayer, AnnotationLayersDocument } from '../../types/annotationLayer';

const BPM = 145;                 // beat = 0.41379 s
const BEAT = 60 / BPM;
const HALF = BEAT / 2;
const GRID = { bpm: BPM, beatsPerBar: 4, gridOffsetSec: 0 };

/** Stand-in for the page's `snapToGridIfEnabled` with GRID set to 1/2 beat. */
const halfBeatSnap = (t: number) => Math.round(t / HALF) * HALF;
/** …and with GRID set to `1/3 beat · triplet`, the unit that has no binary
 *  rung to be flattened onto. */
const THIRD = BEAT / 3;
const tripletSnap = (t: number) => Math.round(t / THIRD) * THIRD;

function docWith(type: AnnotationLayer['type']): AnnotationLayersDocument {
  return {
    song: 'song',
    annotated_at: '2026-01-01T00:00:00.000Z',
    layers: [{
      id: 'L1', name: 'Layer 1', type, visible: true, color: '#4ade80',
      snap: 'beat', items: [],
    } as unknown as AnnotationLayer],
  };
}

const wrap = (el: ReactElement) => <SettingsProvider>{el}</SettingsProvider>;

describe('panel adds snap on the selected grid unit', () => {
  it('a cue added at playhead lands on the 1/2-beat line, not the beat', () => {
    const ref = createRef<AnnotationPanelController>();
    const onDocChange = vi.fn();
    render(wrap(
      <CueEditorPanel
        ref={ref} currentTime={0} doc={docWith('cues')} onDocChange={onDocChange}
        selectedLayerId="L1" snapToGrid grid={GRID} snapTime={halfBeatSnap}
      />,
    ));

    // 1.5 beats in: the nearest whole beat is half a beat away, the nearest
    // half-beat line is exactly where we are.
    ref.current!.addAtPlayhead!(BEAT * 1.5);

    expect(onDocChange).toHaveBeenCalledTimes(1);
    const next = onDocChange.mock.calls[0][0] as AnnotationLayersDocument;
    const items = next.layers[0].items as { time: number }[];
    expect(items).toHaveLength(1);
    expect(items[0].time).toBeCloseTo(BEAT * 1.5, 6);
  });

  it('two cues a half-beat apart both survive — neither collapses onto one beat', () => {
    const ref = createRef<AnnotationPanelController>();
    let doc = docWith('cues');
    const onDocChange = vi.fn((next: AnnotationLayersDocument) => { doc = next; });
    const view = () => wrap(
      <CueEditorPanel
        ref={ref} currentTime={0} doc={doc} onDocChange={onDocChange}
        selectedLayerId="L1" snapToGrid grid={GRID} snapTime={halfBeatSnap}
      />,
    );
    const { rerender } = render(view());

    ref.current!.addAtPlayhead!(BEAT * 1.0 + 0.01);
    // Feed the panel the doc its own add produced, the way the page does —
    // otherwise the second add still reads the empty one.
    rerender(view());
    ref.current!.addAtPlayhead!(BEAT * 1.5 + 0.01);

    const times = (doc.layers[0].items as { time: number }[]).map((i) => i.time);
    expect(times).toHaveLength(2);
    expect(times[0]).toBeCloseTo(BEAT, 6);
    expect(times[1]).toBeCloseTo(BEAT * 1.5, 6);
  });

  it('falls back to whole beats when no snapper is injected', () => {
    const ref = createRef<AnnotationPanelController>();
    const onDocChange = vi.fn();
    render(wrap(
      <CueEditorPanel
        ref={ref} currentTime={0} doc={docWith('cues')} onDocChange={onDocChange}
        selectedLayerId="L1" snapToGrid grid={GRID}
      />,
    ));
    ref.current!.addAtPlayhead!(BEAT * 1.5);
    const items = (onDocChange.mock.calls[0][0] as AnnotationLayersDocument).layers[0].items as { time: number }[];
    expect(items[0].time).toBeCloseTo(BEAT * 2, 6); // 1.5 rounds up to 2
  });

  it('a span added at playhead starts on the 1/2-beat line', () => {
    const ref = createRef<AnnotationPanelController>();
    const onDocChange = vi.fn();
    render(wrap(
      <SpanEditorPanel
        ref={ref} currentTime={0} duration={60} doc={docWith('spans')}
        onDocChange={onDocChange} selectedLayerId="L1"
        snapToGrid grid={GRID} snapTime={halfBeatSnap}
      />,
    ));
    ref.current!.addAtPlayhead!(BEAT * 1.5);
    const items = (onDocChange.mock.calls[0][0] as AnnotationLayersDocument).layers[0].items as { start: number }[];
    expect(items[0].start).toBeCloseTo(BEAT * 1.5, 6);
  });

  it('a cue follows a triplet grid onto a third of a beat', () => {
    const ref = createRef<AnnotationPanelController>();
    const onDocChange = vi.fn();
    render(wrap(
      <CueEditorPanel
        ref={ref} currentTime={0} doc={docWith('cues')} onDocChange={onDocChange}
        selectedLayerId="L1" snapToGrid grid={GRID} snapTime={tripletSnap}
      />,
    ));
    // A third of a beat is not on any binary rung: flattening it onto 1/2 beat
    // (what the unit→division map used to do) would land it 34 ms away, on a
    // line the triplet grid does not draw.
    ref.current!.addAtPlayhead!(BEAT / 3 + 0.004);
    const items = (onDocChange.mock.calls[0][0] as AnnotationLayersDocument).layers[0].items as { time: number }[];
    expect(items[0].time).toBeCloseTo(BEAT / 3, 6);
  });
});

describe('a section marked at the playhead snaps too', () => {
  const boundaryDoc = (): AnnotationLayersDocument => ({
    song: 'song',
    annotated_at: '2026-01-01T00:00:00.000Z',
    layers: [{
      id: 'B1', name: 'Boundaries 1', type: 'boundaries', visible: true,
      color: '#f472b6', snap: 'beat',
      items: [{ id: 'b0', time: 0, type: 'intro', label: 'intro' }],
    } as unknown as AnnotationLayer],
  });

  /** The boundary panel places a mark read from the LIVE media clock, so
   *  nothing upstream has rounded it — this is the case that used to ignore
   *  Snap outright. */
  /** The boundary panel writes through updaters (see its `onDocChange` doc
   *  comment), so the page applies each one to the live doc — do the same
   *  here rather than reading the raw call argument. */
  function mountBoundaryPanel(snapTime?: (t: number) => number) {
    const ref = createRef<AnnotationPanelController>();
    let doc = boundaryDoc();
    const onDocChange = vi.fn((
      next: AnnotationLayersDocument | ((prev: AnnotationLayersDocument) => AnnotationLayersDocument),
    ) => { doc = typeof next === 'function' ? next(doc) : next; });
    render(wrap(
      <BoundaryEditorPanel
        ref={ref} songId="song" currentTime={0} duration={60}
        songBpm={BPM} songBeatsPerBar={4} songGridOffset={0}
        doc={doc} onDocChange={onDocChange} docLoaded
        selectedLayerId="B1" snapTime={snapTime}
      />,
    ));
    return {
      ref,
      onDocChange,
      times: () => (doc.layers[0].items as { time: number }[]).map((i) => i.time),
    };
  }

  it('lands on the grid line, not on the raw media-clock reading', () => {
    const panel = mountBoundaryPanel(halfBeatSnap);

    panel.ref.current!.addAtPlayhead!(BEAT * 1.5 + 0.037);

    expect(panel.onDocChange).toHaveBeenCalled();
    expect(panel.times()).toContain(Number((BEAT * 1.5).toFixed(3)));
  });

  it('places the raw time when no snapper is injected', () => {
    const panel = mountBoundaryPanel();
    panel.ref.current!.addAtPlayhead!(BEAT * 1.5 + 0.037);
    expect(panel.times()).toContain(Number((BEAT * 1.5 + 0.037).toFixed(3)));
  });
});
