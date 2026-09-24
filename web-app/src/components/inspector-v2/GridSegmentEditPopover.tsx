// Floating editor for one grid segment. Opens on a click in the segment lane
// and rides the shared popover machinery (positioning, outside-click, Escape,
// single-popover exclusivity) that every annotation card already uses.
//
// Four things and no more: where the segment starts, how fast it runs, what
// meter it counts in, and a way out. There is deliberately no type, label or
// vocabulary field — a segment is the ruler, not an annotation on it.
//
// The tempo and meter can also be read off the segment's OWN audio, which is
// the only detection that means anything here: a segment exists because the
// count restarts at its start, so a whole-song estimate describes neither it
// nor its neighbour. See services/segmentGridDetection.ts.
//
// The way out is a MERGE, not a delete: dropping this segment's head joins its
// span to the segment before it, which counts on at its own tempo and meter.
// Nothing about the song is lost — only this segment's own count — so the
// button says what happens rather than reaching for the word "delete".
//
// The opening segment is special: its start IS the song's downbeat and its
// tempo and meter ARE the song's, so editing it writes those fields and it
// cannot be merged away — there is nothing before it. The footer says so
// rather than leaving a dead button unexplained.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ResolvedSegment } from '../../utils/gridSegments';
import { cutPreviewAt } from '../../utils/gridSegments';
import { useAnnotationPopover } from './shared/useAnnotationPopover';
import { formatClockTime } from '../../utils/clockTime';
import {
  detectSegmentGrid,
  segmentTooShortReason,
  type SegmentGridDetection,
} from '../../services/segmentGridDetection';

const QUICK_METERS = ['4/4', '3/4', '6/8', '7/8'];
const OTHER_METERS = ['5/4', '2/4', '12/8'];

const BPM_MIN = 20;
const BPM_MAX = 300;

export function useGridSegmentPopover() {
  return useAnnotationPopover({ width: 300, height: 400 });
}

export interface GridSegmentEditPopoverProps {
  segment: ResolvedSegment;
  /** The whole table, for the "what does this cut" footer. */
  segments: readonly ResolvedSegment[];
  total: number;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  positionStyle: CSSProperties;
  barBeatOrigin?: 0 | 1;
  locked?: boolean;
  /** `live` marks a value still being typed or nudged: apply it to the grid
   *  now, but fold the whole run into one undo step. The blur that ends the
   *  run re-commits nothing — the value already landed. */
  onChange: (
    patch: { start?: number; bpm?: number; timeSignature?: string },
    opts?: { live?: boolean },
  ) => void;
  /** Merge this segment into the one before it: the stored head is dropped and
   *  the previous segment grows over the span. Never called for the opening
   *  segment, which has nothing before it. */
  onDelete: () => void;
  onClose: () => void;
  /** Seek the player to the segment's start and play from there. */
  onPlayFrom?: () => void;
  /** Song slug, and the song's length. Both are needed to ask the detectors
   *  about this segment's span; without them the Detect button is hidden
   *  rather than shown broken. */
  slug?: string;
  duration?: number;
}

