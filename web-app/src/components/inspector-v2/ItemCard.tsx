/**
 * Shared horizontal-card shell used by SectionCard, CueItemCard, LoopItemCard.
 *
 * Each annotation type (boundary / cue / loop) renders one of these per item
 * in a flex-wrap row beneath the waveform. The shell owns the visual chrome —
 * fixed width, colored left border, hover/selection glow, optional insert-
 * between affordance — so the three editors stay visually in lockstep while
 * each one composes its own rows (type dropdown, snap buttons, halve/double,
 * candidate chips, …) inside the body.
 */

import type { ReactNode } from 'react';
import { CrosshairIcon } from './CrosshairIcon';

export interface ItemCardShellProps {
  index: number;
  color: string;
  /** Glow when the playhead is inside this item's range (boundary/loop only). */
  highlightCurrent?: boolean;
  /** Ring when this item is the focused/selected one in the editor. */
  isSelected?: boolean;
  onClick?: () => void;
  /** "+" affordance shown between this card and the next on hover. */
  onInsertAfter?: () => void;
  isLast?: boolean;
  /** Fixed card width. Default 108px (matches the original SectionCard). */
  width?: number;
  children: ReactNode;
}

/** Outer chrome — call with the variable rows as children. */
export function ItemCardShell({
  color,
  highlightCurrent = false,
  isSelected = false,
  onClick,
  onInsertAfter,
  isLast,
  width = 108,
  children,
}: ItemCardShellProps) {
  return (
    <div className="flex items-stretch gap-0.5 group">
      <div
        onClick={onClick}
        className={`flex flex-col rounded-r border border-l-0 bg-[#14171d] hover:bg-[#1b1f27] transition-all overflow-hidden ${onClick ? 'cursor-pointer' : ''}`}
        style={{
          width,
          borderLeft: `2px solid ${color}`,
          borderColor: isSelected
            ? `${color}cc`
            : highlightCurrent
              ? `${color}99`
              : 'rgba(255,255,255,0.06)',
          borderLeftColor: color,
          boxShadow: isSelected
            ? `0 0 0 1px ${color}aa, 0 0 12px 0 ${color}44`
            : highlightCurrent
              ? `0 0 0 1px ${color}55, 0 0 12px 0 ${color}33`
              : undefined,
        }}
      >
        {children}
      </div>

      {!isLast && onInsertAfter && (
        <button
          onClick={onInsertAfter}
          className="self-center w-3 flex-shrink-0 flex items-center justify-center text-[10px] text-slate-700 hover:text-violet-400 opacity-0 group-hover:opacity-100 transition-opacity duration-150"
          title="Insert item after this one"
        >+</button>
      )}
    </div>
  );
}

// ─── Reusable row sub-components ───────────────────────────────────────────

/** "#N + <slot>" row (slot is the type dropdown, layer dot, or just empty). */
export function ItemCardHeader({ index, children }: { index: number; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-1 px-1.5 pt-1 pb-0.5">
      <span className="text-[9px] font-mono shrink-0 text-slate-300">#{index + 1}</span>
      {children}
    </div>
  );
}

type ItemCardLabelInputProps =
  | {
      value: string;
      placeholder?: string;
      readOnly: true;
      onChange?: never;
      listId?: never;
    }
  | {
      value: string;
      placeholder?: string;
      readOnly?: false;
      onChange: (v: string) => void;
      listId?: string;
    };

