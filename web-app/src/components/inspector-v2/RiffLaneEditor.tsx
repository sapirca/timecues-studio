/**
 * RiffLaneEditor — building one riff instance on its lane.
 *
 * Two parts. On the lane, under its own cells and on the same time axis, only
 * what happens in time: the instance's slots, their notes, dragging a slot to
 * reorder it, × to remove it, + at the end, the later passes. Every setting —
 * the riff's name and repeats, the selected node's name, pulse, times in a
 * row and edit scope, the node chips, Done — sits in one window floating
 * beside the riff (left of it, or right when the left has no room).
 * Everything a riff is made of is set here, without a sidebar:
 *
 *   * the instance — its name, and how many times the whole riff plays;
 *   * its sequence — a slot per node, played several times in a row
 *     (A ×2 is A twice in the sequence), a node added fresh or reused from
 *     the lane's chips, dragged onto a slot to swap it or between slots to
 *     insert it, a slot dragged by its tag to reorder, × to remove it;
 *   * a node's notes — a press on a step for a short note, a press dragged
 *     across steps for a note held until you let go, on the node's pulse;
 *   * one play, played differently — the same node, the change written as
 *     that play's occurrence: what it left out hollow, what it added ringed.
 *
 * An edit to a node changes every play of it. When the node plays more than
 * once, the lane asks first — every one, or only this play — and the scope
 * switch lets you pick before you edit.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { AnnotationLayer, RiffBoundarySegment, RiffNode, RiffPatternItem } from '../../types/annotationLayer';
import { riffNodeLengthBeats } from '../../types/annotationLayer';
import { MAX_PULSE, pulseFits, pulseNoteName, pulseOf } from '../../utils/pitchedRiff';
import {
  editNotes,
  insertEntry,
  isNodeEntry,
  moveEntry,
  newLaneNode,
  nodeNotes,
  nodeOnPulse,
  occurrenceAt,
  occurrenceFor,
  playedNotes,
  playsOfNode,
  removeEntry,
  replaceEntry,
  riffItem,
  riffNode,
  riffRuns,
  setRunCount,
  swapEntries,
  withItem,
  withNode,
  withNodeNotes,
  withOccurrence,
  withoutEmptyUnusedNodes,
} from './riffLaneEdit';

type RiffLayer = AnnotationLayer<'riff-patterns'>;
export type RiffLayerEdit = (layer: RiffLayer) => RiffLayer | null;

const HEAD_TOP = 4;
const HEAD_H = 22;
const SLOT_TOP = HEAD_TOP + HEAD_H;
const SLOT_H = 92;
const TAG_H = 22;
/** The height the editor takes under the lane, px: the slots, nothing else. */
export const RIFF_EDITOR_H = SLOT_TOP + SLOT_H + 8;
/** The settings window's width, and its gap to the riff, px. */
const WIN_W = 340;
const WIN_GAP = 16;
/** Narrower than this, a step can't be hit: the slot asks for a zoom. */
const MIN_STEP_PX = 6;

const MONO = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } as const;
const SECTION = 'text-[10px] tracking-[0.14em] text-gray-400 uppercase';
const ROWLABEL = 'text-[11px] text-gray-400';
const BTN = 'h-8 px-3 rounded-md border text-[12px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400';
const STEP_BTN = 'w-7 h-7 bg-gray-900 text-gray-200 disabled:opacity-30';

interface Pending { entry: number; notes: RiffBoundarySegment[] }
type Dnd = { kind: 'node'; id: string } | { kind: 'slot'; index: number };
type Over = { slot: number } | { gap: number } | null;

export interface RiffLaneEditorProps {
  layer: RiffLayer;
  itemId: string;
  duration: number;
  bpm: number;
  /** The row the editor sits in — measured to tell whether a step is wide
   *  enough to hit. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** From the top of the row to the editor's top: the lane's cells above it. */
  top: number;
  /** A new instance: nothing is kept until Done, and Esc throws it away. */
  draft: boolean;
  onEdit: (edit: RiffLayerEdit, opts?: { coalesceKey?: string }) => void;
  /** A node made while a draft is open belongs to the draft. */
  onNodeCreated?: (nodeId: string) => void;
  onDone: () => void;
  /** Draft: throw it away. Otherwise: close (every edit is already in, and
   *  undoable). */
  onDiscard: () => void;
}

