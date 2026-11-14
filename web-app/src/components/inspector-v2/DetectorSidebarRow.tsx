/**
 * DetectorSidebarRow — one detector in the Detectors sidebar: show it, run it,
 * and, for a detector that offers it, pick how strict it is.
 *
 * The sidebar is the one place a custom detector lives. Every registered
 * detector has a row whether or not it has run on this song — a detector the
 * annotator is looking for is never simply missing — and the row says which
 * state it is in on its one line, after the name:
 *
 *   has output    ☑ ● Pulse ················ 89  ↻
 *   found nothing ☐ ○ Rolls  none found ········ ↻
 *   failed        ☐ ○ Bass notes  failed ······· ↻
 *   not run yet   ☐ ○ Bass notes ··············· ▶
 *   running       ☑ ● Pulse  running… ·········· ◌
 *   cannot run    ☐ ○ Vocal phrases  needs vocals
 *
 * One line per row, so a sidebar of twenty detectors reads as a list. A row
 * without output ticks the detector for the sidebar's "▶ Run N ticked" instead
 * of showing a lane; once it has run, the same box shows its lane.
 *
 * ⬇ and × (the page's own buttons) appear on hover; the run control never
 * hides. A detector that declares `strictness` shows its setting as a small
 * pill ("Normal", "89"); clicking it opens a slider from Strict (0) through
 * Normal (50) to Loose (100) under the row. Moving it runs nothing — it sets
 * where the next run reads, and while it is away from the setting the lane on
 * screen was read at, the pill turns amber and a ▶ Run sits beside the slider.
 * The slider stays tucked away until asked for: five always-open sliders made
 * the sidebar a mixing desk.
 *
 * A detector that declares `drum_source` gets a second pill the same way: where
 * its drums are read from — Auto, Kit (Drum kit, separated: each drum from its
 * own stem) or Bands (the drums stem's three frequency bands). On Auto the
 * pill also says which one the lane on screen was read from ("Auto · kit"),
 * since that is the question the pill exists to answer. And a lane read before
 * the kit was split, or split again, says "out of date" after its name.
 *
 * A detector that declares `section_source` gets a third, the same again:
 * where the song's sections are read from — Auto, Annotated (the annotator's
 * first boundaries layer) or All-In-One. On Auto it says which it read
 * ("Auto · annotated").
 *
 * A detector that declares `sources` gets one more, labelled from its own list:
 * where it reads its input from (Held lyrics: Auto, Yours, or one model's
 * lyrics). On Auto it says which it read ("Auto · Yours").
 *
 * A detector that declares `switches` — yes/no facts about the song, such as
 * "The bass leads this song" — shows each as a tick on its own line under the
 * row, always in sight: a fact the reading depends on should not hide behind
 * a pill. Ticking runs nothing; while a tick differs from what the lane on
 * screen was read with, an amber ▶ Run sits beside it.
 *
 * A row with a lane also offers "only" on hover: show this detector's lane and
 * hide every other detector lane, to read one detector against the song alone.
 * While it is the only lane shown the word stays up as "all", which brings the
 * others back.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  DRUM_SOURCES, SECTION_SOURCES, STRICTNESS_NAMES, drumSourceName, sectionSourceName, strictnessName,
  type DetectorSource, type DetectorStrictness, type DrumSource, type SectionSource,
} from '../../types/customScript';

const STRICTNESS_HINT = 'How sure it must be before it reports something. '
  + 'Left, stricter: fewer spans, each one certain. Right, looser: the pulse you hear '
  + 'even where hits are late, missing for a bar, or have notes played between them — '
  + 'more spans, some arguable. Normal (50) is the default. Set it, then Run.';

export interface StrictnessPickerProps {
  /** Where the handle is: the setting the next run reads at. */
  value: DetectorStrictness;
  disabled?: boolean;
  /** Name for screen readers, e.g. "Pulse strictness". */
  label: string;
  onChange: (level: DetectorStrictness) => void;
  /** Print the value beside the slider. Off where a pill already shows it. */
  showValue?: boolean;
}

/** Strictness as a slider, Strict at the left, Loose at the right, Normal
 *  marked in the middle, its value beside it. Moving it only moves it: the
 *  run is the caller's Run button. */
