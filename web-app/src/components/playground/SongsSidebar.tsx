import { useMemo, useState, type ReactNode } from 'react';

export interface SidebarSong {
  id: string;
  title: string;
}

/** What the open detector has on one song. */
export type SongRunState = 'loading' | 'none' | 'ok' | 'stale' | 'failed' | 'running' | 'queued';

export interface SongRunStatus {
  state: SongRunState;
  /** Short readout beside the dot: "12 cues", "failed", … */
  text: string;
  /** Longer explanation on hover. */
  title?: string;
}

const STATE_DOT: Record<SongRunState, string> = {
  loading: '#334155',
  none:    '#475569',
  ok:      '#10b981',
  stale:   '#f59e0b',
  failed:  '#ef4444',
  running: '#fbbf24',
  queued:  '#64748b',
};

/** The Playground's right sidebar: the song the detector runs on, and the two
 *  ways to run it — on that song, or on every song. Each row says what the
 *  open detector has on that song, so a sweep's results read at a glance. */
export function SongsSidebar({
  songs,
  loading,
  error,
  selectedSlug,
  onSelect,
  status,
  runLabel,
  runTitle,
  onRun,
  runDisabled,
  running,
  onRunAll,
  runAllDisabled,
  batch,
  onStopAll,
  onCollapse,
  children,
}: {
  songs: SidebarSong[];
  loading: boolean;
  error: string | null;
  selectedSlug: string;
  onSelect: (slug: string) => void;
  status: Record<string, SongRunStatus | undefined>;
  runLabel: string;
  runTitle: string;
  onRun: () => void;
  runDisabled: boolean;
  running: boolean;
  onRunAll: () => void;
  runAllDisabled: boolean;
  /** A Run all in flight on the open detector. */
  batch: { current: number; total: number; cancelRequested: boolean } | null;
  onStopAll: () => void;
  /** Fold the sidebar to a slim column (desktop only). */
  onCollapse?: () => void;
  /** The selected song's stems, under the list. */
  children?: ReactNode;
}) {
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? songs.filter((s) => s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)) : songs;
  }, [songs, filter]);

  return (
    <aside className="flex flex-col flex-1 min-h-0 rounded-lg border border-white/[0.06] bg-[#14171d]/80 overflow-hidden" aria-label="Songs">
      <div className="flex items-center gap-2 px-3 h-11 border-b border-white/[0.05] shrink-0">
        <h2 className="text-[13px] uppercase tracking-[0.18em] text-slate-100 font-bold">Songs</h2>
        <span className="flex-1 text-[11px] text-slate-500">{songs.length}</span>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            title="Hide songs"
            aria-label="Hide songs"
            className="hidden lg:block text-slate-500 hover:text-slate-200 transition-colors text-xl leading-none px-0.5"
          >
            ›
          </button>
        )}
      </div>
      <div className="px-3 pt-2.5 pb-2 space-y-2">
        <button
          type="button"
          onClick={onRun}
          disabled={runDisabled}
          title={runTitle}
          className="w-full h-8 px-3 rounded bg-amber-400 text-[12px] font-semibold text-[#0a0b0d] hover:bg-amber-300 disabled:opacity-40 disabled:cursor-not-allowed truncate"
        >
          {running ? 'Running…' : `▶ ${runLabel}`}
        </button>
        {batch ? (
          <button
            type="button"
            onClick={onStopAll}
            disabled={batch.cancelRequested}
            className="w-full h-8 px-3 rounded border border-amber-400/40 bg-amber-500/10 text-[12px] text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
            title="Stop after the current song finishes."
          >
            {batch.cancelRequested ? 'Stopping…' : `■ Stop · ${batch.current}/${batch.total}`}
          </button>
        ) : (
          <button
            type="button"
            onClick={onRunAll}
            disabled={runAllDisabled}
            className="w-full h-8 px-3 rounded border border-white/10 text-[12px] text-slate-200 hover:border-white/20 hover:bg-white/[0.03] disabled:opacity-40 disabled:cursor-not-allowed"
            title={`Run the open detector on every song (${songs.length}), one after another. Each row below fills in as its song finishes.`}
          >
            ▶▶ Run all {songs.length} songs
          </button>
        )}
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter songs"
          aria-label="Filter songs"
          className="w-full bg-[#0a0b0d] border border-white/10 rounded px-2 py-1.5 text-[12px] text-slate-200 placeholder:text-slate-600"
        />
      </div>
      <div className="flex items-center px-3 pb-1 text-[9px] uppercase tracking-[0.12em] text-slate-600">
        <span className="flex-1">Song</span>
        <span>This detector</span>
      </div>
      <div role="listbox" aria-label="Song to run on" className="flex-1 min-h-0 overflow-y-auto pb-2">
        {loading && <p className="px-3 py-2 text-[12px] text-slate-500">Loading songs…</p>}
        {!loading && error && <p className="px-3 py-2 text-[12px] text-rose-300">Song list failed: {error}</p>}
        {!loading && !error && songs.length === 0 && <p className="px-3 py-2 text-[12px] text-slate-500">No songs in the dataset.</p>}
        {shown.map((s) => {
          const selected = s.id === selectedSlug;
          const st = status[s.id];
          return (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={selected}
              onClick={() => onSelect(s.id)}
              title={s.title}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition ${
                selected ? 'bg-amber-500/[0.08] shadow-[inset_2px_0_0_#fbbf24]' : 'hover:bg-white/[0.03]'
              }`}
            >
              <span
                className={`w-3 h-3 rounded-full border shrink-0 grid place-items-center ${selected ? 'border-amber-300' : 'border-slate-600'}`}
                aria-hidden
              >
                {selected && <span className="w-1.5 h-1.5 rounded-full bg-amber-300" />}
              </span>
              <span className={`min-w-0 flex-1 truncate text-[12px] ${selected ? 'text-amber-100' : 'text-slate-300'}`}>{s.title}</span>
              {st && (
                <span className="flex items-center gap-1.5 shrink-0 text-[10px] text-slate-500" title={st.title}>
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${st.state === 'running' ? 'animate-pulse' : ''}`}
                    style={{ background: STATE_DOT[st.state] }}
                  />
                  {st.text}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {children && <div className="border-t border-white/[0.06] bg-black/20 px-3 py-2.5">{children}</div>}
    </aside>
  );
}
