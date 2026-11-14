// Per-song reference lyrics text editor, in the lyrics editor surface. Persists
// to /api/lyrics-text/<slug> (text/plain) — one file per slug, shared
// across annotators. The text serves as the alignment target for SOFA /
// ctc-forced-aligner; Whisper-base (already wired) ignores it.

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadLyricsText, saveLyricsText } from '../../services/lyricsText';
import { InfoDot } from './InfoDot';

// 600 ms debounce — fast enough that "Saved" appears within a phrase of
// typing, slow enough that a paragraph paste doesn't fire mid-character.
const SAVE_DEBOUNCE_MS = 600;

interface LyricsTextPanelProps {
  slug: string;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function LyricsTextPanel({ slug }: LyricsTextPanelProps) {
  const [text, setText] = useState('');
  // The song whose text the box holds. Loading is derived from it, so a song
  // change reads as not-loaded-yet without an effect having to reset anything.
  const [loadedSlug, setLoadedSlug] = useState<string | null>(null);
  const loaded = loadedSlug === slug;
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>('');
  // What the box holds and which song it belongs to, as of the last render —
  // read by the unmount flush, which would otherwise see the first render's
  // empty text and save it over the lyrics.
  const latestRef = useRef({ slug, text, loaded });
  useEffect(() => { latestRef.current = { slug, text, loaded }; });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const initial = await loadLyricsText(slug);
      if (cancelled) return;
      setText(initial);
      lastSavedRef.current = initial;
      setSaveState('idle');
      setLoadedSlug(slug);
    })();
    return () => { cancelled = true; };
  }, [slug]);

  const flush = useCallback(async (value: string) => {
    if (value === lastSavedRef.current) {
      setSaveState('idle');
      return;
    }
    setSaveState('saving');
    const res = await saveLyricsText(slug, value);
    if (res.ok) {
      lastSavedRef.current = value;
      setSaveState('saved');
    } else {
      setSaveState('error');
    }
  }, [slug]);

  const onChange = useCallback((value: string) => {
    setText(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { void flush(value); }, SAVE_DEBOUNCE_MS);
  }, [flush]);

  // Flush on unmount so an in-flight debounce doesn't drop the last edit. Only
  // once the song's text has loaded: before that the box is empty because
  // nothing has arrived yet, not because anyone cleared it.
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const { slug: s, text: t, loaded: l } = latestRef.current;
    if (l && t !== lastSavedRef.current) void saveLyricsText(s, t);
  }, []);

  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
  const lineCount = text ? text.split('\n').length : 0;

  return (
    <div className="rounded-lg border border-emerald-400/20 bg-emerald-500/[0.04] p-3 mt-3">
      <div className="flex items-center justify-between mb-2 gap-3">
        <div>
          <h3 className="text-[12px] font-semibold text-emerald-200">
            Reference lyrics <span className="text-[10px] uppercase tracking-wider text-slate-500 ml-1">· experimental</span>
            <InfoDot className="ml-1.5" label="About reference lyrics" align="left">
              Paste the song's lyrics here. Shared across annotators; used as the
              alignment target for SOFA / ctc-forced-aligner. Whisper transcribes
              independently and ignores this field.
            </InfoDot>
          </h3>
        </div>
        <SaveBadge state={saveState} />
      </div>
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        disabled={!loaded}
        dir="auto"
        placeholder={loaded ? 'Verse 1\nLine one\nLine two\n\nChorus\n…' : 'Loading…'}
        spellCheck={false}
        className="w-full min-h-[160px] max-h-[400px] rounded bg-[#0c0d12] border border-white/[0.06] px-2 py-1.5 text-[12px] font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-emerald-400/30 resize-y"
      />
      <div className="mt-1 text-[10px] uppercase tracking-wider text-slate-500 font-mono">
        {lineCount} line{lineCount === 1 ? '' : 's'} · {wordCount} word{wordCount === 1 ? '' : 's'} · {text.length} char{text.length === 1 ? '' : 's'}
      </div>
    </div>
  );
}

function SaveBadge({ state }: { state: SaveState }) {
  if (state === 'idle') return null;
  const map: Record<Exclude<SaveState, 'idle'>, { tone: string; label: string }> = {
    saving: { tone: 'bg-sky-500/15 text-sky-300 border-sky-400/30', label: 'Saving…' },
    saved:  { tone: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/30', label: 'Saved' },
    error:  { tone: 'bg-rose-500/15 text-rose-300 border-rose-400/30', label: 'Save failed' },
  };
  const { tone, label } = map[state];
  return (
    <span className={`shrink-0 px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wider ${tone}`}>
      {label}
    </span>
  );
}
