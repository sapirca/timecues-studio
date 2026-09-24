import { createPortal } from 'react-dom';
import { ROW_SIZES, SIGNAL_ROWS, SIGNAL_ROW_IDS, type RowSheetTarget, type RowSize } from './mobileRows';

/**
 * The phone's row sheet — what a tap on a row's name opens.
 *
 * On a phone the label gutter is a 20px strip with the name written up its
 * side (see `.tc-label-cell` in index.css), so the name itself is the one
 * thing that is not readable at a glance. The tap is the way to read it, and
 * while the sheet is up it is also where the row is changed: which signal the
 * row shows, how tall it is, where it sits, whether it is shown at all.
 */

export function MobileRowSheet({
  target, onClose, shownSignals, size, onSize, onSwap, onHide, onMoveUp, onMoveDown,
  markSources, markedKeys = [], onToggleMark,
}: {
  target: RowSheetTarget;
  onClose: () => void;
  /** Signal row ids currently drawn — marks the ones a swap would duplicate. */
  shownSignals: ReadonlySet<string>;
  size?: RowSize;
  onSize?: (s: RowSize) => void;
  /** Replace this row's signal with another; absent on non-signal rows. */
  onSwap?: (toRowId: string) => void;
  onHide?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** Boundary layers (`line`) and boundary detectors (`bar`) that can be drawn
   *  over this row, and which of them are. */
  markSources?: { key: string; name: string; color: string; kind: 'line' | 'bar' }[];
  markedKeys?: readonly string[];
  onToggleMark?: (key: string) => void;
}) {
  const isSignal = !!target.rowId && SIGNAL_ROW_IDS.has(target.rowId);
  const btn = 'h-10 px-3 rounded-md border text-[13px] font-medium disabled:opacity-35';
  return createPortal(
    <div className="fixed inset-0 z-[1000]" data-viz-dropdown-popover="">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/50" />
      <div
        role="dialog"
        aria-label={target.name}
        className="absolute inset-x-0 bottom-0 max-h-[75dvh] flex flex-col bg-[#14171d] border-t border-white/[0.18] rounded-t-xl shadow-2xl shadow-black/60"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        <div className="flex items-center gap-2 h-12 px-4 border-b border-white/[0.08] shrink-0">
          <span className="w-1 self-stretch my-3 rounded" style={{ background: target.color }} />
          <span className="flex-1 min-w-0 text-[15px] font-semibold truncate" style={{ color: target.color }}>
            {target.name}
          </span>
          <button type="button" onClick={onClose} className="h-9 px-3 -mr-2 text-[13px] text-slate-200">Done</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {isSignal && onSwap && (
            <section className="space-y-2">
              <h3 className="text-[11px] uppercase tracking-[0.16em] text-slate-400 font-semibold">Show in this row</h3>
              <div className="grid grid-cols-3 gap-1.5">
                {SIGNAL_ROWS.map((s) => {
                  const current = s.id === target.rowId;
                  const elsewhere = !current && shownSignals.has(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      disabled={current}
                      onClick={() => onSwap(s.id)}
                      className={`h-11 px-2 rounded-md border text-[12px] leading-tight text-left flex items-center gap-1.5 ${
                        current ? 'bg-white/[0.08] text-white' : 'border-white/[0.10] text-slate-200 active:bg-white/[0.06]'
                      }`}
                      style={current ? { borderColor: s.color } : undefined}
                      title={elsewhere ? `${s.label} is already another row — it moves here` : s.label}
                    >
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color }} />
                      <span className="min-w-0 truncate">{s.label}</span>
                      {elsewhere && <span className="ml-auto text-[10px] text-slate-500">on</span>}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-slate-500">A signal already on screen (“on”) moves into this row instead of appearing twice.</p>
            </section>
          )}
          {onSize && (
            <section className="space-y-2">
              <h3 className="text-[11px] uppercase tracking-[0.16em] text-slate-400 font-semibold">Row height</h3>
              <div className="flex gap-1.5">
                {ROW_SIZES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => onSize(s)}
                    aria-pressed={size === s}
                    className={`${btn} flex-1 ${size === s ? 'bg-white/[0.10] border-white/40 text-white' : 'border-white/[0.12] text-slate-300'}`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </section>
          )}
          {markSources && onToggleMark && (
            <section className="space-y-2">
              <h3 className="text-[11px] uppercase tracking-[0.16em] text-slate-400 font-semibold">Draw on this row</h3>
              {markSources.length === 0 ? (
                <p className="text-[12px] text-slate-500">No boundary layers or boundary detectors on this song yet.</p>
              ) : (
                <div className="space-y-1">
                  {markSources.map((m) => {
                    const on = markedKeys.includes(m.key);
                    return (
                      <label key={m.key} className="flex items-center gap-3 min-h-[40px] px-1 rounded active:bg-white/[0.04]">
                        <input type="checkbox" checked={on} onChange={() => onToggleMark(m.key)} className="w-4 h-4 accent-cyan-400" />
                        {/* The swatch is the mark itself: a rule for a layer
                            you annotated, a short bar for a detector's guess. */}
                        <span className="w-4 flex justify-center shrink-0" aria-hidden>
                          {m.kind === 'line'
                            ? <span className="block w-px h-4" style={{ background: m.color }} />
                            : <span className="block w-[3px] h-2.5 rounded-[1.5px]" style={{ background: m.color }} />}
                        </span>
                        <span className="flex-1 min-w-0 text-[13px] text-slate-200 truncate">{m.name}</span>
                        <span className="text-[11px] text-slate-500 shrink-0">{m.kind === 'line' ? 'layer' : 'detector'}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </section>
          )}
          {(onMoveUp || onMoveDown || onHide) && (
            <section className="space-y-2">
              <h3 className="text-[11px] uppercase tracking-[0.16em] text-slate-400 font-semibold">Row</h3>
              <div className="flex gap-1.5 flex-wrap">
                <button type="button" disabled={!onMoveUp} onClick={onMoveUp} className={`${btn} border-white/[0.12] text-slate-200`}>↑ Move up</button>
                <button type="button" disabled={!onMoveDown} onClick={onMoveDown} className={`${btn} border-white/[0.12] text-slate-200`}>↓ Move down</button>
                {onHide && (
                  <button type="button" onClick={onHide} className={`${btn} border-rose-400/30 text-rose-200 ml-auto`}>Hide row</button>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
