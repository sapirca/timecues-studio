/**
 * A lane's Visualize switch: whether the lane plays along with the playhead.
 *
 * Off by default, and per lane. With it on, the lane shows what is sounding
 * now: the section, span, loop or bar under the playhead is lit, the last
 * cue or hit crossed is lit, a pulse blinks on its rate and a drum groove
 * flashes each kick, snare and hat as it is struck. With it off nothing on
 * the lane moves but the playhead line itself — a timeline of twenty lanes
 * all blinking at once is noise, not information.
 */
import { PICKABLE_ATTR } from './visualizeLanes';

/** The small switch in a lane's gutter: ◇ off, ◈ lit in the lane's colour. */
export function VisualizeToggle({ on, color, onToggle }: {
  on: boolean;
  color: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? 'Stop visualizing this lane' : 'Visualize this lane with playback'}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      title={on
        ? 'Visualizing with playback — click to stop'
        : 'Visualize with playback: light what is sounding, blink pulses and drum hits'}
      className="ml-0.5 inline-flex items-center justify-center align-middle w-5 h-5 rounded text-[14px] leading-none transition-all hover:bg-white/10"
      style={{
        color: on ? color : '#9ca3af',
        textShadow: on ? `0 0 6px ${color}cc` : undefined,
        opacity: on ? 1 : 0.85,
      }}
    >
      {on ? '◈' : '◇'}
    </button>
  );
}

/** The same switch in words, for a lane's card. */
export function VisualizeCardButton({ on, color, onToggle }: {
  on: boolean;
  color: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className="w-full px-2 py-1.5 rounded text-[11px] text-gray-200 border border-white/10 hover:bg-white/[0.06] transition-colors flex items-center justify-center gap-1.5"
    >
      <span aria-hidden style={{ color: on ? color : '#6b7280' }}>{on ? '◈' : '◇'}</span>
      {on ? 'Visualizing with playback — stop' : 'Visualize with playback'}
    </button>
  );
}

/**
 * Picking mode's switch over a lane's label: the whole label is the target,
 * so turning on five lanes is five clicks on five names — no selecting a
 * lane first to find a 12px glyph. It covers the label, so while picking a
 * click there never selects, renames or drags.
 */
export function VisualizePickCover({ on, color, name, onToggle }: {
  on: boolean;
  color: string;
  name: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      {...{ [PICKABLE_ATTR]: '' }}
      aria-pressed={on}
      aria-label={on ? `Stop visualizing ${name}` : `Visualize ${name}`}
      title={on ? `${name} — visualizing; click to leave it out` : `${name} — click to visualize with playback`}
      draggable={false}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className="absolute inset-0 z-[5] flex items-center justify-end pr-1 cursor-pointer transition-colors"
      style={{
        background: on ? `${color}2e` : 'rgba(10,11,13,0.55)',
        boxShadow: on ? `inset 0 0 0 1px ${color}aa` : 'inset 0 0 0 1px rgba(255,255,255,0.08)',
      }}
    >
      <span
        aria-hidden
        className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-sm text-[11px] leading-none bg-[#0a0b0d]"
        style={{
          color: on ? color : '#9ca3af',
          border: `1px solid ${on ? color : '#4b5563'}`,
          textShadow: on ? `0 0 6px ${color}cc` : undefined,
        }}
      >
        {on ? '◈' : '◇'}
      </span>
    </button>
  );
}

/**
 * Outside picking mode, the cover's stand-in: it marks the lane as one that
 * can play along, so the Visualize button's "All" can find every such lane
 * with one click instead of opening the picker first.
 */
export function VisualizePickMarker() {
  return <span hidden {...{ [PICKABLE_ATTR]: '' }} />;
}

/**
 * The timeline's Visualize button. Off, it opens picking mode. Picking, it
 * becomes the bar that says what to do and how to finish. On, it says how
 * many lanes are playing along, reopens the picker, and stops them all.
 */
export function VisualizeModeBar({ on, picking, count, onStart, onDone, onAll, onNone, onOff, grid }: {
  on: boolean;
  picking: boolean;
  count: number;
  onStart: () => void;
  onDone: () => void;
  onAll: () => void;
  onNone: () => void;
  onOff: () => void;
  /** The beat grid's switch, on pages where the grid can play along. */
  grid?: { on: boolean; onToggle: () => void };
}) {
  const chip = 'px-2 py-1 rounded text-[10px] leading-none transition-colors';
  // The main button gets room inside and around it, so it reads as the
  // timeline's control rather than one more word in the row.
  const main = 'px-3 py-1 rounded text-[10px] leading-none transition-colors';
  // One click to every lane, without opening the picker.
  const allChip = (
    <button
      type="button"
      onClick={onAll}
      title="Visualize every lane on the timeline with playback"
      className={`${chip} text-gray-400 hover:text-gray-200 hover:bg-white/10`}
    >
      All
    </button>
  );
  if (picking) {
    return (
      <div className="mx-3 flex items-center gap-2.5 text-[10px] text-gray-300" role="toolbar" aria-label="Pick lanes to visualize">
        <span className="text-cyan-300" aria-hidden>◈</span>
        <span>Click lane names to visualize them</span>
        <span className="text-gray-500">· {count} on</span>
        {grid && (
          <button
            type="button"
            onClick={grid.onToggle}
            aria-pressed={grid.on}
            title={grid.on ? 'Beat grid — visualizing; click to leave it out' : 'Beat grid — light each bar and beat on the waveform as it plays'}
            className={`${chip} border ${grid.on ? 'bg-cyan-500/20 text-cyan-200 border-cyan-400/40' : 'text-gray-300 border-white/15 hover:bg-white/10'}`}
          >
            {grid.on ? '◈' : '◇'} Beat grid
          </button>
        )}
        <button type="button" onClick={onAll} className={`${chip} text-gray-300 hover:bg-white/10`}>All</button>
        <button type="button" onClick={onNone} className={`${chip} text-gray-300 hover:bg-white/10`}>None</button>
        <button type="button" onClick={onDone} className={`${chip} bg-cyan-500/20 text-cyan-200 border border-cyan-400/40 hover:bg-cyan-500/30`}>Done</button>
      </div>
    );
  }
  if (on && count > 0) {
    return (
      <div className="mx-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onStart}
          title="Change which lanes play along with the playhead"
          className={`${main} flex items-center gap-1 bg-cyan-500/15 text-cyan-200 border border-cyan-400/40 hover:bg-cyan-500/25`}
        >
          <span aria-hidden style={{ textShadow: '0 0 6px #22d3eecc' }}>◈</span>
          Visualizing {count} {count === 1 ? 'lane' : 'lanes'}
        </button>
        <button
          type="button"
          onClick={onOff}
          title="Stop visualizing — your picks are kept for next time"
          className={`${chip} text-gray-400 hover:text-gray-200 hover:bg-white/10`}
        >
          Stop
        </button>
        {allChip}
      </div>
    );
  }
  return (
    <div className="mx-3 flex items-center gap-2">
      <button
        type="button"
        onClick={onStart}
        title="Pick lanes to play along with the playhead: light what is sounding, blink pulses and drum hits"
        className={`${main} flex items-center gap-1 text-gray-300 border border-white/15 hover:bg-white/10`}
      >
        <span aria-hidden>◇</span>
        Visualize
      </button>
      {allChip}
    </div>
  );
}
