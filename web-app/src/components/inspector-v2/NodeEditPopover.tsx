/**
 * Floating edit popover for a single Riff Node — the library-primitive leaf
 * of the riff hierarchy. Unlike Combos/Instances, a Node is timeless (no
 * start/end), so this does NOT reuse `AnnotationPointCard` (built around a
 * time-based row); it's a small standalone card with the same visual
 * language (header drag handle, footer Delete/Done).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { RiffBoundarySegment, RiffNode } from '../../types/annotationLayer';
import { boundarySegmentsFromTaps, isBoundaryNode, riffNodeLengthBeats } from '../../types/annotationLayer';
import { getAudioBuffer } from '../../services/audioAnalysis';
import { computeOnsetEnvelopeWindow } from '../../services/mirAnalysis';
import type { FrameAxis } from '../../utils/frameTime';
import { sampleOnsetWindow } from '../../utils/onsetWindow';
import {
  BeatChipPicker, TapAlongControls, TapAlongPianoRoll, TapRefineControls,
  useBoundaryTapRefine, useTapAlong,
} from './BeatChipControls';
import {
  BoundarySegmentEditor, type BoundaryOnsetSource, type BoundaryTickSource,
} from './BoundarySegmentEditor';
import { NodeLengthControl } from './RiffPatternEditorPanel';
import { useAnnotationPopover, type PopoverAnchor } from './shared/useAnnotationPopover';

export type NodeEditAnchor = PopoverAnchor;

/** Picker id for a stem source. Namespaced so it can never collide with the
 *  full-mix entry or with a cue layer's own id. */
function stemSourceId(stem: string): string {
  return `stem:${stem}`;
}

export function useNodeEditPopover() {
  return useAnnotationPopover({ width: 320, height: 260 });
}

interface NodeEditPopoverProps {
  node: RiffNode;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  positionStyle: CSSProperties;
  onChange: (patch: Partial<RiffNode>) => void;
  onDelete: () => void;
  /** Closes the card. Returns `false` when a close guard vetoed it; `void`
   *  from callers that can't be vetoed. */
  onClose: () => boolean | void;
  /** Registers a hook the owning `useAnnotationPopover` runs before ANY close
   *  path (Done/×, outside click, Escape) actually closes — this card uses it
   *  to commit a live Tap Along take on the way out (and could veto a close
   *  by returning false). Pass `null` to clear. */
  registerCloseGuard: (guard: (() => boolean) | null) => void;
  bpm?: number;
  /** The first real spot on the timeline this node is actually placed
   *  (directly, or nested inside a combo) — null if it isn't used anywhere
   *  yet, in which case there's no real audio to preview. */
  occurrence: { start: number; end: number } | null;
  /** True while real playback is currently inside `occurrence`. */
  isPlaying?: boolean;
  /** The main player's current time — drives the karaoke sweep the same way
   *  RiffPatternEditPopover does. */
  currentTime?: number;
  /** Seeks the main player to `occurrence.start` (or `preRollSec` earlier,
   *  when given — used by Tap Along's count-in/loop) and plays through it —
   *  undefined when there's no occurrence to play. */
  onPlay?: (preRollSec?: number) => void;
  onStop?: () => void;
  /** When this popup was opened from a specific placed occurrence on the
   *  timeline (rather than the sidebar node list), that occurrence's actual
   *  length — independent of the node's own `stepsPerCycle`, since a
   *  placement can be drag-stretched on the canvas without touching the
   *  node's pattern. Null when there's no such occurrence (falls back to
   *  showing the node's own length). */
  entryLengthSteps?: number | null;
  /** Stretches the specific placement above — present iff `entryLengthSteps`
   *  is. Surfaced as its own STRETCH field: the LENGTH field edits the node
   *  itself, since shortening a node is nearly always meant as a trim. */
  onResizeEntry?: (lengthSteps: number) => void;
  /** Applies a new node length as a trim — see `NodeLengthControl`. */
  onTrimLength?: (lengthBeats: number) => void;
  /** Boundary nodes only: the layers whose items can be turned into this
   *  node's blocks — onsets/cues and lyrics alike — each converting at its
   *  exact fractional beat position inside `occurrence`. Empty when there's
   *  nothing to read (no placement, no bpm, or no layer with items in that
   *  window), in which case the button isn't offered. */
  tickSources?: readonly BoundaryTickSource[];
  /** Boundary nodes only: the song's onset-strength envelope (the browser-side
   *  spectral-flux curve) with the frame axis that says when each value
   *  happened. The slice covering `occurrence` is drawn behind the blocks and
   *  peak-picked into the "audio" onset reference, so a node can be checked
   *  against the actual transients without any detector layer loaded. Absent
   *  while the analysis is still running. */
  onsetEnvelope?: {
    values: readonly number[];
    /** Loudness (RMS) on the same frame axis, when the analysis reported it.
     *  Flux locates the hits; this is what says how long each one lasts, and
     *  so how long a block seeded from it should run. */
    level?: readonly number[];
    axis: FrameAxis;
  } | null;
  /** What `onsetEnvelope` actually is, for the picker's label — the page
   *  analyses whatever the player is loaded with, which is the full mix
   *  unless the user has switched the player over to a stem. */
  onsetEnvelopeName?: string;
  /** Isolated stems this node's blocks can be read against INSTEAD of that
   *  envelope. A full mix is a composite: the kick that defines the rhythm
   *  shares its transients with a vocal, a cymbal and a synth, and flux over
   *  the sum picks up all of them. Pointing the comparison at one stem is the
   *  difference between "23 onsets, 4 of them mine" and a drum track's actual
   *  hits. Each is fetched, decoded and analysed only once the picker selects
   *  it — the window is a few seconds, but the file is a whole song. */
  onsetStems?: readonly { id: string; name: string; url: string }[];
}

