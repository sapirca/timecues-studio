// Per-song info that applies across all annotation types (manual / auto-guess).
// Stored at /api/song-info/<slug> (file: ../song-info/<slug>.json).
//
// BPM is required to start any beat-aware annotation; the others have defaults
// (4/4 and 0.000s offset) so a song can be saved with just a BPM.
//
// Lock state is dataset-wide and lives in data/dataset-config.json (see
// types/datasetConfig.ts) — there is no per-song lock field.
//
// Grid mode (Static BPM / Mapped / Manual adjustment):
//   - 'static'   — single global `bpm` + `gridOffset` (legacy behavior).
//   - 'mapped'   — a tempo map: `gridSegments`, each a hard restart of the
//                  bar grid with its own tempo and meter.
//   - 'manual'   — dual-layer grid built on top of a chosen base
//                  (`manualBaseGridMode`):
//        base   → either Static (global bpm + offset) or Mapped (the
//                 song's `gridSegments`). The curator picks when first
//                 entering Manual mode; the picker can be reopened from
//                 the grid-mode controls.
//        micro  → `beatOverrides` (a sparse index→timestamp map; edited
//                 via the emerald grid strip). Pins individual beats to a
//                 new position WITHOUT touching the macro layer, so a
//                 single-beat fix doesn't warp its neighbors.
// `gridMode`, `beatOverrides`, and `manualBaseGridMode` are all optional;
// absence = static mode (the legacy default for songs created before
// these fields existed).

export type GridMode = 'static' | 'mapped' | 'manual';

/** Base grid Manual mode rides on top of. Only meaningful when
 *  `gridMode === 'manual'`. Undefined = the curator hasn't chosen yet, so
 *  the UI should prompt before allowing manual edits. */
export type ManualBaseGridMode = 'static' | 'mapped';

/** One grid segment: a hard restart of the bar grid.
 *
 *  `start` IS bar 1, beat 1 of a fresh grid carrying its own tempo and its
 *  own meter. Whatever the previous segment was in the middle of stops
 *  there — a bar that only got three and a half beats is a normal outcome,
 *  not an error to round away.
 *
 *  Segments are NOT boundaries: they carry no type, no label and no
 *  vocabulary. They are the ruler, not an annotation on it.
 *
 *  Only the splits *after* the opening are stored. The opening segment is
 *  derived from the song's own `gridOffset` / `bpm` / `timeSignature`, so
 *  those three fields stay the single source of truth for "how the song
 *  starts" and every existing reader of them keeps working. See
 *  resolveGridSegments() in utils/gridSegments.ts. */
export interface GridSegment {
  /** Stable across drags — beat-override keys are scoped by it. */
  id: string;
  /** Seconds, absolute. Strictly greater than the song's gridOffset. */
  start: number;
  bpm: number;
  /** '4/4' | '3/4' | '6/8' | '7/8' | … */
  timeSignature: string;
}

/** Whether bar numbers keep counting across a split or restart at 1.
 *  'continue' is the default: "bar 42" stays a stable reference in
 *  exports, evaluation tables and review notes. */
export type BarNumbering = 'continue' | 'restart';

export interface SongInfo {
  song: string;
  /** Optional human-readable title shown in the UI. Absent → fall back to the
   *  audio file name. The on-disk slug/file name is never affected. */
  title?: string;
  /** Optional artist; only used when `title` is also set, rendered as
   *  "Artist — Title". Ignored when `title` is blank. */
  artist?: string;
  /** Optional curator-defined collection this song belongs to — the one piece
   *  of grouping the corpus can't derive for itself ("Set 1", "Needs a second
   *  pass", "Ex. for the paper"). Free text, one per song, dataset-wide like
   *  the rest of song-info: a collection is a statement about the corpus, not
   *  a private bookmark. Absent / blank = uncollected. */
  collection?: string;
  bpm?: number;
  timeSignature: string;  // default '4/4'
  gridOffset: number;     // default 0
  gridMode?: GridMode;    // default 'static' when absent
  /** Sparse per-beat overrides for Manual mode. Key is the global integer
   *  beat index (cumulative from the song origin, stringified — same shape
   *  the renderer emits as `GridLine.beatIndex` at integer beats). Value
   *  is the new absolute timestamp in seconds for that beat line.
   *
   *  The override displaces the line's *position* on the timeline; the
   *  beat's classification (bar / phrase / sub-beat) is still derived from
   *  the index, so a moved bar line stays a bar line. Sub-beat lines
   *  (8th, 16th notes) are not overridable — only integer beats are. */
  beatOverrides?: Record<string, number>;
  /** Base grid Manual mode rides on top of (see ManualBaseGridMode). When
   *  `gridMode === 'manual'` and this is undefined, the UI prompts the
   *  curator to choose before any edits are committed. Ignored when
   *  `gridMode !== 'manual'`. */
  manualBaseGridMode?: ManualBaseGridMode;
  /** Grid segments after the opening one, sorted ascending by `start`.
   *  Absent or empty = one grid for the whole song, which renders exactly
   *  as it did before this field existed. */
  gridSegments?: GridSegment[];
  /** Bar-numbering convention across splits. Default 'continue'. */
  barNumbering?: BarNumbering;
  /** When true, the annotator opens this song with Grid Lock on.
   *  Set automatically when the annotator enables Grid Lock; cleared on disable.
   *  Field name kept as `annotatorGridMode` for on-disk compatibility with
   *  already-persisted song-info JSON (pre-rename from "Grid Mode"). */
  annotatorGridMode?: boolean;
  updated_at: string;
}

