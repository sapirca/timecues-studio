// Compact toggle for `AnnotationLayer.mode` (`'full-annotation'` ↔
// `'multiple-candidates'`). Lives in each editor panel's slim per-layer
// toolbar. Default value is `'full-annotation'` when the layer document
// pre-dates Phase 2 and the field is missing on disk.

import type { LayerEvalMode } from '../../types/annotationLayer';

interface LayerModePickerProps {
  mode: LayerEvalMode | undefined;
  onChange: (next: LayerEvalMode) => void;
}

const FULL_TITLE =
  'Full annotation — every item is gold. Unmatched items count as misses.';
const CAND_TITLE =
  'Multiple candidates — the whole layer is one set of alternates for the ' +
  'same underlying truth. Matching any ONE item satisfies the layer.';

export function LayerModePicker({ mode, onChange }: LayerModePickerProps) {
  const current = mode ?? 'full-annotation';
  const isFull = current === 'full-annotation';
  return (
    <div
      className="flex items-center gap-px rounded border border-white/[0.08] overflow-hidden shrink-0"
      title="Per-layer evaluation mode"
    >
      <button
        type="button"
        onClick={() => onChange('full-annotation')}
        className={`px-1.5 py-0.5 text-[10px] uppercase tracking-wider transition-colors ${
          isFull
            ? 'bg-violet-500/20 text-violet-100'
            : 'bg-transparent text-slate-500 hover:text-slate-300'
        }`}
        title={FULL_TITLE}
      >
        Full
      </button>
      <button
        type="button"
        onClick={() => onChange('multiple-candidates')}
        className={`px-1.5 py-0.5 text-[10px] uppercase tracking-wider transition-colors ${
          !isFull
            ? 'bg-violet-500/20 text-violet-100'
            : 'bg-transparent text-slate-500 hover:text-slate-300'
        }`}
        title={CAND_TITLE}
      >
        Cands
      </button>
    </div>
  );
}