export function StrictnessPicker({ value, disabled, label, onChange, showValue = true }: StrictnessPickerProps) {
  const ticks = `${useId()}-ticks`;
  return (
    <span className="inline-flex items-center gap-2" title={STRICTNESS_HINT}>
      <input
        type="range"
        min={STRICTNESS_NAMES.strict}
        max={STRICTNESS_NAMES.loose}
        step={1}
        list={ticks}
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={strictnessName(value)}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-24 h-1 accent-amber-400 cursor-pointer disabled:cursor-default disabled:opacity-60"
      />
      <datalist id={ticks}>
        {Object.values(STRICTNESS_NAMES).map((v) => <option key={v} value={v} />)}
      </datalist>
      {showValue && <span className="w-10 text-[10px] tabular-nums text-slate-200">{strictnessName(value)}</span>}
    </span>
  );
}

const DRUM_SOURCE_HINT: Record<DrumSource, string> = {
  auto: 'The separated kit where this song has been split (Drum kit, separated), the three bands otherwise.',
  kit: 'Drum kit, separated: each drum from its own stem — kick, snare, toms, hi-hat, ride, crash. '
    + 'Needs that detector to have run on this song.',
  bands: 'The drums stem\'s three frequency bands (Drum hits): kick, snare and hi-hat only; '
    + 'a kick heard in the snare band shows as grey bleed.',
};

const SECTION_SOURCE_HINT: Record<SectionSource, string> = {
  auto: 'Your first boundaries layer where you have one on this song, All-In-One otherwise.',
  annotated: 'Your first boundaries layer with marks on this song — the sections as you marked them.',
  allin1: 'All-In-One\'s automatic sections (intro, verse, chorus …), as in the Glow with the Flow paper.',
};

/** A detector's sources in their groups, in order of first appearance; the
 *  ungrouped come first under no heading. */
function sourceGroups(options: DetectorSource[]): [string, DetectorSource[]][] {
  const out = new Map<string, DetectorSource[]>([['', []]]);
  for (const o of options) {
    const g = o.group ?? '';
    if (!out.has(g)) out.set(g, []);
    out.get(g)!.push(o);
  }
  return [...out].filter(([, opts]) => opts.length > 0);
}

/** A `sources` choice's label by name (the name itself for one no longer offered). */
function sourceLabel(source: { options: DetectorSource[] }, name: string): string {
  return source.options.find((o) => o.name === name)?.label ?? (name.startsWith('lane:') ? 'a deleted lane' : name);
}

/** The choices as buttons, the chosen one lit (Auto / Kit / Bands, say).
 *  Choosing only chooses: the run is the caller's Run button. */
function SourcePicker<T extends string>({ options, nameOf, hints, value, disabled, label, onChange, wrap }: {
  options: readonly T[]; nameOf: (v: T) => string; hints: Record<T, string>;
  value: T; disabled?: boolean; label: string; onChange: (source: T) => void;
  /** Many choices (a lane per name): let them wrap rather than run off the row. */
  wrap?: boolean;
}) {
  return (
    <span role="radiogroup" aria-label={label} className={`inline-flex rounded border border-white/15 overflow-hidden ${wrap ? 'flex-wrap min-w-0' : ''}`}>
      {options.map((source) => (
        <button
          key={source}
          type="button"
          role="radio"
          aria-checked={value === source}
          disabled={disabled}
          onClick={() => onChange(source)}
          title={hints[source]}
          className={`px-1.5 leading-4 transition-colors disabled:opacity-60 ${wrap ? 'max-w-[11rem] truncate' : ''} ${
            value === source ? 'bg-amber-500/20 text-amber-100' : 'text-slate-400 hover:text-white hover:bg-white/[0.08]'
          }`}
        >
          {nameOf(source)}
        </button>
      ))}
    </span>
  );
}

/** A setting's pill beside the name: a bordered chip with a disclosure
 *  triangle, amber while the chosen setting is not the one on screen. */
