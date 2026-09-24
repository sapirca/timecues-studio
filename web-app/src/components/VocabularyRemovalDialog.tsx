/**
 * Confirmation for a section-vocabulary edit that DROPS names.
 *
 * Removing a name from the vocabulary is not a display-only setting: the next
 * time a song whose annotation uses that name is opened, `normalizeSection`
 * re-types those sections to `unset` and the save that follows persists it. So
 * the edit reaches annotations the user isn't looking at, which is exactly the
 * kind of change that needs saying out loud before it happens rather than being
 * discovered later. Adding names never needs this dialog — nothing existing
 * changes meaning.
 *
 * Amber, not red, and a plain click to approve rather than DeleteConfirmDialog's
 * typed word: the consequence is recoverable (re-add the name and the section
 * keeps its label; the type is what got reset), so a typing ritual would be
 * theatre.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { sectionColor, sectionLabel } from './inspector-v2/sectionConstants';

export interface VocabularyRemovalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names present in the current vocabulary that the pending edit drops. */
  removed: string[];
  /** Apply the pending vocabulary change. */
  onConfirm: () => void;
}

export function VocabularyRemovalDialog({
  open,
  onOpenChange,
  removed,
  onConfirm,
}: VocabularyRemovalDialogProps) {
  const plural = removed.length === 1 ? 'name' : 'names';
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[101] w-[min(480px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-amber-500/40 bg-[#14171d] shadow-2xl shadow-black/70 outline-none"
          aria-describedby={undefined}
        >
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
            <Dialog.Title className="text-[12px] font-semibold tracking-[0.18em] uppercase text-amber-300">
              Remove section {plural}?
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
            <p className="text-[13px] text-slate-200 leading-relaxed">
              This edit drops {removed.length} section {plural} from your vocabulary:
            </p>
            <div className="flex flex-wrap gap-1">
              {removed.map((type) => (
                <span
                  key={type}
                  className="px-1.5 py-0.5 rounded text-[11px] font-mono line-through"
                  style={{
                    backgroundColor: `${sectionColor(type)}1A`,
                    color: sectionColor(type),
                    border: `1px solid ${sectionColor(type)}33`,
                  }}
                >
                  {sectionLabel(type)}
                </span>
              ))}
            </div>
            <p className="text-[12px] text-slate-400 leading-relaxed">
              Sections already annotated with {removed.length === 1 ? 'it' : 'them'} — in
              any song, by you — become{' '}
              <span className="font-mono text-slate-300">—</span> (Unset) the next time
              that song is opened, and stay that way once it saves. Their written labels
              are kept, so you can still see what each one was.
            </p>
            <p className="text-[12px] text-slate-400 leading-relaxed">
              Putting the {plural} back later restores {removed.length === 1 ? 'it' : 'them'}{' '}
              to the dropdown, but sections already reset to Unset stay Unset until you
              re-type them.
            </p>
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/[0.06]">
            <Dialog.Close asChild>
              <button className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 transition-colors">
                Cancel
              </button>
            </Dialog.Close>
            <button
              onClick={() => {
                onConfirm();
                onOpenChange(false);
              }}
              className="px-3 py-1.5 rounded text-[11px] uppercase tracking-wider bg-amber-500/25 hover:bg-amber-500/35 text-amber-100 border border-amber-400/50 transition-colors"
            >
              Remove · set to Unset
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
