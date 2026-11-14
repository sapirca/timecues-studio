import { describe, expect, it } from 'vitest';
import type { AnnotationLayer, CueItem, LyricsItem, RiffNode, RiffPatternItem } from '../types/annotationLayer';
import {
  convertLyricsToMidi,
  convertToMidiMarkers,
  convertToMidiNotes,
  convertToSonicVisualiser,
  cueItemsToMidiNotes,
  lyricsItemsToExportSections,
  riffLayerToExportSections,
  riffLayerToMidiNotes,
} from './exportSerializers';

/** Read a format-0 SMF back into absolute-tick events — what a DAW sees. */
function readSmf(bytes: Uint8Array) {
  const u32 = (i: number) => (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
  expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('MThd');
  const ppq = (bytes[12] << 8) | bytes[13];
  expect(String.fromCharCode(...bytes.slice(14, 18))).toBe('MTrk');
  const end = 22 + u32(18);
  expect(end).toBe(bytes.length);
  const events: { tick: number; kind: string; a?: number; b?: number; ch?: number; text?: string }[] = [];
  let i = 22;
  let tick = 0;
  const vlq = () => { let v = 0; for (;;) { const c = bytes[i++]; v = (v << 7) | (c & 0x7F); if (!(c & 0x80)) return v; } };
  while (i < end) {
    tick += vlq();
    const st = bytes[i++];
    if (st === 0xFF) {
      const type = bytes[i++];
      const len = vlq();
      const data = bytes.slice(i, i + len);
      i += len;
      const kind = type === 0x51 ? 'tempo' : type === 0x06 ? 'marker' : type === 0x05 ? 'lyric' : type === 0x03 ? 'name' : type === 0x2F ? 'end' : `meta${type}`;
      events.push({ tick, kind, text: kind === 'marker' || kind === 'name' || kind === 'lyric' ? new TextDecoder().decode(data) : undefined });
    } else {
      events.push({ tick, kind: (st & 0xF0) === 0x90 ? 'on' : 'off', a: bytes[i], b: bytes[i + 1], ...((st & 0x0F) ? { ch: st & 0x0F } : {}) });
      i += 2;
    }
  }
  return { ppq, events };
}

const cue = (time: number, extra: Partial<CueItem> = {}): CueItem =>
  ({ id: `c${time}`, time, label: 'x', ...extra }) as CueItem;

describe('MIDI markers', () => {
  it('writes one marker per section, in time order, at 120 BPM by default', () => {
    const { ppq, events } = readSmf(convertToMidiMarkers([
      { start: 2, duration: 1, section: 'chorus' },
      { start: 0.5, duration: 1, section: 'verse' },
    ]));
    // 120 BPM: one second is two quarters.
    expect(events.map((e) => [e.kind, e.tick, e.text])).toEqual([
      ['tempo', 0, undefined],
      ['marker', ppq, 'verse'],
      ['marker', 4 * ppq, 'chorus'],
      ['end', 4 * ppq, undefined],
    ]);
  });
});

describe('MIDI notes from a pitched cue layer', () => {
  it('turns each pitched cue into a note as long and as hard as it was played', () => {
    const notes = cueItemsToMidiNotes([
      cue(1, { note: 57, velocity: 100, decay: 0.5 }),
      cue(2, { note: 60, velocity: 40, decay: 0.25 }),
    ]);
    const { ppq, events } = readSmf(convertToMidiNotes(notes, { name: 'Melody (vocals)' }));
    expect(events[0]).toMatchObject({ kind: 'name', tick: 0, text: 'Melody (vocals)' });
    expect(events.filter((e) => e.kind === 'on' || e.kind === 'off').map((e) => [e.kind, e.tick, e.a, e.b])).toEqual([
      ['on', 2 * ppq, 57, 100],
      ['off', 3 * ppq, 57, 64],
      ['on', 4 * ppq, 60, 40],
      ['off', 4.5 * ppq, 60, 64],
    ]);
  });

  it('keeps the BPM so the notes land on the bar grid too', () => {
    const { ppq, events } = readSmf(convertToMidiNotes(cueItemsToMidiNotes([cue(1, { note: 60, decay: 0.5 })]), { bpm: 90 }));
    // 90 BPM: one second is 1.5 quarters.
    expect(events.find((e) => e.kind === 'on')?.tick).toBe(1.5 * ppq);
  });

  it('a note with no length rings until the next one, as the piano roll draws it', () => {
    const notes = cueItemsToMidiNotes([cue(0, { note: 50 }), cue(0.4, { note: 52, decay: 0.2 })]);
    expect(notes[0]).toMatchObject({ time: 0, end: 0.4 });
  });

  it('a note that ends where the next starts is let go before the next is struck', () => {
    const { events } = readSmf(convertToMidiNotes(cueItemsToMidiNotes([
      cue(1, { note: 60, decay: 0.5 }),
      cue(1.5, { note: 60, decay: 0.5 }),
    ])));
    const at = events.filter((e) => e.kind === 'on' || e.kind === 'off').map((e) => e.kind);
    expect(at).toEqual(['on', 'off', 'on', 'off']);
  });

  it('cuts a held note where the same pitch is struck again', () => {
    const notes = cueItemsToMidiNotes([cue(1, { note: 60, decay: 2 }), cue(1.5, { note: 60, decay: 0.5 })]);
    expect(notes.map((n) => [n.time, n.end])).toEqual([[1, 1.5], [1.5, 2]]);
  });

  it('a layer with no pitches has no notes, so it exports as markers', () => {
    expect(cueItemsToMidiNotes([cue(1), cue(2, { velocity: 90 })])).toEqual([]);
  });

  it('cues without a pitch ride along as markers', () => {
    const { events } = readSmf(convertToMidiNotes(
      cueItemsToMidiNotes([cue(1, { note: 60, decay: 0.5 })]),
      { markers: [{ start: 1, duration: 0, section: 'drop' }] },
    ));
    expect(events.filter((e) => e.kind !== 'tempo' && e.kind !== 'end').map((e) => e.kind)).toEqual(['marker', 'on', 'off']);
  });
});

describe('Sonic Visualiser keeps lengths', () => {
  it('writes time,label for instants only', () => {
    expect(convertToSonicVisualiser([{ start: 1, duration: 0, section: 'a' }])).toBe('1.000000,a\n');
  });
  it('writes time,duration,label (a Regions layer) once anything has a length', () => {
    expect(convertToSonicVisualiser([
      { start: 1, duration: 2, section: 'span, one' },
      { start: 4, duration: 0, section: 'cue' },
    ])).toBe('1.000000,2.000000,"span, one"\n4.000000,0.000000,cue\n');
  });
});

const word = (time: number, end: number, text: string, extra: Partial<LyricsItem> = {}): LyricsItem =>
  ({ id: `w${time}`, time, end, text, kind: 'word', ...extra });

describe('Lyrics export', () => {
  it('writes every lyric as a span labelled with its text', () => {
    expect(lyricsItemsToExportSections([
      word(2, 2.5, 'love'),
      { id: 'l', time: 1, end: 3, text: 'all you need is love', kind: 'line' },
    ])).toEqual([
      { start: 1, duration: 2, section: 'all you need is love' },
      { start: 2, duration: 0.5, section: 'love' },
    ]);
  });

  it('writes words as lyric events, split at their syllables, and lines as markers', () => {
    const { ppq, events } = readSmf(convertLyricsToMidi([
      { id: 'l', time: 0.5, end: 3, text: 'a la ta', kind: 'line' },
      word(1, 2, 'alata', { onsets: [
        { time: 1, text: 'a' }, { time: 1.5, text: 'la' }, { time: 1.75, text: 'ta' },
        { time: 5, text: 'outside' },
      ] }),
      word(2.5, 3, 'yes'),
    ]));
    expect(events.filter((e) => e.kind === 'lyric' || e.kind === 'marker').map((e) => [e.kind, e.tick, e.text])).toEqual([
      ['marker', ppq, 'a la ta'],
      ['lyric', 2 * ppq, 'a'],
      ['lyric', 3 * ppq, 'la'],
      ['lyric', 3.5 * ppq, 'ta'],
      ['lyric', 5 * ppq, 'yes'],
    ]);
  });
});

/** A one-bar node at 120 BPM (2 s): hits on beats 1 and 3. */
const node = (id: string, extra: Partial<RiffNode> = {}): RiffNode => ({
  id, name: id, color: '#fff', stepsPerCycle: 16, subbeatsPerBeat: 4,
  segments: [
    { start: 0, end: 1, kind: 'tick', accent: 90 },
    { start: 1, end: 2, kind: 'empty' },
    { start: 2, end: 3, kind: 'tick' },
    { start: 3, end: 4, kind: 'empty' },
  ],
  ...extra,
});

const riffLayer = (items: RiffPatternItem[], nodes: RiffNode[], drum?: string) =>
  ({ id: 'r', name: 'Riff', type: 'riff-patterns', visible: true, color: '#fff', snap: 'off', items, nodes, combos: [], ...(drum ? { drum } : {}) }) as AnnotationLayer<'riff-patterns'>;

describe('Riff patterns export', () => {
  const item: RiffPatternItem = {
    id: 'i', start: 10, end: 14, label: '', repeatCount: 2,
    sequence: [{ type: 'A', lengthSteps: 16 }, { type: 'B', lengthSteps: 16 }],
    // Play 2 is the second repeat's A: it drops beat 3 and adds a fill on beat 4.
    occurrences: [{ index: 2, event: 'fill', missing: [{ start: 2 }], added: [{ start: 3, end: 3.5, accent: 60 }] }],
  };

  it('writes one region per play, named after its node and how it differed', () => {
    expect(riffLayerToExportSections(riffLayer([item], [node('A'), node('B')]), 120)).toEqual([
      { start: 10, duration: 2, section: 'A' },
      { start: 12, duration: 2, section: 'B' },
      { start: 14, duration: 2, section: 'A · fill' },
      { start: 16, duration: 2, section: 'B' },
    ]);
  });

  it('leaves rests out of the regions', () => {
    const rest: RiffPatternItem = { ...item, repeatCount: 1, occurrences: undefined,
      sequence: [{ type: '__silence__', lengthSteps: 16 }, { type: 'A', lengthSteps: 16 }] };
    expect(riffLayerToExportSections(riffLayer([rest], [node('A')]), 120).map((s) => s.section)).toEqual(['A']);
  });

  it('writes the notes every play struck, the occurrence applied', () => {
    const notes = riffLayerToMidiNotes(riffLayer([item], [node('A'), node('B')], 'kick'), 120);
    expect(notes.filter((n) => n.time >= 14 && n.time < 16)).toEqual([
      { time: 14, end: 14.5, midi: 36, velocity: 90, channel: 9 },
      { time: 15.5, end: 15.75, midi: 36, velocity: 60, channel: 9 },
    ]);
    expect(notes).toHaveLength(4 * 2 - 1 + 1);
  });

  it('plays a pitched note at its pitch on a melodic channel', () => {
    const bass = node('A', { segments: [{ start: 0, end: 4, kind: 'tick', note: 33 }] });
    const one: RiffPatternItem = { ...item, end: 12, repeatCount: 1, occurrences: undefined, sequence: [{ type: 'A', lengthSteps: 16 }] };
    const { events } = readSmf(convertToMidiNotes(riffLayerToMidiNotes(riffLayer([one], [bass]), 120), { bpm: 120 }));
    expect(events.filter((e) => e.kind === 'on')).toEqual([{ tick: 10 * 2 * 480, kind: 'on', a: 33, b: 127 }]);
  });
});
