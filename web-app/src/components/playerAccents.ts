import type { PlayerAccent } from './PlayerPanel';

export const WAVEFORM_PEAK_COLOR = '#f97316'; // orange-500 — outer peak halo
export const WAVEFORM_RMS_COLOR  = '#8b5cf6'; // violet-500 — inner RMS body

export const PLAYER_ACCENT_BLUE: PlayerAccent = {
  playBtn:       'bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/30',
  songText:      'text-cyan-300',
  slider:        'accent-cyan-500',
  pill:          'text-cyan-300 bg-cyan-500/10',
  waveColor:     WAVEFORM_RMS_COLOR,
  progressColor: WAVEFORM_PEAK_COLOR,
};

export const PLAYER_ACCENT_FUCHSIA: PlayerAccent = {
  playBtn:       'bg-violet-500/20 hover:bg-violet-500/30 border border-violet-400/30',
  songText:      'text-violet-300',
  slider:        'accent-violet-500',
  pill:          'text-violet-300 bg-violet-500/10',
  waveColor:     WAVEFORM_RMS_COLOR,
  progressColor: WAVEFORM_PEAK_COLOR,
};

/** The Playground's — amber, like its workspace tab. */
export const PLAYER_ACCENT_AMBER: PlayerAccent = {
  playBtn:       'bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/30',
  songText:      'text-amber-300',
  slider:        'accent-amber-500',
  pill:          'text-amber-300 bg-amber-500/10',
  waveColor:     WAVEFORM_RMS_COLOR,
  progressColor: WAVEFORM_PEAK_COLOR,
};
