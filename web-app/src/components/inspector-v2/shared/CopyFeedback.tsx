import { createPortal } from 'react-dom';

/** The whole label cell lights up once, so the row that was copied is plain
 *  even when the ⬇ itself is a 14px glyph. Sits inside the (relative) cell. */
export function CopiedCellFlash({ show }: { show: boolean }) {
  if (!show) return null;
  return <span aria-hidden className="tc-copied-flash pointer-events-none absolute inset-0 z-0" />;
}

/** "✓ Copied to a new layer", floated beside the ⬇ — or, when a layer of
 *  yours already holds exactly that copy, "Already copied — nothing changed".
 *  Portalled because the label cell clips its overflow and is far narrower
 *  than the words. */
export function CopiedTag({ show, at, unchanged = false }: {
  show: boolean;
  at: { left: number; top: number } | null;
  unchanged?: boolean;
}) {
  if ((!show && !unchanged) || !at) return null;
  return createPortal(
    <span
      role="status"
      className="tc-copied-tag pointer-events-none fixed z-[1000] -translate-y-1/2 whitespace-nowrap rounded border border-emerald-400/50 bg-[#0d1f19] px-1.5 py-0.5 text-[11px] font-medium text-emerald-200 shadow-lg"
      style={{ left: at.left, top: at.top }}
    >
      {unchanged ? 'Already copied — nothing changed' : '✓ Copied to a new layer'}
    </span>,
    document.body,
  );
}
