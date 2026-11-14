import type { AlgoGrid } from '../../utils/algoGrid';

const OPTIONS: { value: AlgoGrid; label: string; title: string }[] = [
  { value: 'user', label: 'My grid', title: "Cut on this song's grid, as you set it in Dataset Prep → Song Setup." },
  { value: 'auto', label: 'Automatic', title: "Cut on the beats the algorithm tracks itself — they may drift from your bars." },
];

/** Whose beats MSAF / ruptures / LoCoMotif cut their features at on the next
 *  run — one choice at the top of the run picker. A song with no grid can
 *  still pick "My grid", and is told what to do — the run would otherwise fail
 *  with the same message. */
export function AlgoGridChoice({
  value,
  onChange,
  songHasGrid,
  onOpenPrep,
}: {
  value: AlgoGrid;
  onChange: (grid: AlgoGrid) => void;
  songHasGrid: boolean;
  onOpenPrep: () => void;
}) {
  return (
    <div className="mb-1.5 space-y-1">
      <div role="radiogroup" aria-label="Beat grid for the next run" className="flex items-center gap-2">
        {OPTIONS.map((o) => {
          const on = value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              title={o.title}
              onClick={() => onChange(o.value)}
              className={`h-8 px-3 rounded border text-[11px] whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 ${
                on
                  ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-100'
                  : 'border-white/[0.12] bg-white/[0.03] text-slate-400 hover:text-slate-200 hover:bg-white/[0.06]'
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {value === 'user' && !songHasGrid && (
        <div className="text-[10px] leading-snug text-amber-400/80">
          This song has no grid yet.{' '}
          <button type="button" onClick={onOpenPrep} className="underline hover:text-amber-200">
            Set its BPM and bar 1 in Dataset Prep
          </button>
          , or choose Automatic.
        </div>
      )}
    </div>
  );
}
