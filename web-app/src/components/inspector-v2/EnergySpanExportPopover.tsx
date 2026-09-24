/**
 * Floating popover opened from a pending timeline selection's "⚡ Energy"
 * action. Lets the user pick a single source (mix or one isolated Demucs
 * stem — picking a stem instead of the noisy full-mix composite is the
 * whole point), computes that source's energy trend over the selection via
 * `computeStemEnergySpan`, and saves the result into a Span layer as a new
 * item — label carries a short human tag, description carries the full JSON
 * (curve, trend, envelope, etc.) for an external consumer (e.g. the LOL
 * light-show agent) to read via the normal Span export flow.
 *
 * The Envelope subsection reads the same selection as A/D/S/R — the shape of
 * the gesture, where the trend line only gives its direction. It only appears
 * when the selection actually holds a single gesture; over two drops there is
 * no one envelope to show, so the subsection is replaced by the split points
 * that would give one envelope each. The trend and curve export either way.
 *
 * Brightness (spectral centroid) is measured alongside, per source, and shown
 * next to the energy trend rather than buried in the description — flipping
 * between sources to see which one carries the gesture is the whole point of
 * the Source select, and on a build that is a comparison of *brightness*: the
 * level falls on every source that was mixed out, while the riser holding the
 * tension is the one whose centroid climbs.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { getAudioBuffer } from '../../services/audioAnalysis';
import { ALL_DEMUCS_STEMS, type StemManifest } from '../../hooks/useDemucsStems';
import { buildEnergySpanExport, computeStemEnergySpan, fmtHz, type EnergySpanExport } from '../../utils/energySpan';
import { BRIGHTNESS_COLOR } from './shared/EnvelopeLane';
import { useAnnotationPopover, type PopoverAnchor } from './shared/useAnnotationPopover';
import type { EnergySpanLayerOption } from './energySpanLayerOptions';

export type EnergySpanExportAnchor = PopoverAnchor;

export function useEnergySpanExportPopover() {
  return useAnnotationPopover({ width: 300, height: 400 });
}

type SourceOption = 'mix' | (typeof ALL_DEMUCS_STEMS)[number];

interface EnergySpanExportPopoverProps {
  popoverRef: React.RefObject<HTMLDivElement | null>;
  positionStyle: CSSProperties;
  onClose: () => void;
  songSlug: string;
  startSec: number;
  endSec: number;
  /** The song's own audio URL. The mix is fetched and decoded from it like any
   *  stem, rather than borrowing the buffer the page already has — see the
   *  note in the effect below. */
  mixAudioUrl: string;
  stemManifest: StemManifest | null;
  /** Where this export can be saved, in menu order — build it with
   *  `buildEnergySpanLayerOptions`, which puts the song's energies lane first
   *  so the preselected destination is that lane rather than whichever span
   *  lane happens to sort first. Entries carrying a sentinel id are lanes the
   *  caller materializes on save. */
  spanLayerOptions: EnergySpanLayerOption[];
  /** Destination to open on, when the caller already knows which lane this
   *  export was asked for — the energies lane's own "+ ADD" names its lane.
   *  Falls back to the first option (the energies lane) when absent, which is
   *  what the pending-pill's "⚡ ENERGY" wants. */
  initialLayerId?: string;
  onSaveToLayer: (layerId: string, exportData: EnergySpanExport) => void;
}

