import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { DetectorHeadingCheck, DetectorSidebarRow } from './DetectorSidebarRow';

describe('DetectorSidebarRow', () => {
  it('a detector that has not run yet offers ▶, and a checkbox that ticks it for a run', () => {
    const onRun = vi.fn();
    const onTick = vi.fn();
    const { getByLabelText, getByRole } = render(
      <DetectorSidebarRow name="Bass notes" hasOutput={false} onRun={onRun} onToggleVisible={onTick} />,
    );
    fireEvent.click(getByRole('checkbox'));
    expect(onTick).toHaveBeenCalledOnce();
    expect(onRun).not.toHaveBeenCalled();
    fireEvent.click(getByLabelText('Run Bass notes'));
    expect(onRun).toHaveBeenCalledOnce();
  });

  it('"failed" after the name opens the run log without ticking the row', () => {
    const onShowLog = vi.fn();
    const onTick = vi.fn();
    const { getByText } = render(
      <DetectorSidebarRow name="B" hasOutput={false} failedMessage="boom" onShowLog={onShowLog} onToggleVisible={onTick} />,
    );
    fireEvent.click(getByText('failed'));
    expect(onShowLog).toHaveBeenCalledOnce();
    expect(onTick).not.toHaveBeenCalled();
  });

  it('a row that cannot be ticked (it waits on a stem) has a disabled checkbox', () => {
    const { getByRole } = render(<DetectorSidebarRow name="Vox" hasOutput={false} needsStem="vocals" />);
    expect((getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
  });

  it('a detector with output shows/hides its lane and re-runs from ↻', () => {
    const onRun = vi.fn();
    const onToggle = vi.fn();
    const { getByRole, getByLabelText } = render(
      <DetectorSidebarRow name="Pulse" color="#fff" hasOutput visible onToggleVisible={onToggle} onRun={onRun} />,
    );
    fireEvent.click(getByRole('checkbox'));
    expect(onToggle).toHaveBeenCalledOnce();
    fireEvent.click(getByLabelText('Re-run Pulse'));
    expect(onRun).toHaveBeenCalledOnce();
  });

  it('says running, failed, nothing found, or which stem it waits on', () => {
    expect(render(<DetectorSidebarRow name="A" hasOutput onRun={() => {}} running />).getByRole('status').textContent)
      .toBe('running…');
    const failed = render(<DetectorSidebarRow name="B" hasOutput={false} onRun={() => {}} failedMessage="boom" />);
    failed.getByLabelText('Retry B');
    failed.getByText('failed');
    const empty = render(<DetectorSidebarRow name="C" hasOutput={false} emptyResult onRun={() => {}} />);
    empty.getByText('none found');
    empty.getByLabelText('Re-run C');
    const waits = render(<DetectorSidebarRow name="D" hasOutput={false} onRun={() => {}} needsStem="vocals" />);
    waits.getByText('needs vocals');
    expect(waits.queryByLabelText('Run D')).toBeNull();
  });

  it('drum source is a pill that says what Auto read; choosing runs nothing until ▶ Run', () => {
    const onRun = vi.fn();
    const onChoose = vi.fn();
    const { getByRole, rerender, queryByRole } = render(
      <DetectorSidebarRow name="Percussion layers" hasOutput onRun={onRun}
        drumSource={{ value: 'auto', chosen: 'auto', read: 'kit', onChoose }} />,
    );
    fireEvent.click(getByRole('button', { name: 'Percussion layers drums from: Auto · kit' }));
    fireEvent.click(getByRole('radio', { name: 'Bands' }));
    expect(onChoose).toHaveBeenCalledWith('bands');
    expect(onRun).not.toHaveBeenCalled();
    expect(queryByRole('button', { name: '▶ Run' })).toBeNull();
    rerender(
      <DetectorSidebarRow name="Percussion layers" hasOutput onRun={onRun}
        drumSource={{ value: 'auto', chosen: 'bands', read: 'kit', onChoose }} />,
    );
    expect(getByRole('radio', { name: 'Bands' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(getByRole('button', { name: '▶ Run' }));
    expect(onRun).toHaveBeenCalledOnce();
  });

  it('a switch is a tick always in sight; ticking runs nothing until ▶ Run', () => {
    const onRun = vi.fn();
    const onChoose = vi.fn();
    const sw = (chosen: boolean) => [{ key: 'bass_leads', label: 'The bass leads this song', value: false, chosen, onChoose }];
    const { getByRole, rerender, queryByRole } = render(
      <DetectorSidebarRow name="In front" hasOutput onRun={onRun} switches={sw(false)} />,
    );
    const tick = getByRole('checkbox', { name: 'The bass leads this song' }) as HTMLInputElement;
    expect(tick.checked).toBe(false);
    fireEvent.click(tick);
    expect(onChoose).toHaveBeenCalledWith(true);
    expect(onRun).not.toHaveBeenCalled();
    expect(queryByRole('button', { name: '▶ Run' })).toBeNull();
    rerender(<DetectorSidebarRow name="In front" hasOutput onRun={onRun} switches={sw(true)} />);
    expect((getByRole('checkbox', { name: 'The bass leads this song' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(getByRole('button', { name: '▶ Run' }));
    expect(onRun).toHaveBeenCalledOnce();
  });

  it('section source is a pill that says what Auto read; choosing runs nothing until ▶ Run', () => {
    const onRun = vi.fn();
    const onChoose = vi.fn();
    const { getByRole, rerender, queryByRole } = render(
      <DetectorSidebarRow name="Energy levels" hasOutput onRun={onRun}
        sectionSource={{ value: 'auto', chosen: 'auto', read: 'annotated', onChoose }} />,
    );
    fireEvent.click(getByRole('button', { name: 'Energy levels sections from: Auto · Annotated' }));
    fireEvent.click(getByRole('radio', { name: 'All-In-One' }));
    expect(onChoose).toHaveBeenCalledWith('allin1');
    expect(onRun).not.toHaveBeenCalled();
    expect(queryByRole('button', { name: '▶ Run' })).toBeNull();
    rerender(
      <DetectorSidebarRow name="Energy levels" hasOutput onRun={onRun}
        sectionSource={{ value: 'auto', chosen: 'allin1', read: 'annotated', onChoose }} />,
    );
    expect(getByRole('radio', { name: 'All-In-One' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(getByRole('button', { name: '▶ Run' }));
    expect(onRun).toHaveBeenCalledOnce();
  });

  it('a detector\'s own sources are a pill labelled from its list, saying what Auto read', () => {
    const onRun = vi.fn();
    const onChoose = vi.fn();
    const options = [
      { name: 'auto', label: 'Auto', hint: 'yours, else a model' },
      { name: 'yours', label: 'Yours', hint: 'your lanes' },
      { name: 'ivrit', label: 'ivrit', hint: 'the Hebrew model' },
    ];
    const { getByRole, rerender, queryByRole } = render(
      <DetectorSidebarRow name="Held lyrics" hasOutput onRun={onRun}
        source={{ options, value: 'auto', chosen: 'auto', read: 'ivrit', onChoose }} />,
    );
    fireEvent.click(getByRole('button', { name: 'Held lyrics reads: Auto · ivrit' }));
    expect(getByRole('radio', { name: 'Yours' }).getAttribute('title')).toBe('your lanes');
    fireEvent.click(getByRole('radio', { name: 'Yours' }));
    expect(onChoose).toHaveBeenCalledWith('yours');
    expect(onRun).not.toHaveBeenCalled();
    expect(queryByRole('button', { name: '▶ Run' })).toBeNull();
    rerender(
      <DetectorSidebarRow name="Held lyrics" hasOutput onRun={onRun}
        source={{ options, value: 'auto', chosen: 'yours', read: 'ivrit', onChoose }} />,
    );
    fireEvent.click(getByRole('button', { name: '▶ Run' }));
    expect(onRun).toHaveBeenCalledOnce();
  });

  it('grouped sources sit under their headings, one choice across all of them', () => {
    const onChoose = vi.fn();
    const options = [
      { name: 'auto', label: 'Auto', hint: '' },
      { name: 'yours', label: 'All yours', hint: '', group: 'Your lanes' },
      { name: 'lane:a1', label: 'Ivrit lyrics', hint: '', group: 'Your lanes' },
      { name: 'ivrit', label: 'ivrit', hint: '', group: 'Models' },
    ];
    const { getByRole } = render(
      <DetectorSidebarRow name="Held lyrics" hasOutput onRun={() => {}}
        source={{ options, value: 'lane:a1', chosen: 'lane:a1', onChoose }} />,
    );
    fireEvent.click(getByRole('button', { name: 'Held lyrics reads: Ivrit lyrics' }));
    const mine = getByRole('radiogroup', { name: 'Held lyrics reads, Your lanes' });
    expect([...mine.querySelectorAll('[role=radio]')].map((r) => r.textContent)).toEqual(['All yours', 'Ivrit lyrics']);
    expect(getByRole('radio', { name: 'Ivrit lyrics' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(getByRole('radio', { name: 'ivrit' }));
    expect(onChoose).toHaveBeenCalledWith('ivrit');
  });

  it('a source lane that was deleted reads as such, not as its id', () => {
    const { getByRole } = render(
      <DetectorSidebarRow name="Held lyrics" hasOutput onRun={() => {}}
        source={{ options: [{ name: 'auto', label: 'Auto', hint: '' }], value: 'lane:x1', chosen: 'lane:x1', onChoose: () => {} }} />,
    );
    expect(getByRole('button', { name: 'Held lyrics reads: a deleted lane' })).toBeTruthy();
  });

  it('a lane read before the kit was split says it is out of date', () => {
    const { getByText } = render(
      <DetectorSidebarRow name="Percussion layers" hasOutput onRun={() => {}} stale="split since" />,
    );
    expect(getByText('out of date').getAttribute('title')).toBe('split since');
  });

  it('strictness is a pill until clicked; the slider is 0-100 and moving it runs nothing', () => {
    const onRun = vi.fn();
    const onChoose = vi.fn();
    const { getByRole, getByText, queryByRole } = render(
      <DetectorSidebarRow name="Pulse" hasOutput onRun={onRun} strictness={{ value: 50, chosen: 50, onChoose }} />,
    );
    expect(queryByRole('slider')).toBeNull();
    fireEvent.click(getByRole('button', { name: 'Pulse strictness: Normal' }));
    const slider = getByRole('slider', { name: 'Pulse strictness' }) as HTMLInputElement;
    expect([slider.min, slider.max, slider.step, slider.value]).toEqual(['0', '100', '1', '50']);
    getByText('Normal');
    fireEvent.change(slider, { target: { value: '73' } });
    fireEvent.pointerUp(slider);
    fireEvent.keyUp(slider);
    fireEvent.blur(slider);
    expect(onChoose).toHaveBeenLastCalledWith(73);
    expect(onRun).not.toHaveBeenCalled();
  });

  it('set away from the lane, the slider stays open and offers a Run beside it, and the run is the one click', () => {
    const onRun = vi.fn();
    const { getByRole, getByText, getByLabelText } = render(
      <DetectorSidebarRow name="Pulse" hasOutput onRun={onRun} strictness={{ value: 50, chosen: 73, onChoose: vi.fn() }} />,
    );
    expect((getByRole('slider', { name: 'Pulse strictness' }) as HTMLInputElement).value).toBe('73');
    getByText('73');
    expect(getByLabelText('Re-run Pulse').getAttribute('title')).toContain('at strictness 73');
    fireEvent.click(getByText('▶ Run'));
    expect(onRun).toHaveBeenCalledOnce();
  });

  it('at the lane\'s own setting there is no extra Run, and the slider stays tucked away', () => {
    const { queryByText, queryByRole } = render(
      <DetectorSidebarRow name="Pulse" hasOutput onRun={() => {}} strictness={{ value: 100, chosen: 100, onChoose: vi.fn() }} />,
    );
    expect(queryByText('▶ Run')).toBeNull();
    expect(queryByText('Loose')).not.toBeNull();
    expect(queryByRole('slider')).toBeNull();
  });

  it('a row standing for several lanes shows a dash when only some are checked', () => {
    const { getByRole, getByText } = render(
      <DetectorSidebarRow name="Repeats" hasOutput mixed onToggleVisible={() => {}} note="4 stems" />,
    );
    expect((getByRole('checkbox') as HTMLInputElement).indeterminate).toBe(true);
    getByText('4 stems');
  });

  it('while a run is in flight the slider is held', () => {
    const { getByRole, queryByText } = render(
      <DetectorSidebarRow name="Pulse" hasOutput onRun={() => {}} running
        strictness={{ value: 50, chosen: 80, onChoose: vi.fn() }} />,
    );
    const slider = getByRole('slider', { name: 'Pulse strictness' }) as HTMLInputElement;
    expect(slider.value).toBe('80');
    expect(slider.disabled).toBe(true);
    expect(queryByText('▶ Run')).toBeNull();
  });

  it('a heading box checks every row, clears them when all are on, and shows a dash in between', () => {
    const onSet = vi.fn();
    const some = render(<DetectorHeadingCheck label="Default" allOn={false} allOff={false} onSet={onSet} />);
    const box = some.getByLabelText('All Default') as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    fireEvent.click(box);
    expect(onSet).toHaveBeenLastCalledWith(true);
    const every = render(<DetectorHeadingCheck label="Custom" allOn allOff={false} onSet={onSet} />);
    fireEvent.click(every.getByLabelText('All Custom'));
    expect(onSet).toHaveBeenLastCalledWith(false);
  });
  it('a partly checked heading clears in one click with "none", hidden when nothing is checked', () => {
    const onSet = vi.fn();
    const some = render(<DetectorHeadingCheck label="Default" allOn={false} allOff={false} onSet={onSet} />);
    fireEvent.click(some.getByLabelText('Clear all Default'));
    expect(onSet).toHaveBeenLastCalledWith(false);
    some.unmount();
    const none = render(<DetectorHeadingCheck label="Default" allOn={false} allOff onSet={onSet} />);
    expect(none.queryByLabelText('Clear all Default')).toBeNull();
  });
  it('"only" shows this lane alone, and reads "all" while it is the only one', () => {
    const onSolo = vi.fn();
    const off = render(<DetectorSidebarRow name="Pulse" hasOutput visible onToggleVisible={() => {}} onSolo={onSolo} />);
    fireEvent.click(off.getByLabelText('Show only Pulse'));
    expect(onSolo).toHaveBeenCalledOnce();
    off.unmount();
    const on = render(<DetectorSidebarRow name="Pulse" hasOutput visible onToggleVisible={() => {}} onSolo={onSolo} soloed />);
    expect(on.getByRole('button', { pressed: true }).textContent).toBe('all');
  });
});
