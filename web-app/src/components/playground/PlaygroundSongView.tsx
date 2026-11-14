import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { SharedVizPanel, DEFAULT_FIXED_ROW_ORDER, type BeatGridUnit, type VizRowId, type AlgoOverlay } from '../inspector-v2/SharedVizPanel';
import { VizControlBar } from '../inspector-v2/VizControlBar';
import type { ZoomToRange } from '../PlayerPanel';
import { PLAYER_ACCENT_AMBER } from '../playerAccents';
import {
  detectorBoundaryLayer,
  detectorCueLayer,
  detectorLoopLayer,
  detectorLyricsLayer,
  detectorRiffLayer,
  detectorSpanLayer,
  expandDetectorLanes,
} from '../inspector-v2/detectorLayers';
import type { AnnotationLayer } from '../../types/annotationLayer';
import { createPlayheadClock, PlayheadClockContext, type PlayheadSample } from '../../hooks/usePlayhead';
import { useMirCurves } from '../../hooks/useMirCurves';
import { loadSongInfo } from '../../services/songInfo';
import { resolveGridSegments } from '../../utils/gridSegments';
import { beatsPerBarFromTimeSignature } from '../../utils/beatGrid';
import { getCurrentSettings } from '../../context/SettingsContext';
import type { SongInfo } from '../../types/songInfo';
import type { CustomRegistryEntry, CustomResultEnvelope } from '../../types/customScript';

export interface PlaygroundSong {
  id: string;
  name: string;
  url: string;
}

/** The signal rows the Signals dropdown switches, by the row id the canvas
 *  knows them as. */
type SignalRow = 'waveform' | 'eq' | 'spectrogram' | 'cepstrogram' | 'chroma' | 'tempogram' | 'ssm'
  | 'volume' | 'energy' | 'brightness' | 'novelty' | 'onsets' | 'flux';
const SIGNAL_ROWS: readonly SignalRow[] = [
  'waveform', 'eq', 'spectrogram', 'cepstrogram', 'chroma', 'tempogram', 'ssm',
  'volume', 'energy', 'brightness', 'novelty', 'onsets', 'flux',
];
/** One signal under the waveform to start with — the page is the editor's,
 *  and the song below it is there to check the detector against. */
const DEFAULT_SIGNALS: ReadonlySet<SignalRow> = new Set<SignalRow>(['energy']);
const SIGNALS_KEY = 'playground.signals';

function readSignals(): Set<SignalRow> {
  try {
    const raw = window.localStorage.getItem(SIGNALS_KEY);
    if (raw) {
      const ids = (JSON.parse(raw) as string[]).filter((s): s is SignalRow => (SIGNAL_ROWS as readonly string[]).includes(s));
      return new Set(ids);
    }
  } catch {
    // Storage unavailable or garbled — start from the default.
  }
  return new Set(DEFAULT_SIGNALS);
}

/** The Playground's song: the player, the signals picked in the bar above it,
 *  and the lane of the detector being edited — the same controls, player and
 *  lanes as Algorithm Inspect, mounted for one song and one detector. */