export function EnergySpanExportPopover({
  popoverRef, positionStyle, onClose,
  songSlug, startSec, endSec, mixAudioUrl, stemManifest,
  spanLayerOptions, initialLayerId, onSaveToLayer,
}: EnergySpanExportPopoverProps) {
  const availableSources: SourceOption[] = [
    'mix',
    ...ALL_DEMUCS_STEMS.filter((s) => !!stemManifest?.stems[s]),
  ];
  const [source, setSource] = useState<SourceOption>('mix');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [exportData, setExportData] = useState<EnergySpanExport | null>(null);
  const [targetLayerId, setTargetLayerId] = useState<string>(
    () => (initialLayerId && spanLayerOptions.some((o) => o.id === initialLayerId)
      ? initialLayerId
      : spanLayerOptions[0]?.id ?? ''),
  );
  // Decoding a source's full audio file is the slow part — cache per popover
  // lifetime so flipping between sources to compare trends doesn't re-fetch.
  const bufferCache = useRef<Map<string, AudioBuffer>>(new Map());

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    (async () => {
      try {
        // The mix is fetched and decoded here like every stem, NOT taken from
        // the buffer the page already holds. That one comes from
        // `ws.getDecodedData()`, and WaveSurfer decodes at its default
        // `sampleRate: 8000` because all it needs is peaks to draw — which is
        // the right call for a waveform and ruinous for this measurement.
        // Everything above 4kHz is gone before we see it, so a riser or a
        // hi-hat build cannot register at all: the same span reads
        // 780Hz → 1.1kHz off the playback buffer and 2.4kHz → 4.3kHz off the
        // real file. Energy drifts with it too, enough to move a borderline
        // span across the flat threshold. Raising WaveSurfer's rate instead
        // would five-times the memory of every song on screen to serve this
        // popover; re-decoding here costs one fetch, once per popover.
        const url = source === 'mix' ? mixAudioUrl : stemManifest?.stems[source] ?? null;
        if (!url) { setStatus('error'); return; }
        let buffer = bufferCache.current.get(url) ?? null;
        if (!buffer) {
          buffer = await getAudioBuffer(url);
          bufferCache.current.set(url, buffer);
        }
        if (cancelled) return;
        const result = computeStemEnergySpan({ audioBuffer: buffer, startSec, endSec });
        setExportData(buildEnergySpanExport({ songSlug, stem: source, startSec, endSec, result }));
        setStatus('ready');
      } catch (e) {
        console.error('[energy-span] failed to compute', e);
        if (!cancelled) setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, [source, songSlug, startSec, endSec, mixAudioUrl, stemManifest]);

  return (
    <div
      ref={popoverRef}
      data-annotation-popover
      style={{ ...positionStyle, width: 300 }}
      className="z-50 bg-[#1e242e] border border-white/[0.16] rounded-md shadow-[0_0_28px_rgba(148,163,184,0.30),0_20px_45px_-12px_rgba(0,0,0,0.75)] p-3 space-y-2"
    >
      <div className="flex items-center gap-2 pb-1.5 border-b border-white/[0.04]">
        <span className="text-[10px] uppercase tracking-wider font-medium text-sky-300">Export Energy</span>
        <button
          onClick={onClose}
          className="w-5 h-5 rounded flex items-center justify-center text-slate-300 hover:text-slate-100 hover:bg-white/[0.06] text-[12px] ml-auto"
          title="Close (Esc)"
        >
          ×
        </button>
      </div>

      <label className="block">
        <span className="block text-[9px] uppercase tracking-wider text-slate-300 mb-0.5">Source</span>
        <select
          value={source}
          onChange={(e) => setSource(e.target.value as SourceOption)}
          className="w-full bg-[#0a0b0d] border border-white/[0.06] rounded px-2 py-1 text-[12px] text-slate-100 focus:outline-none focus:ring-1 focus:ring-sky-400/40"
        >
          {availableSources.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </label>

      {status === 'ready' && exportData?.brightness_hz && exportData.brightness_trend && (
        <div className="flex items-baseline gap-1.5 text-[10px]">
          <span className="text-[9px] uppercase tracking-wider text-slate-300">Brightness</span>
          <span style={{ color: BRIGHTNESS_COLOR }}>
            {exportData.brightness_trend === 'flat'
              ? `flat near ${fmtHz(exportData.brightness_hz.start)}`
              : `${exportData.brightness_trend === 'increasing' ? 'rises' : 'falls'} ` +
                `${fmtHz(exportData.brightness_hz.start)} → ${fmtHz(exportData.brightness_hz.end)}`}
          </span>
          {exportData.trend === 'decreasing' && exportData.brightness_trend === 'increasing' && (
            <span className="ml-auto text-[9px] text-slate-400">reads as a build</span>
          )}
        </div>
      )}

      <div className="text-[11px] text-slate-300 min-h-[2.5em]">
        {status === 'loading' && <span className="text-slate-500 italic">Computing…</span>}
        {status === 'error' && <span className="text-red-300">Couldn't load that source's audio.</span>}
        {status === 'ready' && exportData && (
          <span>{exportData.description}</span>
        )}
      </div>

      {status === 'ready' && exportData?.envelope_rejected && (
        <div className="rounded border border-amber-400/25 bg-amber-400/[0.06] px-2 py-1.5 space-y-1">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[9px] uppercase tracking-wider text-slate-300">Envelope</span>
            <span className="text-[10px] text-amber-300/90">
              not a single gesture ({exportData.envelope_rejected.gesture_count})
            </span>
          </div>
          <div className="text-[9px] text-slate-400 leading-snug">
            A/D/S/R describes one onset, peak and decline. Split the selection at{' '}
            <span className="font-mono text-slate-200">
              {exportData.envelope_rejected.split_at_ms
                .map((ms) => `${(startSec + ms / 1000).toFixed(1)}s`)
                .join(', ')}
            </span>{' '}
            to read one envelope per gesture.
          </div>
        </div>
      )}

      {status === 'ready' && exportData?.envelope && (
        <div className="rounded border border-white/[0.06] bg-[#0a0b0d] px-2 py-1.5 space-y-1">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[9px] uppercase tracking-wider text-slate-300">Envelope</span>
            <span className="text-[10px] text-amber-300/90">{exportData.envelope.shape}</span>
            <span
              className="text-[9px] font-mono text-slate-500 ml-auto"
              title="peak RMS before in-span normalization — compare levels across spans with this"
            >
              peak {exportData.envelope.peak_rms.toFixed(3)}
            </span>
          </div>
          <div className="grid grid-cols-4 gap-1">
            {([
              ['A', `${exportData.envelope.attack_ms}ms`, 'Attack — 10%→90% rise into the peak'],
              ['D', `${exportData.envelope.decay_ms}ms`, 'Decay — peak until the fall settles'],
              ['S', `${exportData.envelope.sustain_ms}ms`, 'Sustain — length of the plateau, 0 when the fall never settles'],
              ['R', `${exportData.envelope.release_ms}ms`, 'Release — final descent to the end of the span'],
            ] as const).map(([letter, value, title]) => (
              <div key={letter} className="text-center" title={title}>
                <div className="text-[9px] uppercase tracking-wider text-slate-500">{letter}</div>
                <div className="text-[10px] font-mono text-slate-100">{value}</div>
              </div>
            ))}
          </div>
          <div
            className="text-[9px] text-slate-500"
            title="plateau level relative to this span's own peak"
          >
            sustain level {exportData.envelope.sustain_level.toFixed(2)} of peak
          </div>
        </div>
      )}

      <label className="block">
        <span className="block text-[9px] uppercase tracking-wider text-slate-300 mb-0.5">Save into</span>
        <select
          value={targetLayerId}
          onChange={(e) => setTargetLayerId(e.target.value)}
          className="w-full bg-[#0a0b0d] border border-white/[0.06] rounded px-2 py-1 text-[12px] text-slate-100 focus:outline-none focus:ring-1 focus:ring-sky-400/40"
        >
          {spanLayerOptions.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
      </label>

      <div className="flex items-center justify-end pt-1.5 border-t border-white/[0.04]">
        <button
          onClick={() => exportData && onSaveToLayer(targetLayerId, exportData)}
          disabled={status !== 'ready' || !exportData || !targetLayerId}
          className="px-2.5 py-1 rounded text-[10px] uppercase tracking-wider border transition-colors bg-sky-500/20 hover:bg-sky-500/30 border-sky-400/40 text-sky-200 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-sky-500/20"
        >
          Save to Span layer
        </button>
      </div>
    </div>
  );
}
