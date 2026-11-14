/** The look of a row in a ⋮ menu — every lane's, and a group header's — so a
 *  menu item reads the same wherever it is. `MENU_ROW_SHAPE` is the row without
 *  its colours, for items that colour themselves (delete, merge). */
export const MENU_ROW_SHAPE = 'w-full px-2.5 py-1.5 text-left text-[11px] transition-colors flex items-center gap-1.5';
export const MENU_ROW = `${MENU_ROW_SHAPE} text-slate-200 hover:bg-white/[0.06]`;
/** The rule between a menu's sections. */
export const MENU_DIVIDER = 'h-px bg-white/[0.08] my-1';
/** A small heading over a list inside a menu (Move to, Merge into). */
export const MENU_HEADING = 'px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500';
