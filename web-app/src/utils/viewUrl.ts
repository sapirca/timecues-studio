/**
 * What the inspector is showing, as URL query parameters — so a refresh comes
 * back to the same place, and a copied link shows somebody else exactly what
 * you were looking at.
 *
 * The workspace tab is the path (`/prep`, `/annotate`, `/inspect`); everything
 * else rides in the query:
 *
 *   song   the open song's slug
 *   type   the annotation type being edited            (/annotate)
 *   kind   what Algorithm Inspect is examining          (/inspect)
 *   view   which Inspect tab — algo | eval | karaoke    (/inspect)
 *   algos  the algorithm lanes drawn on the timeline, comma-separated;
 *          a per-stem lane is `<algo>__<stem>`
 *   dets   the curated detectors drawn (by detector name)
 *   layers the non-detector lanes switched on: manual, autoguess,
 *          prominence, consensus
 *   signals the signal rows switched on (SIGNALS menu)
 *   fams   the algorithm families opened in the sidebar
 *   stem   the stem the player is playing (absent = full mix)
 *   filter the Algorithm Inspect stem filter (absent = full mix)
 *   lock   `0` when the player stem is unlocked from the stem filter
 *   speed  playback rate, when not 1
 *   unit   the beat-grid unit, when not a beat
 *   t      the visible time window in seconds, `start-end`, when zoomed in
 *
 * The window is stored as seconds rather than a zoom factor + scroll offset
 * because those are pixels, and the person opening the link has a different
 * screen: the same seconds are the same music at any width.
 *
 * The on/off sets (`dets`, `layers`, `signals`, `fams`) are written whole —
 * `-` for an empty one — because the recipient's own defaults are not the
 * sender's: "nothing but these" has to be said, not implied. Absent means the
 * link says nothing about that part, and the recipient's defaults stand.
 */

import type { AnnotationType, ExaminableType } from '../components/inspector-v2/shared/tabConfig';

export type InspectView = 'algo' | 'eval' | 'karaoke';
export type UrlStem = 'mix' | 'vocals' | 'drums' | 'bass' | 'other' | 'guitar' | 'piano';

export const URL_SIGNALS = [
  'waveform', '3band', 'spectrogram', 'cepstrogram', 'energy', 'brightness', 'novelty',
  'onsets', 'flux', 'chroma', 'tempogram', 'ssm', 'beatgrid',
] as const;
export type UrlSignal = typeof URL_SIGNALS[number];

export const URL_LAYERS = ['manual', 'autoguess', 'prominence', 'consensus'] as const;
export type UrlLayer = typeof URL_LAYERS[number];

export interface ViewUrlState {
  song: string | null;
  type: AnnotationType | null;
  kind: ExaminableType | null;
  view: InspectView | null;
  algos: string[];
  dets: string[] | null;
  layers: UrlLayer[] | null;
  signals: UrlSignal[] | null;
  fams: string[] | null;
  stem: UrlStem | null;
  filter: UrlStem | 'all' | null;
  lock: boolean | null;
  speed: number | null;
  unit: string | null;
  window: { start: number; end: number } | null;
}

const ANNOTATION_TYPES: readonly AnnotationType[] = ['boundaries', 'cues', 'spans', 'lyrics', 'loops', 'riff-patterns'];
const INSPECT_VIEWS: readonly InspectView[] = ['algo', 'eval', 'karaoke'];
const STEMS: readonly UrlStem[] = ['mix', 'vocals', 'drums', 'bass', 'other', 'guitar', 'piano'];
const EMPTY_SET = '-';

function parseList(raw: string | null): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** A whole on/off set: null when the link does not mention it, [] for `-`. */
function parseSet<T extends string>(raw: string | null, allowed?: readonly T[]): T[] | null {
  if (raw == null) return null;
  if (raw === EMPTY_SET) return [];
  const items = parseList(raw);
  return (allowed ? items.filter((i) => (allowed as readonly string[]).includes(i)) : items) as T[];
}

function writeSet(items: readonly string[] | null): string | null {
  if (items == null) return null;
  return items.length ? [...items].sort().join(',') : EMPTY_SET;
}

function oneOf<T extends string>(raw: string | null, allowed: readonly T[]): T | null {
  return raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

function parseWindow(raw: string | null): ViewUrlState['window'] {
  const m = raw?.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  return end > start ? { start, end } : null;
}

/** Reads the view out of a query string. Anything malformed or unknown is
 *  dropped rather than guessed at — a hand-edited or stale link opens on the
 *  defaults for that part instead of on something it never said. */
export function parseViewUrl(search: string): ViewUrlState {
  const p = new URLSearchParams(search);
  const kind = oneOf(p.get('kind'), ANNOTATION_TYPES);
  const speed = Number(p.get('speed'));
  const lock = p.get('lock');
  return {
    song: p.get('song') || null,
    type: oneOf(p.get('type'), ANNOTATION_TYPES),
    kind: kind === 'riff-patterns' ? null : kind,
    view: oneOf(p.get('view'), INSPECT_VIEWS),
    algos: parseList(p.get('algos')),
    dets: parseSet(p.get('dets')),
    layers: parseSet(p.get('layers'), URL_LAYERS),
    signals: parseSet(p.get('signals'), URL_SIGNALS),
    fams: parseSet(p.get('fams')),
    stem: oneOf(p.get('stem'), STEMS),
    filter: oneOf(p.get('filter'), [...STEMS, 'all'] as const),
    lock: lock === '0' ? false : lock === '1' ? true : null,
    speed: speed > 0 && speed <= 4 ? speed : null,
    unit: p.get('unit') || null,
    window: parseWindow(p.get('t')),
  };
}

/** Writes the view into `search`, leaving any parameter it does not own where
 *  it was. A part that is null / empty is removed, so the URL only ever says
 *  what differs from opening the song fresh. */
export function writeViewUrl(search: string, state: ViewUrlState): string {
  const p = new URLSearchParams(search);
  const put = (key: string, value: string | null) => {
    if (value) p.set(key, value); else p.delete(key);
  };
  put('song', state.song);
  put('type', state.type);
  put('kind', state.kind);
  put('view', state.view);
  put('algos', state.algos.length ? [...state.algos].sort().join(',') : null);
  put('dets', writeSet(state.dets));
  put('layers', writeSet(state.layers));
  put('signals', writeSet(state.signals));
  put('fams', writeSet(state.fams));
  put('stem', state.stem && state.stem !== 'mix' ? state.stem : null);
  put('filter', state.filter && state.filter !== 'mix' ? state.filter : null);
  put('lock', state.lock === false ? '0' : null);
  put('speed', state.speed != null && state.speed !== 1 ? String(state.speed) : null);
  put('unit', state.unit && state.unit !== 'beat' ? state.unit : null);
  put('t', state.window ? `${state.window.start.toFixed(2)}-${state.window.end.toFixed(2)}` : null);
  const out = p.toString();
  return out ? `?${out}` : '';
}
