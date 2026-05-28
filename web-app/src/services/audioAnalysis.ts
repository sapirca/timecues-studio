export interface BPMResult {
  bpm: number;
  offset: number;
  beatTimes: number[];
}

export interface EnergyPeakResult {
  peakTimes: number[];
}

export interface SilenceRegion {
  start: number;
  end: number;
}

export interface SectionResult {
  time: number;
  label: string;
}

// Analyze BPM using autocorrelation
export async function analyzeBPM(audioBuffer: AudioBuffer): Promise<BPMResult> {
  const channelData = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;

  // Downsample for faster analysis
  const downsampleFactor = 4;
  const samples = Math.floor(channelData.length / downsampleFactor);
  const downsampled = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    downsampled[i] = channelData[i * downsampleFactor];
  }

  const effectiveSampleRate = sampleRate / downsampleFactor;

  // Compute energy envelope
  const windowSize = Math.floor(effectiveSampleRate * 0.01); // 10ms windows
  const envelope = computeEnvelope(downsampled, windowSize);

  // Find peaks in envelope for beat detection
  const peaks = findPeaks(envelope, windowSize);

  // Analyze peak intervals to find BPM
  if (peaks.length < 2) {
    return { bpm: 120, offset: 0, beatTimes: [] };
  }

  // Calculate intervals between consecutive peaks
  const intervals: number[] = [];
  for (let i = 1; i < peaks.length; i++) {
    const interval = (peaks[i] - peaks[i - 1]) * windowSize / effectiveSampleRate;
    // Only consider intervals that correspond to 60-200 BPM
    if (interval > 0.3 && interval < 1.0) {
      intervals.push(interval);
    }
  }

  if (intervals.length === 0) {
    return { bpm: 120, offset: 0, beatTimes: [] };
  }

  // Find most common interval using histogram
  const histogram = new Map<number, number>();
  for (const interval of intervals) {
    // Round to nearest 10ms
    const rounded = Math.round(interval * 100) / 100;
    histogram.set(rounded, (histogram.get(rounded) || 0) + 1);
  }

  let mostCommonInterval = 0.5;
  let maxCount = 0;
  for (const [interval, count] of histogram) {
    if (count > maxCount) {
      maxCount = count;
      mostCommonInterval = interval;
    }
  }

  const bpm = Math.round(60 / mostCommonInterval);

  // Find the first strong beat for offset
  const offset = peaks.length > 0 ? (peaks[0] * windowSize / effectiveSampleRate) : 0;

  // Generate beat times
  const duration = audioBuffer.duration;
  const beatInterval = 60 / bpm;
  const beatTimes: number[] = [];

  let beatTime = offset;
  while (beatTime < duration) {
    beatTimes.push(beatTime);
    beatTime += beatInterval;
  }

  return { bpm, offset, beatTimes };
}

// Analyze energy peaks (transients, loud sections)
export async function analyzeEnergy(
  audioBuffer: AudioBuffer,
  threshold: number = 0.7,
  minGap: number = 0.5
): Promise<EnergyPeakResult> {
  const channelData = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;

  // Calculate RMS energy in windows
  const windowSize = Math.floor(sampleRate * 0.05); // 50ms windows
  const hopSize = Math.floor(windowSize / 2);
  const energyValues: number[] = [];

  for (let i = 0; i < channelData.length - windowSize; i += hopSize) {
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      sum += channelData[i + j] * channelData[i + j];
    }
    energyValues.push(Math.sqrt(sum / windowSize));
  }

  // Find max energy for normalization
  const maxEnergy = Math.max(...energyValues);
  if (maxEnergy === 0) {
    return { peakTimes: [] };
  }

  // Normalize
  const normalized = energyValues.map(e => e / maxEnergy);

  // Find peaks above threshold with minimum gap
  const peakTimes: number[] = [];
  let lastPeakTime = -minGap;

  for (let i = 1; i < normalized.length - 1; i++) {
    const time = (i * hopSize) / sampleRate;

    // Check if this is a local maximum above threshold
    if (
      normalized[i] > threshold &&
      normalized[i] > normalized[i - 1] &&
      normalized[i] > normalized[i + 1] &&
      time - lastPeakTime >= minGap
    ) {
      peakTimes.push(time);
      lastPeakTime = time;
    }
  }

  return { peakTimes };
}

