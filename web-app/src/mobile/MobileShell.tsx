import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAnnotator } from '../context/AnnotatorContext';
import { useDemo } from '../context/DemoContext';
import { useSettings } from '../context/SettingsContext';
import { useVisibleWorkspaceTabs, tabForPath, type WorkspaceTab } from '../components/workspaceTabs';
import { loadDatasetConfig } from '../services/datasetConfig';
import { requestPausePlayback } from '../utils/playerEvents';
import { useMobile } from './mobileState';
import { switchToDesktop } from './mobileMode';

/**
 * The phone frame around every workspace route.
 *
 *   top bar     — the song you are on (tap → the song list) · your avatar
 *                 (tap → account, corpus, settings, desktop site, sign out).
 *   bottom bar  — the desktop workspace tabs, same names, same order, same
 *                 accent colours, same who-sees-what rules. It is the desktop
 *                 tab strip moved to where a thumb is, not a new navigation.
 *
 * Setlist is the one desktop tab left out of the bar: it is experimental and a
 * sixth tab does not fit a phone, so it lives in the account panel instead.
 */

const INSPECTOR_PATHS = new Set(['/prep', '/annotate', '/inspect']);

/** Bottom-bar names. The desktop labels ("Annotator Tool", "Algorithm
 *  Inspect") do not fit five-across at 390px; these are their first words. */
const SHORT_LABEL: Record<WorkspaceTab, string> = {
  prep: 'Dataprep',
  annotate: 'Annotate',
  inspect: 'Inspect',
  playground: 'Playground',
  team: 'Team',
  setlist: 'Setlist',
};

const ACCENT_TEXT: Record<string, string> = {
  emerald: 'text-emerald-300',
  cyan: 'text-cyan-300',
  violet: 'text-violet-300',
  amber: 'text-amber-300',
  rose: 'text-rose-300',
};
const ACCENT_BORDER: Record<string, string> = {
  emerald: 'border-emerald-400/70',
  cyan: 'border-cyan-400/70',
  violet: 'border-violet-400/70',
  amber: 'border-amber-400/70',
  rose: 'border-rose-400/70',
};
const ACCENT_BAR: Record<string, string> = {
  emerald: 'bg-emerald-400',
  cyan: 'bg-cyan-400',
  violet: 'bg-violet-400',
  amber: 'bg-amber-400',
  rose: 'bg-rose-400',
};

function TabIcon({ id }: { id: WorkspaceTab }) {
  const common = { className: 'w-5 h-5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, viewBox: '0 0 24 24', 'aria-hidden': true };
  switch (id) {
    case 'prep': // a tempo grid
      return <svg {...common}><path d="M4 5v14M9 5v14M14 5v14M19 5v14" /><path d="M2 12h20" opacity=".5" /></svg>;
    case 'annotate': // a marker on a waveform
      return <svg {...common}><path d="M3 12h2l2-5 3 10 3-8 2 5h6" /><path d="M16 3v4" /></svg>;
    case 'inspect': // stacked detector rows
      return <svg {...common}><rect x="3" y="4" width="18" height="4" rx="1" /><rect x="3" y="10" width="12" height="4" rx="1" /><rect x="3" y="16" width="15" height="4" rx="1" /></svg>;
    case 'playground': // code
      return <svg {...common}><path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13 5l-2 14" /></svg>;
    case 'team':
      return <svg {...common}><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><circle cx="17" cy="9" r="2.5" /><path d="M15.5 14.2c3 .2 5.5 2.6 5.5 5.8" /></svg>;
    default:
      return <svg {...common}><circle cx="12" cy="12" r="8" /></svg>;
  }
}

function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase() ?? '').join('') || '?';
}

