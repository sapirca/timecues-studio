import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  stemSlugFromUrl,
  downloadJson,
  formatMB,
  firstVisibleSong,
} from './InspectorPageV2';

// InspectorPageV2 is a 7,000+-line page composed of a player, a corpus
// sidebar, an annotation surface, an algo inspector, and an evaluator.
// Mounting the whole component in jsdom as a "component test" would require
// stubbing dozens of services (AudioContext, AnnotatorContext, fetch for
// manifests, layer storage, stem manifests, …) and would mostly verify the
// stubs. Instead, this file pins the four pure helpers it exports — they
// are the load-bearing primitives the page uses for stem lookup, JSON
// export, byte formatting, and corpus list resolution. Each helper is
// covered in isolation.

// ─── stemSlugFromUrl — Demucs stem lookup ───────────────────────────────────

describe('stemSlugFromUrl', () => {
  it('strips the directory prefix and file extension', () => {
    expect(stemSlugFromUrl('/audio/my-song.mp3')).toBe('my-song');
  });

  it('URL-decodes percent-encoded characters', () => {
    // The stems dir is named after the raw filename; the URL form may have
    // %20 for a space, %2B for a plus sign, etc. We must hit the same dir.
    expect(stemSlugFromUrl('/audio/my%20song.mp3')).toBe('my song');
    expect(stemSlugFromUrl('/audio/track%2B1.flac')).toBe('track+1');
  });

  it('handles bare filenames (no path)', () => {
    expect(stemSlugFromUrl('my-song.wav')).toBe('my-song');
  });

  it('handles URLs with multiple dots in the filename', () => {
    // Only the LAST extension is stripped — `.live.mp3` becomes `track.live`.
    expect(stemSlugFromUrl('/audio/track.live.mp3')).toBe('track.live');
  });

  it('returns the input unchanged when there is no extension', () => {
    expect(stemSlugFromUrl('/audio/no-ext')).toBe('no-ext');
  });

  it('handles an empty url without throwing', () => {
    expect(stemSlugFromUrl('')).toBe('');
  });
});

// ─── formatMB — byte-count formatter for the upload progress bar ────────────

describe('formatMB', () => {
  it('renders one decimal place under 100 MB', () => {
    expect(formatMB(1024 * 1024)).toBe('1.0 MB');
    expect(formatMB(15.5 * 1024 * 1024)).toBe('15.5 MB');
    expect(formatMB(99 * 1024 * 1024)).toBe('99.0 MB');
  });

  it('drops decimals at 100 MB and above', () => {
    // Threshold is exactly 100 MB — anything at-or-above rounds to an integer
    // (saves horizontal space in the compact progress bar).
    expect(formatMB(100 * 1024 * 1024)).toBe('100 MB');
    expect(formatMB(250.7 * 1024 * 1024)).toBe('251 MB');
  });

  it('handles zero', () => {
    expect(formatMB(0)).toBe('0.0 MB');
  });
});

// ─── firstVisibleSong — corpus list head ─────────────────────────────────────

describe('firstVisibleSong', () => {
  const entries = [
    { id: 'a', name: 'A', url: '/audio/a.mp3' },
    { id: 'b', name: 'B', url: '/audio/b.mp3' },
  ];

  it('returns the first entry when the list is non-empty', () => {
    expect(firstVisibleSong(entries)).toEqual(entries[0]);
  });

  it('returns null on an empty list', () => {
    expect(firstVisibleSong([])).toBeNull();
  });
});

// ─── downloadJson — browser-download side effect ────────────────────────────

describe('downloadJson', () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;

  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    vi.restoreAllMocks();
  });

  it('creates a blob with pretty-printed JSON and triggers an <a> click', () => {
    let capturedBlob: Blob | null = null;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      capturedBlob = blob;
      return 'blob:fake-url';
    });
    URL.revokeObjectURL = vi.fn();

    // Spy on click; jsdom's default <a> click is a no-op but we want to be
    // sure it ran (regression on the document.body.appendChild dance).
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click');

    downloadJson('cues.json', { items: [{ time: 1, label: 'kick' }] });

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(capturedBlob).not.toBeNull();
    expect(capturedBlob!.type).toBe('application/json');
  });

  it('writes the payload as indent-2 JSON', async () => {
    let capturedBlob: Blob | null = null;
    URL.createObjectURL = vi.fn((blob: Blob) => { capturedBlob = blob; return 'blob:fake'; });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadJson('out.json', { a: 1, b: [2, 3] });

    const text = await capturedBlob!.text();
    expect(text).toBe(JSON.stringify({ a: 1, b: [2, 3] }, null, 2));
    // Sanity-check the formatting expectation (indent=2 → newlines + 2-space indent).
    expect(text).toContain('\n  ');
  });

  it('cleans up the object URL even when the click handler runs', () => {
    URL.createObjectURL = vi.fn(() => 'blob:fake');
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadJson('out.json', {});
    // The object URL leak would otherwise hold the blob in memory forever.
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
