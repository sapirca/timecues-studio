import { useAdmin } from '../hooks/useAdmin';
import { useDemo } from '../context/DemoContext';
import { useSettings } from '../context/SettingsContext';

/* The workspace tabs, shared by the desktop tab strip (WorkspaceTabHeader)
   and the phone's bottom bar (mobile/MobileShell). */

export type WorkspaceTab = 'prep' | 'annotate' | 'inspect' | 'playground' | 'team' | 'setlist';

/** Path → tab mapping. Used when the header isn't given an explicit `active`
 *  prop (the App-level mount derives it from pathname so the same component
 *  works on every workspace). */
export function tabForPath(pathname: string): WorkspaceTab {
  if (pathname === '/prep') return 'prep';
  if (pathname === '/inspect') return 'inspect';
  if (pathname === '/custom') return 'playground';
  if (pathname === '/team') return 'team';
  if (pathname === '/setlist') return 'setlist';
  return 'annotate';
}

export interface TabDef {
  id: WorkspaceTab;
  label: string;
  path: string;
  accent: string;
  adminOnly?: boolean;
}

export const TABS: TabDef[] = [
  { id: 'prep',       label: 'Dataprep',         path: '/prep',     accent: 'emerald' },
  { id: 'annotate',   label: 'Annotator Tool',   path: '/annotate', accent: 'cyan'    },
  { id: 'inspect',    label: 'Algorithm Inspect', path: '/inspect', accent: 'violet'  },
  { id: 'playground', label: 'Playground',       path: '/custom',   accent: 'amber'   },
  { id: 'setlist',    label: 'Setlist',          path: '/setlist',  accent: 'rose'    },
  { id: 'team',       label: 'Team',             path: '/team',     accent: 'rose', adminOnly: false },
];

/** The tabs this visitor may see — shared by the desktop tab strip and the
 *  phone's bottom bar, so the two can never disagree about who sees what.
 *
 *  Team requires non-public access; the synthetic demo annotator is public,
 *  so the Team tab naturally falls out in demo too. Playground is also
 *  hidden in demo — the Python sandbox there is admin-only and any attempt
 *  to reach /custom while in demo is blocked at both the route guard and
 *  the server proxy. */
export function useVisibleWorkspaceTabs(): TabDef[] {
  const { status } = useAdmin();
  const { isDemo } = useDemo();
  const { settings } = useSettings();
  const canSeeTeam = status?.tier === 'admin' || status?.tier === 'researcher';
  return TABS.filter((t) => {
    if (t.id === 'team') return canSeeTeam && !isDemo;
    if (t.id === 'playground') return !isDemo;
    if (t.id === 'setlist') return settings.experimentalSetlist && !isDemo;
    return true;
  });
}

