import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { DetectorWindowRunPanel } from './DetectorWindowRunPanel';
import { runDetectorWindow } from '../../services/customScripts';

vi.mock('../../services/customScripts', () => ({
  runDetectorWindow: vi.fn(async () => ({
    items: [{ start_ms: 12_000, duration_ms: 4_000, label: 'Bass · Beat · 4 bars' }],
    errors: [], notes: [], window: { start_ms: 10_000, end_ms: 20_000, stems: ['bass'], parts: ['Bass'] },
    window_token: 't',
  })),
  applyDetectorWindow: vi.fn(),
}));
import type { CustomRegistryEntry } from '../../types/customScript';

function det(name: string, label: string, windowable: boolean, is_default: boolean, stem: CustomRegistryEntry['stem'] = 'mix'): CustomRegistryEntry {
  return {
    name, label, windowable, is_default, file: `${name}.py`, status: 'ok', output_kind: 'cue',
    is_annotation: false, description: '', version: '1', stem,
    group: null, review: false, errors: [],
  };
}

describe('DetectorWindowRunPanel detector list', () => {
  const detectors = [
    det('rhythmic_rolls', 'Rhythmic rolls', false, false),
    det('bass_notes', 'Bass notes', true, false),
    det('template', 'Template (every 30 s)', true, true),
    det('example_hardcoded_spans', 'hardcoded spans', false, true),
  ];

  it('lists every detector, whole-song ones greyed, Custom above Default', () => {
    const { container } = render(
      <DetectorWindowRunPanel slug="s" selection={{ start: 10, end: 20 }} detectors={detectors} results={{}} onApplied={() => {}} />,
    );
    const groups = [...container.querySelectorAll('optgroup')];
    expect(groups.map((g) => g.label)).toEqual(['Custom', 'Default']);
    const opts = (g: Element) => [...g.querySelectorAll('option')].map((o) => [o.textContent, o.disabled]);
    expect(opts(groups[0])).toEqual([['Bass notes', false], ['Rhythmic rolls — whole song only', true]]);
    expect(opts(groups[1])).toEqual([['Template (every 30 s)', false], ['hardcoded spans — whole song only', true]]);
    expect((container.querySelector('select') as HTMLSelectElement).value).toBe('bass_notes');
  });

  it('names the stem on each run of a detector registered once per stem', () => {
    const perStem = [
      det('wordless_vocals__vocals', 'Wordless vocals', true, false, 'vocals'),
      det('wordless_vocals__other', 'Wordless vocals', true, false, 'other'),
      det('bass_notes', 'Bass notes', true, false, 'bass'),
    ];
    const { container } = render(
      <DetectorWindowRunPanel slug="s" selection={{ start: 10, end: 20 }} detectors={perStem} results={{}} onApplied={() => {}} />,
    );
    expect([...container.querySelectorAll('option')].map((o) => o.textContent)).toEqual(
      ['Wordless vocals · vocals', 'Wordless vocals · other', 'Bass notes']);
  });

  it('lists only the stems Show per stem narrows to', () => {
    const byStem = [
      det('drum_transients', 'Drum hits', true, false, 'drums'),
      det('bass_notes', 'Bass notes', true, false, 'bass'),
      det('template', 'Template', true, true, null),
    ];
    const { container, getByText } = render(
      <DetectorWindowRunPanel slug="s" selection={{ start: 10, end: 20 }} detectors={byStem} results={{}} stems={['bass']} onApplied={() => {}} />,
    );
    expect([...container.querySelectorAll('option')].map((o) => o.value)).toEqual(['bass_notes']);
    expect((container.querySelector('select') as HTMLSelectElement).value).toBe('bass_notes');
    getByText('bass');

    const mix = render(
      <DetectorWindowRunPanel slug="s" selection={{ start: 10, end: 20 }} detectors={byStem} results={{}} stems={['mix']} onApplied={() => {}} />,
    );
    expect([...mix.container.querySelectorAll('option')].map((o) => o.value)).toEqual(['template']);
  });

  it('offers a detector with parts under each stem it reads, and runs only the lit ones', async () => {
    const pulse = { ...det('pulse', 'Pulse', true, false, 'mix'), output_kind: 'span' as const,
      stem_parts: { drums: ['Kick', 'Snare', 'Hat'], bass: ['Bass'] } };
    const results = { pulse: { items: [
      { start_ms: 12_000, duration_ms: 4_000, label: 'Kick · Beat · 4 bars' },
      { start_ms: 12_000, duration_ms: 4_000, label: 'Bass · 1/2 beat · 4 bars' },
    ] } } as never;
    const { container, getByText } = render(
      <DetectorWindowRunPanel slug="s" selection={{ start: 10, end: 20 }} detectors={[pulse]} results={results} stems={['bass']} onApplied={() => {}} />,
    );
    expect((container.querySelector('select') as HTMLSelectElement).value).toBe('pulse');
    getByText('Bass');
    fireEvent.click(getByText('Run on this section'));
    await waitFor(() => getByText(/the lane has 1 here now/));
    expect(runDetectorWindow).toHaveBeenCalledWith('pulse', 's', 10, 20, ['bass'], undefined);
  });

  it('counts and lists a lanes detector\'s run lane by lane', async () => {
    vi.mocked(runDetectorWindow).mockResolvedValueOnce({
      items: [], errors: [], notes: [], window: { start_ms: 10_000, end_ms: 20_000 }, window_token: 't',
      lanes: [
        { id: 'words', label: 'Words', output_kind: 'lyrics', group: null,
          items: [{ time_ms: 12_000, text: 'a-la-ta', kind: 'word' }] },
        { id: 'onsets', label: 'Onsets', output_kind: 'cue', group: null,
          items: [{ time_ms: 12_000, label: 'a' }, { time_ms: 12_300, label: 'la' }] },
      ],
    } as never);
    const wv = { ...det('wordless_vocals__vocals', 'Wordless vocals', true, false, 'vocals'),
      output_kind: 'lanes' as const };
    // The lane already has the first onset; nothing in Words.
    const results = { wordless_vocals__vocals: { items: [], lanes: [
      { id: 'words', label: 'Words', output_kind: 'lyrics', group: null, items: [] },
      { id: 'onsets', label: 'Onsets', output_kind: 'cue', group: null, items: [{ time_ms: 12_005, label: 'a' }] },
    ] } } as never;
    const { getByText } = render(
      <DetectorWindowRunPanel slug="s" selection={{ start: 10, end: 20 }} detectors={[wv]} results={results} onApplied={() => {}} />,
    );
    fireEvent.click(getByText('Run on this section'));
    await waitFor(() => getByText(/Found 3 here · the lane has 1 here now/));
    getByText('Merge (+2 new)');
    getByText('a-la-ta');
    getByText('Words');
  });

  it('offers the strictness slider for a detector that has it, starting where the lane is', async () => {
    const pulse = { ...det('pulse', 'Pulse', true, false, 'mix'), output_kind: 'span' as const, strictness: true };
    const results = { pulse: { items: [], strictness: 'strict' } } as never;
    const { getByRole, getByText } = render(
      <DetectorWindowRunPanel slug="s" selection={{ start: 10, end: 20 }} detectors={[pulse]} results={results} onApplied={() => {}} />,
    );
    const slider = getByRole('slider', { name: /Pulse strictness/ }) as HTMLInputElement;
    expect(slider.value).toBe('0');
    fireEvent.change(slider, { target: { value: '85' } });
    getByText('the lane is Strict');
    expect(runDetectorWindow).not.toHaveBeenCalledWith('pulse', 's', 10, 20, undefined, 85);
    fireEvent.click(getByText('Run on this section'));
    await waitFor(() => expect(runDetectorWindow).toHaveBeenLastCalledWith('pulse', 's', 10, 20, undefined, 85));
  });

  it('shows no strictness for a detector that does not offer it', () => {
    const { queryByRole } = render(
      <DetectorWindowRunPanel slug="s" selection={{ start: 10, end: 20 }} detectors={[det('bass_notes', 'Bass notes', true, false)]} results={{}} onApplied={() => {}} />,
    );
    expect(queryByRole('slider')).toBeNull();
  });

  it('keeps a detector that failed to load in the list, greyed, and says why', () => {
    const broken = { ...det('pulse', '', false, false, null), status: 'load_error' as const,
      errors: [{ index: null, field: null, value: null, message: "import failed: cannot import name 'generate_window'" }] };
    const { container, getByText } = render(
      <DetectorWindowRunPanel slug="s" selection={{ start: 10, end: 20 }} detectors={[det('bass_notes', 'Bass notes', true, false, 'bass'), broken]} results={{}} stems={['bass']} onApplied={() => {}} />,
    );
    const opt = [...container.querySelectorAll('option')].find((o) => o.value === 'pulse')!;
    expect(opt.disabled).toBe(true);
    expect(opt.textContent).toBe('pulse — failed to load');
    getByText(/generate_window/);
  });
});
