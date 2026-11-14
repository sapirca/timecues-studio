import type { AnnotationLayer } from '../../types/annotationLayer';
import type { EnvelopeLayerType, EnvelopeSource } from '../../utils/soundEnvelopes';
import { AdsrSourceButtons } from './shared/AdsrControl';
import { MENU_DIVIDER, MENU_HEADING, MENU_ROW } from './laneMenuStyle';

/** What a lane's items can be snapped to: the nearest beat, or the nearest
 *  downbeat (bar line) of the song's grid. */
export type LaneSnapUnit = 'beat' | 'bar';

/** What the page does for those items — each one document edit, so ⌘Z. */
export interface UserLaneOps {
  duplicate: (layer: AnnotationLayer) => void;
  copyRegion: (layer: AnnotationLayer, lo: number, hi: number) => void;
  split: (layer: AnnotationLayer) => void;
  setLocked: (layer: AnnotationLayer, locked: boolean) => void;
  mergeTargets: (layer: AnnotationLayer) => { id: string; name: string; color: string }[];
  merge: (layer: AnnotationLayer, targetId: string) => void;
  /** Null when the song has no tempo, so there is no grid to land on. */
  snap: {
    count: (layer: AnnotationLayer, unit: LaneSnapUnit) => number;
    run: (layer: AnnotationLayer, unit: LaneSnapUnit) => void;
  } | null;
  /** Extract ADSR: give a span or lyrics lane's items their envelopes. */
  extractAdsr: (layer: AnnotationLayer<EnvelopeLayerType>, source: EnvelopeSource) => void;
  /** What a lane can be read off: the mix and the song's stems. */
  adsrSources: readonly EnvelopeSource[];
}

/** The ⋮ menu items only a lane of yours has — the actions that make new
 *  lanes out of it, fold it into another, or freeze it. Detector lanes are
 *  re-derived each render, so they get none of these (their copy is ⬇). */
export interface UserLaneActions {
  locked: boolean;
  toggleLock: () => void;
  duplicate: () => void;
  /** Present while a region is highlighted and some of the lane's items sound
   *  inside it. */
  region: { label: string; count: number; copy: () => void } | null;
  /** Present when the lane holds two or more kinds and can be split. */
  split: { kinds: string[]; run: () => void } | null;
  mergeTargets: { id: string; name: string; color: string }[];
  mergeInto: (targetId: string) => void;
  /** Present on a lane whose items are plain times (boundaries, cues, spans,
   *  loops). `count` is how many would move — asked only while the menu is
   *  open, since it walks every item; `why` says why none can. */
  snap: { count: (unit: LaneSnapUnit) => number; run: (unit: LaneSnapUnit) => void; why?: string } | null;
  /** Present on a span or lyrics lane of yours with timed items. `measured`
   *  once any item carries an envelope (the row reads Re-extract); `running`
   *  while a measurement is out. */
  extractAdsr: { run: (source: EnvelopeSource) => void; sources: readonly EnvelopeSource[]; measured: boolean; running: boolean } | null;
}

const DIVIDER = <div className={MENU_DIVIDER} />;

const SNAP_WORDS: Record<LaneSnapUnit, { label: string; on: string; target: string }> = {
  beat: { label: 'Snap to beats', on: 'on beat', target: 'the nearest beat' },
  bar: { label: 'Snap to bars', on: 'on bar', target: 'the nearest bar line' },
};

/** One "Snap to …" row — the same row for beats and for bars. */
function SnapItem({ name, unit, snap, onDone }: {
  name: string;
  unit: LaneSnapUnit;
  snap: NonNullable<UserLaneActions['snap']>;
  onDone: () => void;
}) {
  const words = SNAP_WORDS[unit];
  const count = snap.why ? 0 : snap.count(unit);
  return (
    <button
      type="button"
      disabled={count === 0}
      onClick={() => { snap.run(unit); onDone(); }}
      title={snap.why
        ?? (count === 0
          ? `Every item of "${name}" already sits ${words.on}.`
          : `Move the ${count} item${count === 1 ? '' : 's'} of "${name}" that sit off it onto ${words.target}. A span or loop that would shrink to nothing stays as it is. ⌘Z undoes it.`)}
      className={`${MENU_ROW} disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent`}
    >
      <span className="flex-1">{words.label}</span>
      <span className="text-[10px] text-slate-500 tabular-nums">
        {snap.why ? 'no BPM' : count === 0 ? words.on : count}
      </span>
    </button>
  );
}

