/**
 * The playhead clock — the song position during playback, kept OUT of React
 * state.
 *
 * It used to be `playerTime` state at the top of the inspector. The player
 * publishes a time every animation frame, so every frame re-rendered the whole
 * inspector and every lane, signal row and editor panel under it, whether or
 * not anything they drew had changed. The cost grew with the number of layers
 * on screen and with zoom, and on a busy song it ate the frame budget: the
 * cursor stuttered and the page stopped answering the mouse.
 *
 * Now the time lives here and reaches the screen three ways, cheapest first:
 *
 *  - `<PlayheadLine>` (components/Playhead) — a cursor line that moves
 *    itself. It subscribes and writes its own `style.left`; React never
 *    renders it after mount.
 *  - `usePlayheadEffect(fn)` — the same, for anything else that has to follow
 *    the clock every frame (a canvas sweep, a readout's text, a scroll).
 *  - `usePlayheadValue(t => …)` — a VALUE derived from the time, and a
 *    re-render only when that value changes: which lyric is current, whether
 *    this item is sounding. Return a primitive (or a stable reference); a
 *    fresh object/array per call is a new value every frame and defeats it.
 *
 * Handlers that need "where is the playhead right now" call
 * `usePlayheadClock().get()` at the moment they run, instead of closing over
 * a rendered time.
 *
 * Anything that LIGHTS ON A SOUND — a hit flashing, a word of a lyric, the
 * step of a groove — reads `usePaintClock()` instead. The published time is
 * already old when it arrives: the player reads the media clock on one
 * animation frame and publishes it on the next, and what it lights is shown
 * a frame after that. On a 60 Hz screen that is ~35 ms, and a snare is heard
 * landing before its light. The paint clock adds that lag back, measured on
 * the machine it runs on — the age of the reading when it was published, and
 * the frame length kept as a running average of the player's own readings —
 * so a 120 Hz screen or a machine dropping frames is right without a setting.
 * What it does not add is the speakers' delay: the media clock the player
 * reads already reports what is heard (it is how video stays lip-synced over
 * Bluetooth), so adding a guess for it would count it twice. The playhead
 * line stays on the published clock, level with the waveform's own cursor.
 */

import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { formatClockTime } from '../utils/clockTime';

/** A position read off the running media clock: when it was read
 *  (`performance.now()`) and the playback speed it was moving at. */
export interface PlayheadSample {
  at: number;
  rate: number;
}

export interface PlayheadClock {
  /** The latest published position, in seconds. */
  get(): number;
  /** Seconds of song between `get()` and the moment the frame now being
   *  built reaches the screen. 0 unless playing. See usePaintClock. */
  lead(): number;
  /** Publish a position. Subscribers run synchronously. No-op if unchanged.
   *  Pass the sample while playing; without one (a seek, a pause, a loop
   *  preview's own clock) there is nothing to lead. */
  set(time: number, sample?: PlayheadSample): void;
  subscribe(listener: () => void): () => void;
}

/** Until the player's readings have been timed, assume a 60 Hz screen. */
const DEFAULT_FRAME_MS = 1000 / 60;
/** Gaps between readings outside this are not a frame: two readings in one
 *  frame (the scroll and audioprocess paths both publish), or a stall. */
const MIN_FRAME_MS = 4;
const MAX_FRAME_MS = 100;
/** Share of each new frame gap taken into the running average. */
const FRAME_PULL = 0.1;
/** Never lead by more than this: a reading this old is a hiccup, not lag. */
const MAX_LEAD_S = 0.15;

