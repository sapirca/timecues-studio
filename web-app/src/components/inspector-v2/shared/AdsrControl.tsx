import type { SoundEnvelope } from '../../../types/annotationLayer';
import type { EnvelopeSource } from '../../../utils/soundEnvelopes';

const ms = (s: number) => `${Math.round(s * 1000)}ms`;

const SOURCE_LABEL: Record<EnvelopeSource, string> = {
  mix: 'Mix', vocals: 'Vocals', drums: 'Drums', bass: 'Bass', other: 'Other', guitar: 'Guitar', piano: 'Piano',
};

/** The four stages, as the lane draws them. */
function stages(e: SoundEnvelope): [string, string, string][] {
  return [
    ['A', ms(e.peak - e.start), 'Attack — the rise into the peak'],
    ['D', ms(e.decayEnd - e.peak), 'Decay — the peak down to the sustain'],
    ['S', e.sustainDb != null ? ms(e.release - e.decayEnd) : '—', e.sustainDb != null ? `Sustain — held at ${e.sustainDb} dB under the peak` : 'No sustain: the sound decays straight into its release'],
    ['R', ms(e.end - e.release), 'Release — the fall to silence'],
  ];
}

/**
 * One button per source the song has — the mix and each separated stem. A
 * press extracts from that source. The full mix often holds several sounds at
 * once where one stem holds the one you marked, so the source is a choice, not
 * a setting: the button you press says where it is read. The same row on an
 * item's card and in a lane's ⋮ menu.
 */
export function AdsrSourceButtons({ sources, current, onPick, disabled, what }: {
  sources: readonly EnvelopeSource[];
  /** The source the present envelope was read off, drawn pressed. */
  current?: EnvelopeSource;
  onPick: (source: EnvelopeSource) => void;
  disabled?: boolean;
  /** "this item" / `every item of "Pads"` — for the tooltips. */
  what: string;
}) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Extract ADSR from">
      {sources.map((s) => (
        <button
          key={s}
          type="button"
          disabled={disabled}
          aria-pressed={s === current}
          onClick={() => onPick(s)}
          title={`Read the attack, decay, sustain and release of ${what} off ${s === 'mix' ? 'the full mix' : `the ${s} stem`}. Several pulses there (a gobble, a trill) get their outer shape taken together. ⌘Z undoes it.`}
          className={`min-h-[32px] px-2.5 rounded border text-[11px] tracking-wide focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 disabled:opacity-50 disabled:cursor-wait ${
            s === current
              ? 'border-sky-300 bg-sky-400/20 text-sky-100'
              : 'border-sky-400/40 text-sky-200 hover:bg-sky-400/10'
          }`}
        >
          {SOURCE_LABEL[s]}
        </button>
      ))}
    </div>
  );
}

export interface AdsrControlProps {
  envelope: SoundEnvelope | undefined;
  /** The sources the song has. Empty on a read-only card. */
  sources: readonly EnvelopeSource[];
  onExtract?: (source: EnvelopeSource) => void;
  extracting: boolean;
}

export function AdsrControl({ envelope, sources, onExtract, extracting }: AdsrControlProps) {
  return (
    <div className="space-y-1.5">
      {envelope ? (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] tabular-nums whitespace-nowrap" title={`Peak ${envelope.peakDb} dBFS`}>
          {stages(envelope).map(([k, v, hint]) => (
            <span key={k} title={hint} className="text-slate-300">
              <span className="text-slate-500 mr-1">{k}</span>{v}
            </span>
          ))}
          {envelope.peaks && (
            <span className="text-slate-500" title="The item holds several pulses; the envelope is their outer shape taken together, not one pulse's.">
              outer shape of {envelope.peaks} peaks
            </span>
          )}
        </div>
      ) : (
        <div className="text-[10px] text-slate-500">Not extracted yet.</div>
      )}
      {onExtract && sources.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-500 shrink-0">{extracting ? 'Extracting…' : envelope ? 'Re-extract from' : 'Extract from'}</span>
          <AdsrSourceButtons sources={sources} current={envelope?.source} onPick={onExtract} disabled={extracting} what="this item" />
        </div>
      )}
    </div>
  );
}
