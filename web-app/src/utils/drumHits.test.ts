import { describe, it, expect } from 'vitest';
import { cueToSection, kitPieceOf, pitchNoteToSection, struckHitFields } from './drumHits';
import { karaokeRowsOf } from './karaokeRows';
import { cueItemsToMidiNotes } from './exportSerializers';
import { convertDetectorItems } from '../components/inspector-v2/detectorConvert';
import type { CustomCueItem } from '../types/customScript';
import type { CueItem } from '../types/annotationLayer';

describe('struckHitFields — one shape for every cue', () => {
  it('reads the detector envelope (level_db) and the layer shape (levelDb) alike', () => {
    expect(struckHitFields({ velocity: 112, level_db: -3.2, color: '#f87171' }))
      .toEqual({ velocity: 112, levelDb: -3.2, color: '#f87171' });
    expect(struckHitFields({ velocity: 112, levelDb: -3.2 }))
      .toEqual({ velocity: 112, levelDb: -3.2 });
  });

  it('reads note, decay (ms or s) and importance', () => {
    expect(struckHitFields({ note: 36, decay_ms: 180, importance: 'optional' }))
      .toEqual({ note: 36, decay: 0.18, importance: 'optional' });
    expect(struckHitFields({ decay: 0.25 })).toEqual({ decay: 0.25 });
    expect(struckHitFields({ decay_ms: 0, importance: 'high' })).toEqual({});
  });

  it('omits what is not set instead of writing undefined or null', () => {
    const out = struckHitFields({ velocity: null, levelDb: undefined, color: '' });
    expect(out).toEqual({});
    expect(Object.keys(out)).toHaveLength(0);
  });
});

describe('Copy to manual layer keeps a struck hit', () => {
  it('carries velocity, level and colour from a detector cue into the user layer', () => {
    const items: CustomCueItem[] = [
      { time_ms: 1000, label: 'kick', description: null, intensity: null, candidates: null,
        velocity: 100, level_db: -2, color: '#f87171', note: 36, decay_ms: 180, importance: 'optional' },
      { time_ms: 2000, label: 'clap', description: null, intensity: null, candidates: null },
    ];
    const [hit, plain] = convertDetectorItems('cues', items) as CueItem[];
    expect(hit).toMatchObject({ time: 1, label: 'kick', velocity: 100, levelDb: -2, color: '#f87171', note: 36, decay: 0.18, importance: 'optional' });
    for (const k of ['velocity', 'levelDb', 'color', 'note', 'decay', 'importance']) expect(plain).not.toHaveProperty(k);
  });
});

describe('midiNoteName', () => {
  it('names middle C and the kick range', async () => {
    const { midiNoteName } = await import('./drumHits');
    expect(midiNoteName(60)).toBe('C4');
    expect(midiNoteName(36)).toBe('C2');
    expect(midiNoteName(61)).toBe('C#4');
  });
});

describe('kitPieceOf — which cues are drum hits', () => {
  it('reads detector labels and hand-typed spellings', () => {
    expect(['kick', 'BD', 'Bass drum', 'snare', 'Clap', 'rimshot', 'hat', 'Hi-hat', 'hihats', 'HH', 'ride']
      .map(kitPieceOf)).toEqual(['kick', 'kick', 'kick', 'snare', 'snare', 'snare', 'hat', 'hat', 'hat', 'hat', 'hat']);
    expect(['drop', 'chorus', 'what', 'shh', '', 'E2', 'B1'].map(kitPieceOf)).toEqual([null, null, null, null, null, null, null]);
  });
});

describe('an algorithm lane keeps the pitch of its notes', () => {
  it('a point cue keeps its note and how long it rings', () => {
    expect(cueToSection({ time: 1, label: 'A4', velocity: 90, note: 69, decay_ms: 250 }))
      .toEqual({ time: 1, endTime: 1, type: 'cue', label: 'A4', velocity: 90, note: 69, decay: 0.25 });
    expect(cueToSection({ time: 1, label: 'hit' })).toEqual({ time: 1, endTime: 1, type: 'cue', label: 'hit' });
  });

  it("a basic-pitch note carries its MIDI number and length, and no made-up velocity", () => {
    const sec = pitchNoteToSection({ time: 2, end: 2.5, pitch: 'C4', midi: 60 });
    expect(sec).toEqual({ time: 2, endTime: 2.5, type: 'C4', label: 'C4', note: 60, decay: 0.5 });
  });

  it('so the lane reaches the piano roll, a copy of it, and the MIDI export', () => {
    const lane = [pitchNoteToSection({ time: 0, end: 0.5, pitch: 'C4', midi: 60 }),
                  pitchNoteToSection({ time: 0.5, end: 1, pitch: 'E4', midi: 64 })];
    const rows = karaokeRowsOf('bp', 'basic-pitch', '#ffffff', lane);
    expect(rows.map((r) => r.kind)).toEqual(['notes']);
    // "Copy → Manual" builds its cues through struckHitFields, as InspectorPageV2 does.
    const copied = lane.map((s, i) => ({ id: String(i), time: s.time, label: s.label, ...struckHitFields(s) })) as CueItem[];
    expect(cueItemsToMidiNotes(copied).map((n) => [n.midi, n.time, n.end])).toEqual([[60, 0, 0.5], [64, 0.5, 1]]);
  });
});
