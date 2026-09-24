import { useRef } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AnnotationPointCard } from './AnnotationPointCard';
import { SettingsProvider } from '../../../context/SettingsContext';

// The Timing section's column legend is the only always-visible label telling
// an annotator which numbering the bar.beat column uses — a zero-based grid
// otherwise just reads as off by one.
function Card() {
  const ref = useRef<HTMLDivElement>(null);
  return (
      <AnnotationPointCard
        popoverRef={ref}
        kind="cue"
        layerName="Cues 1"
        layerColor="#888"
        start={0}
        label=""
        description=""
        bpm={120}
        gridOffset={0}
        beatsPerBar={4}
        onChange={vi.fn()}
        onClose={vi.fn()}
        positionStyle={{ left: 0, top: 0 }}
      />
  );
}

function mount(origin: 0 | 1) {
  // Sentinel = this store already went through the zero-based migration, so
  // the explicitly chosen origin survives readStored().
  localStorage.setItem('timecues.settings.v1', JSON.stringify(
    { barBeatOrigin: origin, _barBeatOriginZeroMigrated: true }));
  render(<SettingsProvider><Card /></SettingsProvider>);
}

afterEach(() => { cleanup(); localStorage.clear(); });

describe('AnnotationPointCard bar.beat legend', () => {
  it('labels the column "from 1" under musician numbering', () => {
    mount(1);
    const legend = screen.getAllByTitle(/^bar\.beat —/).find((e) => e.tagName === 'SPAN')!;
    expect(legend.textContent).toContain('from 1');
    expect(legend.getAttribute('title')).toContain('2.3 = bar 2 beat 3');
    expect(legend.getAttribute('title')).toContain('count from 1');
  });

  it('labels the column "from 0" under zero-based numbering', () => {
    mount(0);
    const legend = screen.getAllByTitle(/^bar\.beat —/).find((e) => e.tagName === 'SPAN')!;
    expect(legend.textContent).toContain('from 0');
    // The worked example stays inside the zero-based numbering (beats 0-3).
    expect(legend.getAttribute('title')).toContain('1.2 = bar 1 beat 2');
    expect(legend.getAttribute('title')).toContain('count from 0');
    expect(legend.getAttribute('title')).toContain('First bar / first beat numbered');
  });
});

// Deleting is destructive and irreversible from inside the card, so it has to
// respect the same veto every other close path does — a guard that says "no"
// (an unsaved Tap Along recording whose prompt the user cancelled) must leave
// the item alone, not delete it behind a card that stayed open.
describe('AnnotationPointCard Delete', () => {
  function mountWithDelete(veto: boolean) {
    const onDelete = vi.fn();
    const onClose = vi.fn(() => (veto ? false : undefined));
    function C() {
      const ref = useRef<HTMLDivElement>(null);
      return (
        <AnnotationPointCard
          popoverRef={ref}
          kind="cue"
          layerName="Cues 1"
          layerColor="#888"
          start={0}
          label=""
          description=""
          bpm={120}
          gridOffset={0}
          beatsPerBar={4}
          onChange={vi.fn()}
          onDelete={onDelete}
          onClose={onClose}
          positionStyle={{ left: 0, top: 0 }}
        />
      );
    }
    render(<SettingsProvider><C /></SettingsProvider>);
    return { onDelete, onClose };
  }

  it('keeps the item when a close guard vetoes the close', () => {
    const { onDelete, onClose } = mountWithDelete(true);
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('deletes once the close goes through', () => {
    const { onDelete } = mountWithDelete(false);
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