export const DEFAULT_TIME_SIGNATURE = '4/4';
export const DEFAULT_GRID_OFFSET = 0;
export const DEFAULT_GRID_MODE: GridMode = 'static';

/** Display name derived purely from the editable title/artist fields, mirroring
 *  the server's deriveDisplayName precedence (artist+title → "Artist — Title",
 *  else title). Returns undefined when no title is set, signalling the caller
 *  to fall back to the file-name-derived name. */
export function songTitleDisplay(info: SongInfo | null | undefined): string | undefined {
  const title = info?.title?.trim();
  if (!title) return undefined;
  const artist = info?.artist?.trim();
  return artist ? `${artist} — ${title}` : title;
}

/** Split a display name into its title / artist halves.
 *
 *  Prefers explicit metadata (`title` / `artist`, either from song-info or the
 *  manifest entry that mirrors it); otherwise falls back to the "Artist — Title"
 *  file-name convention that deriveDisplayName() emits. Surfaces that show the
 *  two parts separately (page header, sidebar row) all read title-first, so the
 *  split has to live in one place.
 */
export function splitDisplayName(
  name: string,
  meta?: { title?: string | null; artist?: string | null },
): { title: string; artist?: string } {
  const explicitTitle = meta?.title?.trim();
  if (explicitTitle) {
    return { title: explicitTitle, artist: meta?.artist?.trim() || undefined };
  }
  const idx = name.indexOf(' — ');
  if (idx > 0) {
    return {
      title: name.slice(idx + 3).trim(),
      artist: name.slice(0, idx).trim() || undefined,
    };
  }
  return { title: name };
}

export function makeEmptySongInfo(slug: string): SongInfo {
  return {
    song: slug,
    timeSignature: DEFAULT_TIME_SIGNATURE,
    gridOffset: DEFAULT_GRID_OFFSET,
    gridMode: DEFAULT_GRID_MODE,
    beatOverrides: {},
    updated_at: new Date().toISOString(),
  };
}

/** Active beat-override count. Returns 0 outside Manual mode regardless
 *  of any leftover entries — they're treated as orphan data until the
 *  curator re-enters Manual mode. */
export function getActiveBeatOverrideCount(info: SongInfo | null | undefined): number {
  if (!info || info.gridMode !== 'manual') return 0;
  const o = info.beatOverrides;
  if (!o) return 0;
  return Object.keys(o).length;
}

/** The collection a song is filed under, or undefined when the field is blank
 *  or absent. One helper so the sidebar's headings, the picker's known-names
 *  list and the editor can't disagree about what counts as "uncollected". */
export function songCollection(info: SongInfo | null | undefined): string | undefined {
  const name = info?.collection?.trim();
  return name ? name : undefined;
}

/** A song is ready for annotation as soon as it has a BPM. The dataset-wide
 *  lock is a separate edit-protection concern; it doesn't gate annotation. */
export function isGridReady(info: SongInfo | null | undefined): boolean {
  if (!info) return false;
  return typeof info.bpm === 'number' && info.bpm > 0;
}

/** Resolve the active grid mode, treating undefined as 'static' (legacy
 *  songs predate the field). */
export function effectiveGridMode(info: SongInfo | null | undefined): GridMode {
  return info?.gridMode ?? DEFAULT_GRID_MODE;
}

// ─── Reading what an older build wrote ───────────────────────────────────────

/** Grid modes this build no longer has. Drifting ('dynamic') was removed —
 *  its anchors were derived from a tempo detector, which made any grid built
 *  on them circular as evaluation ground truth. */
const RETIRED_GRID_MODES = new Set(['dynamic']);

/** Fields a retired mode wrote that nothing reads any more. */
const RETIRED_SONG_INFO_FIELDS = ['tempoAnchors'] as const;

/** Normalise a song-info document read off disk (or out of localStorage, or
 *  out of an imported dataset) into what this build understands.
 *
 *  A corpus written by an older build still carries `tempoAnchors`, and may
 *  name `dynamic` as its grid mode or Hand-placed base. `dynamic` is not in
 *  the GridMode union any more, so left alone it selects no tab in the picker
 *  and silently falls through to the static grid — a mode the curator never
 *  chose. Coercing it to 'static' names the same grid out loud.
 *
 *  Cleaning at the READ boundary is what gets the stale fields off disk: the
 *  editor persists the whole document, so the next save of a touched song
 *  writes the cleaned shape back. For a bulk sweep that doesn't wait for a
 *  curator, see tools/strip_drifting_grid_mode.py.
 *
 *  Returns the same object when there is nothing to clean, so callers can use
 *  identity to skip a re-render. */
