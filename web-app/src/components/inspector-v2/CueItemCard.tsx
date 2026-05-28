import type { CueItem } from '../../types/annotationLayer';
import {
  ItemCardShell,
  ItemCardHeader,
  ItemCardLabel,
  SnapTimeRow,
  CandidateChips,
  ItemCardActionRow,
  ItemCardIconButton,
} from './ItemCard';

function fmtTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '0:00.0';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export interface CueItemCardProps {
  index: number;
  cue: CueItem;
  /** Layer accent color — left border + chips. */
  color: string;
  /** Ring + glow when the cue is the focused-in-editor one. */
  isSelected?: boolean;
  /** Selection click — focus this cue. */
  onSelect: () => void;
  onSnap: () => void;
  onChangeLabel: (label: string) => void;
  onToggleImportance: () => void;
  onAddCandidate: () => void;
  onRemoveCandidate: (ci: number) => void;
  onPlay?: () => void;
  onDelete: () => void;
  /** Insert-after affordance — opens a fresh cue with playhead time. */
  onInsertAfter?: () => void;
  isLast?: boolean;
  /** Optional datalist id for label autocomplete (cue taxonomy). */
  labelTaxonomyId?: string;
}

/** Cue card — same shell as SectionCard, no end time, no type dropdown. */
export function CueItemCard({
  index, cue, color, isSelected = false, onSelect,
  onSnap, onChangeLabel, onToggleImportance,
  onAddCandidate, onRemoveCandidate,
  onPlay, onDelete, onInsertAfter, isLast,
  labelTaxonomyId,
}: CueItemCardProps) {
  const isCritical = cue.importance !== 'optional';
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
        value={cue.label}
        onChange={onChangeLabel}
        listId={labelTaxonomyId}
      />

      <SnapTimeRow
        time={cue.time}
        fmt={fmtTime}
        onSnap={onSnap}
        snapTitle="Snap to playhead"
      />

      <CandidateChips
        candidates={cue.candidates ?? []}
        fmt={fmtTime}
        onRemove={onRemoveCandidate}
      />

      <ItemCardActionRow>
        {onPlay && (
          <button
            onClick={(e) => { e.stopPropagation(); onPlay(); }}
            className="flex-1 h-6 flex items-center justify-center rounded text-[12px] border bg-[#0a0b0d] border-white/[0.06] text-emerald-400 hover:border-emerald-400/40 transition-colors"
            title="Play from here"
          >▶</button>
        )}
        <ItemCardIconButton
          onClick={onToggleImportance}
          title={isCritical ? 'Mark optional' : 'Mark critical'}
          state={isCritical ? 'active' : 'idle'}
        >{isCritical ? '★' : '☆'}</ItemCardIconButton>
        <ItemCardIconButton
          onClick={onAddCandidate}
          title="Add alt time at playhead"
        >+</ItemCardIconButton>
        <ItemCardIconButton
          onClick={onDelete}
          title="Delete cue"
          stretch={!onPlay}
        >✕</ItemCardIconButton>
      </ItemCardActionRow>
    </ItemCardShell>
  );
}
