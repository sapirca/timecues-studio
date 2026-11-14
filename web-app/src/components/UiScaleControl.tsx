import { useSyncExternalStore } from 'react';
import { bumpUiScale, getUiScale, isUiScaleFitted, subscribeUiScale, UI_SCALE_MAX, UI_SCALE_MIN } from '../uiScale';

/** − + — the size of all text and buttons. Fits the window until the viewer
 *  picks a size, which is then remembered on this browser. The current size
 *  lives in the tooltip, not on the bar: it is rarely read and the header is
 *  short of room. */
export function UiScaleControl() {
  const mod = /Mac|iP(hone|ad)/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  const z = useSyncExternalStore(subscribeUiScale, getUiScale);
  const pct = `${Math.round(z * 100)}%`;
  const btn =
    'w-8 h-8 flex items-center justify-center text-slate-300 ' +
    'hover:text-white hover:bg-white/[0.08] disabled:opacity-40 disabled:pointer-events-none ' +
    'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cyan-400 transition-colors';
  return (
    <div
      className="flex items-center shrink-0 rounded border border-white/[0.1] bg-white/[0.03] divide-x divide-white/[0.1] overflow-hidden"
      title={isUiScaleFitted()
        ? `Size of all text and buttons: ${pct}, fitted to this window. − / + picks a size and remembers it (${mod}0 fits the window again)`
        : `Size of all text and buttons: ${pct}, remembered on this browser (${mod}0 fits the window again)`}
    >
      <button type="button" className={btn} onClick={() => bumpUiScale(-1)} disabled={z <= UI_SCALE_MIN} aria-label={`Smaller text (now ${pct})`} title={`Smaller — now ${pct} (${mod}−)`}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><path d="M2 7h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
      </button>
      <button type="button" className={btn} onClick={() => bumpUiScale(1)} disabled={z >= UI_SCALE_MAX} aria-label={`Bigger text (now ${pct})`} title={`Bigger — now ${pct} (${mod}+)`}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><path d="M2 7h10M7 2v10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}