export function sanitizeSongInfo<T extends SongInfo>(info: T): T {
  const raw = info as T & Record<string, unknown>;
  const staleFields = RETIRED_SONG_INFO_FIELDS.filter((f) => f in raw);
  const staleMode = typeof raw.gridMode === 'string' && RETIRED_GRID_MODES.has(raw.gridMode);
  const staleBase = typeof raw.manualBaseGridMode === 'string'
    && RETIRED_GRID_MODES.has(raw.manualBaseGridMode);
  if (staleFields.length === 0 && !staleMode && !staleBase) return info;

  const out = { ...raw };
  for (const f of staleFields) delete out[f];
  if (staleMode) out.gridMode = DEFAULT_GRID_MODE;
  if (staleBase) out.manualBaseGridMode = 'static' satisfies ManualBaseGridMode;
  return out as T;
}

/** The base grid Manual mode rides on top of. In Static mode this is
 *  implicitly 'static'. In Manual mode the curator picks via the
 *  base-grid picker and the choice persists in `manualBaseGridMode`.
 *  Returns undefined for Manual mode when no choice has been made yet —
 *  that's the signal to prompt. */
export function effectiveManualBase(
  info: SongInfo | null | undefined,
): ManualBaseGridMode | undefined {
  if (!info || info.gridMode !== 'manual') return undefined;
  return info.manualBaseGridMode;
}

// ─── Grid segments ───────────────────────────────────────────────────────────

/** Two segment heads closer than this collapse into one — below this, the
 *  two are the same edit. */
export const GRID_SEGMENT_DEDUP_SEC = 0.020;  // 20 ms

export const DEFAULT_BAR_NUMBERING: BarNumbering = 'continue';

/** Sort segments, drop invalid ones, drop anything at or before the song's
 *  origin (the opening segment owns that position), and collapse heads that
 *  land within GRID_SEGMENT_DEDUP_SEC of each other — earlier listed wins,
 *  so callers wanting "newest wins" put the new segment first. */
export function normalizeGridSegments(
  segments: readonly GridSegment[] | undefined,
  gridOffset: number,
): GridSegment[] {
  if (!segments || segments.length === 0) return [];
  const origin = Number.isFinite(gridOffset) ? gridOffset : 0;
  const valid = segments.filter(
    (g) => Number.isFinite(g.start) && g.start > origin + GRID_SEGMENT_DEDUP_SEC
        && Number.isFinite(g.bpm) && g.bpm > 0
        && typeof g.id === 'string' && g.id.length > 0,
  );
  const sorted = [...valid].sort((a, b) => a.start - b.start);
  const out: GridSegment[] = [];
  for (const g of sorted) {
    const last = out[out.length - 1];
    if (last && g.start - last.start < GRID_SEGMENT_DEDUP_SEC) continue;
    out.push(g);
  }
  return out;
}

/** True when the grid is a tempo map — Mapped itself, or Hand-placed riding
 *  a Mapped base. It carries a consequence for the UI: tempo and meter
 *  belong to the SEGMENTS in this
 *  mode, so a song-level BPM field beside the segment list would be a second
 *  source of truth for the same number. */
export function isMapMode(info: SongInfo | null | undefined): boolean {
  if (!info) return false;
  const mode = effectiveGridMode(info);
  return mode === 'mapped'
    || (mode === 'manual' && info.manualBaseGridMode === 'mapped');
}

/** The splits that actually shape the rendered grid, accounting for the
 *  active mode. Mapped mode applies them; so does Hand-placed on a Mapped
 *  base, where pinned beats ride the mapped grid. Every other mode leaves
 *  them on disk untouched and inactive. */
export function effectiveGridSegments(
  info: SongInfo | null | undefined,
): GridSegment[] {
  if (!info) return [];
  if (!isMapMode(info)) return [];
  return normalizeGridSegments(info.gridSegments, info.gridOffset ?? 0);
}

/** Every stored split, whatever the mode. For the editors, which have to show
 *  the map you are building even before it is the active grid. */
export function storedGridSegments(
  info: SongInfo | null | undefined,
): GridSegment[] {
  if (!info) return [];
  return normalizeGridSegments(info.gridSegments, info.gridOffset ?? 0);
}

/** How many grids the song is divided into, counting the opening one.
 *  Returns 1 for a song that has never been split, 0 when there is no grid
 *  at all (no BPM yet). */
export function getGridSegmentCount(info: SongInfo | null | undefined): number {
  if (!isGridReady(info)) return 0;
  return storedGridSegments(info).length + 1;
}

export function effectiveBarNumbering(info: SongInfo | null | undefined): BarNumbering {
  return info?.barNumbering ?? DEFAULT_BAR_NUMBERING;
}

/** Fresh id for a new segment. Timestamp + entropy, so ids stay unique
 *  across sessions and never collide inside an override key. */
export function makeGridSegmentId(): string {
  return `gs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
