import { useCallback, useEffect, useState } from 'react';

// Opt-in flag that lets PlayerPanel raise its zoom ceiling beyond the
// dpr-aware buffer cap. When enabled, spectrogram-style canvases drop their
// internal devicePixelRatio to 1 so the buffer stays under the browser's
// max-canvas limit even at high zoom. Trade-off: overlay text/lines
// (frequency labels, beat grid, playhead) appear softer on HiDPI displays.
const ENABLED_KEY = 'tcz.extendedZoom.enabled';
// "Don't ask me again" — when set, the popup is suppressed and the cap stays
// at the standard (dpr-aware) value.
const DISMISSED_KEY = 'tcz.extendedZoom.dismissed';
// Second tier on top of extended: lift the ×32 multiplier ceiling so CSS width
// can exceed the spectrogram canvases' 32 000-px safe buffer. Past that point
// the spectrogram, chromagram, cepstrogram, and 3-Band canvases self-clamp
// their internal pixel buffer — i.e. their texture progressively softens with
// zoom. Time grid, playhead, and waveform stay crisp.
const ULTRA_ENABLED_KEY = 'tcz.ultraZoom.enabled';
const ULTRA_DISMISSED_KEY = 'tcz.ultraZoom.dismissed';
const CHANGE_EVENT = 'tcz:extendedZoomChange';

function readBool(key: string): boolean {
  if (typeof window === 'undefined') return false;
  try { return window.localStorage.getItem(key) === '1'; } catch { return false; }
}

function writeBool(key: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (value) window.localStorage.setItem(key, '1');
    else window.localStorage.removeItem(key);
  } catch { /* ignore quota */ }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export interface ExtendedZoomState {
  /** True when either Extended or Ultra zoom is active — drives the dpr clamp. */
  enabled: boolean;
  dismissed: boolean;
  setEnabled: (v: boolean) => void;
  setDismissed: (v: boolean) => void;
  /** Ultra tier: lifts PlayerPanel's cap multiplier ceiling past the safe-buffer size. */
  ultraEnabled: boolean;
  ultraDismissed: boolean;
  setUltraEnabled: (v: boolean) => void;
  setUltraDismissed: (v: boolean) => void;
}

export function useExtendedZoom(): ExtendedZoomState {
  const [extendedEnabled, setExtendedState] = useState<boolean>(() => readBool(ENABLED_KEY));
  const [dismissed, setDismissedState] = useState<boolean>(() => readBool(DISMISSED_KEY));
  const [ultraEnabled, setUltraState] = useState<boolean>(() => readBool(ULTRA_ENABLED_KEY));
  const [ultraDismissed, setUltraDismissedState] = useState<boolean>(() => readBool(ULTRA_DISMISSED_KEY));

  useEffect(() => {
    const handler = () => {
      setExtendedState(readBool(ENABLED_KEY));
      setDismissedState(readBool(DISMISSED_KEY));
      setUltraState(readBool(ULTRA_ENABLED_KEY));
      setUltraDismissedState(readBool(ULTRA_DISMISSED_KEY));
    };
    window.addEventListener(CHANGE_EVENT, handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handler);
      window.removeEventListener('storage', handler);
    };
  }, []);

  const setEnabled = useCallback((v: boolean) => writeBool(ENABLED_KEY, v), []);
  const setDismissed = useCallback((v: boolean) => writeBool(DISMISSED_KEY, v), []);
  const setUltraEnabled = useCallback((v: boolean) => {
    // Ultra implies extended — the dpr=1 clamp is what makes the buffer-overflow
    // canvases survive at all past the standard cap.
    if (v) writeBool(ENABLED_KEY, true);
    writeBool(ULTRA_ENABLED_KEY, v);
  }, []);
  const setUltraDismissed = useCallback((v: boolean) => writeBool(ULTRA_DISMISSED_KEY, v), []);

  return {
    enabled: extendedEnabled || ultraEnabled,
    dismissed,
    setEnabled,
    setDismissed,
    ultraEnabled,
    ultraDismissed,
    setUltraEnabled,
    setUltraDismissed,
  };
}

// Clamp a raw devicePixelRatio to the value that keeps the spectrogram-style
// canvas buffers under the browser's max-canvas limit. When extended zoom is
// on, these canvases must render at dpr=1 to avoid overflow at high zoom
// factors.
export function effectiveDpr(rawDpr: number, extendedZoom: boolean): number {
  return extendedZoom ? Math.min(rawDpr, 1) : rawDpr;
}
