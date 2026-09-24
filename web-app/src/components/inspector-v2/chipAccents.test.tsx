/**
 * Velocity has to be VISIBLE, not merely stored. These render the real chip
 * grid and read the opacity off the DOM, because the wiring that carries an
 * accent from the node to the chip is the part that silently breaks: a missing
 * prop typechecks fine and shows a grid where every hit looks equally hard.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ChipStrip } from './BeatChipControls';

function heights(container: HTMLElement): number[] {
  const wrapper = container.querySelector('span > span:last-child') as HTMLElement;
  return Array.from(wrapper.children).map(
    (el) => parseFloat((el as HTMLElement).style.height || '100'),
  );
}

function opacities(container: HTMLElement): number[] {
  // The strip renders one <span> per step inside its inner wrapper.
  const wrapper = container.querySelector('span > span:last-child') as HTMLElement;
  return Array.from(wrapper.children).map(
    (el) => Number((el as HTMLElement).style.opacity || '1'),
  );
}

const STEPS = 8;
const ON = [0, 2, 4, 6];

describe('ChipStrip accents', () => {
  it('draws a ghost note fainter than an accent', () => {
    const { container } = render(
      <ChipStrip
        color="#f87171" steps={STEPS} highlighted={ON} spans={[]} label=""
        accents={{ 0: 127, 2: 20 }}
      />,
    );
    const o = opacities(container);
    expect(o[2]).toBeLessThan(o[0]);
  });

  it('draws a step nobody measured at full strength', () => {
    const { container } = render(
      <ChipStrip
        color="#f87171" steps={STEPS} highlighted={ON} spans={[]} label=""
        accents={{ 0: 30 }}
      />,
    );
    const o = opacities(container);
    expect(o[4]).toBe(1);        // no entry for step 4
    expect(o[0]).toBeLessThan(1);
  });

  it('leaves every step alone when nothing was measured', () => {
    const { container } = render(
      <ChipStrip color="#f87171" steps={STEPS} highlighted={ON} spans={[]} label="" />,
    );
    for (const step of ON) expect(opacities(container)[step]).toBe(1);
  });

  it('never dims an empty step — that is what "off" already means', () => {
    const { container } = render(
      <ChipStrip
        color="#f87171" steps={STEPS} highlighted={ON} spans={[]} label=""
        accents={{ 1: 5, 3: 5 }}
      />,
    );
    const o = opacities(container);
    // Steps 1 and 3 are not played; an accent naming them must not touch them.
    expect(o[1]).toBe(1);
    expect(o[3]).toBe(1);
  });

  it('keeps the quietest played step visibly stronger than an unplayed one', () => {
    // An empty chip is drawn with the colour at 0x33 alpha (=0.2) and full
    // opacity; a ghost note at opacity 0.45+ over the solid colour stays
    // clearly the louder-looking of the two.
    const { container } = render(
      <ChipStrip
        color="#f87171" steps={STEPS} highlighted={ON} spans={[]} label=""
        accents={{ 0: 1 }}
      />,
    );
    expect(opacities(container)[0]).toBeGreaterThan(0.4);
  });
});

/**
 * Height is the channel that actually carries velocity. Opacity was there
 * first and was not enough: a detector measures level against the loudest hit
 * in the track, so a mixed drum part lives in the top third of 1..127 — a real
 * kick came out 125..127, which the ramp drew at opacity 0.991..1.000. Stored,
 * carried, drawn, and invisible.
 */
describe('ChipStrip velocity height', () => {
  it('draws a ghost note shorter than an accent', () => {
    const { container } = render(
      <ChipStrip
        color="#f87171" steps={STEPS} highlighted={ON} spans={[]} label=""
        accents={{ 0: 127, 2: 20 }}
      />,
    );
    const h = heights(container);
    expect(h[2]).toBeLessThan(h[0]);
  });

  it('separates two loud hits that opacity alone cannot', () => {
    // The real case: 94 against 127 is 0.86 vs 1.00 in opacity — no one sees
    // that. The same pair has to be plainly different in height.
    const { container } = render(
      <ChipStrip
        color="#f87171" steps={STEPS} highlighted={ON} spans={[]} label=""
        accents={{ 0: 94, 2: 127 }}
      />,
    );
    const h = heights(container);
    expect(h[2] - h[0]).toBeGreaterThan(10);   // >10% of the row
  });

  it('leaves an unmeasured step at full height', () => {
    const { container } = render(
      <ChipStrip
        color="#f87171" steps={STEPS} highlighted={ON} spans={[]} label=""
        accents={{ 0: 30 }}
      />,
    );
    const h = heights(container);
    expect(h[4]).toBe(100);
    expect(h[0]).toBeLessThan(100);
  });

  it('leaves every step full height when nothing was measured', () => {
    const { container } = render(
      <ChipStrip color="#f87171" steps={STEPS} highlighted={ON} spans={[]} label="" />,
    );
    for (const step of ON) expect(heights(container)[step]).toBe(100);
  });

  it('never shortens an empty step — that would read as a quiet note', () => {
    const { container } = render(
      <ChipStrip
        color="#f87171" steps={STEPS} highlighted={ON} spans={[]} label=""
        accents={{ 1: 5, 3: 5 }}
      />,
    );
    const h = heights(container);
    expect(h[1]).toBe(100);
    expect(h[3]).toBe(100);
  });

  it('keeps the quietest played step tall enough to see', () => {
    const { container } = render(
      <ChipStrip
        color="#f87171" steps={STEPS} highlighted={ON} spans={[]} label=""
        accents={{ 0: 1 }}
      />,
    );
    expect(heights(container)[0]).toBeGreaterThanOrEqual(30);
  });
});
