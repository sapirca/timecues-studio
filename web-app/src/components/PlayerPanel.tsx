import { useEffect, useRef, useState, useMemo, useCallback, type RefObject } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { OverviewWaveform } from './OverviewWaveform';
import type { ScaleMode } from '../utils/waveformAnalysis';
import { visibleGridLines } from '../utils/beatGrid';
import { AnchorFlagOverlay } from './inspector-v2/AnchorFlagOverlay';
import { ManualGridEditor } from './inspector-v2/ManualGridEditor';
import { PendingHighlightOverlay, type PendingSelection } from './inspector-v2/AnnotationOverlays';
import type { PreviewRegion } from './inspector-v2/PreviewWindow';
import { PreviewControlsBar } from './inspector-v2/PreviewControlsBar';
import type { TempoAnchor } from '../types/songInfo';
import { useExtendedZoom } from '../hooks/useExtendedZoom';
import { PAUSE_PLAYBACK_EVENT } from '../utils/playerEvents';
import { ExtendedZoomDialog } from './ExtendedZoomDialog';
import { UltraZoomDialog } from './UltraZoomDialog';

const SCALE_STORAGE_KEY = 'tc.overviewWaveformScale';

// Zoom cap configuration — see the cap-computation block inside PlayerPanel.
const MAX_BUFFER_PX = 32_000;
const STANDARD_CEILING = 32;
const ULTRA_CEILING = 128;

function readStoredScale(): ScaleMode {
  if (typeof window === 'undefined') return 'db';
  try {
    const v = window.localStorage.getItem(SCALE_STORAGE_KEY);
    return v === 'lin' || v === 'db' ? v : 'db';
  } catch {
    return 'db';
  }
}

export interface PlayerAccent {
  /** Tailwind classes for the play button (e.g. 'bg-rose-600 hover:bg-rose-500') */
  playBtn: string;
  /** Tailwind class for the song name accent text (e.g. 'text-rose-300') */
  songText: string;
  /** Tailwind class for the volume slider (e.g. 'accent-rose-500') */
  slider: string;
  /** Tailwind classes for the BPM pill (e.g. 'text-rose-400 bg-rose-900/30') */
  pill: string;
  /** WaveSurfer waveColor hex (e.g. '#e11d48') */
  waveColor: string;
  /** WaveSurfer progressColor hex (e.g. '#fb7185') */
  progressColor: string;
}

const DEFAULT_PLAYER_ACCENT: PlayerAccent = {
  playBtn:       'bg-indigo-600 hover:bg-indigo-500',
  songText:      'text-indigo-300',
  slider:        'accent-indigo-500',
  pill:          'text-indigo-400 bg-indigo-900/30',
  waveColor:     '#4f46e5',
  progressColor: '#818cf8',
};

interface PlayerPanelProps {
  url: string;
  trackName?: string;
  bpm?: number;
  /** Display-only time signature string (e.g. '4/4', '3/4'). Rendered next
   *  to the BPM pill in the toolbar. Beat-grid math still uses `beatsPerBar`. */
  timeSignature?: string;
  beatTimes?: number[];
  beatOffset?: number;
  beatsPerBar?: number;
  barGroupSize?: number;
  /** Subdivide each beat (2 = 1/2, 3 = triplet, 4 = 1/4, 6 = 16th triplet, 8 = 1/8). Ignored when barGroupSize is set. */
  subBeatDivision?: number;
  /** Compound-pulse step: only emit lines every N beats. Ignored when barGroupSize or subBeatDivision (>1) is set. */
  beatGroupSize?: number;
  /** Multiplier on beat-grid line width (1 = default). */
  gridThickness?: number;
  onBufferReady?: (buf: AudioBuffer) => void;
  onReady?: () => void;
  onTimeUpdate?: (time: number) => void;
  /** Called whenever zoom or container width changes; parent computes scrollLeft from playerTime.
   *  `atMaxZoom` is true when the +zoom button would no-op (used by the toolbar to disable it). */
  onViewChange?: (zoomFactor: number, containerWidth: number, atMaxZoom: boolean) => void;
  /** Ref populated with a seekTo(seconds) function once the player is ready */
  seekRef?: RefObject<((time: number) => void) | null>;
  /** Ref populated with a play() function once the player is ready */
  playRef?: RefObject<(() => void) | null>;
  /** Ref populated with a pause() function once the player is ready */
  pauseRef?: RefObject<(() => void) | null>;
  /** Called whenever WaveSurfer's scroll position changes */
  onScrollChange?: (scrollLeft: number) => void;
  /** Ref populated with a function to programmatically set the WaveSurfer scroll position (pixels) */
  wsScrollRef?: RefObject<((scrollLeft: number) => void) | null>;
  /** Refs populated with imperative zoom controls once the player is ready */
  zoomInRef?: RefObject<(() => void) | null>;
  zoomOutRef?: RefObject<(() => void) | null>;
  zoomResetRef?: RefObject<(() => void) | null>;
  /** Prompt-free single-step zoom for pinch / Ctrl+wheel. Hard-caps at the
   *  currently-authorized tier so trackpad pinch never auto-progresses the
   *  user into Extended or Ultra zoom — those tiers require an explicit
   *  click on the + button to opt in via the dialog. */
  pinchZoomInRef?: RefObject<(() => void) | null>;
  pinchZoomOutRef?: RefObject<(() => void) | null>;
  /** Scroll the viewport so `time` is centered (or near-left when align='left'). */
  scrollToTimeRef?: RefObject<((time: number, align?: 'center' | 'left') => void) | null>;
  /** Zoom + scroll so [t1, t2] fits the viewport with a small padding margin. */
  zoomToRangeRef?: RefObject<((t1: number, t2: number) => void) | null>;
  /** Called when play/pause state changes */
  onPlayingChange?: (playing: boolean) => void;
  /** Theme accent colors. Defaults to indigo. */
  accent?: PlayerAccent;
  /** Called while the user holds Alt and drags horizontally on the waveform to slide the grid. */
  onGridOffsetChange?: (newOffset: number) => void;
  /** Called once when the Alt-drag begins (e.g. for parent to snapshot the previous offset). */
  onGridOffsetDragStart?: (currentOffset: number) => void;
  /** When true, render bar numbers (1, 2, 3…) above the bar lines. */
  showBarNumbers?: boolean;
  /** Tempo anchors. When provided and non-empty, the beat grid becomes
   *  piecewise-constant — each segment uses its anchor's BPM for spacing.
   *  Also drives the flag overlay above the waveform when `anchorFlagMode`
   *  is non-null. */
  anchors?: readonly TempoAnchor[];
  /** Per-beat overrides (Manual mode). Sparse map keyed by global integer
   *  beat index → absolute timestamp in seconds. Pinned beats render at
   *  their override positions and are tagged so the editor can recolor
   *  them. */
  beatOverrides?: Readonly<Record<string, number>>;
  /** Active grid mode for the anchor flags. 'dynamic' → cyan, 'manual' →
   *  emerald. `null` or 'static' hides the flag layer. */
  anchorFlagMode?: 'dynamic' | 'manual' | null;
  /** Right-click handler for an anchor flag. Only wired in manual mode. */
  onDeleteAnchor?: (index: number) => void;
  /** Drag-an-anchor-flag handlers. Only wired in manual mode. */
  onAnchorDrag?: (index: number, newTime: number) => void;
  onAnchorDragStart?: (index: number) => void;
  /** When 'manual' (and the rest of the manual-edit handlers are wired),
   *  render the per-beat ManualGridEditor as a transparent overlay on top
   *  of the waveform — grabbable hit zones at each beat, seek-clicks still
   *  fall through between them. */
  gridMode?: 'static' | 'dynamic' | 'manual';
  /** Manual-mode per-beat drag commit. Receives the beat's macro time, the
   *  dropped time, and the global integer beat index (override key). */
  onBeatDrag?: (tOrig: number, tNew: number, beatIndex: number) => void;
  /** Right-click on a pinned beat → clear the override at `beatIndex`. */
  onClearBeatOverride?: (beatIndex: number) => void;
  /** When true, manual editing is read-only (non-admin viewer). */
  manualEditLocked?: boolean;
  /** When set, paints the cyan Mark In/Out highlight band over the waveform —
   *  same overlay used on the layer rows below, so the selected range reads
   *  as one continuous stripe across the whole inspector. */
  pendingSelection?: PendingSelection | null;
  /** Drag-to-listen preview region from the signal rows below. Painted as
   *  the same cyan band as pendingSelection so the highlight reads as one
   *  continuous stripe across the OverviewWaveform + every viz row. */
  previewRegion?: PreviewRegion | null;
  /** Fires when the user clicks the waveform to seek (NOT for programmatic
   *  seeks via seekRef). Used by the inspector to dismiss the pending
   *  highlight on click, matching the behavior on the viz rows below. */
  onUserSeek?: (time: number) => void;
  /** Fires when the user drag-selects a range on the top waveform. Wires
   *  the same handleVizRegion the signal rows use, so dragging here marks
   *  an In/Out region exactly like dragging on the 3-Band waveform below. */
  onUserRegion?: (t1: number, t2: number) => void;
  /** Play / loop / × controls for the currently-active previewRegion. When
   *  set together with a `previewRegion`, renders the single shared control
   *  bar above the cyan band on this OverviewWaveform — the in-band bars on
   *  the viz / algo-inspect rows below are intentionally hidden because the
   *  viz scroll container's `overflow-y-hidden` would clip them. */
  previewControls?: {
    isPlaying: boolean;
    loop: boolean;
    onPlay: () => void;
    onPause: () => void;
    onLoopToggle: () => void;
    onDismiss: () => void;
  } | null;
}

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60).toString().padStart(2, '0');
  const ds = Math.floor((s % 1) * 10);
  return `${m}:${ss}.${ds}`;
}

