/**
 * An item's `envelope` — a lyric's or a span's — is a measurement of the sound
 * under it as it was timed when it was measured (Extract ADSR, from its card or
 * its lane's ⋮, or a Sounds detector copy). Retime the item and the measurement
 * describes a span the item no longer has, so it is deleted rather than drawn
 * stale; extracting again puts it back. These are the document-level rules for
 * both directions, the same for both kinds.
 */
import type {
  AnnotationLayer, AnnotationLayersDocument, LyricsItem, SoundEnvelope, SpanItem,
} from '../types/annotationLayer';
import { isEnergySpan, measureAdsr, type AdsrEnvelope } from './energySpan';
import { formatClockTime as fmtTime } from './clockTime';

/** What an envelope is read off: the mix, or one stem. */
export type EnvelopeSource = NonNullable<SoundEnvelope['source']>;

/** The lane kinds whose items carry an `envelope`. */
export type EnvelopeLayerType = 'lyrics' | 'spans';
type EnvelopeItem = LyricsItem | SpanItem;

export function isEnvelopeLayer(layer: AnnotationLayer): layer is AnnotationLayer<EnvelopeLayerType> {
  return layer.type === 'lyrics' || layer.type === 'spans';
}

/** Where an item starts and ends, whichever kind it is. */
function bounds(it: EnvelopeItem): { time: number; end: number | undefined } {
  return 'start' in it ? { time: it.start, end: it.end } : { time: it.time, end: it.end };
}

/** An envelope a retime took away: whose, and what it had been read from —
 *  so the page can read the item again, from the same source, where it is now. */
export interface DroppedEnvelope { layerId: string; itemId: string; source: EnvelopeSource | undefined }

/** `next` with the envelope removed from every item whose start or end moved
 *  in this edit while its envelope stayed — a retime, by any path (drag, trim,
 *  popover, nudge, a move to another lane). An edit that sets the envelope
 *  itself (a measurement, an undo) keeps it. Returns `next` unchanged, the same
 *  object, when nothing was retimed. `onDrop` hears each one removed. */
export function dropRetimedEnvelopes(
  prev: AnnotationLayersDocument | null,
  next: AnnotationLayersDocument | null,
  onDrop?: (dropped: DroppedEnvelope) => void,
): AnnotationLayersDocument | null {
  if (!prev || !next || prev === next) return next;
  const before = new Map<string, EnvelopeItem>();
  for (const layer of prev.layers) {
    if (!isEnvelopeLayer(layer)) continue;
    for (const it of layer.items as EnvelopeItem[]) if (it.envelope) before.set(it.id, it);
  }
  if (before.size === 0) return next;
  let changed = false;
  const layers = next.layers.map((layer) => {
    if (!isEnvelopeLayer(layer)) return layer;
    let hit = false;
    const items = (layer.items as EnvelopeItem[]).map((it) => {
      const was = before.get(it.id);
      if (!was || !it.envelope || it.envelope !== was.envelope) return it;
      const a = bounds(it);
      const b = bounds(was);
      if (a.time === b.time && a.end === b.end) return it;
      hit = true;
      onDrop?.({ layerId: layer.id, itemId: it.id, source: was.envelope!.source });
      return withoutEnvelope(it);
    });
    if (!hit) return layer;
    changed = true;
    return { ...layer, items } as AnnotationLayer;
  });
  return changed ? { ...next, layers } : next;
}

function withoutEnvelope<T extends EnvelopeItem>(it: T): T {
  const out = { ...it };
  delete out.envelope;
  return out;
}

/** An item to measure: its id and span as the lane holds it now. */
export interface MeasuredWord { id: string; time: number; end: number }

/** The lyrics lane's items that are each one sound: every timed word, and
 *  every line with no word inside it. A vocalise written as a line (`אהההה`)
 *  is one held sound; a line over words is a phrase whose words say where its
 *  sounds are. Same rule as `sounds` in the detector. */
export function measurableWords(layer: AnnotationLayer<'lyrics'>): MeasuredWord[] {
  const timed = layer.items.filter((it) => it.end != null && it.end > it.time && it.text.trim());
  const words = timed.filter((it) => it.kind === 'word');
  const lone = timed.filter((it) => it.kind === 'line'
    && !words.some((w) => w.time < it.end! && w.end! > it.time));
  return [...words, ...lone].map((it) => ({ id: it.id, time: it.time, end: it.end! }));
}

/** What Extract ADSR sends. A lane: its lyrics' sounds (measurableWords), or
 *  every span but an ⚡ Energy one (that span is a measurement already, with
 *  its own envelope). One item (its card): that item alone, whatever kind of
 *  lyric — the person asked for that one. Untimed items are never sent. */
