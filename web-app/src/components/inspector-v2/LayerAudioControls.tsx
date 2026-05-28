import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';

export interface LayerAudioConfig {
  enabled: boolean;
  gain: number; // 0..1
  pan: number;  // -1..1
}

export const DEFAULT_LAYER_AUDIO: LayerAudioConfig = {
  enabled: false,
  gain: 0.6,
  pan: 0,
};

/** Plays one short pip at the user's current settings — for the "Test" button. */
function playTestPip(gain: number, pan: number, freq: number) {
  const Ctor: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctor();
  const startAt = ctx.currentTime + 0.02;
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = freq;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, startAt);
  env.gain.linearRampToValueAtTime(Math.max(0.01, gain), startAt + 0.0005);
  env.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.030);
  const panner = ctx.createStereoPanner();
  panner.pan.value = pan;
  osc.connect(env).connect(panner).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + 0.07);
  setTimeout(() => void ctx.close(), 200);
}

/**
 * Labeled button that opens a popover for a layer's auralisation config —
 * enable/disable click pip, volume, and stereo pan. When `label` is set,
 * renders as `[♪ Label]` for use in a horizontal mixer row; without label
 * it falls back to a compact icon-only button.
 */
export function LayerAudioControls({
  value,
  onChange,
  accentColor,
  label,
  testFreq = 1200,
}: {
  value: LayerAudioConfig;
  onChange: (next: LayerAudioConfig) => void;
  accentColor?: string;
  label?: string;
  testFreq?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current && !ref.current.contains(target) && popoverRef.current && !popoverRef.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Position the portal-rendered popover just below the trigger, in viewport coords.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const update = () => {
      const rect = triggerRef.current!.getBoundingClientRect();
      const popoverWidth = 240;
      const margin = 8;
      // Prefer aligning popover's left edge with trigger's left, but flip to right-aligned if it would overflow viewport.
      let left = rect.left;
      if (left + popoverWidth + margin > window.innerWidth) {
        left = Math.max(margin, window.innerWidth - popoverWidth - margin);
      }
      setPopoverPos({ top: rect.bottom + 4, left });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  const accent = accentColor ?? '#a78bfa';
  const iconColor = value.enabled ? accent : '#9ca3af';
  const iconBg = value.enabled ? `${accent}22` : 'transparent';
  const borderColor = value.enabled ? `${accent}88` : '#374151';

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className={
          label
            ? 'flex items-center gap-1 text-[10px] leading-none px-1.5 py-0.5 rounded border hover:bg-gray-800 transition-colors'
            : 'text-[12px] leading-none w-4 h-4 rounded-sm flex items-center justify-center hover:bg-gray-700 transition-colors'
        }
        title={value.enabled ? `${label ?? 'Auralisation'} on — click to configure` : `Click to enable click-pip on ${label ?? 'this layer'}`}
        style={label ? { color: iconColor, background: iconBg, borderColor } : { color: iconColor, background: iconBg }}
      >
        <span>♪</span>
        {label && <span className="uppercase tracking-wide">{label}</span>}
        {label && <span className="opacity-60">▾</span>}
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          className="fixed z-[1000] bg-gray-900 border border-gray-700 rounded shadow-lg p-3 w-60"
          style={{ top: popoverPos.top, left: popoverPos.left }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-[10px] text-gray-400 leading-snug mb-2">
            Plays a short <span className="text-gray-200">pip sound</span> on top of the music whenever the playhead crosses a {label ?? 'layer'} boundary. Doesn't affect music volume.
          </p>
          <label className="flex items-center gap-2 text-[11px] text-gray-200 mb-3 cursor-pointer">
            <input
              type="checkbox"
              checked={value.enabled}
              onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
            />
            <span>Enable click-on-boundary</span>
          </label>
          <div className="space-y-2">
            <div>
              <div className="flex items-center justify-between text-[9px] text-gray-500 uppercase tracking-wide">
                <span>Click volume</span>
                <span>{Math.round(value.gain * 100)}%</span>
              </div>
              <input
                type="range" min={0} max={1} step={0.01}
                value={value.gain}
                onChange={(e) => onChange({ ...value, gain: +e.target.value })}
                className="w-full"
                disabled={!value.enabled}
              />
              <div className="text-[8px] text-gray-600 mt-0.5">Volume of the pip sound, not the music.</div>
            </div>
            <div>
              <div className="flex items-center justify-between text-[9px] text-gray-500 uppercase tracking-wide">
                <span>Stereo pan</span>
                <span>{value.pan === 0 ? 'Center' : value.pan < 0 ? `${Math.round(-value.pan * 100)}% Left` : `${Math.round(value.pan * 100)}% Right`}</span>
              </div>
              <input
                type="range" min={-1} max={1} step={0.05}
                value={value.pan}
                onChange={(e) => onChange({ ...value, pan: +e.target.value })}
                className="w-full"
                disabled={!value.enabled}
              />
              <div className="text-[8px] text-gray-600 mt-0.5">Which ear the pip plays in (use headphones to compare layers).</div>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => playTestPip(value.gain, value.pan, testFreq)}
              className="text-[10px] px-2 py-1 rounded border border-gray-700 hover:border-gray-500 hover:bg-gray-800 text-gray-200 transition-colors"
              disabled={value.gain === 0}
              title={value.gain === 0 ? 'Click volume is 0 — raise it first' : 'Play one pip at current settings'}
            >
              ▸ Test pip
            </button>
            <button
              type="button"
              onClick={() => onChange({ enabled: value.enabled, gain: 0.6, pan: 0 })}
              className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
              title="Reset volume to 60% and pan to center"
            >
              Reset
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