export function MobileTopBar() {
  const { pathname } = useLocation();
  const { annotator } = useAnnotator();
  const { isDemo } = useDemo();
  const { panel, togglePanel, song, choices } = useMobile();
  const onInspector = INSPECTOR_PATHS.has(pathname);
  const tabs = useVisibleWorkspaceTabs();
  const here = tabs.find((t) => t.path === pathname);
  const songsOpen = panel === 'songs';
  const showChoices = onInspector && choices.length > 0;
  // The second row makes the bar taller; every sticky offset and every panel
  // reads --tc-header-h, so one class moves them all (see index.css).
  useEffect(() => {
    document.documentElement.classList.toggle('tc-mobile-tworow', showChoices);
    return () => document.documentElement.classList.remove('tc-mobile-tworow');
  }, [showChoices]);
  const accentTab = tabs.find((t) => t.path === pathname);

  return (
    <header
      className="sticky top-0 z-[70] flex flex-col bg-[#0a0b0d]/95 backdrop-blur border-b border-white/[0.08]"
      style={{ height: 'var(--tc-header-h)' }}
    >
    <div className="h-12 shrink-0 flex items-center gap-2 px-3">
      {onInspector ? (
        <button
          type="button"
          onClick={() => togglePanel('songs')}
          aria-expanded={songsOpen}
          aria-label={songsOpen ? 'Close the song list' : 'Choose a song'}
          className="flex-1 min-w-0 flex items-center gap-1.5 h-10 -ml-1 px-1 rounded-md text-left active:bg-white/[0.06]"
        >
          <span className="min-w-0 flex flex-col leading-tight">
            <span className="text-[15px] font-semibold text-white truncate">
              {song?.title ?? 'Choose a song'}
            </span>
            {song?.artist && <span className="text-[11px] text-slate-400 truncate">{song.artist}</span>}
          </span>
          <span className={`shrink-0 text-slate-400 text-xs transition-transform ${songsOpen ? 'rotate-180' : ''}`} aria-hidden>▾</span>
        </button>
      ) : (
        <span className="flex-1 min-w-0 text-[15px] font-semibold text-white truncate">
          {here ? SHORT_LABEL[here.id] : pathname === '/settings' ? 'Settings' : 'TimeCues Studio'}
        </span>
      )}
      {isDemo && (
        <span className="shrink-0 text-[9px] uppercase tracking-[0.18em] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-200 border border-violet-400/40">
          Demo
        </span>
      )}
      {annotator && (
        <button
          type="button"
          onClick={() => togglePanel('account')}
          aria-expanded={panel === 'account'}
          aria-label="Account menu"
          className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-bold text-white border ${panel === 'account' ? 'bg-indigo-500 border-indigo-300' : 'bg-indigo-600 border-transparent'}`}
        >
          {initialsOf(annotator.displayName)}
        </button>
      )}
    </div>
    {/* The workspace's desktop sidebars, as labelled buttons. Each opens its
        sidebar full-screen under this bar; tapping it again (✕) closes it.
        Kept in the bar, not the page, so the button that opened a panel is
        still on screen to close it. */}
    {showChoices && (
      <div className="h-11 shrink-0 flex items-center gap-1.5 px-3 overflow-x-auto">
        {choices.map((c) => {
          const open = panel === c.id;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => togglePanel(c.id)}
              aria-expanded={open}
              className={`shrink-0 h-8 px-3 rounded-md border text-[12.5px] font-medium whitespace-nowrap ${
                open
                  ? `${ACCENT_TEXT[accentTab?.accent ?? 'cyan']} ${ACCENT_BORDER[accentTab?.accent ?? 'cyan']} bg-white/[0.06]`
                  : 'border-white/[0.12] text-slate-200 bg-white/[0.03]'
              }`}
            >
              {c.label} <span className="text-slate-500" aria-hidden>{open ? '✕' : '›'}</span>
            </button>
          );
        })}
      </div>
    )}
    </header>
  );
}

export function MobileTabBar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { setPanel } = useMobile();
  const tabs = useVisibleWorkspaceTabs().filter((t) => t.id !== 'setlist');
  const active = tabForPath(pathname);

  return (
    <nav
      aria-label="Workspaces"
      className="fixed inset-x-0 bottom-0 z-[70] flex bg-[#0d0f12]/97 backdrop-blur border-t border-white/[0.08]"
      style={{ height: 'var(--tc-nav-h)', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      {tabs.map((t) => {
        const isActive = t.id === active && pathname === t.path;
        return (
          <button
            key={t.id}
            type="button"
            aria-current={isActive ? 'page' : undefined}
            onClick={() => {
              setPanel(null);
              if (isActive) return;
              // The three inspector tabs share one mounted player, so a route
              // change alone would keep the song playing into the next tab.
              requestPausePlayback();
              navigate(t.path);
            }}
            className={`relative flex-1 min-w-0 flex flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium ${
              isActive ? ACCENT_TEXT[t.accent] : 'text-slate-500 active:text-slate-300'
            }`}
          >
            {isActive && <span className={`absolute top-0 left-1/4 right-1/4 h-[2px] rounded-b ${ACCENT_BAR[t.accent]}`} />}
            <TabIcon id={t.id} />
            <span className="truncate max-w-full px-0.5">{SHORT_LABEL[t.id]}</span>
          </button>
        );
      })}
    </nav>
  );
}

/** Full-screen panel between the two bars. Shared by the account menu here
 *  and nothing else — the inspector's panels are its own sidebars, restyled
 *  by the `.tc-aside` rules in index.css. */
function MobilePanelFrame({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div
      role="dialog"
      aria-label={title}
      className="fixed inset-x-0 z-[65] flex flex-col bg-[#101318]"
      style={{ top: 'var(--tc-header-h)', bottom: 'var(--tc-nav-h)' }}
    >
      <div className="flex items-center justify-between h-11 px-4 border-b border-white/[0.06] shrink-0">
        <span className="text-[12px] uppercase tracking-[0.18em] text-slate-300 font-semibold">{title}</span>
        <button type="button" onClick={onClose} className="h-9 px-3 -mr-2 text-[13px] text-slate-300 active:text-white">
          Done
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

function PanelRow({ label, hint, onClick, tone = 'default' }: { label: string; hint?: string; onClick: () => void; tone?: 'default' | 'danger' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center justify-between gap-3 min-h-[52px] px-4 text-left border-b border-white/[0.05] active:bg-white/[0.04] ${tone === 'danger' ? 'text-rose-300' : 'text-slate-100'}`}
    >
      <span className="flex flex-col min-w-0">
        <span className="text-[15px]">{label}</span>
        {hint && <span className="text-[12px] text-slate-500">{hint}</span>}
      </span>
      {tone === 'default' && <span className="text-slate-600" aria-hidden>›</span>}
    </button>
  );
}

export function MobileAccountPanel() {
  const navigate = useNavigate();
  const { annotator, signOut } = useAnnotator();
  const { isDemo, requestExitDemo } = useDemo();
  const { settings } = useSettings();
  const { panel, setPanel } = useMobile();
  const [corpusName, setCorpusName] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadDatasetConfig()
      .then((cfg) => { if (!cancelled) setCorpusName(cfg.corpusName?.trim() || null); })
      .catch(() => { /* row stays hidden */ });
    return () => { cancelled = true; };
  }, []);

  if (panel !== 'account' || !annotator) return null;
  const go = (path: string) => { setPanel(null); requestPausePlayback(); navigate(path); };

  return (
    <MobilePanelFrame title="Account" onClose={() => setPanel(null)}>
      <div className="flex items-center gap-3 px-4 py-4 border-b border-white/[0.06]">
        <span className="w-11 h-11 rounded-full bg-indigo-600 flex items-center justify-center text-[14px] font-bold text-white">
          {initialsOf(annotator.displayName)}
        </span>
        <span className="flex flex-col min-w-0">
          <span className="text-[15px] text-white truncate">{annotator.displayName}</span>
          {annotator.email && <span className="text-[12px] text-slate-400 truncate">{annotator.email}</span>}
          {annotator.role && <span className="text-[12px] text-slate-500">{annotator.role}</span>}
        </span>
      </div>
      {corpusName && !isDemo && (
        <div className="px-4 py-3 border-b border-white/[0.05] text-[12px] text-slate-400">
          Corpus <span className="ml-1 px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-200 border border-cyan-400/30">{corpusName}</span>
        </div>
      )}
      <PanelRow label="Settings" onClick={() => go('/settings')} />
      {settings.experimentalSetlist && !isDemo && (
        <PanelRow label="Setlist" hint="Experimental" onClick={() => go('/setlist')} />
      )}
      <PanelRow label="Home" onClick={() => {
        if (isDemo) { setPanel(null); requestExitDemo(() => navigate('/')); return; }
        go('/');
      }} />
      <PanelRow
        label="Desktop site"
        hint="The full workspace, with the sidebars beside the timeline"
        onClick={switchToDesktop}
      />
      <PanelRow
        label={isDemo ? 'Exit demo' : 'Sign out'}
        tone="danger"
        onClick={() => {
          setPanel(null);
          // Same order as the desktop badge: demo edits get their Keep /
          // Discard prompt before the demo identity is dropped.
          if (isDemo) { requestExitDemo(() => signOut()); return; }
          signOut();
        }}
      />
    </MobilePanelFrame>
  );
}
