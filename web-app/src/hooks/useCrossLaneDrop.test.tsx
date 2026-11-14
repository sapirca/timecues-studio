/**
 * The lane hand-off that rides along with an item drag. jsdom does no layout,
 * so `elementFromPoint` is stubbed to answer by clientY: the pointer's height
 * decides which lane it is over, which is the only thing the hook asks.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { DROP_TARGET_ATTR, edgeScrollStep, useCrossLaneDrop, type CrossLaneDropOptions } from './useCrossLaneDrop';

const pointer = (init: Record<string, unknown> = {}) => ({ isPrimary: true, pointerId: 1, pointerType: 'mouse', ...init });

const ITEMS = [{ id: 'cue-1', time: 1 }, { id: 'cue-2', time: 2 }, { id: 'cue-3', time: 3 }];

function Timeline(props: {
  onDrop: CrossLaneDropOptions['onDrop'];
  group?: string[] | null;
  groupOnly?: boolean;
  reject?: CrossLaneDropOptions['reject'];
  onOwnDrag?: () => void;
}) {
  const { beginLaneDrop } = useCrossLaneDrop({
    layerId: 'a',
    type: 'cues',
    noun: ['cue', 'cues'],
    selectedIds: new Set(),
    onToggleSelect: () => {},
    onSelectRange: () => {},
    groupFor: () => props.group ?? null,
    snapshot: (ids) => ITEMS.filter((it) => ids.includes(it.id)),
    reject: props.reject,
    onDrop: props.onDrop,
  });
  return (
    <div>
      <div data-testid="a" data-drop-lane="a" data-drop-type="cues" data-drop-name="Kicks">
        <button
          data-testid="item"
          onPointerDown={(e) => {
            if (beginLaneDrop('cue-1', e, { groupOnly: props.groupOnly })) return;
            props.onOwnDrag?.();
          }}
        />
      </div>
      <div data-testid="b" data-drop-lane="b" data-drop-type="cues" data-drop-name="Snares"><span data-testid="b-child" /></div>
      <div data-testid="spans" data-drop-lane="s" data-drop-type="spans" />
      <div data-testid="signal" />
    </div>
  );
}

/** Rows stacked 40px apart: a, b, spans, a signal row with no lane. */
function stubLayout(container: HTMLElement) {
  const rows = ['a', 'b-child', 'spans', 'signal'].map((id) => container.querySelector(`[data-testid="${id}"]`));
  document.elementFromPoint = vi.fn((_x: number, y: number) => rows[Math.floor(y / 40)] ?? null);
}

const label = () => document.querySelector<HTMLElement>('[data-testid="lane-drop-label"]');

afterEach(() => { vi.restoreAllMocks(); });