export function createPlayheadClock(initial = 0): PlayheadClock {
  let time = initial;
  let lead = 0;
  let frameMs = DEFAULT_FRAME_MS;
  let lastAt = NaN;
  const listeners = new Set<() => void>();
  return {
    get: () => time,
    lead: () => lead,
    set(next, sample) {
      if (sample) {
        const gap = sample.at - lastAt;
        if (gap >= MIN_FRAME_MS && gap <= MAX_FRAME_MS) frameMs += (gap - frameMs) * FRAME_PULL;
        lastAt = sample.at;
        // The reading's age now, plus the frame until what this publish
        // lights is shown.
        const ageMs = Math.max(0, performance.now() - sample.at);
        lead = Math.min(MAX_LEAD_S, ((ageMs + frameMs) / 1000) * sample.rate);
      } else {
        lastAt = NaN;
        lead = 0;
      }
      if (next === time) return;
      time = next;
      // Snapshot: a listener may unsubscribe (unmount) while we iterate.
      for (const l of [...listeners]) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** Outside a provider (tests, a component rendered on its own) the playhead
 *  simply sits at 0. */
const STILL_CLOCK = createPlayheadClock(0);

export const PlayheadClockContext = createContext<PlayheadClock>(STILL_CLOCK);

export function usePlayheadClock(): PlayheadClock {
  return useContext(PlayheadClockContext);
}

/** The playhead as it will be when the frame now being built is on screen —
 *  for anything that lights on a sound. Same subscription, so it updates
 *  exactly when the playhead does. Pass it to usePlayheadValue /
 *  usePlayheadEffect. */
export function usePaintClock(): PlayheadClock {
  const base = usePlayheadClock();
  return useMemo(() => ({
    get: () => base.get() + base.lead(),
    lead: () => 0,
    set: base.set,
    subscribe: base.subscribe,
  }), [base]);
}

/** A value derived from the playhead; the component re-renders only when the
 *  selector's result changes (compared with `Object.is`). */
export function usePlayheadValue<T>(select: (time: number) => T, clock?: PlayheadClock): T {
  const ctxClock = usePlayheadClock();
  const c = clock ?? ctxClock;
  return useSyncExternalStore(c.subscribe, () => select(c.get()));
}

/** Run `fn` with the playhead now and on every change after, without
 *  re-rendering. `fn` may change identity freely — the latest one is called.
 *  `deps` re-runs it immediately when something else it draws from changes
 *  (a duration, a zoom), since the clock alone would not. */
export function usePlayheadEffect(
  fn: (time: number) => void,
  deps: readonly unknown[] = [],
  clock?: PlayheadClock,
): void {
  const ctxClock = usePlayheadClock();
  const c = clock ?? ctxClock;
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useLayoutEffect(() => {
    fnRef.current(c.get());
    return c.subscribe(() => fnRef.current(c.get()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c, ...deps]);
}

/**
 * Keep an absolutely-positioned element at the playhead by `transform`, not
 * `left`.
 *
 * A `left` write invalidates layout and repaints the layer the element sits
 * in — for a lane cursor, that is the lane with every tick, note and bar in
 * it. At fit zoom that is the whole song's worth of marks, redrawn every
 * frame by a dozen cursors (measured 2026-09-27: at fit zoom, 4× CPU
 * throttle, ~12 ms of a 17 ms frame was paint and layout, script under 1 ms).
 * A transform on its own compositor layer moves without either. The parent's
 * width comes from a ResizeObserver, so following the clock reads no layout.
 *
 * The element must be absolutely positioned against its offset parent, the
 * same box a percentage `left` resolved against. Returns the ref to attach.
 */
export function usePlayheadTransform<E extends HTMLElement>(duration: number, deps: readonly unknown[] = []) {
  const ref = useRef<E>(null);
  const widthRef = useRef(0);
  const place = (t: number) => {
    const el = ref.current;
    if (!el) return;
    const x = (playheadPct(t, duration) / 100) * widthRef.current;
    el.style.transform = `translate3d(${x}px,0,0)`;
  };
  const clock = usePlayheadClock();
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.offsetParent ?? el?.parentElement;
    if (!el || !box) return;
    el.style.left = '0';
    el.style.willChange = 'transform';
    widthRef.current = box.clientWidth;
    place(clock.get());
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      widthRef.current = box.clientWidth;
      place(clock.get());
    });
    ro.observe(box);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock, ...deps]);
  usePlayheadEffect(place, [duration, ...deps]);
  return ref;
}

/** Playhead position as a percentage of `duration`, clamped to [0, 100]. */
export function playheadPct(time: number, duration: number): number {
  return duration > 0 ? Math.max(0, Math.min(100, (time / duration) * 100)) : 0;
}

/**
 * Stands in for the playhead's clock time ("0:30.0") inside a label string —
 * "Split at " + PLAYHEAD_SLOT. A label that spelled the time out changed ten
 * times a second during playback, and each change re-rendered the panel that
 * built it (and, for the toolbar's labels, the whole inspector, which holds
 * them in state). With the slot, the string never changes; `<LiveLabel>` and
 * `usePlayheadTitle` fill it in at the leaf that shows it.
 */
export const PLAYHEAD_SLOT = '\uE000';

export function fillPlayheadSlot(text: string, time: number): string {
  return text.includes(PLAYHEAD_SLOT) ? text.split(PLAYHEAD_SLOT).join(formatClockTime(time)) : text;
}

/** A ref for an element whose `title` holds a PLAYHEAD_SLOT: keeps the
 *  tooltip filled from the live clock by writing the attribute directly.
 *  Pass the template as the element's `title` prop too, or not at all — the
 *  ref overwrites it either way. */
export function usePlayheadTitle<E extends HTMLElement>(text: string | undefined) {
  const ref = useRef<E>(null);
  usePlayheadEffect((t) => {
    const el = ref.current;
    if (!el || text === undefined) return;
    const next = fillPlayheadSlot(text, t);
    if (el.title !== next) el.title = next;
  }, [text]);
  return ref;
}