function parseTrackName(trackName?: string): { artist: string; song: string } | null {
  if (!trackName) return null;
  const trimmed = trackName.trim();
  if (!trimmed) return null;

  const emDashParts = trimmed.split('—').map((p) => p.trim()).filter(Boolean);
  if (emDashParts.length >= 2) {
    return { artist: emDashParts[0], song: emDashParts.slice(1).join(' — ') };
  }

  const hyphenParts = trimmed.split(' - ').map((p) => p.trim()).filter(Boolean);
  if (hyphenParts.length >= 2) {
    return { artist: hyphenParts[0], song: hyphenParts.slice(1).join(' - ') };
  }

  return { artist: 'Unknown Artist', song: trimmed };
}

export function PlayerPanel({ url, trackName, bpm, timeSignature, beatTimes, beatOffset = 0, beatsPerBar = 4, barGroupSize, subBeatDivision, beatGroupSize, gridThickness = 1, onBufferReady, onReady, onTimeUpdate, onViewChange, seekRef, playRef, pauseRef, wsScrollRef, zoomInRef, zoomOutRef, zoomResetRef, pinchZoomInRef, pinchZoomOutRef, scrollToTimeRef, zoomToRangeRef, onScrollChange, onPlayingChange, accent = DEFAULT_PLAYER_ACCENT, onGridOffsetChange, onGridOffsetDragStart, showBarNumbers = false, anchors, beatOverrides, anchorFlagMode, onDeleteAnchor, onAnchorDrag, onAnchorDragStart, gridMode, onBeatDrag, onClearBeatOverride, manualEditLocked = false, pendingSelection, previewRegion, onUserSeek, onUserRegion, previewControls }: PlayerPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Tracks the inner anchor-row div whose width = waveformWidth. Passed to
  // AnchorFlagOverlay so its drag hook maps clientX → time across the full
  // zoomed timeline (the parent rect is post-transform, so its width still
  // equals waveformWidth even after the translateX scroll).
  const anchorRowRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const onBufferReadyRef = useRef(onBufferReady);
  const onReadyRef = useRef(onReady);
  const onTimeUpdateRef = useRef(onTimeUpdate);
  const onViewChangeRef = useRef(onViewChange);
  const onScrollChangeRef = useRef(onScrollChange);
  const onPlayingChangeRef = useRef(onPlayingChange);
  const onUserSeekRef = useRef(onUserSeek);
  useEffect(() => { onBufferReadyRef.current = onBufferReady; }, [onBufferReady]);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  useEffect(() => { onTimeUpdateRef.current = onTimeUpdate; }, [onTimeUpdate]);
  useEffect(() => { onViewChangeRef.current = onViewChange; }, [onViewChange]);
  useEffect(() => { onScrollChangeRef.current = onScrollChange; }, [onScrollChange]);
  useEffect(() => { onPlayingChangeRef.current = onPlayingChange; }, [onPlayingChange]);
  useEffect(() => { onUserSeekRef.current = onUserSeek; }, [onUserSeek]);

  // Global pause request (fired by the workspace tab strip before a tab switch
  // so audio doesn't keep playing across the change). The 'pause' WS event wired
  // below already syncs isPlaying + onPlayingChange, so we only need ws.pause().
  useEffect(() => {
    const onPauseRequest = () => {
      console.log('[tabswitch] pause listener fired; ws?', !!wsRef.current, 'isPlaying?', wsRef.current?.isPlaying());
      wsRef.current?.pause();
    };
    window.addEventListener(PAUSE_PLAYBACK_EVENT, onPauseRequest);
    return () => window.removeEventListener(PAUSE_PLAYBACK_EVENT, onPauseRequest);
  }, []);

  const [isReady, setIsReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const [volume, setVolumeState] = useState(1);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [scaleMode, setScaleModeState] = useState<ScaleMode>(readStoredScale);
  // In-progress drag-select on the top waveform (viewport-pixel space).
  const [dragSel, setDragSel] = useState<{ s: number; e: number } | null>(null);
  const dragSelRef = useRef<{ time: number; x: number } | null>(null);
  const parsedTrack = useMemo(() => parseTrackName(trackName), [trackName]);

  const setScaleMode = useCallback((m: ScaleMode) => {
    setScaleModeState(m);
    try { window.localStorage.setItem(SCALE_STORAGE_KEY, m); } catch { /* ignore quota */ }
  }, []);

  // zoom in px/sec; 0 = fit-to-container
  const [zoom, setZoom] = useState(0);

  // Track devicePixelRatio so the zoom cap reacts when the user drags the
  // window between monitors with different scaling.
  const [pixelRatio, setPixelRatio] = useState(
    () => (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1),
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onChange = () => setPixelRatio(window.devicePixelRatio || 1);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pixelRatio]);

  // Opt-in "extended zoom" — when the user accepts, spectrogram-style canvases
  // drop their internal devicePixelRatio to 1 so the buffer stays under the
  // browser's max-canvas limit even at high zoom. Cost: slightly softer
  // overlays on HiDPI screens. See ExtendedZoomDialog for the user-facing
  // explanation.
  const {
    enabled: extendedZoom,
    setEnabled: setExtendedZoomEnabled,
    ultraEnabled: ultraZoom,
    setUltraEnabled: setUltraZoomEnabled,
  } = useExtendedZoom();
  const [showExtendedZoomPrompt, setShowExtendedZoomPrompt] = useState(false);
  const [showUltraZoomPrompt, setShowUltraZoomPrompt] = useState(false);

  // Track container width for grid positioning
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    obs.observe(el);
    setContainerWidth(el.clientWidth);
    return () => obs.disconnect();
  }, []);

  // Intercept trackpad horizontal wheel deltas on the WaveSurfer container so
  // the browser's swipe-back/forward gesture doesn't fire when scrubbing.
  // WaveSurfer's internal `.scroll` div lives in shadow DOM but wheel events
  // are composed, so they bubble out and our listener on the outer container
  // catches them. React's onWheel is always passive, so we need a native
  // listener with { passive: false } for preventDefault() to take effect.
  //
  // ctrlKey wheel events (Ctrl/⌘+wheel and trackpad pinch — browsers map
  // pinch to wheel+ctrlKey) are remapped to the app's zoomIn/zoomOut so the
  // OverviewWaveform pinches together with the signals below. Accumulate to
  // a threshold so a single pinch frame doesn't fire a runaway zoom cascade.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ZOOM_STEP_THRESHOLD = 40;
    let accumDelta = 0;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        accumDelta += e.deltaY;
        while (accumDelta <= -ZOOM_STEP_THRESHOLD) {
          pinchZoomInRef?.current?.();
          accumDelta += ZOOM_STEP_THRESHOLD;
        }
        while (accumDelta >= ZOOM_STEP_THRESHOLD) {
          pinchZoomOutRef?.current?.();
          accumDelta -= ZOOM_STEP_THRESHOLD;
        }
        return;
      }
      if (e.deltaX === 0) return;
      e.preventDefault();
      const ws = wsRef.current;
      if (ws) ws.setScroll(ws.getScroll() + e.deltaX);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [pinchZoomInRef, pinchZoomOutRef]);

  useEffect(() => {
    const el = containerRef.current;
    if (!url || !el) return;

    setIsReady(false);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setScrollLeft(0);
    setZoom(0);
    setAudioBuffer(null);

    // WaveSurfer still owns playback / scroll / zoom math, but renders nothing
    // visible — the OverviewWaveform canvas (mounted below) draws the peak/RMS
    // dual envelope on top. WS keeps drawing the playback cursor.
    const ws = WaveSurfer.create({
      container: el,
      waveColor: 'rgba(0,0,0,0)',
      progressColor: 'rgba(0,0,0,0)',
      cursorColor: '#ef4444',
      cursorWidth: 2,
      height: 96,
      normalize: false,
    });

    const t0 = performance.now();
    const tag = `[PlayerPanel] ${url}`;
    console.log(`${tag} ← mount, calling ws.load()`);

    // Fires while the audio file bytes are downloading. Stalls here usually
    // mean the server is hung or the response is much larger than expected.
    ws.on('loading', (percent: number) => {
      console.log(`${tag} loading: ${percent}% (+${Math.round(performance.now() - t0)}ms)`);
    });

    ws.on('ready', () => {
      const dur = ws.getDuration();
      const buf = ws.getDecodedData();
      console.log(
        `${tag} ready (+${Math.round(performance.now() - t0)}ms)`,
        { duration: dur, sampleRate: buf?.sampleRate, channels: buf?.numberOfChannels, length: buf?.length },
      );
      setDuration(dur);
      setIsReady(true);
      onReadyRef.current?.();
      if (seekRef) seekRef.current = (time: number) => ws.seekTo(Math.max(0, Math.min(1, time / dur)));
      if (playRef) playRef.current = () => ws.play();
      if (pauseRef) pauseRef.current = () => ws.pause();
      if (wsScrollRef) wsScrollRef.current = (sl: number) => ws.setScroll(sl);
    });

    ws.on('decode', () => {
      const buf = ws.getDecodedData();
      console.log(
        `${tag} decode (+${Math.round(performance.now() - t0)}ms)`,
        buf
          ? { duration: buf.duration, sampleRate: buf.sampleRate, channels: buf.numberOfChannels, length: buf.length }
          : 'no buffer',
      );
      if (buf) {
        setAudioBuffer(buf);
        onBufferReadyRef.current?.(buf);
      }
    });

    ws.on('audioprocess', () => {
      const t = ws.getCurrentTime();
      setCurrentTime(t);
      onTimeUpdateRef.current?.(t);
    });
    ws.on('seeking', () => {
      const t = ws.getCurrentTime();
      setCurrentTime(t);
      onTimeUpdateRef.current?.(t);
    });
    // `interaction` fires only on user click/drag in the WS canvas (NOT on
    // programmatic seeks via seekRef). The inspector uses this to dismiss
    // the pending highlight on click, matching the viz-row behavior.
    ws.on('interaction', (t: number) => {
      onUserSeekRef.current?.(t);
    });
    ws.on('play', () => { setIsPlaying(true); onPlayingChangeRef.current?.(true); });
    ws.on('pause', () => { setIsPlaying(false); onPlayingChangeRef.current?.(false); });
    ws.on('finish', () => { setIsPlaying(false); onPlayingChangeRef.current?.(false); });
    ws.on('scroll', (_vs: number, _ve: number, sl: number) => {
      setScrollLeft(sl);
      onScrollChangeRef.current?.(sl);
    });
    // Without this, decodeAudioData rejections are swallowed and the player
    // sits on "LOADING…" forever — most often when the WAV/audio file uses a
    // format Web Audio can't decode (32-bit float WAV, exotic sample rates,
    // truncated bytes). Surface it so the bug is debuggable.
    ws.on('error', (err: Error) => {
      console.error(`${tag} error (+${Math.round(performance.now() - t0)}ms)`, err);
    });

    // Pre-fetch the URL ourselves so we can see what the server actually sent
    // (status, content-type, byte length). If decode fails downstream, this
    // tells us whether the bytes arrived intact and what codec they claim.
    fetch(url, { method: 'HEAD' })
      .then((res) => {
        console.log(`${tag} HEAD (+${Math.round(performance.now() - t0)}ms)`, {
          status: res.status,
          ok: res.ok,
          contentType: res.headers.get('content-type'),
          contentLength: res.headers.get('content-length'),
          acceptRanges: res.headers.get('accept-ranges'),
        });
      })
      .catch((err: unknown) => {
        console.warn(`${tag} HEAD probe failed`, err);
      });

    // load() returns a promise; if destroy() runs before it resolves
    // (e.g. StrictMode double-mount, or url changes mid-fetch) the fetch is
    // aborted and the promise rejects with AbortError. Swallow that specific
    // case so it doesn't surface as an uncaught rejection.
    ws.load(url)
      .then(() => {
        console.log(`${tag} ws.load() resolved (+${Math.round(performance.now() - t0)}ms)`);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') {
          console.log(`${tag} ws.load() aborted (likely StrictMode/url-change) (+${Math.round(performance.now() - t0)}ms)`);
          return;
        }
        console.error(`${tag} ws.load() rejected (+${Math.round(performance.now() - t0)}ms)`, err);
      });
    wsRef.current = ws;

    return () => {
      console.log(`${tag} ✗ unmount (+${Math.round(performance.now() - t0)}ms)`);
      try {
        ws.destroy();
      } catch (err) {
        console.warn(`${tag} destroy() threw`, err);
      }
      wsRef.current = null;
      if (seekRef) seekRef.current = null;
      if (playRef) playRef.current = null;
      if (pauseRef) pauseRef.current = null;
      if (wsScrollRef) wsScrollRef.current = null;
    };
  }, [url]);

  // Fit zoom = container fills duration (WaveSurfer's default)
  const fitZoom = containerWidth > 0 && duration > 0 ? containerWidth / duration : 0;

  // Effective px/sec passed to WaveSurfer
  const effectiveZoom = zoom > 0 ? zoom : fitZoom;

  // Latest values for use inside the zoom-apply effect without re-firing on every tick.
  const currentTimeRef = useRef(0);
  useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);
  const containerWidthRef = useRef(0);
  useEffect(() => { containerWidthRef.current = containerWidth; }, [containerWidth]);
  const durationRef = useRef(0);
  useEffect(() => { durationRef.current = duration; }, [duration]);

  // Set by zoomIn/zoomOut/zoomReset; the next zoom-apply re-scrolls to keep the
  // playhead centered in the viewport. Resize-driven zoom changes leave this
  // false and don't scroll.
  const pendingUserZoomRef = useRef(false);
  // Optional override for the post-zoom scroll center (seconds). When set, the
  // zoom-apply effect centers on this time instead of currentTime — used by
  // zoomToRange so the new viewport frames the requested interval, not the
  // playhead. Cleared after one consumption.
  const pendingScrollCenterRef = useRef<number | null>(null);

  // Apply zoom to WaveSurfer whenever it changes. If the zoom was triggered by
  // a user zoom command, scroll so the playhead stays centered — clamped to
  // [0, maxScroll] when the playhead is near the start or end of the track, so
  // the cursor is at least kept inside the viewport.
  useEffect(() => {
    if (!isReady || !wsRef.current || effectiveZoom <= 0) return;
    wsRef.current.zoom(effectiveZoom);
    if (pendingUserZoomRef.current) {
      pendingUserZoomRef.current = false;
      const cw = containerWidthRef.current;
      const dur = durationRef.current;
      const centerTime = pendingScrollCenterRef.current ?? currentTimeRef.current;
      pendingScrollCenterRef.current = null;
      const target = centerTime * effectiveZoom - cw / 2;
      const maxScroll = Math.max(0, effectiveZoom * dur - cw);
      const clamped = Math.max(0, Math.min(maxScroll, target));
      wsRef.current.setScroll(clamped);
      // The parent syncs our scroll to a sibling viz container which only
      // resizes to the new zoom width AFTER this effect commits. If we set
      // scroll first, the sibling clamps the value to its old (smaller) width
      // and echoes the clamped value back via wsScrollRef on the next 'scroll'
      // event, overriding our position. Re-assert after layout settles.
      requestAnimationFrame(() => {
        if (wsRef.current) wsRef.current.setScroll(clamped);
      });
    }
  }, [isReady, effectiveZoom]);

  const setVolume = useCallback((vol: number) => {
    const clamped = Math.max(0, Math.min(1, vol));
    setVolumeState(clamped);
    wsRef.current?.setVolume(clamped);
  }, []);

  // Phase anchor for the beat grid. If beatOffset is explicitly nonzero, use it.
  // If beatOffset is 0 AND we have detected beats, fall back to beatTimes[0] for
  // back-compat with the old "auto-detected beats" UX.
  const effectiveAnchor = useMemo(() => {
    if (beatOffset != null && beatOffset !== 0) return beatOffset;
    if (beatOffset === 0 && (!beatTimes || beatTimes.length === 0)) return 0;
    if (beatOffset === 0 && beatTimes && beatTimes.length > 0) return beatTimes[0];
    return 0;
  }, [beatOffset, beatTimes]);

  // ── Alt-drag-to-slide-grid (Rekordbox "Adjust Grid") ──────────────────────
  // Tracks Alt key globally so the overlay only swallows mouse events while held;
  // normal click-to-seek still goes to WaveSurfer when Alt isn't pressed.
  const [altHeld, setAltHeld] = useState(false);
  useEffect(() => {
    if (!onGridOffsetChange) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.altKey) setAltHeld(true); };
    const onKeyUp   = (e: KeyboardEvent) => { if (!e.altKey) setAltHeld(false); };
    const onBlur    = () => setAltHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [onGridOffsetChange]);

  const gridDragRef = useRef<{ startTime: number; startOffset: number; rectLeft: number } | null>(null);
  const handleGridDragDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!e.altKey || !onGridOffsetChange || duration <= 0 || effectiveZoom <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    // Convert screen X → track time. The container is scrolled by `scrollLeft`,
    // so the track time at the click is (clientX - rectLeft + scrollLeft) / pxPerSec.
    const t = (e.clientX - rect.left + scrollLeft) / effectiveZoom;
    gridDragRef.current = { startTime: t, startOffset: effectiveAnchor, rectLeft: rect.left };
    onGridOffsetDragStart?.(effectiveAnchor);
    e.preventDefault();
    e.stopPropagation();

    const onMove = (ev: MouseEvent) => {
      const drag = gridDragRef.current;
      if (!drag) return;
      const tNow = (ev.clientX - drag.rectLeft + scrollLeft) / effectiveZoom;
      const next = drag.startOffset + (tNow - drag.startTime);
      onGridOffsetChange(Math.max(0, next));
    };
    const onUp = () => {
      gridDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [duration, effectiveZoom, scrollLeft, effectiveAnchor, onGridOffsetChange, onGridOffsetDragStart]);

  // Waveform total pixel width for overlay alignment.
  // Use Math.ceil to match WaveSurfer's internal scrollWidth = Math.ceil(duration * minPxPerSec).
  const waveformWidth = duration > 0 && effectiveZoom > 0
    ? Math.ceil(effectiveZoom * duration)
    : (containerWidth || 800);

  // Zoom multiplier relative to fit (for display and external sync)
  const zoomMultiplier = fitZoom > 0 ? effectiveZoom / fitZoom : 1;

  // Cap zoom so neither WaveSurfer's tiled renderer nor the sibling canvas
  // panels (3-Band, Spectrogram) exceed the browser's max canvas dimension.
  //
  // The tightest constraint comes from SpectrogramAnnotated, whose internal
  // pixel buffer is `cssWidth × devicePixelRatio`. At dpr=2 a 16 000 px CSS
  // canvas already produces a 32 000 px buffer — right at the browser's
  // max-canvas cap (Chrome ~32 767 px; Firefox/Safari lower). Past that, the
  // canvas paints blank.
  //
  // Three caps are computed:
  //   • standardCap — uses the real devicePixelRatio. Keeps overlays crisp.
  //   • extendedCap — assumes dpr=1 in the bottleneck canvases (the user has
  //     opted into "extended zoom"). Buys more room on HiDPI displays.
  //   • ultraCap — lifts the multiplier ceiling all the way to ×128. CSS width
  //     now exceeds the 32 000 px safe buffer, so the spectrogram-style and
  //     3-Band canvases self-clamp their internal pixel ratio — they keep
  //     painting but their texture softens proportionally with zoom. The user
  //     opts in via UltraZoomDialog.
  // Floored at 2× so the cap never collapses to "no zoom at all" on weird
  // (very wide / very high-dpr) viewports.
  const standardSafeMultiplier = containerWidth > 0
    ? MAX_BUFFER_PX / (containerWidth * pixelRatio)
    : STANDARD_CEILING;
  const extendedSafeMultiplier = containerWidth > 0
    ? MAX_BUFFER_PX / containerWidth
    : STANDARD_CEILING;
  const standardCapMultiplier = Math.max(2, Math.min(STANDARD_CEILING, standardSafeMultiplier));
  const extendedCapMultiplier = Math.max(2, Math.min(STANDARD_CEILING, extendedSafeMultiplier));
  const activeCapMultiplier = ultraZoom
    ? ULTRA_CEILING
    : (extendedZoom ? extendedCapMultiplier : standardCapMultiplier);
  const maxZoomPx = fitZoom > 0 ? fitZoom * activeCapMultiplier : 1600;
  const standardCapPx = fitZoom > 0 ? fitZoom * standardCapMultiplier : 1600;
  const extendedCapPx = fitZoom > 0 ? fitZoom * extendedCapMultiplier : 1600;

  // Headroom exists when extended would actually unlock more zoom. The dialog
  // is always shown when the user hits the cap — there's no "don't ask again"
  // bypass, so a deliberate click is required to enter Extended/Ultra every
  // time.
  const canOfferExtended = !extendedZoom
    && extendedCapMultiplier > standardCapMultiplier + 1e-3;
  const canOfferUltra = !ultraZoom
    && ULTRA_CEILING > extendedCapMultiplier + 1e-3;

  // Toolbar's atMaxZoom drives the + button's disabled state. Keep the button
  // active when extended- or ultra-zoom headroom is still available — clicking
  // it will open the prompt instead of being a no-op.
  const atFinalCap = isReady && zoom > 0 && zoom >= maxZoomPx - 1e-3;
  const atMaxZoom = atFinalCap && !canOfferExtended && !canOfferUltra;

  // Notify parent whenever zoom factor, container size, or max-zoom state changes
  useEffect(() => {
    if (containerWidth > 0) onViewChangeRef.current?.(zoomMultiplier, containerWidth, atMaxZoom);
  }, [zoomMultiplier, containerWidth, atMaxZoom]);

  // If the cap drops below the current zoom (e.g. window narrowed, moved
  // to a higher-dpr monitor, or the user exited Ultra/Extended), pull zoom
  // back to the new cap so the canvases never operate above the safe buffer
  // size. Flag this as a user-driven zoom so the zoom-apply effect re-
  // centers scroll — otherwise the sibling viz container keeps its old
  // scrollLeft and the signals appear "stuck" at the wrong offset (the
  // OverviewWaveform fits, the signals don't).
  useEffect(() => {
    if (zoom > 0 && maxZoomPx > 0 && zoom > maxZoomPx) {
      pendingUserZoomRef.current = true;
      setZoom(maxZoomPx);
    }
  }, [zoom, maxZoomPx]);

  const zoomIn = useCallback(() => {
    // At the standard (sharp-pixel) cap with extended headroom still on offer:
    // surface the extended-zoom modal rather than silently no-op.
    if (canOfferExtended) {
      const currentZoomPx = zoom > 0 ? zoom : fitZoom;
      if (currentZoomPx >= standardCapPx - 1e-3) {
        setShowExtendedZoomPrompt(true);
        return;
      }
    }
    // At the extended cap with ultra headroom still on offer: surface the
    // ultra-zoom modal. Reached either after the user already enabled extended
    // or — if extended is dismissed — directly at the standard cap.
    if (canOfferUltra) {
      const currentZoomPx = zoom > 0 ? zoom : fitZoom;
      const triggerPx = extendedZoom ? extendedCapPx : standardCapPx;
      if (currentZoomPx >= triggerPx - 1e-3) {
        setShowUltraZoomPrompt(true);
        return;
      }
    }
    pendingUserZoomRef.current = true;
    setZoom((prev) => {
      const base = prev > 0 ? prev : (fitZoom || 50);
      return Math.min(base * 2, maxZoomPx);
    });
  }, [canOfferExtended, canOfferUltra, extendedZoom, zoom, fitZoom, standardCapPx, extendedCapPx, maxZoomPx]);

  const handleApproveExtendedZoom = useCallback(() => {
    setExtendedZoomEnabled(true);
    setShowExtendedZoomPrompt(false);
    // Perform the queued zoom step immediately using the freshly-unlocked cap.
    const newCapPx = fitZoom > 0 ? fitZoom * extendedCapMultiplier : 1600;
    pendingUserZoomRef.current = true;
    setZoom((prev) => {
      const base = prev > 0 ? prev : (fitZoom || 50);
      return Math.min(base * 2, newCapPx);
    });
  }, [setExtendedZoomEnabled, fitZoom, extendedCapMultiplier]);

  const handleDismissExtendedZoom = useCallback(() => {
    setShowExtendedZoomPrompt(false);
  }, []);

  const handleApproveUltraZoom = useCallback(() => {
    setUltraZoomEnabled(true);
    setShowUltraZoomPrompt(false);
    // Perform the queued zoom step immediately using the freshly-unlocked cap.
    const newCapPx = fitZoom > 0 ? fitZoom * ULTRA_CEILING : 1600;
    pendingUserZoomRef.current = true;
    setZoom((prev) => {
      const base = prev > 0 ? prev : (fitZoom || 50);
      return Math.min(base * 2, newCapPx);
    });
  }, [setUltraZoomEnabled, fitZoom]);

  const handleDismissUltraZoom = useCallback(() => {
    setShowUltraZoomPrompt(false);
  }, []);

  const zoomOut = useCallback(() => {
    pendingUserZoomRef.current = true;
    setZoom((prev) => {
      const base = prev > 0 ? prev : (fitZoom || 50);
      const next = base / 2;
      return next <= (fitZoom || 50) * 1.05 ? 0 : next;
    });
  }, [fitZoom]);

  const zoomReset = useCallback(() => {
    pendingUserZoomRef.current = true;
    setZoom(0);
  }, []);

  // Pinch / Ctrl+wheel zoom — prompt-free. Caps at the currently-authorized
  // tier (Standard → Extended only if already enabled → Ultra only if already
  // enabled) so a trackpad gesture can never silently progress the user past
  // the safe-pixel cap. Crossing into Extended/Ultra requires an explicit
  // click on the + button, which routes through zoomIn() and surfaces the
  // ExtendedZoomDialog / UltraZoomDialog.
  const pinchZoomIn = useCallback(() => {
    pendingUserZoomRef.current = true;
    setZoom((prev) => {
      const base = prev > 0 ? prev : (fitZoom || 50);
      // Authorized cap: whatever tier the user has already opted into.
      const authorizedCapPx = ultraZoom
        ? maxZoomPx
        : (extendedZoom ? extendedCapPx : standardCapPx);
      return Math.min(base * 2, authorizedCapPx);
    });
  }, [fitZoom, ultraZoom, extendedZoom, maxZoomPx, extendedCapPx, standardCapPx]);
  const pinchZoomOut = useCallback(() => {
    pendingUserZoomRef.current = true;
    setZoom((prev) => {
      const base = prev > 0 ? prev : (fitZoom || 50);
      const next = base / 2;
      return next <= (fitZoom || 50) * 1.05 ? 0 : next;
    });
  }, [fitZoom]);

  // Scroll the viewport so a specific time is visible. `center` puts the time
  // mid-viewport; `left` parks it ~32 px from the left edge (so the user can
  // still see content stretching to the right of the target — useful for
  // "show me the start of this span" gestures).
  const scrollToTime = useCallback((time: number, align: 'center' | 'left' = 'center') => {
    const ws = wsRef.current;
    if (!ws) return;
    const z = effectiveZoom;
    const cw = containerWidthRef.current;
    const dur = durationRef.current;
    if (z <= 0 || cw <= 0 || dur <= 0) return;
    const targetPx = time * z;
    const target = align === 'center' ? targetPx - cw / 2 : targetPx - 32;
    const maxScroll = Math.max(0, z * dur - cw);
    ws.setScroll(Math.max(0, Math.min(maxScroll, target)));
  }, [effectiveZoom]);

  // Zoom + scroll so [t1, t2] fills the viewport with 15% padding on each
  // side. Clamps to [fit, maxZoomPx]; collapses to "fit" when the range
  // would need less than fit-zoom to display. After setting zoom, the
  // zoom-apply effect picks up pendingScrollCenterRef and re-centers — that
  // path is the only one that survives the sibling-viz scroll echo
  // documented in the zoom-apply effect comment. When zoom doesn't actually
  // change we still set scroll directly so the viewport re-frames even at
  // an already-correct zoom level.
  const zoomToRange = useCallback((t1: number, t2: number) => {
    const cw = containerWidthRef.current;
    const dur = durationRef.current;
    if (cw <= 0 || dur <= 0) return;
    const lo = Math.max(0, Math.min(t1, t2));
    const hi = Math.min(dur, Math.max(t1, t2));
    if (hi - lo < 1e-3) {
      scrollToTime((lo + hi) / 2, 'center');
      return;
    }
    const padFrac = 0.15;
    const span = (hi - lo) * (1 + padFrac * 2);
    const fit = fitZoom > 0 ? fitZoom : (cw / dur);
    let desired = cw / span;
    desired = Math.min(desired, maxZoomPx);
    const nextZoomState = desired <= fit * 1.02 ? 0 : desired;
    const center = (lo + hi) / 2;
    if (nextZoomState === zoom) {
      const z = effectiveZoom;
      if (z <= 0) return;
      const target = center * z - cw / 2;
      const maxScroll = Math.max(0, z * dur - cw);
      wsRef.current?.setScroll(Math.max(0, Math.min(maxScroll, target)));
      return;
    }
    pendingUserZoomRef.current = true;
    pendingScrollCenterRef.current = center;
    setZoom(nextZoomState);
  }, [fitZoom, maxZoomPx, zoom, effectiveZoom, scrollToTime]);

  // Expose imperative zoom handles to the parent (e.g. for keyboard shortcuts).
  // Re-attach whenever the callback identity changes so latest closures are bound.
  useEffect(() => {
    if (zoomInRef) zoomInRef.current = zoomIn;
    if (zoomOutRef) zoomOutRef.current = zoomOut;
    if (zoomResetRef) zoomResetRef.current = zoomReset;
    if (pinchZoomInRef) pinchZoomInRef.current = pinchZoomIn;
    if (pinchZoomOutRef) pinchZoomOutRef.current = pinchZoomOut;
    if (scrollToTimeRef) scrollToTimeRef.current = scrollToTime;
    if (zoomToRangeRef) zoomToRangeRef.current = zoomToRange;
    return () => {
      if (zoomInRef) zoomInRef.current = null;
      if (zoomOutRef) zoomOutRef.current = null;
      if (zoomResetRef) zoomResetRef.current = null;
      if (pinchZoomInRef) pinchZoomInRef.current = null;
      if (pinchZoomOutRef) pinchZoomOutRef.current = null;
      if (scrollToTimeRef) scrollToTimeRef.current = null;
      if (zoomToRangeRef) zoomToRangeRef.current = null;
    };
  }, [zoomIn, zoomOut, zoomReset, pinchZoomIn, pinchZoomOut, scrollToTime, zoomToRange, zoomInRef, zoomOutRef, zoomResetRef, pinchZoomInRef, pinchZoomOutRef, scrollToTimeRef, zoomToRangeRef]);

  const beatLines = useMemo(() => {
    if (!isReady || duration <= 0 || !bpm) return [];
    return visibleGridLines({
      bpm,
      gridOffset: effectiveAnchor,
      beatsPerBar,
      startTime: 0,
      endTime: duration,
      barGroupSize: barGroupSize ?? null,
      subBeatDivision,
      beatGroupSize,
      anchors,
      beatOverrides,
    });
  }, [isReady, duration, bpm, effectiveAnchor, beatsPerBar, barGroupSize, subBeatDivision, beatGroupSize, anchors, beatOverrides]);

  // When zoomed out, labelling every bar turns the top edge into an unreadable
  // smear of digits. Cull to powers-of-two so the label set doesn't shimmer as
  // the user zooms — bar 1 stays put and the gap doubles instead of jittering.
  const barNumberStep = useMemo(() => {
    if (!bpm || !beatsPerBar || effectiveZoom <= 0) return 1;
    const pxPerBar = (60 / bpm) * beatsPerBar * effectiveZoom;
    const MIN_PX_PER_LABEL = 36;
    let step = 1;
    while (pxPerBar * step < MIN_PX_PER_LABEL) step *= 2;
    return step;
  }, [bpm, beatsPerBar, effectiveZoom]);

  // ── Drag-to-select on the top waveform ─────────────────────────────────────
  // Mirrors RegionDragOverlay on the signal rows: short clicks fall through as
  // seeks via onUserSeek; drags above the 6px threshold emit a Mark In/Out
  // region via onUserRegion.
  const timeAtClientX = useCallback((clientX: number, rect: DOMRect): number => {
    if (rect.width <= 0 || effectiveZoom <= 0 || duration <= 0) return 0;
    const localX = clientX - rect.left;
    const t = (scrollLeft + localX) / effectiveZoom;
    return Math.max(0, Math.min(duration, t));
  }, [duration, effectiveZoom, scrollLeft]);

  const handleSelectMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const t = timeAtClientX(e.clientX, e.currentTarget.getBoundingClientRect());
    dragSelRef.current = { time: t, x: e.clientX };
    setDragSel({ s: t, e: t });
    e.preventDefault();
  }, [timeAtClientX]);

  const handleSelectMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragSelRef.current) return;
    const t = timeAtClientX(e.clientX, e.currentTarget.getBoundingClientRect());
    setDragSel({ s: dragSelRef.current.time, e: t });
  }, [timeAtClientX]);

  const handleSelectMouseUp = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const drag = dragSelRef.current;
    if (!drag) return;
    const endT = timeAtClientX(e.clientX, e.currentTarget.getBoundingClientRect());
    const movedPx = Math.abs(e.clientX - drag.x);
    const t1 = Math.min(drag.time, endT);
    const t2 = Math.max(drag.time, endT);
    if (movedPx > 6 && t2 - t1 > 0.1 && onUserRegion) {
      onUserRegion(t1, t2);
    } else {
      // Short click: route to the same dismiss-then-seek handler used by the
      // viz rows, and seek WS directly so the cursor jumps.
      onUserSeek?.(drag.time);
      wsRef.current?.seekTo(Math.max(0, Math.min(1, drag.time / Math.max(0.0001, duration))));
    }
    dragSelRef.current = null;
    setDragSel(null);
  }, [timeAtClientX, onUserRegion, onUserSeek, duration]);

  const handleSelectMouseLeave = useCallback(() => {
    dragSelRef.current = null;
    setDragSel(null);
  }, []);

  return (
    <>
    <div className="rounded-md border border-white/[0.06] bg-[#14171d] overflow-hidden">
      {/* Waveform + beat grid */}
      <div className="relative bg-[#0a0b0d]" style={{ minHeight: 96 }}>
        {/* OverviewWaveform draws peak/RMS, grid, clip caps. z-1, under WS so
            WaveSurfer's red playback cursor stays on top. */}
        <OverviewWaveform
          audioBuffer={audioBuffer}
          containerWidth={containerWidth}
          pxPerSec={effectiveZoom}
          scrollLeft={scrollLeft}
          peakColor={accent.progressColor}
          rmsColor={accent.waveColor}
          scaleMode={scaleMode}
        />

        {/* WaveSurfer container — invisible bars + visible cursor. z-2 puts the
            cursor above the OverviewWaveform overlay. */}
        <div
          ref={containerRef}
          className="w-full relative"
          style={{ zIndex: 2, overscrollBehaviorX: 'none' }}
        />

        {/* Drag-to-select overlay — sits above the WS canvas (z-3) but below
            the highlights/grid/manual-editor/anchor overlays so their pointer-
            events-auto regions still win. Short clicks fall through to onUserSeek
            (which routes via handleVizClick → ws.seekTo); drags emit a Mark
            In/Out region via onUserRegion. */}
        {isReady && (onUserSeek || onUserRegion) && (
          <div
            className="absolute inset-0 z-[3]"
            style={{ cursor: 'crosshair' }}
            onMouseDown={handleSelectMouseDown}
            onMouseMove={handleSelectMouseMove}
            onMouseUp={handleSelectMouseUp}
            onMouseLeave={handleSelectMouseLeave}
          >
            {dragSel && duration > 0 && effectiveZoom > 0 && (() => {
              const lo = Math.min(dragSel.s, dragSel.e);
              const hi = Math.max(dragSel.s, dragSel.e);
              return (
                <div
                  className="absolute top-0 bottom-0 pointer-events-none"
                  style={{
                    left: lo * effectiveZoom - scrollLeft,
                    width: Math.max(1, (hi - lo) * effectiveZoom),
                    background: 'rgba(45,212,191,0.13)',
                    borderLeft: '2px solid rgba(45,212,191,0.7)',
                    borderRight: hi - lo > 0.1 ? '2px solid rgba(45,212,191,0.7)' : 'none',
                  }}
                />
              );
            })()}
          </div>
        )}

        {/* Pending Mark In/Out highlight — same cyan band shown on the layer
            rows below, mirrored here so the selected range reads as one
            continuous stripe across the whole inspector. Uses the beat-grid
            translateX-scroll pattern so % offsets align with the waveform. */}
        {isReady && pendingSelection && duration > 0 && (
          <div className="absolute inset-0 pointer-events-none overflow-hidden z-10">
            <div
              style={{
                position: 'relative',
                width: waveformWidth,
                height: '100%',
                transform: `translateX(-${scrollLeft}px)`,
              }}
            >
              <PendingHighlightOverlay
                sel={pendingSelection}
                duration={duration}
                grid={{ bpm, gridOffset: beatOffset, beatsPerBar }}
              />
            </div>
          </div>
        )}

        {/* Drag-to-listen preview region — same cyan band painted on every viz
            row's PreviewWindow, mirrored here so the highlight reads as one
            continuous stripe spanning the OverviewWaveform too. Reuses
            PendingHighlightOverlay (the {start,end} → {t1,t2} shape is
            isomorphic) and the overflow-hidden + translateX scroll pattern
            so the band trims at the visible edges. */}
        {isReady && previewRegion && duration > 0 && (
          <div className="absolute inset-0 pointer-events-none overflow-hidden z-10">
            <div
              style={{
                position: 'relative',
                width: waveformWidth,
                height: '100%',
                transform: `translateX(-${scrollLeft}px)`,
              }}
            >
              <PendingHighlightOverlay
                sel={{ t1: previewRegion.start, t2: previewRegion.end }}
                duration={duration}
              />
            </div>
          </div>
        )}

        {/* Single shared play / loop / × bar — anchored to the centre of the
            cyan band on this OverviewWaveform. Lives here (not on the viz
            rows below) because the viz scroll container's overflow-y-hidden
            clips anything floating above its rows; PlayerPanel has no such
            clip, so the bar is always visible. Tracks the band's pixel
            position so it stays put as WaveSurfer auto-scrolls. */}
        {isReady && previewRegion && previewControls && duration > 0 && (
          <div className="absolute inset-0 pointer-events-none overflow-hidden z-20">
            <div
              style={{
                position: 'relative',
                width: waveformWidth,
                height: '100%',
                transform: `translateX(-${scrollLeft}px)`,
              }}
            >
              <div
                className="absolute"
                style={{
                  top: 2,
                  left: `${((previewRegion.start + previewRegion.end) / 2 / duration) * 100}%`,
                  transform: 'translateX(-50%)',
                  zIndex: 25,
                }}
              >
                <PreviewControlsBar
                  isPlaying={previewControls.isPlaying}
                  loop={previewControls.loop}
                  onPlay={previewControls.onPlay}
                  onPause={previewControls.onPause}
                  onLoopToggle={previewControls.onLoopToggle}
                  onDismiss={previewControls.onDismiss}
                  extra={
                    <span className="text-[10px] font-mono text-gray-400 px-1 tabular-nums">
                      {(previewRegion.end - previewRegion.start).toFixed(1)}s
                    </span>
                  }
                />
              </div>
            </div>
          </div>
        )}


        {/* Alt-drag overlay — only intercepts mouse events while Alt is held so
            normal click-to-seek still falls through to WaveSurfer. */}
        {onGridOffsetChange && (
          <div
            className="absolute inset-0 z-30"
            style={{
              pointerEvents: altHeld ? 'auto' : 'none',
              cursor: altHeld ? 'ew-resize' : 'default',
              background: altHeld ? 'rgba(56,189,248,0.04)' : 'transparent',
            }}
            onMouseDown={handleGridDragDown}
            title="Alt-drag to slide the beat grid"
          />
        )}

        {/* Beat grid overlay — z-10 keeps it above WaveSurfer's canvas */}
        {isReady && beatLines.length > 0 && (
          <div className="absolute inset-0 pointer-events-none overflow-hidden z-10">
            <div
              style={{
                position: 'relative',
                width: waveformWidth,
                height: '100%',
                transform: `translateX(-${scrollLeft}px)`,
              }}
            >
              {beatLines.map((line, i) => (
                <div
                  key={i}
                  className="absolute top-0 bottom-0"
                  style={{ left: `${(line.t / duration) * 100}%` }}
                >
                  {/* Subtle full-height rule. Phrases stand out only via the small
                      tick caps below — keeps the waveform readable while still
                      letting the eye lock onto bar boundaries. */}
                  <div
                    style={{
                      width: (line.isBar ? 1 : 0.5) * gridThickness,
                      height: '100%',
                      background: line.isPhrase
                        ? 'rgba(251,191,36,0.55)'   // amber — phrase (every 4 bars)
                        : line.isBar
                        ? 'rgba(255,255,255,0.38)'  // white — bar (must read against violet RMS body)
                        : line.isSubBeat
                        ? 'rgba(255,255,255,0.06)'  // very faint — 8th / 16th note subdivisions
                        : 'rgba(255,255,255,0.14)', // hairline — beat subdivision
                    }}
                  />
                  {/* Top + bottom tick caps mark phrases boldly without bleeding
                      across the whole canvas. */}
                  {line.isPhrase && (
                    <>
                      <div className="absolute top-0 left-0" style={{ width: 1, height: 6, background: 'rgba(251,191,36,0.85)' }} />
                      <div className="absolute bottom-0 left-0" style={{ width: 1, height: 6, background: 'rgba(251,191,36,0.85)' }} />
                    </>
                  )}
                  {/* Bar number label (shown only when caller opted in and there is a bar) */}
                  {showBarNumbers && line.isBar && line.barNumber > 0 && ((line.barNumber - 1) % barNumberStep === 0) && (
                    <span
                      className="absolute font-mono select-none"
                      style={{
                        top: 1, left: 2,
                        fontSize: 9,
                        lineHeight: 1,
                        color: line.isPhrase ? 'rgba(251,191,36,0.95)' : 'rgba(226,232,240,0.85)',
                        textShadow: '0 0 2px rgba(0,0,0,0.9)',
                      }}
                    >
                      {line.barNumber}
                    </span>
                  )}
                  {line.isBar && !line.isPhrase && (
                    <>
                      <div className="absolute top-0 left-0" style={{ width: 1, height: 3, background: 'rgba(226,232,240,0.75)' }} />
                      <div className="absolute bottom-0 left-0" style={{ width: 1, height: 3, background: 'rgba(226,232,240,0.75)' }} />
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Manual-grid editor overlay — per-beat draggable hit zones layered
            on top of the waveform. Container is pointer-events-none so
            seek-clicks fall through between beats; each ~9 px hit zone
            opts back in. z-15 sits above the beat grid but below the anchor
            flags + alt-drag overlay. Only rendered in Manual grid mode. */}
        {isReady && gridMode === 'manual' && bpm && onBeatDrag && (
          <div className="absolute inset-0 pointer-events-none overflow-hidden z-[15]">
            <div
              style={{
                position: 'relative',
                width: waveformWidth,
                height: '100%',
                transform: `translateX(-${scrollLeft}px)`,
              }}
            >
              <ManualGridEditor
                overlay
                bpm={bpm}
                gridOffset={effectiveAnchor}
                beatsPerBar={beatsPerBar}
                anchors={anchors}
                beatOverrides={beatOverrides}
                duration={duration}
                onBeatDrag={onBeatDrag}
                onClearOverride={onClearBeatOverride}
                locked={manualEditLocked}
              />
            </div>
          </div>
        )}

        {/* Tempo-anchor flags — ride the same zoom + scroll transform as the
            beat grid so each flag stays pinned to its timestamp. z-20 puts
            the BPM badges above the grid but below the WaveSurfer cursor. */}
        {isReady && anchorFlagMode && anchors && anchors.length > 0 && (
          <div className="absolute inset-0 pointer-events-none overflow-hidden z-20">
            <div
              ref={anchorRowRef}
              style={{
                position: 'relative',
                width: waveformWidth,
                height: '100%',
                transform: `translateX(-${scrollLeft}px)`,
              }}
            >
              <AnchorFlagOverlay
                anchors={anchors}
                duration={duration}
                mode={anchorFlagMode}
                containerRef={anchorRowRef}
                formatLabel={(a) => `${a.timestamp.toFixed(2)}s · ${a.bpm.toFixed(2)} BPM${anchorFlagMode === 'manual' ? ' · drag to reposition · right-click to delete' : ''}`}
                onDeleteAnchor={anchorFlagMode === 'manual' ? onDeleteAnchor : undefined}
                onAnchorDrag={anchorFlagMode === 'manual' ? onAnchorDrag : undefined}
                onAnchorDragStart={anchorFlagMode === 'manual' ? onAnchorDragStart : undefined}
              />
            </div>
          </div>
        )}

        {!isReady && url && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-[#0a0b0d] z-20"
            style={{ minHeight: 96 }}
          >
            <span className="text-slate-500 text-[10px] uppercase tracking-[0.2em] animate-pulse font-mono">Loading…</span>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 px-3 py-2 border-t border-white/[0.05] flex-wrap">
        {/* Transport: jump-to-start · skip back · play/pause · skip forward · jump-to-end */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => wsRef.current?.seekTo(0)}
            disabled={!isReady}
            aria-label="Jump to start"
            title="Jump to start (Home)"
            className={`w-7 h-7 rounded flex items-center justify-center transition-colors ${
              isReady
                ? 'bg-white/[0.04] hover:bg-white/[0.10] text-slate-300'
                : 'bg-white/[0.02] text-slate-700 cursor-not-allowed'
            }`}
          >
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
              <rect x="5" y="4" width="2" height="16" rx="1" />
              <polygon points="20,4 20,20 8,12" />
            </svg>
          </button>
          <button
            onClick={() => {
              const ws = wsRef.current;
              if (!ws || duration <= 0) return;
              ws.seekTo(Math.max(0, Math.min(1, (currentTime - 2) / duration)));
            }}
            disabled={!isReady}
            aria-label="Skip back 2 seconds"
            title="Skip back 2 s (←)"
            className={`w-7 h-7 rounded flex items-center justify-center transition-colors ${
              isReady
                ? 'bg-white/[0.04] hover:bg-white/[0.10] text-slate-300'
                : 'bg-white/[0.02] text-slate-700 cursor-not-allowed'
            }`}
          >
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
              <polygon points="11,5 11,19 2,12" />
              <polygon points="22,5 22,19 13,12" />
            </svg>
          </button>
          <button
            onClick={() => wsRef.current?.playPause()}
            disabled={!isReady}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
            className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
              isReady
                ? `${accent.playBtn} text-slate-100`
                : 'bg-white/[0.04] text-slate-700 cursor-not-allowed'
            }`}
          >
            {isPlaying ? (
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                <polygon points="5,3 19,12 5,21" />
              </svg>
            )}
          </button>
          <button
            onClick={() => {
              const ws = wsRef.current;
              if (!ws || duration <= 0) return;
              ws.seekTo(Math.max(0, Math.min(1, (currentTime + 2) / duration)));
            }}
            disabled={!isReady}
            aria-label="Skip forward 2 seconds"
            title="Skip forward 2 s (→)"
            className={`w-7 h-7 rounded flex items-center justify-center transition-colors ${
              isReady
                ? 'bg-white/[0.04] hover:bg-white/[0.10] text-slate-300'
                : 'bg-white/[0.02] text-slate-700 cursor-not-allowed'
            }`}
          >
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
              <polygon points="2,5 2,19 11,12" />
              <polygon points="13,5 13,19 22,12" />
            </svg>
          </button>
          <button
            onClick={() => wsRef.current?.seekTo(1)}
            disabled={!isReady}
            aria-label="Jump to end"
            title="Jump to end (End)"
            className={`w-7 h-7 rounded flex items-center justify-center transition-colors ${
              isReady
                ? 'bg-white/[0.04] hover:bg-white/[0.10] text-slate-300'
                : 'bg-white/[0.02] text-slate-700 cursor-not-allowed'
            }`}
          >
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
              <polygon points="4,4 4,20 16,12" />
              <rect x="17" y="4" width="2" height="16" rx="1" />
            </svg>
          </button>
        </div>

        {/* Time */}
        <span className="font-mono text-[13px] text-slate-200 tabular-nums">
          {formatTime(currentTime)}
          <span className="text-slate-700 mx-1">/</span>
          <span className="text-slate-500">{formatTime(duration)}</span>
        </span>

        {parsedTrack && (
          <div className="flex items-center gap-1.5 text-[11px] min-w-0">
            <span className="text-slate-500 truncate max-w-[14rem]">{parsedTrack.artist}</span>
            <span className="text-slate-700">·</span>
            <span className={`truncate max-w-[16rem] ${accent.songText}`}>{parsedTrack.song}</span>
          </div>
        )}

        {/* Volume slider */}
        {isReady && (
          <div className="flex items-center gap-2">
            <svg className="w-3.5 h-3.5 text-slate-500 shrink-0" fill="currentColor" viewBox="0 0 24 24">
              {volume === 0 ? (
                <path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
              ) : volume < 0.5 ? (
                <path d="M18.5 12A4.5 4.5 0 0016 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
              ) : (
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
              )}
            </svg>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              className={`w-20 ${accent.slider}`}
              title={`Volume: ${Math.round(volume * 100)}%`}
            />
          </div>
        )}

        {/* Amplitude scale toggle */}
        {isReady && (
          <div className="flex items-center gap-px ml-auto">
            <span className="text-[10px] uppercase tracking-wider text-slate-500 mr-1.5">Scale</span>
            <button
              onClick={() => setScaleMode('lin')}
              title="Linear amplitude (0 to 1)"
              className={`w-7 h-6 rounded-l text-[10px] font-mono transition-colors border-r border-white/[0.04] ${
                scaleMode === 'lin'
                  ? 'bg-white/[0.10] text-slate-100'
                  : 'bg-white/[0.04] hover:bg-white/[0.08] text-slate-400'
              }`}
            >Lin</button>
            <button
              onClick={() => setScaleMode('db')}
              title="Decibel scale (0 to -60 dB)"
              className={`w-7 h-6 rounded-r text-[10px] font-mono transition-colors ${
                scaleMode === 'db'
                  ? 'bg-white/[0.10] text-slate-100'
                  : 'bg-white/[0.04] hover:bg-white/[0.08] text-slate-400'
              }`}
            >dB</button>
          </div>
        )}

        {bpm && (
          <span className={`text-[11px] font-mono px-2 py-0.5 rounded tabular-nums ${accent.pill}`}>
            {Math.round(bpm)} BPM{timeSignature ? ` · ${timeSignature}` : ''}
          </span>
        )}
      </div>
    </div>
    <ExtendedZoomDialog
      open={showExtendedZoomPrompt}
      onOpenChange={setShowExtendedZoomPrompt}
      standardCap={standardCapMultiplier}
      extendedCap={extendedCapMultiplier}
      onApprove={handleApproveExtendedZoom}
      onDismiss={handleDismissExtendedZoom}
    />
    <UltraZoomDialog
      open={showUltraZoomPrompt}
      onOpenChange={setShowUltraZoomPrompt}
      extendedCap={extendedZoom ? extendedCapMultiplier : standardCapMultiplier}
      ultraCap={ULTRA_CEILING}
      onApprove={handleApproveUltraZoom}
      onDismiss={handleDismissUltraZoom}
    />
    </>
  );
}
