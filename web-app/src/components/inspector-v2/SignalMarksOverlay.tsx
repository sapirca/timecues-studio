/**
 * Annotation and detector marks drawn over a signal row — the answer to "put
 * the boundaries on top of the spectrogram": the row keeps its own signal and
 * the marks sit on the same time axis, so a section change can be checked
 * against what the audio does there without looking between two rows.
 *
 * Two looks, so an annotator's boundaries and a detector's guesses never read
 * as the same thing:
 *   lines — a boundary layer's section starts, a thin full-height rule.
 *   bars  — a detector's boundaries, a short narrow bar hung from the row's
 *           top edge (about two dot-diameters tall), which leaves the signal
 *           under it readable where a full rule would cover it.
 *
 * Which marks a row carries is chosen in the phone's row sheet. Positions are
 * a share of the song's duration, the same axis every row's content spans.
 */
export interface SignalMark { t: number; color: string }

export function SignalMarksOverlay({ lines, bars, duration }: {
  lines: readonly SignalMark[];
  bars: readonly SignalMark[];
  duration: number;
}) {
  if (duration <= 0 || (lines.length === 0 && bars.length === 0)) return null;
  const left = (t: number) => `${(Math.max(0, Math.min(duration, t)) / duration) * 100}%`;
  return (
    <div className="absolute inset-0 pointer-events-none z-[5] overflow-hidden" aria-hidden>
      {lines.map((m, i) => (
        <span
          key={`l${i}`}
          className="absolute top-0 bottom-0 w-[2px] -translate-x-1/2"
          style={{ left: left(m.t), background: m.color, boxShadow: '0 0 0 1px rgba(5,0,15,0.7)' }}
        />
      ))}
      {bars.map((m, i) => (
        <span
          key={`b${i}`}
          className="absolute top-[2px] h-[14px] w-[3px] -translate-x-1/2 rounded-[1.5px]"
          style={{ left: left(m.t), background: m.color, boxShadow: '0 0 0 1px #05000f' }}
        />
      ))}
    </div>
  );
}