export function RiffLaneEditor({
  layer, itemId, duration, bpm, containerRef, top, draft, onEdit, onNodeCreated, onDone, onDiscard,
}: RiffLaneEditorProps) {
  const item = riffItem(layer, itemId);
  const [selected, setSelected] = useState(0);
  const [scope, setScope] = useState<'all' | 'play'>('all');
  const [press, setPress] = useState<{ entry: number; a: number; b: number } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [dnd, setDnd] = useState<Dnd | null>(null);
  const [over, setOver] = useState<Over>(null);
  const [rowPx, setRowPx] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setRowPx(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setRowPx(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  const sequence = useMemo(() => item?.sequence ?? [], [item]);
  const sel = Math.max(0, Math.min(selected, sequence.length - 1));
  useEffect(() => { if (sel !== selected) setSelected(sel); }, [sel, selected]);

  const editItem = useCallback((fn: (l: RiffLayer, it: RiffPatternItem) => RiffPatternItem, opts?: { coalesceKey?: string }) => {
    onEdit((l) => {
      const it = riffItem(l, itemId);
      return it ? withoutEmptyUnusedNodes(withItem(l, fn(l, it))) : null;
    }, opts);
  }, [onEdit, itemId]);

  // Esc: a question open is answered "cancel"; otherwise the editor closes —
  // throwing a draft away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (pending) setPending(null);
      else if (dnd) { setDnd(null); setOver(null); }
      else onDiscard();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [pending, dnd, onDiscard]);

  // A note press ends wherever the pointer is let go — off the step, off the row.
  const commitPress = useCallback(() => {
    if (!press || !item) { setPress(null); return; }
    const entry = sequence[press.entry];
    const node = entry && riffNode(layer, entry.type);
    setPress(null);
    if (!node) return;
    const len = riffNodeLengthBeats(node);
    const occ = occurrenceAt(item, press.entry);
    const onPlay = !!occ || scope === 'play';
    const from = onPlay ? playedNotes(node, occ) : nodeNotes(node);
    const next = editNotes(from, press.a, press.b, pulseOf(node), len);
    if (onPlay) {
      editItem((_, it) => withOccurrence(it, press.entry, occurrenceFor(node, press.entry, next)));
    } else if (playsOfNode(layer, node.id) > 1) {
      setPending({ entry: press.entry, notes: next });
    } else {
      onEdit((l) => {
        const n = riffNode(l, node.id);
        return n ? withNode(l, withNodeNotes(n, next)) : null;
      });
    }
  }, [press, item, sequence, layer, scope, editItem, onEdit]);
  useEffect(() => {
    if (!press) return;
    const up = () => commitPress();
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    return () => {
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
    };
  }, [press, commitPress]);

  const secPerStep = 60 / bpm / 4;
  const reps = Math.max(1, Math.floor(item?.repeatCount ?? 1));
  const cycleSec = sequence.reduce((s, e) => s + e.lengthSteps, 0) * secPerStep;
  const pct = (t: number) => `${(t / Math.max(1e-9, duration)) * 100}%`;
  const pxPerSec = duration > 0 ? rowPx / duration : 0;
  const runs = useMemo(() => riffRuns(sequence), [sequence]);
  const runOf = (i: number) => runs.find((r) => i >= r.from && i < r.from + r.count)!;
  const startsAt = useMemo(() => {
    const out: number[] = [];
    let t = item?.start ?? 0;
    for (const e of sequence) { out.push(t); t += e.lengthSteps * secPerStep; }
    out.push(t);
    return out;
  }, [sequence, item?.start, secPerStep]);

  // Where the settings window floats: beside the riff as it is on screen now,
  // re-measured as the page or the zoomed track scrolls.
  const winRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; side: 'left' | 'right'; arrowY: number } | null>(null);
  const riffStart = item?.start ?? 0;
  const riffEnd = riffStart + cycleSec * reps;
  useLayoutEffect(() => {
    let raf = 0;
    const measure = () => {
      raf = 0;
      const row = containerRef.current;
      if (!row || duration <= 0) return;
      const r = row.getBoundingClientRect();
      const x0 = r.left + (riffStart / duration) * r.width;
      const x1 = Math.min(r.right, r.left + (riffEnd / duration) * r.width);
      const slotsMid = r.top + top + SLOT_TOP + SLOT_H / 2;
      const h = winRef.current?.offsetHeight ?? 460;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const roomLeft = x0 - WIN_GAP - WIN_W >= 8;
      const side: 'left' | 'right' = roomLeft ? 'left' : 'right';
      const left = roomLeft ? x0 - WIN_GAP - WIN_W : Math.min(vw - WIN_W - 8, x1 + WIN_GAP);
      const topPx = Math.max(8, Math.min(vh - h - 8, slotsMid - 120));
      const next = { left: Math.round(left), top: Math.round(topPx), side, arrowY: Math.round(slotsMid - topPx) };
      setPlace((p) => (p && p.left === next.left && p.top === next.top && p.side === next.side && p.arrowY === next.arrowY ? p : next));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [containerRef, duration, riffStart, riffEnd, top, rowPx]);

  if (!item) return null;

  const selEntry = sequence[sel];
  const selNode = selEntry && isNodeEntry(layer, selEntry.type) ? riffNode(layer, selEntry.type) ?? null : null;
  const selOcc = occurrenceAt(item, sel);
  const selPlays = selNode ? playsOfNode(layer, selNode.id) : 0;
  const onPlayScope = !!selOcc || scope === 'play';
  const selRun = sequence.length ? runOf(sel) : null;
  const nodeName = (id: string) => riffNode(layer, id)?.name ?? (id ? '?' : '');
  const seqCode = runs.map((r) => nodeName(r.type) + (r.count > 1 ? ` ×${r.count}` : '')).join('  ');
  const differing = (item.occurrences ?? []).length;
  const endBar = (t: number) => {
    const beats = t / (60 / bpm);
    return `${Math.floor(beats / 4) + 1}.${Math.floor(beats % 4) + 1}`;
  };

  const addNode = (id: string, at = sequence.length) => {
    editItem((l, it) => insertEntry(l, it, at, id));
    setSelected(at);
    setScope('all');
  };
  const addNewNode = () => {
    const lengthBeats = selNode ? riffNodeLengthBeats(selNode) : 4;
    const node = newLaneNode(layer, lengthBeats);
    const at = sequence.length;
    onEdit((l) => {
      const it = riffItem(l, itemId);
      if (!it) return null;
      const withN = withNode(l, node);
      return withItem(withN, insertEntry(withN, it, at, node.id));
    });
    onNodeCreated?.(node.id);
    setSelected(at);
    setScope('all');
  };
  const dropOnSlot = (index: number) => {
    const d = dnd;
    setDnd(null); setOver(null);
    if (!d) return;
    if (d.kind === 'node') editItem((l, it) => replaceEntry(l, it, index, d.id));
    else editItem((_, it) => swapEntries(it, d.index, index));
    setSelected(index);
  };
  const dropAtGap = (gap: number) => {
    const d = dnd;
    setDnd(null); setOver(null);
    if (!d) return;
    if (d.kind === 'node') { addNode(d.id, gap); return; }
    editItem((_, it) => moveEntry(it, d.index, gap));
    setSelected(d.index < gap ? gap - 1 : gap);
  };
  const allowDrop = (e: React.DragEvent) => { if (dnd) e.preventDefault(); };

  return (
    // The editor spans the row but draws only at the instance; the rest of it
    // lets clicks through to the lane (seek, other riffs) — only its own
    // pieces take the pointer.
    <div className="absolute inset-x-0 pointer-events-none [&>*]:pointer-events-auto" style={{ top, height: RIFF_EDITOR_H }} data-riff-lane-editor>
      {/* The instance: one frame over every pass it plays, its name on top. */}
      <div
        className="absolute rounded-md border-2 border-slate-300 pointer-events-none"
        style={{ left: pct(item.start), width: pct(cycleSec * reps), top: HEAD_TOP, height: HEAD_H + SLOT_H + 2 }}
      />
      <div
        className="absolute flex items-center gap-2.5 px-2 rounded-t-md bg-slate-800 text-[11px] text-gray-200 whitespace-nowrap overflow-hidden"
        style={{ ...MONO, left: pct(item.start), minWidth: 260, width: pct(cycleSec * reps), top: HEAD_TOP, height: HEAD_H }}
      >
        <span className="font-sans font-semibold text-[12px] text-gray-100">{item.label || 'unnamed riff'}</span>
        <span className="tracking-wider">{seqCode}</span>
        <span className="text-amber-200">×{reps}</span>
        {differing > 0 && <span className="text-gray-400">· {differing} {differing === 1 ? 'play differs' : 'plays differ'}</span>}
      </div>
      {/* The later passes of the whole riff: the same slots again, faded and
          hatched, each with its own plays' occurrences. Edited through pass
          1 — a click selects that slot's node there. */}
      {Array.from({ length: reps - 1 }, (_, k) => k + 1).flatMap((k) => sequence.map((entry, i) => {
        const node = isNodeEntry(layer, entry.type) ? riffNode(layer, entry.type) ?? null : null;
        const left = startsAt[i] + k * cycleSec;
        const width = startsAt[i + 1] - startsAt[i];
        const color = node?.color ?? '#475569';
        const play = k * sequence.length + i;
        const occ = occurrenceAt(item, play);
        return (
          <div
            key={`pass${k}:${i}`}
            className="absolute overflow-hidden rounded"
            style={{ left: pct(left), width: pct(width), top: SLOT_TOP, height: SLOT_H, border: `1px solid ${color}66`, background: `${color}08` }}
          >
            <div className="absolute inset-x-0 top-0 flex items-center gap-1.5 px-1.5 text-[11px] text-gray-300" style={{ ...MONO, height: TAG_H, background: '#0b1220' }}>
              <span className="w-2 h-2 rounded-sm shrink-0 opacity-70" style={{ background: color }} />
              <span className="font-semibold shrink-0">{node?.name ?? '◌'}</span>
              {occ && <span className="text-[10px] text-gray-400 truncate">· {occ.event}</span>}
            </div>
            {node && (
              <SlotNotes
                node={node}
                played={playedNotes(node, occ)}
                differs={!!occ}
                live={false}
                faint
                stepPx={0}
                press={null}
                onPress={() => {}}
                onEnter={() => {}}
                onSelect={() => { setSelected(i); setScope('all'); }}
              />
            )}
          </div>
        );
      }))}
      {Array.from({ length: reps - 1 }, (_, k) => k + 1).map((k) => (
        <div key={k} className="absolute pointer-events-none" style={{ left: pct(item.start + k * cycleSec), top: SLOT_TOP, height: SLOT_H }}>
          <div className="h-full border-l-2 border-dashed border-slate-300" />
          <span className="absolute left-1.5 bottom-1 px-1.5 rounded-full bg-slate-700 text-[10px] text-gray-200 whitespace-nowrap" style={MONO}>
            plays {k + 1}/{reps}
          </span>
        </div>
      ))}

      {/* The slots: the first pass, each entry under the time it plays. */}
      {sequence.map((entry, i) => {
        const node = isNodeEntry(layer, entry.type) ? riffNode(layer, entry.type) ?? null : null;
        const run = runOf(i);
        const copy = i - run.from;
        const isSel = i === sel;
        const left = startsAt[i];
        const width = startsAt[i + 1] - left;
        const color = node?.color ?? '#475569';
        const target = dnd && over && 'slot' in over && over.slot === i && !(dnd.kind === 'slot' && dnd.index === i);
        return (
          <div
            key={i}
            onDragOver={allowDrop}
            onDragEnter={() => { if (dnd) setOver({ slot: i }); }}
            onDrop={(e) => { e.preventDefault(); dropOnSlot(i); }}
            className="absolute overflow-hidden rounded"
            style={{
              left: pct(left), width: pct(width), top: SLOT_TOP, height: SLOT_H,
              border: isSel ? `2px solid ${color}` : `1px solid ${color}99`,
              background: isSel ? `${color}1f` : `${color}0d`,
              opacity: dnd?.kind === 'slot' && dnd.index === i ? 0.45 : 1,
            }}
          >
            <div className="absolute inset-x-0 top-0 flex" style={{ height: TAG_H, background: isSel ? `${color}55` : '#0b1220' }}>
              <button
                type="button"
                draggable
                onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(i)); setDnd({ kind: 'slot', index: i }); }}
                onDragEnd={() => { setDnd(null); setOver(null); }}
                onClick={() => { setSelected(i); setScope('all'); }}
                aria-label={`Select ${node?.name ?? 'rest'}${run.count > 1 ? `, ${copy + 1} of ${run.count} in a row` : ''}`}
                title="Click to edit · drag to move it in the riff"
                className="flex-1 min-w-0 flex items-center gap-1.5 px-1.5 text-left text-[11px] text-gray-100 cursor-grab"
                style={MONO}
              >
                <svg aria-hidden width="8" height="12" viewBox="0 0 8 12" className="shrink-0"><path d="M2 2h.01M6 2h.01M2 6h.01M6 6h.01M2 10h.01M6 10h.01" stroke="#94a3b8" strokeWidth="2.2" strokeLinecap="round" /></svg>
                <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: color }} />
                <span className="font-semibold shrink-0">{copy === 0 ? (node?.name ?? '◌') : ''}</span>
                {copy === 0 && run.count > 1 && <span className="text-amber-200">×{run.count}</span>}
                {run.count > 1 && (
                  <span
                    className="ml-auto px-1.5 rounded-full text-[10px] font-semibold"
                    style={{ background: copy === 0 ? color : '#334155', color: copy === 0 ? '#030712' : '#e2e8f0' }}
                  >
                    {copy + 1}/{run.count}
                  </span>
                )}
                {occurrenceAt(item, i) && <span className="text-[10px] text-gray-300 truncate">· {occurrenceAt(item, i)!.event}</span>}
              </button>
              <button
                type="button"
                disabled={sequence.length <= 1}
                onClick={() => editItem((_, it) => removeEntry(it, i))}
                aria-label={`Remove ${node?.name ?? 'this slot'} from the instance`}
                title={sequence.length <= 1 ? 'An instance plays at least one node' : 'Remove from the instance'}
                className="w-7 shrink-0 text-[14px] text-gray-300 hover:text-white disabled:opacity-30"
              >×</button>
            </div>
            {node && (
              <SlotNotes
                node={node}
                played={playedNotes(node, occurrenceAt(item, i))}
                differs={!!occurrenceAt(item, i)}
                live={isSel}
                faint={copy > 0 && !isSel}
                stepPx={(width * pxPerSec) / Math.max(1, node.stepsPerCycle)}
                press={press?.entry === i ? press : null}
                onPress={(step) => { setSelected(i); setPress({ entry: i, a: step, b: step }); }}
                onEnter={(step) => setPress((p) => (p && p.entry === i && p.b !== step ? { ...p, b: step } : p))}
                onSelect={() => { setSelected(i); setScope('all'); }}
              />
            )}
            {target && (
              <div className="absolute inset-x-0 bottom-0 flex items-center justify-center px-2 text-center text-[12px] text-white bg-gray-950/85 pointer-events-none" style={{ top: TAG_H }}>
                {dnd!.kind === 'node' ? `Drop — this slot plays ${nodeName(dnd!.id)} instead` : `Drop — swap places with ${node?.name ?? 'the rest'}`}
              </div>
            )}
          </div>
        );
      })}

      {/* While something is carried: a gap at every boundary to drop it in. */}
      {dnd && startsAt.map((t, gap) => {
        const hot = over && 'gap' in over && over.gap === gap;
        return (
          <div
            key={`gap${gap}`}
            onDragOver={allowDrop}
            onDragEnter={() => setOver({ gap })}
            onDrop={(e) => { e.preventDefault(); dropAtGap(gap); }}
            className="absolute flex justify-center z-10"
            style={{ left: `calc(${pct(t)} - 10px)`, width: 20, top: SLOT_TOP - 4, height: SLOT_H + 8 }}
          >
            <div className="h-full rounded" style={{ width: hot ? 6 : 3, background: hot ? '#f8fafc' : 'rgba(248,250,252,0.35)' }} />
          </div>
        );
      })}

      <button
        type="button"
        onClick={addNewNode}
        aria-label="Add a new node to this instance"
        title="Add a new node at the end of the riff"
        className="absolute z-10 w-8 h-9 rounded-lg border border-amber-400 bg-gray-900 text-amber-200 text-lg"
        style={{ left: `calc(${pct(startsAt[sequence.length])} - 16px)`, top: SLOT_TOP + (SLOT_H - 36) / 2 + 10 }}
      >+</button>

      {place && createPortal(
        <div
          ref={winRef}
          role="dialog"
          aria-label="Riff settings"
          data-riff-settings
          className="fixed z-50 flex flex-col rounded-xl border border-slate-600 bg-[#0b1120] shadow-2xl"
          style={{ left: place.left, top: place.top, width: WIN_W }}
        >
          {/* points at the riff */}
          <span
            aria-hidden
            className="absolute w-0 h-0"
            style={place.side === 'left'
              ? { right: -10, top: place.arrowY - 9, borderTop: '9px solid transparent', borderBottom: '9px solid transparent', borderLeft: `10px solid ${selNode?.color ?? layer.color}` }
              : { left: -10, top: place.arrowY - 9, borderTop: '9px solid transparent', borderBottom: '9px solid transparent', borderRight: `10px solid ${selNode?.color ?? layer.color}` }}
          />

          {/* the riff */}
          <div className="flex flex-col gap-2 px-3.5 pt-3 pb-2.5 rounded-t-xl bg-[#111a2e] border-b border-slate-800">
            <div className="flex items-center gap-2">
              <label htmlFor="riff-instance-name" className={SECTION}>Riff</label>
              <input
                id="riff-instance-name"
                type="text"
                value={item.label}
                placeholder="name it — e.g. Chorus riff"
                onChange={(e) => {
                  const label = e.target.value;
                  editItem((_, it) => ({ ...it, label }), { coalesceKey: `riff-instance-label:${itemId}` });
                }}
                className="flex-1 min-w-0 h-8 px-2.5 rounded-md border border-slate-700 bg-[#0b1120] text-[13px] font-semibold text-gray-100 outline-none focus:border-slate-500"
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] tracking-wider text-gray-200 truncate" style={MONO}>{seqCode}</span>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-[10px] text-gray-400">whole riff</span>
                <div className="flex items-center rounded-md border border-slate-700 overflow-hidden">
                  <button
                    type="button"
                    aria-label="The whole riff one time fewer"
                    disabled={reps <= 1}
                    onClick={() => editItem((_, it) => ({ ...it, repeatCount: Math.max(1, reps - 1) }))}
                    className={STEP_BTN}
                  >−</button>
                  <span className="min-w-8 text-center text-[12px] text-amber-200" style={MONO}>×{reps}</span>
                  <button
                    type="button"
                    aria-label="The whole riff one time more"
                    onClick={() => editItem((_, it) => ({ ...it, repeatCount: reps + 1 }))}
                    className={STEP_BTN}
                  >+</button>
                </div>
              </div>
            </div>
            <div className="text-[10px] text-slate-500" style={MONO}>
              ends {endBar(item.start + cycleSec * reps)}
              {differing > 0 && ` · ${differing} ${differing === 1 ? 'play differs' : 'plays differ'}`}
            </div>
          </div>

          {/* the selected node */}
          <div className="flex flex-col gap-2.5 px-3.5 py-3 border-b border-slate-800">
            {selNode ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: selNode.color }} aria-hidden />
                  <label htmlFor="riff-node-name" className={SECTION}>Node</label>
                  <input
                    id="riff-node-name"
                    type="text"
                    value={selNode.name}
                    onChange={(e) => {
                      const name = e.target.value;
                      onEdit((l) => {
                        const n = riffNode(l, selNode.id);
                        return n ? withNode(l, { ...n, name }) : null;
                      }, { coalesceKey: `riff-node-name:${selNode.id}` });
                    }}
                    className="w-24 h-8 px-2 rounded-md border bg-[#0b1120] text-[13px] text-gray-100 outline-none"
                    style={{ borderColor: selNode.color }}
                  />
                  <span className="text-[11px] text-slate-500 truncate">slot {sel + 1} of {sequence.length}</span>
                </div>
                <div className="grid items-center gap-x-2 gap-y-2" style={{ gridTemplateColumns: '84px 1fr' }}>
                  <span className={ROWLABEL}>Pulse</span>
                  <PulseStepper
                    pulse={pulseOf(selNode)}
                    lengthBeats={riffNodeLengthBeats(selNode)}
                    onPulse={(v) => onEdit((l) => {
                      const n = riffNode(l, selNode.id);
                      const next = n && nodeOnPulse(n, v);
                      return next ? withNode(l, next) : null;
                    })}
                  />
                  <span className={ROWLABEL}>In a row</span>
                  <div className="flex items-center w-max rounded-md border border-slate-700 overflow-hidden">
                    <button
                      type="button"
                      aria-label="Play it one time fewer in a row"
                      disabled={!selRun || selRun.count <= 1}
                      onClick={() => selRun && editItem((_, it) => setRunCount(it, selRun.from, selRun.count - 1))}
                      className={STEP_BTN}
                    >−</button>
                    <span className="min-w-9 text-center text-[13px] text-amber-200" style={MONO}>×{selRun?.count ?? 1}</span>
                    <button
                      type="button"
                      aria-label="Play it one time more in a row"
                      onClick={() => selRun && editItem((_, it) => setRunCount(it, selRun.from, selRun.count + 1))}
                      className={STEP_BTN}
                    >+</button>
                  </div>
                  <span className={ROWLABEL}>Edits change</span>
                  <div
                    role="radiogroup"
                    aria-label="What an edit changes"
                    className="flex h-8 rounded-md border border-slate-700 overflow-hidden text-[12px]"
                    style={{ opacity: selPlays > 1 || selOcc ? 1 : 0.45 }}
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={!onPlayScope}
                      disabled={!!selOcc}
                      title={selOcc ? 'This play already differs — Play as written to edit the node again' : `An edit changes every ${selNode.name} (${selPlays} ${selPlays === 1 ? 'play' : 'plays'})`}
                      onClick={() => setScope('all')}
                      className="flex-1 truncate px-1.5 disabled:cursor-not-allowed"
                      style={{ background: !onPlayScope ? selNode.color : '#0f172a', color: !onPlayScope ? '#030712' : '#e2e8f0', fontWeight: !onPlayScope ? 600 : 400 }}
                    >
                      Every {selNode.name} · {selPlays}
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={onPlayScope}
                      title={`An edit changes only this play — it stays ${selNode.name}, played differently this once`}
                      onClick={() => setScope('play')}
                      className="flex-1 border-l border-slate-700"
                      style={{ background: onPlayScope ? '#f8fafc' : '#0f172a', color: onPlayScope ? '#030712' : '#e2e8f0', fontWeight: onPlayScope ? 600 : 400 }}
                    >
                      This play
                    </button>
                  </div>
                  <span className={ROWLABEL}>This play</span>
                  <div className="flex items-center gap-1.5" style={{ opacity: selOcc ? 1 : 0.45 }}>
                    <span className="px-2 py-0.5 rounded-full bg-slate-200 text-gray-950 text-[10px] font-semibold" style={MONO}>
                      {selOcc ? selOcc.event : 'as written'}
                    </span>
                    <button
                      type="button"
                      disabled={!selOcc}
                      onClick={() => { editItem((_, it) => withOccurrence(it, sel, null)); setScope('all'); }}
                      className="h-7 px-2 rounded-md border border-slate-600 text-[11px] text-gray-200 disabled:cursor-not-allowed"
                    >
                      Play as written
                    </button>
                  </div>
                </div>
                <p className="text-[11px] leading-relaxed text-slate-500">
                  click a step: note · drag across steps: held note<br />
                  hollow = left out here · ringed = added here
                </p>
              </>
            ) : (
              <p className="text-[12px] text-gray-400">Click a slot on the lane to edit its node.</p>
            )}
          </div>

          {/* the lane's nodes */}
          <div className="flex flex-col gap-2 px-3.5 pt-2.5 pb-3 bg-[#0d1526] border-b border-slate-800">
            <div className="flex items-baseline justify-between gap-2">
              <span className={SECTION}>Nodes</span>
              <span className="text-[10px] text-slate-500">click to add · drag onto the lane</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={addNewNode} className={`${BTN} px-2.5 border-dashed border-amber-400 text-amber-200`}>+ New</button>
              {(layer.nodes ?? []).map((n) => (
                <button
                  key={n.id}
                  type="button"
                  draggable
                  onDragStart={(e) => { e.dataTransfer.setData('text/plain', n.id); setDnd({ kind: 'node', id: n.id }); }}
                  onDragEnd={() => { setDnd(null); setOver(null); }}
                  onClick={() => addNode(n.id)}
                  title={`Click to add ${n.name} at the end · drag it onto a slot to play it there, or between slots to insert it`}
                  className={`${BTN} px-2 flex items-center gap-1.5 bg-gray-900 text-gray-100 cursor-grab`}
                  style={{ borderColor: n.color }}
                >
                  <NodeThumb node={n} />
                  {n.name}
                </button>
              ))}
            </div>
          </div>

          {/* done */}
          <div className="flex flex-col gap-2 px-3.5 py-2.5">
            <span className="text-[10px] text-slate-500">{draft ? 'nothing is saved until Done' : 'changes apply as you make them'}</span>
            <div className="flex items-center gap-2">
              {/* A draft's Discard already deletes it; an existing instance is
                  taken off the lane as one undo step, then the editor closes. */}
              {!draft && (
                <button
                  type="button"
                  onClick={() => {
                    onEdit((l) => withoutEmptyUnusedNodes({ ...l, items: (l.items as RiffPatternItem[]).filter((it) => it.id !== itemId) }));
                    onDiscard();
                  }}
                  title="Delete this instance from the lane (⌘Z brings it back)"
                  className={`${BTN} border-red-500/70 text-red-300 hover:bg-red-500/15`}
                >
                  Delete
                </button>
              )}
              <div className="flex-1" />
              <button type="button" onClick={onDiscard} title="Esc" className={`${BTN} border-slate-700 text-gray-300 hover:border-slate-500`}>
                {draft ? 'Discard' : 'Close'}
              </button>
              <button type="button" onClick={onDone} className={`${BTN} px-4 border-emerald-500 bg-emerald-500 text-emerald-950 font-semibold`}>
                Done
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {pending && selNode && (
        <div
          role="alertdialog"
          aria-label={`Change every ${selNode.name}, or only this play?`}
          className="absolute z-20 w-[380px] p-3 rounded-lg border-2 border-slate-100 bg-gray-900 shadow-2xl flex flex-col gap-2.5"
          style={{ left: `min(${pct(startsAt[pending.entry])}, calc(100% - 390px))`, top: SLOT_TOP + 20 }}
        >
          <button
            type="button"
            onClick={() => setPending(null)}
            aria-label={`Cancel — leave every ${selNode.name} as it was (Esc)`}
            title="Cancel (Esc)"
            className="absolute right-1.5 top-1.5 w-8 h-8 rounded text-gray-300 text-lg hover:text-white"
          >×</button>
          <p className="text-[13px] text-gray-100 leading-snug pr-8">
            This changes every {selNode.name} on the lane ({selPlays} plays). Change them all, or only this play?
          </p>
          <div className="flex gap-2">
            <button type="button" autoFocus onClick={() => setPending(null)} title="Esc" className={`${BTN} border-gray-600 text-gray-200`}>
              Cancel
            </button>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => {
                const p = pending;
                setPending(null);
                onEdit((l) => {
                  const n = riffNode(l, selNode.id);
                  return n ? withNode(l, withNodeNotes(n, p.notes)) : null;
                });
              }}
              className={`${BTN} border-gray-600 text-gray-100`}
            >
              Change every {selNode.name}
            </button>
            <button
              type="button"
              onClick={() => {
                const p = pending;
                setPending(null);
                setScope('play');
                editItem((_, it) => withOccurrence(it, p.entry, occurrenceFor(selNode, p.entry, p.notes)));
              }}
              className={`${BTN} font-semibold text-gray-950`}
              style={{ background: selNode.color, borderColor: selNode.color }}
            >
              Only this play
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** One slot's notes on its node's pulse. Live: every step a target — a press
 *  starts a note, dragging across steps holds it. What the play left out of
 *  its node is drawn hollow, what it added ringed. */
function SlotNotes({ node, played, differs, live, faint, stepPx, press, onPress, onEnter, onSelect }: {
  node: RiffNode;
  played: RiffBoundarySegment[];
  differs: boolean;
  live: boolean;
  faint: boolean;
  stepPx: number;
  press: { a: number; b: number } | null;
  onPress: (step: number) => void;
  onEnter: (step: number) => void;
  onSelect: () => void;
}) {
  const steps = Math.max(1, node.stepsPerCycle);
  const pulse = pulseOf(node);
  const len = riffNodeLengthBeats(node);
  const own = nodeNotes(node);
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const missing = differs ? own.filter((s) => !played.some((p) => near(p.start, s.start) && near(p.end, s.end))) : [];
  const isAdded = (p: RiffBoundarySegment) => differs && !own.some((s) => near(p.start, s.start) && near(p.end, s.end));
  const x = (beat: number) => `${(beat / len) * 100}%`;
  const hittable = live && stepPx >= MIN_STEP_PX;
  const lo = press ? Math.min(press.a, press.b) : 0;
  const hi = press ? Math.max(press.a, press.b) : 0;

  return (
    <div className="absolute inset-x-0 bottom-0" style={{ top: TAG_H, opacity: faint ? 0.55 : 1 }}>
      {faint && (
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'repeating-linear-gradient(135deg, rgba(3,7,18,0.55) 0 6px, rgba(3,7,18,0.3) 6px 12px)' }} />
      )}
      {missing.map((m, k) => (
        <div
          key={`m${k}`}
          className="absolute top-1 bottom-1 rounded-sm pointer-events-none"
          style={{ left: x(m.start), width: x(m.end - m.start), boxShadow: `inset 0 0 0 2px ${node.color}` }}
        />
      ))}
      {played.map((p, k) => (
        // Exactly the note's steps, one plain block however long it is held;
        // a dark hairline at the attack keeps two neighbouring hits from
        // reading as one held note.
        <div
          key={`n${k}`}
          className="absolute top-1 bottom-1 rounded-sm pointer-events-none"
          style={{
            left: x(p.start), width: x(p.end - p.start),
            borderLeft: p.start > 0 ? '1px solid #030712' : undefined,
            background: node.color,
            boxShadow: isAdded(p) ? 'inset 0 0 0 2px #f8fafc' : undefined,
          }}
        />
      ))}
      {/* While dragging: the note it will become, outlined, with its length. */}
      {press && hi > lo && (
        <div
          className="absolute top-1 bottom-1 flex items-center justify-center rounded-sm pointer-events-none"
          style={{ left: x(lo / pulse), width: x((hi - lo + 1) / pulse), background: `${node.color}b3`, boxShadow: 'inset 0 0 0 2px #f8fafc' }}
        >
          <span className="px-1.5 rounded-full bg-gray-950/80 text-white text-[10px] font-semibold whitespace-nowrap" style={MONO}>
            {hi - lo + 1} steps
          </span>
        </div>
      )}
      {hittable && Array.from({ length: steps }, (_, s) => (
        <button
          key={s}
          type="button"
          aria-label={`${node.name}, beat ${Math.floor(s / pulse) + 1}, step ${(s % pulse) + 1}`}
          onPointerDown={(e) => { e.preventDefault(); onPress(s); }}
          onPointerEnter={() => onEnter(s)}
          className="absolute top-0 bottom-0 touch-none"
          style={{
            left: x(s / pulse), width: x(1 / pulse),
            borderLeft: s === 0 ? 'none' : `1px solid ${s % pulse === 0 ? `${node.color}88` : 'rgba(148,163,184,0.14)'}`,
          }}
        />
      ))}
      {live && !hittable && (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-gray-300 bg-gray-950/60 text-center px-1">
          zoom in to draw notes
        </div>
      )}
      {!live && (
        <button type="button" aria-label={`Edit ${node.name}`} onClick={onSelect} className="absolute inset-0" />
      )}
    </div>
  );
}

