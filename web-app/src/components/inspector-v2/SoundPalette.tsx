/**
 * The sound palette, drawn — one row per repeating sound: ▶ to hear one turn
 * of it, the turn itself between repeat signs, how long that turn is, and
 * where in the song it plays. The same view in the Annotator Tool (the user's
 * riff layers) and in Algorithm Inspect (what the detectors found); the
 * caller decides which, see paletteModel.ts.
 */

import { useState, type ReactNode } from 'react';
import { PlayheadWithin } from '../Playhead';
import { PitchRollStrip } from './PitchedRiffEditor';
import { LoopLength, RepeatSign } from './LoopNotation';
import { familyRuns, type PaletteFigure, type PaletteGroup, type PaletteRun, type PaletteSection } from './paletteModel';

/** The palette's columns — name, one turn, length, song timeline. Exported so
 *  a list beside it (the Riff Patterns instances) can line its timeline up. */
export const PALETTE_COLS = 'grid grid-cols-[minmax(0,220px)_minmax(0,240px)_96px_minmax(0,1fr)] gap-x-4 items-center';

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function StripView({ figure }: { figure: PaletteFigure }) {
  const { strip, color } = figure;
  // The strip's width says how long the turn is: a 4-bar loop fills the
  // column, a 1-bar loop a quarter of it, so lengths compare at a glance.
  const widthPct = Math.min(100, Math.max(25, (figure.lengthBeats / 16) * 100));
  return (
    <div className="flex items-stretch gap-1.5" title="One turn of the loop — it repeats between these signs">
      <RepeatSign side="start" color={color} dot={2} />
      <div className="min-w-0 flex items-center" style={{ width: `${widthPct}%`, height: 16 }}>
        <PitchRollStrip color={color} segments={strip.segments} lengthBeats={strip.lengthBeats} />
      </div>
      <RepeatSign side="end" color={color} dot={2} />
    </div>
  );
}

function PlayButton({ label, playing, disabled, onClick }: {
  label: string; playing: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex-none w-7 h-7 rounded-full border inline-flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
        playing ? 'border-amber-400 bg-amber-400/20 text-amber-100' : 'border-white/20 bg-white/[0.04] text-slate-100 hover:border-white/40'
      }`}
    >
      <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
        {playing
          ? <rect x="2" y="2" width="8" height="8" rx="1" fill="currentColor" />
          : <path d="M3.5 1.5 L10.5 6 L3.5 10.5 Z" fill="currentColor" />}
      </svg>
    </button>
  );
}

interface PlayCtx {
  isPlaying: boolean;
  lastId: string | null;
  play: (id: string, start: number, end: number) => void;
  stop: () => void;
}

function RunsTimeline({ figure, runs, duration, ctx }: { figure: PaletteFigure; runs: PaletteRun[]; duration: number; ctx: PlayCtx }) {
  const pct = (t: number) => `${Math.max(0, Math.min(100, (100 * t) / Math.max(1e-6, duration)))}%`;
  return (
    <div className="relative h-5 rounded-sm bg-white/[0.025]">
      {runs.map((run: PaletteRun, i) => (
        <button
          key={i}
          type="button"
          onClick={() => ctx.play(`${figure.id}#run${i}`, run.start, run.end)}
          title={`${run.variant ? `${run.variant} · ` : ''}${fmtTime(run.start)} · ×${run.reps} — play the whole run`}
          aria-label={`Play ${run.variant ?? figure.name} from ${fmtTime(run.start)}, all ${run.reps} turns`}
          className="absolute top-[3px] bottom-[3px] rounded-sm overflow-hidden flex hover:brightness-125"
          // A variant's run: the same figure played a little differently —
          // outlined and lighter, so the row still shows every place it plays.
          style={{
            left: pct(run.start), width: pct(run.end - run.start), minWidth: 3,
            background: run.variant ? `${figure.color}26` : `${figure.color}4d`,
            boxShadow: run.variant ? `inset 0 0 0 1px ${figure.color}99` : undefined,
          }}
        >
          {!run.variant && <span
            className="absolute top-0 bottom-0"
            style={{
              left: `${(100 * (run.firstTurn.start - run.start)) / Math.max(1e-6, run.end - run.start)}%`,
              width: `${(100 * (run.firstTurn.end - run.firstTurn.start)) / Math.max(1e-6, run.end - run.start)}%`,
              background: figure.color,
            }}
          />}
        </button>
      ))}
    </div>
  );
}

