import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CueLayerRow } from './CueLayerRow';
import { cueSubject } from '../../utils/cueSubject';
import type { CueItem } from '../../types/annotationLayer';

const cue = (id: string, time: number, label: string): CueItem => ({ id, time, label });

describe('CueLayerRow tags', () => {
  it('names each tick when the lane mixes kinds of moment', () => {
    render(<CueLayerRow items={[cue('a', 1, 'drop · bar 9'), cue('b', 5, 'hit · drums · bar 12 beat 2')]} color="#eab308" duration={10} />);
    expect(screen.getAllByTestId('cue-tag').map((t) => t.textContent)).toEqual(['drop', 'hit']);
  });

  it('leaves a lane of one kind unlabelled', () => {
    render(<CueLayerRow items={[cue('a', 1, 'kick'), cue('b', 5, 'kick')]} color="#eab308" duration={10} />);
    expect(screen.queryAllByTestId('cue-tag')).toHaveLength(0);
  });

  it('gives a tag the room up to the next tick', () => {
    render(<CueLayerRow items={[cue('a', 1, 'drop'), cue('b', 3, 'hit')]} color="#eab308" duration={10} />);
    const [first, last] = screen.getAllByTestId('cue-tag');
    expect(first.style.width).toContain('20%');
    expect(last.style.width).toContain('70%');
  });

  it('reads the subject before the first " · "', () => {
    expect(cueSubject('bass + drums in, vocals out · bar 97')).toBe('bass + drums in, vocals out');
    expect(cueSubject(undefined)).toBe('');
  });
});