// Detect silent regions
export async function detectSilences(
  audioBuffer: AudioBuffer,
  threshold: number = 0.01,
  minDuration: number = 0.5
): Promise<SilenceRegion[]> {
  const channelData = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;

  // Calculate RMS in windows
  const windowSize = Math.floor(sampleRate * 0.05); // 50ms windows
  const hopSize = Math.floor(windowSize / 2);

  const silences: SilenceRegion[] = [];
  let silenceStart: number | null = null;

  for (let i = 0; i < channelData.length - windowSize; i += hopSize) {
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      sum += channelData[i + j] * channelData[i + j];
    }
    const rms = Math.sqrt(sum / windowSize);
    const time = i / sampleRate;

    if (rms < threshold) {
      if (silenceStart === null) {
        silenceStart = time;
      }
    } else {
      if (silenceStart !== null) {
        const duration = time - silenceStart;
        if (duration >= minDuration) {
          silences.push({ start: silenceStart, end: time });
        }
        silenceStart = null;
      }
    }
  }

  // Handle silence at the end
  if (silenceStart !== null) {
    const duration = audioBuffer.duration - silenceStart;
    if (duration >= minDuration) {
      silences.push({ start: silenceStart, end: audioBuffer.duration });
    }
  }

  return silences;
}

// Detect musical sections using spectral analysis
export async function detectSections(audioBuffer: AudioBuffer): Promise<SectionResult[]> {
  const channelData = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;

  // Analyze spectral features in larger windows
  const windowSize = Math.floor(sampleRate * 2); // 2 second windows
  const hopSize = Math.floor(sampleRate * 0.5); // 500ms hop

  const features: { time: number; centroid: number; energy: number }[] = [];

  for (let i = 0; i < channelData.length - windowSize; i += hopSize) {
    const time = i / sampleRate;

    // Calculate spectral centroid approximation using zero-crossing rate
    let zeroCrossings = 0;
    let energy = 0;
    for (let j = 1; j < windowSize; j++) {
      if ((channelData[i + j] >= 0) !== (channelData[i + j - 1] >= 0)) {
        zeroCrossings++;
      }
      energy += channelData[i + j] * channelData[i + j];
    }

    features.push({
      time,
      centroid: zeroCrossings / windowSize,
      energy: Math.sqrt(energy / windowSize),
    });
  }

  if (features.length < 2) {
    return [{ time: 0, label: 'Intro' }];
  }

  // Detect significant changes in features
  const sections: SectionResult[] = [{ time: 0, label: 'Intro' }];
  const sectionLabels = ['Section A', 'Section B', 'Section C', 'Section D', 'Section E'];
  let labelIndex = 0;

  for (let i = 1; i < features.length; i++) {
    const centroidChange = Math.abs(features[i].centroid - features[i - 1].centroid);
    const energyChange = Math.abs(features[i].energy - features[i - 1].energy);

    // Significant change detection
    const maxCentroid = Math.max(...features.map(f => f.centroid));
    const maxEnergy = Math.max(...features.map(f => f.energy));

    const normalizedCentroidChange = centroidChange / (maxCentroid || 1);
    const normalizedEnergyChange = energyChange / (maxEnergy || 1);

    if (normalizedCentroidChange > 0.3 || normalizedEnergyChange > 0.4) {
      sections.push({
        time: features[i].time,
        label: sectionLabels[labelIndex % sectionLabels.length],
      });
      labelIndex++;
    }
  }

  return sections;
}

// Helper: Compute energy envelope
function computeEnvelope(samples: Float32Array, windowSize: number): Float32Array {
  const numWindows = Math.floor(samples.length / windowSize);
  const envelope = new Float32Array(numWindows);

  for (let i = 0; i < numWindows; i++) {
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      const sample = samples[i * windowSize + j];
      sum += sample * sample;
    }
    envelope[i] = Math.sqrt(sum / windowSize);
  }

  return envelope;
}

// Helper: Find peaks in signal
function findPeaks(signal: Float32Array, minDistance: number): number[] {
  const peaks: number[] = [];
  const threshold = 0.1 * Math.max(...signal);

  for (let i = 1; i < signal.length - 1; i++) {
    if (
      signal[i] > threshold &&
      signal[i] > signal[i - 1] &&
      signal[i] > signal[i + 1]
    ) {
      // Check minimum distance from last peak
      if (peaks.length === 0 || i - peaks[peaks.length - 1] >= minDistance) {
        peaks.push(i);
      }
    }
  }

  return peaks;
}

// Get AudioBuffer from URL
export async function getAudioBuffer(url: string): Promise<AudioBuffer> {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const audioContext = new AudioContext();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  await audioContext.close();
  return audioBuffer;
}