export function PlaygroundSongView({
  song,
  detector,
  envelope,
  color,
  emptyNote,
}: {
  song: PlaygroundSong;
  detector: CustomRegistryEntry | null;
  /** The detector's run on this song, when there is one. */
  envelope: CustomResultEnvelope | null;
  color: string;
  /** Said under the lanes when the detector has no lane to draw. */
  emptyNote: string | null;
}) {
  const [playheadClock] = useState(createPlayheadClock);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [songInfo, setSongInfo] = useState<SongInfo | null>(null);

  // A new song starts from nothing: its own buffer, its own grid.
  const [shownSong, setShownSong] = useState(song.id);
  if (shownSong !== song.id) {
    setShownSong(song.id);
    setAudioBuffer(null);
    setDuration(0);
    setSongInfo(null);
  }
  useEffect(() => {
    playheadClock.set(0);
    let cancelled = false;
    loadSongInfo(song.id).then((info) => { if (!cancelled) setSongInfo(info); });
    return () => { cancelled = true; };
  }, [song.id, playheadClock]);

  const { curves: mirCurves, computing: mirComputing } = useMirCurves(audioBuffer, song.url);

  // ── Signals ──
  const [signals, setSignals] = useState<Set<SignalRow>>(readSignals);
  useEffect(() => {
    try { window.localStorage.setItem(SIGNALS_KEY, JSON.stringify([...signals])); } catch { /* a courtesy */ }
  }, [signals]);
  const shown = (row: SignalRow) => signals.has(row);
  const setShown = useCallback((row: SignalRow, on: boolean) => {
    setSignals((cur) => {
      if (cur.has(row) === on) return cur;
      const next = new Set(cur);
      if (on) next.add(row); else next.delete(row);
      return next;
    });
  }, []);
  const toggle = (row: SignalRow) => (on: boolean) => setShown(row, on);

  // ── Grid, speed ──
  const [showBeatGrid, setShowBeatGrid] = useState(() => getCurrentSettings().defaultShowBeatGrid);
  const [beatGridUnit, setBeatGridUnit] = useState<BeatGridUnit>('beat');
  const [gridLineThickness, setGridLineThickness] = useState(1);
  const [captureGlobalHScroll, setCaptureGlobalHScroll] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(() => getCurrentSettings().defaultPlaybackRate ?? 1);
  const bpm = (songInfo?.bpm ?? 0) > 20 ? songInfo!.bpm : undefined;
  const beatsPerBar = beatsPerBarFromTimeSignature(songInfo?.timeSignature);
  const gridSegments = useMemo(() => resolveGridSegments(songInfo), [songInfo]);

  // ── Player ↔ lanes: one scroll, one zoom ──
  // The player owns zoom and scroll; the lanes follow it, and a scroll of the
  // lanes is handed back to the player. Same hand-off as Algorithm Inspect.
  const seekRef = useRef<((t: number) => void) | null>(null);
  const playRef = useRef<(() => void) | null>(null);
  const pauseRef = useRef<(() => void) | null>(null);
  const wsScrollRef = useRef<((scrollLeft: number) => void) | null>(null);
  const zoomInRef = useRef<(() => void) | null>(null);
  const zoomOutRef = useRef<(() => void) | null>(null);
  const zoomResetRef = useRef<(() => void) | null>(null);
  const zoomToRangeRef = useRef<ZoomToRange | null>(null);
  const vizScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const isProgrammaticScrollRef = useRef(false);
  const desiredVizScrollRef = useRef<number | null>(null);
  const [vizSignalWidth, setVizSignalWidth] = useState(0);
  const [zoomFactor, setZoomFactor] = useState(1);
  const [atMaxZoom, setAtMaxZoom] = useState(false);

  const handleScrollChange = useCallback((scrollLeft: number) => {
    const el = vizScrollContainerRef.current;
    if (!el) return;
    isProgrammaticScrollRef.current = true;
    el.scrollLeft = scrollLeft;
    // The lanes widen to a new zoom a render after the player does, so a
    // target past their current width is clamped — kept, and re-applied below.
    desiredVizScrollRef.current = Math.abs(el.scrollLeft - scrollLeft) > 1 ? scrollLeft : null;
    isProgrammaticScrollRef.current = false;
  }, []);
  const handleVizScroll = useCallback(() => {
    if (isProgrammaticScrollRef.current) return;
    const el = vizScrollContainerRef.current;
    if (!el) return;
    const want = desiredVizScrollRef.current;
    if (want != null && want > el.scrollLeft
        && el.scrollLeft >= el.scrollWidth - el.clientWidth - 1) return;
    desiredVizScrollRef.current = null;
    wsScrollRef.current?.(el.scrollLeft);
  }, []);
  useLayoutEffect(() => {
    const el = vizScrollContainerRef.current;
    const want = desiredVizScrollRef.current;
    if (!el || want == null) return;
    isProgrammaticScrollRef.current = true;
    el.scrollLeft = want;
    isProgrammaticScrollRef.current = false;
    if (Math.abs(el.scrollLeft - want) <= 1) desiredVizScrollRef.current = null;
  }, [vizSignalWidth]);
  const handleViewChange = useCallback((zoom: number, containerWidth: number, atMax: boolean) => {
    setVizSignalWidth(zoom > 1 ? containerWidth * zoom : 0);
    setZoomFactor(zoom);
    setAtMaxZoom(atMax);
  }, []);
  const handleBufferReady = useCallback((buf: AudioBuffer) => {
    setAudioBuffer(buf);
    setDuration(buf.duration);
  }, []);
  const handleTime = useCallback((t: number, sample?: PlayheadSample) => playheadClock.set(t, sample), [playheadClock]);
  const seek = useCallback((t: number) => seekRef.current?.(t), []);

  // ── The detector's lanes ──
  // Drawn by the same builders as Algorithm Inspect's detector lanes. A
  // `lanes` detector (Drum kit split, Instrument layers) returns several lanes
  // of different kinds in one run; it is expanded into one single-kind entry
  // per lane first, exactly as Inspect does, so each gets its own row.
  const lanes = useMemo(() => {
    const out: {
      rowIds: VizRowId[];
      cueLayers: AnnotationLayer<'cues'>[];
      spanLayers: AnnotationLayer<'spans'>[];
      loopLayers: AnnotationLayer<'loops'>[];
      lyricsLayers: AnnotationLayer<'lyrics'>[];
      riffPatternLayers: AnnotationLayer<'riff-patterns'>[];
      algoOverlays: AlgoOverlay[];
    } = { rowIds: [], cueLayers: [], spanLayers: [], loopLayers: [], lyricsLayers: [], riffPatternLayers: [], algoOverlays: [] };
    if (!detector) return out;
    const expanded = expandDetectorLanes([detector], envelope ? { [detector.name]: envelope } : {});
    for (const d of expanded.detectors) {
      const env = expanded.results[d.name] ?? null;
      const cue = detectorCueLayer(d, env, color);
      if (cue) { out.cueLayers.push(cue); out.rowIds.push(`cue-layer:${cue.id}`); continue; }
      const span = detectorSpanLayer(d, env, color);
      if (span) { out.spanLayers.push(span); out.rowIds.push(`span-layer:${span.id}`); continue; }
      const loop = detectorLoopLayer(d, env, color);
      if (loop) { out.loopLayers.push(loop); out.rowIds.push(`loop-layer:${loop.id}`); continue; }
      const lyrics = detectorLyricsLayer(d, env, color);
      if (lyrics) { out.lyricsLayers.push(lyrics); out.rowIds.push(`lyrics-layer:${lyrics.id}`); continue; }
      const riff = detectorRiffLayer(d, env, color);
      if (riff) { out.riffPatternLayers.push(riff); out.rowIds.push(`riff-layer:${riff.id}`); continue; }
      const boundary = detectorBoundaryLayer(d, env, color, duration);
      if (boundary) {
        out.algoOverlays.push({ id: boundary.id, label: boundary.name, labelColor: boundary.color, sections: boundary.sections });
        out.rowIds.push(boundary.id);
      }
    }
    return out;
  }, [detector, envelope, color, duration]);
  const hasLane = lanes.rowIds.length > 0;
  const rowOrder = useMemo<VizRowId[]>(
    () => (hasLane ? [...DEFAULT_FIXED_ROW_ORDER, ...lanes.rowIds] : DEFAULT_FIXED_ROW_ORDER),
    [hasLane, lanes],
  );
  const noop = useCallback(() => {}, []);

  // The view controls ride at the end of the player's transport row rather
  // than on a row of their own above it — one line instead of two.
  const viewControls = (
    <VizControlBar
      compact
      showAnnotations={false}
      showAlgos={false}
      showSnap={false}
      showManual={false} onToggleManual={noop}
      showAutoGuess={false} onToggleAutoGuess={noop}
      showWaveform={shown('waveform')} onToggleWaveform={toggle('waveform')}
      showEQ={shown('eq')} onToggleEQ={toggle('eq')}
      showSpectrogram={shown('spectrogram')} onToggleSpectrogram={toggle('spectrogram')}
      showCepstrogram={shown('cepstrogram')} onToggleCepstrogram={toggle('cepstrogram')}
      showChroma={shown('chroma')} onToggleChroma={toggle('chroma')}
      showTempogram={shown('tempogram')} onToggleTempogram={toggle('tempogram')}
      showSsm={shown('ssm')} onToggleSsm={toggle('ssm')}
      showVolume={shown('volume')} onToggleVolume={toggle('volume')}
      showEnergy={shown('energy')} onToggleEnergy={toggle('energy')}
      showBrightness={shown('brightness')} onToggleBrightness={toggle('brightness')}
      showNovelty={shown('novelty')} onToggleNovelty={toggle('novelty')}
      showOnsets={shown('onsets')} onToggleOnsets={toggle('onsets')}
      showFlux={shown('flux')} onToggleFlux={toggle('flux')}
      showBeatGrid={showBeatGrid} onToggleBeatGrid={setShowBeatGrid}
      beatGridUnit={beatGridUnit} onBeatGridUnitChange={setBeatGridUnit}
      bpm={bpm}
      beatsPerBar={beatsPerBar}
      timeSignature={songInfo?.timeSignature}
      snapToGrid={false} onToggleSnapToGrid={noop}
      captureGlobalHScroll={captureGlobalHScroll} onToggleCaptureGlobalHScroll={setCaptureGlobalHScroll}
      gridLineThickness={gridLineThickness} onGridLineThicknessChange={setGridLineThickness}
      zoomFactor={zoomFactor}
      atMaxZoom={atMaxZoom}
      onZoomIn={() => zoomInRef.current?.()}
      onZoomOut={() => zoomOutRef.current?.()}
      onZoomReset={() => zoomResetRef.current?.()}
      playbackRate={playbackRate}
      onPlaybackRateChange={setPlaybackRate}
    />
  );

  return (
    <PlayheadClockContext.Provider value={playheadClock}>
      <div className="flex flex-col min-h-0">
        <SharedVizPanel
          playerUrl={song.url}
          trackName={song.name}
          audioBuffer={audioBuffer}
          duration={duration}
          bpm={bpm}
          timeSignature={songInfo?.timeSignature}
          beatOffset={songInfo?.gridOffset ?? 0}
          beatsPerBar={beatsPerBar}
          gridSegments={gridSegments}
          showBeatGrid={showBeatGrid}
          beatGridUnit={beatGridUnit}
          showBarNumbers={showBeatGrid}
          gridLineThickness={gridLineThickness}
          captureGlobalHScroll={captureGlobalHScroll}
          showManual={false}
          showAutoGuess={false}
          showProminence={false}
          showWaveform={shown('waveform')}
          showEQ={shown('eq')}
          showSpectrogram={shown('spectrogram')}
          showCepstrogram={shown('cepstrogram')}
          showChroma={shown('chroma')}
          showTempogram={shown('tempogram')}
          showSsm={shown('ssm')}
          showVolume={shown('volume')}
          showEnergy={shown('energy')}
          showBrightness={shown('brightness')}
          showNovelty={shown('novelty')}
          showOnsets={shown('onsets')}
          showFlux={shown('flux')}
          mirCurves={mirCurves}
          mirComputing={mirComputing}
          algoOverlays={lanes.algoOverlays}
          cueLayers={lanes.cueLayers}
          spanLayers={lanes.spanLayers}
          loopLayers={lanes.loopLayers}
          lyricsLayers={lanes.lyricsLayers}
          riffPatternLayers={lanes.riffPatternLayers}
          rowOrder={rowOrder}
          onSetSignalShown={(rowId, on) => {
            if ((SIGNAL_ROWS as readonly string[]).includes(rowId)) setShown(rowId as SignalRow, on);
          }}
          onVizClick={seek}
          onVizRegion={seek}
          onLyricsSeek={seek}
          seekRef={seekRef}
          playRef={playRef}
          pauseRef={pauseRef}
          wsScrollRef={wsScrollRef}
          zoomInRef={zoomInRef}
          zoomOutRef={zoomOutRef}
          zoomResetRef={zoomResetRef}
          zoomToRangeRef={zoomToRangeRef}
          onBufferReady={handleBufferReady}
          onTimeUpdate={handleTime}
          onPlayingChange={setPlaying}
          playbackRate={playbackRate}
          onScrollChange={handleScrollChange}
          onViewChange={handleViewChange}
          vizScrollContainerRef={vizScrollContainerRef}
          vizSignalWidth={vizSignalWidth}
          vizZoomFactor={zoomFactor}
          onVizScroll={handleVizScroll}
          playerIsPlaying={playing}
          playerAccent={PLAYER_ACCENT_AMBER}
          playerTransportAbove
          playerTransportTrailing={viewControls}
          hidePlaybackIcon
          hideTimeDisplay
        />
        {!hasLane && emptyNote && (
          <p className="px-3 py-2 text-[11px] text-slate-500">{emptyNote}</p>
        )}
      </div>
    </PlayheadClockContext.Provider>
  );
}
