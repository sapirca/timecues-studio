/**
 * DetectorWindowRunPanel — run one custom detector on ONLY the highlighted
 * range, then fold what it found into that detector's lane.
 *
 * A whole-song run reads a section against the whole song: the loudest hit in
 * the chorus sets the scale the soft verse is measured on, and a quiet ghost
 * note there never clears the threshold. Running the detector on the range
 * alone gives it the range's own scale. It is a different reading, not a
 * cheaper copy of the same one — which is why what it found is shown first,
 * and the annotator chooses how it lands:
 *
 *   Merge   — everything already in the window stays; only what is new joins
 *             (a hit with the same label within 20 ms is the one already there).
 *   Replace — the window's items go, the run's take their place.
 *
 * Outside the window nothing changes either way, and ✓/✗ decisions follow
 * their items. The server holds the run between the two steps (a token), so
 * what lands is the runner's own validated output.
 *
 * Only detectors that declare `windowable` can be picked: the others work from
 * the whole song (most read its data off disk) and would answer about it while
 * claiming the range. They still sit in the list, greyed and marked, so a
 * detector the annotator is looking for is never simply missing. The list is
 * titled Custom / Default like every other detector list.
 *
 * When the sidebar's Show per stem chips narrow the view to some stems, the
 * list narrows with them: the detectors on offer are the ones you are looking
 * at, and the panel names the stems so the shorter list is never a mystery.
 * A detector that reads several stems into one lane (Pulse: `stem_parts`) is
 * listed under each of them and run on the lit ones only; its Replace then
 * removes only those parts' items, and says so. A detector that failed to
 * load stays in the list too, greyed, with its error below — a detector the
 * annotator expects must never just be absent.
 *
 * A detector that offers a strictness shows the same slider as its
 * sidebar row, starting at the setting its lane was read at: a section run
 * looser than the lane is how the annotator takes the pulse they hear in one
 * drop without loosening the whole song.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatClockTime } from '../../utils/clockTime';
import {
  applyDetectorWindow,
  runDetectorWindow,
  type DetectorWindowApplied,
  type DetectorWindowMode,
} from '../../services/customScripts';
import { strictnessLevel, strictnessName, type CustomRegistryEntry, type CustomResultEnvelope, type DetectorStrictness } from '../../types/customScript';
import { groupByDetectorOrigin } from '../../utils/detectorOrigin';
import { stemFilingLabel } from '../../utils/detectorStems';
import { InfoDot } from './InfoDot';
import { labelInPart } from './detectorLayers';
import { StrictnessPicker } from './DetectorSidebarRow';

/** Mirrors MERGE_SAME_MS in tools/python/custom_runner.py. */
const SAME_EVENT_MS = 20;
/** Mirrors the run-window endpoint's minimum range. */
const MIN_WINDOW_S = 1;

type Item = { time_ms?: number; start_ms?: number; label?: string | null };

/** Mirrors item_in_parts in tools/python/custom_runner.py. */
function inParts(it: Item, parts: readonly string[] | undefined): boolean {
  if (!parts) return true;
  return parts.some((p) => labelInPart(it.label, p));
}

/** A run's items, lane by lane: a `lanes` detector's lanes (each its own
 *  kind), or one unnamed lane of the detector's kind for any other. A section
 *  run of a lanes detector is merged into each lane on its own, so it is
 *  counted and listed that way too. */
interface RunLane { id: string; label: string | null; kind: string; items: Item[] }
function runLanes(env: CustomResultEnvelope | null | undefined, kind: string): RunLane[] {
  if (!env) return [];
  if (env.lanes) {
    return env.lanes.map((l) => ({ id: l.id, label: l.label, kind: l.output_kind, items: l.items as Item[] }));
  }
  return [{ id: '', label: null, kind, items: env.items as Item[] }];
}

/** Every stem a detector reads: its declared one, plus each of its parts'. */
function stemsRead(d: CustomRegistryEntry): string[] {
  return [d.stem ?? 'mix', ...Object.keys(d.stem_parts ?? {})];
}

/** A detector run once per stem registers one entry per stem, all under the
 *  file's label — five identical "Repeated sections" in a dropdown. Name the
 *  stem whenever a label is shared, so each option says which run it is. */
function optionLabel(d: CustomRegistryEntry, shared: ReadonlySet<string>): string {
  const label = d.label || d.name;
  return shared.has(label) && d.stem ? `${label} · ${stemFilingLabel(d.stem)}` : label;
}