describe('useCrossLaneDrop', () => {
  it('one item: marks a same-type lane, labels it, and copies on release', () => {
    const onDrop = vi.fn();
    const onOwnDrag = vi.fn();
    const { container, getByTestId } = render(<Timeline onDrop={onDrop} onOwnDrag={onOwnDrag} />);
    stubLayout(container);
    fireEvent.pointerDown(getByTestId('item'), pointer({ clientX: 10, clientY: 10 }));
    expect(onOwnDrag).toHaveBeenCalled();
    fireEvent.pointerMove(document, pointer({ clientX: 10, clientY: 50 }));
    expect(getByTestId('b').hasAttribute(DROP_TARGET_ATTR)).toBe(true);
    expect(label()?.textContent).toBe('Copy 1 cue → Snares · hold ⌥ to move');
    fireEvent.pointerUp(document, pointer({ clientX: 10, clientY: 50 }));
    expect(onDrop).toHaveBeenCalledWith([ITEMS[0]], 'b', { move: false, joinsDrag: true });
    expect(getByTestId('b').hasAttribute(DROP_TARGET_ATTR)).toBe(false);
    expect(label()).toBeNull();
  });

  it('a group takes the gesture over, and ⌥ at release moves instead of copying', () => {
    const onDrop = vi.fn();
    const onOwnDrag = vi.fn();
    const { container, getByTestId } = render(
      <Timeline onDrop={onDrop} onOwnDrag={onOwnDrag} group={['cue-1', 'cue-3']} />,
    );
    stubLayout(container);
    fireEvent.pointerDown(getByTestId('item'), pointer({ clientY: 10 }));
    expect(onOwnDrag).not.toHaveBeenCalled();
    fireEvent.pointerMove(document, pointer({ clientY: 20 }));
    expect(label()?.textContent).toBe('2 cues · drop on another cues lane');
    fireEvent.pointerMove(document, pointer({ clientY: 50, altKey: true }));
    expect(label()?.textContent).toBe('Move 2 cues → Snares');
    fireEvent.pointerUp(document, pointer({ clientY: 50, altKey: true }));
    expect(onDrop).toHaveBeenCalledWith([ITEMS[0], ITEMS[2]], 'b', { move: true, joinsDrag: false });
  });

  it('groupOnly leaves a plain press to the row', () => {
    const onDrop = vi.fn();
    const onOwnDrag = vi.fn();
    const { container, getByTestId } = render(<Timeline onDrop={onDrop} onOwnDrag={onOwnDrag} groupOnly />);
    stubLayout(container);
    fireEvent.pointerDown(getByTestId('item'), pointer({ clientY: 10 }));
    fireEvent.pointerMove(document, pointer({ clientY: 50 }));
    expect(getByTestId('b').hasAttribute(DROP_TARGET_ATTR)).toBe(false);
    fireEvent.pointerUp(document, pointer({ clientY: 50 }));
    expect(onOwnDrag).toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('a lane that refuses says why and takes nothing', () => {
    const onDrop = vi.fn();
    const { container, getByTestId } = render(
      <Timeline onDrop={onDrop} reject={(to) => (to === 'b' ? 'Would overlap' : null)} />,
    );
    stubLayout(container);
    fireEvent.pointerDown(getByTestId('item'), pointer({ clientY: 10 }));
    fireEvent.pointerMove(document, pointer({ clientY: 50 }));
    expect(getByTestId('b').hasAttribute(DROP_TARGET_ATTR)).toBe(false);
    expect(label()?.textContent).toBe('Would overlap');
    fireEvent.pointerUp(document, pointer({ clientY: 50 }));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('ignores its own lane, another type and rows that are not lanes', () => {
    const onDrop = vi.fn();
    const { container, getByTestId } = render(<Timeline onDrop={onDrop} />);
    stubLayout(container);
    for (const y of [10, 90, 130]) {
      fireEvent.pointerDown(getByTestId('item'), pointer({ clientX: 10, clientY: 10 }));
      fireEvent.pointerMove(document, pointer({ clientX: 10, clientY: y }));
      expect(container.querySelector(`[${DROP_TARGET_ATTR}]`)).toBeNull();
      fireEvent.pointerUp(document, pointer({ clientX: 10, clientY: y }));
    }
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('drops nothing when the browser cancels the gesture, or after Escape', () => {
    const onDrop = vi.fn();
    const { container, getByTestId } = render(<Timeline onDrop={onDrop} />);
    stubLayout(container);
    fireEvent.pointerDown(getByTestId('item'), pointer({ clientY: 10 }));
    fireEvent.pointerMove(document, pointer({ clientY: 50 }));
    fireEvent.pointerCancel(document, pointer({ clientY: 50 }));
    expect(getByTestId('b').hasAttribute(DROP_TARGET_ATTR)).toBe(false);

    fireEvent.pointerDown(getByTestId('item'), pointer({ clientY: 10 }));
    fireEvent.pointerMove(document, pointer({ clientY: 50 }));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.pointerMove(document, pointer({ clientY: 55 }));
    expect(getByTestId('b').hasAttribute(DROP_TARGET_ATTR)).toBe(false);
    fireEvent.pointerUp(document, pointer({ clientY: 55 }));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('a second finger neither moves the target nor ends the gesture', () => {
    const onDrop = vi.fn();
    const { container, getByTestId } = render(<Timeline onDrop={onDrop} />);
    stubLayout(container);
    fireEvent.pointerDown(getByTestId('item'), pointer({ clientY: 10 }));
    fireEvent.pointerMove(document, pointer({ clientY: 50 }));
    fireEvent.pointerUp(document, pointer({ pointerId: 2, clientY: 50 }));
    expect(onDrop).not.toHaveBeenCalled();
    fireEvent.pointerUp(document, pointer({ clientY: 50 }));
    expect(onDrop).toHaveBeenCalledWith([ITEMS[0]], 'b', { move: false, joinsDrag: true });
  });
});

describe('edgeScrollStep', () => {
  it('scrolls up near the top, down near the bottom, faster deeper in, and not in between', () => {
    expect(edgeScrollStep(500, 0, 1000)).toBe(0);
    expect(edgeScrollStep(40, 0, 1000)).toBeLessThan(0);
    expect(edgeScrollStep(2, 0, 1000)).toBeLessThan(edgeScrollStep(40, 0, 1000));
    expect(edgeScrollStep(960, 0, 1000)).toBeGreaterThan(0);
    expect(edgeScrollStep(999, 0, 1000)).toBeGreaterThan(edgeScrollStep(960, 0, 1000));
  });
});