function SettingPill({ text, label, title, open, moved, onToggle }: {
  text: string; label: string; title: string; open: boolean; moved: boolean; onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={label}
      title={title}
      className={`shrink-0 inline-flex items-center gap-0.5 rounded border pl-1.5 pr-0.5 h-[18px] text-[10px] leading-4 transition-colors ${
        moved
          ? 'border-amber-400/50 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
          : open
            ? 'border-white/25 bg-white/[0.08] text-slate-100'
            : 'border-white/15 text-slate-300 hover:text-white hover:border-white/30 hover:bg-white/[0.06]'
      }`}
    >
      {text}
      <svg
        viewBox="0 0 12 12"
        width="12"
        height="12"
        aria-hidden
        className={`shrink-0 transition-transform ${open || moved ? 'rotate-90' : ''}`}
      >
        <path d="M4 2.5 L9 6 L4 9.5 Z" fill="currentColor" />
      </svg>
    </button>
  );
}

/** "· failed" / "· nothing found": a button into the run's log when there is one. */
function StatusNote({ className, title, onShowLog, children }: {
  className: string; title: string; onShowLog?: () => void; children: ReactNode;
}) {
  if (!onShowLog) return <span className={`min-w-0 truncate cursor-help ${className}`} title={title}>{children}</span>;
  return (
    <button
      type="button"
      onClick={onShowLog}
      title={`${title}\n\nClick to see the run's log.`}
      className={`min-w-0 truncate text-left hover:underline underline-offset-2 transition-colors ${className}`}
    >
      {children}
    </button>
  );
}

export interface DetectorHeadingCheckProps {
  /** The heading's words, shown and used for the checkbox's name. */
  label: string;
  /** Every row under the heading is already checked / none is. */
  allOn: boolean;
  allOff: boolean;
  /** Check (true) or clear (false) every row under the heading. */
  onSet: (on: boolean) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  checkboxClassName?: string;
  /** Right-aligned extras on the heading line. */
  children?: ReactNode;
}

/** A Detectors-sidebar heading (Default, a stem, or the whole list) with a
 *  checkbox in the rows' checkbox column: checked when every row under it is,
 *  a dash when some are. Clicking it checks every row, or clears them all
 *  when all are checked — as the rows' own checkboxes would. While any row is
 *  checked a "none" button sits beside it, so clearing a partly checked
 *  heading is one click instead of check-all-then-clear. This one column
 *  of boxes is the whole filter: there is no second set of stem chips. */
export function DetectorHeadingCheck({
  label, allOn, allOff, onSet, disabled, title, className = '', checkboxClassName = '', children,
}: DetectorHeadingCheckProps) {
  const ref = useRef<HTMLInputElement>(null);
  const mixed = !allOn && !allOff;
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <label
        className={`flex items-center gap-1.5 min-w-0 select-none ${disabled ? '' : 'cursor-pointer'}`}
        title={title ?? (allOn
          ? `Hide every ${label} lane and untick the rest`
          : `Show every ${label} lane, and tick the ones with no lane for Run N ticked`)}
      >
        <input
          ref={ref}
          type="checkbox"
          checked={allOn}
          disabled={disabled}
          aria-label={`All ${label}`}
          onChange={() => onSet(!allOn)}
          className={`${checkboxClassName} shrink-0 disabled:opacity-30`}
        />
        <span className="truncate">{label}</span>
      </label>
      {!allOff && !disabled && (
        <button
          type="button"
          onClick={() => onSet(false)}
          aria-label={`Clear all ${label}`}
          title={`Untick every ${label} row and hide its lanes`}
          className="shrink-0 px-1 rounded normal-case tracking-normal font-normal text-[10px] leading-4 text-slate-500 hover:text-white hover:bg-white/[0.10]"
        >
          none
        </button>
      )}
      {children}
    </div>
  );
}

