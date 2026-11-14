/**
 * Which lanes play along with the playhead (see VisualizeToggle), and the
 * picking mode the timeline's Visualize button opens.
 *
 * The lanes you pick are remembered per song, in this browser: setting up
 * the same five lanes again after every reload was most of what made the
 * feature a chore. Turning Visualize off keeps the picks, so the next time
 * it comes on it comes on with them.
 */
import { createContext, useCallback, useEffect, useMemo, useState } from 'react';

/** True while the timeline is in picking mode: every lane's label becomes one
 *  big switch, and a click on it turns that lane on or off. */
export const VisualizePickContext = createContext(false);

/** Marks a label cell that can be picked, so "All" knows which rows can. */
export const PICKABLE_ATTR = 'data-viz-pick';

/** The beat grid's id among the picks. It has no lane label to wear a pick
 *  cover, so the Visualize bar carries its switch instead. */
export const GRID_VIZ_ID = 'beat-grid';

type Stored = { on: boolean; ids: string[] };

const keyFor = (song: string) => `tc:viz-lanes:${song}`;

function readStored(song: string): Stored {
  try {
    const raw = window.localStorage.getItem(keyFor(song));
    if (!raw) return { on: false, ids: [] };
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return {
      on: parsed.on === true,
      ids: Array.isArray(parsed.ids) ? parsed.ids.filter((id): id is string => typeof id === 'string') : [],
    };
  } catch {
    return { on: false, ids: [] };
  }
}

function writeStored(song: string, value: Stored) {
  try { window.localStorage.setItem(keyFor(song), JSON.stringify(value)); } catch { /* private mode */ }
}

export function useVisualizedLanes(song: string) {
  const [state, setState] = useState(() => ({ song, ...readStored(song) }));
  const [picking, setPicking] = useState(false);
  // Another song: load its picks, and leave picking mode.
  if (state.song !== song) {
    setState({ song, ...readStored(song) });
    setPicking(false);
  }
  useEffect(() => { writeStored(state.song, { on: state.on, ids: state.ids }); }, [state]);

  const picked = useMemo<ReadonlySet<string>>(() => new Set(state.ids), [state.ids]);
  const toggle = useCallback((rowId: string) => {
    setState((prev) => {
      const has = prev.ids.includes(rowId);
      const ids = has ? prev.ids.filter((id) => id !== rowId) : [...prev.ids, rowId];
      // Switching a lane on is switching Visualize on — a lane you just lit
      // should play along, not wait for a second button.
      return { ...prev, ids, on: prev.on || !has };
    });
  }, []);
  const setIds = useCallback((ids: string[]) => setState((prev) => ({ ...prev, ids, on: true })), []);
  const startPicking = useCallback(() => {
    setState((prev) => ({ ...prev, on: true }));
    setPicking(true);
  }, []);
  const stopPicking = useCallback(() => setPicking(false), []);
  const turnOff = useCallback(() => {
    setState((prev) => ({ ...prev, on: false }));
    setPicking(false);
  }, []);

  return {
    /** Lanes playing along right now — empty while Visualize is off. */
    active: state.on ? picked : EMPTY,
    picked,
    on: state.on,
    picking,
    toggle,
    setIds,
    startPicking,
    stopPicking,
    turnOff,
  };
}

const EMPTY: ReadonlySet<string> = new Set();