function primaryMs(it: Item, kind: string): number {
  const v = (kind === 'boundary' || kind === 'cue' || kind === 'lyrics') ? it.time_ms : it.start_ms;
  return typeof v === 'number' ? v : 0;
}

export interface DetectorWindowRunPanelProps {
  slug: string;
  /** The highlighted region, in seconds. The call site renders nothing without one. */
  selection: { start: number; end: number };
  /** Every registered detector; the panel offers the windowable ones. */
  detectors: readonly CustomRegistryEntry[];
  /** Current output per detector, to say what the window holds now. */
  results: Record<string, CustomResultEnvelope | undefined>;
  /** Stems the sidebar is narrowed to (Show per stem). Only detectors reading
   *  one of them are listed; null or empty = every stem. A detector that
   *  declares no stem counts as `mix`. */
  stems?: readonly string[] | null;
  /** Detector to select first (e.g. the lane the user is looking at). */
  preferred?: string;
  /** The lane changed on the server — take its new output and edited copy. */
  onApplied: (name: string, applied: DetectorWindowApplied) => void;
  onSeek?: (t: number) => void;
}

export function DetectorWindowRunPanel({
  slug, selection, detectors, results, stems, preferred, onApplied, onSeek,
}: DetectorWindowRunPanelProps) {
  const { start, end } = selection;
  const usable = useMemo(
    () => detectors.filter((d) => d.status === 'ok'
      && (!stems?.length || stemsRead(d).some((s) => stems.includes(s)))),
    [detectors, stems],
  );
  const offered = useMemo(() => usable.filter((d) => d.windowable), [usable]);
  // Failed to load (an import error, a bad manifest): not runnable, but shown
  // whatever the stem filter — a detector that did not load declares no stems.
  const broken = useMemo(() => detectors.filter((d) => d.status !== 'ok'), [detectors]);
  const notOffered = useMemo(() => usable.filter((d) => !d.windowable), [usable]);
  const sharedLabels = useMemo(() => {
    const seen = new Set<string>();
    const shared = new Set<string>();
    for (const d of [...usable, ...broken]) {
      const l = d.label || d.name;
      if (seen.has(l)) shared.add(l);
      seen.add(l);
    }
    return shared;
  }, [usable, broken]);

  const [name, setName] = useState<string>('');
  useEffect(() => {
    if (offered.some((d) => d.name === name)) return;
    const want = offered.find((d) => d.name === preferred) ?? offered[0];
    setName(want?.name ?? '');
  }, [offered, preferred, name]);
  const det = offered.find((d) => d.name === name);
  const kind = det?.output_kind ?? 'cue';
  // The lit stems this detector has parts on — what a run of it reads. Null
  // when nothing narrows it: no filter, or a detector without parts.
  const runStems = useMemo(() => {
    if (!stems?.length || !det?.stem_parts) return null;
    const read = Object.keys(det.stem_parts).filter((s) => stems.includes(s));
    return read.length ? read : null;
  }, [stems, det]);
  const runParts = runStems?.flatMap((s) => det?.stem_parts?.[s] ?? []);
  const runKey = runStems?.join() ?? '';

  // Starts where the lane is, and follows it when another detector is picked.
  const laneLevel = strictnessLevel(det?.strictness ? results[name]?.strictness : undefined);
  const [level, setLevel] = useState<DetectorStrictness>(laneLevel);
  useEffect(() => { setLevel(laneLevel); }, [name, laneLevel]);

  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<CustomResultEnvelope | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // A run belongs to the window and detector it was made for. Move either and
  // it no longer describes what is on screen.
  useEffect(() => {
    setRun(null);
    setError(null);
    setDone(null);
  }, [start, end, name, runKey, level]);

  const length = end - start;
  const windowOk = length >= MIN_WINDOW_S;

  const doRun = useCallback(async () => {
    if (!name) return;
    setRunning(true);
    setError(null);
    setDone(null);
    try {
      const env = await runDetectorWindow(name, slug, start, end, runStems ?? undefined,
        det?.strictness ? level : undefined);
      if (env.fatal) {
        setRun(null);
        setError(env.fatal.message);
      } else {
        setRun(env);
      }
    } catch (e) {
      setRun(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [name, slug, start, end, runStems, det, level]);

  // What each choice would do, counted the way the server will count it.
  const preview = useMemo(() => {
    if (!run) return null;
    const lo = Math.round(start * 1000);
    const hi = Math.round(end * 1000);
    const parts = run.window?.parts;
    const lane = runLanes(results[name], kind);
    let here = 0, found = 0, fresh = 0;
    for (const got of runLanes(run, kind)) {
      const has = (lane.find((l) => l.id === got.id)?.items ?? [])
        .filter((it) => { const t = primaryMs(it, got.kind); return t >= lo && t < hi && inParts(it, parts); });
      here += has.length;
      found += got.items.length;
      fresh += got.items.filter((it) => {
        const t = primaryMs(it, got.kind);
        return !has.some((h) => (h.label ?? null) === (it.label ?? null)
          && Math.abs(primaryMs(h, got.kind) - t) <= SAME_EVENT_MS);
      }).length;
    }
    return { here, found, fresh };
  }, [run, results, name, kind, start, end]);

  const apply = useCallback(async (mode: DetectorWindowMode) => {
    if (!run?.window_token) return;
    setApplying(true);
    setError(null);
    try {
      const applied = await applyDetectorWindow(name, run.window_token, mode);
      onApplied(name, applied);
      const { added, removed, duplicates } = applied.stats;
      setDone(mode === 'merge'
        ? `Merged: ${added} added${duplicates ? `, ${duplicates} already in the lane` : ''}.`
        : `Replaced: ${removed} removed, ${added} put in their place.`);
      setRun(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }, [run, name, onApplied]);

  const fieldCls = 'bg-[#0c0d12] border border-white/[0.08] rounded px-1.5 py-0.5 text-[11px] text-slate-200 focus:outline-none focus:border-sky-400/40';

  return (
    <div className="rounded-lg border border-sky-400/20 bg-sky-500/[0.04] p-3 space-y-2">
      <h3 className="text-[12px] font-semibold text-sky-200">
        Run a detector on this section
        <InfoDot className="ml-1.5" label="What a section run does" align="left">
          Runs the detector on the highlighted region alone — it hears nothing
          else, so its thresholds and loudness scale are this section's own, and
          it can find what a whole-song run measured away. You see what it found
          first, then Merge it into the detector's lane (keep what is there, add
          what is new) or Replace the lane's items in this section with it. The
          rest of the song is never touched. Move or resize the highlight to
          change the section.
        </InfoDot>
      </h3>

      <div className="flex items-baseline flex-wrap gap-x-2 text-[11px]">
        <span className="font-mono text-slate-300">
          {formatClockTime(start, 1)} – {formatClockTime(end, 1)}
        </span>
        <span className={windowOk ? 'text-slate-500' : 'text-amber-400'}>
          {length > 0 ? `${length.toFixed(2)}s` : 'empty'}
        </span>
      </div>
      {!windowOk && (
        <div className="text-[10px] leading-snug text-amber-400/90">
          Too short to run on — widen the highlighted region to at least {MIN_WINDOW_S}s.
        </div>
      )}

      {!!stems?.length && (
        <div className="text-[10px] leading-snug text-slate-500">
          Only <span className="text-slate-300 capitalize">{stems.map(stemFilingLabel).join(', ')}</span> detectors,
          following <span className="text-slate-300">Show per stem</span> below.
        </div>
      )}
      {offered.length === 0 ? (
        <div className="text-[10px] leading-snug text-slate-400">
          {stems?.length
            ? `None of the ${stems.map(stemFilingLabel).join(', ')} detectors can run on a section. Light another stem under Show per stem to pick from more.`
            : 'None of the registered detectors can run on a section yet.'}
        </div>
      ) : (
        <>
          <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <span className="shrink-0">Detector</span>
            <select
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={`${fieldCls} flex-1 min-w-0 truncate`}
            >
              {groupByDetectorOrigin([...usable, ...broken], (d) => d.is_default).map((group) => {
                // Runnable first, then the whole-song ones, then the broken, greyed.
                const runs = (d: CustomRegistryEntry) => d.status === 'ok' && !!d.windowable;
                const ordered = [
                  ...group.items.filter(runs),
                  ...group.items.filter((d) => d.status === 'ok' && !d.windowable),
                  ...group.items.filter((d) => d.status !== 'ok'),
                ];
                const options = ordered.map((d) => (
                  <option key={d.name} value={d.name} disabled={!runs(d)}>
                    {optionLabel(d, sharedLabels)}
                    {d.status !== 'ok' ? ' — failed to load' : d.windowable ? '' : ' — whole song only'}
                  </option>
                ));
                return group.title
                  ? <optgroup key={group.origin} label={group.title}>{options}</optgroup>
                  : options;
              })}
            </select>
          </label>
          {runParts && (
            <div className="text-[10px] leading-snug text-slate-400">
              Reads only <span className="text-slate-200">{runParts.join(', ')}</span> — the
              lane's other parts stay as they are, even on Replace.
            </div>
          )}
          {det?.strictness && (
            <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
              <span className="shrink-0">Strictness</span>
              <StrictnessPicker
                label={`${det.label || det.name} strictness for this section`}
                value={level}
                disabled={running || applying}
                onChange={setLevel}
              />
              {level !== laneLevel && (
                <span className="text-[10px] text-slate-500 truncate">the lane is {strictnessName(laneLevel)}</span>
              )}
            </div>
          )}
          <button
            className="w-full px-2 py-1 rounded bg-sky-600/70 hover:bg-sky-600 text-white text-[11px] uppercase tracking-wider disabled:opacity-40 disabled:hover:bg-sky-600/70"
            onClick={doRun}
            disabled={running || applying || !windowOk || !name || !slug}
          >
            {running ? 'Running…' : 'Run on this section'}
          </button>
        </>
      )}

      {error && <div className="text-[10px] text-red-400 whitespace-pre-wrap">{error}</div>}
      {done && <div className="text-[10px] text-emerald-400">{done}</div>}

      {run && preview && (
        <div className="space-y-2">
          <div className="text-[11px] text-slate-300">
            Found {preview.found} here · the lane has {preview.here} here now
          </div>
          {(run.notes ?? []).length > 0 && (
            <ul className="space-y-0.5 text-[10px] leading-snug text-slate-400 list-disc pl-3.5">
              {(run.notes ?? []).map((n) => <li key={n.code}>{n.message}</li>)}
            </ul>
          )}
          {run.errors.length > 0 && (
            <div className="text-[10px] text-amber-400">
              {run.errors.length} item{run.errors.length === 1 ? '' : 's'} rejected by validation.
            </div>
          )}
          {preview.found > 0 && (
            <div className="max-h-40 overflow-y-auto rounded border border-white/[0.06] divide-y divide-white/[0.04]">
              {runLanes(run, kind).flatMap((l) => l.items.map((it) => ({ l, it })))
                .sort((a, b) => primaryMs(a.it, a.l.kind) - primaryMs(b.it, b.l.kind))
                .map(({ l, it }, i) => {
                const t = primaryMs(it, l.kind) / 1000;
                return (
                  <button
                    key={`${l.id}:${i}:${t}`}
                    onClick={() => onSeek?.(t)}
                    title="Seek here"
                    className="w-full flex items-baseline gap-2 px-1.5 py-0.5 text-left text-[11px] hover:bg-white/[0.03]"
                  >
                    <span className="font-mono text-[10px] text-slate-500 shrink-0">{formatClockTime(t, 2)}</span>
                    {l.label && <span className="text-slate-500 shrink-0">{l.label}</span>}
                    <span className="text-slate-300 truncate">{it.label || (it as { text?: string }).text || '—'}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex items-stretch gap-1.5">
            <button
              className="flex-1 px-2 py-1 rounded bg-emerald-600/80 hover:bg-emerald-600 text-white text-[11px] disabled:opacity-40 disabled:hover:bg-emerald-600/80"
              onClick={() => apply('merge')}
              disabled={applying || preview.fresh === 0}
              title="Keep everything the lane has in this section and add only what it does not have yet"
            >
              {preview.fresh === 0 ? 'Merge — nothing new' : `Merge (+${preview.fresh} new)`}
            </button>
            <button
              className="flex-1 px-2 py-1 rounded border border-white/10 text-slate-200 hover:bg-white/5 text-[11px] disabled:opacity-40 disabled:hover:bg-transparent"
              onClick={() => apply('replace')}
              disabled={applying}
              title="Remove what the lane has in this section and put what this run found in its place"
            >
              Replace ({preview.here} → {preview.found})
            </button>
          </div>
        </div>
      )}

      {broken.length > 0 && (
        <div className="text-[10px] leading-snug text-amber-400/90 space-y-0.5">
          {broken.map((d) => (
            <div key={d.name}>
              <span className="text-amber-300">{d.label || d.name}</span> failed to load
              {d.errors[0] ? `: ${d.errors[0].message}` : ''}. If its code just changed,
              restart the custom-detector server.
            </div>
          ))}
        </div>
      )}
      {notOffered.length > 0 && (
        <div className="text-[10px] leading-snug text-slate-500">
          Whole song only: {[...new Set(notOffered.map((d) => d.label || d.name))].join(', ')} — they
          work from the whole song (most read its data from disk), so a section run
          would not stay inside the section.
        </div>
      )}
    </div>
  );
}