export interface DetectorSidebarRowProps {
  /** Shown name (the layer's, or the detector's label before it has one). */
  name: string;
  /** The lane's colour; absent while the detector has no output. */
  color?: string | null;
  /** A layer exists: the row can show/hide it. */
  hasOutput: boolean;
  /** Ran, and found nothing on this song. Such a run draws no lane: this row
   *  is the only place it shows. */
  emptyResult?: boolean;
  /** What the detector said about that run (its `ctx.warn()` notes), on hover. */
  emptyNotes?: string[];
  /** With output: the lane is shown. Without: the detector is ticked for the
   *  sidebar's "Run N ticked", and will be shown once it has run. */
  visible?: boolean;
  /** Some of the lanes this row stands for are checked, not all (a detector
   *  read on several stems): the box shows a dash. */
  mixed?: boolean;
  /** Quiet text after the name when there is no status to say ("4 stems"). */
  note?: string;
  noteTitle?: string;
  /** Absent = the checkbox cannot be ticked (it waits on a stem, say). */
  onToggleVisible?: () => void;
  checkboxClassName?: string;
  description?: string;

  running?: boolean;
  /** The last run failed; the message is on hover. */
  failedMessage?: string | null;
  /** Opens the last run's log (error, traceback, notes) in the run log panel.
   *  Makes "· failed" and "· nothing found" clickable. */
  onShowLog?: () => void;
  /** The stem this detector reads has not been separated for this song. */
  needsStem?: string | null;
  /** Runs (or re-runs) the detector on the whole song. Absent = not offered here. */
  onRun?: () => void;
  /** Why running is not possible right now (another run in progress…). */
  runBlockedReason?: string | null;

  /** For a detector that offers a strictness. `onRun` reads at `chosen`. */
  strictness?: {
    /** The setting the output on screen was read at. */
    value: DetectorStrictness;
    /** Where the slider is: the setting the next run reads at. */
    chosen: DetectorStrictness;
    onChoose: (level: DetectorStrictness) => void;
  } | null;

  /** For a detector that offers a drum source. `onRun` reads from `chosen`. */
  drumSource?: {
    /** The source the output on screen was asked for. */
    value: DrumSource;
    /** Where the next run reads from. */
    chosen: DrumSource;
    /** What the output on screen was actually read from, when known. */
    read?: 'kit' | 'bands';
    onChoose: (source: DrumSource) => void;
  } | null;
  /** For a detector that offers a section source. `onRun` reads from `chosen`. */
  sectionSource?: {
    /** The source the output on screen was asked for. */
    value: SectionSource;
    /** Where the next run reads from. */
    chosen: SectionSource;
    /** What the output on screen actually read, when known. */
    read?: 'annotated' | 'allin1' | 'none';
    onChoose: (source: SectionSource) => void;
  } | null;
  /** For a detector that declares `sources`. `onRun` reads from `chosen`. */
  source?: {
    options: DetectorSource[];
    /** The source the output on screen was asked for. */
    value: string;
    /** Where the next run reads from. */
    chosen: string;
    /** What the output on screen actually read (on Auto), when known. */
    read?: string;
    onChoose: (source: string) => void;
  } | null;
  /** For a detector that declares switches, one per switch. `onRun` reads
   *  with each at `chosen`. */
  switches?: {
    key: string;
    label: string;
    /** Whether the output on screen was read with it ticked. */
    value: boolean;
    /** Whether the next run reads with it ticked. */
    chosen: boolean;
    onChoose: (ticked: boolean) => void;
  }[] | null;
  /** Why the output on screen is out of date (the drum kit was split since,
   *  say), or null. */
  stale?: string | null;

  /** Show this row's lane alone (hide every other detector lane), or, when
   *  `soloed`, show them all again. Absent = no "only" button. */
  onSolo?: () => void;
  /** This row's lane is the only detector lane shown. */
  soloed?: boolean;

  /** The page's hover actions (copy to a layer, delete output). */
  actions?: ReactNode;
}

