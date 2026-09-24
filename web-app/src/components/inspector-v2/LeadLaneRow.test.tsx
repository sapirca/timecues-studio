/**
 * The picker's naming rules. Every candidate has to arrive with a name a
 * person recognises: most spans and riff instances are never labelled one by
 * one, and a list of "(unlabeled)" rows makes the handover unpickable.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LeadLaneRow, LEAD_LANE_H } from './LeadLaneRow';
import type { LeadCandidate } from '../../utils/leadLane';

const LANE_WIDTH = 1000;

beforeAll(() => {
  // jsdom lays nothing out, so the lane has no width to map clientX onto.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: LANE_WIDTH, bottom: 22,
    width: LANE_WIDTH, height: 22, toJSON: () => ({}),
  } as DOMRect);
});

function cand(over: Partial<LeadCandidate>): LeadCandidate {
  return {
    layerId: 'L1', layerName: 'Chello parts', layerType: 'spans', color: '#0f0',
    itemId: 'i1', label: 'Chello parts', start: 0, end: 60, ...over,
  };
}

/** Drag across the lane to open the picker. */
function openPicker(candidates: LeadCandidate[]) {
  render(
    <LeadLaneRow
      candidates={candidates}
      duration={100}
      currentTime={0}
      onAssignLead={() => {}}
    />,
  );
  const lane = document.querySelector('.bg-gray-950')!;
  fireEvent.pointerDown(lane, { isPrimary: true, clientX: 0 });
  fireEvent.pointerMove(lane, { isPrimary: true, clientX: 300 });
  fireEvent.pointerUp(lane, { isPrimary: true, clientX: 300 });
  return screen.getByRole('dialog');
}

describe('LeadPicker naming', () => {
  it('lists an unlabelled item under its layer name, not "(unlabeled)"', () => {
    const dialog = openPicker([cand({ itemId: 'a', label: 'Chello parts' })]);
    expect(dialog.textContent).toContain('Chello parts');
    expect(dialog.textContent).not.toContain('unlabeled');
  });

  it('shows the occurrence beside a name borrowed from the layer', () => {
    const dialog = openPicker([cand({
      itemId: 'a', layerName: 'Tick Tick (Riff)', label: 'Tick Tick (Riff)',
      placeholder: 'Instance 5', layerType: 'riff-patterns',
    })]);
    expect(dialog.textContent).toContain('Tick Tick (Riff)');
    expect(dialog.textContent).toContain('Instance 5');
  });

  it('keeps a real label as the name and the layer as the detail', () => {
    openPicker([cand({ itemId: 'a', label: 'Chello' })]);
    const row = screen.getByRole('button', { name: /Chello/ });
    expect(row.textContent).toContain('Chello');
    expect(row.textContent).toContain('Chello parts');
  });

  it('falls back to the range when nothing else tells two items apart', () => {
    const dialog = openPicker([cand({ itemId: 'a', start: 10, end: 20 })]);
    // No tempo passed, so the range reads as clock time.
    expect(dialog.textContent).toMatch(/0:10/);
  });
});

/**
 * Splitting a block that already has a lead. Painting a sub-range with the
 * mouse has always worked, but a lead region is routinely a couple of bars —
 * a dozen pixels — and a drag that short never clears the click threshold, so
 * the gesture was unreachable exactly where it was wanted. Both affordances
 * below exist so the cut never depends on how wide the block happens to be.
 */