export function GridSegmentEditPopover({
  segment,
  segments,
  total,
  popoverRef,
  positionStyle,
  barBeatOrigin = 0,
  locked = false,
  onChange,
  onDelete,
  onClose,
  onPlayFrom,
  slug,
  duration,
}: GridSegmentEditPopoverProps) {
  const isOpening = segment.index === 0;
  const cut = isOpening ? null : cutPreviewAt(segments, segment.start, segment.id);
  // The segment this one would merge into. Taken by index rather than by
  // position so it survives a table that is mid-drag.
  const previous = isOpening ? null : segments.find((s) => s.index === segment.index - 1) ?? null;
  const customMeter = !QUICK_METERS.includes(segment.timeSignature);

  return (
    <div
      ref={popoverRef}
      style={positionStyle}
      role="dialog"
      aria-label={`Grid segment ${segment.index + 1}`}
      className="z-50 w-[300px] rounded-lg border border-white/10 bg-[#14171d] p-3 shadow-[0_18px_46px_rgba(0,0,0,0.72)] flex flex-col gap-[11px]"
    >
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] font-semibold text-slate-200">
          Grid segment {segment.index + 1}
        </span>
        <span
          className={`rounded-[3px] border px-1.5 py-[2px] font-mono text-[9.5px] font-semibold uppercase tracking-[0.09em] ${
            isOpening
              ? 'border-slate-400/40 bg-slate-400/15 text-slate-200'
              : 'border-cyan-400/40 bg-cyan-500/15 text-cyan-100'
          }`}
        >
          {isOpening ? 'Opening' : `of ${total}`}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto text-[14px] leading-none text-slate-500 hover:text-slate-200 transition-colors"
        >
          ✕
        </button>
      </div>

      <Field label="Starts at" htmlFor="gs-start">
        <NumberInput
          id="gs-start"
          value={segment.start}
          min={0}
          step={0.001}
          disabled={locked}
          format={(v) => formatClockTime(v, 3)}
          onCommit={(v) => onChange({ start: v })}
          suffix={`bar ${barBeatOrigin === 1 ? 1 : 0} · beat ${barBeatOrigin === 1 ? 1 : 0}`}
          title={isOpening
            ? 'The song’s first downbeat. Same value as “Bar 1 at” in the Downbeat step.'
            : 'Where this grid takes over. This instant becomes its bar 1, beat 1.'}
        />
      </Field>

      <Field label="Tempo" htmlFor="gs-bpm">
        <NumberInput
          id="gs-bpm"
          value={segment.bpm}
          min={BPM_MIN}
          max={BPM_MAX}
          step={0.01}
          disabled={locked}
          format={(v) => v.toFixed(2)}
          onCommit={(v) => onChange({ bpm: v })}
          // Tempo is judged against the audio, not against the number: the
          // grid has to move while the curator types or nudges, or every
          // guess costs a blur to see and a click to come back to.
          onLive={(v) => onChange({ bpm: v }, { live: true })}
          suffix="BPM"
          title={isOpening ? 'The song’s tempo — the same field as step 1.' : 'Tempo from here until the next segment.'}
        />
      </Field>

      {slug && duration != null && (
        <SegmentDetect
          // Remounting IS the invalidation: a result is an answer about a
          // span, so when the span moves the answer has to go with it. A key
          // does that without an effect that resets four pieces of state.
          key={`${segment.id}:${segment.start}:${Math.min(segment.end, duration)}`}
          slug={slug}
          segment={segment}
          duration={duration}
          locked={locked}
          onlySegment={segments.length === 1}
          onApply={onChange}
        />
      )}

      <div className="flex flex-col gap-[5px]">
        <span className="font-mono text-[10px] uppercase tracking-[0.11em] text-slate-500">Meter</span>
        <div className="flex gap-1">
          {QUICK_METERS.map((m) => (
            <MeterChip
              key={m}
              meter={m}
              active={segment.timeSignature === m}
              disabled={locked}
              onPick={() => onChange({ timeSignature: m })}
            />
          ))}
          <select
            value={customMeter ? segment.timeSignature : '__other__'}
            disabled={locked}
            aria-label="Less common meters"
            onChange={(e) => {
              if (e.target.value !== '__other__') onChange({ timeSignature: e.target.value });
            }}
            className={`flex-1 min-w-0 rounded-[5px] border px-1 py-[5px] text-center font-mono text-[11px] transition-colors disabled:opacity-40 ${
              customMeter
                ? 'border-violet-500/50 bg-violet-500/15 text-violet-100'
                : 'border-white/[0.08] bg-white/[0.02] text-slate-400 hover:text-slate-200'
            }`}
          >
            <option value="__other__">…</option>
            {OTHER_METERS.map((m) => <option key={m} value={m}>{m}</option>)}
            {customMeter && !OTHER_METERS.includes(segment.timeSignature) && (
              <option value={segment.timeSignature}>{segment.timeSignature}</option>
            )}
          </select>
        </div>
      </div>

      <div className="flex gap-1.5">
        {onPlayFrom && (
          <button
            type="button"
            onClick={onPlayFrom}
            className="flex-1 rounded-[5px] border border-violet-500/55 bg-violet-500/20 py-[7px] text-[11.5px] font-semibold text-violet-50 hover:bg-violet-500/30 transition-colors"
          >
            Play from here
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          disabled={locked || isOpening}
          title={isOpening
            ? 'Segment 1 has nothing before it to merge into.'
            : previous
              ? `Join this span to segment ${previous.index + 1}, which counts on at ${previous.bpm.toFixed(2)} BPM in ${previous.timeSignature}.`
              : 'Join this span to the segment before it.'}
          className="flex-1 rounded-[5px] border border-amber-500/45 bg-amber-500/10 py-[7px] text-[11.5px] font-semibold text-amber-200 hover:bg-amber-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-amber-500/10"
        >
          ⇤ Merge with previous
        </button>
      </div>

      <p className="border-t border-white/[0.06] pt-[9px] text-[10.5px] leading-[1.45] text-slate-500">
        {isOpening ? (
          <>
            The opening segment has nothing before it to merge into. Its start is the
            song’s downbeat — the same value as{' '}
            <span className="text-slate-300">“Bar 1 at”</span> in step 2.
          </>
        ) : cut ? (
          <>
            Starting here cuts bar {cut.barNumber + barBeatOrigin} of segment {segment.index} short —
            it keeps <b className="font-semibold text-red-300">{trimBeats(cut.beatsKept)} of {cut.beatsPerBar} beats</b>.
          </>
        ) : (
          <>Lands on a bar line, so the segment before it finishes its last bar.</>
        )}
      </p>
    </div>
  );
}

function trimBeats(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-[5px]">
      <label htmlFor={htmlFor} className="font-mono text-[10px] uppercase tracking-[0.11em] text-slate-500">
        {label}
      </label>
      {children}
    </div>
  );
}

