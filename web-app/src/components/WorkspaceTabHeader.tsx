import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAdmin } from '../hooks/useAdmin';
import { useDemo } from '../context/DemoContext';
import { useSettings } from '../context/SettingsContext';
import { AnnotatorBadge } from './AnnotatorBadge';
import { loadDatasetConfig } from '../services/datasetConfig';
import { requestPausePlayback } from '../utils/playerEvents';

export type WorkspaceTab = 'prep' | 'annotate' | 'inspect' | 'playground' | 'team' | 'setlist';

/** Path → tab mapping. Used when the header isn't given an explicit `active`
 *  prop (the App-level mount derives it from pathname so the same component
 *  works on every workspace). */
function tabForPath(pathname: string): WorkspaceTab {
  if (pathname === '/prep') return 'prep';
  if (pathname === '/inspect') return 'inspect';
  if (pathname === '/custom') return 'playground';
  if (pathname === '/team') return 'team';
  if (pathname === '/setlist') return 'setlist';
  return 'annotate';
}

const WORKSPACE_PATHS = new Set(['/prep', '/annotate', '/inspect', '/custom', '/team', '/setlist']);
export function isWorkspacePath(pathname: string): boolean {
  return WORKSPACE_PATHS.has(pathname);
}

interface TabDef {
  id: WorkspaceTab;
  label: string;
  path: string;
  accent: string;
  adminOnly?: boolean;
}

const TABS: TabDef[] = [
  { id: 'prep',       label: 'Dataprep',         path: '/prep',     accent: 'emerald' },
  { id: 'annotate',   label: 'Annotator Tool',   path: '/annotate', accent: 'cyan'    },
  { id: 'inspect',    label: 'Algorithm Inspect', path: '/inspect', accent: 'violet'  },
  { id: 'playground', label: 'Playground',       path: '/custom',   accent: 'amber'   },
  { id: 'setlist',    label: 'Setlist',          path: '/setlist',  accent: 'rose'    },
  { id: 'team',       label: 'Team',             path: '/team',     accent: 'rose', adminOnly: false },
];

const ACCENT_ACTIVE: Record<string, string> = {
  emerald: 'border-emerald-400 text-emerald-200',
  cyan:    'border-cyan-400 text-cyan-200',
  violet:  'border-violet-400 text-violet-200',
  amber:   'border-amber-400 text-amber-200',
  rose:    'border-rose-400 text-rose-200',
};

/**
 * Persistent header for the 5 workspaces. One click to switch; "← Back" returns
 * to the main page. Pages render this just below their global transport bar so
 * the tab strip is consistent across Dataprep / Annotator / Algo Inspect /
 * Playground / Team.
 */
export function WorkspaceTabHeader({ active }: { active?: WorkspaceTab } = {}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { status } = useAdmin();
  const { isDemo, requestExitDemo } = useDemo();
  const { settings } = useSettings();
  const resolvedActive: WorkspaceTab = active ?? tabForPath(pathname);
  const canSeeTeam = status?.tier === 'admin' || status?.tier === 'researcher';

  // Best-effort corpus-name chip next to the studio mark, so the active
  // corpus is visible inside every workspace. Hidden when unset.
  const [corpusName, setCorpusName] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadDatasetConfig()
      .then((cfg) => { if (!cancelled) setCorpusName(cfg.corpusName?.trim() || null); })
      .catch(() => { /* leave chip hidden */ });
    return () => { cancelled = true; };
  }, []);

  const handleBack = () => {
    if (isDemo) {
      requestExitDemo(() => navigate('/'));
      return;
    }
    navigate('/');
  };

  const handleClick = (tab: TabDef) => {
    if (tab.id === resolvedActive) return;
    console.log('[tabswitch] click ->', tab.id, tab.path);
    // Pause first so audio doesn't keep playing into the new tab. The three
    // inspector tabs share one mounted player, so navigation alone won't stop it.
    requestPausePlayback();
    console.log('[tabswitch] pause dispatched; calling navigate now');
    navigate(tab.path);
    console.log('[tabswitch] navigate returned');
  };

  // Team requires non-public access; the synthetic demo annotator is public,
  // so the Team tab naturally falls out in demo too. Playground is also
  // hidden in demo — the Python sandbox there is admin-only and any attempt
  // to reach /custom while in demo is blocked at both the route guard and
  // the server proxy.
  const visibleTabs = TABS.filter((t) => {
    if (t.id === 'team') return canSeeTeam && !isDemo;
    if (t.id === 'playground') return !isDemo;
    if (t.id === 'setlist') return settings.experimentalSetlist && !isDemo;
    return true;
  });

  return (
    <div className="relative z-30 w-full flex items-center gap-3 px-3 py-2 rounded-md border border-white/[0.06] bg-[#14171d]/80 backdrop-blur-sm">
      {/* Left group: back + studio mark + demo chip. flex-1 so the centered
          nav between this and the right group sits in the true visual middle. */}
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <button
          onClick={handleBack}
          title={isDemo ? 'Exit demo and return to main page' : 'Back to main page'}
          className="px-3 py-1.5 rounded text-sm font-mono text-slate-400 hover:text-slate-100 hover:bg-white/[0.05] transition-colors shrink-0"
        >
          ← {isDemo ? 'Exit demo' : 'Back'}
        </button>
        <button
          type="button"
          onClick={() => {
            if (isDemo) { requestExitDemo(() => navigate('/')); return; }
            navigate('/');
          }}
          title="Back to home"
          className="text-[13px] font-semibold tracking-[0.18em] uppercase text-slate-100 shrink-0 hover:text-violet-200 transition-colors"
        >
          TimeCues <span className="text-slate-500 font-normal">/ Studio</span>
        </button>
        {corpusName && !isDemo && (
          <span
            title="Corpus name"
            className="shrink-0 text-[11px] font-medium tracking-wide px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-200 border border-cyan-400/30 truncate max-w-[200px]"
          >
            {corpusName}
          </span>
        )}
        {isDemo && (
          <span
            title="Demo mode: edits stay in this browser, no server writes, no uploads."
            className="shrink-0 text-[9px] uppercase tracking-[0.18em] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-200 border border-violet-400/40"
          >
            Demo
          </span>
        )}
      </div>
      {/* Center: workspace tabs. shrink-0 keeps them from compressing if the
          side groups grow; overflow-x-auto rescues narrow viewports. */}
      <nav className="flex items-center gap-1 shrink-0 overflow-x-auto">
        {visibleTabs.map((t) => {
          const isActive = t.id === resolvedActive;
          const activeClasses = ACCENT_ACTIVE[t.accent] ?? 'border-cyan-400 text-cyan-200';
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => handleClick(t)}
              className={`px-4 py-2 rounded text-[13px] uppercase tracking-wider font-medium transition-colors border whitespace-nowrap leading-none ${
                isActive
                  ? `bg-white/[0.04] ${activeClasses}`
                  : 'border-white/[0.06] text-slate-400 hover:text-slate-200 hover:bg-white/[0.04] hover:border-white/[0.12]'
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </nav>
      {/* Right group: identity badge. Same flex-1 as the left group so the
          tabs are mathematically centered, not just pushed by ml-auto. */}
      <div className="flex items-center justify-end flex-1 min-w-0">
        <AnnotatorBadge inline />
      </div>
    </div>
  );
}
