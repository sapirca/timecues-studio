/* What each signal lane shows and how it is computed — the card a click on the
   lane's name opens. Keyed by row id (mobileRows.SIGNAL_ROWS). Kept short: one
   line of what to read off it, one line of how, in the numbers the code uses
   (services/mirAnalysis, utils/rhythmSignals, the row components). When one of
   those changes, change the line here with it. */

export interface SignalInfo {
  /** What to read off the lane. */
  shows: string;
  /** How it is computed. */
  computed: string;
}

/** The analysis framing every curve lane shares (services/mirAnalysis). */
const FRAMES = '2048-sample FFT windows every 512 samples (~12 ms)';

export const SIGNAL_INFO: Record<string, SignalInfo> = {
  waveform: {
    shows: 'The waveform split into lows, mids and highs, each in its own colour — a kick reads as a low peak, hats as a high one.',
    computed: 'The audio run through three filters (below 150 Hz, 150 Hz–2.5 kHz, above 2.5 kHz); each band is drawn as its own peak envelope.',
  },
  eq: {
    shows: 'How much energy sits in the bass, mids and treble over time.',
    computed: `Mean power per FFT bin in three bands (below 250 Hz, 250 Hz–4 kHz, above 4 kHz), over ${FRAMES}; each band scaled to its own peak.`,
  },
  spectrogram: {
    shows: 'Every frequency over time: bright is loud. Notes are horizontal lines, drums vertical smears.',
    computed: 'A 2048-sample Hann-windowed FFT per pixel column, in dB, with the frequency axis on the mel scale so low notes get room.',
  },
  cepstrogram: {
    shows: 'The timbre — the "colour" of the sound, independent of pitch. A new instrument or texture changes its pattern.',
    computed: `13 MFCCs per frame: 40 mel bands of the power spectrum, log, then a DCT. ${FRAMES}.`,
  },
  chroma: {
    shows: 'Which of the 12 pitch classes (C, C#, … B) are sounding — the harmony and key, regardless of octave.',
    computed: 'Each FFT bin above 55 Hz snapped to its nearest semitone and its power summed into 12 bins; each frame scaled to its loudest bin.',
  },
  tempogram: {
    shows: 'Which tempos are present at each moment (30–300 BPM). A steady beat is a bright horizontal line.',
    computed: 'The onset curve correlated with itself over a ~3 s sliding window, at the lag of each of 40 log-spaced BPM values.',
  },
  ssm: {
    shows: 'Which parts of the song resemble which: a bright off-diagonal stripe is a passage that repeats (a chorus coming back).',
    computed: 'Chroma averaged into ~0.75 s steps, then the cosine similarity of every step against every other.',
  },
  volume: {
    shows: 'Plain loudness — how much sound there is, and how long it lasts.',
    computed: `RMS of the samples in each frame, ${FRAMES}, scaled to the song's loudest frame.`,
  },
  energy: {
    shows: 'How hard the kick and bass land, beat by beat. A drop is the beat hitting; a breakdown is the beat gone, however loud the rest is.',
    computed: 'Per beat of the grid: the strongest bass onset (below 120 Hz) inside it, times how steady those hits are over the 8 beats around it. Without a grid, per 0.5 s.',
  },
  brightness: {
    shows: 'How bright or dark the sound is. Rises as hats, cymbals and open filters come in; falls on a filter sweep down or a bass-only passage.',
    computed: `Spectral centroid — the magnitude-weighted average frequency of each frame, ${FRAMES}; scaled to the song's brightest frame.`,
  },
  novelty: {
    shows: 'How much the sound changes from one moment to the next. Peaks are candidate section changes.',
    computed: 'Cosine distance between neighbouring frames’ feature vectors (loudness, bandwidth, centroid, onsets, 3 bands), Gaussian-smoothed over ~58 ms.',
  },
  onsets: {
    shows: 'Attacks — where a new sound starts (a hit, a plucked note, a syllable).',
    computed: `Onset strength: the sum of every FFT bin's increase in magnitude since the previous frame (decreases ignored). ${FRAMES}.`,
  },
  density: {
    shows: 'How many things are struck per beat, whatever they are. A snare roll going from 8ths to 16ths doubles it at the same volume.',
    computed: 'Peaks picked from the Onsets curve, counted over the 4 beats around each frame (over 2 s without a grid); scaled to the song’s 98th percentile.',
  },
  busyness: {
    shows: 'How much is going on: many parts of the spectrum each starting many notes at full level reads high; long held sounds, or one quiet part ticking alone, read low. A drop sits high, a build thinning to a riser falls.',
    computed: 'Level in 8 bands (40 Hz–16 kHz) in dB; a note is a rise of 6 dB within ~23 ms, counted by its band’s level against the band’s own loud passages (full level 1, 20 dB down 0.1). Notes from all bands summed over the 4 beats around each frame (over 2 s without a grid); scaled to the song’s 98th percentile.',
  },
  bandwidth: {
    shows: 'How widely the sound spreads across frequencies: a lone bass line or a thin lead is narrow, a full mix wide.',
    computed: `Spectral bandwidth — the magnitude-weighted spread of frequencies around the centroid, ${FRAMES}; scaled to the song's widest frame.`,
  },
  flux: {
    shows: 'All spectral change — attacks and also releases, filter closings, notes ending.',
    computed: `Spectral flux: the L2 distance between consecutive frames' magnitude spectra, ${FRAMES}; scaled to its peak.`,
  },
};
