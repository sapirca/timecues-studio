import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { getIsMobile } from './mobileMode';
import { DESKTOP, MobileCtx, type MobilePanel, type MobilePanelChoice, type MobileState } from './mobileState';

/** Holds the phone shell's shared state (see mobileState.ts). On desktop it
 *  hands out the inert DESKTOP value, so nothing downstream re-renders. */
export function MobileProvider({ children }: { children: ReactNode }) {
  const isMobile = getIsMobile();
  const [panel, setPanel] = useState<MobilePanel | null>(null);
  const [song, setSong] = useState<MobileState['song']>(null);
  const [choices, setChoices] = useState<MobilePanelChoice[]>([]);
  // The list "panel" is the page itself with the timeline hidden, so it is a
  // root class (index.css) rather than an overlay; it starts at the top.
  useEffect(() => {
    const on = panel === 'list';
    document.documentElement.classList.toggle('tc-mobile-list', on);
    if (on) window.scrollTo({ top: 0 });
  }, [panel]);
  // The annotation tools dock over the bottom half. What is left is for the
  // lanes being annotated, so the viz toolbar — which is not what you are
  // using while the sheet is up — gives up its rows (index.css).
  useEffect(() => {
    document.documentElement.classList.toggle('tc-mobile-tools', panel === 'tools');
  }, [panel]);
  const value = useMemo<MobileState>(() => (
    isMobile
      ? {
          isMobile,
          panel,
          setPanel,
          togglePanel: (p) => setPanel((cur) => (cur === p ? null : p)),
          song,
          setSong,
          choices,
          setChoices,
        }
      : DESKTOP
  ), [isMobile, panel, song, choices]);
  return <MobileCtx.Provider value={value}>{children}</MobileCtx.Provider>;
}

