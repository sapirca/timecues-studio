import type { PatternItem } from '../../types/annotationLayer';
import {
  ItemCardShell,
  ItemCardHeader,
  ItemCardLabel,
  SnapTimeRow,
  ItemCardActionRow,
  ItemCardIconButton,
} from './ItemCard';

function fmtTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '0:00.0';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export interface PatternItemCardProps {
  index: number;
  pattern: PatternItem;
  color: string;
  duration: number;
  isSelected?: boolean;
  isPlaying?: boolean;
  onSelect: () => void;
  onChangeLabel: (label: string) => void;
  onSnapStart: () => void;
  onSnapEnd: () => void;
  onChangeRepeats: (n: number) => void;
  onPlay?: (start: number, end: number) => void;
  onStop?: () => void;
  onToggleImportance: () => void;
  onDelete: () => void;
  onInsertAfter?: () => void;
  isLast?: boolean;
}

/** Pattern card — same shell as Section/Cue/Loop. The sub-beat chip grid is
 *  *not* inside the card (it needs horizontal room that doesn't fit 108px);
 *  it's rendered below the card row when this card is the selected one. */
export function PatternItemCard({
  index, pattern, color, duration,
  isSelected = false, isPlaying = false,
  onSelect, onChangeLabel,
  onSnapStart, onSnapEnd, onChangeRepeats,
  onPlay, onStop, onToggleImportance, onDelete,
  onInsertAfter, isLast,
}: PatternItemCardProps) {
  const isCritical = pattern.importance !== 'optional';
  const cycle = Math.max(0, pattern.end - pattern.start);
  const reps = Math.max(1, Math.floor(pattern.repeatCount));
  const regionEnd = Math.min(
    duration > 0 ? duration : pattern.start + reps * cycle,
    pattern.start + reps * cycle,
  );
  const cycleBadge = (
    <span
      className="text-[9px] font-mono text-fuchsia-300/80 shrink-0"
      title="cycle duration in seconds"
    >
      {cycle.toFixed(2)}s
    </span>
  );

  return (
    <ItemCardShell
      index={index}
      color={color}
      isSelected={isSelected}
      onClick={onSelect}
      onInsertAfter={onInsertAfter}
      isLast={isLast}
    >
      <ItemCardHeader index={index} />

      <ItemCardLabel value={pattern.label} onChange={onChangeLabel} />

      <SnapTimeRow
        time={pattern.start}
        fmt={fmtTime}
        onSnap={onSnapStart}
        snapTitle="Snap start to playhead"
      />

      <SnapTimeRow
        time={pattern.end}
        fmt={fmtTime}
        onSnap={onSnapEnd}
        snapTitle="Snap end to playhead"
        prefix="–"
        variant="secondary"
        badge={cycleBadge}
      />

      {/* Repeats — clicking the input stops propagation so it doesn't fire
          card-select while the user is typing. */}
      <div className="flex items-center gap-1 px-1.5 pb-1">
        <span className="text-[9px] font-mono text-slate-500 shrink-0">×</span>
        <input
          type="number"
          min={1}
          max={256}
          value={reps}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            const n = Math.max(1, Math.min(256, Math.floor(Number(e.target.value) || 1)));
            onChangeRepeats(n);
          }}
          className="flex-1 min-w-0 bg-[#0a0b0d] border border-white/[0.06] rounded px-1 py-0 text-[10px] font-mono text-slate-200 focus:outline-none focus:ring-1 focus:ring-fuchsia-400/40"
          title={`Repeats × cycle = ${(reps * cycle).toFixed(2)}s (ends ${fmtTime(regionEnd)})`}
        />
      </div>

      <ItemCardActionRow>
        {onPlay && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (isPlaying) onStop?.();
              else onPlay(pattern.start, regionEnd);
            }}
            className={`flex-1 h-6 flex items-center justify-center rounded text-[12px] border transition-colors ${
              isPlaying
                ? 'bg-red-500/20 text-red-300 border-red-400/40'
                : 'bg-fuchsia-500/15 text-fuchsia-200 border-fuchsia-400/30 hover:bg-fuchsia-500/25'
            }`}
            title={isPlaying
              ? 'Stop playback'
              : `Play repeated region (${reps}× cycle = ${(reps * cycle).toFixed(2)}s)`}
          >{isPlaying ? '⏹' : '▶'}</button>
        )}
        <ItemCardIconButton
          onClick={onToggleImportance}
          title={isCritical ? 'Mark optional' : 'Mark critical'}
          state={isCritical ? 'active' : 'idle'}
        >{isCritical ? '★' : '☆'}</ItemCardIconButton>
        <ItemCardIconButton
          onClick={onDelete}
          title="Delete pattern"
          stretch={!onPlay}
        >✕</ItemCardIconButton>
      </ItemCardActionRow>
    </ItemCardShell>
  );
}
