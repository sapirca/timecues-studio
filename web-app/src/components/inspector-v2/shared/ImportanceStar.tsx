import type { ItemImportance } from '../../../types/annotationLayer';

interface ImportanceStarProps {
  importance: ItemImportance | undefined;
  onToggle: () => void;
  size?: 'sm' | 'md';
  /** Tooltip override. Defaults to "Mark critical" / "Mark optional". */
  title?: string;
}

/** Star toggle matching the boundary card (SectionCard.tsx) star — ★ amber when
 *  critical (default), ☆ muted when optional. Click toggles between the two. */
export function ImportanceStar({ importance, onToggle, size = 'md', title }: ImportanceStarProps) {
  const isCritical = importance !== 'optional';
  const dims = size === 'sm' ? 'w-5 h-5 text-[10px]' : 'w-6 h-6 text-[12px]';
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className={`${dims} flex items-center justify-center rounded border transition-colors ${
        isCritical
          ? 'bg-amber-500/15 border-amber-400/40 text-amber-300'
          : 'border-white/[0.04] text-slate-300 hover:text-amber-300'
      }`}
      title={title ?? (isCritical ? 'Critical — click to mark optional' : 'Optional — click to mark critical')}
    >
      {isCritical ? '★' : '☆'}
    </button>
  );
}
