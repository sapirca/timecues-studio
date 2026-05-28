/**
 * Horizontal tab for a top-level annotation type (Boundaries · Cues ·
 * Spans · Loops · Patterns). It is the navigation control in the unified
 * annotation list: all type tabs share one row above the content (splitting
 * the width evenly) and clicking one makes that type active, swapping the
 * content below to its layers. Each tab shows the type label plus a compact
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
      className={`flex-1 basis-0 min-w-0 text-left px-1.5 py-1.5 rounded-md border-b-2 border-x border-t flex flex-col gap-0.5 transition ${
        active
          ? (experimental
              ? 'bg-fuchsia-500/15 text-fuchsia-100 border-b-fuchsia-400 border-x-fuchsia-400/40 border-t-fuchsia-400/40 shadow-[0_0_14px_-3px_rgba(232,121,249,0.6)]'
              : 'bg-cyan-500/15 text-cyan-100 border-b-cyan-400 border-x-cyan-400/40 border-t-cyan-400/40 shadow-[0_0_14px_-3px_rgba(34,211,238,0.6)]')
          : (experimental
              ? 'bg-fuchsia-500/[0.05] text-fuchsia-300/70 hover:text-fuchsia-200 hover:bg-fuchsia-500/10 border-b-fuchsia-400/25 border-x-fuchsia-400/15 border-t-fuchsia-400/15'
              : 'bg-cyan-500/[0.04] text-cyan-300/70 hover:text-cyan-100 hover:bg-cyan-500/10 border-b-cyan-400/25 border-x-transparent border-t-transparent')
      }`}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wide leading-tight truncate">
        {label}
      </span>
      <span className="text-[8.5px] font-mono opacity-70 leading-none">
        {layerCount} · {count}
      </span>
    </button>
  );
}
