import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useDemo } from '../context/DemoContext';

interface BackConfig {
  /** Chip label after the arrow. Defaults to 'Back'. */
  label?: string;
  /** Override default behavior (navigate to '/', exiting demo first if active). */
  onClick?: () => void;
  /** Tooltip on the chip. */
  title?: string;
}

interface AppPageHeaderProps {
  /** `false` hides the back chip (used on `/` landing). Otherwise the chip
   *  appears top-left with `← {label}`. */
  back?: BackConfig | false;
  /** Optional right-side slot (e.g. Settings + AnnotatorBadge on landing). */
  rightSlot?: ReactNode;
}

/**
 * Unified top header used on every page that does NOT mount WorkspaceTabHeader.
 * Renders, left to right: back chip (optional), TIMECUES / STUDIO brand mark,
 * Demo badge (when isDemo), then a right-aligned slot. Same screen position
 * as the workspace header so the back affordance is consistent across the app.
 */
export function AppPageHeader({ back, rightSlot }: AppPageHeaderProps) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { isDemo, requestExitDemo } = useDemo();
  // The home chooser at `/` is route-neutral — the visitor hasn't entered a
  // workspace yet, so labels that describe an active mode (Demo, corpus name)
  // don't belong here.
  const isHome = pathname === '/';

  const goHome = () => {
    if (isDemo) { requestExitDemo(() => navigate('/')); return; }
    navigate('/');
  };

  const showBack = back !== false;
  const backLabel = (back ? back.label : undefined) ?? (isDemo ? 'Exit demo' : 'Back');
  const backTitle = (back ? back.title : undefined)
    ?? (isDemo ? 'Exit demo and return to main page' : 'Back to main page');
  const backOnClick = (back ? back.onClick : undefined) ?? goHome;

  return (
    <header className="flex items-center justify-between gap-3 px-6 py-4 border-b border-white/[0.05]">
      <div className="flex items-center gap-3 min-w-0">
        {showBack && (
          <button
            type="button"
            onClick={backOnClick}
            title={backTitle}
            className="px-3 py-1.5 rounded text-sm font-mono text-slate-400 hover:text-slate-100 hover:bg-white/[0.05] transition-colors shrink-0"
          >
            ← {backLabel}
          </button>
        )}
        <button
          type="button"
          onClick={goHome}
          title="Back to home"
          className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.2em] uppercase text-slate-300 hover:text-violet-200 transition-colors shrink-0"
        >
          <span className="tc-led tc-led-mute !bg-violet-400 !shadow-[0_0_6px_rgba(167,139,250,0.55)]" />
          TimeCues <span className="text-slate-500 font-normal">/ Studio</span>
        </button>
        {isDemo && !isHome && (
          <span
            title="Demo mode: edits stay in this browser, no server writes, no uploads."
            className="shrink-0 text-[9px] uppercase tracking-[0.18em] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-200 border border-violet-400/40"
          >
            Demo
          </span>
        )}
      </div>
      {rightSlot != null && (
        <div className="flex items-center gap-3 shrink-0">{rightSlot}</div>
      )}
    </header>
  );
}