/** A node's notes in a 36 px strip — the chip's picture of it. */
function NodeThumb({ node }: { node: RiffNode }) {
  const len = riffNodeLengthBeats(node) || 1;
  return (
    <span className="relative w-9 h-3.5 rounded-sm bg-gray-950 shrink-0" aria-hidden>
      {nodeNotes(node).map((n, k) => (
        <span
          key={k}
          className="absolute top-0.5 bottom-0.5 rounded-[1px]"
          style={{ left: `${(n.start / len) * 100}%`, width: `max(1.5px, calc(${((n.end - n.start) / len) * 100}% - 1px))`, background: node.color }}
        />
      ))}
    </span>
  );
}

/** The node's pulse as its divider: one step is 1/N of a beat, N typed or
 *  stepped with −/+, and the note it makes said beside it (1/16 → 1/64 note).
 *  −/+ skip a divider the node's length has no whole number of steps on;
 *  a typed one that doesn't fit is refused and the field shows the pulse
 *  again. */
export function PulseStepper({ pulse, lengthBeats, onPulse }: {
  pulse: number;
  lengthBeats: number;
  onPulse: (pulse: number) => void;
}) {
  // What's typed, until Enter or blur; otherwise the field shows the pulse.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? String(pulse);
  const fits = (v: number) => v >= 1 && v <= MAX_PULSE && pulseFits(lengthBeats, v);
  const nextFit = (dir: 1 | -1) => {
    for (let v = pulse + dir; v >= 1 && v <= MAX_PULSE; v += dir) if (fits(v)) return v;
    return null;
  };
  const down = nextFit(-1);
  const up = nextFit(1);
  const commit = () => {
    const v = Math.round(Number(text));
    if (v !== pulse && fits(v)) onPulse(v);
    setDraft(null);
  };
  return (
    <div className="flex items-center gap-2 min-w-0" style={MONO}>
      <div className="flex items-center rounded-md border border-slate-700 overflow-hidden">
        <button
          type="button"
          aria-label="Coarser pulse"
          title={down ? `1/${down} beat · ${pulseNoteName(down)}` : 'Already the coarsest pulse'}
          disabled={!down}
          onClick={() => down && onPulse(down)}
          className={STEP_BTN}
        >−</button>
        <span className="pl-2 text-[13px] text-slate-400">1/</span>
        <input
          aria-label="Pulse divider: one step is 1/N of a beat"
          title={`The grid the notes are written on: 1 to ${MAX_PULSE} steps per beat (${MAX_PULSE} = 1/64 notes). Changing it moves every note to the nearest step of the new one.`}
          inputMode="numeric"
          value={text}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') setDraft(null);
            else if (e.key === 'ArrowUp' && up) { e.preventDefault(); onPulse(up); }
            else if (e.key === 'ArrowDown' && down) { e.preventDefault(); onPulse(down); }
          }}
          className="w-8 h-7 bg-transparent text-center text-[13px] text-amber-200 outline-none"
        />
        <button
          type="button"
          aria-label="Finer pulse"
          title={up ? `1/${up} beat · ${pulseNoteName(up)}` : `Already the finest pulse that fits (max 1/${MAX_PULSE})`}
          disabled={!up}
          onClick={() => up && onPulse(up)}
          className={STEP_BTN}
        >+</button>
      </div>
      <span className="text-[11px] text-slate-400 truncate">beat · {pulseNoteName(pulse)}</span>
    </div>
  );
}
