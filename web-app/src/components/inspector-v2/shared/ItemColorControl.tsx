/**
 * Per-item colour for a `sections` slot of AnnotationPointCard — one control
 * for every kind that carries `color` (cues, spans, loops, boundaries), so a
 * colour is set, shown and reset the same way whichever item you opened.
 *
 * Optional by design: with no colour the item draws in its layer's colour
 * (or, for a boundary, its section type's), and **reset** goes back to that.
 * `colorSection()` (colorSection.tsx) is what a kind mounts; the cue's Hit
 * section embeds `ItemColorControl` directly beside velocity and the rest.
 */

export interface ItemColorControlProps {
  /** The item's own colour, or undefined when it has none. */
  color: string | undefined;
  /** What the item draws in without one — the picker starts here. */
  fallbackColor: string;
  /** Names the fallback in the read-out: "layer colour", "type colour". */
  fallbackName?: string;
  readOnly: boolean;
  onChange: (color: string | undefined) => void;
}

export function ItemColorControl({
  color, fallbackColor, fallbackName = 'layer colour', readOnly, onChange,
}: ItemColorControlProps) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-slate-300" title={`Paints this one item instead of the ${fallbackName}`}>
      <span className="w-16 shrink-0">Colour</span>
      <input
        type="color"
        aria-label="Item colour"
        value={color ?? fallbackColor}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.value)}
        className="w-7 h-6 bg-transparent border border-white/[0.08] rounded cursor-pointer disabled:cursor-not-allowed"
      />
      <span className="text-[10px] text-slate-400">{color ?? fallbackName}</span>
      {color && !readOnly && (
        <button
          onClick={() => onChange(undefined)}
          className="ml-auto text-[10px] text-slate-400 hover:text-slate-100"
          title={`Use the ${fallbackName} again`}
        >reset</button>
      )}
    </div>
  );
}
