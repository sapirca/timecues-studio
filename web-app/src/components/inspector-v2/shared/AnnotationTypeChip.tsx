/**
 * Horizontal tab for a top-level annotation type (Boundaries · Cues ·
 * Spans · Loops · Patterns). It is the navigation control in the unified
 * annotation list: the type tabs fill the row above the content and wrap to a
 * second row when the panel is too narrow for all six (each keeps an ~80px
 * minimum so its label never truncates). Clicking one makes that type active,
 * swapping the content below to its layers. Each tab shows the type label plus a compact
 * "layers · items" count. Experimental types (loops/patterns) get the faded
 * fuchsia treatment so they read as distinct from the always-on types.
 */

interface AnnotationTypeChipProps {
  label: string;
  active: boolean;
  experimental: boolean;
  /** Total items across all layers of this type (shown after the layer count). */
  count: number;
  /** Number of layers of this type. */
  layerCount: number;
  onClick: () => void;
  /** Tooltip — usually the type's one-line description. */
  title?: string;
}

export function AnnotationTypeChip({
  label, active, experimental, count, layerCount, onClick, title,
}: AnnotationTypeChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title ?? (experimental ? 'Experimental annotation type' : undefined)}
      className={`grow basis-[80px] min-w-[80px] text-left px-1.5 py-1.5 rounded-md border-b-2 border-x border-t flex flex-col gap-0.5 transition ${
        active
          ? (experimental
              ? 'bg-fuchsia-500/20 text-fuchsia-50 font-semibold border-b-fuchsia-300 border-x-fuchsia-400/60 border-t-fuchsia-400/60 shadow-[0_0_16px_-2px_rgba(232,121,249,0.75)]'
              : 'bg-cyan-500/20 text-cyan-50 font-semibold border-b-cyan-300 border-x-cyan-400/60 border-t-cyan-400/60 shadow-[0_0_16px_-2px_rgba(34,211,238,0.75)]')
          : (experimental
              ? 'bg-slate-800/30 text-slate-400 hover:text-fuchsia-200 hover:bg-fuchsia-500/10 border-b-white/10 border-x-transparent border-t-transparent hover:border-b-fuchsia-400/40'
              : 'bg-slate-800/30 text-slate-400 hover:text-cyan-100 hover:bg-cyan-500/10 border-b-white/10 border-x-transparent border-t-transparent hover:border-b-cyan-400/40')
      }`}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wide leading-tight whitespace-nowrap">
        {label}
      </span>
      <span className="text-[8.5px] font-mono opacity-70 leading-none">
        {layerCount} · {count}
      </span>
    </button>
  );
}
