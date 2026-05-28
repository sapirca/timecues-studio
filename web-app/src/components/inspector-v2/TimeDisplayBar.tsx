import type { PendingSelection } from './AnnotationOverlays';
import type { PreviewRegion } from './PreviewWindow';
import { CrosshairIcon } from './CrosshairIcon';

interface Props {
  currentTime: number;
  pendingSelection?: PendingSelection | null;
  previewRegion?: PreviewRegion | null;
  showPlaybackIcon?: boolean;
}

interface Selection { start: number; end: number }

function resolveSelection(
  pendingSelection: PendingSelection | null | undefined,
  previewRegion: PreviewRegion | null | undefined,
): Selection | null {
  if (pendingSelection) {
    const t1 = pendingSelection.t1;
    const t2 = pendingSelection.t2;
    if (t2 == null) return { start: t1, end: t1 };
    return t2 >= t1 ? { start: t1, end: t2 } : { start: t2, end: t1 };
  }
  if (previewRegion) return { start: previewRegion.start, end: previewRegion.end };
  return null;
}

function splitTime(totalSeconds: number) {
  const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : 0;
  const totalMs = Math.floor(safe * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return { h, m, s, ms };
}

const pad2 = (n: number) => n.toString().padStart(2, '0');
const pad3 = (n: number) => n.toString().padStart(3, '0');

function TimeReadout({ seconds, showMs, dim, large }: { seconds: number; showMs: boolean; dim?: boolean; large?: boolean }) {
  const { h, m, s, ms } = splitTime(seconds);
  const colorDigit = dim ? 'text-slate-500' : 'text-slate-100';
  const colorUnit = dim ? 'text-slate-600' : 'text-slate-400';
  const sizeDigit = large ? 'text-3xl sm:text-4xl' : 'text-base';
  const sizeUnit  = large ? 'text-xl sm:text-2xl' : 'text-xs';
  const gap = large ? 'gap-1.5' : 'gap-1';
  return (
    <div className={`flex items-baseline ${gap} font-mono tabular-nums tracking-tight ${colorDigit}`}>
      <span className={sizeDigit}>{pad2(h)}</span>
      <span className={`${sizeUnit} ${colorUnit}`}>h</span>
      <span className={sizeDigit}>{pad2(m)}</span>
      <span className={`${sizeUnit} ${colorUnit}`}>m</span>
      <span className={sizeDigit}>
        {pad2(s)}{showMs && <span className={colorUnit}>.</span>}{showMs && pad3(ms)}
      </span>
      <span className={`${sizeUnit} ${colorUnit}`}>s</span>
    </div>
  );
}

export function TimeDisplayBar({ currentTime, pendingSelection, previewRegion, showPlaybackIcon = true }: Props) {
  const selection = resolveSelection(pendingSelection, previewRegion);
  const hasSel = selection != null;
  const start = selection?.start ?? 0;
  const end = selection?.end ?? 0;

  return (
    <div className="flex flex-wrap items-stretch gap-3">
      <div className="flex flex-col justify-center px-4 py-2 rounded-md border border-white/[0.08] bg-[#0a0b0d]/90 shadow-inner shadow-black/40">
        <span className="text-[9px] uppercase tracking-[0.18em] text-slate-500 mb-0.5">Playback</span>
        <div className="flex items-center gap-2.5">
          {showPlaybackIcon && (
            <span className="text-amber-300/90 shrink-0 leading-none" title="Playhead position — used as the source for snap-to-playhead">
              <CrosshairIcon size={28} strokeWidth={1.5} />
            </span>
          )}
          <TimeReadout seconds={currentTime} showMs large />
        </div>
      </div>
      <div className="flex items-center gap-3 px-3 py-2 rounded-md border border-white/[0.08] bg-[#0a0b0d]/90 shadow-inner shadow-black/40">
        <span className="text-[9px] uppercase tracking-[0.18em] text-slate-500">Selection</span>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-[9px] uppercase tracking-wider text-slate-500 w-10">Start</span>
            <TimeReadout seconds={start} showMs dim={!hasSel} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] uppercase tracking-wider text-slate-500 w-10">End</span>
            <TimeReadout seconds={end} showMs dim={!hasSel} />
          </div>
        </div>
        {hasSel && (
          <div className="flex flex-col items-end pl-2 ml-1 border-l border-white/[0.06]">
            <span className="text-[9px] uppercase tracking-wider text-slate-500">Length</span>
            <span className="text-xs font-mono tabular-nums text-slate-300">
              {(end - start).toFixed(3)}s
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
