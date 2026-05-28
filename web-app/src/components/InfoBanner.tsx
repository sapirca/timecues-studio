import { useEffect, useState, type ReactNode } from 'react';
import { getCurrentAnnotatorId } from '../context/AnnotatorContext';

type Accent = 'emerald' | 'cyan' | 'violet' | 'amber' | 'rose' | 'pink' | 'slate';

const ACCENT: Record<Accent, { border: string; bg: string; title: string; body: string; chip: string }> = {
  emerald: { border: 'border-emerald-400/30', bg: 'bg-emerald-500/[0.06]', title: 'text-emerald-200', body: 'text-emerald-100/80', chip: 'text-emerald-300' },
  cyan:    { border: 'border-cyan-400/30',    bg: 'bg-cyan-500/[0.06]',    title: 'text-cyan-200',    body: 'text-cyan-100/80',    chip: 'text-cyan-300'    },
  violet:  { border: 'border-violet-400/30',  bg: 'bg-violet-500/[0.06]',  title: 'text-violet-200',  body: 'text-violet-100/80',  chip: 'text-violet-300'  },
  amber:   { border: 'border-amber-400/30',   bg: 'bg-amber-500/[0.06]',   title: 'text-amber-200',   body: 'text-amber-100/80',   chip: 'text-amber-300'   },
  rose:    { border: 'border-rose-400/30',    bg: 'bg-rose-500/[0.06]',    title: 'text-rose-200',    body: 'text-rose-100/80',    chip: 'text-rose-300'    },
  pink:    { border: 'border-pink-400/30',    bg: 'bg-pink-500/[0.06]',    title: 'text-pink-200',    body: 'text-pink-100/80',    chip: 'text-pink-300'    },
  slate:   { border: 'border-white/10',       bg: 'bg-white/[0.03]',       title: 'text-slate-200',   body: 'text-slate-400',      chip: 'text-slate-400'   },
};

const STORAGE_PREFIX = 'tc.infoBanner.dismissed.';

function storageKey(id: string, userId?: string | null): string {
  const userPart = userId ? `${userId}.` : '';
  return `${STORAGE_PREFIX}${userPart}${id}`;
}

/** Read-only check used by hosts that want to render a "Show tip" affordance
 *  when the banner is currently hidden. Per-user: uses the current annotator ID. */
export function isInfoBannerDismissed(id: string): boolean {
  try {
    const userId = getCurrentAnnotatorId();
    return localStorage.getItem(storageKey(id, userId)) === '1';
  }
  catch { return false; }
}

/** Reset a banner's dismissed state for the current user. */
export function resetInfoBanner(id: string): void {
  try {
    const userId = getCurrentAnnotatorId();
    localStorage.removeItem(storageKey(id, userId));
  } catch { /* ignore */ }
}

/** Reset all dismissed banners for the current user (useful for factory reset / clear site data flows). */
export function resetAllInfoBanners(): void {
  try {
    const userId = getCurrentAnnotatorId();
    const prefix = userId ? `${STORAGE_PREFIX}${userId}.` : STORAGE_PREFIX;
    const keys = Object.keys(localStorage).filter(k => k.startsWith(prefix));
    keys.forEach(k => localStorage.removeItem(k));
  } catch { /* ignore */ }
}

interface InfoBannerProps {
  /** Stable id used as the localStorage key. Bump suffix when the message
   *  changes meaningfully so users see it again. */
  id: string;
  /** Short heading (a few words). Renders before the body in bold accent. */
  title: string;
  /** One-liner body. Keep it tight — this is a nudge, not documentation. */
  children: ReactNode;
  accent?: Accent;
}

export function InfoBanner({ id, title, children, accent = 'slate' }: InfoBannerProps) {
  const [dismissed, setDismissed] = useState<boolean>(() => isInfoBannerDismissed(id));
  const [userId] = useState(() => getCurrentAnnotatorId());

  useEffect(() => {
    setDismissed(isInfoBannerDismissed(id));
  }, [id]);

  if (dismissed) return null;

  const c = ACCENT[accent];

  const handleDismiss = () => {
    try { localStorage.setItem(storageKey(id, userId), '1'); } catch { /* ignore */ }
    setDismissed(true);
  };

  return (
    <div className={`relative flex items-start gap-4 rounded-lg border ${c.border} ${c.bg} px-5 py-4 shadow-sm`}>
      <span aria-hidden className={`shrink-0 text-[22px] leading-none mt-0.5 ${c.chip}`}>ⓘ</span>
      <div className="flex-1 min-w-0 pr-8">
        <div className={`text-[15px] font-semibold leading-tight mb-1 ${c.title}`}>{title}</div>
        <div className={`text-[13px] leading-6 ${c.body}`}>{children}</div>
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        title="Dismiss"
        aria-label="Dismiss"
        className="absolute top-2.5 right-2.5 inline-flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:text-slate-100 hover:bg-white/10 transition-colors text-lg leading-none"
      >
        ×
      </button>
    </div>
  );
}