describe('splitting a lead region', () => {
  const LEAD_GRID = { bpm: 120, gridOffset: 0, beatsPerBar: 4 };  // bar = 2s

  const leader = cand({ prominence: [{ t: 0, level: 'lead' as const }] });

  function renderLane(currentTime = 0, item = leader) {
    const onAssignLead = vi.fn();
    render(
      <LeadLaneRow
        candidates={[item]}
        duration={100}
        currentTime={currentTime}
        gridProps={LEAD_GRID}
        onAssignLead={onAssignLead}
      />,
    );
    const lane = document.querySelector('.bg-gray-950') as HTMLElement;
    const block = lane.querySelector('[title^="Lead:"]') as HTMLElement;
    const strip = block.querySelector('[aria-label^="Split"]') as HTMLElement;
    return { onAssignLead, lane, block, strip };
  }

  /** Slide to `clientX` along the block's cut strip, then press and release. */
  function cutAt(strip: HTMLElement, clientX: number) {
    fireEvent.pointerMove(strip, { isPrimary: true, clientX });
    fireEvent.pointerDown(strip, { isPrimary: true, clientX });
    fireEvent.pointerUp(document, { isPrimary: true, clientX });
  }

  it('gives a lead block one cut strip, however dense its bars are', () => {
    // One strip, not a handle per bar: at a realistic zoom the bar lines are a
    // few pixels apart, and per-bar handles tiled the block so completely that
    // a plain click on it always landed on one instead of selecting it.
    const { block } = renderLane();
    expect(block.querySelectorAll('[aria-label^="Split"]').length).toBe(1);
  });

  it('cuts at the BEAT nearest the pointer, not the bar', () => {
    // 10px = 1s, bars every 2s, beats every 0.5s. x=108 is 10.8s: the nearest
    // bar is 10.0, the nearest beat 11.0. A handover does not wait for the bar
    // line, so the beat wins.
    const { strip } = renderLane();
    cutAt(strip, 108);
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('0:11.0');
    expect(dialog.textContent).toContain('1:00.0');
  });

  it('passes the block end through untouched instead of re-snapping it', () => {
    // Ends at 55s, which is NOT on the 2s bar grid. Re-snapping would pull the
    // range back inside the block and leave a sliver of the old lead behind.
    const offGridEnd = cand({ start: 0, end: 55, prominence: [{ t: 0, level: 'lead' as const }] });
    const { strip } = renderLane(0, offGridEnd);
    cutAt(strip, 200);
    expect(screen.getByRole('dialog').textContent).toContain('0:55.0');
  });

  it('assigns only the part after the cut', () => {
    const { strip, onAssignLead } = renderLane();
    cutAt(strip, 100);
    fireEvent.click(screen.getByRole('dialog').querySelector('button')!);
    expect(onAssignLead).toHaveBeenCalledWith(10, 60, 'i1');
  });

  it('a DRAG that starts on the strip still paints a range', () => {
    // The strip sits on top of the block, so it must not eat the pointerdown —
    // otherwise painting a sub-range inside a block becomes impossible.
    const { strip } = renderLane();
    fireEvent.pointerMove(strip, { isPrimary: true, clientX: 100 });
    fireEvent.pointerDown(strip, { isPrimary: true, clientX: 100 });
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 300 });
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 300 });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('0:10.0');
    expect(dialog.textContent).toContain('0:30.0');   // painted, not cut-to-end
  });

  it('a click on the block BODY reselects the whole range, not a cut', () => {
    const { block } = renderLane();
    const box = block.getBoundingClientRect();
    fireEvent.pointerDown(block, { isPrimary: true, clientX: 300, clientY: box.top + 10 });
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 300 });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('0:00.0');
    expect(dialog.textContent).toContain('1:00.0');
  });

  it('offers a playhead split once a region picker is open', () => {
    const { block } = renderLane(20);
    fireEvent.pointerDown(block, { isPrimary: true, clientX: 100 });
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 100 });          // a click, not a drag
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('0:00.0');          // whole region first
    // The playhead is the one cut the picker offers itself; every other beat
    // is taken off the block's rail.
    fireEvent.click(screen.getByText(/split at bar 10/));
    expect(dialog.textContent).toContain('0:20.0');          // narrowed to the cut
    expect(dialog.textContent).toContain('1:00.0');
  });

  it('hides the playhead split when the playhead is outside the range', () => {
    const { block } = renderLane(80);
    fireEvent.pointerDown(block, { isPrimary: true, clientX: 100 });
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 100 });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.queryByText(/split at/)).toBeNull();
  });

  it('never lists the beats as buttons — the beat is picked on the block', () => {
    // A chip per beat used to sit under the pick-list, so "0·1 0·2 0·3 1 …"
    // read as a second way of choosing WHO leads. The cut is a place in the
    // song, so the rail on the block is the only place it is chosen.
    const { lane } = renderLane();
    fireEvent.pointerDown(lane, { isPrimary: true, clientX: 0, clientY: 4 });
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 40 });      // 0–4s: seven beats in
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 40 });
    const chips = [...screen.getByRole('dialog').querySelectorAll('button')]
      .map((b) => b.textContent ?? '')
      .filter((t) => /^\d+(·\d+)?$/.test(t));
    expect(chips).toEqual([]);
  });

  it('points at the rail when a range has beats to cut at', () => {
    const { lane } = renderLane();
    fireEvent.pointerDown(lane, { isPrimary: true, clientX: 0, clientY: 4 });
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 40 });
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 40 });
    expect(screen.getByRole('dialog').textContent).toMatch(/rail/i);
  });

  it('divides a ONE-BAR block, which has beats in it even with no bar line', () => {
    // The case that drove this: a one-bar lead block has no downbeat inside it,
    // so a bar-only cut grid could not divide it anywhere.
    const oneBar = cand({ start: 0, end: 2, prominence: [{ t: 0, level: 'lead' as const }] });
    const { block } = renderLane(0, oneBar);
    const rail = block.querySelector('[aria-label^="Split"]') as HTMLElement;
    expect(rail).toBeTruthy();
    fireEvent.pointerMove(rail, { isPrimary: true, clientX: 10 });   // 1.0s — the third beat
    fireEvent.pointerDown(rail, { isPrimary: true, clientX: 10 });
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 10 });
    expect(screen.getByRole('dialog').textContent).toContain('0:01.0');
  });

  it('says why a sub-beat block has no cut, instead of showing nothing', () => {
    const sliver = cand({ start: 0, end: 0.4, prominence: [{ t: 0, level: 'lead' as const }] });
    const { block } = renderLane(0, sliver);
    expect(block.querySelectorAll('[aria-label^="Split"]').length).toBe(0);
    fireEvent.pointerDown(block, { isPrimary: true, clientX: 2 });
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 2 });
    expect(screen.getByRole('dialog').textContent).toMatch(/nothing to split/i);
  });

  it('shows a visible rail on a block that CAN be divided', () => {
    const { block } = renderLane();
    const rail = block.querySelector('[aria-label^="Split"]') as HTMLElement;
    expect(rail).toBeTruthy();
    expect(rail.style.background).not.toBe('');   // not an invisible hotzone
  });

  it('names a cut by the bar it starts, not the one before it', () => {
    // A downbeat rounded to milliseconds can read as the bar that just ended,
    // which used to name a cut with the bar that came before it.
    const { strip } = renderLane();
    fireEvent.pointerMove(strip, { isPrimary: true, clientX: 200 });   // 20.0s — a bar line exactly
    // Bars run 2s from t=0, so 20.0s opens bar 10 and closes bar 9.
    expect(strip.getAttribute('aria-label')).toContain('bar 10');
  });
});

