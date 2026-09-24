import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  BoundarySegmentEditor, type BoundaryOnsetSource, type BoundaryTickSource,
} from './BoundarySegmentEditor';
import {
  boundarySegmentsFromHits, normalizeBoundarySegments,
  type RiffBoundarySegment,
} from '../../types/annotationLayer';

/** The editor is controlled; this wrapper feeds its own output back so a test
 *  can click several times and see the accumulated result, the way the node
 *  popup does. */
function Harness({
  initial, lengthBeats = 4, playheadBeat = null, tickSources, onTapAtBeat,
  onsetCurve, levelCurve, onsetSources, onOnsetRefChange, secPerBeat,
}: {
  initial: RiffBoundarySegment[];
  lengthBeats?: number;
  playheadBeat?: number | null;
  tickSources?: BoundaryTickSource[];
  onTapAtBeat?: (beat: number) => void;
  onsetCurve?: number[];
  levelCurve?: number[];
  onsetSources?: BoundaryOnsetSource[];
  onOnsetRefChange?: (id: string | null) => void;
  secPerBeat?: number;
}) {
  const [segments, setSegments] = useState(() => normalizeBoundarySegments(initial, lengthBeats));
  return (
    <BoundarySegmentEditor
      color="#f97316"
      segments={segments}
      lengthBeats={lengthBeats}
      playheadBeat={playheadBeat}
      onChange={setSegments}
      tickSources={tickSources}
      onTapAtBeat={onTapAtBeat}
      onsetCurve={onsetCurve}
      levelCurve={levelCurve}
      onsetSources={onsetSources}
      onOnsetRefChange={onOnsetRefChange}
      secPerBeat={secPerBeat}
    />
  );
}

/** Reads the numbered block list back as `start-end kind` strings. */
function blockList(): string[] {
  return screen.getAllByLabelText(/^Block \d+ start, in beats$/).map((startEl) => {
    const row = startEl.parentElement!;
    const [start, end] = within(row).getAllByRole('spinbutton') as HTMLInputElement[];
    const kind = within(row).getByTitle('Flip between tick and rest').textContent;
    return `${start.value}-${end.value} ${kind}`;
  });
}

/** A loudness curve over `lengthBeats`, loud for `hold` beats from each hit —
 *  the shape `sampleOnsetWindow` hands the editor, built by hand so a block's
 *  expected length can be read off the call. */
function level(lengthBeats: number, hits: readonly [number, number][], columns = 240): number[] {
  const out = new Array(columns).fill(0.02);
  for (const [start, hold] of hits) {
    const from = Math.round((start / lengthBeats) * columns);
    const to = Math.round(((start + hold) / lengthBeats) * columns);
    for (let c = from; c < to && c < columns; c += 1) out[c] = 1;
  }
  return out;
}

/** Index of the block row carrying the karaoke highlight, or -1. */
function highlightedRow(): number {
  return screen.getAllByLabelText(/^Block \d+ start, in beats$/)
    .findIndex((el) => el.parentElement!.className.includes('bg-white/[0.08]'));
}

