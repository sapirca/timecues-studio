import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { useAnnotationPopover } from './useAnnotationPopover';

// jsdom has neither a ResizeObserver nor layout, and the hook measures the
// real card so the clamp uses its true footprint. Give it both: a no-op
// observer, and a 300x400 card — the footprint the tests below reason about.
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {} unobserve() {} disconnect() {}
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 300 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 400 });
});

// Where a card lands relative to the click. The rule is "just right of and
// just below the pointer" — the click is what the card is about, so it has to
// be visibly tied to it. Two escapes from that rule: a card with no room on
// the right flips to the left of the click rather than sliding back over it,
// and a card taller than the viewport gives up on `y` to stay on screen.

function Harness({ anchor }: { anchor?: { x: number; y: number } }) {
  const p = useAnnotationPopover({ width: 300, height: 400, margin: 12 });
  return (
    <>
      <button type="button" onClick={() => p.openAt('layer', 'item', anchor)}>open</button>
      {p.open && (
        <div ref={p.popoverRef} data-testid="card" style={p.positionStyle}>
          card
        </div>
      )}
    </>
  );
}

function openAt(anchor?: { x: number; y: number }) {
  render(<Harness anchor={anchor} />);
  act(() => { screen.getByText('open').click(); });
  return screen.getByTestId('card').style;
}

describe('useAnnotationPopover positioning', () => {
  afterEach(cleanup);

  it('opens just right of and below the click', () => {
    const s = openAt({ x: 400, y: 200 });
    expect(s.left).toBe('408px');
    expect(s.top).toBe('208px');
  });

  it('flips to the left of the click when the right side has no room', () => {
    // jsdom's window is 1024 wide: 900 + 8 + 300 overruns it, and 900 - 8 -
    // 300 clears the margin, so the card goes on the other side of the
    // pointer instead of clamping back on top of it.
    const s = openAt({ x: 900, y: 200 });
    expect(s.left).toBe('592px');
  });

  it('clamps rather than flipping when neither side fits', () => {
    // Too close to the right edge to sit right of the click, too close to the
    // left edge to flip: staying wholly on screen wins over either.
    const s = openAt({ x: 260, y: 200 });
    expect(s.left).toBe('268px');
  });

  it('centers when there is no click to sit beside', () => {
    // Opened from a keyboard or a menu rather than a pointer: with nothing to
    // anchor to, the middle of the screen is the honest answer.
    const s = openAt();
    expect(s.left).toBe('50%');
    expect(s.top).toBe('50%');
    expect(s.transform).toBe('translate(-50%, -50%)');
  });
});