export function DetectorSidebarRow({
  name, color, hasOutput, emptyResult, emptyNotes, visible, mixed, note, noteTitle, onToggleVisible, checkboxClassName = '',
  description, running, failedMessage, onShowLog, needsStem, onRun, runBlockedReason, strictness, drumSource, sectionSource, source, switches, stale,
  onSolo, soloed, actions,
}: DetectorSidebarRowProps) {
  const at = [
    strictness ? ` at strictness ${strictnessName(strictness.chosen)}` : '',
    drumSource ? `, drums from ${drumSourceName(drumSource.chosen)}` : '',
    sectionSource ? `, sections from ${sectionSourceName(sectionSource.chosen)}` : '',
    source ? `, reading ${sourceLabel(source, source.chosen)}` : '',
  ].join('');
  // The slider was moved off the setting the lane on screen was read at.
  const moved = !!strictness && hasOutput && strictness.chosen !== strictness.value;
  const sourceMoved = !!drumSource && hasOutput && drumSource.chosen !== drumSource.value;
  const sectionsMoved = !!sectionSource && hasOutput && sectionSource.chosen !== sectionSource.value;
  const readMoved = !!source && hasOutput && source.chosen !== source.value;
  const switchesMoved = hasOutput && !!switches?.some((s) => s.chosen !== s.value);
  const blocked = !!runBlockedReason;
  const fresh = !hasOutput && !emptyResult && !failedMessage;

  // Every row is one line — checkbox · swatch · name · status · pill · run
  // icon — so the names start in one column and the icons end in another.
  const slot = 'shrink-0 w-5 h-5 inline-flex items-center justify-center rounded';
  let icon: ReactNode = <span className={slot} aria-hidden />;
  if (running) {
    icon = (
      <span className={slot} aria-hidden>
        <span className="w-3 h-3 rounded-full border-[1.5px] border-amber-300/30 border-t-amber-300 animate-spin" />
      </span>
    );
  } else if (onRun && !needsStem) {
    icon = (
      <button
        type="button"
        onClick={onRun}
        disabled={blocked}
        aria-label={`${fresh ? 'Run' : failedMessage ? 'Retry' : 'Re-run'} ${name}`}
        title={blocked ? runBlockedReason!
          : failedMessage ? `Last run failed: ${failedMessage}. Click to try again.`
          : fresh ? `Run ${name} on this song${at}`
          : `Re-run ${name} on this song${at}. Asks first if you have edited its output.`}
        className={`${slot} text-[12px] leading-none text-slate-500 hover:text-amber-200 hover:bg-amber-500/15 transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-500`}
      >
        {fresh ? <span className="text-[9px]">▶</span> : '↻'}
      </button>
    );
  }

  // At most one status, in small type right after the name.
  let status: ReactNode = null;
  if (running) {
    status = <span className="shrink-0 text-amber-300/90 animate-pulse" role="status">running…</span>;
  } else if (needsStem) {
    status = (
      <span
        className="min-w-0 truncate text-slate-500 cursor-help"
        title={`Reads the ${needsStem} stem, which this song has not had separated yet. Separate stems (Demucs) first.`}
      >
        needs {needsStem}
      </span>
    );
  } else if (failedMessage) {
    status = (
      <StatusNote className="text-rose-400/90 hover:text-rose-300" title={failedMessage} onShowLog={onShowLog}>
        failed
      </StatusNote>
    );
  } else if (emptyResult) {
    status = (
      <StatusNote
        className="text-slate-500 hover:text-slate-300"
        title={['It ran on this song and found nothing.', ...(emptyNotes ?? [])].join('\n')}
        onShowLog={onShowLog}
      >
        none found
      </StatusNote>
    );
  } else if (stale && hasOutput) {
    status = <span className="min-w-0 truncate text-amber-300/90 cursor-help" title={stale}>out of date</span>;
  }
  if (!status && note) {
    status = <span className="min-w-0 truncate text-slate-600 cursor-help" title={noteTitle}>{note}</span>;
  }
  const hasStrictness = !!strictness && !needsStem;
  const [tuning, setTuning] = useState(false);
  const hasDrumSource = !!drumSource && !needsStem;
  const [picking, setPicking] = useState(false);
  const sourcePill = drumSource
    ? drumSource.chosen === 'auto' && drumSource.read && !sourceMoved
      ? `Auto · ${drumSource.read}`
      : drumSourceName(drumSource.chosen)
    : '';
  const hasSectionSource = !!sectionSource && !needsStem;
  const [pickingSections, setPickingSections] = useState(false);
  const sectionPill = sectionSource
    ? sectionSource.chosen === 'auto' && sectionSource.read && !sectionsMoved
      ? `Auto · ${sectionSourceName(sectionSource.read)}`
      : sectionSourceName(sectionSource.chosen)
    : '';
  const hasSource = !!source && !needsStem;
  const [pickingSource, setPickingSource] = useState(false);
  const readPill = source
    ? source.chosen === source.options[0]?.name && source.read && source.read !== source.chosen && !readMoved
      ? `${sourceLabel(source, source.chosen)} · ${sourceLabel(source, source.read)}`
      : sourceLabel(source, source.chosen)
    : '';
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { if (box.current) box.current.indeterminate = !!mixed; }, [mixed]);
  // Indent = checkbox (13) + gap (6) + swatch (8) + gap (6): the slider starts under the name.
  const line2 = 'flex items-center gap-2 pl-[33px] pr-6 h-7 pb-1 text-[10px] leading-4';

  return (
    <div className="group/curated-row py-px" title={description || undefined}>
      <div className="flex items-center gap-1 h-[22px]">
        <label className={`flex items-center gap-1.5 select-none flex-1 min-w-0 ${onToggleVisible ? 'cursor-pointer' : ''}`}>
          {/* Every row has one, so the names line up. With a lane it shows
              and hides it; without one it picks the detector for the next run. */}
          <input
            ref={box}
            type="checkbox"
            checked={!!visible}
            disabled={!onToggleVisible || running}
            onChange={() => onToggleVisible?.()}
            title={hasOutput ? undefined : `Tick to run ${name}, with the others you tick`}
            className={`${checkboxClassName} shrink-0 disabled:opacity-30`}
          />
          <span
            className={`inline-block w-2 h-2 rounded-full shrink-0 ${color ? '' : failedMessage ? 'border border-rose-400/70' : 'border border-slate-600'}`}
            style={color ? { background: color } : undefined}
            aria-hidden
          />
          <span className={`text-[11px] truncate ${hasOutput ? 'text-slate-300' : 'text-slate-500'}`} title={name}>{name}</span>
        </label>
        {status && <span className="flex min-w-0 shrink text-[10px] leading-4">{status}</span>}
        {onSolo && (
          <button
            type="button"
            onClick={onSolo}
            aria-pressed={!!soloed}
            aria-label={soloed ? `Show every detector lane again` : `Show only ${name}`}
            title={soloed
              ? 'Only this lane is shown. Click to show every detector lane again.'
              : `Show only ${name} on the timeline: hide every other detector lane.`}
            className={`shrink-0 px-1 py-0.5 rounded text-[10px] leading-none transition-all ${
              soloed
                ? 'text-amber-200 bg-amber-500/15 hover:bg-amber-500/25'
                : 'opacity-0 group-hover/curated-row:opacity-100 focus:opacity-100 text-slate-400 hover:text-white hover:bg-white/[0.10]'
            }`}
          >
            {soloed ? 'all' : 'only'}
          </button>
        )}
        {actions}
        {hasStrictness && (
          <button
            type="button"
            onClick={() => setTuning((t) => !t)}
            aria-expanded={tuning}
            aria-label={`${name} strictness: ${strictnessName(strictness!.chosen)}`}
            title={moved
              ? `Strictness set to ${strictnessName(strictness!.chosen)}; the lane on screen was read at ${strictnessName(strictness!.value)}. Run to apply.`
              : `Strictness ${strictnessName(strictness!.chosen)}. Click to ${tuning ? 'close' : 'change'} it.`}
            // A bordered chip with a disclosure triangle, so it reads as a
            // control: plain grey text beside the name read as a label, and
            // nobody found the slider behind it.
            className={`shrink-0 inline-flex items-center gap-0.5 rounded border pl-1.5 pr-0.5 h-[18px] text-[10px] leading-4 tabular-nums transition-colors ${
              moved
                ? 'border-amber-400/50 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
                : tuning
                  ? 'border-white/25 bg-white/[0.08] text-slate-100'
                  : 'border-white/15 text-slate-300 hover:text-white hover:border-white/30 hover:bg-white/[0.06]'
            }`}
          >
            {strictnessName(strictness!.chosen)}
            <svg
              viewBox="0 0 12 12"
              width="12"
              height="12"
              aria-hidden
              className={`shrink-0 transition-transform ${tuning || moved ? 'rotate-90' : ''}`}
            >
              <path d="M4 2.5 L9 6 L4 9.5 Z" fill="currentColor" />
            </svg>
          </button>
        )}
        {hasDrumSource && (
          <SettingPill
            text={sourcePill}
            label={`${name} drums from: ${sourcePill}`}
            open={picking}
            moved={sourceMoved}
            onToggle={() => setPicking((p) => !p)}
            title={sourceMoved
              ? `Drums set to ${drumSourceName(drumSource!.chosen)}; the lane on screen was read from ${drumSourceName(drumSource!.value)}. Run to apply.`
              : `Drums read from ${drumSourceName(drumSource!.chosen)}${drumSource!.read ? ` (this lane: the ${drumSource!.read === 'kit' ? 'separated kit' : 'three bands'})` : ''}. `
                + `Click to ${picking ? 'close' : 'change'} it.`}
          />
        )}
        {hasSectionSource && (
          <SettingPill
            text={sectionPill}
            label={`${name} sections from: ${sectionPill}`}
            open={pickingSections}
            moved={sectionsMoved}
            onToggle={() => setPickingSections((p) => !p)}
            title={sectionsMoved
              ? `Sections set to ${sectionSourceName(sectionSource!.chosen)}; the lane on screen read ${sectionSourceName(sectionSource!.value)}. Run to apply.`
              : `Sections read from ${sectionSourceName(sectionSource!.chosen)}${sectionSource!.read ? ` (this lane: ${sectionSourceName(sectionSource!.read)})` : ''}. `
                + `Click to ${pickingSections ? 'close' : 'change'} it.`}
          />
        )}
        {hasSource && (
          <SettingPill
            text={readPill}
            label={`${name} reads: ${readPill}`}
            open={pickingSource}
            moved={readMoved}
            onToggle={() => setPickingSource((p) => !p)}
            title={readMoved
              ? `Set to read ${sourceLabel(source!, source!.chosen)}; the lane on screen read ${sourceLabel(source!, source!.value)}. Run to apply.`
              : `Reads ${sourceLabel(source!, source!.chosen)}${source!.read ? ` (this lane: ${sourceLabel(source!, source!.read)})` : ''}. `
                + `Click to ${pickingSource ? 'close' : 'change'} it.`}
          />
        )}
        {icon}
      </div>
      {hasDrumSource && (picking || sourceMoved) && (
        <div className={line2}>
          <span className="shrink-0 text-slate-500">Drums from</span>
          <SourcePicker
            options={DRUM_SOURCES}
            nameOf={drumSourceName}
            hints={DRUM_SOURCE_HINT}
            label={`${name} drums from`}
            value={drumSource!.chosen}
            disabled={blocked || running}
            onChange={drumSource!.onChoose}
          />
          {sourceMoved && onRun && !running && (
            <button
              type="button"
              onClick={onRun}
              disabled={blocked}
              title={blocked ? runBlockedReason!
                : `The lane on screen was read from ${drumSourceName(drumSource!.value)}. Run ${name} again from ${drumSourceName(drumSource!.chosen)}.`}
              className="shrink-0 rounded border border-amber-400/35 px-1.5 leading-4 text-amber-200 hover:bg-amber-500/15 transition-colors disabled:opacity-40"
            >
              ▶ Run
            </button>
          )}
        </div>
      )}
      {hasSectionSource && (pickingSections || sectionsMoved) && (
        <div className={line2}>
          <span className="shrink-0 text-slate-500">Sections from</span>
          <SourcePicker
            options={SECTION_SOURCES}
            nameOf={sectionSourceName}
            hints={SECTION_SOURCE_HINT}
            label={`${name} sections from`}
            value={sectionSource!.chosen}
            disabled={blocked || running}
            onChange={sectionSource!.onChoose}
          />
          {sectionsMoved && onRun && !running && (
            <button
              type="button"
              onClick={onRun}
              disabled={blocked}
              title={blocked ? runBlockedReason!
                : `The lane on screen read ${sectionSourceName(sectionSource!.value)}. Run ${name} again from ${sectionSourceName(sectionSource!.chosen)}.`}
              className="shrink-0 rounded border border-amber-400/35 px-1.5 leading-4 text-amber-200 hover:bg-amber-500/15 transition-colors disabled:opacity-40"
            >
              ▶ Run
            </button>
          )}
        </div>
      )}
      {hasSource && (pickingSource || readMoved) && (
        <div className={`${line2.replace('h-7', 'min-h-7')} flex-wrap`}>
          <span className="shrink-0 text-slate-500">Reads</span>
          {/* One picker per group, each under its heading ("Your lanes", "Models"),
              the ungrouped (Auto) first; one choice across them all. */}
          {sourceGroups(source!.options).map(([heading, opts]) => (
            <span key={heading || '-'} className="flex basis-full min-w-0 flex-col gap-0.5">
              {heading && <span className="text-slate-500">{heading}</span>}
              <SourcePicker
                options={opts.map((o) => o.name)}
                nameOf={(n) => sourceLabel(source!, n)}
                hints={Object.fromEntries(opts.map((o) => [o.name, o.hint]))}
                label={heading ? `${name} reads, ${heading}` : `${name} reads`}
                wrap
                value={source!.chosen}
                disabled={blocked || running}
                onChange={source!.onChoose}
              />
            </span>
          ))}
          {readMoved && onRun && !running && (
            <button
              type="button"
              onClick={onRun}
              disabled={blocked}
              title={blocked ? runBlockedReason!
                : `The lane on screen read ${sourceLabel(source!, source!.value)}. Run ${name} again on ${sourceLabel(source!, source!.chosen)}.`}
              className="shrink-0 rounded border border-amber-400/35 px-1.5 leading-4 text-amber-200 hover:bg-amber-500/15 transition-colors disabled:opacity-40"
            >
              ▶ Run
            </button>
          )}
        </div>
      )}
      {!needsStem && switches?.map((s, k) => (
        <div key={s.key} className={line2}>
          <label className={`flex min-w-0 items-center gap-1.5 ${blocked || running ? 'opacity-50' : 'cursor-pointer'} ${
            hasOutput && s.chosen !== s.value ? 'text-amber-200' : 'text-slate-400 hover:text-slate-200'}`}>
            <input
              type="checkbox"
              checked={s.chosen}
              disabled={blocked || running}
              onChange={(e) => s.onChoose(e.target.checked)}
              className={`${checkboxClassName} shrink-0`}
            />
            <span className="truncate" title={hasOutput && s.chosen !== s.value
              ? `The lane on screen was read with this ${s.value ? 'ticked' : 'unticked'}. Run to apply.`
              : `${s.label}. ${name} reads it; ticking runs nothing until you run it.`}>{s.label}</span>
          </label>
          {switchesMoved && k === switches.length - 1 && onRun && !running && (
            <button
              type="button"
              onClick={onRun}
              disabled={blocked}
              title={blocked ? runBlockedReason! : `Run ${name} again with the ticks as they are now.`}
              className="shrink-0 rounded border border-amber-400/35 px-1.5 leading-4 text-amber-200 hover:bg-amber-500/15 transition-colors disabled:opacity-40"
            >
              ▶ Run
            </button>
          )}
        </div>
      ))}
      {hasStrictness && (tuning || moved) && (
        // Taller than the row: the slider's stop marks hang under its track.
        <div className={line2}>
          <span className="shrink-0 text-slate-500">Strictness</span>
          <StrictnessPicker
            label={`${name} strictness`}
            value={strictness!.chosen}
            disabled={blocked || running}
            onChange={strictness!.onChoose}
            showValue={false}
          />
                    {moved && onRun && !running && (
            <button
              type="button"
              onClick={onRun}
              disabled={blocked}
              title={blocked ? runBlockedReason!
                : `The lane on screen was read at ${strictnessName(strictness!.value)}. Run ${name} again at ${strictnessName(strictness!.chosen)}.`}
              className="shrink-0 rounded border border-amber-400/35 px-1.5 leading-4 text-amber-200 hover:bg-amber-500/15 transition-colors disabled:opacity-40"
            >
              ▶ Run
            </button>
          )}
        </div>
      )}
    </div>
  );
}
