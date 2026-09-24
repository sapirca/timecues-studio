import type { SpanItem } from '../../types/annotationLayer';
import { formatClockTime as fmtTime } from '../../utils/clockTime';
import { isEnergySpan } from '../../utils/energySpan';
import { ProminenceBadge } from './shared/ProminenceControl';
import { PulseBadge } from './shared/PulseControl';
import {
  ItemCardShell,
  ItemCardHeader,
  ItemCardLabel,
  SnapTimeRow,
  ItemCardActionRow,
  ItemCardIconButton,
} from './ItemCard';

export interface SpanItemCardProps {
  index: number;
  span: SpanItem;
  color: string;
  isSelected?: boolean;
  onSelect: () => void;
  onChangeLabel: (label: string) => void;
  onSnapStart: () => void;
  onSnapEnd: () => void;
  onToggleImportance: () => void;
  onPlay?: () => void;
  onDelete: () => void;
  onInsertAfter?: () => void;
  isLast?: boolean;
  /** Optional datalist id for label autocomplete (span taxonomy). */
  labelTaxonomyId?: string;
  /** Override time formatter — used in Grid Lock to show bar·beat instead of mm:ss. */
  fmt?: (t: number) => string;
}

/** Span card — same shell as SectionCard with start + end times, duration
 *  chip, and a label input. */
export function SpanItemCard({
  index, span, color, isSelected = false, onSelect,
  onChangeLabel, onSnapStart, onSnapEnd, onToggleImportance,
  onPlay, onDelete, onInsertAfter, isLast,
  labelTaxonomyId, fmt: fmtOverride,
}: SpanItemCardProps) {
  const fmt = fmtOverride ?? fmtTime;
  const isCritical = span.importance !== 'optional';
  const duration = Math.max(0, span.end - span.start);
  const durationBadge = (
    <span
      className="text-[9px] font-mono text-emerald-300/80 shrink-0"
      title="span duration in seconds"
    >
      {duration.toFixed(2)}s
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

      <ItemCardLabel
        value={span.label}
        onChange={onChangeLabel}
        listId={labelTaxonomyId}
      />

      <div className="flex flex-wrap items-center gap-1">
        <ProminenceBadge points={span.prominence} color={color} />
        {/* An ⚡ Energy span is never offered a pulse in its card, so it never
          * shows one here either — see SpanEditPopover. */}
        {!isEnergySpan(span.description) && <PulseBadge rate={span.pulse} color={color} />}
      </div>

      <SnapTimeRow
        time={span.start}
        fmt={fmt}
        onSnap={onSnapStart}
        snapTitle="Snap start to playhead"
      />

      <SnapTimeRow
        time={span.end}
        fmt={fmt}
        onSnap={onSnapEnd}
        snapTitle="Snap end to playhead"
        prefix="–"
        variant="secondary"
        badge={durationBadge}
      />

      <ItemCardActionRow>
        {onPlay && (
          <button
            onClick={(e) => { e.stopPropagation(); onPlay(); }}
            className="flex-1 h-6 flex items-center justify-center rounded text-[12px] border bg-[#0a0b0d] border-white/[0.06] text-emerald-400 hover:border-emerald-400/40 transition-colors"
            title="Play this span"
          >▶</button>
        )}
        <ItemCardIconButton
          onClick={onToggleImportance}
          title={isCritical ? 'Mark optional' : 'Mark critical'}
          state={isCritical ? 'active' : 'idle'}
        >{isCritical ? '★' : '☆'}</ItemCardIconButton>
        <ItemCardIconButton
          onClick={onDelete}
          title="Delete span"
          stretch={!onPlay}
        >✕</ItemCardIconButton>
      </ItemCardActionRow>
    </ItemCardShell>
  );
}