export function NodeEditPopover({
  node, popoverRef, positionStyle, onChange, onDelete, onClose, registerCloseGuard,
  occurrence, isPlaying, currentTime, onPlay, onStop,
  entryLengthSteps, onResizeEntry, onTrimLength,
  tickSources, onsetEnvelope, onsetEnvelopeName = 'audio', onsetStems,
}: NodeEditPopoverProps) {
  // Boundary nodes replace the whole beat-chip half of this card: no
  // subdivision and no chip grid. Tap Along still runs — it's the same
  // capture loop either way, only the commit differs (raw fractional
  // presses into blocks, instead of a quantised chip patch). Everything
  // else — name, length, placement, playback preview — is shared with grid
  // nodes.
  const boundary = isBoundaryNode(node);
  const lengthBeats = riffNodeLengthBeats(node);
  // Karaoke sweep: map the live playhead's fraction through the real
  // occurrence's duration onto the node's own step grid — correct regardless
  // of whether this particular placement's entry length was stretched away
  // from the node's natural stepsPerCycle (an entry can be resized on the
  // canvas independently of the node it references).
  const playheadStep =
    isPlaying && occurrence && currentTime != null
      ? ((currentTime - occurrence.start) / Math.max(0.001, occurrence.end - occurrence.start)) * node.stepsPerCycle
      : null;

  // The audio under this node, in the node's own beat coordinates — the same
  // linear mapping through `occurrence` the karaoke sweep uses above, so the
  // envelope, the blocks and the playhead cannot disagree. Memoised on the
  // window rather than on `occurrence` itself, which is rebuilt every render
  // (and this card re-renders on every playhead tick).
  const occStart = occurrence?.start ?? null;
  const occEnd = occurrence?.end ?? null;
  // Depends on the envelope's *parts*, not on the wrapper object: the curve
  // lives in the page's state and so keeps its identity, while the axis is
  // four numbers — whereas the `{ values, axis }` around them is rebuilt on
  // every render and would re-slice the window on every single tick.
  const onsetValues = onsetEnvelope?.values;
  const onsetLevels = onsetEnvelope?.level;
  const axisStep = onsetEnvelope?.axis.step ?? 0;
  const axisOffset = onsetEnvelope?.axis.offset ?? 0;
  const axisCount = onsetEnvelope?.axis.count ?? 0;
  const onsetWindow = useMemo(() => (
    boundary && onsetValues && axisCount > 0 && occStart != null && occEnd != null
      ? sampleOnsetWindow(
          onsetValues, { step: axisStep, offset: axisOffset, count: axisCount },
          occStart, occEnd, lengthBeats, { levels: onsetLevels },
        )
      : null
  ), [boundary, onsetValues, onsetLevels, axisStep, axisOffset, axisCount, occStart, occEnd, lengthBeats]);

  // Which onset source the editor's picker is showing. Held here, not just
  // inside the editor, because a stem's audio is only worth fetching once it
  // is the one being looked at — see the effect below. `null` is the editor's
  // own default (the first source) as well as its "off".
  const [onsetRefId, setOnsetRefId] = useState<string | null>(null);
  const selectedStem = (onsetStems ?? []).find((s) => stemSourceId(s.id) === onsetRefId) ?? null;
  const selectedStemId = selectedStem?.id ?? null;
  const selectedStemUrl = selectedStem?.url ?? null;

  // One decoded stem per popover lifetime, so flipping between drums and bass
  // to see which one the blocks actually follow re-fetches nothing. Dropped
  // with the card — these are whole-song buffers.
  const stemBuffers = useRef<Map<string, AudioBuffer>>(new Map());
  const [stemEnvelope, setStemEnvelope] = useState<
    { id: string; values: readonly number[]; level: readonly number[]; axis: FrameAxis } | null
  >(null);
  const [stemStatus, setStemStatus] = useState<'idle' | 'loading' | 'error'>('idle');

  useEffect(() => {
    if (!boundary || !selectedStemId || !selectedStemUrl || occStart == null || occEnd == null) {
      setStemEnvelope(null);
      setStemStatus('idle');
      return;
    }
    let cancelled = false;
    setStemStatus('loading');
    (async () => {
      try {
        let buffer = stemBuffers.current.get(selectedStemId);
        if (!buffer) {
          buffer = await getAudioBuffer(selectedStemUrl);
          stemBuffers.current.set(selectedStemId, buffer);
        }
        if (cancelled) return;
        // Only the frames under this placement — the fetch is the whole song,
        // the analysis is the few seconds being looked at.
        const env = computeOnsetEnvelopeWindow(buffer, occStart, occEnd);
        setStemEnvelope({
          id: selectedStemId,
          values: Array.from(env.values),
          level: Array.from(env.level),
          axis: env.axis,
        });
        setStemStatus('idle');
      } catch (err) {
        console.error('[riff-node] stem onset analysis failed', err);
        if (cancelled) return;
        setStemEnvelope(null);
        setStemStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, [boundary, selectedStemId, selectedStemUrl, occStart, occEnd]);

  // The selected stem's envelope on the node's own beat axis — the same
  // windowing the mix goes through above, so the two are directly comparable.
  const stemWindow = useMemo(() => (
    stemEnvelope && stemEnvelope.id === selectedStemId && occStart != null && occEnd != null
      ? sampleOnsetWindow(
          stemEnvelope.values, stemEnvelope.axis, occStart, occEnd, lengthBeats,
          { levels: stemEnvelope.level },
        )
      : null
  ), [stemEnvelope, selectedStemId, occStart, occEnd, lengthBeats]);

  // What the blocks can be compared against: the audio's own picked onsets
  // first (always there once the track is analysed), then one entry per
  // isolated stem, then every detected onset/cue layer that has something
  // inside this placement — the same sources the ⟳ menu re-seeds from, so
  // "snapped to X" and "seeded from X" mean the same X.
  const onsetSources = useMemo<BoundaryOnsetSource[]>(() => {
    const out: BoundaryOnsetSource[] = [];
    if (onsetWindow && onsetWindow.peakBeats.length > 0) {
      out.push({
        id: 'audio', name: onsetEnvelopeName,
        beats: onsetWindow.peakBeats, curve: onsetWindow.curve,
        levelCurve: onsetWindow.levelCurve,
      });
    }
    if (occStart != null && occEnd != null) {
      for (const stem of onsetStems ?? []) {
        const selected = stem.id === selectedStemId;
        out.push({
          id: stemSourceId(stem.id),
          name: stem.name,
          // Every stem is listed whether or not it has been read yet — a
          // picker that only offers what is already loaded can never be used
          // to load anything.
          beats: selected && stemWindow ? stemWindow.peakBeats : [],
          curve: selected && stemWindow ? stemWindow.curve : undefined,
          levelCurve: selected && stemWindow ? stemWindow.levelCurve : undefined,
          status: selected && stemStatus !== 'idle' ? stemStatus : undefined,
        });
      }
    }
    for (const s of tickSources ?? []) {
      if (s.kind === 'cues' && s.tickBeats && s.tickBeats.length > 0) {
        out.push({ id: s.id, name: s.name, beats: s.tickBeats });
      }
    }
    return out;
  }, [
    onsetWindow, onsetEnvelopeName, tickSources, onsetStems,
    selectedStemId, stemWindow, stemStatus, occStart, occEnd,
  ]);

  // Snap for the block editor, owned here rather than inside it so a tap
  // session commits at exactly the value the picker is showing — "with or
  // without snap" is the same one control in both directions.
  const [boundarySnap, setBoundarySnap] = useState(0);
  // Fold + vote for the tap review step, owned here for the same reason snap
  // is: the preview below and the Save above have to agree on them.
  const refine = useBoundaryTapRefine();

  const tapAlong = useTapAlong({
    stepsPerCycle: node.stepsPerCycle,
    subbeatsPerBeat: node.subbeatsPerBeat,
    playheadStep,
    isPlaying,
    onPlay,
    onStop,
    onChange: (patch) => onChange(patch),
    onSaveTaps: boundary
      ? (taps, numBeats) => onChange({ segments: boundarySegmentsFromTaps(taps, numBeats, boundarySnap, refine) })
      : undefined,
  });
  const tapPreview = tapAlong.previewPatch;
  // Live preview of the blocks the current session would commit — the
  // boundary counterpart of feeding `previewPatch` into the chip grid, so
  // taps are visible where they land instead of only after Save. Re-runs on
  // every snap change too, so flipping the picker during review re-quantises
  // what's on screen before anything is written.
  const tapSegments = boundary && tapAlong.phase !== 'idle' && tapAlong.tapEvents.length > 0
    ? boundarySegmentsFromTaps(tapAlong.tapEvents, tapAlong.numBeats, boundarySnap, refine)
    : null;
  // How many passes the take has, for the vote's ceiling — passes are
  // numbered from 0 and only counted once a tap lands in them.
  const tapPasses = tapAlong.tapEvents.reduce((m, t) => Math.max(m, t.pass + 1), 1);

  // Closing KEEPS the take. Every close path (Done/×, outside click, Escape)
  // commits the live Tap Along session through this guard, so the blocks the
  // user has been watching land in the editor above are exactly the blocks
  // the node ends up with — no confirm prompt, and nothing silently thrown
  // away. Discarding is the one explicit gesture it should be: Tap Along's
  // own ✕ / Cancel. (A commit is a normal node edit, so ⌘Z undoes it.)
  // `save` also stops the session's auto-loop, whatever phase it was in.
  const tapPhase = tapAlong.phase;
  const tapSave = tapAlong.save;
  useEffect(() => {
    registerCloseGuard(() => {
      if (tapPhase !== 'idle') tapSave();
      return true;
    });
    return () => registerCloseGuard(null);
  }, [registerCloseGuard, tapPhase, tapSave]);

  // The block list needs more horizontal room than a chip grid does.
  const width = boundary ? 420 : 320;
  const MARGIN = 12;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const seedKey = `${String(positionStyle.left)}|${String(positionStyle.top)}|${String(positionStyle.transform ?? '')}`;
  const lastSeedRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (lastSeedRef.current === seedKey) return;
    lastSeedRef.current = seedKey;
    const el = popoverRef.current;
    if (typeof window === 'undefined' || !el) return;
    const w = el.offsetWidth || width;
    const h = el.offsetHeight || 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const seedLeft = typeof positionStyle.left === 'number' ? positionStyle.left : (vw - w) / 2;
    const seedTop = typeof positionStyle.top === 'number' ? positionStyle.top : (vh - h) / 2;
    setPos({
      left: clamp(seedLeft, MARGIN, vw - w - MARGIN),
      top: clamp(seedTop, MARGIN, vh - h - MARGIN),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);

  const onHeaderPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, input, textarea, select, a')) return;
    const el = popoverRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const grabX = e.clientX - rect.left;
    const grabY = e.clientY - rect.top;
    const w = rect.width;
    const h = rect.height;
    e.preventDefault();
    const onMove = (ev: PointerEvent) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      setPos({
        left: clamp(ev.clientX - grabX, MARGIN, vw - w - MARGIN),
        top: clamp(ev.clientY - grabY, MARGIN, vh - h - MARGIN),
      });
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  const resolvedStyle: CSSProperties = pos
    ? { position: 'fixed', left: pos.left, top: pos.top, width }
    : { ...positionStyle, width };

  return (
    <div
      ref={popoverRef}
      data-annotation-popover
      style={resolvedStyle}
      className="z-50 bg-[#1e242e] border border-white/[0.16] rounded-md shadow-[0_0_28px_rgba(148,163,184,0.30),0_20px_45px_-12px_rgba(0,0,0,0.75)] p-3 space-y-2"
    >
      <div
        onPointerDown={onHeaderPointerDown}
        className="flex items-center gap-2 pb-1.5 border-b border-white/[0.04] cursor-move select-none"
      >
        <span
          className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
          style={{ background: node.color, boxShadow: `0 0 6px ${node.color}66` }}
        />
        <span className="text-[10px] uppercase tracking-wider font-medium text-orange-300">
          {boundary ? 'Boundary Node' : 'Node'}
        </span>
        <button
          onClick={onClose}
          className="w-5 h-5 rounded flex items-center justify-center text-slate-300 hover:text-slate-100 hover:bg-white/[0.06] text-[12px] ml-auto"
          title="Close (Esc)"
        >
          ×
        </button>
      </div>

      <label className="block">
        <span className="block text-[9px] uppercase tracking-wider text-slate-300 mb-0.5">Name</span>
        <input
          autoFocus
          value={node.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="short name (e.g. kick motif)"
          spellCheck={false}
          className="w-full bg-[#0a0b0d] border border-white/[0.06] rounded px-2 py-1 text-[12px] text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-orange-400/40"
        />
      </label>

      <NodeLengthControl
        node={node}
        onResize={(patch) => onChange(patch)}
        onResizeSubdivision={(patch) => onChange(patch)}
        onTrimLength={onTrimLength}
        entryLengthSteps={entryLengthSteps}
        onResizeEntry={onResizeEntry}
        showSubdivision={!boundary}
      />

      {boundary ? (
        <>
          <BoundarySegmentEditor
            color={node.color}
            segments={tapSegments ?? node.segments ?? []}
            lengthBeats={lengthBeats}
            // Straight relative-time position inside the node — the same
            // fraction the grid card turns into a step index, left in beats
            // instead, so nothing is rounded to a subdivision on the way.
            playheadBeat={playheadStep != null ? playheadStep / Math.max(1, node.subbeatsPerBeat) : null}
            onChange={(segments: RiffBoundarySegment[]) => onChange({ segments })}
            readOnly={tapAlong.phase !== 'idle'}
            tickSources={tickSources}
            onsetCurve={onsetWindow?.curve}
            levelCurve={onsetWindow?.levelCurve}
            onsetSources={onsetSources}
            onOnsetRefChange={setOnsetRefId}
            secPerBeat={occStart != null && occEnd != null && lengthBeats > 0
              ? (occEnd - occStart) / lengthBeats
              : undefined}
            snap={boundarySnap}
            onSnapChange={setBoundarySnap}
            onTapAtBeat={tapAlong.phase === 'recording'
              ? (beat) => tapAlong.tapAtStep(beat * tapAlong.subbeats)
              : undefined}
          />

          {tapAlong.phase !== 'idle' && (
            <TapAlongPianoRoll
              taps={tapAlong.tapEvents}
              numBeats={tapAlong.numBeats}
              playheadBeat={playheadStep != null ? playheadStep / tapAlong.subbeats : null}
              color={node.color}
            />
          )}

          {tapAlong.phase !== 'idle' && tapAlong.tapEvents.length > 0 && (
            <TapRefineControls {...refine} passes={tapPasses} />
          )}

          <TapAlongControls {...tapAlong} disabled={!onPlay} mode="boundary" />
        </>
      ) : (
        <>
          <div>
            <span className="block text-[9px] uppercase tracking-wider text-slate-300 mb-0.5">
              Beats
              {tapAlong.phase === 'recording' && (
                <span className="normal-case text-slate-500"> — tap along, or click a beat directly</span>
              )}
              {tapAlong.phase !== 'idle' && tapAlong.phase !== 'recording' && (
                <span className="normal-case text-slate-500"> — tap along, watch them land here</span>
              )}
            </span>
            <BeatChipPicker
              color={node.color}
              steps={tapPreview?.stepsPerCycle ?? node.stepsPerCycle}
              subbeatsPerBeat={tapPreview?.subbeatsPerBeat ?? node.subbeatsPerBeat}
              highlighted={tapPreview?.highlightedBeats ?? node.highlightedBeats}
              spans={tapPreview?.spans ?? node.spans}
              accents={tapPreview ? undefined : node.accents}
              onChange={(patch) => onChange(patch)}
              playheadStep={playheadStep}
              readOnly={tapAlong.phase !== 'idle'}
              onTapAlongTap={tapAlong.phase === 'recording' ? tapAlong.tapAtStep : undefined}
            />
          </div>

          {tapAlong.phase !== 'idle' && (
            <TapAlongPianoRoll
              taps={tapAlong.tapEvents}
              numBeats={tapAlong.numBeats}
              playheadBeat={playheadStep != null ? playheadStep / tapAlong.subbeats : null}
              color={node.color}
            />
          )}

          <TapAlongControls {...tapAlong} disabled={!onPlay} />
        </>
      )}

      <div className="flex items-center justify-between pt-1.5 border-t border-white/[0.04] gap-1.5">
        <button
          // Cancel any live Tap Along first: closing commits a session (see
          // the guard above) and there's nothing to commit it into — the node
          // is about to be deleted, and a save+delete pair would just be two
          // undo steps for one action.
          onClick={() => { tapAlong.cancel(); if (onClose() === false) return; onDelete(); }}
          className="px-3 py-1 rounded text-[10px] uppercase tracking-wider border transition-colors bg-red-500/20 border-red-400/40 text-red-200 hover:bg-red-500/30"
          title="Delete this node (⌘Z to undo)"
        >
          Delete
        </button>
        <div className="flex items-center gap-1.5">
          {/* Hidden during an active Tap Along session: this button shares
           *  `onPlay`/`onStop` with the tap-along loop below, and pausing
           *  from here while `recording` looks like "the pass reached its
           *  natural end" to that loop, which just restarts playback — so
           *  the button visibly does nothing. Tap Along's own Stop (which
           *  first drops the session into `review`) is the only way to
           *  actually stop playback while a session is live. */}
          {tapAlong.phase === 'idle' && (
            <button
              onClick={() => { if (isPlaying) onStop?.(); else onPlay?.(); }}
              disabled={!onPlay}
              className={`px-2.5 py-1 rounded text-[11px] border transition-colors ${
                !onPlay
                  ? 'bg-white/[0.02] text-slate-600 border-white/[0.06] cursor-not-allowed'
                  : isPlaying
                  ? 'bg-red-500/20 border-red-400/40 text-red-300 hover:bg-red-500/30'
                  : 'bg-[#0a0b0d] border-white/[0.08] text-orange-300 hover:text-orange-200 hover:border-orange-400/40'
              }`}
              title={!onPlay ? 'Place this node in a sequence to preview its real audio' : isPlaying ? 'Stop playback' : 'Play the real audio where this node is first used'}
            >
              {isPlaying ? '⏹' : '▶'}
            </button>
          )}
          {/* Says what it will do while a take is live — the close guard
           *  commits it, so this really is the Save button in that moment. */}
          <button
            onClick={onClose}
            className="px-3 py-1 rounded text-[10px] uppercase tracking-wider border bg-orange-500/20 border-orange-400/40 text-orange-200 hover:bg-orange-500/30"
            title={tapAlong.phase !== 'idle'
              ? 'Keep the tapping shown above and close (⌘Z to undo) — use Tap Along’s ✕ to throw it away instead'
              : undefined}
          >
            {tapAlong.phase !== 'idle' ? 'Save & Done' : 'Done'}
          </button>
        </div>
      </div>
    </div>
  );
}