function FigureRow({ figure, beatsPerBar, duration, ctx, indent = false, toggle, actions, placement = true }: {
  figure: PaletteFigure;
  beatsPerBar: number;
  duration: number;
  ctx: PlayCtx;
  indent?: boolean;
  toggle?: { open: boolean; onToggle: () => void };
  /** Buttons at the end of the name cell — the Annotator's edit / delete. */
  actions?: ReactNode;
  /** Whether the row says where the figure plays (×N and the timeline). */
  placement?: boolean;
}) {
  const first = figure.runs[0]?.firstTurn;
  const turnEnd = first?.end ?? 0;
  // A figure with its variants folded: its row shows the whole family, so
  // the count and the timeline say everywhere it plays.
  const runs = toggle ? familyRuns(figure) : figure.runs;
  const reps = runs.reduce((n, r) => n + r.reps, 0);
  const variantReps = reps - figure.runs.reduce((n, r) => n + r.reps, 0);
  return (
    <div className={`${PALETTE_COLS} min-h-[40px] px-2 py-1 rounded ${indent ? '' : 'bg-white/[0.03]'}`}>
      <div className={`flex items-center gap-2 min-w-0 ${indent ? 'pl-5' : ''}`}>
        <PlayheadWithin start={first?.start ?? 0} end={turnEnd} active={ctx.isPlaying && ctx.lastId === figure.id}>
          {(inside) => (
            <PlayButton
              label={!first ? `${figure.name} is not placed in the song` : inside ? `Stop ${figure.name}` : `Play one turn of ${figure.name}`}
              playing={inside}
              disabled={!first}
              onClick={() => (inside ? ctx.stop() : first && ctx.play(figure.id, first.start, turnEnd))}
            />
          )}
        </PlayheadWithin>
        <span className={`truncate ${indent ? 'text-[12px] text-slate-300' : 'text-[13px] font-medium text-slate-100'}`} title={figure.name}>
          {figure.name}
        </span>
        {toggle && (
          <button
            type="button"
            onClick={toggle.onToggle}
            aria-expanded={toggle.open}
            className="flex-none text-[11px] px-1.5 py-0.5 rounded border border-white/15 text-slate-300 hover:border-white/30"
          >
            {toggle.open ? '▾' : '▸'} {figure.variants.length} variant{figure.variants.length === 1 ? '' : 's'}
          </button>
        )}
        {actions && <span className="ml-auto flex-none flex items-center gap-1">{actions}</span>}
      </div>
      <div className="flex flex-col gap-1 min-w-0">
        <StripView figure={figure} />
        {figure.pitch && <span className="text-[11px] font-mono text-slate-400 pl-3">{figure.pitch}</span>}
      </div>
      <div className="text-[12px] text-slate-300 flex flex-col">
        <LoopLength beats={figure.lengthBeats} beatsPerBar={beatsPerBar} />
        {placement && reps > 0 && (
          <span className="text-[11px] text-slate-500" title={variantReps > 0 ? `${variantReps} of them as a variant` : undefined}>
            ×{reps}{variantReps > 0 ? ` (${variantReps} varied)` : ''}
          </span>
        )}
      </div>
      {!placement
        ? <span />
        : runs.length > 0
          ? <RunsTimeline figure={figure} runs={runs} duration={duration} ctx={ctx} />
          : <span className="text-[11px] text-slate-500">not placed in the song</span>}
    </div>
  );
}

const SECTION_TITLES: Record<PaletteSection, { title: string; hint: string }> = {
  kit: { title: 'Whole drum kit', hint: 'all the drums read together, bar by bar' },
  drum: { title: 'Single drums', hint: 'each drum read on its own' },
  pitched: { title: 'Pitched parts', hint: 'bass, riffs and synths' },
};