function MeterChip({
  meter, active, disabled, onPick,
}: { meter: string; active: boolean; disabled?: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      aria-pressed={active}
      className={`flex-1 rounded-[5px] border py-[5px] text-center font-mono text-[11px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        active
          ? 'border-violet-500/50 bg-violet-500/15 text-violet-100'
          : 'border-white/[0.08] bg-white/[0.02] text-slate-400 hover:border-violet-500/30 hover:text-violet-200'
      }`}
    >
      {meter}
    </button>
  );
}

/** Numeric field with a local buffer, so intermediate states (empty, a
 *  trailing decimal point) survive typing without committing on every
 *  keystroke. Commits on blur and Enter; Escape restores.
 *
 *  A field given `onLive` also streams every in-range value as it is typed or
 *  arrow-nudged, for a value whose only real readout is the picture behind the
 *  popover. The buffer still governs what the input shows, so the stream never
 *  reformats text mid-keystroke; and Escape rewinds the stream by committing
 *  the value the field opened with, since something already went out. */
function NumberInput({
  id, value, min, max, step, disabled, suffix, title, format, onCommit, onLive,
}: {
  id: string;
  value: number;
  min?: number;
  max?: number;
  step: number;
  disabled?: boolean;
  suffix?: string;
  title?: string;
  format: (v: number) => string;
  onCommit: (v: number) => void;
  onLive?: (v: number) => void;
}) {
  const [text, setText] = useState(() => format(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(format(value));
    // `format` is a fresh closure each render; the value is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editing]);

  // What the field held when this edit began, so Escape has somewhere to put
  // the grid back to after a stream has already moved it. `cancelled` rides
  // with it: Escape blurs, and the blur must not turn around and commit the
  // buffer Escape just threw away.
  const openedWith = useRef(value);
  const cancelled = useRef(false);

  const parsed = parseFlexible(text);
  const invalid = parsed == null
    || (min != null && parsed < min)
    || (max != null && parsed > max);

  /** Push an in-range intermediate value out. Half-typed and out-of-range
   *  states are skipped rather than clamped: clamping "1" on the way to "144"
   *  would drag the grid down to the minimum and back for no reason. */
  const live = (next: string) => {
    if (!onLive) return;
    const n = parseFlexible(next);
    if (n == null) return;
    if (min != null && n < min) return;
    if (max != null && n > max) return;
    if (Math.abs(n - value) < 1e-9) return;
    onLive(n);
  };

  const commit = () => {
    setEditing(false);
    if (cancelled.current) { cancelled.current = false; setText(format(openedWith.current)); return; }
    if (invalid || parsed == null) { setText(format(value)); return; }
    if (Math.abs(parsed - value) < 1e-9) { setText(format(value)); return; }
    onCommit(parsed);
  };

  return (
    <div
      className={`flex items-center gap-1.5 rounded-[5px] border bg-[#0a0b0d] px-2 py-1.5 transition-colors ${
        invalid ? 'border-red-500/50' : 'border-white/10 focus-within:border-violet-500/60'
      }`}
      title={title}
    >
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={text}
        disabled={disabled}
        onFocus={() => { openedWith.current = value; setEditing(true); }}
        onChange={(e) => { setText(e.target.value); live(e.target.value); }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            const back = openedWith.current;
            cancelled.current = true;
            if (onLive && Math.abs(back - value) > 1e-9) onCommit(back);
            setText(format(back));
            setEditing(false);
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const base = parsed ?? value;
            const next = format(clamp(base + (e.key === 'ArrowUp' ? step : -step), min, max));
            setText(next);
            live(next);
          }
        }}
        className="min-w-0 flex-1 bg-transparent font-mono text-[12px] tabular-nums text-slate-100 outline-none disabled:opacity-50"
      />
      {suffix && <span className="shrink-0 font-mono text-[10.5px] text-slate-500">{suffix}</span>}
    </div>
  );
}

