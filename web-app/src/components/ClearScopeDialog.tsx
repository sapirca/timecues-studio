import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { formatBytes, type PerSongStorage } from '../services/storageStats';

export type ClearScope = 'STEM' | 'ALGOS' | 'EVERYTHING';

export interface ClearScopeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  songName: string;
  storage: PerSongStorage | null;
  onConfirm: (scope: ClearScope) => void | Promise<void>;
  /** When true, the EVERYTHING scope is disabled — demo visitors can poke at
   *  STEM/ALGOS to free disk but must not be able to delete songs from the
   *  shared corpus. STEM and ALGOS still work; they only touch regenerable
   *  caches. */
  isDemo?: boolean;
}

const SCOPE_LABEL: Record<ClearScope, string> = {
  STEM: 'STEM',
  ALGOS: 'ALGOS',
  EVERYTHING: 'EVERYTHING',
};

/** Per-song clear dialog with three scopes. The user picks a scope, then types
 *  the scope word to confirm. EVERYTHING is destructive across annotators and
 *  audio so it gets a loud red warning. */
export function ClearScopeDialog({
  open,
  onOpenChange,
  songName,
  storage,
  onConfirm,
  isDemo = false,
}: ClearScopeDialogProps) {
  const [scope, setScope] = useState<ClearScope>('STEM');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setScope('STEM');
      setTyped('');
      setBusy(false);
    }
  }, [open]);

  // Demo visitors must never reach EVERYTHING — if it's somehow preselected,
  // fall back to STEM.
  useEffect(() => {
    if (isDemo && scope === 'EVERYTHING') setScope('STEM');
  }, [isDemo, scope]);

  // Reset typed-confirmation when the user switches scopes — they have to retype.
  useEffect(() => { setTyped(''); }, [scope]);

  const stemsBytes        = storage?.caches.stems ?? 0;
  const cacheBytes        = storage?.cacheBytes ?? 0;
  const annotationsBytes  = storage?.annotations ?? 0;
  const audioBytes        = storage?.audio ?? 0;
  const totalBytes        = storage?.totalBytes ?? 0;

  const scopeBytes: Record<ClearScope, number> = {
    STEM:       stemsBytes,
    ALGOS:      cacheBytes,
    EVERYTHING: totalBytes,
  };

  const matches = typed === SCOPE_LABEL[scope];

  const handleConfirm = async () => {
    if (!matches || busy) return;
    setBusy(true);
    try {
      await onConfirm(scope);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  const ScopeOption = ({
    value, title, description, accent, disabled = false, disabledHint,
  }: {
    value: ClearScope;
    title: string;
    description: React.ReactNode;
    accent: 'amber' | 'orange' | 'red';
    disabled?: boolean;
    disabledHint?: string;
  }) => {
    const isSelected = scope === value;
    const tone = {
      amber:  { ring: 'border-amber-400/60 bg-amber-500/10',   dot: 'bg-amber-300',  text: 'text-amber-200' },
      orange: { ring: 'border-orange-400/60 bg-orange-500/10', dot: 'bg-orange-300', text: 'text-orange-200' },
      red:    { ring: 'border-red-400/70 bg-red-500/10',       dot: 'bg-red-300',    text: 'text-red-200' },
    }[accent];
    return (
      <button
        type="button"
        onClick={() => { if (!disabled) setScope(value); }}
        disabled={disabled}
        title={disabled ? disabledHint : undefined}
        className={`w-full text-left rounded border transition-colors px-3 py-2 flex items-start gap-2.5 ${
          disabled
            ? 'border-white/[0.04] bg-white/[0.01] opacity-40 cursor-not-allowed'
            : isSelected
              ? tone.ring
              : 'border-white/[0.06] bg-white/[0.015] hover:bg-white/[0.04]'
        }`}
      >
        <span className={`mt-1 inline-flex h-3 w-3 shrink-0 rounded-full border ${
          isSelected ? `${tone.dot} border-white/30` : 'border-slate-600'
        }`} />
        <span className="flex-1 min-w-0">
          <span className="flex items-center justify-between gap-2">
            <span className={`text-[11px] font-mono font-semibold tracking-wider ${isSelected ? tone.text : 'text-slate-300'}`}>
              {title}
            </span>
            <span className="text-[10px] font-mono text-slate-400 tabular-nums">
              {formatBytes(scopeBytes[value])}
            </span>
          </span>
          <span className="block text-[11px] text-slate-400 leading-relaxed mt-0.5">
            {description}
          </span>
        </span>
      </button>
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[101] w-[min(520px,94vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-amber-400/30 bg-[#14171d] shadow-2xl shadow-black/70 outline-none"
          aria-describedby={undefined}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches) handleConfirm();
          }}
        >
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
            <Dialog.Title className="text-[12px] font-semibold tracking-[0.18em] uppercase text-amber-200">
              Clear storage · {songName}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="text-slate-500 hover:text-slate-200 text-lg leading-none w-6 h-6 flex items-center justify-center rounded hover:bg-white/[0.06]"
                aria-label="Close"
              >
                ×
              </button>
            </Dialog.Close>
          </div>

          <div className="px-5 py-4 space-y-3">
            {/* Full on-disk breakdown — so the user can see exactly what each
                scope will and won't touch before picking one. */}
            <div className="rounded border border-white/[0.06] bg-black/20 px-3 py-2">
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500 font-semibold mb-1.5">
                On disk · {formatBytes(totalBytes)}
              </div>
              <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-[11px] font-mono tabular-nums text-slate-400">
                <span className="text-slate-500">Stems</span>          <span>{formatBytes(storage?.caches.stems ?? 0)}</span>
                <span className="text-slate-500">Analysis</span>       <span>{formatBytes(storage?.caches.analysis ?? 0)}</span>
                <span className="text-slate-500">MSAF raw</span>       <span>{formatBytes(storage?.caches.msafRaw ?? 0)}</span>
                <span className="text-slate-500">BPM</span>            <span>{formatBytes(storage?.caches.bpm ?? 0)}</span>
                <span className="text-slate-500">Algo clusters</span>  <span>{formatBytes(storage?.caches.algoClusters ?? 0)}</span>
                <div className="col-span-2 my-1 h-px bg-white/[0.06]" />
                <span className="text-slate-300">Caches</span>         <span className="text-slate-300">{formatBytes(cacheBytes)}</span>
                <span className="text-slate-500">Annotations</span>    <span>{formatBytes(annotationsBytes)}</span>
                <span className="text-slate-500">Audio</span>          <span>{formatBytes(audioBytes)}</span>
              </div>
            </div>

            <p className="text-[11px] text-slate-400">Pick what to delete:</p>

            <div className="space-y-1.5">
              <ScopeOption
                value="STEM"
                title="STEM"
                description={
                  <>Demucs stem WAVs only. Other algorithm caches, annotations and audio stay intact.</>
                }
                accent="amber"
              />
              <ScopeOption
                value="ALGOS"
                title="ALGOS"
                description={
                  <>All regenerable caches: stems, allin1 / MSAF / ruptures outputs, BPM cache, LLM-vision responses, algo clusters. Annotations and audio stay intact.</>
                }
                accent="orange"
              />
              <ScopeOption
                value="EVERYTHING"
                title="EVERYTHING"
                description={
                  isDemo ? (
                    <>
                      Disabled in demo mode — demo visitors cannot delete songs from the shared corpus. Sign in to manage the dataset.
                    </>
                  ) : (
                    <>
                      Audio file <span className="text-slate-300 font-mono">({formatBytes(audioBytes)})</span>, every cache, AND every annotator's annotations <span className="text-slate-300 font-mono">({formatBytes(annotationsBytes)})</span>.
                    </>
                  )
                }
                accent="red"
                disabled={isDemo}
                disabledHint="Disabled in demo mode"
              />
            </div>

            {scope === 'EVERYTHING' && (
              <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-200 leading-relaxed">
                <span className="font-semibold uppercase tracking-wider">Warning</span> — the entire song <span className="font-mono text-red-100">"{songName}"</span> including the audio file <strong>and ALL annotators' annotations</strong> will be permanently deleted. There is no undo.
              </div>
            )}

            <div className="pt-1">
              <p className="text-[11px] text-slate-400">
                Type <span className={`font-mono ${
                  scope === 'EVERYTHING' ? 'text-red-300' :
                  scope === 'ALGOS'      ? 'text-orange-300' :
                                           'text-amber-300'
                }`}>{SCOPE_LABEL[scope]}</span> to confirm.
              </p>
              <input
                autoFocus
                type="text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={SCOPE_LABEL[scope]}
                className={`mt-1.5 w-full px-3 py-2 rounded bg-black/40 border text-[13px] font-mono text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-1 ${
                  scope === 'EVERYTHING'
                    ? 'border-red-500/40 focus:border-red-400/70 focus:ring-red-500/30'
                    : scope === 'ALGOS'
                      ? 'border-orange-400/40 focus:border-orange-300/70 focus:ring-orange-500/30'
                      : 'border-amber-400/30 focus:border-amber-300/60 focus:ring-amber-400/20'
                }`}
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/[0.06]">
            <Dialog.Close asChild>
              <button className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 transition-colors">
                Cancel
              </button>
            </Dialog.Close>
            <button
              onClick={handleConfirm}
              disabled={!matches || busy}
              className={`px-3 py-1.5 rounded text-[11px] uppercase tracking-wider border transition-colors ${
                matches && !busy
                  ? scope === 'EVERYTHING'
                    ? 'bg-red-500/25 hover:bg-red-500/35 text-red-100 border-red-400/50'
                    : scope === 'ALGOS'
                      ? 'bg-orange-500/25 hover:bg-orange-500/35 text-orange-100 border-orange-400/50'
                      : 'bg-amber-500/25 hover:bg-amber-500/35 text-amber-100 border-amber-400/50'
                  : 'bg-white/[0.04] text-slate-600 border-white/[0.06] cursor-not-allowed'
              }`}
            >
              {busy
                ? 'Deleting…'
                : scope === 'EVERYTHING'
                  ? `Delete EVERYTHING (${formatBytes(scopeBytes[scope])})`
                  : `Clear ${SCOPE_LABEL[scope]} (${formatBytes(scopeBytes[scope])})`}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