describe('painting a range snaps to block edges, not only to downbeats', () => {
  const GRID = { bpm: 120, gridOffset: 0, beatsPerBar: 4 };  // bar = 2s
  // Runs 11s–41s: neither edge is on a downbeat, so plain bar snapping trims.
  const offGrid = cand({ start: 11, end: 41, prominence: [{ t: 0, level: 'lead' as const }] });

  function drag(from: number, to: number) {
    render(
      <LeadLaneRow candidates={[offGrid]} duration={100} currentTime={0}
        gridProps={GRID} onAssignLead={() => {}} />,
    );
    const lane = document.querySelector('.bg-gray-950')!;
    fireEvent.pointerDown(lane, { isPrimary: true, clientX: from });
    fireEvent.pointerMove(document, { isPrimary: true, clientX: to });
    fireEvent.pointerUp(document, { isPrimary: true, clientX: to });
    return screen.getByRole('dialog').textContent ?? '';
  }

  it('lands on the block edges when the drag roughly covers it', () => {
    // 10px = 1s here. Down at 10.4s, up at 41.6s — both inside half a bar of
    // the block's real edges, and both nearer those than the downbeats at 10s
    // and 42s.
    const text = drag(104, 416);
    expect(text).toContain('0:11.0');
    expect(text).toContain('0:41.0');
  });

  it('still snaps to the downbeat when that is the nearer edge', () => {
    // Down at 20.4s / up at 30.4s: the block's edges are far away, so the bar
    // grid wins and the range reads whole bars.
    const text = drag(204, 304);
    expect(text).toContain('0:20.0');
    expect(text).toContain('0:30.0');
  });
});

describe('dismissing the picker', () => {
  it('closes on Escape without the panel having been focused', () => {
    render(
      <LeadLaneRow candidates={[cand({ prominence: [{ t: 0, level: 'lead' as const }] })]}
        duration={100} currentTime={0} onAssignLead={() => {}} />,
    );
    const lane = document.querySelector('.bg-gray-950')!;
    fireEvent.pointerDown(lane, { isPrimary: true, clientX: 700 });
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 900 });
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 900 });
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

/**
 * The lane stacks all four prominence levels, not just the front. Reading a
 * Counter off the canvas used to mean opening the annotation's own popover —
 * on a riff instance, whose row dims a whole cycle rather than drawing a
 * skyline, that was the only place it appeared at all.
 */
