import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { GridLockModal } from './GridLockModal';
import type { GridLockMove } from '../../utils/gridLockSnap';

const mv = (id: string, from: number, to: number, end?: [number, number]): GridLockMove => ({
  id, lane: 'Boundaries 1', label: id,
  from: { start: from, end: end?.[0] }, to: { start: to, end: end?.[1] },
});
const n = (k: number, end = false) => Array.from({ length: k }, (_, i) => mv(`m${i}`, i, i + 0.1, end ? [i + 1, i + 1] : undefined));

describe('GridLockModal picker', () => {
  it('defaults to boundaries+loops, lets spans be added, greys out a type with nothing to move', () => {
    const onConfirm = vi.fn();
    render(<GridLockModal moves={{ boundaries: n(32), loops: n(4, true), spans: n(10, true), 'riff-patterns': [] }}
      unitLabel="Bar" onConfirm={onConfirm} onCancel={() => {}} />);
    const box = (name: string) => screen.getByLabelText(new RegExp('^' + name)) as HTMLInputElement;
    expect(box('Boundaries').checked).toBe(true);
    expect(box('Loops').checked).toBe(true);
    expect(box('Spans').checked).toBe(false);
    expect(box('Riff patterns').disabled).toBe(true);
    expect(screen.getByText('36')).toBeTruthy();
    fireEvent.click(box('Spans'));
    fireEvent.click(box('Loops'));
    expect(screen.getByText('42')).toBeTruthy();
    fireEvent.click(screen.getByText('Enable Grid Lock'));
    expect(onConfirm).toHaveBeenCalledWith(['boundaries', 'spans']);
  });

  it('opens a row to list each move, from where to where', () => {
    render(<GridLockModal
      moves={{ boundaries: [mv('drop', 12.345, 12.5)], loops: [mv('hook', 1, 1.25, [5, 5])], spans: [], 'riff-patterns': [] }}
      unitLabel="Beat" onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.queryByText('drop')).toBeNull();
    fireEvent.click(screen.getByLabelText('Show the boundaries that move'));
    expect(screen.getByText('drop')).toBeTruthy();
    expect(screen.getByText('0:12.345')).toBeTruthy();
    expect(screen.getByText('0:12.500')).toBeTruthy();
    expect(screen.getByText('+155 ms')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Show the loops that move'));
    expect(screen.getByText('hook')).toBeTruthy();
    expect(screen.getByText('stays')).toBeTruthy();
  });
});
