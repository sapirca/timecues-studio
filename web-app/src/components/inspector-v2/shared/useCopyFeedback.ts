import { useCallback, useEffect, useState } from 'react';

/** How long the "copied" state holds — long enough to be seen, short enough
 *  that the ⬇ is back before anyone wants a second copy on purpose. */
const COPIED_MS = 1800;
/** A click arms the feedback for this long. The copy lands on the next render,
 *  so anything later is some other change to the count (a song switch, a
 *  copy made elsewhere) and must not claim this click's success. */
const ARM_MS = 1000;

/** Copies that found the same thing already copied, and made nothing. */
const unchangedListeners = new Set<() => void>();

/** Said by a copy that found a layer of yours already holding exactly what it
 *  would make, and so made nothing: the ⬇ that was just clicked says so,
 *  instead of looking like a click that did nothing. */
export function announceCopyUnchanged(): void {
  for (const listener of unchangedListeners) listener();
}

/** Feedback for a lane's ⬇ "copy to a new layer". The copy itself is silent —
 *  the new layer appears in the Annotator Tool, not on this canvas — so without
 *  this the click looks like it did nothing and gets clicked again.
 *
 *  Success is read from `copyCount` (how many layers already hold a copy of
 *  this lane) going up, not from the click: a copy that is refused (no tempo,
 *  nothing to copy) must not say it worked. Call `arm(button)` in the click
 *  handler, before the copy. */
export function useCopyFeedback(copyCount: number) {
  const [armed, setArmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [unchanged, setUnchanged] = useState(false);
  const [tagAt, setTagAt] = useState<{ left: number; top: number } | null>(null);
  // The count is compared with the last render's, during render — the
  // "adjust state when a prop changes" pattern, so the ✓ shows in the same
  // paint as the copy rather than one effect later.
  const [prevCount, setPrevCount] = useState(copyCount);
  if (copyCount !== prevCount) {
    setPrevCount(copyCount);
    if (armed && copyCount > prevCount) {
      setArmed(false);
      setCopied(true);
    }
  }

  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), ARM_MS);
    // Only the ⬇ just clicked is armed, so only it hears the copy's answer.
    const onUnchanged = () => { setArmed(false); setUnchanged(true); };
    unchangedListeners.add(onUnchanged);
    return () => { window.clearTimeout(t); unchangedListeners.delete(onUnchanged); };
  }, [armed]);

  useEffect(() => {
    if (!unchanged) return;
    const t = window.setTimeout(() => setUnchanged(false), COPIED_MS);
    return () => window.clearTimeout(t);
  }, [unchanged]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(t);
  }, [copied]);

  /** `anchor` is the button the "Copied" tag floats beside. */
  const arm = useCallback((anchor: HTMLElement | null) => {
    const r = anchor?.getBoundingClientRect();
    setTagAt(r && r.width > 0 ? { left: r.right + 6, top: r.top + r.height / 2 } : null);
    setArmed(true);
  }, []);
  return { copied, unchanged, tagAt, arm };
}