describe('the four-level lane', () => {
  // Leads for the first 20s, then drops back to Counter for the rest.
  const handover = cand({
    start: 0, end: 60,
    prominence: [{ t: 0, level: 'lead' as const }, { t: 20, level: 'counter' as const }],
  });

  function renderTiers() {
    render(
      <LeadLaneRow candidates={[handover]} duration={100} currentTime={0}
        gridProps={{ bpm: 120, gridOffset: 0, beatsPerBar: 4 }}
        onAssignLead={() => {}} />,
    );
    const lane = document.querySelector('.bg-gray-950') as HTMLElement;
    const blockFor = (level: string) =>
      lane.querySelector(`[title^="${level}:"]`) as HTMLElement | null;
    return { lane, blockFor };
  }

  it('names every tier in the gutter, front to back', () => {
    const { lane } = renderTiers();
    const gutter = [...lane.querySelectorAll('span')]
      .map((el) => el.textContent)
      .filter((t) => ['Lead', 'Counter', 'Backing', 'Silent'].includes(t ?? ''));
    expect(gutter).toEqual(['Lead', 'Counter', 'Backing', 'Silent']);
  });

  it('draws the same item on two tiers as its arc steps down', () => {
    const { blockFor } = renderTiers();
    expect(blockFor('Lead')?.getAttribute('title')).toContain('0:00.0–0:20.0');
    expect(blockFor('Counter')?.getAttribute('title')).toContain('0:20.0–1:00.0');
    expect(blockFor('Backing')).toBeNull();     // nothing is annotated back there
    expect(blockFor('Silent')).toBeNull();
  });

  it('gives every tier a cut rail, not just the lead', () => {
    const { blockFor } = renderTiers();
    expect(blockFor('Lead')!.querySelectorAll('[aria-label^="Split"]').length).toBe(1);
    expect(blockFor('Counter')!.querySelectorAll('[aria-label^="Split"]').length).toBe(1);
  });

  it('a cut on a lower tier asks what THAT item does, not who leads', () => {
    // Below the lead tier a block names exactly one item, so the question is
    // its own level over the range — not a cross-layer contest for the front.
    const onSetLevel = vi.fn();
    render(
      <LeadLaneRow candidates={[handover]} duration={100} currentTime={0}
        gridProps={{ bpm: 120, gridOffset: 0, beatsPerBar: 4 }}
        onAssignLead={() => {}} onSetLevel={onSetLevel} />,
    );
    const lane = document.querySelector('.bg-gray-950') as HTMLElement;
    fireEvent.pointerDown(lane, { isPrimary: true, clientX: 400, clientY: 18 });   // Counter tier
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 400 });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/what does/i);
    expect(dialog.textContent).toContain('Chello parts');
    expect(screen.queryByText('no lead')).toBeNull();   // meaningless here
    fireEvent.click(screen.getByRole('button', { name: /^Backing/ }));
    expect(onSetLevel).toHaveBeenCalledWith(20, 60, 'i1', 'backing');
  });

  it('routes Lead from the level picker through the exclusive handover', () => {
    // Writing `lead` without demoting whoever held it would leave two
    // unreconciled leads on disk, so it must not take the plain-level path.
    const onAssignLead = vi.fn();
    const onSetLevel = vi.fn();
    render(
      <LeadLaneRow candidates={[handover]} duration={100} currentTime={0}
        gridProps={{ bpm: 120, gridOffset: 0, beatsPerBar: 4 }}
        onAssignLead={onAssignLead} onSetLevel={onSetLevel} />,
    );
    const lane = document.querySelector('.bg-gray-950') as HTMLElement;
    fireEvent.pointerDown(lane, { isPrimary: true, clientX: 400, clientY: 18 });
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 400 });
    fireEvent.click(screen.getByRole('button', { name: /^Lead/ }));
    expect(onAssignLead).toHaveBeenCalledWith(20, 60, 'i1');
    expect(onSetLevel).not.toHaveBeenCalled();
  });

  it('washes only the tier that was clicked, not the whole row', () => {
    const { lane } = renderTiers();
    fireEvent.pointerDown(lane, { isPrimary: true, clientX: 400, clientY: 18 });   // Counter tier
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 400 });
    const wash = [...lane.querySelectorAll('div')].find(
      (el) => el.style.background === 'rgba(45, 212, 191, 0.2)',
    );
    expect(wash).toBeTruthy();
    const tierH = LEAD_LANE_H / 4;
    expect(wash!.style.top).toBe(`${tierH}px`);    // tier 1 of 4
    expect(wash!.style.height).toBe(`${tierH}px`);
  });

  it('washes the whole row for a painted drag, which has no source block', () => {
    const { lane } = renderTiers();
    fireEvent.pointerDown(lane, { isPrimary: true, clientX: 400, clientY: 18 });
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 600 });
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 600 });
    const wash = [...lane.querySelectorAll('div')].find(
      (el) => el.style.background === 'rgba(45, 212, 191, 0.2)',
    );
    expect(wash!.style.top).toBe('0px');
    expect(wash!.style.height).toBe(`${LEAD_LANE_H}px`);
  });

  it('a click on a lower tier reselects THAT block, not whatever leads there', () => {
    const { lane } = renderTiers();
    // x=400 => t=40s. y=18 lands in the second 14px tier (Counter).
    fireEvent.pointerDown(lane, { isPrimary: true, clientX: 400, clientY: 18 });
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 400 });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('0:20.0');
    expect(dialog.textContent).toContain('1:00.0');
  });
});
