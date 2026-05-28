import type { LoopItem } from '../../types/annotationLayer';
import { intervalBars, type BarGrid } from '../../utils/barSnap';
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

export interface LoopItemCardProps {
  index: number;
  loop: LoopItem;
  color: string;
  isSelected?: boolean;
  /** Highlighted when this loop is the one currently playing. */
  isPlaying?: boolean;
  grid: Partial<BarGrid> | null;
  onSelect: () => void;
  onChangeLabel: (label: string) => void;
  onSnapStart: () => void;
  onSnapEnd: () => void;
  /** DJ-style halve / double of loop length (factor 0.5 or 2). */
  onResize: (factor: number) => void;
  onToggleImportance: () => void;
  onPlay: () => void;
  onStop: () => void;
  onDelete: () => void;
  onInsertAfter?: () => void;
  isLast?: boolean;
}

/** Loop card — same shell as SectionCard, with start + end times, halve/double,
 *  bar-length badge, and loop-play. */
export function LoopItemCard({
  index, loop, color, isSelected = false, isPlaying = false,
  grid, onSelect, onChangeLabel,
  onSnapStart, onSnapEnd, onResize, onToggleImportance,
  onPlay, onStop, onDelete, onInsertAfter, isLast,
}: LoopItemCardProps) {
  const isCritical = loop.importance !== 'optional';
  const bars = intervalBars(loop.start, loop.end, grid ?? null);
  const barsBadge = bars !== null
    ? (
      <span
        className="text-[9px] font-mono text-fuchsia-300/80 shrink-0"
        title="loop length in bars"
      >
        {bars.toFixed(bars >= 1 ? 1 : 2)}b
      </span>
    )
    : null;

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

      <ItemCardLabel value={loop.label} onChange={onChangeLabel} />

      <SnapTimeRow
        time={loop.start}
        fmt={fmtTime}
        onSnap={onSnapStart}
        snapTitle="Set start to playhead (snaps to nearest beat when Snap-to-grid is on)"
      />

      <SnapTimeRow
        time={loop.end}
        fmt={fmtTime}
        onSnap={onSnapEnd}
        snapTitle="Set end to playhead (snaps to nearest beat when Snap-to-grid is on)"
        prefix="–"
        variant="secondary"
        badge={barsBadge}
      />

      {/* DJ-style halve / double — bar-snap inherent so kept regardless of
          the global toggle. */}
      <div className="flex items-center gap-0.5 px-1.5 pb-1">
        <button
          onClick={(e) => { e.stopPropagation(); onResize(0.5); }}
          className="flex-1 h-5 flex items-center justify-center rounded border border-fuchsia-400/30 bg-fuchsia-500/10 text-fuchsia-200 hover:text-fuchsia-100 hover:bg-fuchsia-500/20 hover:border-fuchsia-400/60 text-[10px] font-mono leading-none"
          title="Halve loop length — DJ ÷2, anchored at start (,)"
        >÷2</button>
        <button
          onClick={(e) => { e.stopPropagation(); onResize(2); }}
          className="flex-1 h-5 flex items-center justify-center rounded border border-fuchsia-400/30 bg-fuchsia-500/10 text-fuchsia-200 hover:text-fuchsia-100 hover:bg-fuchsia-500/20 hover:border-fuchsia-400/60 text-[10px] font-mono leading-none"
          title="Double loop length — DJ ×2, anchored at start (.)"
        >×2</button>
      </div>

      <ItemCardActionRow>
        <button
          onClick={(e) => { e.stopPropagation(); isPlaying ? onStop() : onPlay(); }}
          className={`flex-1 h-6 flex items-center justify-center rounded text-[12px] border transition-colors ${
            isPlaying
              ? 'bg-red-500/20 text-red-300 border-red-400/40'
              : 'bg-fuchsia-500/15 text-fuchsia-200 border-fuchsia-400/30 hover:bg-fuchsia-500/25'
          }`}
          title={isPlaying ? 'Stop looping (P)' : 'Loop-play this interval seamlessly (P)'}
        >{isPlaying ? '⏹' : '↻'}</button>
        <ItemCardIconButton
          onClick={onToggleImportance}
          title={isCritical ? 'Mark optional' : 'Mark critical'}
          state={isCritical ? 'active' : 'idle'}
        >{isCritical ? '★' : '☆'}</ItemCardIconButton>
        <ItemCardIconButton onClick={onDelete} title="Delete loop">✕</ItemCardIconButton>
      </ItemCardActionRow>
    </ItemCardShell>
  );
}
