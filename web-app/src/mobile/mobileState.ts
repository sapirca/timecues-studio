import { createContext, useContext, type Dispatch, type SetStateAction } from 'react';

/**
 * The one thing the phone shell has to share across the tree: which full-
 * screen panel is up. On desktop the workspace sidebars sit beside the
 * timeline; on a phone there is room for one thing at a time, so each sidebar
 * becomes a panel that replaces the timeline until it is closed.
 *
 *   songs      — the song list (desktop: left sidebar). Opened from the song
 *                name in the top bar, in every inspector workspace.
 *   setup      — Dataprep's Song setup sidebar.
 *   tools      — the Annotator Tool's annotation-tools sidebar.
 *   detectors  — Algorithm Inspect's detector-layers sidebar.
 *   algorithms — Algorithm Inspect's algorithms sidebar.
 *   account    — the avatar menu.
 *   list       — the Annotator Tool's edit list on its own: not a sidebar
 *                but the list that sits under the timeline, with the
 *                timeline hidden (`tc-mobile-list` on the root, index.css).
 *
 * `null` is the timeline itself.
 */
export type MobilePanel = 'songs' | 'setup' | 'tools' | 'detectors' | 'algorithms' | 'account' | 'list';

export interface MobileState {
  isMobile: boolean;
  panel: MobilePanel | null;
  setPanel: Dispatch<SetStateAction<MobilePanel | null>>;
  /** Tap the same panel's button again → back to the timeline. */
  togglePanel: (p: MobilePanel) => void;
  /** The current song, published by the inspector page so the top bar can
   *  name it. Null outside the inspector workspaces or before a pick. */
  song: { title: string; artist?: string } | null;
  setSong: (s: { title: string; artist?: string } | null) => void;
  /** The panels the current workspace offers (its desktop sidebars), shown
   *  as labelled buttons in the top bar's second row. Published by the page
   *  that owns them; empty hides the row. */
  choices: MobilePanelChoice[];
  setChoices: (c: MobilePanelChoice[]) => void;
}

export interface MobilePanelChoice { id: MobilePanel; label: string }

export const DESKTOP: MobileState = {
  isMobile: false,
  panel: null,
  setPanel: () => {},
  togglePanel: () => {},
  song: null,
  setSong: () => {},
  choices: [],
  setChoices: () => {},
};

export const MobileCtx = createContext<MobileState>(DESKTOP);

export function useMobile(): MobileState {
  return useContext(MobileCtx);
}