/** Single-line label row. Editable input or readonly text depending on caller. */
export function ItemCardLabel(props: ItemCardLabelInputProps) {
  const { value, placeholder = 'label' } = props;
  if (props.readOnly) {
    return (
      <div className="mx-1.5 mb-1 px-1 py-0.5 bg-[#0a0b0d] border border-white/[0.06] text-slate-200 text-[10px] rounded truncate">
        {value || <span className="text-slate-400 italic">{placeholder}</span>}
      </div>
    );
  }
  return (
    <input
      value={value}
      onChange={(e) => props.onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      placeholder={placeholder}
      list={props.listId}
      spellCheck={false}
      className="mx-1.5 mb-1 px-1 py-0.5 bg-[#0a0b0d] border border-white/[0.06] text-slate-200 text-[10px] rounded focus:outline-none focus:ring-1 focus:ring-violet-500/40 truncate"
    />
  );
}

interface SnapTimeRowProps {
  time: number;
  fmt: (t: number) => string;
  onSnap?: () => void;
  snapTitle?: string;
  /** Optional badge (e.g. "8b" bar count) shown between time and snap. */
  badge?: ReactNode;
  /** Disable the snap button (e.g. last section's end is locked to duration). */
  snapDisabled?: boolean;
  /** Visual emphasis. "primary" = bright, "secondary" = muted (used for end-time). */
  variant?: 'primary' | 'secondary';
  /** Prefix character — boundary uses "–" before end times to mirror "0:20 → –0:20". */
  prefix?: string;
}

/** Time + (optional badge) + (optional snap-to-playhead button) row. */
export function SnapTimeRow({
  time, fmt, onSnap, snapTitle = 'Snap to playhead',
  badge, snapDisabled = false, variant = 'primary', prefix,
}: SnapTimeRowProps) {
  const timeClass = variant === 'primary'
    ? 'font-mono text-[10px] text-slate-300 flex-1 truncate'
    : 'font-mono text-[9px] text-slate-400 flex-1 truncate';
  return (
    <div className="flex items-center gap-1 px-1.5 pb-0.5">
      <span className={timeClass}>{prefix}{fmt(time)}</span>
      {badge}
      {onSnap && (
        <button
          onClick={(e) => { e.stopPropagation(); if (!snapDisabled) onSnap(); }}
          disabled={snapDisabled}
          className={`shrink-0 w-6 h-6 flex items-center justify-center rounded border transition-colors ${
            snapDisabled
              ? 'border-white/[0.04] text-slate-700 cursor-default'
              : 'border-amber-400/30 bg-amber-500/10 text-amber-300 hover:text-amber-200 hover:bg-amber-500/20 hover:border-amber-400/60'
          }`}
          title={snapDisabled ? 'Locked' : snapTitle}
        >
          <CrosshairIcon size={14} />
        </button>
      )}
    </div>
  );
}

interface CandidateChipsProps {
  candidates: number[];
  fmt: (t: number) => string;
  onRemove: (index: number) => void;
}

/** Wrap of alt-candidate chips (boundary + cue share this exact UI). */
export function CandidateChips({ candidates, fmt, onRemove }: CandidateChipsProps) {
  if (candidates.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-0.5 px-1.5 pb-1">
      {candidates.map((c, ci) => (
        <span key={ci} className="flex items-center gap-0.5 bg-[#0a0b0d] border border-white/[0.06] rounded px-1">
          <span className="text-[9px] font-mono text-violet-300">{fmt(c)}</span>
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(ci); }}
            className="text-slate-400 hover:text-red-400 text-[9px] transition-colors"
            title="Remove candidate"
          >✕</button>
        </span>
      ))}
    </div>
  );
}

/** Bottom action bar — wraps children in the dark border-top row. */
export function ItemCardActionRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-px px-1 pb-1 pt-0.5 border-t border-white/[0.04] mt-auto">
      {children}
    </div>
  );
}

interface IconButtonProps {
  onClick: () => void;
  title: string;
  children: ReactNode;
  /** Visual variant for state styling. */
  state?: 'idle' | 'active' | 'danger';
  /** When true, button stretches to fill remaining flex space (used for the
   *  "delete" button when the play button isn't rendered). */
  stretch?: boolean;
}

/** Shared icon-button styling used inside ItemCardActionRow. */
export function ItemCardIconButton({
  onClick, title, children, state = 'idle', stretch = false,
}: IconButtonProps) {
  const stateClass = state === 'active'
    ? 'bg-amber-500/15 border-amber-400/40 text-amber-300'
    : state === 'danger'
      ? 'bg-red-500/15 border-red-400/40 text-red-300'
      : 'border-white/[0.04] text-slate-300 hover:text-violet-300 tc-hover-reveal';
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={title}
      className={`${stretch ? 'flex-1' : 'w-6'} h-6 flex items-center justify-center rounded border text-[12px] transition-colors ${stateClass}`}
    >{children}</button>
  );
}

/** Trailing "+ Add" card. Used by every editor that hosts a card row. */
export function AddItemAtEndCard({
  onClick, label = '+ Add', width = 108,
}: { onClick: () => void; label?: string; width?: number }) {
  return (
    <button
      onClick={onClick}
      style={{ width }}
      className="self-stretch min-h-[80px] flex items-center justify-center text-[10px] uppercase tracking-wider text-slate-400 hover:text-violet-300 border border-dashed border-white/[0.08] hover:border-violet-500/40 hover:bg-white/[0.02] rounded transition-colors"
    >{label}</button>
  );
}
