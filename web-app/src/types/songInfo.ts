// Per-song info that applies across all annotation types (manual / eye / auto-guess).
// Stored at /api/song-info/<slug> (file: ../song-info/<slug>.json).
//
// BPM is required to start any beat-aware annotation; the others have defaults
// (4/4 and 0.000s offset) so a song can be saved with just a BPM.
//
// Lock state is dataset-wide and lives in data/dataset-config.json (see
// types/datasetConfig.ts) — there is no per-song lock field.
//
// Grid mode (Static BPM / Dynamic / Manual adjustment):
//   - 'static'   — single global `bpm` + `gridOffset` (legacy behavior).
//   - 'dynamic'  — sparse `tempoAnchors` baseline derived from per-frame
//                  tempo analysis (server or client-side).
//   - 'manual'   — dual-layer grid built on top of a chosen base
//                  (`manualBaseGridMode`):
//        base   → either Static (global bpm + offset, anchors ignored) or
//                 Dynamic (`tempoAnchors` active). The curator picks
//                 when first entering Manual mode; the picker can be
//                 reopened from the grid-mode controls.
//        micro  → `beatOverrides` (a sparse index→timestamp map; edited
//                 via the emerald grid strip). Pins individual beats to a
//                 new position WITHOUT touching the macro layer, so a
//                 single-beat fix doesn't warp its neighbors.
// `gridMode`, `tempoAnchors`, `beatOverrides`, and `manualBaseGridMode`
// are all optional; absence = static mode with no anchors (the legacy
// default for songs created before these fields existed).

export type GridMode = 'static' | 'dynamic' | 'manual';

/** Base grid Manual mode rides on top of. Only meaningful when
 *  `gridMode === 'manual'`. 'static' = ignore tempoAnchors; 'dynamic' =
 *  apply them. Undefined = the curator hasn't chosen yet, so the UI
 *  should prompt before allowing manual edits. */
export type ManualBaseGridMode = 'static' | 'dynamic';

/** One point on the piecewise-constant tempo curve. The segment that
 *  *starts* at `timestamp` has tempo `bpm` until the next anchor (or end
 *  of audio). For times before the first anchor, fall back to the global
 *  `bpm` + `gridOffset` on the SongInfo. */
export interface TempoAnchor {
  timestamp: number;   // seconds
  bpm: number;         // beats per minute
}

export interface SongInfo {
  song: string;
  bpm?: number;
  timeSignature: string;  // default '4/4'
  gridOffset: number;     // default 0
  gridMode?: GridMode;    // default 'static' when absent
  tempoAnchors?: TempoAnchor[];  // sorted ascending by timestamp; default []
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
  updated_at: string;
}

export const DEFAULT_TIME_SIGNATURE = '4/4';
export const DEFAULT_GRID_OFFSET = 0;
export const DEFAULT_GRID_MODE: GridMode = 'static';

/** Anchors closer than this collapse into a single point. Matches the
 *  "tight millisecond threshold" used by the manual-drag insert logic. */
export const ANCHOR_DEDUP_SEC = 0.020;  // 20 ms

export function makeEmptySongInfo(slug: string): SongInfo {
  return {
    song: slug,
    timeSignature: DEFAULT_TIME_SIGNATURE,
    gridOffset: DEFAULT_GRID_OFFSET,
    gridMode: DEFAULT_GRID_MODE,
    tempoAnchors: [],
    beatOverrides: {},
    updated_at: new Date().toISOString(),
  };
}

/** Active beat-override count. Like getActiveAnchorCount, this returns 0
 *  outside Manual mode regardless of any leftover entries — they're
 *  treated as orphan data until the curator re-enters Manual mode. */
export function getActiveBeatOverrideCount(info: SongInfo | null | undefined): number {
  if (!info || info.gridMode !== 'manual') return 0;
  const o = info.beatOverrides;
  if (!o) return 0;
  return Object.keys(o).length;
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

/** True when the song's grid is anchor-driven rather than a single global
 *  tempo. Convenience predicate for UI and engine branches. */
export function isAnchorMode(mode: GridMode | undefined): boolean {
  return mode === 'dynamic' || mode === 'manual';
}

/** The base grid Manual mode rides on top of. In Dynamic mode this is
 *  implicitly 'dynamic'; in Static mode 'static'. In Manual mode the
 *  curator picks via the base-grid picker and the choice persists in
 *  `manualBaseGridMode`. Returns undefined for Manual mode when no
 *  choice has been made yet — that's the signal to prompt. */
export function effectiveManualBase(
  info: SongInfo | null | undefined,
): ManualBaseGridMode | undefined {
  if (!info || info.gridMode !== 'manual') return undefined;
  return info.manualBaseGridMode;
}

/** The anchors that actually shape the rendered grid, accounting for
 *  the active mode. Returns undefined in Static mode (anchors ignored)
 *  and in Manual+Static base mode (anchors ignored). Otherwise returns
 *  `info.tempoAnchors`. */
export function effectiveAnchors(
  info: SongInfo | null | undefined,
): readonly TempoAnchor[] | undefined {
  if (!info) return undefined;
  const mode = effectiveGridMode(info);
  if (mode === 'static') return undefined;
  if (mode === 'manual' && info.manualBaseGridMode === 'static') return undefined;
  return info.tempoAnchors;
}

/** Active anchor count. Returns 0 in static mode regardless of any
 *  leftover entries — those are treated as orphan data until the curator
 *  re-enters an anchor mode. */
export function getActiveAnchorCount(info: SongInfo | null | undefined): number {
  if (!info || !isAnchorMode(info.gridMode)) return 0;
  return info.tempoAnchors?.length ?? 0;
}

/** Sort anchors by timestamp and collapse near-duplicates (within
 *  ANCHOR_DEDUP_SEC). When two anchors collapse, the earlier-listed one
 *  wins — callers that want "newest wins" should put the new anchor
 *  first. Anchors with non-finite or non-positive BPM are dropped. */
export function normalizeAnchors(anchors: readonly TempoAnchor[]): TempoAnchor[] {
  const valid = anchors.filter(
    (a) => Number.isFinite(a.timestamp) && a.timestamp >= 0
        && Number.isFinite(a.bpm) && a.bpm > 0,
  );
  const sorted = [...valid].sort((a, b) => a.timestamp - b.timestamp);
  const out: TempoAnchor[] = [];
  for (const a of sorted) {
    const last = out[out.length - 1];
    if (last && a.timestamp - last.timestamp < ANCHOR_DEDUP_SEC) continue;
    out.push(a);
  }
  return out;
}
