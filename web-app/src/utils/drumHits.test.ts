import { describe, it, expect } from 'vitest';
import { struckHitFields } from './drumHits';
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
