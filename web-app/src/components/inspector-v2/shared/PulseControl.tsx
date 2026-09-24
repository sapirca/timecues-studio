/**
 * Pulse picker for a `sections` slot of AnnotationPointCard — the popover half
 * of the rhythmic-rate feature. The drawn half lives in PulseLane.
 *
 * `pulseSection()` at the bottom is what a pulse-carrying kind mounts, the
 * same way `prominenceSection()` is mounted by the four kinds that carry a
 * prominence envelope.
 *
 * Seven chips rather than a dropdown: the whole interaction is "which of these
 * is it?", and a menu hides six of the seven answers behind a click while
 * costing the same vertical space the chips take. They read left to right from
 * fastest to slowest, matching the viz bar's grid menu, so the two surfaces
 * can be scanned the same way.
 *
 * Silence is the eighth chip, set apart by a rule because it is the one answer
 * that is not a rate: it says this stretch is empty on purpose. That is a
 * different claim from leaving the section untouched, which only says nobody
 * has listened yet — so it has to be a chip you can press, not the absence of
 * a press.
 *
 * The readout under them is what stops a pulse from being an abstraction: a
 * rate is much easier to confirm by ear as "every 250 ms, 8 per bar" than as
 * "1/2 beat", and it is the line that exposes a wrong BPM immediately.
 */

import type { CardSectionSpec } from './CardSection';
import {
  PULSE_RATES,
  PULSE_RATE_INFO,
  PULSE_SILENT,
  pulseSummary,
  type PulseRate,
} from '../../../types/annotationLayer';
import { pulseReadout } from '../../../utils/pulse';

/** Read-only pulse chip for the editor-panel item cards, so the rate is
 *  visible without opening the canvas popover. Renders nothing when the item
 *  has no pulse. */
export function PulseBadge({ rate, color }: {
  rate: PulseRate | undefined;
  color: string;
}) {
  if (!rate) return null;
  const info = PULSE_RATE_INFO[rate];
  return (
    <span
      className="text-[9px] font-mono px-1 py-0.5 rounded self-start"
      style={{ color, background: `${color}1a`, boxShadow: `inset 0 0 0 1px ${color}33` }}
      title={`Pulse: ${info.label} — ${info.description}`}
    >
      {info.glyph} {info.short}
    </span>
  );
}

export interface PulseControlProps {
  rate: PulseRate | undefined;
  /** Layer colour, so the active chip matches the ticks drawn on the canvas. */
  color: string;
  /** Beat-grid context for the readout. Without a BPM the chips still work —
   *  the annotation is about the music, not about whether we have a grid yet —
   *  but nothing can be drawn or measured, and the control says so. */
  bpm?: number;
  beatsPerBar?: number;
  readOnly?: boolean;
  onChange: (rate: PulseRate | undefined) => void;
}

/** One chip. Pulled out of the map so the silence chip on the far side of the
 *  rule is the same button as the seven rates rather than a second copy of
 *  this styling that can drift from them. */
function PulseChip({ option, isActive, color, readOnly, onChange }: {
  option: PulseRate;
  isActive: boolean;
  color: string;
  readOnly: boolean;
  onChange: (rate: PulseRate | undefined) => void;
}) {
  const info = PULSE_RATE_INFO[option];
  return (
    <button
      type="button"
      disabled={readOnly}
      // Clicking the active chip clears the annotation, so the way out is the
      // same gesture as the way in — no separate "none" chip competing with
      // the eight real answers. Clearing is not the same as picking Silent:
      // cleared means unannotated, Silent means annotated as empty.
      onClick={() => onChange(isActive ? undefined : option)}
      className={`rounded px-1.5 py-1 text-[10px] leading-none border transition-colors ${
        readOnly ? 'cursor-not-allowed opacity-60' : 'hover:bg-white/[0.06]'
      } ${isActive ? 'text-slate-50' : 'text-slate-300 border-white/[0.06] bg-[#0a0b0d]'}`}
      style={isActive ? {
        borderColor: color,
        background: `${color}33`,
        boxShadow: `inset 0 0 0 1px ${color}88`,
      } : undefined}
      title={`${info.label}\n${info.description}${isActive ? '\n\nClick again to clear the pulse — which leaves the stretch unannotated, not silent.' : ''}`}
    >
      {info.short}
    </button>
  );
}

export function PulseControl({
  rate, color, bpm, beatsPerBar = 4, readOnly = false, onChange,
}: PulseControlProps) {
  return (
    <div>
      <span className="block text-[9px] text-slate-400 mb-1">
        how often this stretch hits · ticks are drawn from the grid, not stored
      </span>

      <div className="flex flex-wrap items-center gap-1">
        {PULSE_RATES.map((option) => (
          <PulseChip
            key={option}
            option={option}
            isActive={rate === option}
            color={color}
            readOnly={readOnly}
            onChange={onChange}
          />
        ))}

        {/* A rule, not a gap: silence belongs to the same question but is not
            one of the rates, and side by side with 'Bar' it would read as the
            slowest one. */}
        <span className="self-stretch w-px bg-white/[0.08] mx-0.5" aria-hidden />

        <PulseChip
          option={PULSE_SILENT}
          isActive={rate === PULSE_SILENT}
          color={color}
          readOnly={readOnly}
          onChange={onChange}
        />
      </div>

      {rate && (
        <div className="mt-1 flex items-center gap-2">
          <span className="text-[9px] font-mono text-slate-400 truncate">
            {(bpm || rate === PULSE_SILENT)
              ? pulseReadout(rate, bpm, beatsPerBar)
              : `${PULSE_RATE_INFO[rate].label} · no tempo yet — set the grid to see it`}
          </span>
          {!readOnly && (
            <button
              type="button"
              onClick={() => onChange(undefined)}
              className="ml-auto text-[10px] text-slate-400 hover:text-slate-200 underline decoration-dotted shrink-0"
              title="Remove the pulse annotation — the band goes back to its plain appearance."
            >
              clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The card section a pulse-carrying kind mounts. Folded by default like
 *  Prominence, with the rate itself as the summary so a closed section still
 *  says what it holds. */
export function pulseSection(props: PulseControlProps): CardSectionSpec {
  return {
    id: 'pulse',
    title: 'Pulse',
    defaultOpen: false,
    summary: pulseSummary(props.rate) ?? undefined,
    content: <PulseControl {...props} />,
  };
}
