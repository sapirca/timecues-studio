import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LyricsTextPanel } from './LyricsTextPanel';
import { loadLyricsText, saveLyricsText } from '../../services/lyricsText';

vi.mock('../../services/lyricsText', () => ({
  loadLyricsText: vi.fn(async () => 'לעולם בעקבות השמש'),
  saveLyricsText: vi.fn(async () => ({ ok: true })),
}));

afterEach(() => vi.clearAllMocks());

const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;

describe('LyricsTextPanel unmount flush', () => {
  // The flush used to read the first render's text — always empty — so closing
  // the panel saved '' over lyrics that had just been saved.
  it('closing the panel never writes empty text over loaded lyrics', async () => {
    const { unmount } = render(<LyricsTextPanel slug="song" />);
    await waitFor(() => expect(box().value).toBe('לעולם בעקבות השמש'));
    unmount();
    expect(saveLyricsText).not.toHaveBeenCalled();
  });

  it('closing the panel saves an edit the debounce had not sent yet', async () => {
    const { unmount } = render(<LyricsTextPanel slug="song" />);
    await waitFor(() => expect(box().value).toBe('לעולם בעקבות השמש'));
    fireEvent.change(box(), { target: { value: 'לעולם בעקבות האור' } });
    unmount();
    expect(saveLyricsText).toHaveBeenCalledTimes(1);
    expect(saveLyricsText).toHaveBeenCalledWith('song', 'לעולם בעקבות האור');
  });

  it('closing before the text arrives saves nothing', async () => {
    let release: (t: string) => void = () => {};
    vi.mocked(loadLyricsText).mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const { unmount } = render(<LyricsTextPanel slug="song" />);
    unmount();
    release('לעולם בעקבות השמש');
    expect(saveLyricsText).not.toHaveBeenCalled();
  });
});
