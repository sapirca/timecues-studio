/**
 * Misc → "Show beat numbers": bars keep their number, and every beat is
 * numbered with its count from the start of the song — 0, 1, 2… straight
 * through, never restarting at a bar — thinned by `beatNumberStep` as the
 * player zooms out.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { GridLines } from './GridLines';
import { SettingsProvider } from '../context/SettingsContext';
import { visibleGridLines } from '../utils/beatGrid';

afterEach(cleanup);

/** Labels as [row, text], row 'bar' (top) or 'beat' (second row). */
function labelsFor(subBeatDivision: number, beatNumberStep: number, barNumberStep = 1, gridOffset = 0): [string, string][] {
  // 120 BPM, 4/4: one bar = 2 s. Two bars, numbered from 0.
  const lines = visibleGridLines({
    bpm: 120, gridOffset, beatsPerBar: 4, startTime: 0, endTime: 3.99,
    subBeatDivision, barBeatOrigin: 0,
  });
  const { container } = render(
    <SettingsProvider>
      <GridLines lines={lines} duration={4} showBarNumbers barNumberStep={barNumberStep} beatNumberStep={beatNumberStep} />
    </SettingsProvider>,
  );
  return [...container.querySelectorAll('span')].map((s) => [
    s.style.top === '11px' ? 'beat' : 'bar', s.textContent ?? '',
  ]);
}

const beats = (l: [string, string][]) => l.filter(([row]) => row === 'beat').map(([, t]) => t);
const bars = (l: [string, string][]) => l.filter(([row]) => row === 'bar').map(([, t]) => t);

describe('GridLines numbering', () => {
  it('numbers bars only when off', () => {
    expect(labelsFor(1, 0)).toEqual([['bar', '0'], ['bar', '1']]);
  });

  it('counts beats through the song without restarting at the bar', () => {
    const l = labelsFor(1, 1);
    expect(bars(l)).toEqual(['0', '1']);
    expect(beats(l)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
  });

  it('numbers beats only on a 1/16 grid, and thins them by the step', () => {
    expect(beats(labelsFor(4, 1))).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
    cleanup();
    expect(beats(labelsFor(4, 2))).toEqual(['0', '2', '4', '6']);
  });

  it('a step of 0 falls back to the bar-number culling', () => {
    expect(labelsFor(4, 0, 2)).toEqual([['bar', '0']]);
  });

  it('leaves pickup beats before the anchor unnumbered', () => {
    // Anchor at 1 s: the beats at 0 s and 0.5 s are a pickup.
    expect(beats(labelsFor(1, 1, 1, 1))[0]).toBe('0');
  });
});
