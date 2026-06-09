import type { ManualSection } from '../../types/manualAnnotation';
import { useSettings } from '../../context/SettingsContext';
import { fmtTime, sectionColor, getSectionTypes } from './sectionConstants';
import {
  ItemCardShell,
  ItemCardHeader,
  ItemCardLabel,
  SnapTimeRow,
  CandidateChips,
  ItemCardActionRow,
  ItemCardIconButton,
  AddItemAtEndCard as SharedAddCard,
} from './ItemCard';

export interface SectionCardProps {
  index: number;
  section: ManualSection;
  endTime: number;
  isLast: boolean;
  /** Light up the card when the playhead is inside this section (Manual only). */
  highlightCurrent?: boolean;
  /** When set, render a "bars-to-next" chip on the end-time row. */
  activeBpm?: number;

  // Snap-to-playhead handlers
  onSnapStart: () => void;
  onSnapEnd: () => void;

  // Action handlers
  onSplit: () => void;
  onTypeChange: (type: string) => void;
  /** Edit the section label inline. When omitted, the label is read-only. */
  onLabelChange?: (label: string) => void;
  onToggleImportance: () => void;
  onAddCandidate: () => void;
  onRemoveCandidate: (ci: number) => void;
  onDelete: () => void;

  // Optional: play/stop section. When omitted, the play button is hidden
  // and the delete button stretches to fill the row.
  onPlay?: () => void;
  onStop?: () => void;
  isPlaying?: boolean;

  // Optional: insert-between affordance shown to the right of the card.
  // Hidden when isLast is true or this prop is missing.
  onInsertAfter?: () => void;
}

/**
 * Visualization-free section card used by both Manual and Eye editors.
 * Behavior is identical except play/stop is opt-in (Manual passes it; Eye doesn't,
 * since by-eye annotation is purely visual).
 */
export function SectionCard({
  index, section, endTime, isLast,
  highlightCurrent = false,
  activeBpm,
  onSnapStart, onSnapEnd,
  onSplit, onTypeChange, onLabelChange, onToggleImportance, onAddCandidate, onRemoveCandidate, onDelete,
  onPlay, onStop, isPlaying = false,
  onInsertAfter,
}: SectionCardProps) {
  const { settings } = useSettings();
  const sectionTypes = getSectionTypes(settings.sectionTypeVocabulary);
  const color = sectionColor(section.type);
  const isCritical = section.importance !== 'optional';
  const barsToNext = activeBpm
    ? Math.round(((endTime - section.time) / ((60 / activeBpm) * 4)) * 2) / 2
    : null;
  const showPlay = !!onPlay;

  return (
    <ItemCardShell
      index={index}
      color={color}
      highlightCurrent={highlightCurrent}
      onInsertAfter={onInsertAfter}
      isLast={isLast}
    >
      <ItemCardHeader index={index}>
        <select
          value={section.type}
          onChange={(e) => { e.stopPropagation(); onTypeChange(e.target.value); }}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 min-w-0 truncate text-[10px] font-mono uppercase tracking-wider bg-transparent border-0 p-0 cursor-pointer focus:outline-none focus:ring-1 focus:ring-violet-500/40 rounded"
          style={{ color }}
          title="Change section type"
        >
          {sectionTypes.map((t) => (
            <option key={t} value={t} className="bg-[#14171d] text-slate-200 normal-case tracking-normal">{t}</option>
          ))}
        </select>
      </ItemCardHeader>

      {onLabelChange
        ? <ItemCardLabel value={section.label} onChange={onLabelChange} />
        : <ItemCardLabel value={section.label} readOnly />}

      <SnapTimeRow time={section.time} fmt={fmtTime} onSnap={onSnapStart} snapTitle="Snap start to playhead" />

      <SnapTimeRow
        time={endTime}
        fmt={fmtTime}
        onSnap={onSnapEnd}
        snapDisabled={isLast}
        snapTitle={isLast ? 'End = song duration' : 'Snap end to playhead'}
        prefix="–"
        variant="secondary"
        badge={barsToNext !== null && (
          <span className="text-[9px] font-mono text-violet-400/80 shrink-0" title="bars to next boundary">
            {barsToNext}b
          </span>
        )}
      />

      <CandidateChips
        candidates={section.candidates ?? []}
        fmt={fmtTime}
        onRemove={onRemoveCandidate}
      />

      <ItemCardActionRow>
        {showPlay && (
          <button
            onClick={(e) => { e.stopPropagation(); isPlaying ? onStop?.() : onPlay?.(); }}
            className={`flex-1 h-6 flex items-center justify-center rounded text-[12px] border transition-colors ${isPlaying ? 'bg-red-500/15 border-red-400/40 text-red-300' : 'bg-[#0a0b0d] border-white/[0.06] text-emerald-400 hover:border-emerald-400/40'}`}
            title={isPlaying ? 'Stop' : 'Play'}
          >{isPlaying ? '⏹' : '▶'}</button>
        )}
        <ItemCardIconButton
          onClick={onToggleImportance}
          title="Mark critical"
          state={isCritical ? 'active' : 'idle'}
        >{isCritical ? '★' : '☆'}</ItemCardIconButton>
        <ItemCardIconButton onClick={onSplit} title="Split at playhead">✂</ItemCardIconButton>
        <ItemCardIconButton onClick={onAddCandidate} title="Add alt time at playhead">+</ItemCardIconButton>
        <ItemCardIconButton onClick={onDelete} title="Delete" stretch={!showPlay}>✕</ItemCardIconButton>
      </ItemCardActionRow>
    </ItemCardShell>
  );
}

/** Trailing "+ Add" card placed after the last SectionCard. */
export function AddSectionAtEndCard({ onClick }: { onClick: () => void }) {
  return <SharedAddCard onClick={onClick} />;
}