function clamp(v: number, min?: number, max?: number): number {
  if (min != null && v < min) return min;
  if (max != null && v > max) return max;
  return v;
}

/** Accepts a plain number of seconds ("10.07") or clock time ("0:10.070"),
 *  so the same field takes whichever the curator has in hand. */
function parseFlexible(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (trimmed.includes(':')) {
    const parts = trimmed.split(':');
    if (parts.length !== 2) return null;
    const m = parseInt(parts[0], 10);
    const sec = parseFloat(parts[1]);
    if (!Number.isFinite(m) || !Number.isFinite(sec)) return null;
    return m * 60 + sec;
  }
  const n = parseFloat(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Read this segment's tempo and meter off its own audio.
 *
 *  Kept deliberately quiet until it has something to say: one button, and the
 *  results appear under it. The answer is thrown away the moment the segment's
 *  bounds move (the caller remounts on a bounds key), because it was an answer
 *  about a span the segment no longer covers — a stale 99.40 sitting under a
 *  head that has been dragged into the next section is worse than no number at
 *  all. Editing the tempo or meter does NOT clear it: the span is unchanged, so
 *  the reading still stands and stays there to compare against.
 */
function SegmentDetect({
  slug, segment, duration, locked, onlySegment, onApply,
}: {
  slug: string;
  segment: ResolvedSegment;
  duration: number;
  locked: boolean;
  /** The map has no splits yet, so this segment's span IS the whole song and
   *  the pitch for reading it separately doesn't apply. */
  onlySegment: boolean;
  onApply: (patch: { bpm?: number; timeSignature?: string }) => void;
}) {
  // The final segment runs to +Infinity; the audio stops at `duration`.
  const start = segment.start;
  const end = Math.min(segment.end, duration);
  const tooShort = segmentTooShortReason(start, end);

  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<SegmentGridDetection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const run = async () => {
    setStatus('running');
    setError(null);
    try {
      const detected = await detectSegmentGrid(slug, start, end);
      setResult(detected);
      setStatus('done');
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    }
  };

  const span = `${formatClockTime(start, 1)}–${formatClockTime(end, 1)}`;
  const best = result?.candidates[0];
  const votes = result
    ? result.candidates.reduce((n, c) => n + c.sources.length, 0)
    : 0;

  return (
    <div className="flex flex-col gap-[7px] rounded-[6px] border border-white/[0.07] bg-white/[0.015] p-2">
      <button
        type="button"
        onClick={run}
        disabled={locked || !!tooShort || status === 'running'}
        title={tooShort ?? `Run the tempo detectors over ${span} only — this segment's own audio, not the whole song.`}
        className="w-full rounded-[5px] border border-violet-500/40 bg-violet-500/10 py-[6px] text-[11px] font-semibold text-violet-100 transition-colors hover:bg-violet-500/20 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-violet-500/10"
      >
        {status === 'running' ? `Listening to ${span}…` : '♪ Detect from this segment'}
      </button>

      {status === 'idle' && (
        <p className="text-[10px] leading-snug text-slate-500">
          {tooShort
            ?? (onlySegment
              ? <>Reads {span} — the whole song, until you split the grid.</>
              : <>Reads {span} only. A song-wide tempo describes neither this segment nor its neighbour.</>)}
        </p>
      )}

      {status === 'error' && (
        <p className="text-[10px] leading-snug text-amber-400/90 break-words">⚠ {error}</p>
      )}

      {status === 'done' && !best && (
        <p className="text-[10px] leading-snug text-amber-400/90">
          No detector could read a tempo out of {span}.
        </p>
      )}

      {status === 'done' && best && (
        <div className="flex flex-col gap-[5px]">
          <button
            type="button"
            disabled={locked}
            onClick={() => onApply({
              bpm: best.bpm,
              ...(result?.meter ? { timeSignature: result.meter } : {}),
            })}
            title={`${best.sources.join(', ')}${result?.meter ? ` · meter from beatnet` : ''}`}
            className="flex items-baseline gap-1.5 rounded-[5px] border border-violet-500/50 bg-violet-500/15 px-2 py-[6px] text-left transition-colors hover:bg-violet-500/25 disabled:opacity-40"
          >
            <span className="font-mono text-[13px] font-semibold tabular-nums text-violet-50">
              {best.bpm.toFixed(2)}
            </span>
            {result?.meter && (
              <span className="font-mono text-[11px] text-violet-200">· {result.meter}</span>
            )}
            <span className="ml-auto shrink-0 text-[10px] text-violet-300">
              {best.sources.length === votes
                ? 'all agree'
                : `${best.sources.length} of ${votes}`} · use
            </span>
          </button>

          {result!.candidates.length > 1 && (
            <>
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                aria-expanded={showAll}
                className="self-start text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
              >
                {showAll ? '▾' : '▸'} {result!.candidates.length - 1} other{result!.candidates.length === 2 ? '' : 's'} heard it differently
              </button>
              {showAll && (
                <div className="grid grid-cols-2 gap-1">
                  {result!.candidates.slice(1).map((c) => (
                    <button
                      key={c.bpm}
                      type="button"
                      disabled={locked}
                      onClick={() => onApply({ bpm: c.bpm })}
                      title={c.sources.join(', ')}
                      className="flex min-w-0 items-baseline gap-1 rounded-[4px] border border-white/[0.08] bg-white/[0.02] px-1.5 py-1 text-slate-300 transition-colors hover:border-violet-500/40 hover:bg-violet-500/10 disabled:opacity-40"
                    >
                      <span className="font-mono text-[11px] tabular-nums">{c.bpm.toFixed(2)}</span>
                      {/* Never "×2" here — in a tempo field that reads as the
                          octave doubler, not as a vote count. */}
                      <span className="min-w-0 flex-1 truncate text-left text-[9.5px] text-slate-500">
                        {c.sources.length > 1 ? `${c.sources.length} agree` : c.sources[0]}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
