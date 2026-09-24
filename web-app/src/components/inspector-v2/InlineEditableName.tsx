import { useEffect, useRef, useState } from 'react';

interface InlineEditableNameProps {
  /** Current name/label shown when not editing and seeded into the input. */
  value: string;
  /** Commit a new value. Called once on blur / Enter, only when it changed. */
  onChange: (next: string) => void;
  /** Shown (italic, muted) in place of an empty value and as the input hint. */
  placeholder?: string;
  /** Native title/tooltip on the display text. */
  title?: string;
  /** Accessible label + tooltip for the pencil button. */
  editLabel?: string;
  /** Classes for the wrapping element (display mode) — usually flex + min-w-0. */
  className?: string;
  /** Classes for the text span (display mode). */
  textClassName?: string;
  /** Inline styles for the text span — e.g. the line-clamp a lane label
   *  computes from its row height. Kept off `className` so the clamp can be a
   *  dynamic line count, and off the wrapper so the pencil never gets elided
   *  along with the name. */
  textStyle?: React.CSSProperties;
  /** Ref onto the text span, so a caller can measure the untruncated name. */
  textRef?: React.Ref<HTMLSpanElement>;
  /** Classes for the pencil button. */
  pencilClassName?: string;
  /** Classes for the input (edit mode). */
  inputClassName?: string;
  /**
   * When true, swallow click/mousedown/keydown so an ancestor role=button
   * (sidebar rows, canvas lanes) doesn't seek/select while editing. */
  stopPropagation?: boolean;
  /** Fires whenever edit mode opens or closes, so a cramped host (a canvas
   *  lane gutter, clipped to the row's own height) can lift its clipping and
   *  stacking for as long as the input is up. */
  onEditingChange?: (editing: boolean) => void;
  /** Leave the pencil out. For a host that offers Rename somewhere else (a
   *  lane's ⋮ menu) and opens the field through `editRequest`. */
  hidePencil?: boolean;
  /** Bump to open the field from outside — each new non-zero value opens it
   *  once, as if the pencil had been clicked. */
  editRequest?: number;
}

/**
 * Click-the-pencil-to-edit name field. Renders read-only text with a small
 * pencil affordance; clicking the pencil swaps in an auto-focused input. Edits
 * are held in a local draft and committed once — on Enter or blur — so each
 * rename is a single undo entry; Escape cancels without committing.
 *
 * Used for boundary labels and layer names across the Manual editor cards, the
 * unified annotation list, and the canvas lane labels so the affordance is
 * identical everywhere.
 */
export function InlineEditableName({
  value,
  onChange,
  placeholder = 'label',
  title,
  editLabel = 'Rename',
  className = '',
  textClassName = '',
  textStyle,
  textRef,
  pencilClassName = '',
  inputClassName = '',
  stopPropagation = false,
  onEditingChange,
  hidePencil = false,
  editRequest = 0,
}: InlineEditableNameProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      const el = inputRef.current;
      if (el) { el.focus(); el.select(); }
    }
  }, [editing]);

  const begin = () => { setDraft(value); setEditing(true); onEditingChange?.(true); };
  const commit = () => {
    setEditing(false);
    onEditingChange?.(false);
    const next = draft.trim();
    if (next !== value) onChange(next);
  };
  const cancel = () => { setEditing(false); onEditingChange?.(false); };

  const beginRef = useRef(begin);
  beginRef.current = begin;
  useEffect(() => {
    if (editRequest) beginRef.current();
  }, [editRequest]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onClick={stopPropagation ? (e) => e.stopPropagation() : undefined}
        onMouseDown={stopPropagation ? (e) => e.stopPropagation() : undefined}
        onKeyDown={(e) => {
          if (stopPropagation) e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
        placeholder={placeholder}
        spellCheck={false}
        // size={1} lets the input shrink below its intrinsic width so a
        // flex-1/min-w-0 parent can actually constrain it.
        size={1}
        className={inputClassName}
      />
    );
  }

  return (
    <span className={className}>
      <span ref={textRef} className={textClassName} style={textStyle} title={title}>
        {value || <span className="italic opacity-60">{placeholder}</span>}
      </span>
      {!hidePencil && <button
        type="button"
        aria-label={editLabel}
        title={editLabel}
        onClick={(e) => { if (stopPropagation) e.stopPropagation(); begin(); }}
        onMouseDown={stopPropagation ? (e) => e.stopPropagation() : undefined}
        className={pencilClassName}
      >
        ✎
      </button>}
    </span>
  );
}