/** The song's minutes, as the header of a timeline column. */
export function SongRuler({ duration }: { duration: number }) {
  const ticks = duration > 0
    ? Array.from({ length: Math.floor(duration / 60) + 1 }, (_, i) => i * 60)
    : [];
  return (
    <div className="relative h-4 normal-case tracking-normal font-mono">
      {ticks.map((t) => (
        <span key={t} className="absolute" style={{ left: `${(100 * t) / duration}%` }}>{t / 60}:00</span>
      ))}
    </div>
  );
}

export function SoundPalette({
  groups, duration, beatsPerBar, isPlaying, onPlay, onStop, emptyText, title, compact = false, rowActions,
  placement = true,
}: {
  groups: PaletteGroup[];
  duration: number;
  beatsPerBar: number;
  isPlaying: boolean;
  onPlay: (start: number, end: number) => void;
  onStop: () => void;
  emptyText: string;
  title: string;
  /** Inside another panel that already names what is listed: no title line
   *  and no group header over a single group. */
  compact?: boolean;
  rowActions?: (figure: PaletteFigure) => ReactNode;
  /** False where the figures are patterns only and their placements are
   *  listed elsewhere (the Annotator's instances): no ×N, no timeline. */
  placement?: boolean;
}) {
  const [lastId, setLastId] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const ctx: PlayCtx = {
    isPlaying,
    lastId,
    play: (id, start, end) => { setLastId(id); onPlay(start, end); },
    stop: onStop,
  };

  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      {!compact && (
        <div className="flex items-baseline gap-3">
          <h3 className="text-[13px] font-semibold text-slate-100">{title}</h3>
          <span className="text-[11px] text-slate-500">shortest loop first · ▶ plays one turn · click a run to hear all of it</span>
        </div>
      )}
      {groups.length === 0 ? (
        <p className="text-[12px] text-slate-400 px-2 py-4 rounded border border-dashed border-white/10">{emptyText}</p>
      ) : (
        <>
          <div className={`${PALETTE_COLS} px-2 pb-1 border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500`}>
            <span>Sound</span>
            <span>One turn</span>
            <span>Length</span>
            {placement ? <SongRuler duration={duration} /> : <span />}
          </div>
          {groups.map((g, gi) => (
            <div key={g.id} className="flex flex-col gap-1">
              {/* A new section starts where the group's section changes. */}
              {g.section && g.section !== groups[gi - 1]?.section && (
                <div className={`flex items-baseline gap-3 px-2 ${gi > 0 ? 'mt-5 pt-3 border-t border-white/10' : 'mt-2'}`}>
                  <h4 className="text-[15px] font-semibold text-slate-100">{SECTION_TITLES[g.section].title}</h4>
                  <span className="text-[12px] text-slate-500">{SECTION_TITLES[g.section].hint}</span>
                </div>
              )}
              {!(compact && groups.length === 1) && (
                <div className="flex items-center gap-2 px-2 pt-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: g.color }}>
                  <span className="w-2 h-2 rounded-sm" style={{ background: g.color }} />
                  {g.name}
                </div>
              )}
              {g.figures.map((f) => {
                const isOpen = open.has(f.id);
                return (
                  <div key={f.id} className="flex flex-col gap-0.5">
                    <FigureRow
                      figure={f}
                      beatsPerBar={beatsPerBar}
                      duration={duration}
                      ctx={ctx}
                      actions={rowActions?.(f)}
                      placement={placement}
                      toggle={f.variants.length > 0 ? {
                        open: isOpen,
                        onToggle: () => setOpen((prev) => {
                          const next = new Set(prev);
                          if (next.has(f.id)) next.delete(f.id); else next.add(f.id);
                          return next;
                        }),
                      } : undefined}
                    />
                    {isOpen && f.variants.map((v) => (
                      <FigureRow key={v.id} figure={v} beatsPerBar={beatsPerBar} duration={duration} ctx={ctx} indent placement={placement} />
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
