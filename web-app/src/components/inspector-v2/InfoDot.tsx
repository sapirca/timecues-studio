import { type ReactNode } from 'react';

/** A tiny ⓘ affordance that tucks explanatory prose out of the way until the
 *  user hovers or focuses it. Use it to keep always-visible subtitles from
 *  cluttering a panel — the label/title stays terse and instructive, the
 *  background detail lives one hover away.
 *
 *  Renders inline (`align-middle`); the popover is absolutely positioned so it
 *  never reflows the row. For long reference content (vocabularies, tables),
 *  prefer a real modal/popover instead — this is for one or two sentences. */
export function InfoDot({
  children,
  className = '',
  label = 'More info',
  align = 'left',
}: {
  children: ReactNode;
  className?: string;
  /** Accessible name for the button + tooltip. */
  label?: string;
  /** Which edge the popover hangs from. Use 'right' when the dot sits near the
   *  right edge of its container so the card stays on-screen. */
  align?: 'left' | 'right';
}) {
  return (
    <span className={`group relative inline-flex align-middle ${className}`}>
      <button
        type="button"
        aria-label={label}
        className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-white/15 text-slate-500 hover:text-slate-200 hover:border-slate-400/60 text-[9px] font-semibold leading-none transition-colors"
      >
        i
      </button>
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-50 top-full mt-1 w-64 max-w-[80vw] rounded-md border border-white/10 bg-[#1a1d24] px-3 py-2 text-[11px] font-normal normal-case tracking-normal leading-snug text-slate-300 shadow-lg opacity-0 invisible transition-opacity duration-100 group-hover:opacity-100 group-hover:visible group-focus-within:opacity-100 group-focus-within:visible ${
          align === 'right' ? 'right-0' : 'left-0'
        }`}
      >
        {children}
      </span>
    </span>
  );
}