export function envelopeTargets(layer: AnnotationLayer<EnvelopeLayerType>, onlyId?: string): MeasuredWord[] {
  if (onlyId == null && layer.type === 'lyrics') return measurableWords(layer as AnnotationLayer<'lyrics'>);
  const out: MeasuredWord[] = [];
  for (const it of layer.items as EnvelopeItem[]) {
    if (onlyId != null && it.id !== onlyId) continue;
    if ('start' in it && isEnergySpan(it.description)) continue;
    const { time, end } = bounds(it);
    if (end != null && end > time) out.push({ id: it.id, time, end });
  }
  return out;
}

/** The lane with a measurement applied: each item that was sent and is still
 *  timed as it was gets its envelope. Where the answer is null (no single sound
 *  there) it loses the one it had only if that was read off the same `source`
 *  — trying another stem that does not hold the sound never wipes a reading
 *  made where it does. An item retimed while the measurement ran keeps what
 *  the retime left (no envelope); items that were not sent are untouched. */
export function applyMeasuredEnvelopes<L extends AnnotationLayer<EnvelopeLayerType>>(
  layer: L,
  sent: readonly MeasuredWord[],
  envelopes: Readonly<Record<string, SoundEnvelope | null>>,
  source?: EnvelopeSource,
): L {
  const asSent = new Map(sent.map((w) => [w.id, w]));
  let changed = false;
  const items = (layer.items as EnvelopeItem[]).map((it) => {
    const w = asSent.get(it.id);
    const { time, end } = bounds(it);
    if (!w || !(it.id in envelopes) || time !== w.time || end !== w.end) return it;
    const env = envelopes[it.id];
    if (env) { changed = true; return { ...it, envelope: env }; }
    if (!it.envelope || it.envelope.source !== source) return it;
    changed = true;
    return withoutEnvelope(it);
  });
  return changed ? { ...layer, items } : layer;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const toDb = (linear: number) => Math.round(20 * Math.log10(Math.max(linear, 1e-6)) * 10) / 10;

/** The span-relative A/D/S/R reading laid onto the song: the attack is the
 *  10%→90% rise INTO the peak, so it is anchored backwards from it, never
 *  before the window it was read from. */
export function adsrToSoundEnvelope(adsr: AdsrEnvelope, startSec: number, source?: EnvelopeSource): SoundEnvelope {
  const peak = startSec + adsr.peakAtMs / 1000;
  const decayEnd = peak + adsr.decayMs / 1000;
  const release = decayEnd + adsr.sustainMs / 1000;
  const env: SoundEnvelope = {
    start: round3(Math.max(startSec, peak - adsr.attackMs / 1000)),
    peak: round3(peak),
    decayEnd: round3(decayEnd),
    release: round3(release),
    end: round3(release + adsr.releaseMs / 1000),
    peakDb: toDb(adsr.peakRms),
  };
  if (adsr.sustainMs > 0 && adsr.sustainLevel > 0) env.sustainDb = Math.min(0, toDb(adsr.sustainLevel));
  if (source) env.source = source;
  return env;
}

/** Each target's envelope, read off `audio` in the browser. A window holding
 *  several pulses (a gobble, a trill) gets their outer shape taken together,
 *  marked with `peaks` so it never passes for one hit's. Null only where
 *  nothing could be read. */
export function extractEnvelopes(
  audio: AudioBuffer,
  targets: readonly MeasuredWord[],
  source?: EnvelopeSource,
): Record<string, SoundEnvelope | null> {
  const out: Record<string, SoundEnvelope | null> = {};
  for (const w of targets) {
    const { adsr, rejection, outer } = measureAdsr(audio, w.time, w.end);
    const read = adsr ?? outer;
    if (!read) { out[w.id] = null; continue; }
    const env = adsrToSoundEnvelope(read, w.time, source);
    if (!adsr && rejection) env.peaks = rejection.gestureCount;
    out[w.id] = env;
  }
  return out;
}

const ms = (s: number) => `${Math.round(s * 1000)} ms`;

/** The envelope in words, for an item's tooltip (leading " · "). */
export function envelopeTitle(e: SoundEnvelope): string {
  return ` · sound ${fmtTime(e.start, 3)}–${fmtTime(e.end, 3)}: attack ${ms(e.peak - e.start)}, `
    + `decay ${ms(e.decayEnd - e.peak)}, `
    + (e.sustainDb != null ? `sustain ${ms(e.release - e.decayEnd)} at ${e.sustainDb} dB, ` : 'no sustain, ')
    + `release ${ms(e.end - e.release)} (peak ${e.peakDb} dBFS)`
    + (e.peaks ? ` — outer shape of ${e.peaks} peaks` : '');
}

/** The loudest peak among a lane's envelopes — every shape in the lane is
 *  scaled against it. -Infinity when none has one. */
export function loudestPeakDb(envelopes: readonly (SoundEnvelope | undefined)[]): number {
  let loudest = -Infinity;
  for (const e of envelopes) if (e && e.peakDb > loudest) loudest = e.peakDb;
  return loudest;
}
