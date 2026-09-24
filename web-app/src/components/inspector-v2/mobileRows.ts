/* Row catalogue and sizes for the phone's row sheet (MobileRowSheet) and the
   row heights SharedVizPanel applies. */

/** Every signal row, in the SIGNALS menu's order, with its row id. */
export const SIGNAL_ROWS: { id: string; label: string; color: string }[] = [
  { id: 'waveform', label: '3-Band', color: '#6366f1' },
  { id: 'eq', label: 'EQ', color: '#60a5fa' },
  { id: 'spectrogram', label: 'Spectrogram', color: '#8b5cf6' },
  { id: 'cepstrogram', label: 'MFCC', color: '#c084fc' },
  { id: 'chroma', label: 'Chroma', color: '#84cc16' },
  { id: 'tempogram', label: 'Tempogram', color: '#d946ef' },
  { id: 'ssm', label: 'SSM', color: '#f97316' },
  { id: 'energy', label: 'Energy', color: '#f59e0b' },
  { id: 'brightness', label: 'Brightness', color: '#22d3ee' },
  { id: 'novelty', label: 'Novelty', color: '#a78bfa' },
  { id: 'onsets', label: 'Onsets', color: '#f472b6' },
  { id: 'flux', label: 'Spectral Flux', color: '#10b981' },
];
export const SIGNAL_ROW_IDS = new Set(SIGNAL_ROWS.map((s) => s.id));

export type RowSize = 'S' | 'M' | 'L' | 'XL';
export const ROW_SIZES: RowSize[] = ['S', 'M', 'L', 'XL'];
/** Height multiplier per size. M is the row's own height; XL is tall enough
 *  to read a spectrogram's bands without a separate full-screen view. */
export const ROW_SIZE_SCALE: Record<RowSize, number> = { S: 0.6, M: 1, L: 1.6, XL: 2.6 };

export interface RowSheetTarget {
  /** The row's id in the row order, when the tapped label belongs to one. */
  rowId?: string;
  name: string;
  color: string;
}

