import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useDemo } from '../context/DemoContext';
import { AnnotatorBadge } from './AnnotatorBadge';
import { UiScaleControl } from './UiScaleControl';
import { tabForPath, useVisibleWorkspaceTabs, type TabDef, type WorkspaceTab } from './workspaceTabs';
import { loadDatasetConfig } from '../services/datasetConfig';
import { requestPausePlayback } from '../utils/playerEvents';

const WORKSPACE_PATHS = new Set(['/prep', '/annotate', '/inspect', '/custom', '/team']);
export function isWorkspacePath(pathname: string): boolean {
  return WORKSPACE_PATHS.has(pathname);
}

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
  const { isDemo, requestExitDemo } = useDemo();
  const resolvedActive: WorkspaceTab = active ?? tabForPath(pathname);

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
    // Pause first so audio doesn't keep playing into the new tab. The three
    // inspector tabs share one mounted player, so navigation alone won't stop it.
    requestPausePlayback();
    navigate(tab.path);
  };

  const visibleTabs = useVisibleWorkspaceTabs();

  return (
    <div className="relative z-30 w-full flex items-center gap-2 xl:gap-3 px-3 py-2 rounded-md border border-white/[0.06] bg-[#14171d]/80">
      {/* One row, and every piece squeezes: the three groups share the spare
          width and give it back in proportion to their size, and each label
          inside them truncates rather than spilling onto its neighbour. (The
          old flex-1 groups had a zero basis, so the row thought everything fit
          and the corpus chip painted over the first tab.) */}
      <div className="flex items-center gap-2 xl:gap-3 flex-auto min-w-0">
        <button
          onClick={handleBack}
          title={isDemo ? 'Exit demo and return to main page' : 'Back to main page'}
          className="px-2 xl:px-3 py-1.5 rounded text-sm font-mono text-slate-400 hover:text-slate-100 hover:bg-white/[0.05] transition-colors min-w-0 truncate whitespace-nowrap"
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
          className="text-[13px] font-semibold tracking-[0.12em] xl:tracking-[0.18em] uppercase text-slate-100 min-w-0 truncate whitespace-nowrap hover:text-violet-200 transition-colors"
        >
          TimeCues <span className="text-slate-500 font-normal">/ Studio</span>
        </button>
        {corpusName && !isDemo && (
          <span
            title={corpusName}
            className="min-w-[2.5rem] text-[11px] font-medium tracking-wide px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-200 border border-cyan-400/30 truncate whitespace-nowrap max-w-[200px]"
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
      {/* Center: workspace tabs. Padding tightens first, then labels truncate;
          overflow-x-auto is the last resort once every tab is at its minimum. */}
      <nav className="flex items-center gap-1 min-w-0 overflow-x-auto">
        {visibleTabs.map((t) => {
          const isActive = t.id === resolvedActive;
          const activeClasses = ACCENT_ACTIVE[t.accent] ?? 'border-cyan-400 text-cyan-200';
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => handleClick(t)}
              title={t.label}
              className={`px-2 xl:px-4 py-2 rounded text-[13px] uppercase tracking-wide xl:tracking-wider font-medium transition-colors border whitespace-nowrap truncate min-w-[3.5rem] leading-none ${
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
      {/* Right group: page size + identity badge, squeezing like the left. */}
      <div className="flex items-center justify-end gap-2 xl:gap-3 flex-auto min-w-0">
        <UiScaleControl />
        <AnnotatorBadge inline />
      </div>
    </div>
  );
}
