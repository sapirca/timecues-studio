/** Drawn on a block, band or cell while the playhead is in it and its lane is
 *  visualized (see VisualizeToggle). Inset, so a lane that clips its children
 *  (every lane does) still shows all of it. */
export function litShadow(color: string): string {
  return `inset 0 0 0 2px rgba(255,255,255,0.9), inset 0 0 12px ${color}`;
}