/** Small padlock, drawn rather than an emoji so it takes the lane's colour. */
export function LockGlyph({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden className={className} fill="currentColor">
      <path d="M3.5 5V3.75a2.5 2.5 0 0 1 5 0V5h.5a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h.5Zm1.25 0h2.5V3.75a1.25 1.25 0 0 0-2.5 0V5Z" />
    </svg>
  );
}

export function UserLaneMenuItems({ name, actions, onDone }: {
  name: string;
  actions: UserLaneActions;
  onDone: () => void;
}) {
  const { locked, region, split, mergeTargets, snap, extractAdsr } = actions;
  const act = (run: () => void) => () => { run(); onDone(); };
  return (
    <>
      <button
        type="button"
        onClick={act(actions.duplicate)}
        title={`Copy every item of "${name}" to a new lane right below it. ⌘Z undoes it.`}
        className={MENU_ROW}
      >
        Duplicate
      </button>
      {region && (
        <button
          type="button"
          onClick={act(region.copy)}
          title={`Copy the ${region.count} item${region.count === 1 ? '' : 's'} that sound in the highlighted region to a new lane right below. Items crossing its edges come whole.`}
          className={MENU_ROW}
        >
          <span className="flex-1">Copy {region.label} to a new lane</span>
          <span className="text-[10px] text-slate-500 tabular-nums">{region.count}</span>
        </button>
      )}
      {split && (
        <button
          type="button"
          onClick={act(split.run)}
          title={`Replace this lane with ${split.kinds.length} lanes, one per kind: ${split.kinds.join(', ')}. ⌘Z puts it back.`}
          className={MENU_ROW}
        >
          <span className="flex-1">Split by kind</span>
          <span className="text-[10px] text-slate-500 tabular-nums">{split.kinds.length} lanes</span>
        </button>
      )}
      {extractAdsr && (
        <div
          className="px-2 py-1.5 space-y-1"
          title={locked ? 'Unlock this lane to extract its envelopes.' : `Give every item of "${name}" its envelope — attack, decay, sustain and release — read off the source you press, and drawn behind it. Retiming an item later reads it again.`}
        >
          <div className="flex items-center text-[11px] text-slate-300">
            <span className="flex-1">{extractAdsr.measured ? 'Re-extract ADSR from' : 'Extract ADSR from'}</span>
            {extractAdsr.running && <span className="text-[10px] text-slate-500">extracting…</span>}
          </div>
          <AdsrSourceButtons
            sources={extractAdsr.sources}
            onPick={(source) => { extractAdsr.run(source); onDone(); }}
            disabled={extractAdsr.running || locked}
            what={`every item of "${name}"`}
          />
        </div>
      )}
      {snap && (<>
        <SnapItem name={name} unit="beat" snap={snap} onDone={onDone} />
        <SnapItem name={name} unit="bar" snap={snap} onDone={onDone} />
      </>)}
      <button
        type="button"
        onClick={act(actions.toggleLock)}
        title={locked
          ? 'Let this lane be edited again.'
          : 'Stop every edit to this lane\'s items — drags, adds, deletes, moves from other lanes — until you unlock it. Name, colour and group stay editable.'}
        className={MENU_ROW}
      >
        <LockGlyph className="w-3 h-3 shrink-0 opacity-80" />
        <span className="flex-1">{locked ? 'Unlock' : 'Lock'}</span>
      </button>
      {mergeTargets.length > 0 && (
        <>
          {DIVIDER}
          <div className={MENU_HEADING}>Merge into</div>
          {mergeTargets.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={act(() => actions.mergeInto(t.id))}
              title={`Move every item of "${name}" into "${t.name}" and remove "${name}". ⌘Z undoes it.`}
              className={MENU_ROW}
            >
              <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ background: t.color }} />
              <span className="flex-1 truncate">{t.name}</span>
            </button>
          ))}
        </>
      )}
    </>
  );
}
