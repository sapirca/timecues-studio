import type { ReactNode } from 'react';

/** Accent tier for an open step. Mirrors the grid-mode colour language used
 *  elsewhere in /prep: violet for the tempo/downbeat work, emerald for the
 *  metronome. */
export type StepAccent = 'violet' | 'emerald';

const ACCENT: Record<StepAccent, { card: string; badge: string; chevron: string }> = {
  violet: {
    card: 'border-violet-500/35 bg-violet-500/[0.05]',
    badge: 'border-violet-400/60 bg-violet-500/20 text-violet-100',
    chevron: 'text-violet-400',
  },
  emerald: {
    card: 'border-emerald-500/35 bg-emerald-500/[0.05]',
    badge: 'border-emerald-400/60 bg-emerald-500/20 text-emerald-50',
    chevron: 'text-emerald-400',
  },
};

const IDLE_CARD = 'border-white/[0.06] bg-white/[0.015]';
const IDLE_BADGE = 'border-white/[0.12] bg-white/[0.03] text-slate-400';
const DONE_BADGE = 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300';

export interface StepSectionProps {
  /** 1-based position, rendered in the badge until the step is done. */
  index: number;
  title: string;
  /** Marks the badge with a ✓ while the step is collapsed and satisfied. */
  done?: boolean;
  /** Right-aligned value shown while collapsed (e.g. `140 · 4/4`). */
  summary?: ReactNode;
  accent?: StepAccent;
  open: boolean;
  onToggle: () => void;
  /** Renders the row dimmed and inert — used before a BPM exists, when the
   *  downbeat / metronome steps have nothing to act on. */
  disabled?: boolean;
  /** Replaces the summary while disabled (e.g. "needs a tempo"). */
  disabledHint?: string;
  children: ReactNode;
}

/** One numbered step in the Song-setup panel. The body stays mounted when
 *  collapsed (just hidden) so draft input state and the metronome's audio
 *  scheduler survive folding the step away. */
export function StepSection({
  index,
  title,
  done = false,
  summary,
  accent = 'violet',
  open,
  onToggle,
  disabled = false,
  disabledHint,
  children,
}: StepSectionProps) {
  const tone = ACCENT[accent];
  const badgeClass = disabled || (!done && !open) ? IDLE_BADGE : open ? tone.badge : DONE_BADGE;

  return (
    <div className={`rounded-lg border transition-colors ${open && !disabled ? tone.card : IDLE_CARD} ${disabled ? 'opacity-45' : ''}`}>
      <button
        type="button"
        onClick={disabled ? undefined : onToggle}
        aria-expanded={open}
        disabled={disabled}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left rounded-lg transition-colors enabled:hover:bg-white/[0.02] disabled:cursor-default"
      >
        <span
          className={`shrink-0 w-5 h-5 rounded-full border inline-flex items-center justify-center font-mono text-[11px] font-semibold ${badgeClass}`}
          aria-hidden="true"
        >
          {done && !open ? '✓' : index}
        </span>
        <span className={`flex-1 min-w-0 text-sm font-semibold ${open && !disabled ? 'text-slate-50' : 'text-slate-200'}`}>
          {title}
        </span>
        {disabled ? (
          <span className="shrink-0 text-[11px] text-slate-500">{disabledHint}</span>
        ) : (
          <>
            {!open && summary != null && (
              <span className="shrink-0 font-mono text-xs text-slate-400 tabular-nums">{summary}</span>
            )}
            <span
              className={`shrink-0 text-xs leading-none transition-transform duration-150 ${open ? `rotate-90 ${tone.chevron}` : 'text-slate-600'}`}
              aria-hidden="true"
            >
              ▸
            </span>
          </>
        )}
      </button>
      <div className={open && !disabled ? 'px-3 pb-3.5 pt-0.5 space-y-3.5' : 'hidden'}>
        {children}
      </div>
    </div>
  );
}