describe('BoundarySegmentEditor', () => {
  it('lists the blocks with their beat edges and kinds', () => {
    render(<Harness initial={[{ start: 2, end: 2.5, kind: 'tick' }, { start: 2.5, end: 3, kind: 'tick' }]} />);
    expect(blockList()).toEqual(['0-2 Empty', '2-2.5 Tick', '2.5-3 Tick', '3-4 Empty']);
    expect(screen.getByText('2 ticks · 4 beats')).toBeTruthy();
  });

  it('highlights the block the playhead is inside — pure relative time', () => {
    const segs: RiffBoundarySegment[] = [{ start: 2, end: 2.5, kind: 'tick' }];
    const { rerender } = render(<Harness initial={segs} playheadBeat={0.5} />);
    expect(highlightedRow()).toBe(0);

    rerender(<Harness initial={segs} playheadBeat={2.2} />);
    expect(highlightedRow()).toBe(1);

    rerender(<Harness initial={segs} playheadBeat={3.9} />);
    expect(highlightedRow()).toBe(2);
  });

  it('drops the highlight entirely when nothing is sounding', () => {
    render(<Harness initial={[{ start: 2, end: 2.5, kind: 'tick' }]} playheadBeat={null} />);
    expect(highlightedRow()).toBe(-1);
  });

  it('draws the sweep line at the playhead’s fraction of the node', () => {
    const { container } = render(
      <Harness initial={[{ start: 2, end: 2.5, kind: 'tick' }]} playheadBeat={1} />,
    );
    const line = container.querySelector('span.z-20') as HTMLElement | null;
    expect(line).toBeTruthy();
    expect(line!.style.left).toBe('25%'); // 1 of 4 beats
  });

  it('flips a block between tick and rest from its toggle', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[{ start: 0, end: 2, kind: 'tick' }]} />);
    expect(blockList()).toEqual(['0-2 Tick', '2-4 Empty']);

    await user.click(screen.getAllByTitle('Flip between tick and rest')[0]);
    // Both blocks are now rests, so they merge into one.
    expect(blockList()).toEqual(['0-4 Empty']);
  });

  it('lays ticks down left to right on repeated "+ Block"', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[]} />);
    const add = screen.getByRole('button', { name: '+ Block' });
    await user.click(add);
    await user.click(add);
    expect(blockList()).toEqual(['0-0.5 Tick', '0.5-1 Tick', '1-4 Empty']);
  });

  it('keeps a typed fractional edge exactly, without snapping it to a grid', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[{ start: 1, end: 2, kind: 'tick' }]} />);
    const start = screen.getByLabelText('Block 2 start, in beats');
    await user.clear(start);
    await user.type(start, '0.37');
    // The field shows the draft, but nothing is committed yet — the block
    // still really ends at 1 — so the intermediate `0` never gets clamped and
    // rewritten under the cursor.
    expect(blockList()).toEqual(['0-1 Empty', '0.37-2 Tick', '2-4 Empty']);
    await user.tab();
    expect(blockList()).toEqual(['0-0.37 Empty', '0.37-2 Tick', '2-4 Empty']);
  });

  it('commits an edge on Enter, and abandons the draft on Escape', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[{ start: 1, end: 2, kind: 'tick' }]} />);
    const start = screen.getByLabelText('Block 2 start, in beats');

    await user.clear(start);
    await user.type(start, '0.5{Enter}');
    expect(blockList()).toEqual(['0-0.5 Empty', '0.5-2 Tick', '2-4 Empty']);

    await user.clear(start);
    await user.type(start, '1.75{Escape}');
    await user.tab();
    expect(blockList()).toEqual(['0-0.5 Empty', '0.5-2 Tick', '2-4 Empty']);
  });

  it('removes a block by handing its span to the neighbour', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[{ start: 1, end: 2, kind: 'tick' }, { start: 3, end: 4, kind: 'tick' }]} />);
    expect(blockList()).toHaveLength(4);
    await user.click(screen.getByLabelText('Remove block 2'));
    expect(blockList()).toEqual(['0-3 Empty', '3-4 Tick']);
  });

  it('labels a block and keeps the label through later edits', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[{ start: 1, end: 2, kind: 'tick' }]} />);
    await user.type(screen.getByLabelText('Block 2 label'), 'snare');
    expect((screen.getByLabelText('Block 2 label') as HTMLInputElement).value).toBe('snare');
  });

  it('offers the layer re-seed only when a source is wired up', async () => {
    const user = userEvent.setup();
    const apply = vi.fn();
    const sources: BoundaryTickSource[] = [
      { id: 'cues:a', name: 'Drum onsets', kind: 'cues', count: 7, apply },
    ];
    const { rerender } = render(<Harness initial={[]} tickSources={sources} />);
    await user.click(screen.getByRole('button', { name: /From layer/ }));
    await user.click(screen.getByTitle(/rebuild them from 7 ticks/));
    expect(apply).toHaveBeenCalledOnce();

    rerender(<Harness initial={[]} />);
    expect(screen.queryByRole('button', { name: /From layer/ })).toBeNull();
  });

  it('groups tick sources by kind and shows how many items each has in range', async () => {
    const user = userEvent.setup();
    const sources: BoundaryTickSource[] = [
      { id: 'cues:a', name: 'Drum onsets', kind: 'cues', count: 7, apply: vi.fn() },
      { id: 'lyrics:b', name: 'Vocals (whisper)', kind: 'lyrics', count: 3, apply: vi.fn() },
    ];
    render(<Harness initial={[]} tickSources={sources} />);
    await user.click(screen.getByRole('button', { name: /From layer/ }));
    expect(screen.getByText('Onsets / cues')).toBeTruthy();
    expect(screen.getByText('Lyrics')).toBeTruthy();
    expect(screen.getByText('Drum onsets').parentElement!.textContent).toContain('7');
    expect(screen.getByText('Vocals (whisper)').parentElement!.textContent).toContain('3');
  });

  it('routes a strip click to the tap session instead of flipping the block', () => {
    const onTapAtBeat = vi.fn();
    // jsdom lays nothing out, so the strip has to be given a width for the
    // click's x to mean a beat at all.
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 0, width: 400, right: 400, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    try {
      render(<Harness initial={[{ start: 1, end: 2, kind: 'tick' }]} onTapAtBeat={onTapAtBeat} />);
      // Halfway across a 4-beat node = beat 2, wherever the click landed
      // block-wise — and the blocks themselves stay exactly as they were.
      fireEvent.click(screen.getByTitle(/^1 – 2 beats · tick/), { clientX: 200 });
      expect(onTapAtBeat).toHaveBeenCalledWith(2);
      expect(blockList()).toEqual(['0-1 Empty', '1-2 Tick', '2-4 Empty']);
    } finally {
      rect.mockRestore();
    }
  });

  it('draws a span across the strip in one drag, without splitting by hand', () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 0, width: 400, right: 400, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    try {
      render(<Harness initial={[]} />);
      // 400px across a 4-beat node ⇒ 100px per beat. Press at beat 2, release
      // at beat 3.5 — the span the user means, in one gesture.
      const block = screen.getByTitle(/^0 – 4 beats · empty/);
      fireEvent.pointerDown(block, { clientX: 200, button: 0 });
      fireEvent.pointerMove(document, { clientX: 350 });
      fireEvent.pointerUp(document, { clientX: 350 });
      expect(blockList()).toEqual(['0-2 Empty', '2-3.5 Tick', '3.5-4 Empty']);
    } finally {
      rect.mockRestore();
    }
  });

  it('drags over a tick to clear it, and keeps a plain click a click', () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 0, width: 400, right: 400, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    try {
      render(<Harness initial={[{ start: 1, end: 3, kind: 'tick' }]} />);
      // Started on a tick ⇒ the swept range comes back as a rest, and the
      // parts of the tick either side survive.
      const tick = screen.getByTitle(/^1 – 3 beats · tick/);
      fireEvent.pointerDown(tick, { clientX: 150, button: 0 });
      fireEvent.pointerMove(document, { clientX: 250 });
      fireEvent.pointerUp(document, { clientX: 250 });
      expect(blockList()).toEqual([
        '0-1 Empty', '1-1.5 Tick', '1.5-2.5 Empty', '2.5-3 Tick', '3-4 Empty',
      ]);

      // A press that doesn't move is a click, and a click is an instant: it
      // drops a short tick where it landed instead of flipping a whole block.
      const rest = screen.getByTitle(/^1.5 – 2.5 beats · empty/);
      fireEvent.pointerDown(rest, { clientX: 200, button: 0 });
      fireEvent.pointerUp(document, { clientX: 200 });
      fireEvent.click(rest, { clientX: 200 });
      expect(blockList()).toEqual([
        '0-1 Empty', '1-1.5 Tick', '1.5-2 Empty', '2-2.5 Tick', '2.5-3 Tick', '3-4 Empty',
      ]);
    } finally {
      rect.mockRestore();
    }
  });

  it('never fills the whole lane from one click on a fresh node', () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 0, width: 400, right: 400, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    try {
      render(<Harness initial={[]} />);
      // The reported bug: one block covers the node, so the old click-to-flip
      // turned every beat into a single tick nobody drew.
      fireEvent.click(screen.getByTitle(/^0 – 4 beats · empty/), { clientX: 100 });
      expect(blockList()).toEqual(['0-1 Empty', '1-1.5 Tick', '1.5-4 Empty']);
      // Clicking that tick takes it away again.
      fireEvent.click(screen.getByTitle(/^1 – 1.5 beats · tick/), { clientX: 110 });
      expect(blockList()).toEqual(['0-4 Empty']);
    } finally {
      rect.mockRestore();
    }
  });

  it('renders onset-seeded blocks at their exact detected positions', () => {
    render(<Harness initial={boundarySegmentsFromHits([0.37, 1.62].map((beat) => ({ beat })), 4, { maxTickBeats: 0.5 })} />);
    expect(blockList()).toEqual([
      '0-0.37 Empty', '0.37-0.87 Tick', '0.87-1.62 Empty', '1.62-2.12 Tick', '2.12-4 Empty',
    ]);
  });

  it('offers Merge beside Replace only for a source that can merge', async () => {
    const user = userEvent.setup();
    const apply = vi.fn();
    const applyMerge = vi.fn();
    const sources: BoundaryTickSource[] = [
      { id: 'cues:a', name: 'Drum onsets', kind: 'cues', count: 7, apply, applyMerge },
      { id: 'lyrics:b', name: 'Vocals', kind: 'lyrics', count: 3, apply: vi.fn() },
    ];
    render(<Harness initial={[]} tickSources={sources} />);
    await user.click(screen.getByRole('button', { name: /From layer/ }));
    // One Merge button in the menu — the lyrics source didn't offer one.
    const merge = screen.getByTitle(/add whichever of the 7 ticks/);
    await user.click(merge);
    expect(applyMerge).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
  });

  it('reports how well the blocks line up with the chosen onsets', () => {
    // Two ticks 0.05 beat late against three onsets, at 0.5 s/beat ⇒ +25 ms.
    render(
      <Harness
        initial={[{ start: 1.05, end: 1.5, kind: 'tick' }, { start: 2.05, end: 2.5, kind: 'tick' }]}
        onsetSources={[{ id: 'audio', name: 'audio', beats: [1, 2, 3] }]}
        secPerBeat={0.5}
      />,
    );
    expect(screen.getByText(/2 \/ 2 on an onset/).textContent).toContain('median +25 ms');
    expect(screen.getByText(/1 onset unmarked/)).toBeTruthy();
  });

  it('falls back to beats when the node is not placed anywhere', () => {
    render(
      <Harness
        initial={[{ start: 1.05, end: 1.5, kind: 'tick' }]}
        onsetSources={[{ id: 'audio', name: 'audio', beats: [1] }]}
      />,
    );
    expect(screen.getByText(/median \+0\.05 beat/)).toBeTruthy();
  });

  it('snaps the near-miss ticks onto the onsets, leaving the rest alone', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={[{ start: 1.05, end: 1.5, kind: 'tick' }, { start: 2.5, end: 3, kind: 'tick' }]}
        onsetSources={[{ id: 'audio', name: 'audio', beats: [1] }]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Snap to onsets' }));
    expect(blockList()).toEqual(['0-1 Empty', '1-1.45 Tick', '1.45-2.5 Empty', '2.5-3 Tick', '3-4 Empty']);
  });

  it('marks every detected onset on a node that has no ticks yet', async () => {
    const user = userEvent.setup();
    render(
      <Harness initial={[]} onsetSources={[{ id: 'audio', name: 'audio', beats: [1, 2.5] }]} />,
    );
    // Snapping has nothing to move on an empty node, which is exactly when
    // the detector is most useful: take the blocks from it instead.
    expect((screen.getByRole('button', { name: 'Snap to onsets' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Mark 2 onsets' }));
    // One hairline per onset — the width picker's default. With no placement
    // there is no tempo to turn 10 ms into beats, so the fallback minimum
    // width is what lands.
    expect(blockList()).toEqual([
      '0-0.99 Empty', '0.99-1.01 Tick', '1.01-2.49 Empty', '2.49-2.51 Tick', '2.51-4 Empty',
    ]);
  });

  it('turns ±10 ms into beats through the node’s own tempo', async () => {
    const user = userEvent.setup();
    // 0.5 s/beat ⇒ 10 ms is 0.02 beat either side of the onset at beat 1.
    render(
      <Harness
        initial={[]}
        onsetSources={[{ id: 'audio', name: 'audio', beats: [1] }]}
        secPerBeat={0.5}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Mark 1 onset' }));
    expect(blockList()).toEqual(['0-0.98 Empty', '0.98-1.02 Tick', '1.02-4 Empty']);
  });

  it('keeps a marker wide enough to survive at an absurdly slow tempo', async () => {
    const user = userEvent.setup();
    // 3 s/beat is 20 bpm — a mistyped BPM, or a placement stretched far past
    // the node's length. 10 ms is 0.003 beat there, narrower than a block is
    // allowed to be, so without a floor the hit would be detected, drawn,
    // counted in the readout and marked by nothing.
    render(
      <Harness
        initial={[]}
        onsetSources={[{ id: 'audio', name: 'audio', beats: [1] }]}
        secPerBeat={3}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Mark 1 onset' }));
    expect(blockList()).toEqual(['0-0.995 Empty', '0.995-1.005 Tick', '1.005-4 Empty']);
  });

  it('marks a peak with a hairline even where the hit rings on for beats', async () => {
    const user = userEvent.setup();
    // The measured-length path would draw this held hit as a half-beat block.
    // A marker says where it is and nothing else, which is what keeps a dense
    // passage from tiling solid.
    render(
      <Harness
        initial={[]}
        onsetSources={[{ id: 'audio', name: 'audio', beats: [2], levelCurve: level(4, [[2, 1.5]]) }]}
        secPerBeat={0.5}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Mark 1 onset' }));
    expect(blockList()).toEqual(['0-1.98 Empty', '1.98-2.02 Tick', '2.02-4 Empty']);
  });

  it('reports a node of markers as sitting on the onsets, 10 ms early', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={[]}
        onsetSources={[{ id: 'audio', name: 'audio', beats: [1, 2.5] }]}
        secPerBeat={0.5}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Mark 2 onsets' }));
    // A marker is centred on its peak, so it starts 10 ms before it — well
    // inside the 1/8-beat match window, and the readout says so rather than
    // rounding the half-width away.
    expect(screen.getByText(/2 \/ 2 on an onset/).textContent).toContain('median −10 ms');
    expect(screen.queryByRole('button', { name: /^(Mark|Add) / })).toBeNull();
  });

  it('adds only the onsets a node with blocks is not already marking', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={[{ start: 1, end: 1.5, kind: 'tick' }]}
        onsetSources={[{ id: 'audio', name: 'audio', beats: [1, 3] }]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Add 1 unmarked' }));
    // The hand-placed block keeps its own width; only the missed onset is new,
    // and it arrives as a marker like any other seeded block.
    expect(blockList()).toEqual([
      '0-1 Empty', '1-1.5 Tick', '1.5-2.99 Empty', '2.99-3.01 Tick', '3.01-4 Empty',
    ]);
  });

  it('gives each marked onset the length it actually rings for', async () => {
    const user = userEvent.setup();
    // A 4-beat node: a stab at beat 1 that is over in a quarter beat, and a
    // held hit at beat 2 that rings for one and a half. A flat width would
    // make both of them a beat long; the stab keeps its own measured 0.25 and
    // the held one stops at the half-beat window cap rather than drawing out
    // its whole sustain.
    render(
      <Harness
        initial={[]}
        onsetSources={[{ id: 'audio', name: 'audio', beats: [1, 2], levelCurve: level(4, [[1, 0.25], [2, 1.5]]) }]}
      />,
    );
    await user.selectOptions(screen.getByTitle(/^How wide a block seeded from the audio/), '0.5');
    await user.click(screen.getByRole('button', { name: 'Mark 2 onsets' }));
    expect(blockList()).toEqual([
      '0-1 Empty', '1-1.25 Tick', '1.25-2 Empty', '2-2.5 Tick', '2.5-4 Empty',
    ]);
  });

  it('lets the width picker set how wide a seeded block may get', async () => {
    const user = userEvent.setup();
    // The held hit at beat 2 rings for 1.5 beats, so the ceiling is what
    // decides its block — which is the knob, not the measurement.
    render(
      <Harness
        initial={[]}
        onsetSources={[{ id: 'audio', name: 'audio', beats: [2], levelCurve: level(4, [[2, 1.5]]) }]}
      />,
    );
    const width = screen.getByTitle(/^How wide a block seeded from the audio/);

    await user.selectOptions(width, '0.25');
    await user.click(screen.getByRole('button', { name: 'Mark 1 onset' }));
    expect(blockList()).toEqual(['0-2 Empty', '2-2.25 Tick', '2.25-4 Empty']);
  });

  it('leaves a hit that stops early alone, however wide the ceiling is', async () => {
    const user = userEvent.setup();
    // A quarter-beat stab under a 2-beat ceiling: the measurement still ends
    // it, so the picker is a ceiling and not a block length.
    render(
      <Harness
        initial={[]}
        onsetSources={[{ id: 'audio', name: 'audio', beats: [1], levelCurve: level(4, [[1, 0.25]]) }]}
      />,
    );
    await user.selectOptions(screen.getByTitle(/^How wide a block seeded from the audio/), '2');
    await user.click(screen.getByRole('button', { name: 'Mark 1 onset' }));
    expect(blockList()).toEqual(['0-1 Empty', '1-1.25 Tick', '1.25-4 Empty']);
  });

  it('falls back to a fixed block when there is no loudness to read', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[]} onsetSources={[{ id: 'audio', name: 'audio', beats: [1] }]} />);
    await user.selectOptions(screen.getByTitle(/^How wide a block seeded from the audio/), '0.5');
    await user.click(screen.getByRole('button', { name: 'Mark 1 onset' }));
    // No loudness to measure, so every block is the width picker's ceiling.
    expect(blockList()).toEqual(['0-1 Empty', '1-1.5 Tick', '1.5-4 Empty']);
  });

  it('keeps the measured length when adding onsets to a node that has blocks', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={[{ start: 0, end: 0.5, kind: 'tick' }]}
        onsetSources={[{ id: 'audio', name: 'audio', beats: [0, 2], levelCurve: level(4, [[0, 0.5], [2, 1.5]]) }]}
      />,
    );
    await user.selectOptions(screen.getByTitle(/^How wide a block seeded from the audio/), '0.5');
    await user.click(screen.getByRole('button', { name: 'Add 1 unmarked' }));
    // The held hit at beat 2 arrives measured and capped, not at the flat
    // merge width — and the hand-placed block at 0 is untouched.
    expect(blockList()).toEqual(['0-0.5 Tick', '0.5-2 Empty', '2-2.5 Tick', '2.5-4 Empty']);
  });

  it('offers nothing to take once every onset is already marked', () => {
    render(
      <Harness
        initial={[{ start: 1, end: 1.5, kind: 'tick' }]}
        onsetSources={[{ id: 'audio', name: 'audio', beats: [1] }]}
      />,
    );
    expect(screen.queryByRole('button', { name: /^(Mark|Add) / })).toBeNull();
  });

  it('cannot snap when nothing is close enough to snap to', () => {
    render(
      <Harness
        initial={[{ start: 0.5, end: 1, kind: 'tick' }]}
        onsetSources={[{ id: 'audio', name: 'audio', beats: [3] }]}
      />,
    );
    expect((screen.getByRole('button', { name: 'Snap to onsets' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('switches the comparison to another layer, and turns it off', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={[{ start: 1, end: 1.5, kind: 'tick' }]}
        onsetSources={[
          { id: 'audio', name: 'audio', beats: [2] },
          { id: 'cues:a', name: 'Drum onsets', beats: [1] },
        ]}
      />,
    );
    const picker = screen.getByRole('combobox', { name: /onsets/ });
    // Defaults to the first source: the audio, which this tick misses.
    expect(screen.getByText(/0 \/ 1 on an onset/)).toBeTruthy();
    await user.selectOptions(picker, 'cues:a');
    expect(screen.getByText(/1 \/ 1 on an onset/)).toBeTruthy();
    await user.selectOptions(picker, '__off');
    expect(screen.queryByText(/on an onset/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Snap to onsets' })).toBeTruthy();
  });

  it('names the chosen source to its owner, so a stem can be read on demand', async () => {
    const user = userEvent.setup();
    const onOnsetRefChange = vi.fn();
    render(
      <Harness
        initial={[{ start: 1, end: 1.5, kind: 'tick' }]}
        onsetSources={[
          { id: 'audio', name: 'audio', beats: [1] },
          { id: 'stem:drums', name: 'audio · drums', beats: [] },
        ]}
        onOnsetRefChange={onOnsetRefChange}
      />,
    );
    const picker = screen.getByRole('combobox', { name: /onsets/ });
    await user.selectOptions(picker, 'stem:drums');
    expect(onOnsetRefChange).toHaveBeenLastCalledWith('stem:drums');
    await user.selectOptions(picker, '__off');
    expect(onOnsetRefChange).toHaveBeenLastCalledWith(null);
  });

  it('waits for a source that is still loading instead of scoring it at zero', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={[{ start: 1, end: 1.5, kind: 'tick' }]}
        onsetSources={[
          { id: 'audio', name: 'audio', beats: [1] },
          { id: 'stem:drums', name: 'audio · drums', beats: [], status: 'loading' },
        ]}
      />,
    );
    await user.selectOptions(screen.getByRole('combobox', { name: /onsets/ }), 'stem:drums');
    expect(screen.getByText(/reading audio · drums/)).toBeTruthy();
    expect(screen.queryByText(/on an onset/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Snap to onsets' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says so when a source could not be read', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={[{ start: 1, end: 1.5, kind: 'tick' }]}
        onsetSources={[
          { id: 'audio', name: 'audio', beats: [1] },
          { id: 'stem:bass', name: 'audio · bass', beats: [], status: 'error' },
        ]}
      />,
    );
    await user.selectOptions(screen.getByRole('combobox', { name: /onsets/ }), 'stem:bass');
    expect(screen.getByText(/couldn't read audio · bass/)).toBeTruthy();
  });

  it("draws the chosen source's own envelope, not the page's", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Harness
        initial={[{ start: 1, end: 1.5, kind: 'tick' }]}
        onsetCurve={[0, 1, 0, 1]}
        onsetSources={[
          { id: 'audio', name: 'audio', beats: [1] },
          { id: 'stem:drums', name: 'audio · drums', beats: [2], curve: [1, 0, 1, 0] },
        ]}
      />,
    );
    const points = () => container.querySelector('polyline')!.getAttribute('points');
    // The mix curve starts at the floor; the drum stem's starts at the ceiling.
    expect(points()!.startsWith('0.00,100.00')).toBe(true);
    await user.selectOptions(screen.getByRole('combobox', { name: /onsets/ }), 'stem:drums');
    expect(points()!.startsWith('0.00,0.00')).toBe(true);
  });

  it('says nothing about onsets when no source is wired up', () => {
    render(<Harness initial={[{ start: 1, end: 1.5, kind: 'tick' }]} />);
    expect(screen.queryByRole('button', { name: 'Snap to onsets' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /onsets/ })).toBeNull();
  });

  it('draws an untouched node as a filled block, not as a hatched rest', () => {
    const { container } = render(<Harness initial={[]} />);
    // One full-length rest is what a brand new boundary node holds, and the
    // rest hatch there reads as "nothing rendered" rather than "nothing
    // marked" — so it is filled in the node's colour instead.
    const cell = container.querySelector('[title="0 – 4 beats · empty"]') as HTMLElement;
    expect(cell).toBeTruthy();
    expect(cell.style.backgroundImage).toBe('');
    expect(cell.style.backgroundColor).toBeTruthy();
  });

  it('goes back to hatching rests once a tick exists to rest between', () => {
    const { container } = render(<Harness initial={[{ start: 1, end: 1.5, kind: 'tick' }]} />);
    const rest = container.querySelector('[title="0 – 1 beats · empty"]') as HTMLElement;
    expect(rest).toBeTruthy();
    expect(rest.style.backgroundImage).toContain('repeating-linear-gradient');
  });

  it('has no subdivision control of its own', () => {
    render(<Harness initial={[]} />);
    expect(screen.queryByText(/Divide beat into/)).toBeNull();
    // snap defaults to free — nothing is quantised unless the user asks — and
    // the width picker beside it starts on the ±10 ms marker, so marking from
    // the audio answers "where are the hits" rather than "how long is each".
    const width = screen.getByTitle(/^How wide a block seeded/) as HTMLSelectElement;
    const snap = screen.getAllByRole('combobox').find((el) => el !== width) as HTMLSelectElement;
    expect(width.value).toBe('0');
    expect(snap.value).toBe('0');
  });
});
