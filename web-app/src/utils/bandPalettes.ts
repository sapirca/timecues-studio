// Palette options for the 3-band frequency waveform.
//
// Each palette defines explicit RGBA for the Low/Mid/High bands in both
// dark and light themes. The colors are semi-transparent so overlapping
// bands remain visible.

export type BandPaletteId =
  | 'classic'
  | 'cool'
  | 'sunset'
  | 'forest'
  | 'mono';

export interface BandColors {
  low: string;
  mid: string;
  high: string;
}

export interface BandPalette {
  id: BandPaletteId;
  label: string;
  hint: string;
  dark: BandColors;
  light: BandColors;
}

export const BAND_PALETTES: Record<BandPaletteId, BandPalette> = {
  classic: {
    id: 'classic',
    label: 'Classic',
    hint: 'Blue · Orange · Gray (Rekordbox-style)',
    dark: {
      low:  'rgba(59, 130, 246, 0.90)',   // blue-500
      mid:  'rgba(249, 115, 22, 0.80)',   // orange-500
      high: 'rgba(210, 210, 220, 0.70)',  // near-white
    },
    light: {
      low:  'rgba(37, 99, 235, 0.75)',    // blue-600
      mid:  'rgba(234, 88, 12, 0.70)',    // orange-600
      high: 'rgba(71, 85, 105, 0.55)',    // slate-600
    },
  },
  cool: {
    id: 'cool',
    label: 'Cool',
    hint: 'Violet · Teal · Slate',
    dark: {
      low:  'rgba(167, 139, 250, 0.85)',  // violet-400
      mid:  'rgba(45, 212, 191, 0.75)',   // teal-400
      high: 'rgba(210, 210, 220, 0.70)',
    },
    light: {
      low:  'rgba(124, 58, 237, 0.80)',   // violet-600
      mid:  'rgba(13, 148, 136, 0.70)',   // teal-600
      high: 'rgba(71, 85, 105, 0.55)',
    },
  },
  sunset: {
    id: 'sunset',
    label: 'Sunset',
    hint: 'Rose · Amber · Slate',
    dark: {
      low:  'rgba(244, 114, 182, 0.85)',  // pink-400
      mid:  'rgba(251, 191, 36, 0.80)',   // amber-400
      high: 'rgba(210, 210, 220, 0.70)',
    },
    light: {
      low:  'rgba(219, 39, 119, 0.75)',   // pink-600
      mid:  'rgba(217, 119, 6, 0.70)',    // amber-600
      high: 'rgba(71, 85, 105, 0.55)',
    },
  },
  forest: {
    id: 'forest',
    label: 'Forest',
    hint: 'Indigo · Emerald · Slate',
    dark: {
      low:  'rgba(129, 140, 248, 0.85)',  // indigo-400
      mid:  'rgba(52, 211, 153, 0.75)',   // emerald-400
      high: 'rgba(210, 210, 220, 0.70)',
    },
    light: {
      low:  'rgba(79, 70, 229, 0.75)',    // indigo-600
      mid:  'rgba(5, 150, 105, 0.70)',    // emerald-600
      high: 'rgba(71, 85, 105, 0.55)',
    },
  },
  mono: {
    id: 'mono',
    label: 'Mono',
    hint: 'Grayscale, no hue',
    dark: {
      low:  'rgba(226, 232, 240, 0.85)',  // slate-200
      mid:  'rgba(148, 163, 184, 0.75)',  // slate-400
      high: 'rgba(100, 116, 139, 0.70)',  // slate-500
    },
    light: {
      low:  'rgba(30, 41, 59, 0.80)',     // slate-800
      mid:  'rgba(71, 85, 105, 0.60)',    // slate-600
      high: 'rgba(148, 163, 184, 0.65)',  // slate-400
    },
  },
};

export const DEFAULT_BAND_PALETTE: BandPaletteId = 'classic';

export function getBandColors(id: BandPaletteId, theme: 'light' | 'dark'): BandColors {
  const p = BAND_PALETTES[id] ?? BAND_PALETTES[DEFAULT_BAND_PALETTE];
  return theme === 'light' ? p.light : p.dark;
}
